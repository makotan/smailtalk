/**
 * **重ね順の段が2つだけであることの検査**(`V4-M18-T02`。`ADR-0094` 限定4)。
 *
 * ## 限定4 の逐語(`docs/adr/0094-overlay-container.md:110`)
 *
 * > **重ね順の段は2つだけ** | **生成側の入口(`web/src/tailwind.css`)に定義する重ね順は
 * > 2段だけ。** **3段目を作らない。** **`z-index` の生の数値をレンダラーのソースに
 * > 書かない**(段の名前だけを使う) | **段の本数を数える検査を新設する**
 * > (`V4-M18-T02`)。**3段目を足したら赤**
 *
 * ## この検査が守るもの / 守らないもの(**先に書く。憲法6**)
 *
 * - **守る**: 段の本数(2)。段の名前(2つの逐語)。レンダラーのソースに `z-index` の
 *   **生の数値**が現れないこと。**手で書く CSS(`web/src/styles.css`)に `z-index` が
 *   1つも無いこと**(`ADR-0094` 限定3。**`preset-boundary.test.ts:188` の (ii) を
 *   1バイトも書き換えていない** —— 本検査はその独立した二重掛けである)。
 * - **守らない**: **実際にどちらが上に描かれるか。** それは CSS の計算であり、
 *   ここは happy-dom ですらないテキスト検査である。**chromium の実測は
 *   `web/e2e/overlay.e2e.ts` が採る。**
 * - **守らない**: **`position` を使わないこと。** **使う** ——
 *   **`ADR-0094` 限定3 が禁じているのは「手で書く CSS」だけであり、器の実装は
 *   座標系プロパティを使う**(`ADR-0087` §3 の総括の禁止7)。
 *   **【禁止】「9プロパティの禁止を守ったまま器を作った」と書かない。**
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const WEB_SRC = join(dirname(import.meta.dir), "src");

function readSource(name: string): string {
  return readFileSync(join(WEB_SRC, name), "utf8");
}

/** 段は2つだけである。**3つ目をここに足したら、それは限定4 を破ることである。** */
const LAYERS: readonly string[] = Object.freeze(["--layer-overlay", "--layer-notice"]);

test("(T02-1) 生成側の入口が定義する重ね順の段は、ちょうど2つである", () => {
  const body = readSource("tailwind.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const declared = [...body.matchAll(/--layer-[a-z0-9-]+/g)].map((match) => match[0]);
  // **重複を潰さずに数える** —— 同じ名前を2回書いて「2段」に見せかけられないようにする。
  expect(declared).toHaveLength(2);
  expect([...declared].sort()).toEqual([...LAYERS].sort());
});

test("(T02-2) 段の値は素の整数であり、色でも `var()` でもない", () => {
  const body = readSource("tailwind.css").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const layer of LAYERS) {
    const match = new RegExp(`${layer}:\\s*([^;]+);`).exec(body);
    expect(match, layer).not.toBeNull();
    expect(/^[0-9]+$/.test((match?.[1] ?? "").trim()), layer).toBe(true);
  }
});

test("(T02-3) 手で書く CSS に z-index が1つも無い(限定3 を1バイトも緩めていない)", () => {
  expect(readSource("styles.css").includes("z-index")).toBe(false);
});

test("(T02-4) レンダラーのソースに `z-index` の生の数値が1つも無い", () => {
  // `z-10` / `z-50` / `z-[100]` / `zIndex: 100` のいずれも書かない。書けるのは段の名前だけ。
  const sources = collectSources(WEB_SRC);
  const offenders: string[] = [];
  for (const [path, body] of sources) {
    const stripped = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    if (/\bz-\[?-?[0-9]/.test(stripped) || /\bzIndex\b/.test(stripped)) {
      offenders.push(path);
    }
  }
  expect(offenders).toEqual([]);
});

/**
 * **「2段とも当たり先を持つ」ことの検査は `web/test/overlay.test.tsx` の (T01-6) が持つ。**
 * **当たり先(器)は `V4-M18-T01` が作るので、検査もそちらに置いた** ——
 * ここに置くと `T02` のコミット時点で当たり先が実在せず、赤いまま積むことになる。
 */

function collectSources(dir: string): [string, string][] {
  const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
  const out: [string, string][] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectSources(full));
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      out.push([full, readFileSync(full, "utf8")]);
    }
  }
  return out;
}
