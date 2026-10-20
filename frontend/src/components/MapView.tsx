import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

// 환경변수가 없을 때 쓰는 기본값 (OpenFreeMap, 무료·키 없음)
const DEFAULT_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

// 초기 화면: 서울시청. MapLibre 좌표 순서는 [경도, 위도]
const INITIAL_CENTER: [number, number] = [126.978, 37.5665];
const INITIAL_ZOOM = 12;

// 소수점 6자리 ≈ 약 0.1m 정밀도. 클릭 좌표 표시에는 충분하다.
const COORD_DECIMALS = 6;

type LngLat = { lng: number; lat: number };

export default function MapView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [clicked, setClicked] = useState<LngLat | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: import.meta.env.VITE_MAP_STYLE_URL || DEFAULT_STYLE_URL,
      center: INITIAL_CENTER,
      zoom: INITIAL_ZOOM,
      minZoom: 2,
      maxZoom: 18,
    });

    // 확대/축소 버튼과 축척 표시. 출처 표기(attribution)는 MapLibre가 기본으로 표시한다.
    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

    // 클릭 지점 마커는 하나만 만들고, 클릭할 때마다 위치만 옮긴다.
    const marker = new maplibregl.Marker({ color: '#e5484d' });

    map.on('click', (e) => {
      // wrap(): 지도를 옆으로 계속 넘겨도 경도를 -180~180 범위로 맞춘다.
      const { lng, lat } = e.lngLat.wrap();
      marker.setLngLat([lng, lat]).addTo(map);
      setClicked({ lng, lat });
    });

    // 컴포넌트가 사라질 때 지도 리소스(WebGL, 이벤트, 마커)를 해제한다.
    return () => map.remove();
  }, []);

  return (
    <>
      <div ref={containerRef} className="map-container" />
      <div className="coord-panel">
        {clicked ? (
          <>
            <div>경도 (lng): {clicked.lng.toFixed(COORD_DECIMALS)}</div>
            <div>위도 (lat): {clicked.lat.toFixed(COORD_DECIMALS)}</div>
          </>
        ) : (
          <div>지도를 클릭하면 좌표가 표시됩니다</div>
        )}
      </div>
    </>
  );
}
