/**
 * **`V8-M18`(サーバ層)—— 権限に書いた条件を、実際に評価することの検査。**
 *
 * 台帳(`docs/adr/0007-vocabulary-governance.md` §8)の `J-G12` / `J-G13` / `J-G14` /
 * `J-G15` / `J-G16` と、メインの裁定 `R-7` / `R-17`(とくに `R-17-5` / `R-17-6` / `R-17-7`)、
 * および `docs/plan/v8/04-rbac-abac-baseline.md` §7 の `V8-M18` の完了の考え方 (i)〜(vi) が仕様である。
 *
 * ## この検査が固定すること
 *
 * 1. **「状態が進行中 かつ 担当が自分」を書くと、同じ役割の2人が同じ表の別々の行を見る**
 *    —— **実 HTTP + 本物の SQLite。** **応答ごと突き合わせる。**
 * 2. **「または」「でない」もそれぞれ別の `test()` で実 HTTP から示す。**
 * 3. **未ログインの要求で「自分」が**偽**に評価されること**(`J-G13` の限定 / 裁定 `R-17-5`)。
 *    **【禁止の履行】「未ログインでは起こらない」とは1文字も書いていない** —— **未ログインの
 *    要求は今日も実在するので、実 HTTP で当てて 0 件になることを見る。**
 * 4. **条件の評価が1箇所に集約されていること**(完了条件 (iv))—— **機械で数える。**
 * 5. **誰も通さない条件・全員を通す条件の知らせが、`dry_run_diff` と HTTP の両方に出ること**
 *    (`J-G16` / 裁定 `R-17-6`)。**拒否しない。適用は通る。知らせるだけ。**
 *
 * ## この検査が固定していないこと(誇張しない)
 *
 * - **書込(`POST` / `PATCH` / `DELETE`)の条件つき規則は、行の中身を1度も見ていない** ——
 *   **行を伴わない判定では条件つきの規則を「通しうる」として扱う。** **穴である**(§やり残し)。
 * - **面と点の合成は今日も `AND` である**(`V8-M19` が `OR` に変える)。
 *   **【`V8-M19` による更新。上の1行は `V8-M18` が書いた予告であり、1バイトも消していない】**
 *   **今日は `OR` である**(`src/server/role-grant-union.test.ts` が固定している)。
 *   **本ファイルの検査は面だけが立っている表で測っているので、`OR` にしても答えは変わらない。**
 * - **表示層に条件の評価は1バイトも無い** —— **サーバの述語をそのまま読む形を保っている。**
 */
import { afterEach, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyManifest,
  createApp,
  dryRunDiff,
  KernelMetaStore,
  type Manifest,
} from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { judgeRoleAccess } from "./owner-scope.ts";
import {
  type DefaultRoleRuleOptions,
  seedSession,
  TEST_ORIGIN,
  withDefaultRoleRules,
} from "./test-helpers.ts";

const APP_ID = "role-conditions-shop";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 「かつ」—— **状態が進行中 かつ 担当が自分**(`D-V8-17` の説明文の例そのもの)。 */
const AND_CONDITION = {
  and: [
    { field: "status", equals: "進行中" },
    { field: "assignee", equals_current_user: true },
  ],
};

/** 「または」—— **状態が公開 または 担当が自分**。 */
const OR_CONDITION = {
  or: [
    { field: "status", equals: "公開" },
    { field: "assignee", equals_current_user: true },
  ],
};

/** 「でない」—— **状態が完了 でない**。 */
const NOT_CONDITION = { not: { field: "status", equals: "完了" } };

/**
 * 3つの組み立てを、**別々の表**に書いた役割の一覧。
 *
 * - `orders` … `owner` は条件なしで全部。`editor` は**かつ**の条件つきで読取だけ。
 * - `tasks` … `owner` は条件なしで全部。`viewer` は**または**の条件つきで読取だけ。
 * - `memos` … `owner` は条件なしで全部。`editor` は**でない**の条件つきで読取だけ。
 */
const CONDITION_ROLES = [
  {
    id: "owner",
    name: "持ち主",
    rules: [
      // **【`V8-M28` / `T-G16a`】持ち主にはこの2行が必ず要る**(適用時検査 = 類型17 の拡張)。
      { target: "app", can: ["write"] },
      { target: "role", can: ["write"] },
      { target: "table", table: "orders", can: ["read", "write", "delete"] },
      { target: "table", table: "tasks", can: ["read", "write", "delete"] },
      { target: "table", table: "memos", can: ["read", "write", "delete"] },
    ],
  },
  {
    id: "editor",
    name: "編集者",
    rules: [
      { target: "table", table: "orders", can: ["read"], when: AND_CONDITION },
      { target: "table", table: "memos", can: ["read"], when: NOT_CONDITION },
    ],
  },
  {
    id: "viewer",
    name: "閲覧者",
    rules: [{ target: "table", table: "tasks", can: ["read"], when: OR_CONDITION }],
  },
];

/** 知らせ(`J-G16`)の検査で使う、**誰も通さない条件**を持つ役割の一覧。 */
const NEVER_MATCHING_ROLES = [
  {
    id: "owner",
    name: "持ち主",
    rules: [
      // **【`V8-M28` / `T-G16a`】持ち主にはこの2行が必ず要る**(適用時検査 = 類型17 の拡張)。
      { target: "app", can: ["write"] },
      { target: "role", can: ["write"] },
    ],
  },
  {
    id: "editor",
    name: "編集者",
    rules: [
      {
        target: "table",
        table: "orders",
        can: ["read"],
        when: {
          and: [
            { field: "status", equals: "進行中" },
            { field: "status", equals: "完了" },
          ],
        },
      },
    ],
  },
  { id: "viewer", name: "閲覧者" },
];

function manifest(roles: unknown[]): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "条件の店",
      tables: [
        {
          id: "orders",
          name: "注文",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "status", name: "状態", type: "text" },
            { id: "assignee", name: "担当", type: "text" },
          ],
        },
        {
          id: "tasks",
          name: "作業",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "status", name: "状態", type: "text" },
            { id: "assignee", name: "担当", type: "text" },
          ],
        },
        {
          id: "memos",
          name: "覚え書き",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "status", name: "状態", type: "text" },
          ],
        },
        {
          id: "notices",
          name: "お知らせ",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "assignee", name: "担当", type: "text" },
            { id: "st_public", name: "公開", type: "boolean" },
          ],
        },
      ],
      views: [{ id: "order-list", type: "list_view", table: "orders", columns: ["title"] }],
      roles,
    },
  } as unknown as Manifest;
}

let dataRoot: string | undefined;
let app: ReturnType<typeof createServerApp>;

/**
 * **【`V8-M26`】第3の引数ではなく、既定で「足さない」ままにしてある。**
 *
 * **本ファイルの題材は `CONDITION_ROLES` が4表すべてに条件つきの規則を手で書いており、
 * 既定3役割の規則を足す必要が無い**(足すと条件つきの規則と `OR` になって主題が消える)。
 * **足すのは (D) だけである** —— **そこだけ `defaults` を渡す。**
 */
async function boot(roles: unknown[], defaults?: DefaultRoleRuleOptions): Promise<void> {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-role-conditions-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "条件の店", { app_id: APP_ID });
  } finally {
    store.close();
  }
  const base = manifest(roles);
  const applied = applyManifest(
    dataRoot,
    APP_ID,
    defaults === undefined ? base : withDefaultRoleRules(base, defaults),
  );
  expect(applied.valid).toBe(true);
  app = createServerApp({ dataRoot });
}

afterEach(async () => {
  if (dataRoot !== undefined) {
    await rm(dataRoot, { recursive: true, force: true });
    dataRoot = undefined;
  }
});

function req(
  cookie: string | undefined,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { origin: TEST_ORIGIN };
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

function session(role: "owner" | "editor" | "viewer") {
  return seedSession(dataRoot as string, APP_ID, {
    role,
    username: `${role}-${Math.random().toString(36).slice(2, 10)}`,
  });
}

const records = (table: string) => `/api/apps/${APP_ID}/tables/${table}/records`;

async function created(cookie: string, table: string, values: unknown): Promise<string> {
  const res = await req(cookie, "POST", records(table), values);
  expect(res.status).toBe(201);
  return ((await res.json()) as { record: { _id: string } }).record._id;
}

/** 一覧の応答をそのまま返す(**件名の並びで突き合わせる**)。 */
async function listTitles(cookie: string | undefined, table: string): Promise<string[]> {
  const res = await req(cookie, "GET", records(table));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { records: { title: string }[] };
  return body.records.map((row) => row.title).sort();
}

// --- (A) 「かつ」+「自分」: 同じ役割の2人が、同じ表の別々の行を見る ----------------------

test("(A) かつ: 同じ役割の2人が、同じ表の別々の行を見る(状態が進行中 かつ 担当が自分)", async () => {
  await boot(CONDITION_ROLES);
  const owner = session("owner");
  const alice = session("editor");
  const bob = session("editor");

  // **行は `owner` が作る**(`owner` の規則には条件が無い)。
  const forAlice = await created(owner.cookie, "orders", {
    title: "アリスの進行中",
    status: "進行中",
    assignee: alice.userId,
  });
  const forBob = await created(owner.cookie, "orders", {
    title: "ボブの進行中",
    status: "進行中",
    assignee: bob.userId,
  });
  await created(owner.cookie, "orders", {
    title: "アリスの完了",
    status: "完了",
    assignee: alice.userId,
  });
  await created(owner.cookie, "orders", {
    title: "他人の進行中",
    status: "進行中",
    assignee: "someone-else",
  });

  // **`owner` は4件すべて見える**(条件が無いので今日どおり)。
  expect(await listTitles(owner.cookie, "orders")).toEqual(
    ["アリスの進行中", "ボブの進行中", "アリスの完了", "他人の進行中"].sort(),
  );

  // **同じ `editor` という役割の2人が、同じ表の別々の行を見る。**
  expect(await listTitles(alice.cookie, "orders")).toEqual(["アリスの進行中"]);
  expect(await listTitles(bob.cookie, "orders")).toEqual(["ボブの進行中"]);

  // **単件も同じ判定を通る** —— **見えない行は 404 で伏せる**(403 にしない)。
  expect((await req(alice.cookie, "GET", `${records("orders")}/${forAlice}`)).status).toBe(200);
  expect((await req(alice.cookie, "GET", `${records("orders")}/${forBob}`)).status).toBe(404);
  expect((await req(bob.cookie, "GET", `${records("orders")}/${forBob}`)).status).toBe(200);
  expect((await req(bob.cookie, "GET", `${records("orders")}/${forAlice}`)).status).toBe(404);

  // **`total` も可視集合から採る**(母集団を割らない)。
  const res = await req(alice.cookie, "GET", records("orders"));
  expect((await res.json()) as { total: number }).toMatchObject({ total: 1 });
});

// --- (B) 「または」 ----------------------------------------------------------------------

test("(B) または: 状態が公開 または 担当が自分 の行だけが見える", async () => {
  await boot(CONDITION_ROLES);
  const owner = session("owner");
  const viewer = session("viewer");

  await created(owner.cookie, "tasks", {
    title: "公開の他人",
    status: "公開",
    assignee: "someone-else",
  });
  await created(owner.cookie, "tasks", {
    title: "非公開の自分",
    status: "下書き",
    assignee: viewer.userId,
  });
  await created(owner.cookie, "tasks", {
    title: "非公開の他人",
    status: "下書き",
    assignee: "someone-else",
  });

  expect(await listTitles(viewer.cookie, "tasks")).toEqual(["公開の他人", "非公開の自分"].sort());
});

// --- (C) 「でない」 ----------------------------------------------------------------------

test("(C) でない: 状態が完了 でない 行だけが見える", async () => {
  await boot(CONDITION_ROLES);
  const owner = session("owner");
  const editor = session("editor");

  await created(owner.cookie, "memos", { title: "作業中のメモ", status: "作業中" });
  await created(owner.cookie, "memos", { title: "完了のメモ", status: "完了" });
  await created(owner.cookie, "memos", { title: "状態なしのメモ" });

  // **`status` が空の行は「完了 でない」を満たす**(等値が偽なので `not` は真)。
  expect(await listTitles(editor.cookie, "memos")).toEqual(
    ["作業中のメモ", "状態なしのメモ"].sort(),
  );
});

// --- (D) 未ログイン: 「自分」は偽に評価される(`J-G13` / 裁定 `R-17-5`)-------------------

test("(D) 未ログインの要求では「自分」が偽に評価される(実 HTTP)", async () => {
  // **まず、条件つきの規則を1本も書いていない状態を測る** —— **未ログインでも公開行は読める。**
  //
  // **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65`。台帳 `T-G26a`。旧の呼び出しを逐語で残す】**
  // **旧:**
  // ```
  // await boot([
  //   { id: "owner", name: "持ち主" },
  //   { id: "editor", name: "編集者" },
  //   { id: "viewer", name: "閲覧者" },
  //   { id: "anonymous", name: "未ログイン" },
  // ]);
  // ```
  // **既定が「閉じる」側へ倒れ、未ログインにも同じ向きが及んだ**(`T-G26a`)——
  // **規則を1本も書かない `anonymous` は、`st_public` が真の行も1件も読めなくなった。**
  // **この検査の主題は「条件つきの規則で『自分』が偽に評価されること」であって
  // 「規則0本の未ログインが読めること」ではない** —— **対照群を保つために、
  // `anonymous` に条件**なし**の読取を1本だけ手で書く。**
  // **【誇張しない】これは「未ログインの既定は変わっていない」という意味ではない** ——
  // **変わった。** **既定のままの未ログインは、今日は公開行すら読めない。**
  await boot(
    [
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
      {
        id: "anonymous",
        name: "未ログイン",
        rules: [{ target: "table", table: "notices", can: ["read"] }],
      },
      // **既定3役割には `apply-diff.ts` の自動付与と同じ規則を足す** ——
      // **足さないと `owner` が行を1件も作れず、測る題材そのものが作れない。**
    ],
    {},
  );
  const owner = session("owner");
  await created(owner.cookie, "notices", { title: "公開のお知らせ", st_public: true });
  await created(owner.cookie, "notices", {
    title: "担当つきの公開",
    st_public: true,
    assignee: owner.userId,
  });
  expect(await listTitles(undefined, "notices")).toEqual(
    ["公開のお知らせ", "担当つきの公開"].sort(),
  );

  // **「担当が自分」の条件を `anonymous` に書く** —— **HTTP の差分の口から書く。**
  const applied = await req(owner.cookie, "POST", `/api/apps/${APP_ID}/diffs`, {
    diff_id: "d-anon-condition",
    intent: "未ログインに条件つきの規則を書く",
    operations: [
      {
        op: "set_roles",
        roles: [
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
          {
            id: "anonymous",
            name: "未ログイン",
            rules: [
              {
                target: "table",
                table: "notices",
                can: ["read"],
                when: { field: "assignee", equals_current_user: true },
              },
            ],
          },
        ],
      },
    ],
  });
  expect(applied.status).toBe(201);

  // **未ログインの要求は今日も実在する** —— **通って 200 が返り、行が0件になる。**
  // **「自分」が偽に評価された結果であり、401 でも 403 でもない。**
  const res = await req(undefined, "GET", records("notices"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ records: [], total: 0 });

  // **判定そのものも偽である**(行の `assignee` に何が入っていても通らない)。
  const m = manifest([
    {
      id: "anonymous",
      name: "未ログイン",
      rules: [
        {
          target: "table",
          table: "notices",
          can: ["read"],
          when: { field: "assignee", equals_current_user: true },
        },
      ],
    },
  ]);
  const decision = judgeRoleAccess({
    manifest: m,
    roles: null,
    target: { target: "table", table: "notices" },
    verb: "read",
    row: { assignee: null },
    subject: null,
  });
  expect(decision.governed).toBe(true);
  expect(decision.allowed).toBe(false);
  expect(decision.blockedBy).toBe("role");
});

// --- (D-2) 葉の3種目「その項目が空」(`V8-M26` / ユーザ決定 `D-V8-70`)-------------------
//
// **測るのは3つである**:
//  1. **空の行に当たり、値のある行に当たらない**(実 HTTP + 本物の SQLite)。
//  2. **「空」は `NULL` と 長さ0の文字列 の**両方**である**(2026-08-11 の実測に基づく)。
//  3. **未ログインでの答え** —— **`equals_current_user` と違い、この葉は**真**になりうる。**
//     **【禁止の履行】「未ログインでは起こらない」とは1文字も書かない。**

test("(D-2) その項目が空: 空の行だけが見え、値のある行は見えない(実 HTTP)", async () => {
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
    {
      id: "editor",
      name: "編集者",
      rules: [
        {
          target: "table",
          table: "orders",
          can: ["read"],
          when: { field: "assignee", is_empty: true },
        },
      ],
    },
    { id: "viewer", name: "閲覧者" },
  ]);
  const owner = session("owner");
  const editor = session("editor");

  await created(owner.cookie, "orders", { title: "担当なし(キーを送らない)", status: "進行中" });
  await created(owner.cookie, "orders", { title: "担当が空文字", status: "進行中", assignee: "" });
  await created(owner.cookie, "orders", {
    title: "担当あり",
    status: "進行中",
    assignee: owner.userId,
  });

  // **空の2件だけが見える。** **値のある1件は見えない。**
  expect(await listTitles(editor.cookie, "orders")).toEqual(
    ["担当なし(キーを送らない)", "担当が空文字"].sort(),
  );
});

test("(D-2b) 未ログインでも「その項目が空」は真になりうる(「自分」とは向きが違う)", async () => {
  // **対照群**: **`anonymous` に条件つきの読取を1本だけ書く**((D) と同じ作法)。
  await boot([
    {
      id: "owner",
      name: "持ち主",
      rules: [
        // **【`V8-M28` / `T-G16a`】持ち主にはこの2行が必ず要る**(適用時検査 = 類型17 の拡張)。
        { target: "app", can: ["write"] },
        { target: "role", can: ["write"] },
        { target: "table", table: "notices", can: ["read", "write", "delete"] },
      ],
    },
    { id: "editor", name: "編集者" },
    { id: "viewer", name: "閲覧者" },
    {
      id: "anonymous",
      name: "未ログイン",
      rules: [
        {
          target: "table",
          table: "notices",
          can: ["read"],
          when: { field: "assignee", is_empty: true },
        },
      ],
    },
  ]);
  const owner = session("owner");
  await created(owner.cookie, "notices", { title: "担当なしの公開", st_public: true });
  await created(owner.cookie, "notices", {
    title: "担当ありの公開",
    st_public: true,
    assignee: owner.userId,
  });

  // **未ログインの要求は今日も実在する** —— **200 が返り、空の行だけが出る。**
  // **`equals_current_user` は未ログインで必ず偽だが、この葉は真になりうる。**
  expect(await listTitles(undefined, "notices")).toEqual(["担当なしの公開"]);

  // **判定そのものも真である**(主体が `null` でも通る)。
  const anonManifest = manifest([
    {
      id: "anonymous",
      name: "未ログイン",
      rules: [
        {
          target: "table",
          table: "notices",
          can: ["read"],
          when: { field: "assignee", is_empty: true },
        },
      ],
    },
  ]);
  const base = {
    manifest: anonManifest,
    roles: null,
    target: { target: "table", table: "notices" } as const,
    verb: "read" as const,
    subject: null,
  };
  // **`null` / キーが無い / 長さ0の文字列 の3つが空である。**
  for (const row of [{ assignee: null }, {}, { assignee: "" }]) {
    const decision = judgeRoleAccess({ ...base, row });
    expect(`${JSON.stringify(row)}:${String(decision.allowed)}`).toBe(
      `${JSON.stringify(row)}:true`,
    );
  }
  // **`0` と `false` は空ではない**(値が入っている)。
  for (const row of [{ assignee: 0 }, { assignee: false }, { assignee: "someone" }]) {
    const decision = judgeRoleAccess({ ...base, row });
    expect(`${JSON.stringify(row)}:${String(decision.allowed)}`).toBe(
      `${JSON.stringify(row)}:false`,
    );
    expect(decision.blockedBy).toBe("role");
  }
});

// --- (E) 条件の評価が1箇所に集約されていること(完了条件 (iv))—— 機械で数える -----------

/** `src/server/` と `web/src/` の**製品コード**(`.test.ts` / `.test.tsx` を除く)を集める。 */
function productSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      productSources(full, out);
      continue;
    }
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry) || /\.e2e\.ts$/.test(entry)) {
      continue;
    }
    out.push(full);
  }
  return out;
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/**
 * **注釈の行を落として、実際に走るコードの行だけを残す。**
 *
 * **この作業は doc コメントに `rule.when` の綴りを何度も書いているので、綴りをそのまま
 * 数えると注釈まで数えてしまう** —— **数えたいのは「実際に条件を読むコード」である。**
 */
function codeOnly(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      return !(trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*"));
    })
    .join("\n");
}

test("(E) 条件の評価は1箇所に集約されている(製品コードを機械で数える)", () => {
  const serverSources = productSources(join(REPO_ROOT, "src", "server"));
  const webSources = productSources(join(REPO_ROOT, "web", "src"));

  // **(1) 評価の入口(`evaluateRoleCondition`)は、製品コード全体で2回しか現れない** ——
  // **宣言1回 + 呼び出し1回。** **どちらも `owner-scope.ts` の中である。**
  let entryTotal = 0;
  for (const file of [...serverSources, ...webSources]) {
    const count = occurrences(codeOnly(readFileSync(file, "utf8")), "evaluateRoleCondition(");
    entryTotal += count;
    if (count > 0) {
      expect(file.endsWith(join("src", "server", "owner-scope.ts"))).toBe(true);
    }
  }
  expect(entryTotal).toBe(2);

  // **(2) 規則から条件(`when`)を取り出すコードも1箇所だけである** ——
  // **`rule.when` の綴りが製品コードに1回しか現れない。**
  let whenTotal = 0;
  for (const file of [...serverSources, ...webSources]) {
    whenTotal += occurrences(codeOnly(readFileSync(file, "utf8")), "rule.when");
  }
  expect(whenTotal).toBe(1);

  // **(3) 表示層(`web/src/`)には条件の評価が1バイトも無い** ——
  // **サーバの述語をそのまま読む形を保っている**(再実装しない)。
  for (const file of webSources) {
    const text = codeOnly(readFileSync(file, "utf8"));
    expect(occurrences(text, "equals_current_user")).toBe(0);
    expect(occurrences(text, "evaluateRoleCondition")).toBe(0);
  }
});

// --- (F) 知らせ(`J-G16`)が `dry_run_diff` と HTTP の両方に出ること -----------------------

const NEVER_MATCHING_DIFF = {
  diff_id: "d-never-matches",
  intent: "誰も通さない条件を書く",
  operations: [{ op: "set_roles", roles: NEVER_MATCHING_ROLES }],
};

test("(F) 誰も通さない条件の知らせが dry_run_diff と HTTP の両方に出る(拒否はしない)", async () => {
  await boot([
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
  ]);
  const owner = session("owner");

  // **(1) `dry_run_diff`** —— **本体を1バイトも変えないまま、知らせだけが返る。**
  const dry = dryRunDiff(dataRoot as string, APP_ID, NEVER_MATCHING_DIFF);
  expect(dry.valid).toBe(true);
  const dryNotices = dry.valid ? dry.report.role_condition_notices : [];
  expect(dryNotices.length).toBeGreaterThan(0);
  expect(dryNotices[0]?.kind).toBe("never_matches");
  expect(dryNotices[0]?.role).toBe("editor");

  // **(2) HTTP(`POST /diffs`)** —— **201 で適用は通る。拒否しない。知らせるだけ。**
  const res = await req(owner.cookie, "POST", `/api/apps/${APP_ID}/diffs`, NEVER_MATCHING_DIFF);
  expect(res.status).toBe(201);
  // **知らせは `change` の内側に在る** —— **`ADR-0003` §3 の「単一キー `change` に包む」を
  // 破らないためであり、`src/server/change-api.test.ts` の `Object.keys(body)` の固定を
  // 1ミリも緩めていない。**
  const body = (await res.json()) as {
    change: { role_condition_notices: { kind: string; role: string; message: string }[] };
  };
  expect(Object.keys(body)).toEqual(["change"]);
  const httpNotices = body.change.role_condition_notices;
  expect(httpNotices.length).toBe(dryNotices.length);
  expect(httpNotices[0]?.kind).toBe("never_matches");
  expect(httpNotices[0]?.role).toBe("editor");
  expect(typeof httpNotices[0]?.message).toBe("string");

  // **矛盾が無ければ空配列が返る** —— **欄そのものは常に在る**(「黙って何もしない」を作らない)。
  const clean = await req(owner.cookie, "POST", `/api/apps/${APP_ID}/diffs`, {
    diff_id: "d-clean",
    intent: "矛盾のない条件に書き直す",
    operations: [{ op: "set_roles", roles: CONDITION_ROLES }],
  });
  expect(clean.status).toBe(201);
  expect(
    ((await clean.json()) as { change: { role_condition_notices: unknown[] } }).change
      .role_condition_notices,
  ).toEqual([]);
});

// --- (G) 行を伴わない判定は条件を確定できない(**穴を隠さない**)---------------------------

test("(G) 行を伴わない判定では条件つきの規則は「通しうる」として扱う(穴を隠さない)", () => {
  const m = manifest(CONDITION_ROLES);
  const target = { target: "table", table: "orders" } as const;

  // **行を渡さないと確定しない** —— **`conditional` が真になり、`allowed` は真である。**
  const withoutRow = judgeRoleAccess({ manifest: m, roles: ["editor"], target, verb: "read" });
  expect(withoutRow.governed).toBe(true);
  expect(withoutRow.conditional).toBe(true);
  expect(withoutRow.allowed).toBe(true);

  // **行を渡すと確定する。**
  const matched = judgeRoleAccess({
    manifest: m,
    roles: ["editor"],
    target,
    verb: "read",
    row: { status: "進行中", assignee: "u-1" },
    subject: "u-1",
  });
  expect(matched.allowed).toBe(true);
  const unmatched = judgeRoleAccess({
    manifest: m,
    roles: ["editor"],
    target,
    verb: "read",
    row: { status: "進行中", assignee: "u-2" },
    subject: "u-1",
  });
  expect(unmatched.allowed).toBe(false);
  expect(unmatched.blockedBy).toBe("role");
});
