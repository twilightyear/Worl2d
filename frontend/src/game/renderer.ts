import type { Map as MapLibreMap } from 'maplibre-gl';
import { TILE_SIZE, toMercator, type TileId } from '../map/grid';
import { GRID_MIN_ZOOM } from '../map/gridLayer';
import { TileClass } from '../map/tileClass';
import type { TileStore } from '../map/tileStore';
import { createSprites, SPRITE_PX, variantOf } from './sprites';

const EARTH_CIRCUMFERENCE = 2 * Math.PI * 6378137;
const WORLD_PX = 512; // MapLibre의 줌 0 세계 크기(px)

// ---- 가짜 3D 건물 설정 --------------------------------------------------------
/** 가상 카메라 높이(메르카토르 m). 낮을수록 건물이 화면 바깥쪽으로 많이 기울어 보인다. */
const CAMERA_HEIGHT = 250;
/** 건물 높이 상한 = 카메라 높이 × 이 비율 (아주 높은 건물이 화면 밖으로 지나치게 뻗지 않게) */
const MAX_HEIGHT_RATIO = 0.6;
/** 높이 값이 없거나 아주 낮은 건물의 최소 높이(m) */
const MIN_BUILDING_M = 3;
/** 벽 그림 한 장(창문 한 줄)이 나타내는 실제 높이(m) */
const WALL_ROW_M = 4;
/** 칸이 화면에서 이보다 작으면(px) 벽을 그림 대신 단색으로 그린다 (성능) */
const TEXTURE_MIN_TILE_PX = 24;
/** 벽 면을 화면에서 몇 px마다 한 조각으로 나눠 그릴지 */
const STRIP_PX = 2;

const OUTLINE = '#5e2a20';
const WALL_FLAT = '#e6dcc8';
/** 면 방향별 그늘 (빛이 남쪽 위에서 온다고 가정) */
const SHADE = { south: 0, east: 0.12, west: 0.12, north: 0.25 } as const;

type Face = keyof typeof SHADE;

export type TileRenderer = {
  setVisible(visible: boolean): void;
  setSelected(tile: TileId | null): void;
  destroy(): void;
};

/** 16x16 그림을 대각선 기준으로 뒤집는다(가로줄 ↔ 세로줄). 동·서쪽 벽에 쓴다. */
function transpose(src: HTMLCanvasElement): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = src.height;
  out.height = src.width;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context를 만들 수 없습니다');
  ctx.setTransform(0, 1, 1, 0, 0, 0);
  ctx.drawImage(src, 0, 0);
  return out;
}

/**
 * 지도 위에 게임 화면 캔버스를 올리고, 보이는 칸을 도트 타일로 그린다.
 * 건물은 높이를 가진 상자로 보고, 캐릭터(화면 중심) 위의 가상 카메라에서 본 원근으로 그린다.
 * (지도는 회전·기울기가 없으므로 바닥은 단순한 확대·이동으로 그린다)
 */
export function createTileRenderer(map: MapLibreMap, store: TileStore): TileRenderer {
  const sprites = createSprites();
  const transposed = new Map<HTMLCanvasElement, HTMLCanvasElement>();
  const wallTransposed = (img: HTMLCanvasElement) => {
    let t = transposed.get(img);
    if (!t) {
      t = transpose(img);
      transposed.set(img, t);
    }
    return t;
  };

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

    const W = canvas.width;
    const H = canvas.height;
    const dpr = W / map.getContainer().clientWidth;
    const k = ((WORLD_PX * 2 ** map.getZoom()) / EARTH_CIRCUMFERENCE) * dpr; // 메르카토르 m → 캔버스 px
    const c = map.getCenter();
    const [cmx, cmy] = toMercator(c.lng, c.lat);
    const realPerMerc = Math.cos((c.lat * Math.PI) / 180); // 메르카토르 1m = 실제 몇 m
    const tilePx = TILE_SIZE * k;
    const textured = tilePx >= TEXTURE_MIN_TILE_PX;

    // 높이 h(메르카토르 m)에 있는 점의 화면 좌표. 높을수록 화면 중심에서 바깥으로 밀린다(원근).
    const scale = (h: number) => CAMERA_HEIGHT / (CAMERA_HEIGHT - h);
    const PX = (mx: number, h = 0) => W / 2 + (mx - cmx) * k * scale(h);
    const PY = (my: number, h = 0) => H / 2 - (my - cmy) * k * scale(h);

    // 건물 높이(메르카토르 m). 건물이 아니면 0
    const heightAt = (x: number, y: number) => {
      if (store.get(x, y) !== TileClass.Building) return 0;
      const real = Math.max(MIN_BUILDING_M, store.height(x, y));
      return Math.min(real / realPerMerc, CAMERA_HEIGHT * MAX_HEIGHT_RATIO);
    };

    // 화면에 보이는 칸 범위 (건물은 화면 바깥쪽으로만 기울므로 바닥 범위만 보면 된다)
    const halfW = W / 2 / k;
    const halfH = H / 2 / k;
    const x0 = Math.floor((cmx - halfW) / TILE_SIZE);
    const x1 = Math.floor((cmx + halfW) / TILE_SIZE);
    const y0 = Math.floor((cmy - halfH) / TILE_SIZE);
    const y1 = Math.floor((cmy + halfH) / TILE_SIZE);

    // ---- 1) 바닥 -------------------------------------------------------------
    const buildings: { x: number; y: number; h: number; d: number }[] = [];
    for (let y = y1; y >= y0; y--) {
      const top = Math.round(PY((y + 1) * TILE_SIZE));
      const bottom = Math.round(PY(y * TILE_SIZE));
      for (let x = x0; x <= x1; x++) {
        const cls = store.get(x, y);
        if (cls === undefined) continue; // 아직 계산 전: 원래 지도가 보인다
        const left = Math.round(PX(x * TILE_SIZE));
        const right = Math.round(PX((x + 1) * TILE_SIZE));
        // 건물 칸의 바닥은 땅으로 깔아 두고, 건물은 2)에서 위에 세운다.
        const groundCls = cls === TileClass.Building ? TileClass.Ground : cls;
        ctx.drawImage(sprites.tiles[groundCls][variantOf(x, y)], left, top, right - left, bottom - top);
        if (cls === TileClass.Building) {
          const dx = (x + 0.5) * TILE_SIZE - cmx;
          const dy = (y + 0.5) * TILE_SIZE - cmy;
          buildings.push({ x, y, h: heightAt(x, y), d: dx * dx + dy * dy });
        }
      }
    }

    if (selected) {
      const left = PX(selected.x * TILE_SIZE);
      const top = PY((selected.y + 1) * TILE_SIZE);
      ctx.fillStyle = 'rgba(250, 204, 21, 0.5)';
      ctx.fillRect(left, top, PX((selected.x + 1) * TILE_SIZE) - left, PY(selected.y * TILE_SIZE) - top);
    }

    // ---- 2) 건물 (먼 것부터 그려서 가까운 건물이 앞을 가리게) ------------------
    buildings.sort((a, b) => b.d - a.d);

    // 벽의 높이 t 지점에 해당하는 벽 그림과 그 안의 줄(0 = 그림 맨 윗줄).
    // 창문 줄은 건물 꼭대기에서부터 맞춘다 (처마가 항상 맨 위에 오도록).
    const wallRowAt = (t: number, a: number, b: number) => {
      const fromTop = (b - t) * realPerMerc; // 꼭대기에서 내려온 실제 거리(m)
      const row = Math.floor(fromTop / WALL_ROW_M);
      const lastRow = Math.floor(((b - a) * realPerMerc - 1e-6) / WALL_ROW_M);
      const frac = fromTop / WALL_ROW_M - row;
      const img = sprites.wall(row === 0, a === 0 && row === lastRow);
      return { img, srcRow: Math.min(SPRITE_PX - 1, Math.floor(frac * SPRITE_PX)) };
    };

    const shadeQuad = (face: Face, pts: [number, number][]) => {
      if (!SHADE[face]) return;
      ctx.beginPath();
      pts.forEach(([px, py], i) => (i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)));
      ctx.closePath();
      ctx.fillStyle = `rgba(0,0,0,${SHADE[face]})`;
      ctx.fill();
    };

    // 남·북쪽 면: 동서로 뻗은 모서리(y = ye, x = xa..xb)를 높이 a..b까지 세운다.
    const faceNS = (face: Face, ye: number, xa: number, xb: number, a: number, b: number) => {
      const quad: [number, number][] = [
        [PX(xa, a), PY(ye, a)],
        [PX(xb, a), PY(ye, a)],
        [PX(xb, b), PY(ye, b)],
        [PX(xa, b), PY(ye, b)],
      ];
      if (!textured) {
        ctx.fillStyle = WALL_FLAT;
        shadeQuadFill(quad);
      } else {
        const n = Math.min(256, Math.max(1, Math.ceil(Math.abs(PY(ye, b) - PY(ye, a)) / STRIP_PX)));
        for (let i = 0; i < n; i++) {
          const t0 = a + ((b - a) * i) / n;
          const t1 = a + ((b - a) * (i + 1)) / n;
          const tm = (t0 + t1) / 2;
          const { img, srcRow } = wallRowAt(tm, a, b);
          const ya = PY(ye, t0);
          const yb = PY(ye, t1);
          const left = PX(xa, tm);
          ctx.drawImage(img, 0, srcRow, SPRITE_PX, 1, left, Math.min(ya, yb), PX(xb, tm) - left, Math.abs(yb - ya) + 0.5);
        }
      }
      shadeQuad(face, quad);
    };

    // 동·서쪽 면: 남북으로 뻗은 모서리(x = xe, y = ya..yb)를 높이 a..b까지 세운다.
    const faceEW = (face: Face, xe: number, ya: number, yb: number, a: number, b: number) => {
      const quad: [number, number][] = [
        [PX(xe, a), PY(ya, a)],
        [PX(xe, a), PY(yb, a)],
        [PX(xe, b), PY(yb, b)],
        [PX(xe, b), PY(ya, b)],
      ];
      if (!textured) {
        ctx.fillStyle = WALL_FLAT;
        shadeQuadFill(quad);
      } else {
        const n = Math.min(256, Math.max(1, Math.ceil(Math.abs(PX(xe, b) - PX(xe, a)) / STRIP_PX)));
        for (let i = 0; i < n; i++) {
          const t0 = a + ((b - a) * i) / n;
          const t1 = a + ((b - a) * (i + 1)) / n;
          const tm = (t0 + t1) / 2;
          const { img, srcRow } = wallRowAt(tm, a, b);
          const xa = PX(xe, t0);
          const xb = PX(xe, t1);
          const top = PY(yb, tm);
          // 뒤집은 그림에서는 원래의 가로줄이 세로줄이 된다.
          ctx.drawImage(wallTransposed(img), srcRow, 0, 1, SPRITE_PX, Math.min(xa, xb), top, Math.abs(xb - xa) + 0.5, PY(ya, tm) - top);
        }
      }
      shadeQuad(face, quad);
    };

    const shadeQuadFill = (pts: [number, number][]) => {
      ctx.beginPath();
      pts.forEach(([px, py], i) => (i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)));
      ctx.closePath();
      ctx.fill();
    };

    for (const { x, y, h } of buildings) {
      const xa = x * TILE_SIZE;
      const xb = (x + 1) * TILE_SIZE;
      const ya = y * TILE_SIZE;
      const yb = (y + 1) * TILE_SIZE;

      // 카메라 쪽을 향한 면 중, 이웃 칸보다 높은 부분만 그린다 (이웃이 같거나 높으면 가려진다).
      const hs = heightAt(x, y - 1);
      if (cmy < ya && hs < h) faceNS('south', ya, xa, xb, hs, h);
      const hn = heightAt(x, y + 1);
      if (cmy > yb && hn < h) faceNS('north', yb, xa, xb, hn, h);
      const hw = heightAt(x - 1, y);
      if (cmx < xa && hw < h) faceEW('west', xa, ya, yb, hw, h);
      const he = heightAt(x + 1, y);
      if (cmx > xb && he < h) faceEW('east', xb, ya, yb, he, h);

      // 지붕(윗면)
      const left = Math.round(PX(xa, h));
      const right = Math.round(PX(xb, h));
      const top = Math.round(PY(yb, h));
      const bottom = Math.round(PY(ya, h));
      ctx.drawImage(sprites.tiles[TileClass.Building][variantOf(x, y)], left, top, right - left, bottom - top);

      // 지붕 외곽선: 이웃이 더 낮은 쪽 (두께 = 도트 1px)
      const t = Math.max(1, Math.round((right - left) / SPRITE_PX));
      ctx.fillStyle = OUTLINE;
      if (hn < h) ctx.fillRect(left, top, right - left, t);
      if (hs < h) ctx.fillRect(left, bottom - t, right - left, t);
      if (hw < h) ctx.fillRect(left, top, t, bottom - top);
      if (he < h) ctx.fillRect(right - t, top, t, bottom - top);
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
