/**
 * **一覧に何件出すかの宣言**(`V4-M22-T05`。`ADR-0113` 限定1〜限定7・限定9・限定10)。
 *
 * ## これは何で、何ではないか
 *
 * - **通したのは「件数」だけである。** **`ADR-0042` 限定2 / §3a-1 / §3a-2 / §3a-3 は
 *   1ミリも解けていない**(`ADR-0113` §Decision 2 (b))。
 * - **【禁止】「ページングを自由に設定できるようになった」と読まない** —— **選べるのは
 *   4つの段階値だけで、自由な整数を1つも受けない**(限定3)。
 * - **【禁止】「件数の問題が解決した」と総括しない**(`ADR-0113` Consequences)——
 *   **深い offset の遅さも、`total` のコストも、子一覧の件数も、1ミリも解けていない。**
 * - **【禁止】「マニフェストがページ位置を持つようになった」と読まない** —— **`offset` /
 *   `page` / 総ページ数のキャッシュを1本も足していない**(限定4)。
 *
 * ## 語彙の総量(**1つも動かしていないことを、ここで数える**)
 *
 * `RESOURCE_KINDS` 7 / `FIELD_TYPES` 8 / `DIFF_OPS` 16 / `$defs` 28 /
 * `$defs/theme` 25・25 / `$defs/field` 11 —— **すべて着手前と同じである。**
 *
 * ## 【本数の実測が限定表と食い違う】
 *
 * **`ADR-0113` 限定1 / 限定2 は「`view.properties` を **+1**」「`view_changes.properties` を
 * **+1**」と書いており、事実5 が「`$defs/view.properties` は 22 / `view_changes` は 16」と
 * 記している。** **同 ADR §限界8 が逐語で「`V4-M18`〜`V4-M21` と `ADR-0112` の実装順に
 * よって変わる。実装時に数え直すこと。」と課している。**
 * **今日の実測は、`V4-M18`(`modal`)と `V4-M22-T01`(`search_fields`)が先に入った後の
 * `$defs/view` = **24** / `view_changes` = **18** である。**
 * **したがって本タスクの増分は 24 → 25 / 18 → 19 である** —— **守ったのは「1本だけ足す」
 * という増分であって、限定表が写した絶対値ではない。** **`ADR-0113` の本文を1バイトも
 * 書き換えていない。**
 */

import { describe, expect, test } from "bun:test";
import diffSchema from "../../schemas/diff.schema.json" with { type: "json" };
import manifestSchema from "../../schemas/manifest.schema.json" with { type: "json" };
import { foldOperations } from "./apply-diff.ts";
import type { ListView, Manifest, View } from "./types.ts";
import { validateManifest, validateManifestFull } from "./validate.ts";

/** 足したキーの名前。**1本だけである**(`ADR-0113` 限定1)。 */
const KEY = "page_size";

function defs(): Record<string, { properties: Record<string, unknown>; required?: string[] }> {
  return (manifestSchema as unknown as { $defs: Record<string, never> }).$defs as never;
}

function viewSchema(): {
  properties: Record<string, unknown>;
  allOf: { if: unknown; then: { properties?: Record<string, unknown>; required?: string[] } }[];
} {
  return defs().view as never;
}

function baseManifest(views: View[]): Manifest {
  return {
    app: {
      id: "shop",
      name: "店",
      tables: [
        { id: "orders", name: "注文", fields: [{ id: "memo", name: "メモ", type: "text" }] },
      ],
      views,
    },
  } as unknown as Manifest;
}

function listView(overrides: Partial<ListView> = {}): View {
  return {
    id: "order-list",
    type: "list_view",
    table: "orders",
    columns: ["memo"],
    ...overrides,
  } as unknown as View;
}

// ---------------------------------------------------------------------------
// 限定1 / 限定9: 足すキーは1本だけ / 語彙の総量は1つも動かない
// ---------------------------------------------------------------------------

describe("(T05-1) 語彙の総量(ADR-0113 限定1 / 限定9)", () => {
  // **【V4-M19-T03 / ADR-0118 限定1 で 25 → 26 に更新した】** 26キー目 `preset_density`
  // (画面の詰まり具合)が門A を通って増えた(V4-M19 単位C。2回目の審査。判定 = 限定採用)。
  // **3種すべてに書けるキーである。****本 ADR の増分ではない。**
  // **【V4-M20-T04 / ADR-0102 限定1 で 26 → 27 に更新した】** 27キー目 `after_save`
  // (保存が成立したあとに行く画面のID)が門A を通って増えた(V4-M20 単位D。2回目の審査。
  // 判定 = 限定採用)。**form 型のビューでだけ書ける。****本 ADR の増分ではない。**
  // **【V4-M23-T01 / ADR-0104 限定採用で 27 → 28 に更新した】** 28キー目 `sum_field`
  // (合計を出す列)が門A を通って増えた。**`list_view` でだけ書ける。****本 ADR の増分では
  // ない。****`page_size` が25キー目であることは今日も真である。**
  test("$defs/view の properties が25本になり、その25本目が本キーである", () => {
    const keys = Object.keys(viewSchema().properties);
    // **【`V6-M2-T01` / `K-G2` / `ADR-0289` 限定1 で 28 → 29 に更新した】** 29キー目 `reference_pickers`
    // (参照項目の選び方の、入力画面ごとの上書き)が門A を通って増えた(`V6-M0` 単位A。判定 = 限定採用)。
    // **`form` 型のビューでだけ書ける。****本 ADR の増分ではない。**
    // **【`V8-M20-T01` / 台帳 `J-G27` / 手続きは `ADR-0301` で 29 → 28 に更新した】** 19キー目
    // だった `audience`(この画面を見せる相手)が**廃止された**(判定 = 廃止)。**代わりに担うのは
    // `app.roles[].rules` の「役割 × 対象(画面)× 読取」である。****旧値の逐語は 29。**
    // **このリポジトリで語彙が減ったのはこれが初めてであり、増分ではなく減分である。**
    // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】期待値を 28 → 29 へ書き換えた。**
    // **旧行の逐語**: `expect(keys).toHaveLength(28);`
    // **書き換えた理由**: この行が固定していたのは「**その決定**が `$defs/view.properties` の本数 を増やさなかったこと」であり、
    // **29本目を足したのは別の決定である**(`V8-M8` が 集計表の宣言 `report` を29キー目として足した)。**検査は消していない。**
    // **【2026-08-20。`V10-M1-T02`。台帳 `NV-G4`。門A 本審査 = `V10-M0` 群A。ADR = `0359`】**
    // **期待値を 29 → 30 へ書き換えた。****旧行の逐語**: `expect(keys).toHaveLength(29);`
    // **30本目を足したのは別の決定である**(`ADR-0359` §4a 限定1 が削除後の行き先
    // `after_delete` を**末尾に**30キー目として足した。**`detail_view` でだけ書ける**)。
    // **本ファイルが測っている決定の増分ではない。****検査は消していない。**
    // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。門A 本審査 = `V10-M0` 群B。ADR = `0359` / `0360`】**
    // **期待値を 30 → 31 へ書き換えた。****旧行の逐語**: `expect(keys).toHaveLength(30);`
    // **31本目を足したのは別の決定である**(`ADR-0359` §4b 限定1 が一続きの流れの中の段
    // `flow` を**末尾に**31キー目として足した。**`list_view` / `form` / `detail_view` の3種別で
    // 書け、集計表(`report_view`)には書けない**)。
    // **本ファイルが測っている決定の増分ではない。****検査は消していない。**
    expect(keys).toHaveLength(31);
    // **【`V8-M20-T01` / 台帳 `J-G27` / `ADR-0301` で見る位置を1つ手前へ直した】** **19キー目だった
    // `audience` が廃止されたので、それより後ろのキーの添字が1つずつ繰り上がった。**
    // **期待値を緩めていない**(位置は今日も1つに固定される)。
    expect(keys[23]).toBe(KEY);
  });

  // 【`V5-M29-T04` / `ADR-0250` 限定10 + 限定11】ここにあった test を、ブロックごと消した。
  //   消したテスト名(逐語): 「$defs の本数 28 が1つも増えていない(値域をインラインで書く = 限定3 後半)」
  //   そのブロックが測っていたもの:
  //     - $defs の本数 28 が1つも増えていない(値域をインラインで書く = 限定3 後半)
  //   移し先は `scripts/vocabulary-drift.test.ts`(一覧の `manifest.$defs:` で始まる行)。
  //   **`expect()` が1つも残らないので空の test を残さなかった**(空の test は緑を返し、
  //   検出力0のまま `Ran` を水増しする)。
  //   **テスト名が持っていた日本語の宣言は、ここでリポジトリから消える**(`ADR-0250` §Decision 5 の (4))。

  // **【`V5-M29-T04` / `ADR-0250` 限定14 がテスト名を更新した】** 旧名(逐語)は
  // 「**$defs/theme 25・25 / $defs/field 11 / RESOURCE_KINDS 7 / FIELD_TYPES 8 / DIFF_OPS 16 が1つも動かない**」。
  // **`RESOURCE_KINDS` / `FIELD_TYPES` / `DIFF_OPS` の総量を固定していた3件を中央へ移したので、
  // この test に残るのは `$defs/theme` と `$defs/field`(どちらも8主題の外)だけである。**
  // **旧名の `$defs/field 11` は、消す前から本体が 12 を測っており食い違っていた。**
  test("$defs/theme 25・25 / $defs/field 12 が1つも動かない", () => {
    expect(Object.keys(defs().theme?.properties ?? {})).toHaveLength(25);
    expect(defs().theme?.required ?? []).toHaveLength(25);
    // **【V4-M19-T07 / ADR-0119 限定1 で 11 → 12 に更新した】** 12キー目 `hide_when_empty`
    // (値が無いとき行ごと出さない)が門A を通って増えた(V4-M19 単位E-a。2回目の審査。
    // 判定 = 限定採用)。**8型すべてに書けるキーである。****本 ADR の増分ではない。**
    // **【V6-M1-T01 / K-G1 / ADR-0288 限定1 で 12 → 13 に更新した】** 13キー目 `reference_picker`
    // (他のテーブルから選ぶ項目の選び方)が門A を通って増えた(V6-M0 単位A。判定 = 限定採用)。
    // **reference 型にだけ書けるキーである。****本 ADR の増分ではない。**
    // **【`V6-M3-T02` / `K-G7` / `ADR-0290` 限定1 で 13 → 14 に更新した】** 14キー目
    // `reference_search_fields`(参照候補の「探せる項目」の、項目ごとの上書き)が門A を通って
    // 増えた(`V6-M0` 単位B。判定 = 限定採用)。**`reference` 型にだけ書けるキーである。**
    // **本 ADR の増分ではない。**
    // **【`V8-M20-T01` / 台帳 `J-G27` / `J-G28` / 手続きは `ADR-0301` で 14 → 12 に更新した】**
    // 8キー目だった `audience`(この項目を見せる相手)と9キー目だった `writable_by`(この項目を
    // 書ける相手)が**2本とも廃止された**(判定 = 廃止)。**代わりに担うのは `app.roles[].rules` の
    // 「役割 × 対象(項目)× 読取 / 書込」である。****旧値の逐語は 14。**
    expect(Object.keys(defs().field?.properties ?? {})).toHaveLength(12);
    // 【`V5-M29-T04` / `ADR-0250` 限定11】ここにあった「$defs/theme 25・25 / $defs/field 11 / RESOURCE_KINDS 7 / FIELD_TYPES 8 / DIFF_OPS 16 が1つも動かない」の検査は
    //   `scripts/vocabulary-drift.test.ts` へ移した(名前の一覧は `scripts/vocabulary-snapshot.txt` の
    //   `RESOURCE_KINDS:` で始まる行)。**総量ではなく名前と順序で見張る。**
    //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
    // 【`V5-M29-T04` / `ADR-0250` 限定11】ここにあった「$defs/theme 25・25 / $defs/field 11 / RESOURCE_KINDS 7 / FIELD_TYPES 8 / DIFF_OPS 16 が1つも動かない」の検査は
    //   `scripts/vocabulary-drift.test.ts` へ移した(名前の一覧は `scripts/vocabulary-snapshot.txt` の
    //   `FIELD_TYPES:` で始まる行)。**総量ではなく名前と順序で見張る。**
    //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
    // 【`V5-M29-T04` / `ADR-0250` 限定11】ここにあった「$defs/theme 25・25 / $defs/field 11 / RESOURCE_KINDS 7 / FIELD_TYPES 8 / DIFF_OPS 16 が1つも動かない」の検査は
    //   `scripts/vocabulary-drift.test.ts` へ移した(名前の一覧は `scripts/vocabulary-snapshot.txt` の
    //   `DIFF_OPS:` で始まる行)。**総量ではなく名前と順序で見張る。**
    //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
  });
});

// ---------------------------------------------------------------------------
// 限定3: 値は段階値の enum だけ。自由な整数を1つも受けない
// ---------------------------------------------------------------------------

describe("(T05-3) 値は4つの段階値だけ(ADR-0113 限定3)", () => {
  test("enum は 10 / 20 / 50 / 100 の4値で、minimum / maximum / pattern を1つも書いていない", () => {
    const property = viewSchema().properties[KEY] as Record<string, unknown>;
    expect(property.enum).toEqual([10, 20, 50, 100]);
    expect(property.minimum).toBeUndefined();
    expect(property.maximum).toBeUndefined();
    expect(property.pattern).toBeUndefined();
  });

  test("4値はすべて通る", () => {
    for (const value of [10, 20, 50, 100]) {
      expect(
        validateManifestFull(baseManifest([listView({ [KEY]: value } as never)])),
        String(value),
      ).toEqual({ valid: true });
    }
  });

  test("範囲内でも enum に無い整数は拒否される(自由な整数を1つも受けない)", () => {
    for (const value of [1, 25, 30, 49, 51, 99, 101, 0, -10]) {
      expect(
        validateManifest(baseManifest([listView({ [KEY]: value } as never)])).valid,
        String(value),
      ).toBe(false);
    }
  });

  test("文字列・小数・真偽値・配列も拒否される", () => {
    for (const value of ["50", 50.5, true, [50], { size: 50 }, null]) {
      expect(
        validateManifest(baseManifest([listView({ [KEY]: value } as never)])).valid,
        JSON.stringify(value),
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 限定4 / 限定5 / 限定6: ページ位置・cursor / keyset・total は1バイトも触らない
// ---------------------------------------------------------------------------

describe("(T05-4) ページ位置のキーを1本も足さない(ADR-0113 限定4・限定5)", () => {
  test("マニフェストのスキーマに offset / page / cursor / keyset というキーが1本も無い", async () => {
    const source = await Bun.file(
      new URL("../../schemas/manifest.schema.json", import.meta.url),
    ).text();
    /*
     * **照合するのは「キーの形("...")」であって、素の単語ではない。**
     *
     * **理由を隠さない**: 本タスクが足した `page_size` の `$comment` は、**「ページ位置の
     * キーを1本も足していない」ことを説明するために `offset` という語を散文で含む。**
     * **素の単語で照合すると、この説明文そのものが赤くなる。**
     *
     * **これは先例と同じ読み方である** —— `docs/plan/v4/records/v4-m22.md` §1-4 (11) が
     * `grep -c '"limit"' schemas/manifest.schema.json` → **0** を測り、
     * **「`limit` の生ヒット1件は `:657` の `$comment` 中の英単語 `limitation` である」**と
     * 明記している。**キーの形で数えるのが、この製品が既に採っている作法である。**
     */
    for (const forbidden of ['"offset"', '"page"', '"cursor"', '"keyset"']) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  test("$defs/view のキーに、位置を表すものが1つも無い", () => {
    const keys = Object.keys(viewSchema().properties);
    for (const forbidden of ["offset", "page", "cursor", "current_page", "total_pages"]) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });

  test("件数のキーは1本だけである(2つ目を足していない)", () => {
    const keys = Object.keys(viewSchema().properties);
    for (const forbidden of ["min_rows", "max_rows", "limit", "show_all"]) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
    expect(keys.filter((key) => key === KEY)).toHaveLength(1);
  });
});

describe("(T05-6) total は今日どおり集約カウントのまま(ADR-0113 限定6)", () => {
  test("countRecords を1バイトも触っていない(署名が着手前のまま)", async () => {
    const source = await Bun.file(new URL("./records.ts", import.meta.url)).text();
    expect(source).toContain("export function countRecords(");
    // **推定・近似・キャッシュを1つも作っていない。**
    for (const forbidden of ["estimatedTotal", "approximateTotal", "cachedTotal"]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// 限定7: `list_view` 分岐でだけ許す
// ---------------------------------------------------------------------------

describe("(T05-7) 書けるのは list_view だけ(ADR-0113 限定7)", () => {
  test("form / detail_view の分岐で false になっている", () => {
    const branches = viewSchema().allOf;
    for (const type of ["form", "detail_view"]) {
      const branch = branches.find(
        (candidate) =>
          ((candidate.if as { properties?: { type?: { const?: string } } }).properties?.type
            ?.const ?? "") === type,
      );
      expect(branch?.then.properties?.[KEY], type).toBe(false);
    }
  });

  test("form に書くと差分全体が拒否される", () => {
    const result = validateManifest(
      baseManifest([
        { id: "order-form", type: "form", table: "orders", fields: ["memo"], [KEY]: 20 } as never,
      ]),
    );
    expect(result.valid).toBe(false);
  });

  test("detail_view に書くと差分全体が拒否される", () => {
    const result = validateManifest(
      baseManifest([
        { id: "order-detail", type: "detail_view", table: "orders", [KEY]: 20 } as never,
      ]),
    );
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 限定8: `related`(子一覧)に1バイトも当たらない
// ---------------------------------------------------------------------------

describe("(T05-8) related に1バイトも当たらない(ADR-0113 限定8 / ADR-0081 限定6 不可侵)", () => {
  test("related の items のプロパティに件数もページ位置も1本も無い", () => {
    // **`view.related` は `$defs/related_list` への `$ref` である**(値域の定義を二重に
    // 持たない作法)。**当たり先は `$defs` の側なので、そこを直に読む。**
    expect(viewSchema().properties.related).toEqual({
      $comment: (viewSchema().properties.related as { $comment: string }).$comment,
      $ref: "#/$defs/related_list",
    });
    const relatedList = defs().related_list as unknown as {
      items: { properties: Record<string, unknown> };
    };
    const keys = Object.keys(relatedList.items.properties);
    for (const forbidden of [KEY, "limit", "offset", "page"]) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// 限定10: 既定は 50。書かなかった画面は今日と1ピクセルも変わらない
// ---------------------------------------------------------------------------

describe("(T05-10) 既定は 50(ADR-0113 限定10)", () => {
  test("本キーは必須ではなく、書かないマニフェストが今日どおり通る", () => {
    const required = (viewSchema() as unknown as { required?: string[] }).required ?? [];
    expect(required).not.toContain(KEY);
    expect(validateManifestFull(baseManifest([listView()]))).toEqual({ valid: true });
  });

  test("schema に default を書いていない(既定は表示層の1箇所が持つ)", () => {
    // **既定を2箇所に住まわせない** —— schema に `default` を書くと「書かれた値」と
    // 「既定」の区別が畳み込みの段階で消えうる(`ADR-0051` 限定4 と同じ理由)。
    const property = viewSchema().properties[KEY] as Record<string, unknown>;
    expect(property.default).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 限定2: view_changes にも同じキーを1本 / カーネルが値を実際に運ぶ
// ---------------------------------------------------------------------------

describe("(T05-2) update_view で後から書けて、値が実際に運ばれる(ADR-0113 限定2)", () => {
  // **【V4-M19-T03 / ADR-0118 限定1 で 19 → 20 に更新した】** 20キー目 `preset_density`
  // (画面の詰まり具合)が門A を通って増えた(V4-M19 単位C。2回目の審査。判定 = 限定採用)。
  // **3種すべてに書けるキーである。****本 ADR の増分ではない。**
  // **【V4-M20-T04 / ADR-0102 限定2 で 20 → 21 に更新した】** 21キー目 `after_save` が
  // `update_view` にも加わった(値は `applyViewChanges` の `form` 分岐が実際に運ぶ)。
  // **本 ADR の増分ではない。**
  // **【V4-M23-T01 / ADR-0104 限定採用で 21 → 22 に更新した】** 22キー目 `sum_field`
  // (合計を出す列。`list_view` でだけ書ける)が `update_view` にも加わった(値は
  // `applyViewChanges` の `list_view` 分岐が実際に運ぶ)。**本 ADR の増分ではない。**
  test("diff.schema.json の view_changes が19本になっている", () => {
    const changes = (diffSchema as unknown as { $defs: { view_changes: { properties: object } } })
      .$defs.view_changes.properties;
    const keys = Object.keys(changes);
    // **【`V6-M2-T02` / `K-G3` / `ADR-0289` 限定1 で 23 → 24 に更新した】** 24キー目 `reference_pickers`
    // (参照項目の選び方の、入力画面ごとの上書き。`form` でだけ書ける)が `update_view` にも加わった
    // (値は `applyViewChanges` の `form` 分岐が実際に運ぶ)。**本 ADR の増分ではない。**
    // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】期待値を 24 → 25 へ書き換えた。**
    // **旧行の逐語**: `expect(keys).toHaveLength(24);`
    // **書き換えた理由**: この行が固定していたのは「**その決定**が `view_changes.properties` の本数 を増やさなかったこと」であり、
    // **25本目を足したのは別の決定である**(`V8-M8` が 集計表の宣言 `report` を25キー目として足した)。**検査は消していない。**
    // **【2026-08-20。`V10-M1-T02`。台帳 `NV-G4`。ADR = `0359` §Decision 2】**
    // **期待値を 25 → 26 へ書き換えた。****旧行の逐語**: `expect(keys).toHaveLength(25);`
    // **26本目を足したのは別の決定である**(`after_delete` を `view_changes` の末尾に足した)。
    // **本ファイルが測っている決定の増分ではない。****検査は消していない。**
    // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。門A 本審査 = `V10-M0` 群B。ADR = `0359` / `0360`】**
    // **期待値を 26 → 27 へ書き換えた。****旧行の逐語**: `expect(keys).toHaveLength(26);`
    // **27本目を足したのは別の決定である**(`flow` を `view_changes` の末尾に足した。
    // `ADR-0359` §Decision 2)。**本ファイルが測っている決定の増分ではない。**
    // **検査は消していない。**
    expect(keys).toHaveLength(27);
    expect(keys[18]).toBe(KEY);
  });

  /** `applyDiff` と**同じ順序**で畳み込みと検証を行う。 */
  function fold(current: Manifest, changes: Record<string, unknown>, view = "order-list") {
    const folded = foldOperations(current, [{ op: "update_view", view, changes } as never]);
    if (!folded.valid) {
      return { valid: false as const, manifest: undefined };
    }
    const validated = validateManifestFull(folded.manifest);
    return validated.valid
      ? { valid: true as const, manifest: folded.manifest }
      : { valid: false as const, manifest: undefined };
  }

  test("値がマニフェストへ運ばれる(「キーは在るが効かない」穴を踏まない)", () => {
    const result = fold(baseManifest([listView()]), { [KEY]: 20 });
    expect(result.valid).toBe(true);
    const view = result.manifest?.app.views.find((candidate) => candidate.id === "order-list");
    expect((view as unknown as Record<string, unknown>)[KEY]).toBe(20);
  });

  test("update_view で form に書こうとすると拒否される", () => {
    const current = baseManifest([
      { id: "order-form", type: "form", table: "orders", fields: ["memo"] } as unknown as View,
    ]);
    expect(fold(current, { [KEY]: 20 }, "order-form").valid).toBe(false);
  });

  test("update_view でも enum の外は拒否される", () => {
    expect(fold(baseManifest([listView()]), { [KEY]: 25 }).valid).toBe(false);
  });

  test("書かなかったキーは触られない(キー単位の差し替えである)", () => {
    const current = baseManifest([listView({ [KEY]: 20 } as never)]);
    const result = fold(current, { name: "注文一覧" });
    expect(result.valid).toBe(true);
    const view = result.manifest?.app.views.find((candidate) => candidate.id === "order-list");
    expect((view as unknown as Record<string, unknown>)[KEY]).toBe(20);
  });

  test("search_fields と page_size は互いに独立して差し替わる(同じ V4-M22 の2キー)", () => {
    const current = baseManifest([listView({ search_fields: ["memo"] } as never)]);
    const result = fold(current, { [KEY]: 100 });
    expect(result.valid).toBe(true);
    const view = result.manifest?.app.views.find((candidate) => candidate.id === "order-list") as
      | Record<string, unknown>
      | undefined;
    expect(view?.[KEY]).toBe(100);
    expect(view?.search_fields).toEqual(["memo"]);
  });
});
