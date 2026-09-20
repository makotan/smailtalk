/**
 * HTTP API の統合テスト(V0-P3-T02)。
 *
 * ADR-0003 §4 の全エンドポイントについて、正常系・異常系を
 * `request()`(実ポートを開かない)で確認する。
 * テストデータは毎回 `fs.mkdtemp` の一時ディレクトリに `createApp` +
 * `applyManifest` で作るため、リポジトリの `data/` には一切触れない。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EscapeHatchStore, putEscapeHatchBody } from "../kernel/escape-hatch-store.ts";
import {
  appDbPath,
  applyDiff,
  applyManifest,
  appManifestPath,
  createApp,
  KernelMetaStore,
  type Manifest,
  unknownTableError,
  type ValidationError,
} from "../kernel/index.ts";
import { appEscapeHatchDir } from "../kernel/storage-paths.ts";
import { createServerApp } from "./app.ts";
import { authed, seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

/** 7型すべてと参照を持つ検証用マニフェスト。 */
function inventoryManifest(): Manifest {
  return {
    app: {
      id: "inventory",
      name: "備品管理",
      tables: [
        {
          id: "categories",
          name: "カテゴリ",
          fields: [{ id: "name", name: "カテゴリ名", type: "text", required: true }],
        },
        {
          id: "items",
          name: "備品",
          fields: [
            { id: "name", name: "備品名", type: "text", required: true },
            { id: "note", name: "備考", type: "long_text" },
            { id: "quantity", name: "数量", type: "number", required: true },
            { id: "in_use", name: "使用中", type: "boolean" },
            { id: "purchased_at", name: "購入日", type: "date" },
            {
              id: "condition",
              name: "状態",
              type: "select",
              options: ["新品", "良好", "要修理"],
            },
            {
              id: "category",
              name: "カテゴリ",
              type: "reference",
              reference_table: "categories",
            },
          ],
        },
      ],
      views: [
        {
          id: "item-list",
          type: "list_view",
          table: "items",
          columns: ["name", "quantity"],
        },
      ],
    },
  };
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;
/**
 * per-app 認証境界(ADR-0014 v3)を通すためのセッション cookie。アプリごとに独立なので
 * app_id → `st_session=<id>` の対応表を beforeEach で用意し、パスの app_id で選ぶ。
 */
let cookies: Record<string, string>;

/** パス中の `/api/apps/<app_id>/` から対応するセッション cookie を選ぶ(無ければ空)。 */
function cookieFor(input: string): string {
  const appId = input.match(/\/api\/apps\/([^/]+)\//)?.[1];
  return (appId !== undefined ? cookies[appId] : undefined) ?? "";
}

/** cookie/Origin 付きで `app.request` する(認証境界の手前を通す)。 */
async function request(
  input: string | Request | Promise<Request>,
  init?: RequestInit,
): Promise<Response> {
  const resolved = input instanceof Promise ? await input : input;
  const cookie = typeof resolved === "string" ? cookieFor(resolved) : "";
  return app.request(authed(cookie)(resolved, init));
}

/** テスト内でよく使うレスポンス読み取り。 */
async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function errorsOf(response: Response): Promise<ValidationError[]> {
  const body = await json(response);
  expect(Array.isArray(body.errors)).toBe(true);
  return body.errors as ValidationError[];
}

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: cookieFor(path), origin: TEST_ORIGIN },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/**
 * PATCH リクエストを組む。V1-M9-T02 以降、If-Match(期待する版)は**必須**なので、
 * 既定では現在の版(GET の ETag)を自動で載せる。版不一致・欠落を試すテストは
 * `ifMatch` に文字列を渡す(`null` で If-Match ヘッダを付けない)。
 */
function patch(path: string, body: unknown, ifMatch?: string | null): Request | Promise<Request> {
  const build = (version: string | null): Request => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      cookie: cookieFor(path),
      origin: TEST_ORIGIN,
    };
    if (version !== null) {
      headers["if-match"] = version;
    }
    return new Request(`http://localhost${path}`, {
      method: "PATCH",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  };
  if (ifMatch !== undefined) {
    return build(ifMatch);
  }
  return versionOf(path).then(build);
}

/** DELETE リクエストを組む。If-Match は必須。既定は現在の版、`ifMatch` で上書き可。 */
async function del(path: string, ifMatch?: string | null): Promise<Request> {
  const version = ifMatch === undefined ? await versionOf(path) : ifMatch;
  const headers: Record<string, string> = { cookie: cookieFor(path), origin: TEST_ORIGIN };
  if (version !== null) {
    headers["if-match"] = version;
  }
  return new Request(`http://localhost${path}`, { method: "DELETE", headers });
}

/** 対象レコードの現在の版(_updated_at)を GET の ETag から得る。 */
async function versionOf(recordPath: string): Promise<string> {
  const response = await request(recordPath);
  const etag = response.headers.get("etag");
  if (etag !== null) {
    return etag;
  }
  const body = await json(response);
  return (body.record as { _updated_at: string })._updated_at;
}

const ITEMS = "/api/apps/inventory/tables/items/records";

/** 備品を1件作って `_id` を返す(参照先カテゴリも自動で用意する)。 */
async function seedItem(overrides: Record<string, unknown> = {}): Promise<string> {
  const created = await request(post(ITEMS, { name: "椅子", quantity: 3, ...overrides }));
  expect(created.status).toBe(201);
  const body = await json(created);
  return (body.record as { _id: string })._id;
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-server-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "備品管理", { app_id: "inventory" });
    createApp(store, "蔵書管理", { app_id: "books" });
  } finally {
    store.close();
  }
  // **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65`】既定が閉じたので、題材へ規則を足す。**
  // **この題材に個人所有(`st_owner`)の表は1つも無い** —— **既定どおり配っても
  // 本ファイルの主題(レコード API の形・検証・ワークフロー)は1ミリも変わらない。**
  const applied = applyManifest(dataRoot, "inventory", withDefaultRoleRules(inventoryManifest()));
  expect(applied.valid).toBe(true);
  app = createServerApp({ dataRoot });
  // レコード API は per-app 認証。両アプリぶんのセッションを app.sqlite に仕込む。
  cookies = {
    inventory: seedSession(dataRoot, "inventory").cookie,
    books: seedSession(dataRoot, "books").cookie,
  };
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

describe("GET /api/apps", () => {
  test("台帳のアプリ一覧を apps キーで返す", async () => {
    const response = await request("/api/apps");
    expect(response.status).toBe(200);
    const body = await json(response);
    const apps = body.apps as {
      app_id: string;
      name: string;
      created_at: string;
      status: string;
    }[];
    expect(apps.map((a) => a.app_id).sort()).toEqual(["books", "inventory"]);
    const inventory = apps.find((a) => a.app_id === "inventory");
    expect(inventory).toBeDefined();
    expect(inventory?.name).toBe("備品管理");
    expect(inventory?.status).toBe("active");
    expect(typeof inventory?.created_at).toBe("string");
  });
});

describe("GET /api/apps/:app_id/manifest", () => {
  test("現行マニフェストをそのまま返す", async () => {
    const response = await request("/api/apps/inventory/manifest");
    expect(response.status).toBe(200);
    // **【`V8-M26`】比べる相手は「適用した題材そのもの」である** —— **`beforeEach` が
    // `withDefaultRoleRules` を通した形で適用しているので、ここも同じ形で突き合わせる。**
    // **主題(適用したものがそのまま返る)は1ミリも変わっていない。**
    //
    // **【`V10-M31-T01`(台帳 `CM-G38`)。2026-08-25。上の行を1バイトも消していない】**
    // **今日から、応答の**外側**に兄弟キー `comment_visibility` が1本載る**
    // (`ADR-0377` の設定をサーバ層でマージする。**定義そのもの = `app` は1バイトも動かない**)。
    // **本題材は設定を1度も倒していないので、実測は既定と同じ OFF の2値である。**
    // **旧の期待値(逐語。1バイトも消していない)**:
    // ```
    //   expect(await response.json()).toEqual(withDefaultRoleRules(inventoryManifest()));
    // ```
    expect(await response.json()).toEqual({
      ...withDefaultRoleRules(inventoryManifest()),
      comment_visibility: { write: false, read: false },
    });
  });

  test("存在しないアプリは 404 で実在するapp_idを allowed_values に載せる", async () => {
    const response = await request("/api/apps/nope/manifest");
    expect(response.status).toBe(404);
    const errors = await errorsOf(response);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("");
    expect(errors[0]?.allowed_values).toContain("inventory");
  });

  test("manifest.json が壊れていたら 500(内部情報は漏らさない)", async () => {
    await writeFile(appManifestPath(dataRoot, "inventory"), "{ broken", "utf-8");
    const response = await request("/api/apps/inventory/manifest");
    expect(response.status).toBe(500);
    const errors = await errorsOf(response);
    expect(errors[0]?.message).toBe("サーバ内部エラー");
    expect(JSON.stringify(errors)).not.toContain(dataRoot);
  });
});

describe("GET .../records(一覧)", () => {
  test("records キーで全件返す(既定は作成順)", async () => {
    await seedItem({ name: "机", quantity: 1 });
    await seedItem({ name: "椅子", quantity: 5 });
    const response = await request(ITEMS);
    expect(response.status).toBe(200);
    const body = await json(response);
    const records = body.records as { name: string }[];
    expect(records.map((r) => r.name)).toEqual(["机", "椅子"]);
  });

  test("sort と order を ListRecordsOptions.sort に写す", async () => {
    await seedItem({ name: "机", quantity: 1 });
    await seedItem({ name: "椅子", quantity: 5 });
    const response = await request(`${ITEMS}?sort=quantity&order=desc`);
    expect(response.status).toBe(200);
    const records = (await json(response)).records as { quantity: number }[];
    expect(records.map((r) => r.quantity)).toEqual([5, 1]);
  });

  test("order を省略すると asc として扱う", async () => {
    await seedItem({ name: "机", quantity: 9 });
    await seedItem({ name: "椅子", quantity: 2 });
    const records = (await json(await request(`${ITEMS}?sort=quantity`))).records as {
      quantity: number;
    }[];
    expect(records.map((r) => r.quantity)).toEqual([2, 9]);
  });

  test("filter.<field> は文字列フィールドの等値条件になる", async () => {
    await seedItem({ name: "机", quantity: 1, condition: "新品" });
    await seedItem({ name: "椅子", quantity: 2, condition: "要修理" });
    const records = (await json(await request(`${ITEMS}?filter.condition=要修理`))).records as {
      name: string;
    }[];
    expect(records.map((r) => r.name)).toEqual(["椅子"]);
  });

  test("number フィールドの filter は数値へデコードされる", async () => {
    await seedItem({ name: "机", quantity: 1 });
    await seedItem({ name: "椅子", quantity: 2 });
    const records = (await json(await request(`${ITEMS}?filter.quantity=2`))).records as {
      name: string;
    }[];
    expect(records.map((r) => r.name)).toEqual(["椅子"]);
  });

  test("boolean フィールドの filter は true/false へデコードされる", async () => {
    await seedItem({ name: "机", quantity: 1, in_use: true });
    await seedItem({ name: "椅子", quantity: 2, in_use: false });
    const records = (await json(await request(`${ITEMS}?filter.in_use=true`))).records as {
      name: string;
    }[];
    expect(records.map((r) => r.name)).toEqual(["机"]);
  });

  test("複数の filter は AND になる", async () => {
    await seedItem({ name: "机", quantity: 1, condition: "新品" });
    await seedItem({ name: "椅子", quantity: 1, condition: "要修理" });
    const records = (await json(await request(`${ITEMS}?filter.quantity=1&filter.condition=新品`)))
      .records as { name: string }[];
    expect(records.map((r) => r.name)).toEqual(["机"]);
  });

  test("filter=<JSON> のブール式(and + gte)で絞り込める(EC-G12 / ADR-0043)", async () => {
    await seedItem({ name: "机", quantity: 1, condition: "新品" });
    await seedItem({ name: "椅子", quantity: 5, condition: "要修理" });
    await seedItem({ name: "棚", quantity: 3, condition: "新品" });
    const filter = {
      and: [
        { field: "condition", equals: "新品" },
        { field: "quantity", gte: 2 },
      ],
    };
    const url = `${ITEMS}?filter=${encodeURIComponent(JSON.stringify(filter))}`;
    const records = (await json(await request(url))).records as { name: string }[];
    expect(records.map((r) => r.name)).toEqual(["棚"]);
  });

  test("filter=<JSON> の or / not のブール結合で絞り込める", async () => {
    await seedItem({ name: "机", quantity: 1, condition: "新品" });
    await seedItem({ name: "椅子", quantity: 5, condition: "要修理" });
    await seedItem({ name: "棚", quantity: 3, condition: "良好" });
    const filter = {
      or: [{ field: "condition", equals: "要修理" }, { not: { field: "quantity", lte: 2 } }],
    };
    const url = `${ITEMS}?filter=${encodeURIComponent(JSON.stringify(filter))}`;
    const records = (await json(await request(url))).records as { name: string }[];
    expect(records.map((r) => r.name).sort()).toEqual(["椅子", "棚"].sort());
  });

  test("filter=<JSON> の contains で部分一致検索できる", async () => {
    await seedItem({ name: "会議机", quantity: 1 });
    await seedItem({ name: "椅子", quantity: 2 });
    const filter = { field: "name", contains: "机" };
    const url = `${ITEMS}?filter=${encodeURIComponent(JSON.stringify(filter))}`;
    const records = (await json(await request(url))).records as { name: string }[];
    expect(records.map((r) => r.name)).toEqual(["会議机"]);
  });

  test("filter(ブール式 JSON)と filter.<field>(等値)の同時指定は 400", async () => {
    const filter = { field: "quantity", gte: 1 };
    const url = `${ITEMS}?filter=${encodeURIComponent(JSON.stringify(filter))}&filter.quantity=1`;
    const response = await request(url);
    expect(response.status).toBe(400);
    const errors = await errorsOf(response);
    expect(errors[0]?.path).toBe("/filter");
  });

  test("壊れた filter JSON は 400", async () => {
    const response = await request(`${ITEMS}?filter=${encodeURIComponent("{壊れた")}`);
    expect(response.status).toBe(400);
    const errors = await errorsOf(response);
    expect(errors[0]?.path).toBe("/filter");
  });

  // --- ページネーション(EC-G11 / ADR-0042)---
  test("total を records と併せて返す(limit/offset 未指定は全件+total)", async () => {
    await seedItem({ name: "机", quantity: 1 });
    await seedItem({ name: "椅子", quantity: 5 });
    const body = await json(await request(ITEMS));
    const records = body.records as { name: string }[];
    expect(records.map((r) => r.name)).toEqual(["机", "椅子"]);
    expect(body.total).toBe(2);
  });

  test("limit で件数を絞っても total は全件のまま", async () => {
    for (let i = 1; i <= 4; i += 1) {
      await seedItem({ name: `n${i}`, quantity: i });
    }
    const body = await json(await request(`${ITEMS}?sort=quantity&limit=2`));
    const records = body.records as { quantity: number }[];
    expect(records.map((r) => r.quantity)).toEqual([1, 2]);
    expect(body.total).toBe(4);
  });

  test("offset で次ページを取れる(limit+offset)", async () => {
    for (let i = 1; i <= 4; i += 1) {
      await seedItem({ name: `n${i}`, quantity: i });
    }
    const body = await json(await request(`${ITEMS}?sort=quantity&limit=2&offset=2`));
    const records = body.records as { quantity: number }[];
    expect(records.map((r) => r.quantity)).toEqual([3, 4]);
    expect(body.total).toBe(4);
  });

  test("total は filter 適用後の件数(EC-G11 限定3)", async () => {
    await seedItem({ name: "机", quantity: 1 });
    await seedItem({ name: "椅子", quantity: 5 });
    await seedItem({ name: "棚", quantity: 3 });
    const filter = { field: "quantity", gte: 3 };
    const url = `${ITEMS}?filter=${encodeURIComponent(JSON.stringify(filter))}&sort=quantity&limit=1`;
    const body = await json(await request(url));
    const records = body.records as { quantity: number }[];
    expect(records.map((r) => r.quantity)).toEqual([3]);
    expect(body.total).toBe(2);
  });

  test("負の limit は 400(/limit)", async () => {
    const response = await request(`${ITEMS}?limit=-1`);
    expect(response.status).toBe(400);
    const errors = await errorsOf(response);
    expect(errors[0]?.path).toBe("/limit");
  });

  test("非整数の offset は 400(/offset)", async () => {
    const response = await request(`${ITEMS}?offset=1.5`);
    expect(response.status).toBe(400);
    const errors = await errorsOf(response);
    expect(errors[0]?.path).toBe("/offset");
  });

  test("sort なしの order 単独指定は 400", async () => {
    const response = await request(`${ITEMS}?order=desc`);
    expect(response.status).toBe(400);
    const errors = await errorsOf(response);
    expect(errors[0]?.path).toBe("/sort/order");
  });

  test("同一フィールドの filter 重複は 400", async () => {
    const response = await request(`${ITEMS}?filter.quantity=1&filter.quantity=2`);
    expect(response.status).toBe(400);
    const errors = await errorsOf(response);
    expect(errors[0]?.path).toBe("/filter/quantity");
  });

  test("number にデコードできない filter 値は 400", async () => {
    const response = await request(`${ITEMS}?filter.quantity=abc`);
    expect(response.status).toBe(400);
    const errors = await errorsOf(response);
    expect(errors[0]?.path).toBe("/filter/quantity/equals");
  });

  test("boolean にデコードできない filter 値は 400", async () => {
    const response = await request(`${ITEMS}?filter.in_use=yes`);
    expect(response.status).toBe(400);
    const errors = await errorsOf(response);
    expect(errors[0]?.path).toBe("/filter/in_use/equals");
    expect(errors[0]?.allowed_values).toEqual(["true", "false"]);
  });

  test("order の値が語彙外なら 400", async () => {
    const response = await request(`${ITEMS}?sort=quantity&order=ascending`);
    expect(response.status).toBe(400);
    const errors = await errorsOf(response);
    expect(errors[0]?.allowed_values).toEqual(["asc", "desc"]);
  });

  test("存在しないフィールドの sort はカーネルのエラーを 400 で透過する", async () => {
    const response = await request(`${ITEMS}?sort=nope`);
    expect(response.status).toBe(400);
    const errors = await errorsOf(response);
    expect(errors[0]?.path).toBe("/sort/field");
    expect(errors[0]?.allowed_values).toContain("quantity");
  });

  test("存在しないフィールドの filter はカーネルのエラーを 400 で透過する", async () => {
    const response = await request(`${ITEMS}?filter.nope=1`);
    expect(response.status).toBe(400);
    const errors = await errorsOf(response);
    expect(errors[0]?.path).toBe("/filter/0/field");
  });

  test("存在しないテーブルは 404", async () => {
    const response = await request("/api/apps/inventory/tables/nope/records");
    expect(response.status).toBe(404);
    const errors = await errorsOf(response);
    expect(errors[0]?.allowed_values).toEqual(["categories", "items"]);
  });

  // 文面はカーネルが唯一の出所。HTTP 経由と MCP 経由で表現が割れないことを守る。
  test("存在しないテーブルの message はカーネルの unknownTableError と一致する", async () => {
    const response = await request("/api/apps/inventory/tables/nope/records");
    expect(response.status).toBe(404);
    const errors = await errorsOf(response);
    const expected = unknownTableError(inventoryManifest(), "nope");
    expect(errors[0]?.message).toBe(expected.message);
    expect(errors[0]?.allowed_values).toEqual(expected.allowed_values);
  });

  test("存在しないアプリは 404", async () => {
    const response = await request("/api/apps/nope/tables/items/records");
    expect(response.status).toBe(404);
    expect((await errorsOf(response))[0]?.allowed_values).toContain("inventory");
  });
});

describe("GET .../records/:record_id", () => {
  test("record キーで1件返す", async () => {
    const id = await seedItem({ name: "机", quantity: 4 });
    const response = await request(`${ITEMS}/${id}`);
    expect(response.status).toBe(200);
    const record = (await json(response)).record as Record<string, unknown>;
    expect(record._id).toBe(id);
    expect(record.name).toBe("机");
    expect(record.quantity).toBe(4);
    expect(typeof record._created_at).toBe("string");
    expect(typeof record._updated_at).toBe("string");
  });

  test("存在しないレコードは 404", async () => {
    const response = await request(`${ITEMS}/does-not-exist`);
    expect(response.status).toBe(404);
    expect((await errorsOf(response))[0]?.path).toBe("");
  });

  test("存在しないテーブルは 404", async () => {
    const response = await request("/api/apps/inventory/tables/nope/records/x");
    expect(response.status).toBe(404);
  });
});

describe("POST .../records", () => {
  test("201 で作成したレコードを返す", async () => {
    const response = await request(post(ITEMS, { name: "机", quantity: 2, in_use: true }));
    expect(response.status).toBe(201);
    const record = (await json(response)).record as Record<string, unknown>;
    expect(record.name).toBe("机");
    expect(record.in_use).toBe(true);
    expect(typeof record._id).toBe("string");
  });

  test("バリデーション違反は 400 でカーネルのエラーをそのまま返す", async () => {
    const response = await request(post(ITEMS, { quantity: 2 }));
    expect(response.status).toBe(400);
    const errors = await errorsOf(response);
    expect(errors.some((e) => e.path === "/name")).toBe(true);
  });

  test("select の選択肢外は allowed_values つきの 400", async () => {
    const response = await request(post(ITEMS, { name: "机", quantity: 1, condition: "謎" }));
    expect(response.status).toBe(400);
    const errors = await errorsOf(response);
    expect(errors[0]?.allowed_values).toEqual(["新品", "良好", "要修理"]);
  });

  test("不正 JSON ボディは 400", async () => {
    const response = await request(post(ITEMS, "{ not json"));
    expect(response.status).toBe(400);
    const errors = await errorsOf(response);
    expect(errors[0]?.path).toBe("");
    expect(errors).toHaveLength(1);
  });

  test("JSON オブジェクトでないボディは 400", async () => {
    const response = await request(post(ITEMS, [1, 2, 3]));
    expect(response.status).toBe(400);
    expect((await errorsOf(response))[0]?.path).toBe("");
  });

  // **【`V8-M26`】旧テスト名: `存在しないテーブルは 404`。**
  test("【V8-M26 で反転】存在しないテーブルへの POST は 404 ではなく 403(面が先に立つ)", async () => {
    const response = await request(post("/api/apps/inventory/tables/nope/records", { name: "x" }));
    // **旧: `expect(response.status).toBe(404);`**
    //
    // **反転の根拠**: **`V8-M26`(`D-V8-45` / `D-V8-65`)。** **面の判定は「その対象を名指しした
    // 規則が在るか」しか見ないので、**実在しない表も「規則が1本も無い表」として閉じる**。**
    // **判定が表の実在検査より前に立つので、404 に到達しない。**
    // **【正直に書く】これは列挙耐性が上がった側面もあるが、**表の打ち間違いが
    // 「存在しません」ではなく「権限がありません」になる**という副作用でもある。**
    expect(response.status).toBe(403);
  });

  test("存在しないアプリは 404", async () => {
    const response = await request(post("/api/apps/nope/tables/items/records", { name: "x" }));
    expect(response.status).toBe(404);
  });
});

describe("PATCH .../records/:record_id", () => {
  test("200 で部分更新した結果を返す", async () => {
    const id = await seedItem({ name: "机", quantity: 2 });
    const response = await request(patch(`${ITEMS}/${id}`, { quantity: 7 }));
    expect(response.status).toBe(200);
    const record = (await json(response)).record as Record<string, unknown>;
    expect(record.quantity).toBe(7);
    expect(record.name).toBe("机");
  });

  test("存在しないレコードは 404", async () => {
    // If-Match は在るが対象が不在。存在確認(404)は版照合より前に決まる。
    const response = await request(patch(`${ITEMS}/does-not-exist`, { quantity: 1 }, "v-any"));
    expect(response.status).toBe(404);
    expect((await errorsOf(response))[0]?.path).toBe("");
  });

  test("バリデーション違反は 400", async () => {
    const id = await seedItem();
    const response = await request(patch(`${ITEMS}/${id}`, { quantity: "たくさん" }));
    expect(response.status).toBe(400);
    expect((await errorsOf(response))[0]?.path).toBe("/quantity");
  });

  test("不正 JSON ボディは 400", async () => {
    const id = await seedItem();
    const response = await request(patch(`${ITEMS}/${id}`, "{ not json"));
    expect(response.status).toBe(400);
  });

  // **【`V8-M26`】旧テスト名: `存在しないテーブルは 404`。**
  test("【V8-M26 で反転】存在しないテーブルへの PATCH は 404 ではなく 403(面が先に立つ)", async () => {
    const response = await request(patch("/api/apps/inventory/tables/nope/records/x", {}, "v-any"));
    // **旧: `expect(response.status).toBe(404);`**
    // **反転の根拠**: **`V8-M26`。** **書込の判定が表の実在検査より前に立つ**
    // (同 describe 群の POST 側と同じ向き)。
    // **【対照】読取(`GET`)側の同名の検査は今日も 404 のままである** ——
    // **書込だけが 403 に倒れた。**
    expect(response.status).toBe(403);
  });

  test("If-Match が無い PATCH は 400(版の指定は必須。ADR-0017)", async () => {
    const id = await seedItem();
    const response = await request(patch(`${ITEMS}/${id}`, { quantity: 7 }, null));
    expect(response.status).toBe(400);
    expect((await errorsOf(response))[0]?.message).toContain("If-Match");
  });

  test("版一致の PATCH は 200 で、応答 ETag は更新後の新しい版になる", async () => {
    const id = await seedItem({ quantity: 2 });
    const before = await versionOf(`${ITEMS}/${id}`);
    const response = await request(patch(`${ITEMS}/${id}`, { quantity: 7 }, before));
    expect(response.status).toBe(200);
    const etag = response.headers.get("etag");
    expect(etag).not.toBeNull();
    expect(etag).not.toBe(before);
    const record = (await json(response)).record as { _updated_at: string };
    expect(etag).toBe(record._updated_at);
  });

  test("版不一致の PATCH は 409(誰かが先に変更した)", async () => {
    const id = await seedItem({ quantity: 2 });
    const stale = await versionOf(`${ITEMS}/${id}`);
    // 別の更新で版を進める。
    await request(patch(`${ITEMS}/${id}`, { quantity: 3 }, stale));
    // 古い版で再更新 → 409。
    const response = await request(patch(`${ITEMS}/${id}`, { quantity: 9 }, stale));
    expect(response.status).toBe(409);
    expect((await errorsOf(response))[0]?.message).toContain("変更されています");
  });
});

describe("DELETE .../records/:record_id", () => {
  test("204 でボディなし、実際に消える", async () => {
    const id = await seedItem();
    const response = await request(del(`${ITEMS}/${id}`));
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect((await request(`${ITEMS}/${id}`)).status).toBe(404);
  });

  test("存在しないレコードは 404", async () => {
    const response = await request(del(`${ITEMS}/does-not-exist`, "v-any"));
    expect(response.status).toBe(404);
    expect((await errorsOf(response))[0]?.path).toBe("");
  });

  // **【`V8-M26`】旧テスト名: `存在しないテーブルは 404`。**
  test("【V8-M26 で反転】存在しないテーブルへの DELETE は 404 ではなく 403(面が先に立つ)", async () => {
    const response = await request(del("/api/apps/inventory/tables/nope/records/x", "v-any"));
    // **旧: `expect(response.status).toBe(404);`**
    // **反転の根拠**: **`V8-M26`。** **削除の判定も表の実在検査より前に立つ。**
    expect(response.status).toBe(403);
  });

  test("If-Match が無い DELETE は 400(版の指定は必須。ADR-0017)", async () => {
    const id = await seedItem();
    const response = await request(del(`${ITEMS}/${id}`, null));
    expect(response.status).toBe(400);
    expect((await errorsOf(response))[0]?.message).toContain("If-Match");
  });

  test("版不一致の DELETE は 409(誰かが先に変更した)", async () => {
    const id = await seedItem({ quantity: 2 });
    const stale = await versionOf(`${ITEMS}/${id}`);
    await request(patch(`${ITEMS}/${id}`, { quantity: 3 }, stale));
    const response = await request(del(`${ITEMS}/${id}`, stale));
    expect(response.status).toBe(409);
    expect((await errorsOf(response))[0]?.message).toContain("変更されています");
  });
});

describe("ルーティングの境界", () => {
  test("未定義の /api パスは JSON の 404", async () => {
    const response = await request("/api/unknown");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    await errorsOf(response);
  });

  test("未定義パスへの POST は index.html を返さず 404", async () => {
    const response = await request(post("/some/page", {}));
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  test("マニフェストを変更する HTTP メソッドは存在しない", async () => {
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      const response = await request("/api/apps/inventory/manifest", { method });
      expect(response.status).toBe(404);
    }
  });

  test("レコードの PUT(全体置換)は提供しない", async () => {
    const id = await seedItem();
    const response = await request(`${ITEMS}/${id}`, { method: "PUT" });
    expect(response.status).toBe(404);
  });

  test("ビルド成果物が無ければ SPA フォールバックも 404 になる", async () => {
    // 既定の `web/dist` は V0-P3-T03 以降ビルドすれば存在しうるので、
    // 「無い」ことを検証するには明示的に存在しないディレクトリを指す必要がある。
    const withoutDist = createServerApp({
      dataRoot,
      webDistDir: join(dataRoot, "does-not-exist"),
    });
    const response = await withoutDist.request("/apps/inventory/item-list");
    expect(response.status).toBe(404);
  });
});

// V0-P3-T03 でフロントのビルド成果物(`web/dist`)ができたため、ADR-0003 §4 #8/#9 の
// 静的配信・SPA フォールバックが実際に効くようになった。実物の `web/dist` に依存すると
// 「ビルド済みかどうか」でテスト結果が変わるので、一時ディレクトリに最小の成果物を作る。
describe("静的配信と SPA フォールバック(ADR-0003 §4 #8/#9)", () => {
  let distDir: string;
  let webApp: ReturnType<typeof createServerApp>;

  beforeEach(async () => {
    distDir = await mkdtemp(join(tmpdir(), "gp-dist-"));
    await mkdir(join(distDir, "assets"), { recursive: true });
    await writeFile(join(distDir, "index.html"), '<!doctype html><div id="root"></div>');
    await writeFile(join(distDir, "assets", "index.js"), "export const ok = true;");
    webApp = createServerApp({ dataRoot, webDistDir: distDir });
  });

  afterEach(async () => {
    await rm(distDir, { recursive: true, force: true });
  });

  test("実在する静的ファイルはそのまま返す", async () => {
    const response = await webApp.request("/assets/index.js");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("export const ok");
  });

  test("フロントのルーティング用の深い URL には index.html を返す(リロードで戻れる)", async () => {
    const response = await webApp.request("/apps/inventory/views/item-list");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('id="root"');
  });

  test("ビルド成果物があっても未定義の /api パスは JSON の 404 のまま", async () => {
    // 未定義の /api パスは per-app 認証境界(records)の外なので、認証なしで 404(未定義)に届く。
    const response = await webApp.request("/api/unknown");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  test("配信ディレクトリの外のファイルは返さない", async () => {
    const response = await webApp.request("/../../etc/passwd");
    // 実体を返さず SPA フォールバック(index.html)に落ちる。
    expect(await response.text()).toContain('id="root"');
  });
});

// --- システムテーブル(ADR-0006 §7)-------------------------------------------------
//
// `_apps` / `_changelog` は `manifest.app.tables` に居ない(ADR-0006 §5)ので、
// 「マニフェストから探して無ければ 404」という素朴な解決だと必ず「存在しません」と
// 嘘をつく。読み取りは通り、書き込みは**読み取り専用エラー**で拒まれることを固定する。
//
// =====================================================================================
// **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-58` / `D-V8-65`。上の3行を1バイトも消していない】**
//
// **この describe の期待値は、下記のとおり **14本** 反転させた。** **黙って書き換えていない。**
//
// ## 何が起きたか(**実測**)
//
// **`V8-M26` が面(役割に束ねた権限)の既定を「閉じる」側へ倒した** ——
// **規則を1本も名指ししていない `table` は拒否される。**
// **システムテーブル(`_apps` / `_changelog` / `_ai_usage`)は `manifest.app.tables` に
// 居ないだけでなく、**役割の規則から名指しすることもできない**。**
//
// **【実測。2026-08-10】** **`{ target: "table", table: "_apps", can: ["read"] }` を書いた
// マニフェストは適用時に拒否される**:
//
// > `/app/roles/0/rules/0/table`: `table の値 "_apps" は識別子の規約に合いません。`
// > `英小文字で始まり、英小文字・数字・ハイフン・アンダースコアのみを使う1〜64文字に…`
//
// **したがって「題材の側を直す」という逃げ道がこの describe には無い** ——
// **今日、システムテーブルを開ける書き方はマニフェストの語彙の中に1つも存在しない。**
//
// ## 何ができなくなったか(**丸めない**)
//
//  - **アプリ台帳の一覧(`_apps`)が、誰に対しても空一覧になる**(`ADR-0305` 限定11 に
//    従って 403 ではなく空で返る)。**単件は 404。**
//  - **変更履歴(`_changelog`)も同じく空一覧 / 404 になる** ——
//    **`ADR-0006` §6b の「全アプリ横断で見える」は、今日は「0件が見える」である。**
//  - **書込は「読み取り専用です」ではなく「あなたの役割に許されていません」(403)になる** ——
//    **`ADR-0006` §7 が避けようとした「誤った推論」の向きが変わった**(旧: 存在しないと
//    言わない / 新: 読み取り専用だとも言わない)。
//  - **`sort` / `filter` の誤りが 400 で返らなくなった** —— **面の判定が検証より前に立ち、
//    空一覧の 200 で返る。**
//
// **【禁止】これを「システムテーブルを塞いだ」と書かない** —— **本タスク(`V8-M26-T05`)は
// 検査の題材しか触っていない。** **塞ぐ意図があったのかどうかは、ここでは判定していない。**
// **判定に必要な材料(規則から名指しできないこと)を、上に実測として置いた。**
//
// =====================================================================================
// **【`D-V8-69`(2026-08-10)。上の 14本の反転は、そのまま元へ戻した。1バイトも消していない】**
// =====================================================================================
//
// **ユーザ決定 `D-V8-69` の見出しの逐語: 「システムの表は権限の外に置く」。**
// **選ばれた説明文の逐語**:
// > **変更履歴やアプリ一覧は今までどおり見えます。ただし「書いていなければ見えない」が及ばない
// > 先が1種類残り、総括に「ここには権限が効かない」と名指しで書くことになります。**
//
// **上の「何ができなくなったか」は、決定によって**起きないことになった** ——
// **`src/server/owner-scope.ts` の `judgeRoleAccess` が、システムが持つ表を面の判定から外す。**
// **一覧は今までどおり中身を返し、単件は 200 で引け、書込は「読み取り専用」の 400 に戻り、
// `sort` / `filter` の誤りは今日も 400 で教えてもらえる。**
//
// **【総括に書く義務。これは決定の一部である】** —— **説明文が自ら述べたとおり、この免除は
// 「『書いていなければ見えない』が及ばない先」を1種類残す。** **総括には
// 「**ここには権限が効かない**」を、`src/shared/system-tables.ts` の全量
// (`_apps` / `_changelog` / `_ai_usage`)とともに **名指しで** 書くこと。**
// **【禁止】「既定を全部閉じた」と書かない。**
//
// **【テスト名を元へ戻した】** —— **反転のときに `【V8-M26 で反転】` を頭に付けた 14本の名前は、
// 期待値と一緒に元へ戻した。** **何をどう反転させ、なぜ戻したかは、各テストの中の
// コメントに逐語で残してある**(このリポジトリは経緯を消さない)。
// =====================================================================================

describe("システムテーブル(ADR-0006)", () => {
  const APPS = "/api/apps/inventory/tables/_apps/records";
  const CHANGELOG = "/api/apps/inventory/tables/_changelog/records";

  /** changelog に apply エントリを1件作る(applyManifest 経由の投入は記録されない)。 */
  function seedChangelog(): void {
    const applied = applyDiff(dataRoot, "inventory", {
      diff_id: "tags",
      intent: "備品にタグを足す",
      operations: [
        { op: "add_field", table: "items", field: { id: "tag", name: "タグ", type: "text" } },
      ],
    });
    expect(applied.valid).toBe(true);
  }

  // **【`V8-M26`】旧テスト名: `GET _apps 一覧はアプリ台帳を投影して返す`。**
  // **【`D-V8-69`】その旧テスト名へ戻した**(反転の記録は下の本文に残してある)。
  test("GET _apps 一覧はアプリ台帳を投影して返す", async () => {
    const response = await request(APPS);
    // **状態は 200 のままである**(`ADR-0305` 限定11 = 一覧は空で返し、403 にしない)。
    expect(response.status).toBe(200);
    const records = (await json(response)).records as Record<string, unknown>[];
    // **【`V8-M26` で反転させたときの記録。1バイトも消していない】**
    // **旧: `expect(records.map((r) => r.app_id).sort()).toEqual(["books", "inventory"]);`**
    // **旧: `const inventory = records.find((r) => r.app_id === "inventory");`**
    // **旧: `expect(inventory?.name).toBe("備品管理");`**
    // **旧: `expect(inventory?.status).toBe("active");`**
    // **旧: `// システム列3つが埋まっていること(detail_view が引けるための前提)。`**
    // **旧: `expect(inventory?._id).toBe("inventory");`**
    // **旧: `expect(typeof inventory?._created_at).toBe("string");`**
    // **旧: `expect(inventory?._updated_at).toBe(inventory?._created_at);`**
    //
    // **反転の根拠**: **`V8-M26`(ユーザ決定 `D-V8-45` / `D-V8-65`)。** **`_apps` を名指しした
    // 規則は識別子の規約(先頭は英小文字)に阻まれて1本も書けない** —— **describe の頭の
    // 実測を参照。** **したがって面は必ず閉じる側に倒れ、行は1件も残らない。**
    // **反転していたときの期待値(逐語): `expect(records).toEqual([]);`**
    //
    // **【`D-V8-69` により再び戻した(2026-08-10)。上の反転の記述は1バイトも消していない】**
    // **システムが持つ表は面の判定を1度も受けないので、上の8行がそのまま戻った。**
    expect(records.map((r) => r.app_id).sort()).toEqual(["books", "inventory"]);
    const inventory = records.find((r) => r.app_id === "inventory");
    expect(inventory?.name).toBe("備品管理");
    expect(inventory?.status).toBe("active");
    // システム列3つが埋まっていること(detail_view が引けるための前提)。
    expect(inventory?._id).toBe("inventory");
    expect(typeof inventory?._created_at).toBe("string");
    expect(inventory?._updated_at).toBe(inventory?._created_at);
  });

  // **【`V8-M26`】旧テスト名: `GET _apps 単体は _id(= app_id)で引ける`。**
  // **【`D-V8-69`】その旧テスト名へ戻した。**
  test("GET _apps 単体は _id(= app_id)で引ける", async () => {
    const response = await request(`${APPS}/inventory`);
    // **【`V8-M26` で反転させたときの記録。1バイトも消していない】**
    // **旧: `expect(response.status).toBe(200);`**
    // **旧: `const record = (await json(response)).record as Record<string, unknown>;`**
    // **旧: `expect(record.app_id).toBe("inventory");`**
    // **旧: `expect(record.name).toBe("備品管理");`**
    //
    // **反転の根拠**: **`V8-M26`。** **単件は 403 ではなく 404 で伏せる**
    // (`ADR-0305` 限定11)—— **`inventory` は実在するが、面が閉じているので無いと答える。**
    // **反転していたときの期待値(逐語): `expect(response.status).toBe(404);`**
    //
    // **【`D-V8-69` により再び戻した(2026-08-10)。上の反転の記述は1バイトも消していない】**
    expect(response.status).toBe(200);
    const record = (await json(response)).record as Record<string, unknown>;
    expect(record.app_id).toBe("inventory");
    expect(record.name).toBe("備品管理");
  });

  test("GET _apps 単体は実在しない _id に 404 を返す(テーブルは存在する)", async () => {
    // **【`V8-M26`】期待値は1バイトも変えていないが、404 の理由は変わった** ——
    // **旧は「そのレコードが無い」、今日は「面が閉じている」でも同じ 404 になる。**
    // **直上の検査(実在する `_id` でも 404)と読み比べること。**
    //
    // **【`D-V8-69` により再び戻した(2026-08-10)。上の反転の記述は1バイトも消していない】**
    // **理由も元へ戻った** —— **システムが持つ表は面の判定を受けないので、この 404 は
    // 今日ふたたび「そのレコードが無い」1つの意味しか持たない。**
    const response = await request(`${APPS}/nope`);
    expect(response.status).toBe(404);
    const errors = await errorsOf(response);
    expect(errors[0]?.message).toContain("レコード");
  });

  // **【`V8-M26`】旧テスト名: `GET _changelog 一覧は intent 付きの変更履歴を返す`。**
  // **【`D-V8-69`】その旧テスト名へ戻した。**
  test("GET _changelog 一覧は intent 付きの変更履歴を返す", async () => {
    seedChangelog();
    const response = await request(CHANGELOG);
    expect(response.status).toBe(200);
    const records = (await json(response)).records as Record<string, unknown>[];
    // **旧: `// V1-M0-T05: createApp が inventory / books それぞれに書く「第0行」(_create-app)`**
    // **旧: `// 2件 + 今回の apply(tags)の1件で、全アプリ横断なので合計3件になる。`**
    // **旧: `expect(records).toHaveLength(3);`**
    // **旧: `const tagEntry = records.find((r) => r.diff_id === "tags");`**
    // **旧: `expect(tagEntry?.app_id).toBe("inventory");`**
    // **旧: `expect(tagEntry?.intent).toBe("備品にタグを足す");`**
    // **旧: `expect(tagEntry?.kind).toBe("apply");`**
    // **旧: `expect(tagEntry?._id).toBe(String(tagEntry?.seq));`**
    // **旧: `// 第0行が実際に見えること自体がこの変更の目的なので、明示的に確かめる。`**
    // **旧: `const createEntry = records.find(...); expect(createEntry?.intent).toBe(...);`**
    //
    // **反転の根拠**: **`V8-M26`(`D-V8-45` / `D-V8-65`)。** **`_changelog` も規則から
    // 名指しできない**(describe の頭の実測)。
    // **【正直に書く】依頼文の逐語(`intent`)が HTTP からは1件も読めなくなった。**
    // **反転していたときの期待値(逐語): `expect(records).toEqual([]);`**
    //
    // **【`D-V8-69` により再び戻した(2026-08-10)。上の反転の記述は1バイトも消していない】**
    // **依頼文の逐語(`intent`)は今日ふたたび HTTP から読める。**
    // V1-M0-T05: createApp が inventory / books それぞれに書く「第0行」(_create-app)
    // 2件 + 今回の apply(tags)の1件で、全アプリ横断なので合計3件になる。
    expect(records).toHaveLength(3);
    const tagEntry = records.find((r) => r.diff_id === "tags");
    expect(tagEntry?.app_id).toBe("inventory");
    expect(tagEntry?.intent).toBe("備品にタグを足す");
    expect(tagEntry?.kind).toBe("apply");
    expect(tagEntry?._id).toBe(String(tagEntry?.seq));
    // 第0行が実際に見えること自体がこの変更の目的なので、明示的に確かめる。
    const createEntry = records.find(
      (r) => r.app_id === "inventory" && r.diff_id === "_create-app",
    );
    expect(createEntry?.intent).toBe(
      "アプリ「備品管理」を作成した(create_app)。この行はカーネルが記録したもので、ユーザの発話ではない。",
    );
  });

  // **【`V8-M26`】旧テスト名: `GET _changelog は filter.app_id でアプリ別に絞れる(DoD-4 の前提)`。**
  // **【`D-V8-69`】その旧テスト名へ戻した。**
  test("GET _changelog は filter.app_id でアプリ別に絞れる(DoD-4 の前提)", async () => {
    seedChangelog();
    const hit = await request(`${CHANGELOG}?filter.app_id=inventory`);
    expect(hit.status).toBe(200);
    // **【`V8-M26` で反転させたときの記録。1バイトも消していない】**
    // **旧: `// inventory: createApp の第0行 + 今回の apply(tags)の2件。`**
    // **旧: `expect((await json(hit)).records).toHaveLength(2);`**
    // **反転していたときの期待値(逐語): `expect((await json(hit)).records).toHaveLength(0);`**
    //
    // **【`D-V8-69` により再び戻した(2026-08-10)。上の反転の記述は1バイトも消していない】**
    // inventory: createApp の第0行 + 今回の apply(tags)の2件。
    expect((await json(hit)).records).toHaveLength(2);

    const miss = await request(`${CHANGELOG}?filter.app_id=books`);
    expect(miss.status).toBe(200);
    // **【`V8-M26` で反転させたときの記録。1バイトも消していない】**
    // **旧: `// books は diff を適用していないが、createApp の第0行だけは見える。`**
    // **旧: `expect((await json(miss)).records).toHaveLength(1);`**
    // **反転していたときの期待値(逐語): `expect((await json(miss)).records).toHaveLength(0);`**
    //
    // **【`D-V8-69` により再び戻した(2026-08-10)。上の反転の記述は1バイトも消していない】**
    // books は diff を適用していないが、createApp の第0行だけは見える。
    expect((await json(miss)).records).toHaveLength(1);
    // **絞り込みそのものは今日も壊れていない** —— **母集合も今日ふたたび0件ではない。**
  });

  // **【`V8-M26`】旧テスト名: `GET _changelog 単体は seq を _id として引ける`。**
  // **【`D-V8-69`】その旧テスト名へ戻した。**
  test("GET _changelog 単体は seq を _id として引ける", async () => {
    seedChangelog();
    // seq1=inventory の第0行、seq2=books の第0行、seq3=tags(このテストの beforeEach と
    // seedChangelog の呼び出し順で決まる、決定的な値)。
    const response = await request(`${CHANGELOG}/3`);
    // **【`V8-M26` で反転させたときの記録。1バイトも消していない】**
    // **旧: `expect(response.status).toBe(200);`**
    // **旧: `const record = (await json(response)).record as Record<string, unknown>;`**
    // **旧: `expect(record.seq).toBe(3);`**
    // **旧: `expect(record.intent).toBe("備品にタグを足す");`**
    //
    // **反転の根拠**: **`V8-M26`。単件は 404 で伏せる**(`ADR-0305` 限定11)。
    // **反転していたときの期待値(逐語): `expect(response.status).toBe(404);`**
    //
    // **【`D-V8-69` により再び戻した(2026-08-10)。上の反転の記述は1バイトも消していない】**
    expect(response.status).toBe(200);
    const record = (await json(response)).record as Record<string, unknown>;
    expect(record.seq).toBe(3);
    expect(record.intent).toBe("備品にタグを足す");
  });

  // **【`V8-M26`】旧テスト名: `GET _changelog は全アプリ横断である(ADR-0006 §6b)`。**
  // **【`D-V8-69`】その旧テスト名へ戻した。**
  test("GET _changelog は全アプリ横断である(ADR-0006 §6b)", async () => {
    seedChangelog();
    // books 側でも apply する。閲覧中のアプリに閉じないので両方見える。
    const applied = applyDiff(dataRoot, "books", {
      diff_id: "books-setup",
      intent: "蔵書テーブルを作る",
      operations: [
        {
          op: "add_table",
          table: {
            id: "books",
            name: "蔵書",
            fields: [{ id: "title", name: "書名", type: "text", required: true }],
          },
        },
      ],
    });
    expect(applied.valid).toBe(true);

    const records = (await json(await request(CHANGELOG))).records as Record<string, unknown>[];
    // **【`V8-M26` で反転させたときの記録。1バイトも消していない】**
    // **旧: `// 各アプリの createApp の第0行(2件)+ 今回の apply(2件)で計4件。`**
    // **旧: `expect(records.map((r) => r.app_id).sort()).toEqual(["books","books","inventory","inventory"]);`**
    // **旧: `expect(records.map((r) => r.diff_id).sort()).toEqual(["_create-app","_create-app","books-setup","tags"]);`**
    //
    // **反転の根拠**: **`V8-M26`。** **`ADR-0006` §6b の「閲覧中のアプリに閉じない」は
    // 今日も真である**(アプリ別に絞れていない)—— **母集合が0件になっただけである。**
    // **反転していたときの期待値(逐語): `expect(records).toEqual([]);`**
    //
    // **【`D-V8-69` により再び戻した(2026-08-10)。上の反転の記述は1バイトも消していない】**
    // 各アプリの createApp の第0行(2件)+ 今回の apply(2件)で計4件。
    expect(records.map((r) => r.app_id).sort()).toEqual([
      "books",
      "books",
      "inventory",
      "inventory",
    ]);
    expect(records.map((r) => r.diff_id).sort()).toEqual([
      "_create-app",
      "_create-app",
      "books-setup",
      "tags",
    ]);
  });

  // **【`V8-M26`】旧テスト名: `sort と filter のエラー文面は通常テーブルと同じ形で返る`。**
  // **【`D-V8-69`】その旧テスト名へ戻した。**
  test("sort と filter のエラー文面は通常テーブルと同じ形で返る", async () => {
    const sorted = await request(`${APPS}?sort=nope`);
    // **【`V8-M26` で反転させたときの記録。1バイトも消していない】**
    // **旧: `expect(sorted.status).toBe(400);`**
    // **旧: `const sortErrors = await errorsOf(sorted);`**
    // **旧: `expect(sortErrors[0]?.path).toBe("/sort/field");`**
    // **旧: `expect(sortErrors[0]?.allowed_values).toContain("_created_at");`**
    //
    // **反転の根拠**: **`V8-M26`。** **面の判定が並べ替え・絞り込みの検証より**前**に立つ**
    // —— **閉じた表では検証まで到達しないので、誤った `sort` を書いても教えてもらえない。**
    // **【正直に書く】これは「エラー文面が変わった」ではなく「エラーが出なくなった」である。**
    // **反転していたときの期待値(逐語): `expect(sorted.status).toBe(200);` /**
    // **`expect((await json(sorted)).records).toEqual([]);`**
    //
    // **【`D-V8-69` により再び戻した(2026-08-10)。上の反転の記述は1バイトも消していない】**
    // **面がシステムの表を1度も判定しないので、検証がふたたび先に立つ。**
    expect(sorted.status).toBe(400);
    const sortErrors = await errorsOf(sorted);
    expect(sortErrors[0]?.path).toBe("/sort/field");
    expect(sortErrors[0]?.allowed_values).toContain("_created_at");

    // **【`V8-M26` で反転させたときの記録。1バイトも消していない】**
    // **旧: `// filter はシステム列を許さない(既存経路の非対称をそのまま写している)。`**
    // **旧: `expect(filtered.status).toBe(400);`** ほか3行も同じ理由で反転した。
    // **反転していたときの期待値(逐語): `expect(filtered.status).toBe(200);` /**
    // **`expect((await json(filtered)).records).toEqual([]);`**
    //
    // **【`D-V8-69` により再び戻した(2026-08-10)。上の反転の記述は1バイトも消していない】**
    // filter はシステム列を許さない(既存経路の非対称をそのまま写している)。
    const filtered = await request(`${APPS}?filter._id=inventory`);
    expect(filtered.status).toBe(400);
    const filterErrors = await errorsOf(filtered);
    expect(filterErrors[0]?.path).toBe("/filter/0/field");
    expect(filterErrors[0]?.allowed_values).not.toContain("_id");
  });

  // --- 書き込みは「存在しません」ではなく「読み取り専用」 ---------------------------

  /**
   * 書き込み拒否の共通の期待。「存在しない」と言っていないことまで見る。
   *
   * **【`V8-M26` で反転。旧の本体を逐語で残す】**
   * ```
   * expect(response.status).toBe(400);
   * const errors = await errorsOf(response);
   * expect(errors).toHaveLength(1);
   * expect(errors[0]?.path).toBe("");
   * expect(errors[0]?.message).toContain("読み取り専用");
   * expect(errors[0]?.message).not.toContain("存在しません");
   * // 代わりに書けるテーブルを案内する(add_table へ誘導しない)。
   * expect(errors[0]?.allowed_values).toEqual(["categories", "items"]);
   * expect(errors[0]?.hint ?? "").not.toContain("add_table");
   * ```
   *
   * **反転の根拠**: **`V8-M26`(`D-V8-45` / `D-V8-58`)。** **面の判定が「読み取り専用です」の
   * 手前に立つので、書込は 403(役割に許されていない)で断られる。**
   * **`ADR-0006` §7 が守ろうとした「存在しないとは言わない」は今日も守られている** ——
   * **しかし「読み取り専用だ」とも言わなくなった。** **代わりに書けるテーブルの案内
   * (`allowed_values`)も消えた。**
   *
   * **【`D-V8-69` により再び戻した(2026-08-10)。上の反転の記述は1バイトも消していない】**
   *
   * **反転していたときの本体(逐語)**:
   * ```
   * expect(response.status).toBe(403);
   * const errors = await errorsOf(response);
   * expect(errors).toHaveLength(1);
   * expect(errors[0]?.path).toBe("");
   * // **「存在しません」と言っていないことは今日も守られている**(旧の主題の生き残り)。
   * expect(errors[0]?.message).not.toContain("存在しません");
   * expect(errors[0]?.message).toContain("役割");
   * ```
   *
   * **システムが持つ表は面の判定を1度も受けないので、拒否はふたたび
   * カーネルの読み取り専用エラー(400)である** —— **`allowed_values` の案内も戻った。**
   */
  async function expectReadOnly(response: Response): Promise<void> {
    expect(response.status).toBe(400);
    const errors = await errorsOf(response);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("");
    expect(errors[0]?.message).toContain("読み取り専用");
    expect(errors[0]?.message).not.toContain("存在しません");
    // 代わりに書けるテーブルを案内する(add_table へ誘導しない)。
    expect(errors[0]?.allowed_values).toEqual(["categories", "items"]);
    expect(errors[0]?.hint ?? "").not.toContain("add_table");
  }

  // **【`V8-M26`】旧テスト名: `POST は読み取り専用エラーで拒む`。**
  // **【`D-V8-69`】その旧テスト名へ戻した**(拒否は 400 に戻った。`expectReadOnly` の doc)。
  test("POST は読み取り専用エラーで拒む", async () => {
    await expectReadOnly(await request(post(APPS, { app_id: "x", name: "x" })));
  });

  // **【`V8-M26`】旧テスト名: `PATCH は読み取り専用エラーで拒む`。**
  // **【`D-V8-69`】その旧テスト名へ戻した。**
  test("PATCH は読み取り専用エラーで拒む", async () => {
    // 読み取り専用拒否は If-Match 検査より前に決まる(If-Match 有無に依らず 400)。
    await expectReadOnly(await request(patch(`${APPS}/inventory`, { name: "改名" }, "v-any")));
  });

  // **【`V8-M26`】旧テスト名: `PATCH は実在しないレコードIDでも 404 ではなく読み取り専用の 400 を返す`。**
  // **【`D-V8-69`】その旧テスト名へ戻した。**
  test("PATCH は実在しないレコードIDでも 404 ではなく読み取り専用の 400 を返す", async () => {
    // 404 を返すと「レコードさえあれば書ける」という誤った推論を許す(ADR-0006 §7)。
    await expectReadOnly(await request(patch(`${APPS}/nope`, { name: "改名" }, "v-any")));
  });

  // **【`V8-M26`】旧テスト名: `DELETE は読み取り専用エラーで拒む`。**
  // **【`D-V8-69`】その旧テスト名へ戻した。**
  test("DELETE は読み取り専用エラーで拒む", async () => {
    await expectReadOnly(await request(del(`${APPS}/inventory`, "v-any")));
  });

  // **【`V8-M26`】旧テスト名: `_changelog への書き込みも同じく読み取り専用エラー`。**
  // **【`D-V8-69`】その旧テスト名へ戻した。**
  test("_changelog への書き込みも同じく読み取り専用エラー", async () => {
    await expectReadOnly(await request(post(CHANGELOG, { seq: 1 })));
  });

  // --- app.sqlite に触らない(`ADR-0006:251` の無番号節 / P2-2)------------------------
  //
  // **V4-M1(`B-G6`)で、この2本の期待を書き換えた。** 何が変わって何が変わっていないかを
  // 先に書く。
  //
  // **`ADR-0006:251` が守れと言っているのは「`_apps` を眺めるだけで統一形式でない 500 に
  // なる」ことを避けることである**(逐語「管理ツールは壊れた状態を見に行くための道具でも
  // あるので、その1件のせいで一覧全体が落ちるのは筋が悪い」)。**読み取り経路そのものは
  // 今日も `app.sqlite` を1度も開かない** —— `withReadSource` の遅延 `appDb()` は
  // システムテーブルでは呼ばれず、壊れたアプリの行も一覧に載り続ける(下の `healthy` 側)。
  //
  // **変わったのは認証層である。** V4-M1 より前、システムテーブルは per-app セッション解決の
  // 手前で素通しされており、**未認証でプラットフォーム全体の依頼文の逐語と AI 利用額が読めた**
  // (`B-G6`)。塞いだので、**セッションを解決できないアプリの URL では 401 になる** ——
  // セッションはそのアプリの `app.sqlite` の中にあり、それが無い/壊れているからである。
  //
  // **したがって「壊れたアプリの URL からも読める」という性質は今日は成り立たない。**
  // 残っているのは「**健全な別アプリの URL から、壊れたアプリの行を含む全体が読める**」で
  // ある。**この2つは同じではない。「性質をそのまま保った」とは書かない。**

  /** 認証境界(middleware)が返す統一メッセージ(`app.ts` の `unauthenticatedError`)。 */
  const AUTH_REQUIRED = "認証が必要です。ログインしてください。";

  test("app.sqlite が無いアプリの URL では 401(統一形式)。健全な別アプリ経由なら一覧は落ちない", async () => {
    await rm(appDbPath(dataRoot, "books"), { force: true });
    // books のセッションは books の app.sqlite の中にあったので、cookie 付きでも解決できない。
    // **重要なのは 500 ではないこと**(統一形式のエラー本体が返ること)。
    const broken = await request("/api/apps/books/tables/_apps/records");
    expect(broken.status).toBe(401);
    expect((await errorsOf(broken))[0]?.message).toBe(AUTH_REQUIRED);

    // 健全な別アプリ経由: 投影はプラットフォーム全体を返すので、**app.sqlite を消した
    // books の行もそのまま載る**(= 一覧全体が落ちない。ADR-0006:251 の目的)。
    const healthy = await request("/api/apps/inventory/tables/_apps/records");
    // **`ADR-0006:251` の目的(統一形式でない 500 にしない)は今日も守られている。**
    expect(healthy.status).toBe(200);
    const records = (await json(healthy)).records as Record<string, unknown>[];
    // **【`V8-M26` で反転させたときの記録。1バイトも消していない】**
    // **旧: `expect(records.map((r) => r.app_id).sort()).toEqual(["books", "inventory"]);`**
    //
    // **反転の根拠**: **`V8-M26`。** **一覧は落ちないが、空である。**
    // **【正直に書く】「壊れた状態を見に行くための道具」としての `_apps` は、今日は
    // 何も見せない**(`ADR-0006:251` の逐語の目的は達成できていない)。
    // **反転していたときの期待値(逐語): `expect(records).toEqual([]);`**
    //
    // **【`D-V8-69` により再び戻した(2026-08-10)。上の反転の記述は1バイトも消していない】**
    // **`ADR-0006:251` の逐語の目的は、今日ふたたび達成できている。**
    expect(records.map((r) => r.app_id).sort()).toEqual(["books", "inventory"]);
  });

  test("app.sqlite が壊れていても 500 にならず、健全な別アプリ経由なら _changelog は読める", async () => {
    await writeFile(appDbPath(dataRoot, "books"), "not a sqlite file", "utf-8");
    const broken = await request("/api/apps/books/tables/_changelog/records");
    expect(broken.status).toBe(401);
    expect((await errorsOf(broken))[0]?.message).toBe(AUTH_REQUIRED);

    const healthy = await request("/api/apps/inventory/tables/_changelog/records");
    expect(healthy.status).toBe(200);
    const records = (await json(healthy)).records as Record<string, unknown>[];
    // **【`V8-M26` で反転させたときの記録。1バイトも消していない】**
    // **旧: `// _changelog は app.sqlite ではなくカーネル台帳(meta store)由来なので、books の`**
    // **旧: `// app.sqlite が壊れていても両アプリの createApp の第0行(_create-app)は読める。`**
    // **旧: `expect(records.map((r) => r.app_id).sort()).toEqual(["books", "inventory"]);`**
    // **旧: `expect(records.every((r) => r.diff_id === "_create-app")).toBe(true);`**
    //
    // **反転の根拠**: **`V8-M26`。** **500 にならないことは今日も守られている**
    // (それがこの検査の1本目の主題である)—— **読める行が0件になった。**
    // **反転していたときの期待値(逐語): `expect(records).toEqual([]);`**
    //
    // **【`D-V8-69` により再び戻した(2026-08-10)。上の反転の記述は1バイトも消していない】**
    // _changelog は app.sqlite ではなくカーネル台帳(meta store)由来なので、books の
    // app.sqlite が壊れていても両アプリの createApp の第0行(_create-app)は読める。
    expect(records.map((r) => r.app_id).sort()).toEqual(["books", "inventory"]);
    expect(records.every((r) => r.diff_id === "_create-app")).toBe(true);
  });

  test("システムテーブルは未認証で読めない(V4-M1 / B-G6。塞ぐ前は 200 だった)", async () => {
    // `request` は cookie を付けるので、ここは素の `app.request` で未認証を作る。
    const response = await app.request(
      new Request("http://localhost/api/apps/inventory/tables/_changelog/records"),
    );
    expect(response.status).toBe(401);
    expect((await errorsOf(response))[0]?.message).toBe(AUTH_REQUIRED);
  });

  test("ユーザテーブルの 404 は今までどおり(システムテーブルの追加で緩めない)", async () => {
    const response = await request("/api/apps/inventory/tables/_snapshots/records");
    expect(response.status).toBe(404);
    const errors = await errorsOf(response);
    expect(errors[0]?.message).toContain("存在しません");
  });
});

// --- V1-M2-T02 完了条件4: HTTP 経路でワークフローが発火する ---------------------------
//
// **フックはカーネル(`src/kernel/records.ts`)に置いてあるので、HTTP 経路と MCP 経路の
// 一致は構造的に保証されている。**それでも書くのは、詳細化 §2-2 の完了条件4 が
// 「**テストは『保証が実際に効いていること』の確認になる**」と定めているからである。
// 保証を信じて省略すると、**保証が外れた日に誰も気づかない**
// (ADR-0003 §7 が「入口を何本生やしても振る舞いが一致する」を設計目標に挙げているのは、
// ずれが静かに起きるからである)。
//
// **PATCH を個別に確かめるのが本節の要点である。** `src/server/app.ts:536-550` の PATCH は
// **`withAppDb` のコールバック内でレスポンスを組む唯一の非対称経路**であり(POST は `:501-507`、
// DELETE は `:570-579` で、どちらもコールバックの外)、詳細化 §2-2 がこの非対称を名指しで
// 記録している。**カーネルにフックを置いた設計では無害なはずだが、「無害なはず」を
// 確かめないままにしない。**
//
// **MCP 経路との突き合わせ(履歴の行が同じ形になること)は `src/mcp/tools/write.test.ts`
// にある** —— あちらは同じ `dataRoot` に HTTP サーバと MCP サーバの両方を立てて、
// 2つの入口が書いた履歴行を直接比較している。

describe("ワークフローの発火(V1-M2-T02 完了条件4 / HTTP 経路)", () => {
  const BOOKS = "/api/apps/books/tables/books/records";
  const FRAGILE = "/api/apps/books/tables/fragile/records";

  /** 履歴テーブルは ADR-0013 §8c 問4 のひな形(`WORKFLOW_HISTORY_COLUMNS` の5列)どおり。 */
  function historyFields() {
    return [
      { id: "ran_at", name: "実行時刻", type: "date" as const },
      { id: "workflow", name: "ワークフロー", type: "text" as const },
      { id: "trigger_type", name: "きっかけ", type: "text" as const },
      { id: "status", name: "結果", type: "text" as const },
      { id: "error", name: "エラー", type: "long_text" as const },
    ];
  }

  beforeEach(() => {
    /*
     * **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65`】題材を2箇所いじった。理由を書く。**
     *
     * 1. **`withDefaultRoleRules` で既定3役割の規則を足した** —— **既定が閉じたので、
     *    書かないとこのアプリへは1行も書けない。**
     * 2. **きっかけの表(`books` / `fragile`)に `st_owner` を1本ずつ足した。**
     *    **これは飾りではなく、足さないとワークフローが1本も走らない。**
     *
     * **2 の実測(2026-08-10)**: **`st_owner` を持たない表がきっかけだと、自動処理の
     * 書き手が「誰でもない」に解決される** —— **面が管轄内(規則を足したので governed)に
     * なった今日、役割を1つも持たない書き手は必ず弾かれる**:
     *
     * > `テーブル "notifications" はアクセス権で守られていますが、この自動処理の書き手`
     * > `(この発火では書き手を特定できません)には作る権限がありません(止めた層: role)`
     *
     * **これは `src/server/automation-access-control.test.ts` の (F-7) が「参照EC が
     * これで壊れた」と書いている現象と同じものである** —— **あちらの直し方は
     * `act_as` の1行、こちらの直し方は `st_owner` の1本である。**
     * **【正直に書く】規則を足さずに閉じたままにしても直らない** —— **閉じた表は
     * `governed: true` で返るので、やはり書き手が弾かれる。**
     */
    const applied = applyManifest(
      dataRoot,
      "books",
      withDefaultRoleRules({
        app: {
          id: "books",
          name: "蔵書管理",
          tables: [
            {
              id: "books",
              name: "本",
              fields: [
                { id: "title", name: "タイトル", type: "text", required: true },
                { id: "memo", name: "メモ", type: "long_text" },
                // **【`V8-M26`】上記 2 の理由で足した1本。** **旧: この行は無かった。**
                { id: "st_owner", name: "所有者", type: "text" },
              ],
            },
            {
              id: "notifications",
              name: "通知",
              fields: [
                { id: "title", name: "件名", type: "text" },
                { id: "source", name: "対象", type: "text" },
              ],
            },
            // 完了条件3(分離)用。`must` が required なので、値を与えない
            // 書き込みは**必ず**失敗する(偶然ではなく構造的に失敗する)。
            {
              id: "strict",
              name: "必須つき",
              fields: [
                { id: "must", name: "必須", type: "text", required: true },
                { id: "note", name: "備考", type: "text" },
              ],
            },
            {
              id: "fragile",
              name: "壊れるワークフローのトリガー元",
              fields: [
                { id: "label", name: "ラベル", type: "text", required: true },
                // **【`V8-M26`】書き手を特定させるための1本**(上記 2 と同じ理由)。
                { id: "st_owner", name: "所有者", type: "text" },
              ],
            },
            { id: "wf-runs", name: "実行履歴", fields: historyFields() },
          ],
          views: [],
          workflows: [
            {
              id: "notify-on-create",
              name: "登録を通知する",
              trigger: { type: "on_create", table: "books" },
              actions: [
                {
                  action: "create_record",
                  table: "notifications",
                  values: { title: "登録されました", source: "$record.title" },
                },
              ],
              history_table: "wf-runs",
            },
            {
              id: "notify-on-update",
              name: "更新を通知する",
              trigger: { type: "on_update", table: "books" },
              actions: [
                {
                  action: "create_record",
                  table: "notifications",
                  values: { title: "更新されました", source: "$record.title" },
                },
              ],
              history_table: "wf-runs",
            },
            {
              id: "always-fails",
              name: "必ず失敗するワークフロー",
              trigger: { type: "on_create", table: "fragile" },
              actions: [
                // `must` を与えないので `validateInput` が必ず拒否する。
                { action: "create_record", table: "strict", values: { note: "書けない" } },
              ],
              history_table: "wf-runs",
            },
          ],
        },
      }),
    );
    expect(applied.valid).toBe(true);
  });

  /** **DB から読み直す。**レスポンスの使い回しでは「本当に書かれたか」が分からない。 */
  async function rowsOf(tableId: string): Promise<Record<string, unknown>[]> {
    const response = await request(`/api/apps/books/tables/${tableId}/records`);
    expect(response.status).toBe(200);
    return (await json(response)).records as Record<string, unknown>[];
  }

  test("POST で on_create が発火し、出力先に行が増え、履歴に1行増える", async () => {
    const created = await request(post(BOOKS, { title: "吾輩は猫である" }));
    expect(created.status).toBe(201);

    // 出力先テーブル。「例外が飛ばなかった」ではなく中身を読む。
    const notifications = await rowsOf("notifications");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.title).toBe("登録されました");
    expect(notifications[0]?.source).toBe("吾輩は猫である");

    // 履歴は**実行1回につき1行**(アクション1つにつき1行ではない)。
    const history = await rowsOf("wf-runs");
    expect(history).toHaveLength(1);
    expect(history[0]?.workflow).toBe("notify-on-create");
    expect(history[0]?.trigger_type).toBe("on_create");
    expect(history[0]?.status).toBe("success");
    expect(history[0]?.error).toBeNull();
  });

  test("PATCH で on_update が発火する(withAppDb のコールバック内でレスポンスを組む唯一の非対称経路)", async () => {
    const created = await request(post(BOOKS, { title: "坊っちゃん" }));
    expect(created.status).toBe(201);
    const bookId = ((await json(created)).record as { _id: string })._id;

    const updated = await request(patch(`${BOOKS}/${bookId}`, { memo: "読了" }));
    expect(updated.status).toBe(200);

    const history = await rowsOf("wf-runs");
    // on_create で1行、on_update で1行。**PATCH の分が落ちていればここで1行足りない。**
    expect(history).toHaveLength(2);
    const onUpdate = history.find((row) => row.trigger_type === "on_update");
    expect(onUpdate?.workflow).toBe("notify-on-update");
    expect(onUpdate?.status).toBe("success");

    // 出力先にも更新の通知が実際に書かれている。
    const notifications = await rowsOf("notifications");
    expect(notifications.map((row) => row.title).sort()).toEqual([
      "更新されました",
      "登録されました",
    ]);
  });

  test("【ADR-0066 で変わった】ワークフローが失敗すると 201 にならず、本体行も残らない", async () => {
    // 【V3-M13-T02 / ADR-0066 による期待値の更新。バグの修正ではない】
    // `ADR-0013` §5a(`0013:417`)の前段「本体 CRUD をロールバックしない」を
    // **決定として破った**(ADR-0066 §Decision 1b)。以前はここが 201 + 本体行1件だった。
    // **後段(例外を伝播させて 500 にしない)は1バイトも変わっていない** ——
    // 下で 500 でないことを直接見る。
    const created = await request(post(FRAGILE, { label: "壊れる" }));
    expect(created.status).not.toBe(500);
    expect(created.status).toBe(400);
    // 失敗の中身が既存の errors 形式で返る(ADR-0066 限定12)。
    const body = (await json(created)) as { errors?: { message?: string }[] };
    expect(String(body.errors?.[0]?.message ?? "")).toContain("ワークフロー");

    // **「400 が返った」を巻き戻しの証明にしない。**DB から読み直して不在を確かめる。
    expect(await rowsOf("fragile")).toHaveLength(0);
    expect(await rowsOf("strict")).toHaveLength(0);

    // 【V3-M13-T04 による期待値の更新】履歴は発火元と同じ tx の内側で書かれるので巻き戻しで
    // 一緒に消えていたが、**`T04` が ADR-0066 限定5 を (B)「巻き戻し後に改めて書く」で
    // 実装した。** HTTP の外側 tx は `ok:false` を return する(throw しない)ので commit し、
    // **失敗の記録はレスポンスを返した後も残る。**
    const runs = (await rowsOf("wf-runs")) as { status?: unknown }[];
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failure");
  });
});

// --- 要件定義書(V1-M8-T02 / ADR-0025 §10)---------------------------------------------
//
// **認可は changelog / manifest と同列のローカル専用(認証なし)**である(§10-1)。
// 要件定義書が含むのは changelog と manifest の再構成であり、新しい情報を1バイトも
// 作らない。owner 検査を足すと「changelog より厳しい理由」が要るが、その理由が無い。
// **cookie を付けずに叩けることを、この describe の全テストが同時に固定している**
// (`request()` は `/api/apps/<app_id>/` から cookie を選ぶが、要件定義書の経路は
//  認証 middleware を1本も通らないので、あってもなくても結果は変わらない)。
//
// =====================================================================================
// **【`V17-M4-T02` による改訂。上の8行は1バイトも書き換えていない】** **台帳 `AC-G20`**
// =====================================================================================
//
// **上の「ローカル専用(認証なし)」も「cookie を付けずに叩けることを全テストが固定している」も、
// 今日の正ではない。** **`GET /requirements` には `GET /manifest` と同じ関門が掛かった** ——
// **未認証は 401 である。**
//
// **したがって中身を撃つ4本は `request()`(cookie を選ぶ)へ移した。**
// **`anonymous()` は消していない** —— **「存在しないアプリは 404」(関門はアプリの実在を
// セッション解決より先に見る)と、新しく足した「未認証は 401」の2本が今日も使っている。**
// **期待値は1つも書き換えていない**(200 は 200 のまま。読む人が変わっただけである)。

describe("GET /api/apps/:app_id/requirements(ADR-0025 §10)", () => {
  const REQUIREMENTS = "/api/apps/inventory/requirements";

  /** 認証を一切付けずに叩く(ローカル専用の無認証であることを実際に踏む)。 */
  async function anonymous(path: string): Promise<Response> {
    return app.request(new Request(`http://localhost${path}`));
  }

  test("既定は markdown で、記述ごとの出典表が付く", async () => {
    const response = await request(REQUIREMENTS);
    expect(response.status).toBe(200);
    const body = await json(response);
    const doc = body.requirements as Record<string, unknown>;

    expect(doc.app_id).toBe("inventory");
    expect(doc.format).toBe("markdown");
    expect(doc.section).toBeNull();
    expect(doc.markdown as string).toContain("# 要件定義書");

    const sources = doc.sources as { statement_id: string; sources: unknown[] }[];
    expect(sources.length).toBeGreaterThan(0);
    // 確認方法2(出典欄が空の記述が0件)。全数で見る。
    for (const entry of sources) {
      expect(entry.sources.length).toBeGreaterThan(0);
    }
  });

  test("format=json は statements と実在集合を返す", async () => {
    const response = await request(`${REQUIREMENTS}?format=json`);
    expect(response.status).toBe(200);
    const doc = (await json(response)).requirements as Record<string, unknown>;

    expect(doc.format).toBe("json");
    const statements = doc.statements as { id: string; section: string; sources: unknown[] }[];
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement.sources.length).toBeGreaterThan(0);
    }
    // 実在集合はマニフェストから作られる(テーブルIDが載っている)。
    expect((doc.identifiers as Record<string, string[]>).table_id).toContain("items");
  });

  test("section はその節の記述だけに絞る", async () => {
    const all = (
      (await json(await request(`${REQUIREMENTS}?format=json`))).requirements as {
        statements: { section: string }[];
      }
    ).statements;
    const response = await request(`${REQUIREMENTS}?format=json&section=data`);
    expect(response.status).toBe(200);
    const doc = (await json(response)).requirements as Record<string, unknown>;

    expect(doc.section).toBe("data");
    const statements = doc.statements as { section: string }[];
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.every((statement) => statement.section === "data")).toBe(true);
    // 期待値は応答から導く(件数を焼き込まない)。
    expect(statements.length).toBe(all.filter((s) => s.section === "data").length);
  });

  test("語彙外の section / format は 400 で受理集合を添えて断る", async () => {
    const badSection = await request(`${REQUIREMENTS}?section=nonexistent`);
    expect(badSection.status).toBe(400);
    const sectionErrors = await errorsOf(badSection);
    expect(sectionErrors[0]?.path).toBe("/section");
    expect(sectionErrors[0]?.allowed_values).toContain("history");

    const badFormat = await request(`${REQUIREMENTS}?format=pdf`);
    expect(badFormat.status).toBe(400);
    const formatErrors = await errorsOf(badFormat);
    expect(formatErrors[0]?.path).toBe("/format");
    expect(formatErrors[0]?.allowed_values).toEqual(["markdown", "json"]);
  });

  test("存在しないアプリは 404 で実在するapp_idを allowed_values に載せる", async () => {
    const response = await anonymous("/api/apps/nope/requirements");
    expect(response.status).toBe(404);
    const errors = await errorsOf(response);
    expect(errors[0]?.path).toBe("");
    expect(errors[0]?.allowed_values).toContain("inventory");
  });

  // **【`V17-M4-T02`。台帳 `AC-G20`】** **上の4本が着手前まで cookie 無しで 200 を
  // 受け取っていたことを、ここで否定形として固定する。**
  test("AC-G20: 認証を付けないと 401 になる(着手前は 200 だった)", async () => {
    for (const path of [REQUIREMENTS, `${REQUIREMENTS}?format=json`]) {
      const response = await anonymous(path);
      expect(response.status, path).toBe(401);
      const errors = await errorsOf(response);
      expect(errors[0]?.message).toBe("認証が必要です。ログインしてください。");
    }
  });
});

// --- V1-M9-T12: 履歴書き込み失敗を成功レスポンスの明示項目に載せる(HTTP 経路)---------
//
// MCP と同型。POST(createRecord)/ PATCH(updateRecord)由来の履歴書き込み失敗を、
// 成功ステータス(201 / 200)のレスポンス JSON の明示項目 `workflow_history_failures` に
// 載せる(4xx にはしない —— 書き込みは成功しているため)。§4-2 の同期区間の規律を守る。

describe("V1-M9-T12: 履歴書き込み失敗を成功レスポンスに載せる(POST / PATCH)", () => {
  /** 履歴テーブルの5列(規約どおり)。 */
  const historyFields = [
    { id: "ran_at", name: "実行時刻", type: "date" as const },
    { id: "workflow", name: "ワークフロー", type: "text" as const },
    { id: "trigger_type", name: "きっかけ", type: "text" as const },
    { id: "status", name: "結果", type: "text" as const },
    { id: "error", name: "エラー", type: "long_text" as const },
  ];

  /**
   * books アプリに items + notifications + 履歴テーブル + on_create/on_update の2本を載せる。
   *
   * **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65`】既定が閉じたので、返す前に規則を足す。**
   * **さらに、きっかけの表 `items` に `st_owner` を1本足した** —— **足さないと自動処理の
   * 書き手が「誰でもない」に解決され、`notifications` への書込が面に弾かれて
   * ワークフローが1本も走らない**(理由の詳細は上の「ワークフローの発火」describe の
   * `beforeEach` の注記を参照)。**本 describe の主題(履歴書き込みの失敗を成功レスポンスに
   * 載せること)は1ミリも変わらない。**
   */
  function workflowManifest(): Manifest {
    return withDefaultRoleRules({
      app: {
        id: "books",
        name: "蔵書管理",
        tables: [
          {
            id: "items",
            name: "本",
            fields: [
              { id: "title", name: "タイトル", type: "text", required: true },
              { id: "memo", name: "メモ", type: "long_text" },
              // **【`V8-M26`】書き手を特定させるための1本。** **旧: この行は無かった。**
              { id: "st_owner", name: "所有者", type: "text" },
            ],
          },
          {
            id: "notifications",
            name: "通知",
            fields: [{ id: "title", name: "件名", type: "text" }],
          },
          { id: "wf-runs", name: "実行履歴", fields: historyFields },
        ],
        views: [],
        workflows: [
          {
            id: "notify-on-create",
            name: "登録を通知する",
            trigger: { type: "on_create", table: "items" },
            actions: [
              {
                action: "create_record",
                table: "notifications",
                values: { title: "登録されました" },
              },
            ],
            history_table: "wf-runs",
          },
          {
            id: "notify-on-update",
            name: "更新を通知する",
            trigger: { type: "on_update", table: "items" },
            actions: [
              {
                action: "create_record",
                table: "notifications",
                values: { title: "更新されました" },
              },
            ],
            history_table: "wf-runs",
          },
        ],
      },
    });
  }

  /** 履歴テーブルを物理的に落として、以後の発火で履歴書き込みが必ず失敗する状態にする。 */
  function breakHistoryTable(appId: string): void {
    const db = new Database(appDbPath(dataRoot, appId), { readwrite: true, create: false });
    try {
      db.run(`DROP TABLE "wf-runs"`);
    } finally {
      db.close();
    }
  }

  const BOOKS_ITEMS = "/api/apps/books/tables/items/records";

  test("POST は on_create の履歴書き込み失敗を workflow_history_failures に載せる(201 のまま)", async () => {
    expect(applyManifest(dataRoot, "books", workflowManifest()).valid).toBe(true);
    breakHistoryTable("books");

    const response = await request(post(BOOKS_ITEMS, { title: "吾輩は猫である" }));
    expect(response.status).toBe(201);
    const body = await json(response);
    expect((body.record as { title: string }).title).toBe("吾輩は猫である");

    const failures = body.workflow_history_failures as
      | { workflow: string; history_table: string; errors: unknown[] }[]
      | undefined;
    expect(failures).toBeDefined();
    expect(failures).toHaveLength(1);
    expect(failures?.[0]?.workflow).toBe("notify-on-create");
    expect(failures?.[0]?.history_table).toBe("wf-runs");
    expect((failures?.[0]?.errors.length ?? 0) > 0).toBe(true);
  });

  test("PATCH は on_update の履歴書き込み失敗を workflow_history_failures に載せる(200 のまま)", async () => {
    expect(applyManifest(dataRoot, "books", workflowManifest()).valid).toBe(true);

    // 先に1件作る(この on_create の履歴はまだ壊していないので成功)。
    const created = await request(post(BOOKS_ITEMS, { title: "坊っちゃん" }));
    expect(created.status).toBe(201);
    const id = ((await json(created)).record as { _id: string })._id;
    const recordPath = `${BOOKS_ITEMS}/${id}`;

    breakHistoryTable("books");
    const response = await request(patch(recordPath, { memo: "読了" }));
    expect(response.status).toBe(200);
    const body = await json(response);
    expect((body.record as { memo: string }).memo).toBe("読了");

    const failures = body.workflow_history_failures as { workflow: string }[] | undefined;
    expect(failures).toBeDefined();
    expect(failures).toHaveLength(1);
    expect(failures?.[0]?.workflow).toBe("notify-on-update");
  });

  test("履歴が健全なら POST の成功レスポンスに workflow_history_failures は出ない", async () => {
    expect(applyManifest(dataRoot, "books", workflowManifest()).valid).toBe(true);

    const response = await request(post(BOOKS_ITEMS, { title: "三四郎" }));
    expect(response.status).toBe(201);
    const body = await json(response);
    expect(body.workflow_history_failures).toBeUndefined();
    expect("workflow_history_failures" in body).toBe(false);
  });

  test("履歴が健全なら PATCH の成功レスポンスに workflow_history_failures は出ない", async () => {
    expect(applyManifest(dataRoot, "books", workflowManifest()).valid).toBe(true);
    const created = await request(post(BOOKS_ITEMS, { title: "こころ" }));
    const id = ((await json(created)).record as { _id: string })._id;
    const recordPath = `${BOOKS_ITEMS}/${id}`;

    const response = await request(patch(recordPath, { memo: "再読" }));
    expect(response.status).toBe(200);
    const body = await json(response);
    expect("workflow_history_failures" in body).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// V3-M5-T02: 逃げ道(任意 CSS)の配信(D-G5 / ADR-0055 限定2・6・7・13)
// ---------------------------------------------------------------------------
//
// **配信層はここ1本である。** マニフェストに在るのは参照(資産名 + ダイジェスト)だけで、
// 本体は owner 専用ストアにある —— この GET が両者を突き合わせ、**突き合わない場合は
// 1バイトも出さずに loud に断る**(限定6)。作用域の宣言外なら、参照が書かれていても
// **配信層が拒否する**(限定7)。
describe("GET /api/apps/:app_id/views/:view_id/custom.css(逃げ道の配信)", () => {
  const CSS = ".gp-list-table th { letter-spacing: 0.08em }";
  const CSS_V2 = ".gp-list-table th { letter-spacing: 0.20em }";

  /** 逃げ道の本体を置き、資産として発行する(owner の HTTP ルートがやることの直呼び)。 */
  function issue(appId: string, name: string, css: string, scopeViews: string[]): string {
    const digest = putEscapeHatchBody(dataRoot, appId, new TextEncoder().encode(css));
    const store = EscapeHatchStore.openForKernel(dataRoot);
    try {
      store.issueEscapeHatchAsset({ appId, name, digest, scopeViews });
    } finally {
      store.close();
    }
    return digest;
  }

  /** 資産を失効させる(登録だけ消える。本体は残る)。 */
  function revoke(appId: string, name: string, digest: string): void {
    const store = EscapeHatchStore.openForKernel(dataRoot);
    try {
      const asset = store.findEscapeHatchAsset(appId, name, digest);
      expect(asset).toBeDefined();
      store.deleteEscapeHatchAsset(asset?.id ?? "");
    } finally {
      store.close();
    }
  }

  /** 参照つきの画面を1枚足す差分を適用する。 */
  async function addViewWithCss(
    viewId: string,
    css: { asset: string; digest: string } | undefined,
    intent = "印刷したときの体裁を整えたい",
  ): Promise<Response> {
    const view: Record<string, unknown> = {
      id: viewId,
      type: "list_view",
      table: "items",
      columns: ["name"],
    };
    if (css !== undefined) {
      view.custom_css = css;
    }
    return await request(
      post("/api/apps/inventory/diffs", {
        diff_id: `d-${viewId}`,
        intent,
        operations: [{ op: "add_view", view }],
      }),
    );
  }

  const cssUrl = (viewId: string) => `/api/apps/inventory/views/${viewId}/custom.css`;

  test("参照が実在し作用域の内側なら、本体をそのまま配信する", async () => {
    const digest = issue("inventory", "print", CSS, ["print-list"]);
    expect((await addViewWithCss("print-list", { asset: "print", digest })).status).toBe(201);

    const response = await request(cssUrl("print-list"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/css");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe(CSS);
  });

  test("参照を持たない画面は 404 で、CSS を1バイトも返さない(通常の状態であり遮断ではない)", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const response = await request(cssUrl("item-list"));
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("application/json");
      // **これは遮断ではない**(参照が無いだけ)。loud にしない —— 全画面で鳴り続ける。
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("限定6: 参照先が未発行なら fail-closed かつ loud(サーバログ + 画面へ返す本文)", async () => {
    const digest = "b".repeat(64);
    expect((await addViewWithCss("ghost-list", { asset: "print", digest })).status).toBe(201);

    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const response = await request(cssUrl("ghost-list"));
      // fail-closed: CSS は1バイトも出ない。
      expect(response.status).toBe(409);
      expect(await response.text()).not.toContain("letter-spacing");
      // loud(宛先1): サーバログに、どの画面のどの資産が遮断されたかが出る。
      expect(warn).toHaveBeenCalled();
      const logged = warn.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(logged).toContain("[escape-hatch]");
      expect(logged).toContain("ghost-list");
      expect(logged).toContain("print");
    } finally {
      warn.mockRestore();
    }

    // loud(宛先2): 画面が読める文面が JSON で返る(黙って効かないのは憲法6 違反)。
    const body = await json(await request(cssUrl("ghost-list")));
    const errors = body.errors as ValidationError[];
    expect(errors[0]?.message).toContain("発行されていません");
    expect(errors[0]?.hint).toBeDefined();
  });

  test("限定6: 同じ名前でも内容ダイジェストが違えば未発行として遮断する(版は内容で決まる)", async () => {
    issue("inventory", "print", CSS, ["v2-list"]);
    const otherDigest = putEscapeHatchBody(dataRoot, "inventory", new TextEncoder().encode(CSS_V2));
    expect((await addViewWithCss("v2-list", { asset: "print", digest: otherDigest })).status).toBe(
      201,
    );

    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const response = await request(cssUrl("v2-list"));
      expect(response.status).toBe(409);
      expect(await response.text()).not.toContain("letter-spacing");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("限定7: 作用域の宣言外の画面では、参照が書かれていても配信層が拒否する", async () => {
    // owner は "allowed-list" にだけ当てることを宣言して発行した。
    const digest = issue("inventory", "print", CSS, ["allowed-list"]);
    expect((await addViewWithCss("allowed-list", { asset: "print", digest })).status).toBe(201);
    // **AI は別の画面にも同じ参照を書ける**(マニフェストは書ける)。
    expect((await addViewWithCss("other-list", { asset: "print", digest })).status).toBe(201);

    // 宣言内の画面には当たる。
    expect((await request(cssUrl("allowed-list"))).status).toBe(200);

    // 宣言外の画面では**配信層が拒否する**(fail-closed かつ loud)。
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const response = await request(cssUrl("other-list"));
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain("letter-spacing");
      expect(warn).toHaveBeenCalled();
      expect(warn.mock.calls.map((args) => args.join(" ")).join("\n")).toContain("作用域");
    } finally {
      warn.mockRestore();
    }
  });

  test("限定6: 登録はあるのに実体が消えていたら遮断する(中途半端に出さない)", async () => {
    const digest = issue("inventory", "print", CSS, ["broken-list"]);
    expect((await addViewWithCss("broken-list", { asset: "print", digest })).status).toBe(201);
    rmSync(join(appEscapeHatchDir(dataRoot, "inventory"), digest));

    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const response = await request(cssUrl("broken-list"));
      expect(response.status).toBe(409);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("update_view で既存画面に参照を付けると、その場で配信される(ADR-0055 改訂1)", async () => {
    // **既存画面(v0 から在る item-list)に、画面を作り直さずに逃げ道を当てる。**
    const digest = issue("inventory", "print", CSS, ["item-list"]);
    // 付ける前は「参照が無い」ので 404(遮断ではない)。
    expect((await request(cssUrl("item-list"))).status).toBe(404);

    const applied = await request(
      post("/api/apps/inventory/diffs", {
        diff_id: "d-attach-existing",
        intent: "既存の一覧に印刷用の体裁を当てたい",
        operations: [
          {
            op: "update_view",
            view: "item-list",
            changes: { custom_css: { asset: "print", digest } },
          },
        ],
      }),
    );
    expect(applied.status).toBe(201);

    // **1 op で当たる。**画面の他の設定(columns)は1バイトも動いていない。
    const response = await request(cssUrl("item-list"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(CSS);
    const manifest = await json(await request("/api/apps/inventory/manifest"));
    const view = (manifest.app as { views: { id: string; columns?: string[] }[] }).views.find(
      (v) => v.id === "item-list",
    );
    expect(view?.columns).toEqual(["name", "quantity"]);

    // undo すると参照だけが消え、画面はそのまま残る(画面を作り直していないため)。
    expect((await request(post("/api/apps/inventory/undo", {}))).status).toBe(200);
    expect((await request(cssUrl("item-list"))).status).toBe(404);
    const after = await json(await request("/api/apps/inventory/manifest"));
    expect((after.app as { views: { id: string }[] }).views.map((v) => v.id)).toContain(
      "item-list",
    );
  });

  test("存在しない画面IDは 404 で、実在する画面IDを allowed_values に載せる", async () => {
    const response = await request(cssUrl("no-such-view"));
    expect(response.status).toBe(404);
    const errors = await errorsOf(response);
    expect(errors[0]?.allowed_values).toContain("item-list");
  });

  test("存在しないアプリは 404", async () => {
    const response = await request("/api/apps/nope/views/item-list/custom.css");
    expect(response.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // 完了条件4: undo の往復を3つの場合で見る(ADR-0055 §4 限界3)
  // -------------------------------------------------------------------------

  test("(a) undo で参照が消えると、見た目の出所も消える", async () => {
    const digest = issue("inventory", "print", CSS, ["undo-a"]);
    expect((await addViewWithCss("undo-a", { asset: "print", digest })).status).toBe(201);
    expect((await request(cssUrl("undo-a"))).status).toBe(200);

    expect((await request(post("/api/apps/inventory/undo", {}))).status).toBe(200);

    // 画面ごと消えたので 404。**当たっていた CSS はもうどこからも配信されない。**
    const after = await request(cssUrl("undo-a"));
    expect(after.status).toBe(404);
    expect(await after.text()).not.toContain("letter-spacing");
  });

  test("(b) owner が本体を書き換えたあとに undo しても、過去の見た目が戻る(content-addressing)", async () => {
    const v1 = issue("inventory", "print", CSS, ["undo-b"]);
    expect((await addViewWithCss("undo-b", { asset: "print", digest: v1 })).status).toBe(201);
    expect(await (await request(cssUrl("undo-b"))).text()).toBe(CSS);

    // owner が「同じ名前で中身を書き換えた」= 新しい版を発行する(旧版は上書きされない)。
    const v2 = issue("inventory", "print", CSS_V2, ["undo-b", "undo-b2"]);
    expect(v2).not.toBe(v1);
    // 参照を新しい版へ差し替える。**update_view 1 op で済む**(ADR-0055 改訂1 / 門A の
    // 差し戻し判定。以前は remove_view + add_view の2 op が要った)。
    const swapped = await request(
      post("/api/apps/inventory/diffs", {
        diff_id: "d-undo-b-v2",
        intent: "見出しの字間を広げた版に差し替える",
        operations: [
          {
            op: "update_view",
            view: "undo-b",
            changes: { custom_css: { asset: "print", digest: v2 } },
          },
        ],
      }),
    );
    expect(swapped.status).toBe(201);
    expect(await (await request(cssUrl("undo-b"))).text()).toBe(CSS_V2);

    // undo すると参照が v1 に戻り、**v1 の実体が壊れていないので過去の見た目が戻る。**
    expect((await request(post("/api/apps/inventory/undo", {}))).status).toBe(200);
    const restored = await request(cssUrl("undo-b"));
    expect(restored.status).toBe(200);
    expect(await restored.text()).toBe(CSS);
  });

  test("(c) owner が失効させたあとに undo すると、参照は戻るが実体は無い —— 限定6 が発火する", async () => {
    // **これは「undo が壊れている」ではない。**「戻せなかったことが分かる」が正しい振る舞いで
    // ある(ADR-0055 §4 限界3)。**同時に「undo で必ず見た目が戻る」とも言えない。**
    const digest = issue("inventory", "print", CSS, ["undo-c"]);
    expect((await addViewWithCss("undo-c", { asset: "print", digest })).status).toBe(201);
    expect((await request(cssUrl("undo-c"))).status).toBe(200);

    // 参照を外す差分を当てて、そのあと owner が資産を明示的に失効させる。
    const removed = await request(
      post("/api/apps/inventory/diffs", {
        diff_id: "d-undo-c-off",
        intent: "逃げ道をやめる",
        operations: [{ op: "remove_view", view: "undo-c" }],
      }),
    );
    expect(removed.status).toBe(201);
    revoke("inventory", "print", digest);

    // undo すると**参照は戻る**(マニフェストは元通り)。
    expect((await request(post("/api/apps/inventory/undo", {}))).status).toBe(200);
    const manifest = await json(await request("/api/apps/inventory/manifest"));
    const views = (manifest.app as { views: { id: string; custom_css?: unknown }[] }).views;
    expect(views.find((v) => v.id === "undo-c")?.custom_css).toEqual({
      asset: "print",
      digest,
    });

    // **だが実体(登録)は無いので、配信は fail-closed かつ loud になる。**
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const response = await request(cssUrl("undo-c"));
      expect(response.status).toBe(409);
      expect(await response.text()).not.toContain("letter-spacing");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  // -------------------------------------------------------------------------
  // 完了条件5: 参照の追加・変更・削除が `_changelog` に intent つきで載る(憲法5)
  // -------------------------------------------------------------------------

  test("参照の追加・変更・削除が changelog に intent つきで載る(いつ・どの画面に・なぜ)", async () => {
    const v1 = issue("inventory", "print", CSS, ["log-list"]);
    const v2 = issue("inventory", "print", CSS_V2, ["log-list"]);
    expect(
      (await addViewWithCss("log-list", { asset: "print", digest: v1 }, "印刷の体裁を整えたい"))
        .status,
    ).toBe(201);
    // **変更は update_view 1 op である**(ADR-0055 改訂1)。
    expect(
      (
        await request(
          post("/api/apps/inventory/diffs", {
            diff_id: "d-log-swap",
            intent: "字間をもう少し広げたいと言われた",
            operations: [
              {
                op: "update_view",
                view: "log-list",
                changes: { custom_css: { asset: "print", digest: v2 } },
              },
            ],
          }),
        )
      ).status,
    ).toBe(201);
    // **削除(参照を外すこと)は前進ではできない** —— `update_view` はキーを消す手段を
    // 持たない(プリセット7キーと同じ性質)。**外す道は remove_view + add_view か undo である。**
    // ここでは前者を使う(changelog に「なぜ外したか」を残せるのは前者だけである)。
    expect(
      (
        await request(
          post("/api/apps/inventory/diffs", {
            diff_id: "d-log-drop",
            intent: "標準の体裁に戻したい",
            operations: [
              { op: "remove_view", view: "log-list" },
              {
                op: "add_view",
                view: { id: "log-list", type: "list_view", table: "items", columns: ["name"] },
              },
            ],
          }),
        )
      ).status,
    ).toBe(201);

    const body = await json(await request("/api/apps/inventory/changelog"));
    const entries = body.changelog as {
      diff_id: string;
      intent: string;
      operations: { op: string; view?: unknown }[];
    }[];
    const find = (diffId: string) => entries.find((e) => e.diff_id === diffId);

    // 追加: どの画面に、どの資産の、どの版が当たったかと、**なぜ**が読める。
    const added = find("d-log-list");
    expect(added?.intent).toBe("印刷の体裁を整えたい");
    expect(JSON.stringify(added?.operations)).toContain(v1);
    expect(JSON.stringify(added?.operations)).toContain("log-list");
    // 変更: 新しい版のダイジェストと意図。**1 op で読める**(2 op に割れない)。
    const swapped = find("d-log-swap");
    expect(swapped?.intent).toBe("字間をもう少し広げたいと言われた");
    expect(JSON.stringify(swapped?.operations)).toContain(v2);
    expect(swapped?.operations).toHaveLength(1);
    // 削除: 参照を持たない画面へ書き換えたことと意図。
    const dropped = find("d-log-drop");
    expect(dropped?.intent).toBe("標準の体裁に戻したい");
    expect(JSON.stringify(dropped?.operations)).not.toContain(v2);
    // **載るのは参照(名前 + ダイジェスト)であって CSS の中身ではない**(ADR-0055 §4 限界4)。
    expect(JSON.stringify(entries)).not.toContain("letter-spacing");
  });
});

/**
 * **【`V8-M20` / 台帳 `J-G30` / `ADR-0301`】置き直した節。**
 *
 * **旧の describe 名(逐語)**: `運営可視の宣言(st_admin_readable)の射程(V3-M8-T01 / ADR-0061)`。
 *
 * **予約規約フィールド `st_admin_readable` は廃止された** —— **残る予約規約フィールドは
 * `st_owner` / `st_public` / `st_undeletable` / `st_no_direct_create` の4本である。**
 * **代わりに立つのは面の表の規則(`app.roles[].rules` の
 * `{ target: "table", table, can: [...] }`)であり、その本体は
 * `src/server/role-read-crosses-owner-scope.test.ts` が測る。**
 *
 * **下の2本は撤去した語彙に依存していなかったので、消さずに残す** ——
 * **fixture から `st_admin_readable` の列だけを落とした。**
 * **1本目は「`st_owner` が無い表には post-filter そのものが無い」ことを、**
 * **2本目は「書込認可は読取可視性と別に決まる」ことを測っており、どちらも今日も真である。**
 */
describe("個人スコープを持たない表の読取と、viewer の書込(V3-M8-T01 / ADR-0061 → V8-M20)", () => {
  const APP = "adminscope";

  /** 個人所有 / 個人所有でない の2テーブルを持つアプリを一時 dataRoot に作る。 */
  async function withApp(
    fn: (ctx: { root: string; app: ReturnType<typeof createServerApp> }) => Promise<void>,
  ): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "gp-adminscope-"));
    try {
      const store = KernelMetaStore.open(root);
      try {
        createApp(store, "運営可視の射程", { app_id: APP });
      } finally {
        store.close();
      }
      // **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65`】既定が閉じたので、題材へ規則を足す。**
      // **`orders` は個人所有(`st_owner`)の表だが、下の2本はどちらも `orders` の
      // **読取**を測っていない**(1本目は `notices` の読取、2本目は `orders` への
      // `viewer` の**書込**)—— **`D-V8-35`(面が読取を許した表では `st_owner` の
      // 読取の絞り込みを越える)には触れない。**
      const applied = applyManifest(
        root,
        APP,
        withDefaultRoleRules({
          app: {
            id: APP,
            name: "運営可視の射程",
            tables: [
              {
                id: "orders", // 個人所有
                // **【`V8-M20` / `J-G30` / `ADR-0301`】旧: ここに
                // `{ id: "st_admin_readable", name: "運営可視", type: "boolean" }` が在った。**
                name: "注文",
                fields: [
                  { id: "title", name: "題", type: "text", required: true },
                  { id: "st_owner", name: "所有者", type: "text" },
                ],
              },
              {
                id: "notices", // 個人所有ではない
                // **【`V8-M20` / `J-G30` / `ADR-0301`】旧: ここにも
                // `{ id: "st_admin_readable", name: "運営可視", type: "boolean" }` が在った。**
                name: "掲示",
                fields: [{ id: "title", name: "題", type: "text", required: true }],
              },
            ],
            views: [{ id: "order-list", type: "list_view", table: "orders", columns: ["title"] }],
          },
        } satisfies Manifest),
      );
      expect(applied.valid).toBe(true);
      await fn({ root, app: createServerApp({ dataRoot: root }) });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  function call(
    ctx: { app: ReturnType<typeof createServerApp> },
    cookie: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const headers: Record<string, string> = { cookie, origin: TEST_ORIGIN };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return Promise.resolve(ctx.app.request(new Request(`http://localhost${path}`, init)));
  }

  // **【`V8-M20` / `J-G30` / `ADR-0301`】旧テスト名**:
  // `個人所有でないテーブル(宣言だけ)は、宣言の有無で読取が1ミリも変わらない`。
  test("個人所有でないテーブルは、運営も編集者も同じ行を読む(post-filter そのものが無い)", async () => {
    await withApp(async (ctx) => {
      const admin = seedSession(ctx.root, APP, { role: "owner", username: "admin" });
      const staff = seedSession(ctx.root, APP, { role: "editor", username: "staff" });
      const path = `/api/apps/${APP}/tables/notices/records`;
      expect((await call(ctx, staff.cookie, "POST", path, { title: "掲示1" })).status).toBe(201);
      // st_owner が無いので post-filter そのものが無い —— 従来どおり両者に見える。
      for (const cookie of [admin.cookie, staff.cookie]) {
        const res = await call(ctx, cookie, "GET", path);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { records: unknown[]; total: number };
        expect(body.records).toHaveLength(1);
        expect(body.total).toBe(1);
      }
    });
  });

  // **【`V8-M20` / `J-G30` / `ADR-0301`】旧テスト名**:
  // `宣言済みテーブルでも viewer の書込は 403 のまま(書込認可は読取可視性と別に決まる)`。
  test("個人スコープのテーブルでも viewer の書込は 403 のまま(書込認可は読取可視性と別に決まる)", async () => {
    await withApp(async (ctx) => {
      const viewer = seedSession(ctx.root, APP, { role: "viewer", username: "peek" });
      const path = `/api/apps/${APP}/tables/orders/records`;
      expect((await call(ctx, viewer.cookie, "POST", path, { title: "注文" })).status).toBe(403);
    });
  });
});
