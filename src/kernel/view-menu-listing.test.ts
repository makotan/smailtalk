/**
 * 画面をメニューへ出す/出さないの宣言(`E-G12` / `V4-M10-T45` / `ADR-0084`)。
 *
 * **限定表の正は [`docs/adr/0084-view-menu-listing.md`](../../docs/adr/0084-view-menu-listing.md) §Decision 2(10点)**、
 * 完了条件の正は `docs/plan/v4/records/v4-m10.md` §3d の `V4-M10-T45` 節(7点)。
 *
 * ## このファイルが固定すること(カーネル側)
 *
 * 1. **限定1**: 足すキーは `$defs/view` に1本(`menu_listed`)だけ。`$defs` の本数 28 /
 *    `RESOURCE_KINDS`(7)/ `FIELD_TYPES`(8)/ `DIFF_OPS`(16)が1つも動かない。
 * 2. **限定2**: 値は真偽値。enum ではない。
 * 3. **限定6**: `diff.schema.json` の `view_changes` にも同じキーが在り、
 *    **`update_view` で後から書ける**(= **値が実際に運ばれる**)。
 * 4. **限定7**: `audience` の値域(5値)と `view.type` の3値が1つも動かない。
 *
 * ## このファイルが証明しないこと(先に書く。誇張しない)
 *
 * - **掲載の判定そのものは表示層である** —— `web/test/view-menu-listing.test.tsx` の担当。
 * - **本キーは可否を1ミリも変えない**(限定5)。**サーバの応答は1バイトも変わらない。**
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { foldOperations } from "./apply-diff.ts";
import type { Manifest, Operation, View } from "./types.ts";
import { DIFF_OPS } from "./types.ts";

const ROOT = dirname(dirname(import.meta.dir));

// biome-ignore lint/suspicious/noExplicitAny: スキーマ JSON を素で読むための局所エイリアス(既存の検査と同じ作法)。
type Any = any;

function readSchema(name: string): Any {
  return JSON.parse(readFileSync(join(ROOT, "schemas", name), "utf8")) as Any;
}

// --- (a) 増分の総量(限定1 / 限定2 / 限定7)------------------------------------------

test("限定1: $defs/view.properties は 21 で、20キー目は menu_listed である", () => {
  // **【V4-M16-T12 / `P-G17` の (C) 側 / ADR-0092 限定1 による更新。理由を書く】**
  // **「テストが落ちたから直した」のではない。** `V4-M14` 本審査② の単位9 が `P-G17` を
  // **限定採用**し(ADR-0092)、**21キー目 `field_groups` が門A を通って増えた。**
  // **`ADR-0084` の増分が1キー(`menu_listed`)であることは1ミリも変わっていない** ——
  // **`menu_listed` が20キー目であることを下の位置指定が今日も見ている。**
  const properties = Object.keys(readSchema("manifest.schema.json").$defs.view.properties);
  // **【V4-M16-T13 / ADR-0093 限定1 で 21 → 22 に更新した】** 門A の本審査(`V4-M14` 本審査② の単位11。判定 = 限定採用)が22キー目 `preset_list_shape`(一覧の器の形)を足した。
  // **【V4-M18-T03 / ADR-0095 限定1 で 22 → 23 に更新した】** 門A の本審査(V4-M18 単位3。
  // 判定 = 限定採用)が23キー目 `modal`(重ねて出す宣言)を足した。**`menu_listed` が20キー目
  // であることは今日も真である。**
  // **【V4-M22-T01 / ADR-0112 限定1 で 23 → 24 に更新した】** 門A の本審査(V4-M22 単位A。
  // 判定 = 限定採用)が24キー目 `search_fields`(検索の対象にする列)を足した。**本 ADR の
  // 増分ではない。** **`menu_listed` が20キー目であることは今日も真である。**
  // **【V4-M22-T05 / ADR-0113 限定1 で 24 → 25 に更新した】** 門A の本審査(V4-M22 単位C。
  // **4回目の審査**。判定 = 限定採用)が25キー目 `page_size`(1ページに出す件数)を足した。
  // **本 ADR の増分ではない。** **`menu_listed` が20キー目であることは今日も真である。**
  // **【V4-M19-T03 / ADR-0118 限定1 で 25 → 26 に更新した】** 26キー目 `preset_density`
  // (画面の詰まり具合)が門A を通って増えた(V4-M19 単位C。2回目の審査。判定 = 限定採用)。
  // **3種すべてに書けるキーである。****本 ADR の増分ではない。** **`menu_listed` が20キー目
  // であることは今日も真である。**
  // **【V4-M20-T04 / ADR-0102 限定1 で 26 → 27 に更新した】** 27キー目 `after_save`
  // (保存が成立したあとに行く画面のID)が門A を通って増えた(V4-M20 単位D。2回目の審査。
  // 判定 = 限定採用)。**form 型のビューでだけ書ける。****本 ADR の増分ではない。**
  // **`menu_listed` が20キー目であることは今日も真である。**
  // **【V4-M23-T01 / ADR-0104 限定採用で 27 → 28 に更新した】** 28キー目 `sum_field`
  // (合計を出す列)が門A を通って増えた。**`list_view` でだけ書ける。****本 ADR の増分では
  // ない。** **`menu_listed` が20キー目であることは今日も真である。**
  // **【`V6-M2-T01` / `K-G2` / `ADR-0289` 限定1 で 28 → 29 に更新した】** 29キー目 `reference_pickers`
  // (参照項目の選び方の、入力画面ごとの上書き)が門A を通って増えた(`V6-M0` 単位A。判定 = 限定採用)。
  // **`form` 型のビューでだけ書ける。****本 ADR の増分ではない。**
  // **【`V8-M20-T01` / 台帳 `J-G27` / 手続きは `ADR-0301` で 29 → 28 に更新した】** 19キー目
  // だった `audience`(この画面を見せる相手)が**廃止された**(判定 = 廃止)。**代わりに担うのは
  // `app.roles[].rules` の「役割 × 対象(画面)× 読取」である。****旧値の逐語は 29。**
  // **このリポジトリで語彙が減ったのはこれが初めてであり、増分ではなく減分である。**
  // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】期待値を 28 → 29 へ書き換えた。**
  // **旧行の逐語**: `expect(properties).toHaveLength(28);`
  // **書き換えた理由**: この行が固定していたのは「**その決定**が `$defs/view.properties` の本数 を増やさなかったこと」であり、
  // **29本目を足したのは別の決定である**(`V8-M8` が 集計表の宣言 `report` を29キー目として足した)。**検査は消していない。**
  // **【2026-08-20。`V10-M1-T02`。台帳 `NV-G4`。門A 本審査 = `V10-M0` 群A。ADR = `0359`】**
  // **期待値を 29 → 30 へ書き換えた。****旧行の逐語**: `expect(properties).toHaveLength(29);`
  // **30本目を足したのは別の決定である**(`ADR-0359` §4a 限定1 が削除後の行き先
  // `after_delete` を**末尾に**30キー目として足した。**`detail_view` でだけ書ける**)。
  // **本ファイルが測っている決定の増分ではない。****検査は消していない。**
  // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。門A 本審査 = `V10-M0` 群B。ADR = `0359` / `0360`】**
  // **期待値を 30 → 31 へ書き換えた。****旧行の逐語**: `expect(properties).toHaveLength(30);`
  // **31本目を足したのは別の決定である**(`ADR-0359` §4b 限定1 が一続きの流れの中の段
  // `flow` を**末尾に**31キー目として足した。**`list_view` / `form` / `detail_view` の3種別で
  // 書け、集計表(`report_view`)には書けない**)。
  // **本ファイルが測っている決定の増分ではない。****検査は消していない。**
  expect(properties).toHaveLength(31);
  // **【`V8-M20-T01` / 台帳 `J-G27` / `ADR-0301` で見る位置を1つ手前へ直した】** **19キー目だった
  // `audience` が廃止されたので、それより後ろのキーの添字が1つずつ繰り上がった。**
  // **期待値を緩めていない**(位置は今日も1つに固定される)。
  expect(properties[18]).toBe("menu_listed");
});

// 【`V5-M29-T04` / `ADR-0250` 限定10 + 限定11】ここにあった test を、ブロックごと消した。
//   消したテスト名(逐語): 「限定1: $defs の本数 28 / RESOURCE_KINDS 7 / FIELD_TYPES 8 / DIFF_OPS 16 が1つも動いていない」
//   そのブロックが測っていたもの:
//     - $defs の本数は 28 である
//     - RESOURCE_KINDS は 7 である
//     - FIELD_TYPES は 9 である(テスト名は 8 と書いていた)
//     - DIFF_OPS は 17 である(テスト名は 16 と書いていた)
//   移し先は `scripts/vocabulary-drift.test.ts`(一覧の `manifest.$defs:` / `RESOURCE_KINDS:` /
//   `FIELD_TYPES:` / `DIFF_OPS:` で始まる行)。
//   **`expect()` が1つも残らないので空の test を残さなかった**(空の test は緑を返し、
//   検出力0のまま `Ran` を水増しする)。
//   **テスト名が持っていた日本語の宣言は、ここでリポジトリから消える**(`ADR-0250` §Decision 5 の (4))。

test("限定2: menu_listed は boolean 1つで、enum も条件も持たない", () => {
  const key = readSchema("manifest.schema.json").$defs.view.properties.menu_listed as Any;
  expect(key.type).toBe("boolean");
  expect(key.enum).toBeUndefined();
  // **「条件つきで出す」「この相手にだけ出す」を1つも作らない**(限定2)——
  // **散文(`$comment` / `description`)を除いた**形の全量が `type: "boolean"` 1つである。
  const { $comment: _c, description: _d, ...shape } = key;
  expect(shape).toEqual({ type: "boolean" });
});

/*
 * **【`V8-M20-T01` / 台帳 `J-G27` / 手続きは `ADR-0301`。2026-08-10】**
 * **旧テスト名(逐語)**: 「**限定7: audience の値域(5値)と view.type の3値が1つも
 * 動いていない**」。**旧本体の逐語**:
 * `expect((view.properties.audience as Any).items.enum).toBeUndefined();` /
 * `expect((view.properties.audience as Any).items.pattern).toBe("^[a-z0-9_]{1,32}$");`
 * (さらにその前の旧本体は `expect(items.enum).toEqual([...5値...])` だった)。
 *
 * **`audience` は `V8-M20` が廃止した**(判定 = 廃止)ので、**その2行は測る対象を持たない。**
 * **消したのは「赤いから」ではなく、キーそのものが今日は存在しないからである。**
 * **`ADR-0084` 限定7 が測りたいのは「`menu_listed` が他の語彙を1ミリも動かしていない」で
 * あり、`view.type` の3値についてはここで測り続ける** —— **主張ごと消したのではない。**
 * **`audience` が消えたことそのものは、`$defs/view.properties` の本数(29 → 28)を
 * このファイルの (a) が測っている。****旧文を1バイトも消していない。**
 */
test("限定7(改): view.type の3値が1つも動いていない(audience の値域は今日は存在しない)", () => {
  const view = readSchema("manifest.schema.json").$defs.view as Any;
  // **廃止されたキーが本当に消えていることを、ここで1本だけ固定する。**
  expect(view.properties.audience).toBeUndefined();
  // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】期待値に `report_view` を足した。**
  // **旧行の逐語**: `expect(readSchema("manifest.schema.json").$defs.view_type.enum).toEqual([`
  // `"form", "list_view", "detail_view",` `]);`
  // **書き換えた理由**: この行が固定していたのは「**`ADR-0084`(`menu_listed`)の決定**が
  // `view.type` の値域を1ミリも動かさなかったこと」であり、**4値目を足したのは別の決定である**
  // (`V8-M8` が画面種別の4種目 `report_view` を足した)。**検査は消していない** ——
  // **順序ごと固定しているので、値が1つでも動けば今日も赤くなる。**
  expect(readSchema("manifest.schema.json").$defs.view_type.enum).toEqual([
    "form",
    "list_view",
    "detail_view",
    "report_view",
  ]);
});

test("限定6: view_changes.properties は 15 で、14キー目は menu_listed である", () => {
  // **【V4-M16-T12 / ADR-0092 限定2 による更新】** 15キー目 `field_groups` が門A を通って
  // 増えた。**`menu_listed` が14キー目であることは1ミリも変わっていない。**
  const properties = Object.keys(readSchema("diff.schema.json").$defs.view_changes.properties);
  // **【V4-M16-T13 / ADR-0093 限定2 で 15 → 16 に更新した】** `update_view` にも16キー目 `preset_list_shape` が加わった(値はカーネルが実際に運ぶ)。
  // **【V4-M18-T03 / ADR-0095 限定6 で 16 → 17 に更新した】** `update_view` にも17キー目
  // `modal` が加わった(値は `applyViewChanges` の `form` 分岐が実際に運ぶ)。
  // **`menu_listed` が14キー目であることは今日も真である。**
  // **【V4-M22-T01 / ADR-0112 限定2 で 17 → 18 に更新した】** `update_view` にも18キー目
  // `search_fields` が加わった(値は `applyViewChanges` の `list_view` 分岐が実際に運ぶ)。
  // **`menu_listed` が14キー目であることは今日も真である。**
  // **【V4-M22-T05 / ADR-0113 限定2 で 18 → 19 に更新した】** `update_view` にも19キー目
  // `page_size` が加わった(値は `applyViewChanges` の `list_view` 分岐が実際に運ぶ)。
  // **`menu_listed` が14キー目であることは今日も真である。**
  // **【V4-M19-T03 / ADR-0118 限定1 で 19 → 20 に更新した】** 20キー目 `preset_density`
  // (画面の詰まり具合)が門A を通って増えた(V4-M19 単位C。2回目の審査。判定 = 限定採用)。
  // **3種すべてに書けるキーである。****本 ADR の増分ではない。** **`menu_listed` が14キー目
  // であることは今日も真である。**
  // **【V4-M20-T04 / ADR-0102 限定2 で 20 → 21 に更新した】** 21キー目 `after_save` が
  // `update_view` にも加わった(値は `applyViewChanges` の `form` 分岐が実際に運ぶ)。
  // **`menu_listed` が14キー目であることは今日も真である。**
  // **【V4-M23-T01 / ADR-0104 限定採用で 21 → 22 に更新した】** `update_view` にも22キー目
  // `sum_field`(合計を出す列。`list_view` でだけ書ける)が加わった(値は `applyViewChanges`
  // の `list_view` 分岐が実際に運ぶ)。**`menu_listed` が14キー目であることは今日も真である。**
  // **【`V6-M2-T02` / `K-G3` / `ADR-0289` 限定1 で 23 → 24 に更新した】** 24キー目 `reference_pickers`
  // (参照項目の選び方の、入力画面ごとの上書き。`form` でだけ書ける)が `update_view` にも加わった
  // (値は `applyViewChanges` の `form` 分岐が実際に運ぶ)。**本 ADR の増分ではない。**
  // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】期待値を 24 → 25 へ書き換えた。**
  // **旧行の逐語**: `expect(properties).toHaveLength(24);`
  // **書き換えた理由**: この行が固定していたのは「**その決定**が `view_changes.properties` の本数 を増やさなかったこと」であり、
  // **25本目を足したのは別の決定である**(`V8-M8` が 集計表の宣言 `report` を25キー目として足した)。**検査は消していない。**
  // **【2026-08-20。`V10-M1-T02`。台帳 `NV-G4`。ADR = `0359` §Decision 2】**
  // **期待値を 25 → 26 へ書き換えた。****旧行の逐語**: `expect(properties).toHaveLength(25);`
  // **26本目を足したのは別の決定である**(`after_delete` を `view_changes` の末尾に足した)。
  // **本ファイルが測っている決定の増分ではない。****検査は消していない。**
  // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。門A 本審査 = `V10-M0` 群B。ADR = `0359` / `0360`】**
  // **期待値を 26 → 27 へ書き換えた。****旧行の逐語**: `expect(properties).toHaveLength(26);`
  // **27本目を足したのは別の決定である**(`flow` を `view_changes` の末尾に足した。
  // `ADR-0359` §Decision 2)。**本ファイルが測っている決定の増分ではない。**
  // **検査は消していない。**
  expect(properties).toHaveLength(27);
  expect(properties[13]).toBe("menu_listed");
});

/*
 * **【V5-M21-T03 / `L-G4` / `ADR-0172` 無効化条文3 で書き換えた】**
 *
 * **着手前のテスト名は「限定6: audience / related / actions は今日も view_changes に無い
 * (射程外)」であり、本体は3つとも無いことを期待していた。****actions については今日から
 * 偽である** —— **`ADR-0172`(門A / 判定 = 限定採用)が `view_changes` に `actions` を
 * 1本足した(22 → 23)。****`ADR-0084` 限定6 の後段のうち無効化されたのは `actions` の
 * 分だけであり、`audience` / `related` は今日も射程外である**(`ADR-0172` §Context 2 が
 * 「残る2つについては同じ論証を行っていない」と明記している)。
 * **`ADR-0084` の本文を1バイトも書き換えていない。**
 */
/*
 * **【`V8-M20-T01` / 台帳 `J-G27` / `ADR-0301`。2026-08-10】** **`audience` は
 * `view_changes` どころか、どこにも無い** —— **キーごと廃止された。****この test は今日も
 * 緑だが、`audience` について測っているものは「射程外である」から「存在しない」へ変わった。**
 * **本体を1バイトも変えていない。**
 */
test("限定6(改): audience / related は今日も view_changes に無い(actions は ADR-0172 が足した)", () => {
  const properties = Object.keys(readSchema("diff.schema.json").$defs.view_changes.properties);
  for (const outOfScope of ["audience", "related"]) {
    expect(properties).not.toContain(outOfScope);
  }
  expect(properties).toContain("actions");
});

// --- (b) update_view で後から書ける = **値が実際に運ばれる**(限定6)-------------------
//
// **`ADR-0076` / `ADR-0080` が作った「キーは在るが値が運ばれない」状態を繰り返さない。**
// **`ADR-0084` の限定表は `src/kernel/` への差分を1つも禁じていない**ので、
// `applyViewChanges`(`apply-diff.ts`)が値を運ぶところまで実装する。

function baseManifest(): Manifest {
  return {
    app: {
      id: "menu-shop",
      name: "メニューの店",
      tables: [
        {
          id: "product",
          name: "商品",
          fields: [{ id: "name", name: "商品名", type: "text", required: true }],
        },
      ],
      views: [
        { id: "product-list", type: "list_view", table: "product", columns: ["name"] },
        { id: "product-detail", type: "detail_view", table: "product", fields: ["name"] },
        { id: "product-form", type: "form", table: "product", fields: ["name"] },
      ],
    },
  };
}

function fold(operations: Operation[]): Manifest {
  const result = foldOperations(baseManifest(), operations);
  if (!result.valid) {
    throw new Error(`fold が失敗した: ${JSON.stringify(result.errors)}`);
  }
  return result.manifest;
}

function viewOf(manifest: Manifest, id: string): View & { menu_listed?: boolean } {
  const view = manifest.app.views.find((v) => v.id === id);
  if (view === undefined) {
    throw new Error(`ビュー ${id} が無い`);
  }
  return view;
}

test("限定6: update_view で書いた menu_listed が適用後マニフェストに残る(3種すべて)", () => {
  for (const id of ["product-list", "product-detail", "product-form"]) {
    const next = fold([
      { op: "update_view", view: id, changes: { menu_listed: false } } as Operation,
    ]);
    expect(viewOf(next, id).menu_listed).toBe(false);
  }
});

test("限定6: true を書き直すと true に戻る(前進で戻せる。undo が要らない)", () => {
  const off = fold([
    { op: "update_view", view: "product-detail", changes: { menu_listed: false } } as Operation,
  ]);
  const back = foldOperations(off, [
    { op: "update_view", view: "product-detail", changes: { menu_listed: true } } as Operation,
  ]);
  expect(back.valid).toBe(true);
  if (!back.valid) {
    return;
  }
  expect(viewOf(back.manifest, "product-detail").menu_listed).toBe(true);
});

test("限定3: 書かなかった画面に menu_listed キーは生えない(既定は「出す」)", () => {
  const next = fold([
    { op: "update_view", view: "product-list", changes: { name: "商品の一覧" } } as Operation,
  ]);
  expect("menu_listed" in viewOf(next, "product-list")).toBe(false);
});

test("限定6: menu_listed を書いた画面に別のキーを update_view しても値が消えない", () => {
  const off = fold([
    { op: "update_view", view: "product-list", changes: { menu_listed: false } } as Operation,
  ]);
  const renamed = foldOperations(off, [
    { op: "update_view", view: "product-list", changes: { name: "隠した一覧" } } as Operation,
  ]);
  expect(renamed.valid).toBe(true);
  if (!renamed.valid) {
    return;
  }
  expect(viewOf(renamed.manifest, "product-list").menu_listed).toBe(false);
});

// --- (c) 語彙の外へ広げない -----------------------------------------------------------

test("限定1: DIFF_OPS に掲載専用の op が1つも無い", () => {
  expect(DIFF_OPS.filter((op) => /menu|list(ed)?$/.test(op))).toEqual([]);
});

// 【`V5-M29-T04` / `ADR-0250` 限定10 + 限定11】ここにあった test を、ブロックごと消した。
//   消したテスト名(逐語): 「限定8: $defs/view の他の18キー(id 〜 audience)は名前も順序も1バイトも変わっていない」
//   そのブロックが測っていたもの:
//     - $defs/view.properties の全28キーが、名前も順序も一致する(`toEqual([...])` の B 形)
//   移し先は `scripts/vocabulary-drift.test.ts`(一覧の `manifest.$defs.view.properties:` で始まる行)。
//   **中央が名前を順序ごと比べていることは、消す前に実測して確かめた** —— 一覧の
//   `manifest.$defs.view.properties:` の28行は、ここにあった配列と**同じ名前・同じ順序**である。
//   **`expect()` が1つも残らないので空の test を残さなかった**(空の test は緑を返し、
//   検出力0のまま `Ran` を水増しする)。
//   **テスト名が持っていた日本語の宣言は、ここでリポジトリから消える**(`ADR-0250` §Decision 5 の (4))。
