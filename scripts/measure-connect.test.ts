/**
 * `V17-M0-T01a`: **実測台 `measure-connect.ts` 自身を撃つ検査。**
 *
 * 上位: `docs/plan/v17/01-v17-m0-plan.md` §6 の `V17-M0-T01a` 行 /
 *       `ADR-0412` §95(「接続直後の余白は今日 **1文字**である」の実測がこの台で取られた)。
 *
 * ## なぜ要るのか
 *
 * `ADR-0410:106` と `ADR-0412:95` は、**`measureAtConnect()` を「複製して打った」**
 * 使い捨てのスクリプト(scratchpad の `v16-m0/measure-connect.ts`)で実測を取っている。
 * **その台は今日ディスク上に無く、どの検査も撃っていない。**
 * 台そのものが壊れても誰も気づかないので、**台を検査の中から呼べる形にして撃つ。**
 *
 * ## この検査が撃つもの ——— **式の整合だけ**
 *
 * **今日の実測値(合計 151,999 / 余白 1 / 道具 26本 ほか)を1つも焼き込んでいない。**
 * 値は説明文を1文字足すたびに動くので、焼き込むと**この検査が「触るな」の意味になる**
 * (`mcp-description-size.test.ts` の doc コメント「今日の実測ぴったりにしない」と同じ向き)。
 * 撃つのは次の3種の**式**である:
 *
 * 1. **合計 = `instructions` + `tools/list`**
 * 2. **道具ごとの内訳の合計が `tools/list` の長さを超えない**(内訳は同じ JSON の部分集合である)
 * 3. **余白 = 上限 − 合計**
 *
 * ## この検査がしないこと(先に書く)
 *
 * - **スクリプトを子プロセスで起動していない。** 測る関数を `export` して直接呼んでいる
 *   (`V17-M0-T01a` の完了条件3 の逐語)。**したがって「端末で打ったときに 0 で終わるか」は
 *   この検査では担保していない** —— それは実施記録に貼った実出力の側で担保する。
 * - **上限 `CONNECT_TOTAL_MAX` の値が妥当かを判定しない。** 定数の所在は `measure-connect.ts`
 *   の1箇所だけであり(下の `(mc5)`)、この検査はその1箇所から読んだ値で式を組み立てる。
 */

import { expect, test } from "bun:test";
import {
  CONNECT_TOTAL_MAX,
  type ConnectMeasurement,
  formatReport,
  measureConnect,
} from "./measure-connect.ts";

/** 測るのは1度でよい(接続を張るので毎回やると遅い)。 */
let cached: ConnectMeasurement | null = null;
async function measured(): Promise<ConnectMeasurement> {
  if (cached === null) cached = await measureConnect();
  return cached;
}

// --- (mc1) 合計 = instructions + tools/list ---

test("(mc1) 合計は instructions と tools/list の和である", async () => {
  const m = await measured();
  expect(m.total).toBe(m.instructionsLength + m.toolsListJsonLength);
  // **どちらも空でない。** 0 なら「測れていない」であって「短くなった」ではない。
  expect(m.instructionsLength).toBeGreaterThan(0);
  expect(m.toolsListJsonLength).toBeGreaterThan(0);
});

// --- (mc2) 道具の内訳 ---

test("(mc2) 内訳の本数が道具の本数と一致する", async () => {
  const m = await measured();
  expect(m.tools.length).toBe(m.toolCount);
  expect(m.toolCount).toBeGreaterThan(0);
});

test("(mc2b) 内訳の JSON 長の合計が tools/list の長さを超えない", async () => {
  const m = await measured();
  const sum = m.tools.reduce((acc, tool) => acc + tool.jsonLength, 0);
  expect(
    sum,
    `内訳の合計 ${sum} が tools/list の ${m.toolsListJsonLength} を超えた(内訳は同じ JSON の部分集合のはずである)`,
  ).toBeLessThanOrEqual(m.toolsListJsonLength);
});

test("(mc2c) 1本の中の description と inputSchema は、その1本の JSON より長くならない", async () => {
  const m = await measured();
  for (const tool of m.tools) {
    expect(tool.descriptionLength, `${tool.name} の description`).toBeLessThanOrEqual(
      tool.jsonLength,
    );
    expect(tool.inputSchemaJsonLength, `${tool.name} の inputSchema`).toBeLessThanOrEqual(
      tool.jsonLength,
    );
    expect(tool.name.length).toBeGreaterThan(0);
  }
});

test("(mc2d) 内訳は JSON 長の長い順に並んでいる", async () => {
  const m = await measured();
  for (let i = 1; i < m.tools.length; i += 1) {
    const previous = m.tools[i - 1];
    const current = m.tools[i];
    if (previous === undefined || current === undefined) continue;
    expect(
      previous.jsonLength,
      `${previous.name}(${previous.jsonLength})が ${current.name}(${current.jsonLength})より前に在る`,
    ).toBeGreaterThanOrEqual(current.jsonLength);
  }
});

// --- (mc3) 余白 = 上限 − 合計 ---

test("(mc3) 余白は上限から合計を引いた値である", async () => {
  const m = await measured();
  expect(m.margin).toBe(CONNECT_TOTAL_MAX - m.total);
  expect(m.limit).toBe(CONNECT_TOTAL_MAX);
});

// --- (mc4) resources ---

test("(mc4) resources の件数と JSON 長が対応している", async () => {
  const m = await measured();
  expect(m.resourceCount).toBeGreaterThanOrEqual(0);
  expect(m.resourcesListJsonLength).toBeGreaterThan(0); // 空でも `{"resources":[]}` の長さは在る
  // **件数が 0 なら、JSON は空配列を包んだ長さそのものである**(今日はここを通る)。
  if (m.resourceCount === 0) {
    expect(m.resourcesListJsonLength).toBe(JSON.stringify({ resources: [] }).length);
  }
});

// --- (mc5) 上限の定数を2箇所に焼き込んでいない ---

test("(mc5) CONNECT_TOTAL_MAX の定義は measure-connect.ts の1箇所だけである", async () => {
  const here = await Bun.file(new URL("./measure-connect.ts", import.meta.url)).text();
  const there = await Bun.file(new URL("./mcp-description-size.test.ts", import.meta.url)).text();
  // 定義(`= <数字>`)の側だけを数える。参照(`CONNECT_TOTAL_MAX` の綴り)は何箇所在ってもよい。
  const definition = /CONNECT_TOTAL_MAX\s*=\s*\d/g;
  expect(here.match(definition)?.length ?? 0).toBe(1);
  expect(there.match(definition)?.length ?? 0).toBe(0);
});

// --- (mc6) 共通部 ---

test("(mc6) 共通部の長さを測っている", async () => {
  const m = await measured();
  expect(m.sharedPreambleLength).toBeGreaterThan(0);
  // 共通部は**全道具に貼られる**ので、`tools/list` 全体より短い。
  expect(m.sharedPreambleLength).toBeLessThan(m.toolsListJsonLength);
});

// --- (mc7) 印字が1〜6 をすべて含む ---

test("(mc7) 印字は 1〜6 の6項目をすべて持つ", async () => {
  const report = formatReport(await measured());
  for (const label of [
    "instructions",
    "tools/list",
    "total",
    "margin",
    "resources/list",
    "describeTool",
  ]) {
    expect(report, `印字に ${label} が無い`).toContain(label);
  }
  // 内訳は道具の本数ぶんの行を持つ。
  const m = await measured();
  for (const tool of m.tools) {
    expect(report, `印字に ${tool.name} の行が無い`).toContain(tool.name);
  }
});
