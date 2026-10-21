// 격자형 타일(게임 칸) 규칙. 백엔드도 나중에 같은 규칙으로 계산해야 한다.
// - 좌표계: Web Mercator(EPSG:3857) 미터. 화면과 나란한 정사각형이 된다.
// - 칸 크기: 2.5 메르카토르 m = 서울(위도 약 37.57°)에서 실제 약 1.98m
// - 칸 ID: (x, y) = floor(메르카토르 좌표 / 칸 크기). x는 동쪽, y는 북쪽으로 갈수록 커진다.
//   (웹 지도 타일 z/x/y와는 별개의 개념이다.)

import type { Feature, FeatureCollection, LineString } from 'geojson';

export const TILE_SIZE = 2.5;

const EARTH_RADIUS = 6378137;
const MAX_LAT = 85.0511287798; // Web Mercator가 표현할 수 있는 최대 위도

export type TileId = { x: number; y: number };
export type LngLat = [number, number];

type LineFeature = Feature<LineString>;
export type GridLines = FeatureCollection<LineString>;

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

/** 경위도(도) → 메르카토르 좌표(m) */
export function toMercator(lng: number, lat: number): [number, number] {
  const clampedLat = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  const x = EARTH_RADIUS * toRad(lng);
  const y = EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + toRad(clampedLat) / 2));
  return [x, y];
}

/** 메르카토르 좌표(m) → 경위도(도) */
export function fromMercator(x: number, y: number): LngLat {
  const lng = toDeg(x / EARTH_RADIUS);
  const lat = toDeg(2 * Math.atan(Math.exp(y / EARTH_RADIUS)) - Math.PI / 2);
  return [lng, lat];
}

/** 경위도가 속한 칸 ID */
export function tileAt(lng: number, lat: number): TileId {
  const [x, y] = toMercator(lng, lat);
  return { x: Math.floor(x / TILE_SIZE), y: Math.floor(y / TILE_SIZE) };
}

/** 칸의 네 꼭짓점(닫힌 고리, [경도, 위도]) */
export function tileRing(tile: TileId): LngLat[] {
  const minX = tile.x * TILE_SIZE;
  const minY = tile.y * TILE_SIZE;
  const maxX = minX + TILE_SIZE;
  const maxY = minY + TILE_SIZE;
  const sw = fromMercator(minX, minY);
  const se = fromMercator(maxX, minY);
  const ne = fromMercator(maxX, maxY);
  const nw = fromMercator(minX, maxY);
  return [sw, se, ne, nw, sw];
}

/**
 * 경위도 범위 안의 격자선. 선이 maxLines개를 넘으면 null을 반환한다.
 * (덜 확대된 상태에서 수만 개의 선을 만들지 않기 위함)
 */
export function gridLines(
  west: number,
  south: number,
  east: number,
  north: number,
  maxLines = 2000,
): GridLines | null {
  const [minX, minY] = toMercator(west, south);
  const [maxX, maxY] = toMercator(east, north);

  const startX = Math.floor(minX / TILE_SIZE);
  const endX = Math.ceil(maxX / TILE_SIZE);
  const startY = Math.floor(minY / TILE_SIZE);
  const endY = Math.ceil(maxY / TILE_SIZE);

  if (endX - startX + (endY - startY) > maxLines) return null;

  const features: LineFeature[] = [];
  const line = (a: LngLat, b: LngLat): LineFeature => ({
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: [a, b] },
  });

  // 세로선: x가 일정 (메르카토르에서 직선)
  for (let i = startX; i <= endX; i++) {
    const x = i * TILE_SIZE;
    features.push(line(fromMercator(x, startY * TILE_SIZE), fromMercator(x, endY * TILE_SIZE)));
  }
  // 가로선: y가 일정
  for (let j = startY; j <= endY; j++) {
    const y = j * TILE_SIZE;
    features.push(line(fromMercator(startX * TILE_SIZE, y), fromMercator(endX * TILE_SIZE, y)));
  }

  return { type: 'FeatureCollection', features };
}
