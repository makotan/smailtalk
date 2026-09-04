/**
 * 参照 EC 全マニフェスト + 公開閲覧/顧客/画像の実証(V2-M7-T01 / CP-V2)。
 *
 * TDD で以下を固定する(検証観点はメインの計画 docs/plan/v2/records/v2-m7.md §1 V2-M7-T01):
 *  (a) `applyManifest` が §1 フル機能セットの全マニフェストを **valid** で受理する
 *      (§1 が要る全テーブル・全ビュー・全ワークフロー・全 function を名指しで確認)。
 *  (b) 匿名カタログ閲覧(EC-G1): 本物の HTTP サーバ(createServerApp)で、未認証 GET が
 *      公開商品(st_public=true)だけ返す。運営テーブル(order)は未認証で遮断。
 *  (c) 顧客ロール分離(EC-G2): 顧客が**本物のサインアップ経路**で登録し、自分の cart/order
 *      だけ見える(st_owner 顧客スコープ)、運営テーブルは 403。owner と分離。
 *  (d) 商品画像(EC-G3): `POST /files` で画像アップロード(認証必須)→ product.image に file_id
 *      → 公開商品の画像は未認証 `GET /files/:id` で配信・非公開商品の画像は 404。
 *  (e) 語彙ゼロ増: FIELD_TYPES(8)/RESOURCE_KINDS(7)/DIFF_OPS(15) 不変を機械固定。
 *
 * 本物の SQLite(mkdtemp の tmpdir)・本物の HTTP サーバ(createServerApp)を使い、
 * afterEach で片付ける(M5 `payment-flow-e2e.test.ts` と同じ作法)。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiCapabilityStore } from "../../src/kernel/ai-capability-store.ts";
import { applyManifest } from "../../src/kernel/apply-manifest.ts";
import { CapabilityStore } from "../../src/kernel/capability-store.ts";
import { createApp } from "../../src/kernel/create-app.ts";
import { ensureIslandRuntimeReady } from "../../src/kernel/island-runner.ts";
import { KernelMetaStore } from "../../src/kernel/meta-store.ts";
import {
  createRecord,
  listRecords,
  type RecordRow,
  updateRecord,
} from "../../src/kernel/records.ts";
import { appDbPath } from "../../src/kernel/storage-paths.ts";
import type { Field, Manifest, Table } from "../../src/kernel/types.ts";
// 【`V5-M29-T06` / メインの裁定1】**`FIELD_TYPES` と `RESOURCE_KINDS` の値 import を消した。**
//   `V5-M29-T05` は「消すと `scripts/kernel-import-snapshot.txt` の行が減り、それを sha で
//   固定している `scripts/industry-neutral-examples.test.ts`(`ADR-0163` 限定3)が赤くなる」
//   ことを理由に残し、`TS6133` と `noUnusedImports` を残した。**メインは消す側を採った。**
//   スナップショットからは本ファイルの2行を含む計9行を消し、
//   `industry-neutral-examples.test.ts` の基準値は同ファイルの作法(旧値を消さずコメントに
//   残す)どおり更新した。**`DIFF_OPS` は同ファイル内で今日も使われているので残っている。**
import { DIFF_OPS } from "../../src/kernel/types.ts";
import { resetWorkflowClock, setWorkflowClock } from "../../src/kernel/workflow-runner.ts";
import { runSchedulerTick } from "../../src/kernel/workflow-scheduler.ts";
import { createServerApp } from "../../src/server/app.ts";
// **【`V8-M20` / 台帳 `J-G30` / `ADR-0301`】`ADMIN_READABLE_FIELD` と `adminReadableField` の
// 2本の import を落とした** —— **予約規約フィールド `st_admin_readable` が廃止され、
// `src/server/owner-scope.ts` から両方の export が消えたためである。**
// **代わりに `roleReadCrossesOwnerScope` を取っている** —— **「その表の読取が、持ち主の枠を
// 越えて開いているか」に今日答えるのはこの1本である**(ユーザ決定 `D-V8-35`)。
import {
  OWNER_FIELD,
  PUBLIC_FIELD,
  personalOwnerField,
  roleReadCrossesOwnerScope,
  UNDELETABLE_FIELD,
} from "../../src/server/owner-scope.ts";
import { seedSession, TEST_ORIGIN } from "../../src/server/test-helpers.ts";
import {
  REF_EC_APP_ID,
  REF_EC_ESCAPE_HATCH_CSS,
  REF_EC_ESCAPE_HATCH_DIGEST,
  referenceEcManifest,
} from "./manifest.ts";

const APP_ID = REF_EC_APP_ID;

let dataRoot: string;
let store: KernelMetaStore;
let app: ReturnType<typeof createServerApp>;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-ref-ec-"));
  store = KernelMetaStore.open(dataRoot);
  createApp(store, "参照EC", { app_id: APP_ID });
  const installed = applyManifest(dataRoot, APP_ID, referenceEcManifest());
  if (!installed.valid) {
    throw new Error(`参照 EC マニフェストの投入に失敗: ${JSON.stringify(installed.errors)}`);
  }

  // ---------------------------------------------------------------------
  // V3-M13-T02(ADR-0066)による**前提の追加**。期待値の更新であって、実装の誤りではない。
  //
  // **`order` の書込は、`wf-order-checkout`(call_external + run_function)の成否に
  // 依存するようになった** —— アクションが1つでも失敗すれば、その書込は成立しない。
  // 本テストはこれまで「アクションが失敗しても注文行は残る」ことに黙って依存していた
  // (接続が未発行・島ランタイム未ロードのまま注文を作っていた)。
  // **依存していた前提が決定として変わったので、テスト側で前提を明示的に整える。**
  //
  // 整えるのは2つだけである(`journey-e2e.test.ts` の beforeEach と同じ作法):
  //   1. 人間 owner による接続の発行(mock-psp / mail-gateway)。**AI は申請だけ**(ADR-0020)
  //   2. 島ランタイムのロード(同期発火経路では待てないので、async 境界で先に済ませる)
  // ---------------------------------------------------------------------
  issueRefEcCapabilities(APP_ID);
  await ensureIslandRuntimeReady();

  app = createServerApp({ dataRoot });
  // **【`V8-M30` 第2波(2026-08-11)。ユーザ決定 `D-V8-82`。題材だけを直した】**
  // **旧(逐語)**: この直後の登録は無く、各検査の顧客サインアップがこのアプリの
  // **最初の1人**だった。
  // **`D-V8-82` により、自己登録でも最初の1人は持ち主になる**(選ばれた説明文の逐語
  // 「**公開の購入サイトでは、最初に買った客が運営者になってしまいます。**」)——
  // **参照 EC の主題(顧客ロールの分離・全ジャーニー)を測るには、先に運営者を1人
  // 置いて初回の席を埋める必要がある。** **測っている中身は1ミリも変えていない。**
  // **最初の1人が持ち主になること自体は `src/server/first-user-owner.test.ts` が測る。**
  {
    const seeded = await app.request(
      new Request(`http://localhost/api/apps/${APP_ID}/auth/password/register`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: TEST_ORIGIN },
        body: JSON.stringify({ username: "ref-ec-owner", password: "pw-123456" }),
      }),
    );
    if (seeded.status !== 200) {
      throw new Error(`運営者の初期登録に失敗: ${await seeded.text()}`);
    }
  }
});

afterEach(async () => {
  store.close();
  await rm(dataRoot, { recursive: true, force: true });
});

/** 送信 secret の取得元(env の名前だけを渡す。secret 本体は保管しない。ADR-0020)。 */
const OUTBOUND_SECRET_ENV = "ST_REF_EC_OUTBOUND_SECRET";

/**
 * 参照 EC のワークフローが要る capability を、**人間 owner の立場で**発行する
 * (V3-M13-T02 / ADR-0066 による前提の追加)。
 *
 * 発行するのは3つ —— 送信の接続2本(`mock-psp` / `mail-gateway`)と AI capability 1本
 * (`ai-copywriter`)。**AI は申請しかできない**(ADR-0020 / ADR-0021 §2b)ので、
 * テストでも発行側の API を直接使う(`journey-e2e.test.ts` と同じ作法)。
 *
 * **AI capability は「ジョブを積めるようにする」だけである** —— `ai_transform` は
 * `ai_jobs` に積むだけで、推論も書き戻しも配送側(`dispatchAiJobs`)が行う。
 * 本テストは配送を1度も回さないので、外部呼び出しは1回も起きない。
 */
function issueRefEcCapabilities(appId: string): void {
  process.env[OUTBOUND_SECRET_ENV] = "ref-ec-outbound-bearer-secret";
  const cap = CapabilityStore.openForKernel(dataRoot);
  try {
    for (const name of ["mock-psp", "mail-gateway"]) {
      cap.createConnection({
        appId,
        name,
        allowedHosts: ["127.0.0.1"],
        secretSource: { kind: "env", value: OUTBOUND_SECRET_ENV },
      });
    }
  } finally {
    cap.close();
  }
  const ai = AiCapabilityStore.openForKernel(dataRoot);
  try {
    ai.createCapability({
      appId,
      name: "ai-copywriter",
      provider: "claude_cli",
      model: "claude-opus-4-8",
      limit: { maxCallsPerDay: 1000, maxCostUsdPerDay: 10 },
    });
  } finally {
    ai.close();
  }
}

const R = (table: string, id?: string) =>
  `/api/apps/${APP_ID}/tables/${table}/records${id === undefined ? "" : `/${id}`}`;

/**
 * **【2026-08-10(`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-58` / `D-V8-65`)で足した】**
 *
 * **カーネル直呼びで注文を入れる検査のための「持ち主」を1人だけ用意する。**
 *
 * **なぜ要るのか** —— **既定が「閉じる」側へ倒れたので、レコード書込で発火する
 * ワークフローの**書き手**が面の判定に掛かるようになった。** **書き手は
 * 「`act_as` が無ければトリガー元の行の持ち主」であり(`resolveWorkflowActor`)、
 * その識別子から実効ロール集合を引くのは `_auth_users` である**
 * (`effectiveRolesOnDb`)。**つまり「実在する利用者の識別子」でなければ、
 * 役割は解けず、未ログインと同じ主体として評価される。**
 *
 * **`seedSession` は本物の利用者行とセッションを作る** —— **HTTP を1度も通さずに
 * 「購入者として書いた行」を作れる唯一の道である。**
 *
 * **1テストにつき1人でよいので、`dataRoot` × アプリID で覚える**(`beforeEach` が
 * `dataRoot` を作り直すので、テストをまたいで再利用されることはない)。
 */
const stableBuyers = new Map<string, ReturnType<typeof seedSession>>();
function stableBuyer(appId: string = APP_ID): ReturnType<typeof seedSession> {
  const key = `${dataRoot}::${appId}`;
  const found = stableBuyers.get(key);
  if (found !== undefined) {
    return found;
  }
  const seeded = seedSession(dataRoot, appId, {
    role: "customer",
    username: `kernel-buyer-${Math.random().toString(36).slice(2, 10)}`,
  });
  stableBuyers.set(key, seeded);
  return seeded;
}

/** owner セッションで records を1件 POST(201 を期待)。 */
async function createAsOwner(
  cookie: string,
  table: string,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await app.request(
    new Request(`http://localhost${R(table)}`, {
      method: "POST",
      headers: { cookie, origin: TEST_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  expect(res.status, `create ${table}: ${await res.clone().text()}`).toBe(201);
  return ((await res.json()) as { record: { _id: string } }).record._id;
}

/** ヘッダ付き request の薄いラッパ。 */
function request(
  method: string,
  path: string,
  opts: { cookie?: string; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.cookie !== undefined) {
    headers.cookie = opts.cookie;
  }
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    headers.origin = TEST_ORIGIN;
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  return Promise.resolve(app.request(new Request(`http://localhost${path}`, init)));
}

/**
 * 本物の顧客サインアップ経路(`/auth/signup/password/register`)で登録し、
 * `st_session` cookie を返す(V3-M11-T01。describe (c) の同名ヘルパと同じ経路)。
 *
 * **describe (c) 内のヘルパを共有化せず、モジュール直下にもう1本置いた** —— (c) の既存
 * テストを1バイトも動かさないためである(V3-M11 差し戻し条件3 の趣旨)。
 */
async function signupCustomer(username: string): Promise<string> {
  const res = await app.request(
    new Request(`http://localhost/api/apps/${APP_ID}/auth/signup/password/register`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: TEST_ORIGIN },
      body: JSON.stringify({ username, password: "pw-123456" }),
    }),
  );
  expect(res.status, `signup ${username}: ${await res.clone().text()}`).toBe(200);
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(";");
    const [k, v] = (pair ?? "").split("=");
    if (k === "st_session") {
      return `st_session=${v}`;
    }
  }
  throw new Error("st_session cookie が発行されなかった");
}

// ===========================================================================
// (a) 全マニフェストが applyManifest valid(§1 フル機能セット)
// ===========================================================================

describe("(a) 参照 EC 全マニフェストは applyManifest で valid(§1 フル機能セット)", () => {
  test("valid が返り、§1 が要る全テーブル・全ビュー・全ワークフロー・全 function が揃う", async () => {
    // beforeEach の applyManifest が既に valid を要求済み。ここは投入結果の再確認 + 名指し検査。
    const freshRoot = await mkdtemp(join(tmpdir(), "gp-ref-ec-a-"));
    const s = KernelMetaStore.open(freshRoot);
    try {
      createApp(s, "参照EC", { app_id: APP_ID });
      const result = applyManifest(freshRoot, APP_ID, referenceEcManifest());
      expect(result.valid, JSON.stringify(result.valid ? {} : result.errors)).toBe(true);
    } finally {
      s.close();
      await rm(freshRoot, { recursive: true, force: true });
    }

    const m = referenceEcManifest().app;

    // §1 が要るテーブルが全て在る(商品カタログ〜決済モック + 集計 + 履歴)。
    const tableIds = m.tables.map((t) => t.id);
    for (const id of [
      "category",
      "product",
      "customer",
      "address",
      "cart",
      "cart_line",
      "order",
      "order_line",
      "coupon",
      "shipping_method",
      "tax_rate",
      "payment_events",
      "cart_totals",
      "order_totals",
      "order_events",
      "wf_runs",
    ]) {
      expect(tableIds, `table ${id}`).toContain(id);
    }

    // 素案の型「⚠」箇所が既存語彙で解けていること(名実確認)。
    const product = m.tables.find((t) => t.id === "product");
    expect(product?.fields.find((f) => f.id === "image")?.type).toBe("image"); // EC-G3
    expect(product?.fields.find((f) => f.id === "sku")).toMatchObject({ unique: true }); // EC-G8
    expect(product?.fields.some((f) => f.id === PUBLIC_FIELD)).toBe(true); // EC-G1
    const category = m.tables.find((t) => t.id === "category");
    // 自己参照(category.parent → category)。reference は同一アプリ内テーブルのみ。
    expect(category?.fields.find((f) => f.id === "parent")).toMatchObject({
      type: "reference",
      reference_table: "category",
    });
    const paymentEvents = m.tables.find((t) => t.id === "payment_events");
    expect(paymentEvents?.fields.find((f) => f.id === "event_id")).toMatchObject({ unique: true });

    // ビュー: 公開 list_view / related 子一覧 / actions プリフィル / form が揃う。
    const viewIds = m.views.map((v) => v.id);
    for (const id of [
      "catalog-list",
      "category-list",
      "product-detail",
      "cart-line-form",
      "cart-detail",
      "order-detail",
      "category-detail",
      "order-list",
      "product-form",
    ]) {
      expect(viewIds, `view ${id}`).toContain(id);
    }
    // EC-G17 related(order-detail に注文明細子一覧)。
    const orderDetail = m.views.find((v) => v.id === "order-detail");
    expect(orderDetail?.type === "detail_view" && orderDetail.related?.[0]).toMatchObject({
      table: "order_line",
      via: "order",
    });
    // EC-G14 actions(product-detail から「カートに入れる」)。
    const productDetail = m.views.find((v) => v.id === "product-detail");
    expect(productDetail?.type === "detail_view" && productDetail.actions?.[0]).toMatchObject({
      form: "cart-line-form",
      prefill: { field: "product" },
    });

    // ワークフロー: トリガー3種・アクション5種を網羅している。
    // **【`V5-M18` / `D-V5-86`。2026-08-05】トリガーは 3種 → 4種になった** ——
    // `manual` は `V5-M25` が足した4値目であり、参照 EC は `wf-cart-close` /
    // `wf-product-archive` の2本でそれを使う。**上の「3種」という行を1バイトも
    // 書き換えていない**(当時の実測である)。**アクションは5種のままである。**
    const wfs = m.workflows ?? [];
    const triggerTypes = new Set(wfs.map((w) => w.trigger.type));
    expect(triggerTypes).toEqual(new Set(["on_create", "on_update", "schedule", "manual"]));
    const actionKinds = new Set(wfs.flatMap((w) => w.actions.map((a) => a.action)));
    expect(actionKinds).toEqual(
      new Set(["create_record", "update_record", "call_external", "ai_transform", "run_function"]),
    );

    // function: 行内(Route B)+ 集計(全置換)が揃う。
    const fnIds = (m.functions ?? []).map((f) => f.id);
    expect(fnIds).toEqual(
      expect.arrayContaining(["fn-line-total", "fn-order-totals", "fn-cart-totals"]),
    );
  });

  test("V4-M33 / D-V4-116: 商品一覧に逃げ道(任意 CSS)の見本への参照は無い(店からは取り消した)", () => {
    // **旧来(V4-M30 / D-V4-113)は、この直前の行が `expect(withReference.map(...)).toEqual(
    // ["catalog-list"])` で「参照が1本だけ在る」ことを固定していた。**
    // D-V4-116(「検査の中だけに残し、店からは取り消す」)により、参照ショップの
    // どのビューも `custom_css` を参照しない = 在庫は再び0件に戻ることを固定する。
    //
    // **`V4-M52` / ユーザ決定 `D-V4-138`** が「参照ショップから使わなくなった宣言2本
    // (`REF_EC_ESCAPE_HATCH_ASSET` / `REF_EC_ESCAPE_HATCH_VIEW`)を消す」と定めたので、
    // 見本を当てていた画面の id は **`manifest.ts` からの import ではなく直に書いた**
    // (値は `"catalog-list"` のまま1バイトも変えていない。この検査が守る内容も変えていない)。
    // 同じ文字列は本ファイルの「10ビューの id」の検査でも直に書かれている。
    const app = referenceEcManifest().app;
    const withReference = app.views.filter((view) => view.custom_css !== undefined);
    expect(withReference).toEqual([]);
    const catalogList = app.views.find((view) => view.id === "catalog-list");
    expect(catalogList?.custom_css).toBeUndefined();
    // 見本の CSS 本文とダイジェストの定数そのものは「検査の中だけに残す」ために引き続き
    // export している(`web/e2e/escape-hatch.e2e.ts` の chromium 検査が同じバイト列である
    // ことを確かめるのに使う)。ここではその定数が自己整合していることだけ確かめる。
    expect(REF_EC_ESCAPE_HATCH_DIGEST).toBe(
      createHash("sha256").update(REF_EC_ESCAPE_HATCH_CSS).digest("hex"),
    );
    // **マニフェストの JSON 全体に CSS の本文が1バイトも入っていない**(参照も本文も無い)。
    expect(JSON.stringify(app)).not.toInclude("background-color");
  });
});

// ===========================================================================
// (b) 匿名カタログ閲覧(EC-G1)
// ===========================================================================

describe("(b) 匿名カタログ閲覧(EC-G1 / st_public)", () => {
  test("未認証 GET は公開商品(st_public=true)だけ返し、非公開は出ない・予約フィールドは伏せる", async () => {
    const { cookie } = seedSession(dataRoot, APP_ID); // owner
    const pubId = await createAsOwner(cookie, "product", {
      name: "公開シャツ",
      price: 3000,
      stock: 10,
      [PUBLIC_FIELD]: true,
    });
    await createAsOwner(cookie, "product", {
      name: "非公開シャツ",
      price: 4000,
      stock: 5,
      [PUBLIC_FIELD]: false,
    });

    const res = await request("GET", R("product"));
    expect(res.status).toBe(200);
    const { records } = (await res.json()) as { records: Record<string, unknown>[] };
    expect(records).toHaveLength(1);
    expect(records[0]?._id).toBe(pubId);
    expect(records[0]?.name).toBe("公開シャツ");
    // 予約規約フィールドは匿名射影で伏せる。
    expect(records[0]).not.toHaveProperty(PUBLIC_FIELD);
    expect(records[0]).not.toHaveProperty(OWNER_FIELD);
  });

  test("未認証はカテゴリ(公開テーブル)も GET できる(公開行のみ)", async () => {
    const { cookie } = seedSession(dataRoot, APP_ID);
    await createAsOwner(cookie, "category", { name: "トップス", [PUBLIC_FIELD]: true });
    const res = await request("GET", R("category"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { records: unknown[] }).records).toHaveLength(1);
  });

  test("運営テーブル(order = st_public 無し)は未認証で遮断(401)", async () => {
    // 実挙動: 公開テーブルでない(st_public 無し)テーブルへの匿名 GET は 401
    //(§1 の「運営データは 403/404」に対する本プラットフォームの実際の遮断コードは 401)。
    //
    // **V3-M11-T01 でテスト名から「st_owner のみ」を落とした** —— order に
    // `st_admin_readable` が加わり「st_owner のみ」が偽になったためである。
    // **【`V8-M20` / `J-G30`】その `st_admin_readable` は今日は無い。** **それでもテスト名を
    // 戻していない** —— **`order` には今日も `st_undeletable` が在り、「st_owner のみ」は
    // やはり偽だからである。****期待値(401 × 2)は今日も1バイトも動かしていない。****この検査は
    // 1度も赤くなっていない**(遮断は st_public の有無だけで決まり、予約規約フィールドの
    // 本数に依存しない)。落としたのは名前の記述だけで、期待値(401 × 2)は1バイトも
    // 動かしていない。判定は V3-M11-T00 §6-1 の基準 (ii)(テーブル構成の写し)による。
    const res = await request("GET", R("order"));
    expect(res.status).toBe(401);
    const single = await request("GET", R("order", "anything"));
    expect(single.status).toBe(401);
  });

  test("公開テーブルでも匿名書込は 401(read-only を構造で守る)", async () => {
    const res = await request("POST", R("product"), { body: { name: "x", [PUBLIC_FIELD]: true } });
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// (c) 顧客ロール分離(EC-G2 / st_owner)—— 本物のサインアップ経路
// ===========================================================================

describe("(c) 顧客ロール分離(EC-G2 / st_owner)", () => {
  /** 本物の顧客サインアップ経路で登録し、st_session cookie を返す。 */
  async function customerSignup(username: string): Promise<string> {
    const res = await app.request(
      new Request(`http://localhost/api/apps/${APP_ID}/auth/signup/password/register`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: TEST_ORIGIN },
        body: JSON.stringify({ username, password: "pw-123456" }),
      }),
    );
    expect(res.status, `signup ${username}: ${await res.clone().text()}`).toBe(200);
    const body = (await res.json()) as { user: { role: string } };
    // 顧客経路は常に role=customer(昇格不可)。
    expect(body.user.role).toBe("customer");
    // Set-Cookie から st_session を取り出す。
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(";");
      const [k, v] = (pair ?? "").split("=");
      if (k === "st_session") {
        return `st_session=${v}`;
      }
    }
    throw new Error("st_session cookie が発行されなかった");
  }

  test("顧客は本物のサインアップ経路で登録でき、自分の cart 行だけ見える(他人の行は不可視)", async () => {
    const c1 = await customerSignup(`cust-1-${Math.random().toString(36).slice(2)}`);
    const c2 = await customerSignup(`cust-2-${Math.random().toString(36).slice(2)}`);

    // 各顧客が自分の cart を作る(st_owner は各自の id にスタンプされる)。
    const create = (cookie: string, status: string) =>
      request("POST", R("cart"), { cookie, body: { status } });
    const mine = await create(c1, "open");
    expect(mine.status).toBe(201);
    const mineId = ((await mine.json()) as { record: { _id: string } }).record._id;
    expect((await create(c2, "open")).status).toBe(201);

    // c1 の一覧には自分の1件だけ。
    const list = await request("GET", R("cart"), { cookie: c1 });
    expect(list.status).toBe(200);
    const ids = ((await list.json()) as { records: { _id: string }[] }).records.map((r) => r._id);
    expect(ids).toEqual([mineId]);
  });

  // **【`V8-M27-T04` / `T-G5`。期待値を反転させた。旧のテスト名と旧の期待値を逐語で残す】**
  // **旧: `test("顧客は運営テーブル(coupon = st_owner も st_public も無い)を GET できない(403)")` /
  //       `expect((await request("GET", R("coupon"), { cookie: c })).status).toBe(403);`
  //       `expect((await request("GET", R("tax_rate"), { cookie: c })).status).toBe(403);`**
  // **根拠**: **`V8-M27` / 台帳 `T-G5` / ユーザ決定 `D-V8-38`。**
  // **読取は今日 403 で断らない**(`ADR-0305` 限定11)—— **一覧は 200 で、
  // 行が応答から落ちる。** **「顧客に運営データを見せない」という主題は今日も真であり、
  // 測り方が「応答コード」から「返る行数」に移った。**
  test("顧客は運営テーブル(coupon / tax_rate)の行を1件も受け取らない(旧: 403。今日は 200 + 0件)", async () => {
    const c = await customerSignup(`cust-a-${Math.random().toString(36).slice(2)}`);
    for (const table of ["coupon", "tax_rate"] as const) {
      const res = await request("GET", R(table), { cookie: c });
      expect({ table, status: res.status }).toEqual({ table, status: 200 });
      const rows = ((await res.json()) as { records: unknown[] }).records;
      expect({ table, rows: rows.length }).toEqual({ table, rows: 0 });
    }
  });

  test("顧客は公開テーブル(product)は GET できるが書込は 403(read-only)", async () => {
    const { cookie: owner } = seedSession(dataRoot, APP_ID);
    await createAsOwner(owner, "product", {
      name: "公開品",
      price: 100,
      stock: 1,
      [PUBLIC_FIELD]: true,
    });
    const c = await customerSignup(`cust-b-${Math.random().toString(36).slice(2)}`);
    expect((await request("GET", R("product"), { cookie: c })).status).toBe(200);
    expect((await request("POST", R("product"), { cookie: c, body: { name: "x" } })).status).toBe(
      403,
    );
  });

  test("owner は運営テーブルを GET・書込とも通る(顧客と分離)", async () => {
    const { cookie } = seedSession(dataRoot, APP_ID);
    expect((await request("GET", R("coupon"), { cookie })).status).toBe(200);
    expect((await request("POST", R("coupon"), { cookie, body: { code: "SAVE10" } })).status).toBe(
      201,
    );
  });
});

// ===========================================================================
// (d) 商品画像(EC-G3)—— POST /files アップロード + GET /files/:id 配信
// ===========================================================================

describe("(d) 商品画像(EC-G3 / POST /files + GET /files/:id)", () => {
  const FILES = `/api/apps/${APP_ID}/files`;

  function pngBytes(tag: number): Uint8Array {
    return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, tag, tag + 1, tag + 2]);
  }

  /** owner セッションで画像を1枚アップロードし file_id を返す。 */
  async function uploadImage(cookie: string, tag: number): Promise<string> {
    const form = new FormData();
    form.set("file", new Blob([Uint8Array.from(pngBytes(tag))]), "photo.png");
    const res = await app.request(
      new Request(`http://localhost${FILES}`, {
        method: "POST",
        headers: { cookie, origin: TEST_ORIGIN },
        body: form,
      }),
    );
    expect(res.status, `upload: ${await res.clone().text()}`).toBe(201);
    return ((await res.json()) as { file_id: string }).file_id;
  }

  test("未認証の画像アップロードは 401(書込は公開しない)", async () => {
    const form = new FormData();
    form.set("file", new Blob([Uint8Array.from(pngBytes(1))]), "photo.png");
    const res = await app.request(
      new Request(`http://localhost${FILES}`, { method: "POST", body: form }),
    );
    expect(res.status).toBe(401);
  });

  test("認証済みでアップロード → product.image に file_id → 公開商品の画像は未認証で配信、非公開は 404", async () => {
    const { cookie } = seedSession(dataRoot, APP_ID); // owner
    const filePublic = await uploadImage(cookie, 10);
    const filePrivate = await uploadImage(cookie, 20);

    // アップロード済み file_id を product.image に結線(公開/非公開の商品を作り分ける)。
    await createAsOwner(cookie, "product", {
      name: "公開画像商品",
      price: 500,
      stock: 3,
      image: filePublic,
      [PUBLIC_FIELD]: true,
    });
    await createAsOwner(cookie, "product", {
      name: "非公開画像商品",
      price: 600,
      stock: 2,
      image: filePrivate,
      [PUBLIC_FIELD]: false,
    });

    // 公開商品の画像は未認証 GET で 200・正しい Content-Type・実体一致。
    const pub = await app.request(new Request(`http://localhost${FILES}/${filePublic}`));
    expect(pub.status).toBe(200);
    expect(pub.headers.get("content-type")).toBe("image/png");
    expect(Array.from(new Uint8Array(await pub.arrayBuffer()))).toEqual(Array.from(pngBytes(10)));

    // 非公開商品の画像は未認証 GET で 404(存在秘匿)。
    const priv = await app.request(new Request(`http://localhost${FILES}/${filePrivate}`));
    expect(priv.status).toBe(404);
  });

  test("存在しない file_id を image フィールドに書くと拒否される(_files 実在確認)", async () => {
    const { cookie } = seedSession(dataRoot, APP_ID);
    const res = await request("POST", R("product"), {
      cookie,
      body: { name: "壊れ画像", price: 1, stock: 1, image: crypto.randomUUID() },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: { message: string }[] };
    expect(body.errors.some((e) => e.message.includes("_files"))).toBe(true);
  });
});

// ===========================================================================
// (e) 語彙ゼロ増(M7 は実証ゲート。カーネル語彙を1つも足さない)
// ===========================================================================

// ---------------------------------------------------------------------------
// 規則2(docs/plan/v3/records/v3-m1-gate-a-theme.md §10)による書き換え
//
// **旧い形**: `expect(DIFF_OPS.length).toBe(15)`。
// **なぜ書き換えたか**: この検査が主張しているのは「**この成果物が語彙を1つも
// 増やしていない**」ことなのに、見ていたのは「**現在の語彙総数**」だった。
// v3 は ADR-0047 で `DIFF_OPS` を 15 → 16 にする(門A 本審査 = 限定採用)ので、
// 数値を 16 に書き換えると **v2 の主張の担保がその瞬間に消える**(検査が
// 「現在16種である」しか言わなくなる)。
// **新しい形**: 「この成果物が使う op の名前の集合 ⊆ v2 完了時点の語彙集合(名前で
// 列挙)」。**(a) v3 が op を足しても赤くならず、(b) v2 の成果物が新語彙を使い始めたら
// 赤くなる。** v2 の主張はそのまま担保される(むしろ主張に一致する方向へ強くなる)。
// **`FIELD_TYPES`(8)と `RESOURCE_KINDS`(7)は本審査で1つも増えないので、数値固定を
// そのまま残す**(§10 の規則2 の末尾。書き換えるのは op の側だけである)。
// ---------------------------------------------------------------------------

/** v2 完了時点(CP-V2 通過)の差分操作語彙。**名前で列挙する**(現在の総数ではない)。 */
const DIFF_OPS_AT_V2_COMPLETION = [
  "add_table",
  "add_field",
  "add_view",
  "update_view",
  "remove_field",
  "remove_table",
  "change_table",
  "change_field",
  "remove_view",
  "add_workflow",
  "update_workflow",
  "remove_workflow",
  "add_function",
  "update_function",
  "remove_function",
] as const;

/**
 * 与えたソースに**実際に現れる**差分 op を集める(手書きの列挙ではない)。
 *
 * 現在の語彙(`DIFF_OPS`)と v2 完了時点の語彙の和集合に含まれる名前だけを拾うので、
 * バッチ書込の `op: "create"` / `"update"` / `"delete"`(ADR-0039。差分 op ではない)は
 * 混ざらない。**成果物が新しい op を使い始めたら、この集合に現れて下の包含が破れる。**
 */
function diffOpsUsedIn(paths: readonly string[]): string[] {
  const known = new Set<string>([...DIFF_OPS, ...DIFF_OPS_AT_V2_COMPLETION]);
  const found = new Set<string>();
  for (const path of paths) {
    for (const match of readFileSync(path, "utf-8").matchAll(/"?op"?:\s*"([a-z_]+)"/g)) {
      const op = match[1];
      if (op !== undefined && known.has(op)) {
        found.add(op);
      }
    }
  }
  return [...found].sort();
}

// 【`V5-M29-T05`】**describe 名を書き換えた。** 旧: 「(e) 語彙ゼロ増: FIELD_TYPES(8) /
//   RESOURCE_KINDS(7) / 参照 EC が使う diff op」。**中の test が消えて `FIELD_TYPES` /
//   `RESOURCE_KINDS` の本数を測るものが1つも無くなったのに、describe 名だけが本数を
//   主張する状態を残さないため(記録 §4-7)。****describe そのものは消していない**
//   (兄弟の test が2本残っている)。
describe("(e) 語彙ゼロ増: 参照 EC が使う diff op", () => {
  // 【`V5-M29-T05` / `ADR-0250` 限定10 + 限定11】ここにあった test を、ブロックごと消した。
  //   消したテスト名(逐語): 「既存語彙の要素数が不変(参照 EC は新語彙を1つも要求しない)」
  //   そのブロックが測っていたもの:
  //     - `expect(FIELD_TYPES.length).toBe(9)`(主張の逐語は describe 名の「(e) 語彙ゼロ増: FIELD_TYPES(8)」)
  //     - `expect(RESOURCE_KINDS.length).toBe(7)`(主張の逐語は describe 名の「(e) 語彙ゼロ増: … RESOURCE_KINDS(7)」)
  //   移し先は `scripts/vocabulary-drift.test.ts`(一覧の `FIELD_TYPES:` / `RESOURCE_KINDS:` で始まる行)。
  //   **`expect()` が1つも残らないので空の test を残さなかった**(空の test は緑を返し、
  //   検出力0のまま `Ran` を水増しする)。
  //   **テスト名が持っていた日本語の宣言は、ここでリポジトリから消える**(`ADR-0250` §Decision 5 の (4))。

  test("参照 EC の構築が使う diff op の集合は空である(規則2。空だから省略しない)", () => {
    // **参照 EC のマニフェストは `manifest.ts` が直に組み立て、`applyManifest` で
    // 投入する** —— 差分 op を1つも経由しない。**空集合であることを明示的に固定する**
    // (§10 の規則2)。参照 EC がある日 diff op を使い始めたら、この期待値が赤くなる。
    const used = diffOpsUsedIn([
      join(import.meta.dir, "manifest.ts"),
      join(import.meta.dir, "functions.ts"),
      join(import.meta.dir, "manifest.test.ts"),
    ]);
    expect(used).toEqual([]);
    for (const op of used) {
      expect(DIFF_OPS_AT_V2_COMPLETION as readonly string[]).toContain(op);
    }
    expect(DIFF_OPS_AT_V2_COMPLETION).toHaveLength(15);
  });
});

// ===========================================================================
// (f) 運営可視宣言(D-G13 / st_admin_readable)—— V3-M11-T01
//
// **【2026-08-10 追記(`V8-M20`。台帳 `J-G30`。ユーザ決定 `D-V8-35`。手続きは `ADR-0301`)。
// 下の「予約規約フィールド `st_admin_readable`」は今日は存在しない。1バイトも消していない】**
//
// **開いているものは同じで、開けているものが違う。** **今日、運営(owner)が購入者の注文を
// 読めるのは、`scripts/ref-ec/manifest.ts` の `app.roles` に書かれた
// `{ target: "table", table: "order", can: ["read", ...] }` による**(判定は
// `roleReadCrossesOwnerScope`)。**測っている現象((f-1)〜(f-5))は1ミリも変えていない。**
//
// **【`D-V8-35` の代償を、この節でも書いておく】** **旧層は `owner` に固定されていたが、
// 面の規則は誰にでも書ける** —— **「この表を読める」と書いた役割は誰であっても全員分が
// 見える。** **(f-5) が測っている `customer` の分離は、`customer` の規則に条件(`when`)が
// 書かれているから保たれているのであって、既定で保たれているのではない。**
//
// **測るもの**: ADR-0061(V3-M8)が用意した受け皿(予約規約フィールド `st_admin_readable`)を
// 参照 EC に**初めて当てた**とき、運営(owner)が購入者の注文を読めるようになるか。
//
// **開くのは読取2経路 × owner ロールだけである**(ADR-0061 限定1 / 限定2)。したがって本節は
//   (f-1) 一覧 `GET .../records` で他人の行が返ること
//   (f-2) 単件 `GET .../records/:id` で他人の行が返ること
//   (f-3) **同じセッションの `PATCH` は通らないこと**(見えても書けない)
//   (f-4) **宣言していないテーブル(cart)は owner でも1件も開かないこと**(自動で開かない)
//   (f-5) **顧客ロールの分離が1ミリも壊れていないこと**
// の5つを、本物の HTTP(createServerApp)+ 本物の SQLite で固定する。SQLite 直読みで
// 代替しない —— 測りたいのはサーバ層の判定であって行の中身ではない。
//
// **ここで固定できるのは「読取」だけである。** 投影テーブル(order_admin / order_line_admin)を
// 外せたかどうかは、この参照 EC(scripts/ref-ec/)では測れない —— 参照 EC はそれらを1つも
// 持たないからである(V3-M11-T00 §1-1 の実測: 全走査0件)。測るのは V3-M11-T04 である。
// ===========================================================================

describe("(f) 運営可視宣言(D-G13 / st_admin_readable): owner の読取だけが開く", () => {
  /** 顧客セッションで order を1件作り、その _id を返す。 */
  async function createOrderAsCustomer(cookie: string, orderNumber: string): Promise<string> {
    const res = await request("POST", R("order"), {
      cookie,
      body: { order_number: orderNumber, status: "pending_payment", total: 1000 },
    });
    expect(res.status, `create order ${orderNumber}: ${await res.clone().text()}`).toBe(201);
    return ((await res.json()) as { record: { _id: string } }).record._id;
  }

  /** 顧客2人がそれぞれ注文を1件持つ状態を作り、cookie / id / username を返す。 */
  async function twoCustomersWithOrders() {
    const u1 = `cust-f1-${Math.random().toString(36).slice(2)}`;
    const u2 = `cust-f2-${Math.random().toString(36).slice(2)}`;
    const c1 = await signupCustomer(u1);
    const c2 = await signupCustomer(u2);
    const o1 = await createOrderAsCustomer(c1, "EC-F-0001");
    const o2 = await createOrderAsCustomer(c2, "EC-F-0002");
    return { c1, c2, o1, o2, u1, u2 };
  }

  // **【`V8-M20` / `J-G30` / `ADR-0301`。検査は消していない。当て先を面へ移した】**
  // **旧テスト名の逐語**: 「(f-0) order には st_admin_readable(boolean・非required)が
  // 宣言され、他テーブルには無い」。
  // **旧本体の逐語**:
  // ```
  //   const declared = tables
  //     .filter((t) => t.fields.some((f) => f.id === ADMIN_READABLE_FIELD))
  //     .map((t) => t.id);
  //   expect(declared).toEqual(["order"]);
  //   const field = tables.find((t) => t.id === "order")
  //     ?.fields.find((f) => f.id === ADMIN_READABLE_FIELD);
  //   expect(field?.type).toBe("boolean");
  //   expect(field?.required).toBeUndefined();
  // ```
  // **問いは1ミリも変えていない**(「運営に読取を開いている表は `order` 1本だけか」)。
  // **読む場所が「表に予約規約フィールドが在るか」から「面の規則がその表を読取で名指しして
  // いるか」へ移った。** **形の検査(boolean・非 required)に相当するものは面には無い**
  // —— **面の規則には行の値が1つも無いからである。代わりに `can` の中身を固定する。**
  // **【2026-08-10(`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-58` / `D-V8-65`)。期待値を
  // 反転させた。旧の本体を逐語で残す】**
  //
  // **旧テスト名の逐語**: 「(f-0) 面が読取を開いているのは order 1本だけで、他テーブルには
  // 1本も無い」。
  // **旧本体の逐語**:
  // ```
  //   const declared = tables
  //     .filter((t) => roleReadCrossesOwnerScope({ manifest, roles: "owner", table: t.id }))
  //     .map((t) => t.id);
  //   expect(declared).toEqual(["order"]);
  //   const ownerRules = (manifest.app.roles ?? []).find((role) => role.id === "owner")?.rules ?? [];
  //   expect(ownerRules.filter((rule) => rule.target === "table").map((rule) => rule.table)).toEqual([
  //     "order",
  //   ]);
  //   expect(
  //     ownerRules.find((rule) => rule.target === "table" && rule.table === "order")?.can,
  //   ).toEqual(["read", "write", "delete"]);
  // ```
  //
  // **反転させた理由**: **`V8-M26` が既定を「閉じる」側へ倒したので、規則を1本も書いていない
  // 表・画面・ボタンは誰にも触れなくなった。** **参照 EC が店として成り立つには、運営が
  // 商品・カテゴリ・マスタ・注文まわりを読み書きできる規則を全部書き下すしかない** ——
  // **したがって「運営の表の規則は `order` 1本だけ」は今日は成り立たない。**
  //
  // **問いは1ミリも変えていない**(「運営に読取が開いているのはどの表か」)。**変わったのは
  // 答えの粒度である** —— **個人所有(`st_owner`)の表のうち運営に開いているのは何本か、を
  // 数える形に書き直した。** **`order` に加えて `order_action`(取り消しの申し込み)が
  // 2本目である** —— **運営が申し込みを受け付ける画面(`order-action-list`)を開けている
  // 以上、読めなければその画面が常に空になるからである。**
  // **【禁止の履行】これを「運営の可視範囲は変わっていない」と書かない** ——
  // **`order_action` は着手前、運営から0行だった。**
  test("(f-0) 面が個人所有の表について運営に読取を開いているのは order と order_action の2本である", () => {
    const manifest = referenceEcManifest();
    const tables = manifest.app.tables;
    const declared = tables
      .filter((t) =>
        // **`roleReadCrossesOwnerScope` を `owner` で当てる** —— **述語を再実装しない**
        // (規約の綴りを2箇所に書かない。`ADR-0033` §Consequences)。
        roleReadCrossesOwnerScope({ manifest, roles: "owner", table: t.id }),
      )
      // **個人所有の表(`st_owner` を持つ表)だけに絞る** —— **述語は「その役割が読める表か」
      // しか答えないので、`st_owner` を持たない表(商品・マスタ・履歴)も真になる。**
      // **`st_owner` を持たない表では「個人スコープを越える」という現象がそもそも起きない。**
      .filter((t) => t.fields.some((f) => f.id === OWNER_FIELD))
      .map((t) => t.id);
    expect(declared).toEqual(["order", "order_action"]);
    // **規則の中身も逐語で固定する** —— **`read` が入っていることがこの節の前提である。**
    const ownerRules = (manifest.app.roles ?? []).find((role) => role.id === "owner")?.rules ?? [];
    expect(
      ownerRules.find((rule) => rule.target === "table" && rule.table === "order")?.can,
    ).toEqual(["read", "write", "delete"]);
    expect(
      ownerRules.find((rule) => rule.target === "table" && rule.table === "order_action")?.can,
    ).toEqual(["read", "write"]);
    // **個人所有の表のうち、運営に1本も規則を書いていないもの** ——
    // **買い物かご・住所・顧客名簿・注文明細は今日も運営から0行である。**
    const closedForOwner = tables
      .filter((t) => t.fields.some((f) => f.id === OWNER_FIELD))
      .filter((t) => !ownerRules.some((rule) => rule.target === "table" && rule.table === t.id))
      .map((t) => t.id);
    expect(closedForOwner.sort()).toEqual(
      ["address", "cart", "cart_line", "customer", "order_line"].sort(),
    );
  });

  test("(f-1) owner は他人(顧客)の注文行を一覧で読める(本物の HTTP)", async () => {
    const { u1, u2 } = await twoCustomersWithOrders();
    const { cookie: owner } = seedSession(dataRoot, APP_ID);

    const res = await request("GET", R("order"), { cookie: owner });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      records: Record<string, unknown>[];
      total: number;
    };
    // owner 自身は注文を1件も持たない。返る2件はどちらも**他人の行**である。
    expect(body.records.map((r) => r.order_number).sort()).toEqual(["EC-F-0001", "EC-F-0002"]);
    expect(body.total).toBe(2);
    // ADR-0016 §6 / ADR-0061 限定7: 生の user id ではなく表示名(= username)に解決して返す。
    expect(body.records.map((r) => r[OWNER_FIELD]).sort()).toEqual([u1, u2].sort());
  });

  test("(f-2) owner は他人の注文行を単件でも読める(GET .../records/:record_id)", async () => {
    const { o1, u1 } = await twoCustomersWithOrders();
    const { cookie: owner } = seedSession(dataRoot, APP_ID);

    const res = await request("GET", R("order", o1), { cookie: owner });
    expect(res.status).toBe(200);
    const { record } = (await res.json()) as { record: Record<string, unknown> };
    expect(record.order_number).toBe("EC-F-0001");
    expect(record[OWNER_FIELD]).toBe(u1);
    // 単件は ETag(= 現在の版)を返す —— これが (f-3) の入力になる。
    expect(res.headers.get("etag")).toBeTruthy();
  });

  test("(f-3) 読めても書けない: 同じ owner セッションの PATCH は 404 で、行は1バイトも動かない", async () => {
    const { o1 } = await twoCustomersWithOrders();
    const { cookie: owner } = seedSession(dataRoot, APP_ID);

    // 開いた読取経路から**正しい版(ETag)を手に入れたうえで**書きに行く。
    // つまり「If-Match が無いから弾かれた」ではないことを構造で示す。
    const read = await request("GET", R("order", o1), { cookie: owner });
    expect(read.status).toBe(200);
    const etag = read.headers.get("etag");
    expect(etag).toBeTruthy();

    const patch = await app.request(
      new Request(`http://localhost${R("order", o1)}`, {
        method: "PATCH",
        headers: {
          cookie: owner,
          origin: TEST_ORIGIN,
          "content-type": "application/json",
          "if-match": etag ?? "",
        },
        body: JSON.stringify({ status: "cancelled" }),
      }),
    );
    // ADR-0061 限定1: 開いたのは読取2経路だけ。書込経路は `adminReadsAllRows` を渡さないので
    // 他人の行は「存在しない」ままで 404 になる(403 ではない —— 存在を伏せる側に倒す)。
    expect(patch.status, await patch.clone().text()).toBe(404);

    // 状態が動いていないことを、開いた読取経路でもう一度確かめる。
    const after = await request("GET", R("order", o1), { cookie: owner });
    expect(((await after.json()) as { record: { status: string } }).record.status).toBe(
      "pending_payment",
    );
  });

  test("(f-4) 宣言していないテーブル(cart)は owner でも他人の行を1件も返さない(自動で開かない)", async () => {
    const c1 = await signupCustomer(`cust-f4-${Math.random().toString(36).slice(2)}`);
    expect(
      (await request("POST", R("cart"), { cookie: c1, body: { status: "open" } })).status,
    ).toBe(201);

    const { cookie: owner } = seedSession(dataRoot, APP_ID);
    const res = await request("GET", R("cart"), { cookie: owner });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: unknown[]; total: number };
    // ADR-0061 限定3: 宣言はテーブル単位で、宣言していないテーブルは owner にも開かない。
    // **order を宣言したことが cart に波及していないこと**がここの主張である。
    expect(body.records).toHaveLength(0);
    expect(body.total).toBe(0);
  });

  test("(f-5) 顧客ロールの分離は1ミリも壊れない(他人の注文は一覧に出ず、単件は 404)", async () => {
    const { c1, c2, o1, o2 } = await twoCustomersWithOrders();

    for (const [cookie, own, other] of [
      [c1, "EC-F-0001", o2],
      [c2, "EC-F-0002", o1],
    ] as const) {
      const list = await request("GET", R("order"), { cookie });
      expect(list.status).toBe(200);
      const body = (await list.json()) as { records: { order_number: string }[]; total: number };
      // ADR-0061 限定2: customer ロールには1ミリも効かない。自分の1件だけ。
      expect(body.records.map((r) => r.order_number)).toEqual([own]);
      expect(body.total).toBe(1);
      // 他人の行は「存在しない」(404。403 だと存在が漏れる)。
      expect((await request("GET", R("order", other), { cookie })).status).toBe(404);
    }
    // 参考: o1 は c1 のもの。自分の単件は読める(分離が「全部見えない」に倒れていない)。
    expect((await request("GET", R("order", o1), { cookie: c1 })).status).toBe(200);
  });
});

// ===========================================================================
// (g) 滞留注文の打ち切り(D-G16a `trigger.table` / D-G16b `older_than`)—— V3-M11-T03
//
// **ADR-0063 / ADR-0064(V3-M10)が用意した宣言を、参照 EC に初めて当てる。**
// V3-M10 は `D-M10-3` により `scripts/ref-ec/` を1バイトも使わなかった(実証はテスト用
// マニフェストだけで行われた)。ここが実地の初例である。
//
// **測るのは「注文されてから3日経った未払いの注文が、毎日1回の発火で打ち切られるか」であって、
// 「3日間 pending_payment のままだったか」ではない**(ADR-0064 §限界1。(g-4) が実測する)。
// ===========================================================================

describe("(g) 滞留注文の打ち切り(D-G16a / D-G16b を参照 EC に初めて当てる)", () => {
  /** 判断1 の既定 TZ。「今日」の境界もこれで決まる(ADR-0013 §6c)。 */
  const TZ = "Asia/Tokyo";
  const SWEEP_ID = "wf-stale-order-sweep";
  /**
   * 上限(1000 行)に触る3本だけに与える明示のタイムアウト。
   *
   * **bun:test の既定は 5000ms であり、1000 行の投入 + 発火はそれに近い**
   * (実測: このマシンで 5.1〜5.3 秒。負荷次第で既定を跨ぐ)。**時間を検査している
   * わけではない** —— 閾値をアサーションに書くと実行環境で揺れるので、書いたのは
   * 「落ちないための上限」だけである。先例は `web/test/list-render-bench.test.tsx:200`。
   */
  const HEAVY_ROW_TEST_TIMEOUT_MS = 120000;

  afterEach(() => {
    // **時刻源を必ず戻す。**戻さないと後続の describe が固定された時刻を見る。
    resetWorkflowClock();
  });

  function withAppDb<T>(fn: (db: Database) => T): T {
    const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  function rowsOf(table: string): RecordRow[] {
    return withAppDb((db) => {
      const result = listRecords(db, referenceEcManifest(), table, {});
      if (!result.ok) {
        throw new Error(`${table} を読めませんでした: ${JSON.stringify(result.errors)}`);
      }
      return result.value;
    });
  }

  /**
   * **【2026-08-10(`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-58` / `D-V8-65`)。
   * 投入する行に持ち主を付けた。期待値は1つも動かしていない】**
   *
   * **既定が「閉じる」側へ倒れたので、注文の作成で発火するワークフロー
   * (`wf-order-checkout` / `wf-order-audit`)の**書き手**が、面の判定に掛かるようになった。**
   * **書き手は「`act_as` が無ければトリガー元の行の持ち主」である**
   * (`resolveWorkflowActor`)—— **`st_owner` を書かずに入れた注文は書き手が
   * 「特定できない」になり、未ログインと同じ主体として評価されて、集計と監査への書込が
   * 1件も通らない**(= 注文そのものが作れない)。
   *
   * **本物の EC では、注文には必ず持ち主が居る** —— **その前提を、この投入にも与える。**
   * **打ち切りの判定(`older_than` / `when`)は `st_owner` を1バイトも見ないので、
   * (g) 群が測っているものは1ミリも変わらない。**
   */
  function seedOrder(fields: Record<string, unknown>): string {
    const buyerId = stableBuyer().userId;
    return withAppDb((db) => {
      const created = createRecord(db, referenceEcManifest(), "order", {
        [OWNER_FIELD]: buyerId,
        ...fields,
      });
      if (!created.ok) {
        throw new Error(`注文の投入に失敗しました: ${JSON.stringify(created.errors)}`);
      }
      return String(created.value._id);
    });
  }

  /** 行を直接書き換える(ワークフローは走らない)。(g-4) が「まま」の不在を作るのに使う。 */
  function pokeOrder(id: string, fields: Record<string, unknown>): void {
    withAppDb((db) => {
      const updated = updateRecord(db, referenceEcManifest(), "order", id, fields);
      if (!updated.ok) {
        throw new Error(`注文の更新に失敗しました: ${JSON.stringify(updated.errors)}`);
      }
    });
  }

  function setNow(iso: string): void {
    setWorkflowClock({ now: () => new Date(iso) });
  }

  function tick(): void {
    runSchedulerTick({ dataRoot, timeZone: TZ });
  }

  /** 注文番号 → 状態 の対応表(打ち切りの結果を1つの値で見る)。 */
  function statusByNumber(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const row of rowsOf("order")) {
      out[String(row.order_number)] = String(row.status);
    }
    return out;
  }

  /** `wf_runs` のうち滞留掃除の行だけ。 */
  function sweepRuns(): RecordRow[] {
    return rowsOf("wf_runs").filter((row) => row.workflow === SWEEP_ID);
  }

  test("(g-1) 宣言の形: schedule + table=order + older_than={placed_at, 3日}・アクションは1本", () => {
    const m = referenceEcManifest().app;
    const wfs = m.workflows ?? [];
    const sweep = wfs.find((w) => w.id === SWEEP_ID);
    expect(sweep, `${SWEEP_ID} が宣言されていない`).toBeDefined();
    if (sweep === undefined) {
      throw new Error("unreachable");
    }

    // D-G16a(ADR-0063): schedule に table を書いて行を列挙する。
    const trigger = sweep.trigger;
    expect(trigger.type).toBe("schedule");
    if (trigger.type !== "schedule") {
      throw new Error("unreachable");
    }
    expect(trigger.table).toBe("order");
    // D-G16b(ADR-0064): 経過時間の述語。**予約列(_created_at / _updated_at)を指さない**
    // —— 指すと ADR-0064 再審査条件 (e) が発火し門A が要る(V3-M11-T00 §3-4)。
    expect(trigger.older_than).toEqual({ field: "placed_at", days: 3 });
    expect(String(trigger.older_than?.field).startsWith("_")).toBe(false);

    // **打ち切りが走るのは毎日1回である**($defs/schedule_at は hour / minute の2キーのまま)。
    expect(Object.keys(trigger.at).sort()).toEqual(["hour", "minute"]);

    // 指し先の `placed_at` が `order` に `date` 型で実在する(ADR-0064 限定1)。
    const order = m.tables.find((t) => t.id === "order");
    expect(order?.fields.find((f) => f.id === "placed_at")?.type).toBe("date");

    // アクションは1本だけ(V3-M11-T00 §3-3 の (f) の推奨 = 全アクションが同じ行集合を見る形)。
    expect(sweep.actions).toHaveLength(1);
    expect(sweep.actions[0]).toEqual({
      action: "update_record",
      table: "order",
      target: "$record._id",
      values: { status: "cancelled" },
      when: { field: "status", equals: "pending_payment" },
    });
    expect(sweep.history_table).toBe("wf_runs");
  });

  test("(g-1b) 既存の wf-totals-sweep を1バイトも書き換えていない(足したのであって差し替えていない)", () => {
    const wfs = referenceEcManifest().app.workflows ?? [];
    const totals = wfs.find((w) => w.id === "wf-totals-sweep");
    expect(totals).toEqual({
      id: "wf-totals-sweep",
      name: "カート合計の定時再集計",
      trigger: { type: "schedule", at: { hour: 3, minute: 0 } },
      actions: [
        { action: "run_function", function: "fn-cart-totals", output_table: "cart_totals" },
      ],
      history_table: "wf_runs",
    });
    // 行を1件も列挙しない schedule は今日どおり在る(非退行)。
    // **trigger のキーは `type` / `at` の2つだけである**(table も older_than も無い)。
    expect(Object.keys(totals?.trigger ?? {}).sort()).toEqual(["at", "type"]);
    // ワークフローは6本 → 7本 → 8本(V4-M4-T07 が `wf-order-cancel-request` を足した)
    // → **9本**(V4-M21-T01 が `wf-cart-line-dedupe` を足した)。
    // **足したのであって書き換えていない** —— 上の `toEqual` が `wf-totals-sweep` の全体を
    // 1バイト単位で押さえている。
    // → **11本**(`V5-M18` が `wf-cart-close` / `wf-product-archive` の2本を足した。
    // どちらも `trigger.type: "manual"`)。**当時 `9` → 今日 `11`。上の行を書き換えていない。**
    expect(wfs).toHaveLength(11);
  });

  test("(g-2) 3日以上前の未払い注文だけが打ち切られ、対象外は1件も触られない", () => {
    seedOrder({
      order_number: "G-old-pending",
      status: "pending_payment",
      placed_at: "2026-07-16",
    });
    seedOrder({
      order_number: "G-new-pending",
      status: "pending_payment",
      placed_at: "2026-07-19",
    });
    seedOrder({ order_number: "G-old-paid", status: "paid", placed_at: "2026-07-16" });
    seedOrder({ order_number: "G-old-shipped", status: "shipped", placed_at: "2026-07-16" });
    // 注文日時が空の行(判定できない行)は対象にしない(fail-closed)。
    seedOrder({ order_number: "G-no-date", status: "pending_payment" });

    setNow("2026-07-20T09:00:00+09:00");
    tick();

    expect(statusByNumber()).toEqual({
      "G-old-pending": "cancelled",
      "G-new-pending": "pending_payment",
      "G-old-paid": "paid",
      "G-old-shipped": "shipped",
      "G-no-date": "pending_payment",
    });

    const runs = sweepRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("success");
  });

  test("(g-3) older_than で落ちた行は履歴に1文字も現れない(when で落ちた行はスキップとして残る)", () => {
    const oldPending = seedOrder({
      order_number: "G3-old-pending",
      status: "pending_payment",
      placed_at: "2026-07-16",
    });
    const oldPaid = seedOrder({
      order_number: "G3-old-paid",
      status: "paid",
      placed_at: "2026-07-16",
    });
    const newPending = seedOrder({
      order_number: "G3-new-pending",
      status: "pending_payment",
      placed_at: "2026-07-19",
    });

    setNow("2026-07-20T09:00:00+09:00");
    tick();

    const error = String(sweepRuns()[0]?.error ?? "");
    // `when` で落ちた行は loud に残る。
    expect(error).toContain("スキップ");
    expect(error).toContain(oldPaid);
    // **`older_than` で落ちた行は履歴に1文字も現れない**(そもそも対象にならない)。
    expect(error).not.toContain(newPending);
    // 打ち切った行も履歴には現れない(成功は行を名指ししない)。
    expect(error).not.toContain(oldPending);
  });

  test("(g-4) 「3日間 pending_payment のまま」ではない: 昨日 pending に戻った古い注文も打ち切られる", () => {
    // 10日前に注文され、ずっと paid だった行を、発火の直前に pending_payment へ戻す。
    // **pending_payment でいた時間は0日である**が、`placed_at` からは10日経っている。
    const revived = seedOrder({
      order_number: "G4-revived",
      status: "paid",
      placed_at: "2026-07-10",
    });
    pokeOrder(revived, { status: "pending_payment" });

    setNow("2026-07-20T09:00:00+09:00");
    tick();

    // **打ち切られる。**測っているのは `placed_at` からの経過であって、
    // 状態が変わってからの経過ではない(ADR-0064 §限界1)。
    expect(statusByNumber()["G4-revived"]).toBe("cancelled");
  });

  test(
    "(g-5) 上限: 1001 行は1件も処理せず打ち切られ、履歴に失敗として残る",
    () => {
      for (let i = 0; i < 1001; i++) {
        seedOrder({
          order_number: `G5-${String(i).padStart(4, "0")}`,
          status: "pending_payment",
          placed_at: "2026-07-16",
        });
      }

      setNow("2026-07-20T09:00:00+09:00");
      tick();

      const runs = sweepRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe("failure");
      expect(String(runs[0]?.error)).toContain("1000");
      // **1件も処理していない**(部分適用しない)。
      expect(rowsOf("order").filter((r) => r.status === "cancelled")).toHaveLength(0);
      // 1001 行の投入だけで数秒かかるので、既定の 5000ms では実行環境によって落ちる。
    },
    HEAVY_ROW_TEST_TIMEOUT_MS,
  );

  test(
    "(g-5b) 上限ちょうど(1000 行)は通り、1000 件すべてが打ち切られる(境界は「超えたら」)",
    () => {
      // **これが V3-M11-T03 が実行時間を測った形そのものである**(1000 行 × update_record 1本)。
      // **時間を検査しない** —— 時間の閾値をテストに書くと実行環境で揺れる。
      // 測った値は docs/plan/v3/records/v3-m11-t03.md §5 に書いた。
      for (let i = 0; i < 1000; i++) {
        seedOrder({
          order_number: `G5b-${String(i).padStart(4, "0")}`,
          status: "pending_payment",
          placed_at: "2026-07-16",
        });
      }

      setNow("2026-07-20T09:00:00+09:00");
      tick();

      const runs = sweepRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe("success");
      expect(rowsOf("order").filter((r) => r.status === "cancelled")).toHaveLength(1000);
    },
    HEAVY_ROW_TEST_TIMEOUT_MS,
  );

  test(
    "(g-6) ADR-0063 §限界1: 打ち切られた発火はその日のうちに再試行されない",
    () => {
      for (let i = 0; i < 1001; i++) {
        seedOrder({
          order_number: `G6-${String(i).padStart(4, "0")}`,
          status: "pending_payment",
          placed_at: "2026-07-16",
        });
      }

      setNow("2026-07-20T09:00:00+09:00");
      tick();
      setNow("2026-07-20T23:59:00+09:00");
      tick();

      // 履歴は1行のまま = 同じ日には二度と走らない(firedOn は status を見ない)。
      expect(sweepRuns()).toHaveLength(1);
      expect(rowsOf("order").filter((r) => r.status === "cancelled")).toHaveLength(0);
    },
    HEAVY_ROW_TEST_TIMEOUT_MS,
  );

  test("(g-7) 打ち切っても在庫は1も戻らない(D-G15 は実装0バイトのままである)", () => {
    const { cookie } = seedSession(dataRoot, APP_ID);
    // 商品を1件作り、在庫を「予約で減った後」の値にしておく。
    const before = withAppDb((db) => {
      const created = createRecord(db, referenceEcManifest(), "product", {
        name: "在庫つき商品",
        price: 1000,
        stock: 3,
      });
      if (!created.ok) {
        throw new Error(JSON.stringify(created.errors));
      }
      return created.value;
    });
    expect(cookie).toBeTruthy();

    const orderId = seedOrder({
      order_number: "G7-stale",
      status: "pending_payment",
      placed_at: "2026-07-16",
    });
    withAppDb((db) => {
      const line = createRecord(db, referenceEcManifest(), "order_line", {
        order: orderId,
        product: String(before._id),
        quantity: 2,
        unit_price: 1000,
      });
      if (!line.ok) {
        throw new Error(JSON.stringify(line.errors));
      }
    });

    setNow("2026-07-20T09:00:00+09:00");
    tick();

    expect(statusByNumber()["G7-stale"]).toBe("cancelled");
    // **在庫は1も戻らない。**打ち切りは status を1つ書き換えるだけである。
    const after = rowsOf("product").find((p) => p._id === before._id);
    expect(after?.stock).toBe(3);
    // 明細も1行も消えない(打ち切りは行を1件も削除しない)。
    expect(rowsOf("order_line")).toHaveLength(1);
  });

  test("(g-8) 走るのは毎日1回である: 同じ日に何度 tick しても打ち切りは1回きり", () => {
    seedOrder({ order_number: "G8-a", status: "pending_payment", placed_at: "2026-07-16" });

    setNow("2026-07-20T04:00:00+09:00");
    tick();
    setNow("2026-07-20T12:00:00+09:00");
    tick();
    setNow("2026-07-20T23:00:00+09:00");
    tick();

    expect(sweepRuns()).toHaveLength(1);

    // 翌日は改めて1回走る(遅れの回収ではなく「今日発火したか」だけを見る)。
    seedOrder({ order_number: "G8-b", status: "pending_payment", placed_at: "2026-07-17" });
    setNow("2026-07-21T04:00:00+09:00");
    tick();
    expect(sweepRuns()).toHaveLength(2);
    expect(statusByNumber()["G8-b"]).toBe("cancelled");
  });

  test("(g-9) 打ち切りは on_update の連鎖を行ごとに誘発し、連鎖の失敗は掃除の履歴に現れない", () => {
    // 参照 EC は order の on_update に `wf-order-enrich`(ai_transform)を持つ。
    // 打ち切りが status を書き換えると、**打ち切った行1件につき1本**その連鎖が走る。
    for (const n of ["G9-1", "G9-2", "G9-3"]) {
      seedOrder({ order_number: n, status: "pending_payment", placed_at: "2026-07-16" });
    }

    setNow("2026-07-20T09:00:00+09:00");
    tick();

    const enrich = rowsOf("wf_runs").filter((r) => r.workflow === "wf-order-enrich");
    // **行ごとに1本** —— 3行を打ち切れば3本である(1回の発火で1本ではない)。
    expect(enrich).toHaveLength(3);
    // 【V3-M13-T02 / ADR-0066 による期待値の更新】以前はここが3本とも `failure` だった
    // (ai capability が発行されていなかったため)。**決定が変わり、on_update の連鎖が
    // 失敗すると打ち切りの `update_record` 自体が成立しなくなった**ので、
    // 「打ち切りが起きて、かつ連鎖が失敗している」状態はもう作れない。
    // beforeEach が capability を発行するようになり、3本とも成功する。
    expect(enrich.map((r) => r.status)).toEqual(["success", "success", "success"]);

    // **それでも掃除そのものの履歴は success である。**連鎖の失敗は別の行に残り、
    // 掃除の履歴を1文字も汚さない —— 「打ち切りは成功したか」と
    // 「打ち切りが誘発したものが成功したか」は、履歴の別の行に分かれている。
    const runs = sweepRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("success");
    expect(String(runs[0]?.error ?? "")).not.toContain("capability");
  });
});

// ===========================================================================
// (h) 宣言の連鎖の検出(V3-M12-T07)—— 「運営画面が警告なしで0件になる」を機械で見つける
//
// **【2026-08-10 追記(`V8-M20`。台帳 `J-G30`。`ADR-0301`)。下の「`st_admin_readable` の
// 宣言」は今日は存在しない。1バイトも消していない】**
//
// **検出している現象は1ミリも変わっていない** —— **「運営が読める表から `reference` で
// 1ホップつながる先が、運営には静かに0件になる」。** **`D` の作り方だけが
// 「表に `st_admin_readable` が在るか」から「面の規則がその表の読取を開いているか」
// (`roleReadCrossesOwnerScope`)へ移った。** **(h-3) の期待値は4件のままである** ——
// **参照 EC で読取が開いている表は今日も `order` 1本だけだからである。**
//
// **【面へ移って新しく増えた危うさ。隠さない】** **旧層は `owner` に固定されていたので、
// この検出は常に「運営から見た欠け」だった。** **面の規則は誰にでも書けるので、
// `roles` に `customer` の読取を書いた表があれば、同じ検出が「購入者から見た欠け」も
// 混ぜて出す。** **下の実装は `owner` を明示して当てており、そこは旧と同じ範囲に留めている。**
//
// **測るもの**: `st_admin_readable` の宣言はテーブル単位である(ADR-0061 限定3)。宣言済み
// テーブルから `reference` で1ホップつながる先が `st_owner` を持ちながら未宣言だと、
// **運営から見てその画面だけが静かに0件になる** —— カーネルは `applyManifest` も `apply_diff`
// も緑のままで、警告を1件も出さない(`v3-m11-t10.md` §9-1 の 1)。ここではそれを
// **マニフェストだけから導ける形**に落として検出する。
//
// **導出規則**(下の `adminReadableChainWarnings` が実装するもの。記録 `v3-m12-t07.md` §3):
//   D = 宣言済み集合   = { t | adminReadableField(t) !== undefined }
//                        **【`V8-M20`】今日は { t | roleReadCrossesOwnerScope(owner, t) }**
//   P = 個人スコープ集合 = { t | personalOwnerField(t) !== undefined }
//   各 reference フィールド `C.f -> U` について
//     - **outgoing**: C ∈ D かつ U ∈ P かつ U ∉ D  → U が欠けている
//     - **incoming**: U ∈ D かつ C ∈ P かつ C ∉ D  → C が欠けている
//   ({table, reference} の辞書順で安定に並べる)
//
// **判定関数は再実装しない** —— サーバ層の `roleReadCrossesOwnerScope`(旧
// `adminReadableField`)/ `personalOwnerField` をそのまま呼ぶ。規約の綴りを2箇所に書くと、
// 片方だけ直されて食い違う(ADR-0033 §Consequences)。
//
// **これは警告であって拒否ではない**(V3-M12-T07 完了条件5)。理由は実測である ——
// **今日の参照 EC 自身が2件引っかかる**((h-3))。拒否にすれば参照 EC のマニフェストが
// 通らなくなる。**引っかかった2件は本タスクでは直さない**(`v3-m12.md` §2a-3 の (h) の裁定
// 「直さない(起票する)」)。したがって (h-3) は「0件であること」ではなく
// **「今日の2件から増えないこと」**を固定する。
//
// **この検出の限界(隠さない)**:
//   1. **「宣言が要るテーブル」の集合そのものは導けない。** マニフェストには「どの画面が
//      運営向けか」を書くキーが1つも無い(`src/mcp/vocabulary.ts` の `CANNOT_DO`
//      「画面を名指しして可視ロールを書くキーはマニフェストに1つもありません」)。導けるのは
//      **宣言済みの1本を起点にした連鎖の不整合**だけである。
//   2. **意図して宣言しない場合と、宣言し忘れた場合を区別できない**(だから拒否にしない)。
//   3. **1ホップだけを見る。** 2ホップ先(宣言済み → 未宣言 → 未宣言)は検出しない。
//   4. **【2026-08-03 / V4-M4-T07 で偽になった】** **かつて「参照 EC(A)には `order_action`
//      相当の操作テーブルが1本も無い」と書いていた**(`v3-m12-t06.md` §4-3 の 3)。
//      **`D-V4-23`(ユーザ決定「参照ショップに取り消しの申し込みを足してよい」)により、
//      `V4-M4-T07` が `order_action` を1本足した。** **したがってこの行は今日の正では
//      ない。** **v3 側の記録(`v3-m12-t06.md` など)は1バイトも書き換えていない** ——
//      当時の記述として正しいからである。
//      **変わらないこと**: **A に対する検出の件数は、B(実地インスタンス)の件数では
//      ない。**「A で0件だったから問題が無い」とは今日も読めない。**A に足した前提を
//      B の観測と合算してはならない**(`01:361` / `ADR-0073` §限界8)。
// ===========================================================================

/**
 * 宣言の連鎖が切れている箇所1件(V3-M12-T07)。
 *
 * `table` に `st_admin_readable` が無いために、`declared`(宣言済み)から `reference` で
 * 1ホップつながる先が運営から見えない、という指摘である。**「直せ」ではなく「見えなくなる」**
 * を言うだけなので、判断材料として `reference`(連鎖の実パス)と向きを必ず持たせる。
 */
type AdminReadableChainWarning = {
  /** 宣言が欠けている側のテーブルID。 */
  table: string;
  /** 連鎖の根拠になった reference フィールドの実パス(`<table>.<field>`)。 */
  reference: string;
  /** 連鎖の起点(`st_admin_readable` を宣言済みのテーブルID)。 */
  declared: string;
  /** `incoming` = 未宣言側が宣言済みを参照 / `outgoing` = 宣言済みが未宣言側を参照。 */
  direction: "incoming" | "outgoing";
};

/**
 * マニフェストから「運営画面が警告なしで0件になる」候補を導く(V3-M12-T07 完了条件2)。
 *
 * **導出できるのは連鎖の不整合だけである** —— 「宣言が要るテーブルの集合」そのものは
 * マニフェストから導けない(可視ロールを書くキーが1つも無い)。詳しくは上のブロックコメント。
 */
function adminReadableChainWarnings(manifest: Manifest): AdminReadableChainWarning[] {
  const tables = manifest.app.tables;
  const byId = new Map(tables.map((t) => [t.id, t]));
  // **規約の判定はサーバ層の関数をそのまま使う**(綴りを2箇所に書かない)。
  // **【`V8-M20`】旧の逐語**: `return t !== undefined && adminReadableField(t) !== undefined;`
  // **今日は面の規則を見る。** **`roles: "owner"` を明示するのは、旧層が `owner` に固定
  // されていたのと同じ範囲に留めるためである**(上のブロックコメントの「新しく増えた危うさ」)。
  const declared = (id: string): boolean => {
    const t = byId.get(id);
    return t !== undefined && roleReadCrossesOwnerScope({ manifest, roles: "owner", table: id });
  };
  const personal = (id: string): boolean => {
    const t = byId.get(id);
    return t !== undefined && personalOwnerField(t) !== undefined;
  };

  const warnings: AdminReadableChainWarning[] = [];
  for (const table of tables) {
    for (const field of table.fields) {
      if (field.type !== "reference") {
        continue;
      }
      const target = field.reference_table;
      if (byId.get(target) === undefined) {
        continue;
      }
      const reference = `${table.id}.${field.id}`;
      // outgoing: 宣言済み → 未宣言の個人テーブル(参照先が読めない = 表示名が解決できない)。
      if (declared(table.id) && personal(target) && !declared(target)) {
        warnings.push({ table: target, reference, declared: table.id, direction: "outgoing" });
      }
      // incoming: 未宣言の個人テーブル → 宣言済み(子一覧が静かに0件になる)。
      if (declared(target) && personal(table.id) && !declared(table.id)) {
        warnings.push({ table: table.id, reference, declared: target, direction: "incoming" });
      }
    }
  }
  // 出力順を実装の走査順に依存させない(テーブル定義の並べ替えで結果が動かないように)。
  return warnings.sort((a, b) =>
    a.table === b.table ? a.reference.localeCompare(b.reference) : a.table.localeCompare(b.table),
  );
}

describe("(h) 宣言の連鎖の検出(V3-M12-T07): 警告なしで0件になる形を機械で見つける", () => {
  /**
   * 検出用の最小マニフェストを組む(テーブルだけ。ビューは連鎖の判定に使わない)。
   *
   * **【`V8-M20` / `J-G30`】第2引数を足した。** **旧は引数1本で、「運営に開く」ことは
   * テーブルに `adminF`(= `st_admin_readable` の項目)を1本置くことで表していた。**
   * **今日それを表すのは `app.roles` の規則である**(項目ではないので、テーブルの外に書く)。
   * **既定の3役割は宣言から消せないので、規則を持たない `editor` / `viewer` も並べる。**
   */
  function manifestOf(tables: Table[], ownerReadable: readonly string[] = []): Manifest {
    return {
      app: {
        id: "chain-probe",
        name: "連鎖検査",
        tables,
        views: [],
        ...(ownerReadable.length === 0
          ? {}
          : {
              roles: [
                {
                  id: "owner",
                  name: "運営",
                  rules: [
                    // **【`V8-M28` / `T-G16a`】持ち主にはこの2行が必ず要る** ——
                    // **適用時検査(類型17 の拡張)が両方の実在を要求する。**
                    { target: "app" as const, can: ["write" as const] },
                    { target: "role" as const, can: ["write" as const] },
                    ...ownerReadable.map((table) => ({
                      target: "table" as const,
                      table,
                      can: ["read" as const],
                    })),
                  ],
                },
                { id: "editor", name: "編集者" },
                { id: "viewer", name: "閲覧者" },
              ],
            }),
      },
    };
  }

  const ownerF: Field = { id: OWNER_FIELD, name: "所有者", type: "text" };
  // **【`V8-M20`】旧の逐語**: `const adminF: Field = { id: ADMIN_READABLE_FIELD, name: "運営可視", type: "boolean" };`
  // **その項目は今日存在しない。** **「運営に開く」は `manifestOf` の第2引数で表す。**

  test("(h-0) 宣言が1本足りない状態を検出する(incoming: 未宣言の子が宣言済みの親を参照)", () => {
    const broken = manifestOf(
      [
        { id: "parent", name: "親", fields: [ownerF] },
        {
          id: "child",
          name: "子",
          fields: [
            ownerF,
            { id: "parent", name: "親", type: "reference", reference_table: "parent" },
          ],
        },
      ],
      // **旧は `parent` の `fields` に `adminF` を1本置いていた**(`[ownerF, adminF]`)。
      ["parent"],
    );
    expect(adminReadableChainWarnings(broken)).toEqual([
      { table: "child", reference: "child.parent", declared: "parent", direction: "incoming" },
    ]);

    // **宣言を1本足すと検出が消える** —— 検出しているのは宣言の有無そのものである。
    const fixed = manifestOf(
      [
        { id: "parent", name: "親", fields: [ownerF] },
        {
          id: "child",
          name: "子",
          fields: [
            ownerF,
            { id: "parent", name: "親", type: "reference", reference_table: "parent" },
          ],
        },
      ],
      // **旧は両方の `fields` に `adminF` を置いていた。**
      ["parent", "child"],
    );
    expect(adminReadableChainWarnings(fixed)).toEqual([]);
  });

  test("(h-1) 逆向き(outgoing: 宣言済みテーブルが未宣言の個人テーブルを参照)も検出する", () => {
    const m = manifestOf(
      [
        {
          id: "order",
          name: "注文",
          fields: [
            ownerF,
            { id: "customer", name: "顧客", type: "reference", reference_table: "customer" },
          ],
        },
        { id: "customer", name: "顧客", fields: [ownerF] },
      ],
      ["order"],
    );
    expect(adminReadableChainWarnings(m)).toEqual([
      { table: "customer", reference: "order.customer", declared: "order", direction: "outgoing" },
    ]);
  });

  test("(h-2) 誤検出0: 個人スコープでない表・連鎖の外の表・宣言が1本も無いアプリは出さない", () => {
    // (i) 参照先が `st_owner` を持たない(= 誰にでも見える共有マスタ)。
    const master = manifestOf(
      [
        {
          id: "order",
          name: "注文",
          fields: [
            ownerF,
            { id: "ship", name: "配送", type: "reference", reference_table: "shipping" },
          ],
        },
        { id: "shipping", name: "配送方法", fields: [{ id: "name", name: "名称", type: "text" }] },
      ],
      ["order"],
    );
    expect(adminReadableChainWarnings(master)).toEqual([]);

    // (ii) 個人テーブルだが、宣言済みテーブルと reference でつながっていない。
    const disconnected = manifestOf(
      [
        { id: "order", name: "注文", fields: [ownerF] },
        { id: "diary", name: "日記", fields: [ownerF] },
      ],
      ["order"],
    );
    expect(adminReadableChainWarnings(disconnected)).toEqual([]);

    // (iii) **宣言が1本も無いアプリは1件も出さない** —— 個人用途アプリ(日記・家計簿)を
    // 全部警告で埋めないため。起点が無いところに連鎖は無い(ADR-0061 §3 案(b) の却下理由)。
    const personal = manifestOf([
      { id: "diary", name: "日記", fields: [ownerF] },
      {
        id: "entry",
        name: "記事",
        fields: [
          ownerF,
          { id: "diary", name: "日記", type: "reference", reference_table: "diary" },
        ],
      },
    ]);
    expect(adminReadableChainWarnings(personal)).toEqual([]);
  });

  test("(h-3) 【既存の不備】今日の参照 EC は4件引っかかる —— 直さず、増えたぶんを名指しで書く", () => {
    // **これは「合格」ではない。**今日の状態をそのまま写した基準値である
    // (`v3-m12.md` §2a-3 の (h): 直さない・起票する)。新しい宣言漏れが1件でも入れば赤くなる。
    //
    // **【V4-M4-T07 で 2件 → 3件に増えた。減らしていない】** 足した `order_action`
    // (取り消しの申し込み。`D-V4-23`)が `order`(宣言済み)へ `reference` で1ホップ
    // つながるのに `st_admin_readable` を持たないためである。**意図してそうしている** ——
    // `ADR-0061` 限定11 の逐語「customer には1ミリも効かない」のとおり、宣言を足しても
    // 購入者の見え方は1ミリも変わらず、**運営が申し込みを一覧で読めるようにするかは
    // `B-G8` の射程外である**(`ADR-0073` の限定表11点に1点も無い)。**限定表の外を
    // 実装しないので、ここは増えたまま残す。**
    //
    // **【`V5-M18` で 3件 → 4件に増えた。減らしていない】** **増えたのは `order.cart` の
    // 1件である** —— 会計(支払い)の入力画面が「押した買い物かごの `_id`」を受け取るために
    // `order` に `cart` 参照を足した(`D-V5-86`)。**`order` は `st_admin_readable` を
    // 宣言しているが、`cart` は宣言していない**(意図してそうしている。`cart` を運営に
    // 見せると購入前の買い物かごの中身が運営から読めるようになり、`D-V4-2` の線を越える)。
    // **したがって運営は「この注文がどの買い物かごから来たか」を注文の画面で辿れない。**
    // **これは `V5-M18` が作った不備であり、直していない。**
    //
    // **【2026-08-10(`V8-M20` / `J-G30`)。件数は4件のままである。読み替えだけを書く】**
    // **上の段落の「`st_admin_readable` を持たない / 宣言している」は、今日は
    // 「面の読取の規則で名指しされていない / されている」と読む。** **参照 EC で運営に
    // 読取が開いている表は今日も `order` 1本だけなので、検出される4件は1件も動いていない。**
    // **【禁止の履行】これを「不備が直った」とは書かない。4件とも今日も在る。**
    //
    // **【2026-08-10(`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-58` / `D-V8-65`)。期待値を
    // 反転させた。4件 → 5件。旧の期待値を逐語で残す】**
    //
    // **旧の期待値(逐語)**:
    // ```
    //   [
    //     { table: "cart",        reference: "order.cart",         declared: "order", direction: "outgoing" },
    //     { table: "customer",    reference: "order.customer",     declared: "order", direction: "outgoing" },
    //     { table: "order_action", reference: "order_action.order", declared: "order", direction: "incoming" },
    //     { table: "order_line",  reference: "order_line.order",   declared: "order", direction: "incoming" },
    //   ]
    // ```
    //
    // **なぜ動いたか** —— **この検出の起点(`declared`)は「面が運営に読取を開いた表」で
    // ある。** **`V8-M26` が既定を閉じたので、参照 EC は店として成り立つために運営の規則を
    // 全部書き下すことになり、起点が `order` 1本から 11 本に増えた。**
    //
    // **消えた1件**: **`order_action`** —— **運営が取り消しの申し込みを読めるようになった**
    // (もう「見えなくなる」側ではない)。**これは不備が1件直った、と書いてよい唯一の行である。**
    // **増えた2件**: **`cart_line.product` と `order_line.product`** ——
    // **`product`(商品)が運営の読取の起点に加わったため、そこへ `reference` で1ホップ
    // つながる個人所有の表(カート明細・注文明細)が「運営から見えない子」として現れた。**
    // **これは新しい不備ではなく、着手前から在った同じ不備が、起点が増えたことで初めて
    // 検出に掛かったものである。** **直していない。**
    // **【禁止の履行】これを「不備が減った」とも「増えた」とも一言で書かない。**
    // **1件消えて2件現れた。差し引き +1 である。**
    expect(adminReadableChainWarnings(referenceEcManifest())).toEqual([
      {
        table: "cart",
        reference: "order.cart",
        declared: "order",
        direction: "outgoing",
      },
      {
        table: "cart_line",
        reference: "cart_line.product",
        declared: "product",
        direction: "incoming",
      },
      {
        table: "customer",
        reference: "order.customer",
        declared: "order",
        direction: "outgoing",
      },
      {
        table: "order_line",
        reference: "order_line.order",
        declared: "order",
        direction: "incoming",
      },
      {
        table: "order_line",
        reference: "order_line.product",
        declared: "product",
        direction: "incoming",
      },
    ]);
  });

  test("(h-4) カーネルは何も言わない: 宣言が1本足りないマニフェストを applyManifest はそのまま受理する", () => {
    const probeRoot = dataRoot;
    createApp(store, "連鎖検査", { app_id: "chain-probe" });
    const result = applyManifest(
      probeRoot,
      "chain-probe",
      manifestOf(
        [
          { id: "parent", name: "親", fields: [ownerF] },
          {
            id: "child",
            name: "子",
            fields: [
              ownerF,
              { id: "parent", name: "親", type: "reference", reference_table: "parent" },
            ],
          },
        ],
        ["parent"],
      ),
    );
    expect(result.valid).toBe(true);
    // **警告の器が1つも無い。**成功形のキーは valid / manifest / plan の3つだけで、
    // 「気をつけろ」を返す場所がカーネルに存在しない(`ApplyManifestResult`)。
    expect(Object.keys(result).sort()).toEqual(["manifest", "plan", "valid"]);
    expect(Object.keys(result)).not.toContain("warnings");
    // 同じ検出をこちらのマニフェストに当てれば1件出る —— 言えるのは検査の側だけである。
    expect(adminReadableChainWarnings(manifestOf([]))).toEqual([]);
  });

  test("(h-5) 検出が指した order_line は、運営から見て実際に警告なしで0件になる(本物の HTTP)", async () => {
    const cust = await signupCustomer(`cust-h-${Math.random().toString(36).slice(2)}`);
    const created = await request("POST", R("order"), {
      cookie: cust,
      body: { order_number: "EC-H-0001", status: "pending_payment", total: 1000 },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const orderId = ((await created.json()) as { record: { _id: string } }).record._id;
    // 明細も顧客が作る(order_line は `st_owner` を持つので customer は "scoped")。
    const line = await request("POST", R("order_line"), {
      cookie: cust,
      body: { order: orderId, quantity: 1, unit_price: 1000, line_total: 1000 },
    });
    expect(line.status, await line.clone().text()).toBe(201);

    const { cookie: owner } = seedSession(dataRoot, APP_ID);

    // 宣言済みの order は他人の行が返る。
    const orders = await request("GET", R("order"), { cookie: owner });
    expect(orders.status).toBe(200);
    expect(((await orders.json()) as { total: number }).total).toBe(1);

    // **未宣言の order_line は 200 のまま 0件である** —— エラーでもなく、警告も無い。
    // これが `order-detail` の related(子一覧)に出る側の表である。
    const lines = await request("GET", R("order_line"), { cookie: owner });
    expect(lines.status).toBe(200);
    const body = (await lines.json()) as { records: unknown[]; total: number };
    expect(body.records).toHaveLength(0);
    expect(body.total).toBe(0);

    // 画面側の裏づけ: `order-detail`(宣言済み order の詳細)の related が order_line である。
    // **V4-M4-T07 で related が1本増えた**(`order_action` = 取り消しの申し込み)。
    // **order_line の側は1バイトも動いていない** —— 増えたのであって差し替えていない。
    const detail = referenceEcManifest().app.views.find(
      (v) => v.id === "order-detail" && v.type === "detail_view",
    );
    expect(detail?.type).toBe("detail_view");
    const related = detail?.type === "detail_view" ? detail.related : undefined;
    expect(related?.map((r) => r.table)).toEqual(["order_line", "order_action"]);
    // **足した `order_action` も同じ不備を持つ**(宣言なし = 運営から見て警告なしで0件)。
    // (h-3) が3件目としてそれを名指ししている。**直していない。**
  });
});

// ===========================================================================
// (j) 入金済みの注文を持ち主が消せない(V4-M4-T07 / `B-G8` / ADR-0073 / D-V4-2 / D-V4-23)
//
// **A(参照 EC)に足した前提の上での観測である。** **B(実地インスタンス `ichishioya`)の
// 観測ではなく、件数を合算してはならない**(`01:361` / `01:426` 総括の禁止11 /
// `ADR-0073` §限界8)。**足した前提**: `order.st_undeletable` / `payment_events.protect_order`
// / `order_action`(取り消しの申し込み)/ `order-action-form` / `order-action-list` /
// `wf-order-cancel-request` / `order-detail` の `actions` と `related` 各1本。
//
// **【禁止】「注文が守られるようになった」と書かない**(`01:420` 総括の禁止5)——
// 守れる範囲は `ADR-0073` の限定表の内側だけである。
// ===========================================================================

describe("(j) 入金済みの注文を持ち主が消せない(B-G8 / ADR-0073)", () => {
  /** owner セッション(決済イベントの投入と監査の読取に使う)。 */
  let ownerCookie: string;
  beforeEach(() => {
    ownerCookie = seedSession(dataRoot, APP_ID).cookie;
  });

  /** 顧客の注文を1件作り、決済受信で入金済み + 削除不可にする。 */
  async function paidOrder(
    cust: string,
    orderNumber: string,
  ): Promise<{ id: string; version: string }> {
    const created = await request("POST", R("order"), {
      cookie: cust,
      body: { order_number: orderNumber, status: "pending_payment", total: 1000 },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const id = ((await created.json()) as { record: { _id: string } }).record._id;

    // 決済受信 → `wf-payment-received` が status/payment_status と **削除不可**を書く。
    // **boolean のリテラルはワークフローに書けない**ので、受信レコードの boolean 列
    // (`protect_order`)を経由している(`scripts/ref-ec/manifest.ts` の逐語)。
    await createAsOwner(ownerCookie, "payment_events", {
      event_id: `evt-${orderNumber}`,
      event_type: "payment.succeeded",
      order: id,
      amount: 1000,
      currency: "JPY",
      status: "paid",
      protect_order: true,
    });

    const read = await request("GET", R("order", id), { cookie: cust });
    expect(read.status).toBe(200);
    const row = ((await read.json()) as { record: Record<string, unknown> }).record;
    expect(row.status).toBe("paid");
    expect(row[UNDELETABLE_FIELD]).toBe(true);
    return { id, version: row._updated_at as string };
  }

  test("(j-1) 入金済みの注文は、持ち主(customer)の DELETE が 409 で止まり、行が残る", async () => {
    const cust = await signupCustomer(`cust-j1-${Math.random().toString(36).slice(2)}`);
    const { id, version } = await paidOrder(cust, "EC-J-0001");

    const res = await app.request(
      new Request(`http://localhost${R("order", id)}`, {
        method: "DELETE",
        headers: { cookie: cust, origin: TEST_ORIGIN, "if-match": version },
      }),
    );
    expect(res.status, await res.clone().text()).toBe(409);
    const body = (await res.json()) as { errors: { message: string }[] };
    expect(String(body.errors[0]?.message)).toContain("削除できません");

    // **行は残る**(`D-V4-2`「行は残り、運営が状態を動かす」)。
    expect((await request("GET", R("order", id), { cookie: cust })).status).toBe(200);
  });

  test("(j-2) 未入金の注文は今日どおり消せる(既定は消せる = ADR-0073 限定4)", async () => {
    const cust = await signupCustomer(`cust-j2-${Math.random().toString(36).slice(2)}`);
    const created = await request("POST", R("order"), {
      cookie: cust,
      body: { order_number: "EC-J-0002", status: "pending_payment", total: 500 },
    });
    expect(created.status).toBe(201);
    const rec = (await created.json()) as { record: { _id: string; _updated_at: string } };
    const res = await app.request(
      new Request(`http://localhost${R("order", rec.record._id)}`, {
        method: "DELETE",
        headers: { cookie: cust, origin: TEST_ORIGIN, "if-match": rec.record._updated_at },
      }),
    );
    expect(res.status, await res.clone().text()).toBe(204);
  });

  test("(j-3) 購入者にできるのは申し込みまで —— order_action は作れるが、注文の状態は動かない", async () => {
    const cust = await signupCustomer(`cust-j3-${Math.random().toString(36).slice(2)}`);
    const { id } = await paidOrder(cust, "EC-J-0003");

    const applied = await request("POST", R("order_action"), {
      cookie: cust,
      body: {
        order: id,
        action_type: "cancel_request",
        reason: "手違いで注文しました",
        status: "requested",
        requested_at: "2026-08-03",
      },
    });
    expect(applied.status, await applied.clone().text()).toBe(201);

    // **注文の状態は1ミリも動いていない**(`ADR-0073` 限定9 / `D-V4-2`)。
    const after = await request("GET", R("order", id), { cookie: cust });
    const row = ((await after.json()) as { record: Record<string, unknown> }).record;
    expect(row.status).toBe("paid");
    expect(row[UNDELETABLE_FIELD]).toBe(true);

    // 申し込みは監査に残る(`wf-order-cancel-request`)。
    const events = await request("GET", R("order_events"), { cookie: ownerCookie });
    const rows = ((await events.json()) as { records: Record<string, unknown>[] }).records;
    expect(rows.some((r) => r.order === id && r.event === "cancel_requested")).toBe(true);
  });

  test("(j-4)【穴】持ち主は削除不可を自分で下ろせ、そのあと消せる —— 塞いでいない", async () => {
    // **`ADR-0073` 限定3 が「`PATCH` を1バイトも変えない」と定めているため、自分の行に
    // 対する購入者の `PATCH` を止める手段が今日は1つも無い。** 限定9 の第4列が求めた
    // 「customer が守られた行の値を直接 `PATCH` できないことを固定するテスト」は、
    // **自分の行については成立しない。** 実測を残す。
    const cust = await signupCustomer(`cust-j4-${Math.random().toString(36).slice(2)}`);
    const { id, version } = await paidOrder(cust, "EC-J-0004");

    const patched = await app.request(
      new Request(`http://localhost${R("order", id)}`, {
        method: "PATCH",
        headers: {
          cookie: cust,
          origin: TEST_ORIGIN,
          "content-type": "application/json",
          "if-match": version,
        },
        body: JSON.stringify({ [UNDELETABLE_FIELD]: false }),
      }),
    );
    expect(patched.status, await patched.clone().text()).toBe(200);

    const read = await request("GET", R("order", id), { cookie: cust });
    const row = ((await read.json()) as { record: Record<string, unknown> }).record;
    const res = await app.request(
      new Request(`http://localhost${R("order", id)}`, {
        method: "DELETE",
        headers: { cookie: cust, origin: TEST_ORIGIN, "if-match": row._updated_at as string },
      }),
    );
    expect(res.status, await res.clone().text()).toBe(204);
  });
});

// ===========================================================================
// (i) 「3日間 pending_payment の**まま**」の「まま」への緩和(V3-M12-T08)
//
// `ADR-0064` §限界1(逐語): 「**「3日間 `pending_payment` の**まま**」の「まま」は
// 表現できていない。** 測るのは日付列からの経過であって状態が変わってからの経過では
// ない(§2 の (b))。**やっていないことを、やっていないと書く。**」
//
// `(g-4)` が参照 EC の上でその具体を実測している —— 10日前に注文され、ずっと `paid`
// だった行を発火の直前に `pending_payment` へ戻すと、**打ち切られる**。
//
// **本節が測るのは「今日の語彙でできる緩和が実在するか」だけである。**
//   - `older_than.field` は「対象テーブルに実在する `date` 型フィールド」なら何でも
//     指せる(`ADR-0064` 限定1)。**`placed_at` でなければならない理由は語彙に無い。**
//   - したがって「状態が変わった時刻」を持つ `date` フィールドを**アプリ側で**足し、
//     そこへ向ければ、`(g-4)` の誤打ち切りは起きない。**カーネルは1バイトも変わらない。**
//
// **本節は本番の参照 EC 宣言(`manifest.ts`)を1バイトも書き換えていない**
// —— `(g-4)` は `ADR-0064` §限界1 が参照 EC の上に現れた唯一の具体であり、
// 消すと `V3-M11-T03` の実測が失われる。緩和は**同じマニフェストから派生させた
// 別アプリ**として同じ dataRoot に並べ、**同じ tick で**本番宣言と突き合わせる。
// したがって **`(i)` が緑でも、参照 EC 自身は今日も誤打ち切りする**(`(i-7)` が固定する)。
// ===========================================================================

describe("(i) まだ払える注文が打ち切られる件の緩和(V3-M12-T08)", () => {
  const TZ = "Asia/Tokyo";
  const SWEEP_ID = "wf-stale-order-sweep";
  /** 緩和版を入れる別アプリ。**本番の参照 EC と同じ dataRoot に並べ、同じ tick で比べる。** */
  const MITIGATED_APP_ID = "ref-ec-status-clock";
  /** 状態が変わった時刻を持つ器(アプリ側のフィールド。**予約列ではない**)。 */
  const STAMP = "status_changed_at";

  afterEach(() => {
    resetWorkflowClock();
  });

  /**
   * **緩和版マニフェスト** —— 本番の参照 EC 宣言から派生させ、**アプリ側だけ**を変える。
   *
   * `schemas/` にも `src/kernel/` にも1バイトも触らない。変えるのは3点だけである。
   */
  function mitigatedEcManifest(appId: string = MITIGATED_APP_ID): Manifest {
    const m = structuredClone(referenceEcManifest());
    m.app.id = appId;

    // (1) **状態が変わった時刻の器**を order に足す —— `date` 型のユーザ定義フィールドである。
    //     `_created_at` / `_updated_at` を指さないので ADR-0064 再審査条件 (e) は発火しない。
    const order = m.app.tables.find((t) => t.id === "order");
    if (order === undefined) {
      throw new Error("order テーブルが無い");
    }
    order.fields.push({ id: STAMP, name: "状態変更日時", type: "date" });

    // (2) **`older_than` の当て先を `placed_at` から `status_changed_at` へ向ける** ——
    //     足したキーは0本である(`{field, days}` の1形の中身を差し替えただけ)。
    const sweep = (m.app.workflows ?? []).find((w) => w.id === SWEEP_ID);
    if (sweep?.trigger.type !== "schedule") {
      throw new Error(`${SWEEP_ID} が schedule ではない`);
    }
    sweep.trigger.older_than = { field: STAMP, days: 3 };

    // (3) **宣言だけで打刻できる経路**: 決済受信で状態を変えるアクションに、トリガー元
    //     (payment_events)の日付列のコピーを1つ足す。**「今」ではなく外から来た値である。**
    const events = m.app.tables.find((t) => t.id === "payment_events");
    if (events === undefined) {
      throw new Error("payment_events テーブルが無い");
    }
    events.fields.push({ id: "occurred_at", name: "発生日時", type: "date" });
    const received = (m.app.workflows ?? []).find((w) => w.id === "wf-payment-received");
    for (const action of received?.actions ?? []) {
      if (action.action === "update_record") {
        action.values = { ...action.values, [STAMP]: "$record.occurred_at" };
      }
    }
    return m;
  }

  /** 別アプリとして dataRoot へ入れる(**本番の参照 EC はそのまま隣に在る**)。 */
  function install(manifest: Manifest, name: string): Manifest {
    createApp(store, name, { app_id: manifest.app.id });
    const installed = applyManifest(dataRoot, manifest.app.id, manifest);
    expect(installed.valid, JSON.stringify(installed)).toBe(true);
    // 隣に置くアプリにも同じ capability を発行する(V3-M13-T02 / ADR-0066 の前提)。
    issueRefEcCapabilities(manifest.app.id);
    return manifest;
  }

  function withDb<T>(appId: string, fn: (db: Database) => T): T {
    const db = new Database(appDbPath(dataRoot, appId), { readwrite: true, create: false });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  function rowsOf(appId: string, manifest: Manifest, table: string): RecordRow[] {
    return withDb(appId, (db) => {
      const result = listRecords(db, manifest, table, {});
      if (!result.ok) {
        throw new Error(`${appId}.${table} を読めませんでした: ${JSON.stringify(result.errors)}`);
      }
      return result.value;
    });
  }

  /**
   * **【2026-08-10(`V8-M26`)。`order` の投入に持ち主を付けた。期待値は1つも動かしていない】**
   *
   * **理由は (g) の `seedOrder` と同じである** —— **既定が閉じたので、注文の作成で発火する
   * ワークフローの書き手が実在の利用者でなければ、集計と監査への書込が通らない。**
   * **アプリごとに `_auth_users` が別なので、`appId` ごとに1人ずつ用意する。**
   * **打ち切りの判定は `st_owner` を1バイトも見ないので、(i) 群の比較は1ミリも変わらない。**
   */
  function seed(appId: string, manifest: Manifest, table: string, fields: Record<string, unknown>) {
    const withOwner =
      table === "order" && fields[OWNER_FIELD] === undefined
        ? { [OWNER_FIELD]: stableBuyer(appId).userId, ...fields }
        : fields;
    return withDb(appId, (db) => {
      const created = createRecord(db, manifest, table, withOwner);
      if (!created.ok) {
        throw new Error(`${appId}.${table} の投入に失敗: ${JSON.stringify(created.errors)}`);
      }
      return String(created.value._id);
    });
  }

  function poke(
    appId: string,
    manifest: Manifest,
    table: string,
    id: string,
    fields: Record<string, unknown>,
  ): void {
    withDb(appId, (db) => {
      const updated = updateRecord(db, manifest, table, id, fields);
      if (!updated.ok) {
        throw new Error(`${appId}.${table} の更新に失敗: ${JSON.stringify(updated.errors)}`);
      }
    });
  }

  function statusByNumber(appId: string, manifest: Manifest): Record<string, string> {
    const out: Record<string, string> = {};
    for (const row of rowsOf(appId, manifest, "order")) {
      out[String(row.order_number)] = String(row.status);
    }
    return out;
  }

  function setNowFor(iso: string): void {
    setWorkflowClock({ now: () => new Date(iso) });
  }

  function tick(): void {
    runSchedulerTick({ dataRoot, timeZone: TZ });
  }

  /**
   * 両方のアプリへ**同じ**注文を入れる(唯一の違いは宣言である)。
   *
   * **本番側からは `status_changed_at` を落とす** —— 本番の `order` にその器が
   * 1本も無いためで、書くと `createRecord` が「フィールドが存在しません」で拒否する
   * (実測)。**落とすこと自体が、本番宣言に状態変更時刻の置き場が無いことの現れである。**
   */
  function seedBoth(
    mitigated: Manifest,
    fields: Record<string, unknown>,
  ): { plain: string; mitigated: string } {
    const { [STAMP]: _stamp, ...withoutStamp } = fields;
    return {
      plain: seed(APP_ID, referenceEcManifest(), "order", withoutStamp),
      mitigated: seed(MITIGATED_APP_ID, mitigated, "order", fields),
    };
  }

  test("(i-1) 緩和の形: older_than は placed_at 以外の date フィールドへ向けられる(applyManifest valid)", () => {
    const mitigated = install(mitigatedEcManifest(), "参照EC(状態変更時刻)");

    // 器はアプリ側のフィールドである(**予約列 `_created_at` / `_updated_at` ではない** ——
    // 指すと ADR-0064 再審査条件 (e) が発火し門A が要る)。
    const order = mitigated.app.tables.find((t) => t.id === "order");
    expect(order?.fields.find((f) => f.id === STAMP)?.type).toBe("date");
    expect(STAMP.startsWith("_")).toBe(false);

    const sweep = (mitigated.app.workflows ?? []).find((w) => w.id === SWEEP_ID);
    expect(sweep?.trigger.type).toBe("schedule");
    if (sweep?.trigger.type !== "schedule") {
      throw new Error("unreachable");
    }
    expect(sweep.trigger.older_than).toEqual({ field: STAMP, days: 3 });
    // **足したのは1形の当て先だけである** —— trigger のキーは4つのまま。
    expect(Object.keys(sweep.trigger).sort()).toEqual(["at", "older_than", "table", "type"]);
    // `when` も1バイト変えていない(AND は今日どおり2層の合成である)。
    expect(sweep.actions[0]).toEqual({
      action: "update_record",
      table: "order",
      target: "$record._id",
      values: { status: "cancelled" },
      when: { field: "status", equals: "pending_payment" },
    });
  });

  test("(i-2) 【本体】同じ行・同じ tick で、本番宣言は誤打ち切りし、緩和版は打ち切らない", () => {
    const mitigated = install(mitigatedEcManifest(), "参照EC(状態変更時刻)");

    // (A) 10日前に注文され、ずっと paid で、発火の直前に pending_payment へ戻った行。
    //     **pending_payment でいた時間は0日である。**
    const revived = seedBoth(mitigated, {
      order_number: "I-revived",
      status: "paid",
      placed_at: "2026-07-10",
      [STAMP]: "2026-07-10",
    });
    // 状態を戻す書き手が、**同じ書込で**状態変更時刻も書く(緩和版だけ)。
    poke(APP_ID, referenceEcManifest(), "order", revived.plain, { status: "pending_payment" });
    poke(MITIGATED_APP_ID, mitigated, "order", revived.mitigated, {
      status: "pending_payment",
      [STAMP]: "2026-07-19",
    });

    // (B) 本当に3日以上 pending_payment のままの行(緩和が機能を殺していないことの対照)。
    seedBoth(mitigated, {
      order_number: "I-stale",
      status: "pending_payment",
      placed_at: "2026-07-10",
      [STAMP]: "2026-07-10",
    });

    setNowFor("2026-07-20T09:00:00+09:00");
    tick();

    // 本番宣言(placed_at): **戻したばかりの行まで打ち切られる**(= (g-4) と同じ)。
    expect(statusByNumber(APP_ID, referenceEcManifest())).toEqual({
      "I-revived": "cancelled",
      "I-stale": "cancelled",
    });
    // 緩和版(status_changed_at): **戻したばかりの行は打ち切られない。**滞留した行は打ち切られる。
    expect(statusByNumber(MITIGATED_APP_ID, mitigated)).toEqual({
      "I-revived": "pending_payment",
      "I-stale": "cancelled",
    });
  });

  test("(i-3) 緩和の代償: 状態変更時刻を書き忘れた行は1件も打ち切られない(過検出が失検出に変わる)", () => {
    const mitigated = install(mitigatedEcManifest(), "参照EC(状態変更時刻)");

    // 書き手が status_changed_at を1文字も書かなかった行(= 今日の参照 EC の全行と同じ形)。
    seedBoth(mitigated, {
      order_number: "I-unstamped",
      status: "pending_payment",
      placed_at: "2026-07-10",
    });

    setNowFor("2026-07-20T09:00:00+09:00");
    tick();

    // 本番宣言では打ち切られ、緩和版では**打ち切られない**。
    expect(statusByNumber(APP_ID, referenceEcManifest())["I-unstamped"]).toBe("cancelled");
    expect(statusByNumber(MITIGATED_APP_ID, mitigated)["I-unstamped"]).toBe("pending_payment");

    // **カーネルは書き忘れを1文字も言わない** —— 履歴は success であり、行を1件も名指ししない。
    const runs = rowsOf(MITIGATED_APP_ID, mitigated, "wf_runs").filter(
      (row) => row.workflow === SWEEP_ID,
    );
    expect(runs).toHaveLength(1);
    /*
     * 【`V8-M42` / `F-G15` / `ADR-0333`。**旧の期待値と、上の1行のコメントの逐語を残す**】
     *
     *     // **カーネルは書き忘れを1文字も言わない** —— 履歴は success であり、行を1件も名指ししない。
     *     expect(runs[0]?.status).toBe("success");
     *
     * **`older_than` が全行を落とした発火は、今日は4値目 `"no_target"` になる**(`ADR-0333` 限定2)。
     * **この検査の主題(書き忘れた行を履歴が1文字も名指ししない)は1バイトも変わっていない** ——
     * **下の `error` の期待値は1文字も動いていない。**
     * **【正直に】`status` の側は、着手前より**わずかに**多くを語るようになった** ——
     * **「対象が1件も無かった」ことだけは読めるようになった。**
     * **それでも「どの行がなぜ落ちたか」は今日も1文字も残らない。**
     */
    expect(runs[0]?.status).toBe("no_target");
    expect(String(runs[0]?.error ?? "")).not.toContain("I-unstamped");
  });

  test("(i-4) 宣言では「今」を書けない: $now も予約列も action_value に書けず apply が拒否する", () => {
    // (a) 「今」を表す記法は1つも無い。`$` で始まる文字列は `$record.<フィールドID>` だけである。
    const withNow = mitigatedEcManifest("reject-now");
    const sweepNow = (withNow.app.workflows ?? []).find((w) => w.id === SWEEP_ID);
    const actionNow = sweepNow?.actions[0];
    if (actionNow?.action !== "update_record") {
      throw new Error("unreachable");
    }
    actionNow.values = { status: "cancelled", [STAMP]: "$now" };
    createApp(store, "拒否 $now", { app_id: "reject-now" });
    expect(applyManifest(dataRoot, "reject-now", withNow).valid).toBe(false);

    // (b) 予約列(`$record._updated_at`)も書けない(ADR-0064 限定5 が言う「予約列を指せない」)。
    const withReserved = mitigatedEcManifest("reject-reserved");
    const sweepRes = (withReserved.app.workflows ?? []).find((w) => w.id === SWEEP_ID);
    const actionRes = sweepRes?.actions[0];
    if (actionRes?.action !== "update_record") {
      throw new Error("unreachable");
    }
    actionRes.values = { status: "cancelled", [STAMP]: "$record._updated_at" };
    createApp(store, "拒否 予約列", { app_id: "reject-reserved" });
    expect(applyManifest(dataRoot, "reject-reserved", withReserved).valid).toBe(false);

    // (c) 書けるのはリテラルだけであり、**リテラルは固定値である**(「今」にならない)。
    const withLiteral = mitigatedEcManifest("accept-literal");
    const sweepLit = (withLiteral.app.workflows ?? []).find((w) => w.id === SWEEP_ID);
    const actionLit = sweepLit?.actions[0];
    if (actionLit?.action !== "update_record") {
      throw new Error("unreachable");
    }
    actionLit.values = { status: "cancelled", [STAMP]: "2026-07-20" };
    createApp(store, "受理 リテラル", { app_id: "accept-literal" });
    expect(applyManifest(dataRoot, "accept-literal", withLiteral).valid).toBe(true);
  });

  test("(i-5) 宣言だけで打刻できる経路は1本ある: トリガー元の日付列を $record でコピーする", () => {
    const mitigated = install(mitigatedEcManifest(), "参照EC(状態変更時刻)");

    // **【`V8-M21` の後半で足した2行。理由を実測で書く】**
    // **決済受信のワークフローは `act_as: "$record.order"`(= 注文の持ち主として動く)を
    // 宣言している。** **面が `order` を名指ししているので、その持ち主が**実在する購入者**で
    // なければ「誰でもない」として止まる**(実測の文面: 「この発火では書き手を特定できません
    // … 止めた層: role」)。**期待値は1つも緩めていない** —— **台に持ち主を1人置いただけである。**
    const buyer = seedSession(dataRoot, MITIGATED_APP_ID, { role: "customer" });

    const orderId = seed(MITIGATED_APP_ID, mitigated, "order", {
      order_number: "I-paid-by-webhook",
      status: "pending_payment",
      placed_at: "2026-07-10",
      [STAMP]: "2026-07-10",
      st_owner: buyer.userId,
    });

    // 決済イベントの受信(**日付は外から来る。カーネルの時計ではない**)。
    seed(MITIGATED_APP_ID, mitigated, "payment_events", {
      event_id: "evt-i5",
      event_type: "charge.succeeded",
      order: orderId,
      status: "paid",
      occurred_at: "2026-07-19",
    });

    const order = rowsOf(MITIGATED_APP_ID, mitigated, "order").find((r) => r._id === orderId);
    // 状態と**状態変更時刻が同じアクションで**書かれた(宣言だけで打刻できている)。
    expect(order?.status).toBe("paid");
    expect(order?.[STAMP]).toBe("2026-07-19");
  });

  test("(i-6) 緩和しても、older_than で落ちた行を追う手段は無い(履歴に1文字も現れない)", () => {
    const mitigated = install(mitigatedEcManifest(), "参照EC(状態変更時刻)");

    // (1) 「まだ経っていない」行(状態変更時刻が新しい = 緩和が救った行)。
    const savedId = seed(MITIGATED_APP_ID, mitigated, "order", {
      order_number: "I-saved",
      status: "pending_payment",
      placed_at: "2026-07-10",
      [STAMP]: "2026-07-19",
    });
    // (2) 「そもそも値が無い」行(書き手が打刻を忘れた = fail-closed で対象外)。
    const unstampedId = seed(MITIGATED_APP_ID, mitigated, "order", {
      order_number: "I-unstamped",
      status: "pending_payment",
      placed_at: "2026-07-10",
    });
    // (3) **「日付が壊れている」行は、この経路では作れない** —— `date` 型の値は書込時に
    //     ISO8601 で検証され、`createRecord` が拒否する(実測)。**したがって
    //     `v3-m11-t10.md` §10-2 の 5 が挙げた3つのうち、書込経路から到達できるのは2つである。**
    const broken = withDb(MITIGATED_APP_ID, (db) =>
      createRecord(db, mitigated, "order", {
        order_number: "I-broken-date",
        status: "pending_payment",
        placed_at: "2026-07-10",
        [STAMP]: "not-a-date",
      }),
    );
    expect(broken.ok).toBe(false);

    setNowFor("2026-07-20T09:00:00+09:00");
    tick();

    const runs = rowsOf(MITIGATED_APP_ID, mitigated, "wf_runs").filter(
      (row) => row.workflow === SWEEP_ID,
    );
    expect(runs).toHaveLength(1);
    /*
     * 【`V8-M42` / `F-G15` / `ADR-0333`。**旧の期待値を逐語で残す**】
     *
     *     expect(runs[0]?.status).toBe("success");
     *
     * **`older_than` が全行を落とした発火は、今日は4値目 `"no_target"` になる**(`ADR-0333` 限定2)。
     * **下の「まだ経っていない」も「そもそも値が無い」も履歴上は同じ「無」である、という
     * この検査の主題は1バイトも変わっていない** —— **`error` の期待値は1文字も動いていない。**
     */
    expect(runs[0]?.status).toBe("no_target");
    const error = String(runs[0]?.error ?? "");
    // **「まだ経っていない」も「そもそも値が無い」も、履歴上は同じ「無」である。**
    expect(error).not.toContain(savedId);
    expect(error).not.toContain(unstampedId);
    expect(error).not.toContain("I-saved");
    expect(error).not.toContain("I-unstamped");
    // 2件とも生きている(打ち切られていない)。**理由の違いはどこにも残らない。**
    expect(statusByNumber(MITIGATED_APP_ID, mitigated)).toEqual({
      "I-saved": "pending_payment",
      "I-unstamped": "pending_payment",
    });
  });

  test("(i-7) 本番の参照 EC 宣言は1バイトも変わっていない(緩和を取り込んでいない)", () => {
    const m = referenceEcManifest().app;
    // 状態変更時刻の器は**本番の order に1本も無い**。
    const order = m.tables.find((t) => t.id === "order");
    expect(order?.fields.find((f) => f.id === STAMP)).toBeUndefined();
    // 本番の打ち切りは今日も `placed_at` を測る(= (g-4) の誤打ち切りは今日も起きる)。
    const sweep = (m.workflows ?? []).find((w) => w.id === SWEEP_ID);
    if (sweep?.trigger.type !== "schedule") {
      throw new Error("unreachable");
    }
    expect(sweep.trigger.older_than).toEqual({ field: "placed_at", days: 3 });
    // ワークフローは **9本**(V4-M4-T07 が `wf-order-cancel-request`、V4-M21-T01 が
    // `wf-cart-line-dedupe` を足した)。**緩和は 1バイトも取り込んでいない** —— それを
    // 押さえているのは上の `STAMP` / `older_than` の2つの assert であって、本数ではない。
    // **当時 `9` → 今日 `11`**(`V5-M18` の手動起動2本)。**上の行を書き換えていない。**
    expect(m.workflows).toHaveLength(11);
  });
});
