import type { Map as MapLibreMap } from 'maplibre-gl';
import { TILE_SIZE, toMercator, type TileId } from '../map/grid';
import { GRID_MIN_ZOOM } from '../map/gridLayer';
import { TileClass } from '../map/tileClass';
import type { TileStore } from '../map/tileStore';
import { createSprites, SPRITE_PX, variantOf } from './sprites';

const EARTH_CIRCUMFERENCE = 2 * Math.PI * 6378137;
const WORLD_PX = 512; // MapLibre의 줌 0 세계 크기(px)

const OUTLINE = '#5e2a20';

export type TileRenderer = {
  setVisible(visible: boolean): void;
  setSelected(tile: TileId | null): void;
  destroy(): void;
};

/**
 * 지도 위에 게임 화면 캔버스를 올리고, 보이는 칸을 도트 타일로 그린다.
 * MapLibre는 카메라(위치·줌)만 제공하고, 칸 그림은 이 캔버스가 직접 그린다.
 * (지도는 회전·기울기가 없으므로 메르카토르 → 화면 변환이 단순한 확대·이동이다)
 */
export function createTileRenderer(map: MapLibreMap, store: TileStore): TileRenderer {
  const sprites = createSprites();
  const canvas = document.createElement('canvas');
  canvas.className = 'game-canvas';
  // 지도 캔버스 바로 뒤에 넣는다. 마커(캐릭터)는 그보다 뒤에 있어서 게임 화면 위에 보인다.
  map.getCanvas().after(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context를 만들 수 없습니다');

  let visible = true;
  let selected: TileId | null = null;

  const resize = () => {
    const dpr = window.devicePixelRatio || 1;
    const { clientWidth: w, clientHeight: h } = map.getContainer();
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  };

  const draw = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!visible || map.getZoom() < GRID_MIN_ZOOM) return;
    ctx.imageSmoothingEnabled = false; // 도트가 흐려지지 않게

    const dpr = canvas.width / map.getContainer().clientWidth;
    // 메르카토르(m) → 캔버스 픽셀
    const k = ((WORLD_PX * 2 ** map.getZoom()) / EARTH_CIRCUMFERENCE) * dpr;
    const c = map.getCenter();
    const [cmx, cmy] = toMercator(c.lng, c.lat);
    const sx = (mx: number) => Math.round(canvas.width / 2 + (mx - cmx) * k);
    const sy = (my: number) => Math.round(canvas.height / 2 - (my - cmy) * k);

    // 화면에 보이는 칸 범위
    const halfW = canvas.width / 2 / k;
    const halfH = canvas.height / 2 / k;
    const x0 = Math.floor((cmx - halfW) / TILE_SIZE);
    const x1 = Math.floor((cmx + halfW) / TILE_SIZE);
    const y0 = Math.floor((cmy - halfH) / TILE_SIZE);
    const y1 = Math.floor((cmy + halfH) / TILE_SIZE);

    const isBuilding = (x: number, y: number) => store.get(x, y) === TileClass.Building;

    for (let y = y1; y >= y0; y--) {
      const top = sy((y + 1) * TILE_SIZE);
      const bottom = sy(y * TILE_SIZE);
      for (let x = x0; x <= x1; x++) {
        const cls = store.get(x, y);
        if (cls === undefined) continue; // 아직 계산 전: 원래 지도가 보인다
        const left = sx(x * TILE_SIZE);
        const right = sx((x + 1) * TILE_SIZE);
        const w = right - left;
        const h = bottom - top;

        if (cls === TileClass.Building && !isBuilding(x, y - 1)) {
          ctx.drawImage(sprites.wall, left, top, w, h); // 건물의 남쪽 끝은 벽
        } else {
          ctx.drawImage(sprites.tiles[cls][variantOf(x, y)], left, top, w, h);
        }

        // 건물 외곽선: 건물이 아닌 칸과 맞닿은 북·동·서쪽 (두께 = 도트 1px)
        if (cls === TileClass.Building) {
          const t = Math.max(1, Math.round(w / SPRITE_PX));
          ctx.fillStyle = OUTLINE;
          if (!isBuilding(x, y + 1)) ctx.fillRect(left, top, w, t);
          if (!isBuilding(x - 1, y)) ctx.fillRect(left, top, t, h);
          if (!isBuilding(x + 1, y)) ctx.fillRect(right - t, top, t, h);
        }
      }
    }

    if (selected) {
      const left = sx(selected.x * TILE_SIZE);
      const top = sy((selected.y + 1) * TILE_SIZE);
      ctx.fillStyle = 'rgba(250, 204, 21, 0.5)';
      ctx.fillRect(left, top, sx((selected.x + 1) * TILE_SIZE) - left, sy(selected.y * TILE_SIZE) - top);
    }
  };

  resize();
  map.on('resize', resize);
  map.on('render', draw); // 지도가 다시 그려질 때마다(이동·줌 중 매 프레임) 같이 그린다
  map.triggerRepaint();

  return {
    setVisible(next) {
      visible = next;
      map.triggerRepaint();
    },
    setSelected(tile) {
      selected = tile;
      map.triggerRepaint();
    },
    destroy() {
      map.off('resize', resize);
      map.off('render', draw);
      canvas.remove();
    },
  };
}
