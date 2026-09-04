/**
 * `fixtures/theme-import/screenshot.png` の生成器(V3-M6-T01 / D-G9)。
 *
 * ## なぜ生成器を置くのか
 *
 * 完了条件1 は資産2種を **git 管理下に入れる**ことを求めている(CI で形が再現できるように
 * するため)。バイナリを1枚コミットするだけだと、**中身が本当にその配色なのかを後世が
 * 検算できない。** そこで **PNG を自前で組み立てる小さな生成器**を横に置き、
 * `web/test/theme-import.test.ts` が「コミットされた PNG が生成器の出力とバイト単位で
 * 一致する」ことと「画素の中に資産の9色が実在する」ことの両方を確かめる。
 *
 * ## 新しい依存パッケージを1つも足さない
 *
 * 使うのは `node:zlib` だけである(Node 互換 API。`package.json` は1バイトも動かない)。
 * **フィルタ無し(各走査線の先頭バイトが 0)・パレット無し(色種別 2 = truecolor)・
 * 8bit・非インタレース**の最も単純な PNG しか書かないので、読む側は
 * `zlib.inflateSync` だけで画素へ戻せる。
 *
 * ## これは何の画像なのか(誇張しない)
 *
 * **架空の組織「ハシバミ製作所」の受注画面のワイヤーフレーム**である。文字は1文字も
 * 描いていない —— 描いてあるのは**色の面**だけで、「配色が読み取れる」以上のことは
 * 主張しない。**実在の製品のスクリーンショットではない。**
 *
 * ## 作り直し方
 *
 *     bun run fixtures/theme-import/screenshot.gen.ts
 *
 * 出力は決定論的である(時刻・乱数を1つも使わない)。
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

export const SCREENSHOT_WIDTH = 96;
export const SCREENSHOT_HEIGHT = 64;

/** 地色。ページ全体を塗る。 */
export const SCREENSHOT_BACKGROUND = "#fffdf8";

export type MockupBlock = {
  /** 何を表している面なのか(人間のための注記)。 */
  readonly note: string;
  /** `#rrggbb`。 */
  readonly color: string;
  readonly x0: number;
  readonly y0: number;
  /** 右端・下端を含む。 */
  readonly x1: number;
  readonly y1: number;
};

/**
 * 受注画面のワイヤーフレーム。**上から順に**: 見出し帯 → 区切り線 → 画面名 →
 * 項目名 → 本文 → 未入力の案内文 → エラー文 → フォーカス中のボタン。
 */
export const MOCKUP_BLOCKS: readonly MockupBlock[] = Object.freeze([
  Object.freeze({ note: "見出し帯(強調された面)", color: "#eef2ea", x0: 0, y0: 0, x1: 95, y1: 7 }),
  Object.freeze({ note: "見出しの下の区切り線", color: "#6b7a70", x0: 0, y0: 8, x1: 95, y1: 8 }),
  Object.freeze({ note: "画面名(本文の文字色)", color: "#14281d", x0: 8, y0: 14, x1: 47, y1: 21 }),
  Object.freeze({ note: "項目名", color: "#33443a", x0: 8, y0: 26, x1: 31, y1: 29 }),
  Object.freeze({ note: "補助的な説明文", color: "#405146", x0: 8, y0: 32, x1: 87, y1: 35 }),
  Object.freeze({ note: "未入力時の案内文", color: "#4d5e53", x0: 8, y0: 38, x1: 63, y1: 41 }),
  Object.freeze({ note: "エラー文", color: "#8c1d18", x0: 8, y0: 46, x1: 55, y1: 49 }),
  Object.freeze({
    note: "フォーカス中のボタンのリング",
    color: "#1a5fb4",
    x0: 8,
    y0: 54,
    x1: 39,
    y1: 59,
  }),
]);

function hexToRgb(hex: string): readonly [number, number, number] {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (match === null) {
    throw new Error(`#rrggbb ではない色: ${hex}`);
  }
  return [
    Number.parseInt(match[1] ?? "0", 16),
    Number.parseInt(match[2] ?? "0", 16),
    Number.parseInt(match[3] ?? "0", 16),
  ];
}

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = ((CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) {
    out[4 + i] = type.charCodeAt(i);
  }
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** ワイヤーフレームの画素(RGB × 幅 × 高さ)。 */
export function buildScreenshotPixels(): Uint8Array {
  const pixels = new Uint8Array(SCREENSHOT_WIDTH * SCREENSHOT_HEIGHT * 3);
  const base = hexToRgb(SCREENSHOT_BACKGROUND);
  for (let i = 0; i < SCREENSHOT_WIDTH * SCREENSHOT_HEIGHT; i += 1) {
    pixels[i * 3] = base[0];
    pixels[i * 3 + 1] = base[1];
    pixels[i * 3 + 2] = base[2];
  }
  for (const block of MOCKUP_BLOCKS) {
    const [r, g, b] = hexToRgb(block.color);
    for (let y = block.y0; y <= block.y1; y += 1) {
      for (let x = block.x0; x <= block.x1; x += 1) {
        const offset = (y * SCREENSHOT_WIDTH + x) * 3;
        pixels[offset] = r;
        pixels[offset + 1] = g;
        pixels[offset + 2] = b;
      }
    }
  }
  return pixels;
}

/** PNG のバイト列。**決定論的である**(時刻も乱数も使わない)。 */
export function buildScreenshotPng(): Uint8Array {
  const pixels = buildScreenshotPixels();
  const stride = SCREENSHOT_WIDTH * 3;
  // 各走査線の先頭に**フィルタ 0(None)**を置く。これが「読み直せる」ことの条件である。
  const raw = new Uint8Array(SCREENSHOT_HEIGHT * (stride + 1));
  for (let y = 0; y < SCREENSHOT_HEIGHT; y += 1) {
    raw[y * (stride + 1)] = 0;
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, SCREENSHOT_WIDTH);
  view.setUint32(4, SCREENSHOT_HEIGHT);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type 2 = truecolor(**パレットを使わない**)
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace

  const signature = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const idat = Uint8Array.from(deflateSync(raw, { level: 9 }));
  const parts = [signature, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

if (import.meta.main) {
  const path = join(import.meta.dir, "screenshot.png");
  writeFileSync(path, buildScreenshotPng());
  process.stdout.write(`${path} を書き出した(${String(buildScreenshotPng().length)} バイト)\n`);
}
