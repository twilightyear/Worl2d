import { TileClass } from '../map/tileClass';

/** 도트 타일 한 장의 픽셀 크기 */
export const SPRITE_PX = 16;

/** 칸 종류별 변형 그림 개수 (같은 종류도 칸마다 무늬를 조금씩 다르게) */
const VARIANTS = 4;

export type Sprites = {
  tiles: Record<TileClass, HTMLCanvasElement[]>;
  /** 남쪽이 건물이 아닌 건물 칸: 지붕 끝 + 창문 있는 벽 */
  wall: HTMLCanvasElement;
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

function roof(seed: number) {
  const r = rng(seed);
  return sprite((px) => {
    px(0, 0, '#bd5d47', S, S);
    // 기와 줄: 4px마다 어두운 선, 줄마다 이음새 위치를 엇갈리게
    for (let y = 3; y < S; y += 4) {
      px(0, y, '#9c4836', S, 1);
      const offset = (y / 4) % 2 === 0 ? 0 : 4;
      for (let x = offset; x < S; x += 8) px(x, y - 3, '#9c4836', 1, 3);
    }
    for (let i = 0; i < 4; i++) px(Math.floor(r() * S), Math.floor(r() * S), '#d4806a');
  });
}

function wall() {
  return sprite((px) => {
    px(0, 0, '#8c3e2f', S, 3); // 지붕 끝(처마)
    px(0, 3, '#e6dcc8', S, S - 3); // 벽
    // 창문
    px(4, 6, '#3c4e66', 8, 6);
    px(5, 7, '#6f9cc9', 6, 4);
    px(5, 7, '#a9cfee', 2, 1);
    px(7, 7, '#3c4e66', 1, 4); // 창살
    px(0, S - 1, '#b6a68c', S, 1); // 벽 아래 그림자
  });
}

const variants = (make: (seed: number) => HTMLCanvasElement, base: number) =>
  Array.from({ length: VARIANTS }, (_, i) => make(base + i * 7919));

/** 도트 타일 그림을 만든다. (외부 이미지 없이 코드로 생성한 원본 그림) */
export function createSprites(): Sprites {
  return {
    tiles: {
      [TileClass.Ground]: variants(ground, 1),
      [TileClass.Green]: variants(grass, 2),
      [TileClass.Water]: variants(water, 3),
      [TileClass.Road]: variants(road, 4),
      [TileClass.Building]: variants(roof, 5),
    },
    wall: wall(),
  };
}

/** 칸 좌표로 변형 번호를 고른다 (같은 칸은 항상 같은 그림) */
export function variantOf(x: number, y: number): number {
  const h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) >>> 0;
  return h % VARIANTS;
}
