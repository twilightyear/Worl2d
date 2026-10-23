import { TILE_SIZE } from './grid';

/**
 * 실제 지형 높이(해발 m). AWS Open Data의 Terrain Tiles(Terrarium 형식, 무료·키 없음)를 쓴다.
 * 줌 15 타일(256×256px, 서울에서 1px ≈ 3.8m)을 필요할 때 받아서 칸 중심 높이를 쌍선형 보간으로 구한다.
 * 출처 표기: README 참고 (Mapzen Terrain Tiles, SRTM 등)
 */
const DEM_ZOOM = 15;
const DEM_URL = (x: number, y: number) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${DEM_ZOOM}/${x}/${y}.png`;
const HALF_WORLD = Math.PI * 6378137; // 메르카토르 세계 절반 크기(m)
const N = 2 ** DEM_ZOOM;
/** 메모리에 둘 DEM 타일 수 (한 장 = 256KB) */
const CACHE_MAX = 64;

/** 층 하나의 높이(m). 해발 높이를 이 단위로 끊어서 층으로 만든다 */
export const LEVEL_M = 4;

export type Terrain = {
  /** 칸 중심의 해발 높이(m). 아직 받지 못했으면 undefined */
  elevation(x: number, y: number): number | undefined;
  /** 칸의 층 = floor(해발 / LEVEL_M). 아직 받지 못했으면 undefined */
  level(x: number, y: number): number | undefined;
  /** DEM 타일이 새로 들어올 때마다 1씩 커진다 */
  version(): number;
};

export function createTerrain(onUpdate: () => void): Terrain {
  const tiles = new Map<number, Float32Array | 'loading' | 'error'>();
  let version = 0;

  const load = (tx: number, ty: number, k: number) => {
    tiles.set(k, 'loading');
    fetch(DEM_URL(tx, ty))
      .then((r) => {
        if (!r.ok) throw new Error(`DEM ${r.status}`);
        return r.blob();
      })
      .then((b) => createImageBitmap(b))
      .then((bm) => {
        const c = new OffscreenCanvas(256, 256);
        const g = c.getContext('2d', { willReadFrequently: true });
        if (!g) throw new Error('canvas 2d context를 만들 수 없습니다');
        g.drawImage(bm, 0, 0);
        const d = g.getImageData(0, 0, 256, 256).data;
        const out = new Float32Array(256 * 256);
        // Terrarium: 높이 = (R × 256 + G + B / 256) − 32768
        for (let i = 0; i < out.length; i++) out[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
        tiles.set(k, out);
        if (tiles.size > CACHE_MAX) {
          const oldest = tiles.keys().next().value!;
          if (oldest !== k) tiles.delete(oldest);
        }
        version++;
        onUpdate();
      })
      .catch((err) => {
        console.error(err);
        tiles.set(k, 'error');
      });
  };

  /** 세계 픽셀 좌표(줌 15 기준)의 높이 */
  const sample = (px: number, py: number): number | undefined => {
    const tx = Math.floor(px / 256);
    const ty = Math.floor(py / 256);
    const k = tx * 100_000 + ty;
    const t = tiles.get(k);
    if (t === undefined) {
      load(tx, ty, k);
      return undefined;
    }
    if (typeof t === 'string') return undefined;
    const ix = Math.min(255, Math.max(0, Math.floor(px - tx * 256)));
    const iy = Math.min(255, Math.max(0, Math.floor(py - ty * 256)));
    return t[iy * 256 + ix];
  };

  const elevation = (x: number, y: number) => {
    // 칸 중심(메르카토르 m) → 줌 15 세계 픽셀. 픽셀 중심 기준으로 보간한다
    const mx = (x + 0.5) * TILE_SIZE;
    const my = (y + 0.5) * TILE_SIZE;
    const px = ((mx + HALF_WORLD) / (2 * HALF_WORLD)) * N * 256 - 0.5;
    const py = ((HALF_WORLD - my) / (2 * HALF_WORLD)) * N * 256 - 0.5;
    const x0 = Math.floor(px);
    const y0 = Math.floor(py);
    const fx = px - x0;
    const fy = py - y0;
    const a = sample(x0, y0);
    const b = sample(x0 + 1, y0);
    const c = sample(x0, y0 + 1);
    const d = sample(x0 + 1, y0 + 1);
    if (a === undefined || b === undefined || c === undefined || d === undefined) return undefined;
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };

  return {
    elevation,
    level(x, y) {
      const e = elevation(x, y);
      return e === undefined ? undefined : Math.floor(e / LEVEL_M);
    },
    version: () => version,
  };
}
