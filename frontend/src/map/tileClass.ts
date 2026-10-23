import type { Geometry, Position } from 'geojson';
import type { GeoJSONFeature, Map as MapLibreMap } from 'maplibre-gl';
import { CHUNK_SIZE, chunkBounds, fromMercator, toMercator, type ChunkId } from './grid';

/** 칸 종류. 숫자 값은 계산용 인덱스다. */
export const TileClass = {
  Ground: 0,
  Green: 1,
  Water: 2,
  Road: 3,
  Building: 4,
} as const;
export type TileClass = (typeof TileClass)[keyof typeof TileClass];

/** 칸 종류 이름 (화면 표시용) */
export const TILE_CLASS_LABEL: Record<TileClass, string> = {
  [TileClass.Ground]: '땅',
  [TileClass.Green]: '풀',
  [TileClass.Water]: '물',
  [TileClass.Road]: '도로',
  [TileClass.Building]: '건물',
};

/** 캐릭터가 들어갈 수 있는 칸인지. 건물과 물은 막힌다. */
export function isWalkable(cls: TileClass): boolean {
  return cls !== TileClass.Building && cls !== TileClass.Water;
}

/** T1 임시 색상 (T2에서 도트 타일 그림으로 바꾼다) */
export const TILE_CLASS_COLOR: Record<TileClass, string> = {
  [TileClass.Ground]: '#d9c9a0',
  [TileClass.Green]: '#7cc46a',
  [TileClass.Water]: '#4aa3df',
  [TileClass.Road]: '#a9a9a9',
  [TileClass.Building]: '#c0604b',
};

// OpenMapTiles 스키마의 class 값 → 칸 종류
const GREEN_LANDCOVER = new Set(['grass', 'wood', 'farmland', 'wetland']);
const GREEN_LANDUSE = new Set(['pitch', 'playground', 'cemetery', 'park']);

// 도로 등급별 대략적인 폭(실제 m). 선 데이터를 이 폭으로 굵게 그려서 도로 칸을 정한다.
const ROAD_WIDTH_M: Record<string, number> = {
  motorway: 20,
  trunk: 16,
  primary: 14,
  secondary: 12,
  tertiary: 10,
  minor: 7,
  service: 5,
  track: 3,
  path: 2,
};
const WATERWAY_WIDTH_M = 3;

/** collectFeatures 끝에서 실제 범위로 채운다 */
const NO_BBOX: [number, number, number, number] = [0, 0, 0, 0];

/** 칸 하나를 몇 px로 그려서 판단할지. 칸 중심 픽셀만 읽으므로 경계의 흐림(안티앨리어싱) 영향을 피한다. */
const SAMPLE_SCALE = 4;

/** 칸 중심이 이 비율 이상 덮이면 그 종류로 본다 (알파 0~255 중 128 = 50%) */
const COVER_THRESHOLD = 128;

/** 칸 종류를 그리는 순서. 나중 종류가 우선한다. */
const CLASS_ORDER: TileClass[] = [TileClass.Green, TileClass.Water, TileClass.Road, TileClass.Building];

/** 칸 판단용 도형. bbox = 메르카토르 범위 [minX, minY, maxX, maxY] (선은 폭만큼 넓힘) */
export type Draw = {
  cls: TileClass;
  geometry: Geometry;
  bbox: [number, number, number, number];
  widthM?: number;
  heightM?: number;
  /** 건물 벽 색 0xRRGGBB (지도 데이터에 색이 있을 때만). 없으면 건물마다 대체 색을 고른다. */
  color?: number;
  /** 다리 위 도로. 칸 종류(아래층)에는 넣지 않고, 다리 배열(위층)에만 넣는다. */
  bridge?: boolean;
  /** 계단(OSM highway=steps). 층이 다른 칸 사이를 오르내릴 수 있다 */
  stairs?: boolean;
};

/** 다리 상판 방향 (칸마다). 다리는 이 방향으로만 오르내린다. */
export const BridgeDir = {
  None: 0,
  /** 동서 방향 다리 */
  EastWest: 1,
  /** 남북 방향 다리 */
  NorthSouth: 2,
} as const;

/** 청크 계산 결과. 두 배열 모두 index = row * CHUNK_SIZE + col, row 0이 북쪽 줄 */
export type ChunkData = {
  classes: Uint8Array;
  /** 건물 높이(m, 최대 255). 건물이 아닌 칸은 0 */
  heights: Uint8Array;
  /** 건물 벽 색 0xRRGGBB. 건물이 아닌 칸은 0 */
  colors: Uint32Array;
  /** 다리 상판 방향(BridgeDir). 다리가 없으면 0. 다리 아래 칸 종류는 classes에 그대로 남는다 */
  bridges: Uint8Array;
  /** 지도 데이터의 계단이 지나는 칸이면 1 */
  stairs: Uint8Array;
};

/** 색 정보가 없는 건물에 쓸 건물 색 (건물마다 하나를 고정으로 고른다) */
// 지붕 색이 서로 잘 구분되도록 색 계열(hue)이 다른 색으로 골랐다. (지붕은 벽 색 계열을 따라간다)
const FALLBACK_BUILDING_COLORS = [
  0xe8dcc8, // 베이지 → 갈색 지붕
  0xb8c8d6, // 푸른 회색 → 파란 지붕
  0xcfdcc0, // 연녹색 → 초록 지붕
  0xe0b8b0, // 장밋빛 → 빨간 지붕
  0xd6c8e0, // 라벤더 → 보라 지붕
  0xe6d6a8, // 모래색 → 황토 지붕
  0xc8d8d4, // 민트 회색 → 청록 지붕
  0xdcdcdc, // 밝은 회색 → 회색 지붕
];

// 색 문자열(#rrggbb, 색 이름 등)을 숫자로 바꾸는 데 쓰는 캔버스. 브라우저가 해석하게 한다.
let colorCtx: CanvasRenderingContext2D | null = null;
function parseColor(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null;
  colorCtx ??= document.createElement('canvas').getContext('2d');
  if (!colorCtx) return null;
  colorCtx.fillStyle = '#010203'; // 해석에 실패하면 이 값이 그대로 남는다
  colorCtx.fillStyle = value;
  const out = colorCtx.fillStyle;
  if (out === '#010203' || !out.startsWith('#')) return null;
  return parseInt(out.slice(1, 7), 16);
}

/**
 * 건물 하나(다각형 하나)의 대체 색. 첫 꼭짓점 좌표로 고르므로 같은 건물은 항상 같은 색이다.
 * 지도 데이터는 높이·색이 같은 건물 수천 채를 묶음 도형(MultiPolygon) 하나로 보내므로,
 * 도형 단위가 아니라 그 안의 다각형 단위로 골라야 건물마다 색이 달라진다.
 */
function fallbackColor(polygon: Position[][]): number {
  const [lng, lat] = polygon[0]?.[0] ?? [0, 0];
  const h = (Math.imul(Math.round(lng * 1e6), 73856093) ^ Math.imul(Math.round(lat * 1e6), 19349663)) >>> 0;
  return FALLBACK_BUILDING_COLORS[h % FALLBACK_BUILDING_COLORS.length];
}

const hex = (color: number) => `#${color.toString(16).padStart(6, '0')}`;

/** 기본 지도의 벡터 소스 ID (스타일마다 이름이 달라서 찾아서 쓴다) */
export function findVectorSourceId(map: MapLibreMap): string | null {
  const sources = map.getStyle().sources;
  return Object.keys(sources).find((id) => sources[id].type === 'vector') ?? null;
}

/**
 * 다각형 고리를 사각형 [lo, hi]² 안으로 잘라낸다 (Sutherland–Hodgman).
 * 청크 밖으로 길게 뻗은 넓은 면(공원, 물 등)을 그대로 그리면 꼭짓점이 많아 매우 느려서, 미리 잘라 둔다.
 */
function clipRing(ring: [number, number][], lo: number, hi: number): [number, number][] {
  type P = [number, number];
  const clipEdge = (pts: P[], inside: (p: P) => boolean, cross: (a: P, b: P) => P): P[] => {
    const out: P[] = [];
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i];
      const prev = pts[(i + pts.length - 1) % pts.length];
      const curIn = inside(cur);
      const prevIn = inside(prev);
      if (curIn) {
        if (!prevIn) out.push(cross(prev, cur));
        out.push(cur);
      } else if (prevIn) {
        out.push(cross(prev, cur));
      }
    }
    return out;
  };
  const atX = (x: number) => (a: P, b: P): P => [x, a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0])];
  const atY = (y: number) => (a: P, b: P): P => [a[0] + ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]), y];
  let pts = ring;
  pts = clipEdge(pts, (p) => p[0] >= lo, atX(lo));
  if (pts.length) pts = clipEdge(pts, (p) => p[0] <= hi, atX(hi));
  if (pts.length) pts = clipEdge(pts, (p) => p[1] >= lo, atY(lo));
  if (pts.length) pts = clipEdge(pts, (p) => p[1] <= hi, atY(hi));
  return pts;
}

/** 도형의 메르카토르 범위. margin(m)만큼 넓힌다. */
function bboxOf(g: Geometry, margin: number): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const visit = (c: unknown): void => {
    if (typeof (c as number[])[0] === 'number') {
      const [x, y] = toMercator((c as number[])[0], (c as number[])[1]);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    } else {
      (c as unknown[]).forEach(visit);
    }
  };
  if ('coordinates' in g) visit(g.coordinates);
  return [minX - margin, minY - margin, maxX + margin, maxY + margin];
}

/** 현재 불러온 지도 데이터에서 칸 종류 판단에 쓸 도형을 그리는 순서대로 모은다. */
export function collectFeatures(map: MapLibreMap, sourceId: string): Draw[] {
  const q = (sourceLayer: string): GeoJSONFeature[] =>
    map.querySourceFeatures(sourceId, { sourceLayer });
  const cls = (f: GeoJSONFeature) => String(f.properties?.class ?? '');

  const draws: Draw[] = [];
  // 1) 녹지
  for (const f of q('landcover')) if (GREEN_LANDCOVER.has(cls(f))) draws.push({ cls: TileClass.Green, geometry: f.geometry, bbox: NO_BBOX });
  for (const f of q('landuse')) if (GREEN_LANDUSE.has(cls(f))) draws.push({ cls: TileClass.Green, geometry: f.geometry, bbox: NO_BBOX });
  for (const f of q('park')) draws.push({ cls: TileClass.Green, geometry: f.geometry, bbox: NO_BBOX });
  // 2) 물
  for (const f of q('water')) draws.push({ cls: TileClass.Water, geometry: f.geometry, bbox: NO_BBOX });
  for (const f of q('waterway')) {
    if (f.properties?.brunnel === 'tunnel') continue; // 땅속 수로(복개천)는 제외
    draws.push({ cls: TileClass.Water, geometry: f.geometry, bbox: NO_BBOX, widthM: WATERWAY_WIDTH_M });
  }
  // 3) 도로 (지하 도로는 제외). 다리 위 도로는 따로 표시해서 다리 아래 칸(물, 아래 도로)이 남게 한다.
  for (const f of q('transportation')) {
    const width = ROAD_WIDTH_M[cls(f)];
    if (!width || f.properties?.brunnel === 'tunnel') continue;
    const bridge = f.properties?.brunnel === 'bridge';
    const stairs = f.properties?.subclass === 'steps';
    draws.push({ cls: TileClass.Road, geometry: f.geometry, bbox: NO_BBOX, widthM: width, bridge, stairs });
  }
  // 4) 건물 (가장 우선)
  for (const f of q('building')) {
    const height = Number(f.properties?.render_height ?? 0);
    draws.push({
      cls: TileClass.Building,
      geometry: f.geometry,
      bbox: NO_BBOX,
      heightM: Number.isFinite(height) ? height : 0,
      color: parseColor(f.properties?.colour) ?? undefined,
    });
  }
  // 선 폭은 실제 m라서 메르카토르로는 조금 더 넓다(서울 약 1.26배). 넉넉하게 2배로 잡는다.
  for (const d of draws) d.bbox = bboxOf(d.geometry, (d.widthM ?? 0) * 2);
  return draws;
}

/** 청크의 칸 종류와 건물 높이를 계산한다. */
export function classifyChunk(chunk: ChunkId, allDraws: Draw[]): ChunkData {
  const size = CHUNK_SIZE * SAMPLE_SCALE;
  const cb = chunkBounds(chunk);
  // 청크와 겹치는 도형만 그린다. (그 일대 도형 전부를 그리던 것이 가장 큰 병목이었다)
  const draws = allDraws.filter(
    ({ bbox: [x0, y0, x1, y1] }) => x1 >= cb.minX && x0 <= cb.maxX && y1 >= cb.minY && y0 <= cb.maxY,
  );
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('canvas 2d context를 만들 수 없습니다');

  const b = chunkBounds(chunk);
  const pxPerM = size / (b.maxX - b.minX);
  // 메르카토르 1m가 실제로 몇 m인지(위도에 따라 다름). 도로 폭(실제 m)을 메르카토르로 바꿀 때 쓴다.
  const [, centerLat] = fromMercator((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2);
  const realPerMercator = Math.cos((centerLat * Math.PI) / 180);

  const toPx = (p: Position): [number, number] => {
    const [mx, my] = toMercator(p[0], p[1]);
    return [(mx - b.minX) * pxPerM, (b.maxY - my) * pxPerM]; // 캔버스는 y가 아래로 증가
  };

  // 캔버스보다 조금 넓은 사각형으로 잘라서 그린다 (경계 칸의 판단이 바뀌지 않게 여유를 둔다)
  const CLIP_PAD = SAMPLE_SCALE * 2;
  // 청크(+여유) 범위를 경위도로 구해 두고, 범위 밖 고리는 좌표 변환 없이 건너뛴다.
  // (묶음 도형에는 청크와 상관없는 건물이 수천 개 들어 있다)
  const padM = CLIP_PAD / pxPerM;
  const [west, south] = fromMercator(b.minX - padM, b.minY - padM);
  const [east, north] = fromMercator(b.maxX + padM, b.maxY + padM);
  const outside = (ring: Position[]) => {
    let w = Infinity;
    let s = Infinity;
    let e = -Infinity;
    let n = -Infinity;
    for (const [lng, lat] of ring) {
      if (lng < w) w = lng;
      if (lng > e) e = lng;
      if (lat < s) s = lat;
      if (lat > n) n = lat;
    }
    return e < west || w > east || n < south || s > north;
  };
  const tracePolygon = (rings: Position[][]) => {
    for (const ring of rings) {
      if (outside(ring)) continue;
      const pts = clipRing(ring.map(toPx), -CLIP_PAD, size + CLIP_PAD);
      if (pts.length < 3) continue;
      pts.forEach(([x, y], i) => {
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
    }
  };
  const traceLine = (line: Position[]) => {
    line.forEach((p, i) => {
      const [x, y] = toPx(p);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
  };

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';

  // 모든 칸을 땅으로 시작한다.
  const result = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE).fill(TileClass.Ground);
  const half = Math.floor(SAMPLE_SCALE / 2);

  const drawShape = (g: Geometry, widthM?: number) => {
    ctx.beginPath();
    if (g.type === 'Polygon') {
      tracePolygon(g.coordinates);
      ctx.fill('evenodd');
    } else if (g.type === 'MultiPolygon') {
      g.coordinates.forEach(tracePolygon);
      ctx.fill('evenodd');
    } else if ((g.type === 'LineString' || g.type === 'MultiLineString') && widthM) {
      if (g.type === 'LineString') traceLine(g.coordinates);
      else g.coordinates.forEach(traceLine);
      ctx.lineWidth = (widthM / realPerMercator) * pxPerM;
      ctx.stroke();
    }
  };

  // 종류마다 따로 그려서(다른 종류와 색이 섞이지 않게) 칸 중심이 절반 이상 덮였는지 본다.
  // 한 캔버스에 여러 종류를 겹쳐 그리면, 경계의 부드럽게 섞인 색이 엉뚱한 종류로 읽혔다.
  for (const cls of CLASS_ORDER) {
    ctx.clearRect(0, 0, size, size);
    for (const d of draws) {
      if (d.cls === cls && !d.bridge) drawShape(d.geometry, d.widthM);
    }

    const data = ctx.getImageData(0, 0, size, size).data;
    for (let row = 0; row < CHUNK_SIZE; row++) {
      for (let col = 0; col < CHUNK_SIZE; col++) {
        const px = col * SAMPLE_SCALE + half;
        const py = row * SAMPLE_SCALE + half;
        if (data[(py * size + px) * 4 + 3] >= COVER_THRESHOLD) result[row * CHUNK_SIZE + col] = cls;
      }
    }
  }

  // 건물 높이: 낮은 건물부터 높이 값을 빨강 채널로 그려서, 겹치면 높은 건물이 남게 한다.
  const heights = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
  ctx.clearRect(0, 0, size, size);
  const buildings = draws.filter((d) => d.cls === TileClass.Building).sort((a, b) => (a.heightM ?? 0) - (b.heightM ?? 0));
  for (const d of buildings) {
    ctx.fillStyle = `rgb(${Math.min(255, Math.round(d.heightM ?? 0))},0,0)`;
    drawShape(d.geometry);
  }
  const hData = ctx.getImageData(0, 0, size, size).data;
  for (let row = 0; row < CHUNK_SIZE; row++) {
    for (let col = 0; col < CHUNK_SIZE; col++) {
      const i = row * CHUNK_SIZE + col;
      if (result[i] !== TileClass.Building) continue;
      const px = col * SAMPLE_SCALE + half;
      const py = row * SAMPLE_SCALE + half;
      heights[i] = hData[(py * size + px) * 4]; // getImageData는 알파를 풀어 준 색을 돌려주므로 경계에서도 값이 유지된다
    }
  }

  // 건물 색: 높이와 같은 순서(낮은 건물 → 높은 건물)로 칠해서, 겹치면 높은 건물 색이 남게 한다.
  const colors = new Uint32Array(CHUNK_SIZE * CHUNK_SIZE);
  ctx.clearRect(0, 0, size, size);
  for (const d of buildings) {
    const g = d.geometry;
    if (d.color !== undefined) {
      ctx.fillStyle = hex(d.color); // 지도 데이터의 실제 색
      drawShape(g);
    } else if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
      // 색 정보가 없으면 건물(다각형)마다 대체 색을 따로 고른다
      for (const polygon of g.type === 'Polygon' ? [g.coordinates] : g.coordinates) {
        ctx.beginPath();
        tracePolygon(polygon);
        ctx.fillStyle = hex(fallbackColor(polygon));
        ctx.fill('evenodd');
      }
    }
  }
  // 붙어 있는 건물 경계에서는 두 색이 섞인 중간 색이 읽힌다. 실제로 칠한 색 중 가장 가까운 색으로 맞춘다.
  // (중간 색이 그대로 남으면 색마다 지붕·벽 그림을 새로 만들어야 해서 화면이 멈칫했다)
  const used = new Set<number>(FALLBACK_BUILDING_COLORS);
  for (const d of buildings) if (d.color !== undefined) used.add(d.color);
  const palette = [...used];
  const nearest = (r: number, g: number, bl: number) => {
    let best = palette[0];
    let bestD = Infinity;
    for (const c of palette) {
      const dr = ((c >> 16) & 255) - r;
      const dg = ((c >> 8) & 255) - g;
      const db = (c & 255) - bl;
      const dist = dr * dr + dg * dg + db * db;
      if (dist < bestD) {
        bestD = dist;
        best = c;
      }
    }
    return best;
  };
  const cData = ctx.getImageData(0, 0, size, size).data;
  for (let row = 0; row < CHUNK_SIZE; row++) {
    for (let col = 0; col < CHUNK_SIZE; col++) {
      const i = row * CHUNK_SIZE + col;
      if (result[i] !== TileClass.Building) continue;
      const p = ((row * SAMPLE_SCALE + half) * size + col * SAMPLE_SCALE + half) * 4;
      colors[i] = nearest(cData[p], cData[p + 1], cData[p + 2]);
    }
  }

  // 다리: 선분마다 방향에 따라 빨강(동서) / 초록(남북)으로 그려서, 칸마다 상판 방향을 읽는다.
  const bridges = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
  const bridgeDraws = draws.filter((d) => d.bridge);
  if (bridgeDraws.length) {
    ctx.clearRect(0, 0, size, size);
    for (const d of bridgeDraws) {
      const g = d.geometry;
      const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
      ctx.lineWidth = ((d.widthM ?? 0) / realPerMercator) * pxPerM;
      for (const line of lines) {
        for (let i = 1; i < line.length; i++) {
          const [ax, ay] = toPx(line[i - 1]);
          const [bx, by] = toPx(line[i]);
          ctx.strokeStyle = Math.abs(bx - ax) >= Math.abs(by - ay) ? '#f00' : '#0f0';
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
          ctx.stroke();
        }
      }
    }
    const bData = ctx.getImageData(0, 0, size, size).data;
    for (let row = 0; row < CHUNK_SIZE; row++) {
      for (let col = 0; col < CHUNK_SIZE; col++) {
        const i = row * CHUNK_SIZE + col;
        if (result[i] === TileClass.Building) continue;
        const p = ((row * SAMPLE_SCALE + half) * size + col * SAMPLE_SCALE + half) * 4;
        if (bData[p + 3] < COVER_THRESHOLD) continue;
        bridges[i] = bData[p] >= bData[p + 1] ? BridgeDir.EastWest : BridgeDir.NorthSouth;
      }
    }
  }

  // 계단: 다리가 아닌 계단 선이 지나는 칸
  const stairs = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
  const stairDraws = draws.filter((d) => d.stairs && !d.bridge);
  if (stairDraws.length) {
    ctx.clearRect(0, 0, size, size);
    ctx.strokeStyle = '#fff';
    for (const d of stairDraws) drawShape(d.geometry, d.widthM);
    const sData = ctx.getImageData(0, 0, size, size).data;
    for (let row = 0; row < CHUNK_SIZE; row++) {
      for (let col = 0; col < CHUNK_SIZE; col++) {
        const p = ((row * SAMPLE_SCALE + half) * size + col * SAMPLE_SCALE + half) * 4;
        if (sData[p + 3] >= COVER_THRESHOLD) stairs[row * CHUNK_SIZE + col] = 1;
      }
    }
  }

  return { classes: result, heights, colors, bridges, stairs };
}
