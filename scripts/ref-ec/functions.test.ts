/**
 * 参照 EC の周辺計算(function 島)の実挙動 TDD(V2-M7-T02 / CP-V2)。
 *
 * 本物の SQLite(mkdtemp)+ 本物の QuickJS-WASM 島 + 本物の run_function 実行経路
 * (`createRecord` → `runWorkflows` → `runAction` → 島)で、次を証明する
 * (`src/kernel/aggregation-demo.test.ts` の作法に揃える。モックを1つも置かない):
 *
 *  (1) **明細金額(単価×数量)= Route B**: cart_line/order_line の on_create で fn-line-total が
 *      発火し、`line_total = unit_price × quantity` を**行自身へ書き戻す**(write_back:$record)。
 *  (2) **集計(小計・クーポン割引・送料・税・合計)= output_table 全置換**: 明細全行を入力に
 *      小計 Σ line_total / 割引(percent・fixed)/ 送料(free_over 境界)/ 税(subtotal×rate を Math.floor)/
 *      合計を計算し、集計テーブルへ全置換で書く。concrete な値で percent/fixed/境界/税を固定する。
 *  (3) **manifest.ts に実際に焼き込んだ島(既定価格設定)がそのまま走る**ことを、
 *      referenceEcManifest() の FunctionDef を直接実行して確認する。
 *
 * ## この T02 の正直な限界(誇張しない。憲法6。functions.ts の ★ と本記録 §1 T02-3 に対応)
 *  (a) **行内計算列にならない**: Route B は行内1件のみ。小計/合計は Σ を自動更新する手段が無く、
 *      集計専用テーブル(cart_totals/order_totals)へ output_table 全置換で落ちる(EC-G10 の代償)。
 *  (b) **一般式言語なし**: 演算は島の JS。カーネル限定12 は不変。
 *  (c) **通貨精度・単位なし**: JPY 整数のみ。税は Math.floor で決定論的に丸める(EC-G9 却下維持)。
 *  (d) **output_table は全置換**(部分更新でない)。
 *  (e) **★集計島は1テーブルしか入力に取れず coupon/shipping/tax テーブルを join できない** ——
 *      価格設定は島に定数で焼き込むしかなく、「注文ごとに coupon 行を引いて適用」は**成立しない**。
 *      本テストは config を差し替えて計算の正しさを証明するが、注文別クーポン引きは別経路が要る。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifestDdl } from "../../src/kernel/ddl.ts";
import { ensureIslandRuntimeReady } from "../../src/kernel/island-runner.ts";
import { createRecord, listRecords, type RecordRow } from "../../src/kernel/records.ts";
import { appDbPath } from "../../src/kernel/storage-paths.ts";
import type { FunctionDef, FunctionInput, Manifest, Workflow } from "../../src/kernel/types.ts";
import { OWNER_FIELD } from "../../src/server/owner-scope.ts";
import { seedSession } from "../../src/server/test-helpers.ts";
import {
  CART_TOTALS_ISLAND,
  DEFAULT_SHIPPING,
  DEFAULT_TAX,
  LINE_TOTAL_ISLAND,
  ORDER_TOTALS_ISLAND,
  type PricingConfig,
  totalsIsland,
} from "./functions.ts";
import { referenceEcManifest } from "./manifest.ts";

beforeAll(async () => {
  // 同期の runIslandSync は未ロードだと fail-closed する。先にロードしておく。
  await ensureIslandRuntimeReady();
});

const APP_ID = "ref-ec-fn";

/** 履歴テーブルの5列(規約どおり)。 */
function historyFields() {
  return [
    { id: "ran_at", name: "実行時刻", type: "date" as const },
    { id: "workflow", name: "ワークフロー", type: "text" as const },
    { id: "trigger_type", name: "きっかけ", type: "text" as const },
    { id: "status", name: "結果", type: "text" as const },
    { id: "error", name: "エラー", type: "long_text" as const },
  ];
}

let dataRoot: string;
let db: Database;
/**
 * **【2026-08-10(`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-58` / `D-V8-65`)で足した】**
 * **この検査群が書き込むときの「書き手」の識別子。** 下の {@link openWritesToKernelActor} を見よ。
 */
let kernelActorId: string;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-ref-ec-fn-"));
  await mkdir(join(dataRoot, "apps", APP_ID), { recursive: true });
  db = new Database(appDbPath(dataRoot, APP_ID), { create: true });
  // **本物の利用者行を1人だけ作る**(`_auth_users`)。**HTTP は1度も通さない。**
  kernelActorId = seedSession(dataRoot, APP_ID, { role: KERNEL_ACTOR_ROLE }).userId;
});

afterEach(async () => {
  db.close();
  await rm(dataRoot, { recursive: true, force: true });
});

/**
 * **【2026-08-10(`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-58` / `D-V8-65`)で足した】**
 *
 * **このファイルの検査用マニフェスト(focused manifest)に、書き手と権限を与える。**
 *
 * ## なぜ要るようになったか
 *
 * **`V8-M26` が権限の既定を「閉じる」側へ倒した** —— **役割を1つも宣言していないアプリでも、
 * 表・画面・ボタンは規則が無ければ誰も触れない。** **レコード書込で発火するワークフローの
 * 書込も、その判定に掛かる**(`src/kernel/workflow-runner.ts` の `judgeAutomationWrite`)。
 *
 * **判定に使われる主体は「`act_as` が無ければトリガー元の行の持ち主(`st_owner`)」であり、
 * その識別子から実効ロール集合を引くのは `_auth_users` である。** **したがって
 * 「持ち主の列が無い表」でも「実在しない利用者」でも、書き手は未ログインと同じ主体になり、
 * 集計(`output_table` 全置換)も更新操作(`write_ops`)も1件も通らない。**
 *
 * ## ここで足すもの(**島の計算には1バイトも触れていない**)
 *
 *  1. **すべての表に持ち主の列(`st_owner`)を足す** —— **書き手を解けるようにするため。**
 *  2. **役割 `customer` にすべての表の読み書き削除を許す規則を足す**(既定3役割は空で並べる)。
 *
 * **既に `roles` を持つマニフェスト(参照 EC の本体)は1バイトも触らない** ——
 * **あちらは自前の規則を持っており、`st_owner` の有無も宣言どおりだからである。**
 *
 * **【この検査群が測っているものは1ミリも変わっていない】** —— **測っているのは島の
 * 計算結果(小計・割引・送料・税・合計・重複のまとめ)であって、権限ではない。**
 */
const KERNEL_ACTOR_ROLE = "customer";
function openWritesToKernelActor(manifest: Manifest): Manifest {
  if (manifest.app.roles !== undefined) {
    return manifest;
  }
  for (const table of manifest.app.tables) {
    if (!table.fields.some((field) => field.id === OWNER_FIELD)) {
      table.fields.push({ id: OWNER_FIELD, name: "所有者", type: "text" });
    }
  }
  manifest.app.roles = [
    { id: "owner", name: "運営" },
    { id: "editor", name: "編集者" },
    { id: "viewer", name: "閲覧者" },
    {
      id: KERNEL_ACTOR_ROLE,
      name: "書き手",
      rules: manifest.app.tables.map((table) => ({
        target: "table" as const,
        table: table.id,
        can: ["read", "write", "delete"] as ("read" | "write" | "delete")[],
      })),
    },
  ] as NonNullable<Manifest["app"]["roles"]>;
  return manifest;
}

function create(manifest: Manifest, table: string, fields: Record<string, unknown>): RecordRow {
  // **持ち主の列を持つ表には、必ず書き手を焼き付ける**(上の doc の 1)。
  const declared = manifest.app.tables.find((candidate) => candidate.id === table);
  const stamped =
    declared?.fields.some((field) => field.id === OWNER_FIELD) === true &&
    fields[OWNER_FIELD] === undefined
      ? { ...fields, [OWNER_FIELD]: kernelActorId }
      : fields;
  const result = createRecord(db, manifest, table, stamped);
  if (!result.ok) {
    throw new Error(`${table} の作成に失敗: ${JSON.stringify(result.errors)}`);
  }
  return result.value;
}

// ===========================================================================
// (1) 明細金額(単価×数量)= Route B(write_back:$record)
// ===========================================================================

describe("(1) 明細金額 = Route B(write_back:$record)", () => {
  test("参照 EC の実マニフェスト: cart_line 作成で fn-line-total が line_total を行へ書き戻す", () => {
    // manifest.ts が実際に焼き込んだ島(LINE_TOTAL_ISLAND)を、実マニフェストの wf-cart-line-total
    // 経由でそのまま走らせる。cart 参照は任意なので省略し、単価×数量だけで検証する。
    const manifest = referenceEcManifest();
    applyManifestDdl(db, openWritesToKernelActor(manifest));

    const line = create(manifest, "cart_line", { quantity: 3, unit_price: 1200 });
    // 作成レスポンス自体は書き戻し前のスナップショット(line_total 未設定 = null)。
    expect(line.line_total ?? null).toBeNull();
    // Route B: 行自身を読み直すと line_total が書き戻っている(1200×3=3600)。
    const reread = listRecords(db, manifest, "cart_line");
    expect(reread.ok).toBe(true);
    if (reread.ok) {
      expect(reread.value).toHaveLength(1);
      expect(reread.value[0]?.line_total).toBe(3600);
    }
  });

  test("同じ島(fn-line-total)は order_line にも同型で効く(数量0・単価欠損は0)", () => {
    // 同一島 LINE_TOTAL_ISLAND を order_line の on_create に配線した focused manifest で、
    // 境界(数量0 / 単価欠損 → 0)も含めて Route B が正しく書き戻すことを示す。
    const manifest: Manifest = {
      app: {
        id: APP_ID,
        name: "line-total focused",
        tables: [
          {
            id: "order_line",
            name: "注文明細",
            fields: [
              { id: "quantity", name: "数量", type: "number", required: true },
              { id: "unit_price", name: "単価", type: "number" },
              { id: "line_total", name: "明細金額", type: "number" },
            ],
          },
          { id: "wf_runs", name: "実行履歴", fields: historyFields() },
        ],
        views: [],
        functions: [
          {
            id: "fn-line-total",
            name: "明細金額",
            code: LINE_TOTAL_ISLAND,
            input: { source: "record" },
            output: { fields: [{ id: "line_total", type: "number" }] },
          },
        ],
        workflows: [
          {
            id: "wf-ol-total",
            name: "注文明細金額",
            trigger: { type: "on_create", table: "order_line" },
            actions: [{ action: "run_function", function: "fn-line-total", write_back: "$record" }],
            history_table: "wf_runs",
          },
        ],
      },
    };
    applyManifestDdl(db, openWritesToKernelActor(manifest));

    create(manifest, "order_line", { quantity: 4, unit_price: 250 }); // 1000
    create(manifest, "order_line", { quantity: 0, unit_price: 999 }); // 0
    create(manifest, "order_line", { quantity: 5 }); // 単価欠損 → 0

    const rows = listRecords(db, manifest, "order_line");
    expect(rows.ok).toBe(true);
    if (rows.ok) {
      expect(rows.value.map((r) => r.line_total).sort((a, b) => Number(a) - Number(b))).toEqual([
        0, 0, 1000,
      ]);
    }
  });
});

// ===========================================================================
// (2) 集計(小計・クーポン割引・送料・税・合計)= output_table 全置換
// ===========================================================================

/**
 * cart(参照先)/ cart_line(集計入力)/ cart_totals(参照付き集計出力・全置換)/ 履歴 の
 * focused manifest。集計 function は `totalsIsland(config)` を差す(config を差し替えて
 * percent/fixed/free_over/税 を実挙動で証明する)。**cart_totals.cart は参照**なので、実マニフェスト
 * と同じ FK 検証(実在 cart を指す)を通る。
 */
function cartTotalsManifest(config: Omit<PricingConfig, "group_field">): Manifest {
  const fn: FunctionDef = {
    id: "fn-cart-totals",
    name: "カート合計",
    code: totalsIsland({ group_field: "cart", ...config }),
    input: { source: "table", table: "cart_line" },
    output: {
      fields: [
        { id: "cart", type: "text" },
        { id: "subtotal", type: "number" },
        { id: "discount", type: "number" },
        { id: "shipping_fee", type: "number" },
        { id: "tax", type: "number" },
        { id: "total", type: "number" },
      ],
    },
  };
  const wf: Workflow = {
    id: "wf-cart-totals",
    name: "カート合計集計",
    trigger: { type: "on_create", table: "cart_line" },
    actions: [{ action: "run_function", function: "fn-cart-totals", output_table: "cart_totals" }],
    history_table: "wf_runs",
  };
  return {
    app: {
      id: APP_ID,
      name: "cart totals focused",
      tables: [
        { id: "cart", name: "カート", fields: [{ id: "status", name: "状態", type: "text" }] },
        {
          id: "cart_line",
          name: "カート明細",
          fields: [
            { id: "cart", name: "カート", type: "reference", reference_table: "cart" },
            { id: "quantity", name: "数量", type: "number", required: true },
            { id: "unit_price", name: "単価", type: "number" },
            { id: "line_total", name: "小計", type: "number" },
          ],
        },
        {
          id: "cart_totals",
          name: "カート合計",
          fields: [
            { id: "cart", name: "カート", type: "reference", reference_table: "cart" },
            { id: "subtotal", name: "小計", type: "number" },
            { id: "discount", name: "割引", type: "number" },
            { id: "shipping_fee", name: "送料", type: "number" },
            { id: "tax", name: "税", type: "number" },
            { id: "total", name: "合計", type: "number" },
          ],
        },
        { id: "wf_runs", name: "実行履歴", fields: historyFields() },
      ],
      views: [],
      functions: [fn],
      workflows: [wf],
    },
  };
}

/** cart を1件作り、line_total 付き cart_line を順に入れ、最終の cart_totals 行(単一 cart 前提)を返す。 */
function runCartTotals(
  manifest: Manifest,
  lineTotals: number[],
): { subtotal: number; discount: number; shipping_fee: number; tax: number; total: number } {
  applyManifestDdl(db, openWritesToKernelActor(manifest));
  const cart = create(manifest, "cart", { status: "open" });
  for (const lt of lineTotals) {
    // 集計入力として line_total を直接与える(Route B と集計が別経路であることを保つ)。
    create(manifest, "cart_line", { cart: cart._id, quantity: 1, unit_price: lt, line_total: lt });
  }
  const totals = listRecords(db, manifest, "cart_totals");
  if (!totals.ok || totals.value.length !== 1) {
    throw new Error(`cart_totals が1行になりませんでした: ${JSON.stringify(totals)}`);
  }
  const r = totals.value[0] as RecordRow;
  expect(r.cart).toBe(cart._id); // 参照(FK)が実在 cart を指す
  return {
    subtotal: Number(r.subtotal),
    discount: Number(r.discount),
    shipping_fee: Number(r.shipping_fee),
    tax: Number(r.tax),
    total: Number(r.total),
  };
}

describe("(2) 集計: 小計・クーポン割引・送料・税・合計(output_table 全置換)", () => {
  test("percent クーポン + 送料課金(free_over 未満)+ 税", () => {
    // subtotal=4400, percent10 → floor(440)=440, 4400<5000 → 送料500, tax floor(440)=440
    // total = 4400 - 440 + 500 + 440 = 4900
    const m = cartTotalsManifest({
      coupon: { type: "percent", value: 10 },
      shipping: { base_fee: 500, free_over: 5000 },
      tax: { rate: 0.1 },
    });
    expect(runCartTotals(m, [3600, 800])).toEqual({
      subtotal: 4400,
      discount: 440,
      shipping_fee: 500,
      tax: 440,
      total: 4900,
    });
  });

  test("fixed クーポン + 送料無料(free_over ちょうど到達)+ 税", () => {
    // subtotal=5000, fixed800 → 800, 5000>=5000 → 送料0, tax floor(5000×0.08)=400
    // total = 5000 - 800 + 0 + 400 = 4600
    const m = cartTotalsManifest({
      coupon: { type: "fixed", value: 800 },
      shipping: { base_fee: 500, free_over: 5000 },
      tax: { rate: 0.08 },
    });
    expect(runCartTotals(m, [2500, 2500])).toEqual({
      subtotal: 5000,
      discount: 800,
      shipping_fee: 0,
      tax: 400,
      total: 4600,
    });
  });

  test("free_over 境界: ちょうど1円下は送料課金 + 税は Math.floor で切り捨て(4999→499)", () => {
    // subtotal=4999(<5000)→ 送料500。tax floor(4999×0.10)=floor(499.9)=499 ← 丸めが効く箇所
    // total = 4999 - 0 + 500 + 499 = 5998
    const m = cartTotalsManifest({
      coupon: null,
      shipping: { base_fee: 500, free_over: 5000 },
      tax: { rate: 0.1 },
    });
    expect(runCartTotals(m, [4999])).toEqual({
      subtotal: 4999,
      discount: 0,
      shipping_fee: 500,
      tax: 499,
      total: 5998,
    });
  });

  test("percent の端数も Math.floor(1055×10%→105.5→105)+ グループごとに送料の両側が出る", () => {
    // 複数 cart を1回の全置換で束ね、free_over の両側(未満=送料 / 到達=無料)を同時に示す。
    const m = cartTotalsManifest({
      coupon: { type: "percent", value: 10 },
      shipping: { base_fee: 500, free_over: 5000 },
      tax: { rate: 0.1 },
    });
    applyManifestDdl(db, openWritesToKernelActor(m));
    const cartX = create(m, "cart", { status: "open" }); // subtotal 1055(<5000)
    const cartY = create(m, "cart", { status: "open" }); // subtotal 6000(>=5000)
    create(m, "cart_line", { cart: cartX._id, quantity: 1, unit_price: 1000, line_total: 1000 });
    create(m, "cart_line", { cart: cartX._id, quantity: 1, unit_price: 55, line_total: 55 });
    create(m, "cart_line", { cart: cartY._id, quantity: 1, unit_price: 6000, line_total: 6000 });

    const totals = listRecords(db, m, "cart_totals", { sort: { field: "subtotal", order: "asc" } });
    expect(totals.ok).toBe(true);
    if (totals.ok) {
      expect(
        totals.value.map((r) => ({
          cart: r.cart,
          subtotal: r.subtotal,
          discount: r.discount,
          shipping_fee: r.shipping_fee,
          tax: r.tax,
          total: r.total,
        })),
      ).toEqual([
        // X: percent floor(105.5)=105, 送料500(1055<5000), tax floor(105.5)=105, 1055-105+500+105=1555
        {
          cart: cartX._id,
          subtotal: 1055,
          discount: 105,
          shipping_fee: 500,
          tax: 105,
          total: 1555,
        },
        // Y: percent floor(600)=600, 送料0(6000>=5000), tax floor(600)=600, 6000-600+0+600=6000
        { cart: cartY._id, subtotal: 6000, discount: 600, shipping_fee: 0, tax: 600, total: 6000 },
      ]);
    }
  });

  test("line_total 欠損時は unit_price×quantity で代替して小計を出す(集計側フォールバック)", () => {
    const m = cartTotalsManifest({
      coupon: null,
      shipping: { base_fee: 500, free_over: 5000 },
      tax: { rate: 0.1 },
    });
    applyManifestDdl(db, openWritesToKernelActor(m));
    const cart = create(m, "cart", { status: "open" });
    // line_total を渡さない → 島が unit_price×quantity=1200×2=2400 で代替。
    create(m, "cart_line", { cart: cart._id, quantity: 2, unit_price: 1200 });
    const totals = listRecords(db, m, "cart_totals");
    expect(totals.ok && totals.value[0]?.subtotal).toBe(2400);
    expect(totals.ok && totals.value[0]?.total).toBe(2400 + 500 + 240); // 送料500 + tax240
  });

  test("全置換: 明細追加のたびに古い集計は残らない(部分更新でない)", () => {
    const m = cartTotalsManifest({
      coupon: null,
      shipping: { base_fee: 500, free_over: 5000 },
      tax: { rate: 0.1 },
    });
    applyManifestDdl(db, openWritesToKernelActor(m));
    const cart = create(m, "cart", { status: "open" });
    create(m, "cart_line", { cart: cart._id, quantity: 1, unit_price: 1000, line_total: 1000 });
    let totals = listRecords(db, m, "cart_totals");
    expect(totals.ok && totals.value).toHaveLength(1);
    expect(totals.ok && totals.value[0]?.subtotal).toBe(1000);

    create(m, "cart_line", { cart: cart._id, quantity: 1, unit_price: 500, line_total: 500 });
    totals = listRecords(db, m, "cart_totals");
    // 全置換なので 1 行のまま subtotal=1500(古い {1000} は残らない)。
    expect(totals.ok && totals.value).toHaveLength(1);
    expect(totals.ok && totals.value[0]?.subtotal).toBe(1500);
  });
});

// ===========================================================================
// (3) manifest.ts に焼き込んだ既定島がそのまま走る(既定価格設定)
// ===========================================================================

describe("(3) manifest.ts の既定島(既定価格設定)がそのまま走る", () => {
  test("焼き込み byte 一致: 既定島は totalsIsland(既定設定)と同一ソース", () => {
    expect(CART_TOTALS_ISLAND).toBe(
      totalsIsland({
        group_field: "cart",
        coupon: null,
        shipping: { ...DEFAULT_SHIPPING },
        tax: { ...DEFAULT_TAX },
      }),
    );
    expect(ORDER_TOTALS_ISLAND).toBe(
      totalsIsland({
        group_field: "order",
        coupon: null,
        shipping: { ...DEFAULT_SHIPPING },
        tax: { ...DEFAULT_TAX },
      }),
    );
    // 実マニフェストの function がこの島を実際に持っている。
    const fns = referenceEcManifest().app.functions ?? [];
    expect(fns.find((f) => f.id === "fn-cart-totals")?.code).toBe(CART_TOTALS_ISLAND);
    expect(fns.find((f) => f.id === "fn-order-totals")?.code).toBe(ORDER_TOTALS_ISLAND);
    expect(fns.find((f) => f.id === "fn-line-total")?.code).toBe(LINE_TOTAL_ISLAND);
  });

  test("実マニフェストの fn-order-totals を run_function で走らせ既定設定の合計が出る", () => {
    // referenceEcManifest() の FunctionDef(= manifest.ts が焼き込んだ既定島)を直接配線して実行。
    // 既定はクーポン null / 送料500・無料5000 / 税10%。
    //
    // **V3-M11-T02 で更新した1点(期待値ではなく構成)**: 実マニフェストの fn-order-totals は
    // 入力に shipping_method / tax_rate / coupon を宣言するようになったので、この focused
    // manifest にも同じ3表を置く(**行は1件も入れない**)。置かないと resolveFunctionInput が
    // 「入力テーブルを読めませんでした」で fail-closed し、集計行が0件になる(実測)。
    // **期待する金額(4400 / 0 / 500 / 440 / 5340)は1バイトも変えていない** —— 表が空なので
    // 島に残った既定値が使われ、焼き込み時代と同じ数になる。
    const src = referenceEcManifest();
    const orderTotalsFn = (src.app.functions ?? []).find((f) => f.id === "fn-order-totals");
    if (orderTotalsFn === undefined) {
      throw new Error("fn-order-totals が実マニフェストにありません");
    }
    const manifest: Manifest = {
      app: {
        id: APP_ID,
        name: "order totals wired",
        tables: [
          { id: "order", name: "注文", fields: [{ id: "status", name: "状態", type: "text" }] },
          {
            id: "order_line",
            name: "注文明細",
            fields: [
              { id: "order", name: "注文", type: "reference", reference_table: "order" },
              { id: "quantity", name: "数量", type: "number", required: true },
              { id: "unit_price", name: "単価", type: "number" },
              { id: "line_total", name: "明細金額", type: "number" },
            ],
          },
          {
            id: "order_totals",
            name: "注文合計",
            fields: [
              { id: "order", name: "注文", type: "reference", reference_table: "order" },
              { id: "subtotal", name: "小計", type: "number" },
              { id: "discount", name: "割引", type: "number" },
              { id: "shipping_fee", name: "送料", type: "number" },
              { id: "tax", name: "税", type: "number" },
              { id: "total", name: "合計", type: "number" },
            ],
          },
          // V3-M11-T02: 入力宣言に現れる3表(**行は1件も入れない** = 既定値が使われる)。
          {
            id: "shipping_method",
            name: "配送方法",
            fields: [
              { id: "name", name: "名称", type: "text", required: true },
              { id: "base_fee", name: "基本送料", type: "number" },
              { id: "free_over", name: "無料になる金額", type: "number" },
            ],
          },
          {
            id: "tax_rate",
            name: "税率",
            fields: [
              { id: "name", name: "名称", type: "text", required: true },
              { id: "rate", name: "税率", type: "number" },
            ],
          },
          {
            id: "coupon",
            name: "クーポン",
            fields: [
              { id: "code", name: "コード", type: "text", unique: true },
              {
                id: "discount_type",
                name: "割引種別",
                type: "select",
                options: ["percent", "fixed"],
              },
              { id: "discount_value", name: "割引値", type: "number" },
              { id: "is_active", name: "有効", type: "boolean" },
            ],
          },
          { id: "wf_runs", name: "実行履歴", fields: historyFields() },
        ],
        views: [],
        functions: [orderTotalsFn],
        workflows: [
          {
            id: "wf-order-totals",
            name: "注文合計集計",
            trigger: { type: "on_create", table: "order_line" },
            actions: [
              { action: "run_function", function: "fn-order-totals", output_table: "order_totals" },
            ],
            history_table: "wf_runs",
          },
        ],
      },
    };
    applyManifestDdl(db, openWritesToKernelActor(manifest));
    const order = create(manifest, "order", { status: "pending_payment" });
    create(manifest, "order_line", {
      order: order._id,
      quantity: 1,
      unit_price: 3600,
      line_total: 3600,
    });
    create(manifest, "order_line", {
      order: order._id,
      quantity: 1,
      unit_price: 800,
      line_total: 800,
    });
    // subtotal=4400, 既定はクーポン無 → discount0, 4400<5000 → 送料500, tax floor(440)=440
    // total = 4400 - 0 + 500 + 440 = 5340
    const totals = listRecords(db, manifest, "order_totals");
    expect(totals.ok).toBe(true);
    if (totals.ok) {
      expect(totals.value).toHaveLength(1);
      expect(totals.value[0]).toMatchObject({
        order: order._id,
        subtotal: 4400,
        discount: 0,
        shipping_fee: 500,
        tax: 440,
        total: 5340,
      });
    }
  });
});

// ===========================================================================
// (4) 焼き込み定数をテーブルの現在値へ置き換える(V3-M11-T02。ADR-0062 の複数入力)
// ===========================================================================

/**
 * `referenceEcManifest()` が実際に持っている `fn-order-totals` を、**実マニフェストと同じ
 * 入力宣言のまま**走らせるための focused manifest。
 *
 * **(3) の focused manifest との違いは、`shipping_method` / `tax_rate` / `coupon` の3表を
 * 置いたことだけである** —— 実マニフェストの `fn-order-totals` が入力にこの3表を宣言する
 * ようになったので、表が無いと `resolveFunctionInput` が fail-closed する
 * (`src/kernel/workflow-runner.ts:1206` 「入力テーブル "…" を読めませんでした」)。
 *
 * **`order` テーブルは入力宣言に入っていない**(要素数は4。ADR-0062 限定3 の `maxItems: 5`
 * に収める + メインの裁定「既存3表を使う・最大4」)。よって島は `order.coupon` /
 * `order.shipping_method` の参照に**手が届かない** —— それが (4-5) の実測の対象である。
 */
function orderTotalsFromTablesManifest(): Manifest {
  const orderTotalsFn = (referenceEcManifest().app.functions ?? []).find(
    (f) => f.id === "fn-order-totals",
  );
  if (orderTotalsFn === undefined) {
    throw new Error("fn-order-totals が実マニフェストにありません");
  }
  return {
    app: {
      id: APP_ID,
      name: "order totals from tables",
      tables: [
        {
          id: "order",
          name: "注文",
          fields: [
            { id: "status", name: "状態", type: "text" },
            // 「この注文に当たるクーポン」はここに在る。**島の入力ではない。**
            { id: "coupon", name: "適用クーポン", type: "reference", reference_table: "coupon" },
          ],
        },
        {
          id: "order_line",
          name: "注文明細",
          fields: [
            { id: "order", name: "注文", type: "reference", reference_table: "order" },
            { id: "quantity", name: "数量", type: "number", required: true },
            { id: "unit_price", name: "単価", type: "number" },
            { id: "line_total", name: "明細金額", type: "number" },
          ],
        },
        {
          id: "order_totals",
          name: "注文合計",
          fields: [
            { id: "order", name: "注文", type: "reference", reference_table: "order" },
            { id: "subtotal", name: "小計", type: "number" },
            { id: "discount", name: "割引", type: "number" },
            { id: "shipping_fee", name: "送料", type: "number" },
            { id: "tax", name: "税", type: "number" },
            { id: "total", name: "合計", type: "number" },
          ],
        },
        // --- 焼き込みの置き換え先(実マニフェストと同じ3表。フィールド定義も同じ)-------
        {
          id: "coupon",
          name: "クーポン",
          fields: [
            { id: "code", name: "コード", type: "text", unique: true },
            {
              id: "discount_type",
              name: "割引種別",
              type: "select",
              options: ["percent", "fixed"],
            },
            { id: "discount_value", name: "割引値", type: "number" },
            { id: "is_active", name: "有効", type: "boolean" },
          ],
        },
        {
          id: "shipping_method",
          name: "配送方法",
          fields: [
            { id: "name", name: "名称", type: "text", required: true },
            { id: "base_fee", name: "基本送料", type: "number" },
            { id: "free_over", name: "無料になる金額", type: "number" },
          ],
        },
        {
          id: "tax_rate",
          name: "税率",
          fields: [
            { id: "name", name: "名称", type: "text", required: true },
            { id: "rate", name: "税率", type: "number" },
          ],
        },
        { id: "wf_runs", name: "実行履歴", fields: historyFields() },
      ],
      views: [],
      functions: [orderTotalsFn],
      workflows: [
        {
          id: "wf-order-totals",
          name: "注文合計集計",
          trigger: { type: "on_create", table: "order_line" },
          actions: [
            { action: "run_function", function: "fn-order-totals", output_table: "order_totals" },
          ],
          history_table: "wf_runs",
        },
      ],
    },
  };
}

/** 注文を1件作り、明細を入れ、その注文の集計行を返す。 */
function totalsOf(
  manifest: Manifest,
  orderId: string,
): { subtotal: number; discount: number; shipping_fee: number; tax: number; total: number } {
  const rows = listRecords(db, manifest, "order_totals");
  if (!rows.ok) {
    throw new Error(`order_totals を読めませんでした: ${JSON.stringify(rows)}`);
  }
  const r = rows.value.find((x) => x.order === orderId);
  if (r === undefined) {
    throw new Error(`注文 ${orderId} の集計行がありません: ${JSON.stringify(rows.value)}`);
  }
  return {
    subtotal: Number(r.subtotal),
    discount: Number(r.discount),
    shipping_fee: Number(r.shipping_fee),
    tax: Number(r.tax),
    total: Number(r.total),
  };
}

describe("(4) 焼き込み定数をテーブルの現在値へ置き換える(ADR-0062 の複数入力)", () => {
  test("(4-1) 実マニフェストの集計 function の入力は配列形・要素4・全部 source=table(重複なし)", () => {
    const fns = referenceEcManifest().app.functions ?? [];
    for (const [id, lineTable] of [
      ["fn-order-totals", "order_line"],
      ["fn-cart-totals", "cart_line"],
    ] as const) {
      const found = fns.find((f) => f.id === id);
      if (found === undefined) {
        throw new Error(`${id} が実マニフェストにありません`);
      }
      const input = found.input;
      expect(Array.isArray(input), `${id} の input は配列形`).toBe(true);
      const list = input as FunctionInput[];
      // ADR-0062 限定3: maxItems = 5。メインの裁定: 要素数は最大4(再審査条件 (e) 非発火)。
      expect(list, `${id} の要素数`).toHaveLength(4);
      expect(list.every((one) => one.source === "table")).toBe(true);
      const tables = list.map((one) => (one.source === "table" ? one.table : ""));
      // 明細表 + 既存3表(新しい表を1本も作らない)。
      expect(tables).toEqual([lineTable, "shipping_method", "tax_rate", "coupon"]);
      // uniqueItems(ADR-0062 限定5)を実地でも満たす。
      expect(new Set(tables).size).toBe(4);
      // **`order` / `cart` は入力に入っていない** —— 「この注文のクーポン」を選ぶ鍵は島に届かない。
      expect(tables).not.toContain("order");
      expect(tables).not.toContain("cart");
    }
  });

  test("(4-1b) スキーマの上限は maxItems=5 であり、宣言した4はその内側である", () => {
    const schema = JSON.parse(
      readFileSync(join(import.meta.dir, "../../schemas/manifest.schema.json"), "utf-8"),
    ) as {
      $defs: {
        function: { properties: { input: { allOf: { then?: { maxItems?: number } }[] } } };
      };
    };
    const maxItems = schema.$defs.function.properties.input.allOf
      .map((branch) => branch.then?.maxItems)
      .find((v) => v !== undefined);
    expect(maxItems).toBe(5);
  });

  test("(4-2) 表の値を焼き込みと同じにすると合計は1円も変わらない", () => {
    const m = orderTotalsFromTablesManifest();
    applyManifestDdl(db, openWritesToKernelActor(m));
    // **焼き込み(DEFAULT_SHIPPING / DEFAULT_TAX)と同じ値**を表に入れる。
    create(m, "shipping_method", {
      name: "標準",
      base_fee: DEFAULT_SHIPPING.base_fee,
      free_over: DEFAULT_SHIPPING.free_over,
    });
    create(m, "tax_rate", { name: "標準税率", rate: DEFAULT_TAX.rate });
    const order = create(m, "order", { status: "pending_payment" });
    create(m, "order_line", { order: order._id, quantity: 1, unit_price: 3600, line_total: 3600 });
    create(m, "order_line", { order: order._id, quantity: 1, unit_price: 800, line_total: 800 });
    // (3) の焼き込み時代とまったく同じ数(4400 / 0 / 500 / 440 / 5340)。
    expect(totalsOf(m, String(order._id))).toEqual({
      subtotal: 4400,
      discount: 0,
      shipping_fee: 500,
      tax: 440,
      total: 5340,
    });
  });

  test("(4-3) 表の値を変えると合計が変わる(島が表を実際に読んでいる)", () => {
    const m = orderTotalsFromTablesManifest();
    applyManifestDdl(db, openWritesToKernelActor(m));
    // 焼き込みと違う値: 送料800・無料閾値10万(= 実質いつも課金)・税率20%。
    create(m, "shipping_method", { name: "速達", base_fee: 800, free_over: 100000 });
    create(m, "tax_rate", { name: "高税率", rate: 0.2 });
    const order = create(m, "order", { status: "pending_payment" });
    create(m, "order_line", { order: order._id, quantity: 1, unit_price: 3600, line_total: 3600 });
    create(m, "order_line", { order: order._id, quantity: 1, unit_price: 800, line_total: 800 });
    // 4400 - 0 + 800 + floor(4400×0.2)=880 → 6080。**焼き込み時代の 5340 ではない。**
    expect(totalsOf(m, String(order._id))).toEqual({
      subtotal: 4400,
      discount: 0,
      shipping_fee: 800,
      tax: 880,
      total: 6080,
    });
  });

  test("(4-4) 表が空のときは島に残った既定値が使われる(定数は消えていない)", () => {
    const m = orderTotalsFromTablesManifest();
    applyManifestDdl(db, openWritesToKernelActor(m));
    // shipping_method / tax_rate に1行も入れない。
    const order = create(m, "order", { status: "pending_payment" });
    create(m, "order_line", { order: order._id, quantity: 1, unit_price: 4400, line_total: 4400 });
    expect(totalsOf(m, String(order._id))).toEqual({
      subtotal: 4400,
      discount: 0,
      shipping_fee: DEFAULT_SHIPPING.base_fee,
      tax: Math.floor(4400 * DEFAULT_TAX.rate),
      total: 4400 + DEFAULT_SHIPPING.base_fee + Math.floor(4400 * DEFAULT_TAX.rate),
    });
    // **既定値は島のソースに JSON リテラルとして今日も焼き込まれている**(逐語で固定する)。
    expect(ORDER_TOTALS_ISLAND).toContain('"base_fee":500');
    expect(ORDER_TOTALS_ISLAND).toContain('"free_over":5000');
    expect(ORDER_TOTALS_ISLAND).toContain('"rate":0.1');
  });

  test("(4-5) 有効クーポンが2行あると、注文ごとに違うクーポンを指していても1円も当たらない", () => {
    const m = orderTotalsFromTablesManifest();
    applyManifestDdl(db, openWritesToKernelActor(m));
    const c1 = create(m, "coupon", {
      code: "A10",
      discount_type: "percent",
      discount_value: 10,
      is_active: true,
    });
    const c2 = create(m, "coupon", {
      code: "B500",
      discount_type: "fixed",
      discount_value: 500,
      is_active: true,
    });
    // **注文は「どのクーポンか」を持っている**(order.coupon の参照)。
    const o1 = create(m, "order", { status: "pending_payment", coupon: c1._id });
    const o2 = create(m, "order", { status: "pending_payment", coupon: c2._id });
    create(m, "order_line", { order: o1._id, quantity: 1, unit_price: 4400, line_total: 4400 });
    create(m, "order_line", { order: o2._id, quantity: 1, unit_price: 4400, line_total: 4400 });
    // **島は coupon 表の2行を受け取っているが、どちらがこの注文のものかを選べない** ——
    // 鍵(order.coupon)は入力に無く、カーネルは参照を1ホップも辿らない(ADR-0062 §限界1/2)。
    for (const id of [o1._id, o2._id]) {
      expect(totalsOf(m, String(id)), `注文 ${String(id)}`).toEqual({
        subtotal: 4400,
        discount: 0,
        shipping_fee: 500,
        tax: 440,
        total: 5340,
      });
    }
  });

  test("(4-6) 有効クーポンが1行だと、そのクーポンを指していない注文にも当たる(店舗共通の一律割引)", () => {
    const m = orderTotalsFromTablesManifest();
    applyManifestDdl(db, openWritesToKernelActor(m));
    const c1 = create(m, "coupon", {
      code: "A10",
      discount_type: "percent",
      discount_value: 10,
      is_active: true,
    });
    const withCoupon = create(m, "order", { status: "pending_payment", coupon: c1._id });
    // **クーポンを1つも指していない注文。**
    const withoutCoupon = create(m, "order", { status: "pending_payment" });
    create(m, "order_line", {
      order: withCoupon._id,
      quantity: 1,
      unit_price: 4400,
      line_total: 4400,
    });
    create(m, "order_line", {
      order: withoutCoupon._id,
      quantity: 1,
      unit_price: 4400,
      line_total: 4400,
    });
    // 両方に 440(= floor(4400×10%))が当たる。**注文別ではない。**
    for (const id of [withCoupon._id, withoutCoupon._id]) {
      expect(totalsOf(m, String(id)), `注文 ${String(id)}`).toEqual({
        subtotal: 4400,
        discount: 440,
        shipping_fee: 500,
        tax: 440,
        total: 4900,
      });
    }
  });

  test("(4-7) RUN_FUNCTION_LIMITS の3値は1バイトも変わっていない(ADR-0062 限定6)", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/kernel/workflow-runner.ts"), "utf-8");
    expect(src).toContain("const RUN_FUNCTION_LIMITS: IslandLimits = {\n  timeoutMillis: 1000,");
    expect(src).toContain("memoryBytes: 64 * 1024 * 1024,");
    expect(src).toContain("maxInputBytes: 1024 * 1024,");
  });

  test("(4-8) list_view の filter に $record を1つも書いていない(ADR-0062 改訂2 の罠)", () => {
    // 書いても apply 時に拒否されず、リテラル文字列として静かに通って実行時に0行になる。
    // **書かない**ことを機械的に固定する(将来書いたらここが赤くなる)。
    const views = referenceEcManifest().app.views;
    expect(JSON.stringify(views)).not.toContain("$record");
    // 集計 function も view 経由の入力を1つも使っていない(source は table だけ)。
    for (const fn of referenceEcManifest().app.functions ?? []) {
      const list = Array.isArray(fn.input) ? fn.input : [fn.input];
      expect(list.some((one) => one.source === "view")).toBe(false);
    }
  });
});
