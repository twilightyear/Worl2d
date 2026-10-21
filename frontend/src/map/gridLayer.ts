import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import { gridLines, tileRing, type TileId } from './grid';

/** 이 줌 이상에서만 격자선을 그린다. (줌 18.5에서 칸 하나가 화면에서 약 12px) */
export const GRID_MIN_ZOOM = 18.5;

const GRID_SOURCE = 'grid';
const SELECTED_SOURCE = 'selected-tile';

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

/** 격자선과 선택 칸 레이어를 추가한다. 지도 'load' 이후에 호출해야 한다. */
export function addGridLayer(map: MapLibreMap): void {
  map.addSource(GRID_SOURCE, { type: 'geojson', data: EMPTY });
  map.addSource(SELECTED_SOURCE, { type: 'geojson', data: EMPTY });

  map.addLayer({
    id: 'selected-tile-fill',
    type: 'fill',
    source: SELECTED_SOURCE,
    paint: { 'fill-color': '#facc15', 'fill-opacity': 0.6 },
  });

  map.addLayer({
    id: 'grid-lines',
    type: 'line',
    source: GRID_SOURCE,
    minzoom: GRID_MIN_ZOOM,
    paint: { 'line-color': '#111827', 'line-opacity': 0.3, 'line-width': 1 },
  });

  // 화면이 멈출 때마다 보이는 범위(+ 여유분)의 격자선만 다시 계산한다.
  const update = () => {
    const source = map.getSource<GeoJSONSource>(GRID_SOURCE);
    if (!source) return;
    if (map.getZoom() < GRID_MIN_ZOOM) {
      source.setData(EMPTY);
      return;
    }
    const b = map.getBounds();
    const padLng = (b.getEast() - b.getWest()) / 2;
    const padLat = (b.getNorth() - b.getSouth()) / 2;
    const lines = gridLines(
      b.getWest() - padLng,
      b.getSouth() - padLat,
      b.getEast() + padLng,
      b.getNorth() + padLat,
    );
    source.setData(lines ?? EMPTY);
  };

  update();
  map.on('moveend', update);
}

/** 선택한 칸을 강조한다. */
export function showSelectedTile(map: MapLibreMap, tile: TileId): void {
  map.getSource<GeoJSONSource>(SELECTED_SOURCE)?.setData({
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [tileRing(tile)] },
  });
}
