/**
 * **一覧の読取が、束ねるときだけ行ごとの群の値(`group_keys`)を添えること**(`V20-M4-T03`)。
 *
 * ## なぜサーバが添えるのか(**丸めの置き場**)
 *
 * **画面の見出しは、日付なら粒度で丸めた値を出す**(日 = `YYYY-MM-DD` / 週 = その週の月曜の
 * `YYYY-MM-DD` / 月 = `YYYY-MM`)。**丸めの実装はカーネルの `truncateToGranularity` の1本だけで
 * ある**(`ADR-0339` 限定7「日付の丸めを2本目にしない」)。
 * **画面(`web/`)はそれを値として import できない** —— **`ADR-0009` 限定2 が、層をまたいで値として
 * import してよいのを `normalizeSort` の1本に限っている**(見張りは `scripts/kernel-import-drift.test.ts`)。
 * しかも `report.ts` は読取(`read-records.ts`)を値で import しており、画面の束に SQLite の読取を
 * 引き込む。
 * **したがって、並べるときに使った群の値(`listGroupKey` = `truncateToGranularity` を呼ぶだけ)を、
 * サーバが応答の `group_keys` に行と同じ順で添える。** **画面は受け取った値を見出しに出すだけで、
 * 丸めを1文字も書かない**(`web/test/list-group-by.test.tsx` がソースを読んで固定する)。
 *
 * ## ここで測るもの(**本物の SQLite / 本物の HTTP**)
 *
 * | # | 何を |
 * |---|---|
 * | (k-1) | `group_by=category` の応答は `records` と同じ長さの `group_keys` を持ち、各要素がその行の値(値が無ければ `null`) |
 * | (k-2) | 日付は粒度で丸めた値(日 / 週 / 月)。週またぎ・年またぎ・日曜・月曜・時刻つきを含む日付表の手書きの期待値と一致 |
 * | (k-3) | ページを切った応答でも、`group_keys` はそのページの行と1対1 |
 * | (k-4) | `group_by` を渡さない応答には `group_keys` が1バイトも載らない(キーは `records` / `total` のまま) |
 * | (k-5) | 母集団を post-filter で閉じる表(`st_owner` を持つ表)でも同じ形 |
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { OWNER_FIELD } from "./owner-scope.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "list-group-keys";

function manifest(): Manifest {
  return withDefaultRoleRules({
    app: {
      id: APP_ID,
      name: "群の値",
      tables: [
        {
          id: "ticket",
          name: "チケット",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "category", name: "種類", type: "select", options: ["食品", "雑貨", "書籍"] },
            { id: "due", name: "期限", type: "date" },
            { id: "done", name: "済み", type: "boolean" },
          ],
        },
        {
          id: "note",
          name: "メモ",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "category", name: "種類", type: "select", options: ["食品", "雑貨"] },
            { id: OWNER_FIELD, name: "持ち主", type: "text" },
          ],
        },
      ],
      views: [
        {
          id: "ticket-list",
          type: "list_view",
          table: "ticket",
          columns: ["title", "category", "due", "done"],
        },
      ],
    },
  }) as unknown as Manifest;
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-list-group-keys-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "群の値", { app_id: APP_ID });
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

async function create(cookie: string, table: string, body: Record<string, unknown>): Promise<void> {
  const res = await req(cookie, "POST", recordsPath(table), body);
  expect(res.status, JSON.stringify(body)).toBe(201);
}

type Body = { records: Record<string, unknown>[]; total: number; group_keys?: unknown[] };

async function read(cookie: string, table: string, query: string): Promise<Body> {
  const res = await req(cookie, "GET", `${recordsPath(table)}${query === "" ? "" : `?${query}`}`);
  const body = (await res.json()) as Body;
  expect(res.status, JSON.stringify(body)).toBe(200);
  return body;
}

function owner(name: string): string {
  return seedSession(dataRoot, APP_ID, { role: "owner", username: name }).cookie;
}

/** 行の件名と群の値の組(並びごと比べる)。 */
function pairs(body: Body): [string, unknown][] {
  expect(body.group_keys).toBeDefined();
  expect(body.group_keys).toHaveLength(body.records.length);
  return body.records.map((row, index) => [String(row.title), body.group_keys?.[index]]);
}

test("(k-1) group_by=category の応答は records と同じ長さの group_keys を持ち、各要素がその行の値(値なしは null)", async () => {
  const cookie = owner("k1");
  await create(cookie, "ticket", { title: "a", category: "食品" });
  await create(cookie, "ticket", { title: "b" });
  await create(cookie, "ticket", { title: "c", category: "雑貨" });
  await create(cookie, "ticket", { title: "d", category: "食品", done: true });
  expect(pairs(await read(cookie, "ticket", "group_by=category"))).toEqual([
    ["c", "雑貨"],
    ["a", "食品"],
    ["d", "食品"],
    ["b", null],
  ]);
  // 真偽も値そのもの(文字に直さない。見出しの文字は画面が列のセルと同じ部品で作る)。
  expect(pairs(await read(cookie, "ticket", "group_by=done"))).toEqual([
    ["d", true],
    ["a", null],
    ["b", null],
    ["c", null],
  ]);
});

test("(k-2) 日付は粒度で丸めた値(日 / 週 / 月)で、日付表の手書きの期待値と一致する", async () => {
  const cookie = owner("k2");
  // 件名 = 期限の生の値。週は月曜始まり。
  const table: [string, { day: string; week: string; month: string }][] = [
    ["2026-09-20", { day: "2026-09-20", week: "2026-09-14", month: "2026-09" }], // 日曜
    ["2026-09-21", { day: "2026-09-21", week: "2026-09-21", month: "2026-09" }], // 月曜
    ["2026-09-27", { day: "2026-09-27", week: "2026-09-21", month: "2026-09" }], // 日曜(週の末)
    ["2026-10-01T09:00:00Z", { day: "2026-10-01", week: "2026-09-28", month: "2026-10" }], // 月またぎ・時刻つき
    ["2026-12-31", { day: "2026-12-31", week: "2026-12-28", month: "2026-12" }],
    ["2027-01-03", { day: "2027-01-03", week: "2026-12-28", month: "2027-01" }], // 年またぎ・日曜
  ];
  for (const [due] of table) {
    await create(cookie, "ticket", { title: due, due });
  }
  await create(cookie, "ticket", { title: "期限なし" });
  for (const granularity of ["day", "week", "month"] as const) {
    const got = pairs(await read(cookie, "ticket", `group_by=due&granularity=${granularity}`));
    const expected = new Map<string, unknown>([
      ...table.map(([due, keys]): [string, unknown] => [due, keys[granularity]]),
      ["期限なし", null],
    ]);
    expect(got.length, granularity).toBe(expected.size);
    for (const [title, key] of got) {
      expect(key, `${granularity} ${title}`).toBe(expected.get(title) as never);
    }
    // 値なしは最後。
    expect(got.at(-1), granularity).toEqual(["期限なし", null]);
  }
});

test("(k-3) ページを切った応答でも、group_keys はそのページの行と1対1", async () => {
  const cookie = owner("k3");
  for (const [title, category] of [
    ["a", "食品"],
    ["b", "雑貨"],
    ["c", "食品"],
    ["d", "雑貨"],
    ["e", null],
  ] as const) {
    await create(cookie, "ticket", category === null ? { title } : { title, category });
  }
  const whole = pairs(await read(cookie, "ticket", "group_by=category"));
  const pages = [
    ...pairs(await read(cookie, "ticket", "group_by=category&limit=2&offset=0")),
    ...pairs(await read(cookie, "ticket", "group_by=category&limit=2&offset=2")),
    ...pairs(await read(cookie, "ticket", "group_by=category&limit=2&offset=4")),
  ];
  expect(pages).toEqual(whole);
  expect(whole.map(([, key]) => key)).toEqual(["雑貨", "雑貨", "食品", "食品", null]);
});

test("(k-4) group_by を渡さない応答には group_keys が載らない(キーは records / total のまま)", async () => {
  const cookie = owner("k4");
  await create(cookie, "ticket", { title: "a", category: "食品" });
  for (const query of ["", "sort=title&order=desc", "limit=1&offset=0", "filter.category=食品"]) {
    const body = await read(cookie, "ticket", query);
    expect(Object.keys(body).sort(), query).toEqual(["records", "total"]);
  }
});

test("(k-5) 母集団を post-filter で閉じる表(st_owner を持つ表)でも、group_keys は行と1対1", async () => {
  const cookie = owner("k5");
  await create(cookie, "note", { title: "a", category: "食品" });
  await create(cookie, "note", { title: "b" });
  await create(cookie, "note", { title: "c", category: "雑貨" });
  expect(pairs(await read(cookie, "note", "group_by=category"))).toEqual([
    ["c", "雑貨"],
    ["a", "食品"],
    ["b", null],
  ]);
  expect(pairs(await read(cookie, "note", "group_by=category&limit=1&offset=1"))).toEqual([
    ["a", "食品"],
  ]);
});
