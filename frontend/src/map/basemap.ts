import type { Map as MapLibreMap } from 'maplibre-gl';
import { findVectorSourceId } from './tileClass';

const KEEPALIVE_ID = 'basemap-data-keepalive';

/**
 * 기본 지도(OpenFreeMap 스타일)의 레이어를 켜고 끄는 함수를 만든다.
 * 게임 화면이 기본 지도를 완전히 덮으므로, 게임 화면일 때는 꺼서 그리는 비용을 아낀다.
 * 지도 'load' 직후, 우리 레이어를 추가하기 전에 호출해야 한다. (그 시점의 레이어만 기본 지도로 본다)
 */
export function createBasemapToggle(map: MapLibreMap): (visible: boolean) => void {
  // 배경색 레이어는 남겨 둔다 (계산 전 영역이 투명하게 비지 않게)
  const ids = map
    .getStyle()
    .layers.filter((l) => l.type !== 'background')
    .map((l) => l.id);

  // 레이어를 모두 끄면 지도 데이터(벡터 타일)도 받아오지 않는다. 칸 종류 계산에는 데이터가 필요하므로,
  // 보이지 않는(투명한) 레이어 하나를 남겨 데이터를 계속 받게 한다.
  const sourceId = findVectorSourceId(map);
  if (sourceId) {
    map.addLayer({
      id: KEEPALIVE_ID,
      type: 'fill',
      source: sourceId,
      'source-layer': 'water',
      paint: { 'fill-opacity': 0 },
    });
  }

  let current: boolean | null = null;
  return (visible: boolean) => {
    if (visible === current) return;
    current = visible;
    for (const id of ids) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  };
}
