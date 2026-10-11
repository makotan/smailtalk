/**
 * **一覧の束ねるキー(`group_by`)を書いても、一覧の読取の応答が変わらないことの実測**
 * (`V20-M4-T01` の (b) / (c) / (d) のサーバ側。条文 = `ADR-0470` / `ADR-0461`、メインの裁定3〜5)。
 *
 * ## ここで測るもの(**本物の SQLite / 本物の HTTP**)
 *
 * | # | 何を | 裁定 |
 * |---|---|---|
 * | (b) | **絞り込み**: 絞り込みの結果が0件の群について、サーバは行を返すだけで見出しを1つも返さない(応答のキーは `records` / `total` のまま) | 裁定3 |
 * | (c) | **ボタン**: 行の形(各行のキーの集合)が区切る前と後で1つも変わらない。見出しの行は1つも混ざらない(全行が `_id` を持つ) | 裁定4 |
 * | (d) | **母集団**: 同じ人に見える行の数と行の集合が、区切る前と後で同じ(`st_owner` を持つ表を含む) | 裁定5 |
 *
 * ## 【正直に書く】この検査が言わないこと
 *
 * 1. **並び順を1つも測っていない** —— **本葉(`V20-M4-T01` / `T02`)はサーバの並びを入れていない**
 *    (`ADR-0339` 限定7 に当たるので止めた。記録 `docs/plan/v20/records/v20-m4-t01.md` §1)。
 *    **比べるのは行の集合(`_id` を整列したもの)と件数と応答の形だけである** —— **並びが入っても
 *    この検査は書き換えずに効く**(並びは集合も件数も変えない、が主張である)。
 *    **【2026-09-24 追記】並びは後に案A で入った。** 読取の引数 `group_by=` を渡さない要求は
 *    今日も着手前と同じであり、本ファイルの3本は書き換えずに緑である。並びは
 *    `src/server/list-group-by-order.test.ts` が撃つ。
 * 2. **`st_owner` の絞り込みが効いている相手を撃っていない** —— **既定の役割の規則を足した題材では
 *    表の規則が `st_owner` の絞り込みを読取で効かなくする**(`D-V8-35`。`list-view-sum-boundary.test.ts`
 *    (C) の注と同じ)。**この題材で言えるのは「`st_owner` を持つ表でも、区切る前後で行の集合が同じ」
 *    までである。** 母集団の判定が群を1つも知らないことの構造上の担保は
 *    `src/server/record-population-home.test.ts` の (C-1) と `src/kernel/list-group-by.test.ts` の (h)。
 * 3. **ボタンを押していない** —— 押下は描画(`V20-M4-T03`)の e2e が見る。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { OWNER_FIELD } from "./owner-scope.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "list-group-by-read";

function manifest(withGroupBy: boolean): Manifest {
  const groupBy = (value: Record<string, unknown>) => (withGroupBy ? { group_by: value } : {});
  return withDefaultRoleRules({
    app: {
      id: APP_ID,
      name: "一覧の区切り",
      tables: [
        {
          id: "ticket",
          name: "チケット",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "category", name: "種類", type: "select", options: ["食品", "雑貨", "書籍"] },
            { id: "due", name: "期限", type: "date" },
          ],
        },
        {
          id: "note",
          name: "メモ",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "category", name: "種類", type: "select", options: ["食品", "雑貨"] },
            { id: OWNER_FIELD, name: "所有者", type: "text" },
          ],
        },
      ],
      views: [
        {
          id: "ticket-list",
          type: "list_view",
          table: "ticket",
          columns: ["title", "category", "due"],
          ...groupBy({ field: "category" }),
        },
        {
          id: "ticket-by-week",
          type: "list_view",
          table: "ticket",
          columns: ["title", "due"],
          ...groupBy({ field: "due", granularity: "week" }),
        },
        {
          id: "note-list",
          type: "list_view",
          table: "note",
          columns: ["title", "category"],
          ...groupBy({ field: "category" }),
        },
      ],
    },
  } as unknown as Manifest);
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-list-group-by-read-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "一覧の区切り", { app_id: APP_ID });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP_ID, manifest(false)).valid).toBe(true);
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

async function create(cookie: string, table: string, body: Record<string, unknown>): Promise<void> {
  const res = await req(cookie, "POST", recordsPath(table), body);
  expect(res.status, JSON.stringify(body)).toBe(201);
}

type Shape = {
  status: number;
  bodyKeys: string[];
  total: number;
  ids: string[];
  rowKeys: string[][];
};

async function readShape(
  cookie: string,
  table: string,
  params: Record<string, string> = {},
): Promise<Shape> {
  const query = new URLSearchParams(params).toString();
  const res = await req(cookie, "GET", `${recordsPath(table)}${query === "" ? "" : `?${query}`}`);
  const body = (await res.json()) as { records?: Record<string, unknown>[]; total?: number };
  const records = body.records ?? [];
  return {
    status: res.status,
    bodyKeys: Object.keys(body).sort(),
    total: body.total ?? -1,
    ids: records.map((row) => String(row._id)).sort(),
    rowKeys: records.map((row) => Object.keys(row).sort()),
  };
}

/** 区切る前に読み、`group_by` を書いた設計図を適用し直し、同じ要求をもう1度読む。 */
async function beforeAndAfter(
  reads: { cookie: string; table: string; params?: Record<string, string> }[],
): Promise<{ before: Shape[]; after: Shape[] }> {
  const before: Shape[] = [];
  for (const r of reads) {
    before.push(await readShape(r.cookie, r.table, r.params));
  }
  const applied = applyManifest(dataRoot, APP_ID, manifest(true));
  expect(applied.valid).toBe(true);
  const after: Shape[] = [];
  for (const r of reads) {
    after.push(await readShape(r.cookie, r.table, r.params));
  }
  return { before, after };
}

test("(b) 絞り込みで0件になる群について、サーバは行を返すだけで見出しを1つも返さない(区切る前と後で応答が同じ)", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner", username: "b-owner" }).cookie;
  await create(owner, "ticket", { title: "りんご", category: "食品", due: "2026-09-21" });
  await create(owner, "ticket", { title: "はさみ", category: "雑貨", due: "2026-09-22" });

  const { before, after } = await beforeAndAfter([
    // 行の無い群(書籍)に絞る。
    { cookie: owner, table: "ticket", params: { "filter.category": "書籍" } },
    // 行の在る群(食品)に絞る。
    { cookie: owner, table: "ticket", params: { "filter.category": "食品" } },
  ]);
  expect(before[0]).toEqual({
    status: 200,
    bodyKeys: ["records", "total"],
    total: 0,
    ids: [],
    rowKeys: [],
  });
  expect(after[0]).toEqual(before[0] as Shape);
  expect(before[1]?.total).toBe(1);
  expect(after[1]).toEqual(before[1] as Shape);
});

test("(c) 行の形は区切る前と後で1つも変わらず、見出しの行は1つも混ざらない(全行が _id を持つ)", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner", username: "c-owner" }).cookie;
  await create(owner, "ticket", { title: "りんご", category: "食品", due: "2026-09-20" });
  await create(owner, "ticket", { title: "はさみ", category: "雑貨", due: "2026-09-21" });
  await create(owner, "ticket", { title: "未分類" });

  const { before, after } = await beforeAndAfter([
    { cookie: owner, table: "ticket" },
    { cookie: owner, table: "ticket", params: { limit: "2", offset: "1" } },
  ]);
  expect(before[0]?.total).toBe(3);
  expect(after).toEqual(before);
  for (const shape of after) {
    for (const keys of shape.rowKeys) {
      expect(keys).toContain("_id");
    }
    expect(shape.ids.every((id) => id !== "undefined")).toBe(true);
  }
});

test("(d) 同じ人に見える行の数と行の集合は、区切る前と後で同じ(st_owner を持つ表を含む)", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner", username: "d-owner" }).cookie;
  const editor = seedSession(dataRoot, APP_ID, { role: "editor", username: "d-editor" }).cookie;
  const viewer = seedSession(dataRoot, APP_ID, { role: "viewer", username: "d-viewer" }).cookie;
  await create(owner, "note", { title: "持ち主の1", category: "食品" });
  await create(editor, "note", { title: "編集者の1", category: "雑貨" });
  await create(editor, "note", { title: "編集者の2" });
  await create(owner, "ticket", { title: "りんご", category: "食品", due: "2026-09-20" });

  const reads = [owner, editor, viewer].flatMap((cookie) => [
    { cookie, table: "note" },
    { cookie, table: "ticket" },
  ]);
  const { before, after } = await beforeAndAfter(reads);
  expect(after).toEqual(before);
  // 陽性対照: 比べている値は空ではない(0件どうしの一致で緑になっていない)。
  expect(before.some((shape) => shape.total > 0)).toBe(true);
});
