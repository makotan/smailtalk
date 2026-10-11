/**
 * **一覧の区切りの上限と、塞がない穴の実測**(`V20-M4-T04`。メインの裁定7、`ADR-0470`)。
 *
 * ## 裁定7(群の数の上限)
 *
 * **一覧の群の数には、別の上限を置かない。** 集計表には「作る群は 10,000 件まで」
 * (`MAX_REPORT_GROUPS`。`src/server/report-limits.ts`)が在るが、一覧は行を1件ずつ出すだけで、
 * **見出しは返した行からしか作らない** —— **群の値(`group_keys`)は返した行と1対1**なので、
 * 1回の応答の群の数は、その応答の行の数を超えようがない。**画面は必ず `limit=<page_size>`
 * (10 / 20 / 50 / 100。書かなければ 50)で読む**ので、画面の見出しの数は1ページの行数を超えない。
 * 画面の側の固定は `web/test/list-group-by.test.tsx` の「T04 (a) 裁定7 …」。
 *
 * ## ここで測るもの(**本物の SQLite / 本物の HTTP**)
 *
 * | # | 何を |
 * |---|---|
 * | (L-1) | 全行が別の群になる題材(日ごとに束ねる。25行・25日)で、`limit` = 画面の件数の4値それぞれについて、群の値の数 = 行の数 ≤ `limit`、群の切れ目の数 ≤ 行の数 |
 * | (L-2) | 【塞がない穴】`limit` を渡さない読取(画面ではなく API を直に叩く読取)は全件と、全件と同じ数の群の値を返す。群の数の上限は無い |
 * | (L-3) | 【塞がない穴】群の文字の並びは JS(UTF-16)の順で、同じ項目の `sort`(SQLite のバイト順)と逆転する組が在る |
 * | (L-4) | 【塞がない穴】参照の項目で束ねると、群の順は参照先の行の番号(UUID)の文字列順である(参照先の名前の順ではない) |
 * | (L-5) | 【塞がない穴】役割の規則が名指しした項目を画面の `group_by` に書いても適用は通り、画面が送るのと同じ読取は 400 になる(画面の `sort` に書いたときと同じ) |
 * | (L-5)【2026-09-24 追記】 | **直した**(`V20-M4-T07`)。名指しした項目を画面の `group_by` に書く差分は適用の時点で拒否する(集計表の `group_by` / `search_fields` / `sum_field` と同じ側)。読取の壁(400)はそのまま残る。上の行は当時の逐語として消していない |
 *
 * **このファイルの検査は TDD の赤を経ていない** —— 主張はどれも「今日こうである」の実測であり、
 * 実装前から真である(`V20-M4-T04` の記録に書いた)。**(L-2)〜(L-5) は穴の今日の姿を固定する** ——
 * 穴を塞いだ段は、この検査を意図して書き換えること(黙って消さない)。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "list-group-limits";

/** 画面の1ページの件数として書ける4値(`$defs/view.properties.page_size` の `enum`)。 */
const PAGE_SIZES = [10, 20, 50, 100] as const;

function manifest(views: Record<string, unknown>[] = []): Manifest {
  return withDefaultRoleRules({
    app: {
      id: APP_ID,
      name: "区切りの上限",
      tables: [
        {
          id: "ticket",
          name: "チケット",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "due", name: "期限", type: "date" },
            // UTF-16 の順と UTF-8 のバイト順が逆転する2文字(全角の A と、サロゲート対の文字)。
            { id: "kind", name: "区分", type: "select", options: ["Ａ", "𠮷"] },
            { id: "vendor", name: "仕入先", type: "reference", reference_table: "vendor" },
            { id: "secret", name: "内部区分", type: "select", options: ["甲", "乙"] },
          ],
        },
        {
          id: "vendor",
          name: "仕入先",
          fields: [{ id: "vendor_name", name: "名称", type: "text", required: true }],
        },
      ],
      views: [
        {
          id: "ticket-list",
          type: "list_view",
          table: "ticket",
          columns: ["title", "due", "kind", "vendor", "secret"],
        },
        ...views,
      ],
      roles: [
        {
          id: "owner",
          name: "持ち主",
          rules: [{ target: "field", table: "ticket", field: "secret", can: ["read", "write"] }],
        },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
      ],
    },
  }) as unknown as Manifest;
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-list-group-limits-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "区切りの上限", { app_id: APP_ID });
  } finally {
    store.close();
  }
  const applied = applyManifest(dataRoot, APP_ID, manifest());
  expect(applied.valid, JSON.stringify(applied)).toBe(true);
  app = createServerApp({ dataRoot });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

function req(cookie: string, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { origin: TEST_ORIGIN, cookie };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return Promise.resolve(app.request(new Request(`http://localhost${path}`, init)));
}

const recordsPath = (table: string) => `/api/apps/${APP_ID}/tables/${table}/records`;

async function create(
  cookie: string,
  table: string,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await req(cookie, "POST", recordsPath(table), body);
  const json = (await res.json()) as { _id?: string; record?: { _id: string } };
  expect(res.status, JSON.stringify(json)).toBe(201);
  return (json._id ?? json.record?._id) as string;
}

type Body = { records: Record<string, unknown>[]; total: number; group_keys?: unknown[] };

async function get(cookie: string, query: string): Promise<{ status: number; json: Body }> {
  const res = await req(cookie, "GET", `${recordsPath("ticket")}?${query}`);
  return { status: res.status, json: (await res.json()) as Body };
}

async function read(cookie: string, query: string): Promise<Body> {
  const { status, json } = await get(cookie, query);
  expect(status, JSON.stringify(json)).toBe(200);
  return json;
}

function owner(name: string): string {
  return seedSession(dataRoot, APP_ID, { role: "owner", username: name }).cookie;
}

/** 群の切れ目の数 = 画面が出す見出しの数(連続する同じ値を1群とする。画面の `groupRecords` と同じ数え方)。 */
function runs(keys: unknown[]): number {
  return keys.filter((key, index) => index === 0 || key !== keys[index - 1]).length;
}

/** 2026-09-01 から n 日目(1日ずつ違う日付)。 */
function day(n: number): string {
  return new Date(Date.UTC(2026, 8, 1 + n)).toISOString().slice(0, 10);
}

test("(L-1) 裁定7 全行が別の群でも、1回の応答の群の数は返した行の数を超えず、行の数は limit(画面の件数の4値)を超えない", async () => {
  const cookie = owner("l1");
  const ROWS = 25;
  for (let n = 0; n < ROWS; n += 1) {
    await create(cookie, "ticket", { title: `t${n}`, due: day(n) });
  }
  for (const limit of PAGE_SIZES) {
    const body = await read(cookie, `group_by=due&granularity=day&limit=${limit}&offset=0`);
    const keys = body.group_keys ?? [];
    expect(keys, `limit=${limit}`).toHaveLength(body.records.length);
    expect(body.records.length, `limit=${limit}`).toBe(Math.min(limit, ROWS));
    expect(body.records.length, `limit=${limit}`).toBeLessThanOrEqual(limit);
    // 最悪の場合(全行が別の群)で、見出しの数 = 行の数。超えることは無い。
    expect(runs(keys), `limit=${limit}`).toBe(body.records.length);
    expect(body.total, `limit=${limit}`).toBe(ROWS);
  }
  // 2ページ目も同じ(ページの先頭の行は必ず群の始まりとして数える)。
  const second = await read(cookie, "group_by=due&granularity=day&limit=10&offset=10");
  expect(second.group_keys).toHaveLength(10);
  expect(runs(second.group_keys ?? [])).toBe(10);
  expect(second.group_keys?.[0]).toBe(day(10));
});

test("(L-2) 【塞がない穴】limit を渡さない読取は全件と、全件と同じ数の群の値を返す(群の数の上限は無い)", async () => {
  const cookie = owner("l2");
  const ROWS = 30;
  for (let n = 0; n < ROWS; n += 1) {
    await create(cookie, "ticket", { title: `t${n}`, due: day(n) });
  }
  const body = await read(cookie, "group_by=due&granularity=day");
  expect(body.records).toHaveLength(ROWS);
  expect(body.group_keys).toHaveLength(ROWS);
  expect(runs(body.group_keys ?? [])).toBe(ROWS);
});

test("(L-3) 【塞がない穴】群の文字の並びは JS(UTF-16)の順で、同じ項目の sort(SQLite のバイト順)と逆転する", async () => {
  const cookie = owner("l3");
  await create(cookie, "ticket", { title: "全角A", kind: "Ａ" });
  await create(cookie, "ticket", { title: "吉", kind: "𠮷" });
  const bySort = await read(cookie, "sort=kind&order=asc");
  const byGroup = await read(cookie, "group_by=kind");
  // SQLite(UTF-8 のバイト順): Ａ(EF BC A1)< 𠮷(F0 A0 AE B7)。
  expect(bySort.records.map((row) => row.kind)).toEqual(["Ａ", "𠮷"]);
  // JS(UTF-16 の符号単位の順): 𠮷(D842 …)< Ａ(FF21)。**逆転する。**
  expect(byGroup.group_keys).toEqual(["𠮷", "Ａ"]);
  expect(byGroup.records.map((row) => row.kind)).toEqual(["𠮷", "Ａ"]);
});

test("(L-4) 【塞がない穴】参照の項目で束ねると、群の順は参照先の行の番号(UUID)の文字列順で、群の値も行の番号である", async () => {
  const cookie = owner("l4");
  const vendorIds: string[] = [];
  for (const name of ["あ商会", "い商会", "う商会", "え商会"]) {
    vendorIds.push(await create(cookie, "vendor", { vendor_name: name }));
  }
  for (const [index, id] of vendorIds.entries()) {
    await create(cookie, "ticket", { title: `t${index}`, vendor: id });
  }
  const body = await read(cookie, "group_by=vendor");
  // 群の値は参照先の行の番号そのもの(名前ではない)。
  expect([...(body.group_keys ?? [])].sort()).toEqual([...vendorIds].sort());
  // 並びは行の番号の文字列の昇順(名前の順「あ・い・う・え」とは無関係)。
  expect(body.group_keys).toEqual([...vendorIds].sort());
});

/*
 * **【2026-09-24 追記。`V20-M4-T07`】(L-5) を意図して書き換えた(黙って消していない)。**
 * **旧テスト名**: 「(L-5) 【塞がない穴】役割の規則が名指しした項目を画面の group_by に書いても適用は通り、
 * 画面が送るのと同じ読取は 400(画面の sort と同じ)」。**旧版は適用が通ることを固定していた。**
 * 点検 `T06` の指摘1 への裁定で、一覧の `group_by` を集計表の `group_by` / `search_fields` / `sum_field`
 * と同じ側(適用の時点で拒否)に並べた。**画面の `sort` は今日どおり適用が通る**(触っていない)。
 */
test("(L-5) 【直した】役割の規則が名指しした項目を画面の group_by に書く差分は適用の時点で拒否され、読取の壁(400)は残る(画面の sort は今日どおり適用が通り 400)", async () => {
  const cookie = owner("l5");
  await create(cookie, "ticket", { title: "a", secret: "甲" });
  const groupView = {
    id: "ticket-by-secret",
    type: "list_view",
    table: "ticket",
    columns: ["title", "secret"],
    group_by: { field: "secret" },
  };
  const sortView = {
    id: "ticket-sorted-by-secret",
    type: "list_view",
    table: "ticket",
    columns: ["title", "secret"],
    sort: { field: "secret", order: "asc" },
  };
  // 一覧の group_by: 適用の時点で拒否(名指しを見る)。
  const rejected = applyManifest(dataRoot, APP_ID, manifest([groupView]));
  expect(rejected.valid).toBe(false);
  expect(JSON.stringify(rejected)).toContain("役割の規則が名指ししている項目です");
  // 画面の sort: 今日どおり適用は通る(この段は触っていない)。
  const applied = applyManifest(dataRoot, APP_ID, manifest([sortView]));
  expect(applied.valid, JSON.stringify(applied)).toBe(true);
  // 読取の壁はそのまま: 画面が送るのと同じ読取(group_by= / sort=)は、owner でも 400。
  const byGroup = await get(cookie, "group_by=secret&limit=50&offset=0");
  const bySort = await get(cookie, "sort=secret&order=asc&limit=50&offset=0");
  expect(byGroup.status).toBe(400);
  expect(bySort.status).toBe(400);
  const namedSort = await get(
    cookie,
    "sort=secret&order=asc&limit=50&offset=0&view=ticket-sorted-by-secret",
  );
  expect(namedSort.status).toBe(400);
});
