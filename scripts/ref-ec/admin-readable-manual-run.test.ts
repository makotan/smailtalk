/**
 * **「読めるが押せない」を、宣言を持つ表そのもので再現する**(`V5-M26-T08` の穴2)。
 *
 * ## **【`V8-M20` / 台帳 `J-G30` / ユーザ決定 `D-V8-35` / `ADR-0301`】測る対象を面へ移した**
 *
 * **旧のヘッダの逐語**(1バイトも書き換えずに、下に引用として残す):
 *
 * > **本ファイルは `order`(`st_admin_readable` を宣言している唯一の表)で同じことを測る。**
 * > **原因は `src/server/app.ts` の1行である** —— 手動起動のハンドラは
 * > `isOwnerVisible(existing.value[OWNER_FIELD], actor.id)` を**第3引数(`adminReadable`)
 * > なしで**呼ぶ(`src/server/owner-scope.ts` の既定値は `false`)。
 * > **レコードの読取経路はその第3引数を渡す。**
 *
 * **今日**: **`order` は「運営に読取を開いている唯一の表」であり続けているが、開いているのは
 * 予約規約フィールドではなく面の規則(`app.roles` の `owner` x 表 `order` x 読取)である。**
 * **原因の1行も移った** —— **手動起動のハンドラは `isOwnerVisible(...)` を呼ぶだけで、
 * `roleReadCrossesOwnerScope` を1度も呼ばない**(`D-V8-35` が開いたのは読取経路だけである)。
 * **測っている現象(同じ行・同じ運営・同じ瞬間に `GET` が 200、手動起動が 404)は1ミリも
 * 変わっていない。**
 *
 * ## `checkout-journey.test.ts` の (D-2) との違い
 *
 * **(D-2) は3段で測っているが、3段目(404 を直接見る段)の対象は `cart` である。**
 * **`cart` には運営に読取を開く規則が1本も無い** —— **したがって (D-2) の 404 は
 * 「宣言があるのに効かない」ことの証拠にはなっていない**(宣言が無い表で 404 が出るのは
 * 今日の設計どおりである)。**本ファイルは `order` で同じことを測る。**
 *
 * ## 測っていないこと
 *
 * - **ブラウザを1度も開いていない。** 通しているのは `app.request()` である。
 * - **この穴を1バイトも塞いでいない。** **本タスクは実装を1行も足していない。**
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifest } from "../../src/kernel/apply-manifest.ts";
import { createApp } from "../../src/kernel/create-app.ts";
import { KernelMetaStore } from "../../src/kernel/meta-store.ts";
import type { ListView, Manifest } from "../../src/kernel/types.ts";
import { createServerApp } from "../../src/server/app.ts";
import { seedSession, TEST_ORIGIN } from "../../src/server/test-helpers.ts";
import { REF_EC_APP_ID, referenceEcManifest } from "./manifest.ts";

let dataRoot: string;
let store: KernelMetaStore;
let app: ReturnType<typeof createServerApp>;

/**
 * **`order` に `manual` のワークフローを1本足し、`order-list` にそれを起こす操作起点を置く。**
 *
 * **識別子(`id`)は書かない** —— **書いて面の規則から名指しすると、面のボタンの 403 が
 * 先に立ち、個人スコープの 404 を測れなくなる**((D-2) の2段目がまさにそれである)。
 * **旧の逐語**: 「**`audience` は書かない** —— **書くと `audience` の 403 が先に立ち…**」。
 * **`id` の無い起点は面から名指しできないので、今日どおり素通りする。**
 */
function manifestWithOwnerRunnableOrderAction(): Manifest {
  const next = referenceEcManifest();
  // **落とすのは2本だけである** —— `wf-order-checkout`(`call_external`)と
  // `wf-order-enrich`(`ai_transform`)。**本ファイルは接続も AI capability も発行しないので、
  // 残すと `order` の作成が 400 になる**(ワークフローが失敗した書込は1バイトも残らない)。
  // **`web/e2e/ref-ec-checkout.e2e.ts` が落としているのと同じ2本である。**
  const dropped = new Set(["wf-order-checkout", "wf-order-enrich"]);
  next.app.workflows = [
    ...(next.app.workflows ?? []).filter((workflow) => !dropped.has(workflow.id)),
    {
      id: "wf-order-payment-confirm",
      name: "入金を確認する",
      trigger: { type: "manual", table: "order" },
      actions: [
        {
          action: "update_record",
          table: "order",
          target: "$record._id",
          values: { payment_status: "paid" },
        },
      ],
      history_table: "wf_runs",
    } as unknown as NonNullable<Manifest["app"]["workflows"]>[number],
  ];
  const orderList = next.app.views.find((view) => view.id === "order-list") as ListView;
  orderList.actions = [
    { view: "order-receipt", name: "会計の控えを見る" },
    { run: "wf-order-payment-confirm", name: "入金を確認する" },
  ];
  return next;
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-ref-ec-admin-readable-"));
  store = KernelMetaStore.open(dataRoot);
  createApp(store, "参照EC", { app_id: REF_EC_APP_ID });
  const installed = applyManifest(dataRoot, REF_EC_APP_ID, manifestWithOwnerRunnableOrderAction());
  if (!installed.valid) {
    throw new Error(`投入に失敗: ${JSON.stringify(installed.errors)}`);
  }
  app = createServerApp({ dataRoot });
});

afterEach(async () => {
  store.close();
  await rm(dataRoot, { recursive: true, force: true });
});

async function req(
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { origin: TEST_ORIGIN, cookie };
  if (body !== undefined) headers["content-type"] = "application/json";
  return app.request(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

/**
 * **穴2の再現。** **同じ行に対して、運営の `GET` は 200、運営の手動起動は 404 である。**
 */
// **【`V8-M20` / `J-G30`】旧テスト名の逐語**:
// 「(H-1) `st_admin_readable` を宣言した `order` でも、運営は購入者の行に手動起動を押せない」。
// **主語を面の規則へ移しただけで、測っている現象は1ミリも変えていない。**
test("(H-1) 面が運営に読取を開いた `order` でも、運営は購入者の行に手動起動を押せない", async () => {
  const buyer = seedSession(dataRoot, REF_EC_APP_ID, { role: "customer" });
  const owner = seedSession(dataRoot, REF_EC_APP_ID, { role: "owner" });
  const base = `/api/apps/${REF_EC_APP_ID}`;

  // **旧の作成本文には `st_admin_readable: true,` が入っていた**(今日は 400 になる)。
  const created = await req(buyer.cookie, "POST", `${base}/tables/order/records`, {
    order_number: "M26-H-1",
    status: "pending_payment",
    payment_status: "unpaid",
  });
  expect(created.status).toBe(201);
  const orderId = ((await created.json()) as { record: { _id: string } }).record._id;

  // (1) **運営は読める** —— 面の規則(`owner` x 表 `order` x 読取)が効いている。
  // **旧の逐語**: 「(1) **運営は読める** —— `st_admin_readable` が効いている。」
  const read = await req(owner.cookie, "GET", `${base}/tables/order/records/${orderId}`);
  expect(read.status).toBe(200);

  // (2) **同じ行に、同じ運営が、宣言された操作起点から手動起動を押すと 404 である。**
  //     **面の 403 ではない** —— この起点には `id` が無く、面から名指しできないためである。
  const run = await req(
    owner.cookie,
    "POST",
    `${base}/views/order-list/actions/run?workflow=wf-order-payment-confirm&record=${orderId}`,
  );
  expect(run.status).toBe(404);
  const body = (await run.json()) as { errors: { message: string }[] };
  expect(body.errors[0]?.message).toContain("は存在しません");

  // (3) **行は1ミリも動いていない。**
  const after = await req(owner.cookie, "GET", `${base}/tables/order/records/${orderId}`);
  expect(
    ((await after.json()) as { record: { payment_status: string } }).record.payment_status,
  ).toBe("unpaid");
});

/**
 * **対照** —— **押した人が持ち主なら、同じ入口・同じ宣言で 200 になる。**
 *
 * **これが緑であることは、(H-1) の 404 が「入口そのものが壊れている」からではないことを示す。**
 */
test("(H-2) 対照: 持ち主本人が押せば同じ入口が 200 を返し、行が変わる", async () => {
  const buyer = seedSession(dataRoot, REF_EC_APP_ID, { role: "customer" });
  const base = `/api/apps/${REF_EC_APP_ID}`;

  const created = await req(buyer.cookie, "POST", `${base}/tables/order/records`, {
    order_number: "M26-H-2",
    status: "pending_payment",
    payment_status: "unpaid",
  });
  expect(created.status).toBe(201);
  const orderId = ((await created.json()) as { record: { _id: string } }).record._id;

  const run = await req(
    buyer.cookie,
    "POST",
    `${base}/views/order-list/actions/run?workflow=wf-order-payment-confirm&record=${orderId}`,
  );
  expect(run.status).toBe(200);
  expect((await run.json()) as { failures: unknown[] }).toMatchObject({ failures: [] });

  const after = await req(buyer.cookie, "GET", `${base}/tables/order/records/${orderId}`);
  expect(
    ((await after.json()) as { record: { payment_status: string } }).record.payment_status,
  ).toBe("paid");
});
