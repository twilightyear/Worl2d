import type { TileId } from '../map/grid';
import { TileClass } from '../map/tileClass';
import type { TileStore } from '../map/tileStore';
import type { Direction } from './character';
import { hash } from './placement';
import { SPRITE_PX } from './sprites';
import type { Tileset } from './tileset';

/**
 * 건물 실내. 실제 실내 도면 데이터는 없으므로 자동으로 만든다.
 * - 바닥 모양 = 실제 건물 외곽(문 칸에서 이어진 건물 칸들)
 * - 층 수 = 건물 높이 ÷ 3m (1~6층)
 * - 층마다 올라가는 계단·내려가는 계단, 가구(탁자·화분)를 칸 좌표 해시로 배치 (같은 건물은 항상 같은 모양)
 * 실내에 있는 동안은 바깥 캐릭터를 멈추고, 이 모듈이 키 입력·그리기를 맡는다.
 */

const STEP_MS = 220;
/** 실내로 쓸 최대 칸 수 (아주 큰 건물은 문 근처 일부만) */
const MAX_CELLS = 1500;
/** 층 하나의 높이(m) */
const FLOOR_M = 3;
const MAX_FLOORS = 6;

const DELTA: Record<Direction, [number, number]> = { up: [0, 1], down: [0, -1], left: [-1, 0], right: [1, 0] };
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
const NEIGHBORS: [number, number][] = [
  [0, 1],
  [1, 0],
  [0, -1],
  [-1, 0],
];
const key = (x: number, y: number) => `${x},${y}`;

/** 문이 있는 건물 칸인지: 렌더러가 문을 그리는 칸(4칸 중 1칸꼴) 중 바깥 땅과 맞닿은 칸 */
export function isDoorCell(store: TileStore, x: number, y: number): boolean {
  if (store.get(x, y) !== TileClass.Building || hash(x, y) % 4 !== 0) return false;
  return NEIGHBORS.some(([dx, dy]) => {
    const c = store.get(x + dx, y + dy);
    return c !== undefined && c !== TileClass.Building && c !== TileClass.Water;
  });
}

type Furniture = 'table' | 'plant';
type Floor = {
  up: string | null; // 올라가는 계단 칸
  down: string | null; // 내려가는 계단 칸
  furniture: Map<string, Furniture>;
};

type Layout = { cells: Set<string>; list: TileId[]; floors: Floor[]; door: string };

/** 문 칸에서 너비 우선 탐색으로 거리(칸 수)를 잰다 */
function distances(cells: Set<string>, from: TileId): Map<string, number> {
  const dist = new Map<string, number>([[key(from.x, from.y), 0]]);
  const queue: TileId[] = [from];
  for (let i = 0; i < queue.length; i++) {
    const c = queue[i];
    const d = dist.get(key(c.x, c.y))!;
    for (const [dx, dy] of NEIGHBORS) {
      const k = key(c.x + dx, c.y + dy);
      if (cells.has(k) && !dist.has(k)) {
        dist.set(k, d + 1);
        queue.push({ x: c.x + dx, y: c.y + dy });
      }
    }
  }
  return dist;
}

function buildLayout(store: TileStore, door: TileId): Layout {
  // 1) 바닥: 문 칸에서 이어진 건물 칸
  const cells = new Set<string>([key(door.x, door.y)]);
  const list: TileId[] = [door];
  for (let i = 0; i < list.length && list.length < MAX_CELLS; i++) {
    const c = list[i];
    for (const [dx, dy] of NEIGHBORS) {
      const x = c.x + dx;
      const y = c.y + dy;
      const k = key(x, y);
      if (!cells.has(k) && store.get(x, y) === TileClass.Building) {
        cells.add(k);
        list.push({ x, y });
      }
    }
  }
  // 2) 층 수: 건물에서 가장 높은 칸 기준
  let maxH = 0;
  for (const c of list) maxH = Math.max(maxH, store.height(c.x, c.y));
  const count = Math.max(1, Math.min(MAX_FLOORS, Math.round(maxH / FLOOR_M)));

  // 3) 계단: 층마다 '들어온 곳(문 또는 아래층 계단)'에서 가장 먼 칸에 올라가는 계단
  //    (바닥이 너무 작아 먼 칸이 없으면 1층짜리로 본다)
  const floors: Floor[] = [];
  let entry = door;
  for (let f = 0; f < count; f++) {
    const dist = distances(cells, entry);
    const down = f === 0 ? null : key(entry.x, entry.y);
    let up: string | null = null;
    if (f < count - 1) {
      let best = -1;
      for (const c of list) {
        const d = dist.get(key(c.x, c.y)) ?? -1;
        // 같은 거리면 해시로 골라서 건물마다 위치가 달라지게
        if (d > best || (d === best && hash(c.x + f, c.y) % 2 === 0)) {
          best = d;
          up = key(c.x, c.y);
        }
      }
      if (best < 2) up = null;
    }
    floors.push({ up, down, furniture: new Map() });
    if (!up) break;
    const [ux, uy] = up.split(',').map(Number);
    entry = { x: ux, y: uy };
  }

  // 4) 가구: 사방이 실내인 칸(넓은 곳)에만, 계단·문 근처와 다른 가구 옆은 피해서
  const doorKey = key(door.x, door.y);
  floors.forEach((fl, f) => {
    const special = [fl.up, fl.down, f === 0 ? doorKey : null].filter((k): k is string => !!k).map((k) => k.split(',').map(Number));
    for (const c of list) {
      if (hash(c.x * 7 + f, c.y * 13) % 9 !== 0) continue;
      if (!NEIGHBORS.every(([dx, dy]) => cells.has(key(c.x + dx, c.y + dy)))) continue;
      if (special.some(([sx, sy]) => Math.abs(sx - c.x) + Math.abs(sy - c.y) <= 2)) continue;
      if (NEIGHBORS.some(([dx, dy]) => fl.furniture.has(key(c.x + dx, c.y + dy)))) continue;
      fl.furniture.set(key(c.x, c.y), hash(c.y, c.x) % 3 === 0 ? 'plant' : 'table');
    }
  });
  return { cells, list, floors, door: doorKey };
}

// ---- 그림 (코드로 그리는 16px 도트) -------------------------------------------------
function sprite(draw: (g: CanvasRenderingContext2D) => void): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = SPRITE_PX;
  c.height = SPRITE_PX;
  const g = c.getContext('2d')!;
  draw(g);
  return c;
}
const px = (g: CanvasRenderingContext2D, color: string, x: number, y: number, w: number, h: number) => {
  g.fillStyle = color;
  g.fillRect(x, y, w, h);
};
const SPRITES = {
  floor: [0, 1].map((v) =>
    sprite((g) => {
      px(g, v ? '#c99a63' : '#c4955e', 0, 0, 16, 16); // 나무 마루
      for (let y = 3; y < 16; y += 4) px(g, '#a77c4a', 0, y, 16, 1);
      px(g, '#a77c4a', v ? 5 : 11, 0, 1, 3);
      px(g, '#a77c4a', v ? 12 : 3, 4, 1, 3);
      px(g, '#a77c4a', v ? 7 : 9, 8, 1, 3);
      px(g, '#a77c4a', v ? 2 : 14, 12, 1, 3);
    }),
  ),
  wall: [0, 1].map((win) =>
    sprite((g) => {
      px(g, '#e9e1cf', 0, 0, 16, 16); // 벽지
      px(g, '#d8cdb5', 0, 0, 16, 2);
      px(g, '#8d7a5a', 0, 13, 16, 3); // 걸레받이
      if (win) {
        px(g, '#6b5a40', 3, 2, 10, 9);
        px(g, '#9fd3ec', 4, 3, 8, 7);
        px(g, '#d9f1fb', 4, 3, 3, 2);
        px(g, '#6b5a40', 7, 3, 1, 7);
      }
    }),
  ),
  table: sprite((g) => {
    px(g, 'rgba(0,0,0,0.2)', 2, 12, 12, 3);
    px(g, '#7a4e2a', 2, 4, 12, 8);
    px(g, '#9c6a3c', 2, 4, 12, 6);
    px(g, '#5c3a1e', 3, 11, 2, 3);
    px(g, '#5c3a1e', 11, 11, 2, 3);
    px(g, '#f2efe6', 6, 5, 4, 3); // 책
  }),
  plant: sprite((g) => {
    px(g, 'rgba(0,0,0,0.2)', 4, 13, 8, 2);
    px(g, '#b5653a', 5, 9, 6, 5);
    px(g, '#8e4c29', 5, 9, 6, 1);
    px(g, '#3f9b4a', 3, 2, 10, 7);
    px(g, '#5cc06a', 5, 1, 6, 5);
    px(g, '#2f7a39', 4, 6, 3, 2);
  }),
  up: sprite((g) => {
    px(g, '#9aa0a6', 0, 0, 16, 16);
    for (let y = 0; y < 16; y += 4) {
      px(g, '#d5d9dd', 0, y, 16, 2);
      px(g, '#6c7278', 0, y + 3, 16, 1);
    }
    px(g, '#2b6cb0', 6, 2, 4, 1); // ▲ 표시
    px(g, '#2b6cb0', 5, 3, 6, 1);
  }),
  down: sprite((g) => {
    px(g, '#5f656b', 0, 0, 16, 16);
    for (let y = 0; y < 16; y += 4) {
      px(g, '#8b9197', 0, y + 2, 16, 2);
      px(g, '#3e4348', 0, y, 16, 1);
    }
    px(g, '#e8b23a', 5, 12, 6, 1); // ▼ 표시
    px(g, '#e8b23a', 6, 13, 4, 1);
  }),
  mat: sprite((g) => {
    px(g, '#a8323a', 2, 3, 12, 10);
    px(g, '#d0525a', 3, 4, 10, 8);
    px(g, '#a8323a', 4, 6, 8, 1);
    px(g, '#a8323a', 4, 9, 8, 1);
  }),
};

// ---- 실내 화면 ---------------------------------------------------------------------
export type InteriorOptions = {
  store: TileStore;
  /** 문 칸 (건물 칸) */
  door: TileId;
  /** 들어오기 직전에 서 있던 바깥 칸 (나갈 때 이 칸으로 돌아간다) */
  outside: TileId;
  container: HTMLElement;
  tileset: () => Promise<Tileset>;
  /** 층이 바뀌거나 칸을 옮길 때 (표시용) */
  onChange?: (floor: number, floors: number) => void;
  /** 밖으로 나갈 때 */
  onExit: (outside: TileId) => void;
};

export type Interior = { destroy(): void };

export function createInterior(opts: InteriorOptions): Interior {
  const layout = buildLayout(opts.store, opts.door);
  let floor = 0;
  let tile: TileId = { ...opts.door };
  // 들어온 방향(바깥 → 문)을 바라본다
  const dx0 = opts.door.x - opts.outside.x;
  const dy0 = opts.door.y - opts.outside.y;
  let facing: Direction = dx0 > 0 ? 'right' : dx0 < 0 ? 'left' : dy0 > 0 ? 'up' : 'down';
  let step: { from: TileId; to: TileId; startedAt: number } | null = null;
  const held: Direction[] = [];
  let queued: Direction | null = null;
  let tileset: Tileset | null = null;
  let destroyed = false;
  opts.tileset().then((t) => (tileset = t)).catch(() => {});

  const canvas = document.createElement('canvas');
  canvas.className = 'interior-canvas';
  opts.container.appendChild(canvas);
  const ctx = canvas.getContext('2d')!;

  const onKeyDown = (e: KeyboardEvent) => {
    const dir = KEY_TO_DIRECTION[e.code];
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();
    if (!held.includes(dir)) held.push(dir);
    if (!e.repeat) queued = dir;
  };
  const onKeyUp = (e: KeyboardEvent) => {
    const dir = KEY_TO_DIRECTION[e.code];
    if (!dir) return;
    const i = held.indexOf(dir);
    if (i >= 0) held.splice(i, 1);
  };
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);

  const fl = () => layout.floors[floor];
  const blocked = (x: number, y: number) => {
    const k = key(x, y);
    return !layout.cells.has(k) || fl().furniture.has(k);
  };
  opts.onChange?.(floor, layout.floors.length);

  const arrive = (t: TileId) => {
    tile = t;
    const k = key(t.x, t.y);
    // 계단을 밟으면 층을 옮긴다 (도착한 층에서는 같은 자리의 반대 계단 위에 선다)
    if (k === fl().up) floor++;
    else if (k === fl().down) floor--;
    else return;
    opts.onChange?.(floor, layout.floors.length);
  };

  const exit = () => {
    if (destroyed) return;
    destroy();
    opts.onExit(opts.outside);
  };

  let frame = 0;
  const loop = (now: number) => {
    if (step && now - step.startedAt >= STEP_MS) {
      const to = step.to;
      step = null;
      arrive(to);
    }
    const next = held.length > 0 ? held[held.length - 1] : queued;
    if (!step && next) {
      queued = null;
      facing = next;
      const [dx, dy] = DELTA[next];
      const to = { x: tile.x + dx, y: tile.y + dy };
      if (floor === 0 && key(tile.x, tile.y) === layout.door && to.x === opts.outside.x && to.y === opts.outside.y) {
        exit(); // 문 칸에서 바깥 쪽으로 나간다
        return;
      }
      if (floor === 0 && key(to.x, to.y) === layout.door) {
        step = { from: tile, to, startedAt: now };
      } else if (!blocked(to.x, to.y)) {
        step = { from: tile, to, startedAt: now };
      }
    }
    draw(now);
    frame = requestAnimationFrame(loop);
  };

  const draw = (now: number) => {
    const dpr = window.devicePixelRatio || 1;
    const w = opts.container.clientWidth;
    const h = opts.container.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    // 화면에 칸이 대략 세로 11칸 보이게 하는 정수 배율
    const S = Math.max(2, Math.round(canvas.height / (SPRITE_PX * 11)));
    const T = SPRITE_PX * S;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#16120e';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 캐릭터 위치(칸 단위, 이동 중이면 보간)
    let cx = tile.x;
    let cy = tile.y;
    if (step) {
      const t = Math.min(1, (now - step.startedAt) / STEP_MS);
      cx = step.from.x + (step.to.x - step.from.x) * t;
      cy = step.from.y + (step.to.y - step.from.y) * t;
    }
    // 칸 (x, y)의 화면 왼쪽 위. y는 북쪽이 크므로 화면에서는 뒤집는다
    const sx = (x: number) => Math.round(canvas.width / 2 + (x - cx - 0.5) * T);
    const sy = (y: number) => Math.round(canvas.height / 2 - (y - cy + 0.5) * T);
    const span = Math.ceil(Math.max(canvas.width, canvas.height) / T / 2) + 2;
    const f = fl();
    for (const c of layout.list) {
      if (Math.abs(c.x - cx) > span || Math.abs(c.y - cy) > span) continue;
      const k = key(c.x, c.y);
      const X = sx(c.x);
      const Y = sy(c.y);
      ctx.drawImage(SPRITES.floor[hash(c.x, c.y) % 2], X, Y, T, T);
      // 뒤쪽(북쪽)이 바깥이면 그 자리에 벽을 세운다 (창문은 해시로)
      if (!layout.cells.has(key(c.x, c.y + 1))) ctx.drawImage(SPRITES.wall[hash(c.x, c.y + floor) % 3 === 0 ? 1 : 0], X, Y - T, T, T);
      if (k === f.up) ctx.drawImage(SPRITES.up, X, Y, T, T);
      if (k === f.down) ctx.drawImage(SPRITES.down, X, Y, T, T);
      if (floor === 0 && k === layout.door) ctx.drawImage(SPRITES.mat, X, Y, T, T);
      // 옆·앞쪽 외벽 선
      ctx.fillStyle = '#3a2f24';
      if (!layout.cells.has(key(c.x - 1, c.y))) ctx.fillRect(X, Y, S * 2, T);
      if (!layout.cells.has(key(c.x + 1, c.y))) ctx.fillRect(X + T - S * 2, Y, S * 2, T);
      if (!layout.cells.has(key(c.x, c.y - 1))) ctx.fillRect(X, Y + T - S * 3, T, S * 3);
    }
    // 가구와 캐릭터: 뒤쪽(북쪽)부터
    const items: { y: number; draw: () => void }[] = [];
    for (const [k, kind] of f.furniture) {
      const [x, y] = k.split(',').map(Number);
      if (Math.abs(x - cx) > span || Math.abs(y - cy) > span) continue;
      items.push({ y, draw: () => ctx.drawImage(SPRITES[kind], sx(x), sy(y), T, T) });
    }
    items.push({
      y: cy,
      draw: () => {
        const X = sx(cx);
        const Y = sy(cy);
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.beginPath();
        ctx.ellipse(X + T / 2, Y + T * 0.85, T * 0.3, T * 0.1, 0, 0, Math.PI * 2);
        ctx.fill();
        if (tileset) {
          const col = { down: 0, up: 1, left: 2, right: 3 }[facing];
          const row = step ? Math.floor(now / 125) % 4 : 0;
          ctx.drawImage(tileset.character, col * 16, row * 16, 16, 16, X, Y - S * 2, T, T);
        } else {
          ctx.fillStyle = '#ef4444';
          ctx.fillRect(X + T * 0.25, Y + T * 0.2, T * 0.5, T * 0.6);
        }
      },
    });
    items.sort((a, b) => b.y - a.y).forEach((it) => it.draw());

    // 층 표시
    const label = `${floor + 1}F / ${layout.floors.length}F`;
    ctx.font = `bold ${Math.round(12 * dpr)}px ui-monospace, monospace`;
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(canvas.width - tw - 28 * dpr, canvas.height - 40 * dpr, tw + 16 * dpr, 26 * dpr);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, canvas.width - tw - 20 * dpr, canvas.height - 22 * dpr);
  };

  const destroy = () => {
    destroyed = true;
    cancelAnimationFrame(frame);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    canvas.remove();
  };

  frame = requestAnimationFrame(loop);
  return { destroy };
}
