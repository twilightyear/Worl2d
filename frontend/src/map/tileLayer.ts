import type { Feature, FeatureCollection, Polygon } from 'geojson';
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import { CHUNK_SIZE, chunkBounds, chunksInBounds, fromMercator, TILE_SIZE, type ChunkId } from './grid';
import { GRID_MIN_ZOOM } from './gridLayer';
import { classifyChunk, collectFeatures, findVectorSourceId, TILE_CLASS_COLOR, TileClass } from './tileClass';

const SOURCE_ID = 'game-tiles';
const LAYER_ID = 'game-tiles-fill';

// 우리 데이터 레이어들. 게임 타일은 이것들보다 아래에 깔아야 한다.
const OVERLAY_LAYER_IDS = ['sample-fill', 'selected-tile-fill', 'grid-lines'];

const key = ({ cx, cy }: ChunkId) => `${cx}_${cy}`;

type TileFeature = Feature<Polygon, { cls: number }>;

/**
 * 청크의 칸 종류를 사각형 도형으로 바꾼다.
 * 같은 줄에서 같은 종류가 이어지는 칸들은 사각형 하나로 묶어 도형 수를 줄인다.
 * (image 소스 + nearest 조합이 MapLibre 5.24에서 검게 그려져서, 경계가 선명한 벡터 도형을 쓴다)
 */
function chunkToFeatures(chunk: ChunkId, classes: Uint8Array): TileFeature[] {
  const b = chunkBounds(chunk);
  const features: TileFeature[] = [];
  for (let row = 0; row < CHUNK_SIZE; row++) {
    // row 0이 북쪽 줄이다.
    const maxY = b.maxY - row * TILE_SIZE;
    const minY = maxY - TILE_SIZE;
    let start = 0;
    for (let col = 1; col <= CHUNK_SIZE; col++) {
      const cls = classes[row * CHUNK_SIZE + start];
      if (col < CHUNK_SIZE && classes[row * CHUNK_SIZE + col] === cls) continue;
      const minX = b.minX + start * TILE_SIZE;
      const maxX = b.minX + col * TILE_SIZE;
      const sw = fromMercator(minX, minY);
      const ne = fromMercator(maxX, maxY);
      features.push({
        type: 'Feature',
        properties: { cls },
        geometry: {
          type: 'Polygon',
          coordinates: [[sw, [ne[0], sw[1]], ne, [sw[0], ne[1]], sw]],
        },
      });
      start = col;
    }
  }
  return features;
}

/**
 * 화면에 보이는 청크마다 칸 종류를 계산해 게임 타일로 칠한다.
 * 지도 'load' 이후에 호출한다. 반환값: 게임 타일 표시를 켜고 끄는 함수.
 */
export function addTileLayer(map: MapLibreMap): (visible: boolean) => void {
  const vectorSourceId = findVectorSourceId(map);
  const done = new Set<string>();
  const features: TileFeature[] = [];
  let visible = true;

  const empty: FeatureCollection = { type: 'FeatureCollection', features: [] };
  map.addSource(SOURCE_ID, { type: 'geojson', data: empty });

  // 칸 종류(cls) → 색
  const colorMatch: unknown[] = ['match', ['get', 'cls']];
  for (const cls of Object.values(TileClass)) colorMatch.push(cls, TILE_CLASS_COLOR[cls]);
  colorMatch.push(TILE_CLASS_COLOR[TileClass.Ground]);

  map.addLayer(
    {
      id: LAYER_ID,
      type: 'fill',
      source: SOURCE_ID,
      minzoom: GRID_MIN_ZOOM,
      paint: {
        'fill-color': colorMatch as never, // match 식은 배열로 만들어서 타입 검사를 우회한다
        'fill-antialias': false, // 붙어 있는 사각형 사이에 가는 틈이 보이지 않게
      },
    },
    OVERLAY_LAYER_IDS.find((id) => map.getLayer(id)),
  );

  const update = () => {
    if (!vectorSourceId || !visible || map.getZoom() < GRID_MIN_ZOOM) return;

    const b = map.getBounds();
    const pending = chunksInBounds(b.getWest(), b.getSouth(), b.getEast(), b.getNorth()).filter(
      (c) => !done.has(key(c)),
    );
    if (pending.length === 0) return;

    // 지도 데이터는 한 번만 꺼내서 이번에 계산할 청크들이 함께 쓴다.
    const draws = collectFeatures(map, vectorSourceId);
    if (draws.length === 0) return; // 아직 데이터가 안 들어왔으면 다음 idle 때 다시 시도

    for (const chunk of pending) {
      features.push(...chunkToFeatures(chunk, classifyChunk(chunk, draws)));
      done.add(key(chunk));
    }
    map.getSource<GeoJSONSource>(SOURCE_ID)?.setData({ type: 'FeatureCollection', features });
  };

  // 지도 이동과 데이터 로딩이 모두 끝난 시점(idle)에 계산한다.
  map.on('idle', update);
  update();

  return (next: boolean) => {
    visible = next;
    map.setLayoutProperty(LAYER_ID, 'visibility', next ? 'visible' : 'none');
    if (next) update();
  };
}
