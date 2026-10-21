import type { Map as MapLibreMap } from 'maplibre-gl';
import { API_BASE_URL } from '../api/config';

// 백엔드 GET /api/features/sample 이 GeoJSON FeatureCollection을 반환한다.
// 좌표는 GeoJSON 표준대로 WGS84 [경도, 위도] 순서다.
const SAMPLE_GEOJSON_URL = `${API_BASE_URL}/api/features/sample`;

const SOURCE_ID = 'sample';

/** 샘플 GeoJSON을 지도에 그린다. 지도 스타일 로딩이 끝난 뒤('load') 호출해야 한다. */
export function addSampleLayer(map: MapLibreMap): void {
  // 소스: 데이터를 어디서 가져오는지. MapLibre가 URL을 직접 요청한다.
  map.addSource(SOURCE_ID, {
    type: 'geojson',
    data: SAMPLE_GEOJSON_URL,
  });

  // 레이어: 같은 소스를 어떻게 그릴지. geometry 종류별로 나눠서 그린다.
  map.addLayer({
    id: 'sample-fill',
    type: 'fill',
    source: SOURCE_ID,
    filter: ['==', ['geometry-type'], 'Polygon'],
    paint: {
      'fill-color': '#3b82f6',
      'fill-opacity': 0.25,
    },
  });

  map.addLayer({
    id: 'sample-outline',
    type: 'line',
    source: SOURCE_ID,
    filter: ['==', ['geometry-type'], 'Polygon'],
    paint: {
      'line-color': '#1d4ed8',
      'line-width': 2,
    },
  });

  map.addLayer({
    id: 'sample-points',
    type: 'circle',
    source: SOURCE_ID,
    filter: ['==', ['geometry-type'], 'Point'],
    paint: {
      'circle-radius': 6,
      'circle-color': '#f97316',
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 2,
    },
  });
}
