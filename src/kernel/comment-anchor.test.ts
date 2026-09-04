/**
 * **`related` が `update_view` の受理キーに黙って入らないことの見張り**
 * (`V10-M26-T03` / `CM-G34` / [`ADR-0374`](../../../../docs/adr/0374-label-drift-and-propagation.md))。
 *
 * ## なぜ要るか(危険 (c))
 *
 * `V10-M24` が定義に名札(`id`)を3箇所入れ、そのうち1つが **`detail_view.related[].id`** である。
 * 名札はコメントの宛先(`view_related`)から名指しするためのもので、**`add_view` でだけ書ける。**
 * **`related` は今日 `update_view` の受理キーに入っていない** —— ここに `related` が
 * **黙って**入ると、「関連一覧は後から書き換えられない」という今日の説明が全部偽になり、
 * かつ**名札の一意検査が `update_view` の経路を1度も通らない**まま口だけが開く。
 * **この見張りは、その日に赤くなるためだけに在る。**
 *
 * ## 見る7箇所(**逐語ではなく構造で当てる**。7 だけが逐語)
 *
 * | # | 箇所 | 当て方 | 構造 / 逐語 |
 * |--:|---|---|---|
 * | 1 | `UPDATE_VIEW_ACCEPTED_KEYS`(`src/mcp/vocabulary.ts`) | `import` して長さと `includes` | **構造** |
 * | 2 | `schemas/diff.schema.json` の `$defs/view_changes` | JSON を読んでキー集合 | **構造** |
 * | 3 | `CHANGE_KEYS_BY_VIEW_TYPE`(`src/kernel/apply-diff.ts`) | `applyDiff` を実際に走らせ、拒否エラーの `allowed_values` を読む | **構造** |
 * | 4 | `src/kernel/migrate.ts` の27キーの列挙 | `planMigration` を実際に走らせ、文面から列を切り出す | **文面の解析**(下記) |
 * | 5 | `applyViewChanges` が値を運ぶ行(`src/kernel/apply-diff.ts`) | 適用前後の `manifest.json` のバイト列 | **構造** |
 * | 6 | `ViewChanges` 型(`src/kernel/types.ts`) | **型 → 値の全射**(`satisfies Record<keyof ViewChanges, true>`) | **構造(型)** |
 * | 7 | `VOCABULARY_SCOPE` の該当文 | 逐語(`ADR-0374` `CM-G34` 限定2 が「ここだけ逐語」と明示) | **逐語** |
 *
 * ## 検出器は2種である(**片方だけでは素通りする**)
 *
 * - **`bun test src/kernel/comment-anchor.test.ts`** —— 1〜5 と 7 を捕まえる。
 * - **`bunx tsc --noEmit`** —— **6 はここでしか捕まらない。** 型だけの変化は `bun test` を
 *   1ミリも動かさない(`type-only-lines-need-tsc-detector`。同じ型の見落としがこの
 *   リポジトリで4度出ている)。**`VIEW_CHANGE_KEYS` を手書きの配列で書くと、
 *   `ViewChanges` に `related?:` が生えても全件 `bun test` が 0 fail のままである**
 *   —— だから `satisfies Record<keyof ViewChanges, true>` で**全射**を要求する。
 *
 * ## 4(`migrate.ts`)について —— **正直に書く**
 *
 * **`migrate.ts` の27キーは、テンプレート文字列の中の散文であり、export されていない。**
 * **ソースを構造として読む道は今日1本も無い。** 本ファイルは `planMigration` を実際に
 * 走らせ、返ってきた文面から列を切り出して**型**(`VIEW_CHANGE_KEYS`)と突き合わせる。
 * **切り出しの正規表現は文面の逐語断片であり、その意味でここは純粋な構造読みではない。**
 *
 * **既に別の検査が同じ箇所を固定している** —— `src/kernel/migrate.test.ts` の
 * `describe("V3-M2-T01: マニフェスト直渡し経路のエラー文言が view_changes のキー集合と一致する")`
 * が、**`schemas/diff.schema.json` の `$defs/view_changes`** と突き合わせている。
 * **本ファイルは同じ突合を二重に置かない** —— 突き合わせる相手を**型**に替えてある
 * (あちらは JSON スキーマ、こちらは `ViewChanges`)。**この2本が揃って初めて
 * 「型 ⇄ スキーマ ⇄ 文面」の三者が繋がる。**
 *
 * ## このファイルが**証明しないこと**(誇張しない)
 *
 * - **`related` が `add_view` で書けることは、ここでは1度も測っていない。** 見張っているのは
 *   `update_view` の側だけである。
 * - **コメントの宛先(`view_related`)が名札を実際に解決することは1件も測っていない。**
 *   器(`comment-store.ts`)は宛先の綴りを1度も定義と突き合わせない —— **今日は
 *   「実在しない名札にもコメントを書ける」。** それは `CommentStore` の限界であって、
 *   本ファイルの担当ではない。
 * - **画面(`web/`)を1ピクセルも見ていない。** `src/kernel/` から `web/` を読む `import` は
 *   **1件も足していない**(`v10-m24.md` §15-2 の 8 の申し送り —— `field-group-shape.test.ts`
 *   が払った代償を、本ファイルは払わずに済ませた。7箇所のどれも描画層に無いためである)。
 * - **`related` を `update_view` で送ったときに拒否するのは、今日は 3 ではなく 2 である**
 *   —— **`diff.schema.json` の `additionalProperties: false` が先に落とす。**
 *   `CHANGE_KEYS_BY_VIEW_TYPE` は `related` に対して**一度も評価されない。**
 *   だから 3 は「スキーマを通るが `detail_view` には許されないキー」を送って読む。
 */

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { UPDATE_VIEW_ACCEPTED_KEYS, VOCABULARY_SCOPE } from "../mcp/vocabulary.ts";
import { applyDiff } from "./apply-diff.ts";
import { createApp } from "./create-app.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { planMigration } from "./migrate.ts";
import { appManifestPath } from "./storage-paths.ts";
import type { Diff, Manifest, ViewChanges } from "./types.ts";

const ROOT = dirname(dirname(import.meta.dir));
const APP_ID = "ca-anchor";
const DETAIL_ID = "parent-detail";

/**
 * **`ViewChanges` のキー集合を、型から導いた値として持つ。**
 *
 * **`satisfies Record<keyof ViewChanges, true>` が全射を要求する** ——
 * 型にキーが1本生えれば「足りない」と言われ、型から消えれば「余分だ」と言われる。
 * **どちらも `bunx tsc --noEmit` でしか出ない。** 手書きの配列に置き換えてはいけない。
 */
const VIEW_CHANGE_KEYS = {
  name: true,
  columns: true,
  sort: true,
  filter: true,
  fields: true,
  preset_column_align: true,
  preset_column_width: true,
  preset_pager_position: true,
  preset_label_placement: true,
  preset_field_columns: true,
  preset_image_size: true,
  preset_text_preview: true,
  custom_css: true,
  menu_listed: true,
  field_groups: true,
  preset_list_shape: true,
  modal: true,
  search_fields: true,
  page_size: true,
  sum_field: true,
  preset_density: true,
  after_save: true,
  after_delete: true,
  flow: true,
  actions: true,
  reference_pickers: true,
  report: true,
} satisfies Record<keyof ViewChanges, true>;

/** 型から導いたキー名(並びは問わないので、突合はすべて整列してから行う)。 */
const TYPE_KEYS = Object.keys(VIEW_CHANGE_KEYS).sort();

/**
 * AI へ渡る受理キーの列挙を、**綴りの型を外して**見る。
 *
 * **`UPDATE_VIEW_ACCEPTED_KEYS` はリテラルのタプルなので、素のままだと
 * `includes("related")` が「その綴りは要素の型に無い」と型検査で止まる** ——
 * それでは「今日 `related` が入っていない」ことを**実行時に**言えない
 * (定数に `related` を1行足した日に、この検査が黙って消えてしまう)。
 * **綴りの型を外して `readonly string[]` として見ることで、
 * 足された日に `bun test` が赤くなる。**
 */
const MCP_ACCEPTED_KEYS: readonly string[] = UPDATE_VIEW_ACCEPTED_KEYS;

// biome-ignore lint/suspicious/noExplicitAny: スキーマ JSON を素で読むための局所エイリアス(既存の検査と同じ作法)。
type Any = any;

/** `schemas/diff.schema.json` を素で読む。 */
function diffSchema(): Any {
  return JSON.parse(readFileSync(join(ROOT, "schemas", "diff.schema.json"), "utf-8")) as Any;
}

/**
 * `related` を `update_view` の `changes` に書いた差分。
 *
 * **型では書けない**(それが本ファイルの主張そのものである)ので、受け口の型を外して渡す。
 * **`ViewChanges` に `related` が生えてもこの行は緑のままである** —— だから 6 が別に要る。
 */
const RELATED_CHANGES = {
  related: [{ id: "rel_b", table: "kids", via: "p", columns: ["t"] }],
} as unknown as ViewChanges;

/** 親子2表と、名札つき関連一覧を持つ詳細画面・一覧画面を1つずつ持つ土台。 */
const BASE_DIFF: Diff = {
  diff_id: "d-ca-1",
  intent: "related の受理キーを見張るための土台",
  operations: [
    {
      op: "add_table",
      table: {
        id: "parents",
        name: "親",
        fields: [
          { id: "f_a", name: "項目A", type: "text" },
          { id: "f_b", name: "項目B", type: "text" },
        ],
      },
    },
    {
      op: "add_table",
      table: {
        id: "kids",
        name: "子",
        fields: [
          { id: "p", name: "親", type: "reference", reference_table: "parents" },
          { id: "t", name: "題", type: "text" },
        ],
      },
    },
    {
      op: "add_view",
      view: {
        id: DETAIL_ID,
        type: "detail_view",
        table: "parents",
        // **`add_view` でなら名札つきの関連一覧を書ける**(今日の正。陽性対照でもある)。
        related: [{ id: "rel_a", table: "kids", via: "p", columns: ["t"] }],
      },
    },
  ],
};

/** 土台を作り、`fn` に「データ台の根」を渡す。後始末まで面倒を見る。 */
function withApp(fn: (dataRoot: string) => void): void {
  const dataRoot = mkdtempSync(join(tmpdir(), "gp-comment-anchor-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "宛先の見張り", { app_id: APP_ID });
    const seeded = applyDiff(dataRoot, APP_ID, BASE_DIFF);
    expect(seeded.valid, JSON.stringify(seeded.valid ? [] : seeded.errors)).toBe(true);
    fn(dataRoot);
  } finally {
    store.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

/** 「変更できるのは A / B / C のみです。」の A / B / C を取り出す(`migrate.test.ts` と同じ切り出し)。 */
function enumeratedKeys(message: string): string[] {
  const matched = /変更できるのは (.+?) のみです。/.exec(message);
  expect(matched, message).not.toBeNull();
  return (matched?.[1] ?? "").split(" / ");
}

/** `planMigration` を「type を変える」形で走らせ、拒否メッセージを返す。 */
function typeChangeMessage(): string {
  const current: Manifest = {
    app: {
      id: APP_ID,
      name: "宛先の見張り",
      tables: [{ id: "parents", name: "親", fields: [{ id: "f_a", name: "項目A", type: "text" }] }],
      views: [{ id: "v1", type: "list_view", table: "parents", columns: ["f_a"] }],
    },
  };
  const next: Manifest = structuredClone(current);
  next.app.views = [{ id: "v1", type: "detail_view", table: "parents" }];
  const result = planMigration(current, next);
  expect(result.valid).toBe(false);
  return result.valid ? "" : (result.errors[0]?.message ?? "");
}

// ---------------------------------------------------------------------------
// 1. AI へ渡る受理キーの列挙
// ---------------------------------------------------------------------------

test("(ca1) AI へ渡る update_view の受理キー26本に related が無い(陽性対照 field_groups は在る)", () => {
  // **`UPDATE_VIEW_ACCEPTED_KEYS` は `VOCABULARY_SCOPE` と `apply_diff` のツール固有説明の
  // 両方が読む1つの定数である**(片方だけが古くなる余地を作らないため)。
  // **ここに `related` を1行足すと、AI は「後から書き換えられる」と読む。**
  expect(MCP_ACCEPTED_KEYS.length).toBe(26);
  expect(MCP_ACCEPTED_KEYS.includes("related")).toBe(false);
  // 陽性対照 —— 同じ式が「在る」を掴めることの実証(常に false を返す式ではない)。
  expect(MCP_ACCEPTED_KEYS.includes("field_groups")).toBe(true);
  // **26 と 27 の差は `report` 1本ちょうどである**(`ADR-0374` `CM-G34` 限定6 の既知の食い違い。
  // **この差は本単位が生んだものではなく、直しもしない**)。
  expect(TYPE_KEYS.filter((key) => !MCP_ACCEPTED_KEYS.includes(key))).toEqual(["report"]);
});

// ---------------------------------------------------------------------------
// 2. 差分スキーマ
// ---------------------------------------------------------------------------

test("(ca2) diff.schema.json の view_changes 27キーに related が無く、型のキー集合と一致する", () => {
  const viewChanges = diffSchema().$defs.view_changes;
  const keys = Object.keys(viewChanges.properties as Record<string, unknown>);
  expect(keys.length).toBe(27);
  expect(keys.includes("related")).toBe(false);
  // 陽性対照。
  expect(keys.includes("field_groups")).toBe(true);
  // **`additionalProperties: false` が、知らないキーを黙って通さないことの根拠である** ——
  // これが `true` に変わると、`related` は「未知のプロパティ」ではなくなり素通りする。
  expect(viewChanges.additionalProperties).toBe(false);
  // **スキーマと型が同じ集合であること**(片方にだけ `related` が生える形を封じる)。
  expect([...keys].sort()).toEqual(TYPE_KEYS);
});

// ---------------------------------------------------------------------------
// 3. ビュー種別ごとの許可キー
// ---------------------------------------------------------------------------

test("(ca3) detail_view の許可キーに related が無い(applyDiff を実際に走らせて読む)", () => {
  withApp((dataRoot) => {
    // **スキーマは通るが `detail_view` には許されないキー**を送り、
    // `CHANGE_KEYS_BY_VIEW_TYPE` が返す許可キーの全量を読む。
    // **`related` を送るとスキーマ(2)が先に落とすので、この箇所は評価されない** ——
    // だから `related` ではなく `preset_column_align` を送る。
    const result = applyDiff(dataRoot, APP_ID, {
      diff_id: "d-ca-2",
      intent: "detail_view に一覧専用キーを送って、許可キーの全量を読む",
      operations: [
        { op: "update_view", view: DETAIL_ID, changes: { preset_column_align: { f_a: "left" } } },
      ],
    });
    expect(result.valid).toBe(false);
    if (result.valid) return;
    // 綴りの型を外して見る(理由は `MCP_ACCEPTED_KEYS` の doc と同じ)。
    const allowed: readonly string[] = result.errors[0]?.allowed_values ?? [];
    expect(allowed.length).toBeGreaterThan(0);
    expect(allowed.includes("related")).toBe(false);
    // 陽性対照 —— まとまりは `detail_view` で書ける。
    expect(allowed.includes("field_groups")).toBe(true);
    // **許可キーは `ViewChanges` の部分集合である**(型に無いキーを許していない)。
    expect(allowed.filter((key) => !TYPE_KEYS.includes(key))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. マニフェスト直渡し経路の文面
// ---------------------------------------------------------------------------

test("(ca4) migrate.ts の文面が列挙する27キーに related が無く、型のキー集合と一致する", () => {
  // **`migrate.ts` は27キーを散文で直書きしており、export していない** ——
  // ソースを構造として読む道は無いので、`planMigration` を走らせて文面を得る。
  // **突き合わせる相手は「型」である**(`migrate.test.ts` は JSON スキーマと突き合わせている。
  // 相手を替えてあるので二重ではない)。
  const keys = enumeratedKeys(typeChangeMessage());
  expect(keys.length).toBe(27);
  expect(keys.includes("related")).toBe(false);
  // 陽性対照。
  expect(keys.includes("field_groups")).toBe(true);
  expect([...keys].sort()).toEqual(TYPE_KEYS);
});

// ---------------------------------------------------------------------------
// 5. 値を運ぶ行
// ---------------------------------------------------------------------------

test("(ca5) update_view で related を送っても、適用後の定義が1バイトも変わらない", () => {
  withApp((dataRoot) => {
    const manifestPath = appManifestPath(dataRoot, APP_ID);
    const before = readFileSync(manifestPath, "utf-8");
    const rejected = applyDiff(dataRoot, APP_ID, {
      diff_id: "d-ca-3",
      intent: "related を update_view で書こうとする",
      operations: [{ op: "update_view", view: DETAIL_ID, changes: RELATED_CHANGES }],
    });
    expect(rejected.valid).toBe(false);
    // **拒否の文言に `related` が名指しで出る**(黙って捨てているのではない)。
    const messages = rejected.valid ? [] : rejected.errors.map((error) => error.message);
    expect(messages.some((message) => message.includes("related"))).toBe(true);
    // **バイト列が1文字も動かない** —— `applyViewChanges` に `related` を運ぶ行が無いことの実測。
    expect(readFileSync(manifestPath, "utf-8")).toBe(before);
    // **名札つきの関連一覧は `add_view` で入れたものがそのまま残っている**(消してもいない)。
    const manifest = JSON.parse(before) as Manifest;
    const detail = manifest.app.views.find((view) => view.id === DETAIL_ID);
    expect(detail?.type === "detail_view" ? detail.related?.[0]?.id : undefined).toBe("rel_a");

    // 陽性対照 —— **まとまりを送ればバイト列は実際に動く。**
    // (「何を送っても変わらない台」で測っていないことの実証)
    const accepted = applyDiff(dataRoot, APP_ID, {
      diff_id: "d-ca-4",
      intent: "field_groups を update_view で書く(陽性対照)",
      operations: [
        {
          op: "update_view",
          view: DETAIL_ID,
          changes: { field_groups: { 基本: { id: "g_a", fields: ["f_a"] } } },
        },
      ],
    });
    expect(accepted.valid, JSON.stringify(accepted.valid ? [] : accepted.errors)).toBe(true);
    expect(readFileSync(manifestPath, "utf-8")).not.toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 6. 型(**この箇所は `bun test` では捕まらない。検出器は `bunx tsc --noEmit`**)
// ---------------------------------------------------------------------------

test("(ca6) ViewChanges 型のキー集合に related が無い(型 → 値の全射で固定する)", () => {
  // **この `expect` は、型に `related?:` が生えても緑のままである。**
  // **赤くなるのは `bunx tsc --noEmit` の側である** —— 上の `VIEW_CHANGE_KEYS` に付けた
  // `satisfies Record<keyof ViewChanges, true>` が「`related` が足りない」と言う。
  // **【禁止】`VIEW_CHANGE_KEYS` を手書きの配列(`as const`)に書き換えないこと。**
  // その形にすると、型が変わっても全件 `bun test` が 0 fail のまま、
  // この検査の名前だけが嘘になる(このリポジトリで4度出た型)。
  expect(TYPE_KEYS.length).toBe(27);
  expect(TYPE_KEYS.includes("related")).toBe(false);
  // 陽性対照。
  expect(TYPE_KEYS.includes("field_groups")).toBe(true);
});

// ---------------------------------------------------------------------------
// 7. AI へ渡る説明の逐語(**ここだけ逐語**。`ADR-0374` `CM-G34` 限定2 が明示)
// ---------------------------------------------------------------------------

test("(ca7) AI へ渡る説明が「related は今日も update_view では書けません」と言い続けている", () => {
  // **7箇所のうち、逐語で当てるのはここ1つだけである。**
  // 機械が守っているのは「この文が在ること」だけで、**文が今日の正であることは
  // 誰も守っていない** —— 上の 1〜6 が偽になれば、この文のほうが嘘になる。
  expect(VOCABULARY_SCOPE).toContain("related は今日も update_view では書けません");
  // 陽性対照 —— 同じ式で、在るはずのないものは掴まない。
  expect(VOCABULARY_SCOPE).not.toContain("related は update_view で書けます");
});
