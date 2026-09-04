/**
 * **`V8-M20-T06` —— `st_owner`(個人スコープ)の**読取**の重ね順を変えたことの検査。**
 *
 * 台帳(`docs/adr/0007-vocabulary-governance.md` §8)の **`J-G30`(判定 = 廃止)**、
 * 手続きの `ADR-0301`(語彙を廃止する判定値と `Δ11`)、
 * および **ユーザ決定 `D-V8-35`(2026-08-10)** が仕様である。
 *
 * ## なぜこれが要るのか(**撤去の前に測って、代わりが立たないことが分かった**)
 *
 * **`V8-M20-T01` は「`st_admin_readable` が今日していること(運営に他人の行を見せる)を、
 * 役割 × 表 × 読取 で書けるか」を実 HTTP で測り、**書けない**という結果を得た。**
 * **役割 `owner` に `{ target: "table", table: "orders", can: ["read","write","delete"] }` を
 * 書いても、他人の `st_owner` 行は一覧0件・単件404 であり、規則を1本も書かない対照群と
 * 応答が1バイトも変わらなかった。** **`st_owner` が `AND` で先に効いていたためである。**
 *
 * **その実測を受けてユーザが `D-V8-35` を決め、メインが重ね順を裁定した。**
 *
 * ## `D-V8-35` の説明文の逐語(**代償を隠さないために全文を写す**)
 *
 * > 予定どおり古い宣言を廃止し、代わりに「この役割はこの表を読める」と書いたら、その役割の人には
 * > 全員分の行が見えるようにします。運営者は今までどおりデータを横断して見られます。**ただし
 * > 代償があります —— 「この表を読める」と書いた役割は誰であっても全員分が見えるので、書き方を
 * > 間違えると、本来自分の分だけ見えるはずだった人に全員分が見えます。今日はその危険が
 * > 「運営者だけ」に閉じていました。**
 *
 * ## 合成式の今日の正(メインの裁定)
 *
 * - **読取**: `許可 = (面 OR 点) AND ( st_owner を満たす OR 面が読取を許している ) AND その他の残す層`
 * - **書込・削除**: 今日どおり(`st_owner` は `AND`)
 *
 * ## **`D-V8-32` との関係(誇張しない)**
 *
 * **`D-V8-32`(「誰が」ではない約束4本は今日どおり残して併存させる)は今日も生きている** ——
 * **`st_owner` / `st_public` / `st_undeletable` / `st_no_direct_create` はフィールドも実装も
 * 1バイトも消えていない。** **しかし `st_owner` の**重ね順**は読取についてだけ変わった。**
 * **【禁止の履行】「4本は1ミリも変わっていない」とは書かない。**
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN } from "./test-helpers.ts";

const APP_ID = "role-read-crosses";

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;

/** 既定の役割定義3本(`create-app.ts` が入れる3本と同じ `id`)。**この3本は消せない。** */
const DEFAULTS = [
  {
    id: "owner",
    name: "持ち主",
    rules: [
      // **【`V8-M28` / `T-G16a`】持ち主にはこの2行が必ず要る**(適用時検査 = 類型17 の拡張)。
      { target: "app", can: ["write"] },
      { target: "role", can: ["write"] },
    ],
  },
  { id: "editor", name: "編集者" },
  { id: "viewer", name: "閲覧者" },
];

function manifest(roles: unknown[]): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "個人スコープの店",
      tables: [
        {
          id: "orders",
          name: "注文",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            // **`st_owner`(個人スコープ)。`D-V8-32` により今日も残る。**
            { id: "st_owner", name: "持ち主", type: "text" },
          ],
        },
      ],
      views: [],
      roles,
    },
  } as unknown as Manifest;
}

async function boot(roles: unknown[]): Promise<void> {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-role-read-cross-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "個人スコープの店", { app_id: APP_ID });
  } finally {
    store.close();
  }
  const applied = applyManifest(dataRoot, APP_ID, manifest(roles));
  expect(applied.valid).toBe(true);
  app = createServerApp({ dataRoot });
}

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

function req(
  cookie: string | undefined,
  method: string,
  path: string,
  body?: unknown,
  extra?: Record<string, string>,
): Promise<Response> {
  const headers: Record<string, string> = { origin: TEST_ORIGIN, ...(extra ?? {}) };
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return Promise.resolve(app.request(new Request(`http://localhost${path}`, init)));
}

const ORDERS = `/api/apps/${APP_ID}/tables/orders/records`;

async function created(cookie: string, title: string): Promise<string> {
  const res = await req(cookie, "POST", ORDERS, { title });
  expect(res.status).toBe(201);
  return ((await res.json()) as { record: { _id: string } }).record._id;
}

async function listTitles(cookie: string): Promise<string[]> {
  const res = await req(cookie, "GET", ORDERS);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { records: { title: string }[] };
  return body.records.map((row) => row.title).sort();
}

/** 表に読取(と書込・削除)を書いた役割の一覧。**`owner` にだけ書く。** */
const OWNER_READS_ALL = [
  {
    id: "owner",
    name: "持ち主",
    // **書込・削除も書いてある** —— **対象を名指しした時点で全動詞が allow-list になるため、
    // 書かないと `owner` が自分で作った行すら直せなくなる**(面の既定。裁定 `R-4`)。
    rules: [
      // **【`V8-M28` / `T-G16a`】持ち主にはこの2行が必ず要る**(適用時検査 = 類型17 の拡張)。
      { target: "app", can: ["write"] },
      { target: "role", can: ["write"] },
      { target: "table", table: "orders", can: ["read", "write", "delete"] },
    ],
  },
  {
    id: "editor",
    name: "編集者",
    rules: [{ target: "table", table: "orders", can: ["read", "write"] }],
  },
  { id: "viewer", name: "閲覧者" },
];

// --- (A) 撤去の前に書けなかったものが、今日は書ける ------------------------------------

test("(A) 表に読取を書いた役割は、他人の `st_owner` 行を一覧でも単件でも読める", async () => {
  await boot(OWNER_READS_ALL);
  const owner = seedSession(dataRoot, APP_ID, { role: "owner", username: "A-owner" });
  const buyer = seedSession(dataRoot, APP_ID, { role: "editor", username: "A-buyer" });

  const id = await created(buyer.cookie, "買い手の注文");

  // **`V8-M20-T01` ではここが `[]` と 404 だった。** **同じ宣言・同じ要求で、今日は通る。**
  expect(await listTitles(owner.cookie)).toEqual(["買い手の注文"]);
  const one = await req(owner.cookie, "GET", `${ORDERS}/${id}`);
  expect(one.status).toBe(200);

  // **持ち主の側は今日どおり自分の行を読める**(越えたことで誰かが読めなくなってはいない)。
  expect(await listTitles(buyer.cookie)).toEqual(["買い手の注文"]);
});

// --- (B) 越えるのは読取だけである ------------------------------------------------------

test("(B) 越えるのは読取だけ —— 他人の行への更新・削除は今日どおり止まる", async () => {
  await boot(OWNER_READS_ALL);
  const owner = seedSession(dataRoot, APP_ID, { role: "owner", username: "B-owner" });
  const buyer = seedSession(dataRoot, APP_ID, { role: "editor", username: "B-buyer" });

  const id = await created(buyer.cookie, "買い手の注文");
  const one = await req(owner.cookie, "GET", `${ORDERS}/${id}`);
  expect(one.status).toBe(200);
  const version = one.headers.get("etag") ?? "";
  expect(version).not.toBe("");

  // **読めた行を、そのまま直せはしない。** **`st_owner` は書込・削除では今日どおり `AND` である。**
  // **版(`If-Match`)を正しく渡しても止まる** —— **止めているのは CAS ではなく個人スコープである。**
  const patched = await req(
    owner.cookie,
    "PATCH",
    `${ORDERS}/${id}`,
    { title: "運営が直す" },
    {
      "if-match": version,
    },
  );
  expect(patched.status).toBe(404);

  const deleted = await req(owner.cookie, "DELETE", `${ORDERS}/${id}`, undefined, {
    "if-match": version,
  });
  expect(deleted.status).toBe(404);

  // **行は1バイトも変わっていない。**
  const after = await req(buyer.cookie, "GET", `${ORDERS}/${id}`);
  expect(after.status).toBe(200);
  expect(((await after.json()) as { record: { title: string } }).record.title).toBe("買い手の注文");
});

// --- (C) 規則を書いていない表では今日どおり --------------------------------------------

test("(C) 面の規則を1本も書いていない表では、`st_owner` は今日どおり効く", async () => {
  await boot(DEFAULTS);
  const owner = seedSession(dataRoot, APP_ID, { role: "owner", username: "C-owner" });
  const buyer = seedSession(dataRoot, APP_ID, { role: "editor", username: "C-buyer" });

  // **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-58` / `D-V8-65`。旧の3行を逐語で残す】**
  //
  // **旧: `const id = await created(buyer.cookie, "買い手の注文");`**
  // **旧: `expect(await listTitles(owner.cookie)).toEqual([]);`**
  // **旧: `expect((await req(owner.cookie, "GET", `${ORDERS}/${id}`)).status).toBe(404);`**
  //
  // **既定が「閉じる」側へ倒れたので、この題材の前提そのものが無くなった** ——
  // **「面の規則を1本も書いていない表」は今日、誰にも開かない。**
  // **買い手は行を1件も作れないので、`st_owner` が読取を絞っているかを、この形では
  // もう測れない。** **一覧が空になること自体は着手前と同じだが、空にしている層が
  // 個人スコープから面へ移った。**
  expect((await req(buyer.cookie, "POST", ORDERS, { title: "買い手の注文" })).status).toBe(403);
  expect((await req(owner.cookie, "POST", ORDERS, { title: "運営の注文" })).status).toBe(403);

  // **既定は「自分の行と共有行だけ」である。** **撤去は既定を1ミリも動かしていない。**
  // **【`V8-M26` による訂正。上の1行は1バイトも消していない】** **今日の既定は
  // 「面が閉じているので1行も見えない」である** —— **持ち主本人にも見えない。**
  expect(await listTitles(owner.cookie)).toEqual([]);
  expect(await listTitles(buyer.cookie)).toEqual([]);
  // **単件は今日も 404 である**(`ADR-0305` 限定11。**403 で存在を漏らさない**)——
  // **ただし行が1件も作れないので、測れるのは「在りもしない行」に対する 404 だけである。**
  expect((await req(owner.cookie, "GET", `${ORDERS}/no-such-row`)).status).toBe(404);
});

/**
 * **【`V8-M26` が消した測り方について、正直に書いておく】**
 *
 * **上の (C) は「面が読取を許していない表では `st_owner` が読取を絞る」ことを測っていた。**
 * **今日の合成式は `読取 = (面 OR 点) AND (st_owner を満たす OR 面が読取を許している)` である。**
 * **既定が閉じたことで、`access_control` を宣言していない表では次の2つしか起こらない**:
 *
 *  1. **面が読取を許している** → **第2項が真になり、`st_owner` は1行も絞らない**((A) の形)。
 *  2. **面が読取を許していない** → **第1項が偽になり、`st_owner` を満たす行も含めて0行**。
 *
 * **したがって `st_owner` の読取の絞り込みが今日も観測できるのは、
 * 「点(行ごとの付与)だけで見えている行」がある表 —— つまり `access_control` を
 * 宣言した表 —— だけである。** **これは `D-V8-32`(4本は今日も残す)と矛盾しないが、
 * 「`st_owner` の読取は今日どおり効く」とは書けない。**
 */

// --- (D) 代償 --------------------------------------------------------------------------

test("(D)【正直に書く】運営でない役割に表の読取を書くと、その人に全員分の行が見える", async () => {
  // **`D-V8-35` の説明文の逐語**:
  // > 「この表を読める」と書いた役割は誰であっても全員分が見えるので、書き方を間違えると、
  // > 本来自分の分だけ見えるはずだった人に全員分が見えます。
  // > **今日はその危険が「運営者だけ」に閉じていました。**
  //
  // **この検査は穴を塞ぐためのものではない。** **`D-V8-35` が承知で受け入れた代償が、
  // 実際に起こることを実 HTTP で固定するためのものである。**
  // **【禁止の履行】これを「安全である」と読み替えない。**
  // **撤去した `st_admin_readable` は `owner` に固定されており(`adminReadsAllRows` の
  // `declaredMatchesRoles(["owner"], role)`)、この形は起こりえなかった。**
  await boot([
    ...DEFAULTS,
    {
      id: "member",
      name: "会員",
      // **運営ではない役割**に、条件(`when`)を付けずに表の読取を書いた。
      rules: [{ target: "table", table: "orders", can: ["read", "write"] }],
    },
  ]);
  const a = seedSession(dataRoot, APP_ID, { role: "member" as never, username: "D-member-A" });
  const b = seedSession(dataRoot, APP_ID, { role: "member" as never, username: "D-member-B" });

  await created(a.cookie, "Aの注文");
  await created(b.cookie, "Bの注文");

  // **会員A に、会員B の行まで見えている。**
  expect(await listTitles(a.cookie)).toEqual(["Aの注文", "Bの注文"]);
  expect(await listTitles(b.cookie)).toEqual(["Aの注文", "Bの注文"]);
});

test("(D-2)【正直に書く】条件(when)を付ければ絞れる —— ただし付け忘れは検査されない", async () => {
  // **上の (D) の代償は、条件(`when`)で「持ち主が自分」に絞れば避けられる。**
  // **しかし「付け忘れ」を止める仕組みは今日1つも無い** —— **警告も出ない。**
  // **その事実をここで固定する**(下の `owner` 側は条件を付けていないので全員分が見える)。
  await boot([
    {
      id: "owner",
      name: "持ち主",
      rules: [
        // **【`V8-M28` / `T-G16a`】持ち主にはこの2行が必ず要る**(適用時検査 = 類型17 の拡張)。
        { target: "app", can: ["write"] },
        { target: "role", can: ["write"] },
        { target: "table", table: "orders", can: ["read", "write", "delete"] },
      ],
    },
    { id: "editor", name: "編集者" },
    { id: "viewer", name: "閲覧者" },
    {
      id: "member",
      name: "会員",
      rules: [
        {
          target: "table",
          table: "orders",
          can: ["read", "write"],
          when: { field: "st_owner", equals_current_user: true },
        },
      ],
    },
  ]);
  const a = seedSession(dataRoot, APP_ID, { role: "member" as never, username: "E-member-A" });
  const b = seedSession(dataRoot, APP_ID, { role: "member" as never, username: "E-member-B" });
  const owner = seedSession(dataRoot, APP_ID, { role: "owner", username: "E-owner" });

  await created(a.cookie, "Aの注文");
  await created(b.cookie, "Bの注文");

  // **条件つきの役割は自分の行だけ。**
  expect(await listTitles(a.cookie)).toEqual(["Aの注文"]);
  expect(await listTitles(b.cookie)).toEqual(["Bの注文"]);
  // **条件を付けていない役割は全員分。**
  expect(await listTitles(owner.cookie)).toEqual(["Aの注文", "Bの注文"]);
});
