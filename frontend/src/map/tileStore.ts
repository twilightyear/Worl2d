import type { Map as MapLibreMap } from 'maplibre-gl';
import { CHUNK_SIZE, chunkOf, chunksInBounds, tileAt, type ChunkId } from './grid';
import { GRID_MIN_ZOOM } from './gridLayer';
import { classifyChunk, collectFeatures, findVectorSourceId, type ChunkData, type Draw, type TileClass } from './tileClass';

// 청크 키를 숫자로 만든다 (문자열을 매번 만들지 않게). |cy|는 25만을 넘지 않는다.
const key = (cx: number, cy: number) => cx * 1_000_000 + cy;

export type TileStore = {
  /** 칸 종류. 아직 계산하지 않은 칸이면 undefined */
  get(x: number, y: number): TileClass | undefined;
  /** 건물 높이(m). 건물이 아니거나 계산 전이면 0 */
  height(x: number, y: number): number;
  /** 청크 데이터 (계산 전이면 undefined) */
  chunk(cx: number, cy: number): ChunkData | undefined;
};

/**
 * 화면에 보이는 청크의 칸 종류를 계산해서 보관한다.
 * 지도 'load' 이후에 호출한다. 새 청크를 계산하면 onUpdate를 호출한다.
 */
export function createTileStore(map: MapLibreMap, onUpdate: () => void): TileStore {
  const sourceId = findVectorSourceId(map);
  const chunks = new Map<number, ChunkData>();
  // 지도 데이터에서 모은 도형. 지도 데이터가 새로 들어오면 다시 모은다.
  let draws: Draw[] | null = null;
  map.on('sourcedata', (e) => {
    if (e.sourceId === sourceId && e.tile) draws = null;
  });
  let scheduled = false;

  const update = () => {
    if (!sourceId || map.getZoom() < GRID_MIN_ZOOM) return;
    // 화면보다 사방으로 화면 절반만큼 넓게 미리 계산해 둔다. (걸어가는 쪽이 미리 준비되도록)
    const b = map.getBounds();
    const padLng = (b.getEast() - b.getWest()) / 2;
    const padLat = (b.getNorth() - b.getSouth()) / 2;
    const pending: ChunkId[] = chunksInBounds(
      b.getWest() - padLng,
      b.getSouth() - padLat,
      b.getEast() + padLng,
      b.getNorth() + padLat,
    ).filter((c) => !chunks.has(key(c.cx, c.cy)));
    if (pending.length === 0) return;

    if (!draws) draws = collectFeatures(map, sourceId);
    if (draws.length === 0) {
      draws = null; // 아직 데이터가 안 들어왔으면 다음에 다시 시도
      return;
    }

    // 화면 중심에 가까운 청크부터, 한 번에 한 청크만 계산한다. (한 프레임이 길게 멈추지 않게)
    const center = map.getCenter();
    const here = chunkOf(tileAt(center.lng, center.lat));
    pending.sort(
      (a, b) => Math.hypot(a.cx - here.cx, a.cy - here.cy) - Math.hypot(b.cx - here.cx, b.cy - here.cy),
    );
    const c = pending[0];
    chunks.set(key(c.cx, c.cy), classifyChunk(c, draws));
    onUpdate();

    // 남은 청크는 다음 프레임에 이어서 계산한다.
    if (pending.length > 1 && !scheduled) {
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        update();
      });
    }
  };

  // 데이터 로딩이 끝났을 때(idle)와, 캐릭터 이동처럼 지도가 계속 움직이는 중(moveend)에도 계산한다.
  // 새로 계산할 청크가 없으면 바로 끝나므로 자주 호출해도 부담이 적다.
  map.on('idle', update);
  map.on('moveend', update);
  update();

  // 칸 좌표 → (청크 데이터, 배열 index)
  const locate = (x: number, y: number): [ChunkData, number] | null => {
    const cx = Math.floor(x / CHUNK_SIZE);
    const cy = Math.floor(y / CHUNK_SIZE);
    const data = chunks.get(key(cx, cy));
    if (!data) return null;
    const col = x - cx * CHUNK_SIZE;
    const row = CHUNK_SIZE - 1 - (y - cy * CHUNK_SIZE); // row 0이 북쪽 줄
    return [data, row * CHUNK_SIZE + col];
  };

  return {
    get(x, y) {
      const found = locate(x, y);
      return found ? (found[0].classes[found[1]] as TileClass) : undefined;
    },
    height(x, y) {
      const found = locate(x, y);
      return found ? found[0].heights[found[1]] : 0;
    },
    chunk(cx, cy) {
      return chunks.get(key(cx, cy));
    },
  };
}
