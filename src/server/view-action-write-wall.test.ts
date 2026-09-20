/**
 * **操作起点の「見せる相手」から導いた書込の壁**(`V5-M28-T01`。`A-G1` /
 * [`ADR-0249`](../../docs/adr/0249-view-action-audience-write-wall.md))。
 *
 * **実施記録**: [`docs/plan/v5/records/v5-m28.md`](../../docs/plan/v5/records/v5-m28.md) §6-2 `T01`。
 *
 * ## 本ファイルが測るもの / 測らないもの(**先に書く**)
 *
 * - **測るのは述語1本だけである** —— **HTTP を1本も張らず、SQLite を1度も開かない。**
 *   **`createServerApp` を1度も呼んでいない。**
 * - **したがって「403 が返ること」を1件も測っていない。** **結線は `V5-M28-T02`(単件経路)と
 *   `V5-M28-T03`(バッチ経路)であり、そこで初めて応答が変わる。**
 * - **`?view=` の有無を1件も測っていない**(述語は名乗りを引数に取らない。`ADR-0249` 限定7)。
 * - **止めない経路5本(受信口 / MCP / ワークフロー / コードの島 / `DELETE`)を1件も測っていない**
 *   (`ADR-0249` 限定13。実測は `V5-M28-T06`)。
 *
 * ## 壁の定義(`ADR-0249` §Decision 1 / 4)
 *
 * > **表 `T` を書き先とする操作起点のうち `audience` を宣言しているものが1つ以上あるとき、
 * > `T` への当該種類の書込は、それらの `audience` の**和集合**に挙がっている相手だけに許す。**
 * > **宣言が1つも無い表には壁が立たない。**
 *
 * ## **追記(`V5-M28-T02`。上の段落を1バイトも消していない)**
 *
 * **上の「測るもの / 測らないもの」は `(W-1)`〜`(W-11)` についてだけ今日も真である。**
 * **`V5-M28-T02` が足した `(H-1)`〜`(H-8)` は、本物の HTTP(`createServerApp`)と
 * 本物の SQLite を通す** —— **そこで初めて 403 という応答を測る。**
 *
 * **`(H)` 群がそれでも測っていないもの**:
 *
 * - **バッチ経路(`POST /api/apps/:app_id/batch`)を1件も測っていない**(`V5-M28-T03`)。
 * - **止めない経路のうち、受信口 / MCP / ワークフロー / コードの島を1件も測っていない**
 *   (`V5-M28-T06`)。**`DELETE` だけは `(H-5)` が測る** —— **穴が空いていることを固定する側である。**
 * - **参照EC の実データで壁が立つことを1件も測っていない**(`V5-M28-T05`)。
 * - **ブラウザを1枚も開いていない。**
 *
 * ## **追記(`V5-M28-T03`。上の段落を1バイトも消していない)**
 *
 * **`(BT-1)`〜`(BT-5)` が足りたのは、バッチ経路(`POST /api/apps/:app_id/batch`)だけである。**
 * **上の「バッチ経路を1件も測っていない」は、`(H)` 群についてだけ今日も真である。**
 *
 * **`(BT)` 群がそれでも測っていないもの**:
 *
 * - **止めない経路4本(受信口 / MCP / ワークフロー / コードの島)を1件も測っていない**
 *   (`V5-M28-T06`)。
 * - **参照EC の実データで壁が立つことを1件も測っていない**(`V5-M28-T05`)。
 * - **`?view=` を名乗ったバッチを1件も測っていない**(壁は名乗りを引数に取らないが、
 *   バッチ経路でそれを HTTP で測ってはいない)。
 * - **ブラウザを1枚も開いていない。**
 *
 * ## **追記(`V8-M20`。台帳 `J-G29`(判定 = 廃止)。手続きは `ADR-0301`。上を1バイトも消していない)**
 *
 * **壁を立てる宣言が `view_action.audience` から**面**(`app.roles[].rules`)へ移った。**
 * **述語の名前も `isViewActionWriteAllowed` から `isRoleActionWriteAllowed` へ移った**
 * (引数の並びは同じ4本である)。
 *
 * **今日の壁の定義**(`src/server/owner-scope.ts` の `isRoleActionWriteAllowed` の doc の逐語):
 *
 * > **表 `T` を書き先とする操作起点のうち、面の規則で名指しされているものが1本以上あるとき、
 * > `T` への当該種類の書込は「その相手がどれか1本を `read` できる」ときだけ許す。**
 * > **名指しされた起点が1本も無ければ壁は立たない。**
 *
 * **旧宣言 → 新しい書き方の対応**:
 *
 * ```jsonc
 * // 旧: view_action に audience: ["customer"]
 * // 新: 操作起点に id を書き、
 * //     app.roles の customer に { target: "action", view: "catalog-list", action: "<id>", can: ["read"] }
 * ```
 *
 * **【`V8-M20` が新しく開いた穴。塞いでいない】** **面の規則は `(view, action)` の2つで
 * 名指しするので、`view_action.id` を書いていない操作起点は壁の材料にならない。**
 * **旧層は識別子が無くても効いていた**(`schemas/manifest.schema.json` の
 * `$defs/view_action.audience` の `$comment` の逐語:「**旧層は id が無くても効いていた。**」)。
 * **`(W-12)` がこの穴を実測して固定する。**
 *
 * **【`V8-M20` で書けなくなった形。誇張しない】** **旧 `audience: []`(空配列 = 誰も通さない)に
 * 当たる宣言は、面には書けない** —— **`can` は `minItems: 1` である。**
 * **`(W-11)` はそれを踏まえて書き直してある。**
 *
 * **【上の「測るもの / 測らないもの」の射程の訂正】** **`V5-M28-T02` の追記は
 * 「`(W-1)`〜`(W-11)` についてだけ今日も真である」と書いているが、`V8-M20` が足した
 * `(W-12)` も述語だけを測る側である**(HTTP を1本も張らず、SQLite を1度も開かない)。
 * **したがって射程は `(W-1)`〜`(W-12)` である。**
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Role } from "../auth/types.ts";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { isRoleActionWriteAllowed } from "./owner-scope.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

/** 述語に渡す形だけを組む(カーネルの型に無いキーを書くので `unknown` で扱う)。 */
type Action = Record<string, unknown>;
type View = Record<string, unknown>;

/**
 * **表2本(`product` / `order`)を持つ最小のアプリ。** **views と roles だけを差し替える。**
 * **述語はテーブル定義を1バイトも読まないが、実物と同じ形にしておく。**
 *
 * **【`V8-M20`】第2引数 `roles` が増えた** —— **壁を立てるのは面の規則だからである。**
 */
function manifestOf(views: readonly View[], roles: readonly unknown[] = DEFAULT_ROLES): unknown {
  return {
    app: {
      id: "write-wall-shop",
      name: "壁の店",
      tables: [
        {
          id: "product",
          name: "商品",
          fields: [{ id: "name", name: "商品名", type: "text", required: true }],
        },
        {
          id: "order",
          name: "注文",
          fields: [{ id: "product", name: "商品", type: "reference", reference_table: "product" }],
        },
      ],
      views,
      roles,
    },
  };
}

/**
 * **既定の役割定義3本**(`src/kernel/create-app.ts` の `DEFAULT_ROLES` と同じ `id`)。
 * **`app.roles` を宣言するなら、この3本は消せない**
 * (`src/kernel/referential-integrity.ts` の類型17)。**規則は1本も持たない。**
 */
const DEFAULT_ROLES: readonly unknown[] = [
  { id: "owner", name: "持ち主" },
  { id: "editor", name: "編集者" },
  { id: "viewer", name: "閲覧者" },
];

/** **「この役割は、この画面のこのボタンを読める」** の1本。 */
type Grant = { readonly role: string; readonly view: string; readonly action: string };

/**
 * **面の規則を組む**(既定3本を必ず含める)。
 *
 * **規則を1本も渡さなければ、既定3本が規則なしで並ぶだけである** ——
 * **どの対象も名指しされないので、壁は1本も立たない**(裁定 `R-4`)。
 */
function rolesGranting(...grants: readonly Grant[]): unknown[] {
  const byId = new Map<string, { id: string; name: string; rules: unknown[] }>();
  for (const declaration of DEFAULT_ROLES as readonly { id: string; name: string }[]) {
    byId.set(declaration.id, { id: declaration.id, name: declaration.name, rules: [] });
  }
  for (const grant of grants) {
    if (!byId.has(grant.role)) {
      byId.set(grant.role, { id: grant.role, name: grant.role, rules: [] });
    }
    byId.get(grant.role)?.rules.push({
      target: "action",
      view: grant.view,
      action: grant.action,
      can: ["read"],
    });
  }
  // **`rules` は `minItems: 1` なので、1本も無い役割からはキーごと落とす。**
  return [...byId.values()].map((declaration) =>
    declaration.rules.length === 0 ? { id: declaration.id, name: declaration.name } : declaration,
  );
}

/** 商品一覧(`product`)に操作起点を並べる。 */
function catalogList(actions: readonly Action[]): View {
  return {
    id: "catalog-list",
    type: "list_view",
    table: "product",
    columns: ["name"],
    actions,
  };
}

/** 注文を作る入力フォーム(`order`)。**親ビューの表(`product`)と違う表を指す。** */
const ORDER_FORM: View = { id: "order-form", type: "form", table: "order", fields: ["product"] };

/** 商品詳細(`product`)に操作起点を並べる。 */
function productDetail(actions: readonly Action[]): View {
  return {
    id: "product-detail",
    type: "detail_view",
    table: "product",
    fields: ["name"],
    actions,
  };
}

/**
 * 遷移の形(`form` + `prefill`)。**書き先 = 遷移先 form の表 / 種類 = 作成。**
 *
 * **【`V8-M20`】引数が `audience` から `id` になった** —— **面の規則は
 * `view_action.id` でボタンを名指しするので、識別子が壁の材料である。**
 * **旧: `formAction(["customer"])`。新: `formAction("go-order")` +
 * `rolesGranting({ role: "customer", view: "catalog-list", action: "go-order" })`。**
 */
function formAction(id?: string): Action {
  const action: Action = { form: "order-form", prefill: { field: "product" }, name: "注文する" };
  if (id !== undefined) {
    action.id = id;
  }
  return action;
}

/** 値の書換の形(`set`)。**書き先 = 乗っているビューの表 / 種類 = 更新。** */
function setAction(id?: string): Action {
  const action: Action = { set: { field: "name", value: "売切" }, name: "売切にする" };
  if (id !== undefined) {
    action.id = id;
  }
  return action;
}

/** ログイン済みの相手として本ファイルが総当たりする値。 */
const LOGGED_IN: readonly Role[] = ["owner", "editor", "viewer", "customer"];

test("(W-1) 規則が1本も無い表には壁が立たない(どのロールでも真)", () => {
  // **【`V8-M20` / `J-G29`】旧テスト名: `(W-1) 宣言が1本も無い表には壁が立たない(どのロールでも真)`。**
  // **旧は「操作起点は在るが `audience` を1つも書いていない」形だった。**
  // **新は「操作起点に識別子は在るが、面の規則が1本も名指ししていない」形である。**
  //
  // **【`V8-M26` / ユーザ決定 `D-V8-45` / `D-V8-65`。期待値を4本反転させた。旧文を1バイトも
  // 消していない】**
  // **旧(逐語)**:
  //   `expect(isRoleActionWriteAllowed(m, "order", "create", role)).toBe(true);`
  //   `expect(isRoleActionWriteAllowed(m, "product", "update", role)).toBe(true);`
  //   `expect(isRoleActionWriteAllowed(bare, "order", "create", role)).toBe(true);`
  //   `expect(isRoleActionWriteAllowed(noRoles, "order", "create", role)).toBe(true);`
  //   (`bare` は操作起点が1本も無い形、`noRoles` は役割を1つも宣言していない形)
  //
  // **今日、壁が立つ条件が「規則が1本でも在る」から「識別子つきのボタンが在る」へ変わった** ——
  // **`isRoleActionWriteAllowed` の `if (!decision.governed) continue;` が、既定が閉じたことで
  // 1度も `continue` しなくなったからである。**
  // **したがって test 名の「規則が1本も無い表には壁が立たない」は今日は偽である**(旧名は残す)。
  //
  // **【壁が立たない形は今日も在る。3つを名指しで残す】**
  //  1. **その表を書き先とする操作起点が1本も無い**(`bare` / `order` の更新 / `product` の作成)。
  //  2. **書込を起こさない形のボタンしか無い**(`view` / `run`。下の `(W-6)`)。
  //  3. **識別子(`id`)を書いていない**(下の `(W-12)`。`V8-M20` が開けた穴)。
  const m = manifestOf([
    catalogList([formAction("go-order")]),
    ORDER_FORM,
    productDetail([setAction("mark-sold")]),
  ]);
  for (const role of [...LOGGED_IN, null]) {
    // **`go-order` が `order` の**作成**に壁を立てる**(旧: `true`)。
    expect(isRoleActionWriteAllowed(m, "order", "create", role)).toBe(false);
    // **`order` の**更新**を起こすボタンは1本も無いので、今日も壁は立たない。**
    expect(isRoleActionWriteAllowed(m, "order", "update", role)).toBe(true);
    // **`product` の**作成**を起こすボタンも1本も無い。**
    expect(isRoleActionWriteAllowed(m, "product", "create", role)).toBe(true);
    // **`mark-sold` が `product` の**更新**に壁を立てる**(旧: `true`)。
    expect(isRoleActionWriteAllowed(m, "product", "update", role)).toBe(false);
  }
  // **そもそも操作起点が1本も無い表も同じである。**
  // **ここは今日も `true` である** —— **壁の材料になるボタンが1本も無いからである。**
  const bare = manifestOf([catalogList([]), ORDER_FORM]);
  for (const role of LOGGED_IN) {
    expect(isRoleActionWriteAllowed(bare, "order", "create", role)).toBe(true);
  }
  // **役割を1つも宣言していないアプリも同じである**(`app.roles` は今日も省略可)。
  // **【反転】** **`D-V8-65` により、役割を1つも宣言していないアプリも閉じる側になった** ——
  // **`judgeRoleAccess` の1段目が `CLOSED_ROLE_ACCESS` を返すので `governed` が真になり、
  // 壁が立って誰も通らない。**(旧: `true`)
  const noRoles = manifestOf([catalogList([formAction("go-order")]), ORDER_FORM], []);
  for (const role of LOGGED_IN) {
    expect(isRoleActionWriteAllowed(noRoles, "order", "create", role)).toBe(false);
  }
});

test("(W-2) form 形のボタンの規則は、遷移先 form ビューの table に作成の壁を立てる", () => {
  const m = manifestOf(
    [catalogList([formAction("go-order")]), ORDER_FORM],
    rolesGranting({ role: "customer", view: "catalog-list", action: "go-order" }),
  );
  expect(isRoleActionWriteAllowed(m, "order", "create", "customer")).toBe(true);
  expect(isRoleActionWriteAllowed(m, "order", "create", "owner")).toBe(false);
  expect(isRoleActionWriteAllowed(m, "order", "create", "editor")).toBe(false);
  expect(isRoleActionWriteAllowed(m, "order", "create", "viewer")).toBe(false);
});

test("(W-3) form 形のボタンの規則は、操作起点が乗っているビューの table には壁を立てない", () => {
  // **`catalog-list` の表は `product` である。** **壁が立つのは `order` だけである。**
  const m = manifestOf(
    [catalogList([formAction("go-order")]), ORDER_FORM],
    rolesGranting({ role: "customer", view: "catalog-list", action: "go-order" }),
  );
  for (const role of LOGGED_IN) {
    expect(isRoleActionWriteAllowed(m, "product", "create", role)).toBe(true);
    expect(isRoleActionWriteAllowed(m, "product", "update", role)).toBe(true);
  }
});

test("(W-4) set 形のボタンの規則は、操作起点が乗っているビューの table に更新の壁を立てる", () => {
  const m = manifestOf(
    [productDetail([setAction("mark-sold")])],
    rolesGranting({ role: "editor", view: "product-detail", action: "mark-sold" }),
  );
  expect(isRoleActionWriteAllowed(m, "product", "update", "editor")).toBe(true);
  expect(isRoleActionWriteAllowed(m, "product", "update", "owner")).toBe(false);
  expect(isRoleActionWriteAllowed(m, "product", "update", "customer")).toBe(false);
});

test("(W-5) form 形は更新の壁に入らない / set 形は作成の壁に入らない", () => {
  const formOnly = manifestOf(
    [catalogList([formAction("go-order")]), ORDER_FORM],
    rolesGranting({ role: "customer", view: "catalog-list", action: "go-order" }),
  );
  for (const role of LOGGED_IN) {
    // **作成の壁は立っているが、更新の壁は1本も立っていない。**
    expect(isRoleActionWriteAllowed(formOnly, "order", "update", role)).toBe(true);
  }
  expect(isRoleActionWriteAllowed(formOnly, "order", "create", "owner")).toBe(false);

  const setOnly = manifestOf(
    [productDetail([setAction("mark-sold")])],
    rolesGranting({ role: "editor", view: "product-detail", action: "mark-sold" }),
  );
  for (const role of LOGGED_IN) {
    // **更新の壁は立っているが、作成の壁は1本も立っていない。**
    expect(isRoleActionWriteAllowed(setOnly, "product", "create", role)).toBe(true);
  }
  expect(isRoleActionWriteAllowed(setOnly, "product", "update", "owner")).toBe(false);
});

test("(W-6) view 形と run 形は壁を1本も立てない(規則で名指ししても)", () => {
  const viewAction: Action = { id: "go-orders", view: "order-list", name: "注文一覧へ" };
  const runAction: Action = { id: "archive", run: "wf-archive", name: "アーカイブ" };
  const m = manifestOf(
    [
      catalogList([viewAction, runAction]),
      ORDER_FORM,
      { id: "order-list", type: "list_view", table: "order", columns: ["product"] },
    ],
    // **【`V8-M20`】旧は `audience: ["customer"]` / `["owner"]` を両者に書いていた。**
    // **新は面の規則で名指しする** —— **それでも書き先を持たない形なので壁は立たない。**
    rolesGranting(
      { role: "customer", view: "catalog-list", action: "go-orders" },
      { role: "owner", view: "catalog-list", action: "archive" },
    ),
  );
  for (const role of [...LOGGED_IN, null]) {
    expect(isRoleActionWriteAllowed(m, "product", "create", role)).toBe(true);
    expect(isRoleActionWriteAllowed(m, "product", "update", role)).toBe(true);
    // **行き先の表にも壁は立たない** —— **`view` 形は書き先を持たない。**
    expect(isRoleActionWriteAllowed(m, "order", "create", role)).toBe(true);
    expect(isRoleActionWriteAllowed(m, "order", "update", role)).toBe(true);
  }
});

test("(W-7) 同じ表・同じ種類に2本の規則があれば和集合になる(owner と customer で両方が真)", () => {
  const m = manifestOf(
    [catalogList([formAction("go-order-a"), formAction("go-order-b")]), ORDER_FORM],
    rolesGranting(
      { role: "owner", view: "catalog-list", action: "go-order-a" },
      { role: "customer", view: "catalog-list", action: "go-order-b" },
    ),
  );
  expect(isRoleActionWriteAllowed(m, "order", "create", "owner")).toBe(true);
  expect(isRoleActionWriteAllowed(m, "order", "create", "customer")).toBe(true);
  // **和集合に居ない相手は今日も止まる**(「どちらが勝つか」の規則を作らない)。
  expect(isRoleActionWriteAllowed(m, "order", "create", "editor")).toBe(false);
  expect(isRoleActionWriteAllowed(m, "order", "create", "viewer")).toBe(false);
});

test("(W-8) 規則の無い操作起点は壁を消さない(同じ表に規則あり1本 + 規則なし1本)", () => {
  // **参照EC の `catalog-list:533`(`["customer"]`)と `product-detail:569-571`(宣言なし)
  // の形そのものである。**
  const m = manifestOf(
    [
      catalogList([formAction("go-order")]),
      productDetail([formAction("go-order-detail")]),
      ORDER_FORM,
    ],
    rolesGranting({ role: "customer", view: "catalog-list", action: "go-order" }),
  );
  expect(isRoleActionWriteAllowed(m, "order", "create", "customer")).toBe(true);
  // **規則の無い1本は「全員可」に倒さない** —— **運営は今日も止まる。**
  expect(isRoleActionWriteAllowed(m, "order", "create", "owner")).toBe(false);
  expect(isRoleActionWriteAllowed(m, "order", "create", "editor")).toBe(false);
});

test("(W-9) 宣言された種類(supplier)も壁の値になる", () => {
  const m = manifestOf(
    [catalogList([formAction("go-order")]), ORDER_FORM],
    rolesGranting({ role: "supplier", view: "catalog-list", action: "go-order" }),
  );
  expect(isRoleActionWriteAllowed(m, "order", "create", "supplier")).toBe(true);
  expect(isRoleActionWriteAllowed(m, "order", "create", "customer")).toBe(false);
  expect(isRoleActionWriteAllowed(m, "order", "create", "owner")).toBe(false);
});

test("(W-10) anonymous だけに書いた規則は、ログイン済みの誰も通さない壁になる", () => {
  // **【`V8-M20`】旧テスト名: `(W-10) audience: ["anonymous"] だけの宣言は、ログイン済みの誰も
  // 通さない壁になる`。** **旧の題材は `audience: ["anonymous"]`、新は役割 `anonymous` の規則。**
  // **`anonymous` は `app.roles[].id` に書ける予約4語の1つである。**
  const m = manifestOf(
    [catalogList([formAction("go-order")]), ORDER_FORM],
    rolesGranting({ role: "anonymous", view: "catalog-list", action: "go-order" }),
  );
  for (const role of LOGGED_IN) {
    expect(isRoleActionWriteAllowed(m, "order", "create", role)).toBe(false);
  }
  // **`null`(未ログイン)は面の主体 `anonymous` に写る** —— **ただし書込経路は 401 で
  // 先に落ちるので、この値が実際の応答に出ることは無い**(`ADR-0249` 限定8)。
  // **本ファイルは 401 を1件も測っていない。**
  expect(isRoleActionWriteAllowed(m, "order", "create", null)).toBe(true);
});

test("(W-11) 規則を書かなかった操作起点は今日も全員が通る(壊れた規則は誰も通さない側へ倒れる)", () => {
  // **【`V8-M20` / `J-G29`】旧テスト名: `(W-11) 空配列の宣言は誰も通さない(undefined と [] を混ぜない)`。**
  // **旧の前半(`audience: []`)に当たる形は、面には書けない** ——
  // **`app.roles[].rules[].can` は `minItems: 1` であり、空配列を書いた差分は適用時に拒否される。**
  // **したがって「空の宣言」と「宣言なし」の2通りを突き合わせる形は今日は作れない。**
  //
  // **残った半分(書かなかった側は全員が通る)は今日も真である。**
  //
  // **【`V8-M26` / ユーザ決定 `D-V8-45`。期待値を反転させた。旧文を1バイトも消していない】**
  // **旧(逐語)**: `expect(isRoleActionWriteAllowed(absent, "order", "create", role)).toBe(true);`
  // **直上の1行(「残った半分 … は今日も真である」)は今日は偽である** ——
  // **既定が閉じたことで、規則を**書かなかった**ボタンも `governed: true` を返す。**
  // **つまり `(W-11)` が測っていた2通り(「書かなかった」と「壊れた規則」)は、今日
  // まったく同じ答え(`false`)になり、区別が消えた。**
  const absent = manifestOf([catalogList([formAction("go-order")]), ORDER_FORM]);
  for (const role of [...LOGGED_IN, null]) {
    expect(isRoleActionWriteAllowed(absent, "order", "create", role)).toBe(false);
  }

  // **【fail-closed の確認】** **`can: []` はスキーマが拒否するので実物には現れないが、
  // 述語がそれを受け取ったときに「全員可」へ倒れないことを固定する。**
  // **`governed`(名指しされた)は真になり、`read` を含まないので誰も通らない。**
  const brokenRules = manifestOf(
    [catalogList([formAction("go-order")]), ORDER_FORM],
    [
      {
        id: "owner",
        name: "持ち主",
        rules: [{ target: "action", view: "catalog-list", action: "go-order", can: [] }],
      },
      { id: "editor", name: "編集者" },
      { id: "viewer", name: "閲覧者" },
    ],
  );
  for (const role of [...LOGGED_IN, null]) {
    expect(isRoleActionWriteAllowed(brokenRules, "order", "create", role)).toBe(false);
  }
});

/**
 * **【`V8-M20` / `J-G29` が新しく開いた穴。塞いでいないことを固定する側である】**
 *
 * **面の規則は `(view, action)` の2つでボタンを名指しする** —— **`view_action.id` を
 * 書いていない操作起点は名指しできないので、規則を1本も書けない。**
 * **`isRoleActionWriteAllowed` は識別子の無い起点を `continue` で読み飛ばす**(実装の逐語)。
 *
 * **旧層(`view_action.audience`)は識別子が無くても効いていた** ——
 * **`schemas/manifest.schema.json` の `$defs/view_action.audience` の `$comment` の逐語:
 * 「**旧層は id が無くても効いていた。**」**
 *
 * **【禁止】これを「旧層と同じ限界」と書かない。** **【禁止】「壁は同じ範囲に立つ」と書かない。**
 */
test("(W-12) 識別子(id)を書いていない操作起点は壁の材料にならない(V8-M20 が新しく開いた穴)", () => {
  // **同じ画面に2本。** **識別子を書いたほうだけが壁を立てる。**
  const m = manifestOf(
    [catalogList([formAction(), formAction("go-order")]), ORDER_FORM],
    rolesGranting({ role: "customer", view: "catalog-list", action: "go-order" }),
  );
  expect(isRoleActionWriteAllowed(m, "order", "create", "customer")).toBe(true);
  expect(isRoleActionWriteAllowed(m, "order", "create", "owner")).toBe(false);

  // **書込を起こす1本から識別子を外すと、壁は1本も立たなくなる。**
  // **面の規則は在る**(実在する別のボタンを名指ししている)—— **にもかかわらず、
  // `order` の作成は誰でも通る。**
  const nameless = manifestOf(
    [
      catalogList([formAction(), { id: "go-orders", view: "order-list", name: "注文一覧へ" }]),
      ORDER_FORM,
      { id: "order-list", type: "list_view", table: "order", columns: ["product"] },
    ],
    rolesGranting({ role: "customer", view: "catalog-list", action: "go-orders" }),
  );
  for (const role of [...LOGGED_IN, null]) {
    expect(isRoleActionWriteAllowed(nameless, "order", "create", role)).toBe(true);
  }
});

// ---------------------------------------------------------------------------
// (H) 群 —— **本物の HTTP で壁を測る**(`V5-M28-T02`)
//
// **ここから下は述語ではなく応答を測る。** **`createServerApp` を起動し、SQLite を開く。**
//
// **【`V8-M20` / `J-G29` / `ADR-0301`】壁を立てる宣言が面(`app.roles[].rules`)へ移った。**
// **下の表の「立てている宣言」は、今日は「そのボタンの識別子を `read` で名指しした役割」である** ——
// **旧の `audience: ["editor"]` は、`editor` の `{ target: "action", … , can: ["read"] }` になった。**
// **壁の中 / 壁の外の顔ぶれは1つも変えていない。**
//
// **題材の壁は2本である**(どちらも旧 `audience: ["editor"]` = 今日は `editor` の規則):
//
// | 表 | 種類 | 立てている宣言 | 壁の中 | 壁の外 |
// |---|---|---|---|---|
// | `order` | **作成** | `catalog-list` の遷移の形(`form: "order-form"`) | `editor` | `owner` |
// | `product` | **更新** | `product-detail` の値の書換の形(`set`) | `editor` | `owner` |
//
// **【`V5-M28-T03` が3本目を足した。上の2行を1バイトも消していない】**
//
// | 表 | 種類 | 立てている宣言 | 壁の中 | 壁の外 |
// |---|---|---|---|---|
// | `coupon` | **作成** | `catalog-list` の2本目の遷移の形(`form: "coupon-form"`) | `customer` | `owner` / `editor` |
//
// **`coupon` の壁を `["customer"]` にしたのは `(BT-5)` のためである** —— **バッチ経路は今日
// `editor` / `owner` に限られている**(`app.ts` の `batchAuthMiddleware`)**ので、`customer`
// だけの壁が立った表はバッチから誰も書けない。** **これは設計の帰結であって、穴でも不具合でもない。**
// **`(H)` 群の2本の壁は1バイトも動いていない**(3本目が指す先は `coupon-form` = `coupon` である)。
//
// **壁の外の相手を `owner` にしたのは、`customer` だと `nonAdminTableAccess`(`ADR-0033`)が
// 壁より手前で 403 を返してしまい、何が止めたのかが測れなくなるためである。**
// **`owner` と `editor` はどちらも今日どおり全テーブルに書けるロールである** ——
// **したがって (H) 群の 403 は、壁だけが作った差分である。**
// ---------------------------------------------------------------------------

const HTTP_APP_ID = "write-wall-http-shop";

/** **(H) 群の題材。** **上の表の2本の壁だけを持つ。** */
function httpManifest(): Manifest {
  return {
    app: {
      id: HTTP_APP_ID,
      name: "壁の店(HTTP)",
      tables: [
        {
          id: "product",
          name: "商品",
          fields: [
            { id: "name", name: "商品名", type: "text", required: true },
            { id: "memo", name: "覚書", type: "text" },
          ],
        },
        {
          id: "order",
          name: "注文",
          fields: [
            { id: "product", name: "商品", type: "reference", reference_table: "product" },
            { id: "note", name: "備考", type: "text" },
          ],
        },
        // **`V5-M28-T03` が足した3本目の表。** **`(BT-5)` のためだけに在る。**
        {
          id: "coupon",
          name: "クーポン",
          fields: [
            { id: "product", name: "商品", type: "reference", reference_table: "product" },
            { id: "code", name: "符号", type: "text" },
          ],
        },
      ],
      views: [
        {
          id: "catalog-list",
          type: "list_view",
          table: "product",
          columns: ["name"],
          // **作成の壁**(書き先は遷移先 `order-form` の表 = `order`)。
          // **【`V8-M20`】旧は各操作起点に `audience` を書いていた。**
          // **新は識別子(`id`)を書き、下の `roles` から名指しする。**
          actions: [
            {
              id: "go-order",
              form: "order-form",
              prefill: { field: "product" },
              name: "注文する",
            },
            // **`V5-M28-T03` が足した3本目の壁**(書き先は `coupon-form` の表 = `coupon`)。
            // **`order` の壁には1ミリも寄与しない** —— **書き先が違うからである。**
            {
              id: "go-coupon",
              form: "coupon-form",
              prefill: { field: "product" },
              name: "クーポンを配る",
            },
          ],
        },
        { id: "order-form", type: "form", table: "order", fields: ["product"] },
        { id: "coupon-form", type: "form", table: "coupon", fields: ["product", "code"] },
        { id: "order-list", type: "list_view", table: "order", columns: ["product"] },
        {
          id: "product-detail",
          type: "detail_view",
          table: "product",
          // **更新の壁**(書き先は乗っているビューの表 = `product`)。
          actions: [{ id: "mark-sold", set: { field: "memo", value: "売切" }, name: "売切にする" }],
        },
      ],
      // **面の規則。** **既定3本(`owner` / `editor` / `viewer`)は消せない。**
      //
      // **旧 `audience: ["editor"]` の2本 → `editor` の2本の規則。**
      // **旧 `audience: ["customer"]` の1本 → `customer` の1本の規則。**
      // **`owner` / `viewer` には規則を1本も書かない** —— **allow-list なので壁の外になる。**
      // **【`V18-M4-T02b`。ユーザ決定 `D-V18-26` / `ADR-0441`】画面(`view`)の読取を足した。**
      //
      // **`V18-M4-T02` が「画面名を名乗らない読取」に壁を立てた** —— **その表を指す
      // 一覧系の画面(`list_view` / `report_view`)を1本も読めない相手の一覧は 0件、
      // 単票系(`detail_view` / `form`)を1本も読めない相手の単票は 404 になる。**
      // **`D-V18-26` により、画面を宣言しているのに「誰に見せるか」を役割の規則に
      // 1行も書いていない場合も止まる。**
      //
      // **直上の「`owner` / `viewer` には規則を1本も書かない」は、画面については今日は
      // 偽である(1バイトも消していない)。** **足すのは画面の**読取**だけであり、
      // ボタン(`action`)の規則は1本も足していない** —— **(H) 群と (BT) 群の 403 は
      // ボタンの規則で立っているので、壁の顔ぶれは1ミリも動いていない。**
      // **(H-4) / (BT-2) / (BT-3) / (BT-4) が測っているのは書込の壁であって画面の規則では
      // ないので、主張(`expect`)は1バイトも書き換えていない。**
      roles: [
        {
          id: "owner",
          name: "持ち主",
          rules: [
            // (H-4) `order` の一覧 / (BT-3) の対照
            { target: "view", view: "order-list", can: ["read"] },
            // (BT-4) `product` の一覧
            { target: "view", view: "catalog-list", can: ["read"] },
            // (BT-2) `product` の単票(`detail_view`)
            { target: "view", view: "product-detail", can: ["read"] },
          ],
        },
        {
          id: "editor",
          name: "編集者",
          rules: [
            { target: "action", view: "catalog-list", action: "go-order", can: ["read"] },
            { target: "action", view: "product-detail", action: "mark-sold", can: ["read"] },
            // **【`V18-M4-T02b` / `D-V18-26`】(BT-3) が `editor` で `order` / `coupon` の
            // 行数を数えるのに要る1本。**
            { target: "view", view: "order-list", can: ["read"] },
          ],
        },
        { id: "viewer", name: "閲覧者" },
        {
          id: "customer",
          name: "お客様",
          rules: [{ target: "action", view: "catalog-list", action: "go-coupon", can: ["read"] }],
        },
      ],
    },
  } as unknown as Manifest;
}

let httpDataRoot: string;
let httpApp: ReturnType<typeof createServerApp>;

beforeEach(async () => {
  httpDataRoot = await mkdtemp(join(tmpdir(), "gp-write-wall-http-"));
  const store = KernelMetaStore.open(httpDataRoot);
  try {
    createApp(store, "壁の店(HTTP)", { app_id: HTTP_APP_ID });
  } finally {
    store.close();
  }
  // **【`V8-M26`】表(`product` / `order` / `coupon`)にだけ既定3役割の規則を足す。**
  // **`skipAllViews: true` を渡すのが要点である** —— **画面とボタンの規則は題材が自分で
  // 書いており(壁の顔ぶれそのもの)、そこへ既定の規則を足すと (H) (BT) 両群の 403 が
  // 1本も立たなくなる。**
  expect(
    applyManifest(
      httpDataRoot,
      HTTP_APP_ID,
      withDefaultRoleRules(httpManifest(), { skipAllViews: true }),
    ).valid,
  ).toBe(true);
  httpApp = createServerApp({ dataRoot: httpDataRoot });
});

afterEach(async () => {
  await rm(httpDataRoot, { recursive: true, force: true });
});

function httpReq(
  cookie: string | undefined,
  method: string,
  path: string,
  body?: unknown,
  extra?: Record<string, string>,
): Promise<Response> {
  const headers: Record<string, string> = { origin: TEST_ORIGIN, ...(extra ?? {}) };
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return Promise.resolve(httpApp.request(new Request(`http://localhost${path}`, init)));
}

function httpSession(role: "owner" | "editor" | "customer") {
  return seedSession(httpDataRoot, HTTP_APP_ID, { role, username: `${role}-${Math.random()}` });
}

const HTTP_PRODUCTS = `/api/apps/${HTTP_APP_ID}/tables/product/records`;
const HTTP_ORDERS = `/api/apps/${HTTP_APP_ID}/tables/order/records`;
const HTTP_COUPONS = `/api/apps/${HTTP_APP_ID}/tables/coupon/records`;
const HTTP_BATCH = `/api/apps/${HTTP_APP_ID}/batch`;

/** 壁の外(`owner`)でも作れる表なので、題材の行は `owner` が置く。 */
async function seedWallProduct(cookie: string): Promise<{ id: string; version: string }> {
  const res = await httpReq(cookie, "POST", HTTP_PRODUCTS, { name: "梅干し" });
  expect(res.status).toBe(201);
  const record = ((await res.json()) as { record: { _id: string; _updated_at: string } }).record;
  return { id: record._id, version: record._updated_at };
}

/** 壁の中(`editor`)だけが作れる表。 */
async function seedWallOrder(cookie: string): Promise<{ id: string; version: string }> {
  const res = await httpReq(cookie, "POST", HTTP_ORDERS, { note: "初回" });
  expect(res.status).toBe(201);
  const record = ((await res.json()) as { record: { _id: string; _updated_at: string } }).record;
  return { id: record._id, version: record._updated_at };
}

test("(H-1) 壁の外の相手の POST は 403 になり、行が1件も増えない", async () => {
  const o = httpSession("owner");
  const res = await httpReq(o.cookie, "POST", HTTP_ORDERS, { note: "運営が作る" });
  expect(res.status).toBe(403);

  // **1件も増えていないことを、同じ相手の GET で数える**(`GET` に壁は掛からない)。
  const after = await httpReq(o.cookie, "GET", HTTP_ORDERS);
  expect(after.status).toBe(200);
  expect(((await after.json()) as { records: unknown[] }).records).toHaveLength(0);
});

test("(H-2) 壁の中の相手の POST は今日どおり 201", async () => {
  const e = httpSession("editor");
  const res = await httpReq(e.cookie, "POST", HTTP_ORDERS, { note: "担当が作る" });
  expect(res.status).toBe(201);
});

test("(H-3) ?view= を付けなくても同じに 403 になる(壁は名乗りに依存しない)", async () => {
  const o = httpSession("owner");
  // **画面を名乗った要求。**
  const named = await httpReq(o.cookie, "POST", `${HTTP_ORDERS}?view=order-form`, {
    note: "名乗る",
  });
  expect(named.status).toBe(403);
  // **名乗らない要求。** **同じ状態コードである。**
  const bare = await httpReq(o.cookie, "POST", HTTP_ORDERS, { note: "名乗らない" });
  expect(bare.status).toBe(403);
  expect(bare.status).toBe(named.status);
});

test("(H-4) 壁の立った表への GET は今日どおり通る", async () => {
  const e = httpSession("editor");
  await seedWallOrder(e.cookie);
  const o = httpSession("owner");
  const res = await httpReq(o.cookie, "GET", HTTP_ORDERS);
  expect(res.status).toBe(200);
  expect(((await res.json()) as { records: unknown[] }).records).toHaveLength(1);
});

test("(H-5) 壁の立った表への DELETE は今日どおり通る(穴。塞いでいないことを固定する)", async () => {
  const e = httpSession("editor");
  const order = await seedWallOrder(e.cookie);
  // **作れない相手が、同じ表の行を消せる。** **`ADR-0249` 限定1 / §4-5 の穴5 である。**
  const o = httpSession("owner");
  const res = await httpReq(o.cookie, "DELETE", `${HTTP_ORDERS}/${order.id}`, undefined, {
    "if-match": order.version,
  });
  expect(res.status).toBe(204);
});

test("(H-6) set 形の宣言がある表への PATCH は、壁の外の相手に 403", async () => {
  const o = httpSession("owner");
  // **作成の壁は `product` に立っていない** —— **同じ相手が作れて、直せない。**
  const product = await seedWallProduct(o.cookie);
  const res = await httpReq(
    o.cookie,
    "PATCH",
    `${HTTP_PRODUCTS}/${product.id}`,
    { memo: "手直し" },
    {
      "if-match": product.version,
    },
  );
  expect(res.status).toBe(403);
});

test("(H-7) form 形の宣言しかない表への PATCH は今日どおり通る", async () => {
  const e = httpSession("editor");
  const order = await seedWallOrder(e.cookie);
  // **`order` に立っているのは作成の壁だけである** —— **更新の壁は1本も立っていない。**
  const o = httpSession("owner");
  const res = await httpReq(
    o.cookie,
    "PATCH",
    `${HTTP_ORDERS}/${order.id}`,
    { note: "直す" },
    {
      "if-match": order.version,
    },
  );
  expect(res.status).toBe(200);
});

test("(H-8) 未ログインは今日どおり 401(壁の手前で落ちる)", async () => {
  const res = await httpReq(undefined, "POST", HTTP_ORDERS, { note: "名無し" });
  expect(res.status).toBe(401);
});

// ---------------------------------------------------------------------------
// (BT) 群 —— **まとめ書きの経路(`POST /api/apps/:app_id/batch`)で壁を測る**(`V5-M28-T03`)
//
// **バッチは1つの `IMMEDIATE` トランザクションで全成功か全失敗である**(`ADR-0039`)。
// **したがって「1つでも壁に当たったら1行も書かれない」ことを、`GET` の件数で数える。**
//
// **【この群が測っていないこと】**
// - **`?view=` を名乗ったバッチを1件も測っていない。**
// - **`if_match` を省いた update op を1件も測っていない**(バッチの `if_match` は今日も任意である)。
// - **壁が op の**何番目**で当たったかを測っていない**(応答は最初に当たった1件ぶんである)。
// ---------------------------------------------------------------------------

/** バッチ経路へ ops を投げる。 */
function httpBatch(cookie: string, ops: readonly unknown[]): Promise<Response> {
  return httpReq(cookie, "POST", HTTP_BATCH, { ops });
}

/** その表の行数を数える(`GET` に壁は掛かっていない)。 */
async function countRows(cookie: string, path: string): Promise<number> {
  const res = await httpReq(cookie, "GET", path);
  expect(res.status).toBe(200);
  return ((await res.json()) as { records: unknown[] }).records.length;
}

test("(BT-1) 壁の外の相手の batch create op は 403 になり、1件も書かれない(部分適用ゼロ)", async () => {
  const o = httpSession("owner");
  const res = await httpBatch(o.cookie, [
    { op: "create", table: "order", values: { note: "運営" } },
  ]);
  expect(res.status).toBe(403);
  expect(await countRows(o.cookie, HTTP_ORDERS)).toBe(0);
});

test("(BT-2) 壁の外の相手の batch update op は 403 になる", async () => {
  const o = httpSession("owner");
  // **`product` に作成の壁は立っていない** —— **同じ相手が作れて、直せない。**
  const product = await seedWallProduct(o.cookie);
  const res = await httpBatch(o.cookie, [
    {
      op: "update",
      table: "product",
      target: product.id,
      values: { memo: "手直し" },
      if_match: product.version,
    },
  ]);
  expect(res.status).toBe(403);
  // **値が1バイトも変わっていないことを読み直して確かめる。**
  const after = await httpReq(o.cookie, "GET", `${HTTP_PRODUCTS}/${product.id}`);
  expect(after.status).toBe(200);
  // **書かれていれば `"手直し"` になっている。** **実測値は `null`(未設定)である。**
  expect(((await after.json()) as { record: { memo?: unknown } }).record.memo).toBeNull();
});

test("(BT-3) 壁の内側と外側の op が混ざったバッチは、全体が 403 で1件も書かれない", async () => {
  const e = httpSession("editor");
  // **1本目は壁の内側**(`order` の作成の壁は `["editor"]`)。
  // **2本目は壁の外側**(`coupon` の作成の壁は `["customer"]`)。
  const res = await httpBatch(e.cookie, [
    { op: "create", table: "order", values: { note: "通るはずの1本目" } },
    { op: "create", table: "coupon", values: { code: "止まる2本目" } },
  ]);
  expect(res.status).toBe(403);
  // **1本目も書かれていない。** **これが部分適用ゼロの実測である。**
  expect(await countRows(e.cookie, HTTP_ORDERS)).toBe(0);
  expect(await countRows(e.cookie, HTTP_COUPONS)).toBe(0);

  // **【対照】** **1本目だけを同じ相手が同じ形で投げると通り、行が1件増える** ——
  // **したがって上の 0 件は「1本目がもともと書けなかったから」ではない。**
  const alone = await httpBatch(e.cookie, [
    { op: "create", table: "order", values: { note: "通るはずの1本目" } },
  ]);
  expect(alone.status).toBe(200);
  expect(await countRows(e.cookie, HTTP_ORDERS)).toBe(1);
});

test("(BT-4) 壁の立っていない表だけのバッチは今日どおり通る", async () => {
  const o = httpSession("owner");
  // **`product` には作成の壁が1本も立っていない**(立っているのは更新の壁だけである)。
  const res = await httpBatch(o.cookie, [
    { op: "create", table: "product", values: { name: "梅干し" } },
    { op: "create", table: "product", values: { name: "沢庵" } },
  ]);
  expect(res.status).toBe(200);
  expect(await countRows(o.cookie, HTTP_PRODUCTS)).toBe(2);
});

test("(BT-5) batch は今日どおり editor/owner 限定なので、customer だけの壁が立った表は誰も batch で書けない", async () => {
  const couponOp = [{ op: "create", table: "coupon", values: { code: "誰も書けない" } }];
  // **壁の外の2ロール** —— **壁が 403 を返す。**
  const o = httpSession("owner");
  expect((await httpBatch(o.cookie, couponOp)).status).toBe(403);
  const e = httpSession("editor");
  expect((await httpBatch(e.cookie, couponOp)).status).toBe(403);
  // **壁の中の唯一の相手(`customer`)は、壁より手前の `batchAuthMiddleware` が 403 で落とす。**
  // **同じ 403 だが、止めているものが違う** —— **本検査はその区別を測っていない。**
  const c = httpSession("customer");
  expect((await httpBatch(c.cookie, couponOp)).status).toBe(403);
  // **どの相手でも1行も書かれていない。**
  expect(await countRows(o.cookie, HTTP_COUPONS)).toBe(0);
});
