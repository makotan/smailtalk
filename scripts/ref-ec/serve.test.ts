/**
 * 参照ショップ起動スクリプトの検査(V4-M1-T00 / `D-V4-28`)。
 *
 * ## 何を検査するか
 *
 * `D-V4-28`(ユーザ決定)は「参照 EC をコマンド1発で立ち上がる形にする」と定めた。
 * 立ち上げそのもの(`Bun.serve` でポートを開く)はプロセスの話なのでここでは踏まず、
 * **検証可能な単位に割った3つ**を固定する:
 *
 *  1. **マニフェストの流し込み** —— `scripts/ref-ec/manifest.ts` の宣言が、実際の dataRoot 上の
 *     アプリ実体(台帳 + `manifest.json` + `app.sqlite`)になること。ビュー10本が空画面に
 *     ならないだけの種データが入ること。
 *  2. **冪等性** —— 2回目以降も壊れずに立ち上がること。アプリも種データも二重にならず、
 *     標準出力に出した平文パスワードが**再実行後も実際にログインできる**こと。
 *  3. **出力する URL の形** —— 10ビュー全部の URL を組み立て、`localhost` で出すこと
 *     (`127.0.0.1` 表記だと `src/server/app.ts` の Origin 検査で POST が全部 403 になる。
 *     04 §2-9 の【必須】)。
 *
 * ## ここで検査していないこと(誇張しない)
 *
 * - **実プロセスの起動**(`bun run scripts/ref-ec/serve.ts` がポートを開くこと)は踏んでいない。
 *   `import.meta.main` 配下の `main()` はテストから呼ばない。実際に起動して画面が返ることは
 *   `docs/plan/v4/records/v4-m1.md` に手で踏んだ記録として残す。
 * - **ブラウザでの描画**は踏んでいない(playwright には載せていない)。
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAuthConfig } from "../../src/auth/config.ts";
import { KernelMetaStore } from "../../src/kernel/meta-store.ts";
import { listRecords } from "../../src/kernel/records.ts";
import { appDbPath, appManifestPath } from "../../src/kernel/storage-paths.ts";
import type { Manifest } from "../../src/kernel/types.ts";
import { createServerApp } from "../../src/server/app.ts";
import { REF_EC_APP_ID } from "./manifest.ts";
import {
  formatStartupReport,
  type ProvisionResult,
  provisionReferenceShop,
  REF_EC_CUSTOMER,
  REF_EC_DEFAULT_DATA_ROOT,
  REF_EC_DEFAULT_PORT,
  REF_EC_OWNER,
  referenceShopUrls,
  resolveServeConfig,
} from "./serve.ts";

const PORT = 3399;
const ORIGIN = `http://localhost:${PORT}`;

let dataRoot: string;
let first: ProvisionResult;
let second: ProvisionResult;

beforeAll(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-refec-serve-"));
  first = await provisionReferenceShop({ dataRoot, origin: ORIGIN });
  // 2回目(冪等性)。**同じ dataRoot に対してもう一度そのまま呼ぶ。**
  second = await provisionReferenceShop({ dataRoot, origin: ORIGIN });
});

afterAll(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

/** アプリ DB の1テーブルの行数を、ディスクの manifest.json 経由で数える。 */
function countRows(table: string): number {
  const manifest = JSON.parse(
    readFileSync(appManifestPath(dataRoot, REF_EC_APP_ID), "utf-8"),
  ) as Manifest;
  const db = new Database(appDbPath(dataRoot, REF_EC_APP_ID), { readonly: true });
  try {
    const result = listRecords(db, manifest, table);
    if (!result.ok) {
      throw new Error(`一覧に失敗(${table}): ${JSON.stringify(result.errors)}`);
    }
    return result.value.length;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// 1. マニフェストの流し込み
// ---------------------------------------------------------------------------

describe("参照ショップの用意(マニフェストの流し込み)", () => {
  test("台帳に参照 EC が1本でき、manifest.json と app.sqlite が実体として在る", () => {
    expect(first.appId).toBe(REF_EC_APP_ID);
    expect(first.appCreated).toBe(true);

    const store = KernelMetaStore.open(dataRoot);
    try {
      expect(store.listApps().map((app) => app.app_id)).toEqual([REF_EC_APP_ID]);
    } finally {
      store.close();
    }
    expect(existsSync(appManifestPath(dataRoot, REF_EC_APP_ID))).toBe(true);
    expect(existsSync(appDbPath(dataRoot, REF_EC_APP_ID))).toBe(true);
  });

  test("参照 EC の宣言(テーブル17 / ビュー16 / function 4 / workflow 11)がそのまま入る", () => {
    // **V4-M4-T07(`D-V4-23`)で テーブル16 → 17 / ビュー10 → 12 / workflow 7 → 8 になった。**
    // 増えたのは `order_action`(取り消しの申し込み)/ `order-action-form` /
    // `order-action-list` / `wf-order-cancel-request` の4つである。
    // **V4-M21-T01(`E-G30` / `D-V4-72`)で ビュー12 → 13 / function 3 → 4 /
    // workflow 8 → 9 になった。** 増えたのは `cart-line-list`(無効行を出さない一覧)/
    // `fn-cart-line-dedupe`(島)/ `wf-cart-line-dedupe` の3つである。
    // **テーブルは17本のまま**(足したのは `cart_line` の `voided` フィールド1本だけ)。
    // **【`V5-M18` / `D-V5-86`。2026-08-05】ビュー13 → 16 / workflow 9 → 11 になった。**
    // 増えたのは `cart-list`(買い物かご一覧)/ `checkout-form`(会計の入力画面)/
    // `order-receipt`(会計の控え)の3ビューと、`wf-cart-close` / `wf-product-archive` の
    // 2ワークフロー(どちらも `trigger.type: "manual"`)である。
    // **テーブルは17本のまま**(足したのは `order` の `cart` / `payment_method` /
    // `payment_slip` の3フィールドだけ)。**function は4本のまま。**
    // **上の3つのコメント行を1バイトも書き換えていない**(当時の実測である)。
    expect(first.manifest.app.tables).toHaveLength(17);
    expect(first.manifest.app.views).toHaveLength(16);
    expect(first.manifest.app.functions).toHaveLength(4);
    expect(first.manifest.app.workflows).toHaveLength(11);
  });

  test("第1号ユーザが owner になり、2人目は customer になる(誰が owner かが決まる)", () => {
    expect(first.accounts.owner.username).toBe(REF_EC_OWNER.username);
    expect(first.accounts.owner.role).toBe("owner");
    expect(first.accounts.owner.created).toBe(true);
    expect(first.accounts.customer.username).toBe(REF_EC_CUSTOMER.username);
    expect(first.accounts.customer.role).toBe("customer");
    // owner のほうが先に作られている(このスクリプトが owner を第1号として登録する)。
    expect(first.accounts.owner.userId).not.toBe(first.accounts.customer.userId);
  });

  test("平文パスワードを結果として持ち帰る(標準出力に出せる形になっている)", () => {
    expect(first.accounts.owner.password).toBe(REF_EC_OWNER.password);
    expect(first.accounts.customer.password).toBe(REF_EC_CUSTOMER.password);
    expect(first.accounts.owner.sessionCookie).toStartWith("st_session=");
    expect(first.accounts.customer.sessionCookie).toStartWith("st_session=");
  });

  test("種データが入り、ビューが当たるテーブルが1行以上になる", () => {
    expect(first.seeded).toBe(true);
    for (const table of ["category", "product", "cart", "cart_line", "order", "order_line"]) {
      expect(first.rowCounts[table], `${table} の行数`).toBeGreaterThan(0);
    }
    // detail_view の URL を組むための代表 _id。
    for (const table of ["category", "product", "cart", "order"]) {
      expect(first.sampleRecordIds[table], `${table} の代表 _id`).toBeTruthy();
    }
  });

  test("order_totals は集計ワークフローが実際に書いた行である(1行。注文2本のうち1本ぶん)", () => {
    // fn-order-totals は order の on_create でしか走らないので、最後に作った注文の明細は
    // まだ集計に入っていない。**空にならないことだけを固定し、全注文ぶんとは書かない。**
    expect(first.rowCounts.order_totals).toBe(1);
    expect(first.rowCounts.order).toBe(2);
  });

  test("アプリが注文行に焼き付けた合計と、集計島が order_totals に書いた合計が一致する", () => {
    // 参照 EC に「行内の計算列」は無く、金額は (a) アプリが注文行に焼き付けたスナップショットと
    // (b) 島が集計テーブルへ書いた値の**2箇所に別々に在る**。種データの価格設定をマスタ3表と
    // ずらすと、画面上で2つの合計が食い違う(実測で踏んだ)。**一致することを固定する。**
    const manifest = JSON.parse(
      readFileSync(appManifestPath(dataRoot, REF_EC_APP_ID), "utf-8"),
    ) as Manifest;
    const db = new Database(appDbPath(dataRoot, REF_EC_APP_ID), { readonly: true });
    try {
      const orders = listRecords(db, manifest, "order");
      const totals = listRecords(db, manifest, "order_totals");
      if (!orders.ok || !totals.ok) {
        throw new Error("一覧に失敗しました。");
      }
      const totalsRow = totals.value[0];
      expect(totalsRow).toBeDefined();
      const order = orders.value.find((row) => row._id === totalsRow?.order);
      expect(order, "集計行に対応する注文").toBeDefined();
      expect(totalsRow?.subtotal).toBe(order?.subtotal);
      expect(totalsRow?.discount).toBe(order?.discount);
      expect(totalsRow?.shipping_fee).toBe(order?.shipping_fee);
      expect(totalsRow?.tax).toBe(order?.tax);
      expect(totalsRow?.total).toBe(order?.total);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. 冪等性
// ---------------------------------------------------------------------------

describe("冪等性(2回目以降も壊れずに立ち上がる)", () => {
  test("2回目はアプリを作り直さず、既存を再利用する", () => {
    expect(second.appCreated).toBe(false);
    expect(second.seeded).toBe(false);
    const store = KernelMetaStore.open(dataRoot);
    try {
      expect(store.listApps()).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("2回目で種データが二重にならない", () => {
    expect(second.rowCounts).toEqual(first.rowCounts);
    expect(countRows("product")).toBe(first.rowCounts.product ?? -1);
    expect(countRows("order")).toBe(first.rowCounts.order ?? -1);
  });

  test("2回目でもアカウントは増えず、owner は第1号のまま", () => {
    expect(second.accounts.owner.created).toBe(false);
    expect(second.accounts.owner.userId).toBe(first.accounts.owner.userId);
    expect(second.accounts.owner.role).toBe("owner");
    expect(second.accounts.customer.userId).toBe(first.accounts.customer.userId);
    expect(second.accounts.customer.role).toBe("customer");
  });

  test("再実行後も、出力した平文パスワードで実際にログインできる", async () => {
    const app = createServerApp({
      dataRoot,
      authConfig: loadAuthConfig({ ST_AUTH_EXPECTED_ORIGIN: ORIGIN }),
    });
    for (const account of [second.accounts.owner, second.accounts.customer]) {
      const response = await app.request(
        new Request(`${ORIGIN}/api/apps/${REF_EC_APP_ID}/auth/password/login`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: ORIGIN },
          body: JSON.stringify({ username: account.username, password: account.password }),
        }),
      );
      expect(response.status, `${account.username} のログイン`).toBe(200);
      const body = (await response.json()) as { user: { username: string; role: string } };
      expect(body.user.username).toBe(account.username);
      expect(body.user.role).toBe(account.role);
    }
  });

  test("fresh を指定すると作り直す(明示的に消してから組み直す)", async () => {
    const freshRoot = await mkdtemp(join(tmpdir(), "gp-refec-fresh-"));
    try {
      const before = await provisionReferenceShop({ dataRoot: freshRoot, origin: ORIGIN });
      expect(before.appCreated).toBe(true);
      const again = await provisionReferenceShop({
        dataRoot: freshRoot,
        origin: ORIGIN,
        fresh: true,
      });
      expect(again.appCreated).toBe(true);
      expect(again.seeded).toBe(true);
      // 作り直したので _id は前回と別物になる。
      expect(again.sampleRecordIds.product).not.toBe(before.sampleRecordIds.product);
      const store = KernelMetaStore.open(freshRoot);
      try {
        expect(store.listApps()).toHaveLength(1);
      } finally {
        store.close();
      }
    } finally {
      await rm(freshRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 3. 出力する URL の形
// ---------------------------------------------------------------------------

describe("出力する URL の形", () => {
  test("アプリのトップ + ビュー16本ぶんの URL を出す", () => {
    const urls = referenceShopUrls(PORT, first);
    // 1(トップ)+ 13(ビュー)= 14。**V4-M4-T07 で 11 → 13、V4-M21-T01 で 13 → 14 になった。**
    // **【`V5-M18`】1 + 16 = 17。当時 `14` → 今日 `17`**(会計まわりの3ビュー)。
    // **上のコメント行を1バイトも書き換えていない。**
    expect(urls).toHaveLength(17);
    expect(urls[0]?.url).toBe(`${ORIGIN}/apps/${REF_EC_APP_ID}`);
    const viewIds = first.manifest.app.views.map((view) => view.id);
    for (const viewId of viewIds) {
      expect(
        urls.some((entry) => entry.url.includes(`/views/${viewId}`)),
        `${viewId} の URL`,
      ).toBe(true);
    }
  });

  test("detail_view の URL には代表レコードの _id が付く(単票が空にならない)", () => {
    const urls = referenceShopUrls(PORT, first);
    const detail = urls.find((entry) => entry.url.includes("/views/product-detail"));
    expect(detail?.url).toBe(
      `${ORIGIN}/apps/${REF_EC_APP_ID}/views/product-detail/records/${first.sampleRecordIds.product}`,
    );
  });

  test("list_view / form の URL にはレコード id を付けない", () => {
    const urls = referenceShopUrls(PORT, first);
    expect(urls.find((entry) => entry.url.includes("/views/catalog-list"))?.url).toBe(
      `${ORIGIN}/apps/${REF_EC_APP_ID}/views/catalog-list`,
    );
    expect(urls.find((entry) => entry.url.includes("/views/product-form"))?.url).toBe(
      `${ORIGIN}/apps/${REF_EC_APP_ID}/views/product-form`,
    );
  });

  test("URL は必ず localhost で出す(127.0.0.1 は POST が 403 になるので1つも出さない)", () => {
    const urls = referenceShopUrls(PORT, first);
    for (const entry of urls) {
      expect(entry.url).toStartWith(`http://localhost:${PORT}/`);
      expect(entry.url).not.toInclude("127.0.0.1");
    }
  });
});

// ---------------------------------------------------------------------------
// 4. 起動時の標準出力
// ---------------------------------------------------------------------------

describe("起動時の標準出力", () => {
  test("どの URL で何が見えるかと、平文の資格情報と、誰が owner かを出す", () => {
    const report = formatStartupReport(PORT, first);
    expect(report).toInclude(`http://localhost:${PORT}/apps/${REF_EC_APP_ID}`);
    // 平文をそのまま出す(D-V4-4 の作法。最初の1人だけが owner なので持ち主に渡す)。
    expect(report).toInclude(REF_EC_OWNER.username);
    expect(report).toInclude(REF_EC_OWNER.password);
    expect(report).toInclude(REF_EC_CUSTOMER.username);
    expect(report).toInclude(REF_EC_CUSTOMER.password);
    expect(report).toInclude("owner");
    expect(report).toInclude("customer");
    // 10ビューぶんの見出しが並ぶ。
    for (const view of first.manifest.app.views) {
      expect(report, `${view.id} の行`).toInclude(view.id);
    }
    // dataRoot も出す(どこに書いたかを隠さない)。
    expect(report).toInclude(dataRoot);
  });

  test("st_owner のスコープで「owner には見えない画面がある」ことを出力に書く", () => {
    // owner にも st_owner が効くので、購入者の cart / order は owner では0件に見える。
    // 起動時に黙らせない(憲法6)。
    const report = formatStartupReport(PORT, first);
    expect(report).toInclude("st_owner");
  });
});

// ---------------------------------------------------------------------------
// 4b. 逃げ道(任意 CSS)の見本 —— V4-M30 / `D-V4-113` で1件発行していたが、
//     V4-M33 / `D-V4-116`(「検査の中だけに残し、店からは取り消す」)で
//     参照ショップからは発行と参照の両方を外した。
// ---------------------------------------------------------------------------

describe("逃げ道(任意 CSS)の見本は参照ショップに1件も無い(D-V4-116 で取り消した)", () => {
  /**
   * **取り消した見本の資産名**(かつて `scripts/ref-ec/manifest.ts` が
   * `REF_EC_ESCAPE_HATCH_ASSET` として export していた値)。
   *
   * **`V4-M52` / ユーザ決定 `D-V4-138`** が「参照ショップから使わなくなった宣言2本を消す」と定めたので、
   * 定数の宣言は `manifest.ts` から消し、**この検査が守っていたバイト列だけをここに直に置いた。**
   * **値は1バイトも変えていない**(`"catalog-emphasis"`)。**検査は1本も消していない。**
   */
  const RETIRED_ESCAPE_HATCH_ASSET = "catalog-emphasis";

  /**
   * **見本を当てていた画面の id**(かつて `REF_EC_ESCAPE_HATCH_VIEW` として export していた値)。
   * 同じく `D-V4-138` で宣言を消し、値をここに直に置いた(`"catalog-list"`。1バイトも変えていない)。
   * **この id は `scripts/ref-ec/manifest.ts` の `catalog-list` ビューと同じもので、
   * `manifest.test.ts` も同じ文字列を直に書いている。**
   */
  const RETIRED_ESCAPE_HATCH_VIEW = "catalog-list";

  /** owner でログインして `st_session=<id>` を返す(**製品の HTTP 経路をそのまま通す**)。 */
  async function ownerCookie(app: ReturnType<typeof createServerApp>): Promise<string> {
    const response = await app.request(
      new Request(`${ORIGIN}/api/apps/${REF_EC_APP_ID}/auth/password/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({
          username: REF_EC_OWNER.username,
          password: REF_EC_OWNER.password,
        }),
      }),
    );
    expect(response.status).toBe(200);
    const setCookie = response.headers.get("set-cookie") ?? "";
    const id = /st_session=([^;]+)/.exec(setCookie)?.[1];
    expect(id, "ログインでセッション cookie が返る").toBeDefined();
    return `st_session=${id}`;
  }

  function serverApp(): ReturnType<typeof createServerApp> {
    return createServerApp({
      dataRoot,
      authConfig: loadAuthConfig({ ST_AUTH_EXPECTED_ORIGIN: ORIGIN }),
    });
  }

  // **旧来(V4-M30 / D-V4-113)は、この直後が `expect(assets).toHaveLength(1)` と
  // `assets[0]?.name === "catalog-emphasis"` 等で「1件だけ発行され、2回目の用意でも
  // 増えない」ことを固定していた。** D-V4-116 で発行そのものをやめたので、owner から見た
  // 在庫は(1回目・2回目とも)0件のままであることを固定する。
  test("owner の HTTP 経路で見ても在庫は0件のまま(発行しない。冪等に0件)", async () => {
    const app = serverApp();
    const cookie = await ownerCookie(app);
    const response = await app.request(
      new Request(`${ORIGIN}/api/apps/${REF_EC_APP_ID}/escape-hatch-assets`, {
        headers: { origin: ORIGIN, cookie },
      }),
    );
    expect(response.status).toBe(200);
    const { assets } = (await response.json()) as {
      assets: { name: string; digest: string; scopeViews: string[] }[];
    };
    // **`second` も同じ dataRoot に対して走っている**(beforeAll)。それでも0件のままである。
    expect(assets).toHaveLength(0);
    expect(second.appId).toBe(REF_EC_APP_ID);
  });

  test("商品一覧にも、参照を書いていた画面にも custom.css の配信は無い(404)", async () => {
    // **旧来は `expect(response.status).toBe(200)` で配信が届くことを固定していた。**
    // 参照を外した今は、`category-list`(元々参照を書いていなかった画面)と同じ 404 になる
    // (「逃げ道を使っていない画面」であって、遮断=409 ではない)。
    const response = await serverApp().request(
      `${ORIGIN}/api/apps/${REF_EC_APP_ID}/views/${RETIRED_ESCAPE_HATCH_VIEW}/custom.css`,
    );
    expect(response.status).toBe(404);
  });

  test("作用域として使っていた画面以外にも、引き続き配信されない", async () => {
    const response = await serverApp().request(
      `${ORIGIN}/api/apps/${REF_EC_APP_ID}/views/category-list/custom.css`,
    );
    expect(response.status).toBe(404);
  });

  test("起動時の出力は、もう見本にも『壊れたことの検出ではない』にも触れない", () => {
    // **旧来は `expect(report).toInclude("catalog-emphasis")` 等で、見本の案内が
    // 出力に含まれることを固定していた。** 発行をやめたので、その案内ごと消えている
    // ことを逆から固定する(= 持ち主向けの帯は参照ショップの起動報告にはもう出ない)。
    const report = formatStartupReport(PORT, first);
    expect(report).not.toInclude(RETIRED_ESCAPE_HATCH_ASSET);
    expect(report).not.toInclude("壊れたことの検出ではありません");
    expect(report).not.toInclude("当たり先は1件も数えていません");
  });
});

// ---------------------------------------------------------------------------
// 5. 設定の解決
// ---------------------------------------------------------------------------

describe("設定の解決(env)", () => {
  test("既定は data-ref-ec / 3211 / localhost:3211", () => {
    const config = resolveServeConfig({});
    expect(config.dataRoot).toBe(REF_EC_DEFAULT_DATA_ROOT);
    expect(config.port).toBe(REF_EC_DEFAULT_PORT);
    expect(config.origin).toBe(`http://localhost:${REF_EC_DEFAULT_PORT}`);
    expect(config.fresh).toBe(false);
  });

  test("env で dataRoot / ポート / 作り直しを差し替えられる", () => {
    const config = resolveServeConfig({
      ST_REF_EC_DATA_ROOT: "data-ref-ec-2",
      ST_REF_EC_PORT: "3999",
      ST_REF_EC_FRESH: "1",
    });
    expect(config.dataRoot).toBe("data-ref-ec-2");
    expect(config.port).toBe(3999);
    expect(config.origin).toBe("http://localhost:3999");
    expect(config.fresh).toBe(true);
  });

  test("既定の dataRoot は .gitignore の data-*/ に掛かる名前である", () => {
    // 生成物を git に入れないための約束。名前を変えるならこの検査も一緒に直すこと。
    expect(REF_EC_DEFAULT_DATA_ROOT).toStartWith("data-");
  });
});
