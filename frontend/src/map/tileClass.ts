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

/** 칸 하나를 몇 px로 그려서 판단할지. 칸 중심 픽셀만 읽으므로 경계의 흐림(안티앨리어싱) 영향을 피한다. */
const SAMPLE_SCALE = 4;

/** 칸 종류를 빨강 채널 값으로 그려 두었다가 다시 읽는다. */
const CLASS_STEP = 50;
const classFill = (c: TileClass) => `rgb(${c * CLASS_STEP},0,0)`;

type Draw = { cls: TileClass; geometry: Geometry; widthM?: number };

/** 기본 지도의 벡터 소스 ID (스타일마다 이름이 달라서 찾아서 쓴다) */
export function findVectorSourceId(map: MapLibreMap): string | null {
  const sources = map.getStyle().sources;
  return Object.keys(sources).find((id) => sources[id].type === 'vector') ?? null;
}

/** 현재 불러온 지도 데이터에서 칸 종류 판단에 쓸 도형을 그리는 순서대로 모은다. */
export function collectFeatures(map: MapLibreMap, sourceId: string): Draw[] {
  const q = (sourceLayer: string): GeoJSONFeature[] =>
    map.querySourceFeatures(sourceId, { sourceLayer });
  const cls = (f: GeoJSONFeature) => String(f.properties?.class ?? '');

  const draws: Draw[] = [];
  // 1) 녹지
  for (const f of q('landcover')) if (GREEN_LANDCOVER.has(cls(f))) draws.push({ cls: TileClass.Green, geometry: f.geometry });
  for (const f of q('landuse')) if (GREEN_LANDUSE.has(cls(f))) draws.push({ cls: TileClass.Green, geometry: f.geometry });
  for (const f of q('park')) draws.push({ cls: TileClass.Green, geometry: f.geometry });
  // 2) 물
  for (const f of q('water')) draws.push({ cls: TileClass.Water, geometry: f.geometry });
  for (const f of q('waterway')) draws.push({ cls: TileClass.Water, geometry: f.geometry, widthM: WATERWAY_WIDTH_M });
  // 3) 도로 (지하 도로는 제외)
  for (const f of q('transportation')) {
    const width = ROAD_WIDTH_M[cls(f)];
    if (!width || f.properties?.brunnel === 'tunnel') continue;
    draws.push({ cls: TileClass.Road, geometry: f.geometry, widthM: width });
  }
  // 4) 건물 (가장 우선)
  for (const f of q('building')) draws.push({ cls: TileClass.Building, geometry: f.geometry });
  return draws;
}

/**
 * 청크의 칸 종류를 계산한다.
 * 반환값: 길이 CHUNK_SIZE² 배열. index = row * CHUNK_SIZE + col, row 0이 북쪽(위) 줄이다.
 */
export function classifyChunk(chunk: ChunkId, draws: Draw[]): Uint8Array {
  const size = CHUNK_SIZE * SAMPLE_SCALE;
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

  const tracePolygon = (rings: Position[][]) => {
    for (const ring of rings) {
      ring.forEach((p, i) => {
        const [x, y] = toPx(p);
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

  ctx.fillStyle = classFill(TileClass.Ground);
  ctx.fillRect(0, 0, size, size);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const d of draws) {
    const g = d.geometry;
    ctx.beginPath();
    if (g.type === 'Polygon') {
      tracePolygon(g.coordinates);
      ctx.fillStyle = classFill(d.cls);
      ctx.fill('evenodd');
    } else if (g.type === 'MultiPolygon') {
      g.coordinates.forEach(tracePolygon);
      ctx.fillStyle = classFill(d.cls);
      ctx.fill('evenodd');
    } else if ((g.type === 'LineString' || g.type === 'MultiLineString') && d.widthM) {
      if (g.type === 'LineString') traceLine(g.coordinates);
      else g.coordinates.forEach(traceLine);
      ctx.strokeStyle = classFill(d.cls);
      ctx.lineWidth = (d.widthM / realPerMercator) * pxPerM;
      ctx.stroke();
    }
  }

  // 각 칸의 중심 픽셀을 읽어 칸 종류로 바꾼다.
  const data = ctx.getImageData(0, 0, size, size).data;
  const result = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
  const half = Math.floor(SAMPLE_SCALE / 2);
  for (let row = 0; row < CHUNK_SIZE; row++) {
    for (let col = 0; col < CHUNK_SIZE; col++) {
      const px = col * SAMPLE_SCALE + half;
      const py = row * SAMPLE_SCALE + half;
      const red = data[(py * size + px) * 4];
      result[row * CHUNK_SIZE + col] = Math.min(TileClass.Building, Math.round(red / CLASS_STEP)) as TileClass;
    }
  }
  return result;
}
