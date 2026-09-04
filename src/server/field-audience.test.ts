/**
 * `B-G2`(項目ごとに「見せる相手」を宣言する)の**宣言の置き場**の検査(`V4-M3-T05`)。
 *
 * 判定の正は `docs/plan/v4/records/v4-m0-gate-a-field-visibility.md`、
 * 限定表の正は `docs/adr/0071-field-audience-declaration.md` §3(**11点**)、
 * 完了条件の正は `docs/plan/v4/records/v4-m3.md` §4 の「V4-M3-T05」節。
 *
 * ## ここが押さえる限定(`ADR-0071` §3)
 *
 * | # | 限定 | ここでの検査 |
 * |---|---|---|
 * | 1 | 足すキーは `$defs/field` に1本だけ(7 → 8)。`$defs` 28 を増やさない | (a) |
 * | 2 | **予約規約フィールドを1本も足さない**(**`B-G2` の増分が0本であること**。総数は `ADR-0073` により 3 → 4 になった。詳細は (f) のコメント) | (f) |
 * | 3 | 値域は既存4ロールの列挙。**匿名を含めない**(匿名には常に落とす) | (b) / (c) / (e) |
 * | 7 | **宣言し忘れた項目は今日どおり出る。既定は「出す」である** | (d) |
 * | 10 | **画面単位の宣言を1つも作らない**(`$defs/view.properties` は 19 のまま) | (a) |
 *
 * ## この検査が言わないこと(誇張しない)
 *
 * - **ここは「宣言を書けること」しか見ない。** **応答から実際に落ちること**(限定5)は
 *   `V4-M3-T06` の検査(`field-audience-projection.test.ts`)が見る。
 * - **「在庫は漏れなくなった」とは書けない**(`ADR-0071` §限界1)。
 *   **作れるのは「客に出さない項目を宣言できる」ことであって「客に出ない」ではない。**
 *
 * ---
 *
 * ## **【`V8-M20` / 台帳 `J-G28` / `ADR-0301` / ユーザ決定 `D-V8-35`】今日の正はここから下である**
 *
 * **上の表を1バイトも書き換えていない**(当時の条文を読めるように残す作法)。
 * **食い違っているのは1点、しかし根本である** —— **`$defs/field` のキー `audience` は
 * 廃止された。** **項目の「見せる相手」を言う場所は、面(`app.roles[].rules` の
 * `{ target: "field", table, field, can: ["read"] }`)へ移った。**
 *
 * **したがって本ファイルは「宣言を書けること」を、面の側で測り直している**
 * (作法の正は `ADR-0301` 限定6「面の側で同じことが言える検査は、消さずに置き直す」)。
 *
 * **【置き直しで意味が変わった点。誇張しないために先に書く】**
 *
 * 1. **旧 `audience` は「読取に見せる相手」だけを言えた。** **面の規則は対象を名指しした
 *    時点で全動詞が allow-list になる** —— **`can: ["read"]` だけを書いた項目は、
 *    **誰も書けなくなる**(規則を書いた役割も含む)。**「読取だけを絞る」は今日書けない。**
 * 2. **旧 `audience` の値域は匿名を含めなかった**(限定3)。**面では `anonymous` を
 *    `roles[].id` に書けるが、**項目の規則だけは書けない**(`J-G11` の非対称)——
 *    **結果として「匿名には常に落ちる」は今日も成り立っている**(下の (c) が実測)。
 * 3. **既定は今日も「出す」である**(限定7)—— **規則を1本も書いていない項目は面の管轄外。**
 */
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { isRoleGovernedField } from "./owner-scope.ts";

/** `schemas/manifest.schema.json` をファイルから直に読む(理由は `view-audience.test.ts`)。 */
const MANIFEST_SCHEMA_FILE = join(import.meta.dir, "..", "..", "schemas", "manifest.schema.json");

function schema(): {
  $defs: Record<string, { properties?: Record<string, unknown> }>;
} {
  return JSON.parse(readFileSync(MANIFEST_SCHEMA_FILE, "utf-8")) as {
    $defs: Record<string, { properties?: Record<string, unknown> }>;
  };
}

// --- (a) 増分の総量(限定1 / 限定10)-----------------------------------------------

test("(a)【反転】$defs/field.properties から audience が消えた(V8-M20 / J-G28)", () => {
  // **`V4-M10-T01` / `ADR-0076` 限定1 が9キー目(`writable_by`)を足したので、
  // 期待値を 8 → 9 に更新した。****`ADR-0071` の増分が `audience` の1キーだけであることは
  // 下の「増分は `ADR-0071` の1キーだけ」の検査と `field-write-control.test.ts` が見ている。**
  // **【V4-M10-T46 / `E-G14` / `ADR-0086` 限定1 による更新】** **10キー目(`unit`)が
  // 加わったので期待値を 9 → 10 にした。****`ADR-0071` の増分は今日も `audience` の
  // 1キーだけである** —— **3つは別の門を通った別の増分である**
  // (`ADR-0071` / `ADR-0076` / `ADR-0086`)。
  // **【V4-M16-T10 / `P-G28` + `P-G22` / `ADR-0090` 限定1 による更新】** **11キー目
  // (`emphasis`)が加わったので期待値を 10 → 11 にした。** **`ADR-0071` の増分は今日も
  // `audience` の1キーだけである** —— **4つは別の門を通った別の増分である**
  // (`ADR-0071` / `ADR-0076` / `ADR-0086` / `ADR-0090`)。
  // **【V4-M19-T07 / ADR-0119 限定1 で 11 → 12 に更新した】** 12キー目 `hide_when_empty`
  // (値が無いとき行ごと出さない)が門A を通って増えた(V4-M19 単位E-a。2回目の審査。
  // 判定 = 限定採用)。**8型すべてに書けるキーである。****本 ADR の増分ではない。**
  // **【V6-M1-T01 / K-G1 / ADR-0288 限定1 で 12 → 13 に更新した】** 13キー目 `reference_picker`
  // (他のテーブルから選ぶ項目の選び方)が門A を通って増えた(V6-M0 単位A。判定 = 限定採用)。
  // **reference 型にだけ書けるキーである。****本 ADR の増分ではない。**
  const keys = Object.keys(schema().$defs.field?.properties ?? {}).sort();
  // **【`V6-M3-T02` / `K-G7` / `ADR-0290` 限定1 で 13 → 14 に更新した】** 14キー目
  // `reference_search_fields`(参照候補の「探せる項目」の、項目ごとの上書き)が門A を通って
  // 増えた(`V6-M0` 単位B。判定 = 限定採用)。**`reference` 型にだけ書けるキーである。**
  // **本 ADR の増分ではない。**
  //
  // **【`V8-M20` / 台帳 `J-G28` / `ADR-0301` による反転。旧値をここに残す】**
  // **旧: `expect(keys).toHaveLength(14);` / `expect(keys).toContain("audience");`**
  // **`audience`(項目の「見せる相手」)と `writable_by`(項目の「書ける相手」)の2キーが
  // 廃止され、14 → 12 になった。** **代わりに立つのは面の規則
  // (`app.roles[].rules` の `{ target: "field", … }`)である** —— **`$defs/field` の
  // 側には1キーも足していない。**
  expect(keys).toHaveLength(12);
  expect(keys).not.toContain("audience");
  expect(keys).not.toContain("writable_by");
});

// 【`V5-M29-T05` / `ADR-0250` 限定10 + 限定11】ここにあった test を、ブロックごと消した。
//   消したテスト名(逐語): 「(a) $defs の本数は 28 のまま(限定1)」
//   そのブロックが測っていたもの:
//     - `expect(Object.keys(schema().$defs)).toHaveLength(28)`(主張の逐語はテスト名の「$defs の本数は 28 のまま(限定1)」)
//   移し先は `scripts/vocabulary-drift.test.ts`(一覧の `manifest.$defs:` で始まる行)。
//   **`expect()` が1つも残らないので空の test を残さなかった**(空の test は緑を返し、
//   検出力0のまま `Ran` を水増しする)。
//   **テスト名が持っていた日本語の宣言は、ここでリポジトリから消える**(`ADR-0250` §Decision 5 の (4))。

// **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。ADR = `0359` §4b。題名の数を直した】**
// **旧名の逐語**: `(a) $defs/view.properties は 30 で、ADR-0071 の増分は0キーである(限定10: 画面単位を1つも作らない)`
// **31キー目 `flow` が増えたのは別の決定である。****本ファイルが測っている増分は今日も0キーである。**
test("(a) $defs/view.properties は 31 で、ADR-0071 の増分は0キーである(限定10: 画面単位を1つも作らない)", () => {
  // **`B-G1`(`ADR-0070`)が 18 → 19 にした分と、`E-G12`(`ADR-0084`。`V4-M10-T45`)が
  // 19 → 20 にした分だけである。** **`B-G2`(`ADR-0071`)は今日も1つも増やしていない。**
  // **【V4-M16-T12 / `P-G17` の (C) 側 / ADR-0092 限定1 による更新】** **`ADR-0092`
  // (門A の本審査 = `V4-M14` 本審査② の単位9。判定 = 限定採用)が21キー目 `field_groups`
  // (詳細画面の項目のまとまり)を足したので期待値を 20 → 21 にした。**
  // **本 ADR の増分が増えたのではない**(どの ADR の限定が何を増やしたかを混ぜない)。
  // **【V4-M16-T13 / ADR-0093 限定1 で 21 → 22 に更新した】** 門A の本審査(`V4-M14` 本審査② の単位11。判定 = 限定採用)が22キー目 `preset_list_shape`(一覧の器の形)を足した。
  // **【V4-M18-T03 / ADR-0095 限定1 で 22 → 23 に更新した】** 門A の本審査(V4-M18 単位3。
  // 判定 = 限定採用)が23キー目 `modal`(重ねて出す宣言)を足した。**本 ADR の増分ではない。**
  // **【V4-M22-T01 / ADR-0112 限定1 で 23 → 24 に更新した】** 門A の本審査(V4-M22 単位A。
  // 判定 = 限定採用)が24キー目 `search_fields`(検索の対象にする列)を足した。**本 ADR の
  // 増分ではない。**
  // **【V4-M22-T05 / ADR-0113 限定1 で 24 → 25 に更新した】** 門A の本審査(V4-M22 単位C。
  // **4回目の審査**。判定 = 限定採用)が25キー目 `page_size`(1ページに出す件数)を足した。
  // **本 ADR の増分ではない。**
  // **【V4-M19-T03 / ADR-0118 限定1 で 25 → 26 に更新した】** 26キー目 `preset_density`
  // (画面の詰まり具合)が門A を通って増えた(V4-M19 単位C。2回目の審査。判定 = 限定採用)。
  // **3種すべてに書けるキーである。****本 ADR の増分ではない。**
  // **【V4-M20-T04 / ADR-0102 限定1 で 26 → 27 に更新した】** 27キー目 `after_save`
  // (保存が成立したあとに行く画面のID)が門A を通って増えた(V4-M20 単位D。2回目の審査。
  // 判定 = 限定採用)。**form 型のビューでだけ書ける。****本 ADR の増分ではない。**
  // **【V4-M23-T01 / ADR-0104 限定1 で 27 → 28 に更新した】** 28キー目 `sum_field`
  // (合計を出す列)が門A を通って増えた(判定 = 限定採用)。**`list_view` でだけ書ける。**
  // **本 ADR の増分ではない。**
  // **【`V6-M2-T01` / `K-G2` / `ADR-0289` 限定1 で 28 → 29 に更新した】** 29キー目 `reference_pickers`
  // (参照項目の選び方の、入力画面ごとの上書き)が門A を通って増えた(`V6-M0` 単位A。判定 = 限定採用)。
  // **`form` 型のビューでだけ書ける。****本 ADR の増分ではない。**
  //
  // **【`V8-M20` / 台帳 `J-G27` / `ADR-0301` による更新。旧値をここに残す】**
  // **旧: `expect(Object.keys(schema().$defs.view?.properties ?? {})).toHaveLength(29);`**
  // **画面の「見せる相手」(`view.audience`)が廃止され、29 → 28 になった。**
  // **`ADR-0071`(本 ADR)の増分は今日も0キーである** —— **減ったのは別の単位の増分である。**
  // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】期待値を 28 → 29 へ書き換えた。**
  // **旧行の逐語**: `expect(Object.keys(schema().$defs.view?.properties ?? {})).toHaveLength(28);`
  // **書き換えた理由**: この行が固定していたのは「**その決定**が `$defs/view.properties` の本数 を増やさなかったこと」であり、
  // **29本目を足したのは別の決定である**(`V8-M8` が 集計表の宣言 `report` を29キー目として足した)。**検査は消していない。**
  // **【2026-08-20。`V10-M1-T02`。台帳 `NV-G4`。門A 本審査 = `V10-M0` 群A。ADR = `0359`】**
  // **期待値を 29 → 30 へ書き換えた。****旧行の逐語は直下の行の 29 である。**
  // **30本目を足したのは別の決定である**(`ADR-0359` §4a 限定1 が削除後の行き先
  // `after_delete` を30キー目として足した。**`detail_view` でだけ書ける**)。
  // **検査は消していない。****本 ADR の増分ではない。**
  // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。門A 本審査 = `V10-M0` 群B。ADR = `0359` / `0360`】**
  // **期待値を 30 → 31 へ書き換えた。****旧行の逐語**: `expect(Object.keys(schema().$defs.view?.properties ?? {})).toHaveLength(30);`
  // **31本目を足したのは別の決定である**(`ADR-0359` §4b 限定1 が一続きの流れの中の段
  // `flow` を**末尾に**31キー目として足した。**`list_view` / `form` / `detail_view` の3種別で
  // 書け、集計表(`report_view`)には書けない**)。
  // **本ファイルが測っている決定の増分ではない。****検査は消していない。**
  expect(Object.keys(schema().$defs.view?.properties ?? {})).toHaveLength(31);
  expect(Object.keys(schema().$defs.view?.properties ?? {})).not.toContain("audience");
});

// 【`V8-M20` / 台帳 `J-G28` / `ADR-0301`】ここにあった test を、ブロックごと消した。
//   消したテスト名(逐語): 「(a) 値域の定義を二重に持たない($defs/view/properties/audience をそのまま指す)」
//   そのブロックが測っていたもの:
//     - `expect((schema().$defs.field?.properties?.audience as { $ref?: string })?.$ref)
//        .toBe("#/$defs/view/properties/audience")`
//   **消した理由**: **指す側(`$defs/field.properties.audience`)と指される側
//   (`$defs/view.properties.audience`)の**両方**が廃止された** —— **面の規則の値域は
//   `app.roles[].rules` にインラインで書かれており、指し先そのものが存在しない。**
//   **「面の側で同じことが言える検査」ではない**(`ADR-0301` 限定6 の判定)—— **`$ref` を
//   使い回す作法は面の側に持ち越されていない**(値域はインライン。`J-G6` の $comment)。
//   **`expect()` が1つも残らないので空の test を残さなかった。**

// --- (b)(c) 値域(限定3)------------------------------------------------------------

const APP_ID = "field-audience-app";

/** 既定の役割定義3本(`app.roles` を書くなら**必ず全部**入れる。消すと適用が invalid)。 */
const DEFAULT_ROLES = [
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
];

/**
 * **`stock`(在庫数)に面の規則を当てたマニフェスト**(`roles` を省略すると規則0本)。
 *
 * **【置き直し前の形。1バイトも書き換えずに残す】** ——
 * `{ id: "stock", name: "在庫数", type: "number", audience: ["owner", "editor"] }`。
 */
function manifestWith(roles?: unknown): Manifest {
  const app: Record<string, unknown> = {
    id: APP_ID,
    name: "項目の宣言テスト",
    tables: [
      {
        id: "product",
        name: "商品",
        fields: [
          { id: "name", name: "名称", type: "text", required: true },
          { id: "stock", name: "在庫数", type: "number" },
        ],
      },
    ],
    views: [{ id: "product-list", type: "list_view", table: "product", columns: ["name"] }],
  };
  if (roles !== undefined) {
    app.roles = roles;
  }
  return { app } as unknown as Manifest;
}

/** `stock` を名指しする面の項目の規則を1本作る。 */
const stockRule = (can: readonly string[]) => ({
  target: "field",
  table: "product",
  field: "stock",
  can,
});

function applyIn(manifest: Manifest): boolean {
  const dataRoot = mkdtempSync(join(tmpdir(), "gp-field-audience-"));
  try {
    const store = KernelMetaStore.open(dataRoot);
    try {
      createApp(store, "項目の宣言テスト", { app_id: APP_ID });
    } finally {
      store.close();
    }
    return applyManifest(dataRoot, APP_ID, manifest).valid;
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

test("(b)【置き直し】面の項目の規則を書いたマニフェストは適用できる(4ロール分)", () => {
  // **【置き直し前の逐語。1バイトも書き換えずに残す】**
  //   test("(b) audience に4ロールを書いたマニフェストは適用できる", () => {
  //     for (const value of [["owner"], ["owner", "editor"], ["viewer"], ["customer"]]) {
  //       expect(applyIn(manifestWith(value)), JSON.stringify(value)).toBe(true);
  //     }
  //   });
  // **`V8-M20` / `J-G28` で `field.audience` が廃止され、項目の「見せる相手」は
  // 面(`app.roles[].rules`)が言うようになった。** **同じ4ロールを、規則を持つ役割として書く。**
  const cases: readonly (readonly string[])[] = [
    ["owner"],
    ["owner", "editor"],
    ["viewer"],
    ["customer"],
  ];
  for (const ids of cases) {
    const roles = [
      // **【`V8-M28` / `T-G16a`】旧の逐語: `{ ...role, rules: [stockRule(["read"])] }`** ——
      // **持ち主の2本(`app` / `role`)を潰さないよう、既存の規則に**足す**形へ直した。**
      ...DEFAULT_ROLES.map((role) =>
        ids.includes(role.id)
          ? { ...role, rules: [...(role.rules ?? []), stockRule(["read"])] }
          : role,
      ),
      // **`customer`(既定の非運営の種類。`ADR-0158` 限定3)は既定3本の外なので足す。**
      ...(ids.includes("customer")
        ? [{ id: "customer", name: "お客様", rules: [stockRule(["read"])] }]
        : []),
    ];
    expect(applyIn(manifestWith(roles)), JSON.stringify(ids)).toBe(true);
  }
});

test("(c)【置き直し】未ログイン(anonymous)に項目の規則は書けない(J-G11 の非対称)", () => {
  // **【置き直し前の逐語。1バイトも書き換えずに残す】**
  //   test("(c) audience に anonymous は書けない(ADR-0071 限定3: 匿名を含めない)", () => {
  //     expect(applyIn(manifestWith(["anonymous"]))).toBe(false);
  //   });
  // **旧 `audience` は値域そのものが匿名を持たなかった**(`ADR-0071` 限定3)。
  // **面では `anonymous` を `roles[].id` に書けるが、`J-G11` の分岐が
  // 「未ログインの要素からは対象 `field` を除き、動詞を `read` に絞る」と定めている** ——
  // **項目の規則だけは今日も書けない。****結果として「匿名には常に落ちる」は成り立つ。**
  expect(
    applyIn(
      manifestWith([
        ...DEFAULT_ROLES,
        { id: "anonymous", name: "未ログイン", rules: [stockRule(["read"])] },
      ]),
    ),
  ).toBe(false);
});

test("(c)【置き直し】項目の規則に書けない動詞・空の列挙・重複は書けない", () => {
  // **【置き直し前の逐語。1バイトも書き換えずに残す】**
  //   test("(c) 4ロール以外の値・空配列・重複・文字列は書けない", () => {
  //     expect(applyIn(manifestWith(["admin"]))).toBe(false);
  //     expect(applyIn(manifestWith([]))).toBe(false);
  //     expect(applyIn(manifestWith(["owner", "owner"]))).toBe(false);
  //     expect(applyIn(manifestWith("owner"))).toBe(false);
  //   });
  // **面では絞り方が変わった** —— **役割の識別子の値域は `^[a-z0-9_]{1,32}$` の1本で、
  // `admin` のような綴りは今日も通ってしまう**(`V8-M16` が申告済みの穴。**塞いでいない**)。
  // **代わりに閉じているのは「対象ごとに書ける動詞」と「列挙の形」である。**
  // **【`V8-M28` / `T-G16a`】旧の逐語: `manifestWith([{ ...DEFAULT_ROLES[0], rules: [rule] }, ...`**
  // —— **持ち主の2本(`app` / `role`)を潰さないよう、既存の規則に**足す**形へ直した。**
  // **拒否されるべき行(動詞・空・重複)は今日も拒否される** —— **緩めていない。**
  const withRule = (rule: unknown) =>
    manifestWith([
      { ...DEFAULT_ROLES[0], rules: [...(DEFAULT_ROLES[0]?.rules ?? []), rule] },
      DEFAULT_ROLES[1],
      DEFAULT_ROLES[2],
    ]);
  // **項目に `delete` は書けない**(項目の動詞は `read` / `write` の2語だけ)。
  expect(applyIn(withRule(stockRule(["delete"])))).toBe(false);
  // **空の列挙は書けない**(`minItems: 1`。「0本書く」と「書かない」の2通りを作らない)。
  expect(applyIn(withRule(stockRule([])))).toBe(false);
  // **同じ動詞を2度書けない**(`uniqueItems`)。
  expect(applyIn(withRule(stockRule(["read", "read"])))).toBe(false);
  // **【`V8-M26`。ユーザ決定 `D-V8-66`(2026-08-10)。旧の4行を逐語で残す。1バイトも消していない】**
  //   // **実在しない項目は名指しできない**(適用時検査。「書けるが効かない宣言」を作らない)。
  //   expect(
  //     applyIn(withRule({ target: "field", table: "product", field: "no_such", can: ["read"] })),
  //   ).toBe(false);
  // **今日は `true` である** —— **`D-V8-66` が `src/kernel/referential-integrity.ts` の
  // 類型16(役割の規則が指す先の実在検査。`table` / `field` / `view` / `action` の4本)を
  // 撤去したので、実在しない項目を名指しした規則も適用が通る。**
  // **【正直に書く】これは既定を閉じたこと(`D-V8-45` / `D-V8-65`)の帰結ではない** ——
  // **同じ `V8-M26` の中の別の決定(`D-V8-66`)の帰結である。**
  // **「書けるが効かない宣言を作らない」(`ADR-0086` 限定4)は、役割の規則についてだけ、
  // 今日は成り立っていない。**
  expect(
    applyIn(withRule({ target: "field", table: "product", field: "no_such", can: ["read"] })),
  ).toBe(true);
  // **既定3ロールは消せない**(`set_roles` は全体差し替えなので、ここが最後の歯止めである)。
  expect(
    applyIn(manifestWith([{ id: "owner", name: "持ち主", rules: [stockRule(["read"])] }])),
  ).toBe(false);
});

// --- (d) 宣言の無い項目は今日どおり(限定7)-------------------------------------------

test("(d) 規則を1本も書いていないマニフェストは今日どおり適用できる(限定7)", () => {
  expect(applyIn(manifestWith(undefined))).toBe(true);
});

test("(d)【置き直し】規則を1本も持たない項目は面の管轄外である(既定は「出す」である)", () => {
  // **【置き直し前の逐語。1バイトも書き換えずに残す】**
  //   test("(d) fieldAudience は宣言の無い項目に undefined を返す(既定は「出す」である)", () => {
  //     expect(fieldAudience({ id: "stock", name: "在庫", type: "number" })).toBeUndefined();
  //   });
  // **`fieldAudience`(項目1本を見る述語)は撤去された。** **面では「管轄内か」を
  // マニフェスト全体に問う** —— **規則を書くのは項目ではなく役割の側だからである。**
  expect(isRoleGovernedField(manifestWith(undefined), "product", "stock")).toBe(false);
});

// --- (e) 述語 ------------------------------------------------------------------------

test("(e)【置き直し】面が名指しした項目は管轄内になる —— ロールを1つも見ない", () => {
  // **【置き直し前の逐語。1バイトも書き換えずに残す】**
  //   test("(e) fieldAudience は宣言された列挙をそのまま返す", () => {
  //     expect(fieldAudience({ id: "stock", name: "在庫", type: "number", audience: ["owner"] })).toEqual(
  //       ["owner"],
  //     );
  //   });
  // **`isRoleGovernedField` が返すのは「面がその項目を名指ししているか」の1真偽である** ——
  // **誰の規則であっても、名指しされた時点で管轄内(allow-list)になる**(裁定 `R-4`)。
  // **相手によって答えが割れない**(`ADR-0120` 限定2 と同じ形)。
  const ruled = manifestWith([
    { ...DEFAULT_ROLES[0], rules: [stockRule(["read"])] },
    DEFAULT_ROLES[1],
    DEFAULT_ROLES[2],
  ]);
  expect(isRoleGovernedField(ruled, "product", "stock")).toBe(true);
  // **名指しされていない項目は、同じ表の中でも管轄外のままである。**
  expect(isRoleGovernedField(ruled, "product", "name")).toBe(false);
});

// --- (f) 予約規約フィールド(限定2)--------------------------------------------------

test("(f) `B-G2` は予約規約フィールドを1本も足していない(ADR-0071 限定2)", () => {
  // **【この検査は 2026-08-03 の `work/v4-m4` / `work/v4-m3` のマージで書き直した】**
  // 経緯と原典の逐語は `docs/plan/v4/records/v4-m3-m4-merge.md` §2-1。
  //
  // **書き直す前は「3本のまま」を絶対の本数で固定していた。それが今日は誤りである。**
  // `ADR-0073`(`B-G8` の門A本審査 = 限定採用。`V4-M4-T04` が実装)が**4本目
  // `st_undeletable` を足した**からである。**`ADR-0071` 限定2 と `ADR-0073` 限定1 は、
  // どちらも `V4-M0` の同じ審査で限定採用された正規の変更であり、片方が誤りではない。**
  //
  // **4本目が正当である理由**(推測ではなく手続きの実測):
  //   - `ADR-0061` 限定9 は「4本目(`st_*`)には**門A の新規審査 + 同格の個別 ADR**が要る」と
  //     要求していた。`ADR-0073` §4 はその2つを満たしている —— 門A の新規審査 =
  //     `docs/plan/v4/records/v4-m0-gate-a-order-protection.md`(2026-08-02)/
  //     同格の個別 ADR = `docs/adr/0073-row-state-delete-protection.md` そのもの。
  //   - **同 §4 は「`export const *_FIELD` の本数の検査 | **3 → 4 に更新する**(限定2)。
  //     **更新の根拠として本 ADR を名指しでコメントに書く**」と明文で指示している。**
  //     **本コメントがその名指しである。**
  //
  // **`ADR-0071` 限定2 の逐語**(`docs/adr/0071-field-audience-declaration.md`):
  //   > **予約規約フィールドを1本も足さない**(3本のまま) | **`st_*` の4本目を置き場に
  //   > しない。** **理由は構造的である** —— `ADR-0061` 限定3 の逐語「**宣言はテーブル単位。
  //   > フィールドの存在だけが宣言**」により、予約規約フィールドが言えるのは「この表は〜で
  //   > ある」までであり、「この表のうち `stock` と `sku` は〜である」を言えない
  // **限定の趣旨は「`B-G2` が `st_*` の4本目を宣言の置き場にしない」であって、「この製品の
  // 予約規約フィールドが未来永劫3本である」ではない。** **実際に4本目を足したのは
  // `B-G8`(別単位・別 ADR。用途は削除の抑止であって項目単位の見せ分けではない)であり、
  // `B-G2` は1本も足していない。** **したがってここは「`B-G2` の増分が0本であること」を測る。**
  //
  // **【限定表の第4列との食い違いを隠さない】** `ADR-0071` 限定2 の第4列は
  // 「`grep -cE "^export const [A-Z_]+_FIELD = " src/server/owner-scope.ts` が **3**」と
  // 書いており、**その式は今日 4 を返すので、逐語のままでは緑にならない。**
  // **`ADR-0071` の本文は1バイトも書き換えていない**(文言の是正が要るかはユーザ/門A の判断)。
  const source = readFileSync(join(import.meta.dir, "owner-scope.ts"), "utf-8");
  // **素朴な `grep -c "^export const .*_FIELD"` は `ANON_RESERVED_FIELDS` /
  // `READ_HIDDEN_RESERVED_FIELDS`(予約規約フィールドの**一覧**であって予約規約フィールド
  // ではない)を拾う**(`ADR-0073` 限定2 の実測)。**`= "st_..."` まで要求する形で数える。**
  const declared = [...source.matchAll(/^export const ([A-Z_]+_FIELD) = "(st_[a-z_]+)";$/gm)].map(
    (m) => m[1] as string,
  );
  // 1〜3本目の出自は `owner-scope.ts` の各節のコメント(`ADR-0016` / `ADR-0034` / `ADR-0061`)。
  // **4本目 `UNDELETABLE_FIELD`(`st_undeletable`)の出自は `ADR-0073` である。**
  // **【V4-M10-T04 / E-G49 / ADR-0077 による更新】** **5本目 `st_no_direct_create` が
  // 正規の手続きで足された**(`ADR-0073` 限定2 / `ADR-0061` 限定9 が要求する「門A の新規審査 +
  // 同格の個別 ADR」の両方を満たしている —— `docs/plan/v4/records/v4-m7-gate-a-direct-create.md`
  // と `docs/adr/0077-direct-create-suppression.md`)。**この検査の趣旨(この単位が
  // 予約規約フィールドを1本も足していないこと)は今日も真である。**
  //
  // **【`V8-M20` / 台帳 `J-G30` / `ADR-0301` による更新。旧値をここに残す】**
  // **旧: 5本(`ADMIN_READABLE_FIELD` を含んでいた)。**
  // **`st_admin_readable`(運営可視の宣言)**の1本だけ**が廃止され、5 → 4 になった。**
  // **代わりに立つのは面の「役割 × 対象(表)× 読取」である**(`roleReadCrossesOwnerScope`)。
  // **残る4本(`st_owner` / `st_public` / `st_undeletable` / `st_no_direct_create`)は
  // 今日もフィールドも実装も在る** —— **ただし `st_owner` の読取の重ね順は変わった**
  // (`D-V8-35`)。**「4本は1ミリも変わっていない」とは書かない。**
  expect(declared.sort()).toEqual([
    "NO_DIRECT_CREATE_FIELD",
    "OWNER_FIELD",
    "PUBLIC_FIELD",
    "UNDELETABLE_FIELD",
  ]);

  // **`B-G2` の増分が0本であることの、より直接的な測り方** —— **項目ごとの見せ分けの宣言は
  // 予約規約フィールドではなく `$defs/field` の1キー(`audience`)に置かれている**(限定1)。
  // **予約規約フィールドの定数に `audience` 由来のものが1本も無いこと**を固定する。
  // **【`V8-M20`】そのキーは廃止され、宣言は面へ移った** —— **移った先も予約規約
  // フィールドではないので、この2行が測る性質は1ミリも変わらない。**
  expect(declared.filter((name) => name.includes("AUDIENCE"))).toEqual([]);
  expect(source).not.toContain('_FIELD = "st_audience"');
});
