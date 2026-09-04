/**
 * 越えてはならない線の機械検査(V3-M2-T05)。
 *
 * 完了条件の正は `docs/plan/v3/records/v3-m2.md` §2 の「V3-M2-T05」節の5、
 * 限定の正は `docs/adr/0050-view-display-presets.md` §3 の限定1 / 5 / 9 / 10 / 11 と
 * `docs/adr/0051-layout-ledger-f5.md` §3 の限定2、改訂の出所は
 * `docs/adr/0052-preset-declaration-revision.md`。
 *
 * ## この5群が何を守るのか
 *
 * | # | 検査 | 守るもの |
 * |---|---|---|
 * | (i) | schema 側の enum が有限であること(**9軸24値の全量を列挙固定**) | 「値を1つ足す」を黙って通さない(限定1) |
 * | (ii) | `web/src/styles.css` に座標・重ね順・切り替え機構・自由な px が現れないこと | 「規則を1本足す」で線を越えるのを止める(限定9 / 限定11) |
 * | (iii) | **CSS のバイト列**を受ける口が schema に無いこと | **CSS そのものを語彙側に持ち込めない**(限定11 / ADR-0051 限定2 / **ADR-0055 限定2**) |
 * | (iv) | `data-app-id` / `data-view-id` が0件であること | **アプリ固有のセレクタを書く手段そのものを作らない**(限定5 = 経路B) |
 * | (v) | **表示関数と `ViewRendererProps` の引数の集合** | **8つ目の引数を黙って足せないようにする**(限定10) |
 *
 * ## 拒否リストを作っていない(ADR-0013 限定13)
 *
 * **ここで検査しているのは「enum が有限であること」と「禁じた宣言が CSS に現れないこと」で
 * あって、実行時に弾く値の一覧ではない。** 実行時に不正な値を落とすのは schema の `enum` と
 * `additionalProperties: false` であり、本ファイルはその形が崩れていないことだけを見る。
 * **「書いてはいけない文字・記法の一覧」をカーネルにも表示層にも持っていない。**
 *
 * ## 限界(先に書く。憲法6)
 *
 * 1. **軸7(`preset_text_preview`)だけは DOM に属性が出ない。** この軸は CSS では実装できず
 *    (`web/src/fields/display.tsx` が切り詰め後の文字列しか DOM に出さない)、表示関数の
 *    引数として渡る(ADR-0050 限定10)。**したがって本ファイルが軸7 に当てられるのは (i) の
 *    型の検査だけであり、(ii) の CSS 側の検査には当たり先が無い。** 軸7 が実際に効くことの
 *    実測は `web/e2e/preset.e2e.ts` の (viii)(描かれた文字数を chromium で数える)にある。
 * 2. **本ファイルは CSS のテキストと JSON しか見ない。** 描画は見ていない(そちらは
 *    `web/e2e/preset.e2e.ts`)。**「規則が実際に当たる」ことは本ファイルでは証明できない。**
 * 3. **(iv) は「今日0件である」ことしか言えない。** 画面を指す属性を新設する変更を
 *    止めるのは本検査だが、**別名(`data-screen` 等)で作られたら気づかない。**
 * 4. **(v) はソーステキストの検査であって型検査ではない。** 正規表現で引数名を数えているので、
 *    次の経路は捕まえられない —— **(a)** 引数の型を別名(`type Props = { … }`)へ切り出して
 *    そちらに増やす **(b)** スプレッド(`...rest`)や交差型(`A & B`)で増やす
 *    **(c)** `FieldValue` / `FieldCell` 以外の新しい表示関数を作ってそちらで受け取る。
 *    **捕まえられるのは「同じ関数の引数リストに1つ足す」という、いちばん起こりやすい経路だけである。**
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HANDWRITTEN_SOURCES, readStyleSource } from "./style-source-set.ts";

/**
 * 移した公開単位の根(`apps/smailtalk/`)。`src` / `web` / `schemas` はこの下に在る。
 * **`import.meta.dir` から数える**(cwd 相対だと `bun test` を打つ場所で結果が変わる)。
 */
const PRODUCT_ROOT = dirname(dirname(import.meta.dir));
const MANIFEST_SCHEMA_PATH = join(PRODUCT_ROOT, "schemas", "manifest.schema.json");
const DIFF_SCHEMA_PATH = join(PRODUCT_ROOT, "schemas", "diff.schema.json");

// biome-ignore lint/suspicious/noExplicitAny: 正準スキーマの構造を動的に辿るため
type Any = any;

function readJson(path: string): Any {
  return JSON.parse(readFileSync(path, "utf-8")) as Any;
}

/**
 * **読む対象は「ファイル名1つ」ではなく「配られる CSS の集合のうち手で書く側」である**
 * (`V4-M15-T02`。`ADR-0088` 限定2)。**着手前は
 * `const css = readFileSync(STYLES_PATH, "utf-8");` の1行だった。**
 *
 * **【正直に書く。射程は縮んだ】** **(ii) の4本が当たるのは手で書く側だけであり、
 * 部品体系のビルド出力には当たらない。** `ADR-0087` 総括の禁止7 の逐語
 * 「**部品体系の生成物は座標系プロパティを含みうる。禁止が及ぶのは手で書く CSS だけであり、
 * 射程は縮む。縮んだことを書かずに「守った」と書かない。**」に従う。
 * **【禁止】「歯止めを守ったまま実装した」と書かない。**
 */
const css = HANDWRITTEN_SOURCES.map(readStyleSource).join("\n");

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

// ---------------------------------------------------------------------------
// (i) schema 側の enum が有限であること —— 9軸24値の全量を列挙固定する
// ---------------------------------------------------------------------------

/**
 * **8軸22値の全量。** ADR-0050 限定1 が列挙固定したものと1対1でなければならない
 * (`ADR-0085` 限定1 が軸7 の値域だけを 3 → 4 にし、**`ADR-0093` 限定1 / 限定3 が
 * 8つ目の軸を1本足した**)。
 *
 * **数え方**: 3 + 3 + 3 + 2 + 2 + 3 + 4 + 2 = 22。**この表に値を1つ足す変更は、
 * ADR-0050 §3a 3 の門A を通していないかぎり赤のままにする。**
 *
 * **【V4-M19-T03 / ADR-0118 限定1・限定3 で 8軸22値 → 9軸24値に更新した】** `V4-M19` 単位C
 * (2回目の審査。前回 = `V4-M14` 単位7 は却下)が **9つ目の軸** `preset_density`(画面の詰まり具合)
 * を限定採用した(判定 = 限定採用 / 審査記録 =
 * `docs/plan/v4/records/v4-m19-gate-a-view-density.md` / ADR =
 * `docs/adr/0118-view-density-preset.md`。限定1 =「足すキーは `$defs/view` に1本だけ」/
 * 限定3 =「値域は `comfortable` / `compact` の2値だけ」)。**旧文を1バイトも消していない。**
 * **数え方は 3 + 3 + 3 + 2 + 2 + 3 + 4 + 2 + 2 = 24 になる。**
 */
const PRESET_ENUMS: Record<string, readonly (string | number)[]> = {
  preset_column_align: ["left", "center", "right"],
  preset_column_width: ["narrow", "standard", "wide"],
  preset_pager_position: ["top", "bottom", "both"],
  preset_label_placement: ["inline", "stacked"],
  preset_field_columns: [1, 2],
  preset_image_size: ["thumbnail", "medium", "original"],
  // **【V4-M10-T36 / `E-G13` / ADR-0085 限定1】値域が 3 → 4 になった**(4値目 `full` =
  // 切らない)。**軸は7軸のままで、選択肢の総数が 19 → 20 になった**(限定3)。
  // **列挙を消して件数に丸めない。**
  preset_text_preview: ["short", "standard", "long", "full"],
  /*
   * **【V4-M16-T13 / `P-G24` の (C) 側 / ADR-0093 限定1・限定3 が足した8つ目の軸】**
   *
   * **「テストが落ちたから直した」のではない。** **`V4-M14` 本審査② の単位11 が `P-G24` を
   * 限定採用した** —— **判定 = 限定採用 / 審査記録 =
   * `docs/plan/v4/records/v4-m14-gate-a-list-shape.md` / ADR =
   * `docs/adr/0093-list-view-shape.md`**(限定1 =「足すキーは `$defs/view` に1本だけ。
   * 8つ目の `preset_` キー」/ 限定3 =「値域は `table` / `card` の2値だけ」)。
   * **門A を通った1軸は列挙を更新して通す**(`ADR-0085` が軸7 の値域を更新した作法と同型)。
   *
   * **`ADR-0050` §3a 3 の問いには `ADR-0093` §Context 5 が3点で答えており、
   * 当たり先(`.list-cards` / `.list-card` / `.list-card-field` / `.list-card-label` の
   * 4規則)は宣言と同じ差分で実在させた**(限定6。実測は `web/test/list-view-shape.test.tsx`
   * の (e))。**当たり先の無い enum 値を1つも置いていない。**
   *
   * **3値目(グリッド / カンバン / カレンダー / タイムライン)を1つも足していない。**
   * **9つ目のキーを足す提案は `ADR-0050` §3a 3 の門A を改めて通すこと** ——
   * **`ADR-0093` を根拠にできない**(同 §Decision 3 の 6)。
   */
  preset_list_shape: ["table", "card"],
  /*
   * **【V4-M19-T03 / `P-G32` の (C) 側 / ADR-0118 限定1・限定3 が足した9つ目の軸】**
   *
   * **「テストが落ちたから直した」のではない。** `V4-M19` 単位C(2回目の審査。前回 = `V4-M14`
   * 単位7 は却下)が `P-G32` を**限定採用**した —— **判定 = 限定採用 / 審査記録 =
   * `docs/plan/v4/records/v4-m19-gate-a-view-density.md` / ADR =
   * `docs/adr/0118-view-density-preset.md`**(限定1 =「足すキーは `$defs/view` に1本だけ。
   * 9つ目の `preset_` キー」/ 限定3 =「値域は `comfortable` / `compact` の2値だけ」)。
   * **門A を通った1軸は列挙を更新して通す**(`ADR-0093` が8つ目の軸を足した作法と同型)。
   *
   * **当たり先は2値それぞれについて実在する**(限定6。`comfortable` = `web/src/ui/family.ts`
   * の `DEFAULT_UI_FAMILY` が指す既定の描画、`compact` = Tailwind の
   * `group-data-[ui-family=compact]/ui:` 変種)。**当たり先の無い enum 値を1つも置いていない。**
   *
   * **3値目を1つも足していない。** **10個目のキーを足す提案は `ADR-0050` §3a 3 の門A を
   * 改めて通すこと** —— **`ADR-0118` を根拠にできない**(同 §Decision 4)。
   * **3種すべて(list_view / form / detail_view)に書ける唯一の軸である**
   * (`$defs/view` の `allOf` のどの分岐でも `false` にしていない)。
   */
  preset_density: ["comfortable", "compact"],
};

/** 列ごとのマップになっている2軸(値は `additionalProperties` の側にある)。 */
const MAP_AXES = new Set(["preset_column_align", "preset_column_width"]);

test("(i) $defs/view のプリセットキーは9つちょうどで、名前が ADR-0050 限定1 + ADR-0093 + ADR-0118 と一致する", () => {
  const viewProperties = readJson(MANIFEST_SCHEMA_PATH).$defs.view.properties;
  const presetKeys = Object.keys(viewProperties)
    .filter((key) => key.startsWith("preset_"))
    .sort();
  expect(presetKeys).toEqual(Object.keys(PRESET_ENUMS).sort());
  // **【V4-M16-T13 / ADR-0093 限定1 で 7 → 8 に更新した】** 着手前は逐語
  // `expect(presetKeys.length).toBe(7);` で、直上のコメントは「**8つ目のキーを足したら
  // 赤くなる。**」だった。**8つ目を足したのは門A の判定である**(判定 = 限定採用 /
  // 審査記録 = `docs/plan/v4/records/v4-m14-gate-a-list-shape.md` / ADR =
  // `docs/adr/0093-list-view-shape.md`)。**旧文を1バイトも消していない。**
  // **9つ目のキーを足したら赤くなる。** 消しても赤くなる(両向き)。
  // **【V4-M19-T03 / ADR-0118 限定1 で 8 → 9 に更新した】** `V4-M19` 単位C(2回目の審査)が
  // 9つ目の `preset_` キー `preset_density`(画面の詰まり具合)を足した。**本ファイルの
  // 数え上げそのものは ADR-0118 の増分であり、他のどの ADR の増分でもない。**
  // **10個目のキーを足したら赤くなる。** 消しても赤くなる(両向き)。
  expect(presetKeys.length).toBe(9);
});

test("(i) 9軸の値域はすべて有限 enum で、値の全量が24である", () => {
  const viewProperties = readJson(MANIFEST_SCHEMA_PATH).$defs.view.properties;
  let total = 0;
  for (const [key, expected] of Object.entries(PRESET_ENUMS)) {
    const schema = viewProperties[key];
    expect(schema, key).toBeDefined();
    const valueSchema = MAP_AXES.has(key) ? schema.additionalProperties : schema;
    // **自由な文字列も自由な数値も1つも受けない**(限定11)—— 値域は必ず `enum` である。
    expect(valueSchema.enum, key).toBeDefined();
    expect(valueSchema.enum, key).toEqual(expected);
    total += (valueSchema.enum as unknown[]).length;
    // 列ごとのマップは**キーも自由文字列ではない**(`$defs/resource_id` の形に閉じる)。
    if (MAP_AXES.has(key)) {
      expect(schema.type, key).toBe("object");
      expect(schema.propertyNames?.$ref, key).toBe("#/$defs/resource_id");
    }
  }
  // **8軸22値。** 値を1つ足す/減らすと落ちる。
  // **【V4-M16-T13 / ADR-0093 限定3 で 20 → 22 に更新した】** 着手前は逐語
  // `expect(total).toBe(20);` で、直上のコメントは「**7軸20値。**」だった。
  // **増えたのは8つ目の軸の2値ぶんだけで、既存7軸の enum に1値も足していない。**
  // **【V4-M19-T03 / ADR-0118 限定3 で 22 → 24 に更新した】** 着手前は逐語
  // `expect(total).toBe(22);` だった。**増えたのは9つ目の軸(`preset_density`)の2値ぶん
  // だけで、既存8軸の enum に1値も足していない。**
  expect(total).toBe(24);
});

test("(i) view_changes 側は9軸とも manifest の定義を $ref で共有し、値域が二重管理になっていない", () => {
  const changes = readJson(DIFF_SCHEMA_PATH).$defs.view_changes.properties;
  for (const key of Object.keys(PRESET_ENUMS)) {
    const schema = changes[key];
    expect(schema, key).toBeDefined();
    // **差し替え経路が独自の値域を持たない。** 値の集合は上のテストが固定した1箇所にしかなく、
    // 「マニフェストには書けないが update_view でなら書ける値」を作れない。
    expect(schema.$ref, key).toBe(
      `https://smailtalk.dev/schemas/manifest.schema.json#/$defs/view/properties/${key}`,
    );
    expect(
      Object.keys(schema).filter((name) => name !== "$ref" && name !== "$comment"),
      key,
    ).toEqual([]);
  }
  // 未知キーを書けない形が崩れていないこと(限定2)。
  expect(readJson(DIFF_SCHEMA_PATH).$defs.view_changes.additionalProperties).toBe(false);
  expect(readJson(MANIFEST_SCHEMA_PATH).$defs.view.additionalProperties).toBe(false);
});

// ---------------------------------------------------------------------------
// (ii) `web/src/styles.css` に越えてはならない宣言が現れないこと
// ---------------------------------------------------------------------------

test("(ii) styles.css に position / z-index / 座標のプロパティが1つも現れない", () => {
  const body = stripComments(css);
  // **宣言のプロパティ名としての出現だけを見る**(`margin-left` の `left` を拾わないよう、
  // プロパティの先頭であることを要求する)。
  for (const property of [
    "position",
    "z-index",
    "top",
    "left",
    "right",
    "bottom",
    "inset",
    "float",
    "transform",
  ]) {
    const pattern = new RegExp(`(^|[;{])\\s*${property}\\s*:`, "m");
    expect(pattern.test(body), property).toBe(false);
  }
});

test("(ii) 手で書く側に、幅の条件以外の at-rule / 配色設定のメディア特性 / テーマ切り替えの属性セレクタが無い", () => {
  // **【V4-M15-T07 で1行だけ書き換えた。ADR-0089 限定5】**
  //
  // **着手前の3行は次のとおりだった**(2026-08-03 実測):
  //   expect(css).not.toContain("@");                     // :172
  //   expect(css).not.toContain("prefers-color-scheme");  // :173
  //   expect(css).not.toContain("[data-theme]");          // :174
  //
  // **書き換えたのは `:172` の1行だけである。** `:173` / `:174` の2行は
  // **1バイトも変えずに残してある** —— `ADR-0089` 限定5 の逐語
  // 「**`:172` の `@` の行を書き換えるときに、この2行を一緒に落とさない**」。
  // **【禁止】残り2行を黙って落とさない。**
  //
  // **`ADR-0046` 限定5 を緩めている。緩めていないふりをしない**(`ADR-0089` §Context 2)。
  // 緩めたのは「幅の条件のメディアクエリ」の分だけである。
  const body = stripComments(css);
  const atRuleNames = [...body.matchAll(/@([a-zA-Z-]+)/g)].map((match) => match[1]);
  // **通すのは `@media` だけ**(`ADR-0089` 限定2)。
  expect([...new Set(atRuleNames)].sort()).toEqual(["media"]);
  // **通すのは幅の条件だけ**(`ADR-0089` 限定1)。条件の全量を列挙固定する。
  const conditions = [...body.matchAll(/@media([^{]*)\{/g)].map((match) =>
    (match[1] ?? "").trim().replace(/\s+/g, ""),
  );
  expect([...new Set(conditions)].sort()).toEqual(["(min-width:40rem)", "(min-width:64rem)"]);

  // **以下の2行は着手前から1バイトも変えていない。**
  expect(css).not.toContain("prefers-color-scheme");
  expect(css).not.toContain("[data-theme]");
});

test("(ii) px リテラルは :root のスロット定義の中にしか無い(自由な px 座標が無い)", () => {
  const body = stripComments(css);
  const rootStart = body.indexOf(":root {");
  expect(rootStart).toBeGreaterThan(-1);
  const rootEnd = body.indexOf("}", rootStart);
  expect(rootEnd).toBeGreaterThan(rootStart);
  for (const match of body.matchAll(/[0-9.]+px/g)) {
    const at = match.index ?? -1;
    // **スロットの実値(枠線の太さ・フォーカスリングの太さ)以外に px を書かない。**
    // プリセットの段階値は `rem` で書いてあり、座標は1つも無い。
    expect(at > rootStart && at < rootEnd, `${match[0]} at ${at}`).toBe(true);
  }
});

test("(ii) プリセットの規則のセレクタにアプリID・画面ID・フィールドIDが現れない", () => {
  const body = stripComments(css);
  // `data-preset-*` を含む規則のセレクタだけを取り出す。
  const selectors = [...body.matchAll(/([^{}]+)\{[^{}]*\}/g)]
    .map((match) => (match[1] ?? "").trim())
    .filter((selector) => selector.includes("data-preset-"));
  expect(selectors.length).toBeGreaterThan(0);
  for (const selector of selectors) {
    // 属性値に入るのは enum の1要素だけである(ADR-0050 §2 (b) の論証1)。
    for (const value of [...selector.matchAll(/data-preset-[a-z]+="([^"]+)"/g)]) {
      const literal = value[1] as string;
      const known = Object.values(PRESET_ENUMS).some((values) =>
        values.some((candidate) => String(candidate) === literal),
      );
      expect(known, `${selector} の ${literal}`).toBe(true);
    }
    expect(selector, selector).not.toContain("data-app-id");
    expect(selector, selector).not.toContain("data-view-id");
  }
});

// ---------------------------------------------------------------------------
// (iii) **CSS のバイト列**を受ける口が schema に無いこと
//
// **【2026-07-27。V3-M5-T05 が意味を書き直した。ADR-0055 限定2】**
//
// **旧の意味**: 「任意 CSS 文字列を受ける口が schema に無いこと」= **逃げ道を語彙側に
// 開けない**(ADR-0050 限定11 / ADR-0051 限定2)。
//
// **なぜ書き直すのか**: **V3-M5 で逃げ道が門A を通り、`$defs/view` に18キー目
// `custom_css` が入った**(ADR-0055 限定1)。**「逃げ道を語彙側に開けない」という旧の
// 意味は、その時点で成立しなくなった** —— 開いたのは審査の判定である。
//
// **弱めていない。守る対象を書き直しただけである**: **今日も守るのは「CSS の**バイト列**を
// 受ける口が1つも無いこと」**である。**`custom_css` は本検査に抵触しない** —— 受けるのは
// 資産名(`resource_id` の `$ref`)と sha256 の16進64文字の2要素だけで、
// `additionalProperties: false` で閉じており、**自由文字列を受ける場所が1つも無い**
// (形の全量は `src/kernel/validate.test.ts` の「限定2」2本が固定している)。
// **したがって禁止キー名の一覧も、`"format": "css"` の禁止も、1つも外していない。**
// **むしろ下に2本足した** —— **`/css/` に当たるキーが `custom_css` ただ1つであること**と、
// **その値域に自由文字列が1つも無いこと**を、ここでも見る(限定1 の「2つ目を足さない」の
// 表示層側の写し。**19キー目が「逃げ道の色違い」として黙って入るのを止める**)。
// ---------------------------------------------------------------------------

test("(iii) マニフェスト・差分スキーマに CSS のバイト列 / スタイル文字列を受けるキーが無い", () => {
  for (const path of [MANIFEST_SCHEMA_PATH, DIFF_SCHEMA_PATH]) {
    const text = readFileSync(path, "utf-8");
    const schema = readJson(path);
    const keys: string[] = [];
    const walk = (node: Any): void => {
      if (node === null || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      for (const [key, value] of Object.entries(node)) {
        keys.push(key);
        walk(value);
      }
    };
    walk(schema);
    // **「css」「style」「class」「inline」という名前のキーを1つも作らない。**
    // (`$comment` の散文には現れるので、キー名だけを見る。)
    // **`custom_css` はこの一覧のどれとも一致しない**(完全一致で見ているため)—— それは
    // 偶然ではなく、**この一覧が禁じているのは「CSS そのものを入れる箱」だから**である。
    for (const forbidden of ["css", "style", "styles", "class", "className", "inline_style"]) {
      expect(keys, `${path} の ${forbidden}`).not.toContain(forbidden);
    }
    // 生の JSON にも `"format": "css"` のような逃げ道が無いこと。
    expect(text).not.toContain('"format": "css"');
  }
});

test("(iii) 逃げ道に当たるキーは custom_css ただ1つで、その値域に自由文字列が1つも無い", () => {
  // **限定1 の「2つ目を足さない」を、プリセットの境界検査の側からも見る。**
  const manifest = readJson(MANIFEST_SCHEMA_PATH);
  const cssKeys = Object.keys(manifest.$defs.view.properties).filter((key: string) =>
    /css|style|escape|hatch/.test(key),
  );
  expect(cssKeys).toEqual(["custom_css"]);
  // `$defs/app` と `$defs/theme` の側にも生えていないこと(アプリ単位・テーマ単位を作らない)。
  for (const def of ["app", "theme"]) {
    const properties = Object.keys(manifest.$defs[def].properties);
    expect(
      properties.filter((key: string) => /css|style|escape|hatch/.test(key)),
      def,
    ).toEqual([]);
  }
  // **形で縛る**(長さではない)—— 2要素・追加キー不可・どちらも自由文字列ではない。
  const reference = manifest.$defs.view.properties.custom_css;
  expect(reference.type).toBe("object");
  expect(reference.additionalProperties).toBe(false);
  expect(Object.keys(reference.properties).sort()).toEqual(["asset", "digest"]);
  // 資産名は既存の `resource_id` を `$ref` する(その場に自由文字列の定義を置かない)。
  expect(reference.properties.asset.$ref).toBe("#/$defs/resource_id");
  // ダイジェストは sha256 の16進64文字ちょうどにしか一致しない(= CSS を入れられない)。
  expect(reference.properties.digest.pattern).toBe("^[0-9a-f]{64}$");
  expect(reference.properties.digest.minLength).toBeUndefined();
});

test("(iii) プリセットの値域に自由文字列(enum なしの string / pattern だけの string)が無い", () => {
  const viewProperties = readJson(MANIFEST_SCHEMA_PATH).$defs.view.properties;
  for (const key of Object.keys(PRESET_ENUMS)) {
    const schema = viewProperties[key];
    const valueSchema = MAP_AXES.has(key) ? schema.additionalProperties : schema;
    // `pattern` で「それらしい文字列」を受ける形(= 実質自由文字列)を作らない。
    expect(valueSchema.pattern, key).toBeUndefined();
    expect(valueSchema.minLength, key).toBeUndefined();
    // オブジェクトや配列を値にしない(入れ子にすると任意 CSS の受け皿になりうる)。
    expect(["string", "integer"], key).toContain(valueSchema.type);
  }
});

// ---------------------------------------------------------------------------
// (iv) `data-app-id` / `data-view-id` が0件であること(限定5 = 経路B)
// ---------------------------------------------------------------------------

test("(iv) アプリ・画面を指す DOM 属性が製品コード(src / web/src / schemas)に1つも無い", async () => {
  // **指す手段が無ければアプリ固有のセレクタは書けない**(構造による担保。ADR-0050 §2 (b) の論証3)。
  //
  // **対象は製品コードだけである。** 検査側(本ファイル)と `web/e2e/preset.e2e.ts` は
  // 「0件であること」を主張するために属性名そのものを書いており、そこまで含めると
  // **検査が自分の存在で落ちる。** 属性を出すのは製品コードだけなので、射程をそこに絞る
  // (**この絞り込みが限界1件である** —— 検査ファイルの中に属性を出す実装を書いたら気づかない)。
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(
    "grep",
    ["-rn", "--", "data-view-id\\|data-app-id", "src", "web/src", "schemas"],
    { cwd: PRODUCT_ROOT, encoding: "utf-8" },
  );
  // grep は該当0件で終了コード1 を返す。**出力が空であることを見る。**
  expect(result.stdout.trim()).toBe("");
}); // ---------------------------------------------------------------------------
// (v) 表示関数と `ViewRendererProps` の引数の集合(ADR-0050 限定10 / ADR-0052 限定3)
// ---------------------------------------------------------------------------
//
// **限定10 は ADR-0049 限定3 の例外を明示的に許した唯一の箇所である** ——
// 「表示関数に足せる引数は軸7 の1つだけ。色・長さ・書体の実値を1つも受けない」。
// **例外に歯止めが無いと、次の変更が黙って8つ目の引数を足せる。**
//
// **本検査は新しい設計判断を1つも足していない。** 固定しているのは ADR-0050 限定10 が
// 既に明文で書いた集合そのものであり、テストはそれを機械で読めるようにしただけである。
//
// 解析は**正規表現**で行う(`web/test/styles.test.ts` が CSS を正規表現で解いているのと同型。
// **パーサを新設しない**)。コメントを落とすと引数リストも型リテラルも波括弧を含まないので、
// `[^{}]*` で安全に切り出せる(この前提が崩れたら正規表現が一致せず、下の
// `toBeDefined()` が落ちる = 黙って素通りしない)。

const DISPLAY_PATH = join(dirname(import.meta.dir), "src", "fields", "display.tsx");
const VIEW_TYPES_PATH = join(dirname(import.meta.dir), "src", "views", "types.ts");

/** 行コメントも落とす(型リテラルの中の `//` を数えないため)。 */
function stripAllComments(text: string): string {
  return stripComments(text).replace(/\/\/[^\n]*/g, "");
}

/** `{ a, b, c }` の形から名前を並び順のまま取り出す。 */
function destructuredNames(pattern: string): string[] {
  return pattern
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
}

/** `{ a: T; b?: U }` の形からプロパティ名を並び順のまま取り出す。 */
function typeLiteralNames(body: string): string[] {
  return [...body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\??\s*:/g)].map((match) => match[1] as string);
}

/**
 * **表示関数が受け取ってよい引数の全量。**
 *
 * **`textPreview` 以外の4つは表示オプションではない** —— `field` / `value` は描く対象そのもの、
 * `referenceLabels` は参照の代表値の索引、`appId` は image の配信 URL の組み立てに要る。
 * **表示オプションは `textPreview`(軸7 の3値 enum)ただ1つである。**
 */
const DISPLAY_FUNCTION_PARAMETERS = ["field", "value", "referenceLabels", "appId", "textPreview"];

/** そのうち「表示オプション」に当たるもの。**限定10 が許した例外はここだけである。** */
const DISPLAY_OPTION_PARAMETERS = ["textPreview"];

test("(v) FieldValue / FieldCell が受け取る引数は5つちょうどで、表示オプションは軸7 の1つだけ", () => {
  const source = stripAllComments(readFileSync(DISPLAY_PATH, "utf-8"));
  for (const name of ["FieldValue", "FieldCell"]) {
    const match = new RegExp(
      `export function ${name}\\(\\{([^{}]*)\\}\\s*:\\s*\\{([^{}]*)\\}\\s*\\)`,
    ).exec(source);
    // 一致しなくなったら **黙って素通りさせない**(形が変わったのだから検査を作り直す)。
    expect(match, `${name} の引数リストを読めない`).not.toBeNull();
    const destructured = destructuredNames((match as RegExpExecArray)[1] ?? "");
    const declared = typeLiteralNames((match as RegExpExecArray)[2] ?? "");
    // **6つ目を足すと落ちる。5つ目を消しても落ちる**(両向き)。
    expect(destructured, `${name} の分解代入`).toEqual(DISPLAY_FUNCTION_PARAMETERS);
    expect(declared, `${name} の型リテラル`).toEqual(DISPLAY_FUNCTION_PARAMETERS);
    // **表示オプションは軸7 の1つだけである**(限定10 の本文そのもの)。
    const options = destructured.filter(
      (parameter) => !["field", "value", "referenceLabels", "appId"].includes(parameter),
    );
    expect(options, `${name} の表示オプション`).toEqual(DISPLAY_OPTION_PARAMETERS);
  }
  // **軸7 の引数の型は、ビュー定義の値そのものでなければならない** —— 独自の型を作ると
  // enum の外の値(文字数・px)を受け取れるようになる(限定10 の「実値を1つも受けない」)。
  expect(source).toContain('type TextPreview = ListView["preset_text_preview"]');
});

test("(v) ViewRendererProps は5つちょうどで、プリセットの props が1つも足されていない", () => {
  // **軸1〜6 は `view` の中にあり、軸7 も `view` から読む**ので、props は1つも増えない
  // (`V3-M2-T04` が `git diff -- web/src/views/types.ts` = 0行で担保したことの恒久化)。
  const source = stripAllComments(readFileSync(VIEW_TYPES_PATH, "utf-8"));
  const match = /export type ViewRendererProps<[^>]*>\s*=\s*\{([^{}]*)\}/.exec(source);
  expect(match, "ViewRendererProps を読めない").not.toBeNull();
  expect(typeLiteralNames((match as RegExpExecArray)[1] ?? "")).toEqual([
    "appId",
    "manifest",
    "view",
    "recordId",
    "prefill",
  ]);
  // `preset` で始まる props を1つも持たない(限定10 の後半)。
  expect(
    typeLiteralNames((match as RegExpExecArray)[1] ?? "").filter((name) =>
      name.startsWith("preset"),
    ),
  ).toEqual([]);
});

// ---------------------------------------------------------------------------
// (vi) `preset_field_columns` の `$comment` の**前提**が、今日の実物と一致すること
//      (`V4-M51`。門A 本審査 単位A = 限定採用。ADR = `docs/adr/0156-*.md`)
// ---------------------------------------------------------------------------

/**
 * **なぜこの4本が要るのか。**
 *
 * **`schemas/manifest.schema.json` の `preset_field_columns` の `$comment` は、2箇所で
 * 「`@media` を1つも足さない / 足していない」を**前提**として掲げ、そこから
 * 「**段組数は画面幅に追随しない固定値である**」という**帰結**を導いている。**
 *
 * **前提は 2026-08-03 から偽である** —— `ADR-0089`(`V4-M15-T07` / `D-V4-44`)が
 * `web/src/styles.css` に**幅の条件の `@media` を2本**足し、同 ADR §Context 2 が逐語で
 * 「**`ADR-0046` 限定5 を緩めている。緩めていないふりをしない**」と書いている。
 *
 * **帰結は今日も真である** —— 2本はどちらも `.shell` の `padding` にしか当たらず、
 * 段組の規則(`[data-preset-columns=…]`)は `@media` の外にある。
 *
 * **したがって直すのは前提の側だけであり、帰結は1バイトも書き換えない。**
 * **(vi-1)〜(vi-2) が追記の実在を、(vi-3) が旧文の非削除を、(vi-4)〜(vi-5) が
 * 「前提が偽」「帰結が真」の**実物側の実証**を固定する。**
 */
const FIELD_COLUMNS_COMMENT: string = (() => {
  const schema = readJson(MANIFEST_SCHEMA_PATH);
  const comment = schema.$defs?.view?.properties?.preset_field_columns?.$comment;
  expect(typeof comment, "preset_field_columns の $comment を読めない").toBe("string");
  return comment as string;
})();

/** **旧文2文。1バイトも消してはならない。** */
const FIELD_COLUMNS_OLD_PREMISES = [
  // 初版(`D-G4` / `ADR-0050` 限定1)。
  "**@media を1つも足さない** (ADR-0046 限定5 / ADR-0050 限定9) ので、**段組数は画面幅に追随しない固定値である。狭い画面では潰れる。**",
  // `V4-M16-T11` / `ADR-0091` 限定3 が足した分。**足した日にはもう偽だった。**
  "**@media は今日も1つも足していないので、form でも段組数は画面幅に追随しない固定値である。**",
] as const;

test("(vi-1) preset_field_columns の $comment に V4-M51 の追記が1つ在る", () => {
  expect(FIELD_COLUMNS_COMMENT).toContain("【V4-M51 が 2026-08-04 に追記");
});

test("(vi-2) 追記が「前提は偽・帰結は真」を分けて述べ、原因の ADR と今日の本数を名指ししている", () => {
  // **前提が偽であることを言い切る**(「曖昧になった」で濁さない)。
  expect(FIELD_COLUMNS_COMMENT).toContain(
    "上の2つの『@media を1つも足さない / 足していない』は今日から偽である",
  );
  // **原因を名指しする**(行番号だけで指さない = `ADR-0007` §6 規律1)。
  expect(FIELD_COLUMNS_COMMENT).toContain("ADR-0089");
  // **今日の実測(本数と条件)を書く。**
  expect(FIELD_COLUMNS_COMMENT).toContain("幅の条件の @media が2本ある");
  expect(FIELD_COLUMNS_COMMENT).toContain("(min-width: 40rem)");
  expect(FIELD_COLUMNS_COMMENT).toContain("(min-width: 64rem)");
  // **帰結は今日も真であることを、同じ追記の中で述べる**(「レスポンシブになった」に倒さない)。
  expect(FIELD_COLUMNS_COMMENT).toContain(
    "帰結(段組数は画面幅に追随しない固定値である)は今日も真である",
  );
  // **語彙を1本も増やしていないことを述べる。**
  expect(FIELD_COLUMNS_COMMENT).toContain("properties にキーを1つも足していない");
});

test("(vi-3) 追記は旧文2文を1バイトも消していない", () => {
  for (const premise of FIELD_COLUMNS_OLD_PREMISES) {
    expect(FIELD_COLUMNS_COMMENT, premise).toContain(premise);
  }
});

test("(vi-4) 前提が偽であることの実証 —— 手で書く側に幅の条件の @media が2本ある", () => {
  const body = stripComments(css);
  const conditions = [...body.matchAll(/@media([^{]*)\{/g)].map((match) =>
    (match[1] ?? "").trim().replace(/\s+/g, ""),
  );
  // **「1つも足さない」が偽であることは、0 でないことで示す**(本数そのものは (ii) が固定している)。
  expect(conditions.length).toBe(2);
});

test("(vi-5) 帰結が真であることの実証 —— 段組の規則が @media の内側に1つも無い", () => {
  const body = stripComments(css);
  // `@media` のブロックを波括弧の対応で切り出す(入れ子は `ADR-0089` 限定2 により存在しない)。
  const insides: string[] = [];
  for (const match of body.matchAll(/@media[^{]*\{/g)) {
    let depth = 1;
    let index = (match.index ?? 0) + match[0].length;
    const start = index;
    while (index < body.length && depth > 0) {
      const ch = body[index];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      index += 1;
    }
    insides.push(body.slice(start, index - 1));
  }
  expect(insides.length).toBe(2);
  for (const inside of insides) {
    expect(inside, inside).not.toContain("data-preset-columns");
    // **2本が当たるのは `.shell` の `padding` だけである。**
    expect(inside.replace(/\s/g, ""), inside).toMatch(/^\.shell\{padding:[^{}]*;\}$/);
  }
  // **段組の規則そのものは `@media` の外に在る**(器の側で存在を確かめる)。
  expect(body).toContain('[data-preset-columns="2"]');
});

// ---------------------------------------------------------------------------
// (vii) 同じ前提が残る**5箇所**が、今日の実物と一致すること
//       (`V4-M53`。門A 本審査 **単位B-1** = 限定採用。ADR = `docs/adr/0157-*.md`)
// ---------------------------------------------------------------------------

/**
 * **なぜこの5本が要るのか。**
 *
 * **`V4-M51`(= 上の (vi))が直したのは `schemas/manifest.schema.json` の `$comment` 1箇所
 * だけである。** **同じ「前提 → 帰結」の構造を持つ記述が、実測でほかに5箇所ある**
 * (`src/kernel/types.ts` の doc コメント2箇所 / `docs/manual.md`(**利用者向けの説明書**)/
 * `src/mcp/vocabulary.test.ts` のコメント / `web/e2e/preset.e2e.ts` のヘッダ)。
 * **`V4-M51` 単位B はそこを保留にした**(`ADR-0007` §3a 改訂5 の実在確認に書けるタスクが
 * 1つも無かった)。**その起票が `07-remaining-milestones.md` §2-14(`V4-M53`)である。**
 *
 * **偽なのは前提の側だけである** —— **`ADR-0089`(`V4-M15-T07` / `D-V4-44`。2026-08-03)が
 * `web/src/styles.css` に幅の条件の `@media` を2本足した。** **帰結(段組数・列幅は画面幅に
 * 追随しない)は今日も真である** —— **その実物側の実証は上の (vi-4) / (vi-5) が持っており、
 * ここでは繰り返さない**(2箇所に住まわせない)。
 *
 * **(vii-1) / (vii-2) が追記の実在と中身を、(vii-3) / (vii-4) / (vii-5) が
 * 「旧文と帰結を1バイトも消していない」ことを固定する。**
 * **(vii-3)〜(vii-5) は実装前から緑でなければならない**(実装で破りうるものだからである。
 * (vi-3) と同じ理由)。
 *
 * **【`X-G28` / `V9-M11-T02` / `D-V9-21` で移した】** (vii-1)〜(vii-4) は `PREMISE_SITES` の
 * 1件目(`docs/manual.md`)を `resolveSite()` 経由で fs 読みするため、公開単位
 * (`apps/smailtalk/`)の外を読む検査になっていた。**4本とも
 * `tools/docs/preset-boundary-docs.test.ts` へ切り出した**(`PREMISE_SITES` /
 * `FIELD_COLUMNS_DOCS` / `FIELD_COLUMNS_DOC_OLD` / `premiseRegion` /
 * `REQUIRED_IN_ADDENDUM` を含む)。(vii-5) は `docs/` を読まないのでここに残す。
 */

test("(vii-5) src/mcp/vocabulary.test.ts の expect の行を1バイトも変えていない", () => {
  // **帰結は今日も真なので、`CANNOT_DO` の側の逐語を1文字も動かさない**
  // (`records/v4-m51.md` §5-2 の 6 の逐語「**`expect()` の行…は1バイトも変えない**」)。
  const source = readFileSync(join(PRODUCT_ROOT, "src", "mcp", "vocabulary.test.ts"), "utf-8");
  expect(source).toContain('expect(CANNOT_DO).toContain("画面幅に追随しない");');
});

// ---------------------------------------------------------------------------
// (viii) **字面走査が構造的に取り逃していた同型5箇所**が、今日の実物と一致すること
//        (`V4-M55`。**門外 Δ7** の審査 単位D-1 = 限定採用。記録 =
//        `docs/plan/v4/records/v4-m55.md`。**個別 ADR は無い** —— `ADR-0007` §6 の
//        閾値が門外に定める記録は台帳1行だけだからである)
// ---------------------------------------------------------------------------

/**
 * **なぜこの5本が要るのか。**
 *
 * **(vi)(= `V4-M51`)と (vii)(= `V4-M53`)が直したのは、「`@media`」という**字面**を
 * 含む記述だけである。** **同じ「前提 → 帰結」の構造を持ちながら、字面を意図的に避けて
 * 「メディアクエリ」と書いた記述が `web/src/styles.css` に2箇所あり、字面走査では
 * 原理的に届かなかった**(同ファイルの逐語「**このコメントに禁止対象の字面を書かないのは、
 * `web/src/styles.css` に対する `grep` の結果を汚さないためである**」)。
 * **`ADR-0007` 限界11 の改訂7 追記(「**「X は無い」と述べる文面は、定義上 X という
 * 識別子を含まない**」)の実例が、また1件増えた。**
 *
 * **5箇所の内訳**: `web/src/styles.css` の form 側 / detail 側の段組コメント2箇所(同型)/
 * `docs/manual.md` の「レスポンシブは1つも無い」/ `src/mcp/vocabulary.test.ts` の
 * 「ダークモード / レスポンシブは1つも足していない」/ `web/src/styles.css` の
 * 「at-rule 記号の個数は今日も 0」。
 *
 * **偽なのは前提の側だけである。** **帰結(段組数・列幅は画面幅に追随しない / ダークモードは
 * 1つも無い)は今日も真であり、実物側の実証は (vi-4) / (vi-5) が持つ**(2箇所に住まわせない)。
 *
 * **(viii-5) だけは他と性質が違う** —— **`D-V4-190`(ユーザ決定)により追記に `@media` の
 * 字面を使った結果、`web/src/styles.css` が自ら掲げていた方針を破った。**
 * **破ったことを方針の側にも書き残すことを、この検査が固定する。黙って破らない。**
 */

/** `web/src/styles.css` の生テキスト(コメントを含む)。 */
const STYLES_SOURCE: string = readFileSync(join(PRODUCT_ROOT, "web", "src", "styles.css"), "utf-8");

/**
 * **【`X-G28` / `V9-M11-T02` / `D-V9-21` で移した】** (viii-1)〜(viii-4) は
 * `PARAPHRASED_SITES` の3件目(`docs/manual.md`)を `resolveSite()` 経由で fs 読みするため、
 * 公開単位(`apps/smailtalk/`)の外を読む検査になっていた。**4本とも
 * `tools/docs/preset-boundary-docs.test.ts` へ切り出した**(`PARAPHRASED_SITES` /
 * `REQUIRED_IN_M55_ADDENDUM` / `paraphrasedRegion` を含む)。(viii-5) / (viii-6) は
 * `STYLES_SOURCE`(製品コード)しか読まないのでここに残す。
 */

test("(viii-5) 字面を避ける方針を破ったことが、方針の側にも書き残されている(D-V4-190)", () => {
  // **旧方針の文は1バイトも消していない。**
  expect(STYLES_SOURCE).toContain(
    " * (このコメントに禁止対象の字面を書かないのは、`web/src/styles.css` に対する `grep` の結果を",
  );
  // **破ったことを、方針のすぐ後ろで明言している**(黙って破らない)。
  const policyIndex = STYLES_SOURCE.indexOf("汚さないためである ——");
  expect(policyIndex, "方針の文が見つからない").toBeGreaterThanOrEqual(0);
  const after = STYLES_SOURCE.slice(policyIndex, policyIndex + 1600);
  expect(after, "方針の側に V4-M55 の追記が無い").toContain("【V4-M55");
  expect(after).toContain("D-V4-190");
  expect(after).toContain("意図的に破");
  // **実際に破れていること**(= コメントの中に `@` が1つ以上ある)。
  // **着手時は 0 だった**(2026-08-04 実測)。**この検査が赤いなら、字面はまだ書かれていない。**
  const comments = STYLES_SOURCE.match(/\/\*[\s\S]*?\*\//g) ?? [];
  const atInComments = comments.reduce((sum, c) => sum + (c.match(/@/g) ?? []).length, 0);
  expect(atInComments, "コメントに @ の字面が1つも無い").toBeGreaterThan(0);
});

test("(viii-6) 追記が引く行番号が、今日そのファイルのその行を実際に指している(ADR-0007 §6 規律1)", () => {
  // **本タスクの追記は `web/src/styles.css` の2本の `@media` を行番号つきで引いている。**
  // **行番号は追記そのものによってずれる**ので、ずれていないことを機械で見る。
  const lines = STYLES_SOURCE.split("\n");
  const cited = [...STYLES_SOURCE.matchAll(/`:(\d+)` 逐語 `(@media \(min-width: \d+rem\))`/g)];
  // **5箇所のうち、行番号つきで引いているものが1件以上ある**(0件なら規律1 を履行していない)。
  expect(cited.length, "行番号 + 逐語の対が1件も無い").toBeGreaterThan(0);
  for (const match of cited) {
    const lineNo = Number(match[1]);
    const literal = match[2] ?? "";
    expect(
      lines[lineNo - 1] ?? "",
      `styles.css:${lineNo} が「${literal}」を指していない`,
    ).toContain(literal);
  }
});

// ---------------------------------------------------------------------------
// (ix) **活用形の違いで走査をすり抜けた同型2件**(`V4-M57` / `D-V4-195`)と、
//      **画面幅の条件の数え方の手順**(`D-V4-196`)
// ---------------------------------------------------------------------------

/**
 * **(vi)(= `V4-M51`)/ (vii)(= `V4-M53`)/ (viii)(= `V4-M55`)に続く4本目である。**
 *
 * **(viii) が直したのは「`@media` の字面を意図的に避けた」記述だった**(= `ADR-0007`
 * 限界11 改訂7 追記が名指しした**第1の類型**。「X は無い」と述べる文面は X を含まない)。
 * **本節が直す2件はそれとは別の、走査の第2の類型である** —— **字面を含んでいるのに
 * 届かなかった。** **理由は3つある**:
 *
 * - **(a) 否定の活用形** —— **可能形「1つも足**せ**ない」が `V4-M53` の交替列
 *   (`足さない` / `足していない` / `無い` / `持てない` / `使わない`)に無かった。
 * - **(b) 丁寧語** —— 「1つも**ありません**」。
 * - **(c) 走査の対象ディレクトリに当該ファイルが無かった** ——
 *   `V4-M53` の走査2 の対象は逐語 `src web schemas docs/manual.md` であり、
 *   `docs/mcp-quickstart.md` が入っていなかった。
 *
 * **2件の内訳**: `web/e2e/theme-baseline.e2e.ts`(理由 (a))/
 * `docs/mcp-quickstart.md`(理由 (b) と (c) が重なっている)。
 *
 * **偽なのは前提(理由)の側だけである。** **帰結(「この製品はダークモードに追随しない」/
 * 「段組と列幅は画面幅に追随しない」)は今日も真であり、実物側の実証は (vi-4) / (vi-5) が
 * 持つ**(2箇所に住まわせない)。
 *
 * **(ix-5) だけは他と性質が違う** —— **`D-V4-196` により、「画面幅の条件が何本あるか」の
 * 数え方の手順を手引きに書いた。** **`V4-M55` が方針を破って字面を書いた結果、
 * `grep` の返す行数が条件の本数と一致しなくなったためである。**
 *
 * **【`X-G28` / `V9-M11-T02` / `D-V9-21` で移した】** (ix-1)〜(ix-5) は `CONJUGATION_SITES`
 * の2件目(`docs/mcp-quickstart.md`)への `resolveSite()` 経由の fs 読み、または
 * `REPO_ROOT`/`docs/` への直接読み(ix-4 / ix-5)を持つため、公開単位(`apps/smailtalk/`)の
 * 外を読む検査になっていた。**5本とも `tools/docs/preset-boundary-docs.test.ts` へ
 * 切り出した**(`CONJUGATION_SITES` / `REQUIRED_IN_M57_ADDENDUM` / `conjugationRegion` を
 * 含む)。(ix-6) / (ix-7) は `STYLES_SOURCE`(製品コード)しか読まないのでここに残す。
 */

test("(ix-6) §10.6 が書いた数え方が、今日の実物に対して実際にその値を返す", () => {
  // **手順を書いただけで数えていない、を止める。** **手引きの3つの数を実物で測り直す。**
  const raw = STYLES_SOURCE.split("\n").filter((line) => line.includes("@media")).length;
  const stripped = STYLES_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "");
  const conditions = (stripped.match(/@media/g) ?? []).length;
  expect(raw, "grep が返す行数(コメント込み)").toBe(15);
  expect(conditions, "コメントを除いた幅の条件の本数").toBe(2);
  // **この2つが食い違っていることが、手順が要る理由そのものである。**
  expect(raw).not.toBe(conditions);
});

test("(ix-7) 追記が引く行番号が、今日そのファイルのその行を実際に指している(ADR-0007 §6 規律1)", () => {
  const lines = STYLES_SOURCE.split("\n");
  const e2e = readFileSync(join(PRODUCT_ROOT, "web", "e2e", "theme-baseline.e2e.ts"), "utf-8");
  const cited = [...e2e.matchAll(/`:(\d+)` 逐語 `(@media \(min-width: \d+rem\))`/g)];
  expect(cited.length, "行番号 + 逐語の対が1件も無い").toBeGreaterThan(0);
  for (const match of cited) {
    const lineNo = Number(match[1]);
    const literal = match[2] ?? "";
    expect(
      lines[lineNo - 1] ?? "",
      `styles.css:${lineNo} が「${literal}」を指していない`,
    ).toContain(literal);
  }
});
