import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { createCharacter, type Direction } from '../game/character';
import { tileAt, type TileId } from '../map/grid';
import { addGridLayer, GRID_MIN_ZOOM, showSelectedTile } from '../map/gridLayer';
import { addSampleLayer } from '../map/sampleLayer';
import { addTileLayer } from '../map/tileLayer';

// 환경변수가 없을 때 쓰는 기본값 (OpenFreeMap, 무료·키 없음)
const DEFAULT_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

// 초기 화면: 서울시청. MapLibre 좌표 순서는 [경도, 위도]
const INITIAL_CENTER: [number, number] = [126.978, 37.5665];
// 게임 화면 기준 줌. 줌 21에서 칸 하나가 화면에서 약 67px
const INITIAL_ZOOM = 21;

// 캐릭터 시작 칸: 서울시청 앞
const START_TILE = tileAt(INITIAL_CENTER[0], INITIAL_CENTER[1]);

const DIRECTION_LABEL: Record<Direction, string> = { up: '↑', down: '↓', left: '←', right: '→' };

// 소수점 6자리 ≈ 약 0.1m 정밀도. 클릭 좌표 표시에는 충분하다.
const COORD_DECIMALS = 6;

type Clicked = { lng: number; lat: number; tile: TileId };
type Player = { tile: TileId; facing: Direction };

export default function MapView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [clicked, setClicked] = useState<Clicked | null>(null);
  const [zoom, setZoom] = useState(INITIAL_ZOOM);
  const [player, setPlayer] = useState<Player | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: import.meta.env.VITE_MAP_STYLE_URL || DEFAULT_STYLE_URL,
      center: INITIAL_CENTER,
      zoom: INITIAL_ZOOM,
      minZoom: 2,
      maxZoom: 22, // 칸(약 2m)을 크게 보려면 깊게 확대해야 한다. 줌 22에서 칸 하나가 화면에서 약 134px
      // 포켓몬식 탑다운 화면: 회전과 기울기를 막아 북쪽이 항상 위, 격자가 항상 반듯하게 보이게 한다.
      maxPitch: 0,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      // 방향키는 캐릭터 이동(G2)에 쓸 예정이라 지도의 키보드 이동을 끈다.
      keyboard: false,
    });
    map.touchZoomRotate.disableRotation();

    // 회전이 없으므로 나침반 버튼은 숨긴다.
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

    // 기본 지도 스타일 로딩이 끝나야 그 위에 우리 데이터 레이어를 추가할 수 있다.
    let destroyCharacter: (() => void) | undefined;
    let tilesVisible = true;
    let setTilesVisible: ((visible: boolean) => void) | undefined;

    // M 키: 게임 타일 화면 ↔ 원래 지도 화면 (비교/디버깅용)
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'KeyM' || !setTilesVisible) return;
      tilesVisible = !tilesVisible;
      setTilesVisible(tilesVisible);
    };
    window.addEventListener('keydown', onKeyDown);

    map.on('load', () => {
      addSampleLayer(map);
      addGridLayer(map);
      setTilesVisible = addTileLayer(map);
      destroyCharacter = createCharacter(map, {
        start: START_TILE,
        onChange: (tile, facing) => setPlayer({ tile, facing }),
      });
    });

    map.on('zoomend', () => setZoom(map.getZoom()));

    // 클릭 지점 마커는 하나만 만들고, 클릭할 때마다 위치만 옮긴다.
    const marker = new maplibregl.Marker({ color: '#e5484d' });

    map.on('click', (e) => {
      // wrap(): 지도를 옆으로 계속 넘겨도 경도를 -180~180 범위로 맞춘다.
      const { lng, lat } = e.lngLat.wrap();
      const tile = tileAt(lng, lat);
      marker.setLngLat([lng, lat]).addTo(map);
      showSelectedTile(map, tile);
      setClicked({ lng, lat, tile });
    });

    // 컴포넌트가 사라질 때 캐릭터(키보드 이벤트, 애니메이션)와 지도 리소스를 해제한다.
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      destroyCharacter?.();
      map.remove();
    };
  }, []);

  return (
    <>
      <div ref={containerRef} className="map-container" />
      <div className="coord-panel">
        {player && (
          <div>
            캐릭터 칸: {player.tile.x}, {player.tile.y} {DIRECTION_LABEL[player.facing]}
          </div>
        )}
        <div>이동: 방향키 또는 WASD</div>
        <div>M: 게임 타일 / 지도 전환</div>
        <hr />
        {clicked ? (
          <>
            <div>경도 (lng): {clicked.lng.toFixed(COORD_DECIMALS)}</div>
            <div>위도 (lat): {clicked.lat.toFixed(COORD_DECIMALS)}</div>
            <div>
              칸 (x, y): {clicked.tile.x}, {clicked.tile.y}
            </div>
          </>
        ) : (
          <div>지도를 클릭하면 좌표가 표시됩니다</div>
        )}
        <div>
          줌: {zoom.toFixed(1)}
          {zoom < GRID_MIN_ZOOM && ` (격자는 ${GRID_MIN_ZOOM} 이상에서 표시)`}
        </div>
      </div>
    </>
  );
}
