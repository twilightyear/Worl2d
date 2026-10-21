import type { Map as MapLibreMap } from 'maplibre-gl';
import { CHUNK_SIZE, chunksInBounds, type ChunkId } from './grid';
import { GRID_MIN_ZOOM } from './gridLayer';
import { classifyChunk, collectFeatures, findVectorSourceId, type TileClass } from './tileClass';

const key = (cx: number, cy: number) => `${cx}_${cy}`;

export type TileStore = {
  /** 칸 종류. 아직 계산하지 않은 칸이면 undefined */
  get(x: number, y: number): TileClass | undefined;
};

/**
 * 화면에 보이는 청크의 칸 종류를 계산해서 보관한다.
 * 지도 'load' 이후에 호출한다. 새 청크를 계산하면 onUpdate를 호출한다.
 */
export function createTileStore(map: MapLibreMap, onUpdate: () => void): TileStore {
  const sourceId = findVectorSourceId(map);
  const chunks = new Map<string, Uint8Array>();

  const update = () => {
    if (!sourceId || map.getZoom() < GRID_MIN_ZOOM) return;
    const b = map.getBounds();
    const pending: ChunkId[] = chunksInBounds(b.getWest(), b.getSouth(), b.getEast(), b.getNorth()).filter(
      (c) => !chunks.has(key(c.cx, c.cy)),
    );
    if (pending.length === 0) return;

    // 지도 데이터는 한 번만 꺼내서 이번에 계산할 청크들이 함께 쓴다.
    const draws = collectFeatures(map, sourceId);
    if (draws.length === 0) return; // 아직 데이터가 안 들어왔으면 다음 idle 때 다시 시도

    for (const c of pending) chunks.set(key(c.cx, c.cy), classifyChunk(c, draws));
    onUpdate();
  };

  // 지도 이동과 데이터 로딩이 모두 끝난 시점(idle)에 계산한다.
  map.on('idle', update);
  update();

  return {
    get(x, y) {
      const cx = Math.floor(x / CHUNK_SIZE);
      const cy = Math.floor(y / CHUNK_SIZE);
      const classes = chunks.get(key(cx, cy));
      if (!classes) return undefined;
      const col = x - cx * CHUNK_SIZE;
      const row = CHUNK_SIZE - 1 - (y - cy * CHUNK_SIZE); // row 0이 북쪽 줄
      return classes[row * CHUNK_SIZE + col] as TileClass;
    },
  };
}
