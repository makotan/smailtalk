/**
 * SQ-M5: **一本化によって観測できる結果が変わった点を、変わった後の値で固定する。**
 *
 * ## この検査が在る理由
 *
 * SQ-M4 までで、システムテーブル(`_apps` / `_changelog` / `_ai_usage`)の絞り込み・
 * 並べ替え・ページ送りは `records.ts` の SQL 1本になった。**それまでは JS で書いた
 * 2つ目の実装が別にあり、同じ宣言が指す表によって違う意味に解釈されていた。**
 * 一本化で**観測できる結果が変わった点**は、次の4つである(いずれもユーザ表の側へ揃った):
 *
 * | 変わったこと | 一本化の前 | 今日 |
 * |---|---|---|
 * | `not` の中で対象列が未記入の行 | **残った** | **落ちる**(SQL の三値論理) |
 * | `equals: null` | **未記入に一致した**(事実上の `is_null`) | **0件**(`ADR-0043` 限定1 に沿う) |
 * | BMP 外文字の並び | UTF-16 符号単位順 | **UTF-8 バイト順**(SQLite の BINARY) |
 * | 絞り込みと合計欄を同時に間違えたとき | 指摘が**1件**しか返らなかった | **両方返る** |
 *
 * **ここに書いた期待値は、すべて実際に走らせて出た値である**(「たぶんこうなるはず」で
 * 書いた値は1つも無い)。
 *
 * ## #6(2つの経路を本当に突き合わせる)の書き方について
 *
 * **`readRecordList` にユーザ表IDを渡しても SQL 経路へ委譲されるだけで、
 * 「2つを比べた」ことにはならない。** `read-records.test.ts` の
 * 「SQL 経路とメモリ経路が同一入力で同一結果を返す(books)」が**まさにその罠**に落ちており
 * (両側とも SQL 経路だった)、それが今回の一本化の発端である。
 * **したがってこのファイルは、片側を必ずシステムテーブルにし、もう片側に
 * 「同じ値を持つユーザ表」を実際に作って流す。**
 *
 * ## 既定順について(ユーザ決定1)
 *
 * **既定の並びは今日のまま保つ。** 3表とも既定順は `_id` ではなく
 * `defaultOrderBy`(`_apps` は `created_at`+`ledger_seq`、`_changelog` は `seq`、
 * `_ai_usage` は `called_at`+`id`)で組み立てているので、**`_id` をどう出そうと
 * 既定順は1件も動かない**(#5 / #9 が固定する)。
 *
 * ## `_id` について —— **「代償を受け入れる」から「代償が要らなかった」へ**
 *
 * このファイルは最初、`_changelog._id` に `CAST(... AS TEXT)` を**入れずに**書かれ、
 * その代償(`_id = "05"` / `" 5"` が seq=5 に一致してしまう)を #7 で固定していた。
 * **理由は「CAST を入れると既定順が 1,10,2… に変わるから」だったが、実測で否定された** ——
 * 既定順は `seq` で組み立てているので `CAST` とは無関係だった(上記)。
 *
 * 根拠が消えたので、**一本化の前(`566d925`)を実際に走らせて測り直した**:
 *
 * | `_changelog` への宣言 | 一本化の前 | `CAST` 無し | `CAST` 有り(今日) | ユーザ表(UUID) |
 * |---|---|---|---|---|
 * | 既定順(`sort` 未指定) | `1,2,3…10,11` | `1,2,3…10,11` | `1,2,3…10,11` | ― |
 * | `sort:{field:"_id",order:"asc"}` | `1,10,11,2…9` | **`1,2,3…10,11`** | `1,10,11,2…9` | 文字列順 |
 * | `readRecord("5")` | `d-005` | `d-005` | `d-005` | ― |
 * | `readRecord("05")` / `" 5"` / `"5.0"` / `"+5"` | **`null`** | **`d-005`** | **`null`** | ― |
 *
 * **`CAST` 無しだけが、一本化の前ともユーザ表とも違っていた。** `_id` は語彙の上では
 * 必ず文字列であり、ユーザ表では UUID の TEXT である —— `CAST` を落とすと `_changelog`
 * だけが INTEGER のまま数値順に並び、**「同じ宣言が指す表によって違う意味になる」という、
 * 一本化がまさに消しに来たものが `_id` に残っていた。** よって `CAST` を入れた。
 * **代償(#7)は受け入れる必要が無かったので、無くなった。**
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiCapabilityStore } from "./ai-capability-store.ts";
import { applyManifestDdl } from "./ddl.ts";
import type { ValidationError } from "./errors.ts";
import { KernelMetaStore } from "./meta-store.ts";
import {
  type ReadSource,
  readRecord,
  readRecordCountAndSum,
  readRecordList,
} from "./read-records.ts";
import { createRecord, type ListRecordsOptions, type RecordRow } from "./records.ts";
import { computeReport } from "./report.ts";
import type {
  FilterCondition,
  FilterNode,
  Manifest,
  ReportDeclaration,
  ReportView,
} from "./types.ts";

// =====================================================================================
// 題材
//
// **システムテーブル3本と、同じ値を持つユーザ表3本を1つの題材から作る。**
// **値の写しを2箇所に書かない** —— 下の3つの配列だけが値の出どころであり、
// システム側(`KernelMetaStore` / `AiCapabilityStore`)とユーザ側(`createRecord`)は
// どちらも同じ配列を読む。**片側だけ書き換えて「一致した」と言えないようにするため。**
// =====================================================================================

/**
 * アプリ5件。
 *
 * - `name` は **BMP 外文字の並びを測るため**に選んである
 *   (`A` = U+0041 / `Ａ` = U+FF21 / `𠮷` = U+20BB7)。
 * - **`twin-one` と `twin-two` は `created_at` が同値である**(#8 の題材)。
 *   登録の順が `ledger_seq` になるので、既定順の前後はこの配列の順で決まる。
 */
const APPS = [
  { app_id: "app-a", name: "A", created_at: "2026-08-01T00:00:00.000Z" },
  { app_id: "app-zen-a", name: "Ａ", created_at: "2026-08-02T00:00:00.000Z" },
  { app_id: "app-kichi", name: "𠮷", created_at: "2026-08-03T00:00:00.000Z" },
  { app_id: "twin-one", name: "𠮷 その1", created_at: "2026-08-04T00:00:00.000Z" },
  { app_id: "twin-two", name: "𠮷 その2", created_at: "2026-08-04T00:00:00.000Z" },
] as const;

/**
 * 変更履歴11件(#9 の題材。**10件以上**ある)。
 *
 * **`applied_at` は同値を2組(seq 1/2 と seq 6/7 と seq 10/11)含み、しかも
 * 単調増加していない**(seq 3 は seq 2 より**前**の時刻、seq 9 は seq 8 より**前**)。
 * **既定順が `applied_at` ではなく `seq` で決まっていることが、これで初めて判別できる** ——
 * 題材が小さいと、どちらで並べても同じ結果になって「偶然緑」になる。
 */
const CHANGELOG = [
  { app_id: "app-a", diff_id: "d-001", intent: "表を作る", applied_at: "2026-08-05T00:00:00.000Z" },
  { app_id: "app-a", diff_id: "d-002", intent: "列を足す", applied_at: "2026-08-05T00:00:00.000Z" },
  {
    app_id: "app-kichi",
    diff_id: "d-003",
    intent: "画面を作る",
    applied_at: "2026-08-04T00:00:00.000Z",
  },
  {
    app_id: "app-kichi",
    diff_id: "d-004",
    intent: "やっぱり戻す",
    applied_at: "2026-08-06T00:00:00.000Z",
    kind: "undo",
    undo_target_seq: 3,
  },
  {
    app_id: "app-zen-a",
    diff_id: "d-005",
    intent: "一覧を作る",
    applied_at: "2026-08-03T00:00:00.000Z",
  },
  {
    app_id: "app-zen-a",
    diff_id: "d-006",
    intent: "もう一度やる",
    applied_at: "2026-08-07T00:00:00.000Z",
    kind: "redo",
    undo_target_seq: 4,
  },
  {
    app_id: "twin-one",
    diff_id: "d-007",
    intent: "表を作る",
    applied_at: "2026-08-07T00:00:00.000Z",
  },
  {
    app_id: "twin-one",
    diff_id: "d-008",
    intent: "グラフを足す",
    applied_at: "2026-08-08T00:00:00.000Z",
  },
  {
    app_id: "twin-two",
    diff_id: "d-009",
    intent: "集計表を足す",
    applied_at: "2026-08-02T00:00:00.000Z",
  },
  {
    app_id: "twin-two",
    diff_id: "d-010",
    intent: "戻す",
    applied_at: "2026-08-09T00:00:00.000Z",
    kind: "undo",
    undo_target_seq: 9,
  },
  {
    app_id: "twin-two",
    diff_id: "d-011",
    intent: "進める",
    applied_at: "2026-08-09T00:00:00.000Z",
    kind: "redo",
    undo_target_seq: 10,
  },
] as const;

/**
 * AI 使用量5件。
 *
 * **`actor` は非 required の text である** —— **システムテーブル3本の中で、
 * 5つの葉演算子(`equals` / `contains` / `gte` / `lte` / `in`)を全部当てられる
 * 未記入になりうる列はこれだけである**(`_apps` は全項目 required、
 * `_changelog.undo_target_seq` は number なので `contains` が型で弾かれる)。
 * BMP 外文字も同じ列に載せてあるので、#1 と #3 が同じ題材で測れる。
 */
const USAGE = [
  { actor: "A", called_at: "2026-08-01T00:00:00.000Z", tokens: 1 },
  { actor: null, called_at: "2026-08-02T00:00:00.000Z", tokens: 2 },
  { actor: "Ａ", called_at: "2026-08-03T00:00:00.000Z", tokens: 3 },
  { actor: "𠮷田", called_at: "2026-08-04T00:00:00.000Z", tokens: 4 },
  { actor: null, called_at: "2026-08-05T00:00:00.000Z", tokens: 5 },
] as const;

/**
 * ユーザ表3本。**フィールドのID・型・required・選択肢を、システムテーブルの定義
 * (`src/shared/system-tables.ts`)と同じに揃えてある** —— 揃っていないと、
 * 結果が一致しなかったときに「実装が割れている」のか「表の形が違う」のかが分からない。
 */
const manifest: Manifest = {
  app: {
    id: "sq-m5",
    name: "SQ-M5 の突き合わせ台",
    tables: [
      {
        id: "apps_mirror",
        name: "_apps と同じ値を持つユーザ表",
        fields: [
          { id: "app_id", name: "アプリID", type: "text", required: true },
          { id: "name", name: "アプリ名", type: "text", required: true },
          { id: "created_at", name: "作成日時", type: "date", required: true },
          {
            id: "status",
            name: "状態",
            type: "select",
            required: true,
            options: ["active", "archived"],
          },
        ],
      },
      {
        id: "changelog_mirror",
        name: "_changelog と同じ値を持つユーザ表",
        fields: [
          { id: "seq", name: "連番", type: "number", required: true },
          { id: "app_id", name: "アプリID", type: "text", required: true },
          { id: "diff_id", name: "差分ID", type: "text", required: true },
          { id: "intent", name: "意図", type: "long_text", required: true },
          { id: "applied_at", name: "適用日時", type: "date", required: true },
          {
            id: "kind",
            name: "種別",
            type: "select",
            required: true,
            options: ["apply", "undo", "redo"],
          },
          { id: "undo_target_seq", name: "取り消し対象の連番", type: "number" },
        ],
      },
      {
        id: "usage_mirror",
        name: "_ai_usage と同じ値を持つユーザ表",
        fields: [
          { id: "app_id", name: "アプリID", type: "text", required: true },
          { id: "capability_id", name: "capability ID", type: "text", required: true },
          { id: "workflow_id", name: "呼出元ワークフロー", type: "text", required: true },
          { id: "actor", name: "ユーザ", type: "text" },
          { id: "model", name: "モデル", type: "text", required: true },
          { id: "input_tokens", name: "入力トークン", type: "number", required: true },
          { id: "output_tokens", name: "出力トークン", type: "number", required: true },
          { id: "cost_usd", name: "推定コスト(USD)", type: "number", required: true },
          {
            id: "status",
            name: "結果",
            type: "select",
            required: true,
            options: ["success", "failure", "blocked"],
          },
          { id: "usage_date", name: "使用日(集計境界)", type: "text", required: true },
          { id: "called_at", name: "呼び出し日時", type: "date", required: true },
        ],
      },
    ],
    views: [],
  },
};

let dataRoot: string;
let appDb: Database;
let source: ReadSource;

function unwrap<T>(result: { ok: true; value: T } | { ok: false; errors: ValidationError[] }): T {
  if (!result.ok) {
    throw new Error(`期待に反して失敗しました: ${JSON.stringify(result.errors)}`);
  }
  return result.value;
}

function expectErrors(
  result: { ok: true; value: unknown } | { ok: false; errors: ValidationError[] },
): ValidationError[] {
  if (result.ok) {
    throw new Error(`失敗を期待しましたが成功しました: ${JSON.stringify(result.value)}`);
  }
  return result.errors;
}

/** ユーザ表へ1行書く(失敗したら題材が壊れているので即座に落とす)。 */
function seed(tableId: string, input: Record<string, unknown>): void {
  const created = createRecord(appDb, manifest, tableId, input);
  if (!created.ok) {
    throw new Error(`題材の投入に失敗しました(${tableId}): ${JSON.stringify(created.errors)}`);
  }
}

function rows(tableId: string, options: ListRecordsOptions = {}): RecordRow[] {
  return unwrap(readRecordList(source, manifest, tableId, options));
}

function column(tableId: string, field: string, options: ListRecordsOptions = {}): unknown[] {
  return rows(tableId, options).map((row) => (row as unknown as Record<string, unknown>)[field]);
}

/** `_ai_usage` / `usage_mirror` を `called_at` 昇順で読み、`actor` の並びだけを採る。 */
function actorsOf(tableId: string, options: ListRecordsOptions = {}): unknown[] {
  return column(tableId, "actor", { sort: { field: "called_at", order: "asc" }, ...options });
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-sq-m5-"));
  appDb = new Database(":memory:");
  applyManifestDdl(appDb, manifest);
  source = { dataRoot, appDb: () => appDb };

  // --- システムテーブル側 ---
  const store = KernelMetaStore.open(dataRoot);
  try {
    for (const app of APPS) {
      store.registerApp({ ...app });
    }
    for (const entry of CHANGELOG) {
      store.appendChangelog({ ...entry, operations: [] });
    }
  } finally {
    store.close();
  }
  const ai = AiCapabilityStore.openForKernel(dataRoot);
  try {
    const capability = ai.createCapability({
      appId: "app-a",
      name: "summarize",
      provider: "claude_cli",
      model: "claude-sonnet-4",
      limit: { maxCallsPerDay: 100, maxCostUsdPerDay: 1 },
    });
    for (const usage of USAGE) {
      ai.recordUsage({
        appId: "app-a",
        capabilityId: capability.id,
        workflowId: "wf-1",
        actor: usage.actor,
        model: "claude-sonnet-4",
        inputTokens: usage.tokens,
        outputTokens: usage.tokens * 2,
        costUsd: usage.tokens / 100,
        status: "success",
        usageDate: usage.called_at.slice(0, 10),
        calledAt: usage.called_at,
      });
    }
  } finally {
    ai.close();
  }

  // --- ユーザ表側(同じ値。同じ順で入れる)---
  for (const app of APPS) {
    seed("apps_mirror", { ...app, status: "active" });
  }
  CHANGELOG.forEach((entry, index) => {
    seed("changelog_mirror", {
      seq: index + 1,
      app_id: entry.app_id,
      diff_id: entry.diff_id,
      intent: entry.intent,
      applied_at: entry.applied_at,
      kind: "kind" in entry ? entry.kind : "apply",
      undo_target_seq: "undo_target_seq" in entry ? entry.undo_target_seq : null,
    });
  });
  for (const usage of USAGE) {
    seed("usage_mirror", {
      app_id: "app-a",
      capability_id: "cap-1",
      workflow_id: "wf-1",
      actor: usage.actor,
      model: "claude-sonnet-4",
      input_tokens: usage.tokens,
      output_tokens: usage.tokens * 2,
      cost_usd: usage.tokens / 100,
      status: "success",
      usage_date: usage.called_at.slice(0, 10),
      called_at: usage.called_at,
    });
  }
});

afterEach(async () => {
  appDb.close();
  await rm(dataRoot, { recursive: true, force: true });
});

// =====================================================================================
// #1 `not` × 未記入 —— **システム表でも行が落ちる**(5演算子すべて)
// =====================================================================================

/**
 * `not` の中に置いたときの5演算子。
 *
 * **`actor` が未記入の2行(`null`)は、どの `not` からも返らない** ——
 * SQL では `NOT (NULL = 'A')` が `NULL` になり、`WHERE` は `NULL` を通さないためである。
 * **一本化の前は、JS 側の実装が `undefined !== "A"` を真と評価して未記入の行を残していた。**
 * 「未記入は『A ではない』はずだ」という直感は今日は当たらない —— **これが変わった挙動である。**
 */
const NOT_FILTERS = {
  equals: { not: { field: "actor", equals: "A" } },
  contains: { not: { field: "actor", contains: "A" } },
  gte: { not: { field: "actor", gte: "Ａ" } },
  lte: { not: { field: "actor", lte: "A" } },
  in: { not: { field: "actor", in: ["A", "Ａ"] } },
} satisfies Record<string, FilterNode>;

describe("SQ-M5 #1: `not` の中で対象列が未記入の行は落ちる(システム表でもユーザ表と同じ)", () => {
  test("5演算子すべてで、未記入(null)の2行が1件も返らない", () => {
    // **5種ちょうどを覆っていること自体を数える**(1種消しても緑にならない)。
    expect(Object.keys(NOT_FILTERS)).toHaveLength(5);
    for (const [label, filter] of Object.entries(NOT_FILTERS)) {
      expect(
        actorsOf("_ai_usage", { filter }),
        `${label}: システム表に未記入が残っている`,
      ).not.toContain(null);
    }
  });

  test('equals: not equals "A" は Ａ と 𠮷田 だけ(未記入は落ちる)', () => {
    expect(actorsOf("_ai_usage", { filter: NOT_FILTERS.equals })).toEqual(["Ａ", "𠮷田"]);
  });

  test('contains: not contains "A" は Ａ と 𠮷田 だけ(全角Ａは ASCII の A を含まない)', () => {
    expect(actorsOf("_ai_usage", { filter: NOT_FILTERS.contains })).toEqual(["Ａ", "𠮷田"]);
  });

  test('gte: not gte "Ａ" は A だけ', () => {
    expect(actorsOf("_ai_usage", { filter: NOT_FILTERS.gte })).toEqual(["A"]);
  });

  test('lte: not lte "A" は Ａ と 𠮷田 だけ', () => {
    expect(actorsOf("_ai_usage", { filter: NOT_FILTERS.lte })).toEqual(["Ａ", "𠮷田"]);
  });

  test('in: not in ["A","Ａ"] は 𠮷田 だけ', () => {
    expect(actorsOf("_ai_usage", { filter: NOT_FILTERS.in })).toEqual(["𠮷田"]);
  });

  test("5演算子すべてで、システム表とユーザ表の結果が一致する", () => {
    for (const [label, filter] of Object.entries(NOT_FILTERS)) {
      expect(actorsOf("_ai_usage", { filter }), `${label} が割れている`).toEqual(
        actorsOf("usage_mirror", { filter }),
      );
    }
  });
});

// =====================================================================================
// #2 `equals: null` —— **0件**(`is_null` として働かない)
// =====================================================================================

describe("SQ-M5 #2: `equals: null` は0件(未記入に一致しない)", () => {
  /**
   * **`FilterCondition` / `FilterLeaf` の型は `null` を許していない** ——
   * それでも `null` は **HTTP と MCP の JSON から実際に到達する**(型はランタイムの門ではない)。
   * **到達したときに何が起きるかを固定するのがこの検査の目的**なので、
   * 型の側は明示的に外して**外から来る値そのまま**を流す。
   */
  const nullEqualsNode = { field: "actor", equals: null } as unknown as FilterNode;
  const nullEqualsArray = [{ field: "actor", equals: null }] as unknown as FilterCondition[];

  test("ブール式の葉として渡しても0件(システム表)", () => {
    expect(actorsOf("_ai_usage", { filter: nullEqualsNode })).toEqual([]);
  });

  test("後方互換の等値AND配列で渡しても0件(システム表)", () => {
    expect(actorsOf("_ai_usage", { filter: nullEqualsArray })).toEqual([]);
  });

  test("`and` でくるんでも0件(システム表)", () => {
    expect(
      actorsOf("_ai_usage", { filter: { and: [nullEqualsNode] } as unknown as FilterNode }),
    ).toEqual([]);
  });

  test("ユーザ表でも同じく0件(葉・配列の両方)", () => {
    expect(actorsOf("usage_mirror", { filter: nullEqualsNode })).toEqual([]);
    expect(actorsOf("usage_mirror", { filter: nullEqualsArray })).toEqual([]);
  });

  test("未記入の行そのものは題材に2件ある(0件の理由が『行が無いから』ではない)", () => {
    expect(actorsOf("_ai_usage").filter((actor) => actor === null)).toHaveLength(2);
    expect(actorsOf("usage_mirror").filter((actor) => actor === null)).toHaveLength(2);
  });
});

// =====================================================================================
// #3 BMP 外文字の並び —— **UTF-8 バイト順**
// =====================================================================================

/**
 * `A`(U+0041) / `Ａ`(U+FF21) / `𠮷`(U+20BB7)の3文字。
 *
 * - **UTF-16 符号単位順**(JS の `<`): `A`(0041) < `𠮷`(D842 DFB7) < `Ａ`(FF21)
 * - **UTF-8 バイト順**(SQLite の BINARY): `A`(41) < `Ａ`(EF BC A1) < `𠮷`(F0 A0 AE B7)
 *
 * **`Ａ` と `𠮷` の前後が入れ替わる。** 今日は後者(UTF-8 バイト順)である。
 */
describe("SQ-M5 #3: BMP 外文字の並びは UTF-8 バイト順(ユーザ表と一致)", () => {
  test("sort 昇順: null → A → Ａ → 𠮷田(SQLite は NULL を先頭に置く)", () => {
    expect(column("_ai_usage", "actor", { sort: { field: "actor", order: "asc" } })).toEqual([
      null,
      null,
      "A",
      "Ａ",
      "𠮷田",
    ]);
  });

  test("sort 降順: 𠮷田 → Ａ → A → null", () => {
    expect(column("_ai_usage", "actor", { sort: { field: "actor", order: "desc" } })).toEqual([
      "𠮷田",
      "Ａ",
      "A",
      null,
      null,
    ]);
  });

  test("sort の並びがユーザ表と一致する(昇順・降順とも)", () => {
    for (const order of ["asc", "desc"] as const) {
      expect(column("_ai_usage", "actor", { sort: { field: "actor", order } })).toEqual(
        column("usage_mirror", "actor", { sort: { field: "actor", order } }),
      );
    }
  });

  test('gte "Ａ" は Ａ と 𠮷田(UTF-16 順なら 𠮷田 は外れるはずだった)', () => {
    const filter: FilterNode = { field: "actor", gte: "Ａ" };
    expect(actorsOf("_ai_usage", { filter })).toEqual(["Ａ", "𠮷田"]);
    expect(actorsOf("usage_mirror", { filter })).toEqual(["Ａ", "𠮷田"]);
  });

  test('lte "Ａ" は A と Ａ(𠮷田 は入らない)', () => {
    const filter: FilterNode = { field: "actor", lte: "Ａ" };
    expect(actorsOf("_ai_usage", { filter })).toEqual(["A", "Ａ"]);
    expect(actorsOf("usage_mirror", { filter })).toEqual(["A", "Ａ"]);
  });

  test("`_apps` の name でも同じ並びになる(表を変えても割れない)", () => {
    const byName = { sort: { field: "name", order: "asc" } } as const;
    expect(column("_apps", "name", byName)).toEqual(["A", "Ａ", "𠮷", "𠮷 その1", "𠮷 その2"]);
    expect(column("apps_mirror", "name", byName)).toEqual(column("_apps", "name", byName));
  });
});

// =====================================================================================
// #4 絞り込みと合計欄を同時に間違えたとき —— **指摘が両方返る**
// =====================================================================================

describe("SQ-M5 #4: 絞り込みと合計欄を同時に間違えると、指摘が両方返る", () => {
  /** 実在しない絞り込み列 + number ではない合計欄。**2箇所とも間違えている。** */
  function bothWrong(tableId: string): ValidationError[] {
    return expectErrors(
      readRecordCountAndSum(source, manifest, tableId, {
        filter: [{ field: "nope", equals: "x" }],
        sumField: "intent",
      }),
    );
  }

  test("システム表でも指摘は2件返る(一本化の前は1件だった)", () => {
    expect(bothWrong("_changelog").map((error) => error.path)).toEqual(["/filter/0/field", "/sum"]);
  });

  test("絞り込みの指摘は message も hint も今日の文面である", () => {
    const error = bothWrong("_changelog")[0];
    expect(error?.message).toBe(
      '絞り込みに指定されたフィールド "nope" はテーブル "_changelog" に存在しません。',
    );
    expect(error?.hint).toBe('テーブル "_changelog" に実在するフィールドIDを指定してください。');
    expect(error?.allowed_values).toEqual([
      "seq",
      "app_id",
      "diff_id",
      "intent",
      "applied_at",
      "kind",
      "undo_target_seq",
    ]);
  });

  test("合計欄の指摘は message も hint も今日の文面である", () => {
    const error = bothWrong("_changelog")[1];
    expect(error?.message).toBe(
      '合計を出す列 "intent" は long_text 型です。合計を出せるのは number だけです。',
    );
    expect(error?.hint).toBe(
      "number のフィールドを指定してください(足し算の意味が定まるのは number だけです)。",
    );
    expect(error?.allowed_values).toEqual(["seq", "undo_target_seq"]);
  });

  test("message と hint の両方が、同じ形のユーザ表と 1文字も違わない(表IDを除く)", () => {
    // **表IDだけは必ず違う**(比べる相手が別の表なので当然である)。
    // そこだけを揃えて、**残りの文面が1文字も違わないこと**を見る。
    const asUser = JSON.stringify(bothWrong("_changelog")).replaceAll(
      "_changelog",
      "changelog_mirror",
    );
    expect(JSON.parse(asUser)).toEqual(bothWrong("changelog_mirror"));
  });
});

// =====================================================================================
// #5 / #9 既定順 —— **今日と同じ**(ユーザ決定1)
// =====================================================================================

describe("SQ-M5 #5 / #9: 既定順が今日と同じである(題材は11件・applied_at 同値を含む)", () => {
  test("_changelog は 1,2,3…10,11 の順(1,10,2 になっていない)", () => {
    expect(column("_changelog", "_id")).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
      "11",
    ]);
    expect(column("_changelog", "seq")).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  test("題材の applied_at は同値を含み、しかも単調増加ではない(seq で並んでいることの証明)", () => {
    // **`applied_at` で並べていたら、この並びには絶対にならない。**
    expect(column("_changelog", "applied_at")).toEqual([
      "2026-08-05T00:00:00.000Z",
      "2026-08-05T00:00:00.000Z",
      "2026-08-04T00:00:00.000Z",
      "2026-08-06T00:00:00.000Z",
      "2026-08-03T00:00:00.000Z",
      "2026-08-07T00:00:00.000Z",
      "2026-08-07T00:00:00.000Z",
      "2026-08-08T00:00:00.000Z",
      "2026-08-02T00:00:00.000Z",
      "2026-08-09T00:00:00.000Z",
      "2026-08-09T00:00:00.000Z",
    ]);
    expect(column("_changelog", "diff_id")).toEqual([
      "d-001",
      "d-002",
      "d-003",
      "d-004",
      "d-005",
      "d-006",
      "d-007",
      "d-008",
      "d-009",
      "d-010",
      "d-011",
    ]);
  });

  test("_apps の既定順は created_at → 登録順(ledger_seq)である", () => {
    expect(column("_apps", "app_id")).toEqual([
      "app-a",
      "app-zen-a",
      "app-kichi",
      "twin-one",
      "twin-two",
    ]);
  });

  test("_ai_usage の既定順は called_at 昇順である(actor の並びで見る)", () => {
    expect(column("_ai_usage", "actor")).toEqual(["A", null, "Ａ", "𠮷田", null]);
  });

  test("既定順は sort を明示したときの並びと一致する(_changelog は seq 昇順)", () => {
    expect(column("_changelog", "diff_id")).toEqual(
      column("_changelog", "diff_id", { sort: { field: "seq", order: "asc" } }),
    );
  });

  /**
   * **【`_id` を明示して並べると文字列順である —— 既定順とは違う】**
   *
   * 既定順は `seq` で並んでいるので、`_id` の出し方(`CAST` の有無)では**赤くならない**。
   * **`_id` を明示して並べたときにだけ、その差が観測できる**ので、ここで押さえる。
   *
   * **期待値は一本化の前(`566d925`)を実際に走らせて採った値と1文字も違わない。**
   * `CAST` を落とすとこの2本が `1,2,3…10,11` / `11,10,9…1` に変わり、**`_changelog`
   * だけが数値順になってユーザ表と割れる**(そちらを固定していたのが旧版のこの検査)。
   */
  test("`_id` を明示して並べると文字列順である(一本化の前と同じ 1,10,11,2…)", () => {
    expect(column("_changelog", "_id", { sort: { field: "_id", order: "asc" } })).toEqual([
      "1",
      "10",
      "11",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
    ]);
    expect(column("_changelog", "_id", { sort: { field: "_id", order: "desc" } })).toEqual([
      "9",
      "8",
      "7",
      "6",
      "5",
      "4",
      "3",
      "2",
      "11",
      "10",
      "1",
    ]);
  });

  test("`_id` を明示しても既定順は動かない(既定順は `_id` ではなく seq で組み立てている)", () => {
    expect(column("_changelog", "_id")).not.toEqual(
      column("_changelog", "_id", { sort: { field: "_id", order: "asc" } }),
    );
    expect(column("_changelog", "_id")).toEqual(
      column("_changelog", "_id", { sort: { field: "seq", order: "asc" } }),
    );
  });
});

// =====================================================================================
// #6 **同じ宣言を、システム表と、同じ値を持つユーザ表の両方に流す**
// =====================================================================================

/**
 * **ここが SQ-M5 の芯である。**
 *
 * `readRecordList` にユーザ表IDを渡しても `listRecords` へ委譲されるだけなので、
 * **ユーザ表どうしを比べても「2つを比べた」ことにならない。**
 * **片側は必ずシステムテーブル**(`kernel.sqlite` の投影を副問合せで読む経路)、
 * **もう片側は `app.sqlite` の実テーブル**である。
 */
const SHARED_DECLARATIONS: readonly {
  readonly label: string;
  readonly options: ListRecordsOptions;
}[] = [
  {
    label: "and + not + 未記入を含む列",
    options: {
      filter: {
        and: [{ field: "app_id", contains: "app" }, { not: { field: "undo_target_seq", gte: 4 } }],
      },
      sort: { field: "seq", order: "asc" },
    },
  },
  {
    label: "or + in + lte",
    options: {
      filter: {
        or: [
          { field: "kind", in: ["undo", "redo"] },
          { field: "seq", lte: 2 },
        ],
      },
      sort: { field: "seq", order: "desc" },
    },
  },
  {
    label: "contains(日本語の部分一致)",
    options: {
      filter: { field: "intent", contains: "戻す" },
      sort: { field: "seq", order: "asc" },
    },
  },
  {
    label: "limit + offset(ページ送り)",
    options: { sort: { field: "seq", order: "asc" }, limit: 3, offset: 4 },
  },
  {
    label: "not equals(未記入の行が落ちる側)",
    options: {
      filter: { not: { field: "undo_target_seq", equals: 3 } },
      sort: { field: "seq", order: "asc" },
    },
  },
];

describe("SQ-M5 #6: 同じ宣言をシステム表とユーザ表の両方に流すと結果が一致する", () => {
  test("題材の値が両側で本当に同じである(比較の前提)", () => {
    const fields = ["seq", "app_id", "diff_id", "intent", "applied_at", "kind", "undo_target_seq"];
    const project = (tableId: string): unknown[][] =>
      rows(tableId, { sort: { field: "seq", order: "asc" } }).map((row) =>
        fields.map((field) => (row as unknown as Record<string, unknown>)[field]),
      );
    expect(project("_changelog")).toEqual(project("changelog_mirror"));
    expect(project("_changelog")).toHaveLength(11);
  });

  for (const { label, options } of SHARED_DECLARATIONS) {
    test(`${label}: システム表とユーザ表が同じ行を同じ順で返す`, () => {
      expect(column("_changelog", "diff_id", options)).toEqual(
        column("changelog_mirror", "diff_id", options),
      );
    });
  }

  test("実際に返る行の値も固定する(『両方とも空だから一致した』を防ぐ)", () => {
    expect(column("_changelog", "diff_id", SHARED_DECLARATIONS[0]?.options ?? {})).toEqual([
      "d-004",
    ]);
    expect(column("_changelog", "diff_id", SHARED_DECLARATIONS[1]?.options ?? {})).toEqual([
      "d-011",
      "d-010",
      "d-006",
      "d-004",
      "d-002",
      "d-001",
    ]);
    expect(column("_changelog", "diff_id", SHARED_DECLARATIONS[2]?.options ?? {})).toEqual([
      "d-004",
      "d-010",
    ]);
    expect(column("_changelog", "diff_id", SHARED_DECLARATIONS[3]?.options ?? {})).toEqual([
      "d-005",
      "d-006",
      "d-007",
    ]);
    expect(column("_changelog", "diff_id", SHARED_DECLARATIONS[4]?.options ?? {})).toEqual([
      "d-006",
      "d-010",
      "d-011",
    ]);
  });

  test("_apps と _ai_usage でも、同じ宣言が同じ結果になる", () => {
    const appsOptions: ListRecordsOptions = {
      filter: { not: { field: "name", contains: "その" } },
      sort: { field: "name", order: "asc" },
    };
    expect(column("_apps", "name", appsOptions)).toEqual(["A", "Ａ", "𠮷"]);
    expect(column("apps_mirror", "name", appsOptions)).toEqual(
      column("_apps", "name", appsOptions),
    );

    const usageOptions: ListRecordsOptions = {
      filter: {
        or: [
          { field: "actor", gte: "Ａ" },
          { field: "input_tokens", lte: 1 },
        ],
      },
      sort: { field: "input_tokens", order: "asc" },
    };
    expect(column("_ai_usage", "actor", usageOptions)).toEqual(["A", "Ａ", "𠮷田"]);
    expect(column("usage_mirror", "actor", usageOptions)).toEqual(
      column("_ai_usage", "actor", usageOptions),
    );
  });

  /**
   * **`sort: {field: "_id"}` が、システム表とユーザ表で同じ意味になる。**
   *
   * ユーザ表の `_id` は `crypto.randomUUID()` なので、**返る値そのものは突き合わせられない。**
   * 突き合わせられるのは**意味**である —— `_id` は語彙の上では必ず文字列なので、
   * 「`_id` で並べた順」は「返った `_id` を文字列として並べ直した順」と一致しなければならない。
   *
   * **`_changelog._id` から `CAST(... AS TEXT)` を落とすと、この検査はシステム表側だけで
   * 落ちる**(`seq` が INTEGER のまま数値順に並び、`"10"` が `"2"` より前に来なくなる)。
   * `_apps._id`(`app_id`)と `_ai_usage._id`(UUID)は元から TEXT なので、どちらでも通る。
   *
   * **題材の `_id` は数字と UUID(小文字16進+ハイフン)だけなので全て ASCII であり、
   * JS の UTF-16 順と SQLite の UTF-8 バイト順は一致する** —— #3 の BMP 外文字の話は
   * ここには混ざらない。
   */
  test("`_id` で並べた順が、返った `_id` の文字列順と一致する(4表すべて)", () => {
    for (const tableId of ["_changelog", "changelog_mirror", "_apps", "apps_mirror"]) {
      const asc = column(tableId, "_id", { sort: { field: "_id", order: "asc" } }) as string[];
      const desc = column(tableId, "_id", { sort: { field: "_id", order: "desc" } }) as string[];
      expect(asc.every((id) => typeof id === "string")).toBe(true);
      expect({ tableId, asc }).toEqual({ tableId, asc: [...asc].sort() });
      expect({ tableId, desc }).toEqual({ tableId, desc: [...asc].reverse() });
    }
  });

  test("その突き合わせが本当に効く題材である(`_changelog` は数値順と文字列順が違う)", () => {
    // 11件あるので `"10"` / `"11"` が `"2"` より前に来る ——
    // 数値順と文字列順が同じになる題材(1〜9)では、上の検査は素通りしてしまう。
    const asc = column("_changelog", "_id", { sort: { field: "_id", order: "asc" } }) as string[];
    expect(asc).toHaveLength(11);
    expect(asc.indexOf("10")).toBeLessThan(asc.indexOf("2"));
    expect([...asc].sort((a, b) => Number(a) - Number(b))).not.toEqual(asc);
  });
});

// =====================================================================================
// #7 `_id` の単体取得 —— **`_id` は文字列として突き合わせる**(一本化の前と同じ)
// =====================================================================================

/**
 * **【この節は SQ-M5 の途中で期待値がひっくり返った。経緯を消さずに残す】**
 *
 * 旧版のこの節は「`_id = "05"` / `" 5"` / `"5.0"` / `"+5"` も seq=5 に当たる」を
 * **ユーザ決定2の代償として**固定していた。`_changelog._id` を `"seq"`(INTEGER)の
 * まま出していたので、副問合せ越しに SQLite の INTEGER 親和性が伝わり、
 * `WHERE "_id" = '05'` の右辺が数の 5 に変換されて一致していたためである。
 *
 * **その代償を受け入れる理由(「CAST を入れると既定順が 1,10,2 に変わる」)が、
 * 実測で否定された。** 既定順は `_id` ではなく `seq` で組み立てているので、
 * `CAST` を入れても既定順は1件も動かない。そこで**一本化の前(`566d925`)を実際に
 * 走らせて測り直したところ、`"05"` も `" 5"` も `"5.0"` も `"+5"` も `null` だった** ——
 * **代償は一本化が持ち込んだものであって、元からあった挙動ではなかった。**
 *
 * `CAST("seq" AS TEXT)` を入れた今日は、下のとおり**一本化の前と1件も違わない。**
 * ユーザ表の `_id`(UUID)でも同じで、**`_id` は3表ともユーザ表とも「文字列として
 * 突き合わせる」1つの意味に揃っている。**
 */
describe("SQ-M5 #7: `_id` は文字列として突き合わせる(数として解釈されない)", () => {
  function fetched(id: string): string | null {
    const row = unwrap(readRecord(source, manifest, "_changelog", id));
    return row === null ? null : (row.diff_id as string);
  }

  test('素直な "5" は seq=5 に当たる(詳細画面が今日どおり開く)', () => {
    expect(fetched("5")).toBe("d-005");
  });

  test('"05" は当たらない(一本化の前と同じ null。CAST を落とすと当たってしまう)', () => {
    expect(fetched("05")).toBeNull();
  });

  test('" 5" も当たらない(前の空白は無視されない)', () => {
    expect(fetched(" 5")).toBeNull();
  });

  test('"5 " / "5.0" / "+5" も当たらない(数として読めても文字列が違う)', () => {
    expect(fetched("5 ")).toBeNull();
    expect(fetched("5.0")).toBeNull();
    expect(fetched("+5")).toBeNull();
  });

  test('数として読めない "5x" も当たらない(null。エラーではない)', () => {
    expect(fetched("5x")).toBeNull();
  });

  test("当たる文字列は素直な10進表記ちょうど1つである(11件すべてで確かめる)", () => {
    // **`"5"` だけが当たるのを 1件で見ても「たまたま」かもしれない。**
    // 11件すべてについて、`String(seq)` は当たり、0埋め・前後空白は当たらないことを見る。
    for (let seq = 1; seq <= 11; seq += 1) {
      const expected = `d-${String(seq).padStart(3, "0")}`;
      expect({ seq, hit: fetched(String(seq)) }).toEqual({ seq, hit: expected });
      expect({ seq, hit: fetched(`0${seq}`) }).toEqual({ seq, hit: null });
      expect({ seq, hit: fetched(` ${seq}`) }).toEqual({ seq, hit: null });
    }
  });

  test("ユーザ表の `_id`(UUID)では同じことが起きない", () => {
    const target = rows("changelog_mirror", { sort: { field: "seq", order: "asc" } })[4];
    const id = target?._id as string;
    expect(unwrap(readRecord(source, manifest, "changelog_mirror", id))?.diff_id).toBe("d-005");
    expect(unwrap(readRecord(source, manifest, "changelog_mirror", `0${id}`))).toBeNull();
  });

  test("`_apps` の `_id`(app_id = 文字列)では数の解釈が起きない", () => {
    expect(unwrap(readRecord(source, manifest, "_apps", "app-a"))?.name).toBe("A");
    expect(unwrap(readRecord(source, manifest, "_apps", " app-a"))).toBeNull();
  });
});

// =====================================================================================
// #8 同一 `created_at` のアプリ2件の前後
// =====================================================================================

describe("SQ-M5 #8: created_at が同値のアプリ2件の前後が決まっている", () => {
  test("題材に created_at が同値のアプリがちょうど2件ある", () => {
    const sameDay = rows("_apps").filter((row) => row.created_at === "2026-08-04T00:00:00.000Z");
    expect(sameDay.map((row) => row.app_id)).toEqual(["twin-one", "twin-two"]);
  });

  test("既定順では登録順(ledger_seq)で twin-one が先に来る", () => {
    const order = column("_apps", "app_id");
    expect(order.indexOf("twin-one")).toBeLessThan(order.indexOf("twin-two"));
    expect(order).toEqual(["app-a", "app-zen-a", "app-kichi", "twin-one", "twin-two"]);
  });

  test("created_at を明示して昇順にしても同じ前後になる", () => {
    expect(column("_apps", "app_id", { sort: { field: "created_at", order: "asc" } })).toEqual([
      "app-a",
      "app-zen-a",
      "app-kichi",
      "twin-one",
      "twin-two",
    ]);
  });

  test("created_at 降順では twin-two が先に来る(同値の2件も反転する)", () => {
    expect(column("_apps", "app_id", { sort: { field: "created_at", order: "desc" } })).toEqual([
      "twin-two",
      "twin-one",
      "app-kichi",
      "app-zen-a",
      "app-a",
    ]);
  });
});

// =====================================================================================
// #10 集計表の群の並び(`report.ts` は1バイトも触っていないが、挙動は追随する)
// =====================================================================================

function reportOf(tableId: string, report: ReportDeclaration): ReturnType<typeof computeReport> {
  const view: ReportView = {
    id: "sq_m5_report",
    type: "report_view",
    name: "SQ-M5 の集計",
    table: tableId,
    report,
  };
  return computeReport(source, manifest, view);
}

function groupKeys(tableId: string, report: ReportDeclaration): unknown[] {
  return unwrap(reportOf(tableId, report)).groups.map((group) => group.keys[0]?.value);
}

function groupCounts(tableId: string, report: ReportDeclaration): number[] {
  return unwrap(reportOf(tableId, report)).groups.map(
    (group) => group.aggregates[0]?.value as number,
  );
}

describe("SQ-M5 #10: `_apps` / `_changelog` を対象にした集計表の群の並び", () => {
  const byKind: ReportDeclaration = {
    group_by: [{ field: "kind" }],
    aggregates: [{ type: "count" }, { type: "sum", field: "undo_target_seq" }],
  };
  const byCreatedDay: ReportDeclaration = {
    group_by: [{ field: "created_at", granularity: "day" }],
    aggregates: [{ type: "count" }],
  };

  test("_changelog を kind で束ねると apply / redo / undo の順に並ぶ", () => {
    expect(groupKeys("_changelog", byKind)).toEqual(["apply", "redo", "undo"]);
    expect(groupCounts("_changelog", byKind)).toEqual([7, 2, 2]);
  });

  test("_changelog の群ごとの合計も固定する(未記入は 0 として足される)", () => {
    const result = unwrap(reportOf("_changelog", byKind));
    expect(result.groups.map((group) => group.aggregates[1]?.value)).toEqual([0, 14, 12]);
    expect(result.total_groups).toBe(3);
    expect(result.totals.map((aggregate) => aggregate.value)).toEqual([11, 26]);
  });

  test("_apps を created_at(日)で束ねると 4群になり、同日の2件が1群にまとまる", () => {
    expect(groupKeys("_apps", byCreatedDay)).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
      "2026-08-04",
    ]);
    expect(groupCounts("_apps", byCreatedDay)).toEqual([1, 1, 1, 2]);
  });

  test("同じ宣言をユーザ表に流しても、群の並びと値が一致する", () => {
    expect(unwrap(reportOf("_changelog", byKind))).toEqual(
      unwrap(reportOf("changelog_mirror", byKind)),
    );
    expect(unwrap(reportOf("_apps", byCreatedDay))).toEqual(
      unwrap(reportOf("apps_mirror", byCreatedDay)),
    );
  });

  /**
   * **【正直に書く。ここは読取の既定順とは違う規則で並んでいる】**
   *
   * 集計表の群は `report.ts` が **JS 側で並べ替えている**(`computeReport` の
   * `compareByDefault`)。**読取の並びは SQL の BINARY = UTF-8 バイト順だが、
   * 群の並びは JS の文字列比較 = UTF-16 符号単位順である。**
   * その結果、**同じ3文字が読取と集計で違う順に出る**:
   *
   * - 読取(#3): `A` → `Ａ` → `𠮷田`
   * - 集計(下): `A` → `𠮷田` → `Ａ`
   *
   * **これは一本化が作った差ではない**(システム表とユーザ表で同じ結果になる)。
   * **`report.ts` のコードは今回1バイトも触っていない**ので、この段では**直さずに固定する。**
   */
  test("群の並びは UTF-16 順である(読取の UTF-8 順とは違う。両表で同じ)", () => {
    const byActor: ReportDeclaration = {
      group_by: [{ field: "actor" }],
      aggregates: [{ type: "count" }],
    };
    expect(groupKeys("_ai_usage", byActor)).toEqual(["A", "𠮷田", "Ａ", null]);
    expect(groupKeys("usage_mirror", byActor)).toEqual(["A", "𠮷田", "Ａ", null]);
    // 読取の側は UTF-8 バイト順のままである(#3 と同じ値)。
    expect(column("_ai_usage", "actor", { sort: { field: "actor", order: "desc" } })).toEqual([
      "𠮷田",
      "Ａ",
      "A",
      null,
      null,
    ]);
  });

  /**
   * **【同じく正直に書く】** 行そのもの(`_id`)で束ねると、群の並びは
   * **文字列の辞書順**になる —— **読取の既定順(1,2,3…10,11)とは違う。**
   * `_changelog._id` は `toRecordRow` が `String()` で写した文字列なので、
   * `"10"` が `"2"` より前に来る。**これも `report.ts` の側の規則であり、
   * 今回の一本化で変わったものではない。**
   *
   * **【SQ-M5 追記】** `_id` に `CAST(... AS TEXT)` を入れたので、**読取で `sort` に
   * `_id` を明示したときの並びは、この群の並びと一致する**ようになった(#5 の
   * 「`_id` を明示して並べると文字列順である」)。**違うのは「既定順」との比較だけ**で、
   * 既定順は `_id` ではなく `seq` で組み立てているからである。
   */
  test("_id で束ねると群の並びは 1,10,11,2… になる(読取の既定順とは違う)", () => {
    const byRow: ReportDeclaration = {
      group_by: [{ field: "_id" }],
      aggregates: [{ type: "count" }],
    };
    expect(groupKeys("_changelog", byRow)).toEqual([
      "1",
      "10",
      "11",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
    ]);
    // 読取の既定順はこうではない(#5)。
    expect(column("_changelog", "_id")).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
      "11",
    ]);
  });
});
