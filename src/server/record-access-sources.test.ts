/**
 * **`V17-M6-T04` / `AC-G24`(口)**: **「どの付与行が効いて読み書きができるのか」を返す、
 * 読取専用の HTTP の口を1本。**
 *
 * **正は `docs/plan/v17/07-v17-m6-plan.md` の §2b の 4 / §3-4b(**今日の正**)であり、
 * §3-4 は 2026-09-08 の利用者決定 `D1` より前の仮決定である**(1バイトも消えていないが、
 * 「自分についてだけ」と書いた部分は今日の正ではない)。
 *
 * ## 測るもの(**計画 §2b の 4 の7項**)
 *
 * - **(S-1)** **口が実在する**(**着手前 赤**。今日は 404)。
 * - **(S-2)** **`GET` 以外(`POST` / `PATCH` / `DELETE`)はこの口に1本も生えていない**
 *   (**読取専用**。**着手前 緑** —— **口そのものが無いので 404 になる**。
 *   **【正直に】着手前のこの緑は「読取専用だから」ではなく「口が無いから」である。**)。
 * - **(S-3)** **直接の付与で `read` が真になった行では、その付与行の `_id` が返る**
 *   (**着手前 赤**)。
 * - **(S-4)** **引き継ぎで真になった行では、**親の側の付与行の `_id` と、その行が在る表**が
 *   返る**(**着手前 赤**)。
 * - **(S-5)** **付与が1件も無い行では、単票 `GET` と同じ **404** になる**
 *   (**存在を伏せる。着手前 緑** —— **(S-2) と同じ理由で、着手前の緑は口が無いことの帰結である**)。
 * - **(S-6)** **一覧・単票の応答の `access` は4キーのままである**(**着手前 緑。`ADR-0402` 限定2**)。
 * - **(S-7)** **MCP の道具は 26本 のままである**(**着手前 緑**)。
 *
 * ## **`D1`(利用者決定)が足した経路**(**§3-4b。「管理者は他の人の分も確かめられる」**)
 *
 * - **(M-1)** **運営が `?member=` で他の利用者ぶんを問える**(**着手前 赤**)。
 * - **(M-2)** **運営自身が読めない行は **404**(`?member=` を書いても伏せる)。**
 * - **(M-3)** **問われた相手がその行を読めないときは **200** で `sources` が空。**
 * - **(M-4)** **`?member=` が名簿に実在しない行を指したら **400**。**
 * - **(M-5)** **非運営が `?member=` を書くと **403**。**
 *
 * ## **限定の機械的な固定**(**§3-4b の (9)。門外なので個別 ADR は書かない**)
 *
 * - **(L-6)** **`sources` の1件のキーは **7つちょうど** である**(付与行の中身を1つも返さない)。
 * - **(L-9)** **`?member=` を書けるのは運営だけである**((M-5) と同じ項)。
 * - **(L-2)** **MCP の道具を1本も増やさない**((S-7) と同じ項)。
 *
 * ## **【この検査が測っていないもの。誇張しない】**
 *
 * - **止めた層の名前(`blockedBy`)が返らないことは (L-6) の裏返しでしか測っていない。**
 * - **`sources` が空であることの理由(面で読めているのか、何も届いていないのか)は
 *   この口からは区別できない** —— **区別できないことそのものは撃っていない。**
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appDbPath,
  applyManifest,
  createApp,
  createRecord,
  KernelMetaStore,
  type Manifest,
} from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "access-sources-desk";

/** **測る口**(**単票 `GET` より1段深い。ルート照合がぶつからない**)。 */
const DOOR = (tableId: string, recordId: string): string =>
  `/api/apps/${APP_ID}/tables/${tableId}/records/${recordId}/access-sources`;

/** 単票 `GET`(**伏せ方をそろえたことを測る相手**)。 */
const SINGLE = (tableId: string, recordId: string): string =>
  `/api/apps/${APP_ID}/tables/${tableId}/records/${recordId}`;

const PERMISSIONS = [
  { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
  { id: "writer", name: "編集できる", read: true, write: true, delete: false },
] as const;

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "付与の出どころ台帳",
      roles: [
        {
          id: "owner",
          name: "持ち主",
          rules: [
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
          ],
        },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
      ],
      tables: [
        {
          id: "cases",
          name: "案件",
          fields: [{ id: "title", name: "題", type: "text", required: true }],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "writer",
            grant: {
              table: "case_grant",
              target: "case",
              member: "member",
              permission: "permission",
            },
            members: { table: "case_member", account: "account" },
          },
        },
        {
          id: "notes",
          name: "案件メモ",
          fields: [
            { id: "body", name: "本文", type: "text" },
            { id: "case", name: "案件", type: "reference", reference_table: "cases" },
          ],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "writer",
            grant: {
              table: "note_grant",
              target: "note",
              member: "member",
              permission: "permission",
            },
            members: { table: "case_member", account: "account" },
            inherit_from: ["case"],
          },
        },
        {
          id: "plain",
          name: "掲示",
          fields: [{ id: "body", name: "本文", type: "text" }],
        },
        {
          id: "case_member",
          name: "利用者",
          fields: [{ id: "account", name: "ログイン", type: "text" }],
        },
        {
          id: "case_grant",
          name: "付与",
          fields: [
            { id: "case", name: "案件", type: "reference", reference_table: "cases" },
            { id: "member", name: "相手", type: "reference", reference_table: "case_member" },
            { id: "permission", name: "権限", type: "select", options: ["reader", "writer"] },
          ],
        },
        {
          id: "note_grant",
          name: "メモの付与",
          fields: [
            { id: "note", name: "メモ", type: "reference", reference_table: "notes" },
            { id: "member", name: "相手", type: "reference", reference_table: "case_member" },
            { id: "permission", name: "権限", type: "select", options: ["reader", "writer"] },
          ],
        },
      ],
      views: [],
    },
  } as unknown as Manifest;
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;
let owner: ReturnType<typeof seedSession>;
let editor: ReturnType<typeof seedSession>;
let ownerMember = "";
let editorMember = "";
/** 運営にだけ付与が在る行。 */
let caseOwnerOnly = "";
/** 運営と編集者の両方に付与が在る行。 */
let caseShared = "";
/** 編集者にだけ付与が在る行(**運営には見えない**)。 */
let caseOtherOnly = "";
/** 付与が1件も無い行。 */
let caseNoGrant = "";
/** 親(`caseShared`)にだけ付与が在る子の行。 */
let noteInherited = "";
/** 宣言していない表の行。 */
let plainRow = "";
/** 運営に配った付与行の `_id`(`caseShared`)。 */
let sharedGrantToOwner = "";
/** 編集者に配った付与行の `_id`(`caseShared`)。 */
let sharedGrantToEditor = "";
/** 運営に配った付与行の `_id`(`caseOwnerOnly`)。 */
let ownerOnlyGrant = "";

function withDb<T>(run: (db: Database) => T): T {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    return run(db);
  } finally {
    db.close();
  }
}

async function get(path: string, cookie?: string): Promise<Response> {
  return await app.request(path, cookie === undefined ? {} : { headers: { cookie } });
}

/** **生の応答をそのまま貼れる形にする**(ステータス + 本文の文字列)。 */
async function raw(path: string, cookie?: string): Promise<{ status: number; body: string }> {
  const response = await get(path, cookie);
  return { status: response.status, body: await response.text() };
}

type SourceEntry = {
  table?: string;
  record_id?: string;
  permission?: string;
  grants?: string[];
  via?: string;
  depth?: number;
  through?: { table?: string; record_id?: string } | null;
};
type DoorBody = {
  subject?: { member?: string | null; self?: boolean };
  access?: Record<string, Record<string, unknown>>;
  sources?: SourceEntry[];
};

async function door(
  tableId: string,
  recordId: string,
  cookie: string,
  member?: string,
): Promise<{ status: number; body: DoorBody }> {
  const path =
    member === undefined ? DOOR(tableId, recordId) : `${DOOR(tableId, recordId)}?member=${member}`;
  const response = await get(path, cookie);
  return { status: response.status, body: (await response.json()) as DoorBody };
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-ras-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "付与の出どころ台帳", { app_id: APP_ID });
  } finally {
    store.close();
  }
  // **点(行ごとの付与)を測るので、点を宣言した2表には面の規則を1本も足さない** ——
  // **面と点は `OR` なので、足すと点の測定が丸ごと無効になる**(`record-access-orphans.test.ts`
  // が採ったのと同じ作法)。
  expect(
    applyManifest(
      dataRoot,
      APP_ID,
      withDefaultRoleRules(manifest(), { skipTables: ["cases", "notes"] }),
    ).valid,
  ).toBe(true);
  app = createServerApp({ dataRoot });

  owner = seedSession(dataRoot, APP_ID, { role: "owner", username: "u-owner" });
  editor = seedSession(dataRoot, APP_ID, { role: "editor", username: "u-editor" });

  const loaded = manifest();
  withDb((db) => {
    const make = (table: string, values: Record<string, unknown>): string => {
      const created = createRecord(db, loaded, table, values);
      expect(created.ok).toBe(true);
      return (created as { value: { _id: string } }).value._id;
    };
    ownerMember = make("case_member", { account: owner.userId });
    editorMember = make("case_member", { account: editor.userId });

    caseOwnerOnly = make("cases", { title: "運営だけの案件" });
    caseShared = make("cases", { title: "2人に配った案件" });
    caseOtherOnly = make("cases", { title: "編集者だけの案件" });
    caseNoGrant = make("cases", { title: "誰にも配っていない案件" });
    noteInherited = make("notes", { body: "親にだけ付与が在るメモ", case: caseShared });
    plainRow = make("plain", { body: "宣言していない表" });

    ownerOnlyGrant = make("case_grant", {
      case: caseOwnerOnly,
      member: ownerMember,
      permission: "writer",
    });
    sharedGrantToOwner = make("case_grant", {
      case: caseShared,
      member: ownerMember,
      permission: "writer",
    });
    sharedGrantToEditor = make("case_grant", {
      case: caseShared,
      member: editorMember,
      permission: "reader",
    });
    make("case_grant", { case: caseOtherOnly, member: editorMember, permission: "writer" });
  });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

describe("V17-M6-T04 (S): 計画 §2b の 4 の7項", () => {
  test("(S-1) 口が実在する —— 自分に届いている行では 200 が返る", async () => {
    const out = await raw(DOOR("cases", caseOwnerOnly), owner.cookie);
    expect(out.status).toBe(200);
    const body = JSON.parse(out.body) as DoorBody;
    // **トップレベルのキーは3つちょうどである**(§3-4b の (5))。
    expect(Object.keys(body).sort()).toEqual(["access", "sources", "subject"]);
    expect(body.subject).toEqual({ member: null, self: true });
  });

  test("(S-2) GET 以外はこの口に1本も生えていない(読取専用)", async () => {
    for (const method of ["POST", "PATCH", "DELETE"]) {
      const init: RequestInit = {
        method,
        headers: { cookie: owner.cookie, "content-type": "application/json" },
      };
      if (method !== "DELETE") {
        init.body = "{}";
      }
      const response = await app.request(
        new Request(`http://localhost${DOOR("cases", caseOwnerOnly)}`, init),
      );
      expect({ method, status: response.status }).toEqual({ method, status: 404 });
    }
    // **ソースの上でも、このパスの登録が `app.get` 1本だけであることを固定する。**
    const source = readFileSync(new URL("./app.ts", import.meta.url).pathname, "utf8");
    const registrations = [...source.matchAll(/\bapp\.(get|post|patch|delete|put)\(\s*"([^"]+)"/g)]
      .filter((match) => (match[2] as string).endsWith("/access-sources"))
      .map((match) => `${(match[1] as string).toUpperCase()} ${match[2]}`);
    expect(registrations).toEqual([
      "GET /api/apps/:app_id/tables/:table_id/records/:record_id/access-sources",
    ]);
  });

  test("(S-3) 直接の付与で read が真になった行では、その付与行の _id が返る", async () => {
    const out = await door("cases", caseOwnerOnly, owner.cookie);
    expect(out.status).toBe(200);
    expect(out.body.sources?.map((entry) => entry.record_id)).toEqual([ownerOnlyGrant]);
    const entry = out.body.sources?.[0] as SourceEntry;
    expect({
      table: entry.table,
      permission: entry.permission,
      grants: entry.grants,
      via: entry.via,
      depth: entry.depth,
      through: entry.through,
    }).toEqual({
      table: "case_grant",
      permission: "writer",
      grants: ["read", "write"],
      via: "self",
      depth: 0,
      through: null,
    });
    // **判定そのものと1バイトも食い違わない** —— **同じ行の `access` を並べて見る。**
    expect(out.body.access?.[caseOwnerOnly]).toEqual({
      read: true,
      write: true,
      delete: false,
      grant_write: true,
    });
  });

  test("(S-4) 引き継ぎで真になった行では、親の側の付与行の _id とその表が返る", async () => {
    const out = await door("notes", noteInherited, owner.cookie);
    expect(out.status).toBe(200);
    expect(out.body.sources).toEqual([
      {
        table: "case_grant",
        record_id: sharedGrantToOwner,
        permission: "writer",
        grants: ["read", "write"],
        via: "inherited",
        depth: 1,
        through: { table: "cases", record_id: caseShared },
      },
    ]);
  });

  test("(S-5) 付与が1件も無い行では、単票 GET と同じ 404 になる(存在を伏せる)", async () => {
    const single = await raw(SINGLE("cases", caseNoGrant), owner.cookie);
    const sources = await raw(DOOR("cases", caseNoGrant), owner.cookie);
    expect({ single: single.status, sources: sources.status }).toEqual({
      single: 404,
      sources: 404,
    });
  });

  test("(S-6) 一覧・単票の応答の access は4キーのままである(`ADR-0402` 限定2)", async () => {
    const list = await get(`/api/apps/${APP_ID}/tables/cases/records`, owner.cookie);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { access?: Record<string, Record<string, unknown>> };
    for (const value of Object.values(listBody.access ?? {})) {
      expect(Object.keys(value).sort()).toEqual(["delete", "grant_write", "read", "write"]);
    }
    const single = await get(SINGLE("cases", caseOwnerOnly), owner.cookie);
    expect(single.status).toBe(200);
    const singleBody = (await single.json()) as {
      access?: Record<string, Record<string, unknown>>;
    };
    expect(Object.keys(singleBody.access?.[caseOwnerOnly] ?? {}).sort()).toEqual([
      "delete",
      "grant_write",
      "read",
      "write",
    ]);
  });

  test("(S-7) MCP の道具は 26本 のままである", () => {
    const tools = ["read", "write"].flatMap((file) =>
      [
        ...readFileSync(
          new URL(`../mcp/tools/${file}.ts`, import.meta.url).pathname,
          "utf8",
        ).matchAll(/server\.registerTool\(\s*"([a-z_]+)"/g),
      ].map((match) => match[1] as string),
    );
    expect(tools.length).toBe(26);
  });
});

describe("V17-M6-T04 (M): 利用者決定 `D1` —— 運営は他の利用者ぶんも問える", () => {
  test("(M-1) 運営が ?member= で他の利用者ぶんを問える", async () => {
    const out = await door("cases", caseShared, owner.cookie, editorMember);
    expect(out.status).toBe(200);
    expect(out.body.subject).toEqual({ member: editorMember, self: false });
    expect(out.body.sources?.map((entry) => entry.record_id)).toEqual([sharedGrantToEditor]);
    // **返るのは相手の判定である**(`reader` なので書けない)。
    expect(out.body.access?.[caseShared]).toEqual({
      read: true,
      write: false,
      delete: false,
      grant_write: false,
    });
    // **自分について問えば、返るのは自分の付与行である**(混ざっていない)。
    const self = await door("cases", caseShared, owner.cookie);
    expect(self.body.sources?.map((entry) => entry.record_id)).toEqual([sharedGrantToOwner]);
  });

  test("(M-2) 運営自身が読めない行は 404(?member= を書いても伏せる)", async () => {
    const single = await raw(SINGLE("cases", caseOtherOnly), owner.cookie);
    const asked = await raw(`${DOOR("cases", caseOtherOnly)}?member=${editorMember}`, owner.cookie);
    expect({ single: single.status, asked: asked.status }).toEqual({ single: 404, asked: 404 });
    // **編集者からは実際に読める行である**(伏せているのは運営に対してだけである)。
    const byEditor = await raw(SINGLE("cases", caseOtherOnly), editor.cookie);
    expect(byEditor.status).toBe(200);
  });

  test("(M-3) 問われた相手がその行を読めないときは 200 で sources が空", async () => {
    const out = await door("cases", caseOwnerOnly, owner.cookie, editorMember);
    expect(out.status).toBe(200);
    expect(out.body.sources).toEqual([]);
    expect(out.body.access?.[caseOwnerOnly]).toEqual({
      read: false,
      write: false,
      delete: false,
      grant_write: false,
    });
  });

  test("(M-4) ?member= が名簿に実在しない行を指したら 400", async () => {
    const out = await raw(`${DOOR("cases", caseShared)}?member=no-such-member`, owner.cookie);
    expect(out.status).toBe(400);
    // **その id が他の表に在るかどうかを1文字も漏らさない。**
    expect(out.body).not.toContain("no-such-member");
    expect(out.body).not.toContain("case_member");
  });

  test("(M-5) 非運営が ?member= を書くと 403(`?member=` 無しなら今日どおり通る)", async () => {
    const forbidden = await raw(
      `${DOOR("cases", caseShared)}?member=${ownerMember}`,
      editor.cookie,
    );
    expect(forbidden.status).toBe(403);
    const own = await door("cases", caseShared, editor.cookie);
    expect(own.status).toBe(200);
    expect(own.body.sources?.map((entry) => entry.record_id)).toEqual([sharedGrantToEditor]);
  });
});

// ---------------------------------------------------------------------------
// 【2026-09-14 `V18-M8-T02`(`ADR-0445` §Decision 6)】`?member=` には面を掛けない
// ---------------------------------------------------------------------------

/**
 * **閲覧者を1人足し、`caseShared` に直接の `writer` を配る**(この2本の検査だけの台)。
 * **閲覧者は既定の規則で付与表 `case_grant` に `read` しか持たない** —— **面で付与表に書けない
 * 直接の作成者である。**
 */
function seedViewerWriter(): { viewer: ReturnType<typeof seedSession>; viewerMember: string } {
  const viewer = seedSession(dataRoot, APP_ID, { role: "viewer", username: "u-viewer" });
  const loaded = manifest();
  let viewerMember = "";
  withDb((db) => {
    const made = createRecord(db, loaded, "case_member", { account: viewer.userId });
    expect(made.ok).toBe(true);
    viewerMember = (made as { value: { _id: string } }).value._id;
    const granted = createRecord(db, loaded, "case_grant", {
      case: caseShared,
      member: viewerMember,
      permission: "writer",
    });
    expect(granted.ok).toBe(true);
  });
  return { viewer, viewerMember };
}

describe("V18-M8-T02 (M): `?member=` では面を掛けず、本人について問うと面を掛ける", () => {
  test("(M-6) 運営が ?member= で他人について問うた `grant_write` には、面の断りが1つも掛からない", async () => {
    const { viewerMember } = seedViewerWriter();
    const asked = await door("cases", caseShared, owner.cookie, viewerMember);
    expect(asked.status).toBe(200);
    // **閲覧者は面で付与表に書けないが、`?member=` の答えは壁の関門 (1)(2) だけで決まる**
    // (相手の役割はこの口に渡らない。**面を掛けると「配れる人を配れないと言う」嘘になる**)。
    // **【誇張しない】この真は「その人が押しても断られない」ことを意味しない**(`ADR-0445` §Decision 6)。
    expect(asked.body.access?.[caseShared]?.grant_write).toBe(true);
  });

  test("(M-7) 本人について問うと面の断りが掛かり、同じ人の付与の POST も面で止まる", async () => {
    const { viewer } = seedViewerWriter();
    const self = await door("cases", caseShared, viewer.cookie);
    const single = await get(SINGLE("cases", caseShared), viewer.cookie);
    const singleBody = (await single.json()) as {
      access?: Record<string, Record<string, unknown>>;
    };
    const posted = await app.request(`/api/apps/${APP_ID}/tables/case_grant/records`, {
      method: "POST",
      headers: { cookie: viewer.cookie, "content-type": "application/json", origin: TEST_ORIGIN },
      body: JSON.stringify({ case: caseShared, member: editorMember, permission: "reader" }),
    });
    const message = ((await posted.json()) as { errors?: { message?: string }[] }).errors?.[0]
      ?.message;
    expect({
      door: self.body.access?.[caseShared]?.grant_write,
      single: singleBody.access?.[caseShared]?.grant_write,
      status: posted.status,
      message,
    }).toEqual({
      door: false,
      single: false,
      status: 403,
      message:
        '表 "case_grant" に対する書き込みは、あなたの役割に許されていません(止めた層: role)。',
    });
  });
});

describe("V17-M6-T04 (L): 門外の限定の機械的な固定(§3-4b の (9))", () => {
  test("(L-6) sources の1件のキーは7つちょうどである(付与行の中身を1つも返さない)", async () => {
    const direct = await door("cases", caseOwnerOnly, owner.cookie);
    const inherited = await door("notes", noteInherited, owner.cookie);
    const entries = [...(direct.body.sources ?? []), ...(inherited.body.sources ?? [])];
    expect(entries.length).toBe(2);
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual([
        "depth",
        "grants",
        "permission",
        "record_id",
        "table",
        "through",
        "via",
      ]);
    }
    // **相手の名前も、相手を指す欄の値も1文字も返らない。**
    const body = JSON.stringify(direct.body) + JSON.stringify(inherited.body);
    expect(body).not.toContain(ownerMember);
    expect(body).not.toContain(editorMember);
    expect(body).not.toContain(owner.userId);
  });

  test("(L-7) 宣言していない表では 200 で sources が空である(伏せない・作らない)", async () => {
    // **【なぜ 404 にしないか。決めた理由を書く】** —— **その行は運営から今日**読める**。**
    // **読める行に 404 を返すと、この口だけが単票 `GET` と食い違う。**
    // **点(行ごとの付与)を宣言していない表には付与行が1件も無いので、`sources` は空である**
    // —— **それが真実であり、伏せる理由が1つも無い。**
    const out = await door("plain", plainRow, owner.cookie);
    expect(out.status).toBe(200);
    expect(out.body.sources).toEqual([]);
  });

  test("(L-8) 未認証はこの口に1バイトも届かない(401)", async () => {
    const out = await raw(DOOR("cases", caseOwnerOnly));
    expect(out.status).toBe(401);
  });
});
