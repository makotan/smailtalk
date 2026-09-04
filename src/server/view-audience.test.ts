/**
 * **画面ごとの「見せる相手」の宣言の置き場**の検査。
 *
 * ## 【`V8-M20` / 台帳 `J-G27`(判定 = 廃止)/ `ADR-0301` / ユーザ決定 `D-V8-35`】
 *
 * **本ファイルが元々測っていた `view.audience`(`B-G1` / `ADR-0070`)は撤去された。**
 * **代わりに立つのは 役割 x 対象(画面)x 読取** ——
 * `app.roles[].rules` の `{ "target": "view", "view": "<画面ID>", "can": ["read"] }` である。
 *
 * **ファイル名は `view-audience.test.ts` のままにしてある**(改名は本タスクの射程外)。
 * **中身は「画面の見せ分けの宣言はどこに置かれ、何が書けるか」を測る、という問いのまま
 * 置き直した。**
 *
 * **旧ファイルのヘッダが持っていた限定表(`ADR-0070` §3 の 12点)は、その語彙ごと消えた。**
 * **消した検査・置き直した検査の逐語は、本タスクの報告に列挙してある。**
 *
 * ## ここが押さえること(置き直したあと)
 *
 * | # | 押さえること | ここでの検査 |
 * |---|---|---|
 * | 1 | **`$defs/view` から `audience` が消えている**(キーは 29 → 28) | (a) |
 * | 2 | **`$defs/field` からも `audience` / `writable_by` が消えている**(14 → 12。`J-G28`) | (a) |
 * | 3 | **`audience` を書いたマニフェストは適用できない**(語彙が無い) | (b) |
 * | 4 | **面の規則で同じことが書け、適用できる** | (b) |
 * | 5 | **規則を1本も書いていない画面は今日どおり全員に許される**(裁定 `R-4` の管轄外) | (d) |
 * | 6 | **1本でも書かれた画面は allow-list になる** | (e) |
 * | 7 | **予約規約フィールドは 5本 → 4本**(`st_admin_readable` の撤去。`J-G30`) | (f) |
 *
 * ## この検査が言わないこと(誇張しない)
 *
 * - **ここは「宣言を書けること」と「純関数の判定」しか見ない。**
 *   **サーバが 403 を返すこと**は `view-audience-enforcement.test.ts` が見る。
 * - **`GET /api/apps/:app_id/manifest` は今日も未ログインで全ビュー定義を返す。**
 *   **`app.roles` の規則もそのまま返る** —— **「誰にどの画面が開いているか」まで未ログインで
 *   読める**(`view-audience-enforcement.test.ts` の (Y) が実測で固定する)。
 * - **MCP 経路は1ミリも守られない**(`ADR-0070` 限定8 が言っていた穴は、面でも塞がっていない)。
 */
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { judgeRoleAccess } from "./owner-scope.ts";

/**
 * `schemas/manifest.schema.json` をファイルから直に読む。
 *
 * **`src/kernel/validate.ts` の `MANIFEST_SCHEMA_PATH` を import しない** ——
 * `scripts/kernel-import-drift.test.ts`(`ADR-0009` 限定2)が「`src/kernel/` の外から**値として**
 * import されるシンボル」を `scripts/kernel-import-snapshot.txt` で凍結しており、
 * **新しい層またぎを1本増やすことになる**(本ファイルが値 import する3本は、同じ
 * `src/server/` の既存検査が既に引いている組であり、**新しい種類は0本である**)。
 * ここは `web/test/shell-navigation-boundary.test.ts` と同じくパスを組んで読む。
 */
const MANIFEST_SCHEMA_FILE = join(import.meta.dir, "..", "..", "schemas", "manifest.schema.json");

function schema(): {
  $defs: Record<string, { properties?: Record<string, unknown> }>;
} {
  return JSON.parse(readFileSync(MANIFEST_SCHEMA_FILE, "utf-8")) as {
    $defs: Record<string, { properties?: Record<string, unknown> }>;
  };
}

// --- (a) 語彙から消えたもの(`J-G27` / `J-G28`)----------------------------------------

// **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。ADR = `0359` §4b。題名の数を直した】**
// **旧名の逐語**: `(a) $defs/view.properties から audience が消えて、今日は 30キーである(V8-M20 / J-G27)`
// **31キー目 `flow` が増えたのは別の決定である。****`audience` が今日も無いことは1ミリも変わらない。**
test("(a) $defs/view.properties から audience が消えて、今日は 31キーである(V8-M20 / J-G27)", () => {
  // **【`V8-M20` / `J-G27` / `ADR-0301`】`view.audience` は廃止された。**
  // **旧: `expect(properties).toHaveLength(29);` / `expect(properties[18]).toBe("audience");`**
  // **(19キー目が `audience` であることを `ADR-0070` 限定1 の固定として測っていた)。**
  // **旧の更新履歴のコメント(`ADR-0084` が 19 → 20、`ADR-0092` が 20 → 21、`ADR-0093` /
  // `ADR-0095` / `ADR-0112` / `ADR-0113` / `ADR-0118` / `ADR-0102` / `ADR-0104` / `ADR-0289`
  // が順に 29 まで積んだこと)は、その語彙ごとここで消える。**
  // **今日は 1キー減って 28 である** —— **減ったのは `audience` ちょうど1本だけであること
  // を、下の2行が押さえる。**
  const properties = Object.keys(schema().$defs.view?.properties ?? {});
  // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】期待値を 28 → 29 へ書き換えた。**
  // **旧行の逐語**: `expect(properties).toHaveLength(28);`
  // **書き換えた理由**: この行が固定していたのは「**その決定**が `$defs/view.properties` の本数 を増やさなかったこと」であり、
  // **29本目を足したのは別の決定である**(`V8-M8` が 集計表の宣言 `report` を29キー目として足した)。**検査は消していない。**
  // **【2026-08-20。`V10-M1-T02`。台帳 `NV-G4`。門A 本審査 = `V10-M0` 群A。ADR = `0359`】**
  // **期待値を 29 → 30 へ書き換えた。****旧行の逐語**: `expect(properties).toHaveLength(29);`
  // **30本目を足したのは別の決定である**(`ADR-0359` §4a 限定1 が削除後の行き先
  // `after_delete` を30キー目として足した)。**`audience` は今日も1本も戻っていない。**
  // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。門A 本審査 = `V10-M0` 群B。ADR = `0359` / `0360`】**
  // **期待値を 30 → 31 へ書き換えた。****旧行の逐語**: `expect(properties).toHaveLength(30);`
  // **31本目を足したのは別の決定である**(`ADR-0359` §4b 限定1 が一続きの流れの中の段
  // `flow` を**末尾に**31キー目として足した。**`list_view` / `form` / `detail_view` の3種別で
  // 書け、集計表(`report_view`)には書けない**)。
  // **本ファイルが測っている決定の増分ではない。****検査は消していない。**
  expect(properties).toHaveLength(31);
  expect(properties).not.toContain("audience");
  // **19キー目(添字18)に居たのは `audience` だった。今日そこに居るのは `menu_listed` である**
  // —— **`audience` が抜けて後ろが1つずつ繰り上がった、という事実をそのまま固定する。**
  expect(properties[18]).toBe("menu_listed");
});

// 【`V5-M29-T05` / `ADR-0250` 限定10 + 限定11】ここにあった test を、ブロックごと消した。
//   消したテスト名(逐語): 「(a) $defs の本数は 28 のまま(限定1: 新しい定義を1つも作らない)」
//   そのブロックが測っていたもの:
//     - `expect(Object.keys(schema().$defs)).toHaveLength(28)`(主張の逐語はブロック内のコメント
//       「**値域の enum は `$defs/view/properties/audience` にインラインで書く。** 新しい `$defs`
//       (例 `audience_role`)を作ると 28 が 29 になり、限定1 に反する。」)
//   移し先は `scripts/vocabulary-drift.test.ts`(一覧の `manifest.$defs:` で始まる行)。
//   **`expect()` が1つも残らないので空の test を残さなかった**(空の test は緑を返し、
//   検出力0のまま `Ran` を水増しする)。
//   **テスト名が持っていた日本語の宣言は、ここでリポジトリから消える**(`ADR-0250` §Decision 5 の (4))。

test("(a) $defs/field.properties から audience と writable_by が消えて 12キーになった(J-G28)", () => {
  // **【`V8-M20` / `J-G28` / `ADR-0301`】項目の「見せる相手」(`field.audience`)と
  // 「書ける相手」(`field.writable_by`)を廃止した。** **代わりに立つのは
  // 役割 x 対象(項目)x 読取 / 書込 である。**
  // **旧: `expect(keys).toHaveLength(14);` /
  //   `expect(keys.filter((key) => key === "audience")).toHaveLength(1);`**
  // **旧の趣旨は「`ADR-0070` の増分は `view` 側の1キーだけで、`field` 側の増分は
  // `ADR-0071` / `ADR-0076` / `ADR-0086` / `ADR-0090` / `ADR-0119` / `ADR-0288` /
  // `ADR-0290` という別の門の別の増分である」だった。**
  // **今日は 14 → 12** —— **`audience`(`ADR-0071`)と `writable_by`(`ADR-0076`)の2本が
  // 消えた。** **他の増分は1本も消えていない。**
  const keys = Object.keys(schema().$defs.field?.properties ?? {});
  expect(keys).toHaveLength(12);
  expect(keys).not.toContain("audience");
  expect(keys).not.toContain("writable_by");
});

// --- (b) 何が書けるか(旧宣言は書けない / 面の規則は書ける)-----------------------------

const APP_ID = "audience-app";

/** 画面1つと表1つだけのマニフェスト。`extra` を `app` に混ぜられる(`roles` を渡すため)。 */
function manifestWith(view: Record<string, unknown>, extra?: Record<string, unknown>): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "宣言テスト",
      tables: [
        {
          id: "product",
          name: "商品",
          fields: [
            { id: "name", name: "名称", type: "text", required: true },
            { id: "stock", name: "在庫", type: "number" },
          ],
        },
      ],
      views: [view as never],
      ...(extra ?? {}),
    },
  } as unknown as Manifest;
}

/** 既定の役割定義3本。**`set_roles` は全体差し替えなので、これを外すと適用できない。** */
const DEFAULTS = [
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

const ADMIN_LIST: Record<string, unknown> = {
  id: "admin-list",
  type: "list_view",
  table: "product",
  columns: ["name"],
};

function applyIn(manifest: Manifest): { valid: boolean; messages: string[] } {
  const dataRoot = mkdtempSync(join(tmpdir(), "gp-audience-"));
  try {
    const store = KernelMetaStore.open(dataRoot);
    try {
      createApp(store, "宣言テスト", { app_id: APP_ID });
    } finally {
      store.close();
    }
    const result = applyManifest(dataRoot, APP_ID, manifest);
    return {
      valid: result.valid,
      messages: result.valid ? [] : result.errors.map((e) => e.message),
    };
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

test("(b) 画面に audience を書いたマニフェストは、もう適用できない(V8-M20 / J-G27)", () => {
  // **【`V8-M20` / `J-G27` / `ADR-0301`】この test は置き直しである。**
  // **旧テスト名(逐語)**: 「(b) audience に4ロールを書いたマニフェストは適用できる(限定2 の値域)」。
  // **旧本体**: `["owner"] / ["editor"] / ["viewer"] / ["customer"] / ["owner","editor"]` の
  // 5通りについて `applyIn(manifestWith(value)).valid` が `true` であることを測っていた。
  // **今日はどれも `false` である** —— **キーが `schemas/manifest.schema.json` から消えたので、
  // `additionalProperties: false` が弾く。**
  // **「黙って無視される」のではなく拒否されることを、ここで固定する** ——
  // **書いた人が守られていると思い込む形にしない。**
  for (const value of [["owner"], ["editor"], ["viewer"], ["customer"], ["owner", "editor"]]) {
    expect(
      applyIn(manifestWith({ ...ADMIN_LIST, audience: value })).valid,
      JSON.stringify(value),
    ).toBe(false);
  }
});

test("(b) 同じ見せ分けは、面の規則(役割 x 画面 x 読取)として書けて適用できる", () => {
  // **【`V8-M20` / `J-G27` / `ADR-0301`】旧 `audience: ["owner","editor"]` の置き直し先。**
  // **`owner` と `editor` にだけ `{target:"view", view:"admin-list", can:["read"]}` を書く。**
  // **`viewer` には書かない** —— **1本でも書かれた対象は allow-list になるので、それで締まる。**
  const applied = applyIn(
    manifestWith(ADMIN_LIST, {
      roles: [
        {
          id: "owner",
          name: "持ち主",
          rules: [
            // **【`V8-M28` / `T-G16a`】持ち主にはこの2行が必ず要る**(適用時検査 = 類型17 の拡張)。
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
            { target: "view", view: "admin-list", can: ["read"] },
          ],
        },
        {
          id: "editor",
          name: "編集者",
          rules: [{ target: "view", view: "admin-list", can: ["read"] }],
        },
        { id: "viewer", name: "閲覧者" },
      ],
    }),
  );
  expect(applied.valid, applied.messages.join(" / ")).toBe(true);
});

test("(b) 画面の規則に書ける動詞は read だけである(write / delete は適用時に拒否される)", () => {
  // **【`V8-M20` / `J-G27`】この test は置き直しである。**
  // **旧テスト名(逐語)**: 「(c) audience の値域は `ADR-0074` により 4 → 5 になった(`B-G1` は1値も足していない)」。
  // **旧本体**: `applyIn(manifestWith(["anonymous"])).valid === true` と、
  //   `$defs/view/properties/audience/items` の `enum` が `undefined` で `pattern` が
  //   `"^[a-z0-9_]{1,32}$"` であることを測っていた(`ADR-0159` が `enum` を `pattern` に替えた後の形)。
  // **旧の問いは「画面の見せ分けの宣言に何が書けるか」だった。** **その問いを面の側で置き直す** ——
  // **画面(`target: "view"`)に書ける動詞は `read` だけであり**(schema の `allOf` が
  // `can.items` を `{"const":"read"}` に閉じている)、**`write` / `delete` は書けない。**
  for (const can of [["write"], ["delete"], ["read", "write"]]) {
    const applied = applyIn(
      manifestWith(ADMIN_LIST, {
        roles: [
          { id: "owner", name: "持ち主", rules: [{ target: "view", view: "admin-list", can }] },
          { id: "editor", name: "編集者" },
          { id: "viewer", name: "閲覧者" },
        ],
      }),
    );
    expect(applied.valid, JSON.stringify(can)).toBe(false);
  }
});

test("(b) 実在しない画面ID・空の規則・既定3ロールの欠落は書けない", () => {
  // **【`V8-M20` / `J-G27`】この test は置き直しである。**
  // **旧テスト名(逐語)**: 「(c) 宣言していない種類名・空配列・重複は書けない」。
  // **旧本体**: `["admin"]` / `[]` / `["owner","owner"]` / `"owner"`(配列でない)の4通りが
  //   `applyIn(...).valid === false` であることを測っていた。
  // **旧の問いは「宣言の形が閉じているか」だった。** **面の側で同じ問いを置き直す。**

  // (1) **実在しない画面IDを指す規則**(適用時の参照整合検査 = 類型16)。
  //
  // **【`V8-M26` / ユーザ決定 `D-V8-66`。期待値を反転させた。旧文を1バイトも消していない】**
  // **旧(逐語)**: `).toBe(false);` —— **実在しない画面を指す規則は書けなかった。**
  // **今日は `true` である** —— **`D-V8-66` が `src/kernel/referential-integrity.ts` の
  // 類型16 から `rules[].table` / `rules[].field` / `rules[].view` / `rules[].action` の
  // 実在検査4本を撤去したためである。**
  // **理由(`D-V8-66` の逐語の要旨)**: **`V8-M26` の自動付与が `add_view` のたびに規則を
  // 足すのに `remove_view` はカスケードしないので、旧の検査を残すと「後から作った画面を
  // 消せない」ことになった。** **`ADR-0086` 限定4 の「書けるが必ず効かない組み合わせを
  // 1つも作らない」を、役割の規則についてだけ正面から破った結果である。**
  expect(
    applyIn(
      manifestWith(ADMIN_LIST, {
        roles: [
          {
            id: "owner",
            name: "持ち主",
            rules: [
              // **【`V8-M28` / `T-G16a`】持ち主にはこの2行が必ず要る**(適用時検査 = 類型17 の拡張)。
              { target: "app", can: ["write"] },
              { target: "role", can: ["write"] },
              { target: "view", view: "no-such-view", can: ["read"] },
            ],
          },
          { id: "editor", name: "編集者" },
          { id: "viewer", name: "閲覧者" },
        ],
      }),
    ).valid,
  ).toBe(true);

  // (2) **空の規則の配列**(`minItems: 1`。「0本書く」と「書かない」の2通りを作らない)。
  expect(
    applyIn(
      manifestWith(ADMIN_LIST, {
        roles: [{ id: "owner", name: "持ち主", rules: [] }, ...DEFAULTS.slice(1)],
      }),
    ).valid,
  ).toBe(false);

  // (3) **同じ役割IDを2度書く**(適用時検査 = 類型5 の補遺)。
  expect(
    applyIn(
      manifestWith(ADMIN_LIST, {
        roles: [...DEFAULTS, { id: "owner", name: "もう1人の持ち主" }],
      }),
    ).valid,
  ).toBe(false);

  // (4) **既定3ロールを1つでも欠く**(適用時検査 = 類型17。`set_roles` は全体差し替え)。
  expect(
    applyIn(manifestWith(ADMIN_LIST, { roles: [{ id: "owner", name: "持ち主" }] })).valid,
  ).toBe(false);
});

// --- (d) 規則を1本も書いていない画面は今日どおり(裁定 `R-4` の管轄外)------------------

test("(d) 役割を1つも宣言していないマニフェストは今日どおり適用できる", () => {
  // **【`V8-M20` / `J-G27`】旧テスト名(逐語)**: 「(d) audience を書いていないマニフェストは
  // 今日どおり適用できる(限定4)」。**問い(宣言を書かないアプリが壊れないこと)は同じである。**
  // **`app.roles` は今日も `required` に入っていない** —— 省略は「役割を1つも宣言していない」。
  expect(applyIn(manifestWith(ADMIN_LIST)).valid).toBe(true);
});

test("(d) 規則を1本も書いていない画面は、どのロールにも許される(裁定 R-4 の管轄外)", () => {
  // **【`V8-M20` / `J-G27`】この test は置き直しである。**
  // **旧テスト名(逐語)**: 「(d) audience を書いていないビューは、どのロールにも許される(限定4)」。
  // **旧本体**: `viewAudience(view)` が `undefined` を返し、
  //   `isViewAudienceAllowed(view, role)` が owner / editor / viewer / customer / null の
  //   5通りすべてで `true` を返すことを測っていた。
  // **`viewAudience` / `isViewAudienceAllowed` は `owner-scope.ts` から消えたので、
  // 同じことを `judgeRoleAccess` で言う。**
  const manifest = {
    app: {
      roles: [
        // **別の画面には規則が在る。** それでも `v` は管轄外である(対象ごとに独立)。
        { id: "owner", rules: [{ target: "view", view: "other", can: ["read"] }] },
        { id: "editor" },
        { id: "viewer" },
      ],
    },
  };
  for (const roles of [["owner"], ["editor"], ["viewer"], ["customer"], null] as const) {
    const decision = judgeRoleAccess({
      manifest,
      roles,
      target: { target: "view", view: "v" },
      verb: "read",
    });
    // **【`V8-M26` / ユーザ決定 `D-V8-45` / `D-V8-58`。期待値を3行とも反転させた。
    // 旧文を1バイトも消していない】**
    // **旧(逐語)**:
    //   `expect(decision.governed, String(roles)).toBe(false);`
    //   `expect(decision.allowed, String(roles)).toBe(true);`
    //   `expect(decision.blockedBy, String(roles)).toBeNull();`
    // **今日は逆である** —— **規則を1本も書いていない画面は「管轄外(全許可)」ではなく
    // 「閉じる側の管轄内」になった**(`CLOSED_ROLE_ACCESS`)。
    // **`owner` も例外ではない** —— **1本目の実測が `roles: ["owner"]` で落ちた。**
    // **`field`(項目)だけは今日も管轄外である**(台帳 `T-G1b` = 却下)。
    expect(decision.governed, String(roles)).toBe(true);
    expect(decision.allowed, String(roles)).toBe(false);
    expect(decision.blockedBy, String(roles)).toBe("role");
  }
  // **【`V8-M26`】上の反転が「画面だから」ではなく「項目以外だから」であることを、
  // 同じマニフェストの項目で1件だけ押さえる** —— **項目は今日も管轄外(全許可)である。**
  const field = judgeRoleAccess({
    manifest,
    roles: ["owner"],
    target: { target: "field", table: "product", field: "name" },
    verb: "read",
  });
  expect(field.governed).toBe(false);
  expect(field.allowed).toBe(true);
});

// --- (e) 述語(サーバ層の `?view=` の遮断が呼ぶ1本)-------------------------------------

test("(e) judgeRoleAccess は、規則が1本でも在る画面を allow-list として扱う", () => {
  // **【`V8-M20` / `J-G27`】この test は置き直しである。**
  // **旧テスト名(逐語)**: 「(e) viewAudience は宣言された列挙をそのまま返し、宣言が無ければ
  //   undefined を返す」。
  // **旧本体**: `viewAudience({... audience:["owner"]})` が `["owner"]` を、宣言が無ければ
  //   `undefined` を、`audience: []` なら `[]` を返すことを測っていた(壊れた値を「宣言が無い」に
  //   倒さない、という向きの正直さ)。
  // **面には「宣言の列挙を返す読み手」が無い**(判定1本しか無い)ので、**同じ向きのことを
  // `governed` の旗で言う** —— **規則が在れば管轄内、無ければ管轄外。**
  const ruled = {
    app: {
      roles: [
        { id: "owner", rules: [{ target: "view", view: "v", can: ["read"] }] },
        { id: "editor" },
        { id: "viewer" },
      ],
    },
  };
  const inside = judgeRoleAccess({
    manifest: ruled,
    roles: ["owner"],
    target: { target: "view", view: "v" },
    verb: "read",
  });
  expect(inside.governed).toBe(true);
  expect(inside.allowed).toBe(true);
  // **役割を1つも宣言していないアプリは、どの対象も管轄外である**(判定の1段目)。
  //
  // **【`V8-M26` / ユーザ決定 `D-V8-65`。期待値を2行とも反転させた。旧文を1バイトも
  // 消していない】**
  // **旧(逐語)**: `expect(none.governed).toBe(false);` / `expect(none.allowed).toBe(true);`
  // **今日は「役割を1つも宣言していないアプリも閉じる」**(`D-V8-65`)——
  // **判定の1段目で `CLOSED_ROLE_ACCESS` が返る。** **すぐ上のコメント1行
  // (「どの対象も管轄外である」)は、今日は項目についてだけ真である。**
  const none = judgeRoleAccess({
    manifest: { app: {} },
    roles: ["owner"],
    target: { target: "view", view: "v" },
    verb: "read",
  });
  expect(none.governed).toBe(true);
  expect(none.allowed).toBe(false);
  // **項目だけは今日も1段目で全許可のまま抜ける**(台帳 `T-G1b` = 却下)。
  const noneField = judgeRoleAccess({
    manifest: { app: {} },
    roles: ["owner"],
    target: { target: "field", table: "t", field: "f" },
    verb: "read",
  });
  expect(noneField.governed).toBe(false);
  expect(noneField.allowed).toBe(true);
});

test("(e) judgeRoleAccess は規則を書いた役割だけを通す(未ログインも通さない)", () => {
  // **【`V8-M20` / `J-G27`】この test は置き直しである。**
  // **旧テスト名(逐語)**: 「(e) isViewAudienceAllowed は列挙にあるロールだけを通す(未認証は通さない)」。
  // **旧本体**: `audience: ["owner","editor"]` の画面について owner / editor が `true`、
  //   viewer / customer / `null`(未認証)が `false` であることを測っていた。
  // **同じ形が面でそのまま言える** —— **`owner` と `editor` にだけ規則を書く。**
  // **未ログインは `anonymous` として判定される**(`roleSubjectsOf`)—— **`anonymous` に
  // 規則を書いていないので通らない。**
  const manifest = {
    app: {
      roles: [
        { id: "owner", rules: [{ target: "view", view: "v", can: ["read"] }] },
        { id: "editor", rules: [{ target: "view", view: "v", can: ["read"] }] },
        { id: "viewer" },
      ],
    },
  };
  const judge = (roles: readonly string[] | null) =>
    judgeRoleAccess({
      manifest,
      roles: roles as never,
      target: { target: "view", view: "v" },
      verb: "read",
    }).allowed;
  expect(judge(["owner"])).toBe(true);
  expect(judge(["editor"])).toBe(true);
  expect(judge(["viewer"])).toBe(false);
  expect(judge(["customer"])).toBe(false);
  expect(judge(null)).toBe(false);
});

// --- (f) 予約規約フィールド(`J-G30`)---------------------------------------------------

test("(f) 予約規約フィールドは 4本である(V8-M20 / J-G30 で st_admin_readable が消えた)", () => {
  // **【この検査は 2026-08-03 の `work/v4-m4` / `work/v4-m3` のマージで一度書き直している】**
  // 経緯と原典の逐語は `docs/plan/v4/records/v4-m3-m4-merge.md` §2-1。
  // **そのときの趣旨は「`B-G1` が予約規約フィールドを1本も足していないこと」だった。**
  //
  // **【`V8-M20` / `J-G30` / `ADR-0301` による更新】**
  // **`st_admin_readable`(運営には全員分の行を見せる、という規約フィールド)を廃止した。**
  // **代わりに立つのは 役割 x 対象(表)x 読取である**(`app.roles[].rules` の
  // `{ "target": "table", "table": "<表ID>", "can": ["read"] }`)。
  // **旧: `expect(declared.sort()).toEqual(["ADMIN_READABLE_FIELD","NO_DIRECT_CREATE_FIELD",
  //   "OWNER_FIELD","PUBLIC_FIELD","UNDELETABLE_FIELD"]);`(5本)。**
  // **今日は 4本である。** **消えたのは `ADMIN_READABLE_FIELD` ちょうど1本で、
  // 他の4本(`st_owner` = `ADR-0016` / `st_public` = `ADR-0034` /
  // `st_undeletable` = `ADR-0073` / `st_no_direct_create` = `ADR-0077`)は1本も消えていない。**
  //
  // **【`ADR-0301` 限定10 に従い、誇張しない】** **「語彙が減った」を成果として書かない。**
  // **減ったのはこの1本であって、代わりに立った面の規則は別の場所で増えている。**
  const source = readFileSync(join(import.meta.dir, "owner-scope.ts"), "utf-8");
  // **素朴な `grep -c "^export const .*_FIELD"` は `ANON_RESERVED_FIELDS`(予約規約
  // フィールドの**一覧**であって予約規約フィールドではない)を拾う**(`ADR-0073` 限定2 の実測)。
  // **`= "st_..."` まで要求する形で数える。**
  const declared = [...source.matchAll(/^export const ([A-Z_]+_FIELD) = "(st_[a-z_]+)";$/gm)].map(
    (m) => m[1] as string,
  );
  expect(declared.sort()).toEqual([
    "NO_DIRECT_CREATE_FIELD",
    "OWNER_FIELD",
    "PUBLIC_FIELD",
    "UNDELETABLE_FIELD",
  ]);
  expect(declared).not.toContain("ADMIN_READABLE_FIELD");

  // **画面の見せ分けは、今日も予約規約フィールドには置かれていない** ——
  // **置き場は `app.roles[].rules` である**(旧は `$defs/view` の `audience` キーだった)。
  expect(declared.filter((name) => name.includes("AUDIENCE"))).toEqual([]);
  expect(source).not.toContain('_FIELD = "st_audience"');
});
