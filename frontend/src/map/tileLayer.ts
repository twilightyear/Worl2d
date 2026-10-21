import type { Map as MapLibreMap } from 'maplibre-gl';
import { CHUNK_SIZE, chunkBounds, chunksInBounds, fromMercator, type ChunkId } from './grid';
import { GRID_MIN_ZOOM } from './gridLayer';
import { classifyChunk, collectFeatures, findVectorSourceId, TILE_CLASS_COLOR, type TileClass } from './tileClass';

const LAYER_PREFIX = 'tile-chunk-';

// 우리 데이터 레이어들. 게임 타일은 이것들보다 아래에 깔아야 한다.
const OVERLAY_LAYER_IDS = ['sample-fill', 'selected-tile-fill', 'grid-lines'];

const key = ({ cx, cy }: ChunkId) => `${cx}_${cy}`;

/** 칸 종류 배열을 칸 1개 = 1px 이미지로 만든다. */
function renderChunkImage(classes: Uint8Array): string {
  const canvas = document.createElement('canvas');
  canvas.width = CHUNK_SIZE;
  canvas.height = CHUNK_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context를 만들 수 없습니다');
  for (let i = 0; i < classes.length; i++) {
    ctx.fillStyle = TILE_CLASS_COLOR[classes[i] as TileClass];
    ctx.fillRect(i % CHUNK_SIZE, Math.floor(i / CHUNK_SIZE), 1, 1);
  }
  return canvas.toDataURL();
}

/** 청크 네 모서리 경위도 [좌상, 우상, 우하, 좌하] (MapLibre image 소스 형식) */
function chunkCorners(chunk: ChunkId): [[number, number], [number, number], [number, number], [number, number]] {
  const b = chunkBounds(chunk);
  return [
    fromMercator(b.minX, b.maxY),
    fromMercator(b.maxX, b.maxY),
    fromMercator(b.maxX, b.minY),
    fromMercator(b.minX, b.minY),
  ];
}

/**
 * 화면에 보이는 청크마다 칸 종류를 계산해 게임 타일 이미지로 붙인다.
 * 지도 'load' 이후에 호출한다. 반환값: 게임 타일 표시를 켜고 끄는 함수.
 */
export function addTileLayer(map: MapLibreMap): (visible: boolean) => void {
  const sourceId = findVectorSourceId(map);
  const done = new Set<string>();
  let visible = true;

  const beforeId = () => OVERLAY_LAYER_IDS.find((id) => map.getLayer(id));

  const update = () => {
    if (!sourceId || !visible || map.getZoom() < GRID_MIN_ZOOM) return;

    const b = map.getBounds();
    const pending = chunksInBounds(b.getWest(), b.getSouth(), b.getEast(), b.getNorth()).filter(
      (c) => !done.has(key(c)),
    );
    if (pending.length === 0) return;

    // 지도 데이터는 한 번만 꺼내서 이번에 계산할 청크들이 함께 쓴다.
    const draws = collectFeatures(map, sourceId);
    if (draws.length === 0) return; // 아직 데이터가 안 들어왔으면 다음 idle 때 다시 시도

    for (const chunk of pending) {
      const id = LAYER_PREFIX + key(chunk);
      map.addSource(id, { type: 'image', url: renderChunkImage(classifyChunk(chunk, draws)), coordinates: chunkCorners(chunk) });
      map.addLayer(
        {
          id,
          type: 'raster',
          source: id,
          minzoom: GRID_MIN_ZOOM,
          paint: { 'raster-resampling': 'nearest', 'raster-fade-duration': 0 },
        },
        beforeId(),
      );
      done.add(key(chunk));
    }
  };

  // 지도 이동과 데이터 로딩이 모두 끝난 시점(idle)에 계산한다.
  map.on('idle', update);
  update();

  return (next: boolean) => {
    visible = next;
    for (const k of done) {
      map.setLayoutProperty(LAYER_PREFIX + k, 'visibility', next ? 'visible' : 'none');
    }
    if (next) update();
  };
}
