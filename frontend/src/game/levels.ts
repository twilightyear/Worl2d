import type { TileId } from '../map/grid';
import { isWalkable } from '../map/tileClass';
import type { TileStore } from '../map/tileStore';
import { blocks, objectAt } from './placement';

/**
 * 층(높이) 규칙. 캐릭터는 지금 서 있는 층(z)을 가진다.
 * - z = 0: 땅 (다리 아래 포함)
 * - z = 1: 다리 상판 위
 * 층은 다리 끝에서 다리 방향으로 걸어 들어갈 때만 바뀐다. (다리 옆면은 난간이라 막힌다)
 */

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
    if (bFrom === axis && groundOk()) return 0; // 다리 끝에서 땅으로 내려선다
    return null; // 다리 옆은 난간
  }
  if (bTo && !bFrom && bTo === axis) return 1; // 다리 끝에서 다리 방향으로 올라탄다
  return groundOk() ? 0 : null; // 다리 아래로 지나가거나 그냥 땅
}
