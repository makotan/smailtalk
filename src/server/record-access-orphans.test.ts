/**
 * **`V7-M5-T02` / `Z-G19`**: **「誰にも見えない行」を見つける、運営専用の口を1本。**
 *
 * **正は `docs/plan/v7/records/v7-m5.md` の `V7-M5-T02` と、
 * `docs/plan/v7/records/v7-m0.md` の §6-3 `Z-G19`(限定1〜6 と「誇張しない」の枠)である。**
 *
 * ## 測るもの
 *
 * - **(A)** **運営(`owner`)が、付与が0件の行をこの口から取れる**(HTTP の生の応答を貼る形)。
 * - **(B)** **他人に付与された行が1件も並ばない。** **運営自身に付与された行も並ばない**
 *   (**付与が在るから**であって、相手が誰かは1ミリも見ていない)。
 * - **(C)** **`editor` / `viewer` / 宣言された利用者の種類 → 403、未認証 → 401**
 *   (**実測値で固定する。認証の壁は判定より手前に立つ** —— `V7-M5-T01` の (B) と同じ形)。
 * - **(D)** **宣言していない表 / `enabled: false` の表 → 404**(オプトイン)。
 * - **(E)** **読取専用** —— **`PATCH` / `DELETE` / `POST` はこのパスで1本も通らない。**
 *   **ソースの上でも、このパスの登録が `app.get` 1本だけであることを固定する。**
 * - **(F)** **`limit` / `offset` を変えても件数が狂わない**(母集団は「付与0件の行」の集合)。
 * - **(G)** **この口は `Z-G18` の壁を迂回していない** —— **この口から取れた行を、通常の
 *   単件 `GET` で運営が取ろうとすると今日も 404 である**(**同じテストの中で並べる**)。
 * - **(H)** **付与を1件足すと、その行はこの口から消える**(付与0件でなくなるため)。
 * - **(I)** **ルート照合がぶつからない** —— **`unreachable-records` が単件 `GET` の
 *   `:record_id` として拾われていないことを、応答の形と登録の全量の両方で測る。**
 *
 * ## **(Y) 引き継ぎの穴を塞いだこと(`V7-M5-T02` 差し戻し後に足した)**
 *
 * **【何が起きていたか。旧の検査の名前と期待値を1バイトも消さずに書く】** ——
 * **初版の本ファイルには次の2本が在った**:
 *   `test("(X-1) 親にだけ付与が在る子の行は、この口に並ぶ(穴である)", …)` ——
 *     期待値 `expect(listing.ids).toContain(inheritingNote); expect(listing.total).toBe(2);`
 *   `test("(X-1b) その子の行は、親の付与を持つ他人からは実際に読める", …)` ——
 *     期待値 `expect(single.status).toBe(200);` と、同じ行がこの口に並んでいること。
 * **この2本は「穴が在る」ことを緑で記録していた。** **`01-record-access-grant-baseline.md`
 * §7 の `V7-M5` の完了の考え方 (ii) の逐語「**『誰にも見えない行』を見つける道が実在し、
 * それが (i) の壁を迂回する新しい抜け道になっていないこと。**」に照らすと、これは完了条件
 * そのものに当たる** —— **メインが差し戻し、母集団を「引き継ぎのどの段にも付与が無い行」
 * まで狭めた。** **下の (Y) がその塞ぎを固定する。**
 *
 * - **(Y-1)** **親にだけ付与が在る子の行が口に並ばない**。**同じテストの中で**、その行が
 *   他人から単件 `GET` で **200** で読めることを並べて突き合わせる(= **見えている行は
 *   取り残しに出ない**)。
 * - **(Y-2)** **3段(祖父 → 親 → 子)でも同じ。**
 * - **(Y-3)** **どの段にも付与が無い行は今日どおり並ぶ**(狭めすぎて空にしていない)。
 * - **(Y-4)** **循環があってもこの口は応答を返す**(訪問済み集合。`Z-G16`)。
 * - **(Y-5)** **`st_public` と宣言の同居は適用時に拒否される** —— **したがって
 *   「公開表で未認証がハンドラまで届く」場合分けは今日は到達できない**(実測)。
 * - **(Y-6)** **段数の上限に当たったら要求全体が 400 になる**(`V7-M4-T04` と同じ形)。
 *
 * ## **測って「できていない」ことを記録するもの(誇張しない)**
 *
 * - **(X-2)** **付与の相手(メンバー行)が消えた行は、この口に1件も並ばない**
 *   (**付与が0件ではないため**)。**その行が今日どの道から見つかるかを並べて測る。**
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
  deleteRecord,
  KernelMetaStore,
  type Manifest,
} from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "orphan-desk";
const APP_SOURCE = readFileSync(new URL("./app.ts", import.meta.url).pathname, "utf8");

/** 運営専用の口。**`/records` の下ではなく兄弟のパスに置いてある**(ルート照合の衝突回避)。 */
const DOOR = (tableId: string): string =>
  `/api/apps/${APP_ID}/tables/${tableId}/unreachable-records`;

const PERMISSIONS = [
  { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
  { id: "writer", name: "編集できる", read: true, write: true, delete: false },
] as const;

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "取り残し台帳",
      // **【`V8-M29` 第2波】旧(逐語)**: `user_kinds: [{ id: "partner", name: "協力会社" }],`
      // **語彙 `app.user_kinds` は廃止された** —— **代わりに立つのは `app.roles`
      // (差分操作 `set_roles`)である。****`partner` に規則(`rules`)は1本も書かない** ——
      // **`withDefaultRoleRules` が規則を足すのは既定3役割だけなので、`partner` の面は
      // 旧(利用者の種類だった日)と同じく閉じたままである。**
      roles: [
        {
          id: "owner",
          name: "持ち主",
          // **【`V8-M28` / `T-G16a`】持ち主にはこの2行が必ず要る**(類型17 の拡張)。
          rules: [
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
          ],
        },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
        { id: "partner", name: "協力会社" },
      ],
      tables: [
        {
          // **宣言つきの表**(`st_owner` も `st_public` も1本も持たない)。
          id: "cases",
          name: "案件",
          fields: [
            { id: "title", name: "題", type: "text", required: true },
            { id: "memo", name: "メモ", type: "long_text" },
          ],
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
          // **引き継ぎ(`inherit_from`)を持つ子の表**((X-1) の測定台)。
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
          // **孫の表**((Y-2) の3段: `note_lines` → `notes` → `cases`)。
          id: "note_lines",
          name: "メモの明細",
          fields: [
            { id: "body", name: "本文", type: "text" },
            { id: "note", name: "メモ", type: "reference", reference_table: "notes" },
          ],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "writer",
            grant: {
              table: "line_grant",
              target: "line",
              member: "member",
              permission: "permission",
            },
            members: { table: "case_member", account: "account" },
            inherit_from: ["note"],
          },
        },
        {
          // **段数の上限の測定台**((Y-6))。**循環の表と分けてある** —— **1行でも上限に
          // 当たると要求全体が 400 になるので、同じ表に置くと (Y-4) が測れない。**
          id: "deep_nodes",
          name: "深い節",
          fields: [
            { id: "title", name: "名前", type: "text", required: true },
            { id: "parent", name: "親", type: "reference", reference_table: "deep_nodes" },
          ],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "writer",
            grant: {
              table: "deep_grant",
              target: "node",
              member: "member",
              permission: "permission",
            },
            members: { table: "case_member", account: "account" },
            inherit_from: ["parent"],
          },
        },
        {
          // **自分自身を親にできる表**((Y-4) の循環の測定台)。
          id: "nodes",
          name: "入れ子の節",
          fields: [
            { id: "title", name: "名前", type: "text", required: true },
            { id: "parent", name: "親", type: "reference", reference_table: "nodes" },
          ],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "writer",
            grant: {
              table: "node_grant",
              target: "node",
              member: "member",
              permission: "permission",
            },
            members: { table: "case_member", account: "account" },
            inherit_from: ["parent"],
          },
        },
        {
          // **宣言していない表**(オプトインの対照)。
          id: "plain",
          name: "掲示",
          fields: [{ id: "body", name: "本文", type: "text" }],
        },
        {
          // **`enabled: false` の表**(宣言はあるが効かない)。
          id: "paused",
          name: "停止中の表",
          fields: [{ id: "body", name: "本文", type: "text" }],
          access_control: {
            enabled: false,
            permissions: [...PERMISSIONS],
            creator_permission: "writer",
            grant: {
              table: "paused_grant",
              target: "paused",
              member: "member",
              permission: "permission",
            },
            members: { table: "case_member", account: "account" },
          },
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
        {
          id: "line_grant",
          name: "明細の付与",
          fields: [
            { id: "line", name: "明細", type: "reference", reference_table: "note_lines" },
            { id: "member", name: "相手", type: "reference", reference_table: "case_member" },
            { id: "permission", name: "権限", type: "select", options: ["reader", "writer"] },
          ],
        },
        {
          id: "deep_grant",
          name: "深い節の付与",
          fields: [
            { id: "node", name: "節", type: "reference", reference_table: "deep_nodes" },
            { id: "member", name: "相手", type: "reference", reference_table: "case_member" },
            { id: "permission", name: "権限", type: "select", options: ["reader", "writer"] },
          ],
        },
        {
          id: "node_grant",
          name: "節の付与",
          fields: [
            { id: "node", name: "節", type: "reference", reference_table: "nodes" },
            { id: "member", name: "相手", type: "reference", reference_table: "case_member" },
            { id: "permission", name: "権限", type: "select", options: ["reader", "writer"] },
          ],
        },
        {
          id: "paused_grant",
          name: "停止中の付与",
          fields: [
            { id: "paused", name: "行", type: "reference", reference_table: "paused" },
            { id: "member", name: "相手", type: "reference", reference_table: "case_member" },
            { id: "permission", name: "権限", type: "select", options: ["reader", "writer"] },
          ],
        },
      ],
      views: [],
    },
  } as unknown as Manifest;
}

const SIGNED_IN = ["owner", "editor", "viewer", "partner"] as const;
type SignedIn = (typeof SIGNED_IN)[number];

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;
let actors: Record<SignedIn, ReturnType<typeof seedSession>>;
let members: Record<SignedIn, string>;
/** 付与が0件の行(**この口に並ぶべき集合**)。 */
let orphans: string[] = [];
/** 他人(誰のセッションでもない利用者)にだけ付与された行。 */
let grantedToStranger = "";
/** **運営自身**に付与された行(**付与が在るので並ばない**)。 */
let grantedToOwner = "";
/** 付与は在るが、相手のメンバー行が消えている行((X-2))。 */
let grantedToDeletedMember = "";
/** 親(`cases`)にだけ付与が在る子の行((Y-1))。 */
let inheritingNote = "";
/** 付与も引き継ぎ元の付与も1件も無い子の行。 */
let orphanNote = "";
/** 祖父(`cases`)にだけ付与が在る孫の行((Y-2) の3段)。 */
let inheritingLine = "";
/** どの段にも付与が無い孫の行。 */
let orphanLine = "";
/** 循環((Y-4)): `cycA.parent = cycB` / `cycB.parent = cycA`。 */
let cycA = "";
let cycB = "";
/** 段数の上限((Y-6)): 7行の鎖(段6 に進もうとする)。 */
let deepLeaf = "";
let plainRow = "";
let pausedRow = "";
let strangerMember = "";

function withDb<T>(run: (db: Database) => T): T {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    return run(db);
  } finally {
    db.close();
  }
}

/** 認証済みなら cookie を送り、未認証(`undefined`)なら1バイトも送らない。 */
async function get(path: string, cookie?: string): Promise<Response> {
  return await app.request(path, cookie === undefined ? {} : { headers: { cookie } });
}

/** **生の応答をそのまま貼れる形にする**(ステータス + 本文の文字列)。 */
async function raw(path: string, cookie?: string): Promise<{ status: number; body: string }> {
  const response = await get(path, cookie);
  return { status: response.status, body: await response.text() };
}

type ListBody = { records?: { _id?: string }[]; total?: number };

async function listed(path: string, cookie: string): Promise<{ ids: string[]; total: number }> {
  const response = await get(path, cookie);
  expect(response.status).toBe(200);
  const body = (await response.json()) as ListBody;
  return {
    ids: (body.records ?? []).map((row) => row._id as string),
    total: body.total as number,
  };
}

function grant(
  table: "case_grant" | "note_grant" | "node_grant",
  values: Record<string, unknown>,
): string {
  const loaded = manifest();
  return withDb((db) => {
    const created = createRecord(db, loaded, table, values);
    expect(created.ok).toBe(true);
    return (created as { value: { _id: string } }).value._id;
  });
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-rao-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "取り残し台帳", { app_id: APP_ID });
  } finally {
    store.close();
  }
  // **【`V8-M26`】既定が「閉じる」側へ倒れたので、題材へ既定3役割の規則を足す。**
  // **旧: `expect(applyManifest(dataRoot, APP_ID, manifest()).valid).toBe(true);`**
  //
  // **本ファイルの主題は「取り残し(付与の相手が消えた行)を運営専用の口で見つけられるか」
  // であって面ではない。** **`access_control` を効かせている5表
  // (`cases` / `notes` / `note_lines` / `deep_nodes` / `nodes`)には1本も足さない** ——
  // **面と点は `OR` なので、足すと点の測定が丸ごと無効になる。**
  // **足すのは土台の表(付与表・利用者表・`plain` / `paused`)だけである。**
  expect(
    applyManifest(
      dataRoot,
      APP_ID,
      withDefaultRoleRules(manifest(), {
        skipTables: ["cases", "notes", "note_lines", "deep_nodes", "nodes"],
      }),
    ).valid,
  ).toBe(true);
  app = createServerApp({ dataRoot });

  actors = {} as Record<SignedIn, ReturnType<typeof seedSession>>;
  for (const role of SIGNED_IN) {
    actors[role] = seedSession(dataRoot, APP_ID, { role, username: `u-${role}` });
  }

  const loaded = manifest();
  members = {} as Record<SignedIn, string>;
  orphans = [];
  withDb((db) => {
    const caseRow = (title: string): string => {
      const created = createRecord(db, loaded, "cases", { title });
      expect(created.ok).toBe(true);
      return (created as { value: { _id: string } }).value._id;
    };
    // **付与0件の行を7件**(ページングの母集団でもある)。
    for (let index = 0; index < 7; index += 1) {
      orphans.push(caseRow(`取り残し${index}`));
    }
    grantedToStranger = caseRow("他人に渡した案件");
    grantedToOwner = caseRow("運営自身に渡した案件");
    grantedToDeletedMember = caseRow("相手が消えた案件");

    const plain = createRecord(db, loaded, "plain", { body: "宣言していない表" });
    expect(plain.ok).toBe(true);
    plainRow = (plain as { value: { _id: string } }).value._id;
    const paused = createRecord(db, loaded, "paused", { body: "enabled: false の表" });
    expect(paused.ok).toBe(true);
    pausedRow = (paused as { value: { _id: string } }).value._id;

    for (const role of SIGNED_IN) {
      const created = createRecord(db, loaded, "case_member", { account: actors[role].userId });
      expect(created.ok).toBe(true);
      members[role] = (created as { value: { _id: string } }).value._id;
    }
    const stranger = createRecord(db, loaded, "case_member", { account: "someone-else" });
    expect(stranger.ok).toBe(true);
    strangerMember = (stranger as { value: { _id: string } }).value._id;

    // **子の行**: 親にだけ付与が在るもの / 何も無いもの。
    const note = (body: string, caseId: string | null): string => {
      const created = createRecord(
        db,
        loaded,
        "notes",
        caseId === null ? { body } : { body, case: caseId },
      );
      expect(created.ok).toBe(true);
      return (created as { value: { _id: string } }).value._id;
    };
    inheritingNote = note("親に付与が在るメモ", grantedToStranger);
    orphanNote = note("親も自分も付与が無いメモ", orphans[0] as string);

    // **孫の行**((Y-2) の3段: 明細 → メモ → 案件)。
    const line = (body: string, noteId: string): string => {
      const created = createRecord(db, loaded, "note_lines", { body, note: noteId });
      expect(created.ok).toBe(true);
      return (created as { value: { _id: string } }).value._id;
    };
    inheritingLine = line("祖父に付与が在る明細", inheritingNote);
    orphanLine = line("どの段にも付与が無い明細", orphanNote);

    // **循環**((Y-4)): **`createRecord` は作成時にしか値を渡せないので、環を閉じる
    // 2度目の書込だけ生 SQL で行う**(`src/server/access-control-cycle.test.ts` の先例と
    // 同じ作法)。
    const node = (title: string, parent: string | null): string => {
      const created = createRecord(
        db,
        loaded,
        "nodes",
        parent === null ? { title } : { title, parent },
      );
      expect(created.ok).toBe(true);
      return (created as { value: { _id: string } }).value._id;
    };
    cycA = node("環A", null);
    cycB = node("環B", cycA);
    db.query("UPDATE nodes SET parent = ? WHERE _id = ?").run(cycB, cycA);

    // **段数の上限**((Y-6)): **7行の鎖**(葉から数えて段6 に進もうとする)。
    const deepNode = (title: string, parent: string | null): string => {
      const created = createRecord(
        db,
        loaded,
        "deep_nodes",
        parent === null ? { title } : { title, parent },
      );
      expect(created.ok).toBe(true);
      return (created as { value: { _id: string } }).value._id;
    };
    let previous = deepNode("鎖0", null);
    for (let index = 1; index < 7; index += 1) {
      previous = deepNode(`鎖${index}`, previous);
    }
    deepLeaf = previous;
  });

  grant("case_grant", {
    case: grantedToStranger,
    member: strangerMember,
    permission: "writer",
  });
  grant("case_grant", {
    case: grantedToOwner,
    member: members.owner,
    permission: "writer",
  });
  // **相手のメンバー行が消えている付与**((X-2))—— **付与行そのものは残る。**
  const doomed = withDb((db) => {
    const created = createRecord(db, manifest(), "case_member", { account: "gone-user" });
    expect(created.ok).toBe(true);
    return (created as { value: { _id: string } }).value._id;
  });
  grant("case_grant", {
    case: grantedToDeletedMember,
    member: doomed,
    permission: "writer",
  });
  withDb((db) => {
    const removed = deleteRecord(db, manifest(), "case_member", doomed);
    expect(removed.ok).toBe(true);
  });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (A)(B) 運営が付与0件の行を取れる / 付与の在る行は1件も並ばない
// ---------------------------------------------------------------------------

describe("V7-M5-T02 (A): 運営専用の口から、付与が0件の行が取れる", () => {
  test("(A-1) `owner` の生の応答 —— 200 で、並ぶのは付与0件の7行ちょうど", async () => {
    const response = await raw(DOOR("cases"), actors.owner.cookie);
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as ListBody;
    expect(body.total).toBe(7);
    expect((body.records ?? []).map((row) => row._id).sort()).toEqual([...orphans].sort());
    // **応答の形は既存の一覧 `GET` とそろえてある**(`records` と `total` の2キー)。
    expect(Object.keys(body).sort()).toEqual(["records", "total"]);
  });

  test("(B-1) 他人に付与された行は1件も並ばない", async () => {
    const listing = await listed(DOOR("cases"), actors.owner.cookie);
    expect(listing.ids).not.toContain(grantedToStranger);
  });

  test("(B-2) 運営自身に付与された行も並ばない(付与が在るから)", async () => {
    const listing = await listed(DOOR("cases"), actors.owner.cookie);
    expect(listing.ids).not.toContain(grantedToOwner);
    // **運営自身の行が並ばないことは、この口が「自分に見える行の一覧」ではないことの証拠である。**
    expect(listing.total).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// (C) 運営以外は開かない —— **実測値で固定する**
// ---------------------------------------------------------------------------

describe("V7-M5-T02 (C): 運営以外がこの口を叩いたときの生の応答", () => {
  test("(C-1) editor / viewer / 宣言された種類 → 403、未認証 → 401", async () => {
    const measured = [
      { who: "editor", ...(await raw(DOOR("cases"), actors.editor.cookie)) },
      { who: "viewer", ...(await raw(DOOR("cases"), actors.viewer.cookie)) },
      { who: "partner", ...(await raw(DOOR("cases"), actors.partner.cookie)) },
      { who: "anonymous", ...(await raw(DOOR("cases"))) },
    ].map((entry) => ({ who: entry.who, status: entry.status }));
    // **未認証だけが 401 である** —— **認証の壁は判定より手前に立つ**(`V7-M5-T01` (B) と同じ)。
    expect(measured).toEqual([
      { who: "editor", status: 403 },
      { who: "viewer", status: 403 },
      { who: "partner", status: 403 },
      { who: "anonymous", status: 401 },
    ]);
  });

  test("(C-2) 運営以外の応答に、行の値が1バイトも載っていない", async () => {
    for (const cookie of [actors.editor.cookie, actors.viewer.cookie, actors.partner.cookie]) {
      const response = await raw(DOOR("cases"), cookie);
      expect(response.body).not.toContain("取り残し");
      expect(response.body).not.toContain('"records"');
    }
  });
});

// ---------------------------------------------------------------------------
// (D) 対象は `access_control.enabled` が真の表だけ
// ---------------------------------------------------------------------------

// **【`V8-M41` / 台帳 `F-G13` = 限定採用・門外(`Δ7`)。2026-08-13。旧の名前と期待値を
//   1バイトも消していない】**
//
// **旧の describe の名前**: 「**V7-M5-T02 (D): 宣言していない表と `enabled: false` の表は 404**」。
// **旧の (D-1) の名前**: 「**(D-1) 宣言していない表 / `enabled: false` の表 / 実在しない表 → すべて 404**」。
// **旧の (D-1) の期待値**:
//
//     expect(measured).toEqual([
//       { table: "plain", status: 404 },
//       { table: "paused", status: 404 },
//       { table: "nosuch", status: 404 },
//     ]);
//
// **旧の (D-2) の名前**: 「**(D-2) 404 の本文に、その表の行の値が1バイトも載っていない**」。
// **(D-2) の期待値そのものは1バイトも動かしていない**(本文に行の値が載らないことは、
// 200 になった今日も同じように測れる)。
//
// **何が変わったか** —— **`v8-m33.md` §12 の `D-13`(**規則ゼロで誰にも届かなくなった行を
// この口が1件も拾わない**)を塞いだので、宣言していない表と `enabled: false` の表は
// 404 ではなく 200 を返すようになった。**
// **本ファイルの題材では `plain` / `paused` に既定3役割の規則が入っている**
// (`beforeEach` の `withDefaultRoleRules` が `skipTables` で外しているのは点を宣言した
// 5表だけである)—— **したがってその行は誰かから読めており、一覧は 200 の空である。**
// **`nosuch`(実在しない表)は今日も 404 である** —— **404 が残る条件が消えたのではない。**
describe("V7-M5-T02 (D): 宣言していない表と `enabled: false` の表は、面の判定で拾う(`V8-M41`)", () => {
  test("(D-1) 宣言していない表 / `enabled: false` の表 → 200(規則が在るので0件)/ 実在しない表 → 今日も 404", async () => {
    const measured = [
      { table: "plain", ...(await raw(DOOR("plain"), actors.owner.cookie)) },
      { table: "paused", ...(await raw(DOOR("paused"), actors.owner.cookie)) },
      { table: "nosuch", ...(await raw(DOOR("nosuch"), actors.owner.cookie)) },
    ].map((entry) => ({ table: entry.table, status: entry.status }));
    expect(measured).toEqual([
      { table: "plain", status: 200 },
      { table: "paused", status: 200 },
      { table: "nosuch", status: 404 },
    ]);
  });

  test("(D-2) 応答の本文に、その表の行の値が1バイトも載っていない", async () => {
    const plain = await raw(DOOR("plain"), actors.owner.cookie);
    expect(plain.body).not.toContain(plainRow);
    const paused = await raw(DOOR("paused"), actors.owner.cookie);
    expect(paused.body).not.toContain(pausedRow);
  });
});

// ---------------------------------------------------------------------------
// (E) 読取専用
// ---------------------------------------------------------------------------

describe("V7-M5-T02 (E): この口は読取専用である", () => {
  test("(E-1) POST / PATCH / DELETE はこのパスで通らない(実測値で固定)", async () => {
    const measured: { method: string; status: number }[] = [];
    for (const method of ["POST", "PATCH", "DELETE"] as const) {
      const response = await app.request(DOOR("cases"), {
        method,
        headers: {
          cookie: actors.owner.cookie,
          origin: TEST_ORIGIN,
          "content-type": "application/json",
        },
        body: JSON.stringify({ title: "この口から書けてはならない" }),
      });
      measured.push({ method, status: response.status });
    }
    expect(measured).toEqual([
      { method: "POST", status: 404 },
      { method: "PATCH", status: 404 },
      { method: "DELETE", status: 404 },
    ]);
  });

  test("(E-2) ソースの上でも、このパスの登録は `app.get` 1本だけである", () => {
    const path = "/api/apps/:app_id/tables/:table_id/unreachable-records";
    const registrations = [
      ...APP_SOURCE.matchAll(/\bapp\.(get|post|patch|delete|put|all|options|head)\(\s*"([^"]+)"/g),
    ]
      .filter((match) => match[2] === path)
      .map((match) => (match[1] as string).toUpperCase());
    expect(registrations).toEqual(["GET"]);
  });

  test("(E-3) この口を叩いても付与表の行は1件も増えない", async () => {
    const before = await listed(
      `/api/apps/${APP_ID}/tables/case_grant/records`,
      actors.owner.cookie,
    );
    await get(DOOR("cases"), actors.owner.cookie);
    const after = await listed(
      `/api/apps/${APP_ID}/tables/case_grant/records`,
      actors.owner.cookie,
    );
    expect(after.total).toBe(before.total);
  });
});

// ---------------------------------------------------------------------------
// (F) ページング
// ---------------------------------------------------------------------------

describe("V7-M5-T02 (F): `limit` / `offset` を変えても件数が狂わない", () => {
  test("(F-1) 母集団は付与0件の行の集合(7件)であり、頁を継いでも重複も欠落も無い", async () => {
    const pages: string[] = [];
    for (let offset = 0; offset < 9; offset += 3) {
      const page = await listed(`${DOOR("cases")}?limit=3&offset=${offset}`, actors.owner.cookie);
      expect(page.total).toBe(7);
      pages.push(...page.ids);
    }
    expect(pages.sort()).toEqual([...orphans].sort());
    expect(new Set(pages).size).toBe(7);
  });

  test("(F-2) `limit` を変えても `total` は動かない", async () => {
    const measured: { limit: number; total: number; rows: number }[] = [];
    for (const limit of [1, 4, 100]) {
      const page = await listed(`${DOOR("cases")}?limit=${limit}`, actors.owner.cookie);
      measured.push({ limit, total: page.total, rows: page.ids.length });
    }
    expect(measured).toEqual([
      { limit: 1, total: 7, rows: 1 },
      { limit: 4, total: 7, rows: 4 },
      { limit: 100, total: 7, rows: 7 },
    ]);
  });

  test("(F-3) 母集団の外を指す `offset` は空の頁を返す(`total` は動かない)", async () => {
    const page = await listed(`${DOOR("cases")}?limit=3&offset=7`, actors.owner.cookie);
    expect({ rows: page.ids.length, total: page.total }).toEqual({ rows: 0, total: 7 });
  });
});

// ---------------------------------------------------------------------------
// (G) `Z-G18` の壁を迂回していない
// ---------------------------------------------------------------------------

describe("V7-M5-T02 (G): この口は `Z-G18` の壁を迂回していない", () => {
  test("(G-1) この口から取れた行を、運営が通常の単件 `GET` で取ろうとすると今日も 404", async () => {
    const listing = await listed(DOOR("cases"), actors.owner.cookie);
    expect(listing.ids.length).toBe(7);
    const measured: { via: string; status: number }[] = [];
    for (const id of listing.ids) {
      const single = await raw(
        `/api/apps/${APP_ID}/tables/cases/records/${id}`,
        actors.owner.cookie,
      );
      measured.push({ via: "単件 GET", status: single.status });
    }
    expect(measured).toEqual(listing.ids.map(() => ({ via: "単件 GET", status: 404 })));
    // **同じ行が、この口では 200 で取れている** —— **2つの応答を並べて突き合わせている。**
    const door = await raw(DOOR("cases"), actors.owner.cookie);
    expect(door.status).toBe(200);
  });

  test("(G-2) 通常の一覧 `GET` には、この口に並ぶ行が1件も出ない", async () => {
    const normal = await listed(`/api/apps/${APP_ID}/tables/cases/records`, actors.owner.cookie);
    for (const id of orphans) {
      expect(normal.ids).not.toContain(id);
    }
    // **運営に見えるのは「運営自身に付与された1行」だけである** —— **運営であることでは
    // なく、付与が在ることで見えている**(`Z-G18` 限定3: 運営ロールも例外にしない)。
    expect({ total: normal.total, ids: normal.ids }).toEqual({
      total: 1,
      ids: [grantedToOwner],
    });
  });
});

// ---------------------------------------------------------------------------
// (H) 付与を1件足すと消える
// ---------------------------------------------------------------------------

describe("V7-M5-T02 (H): 付与を1件足すと、その行はこの口から消える", () => {
  test("(H-1) 付与の前後で、その行の在り方が変わる(7 → 6)", async () => {
    const target = orphans[3] as string;
    const before = await listed(DOOR("cases"), actors.owner.cookie);
    expect(before.ids).toContain(target);
    grant("case_grant", { case: target, member: strangerMember, permission: "reader" });
    const after = await listed(DOOR("cases"), actors.owner.cookie);
    expect({ total: after.total, has: after.ids.includes(target) }).toEqual({
      total: 6,
      has: false,
    });
  });
});

// ---------------------------------------------------------------------------
// (I) ルート照合がぶつかっていない
// ---------------------------------------------------------------------------

describe("V7-M5-T02 (I): `unreachable-records` は `:record_id` として拾われない", () => {
  test("(I-1) この口の応答は一覧の形であり、単件 `GET` の形ではない", async () => {
    const response = await raw(DOOR("cases"), actors.owner.cookie);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect("records" in body).toBe(true);
    expect("record" in body).toBe(false);
  });

  test("(I-2) `/records/unreachable-records` は今日も単件 `GET` の 404 である(別のパス)", async () => {
    const response = await raw(
      `/api/apps/${APP_ID}/tables/cases/records/unreachable-records`,
      actors.owner.cookie,
    );
    expect(response.status).toBe(404);
    // **単件 `GET` のハンドラが答えている**(「エンドポイントがありません」ではない)。
    expect(response.body).not.toContain("に対応するエンドポイントはありません");
  });

  test("(I-3) 登録の全量に、両方のパスが別々に在る", () => {
    const routes = (app as unknown as { routes: { method: string; path: string }[] }).routes.map(
      (route) => `${route.method} ${route.path}`,
    );
    expect(routes).toContain("GET /api/apps/:app_id/tables/:table_id/records/:record_id");
    expect(routes).toContain("GET /api/apps/:app_id/tables/:table_id/unreachable-records");
  });
});

// ---------------------------------------------------------------------------
// (Y) **引き継ぎの穴を塞いだ** —— 差し戻し後に足した
// ---------------------------------------------------------------------------

describe("V7-M5-T02 (Y): 引き継ぎの親に付与が在る行は、この口に並ばない", () => {
  test("(Y-1) 並ばないことと、その行が他人からは 200 で読めることを、同じテストで並べる", async () => {
    // **他人(`strangerMember`)の口座は誰のセッションでもないので、`viewer` にも同じ
    // 親への付与を入れて「実際に読める人」を作る。**
    grant("case_grant", { case: grantedToStranger, member: members.viewer, permission: "reader" });
    const single = await raw(
      `/api/apps/${APP_ID}/tables/notes/records/${inheritingNote}`,
      actors.viewer.cookie,
    );
    const listing = await listed(DOOR("notes"), actors.owner.cookie);
    // **左: その行は viewer から読める(= 誰にも見えない行ではない)。**
    // **右: だからこの口には並ばない。**
    expect({
      viewerSingleGet: single.status,
      listedInDoor: listing.ids.includes(inheritingNote),
    }).toEqual({ viewerSingleGet: 200, listedInDoor: false });
  });

  test("(Y-1b) 運営はその行を通常の単件 `GET` では今日も読めない(壁は動いていない)", async () => {
    grant("case_grant", { case: grantedToStranger, member: members.viewer, permission: "reader" });
    const asOwner = await raw(
      `/api/apps/${APP_ID}/tables/notes/records/${inheritingNote}`,
      actors.owner.cookie,
    );
    const asViewer = await raw(
      `/api/apps/${APP_ID}/tables/notes/records/${inheritingNote}`,
      actors.viewer.cookie,
    );
    // **運営は 404、他人は 200。** **この口もその行を出さないので、運営がその行の中身へ
    // 届く道は今日1本も無い。**
    expect({ owner: asOwner.status, viewer: asViewer.status }).toEqual({ owner: 404, viewer: 200 });
    const listing = await listed(DOOR("notes"), actors.owner.cookie);
    expect(listing.ids).not.toContain(inheritingNote);
  });

  test("(Y-2) 3段(祖父 → 親 → 子)でも同じ —— 祖父に付与が在る孫は並ばない", async () => {
    const listing = await listed(DOOR("note_lines"), actors.owner.cookie);
    expect({
      inheriting: listing.ids.includes(inheritingLine),
      orphan: listing.ids.includes(orphanLine),
      total: listing.total,
    }).toEqual({ inheriting: false, orphan: true, total: 1 });
  });

  test("(Y-3) どの段にも付与が無い行は、今日どおり並ぶ(狭めすぎていない)", async () => {
    const notes = await listed(DOOR("notes"), actors.owner.cookie);
    const cases = await listed(DOOR("cases"), actors.owner.cookie);
    expect({
      notes: { ids: notes.ids, total: notes.total },
      caseTotal: cases.total,
    }).toEqual({ notes: { ids: [orphanNote], total: 1 }, caseTotal: 7 });
  });

  test("(Y-4) 循環があってもこの口は応答を返す(訪問済み集合。`Z-G16`)", async () => {
    const response = await raw(DOOR("nodes"), actors.owner.cookie);
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as ListBody;
    const ids = (body.records ?? []).map((row) => row._id as string);
    // **環の2行はどちらも付与が0件なので、どちらも並ぶ**(打ち切りにも拒否にもならない)。
    expect({ a: ids.includes(cycA), b: ids.includes(cycB) }).toEqual({ a: true, b: true });
  });

  test("(Y-4b) 環のどこかに付与を1件入れると、環の中の行は並ばなくなる", async () => {
    grant("node_grant", { node: cycA, member: strangerMember, permission: "reader" });
    const listing = await listed(DOOR("nodes"), actors.owner.cookie);
    expect({ a: listing.ids.includes(cycA), b: listing.ids.includes(cycB) }).toEqual({
      a: false,
      b: false,
    });
  });

  test("(Y-5) `st_public` と宣言の同居は適用時に拒否される(この場合分けは到達不能)", async () => {
    const otherRoot = await mkdtemp(join(tmpdir(), "gp-rao-pub-"));
    const store = KernelMetaStore.open(otherRoot);
    try {
      createApp(store, "公開と宣言の同居", { app_id: "public-mix" });
    } finally {
      store.close();
    }
    const mixed = {
      app: {
        id: "public-mix",
        name: "公開と宣言の同居",
        tables: [
          {
            id: "items",
            name: "品目",
            fields: [
              { id: "title", name: "題", type: "text", required: true },
              { id: "st_public", name: "公開", type: "boolean" },
            ],
            access_control: {
              enabled: true,
              permissions: [...PERMISSIONS],
              creator_permission: "writer",
              grant: {
                table: "item_grant",
                target: "item",
                member: "member",
                permission: "permission",
              },
              members: { table: "item_member", account: "account" },
            },
          },
          {
            id: "item_member",
            name: "利用者",
            fields: [{ id: "account", name: "ログイン", type: "text" }],
          },
          {
            id: "item_grant",
            name: "付与",
            fields: [
              { id: "item", name: "品目", type: "reference", reference_table: "items" },
              { id: "member", name: "相手", type: "reference", reference_table: "item_member" },
              { id: "permission", name: "権限", type: "select", options: ["reader", "writer"] },
            ],
          },
        ],
        views: [],
      },
    } as unknown as Manifest;
    const applied = applyManifest(otherRoot, "public-mix", mixed);
    expect(applied.valid).toBe(false);
    // **拒否の文面に `st_public` が名指しで出る**(何が同居できないかが利用者に分かる)。
    expect(JSON.stringify(applied)).toContain("st_public");
    await rm(otherRoot, { recursive: true, force: true });
  });

  test("(Y-6) 段数の上限に当たったら、要求全体が 400 になる(黙って落とさない)", async () => {
    const response = await raw(DOOR("deep_nodes"), actors.owner.cookie);
    // **7行の鎖の葉から辿ると段6 に進もうとするので、`Z-G17` の上限に当たる。**
    // **`V7-M4-T04` が単件・一覧で採った形にそろえて、要求全体を 400 にしている。**
    // **文面も `V7-M4-T04` が `errors.ts` に置いた1本で、この口が独自の文面を持たない。**
    expect(response.status).toBe(400);
    expect(response.body).toContain("たどる段数の上限に達しました");
    // **葉の行は「取り残しかどうか」を出せていない** —— **黙って一覧から落とすと、
    // 運営者には「取り残しは無い」と読めてしまう。**
    expect(response.body).not.toContain(deepLeaf);
  });
});

// ---------------------------------------------------------------------------
// (X) **測って「できていない」ことを記録する** —— 丸めない
// ---------------------------------------------------------------------------

describe("V7-M5-T02 (X): この口で解けていないもの(実測)", () => {
  test("(X-2) 付与の相手が消えた行は、この口に1件も並ばない", async () => {
    const listing = await listed(DOOR("cases"), actors.owner.cookie);
    expect(listing.ids).not.toContain(grantedToDeletedMember);
  });

  test("(X-2b) その行は、今日どの道から見つかるか(全部並べて測る)", async () => {
    const paths = [
      { via: "運営専用の口", ...(await raw(DOOR("cases"), actors.owner.cookie)) },
      {
        via: "通常の一覧 GET",
        ...(await raw(`/api/apps/${APP_ID}/tables/cases/records`, actors.owner.cookie)),
      },
      {
        via: "通常の単件 GET",
        ...(await raw(
          `/api/apps/${APP_ID}/tables/cases/records/${grantedToDeletedMember}`,
          actors.owner.cookie,
        )),
      },
      {
        via: "付与表の一覧 GET",
        ...(await raw(`/api/apps/${APP_ID}/tables/case_grant/records`, actors.owner.cookie)),
      },
    ];
    const measured = paths.map((entry) => ({
      via: entry.via,
      status: entry.status,
      // **行の中身(題)が応答に載っているか。** **`_id` は問い合わせに書いた値が
      // 404 の文面へそのまま反射するので、中身の有無とは別に下で測る。**
      showsTitle: entry.body.includes("相手が消えた案件"),
      showsId: entry.body.includes(grantedToDeletedMember),
    }));
    // **行の中身を返す道は1本も無い。** **付与表の一覧にだけ「その行を指す付与が
    // 在る」ことが残る** —— **中身は取れないが、`_id` は見つけられる。**
    expect(measured).toEqual([
      { via: "運営専用の口", status: 200, showsTitle: false, showsId: false },
      { via: "通常の一覧 GET", status: 200, showsTitle: false, showsId: false },
      // **単件 `GET` の 404 は、問い合わせに書いた `_id` を文面に反射する**(中身は出ない)。
      { via: "通常の単件 GET", status: 404, showsTitle: false, showsId: true },
      { via: "付与表の一覧 GET", status: 200, showsTitle: false, showsId: true },
    ]);
  });
});
