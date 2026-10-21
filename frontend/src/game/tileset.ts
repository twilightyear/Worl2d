import { TileClass } from '../map/tileClass';

/**
 * Ninja Adventure 타일셋(CC0)에서 바닥 타일과 캐릭터 그림을 불러온다.
 * 파일은 frontend/public/tiles/ninja-adventure/ 에 있다.
 */

const BASE = '/tiles/ninja-adventure';
const T = 16; // 타일 한 장 크기(px)

/** 이웃 4칸(북·동·남·서)이 같은 종류인지에 따라 고르는 오토타일 16장 */
export type Autotile = (n: boolean, e: boolean, s: boolean, w: boolean) => HTMLCanvasElement;

export type Tileset = {
  grass: HTMLCanvasElement[];
  dirt: Autotile;
  road: Autotile;
  water: Autotile;
  /** 캐릭터 시트 (16×16 칸, 열 = 방향, 0~3행 = 걷기) */
  character: HTMLImageElement;
};

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`이미지를 불러오지 못했습니다: ${src}`));
    img.src = src;
  });
}

/** 시트에서 (col, row) 칸 한 장을 잘라 캔버스로 만든다. recolor로 픽셀 색을 바꿀 수 있다. */
function cut(
  img: HTMLImageElement,
  col: number,
  row: number,
  recolor?: (r: number, g: number, b: number) => [number, number, number] | null,
): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = T;
  c.height = T;
  const ctx = c.getContext('2d', { willReadFrequently: Boolean(recolor) });
  if (!ctx) throw new Error('canvas 2d context를 만들 수 없습니다');
  ctx.drawImage(img, col * T, row * T, T, T, 0, 0, T, T);
  if (recolor) {
    const data = ctx.getImageData(0, 0, T, T);
    const d = data.data;
    for (let i = 0; i < d.length; i += 4) {
      const out = recolor(d[i], d[i + 1], d[i + 2]);
      if (out) [d[i], d[i + 1], d[i + 2]] = out;
    }
    ctx.putImageData(data, 0, 0);
  }
  return c;
}

/**
 * 오토타일 묶음 (이 타일셋의 배치):
 *   (0,0)(1,0)(2,0) | (3,0)   ← 3×3 덩어리의 윗줄 | 세로 길 위쪽 끝
 *   (0,1)(1,1)(2,1) | (3,1)   ← 가운데 줄         | 세로 길 중간
 *   (0,2)(1,2)(2,2) | (3,2)   ← 아랫줄            | 세로 길 아래쪽 끝
 *   (0,3)(1,3)(2,3) | (3,3)   ← 가로 길 왼쪽 끝·중간·오른쪽 끝 | 외딴 한 칸
 * (originCol, originRow)는 묶음의 왼쪽 위 칸이다.
 */
function autotile(
  img: HTMLImageElement,
  originCol: number,
  originRow: number,
  recolor?: (r: number, g: number, b: number) => [number, number, number] | null,
): Autotile {
  const cache = new Map<string, HTMLCanvasElement>();
  const at = (dc: number, dr: number) => {
    const k = `${dc},${dr}`;
    let c = cache.get(k);
    if (!c) {
      c = cut(img, originCol + dc, originRow + dr, recolor);
      cache.set(k, c);
    }
    return c;
  };
  return (n, e, s, w) => {
    if (n && e && s && w) return at(1, 1);
    if (!n && e && s && w) return at(1, 0);
    if (n && e && !s && w) return at(1, 2);
    if (n && e && s && !w) return at(0, 1);
    if (n && !e && s && w) return at(2, 1);
    if (!n && !w && e && s) return at(0, 0);
    if (!n && !e && w && s) return at(2, 0);
    if (!s && !w && n && e) return at(0, 2);
    if (!s && !e && n && w) return at(2, 2);
    if (n && s) return at(3, 1); // 세로로만 이어짐
    if (s) return at(3, 0); // 남쪽으로만 이어짐 → 세로 길 위쪽 끝
    if (n) return at(3, 2); // 북쪽으로만 이어짐 → 세로 길 아래쪽 끝
    if (e && w) return at(1, 3); // 가로로만 이어짐
    if (e) return at(0, 3); // 동쪽으로만 → 가로 길 왼쪽 끝
    if (w) return at(2, 3); // 서쪽으로만 → 가로 길 오른쪽 끝
    return at(3, 3); // 외딴 한 칸
  };
}

/** 흙(갈색) 픽셀만 회색 포장도로 색으로 바꾼다. 풀(초록, g ≥ r)은 그대로 둔다. */
const dirtToPavement = (r: number, g: number, b: number): [number, number, number] | null => {
  if (r <= g + 8) return null;
  const v = 0.3 * r + 0.59 * g + 0.11 * b;
  const clamp = (x: number) => Math.max(0, Math.min(255, Math.round(x)));
  return [clamp(v * 0.95 + 18), clamp(v * 0.97 + 20), clamp(v + 28)];
};

export async function loadTileset(): Promise<Tileset> {
  const [floor, water, character] = await Promise.all([
    loadImage(`${BASE}/TilesetFloor.png`),
    loadImage(`${BASE}/TilesetWater.png`),
    loadImage(`${BASE}/CharacterBoy.png`),
  ]);
  return {
    // 연두색 풀밭: 무늬 없는 칸을 더 자주 쓴다
    grass: [cut(floor, 0, 12), cut(floor, 0, 12), cut(floor, 1, 12), cut(floor, 3, 12)],
    dirt: autotile(floor, 0, 7),
    road: autotile(floor, 0, 7, dirtToPavement),
    water: autotile(water, 0, 6),
    character,
  };
}

/** 칸 종류별로, 이웃이 '이어진 것'으로 볼 종류 (오토타일 테두리를 그리지 않을 이웃) */
export function connects(cls: TileClass, neighbor: TileClass | undefined): boolean {
  if (neighbor === undefined) return true; // 아직 계산 전인 칸에는 테두리를 그리지 않는다
  if (cls === TileClass.Water) return neighbor === TileClass.Water;
  // 흙·도로·건물 바닥은 풀밭이 아닌 것과는 모두 이어진다 (흙과 도로 사이에 풀 테두리가 생기지 않게)
  return neighbor !== TileClass.Green;
}
