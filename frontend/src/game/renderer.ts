import type { Map as MapLibreMap } from 'maplibre-gl';
import { CHUNK_SIZE, TILE_SIZE, toMercator, type TileId } from '../map/grid';
import { GRID_MIN_ZOOM } from '../map/gridLayer';
import { TileClass } from '../map/tileClass';
import type { TileStore } from '../map/tileStore';
import { createSprites, SPRITE_PX, variantOf, type BuildingSprites } from './sprites';

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

// ---- 바닥 캐시 ----------------------------------------------------------------
/** 청크 바닥 그림을 몇 장까지 보관할지 (한 장 = 1024×1024px ≈ 4MB) */
const GROUND_CACHE_MAX = 16;

const WALL_FLAT = '#e6dcc8';
/** 면 방향별 그늘 (빛이 남쪽 위에서 온다고 가정) */
const SHADE = { south: 0, east: 0.12, west: 0.12, north: 0.25 } as const;

type Face = keyof typeof SHADE;
type Pt = [number, number];

export type TileRenderer = {
  setVisible(visible: boolean): void;
  setSelected(tile: TileId | null): void;
  destroy(): void;
};

function newCanvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context를 만들 수 없습니다');
  return { c, ctx };
}

/**
 * 벽 그림을 면 방향에 맞게 돌려 둔다. 모든 방향에서 그림의 0번 줄(처마)이 "건물 꼭대기 쪽"이 되게 한다.
 * - south: 꼭대기가 화면 위쪽 → 그대로
 * - north: 꼭대기가 화면 아래쪽 → 위아래 뒤집기
 * - east : 꼭대기가 화면 왼쪽 → 대각선 뒤집기 (0번 줄이 0번 열로)
 * - west : 꼭대기가 화면 오른쪽 → 대각선 뒤집기 후 좌우 뒤집기
 */
function orient(src: HTMLCanvasElement, face: Face): HTMLCanvasElement {
  const { c, ctx } = newCanvas(SPRITE_PX, SPRITE_PX);
  const S = SPRITE_PX;
  if (face === 'south') ctx.setTransform(1, 0, 0, 1, 0, 0);
  else if (face === 'north') ctx.setTransform(1, 0, 0, -1, 0, S);
  else if (face === 'east') ctx.setTransform(0, 1, 1, 0, 0, 0);
  else ctx.setTransform(0, 1, -1, 0, S, 0);
  ctx.drawImage(src, 0, 0);
  return c;
}

/**
 * 지도 위에 게임 화면 캔버스를 올리고, 보이는 칸을 도트 타일로 그린다.
 * 건물은 높이를 가진 상자로 보고, 캐릭터(화면 중심) 위의 가상 카메라에서 본 원근으로 그린다.
 */
export function createTileRenderer(map: MapLibreMap, store: TileStore): TileRenderer {
  const sprites = createSprites();

  // 방향별로 돌린 벽 그림 캐시
  const oriented = new Map<HTMLCanvasElement, Record<Face, HTMLCanvasElement>>();
  const wallImg = (img: HTMLCanvasElement, face: Face) => {
    let set = oriented.get(img);
    if (!set) {
      set = {
        south: orient(img, 'south'),
        north: orient(img, 'north'),
        east: orient(img, 'east'),
        west: orient(img, 'west'),
      };
      oriented.set(img, set);
    }
    return set[face];
  };

  // 청크 바닥 그림 캐시: 칸마다 매 프레임 그리지 않고, 청크당 한 장을 미리 그려 두고 붙인다.
  // Map은 넣은 순서를 기억하므로, 쓸 때마다 맨 뒤로 옮기고 넘치면 맨 앞(가장 오래 안 쓴 것)을 지운다.
  const groundCache = new Map<number, HTMLCanvasElement>();
  const groundOf = (cx: number, cy: number): HTMLCanvasElement | undefined => {
    const k = cx * 1_000_000 + cy;
    const hit = groundCache.get(k);
    if (hit) {
      groundCache.delete(k);
      groundCache.set(k, hit);
      return hit;
    }
    const data = store.chunk(cx, cy);
    if (!data) return undefined;
    const { c, ctx: g } = newCanvas(CHUNK_SIZE * SPRITE_PX, CHUNK_SIZE * SPRITE_PX);
    for (let row = 0; row < CHUNK_SIZE; row++) {
      const y = cy * CHUNK_SIZE + (CHUNK_SIZE - 1 - row);
      for (let col = 0; col < CHUNK_SIZE; col++) {
        const x = cx * CHUNK_SIZE + col;
        const cls = data.classes[row * CHUNK_SIZE + col] as TileClass;
        // 건물 칸의 바닥은 땅으로 깔아 두고, 건물은 그 위에 세운다.
        const groundCls = cls === TileClass.Building ? TileClass.Ground : cls;
        g.drawImage(sprites.tiles[groundCls][variantOf(x, y)], col * SPRITE_PX, row * SPRITE_PX);
      }
    }
    groundCache.set(k, c);
    if (groundCache.size > GROUND_CACHE_MAX) groundCache.delete(groundCache.keys().next().value!);
    return c;
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
    const textured = TILE_SIZE * k >= TEXTURE_MIN_TILE_PX;
    const wallRowMerc = WALL_ROW_M / realPerMerc;

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

    // ---- 1) 바닥: 청크마다 미리 그려 둔 그림 한 장씩 ---------------------------
    const span = CHUNK_SIZE * TILE_SIZE;
    for (let cy = Math.floor(y0 / CHUNK_SIZE); cy <= Math.floor(y1 / CHUNK_SIZE); cy++) {
      for (let cx = Math.floor(x0 / CHUNK_SIZE); cx <= Math.floor(x1 / CHUNK_SIZE); cx++) {
        const img = groundOf(cx, cy);
        if (!img) continue; // 아직 계산 전
        const left = Math.round(PX(cx * span));
        const top = Math.round(PY((cy + 1) * span));
        ctx.drawImage(img, left, top, Math.round(PX((cx + 1) * span)) - left, Math.round(PY(cy * span)) - top);
      }
    }

    if (selected) {
      const left = PX(selected.x * TILE_SIZE);
      const top = PY((selected.y + 1) * TILE_SIZE);
      ctx.fillStyle = 'rgba(250, 204, 21, 0.5)';
      ctx.fillRect(left, top, PX((selected.x + 1) * TILE_SIZE) - left, PY(selected.y * TILE_SIZE) - top);
    }

    // ---- 2) 건물 (먼 것부터 그려서 가까운 건물이 앞을 가리게) ------------------
    const buildings: { x: number; y: number; h: number; d: number; color: number }[] = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const h = heightAt(x, y);
        if (h === 0) continue;
        const dx = (x + 0.5) * TILE_SIZE - cmx;
        const dy = (y + 0.5) * TILE_SIZE - cmy;
        // 비슷한 색은 같은 그림을 쓰도록 색을 16단계로 묶는다 (그림 캐시가 너무 커지지 않게)
        const color = (store.color(x, y) & 0xf0f0f0) | 0x080808;
        buildings.push({ x, y, h, d: dx * dx + dy * dy, color });
      }
    }
    buildings.sort((a, b) => b.d - a.d);

    const fillQuad = (pts: Pt[], style: string) => {
      ctx.beginPath();
      pts.forEach(([px, py], i) => (i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)));
      ctx.closePath();
      ctx.fillStyle = style;
      ctx.fill();
    };

    /**
     * 옆면 하나를 그린다. 모서리(e0 → e1, 바닥 높이 a)에서 꼭대기 높이 b까지.
     * 창문 줄은 꼭대기에서부터 WALL_ROW_M마다 한 장씩 붙이고, 맨 아래 줄은 남는 만큼만 잘라 쓴다.
     */
    const face = (bs: BuildingSprites, f: Face, e0: [number, number], e1: [number, number], a: number, b: number) => {
      const P = ([mx, my]: [number, number], h: number): Pt => [PX(mx, h), PY(my, h)];
      const quad = [P(e0, a), P(e1, a), P(e1, b), P(e0, b)];
      if (!textured) {
        fillQuad(quad, WALL_FLAT);
      } else {
        const rows = Math.ceil((b - a) / wallRowMerc - 1e-6);
        for (let i = 0; i < rows; i++) {
          const tTop = b - i * wallRowMerc;
          const tBottom = Math.max(a, tTop - wallRowMerc);
          const part = (tTop - tBottom) / wallRowMerc; // 이 줄에서 쓰는 비율 (맨 아래 줄만 1보다 작을 수 있음)
          const src = wallImg(bs.wall(i === 0, a === 0 && i === rows - 1), f);
          const used = Math.max(1, Math.round(part * SPRITE_PX));
          const tMid = (tTop + tBottom) / 2;
          // 띠의 네 모서리 중 가운데 높이 기준으로 사각형을 잡는다 (원근에 의한 미세한 사다리꼴은 무시)
          const [ax, ay] = P(e0, tMid);
          const [bx, by] = P(e1, tMid);
          if (f === 'south' || f === 'north') {
            const yt = PY(e0[1], tTop);
            const yb = PY(e0[1], tBottom);
            const sy = f === 'south' ? 0 : SPRITE_PX - used;
            ctx.drawImage(src, 0, sy, SPRITE_PX, used, Math.min(ax, bx), Math.min(yt, yb), Math.abs(bx - ax), Math.abs(yb - yt) + 0.5);
          } else {
            const xt = PX(e0[0], tTop);
            const xb = PX(e0[0], tBottom);
            const sx = f === 'east' ? 0 : SPRITE_PX - used;
            ctx.drawImage(src, sx, 0, used, SPRITE_PX, Math.min(xt, xb), Math.min(ay, by), Math.abs(xb - xt) + 0.5, Math.abs(by - ay));
          }
        }
      }
      if (SHADE[f]) fillQuad(quad, `rgba(0,0,0,${SHADE[f]})`);
    };

    for (const { x, y, h, color } of buildings) {
      const bs = sprites.building(color);
      const xa = x * TILE_SIZE;
      const xb = (x + 1) * TILE_SIZE;
      const ya = y * TILE_SIZE;
      const yb = (y + 1) * TILE_SIZE;

      // 카메라 쪽을 향한 면 중, 이웃 칸보다 높은 부분만 그린다 (이웃이 같거나 높으면 가려진다).
      const hs = heightAt(x, y - 1);
      const hn = heightAt(x, y + 1);
      const hw = heightAt(x - 1, y);
      const he = heightAt(x + 1, y);
      if (cmy < ya && hs < h) face(bs, 'south', [xa, ya], [xb, ya], hs, h);
      if (cmy > yb && hn < h) face(bs, 'north', [xa, yb], [xb, yb], hn, h);
      if (cmx < xa && hw < h) face(bs, 'west', [xa, ya], [xa, yb], hw, h);
      if (cmx > xb && he < h) face(bs, 'east', [xb, ya], [xb, yb], he, h);

      // 지붕(윗면)
      const left = Math.round(PX(xa, h));
      const right = Math.round(PX(xb, h));
      const top = Math.round(PY(yb, h));
      const bottom = Math.round(PY(ya, h));
      ctx.drawImage(bs.roofs[variantOf(x, y)], left, top, right - left, bottom - top);

      // 지붕 외곽선: 이웃이 더 낮은 쪽 (두께 = 도트 1px)
      const t = Math.max(1, Math.round((right - left) / SPRITE_PX));
      ctx.fillStyle = bs.outline;
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
