/**
 * ある状態から先の行を消せなくする —— 予約規約フィールド4本目(`st_undeletable`)の
 * サーバ層テスト(V4-M4-T04 / T05。**ADR-0073 = `B-G8` の限定採用。限定表11点**)。
 *
 * 目的(`D-V4-2` 逐語): **消すのではなく「取り消し」にする** —— 購入者ができるのは
 * キャンセルの申し込みまで。**行は残り、運営が状態を動かす。**
 *
 * **この検査が固定するのは限定表の内側だけである**(`ADR-0073` §3):
 *
 * | 限定 | ここで固定するもの |
 * |---|---|
 * | 1 | 足すのは予約規約フィールド1本だけ(boolean・非required)。**表に在るだけでは何も起きない** |
 * | 3 | **止めるのは `DELETE` だけ。守られた行への `PATCH` は今日どおり通る**(= 運営が状態を動かせる) |
 * | 4 | **既定は「今日どおり消せる」**(宣言していない表・値が立っていない行) |
 * | 7 | 匿名応答に現れない |
 * | 9 | **購入者が状態を直接動かせる実装にしない**(他人の行は `st_owner` の scoped 判定で届かない) |
 * | 10 | `If-Match` の CAS と個人スコープの事前判定を1バイトも変えない |
 *
 * **【正直に書く】限定9 には今日ふさがっていない穴がある** —— 最後の2本(`(穴)` で
 * 始まるテスト)がそれを**実測で固定している。** 詳細は `docs/plan/v4/records/v4-m4-t05.md`。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { OWNER_FIELD, PUBLIC_FIELD, UNDELETABLE_FIELD } from "./owner-scope.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "shop";

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "ショップ",
      tables: [
        {
          // 宣言つき × 顧客スコープ(= 参照 EC の `order` と同じ形)。
          id: "orders",
          name: "注文",
          fields: [
            { id: "item", name: "品目", type: "text", required: true },
            { id: OWNER_FIELD, name: "所有者", type: "text" },
            { id: UNDELETABLE_FIELD, name: "削除不可", type: "boolean" },
          ],
        },
        {
          // **宣言なし**(既定 = 今日どおり消せる)。
          id: "memos",
          name: "メモ",
          fields: [
            { id: "body", name: "本文", type: "text", required: true },
            { id: OWNER_FIELD, name: "所有者", type: "text" },
          ],
        },
        {
          // 宣言つき × **運営テーブル**(`st_owner` も `st_public` も無い)。
          // owner が自分で消せる表で「行の状態が止める」ことを見るために要る。
          id: "announcements",
          name: "掲示",
          fields: [
            { id: "body", name: "本文", type: "text", required: true },
            { id: UNDELETABLE_FIELD, name: "削除不可", type: "boolean" },
          ],
        },
        {
          // 宣言つき × 公開(匿名応答に現れないことの検査用)。
          id: "notices",
          name: "お知らせ",
          fields: [
            { id: "title", name: "題", type: "text", required: true },
            { id: PUBLIC_FIELD, name: "公開", type: "boolean" },
            { id: UNDELETABLE_FIELD, name: "削除不可", type: "boolean" },
          ],
        },
      ],
      views: [{ id: "order-list", type: "list_view", table: "orders", columns: ["item"] }],
    },
  };
}

/**
 * **【`V8-M26`】適用する題材**(`beforeEach` が `applyManifest` に渡すもの)。
 *
 * **既定が閉じた**(`V8-M26` / ユーザ決定 `D-V8-45` / `D-V8-65`)—— **規則を1本も
 * 名指ししていない表・画面・ボタンは拒否される。****本ファイルの主題は行の状態
 * (`st_undeletable`)であって面の判定ではない**ので、面は開けたうえで測る。
 *
 * **足す規則は最小限である**:
 * - `withDefaultRoleRules` が既定3役割(`owner` / `editor` / `viewer`)へ
 *   `apply-diff.ts` の自動付与と同じ規則を入れる(実アプリでは差分を通せば必ず入るもの)。
 * - **`customer`** は既定3役割に入らないので手で書く —— **本ファイルの主役は購入者であり、
 *   購入者が自分の行を作る・読む・消せることが前提だからである。**
 * - **`anonymous`** には `notices` の**読取1語だけ**を書く —— **限定7(匿名応答に
 *   `st_undeletable` が現れない)は「匿名が公開行を読めた上で、その項目が落ちている」ことを
 *   測る検査であり、読めなければ主題そのものが測れない。****書込・削除は1語も書いていない。**
 *
 * **`customer` の規則には条件(`when`)を付けている** —— **`D-V8-35` により、面が表の
 * **読取**を許すとその役割は `st_owner`(個人スコープ)を読取について越えるので、
 * 素で書くと購入者に全員分の注文が見えてしまう**(限定9 / 限定10 が測っている性質の消滅)。
 * **`when: { field: st_owner, equals_current_user: true }` で「自分の行についてだけ」に絞る**
 * (`V8-M18` / `J-G12`。`src/server/owner-scope.test.ts:916` と同じ形)。
 */
function seededManifest(): Manifest {
  const m = manifest() as Manifest & {
    app: { roles?: { id: string; name: string; rules?: unknown[] }[] };
  };
  m.app.roles = [
    {
      id: "customer",
      name: "購入者",
      rules: [
        {
          target: "table",
          table: "orders",
          can: ["read", "write", "delete"],
          when: { field: OWNER_FIELD, equals_current_user: true },
        },
        {
          target: "table",
          table: "memos",
          can: ["read", "write", "delete"],
          when: { field: OWNER_FIELD, equals_current_user: true },
        },
      ],
    },
    {
      id: "anonymous",
      name: "未ログイン",
      rules: [{ target: "table", table: "notices", can: ["read"] }],
    },
  ];
  return withDefaultRoleRules(m);
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-undel-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "ショップ", { app_id: APP_ID });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP_ID, seededManifest()).valid).toBe(true);
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

async function create(
  cookie: string,
  table: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await req(cookie, "POST", R(table), body);
  expect(res.status).toBe(201);
  return ((await res.json()) as { record: Record<string, unknown> }).record;
}

async function versionOf(cookie: string, table: string, id: string): Promise<string> {
  const res = await req(cookie, "GET", R(table, id));
  const etag = res.headers.get("etag");
  if (etag !== null) {
    return etag;
  }
  return ((await res.json()) as { record: { _updated_at: string } }).record._updated_at;
}

const customer = (username: string) =>
  seedSession(dataRoot, APP_ID, { role: "customer", username });
const owner = (username: string) => seedSession(dataRoot, APP_ID, { role: "owner", username });

// --- 限定4: 既定は「今日どおり消せる」-----------------------------------------------

test("限定4: 宣言していない表の DELETE は今日どおり通る(既存の全アプリが1バイトも変わらない)", async () => {
  const c = customer("c1");
  const memo = await create(c.cookie, "memos", { body: "覚え書き" });
  const res = await req(
    c.cookie,
    "DELETE",
    R("memos", memo._id as string),
    undefined,
    memo._updated_at as string,
  );
  expect(res.status).toBe(204);
});

test("限定1 / 4: 宣言した表でも、値が立っていない行は今日どおり消せる", async () => {
  const c = customer("c1");
  // フィールドが表に在るだけでは何も起きない(限定1)。
  const order = await create(c.cookie, "orders", { item: "本" });
  expect(order[UNDELETABLE_FIELD]).not.toBe(true);
  const res = await req(
    c.cookie,
    "DELETE",
    R("orders", order._id as string),
    undefined,
    order._updated_at as string,
  );
  expect(res.status).toBe(204);
});

test("限定1: 値が false の行も今日どおり消せる(**厳密に true の行だけ**が守られる)", async () => {
  const c = customer("c1");
  const order = await create(c.cookie, "orders", { item: "本", [UNDELETABLE_FIELD]: false });
  const res = await req(
    c.cookie,
    "DELETE",
    R("orders", order._id as string),
    undefined,
    order._updated_at as string,
  );
  expect(res.status).toBe(204);
});

// --- 本体: 値が立っている行は消せない -------------------------------------------------

test("B-G8 の本体: 値が立っている行は、持ち主(customer)が DELETE できない", async () => {
  const c = customer("c1");
  const order = await create(c.cookie, "orders", { item: "本", [UNDELETABLE_FIELD]: true });
  const res = await req(
    c.cookie,
    "DELETE",
    R("orders", order._id as string),
    undefined,
    order._updated_at as string,
  );
  expect(res.status).toBe(409);
  const body = (await res.json()) as { errors: { message: string }[] };
  expect(String(body.errors[0]?.message)).toContain("削除");
  // **行は残っている**(`D-V4-2`: 行は残り、運営が状態を動かす)。
  expect((await req(c.cookie, "GET", R("orders", order._id as string))).status).toBe(200);
});

test("B-G8 の本体: 運営(owner)でも DELETE できない —— **actor ではなく行の状態**で決まる", async () => {
  // **`st_owner` を持たない運営テーブルで見る。** 個人所有テーブル(`orders`)で owner が
  // 叩くと、行の状態に届く前に既存の個人スコープ判定が 404 を返す(下の検査で固定する)——
  // **`st_admin_readable` が開くのは読取2経路だけで、`DELETE` には1ミリも効かない**
  // (`ADR-0061` 限定1)。したがって「行の状態が actor によらず止める」は、owner が本来
  // 消せる表でしか観測できない。
  // **【`V8-M20` / 台帳 `J-G30` / `ADR-0301` / ユーザ決定 `D-V8-35`】`st_admin_readable` は
  // 廃止され、代わりに面の規則(役割 × 対象(表)× 読取)が立った。** **上の段落は当時の
  // 説明として残す** —— **面の規則で読取を開いても越えるのは読取だけで、`DELETE` には
  // 1ミリも効かない**(`D-V8-35` の逐語)。**この検査の前提は今日も同じであり、本ファイルは
  // 期待値を1つも書き換えていない。**
  const o = owner("admin");
  const row = await create(o.cookie, "announcements", {
    body: "消せない掲示",
    [UNDELETABLE_FIELD]: true,
  });
  const res = await req(
    o.cookie,
    "DELETE",
    R("announcements", row._id as string),
    undefined,
    row._updated_at as string,
  );
  expect(res.status).toBe(409);
  // 宣言つきでも値が立っていなければ owner は今日どおり消せる(限定4)。
  const plain = await create(o.cookie, "announcements", { body: "普通の掲示" });
  const ok = await req(
    o.cookie,
    "DELETE",
    R("announcements", plain._id as string),
    undefined,
    plain._updated_at as string,
  );
  expect(ok.status).toBe(204);
});

test("限定10: 個人所有テーブルでは、owner の DELETE は今日どおり 404 のまま(判定の順序を変えない)", async () => {
  // **これは `B-G8` が変えていないことの提示である。** 購入者の注文は owner にも
  // 見えないので(`st_owner`)、削除不可の判定に届く前に 404 になる。
  // **「運営なら消せる」でも「運営だから止まる」でもなく、今日と1バイトも変わらない。**
  const c = customer("c1");
  const o = owner("admin");
  const order = await create(c.cookie, "orders", { item: "本", [UNDELETABLE_FIELD]: true });
  const res = await req(
    o.cookie,
    "DELETE",
    R("orders", order._id as string),
    undefined,
    order._updated_at as string,
  );
  expect(res.status).toBe(404);
});

// --- 限定3: 止めるのは DELETE だけ ---------------------------------------------------

test("限定3: 守られた行に対する `PATCH` は今日どおり通る(= 運営/持ち主が状態を動かせる)", async () => {
  const c = customer("c1");
  const order = await create(c.cookie, "orders", { item: "本", [UNDELETABLE_FIELD]: true });
  const version = await versionOf(c.cookie, "orders", order._id as string);
  const res = await req(
    c.cookie,
    "PATCH",
    R("orders", order._id as string),
    { item: "本(改)" },
    version,
  );
  expect(res.status).toBe(200);
});

test("限定3: 守られた表への `POST` は今日どおり通る(新しい行を作れなくならない)", async () => {
  const c = customer("c1");
  const res = await req(c.cookie, "POST", R("orders"), { item: "新規" });
  expect(res.status).toBe(201);
});

// --- 限定10: CAS と個人スコープの事前判定を1バイトも変えない --------------------------

test("限定10: 守られた行でも `If-Match` が無ければ今日どおり 400(CAS の関門が先)", async () => {
  const c = customer("c1");
  const order = await create(c.cookie, "orders", { item: "本", [UNDELETABLE_FIELD]: true });
  const res = await req(c.cookie, "DELETE", R("orders", order._id as string));
  expect(res.status).toBe(400);
});

test("限定10: 他人の守られた行は今日どおり 404(存在を伏せる個人スコープの判定が先)", async () => {
  const c1 = customer("c1");
  const c2 = customer("c2");
  const order = await create(c1.cookie, "orders", { item: "本", [UNDELETABLE_FIELD]: true });
  const res = await req(
    c2.cookie,
    "DELETE",
    R("orders", order._id as string),
    undefined,
    order._updated_at as string,
  );
  // **409 ではなく 404** —— 守られていることを他人に漏らさない。
  expect(res.status).toBe(404);
});

// --- 限定9: 購入者が他人の状態を直接動かせない ----------------------------------------

test("限定9: 他人の守られた行の値を customer は `PATCH` できない(`st_owner` の scoped 判定)", async () => {
  const c1 = customer("c1");
  const c2 = customer("c2");
  const order = await create(c1.cookie, "orders", { item: "本", [UNDELETABLE_FIELD]: true });
  const res = await req(
    c2.cookie,
    "PATCH",
    R("orders", order._id as string),
    { [UNDELETABLE_FIELD]: false },
    order._updated_at as string,
  );
  expect(res.status).toBe(404);
});

// --- 限定7: 匿名に漏らさない ----------------------------------------------------------

test("限定7: 匿名の公開読取に `st_undeletable` が1件も現れない", async () => {
  const o = owner("admin");
  await create(o.cookie, "notices", {
    title: "臨時休業",
    [PUBLIC_FIELD]: true,
    [UNDELETABLE_FIELD]: true,
  });
  const list = await req(undefined, "GET", R("notices"));
  expect(list.status).toBe(200);
  const body = (await list.json()) as { records: Record<string, unknown>[] };
  expect(body.records).toHaveLength(1);
  expect(Object.hasOwn(body.records[0] ?? {}, UNDELETABLE_FIELD)).toBe(false);
});

// --- 限定11 / 発見した穴: **塞いでいないものを、塞いだと書かない** ---------------------

test("(穴)持ち主は自分の行の `st_undeletable` を `PATCH` で下ろせる —— そのあと消せる", async () => {
  // **これは ADR-0073 限定9 が「固定する」と書いた形にならなかった実測である。**
  // 限定3 が「`PATCH` を1バイトも変えない」と定めているため、**自分の行に対する
  // 購入者の `PATCH` を止める手段が今日は1つも無い**(フィールド単位の書込制御が
  // 語彙にも実装にも無い。`ADR-0034` §92-2)。**塞いでいないので、検査で固定して残す。**
  const c = customer("c1");
  const order = await create(c.cookie, "orders", { item: "本", [UNDELETABLE_FIELD]: true });
  const id = order._id as string;

  // 1回目の削除は止まる。
  const blocked = await req(
    c.cookie,
    "DELETE",
    R("orders", id),
    undefined,
    order._updated_at as string,
  );
  expect(blocked.status).toBe(409);

  // 持ち主が自分で値を下ろせる。
  const patched = await req(
    c.cookie,
    "PATCH",
    R("orders", id),
    { [UNDELETABLE_FIELD]: false },
    await versionOf(c.cookie, "orders", id),
  );
  expect(patched.status).toBe(200);

  // そのあとは消せる。**「注文が守られるようになった」とは書けない。**
  const deleted = await req(
    c.cookie,
    "DELETE",
    R("orders", id),
    undefined,
    await versionOf(c.cookie, "orders", id),
  );
  expect(deleted.status).toBe(204);
});

test("(穴)限定11: ワークフローの履歴テーブルは本 ADR の射程外である(宣言しなければ守られない)", async () => {
  // **`docs/plan/v4/01-boundary-baseline.md:181` の「履歴も `delete_record` で消せる」を
  // 1ミリも塞いでいない**(ADR-0073 限定11)。ここでは「宣言のない表は今日どおり
  // 消せる」ことをもって、その一般形を固定する。**MCP の `delete_record` は
  // そもそも HTTP ハンドラを通らない**(限定6)ので、本検査は HTTP 経路の話である。
  const c = customer("c1");
  const memo = await create(c.cookie, "memos", { body: "履歴に見立てた行" });
  const res = await req(
    c.cookie,
    "DELETE",
    R("memos", memo._id as string),
    undefined,
    memo._updated_at as string,
  );
  expect(res.status).toBe(204);
});
