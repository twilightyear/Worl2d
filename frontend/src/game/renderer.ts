import type { Map as MapLibreMap } from 'maplibre-gl';
import { CHUNK_SIZE, TILE_SIZE, toMercator, type TileId } from '../map/grid';
import { GRID_MIN_ZOOM } from '../map/gridLayer';
import { TileClass } from '../map/tileClass';
import type { TileStore } from '../map/tileStore';
import type { CharacterState } from './character';
import { createSprites, SPRITE_PX, variantOf, type BuildingSprites } from './sprites';
import { connects, loadTileset, type Tileset } from './tileset';

const EARTH_CIRCUMFERENCE = 2 * Math.PI * 6378137;
const WORLD_PX = 512; // MapLibre의 줌 0 세계 크기(px)

// ---- 카메라: 남쪽에서 비스듬히 내려다보는 시점 ---------------------------------
/** 높이 1m가 화면에서 위로 몇 m만큼 솟아 보이는지. 클수록 카메라가 남쪽으로 누운 느낌 */
const TILT = 0.5;
/**
 * 가상 카메라 높이(메르카토르 m). 낮을수록 원근이 강해져서, 캐릭터가 움직일 때
 * 건물이 기우는 방향과 보이는 면(남·북·동·서)이 크게 달라진다.
 */
const CAMERA_HEIGHT = 200;

// ---- 건물 높이 압축 (그대로 그리면 고층 건물 벽이 화면을 덮는다) -----------------
/** 높이 값이 없거나 아주 낮은 건물의 최소 높이(m) */
const MIN_BUILDING_M = 3;
/** 이 높이(m)까지는 그대로, 넘는 부분은 HEIGHT_SCALE 비율로 줄여서 그린다 */
const HEIGHT_KEEP_M = 4;
const HEIGHT_SCALE = 0.35;
/** 그리는 높이 상한(m) */
const MAX_RENDER_M = 30;
/** 벽 그림 한 장(창문 한 줄)이 나타내는 높이(m, 압축된 높이 기준) */
const WALL_ROW_M = 3;
// ---- 그림자 -------------------------------------------------------------------
/** 그림자 길이 = 그리는 높이 × 이 비율 (남동쪽으로) */
const SHADOW_RATIO = 0.6;
/** 그림자 최대 길이(칸) */
const SHADOW_MAX_TILES = 4;
/** 그림자 진하기 */
const SHADOW_ALPHA = 0.22;

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
  /** 캐릭터 상태를 알려 주는 함수. 건물과 앞뒤 순서를 맞춰 그린다. */
  setActor(get: () => CharacterState): void;
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

  // 타일셋(Ninja Adventure)은 비동기로 불러온다. 불러오기 전에는 코드로 만든 그림을 쓴다.
  let tileset: Tileset | null = null;
  loadTileset()
    .then((t) => {
      tileset = t;
      groundCache.clear(); // 새 그림으로 바닥을 다시 그리게
      map.triggerRepaint();
    })
    .catch((err) => console.error(err));

  /** 바닥 칸 그림. 타일셋이 있으면 이웃을 보고 오토타일을 고른다. */
  const groundTile = (x: number, y: number, cls: TileClass): HTMLCanvasElement => {
    if (!tileset) {
      // 건물 칸의 바닥은 땅으로 깔아 두고, 건물은 그 위에 세운다.
      const groundCls = cls === TileClass.Building ? TileClass.Ground : cls;
      return sprites.tiles[groundCls][variantOf(x, y)];
    }
    if (cls === TileClass.Green) return tileset.grass[variantOf(x, y)];
    const n = connects(cls, store.get(x, y + 1));
    const e = connects(cls, store.get(x + 1, y));
    const s = connects(cls, store.get(x, y - 1));
    const w = connects(cls, store.get(x - 1, y));
    if (cls === TileClass.Water) return tileset.water(n, e, s, w);
    if (cls === TileClass.Road) return tileset.road(n, e, s, w);
    return tileset.dirt(n, e, s, w); // 땅, 건물 바닥
  };

  // 청크 바닥 그림 캐시: 칸마다 매 프레임 그리지 않고, 청크당 한 장을 미리 그려 두고 붙인다.
  // Map은 넣은 순서를 기억하므로, 쓸 때마다 맨 뒤로 옮기고 넘치면 맨 앞(가장 오래 안 쓴 것)을 지운다.
  // 오토타일은 옆 청크의 칸도 보므로, 옆 청크가 아직 없을 때 만든 그림은 나중에 다시 만든다.
  type GroundEntry = { canvas: HTMLCanvasElement; complete: boolean; version: number; data: unknown };
  const groundCache = new Map<number, GroundEntry>();
  const groundOf = (cx: number, cy: number): HTMLCanvasElement | undefined => {
    const k = cx * 1_000_000 + cy;
    const hit = groundCache.get(k);
    // 청크 데이터가 다시 계산되어 바뀌었으면(임시 → 정식) 그림도 다시 만든다.
    if (hit && hit.data === store.chunk(cx, cy) && (hit.complete || hit.version === store.version())) {
      groundCache.delete(k);
      groundCache.set(k, hit);
      return hit.canvas;
    }
    const data = store.chunk(cx, cy);
    if (!data) return undefined;
    const { c, ctx: g } = newCanvas(CHUNK_SIZE * SPRITE_PX, CHUNK_SIZE * SPRITE_PX);
    for (let row = 0; row < CHUNK_SIZE; row++) {
      const y = cy * CHUNK_SIZE + (CHUNK_SIZE - 1 - row);
      for (let col = 0; col < CHUNK_SIZE; col++) {
        const x = cx * CHUNK_SIZE + col;
        const cls = data.classes[row * CHUNK_SIZE + col] as TileClass;
        g.drawImage(groundTile(x, y, cls), col * SPRITE_PX, row * SPRITE_PX);
      }
    }
    const complete = [
      [cx, cy + 1],
      [cx + 1, cy],
      [cx, cy - 1],
      [cx - 1, cy],
    ].every(([nx, ny]) => store.chunk(nx, ny) !== undefined);
    groundCache.delete(k);
    groundCache.set(k, { canvas: c, complete, version: store.version(), data });
    if (groundCache.size > GROUND_CACHE_MAX) groundCache.delete(groundCache.keys().next().value!);
    return c;
  };

  const canvas = document.createElement('canvas');
  canvas.className = 'game-canvas';
  // 지도 캔버스 바로 뒤에 넣는다. 마커(캐릭터)는 그보다 뒤에 있어서 게임 화면 위에 보인다.
  map.getCanvas().after(canvas);
  const screenCtx = canvas.getContext('2d');
  if (!screenCtx) throw new Error('canvas 2d context를 만들 수 없습니다');

  // 도트 해상도(칸당 16px)로 먼저 그리는 캔버스. 다 그린 뒤 정수 배율로 키워 화면에 붙인다.
  // 그러면 바닥·벽·캐릭터의 도트 크기가 모두 같아져서 진짜 도트 그림처럼 보인다.
  const lowCanvas = document.createElement('canvas');
  const ctx = lowCanvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context를 만들 수 없습니다');
  // 그림자를 한 번에 반투명하게 얹기 위한 캔버스 (겹친 그림자가 더 진해지지 않게)
  const shadowCanvas = document.createElement('canvas');
  const shadowCtx = shadowCanvas.getContext('2d');
  if (!shadowCtx) throw new Error('canvas 2d context를 만들 수 없습니다');

  let visible = true;
  let selected: TileId | null = null;
  let getActor: (() => CharacterState) | null = null;

  const resize = () => {
    const dpr = window.devicePixelRatio || 1;
    const { clientWidth: w, clientHeight: h } = map.getContainer();
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  };

  /** 화면 px 기준, 메르카토르 1m가 몇 px인지 */
  const screenScale = (zoom: number) =>
    ((WORLD_PX * 2 ** zoom) / EARTH_CIRCUMFERENCE) * (canvas.width / map.getContainer().clientWidth);

  const draw = () => {
    screenCtx.clearRect(0, 0, canvas.width, canvas.height);
    if (!visible || map.getZoom() < GRID_MIN_ZOOM) return;

    // 도트 1px = 화면 S px (정수). 줌이 딱 맞지 않을 때(확대·축소 중)는 가장 가까운 정수로.
    const kScreen = screenScale(map.getZoom());
    const S = Math.max(1, Math.round((TILE_SIZE * kScreen) / SPRITE_PX));
    const k = kScreen / S; // 도트 해상도 기준, 메르카토르 1m = k px (칸 하나 ≈ 16px)

    const W = Math.ceil(canvas.width / S) + 2;
    const H = Math.ceil(canvas.height / S) + 2;
    if (lowCanvas.width !== W || lowCanvas.height !== H) {
      lowCanvas.width = W;
      lowCanvas.height = H;
      shadowCanvas.width = W;
      shadowCanvas.height = H;
    }
    ctx.clearRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = false; // 도트가 흐려지지 않게
    const OX = Math.floor(W / 2);
    const OY = Math.floor(H / 2);

    // 카메라를 도트 격자에 맞춘다. 남는 소수 부분(fx, fy)은 화면에 붙일 때 화면 px 단위로 옮긴다.
    // (그래야 걸을 때 도트가 흔들리지 않으면서도 화면은 부드럽게 움직인다)
    const c = map.getCenter();
    const [trueX, trueY] = toMercator(c.lng, c.lat);
    const ix = Math.floor(trueX * k);
    const iy = Math.floor(trueY * k);
    const fx = trueX * k - ix;
    const fy = trueY * k - iy;
    const cmx = ix / k;
    const cmy = iy / k;
    const realPerMerc = Math.cos((c.lat * Math.PI) / 180); // 메르카토르 1m = 실제 몇 m
    const textured = true;
    const wallRowMerc = WALL_ROW_M / realPerMerc;

    // 높이 h(메르카토르 m)에 있는 점의 화면 좌표.
    // 높을수록 화면 위로 솟고(비스듬한 시점), 아주 약하게 화면 중심에서 바깥으로 밀린다(원근).
    // 바닥(h = 0)은 MapLibre 지도와 정확히 같은 위치다. (클릭·충돌·격자가 그대로 맞는다)
    const scale = (h: number) => CAMERA_HEIGHT / (CAMERA_HEIGHT - h);
    const PX = (mx: number, h = 0) => OX + (mx - cmx) * k * scale(h);
    const PY = (my: number, h = 0) => OY - (my - cmy) * k * scale(h) - h * TILT * k;

    // 그릴 건물 높이(메르카토르 m). 건물이 아니면 0
    const heightAt = (x: number, y: number) => {
      if (store.get(x, y) !== TileClass.Building) return 0;
      const real = Math.max(MIN_BUILDING_M, store.height(x, y));
      const shown = real <= HEIGHT_KEEP_M ? real : HEIGHT_KEEP_M + (real - HEIGHT_KEEP_M) * HEIGHT_SCALE;
      return Math.min(shown, MAX_RENDER_M) / realPerMerc;
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

    // ---- 2) 건물과 캐릭터 (북쪽=뒤쪽부터 그려서 남쪽=앞쪽이 가리게) ---------------
    // 화면 아래(남쪽) 바깥에 있는 건물도 위로 솟아 화면에 들어올 수 있으므로 남쪽으로 여유를 둔다.
    const southMargin = Math.ceil(((MAX_RENDER_M / realPerMerc) * TILT) / TILE_SIZE) + 1;
    // 그리는 순서: 가상 카메라가 있는 바닥 지점에서 먼 것부터.
    // 카메라는 화면 중심 위에서 남쪽으로 기울어 있으므로, 그 바닥 지점은 중심보다 남쪽이다.
    const eyeX = cmx;
    const eyeY = cmy - CAMERA_HEIGHT * TILT;
    const dist2 = (mx: number, my: number) => (mx - eyeX) ** 2 + (my - eyeY) ** 2;
    type Item = { kind: 'building'; x: number; y: number; h: number; color: number; d: number };
    type ActorItem = { kind: 'actor'; d: number };
    const items: (Item | ActorItem)[] = [];
    for (let y = y0 - southMargin; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const h = heightAt(x, y);
        if (h === 0) continue;
        // 비슷한 색은 같은 그림을 쓰도록 색을 16단계로 묶는다 (그림 캐시가 너무 커지지 않게)
        const color = (store.color(x, y) & 0xf0f0f0) | 0x080808;
        items.push({ kind: 'building', x, y, h, color, d: dist2((x + 0.5) * TILE_SIZE, (y + 0.5) * TILE_SIZE) });
      }
    }
    const actor = getActor?.();
    if (actor) {
      items.push({ kind: 'actor', d: dist2(actor.pos[0], actor.pos[1]) });
    }
    items.sort((a, b) => b.d - a.d);

    // ---- 그림자: 건물이 남동쪽으로 드리운다 --------------------------------------
    // 따로 칠한 뒤 한 번에 반투명하게 얹어서, 그림자끼리 겹쳐도 더 진해지지 않게 한다.
    shadowCtx.clearRect(0, 0, W, H);
    shadowCtx.fillStyle = '#000';
    for (const it of items) {
      if (it.kind !== 'building') continue;
      const len = Math.min(it.h * SHADOW_RATIO, SHADOW_MAX_TILES * TILE_SIZE);
      const xa = it.x * TILE_SIZE;
      const ya = it.y * TILE_SIZE;
      // 그림자는 칸을 남동쪽으로 끌어 늘인 모양. 칸 반 크기 간격으로 찍어서 이어 붙인다.
      for (let s = TILE_SIZE / 2; s <= len + 1e-6; s += TILE_SIZE / 2) {
        const left = Math.round(PX(xa + s));
        const top = Math.round(PY(ya + TILE_SIZE - s));
        shadowCtx.fillRect(left, top, Math.round(PX(xa + s + TILE_SIZE)) - left, Math.round(PY(ya - s)) - top);
      }
    }
    ctx.globalAlpha = SHADOW_ALPHA;
    ctx.drawImage(shadowCanvas, 0, 0);
    ctx.globalAlpha = 1;

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

    const tilePx = TILE_SIZE * k;
    const drawActor = () => {
      if (!actor) return;
      const fx = PX(actor.pos[0]);
      const fy = PY(actor.pos[1]);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath();
      ctx.ellipse(fx, fy + tilePx * 0.3, tilePx * 0.32, tilePx * 0.12, 0, 0, Math.PI * 2);
      ctx.fill();
      if (tileset) {
        // 캐릭터 시트: 열 = 방향(아래·위·왼쪽·오른쪽), 행 = 걷기 프레임(0~3). 멈춰 있으면 0행
        const col = { down: 0, up: 1, left: 2, right: 3 }[actor.facing];
        const row = actor.moving ? Math.floor(performance.now() / 125) % 4 : 0;
        const size = Math.round(tilePx);
        // 발이 칸 중심보다 약간 아래(남쪽)에 오도록 그린다
        ctx.drawImage(tileset.character, col * 16, row * 16, 16, 16, Math.round(fx - size / 2), Math.round(fy + tilePx * 0.4 - size), size, size);
        return;
      }
      // 타일셋을 불러오기 전 임시 그림: 몸
      const cy = fy - tilePx * 0.3;
      const r = tilePx * 0.38;
      ctx.fillStyle = '#ef4444';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(1, tilePx * 0.06);
      ctx.beginPath();
      ctx.arc(fx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      const d = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[actor.facing];
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(fx + d[0] * r * 0.5, cy + d[1] * r * 0.5, r * 0.28, 0, Math.PI * 2);
      ctx.fill();
    };

    for (const item of items) {
      if (item.kind === 'actor') {
        drawActor();
        continue;
      }
      const { x, y, h, color } = item;
      const bs = sprites.building(color);
      const xa = x * TILE_SIZE;
      const xb = (x + 1) * TILE_SIZE;
      const ya = y * TILE_SIZE;
      const yb = (y + 1) * TILE_SIZE;

      // 이웃 칸보다 높은 부분만 옆면을 그린다 (이웃이 같거나 높으면 가려진다).
      // 보이는 면은 실제 투영으로 판단한다: 윗면이 바닥보다 화면에서 어느 쪽으로 밀렸는지에 따라,
      // 그 반대쪽 면이 드러난다. 캐릭터 위치에 따라 남·북·동·서 어느 면이든 보일 수 있다.
      const hs = heightAt(x, y - 1);
      const hn = heightAt(x, y + 1);
      const hw = heightAt(x - 1, y);
      const he = heightAt(x + 1, y);
      if (hw < h && PX(xa, h) > PX(xa)) face(bs, 'west', [xa, ya], [xa, yb], hw, h);
      if (he < h && PX(xb, h) < PX(xb)) face(bs, 'east', [xb, ya], [xb, yb], he, h);
      if (hn < h && PY(yb, h) > PY(yb)) face(bs, 'north', [xa, yb], [xb, yb], hn, h);
      if (hs < h && PY(ya, h) < PY(ya)) face(bs, 'south', [xa, ya], [xb, ya], hs, h);

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

    // ---- 도트 해상도 그림을 정수 배율로 키워 화면에 붙인다 -----------------------
    // 도트 좌표 (OX, OY - …)가 격자에 맞춘 카메라이고, 실제 카메라는 거기서 (fx, fy)만큼 떨어져 있다.
    screenCtx.imageSmoothingEnabled = false;
    screenCtx.drawImage(
      lowCanvas,
      Math.round(canvas.width / 2 - (OX + fx) * S),
      Math.round(canvas.height / 2 - (OY - fy) * S),
      W * S,
      H * S,
    );
  };

  /**
   * 확대·축소가 끝나면, 칸 하나가 화면에서 16px의 정수배가 되는 줌으로 살짝 맞춘다.
   * (줌이 애매하면 도트 1px이 화면 몇 px과 딱 맞지 않아 크기가 들쭉날쭉해진다)
   */
  const snapZoom = () => {
    const zoom = map.getZoom();
    if (zoom < GRID_MIN_ZOOM) return;
    const tilePx = TILE_SIZE * screenScale(zoom);
    let n = Math.max(1, Math.round(tilePx / SPRITE_PX));
    // 칸 크기가 16n px이 되는 줌: tilePx는 2^zoom에 비례한다
    const zoomFor = (m: number) => zoom + Math.log2((m * SPRITE_PX) / tilePx);
    if (zoomFor(n) > map.getMaxZoom()) n -= 1;
    if (zoomFor(n) < GRID_MIN_ZOOM) n += 1;
    const target = zoomFor(n);
    if (Math.abs(target - zoom) > 1e-3) map.easeTo({ zoom: target, duration: 120 });
  };

  resize();
  map.on('resize', resize);
  map.on('render', draw); // 지도가 다시 그려질 때마다(이동·줌 중 매 프레임) 같이 그린다
  map.on('zoomend', snapZoom);
  snapZoom();
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
    setActor(get) {
      getActor = get;
      map.triggerRepaint();
    },
    destroy() {
      map.off('resize', resize);
      map.off('render', draw);
      map.off('zoomend', snapZoom);
      canvas.remove();
    },
  };
}
