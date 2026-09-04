/**
 * `B-G5`(未ログインでも見られる画面を作りたい)の**表示層の契約**の検査
 * (`V4-M2-T05` / `T06` / `T07`)。
 *
 * 判定の正は `docs/plan/v4/records/v4-m2-gate-a-anonymous-view.md`(門A 本審査 = **限定採用**)、
 * 限定表の正は `docs/adr/0074-anonymous-view-audience.md` §3(**12点**)、
 * 完了条件の正は `docs/plan/v4/records/v4-m2.md` §2、
 * `ADR-0014:80` の完了条件の定義文の改訂は `docs/adr/0075-authentication-completion-redefinition.md`。
 *
 * **サーバ側の契約は `src/server/anonymous-view-audience.test.ts` が持つ。2つを混ぜない。**
 *
 * ## ここが押さえる限定(`ADR-0074` §3)
 *
 * | # | 限定 | ここでの検査 |
 * |---|---|---|
 * | 5 | `audience` を書いていない画面は、匿名に1画面も見せない | (b) / (e) |
 * | 6 | **匿名で書込 UI が出ない**(`canWriteRole(null, table)` が `false`) | (a) |
 * | 7 | 匿名の可視集合は `anonymous` と書かれた画面だけである | (b) |
 * | —— | `ROLE_LABELS` に `anonymous` を足さない(`ADR-0074` §3a-5) | (c) |
 * | —— | ログイン画面に導線を置く(`D-V4-20` (b)) | (d) |
 *
 * ## 【`V8-M20`(2026-08-10)。台帳 `J-G27`。手続きは `ADR-0301`】**既定の向きが1つ変わった**
 *
 * **`view.audience` は廃止され、代わりに面(`app.roles[].rules` の
 * `{ target: "view", view: <画面ID>, can: ["read"] }`)が立った。**
 * **未ログインは面では `anonymous` を主体として判定される**(`J-G11`)。
 *
 * **【ここが同じにならない1点。誇張しない】**
 * **旧層の限定5 / 限定7 は「`audience` を書いていない画面は匿名に1画面も見せない」という
 * **閉じる向きの既定**だった。** **面の既定は「規則を1本も書いていない対象は管轄外
 * (全許可)」である**(裁定 `R-4`)。
 * **したがって規則を1本も書いていないアプリでは、未ログインに画面が並ぶ側に倒れる。**
 * **【禁止の履行】これを「同じ挙動を保った」と書かない。**
 * **この向きそのものを固定するのが (b) の1本目と (e) の4本目である**
 * (**どちらも旧の期待値を反転させた。旧の期待値はその場のコメントに逐語で残してある**)。
 *
 * **もう1つの帰結**: **旧層では「宣言を書かない」だけで匿名から隠せたが、面では
 * **他の役割が名指しする**ことで初めて匿名から隠れる。** **題材 `shopManifest()` の
 * `admin-product-form` は、旧では宣言0本で匿名から隠れていたが、今日は
 * customer / editor / viewer / owner の規則がそれを名指しすることで隠れている。**
 *
 * ## 【`V8-M26`(2026-08-10)。ユーザ決定 `D-V8-45` / `D-V8-65`】**その向きがもう1度変わった**
 *
 * **上の「面の既定は管轄外(全許可)」は今日から偽である**(**旧文は1バイトも消していない**)——
 * **`V8-M26-T03` が `judgeRoleAccess` の既定を閉じる側へ倒し、`table` / `view` / `action` は
 * 規則が1本も名指ししていなければ拒否される**(`field` だけは今日どおり開いたまま。
 * 台帳 `T-G1b` = 却下)。**役割を1つも宣言していないアプリも閉じる**(`D-V8-65`)。
 * **未ログイン(`anonymous`)にも同じ向きが及ぶ**(台帳 `T-G26a`)。
 *
 * **したがって `V8-M20` が反転させた2本((b) の1本目 / (e) の4本目)は、今日もう1度
 * 反転して旧層(`ADR-0074` 限定5 / 限定7)と同じ側 —— **規則を1本も書いていないアプリでは
 * 未ログインに1画面も出ない** —— に戻った。** **`V8-M20` の期待値は逐語でその場に残してある。**
 *
 * **【正直に書く】これは「`ADR-0074` の閉じる向きが復活した」のであって、
 * `ADR-0074` の宣言(`view.audience`)が戻ったのではない。** **閉じているのは面の既定である。**
 *
 * ## この検査が言わないこと(**誇張しない**)
 *
 * - **`GET /api/apps/:app_id/manifest` は今日も未認証で全ビュー定義を返す**(限定9)。
 *   **匿名に見せないと宣言した画面の定義も読める。「宣言で隠す」は情報の遮断ではない。**
 * - **UI が隠すことは遮断ではない**(`ADR-0053:41`)。**遮断はサーバの 403 / 401 である。**
 * - **匿名に返る行は今日どおり `st_public` が真の行に限られる**(`ADR-0074` §3a-2)——
 *   **`anonymous` と宣言した画面の対象テーブルが公開でなければ、開いても行は返らない。**
 *   **本 ADR はそこを1ミリも変えていない。**
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { Manifest, Table } from "../../src/kernel/types.ts";
import { App } from "../src/App.tsx";
import { ANONYMOUS, canWriteRole, roleLabels, visibleViewsForRole } from "../src/auth/authz.tsx";

const APP_ID = "anon-shop";

/** 公開テーブル1本と、宣言のある画面2本 + 宣言の無い画面1本。 */
function shopManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "匿名ショップ",
      tables: [
        {
          id: "product",
          name: "商品",
          fields: [
            { id: "name", name: "名称", type: "text", required: true },
            { id: "st_public", name: "公開", type: "boolean" },
          ],
        },
      ],
      views: [
        // **匿名から隠す画面**(旧は「宣言の無い画面」。今日は他の役割が名指しして隠す)。
        {
          id: "admin-product-form",
          name: "商品登録",
          type: "form",
          table: "product",
          fields: ["name"],
        },
        // **匿名に見せると宣言した画面。**
        {
          id: "catalog-list",
          name: "商品一覧",
          type: "list_view",
          table: "product",
          columns: ["name"],
        },
        // **運営にだけ見せると宣言した画面**(匿名には見せない)。
        {
          id: "admin-product-list",
          name: "商品台帳",
          type: "list_view",
          table: "product",
          columns: ["name"],
        },
      ],
      /*
       * **【`V8-M20` / `J-G27`】旧の `view.audience` 3本を、面の規則へ置き直した。**
       *
       * **旧の逐語**:
       *   - `admin-product-form` … `audience` を1つも書かない(= 匿名以外の全員に見える)
       *   - `catalog-list`       … `audience: ["anonymous", "customer"]`
       *   - `admin-product-list` … `audience: ["owner"]`
       *
       * **`admin-product-form` に規則が要るのは、面の既定が「書かなければ全員に見える」で
       * あり、旧の「書かなければ匿名には見せない」ではないからである。**
       * **これは置き直しの副作用であって、隠す強さが増えたのではない。**
       */
      roles: [
        { id: "anonymous", rules: [{ target: "view", view: "catalog-list", can: ["read"] }] },
        {
          id: "customer",
          rules: [
            { target: "view", view: "catalog-list", can: ["read"] },
            { target: "view", view: "admin-product-form", can: ["read"] },
          ],
        },
        { id: "editor", rules: [{ target: "view", view: "admin-product-form", can: ["read"] }] },
        { id: "viewer", rules: [{ target: "view", view: "admin-product-form", can: ["read"] }] },
        {
          id: "owner",
          rules: [
            { target: "view", view: "admin-product-form", can: ["read"] },
            { target: "view", view: "admin-product-list", can: ["read"] },
          ],
        },
      ],
    },
  };
}

/**
 * **匿名に1画面も見せないアプリ**(`(d)` の2本目が要る題材)。
 *
 * **【`V8-M20`】旧はここに `plainManifest()`(宣言を1つも書いていないアプリ)を渡していた** ——
 * **面の既定では、それは「匿名に全画面が見える」側に倒れるので、もう 0件の題材ではない。**
 * **0件を作るには、全部の画面を匿名以外の役割が名指しする必要がある。**
 */
function closedManifest(): Manifest {
  const base = plainManifest();
  base.app.roles = [
    {
      id: "owner",
      rules: [
        { target: "view", view: "entry-list", can: ["read"] },
        { target: "view", view: "entry-form", can: ["read"] },
      ],
    },
  ];
  return base;
}

/** 宣言を1つも書いていないマニフェスト(既存アプリの代表)。 */
function plainManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "宣言なしアプリ",
      tables: [
        {
          id: "entries",
          name: "エントリ",
          fields: [{ id: "label", name: "ラベル", type: "text", required: true }],
        },
      ],
      views: [
        { id: "entry-list", name: "一覧", type: "list_view", table: "entries", columns: ["label"] },
        { id: "entry-form", name: "登録", type: "form", table: "entries", fields: ["label"] },
      ],
    },
  };
}

function tableOf(manifest: Manifest, id: string): Table {
  const table = manifest.app.tables.find((t) => t.id === id);
  if (table === undefined) throw new Error(`no table ${id}`);
  return table;
}

// ---------------------------------------------------------------------------
// (a) 匿名で書込 UI が出ない(`ADR-0074` 限定6 / 台帳の `B-G5` 完了条件2)
// ---------------------------------------------------------------------------

describe("(a) canWriteRole(null) は書込不可である(ADR-0074 限定6)", () => {
  test("provider 外(role === null)は書込不可に倒れる —— テーブルを渡しても渡さなくても", () => {
    // **【この検査を消してはならない】** 消すと `canWriteRole(null)` が `true` に戻っても
    // 誰も気づかない。**消すと赤くなること**は `V4-M2-T06` の完了条件5 が1度確かめた。
    //
    // **着手前は `true` だった**(`web/src/auth/authz.tsx` のヘッダが「provider の外(既定)
    // では `role = null` = 書込可」と明示的に決めていた。2026-08-03 実測)。
    // **`ADR-0074` 限定6 がこれを `false` に反転させた** —— **匿名に画面を開いた瞬間、
    // `RoleProvider` が包んでいない subtree に `null` が流れ、保存・編集・削除ボタンが
    // 匿名に出るからである**(審査記録 §3 の S3-2a)。
    const manifest = shopManifest();
    expect(canWriteRole(null)).toBe(false);
    expect(canWriteRole(null, undefined)).toBe(false);
    expect(canWriteRole(null, tableOf(manifest, "product"))).toBe(false);
  });

  test("既存4ロールの答えは1つも変わっていない(反転したのは null だけである)", () => {
    const manifest = shopManifest();
    const product = tableOf(manifest, "product");
    expect(canWriteRole("owner")).toBe(true);
    expect(canWriteRole("editor")).toBe(true);
    expect(canWriteRole("viewer")).toBe(false);
    expect(canWriteRole("owner", product)).toBe(true);
    expect(canWriteRole("editor", product)).toBe(true);
    expect(canWriteRole("viewer", product)).toBe(false);
    // customer は今日どおりテーブル単位(公開テーブルは `scoped` ではないので不可)。
    //
    // --- 【`V8-M27-T04` / `T-G5`。期待値を反転させた。旧の1行を1バイトも消していない】 ---
    //
    // **旧(逐語)**: `expect(canWriteRole("customer", product)).toBe(false);`
    // **上の説明も旧のものである。**
    // **根拠**: **`V8-M27` / 台帳 `T-G5` / ユーザ決定 `D-V8-38`。**
    // **`canWriteRole` から表単位の枝(`nonAdminTableAccess`)を撤去した** ——
    // **`customer` は表の作りでは落ちなくなった。**
    // **このテスト名の「既存4ロールの答えは1つも変わっていない」は今日から偽である。**
    // **`null` / `ANONYMOUS` / `viewer` の答えは1バイトも変わっていない**(上下の行)。
    expect(canWriteRole("customer", product)).toBe(true);
  });

  test("匿名は書込不可である(ANONYMOUS を直接渡しても同じ答えになる)", () => {
    expect(canWriteRole(ANONYMOUS)).toBe(false);
    expect(canWriteRole(ANONYMOUS, tableOf(shopManifest(), "product"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (b) 匿名の可視集合(`ADR-0074` 限定5 / 限定7)
// ---------------------------------------------------------------------------

describe("(b) 匿名に見えるのは anonymous と宣言した画面だけである", () => {
  test("【向きが戻った】規則を1本も書いていないアプリでは、未ログインに1画面も並ばない", () => {
    // **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65` で期待値をもう1度反転させた。
    //   `V8-M20` の逐語も、その下に残っている旧層の逐語も1バイトも消していない】**
    //
    // **`V8-M20` のテスト名**: 「【向きが変わった】規則を1本も書いていないアプリでは、
    // 未ログインに全画面が並ぶ」。
    // **`V8-M20` の期待値(逐語)**:
    //   `expect(visibleViewsForRole(ANONYMOUS, plain).map((v) => v.id)).toEqual([`
    //   `  "entry-list",`
    //   `  "entry-form",`
    //   `]);`
    //
    // **今日**: **`V8-M26-T03` が面の既定を閉じる側へ倒した**(`table` / `view` / `action`)。
    // **役割を1つも宣言していないアプリも閉じ**(`D-V8-65`)、**未ログインにも同じ向きが
    // 及ぶ**(台帳 `T-G26a`)。**よって 0件に戻った。**
    // **【禁止の履行】これを「同じ挙動を保った」と書かない。向きは2度変わった。**
    // **【誇張しない】旧層(`ADR-0074` 限定5)と数が一致しただけであり、
    // 宣言(`view.audience`)が戻ったのではない。**
    // **【`V8-M20` / `J-G27` で期待値を反転させた。旧の逐語を1バイトも消していない】**
    //
    // **旧テスト名**: 「宣言を1つも書いていないアプリでは 0件になる(限定5)」。
    // **旧の期待値**: `expect(visibleViewsForRole(ANONYMOUS, plainManifest())).toHaveLength(0);`
    // **旧のコメント(逐語)**: 「**既定は「変えない」。既存の全アプリが1バイトの変更もなく
    // 今日どおり動く。** **`canReadTableRole(null, table)` は今日も `true` に倒れる**
    // (そちらは1バイトも変えていない)。**匿名の可視集合をそれで決めていたら全ビューが
    // 並ぶ** —— だから匿名は別の述語(`isViewAnonymousVisible`)で決める(審査記録 §3 の
    // S3-2a)。」
    //
    // **今日**: **`isViewAnonymousVisible` は撤去され、匿名も面(`judgeRoleAccess`)で
    // 決まる。** **面の既定は管轄外(全許可)なので、旧のコメントが名指ししていた
    // 「全ビューが並ぶ」がそのまま起きる。**
    // **【禁止の履行】これを「同じ挙動を保った」と書かない。向きは変わった。**
    const plain = plainManifest();
    expect(visibleViewsForRole(ANONYMOUS, plain).map((v) => v.id)).toEqual([]);
    // **【`V8-M20` の逐語】「閉じるには、匿名以外の役割が全画面を名指しする必要がある。」**
    // **今日はその手当てが要らない**(既定で閉じている)—— **`closedManifest()` でも
    // 同じ 0件になることを、対照として残しておく。**
    expect(visibleViewsForRole(ANONYMOUS, closedManifest())).toHaveLength(0);
  });

  test("宣言した画面だけが、マニフェストの順序のまま並ぶ(限定7)", () => {
    const manifest = shopManifest();
    const views = visibleViewsForRole(ANONYMOUS, manifest);
    expect(views.map((v) => v.id)).toEqual(["catalog-list"]);
    // **匿名の役割が名指しした画面数と一致する**(旧は `audience` に `anonymous` が
    // 入っている画面を数えていた。**数える先だけが面へ移った**)。
    const anonymousRules = (manifest.app.roles ?? []).filter((role) => role.id === "anonymous");
    const declared = manifest.app.views.filter((v) =>
      anonymousRules.some((role) =>
        (role.rules ?? []).some(
          (rule) => rule.target === "view" && rule.view === v.id && rule.can.includes("read"),
        ),
      ),
    );
    expect(views).toHaveLength(declared.length);
  });

  test("ログイン済みのロールの見え方は1つも変わっていない", () => {
    const manifest = shopManifest();
    // owner: 宣言の無い画面 + 自分に宣言された画面(`anonymous` だけの画面は見えない)。
    expect(visibleViewsForRole("owner", manifest).map((v) => v.id)).toEqual([
      "admin-product-form",
      "admin-product-list",
    ]);
    // customer: **宣言の無い画面は今日どおり `nonAdminTableAccess` 次第で見える**
    // (`product` は `st_public` を持つので `admin-product-form` も customer には見える ——
    //  **これは `B-G5` が作った状態ではなく着手前からの状態である**)。
    // 宣言された画面は列挙どおり(owner だけを名指しした画面は消える)。
    expect(visibleViewsForRole("customer", manifest).map((v) => v.id)).toEqual([
      "admin-product-form",
      "catalog-list",
    ]);
    // **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65` で期待値を反転させた。
    //   旧の逐語を1バイトも消していない】**
    // **旧のコメント**: 「規則を書いていないアプリでは、既存ロールの一覧は1件も減らない。」
    // **旧の期待値**: `expect(visibleViewsForRole("owner", plainManifest())).toHaveLength(2);`
    // **今日**: **役割を1つも宣言していないアプリは画面を閉じる**(`D-V8-65`)——
    // **既存ロールの一覧も 0件になる。** **したがって上のテスト名
    // 「ログイン済みのロールの見え方は1つも変わっていない」は、
    // 規則を書いていないアプリについては今日から偽である**(**題材 `shopManifest()` の
    // 側は規則を持つので、そちらの期待値は1バイトも動いていない**)。
    expect(visibleViewsForRole("owner", plainManifest())).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (c) `anonymous` はロールではない(`ADR-0074` §3a-5)
// ---------------------------------------------------------------------------

test("(c) ロールの表示名に `anonymous` が1つも無い(匿名を5ロール目にしていない)", () => {
  // **`ADR-0033` §3a-1 の逐語**:「**5番目・6番目のロール(店員 / 配送業者 / ゲスト 等)を
  // 足す。** … **本 ADR は先例を作らない。**」**`Role` 型を増やすには別の門が要る。**
  // **`ADR-0074` が足したのは `audience` の値域の1値であって、認証のロールではない。**
  //
  // **【`V5-M17-T08` / `ADR-0158` / `ADR-0159` 限定5 で置き換えた。旧テスト名を先に書く】**
  // **旧テスト名**: 「(c) ROLE_LABELS は4値のままである(anonymous を5ロール目にしていない)」。
  // **旧本体**は `Object.keys(ROLE_LABELS)` が4値ちょうどであることを固定していた。
  // **`ADR-0158` がロール値をアプリの宣言に開いたので、「4値ちょうど」はもう成立しない。**
  // **測る対象を「宣言が無いアプリでは着手前と同じ4値」+「宣言があっても匿名は入らない」
  // に入れ替えた** —— **`ADR-0074` §3a-5 の線(匿名をロールにしない)は1ミリも緩めていない。**
  expect(Object.keys(roleLabels()).sort()).toEqual(["customer", "editor", "owner", "viewer"]);
  expect(Object.keys(roleLabels())).not.toContain("anonymous");
  // **宣言があっても匿名はロールにならない。**
  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`】旧の期待値(逐語)**:
  //     const declared = roleLabels([{ id: "member", name: "会員" }]);
  //     expect(Object.keys(declared).sort()).toEqual(["editor", "member", "owner", "viewer"]);
  //     expect(Object.keys(declared)).not.toContain("anonymous");
  // **引数が「宣言された利用者の種類」から「宣言された役割」に変わり、
  // `customer` は今日つねに対応表に載る**(値域から外す手段が無くなった)。
  // **測っている線(匿名をロールにしない。`ADR-0074` §3a-5)は1ミリも緩めていない。**
  // **【根拠を名指しで書く(メインの裁定3)】**
  // **値域を狭めていたのは `app.user_kinds` の宣言そのものである** ——
  // **`src/server/auth-routes.ts` の旧 `roleValuesForKinds` の逐語**:
  //     return [...RESERVED_ROLES, ...(kinds.length === 0 ? [DEFAULT_USER_KIND] : kinds)];
  // **`kinds` が空でないとき(= 立場を宣言したとき)、`DEFAULT_USER_KIND`(= `customer`)は
  // 戻りに1度も入らなかった。** **その `kinds` の唯一の出所は
  // `src/server/owner-scope.ts` の `effectiveUserKindIds`(= `app.user_kinds` を読む)であり、
  // `V8-M29` 第2波が `app.user_kinds` ごと廃止した。**
  // **代わりに立った `app.roles` は「既定に足す」ことしかできず、既定から引き算する
  // 書き方を1つも持たない**(台帳 `J-G2` の限定「アプリの作者は既定に足すことしか
  // できず、引き算(拒否)を1つも書けない」)。
  // **したがって、宣言の側から値域を狭める手段は今日1つも無い。担い手は無い**
  // (`ADR-0301` 限定6 の ④)。
  // **【禁止の履行】これを「影響は無い」と書かない** —— **実挙動が1つ変わった。**

  const declared = roleLabels([{ id: "member", name: "会員" }]);
  expect(Object.keys(declared).sort()).toEqual(["customer", "editor", "member", "owner", "viewer"]);
  expect(Object.keys(declared)).not.toContain("anonymous");
});

// ---------------------------------------------------------------------------
// (d) / (e) 画面としての振る舞い
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let originalFetch: typeof fetch;

function stub(manifest: Manifest, records: unknown[] = []): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input).split("?")[0] ?? "";
    if (url === `/api/apps/${APP_ID}/auth/me`) {
      return Promise.resolve(
        jsonResponse({ errors: [{ path: "", message: "認証されていません。" }] }, 401),
      );
    }
    if (url === `/api/apps/${APP_ID}/manifest`) {
      return Promise.resolve(jsonResponse(manifest));
    }
    if (url.endsWith("/records")) {
      return Promise.resolve(jsonResponse({ records, total: records.length }));
    }
    return Promise.resolve(jsonResponse({ errors: [{ path: "", message: "no stub" }] }, 404));
  }) as typeof fetch;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.history.replaceState({}, "", "/");
});

describe("(d) ログイン画面の導線(D-V4-20 (b))", () => {
  test("匿名に見せる画面があれば、ログイン画面から1本ずつたどれる", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}`);
    stub(shopManifest());
    render(<App />);

    await screen.findByTestId("login-page");
    const nav = screen.getByTestId("anonymous-views");
    const links = nav.querySelectorAll("a");
    // **宣言した画面だけが並ぶ**(運営用と宣言した画面も、宣言の無い画面も並ばない)。
    expect(links.length).toBe(1);
    expect(links[0]?.textContent).toContain("商品一覧");
    expect(links[0]?.getAttribute("href")).toBe(`/apps/${APP_ID}/views/catalog-list`);
  });

  test("匿名に見せる画面が0件なら、導線を1つも出さない(押しても何も無い導線を出さない)", async () => {
    // **【`V8-M20` / `J-G27` で題材を差し替えた。旧の逐語を1バイトも消していない】**
    // **旧**: `stub(plainManifest());`(= 宣言を1つも書いていないアプリ)。
    // **今日**: 面の既定は「規則を1本も書いていない対象は全許可」なので、
    // **宣言を書いていないアプリはもう 0件の題材ではない。**
    // **0件を作るには匿名以外の役割が全画面を名指しする**(`closedManifest()`)。
    // **測っている問い(0件なら導線を出さない)は1ミリも変えていない。**
    window.history.replaceState({}, "", `/apps/${APP_ID}`);
    stub(closedManifest());
    render(<App />);

    await screen.findByTestId("login-page");
    expect(screen.queryByTestId("anonymous-views")).toBeNull();
  });

  test("既存の data-testid を1つも消していない(LoginPage 冒頭注記の逐語)", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}`);
    stub(shopManifest());
    render(<App />);

    await screen.findByTestId("login-page");
    for (const id of [
      "auth-username",
      "auth-password",
      "passkey-login",
      "password-login",
      "customer-signup",
      "admin-signup-note",
    ]) {
      expect(screen.getByTestId(id), id).toBeDefined();
    }
  });
});

describe("(e) 未ログインで開ける画面 / 開けない画面", () => {
  test("anonymous と宣言した画面は、未ログインのまま描かれる", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/catalog-list`);
    stub(shopManifest(), [{ _id: "r1", name: "藻塩" }]);
    render(<App />);

    await waitFor(() => expect(screen.getByTestId("view-list")).toBeDefined());
    // **ログイン画面には落ちない**(`ADR-0075` が改訂した `ADR-0014:80` (b) の例外)。
    expect(screen.queryByTestId("login-page")).toBeNull();
    // **画面一覧には宣言した画面だけが並ぶ。**
    expect(screen.getByTestId("view-list").querySelectorAll("li").length).toBe(1);
    // **ログイン済みの導線は1つも出さない**(ログアウト・アカウント・ユーザ管理 など)。
    for (const id of ["logout", "open-account", "open-user-admin", "current-role"]) {
      expect(screen.queryByTestId(id), id).toBeNull();
    }
    // **ログインへの導線は出す**(「ここから先はログインが要る」ことを言える場所を残す)。
    expect(screen.getByTestId("anonymous-login-link")).toBeDefined();
  });

  test("匿名が名指しされていない画面を直接開いても、今日どおりログイン画面に落ちる(限定5)", async () => {
    // **【`V8-M20` / `J-G27` でテスト名を書き換えた。旧の逐語を1バイトも消していない】**
    // **旧テスト名**: 「宣言していない画面を直接開いても、今日どおりログイン画面に落ちる(限定5)」。
    // **`admin-product-form` は旧では「宣言0本」で匿名から隠れていたが、今日は
    // customer / editor / viewer / owner の規則が名指しすることで隠れている。**
    // **期待値(ログイン画面に落ちる)は1バイトも変えていない。**
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/admin-product-form`);
    stub(shopManifest());
    render(<App />);

    await screen.findByTestId("login-page");
    expect(screen.queryByTestId("view-list")).toBeNull();
  });

  test("運営にだけ宣言した画面を直接開いても、ログイン画面に落ちる(限定7)", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/admin-product-list`);
    stub(shopManifest());
    render(<App />);

    await screen.findByTestId("login-page");
    expect(screen.queryByTestId("view-list")).toBeNull();
  });

  test("【向きが戻った】規則を1本も書いていないアプリは、未ログインで開くとログイン画面に落ちる", async () => {
    // **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65` で期待値をもう1度反転させた。
    //   下に残っている `V8-M20` の逐語も、その中の旧層の逐語も1バイトも消していない】**
    //
    // **`V8-M20` のテスト名**: 「【向きが変わった】規則を1本も書いていないアプリは、
    // 未ログインのまま画面が描かれる」。
    // **`V8-M20` の期待値(逐語)**:
    //   `await waitFor(() => expect(screen.getByTestId("view-list")).toBeDefined());`
    //   `expect(screen.queryByTestId("login-page")).toBeNull();`
    //
    // **今日**: **面の既定が閉じる側へ倒れ**(`V8-M26-T03`)、**役割を1つも宣言していない
    // アプリも閉じる**(`D-V8-65`)。**未ログインにも同じ向きが及ぶ**(台帳 `T-G26a`)ので、
    // **旧層(`ADR-0074` 限定5)と同じくログイン画面に落ちる。**
    // **【禁止の履行】これを「同じ挙動を保った」と書かない。向きは2度変わった。**
    //
    // **以下は `V8-M20` が書いた注記であり、1バイトも消していない。**
    // **【`V8-M20` / `J-G27` で期待値を反転させた。旧の逐語を1バイトも消していない】**
    //
    // **旧テスト名**: 「宣言を1つも書いていないアプリは、今日どおり全画面がログイン画面に
    // 落ちる(限定5)」。
    // **旧の期待値**:
    //   `await screen.findByTestId("login-page");`
    //   `expect(screen.queryByTestId("view-list")).toBeNull();`
    //
    // **今日**: **`view.audience` の閉じる向きの既定(`ADR-0074` 限定7)が撤去され、
    // 匿名も面(`judgeRoleAccess`)で決まる。** **面の既定は管轄外(全許可)なので、
    // 規則を1本も書いていないアプリの画面は未ログインのまま開く。**
    // **【禁止の履行】これを「同じ挙動を保った」と書かない。向きは変わった。**
    // **【誇張しない】行が返るかどうかは別の話である** —— **匿名に返る行は今日も
    // `st_public` が真の行に限られる**(`ADR-0074` §3a-2。ここは1ミリも変わっていない)。
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/entry-list`);
    stub(plainManifest());
    render(<App />);

    await screen.findByTestId("login-page");
    expect(screen.queryByTestId("view-list")).toBeNull();

    // **【`V8-M20` の逐語】「閉じる向きが要るなら、匿名以外の役割が画面を名指しする
    // (`closedManifest()`)—— そのときは旧と同じくログイン画面に落ちる。」**
    // **今日はその手当てが要らない**(既定で閉じている)—— **対照として残しておく。**
    cleanup();
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/entry-list`);
    stub(closedManifest());
    render(<App />);
    await screen.findByTestId("login-page");
    expect(screen.queryByTestId("view-list")).toBeNull();
  });
});
