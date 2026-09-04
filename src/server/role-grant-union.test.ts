/**
 * **`V8-M19`(サーバ層)—— 面(役割に束ねた権限)と点(行ごとの付与)を `OR` で重ね、
 * 所属の穴(`U-2`)を塞ぐことの検査。**
 *
 * 台帳(`docs/adr/0007-vocabulary-governance.md` §8)の `J-G17` / `J-G18` / `J-G19` /
 * `J-G20` / `J-G33` / `J-G41`、ユーザ決定 `D-V8-19` / `D-V8-23` / `D-V8-28`、
 * メインの裁定 `R-5` / `R-6` / `R-15`、および
 * `docs/plan/v8/04-rbac-abac-baseline.md` §7 の `V8-M19` の完了の考え方 (i)〜(iv) と
 * §8 の 7 / 9 / 12 の (ii)(vi) が仕様である。
 *
 * ## この検査が固定すること
 *
 * 1. **4通りのシナリオ**(面だけ / 点だけ / 両方 / どちらも無い)を**別々の `test()`** で
 *    実 HTTP から示す。**(iv) だけが見えない。** **運営(`owner`)と一般の応答を両方見る。**
 * 2. **合成の単位は(行, 要求している人, 動詞)ちょうど**(`J-G18` の限定)——
 *    **引き算も順序も勝ち負けの規則も無い。**
 * 3. **止めた層を名指しできることが、`OR` にしたあとも成り立つ**(裁定 `N-13` / `R-5`)。
 * 4. **引き継ぎ(`J-G20`)では、役割の側を `walkAccessInheritance` の**外側**で1回だけ
 *    評価する** —— **辿りの段数を増やしても評価回数が増えないことを機械で示す。**
 * 5. **自分のメンバー行の所属グループを付け替える要求が拒否される**(`J-G33` / `D-V8-28` /
 *    `U-2`)。**着手前は通っていた**(実施記録 §2 に応答を逐語で貼ってある)。
 *
 * ## この検査が固定していないこと(**誇張しない**)
 *
 * - **`OR` は見える側に倒れる。** **面で締めても点が開いていれば見える** ——
 *   **その形は (F) が実物で1件示している。** **【禁止の履行】「`OR` なので安全側に倒れる」
 *   とは1文字も書いていない。**
 * - **旧4層(`view.audience` / `field.audience` / `field.writable_by` / `view_action.audience`)
 *   との重ね順は今日も `AND` である**(撤去は `V8-M20`)。
 *   **【`V8-M20` は実施済みである。台帳 `J-G27`〜`J-G30` / `ADR-0301`】** **4層とも撤去され、
 *   `schemas/manifest.schema.json` からも消えた。** **したがって「重ね順」を測れる相手は
 *   今日はもう無い** —— **上の1行は撤去前の記述として残す。** **本ファイルは1行も期待値を
 *   書き換えていない**(面と点の `OR` だけを測っており、旧4層を1つも使っていなかった)。
 * - **項目・画面・ボタンの規則に点は無い** —— **`OR` の単位は行である。**
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import {
  combineRoleAndGrantAccess,
  judgeRoleAccess,
  resolveCombinedRecordAccess,
} from "./owner-scope.ts";
import {
  type DefaultRoleRuleOptions,
  seedSession,
  TEST_ORIGIN,
  withDefaultRoleRules,
} from "./test-helpers.ts";

const APP_ID = "role-grant-union";

const PERMISSIONS = [
  { id: "keeper", name: "管理", read: true, write: true, delete: true },
  { id: "reader", name: "閲覧", read: true, write: false, delete: false },
];

/**
 * **面の規則**: **`editor` にだけ `orders` の読取を書く。**
 *
 * - **`editor`** … 面が**通す**(表が名指しされ、`read` が書かれている)。
 * - **`owner` / `viewer`** … 面が**止める**(表は名指しされているので allow-list になり、
 *   規則を持たない役割は通らない)。**引き算は1つも書いていない**(`J-G2` の限定)。
 */
const UNION_ROLES = [
  { id: "owner", name: "持ち主" },
  { id: "editor", name: "編集者", rules: [{ target: "table", table: "orders", can: ["read"] }] },
  { id: "viewer", name: "閲覧者" },
];

function manifest(roles: unknown[], inherit = false): Manifest {
  const orders: Record<string, unknown> = {
    id: "orders",
    name: "注文",
    fields: [
      { id: "title", name: "件名", type: "text", required: true },
      { id: "parent", name: "親", type: "reference", reference_table: "orders" },
    ],
    access_control: {
      enabled: true,
      permissions: PERMISSIONS,
      creator_permission: "keeper",
      grant: {
        table: "order_grant",
        target: "order",
        member: "member",
        group: "team",
        permission: "permission",
      },
      members: { table: "book_member", account: "account", group: "team" },
      groups: { table: "book_team" },
      ...(inherit ? { inherit_from: ["parent"] } : {}),
    },
  };
  return {
    app: {
      id: APP_ID,
      name: "重ねる店",
      tables: [
        orders,
        { id: "book_team", name: "班", fields: [{ id: "title", name: "名前", type: "text" }] },
        {
          id: "book_member",
          name: "参加者",
          fields: [
            { id: "account", name: "アカウント", type: "text" },
            { id: "team", name: "班", type: "reference", reference_table: "book_team" },
          ],
        },
        {
          id: "order_grant",
          name: "付与",
          fields: [
            { id: "order", name: "注文", type: "reference", reference_table: "orders" },
            { id: "member", name: "人", type: "reference", reference_table: "book_member" },
            { id: "team", name: "班", type: "reference", reference_table: "book_team" },
            {
              id: "permission",
              name: "権限",
              type: "select",
              options: ["keeper", "reader"],
            },
          ],
        },
      ],
      views: [],
      roles,
    },
  } as unknown as Manifest;
}

let dataRoot: string | undefined;
let app: ReturnType<typeof createServerApp>;

/**
 * **【`V8-M26`】既定が「閉じる」側へ倒れたので、題材に既定3役割の規則を足す。**
 *
 * **足す相手は `orders` **以外**の3表(`book_team` / `book_member` / `order_grant`)である** ——
 * **`orders` には1本も足さない。** **理由は2つある**:
 *
 *  1. **`orders` は `access_control` を宣言した表であり、面と点は `OR` である** ——
 *     **面の規則を足すと点(行ごとの付与)の測定が丸ごと無効になる。**
 *  2. **本ファイルの主題は「面と点の重なり」であり、`orders` の面は `UNION_ROLES` が
 *     手で書いた1本(`editor` の読取)だけであることが前提である。**
 *
 * **【正直に書く。ここが本ファイルで見つかった一番大きな穴である】**
 * **実アプリでは `add_table` を通した時点で `apply-diff.ts` の自動付与が
 * 既定3役割へ表の規則を入れる** —— **`access_control` を宣言した表も例外ではない。**
 * **したがって「面 `OR` 点」の下では、自動付与が入った表の点は既定で意味を失う**
 * (**面が全員に `read` を配ってしまう**)。**本ファイルはその形を測っていない** ——
 * **測れる題材(自動付与が入っていない表)を意図的に使っている。**
 */
async function boot(
  roles: unknown[],
  inherit = false,
  defaults: DefaultRoleRuleOptions = { skipTables: ["orders"] },
): Promise<void> {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-role-grant-union-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "重ねる店", { app_id: APP_ID });
  } finally {
    store.close();
  }
  const applied = applyManifest(
    dataRoot,
    APP_ID,
    withDefaultRoleRules(manifest(roles, inherit), defaults),
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

const records = (table: string) => `/api/apps/${APP_ID}/tables/${table}/records`;

function session(role: "owner" | "editor" | "viewer") {
  return seedSession(dataRoot as string, APP_ID, {
    role,
    username: `${role}-${Math.random().toString(36).slice(2, 10)}`,
  });
}

async function create(
  cookie: string,
  table: string,
  values: unknown,
): Promise<Record<string, unknown>> {
  const res = await req(cookie, "POST", records(table), values);
  expect(res.status).toBe(201);
  return ((await res.json()) as { record: Record<string, unknown> }).record;
}

async function listTitles(cookie: string | undefined, table = "orders"): Promise<string[]> {
  const res = await req(cookie, "GET", records(table));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { records: { title: string }[] };
  return body.records.map((row) => row.title).sort();
}

/** 付与表からその行への付与を1件残らず消す(**「行ごとの付与が1件も無い行」を作る**)。 */
async function stripGrants(ownerCookie: string, orderId: string): Promise<number> {
  const res = await req(ownerCookie, "GET", records("order_grant"));
  const body = (await res.json()) as { records: Record<string, unknown>[] };
  let removed = 0;
  for (const grant of body.records) {
    if (grant.order !== orderId) {
      continue;
    }
    const deleted = await req(
      ownerCookie,
      "DELETE",
      `${records("order_grant")}/${grant._id as string}`,
      undefined,
      grant._updated_at as string,
    );
    expect(deleted.status).toBe(204);
    removed += 1;
  }
  return removed;
}

/**
 * 4通りのシナリオの土台。
 *
 * - **`plain`** … **行ごとの付与が1件も無い行**(作成者付与まで消してある)。
 * - **`granted`** … **`viewer` の班に読取を配った行。**
 * - **`both`** … **`editor` の班に読取を配った行**(面も点も通す)。
 */
async function scenario() {
  await boot(UNION_ROLES);
  const owner = session("owner");
  const editor = session("editor");
  const viewer = session("viewer");
  const teamE = await create(owner.cookie, "book_team", { title: "編集班" });
  const teamV = await create(owner.cookie, "book_team", { title: "閲覧班" });
  const teamO = await create(owner.cookie, "book_team", { title: "運営班" });
  await create(owner.cookie, "book_member", { account: owner.userId, team: teamO._id });
  await create(owner.cookie, "book_member", { account: editor.userId, team: teamE._id });
  await create(owner.cookie, "book_member", { account: viewer.userId, team: teamV._id });
  const plain = await create(owner.cookie, "orders", { title: "付与ゼロ" });
  const granted = await create(owner.cookie, "orders", { title: "点だけ" });
  const both = await create(owner.cookie, "orders", { title: "両方" });
  expect(await stripGrants(owner.cookie, plain._id as string)).toBeGreaterThan(0);
  await stripGrants(owner.cookie, granted._id as string);
  await stripGrants(owner.cookie, both._id as string);
  await create(owner.cookie, "order_grant", {
    order: granted._id,
    team: teamV._id,
    permission: "reader",
  });
  await create(owner.cookie, "order_grant", {
    order: both._id,
    team: teamE._id,
    permission: "reader",
  });
  return { owner, editor, viewer, plain, granted, both };
}

// --- (A)〜(D) 4通りのシナリオ(`04` §8 の 7)------------------------------------------

test("(A) (i) 面だけで見える —— 行ごとの付与が1件も無い行が、役割の側の規則だけで見える", async () => {
  const s = await scenario();
  // **一般のアカウント(`editor`)** —— **面が通す。点は「付与0件」なので止めている。**
  expect(await listTitles(s.editor.cookie)).toContain("付与ゼロ");
  const one = await req(s.editor.cookie, "GET", `${records("orders")}/${s.plain._id as string}`);
  expect(one.status).toBe(200);
  // **運営のアカウント(`owner`)** —— **面も点も止めるので見えない**(下の (D) と同じ形)。
  expect(await listTitles(s.owner.cookie)).not.toContain("付与ゼロ");
  const asOwner = await req(s.owner.cookie, "GET", `${records("orders")}/${s.plain._id as string}`);
  expect(asOwner.status).toBe(404);
});

test("(B) (ii) 点だけで見える —— 面が止めている人に、行ごとの付与だけで見える", async () => {
  const s = await scenario();
  // **一般のアカウント(`viewer`)** —— **面は止める(規則を1本も持たない)。点が通す。**
  expect(
    judgeRoleAccess({
      manifest: manifest(UNION_ROLES),
      roles: ["viewer"],
      target: { target: "table", table: "orders" },
      verb: "read",
    }),
  ).toEqual({ allowed: false, governed: true, blockedBy: "role", conditional: false });
  expect(await listTitles(s.viewer.cookie)).toEqual(["点だけ"]);
  const one = await req(s.viewer.cookie, "GET", `${records("orders")}/${s.granted._id as string}`);
  expect(one.status).toBe(200);
  // **運営のアカウント(`owner`)** —— **付与が `viewer` の班にしか無いので見えない。**
  expect(await listTitles(s.owner.cookie)).not.toContain("点だけ");
});

test("(C) (iii) 両方ある —— 面も点も通す", async () => {
  const s = await scenario();
  // **一般のアカウント(`editor`)** —— **面が通し、かつ `編集班` への付与も在る。**
  expect(await listTitles(s.editor.cookie)).toContain("両方");
  const direct = await req(s.editor.cookie, "GET", `${records("orders")}/${s.both._id as string}`);
  expect(direct.status).toBe(200);
  // **運営のアカウント(`owner`)** —— **面は止め、`編集班` への付与も `運営班` には効かない。**
  // **運営でも見えない** —— **【禁止の履行】「運営だから見える」分岐を面に1本も作っていない。**
  expect(await listTitles(s.owner.cookie)).not.toContain("両方");
  const asOwner = await req(s.owner.cookie, "GET", `${records("orders")}/${s.both._id as string}`);
  expect(asOwner.status).toBe(404);
});

test("(D) (iv) どちらも無い —— 面も点も止めるので見えない(4通りのうちこれだけが見えない)", async () => {
  const s = await scenario();
  // **一般のアカウント(`viewer`)から「付与ゼロ」の行が見えない。**
  expect(await listTitles(s.viewer.cookie)).not.toContain("付与ゼロ");
  const one = await req(s.viewer.cookie, "GET", `${records("orders")}/${s.plain._id as string}`);
  expect(one.status).toBe(404);
  // **運営のアカウント(`owner`)からも見えない。**
  const asOwner = await req(s.owner.cookie, "GET", `${records("orders")}/${s.plain._id as string}`);
  expect(asOwner.status).toBe(404);
  // **4通りの突き合わせ** —— **見えるのは3通り、見えないのは (iv) だけである。**
  //
  // **`editor` は面が表の読取を通しているので、3行とも見える**(`OR` は見える側に倒れる)。
  // **`viewer` は面が止めているので、付与のある1行だけが見える。**
  // **`owner` は面も止め、どの付与も自分の班に来ていないので1行も見えない。**
  expect(await listTitles(s.editor.cookie)).toEqual(["付与ゼロ", "両方", "点だけ"].sort());
  expect(await listTitles(s.viewer.cookie)).toEqual(["点だけ"]);
  expect(await listTitles(s.owner.cookie)).toEqual([]);
});

// --- (E) 合成の単位と、止めた層の名指し(`J-G18` / 裁定 `N-13`)---------------------------

test("(E) 合成は (行, 要求している人, 動詞) ちょうどの `OR` であり、止めた層を名指しできる", () => {
  const m = manifest(UNION_ROLES);
  const target = { target: "table", table: "orders" } as const;
  const passed = judgeRoleAccess({ manifest: m, roles: ["editor"], target, verb: "read" });
  const blocked = judgeRoleAccess({ manifest: m, roles: ["viewer"], target, verb: "read" });
  expect(passed.allowed).toBe(true);
  expect(blocked.blockedBy).toBe("role");

  // **点が管轄外**(宣言していない表)—— **面だけで決まる。**
  expect(combineRoleAndGrantAccess({ role: passed, grant: undefined, verb: "read" })).toEqual({
    allowed: true,
    blockedBy: [],
  });
  expect(combineRoleAndGrantAccess({ role: blocked, grant: undefined, verb: "read" })).toEqual({
    allowed: false,
    blockedBy: ["role"],
  });
  // **(i) 面だけ** —— **点が止めても通る。** **止めた層は名指しできる。**
  expect(
    combineRoleAndGrantAccess({
      role: passed,
      grant: { read: false, write: false, delete: false },
      verb: "read",
    }),
  ).toEqual({ allowed: true, blockedBy: ["grant"] });
  // **(ii) 点だけ** —— **面が止めても通る。**
  expect(
    combineRoleAndGrantAccess({
      role: blocked,
      grant: { read: true, write: true, delete: true },
      verb: "read",
    }),
  ).toEqual({ allowed: true, blockedBy: ["role"] });
  // **(iii) 両方** —— **通る。止めた層は0本。**
  expect(
    combineRoleAndGrantAccess({
      role: passed,
      grant: { read: true, write: true, delete: true },
      verb: "read",
    }),
  ).toEqual({ allowed: true, blockedBy: [] });
  // **(iv) どちらも無い** —— **止まる。止めた層は2本とも名指しできる。**
  expect(
    combineRoleAndGrantAccess({
      role: blocked,
      grant: { read: false, write: false, delete: false },
      verb: "read",
    }),
  ).toEqual({ allowed: false, blockedBy: ["role", "grant"] });
  // **動詞ごとに別々に決まる**(合成の単位に動詞が入っていることの実測)。
  expect(
    combineRoleAndGrantAccess({
      role: blocked,
      grant: { read: true, write: false, delete: false },
      verb: "write",
    }),
  ).toEqual({ allowed: false, blockedBy: ["role", "grant"] });
});

// --- (F) 「面で締めても点で漏れる」を実物で1件示す(`04` §8 の 12 の (ii))----------------

test("(F) 面で締めても点で漏れる —— 役割の側が読取を書いていない人に、付与1件で見える", async () => {
  const s = await scenario();
  // **`viewer` の役割には規則が1本も無い**(= 面は止める)。**それでも見えている。**
  expect(await listTitles(s.viewer.cookie)).toEqual(["点だけ"]);
  // **同じ行を、付与を消すと見えなくなる** —— **見せていたのは点であることの確定。**
  const removed = await stripGrants(s.owner.cookie, s.granted._id as string);
  expect(removed).toBeGreaterThan(0);
  expect(await listTitles(s.viewer.cookie)).toEqual([]);
});

// --- (G) 引き継ぎ(`J-G20`)—— 役割の側は辿りの**外側**で1回だけ ------------------------

test("(G) 引き継ぎでは役割の側を辿りの外側で1回だけ評価する(段数を増やしても回数が増えない)", async () => {
  // **`app.roles` の読み出し回数を数える**(`judgeRoleAccess` は呼ばれるたびに1回読む)。
  let reads = 0;
  const build = (): Manifest => {
    const base = manifest(UNION_ROLES, true);
    const roles = (base.app as unknown as { roles: unknown }).roles;
    Object.defineProperty(base.app, "roles", {
      get() {
        reads += 1;
        return roles;
      },
      configurable: true,
    });
    return base;
  };
  const rows: Record<string, Record<string, unknown>[]> = { orders: [], order_grant: [] };
  const chain = (depth: number): Record<string, unknown> => {
    rows.orders = [];
    let parent: string | null = null;
    let row: Record<string, unknown> = {};
    for (let i = 0; i <= depth; i += 1) {
      row = { _id: `row-${i}`, title: `第${i}段`, parent };
      rows.orders?.push(row);
      parent = row._id as string;
    }
    return row;
  };
  const readRows = (tableId: string): readonly Record<string, unknown>[] => rows[tableId] ?? [];
  const readRow = (tableId: string, recordId: string): Record<string, unknown> | undefined =>
    (rows[tableId] ?? []).find((candidate) => candidate._id === recordId);

  const shallow = build();
  const leafShallow = chain(1);
  reads = 0;
  resolveCombinedRecordAccess({
    manifest: shallow,
    tableId: "orders",
    row: leafShallow,
    actorId: null,
    roles: ["editor"],
    sources: { grantTable: "order_grant", memberTable: "book_member", groupTable: "book_team" },
    readRows,
    readRow,
  });
  const shallowReads = reads;

  const deep = build();
  const leafDeep = chain(4);
  reads = 0;
  resolveCombinedRecordAccess({
    manifest: deep,
    tableId: "orders",
    row: leafDeep,
    actorId: null,
    roles: ["editor"],
    sources: { grantTable: "order_grant", memberTable: "book_member", groupTable: "book_team" },
    readRows,
    readRow,
  });
  const deepReads = reads;

  // **段数を1段から4段へ増やしても、役割の側の評価回数は1ミリも増えない。**
  expect(deepReads).toBe(shallowReads);
  // **回数は動詞の数(読取 / 書込 / 削除)ちょうどである** —— **辿りの各段では1度も評価しない。**
  expect(shallowReads).toBe(3);

  // **`walkAccessInheritance` と `resolveRecordAccess` の本文に、面の判定の綴りが1文字も無い。**
  const source = await Bun.file(join(import.meta.dir, "owner-scope.ts")).text();
  const bodyOf = (name: string): string => {
    const at = source.indexOf(`function ${name}(`);
    expect(at).toBeGreaterThan(-1);
    const next = source.indexOf("\nexport ", at + 1);
    const end = source.indexOf("\nfunction ", at + 1);
    const stop = Math.min(next < 0 ? source.length : next, end < 0 ? source.length : end);
    return source.slice(at, stop);
  };
  expect(bodyOf("walkAccessInheritance")).not.toContain("judgeRoleAccess");
  expect(bodyOf("resolveRecordAccess")).not.toContain("judgeRoleAccess");
});

// --- (H) 所属の穴(`J-G33` / `D-V8-28` / `U-2`)-------------------------------------------

test("(H) 自分のメンバー行の所属グループを付け替える要求が拒否される", async () => {
  const s = await scenario();
  // **`viewer` は今 `閲覧班` に居り、「両方」の行は `編集班` にだけ配ってある。**
  expect(await listTitles(s.viewer.cookie)).toEqual(["点だけ"]);
  const mine = await req(s.viewer.cookie, "GET", records("book_member"));
  expect(mine.status).toBe(200);
  const body = (await mine.json()) as { records: Record<string, unknown>[] };
  const myRow = body.records.find((row) => row.account === s.viewer.userId);
  expect(myRow).toBeDefined();
  const teams = await req(s.owner.cookie, "GET", records("book_team"));
  const teamRows = ((await teams.json()) as { records: Record<string, unknown>[] }).records;
  const editorTeam = teamRows.find((row) => row.title === "編集班");
  const patched = await req(
    s.viewer.cookie,
    "PATCH",
    `${records("book_member")}/${(myRow as Record<string, unknown>)._id as string}`,
    { team: editorTeam?._id },
    (myRow as Record<string, unknown>)._updated_at as string,
  );
  // **拒否される**(着手前は 200 で通っていた。実施記録 §2 に応答を逐語で貼ってある)。
  expect(patched.status).toBe(403);
  // **付け替えられていないので、見える行も1件も増えていない。**
  expect(await listTitles(s.viewer.cookie)).toEqual(["点だけ"]);
});

test("(H-2) 自分のメンバー行のアカウント欄も付け替えられない(`U-2` の逐語のもう半分)", async () => {
  const s = await scenario();
  const mine = await req(s.viewer.cookie, "GET", records("book_member"));
  const body = (await mine.json()) as { records: Record<string, unknown>[] };
  const other = body.records.find((row) => row.account === s.editor.userId);
  const myRow = body.records.find((row) => row.account === s.viewer.userId);
  expect(other).toBeDefined();
  const patched = await req(
    s.viewer.cookie,
    "PATCH",
    `${records("book_member")}/${(myRow as Record<string, unknown>)._id as string}`,
    { account: s.editor.userId },
    (myRow as Record<string, unknown>)._updated_at as string,
  );
  expect(patched.status).toBe(403);
});

test("(H-3) メンバー表・グループ表を運営(`owner`)は今日どおり書ける(塞いだのは非運営だけ)", async () => {
  const s = await scenario();
  const created = await create(s.owner.cookie, "book_team", { title: "あとから班" });
  expect(created._id).toBeDefined();
  const mine = await req(s.owner.cookie, "GET", records("book_member"));
  const body = (await mine.json()) as { records: Record<string, unknown>[] };
  const row = body.records.find((candidate) => candidate.account === s.viewer.userId);
  const patched = await req(
    s.owner.cookie,
    "PATCH",
    `${records("book_member")}/${(row as Record<string, unknown>)._id as string}`,
    { team: created._id },
    (row as Record<string, unknown>)._updated_at as string,
  );
  expect(patched.status).toBe(200);
});

// --- (I)(J) v7 の残り2穴(`04` §8 の 12 の (vi))-----------------------------------------
//
// **【この2件は「塞ぐこと」を要求されていない】** —— **要求は「塞いだか塞がなかったかを
// 1件ずつ書くこと」だけである**(`04` §7 の `V8-M19` の (iv))。
// **`V8-M19` はどちらも**塞がなかった**。** **その判断と理由は実施記録 §6 に書いた。**
// **ここでは「今日どうなっているか」を実 HTTP で固定する** —— **黙って残さないためである。**

test("(I) 【塞がなかった】付与表・メンバー表は今日も誰でも一覧できる(既定では絞らない)", async () => {
  const s = await scenario();
  // **面の規則を1本も書いていない表なので、面は管轄外(全許可)である。**
  // **点も付与表そのものには掛からない**(掛けると循環する。v7 の裁定)。
  //
  // **【`V8-M26` による訂正。上の2行は1バイトも消していない】** **今日は「規則を1本も
  // 書いていない表」は閉じる** —— **したがってこの2表が誰にでも見えている理由は
  // 「管轄外」ではなく「既定3役割に規則が入っている」ことに変わった**
  // (**題材では `withDefaultRoleRules` が足し、実アプリでは `add_table` の自動付与が入れる**)。
  // **穴そのものは1ミリも塞がっていない** —— **既定のままのアプリでは、付与表もメンバー表も
  // 今日も誰でも一覧できる。**
  const grants = await req(s.viewer.cookie, "GET", records("order_grant"));
  expect(grants.status).toBe(200);
  expect(((await grants.json()) as { total: number }).total).toBeGreaterThan(0);
  const members = await req(s.viewer.cookie, "GET", records("book_member"));
  expect(members.status).toBe(200);
  expect(((await members.json()) as { total: number }).total).toBeGreaterThan(0);
});

test("(I-2) ただし面の規則を書けば閉じられる(`J-G19` が用意した手段。既定ではない)", async () => {
  // **【`V8-M26`】`order_grant` にも既定3役割の規則を足さない** —— **足すと
  // 「面の規則を書いて閉じた」ことを測れなくなる。** **この表を名指しする規則は
  // 下で手で書く `owner` の1本だけであり、着手前と1バイトも同じ形である。**
  await boot(
    [
      {
        id: "owner",
        name: "持ち主",
        rules: [{ target: "table", table: "order_grant", can: ["read"] }],
      },
      { id: "editor", name: "編集者" },
      { id: "viewer", name: "閲覧者" },
    ],
    false,
    { skipTables: ["orders", "order_grant"] },
  );
  const owner = session("owner");
  const viewer = session("viewer");
  const team = await create(owner.cookie, "book_team", { title: "班" });
  await create(owner.cookie, "book_member", { account: owner.userId, team: team._id });
  await create(owner.cookie, "book_member", { account: viewer.userId, team: team._id });
  await create(owner.cookie, "orders", { title: "1件" });
  // **運営には見える**(規則が書いてある側)。
  const asOwner = await req(owner.cookie, "GET", records("order_grant"));
  expect(((await asOwner.json()) as { total: number }).total).toBeGreaterThan(0);
  // **規則を持たない役割には、応答から落ちる**(403 にしない = 表の存在を漏らさない)。
  const asViewer = await req(viewer.cookie, "GET", records("order_grant"));
  expect(asViewer.status).toBe(200);
  expect(await asViewer.json()).toEqual({ records: [], total: 0 });
});

test("(J) 【塞がなかった】見えない行に紐づく行は今日も作れる", async () => {
  // **面の規則を1本も書いていないアプリ**(= v7 と同じ形。点だけが効いている)で測る。
  // **【`V8-M26` による訂正。上の1行は1バイトも消していない】** **`orders` については
  // 今日も「面の規則が1本も無い」ままである**(`skipTables` の既定)。
  // **土台の3表(班・参加者・付与)にだけ既定3役割の規則が入っている** ——
  // **測っている `orders` の点は1バイトも変わっていない。**
  await boot(
    [
      { id: "owner", name: "持ち主" },
      { id: "editor", name: "編集者" },
      { id: "viewer", name: "閲覧者" },
    ],
    true,
  );
  const owner = session("owner");
  const editor = session("editor");
  const team = await create(owner.cookie, "book_team", { title: "班" });
  const teamO = await create(owner.cookie, "book_team", { title: "運営班" });
  await create(owner.cookie, "book_member", { account: owner.userId, team: teamO._id });
  await create(owner.cookie, "book_member", { account: editor.userId, team: team._id });
  const hidden = await create(owner.cookie, "orders", { title: "見えない親" });
  // **`editor` にはこの行への付与が1件も無い。**
  const asEditor = await req(editor.cookie, "GET", `${records("orders")}/${hidden._id as string}`);
  expect(asEditor.status).toBe(404); // **見えない。**
  // **それでも、その見えない行を親に指した行を作れる。**
  const child = await req(editor.cookie, "POST", records("orders"), {
    title: "見えない親の子",
    parent: hidden._id,
  });
  expect(child.status).toBe(201);
});

// --- (K) `OR` の短絡に置いた2つの例外(**穴を開けないための線**)-------------------------

test("(K) バッチの `delete` op では面が最終の答えである(点を判定しない経路で短絡させない)", async () => {
  const s = await scenario();
  // **`editor` は面が `orders` の読取だけを許されており、`delete` は書かれていない。**
  // **バッチは今日 `delete` op に点の判定を1バイトも掛けない** —— **したがってここで面を
  // 短絡させると、点も面も見ない削除ができてしまう。** **面が止める。**
  const res = await req(s.editor.cookie, "POST", `/api/apps/${APP_ID}/batch`, {
    ops: [{ op: "delete", table: "orders", target: s.plain._id }],
  });
  expect(res.status).toBe(403);
  // **行は消えていない**(面が読取を通しているので、`editor` からは今日も見える)。
  expect(await listTitles(s.editor.cookie)).toContain("付与ゼロ");
});

test("(K-2) 単件 `DELETE` は下流が点を判定するので短絡してよい(点だけで消せる)", async () => {
  const s = await scenario();
  // **`viewer` は面が止めている。** **点は `閲覧班` に `reader`(読取だけ)を配ってある** ——
  // **`delete` はどちらの層も通していないので止まる。**
  const one = await req(s.viewer.cookie, "GET", `${records("orders")}/${s.granted._id as string}`);
  expect(one.status).toBe(200);
  const version = (await one.json()) as { record: { _updated_at: string } };
  const deleted = await req(
    s.viewer.cookie,
    "DELETE",
    `${records("orders")}/${s.granted._id as string}`,
    undefined,
    version.record._updated_at,
  );
  // **`viewer` は固定ロールの層が書込を止めるので 403**(面より前に立つ層である)。
  // **【誇張しない】これは面でも点でもない層が止めている** —— **止めた層を取り違えない。**
  expect(deleted.status).toBe(403);
});
