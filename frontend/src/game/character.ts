import type { Map as MapLibreMap } from 'maplibre-gl';
import { fromMercator, TILE_SIZE, type TileId } from '../map/grid';

export type Direction = 'up' | 'down' | 'left' | 'right';

// 칸 ID는 y가 북쪽으로 갈수록 커지므로 '위'는 y + 1이다.
const DELTA: Record<Direction, TileId> = {
  up: { x: 0, y: 1 },
  down: { x: 0, y: -1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

// KeyboardEvent.code 기준 (키보드 배열/한영 입력 상태와 무관)
const KEY_TO_DIRECTION: Record<string, Direction> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  KeyW: 'up',
  KeyS: 'down',
  KeyA: 'left',
  KeyD: 'right',
};

/** 한 칸 이동에 걸리는 시간(ms). 250ms = 초당 4칸 */
const STEP_MS = 250;

export type Mercator = [number, number];

type Step = { from: Mercator; to: Mercator; target: TileId; z: number; startedAt: number };

/** 렌더러가 캐릭터를 그릴 때 쓰는 현재 상태 */
export type CharacterState = {
  /** 현재 위치(메르카토르 m). 이동 중에는 두 칸 사이 값 */
  pos: Mercator;
  facing: Direction;
  moving: boolean;
  /** 지금 칸과 층 (이동 중이면 출발한 칸) */
  tile: TileId;
  z: number;
  /** 이동 중이면 도착할 칸·층과 진행률(0~1) */
  next: { tile: TileId; z: number; t: number } | null;
};

export type CharacterOptions = {
  start: TileId;
  /** from(층 z)에서 to로 갈 때 도착하는 층. 갈 수 없으면 null. 없으면 어디든 같은 층으로 간다. */
  enter?: (from: TileId, to: TileId, z: number) => number | null;
  /** 캐릭터가 새 칸에 도착하거나 방향을 바꿀 때 호출된다. */
  onChange?: (tile: TileId, facing: Direction, z: number) => void;
};

export type Character = {
  getState(): CharacterState;
  /** 그 칸으로 바로 옮긴다 (땅 층으로. 다리 위 판단은 levels.resolveZ가 한다) */
  teleport(tile: TileId): void;
  destroy(): void;
};

const tileCenter = (tile: TileId): Mercator => [
  (tile.x + 0.5) * TILE_SIZE,
  (tile.y + 0.5) * TILE_SIZE,
];

/**
 * 키보드로 캐릭터를 한 칸씩 움직이고, 카메라가 캐릭터를 따라가게 한다.
 * 캐릭터 그림은 렌더러가 getState()를 보고 건물과 앞뒤 순서를 맞춰 그린다.
 * 지도 'load' 이후에 호출하고, destroy()로 정리한다.
 */
export function createCharacter(map: MapLibreMap, options: CharacterOptions): Character {
  let tile: TileId = { ...options.start };
  let facing: Direction = 'down';
  let z = 0;
  let step: Step | null = null;
  let pos: Mercator = tileCenter(tile);
  const held: Direction[] = []; // 누르고 있는 방향들. 마지막에 누른 방향이 우선
  // 마지막으로 누른 방향. 키를 아주 짧게 눌렀다 떼서 held에 남아 있지 않아도 한 칸은 이동하게 한다.
  let queued: Direction | null = null;

  // 캐릭터 위치를 바꾸고 카메라를 그 위치로 옮긴다. (카메라 이동이 다시 그리기를 일으킨다)
  const place = (p: Mercator) => {
    pos = p;
    map.jumpTo({ center: fromMercator(p[0], p[1]) });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const dir = KEY_TO_DIRECTION[e.code];
    if (!dir) return;
    e.preventDefault(); // 방향키로 페이지가 스크롤되지 않게
    if (!held.includes(dir)) held.push(dir);
    if (!e.repeat) queued = dir;
  };

  const onKeyUp = (e: KeyboardEvent) => {
    const dir = KEY_TO_DIRECTION[e.code];
    if (!dir) return;
    const i = held.indexOf(dir);
    if (i >= 0) held.splice(i, 1);
  };

  // 다른 창으로 넘어가면 keyup을 못 받으므로, 키가 눌린 채로 남지 않게 비운다.
  const onBlur = () => {
    held.length = 0;
  };

  let frame = 0;
  const loop = (now: number) => {
    // 1. 이동 중이면 시작 칸 중심 → 목표 칸 중심 사이를 시간에 비례해 보간한다.
    if (step) {
      const t = Math.min(1, (now - step.startedAt) / STEP_MS);
      place([
        step.from[0] + (step.to[0] - step.from[0]) * t,
        step.from[1] + (step.to[1] - step.from[1]) * t,
      ]);
      if (t === 1) {
        tile = step.target;
        z = step.z;
        step = null;
        options.onChange?.(tile, facing, z);
      }
    }

    // 2. 멈춰 있고 방향키가 눌려 있으면 다음 칸으로 출발한다.
    const next = held.length > 0 ? held[held.length - 1] : queued;
    if (!step && next) {
      const dir = next;
      queued = null;
      if (dir !== facing) {
        facing = dir;
        options.onChange?.(tile, facing, z);
        map.triggerRepaint(); // 제자리에서 방향만 바뀌어도 다시 그린다
      }
      const target = { x: tile.x + DELTA[dir].x, y: tile.y + DELTA[dir].y };
      // 막힌 칸이면 그쪽을 바라보기만 하고 제자리에 있는다.
      const nz = options.enter ? options.enter(tile, target, z) : z;
      if (nz !== null) {
        step = { from: tileCenter(tile), to: tileCenter(target), target, z: nz, startedAt: now };
      }
    }

    frame = requestAnimationFrame(loop);
  };

  place(pos);
  options.onChange?.(tile, facing, z);

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  frame = requestAnimationFrame(loop);

  return {
    getState: () => ({
      pos,
      facing,
      moving: step !== null,
      tile,
      z,
      next: step ? { tile: step.target, z: step.z, t: Math.min(1, (performance.now() - step.startedAt) / STEP_MS) } : null,
    }),
    teleport(target) {
      step = null;
      queued = null;
      tile = { ...target };
      z = 0;
      place(tileCenter(tile));
      options.onChange?.(tile, facing, z);
    },
    destroy() {
      cancelAnimationFrame(frame);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    },
  };
}
