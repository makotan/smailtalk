/**
 * 要件ドキュメント生成(V1-M8-T02。ADR-0025)の検査。
 *
 * このテストが固定するのは **ADR-0025 §5 の論証がコードの上で成り立っていること**である。
 * 論証は5つの辺からなり、そのうち4つはここで**全数検査**される(辺5「LLM を呼ばない」は
 * import が無いことで担保される)。
 *
 * - 辺1(§5): `renderRequirementsMarkdown(doc.statements) === doc.markdown`(テスト6)
 * - 辺2(§5): `renderStatementText(s.template, s.slots) === s.text`(テスト7)
 * - 辺3(§5): `verbatim` は出典の該当フィールドとバイト一致(テスト8)/
 *            `id` は実在集合の要素(テスト9・17)
 * - 辺4(§5): `sources` が非空(テスト5)
 *
 * さらに ADR-0025 §4-3 の**残差検査**(テスト10)を置く。これが無いと確認方法3 は
 * 「甘い」のではなく**無意味**になる —— 地の文に何を書いても通ってしまうからである。
 *
 * 作法は `changelog.test.ts` に揃えた(実ディスク・実DB・実 changelog を使い、
 * モックを1つも置かない)。一時 dataRoot は `mkdtemp` で作り、実 `data/` を汚さない。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SYSTEM_TABLES } from "../shared/system-tables.ts";
import { applyDiff } from "./apply-diff.ts";
import { readCurrentManifest } from "./apply-manifest.ts";
import { getChangelog } from "./changelog.ts";
import { createApp } from "./create-app.ts";
import { type ChangelogEntry, KernelMetaStore } from "./meta-store.ts";
// ブール式 filter の深度上限。**生成器と同じ定数を共有していることを検査する**
// (ADR-0068 B3。生成器に第2の上限を作らない)。
import { createRecord, MAX_FILTER_DEPTH } from "./records.ts";
import {
  generateRequirementsDoc,
  REQUIREMENT_TEMPLATES,
  type RequirementStatement,
  type RequirementsDoc,
  type RequirementTemplateId,
  renderRequirementsMarkdown,
  renderStatementText,
  type Slot,
} from "./requirements-doc.ts";
import { appDbPath, appManifestPath } from "./storage-paths.ts";
import {
  DIFF_OPS,
  type Diff,
  FIELD_TYPES,
  type FilterCondition,
  type FilterNode,
  type FunctionInput,
  type Manifest,
  SORT_ORDERS,
  type Theme,
  VIEW_TYPES,
  type WorkflowAction,
  type WorkflowTrigger,
} from "./types.ts";
import { undo } from "./undo.ts";

const APP_ID = "book-tracker";
const APP_NAME = "蔵書管理";

let dataRoot: string;
let store: KernelMetaStore;

// --- 試材 ---------------------------------------------------------------------

const INTENT_1 = "本を記録したいので、タイトルとメモを持つ台帳と一覧・入力画面を用意する";
const INTENT_2 = "ジャンル・タグの`select` と評価を★にしたいです";
const INTENT_3 = "タグを別台帳にして、本から参照できるようにする";

/**
 * 第1差分。テーブル1・ビュー3(list_view / form / detail_view)を足す。
 *
 * `add_table` は**フィールドを2件同時に**入れてある —— 帰属(ADR-0025 §8)が
 * `add_field` だけでなく `add_table` の中のフィールドも拾えることを検査するため。
 */
const DIFF_1: Diff = {
  diff_id: "d-001",
  intent: INTENT_1,
  operations: [
    {
      op: "add_table",
      table: {
        id: "books",
        name: "本",
        fields: [
          { id: "title", name: "タイトル", type: "text", required: true },
          { id: "memo", name: "メモ", type: "long_text" },
        ],
      },
    },
    {
      op: "add_view",
      view: { id: "book-list", type: "list_view", table: "books", columns: ["title"] },
    },
    {
      op: "add_view",
      view: { id: "book-form", type: "form", table: "books", fields: ["title", "memo"] },
    },
    {
      op: "add_view",
      view: { id: "book-detail", type: "detail_view", table: "books", fields: ["title", "memo"] },
    },
  ],
};

/** 第2差分。select(選択肢)と number を足し、一覧の列・並び順・絞り込みを設定する。 */
const DIFF_2: Diff = {
  diff_id: "d-002",
  intent: INTENT_2,
  operations: [
    {
      op: "add_field",
      table: "books",
      field: { id: "genre", name: "ジャンル", type: "select", options: ["小説", "技術書"] },
    },
    { op: "add_field", table: "books", field: { id: "rating", name: "評価", type: "number" } },
    {
      op: "update_view",
      view: "book-list",
      changes: {
        name: "本の一覧",
        columns: ["title", "genre", "rating"],
        sort: [
          { field: "rating", order: "desc" },
          { field: "title", order: "asc" },
        ],
        filter: [{ field: "genre", equals: "技術書" }],
      },
    },
  ],
};

/** 第3差分。参照フィールド(reference)を足す。 */
const DIFF_3: Diff = {
  diff_id: "d-003",
  intent: INTENT_3,
  operations: [
    {
      op: "add_table",
      table: {
        id: "tags",
        name: "タグ",
        fields: [{ id: "label", name: "名前", type: "text", required: true }],
      },
    },
    {
      op: "add_field",
      table: "books",
      field: { id: "tag", name: "タグ", type: "reference", reference_table: "tags" },
    },
  ],
};

/** 差分を適用する。失敗したらテストの前提が崩れているので即座に落とす。 */
function apply(diff: Diff): void {
  const result = applyDiff(dataRoot, APP_ID, diff);
  if (!result.valid) {
    throw new Error(
      `テスト前提の差分適用に失敗しました(${diff.diff_id}): ${JSON.stringify(result.errors)}`,
    );
  }
}

/** 基本の3差分を入れる(テーブル2・ビュー3)。 */
function seedBase(): void {
  apply(DIFF_1);
  apply(DIFF_2);
  apply(DIFF_3);
}

/** ワークフロー(実行履歴テーブル付き)と関数(コードの島)を足す。 */
function seedAutomation(): void {
  apply({
    diff_id: "d-010",
    intent: "自動化と関数の記録先テーブルを用意する",
    operations: [
      {
        op: "add_table",
        table: {
          id: "wf-runs",
          name: "実行履歴",
          fields: [
            { id: "ran_at", name: "実行時刻", type: "date" },
            { id: "workflow", name: "ワークフロー", type: "text" },
            { id: "trigger_type", name: "きっかけ", type: "text" },
            { id: "status", name: "結果", type: "text" },
            { id: "error", name: "エラー", type: "long_text" },
          ],
        },
      },
      {
        op: "add_table",
        table: {
          id: "monthly-counts",
          name: "月次集計",
          fields: [
            { id: "month", name: "月", type: "text" },
            { id: "count", name: "件数", type: "number" },
          ],
        },
      },
    ],
  });
  apply({
    diff_id: "d-011",
    intent: "本が登録されたら月次集計を数え直す",
    operations: [
      {
        op: "add_function",
        function: {
          id: "count-by-month",
          name: "月ごとに本を数える",
          code: "export default (rows) => rows;",
          input: { source: "table", table: "books" },
          output: {
            fields: [
              { id: "month", type: "text" },
              { id: "count", type: "number" },
            ],
          },
          capabilities: [],
        },
      },
      {
        op: "add_workflow",
        workflow: {
          id: "recount-on-new-book",
          name: "本が増えたら数え直す",
          trigger: { type: "on_create", table: "books" },
          actions: [
            {
              action: "create_record",
              table: "wf-runs",
              values: { workflow: "recount-on-new-book" },
            },
            { action: "run_function", function: "count-by-month", output_table: "monthly-counts" },
          ],
          history_table: "wf-runs",
        },
      },
    ],
  });
}

/**
 * 外部到達アクション(`call_external`)と AI 呼び出し(`ai_transform`)を持つ自動化を足す。
 *
 * **ADR-0025 改訂1 が埋めた欠落の試材である** —— 改訂前は「外部へ送信する動作がある」
 * までしか文書に出ず、**どこへ何を送るかが1文字も書かれなかった。**
 * 実行されるかどうかは capability の有無で実行層が決めるが(ADR-0020 / ADR-0021)、
 * **マニフェストに書いてある以上、要件定義書には出なければならない。**
 */
function seedExternalAndAi(): void {
  apply({
    diff_id: "d-014",
    intent: "本が登録されたらチームに知らせて、メモを AI に要約させたい",
    operations: [
      {
        op: "add_workflow",
        workflow: {
          id: "notify-and-summarize",
          name: "登録を知らせて要約する",
          trigger: { type: "on_create", table: "books" },
          actions: [
            {
              action: "call_external",
              connection: "team-chat",
              destination: "https://example.com/hooks/books",
              payload: { title: "$record.title", note: "新しい本が登録されました" },
            },
            {
              action: "ai_transform",
              capability: "summarizer",
              prompt: "本のメモを1文に要約してください。",
              input: { source_text: "$record.memo" },
              output_field: "memo",
              fallback: "要約できませんでした",
            },
          ],
          history_table: "wf-runs",
        },
      },
    ],
  });
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-requirements-doc-"));
  store = KernelMetaStore.open(dataRoot);
  createApp(store, APP_NAME, { app_id: APP_ID });
});

afterEach(async () => {
  store.close();
  await rm(dataRoot, { recursive: true, force: true });
});

// --- 監査側のユーティリティ(生成器の内部を1行も使わない) -------------------------

/** 引用ブロック行(`> ` 始まり)を、改行ごと取り除く。 */
function stripQuoteBlocks(markdown: string): string {
  return markdown.replace(/^> .*\n?/gm, "");
}

/** バッククォートスパンの中身を順に返す(引用ブロックを除いた後に呼ぶこと)。 */
function backtickSpans(text: string): string[] {
  return [...text.matchAll(/`([^`]*)`/g)].map((m) => m[1] ?? "");
}

/** 鉤括弧スパンの中身を順に返す。 */
function bracketSpans(text: string): string[] {
  return [...text.matchAll(/「([^「」]*)」/g)].map((m) => m[1] ?? "");
}

/** RFC6901 の JSON Pointer で辿る(監査側の独立実装)。 */
function resolvePointer(root: unknown, pointer: string): unknown {
  if (pointer === "") {
    return root;
  }
  let current: unknown = root;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      current = current[Number(key)];
    } else if (typeof current === "object" && current !== null) {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return current;
}

/** `Record<string, Slot>` を配列として走る(型を緩めない)。 */
function slotsOf(statement: RequirementStatement): Slot[] {
  return Object.values(statement.slots);
}

/**
 * 残差が「断片の連結」に分解できるかを判定する(ADR-0025 §4-3)。
 * 単純な word-break DP。断片集合に無い文字が1つでも残れば false になる。
 */
function decomposable(text: string, fragments: string[]): { ok: boolean; rest: string } {
  const usable = [...new Set(fragments)].filter((f) => f.length > 0);
  const reachable = new Array<boolean>(text.length + 1).fill(false);
  reachable[0] = true;
  let furthest = 0;
  for (let i = 0; i <= text.length; i += 1) {
    if (!reachable[i]) {
      continue;
    }
    furthest = Math.max(furthest, i);
    for (const fragment of usable) {
      if (text.startsWith(fragment, i)) {
        reachable[i + fragment.length] = true;
      }
    }
  }
  return { ok: reachable[text.length] === true, rest: text.slice(furthest, furthest + 120) };
}

/** テンプレート本文を `{slot}` で割った断片(ADR-0025 §4-3 の「テンプレート断片」)。 */
function templateFragments(): string[] {
  return Object.values(REQUIREMENT_TEMPLATES).flatMap((body) => body.split(/\{[a-z_]+\}/));
}

/**
 * 文書骨格の断片。**`renderRequirementsMarkdown([])` から導く** ——
 * 見出し・前書き・注記はいずれも statements に依存しない定数なので、
 * 空入力の出力がそれらの全体になる(ADR-0025 §5 辺1)。
 */
function skeletonFragments(): string[] {
  return [...renderRequirementsMarkdown([]).split("\n").filter(Boolean), "\n"];
}

/** カーネルの語彙定数 + 型リテラル由来の語彙(生成器の定数表を借りずに書き下す)。 */
const VOCABULARY_VALUES: readonly string[] = [
  ...FIELD_TYPES,
  ...VIEW_TYPES,
  ...DIFF_OPS,
  ...SORT_ORDERS,
  "apply",
  "undo",
  "on_create",
  "on_update",
  "schedule",
  "create_record",
  "update_record",
  "call_external",
  "ai_transform",
  "run_function",
  "table",
  "view",
  "record",
];

/** 実在集合(識別子)。**生成器の `identifiers` を使わずに独立に組み立てる**(§4-6 の作法)。 */
function realIdentifiers(manifest: Manifest, entries: ChangelogEntry[]): Set<string> {
  const app = manifest.app;
  const ids = [
    app.id,
    ...app.tables.map((t) => t.id),
    ...app.tables.flatMap((t) => t.fields.map((f) => f.id)),
    ...app.views.map((v) => v.id),
    ...(app.workflows ?? []).map((w) => w.id),
    ...(app.functions ?? []).map((f) => f.id),
    ...(app.functions ?? []).flatMap((f) => (f.output.fields ?? []).map((o) => o.id)),
    ...SYSTEM_TABLES.map((t) => t.id),
    ...SYSTEM_TABLES.flatMap((t) => t.fields.map((f) => f.id)),
    ...entries.map((e) => e.diff_id),
    ...entries.map((e) => e.applied_at),
    // **【`V8-M22` / 台帳 `J-G34a` / `ADR-0315`】役割の識別子とボタンの識別子。**
    // **生成器の `buildIdentifierSets` を1行も借りず、監査と同じくマニフェストを
    // 独立に読んで組み立てる**(§4-6 の作法)。
    ...(app.roles ?? []).map((role) => role.id),
    ...app.views.flatMap((view) =>
      ("actions" in view ? ((view.actions ?? []) as { id?: string }[]) : []).flatMap((action) =>
        action.id === undefined ? [] : [action.id],
      ),
    ),
    ...historicalIdentifiers(entries),
  ];
  return new Set(ids);
}

/**
 * **changelog の `operations` に現れた識別子**(ADR-0025 改訂2)。
 *
 * 生成器の `historicalIdentifierSets` を1行も借りず、監査と同じく changelog を
 * 独立に読んで組み立てる(§4-6 の作法)。**マニフェストの実在集合とは別物である** ——
 * 消された画面・改名前のフィールドはここにしか無い(§限界13)。
 */
function historicalIdentifiers(entries: ChangelogEntry[]): string[] {
  return entries.flatMap((entry) =>
    entry.operations.flatMap((op) => {
      switch (op.op) {
        case "add_table":
          return [op.table.id, ...op.table.fields.map((f) => f.id)];
        case "remove_table":
          return [op.table];
        case "change_table":
          return op.changes.id === undefined ? [op.table] : [op.table, op.changes.id];
        case "add_field":
          return [op.table, op.field.id];
        case "remove_field":
          return [op.table, op.field];
        case "change_field":
          return op.changes.id === undefined
            ? [op.table, op.field]
            : [op.table, op.field, op.changes.id];
        case "add_view":
          return [op.view.id];
        case "update_view":
        case "remove_view":
          return [op.view];
        case "add_workflow":
        case "update_workflow":
        case "remove_workflow":
          return [op.workflow.id];
        case "add_function":
        case "update_function":
        case "remove_function":
          return [op.function.id];
        case "set_theme":
          // **V3-M1-T03(ADR-0047。16種目の op)。識別子を1つも返さない。**
          // テーマは対象IDを取らず(app に1つしか無い)、`origin.template_app_id` は
          // **カーネルが実在を検証しない別アプリのID**なので集めない(ADR-0047 限定7)。
          // 生成側(`historicalIdentifierSets`)と同じ規則をここで独立に再現している
          // (§4-6: 生成器と集合構築を共有しない)。
          return [];
        case "set_roles":
          // **V8-M16-T03(台帳 J-G1b。18種目の op)。識別子を1つも返さない。**
          // **宣言は対象IDを取らない**(役割の一覧は app に1つしか無い)。**宣言された
          // 役割の識別子(`owner` / `member` など)も集めない** —— テーブル・フィールド・
          // ビュー・ワークフロー・関数のどれでもなく、監査側が持つ5集合のどれにも属さない。
          // **生成側(`historicalIdentifierSets`)と同じ規則をここで独立に再現している。**
          // **この網羅性の番人は実際に働いた** —— 本タスクではまず
          // `tsc` が `Type 'SetRolesOperation' is not assignable to type 'never'` で落ちた。
          return [];
        // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11`。判定値 = 廃止】**
        // **`set_user_kinds` が `DiffOperation` の union から消えたので、この `case` は
        // 型として到達できなくなった**(`tsc` が
        // `TS2678: Type '"set_user_kinds"' is not comparable to type ...` で落ちた)。
        // **分岐だけを外し、逐語は残す。****網羅性の番人(下の `default` の `never` 検査)は
        // 1バイトも弱めていない** —— **むしろこの撤去を型で検出したのはその番人である。**
        // **旧(逐語)**:
        //     `case "set_user_kinds":`
        //       `// **V5-M17b(ADR-0248。17種目の op)。識別子を1つも返さない。**`
        //       `// **宣言は対象IDを取らない**(app に1つしか無い)。**宣言された種類の識別子`
        //       `// (\`member\` など)も集めない** —— テーブル・フィールド・ビュー・ワークフロー・`
        //       `// 関数のどれでもなく、監査側が持つ5集合のどれにも属さないためである。`
        //       `// **生成側(\`historicalIdentifierSets\`)と同じ規則をここで独立に再現している。**`
        //       `// **この網羅性の番人は実際に働いた** —— 本タスクではまず`
        //       `// \`tsc\` が \`Type 'SetUserKindsOperation' is not assignable to type 'never'\` で落ちた。`
        //       `return [];`
        default: {
          // **網羅性の番人。** 差分 op が増えたのにここを直し忘れると
          // `never` への代入が型エラーになる —— 監査側の集合が静かに古くなるのを防ぐ。
          const exhaustive: never = op;
          throw new Error(`未知の op が changelog にあります: ${JSON.stringify(exhaustive)}`);
        }
      }
    }),
  );
}

/**
 * 実在集合(表示名 + capability 名 + アクションの項目名)。
 *
 * 鉤括弧スパンの照合先。**capability 名とアクションの項目名は自己言及的**である
 * (ADR-0025 §限界6 / 改訂1)—— マニフェスト上の値そのものからしか作れないので、
 * 照合できるのは「他のパスから来た値が混ざっていないこと」までである。
 */
function realNames(manifest: Manifest): Set<string> {
  const app = manifest.app;
  const actions = (app.workflows ?? []).flatMap((w) => w.actions);
  const names = [
    app.name,
    ...app.tables.map((t) => t.name),
    ...app.tables.flatMap((t) => t.fields.map((f) => f.name)),
    ...app.views.flatMap((v) => (v.name === undefined ? [] : [v.name])),
    ...(app.workflows ?? []).map((w) => w.name),
    ...(app.functions ?? []).map((f) => f.name),
    ...(app.functions ?? []).flatMap((f) => f.capabilities ?? []),
    ...actions.flatMap((a) => (a.action === "call_external" ? [a.connection] : [])),
    ...actions.flatMap((a) => (a.action === "ai_transform" ? [a.capability] : [])),
    ...actions.flatMap((a) => (a.action === "call_external" ? Object.keys(a.payload) : [])),
    ...actions.flatMap((a) => (a.action === "ai_transform" ? Object.keys(a.input) : [])),
    ...actions.flatMap((a) =>
      a.action === "create_record" || a.action === "update_record" ? Object.keys(a.values) : [],
    ),
    // **【`V8-M22` / 台帳 `J-G34a` / `ADR-0315`】役割の表示名(`app.roles[].name`)。**
    // **`_name` で終わるグループなので鉤括弧で描かれる**(`ADR-0025` §4-2)。
    ...(app.roles ?? []).flatMap((role) => (role.name === undefined ? [] : [role.name])),
    ...SYSTEM_TABLES.map((t) => t.name),
    ...SYSTEM_TABLES.flatMap((t) => t.fields.map((f) => f.name)),
  ];
  return new Set(names);
}

/** 生成物と、その材料(独立に読み直したもの)。 */
function generateWithMaterials(): {
  doc: RequirementsDoc;
  manifest: Manifest;
  entries: ChangelogEntry[];
} {
  return {
    doc: generateRequirementsDoc(dataRoot, APP_ID),
    manifest: readCurrentManifest(dataRoot, APP_ID),
    entries: getChangelog(dataRoot, APP_ID),
  };
}

// --- テスト -------------------------------------------------------------------

describe("テンプレート定数表の不変条件(ADR-0025 §3)", () => {
  test("スロット記法以外にバッククォート・鉤括弧・行頭の引用記号を含まない", () => {
    // これが崩れるとスパン抽出(§4-2)が定義できなくなり、残差検査も識別子照合も
    // 「区切りは文書の側が与える」という前提を失う。
    for (const [id, body] of Object.entries(REQUIREMENT_TEMPLATES)) {
      expect(`${id}:${body}`).not.toContain("`");
      expect(`${id}:${body}`).not.toContain("「");
      expect(`${id}:${body}`).not.toContain("」");
      for (const line of body.split("\n")) {
        expect(`${id}:${line}`).not.toMatch(/^> /);
      }
    }
  });

  test("逐語引用のスロットはテンプレート末尾の1行にだけ置ける(最大1つ)", () => {
    // §3 不変条件2。逐語引用は引用ブロックへ先に隔離されるので区切り文字を含んでよいが、
    // 行の途中に置けてしまうと隔離が成立しない。
    for (const [id, body] of Object.entries(REQUIREMENT_TEMPLATES)) {
      const lines = body.split("\n");
      expect(`${id}:${lines.length}`).toMatch(/^[a-z._]+:[12]$/);
      if (lines.length === 2) {
        expect(`${id}:${lines[1]}`).toMatch(/^[a-z._]+:\{[a-z_]+\}$/);
      }
    }
  });

  test("テンプレートIDの union と定数表のキー集合が完全一致する", () => {
    // §3 不変条件3。片方だけ増やせないことを型と実体の両方で固定する。
    const keys = Object.keys(REQUIREMENT_TEMPLATES).sort();
    const union: RequirementTemplateId[] = [
      "overview.identity",
      "overview.created",
      "overview.scale",
      "features.table",
      "features.view",
      "features.workflow",
      "features.function",
      // **【`V8-M22` / 台帳 `J-G34a` / ユーザ決定 `D-V8-36`(2026-08-10)/ `ADR-0315`】**
      // **`app.roles`(役割と、その役割ができること)を述べる14本。**
      // **内訳**: 名前2本 + できること7本(対象4種 × 書ける動詞)+ 条件5本。
      // **「できないと宣言している」側の本は1本も無い** —— **`can` の値域に否定が
      // 1つも無いためである**(台帳 `J-G2` の限定)。**`ADR-0300` の `_no_read` 群とは
      // 形が違うが、それは対症ではなく値域の違いである。**
      // **役割の付与状況(誰がその役割を持っているか)を述べる本も1本も無い** ——
      // **それはアプリの定義ではなく利用者のデータである。**
      "features.role",
      "features.role_name",
      "features.role_rule_table_read",
      "features.role_rule_table_write",
      "features.role_rule_table_delete",
      "features.role_rule_field_read",
      "features.role_rule_field_write",
      "features.role_rule_view_read",
      "features.role_rule_action_read",
      "features.role_condition_and",
      "features.role_condition_or",
      "features.role_condition_not",
      "features.role_condition_equals",
      "features.role_condition_equals_current_user",
      // **【`V8-M26` / ユーザ決定 `D-V8-70`(2026-08-11)】葉の3種目(その項目が空か)。**
      "features.role_condition_is_empty",
      "screens.target",
      "screens.display_name",
      "screens.column",
      "screens.item",
      "screens.sort",
      "screens.filter",
      // ADR-0068 A6(V3-M13-T12)。`view.related` / `view.actions` の3件。
      "screens.related",
      "screens.related_column",
      "screens.action",
      // ADR-0068 B群(V3-M13-T12)。`list_view.filter` のブール式。**ちょうど9本である**(B2)。
      "screens.filter_and",
      "screens.filter_or",
      "screens.filter_not",
      "screens.filter_equals",
      "screens.filter_contains",
      "screens.filter_gte",
      "screens.filter_lte",
      "screens.filter_in",
      "screens.filter_in_value",
      // **ADR-0126 A1(V4-M32-T01)。v4 が `$defs/view` に足した8キーを述べる11本。**
      // **A2 の14キーのうち view 側の8キーがここに当たる。**
      // **【`V8-M20` / 台帳 `J-G27` / `ADR-0301`】`"screens.audience"` をこの列から
      // 落とした。****旧: この位置に `"screens.audience"` が並んでいた**(11本の1本目)。
      // **`$defs/view/properties/audience` が廃止されたので、テンプレートごと撤去した。**
      // **検査そのものは1本も消していない**(節ごとの並びの固定は今日も守っている)。
      "screens.menu_listed",
      "screens.menu_unlisted",
      "screens.field_group",
      "screens.field_group_item",
      "screens.modal",
      "screens.non_modal",
      "screens.search_field",
      "screens.page_size",
      "screens.after_save",
      "screens.sum_field",
      // V4-M39-T01 / ADR-0144 A1(9本)。**画面の見せ方のプリセット9キー。**
      "screens.preset_column_align",
      "screens.preset_column_width",
      "screens.preset_pager_position",
      "screens.preset_label_placement",
      "screens.preset_field_columns",
      "screens.preset_image_size",
      "screens.preset_text_preview",
      "screens.preset_list_shape",
      "screens.preset_density",
      // V4-M39-T01 / ADR-0145 A1(2本)。**逃げ道(任意 CSS)への参照。**
      "screens.custom_css",
      "screens.custom_css_digest",
      // **【`V6-M6-T02` / `K-G2` / `K-G21b` / `ADR-0291` A1】** 入力画面ごとの
      // 参照項目の選び方の上書きを述べる3本(有限3値それぞれ1本)。
      "screens.reference_picker_list",
      "screens.reference_picker_type_filter",
      "screens.reference_picker_search",
      // **【`V8-M13-T03` / 台帳 `Q-G31a`(限定採用)/ `Q-G31b`(保留 → 再審査して限定採用)】**
      // **集計表の中身を述べる12本**(束ねるキー6 + 集計3 + 突き合わせ1 + グラフ2)。
      // **有限値(粒度3・グラフ2)はそれぞれ1本ずつ置いてあり、20件目の語彙グループを
      // 作っていない** —— **すぐ上の `reference_picker` 3本と同じ形である。**
      "screens.report_group_by",
      "screens.report_group_by_row",
      "screens.report_group_by_table",
      "screens.report_group_by_day",
      "screens.report_group_by_week",
      "screens.report_group_by_month",
      "screens.report_aggregate_count",
      "screens.report_aggregate_sum",
      "screens.report_aggregate_table",
      "screens.report_join",
      "screens.report_chart_bar",
      "screens.report_chart_line",
      "data.table",
      "data.field",
      "data.field_required",
      "data.field_optional",
      "data.field_option",
      "data.field_reference",
      // **ADR-0126 A1(V4-M32-T01)。v4 が `$defs/field` に足した6キーを述べる9本。**
      "data.field_unique",
      "data.field_unique_owner",
      "data.field_not_unique",
      // **【`V8-M20` / 台帳 `J-G28` / `ADR-0301`】`"data.field_audience"` と
      // `"data.field_writable_by"` をこの列から落とした。****旧: この位置に2本が
      // 並んでいた。****`$defs/field` の `audience` / `writable_by` と
      // `$defs/field_changes` の `writable_by` が廃止されたので、テンプレートごと撤去した。**
      "data.field_unit",
      "data.field_emphasis",
      "data.field_hide_when_empty",
      "data.field_show_when_empty",
      // **【`V6-M6-T02` / `K-G1` / `K-G21b` / `ADR-0291` A1】** 参照項目の選び方を
      // 述べる3本(有限3値それぞれ1本)。
      // **`reference_search_fields`(探せる項目)の分は1本も無い** ——
      // **ユーザ決定 `D-V6-21` により出さないと決めたためである。**
      "data.field_reference_picker_list",
      "data.field_reference_picker_type_filter",
      "data.field_reference_picker_search",
      // **【`V7-M6-T03` / `Z-G28`】アクセス権管理の宣言を述べる12本。**
      // **出すのは4項目に閉じる**((a) 使うこと /(b) 権限名と読む・書く・消すの組 /
      // (c) 付与表・メンバー表・グループ表の名前 /(d) `inherit_from` の参照項目)。
      // **`creator_permission` を述べる本は1本も無い**(5項目目を足さないため)。
      "data.table_access_control",
      "data.table_access_permission",
      "data.table_access_permission_read",
      "data.table_access_permission_no_read",
      "data.table_access_permission_write",
      "data.table_access_permission_no_write",
      "data.table_access_permission_delete",
      "data.table_access_permission_no_delete",
      "data.table_access_grant_table",
      "data.table_access_member_table",
      "data.table_access_group_table",
      "data.table_access_inherit_from",
      "automation.workflow",
      "automation.trigger_on_create",
      "automation.trigger_on_update",
      "automation.trigger_schedule",
      // ADR-0068 A4 / A5(V3-M13-T12)。`schedule` の `table` と `older_than`。
      "automation.trigger_schedule_table",
      "automation.trigger_schedule_older_than",
      // **【`V5-M25-T01` / `L-G8` / `ADR-0174`】4値目 `manual` の文。**
      "automation.trigger_manual",
      "automation.action",
      "automation.action_target_table",
      // ADR-0068 A1 / A2(V3-M13-T12)。`update_record` の `target` と、全種の `when`。
      "automation.action_target",
      "automation.action_when",
      "automation.action_run_function",
      "automation.action_run_function_write_back",
      // ADR-0068 A7(V3-M13-T12)。第3の書込モード `write_ops`(ADR-0067)。
      "automation.action_run_function_write_ops",
      // ADR-0025 改訂1(2026-07-23)で足した9件。「外部へ送信する動作があるが、
      // どこへ何を送るかは書いていない」文書になる欠落を埋めるためのもの。
      "automation.action_connection",
      "automation.action_destination",
      "automation.action_payload",
      "automation.action_value",
      "automation.action_ai_capability",
      "automation.action_ai_prompt",
      "automation.action_ai_input",
      "automation.action_ai_output_field",
      "automation.action_ai_fallback",
      "automation.function",
      "automation.function_input_table",
      "automation.function_input_view",
      "automation.function_input_record",
      // ADR-0068 A3(V3-M13-T12)。`function.input` の配列形(位置つき3本)。
      "automation.function_input_table_at",
      "automation.function_input_view_at",
      "automation.function_input_record_at",
      "automation.function_output_field",
      // ADR-0068 A7(V3-M13-T12)。`function.output.ops`(ADR-0067)。
      "automation.function_output_ops",
      "automation.function_capability",
      "history.applied",
      "history.intent",
      "history.operation",
      // ADR-0025 改訂2(2026-07-23)で足した7件。操作の「対象」を述べる。
      // これが無いと履歴節が「add_view が7回」としか書かず、どの画面を足したのかが
      // 1つも分からない(実データ data-demo/reading-log で判明した欠落)。
      "history.operation_table",
      "history.operation_field",
      "history.operation_view",
      "history.operation_workflow",
      "history.operation_function",
      "history.operation_rename_table",
      "history.operation_rename_field",
      "history.undo",
      "history.undone",
    ];
    expect(keys).toEqual([...union].sort());
  });

  /**
   * **`ADR-0025` 限定6 / `ADR-0126` B6・C1(`V4-M32-T01`)。**
   *
   * **`renderStatementText` を1バイトも変えていないこと**の代わりの検査である。
   * **`ADR-0068` の実装(`V3-M13-T12`)は「`const PLACEHOLDER_RE` から
   * `renderRequirementsMarkdown` の直前までを実装前後で `diff` して0行」で確かめたが、
   * それは実装の前後を並べる作業であってテストには書けない**(テストは HEAD の1点しか
   * 見られない)。**そこで `ADR-0025` 改訂4 の先例に倣い、テンプレート本文の側から
   * 「ミニ言語になっていない」ことを全数で押さえる。**
   *
   * **この検査が押さえられるのは「テンプレートがミニ言語の記法を含まないこと」までで、
   * `renderStatementText` の本体が単純置換のままであることは押さえていない。**
   * **正直に書く: レンダラ本体の不変性は、今日も人間のレビューに頼っている。**
   */
  test("テンプレート本文はミニ言語になっていない(スロット記法以外に記法が1件も無い)", () => {
    // `{name}` を取り除いた残りに、繰り返し・条件分岐・演算子・変数展開の記法が1つも無いこと。
    const FORBIDDEN = ["{", "}", "#if", "#each", "%", "||", "&&", "?", "$", "+"];
    const bodies = Object.entries(REQUIREMENT_TEMPLATES);
    // **95本ちょうどを見ていることを数で残す**(ADR-0126 A1)。
    // **【V4-M39-T01 / ADR-0144 A1(9本)+ ADR-0145 A1(2本)で 95 → 106 に更新した】**
    // **【`V5-M25-T01` / `ADR-0174` で 106 → 107 に更新した】** **旧: `toHaveLength(106)`。**
    // **増えたのは `automation.trigger_manual` の1本だけである。**
    // **【`V6-M6-T02` / `K-G21b` / `ADR-0291` A1 で 107 → 113 に更新した】**
    // **増えたのは参照項目の選び方の6本である**(項目側3本 + 入力画面側3本)——
    // **有限3値のそれぞれに1本ずつ置き、20件目の語彙グループを作らなかった。**
    // **`reference_search_fields` の分は1本も増えていない**(`D-V6-21`)。
    // **【`V7-M6-T03` / `Z-G28` で 113 → 125 に更新した】** **旧: `toHaveLength(113)`。**
    // **増えたのはアクセス権管理の宣言を述べる12本である**((a) 1本 /(b) 権限1件につき
    // 4本 = 名前1 + 真偽3の6本 /(c) 3本 /(d) 1本 —— **真偽を別の文にしたので
    // (b) だけで7本になる**)。**`creator_permission` の分は1本も無い。**
    // **【`V8-M20` / 台帳 `J-G27` / `J-G28` / `ADR-0301` で 125 → 122 に更新した】**
    // **旧: `toHaveLength(125)`。** **減ったのは `screens.audience` /
    // `data.field_audience` / `data.field_writable_by` の3本である** ——
    // **このファイルでテンプレートの本数が減るのは初めてである。**
    // **根拠にしていた宣言(`$defs/view` の `audience`、`$defs/field` の
    // `audience` / `writable_by`)がスキーマから消えたためであり、
    // 「文を出さないと決めた」のではない。**
    // **【`V8-M22` / 台帳 `J-G34a` / ユーザ決定 `D-V8-36` / `ADR-0315` で 122 → 136 に更新した】**
    // **旧: `toHaveLength(122)`。** **増えたのは役割を述べる14本である**
    // (名前2 + できること7 + 条件5)。**出すと決めたのは 2026-08-10 のユーザである。**
    // **【`V8-M26` / 台帳 `D-V8-70`(2026-08-11)で 136 → 137 に更新した】**
    // **旧: `toHaveLength(136)`。** **増えたのは葉の3種目を述べる
    // `features.role_condition_is_empty` の1本ちょうどである**(減った本数・改名は0)。
    // **この test が固定している本数はこの1本ぶんしか動いていない。**
    // **【`V8-M13-T03` / 台帳 `Q-G31a` / `Q-G31b` で 137 → 149 に更新した】**
    // **旧: `toHaveLength(137)`。** **増えたのは集計表の中身を述べる12本ちょうどである**
    // (束ねるキー6 + 集計3 + 突き合わせ1 + グラフ2)。**減った本数・改名は0である。**
    expect(bodies).toHaveLength(149);
    for (const [id, body] of bodies) {
      const withoutSlots = body.replace(/\{[a-z_]+\}/g, "");
      for (const token of FORBIDDEN) {
        expect(`${id}:${withoutSlots}`).not.toContain(token);
      }
    }
  });
});

describe("テスト1・2・3: 入口と第0行の帰属(ADR-0025 §8-2)", () => {
  test("1: 存在しない app_id は空文書で誤魔化さず明確なエラーにする(憲法6)", () => {
    expect(() => generateRequirementsDoc(dataRoot, "no-such-app")).toThrow(/no-such-app/);
    expect(() => generateRequirementsDoc(dataRoot, "no-such-app")).toThrow(
      /台帳に登録されていません/,
    );
  });

  test("2: create_app 直後でも overview が生成され、出典に第0行が入る", () => {
    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    const overview = doc.statements.filter((s) => s.section === "overview");
    expect(overview.length).toBeGreaterThanOrEqual(3);

    const created = overview.find((s) => s.template === "overview.created");
    expect(created).toBeDefined();
    expect(
      created?.sources.some((s) => s.kind === "changelog" && s.diff_id === "_create-app"),
    ).toBe(true);
  });

  test("3: 第0行(snapshot === null)が帰属から落ちない —— M8 が M0/F-28 に依存する理由", () => {
    // ADR-0025 §8-2: attribution の条件は kind === "apply" かつ未取り消しの2つだけで、
    // **`snapshot !== null` を条件に入れてはならない**。入れると第0行が消え、
    // 「このアプリが作られた」という最も重要な事実の出典が失われる。
    seedBase();
    const entries = getChangelog(dataRoot, APP_ID);
    const zeroth = entries[0];
    expect(zeroth?.diff_id).toBe("_create-app");
    expect(zeroth?.snapshot).toBeNull();

    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    const usesZeroth = doc.statements.some((s) =>
      s.sources.some((src) => src.kind === "changelog" && src.seq === zeroth?.seq),
    );
    expect(usesZeroth).toBe(true);
  });
});

describe("テスト4: manifest 出典と changelog 出典の両方が付く", () => {
  test("data / screens の各 statement が manifest と diff_id の双方を出典に持つ", () => {
    seedBase();
    const doc = generateRequirementsDoc(dataRoot, APP_ID);

    const targeted = doc.statements.filter((s) => s.section === "data" || s.section === "screens");
    expect(targeted.length).toBeGreaterThan(0);
    for (const statement of targeted) {
      expect(statement.sources.some((s) => s.kind === "manifest")).toBe(true);
      expect(statement.sources.some((s) => s.kind === "changelog")).toBe(true);
    }

    // 具体例: books.rating は d-002 で足された。
    const rating = doc.statements.find(
      (s) =>
        s.template === "data.field" &&
        s.slots.field_id?.kind === "id" &&
        (s.slots.field_id as { value: string }).value === "rating",
    );
    expect(rating).toBeDefined();
    expect(rating?.sources.some((s) => s.kind === "changelog" && s.diff_id === "d-002")).toBe(true);
  });
});

describe("テスト5〜8: 論証の4辺を全数検査する(ADR-0025 §5)", () => {
  beforeEach(() => {
    seedBase();
    seedAutomation();
    seedExternalAndAi();
  });

  test("5: 全 statement の sources が非空(確認方法2 の実行時確認)", () => {
    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    expect(doc.statements.length).toBeGreaterThan(0);
    for (const statement of doc.statements) {
      expect(statement.sources.length).toBeGreaterThan(0);
    }
  });

  test("6: markdown は renderRequirementsMarkdown(statements) の出力だけである(辺1)", () => {
    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    expect(renderRequirementsMarkdown(doc.statements)).toBe(doc.markdown);
  });

  test("7: text は renderStatementText(template, slots) の出力だけである(辺2)", () => {
    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    for (const statement of doc.statements) {
      expect(renderStatementText(statement.template, statement.slots)).toBe(statement.text);
    }
  });

  test("8: 全 verbatim スロットが出典の該当フィールド値とバイト一致する(辺3)", () => {
    const { doc, manifest, entries } = generateWithMaterials();
    let checked = 0;
    for (const statement of doc.statements) {
      for (const slot of slotsOf(statement)) {
        if (slot.kind !== "verbatim") {
          continue;
        }
        const source = slot.from.source;
        const root =
          source.kind === "manifest" ? manifest : entries.find((e) => e.seq === source.seq);
        expect(root).toBeDefined();
        const container = resolvePointer(root, source.pointer);
        expect(container).toBeDefined();
        const raw = (container as Record<string, unknown>)[slot.from.field];
        expect(typeof raw === "string" ? raw : String(raw)).toBe(slot.value);
        checked += 1;
      }
    }
    // 逐語引用が1件も無ければこの検査は空回りするので、下限を置く。
    expect(checked).toBeGreaterThan(0);
  });
});

describe("テスト9・10: markdown 側の照合(ADR-0025 §4)", () => {
  beforeEach(() => {
    seedBase();
    seedAutomation();
    seedExternalAndAi();
  });

  test("9: スパンの中身が実在集合・語彙と完全一致する(部分文字列マッチを使わない)", () => {
    const { doc, manifest, entries } = generateWithMaterials();
    const identifiers = realIdentifiers(manifest, entries);
    const names = realNames(manifest);
    const body = stripQuoteBlocks(doc.markdown);

    const spans = backtickSpans(body);
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) {
      if (/^-?[0-9]+$/.test(span)) {
        continue; // 数値スパンは識別子集合と照合しない(§4-4。捕まえないことを明記済み)
      }
      if (VOCABULARY_VALUES.includes(span)) {
        continue;
      }
      expect(identifiers.has(span)).toBe(true);
    }

    const brackets = bracketSpans(body);
    expect(brackets.length).toBeGreaterThan(0);
    for (const span of brackets) {
      expect(names.has(span)).toBe(true);
    }
  });

  test("10: 残差がテンプレート断片と文書骨格定数の連結に一致する(§4-3)", () => {
    // この検査が無いと確認方法3 は「甘い」のではなく**無意味**になる ——
    // 地の文に何を書いても通ってしまうからである。
    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    const residual = stripQuoteBlocks(doc.markdown)
      .replace(/`[^`]*`/g, "")
      .replace(/「[^「」]*」/g, "");
    const fragments = [...templateFragments(), ...skeletonFragments()];
    const verdict = decomposable(residual, fragments);
    expect(verdict.rest).toBe(verdict.ok ? verdict.rest : "");
    expect(verdict.ok).toBe(true);

    // **陰性対照**: 地の文に1文でも混ぜたら落ちること。これが無いと、この検査が
    // 「常に true を返す空回り」になっていても気づけない。
    const forged = `${residual}このアプリは外部の顧客データベースと同期する。`;
    expect(decomposable(forged, fragments).ok).toBe(false);
  });
});

describe("テスト11・12: undo の扱い(ADR-0025 §8-1 / §8-4)", () => {
  test("11: 取り消された apply は history に残るが、帰属の出典には使われない", () => {
    seedBase();
    const undone = undo(dataRoot, APP_ID);
    expect(undone.valid).toBe(true);

    const entries = getChangelog(dataRoot, APP_ID);
    const target = entries.find((e) => e.diff_id === "d-003");
    expect(target).toBeDefined();

    const doc = generateRequirementsDoc(dataRoot, APP_ID);

    // history には「取り消された」として現れる(§8-4: 履歴からは消さない)。
    const undoneStatement = doc.statements.find((s) => s.template === "history.undone");
    expect(undoneStatement).toBeDefined();
    expect(doc.markdown).toContain("`d-003`");

    // history 以外の節では出典に使わない(現在のマニフェストの根拠ではない)。
    const leaked = doc.statements
      .filter((s) => s.section !== "history")
      .some((s) => s.sources.some((src) => src.kind === "changelog" && src.seq === target?.seq));
    expect(leaked).toBe(false);
  });

  test("12: 取り消された差分で足したフィールドは data 節に現れない", () => {
    seedBase();
    expect(undo(dataRoot, APP_ID).valid).toBe(true);

    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    const dataFieldIds = doc.statements
      .filter((s) => s.section === "data")
      .flatMap((s) => slotsOf(s))
      .flatMap((slot) => (slot.kind === "id" && slot.group === "field_id" ? [slot.value] : []));
    // d-003 が足した books.tag と tags.label は巻き戻しで消えている。
    expect(dataFieldIds).not.toContain("tag");
    expect(dataFieldIds).not.toContain("label");
    expect(dataFieldIds).toContain("title");
  });
});

describe("テスト13・14・15・16: 各リソースが節に現れる", () => {
  test("13: ワークフローのトリガーとアクションが automation 節に出る", () => {
    seedBase();
    seedAutomation();
    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    const templates = doc.statements.map((s) => s.template);
    expect(templates).toContain("automation.workflow");
    expect(templates).toContain("automation.trigger_on_create");
    expect(templates).toContain("automation.action");
    expect(templates).toContain("automation.action_target_table");
    expect(templates).toContain("automation.action_run_function");
    // create_record が書き込む項目も1キー1記述で出る(改訂1)。
    expect(templates).toContain("automation.action_value");
  });

  test("13c: call_external の接続・宛先・送信内容が automation 節に出る(改訂1)", () => {
    // 改訂前の欠落: 「外部へ送信する動作がある」までしか出ず、**どこへ何を送るかが
    // 1文字も書かれなかった。** 要件定義書としてこれは実害がある。
    seedBase();
    seedAutomation();
    seedExternalAndAi();
    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    const templates = doc.statements.map((s) => s.template);
    expect(templates).toContain("automation.action_connection");
    expect(templates).toContain("automation.action_destination");
    expect(templates).toContain("automation.action_payload");

    // 接続名は鉤括弧、宛先と送信内容の値は逐語引用として出る。
    expect(doc.markdown).toContain("「team-chat」");
    expect(doc.markdown).toContain("> https://example.com/hooks/books");
    expect(doc.markdown).toContain("「title」");
    expect(doc.markdown).toContain("> $record.title");
    expect(doc.markdown).toContain("「note」");
    expect(doc.markdown).toContain("> 新しい本が登録されました");

    // payload は1キー = 1 statement(限定7 のスカラ原則)。
    const payloads = doc.statements.filter((s) => s.template === "automation.action_payload");
    expect(payloads).toHaveLength(2);
  });

  test("13d: ai_transform の capability・指示・入力・書き戻し先・失敗時の値が出る(改訂1)", () => {
    seedBase();
    seedAutomation();
    seedExternalAndAi();
    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    const templates = doc.statements.map((s) => s.template);
    expect(templates).toContain("automation.action_ai_capability");
    expect(templates).toContain("automation.action_ai_prompt");
    expect(templates).toContain("automation.action_ai_input");
    expect(templates).toContain("automation.action_ai_output_field");
    expect(templates).toContain("automation.action_ai_fallback");

    expect(doc.markdown).toContain("「summarizer」");
    // prompt は**逐語引用**である(マニフェスト由来の自由文字列なので verbatim が正しい)。
    expect(doc.markdown).toContain("> 本のメモを1文に要約してください。");
    expect(doc.markdown).toContain("> 要約できませんでした");
    // 書き戻し先は実在するフィールドIDなので、バッククォートの識別子スパンで出る。
    expect(doc.markdown).toContain("`memo`");
  });

  test("13b: on_update / schedule トリガーもそれぞれのテンプレートで出る", () => {
    seedBase();
    seedAutomation();
    apply({
      diff_id: "d-012",
      intent: "更新時と定時の自動化も足す",
      operations: [
        {
          op: "add_workflow",
          workflow: {
            id: "on-book-update",
            name: "本が更新されたら記録する",
            trigger: { type: "on_update", table: "books" },
            actions: [
              { action: "update_record", table: "wf-runs", target: "$record._id", values: {} },
            ],
            history_table: "wf-runs",
          },
        },
        {
          op: "add_workflow",
          workflow: {
            id: "nightly-recount",
            name: "毎晩数え直す",
            trigger: { type: "schedule", at: { hour: 3, minute: 30 } },
            actions: [
              {
                action: "run_function",
                function: "count-by-month",
                output_table: "monthly-counts",
              },
            ],
            history_table: "wf-runs",
          },
        },
      ],
    });
    const templates = generateRequirementsDoc(dataRoot, APP_ID).statements.map((s) => s.template);
    expect(templates).toContain("automation.trigger_on_update");
    expect(templates).toContain("automation.trigger_schedule");
  });

  test("14: 関数が automation 節に出る(入力 source 3種)", () => {
    seedBase();
    seedAutomation();
    apply({
      diff_id: "d-013",
      intent: "画面入力とレコード入力の関数も足す",
      operations: [
        {
          op: "add_function",
          function: {
            id: "from-view",
            name: "一覧の行を数える",
            code: "export default (rows) => rows;",
            input: { source: "view", view: "book-list" },
            output: { fields: [{ id: "count", type: "number" }] },
            capabilities: ["notify-slack"],
          },
        },
        {
          op: "add_function",
          function: {
            id: "from-record",
            name: "1レコードを整える",
            code: "export default (row) => [row];",
            input: { source: "record" },
            output: { fields: [{ id: "month", type: "text" }] },
          },
        },
      ],
    });
    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    const templates = doc.statements.map((s) => s.template);
    expect(templates).toContain("automation.function");
    expect(templates).toContain("automation.function_input_table");
    expect(templates).toContain("automation.function_input_view");
    expect(templates).toContain("automation.function_input_record");
    expect(templates).toContain("automation.function_output_field");
    expect(templates).toContain("automation.function_capability");
    expect(doc.markdown).toContain("「notify-slack」");
  });

  test("15: select の選択肢と reference の参照先が data 節に出る", () => {
    seedBase();
    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    const templates = doc.statements.map((s) => s.template);
    expect(templates).toContain("data.field_option");
    expect(templates).toContain("data.field_reference");
    // 選択肢は逐語引用(引用ブロック)として出る。
    expect(doc.markdown).toContain("> 技術書");
    expect(doc.markdown).toContain("> 小説");
  });

  test("16: list_view の sort(複合)と filter が screens 節に出る", () => {
    seedBase();
    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    const sorts = doc.statements.filter((s) => s.template === "screens.sort");
    expect(sorts).toHaveLength(2);
    expect(doc.statements.some((s) => s.template === "screens.filter")).toBe(true);
    expect(doc.statements.some((s) => s.template === "screens.display_name")).toBe(true);
    expect(doc.statements.some((s) => s.template === "screens.column")).toBe(true);
    expect(doc.statements.some((s) => s.template === "screens.item")).toBe(true);
  });

  test("16b: 単数オブジェクト表記の sort も同じ形で出る(normalizeSort の唯一の入口)", () => {
    seedBase();
    apply({
      diff_id: "d-020",
      intent: "並び順をタイトル順の1本にする",
      operations: [
        {
          op: "update_view",
          view: "book-list",
          changes: { sort: { field: "title", order: "asc" } },
        },
      ],
    });
    const sorts = generateRequirementsDoc(dataRoot, APP_ID).statements.filter(
      (s) => s.template === "screens.sort",
    );
    expect(sorts).toHaveLength(1);
  });
});

describe("テスト17: fail-closed(ADR-0025 §4-5 / §5 辺3)", () => {
  /** スキーマは通るが実在集合から外れるマニフェストを、検証を経ずに直接置く。 */
  function overwriteManifest(manifest: Manifest): void {
    writeFileSync(appManifestPath(dataRoot, APP_ID), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  test("実在しないフィールドIDを参照する画面があると throw する", () => {
    seedBase();
    const manifest = readCurrentManifest(dataRoot, APP_ID);
    const view = manifest.app.views.find((v) => v.id === "book-list");
    if (view === undefined || view.type !== "list_view") {
      throw new Error("テスト前提の list_view が見つかりません。");
    }
    view.columns = ["ghost-field"];
    overwriteManifest(manifest);

    expect(() => generateRequirementsDoc(dataRoot, APP_ID)).toThrow(/ghost-field/);
  });

  test("表示名に鉤括弧が混入していると throw する(区切りが壊れるため)", () => {
    seedBase();
    const manifest = readCurrentManifest(dataRoot, APP_ID);
    const table = manifest.app.tables.find((t) => t.id === "books");
    if (table === undefined) {
      throw new Error("テスト前提のテーブルが見つかりません。");
    }
    table.name = "本「一覧」";
    overwriteManifest(manifest);

    expect(() => generateRequirementsDoc(dataRoot, APP_ID)).toThrow();
  });

  test("renderStatementText はスロットの過不足と未知のテンプレートを拒否する", () => {
    expect(() =>
      renderStatementText("overview.identity", {
        app_id: { kind: "id", group: "app_id", value: "x" },
      }),
    ).toThrow();
    expect(() =>
      renderStatementText("data.field_required", {
        table_id: { kind: "id", group: "table_id", value: "books" },
        field_id: { kind: "id", group: "field_id", value: "title" },
        extra: { kind: "number", value: 1 },
      }),
    ).toThrow();
  });
});

describe("テスト18: 決定論(ADR-0025 §6)", () => {
  test("同じ入力から2回生成すると markdown も JSON も完全一致する", () => {
    seedBase();
    seedAutomation();
    seedExternalAndAi();
    const first = generateRequirementsDoc(dataRoot, APP_ID);
    const second = generateRequirementsDoc(dataRoot, APP_ID);
    expect(second.markdown).toBe(first.markdown);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  test("生成物に生成時刻・ホスト名・バージョン・パスを含めない", () => {
    seedBase();
    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    const serialized = JSON.stringify(doc);
    // dataRoot(一時ディレクトリの絶対パス)が1バイトも漏れないこと。
    expect(serialized).not.toContain(dataRoot);
    // changelog 由来の applied_at 以外の時刻が入っていないこと(現在時刻の年月日は
    // applied_at と同じ日になりうるので、比較は「applied_at 集合の外の ISO 文字列が無い」で行う)。
    const known = new Set(getChangelog(dataRoot, APP_ID).map((e) => e.applied_at));
    for (const match of serialized.matchAll(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g)) {
      expect(known.has(match[0])).toBe(true);
    }
  });
});

describe("テスト19: rename チェーンの追跡(ADR-0025 §8-3)", () => {
  test("rename 後のフィールドの帰属が rename 前の diff を出典に持つ", () => {
    seedBase();
    apply({
      diff_id: "d-030",
      intent: "タイトルという呼び方をやめて書名に統一する",
      operations: [
        { op: "change_field", table: "books", field: "title", changes: { id: "book_title" } },
      ],
    });

    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    const renamed = doc.statements.find(
      (s) =>
        s.template === "data.field" &&
        s.slots.field_id?.kind === "id" &&
        (s.slots.field_id as { value: string }).value === "book_title",
    );
    expect(renamed).toBeDefined();
    const diffIds = (renamed?.sources ?? []).flatMap((s) =>
      s.kind === "changelog" ? [s.diff_id] : [],
    );
    // rename 前に作られた d-001 を見失わないこと(見失っても sources は非空のままなので
    // 確認方法2 では気づけない —— だからここで直接固定する)。
    expect(diffIds).toContain("d-001");
    expect(diffIds).toContain("d-030");
  });

  test("テーブルの rename でもフィールドの帰属を見失わない", () => {
    seedBase();
    apply({
      diff_id: "d-031",
      intent: "本という呼び方をやめて蔵書に統一する",
      operations: [{ op: "change_table", table: "books", changes: { id: "volumes" } }],
    });

    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    const field = doc.statements.find(
      (s) =>
        s.template === "data.field" &&
        s.slots.field_id?.kind === "id" &&
        (s.slots.field_id as { value: string }).value === "memo",
    );
    const diffIds = (field?.sources ?? []).flatMap((s) =>
      s.kind === "changelog" ? [s.diff_id] : [],
    );
    expect(diffIds).toContain("d-001");
  });
});

describe("文書構成(ADR-0025 §7)", () => {
  test("6節すべての見出しと history 節の注記が出る", () => {
    seedBase();
    const markdown = generateRequirementsDoc(dataRoot, APP_ID).markdown;
    for (const heading of [
      "## 概要",
      "## 機能一覧",
      "## 画面",
      "## データ",
      "## 自動化",
      "## 履歴",
    ]) {
      expect(markdown).toContain(heading);
    }
    expect(markdown).toContain("intent は当時の記録であり、逐語でない場合がある。");
    expect(markdown).toContain("apply_diff");
    // 「直った」とは書かない(§F-12 の4)。
    expect(markdown).not.toContain("直った");
  });

  test("history 節に全行(apply / undo)が現れる", () => {
    seedBase();
    expect(undo(dataRoot, APP_ID).valid).toBe(true);
    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    const history = doc.statements.filter((s) => s.section === "history");
    const applied = history.filter((s) => s.template === "history.applied");
    const undone = history.filter((s) => s.template === "history.undo");
    // _create-app + d-001..d-003 = 4件の apply、undo が1件。
    expect(applied).toHaveLength(4);
    expect(undone).toHaveLength(1);
    expect(history.filter((s) => s.template === "history.intent")).toHaveLength(5);
  });

  test("改訂2: 履歴の各操作に「対象」が付き、どの画面・テーブルを触ったかが読める", () => {
    // 実データ(data-demo/reading-log)で見つかった欠落。改訂前の履歴節は
    // 「差分 d-001-initial の 3 番目の操作は add_view である」としか書かず、
    // **どの画面を足したのかが1つも分からなかった。**
    seedBase();
    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    const history = doc.statements.filter((s) => s.section === "history");

    // d-001 は add_table 1 + add_view 3、d-002 は add_field 2 + update_view 1、
    // d-003 は add_table 1 + add_field 1。対象の記述は操作と同数だけ出る。
    const operations = history.filter((s) => s.template === "history.operation");
    const targets = history.filter((s) => s.template.startsWith("history.operation_"));
    expect(operations.length).toBe(9);
    expect(targets.length).toBe(operations.length);

    // 「add_view が3回」ではなく、どの画面かが書いてある。
    const viewTargets = targets
      .filter((s) => s.template === "history.operation_view")
      .flatMap((s) => Object.values(s.slots))
      .flatMap((slot) =>
        slot.kind === "id" && slot.group === "historical_view_id" ? [slot.value] : [],
      );
    expect(viewTargets).toContain("book-list");
    expect(viewTargets).toContain("book-form");
    expect(viewTargets).toContain("book-detail");
  });

  test("改訂2: 消された画面の操作対象が履歴に出る(現在のマニフェストには無い)", () => {
    // `historical_view_id` を使わずマニフェストの実在集合に照合していたら、
    // **ここで fail-closed して生成が止まる。** それがこのテストの主眼である。
    seedBase();
    apply({
      diff_id: "d-040",
      intent: "詳細画面はいらないので消す",
      operations: [{ op: "remove_view", view: "book-detail" }],
    });

    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    // 現在のマニフェストには book-detail が無い。
    expect(doc.identifiers.view_id).not.toContain("book-detail");
    // それでも履歴には「何を消したか」が残る。
    expect(doc.identifiers.historical_view_id).toContain("book-detail");
    expect(doc.markdown).toContain("`remove_view`");
    const removed = doc.statements.filter(
      (s) =>
        s.template === "history.operation_view" &&
        Object.values(s.slots).some((slot) => slot.kind === "id" && slot.value === "book-detail"),
    );
    expect(removed.length).toBeGreaterThan(0);
  });

  test("改訂2: rename 前のフィールドIDと rename 後のIDが履歴に両方出る", () => {
    seedBase();
    apply({
      diff_id: "d-041",
      intent: "タイトルという呼び方をやめて書名に統一する",
      operations: [
        { op: "change_field", table: "books", field: "title", changes: { id: "book_title" } },
      ],
    });

    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    // 現在のマニフェストに title はもう無い。
    expect(doc.identifiers.field_id).not.toContain("title");
    expect(doc.identifiers.historical_field_id).toContain("title");

    const renames = doc.statements.filter((s) => s.template === "history.operation_rename_field");
    expect(renames).toHaveLength(1);
    const values = Object.values(renames[0]?.slots ?? {}).flatMap((slot) =>
      slot.kind === "id" ? [slot.value] : [],
    );
    expect(values).toContain("title");
    expect(values).toContain("book_title");
  });

  test("改訂2: 取り消された差分の操作対象も履歴に残る(§8-4)", () => {
    seedBase();
    expect(undo(dataRoot, APP_ID).valid).toBe(true);

    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    // d-003 は巻き戻されたので tags テーブルは現在のマニフェストに無い。
    expect(doc.identifiers.table_id).not.toContain("tags");
    // それでも「何が起きたか」は履歴に残る(取り消しは、起きなかったことにはしない)。
    expect(doc.identifiers.historical_table_id).toContain("tags");
    const targets = doc.statements.filter(
      (s) =>
        s.template === "history.operation_table" &&
        Object.values(s.slots).some((slot) => slot.kind === "id" && slot.value === "tags"),
    );
    expect(targets.length).toBeGreaterThan(0);
  });

  test("改訂2: ワークフローと関数の操作対象も出る", () => {
    seedBase();
    seedAutomation();
    const templates = generateRequirementsDoc(dataRoot, APP_ID).statements.map((s) => s.template);
    expect(templates).toContain("history.operation_workflow");
    expect(templates).toContain("history.operation_function");
  });

  test("statement の id は生成順の連番で、重複しない", () => {
    seedBase();
    const ids = generateRequirementsDoc(dataRoot, APP_ID).statements.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe("S-001");
    for (const id of ids) {
      expect(id).toMatch(/^S-\d{3,}$/);
    }
  });
});

/**
 * **`$defs/view` のキーのうち、要件ドキュメントに文を出すものの集合**(V3-M2-T01。完了条件6)。
 *
 * `docs/adr/0050-view-display-presets.md` 限界8 は「**プリセットは要件ドキュメントに1文も
 * 現れない**」と決めた(`related` / `actions` / テーマも既に1文も出していない)。
 * **問題は「出さない」ことではなく、「黙って落ちる」ことである** ——
 * `viewStatements` の view キーには**網羅性の番人(`const exhaustive: never`)が1つも無く**、
 * キーを足してもどのテストも赤くならない(`docs/plan/v3/records/v3-m2.md` §2-10 (B))。
 *
 * **そこで「出すものの集合」を明示的に列挙して固定する。** `$defs/view` に8つ目のキーが
 * 増えた瞬間にこの表が合わなくなり、**「文を出すのか出さないのか」を決めるまで赤いままになる。**
 * changelog の op 側が `const exhaustive: never` で守られているのと同じ役目を、
 * スキーマとの照合で果たす(view のキーは TypeScript の判別共用体ではないため、
 * `never` 代入の手口をそのまま使えない)。
 *
 * ---
 *
 * **【2026-08-01。V3-M13-T12 が「キー単位」から「キー × 形」へ広げた(`ADR-0068` D6)】**
 *
 * **理由(逐語)**: 「**`filter: true` の1マスでは『等値AND配列では出る / ブール式では
 * 出ない』が読めない**」。実際、旧表の `filter: true` の行にはその食い違いが**コメントで
 * しか**書かれておらず、機械的には読めなかった。
 *
 * **新しい作法を作っていない** —— 先例は `TRIGGER_KEY_EMITS_STATEMENT`(キー × トリガー
 * 種別)と `WORKFLOW_ACTION_KEY_EMITS_STATEMENT`(キー × アクション種別)であり、
 * 値も同じ3値(`Emission`)にした。**`$defs/view` の第2軸は「形」である** ——
 * schema の `allOf` が分岐する `type` の3値に、**`list_view` の `filter` が取る2つの形**
 * (等値AND配列 / ブール式)を掛けた4つで、これが「同じキーの現れ方が割れる」全パターンを覆う。
 */
describe("V3-M2-T01 / V3-M13-T12: view のキー × 形 のうち要件ドキュメントに文を出すものの集合", () => {
  /**
   * **画面の「形」。** schema の `allOf` は `type` の3値で分岐するが、
   * **`list_view` はさらに `filter` の形で割れる**(等値AND配列 / ブール式)ので4つになる。
   * `unwritable` の裏取りに使う schema の分岐は、下の `SCHEMA_BRANCH_OF_FORM` で対応づける。
   */
  /*
   * **【2026-08-15。`V8-M13-T03`。台帳 `Q-G31a` / `Q-G31b`】5形目 `report_view` を足した。**
   * **上の JSDoc(「`type` の3値」「4つで全パターンを覆う」)を1バイトも書き換えていないが、
   * 今日は偽である** —— **`V8-M8` が画面種別の4種目 `report_view` を足しており、
   * schema の `allOf` は今日5分岐である。**
   *
   * **足した理由**: **`V8-M8` は「第2軸に `report_view` を足していない」と申告して 29キー ×
   * 4形 = 116マスのまま `report` を「4形すべて `unwritable`」で置いた**(`v8-m8.md:498`)。
   * **本タスクが `report_view` の本文を出した今日、その表だけを読むと「`report` はどの形でも
   * 書けない = 1文も出ない」と読めてしまう** —— **表の役目(「文を出すのか出さないのかを
   * 決めるまで赤いまま」)が果たされない。**
   * **足す代わりに新たに書いた判断は 29マスちょうどである**(既存116マスは1マスも
   * 書き換えていない)。**`v8-m8.md:498` の「30キー × 5形 = 150マス」は実測と合わない** ——
   * **`$defs/view.properties` は今日 **29キー**であり、29 × 5 = **145マス**である。**
   */
  const VIEW_FORMS = [
    "list_view_equals_filter",
    "list_view_boolean_filter",
    "detail_view",
    "form",
    "report_view",
  ] as const;
  type ViewForm = (typeof VIEW_FORMS)[number];

  const SCHEMA_BRANCH_OF_FORM: Record<ViewForm, string> = {
    list_view_equals_filter: "list_view",
    list_view_boolean_filter: "list_view",
    detail_view: "detail_view",
    form: "form",
    report_view: "report_view",
  };

  /** `TRIGGER_KEY_EMITS_STATEMENT` / `WORKFLOW_ACTION_KEY_EMITS_STATEMENT` と同じ3値。 */
  type Emission = "emits" | "silent" | "unwritable";

  /**
   * **キー × 形 → 現れ方。28キー × 4形 = 112マス。**
   *
   * 「出さない」に倒すこと自体は判断であって不具合ではないが、
   * **判断を書かずに増やすことは許さない。**
   *
   * **【2026-08-04。`V4-M39-T01` / `ADR-0144` D7 が古い JSDoc を直した】** 旧記述は
   * 「**18キー × 4形 = 72マス**」であり、`ADR-0126` が28キーに増やした時点で事実で
   * なくなっていた(審査記録 `v4-m39-gate-a.md` §1-5 の 1 が実測して申告したもの)。
   * **数の正は下の `toHaveLength(28)` と `cells()` の側である。**
   */
  const VIEW_KEY_EMITS_STATEMENT: Record<string, Record<ViewForm, Emission>> = {
    // `screens.target` / `screens.display_name`。**4形すべてで書け、必ず出る。**
    id: {
      list_view_equals_filter: "emits",
      list_view_boolean_filter: "emits",
      detail_view: "emits",
      form: "emits",
      report_view: "emits",
    },
    type: {
      list_view_equals_filter: "emits",
      list_view_boolean_filter: "emits",
      detail_view: "emits",
      form: "emits",
      report_view: "emits",
    },
    table: {
      list_view_equals_filter: "emits",
      list_view_boolean_filter: "emits",
      detail_view: "emits",
      form: "emits",
      report_view: "emits",
    },
    name: {
      list_view_equals_filter: "emits",
      list_view_boolean_filter: "emits",
      detail_view: "emits",
      form: "emits",
      report_view: "emits",
    },
    // `screens.column` / `screens.sort`。list_view でだけ書ける。
    columns: {
      list_view_equals_filter: "emits",
      list_view_boolean_filter: "emits",
      detail_view: "unwritable",
      form: "unwritable",
      report_view: "unwritable",
    },
    sort: {
      list_view_equals_filter: "emits",
      list_view_boolean_filter: "emits",
      detail_view: "unwritable",
      form: "unwritable",
      report_view: "unwritable",
    },
    /*
     * **これが D6 の当て先である。**
     *
     * **旧表(キー単位)は `filter: true` の1マスで、コメントに「等値AND配列のときだけ。
     * ブール式は M8 の射程外」と書いていた** —— 表を見ただけでは欠落が読めなかった。
     * **`ADR-0068` B群(`V3-M11-G2` = 限定採用)がブール式の側を実装したので、
     * 今日は2つの形とも `emits` である。**
     * 等値AND配列は `screens.filter`、ブール式は `screens.filter_*`(9本)が受ける。
     */
    filter: {
      list_view_equals_filter: "emits",
      list_view_boolean_filter: "emits",
      detail_view: "unwritable",
      form: "unwritable",
      report_view: "unwritable",
    },
    // `screens.item`。detail_view / form で書ける。
    fields: {
      list_view_equals_filter: "unwritable",
      list_view_boolean_filter: "unwritable",
      detail_view: "emits",
      form: "emits",
      report_view: "unwritable",
    },
    // **EC-G17 / ADR-0044。v2 からの既知の欠落だったが、`ADR-0068` A6 が塞いだ**
    // (`screens.related` + `screens.related_column`)。detail_view でだけ書ける。
    related: {
      list_view_equals_filter: "unwritable",
      list_view_boolean_filter: "unwritable",
      detail_view: "emits",
      form: "unwritable",
      report_view: "unwritable",
    },
    // **EC-G14 / ADR-0045。同上**(`screens.action`)。
    // **【V5-M21-T01 / `L-G1` / ADR-0171 で `list_view` の2形を `unwritable` →
    // `emits` に移した】** **門A の本審査(`V5-M20` 面1。判定 = 限定採用)が
    // `list_view` 分岐の `"actions": false,` を解いた。****キーは1本も増えていない**
    // (28のまま)。**テンプレートも1本も足していない**(`screens.action` をそのまま
    // 使う)。**`form` は今日も `unwritable` である**(限定3)。
    // **一覧に書けるのは遷移の形だけなので、`set` 形は一覧では今日も1文も出ない** ——
    // ただしそれは「書けない」からであって、テンプレートが無いからではない
    // (`detail_view` の `set` 形が1文も出ないのは今日も変わらない)。
    actions: {
      list_view_equals_filter: "emits",
      list_view_boolean_filter: "emits",
      detail_view: "emits",
      form: "unwritable",
      report_view: "unwritable",
    },
    /*
     * **D-G4 / ADR-0050 限界8。** **`ADR-0068` 共通10 が名指しで「足さない」と定めた** ——
     * 審査が明示的に落とした欠落であり、本実装はそれを覆さない。
     *
     * ---
     *
     * **【2026-08-04。`V4-M39-T01` / `ADR-0144` A9 による更新。上の記述は判定時点の記録として
     * 残す】** **上が「本実装はそれを覆さない」と書いた判断を、門A の本審査
     * (`V4-M39-G1` = 単位A。判定 = 限定採用。結論が出た問は問4)が覆した。**
     * **単位A の7キー・16マスが `silent` → `emits` へ移る**(`preset_column_align` 2 /
     * `preset_column_width` 2 / `preset_pager_position` 2 / `preset_label_placement` 2 /
     * `preset_field_columns` 2 / `preset_image_size` 3 / `preset_text_preview` 3)。
     * **マス総数(112)と `unwritable`(43)は1マスも動かない。**
     * **述べるのは「そう宣言している」ことまでである**(A4)—— **宣言と描画は一致するとは
     * 限らない。効いているかは1つも検査していない**(C10)。
     */
    preset_column_align: {
      list_view_equals_filter: "emits",
      list_view_boolean_filter: "emits",
      detail_view: "unwritable",
      form: "unwritable",
      report_view: "unwritable",
    },
    preset_column_width: {
      list_view_equals_filter: "emits",
      list_view_boolean_filter: "emits",
      detail_view: "unwritable",
      form: "unwritable",
      report_view: "unwritable",
    },
    preset_pager_position: {
      list_view_equals_filter: "emits",
      list_view_boolean_filter: "emits",
      detail_view: "unwritable",
      form: "unwritable",
      report_view: "unwritable",
    },
    // **【V4-M16-T11 / P-G29 / ADR-0091 限定3】この2軸の `form` は着手前 `"unwritable"` だった。**
    // **`ADR-0091`(門A / 判定 = 限定採用)が form 分岐の `false` を外したので `"silent"` になる**
    // —— **「書ける」に変わっただけで、要件ドキュメントには今日も1文も出さない**
    // (`ADR-0055` 限定14 と同じ扱い。出す/出さないの判定は1バイトも変えていない)。
    // **残る5軸の `form` は `"unwritable"` のままである。**
    // **【V4-M39-T01 / ADR-0144 A9 による更新】** **書ける2形が `emits` になった** ——
    // **入力フォーム(form)の見せ方が要件定義書に現れるのは、この2軸と `preset_density` が
    // 初めてである。**
    preset_label_placement: {
      list_view_equals_filter: "unwritable",
      list_view_boolean_filter: "unwritable",
      detail_view: "emits",
      form: "emits",
      report_view: "unwritable",
    },
    preset_field_columns: {
      list_view_equals_filter: "unwritable",
      list_view_boolean_filter: "unwritable",
      detail_view: "emits",
      form: "emits",
      report_view: "unwritable",
    },
    preset_image_size: {
      list_view_equals_filter: "emits",
      list_view_boolean_filter: "emits",
      detail_view: "emits",
      form: "unwritable",
      report_view: "unwritable",
    },
    preset_text_preview: {
      list_view_equals_filter: "emits",
      list_view_boolean_filter: "emits",
      detail_view: "emits",
      form: "unwritable",
      report_view: "unwritable",
    },
    // **D-G5 / ADR-0055 限定14。** 逃げ道の参照は要件ドキュメントに1文も出さない ——
    // 「逸脱として要件ドキュメントに必ず現れる」という 01 §4 の約束の**側を落とす**判断で
    // あり(理由3点は ADR-0055 限定14。うち1点は ADR-0025 限定11 の余白が実測で0であること)、
    // **V3-M5 は `src/kernel/requirements-doc.ts` を1バイトも触っていない。**
    // **これは「気づかずに落ちた」のではなく、審査が明示的に落とした欠落である。**
    // **`ADR-0068` 共通10 もこれを名指しで維持した。** どの形でも書ける(schema は
    // どの分岐でも `false` にしていない)ので、4形とも `silent` である。
    //
    // ---
    //
    // **【2026-08-04。`V4-M39-T01` / `ADR-0145` A8 による更新。上の記述は判定時点の記録として
    // 残す】** **門A の本審査(`V4-M39-G3` = 単位C。判定 = 限定採用。結論が出た問は問4)が
    // `ADR-0055` 限定14 を覆した。** **4形とも `emits` になる**(`screens.custom_css` +
    // `screens.custom_css_digest`)。**回収したのは「参照が現れる」までであり、
    // 「逸脱の列挙」は今日も実装されていない**(`ADR-0145` C2)——
    // **何から逸脱したかを述べるには CSS の中身を読むことになり、憲法1 に当たる。**
    // **CSS のバイト列は1バイトも読んでいない**(A3 / B1)。
    // **失効した資産を指す参照にも文が出る**(A7。fail-closed しない)。
    custom_css: {
      list_view_equals_filter: "emits",
      list_view_boolean_filter: "emits",
      detail_view: "emits",
      form: "emits",
      report_view: "emits",
    },
    /*
     * **`B-G1` / ADR-0070(V4-M3-T02)が足した19キー目。**
     *
     * **4形とも `silent` である** —— **要件ドキュメントは「この画面を誰に見せるか」を
     * 1文も書かない。** これは**見落としではなく、`ADR-0070` 限定5(`src/kernel/` に
     * 1バイトも差分を出さない)の帰結である** —— 文を出すには
     * `src/kernel/requirements-doc.ts` を触ることになり、限定5 に正面から当たる。
     *
     * **【この欠落を正直に書く】** **`audience` を書いたアプリの要件ドキュメントを読んでも、
     * 運営専用の画面が運営専用であることは1文字も分からない。** **`custom_css`(限定14 で
     * 明示的に落とした)と違い、こちらは「限定表が触れる先を閉じたので出せない」形である。**
     * **`V4-M3-T08` の「守らない経路」に1行書く。** 出したくなったら改めて門を通すこと。
     *
     * どの形でも書ける(schema はどの分岐でも `false` にしていない)ので、4形とも `silent`。
     *
     * ---
     *
     * **【2026-08-04。`V4-M32-T01` / `ADR-0126` A2・A10 による更新。上の記述は判定時点の
     * 記録として残す】** **上の段落が「出したくなったら改めて門を通すこと」と書いた、その門を
     * 通した** —— `ADR-0126`(`D-V4-117` = **限定採用**。結論が出た問は問4)が
     * `screens.audience` を足したので、4形とも `emits` になる。**上が「1文字も分からない」と
     * 書いた欠落は、今日は事実でなくなった。** **`ADR-0070` 限定5 を覆したのではない** ——
     * 限定5 は特定の着手前 sha からの差分を測る期間限定の式であり、本 ADR の増分を縛らない
     * (`ADR-0126` §Context 3)。
     *
     * ---
     *
     * **【2026-08-09。`V8-M20` / 台帳 `J-G27` / `ADR-0301` による撤去。上の2つの記録は
     * 判定時点のものとして残す】** **`audience` の行(4形とも `emits`)をこの表から
     * 落とした。****旧: `audience: { list_view_equals_filter: "emits",
     * list_view_boolean_filter: "emits", detail_view: "emits", form: "emits" }`。**
     * **理由は「出さないと決め直した」ではない** —— **`schemas/manifest.schema.json` の
     * `$defs/view/properties/audience` そのものが廃止され、この表の正準(スキーマの
     * キーの並び)から消えた。** **画面を誰に見せるかは `app.roles[].rules`
     * (対象 `view`・動詞 `read`)へ移った。**
     * **その `rules` を述べるテンプレートは今日1本も無い** ——
     * **要件ドキュメントは権限について1文も書かない。**
     */
    /*
     * **`E-G12` / `ADR-0084`(`V4-M10-T45`)が足した20キー目。**
     *
     * **4形とも `silent` である** —— **要件ドキュメントは「この画面をメニューに出すか」を
     * 1文も書かない。** **`ADR-0084` の限定表は要件ドキュメント生成を1点も要求していない**
     * ので、本実施は文を1本も足していない(限定表の外を実装しない)。
     *
     * **【この欠落を正直に書く】** **`menu_listed: false` を書いたアプリの要件ドキュメントを
     * 読んでも、その画面がメニューに出ないことは1文字も分からない。** **`audience` /
     * `custom_css` と同じ形の欠落がこれで3本目である。** 出したくなったら改めて門を通すこと。
     *
     * どの形でも書ける(schema はどの分岐でも `false` にしていない)ので、4形とも `silent`。
     *
     * ---
     *
     * **【2026-08-04。`V4-M32-T01` / `ADR-0126` A2・A10 による更新】** **`ADR-0126` が
     * `screens.menu_listed` / `screens.menu_unlisted` の2本を足したので、4形とも `emits` に
     * なる。** **真偽それぞれ1文であり(`ADR-0126` §Decision 2 の 2)、既定値は推測しない**
     * —— **書かなかった画面については今日も1文も出ない**(A3)。
     */
    menu_listed: {
      list_view_equals_filter: "emits",
      list_view_boolean_filter: "emits",
      detail_view: "emits",
      form: "emits",
      report_view: "emits",
    },
    /*
     * **`P-G17` の (C) 側 / `ADR-0092`(`V4-M16-T12`)が足した21キー目。**
     *
     * **`detail_view` でだけ書ける**(限定2)ので、`list_view` 2形と form は `unwritable`
     * (schema の `allOf` がその2分岐で `false` にしている)。
     *
     * **書ける唯一の形でも `silent` である** —— **要件ドキュメントは「どの項目がどのまとまりに
     * 属するか」を1文も書かない。** **`ADR-0092` の限定表は要件ドキュメント生成を1点も
     * 要求しておらず、§Context 4 の 5 が「要件ドキュメント(`ADR-0025`)に1文も現れない」を
     * 自分で不利な材料として挙げている**(`ADR-0050` 限界8 と同型)。本実施は文を1本も
     * 足していない(**限定表の外を実装しない**)。
     *
     * **【この欠落を正直に書く】** **`field_groups` を書いたアプリの要件ドキュメントを読んでも、
     * 項目がまとまって出ることは1文字も分からない。** **`audience` / `custom_css` /
     * `menu_listed` と同じ形の欠落がこれで4本目である。** 出したくなったら改めて門を通すこと。
     *
     * ---
     *
     * **【2026-08-04。`V4-M32-T01` / `ADR-0126` A2・A10 による更新】** **その門を通した** ——
     * `screens.field_group`(まとまり1件につき1文)と `screens.field_group_item`(所属項目
     * 1件につき1文)を足したので、書ける唯一の形 `detail_view` が `emits` になる。**残る3形は
     * `unwritable` のままで1マスも動いていない。** **`ADR-0092:42` の逐語「要件ドキュメント
     * (`ADR-0025`)に1文も現れない」は、今日は事実でなくなった** —— **`ADR-0126` D2 の判定に
     * より `ADR-0092` 本文には1バイトも追記していない**(申告は `ADR-0126` Consequences 4)。
     */
    field_groups: {
      list_view_equals_filter: "unwritable",
      list_view_boolean_filter: "unwritable",
      detail_view: "emits",
      form: "unwritable",
      report_view: "unwritable",
    },
    /*
     * **22キー目 `preset_list_shape`(`P-G24` の (C) 側 / `V4-M16-T13` / `ADR-0093`)。**
     *
     * **`list_view` でだけ書け(限定2)、書いても要件ドキュメントの文は1文も出ない** ——
     * **`ADR-0093` の限定表は要件ドキュメントを1点も要求していない**(他のプリセット7軸 /
     * `custom_css` / `audience` / `menu_listed` / `field_groups` と同じ扱いである)。
     * **【禁止】「一覧の器の形が要件定義書に載るようになった」と書かない。載らない。**
     *
     * ---
     *
     * **【2026-08-04。`V4-M39-T01` / `ADR-0144` A9(単位B)による更新。上の記述は判定時点の
     * 記録として残す】** **上が「載らない」と書いた欠落を、門A の本審査(`V4-M39-G2` =
     * 単位B。判定 = 限定採用)が覆した。** **書ける2形が `emits` になる**
     * (`screens.preset_list_shape`)。**単位A と別に判定した理由は、`ADR-0068` 共通10 の
     * 逐語が「プリセット7キー」と数を名指ししており、このキーがその名指しに入っていな
     * かったからである**(`ADR-0144` §Context 2)。
     * **【正直に書く】`preset_list_shape: "card"` のとき `preset_column_align` /
     * `preset_column_width` は効かない**(schema の `description` 逐語)——
     * **単位A の文と単位B の文が同じ画面で矛盾しうる。要件定義書はそれを1つも検査しない**
     * (`ADR-0144` C10)。
     */
    preset_list_shape: {
      list_view_equals_filter: "emits",
      list_view_boolean_filter: "emits",
      detail_view: "unwritable",
      form: "unwritable",
      report_view: "unwritable",
    },
    /*
     * **23キー目 `modal`(`P-G14` の (C) 側 / `V4-M18-T03` / `ADR-0095`)。**
     *
     * **`form` でだけ書け(限定4)、書いても要件ドキュメントの文は1文も出ない** ——
     * `src/kernel/requirements-doc.ts` は `modal` に1バイトも触っていない。**`ADR-0095` の
     * 限定表は要件ドキュメント生成を1点も要求していない**(他のプリセット7軸 / `custom_css` /
     * `audience` / `menu_listed` / `field_groups` / `preset_list_shape` と同じ扱いである)。
     * **【禁止】「重ねて出す宣言が要件定義書に載るようになった」と書かない。載らない。**
     *
     * ---
     *
     * **【2026-08-04。`V4-M32-T01` / `ADR-0126` A2・A10 による更新。上の禁止は判定時点の
     * 記録として残す】** **`ADR-0126` が `screens.modal` / `screens.non_modal` の2本を
     * 足したので、書ける唯一の形 `form` が `emits` になる。** **上の【禁止】が禁じていた
     * 文言は、今日は書いてよい** —— 禁止が守っていたのは「載らないのに載ると書くこと」で
     * あって、載せること自体ではない。**残る3形は `unwritable` のままである。**
     */
    modal: {
      list_view_equals_filter: "unwritable",
      list_view_boolean_filter: "unwritable",
      detail_view: "unwritable",
      form: "emits",
      report_view: "unwritable",
    },
    /*
     * **24キー目 `search_fields`(`E-G7` の (C) 側 / `V4-M22-T01` / `ADR-0112`)。**
     *
     * **`list_view` でだけ書け(限定3)、書いても要件ドキュメントの文は1文も出ない** ——
     * `src/kernel/requirements-doc.ts` は `search_fields` に1バイトも触っていない。
     * **`ADR-0112` の限定表は要件ドキュメントへの出力を1バイトも足していない(限定表に無い)**
     * (他のプリセット7軸 / `custom_css` / `audience` / `menu_listed` / `field_groups` /
     * `preset_list_shape` / `modal` と同じ扱いである)。
     * **【禁止】「検索の対象にする列が要件定義書に載るようになった」と書かない。載らない。**
     *
     * ---
     *
     * **【2026-08-04。`V4-M32-T01` / `ADR-0126` A2・A10 による更新】** **`screens.search_field`
     * (項目1件につき1文・位置つき)を足したので、`list_view` の2形が `emits` になる。**
     * **残る2形は `unwritable` のままである。**
     */
    search_fields: {
      list_view_equals_filter: "emits",
      list_view_boolean_filter: "emits",
      detail_view: "unwritable",
      form: "unwritable",
      report_view: "unwritable",
    },
    /*
     * **25キー目 `page_size`(`E-G8`/`E-G11` の (C) 側 / `V4-M22-T05` / `ADR-0113`)。**
     *
     * **`list_view` でだけ書け(限定7)、書いても要件ドキュメントの文は1文も出ない** ——
     * `src/kernel/requirements-doc.ts` は `page_size` に1バイトも触っていない。
     * **`ADR-0113` は要件ドキュメントへの出力を1バイトも足していない(限定表に無い)**
     * (他のプリセット7軸 / `custom_css` / `audience` / `menu_listed` / `field_groups` /
     * `preset_list_shape` / `modal` / `search_fields` と同じ扱いである)。
     * **【禁止】「1ページの件数が要件定義書に載るようになった」と書かない。載らない。**
     *
     * ---
     *
     * **【2026-08-04。`V4-M32-T01` / `ADR-0126` A2・A10 による更新】** **`screens.page_size`
     * を1本足したので、`list_view` の2形が `emits` になる。** **値は有限 enum の整数なので
     * `number` スロットで写す**(`ADR-0126` §Decision 2 の 6)。**残る2形は `unwritable`。**
     */
    page_size: {
      list_view_equals_filter: "emits",
      list_view_boolean_filter: "emits",
      detail_view: "unwritable",
      form: "unwritable",
      report_view: "unwritable",
    },
    /*
     * **26キー目 `preset_density`(`P-G32` の (C) 側 / `V4-M19-T03` / `ADR-0118`)。**
     *
     * **3種すべてで書け(限定6)、どの形でも要件ドキュメントの文は1文も出ない** ——
     * `src/kernel/requirements-doc.ts` は `preset_density` に1バイトも触っていない。
     * **`ADR-0118` は要件ドキュメントへの出力を1バイトも足していない(限定表に無い)**
     * (他のプリセット8軸 / `custom_css` / `audience` / `menu_listed` / `field_groups` /
     * `preset_list_shape` / `modal` / `search_fields` / `page_size` と同じ扱いである)。
     * **【禁止】「画面の詰まり具合が要件定義書に載るようになった」と書かない。載らない。**
     * **本 ADR の増分ではない。**
     *
     * ---
     *
     * **【2026-08-04。`V4-M39-T01` / `ADR-0144` A9(単位B)による更新。上の記述は判定時点の
     * 記録として残す】** **上が「載らない」と書いた欠落を、門A の本審査(`V4-M39-G2` =
     * 単位B。判定 = 限定採用)が覆した。****3種すべてに書けるので4形とも `emits` になる**
     * (`screens.preset_density`)。**入力フォーム(form)の見せ方が要件定義書に現れるのは、
     * この製品でここが初めてである**(`preset_label_placement` / `preset_field_columns` と
     * 同じ実装で入った)。
     * **【正直に書く】`preset_density: "comfortable"` は既定そのものであり、書いた画面の
     * DOM は書かなかった場合と一致する** —— **それでも1文出る**(`ADR-0144` A3。
     * 2026-08-04 のユーザ決定・未採番が「**既定値と同じ値で宣言されている見せ方も1文出す**」
     * と定めた)。**要件定義書に「情報量0の文」が増えることを隠さない。**
     */
    preset_density: {
      list_view_equals_filter: "emits",
      list_view_boolean_filter: "emits",
      detail_view: "emits",
      form: "emits",
      report_view: "unwritable",
    },
    /*
     * **【V4-M20-T04 / ADR-0102 限定1・限定3 で足した27キー目 `after_save`(保存が成立した
     * あとに行く画面のID)】** —— **`form` でだけ書ける**(限定3。list_view / detail_view
     * の allOf 分岐では `false`)。**書ける `form` の1形も「1文も出さない」側に置く** ——
     * `src/kernel/requirements-doc.ts` の `screens.*` 群は `target` / `display_name` /
     * `column` / `item` / `sort` / `filter` / `related` / `related_column` / `action` の
     * 有限列挙であり、`after_save` を読んで文を出す処理を1つも持たない
     * (他のプリセット系キーと同じ扱い)。**門A の本審査(V4-M20 単位D。2回目の審査。
     * 判定 = 限定採用)を通った増分である。**
     */
    /*
     * **【2026-08-04。`V4-M32-T01` / `ADR-0126` A2・A10 による更新】** **`screens.after_save`
     * を1本足したので、書ける唯一の形 `form` が `emits` になる。** **遷移先は `view_id` の
     * 実在集合に照合する**(`ADR-0102` 限定8 が apply 時に実在を保証しているので fail-closed
     * に落ちない)。**残る3形は `unwritable` のままである。**
     */
    /*
     * **【2026-08-20。`V10-M1-T01` / `NV-G3a` / `ADR-0358` 限定1 による更新】**
     * **旧行の逐語**: `detail_view: "unwritable",`
     *
     * **門A の本審査(`V10-M0` 群A。判定 = 限定採用)が `detail_view` 分岐の
     * `"after_save": false,` を外したので、`detail_view` は `unwritable` ではなくなった。**
     * **`emits` を選んだ**(`silent` を選ばなかった)—— **理由は
     * `src/kernel/requirements-doc.ts` の `detail_view` の `after_save` ブロックの
     * JSDoc に2点書いてある**(`silent` の復活には別の門が要る / 専用の文面を足すことは
     * 語彙を1つ足すのと同じ重さである)。
     * **【正直に書く】出る文は `form` とまったく同じ「保存が成立したあと」であり、
     * 詳細画面に「保存」という出来事は無い。****実際に発火するのは `set` 形の書込が
     * 成立したときだけである。****この1点で要件定義書は今日ずれている。**
     * **`list_view` 2形と `report_view` は `unwritable` のまま1マスも動いていない。**
     */
    after_save: {
      list_view_equals_filter: "unwritable",
      list_view_boolean_filter: "unwritable",
      detail_view: "emits",
      form: "emits",
      report_view: "unwritable",
    },
    /**
     * **【`V4-M23-T01` / `ADR-0104`(28キー目 `sum_field` = 一覧が表す集合について
     * `number` 列1本の合計を出す)】** —— **`list_view` でだけ書ける**(限定4。form /
     * `detail_view` の allOf 分岐では `false`)。**書ける `list_view` の2形も
     * 「1文も出さない」側に置く** —— `src/kernel/requirements-doc.ts` の `screens.*` 群は
     * `target` / `display_name` / `column` / `item` / `sort` / `filter` / `related` /
     * `related_column` / `action` の有限列挙であり、**`sum_field` を読んで文を出す処理を
     * 1つも持たない**(`search_fields` / `page_size` / `preset_density` / `after_save` と
     * 同じ扱い)。**門A の本審査(V4-M23 単位A-2。4回目の審査 = 3回目の再提出。
     * 判定 = 限定採用)を通った増分である。**
     * **【正直に書く】したがって「この一覧には合計が出る」ことは要件定義書に1文も出ない。**
     * **これは `requirements-doc.ts` の逐語コメントが既に申告している既定の姿であり、
     * 本タスクはそれを1ミリも直していない。**
     */
    /*
     * **【2026-08-04。`V4-M32-T01` / `ADR-0126` A2・A10 による更新。上の【正直に書く】は
     * 判定時点の記録として残す】** **`screens.sum_field` を1本足したので、`list_view` の
     * 2形が `emits` になる。** **上が「合計が出ることは要件定義書に1文も出ない」と書いた
     * 状態は、今日は事実でなくなった。** **残る2形は `unwritable` のままである。**
     */
    sum_field: {
      list_view_equals_filter: "emits",
      list_view_boolean_filter: "emits",
      detail_view: "unwritable",
      form: "unwritable",
      report_view: "unwritable",
    },
    /*
     * **【`V6-M2-T01` / `K-G2` / `ADR-0289` 限定1・限定4】29キー目 `reference_pickers`
     * (参照項目の選び方の、入力画面ごとの上書き)が門A の本審査(`V6-M0` 単位A。
     * 判定 = 限定採用)を通って加わった。**
     *
     * **判断: `form` は `silent`、残る3形は `unwritable` である。**
     * **`src/kernel/requirements-doc.ts` の `screens.*` 群は `target` / `display_name` /
     * `column` / `item` / `sort` / `filter` / `related` / `related_column` / `action` の
     * 有限列挙であり、`reference_pickers` を読んで文を出す処理を1つも持たない。**
     * **【正直に書く】したがって「この入力画面の取引先は別の面を開いて探す」ことは、
     * 今日 要件定義書に1文も出ない。**
     * **これを `emits` にするのは `K-G21b`(`V6-M6-T02`)の仕事であり、本タスクではない**
     * (`v6-m0.md` §7-11。**`K-G21b` の限定2 は「出すのは `K-G1`(項目の選び方)と
     * `K-G2`(画面の上書き)だけ」と定めている**)。
     * **`V6-M1` が `$defs/field` 側で作った `silent` 1マスと同型の、2件目である。**
     */
    /*
     * **【`V6-M6-T02` / `K-G21b` / `ADR-0291` A1・A2 で `silent` → `emits` になった】**
     * **`V6-M2-T01` が作った1マスの `silent` を、予告どおり `V6-M6` が塞いだ。**
     * **上の判断文(逐語「今日 要件定義書に1文も出ない」)は今日から偽である** ——
     * **旧文を1バイトも消していない。**
     * **出るのは項目ごとに1文で、3値それぞれ別の文である**
     * (`screens.reference_picker_list` / `_type_filter` / `_search`)。
     */
    reference_pickers: {
      list_view_equals_filter: "unwritable",
      list_view_boolean_filter: "unwritable",
      detail_view: "unwritable",
      form: "emits",
      report_view: "unwritable",
    },
    /*
     * **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】30個目のキー `report`
     * (集計表の中身)。**
     *
     * **4形すべてで `unwritable` である** —— **`report` を書けるのは画面種別の4種目
     * `report_view` だけであり、この表が持つ4形(`list_view` の2形 / `detail_view` /
     * `form`)のどれでも `allOf` が `false` で閉じている。**
     *
     * **【第2軸(形)に `report_view` を足していない。判断であって書き漏らしではない】**
     * **足すと表が 30キー × 5形 = 150マスになり、既存29キーぶん29マスの判断を
     * 本マイルストーンで新たに書くことになる。** **要件定義書に集計表の中身を出すのは
     * `V8-M13`(台帳 `Q-G31a`)の担当であり、そのとき形を足して29マスを埋めるのが
     * 筋である。** **`V8-M8` の生成器は `report_view` の画面について本文を1文も
     * 出さない**(`src/kernel/requirements-doc.ts` の `report_view` 早期 return)。
     * **黙って出さないのではなく、ここに「4形で書けない」と明示している。**
     *
     * ---
     *
     * **【2026-08-15 追記。`V8-M13-T03`。台帳 `Q-G31a` / `Q-G31b`。上の本文を1バイトも
     * 書き換えていない。ただし2点が今日は偽である】**
     *
     * **(1) 「4形すべてで `unwritable`」は今日は全量ではない** —— **上の予告どおり
     * `V8-M13` が5形目 `report_view` を足し、`report/report_view` を `emits` にした。**
     * **本文が出るようになったので、早期 return も今日は「1文も出さない」形ではない。**
     *
     * **(2) 「30キー × 5形 = 150マス」は実測と合わない** —— **`$defs/view.properties` は
     * 今日 **29キー**であり**(数え方: `schemas/manifest.schema.json` の
     * `$defs/view.properties` のキー数。下の `canonicalViewKeys()` と
     * `Object.keys(VIEW_KEY_EMITS_STATEMENT)` の突き合わせが機械で固定している)、
     * **29 × 5 = **145マス**である。** **同じ段落の「既存29キーぶん29マス」の側が
     * 正しく、キーの総数を30と書いた側が誤りである**(`report` は29キー目である ——
     * `schemas/manifest.schema.json` の `report` の `$comment` が自ら「本キーは29キー目」
     * と書いている)。**同じ誤りが `docs/plan/v8/records/v8-m8.md:498` にもある。**
     * **どちらの本文も1バイトも書き換えていない。**
     */
    report: {
      list_view_equals_filter: "unwritable",
      list_view_boolean_filter: "unwritable",
      detail_view: "unwritable",
      form: "unwritable",
      report_view: "emits",
    },
    /*
     * **【2026-08-20。`V10-M1-T02`。台帳 `NV-G4`。門A 本審査 = `V10-M0` 群A。
     * ADR = `ADR-0359`】30キー目。**
     *
     * **判定は `silent`(書けるが、要件定義書に1文も出さない)である。**
     * **`silent` はこのファイルで着手前 **0マス**であり、本タスクが1マス復活させる**
     * (`ADR-0126` A10 が26 → 4に、`ADR-0145` A8 が4 → 0にした)。
     * **丸めずに書く。**
     *
     * **【なぜ `emits` にしなかったか。`V10-M1-T01` と判断を変えた理由】**
     *
     * **`T01`(`ADR-0358`)は `after_save/detail_view` を `emits` にした。**
     * **そのとき使えた文面は `screens.after_save`(「保存が成立したあと画面 X へ移ると
     * 宣言している。」)であり、詳細画面の `set` 形の書込は「保存」から遠いとはいえ
     * **書込**ではある** —— **`T01` はそのずれを引き受けて `emits` を採った。**
     *
     * **本キーで同じ判断を採ると、削除の行き先について「**保存**が成立したあと」と
     * 述べることになる。** **これは要件定義書が事実でないことを述べる形であり、
     * ずれではなく誤りである。** **`ADR-0025` §6 の決定論も `ADR-0126` A4 の
     * 「述べるのは『そう宣言している』ことまで」も、嘘を述べてよいとは言っていない。**
     *
     * **専用の文面(`screens.after_delete`)を新設する道は採れない** ——
     * **文面(`REQUIREMENT_TEMPLATES`)を足すことは語彙を1つ足すのと同じ重さの決定であり
     * (`ADR-0025` 限定11 / `ADR-0144` §3a)、加えて `ADR-0144` §3a の 2 は
     * 「`A2` の9キーに10キー目を足したくなったとき(`$defs/view` に新しいキーが
     * 増えたとき)」に `ADR-0007` の門A を改めて通すことを課している。**
     * **`ADR-0359` はその門を通していない**(同 ADR は要件ドキュメントに1文も触れて
     * いない)。**したがって本タスクは `A2` のキーを1本も増やさない。**
     *
     * **残るのは `silent` だけである。** **`silent` の意味は `ADR-0126` §Consequences の
     * 逐語で「書けるのに出ないのは、審査が明示的に落としたものだけになる」であり、
     * **ここに理由を書いた本件はまさにその形である。**
     *
     * **【正直に書く。丸めない】その代償として、この製品の要件定義書は
     * 「削除の後どこへ行くか」を1文も述べない。** **`after_delete` を書いたアプリと
     * 書いていないアプリの要件定義書は1バイトも変わらない。**
     * **これを解くには専用の文面を1本足すことになり、それは改めて `ADR-0007` の門を通す。**
     *
     * **`detail_view` 以外の4マスが `unwritable` であることは、下の
     * 「`unwritable` の73マスは schema の `allOf` が実際に `false` にしている」が
     * 散文ではなくスキーマで裏を取る。**
     * **【2026-08-20。`V10-M4-T01`。直前の1文の「73マス」は今日は偽である】**
     * **31キー目 `flow` の `report_view` の1マスが加わり、今日は **74マス** である。**
     * **旧文を1バイトも消していない**(`ADR-0007` §6 規律1 と同じ作法)——
     * **裏を取る仕掛けそのものは1バイトも変わっていない。**
     */
    after_delete: {
      list_view_equals_filter: "unwritable",
      list_view_boolean_filter: "unwritable",
      detail_view: "silent",
      form: "unwritable",
      report_view: "unwritable",
    },
    /*
     * **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。門A 本審査 = `V10-M0` 群B。
     * ADR = `ADR-0359` / `ADR-0360`】31キー目。**
     *
     * **判定は4形とも `silent`(書けるが、要件定義書に1文も出さない)である。**
     * **`silent` は `V10-M1-T02` が1マス復活させたところであり、本タスクが4マス足して
     * 5マスにする**(`after_delete/detail_view` + `flow` の4形)。**丸めずに書く。**
     *
     * **【なぜ `emits` にしなかったか。`after_delete` と同じ向きである】**
     *
     * **今日ある文面(`REQUIREMENT_TEMPLATES`)に、段の並びを述べるものは1本も無い。**
     * **`screens.after_save`(「保存が成立したあと画面 X へ移ると宣言している。」)を
     * 当てると、`list_view` に置いた入力の段についてまで「保存が成立したあと」と
     * 述べることになる** —— **これは要件定義書が事実でないことを述べる形であり、
     * ずれではなく誤りである。**
     *
     * **専用の文面(`screens.flow`)を新設する道は採れない** ——
     * **文面(`REQUIREMENT_TEMPLATES`)を足すことは語彙を1つ足すのと同じ重さの決定であり
     * (`ADR-0025` 限定11 / `ADR-0144` §3a)、加えて `ADR-0144` §3a の 2 は
     * 「`A2` の9キーに10キー目を足したくなったとき(`$defs/view` に新しいキーが
     * 増えたとき)」に `ADR-0007` の門A を改めて通すことを課している。**
     * **`ADR-0359` はその門を通していない**(同 ADR は要件ドキュメントについて
     * 「同じマイルストーンの中でそろえる」としか書いておらず、文面を1本も足していない)。
     * **`ADR-0360` も要件ドキュメントに1文も触れていない。**
     * **したがって本タスクは `A2` のキーを1本も増やさない。**
     *
     * **残るのは `silent` だけである。** **`silent` の意味は `ADR-0126` §Consequences の
     * 逐語で「書けるのに出ないのは、審査が明示的に落としたものだけになる」であり、
     * **ここに理由を書いた本件はまさにその形である。**
     *
     * **【正直に書く。丸めない】その代償として、この製品の要件定義書は
     * 「どの画面がどの流れの何段目か」を1文も述べない。** **`flow` を書いたアプリと
     * 書いていないアプリの要件定義書は1バイトも変わらない。**
     * **これを解くには専用の文面を1本足すことになり、それは改めて `ADR-0007` の門を通す。**
     *
     * **`report_view` の1マスだけが `unwritable` である** —— **集計表は流れの段に
     * なれない**(`V10-M4` の決1。**`ADR-0359` にも `ADR-0360` にも1条も書かれていない
     * メインの決定である**)。**そのことは、下の「`unwritable` の74マスは schema の
     * `allOf` が実際に `false` にしている」が散文ではなくスキーマで裏を取る。**
     *
     * **`form` / `list_view` の2形が `silent`(= `unwritable` ではない)なのは、
     * その2分岐の `flow` が `false` ではなくオブジェクト(`kind` を入力の段に固定する
     * 部分制約)だからである** —— **キーそのものは書ける。閉じているのは値の1つだけである。**
     */
    flow: {
      list_view_equals_filter: "silent",
      list_view_boolean_filter: "silent",
      detail_view: "silent",
      form: "silent",
      report_view: "unwritable",
    },
  };

  function canonicalViewSchema(): {
    properties: Record<string, unknown>;
    allOf: {
      if: { properties: { type: { const: string } } };
      then: { required?: string[]; properties?: Record<string, unknown> };
    }[];
  } {
    const schema = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "..", "schemas", "manifest.schema.json"), "utf-8"),
    ) as {
      $defs: {
        view: {
          properties: Record<string, unknown>;
          allOf: {
            if: { properties: { type: { const: string } } };
            then: { required?: string[]; properties?: Record<string, unknown> };
          }[];
        };
      };
    };
    return schema.$defs.view;
  }

  function canonicalViewKeys(): string[] {
    return Object.keys(canonicalViewSchema().properties);
  }

  /** 表の全マス(キー × 形)を `"<key>/<form>"` の名前つきで平らに並べる。 */
  function cells(): [string, Emission][] {
    return Object.entries(VIEW_KEY_EMITS_STATEMENT).flatMap(([key, byForm]) =>
      VIEW_FORMS.map((form): [string, Emission] => [`${key}/${form}`, byForm[form]]),
    );
  }

  test("$defs/view の全キーについて『文を出すか出さないか』が明示されている", () => {
    // **順序ごと固定する。** 22個目が増えたらここが赤くなり、判断を書くまで緑にならない。
    // **19個目(`audience` / `B-G1` / ADR-0070)は V4-M3-T02 が判断を書いて通した。**
    // **20個目(`menu_listed` / `E-G12` / ADR-0084)は V4-M10-T45 が判断を書いて通した。**
    // **21個目(`field_groups` / `P-G17` の (C) 側 / ADR-0092)は V4-M16-T12 が判断を
    // 書いて通した**(`detail_view` だけ `silent`、残る3形は `unwritable`)。
    // **22個目(`preset_list_shape` / `P-G24` の (C) 側 / ADR-0093)は V4-M16-T13 が判断を
    // 書いて通した**(`list_view` の2形が `silent`、残る2形は `unwritable`)。
    // **23個目(`modal` / `P-G14` の (C) 側 / ADR-0095)は V4-M18-T03 が判断を
    // 書いて通した**(`form` の1形だけ `silent`、残る3形は `unwritable`)。
    // **24個目(`search_fields` / `E-G7` の (C) 側 / ADR-0112)は V4-M22-T01 が判断を
    // 書いて通した**(`list_view` の2形が `silent`、残る2形は `unwritable`)。
    // **25個目(`page_size` / `E-G8`/`E-G11` の (C) 側 / ADR-0113)は V4-M22-T05 が判断を
    // 書いて通した**(`list_view` の2形が `silent`、残る2形は `unwritable`)。
    // **26個目(`preset_density` / `P-G32` の (C) 側 / ADR-0118)は V4-M19-T03 が判断を
    // 書いて通した**(4形すべて `silent`)。
    // **27個目(`after_save` / `E-G34` / ADR-0102)は V4-M20-T04 が判断を書いて通した**
    // (`form` の1形だけ `silent`、残る3形は `unwritable`)。
    // **29個目(`reference_pickers` / `K-G2` / `ADR-0289`)は `V6-M2-T01` が判断を書いて
    // 通した**(`form` の1形だけ `silent`、残る3形は `unwritable`)。
    expect(canonicalViewKeys()).toEqual(Object.keys(VIEW_KEY_EMITS_STATEMENT));
  });

  // **【V4-M32-T01。テスト名の食い違いを先に申告する】** **着手前のこのテストの名前は
  // 「100マスの内訳は emits 26 / silent 36 / unwritable 38 である(数で残す)」であり、
  // 中の assertion(112 / 26 / 43 / 43)と食い違っていた。** **名前だけが `page_size` を
  // 足した時点(100マス / silent 36 / unwritable 38)で止まっており、その後の
  // `preset_density` / `after_save` / `sum_field` の3回の更新で追随していなかった。**
  // **本タスクはその食い違いを直したうえで、今日の実数に合わせる。** **数の正は
  // assertion 側であり、名前は読み手のための写しである。**
  // **【2026-08-20。`V10-M1-T01` / `ADR-0358`。テスト名の食い違いを先に申告する】**
  // **着手前のこのテストの名前は「112マスの内訳は emits 69 / silent 0 / unwritable 43 である
  // (数で残す)」であり、中の assertion(145 / 75 / 0 / 70)と食い違っていた。**
  // **名前が `V4-M39-T01` の時点(112 / 69 / 0 / 43)で止まっており、その後の
  // `V5-M21-T01` / `V6-M2-T01` / `V6-M6-T02` / `V8-M8` / `V8-M13-T03` / `V8-M20` の
  // 更新に追随していなかった。****本タスクは数を動かすので、その食い違いも同時に直す。**
  // **数の正は assertion 側であり、名前は読み手のための写しである。**
  test("150マスの内訳は emits 76 / silent 1 / unwritable 73 である(数で残す)", () => {
    // **【V4-M3-T02 / `B-G1` / ADR-0070 による更新】** 19キー目 `audience` が4形とも
    // 書けるので、マスは 72 → 76、silent は 18 → 22 になった。**emits は26 のまま1つも
    // 増えていない** —— **`audience` を書いても要件ドキュメントの文は1文も増えない。**
    // **【V4-M10-T45 / `E-G12` / ADR-0084 による更新】** 20キー目 `menu_listed` も4形とも
    // 書けるので、マスは 76 → 80、silent は 22 → 26 になった。**emits は26 のまま1つも
    // 増えていない** —— **`menu_listed` を書いても要件ドキュメントの文は1文も増えない。**
    // **【V4-M16-T12 / `P-G17` の (C) 側 / ADR-0092 限定1・限定2】21キー目 `field_groups` が
    // 門A(`V4-M14` 本審査② の単位9。判定 = 限定採用)を通って加わった。****マスは
    // 80 → 84、silent は 28 → 29、unwritable は 26 → 29 になった。****emits は26 のまま
    // 1つも増えていない** —— **`field_groups` を書いても要件ドキュメントの文は1文も増えない**
    // (`ADR-0092` §Context 4 の 5 が自分で挙げた不利な材料そのものである)。
    // **【V4-M16-T13 / `P-G24` の (C) 側 / ADR-0093 限定1・限定2】22キー目
    // `preset_list_shape` が門A(`V4-M14` 本審査② の単位11。判定 = 限定採用)を通って
    // 加わった。****マスは 84 → 88、silent は 29 → 31、unwritable は 29 → 31 になった。**
    // **emits は26 のまま1つも増えていない** —— **`preset_list_shape` を書いても要件
    // ドキュメントの文は1文も増えない**(他のプリセット7軸と同じである)。
    // **【V4-M18-T03 / `P-G14` の (C) 側 / ADR-0095 限定1・限定4・限定6】23キー目 `modal`
    // が門A(V4-M18 単位3。判定 = 限定採用)を通って加わった。****マスは 88 → 92、silent は
    // 31 → 32(`form` の1マスだけ)、unwritable は 31 → 34(`list_view` 2マス +
    // `detail_view` 1マス)になった。****emits は26 のまま1つも増えていない** ——
    // **`modal` を書いても要件ドキュメントの文は1文も増えない。**
    // **【V4-M22-T01 / `E-G7` の (C) 側 / ADR-0112 限定2・限定3】24キー目 `search_fields`
    // が門A(V4-M22 単位A。判定 = 限定採用)を通って加わった。****マスは 92 → 96、silent は
    // 32 → 34(`list_view` 2マス)、unwritable は 34 → 36(`detail_view` 1マス +
    // `form` 1マス)になった。****emits は26 のまま1つも増えていない** ——
    // **`search_fields` を書いても要件ドキュメントの文は1文も増えない。**
    // **【V4-M22-T05 / `E-G8`/`E-G11` の (C) 側 / ADR-0113 限定1・限定7】25キー目
    // `page_size` が門A(V4-M22 単位C。4回目の審査。判定 = 限定採用)を通って加わった。**
    // **マスは 96 → 100、silent は 34 → 36(`list_view` 2マス)、unwritable は
    // 36 → 38(`detail_view` 1マス + `form` 1マス)になった。****emits は26 のまま
    // 1つも増えていない** —— **`page_size` を書いても要件ドキュメントの文は1文も増えない。**
    // **【V4-M19-T03 / `P-G32` の (C) 側 / ADR-0118 限定1・限定6】26キー目 `preset_density`
    // が門A(V4-M19 単位C。2回目の審査。判定 = 限定採用)を通って加わった。****3種すべてで
    // 書けるので、マスは 100 → 104、silent は 36 → 40(4形すべて)、unwritable は38のまま
    // 動いていない。****emits は26 のまま1つも増えていない** ——
    // **`preset_density` を書いても要件ドキュメントの文は1文も増えない。****本 ADR の
    // 増分ではない。**
    // **【V4-M20-T04 / ADR-0102 限定1・限定3】27キー目 `after_save` が門A(V4-M20 単位D。
    // 2回目の審査。判定 = 限定採用)を通って加わった。****`form` でだけ書けるので、マスは
    // 104 → 108、silent は 40 → 41(`form` の1マスだけ)、unwritable は 38 → 41
    // (`list_view` 2マス + `detail_view` 1マス)になった。****emits は26 のまま1つも
    // 増えていない** —— **`after_save` を書いても要件ドキュメントの文は1文も増えない。**
    // **【V4-M23-T01 / ADR-0104 限定1・限定4 で 108 → 112 に更新した】** 28キー目
    // `sum_field` が門A の本審査(V4-M23 単位A-2。4回目の審査 = 3回目の再提出。
    // 判定 = 限定採用)を通って加わった。****`list_view` でだけ書けるので、マスは
    // 108 → 112、silent は 41 → 43(`list_view` の2マス)、unwritable は 41 → 43
    // (`detail_view` 1マス + `form` 1マス)になった。****emits は26 のまま1つも
    // 増えていない** —— **`sum_field` を書いても要件ドキュメントの文は1文も増えない。**
    // **【V4-M32-T01 / ADR-0126 A2・A10 による更新】** **28キー目までは1つも増えていない
    // (キーは28のまま)が、17マスが `silent` → `emits` へ移った。****内訳は
    // `audience` 4形 / `menu_listed` 4形 / `field_groups` の `detail_view` 1 /
    // `modal` の `form` 1 / `search_fields` の `list_view` 2形 / `page_size` の
    // `list_view` 2形 / `after_save` の `form` 1 / `sum_field` の `list_view` 2形
    // = 4+4+1+1+2+2+1+2 = 17 である。****マスの総数(112)と `unwritable`(43)は
    // 1マスも動いていない**(A10)。**emits は 26 → 43、silent は 43 → 26 になった。**
    // **【V4-M39-T01 / ADR-0144 A9 + ADR-0145 A8 による更新】** **28キー目までは1つも
    // 増えていない(キーは28のまま)が、残っていた26マスが全部 `silent` → `emits` へ移った。**
    // **内訳は 単位A の16マス**(`preset_column_align` 2 / `preset_column_width` 2 /
    // `preset_pager_position` 2 / `preset_label_placement` 2 / `preset_field_columns` 2 /
    // `preset_image_size` 3 / `preset_text_preview` 3)**+ 単位B の6マス**
    // (`preset_list_shape` 2 / `preset_density` 4)**+ 単位C の4マス**(`custom_css` 4)
    // **= 16+6+4 = 26 である。****マスの総数(112)と `unwritable`(43)は1マスも動いて
    // いない。****emits は 43 → 69、silent は 26 → 0 になった。**
    // **【「要件定義書が追いついた」とは書かない】** **テーマ25スロットは今日も1文も
    // 出ない**(`ADR-0144` B1。`THEME_SLOT_EMITS_STATEMENT` の25件はすべて `false` の
    // ままである)。**動いたのは `$defs/view` の側だけである。**
    // **【V5-M21-T01 / `L-G1` / ADR-0171 による更新】** **キーは28のまま1つも増えて
    // いないが、`actions` の `list_view` 2マスが `unwritable` → `emits` へ移った。**
    // **マスの総数(112)と `silent`(0)は1マスも動いていない。****emits は 69 → 71、
    // unwritable は 43 → 41 になった。****本ファイルで `unwritable` が減るのは初めてである。**
    // **【`V6-M2-T01` / `K-G2` / `ADR-0289` 限定1・限定4 で 112 → 116 に更新した】**
    // **29キー目 `reference_pickers` が門A の本審査(`V6-M0` 単位A。判定 = 限定採用)を
    // 通って加わった。****`form` でだけ書けるので、マスは 112 → 116、silent は 0 → 1
    // (`form` の1マスだけ)、unwritable は 41 → 44(`list_view` 2マス + `detail_view`
    // 1マス)になった。****emits は71のまま1つも増えていない** ——
    // **`reference_pickers` を書いても要件ドキュメントの文は1文も増えない。**
    // **【`silent` が復活したことを隠さない】** **`ADR-0144` A9 が 0 にした `silent` が、
    // 本タスクで 1 に戻った。** **上の述語が求めるとおり、これは (b)「限定表が要件
    // ドキュメントを要求しなかった」側である。****門は素通りしていない** ——
    // **`V6-M0` の門A本審査が、要件ドキュメントに出す側を `K-G21b`(単位K)として別に立て、
    // 門A / 限定採用と判定している**(`v6-m0.md` §7-11 / §9 の台帳。**実装タスク =
    // `V6-M6-T02`**)。**`0` に戻すのは `V6-M6-T02` の仕事である。**
    // **`$defs/field` 側の同型の1マス(`reference_picker` / `reference`)は `V6-M1` が
    // 作った。****今日この製品には `silent` が2マスある。**
    // **【`V8-M20` / 台帳 `J-G27` / `ADR-0301` で 116 → 112 に縮んだ】**
    // **旧: `expect(all).toHaveLength(116)` / `emits` は 72。**
    // **29キー目まであったうちの `audience`(4形とも `emits`)が、スキーマからキーごと
    // 廃止されて表から落ちた。****マスは 116 → 112、`emits` は 72 → 68 になった。**
    // **`silent`(0)と `unwritable`(44)は1マスも動いていない。**
    // **このファイルでマスの総数が減るのは初めてである** —— 今までの更新はすべて
    // 「キーが増える」側だった。
    const all = cells();
    // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】112 → 116 に更新した。**
    // **旧行の逐語**: `expect(all).toHaveLength(112);`
    // **30個目のキー `report`(集計表の中身)が加わり、4形ぶんの4マスが増えた。**
    // **第2軸(形)には `report_view` を足していない**(理由は `VIEW_KEY_EMITS_STATEMENT`
    // の `report` の JSDoc)。
    // **【2026-08-15。`V8-M13-T03`。台帳 `Q-G31a` / `Q-G31b`】116 → 145 に更新した。**
    // **旧行の逐語**: `expect(all).toHaveLength(116);`
    // **第2軸(形)に5形目 `report_view` を足したためである**(理由は `VIEW_FORMS` の上の
    // コメント)。**キーは29のまま1つも増えていない** —— **29 × 5 = 145。**
    // **新たに書いた判断は 29マスちょうどで、既存116マスは1マスも書き換えていない。**
    // **【2026-08-20。`V10-M1-T02`。台帳 `NV-G4`。門A 本審査 = `V10-M0` 群A。
    // ADR = `0359`】145 → 150 に更新した。**
    // **旧行の逐語**: `expect(all).toHaveLength(145);`
    // **30キー目 `after_delete`(削除が成立したあとの行き先)が加わり、5形ぶんの5マスが
    // 増えた** —— **30 × 5 = 150。****新たに書いた判断は5マスちょうどで、既存145マスは
    // 1マスも書き換えていない。**
    // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。門A 本審査 = `V10-M0` 群B。
    // ADR = `0359` / `0360`】150 → 155 に更新した。**
    // **旧行の逐語**: `expect(all).toHaveLength(150);`
    // **31キー目 `flow`(一続きの流れの中の段)が加わり、5形ぶんの5マスが増えた** ——
    // **31 × 5 = 155。****新たに書いた判断は5マスちょうどで、既存150マスは
    // 1マスも書き換えていない。**
    expect(all).toHaveLength(155);
    // **【`V6-M6-T02` / `ADR-0291` A1 で 71 → 72 になった】** `reference_pickers/form` の
    // 1マスが `silent` から移った。**マスの総数(116)は1マスも動いていない。**
    // **【2026-08-15。`V8-M13-T03` で 68 → 75 に更新した】** **旧: `toHaveLength(68)`。**
    // **増えたのは `report_view` の列で開いている7キー**(`id` / `type` / `table` / `name` /
    // `custom_css` / `menu_listed` / `report`)**ちょうどである** —— **schema の
    // `report_view` 分岐が閉じていないキーが7本であることの写しであり、下の
    // 「`allOf` が実際に `false` にしている」検査が機械で裏を取る。**
    // **【この7本のうち `report` の1マスが、本タスクが実際に文を出させたものである】**
    // **残る6本は `V8-M8` の時点ですでに文が出ていた**(共通部分)。
    // **【2026-08-20。`V10-M1-T01` / `NV-G3a` / `ADR-0358` 限定1 で 75 → 76 に更新した】**
    // **旧行の逐語**: `expect(all.filter(([, e]) => e === "emits")).toHaveLength(75);`
    // **増えたのは `after_save/detail_view` の1マスちょうどである**(`unwritable` から移った)。
    // **門A の本審査(`V10-M0` 群A。判定 = 限定採用)が `detail_view` 分岐の
    // `"after_save": false,` を外したためである。****キーは29のまま1本も増えていない。**
    // **【2026-08-20。`V10-M1-T02` / `NV-G4` / `ADR-0359`】76 のまま1マスも動かない。**
    // **`after_delete` は5形とも `emits` ではない**(`detail_view` が `silent`、残る4マスが
    // `unwritable`)—— **`after_delete` を書いても要件定義書の文は1文も増えない。**
    // **【2026-08-20。`V10-M4-T01` / `NV-G9` / `ADR-0359` / `ADR-0360`】76 のまま1マスも動かない。**
    // **`flow` は5形とも `emits` ではない**(4形が `silent`、`report_view` が `unwritable`)——
    // **`flow` を書いても要件定義書の文は1文も増えない。**
    expect(all.filter(([, e]) => e === "emits")).toHaveLength(76);
    // **「書けるのに1文も出ない」26マスは、プリセット7キーと custom_css と audience と
    // menu_listed である** ——`ADR-0068` 共通10 が名指しで維持した欠落 + `ADR-0070` 限定5 の
    // 帰結 + `ADR-0084` の限定表が要件ドキュメントを1点も要求していないことの帰結であり、
    // **本タスクは要件ドキュメントの文を1本も足していない。**
    // **【V4-M16-T11 / ADR-0091 限定3】silent 26 → 28 / unwritable 28 → 26。**
    // **移ったのは2マスだけで、どちらも `preset_label_placement` / `preset_field_columns` の
    // `form` である**(`unwritable` → `silent`)。**要件ドキュメントの文は1本も増えていない**
    // —— 「書けるようになったが1文も出さない」側へ移っただけである。
    // **【V4-M20-T04 / ADR-0102 限定1・限定3 で 40 → 41 に更新した】** `after_save` の
    // `form` 1マスが加わった。
    // **【V4-M23-T01 / ADR-0104 限定4 で 41 → 43 に更新した】** `sum_field` の
    // `list_view` 2マスが加わった。
    // **【V4-M32-T01 / ADR-0126 A10 で 43 → 26 に縮んだ。述語も2つに縮んだ】**
    // **述語が長い列だったのは、「書けるのに1文も出ない」マスに2つの由来が混ざって
    // いたからである** —— (a) 審査が明示的に落としたもの(`ADR-0050` 限界8 /
    // `ADR-0055` 限定14 / `ADR-0068` 共通10)と、(b) 限定表が要件ドキュメントを
    // 1点も要求しなかったので出せなかったもの。**`ADR-0126` が (b) を全部 `emits` へ
    // 移したので、今日の `silent` 26マスは (a) だけになった。**
    // **逐語で書く: 書けるのに1文も出ないのは、審査が明示的に落としたものだけになった。**
    // **内訳は プリセット9キーの22マス + `custom_css` の4マス = 26 ちょうどである**
    // (`preset_column_align` 2 / `preset_column_width` 2 / `preset_pager_position` 2 /
    // `preset_label_placement` 2 / `preset_field_columns` 2 / `preset_image_size` 3 /
    // `preset_text_preview` 3 / `preset_list_shape` 2 / `preset_density` 4 = 22)。
    // **この2つの述語を3つ目に増やしたくなったら、それは (b) の穴をまた開けたという
    // ことである** —— `ADR-0126` §3a の 2 の門を通すこと。
    // **【V4-M39-T01 / ADR-0144 A9 + ADR-0145 A8 で 26 → 0 になった】**
    // **`$defs/view` に「書けるのに1文も出ない」キーは今日1つも無い。**
    // **述語は残す**(0件でも守り続ける)—— **`silent` が1マスでも復活したら、それは
    // (a)「審査が明示的に落とした」か (b)「限定表が要件ドキュメントを要求しなかった」の
    // どちらかであり、`ADR-0126` §3a の 2 / `ADR-0144` §3a の 2 の門を通すこと。**
    // **【`V6-M2-T01` / `K-G2` / `ADR-0289` で 0 → 1 に戻った。述語を1つ足した】**
    // **戻したのは `reference_pickers/form` の1マスだけである。** **由来は (b)
    // 「限定表が要件ドキュメントを1点も要求しなかった」側であり、門は `V6-M0` の
    // 本審査が `K-G21b` として別に通している**(`v6-m0.md` §7-11)。
    // **`ADR-0126` §3a の 2 / `ADR-0144` §3a の 2 が求める門を素通りしていない。**
    // **【`V6-M6-T02` / `K-G21b` / `ADR-0291` で 1 → 0 に戻った】**
    // **`V6-M2-T01` が (b)「限定表が要件ドキュメントを1点も要求しなかった」側として
    // 1マス戻していたものを、その門(`V6-M0` の `K-G21b`。判定 = 限定採用)の
    // 実装タスクである本タスクが塞いだ。**
    // **述語は残す**(0件でも守り続ける)—— **`silent` が1マスでも復活したら、それは
    // (a)「審査が明示的に落とした」か (b)「限定表が要件ドキュメントを要求しなかった」の
    // どちらかであり、`ADR-0126` §3a の 2 / `ADR-0144` §3a の 2 の門を通すこと。**
    // **【2026-08-20。`V10-M1-T02` / `NV-G4` / `ADR-0359` で 0 → 1 に戻った。述語を1つ足した】**
    // **戻したのは `after_delete/detail_view` の1マスだけである。**
    // **由来は (a)「審査が明示的に落とした」側ではない。** **正直に書くと、由来は
    // 「今日ある文面のどれを使っても事実でないことを述べることになり、専用の文面を
    // 新設する門(`ADR-0144` §3a の 2)を `ADR-0359` が通していない」ことである** ——
    // **理由の全文は上の `VIEW_KEY_EMITS_STATEMENT` の `after_delete` の JSDoc に書いた。**
    // **`ADR-0126` §3a の 2 / `ADR-0144` §3a の 2 が求める門を素通りしていない** ——
    // **通していないから `emits` にしなかった、という向きである。**
    // **【2026-08-20。`V10-M4-T01` / `NV-G9` / `ADR-0359` / `ADR-0360` で 1 → 5 になった。
    // 述語を1つ足した】**
    // **旧行の逐語**: `expect(silent).toEqual(["after_delete/detail_view"]);`
    // **増えたのは `flow` の4マスちょうどである**(`report_view` の1マスは `unwritable`)。
    // **由来は `after_delete` と同じで、(a)「審査が明示的に落とした」側ではない。**
    // **正直に書くと、由来は「今日ある文面のどれを使っても事実でないことを述べることに
    // なり、専用の文面を新設する門(`ADR-0144` §3a の 2)を `ADR-0359` / `ADR-0360` が
    // 通していない」ことである** —— **理由の全文は上の `VIEW_KEY_EMITS_STATEMENT` の
    // `flow` の JSDoc に書いた。**
    // **`ADR-0126` §3a の 2 / `ADR-0144` §3a の 2 が求める門を素通りしていない** ——
    // **通していないから `emits` にしなかった、という向きである。**
    const silent = all.filter(([, e]) => e === "silent").map(([name]) => name);
    expect(silent).toEqual([
      "after_delete/detail_view",
      "flow/list_view_equals_filter",
      "flow/list_view_boolean_filter",
      "flow/detail_view",
      "flow/form",
    ]);
    for (const name of silent) {
      expect(
        name.startsWith("preset_") ||
          name.startsWith("custom_css/") ||
          name.startsWith("reference_pickers/") ||
          name.startsWith("after_delete/") ||
          name.startsWith("flow/"),
      ).toBe(true);
    }
    // **【V4-M23-T01 / ADR-0104 限定4 で 41 → 43 に更新した】** `sum_field` の
    // `detail_view` 1マスと `form` 1マスが加わった。
    // **【V5-M21-T01 / `L-G1` / ADR-0171 で 43 → 41 に更新した】** `actions` の
    // `list_view` 2マスが抜けた(`unwritable` → `emits`)。**本ファイルで
    // `unwritable` が減るのは初めてである。****`form` の `actions` は今日も
    // `unwritable` のまま1マスも動いていない。**
    // **【`V6-M2-T01` / `ADR-0289` 限定4 で 41 → 44 に更新した】** `reference_pickers` の
    // `list_view` 2マスと `detail_view` 1マスが加わった(`form` でだけ書けるためである)。
    // **【2026-08-14。`V8-M8`。台帳 `Q-G1`】44 → 48 に更新した。**
    // **旧行の逐語**: `expect(all.filter(([, e]) => e === "unwritable")).toHaveLength(44);`
    // **`report` の4マス(4形すべて)が加わった** —— **`report` を書けるのは
    // `report_view` だけであり、この表の4形のどれでも `allOf` が `false` で閉じている。**
    // **【2026-08-15。`V8-M13-T03`】48 → 70 に更新した。**
    // **旧行の逐語**: `expect(all.filter(([, e]) => e === "unwritable")).toHaveLength(48);`
    // **`report_view` の列で閉じている22キーが加わった**(29 − 7)—— **行を1行ずつ並べる
    // 画面のキーは、束ねた結果に当たり先を1つも持たない。****75 + 70 = 145。**
    // **【2026-08-20。`V10-M1-T01` / `NV-G3a` / `ADR-0358` 限定1 で 70 → 69 に更新した】**
    // **旧行の逐語**: `expect(all.filter(([, e]) => e === "unwritable")).toHaveLength(70);`
    // **減ったのは `after_save/detail_view` の1マスちょうどである。****76 + 69 = 145。**
    // **`list_view` 2形と `report_view` の `after_save` は今日も `unwritable` のままである**
    // (限定1。`NV-G3b` = **却下**)。
    // **【2026-08-20。`V10-M1-T02` / `NV-G4` / `ADR-0359` 限定2 で 69 → 73 に更新した】**
    // **旧行の逐語**: `expect(all.filter(([, e]) => e === "unwritable")).toHaveLength(69);`
    // **増えたのは `after_delete` の4マスちょうどである**(`list_view` 2形 / `form` /
    // `report_view`。**書けるのは `detail_view` だけだからである**)。
    // **76 + 1 + 73 = 150。**
    // **【2026-08-20。`V10-M4-T01` / `NV-G9` / `ADR-0359` / `ADR-0360` で 73 → 74 に更新した】**
    // **旧行の逐語**: `expect(all.filter(([, e]) => e === "unwritable")).toHaveLength(73);`
    // **増えたのは `flow/report_view` の1マスちょうどである**(**集計表は流れの段に
    // なれない**。`V10-M4` の決1)。**76 + 5 + 74 = 155。**
    expect(all.filter(([, e]) => e === "unwritable")).toHaveLength(74);
    // **【V4-M16-T13 / ADR-0093 限定1 で 21 → 22 に更新した】** 門A の本審査(`V4-M14` 本審査② の単位11。判定 = 限定採用)が22キー目 `preset_list_shape`(一覧の器の形)を足した。
    // **【V4-M18-T03 / ADR-0095 限定1 で 22 → 23 に更新した】** 門A の本審査(V4-M18 単位3。
    // 判定 = 限定採用)が23キー目 `modal` を足した。
    // **【V4-M22-T01 / ADR-0112 限定1 で 23 → 24 に更新した】** 門A の本審査(V4-M22 単位A。
    // 判定 = 限定採用)が24キー目 `search_fields` を足した。
    // **【V4-M22-T05 / ADR-0113 限定1 で 24 → 25 に更新した】** 門A の本審査(V4-M22 単位C。
    // 4回目の審査。判定 = 限定採用)が25キー目 `page_size` を足した。
    // **【V4-M19-T03 / ADR-0118 限定1 で 25 → 26 に更新した】** 門A の本審査(V4-M19 単位C。
    // 2回目の審査。判定 = 限定採用)が26キー目 `preset_density` を足した。**本 ADR の
    // 増分ではない。**
    // **【V4-M20-T04 / ADR-0102 限定1 で 26 → 27 に更新した】** 門A の本審査(V4-M20 単位D。
    // 2回目の審査。判定 = 限定採用)が27キー目 `after_save` を足した。**本 ADR の増分では
    // ない。**
    // **【V4-M23-T01 / ADR-0104 限定1 で 27 → 28 に更新した】** 門A の本審査(V4-M23
    // 単位A-2。4回目の審査 = 3回目の再提出。判定 = 限定採用)が28キー目 `sum_field` を
    // 足した。**本 ADR の増分そのものである。**
    // **【V4-M32-T01 / ADR-0126 B3】28 のまま1つも動かない** —— **本タスクは `schemas/` を
    // 1バイトも変えていない。****動いたのはマスの値だけである。**
    // **【`V6-M2-T01` / `K-G2` / `ADR-0289` 限定1 で 28 → 29 に更新した】** 門A の本審査
    // (`V6-M0` 単位A。判定 = 限定採用)が29キー目 `reference_pickers`(参照項目の選び方の、
    // 入力画面ごとの上書き)を足した。**本 ADR の増分そのものである。**
    // **【`V8-M20` / 台帳 `J-G27` / `ADR-0301` で 29 → 28 に縮んだ】** **旧:
    // `toHaveLength(29)`。** **`$defs/view` から `audience` が廃止されたためである。**
    // **このファイルで `$defs/view` のキーが減るのは初めてである。**
    // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】28 → 29 に更新した。**
    // **旧行の逐語**: `expect(Object.keys(VIEW_KEY_EMITS_STATEMENT)).toHaveLength(28);`
    // **門A の本審査(`V8-M7`)が29キー目 `report`(集計表の中身)を足した。**
    // **【2026-08-20。`V10-M1-T02`。台帳 `NV-G4`。門A 本審査 = `V10-M0` 群A】29 → 30 に更新した。**
    // **旧行の逐語**: `expect(Object.keys(VIEW_KEY_EMITS_STATEMENT)).toHaveLength(29);`
    // **門A の本審査(`V10-M0` 群A)が30キー目 `after_delete`(削除の後の行き先)を足した。**
    // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。門A 本審査 = `V10-M0` 群B】30 → 31 に更新した。**
    // **旧行の逐語**: `expect(Object.keys(VIEW_KEY_EMITS_STATEMENT)).toHaveLength(30);`
    // **門A の本審査(`V10-M0` 群B)が31キー目 `flow`(一続きの流れの中の段)を足した。**
    expect(Object.keys(VIEW_KEY_EMITS_STATEMENT)).toHaveLength(31);
  });

  // **【2026-08-20。`V10-M1-T01` / `ADR-0358`。テスト名の食い違いを先に申告する】**
  // **着手前のこの名前は「`unwritable` の34マス」であり、実測(着手前 70 / 今日 69)と
  // 食い違っていた** —— **名前が `V4-M18-T03` 前後の値で止まっていた。**
  // **本タスクが `unwritable` を1マス減らすので、その食い違いも同時に直す。**
  // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。ADR = `0359` / `0360`。題名の数を直した】**
  // **旧名の逐語**: `` `unwritable` の73マスは schema の allOf が実際に `false` にしている(散文で決めない) ``
  // **`expect` は本数を1つも持たないので緑のままだった** —— **嘘になるのは題名だけである。**
  test("`unwritable` の74マスは schema の allOf が実際に `false` にしている(散文で決めない)", () => {
    const branches = canonicalViewSchema().allOf;
    for (const form of VIEW_FORMS) {
      const branch = branches.find(
        (candidate) => candidate.if.properties.type.const === SCHEMA_BRANCH_OF_FORM[form],
      );
      expect(branch).toBeDefined();
      for (const key of Object.keys(VIEW_KEY_EMITS_STATEMENT)) {
        const emission = VIEW_KEY_EMITS_STATEMENT[key]?.[form];
        if (emission === "unwritable") {
          expect(branch?.then.properties?.[key]).toBe(false);
        } else {
          // **`emits` / `silent` の側は `false` になっていない(= 書ける)ことも裏を取る。**
          expect(branch?.then.properties?.[key]).not.toBe(false);
        }
      }
    }
  });

  test("22キー目が増えると上の照合が赤くなる(schemas/ を1バイトも変えずに確かめる)", () => {
    const withTwentiethKey = [...canonicalViewKeys(), "for_each"];
    expect(withTwentiethKey).not.toEqual(Object.keys(VIEW_KEY_EMITS_STATEMENT));
    const reordered = [...canonicalViewKeys()].reverse();
    expect(reordered).not.toEqual(Object.keys(VIEW_KEY_EMITS_STATEMENT));
    expect(VIEW_KEY_EMITS_STATEMENT.for_each).toBeUndefined();
  });

  /*
   * **【2026-08-04。`V4-M39-T01` / `ADR-0144` A9 による反転。テストは1本も消していない】**
   *
   * **着手前のこのテストの名前の逐語**:
   * 「**『出さない』と決めたプリセット7キーは、書いても screens の文が1文も増えない(実測)**」
   * **着手前の期待値の逐語**: `expect(after).toEqual(before);` と、
   * `for (const value of ["preset_", "stacked", "thumbnail"]) { expect(markdown).not.toContain(value); }`
   *
   * **`V4-M39` の門A 本審査(`V4-M39-G1` = 単位A。判定 = 限定採用)が「出さない」の側を
   * 覆したので、期待値を反転する。** **この describe が塞ごうとしていたもの(門を通さずに
   * 載せ方を変えられること)は1バイトも緩めていない** —— **変わったのは門の判定であって、
   * 歯止めではない。** **両方向の歯止めであることも維持する** ——
   * **出なくなったらこのテストが赤くなる。**
   */
  test("門A が『出す』に覆したプリセット7キーは、書くと screens の文が増える(実測)", () => {
    seedBase();
    const before = generateRequirementsDoc(dataRoot, APP_ID)
      .statements.filter((s) => s.section === "screens")
      .map((s) => s.text);

    apply({
      diff_id: "d-050",
      intent: "画面ごとの見せ方を選ぶ",
      operations: [
        {
          op: "update_view",
          view: "book-list",
          changes: {
            preset_column_align: { title: "center" },
            preset_column_width: { title: "wide" },
            preset_pager_position: "both",
            preset_image_size: "thumbnail",
            preset_text_preview: "long",
          },
        },
        {
          op: "update_view",
          view: "book-detail",
          changes: {
            preset_label_placement: "stacked",
            preset_field_columns: 2,
            preset_image_size: "medium",
            preset_text_preview: "short",
          },
        },
      ],
    });

    const after = generateRequirementsDoc(dataRoot, APP_ID)
      .statements.filter((s) => s.section === "screens")
      .map((s) => s.text);

    // **9文増える**(7キー分。`book-list` の5本 + `book-detail` の4本)。
    // **出なくなったらこのテストが赤くなり、「出すと決めたはずのものが出ていない」ことに
    // 気付ける(両方向の歯止め)。**
    expect(after).not.toEqual(before);
    expect(after.length - before.length).toBe(9);
    // **既にあった文は、並びも本文も1バイトも変わらない**(A3)。
    expect(after.filter((text) => before.includes(text))).toEqual(before);
    // **プリセットの値は語彙タグとして地の文に現れる**(`term` スロット)。
    const markdown = generateRequirementsDoc(dataRoot, APP_ID).markdown;
    for (const value of ["`stacked`", "`thumbnail`"]) {
      expect(markdown).toContain(value);
    }
    // **キーの名前そのもの(`preset_`)は1度も現れない** —— 出すのは値であって、
    // マニフェストのキー名ではない(`ADR-0025` §4-2 の描き方を1バイトも変えていない)。
    expect(markdown).not.toContain("preset_");
  });
});

/**
 * V3-M9-T03b: 複数入力(配列形。ADR-0062)の要件ドキュメントへの現れ方の固定。
 *
 * **これは望ましい状態を固定しているのではなく、今日の挙動を固定している。**
 * **出す方が良いと判断されたら、このテストを意図的に更新すること。**
 * **`ADR-0025` の門を通さずに `else` を足せてしまう状態を塞ぐのが目的である。**
 *
 * 何を塞ぐのか —— `src/kernel/requirements-doc.ts` の `if (!Array.isArray(declaredInput))`
 * には `else` が無い。そのため **関数の入力を配列形で書くと、入力の文
 * (`automation.function_input_table` / `_view` / `_record`)が1件も出ない。**
 * 単体形なら1件出る。つまり **V3-M9 は「それまで載っていたものが載らなくなる経路」を
 * 新設した** —— 単体形を配列形に書き換えるだけで、要件ドキュメントから入力の記述が消える。
 * この事実は V3-M9-T05 が実際に生成して実測したものであり(v3-m9-t05.md §2-3)、
 * **V3-M9 は生成器を変更しないと判定した**(同 §7-1)。判定の結果として今日の正である。
 *
 * **正であることと、機械的に固定されていることは別である。** 固定が無ければ、誰かが
 * ここに `else` を足しても既存の検査は1本も落ちない —— `ADR-0025` の門を通さずに
 * 文書の載せ方を変えられてしまう。それを塞ぐのがこの describe である。
 *
 * 試材は T05 のプローブと同じ形にしてある(テーブル5・ビュー1・関数1・自動化1)。
 * T05 が測った数(単体形 69 statement / 配列形 68 statement / 差分は
 * `automation.function_input_table` の1文ちょうど / 要素数を変えても・`update_function`
 * で入れ替えても生成物は1バイトも変わらない)を、T03b でも自分で再現してから落としている。
 *
 * ---
 *
 * **【2026-08-01。V3-M13-T12 による期待値の更新。上の記述は判定時点の記録として残す】**
 *
 * **上の段落が「出す方が良いと判断されたら、このテストを意図的に更新すること」と書いた、
 * その判断が下りた。** `ADR-0068` A3(`V3-M11-G1` = **限定採用**。結論が出た問は問4)が
 * **「配列形は要素ごとに1文を出す」**と定めたので、本 describe の期待値をそのとおりに
 * 更新する。**この describe が塞ごうとしていたもの(門を通さずに載せ方を変えられること)は
 * 1バイトも緩めていない** —— 変わったのは門の判定であって、歯止めではない。
 *
 * **`T02` §5-3 の判定基準に当てると、下の4本はすべて (b)「期待値の更新」である**
 * ——赤くなった assertion が固定していた振る舞い(配列形で入力の文が0件であること)は、
 * **`ADR-0068` A3 が名指しで変えると定めた項目の直接の帰結**である。**(a)「実装の誤り」は0件。**
 * **「バグを直した」ではない**(禁止4)—— `V3-M9` の0件は決定であり、見落としではなかった。
 *
 * **単体形の生成物は今日も1バイトも変わっていない**(A3 の禁止形)。T03b-3 の期待値
 * (69 statement / 7104 バイト / automation 節の全文)は**1文字も書き換えていない。**
 */
describe("V3-M9-T03b: 複数入力(配列形)の現れ方 —— ADR-0068 A3 による更新後(ADR-0062 / ADR-0025)", () => {
  const PROBE_APP_ID = "shop";
  const PROBE_APP_NAME = "受注管理";

  /** 単体形の入力の文を出す3テンプレート。**位置つきの3本(配列形)とは別である。** */
  const INPUT_TEMPLATES: readonly RequirementTemplateId[] = [
    "automation.function_input_table",
    "automation.function_input_view",
    "automation.function_input_record",
  ];

  /** 配列形の入力の文を出す3テンプレート(ADR-0068 A3。位置を持つ)。 */
  const INPUT_AT_TEMPLATES: readonly RequirementTemplateId[] = [
    "automation.function_input_table_at",
    "automation.function_input_view_at",
    "automation.function_input_record_at",
  ];

  /** 単体形(`{ source: "table", table: "order" }`)。今日まで唯一の形。 */
  const SINGLE: FunctionInput = { source: "table", table: "order" };
  /** 配列形・要素1。**意味は単体形と同じで、形だけが違う。** */
  const ARRAY1: FunctionInput[] = [{ source: "table", table: "order" }];
  /** 配列形・要素3。ADR-0062 §3 が挙げた「トリガー元 + 明細表 + マスタ表」。 */
  const ARRAY3: FunctionInput[] = [
    { source: "record" },
    { source: "table", table: "order_item" },
    { source: "table", table: "tax_rate" },
  ];

  /**
   * 単体形のときの automation 節の逐語(**T05 §2-2 の実測をそのまま置く**)。
   * 後方互換の固定はここが本体である —— 件数だけでなく**文そのもの**を突き合わせる。
   */
  const SINGLE_AUTOMATION_TEXTS: readonly string[] = [
    "自動化 `recalc`(表示名 「注文が増えたら計算する」)の実行履歴はテーブル `wf_runs` に記録される。",
    "自動化 `recalc` は、テーブル `order` にレコードが作られたとき(発火条件 `on_create`)に動く。",
    "自動化 `recalc` の `1` 番目の動作は `run_function` である。",
    "自動化 `recalc` の `1` 番目の動作は関数 `calc_total` を実行し、結果をテーブル `calc_result` に書き込む。",
    "関数 `calc_total`(表示名 「税込金額を計算する」)が定義されている。",
    "関数 `calc_total` はテーブル `order` の全行を入力に取る(入力元は `table`)。",
    "関数 `calc_total` の出力の `1` 番目のフィールドは `amount` で、型は `number` である。",
  ];

  /** 生成時刻(`applied_at` / 作成時刻)だけを潰す。ADR-0025 §6 の決定論は同一入力について言う。 */
  function normalizeTimestamps(markdown: string): string {
    return markdown.replace(/20\d\d-\d\d-\d\dT[0-9:.]+Z/g, "<TS>");
  }

  function byteLength(text: string): number {
    return new TextEncoder().encode(text).length;
  }

  /**
   * 関数の入力だけを差し替えて要件ドキュメントを1本作る。
   *
   * **専用の一時 dataRoot を作る** —— `update_function` 前後や配列形どうしを
   * **別々のアプリとして**突き合わせる必要があるためである(グローバルの dataRoot は触らない)。
   */
  async function generateForInput(
    input: FunctionInput | FunctionInput[],
    updateTo?: FunctionInput | FunctionInput[],
  ): Promise<{ doc: RequirementsDoc; markdown: string }> {
    const root = await mkdtemp(join(tmpdir(), "gp-req-doc-multi-input-"));
    const probeStore = KernelMetaStore.open(root);
    try {
      createApp(probeStore, PROBE_APP_NAME, { app_id: PROBE_APP_ID });
      const applyHere = (diff: Diff): void => {
        const result = applyDiff(root, PROBE_APP_ID, diff);
        if (!result.valid) {
          throw new Error(
            `テスト前提の差分適用に失敗しました(${diff.diff_id}): ${JSON.stringify(result.errors)}`,
          );
        }
      };
      applyHere({
        diff_id: "d-001-tables",
        intent: "注文と明細と税率の台帳を作る。",
        operations: [
          {
            op: "add_table",
            table: {
              id: "order",
              name: "注文",
              fields: [{ id: "total", name: "合計金額", type: "number" }],
            },
          },
          {
            op: "add_table",
            table: {
              id: "order_item",
              name: "注文明細",
              fields: [
                { id: "order_ref", name: "注文", type: "reference", reference_table: "order" },
                { id: "qty", name: "数量", type: "number" },
              ],
            },
          },
          {
            op: "add_table",
            table: {
              id: "tax_rate",
              name: "税率",
              fields: [{ id: "rate", name: "率", type: "number" }],
            },
          },
          {
            op: "add_table",
            table: {
              id: "calc_result",
              name: "計算結果",
              fields: [{ id: "amount", name: "金額", type: "number" }],
            },
          },
          {
            op: "add_table",
            table: {
              id: "wf_runs",
              name: "実行履歴",
              fields: [
                { id: "ran_at", name: "実行時刻", type: "date" },
                { id: "workflow", name: "自動化", type: "text" },
                { id: "trigger_type", name: "きっかけ", type: "text" },
                { id: "status", name: "結果", type: "text" },
                { id: "error", name: "エラー", type: "long_text" },
              ],
            },
          },
          {
            op: "add_view",
            view: {
              id: "order_list",
              name: "注文一覧",
              type: "list_view",
              table: "order",
              columns: ["total"],
            },
          },
        ],
      });
      applyHere({
        diff_id: "d-002-function",
        intent: "税込金額を計算する島を置く。",
        operations: [
          {
            op: "add_function",
            function: {
              id: "calc_total",
              name: "税込金額を計算する",
              code: "export default (rows) => rows;",
              input,
              output: { fields: [{ id: "amount", type: "number" }] },
              capabilities: [],
            },
          },
          {
            op: "add_workflow",
            workflow: {
              id: "recalc",
              name: "注文が増えたら計算する",
              trigger: { type: "on_create", table: "order" },
              actions: [
                { action: "run_function", function: "calc_total", output_table: "calc_result" },
              ],
              history_table: "wf_runs",
            },
          },
        ],
      });
      if (updateTo !== undefined) {
        applyHere({
          diff_id: "d-003-change-input",
          intent: "関数の入力を見直す。",
          operations: [
            {
              op: "update_function",
              function: {
                id: "calc_total",
                name: "税込金額を計算する",
                code: "export default (rows) => rows;",
                input: updateTo,
                output: { fields: [{ id: "amount", type: "number" }] },
                capabilities: [],
              },
            },
          ],
        });
      }
      const doc = generateRequirementsDoc(root, PROBE_APP_ID);
      return { doc, markdown: normalizeTimestamps(doc.markdown) };
    } finally {
      probeStore.close();
      await rm(root, { recursive: true, force: true });
    }
  }

  function inputStatements(doc: RequirementsDoc): RequirementStatement[] {
    return doc.statements.filter((s) => INPUT_TEMPLATES.includes(s.template));
  }

  function inputAtStatements(doc: RequirementsDoc): RequirementStatement[] {
    return doc.statements.filter((s) => INPUT_AT_TEMPLATES.includes(s.template));
  }

  /** statement の本文も生成時刻を潰してから突き合わせる(history 節が時刻を持つため)。 */
  function normalizedTexts(doc: RequirementsDoc): string[] {
    return doc.statements.map((s) => normalizeTimestamps(s.text));
  }

  test("T03b-1: 配列形(要素1)では入力の文が1件出る(ADR-0068 A3 による更新。旧期待値は0件)", async () => {
    const { doc, markdown } = await generateForInput(ARRAY1);

    // **「たまたま通っている」を排する**: 関数そのものは確かに文書に載っている。
    const templates = doc.statements.map((s) => s.template);
    expect(templates).toContain("automation.function");
    expect(templates).toContain("automation.function_output_field");

    // **単体形の3本は1件も使われない**(位置つきの3本が使われる。後方互換の分離)。
    expect(inputStatements(doc)).toHaveLength(0);
    for (const templateId of INPUT_TEMPLATES) {
      expect(templates).not.toContain(templateId);
    }
    // **ここが更新された期待値である。** 要素1 → 1文。
    expect(inputAtStatements(doc)).toHaveLength(1);
    expect(inputAtStatements(doc)[0]?.template).toBe("automation.function_input_table_at");
    expect(markdown).toContain(
      "関数 `calc_total` の `1` 番目の入力はテーブル `order` の全行である(入力元は `table`)。",
    );
    // **単体形の文言(「入力に取る」)は、配列形の生成物に1文字も混ざらない。**
    expect(markdown).not.toContain("入力に取る");
  });

  test("T03b-2: 配列形(要素3)では入力の文が3件出る(要素ごとに1文)", async () => {
    const { doc, markdown } = await generateForInput(ARRAY3);

    const templates = doc.statements.map((s) => s.template);
    expect(templates).toContain("automation.function");
    expect(templates).toContain("automation.function_output_field");

    expect(inputStatements(doc)).toHaveLength(0);
    // **宣言した3つの入力が、宣言順に3文として現れる。**
    expect(inputAtStatements(doc).map((s) => s.template)).toEqual([
      "automation.function_input_record_at",
      "automation.function_input_table_at",
      "automation.function_input_table_at",
    ]);
    expect(markdown).toContain(
      "関数 `calc_total` の `2` 番目の入力はテーブル `order_item` の全行である(入力元は `table`)。",
    );
    expect(markdown).toContain(
      "関数 `calc_total` の `3` 番目の入力はテーブル `tax_rate` の全行である(入力元は `table`)。",
    );
    expect(markdown).not.toContain("入力に取る");
  });

  test("T03b-3: 単体形の生成結果は今日と同一である(後方互換。V3-M9 で1バイトも変わっていない)", async () => {
    const { doc, markdown } = await generateForInput(SINGLE);

    // T05 §2-1 の実測(69 statement)。
    // **【`V8-M22` / 台帳 `J-G34a` / `ADR-0315` で 69 → 75 に更新した】** **旧: `69`。**
    // **増えた6は既定3役割 ×(名前1 + 表示名1)である** —— **`set_roles` を1度も
    // 呼んでいないアプリでも増える**(`create_app` が既定3本を必ず書き込むため)。
    // **テスト名の「今日と同一である」は当時の逐語であり、書き換えていない** ——
    // **本タスクは後方互換を測っているのではなく、波及を数で残している。**
    // **【`V8-M26-T04` で 75 → 108 に更新した】** **旧: `75`。**
    // **増えた33は、`T04`(作るたびに既定3役割の規則を自動で足す。ユーザ決定 `D-V8-56` /
    // `D-V8-60` / `D-V8-61` / `D-V8-62`)が入れた規則の文である** —— **表・画面・ボタンを
    // 差分で作った分だけ、3役割それぞれに1本ずつ規則が入る。**
    // **テスト名の「今日と同一である」は当時の逐語であり、書き換えていない。**
    expect(doc.statements).toHaveLength(108);
    // T05 §2-2 の逐語。**automation 節の全文を突き合わせる。**
    const automationTexts = doc.statements
      .filter((s) => s.section === "automation")
      .map((s) => s.text);
    expect(automationTexts).toEqual([...SINGLE_AUTOMATION_TEXTS]);
    // 入力の文はちょうど1件出る(配列形の0件との対照)。
    const inputs = inputStatements(doc);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.template).toBe("automation.function_input_table");
    // T05 §2-1 の実測(生成時刻を `<TS>` に正規化したあとの markdown のバイト数)。
    // **T05 の記録は 7105 と書いているが、それはプローブが `console.log` で足した
    // 末尾の改行1バイトを含む値である**(T03b が再実測して切り分けた)。
    // `doc.markdown` そのものは **7104 バイト**である。
    // **【`V8-M22` / 台帳 `J-G34a` / `ADR-0315` で 7104 → 7432 に更新した】** **旧: `7104`。**
    // **増えた 328 バイトは既定3役割の6文である**(名前3 + 表示名3)。
    // **【`V8-M26-T04` で 7432 → 11250 に更新した】** **旧: `7432`。**
    // **増えた 3818 バイトは、`T04` が自動で足した規則(33文)の分である。**
    // **【`V10-M34-T01`(2026-08-26)。台帳 `CM-G45` / `ADR-0379` で 11250 → 11386 に更新した】**
    // **旧: `11250`。** **増えた 136 バイトは、前書きに足した固定の1文
    // 「コメントの書く欄と読む場所はアプリごとの設定であり、この文書はその設定を1件も読んでいない。」
    // の分ちょうどである**(46文字。全角45 × 3バイト + 半角「1」1バイト = 136)。
    // **文の型(`REQUIREMENT_TEMPLATES`)は1本も増えていない** —— 149 のままである。
    expect(byteLength(markdown)).toBe(11386);
  });

  test("T03b-4: 単体形と配列形の差は入力の文の言い回しだけである(旧: 配列形で1文消える)", async () => {
    const single = await generateForInput(SINGLE);
    const array1 = await generateForInput(ARRAY1);

    // **statement 数が揃った。** 旧期待値は 69 → 68(配列形で1文**減っていた**)。
    // **【`V8-M22` / `ADR-0315` で 69 → 75 に更新した】** **増えた6は既定3役割の分である。**
    // **【`V8-M26-T04` で 75 → 108 に更新した】** **旧: `75`。**
    // **増えた33は、`T04`(作るたびに既定3役割の規則を自動で足す。ユーザ決定 `D-V8-56` /
    // `D-V8-60` / `D-V8-61` / `D-V8-62`)が入れた規則の文である** —— **表・画面・ボタンを
    // 差分で作った分だけ、3役割それぞれに1本ずつ規則が入る。**
    // **テスト名の「今日と同一である」は当時の逐語であり、書き換えていない。**
    expect(single.doc.statements).toHaveLength(108);
    // **【`V8-M26-T04` で 75 → 108 に更新した】** **旧: `75`。** **増えた33は自動付与の規則の文。**
    expect(array1.doc.statements).toHaveLength(108);

    const singleTexts = normalizedTexts(single.doc);
    const arrayTexts = normalizedTexts(array1.doc);
    // 差は入力の1文の言い回しだけで、**他は1文も動いていない。**
    expect(singleTexts.filter((t) => !arrayTexts.includes(t))).toEqual([
      "関数 `calc_total` はテーブル `order` の全行を入力に取る(入力元は `table`)。",
    ]);
    expect(arrayTexts.filter((t) => !singleTexts.includes(t))).toEqual([
      "関数 `calc_total` の `1` 番目の入力はテーブル `order` の全行である(入力元は `table`)。",
    ]);
  });

  test("T03b-5: 配列の要素数を変えると生成物が変わる(旧: 1バイトも変わらなかった)", async () => {
    const array1 = await generateForInput(ARRAY1);
    const array3 = await generateForInput(ARRAY3);

    // **ここが本タスクの中核である。** 旧期待値は「まったく違う入力を宣言した2つの
    // アプリの要件定義書が1バイトも違わない」だった。
    expect(array3.markdown).not.toBe(array1.markdown);
    expect(array3.doc.statements).toHaveLength(array1.doc.statements.length + 2);
  });

  test("T03b-6: `update_function` で入力を全部入れ替えると生成物が変わる(旧: 変わらなかった)", async () => {
    // 対照: `array1` → `array1`(何も変えていない)。
    const same = await generateForInput(ARRAY1, ARRAY1);
    // 実験: `array1` → `array3`(入力を全部入れ替えた)。
    const changed = await generateForInput(ARRAY1, ARRAY3);

    // **履歴節は今日も「`update_function` を行った」までしか書かない** ——
    // 変わったのは **現在のマニフェストを述べる automation 節**である。
    expect(changed.markdown).not.toBe(same.markdown);
    // **【`V8-M22` / `ADR-0315` で 73 → 79 に更新した】** **増えた6は既定3役割の分である。**
    // **【`V8-M26-T04` で 79 → 112 に更新した】** **旧: `79`。**
    // **増えた33は、`T04`(作るたびに既定3役割の規則を自動で足す。ユーザ決定 `D-V8-56` /
    // `D-V8-60` / `D-V8-61` / `D-V8-62`)が入れた規則の文である** —— **表・画面・ボタンを
    // 差分で作った分だけ、3役割それぞれに1本ずつ規則が入る。**
    // **テスト名の「今日と同一である」は当時の逐語であり、書き換えていない。**
    expect(same.doc.statements).toHaveLength(112);
    // **【`V8-M22` / `ADR-0315` で 69 → 75 に更新した】** **増えた6は既定3役割の分である。**
    // **【`V8-M26-T04` で 81 → 114 に更新した】** **旧: `81`。** **増えた33は自動付与の規則の文。**
    expect(changed.doc.statements).toHaveLength(114);
    // 入れ替えた後の入力の文が、入れ替え後の宣言(record + table 2本)を述べている。
    expect(inputAtStatements(changed.doc).map((s) => s.template)).toEqual([
      "automation.function_input_record_at",
      "automation.function_input_table_at",
      "automation.function_input_table_at",
    ]);
    // 単体形の3本は今日も1件も使われない。
    expect(inputStatements(changed.doc)).toHaveLength(0);
  });
});

/**
 * **`$defs/workflow_trigger` のキーのうち、要件ドキュメントに文を出すものの集合**
 * (V3-M11-T06。`v3-m10-t07.md` §8 の申し送り (c) = メインの裁定3)。
 *
 * `$defs/view` 側の `VIEW_KEY_EMITS_STATEMENT`(`:1285`〜`:1309`)と**同じ役目**を負うが、
 * **同じ形にはできない** —— view のキーは「出す / 出さない」の2値で書けるのに対し、
 * **`workflow_trigger` の `table` キーは `on_create` / `on_update` では文を出し、
 * `schedule` では1文も出さない**(`v3-m10-t06.md:216` 逐語「**同じ `table: "order"` という
 * 宣言が、`on_create` では1文になり、`schedule` では0文になる**」)。
 * したがって**キー × トリガー種別**の表にし、値も2値ではなく3値にした(下の `Emission`)。
 *
 * **この表が防ぐのは「文が出ないこと」ではなく「判断を書かないまま静かに通ること」である。**
 * `ADR-0064` が3キー → 4キーにしたとき、`src/kernel/workflow-schema.test.ts:1120` は
 * 確かに赤くなった(`7e5faea` の diff が期待値の更新を記録している)。
 * **しかし赤くなったのは schema の形を見る検査だけで、要件ドキュメント側は1本も赤くならず、
 * `older_than` は「出す / 出さない」の判断が1度も書かれないまま出荷された。**
 * ここが塞ぐのはその穴である。
 */
describe("V3-M11-T06: workflow_trigger のキーのうち要件ドキュメントに文を出すものの集合(ADR-0063 / ADR-0064)", () => {
  /*
   * `$defs/workflow_trigger.properties.type.enum` の値。**宣言順のまま**である。
   *
   * **【`V5-M25-T01` / `L-G8` / `ADR-0174` による追随。旧を隠さない】**
   * **旧(逐語)**: 「`$defs/workflow_trigger.properties.type.enum` の**3値**」/
   * `const TRIGGER_TYPES = ["on_create", "on_update", "schedule"] as const;`
   *
   * **【この表は `manual` を1件も捕まえられなかった。正直に書く】**
   * **本 describe の doc は「この表が防ぐのは『判断を書かないまま静かに通ること』である」と
   * 書いている。** **しかし種別の側が増えても、キーの本数(4)が変わらない限りこの表は
   * 赤くならない** —— **`ADR-0174` が4値目を足したとき、本ファイルで赤くなったのは
   * テンプレート本数の検査だけで、この表は緑のまま通った。**
   * **穴は「キー × 種別」の**種別の側**に見張りが無かったことである。**
   * **下に種別の本数を schema と突き合わせる検査を1本足した**(`V5-M25-T01`)。
   */
  const TRIGGER_TYPES = ["on_create", "on_update", "schedule", "manual"] as const;
  type TriggerType = (typeof TRIGGER_TYPES)[number];

  /**
   * **キーの現れ方。単一の boolean では書けないので3値にした。**
   *
   * - `"emits"` —— そのトリガー種別で書け、要件ドキュメントに文が出る。
   * - `"silent"` —— **書けるのに文が1つも出ない**(要件ドキュメントの欠落。当て先はここ)。
   * - `"unwritable"` —— schema がそのトリガー種別で書けなくしている(`allOf` の
   *   `"at": false` / `"older_than": false`)。**「出さないと決めた」のではなく「書けない」。**
   *   この3つ目の値は散文ではなく schema と突き合わせて裏を取る(下の検査)。
   */
  type Emission = "emits" | "silent" | "unwritable";

  const TRIGGER_KEY_EMITS_STATEMENT: Record<string, Record<TriggerType, Emission>> = {
    // `automation.trigger_on_create` / `_on_update` / `_schedule` の `trigger_type` スロット。
    // **3種別すべてで出る。**
    // **`manual`(`ADR-0174`)**: `automation.trigger_manual` の `trigger_type` スロット。
    type: { on_create: "emits", on_update: "emits", schedule: "emits", manual: "emits" },
    // **【V3-M13-T12 による期待値の更新。上の記述は当時の実測として残す】**
    // **当時**: 同じキーが種別で割れ、schedule 分岐は `trigger.table` を1度も読まなかった
    // (D-G16a / ADR-0063 が足した意味は0文だった)。
    // **今日**: `ADR-0068` A4(`V3-M11-G1` = 限定採用)により
    // `automation.trigger_schedule_table` の1文が出る。**3種別とも `emits` になった。**
    // **`manual`(`ADR-0174`)**: `automation.trigger_manual` の `table_id` スロット。
    // **必須である**(schema の `manual` 分岐が `required: ["table"]`)。
    table: { on_create: "emits", on_update: "emits", schedule: "emits", manual: "emits" },
    // `automation.trigger_schedule` の `hour` / `minute` スロット(`:1452`〜`:1453`)。
    // on_create / on_update では schema が `"at": false` にしている。
    at: {
      on_create: "unwritable",
      on_update: "unwritable",
      schedule: "emits",
      manual: "unwritable",
    },
    // **D-G16b / ADR-0064 が足した4キー目。** **schedule かつ table を書いたときだけ
    // 書ける**(`allOf` の4分岐目)。
    // **【V3-M13-T12 による期待値の更新。当時の実測は残す】** **当時**: 生成器に
    // `older_than` の語は0件で、`days` を 3 → 30 にしても生成物は1バイトも変わらなかった
    // (`v3-m10-t06.md` §2-2 (3))。**今日**: `ADR-0068` A5 により
    // `automation.trigger_schedule_older_than` の1文が出る。
    older_than: {
      on_create: "unwritable",
      on_update: "unwritable",
      schedule: "emits",
      manual: "unwritable",
    },
  };

  function canonicalTriggerSchema(): {
    properties: Record<string, unknown>;
    allOf: {
      if: { properties: { type: { const: string } }; not?: unknown };
      then: { required?: string[]; properties?: Record<string, unknown> };
    }[];
  } {
    const schema = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "..", "schemas", "manifest.schema.json"), "utf-8"),
    ) as {
      $defs: {
        workflow_trigger: {
          properties: Record<string, unknown>;
          allOf: {
            if: { properties: { type: { const: string } }; not?: unknown };
            then: { required?: string[]; properties?: Record<string, unknown> };
          }[];
        };
      };
    };
    return schema.$defs.workflow_trigger;
  }

  function canonicalTriggerKeys(): string[] {
    return Object.keys(canonicalTriggerSchema().properties);
  }

  /** 表の全マス(キー × 種別)を `"<key>/<type>"` の名前つきで平らに並べる。 */
  function cells(): [string, Emission][] {
    return Object.entries(TRIGGER_KEY_EMITS_STATEMENT).flatMap(([key, byType]) =>
      TRIGGER_TYPES.map((type): [string, Emission] => [`${key}/${type}`, byType[type]]),
    );
  }

  test("$defs/workflow_trigger の全キーについて『文を出すか出さないか』が明示されている", () => {
    // **順序ごと固定する。** 5つ目が増えたらここが赤くなり、判断を書くまで緑にならない。
    // `src/kernel/workflow-schema.test.ts:1120` は `.sort()` した集合しか見ておらず、
    // **要件ドキュメントに出すか否かは1文字も問うていない**(だから ADR-0064 のとき
    // あちらは期待値の更新だけで通り、判断は書かれなかった)。
    expect(canonicalTriggerKeys()).toEqual(Object.keys(TRIGGER_KEY_EMITS_STATEMENT));
  });

  // **【V3-M13-T12 による期待値の更新】** 旧: emits 6 / silent 2 / unwritable 4。
  // **`ADR-0068` A4 / A5 が silent の2マスを emits に変えた。** マスの総数は12のままである
  // (キーは1本も増えていない)。
  /*
   * **【`V5-M25-T01` / `ADR-0174` による追随。旧テスト名を隠さない】**
   * **旧(逐語)**: 「**12マスの内訳は emits 8 / silent 0 / unwritable 4 である(数で残す)**」。
   * **`ADR-0174` が種別を1つ足したのでマスは 12 → 16 になった。**
   * **キーは1本も増えていない**(4本のまま)。
   */
  test("16マスの内訳は emits 10 / silent 0 / unwritable 6 である(数で残す)", () => {
    const all = cells();
    expect(all).toHaveLength(16);
    expect(all.filter(([, e]) => e === "emits").map(([name]) => name)).toEqual([
      "type/on_create",
      "type/on_update",
      "type/schedule",
      "type/manual",
      "table/on_create",
      "table/on_update",
      "table/schedule",
      "table/manual",
      "at/schedule",
      "older_than/schedule",
    ]);
    // **「書けるのに1文も出ない」マスは0件になった。** V3-M10 が作った2マスは
    // V3-M13-T12 が塞いだ。
    expect(all.filter(([, e]) => e === "silent")).toHaveLength(0);
    expect(all.filter(([, e]) => e === "unwritable").map(([name]) => name)).toEqual([
      "at/on_create",
      "at/on_update",
      "at/manual",
      "older_than/on_create",
      "older_than/on_update",
      "older_than/manual",
    ]);
  });

  /*
   * **【`V5-M25-T01` / `ADR-0174` による追随。旧テスト名を隠さない】**
   * **旧(逐語)**: 「**`unwritable` の4マスは schema の allOf が実際に `false` にしている
   * (散文で決めない)**」。**`manual` の2マスが増えて6マスになった。**
   *
   * **【`ADR-0174` が露わにした穴を書く】** **この describe は「キー × 種別」の表だが、
   * 種別の側に見張りが1本も無かった** —— **`type.enum` が 3 → 4 になったとき、
   * この表は緑のまま通り、列が現実より1つ少ないまま「12マス」を数え続けられた。**
   * **【禁止】これを「表が守っていた」と書かない** —— **守っていなかった。**
   * **下の1本(列の一致)を `V5-M25-T01` が足した。**
   */
  test("表の列(種別)が schema の enum と一致する(5値目が増えたら赤くなる)", () => {
    const type = canonicalTriggerSchema().properties.type as { enum: string[] };
    expect([...type.enum]).toEqual([...TRIGGER_TYPES]);
  });

  test("`unwritable` の6マスは schema の allOf が実際に `false` にしている(散文で決めない)", () => {
    const branches = canonicalTriggerSchema().allOf;
    for (const type of ["on_create", "on_update", "manual"] as const) {
      const branch = branches.find(
        (candidate) =>
          candidate.if.properties.type.const === type && candidate.if.not === undefined,
      );
      expect(branch).toBeDefined();
      for (const key of ["at", "older_than"] as const) {
        expect(TRIGGER_KEY_EMITS_STATEMENT[key]?.[type]).toBe("unwritable");
        expect(branch?.then.properties?.[key]).toBe(false);
      }
    }
  });

  test("5キー目が増えると上の照合が赤くなる(schemas/ を1バイトも変えずに確かめる)", () => {
    // **確かめ方**: schema を書き換えずに「5キー目が在る世界のキー列」を作り、
    // 1本目の検査が使っている比較(`toEqual`)が**成立しない**ことを示す。
    const withFifthKey = [...canonicalTriggerKeys(), "for_each"];
    expect(withFifthKey).not.toEqual(Object.keys(TRIGGER_KEY_EMITS_STATEMENT));
    // 宣言順が変わっただけでも赤くなる(集合ではなく列として見ているため)。
    const reordered = [...canonicalTriggerKeys()].reverse();
    expect(reordered).not.toEqual(Object.keys(TRIGGER_KEY_EMITS_STATEMENT));
    // 5キー目には判断が1つも書かれていない = 表を書き足すまで緑にならない。
    expect(TRIGGER_KEY_EMITS_STATEMENT.for_each).toBeUndefined();
  });

  // --- ここから実測(表が現実と合っていることを、生成して突き合わせる)----------------

  const PROBE_APP_ID = "sweep-shop";
  const PROBE_APP_NAME = "打ち切りの実験";

  function normalizeTimestamps(markdown: string): string {
    return markdown.replace(/20\d\d-\d\d-\d\dT[0-9:.]+Z/g, "<TS>");
  }

  function byteLength(text: string): number {
    return new TextEncoder().encode(text).length;
  }

  /**
   * **トリガーの宣言だけを差し替えて**要件ドキュメントを1本作る。
   *
   * 専用の一時 dataRoot を使う(`V3-M9-T03b` の `generateForInput` と同じ作法)。
   * **トリガー以外は1文字も変えない** —— 差が出たらそれはトリガーの差である。
   */
  async function generateForTrigger(
    trigger: WorkflowTrigger,
  ): Promise<{ doc: RequirementsDoc; markdown: string }> {
    const root = await mkdtemp(join(tmpdir(), "gp-req-doc-trigger-"));
    const probeStore = KernelMetaStore.open(root);
    try {
      createApp(probeStore, PROBE_APP_NAME, { app_id: PROBE_APP_ID });
      const applyHere = (diff: Diff): void => {
        const result = applyDiff(root, PROBE_APP_ID, diff);
        if (!result.valid) {
          throw new Error(
            `テスト前提の差分適用に失敗しました(${diff.diff_id}): ${JSON.stringify(result.errors)}`,
          );
        }
      };
      applyHere({
        diff_id: "d-001-tables",
        intent: "注文と実行履歴の台帳を作る。",
        operations: [
          {
            op: "add_table",
            table: {
              id: "order",
              name: "注文",
              fields: [
                { id: "status", name: "状態", type: "text" },
                { id: "placed_at", name: "注文日時", type: "date" },
              ],
            },
          },
          {
            op: "add_table",
            table: {
              id: "wf_runs",
              name: "実行履歴",
              fields: [
                { id: "ran_at", name: "実行時刻", type: "date" },
                { id: "workflow", name: "自動化", type: "text" },
                { id: "trigger_type", name: "きっかけ", type: "text" },
                { id: "status", name: "結果", type: "text" },
                { id: "error", name: "エラー", type: "long_text" },
              ],
            },
          },
        ],
      });
      applyHere({
        diff_id: "d-002-workflow",
        intent: "滞留した注文を打ち切る。",
        operations: [
          {
            op: "add_workflow",
            workflow: {
              id: "cancel_stale",
              name: "滞留注文の打ち切り",
              trigger,
              actions: [
                { action: "create_record", table: "wf_runs", values: { workflow: "cancel_stale" } },
              ],
              history_table: "wf_runs",
            },
          },
        ],
      });
      const doc = generateRequirementsDoc(root, PROBE_APP_ID);
      return { doc, markdown: normalizeTimestamps(doc.markdown) };
    } finally {
      probeStore.close();
      await rm(root, { recursive: true, force: true });
    }
  }

  const SCHEDULE_PLAIN: WorkflowTrigger = { type: "schedule", at: { hour: 3, minute: 0 } };
  const SCHEDULE_TABLE: WorkflowTrigger = {
    type: "schedule",
    table: "order",
    at: { hour: 3, minute: 0 },
  };
  const SCHEDULE_OLDER: WorkflowTrigger = {
    type: "schedule",
    table: "order",
    at: { hour: 3, minute: 0 },
    older_than: { field: "placed_at", days: 3 },
  };
  const ON_CREATE: WorkflowTrigger = { type: "on_create", table: "order" };

  // **【V3-M13-T12 による期待値の更新】** 旧題は「`silent` の2マスの実測 —— table も
  // older_than も書いた生成物が、書かない生成物と1バイトも違わない」であり、
  // **意味がまったく違う3つのアプリの要件定義書が1バイトも違わない**ことを固定していた。
  // `ADR-0068` A4 / A5 がそれを変えた。**歯止め(表と実測の突き合わせ)は1バイトも
  // 緩めていない** —— 向きが逆になっただけである。
  test("`emits` の2マスの実測 —— table と older_than を書くと生成物が1文ずつ増える", async () => {
    const plain = await generateForTrigger(SCHEDULE_PLAIN);
    const withTable = await generateForTrigger(SCHEDULE_TABLE);
    const withOlderThan = await generateForTrigger(SCHEDULE_OLDER);

    // **1回だけ発火する / 表の全行を1件ずつ処理する / 3日以上経った行だけを処理する。**
    // 3つのアプリの要件定義書は、いまや別物である。
    expect(withTable.markdown).not.toBe(plain.markdown);
    expect(withOlderThan.markdown).not.toBe(withTable.markdown);
    expect(withTable.doc.statements).toHaveLength(plain.doc.statements.length + 1);
    expect(withOlderThan.doc.statements).toHaveLength(plain.doc.statements.length + 2);
    expect(byteLength(withOlderThan.markdown)).toBeGreaterThan(byteLength(plain.markdown));

    // 既存の `automation.trigger_schedule` の文は1バイトも変わっていない(A4 の禁止形)。
    const scheduleStatements = withOlderThan.doc.statements.filter(
      (s) => s.template === "automation.trigger_schedule",
    );
    expect(scheduleStatements).toHaveLength(1);
    expect(Object.keys(scheduleStatements[0]?.slots ?? {})).toEqual([
      "workflow_id",
      "hour",
      "minute",
      "trigger_type",
    ]);

    // 足した2文が `automation` 節に確かに在る。
    const automationTexts = withOlderThan.doc.statements
      .filter((s) => s.section === "automation")
      .map((s) => s.text);
    expect(automationTexts).toContain(
      "自動化 `cancel_stale` は、発火したときテーブル `order` の行を1件ずつ対象にする。",
    );
    expect(automationTexts).toContain(
      "自動化 `cancel_stale` が対象にするのは、フィールド `placed_at` の値が発火した日から `3` 日以上前の行だけである。",
    );
    // **経過時間を計算した結果(具体的な日付)は1文字も書かない**(共通7)。
    for (const text of automationTexts) {
      expect(text).not.toMatch(/20\d\d-\d\d-\d\d/);
    }
  });

  test("`table/on_create` = emits の実測 —— 同じ table キーが on_create では1文になる", async () => {
    const onCreate = await generateForTrigger(ON_CREATE);
    const schedule = await generateForTrigger(SCHEDULE_TABLE);

    const onCreateTrigger = onCreate.doc.statements.filter(
      (s) => s.template === "automation.trigger_on_create",
    );
    expect(onCreateTrigger).toHaveLength(1);
    // **`table_id` スロットが在る。** schedule 側(上の検査)には無い。
    expect(Object.keys(onCreateTrigger[0]?.slots ?? {})).toEqual([
      "workflow_id",
      "table_id",
      "trigger_type",
    ]);
    expect(onCreateTrigger[0]?.text).toContain("order");

    // **同じ `table: "order"` を書いているのに、schedule 側の文には `order` が出ない。**
    // これが「単一の boolean では書けない」ことの実測である。
    const scheduleTrigger = schedule.doc.statements.filter(
      (s) => s.template === "automation.trigger_schedule",
    );
    expect(scheduleTrigger).toHaveLength(1);
    expect(scheduleTrigger[0]?.text).not.toContain("order");
  });
});

/**
 * **`$defs/workflow_action` のキーのうち、要件ドキュメントに文を出すものの集合**
 * (V3-M12-T11。申し送り(7) = `v3-m11-t06.md` §8 の1 / §4-3 が「無い」と記録した4件の1つ)。
 *
 * `$defs/workflow_trigger` 側の `TRIGGER_KEY_EMITS_STATEMENT`(`:1747`)と**同じ役目**を負う。
 * `workflow_action` も `workflow_trigger` と同じく `allOf` + `if`/`then` で分岐しており
 * (action の種別5つで `required` / `false` が入れ替わる。`schemas/manifest.schema.json`
 * `$defs/workflow_action.allOf` の5分岐)、単一の boolean では書けない。**したがって
 * キー × action種別の表にし、値も `TRIGGER_KEY_EMITS_STATEMENT` と同じ3値(`Emission`)にした。**
 *
 * `V3-M11-T06` が挙げた「単一 boolean では書けない理由」(同じキーが種別によって出たり
 * 出なかったりする / 「出さない」と「書けない」は別物である)は、そのままここにも当たる
 * ——`table` は create_record / update_record では文を出し、他の3種では schema が
 * そもそも書かせない(`false`)。
 */
describe("V3-M12-T11: workflow_action のキーのうち要件ドキュメントに文を出すものの集合", () => {
  const ACTION_TYPES = [
    "create_record",
    "update_record",
    "call_external",
    "ai_transform",
    "run_function",
  ] as const;
  type ActionType = (typeof ACTION_TYPES)[number];

  /** `workflow_trigger` 側の `Emission`(`:1745`)と同じ3値。 */
  type Emission = "emits" | "silent" | "unwritable";

  /**
   * キー → action種別 → 現れ方。**16キー × 5種別 = 80マス。**
   *
   * 出所は `src/kernel/requirements-doc.ts:1478`〜`:1646`(`workflowStatements` の
   * action 処理)の実読みである。行番号はドリフトしうるので、判定は「何が読まれているか」の
   * 内容一致で行った(§0-4b の規律に揃える)。
   */
  const WORKFLOW_ACTION_KEY_EMITS_STATEMENT: Record<string, Record<ActionType, Emission>> = {
    // `automation.action` の `action_type` スロット(`:1487`)。5種すべてで必ず出る。
    action: {
      create_record: "emits",
      update_record: "emits",
      call_external: "emits",
      ai_transform: "emits",
      run_function: "emits",
    },
    // `automation.action_target_table` の `table_id`(`:1501`)。create_record / update_record
    // だけが書け、書けば必ず出る。他の3種は allOf が `false` にしている。
    table: {
      create_record: "emits",
      update_record: "emits",
      call_external: "unwritable",
      ai_transform: "unwritable",
      run_function: "unwritable",
    },
    // `automation.action_value`(`mapEntryStatements`、`:1507`〜`:1517`)。
    values: {
      create_record: "emits",
      update_record: "emits",
      call_external: "unwritable",
      ai_transform: "unwritable",
      run_function: "unwritable",
    },
    // **update_record だけが書け、schema は `required` にしている。**
    // **【V3-M13-T12 による期待値の更新。当時の実測は残す】** **当時**: `requirements-doc.ts`
    // は `action.target` を1度も読まず、**必須なのに文が無かった**
    // (`workflow_trigger` の `table/schedule` と同型の欠落)。
    // **今日**: `ADR-0068` A1 により `automation.action_target` の1文が出る
    // (**値は解釈せず逐語引用で写す**)。
    target: {
      create_record: "unwritable",
      update_record: "emits",
      call_external: "unwritable",
      ai_transform: "unwritable",
      run_function: "unwritable",
    },
    connection: {
      create_record: "unwritable",
      update_record: "unwritable",
      call_external: "emits", // automation.action_connection(`:1521`〜`:1533`)
      ai_transform: "unwritable",
      run_function: "unwritable",
    },
    destination: {
      create_record: "unwritable",
      update_record: "unwritable",
      call_external: "emits", // automation.action_destination(同上)
      ai_transform: "unwritable",
      run_function: "unwritable",
    },
    payload: {
      create_record: "unwritable",
      update_record: "unwritable",
      call_external: "emits", // automation.action_payload(mapEntryStatements、`:1544`〜`:1552`)
      ai_transform: "unwritable",
      run_function: "unwritable",
    },
    capability: {
      create_record: "unwritable",
      update_record: "unwritable",
      call_external: "unwritable",
      ai_transform: "emits", // automation.action_ai_capability(`:1556`〜`:1567`)
      run_function: "unwritable",
    },
    prompt: {
      create_record: "unwritable",
      update_record: "unwritable",
      call_external: "unwritable",
      ai_transform: "emits", // automation.action_ai_prompt(同上)
      run_function: "unwritable",
    },
    input: {
      create_record: "unwritable",
      update_record: "unwritable",
      call_external: "unwritable",
      ai_transform: "emits", // automation.action_ai_input(mapEntryStatements、`:1579`〜`:1587`)
      run_function: "unwritable",
    },
    output_field: {
      create_record: "unwritable",
      update_record: "unwritable",
      call_external: "unwritable",
      ai_transform: "emits", // automation.action_ai_output_field(`:1588`〜`:1598`)
      run_function: "unwritable",
    },
    fallback: {
      create_record: "unwritable",
      update_record: "unwritable",
      call_external: "unwritable",
      ai_transform: "emits", // automation.action_ai_fallback(`:1599`〜`:1609`)
      run_function: "unwritable",
    },
    function: {
      create_record: "unwritable",
      update_record: "unwritable",
      call_external: "unwritable",
      ai_transform: "unwritable",
      run_function: "emits", // automation.action_run_function[_write_back](`:1616`〜`:1643`)
    },
    output_table: {
      create_record: "unwritable",
      update_record: "unwritable",
      call_external: "unwritable",
      ai_transform: "unwritable",
      run_function: "emits", // automation.action_run_function(`:1629`〜`:1643`)
    },
    write_back: {
      create_record: "unwritable",
      update_record: "unwritable",
      call_external: "unwritable",
      ai_transform: "unwritable",
      run_function: "emits", // automation.action_run_function_write_back(`:1612`〜`:1628`)
    },
    /*
     * **V3-M13-T09 が足した17キー目**(`D-G15` / ADR-0067 限定 A10。門A 本審査4回目 = 限定採用)。
     *
     * **T09 の判断(当時): 5種すべて `silent` である。** `run_function` でだけ書けるが
     * (他4種の then 分岐は `write_ops: false` で書けなくしてある)、
     * **`requirements-doc.ts` は `write_ops` という語を1文字も持たなかった。**
     *
     * **【当時、正直に書かれた穴】** `write_ops` モードの `run_function` は、
     * `automation.action_run_function`(`output_table` 分岐)にも
     * `automation.action_run_function_write_back`(`write_back` 分岐)にも入らないので、
     * **そのアクションについて「どの関数を呼ぶか」も「どこへ書くか」も1文も出なかった。**
     * **これを解くのは要件ドキュメントの語彙(ADR-0025)の側の判断であり、
     * `ADR-0067` の限定表21点は要件ドキュメントを1点も名指ししていない** ——
     * **したがって T09 はここを解かず、穴として記録した**(`v3-m13-t09.md` §8)。
     *
     * **【V3-M13-T12 による期待値の更新】** `ADR-0068` A7(`V3-M11-G1` = 限定採用)が
     * その穴を名指しで塞いだ。`automation.action_run_function_write_ops` の1文が出る。
     * **島が実際に何を書くかは今日も1文字も書かない**(A7 の禁止形)。
     */
    write_ops: {
      create_record: "unwritable",
      update_record: "unwritable",
      call_external: "unwritable",
      ai_transform: "unwritable",
      run_function: "emits",
    },
    // **5種すべてで書ける**(schema はどの分岐でも `false` にしていない)。
    // **【V3-M13-T12 による期待値の更新。当時の実測は残す】** **当時**: `requirements-doc.ts`
    // は `when` という語を1文字も持たなかった(EC-G5条件分岐。ADR-0036)。
    // **今日**: `ADR-0068` A2 により `automation.action_when` の1文が5種すべてで出る。
    when: {
      create_record: "emits",
      update_record: "emits",
      call_external: "emits",
      ai_transform: "emits",
      run_function: "emits",
    },
  };

  function canonicalActionSchema(): {
    properties: Record<string, unknown>;
    allOf: {
      if: { properties: { action: { const: string } } };
      then: { required?: string[]; properties?: Record<string, unknown> };
    }[];
  } {
    const schema = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "..", "schemas", "manifest.schema.json"), "utf-8"),
    ) as {
      $defs: {
        workflow_action: {
          properties: Record<string, unknown>;
          allOf: {
            if: { properties: { action: { const: string } } };
            then: { required?: string[]; properties?: Record<string, unknown> };
          }[];
        };
      };
    };
    return schema.$defs.workflow_action;
  }

  function canonicalActionKeys(): string[] {
    return Object.keys(canonicalActionSchema().properties);
  }

  /** 表の全マス(キー × action種別)を `"<key>/<type>"` の名前つきで平らに並べる。 */
  function cells(): [string, Emission][] {
    return Object.entries(WORKFLOW_ACTION_KEY_EMITS_STATEMENT).flatMap(([key, byType]) =>
      ACTION_TYPES.map((type): [string, Emission] => [`${key}/${type}`, byType[type]]),
    );
  }

  test("$defs/workflow_action の全キーについて『文を出すか出さないか』が明示されている", () => {
    // **順序ごと固定する。** 17キー目が増えたらここが赤くなり、判断を書くまで緑にならない。
    expect(canonicalActionKeys()).toEqual(Object.keys(WORKFLOW_ACTION_KEY_EMITS_STATEMENT));
  });

  // **【V3-M13-T09 による期待値の更新】17キー目(`write_ops`。ADR-0067)が入り 80 → 85 マスに
  // なった。** そのとき `silent` は 6 → 7 で、`emits` は 20 のままだった。
  // **【V3-M13-T12 による期待値の更新】** `ADR-0068` A1 / A2 / A7 が `silent` の7マス
  // (`target/update_record` / `write_ops/run_function` / `when/×5`)を **すべて `emits` に
  // 変えた。** **マスの総数は85のままで、キーは1本も増えていない** —— 変わったのは
  // 「書けるのに1文も出ない」マスが7から0になったことだけである。
  test("85マスの内訳は emits 27 / silent 0 / unwritable 58 である(数で残す)", () => {
    const all = cells();
    expect(all).toHaveLength(85);
    expect(all.filter(([, e]) => e === "emits").map(([name]) => name)).toEqual([
      "action/create_record",
      "action/update_record",
      "action/call_external",
      "action/ai_transform",
      "action/run_function",
      "table/create_record",
      "table/update_record",
      "values/create_record",
      "values/update_record",
      // ADR-0068 A1。**必須なのに0文だったマス。**
      "target/update_record",
      "connection/call_external",
      "destination/call_external",
      "payload/call_external",
      "capability/ai_transform",
      "prompt/ai_transform",
      "input/ai_transform",
      "output_field/ai_transform",
      "fallback/ai_transform",
      "function/run_function",
      "output_table/run_function",
      "write_back/run_function",
      // ADR-0068 A7。**第3の書込モード(ADR-0067)。**
      "write_ops/run_function",
      // ADR-0068 A2。**5種すべてで書けるのに0文だった5マス(EC-G5 / ADR-0036)。**
      "when/create_record",
      "when/update_record",
      "when/call_external",
      "when/ai_transform",
      "when/run_function",
    ]);
    // **「書けるのに1文も出ない」マスは0件になった。**
    expect(all.filter(([, e]) => e === "silent")).toHaveLength(0);
    expect(all.filter(([, e]) => e === "unwritable")).toHaveLength(58);
  });

  test("`unwritable` の58マスは schema の allOf が実際に `false` にしている(散文で決めない)", () => {
    const branches = canonicalActionSchema().allOf;
    for (const type of ACTION_TYPES) {
      const branch = branches.find((candidate) => candidate.if.properties.action.const === type);
      expect(branch).toBeDefined();
      for (const key of Object.keys(WORKFLOW_ACTION_KEY_EMITS_STATEMENT)) {
        const emission = WORKFLOW_ACTION_KEY_EMITS_STATEMENT[key]?.[type];
        if (emission === "unwritable") {
          expect(branch?.then.properties?.[key]).toBe(false);
        } else {
          // **`emits` / `silent` の側は `false` になっていない(= 書ける)ことも裏を取る。**
          expect(branch?.then.properties?.[key]).not.toBe(false);
        }
      }
    }
  });

  test("18キー目が増えると上の照合が赤くなる(schemas/ を1バイトも変えずに確かめる)", () => {
    const withEighteenthKey = [...canonicalActionKeys(), "for_each"];
    expect(withEighteenthKey).not.toEqual(Object.keys(WORKFLOW_ACTION_KEY_EMITS_STATEMENT));
    const reordered = [...canonicalActionKeys()].reverse();
    expect(reordered).not.toEqual(Object.keys(WORKFLOW_ACTION_KEY_EMITS_STATEMENT));
    expect(WORKFLOW_ACTION_KEY_EMITS_STATEMENT.for_each).toBeUndefined();
  });

  // --- ここから実測(silent の2種を、生成して突き合わせる)--------------------------

  const PROBE_APP_ID = "action-probe-shop";
  const PROBE_APP_NAME = "アクションの実験";

  function normalizeTimestamps(markdown: string): string {
    return markdown.replace(/20\d\d-\d\d-\d\dT[0-9:.]+Z/g, "<TS>");
  }

  /** `order` テーブル1本とトリガー on_create を持つ最小アプリの上で、actions だけを差し替える。 */
  async function generateForActions(
    actions: WorkflowAction[],
  ): Promise<{ doc: RequirementsDoc; markdown: string }> {
    const root = await mkdtemp(join(tmpdir(), "gp-req-doc-action-"));
    const probeStore = KernelMetaStore.open(root);
    try {
      createApp(probeStore, PROBE_APP_NAME, { app_id: PROBE_APP_ID });
      const applyHere = (diff: Diff): void => {
        const result = applyDiff(root, PROBE_APP_ID, diff);
        if (!result.valid) {
          throw new Error(
            `テスト前提の差分適用に失敗しました(${diff.diff_id}): ${JSON.stringify(result.errors)}`,
          );
        }
      };
      applyHere({
        diff_id: "d-001-tables",
        intent: "注文と実行履歴の台帳を作る。",
        operations: [
          {
            op: "add_table",
            table: {
              id: "order",
              name: "注文",
              fields: [{ id: "status", name: "状態", type: "text" }],
            },
          },
          {
            op: "add_table",
            table: {
              id: "wf_runs",
              name: "実行履歴",
              fields: [
                { id: "ran_at", name: "実行時刻", type: "date" },
                { id: "workflow", name: "自動化", type: "text" },
                { id: "trigger_type", name: "きっかけ", type: "text" },
                { id: "status", name: "結果", type: "text" },
                { id: "error", name: "エラー", type: "long_text" },
              ],
            },
          },
        ],
      });
      applyHere({
        diff_id: "d-002-workflow",
        intent: "注文が来たら実行する。",
        operations: [
          {
            op: "add_workflow",
            workflow: {
              id: "on-order",
              name: "注文をきっかけに動く",
              trigger: { type: "on_create", table: "order" },
              actions,
              history_table: "wf_runs",
            },
          },
        ],
      });
      const doc = generateRequirementsDoc(root, PROBE_APP_ID);
      return { doc, markdown: normalizeTimestamps(doc.markdown) };
    } finally {
      probeStore.close();
      await rm(root, { recursive: true, force: true });
    }
  }

  function automationSection(doc: RequirementsDoc): RequirementStatement[] {
    return doc.statements.filter((s) => s.section === "automation");
  }

  // **【V3-M13-T12 による期待値の更新】** 旧題は「`target/update_record` = silent の実測 ——
  // target を書き換えても automation 節が1バイトも変わらない」。`ADR-0068` A1 が変えた。
  test("`target/update_record` = emits の実測 —— target を書き換えると automation 節が変わる", async () => {
    const withSelfTarget = await generateForActions([
      { action: "update_record", table: "order", target: "$record._id", values: { status: "x" } },
    ]);
    const withLiteralTarget = await generateForActions([
      {
        action: "update_record",
        table: "order",
        target: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        values: { status: "x" },
      },
    ]);

    // **意味がまったく違う2つの target(自己更新 / 特定行のリテラル UUID)は、
    // いまや別の文書になる。**
    const selfTexts = automationSection(withSelfTarget.doc).map((s) => s.text);
    const literalTexts = automationSection(withLiteralTarget.doc).map((s) => s.text);
    expect(literalTexts).not.toEqual(selfTexts);

    // 既存の `automation.action_target_table` の文は1バイトも変わっていない。
    const targetTableStatement = automationSection(withSelfTarget.doc).find(
      (s) => s.template === "automation.action_target_table",
    );
    expect(targetTableStatement).toBeDefined();
    expect(Object.keys(targetTableStatement?.slots ?? {})).toEqual([
      "workflow_id",
      "position",
      "table_id",
    ]);

    // **値は解釈せず逐語引用で写す**(A1)。解決した結果(参照先の行の中身)は書かない。
    expect(selfTexts).toContain(
      "自動化 `on-order` の `1` 番目の動作が更新する対象は、次のとおり記録されている:\n> $record._id",
    );
    expect(literalTexts).toContain(
      "自動化 `on-order` の `1` 番目の動作が更新する対象は、次のとおり記録されている:\n> aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    );
  });

  // **【V3-M13-T12 による期待値の更新】** 旧題は「`when` = silent の実測」。
  test("`when` = emits の実測(create_record と ai_transform の2種で計測)", async () => {
    const createWithout = await generateForActions([
      { action: "create_record", table: "order", values: { status: "x" } },
    ]);
    const createWith = await generateForActions([
      {
        action: "create_record",
        table: "order",
        values: { status: "x" },
        when: { field: "status", equals: "pending" },
      },
    ]);
    expect(automationSection(createWith.doc).map((s) => s.text)).not.toEqual(
      automationSection(createWithout.doc).map((s) => s.text),
    );
    expect(automationSection(createWith.doc).map((s) => s.text)).toContain(
      "自動化 `on-order` の `1` 番目の動作は、フィールド `status` の値が次と等しいときだけ動く:\n> pending",
    );

    const aiWithout = await generateForActions([
      {
        action: "ai_transform",
        capability: "summarize",
        prompt: "状態を要約する",
        input: { status: "$record.status" },
        output_field: "status",
        fallback: "unknown",
      },
    ]);
    const aiWith = await generateForActions([
      {
        action: "ai_transform",
        capability: "summarize",
        prompt: "状態を要約する",
        input: { status: "$record.status" },
        output_field: "status",
        fallback: "unknown",
        when: { field: "status", equals: "pending" },
      },
    ]);
    expect(automationSection(aiWith.doc).map((s) => s.text)).not.toEqual(
      automationSection(aiWithout.doc).map((s) => s.text),
    );
    expect(automationSection(aiWith.doc).map((s) => s.text)).toContain(
      "自動化 `on-order` の `1` 番目の動作は、フィールド `status` の値が次と等しいときだけ動く:\n> pending",
    );
    // **条件の評価結果(何件が該当するか)は1文字も書かない**(ADR-0068 A2 の禁止形)。
    for (const text of automationSection(aiWith.doc).map((s) => s.text)) {
      expect(text).not.toContain("件が該当");
    }

    // **正直に書く**: `when` の emits を実際に生成して確かめたのは create_record /
    // ai_transform の2種だけである。update_record / call_external / run_function は
    // 個別には生成していない —— 根拠は実装が**アクション種別より前で**`when` を処理して
    // いること(`action.when !== undefined` の分岐が種別分岐の外に1本だけ在る)であり、
    // 5種を貫く単一の分岐非依存の事実から演繹している。**当時と同じ形の演繹である。**
  });
});

/**
 * **`$defs/function_input` のキーのうち、要件ドキュメントに文を出すものの集合**
 * (V3-M12-T11。`v3-m11-t06.md` §4-3 が「無い」と記録した2つ目)。
 *
 * `function_input` も `workflow_trigger` / `workflow_action` と同じく `allOf` + `if`/`then`
 * (`source` の3値で分岐)を持つので、同じ3値(`Emission`)の表にした。
 *
 * **ただし4件のうち唯一、`silent` が0マスである** —— `source` / `table` / `view` の3キーは
 * いずれも、書ける場面では必ず文を出す(`src/kernel/requirements-doc.ts:1679`〜`:1719`)。
 * これは`V3-M11-T06` の「4件とも `silent` を持つ」という前提(§8 申し送り(7))を検分した
 * 結果としての**新しい実測**であり、そのまま先行記録を書き換えるものではない
 * (先行記録は「表が無い」とだけ言っており「silent が在る」とは言っていない)。
 */
describe("V3-M12-T11: function_input のキーのうち要件ドキュメントに文を出すものの集合", () => {
  const SOURCE_TYPES = ["table", "view", "record"] as const;
  type SourceType = (typeof SOURCE_TYPES)[number];
  type Emission = "emits" | "silent" | "unwritable";

  const FUNCTION_INPUT_KEY_EMITS_STATEMENT: Record<string, Record<SourceType, Emission>> = {
    // `function_input_source` タームスロット。`automation.function_input_table` /
    // `_view` / `_record` の3テンプレートすべてに載る(`:1681`)。
    source: { table: "emits", view: "emits", record: "emits" },
    // `automation.function_input_table` の `table_id`(`:1683`〜`:1695`)。source=table だけ書ける。
    table: { table: "emits", view: "unwritable", record: "unwritable" },
    // `automation.function_input_view` の `view_id`(`:1696`〜`:1709`)。source=view だけ書ける。
    view: { table: "unwritable", view: "emits", record: "unwritable" },
    /*
     * **【V4-M10-T44 / E-G72 / ADR-0083 が足した4キー目】**
     *
     * **判断: `source: "table"` では `silent`(書けるが要件ドキュメントに文を出さない)、
     * `view` / `record` では `unwritable`(schema の `allOf` が `false` にしている)。**
     *
     * **`silent` にした理由を隠さない**: **`src/kernel/requirements-doc.ts` に
     * `via` の文を出す実装を1行も足していない。** **`ADR-0083` の限定表12点は
     * 要件ドキュメントについて1行も要求しておらず、限定表の外を実装しないためである。**
     * **帰結**: **`via` を書いた宣言の要件ドキュメントは、`source: "table"` の文
     * (「テーブルの全行を渡す」)をそのまま出す** —— **絞られていることが文面に現れない。**
     * **これは正直に記録すべき欠落であり、緑であることは「足りている」ことを意味しない。**
     */
    via: { table: "silent", view: "unwritable", record: "unwritable" },
  };

  function canonicalFunctionInputSchema(): {
    properties: Record<string, unknown>;
    allOf: {
      if: { properties: { source: { const: string } } };
      then: { required?: string[]; properties?: Record<string, unknown> };
    }[];
  } {
    const schema = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "..", "schemas", "manifest.schema.json"), "utf-8"),
    ) as {
      $defs: {
        function_input: {
          properties: Record<string, unknown>;
          allOf: {
            if: { properties: { source: { const: string } } };
            then: { required?: string[]; properties?: Record<string, unknown> };
          }[];
        };
      };
    };
    return schema.$defs.function_input;
  }

  function canonicalFunctionInputKeys(): string[] {
    return Object.keys(canonicalFunctionInputSchema().properties);
  }

  function cells(): [string, Emission][] {
    return Object.entries(FUNCTION_INPUT_KEY_EMITS_STATEMENT).flatMap(([key, bySource]) =>
      SOURCE_TYPES.map((source): [string, Emission] => [`${key}/${source}`, bySource[source]]),
    );
  }

  test("$defs/function_input の全キーについて『文を出すか出さないか』が明示されている", () => {
    // **順序ごと固定する。** 4キー目が増えたらここが赤くなり、判断を書くまで緑にならない。
    expect(canonicalFunctionInputKeys()).toEqual(Object.keys(FUNCTION_INPUT_KEY_EMITS_STATEMENT));
  });

  test("12マスの内訳は emits 5 / silent 1 / unwritable 6 である(数で残す)", () => {
    // **【V4-M10-T44 / ADR-0083 による更新】** **9 → 12 マスになった**(4キー目 `via`)。
    // **`silent` が 0 → 1 になった** —— **要件ドキュメントに `via` の文が1つも無い**
    // ことを、数として残す(§上のコメント)。
    const all = cells();
    expect(all).toHaveLength(12);
    expect(all.filter(([, e]) => e === "emits").map(([name]) => name)).toEqual([
      "source/table",
      "source/view",
      "source/record",
      "table/table",
      "view/view",
    ]);
    expect(all.filter(([, e]) => e === "silent").map(([name]) => name)).toEqual(["via/table"]);
    expect(all.filter(([, e]) => e === "unwritable")).toHaveLength(6);
  });

  test("`unwritable` の4マスは schema の allOf が実際に `false` にしている(散文で決めない)", () => {
    const branches = canonicalFunctionInputSchema().allOf;
    for (const source of SOURCE_TYPES) {
      const branch = branches.find((candidate) => candidate.if.properties.source.const === source);
      expect(branch).toBeDefined();
      for (const key of Object.keys(FUNCTION_INPUT_KEY_EMITS_STATEMENT)) {
        const emission = FUNCTION_INPUT_KEY_EMITS_STATEMENT[key]?.[source];
        if (emission === "unwritable") {
          expect(branch?.then.properties?.[key]).toBe(false);
        } else {
          expect(branch?.then.properties?.[key]).not.toBe(false);
        }
      }
    }
  });

  test("5キー目が増えると上の照合が赤くなる(schemas/ を1バイトも変えずに確かめる)", () => {
    const withFourthKey = [...canonicalFunctionInputKeys(), "for_each"];
    expect(withFourthKey).not.toEqual(Object.keys(FUNCTION_INPUT_KEY_EMITS_STATEMENT));
    const reordered = [...canonicalFunctionInputKeys()].reverse();
    expect(reordered).not.toEqual(Object.keys(FUNCTION_INPUT_KEY_EMITS_STATEMENT));
    expect(FUNCTION_INPUT_KEY_EMITS_STATEMENT.for_each).toBeUndefined();
  });

  test("`emits` の5マスは既存の実測に当て先がある(再走させず、当て先を引用する)", () => {
    // **本テストは新しく生成しない** —— `source` / `table` / `view` の3テンプレートは
    // 本ファイルの「14: 関数が automation 節に出る(入力 source 3種)」(`describe` は
    // `V1-M8-T02` 側。`toContain("automation.function_input_table" / "_view" / "_record")`)
    // が既に実測済みである。二重に生成し直さず、当て先だけを実測で確認する。
    const templateIds = Object.keys(REQUIREMENT_TEMPLATES);
    expect(templateIds).toContain("automation.function_input_table");
    expect(templateIds).toContain("automation.function_input_view");
    expect(templateIds).toContain("automation.function_input_record");
  });
});

/**
 * **`$defs/app` のキーのうち、要件ドキュメントに文を出すものの集合**
 * (V3-M12-T11。`v3-m11-t06.md` §4-3 が「無い」と記録した3つ目)。
 *
 * `app` には `allOf` が無い(`schemas/manifest.schema.json` の `$defs/app` を実測で確認済み
 * —— `Object.hasOwn` で下のテストが裏を取る)。**トリガー種別・action種別・source種別のような
 * 分岐が無いので、`view` 側の `VIEW_KEY_EMITS_STATEMENT`(`:1286`)と同じ2値(boolean)の
 * 表で足りる。** `workflow_action` / `function_input` の3値(`Emission`)とは形が違う
 * ——理由は分岐の有無であって、対症療法ではない。
 */
describe("V3-M12-T11: app のキーのうち要件ドキュメントに文を出すものの集合", () => {
  /**
   * キー → 文を出すか。**id / name / tables / views / workflows / functions の6キーは
   * `overviewStatements` / `featureStatements`(`src/kernel/requirements-doc.ts:1061`〜
   * `:1160` 台)が読む。** `theme` だけは、`app.theme` という語がこのファイルに1度も
   * 現れない(実測は下のテスト)。
   */
  const APP_KEY_EMITS_STATEMENT: Record<string, boolean> = {
    id: true, // overview.identity の app_id(:1068)
    name: true, // overview.identity の app_name(:1069)
    tables: true, // overview.scale の table_count(:1101)+ features.table(:1115〜)
    views: true, // overview.scale の view_count(:1102)+ features.view(:1129〜)
    workflows: true, // overview.scale の workflow_count(:1103)+ features.workflow(:1143〜)
    functions: true, // overview.scale の function_count(:1104)+ features.function(:1157〜)
    theme: false, // **`app.theme` を読む行が1つも無い。実測は下の生成テスト。**
    // **【`V5-M17-T02` / `ADR-0158` 限定8 が足した8キー目 `user_kinds`】**
    // **文を出さない。** **`app.user_kinds` を読む行は `src/kernel/requirements-doc.ts` に
    // 1つも無い**(実測は下の生成テスト)。**`ADR-0158` は要件ドキュメントの出力を
    // 1バイトも変えないと決めていない** —— **決めていないものを黙って足さない**という
    // 側に倒した。**したがって「このアプリの利用者の種類」は要件ドキュメントに出ない。**
    // **これは限界であって、そう決めた記録が `docs/plan/v5/records/v5-m17.md` にある。**
    // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`。判定値 = 廃止】**
    // **旧(逐語)**: `user_kinds: false,` —— **`app.user_kinds` の器ごと撤去されたので、
    // 「文を出すか出さないか」を書く相手が今日1つも無い。**この表は `$defs/app` の全キーと
    // 順序ごと一致することを下の検査が測るので、器が消えた側も外す(9 → 8)。
    // **「このアプリの利用者の種類は要件ドキュメントに出ない」という当時の限界は、
    // 出ない理由が「読む行が無い」から「器が無い」に変わっただけで、今日も真である。**
    // **【`V8-M16-T02` / `J-G1b` / `D-V8-31` が足した9本目 `roles`】**
    // **文を出さない。** **`app.roles` を読む行は `src/kernel/requirements-doc.ts` に
    // 1つも無い。****`V8-M16` は要件ドキュメントの出力を1バイトも変えないと決めていない**
    // —— **決めていないものを黙って足さない**という側に倒した(`user_kinds` と同じ扱い)。
    // **したがって「このアプリの役割」は要件ドキュメントに出ない。**
    // **これは限界であって、判定の実装が入る `V8-M17` 以降で改めて判断する。**
    roles: false,
  };

  function canonicalAppSchema(): { properties: Record<string, unknown>; allOf?: unknown } {
    const schema = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "..", "schemas", "manifest.schema.json"), "utf-8"),
    ) as { $defs: { app: { properties: Record<string, unknown>; allOf?: unknown } } };
    return schema.$defs.app;
  }

  function canonicalAppKeys(): string[] {
    return Object.keys(canonicalAppSchema().properties);
  }

  test("$defs/app の全キーについて『文を出すか出さないか』が明示されている", () => {
    // **順序ごと固定する。** 8キー目が増えたらここが赤くなり、判断を書くまで緑にならない。
    expect(canonicalAppKeys()).toEqual(Object.keys(APP_KEY_EMITS_STATEMENT));
  });

  test("$defs/app は allOf(分岐)を持たない —— だから2値の表で足りる", () => {
    expect(Object.hasOwn(canonicalAppSchema(), "allOf")).toBe(false);
  });

  test("現在『出す』のは6キー・『出さない』のは1キー(theme)である(内訳を数で残す)", () => {
    const emits = Object.entries(APP_KEY_EMITS_STATEMENT).filter(([, on]) => on);
    expect(emits.map(([key]) => key)).toEqual([
      "id",
      "name",
      "tables",
      "views",
      "workflows",
      "functions",
    ]);
    // **【`V5-M17-T02` の追随】7 → 8**(`ADR-0158` 限定8 が `user_kinds` を足した)。
    // **テスト名の「6キー・1キー」は当時の逐語であり、今日は「6キー・2キー」である。
    // 名を書き換えていない**(`v5-merge-repair-2.md` §5-2 が数えた「本体だけ追随して
    // テスト名に古い数が残る」形と同じものが、ここでも1件増えた)。
    // **【`V8-M16-T02` の追随】8 → 9**(`J-G1b` / `D-V8-31` が `roles` を足した)。
    // **今日は「6キー・3キー」である。期待値だけを実体に合わせ、検査は消していない。**
    // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`。判定値 = 廃止】9 → 8**(`user_kinds` の器を撤去した)。
    // **旧(逐語)**: `expect(Object.keys(APP_KEY_EMITS_STATEMENT)).toHaveLength(9);`
    // **今日は「6キー・2キー」である**(出さないのは `theme` と `roles` の2つ)。
    expect(Object.keys(APP_KEY_EMITS_STATEMENT)).toHaveLength(8);
  });

  test("8キー目が増えると上の照合が赤くなる(schemas/ を1バイトも変えずに確かめる)", () => {
    // **【`V5-M17-T02`】8キー目は実際に増えた**(`user_kinds`)。**この検査が測るのは
    // 「9キー目」であって、テスト名の「8キー目」は当時の逐語である。名を書き換えていない。**
    const withEighthKey = [...canonicalAppKeys(), "extra_key"];
    expect(withEighthKey).not.toEqual(Object.keys(APP_KEY_EMITS_STATEMENT));
    const reordered = [...canonicalAppKeys()].reverse();
    expect(reordered).not.toEqual(Object.keys(APP_KEY_EMITS_STATEMENT));
    expect(APP_KEY_EMITS_STATEMENT.extra_key).toBeUndefined();
  });

  // --- ここから実測(theme が silent であることを、生成して突き合わせる)------------

  const PROBE_APP_ID = "app-theme-probe-shop";
  const PROBE_APP_NAME = "テーマ有無の実験";

  function normalizeTimestamps(markdown: string): string {
    return markdown.replace(/20\d\d-\d\d-\d\dT[0-9:.]+Z/g, "<TS>");
  }

  /** 全25スロットを持つ最小のテーマ(値は `theme-history.test.ts` の `passingTheme` に揃えた)。 */
  function sampleTheme(): Theme {
    return {
      slots: {
        "--color-danger": "#a00000",
        "--color-text": "#000000",
        "--color-text-label": "#595959",
        "--color-text-placeholder": "#595959",
        "--color-text-secondary": "#595959",
        "--color-border": "#767676",
        "--color-page-background": "#ffffff",
        "--color-surface-highlight": "#f2f2f2",
        "--font-family-base": "system-ui, sans-serif",
        "--font-size-note": "0.875rem",
        "--font-size-secondary": "0.85em",
        "--line-height-base": "1.6",
        "--space-1": "0.25rem",
        "--space-2": "0.5rem",
        "--space-3": "0.75rem",
        "--space-4": "1rem",
        "--space-5": "1.25rem",
        "--space-6": "2rem",
        "--border-width": "1px",
        "--control-border-radius": "4px",
        "--surface-shadow": "none",
        "--focus-outline-color": "#005fcc",
        "--focus-outline-width": "2px",
        "--detail-label-width": "8rem",
        "--login-max-width": "22rem",
      },
    };
  }

  async function generateWithOrWithoutTheme(
    withTheme: boolean,
  ): Promise<{ doc: RequirementsDoc; markdown: string }> {
    const root = await mkdtemp(join(tmpdir(), "gp-req-doc-app-theme-"));
    const probeStore = KernelMetaStore.open(root);
    try {
      createApp(probeStore, PROBE_APP_NAME, { app_id: PROBE_APP_ID });
      const applyHere = (diff: Diff): void => {
        const result = applyDiff(root, PROBE_APP_ID, diff);
        if (!result.valid) {
          throw new Error(
            `テスト前提の差分適用に失敗しました(${diff.diff_id}): ${JSON.stringify(result.errors)}`,
          );
        }
      };
      applyHere({
        diff_id: "d-001-table",
        intent: "台帳を1本だけ用意する。",
        operations: [
          {
            op: "add_table",
            table: {
              id: "note",
              name: "メモ",
              fields: [{ id: "body", name: "本文", type: "text" }],
            },
          },
        ],
      });
      if (withTheme) {
        applyHere({
          diff_id: "d-002-theme",
          intent: "見た目を指定する。",
          operations: [{ op: "set_theme", theme: sampleTheme() }],
        });
      }
      const doc = generateRequirementsDoc(root, PROBE_APP_ID);
      return { doc, markdown: normalizeTimestamps(doc.markdown) };
    } finally {
      probeStore.close();
      await rm(root, { recursive: true, force: true });
    }
  }

  test("`theme` = silent の実測 —— テーマの有無で overview / features 節が1バイトも変わらない", async () => {
    const without = await generateWithOrWithoutTheme(false);
    const withT = await generateWithOrWithoutTheme(true);

    const overviewAndFeatures = (doc: RequirementsDoc): string[] =>
      doc.statements
        .filter((s) => s.section === "overview" || s.section === "features")
        .map((s) => normalizeTimestamps(s.text));

    // **テーマを足しても overview / features 節は1バイトも変わらない。**
    expect(overviewAndFeatures(withT.doc)).toEqual(overviewAndFeatures(without.doc));

    // **history 節だけが変わる**(「差分Xの1番目の操作は set_theme である」という、
    // 対象を名指ししない汎用の1文が増える。中身の25スロットは述べない)。
    const historyTexts = withT.doc.statements
      .filter((s) => s.section === "history")
      .map((s) => s.text);
    expect(historyTexts.some((t) => t.includes("set_theme"))).toBe(true);
    for (const text of historyTexts) {
      // **色・フォント等の値は history 節にも1文字も現れない。**
      expect(text).not.toContain("#a00000");
      expect(text).not.toContain("system-ui");
    }

    // **markdown 全体でも同じ**(色の値そのものがどこにも出ない)。
    expect(withT.markdown).not.toContain("#a00000");
    expect(withT.markdown).not.toContain("system-ui, sans-serif");
  });
});

/**
 * **`$defs/theme`(25スロット)のキーのうち、要件ドキュメントに文を出すものの集合**
 * (V3-M12-T11。`v3-m11-t06.md` §4-3 が「無い」と記録した4つ目、最後の1つ)。
 *
 * **これは `$defs/app` の `theme` キー(1個)とは別物である** —— `app` の `theme` は
 * 「テーマという入れ物があるか」の1マスだけだったが、こちらは**入れ物の中身(25個の
 * CSS カスタムプロパティ)** そのものである。
 *
 * **形が他の3件と違う。** `workflow_action` / `function_input` は action種別 / source種別に
 * よって同じキーの現れ方が割れたが(3値の `Emission`)、`app` は分岐こそ無いが `emits` /
 * `silent` の両方を持っていた(2値)。**`theme` の25キーは全部 `required` で(下のテストで
 * 実測)、しかも25キー全部が `silent` である** —— `emits` も `unwritable` も0マスであり、
 * `Record<string, boolean>` の表を書いても**全マスが同じ値になる**。表としての情報量は
 * 「25キー全部が読まれていない」という1個の事実に潰れる。これが「歯止めの形が他の3件と
 * 違う」の中身である —— 分岐が無いのは `app` と同じだが、`app` は6/7が `emits` なのに対し
 * `theme` は0/25が `emits` である。
 */
describe("V3-M12-T11: $defs/theme(25スロット)のキーのうち要件ドキュメントに文を出すものの集合", () => {
  function canonicalThemeSchema(): { properties: Record<string, unknown>; required: string[] } {
    const schema = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "..", "schemas", "manifest.schema.json"), "utf-8"),
    ) as { $defs: { theme: { properties: Record<string, unknown>; required: string[] } } };
    return schema.$defs.theme;
  }

  function canonicalThemeKeys(): string[] {
    return Object.keys(canonicalThemeSchema().properties);
  }

  /**
   * 25キー全部 → false。**この表は情報量として単一の boolean(「theme は文を出さない」)に潰れる。**
   *
   * **意図して `canonicalThemeKeys()` から自動生成していない** —— 自動生成すると、
   * スロットが増えたときに表側も一緒に増えてしまい、「26キー目が増えたら赤くなる」という
   * 歯止めそのものが自己参照になって働かなくなる(実際に一度その形で書き、schema へ
   * `--extra-test-slot` を1本足して実測したところ、キー一致検査だけは**赤くならなかった**
   * ——`toHaveLength(25)` の側だけが赤くなった。**歯止めとして機能していなかったので、
   * 他の3件と同じ「ベタ書きの列挙」に直した。**下のテストはこの回り道の実測を記録している。
   */
  const THEME_SLOT_EMITS_STATEMENT: Record<string, boolean> = {
    "--color-danger": false,
    "--color-text": false,
    "--color-text-label": false,
    "--color-text-placeholder": false,
    "--color-text-secondary": false,
    "--color-border": false,
    "--color-page-background": false,
    "--color-surface-highlight": false,
    "--font-family-base": false,
    "--font-size-note": false,
    "--font-size-secondary": false,
    "--line-height-base": false,
    "--space-1": false,
    "--space-2": false,
    "--space-3": false,
    "--space-4": false,
    "--space-5": false,
    "--space-6": false,
    "--border-width": false,
    "--control-border-radius": false,
    "--surface-shadow": false,
    "--focus-outline-color": false,
    "--focus-outline-width": false,
    "--detail-label-width": false,
    "--login-max-width": false,
  };

  test("$defs/theme の25キー全部が required である(完了条件5。歯止めの形が違う理由の実測)", () => {
    const schema = canonicalThemeSchema();
    expect(schema.required).toHaveLength(25);
    // **required の集合と properties の集合が完全に一致する** —— 任意のキーが1つも無い。
    expect([...schema.required].sort()).toEqual([...canonicalThemeKeys()].sort());
  });

  test("$defs/theme の全キーについて『文を出すか出さないか』が明示されている(26キー目のガード)", () => {
    expect(canonicalThemeKeys()).toEqual(Object.keys(THEME_SLOT_EMITS_STATEMENT));
    // **25キー全部が `false`(silent)である。** `emits` は0マス。
    expect(Object.values(THEME_SLOT_EMITS_STATEMENT).every((v) => v === false)).toBe(true);
    expect(Object.keys(THEME_SLOT_EMITS_STATEMENT)).toHaveLength(25);
  });

  test("26キー目が増えると上の照合が赤くなる(schemas/ を1バイトも変えずに確かめる)", () => {
    const withTwentySixthKey = [...canonicalThemeKeys(), "--extra-slot"];
    expect(withTwentySixthKey).not.toEqual(Object.keys(THEME_SLOT_EMITS_STATEMENT));
    const reordered = [...canonicalThemeKeys()].reverse();
    expect(reordered).not.toEqual(Object.keys(THEME_SLOT_EMITS_STATEMENT));
  });

  test("スロットの値を変えても要件ドキュメントは1バイトも変わらない(2つの異なるテーマを生成して比較)", async () => {
    const root = await mkdtemp(join(tmpdir(), "gp-req-doc-theme-slots-"));
    const probeStore = KernelMetaStore.open(root);
    const PROBE_APP_ID = "theme-slot-probe-shop";
    try {
      createApp(probeStore, "スロット差し替えの実験", { app_id: PROBE_APP_ID });
      const applyHere = (diff: Diff): void => {
        const result = applyDiff(root, PROBE_APP_ID, diff);
        if (!result.valid) {
          throw new Error(
            `テスト前提の差分適用に失敗しました(${diff.diff_id}): ${JSON.stringify(result.errors)}`,
          );
        }
      };
      applyHere({
        diff_id: "d-001-table",
        intent: "台帳を1本だけ用意する。",
        operations: [
          {
            op: "add_table",
            table: {
              id: "note",
              name: "メモ",
              fields: [{ id: "body", name: "本文", type: "text" }],
            },
          },
        ],
      });

      const baseSlots: Record<string, string> = {
        "--color-danger": "#a00000",
        "--color-text": "#000000",
        "--color-text-label": "#595959",
        "--color-text-placeholder": "#595959",
        "--color-text-secondary": "#595959",
        "--color-border": "#767676",
        "--color-page-background": "#ffffff",
        "--color-surface-highlight": "#f2f2f2",
        "--font-family-base": "system-ui, sans-serif",
        "--font-size-note": "0.875rem",
        "--font-size-secondary": "0.85em",
        "--line-height-base": "1.6",
        "--space-1": "0.25rem",
        "--space-2": "0.5rem",
        "--space-3": "0.75rem",
        "--space-4": "1rem",
        "--space-5": "1.25rem",
        "--space-6": "2rem",
        "--border-width": "1px",
        "--control-border-radius": "4px",
        "--surface-shadow": "none",
        "--focus-outline-color": "#005fcc",
        "--focus-outline-width": "2px",
        "--detail-label-width": "8rem",
        "--login-max-width": "22rem",
      };
      // **25キー全部がここで埋まっていることを、`schemas/` 側の実測(canonicalThemeKeys)と突き合わせる。**
      expect(Object.keys(baseSlots).sort()).toEqual(canonicalThemeKeys().sort());

      applyHere({
        diff_id: "d-002-theme-a",
        intent: "見た目Aを指定する。",
        operations: [{ op: "set_theme", theme: { slots: baseSlots } }],
      });
      const docA = generateRequirementsDoc(root, PROBE_APP_ID);

      const changedSlots = { ...baseSlots, "--color-danger": "#123456", "--space-1": "9rem" };
      applyHere({
        diff_id: "d-003-theme-b",
        intent: "見た目Bへ差し替える。",
        operations: [{ op: "set_theme", theme: { slots: changedSlots } }],
      });
      const docB = generateRequirementsDoc(root, PROBE_APP_ID);

      // **history 節(「Nつ目の操作は set_theme である」という2件の汎用文)を除けば、
      // 残りは1バイトも違わない。**
      const withoutHistory = (doc: RequirementsDoc): string[] =>
        doc.statements.filter((s) => s.section !== "history").map((s) => s.text);
      expect(withoutHistory(docB)).toEqual(withoutHistory(docA));

      // **変えた値そのもの(`#123456` / `9rem`)がどこにも現れない。**
      for (const statement of docB.statements) {
        expect(statement.text).not.toContain("#123456");
      }
    } finally {
      probeStore.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

/**
 * **V3-M13-T12(`ADR-0068` の A群 / B群 の実装)の検査。**
 *
 * `ADR-0068` は `V3-M11-G1`(スカラ形7宣言)と `V3-M11-G2`(`view.filter` のブール式)を
 * **2単位とも限定採用**にした(結論が出た問はどちらも問4)。本 describe が固定するのは
 * **「対象の宣言を含むアプリについて、生成された要件ドキュメントにその宣言が現れること」**
 * であり、`T12` 完了条件2 の逐語である。
 *
 * **【この describe が主張しないこと】** **「要件ドキュメントに載ったから安全である」とは
 * 1文字も書いていない**(`ADR-0068` C5 / `ADR-0025` 限界1)。**固定したのは「載る」ことだけで、
 * テンプレート本文の主張が正しいかは1文字も検査していない。**
 *
 * 作法は先行する4つの `*_EMITS_STATEMENT` の describe と同じで、**実ディスク・実DB・
 * 実 changelog を使い、モックを1つも置かない。** 一時 dataRoot は `mkdtemp` で作る。
 */
describe("V3-M13-T12: ADR-0068 A群 —— スカラ形7宣言が要件ドキュメントに現れる", () => {
  const PROBE_APP_ID = "declaration-probe-shop";
  const PROBE_APP_NAME = "宣言の実験";

  function normalizeTimestamps(markdown: string): string {
    return markdown.replace(/20\d\d-\d\d-\d\dT[0-9:.]+Z/g, "<TS>");
  }

  /**
   * 土台(テーブル4本)を固定し、variant の差分だけを足して1本生成する。
   *
   * **`T07` 審査記録 §4 の対照実験と同じ土台**である(`customer` / `order` / `wf_runs` /
   * `totals`)。**variant 側の `intent` は全部同じ文字列にしてある** —— intent は history 節に
   * 逐語引用として出るので、違えるとバイト差が宣言由来か intent 由来か分からなくなる。
   */
  async function generateFor(
    operations: Diff["operations"],
  ): Promise<{ doc: RequirementsDoc; markdown: string }> {
    const root = await mkdtemp(join(tmpdir(), "gp-req-doc-declaration-"));
    const probeStore = KernelMetaStore.open(root);
    try {
      createApp(probeStore, PROBE_APP_NAME, { app_id: PROBE_APP_ID });
      const applyHere = (diff: Diff): void => {
        const result = applyDiff(root, PROBE_APP_ID, diff);
        if (!result.valid) {
          throw new Error(
            `テスト前提の差分適用に失敗しました(${diff.diff_id}): ${JSON.stringify(result.errors)}`,
          );
        }
      };
      applyHere({
        diff_id: "d-001-base",
        intent: "顧客・注文・実行履歴・集計の台帳を作る。",
        operations: [
          {
            op: "add_table",
            table: {
              id: "customer",
              name: "顧客",
              fields: [{ id: "cname", name: "氏名", type: "text" }],
            },
          },
          {
            op: "add_table",
            table: {
              id: "order",
              name: "注文",
              fields: [
                { id: "status", name: "状態", type: "text" },
                { id: "qty", name: "数量", type: "number" },
                { id: "placed_at", name: "注文日時", type: "date" },
                { id: "buyer", name: "購入者", type: "reference", reference_table: "customer" },
              ],
            },
          },
          {
            op: "add_table",
            table: {
              id: "wf_runs",
              name: "実行履歴",
              fields: [
                { id: "ran_at", name: "実行時刻", type: "date" },
                { id: "workflow", name: "自動化", type: "text" },
                { id: "trigger_type", name: "きっかけ", type: "text" },
                { id: "status", name: "結果", type: "text" },
                { id: "error", name: "エラー", type: "long_text" },
              ],
            },
          },
          {
            op: "add_table",
            table: {
              id: "totals",
              name: "集計",
              fields: [{ id: "month", name: "月", type: "text" }],
            },
          },
        ],
      });
      applyHere({ diff_id: "d-002", intent: "宣言を1つ足す。", operations });
      const doc = generateRequirementsDoc(root, PROBE_APP_ID);
      return { doc, markdown: normalizeTimestamps(doc.markdown) };
    } finally {
      probeStore.close();
      await rm(root, { recursive: true, force: true });
    }
  }

  function texts(doc: RequirementsDoc, section: RequirementStatement["section"]): string[] {
    return doc.statements.filter((s) => s.section === section).map((s) => s.text);
  }

  function workflowWith(actions: WorkflowAction[], trigger?: WorkflowTrigger): Diff["operations"] {
    return [
      {
        op: "add_workflow",
        workflow: {
          id: "wf1",
          name: "自動化",
          trigger: trigger ?? { type: "on_create", table: "order" },
          actions,
          history_table: "wf_runs",
        },
      },
    ];
  }

  test("A1: `action.target` が1文になる —— 値は解釈せず逐語引用で写す", async () => {
    const literal = await generateFor(
      workflowWith([
        {
          action: "update_record",
          table: "order",
          target: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          values: { status: "done" },
        },
      ]),
    );
    const selfRef = await generateFor(
      workflowWith([
        {
          action: "update_record",
          table: "order",
          target: "$record._id",
          values: { status: "done" },
        },
      ]),
    );

    // **これが本タスクの中核である** —— 2つの target は意味がまったく違うのに、
    // 実装前は automation 節が1バイトも違わなかった(`ADR-0068` Context 1 の1行目)。
    expect(texts(selfRef.doc, "automation")).not.toEqual(texts(literal.doc, "automation"));

    const statement = literal.doc.statements.find((s) => s.template === "automation.action_target");
    expect(statement).toBeDefined();
    // **値を解決した結果(「顧客テーブルの誰それ」)を書いていない。逐語引用である**(A1)。
    expect(statement?.slots.target?.kind).toBe("verbatim");
    expect(statement?.text).toContain("> aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    const selfStatement = selfRef.doc.statements.find(
      (s) => s.template === "automation.action_target",
    );
    expect(selfStatement?.text).toContain("> $record._id");
  });

  test("A2: `action.when` が1文になる —— field は id スロット・equals は逐語引用", async () => {
    const without = await generateFor(
      workflowWith([{ action: "create_record", table: "wf_runs", values: { workflow: "wf1" } }]),
    );
    const withWhen = await generateFor(
      workflowWith([
        {
          action: "create_record",
          table: "wf_runs",
          values: { workflow: "wf1" },
          when: { field: "status", equals: "pending" },
        },
      ]),
    );

    expect(texts(withWhen.doc, "automation")).not.toEqual(texts(without.doc, "automation"));
    const statement = withWhen.doc.statements.find((s) => s.template === "automation.action_when");
    expect(statement).toBeDefined();
    expect(statement?.slots.field_id).toEqual({ kind: "id", group: "field_id", value: "status" });
    expect(statement?.slots.value?.kind).toBe("verbatim");
    expect(statement?.text).toContain("> pending");
    // **条件の評価結果を1文字も書いていない**(A2)—— 「何件が該当するか」は出ない。
    for (const text of texts(withWhen.doc, "automation")) {
      expect(text).not.toContain("件が該当");
    }
  });

  test("A3: `function.input` の配列形が要素ごとに1文になる(単体形の生成物は1バイトも変わらない)", async () => {
    const single = await generateFor([
      {
        op: "add_function",
        function: {
          id: "f1",
          name: "関数",
          code: "export default (rows) => rows;",
          input: { source: "table", table: "order" },
          output: { fields: [{ id: "month", type: "text" }] },
          capabilities: [],
        },
      },
    ]);
    const array2 = await generateFor([
      {
        op: "add_function",
        function: {
          id: "f1",
          name: "関数",
          code: "export default (rows) => rows;",
          input: [{ source: "record" }, { source: "table", table: "order" }],
          output: { fields: [{ id: "month", type: "text" }] },
          capabilities: [],
        },
      },
    ]);

    // **単体形は1バイトも変わらない**(A3 の禁止形。後方互換)。
    expect(
      single.doc.statements.filter((s) => s.template === "automation.function_input_table"),
    ).toHaveLength(1);
    expect(texts(single.doc, "automation")).toContain(
      "関数 `f1` はテーブル `order` の全行を入力に取る(入力元は `table`)。",
    );

    // **配列形は要素ごとに1文である**(2要素 → 2文)。実装前は0文だった。
    const arrayInputs = array2.doc.statements.filter((s) =>
      s.template.startsWith("automation.function_input_"),
    );
    expect(arrayInputs.map((s) => s.template)).toEqual([
      "automation.function_input_record_at",
      "automation.function_input_table_at",
    ]);
    // **位置を持つ**(A3 の逐語「既存の table / view / record の3本に位置を持たせる」)。
    expect(arrayInputs[0]?.slots.position).toEqual({ kind: "number", value: 1 });
    expect(arrayInputs[1]?.slots.position).toEqual({ kind: "number", value: 2 });
  });

  test("A4: `trigger.table`(schedule)が1文になる", async () => {
    const plain = await generateFor(
      workflowWith([{ action: "create_record", table: "wf_runs", values: { workflow: "wf1" } }], {
        type: "schedule",
        at: { hour: 3, minute: 0 },
      }),
    );
    const withTable = await generateFor(
      workflowWith([{ action: "create_record", table: "wf_runs", values: { workflow: "wf1" } }], {
        type: "schedule",
        table: "order",
        at: { hour: 3, minute: 0 },
      }),
    );

    expect(texts(withTable.doc, "automation")).not.toEqual(texts(plain.doc, "automation"));
    const statement = withTable.doc.statements.find(
      (s) => s.template === "automation.trigger_schedule_table",
    );
    expect(statement).toBeDefined();
    expect(statement?.slots.table_id).toEqual({ kind: "id", group: "table_id", value: "order" });
    // **`on_create` / `on_update` の既存の文は1バイトも変わらない**(A4 の禁止形)。
    const onCreate = await generateFor(
      workflowWith([{ action: "create_record", table: "wf_runs", values: { workflow: "wf1" } }], {
        type: "on_create",
        table: "order",
      }),
    );
    expect(texts(onCreate.doc, "automation")).toContain(
      "自動化 `wf1` は、テーブル `order` にレコードが作られたとき(発火条件 `on_create`)に動く。",
    );
    expect(
      onCreate.doc.statements.filter((s) => s.template === "automation.trigger_schedule_table"),
    ).toHaveLength(0);
  });

  test("A5: `trigger.older_than` が1文になる —— 経過時間を計算した結果は書かない", async () => {
    const withTable = await generateFor(
      workflowWith([{ action: "create_record", table: "wf_runs", values: { workflow: "wf1" } }], {
        type: "schedule",
        table: "order",
        at: { hour: 3, minute: 0 },
      }),
    );
    const withOlder = await generateFor(
      workflowWith([{ action: "create_record", table: "wf_runs", values: { workflow: "wf1" } }], {
        type: "schedule",
        table: "order",
        at: { hour: 3, minute: 0 },
        older_than: { field: "placed_at", days: 3 },
      }),
    );

    expect(texts(withOlder.doc, "automation")).not.toEqual(texts(withTable.doc, "automation"));
    const statement = withOlder.doc.statements.find(
      (s) => s.template === "automation.trigger_schedule_older_than",
    );
    expect(statement).toBeDefined();
    expect(statement?.slots.field_id).toEqual({
      kind: "id",
      group: "field_id",
      value: "placed_at",
    });
    expect(statement?.slots.days).toEqual({ kind: "number", value: 3 });
    // **「3日前は何月何日」を1文字も書いていない**(A5 / 共通7)—— 日付が出れば非決定的になる。
    for (const text of texts(withOlder.doc, "automation")) {
      expect(text).not.toMatch(/20\d\d-\d\d-\d\d/);
    }
  });

  test("A6: `view.related` は1件 + 列ごとに1文、`view.actions` は1件につき1文になる", async () => {
    const related = await generateFor([
      {
        op: "add_view",
        view: {
          id: "customer_detail",
          name: "顧客詳細",
          type: "detail_view",
          table: "customer",
          fields: ["cname"],
          related: [{ table: "order", via: "buyer", columns: ["status", "qty"] }],
        },
      },
    ]);
    const relatedStatements = related.doc.statements.filter((s) =>
      s.template.startsWith("screens.related"),
    );
    expect(relatedStatements.map((s) => s.template)).toEqual([
      "screens.related",
      "screens.related_column",
      "screens.related_column",
    ]);
    expect(relatedStatements[0]?.slots.field_id).toEqual({
      kind: "id",
      group: "field_id",
      value: "buyer",
    });
    // **生成器は DB を1行も読まない**(A6 の禁止形)—— 子レコードの中身に触れない。
    for (const text of texts(related.doc, "screens")) {
      expect(text).not.toContain("件の行が");
    }

    const actions = await generateFor([
      {
        op: "add_view",
        view: {
          id: "order_form",
          name: "注文の作成",
          type: "form",
          table: "order",
          fields: ["status", "buyer"],
        },
      },
      {
        op: "add_view",
        view: {
          id: "customer_detail",
          name: "顧客詳細",
          type: "detail_view",
          table: "customer",
          fields: ["cname"],
          actions: [{ form: "order_form", prefill: { field: "buyer" }, name: "注文を作る" }],
        },
      },
    ]);
    const actionStatements = actions.doc.statements.filter((s) => s.template === "screens.action");
    expect(actionStatements).toHaveLength(1);
    expect(actionStatements[0]?.slots.form_view_id).toEqual({
      kind: "id",
      group: "view_id",
      value: "order_form",
    });
    expect(actionStatements[0]?.slots.field_id).toEqual({
      kind: "id",
      group: "field_id",
      value: "buyer",
    });
  });

  test("A7: `action.write_ops` と `function.output.ops` がそれぞれ1文になる —— 島が何を書くかは書かない", async () => {
    const writeOps = await generateFor([
      {
        op: "add_function",
        function: {
          id: "f1",
          name: "島を呼ぶ",
          code: "export default (rows) => rows;",
          input: { source: "record" },
          output: { ops: true },
          capabilities: [],
        },
      },
      {
        op: "add_workflow",
        workflow: {
          id: "wf1",
          name: "島を呼ぶ",
          trigger: { type: "on_create", table: "order" },
          actions: [{ action: "run_function", function: "f1", write_ops: true }],
          history_table: "wf_runs",
        },
      },
    ]);

    const opsAction = writeOps.doc.statements.find(
      (s) => s.template === "automation.action_run_function_write_ops",
    );
    expect(opsAction).toBeDefined();
    // **どの関数を呼ぶかは書く**(実装前は1文も出なかった)。
    expect(opsAction?.slots.function_id).toEqual({
      kind: "id",
      group: "function_id",
      value: "f1",
    });
    const opsOutput = writeOps.doc.statements.find(
      (s) => s.template === "automation.function_output_ops",
    );
    expect(opsOutput).toBeDefined();

    // **島が実際に何を書くかを1文字も書いていない**(A7 の禁止形。`ADR-0067` 限定 A11)——
    // op は実行時に島が生成するのでマニフェストに存在しない。
    for (const text of texts(writeOps.doc, "automation")) {
      expect(text).not.toContain("在庫");
      expect(text).not.toContain("減ら");
    }
  });

  /*
   * **【2026-08-04。`V4-M39-T01` / `ADR-0144` A2 + `ADR-0145` A1 による更新。
   * テストは1本も消していない】**
   *
   * **着手前のこのテストの名前の逐語**:
   * 「**A群の10件は、すべて `ADR-0068` が名指しした宣言だけに当たる(テーマ25スロット /
   * プリセット7キー / custom_css には1本も足していない)**」
   * **着手前の期待値の逐語**:
   * ```
   * for (const [id, body] of Object.entries(REQUIREMENT_TEMPLATES)) {
   *   expect(`${id}:${body}`).not.toContain("preset_");
   *   expect(`${id}:${body}`).not.toContain("custom_css");
   *   expect(`${id}:${body}`).not.toContain("--color");
   * }
   * ```
   *
   * **`V4-M39` の門A 本審査が、3件のうち2件(プリセット9キー / `custom_css`)を覆した。**
   * **テーマ25スロットは覆されていない**(`ADR-0144` B1)。**したがって:**
   * - **テーマ(`--color`)は今日も**全数**で禁じ続ける**(1バイトも緩めない)。
   * - **プリセットと `custom_css` は、テンプレート**ID**には現れてよい**(`screens.preset_*` /
   *   `screens.custom_css*` の11本がそれである)が、**本文には今日も1文字も現れない** ——
   *   **地の文に出すのはマニフェストの**値**であって、キーの名前ではない**
   *   (`ADR-0025` §4-2 の描き方を1バイトも変えていない)。
   */
  test("テーマ25スロットには今日も1本も足していない(プリセット / custom_css は門A が覆した。ID にだけ現れ、本文には現れない)", () => {
    for (const [id, body] of Object.entries(REQUIREMENT_TEMPLATES)) {
      // **覆されていない1件。全数で禁じ続ける。**
      expect(`${id}:${body}`).not.toContain("--color");
      // **本文にはキーの名前が1文字も現れない**(**ID は対象外** —— `screens.preset_*` /
      // `screens.custom_css*` の11本の ID にはもちろん現れる)。
      expect(body).not.toContain("preset_");
      expect(body).not.toContain("custom_css");
      expect(id.length).toBeGreaterThan(0);
    }
    // **テーマを述べるテンプレートは今日も0本である**(`ADR-0144` B1)。
    expect(
      Object.keys(REQUIREMENT_TEMPLATES).filter((id) => id.startsWith("screens.theme")),
    ).toEqual([]);
  });
});

/**
 * **V3-M13-T12(`ADR-0068` の B群)。`list_view.filter` のブール式。**
 *
 * `ADR-0068` §2 の判定「**木は平坦なスカラで表せる**」を、コードで書いて確かめる
 * ——同 ADR §限界3 が「論証だけである。コードで書いて確かめていない」と自ら申告した点を、
 * 本 describe の復元テストが埋める。
 */
describe("V3-M13-T12: ADR-0068 B群 —— view.filter のブール式が要件ドキュメントに現れる", () => {
  const PROBE_APP_ID = "filter-probe-shop";
  const PROBE_APP_NAME = "絞り込みの実験";

  async function generateForFilter(
    filter: FilterCondition[] | FilterNode | undefined,
  ): Promise<{ doc: RequirementsDoc; markdown: string }> {
    const root = await mkdtemp(join(tmpdir(), "gp-req-doc-filter-"));
    const probeStore = KernelMetaStore.open(root);
    try {
      createApp(probeStore, PROBE_APP_NAME, { app_id: PROBE_APP_ID });
      const applyHere = (diff: Diff): void => {
        const result = applyDiff(root, PROBE_APP_ID, diff);
        if (!result.valid) {
          throw new Error(
            `テスト前提の差分適用に失敗しました(${diff.diff_id}): ${JSON.stringify(result.errors)}`,
          );
        }
      };
      applyHere({
        diff_id: "d-001-base",
        intent: "注文の台帳を作る。",
        operations: [
          {
            op: "add_table",
            table: {
              id: "order",
              name: "注文",
              fields: [
                { id: "status", name: "状態", type: "text" },
                { id: "qty", name: "数量", type: "number" },
                { id: "memo", name: "備考", type: "text" },
              ],
            },
          },
        ],
      });
      applyHere({
        diff_id: "d-002",
        intent: "宣言を1つ足す。",
        operations: [
          {
            op: "add_view",
            view: {
              id: "order_list",
              name: "注文一覧",
              type: "list_view",
              table: "order",
              columns: ["status", "qty"],
              ...(filter === undefined ? {} : { filter }),
            },
          },
        ],
      });
      const doc = generateRequirementsDoc(root, PROBE_APP_ID);
      return { doc, markdown: doc.markdown.replace(/20\d\d-\d\d-\d\dT[0-9:.]+Z/g, "<TS>") };
    } finally {
      probeStore.close();
      await rm(root, { recursive: true, force: true });
    }
  }

  /** B群のテンプレート。**9本ちょうどである**(B2)。 */
  const FILTER_TEMPLATES: readonly RequirementTemplateId[] = [
    "screens.filter_and",
    "screens.filter_or",
    "screens.filter_not",
    "screens.filter_equals",
    "screens.filter_contains",
    "screens.filter_gte",
    "screens.filter_lte",
    "screens.filter_in",
    "screens.filter_in_value",
  ];

  function filterStatements(doc: RequirementsDoc): RequirementStatement[] {
    return doc.statements.filter((s) => FILTER_TEMPLATES.includes(s.template));
  }

  test("B2: ブール式のテンプレートはちょうど9本である(10本目を足さない)", () => {
    const ids = Object.keys(REQUIREMENT_TEMPLATES);
    for (const id of FILTER_TEMPLATES) {
      expect(ids).toContain(id);
    }
    // 10本目(たとえば `xor`)は無い。
    expect(ids.filter((id) => id.startsWith("screens.filter_"))).toHaveLength(9);
  });

  test("B4: 等値AND配列の既存の1文は1バイトも変わらない(後方互換)", async () => {
    const equals = await generateForFilter([{ field: "status", equals: "pending" }]);
    const screens = equals.doc.statements.filter((s) => s.section === "screens");
    expect(screens.map((s) => s.text)).toContain(
      "画面 `order_list` は `1` 番目の絞り込み条件として、フィールド `status` の値が次と等しい行だけを表示する:\n> pending",
    );
    // **ブール式のテンプレートは1件も使われない。**
    expect(filterStatements(equals.doc)).toHaveLength(0);
  });

  test("B1: ブール式は前順走査でノードごとに1文になり、通し番号と深さを持つ", async () => {
    const none = await generateForFilter(undefined);
    const bool = await generateForFilter({
      and: [{ field: "status", equals: "pending" }, { not: { field: "memo", contains: "取消" } }],
    });

    // 実装前は `filter-none` と1バイトも違わなかった(`ADR-0068` Context 1 の最終行)。
    expect(bool.markdown).not.toBe(none.markdown);

    const nodes = filterStatements(bool.doc);
    // 前順: and(深さ1)→ equals(深さ2)→ not(深さ2)→ contains(深さ3)。
    expect(
      nodes.map((s) => [
        s.template,
        (s.slots.position as { value: number }).value,
        (s.slots.depth as { value: number }).value,
      ]),
    ).toEqual([
      ["screens.filter_and", 1, 1],
      ["screens.filter_equals", 2, 2],
      ["screens.filter_not", 3, 2],
      ["screens.filter_contains", 4, 3],
    ]);
    // スロットは既存4種のまま(共通5 / C2)。
    for (const node of nodes) {
      for (const slot of Object.values(node.slots)) {
        expect(["id", "verbatim", "term", "number"]).toContain(slot.kind);
      }
    }
  });

  test("B1: 前順の訪問列と深さの列から、元の木を復元できる(ADR-0068 §限界3 が確かめていなかった点)", async () => {
    const tree: FilterNode = {
      or: [
        {
          and: [
            { field: "status", equals: "open" },
            { field: "qty", gte: 3 },
          ],
        },
        { not: { field: "memo", contains: "済" } },
      ],
    };
    const doc = (await generateForFilter(tree)).doc;
    const nodes = filterStatements(doc).filter((s) => s.template !== "screens.filter_in_value");

    /** 前順列 + 深さ列から木を組み直す(親は「直前に現れた深さ-1 のノード」)。 */
    type Rebuilt = { template: RequirementTemplateId; children: Rebuilt[] };
    const stack: Rebuilt[] = [];
    let root: Rebuilt | undefined;
    for (const node of nodes) {
      const depth = (node.slots.depth as { value: number }).value;
      const rebuilt: Rebuilt = { template: node.template, children: [] };
      stack.length = depth - 1;
      const parent = stack[depth - 2];
      if (parent === undefined) {
        root = rebuilt;
      } else {
        parent.children.push(rebuilt);
      }
      stack[depth - 1] = rebuilt;
    }

    expect(root).toEqual({
      template: "screens.filter_or",
      children: [
        {
          template: "screens.filter_and",
          children: [
            { template: "screens.filter_equals", children: [] },
            { template: "screens.filter_gte", children: [] },
          ],
        },
        {
          template: "screens.filter_not",
          children: [{ template: "screens.filter_contains", children: [] }],
        },
      ],
    });
  });

  test("B群: `in` の値は1件につき1文になる(スロットはスカラのまま)", async () => {
    const doc = (await generateForFilter({ field: "status", in: ["open", "paid", "shipped"] })).doc;
    const nodes = filterStatements(doc);
    expect(nodes.map((s) => s.template)).toEqual([
      "screens.filter_in",
      "screens.filter_in_value",
      "screens.filter_in_value",
      "screens.filter_in_value",
    ]);
    expect(nodes[1]?.text).toContain("> open");
    expect(nodes[3]?.text).toContain("> shipped");
  });

  test("B3: 深度上限は `MAX_FILTER_DEPTH` を共有する(生成器に第2の上限を書かない)", async () => {
    expect(MAX_FILTER_DEPTH).toBe(8);
    // 上限ちょうど(深さ8)は通る。
    let deep: FilterNode = { field: "status", equals: "open" };
    for (let i = 0; i < MAX_FILTER_DEPTH - 1; i += 1) {
      deep = { not: deep };
    }
    const ok = await generateForFilter(deep);
    expect(filterStatements(ok.doc)).toHaveLength(MAX_FILTER_DEPTH);
    // 1段深いものは fail-closed する(黙って落とさない)。
    await expect(generateForFilter({ not: deep })).rejects.toThrow(/深/);
  });

  test("B6: 述語の評価を1つも行わない(生成器は DB のレコードを1行も読まない)", async () => {
    const doc = (await generateForFilter({ field: "qty", gte: 3 })).doc;
    for (const text of doc.statements.map((s) => s.text)) {
      expect(text).not.toContain("件が該当");
      expect(text).not.toContain("該当する行");
    }
  });
});

/**
 * **`$defs/function_output` のキーのうち、要件ドキュメントに文を出すものの集合**
 * (`ADR-0068` D5)。
 *
 * **`T07` の実測(審査記録 §4-4)では、この表だけが存在しなかった** —— `ops` が
 * `V3-M13-T09` で足されたとき、赤くなる検査は1本も無かった。**同じ穴を次に開けさせない。**
 *
 * **2値(boolean)にした理由**: `fields` と `ops` は schema の `allOf` で**排他**であり、
 * どちらのキーを書いたかが「形」そのものを決める。**同じキーが形によって出たり出なかったり
 * する状況が構造的に起こらない**ので、`workflow_action` / `function_input` の3値
 * (`Emission`)ではなく `app` / `view` と同じ2値で足りる。**排他であることは散文で決めず、
 * 下の検査が schema から裏を取る。**
 */
describe("V3-M13-T12: $defs/function_output のキーのうち要件ドキュメントに文を出すものの集合", () => {
  const FUNCTION_OUTPUT_KEY_EMITS_STATEMENT: Record<string, boolean> = {
    // `automation.function_output_field`(1フィールド = 1 statement)。
    fields: true,
    // **`ADR-0068` A7 で足した。** `automation.function_output_ops` の1文。
    // 実装前は「島が更新操作の配列を返す」ことが1文字も出ていなかった。
    ops: true,
  };

  function canonicalFunctionOutputSchema(): {
    properties: Record<string, unknown>;
    allOf: { if: { required?: string[] }; then: { properties?: Record<string, unknown> } }[];
  } {
    const schema = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "..", "schemas", "manifest.schema.json"), "utf-8"),
    ) as {
      $defs: {
        function_output: {
          properties: Record<string, unknown>;
          allOf: { if: { required?: string[] }; then: { properties?: Record<string, unknown> } }[];
        };
      };
    };
    return schema.$defs.function_output;
  }

  test("$defs/function_output の全キーについて『文を出すか出さないか』が明示されている", () => {
    // **順序ごと固定する。** 3キー目が増えたらここが赤くなり、判断を書くまで緑にならない。
    expect(Object.keys(canonicalFunctionOutputSchema().properties)).toEqual(
      Object.keys(FUNCTION_OUTPUT_KEY_EMITS_STATEMENT),
    );
  });

  test("2キーとも『出す』である(内訳を数で残す)", () => {
    const emits = Object.entries(FUNCTION_OUTPUT_KEY_EMITS_STATEMENT).filter(([, on]) => on);
    expect(emits.map(([key]) => key)).toEqual(["fields", "ops"]);
    expect(Object.keys(FUNCTION_OUTPUT_KEY_EMITS_STATEMENT)).toHaveLength(2);
  });

  test("2キーが排他であることを schema の allOf から裏取りする(散文で決めない)", () => {
    const branch = canonicalFunctionOutputSchema().allOf.find((candidate) =>
      candidate.if.required?.includes("ops"),
    );
    expect(branch).toBeDefined();
    expect(branch?.then.properties?.fields).toBe(false);
  });

  test("3キー目が増えると上の照合が赤くなる(schemas/ を1バイトも変えずに確かめる)", () => {
    const withThirdKey = [...Object.keys(canonicalFunctionOutputSchema().properties), "for_each"];
    expect(withThirdKey).not.toEqual(Object.keys(FUNCTION_OUTPUT_KEY_EMITS_STATEMENT));
    expect(FUNCTION_OUTPUT_KEY_EMITS_STATEMENT.for_each).toBeUndefined();
  });
});

/**
 * **`$defs/field` の12キー × 9型 の凍結表**(`ADR-0126` A9。`V4-M32-T02`。
 * **9型目 `file` は `V5-M16` / `ADR-0161` が足した**)。
 *
 * **`VIEW_KEY_EMITS_STATEMENT`(`:1360` 付近)と同じ役目を負う** —— **黙ってキーが増えるのを
 * 止める番人**である。**着手前、`$defs/field` 側にはこの番人が1本も立っていなかった**
 * (`ADR-0126` Consequences。実測 `grep -rln "FIELD_KEY_EMITS" src/ web/` = **0件**)——
 * 項目の宣言が1本増えても要件ドキュメントに出ないことに気づく検査は存在しなかった。
 *
 * **`ADR-0068` D5(`$defs/function_output` の表の新設)が先例である。** ただし
 * `function_output` は2値(boolean)で足りたのに対し、**`$defs/field` は型ごとに書ける
 * / 書けないが割れる**(`options` は select だけ、`unit` は number だけ)ので、
 * `VIEW_KEY_EMITS_STATEMENT` と同じ3値(`emits` / `silent` / `unwritable`)を採る。
 *
 * **`unwritable` は schema の `allOf` から機械的に裏を取る。** **view 側と形が違う** ——
 * view 側は `then.properties.<key> === false` だが、**field 側は `else.properties.<key> ===
 * false`** である(「select **でない**なら `options` を書けない」という書き方)。
 * **散文で決めない。**
 */
describe("V4-M32-T02: $defs/field のキー × 型 のうち要件ドキュメントに文を出すものの集合(ADR-0126 A9)", () => {
  /** `VIEW_KEY_EMITS_STATEMENT` と同じ3値。 */
  type Emission = "emits" | "silent" | "unwritable";

  /**
   * **キー × 型 → 現れ方。12キー × 9型 = 108マス。**
   * (**着手前は 12キー × 8型 = 96マスだった。** **`V5-M16` / `ADR-0161` が9型目 `file` を
   * 足したので 96 → 108 になった。** **キーは12のままである。**)
   *
   * キーの順序は `schemas/manifest.schema.json` の `$defs/field.properties` の順、
   * 型の順序は `FIELD_TYPES` である。**どちらも順序ごと固定する**(13キー目・9型目が
   * 増えたら赤くなる)。
   */
  const FIELD_KEY_EMITS_STATEMENT: Record<string, Record<string, Emission>> = {
    // `data.field` の3スロット(`field_id` / `field_name` / `field_type`)。全型で出る。
    id: {
      text: "emits",
      long_text: "emits",
      number: "emits",
      boolean: "emits",
      date: "emits",
      select: "emits",
      reference: "emits",
      image: "emits",
      file: "emits",
    },
    name: {
      text: "emits",
      long_text: "emits",
      number: "emits",
      boolean: "emits",
      date: "emits",
      select: "emits",
      reference: "emits",
      image: "emits",
      file: "emits",
    },
    type: {
      text: "emits",
      long_text: "emits",
      number: "emits",
      boolean: "emits",
      date: "emits",
      select: "emits",
      reference: "emits",
      image: "emits",
      file: "emits",
    },
    // `data.field_required` / `data.field_optional`。**書かなくても1文出る唯一のキーである**
    // —— 省略時は「任意である」と述べる。**`ADR-0126` A3(書かれていなければ1文も出ない)は
    // 本 ADR が足した14キーに課した不変条件であり、v1 からある `required` には遡及しない。**
    required: {
      text: "emits",
      long_text: "emits",
      number: "emits",
      boolean: "emits",
      date: "emits",
      select: "emits",
      reference: "emits",
      image: "emits",
      file: "emits",
    },
    // `data.field_option`(選択肢1件につき1文)。**select にだけ書ける。**
    options: {
      text: "unwritable",
      long_text: "unwritable",
      number: "unwritable",
      boolean: "unwritable",
      date: "unwritable",
      select: "emits",
      reference: "unwritable",
      image: "unwritable",
      file: "unwritable",
    },
    // `data.field_reference`。**reference にだけ書ける。**
    reference_table: {
      text: "unwritable",
      long_text: "unwritable",
      number: "unwritable",
      boolean: "unwritable",
      date: "unwritable",
      select: "unwritable",
      reference: "emits",
      image: "unwritable",
      file: "unwritable",
    },
    // **`ADR-0126` A2 の9番目。**`EC-G8` / `ADR-0038` + `ADR-0078`(owner スコープ)。
    // **3値それぞれ1文**(`data.field_unique` / `data.field_unique_owner` /
    // `data.field_not_unique`)。**8型すべてに書ける。**
    unique: {
      text: "emits",
      long_text: "emits",
      number: "emits",
      boolean: "emits",
      date: "emits",
      select: "emits",
      reference: "emits",
      image: "emits",
      file: "emits",
    },
    /*
     * **【`V8-M20` / 台帳 `J-G28` / `ADR-0301`】`audience` と `writable_by` の
     * 2行(どちらも9型とも `emits`)をこの表から落とした。**
     *
     * **旧記述の逐語**:
     *   `audience`: 「**`ADR-0126` A2 の10番目。**`B-G2` / `ADR-0071`。**値1件につき1文**
     *     (位置つき)。**着手前は `ADR-0071` 限定6(`src/kernel/` に1バイトも差分を
     *     出さない)の帰結で1文も出ていなかった。**」(値は9型とも `"emits"`)
     *   `writable_by`: 「**`ADR-0126` A2 の11番目。**`ADR-0076`。**`audience` と別の
     *     テンプレートにする** —— `ADR-0076` §1b が『読取の値域と書込の値域は一致しない。
     *     裏返しではない』と明記しており、同じ文で表すと2つが同じものに読める
     *     (`ADR-0126` §Decision 2 の 11)。」(値は9型とも `"emits"`)
     *
     * **理由は「出さないと決め直した」ではない** —— **この表の正準である
     * `schemas/manifest.schema.json` の `$defs/field.properties` から2キーが廃止された。**
     * **項目ごとの見せる相手 / 書ける相手は `app.roles[].rules`(対象 `field`・
     * 動詞 `read` / `write`)へ移った。****その `rules` を述べるテンプレートは今日1本も
     * 無く、要件ドキュメントは権限について1文も書かない。**
     */
    // **`ADR-0126` A2 の12番目。**`E-G14` / `ADR-0086`。**number にだけ書ける。**
    // 値は自由文字列なので `verbatim`(A7)。
    unit: {
      text: "unwritable",
      long_text: "unwritable",
      number: "emits",
      boolean: "unwritable",
      date: "unwritable",
      select: "unwritable",
      reference: "unwritable",
      image: "unwritable",
      file: "unwritable",
    },
    // **`ADR-0126` A2 の13番目。**`P-G28` / `ADR-0090`。**select にだけ書ける。**
    // **`ADR-0090:47` の逐語「要件ドキュメント(`ADR-0025`)に1文も現れない」は、今日は
    // 事実でなくなった**(`ADR-0126` Consequences 4 が申告している)。
    emphasis: {
      text: "unwritable",
      long_text: "unwritable",
      number: "unwritable",
      boolean: "unwritable",
      date: "unwritable",
      select: "emits",
      reference: "unwritable",
      image: "unwritable",
      file: "unwritable",
    },
    // **`ADR-0126` A2 の14番目。**`E-G17` / `ADR-0119`。**真偽それぞれ1文。8型すべてに書ける。**
    hide_when_empty: {
      text: "emits",
      long_text: "emits",
      number: "emits",
      boolean: "emits",
      date: "emits",
      select: "emits",
      reference: "emits",
      image: "emits",
      file: "emits",
    },
    // **`ADR-0126` A2 の15番目。**`K-G1` / `ADR-0288`(`V6-M1-T01`)。**`reference` にだけ
    // 書ける。**
    //
    // **【この製品で最初の `silent` である。丸めない】** **今日、この宣言は要件ドキュメントに
    // 1文も出ない。** **書けるのに1文も出ないので `emits` ではなく `silent` である。**
    //
    // **これは `ADR-0126` §3a の 2(A2 に15キー目を足すときは門A を改めて通す)を素通り
    // したものではない** —— **`V6-M0` の門A本審査が、要件ドキュメントに出す側を `K-G21b` と
    // いう別の審査単位(単位K)として立て、`門A(catch-all)` / `限定採用` と判定している**
    // (記録 `docs/plan/v6/records/v6-m0.md` §7-1 / §9 の台帳。**起草する ADR の主題 =
    // 「参照項目の選び方を要件ドキュメントに出す」、実装タスク = `V6-M6-T02`**)。
    // **`V6-M1` はその実装タスクではない。** **したがって今日の正しい値は `silent` であり、
    // `V6-M6` が `emits` に変える。**
    //
    // **【この行が緑のまま残り続けたら、それは V6-M6 が実施されなかったということである】**
    // 下の「`silent` は0である」を測っていた検査は、この1マスのために期待値が 0 → 1 に
    // なった。**0 に戻すのは `V6-M6-T02` の仕事である。**
    /*
     * **【`V6-M6-T02` / `K-G21b` / `ADR-0291` A1・A2 で `silent` → `emits` になった】**
     * **上の逐語「この製品で最初の `silent` である」「今日、この宣言は要件ドキュメントに
     * 1文も出ない」は今日から偽である。****旧文を1バイトも消していない。**
     * **`V6-M1` の予告(逐語「0 に戻すのは `V6-M6-T02` の仕事である」)を履行した。**
     * **出るのは3値それぞれ別の文である**(`data.field_reference_picker_list` /
     * `_type_filter` / `_search`)。
     */
    reference_picker: {
      text: "unwritable",
      long_text: "unwritable",
      number: "unwritable",
      boolean: "unwritable",
      date: "unwritable",
      select: "unwritable",
      reference: "emits",
      image: "unwritable",
      file: "unwritable",
    },
    // **`ADR-0126` A2 の16番目。**`K-G7` / `ADR-0290`(`V6-M3-T02`)。**`reference` に
    // だけ書ける。**
    //
    // **【この製品で2つ目の `silent` である。丸めない】** **今日、この宣言は要件
    // ドキュメントに1文も出ない。**
    //
    // **【`reference_picker` の1マスと性質が違う。ここを混ぜない】**
    // **`reference_picker` の `silent` は「今日はまだ出していない」であり、`V6-M6-T02`
    // が `emits` に変える。** **本キーの `silent` は「出さないと決めた」である** ——
    // **ユーザ決定 `D-V6-21`(要件の説明書には選び方は出す・探せる項目は出さない)と、
    // `V6-M0` §7-11 の限定2(「`K-G6`(テーブルの『探せる項目』)は出さない ——
    // 今日 `representative_field` を1件も出していない作法に合わせる」)による。**
    // **したがってこのマスは `V6-M6-T02` の後も `silent` のまま残る見込みである。**
    // **「書けるのに1文も出ない宣言」が1件、決定として残るということである。隠さない。**
    reference_search_fields: {
      text: "unwritable",
      long_text: "unwritable",
      number: "unwritable",
      boolean: "unwritable",
      date: "unwritable",
      select: "unwritable",
      reference: "silent",
      image: "unwritable",
      file: "unwritable",
    },
  };

  function canonicalFieldSchema(): {
    properties: Record<string, unknown>;
    allOf: {
      if: { properties: { type: { const: string } } };
      else?: { properties?: Record<string, unknown> };
    }[];
  } {
    const schema = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "..", "schemas", "manifest.schema.json"), "utf-8"),
    ) as {
      $defs: {
        field: {
          properties: Record<string, unknown>;
          allOf: {
            if: { properties: { type: { const: string } } };
            else?: { properties?: Record<string, unknown> };
          }[];
        };
      };
    };
    return schema.$defs.field;
  }

  /**
   * **schema が「このキーを書けない」と定めている型の集合**を `allOf` から機械的に作る。
   *
   * **view 側と形が違う** —— 分岐は `if: type === X` / `else: { <key>: false }` であり、
   * 「**X でない型では書けない**」と読む。したがって禁止される型は「X 以外の全部」である。
   * **`select` を条件にする分岐が2本ある**(`options` と `emphasis`)ので、
   * 分岐を型の const だけで引き当てず、キーごとに全分岐を走査する。
   */
  function typesForbiddenBySchema(key: string): Set<string> {
    const forbidden = new Set<string>();
    for (const branch of canonicalFieldSchema().allOf) {
      if (branch.else?.properties?.[key] === false) {
        for (const type of FIELD_TYPES) {
          if (type !== branch.if.properties.type.const) {
            forbidden.add(type);
          }
        }
      }
    }
    return forbidden;
  }

  function cells(): [string, Emission][] {
    return Object.entries(FIELD_KEY_EMITS_STATEMENT).flatMap(([key, byType]) =>
      FIELD_TYPES.map((type): [string, Emission] => {
        const emission = byType[type];
        if (emission === undefined) {
          throw new Error(`表に ${key}/${type} のマスがありません。`);
        }
        return [`${key}/${type}`, emission];
      }),
    );
  }

  test("$defs/field の全キーについて『文を出すか出さないか』が明示されている(順序ごと)", () => {
    // **13キー目が増えたらここが赤くなり、判断を書くまで緑にならない。**
    // **これが `ADR-0126` A9 の狙いである** —— v4 は `$defs/field` に5キーを足したが、
    // その5回とも赤くなる検査は1本も無かった。
    expect(Object.keys(canonicalFieldSchema().properties)).toEqual(
      Object.keys(FIELD_KEY_EMITS_STATEMENT),
    );
  });

  test("型の並びは FIELD_TYPES と順序ごと一致する(10型目が増えたら赤くなる)", () => {
    for (const [key, byType] of Object.entries(FIELD_KEY_EMITS_STATEMENT)) {
      expect(`${key}:${Object.keys(byType).join(",")}`).toBe(`${key}:${FIELD_TYPES.join(",")}`);
    }
    expect(FIELD_TYPES).toHaveLength(9); // 【`V5-M16` / `ADR-0161`】8 → 9(`file` が9種目)。**この行が固定していたのは「その決定が語彙を増やさなかったこと」であり、増やしたのは別の決定である。**
  });

  test("126マスの内訳は emits 76 / silent 2 / unwritable 48 である(数で残す)", () => {
    // **【`V5-M16` / `ADR-0161`】96 → 108(9型目 `file`)。** **emits 68 → 76**
    // (`file` に書ける8キー分)/ **unwritable 28 → 32**(`options` / `reference_table` /
    // `unit` / `emphasis` の4キー分)。**キーは12のままである。**
    // **【V6-M1-T01 / K-G1 / ADR-0288】108 → 117(15キー目 `reference_picker` × 9型)。**
    // **`emits` は 76 のまま動かない**(新しいキーは今日1文も出さない)。
    // **`silent` が 0 → 1 になった**(`reference_picker` / `reference` の1マス)。
    // **`unwritable` が 32 → 40 になった**(`reference` 以外の8型)。
    // **【`V6-M3-T02` / `K-G7` / `ADR-0290`】117 → 126(16キー目 `reference_search_fields`
    // × 9型)。** **`emits` は 76 のまま動かない**(新しいキーは今日1文も出さない)。
    // **`silent` が 1 → 2 になった**(`reference_search_fields` / `reference` の1マス)。
    // **`unwritable` が 40 → 48 になった**(`reference` 以外の8型)。
    // **【`V8-M20` / 台帳 `J-G28` / `ADR-0301` で 126 → 108 に縮んだ】**
    // **旧: `expect(all).toHaveLength(126)` / `emits` は 77。**
    // **`audience` と `writable_by` の2キー(どちらも9型とも `emits`)が、スキーマから
    // キーごと廃止されて表から落ちた。****マスは 126 → 108(2キー × 9型 = 18マス減)、
    // `emits` は 77 → 59 になった。****`silent`(1)と `unwritable`(48)は1マスも
    // 動いていない。****このファイルで `$defs/field` のキーが減るのは初めてである。**
    const all = cells();
    expect(all).toHaveLength(108);
    // **【`V6-M6-T02` / `ADR-0291` A1 で 76 → 77 になった】** `reference_picker/reference` の
    // 1マスが `silent` から移った。**マスの総数(126)は1マスも動いていない。**
    expect(all.filter(([, e]) => e === "emits")).toHaveLength(59);
    // **`silent` が0であることを明示的に検査する。**
    // **今日、`$defs/field` に書けるキーは全部が要件定義書に文を出す。**
    // **これは `$defs/view` 側とは違う**(view 側は今日も26マスが `silent` であり、
    // その全部が `ADR-0050` 限界8 / `ADR-0055` 限定14 が明示的に落としたものである)。
    // **ここが0でなくなったら、それは「書けるのに1文も出ない項目の宣言」が生まれた
    // ということである** —— `ADR-0126` §3a の 2 の門を通すこと。
    // **【V6-M1-T01 で 0 → 1 になった。丸めない】** **この製品で最初の `silent` である。**
    // **中身は `reference_picker` / `reference` の1マスだけで、`V6-M6-T02` が要件
    // ドキュメントに文を出したら 0 に戻る。** **上の行が言う「書けるのに1文も出ない項目の
    // 宣言」は、今日1件実在する** —— **その門(`ADR-0126` §3a の 2)は `V6-M0` の門A
    // 本審査が単位K(`K-G21b`。判定 = 限定採用。実装タスク = `V6-M6-T02`)として通して
    // おり、素通りではない。**
    // **【`V6-M3-T02` で 1 → 2 になった。丸めない】** **2つ目は
    // `reference_search_fields` / `reference` の1マスである。**
    // **【1つ目と性質が違う。ここを混ぜない】** **`reference_picker` の側は
    // 「今日はまだ出していない」であり `V6-M6-T02` が `emits` に変える。**
    // **`reference_search_fields` の側は「出さないと決めた」である**(ユーザ決定
    // `D-V6-21` / `V6-M0` §7-11 の限定2)。**したがって `V6-M6-T02` の後も 0 には
    // 戻らず 1 が残る見込みである。** **「書けるのに1文も出ない宣言」を決定として
    // 1件残すということであり、隠さない。**
    // **【`V6-M6-T02` / `K-G21b` / `ADR-0291` で 2 → 1 になった。0 には戻らない】**
    // **戻したのは `reference_picker/reference` の1マスだけである。**
    // **残る1マス(`reference_search_fields/reference`)は「出さないと決めた」側であり、
    // `V6-M6` の後も `silent` のまま残る** —— **ユーザ決定 `D-V6-21`(要件の説明書には
    // 選び方は出す・探せる項目は出さない)と `V6-M0` §7-11 の `K-G21b` 限定2 による。**
    // **「書けるのに1文も出ない項目の宣言」を、決定として1件残したということである。**
    // **`ADR-0126` §3a の 2 の門は素通りしていない** —— **`V6-M0` の門A 本審査が
    // 単位K(`K-G21b`。判定 = 限定採用)として通し、`ADR-0291` がその限定表を持つ。**
    expect(all.filter(([, e]) => e === "silent")).toHaveLength(1);
    expect(all.filter(([, e]) => e === "silent").map(([name]) => name)).toEqual([
      "reference_search_fields/reference",
    ]);
    // **`unwritable` 32 の内訳**: `options`(select 以外の8型)/ `reference_table`
    // (reference 以外の8型)/ `unit`(number 以外の8型)/ `emphasis`(select 以外の8型)
    // = 8 × 4 = 32。**着手前は 7 × 4 = 28 だった。**
    // **【V6-M1-T01 で 32 → 40 になった】** `reference_picker`(reference 以外の8型)が
    // 5本目として加わった = 8 × 5 = 40。
    // **【`V6-M3-T02` で 40 → 48 になった】** `reference_search_fields`(reference 以外の
    // 8型)が6本目として加わった = 8 × 6 = 48。
    expect(all.filter(([, e]) => e === "unwritable")).toHaveLength(48);
    // **【`V8-M20` / 台帳 `J-G28` / `ADR-0301` で 14 → 12 に縮んだ】** **旧:
    // `toHaveLength(14)`。** **`$defs/field` から `audience` / `writable_by` が
    // 廃止されたためである。**
    expect(Object.keys(FIELD_KEY_EMITS_STATEMENT)).toHaveLength(12);
  });

  test("`unwritable` の48マスは schema の allOf が実際に `false` にしている(散文で決めない)", () => {
    for (const [key, byType] of Object.entries(FIELD_KEY_EMITS_STATEMENT)) {
      const forbidden = typesForbiddenBySchema(key);
      for (const type of FIELD_TYPES) {
        if (byType[type] === "unwritable") {
          expect(`${key}/${type}:${String(forbidden.has(type))}`).toBe(`${key}/${type}:true`);
        } else {
          // **`emits` / `silent` の側は `false` になっていない(= 書ける)ことも裏を取る。**
          expect(`${key}/${type}:${String(forbidden.has(type))}`).toBe(`${key}/${type}:false`);
        }
      }
    }
  });

  test("13キー目が増えると上の照合が赤くなる(schemas/ を1バイトも変えずに確かめる)", () => {
    const withThirteenthKey = [...Object.keys(canonicalFieldSchema().properties), "for_each"];
    expect(withThirteenthKey).not.toEqual(Object.keys(FIELD_KEY_EMITS_STATEMENT));
    const reordered = [...Object.keys(canonicalFieldSchema().properties)].reverse();
    expect(reordered).not.toEqual(Object.keys(FIELD_KEY_EMITS_STATEMENT));
    expect(FIELD_KEY_EMITS_STATEMENT.for_each).toBeUndefined();
  });
});

/**
 * **`ADR-0126` A2 / A3 の実測**(`V4-M32-T02`)。**14キーが要件定義書に現れることを、
 * 本物の生成(実ディスク・実DB・実 changelog)で確かめる。**
 *
 * **中核の不変条件は A3 である**: **キーが書かれていれば必ず1文以上出る。書かれて
 * いなければ1文も出ない。** **既定値を推測して文を出さない** —— 書かれていない
 * `menu_listed` について「メニューに並ぶ」と書かない(それは実装の既定であって
 * アプリの宣言ではない)。**この不変条件により、既存アプリの生成物は1バイトも変わらない。**
 *
 * **【この describe が主張していないこと】** **文面の正しさは1文字も検査していない**
 * (`ADR-0025` §限界1 / `ADR-0126` C5)。**検査したのは「載る / 載らない」だけである。**
 * **「要件定義書に載ったから安全である」とは1文字も書かない** —— **宣言は保証ではない**
 * (`ADR-0126` A4。`GET /manifest` / MCP / 島 / ワークフローの各経路は今日も守られない)。
 */
describe("V4-M32-T02: ADR-0126 A2 —— v4 が足した14キーが要件ドキュメントに現れる", () => {
  /**
   * 本 ADR が足した20本ちょうど(A1)。**21本目を足さない。**
   *
   * **【`V8-M20` / 台帳 `J-G27` / `J-G28` / `ADR-0301`。宣言と実体の食い違いを黙って
   * 直さずに書き残す】** **この配列は今日 17本である。上の JSDoc の「20本ちょうど」は
   * `ADR-0126` A1 の逐語であり、今日の実体ではない。**
   *
   * **食い違いの扱いを決めた**: **JSDoc の逐語は書き換えない。** 理由は2つある ——
   * (1) **`ADR-0126` A1 が「20本ちょうど」と決めたこと自体は今日も歴史上の事実であり、
   * 本タスクはその決定を覆していない**(覆したのは根拠となる語彙の側である)。
   * (2) **このリポジトリは、テスト名や宣言コメントの逐語を残したまま本体だけを実体に
   * 合わせる作法を採っている**(先例: `:3716` の `$defs/app` の「6キー・1キー」、
   * `:2019` の「112マスの内訳」、`:5187` の「13キー目」)。
   * **したがってここでは「20」という数を1箇所も検査していない** ——
   * **本数を固定する `expect()` はこの配列には無く、下の各検査は配列を走査するだけである。**
   * **数を主張する検査を新しく足すこともしない**(本タスクの射程外)。
   *
   * **落とした3本の逐語**: `"screens.audience"` / `"data.field_audience"` /
   * `"data.field_writable_by"`。**`$defs/view` の `audience`、`$defs/field` の
   * `audience` / `writable_by` が `V8-M20` で廃止され、テンプレートごと撤去された。**
   *
   * **なお、この describe の名前(「v4 が足した14キーが要件ドキュメントに現れる」)と、
   * 下の3つのテスト名(「足した20本すべてが…」など)の「14」「20」も、同じ理由で
   * 当時の逐語のまま残している。今日は12キー・17本である。**
   */
  const NEW_TEMPLATES: readonly RequirementTemplateId[] = [
    "screens.menu_listed",
    "screens.menu_unlisted",
    "screens.field_group",
    "screens.field_group_item",
    "screens.modal",
    "screens.non_modal",
    "screens.search_field",
    "screens.page_size",
    "screens.after_save",
    "screens.sum_field",
    "data.field_unique",
    "data.field_unique_owner",
    "data.field_not_unique",
    "data.field_unit",
    "data.field_emphasis",
    "data.field_hide_when_empty",
    "data.field_show_when_empty",
  ];

  /**
   * **`audience` / `writable_by` は `src/kernel/types.ts` に無い**(`ADR-0071` 限定6 /
   * `ADR-0076` 限定7 が `src/kernel/` を閉じたため、スキーマにだけ在ってカーネルの型に
   * 無い)。**本タスクは `types.ts` を1バイトも触らない**(触ってよいファイルの外)ので、
   * 試材の差分は構造のまま渡す。**`src/server/` の既存テストが `as never` で同じことを
   * している**(`field-audience-projection.test.ts:66` など)。
   */
  function applyRaw(diff: unknown): void {
    apply(diff as Diff);
  }

  /**
   * **既にあるリソースに、v4 の14キーのうち書けるものだけを足す。**
   * **リソースを1つも増やさない** —— これにより「既存の文が1バイトも変わらないこと」を
   * 測れる(足された文は全部が本 ADR の20本のどれかである)。
   */
  function writeV4KeysOnExistingResources(): void {
    applyRaw({
      diff_id: "d-126a",
      intent: "v4 が足した画面と項目の宣言を、今ある画面と項目に書く",
      operations: [
        {
          op: "update_view",
          view: "book-list",
          changes: {
            menu_listed: true,
            search_fields: ["title", "memo"],
            page_size: 20,
            sum_field: "rating",
          },
        },
        {
          op: "update_view",
          view: "book-detail",
          changes: { field_groups: { 基本情報: ["title", "memo"] } },
        },
        { op: "update_view", view: "book-form", changes: { after_save: "book-detail" } },
        { op: "change_field", table: "books", field: "title", changes: { unique: true } },
        { op: "change_field", table: "books", field: "memo", changes: { hide_when_empty: true } },
        { op: "change_field", table: "books", field: "rating", changes: { unit: "点" } },
        {
          op: "change_field",
          table: "books",
          field: "genre",
          changes: { unique: false, emphasis: { 技術書: "caution" } },
        },
      ],
    });
  }

  /**
   * **リソースを新しく足して、`update_view` / `change_field` では運べないキーを書く。**
   *
   * **旧記述の逐語**: 「**`view.audience` / `view.modal` / `field.audience` /
   * `field.writable_by` は変更操作の変更範囲に入っていない**(`ADR-0071` / `ADR-0076` /
   * `ADR-0095` の各限定表)ので、`add_view` / `add_field` で書くしかない。」
   *
   * **【`V8-M20` / 台帳 `J-G27` / `J-G28` / `ADR-0301`】試材から `audience` /
   * `writable_by` を落とした。****今日は書けない** —— スキーマから廃止されたので、
   * この差分を送ると `apply_diff` が「未知のプロパティ」で拒否する
   * (**落とす前に実測して確かめた**)。**残っているのは `view.modal` だけである。**
   */
  function writeV4KeysOnNewResources(): void {
    applyRaw({
      diff_id: "d-126b",
      intent: "重ねて出す入力画面と、見せる相手を宣言した項目を足す",
      operations: [
        {
          op: "add_view",
          view: {
            id: "book-modal",
            type: "form",
            table: "books",
            fields: ["title"],
            menu_listed: false,
            modal: true,
            after_save: "book-detail",
            // **旧: `audience: ["owner", "editor"]`(`V8-M20` / `J-G27` で廃止)。**
          },
        },
        // **真偽の「偽」の側も1文出す**(A2 の 4)—— 「書いてある」ことを述べるので、
        // `modal: false` を書いた画面についても1文出る。**書かなかった画面には出ない。**
        {
          op: "add_view",
          view: {
            id: "book-plain-form",
            type: "form",
            table: "books",
            fields: ["title"],
            modal: false,
          },
        },
        {
          op: "add_field",
          table: "books",
          field: {
            id: "secret",
            name: "内部メモ",
            type: "text",
            // **旧: `audience: ["owner", "viewer"]` / `writable_by: ["owner"]`
            // (`V8-M20` / `J-G28` で廃止)。**
            unique: "owner",
            hide_when_empty: false,
          },
        },
      ],
    });
  }

  function seedAllV4Keys(): void {
    seedBase();
    writeV4KeysOnExistingResources();
    writeV4KeysOnNewResources();
  }

  function textsOf(template: RequirementTemplateId): string[] {
    return generateRequirementsDoc(dataRoot, APP_ID)
      .statements.filter((statement) => statement.template === template)
      .map((statement) => statement.text);
  }

  // --- A3 の裏側: 書いていなければ1文も出ない -----------------------------------------

  test("A3: 14キーを1つも書いていないアプリでは、足した20本が1文も出ない", () => {
    seedBase();
    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    const used = new Set(doc.statements.map((statement) => statement.template));
    for (const template of NEW_TEMPLATES) {
      expect(`${template}:${String(used.has(template))}`).toBe(`${template}:false`);
    }
    // **既定値を推測していないことの直接の検査。** 書かなかった `menu_listed` について
    // 「メニューに並べる」と述べていない(述べたら、それは実装の既定であってアプリの
    // 宣言ではない = 出典の無い記述になる)。
    expect(doc.markdown).not.toContain("メニューに並べる");
    expect(doc.markdown).not.toContain("重ねて出す");
    expect(doc.markdown).not.toContain("見せる相手");
  });

  test("A3: キーを書いても、既にあった文は1バイトも変わらない(screens / data の全文比較)", () => {
    seedBase();
    const before = generateRequirementsDoc(dataRoot, APP_ID).statements.filter(
      (statement) => statement.section === "screens" || statement.section === "data",
    );
    const beforeTexts = before.map((statement) => statement.text);

    writeV4KeysOnExistingResources();

    const after = generateRequirementsDoc(dataRoot, APP_ID).statements.filter(
      (statement) => statement.section === "screens" || statement.section === "data",
    );
    const added = new Set<RequirementTemplateId>(NEW_TEMPLATES);
    const survived = after
      .filter((statement) => !added.has(statement.template))
      .map((statement) => statement.text);

    // **足した20本を除くと、文の並びも本文も1バイトも変わらない。**
    expect(survived).toEqual(beforeTexts);
    // **そして実際に文は増えている**(0件と等しくて緑になる空回りを塞ぐ)。
    expect(after.length).toBeGreaterThan(before.length);
  });

  // --- A2 の14キー。**1キーにつき少なくとも1本** ---------------------------------------

  /*
   * **【`V8-M20` / 台帳 `J-G27` / `ADR-0301`】ここに在ったテストを1本消した。**
   *
   * **消したテスト名の逐語**: `test("1: view.audience —— 値1件につき1文(位置つき)")`
   * **本体が固定していた逐語**:
   *   「画面 `book-modal` は、`1` 番目の見せる相手として `owner` を宣言している。」
   *   「画面 `book-modal` は、`2` 番目の見せる相手として `editor` を宣言している。」
   *
   * **消してよい理由は「赤いから」ではない** —— **`screens.audience` テンプレートも、
   * それが読んでいた `$defs/view/properties/audience` も、今日は存在しない。**
   * **存在しないものの出力を固定する検査は、書き換えようがない**(`textsOf` の
   * 引数に渡す `RequirementTemplateId` が型として無い)。
   * **代わりの検査を足していない** —— `app.roles[].rules` を述べるテンプレートは
   * 今日1本も無く、固定すべき出力が1文字も無いためである。
   */

  test("2: view.menu_listed —— 真偽それぞれ1文(2本とも実測する)", () => {
    seedAllV4Keys();
    expect(textsOf("screens.menu_listed")).toEqual([
      "画面 `book-list` は、メニューに並べると宣言している。",
    ]);
    expect(textsOf("screens.menu_unlisted")).toEqual([
      "画面 `book-modal` は、メニューに並べないと宣言している。",
    ]);
  });

  test("3: view.field_groups —— まとまり1件につき1文 + 所属項目1件につき1文", () => {
    seedAllV4Keys();
    expect(textsOf("screens.field_group")).toEqual([
      "画面 `book-detail` の `1` 番目の項目のまとまりの名前は 「基本情報」 である。",
    ]);
    expect(textsOf("screens.field_group_item")).toEqual([
      "画面 `book-detail` の `1` 番目の項目のまとまりは、`1` 番目の項目としてフィールド `title` を含む。",
      "画面 `book-detail` の `1` 番目の項目のまとまりは、`2` 番目の項目としてフィールド `memo` を含む。",
    ]);
  });

  test("4: view.modal —— 真偽それぞれ1文", () => {
    seedAllV4Keys();
    expect(textsOf("screens.modal")).toEqual([
      "画面 `book-modal` は、今の画面に重ねて出すと宣言している。",
    ]);
    expect(textsOf("screens.non_modal")).toEqual([
      "画面 `book-plain-form` は、今の画面に重ねずに出すと宣言している。",
    ]);
  });

  test("4b: A3 —— `modal` を書かなかった form については1文も出ない(既定値を推測しない)", () => {
    seedAllV4Keys();
    // `book-form` は `modal` を書いていない。**「重ねずに出す」が実装の既定であっても、
    // それはアプリの宣言ではないので1文も出さない。**
    for (const text of [...textsOf("screens.modal"), ...textsOf("screens.non_modal")]) {
      expect(text).not.toContain("book-form`");
    }
  });

  test("5: view.search_fields —— 項目1件につき1文(位置つき)", () => {
    seedAllV4Keys();
    expect(textsOf("screens.search_field")).toEqual([
      "画面 `book-list` は、`1` 番目の検索対象としてフィールド `title` を宣言している。",
      "画面 `book-list` は、`2` 番目の検索対象としてフィールド `memo` を宣言している。",
    ]);
  });

  test("6: view.page_size —— 1文(値は number スロット)", () => {
    seedAllV4Keys();
    expect(textsOf("screens.page_size")).toEqual([
      "画面 `book-list` は、1ページに `20` 件を出すと宣言している。",
    ]);
    const slot = generateRequirementsDoc(dataRoot, APP_ID).statements.find(
      (statement) => statement.template === "screens.page_size",
    )?.slots.count;
    expect(slot).toEqual({ kind: "number", value: 20 });
  });

  test("7: view.after_save —— 1文(遷移先は view_id の実在集合に照合する)", () => {
    seedAllV4Keys();
    expect(textsOf("screens.after_save")).toEqual([
      "画面 `book-form` は、保存が成立したあと画面 `book-detail` へ移ると宣言している。",
      "画面 `book-modal` は、保存が成立したあと画面 `book-detail` へ移ると宣言している。",
    ]);
  });

  /*
   * **【2026-08-20。`V10-M1-T01` / `NV-G3a` / `ADR-0358` 限定1 で足した】**
   *
   * **すぐ上の 7 は `form` の2画面だけを固定しており、`detail_view` は当時
   * `unwritable` だった。** **今日は `detail_view` にも書けるので、実際に文が出ることを
   * 定数表(`VIEW_KEY_EMITS_STATEMENT`)ではなく**生成結果**で固定する** ——
   * **「`emits` と表に書いたのに1文も出ない」を作らない。**
   *
   * **【正直に書く。丸めない】出る文は `form` とまったく同じ「保存が成立したあと」である。**
   * **詳細画面に「保存」という出来事は無く、実際に発火するのは `actions` の `set` 形の
   * 書込が成立したときだけである**(限定2)。**専用の文面を足していない** ——
   * **文面(`REQUIREMENT_TEMPLATES`)を足すことは語彙を1つ足すのと同じ重さの決定であり
   * (`ADR-0025` 限定11 / `ADR-0144` §3a)、`ADR-0358` はその門を通していない。**
   * **この1点で要件定義書は今日ずれている。**
   */
  test("7b: detail_view.after_save —— 文が実際に出る(文面は form と同じで、そのずれを隠さない)", () => {
    seedAllV4Keys();
    applyRaw({
      diff_id: "d-358",
      intent: "詳細画面の書換ボタンが成立したあとの行き先を書く",
      operations: [
        { op: "update_view", view: "book-detail", changes: { after_save: "book-list" } },
      ],
    });
    expect(textsOf("screens.after_save")).toContain(
      "画面 `book-detail` は、保存が成立したあと画面 `book-list` へ移ると宣言している。",
    );
  });

  test("8: view.sum_field —— 1文", () => {
    seedAllV4Keys();
    expect(textsOf("screens.sum_field")).toEqual([
      "画面 `book-list` は、今表している集合についてフィールド `rating` の合計を出すと宣言している。",
    ]);
  });

  test("9: field.unique —— 3値それぞれ1文(owner スコープを別の文にする)", () => {
    seedAllV4Keys();
    expect(textsOf("data.field_unique")).toEqual([
      "テーブル `books` のフィールド `title` は、同じ値を持つ行を2つ作れないと宣言している。",
    ]);
    expect(textsOf("data.field_unique_owner")).toEqual([
      "テーブル `books` のフィールド `secret` は、同じ持ち主の中で同じ値を持つ行を2つ作れないと宣言している。",
    ]);
    expect(textsOf("data.field_not_unique")).toEqual([
      "テーブル `books` のフィールド `genre` は、同じ値を持つ行を作れると宣言している。",
    ]);
  });

  /*
   * **【`V8-M20` / 台帳 `J-G28` / `ADR-0301`】ここに在ったテストを2本消した。**
   *
   * **消したテスト名の逐語**:
   *   `test("10: field.audience —— 値1件につき1文(位置つき)")`
   *   `test("11: field.writable_by —— audience とは別のテンプレートで1文")`
   *
   * **本体が固定していた逐語**:
   *   10:「テーブル `books` のフィールド `secret` は、`1` 番目の見せる相手として
   *       `owner` を宣言している。」/「…`2` 番目の見せる相手として `viewer` を…」
   *   11:「テーブル `books` のフィールド `secret` は、`1` 番目の書ける相手として
   *       `owner` を宣言している。」
   *
   * **消してよい理由は「赤いから」ではない** —— **`data.field_audience` /
   * `data.field_writable_by` の2テンプレートも、それが読んでいた `$defs/field` の
   * `audience` / `writable_by` も、今日は存在しない。**
   * **代わりの検査を足していない**(上の 1 と同じ理由)。
   */

  test("12: field.unit —— 1文(末尾は逐語引用)", () => {
    seedAllV4Keys();
    expect(textsOf("data.field_unit")).toEqual([
      "テーブル `books` のフィールド `rating` の値の単位は次のとおり記録されている:\n> 点",
    ]);
  });

  test("13: field.emphasis —— 対応1件につき1文(選択肢の値は options の添字を指す)", () => {
    seedAllV4Keys();
    expect(textsOf("data.field_emphasis")).toEqual([
      "テーブル `books` のフィールド `genre` は、次の選択肢を `caution` として強調すると宣言している:\n> 技術書",
    ]);
    const statement = generateRequirementsDoc(dataRoot, APP_ID).statements.find(
      (candidate) => candidate.template === "data.field_emphasis",
    );
    // **出典は `options` 配列の添字である**(`data.field_option` と同じ経路。A7)。
    expect(statement?.slots.option).toEqual({
      kind: "verbatim",
      value: "技術書",
      from: {
        source: { kind: "manifest", pointer: "/app/tables/0/fields/2/options" },
        field: "1",
      },
    });
  });

  test("14: field.hide_when_empty —— 真偽それぞれ1文", () => {
    seedAllV4Keys();
    expect(textsOf("data.field_hide_when_empty")).toEqual([
      "テーブル `books` のフィールド `memo` は、値が無いとき画面に出さないと宣言している。",
    ]);
    expect(textsOf("data.field_show_when_empty")).toEqual([
      "テーブル `books` のフィールド `secret` は、値が無くても画面に出すと宣言している。",
    ]);
  });

  // --- 論証の4辺が新しい20本でも成り立っていること(ADR-0025 §5)---------------------

  test("足した20本すべてが実地で踏まれ、辺2(text はレンダラの出力のみ)が成り立つ", () => {
    seedAllV4Keys();
    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    const used = new Set(doc.statements.map((statement) => statement.template));
    for (const template of NEW_TEMPLATES) {
      expect(`${template}:${String(used.has(template))}`).toBe(`${template}:true`);
    }
    for (const statement of doc.statements) {
      expect(renderStatementText(statement.template, statement.slots)).toBe(statement.text);
    }
  });

  test("辺4(出典が非空)と、出典が実際にマニフェストで解決できること", () => {
    seedAllV4Keys();
    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    const manifest = readCurrentManifest(dataRoot, APP_ID) as unknown;
    const added = new Set<RequirementTemplateId>(NEW_TEMPLATES);
    let checked = 0;
    for (const statement of doc.statements) {
      if (!added.has(statement.template)) {
        continue;
      }
      expect(statement.sources.length).toBeGreaterThan(0);
      const first = statement.sources[0];
      expect(first?.kind).toBe("manifest");
      if (first?.kind === "manifest") {
        expect(`${statement.template}:${first.pointer}`).not.toBe(`${statement.template}:`);
        expect(resolvePointer(manifest, first.pointer)).toBeDefined();
        checked += 1;
      }
    }
    // **空回りを塞ぐ**(0件で緑にならない)。
    expect(checked).toBeGreaterThanOrEqual(20);
  });

  test("新しい識別子グループは field_group_name の1件だけで、実在集合に載る(A5)", () => {
    seedAllV4Keys();
    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    expect(doc.identifiers.field_group_name).toEqual(["基本情報"]);
    // **`_name` で終わるので鉤括弧で描かれる**(ADR-0025 §4-2)。
    expect(doc.markdown).toContain("「基本情報」");
    expect(doc.markdown).not.toContain("`基本情報`");
  });

  test("新しい語彙グループは2件だけで、値はスキーマの enum の写しである(A6)", () => {
    seedAllV4Keys();
    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    const vocabularies = new Set<string>();
    for (const statement of doc.statements) {
      for (const slot of Object.values(statement.slots)) {
        if (slot.kind === "term") {
          vocabularies.add(slot.vocabulary);
        }
      }
    }
    // **【`V8-M20` / 台帳 `J-G27` / `J-G28` / `ADR-0301` で `true` → `false` に更新した】**
    // **旧本体**: `expect(vocabularies.has("audience_role")).toBe(true);`
    // **検査は消していない。****向きを反転させて、今日の実体をそのまま固定する。**
    // **`audience_role` を使っていたのは `screens.audience` / `data.field_audience` /
    // `data.field_writable_by` の3本だけで、その3本が撤去された。**
    // **【正直に書く】** **`VocabularyGroup` には `audience_role` が今日も在り、
    // `VOCABULARIES` にも `AUDIENCE_ROLES`(5値)が在る** ——
    // **誰も使わない語彙スロットが1件、語彙グループ19件のうちに残っている。**
    // **残した根拠は `ADR-0301` である** —— **`V8-M20` の台帳が挙げる撤去の単位は
    // `J-G27`〜`J-G30` だけで、この生成器の内部語彙グループを撤去する単位は1件も無い。**
    // **根拠の無い撤去は行わない**(理由の全文は `requirements-doc.ts` の
    // `VocabularyGroup` の `audience_role` の節に書いた)。
    expect(vocabularies.has("audience_role")).toBe(false);
    expect(vocabularies.has("emphasis_level")).toBe(true);
    // **スキーマ側の enum と突き合わせる**(片方だけ直ると食い違う穴があることの申告は
    // `ADR-0126` Consequences 6。ここではその食い違いを実際に検出する)。
    const schema = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "..", "schemas", "manifest.schema.json"), "utf-8"),
    ) as {
      $defs: {
        view: { properties: Record<string, unknown> };
        field: { properties: { emphasis: { additionalProperties: { enum: string[] } } } };
      };
    };
    // **【`V5-M17-T07` / `G-G8` / `ADR-0159` 限定1 で置き換えた。旧本体を先に書く】**
    // **旧本体**: `expect(...audience.items.enum).toEqual(["owner","editor","viewer","customer","anonymous"])`。
    // **`ADR-0159` が `enum` を「識別子の形」(`pattern`)へ替えたので、スキーマは値を
    // 1つも列挙していない。****生成器の `AUDIENCE_ROLES`(5値の写し)との突き合わせは
    // `scripts/audience-role-sync.test.ts` が正準を移したうえで今日も行っている。**
    // **【`V8-M20` / `J-G27` / `ADR-0301` で置き換えた。旧本体を先に書く】**
    // **旧本体**: `expect(schema.$defs.view.properties.audience.items.enum).toBeUndefined();`
    //             `expect(schema.$defs.view.properties.audience.items.pattern).toBe("^[a-z0-9_]{1,32}$");`
    // **`$defs/view/properties/audience` そのものが廃止されたので、上の2行は読む先が無い
    // (実行すると `undefined` を参照して落ちる)。****「キーが在ること」を前提にした
    // 検査を、「キーが無いこと」の検査に反転させる** —— **黙って消すのではなく、
    // 廃止が実際に起きていることをここで測る。**
    expect(schema.$defs.view.properties.audience).toBeUndefined();
    expect(schema.$defs.field.properties.emphasis.additionalProperties.enum).toEqual([
      "neutral",
      "info",
      "caution",
      "danger",
    ]);
  });

  test("A4: 文面は「宣言している」までしか述べない(保証を1文字も述べない)", () => {
    seedAllV4Keys();
    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    for (const template of NEW_TEMPLATES) {
      const body = REQUIREMENT_TEMPLATES[template];
      for (const forbidden of ["だけが見られる", "は漏れない", "は書けない", "安全"]) {
        expect(`${template}:${body}`).not.toContain(forbidden);
      }
    }
    for (const forbidden of ["だけが見られる", "漏れない", "安全である"]) {
      expect(doc.markdown).not.toContain(forbidden);
    }
  });
});

/**
 * **`V4-M39-T01`。`ADR-0144`(プリセット9キー・限定38点)/ `ADR-0145`(逃げ道への参照・限定29点)。**
 *
 * **`$defs/view` の28キーのうち、4形すべてで1文も出していなかった最後の10キーを出す。**
 * **中核の不変条件は `ADR-0144` A3 である**: **書かれていれば必ず1文以上出る。書かれて
 * いなければ1文も出ない。既定値を推測して文を出さない。**
 *
 * **【この describe が主張していないこと】**
 * 1. **「要件定義書を読めば画面の見た目が分かる」とは1文字も検査していない**(`ADR-0144` C9)
 *    —— **宣言と描画は一致するとは限らない**(型とプリセットの対応は1つも検査されておらず、
 *    `columns` 非掲載の列にも寄せ・幅を書け、`card` は列の軸を無効にする)。
 * 2. **「この画面は独自の見た目になっている」とは1文字も検査していない**(`ADR-0145` A6 / C1)
 *    —— **資産が失効していれば当たっていない。** 生成は失効を1つも知らない(A7)。
 * 3. **プリセットが効いているかを1つも検査していない**(`ADR-0144` C10)。
 * 4. **CSS のバイト列を1バイトも読んでいない**(`ADR-0145` A3 / B1。憲法1)。
 */
describe("V4-M39-T01: ADR-0144 / ADR-0145 —— 画面の見せ方9キーと逃げ道への参照が要件ドキュメントに現れる", () => {
  /** **足したのは11本ちょうど**(`ADR-0144` A1 の9本 + `ADR-0145` A1 の2本)。**12本目を足さない。** */
  const NEW_TEMPLATES: readonly RequirementTemplateId[] = [
    "screens.preset_column_align",
    "screens.preset_column_width",
    "screens.preset_pager_position",
    "screens.preset_label_placement",
    "screens.preset_field_columns",
    "screens.preset_image_size",
    "screens.preset_text_preview",
    "screens.preset_list_shape",
    "screens.preset_density",
    "screens.custom_css",
    "screens.custom_css_digest",
  ];

  /** 逃げ道の資産の内容ダイジェスト(sha256 の16進64桁)。**短縮も変換もしない**(`ADR-0145` A5 / C3)。 */
  const DIGEST = "0123456789abcdef".repeat(4);

  /** 9キーを、書ける画面種別に書き分ける(schema の `allOf` の実測どおり)。 */
  function writePresets(): void {
    apply({
      diff_id: "d-144a",
      intent: "画面ごとの見せ方を選ぶ",
      operations: [
        {
          op: "update_view",
          view: "book-list",
          changes: {
            preset_column_align: { title: "center", genre: "right" },
            preset_column_width: { title: "wide" },
            preset_pager_position: "both",
            preset_image_size: "thumbnail",
            preset_text_preview: "long",
            preset_list_shape: "card",
            preset_density: "compact",
          },
        },
        {
          op: "update_view",
          view: "book-detail",
          changes: {
            preset_label_placement: "stacked",
            preset_field_columns: 2,
            preset_image_size: "medium",
            preset_text_preview: "short",
            preset_density: "comfortable",
          },
        },
        {
          op: "update_view",
          view: "book-form",
          changes: {
            preset_label_placement: "inline",
            preset_field_columns: 1,
            preset_density: "comfortable",
          },
        },
      ],
    });
  }

  /** 逃げ道(任意 CSS)への参照を1画面に書く。**CSS の本文はマニフェストに置き場が無い。** */
  function writeEscapeHatch(): void {
    apply({
      diff_id: "d-145a",
      intent: "持ち主が発行した資産を一覧に結び付ける",
      operations: [
        {
          op: "update_view",
          view: "book-list",
          changes: { custom_css: { asset: "print-layout", digest: DIGEST } },
        },
      ],
    });
  }

  function seedAll(): void {
    seedBase();
    writePresets();
    writeEscapeHatch();
  }

  function textsOf(template: RequirementTemplateId): string[] {
    return generateRequirementsDoc(dataRoot, APP_ID)
      .statements.filter((statement) => statement.template === template)
      .map((statement) => statement.text);
  }

  /** `src/kernel/requirements-doc.ts` の union をソースのテキストから数える(値が export されていないため)。 */
  function unionMembers(name: string): string[] {
    const source = readFileSync(join(import.meta.dir, "requirements-doc.ts"), "utf-8");
    const start = source.indexOf(`export type ${name} =`);
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf(";", start));
    return [...body.matchAll(/\|\s*"([a-z_]+)"/g)].map((match) => match[1] ?? "");
  }

  function viewSchemaProperties(): Record<string, Record<string, unknown>> {
    const schema = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "..", "schemas", "manifest.schema.json"), "utf-8"),
    ) as { $defs: { view: { properties: Record<string, Record<string, unknown>> } } };
    return schema.$defs.view.properties;
  }

  // --- A1: 本数 ---------------------------------------------------------------------

  /*
   * **【`V5-M25-T01` / `ADR-0174` による追随。旧を隠さない】** **旧: `toHaveLength(106)`。**
   * **`ADR-0174` が `automation.trigger_manual` を1本足した(106 → 107)。**
   * **本 test が固定しているのは `ADR-0144` / `ADR-0145` が足した11本であり、
   * その主張(`NEW_TEMPLATES` が全部在る / `screens.preset_` は9本)は1ミリも弱まっていない。**
   */
  test("A1: テンプレートは 95 → 106 → 107 になる(`ADR-0144`/`ADR-0145` が11本、`ADR-0174` が1本)", () => {
    const ids = Object.keys(REQUIREMENT_TEMPLATES);
    // **【`V6-M6-T02` / `ADR-0291` A1 で 107 → 113 に更新した】** **本 ADR の増分ではない**
    // —— 増えたのは参照項目の選び方の6本であり、`ADR-0144` / `ADR-0145` / `ADR-0174` の
    // 本数(11 + 1)は1本も動いていない(下の3行がそれを別々に固定している)。
    // **【`V7-M6-T03` / `Z-G28` で 113 → 125 に更新した】** **旧: `toHaveLength(113)`。**
    // **これも本 ADR の増分ではない** —— 増えたのはアクセス権管理の宣言の12本であり、
    // `ADR-0144` / `ADR-0145` / `ADR-0174` の本数(11 + 1)は1本も動いていない。
    // **【`V8-M20` / 台帳 `J-G27` / `J-G28` / `ADR-0301` で 125 → 122 に更新した】**
    // **旧: `toHaveLength(125)`。****この test で総数が減るのは初めてである。**
    // **これも本 ADR の増分ではない** —— 撤去されたのは `ADR-0126` A1 の3本であり、
    // `ADR-0144` / `ADR-0145` / `ADR-0174` の本数(11 + 1)は1本も動いていない
    // (下の3行がそれを別々に固定している)。
    // **【`V8-M22` / 台帳 `J-G34a` / ユーザ決定 `D-V8-36` / `ADR-0315` で 122 → 136 に更新した】**
    // **旧: `toHaveLength(122)`。** **本 ADR の増分ではない** —— 増えたのは役割を述べる
    // 14本であり、この test が固定している本数は1本も動いていない(下の行が別に固定する)。
    // **【`V8-M26` / 台帳 `D-V8-70`(2026-08-11)で 136 → 137 に更新した】**
    // **旧: `toHaveLength(136)`。** **増えたのは葉の3種目を述べる
    // `features.role_condition_is_empty` の1本ちょうどである**(減った本数・改名は0)。
    // **この test が固定している本数はこの1本ぶんしか動いていない。**
    // **【`V8-M13-T03` / 台帳 `Q-G31a` / `Q-G31b` で 137 → 149 に更新した】**
    // **旧: `toHaveLength(137)`。** **増えたのは集計表の中身を述べる12本ちょうどである。**
    // **本 ADR の増分ではない。**
    expect(ids).toHaveLength(149);
    for (const template of NEW_TEMPLATES) {
      expect(ids).toContain(template);
    }
    // **`screens.preset_` で始まるのは9本ちょうど**(`ADR-0144` A1)。
    expect(ids.filter((id) => id.startsWith("screens.preset_"))).toHaveLength(9);
    // **`screens.custom_css` で始まるのは2本ちょうど**(`ADR-0145` A1)。
    expect(ids.filter((id) => id.startsWith("screens.custom_css"))).toHaveLength(2);
  });

  // --- A3: 書いていなければ1文も出ない / 生成物が1バイトも変わらない -----------------

  test("A3: 10キーを1つも書いていないアプリでは、足した11本が1文も出ない", () => {
    seedBase();
    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    const used = new Set(doc.statements.map((statement) => statement.template));
    for (const template of NEW_TEMPLATES) {
      expect(`${template}:${String(used.has(template))}`).toBe(`${template}:false`);
    }
    // **既定値を推測していないことの直接の検査。** 書かなかった `preset_density` について
    // 「ゆったりである」と述べていない(述べたら出典の無い記述になる)。
    expect(doc.markdown).not.toContain("詰まり具合");
    expect(doc.markdown).not.toContain("段組数");
    expect(doc.markdown).not.toContain("目印");
  });

  test("A3: キーを書いても、既にあった文は1バイトも変わらない(screens 節の全文比較)", () => {
    seedBase();
    const beforeTexts = generateRequirementsDoc(dataRoot, APP_ID)
      .statements.filter((statement) => statement.section === "screens")
      .map((statement) => statement.text);

    writePresets();
    writeEscapeHatch();

    const after = generateRequirementsDoc(dataRoot, APP_ID).statements.filter(
      (statement) => statement.section === "screens",
    );
    const added = new Set<RequirementTemplateId>(NEW_TEMPLATES);
    const survived = after
      .filter((statement) => !added.has(statement.template))
      .map((statement) => statement.text);
    expect(survived).toEqual(beforeTexts);
    // **実際に文は増えている**(0件と等しくて緑になる空回りを塞ぐ)。
    expect(after.length).toBeGreaterThan(beforeTexts.length);
  });

  test("A3: 列の寄せ・幅を空の `{}` にした画面は、キーが書いてあるのに1文も出ない(非対称を隠さない)", () => {
    seedBase();
    apply({
      diff_id: "d-144-empty",
      intent: "列ごとの指定をやめる",
      operations: [
        {
          op: "update_view",
          view: "book-list",
          changes: { preset_column_align: {}, preset_column_width: {} },
        },
      ],
    });
    expect(textsOf("screens.preset_column_align")).toEqual([]);
    expect(textsOf("screens.preset_column_width")).toEqual([]);
    // **マニフェストにはキーが在る**(「書いていない」のではなく「空を書いた」)。
    const manifest = readCurrentManifest(dataRoot, APP_ID) as unknown as {
      app: { views: { id: string; preset_column_align?: unknown }[] };
    };
    const list = manifest.app.views.find((view) => view.id === "book-list");
    expect(list?.preset_column_align).toEqual({});
  });

  // --- A2: 9キー + 逃げ道の実測 -------------------------------------------------------

  test("1: preset_column_align —— マップの要素1件につき1文(列は field_id で照合する)", () => {
    seedAll();
    expect(textsOf("screens.preset_column_align")).toEqual([
      "画面 `book-list` は、列 `title` の寄せとして `center` を宣言している。",
      "画面 `book-list` は、列 `genre` の寄せとして `right` を宣言している。",
    ]);
  });

  test("2: preset_column_width —— マップの要素1件につき1文", () => {
    seedAll();
    expect(textsOf("screens.preset_column_width")).toEqual([
      "画面 `book-list` は、列 `title` の幅として `wide` を宣言している。",
    ]);
  });

  test("3: preset_pager_position —— 1文", () => {
    seedAll();
    expect(textsOf("screens.preset_pager_position")).toEqual([
      "画面 `book-list` は、件数とページ送りの位置として `both` を宣言している。",
    ]);
  });

  test("4: preset_label_placement —— detail_view と form の両方で1文", () => {
    seedAll();
    expect(textsOf("screens.preset_label_placement")).toEqual([
      "画面 `book-form` は、項目名と値の並べ方として `inline` を宣言している。",
      "画面 `book-detail` は、項目名と値の並べ方として `stacked` を宣言している。",
    ]);
  });

  test("5: preset_field_columns —— 1文(値は number スロット。語彙タグにしない)", () => {
    seedAll();
    expect(textsOf("screens.preset_field_columns")).toEqual([
      "画面 `book-form` は、項目の段組数として `1` を宣言している。",
      "画面 `book-detail` は、項目の段組数として `2` を宣言している。",
    ]);
    const slot = generateRequirementsDoc(dataRoot, APP_ID).statements.find(
      (statement) => statement.template === "screens.preset_field_columns",
    )?.slots.count;
    expect(slot).toEqual({ kind: "number", value: 1 });
  });

  test("6: preset_image_size —— list_view と detail_view で1文", () => {
    seedAll();
    expect(textsOf("screens.preset_image_size")).toEqual([
      "画面 `book-list` は、画像の大きさとして `thumbnail` を宣言している。",
      "画面 `book-detail` は、画像の大きさとして `medium` を宣言している。",
    ]);
  });

  test("7: preset_text_preview —— list_view と detail_view で1文", () => {
    seedAll();
    expect(textsOf("screens.preset_text_preview")).toEqual([
      "画面 `book-list` は、長文の見せる長さとして `long` を宣言している。",
      "画面 `book-detail` は、長文の見せる長さとして `short` を宣言している。",
    ]);
  });

  test("8: preset_list_shape —— 1文(単位B)", () => {
    seedAll();
    expect(textsOf("screens.preset_list_shape")).toEqual([
      "画面 `book-list` は、一覧の器の形として `card` を宣言している。",
    ]);
  });

  test("9: preset_density —— 3種すべての画面で1文(入力フォームの見せ方が出るのは初めて)", () => {
    seedAll();
    expect(textsOf("screens.preset_density")).toEqual([
      "画面 `book-list` は、画面の詰まり具合として `compact` を宣言している。",
      "画面 `book-form` は、画面の詰まり具合として `comfortable` を宣言している。",
      "画面 `book-detail` は、画面の詰まり具合として `comfortable` を宣言している。",
    ]);
  });

  test("10: custom_css —— 資産名とダイジェストの2文(CSS の中身は1バイトも出ない)", () => {
    seedAll();
    expect(textsOf("screens.custom_css")).toEqual([
      "画面 `book-list` は、持ち主が発行した資産 「print-layout」 を参照すると宣言している。",
    ]);
    expect(textsOf("screens.custom_css_digest")).toEqual([
      `画面 \`book-list\` が参照する資産 「print-layout」 の中身の目印は次のとおり記録されている:\n> ${DIGEST}`,
    ]);
  });

  // --- ADR-0145 A5: ダイジェストは verbatim で64桁そのまま ---------------------------

  test("ADR-0145 A5 / C3: ダイジェストは切り詰めも変換もせず64桁そのまま写す", () => {
    seedAll();
    const statement = generateRequirementsDoc(dataRoot, APP_ID).statements.find(
      (candidate) => candidate.template === "screens.custom_css_digest",
    );
    expect(statement?.slots.digest).toEqual({
      kind: "verbatim",
      value: DIGEST,
      from: {
        source: { kind: "manifest", pointer: "/app/views/0/custom_css" },
        field: "digest",
      },
    });
    expect(DIGEST).toHaveLength(64);
    expect(statement?.text).toContain(DIGEST);
  });

  test("ADR-0145 A5: 足した11本のうち `verbatim` を使うのは custom_css_digest の1本だけである", () => {
    /*
     * **【実測の食い違いを明記する】** `ADR-0145` A5 は「**`verbatim` の使用箇所は 2 → 3 に
     * なる**」と書き、審査記録 §1-4 も「`verbatim` の使用箇所 = **2**」と測っていた。
     * **着手時の実数は 12 本である**(下の一覧)。**2 は `ADR-0126` A7 が「自分が足した20本の
     * うち2本」と言ったものであり、生成器全体の数ではない。**
     * **ADR の本文は1バイトも書き換えず、実数で固定する**(`records/v4-m39-impl.md` §5)。
     * **限定の趣旨(4箇所目を足さない = 本 ADR の増分は1本だけ)は下の2つの assertion が
     * そのまま守る。**
     */
    const verbatimTemplates = Object.entries(REQUIREMENT_TEMPLATES)
      .filter(([, body]) => /\n\{[a-z_]+\}$/.test(body))
      .map(([id]) => id);
    expect(verbatimTemplates).toEqual([
      // **【`V8-M22` / 台帳 `J-G34a` / `ADR-0315` で1本増えた】** **旧一覧はこの行を持たない。**
      // **役割の規則の条件が定数と比べる値(`when` の `equals`)を写す1本である** ——
      // **`screens.filter_equals` と同じ理由で、値を解釈せず逐語引用にした。**
      // **本 ADR(`ADR-0145`)の増分ではない。**
      "features.role_condition_equals",
      "screens.filter",
      "screens.filter_equals",
      "screens.filter_contains",
      "screens.filter_gte",
      "screens.filter_lte",
      "screens.filter_in_value",
      "screens.custom_css_digest",
      "data.field_option",
      "data.field_unit",
      "data.field_emphasis",
      // **【`V7-M6-T03` / `Z-G28` で1本増えた】** **旧一覧はこの行を持たない。**
      // **アクセス権管理の権限名(機械が使う名前)を写す1本である** —— 実在集合を持たず
      // 閉じた語彙でもないので、`data.field_option` と同じ逐語引用の形を採った。
      // **本 ADR(`ADR-0145`)の増分ではない**(下の assertion がそれを別に固定している)。
      "data.table_access_permission",
      "automation.action_target",
      "automation.action_when",
      "automation.action_destination",
      "automation.action_payload",
      "automation.action_value",
      "automation.action_ai_prompt",
      "automation.action_ai_input",
      "automation.action_ai_fallback",
      "history.intent",
    ]);
    // **本 ADR が足したのは1本ちょうどである**(A5 の「4箇所目を足さない」の実体)。
    expect(
      verbatimTemplates.filter((id) => NEW_TEMPLATES.includes(id as RequirementTemplateId)),
    ).toEqual(["screens.custom_css_digest"]);
  });

  // --- ADR-0145 A7: 実在を照合しない。fail-closed しない -----------------------------

  test("ADR-0145 A7: 失効した(ストアに無い)資産を指す参照でも生成は成功する", () => {
    seedBase();
    apply({
      diff_id: "d-145-missing",
      intent: "発行していない資産を指す参照を書く",
      operations: [
        {
          op: "update_view",
          view: "book-detail",
          changes: { custom_css: { asset: "never-issued", digest: DIGEST } },
        },
      ],
    });
    // **fail-closed しない**(照合先がマニフェストの外に在り、読みに行くと A3 / B1 を破る)。
    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    expect(doc.markdown).toContain("「never-issued」");
    expect(doc.identifiers.escape_hatch_asset_name).toEqual(["never-issued"]);
  });

  // --- ADR-0145 A3 / B1: CSS を1バイトも読まない --------------------------------------

  test("ADR-0145 A3 / B1: 生成器は blob / escape-hatch を1本も import しない(憲法1)", () => {
    const source = readFileSync(join(import.meta.dir, "requirements-doc.ts"), "utf-8");
    const importLines = source
      .split("\n")
      .filter((line) => /^\s*import\s|^\s*}\s*from\s/.test(line));
    for (const line of importLines) {
      expect(line).not.toContain("blob");
      expect(line).not.toContain("escape");
    }
    expect(source).not.toContain("putBlob");
    expect(source).not.toContain("getBlob");
  });

  // --- ADR-0144 A5 / A6: 語彙グループ8件 ---------------------------------------------

  test("ADR-0144 A5 / A6: 語彙グループは 11 → 19 になり、値は schema の enum と順序ごと一致する", () => {
    const groups = unionMembers("VocabularyGroup");
    expect(groups).toHaveLength(19);
    for (const group of [
      "column_align",
      "column_width",
      "pager_position",
      "label_placement",
      "image_size",
      "text_preview",
      "list_shape",
      "density",
    ]) {
      expect(groups).toContain(group);
    }

    seedAll();
    const used = new Map<string, string[]>();
    for (const statement of generateRequirementsDoc(dataRoot, APP_ID).statements) {
      for (const slot of Object.values(statement.slots)) {
        if (slot.kind === "term") {
          used.set(slot.vocabulary, [...(used.get(slot.vocabulary) ?? []), slot.value]);
        }
      }
    }
    const properties = viewSchemaProperties();
    /** マップ形のキー(`{<field_id>: <enum>}`)の値域は `additionalProperties` の下に在る。 */
    const mapEnum = (key: string): string[] => {
      const property = properties[key];
      expect(property).toBeDefined();
      return (property?.additionalProperties as { enum: string[] } | undefined)?.enum ?? [];
    };
    // **順序ごと**一致させる(片方だけ直ると食い違う穴の申告は `ADR-0144` Consequences 5)。
    const expected: Record<string, string[]> = {
      column_align: mapEnum("preset_column_align"),
      column_width: mapEnum("preset_column_width"),
      pager_position: properties.preset_pager_position?.enum as string[],
      label_placement: properties.preset_label_placement?.enum as string[],
      image_size: properties.preset_image_size?.enum as string[],
      text_preview: properties.preset_text_preview?.enum as string[],
      list_shape: properties.preset_list_shape?.enum as string[],
      density: properties.preset_density?.enum as string[],
    };
    expect(expected.column_align).toEqual(["left", "center", "right"]);
    expect(expected.column_width).toEqual(["narrow", "standard", "wide"]);
    expect(expected.pager_position).toEqual(["top", "bottom", "both"]);
    expect(expected.label_placement).toEqual(["inline", "stacked"]);
    expect(expected.image_size).toEqual(["thumbnail", "medium", "original"]);
    expect(expected.text_preview).toEqual(["short", "standard", "long", "full"]);
    expect(expected.list_shape).toEqual(["table", "card"]);
    expect(expected.density).toEqual(["comfortable", "compact"]);
    // 実地で踏んだ語彙タグが、すべて schema の enum の要素であること。
    for (const [group, values] of used) {
      const allowed = expected[group];
      if (allowed === undefined) {
        continue;
      }
      for (const value of values) {
        expect(allowed).toContain(value);
      }
    }
  });

  // --- ADR-0144 A7: number スロットは1本だけ ------------------------------------------

  test("ADR-0144 A7: 足した11本のうち `number` スロットを生むのは preset_field_columns だけである", () => {
    seedAll();
    const added = new Set<RequirementTemplateId>(NEW_TEMPLATES);
    const withNumber = new Set<string>();
    for (const statement of generateRequirementsDoc(dataRoot, APP_ID).statements) {
      if (!added.has(statement.template)) {
        continue;
      }
      for (const slot of Object.values(statement.slots)) {
        if (slot.kind === "number") {
          withNumber.add(statement.template);
        }
        // **スロットは既存4種のまま**(`ADR-0144` B8 / C2)。
        expect(["id", "verbatim", "term", "number"]).toContain(slot.kind);
      }
    }
    expect([...withNumber]).toEqual(["screens.preset_field_columns"]);
  });

  // --- ADR-0144 A8 / ADR-0145 A4: 識別子グループ --------------------------------------

  test("ADR-0144 A8: マップ2キーの列は既存の field_id グループで写す(新しい識別子グループを作らない)", () => {
    seedAll();
    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    for (const template of [
      "screens.preset_column_align",
      "screens.preset_column_width",
    ] as const) {
      const statement = doc.statements.find((candidate) => candidate.template === template);
      expect(statement?.slots.field_id).toEqual({
        kind: "id",
        group: "field_id",
        value: "title",
      });
    }
  });

  test("ADR-0145 A4: 識別子グループは escape_hatch_asset_name の1件だけ増える(19件目を作らない)", () => {
    // **【実測の食い違いを明記する】** `ADR-0144` A8 / `ADR-0145` A4 は「17 → 18」と書いたが、
    // **着手時の実数は 22 である**(`historical_*` の5件を数え落としている)。
    // **ADR の本文は1バイトも書き換えず、実数で固定する**(`docs/plan/v4/records/v4-m39-impl.md` §5)。
    // **【`V8-M22` / 台帳 `J-G34a` / `ADR-0315` で 23 → 26 に更新した】** **旧: `23`。**
    // **増えたのは `role_id` / `role_name` / `view_action_id` の3件である。**
    // **本 ADR(`ADR-0145`)の増分(`escape_hatch_asset_name` の1件)は1ミリも動いていない**
    // —— **下の2行がそれを別に固定している。**
    expect(unionMembers("IdentifierGroup")).toHaveLength(26);
    seedAll();
    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    expect(Object.keys(doc.identifiers)).toHaveLength(26);
    expect(doc.identifiers.escape_hatch_asset_name).toEqual(["print-layout"]);
    // **`_name` で終わるので鉤括弧で描かれる**(`ADR-0025` §4-2)。
    expect(doc.markdown).toContain("「print-layout」");
    expect(doc.markdown).not.toContain("`print-layout`");
  });

  // --- ADR-0144 A4 / C9 / ADR-0145 A6 / C1: 文面は「宣言している」までしか述べない -----

  test("A4 / A6: 足した11本の本文に、描画の結果を述べる語が1件も無い", () => {
    /*
     * **語の一覧をこの検査の中で固定する**(`ADR-0144` A4)。
     *
     * **【緊張を明記する】** 語の一覧を作ることは `ADR-0013` 限定13(拒否リストを作らない)と
     * 緊張しうる。**当て先はテンプレート本文という有限の定数表であって、ユーザが書く値では
     * ない** —— **限定13 が禁じたのは「システムが受け取る値の拒否リスト」である。**
     * ここで拒否しているのは開発者が書く定数であり、実行時に1度も評価されない。
     */
    const FORBIDDEN_RENDERING_WORDS = [
      "のように見える",
      "縮小して",
      "2段組で並ぶ",
      "切り詰められる",
      "効いている",
      "当たっている",
      "描画される",
      "見た目になる",
      "上書き",
      "独自の見た目",
      "安全",
    ];
    for (const template of NEW_TEMPLATES) {
      const body = REQUIREMENT_TEMPLATES[template];
      for (const forbidden of FORBIDDEN_RENDERING_WORDS) {
        expect(`${template}:${body}`).not.toContain(forbidden);
      }
      // **どの本文も「宣言している」か「記録されている」で閉じる。**
      expect(/宣言している。$|記録されている:\n\{[a-z_]+\}$/.test(body)).toBe(true);
    }
    seedAll();
    // **当て先は画面節の本文である。** 履歴節の `intent` は**ユーザが書いた逐語引用**であり、
    // そこに何が書かれるかを本検査は1文字も縛らない(`ADR-0013` 限定13 との緊張を広げない)。
    const screens = generateRequirementsDoc(dataRoot, APP_ID)
      .statements.filter((statement) => statement.section === "screens")
      .map((statement) => statement.text)
      .join("\n");
    for (const forbidden of FORBIDDEN_RENDERING_WORDS) {
      expect(screens).not.toContain(forbidden);
    }
  });

  // --- 論証の4辺が新しい11本でも成り立つこと(ADR-0025 §5)---------------------------

  test("足した11本すべてが実地で踏まれ、辺2(text はレンダラの出力のみ)と辺4(出典が非空)が成り立つ", () => {
    seedAll();
    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    const used = new Set(doc.statements.map((statement) => statement.template));
    for (const template of NEW_TEMPLATES) {
      expect(`${template}:${String(used.has(template))}`).toBe(`${template}:true`);
    }
    const manifest = readCurrentManifest(dataRoot, APP_ID) as unknown;
    const added = new Set<RequirementTemplateId>(NEW_TEMPLATES);
    let checked = 0;
    for (const statement of doc.statements) {
      expect(renderStatementText(statement.template, statement.slots)).toBe(statement.text);
      if (!added.has(statement.template)) {
        continue;
      }
      expect(statement.sources.length).toBeGreaterThan(0);
      const first = statement.sources[0];
      expect(first?.kind).toBe("manifest");
      if (first?.kind === "manifest") {
        expect(resolvePointer(manifest, first.pointer)).toBeDefined();
        checked += 1;
      }
    }
    // **空回りを塞ぐ**(0件で緑にならない)。
    expect(checked).toBeGreaterThanOrEqual(11);
  });

  // --- ADR-0145 A2: custom_css の要素は2つちょうど ------------------------------------

  test("ADR-0145 A2: `$defs/view/properties/custom_css` の要素は2つちょうどである(3要素目が増えたら赤くなる)", () => {
    const custom = viewSchemaProperties().custom_css;
    expect(Object.keys(custom?.properties as Record<string, unknown>)).toEqual(["asset", "digest"]);
    expect(custom?.additionalProperties).toBe(false);
  });
});

/**
 * **`V6-M6-T02`。`K-G21b`(門A / 判定 = 限定採用)。`ADR-0291`(限定表つき)。**
 *
 * **参照項目の選び方(`$defs/field` の `reference_picker` / `$defs/view` の
 * `reference_pickers`)を要件定義書に出す。** **探せる項目(`reference_search_fields`)は
 * 出さない** —— **ユーザ決定 `D-V6-21` と `V6-M0` §7-11 の `K-G21b` 限定2 による。**
 *
 * **【この describe が主張していないこと】**
 * 1. **「要件定義書を読めば実際にどう選べるかが分かる」とは1文字も検査していない** ——
 *    **どの器で描くかはマニフェストに1バイトも現れない**(`ADR-0288` 限定2)。
 * 2. **探せる項目が0本のとき検索の口が出ないことを、要件定義書は1文も述べない**
 *    (`ADR-0290` / `v6-m4.md` §1-4)。**宣言と画面の一致を誰も保証していない。**
 * 3. **`representative_field` を1件も出していない作法を1バイトも変えていない**
 *    (実測: `grep -c representative_field src/kernel/requirements-doc.ts` = 0)。
 */
describe("V6-M6-T02: ADR-0291 —— 参照項目の選び方が要件ドキュメントに現れる", () => {
  /** **足したのは6本ちょうど**(項目側3本 + 入力画面側3本)。**7本目を足さない。** */
  const NEW_TEMPLATES: readonly RequirementTemplateId[] = [
    "data.field_reference_picker_list",
    "data.field_reference_picker_type_filter",
    "data.field_reference_picker_search",
    "screens.reference_picker_list",
    "screens.reference_picker_type_filter",
    "screens.reference_picker_search",
  ];

  function textsOf(template: RequirementTemplateId): string[] {
    return generateRequirementsDoc(dataRoot, APP_ID)
      .statements.filter((statement) => statement.template === template)
      .map((statement) => statement.text);
  }

  test("A1: テンプレートは 107 → 113 になる(6本ちょうど。7本目を足していない)", () => {
    const ids = Object.keys(REQUIREMENT_TEMPLATES);
    // **【`V7-M6-T03` / `Z-G28` で 113 → 125 に更新した】** **旧: `toHaveLength(113)`。**
    // **本 ADR(`ADR-0291`)の増分ではない** —— 増えたのはアクセス権管理の宣言の12本で
    // あり、参照項目の選び方の6本は1本も動いていない(下の2行がそれを別々に固定している)。
    // **【`V8-M20` / 台帳 `J-G27` / `J-G28` / `ADR-0301` で 125 → 122 に更新した】**
    // **旧: `toHaveLength(125)`。** **本 ADR(`ADR-0291`)の増分ではない** ——
    // 撤去されたのは `ADR-0126` A1 の3本であり、参照項目の選び方の6本は1本も動いていない。
    // **【`V8-M22` / 台帳 `J-G34a` / ユーザ決定 `D-V8-36` / `ADR-0315` で 122 → 136 に更新した】**
    // **旧: `toHaveLength(122)`。** **本 ADR の増分ではない** —— 増えたのは役割を述べる
    // 14本であり、この test が固定している本数は1本も動いていない(下の行が別に固定する)。
    // **【`V8-M26` / 台帳 `D-V8-70`(2026-08-11)で 136 → 137 に更新した】**
    // **旧: `toHaveLength(136)`。** **増えたのは葉の3種目を述べる
    // `features.role_condition_is_empty` の1本ちょうどである**(減った本数・改名は0)。
    // **この test が固定している本数はこの1本ぶんしか動いていない。**
    // **【`V8-M13-T03` / 台帳 `Q-G31a` / `Q-G31b` で 137 → 149 に更新した】**
    // **旧: `toHaveLength(137)`。** **増えたのは集計表の中身を述べる12本ちょうどである。**
    // **本 ADR の増分ではない。**
    expect(ids).toHaveLength(149);
    for (const template of NEW_TEMPLATES) {
      expect(ids).toContain(template);
    }
    // **`reference_picker` を名に持つのは6本ちょうど**(3値 × 2箇所)。
    expect(ids.filter((id) => id.includes("reference_picker"))).toHaveLength(6);
    // **`reference_search_fields` を名に持つテンプレートは1本も無い**(`D-V6-21`)。
    expect(ids.filter((id) => id.includes("reference_search"))).toHaveLength(0);
  });

  test("A2: 書いていないアプリでは、足した6本が1文も出ない(既定値を推測しない)", () => {
    seedBase();
    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    const used = new Set(doc.statements.map((statement) => statement.template));
    for (const template of NEW_TEMPLATES) {
      expect(`${template}:${String(used.has(template))}`).toBe(`${template}:false`);
    }
    // **書かなかった参照項目について「一覧から選ぶ」と述べていない** ——
    // それは表示層の既定であって、アプリの宣言ではない。
    expect(doc.markdown).not.toContain("参照先の選び方");
  });

  test("A3: 項目に書いた選び方が1文になる(3値それぞれ別の文)", () => {
    seedBase();
    apply({
      diff_id: "d-291a",
      intent: "タグの選び方を、別の面を開いて探す形にする",
      operations: [
        {
          op: "change_field",
          table: "books",
          field: "tag",
          changes: { reference_picker: "search" },
        },
      ],
    });
    expect(textsOf("data.field_reference_picker_search")).toEqual([
      "テーブル `books` のフィールド `tag` は、参照先の選び方として別の面を開いて探す形を宣言している。",
    ]);
    // **他の2値の文は1件も出ない**(3値を1つの文に丸めていないことの実測)。
    expect(textsOf("data.field_reference_picker_list")).toEqual([]);
    expect(textsOf("data.field_reference_picker_type_filter")).toEqual([]);

    // 書き換えると文も入れ替わる(`change_field` が値を運ぶことの実測)。
    apply({
      diff_id: "d-291b",
      intent: "タグの選び方を、打った文字で絞る形に変える",
      operations: [
        {
          op: "change_field",
          table: "books",
          field: "tag",
          changes: { reference_picker: "type_filter" },
        },
      ],
    });
    expect(textsOf("data.field_reference_picker_search")).toEqual([]);
    expect(textsOf("data.field_reference_picker_type_filter")).toEqual([
      "テーブル `books` のフィールド `tag` は、参照先の選び方として打った文字で候補を絞る形を宣言している。",
    ]);
  });

  test("A4: 入力画面に書いた上書きが項目ごとに1文になる(項目側とは別の文)", () => {
    seedBase();
    apply({
      diff_id: "d-291c",
      intent: "項目は一覧から選ぶ形、入力画面だけ別の面を開いて探す形にする",
      operations: [
        { op: "change_field", table: "books", field: "tag", changes: { reference_picker: "list" } },
        {
          op: "update_view",
          view: "book-form",
          changes: { reference_pickers: { tag: "search" } },
        },
      ],
    });
    // **項目側と画面側は別の文である** —— 同じ文にすると、どちらが効くかが読めなくなる。
    expect(textsOf("data.field_reference_picker_list")).toEqual([
      "テーブル `books` のフィールド `tag` は、参照先の選び方として一覧から選ぶ形を宣言している。",
    ]);
    expect(textsOf("screens.reference_picker_search")).toEqual([
      "画面 `book-form` は、フィールド `tag` の参照先の選び方として別の面を開いて探す形を宣言している。",
    ]);
    // **優先順位そのものは1文も述べない** —— 述べるのは「そう宣言している」までである。
    expect(generateRequirementsDoc(dataRoot, APP_ID).markdown).not.toContain("優先");
  });

  test("A5: 出典が manifest の JSON Pointer で、選び方のキーを指している", () => {
    seedBase();
    apply({
      diff_id: "d-291d",
      intent: "選び方を項目と入力画面の両方に書く",
      operations: [
        { op: "change_field", table: "books", field: "tag", changes: { reference_picker: "list" } },
        {
          op: "update_view",
          view: "book-form",
          changes: { reference_pickers: { tag: "type_filter" } },
        },
      ],
    });
    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    const fieldStatement = doc.statements.find(
      (statement) => statement.template === "data.field_reference_picker_list",
    );
    // **先頭がマニフェストの出典で、続くのが帰属(どの差分が書いたか)である** ——
    // **既存の14キーとまったく同じ形であることを見る**(新しい出典の型を作っていない)。
    expect(fieldStatement?.sources[0]).toEqual({
      kind: "manifest",
      pointer: "/app/tables/0/fields/4/reference_picker",
    });
    const viewStatement = doc.statements.find(
      (statement) => statement.template === "screens.reference_picker_type_filter",
    );
    expect(viewStatement?.sources[0]).toEqual({
      kind: "manifest",
      pointer: "/app/views/1/reference_pickers/tag",
    });
  });

  test("A6: 探せる項目(reference_search_fields)は1文も出ない(D-V6-21。意図して出さない)", () => {
    seedBase();
    apply({
      diff_id: "d-291e",
      intent: "候補の照合先をテーブル側と項目側の両方に書く",
      operations: [
        {
          op: "change_table",
          table: "tags",
          changes: { reference_search_fields: ["label"] },
        },
        {
          op: "change_field",
          table: "books",
          field: "tag",
          changes: { reference_search_fields: ["label"] },
        },
      ],
    });
    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    // **書かれていることの前提を先に固定する**(宣言が入っていないのに0文なら意味が無い)。
    const manifest = JSON.parse(
      readFileSync(join(dataRoot, "apps", APP_ID, "manifest.json"), "utf-8"),
    ) as { app: { tables: { id: string; reference_search_fields?: string[] }[] } };
    expect(
      manifest.app.tables.find((table) => table.id === "tags")?.reference_search_fields,
    ).toEqual(["label"]);
    // **それでも1文も出ない。** **これは書き忘れではなく決定である**(`D-V6-21`)。
    expect(doc.markdown).not.toContain("打った文字を照合");
    expect(doc.markdown).not.toContain("探せる");
    expect(
      doc.statements.filter((statement) => statement.template.includes("reference_search")),
    ).toHaveLength(0);
    // **`representative_field` も今日どおり1文も出ない**(合わせる先の作法)。
    expect(doc.markdown).not.toContain("代表");
  });

  test("A7: 文面は「宣言している」までしか述べない(保証も器の名前も1文字も述べない)", () => {
    for (const template of NEW_TEMPLATES) {
      const body = REQUIREMENT_TEMPLATES[template];
      for (const forbidden of [
        "小窓",
        "ポップアップ",
        "モーダル",
        "ダイアログ",
        "絞り込める",
        "開く",
        "安全",
      ]) {
        expect(`${template}:${body}`).not.toContain(forbidden);
      }
    }
  });

  test("A8: src/kernel/ に新しい export を1本も足していない(K-G21b 限定3。Δ8 を空に保つ)", () => {
    // **語彙グループも増やしていない**(`ADR-0144` §3a の 3 の門に当たらない)——
    // 3値のそれぞれに1本ずつテンプレートを置く形を採ったためである。
    const source = readFileSync(join(import.meta.dir, "requirements-doc.ts"), "utf-8");
    expect(source).toContain("const REFERENCE_PICKER_FIELD_TEMPLATES");
    expect(source).not.toContain("export const REFERENCE_PICKER_FIELD_TEMPLATES");
    expect(source).toContain("const REFERENCE_PICKER_VIEW_TEMPLATES");
    expect(source).not.toContain("export const REFERENCE_PICKER_VIEW_TEMPLATES");
    // **`VOCABULARIES` は19件のままである**(20件目を作っていない)。
    expect(source).not.toContain("reference_picker: REFERENCE_PICKERS");
  });
});

/**
 * **`V7-M6-T03`。`Z-G28`(門A / 判定 = 限定採用)。`V7-M0` §6-3 の `Z-G28` の節。**
 *
 * **`access_control` を宣言した表について、その宣言が要件ドキュメントに文章として出る。**
 *
 * **【`Z-G28` の限定を、この describe が測る形にしたもの】**
 * 1. **出すのは宣言だけである** —— **付与の行の中身を1文字も出さない**(`A3` が
 *    実際に付与の行を作った状態で測る)。
 * 2. **出すのは4項目に閉じる** —— (a) この表がアクセス権管理を使うこと /
 *    (b) 権限名とその読む・書く・消すの組 / (c) 付与表・メンバー表・グループ表の名前 /
 *    (d) `inherit_from` の参照項目の名前。**5項目目を足さない**(`A6` が測る)。
 * 3. **`src/kernel/` の公開エクスポートを1つも増やさない**(判定は
 *    `scripts/kernel-export-drift.test.ts`。ここでは `A7` が「新しい `export` の字面が
 *    1つも無い」ことを測る)。
 * 4. **宣言していない表・`enabled: false` の表では生成物が1バイトも変わらない**(`A4`)。
 *
 * **【この describe が主張していないこと。丸めない】**
 * - **要件ドキュメントを読んでも「誰がどの行を見られるか」は分からない。** 出るのは
 *   **宣言**だけであり、**実際の付与は行の中にある**(そして行の中身は1文字も出ない)。
 * - **宣言と実際のふるまいが一致することを1文も検査していない** —— 判定は HTTP の
 *   経路にだけ在り、MCP・受信口・ワークフロー・島は宣言を1つも見ない(`V7-M6-T01` の実測)。
 * - **`creator_permission`(行を作った人に自動で与える権限名)は1文も出ない** ——
 *   **4項目に閉じるという限定 (2) の帰結である。書き忘れではない。**
 */
describe("V7-M6-T03: Z-G28 —— アクセス権管理の宣言が要件ドキュメントに現れる", () => {
  /** **足したのは12本ちょうど**(13本目を足さない)。 */
  const NEW_TEMPLATES: readonly RequirementTemplateId[] = [
    "data.table_access_control",
    "data.table_access_permission",
    "data.table_access_permission_read",
    "data.table_access_permission_no_read",
    "data.table_access_permission_write",
    "data.table_access_permission_no_write",
    "data.table_access_permission_delete",
    "data.table_access_permission_no_delete",
    "data.table_access_grant_table",
    "data.table_access_member_table",
    "data.table_access_group_table",
    "data.table_access_inherit_from",
  ];

  /** 宣言が規約どおりに書ける形の7表(保護対象2・付与2・利用者・グループ・素の表)。 */
  function seedGrantShop(): void {
    apply({
      diff_id: "d-701",
      intent: "案件・付与・利用者・グループ・書庫・メモの表を用意する",
      operations: [
        {
          op: "add_table",
          table: {
            id: "groups",
            name: "グループ",
            fields: [{ id: "label", name: "名前", type: "text", required: true }],
          },
        },
        {
          op: "add_table",
          table: {
            id: "member",
            name: "利用者",
            fields: [
              { id: "account", name: "ログイン", type: "text" },
              { id: "belongs_to", name: "所属", type: "reference", reference_table: "groups" },
            ],
          },
        },
        {
          op: "add_table",
          table: {
            id: "project",
            name: "案件",
            fields: [
              { id: "title", name: "件名", type: "text", required: true },
              { id: "parent", name: "親案件", type: "reference", reference_table: "project" },
            ],
          },
        },
        {
          op: "add_table",
          table: {
            id: "project_grant",
            name: "案件の付与",
            fields: [
              { id: "target", name: "案件", type: "reference", reference_table: "project" },
              { id: "member", name: "利用者", type: "reference", reference_table: "member" },
              { id: "team", name: "グループ", type: "reference", reference_table: "groups" },
              { id: "permission", name: "権限", type: "select", options: ["reader", "writer"] },
            ],
          },
        },
        {
          op: "add_table",
          table: {
            id: "archive",
            name: "書庫",
            fields: [
              { id: "body", name: "本文", type: "long_text" },
              { id: "done", name: "完了", type: "boolean" },
            ],
          },
        },
        {
          op: "add_table",
          table: {
            id: "archive_grant",
            name: "書庫の付与",
            fields: [
              { id: "target", name: "書庫", type: "reference", reference_table: "archive" },
              { id: "member", name: "利用者", type: "reference", reference_table: "member" },
              { id: "permission", name: "権限", type: "select", options: ["reader"] },
            ],
          },
        },
        {
          op: "add_table",
          table: {
            id: "note",
            name: "メモ",
            fields: [
              { id: "body", name: "本文", type: "long_text" },
              { id: "done", name: "完了", type: "boolean" },
            ],
          },
        },
        {
          op: "add_view",
          view: { id: "project-form", type: "form", table: "project", fields: ["title"] },
        },
      ],
    });
  }

  /** `project` に**有効な**宣言を、`archive` に **`enabled: false`** の宣言を書く。 */
  function declareAccessControl(): void {
    apply({
      diff_id: "d-702",
      intent: "案件でアクセス権管理を使う。書庫は設定だけ書いて有効にしない",
      operations: [
        {
          op: "change_table",
          table: "project",
          changes: {
            access_control: {
              enabled: true,
              permissions: [
                { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
                { id: "writer", name: "編集可", read: true, write: true, delete: true },
                // **読めないが書ける権限**を1件置く —— **否定側の3本
                // (`_no_read` / `_no_write` / `_no_delete`)が実際に使われることを
                // 測るためである**(真偽を1文に丸めていないことの実測)。
                { id: "submitter", name: "投函のみ", read: false, write: true, delete: false },
              ],
              creator_permission: "writer",
              grant: {
                table: "project_grant",
                target: "target",
                member: "member",
                group: "team",
                permission: "permission",
              },
              members: { table: "member", account: "account", group: "belongs_to" },
              groups: { table: "groups" },
              inherit_from: ["parent"],
            },
          },
        },
        {
          op: "change_table",
          table: "archive",
          changes: {
            access_control: {
              enabled: false,
              permissions: [
                { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
              ],
              creator_permission: "reader",
              grant: {
                table: "archive_grant",
                target: "target",
                member: "member",
                permission: "permission",
              },
              members: { table: "member", account: "account" },
            },
          },
        },
      ],
    });
  }

  /** その表について出た記述の本文(出典の JSON Pointer で表を選ぶ)。 */
  function textsOfTable(doc: RequirementsDoc, tableIndex: number): string[] {
    return doc.statements
      .filter((statement) => {
        const first = statement.sources[0];
        return (
          statement.section === "data" &&
          first.kind === "manifest" &&
          (first.pointer === `/app/tables/${tableIndex}` ||
            first.pointer.startsWith(`/app/tables/${tableIndex}/`))
        );
      })
      .map((statement) => statement.text);
  }

  function tableIndexOf(manifest: Manifest, tableId: string): number {
    const index = manifest.app.tables.findIndex((table) => table.id === tableId);
    if (index === -1) {
      throw new Error(`テーブル ${tableId} がありません。`);
    }
    return index;
  }

  test("A1: テンプレートは 113 → 125 になる(12本ちょうど。13本目を足していない)", () => {
    const ids = Object.keys(REQUIREMENT_TEMPLATES);
    // **【`V8-M20` / 台帳 `J-G27` / `J-G28` / `ADR-0301` で 125 → 122 に更新した】**
    // **旧: `toHaveLength(125)`。** **本 ADR(`Z-G28`)の増分ではない** ——
    // 撤去されたのは `ADR-0126` A1 の3本であり、アクセス権管理の12本は1本も動いていない
    // (下の1行がそれを別に固定している)。**テスト名の「113 → 125」は当時の逐語であり、
    // 書き換えていない。**
    // **【`V8-M22` / 台帳 `J-G34a` / ユーザ決定 `D-V8-36` / `ADR-0315` で 122 → 136 に更新した】**
    // **旧: `toHaveLength(122)`。** **本 ADR の増分ではない** —— 増えたのは役割を述べる
    // 14本であり、この test が固定している本数は1本も動いていない(下の行が別に固定する)。
    // **【`V8-M26` / 台帳 `D-V8-70`(2026-08-11)で 136 → 137 に更新した】**
    // **旧: `toHaveLength(136)`。** **増えたのは葉の3種目を述べる
    // `features.role_condition_is_empty` の1本ちょうどである**(減った本数・改名は0)。
    // **この test が固定している本数はこの1本ぶんしか動いていない。**
    // **【`V8-M13-T03` / 台帳 `Q-G31a` / `Q-G31b` で 137 → 149 に更新した】**
    // **旧: `toHaveLength(137)`。** **増えたのは集計表の中身を述べる12本ちょうどである。**
    // **本 ADR の増分ではない。**
    expect(ids).toHaveLength(149);
    for (const template of NEW_TEMPLATES) {
      expect(ids).toContain(template);
    }
    // **`table_access` を名に持つのは12本ちょうどである。**
    expect(ids.filter((id) => id.includes("table_access"))).toHaveLength(12);
  });

  test("A2: 宣言した表について4項目が逐語で出る(a: 使うこと / b: 権限名と3つの組 / c: 3つの表の名前 / d: 親を辿る項目)", () => {
    seedGrantShop();
    declareAccessControl();
    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    const texts = new Set(doc.statements.map((statement) => statement.text));

    // (a) この表がアクセス権管理を使うこと。
    expect(texts).toContain("テーブル `project` は、この表でアクセス権管理を使うと宣言している。");

    // (b) 権限名と、その読む / 書く / 消すの組。**権限名は逐語引用のブロックに出る。**
    expect(texts).toContain(
      "テーブル `project` の `1` 番目の権限名は次のとおり記録されている:\n> reader",
    );
    expect(texts).toContain("テーブル `project` の `1` 番目の権限は、行を読めると宣言している。");
    expect(texts).toContain(
      "テーブル `project` の `1` 番目の権限は、行を書き換えられないと宣言している。",
    );
    expect(texts).toContain("テーブル `project` の `1` 番目の権限は、行を消せないと宣言している。");
    expect(texts).toContain(
      "テーブル `project` の `2` 番目の権限名は次のとおり記録されている:\n> writer",
    );
    expect(texts).toContain("テーブル `project` の `2` 番目の権限は、行を読めると宣言している。");
    expect(texts).toContain(
      "テーブル `project` の `2` 番目の権限は、行を書き換えられると宣言している。",
    );
    expect(texts).toContain("テーブル `project` の `2` 番目の権限は、行を消せると宣言している。");
    expect(texts).toContain(
      "テーブル `project` の `3` 番目の権限名は次のとおり記録されている:\n> submitter",
    );
    expect(texts).toContain("テーブル `project` の `3` 番目の権限は、行を読めないと宣言している。");
    expect(texts).toContain(
      "テーブル `project` の `3` 番目の権限は、行を書き換えられると宣言している。",
    );
    expect(texts).toContain("テーブル `project` の `3` 番目の権限は、行を消せないと宣言している。");

    // (c) 付与表・メンバー表・グループ表の名前。
    expect(texts).toContain(
      "テーブル `project` は、誰にどの行をどの権限で渡したかをテーブル `project_grant` に記録すると宣言している。",
    );
    expect(texts).toContain(
      "テーブル `project` は、利用者をテーブル `member` に記録すると宣言している。",
    );
    expect(texts).toContain(
      "テーブル `project` は、グループをテーブル `groups` に記録すると宣言している。",
    );

    // (d) `inherit_from` の参照項目の名前。
    expect(texts).toContain(
      "テーブル `project` は、`1` 番目の親を辿る項目としてフィールド `parent` を宣言している。",
    );

    // **12本すべてが実際に使われている**(3本は否定側なので、上の8本と合わせて12本)。
    const used = new Set(doc.statements.map((statement) => statement.template));
    for (const template of NEW_TEMPLATES) {
      expect(`${template}:${String(used.has(template))}`).toBe(`${template}:true`);
    }
  });

  test("A3: 付与の行の中身が1文字も出ない(実際に付与の行を作った状態で測る)", () => {
    seedGrantShop();
    declareAccessControl();
    const manifest = readCurrentManifest(dataRoot, APP_ID);
    const db = new Database(appDbPath(dataRoot, APP_ID));
    try {
      const created = <T extends { _id: string }>(result: {
        ok: boolean;
        value?: unknown;
        errors?: unknown;
      }): T => {
        if (!result.ok) {
          throw new Error(`行の作成に失敗しました: ${JSON.stringify(result.errors)}`);
        }
        return result.value as T;
      };
      const group = created<{ _id: string }>(
        createRecord(db, manifest, "groups", { label: "ヒミツ班" }),
      );
      const person = created<{ _id: string }>(
        createRecord(db, manifest, "member", {
          account: "himitsu-account@example.invalid",
          belongs_to: group._id,
        }),
      );
      const project = created<{ _id: string }>(
        createRecord(db, manifest, "project", { title: "ヒミツ案件" }),
      );
      const grantRow = created<{ _id: string }>(
        createRecord(db, manifest, "project_grant", {
          target: project._id,
          member: person._id,
          team: group._id,
          permission: "writer",
        }),
      );

      const doc = generateRequirementsDoc(dataRoot, APP_ID);
      // **付与の行の中身(誰に・どの行を・どの権限で渡したか)が1文字も出ていない。**
      for (const value of [
        "ヒミツ班",
        "himitsu-account@example.invalid",
        "ヒミツ案件",
        group._id,
        person._id,
        project._id,
        grantRow._id,
      ]) {
        expect(doc.markdown.includes(value)).toBe(false);
      }
      // **宣言のほうは出ている**(0件で緑になる検査にしない)。
      expect(doc.markdown).toContain(
        "テーブル `project` は、この表でアクセス権管理を使うと宣言している。",
      );
    } finally {
      db.close();
    }
  });

  test("A4: 宣言していない表・enabled: false の表の生成物が1バイトも変わらない(同じアプリの中で並べる)", () => {
    seedGrantShop();
    const before = generateRequirementsDoc(dataRoot, APP_ID);
    const beforeManifest = readCurrentManifest(dataRoot, APP_ID);
    const noteIndex = tableIndexOf(beforeManifest, "note");
    const archiveIndex = tableIndexOf(beforeManifest, "archive");
    const noteBefore = textsOfTable(before, noteIndex);
    const archiveBefore = textsOfTable(before, archiveIndex);

    declareAccessControl();
    const after = generateRequirementsDoc(dataRoot, APP_ID);
    const afterManifest = readCurrentManifest(dataRoot, APP_ID);
    // 表の位置が動いていないことを先に固定する(位置が動くと比較が意味を失う)。
    expect(tableIndexOf(afterManifest, "note")).toBe(noteIndex);
    expect(tableIndexOf(afterManifest, "archive")).toBe(archiveIndex);

    // **宣言していない表(note)は1バイトも変わらない。**
    expect(textsOfTable(after, noteIndex)).toEqual(noteBefore);
    // **`enabled: false` の表(archive)も1バイトも変わらない。**
    expect(textsOfTable(after, archiveIndex)).toEqual(archiveBefore);

    // **前提の固定**: `enabled: false` の宣言がマニフェストに実在している
    // (書かれていないのに0文なら、この検査は何も測っていない)。
    const archive = afterManifest.app.tables[archiveIndex];
    expect(archive?.access_control?.enabled).toBe(false);
    expect(archive?.access_control?.grant.table).toBe("archive_grant");

    // **同じ形の2表を並べる** —— `enabled: false` の表の出力は、宣言していない表の出力と
    // 表IDの綴りを除いて完全に一致する。
    expect(archiveBefore.map((text) => text.replaceAll("`archive`", "`note`"))).toEqual(
      noteBefore.map((text) => text.replaceAll("「メモ」", "「書庫」")),
    );

    // **12本のどれも、この2表については1文も出ていない。**
    for (const statement of after.statements) {
      if (!(NEW_TEMPLATES as readonly string[]).includes(statement.template)) {
        continue;
      }
      const first = statement.sources[0];
      expect(first.kind === "manifest" ? first.pointer : "").toContain(
        `/app/tables/${tableIndexOf(afterManifest, "project")}/access_control`,
      );
    }
  });

  test("A5: 同じマニフェストから2回生成して1バイトも違わない(決定論。ADR-0025 §6)", () => {
    seedGrantShop();
    declareAccessControl();
    const first = generateRequirementsDoc(dataRoot, APP_ID);
    const second = generateRequirementsDoc(dataRoot, APP_ID);
    expect(second.markdown).toBe(first.markdown);
    expect(JSON.stringify(second.statements)).toBe(JSON.stringify(first.statements));
    expect(JSON.stringify(second.identifiers)).toBe(JSON.stringify(first.identifiers));
  });

  test("A6: 4項目より多いことを書いていない(5項目目を足していない)", () => {
    seedGrantShop();
    declareAccessControl();
    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    // **`creator_permission`(行を作った人に自動で与える権限名)は1文も出ない。**
    expect(doc.markdown).not.toContain("作った人");
    // **付与表・利用者表・グループ表の「どの列が何を表すか」は1文も出ない**
    // ((c) は**表の名前だけ**である)。**列のIDは項目の宣言(`data.field`)としては
    // 今日どおり出るので、測る対象は足した12本の本文に限る。**
    const declared = doc.statements
      .filter((statement) => (NEW_TEMPLATES as readonly string[]).includes(statement.template))
      .map((statement) => statement.text)
      .join("\n");
    expect(declared.length).toBeGreaterThan(0);
    for (const columnish of ["target", "belongs_to", "account", "team", "permission"]) {
      expect(`${columnish}:${String(declared.includes(columnish))}`).toBe(`${columnish}:false`);
    }
    // **人が読む権限名(`name`)は1文も出ない**(出るのは機械が使う名前だけである)。
    expect(doc.markdown).not.toContain("参照のみ");
    expect(doc.markdown).not.toContain("編集可");
    // **文面は「宣言している」までしか述べない** —— 保証も、守る経路の広さも述べない。
    for (const template of NEW_TEMPLATES) {
      const body = REQUIREMENT_TEMPLATES[template];
      for (const forbidden of ["安全", "守られ", "遮断", "できません", "見られません"]) {
        expect(`${template}:${body}`).not.toContain(forbidden);
      }
    }
  });

  test("A7: src/kernel/ に新しい export を1本も足していない(Z-G28 限定3。Δ8 を空に保つ)", () => {
    const source = readFileSync(join(import.meta.dir, "requirements-doc.ts"), "utf-8");
    // **語彙グループも識別子グループも増やしていない** —— 権限名は逐語引用で写し、
    // 読む / 書く / 消すの3つは真偽それぞれ1本のテンプレートで表したためである。
    expect(source).not.toContain("permission_name");
    expect(source).not.toContain("access_permission: ");
    // **新しい `export` の字面が1つも無いこと**(判定の正は `kernel-export-drift.test.ts`)。
    expect(source).not.toContain("export const ACCESS_CONTROL");
    expect(source).not.toContain("export function accessControlStatements");
  });

  test("A8: 出典が manifest の JSON Pointer で、宣言のキーを指している", () => {
    seedGrantShop();
    declareAccessControl();
    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    const manifest = readCurrentManifest(dataRoot, APP_ID);
    const base = `/app/tables/${tableIndexOf(manifest, "project")}/access_control`;
    const pointerOf = (template: RequirementTemplateId): string | undefined => {
      const found = doc.statements.find((statement) => statement.template === template);
      const first = found?.sources[0];
      return first?.kind === "manifest" ? first.pointer : undefined;
    };
    expect(pointerOf("data.table_access_control")).toBe(`${base}/enabled`);
    expect(pointerOf("data.table_access_permission")).toBe(`${base}/permissions/0`);
    expect(pointerOf("data.table_access_permission_read")).toBe(`${base}/permissions/0/read`);
    expect(pointerOf("data.table_access_grant_table")).toBe(`${base}/grant/table`);
    expect(pointerOf("data.table_access_member_table")).toBe(`${base}/members/table`);
    expect(pointerOf("data.table_access_group_table")).toBe(`${base}/groups/table`);
    expect(pointerOf("data.table_access_inherit_from")).toBe(`${base}/inherit_from/0`);
  });
});

/**
 * **`V8-M22`。台帳 `J-G34a`(門A / 判定 = 限定採用)/ ユーザ決定 `D-V8-36`(2026-08-10)。**
 *
 * **`app.roles`(役割と、その役割ができること)が要件ドキュメントに文章として出る。**
 *
 * **【誰が「出す」と決めたのか】** **決めたのは 2026-08-10 のユーザである**
 * (`docs/plan/v8/03-user-decisions.md` §4e の `D-V8-36`。**選ばれた見出しの逐語 =
 * 「役割と、できることまで載せる」**)。
 * **【禁止】これを「`V8-M15` の判定どおり」と書かない** —— **`V8-M15` は出すか出さないかを
 * 決めていない**(台帳 `J-G34a` の限定が「9キー目を出すか出さないかを決めるのは本単位である」
 * と書き、`V8-M16`〜`V8-M18` の3本の記録が裁定 `N-1` に倒して `V8-M22` へ申し送っていた)。
 *
 * **【出す範囲。決定の射程を1ミリも超えない】**
 * 1. **役割の名前**(`id` と `name`)。
 * 2. **その役割ができること**(`rules` の 対象4種 × 動詞3語)。
 * 3. **条件(`when`)があるときはその条件**(かつ / または / でない / 「この項目が◯◯」/
 *    「この項目が自分」)。
 *
 * **【出さないもの】** **役割の付与状況(誰がその役割を持っているか)は1文字も出さない**
 * —— **それはアプリの定義ではなく利用者のデータである**(`_auth_users.role` の行の中身)。
 * **`R4` が、出典が `/app/roles` の外を1件も指していないことで測る。**
 *
 * **【この describe が主張していないこと。丸めない】**
 * - **宣言と実際のふるまいが一致することを1文も検査していない。** 出るのは**宣言**だけである。
 * - **面(役割の規則)と点(`access_control` の付与)がどう重なるかを1文も出さない。**
 * - **既定の3役割(`owner` / `editor` / `viewer`)は `create_app` が必ず書き込むので、
 *   `set_roles` を1度も呼んでいないアプリの生成物も本タスクで変わる**(`R8` が測る)。
 */
describe("V8-M22: J-G34a —— 役割とできることが要件ドキュメントに現れる", () => {
  /** **足したのは14本ちょうど**(15本目を足さない)。 */
  const ROLE_TEMPLATES: readonly RequirementTemplateId[] = [
    "features.role",
    "features.role_name",
    "features.role_rule_table_read",
    "features.role_rule_table_write",
    "features.role_rule_table_delete",
    "features.role_rule_field_read",
    "features.role_rule_field_write",
    "features.role_rule_view_read",
    "features.role_rule_action_read",
    "features.role_condition_and",
    "features.role_condition_or",
    "features.role_condition_not",
    "features.role_condition_equals",
    "features.role_condition_equals_current_user",
    // **【`V8-M26` / ユーザ決定 `D-V8-70`(2026-08-11)。上の「**足したのは14本ちょうど**」は
    // 今日は 15本である。旧の字面を1バイトも消していない】** **葉の3種目(その項目が空か)。**
    // **`V8-M22` が足した本数は今日も 14本のままで、15本目を足したのは `V8-M26` である。**
    "features.role_condition_is_empty",
  ];

  /** `src/kernel/requirements-doc.ts` の union をソースのテキストから数える。 */
  function unionMembersOf(name: string): string[] {
    const source = readFileSync(join(import.meta.dir, "requirements-doc.ts"), "utf-8");
    const start = source.indexOf(`export type ${name} =`);
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf(";", start));
    return [...body.matchAll(/\|\s*"([a-z_]+)"/g)].map((match) => match[1] ?? "");
  }

  /** 表2・画面2(ボタン付き)を用意する。 */
  function seedOrderShop(): void {
    apply({
      diff_id: "d-801",
      intent: "注文と会員の表、注文の一覧・入力画面を用意する",
      operations: [
        {
          op: "add_table",
          table: {
            id: "orders",
            name: "注文",
            fields: [
              { id: "title", name: "件名", type: "text", required: true },
              { id: "status", name: "状態", type: "select", options: ["進行中", "完了"] },
              { id: "assignee", name: "担当", type: "text" },
              { id: "secret_memo", name: "社内メモ", type: "long_text" },
            ],
          },
        },
        {
          op: "add_table",
          table: {
            id: "members",
            name: "会員",
            fields: [{ id: "nickname", name: "呼び名", type: "text", required: true }],
          },
        },
        {
          op: "add_view",
          view: { id: "order-form", type: "form", table: "orders", fields: ["title", "status"] },
        },
        {
          op: "add_view",
          view: {
            id: "order-detail",
            type: "detail_view",
            table: "orders",
            fields: ["title", "status"],
            actions: [{ id: "to_form", set: { field: "status", value: "完了" } }],
          },
        },
      ],
    });
  }

  /** 既定3本 + 役割2本(`member` / `staff`)。条件つきの規則を1本持たせる。 */
  function declareRoles(): void {
    apply({
      diff_id: "d-802",
      intent: "会員と担当者の役割を宣言する",
      operations: [
        {
          op: "set_roles",
          roles: [
            {
              id: "owner",
              name: "持ち主",
              rules: [
                // **【`V8-M28` / `T-G16a`】持ち主にはこの2行が必ず要る**(適用時検査 = 類型17 の拡張)。
                { target: "app", can: ["write"] },
                { target: "role", can: ["write"] },
              ],
            },
            { id: "editor", name: "編集者" },
            { id: "viewer", name: "閲覧者" },
            {
              id: "member",
              name: "会員",
              rules: [
                { target: "table", table: "orders", can: ["read", "write"] },
                { target: "view", view: "order-detail", can: ["read"] },
                { target: "action", view: "order-detail", action: "to_form", can: ["read"] },
              ],
            },
            {
              id: "staff",
              name: "担当者",
              rules: [
                {
                  target: "table",
                  table: "orders",
                  can: ["read", "write", "delete"],
                  when: {
                    and: [
                      { field: "status", equals: "進行中" },
                      { field: "assignee", equals_current_user: true },
                    ],
                  },
                },
                {
                  target: "field",
                  table: "orders",
                  field: "secret_memo",
                  can: ["read"],
                  when: { not: { field: "status", equals: "完了" } },
                },
                {
                  target: "field",
                  table: "orders",
                  field: "title",
                  can: ["write"],
                  when: {
                    or: [
                      { field: "status", equals: "進行中" },
                      { field: "assignee", equals_current_user: true },
                    ],
                  },
                },
                // **【`V8-M26` / ユーザ決定 `D-V8-70`(2026-08-11)】葉の3種目を1本使う。**
                // **`R3` が「足したテンプレートが1本残らず実際に使われている」を測るので、
                // 使わないテンプレートを足すと 0件 で緑になる検査が生まれる。**
                // **題材は「担当が空の行(まだ誰も持っていない注文)」である。**
                {
                  target: "field",
                  table: "orders",
                  field: "secret_memo",
                  can: ["write"],
                  when: { field: "assignee", is_empty: true },
                },
              ],
            },
          ],
        },
      ],
    });
  }

  // --- R1: 本数 ---------------------------------------------------------------------

  test("R1: テンプレートは 122 → 136 になる(14本ちょうど。15本目を足していない)", () => {
    const ids = Object.keys(REQUIREMENT_TEMPLATES);
    // **【`V8-M26` / 台帳 `D-V8-70`(2026-08-11)で 136 → 137 に更新した】**
    // **旧: `toHaveLength(136)`。** **増えたのは葉の3種目を述べる
    // `features.role_condition_is_empty` の1本ちょうどである**(減った本数・改名は0)。
    // **この test が固定している本数はこの1本ぶんしか動いていない。**
    // **【`V8-M13-T03` / 台帳 `Q-G31a` / `Q-G31b` で 137 → 149 に更新した】**
    // **旧: `toHaveLength(137)`。** **増えたのは集計表の中身を述べる12本ちょうどである。**
    // **本 ADR の増分ではない。**
    expect(ids).toHaveLength(149);
    for (const template of ROLE_TEMPLATES) {
      expect(ids).toContain(template);
    }
    // **`features.role` で始まるのは14本ちょうどである。**
    // **【`V8-M26` / ユーザ決定 `D-V8-70`(2026-08-11)で 14 → 15 に更新した】**
    // **旧: `toHaveLength(14)`。** **増えたのは `features.role_condition_is_empty` の1本
    // ちょうどで、減った本数・改名は0である。** **直前の1行の字面は1バイトも消していない。**
    expect(ids.filter((id) => id.startsWith("features.role"))).toHaveLength(15);
  });

  // --- R2: 役割の名前とできることが逐語で出る ------------------------------------------

  test("R2: 役割の名前と、その役割ができることが逐語で出る", () => {
    seedOrderShop();
    declareRoles();
    const texts = new Set(generateRequirementsDoc(dataRoot, APP_ID).statements.map((s) => s.text));

    // 1. 役割の名前(`id` と `name`)。
    expect(texts).toContain("このアプリは役割 `member` を持つ。");
    expect(texts).toContain("役割 `member` の表示名は 「会員」 である。");
    expect(texts).toContain("このアプリは役割 `staff` を持つ。");
    expect(texts).toContain("役割 `staff` の表示名は 「担当者」 である。");

    // 2. できること(対象4種 × 動詞3語)。
    expect(texts).toContain(
      "役割 `member` の `1` 番目の規則は、テーブル `orders` の行を読めると宣言している。",
    );
    expect(texts).toContain(
      "役割 `member` の `1` 番目の規則は、テーブル `orders` の行を書き換えられると宣言している。",
    );
    expect(texts).toContain(
      "役割 `member` の `2` 番目の規則は、画面 `order-detail` を見られると宣言している。",
    );
    expect(texts).toContain(
      "役割 `member` の `3` 番目の規則は、画面 `order-detail` のボタン `to_form` を使えると宣言している。",
    );
    expect(texts).toContain(
      "役割 `staff` の `1` 番目の規則は、テーブル `orders` の行を消せると宣言している。",
    );
    expect(texts).toContain(
      "役割 `staff` の `2` 番目の規則は、テーブル `orders` のフィールド `secret_memo` を読めると宣言している。",
    );
    expect(texts).toContain(
      "役割 `staff` の `3` 番目の規則は、テーブル `orders` のフィールド `title` を書き換えられると宣言している。",
    );
  });

  // --- R3: 条件が文章になる -----------------------------------------------------------

  test("R3: 条件(かつ / または / でない / この項目が◯◯ / この項目が自分)が文章になる", () => {
    seedOrderShop();
    declareRoles();
    const texts = new Set(generateRequirementsDoc(dataRoot, APP_ID).statements.map((s) => s.text));

    // かつ + 葉2種(定数との等値 / 「自分」)。**前順で通し番号と深さを持つ。**
    expect(texts).toContain(
      "役割 `staff` の `1` 番目の規則の条件の `1` 番目の要素(深さ `0`)は、その下に続く条件をすべて満たす行にだけ当たる。",
    );
    expect(texts).toContain(
      "役割 `staff` の `1` 番目の規則の条件の `2` 番目の要素(深さ `1`)は、フィールド `status` の値が次と等しい行にだけ当たる:\n> 進行中",
    );
    expect(texts).toContain(
      "役割 `staff` の `1` 番目の規則の条件の `3` 番目の要素(深さ `1`)は、フィールド `assignee` の値が要求している人と等しい行にだけ当たる。",
    );
    // でない。
    expect(texts).toContain(
      "役割 `staff` の `2` 番目の規則の条件の `1` 番目の要素(深さ `0`)は、その下に続く条件を満たさない行にだけ当たる。",
    );
    // または。
    expect(texts).toContain(
      "役割 `staff` の `3` 番目の規則の条件の `1` 番目の要素(深さ `0`)は、その下に続く条件のいずれかを満たす行にだけ当たる。",
    );

    // **14本すべてが実際に使われている**(0件で緑になる検査にしない)。
    const used = new Set(
      generateRequirementsDoc(dataRoot, APP_ID).statements.map((s) => s.template),
    );
    for (const template of ROLE_TEMPLATES) {
      expect(`${template}:${String(used.has(template))}`).toBe(`${template}:true`);
    }
  });

  // --- R4: 付与状況(利用者のデータ)を1文字も出さない ----------------------------------

  test("R4: 出典は `/app/roles` の中だけを指す(誰がその役割を持っているかは1文字も出ない)", () => {
    seedOrderShop();
    declareRoles();
    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    const roleStatements = doc.statements.filter((statement) =>
      (ROLE_TEMPLATES as readonly string[]).includes(statement.template),
    );
    expect(roleStatements.length).toBeGreaterThan(0);
    for (const statement of roleStatements) {
      for (const source of statement.sources) {
        expect(source.kind).toBe("manifest");
        const pointer = source.kind === "manifest" ? source.pointer : "";
        expect(`${pointer}:${String(pointer.startsWith("/app/roles/"))}`).toBe(`${pointer}:true`);
      }
    }
    // **利用者の表(`_auth_users`)を1度も読んでいない** —— 生成器はマニフェストと
    // changelog しか読まない(`ADR-0025` §5 辺5)。**その字面が本文に1度も出ない。**
    const roleText = roleStatements.map((statement) => statement.text).join("\n");
    expect(roleText).not.toContain("_auth_users");
    expect(roleText).not.toContain("持っている");
  });

  // --- R5: 決定論 ---------------------------------------------------------------------

  test("R5: 同じマニフェストから2回生成して1バイトも違わない(ADR-0025 §6)", () => {
    seedOrderShop();
    declareRoles();
    const first = generateRequirementsDoc(dataRoot, APP_ID);
    const second = generateRequirementsDoc(dataRoot, APP_ID);
    expect(second.markdown).toBe(first.markdown);
    expect(JSON.stringify(second.statements)).toBe(JSON.stringify(first.statements));
    expect(JSON.stringify(second.identifiers)).toBe(JSON.stringify(first.identifiers));
  });

  // --- R6: 識別子グループ --------------------------------------------------------------

  test("R6: 識別子グループは 23 → 26 になる(role_id / role_name / view_action_id)", () => {
    expect(unionMembersOf("IdentifierGroup")).toHaveLength(26);
    seedOrderShop();
    declareRoles();
    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    expect(Object.keys(doc.identifiers)).toHaveLength(26);
    expect(doc.identifiers.role_id).toEqual(["editor", "member", "owner", "staff", "viewer"]);
    expect(doc.identifiers.role_name).toEqual(
      ["会員", "担当者", "持ち主", "編集者", "閲覧者"].sort(),
    );
    expect(doc.identifiers.view_action_id).toEqual(["to_form"]);
    // **語彙グループは19件のままである**(20件目を作っていない)。
    expect(unionMembersOf("VocabularyGroup")).toHaveLength(19);
  });

  // --- R7: 文面は「宣言している」までしか述べない ---------------------------------------

  test("R7: 14本の本文が保証を述べていない(宣言と判定を混ぜない)", () => {
    for (const template of ROLE_TEMPLATES) {
      const body = REQUIREMENT_TEMPLATES[template];
      for (const forbidden of ["安全", "守られ", "遮断", "できません", "見られません", "保証"]) {
        expect(`${template}:${body}`).not.toContain(forbidden);
      }
    }
  });

  // --- R8: 既定3役割は `set_roles` を呼ばなくても出る ------------------------------------

  test("R8: `set_roles` を1度も呼んでいないアプリでも既定3役割の文が出る(波及を隠さない)", () => {
    seedOrderShop();
    const texts = new Set(generateRequirementsDoc(dataRoot, APP_ID).statements.map((s) => s.text));
    expect(texts).toContain("このアプリは役割 `owner` を持つ。");
    expect(texts).toContain("このアプリは役割 `editor` を持つ。");
    expect(texts).toContain("このアプリは役割 `viewer` を持つ。");
    // **【`V8-M26-T04` による更新。旧の1行を逐語で残す】**
    // **旧: 「規則を1本も持たない役割は、できることの文を1つも持たない。」→ `toHaveLength(0)`。**
    // **今日は偽である** —— **`T04`(ユーザ決定 `D-V8-56` / `D-V8-60` / `D-V8-61` /
    // `D-V8-62`)が、表・画面・ボタンを**作るたび**に既定3役割へ規則を1本ずつ入れるので、
    // `seedOrderShop()`(差分で表と画面を作る)を通ったアプリには規則が実在する。**
    // **`set_roles` を1度も呼んでいないことは今日も真であり、テスト名は1バイトも変えていない。**
    // **【禁止】これを「役割の宣言が増えた」と書かない** —— **増えたのは規則の本数である。**
    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    expect(
      doc.statements.filter((statement) => statement.template.startsWith("features.role_rule_")),
    ).toHaveLength(21);
  });
});

/**
 * **`V8-M22`。台帳 `J-G34b`(門A / 判定 = 限定採用)。**
 *
 * **`V8-M20` が撤去した宣言についての文が、要件ドキュメントに残っていないこと。**
 *
 * **【この単位は `D-V8-36` と独立である】** **出す側(`J-G34a`)を選ばなかった場合でも
 * 消す側は実施される。**
 *
 * **【実対象】** **画面・項目・ボタンの3層**(`view.audience` / `field.audience` +
 * `field.writable_by` / `view_action.audience`)。**運営者の全行読取(`st_admin_readable`)の
 * テンプレートは今日0本である**(`B3` が実測で固定する)。
 *
 * **【撤去されなかった層のテンプレートを1本も消さない】** **予約規約フィールドの4本
 * (`st_owner` / `st_public` / `st_undeletable` / `st_no_direct_create`)は今日も
 * `data.field` 系のテンプレートで文になる**(`B4` が測る = 消しすぎの検出)。
 */
describe("V8-M22: J-G34b —— やめた古い決め方についての文が残っていない", () => {
  test("B1: テンプレートIDにも本文にも、撤去された5語が1件も無い", () => {
    for (const [id, body] of Object.entries(REQUIREMENT_TEMPLATES)) {
      for (const retired of ["audience", "writable_by", "st_admin_readable"]) {
        expect(`${id}:${body}`).not.toContain(retired);
      }
    }
    // **日本語の文面の側でも消えている** —— 綴りだけを見て「消えた」と書かない。
    const bodies = Object.values(REQUIREMENT_TEMPLATES).join("\n");
    for (const phrase of ["見せる相手", "書ける相手", "運営が全行"]) {
      expect(bodies).not.toContain(phrase);
    }
  });

  test("B2: 生成物に撤去された5層についての文が1文も出ない", () => {
    apply({
      diff_id: "d-811",
      intent: "撤去された層を持たない普通の表と画面を用意する",
      operations: [
        {
          op: "add_table",
          table: {
            id: "tickets",
            name: "受付",
            fields: [{ id: "subject", name: "件名", type: "text", required: true }],
          },
        },
        {
          op: "add_view",
          view: { id: "ticket-list", type: "list_view", table: "tickets", columns: ["subject"] },
        },
      ],
    });
    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    for (const phrase of ["見せる相手", "書ける相手", "audience", "writable_by"]) {
      expect(`${phrase}:${String(doc.markdown.includes(phrase))}`).toBe(`${phrase}:false`);
    }
  });

  test("B3: 運営者の全行読取(`st_admin_readable`)のテンプレートは今日0本である(実測で固定する)", () => {
    const ids = Object.keys(REQUIREMENT_TEMPLATES);
    expect(ids.filter((id) => id.includes("admin"))).toHaveLength(0);
  });

  test("B4: 撤去されなかった予約規約フィールド4本の文は今日どおり出る(消しすぎの検出)", () => {
    apply({
      diff_id: "d-812",
      intent: "予約規約フィールドを4本とも持つ表を用意する",
      operations: [
        {
          op: "add_table",
          table: {
            id: "diaries",
            name: "日記",
            fields: [
              { id: "body", name: "本文", type: "long_text" },
              { id: "st_owner", name: "持ち主", type: "text" },
              { id: "st_public", name: "公開", type: "boolean" },
              { id: "st_undeletable", name: "削除不可", type: "boolean" },
              { id: "st_no_direct_create", name: "直接作成の遮断", type: "boolean" },
            ],
          },
        },
      ],
    });
    const texts = new Set(generateRequirementsDoc(dataRoot, APP_ID).statements.map((s) => s.text));
    expect(texts).toContain(
      "テーブル `diaries` の `2` 番目のフィールドは `st_owner`(表示名 「持ち主」)で、型は `text` である。",
    );
    expect(texts).toContain(
      "テーブル `diaries` の `3` 番目のフィールドは `st_public`(表示名 「公開」)で、型は `boolean` である。",
    );
    expect(texts).toContain(
      "テーブル `diaries` の `4` 番目のフィールドは `st_undeletable`(表示名 「削除不可」)で、型は `boolean` である。",
    );
    expect(texts).toContain(
      "テーブル `diaries` の `5` 番目のフィールドは `st_no_direct_create`(表示名 「直接作成の遮断」)で、型は `boolean` である。",
    );
  });
});

/*
 * **【`V8-M13-T03`。台帳 `Q-G31a`(限定採用)/ `Q-G31b`(保留 → 本タスクで再審査)。
 * 門A 本審査 = `V8-M7`】集計表の中身が要件ドキュメントの本文に出る。**
 *
 * **着手前の実物**: **`src/kernel/requirements-doc.ts` の `report_view` 早期 return が
 * 「集計表という画面が在る」ことしか言わせなかった**(同ファイルの JSDoc が自ら申告)。
 *
 * **本タスクが守った枠**(いずれも上流の限定である):
 * - **`Slot` は今日も4種ちょうどである**(`ADR-0315` 限定5・限定6。5種目を作っていない)。
 * - **`src/kernel/` の公開エクスポートを1件も増やしていない**(`ADR-0025` 限定11。枠は
 *   14件で余白0。担保は `scripts/kernel-export-drift.test.ts`)。
 * - **語彙グループ(`VocabularyGroup`)を1件も増やしていない**(19のまま)——
 *   **有限値のそれぞれに1本ずつテンプレートを置く形を採った。****先例は
 *   `V6-M6-T02` / `ADR-0291` A1(参照項目の選び方。有限3値に3本を置き、20件目の
 *   語彙グループを作らなかった)である。**
 * - **識別子グループ(`IdentifierGroup`)を1件も増やしていない**(26のまま)——
 *   **束ねるキー・集計の列・突き合わせの参照項目はすべて既存の `field_id`、
 *   表はすべて既存の `table_id` で写した。**
 *
 * **`Q-G31b`(結合)の再審査の答えはこのファイルの下の `join` の検査そのものである** ——
 * **`{table, via}` は「表 `T` の参照フィールド `f`」の対でしかなく、`id` スロット2つ
 * (`table_id` / `field_id`)で1文に収まる。****写せたので限定採用へ倒した。**
 */
describe("V8-M13-T03 / Q-G31a / Q-G31b: 集計表の中身が要件ドキュメントに出る", () => {
  /**
   * 集計表の試材。**`seedBase()` の後に呼ぶ**(`books` / `tags` / `genre` / `rating` /
   * `tag` が要る)。**結合・表の指定・粒度・件数・合計・グラフを1つの宣言に入れてある。**
   */
  function seedReport(): void {
    apply({
      diff_id: "d-900",
      intent: "ジャンルごとの冊数と評価の合計を、月ごとの内訳つきで見たい",
      operations: [
        {
          op: "add_field",
          table: "books",
          field: { id: "published", name: "発売日", type: "date" },
        },
        {
          op: "add_view",
          view: {
            id: "book-report",
            type: "report_view",
            table: "books",
            name: "ジャンル別の集計",
            report: {
              join: [{ table: "books", via: "tag" }],
              group_by: [
                { field: "genre" },
                { table: "books", field: "published", granularity: "month" },
              ],
              aggregates: [{ type: "count" }, { type: "sum", table: "books", field: "rating" }],
              chart: "bar",
            },
          },
        },
      ],
    });
  }

  function reportTexts(): string[] {
    return generateRequirementsDoc(dataRoot, APP_ID)
      .statements.filter((statement) => statement.template.startsWith("screens.report_"))
      .map((statement) => statement.text);
  }

  test("Q-G31a-1: 束ねるキーの名前と集計の種類が文として出る(着手前は1文も無かった)", () => {
    seedBase();
    seedReport();
    expect(reportTexts()).toEqual([
      "画面 `book-report` の集計表は、`1` 番目の突き合わせとして、テーブル `books` の参照フィールド `tag` で結び付いた行を母集団に加えると宣言している。",
      "画面 `book-report` の集計表は、`1` 番目の束ねるキーとしてフィールド `genre` を宣言している。",
      "画面 `book-report` の集計表は、`2` 番目の束ねるキーとしてフィールド `published` を宣言している。",
      "画面 `book-report` の集計表の `2` 番目の束ねるキーは、テーブル `books` の項目であると宣言している。",
      "画面 `book-report` の集計表の `2` 番目の束ねるキーは、日付を月ごとに束ねると宣言している。",
      "画面 `book-report` の集計表は、`1` 番目の集計として行の件数を数えると宣言している。",
      "画面 `book-report` の集計表は、`2` 番目の集計としてフィールド `rating` の合計を出すと宣言している。",
      "画面 `book-report` の集計表の `2` 番目の集計は、テーブル `books` を対象とすると宣言している。",
      "画面 `book-report` の集計表は、集計の結果を棒グラフで描くと宣言している。",
    ]);
  });

  test("Q-G31a-2: 書いていないキーの文は1つも出ない(既定値を推測しない。ADR-0126 A3)", () => {
    seedBase();
    apply({
      diff_id: "d-901",
      intent: "結合も表の指定も粒度もグラフも書かない最小の集計表",
      operations: [
        {
          op: "add_view",
          view: {
            id: "min-report",
            type: "report_view",
            table: "books",
            report: { group_by: [{ field: "genre" }], aggregates: [{ type: "count" }] },
          },
        },
      ],
    });
    expect(reportTexts()).toEqual([
      "画面 `min-report` の集計表は、`1` 番目の束ねるキーとしてフィールド `genre` を宣言している。",
      "画面 `min-report` の集計表は、`1` 番目の集計として行の件数を数えると宣言している。",
    ]);
  });

  test("Q-G31a-3: 予約された行の番号(`_id`)で束ねても生成は止まらない(実在集合に無いため)", () => {
    seedBase();
    apply({
      diff_id: "d-902",
      intent: "行そのもので束ねる集計表",
      operations: [
        {
          op: "add_view",
          view: {
            id: "row-report",
            type: "report_view",
            table: "books",
            report: { group_by: [{ field: "_id" }], aggregates: [{ type: "count" }] },
          },
        },
      ],
    });
    expect(reportTexts()).toEqual([
      "画面 `row-report` の集計表は、`1` 番目の束ねるキーとして行そのものを宣言している(1行が1つの群になる)。",
      "画面 `row-report` の集計表は、`1` 番目の集計として行の件数を数えると宣言している。",
    ]);
  });

  test("Q-G31a-4: 粒度は3値それぞれに1本ずつ置いてある(語彙グループを増やしていない)", () => {
    seedBase();
    apply({
      diff_id: "d-903",
      intent: "日・週・月の3つの粒度を1つずつ持つ集計表を3つ作る",
      operations: [
        {
          op: "add_field",
          table: "books",
          field: { id: "published", name: "発売日", type: "date" },
        },
        {
          op: "add_view",
          view: {
            id: "day-report",
            type: "report_view",
            table: "books",
            report: {
              group_by: [{ field: "published", granularity: "day" }],
              aggregates: [{ type: "count" }],
            },
          },
        },
        {
          op: "add_view",
          view: {
            id: "week-report",
            type: "report_view",
            table: "books",
            report: {
              group_by: [{ field: "published", granularity: "week" }],
              aggregates: [{ type: "count" }],
            },
          },
        },
      ],
    });
    const texts = reportTexts();
    expect(texts).toContain(
      "画面 `day-report` の集計表の `1` 番目の束ねるキーは、日付を日ごとに束ねると宣言している。",
    );
    expect(texts).toContain(
      "画面 `week-report` の集計表の `1` 番目の束ねるキーは、日付を週ごとに束ねると宣言している(週の始まりは月曜日である)。",
    );
  });

  test("Q-G31b: 結合の相手と結合キーが1文に出る(`Slot` 4種だけで写せた)", () => {
    seedBase();
    seedReport();
    const statement = generateRequirementsDoc(dataRoot, APP_ID).statements.find(
      (candidate) => candidate.template === "screens.report_join",
    );
    expect(statement?.slots).toEqual({
      view_id: { kind: "id", group: "view_id", value: "book-report" },
      position: { kind: "number", value: 1 },
      table_id: { kind: "id", group: "table_id", value: "books" },
      field_id: { kind: "id", group: "field_id", value: "tag" },
    });
    // **出典はマニフェストの当該要素 + 帰属**(`ADR-0025` §8。その画面を入れた差分)。
    expect(statement?.sources[0]).toEqual({
      kind: "manifest",
      pointer: "/app/views/3/report/join/0",
    });
    expect(statement?.sources.slice(1)).toEqual([
      { kind: "changelog", seq: 5, diff_id: "d-900", pointer: "/operations/1" },
    ]);
  });

  test("段3: グラフ種別は2値それぞれに1本ずつ置いてある(棒 / 折れ線)", () => {
    seedBase();
    apply({
      diff_id: "d-904",
      intent: "折れ線で描く集計表",
      operations: [
        {
          op: "add_view",
          view: {
            id: "line-report",
            type: "report_view",
            table: "books",
            report: {
              group_by: [{ field: "genre" }],
              aggregates: [{ type: "count" }],
              chart: "line",
            },
          },
        },
      ],
    });
    expect(reportTexts()).toContain(
      "画面 `line-report` の集計表は、集計の結果を折れ線グラフで描くと宣言している。",
    );
  });

  test("枠: 足した文のスロットは既存4種だけで、識別子グループも語彙グループも増えていない", () => {
    seedBase();
    seedReport();
    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    for (const statement of doc.statements) {
      if (!statement.template.startsWith("screens.report_")) {
        continue;
      }
      for (const slot of Object.values(statement.slots)) {
        expect(["id", "verbatim", "term", "number"]).toContain(slot.kind);
        // **`term` は1つも使っていない**(語彙グループを増やさない形を採ったため)。
        expect(slot.kind).not.toBe("term");
        if (slot.kind === "id") {
          expect(["view_id", "table_id", "field_id"]).toContain(slot.group);
        }
      }
    }
    expect(Object.keys(doc.identifiers)).toHaveLength(26);
  });

  /*
   * **【正直に固定する】`report.filter` と `report.sort` は今日1文も出ない。**
   *
   * **どちらも `Q-G31a`(何を束ねて何を数えるか)にも `Q-G31b`(どの表とどの列を
   * 突き合わせているか)にも入っておらず、門A の本審査(`V8-M7`)が「出す」と判定した
   * 単位が1つも無い。****書けないのではなく、審査を通っていないので書かない。**
   * **`ADR-0126` A3 の不変条件(キーが書かれていれば必ず1文以上出る)は、`report` という
   * キーの単位では満たされている**(`group_by` / `aggregates` は必須なので、`report` を
   * 書いた画面には必ず2文以上出る)—— **満たされていないのは `report` の**内側**の
   * 2キーについてである。****この test はその欠落を数で残すためのものであり、
   * 塞いだら赤くなる。**
   */
  test("正直に固定する: `report.filter` / `report.sort` は今日1文も出ない(門を通していない)", () => {
    seedBase();
    apply({
      diff_id: "d-905",
      intent: "絞り込みと並べ替えを書いた集計表",
      operations: [
        {
          op: "add_view",
          view: {
            id: "sorted-report",
            type: "report_view",
            table: "books",
            report: {
              group_by: [{ field: "genre" }],
              aggregates: [{ type: "count" }],
              filter: [{ field: "genre", equals: "技術書" }],
              sort: { target: "aggregate", index: 0, order: "desc" },
            },
          },
        },
      ],
    });
    // **出るのは束ねるキー1本と集計1本ちょうどで、絞り込みも並べ替えも1文も無い。**
    expect(reportTexts()).toEqual([
      "画面 `sorted-report` の集計表は、`1` 番目の束ねるキーとしてフィールド `genre` を宣言している。",
      "画面 `sorted-report` の集計表は、`1` 番目の集計として行の件数を数えると宣言している。",
    ]);
    const markdown = generateRequirementsDoc(dataRoot, APP_ID).markdown;
    expect(markdown).not.toContain("sorted-report` の絞り込み");
    expect(markdown).not.toContain("sorted-report` の集計表は、集計の結果を");
  });

  test("枠: 集計表を持たないアプリの生成物は1バイトも変わらない(既存の文を1本も動かしていない)", () => {
    seedBase();
    const before = generateRequirementsDoc(dataRoot, APP_ID).markdown;
    expect(before).not.toContain("集計表は");
    expect(
      generateRequirementsDoc(dataRoot, APP_ID).statements.filter((statement) =>
        statement.template.startsWith("screens.report_"),
      ),
    ).toHaveLength(0);
  });
});

// --- V10-M34-T01(台帳 `CM-G45` / `ADR-0379` §Decision 2 の (4))---------------------------
//
// **要件定義書の生成物には、コメントへの言及が着手前 **0件** であった。**
// **本段が足すのは**前書きの固定1文**だけである** —— **`REQUIREMENT_TEMPLATES` を1本も増やさない。**
// **理由**: **生成器の材料は「マニフェストと変更履歴」だけで、コメントの出し入れの設定は
// `apps` 表(`comment_visibility`)に在り、生成器はそれを1件も読まない。**
// **固定の1文は材料を1つも増やさないので、`src/mcp/tools/read.ts:1228` の
// 「マニフェストと変更履歴だけから機械的に生成する」は今日も真のままである。**
// **【禁止】設定の値(出す / 出さない)を書かない** —— **読んでいないのだから書けない。**

const COMMENT_PREFACE_NOTE =
  "コメントの書く欄と読む場所はアプリごとの設定であり、この文書はその設定を1件も読んでいない。";

test("V10-M34-T01 (4b): 生成物の前書きは、コメントの設定を1件も読んでいないことを述べている", () => {
  const markdown = renderRequirementsMarkdown([]);
  // **前書きの旧2文は1バイトも消していない。**
  expect(markdown).toContain(
    "この文書は、アプリのマニフェストと変更履歴だけから機械的に生成したものである。すべての記述は出典を持つ。",
  );
  // **足したのはこの1文だけである。**
  expect(markdown).toContain(COMMENT_PREFACE_NOTE);
  expect(markdown.split(COMMENT_PREFACE_NOTE).length - 1).toBe(1);
  // **1文ちょうど**(`。` が1つ)。
  expect(COMMENT_PREFACE_NOTE.split("。").length - 1).toBe(1);
  // **【禁止】設定の値を書かない** —— 読んでいないので書けない。
  expect(COMMENT_PREFACE_NOTE).not.toContain("ON");
  expect(COMMENT_PREFACE_NOTE).not.toContain("OFF");
});

test("V10-M34-T01 (4b): 文の型は1つも増えていない(REQUIREMENT_TEMPLATES = 149 のまま)", () => {
  // **`ADR-0379` 限定6「要件定義書に出す文の型は1つちょうど」の前提は
  // 「その文が `REQUIREMENT_TEMPLATES` の1本である」ことであった。**
  // **本段は前書きの固定文を採ったので、テンプレートは1本も増えない。**
  expect(Object.keys(REQUIREMENT_TEMPLATES)).toHaveLength(149);
});
