import type { Map as MapLibreMap } from 'maplibre-gl';
import { CHUNK_SIZE, chunkBounds, chunkOf, chunksInBounds, tileAt, toMercator, type ChunkId } from './grid';
import { GRID_MIN_ZOOM } from './gridLayer';
import { classifyChunk, collectFeatures, findVectorSourceId, type ChunkData, type Draw, type TileClass } from './tileClass';

// 청크 키를 숫자로 만든다 (문자열을 매번 만들지 않게). |cy|는 25만을 넘지 않는다.
const key = (cx: number, cy: number) => cx * 1_000_000 + cy;

export type TileStore = {
  /** 칸 종류. 아직 계산하지 않은 칸이면 undefined */
  get(x: number, y: number): TileClass | undefined;
  /** 건물 높이(m). 건물이 아니거나 계산 전이면 0 */
  height(x: number, y: number): number;
  /** 건물 벽 색 0xRRGGBB. 건물이 아니거나 계산 전이면 0 */
  color(x: number, y: number): number;
  /** 청크 데이터 (계산 전이면 undefined) */
  chunk(cx: number, cy: number): ChunkData | undefined;
  /** 새 청크가 계산될 때마다 1씩 커진다 (그림 캐시를 다시 만들지 판단할 때 쓴다) */
  version(): number;
};

/**
 * 화면에 보이는 청크의 칸 종류를 계산해서 보관한다.
 * 지도 'load' 이후에 호출한다. 새 청크를 계산하면 onUpdate를 호출한다.
 */
export function createTileStore(map: MapLibreMap, onUpdate: () => void): TileStore {
  const sourceId = findVectorSourceId(map);
  const chunks = new Map<number, ChunkData>();
  // 지도 데이터에서 모은 도형. 지도 데이터가 새로 들어오면 다시 모은다.
  let draws: Draw[] | null = null;

  // 받아 둔 데이터 타일 목록 ("x/y", 데이터 최대 줌 기준).
  // 청크(약 127m)는 데이터 타일(약 1.9km) 경계에 걸칠 수 있는데, 건너편 타일을 아직 받지 않은 채 계산하면
  // 그쪽 칸이 전부 땅으로 계산되어 '영역째 깨진' 모양으로 남았다. 그래서 덮는 타일이 다 있을 때만 계산한다.
  const sourceMaxZoom = (map.getSource(sourceId ?? '') as { maxzoom?: number } | undefined)?.maxzoom ?? 14;
  const loadedTiles = new Set<string>();
  map.on('sourcedata', (e) => {
    if (e.sourceId !== sourceId || !e.tile) return;
    draws = null;
    const tile = e.tile as { state?: string; tileID?: { canonical?: { z: number; x: number; y: number } } };
    const c = tile.tileID?.canonical;
    if (tile.state === 'loaded' && c && c.z === sourceMaxZoom) loadedTiles.add(`${c.x}/${c.y}`);
  });

  /** 메르카토르 범위를 덮는 데이터 타일 목록 */
  const WORLD = 2 * Math.PI * 6378137;
  const tilesFor = (minX: number, minY: number, maxX: number, maxY: number) => {
    const size = WORLD / 2 ** sourceMaxZoom;
    const tx = (mx: number) => Math.floor((mx + WORLD / 2) / size);
    const ty = (my: number) => Math.floor((WORLD / 2 - my) / size); // 타일 y는 북쪽이 0
    const keys: string[] = [];
    for (let x = tx(minX); x <= tx(maxX); x++) {
      for (let y = ty(maxY); y <= ty(minY); y++) keys.push(`${x}/${y}`);
    }
    return keys;
  };
  const covered = (c: ChunkId) => {
    const b = chunkBounds(c);
    return tilesFor(b.minX, b.minY, b.maxX, b.maxY).every((k) => loadedTiles.has(k));
  };
  let scheduled = false;
  let version = 0;

  const update = () => {
    if (!sourceId || map.getZoom() < GRID_MIN_ZOOM) return;
    // 화면보다 사방으로 화면 절반만큼 넓게 미리 계산해 둔다. (걸어가는 쪽이 미리 준비되도록)
    const b = map.getBounds();
    const padLng = (b.getEast() - b.getWest()) / 2;
    const padLat = (b.getNorth() - b.getSouth()) / 2;
    const pending: ChunkId[] = chunksInBounds(
      b.getWest() - padLng,
      b.getSouth() - padLat,
      b.getEast() + padLng,
      b.getNorth() + padLat,
    ).filter((c) => !chunks.has(key(c.cx, c.cy)) && covered(c));
    if (pending.length === 0) return;

    // 지금 화면의 지도 데이터가 다 들어오기 전에는 계산하지 않는다.
    // (멀리 이동한 직후에는 예전 지역 데이터만 있어서, 새 청크가 전부 '땅'으로 계산되어 버렸다)
    if (!map.isSourceLoaded(sourceId)) return;

    // 지금 화면을 덮는 데이터 타일은 확실히 받아져 있다. (처음 로딩 때처럼 기록을 시작하기 전에
    // 받은 타일이 있을 수 있어서, 여기서도 기록해 둔다)
    {
      const v = map.getBounds();
      const [vx0, vy0] = toMercator(v.getWest(), v.getSouth());
      const [vx1, vy1] = toMercator(v.getEast(), v.getNorth());
      for (const k of tilesFor(vx0, vy0, vx1, vy1)) loadedTiles.add(k);
    }

    if (!draws) draws = collectFeatures(map, sourceId);
    if (draws.length === 0) {
      draws = null; // 아직 데이터가 안 들어왔으면 다음에 다시 시도
      return;
    }

    // 화면 중심에 가까운 청크부터, 한 번에 한 청크만 계산한다. (한 프레임이 길게 멈추지 않게)
    const center = map.getCenter();
    const here = chunkOf(tileAt(center.lng, center.lat));
    pending.sort(
      (a, b) => Math.hypot(a.cx - here.cx, a.cy - here.cy) - Math.hypot(b.cx - here.cx, b.cy - here.cy),
    );
    const c = pending[0];
    chunks.set(key(c.cx, c.cy), classifyChunk(c, draws));
    version++;
    onUpdate();

    // 남은 청크는 다음 프레임에 이어서 계산한다.
    // requestAnimationFrame으로 바로 부르면, 순간 이동 직후 지도가 새 위치 데이터를 요청하기 전에 실행되어
    // 예전 데이터로 계산될 수 있다. 그래서 지도가 다시 그려진 직후(render)에만 이어서 계산한다.
    if (pending.length > 1 && !scheduled) {
      scheduled = true;
      map.once('render', () => {
        scheduled = false;
        update();
      });
      map.triggerRepaint();
    }
  };

  // 데이터 로딩이 끝났을 때(idle)와, 캐릭터 이동처럼 지도가 계속 움직이는 중(moveend)에도 계산한다.
  // 새로 계산할 청크가 없으면 바로 끝나므로 자주 호출해도 부담이 적다.
  // moveend 직후에는 지도가 아직 새 위치의 데이터를 요청하기 전이라 '다 들어왔다'고 잘못 답한다.
  // 그래서 지도가 한 번 다시 그려진 뒤(새 위치 기준으로 데이터 요청이 반영된 뒤)에 계산한다.
  map.on('idle', update);
  map.on('moveend', () => map.once('render', update));
  update();

  // 칸 좌표 → (청크 데이터, 배열 index)
  const locate = (x: number, y: number): [ChunkData, number] | null => {
    const cx = Math.floor(x / CHUNK_SIZE);
    const cy = Math.floor(y / CHUNK_SIZE);
    const data = chunks.get(key(cx, cy));
    if (!data) return null;
    const col = x - cx * CHUNK_SIZE;
    const row = CHUNK_SIZE - 1 - (y - cy * CHUNK_SIZE); // row 0이 북쪽 줄
    return [data, row * CHUNK_SIZE + col];
  };

  return {
    get(x, y) {
      const found = locate(x, y);
      return found ? (found[0].classes[found[1]] as TileClass) : undefined;
    },
    height(x, y) {
      const found = locate(x, y);
      return found ? found[0].heights[found[1]] : 0;
    },
    color(x, y) {
      const found = locate(x, y);
      return found ? found[0].colors[found[1]] : 0;
    },
    chunk(cx, cy) {
      return chunks.get(key(cx, cy));
    },
    version: () => version,
  };
}
