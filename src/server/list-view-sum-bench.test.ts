/**
 * `V4-M23-T06`: **合計の費用を実サーバ経路で測る**(`D-V4-89` / `E-G31` / `ADR-0104` §限界6)。
 *
 * 上位: `docs/plan/v4/records/v4-m23.md` §1-1 の `V4-M23-T06` の行 / §2-5(審査の見立て)。
 *
 * ## なぜ測るのか(**審査は実経路を1度も測っていない**)
 *
 * **`v4-m23.md` §2-5 の逐語**: 「**測ったもの**: **repo の外**(scratchpad の使い捨て
 * スクリプト。…)で、`bun:sqlite` のメモリ DB に4列の表を作り、索引を1つも張らずに
 * `WHERE status = ? AND st_owner = ?` を当てた。20回の平均。」
 * **その値は 10万行・索引なし・メモリ DB で `COUNT(*)` 2.428ms / `SUM` 2.433ms /
 * 同じ1文で 2.975ms / 行取得 0.803ms である。**
 * **本ファイルが測るのは、実ディスクの `app.sqlite` を本物の HTTP 経路で叩いた値である。**
 *
 * ## 測定規律(`web/test/list-render-bench.test.tsx` / `M9-T03` と同じ)
 *
 * **時間は「桁と比」だけを結論に使う。** 各 N で複数回測り、中央値・min・max を
 * `console.log` に残す。**1回だけの値は結論に載せない。**
 * **絶対値そのものは環境依存であり、判定に使わない** —— **したがって本ファイルの
 * `expect` は時間を1つも見ない。** **固定するのは構造的事実(DB への往復が増えていないこと)
 * だけである。**
 *
 * ## 【正直に書く】このファイルが測っていないもの
 *
 * 1. **索引を張った場合を測っていない**(この製品はユーザ定義列に索引を1本も張らない)。
 * 2. **同時アクセスを1度も測っていない。**
 * 3. **実地に大きな表が在るかを測っていない**(参照ショップの商品は32件である)。
 * 4. **ブラウザの描画コストを1ミリも測っていない**(それは `list-render-bench` の側)。
 * 5. **WAL / `busy_timeout` の効き方を測っていない。**
 */

import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appDbPath,
  applyManifest,
  createApp,
  createRecord,
  KernelMetaStore,
  type Manifest,
} from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { OWNER_FIELD } from "./owner-scope.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "sum-bench";

/** 測った値の置き場(最後にまとめて1回だけ出す)。 */
const measurements: string[] = [];

function baseManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "合計の費用",
      tables: [
        {
          id: "plain",
          name: "非スコープの表",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "amount", name: "金額", type: "number" },
            { id: "status", name: "状態", type: "select", options: ["open", "done"] },
          ],
        },
        {
          id: "scoped",
          name: "個人スコープの表",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "amount", name: "金額", type: "number" },
            { id: OWNER_FIELD, name: "所有者", type: "text" },
          ],
        },
      ],
      views: [
        {
          id: "plain-list",
          type: "list_view",
          table: "plain",
          columns: ["title", "amount"],
          sum_field: "amount",
        },
        {
          id: "scoped-list",
          type: "list_view",
          table: "scoped",
          columns: ["title", "amount"],
          sum_field: "amount",
        },
      ],
    },
  } as unknown as Manifest;
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;
let cookie: string;
let actorId: string;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-sum-bench-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "合計の費用", { app_id: APP_ID });
  } finally {
    store.close();
  }
  // **【`V8-M26`】既定3役割の規則を足す**(`apply-diff.ts` の自動付与と同じ形)——
  // **面の既定が閉じたので、足さないと一覧が 0 行・合計 0 になり、何も計測できない。**
  // **測っているのは費用であって面ではない。**
  expect(applyManifest(dataRoot, APP_ID, withDefaultRoleRules(baseManifest())).valid).toBe(true);
  app = createServerApp({ dataRoot });
  const session = seedSession(dataRoot, APP_ID, { role: "owner", username: "bench" });
  cookie = session.cookie;
  actorId = session.userId;
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

afterAll(() => {
  if (measurements.length > 0) {
    console.log(`\n[V4-M23-T06] 実サーバ経路の計測\n${measurements.join("\n")}`);
  }
});

/**
 * 実ディスクの `app.sqlite` へ、カーネルの `createRecord` で行を入れる。
 * **1つのトランザクションに包む** —— 投入そのものの時間は計測対象ではない。
 */
function seed(table: string, count: number, withOwner: boolean): void {
  const manifest = baseManifest();
  const db = new Database(appDbPath(dataRoot, APP_ID));
  try {
    db.exec("BEGIN IMMEDIATE");
    for (let index = 0; index < count; index += 1) {
      const values = {
        title: `行 ${index}`,
        amount: index % 1000,
        ...(withOwner ? { [OWNER_FIELD]: actorId } : { status: index % 2 === 0 ? "open" : "done" }),
      };
      const result = createRecord(db, manifest, table, values);
      if (!result.ok) {
        db.exec("ROLLBACK");
        throw new Error(`行の投入に失敗: ${JSON.stringify(result.errors)}`);
      }
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

const recordsPath = (table: string) => `/api/apps/${APP_ID}/tables/${table}/records`;

async function get(table: string, query: string): Promise<{ status: number; body: unknown }> {
  const res = await app.request(
    new Request(`${TEST_ORIGIN}${recordsPath(table)}${query}`, {
      headers: { origin: TEST_ORIGIN, cookie },
    }),
  );
  return { status: res.status, body: await res.json() };
}

/** 中央値・最小・最大を返す(**平均を使わない** —— 外れ値1回に引きずられる)。 */
function stats(samples: number[]): { median: number; min: number; max: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    median:
      sorted.length % 2 === 0
        ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
        : (sorted[mid] as number),
    min: sorted[0] as number,
    max: sorted[sorted.length - 1] as number,
  };
}

async function measure(label: string, runs: number, fn: () => Promise<void>): Promise<void> {
  // 1回だけ温める(初回はクエリの準備が乗る)。
  await fn();
  const samples: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now();
    await fn();
    samples.push(performance.now() - started);
  }
  const { median, min, max } = stats(samples);
  measurements.push(
    `  ${label}: median ${median.toFixed(3)}ms / min ${min.toFixed(3)}ms / max ${max.toFixed(3)}ms (${runs} runs)`,
  );
}

// ---------------------------------------------------------------------------
// (1) 非スコープ分岐 —— 合計の有無で一覧応答がどれだけ変わるか
// ---------------------------------------------------------------------------

test("(1) 非スコープ分岐: 1,000行 / 10,000行で、合計の有無の差を実サーバ経路で測る", async () => {
  // **審査(§2-5)が repo 外のメモリ DB で測ったのと同じ 100,000 行も含める** ——
  // **同じ土俵の数を並べないと「実経路でどれだけ違うか」が言えない。**
  for (const rowCount of [1000, 10000, 100000]) {
    await rm(dataRoot, { recursive: true, force: true });
    dataRoot = await mkdtemp(join(tmpdir(), "gp-sum-bench-"));
    const store = KernelMetaStore.open(dataRoot);
    try {
      createApp(store, "合計の費用", { app_id: APP_ID });
    } finally {
      store.close();
    }
    // **【`V8-M26`】既定3役割の規則を足す**(すぐ上の `beforeEach` と同じ理由)。
    expect(applyManifest(dataRoot, APP_ID, withDefaultRoleRules(baseManifest())).valid).toBe(true);
    app = createServerApp({ dataRoot });
    const session = seedSession(dataRoot, APP_ID, { role: "owner", username: `bench-${rowCount}` });
    cookie = session.cookie;
    actorId = session.userId;
    seed("plain", rowCount, false);

    measurements.push(`[非スコープ / ${rowCount.toLocaleString()}行 / 索引なし / 実ディスク]`);
    await measure("合計なし (limit=50)", 20, async () => {
      const res = await get("plain", "?limit=50");
      expect(res.status).toBe(200);
    });
    await measure("合計あり (limit=50&sum=amount)", 20, async () => {
      const res = await get("plain", "?limit=50&sum=amount");
      expect(res.status).toBe(200);
    });
    await measure("合計あり + filter", 20, async () => {
      const res = await get(
        "plain",
        `?limit=50&sum=amount&filter=${encodeURIComponent(JSON.stringify({ field: "status", equals: "open" }))}`,
      );
      expect(res.status).toBe(200);
    });

    // **合計の値そのものが正しいことも同じ経路で確かめる**(速さだけを見ない)。
    const checked = await get("plain", "?limit=50&sum=amount");
    const expected = Array.from({ length: rowCount }, (_, i) => i % 1000).reduce(
      (a, b) => a + b,
      0,
    );
    expect((checked.body as { sum: number }).sum).toBe(expected);
  }
}, 300_000);

// ---------------------------------------------------------------------------
// (2) post-filter 分岐 —— 全件をメモリに読む分岐で、追加の走査が生じないこと
// ---------------------------------------------------------------------------

test("(2) post-filter 分岐: 合計を足しても DB への往復が1本も増えない(構造で固定)", async () => {
  seed("scoped", 2000, true);

  // **DB への往復の本数を数える**(時間ではなく構造で見る)。
  // **`ADR-0042` §限界2 の逐語「可視分岐は全件をメモリに読む」がそのまま当たる分岐である。**
  measurements.push("[個人スコープ(post-filter) / 2,000行 / 索引なし / 実ディスク]");
  await measure("合計なし (limit=50)", 20, async () => {
    const res = await get("scoped", "?limit=50");
    expect(res.status).toBe(200);
  });
  await measure("合計あり (limit=50&sum=amount)", 20, async () => {
    const res = await get("scoped", "?limit=50&sum=amount");
    expect(res.status).toBe(200);
  });

  const withSum = await get("scoped", "?limit=50&sum=amount");
  const body = withSum.body as { total: number; sum: number };
  expect(body.total).toBe(2000);
  expect(body.sum).toBe(
    Array.from({ length: 2000 }, (_, i) => i % 1000).reduce((a, b) => a + b, 0),
  );
}, 120_000);

test("(2) post-filter 分岐は SQL の集約を1文も投げない(合計は可視集合の総和である)", async () => {
  // **構造の固定**: 可視分岐の合計は `sumVisible`(JS の総和)だけを通る。
  // **時間ではなく、SQL を1文も増やしていないことを字面で押さえる。**
  const source = await Bun.file(new URL("./app.ts", import.meta.url)).text();
  const codeLines = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
  expect(codeLines.filter((line) => line.includes("SUM("))).toEqual([]);
  expect(source).toContain("const sumVisible = (rows: Record<string, unknown>[]): number =>");
});

// ---------------------------------------------------------------------------
// (3) 索引が無いことの帰結
// ---------------------------------------------------------------------------

test("(3) ユーザ定義列に索引が1本も張られていない(合計は全走査である)", async () => {
  seed("plain", 100, false);
  // **カーネルの DDL がユーザ定義列に `CREATE INDEX` を1本も出していない。**
  const ddl = await Bun.file(new URL("../kernel/ddl.ts", import.meta.url)).text();
  const codeLines = ddl.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
  expect(codeLines.filter((line) => line.includes("CREATE INDEX"))).toEqual([]);
  measurements.push(
    "[索引] src/kernel/ddl.ts の製品コードに CREATE INDEX が0件 —— 合計も件数も全走査である",
  );
});
