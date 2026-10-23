import { TileClass } from '../map/tileClass';
import type { ObjectKind } from './placement';

/**
 * 타일 그림 불러오기
 * - 바닥·물체: Kenney RPG Urban Pack (CC0) — frontend/public/tiles/kenney-rpg-urban/
 * - 캐릭터: Ninja Adventure (CC0) — frontend/public/tiles/ninja-adventure/
 */

const T = 16; // 타일 한 장 크기(px)

/** 이웃 4칸(북·동·남·서)이 같은 종류인지에 따라 고르는 오토타일 16장 */
export type Autotile = (n: boolean, e: boolean, s: boolean, w: boolean) => HTMLCanvasElement;

export type Tileset = {
  grass: Autotile;
  sidewalk: Autotile;
  water: Autotile;
  asphalt: HTMLCanvasElement[];
  paving: HTMLCanvasElement[];
  /** 물체 그림 (16×32: 아래쪽이 칸에 닿는다). 같은 종류에 변형이 여러 개일 수 있다. */
  objects: Record<ObjectKind, HTMLCanvasElement[]>;
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

/** 시트에서 (col, row)부터 w×h칸을 잘라 캔버스로 만든다 */
function cut(img: HTMLImageElement, col: number, row: number, w = 1, h = 1): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w * T;
  c.height = h * T;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context를 만들 수 없습니다');
  ctx.drawImage(img, col * T, row * T, w * T, h * T, 0, 0, w * T, h * T);
  return c;
}

/**
 * Kenney 오토타일 배치 ((oc, or) = 3×3 덩어리의 왼쪽 위 칸):
 *   3×3 덩어리: (oc..oc+2, or..or+2)  ← 모서리·변·가운데
 *   가로 띠:    (oc+3, or+2) 왼쪽 끝, (oc+4, or+2) 중간, (oc+5, or+2) 오른쪽 끝
 *   외딴 한 칸: (oc+6, or+2)
 *   세로 띠:    (oc+7, or) 위쪽 끝, (oc+7, or+1) 중간, (oc+7, or+2) 아래쪽 끝
 */
function autotile(img: HTMLImageElement, oc: number, or: number): Autotile {
  const cache = new Map<string, HTMLCanvasElement>();
  const at = (c: number, r: number) => {
    const k = `${c},${r}`;
    let t = cache.get(k);
    if (!t) {
      t = cut(img, c, r);
      cache.set(k, t);
    }
    return t;
  };
  return (n, e, s, w) => {
    if (n && e && s && w) return at(oc + 1, or + 1);
    if (!n && e && s && w) return at(oc + 1, or);
    if (n && e && !s && w) return at(oc + 1, or + 2);
    if (n && e && s && !w) return at(oc, or + 1);
    if (n && !e && s && w) return at(oc + 2, or + 1);
    if (!n && !w && e && s) return at(oc, or);
    if (!n && !e && w && s) return at(oc + 2, or);
    if (!s && !w && n && e) return at(oc, or + 2);
    if (!s && !e && n && w) return at(oc + 2, or + 2);
    if (n && s) return at(oc + 7, or + 1); // 세로로만 이어짐
    if (s) return at(oc + 7, or); // 남쪽으로만 → 세로 띠 위쪽 끝
    if (n) return at(oc + 7, or + 2); // 북쪽으로만 → 세로 띠 아래쪽 끝
    if (e && w) return at(oc + 4, or + 2); // 가로로만 이어짐
    if (e) return at(oc + 3, or + 2); // 동쪽으로만 → 가로 띠 왼쪽 끝
    if (w) return at(oc + 5, or + 2); // 서쪽으로만 → 가로 띠 오른쪽 끝
    return at(oc + 6, or + 2); // 외딴 한 칸
  };
}

export async function loadTileset(): Promise<Tileset> {
  const [urban, character] = await Promise.all([
    loadImage('/tiles/kenney-rpg-urban/urban.png'),
    loadImage('/tiles/ninja-adventure/CharacterBoy.png'),
  ]);
  return {
    grass: autotile(urban, 0, 0),
    sidewalk: autotile(urban, 8, 0),
    water: autotile(urban, 8, 6),
    asphalt: [cut(urban, 9, 16), cut(urban, 9, 17), cut(urban, 1, 17), cut(urban, 8, 16)],
    paving: [cut(urban, 1, 4)],
    objects: {
      lamp: [cut(urban, 7, 6, 1, 2)],
      streetTree: [cut(urban, 17, 8, 1, 2)],
      tree: [cut(urban, 16, 8, 1, 2), cut(urban, 17, 8, 1, 2), cut(urban, 21, 8, 1, 2)],
      bench: [cut(urban, 1, 10)],
    },
    character,
  };
}

/** 오토타일에서 이웃을 '이어진 것'으로 볼지 (테두리를 그리지 않을 이웃) */
export function connects(cls: TileClass, neighbor: TileClass | undefined): boolean {
  if (neighbor === undefined) return true; // 아직 계산 전인 칸에는 테두리를 그리지 않는다
  return neighbor === cls;
}
