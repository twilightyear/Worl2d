import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import { fromMercator, TILE_SIZE, tileRing, type TileId } from '../map/grid';

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
/** 캐릭터 크기 = 칸 크기 × 이 비율 */
const SPRITE_SCALE = 0.8;

type Mercator = [number, number];

type Step = { from: Mercator; to: Mercator; target: TileId; startedAt: number };

export type CharacterOptions = {
  start: TileId;
  /** 캐릭터가 새 칸에 도착하거나 방향을 바꿀 때 호출된다. */
  onChange?: (tile: TileId, facing: Direction) => void;
};

const tileCenter = (tile: TileId): Mercator => [
  (tile.x + 0.5) * TILE_SIZE,
  (tile.y + 0.5) * TILE_SIZE,
];

/**
 * 지도 위에 캐릭터를 놓고 키보드로 한 칸씩 움직인다. 카메라는 캐릭터를 따라간다.
 * 지도 'load' 이후에 호출하고, 반환된 함수로 정리한다.
 */
export function createCharacter(map: MapLibreMap, options: CharacterOptions): () => void {
  let tile: TileId = { ...options.start };
  let facing: Direction = 'down';
  let step: Step | null = null;
  const held: Direction[] = []; // 누르고 있는 방향들. 마지막에 누른 방향이 우선

  const el = document.createElement('div');
  el.className = 'character';
  el.dataset.facing = facing;
  const marker = new maplibregl.Marker({ element: el });

  // 줌이 바뀌면 칸의 화면 크기에 맞춰 캐릭터 크기를 다시 계산한다.
  const resize = () => {
    const ring = tileRing(tile);
    const sw = map.project(ring[0]);
    const ne = map.project(ring[2]);
    const size = Math.abs(ne.x - sw.x) * SPRITE_SCALE;
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
  };

  // 캐릭터와 카메라를 같은 위치에 둔다.
  const place = ([x, y]: Mercator) => {
    const lngLat = fromMercator(x, y);
    marker.setLngLat(lngLat);
    map.jumpTo({ center: lngLat });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const dir = KEY_TO_DIRECTION[e.code];
    if (!dir) return;
    e.preventDefault(); // 방향키로 페이지가 스크롤되지 않게
    if (!held.includes(dir)) held.push(dir);
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
        step = null;
        options.onChange?.(tile, facing);
      }
    }

    // 2. 멈춰 있고 방향키가 눌려 있으면 다음 칸으로 출발한다.
    if (!step && held.length > 0) {
      const dir = held[held.length - 1];
      if (dir !== facing) {
        facing = dir;
        el.dataset.facing = dir;
        options.onChange?.(tile, facing);
      }
      const target = { x: tile.x + DELTA[dir].x, y: tile.y + DELTA[dir].y };
      step = { from: tileCenter(tile), to: tileCenter(target), target, startedAt: now };
    }

    frame = requestAnimationFrame(loop);
  };

  marker.setLngLat(fromMercator(...tileCenter(tile))).addTo(map);
  place(tileCenter(tile));
  resize();
  options.onChange?.(tile, facing);

  map.on('zoom', resize);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  frame = requestAnimationFrame(loop);

  return () => {
    cancelAnimationFrame(frame);
    map.off('zoom', resize);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    marker.remove();
  };
}
