import { TileClass } from '../map/tileClass';

/** 도트 타일 한 장의 픽셀 크기 */
export const SPRITE_PX = 16;

/** 칸 종류별 변형 그림 개수 (같은 종류도 칸마다 무늬를 조금씩 다르게) */
const VARIANTS = 4;

/** 건물 색 하나에 대한 그림 묶음 */
export type BuildingSprites = {
  roofs: HTMLCanvasElement[];
  /** 옆면 벽. eaves: 벽 맨 윗줄(처마), base: 벽 맨 아랫줄(바닥 그림자) */
  wall: (eaves: boolean, base: boolean) => HTMLCanvasElement;
  /** 지붕 외곽선 색 */
  outline: string;
};

export type Sprites = {
  tiles: Record<TileClass, HTMLCanvasElement[]>;
  /** 건물 색(0xRRGGBB)별 그림. 처음 쓰일 때 만들어 보관한다. */
  building: (color: number) => BuildingSprites;
};

// 시드가 같으면 항상 같은 무늬가 나오는 난수 (mulberry32)
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sprite(draw: (px: (x: number, y: number, color: string, w?: number, h?: number) => void) => void) {
  const canvas = document.createElement('canvas');
  canvas.width = SPRITE_PX;
  canvas.height = SPRITE_PX;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context를 만들 수 없습니다');
  draw((x, y, color, w = 1, h = 1) => {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
  });
  return canvas;
}

const S = SPRITE_PX;

/** 색을 밝게(amount > 0) 또는 어둡게(amount < 0) 한다. amount: -1 ~ 1 */
function shade(color: number, amount: number): string {
  const ch = (v: number) => {
    const out = amount >= 0 ? v + (255 - v) * amount : v * (1 + amount);
    return Math.max(0, Math.min(255, Math.round(out)));
  };
  const r = ch((color >> 16) & 255);
  const g = ch((color >> 8) & 255);
  const b = ch(color & 255);
  return `rgb(${r},${g},${b})`;
}

/** 바탕색 위에 점을 흩뿌린다 */
function speckled(seed: number, base: string, dots: [string, number][]) {
  const r = rng(seed);
  return sprite((px) => {
    px(0, 0, base, S, S);
    for (const [color, count] of dots) {
      for (let i = 0; i < count; i++) px(Math.floor(r() * S), Math.floor(r() * S), color);
    }
  });
}

function ground(seed: number) {
  return speckled(seed, '#d9c9a0', [
    ['#c4b285', 10],
    ['#e8dcba', 6],
  ]);
}

function grass(seed: number) {
  const r = rng(seed);
  return sprite((px) => {
    px(0, 0, '#79c062', S, S);
    // 풀잎: ʌ 모양 (어두운 2px + 밝은 끝)
    for (let i = 0; i < 6; i++) {
      const x = 1 + Math.floor(r() * (S - 3));
      const y = 2 + Math.floor(r() * (S - 3));
      px(x, y, '#5a9e48');
      px(x + 2, y, '#5a9e48');
      px(x + 1, y - 1, '#9ad884');
    }
  });
}

function water(seed: number) {
  const r = rng(seed);
  return sprite((px) => {
    px(0, 0, '#4a9fdb', S, S);
    for (let i = 0; i < 4; i++) {
      const x = Math.floor(r() * (S - 4));
      const y = Math.floor(r() * S);
      px(x, y, '#9bd3f2', 3, 1); // 물결
      px(x + 3, y + 1 < S ? y + 1 : y, '#3b86bf', 2, 1);
    }
  });
}

function road(seed: number) {
  return speckled(seed, '#9b9b9b', [
    ['#878787', 12],
    ['#b2b2b2', 6],
  ]);
}

/** 지붕: 기와 줄 무늬 */
function roof(seed: number, base: number) {
  const r = rng(seed);
  const fill = shade(base, 0);
  const line = shade(base, -0.2);
  const light = shade(base, 0.15);
  return sprite((px) => {
    px(0, 0, fill, S, S);
    // 4px마다 어두운 선, 줄마다 이음새 위치를 엇갈리게
    for (let y = 3; y < S; y += 4) {
      px(0, y, line, S, 1);
      const offset = (y / 4) % 2 === 0 ? 0 : 4;
      for (let x = offset; x < S; x += 8) px(x, y - 3, line, 1, 3);
    }
    for (let i = 0; i < 4; i++) px(Math.floor(r() * S), Math.floor(r() * S), light);
  });
}

/** 벽: 창문 한 줄 */
function wall(eaves: boolean, base: boolean, wallColor: number, roofColor: number) {
  return sprite((px) => {
    px(0, 0, shade(wallColor, 0), S, S);
    if (eaves) px(0, 0, shade(roofColor, -0.25), S, 3); // 지붕 끝(처마)
    // 창문 (처마가 있으면 그만큼 아래로)
    const top = eaves ? 6 : 4;
    px(4, top, '#3c4e66', 8, 6);
    px(5, top + 1, '#6f9cc9', 6, 4);
    px(5, top + 1, '#a9cfee', 2, 1);
    px(7, top + 1, '#3c4e66', 1, 4); // 창살
    px(0, S - 1, shade(wallColor, base ? -0.22 : -0.08), S, 1); // 바닥 그림자 / 층 구분선
  });
}

/**
 * 벽 색에서 지붕 색을 만든다. 색 계열(hue)은 유지하고 채도는 높이고 밝기는 중간으로.
 * (어둡게만 하면 밝은 벽 색들이 모두 비슷한 어두운 색이 되어 지붕이 구분되지 않았다)
 * 회색 계열(채도가 아주 낮은 색)은 회색 지붕으로 둔다.
 */
export function roofColorOf(wallColor: number): number {
  const r = ((wallColor >> 16) & 255) / 255;
  const g = ((wallColor >> 8) & 255) / 255;
  const b = (wallColor & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const roofS = s < 0.08 ? 0 : 0.5;
  const roofL = 0.42;
  // HSL → RGB
  const c = (1 - Math.abs(2 * roofL - 1)) * roofS;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = roofL - c / 2;
  const [r1, g1, b1] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const to = (v: number) => Math.round((v + m) * 255);
  return (to(r1) << 16) | (to(g1) << 8) | to(b1);
}

function buildingSet(color: number): BuildingSprites {
  const roofColor = roofColorOf(color);
  const walls = new Map<string, HTMLCanvasElement>();
  return {
    roofs: Array.from({ length: VARIANTS }, (_, i) => roof(5 + i * 7919, roofColor)),
    wall: (eaves, base) => {
      const k = `${eaves}-${base}`;
      let c = walls.get(k);
      if (!c) {
        c = wall(eaves, base, color, roofColor);
        walls.set(k, c);
      }
      return c;
    },
    outline: shade(roofColor, -0.45),
  };
}

const variants = (make: (seed: number) => HTMLCanvasElement, base: number) =>
  Array.from({ length: VARIANTS }, (_, i) => make(base + i * 7919));

/** 도트 타일 그림을 만든다. (외부 이미지 없이 코드로 생성한 원본 그림) */
export function createSprites(): Sprites {
  const buildings = new Map<number, BuildingSprites>();
  return {
    tiles: {
      [TileClass.Ground]: variants(ground, 1),
      [TileClass.Green]: variants(grass, 2),
      [TileClass.Water]: variants(water, 3),
      [TileClass.Road]: variants(road, 4),
      // 건물 칸 자체는 그리지 않고(지붕·벽은 building()으로 그림), 기본값으로만 둔다.
      [TileClass.Building]: variants((seed) => roof(seed, 0xbd5d47), 5),
    },
    building(color) {
      let set = buildings.get(color);
      if (!set) {
        set = buildingSet(color);
        buildings.set(color, set);
      }
      return set;
    },
  };
}

/** 칸 좌표로 변형 번호를 고른다 (같은 칸은 항상 같은 그림) */
export function variantOf(x: number, y: number): number {
  const h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) >>> 0;
  return h % VARIANTS;
}
