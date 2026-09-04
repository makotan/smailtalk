/**
 * `V4-M15-T09` (2) のバンドル記録器(`t18-bundle-size.ts`)の**純粋な部分だけ**の検査。
 *
 * ## 何を踏み、何を踏まないか(誇張しない)
 *
 * - **踏む**: 引数の解釈(`parseArgs`)/ 拡張子から種別への写し(`classifyAsset`)/
 *   1ファイルの大きさ(`measureAsset`。**メモリ上のバイト列に対して掛ける**)/
 *   種別ごとの合計(`summarize`)/ 出力行の形(`formatLines`)。
 * - **踏まない**: **`bun run build:web` を1度も走らせない。** **`web/dist/` を1バイトも読まない。**
 *   したがってこの検査は `bun test`(実 CI の `checks` ジョブ)でそのまま緑になり、遅くもならない
 *   —— 実際の大きさの記録は `t18-bundle-size.ts` の冒頭の表と、そこに書いた手順が正である。
 *   (`t13-tools.test.ts` が「サーバの起動も chromium の起動も1度もしない」のと同じ立場。)
 *
 * **【この検査はバンドルの大きさを1つも判定しない。】** `P-G45` は上限を求めておらず、
 * ここで固定しているのは**記録器が壊れていないこと**だけである。
 */
import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import {
  classifyAsset,
  DEFAULT_DIST_DIR,
  formatLines,
  measureAsset,
  parseArgs,
  summarize,
} from "./t18-bundle-size.ts";

describe("t18-bundle-size の引数", () => {
  test("--label と --out-dir で既定値がそろう", () => {
    const options = parseArgs(["--label", "after", "--out-dir", "tmp/out"]);
    expect(options.label).toBe("after");
    expect(options.distDir).toBe(DEFAULT_DIST_DIR);
    expect(options.outDir).toBe("tmp/out");
    expect(options.write).toBe(true);
  });

  /**
   * **`V9-M3-T01`(群D)。読む先は公開単位の中、書く先は名指しに変えた。**
   *
   * - `DEFAULT_DIST_DIR`: 旧 `web/dist/assets`。**`V9-M1` が `web/` を
   *   `apps/smailtalk/web/` へ移した**ので、正本のルートを cwd にして走らせると
   *   「読めません」で落ちていた(`package.json` の `bundle-size` は正本のルートから走る)。
   * - `DEFAULT_OUT_DIR`: 撤去した。**`docs/` は公開単位の外に残る。**
   *   書き先を黙って器の外に決めない。
   */
  test("既定の読み先は公開単位の中(apps/smailtalk/web)を指す", () => {
    expect(DEFAULT_DIST_DIR).toBe("apps/smailtalk/web/dist/assets");
  });

  test("--label が無ければ落ちる(どの時点の値か分からない記録を残さない)", () => {
    expect(() => parseArgs(["--out-dir", "tmp/out"])).toThrow();
  });

  test("書くのに --out-dir が無ければ落ちる(公開単位の外へ黙って書かない)", () => {
    expect(() => parseArgs(["--label", "after"])).toThrow();
  });

  test("--no-write なら --out-dir は要らない(1バイトも書かないため)", () => {
    const options = parseArgs(["--label", "after", "--no-write"]);
    expect(options.write).toBe(false);
    expect(options.outDir).toBeUndefined();
  });

  test("知らない引数は落ちる(綴り間違いを黙って無視しない)", () => {
    expect(() => parseArgs(["--label", "after", "--out-dir", "tmp/out", "--labels"])).toThrow();
  });

  test("値を取る引数に値が無ければ落ちる", () => {
    expect(() => parseArgs(["--label"])).toThrow();
    expect(() => parseArgs(["--label", "after", "--dist-dir"])).toThrow();
    expect(() => parseArgs(["--label", "after", "--out-dir"])).toThrow();
  });

  test("--dist-dir / --out-dir / --no-write を受ける", () => {
    const options = parseArgs([
      "--label",
      "before",
      "--dist-dir",
      "tmp/assets",
      "--out-dir",
      "tmp/out",
      "--no-write",
    ]);
    expect(options.distDir).toBe("tmp/assets");
    expect(options.outDir).toBe("tmp/out");
    expect(options.write).toBe(false);
  });
});

describe("拡張子から種別への写し", () => {
  test("JS と CSS を拾う", () => {
    expect(classifyAsset("index-Wr4yBsit.js")).toBe("js");
    expect(classifyAsset("index-C9ga_GCQ.css")).toBe("css");
    expect(classifyAsset("chunk.mjs")).toBe("js");
    expect(classifyAsset("chunk.cjs")).toBe("js");
  });

  test("`.map` は JS に数えない(配信されないため)", () => {
    expect(classifyAsset("index.js.map")).toBe("other");
    expect(classifyAsset("index.css.map")).toBe("other");
  });

  test("画像・フォントは `other`", () => {
    expect(classifyAsset("logo.svg")).toBe("other");
    expect(classifyAsset("inter.woff2")).toBe("other");
  });

  test("大文字の拡張子でも拾う", () => {
    expect(classifyAsset("INDEX.JS")).toBe("js");
  });
});

describe("1ファイルの大きさ", () => {
  test("生バイト数はそのままの長さで、gzip は `node:zlib` の既定と一致する", () => {
    // 圧縮の効く中身を使う(同じ文字の繰り返しでは raw < gzip になり、比較の意味が薄れる)。
    const body = Buffer.from(`body{color:#000}`.repeat(500), "utf-8");
    const asset = measureAsset("index-abc.css", body);
    expect(asset.name).toBe("index-abc.css");
    expect(asset.kind).toBe("css");
    expect(asset.rawBytes).toBe(body.byteLength);
    // **記録器が使うのは既定の圧縮率である**(`level: 9` ではない)。
    // vite が build 後に報告する gzip 値と同じ既定であることを、ここで固定している。
    expect(asset.gzipBytes).toBe(gzipSync(body).byteLength);
    expect(asset.gzipBytes).not.toBe(gzipSync(body, { level: 9 }).byteLength);
  });

  test("空ファイルでも落ちない(0 を 0 として記録する)", () => {
    const asset = measureAsset("empty.js", new Uint8Array(0));
    expect(asset.rawBytes).toBe(0);
    expect(asset.gzipBytes).toBeGreaterThan(0); // gzip のヘッダぶん
  });
});

// --- 集計 -----------------------------------------------------------------------

const SAMPLE = [
  { name: "index.js", kind: "js" as const, rawBytes: 329_717, gzipBytes: 98_725 },
  { name: "extra.js", kind: "js" as const, rawBytes: 1_000, gzipBytes: 500 },
  { name: "index.css", kind: "css" as const, rawBytes: 21_475, gzipBytes: 5_174 },
  { name: "logo.svg", kind: "other" as const, rawBytes: 900, gzipBytes: 400 },
];

describe("種別ごとの合計(判定はしない)", () => {
  test("JS と CSS を別に数え、合計は JS + CSS である", () => {
    const totals = summarize(SAMPLE);
    expect(totals.js).toEqual({ files: 2, rawBytes: 330_717, gzipBytes: 99_225 });
    expect(totals.css).toEqual({ files: 1, rawBytes: 21_475, gzipBytes: 5_174 });
    expect(totals.total).toEqual({ files: 3, rawBytes: 352_192, gzipBytes: 104_399 });
  });

  test("`other` は数えるが合計に混ぜない", () => {
    const totals = summarize(SAMPLE);
    expect(totals.other).toEqual({ files: 1, rawBytes: 900, gzipBytes: 400 });
    expect(totals.total.rawBytes).toBe(totals.js.rawBytes + totals.css.rawBytes);
    expect(totals.total.gzipBytes).toBe(totals.js.gzipBytes + totals.css.gzipBytes);
  });

  test("0件でも落ちずに0を返す", () => {
    expect(summarize([]).total).toEqual({ files: 0, rawBytes: 0, gzipBytes: 0 });
  });
});

describe("出力の形", () => {
  test("バイト数を丸めない(kB に直さない)", () => {
    const lines = formatLines(SAMPLE, summarize(SAMPLE));
    expect(lines.join("\n")).toContain("329,717 B");
    expect(lines.join("\n")).toContain("gzip=98,725 B");
    // **kB に直した値は1つも出さない。**
    expect(lines.join("\n")).not.toContain("kB");
  });

  test("合計の行に「上限は設けない」と書いてある(`P-G45` の要求はそこではない)", () => {
    const lines = formatLines(SAMPLE, summarize(SAMPLE));
    const last = lines.at(-1) ?? "";
    expect(last).toContain("上限は設けない");
    expect(last).toContain("352,192 B");
  });
});

describe("この記録器が合否を1つも判定しないこと", () => {
  test("どんなに大きくても例外を投げず、真偽値も返さない", () => {
    // **1 GB でも記録するだけである。** ここが赤くなったら、上限が入り込んだということ。
    const huge = [{ name: "index.js", kind: "js" as const, rawBytes: 1e9, gzipBytes: 3e8 }];
    const totals = summarize(huge);
    expect(totals.total.rawBytes).toBe(1e9);
    expect(() => formatLines(huge, totals)).not.toThrow();
    // 返り値に合否を表す項目が1つも無いこと。
    expect(Object.keys(totals.total).sort()).toEqual(["files", "gzipBytes", "rawBytes"]);
  });
});
