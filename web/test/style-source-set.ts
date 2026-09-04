/**
 * **配られる CSS の集合の定義**(`V4-M15-T02`。`ADR-0088` 限定2 / 限定5 / 限定6)。
 *
 * ## なぜファイル名1つではなくなったのか
 *
 * **2026-08-03 の着手前まで、CSS を見る検査は `web/src/styles.css` という
 * 1本のファイル名を直接読んでいた**(`web/test/styles.test.ts` の `STYLES_PATH` と
 * `web/test/preset-boundary.test.ts` の (ii) 4本)。**したがって「別のファイルに書けば
 * 今日の検査に当たらない」は、`ADR-0088` の判定を待たずに成立していた**
 * (`ADR-0088` §Context 2)。
 *
 * **`ADR-0088` 限定2 は、この穴を塞ぐことを義務として課した** —— 逐語
 * 「**検査が集合の定義そのものを持つ。集合は「ビルド出力に含まれる CSS のうち、
 * この製品のソースに由来するもの」を漏れなく含む。集合の外に CSS を置けないことを、
 * 検査自身が示す** —— 「このファイルを読む」ではなく「この集合を読み、集合が全量で
 * あることを確かめる」形にする」。
 *
 * **本ファイルが集合の定義であり、`web/test/style-sources.test.ts` が全量性を示す。**
 *
 * ## 手で書く側 と 生成された側(`ADR-0088` 限定5)
 *
 * **完全一致固定(`styles.test.ts` の (a))の対象は「手で書く規則」だけに絞る。**
 * **生成物を完全一致固定の対象にしない。** —— **これは固定の射程が縮むことである。**
 * **【正直に書く】縮んだ。** 部品体系のビルド出力は数千行あり、版を上げるたびに全部
 * 変わるので、宣言の完全一致で押さえることは現実的でない。**代わりに生成側には
 * 「何が出てはいけないか」の検査だけを掛ける**(`style-sources.test.ts`)。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

/** `web/src` の絶対パス。 */
export const WEB_SRC_DIR = join(dirname(import.meta.dir), "src");

/** 集合の1要素。 */
export type StyleSource = {
  /** `web/src` からの相対パス(POSIX 区切り)。 */
  readonly path: string;
  /**
   * `handwritten` = 人が1行ずつ書く。宣言の完全一致固定の対象(`ADR-0088` 限定5)。
   * `generated` = 部品体系のビルド出力の入口。完全一致固定の対象にしない。
   */
  readonly kind: "handwritten" | "generated";
  /** 冒頭宣言に必ず含まれる逐語(`ADR-0088` 限定4)。 */
  readonly headerMarker: string;
};

/**
 * **配られる CSS の集合(2本)**(`ADR-0088` 限定6 が実数の記録を求める)。
 *
 * **着手前は1本、着手後は2本である。**
 */
export const STYLE_SOURCES: readonly StyleSource[] = Object.freeze([
  Object.freeze({
    path: "styles.css",
    kind: "handwritten",
    headerMarker: "足してよいのは5つだけである",
  }),
  Object.freeze({
    path: "tailwind.css",
    kind: "generated",
    headerMarker: "ここに何を書いてよいか",
  }),
] as const);

export const HANDWRITTEN_SOURCES = STYLE_SOURCES.filter((source) => source.kind === "handwritten");

export function styleSourcePath(source: StyleSource): string {
  return join(WEB_SRC_DIR, ...source.path.split("/"));
}

export function readStyleSource(source: StyleSource): string {
  return readFileSync(styleSourcePath(source), "utf-8");
}

/**
 * `web/src` 配下に実在する CSS ファイルを**全部**列挙する(再帰)。
 *
 * **集合の全量性はこの関数と `STYLE_SOURCES` の突合で示す** —— 新しい CSS を
 * `web/src` のどこに置いても、`STYLE_SOURCES` に足さない限り検査が赤くなる。
 */
export function discoverCssFiles(dir: string = WEB_SRC_DIR): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...discoverCssFiles(full));
    } else if (entry.endsWith(".css")) {
      out.push(relative(WEB_SRC_DIR, full).split(sep).join("/"));
    }
  }
  return out.sort();
}

/** `web/src` 配下の TypeScript / TSX を全部列挙する(再帰)。 */
export function discoverSourceFiles(dir: string = WEB_SRC_DIR): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...discoverSourceFiles(full));
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out.sort();
}
