import { TileClass } from '../map/tileClass';
import type { TileStore } from '../map/tileStore';

/**
 * 칸 종류만 보고 정하는 배치 규칙 (같은 칸은 항상 같은 결과).
 * - 도로 가장자리 칸은 보도, 안쪽은 차도
 * - 보도·공원에 가로등, 나무, 벤치를 규칙적으로 놓는다
 * 렌더러(그리기)와 충돌 판정이 같은 규칙을 쓴다.
 */

export type ObjectKind = 'lamp' | 'streetTree' | 'tree' | 'bench';

const mod = (v: number, n: number) => ((v % n) + n) % n;
export const hash = (x: number, y: number) => (Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) >>> 0;

const NEIGHBORS: [number, number][] = [
  [0, 1],
  [1, 0],
  [0, -1],
  [-1, 0],
];

/** 도로 칸 중 도로가 아닌 칸과 맞닿은 칸 = 보도 (계산 전인 칸은 도로로 본다) */
export function isSidewalk(store: TileStore, x: number, y: number): boolean {
  if (store.get(x, y) !== TileClass.Road) return false;
  return NEIGHBORS.some(([dx, dy]) => {
    const c = store.get(x + dx, y + dy);
    return c !== undefined && c !== TileClass.Road;
  });
}

/** 도로 칸 중 보도가 아닌 칸 = 차도 */
export function isAsphalt(store: TileStore, x: number, y: number): boolean {
  return store.get(x, y) === TileClass.Road && !isSidewalk(store, x, y);
}

/** 칸에 놓이는 물체 (없으면 null) */
export function objectAt(store: TileStore, x: number, y: number): ObjectKind | null {
  const cls = store.get(x, y);
  if (cls === TileClass.Road) {
    if (!isSidewalk(store, x, y)) return null;
    // 차도와 맞닿은(연석 쪽) 보도에, 8칸마다 가로등과 가로수를 번갈아 놓는다
    const curb = NEIGHBORS.some(([dx, dy]) => isAsphalt(store, x + dx, y + dy));
    if (!curb) return null;
    const m = mod(x + y, 8);
    if (m === 0) return 'lamp';
    if (m === 4) return 'streetTree';
    return null;
  }
  if (cls === TileClass.Green) {
    const edge = NEIGHBORS.some(([dx, dy]) => {
      const c = store.get(x + dx, y + dy);
      return c !== undefined && c !== TileClass.Green;
    });
    const h = hash(x, y);
    if (!edge && h % 12 === 0) return 'tree'; // 공원 안쪽: 나무 (칸 12개당 1그루)
    if (edge && h % 17 === 0) return 'bench'; // 공원 가장자리: 벤치
  }
  return null;
}

/** 지나갈 수 없는 물체인지 */
export function blocks(kind: ObjectKind | null): boolean {
  return kind !== null;
}
