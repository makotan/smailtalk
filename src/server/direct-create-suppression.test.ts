/**
 * 「このテーブルへは直接作らせない」を宣言する —— 予約規約フィールド5本目
 * (`st_no_direct_create`)のサーバ層テスト(`V4-M10-T04` / `T05`。
 * **`ADR-0077` = `V4-M7` 単位2 の限定採用。限定表10点**)。
 *
 * 目的(`ADR-0077` §S1 逐語): **「このテーブルの行は、利用者が画面や API から直接作るのでは
 * なく、決められた自動処理を通してだけ作られるようにしたい。読むことは今日どおりできる。」**
 *
 * **この検査が固定するのは限定表の内側だけである**(`docs/adr/0077-direct-create-suppression.md` §3):
 *
 * | 限定 | ここで固定するもの |
 * |---|---|
 * | 1 | 足すのは予約規約フィールド1本だけ(boolean・非required)。`schemas/` と `src/kernel/` に1バイトも差分を出さない |
 * | 2 | 予約規約フィールド定数が**5本**を超えない |
 * | 3 | **止めるのは `POST` と `/batch` の create op だけ**。`PATCH` / `DELETE` を1バイトも変えない |
 * | 4 | **ワークフローの `create_record` と島の create op を1ミリも止めない**(これが目的である) |
 * | 5 | **既定は「今日どおり作れる」** |
 * | 7 | 匿名に漏らさない(`ANON_RESERVED_FIELDS`) |
 * | 8 | **読取スコープを1ミリも変えない**(本人は自分の行を読める) |
 * | 9 | 宣言はテーブル単位。**行の値は判定に使わない** |
 *
 * ## この検査が言わないこと(誇張しない)
 *
 * - **MCP / 受信 capability / 島 / ワークフローの経路は1ミリも守られない**(限定6 の帰結)。
 * - **「決められた自動処理」の「決められた」は表現できない**(限定10)。**どのワークフローでも作れる。**
 * - **既存の壊れた行は1件も直らない**(`ADR-0077` §S3 (e))。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyManifest,
  createApp,
  createRecord,
  KernelMetaStore,
  type Manifest,
} from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import {
  ANON_RESERVED_FIELDS,
  NO_DIRECT_CREATE_FIELD,
  OWNER_FIELD,
  PUBLIC_FIELD,
} from "./owner-scope.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

/**
 * 移した公開単位の根(`apps/smailtalk/`)。**`import.meta.dir` から数える** ——
 * cwd 相対で解くと `bun test` を打つ場所で結果が変わる(`src/` はもうルート直下に無い)。
 */
const PRODUCT_ROOT = join(import.meta.dir, "..", "..");

const APP_ID = "ndc-shop";

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "直接作成の遮断テスト",
      tables: [
        {
          // 宣言つき × 顧客スコープ(= 参照 EC の `order` と同じ形)。
          id: "orders",
          name: "注文",
          fields: [
            { id: "item", name: "品目", type: "text", required: true },
            { id: OWNER_FIELD, name: "所有者", type: "text" },
            { id: NO_DIRECT_CREATE_FIELD, name: "直接作成の遮断", type: "boolean" },
          ],
        },
        {
          // **宣言なし**(既定 = 今日どおり作れる)。
          id: "carts",
          name: "カート",
          fields: [
            { id: "item", name: "品目", type: "text", required: true },
            { id: OWNER_FIELD, name: "所有者", type: "text" },
          ],
        },
        {
          // 宣言つき × 公開(匿名応答に現れないことの検査用)。
          id: "notices",
          name: "お知らせ",
          fields: [
            { id: "title", name: "題", type: "text", required: true },
            { id: PUBLIC_FIELD, name: "公開", type: "boolean" },
            { id: NO_DIRECT_CREATE_FIELD, name: "直接作成の遮断", type: "boolean" },
          ],
        },
      ],
      views: [{ id: "order-list", type: "list_view", table: "orders", columns: ["item"] }],
      // **【`V8-M26`】面の既定が閉じたので、既定3役割の外(`customer` / `anonymous`)には
      // 表の規則を手で書く必要がある。** **既定3役割の分は `withDefaultRoleRules` が足す。**
      //
      // **`ADR-0077` の限定表を測るために最低限だけ配る** ——
      //  - `customer` … `orders` の読取・書込・削除(限定3 の `PATCH` / `DELETE` と 限定8 の読取)
      //    と `carts` の読取・書込(限定5 の「宣言していない表は今日どおり作れる」)。
      //  - `anonymous` … `notices` の読取(限定7 の匿名公開読取)。
      //
      // **`orders` に `write` を配っても 限定3 の `POST` = 403 は変わらない** ——
      // **止めているのは `st_no_direct_create` であって面ではない**(下の 限定3 の2本が
      // `customer` でも `owner` でも 403 のまま緑であることが、その対照になっている)。
      //
      // **【`orders` の規則に条件(`when`)を付けてある。理由を実測で書く】**
      // **条件を外して素の `{ can: ["read", ...] }` にすると、限定8(本人は自分の行だけを
      // 読める)が `records` 1件 → **2件** になる** —— **`D-V8-35` により
      // 「この表を読める」と書いた役割は `st_owner` の軸を越えて全員分が見えるからである。**
      // **つまり `V8-M26` の既定が閉じた今日、`st_owner` の表で「自分の行だけ読める客」を
      // 表すには、条件つきの規則を書くしかない**(素の読取は0件か全件かの二択になる)。
      roles: [
        {
          id: "customer",
          name: "お客様",
          rules: [
            {
              target: "table",
              table: "orders",
              can: ["read", "write", "delete"],
              when: { field: OWNER_FIELD, equals_current_user: true },
            },
            { target: "table", table: "carts", can: ["read", "write"] },
            // **【`V18-M4-T02b`。ユーザ決定 `D-V18-26` / `ADR-0441`】画面の規則を1本足した。**
            //
            // **`V18-M4-T02` が「画面名を名乗らない読取」に壁を立てた** —— **その表を指す
            // 一覧系の画面(`list_view` / `report_view`)を**1本も読めない**相手の一覧は 0件に
            // なる(単票は 404)。** **`D-V18-26` により、画面を宣言しているのに「誰に見せるか」を
            // 役割の規則に1行も書いていない場合も止まる。**
            //
            // **この題材は `order-list`(`list_view`。表 `orders`)を宣言しながら、
            // その画面の規則を1本も書いていなかった。** **限定8(本人は自分の行を
            // 今日どおり読める)が測っているのは `st_no_direct_create` と `st_owner` の
            // 層であって画面の規則ではないので、主張(`expect`)は1バイトも
            // 書き換えていない。**
            { target: "view", view: "order-list", can: ["read"] },
          ],
        },
        {
          id: "anonymous",
          name: "未ログイン",
          rules: [{ target: "table", table: "notices", can: ["read"] }],
        },
      ],
    },
  } as unknown as Manifest;
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-ndc-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "直接作成の遮断テスト", { app_id: APP_ID });
  } finally {
    store.close();
  }
  // **【`V8-M26`】既定3役割の規則を足す**(`apply-diff.ts` の自動付与と同じ規則)。
  expect(applyManifest(dataRoot, APP_ID, withDefaultRoleRules(manifest())).valid).toBe(true);
  app = createServerApp({ dataRoot });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

function req(
  cookie: string | undefined,
  method: string,
  path: string,
  body?: unknown,
  ifMatch?: string,
): Promise<Response> {
  const headers: Record<string, string> = { origin: TEST_ORIGIN };
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  if (ifMatch !== undefined) {
    headers["if-match"] = ifMatch;
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return Promise.resolve(app.request(new Request(`http://localhost${path}`, init)));
}

const R = (table: string, id?: string) =>
  `/api/apps/${APP_ID}/tables/${table}/records${id === undefined ? "" : `/${id}`}`;

const customer = (username: string) =>
  seedSession(dataRoot, APP_ID, { role: "customer", username });
const owner = (username: string) => seedSession(dataRoot, APP_ID, { role: "owner", username });

/** カーネル経路(= ワークフロー / 島が通る経路)で行を1件作る。 */
function createViaKernel(table: string, values: Record<string, unknown>): Record<string, unknown> {
  const db = new Database(join(dataRoot, "apps", APP_ID, "app.sqlite"));
  try {
    const result = createRecord(db, manifest(), table, values);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("createRecord failed");
    }
    return result.value as Record<string, unknown>;
  } finally {
    db.close();
  }
}

// --- 限定2: 予約規約フィールドは4本で止まる ----------------------------------------------

// **【`V8-M20` / 台帳 `J-G30` / `ADR-0301`】予約規約フィールドは 5本 → 4本。**
// **`st_admin_readable` を廃止し、面の規則(役割 × 対象(表)× 読取)へ置き直した。**
// **旧のテスト名: 「限定2: 予約規約フィールドは5本で止まっている(6本目には改めて門A が要る)」。**
// **旧の期待値: `["st_owner", "st_public", "st_admin_readable", "st_undeletable",
//   "st_no_direct_create"]`。**
// **`ADR-0077` 限定2 の趣旨(勝手に本数を増やさない = 増やすなら門A)は今日も生きている。**
test("限定2: 予約規約フィールドは4本で止まっている(5本目には改めて門A が要る)", async () => {
  // **`ADR-0077` 限定2 の逐語が指定した検査式をそのまま使う** —— 素朴な
  // `grep -c "^export const .*_FIELD"` は `ANON_RESERVED_FIELDS` を拾ってしまう。
  // **(`READ_HIDDEN_RESERVED_FIELDS` は `V8-M20` で消えたので、今日はもう拾わない。)**
  const source = await readFile(join(PRODUCT_ROOT, "src", "server", "owner-scope.ts"), "utf-8");
  const fields = [...source.matchAll(/^export const ([A-Z_]+_FIELD) = "(st_[a-z_]+)";$/gm)].map(
    (m) => m[2] as string,
  );
  expect(fields).toEqual(["st_owner", "st_public", "st_undeletable", "st_no_direct_create"]);
});

// --- 限定3: 止めるのは POST と /batch の create op だけ ------------------------------------

test("限定3: 宣言した表への POST は 403(顧客)", async () => {
  const c = customer("c1");
  const res = await req(c.cookie, "POST", R("orders"), { item: "本" });
  expect(res.status).toBe(403);
});

test("限定3: 宣言した表への POST は運営(owner)でも 403(宣言はロールで出し分けない)", async () => {
  const o = owner("o1");
  const res = await req(o.cookie, "POST", R("orders"), { item: "本" });
  expect(res.status).toBe(403);
});

test("限定3: 宣言した表への /batch の create op は 403", async () => {
  // **バッチ経路は今日 editor / owner にしか開いていない**(`app.ts` の `batchAuthMiddleware`)。
  // **customer で叩くと `ADR-0077` とは別の理由で 403 になるので、owner で叩く。**
  const c = owner("o-batch");
  const res = await req(c.cookie, "POST", `/api/apps/${APP_ID}/batch`, {
    ops: [{ op: "create", table: "orders", values: { item: "本" } }],
  });
  expect(res.status).toBe(403);
});

test("限定3: 宣言した表でも PATCH は1ミリも変わらない", async () => {
  const c = customer("c1");
  const row = createViaKernel("orders", { item: "本", [OWNER_FIELD]: c.userId });
  const res = await req(
    c.cookie,
    "PATCH",
    R("orders", row._id as string),
    { item: "本(改)" },
    row._updated_at as string,
  );
  expect(res.status).toBe(200);
});

test("限定3: 宣言した表でも DELETE は1ミリも変わらない", async () => {
  const c = customer("c1");
  const row = createViaKernel("orders", { item: "本", [OWNER_FIELD]: c.userId });
  const res = await req(
    c.cookie,
    "DELETE",
    R("orders", row._id as string),
    undefined,
    row._updated_at as string,
  );
  expect(res.status).toBe(204);
});

test("限定3: 宣言した表でも /batch の update op は1ミリも変わらない", async () => {
  const c = owner("o-batch");
  const row = createViaKernel("orders", { item: "本", [OWNER_FIELD]: c.userId });
  const res = await req(c.cookie, "POST", `/api/apps/${APP_ID}/batch`, {
    ops: [{ op: "update", table: "orders", target: row._id as string, values: { item: "本(改)" } }],
  });
  expect(res.status).toBe(200);
});

// --- 限定4: 自動処理の create は1ミリも止まらない(**これが目的である**)-------------------

test("限定4: 宣言した表にカーネル経路(ワークフロー / 島)は今日どおり create できる", () => {
  const row = createViaKernel("orders", { item: "自動生成" });
  expect(row.item).toBe("自動生成");
});

// --- 限定5: 既定は「今日どおり作れる」---------------------------------------------------

test("限定5: 宣言していない表の POST は今日どおり 201", async () => {
  const c = customer("c1");
  const res = await req(c.cookie, "POST", R("carts"), { item: "本" });
  expect(res.status).toBe(201);
});

test("限定5: 宣言していない表の /batch の create op は今日どおり 200", async () => {
  const c = owner("o-batch");
  const res = await req(c.cookie, "POST", `/api/apps/${APP_ID}/batch`, {
    ops: [{ op: "create", table: "carts", values: { item: "本" } }],
  });
  expect(res.status).toBe(200);
});

// --- 限定8: 読取スコープを1ミリも変えない -----------------------------------------------

test("限定8: 宣言した表を、本人は今日どおり読める(目的文の後段)", async () => {
  const c = customer("c1");
  createViaKernel("orders", { item: "本", [OWNER_FIELD]: c.userId });
  createViaKernel("orders", { item: "他人の本", [OWNER_FIELD]: "someone-else" });
  const res = await req(c.cookie, "GET", R("orders"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { records: Record<string, unknown>[] };
  // **自分の行だけが見える** —— `st_owner` の post-filter は1ミリも動いていない。
  expect(body.records).toHaveLength(1);
  expect(body.records[0]?.item).toBe("本");
});

// --- 限定7: 匿名に漏らさない ------------------------------------------------------------

test("限定7: 匿名の公開読取に st_no_direct_create が1件も現れない", async () => {
  createViaKernel("notices", { title: "臨時休業", [PUBLIC_FIELD]: true });
  const res = await req(undefined, "GET", R("notices"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { records: Record<string, unknown>[] };
  expect(body.records).toHaveLength(1);
  expect(Object.hasOwn(body.records[0] ?? {}, NO_DIRECT_CREATE_FIELD)).toBe(false);
});

// **【`V8-M20` / 台帳 `J-G30` / `ADR-0301`】`ANON_RESERVED_FIELDS` は 5本 → 4本。**
// **`ADMIN_READABLE_FIELD`(`st_admin_readable`)を廃止した1本ぶん。**
// **旧のテスト名: 「限定7: ANON_RESERVED_FIELDS に5本すべてが入っている」。**
// **旧の期待値: `expect(ANON_RESERVED_FIELDS).toHaveLength(5);`。**
test("限定7: ANON_RESERVED_FIELDS に4本すべてが入っている", () => {
  expect(ANON_RESERVED_FIELDS).toContain(NO_DIRECT_CREATE_FIELD);
  expect(ANON_RESERVED_FIELDS).toHaveLength(4);
});

// --- 限定9: 宣言はテーブル単位。行の値は判定に使わない ------------------------------------

test("限定9: 行に false を書いても宣言は解けない(フィールドが在ることだけが宣言である)", async () => {
  const c = customer("c1");
  const res = await req(c.cookie, "POST", R("orders"), {
    item: "本",
    [NO_DIRECT_CREATE_FIELD]: false,
  });
  expect(res.status).toBe(403);
});

// --- 限定1 / 限定6: schemas に現れない / 判定は owner-scope.ts に集約 ----------------------

test("限定1: schemas/ に st_no_direct_create が1文字も現れない", async () => {
  const manifestSchema = await readFile(
    join(PRODUCT_ROOT, "schemas", "manifest.schema.json"),
    "utf-8",
  );
  const diffSchema = await readFile(join(PRODUCT_ROOT, "schemas", "diff.schema.json"), "utf-8");
  expect(manifestSchema).not.toContain(NO_DIRECT_CREATE_FIELD);
  expect(diffSchema).not.toContain(NO_DIRECT_CREATE_FIELD);
});
