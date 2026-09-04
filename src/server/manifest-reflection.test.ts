/**
 * マニフェスト変更の動的反映(V0-P3-T07)の統合テスト。
 *
 * 確かめるのは1点だけ ——
 * **サーバを立て直さずにマニフェストを差し替えたら、次のリクエストからもう新しい
 * マニフェストで応答する**こと。これが成り立たない(= サーバがマニフェストを
 * プロセス内にキャッシュしている)と、ブラウザをリロードしても画面は古いままになり、
 * T07 の完了条件「再ビルド・再起動なしにリロードだけで反映される」が崩れる。
 *
 * そのため、ここでは `createServerApp` で作った Hono インスタンスを**一度だけ**作り、
 * 差し替えの前後で**同じインスタンス**に `request()` する。作り直さないことが
 * このテストの本質なので、`app` を再生成してはいけない。
 *
 * マニフェストを変える HTTP エンドポイントは製品側に存在しない(ADR-0003)。
 * 差し替えはカーネルの `applyManifest` を直接呼ぶ。
 *
 * 期待値はすべて**このファイルで組み立てたマニフェストから導く**。テーブル名や
 * フィールド名を文字列リテラルで期待値に書かない(CP-3 確認方法4)。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyManifest,
  createApp,
  type Field,
  KernelMetaStore,
  type Manifest,
  type Table,
  type View,
} from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { authed, seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "reflection";

/** 差し替え前のマニフェスト。テーブル1つ・ビュー1つの最小構成。 */
function baseManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "反映確認",
      tables: [
        {
          id: "base-table",
          name: "基本テーブル",
          fields: [{ id: "title", name: "見出し", type: "text", required: true }],
        },
      ],
      views: [{ id: "base-list", type: "list_view", table: "base-table", columns: ["title"] }],
    },
  };
}

/** 追加する要素(additive のみ)。期待値はここから導く。 */
const ADDED_FIELD: Field = { id: "added-note", name: "追記", type: "long_text" };
const ADDED_TABLE: Table = {
  id: "added-table",
  name: "追加テーブル",
  fields: [{ id: "label", name: "名称", type: "text", required: true }],
};
const ADDED_VIEW: View = {
  id: "added-list",
  type: "list_view",
  table: ADDED_TABLE.id,
  columns: [ADDED_TABLE.fields[0]?.id ?? ""],
};

/** 差し替え後のマニフェスト。既存要素は一切消さない(v0 は additive のみ)。 */
function extendedManifest(): Manifest {
  const next = baseManifest();
  const table = next.app.tables[0];
  if (table === undefined) {
    throw new Error("テストのマニフェストが壊れています");
  }
  table.fields.push(ADDED_FIELD);
  next.app.tables.push(ADDED_TABLE);
  next.app.views.push(ADDED_VIEW);
  return next;
}

let dataRoot: string;
/** サーバインスタンスは1回だけ作る。差し替えを跨いで使い回すことがテストの要。 */
let app: ReturnType<typeof createServerApp>;
/** 認証境界(ADR-0014)を通すためのセッション cookie。 */
let cookie: string;

/** cookie/Origin 付きで `app.request` する(認証境界の手前を通す)。 */
function request(input: string | Request, init?: RequestInit): Response | Promise<Response> {
  return app.request(authed(cookie)(input, init));
}

const base = baseManifest();
const baseTable = base.app.tables[0] as Table;
const baseField = baseTable.fields[0] as Field;

const recordsPath = (tableId: string) => `/api/apps/${APP_ID}/tables/${tableId}/records`;
const manifestPath = `/api/apps/${APP_ID}/manifest`;

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: TEST_ORIGIN },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-reflection-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, base.app.name, { app_id: APP_ID });
  } finally {
    store.close();
  }
  // **【`V8-M26`】題材に既定3役割の規則を足す** —— **実アプリは `add_table` / `add_view` を
  // 畳み込むたびに `apply-diff.ts` が同じ規則を入れる。ここは `applyManifest` を直接
  // 呼ぶので、その自動付与に乗らない。** **判定(`owner-scope.ts`)は1バイトも緩めていない。**
  const applied = applyManifest(dataRoot, APP_ID, withDefaultRoleRules(baseManifest()));
  expect(applied.valid).toBe(true);
  app = createServerApp({ dataRoot });
  cookie = seedSession(dataRoot, APP_ID).cookie;
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

test("マニフェストを差し替えると、同じサーバインスタンスのまま応答が変わる", async () => {
  // --- 差し替え前 ---
  const before = await json(await request(manifestPath));
  const beforeManifest = before as unknown as Manifest;
  expect(beforeManifest.app.tables.map((t) => t.id)).toEqual([baseTable.id]);
  expect(beforeManifest.app.views.map((v) => v.id)).toEqual(base.app.views.map((v) => v.id));
  expect((beforeManifest.app.tables[0] as Table).fields.map((f) => f.id)).not.toContain(
    ADDED_FIELD.id,
  );

  // 既存データを1件作っておく(additive な差し替えで消えないことを後で確かめる)。
  const seeded = await request(post(recordsPath(baseTable.id), { [baseField.id]: "既存" }));
  expect(seeded.status).toBe(201);
  const seededId = ((await json(seeded)).record as { _id: string })._id;

  // 追加前のテーブル・フィールドは、まだ存在しない扱い。
  expect((await request(recordsPath(ADDED_TABLE.id))).status).toBe(404);
  const rejected = await request(
    post(recordsPath(baseTable.id), { [baseField.id]: "x", [ADDED_FIELD.id]: "まだ無い" }),
  );
  expect(rejected.status).toBe(400);

  // --- 差し替え(サーバは起動したまま。再生成もしない)---
  // **【`V8-M26`】差し替え後の題材にも同じ規則を足す**(追加した表・画面の分も入る)。
  const applied = applyManifest(dataRoot, APP_ID, withDefaultRoleRules(extendedManifest()));
  expect(applied.valid).toBe(true);

  // --- 差し替え後: 同じ app インスタンスへのリクエスト ---
  const after = (await json(await request(manifestPath))) as unknown as Manifest;
  expect(after.app.tables.map((t) => t.id)).toContain(ADDED_TABLE.id);
  expect(after.app.views.map((v) => v.id)).toContain(ADDED_VIEW.id);
  const afterBaseTable = after.app.tables.find((t) => t.id === baseTable.id) as Table;
  expect(afterBaseTable.fields.map((f) => f.id)).toContain(ADDED_FIELD.id);

  // 新テーブルのレコードAPI が使えるようになる(さっきは 404 だった)。
  const newTableList = await request(recordsPath(ADDED_TABLE.id));
  expect(newTableList.status).toBe(200);
  const addedTableField = ADDED_TABLE.fields[0] as Field;
  const createdInNewTable = await request(
    post(recordsPath(ADDED_TABLE.id), { [addedTableField.id]: "新テーブルの1件目" }),
  );
  expect(createdInNewTable.status).toBe(201);

  // 新フィールドに書けるようになる(さっきは 400 だった)。
  const accepted = await request(
    post(recordsPath(baseTable.id), { [baseField.id]: "新", [ADDED_FIELD.id]: "書ける" }),
  );
  expect(accepted.status).toBe(201);
  expect((await json(accepted)).record).toHaveProperty(ADDED_FIELD.id, "書ける");

  // 既存レコードは残っており、新フィールドは未設定(null)として読める。
  const existing = await request(`${recordsPath(baseTable.id)}/${seededId}`);
  expect(existing.status).toBe(200);
  const existingRecord = (await json(existing)).record as Record<string, unknown>;
  expect(existingRecord[baseField.id]).toBe("既存");
  expect(existingRecord[ADDED_FIELD.id]).toBeNull();
});
