import type { TileId } from '../map/grid';
import { isWalkable, TileClass } from '../map/tileClass';
import type { TileStore } from '../map/tileStore';
import { blocks, hash, objectAt } from './placement';

/**
 * 층(높이) 규칙. 캐릭터는 지금 서 있는 층(z)을 가진다.
 * - z = 0: 땅 (다리 아래 포함)
 * - z = 1: 다리 상판 위
 * 층은 다리 끝에서 다리 방향으로 걸어 들어갈 때만 바뀐다. (다리 옆면은 난간이라 막힌다)
 */

// ---- 지형 층 ------------------------------------------------------------------
// 칸마다 해발 높이를 LEVEL_M(4m) 단위로 끊은 "층"이 있다 (map/terrain.ts).
// - 도로·보도블록(땅) 칸이 끼면 경사로로 보고 층이 달라도 오르내린다.
// - 풀밭끼리 층이 다르면 턱(절벽)이다: 한 층 아래로는 뛰어내릴 수 있고, 올라가려면 계단을 찾아야 한다.
// - 계단: 지도 데이터의 계단(OSM steps) + 턱을 따라 일정 간격으로 자동으로 놓는다.

const NEIGHBORS: [number, number][] = [
  [0, 1],
  [1, 0],
  [0, -1],
  [-1, 0],
];

/** 경사로로 보는 칸 (층이 달라도 걸어서 오르내린다) */
const isSlope = (cls: TileClass) => cls === TileClass.Road || cls === TileClass.Ground;
/** 턱이 생길 수 있는 칸 (자연 지형) */
const isNatural = (cls: TileClass | undefined) => cls === TileClass.Green;

/** a, b 두 칸 사이가 턱(절벽)인지 */
export function isLedge(store: TileStore, ax: number, ay: number, bx: number, by: number): boolean {
  if (!isNatural(store.get(ax, ay)) || !isNatural(store.get(bx, by))) return false;
  const la = store.level(ax, ay);
  const lb = store.level(bx, by);
  return la !== undefined && lb !== undefined && la !== lb;
}

/** 계단 칸인지: 지도 데이터의 계단이거나, 턱 위쪽 칸 중 9칸에 1칸꼴 */
export function isStairs(store: TileStore, x: number, y: number): boolean {
  if (store.osmStairs(x, y)) return true;
  if (hash(x, y) % 9 !== 0) return false;
  const l = store.level(x, y);
  return l !== undefined && NEIGHBORS.some(([dx, dy]) => isLedge(store, x, y, x + dx, y + dy) && store.level(x + dx, y + dy)! < l);
}

/** 계단이 내려가는 방향(이웃 칸 오프셋). 아래층 이웃이 없으면 남쪽 */
export function stairsDown(store: TileStore, x: number, y: number): [number, number] {
  const l = store.level(x, y);
  if (l !== undefined) {
    for (const [dx, dy] of NEIGHBORS) {
      const n = store.level(x + dx, y + dy);
      if (n !== undefined && n < l) return [dx, dy];
    }
  }
  return [0, -1];
}

/** 땅 층에서 from → to 이동이 지형(층 차이) 때문에 막히는지 */
function terrainAllows(store: TileStore, from: TileId, to: TileId): boolean {
  const lf = store.level(from.x, from.y);
  const lt = store.level(to.x, to.y);
  if (lf === undefined || lt === undefined || lf === lt) return true;
  const fc = store.get(from.x, from.y);
  const tc = store.get(to.x, to.y);
  if ((fc !== undefined && isSlope(fc)) || (tc !== undefined && isSlope(tc))) return true;
  if (isStairs(store, from.x, from.y) || isStairs(store, to.x, to.y)) return true;
  return lt === lf - 1; // 턱: 한 층 아래로 뛰어내리기만 된다
}

// ---- 다리 ----------------------------------------------------------------------

/** 다리 상판 높이(실제 m) */
export const DECK_M = 5;
/** 다리 끝에서 몇 칸에 걸쳐 경사로로 올라가는지 */
const RAMP_TILES = 3;

/** 다리 상판 높이(실제 m). 다리 끝 근처는 경사로라서 낮다. 다리가 아니면 0 */
export function deckHeightM(store: TileStore, x: number, y: number): number {
  const dir = store.bridge(x, y);
  if (!dir) return 0;
  const [dx, dy] = dir === 1 ? [1, 0] : [0, 1];
  // 다리 방향 앞뒤로 다리 끝까지 몇 칸인지 (RAMP_TILES칸까지만 센다)
  let ends = RAMP_TILES;
  for (const s of [1, -1]) {
    for (let i = 1; i <= RAMP_TILES; i++) {
      if (!store.bridge(x + dx * s * i, y + dy * s * i)) {
        ends = Math.min(ends, i);
        break;
      }
    }
  }
  return (DECK_M * ends) / RAMP_TILES;
}

/**
 * 칸 데이터와 맞지 않는 층을 바로잡는다.
 * - 다리가 없는데 상판 층이면 → 땅 (데이터가 다시 계산되어 다리가 사라진 경우)
 * - 다리 아래가 물처럼 설 수 없는 칸인데 땅 층이면 → 상판 (시작 위치가 다리 위인 경우)
 */
export function resolveZ(store: TileStore, x: number, y: number, z: number): number {
  const b = store.bridge(x, y);
  if (z >= 1 && !b) return 0;
  const cls = store.get(x, y);
  if (z === 0 && b && cls !== undefined && !isWalkable(cls)) return 1;
  return z;
}

/** 층 z에서 칸 바닥 높이(실제 m) */
export function surfaceM(store: TileStore, x: number, y: number, z: number): number {
  return resolveZ(store, x, y, z) >= 1 ? deckHeightM(store, x, y) : 0;
}

/**
 * from(층 z)에서 to로 한 칸 이동할 때 도착하는 층. 갈 수 없으면 null.
 * 아직 계산하지 않은 칸은 지나갈 수 있게 둔다. (막으면 데이터가 늦을 때 캐릭터가 멈춘다)
 */
export function stepLevel(store: TileStore, from: TileId, to: TileId, z: number): number | null {
  const cls = store.get(to.x, to.y);
  if (cls === undefined) return z;
  const axis = from.x !== to.x ? 1 : 2; // 이동 방향: 1 = 동서, 2 = 남북 (BridgeDir과 같은 값)
  const bFrom = store.bridge(from.x, from.y);
  const bTo = store.bridge(to.x, to.y);
  z = resolveZ(store, from.x, from.y, z);
  // 땅 층에서 들어갈 수 있는 칸: 건물·물, 가로등·나무·벤치가 없는 칸
  const groundOk = () => isWalkable(cls) && !blocks(objectAt(store, to.x, to.y));

  if (z >= 1) {
    if (bTo) return 1; // 상판 위를 계속 걷는다 (아래가 물이어도 된다)
    if (bFrom === axis && groundOk()) return 0; // 다리 끝에서 땅으로 내려선다 (다리 끝은 지형과 이어져 있다고 본다)
    return null; // 다리 옆은 난간
  }
  if (bTo && !bFrom && bTo === axis) return 1; // 다리 끝에서 다리 방향으로 올라탄다
  return groundOk() && terrainAllows(store, from, to) ? 0 : null; // 다리 아래로 지나가거나 그냥 땅
}
