/**
 * **`V7-M5-T01` / `Z-G18`**: **付与が1件も無い行が、誰からも見えない。**
 *
 * **正は `docs/plan/v7/records/v7-m5.md` の `V7-M5-T01` と、
 * `docs/plan/v7/records/v7-m0.md` の §6-3 `Z-G18`(限定1〜7)/ §5-4 の (i)(ii)(iii) である。**
 *
 * ## **本ファイルの位置づけ —— 先に正直に書く**
 *
 * **完了条件 (i)(ii) の大半は、`V7-M3` と `V7-M4` が判定を8経路へ配線した時点で
 * すでに満たされていた。** **本ファイルはその「すでに満たされていた」を実測して固定し、
 * **1件も検査が無かった部分**(**完了条件 (iii) のページング**と、**未認証を含む5通りの
 * 生の応答**)を新しく足すものである。** **どこまでが既存の実装で、どこからが本ファイルの
 * 新規かは §(Z) の対照表に1件ずつ書いてある。**
 *
 * **【本ファイルが「実装した」と言えるものは1バイトも無い】** —— **`src/server/` の
 * 製品コードに1行も足していない。** **測って固定しただけである。**
 *
 * ## 測るもの
 *
 * - **(A)** **5通りの相手**(`owner` / `editor` / `viewer` / 宣言された種類 / **未認証**)で、
 *   **付与0件の行が一覧に1件も出ない。** **HTTP の生の応答(ステータス + 本文)を貼る形。**
 * - **(B)** **同じ5通りで単件 `GET`。** **【計画の文面と実測がずれる1点。丸めない】** ——
 *   **未認証だけは `404` ではなく `401` である**(認証の壁が判定より手前に立つ。`app.ts` の
 *   `recordsAuthMiddleware`)。**行は取れないが、応答コードは他の4通りと違う。**
 * - **(C)** **付与が1件でもあれば、その相手からは見える** —— **拒否側だけを測らない。**
 *   **未認証は付与を持ちようが無い**(付与は利用者表の行に結び付き、未認証には行が無い)。
 * - **(D)** **ページングの件数が狂わない**(完了条件 (iii))—— **`limit` / `offset` を変えて
 *   `total` と返る行数と `_id` の集合を照合し、**空のページが1つも生まれない**ことを測る。**
 * - **(E)** **宣言していない表と `enabled: false` の表は、今日と1バイトも変わらない。**
 * - **(F)** **`st_admin_readable` と同居できない**(`V7-M1-T05` の適用時検査)。
 *   **【`V8-M20` / `J-G30` / `ADR-0301` による更新】** **`st_admin_readable` は廃止された。**
 *   **同居を拒否する綴りは 2本 → 1本(`st_public` だけ)になった** ——
 *   **(F) は測る先を `st_public` に置き直してある**(消していない)。
 * - **(G)** **一覧 `GET` のどの分岐に入るか** —— **4本ある分岐のうち、宣言つきの表が
 *   **非スコープ分岐(DB 側の `LIMIT`/`OFFSET`)に落ちない**ことを、ふるまいと
 *   `app.ts` の分岐順序の両方で固定する。**
 * - **(H)** **付与表そのものは宣言つきの表ではない** —— **運営ロールが付与表を普通に
 *   一覧できることを実測し、そのうえで「自分に付与して開く」3つの道
 *   (**新しい付与 / 既存の付与の付け替え / 自分の口座を指す2本目の利用者行**)が
 *   今日すべて **403** で止まることを実測する。**
 *
 * ## 測らないもの(**誇張しない**)
 *
 * - **`MCP` の23本 / 受信口 / ワークフロー / コードの島は、今日も同じ行を読み書きできる**
 *   **【2026-08-16 訂正(`V8-M13-T04`)。直前の1行を1バイトも書き換えていない】この「23本」は今日は24本である**
 *   (`V8-M13-T02` が `read_report` を足した)。
 *   (`Z-G21`〜`Z-G24`。**判定を受ける経路は8本ちょうどである** = `Z-G18` 限定5)。
 * - **グループ経由で自分に付与できるかどうかは1件も測っていない** —— **本フィクスチャは
 *   グループ表を1つも宣言していない。** **付与の書込の判定そのものは `V7-M3-T03` の
 *   `src/server/access-control-grant-write.test.ts` の担当である。**
 * - **`GET /api/apps/:app_id/changelog` は行の値を1件も返さない**(返すのは差分の意図と
 *   スキーマ変更である)ので、本ファイルは測らない。**測っていないことは書く。**
 * - **性能は1件も測っていない**(判定は post-filter であり、全件をメモリに読む。
 *   `v7-m0.md` §5-4 (i) が引き受けた代償)。
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
import { validateManifestFull } from "../kernel/validate.ts";
import { createServerApp } from "./app.ts";
import { OWNER_FIELD, PUBLIC_FIELD, personalOwnerField } from "./owner-scope.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "case-depot";
const APP_SOURCE = readFileSync(new URL("./app.ts", import.meta.url).pathname, "utf8");
/**
 * **【`V8-M10-T02`(台帳 `Q-G16a`)が足した1本】** **母集団を決める判定の家。**
 * **一覧 GET の5分岐は今日この中に在る**(下の (G-1) が順序を固定する)。
 */
const OWNER_SCOPE_SOURCE = readFileSync(
  new URL("./owner-scope.ts", import.meta.url).pathname,
  "utf8",
);

/** 権限名2つ(`read` だけの名前と、`write` も持つ名前)。 */
const PERMISSIONS = [
  { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
  { id: "writer", name: "編集できる", read: true, write: true, delete: false },
] as const;

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "案件台帳",
      // **宣言された役割を1つ置く**(5通りの4人目)。
      // **【`V8-M29` 第2波】旧(逐語)**: `user_kinds: [{ id: "partner", name: "協力会社" }],`
      // **語彙 `app.user_kinds` は廃止された** —— **代わりに立つのは `app.roles`
      // (差分操作 `set_roles`)であり、宣言した独自の役割がそのまま「人に付けられる値」
      // になる。****`partner` に規則(`rules`)は1本も書かない** ——
      // **`withDefaultRoleRules` が規則を足すのは既定3役割だけなので、`partner` の面は
      // 旧(利用者の種類だった日)と同じく閉じたままである。**
      roles: [
        {
          id: "owner",
          name: "持ち主",
          // **【`V8-M28` / `T-G16a`】持ち主にはこの2行が必ず要る**(類型17 の拡張)——
          // **`withDefaultRoleRules` を通さずに `validateManifestFull(manifest())` を
          // 直に測る検査((F-1b) / (F-2))が在るので、題材の側に書いておく。**
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
          // **宣言つきの表。`st_owner` も `st_public` も `st_admin_readable` も1本も持たない。**
          // **【`V8-M20` / `J-G30`】`st_admin_readable` は廃止された** —— **上の1文は今日も
          // 真だが、3本目はもう「持てない」のではなく「予約規約フィールドではない」だけである。**
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
          // **宣言していない表**(オプトインの対照)。
          id: "plain",
          name: "掲示",
          fields: [{ id: "body", name: "本文", type: "text" }],
        },
        {
          // **`enabled: false` の表**(宣言はあるが効かない。`plain` と同じ形の項目を持たせ、
          // 応答の形が `plain` と食い違わないことを測れるようにする)。
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
          // **`st_owner` と `access_control` の両方を持つ表**(一覧 `GET` の**2本目**の
          // post-filter 分岐。**重ね順は AND** = `v7-m0.md` §5-4 (iv))。
          id: "dual",
          name: "個人所有かつ宣言つき",
          fields: [
            { id: "title", name: "題", type: "text", required: true },
            { id: OWNER_FIELD, name: "所有者", type: "text" },
          ],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "writer",
            grant: {
              table: "dual_grant",
              target: "dual",
              member: "member",
              permission: "permission",
            },
            members: { table: "case_member", account: "account" },
          },
        },
        {
          id: "dual_grant",
          name: "個人所有の付与",
          fields: [
            { id: "dual", name: "行", type: "reference", reference_table: "dual" },
            { id: "member", name: "相手", type: "reference", reference_table: "case_member" },
            { id: "permission", name: "権限", type: "select", options: ["reader", "writer"] },
          ],
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

/** **5通りの相手。** 4人は認証済み、5人目は未認証(cookie を1バイトも送らない)。 */
const SIGNED_IN = ["owner", "editor", "viewer", "partner"] as const;
type SignedIn = (typeof SIGNED_IN)[number];

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;
let actors: Record<SignedIn, ReturnType<typeof seedSession>>;
let members: Record<SignedIn, string>;
/** 付与0件の行3件 / 誰かに付与された行(他人の付与)1件。 */
let orphans: string[] = [];
let ownedByOther = "";
/** ページングの母集団(付与0件を混ぜた7行)。 */
let pageRows: string[] = [];
let grantedPageRows: string[] = [];
let plainRow = "";
let pausedRow = "";
/** `st_owner` と `access_control` を両方持つ表(AND の分岐)。 */
let dualVisible: string[] = [];
let dualHidden: string[] = [];

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

function grantTo(memberId: string, recordId: string, permission: string): void {
  const loaded = manifest();
  withDb((db) => {
    const created = createRecord(db, loaded, "case_grant", {
      case: recordId,
      member: memberId,
      permission,
    });
    expect(created.ok).toBe(true);
  });
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-rav-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "案件台帳", { app_id: APP_ID });
  } finally {
    store.close();
  }
  // **【`V8-M26`】既定が「閉じる」側へ倒れたので、題材へ既定3役割の規則を足す。**
  // **旧: `expect(applyManifest(dataRoot, APP_ID, manifest()).valid).toBe(true);`**
  //
  // **本ファイルの主題は「点(行ごとの付与)で行が見えるかどうか」であって面ではない。**
  // **`access_control` を宣言して**効かせている**2表(`cases` / `dual`)には1本も足さない** ——
  // **面と点は `OR` なので、そこへ面の規則を足すと点の測定が丸ごと無効になる。**
  // **足すのは土台の表だけである**(`plain` / `paused` / `case_member` / `case_grant` /
  // `dual_grant` / `paused_grant`)—— **どれも `Z-G18` の判定を受けない表であり、
  // 実アプリでは `add_table` の自動付与で同じ規則が必ず入る。**
  expect(
    applyManifest(
      dataRoot,
      APP_ID,
      withDefaultRoleRules(manifest(), { skipTables: ["cases", "dual"] }),
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
  pageRows = [];
  grantedPageRows = [];
  dualVisible = [];
  dualHidden = [];
  withDb((db) => {
    const caseRow = (title: string): string => {
      const created = createRecord(db, loaded, "cases", { title });
      expect(created.ok).toBe(true);
      return (created as { value: { _id: string } }).value._id;
    };
    // **付与0件の行を3件**(`Z-G18` の主題)。
    for (const title of [
      "だれの物でもない案件1",
      "だれの物でもない案件2",
      "だれの物でもない案件3",
    ]) {
      orphans.push(caseRow(title));
    }
    // **他人にだけ付与された行**(「付与0件」と「他人の行」を分けるため)。
    ownedByOther = caseRow("他人の案件");

    const plain = createRecord(db, loaded, "plain", { body: "宣言していない表" });
    expect(plain.ok).toBe(true);
    plainRow = (plain as { value: { _id: string } }).value._id;
    const paused = createRecord(db, loaded, "paused", { body: "enabled: false の表" });
    expect(paused.ok).toBe(true);
    pausedRow = (paused as { value: { _id: string } }).value._id;

    // **4人ともメンバー表に行を持つ** —— **「付与が無い」と「メンバー行が無い」を分ける。**
    for (const role of SIGNED_IN) {
      const created = createRecord(db, loaded, "case_member", { account: actors[role].userId });
      expect(created.ok).toBe(true);
      members[role] = (created as { value: { _id: string } }).value._id;
    }
    // **他人**(誰のセッションでもない利用者)。
    const stranger = createRecord(db, loaded, "case_member", { account: "someone-else" });
    expect(stranger.ok).toBe(true);
    const strangerId = (stranger as { value: { _id: string } }).value._id;
    const strangerGrant = createRecord(db, loaded, "case_grant", {
      case: ownedByOther,
      member: strangerId,
      permission: "writer",
    });
    expect(strangerGrant.ok).toBe(true);

    // **ページングの母集団**: **7行のうち4行に `viewer` への付与を入れ、3行は付与0件にする。**
    // **付与0件の行を「混ぜる」** —— 先頭・中間・末尾のどこにも来るように交互に並べる。
    for (let index = 0; index < 7; index += 1) {
      const id = caseRow(`頁${index}`);
      pageRows.push(id);
      if (index % 2 === 0 && grantedPageRows.length < 4) {
        grantedPageRows.push(id);
        const created = createRecord(db, loaded, "case_grant", {
          case: id,
          member: members.viewer,
          permission: "reader",
        });
        expect(created.ok).toBe(true);
      }
    }

    // **AND の分岐の母集団**: **`viewer` 所有3件(うち付与2件)+ 他人所有3件(うち付与1件)。**
    // **`viewer` に見えるのは「自分の行」かつ「付与のある行」の2件だけである。**
    const dual = (title: string, owner: string): string => {
      const created = createRecord(db, loaded, "dual", { title, [OWNER_FIELD]: owner });
      expect(created.ok).toBe(true);
      return (created as { value: { _id: string } }).value._id;
    };
    const dualGrant = (recordId: string): void => {
      const created = createRecord(db, loaded, "dual_grant", {
        dual: recordId,
        member: members.viewer,
        permission: "reader",
      });
      expect(created.ok).toBe(true);
    };
    const mine1 = dual("自分の行・付与あり1", actors.viewer.userId);
    const mine2 = dual("自分の行・付与あり2", actors.viewer.userId);
    const mine3 = dual("自分の行・付与なし", actors.viewer.userId);
    const theirs1 = dual("他人の行・付与あり", "someone-else");
    const theirs2 = dual("他人の行・付与なし1", "someone-else");
    const theirs3 = dual("他人の行・付与なし2", "someone-else");
    dualGrant(mine1);
    dualGrant(mine2);
    dualGrant(theirs1);
    dualVisible = [mine1, mine2];
    dualHidden = [mine3, theirs1, theirs2, theirs3];
  });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (A) 一覧 GET —— 5通りの相手すべてで、付与0件の行が1件も出ない
// ---------------------------------------------------------------------------

describe("V7-M5-T01 (A): 付与0件の行は、5通りの相手すべての一覧に出ない", () => {
  test("(A-1) 5通りの生の応答(ステータス + 本文)を並べる", async () => {
    const path = `/api/apps/${APP_ID}/tables/cases/records`;
    const measured = [
      { who: "owner", ...(await raw(path, actors.owner.cookie)) },
      { who: "editor", ...(await raw(path, actors.editor.cookie)) },
      { who: "viewer", ...(await raw(path, actors.viewer.cookie)) },
      { who: "partner(宣言された種類)", ...(await raw(path, actors.partner.cookie)) },
      { who: "未認証", ...(await raw(path)) },
    ];
    // **`viewer` だけはページングの母集団に付与を4件持っているので、その4件が並ぶ。**
    // **付与0件の3件と他人の1件は、5通りのどれにも1件も出ない。**
    expect(measured.map((entry) => ({ who: entry.who, status: entry.status }))).toEqual([
      { who: "owner", status: 200 },
      { who: "editor", status: 200 },
      { who: "viewer", status: 200 },
      { who: "partner(宣言された種類)", status: 200 },
      // **未認証は認証の壁で 401** —— **判定より手前で止まる。**
      { who: "未認証", status: 401 },
    ]);
    expect(measured[0]?.body).toBe('{"records":[],"total":0}');
    expect(measured[1]?.body).toBe('{"records":[],"total":0}');
    expect(measured[3]?.body).toBe('{"records":[],"total":0}');
    // **`viewer` の本文には、付与0件の行の `_id` が1件も現れない。**
    const viewerBody = measured[2]?.body ?? "";
    for (const id of [...orphans, ownedByOther]) {
      expect(viewerBody.includes(id)).toBe(false);
    }
    // **未認証の本文は認証の統一形式である(行の値を1バイトも含まない)。**
    const anonymousBody = measured[4]?.body ?? "";
    expect(anonymousBody.includes('"errors"')).toBe(true);
    for (const id of [...orphans, ownedByOther, ...pageRows]) {
      expect(anonymousBody.includes(id)).toBe(false);
    }
  });

  test("(A-2) 付与0件の行の `_id` は、どの相手の一覧本文にも1文字も現れない", async () => {
    const path = `/api/apps/${APP_ID}/tables/cases/records`;
    for (const role of SIGNED_IN) {
      const body = (await raw(path, actors[role].cookie)).body;
      for (const id of orphans) {
        expect({ role, id, leaked: body.includes(id) }).toEqual({ role, id, leaked: false });
      }
    }
  });

  test("(A-3) 他人にだけ付与された行も、付与を持たない相手には出ない(「0件」と「他人の行」を分ける)", async () => {
    const path = `/api/apps/${APP_ID}/tables/cases/records`;
    for (const role of SIGNED_IN) {
      const body = (await raw(path, actors[role].cookie)).body;
      expect({ role, leaked: body.includes(ownedByOther) }).toEqual({ role, leaked: false });
    }
  });
});

// ---------------------------------------------------------------------------
// (B) 単件 GET —— 5通りの相手すべてで取れない
// ---------------------------------------------------------------------------

describe("V7-M5-T01 (B): 付与0件の行の単件 GET は、5通りの相手すべてで取れない", () => {
  test("(B-1) 5通りの生の応答を並べる —— 認証済み4通りは 404、未認証だけ 401", async () => {
    const path = `/api/apps/${APP_ID}/tables/cases/records/${orphans[0]}`;
    const measured = [
      { who: "owner", ...(await raw(path, actors.owner.cookie)) },
      { who: "editor", ...(await raw(path, actors.editor.cookie)) },
      { who: "viewer", ...(await raw(path, actors.viewer.cookie)) },
      { who: "partner(宣言された種類)", ...(await raw(path, actors.partner.cookie)) },
      { who: "未認証", ...(await raw(path)) },
    ];
    // **【計画の文面(「単件 GET が 404」)と実測がずれる1点。丸めない】** ——
    // **未認証は 401 である。** **行は取れないが、応答コードは他の4通りと違う。**
    // **理由: `recordsAuthMiddleware` が判定より手前に立つからである**
    // (宣言した表に `st_public` は同居できないので、匿名公開の窓も開かない)。
    expect(measured.map((entry) => ({ who: entry.who, status: entry.status }))).toEqual([
      { who: "owner", status: 404 },
      { who: "editor", status: 404 },
      { who: "viewer", status: 404 },
      { who: "partner(宣言された種類)", status: 404 },
      { who: "未認証", status: 401 },
    ]);
    // **404 の本文は「その行が無い」と言うだけで、行の値を1バイトも含まない。**
    for (const entry of measured) {
      expect(entry.body.includes("だれの物でもない")).toBe(false);
    }
  });

  test("(B-2) 3件とも、認証済み4通りすべてで 404 である(1件だけの偶然ではない)", async () => {
    for (const id of orphans) {
      for (const role of SIGNED_IN) {
        const response = await get(
          `/api/apps/${APP_ID}/tables/cases/records/${id}`,
          actors[role].cookie,
        );
        expect({ id, role, status: response.status }).toEqual({ id, role, status: 404 });
      }
    }
  });

  test("(B-3) 存在しない `_id` の応答と本文が1バイトも違わない(在ることが漏れない)", async () => {
    const real = await raw(
      `/api/apps/${APP_ID}/tables/cases/records/${orphans[0]}`,
      actors.owner.cookie,
    );
    const fake = await raw(
      `/api/apps/${APP_ID}/tables/cases/records/rec_does_not_exist`,
      actors.owner.cookie,
    );
    expect(real.status).toBe(fake.status);
    // **本文は `_id` の文字列だけが違う** —— その1点を除けば同じ形である。
    expect(real.body.replace(orphans[0] ?? "", "X")).toBe(
      fake.body.replace("rec_does_not_exist", "X"),
    );
  });
});

// ---------------------------------------------------------------------------
// (C) 付与が1件でもあれば見える —— 拒否側だけを測ると、全部拒否しても緑になる
// ---------------------------------------------------------------------------

describe("V7-M5-T01 (C): 付与を1件入れれば、その相手からは見える", () => {
  test("(C-1) 認証済み4通りとも、付与を入れた瞬間に一覧と単件に出る", async () => {
    const target = orphans[0] as string;
    for (const role of SIGNED_IN) {
      // 付与の前(0件)。
      const before = await get(
        `/api/apps/${APP_ID}/tables/cases/records/${target}`,
        actors[role].cookie,
      );
      expect({ role, status: before.status }).toEqual({ role, status: 404 });

      grantTo(members[role] as string, target, "reader");

      const after = await raw(
        `/api/apps/${APP_ID}/tables/cases/records/${target}`,
        actors[role].cookie,
      );
      expect({ role, status: after.status }).toEqual({ role, status: 200 });
      expect(after.body.includes("だれの物でもない案件1")).toBe(true);

      const list = (await get(`/api/apps/${APP_ID}/tables/cases/records`, actors[role].cookie).then(
        (response) => response.json(),
      )) as { records: { _id: string }[]; total: number };
      expect({ role, hit: list.records.some((record) => record._id === target) }).toEqual({
        role,
        hit: true,
      });
      // **付与を入れたのは1行だけである** —— **残り2件の付与0件の行は今日も出ない。**
      for (const other of orphans.slice(1)) {
        expect({ role, leaked: list.records.some((record) => record._id === other) }).toEqual({
          role,
          leaked: false,
        });
      }
    }
  });

  test("(C-2) 未認証は付与を持ちようが無い(付与は利用者表の行に結び付く)", async () => {
    // **利用者表に「未認証」を表す行は作れない** —— `members.account` に入れる actor の id が
    // 存在しないからである。**したがって未認証について「付与があれば見える」は測れない。**
    // **測れないことを黙って落とさず、ここに固定する。**
    const target = orphans[0] as string;
    grantTo(members.owner as string, target, "reader");
    const response = await raw(`/api/apps/${APP_ID}/tables/cases/records/${target}`);
    expect(response.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// (D) ページング —— 完了条件 (iii)。**可視集合を母集団にする**
// ---------------------------------------------------------------------------

describe("V7-M5-T01 (D): ページングの件数が狂わない(付与0件の行を混ぜる)", () => {
  /** 一覧を1ページ取る。 */
  async function page(
    cookie: string,
    query: string,
  ): Promise<{ ids: string[]; total: number; status: number }> {
    const response = await get(`/api/apps/${APP_ID}/tables/cases/records${query}`, cookie);
    const body = (await response.json()) as { records: { _id: string }[]; total: number };
    return {
      status: response.status,
      ids: body.records.map((record) => record._id),
      total: body.total,
    };
  }

  test("(D-1) 母集団は可視集合である —— `total` は付与のある4件で、全体の11件ではない", async () => {
    const all = await page(actors.viewer.cookie, "");
    expect(all.status).toBe(200);
    expect(all.total).toBe(4);
    expect(all.ids.sort()).toEqual([...grantedPageRows].sort());
    // **表には11行ある**(付与0件3 + 他人1 + 頁7)—— **`total` はその数ではない。**
    const everything = withDb(
      (db) => (db.query("SELECT COUNT(*) AS n FROM cases").get() as { n: number }).n,
    );
    expect(everything).toBe(11);
    expect(all.total).not.toBe(everything);
  });

  test("(D-2) `limit=2` で3ページ取ると、2件 + 2件 + 0件で、集合が可視集合と一致する", async () => {
    const pages = [
      await page(actors.viewer.cookie, "?limit=2&offset=0"),
      await page(actors.viewer.cookie, "?limit=2&offset=2"),
      await page(actors.viewer.cookie, "?limit=2&offset=4"),
    ];
    expect(pages.map((entry) => ({ count: entry.ids.length, total: entry.total }))).toEqual([
      { count: 2, total: 4 },
      { count: 2, total: 4 },
      // **4件目の次のページは空である** —— **これは `total` と一致した「終わり」であって、
      // 「見えない行を数えたうえで落とした穴」ではない。**
      { count: 0, total: 4 },
    ]);
    const collected = pages.flatMap((entry) => entry.ids);
    expect(collected.sort()).toEqual([...grantedPageRows].sort());
    // **重複が1件も無い。**
    expect(new Set(collected).size).toBe(collected.length);
  });

  test("(D-3) 空のページが1つも生まれない —— `total` 未満の `offset` は必ず1件以上返す", async () => {
    const total = (await page(actors.viewer.cookie, "?limit=1&offset=0")).total;
    expect(total).toBe(4);
    for (let offset = 0; offset < total; offset += 1) {
      const one = await page(actors.viewer.cookie, `?limit=1&offset=${offset}`);
      expect({ offset, count: one.ids.length, total: one.total }).toEqual({
        offset,
        count: 1,
        total,
      });
    }
    // **`total` ちょうどの `offset` で初めて空になる。**
    expect((await page(actors.viewer.cookie, `?limit=1&offset=${total}`)).ids).toEqual([]);
  });

  test("(D-4) 1件ずつ辿った集合が、まとめて取った集合と1件も食い違わない", async () => {
    const all = await page(actors.viewer.cookie, "");
    const walked: string[] = [];
    for (let offset = 0; offset < all.total; offset += 1) {
      walked.push(...(await page(actors.viewer.cookie, `?limit=1&offset=${offset}`)).ids);
    }
    expect(walked).toEqual(all.ids);
  });

  test("(D-5) 付与が1件も無い相手は、どの `offset` でも 0件で `total` も 0 である", async () => {
    for (const query of ["", "?limit=2&offset=0", "?limit=2&offset=2", "?offset=0"]) {
      const entry = await page(actors.owner.cookie, query);
      expect({ query, count: entry.ids.length, total: entry.total }).toEqual({
        query,
        count: 0,
        total: 0,
      });
    }
  });

  test("(D-6) `limit` が母集団より大きくても `total` は可視集合のままである", async () => {
    const entry = await page(actors.viewer.cookie, "?limit=100&offset=0");
    expect({ count: entry.ids.length, total: entry.total }).toEqual({ count: 4, total: 4 });
  });

  // -------------------------------------------------------------------------
  // **一覧 `GET` の post-filter 分岐は2本ある。** **`st_owner` を併せ持つ表の側も測る** ——
  // **1本だけ測ると、もう1本が非スコープ分岐に落ちても緑のままになる。**
  // -------------------------------------------------------------------------

  async function dualPage(
    cookie: string,
    query: string,
  ): Promise<{ ids: string[]; total: number; status: number }> {
    const response = await get(`/api/apps/${APP_ID}/tables/dual/records${query}`, cookie);
    const body = (await response.json()) as { records: { _id: string }[]; total: number };
    return {
      status: response.status,
      ids: body.records.map((record) => record._id),
      total: body.total,
    };
  }

  test("(D-7) `st_owner` と併せ持つ表では、自分の行かつ付与のある行だけが `total` に入る(AND)", async () => {
    const entry = await dualPage(actors.viewer.cookie, "");
    expect(entry.status).toBe(200);
    expect(entry.total).toBe(2);
    expect(entry.ids.sort()).toEqual([...dualVisible].sort());
    for (const id of dualHidden) {
      expect({ id, leaked: entry.ids.includes(id) }).toEqual({ id, leaked: false });
    }
  });

  test("(D-8) その分岐でも `limit` / `offset` を変えて空のページが生まれない", async () => {
    const total = (await dualPage(actors.viewer.cookie, "?limit=1&offset=0")).total;
    expect(total).toBe(2);
    const walked: string[] = [];
    for (let offset = 0; offset < total; offset += 1) {
      const one = await dualPage(actors.viewer.cookie, `?limit=1&offset=${offset}`);
      expect({ offset, count: one.ids.length, total: one.total }).toEqual({
        offset,
        count: 1,
        total,
      });
      walked.push(...one.ids);
    }
    expect(walked.sort()).toEqual([...dualVisible].sort());
    expect((await dualPage(actors.viewer.cookie, `?limit=1&offset=${total}`)).ids).toEqual([]);
  });

  test("(D-9) 付与を1件も持たない運営ロールは、その表でも 0件 / `total` 0 である", async () => {
    for (const role of ["owner", "editor"] as const) {
      const entry = await dualPage(actors[role].cookie, "?limit=2&offset=0");
      expect({ role, count: entry.ids.length, total: entry.total }).toEqual({
        role,
        count: 0,
        total: 0,
      });
    }
  });

  test("(D-10) その表の付与0件の行は、単件 GET でも運営ロールに 404 である", async () => {
    for (const id of dualHidden) {
      const response = await get(
        `/api/apps/${APP_ID}/tables/dual/records/${id}`,
        actors.owner.cookie,
      );
      expect({ id, status: response.status }).toEqual({ id, status: 404 });
    }
  });
});

// ---------------------------------------------------------------------------
// (E) 宣言していない表 / `enabled: false` の表 —— 今日と1バイトも変わらない
// ---------------------------------------------------------------------------

describe("V7-M5-T01 (E): 宣言していない表と `enabled: false` の表は今日どおり", () => {
  test("(E-1) 予約3ロールは、どちらの表も全行を読める(付与を1件も持たない相手でも)", async () => {
    for (const role of ["owner", "editor", "viewer"] as const) {
      for (const [tableId, rowId] of [
        ["plain", plainRow],
        ["paused", pausedRow],
      ] as const) {
        const entry = await raw(
          `/api/apps/${APP_ID}/tables/${tableId}/records`,
          actors[role].cookie,
        );
        expect({ role, tableId, status: entry.status }).toEqual({ role, tableId, status: 200 });
        expect({ role, tableId, hit: entry.body.includes(rowId) }).toEqual({
          role,
          tableId,
          hit: true,
        });
      }
    }
  });

  test("(E-2) 単件 GET も 200 のままである(判定が1バイトも掛からない)", async () => {
    for (const [tableId, rowId] of [
      ["plain", plainRow],
      ["paused", pausedRow],
    ] as const) {
      const entry = await raw(
        `/api/apps/${APP_ID}/tables/${tableId}/records/${rowId}`,
        actors.owner.cookie,
      );
      expect({ tableId, status: entry.status }).toEqual({ tableId, status: 200 });
    }
  });

  test("(E-3) `enabled: false` の表の応答は、宣言していない表の応答と形が1バイトも違わない", async () => {
    const plain = await raw(`/api/apps/${APP_ID}/tables/plain/records`, actors.owner.cookie);
    const paused = await raw(`/api/apps/${APP_ID}/tables/paused/records`, actors.owner.cookie);
    expect(plain.status).toBe(paused.status);
    // **違うのは行の `_id` / 作成時刻 / 本文の値だけである**(それはフィクスチャの差である)
    // —— **キーの並びも `total` も、`access_control` の宣言に由来する差が1つも無い。**
    // **とくに `access_control` 由来の項目が応答に1つも増えていない。**
    const shapeOf = (body: string): unknown => {
      const parsed = JSON.parse(body) as { records: Record<string, unknown>[]; total: number };
      return {
        total: parsed.total,
        keys: parsed.records.map((record) => Object.keys(record).sort()),
      };
    };
    expect(shapeOf(paused.body)).toEqual(shapeOf(plain.body));
  });

  // **【`V8-M27-T04` / `T-G5`。期待値を反転させた。旧のテスト名と旧の期待値を逐語で残す】**
  // **旧: `(E-4) 宣言された種類には、どちらの表も今日どおり 403 である(運営テーブル)` /
  //       `expect({ tableId, status: entry.status }).toEqual({ tableId, status: 403 });`**
  // **根拠**: **`V8-M27` / 台帳 `T-G5` / ユーザ決定 `D-V8-38`。**
  // **`nonAdminTableAccess` を撤去した** —— **読取は今日 403 で断らない
  // (`ADR-0305` 限定11: 一覧は 200 + 応答から落とす)。**
  // **この (E) 群の主題(「宣言していない表と `enabled: false` の表は同じ扱い」)は
  // 1ミリも変わっていない** —— **2つの表の応答が今日も同じであることを測り続ける。**
  test("(E-4 の反転) 宣言された種類には、どちらの表も同じ応答である(403 ではなく 200 + 0件)", async () => {
    for (const tableId of ["plain", "paused"] as const) {
      const entry = await raw(
        `/api/apps/${APP_ID}/tables/${tableId}/records`,
        actors.partner.cookie,
      );
      expect({ tableId, status: entry.status }).toEqual({ tableId, status: 200 });
      expect({
        tableId,
        rows: (JSON.parse(entry.body) as { records: unknown[] }).records.length,
      }).toEqual({ tableId, rows: 0 });
    }
  });

  test("(E-5) 未認証には、どちらの表も今日どおり 401 である", async () => {
    for (const tableId of ["plain", "paused"] as const) {
      const entry = await raw(`/api/apps/${APP_ID}/tables/${tableId}/records`);
      expect({ tableId, status: entry.status }).toEqual({ tableId, status: 401 });
    }
  });

  test("(E-6) `paused` は今日「宣言していない表」と同じ分岐に入る(`personalOwnerField` も無い)", () => {
    const loaded = manifest();
    const paused = loaded.app.tables.find((table) => table.id === "paused");
    if (paused === undefined) {
      throw new Error("フィクスチャに `paused` が無い");
    }
    expect(personalOwnerField(paused)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (F) 「書けるが効かない」項目との同居 —— 適用時に拒否される(`V7-M1-T05` の実装)
// ---------------------------------------------------------------------------
//
// **【`V8-M20` / `J-G30` / `ADR-0301` による置き直し。検査は1本も消していない】**
//
// **着手前、この節の見出しと3本の検査は `st_admin_readable` を測っていた。**
// **`st_admin_readable` は `V8-M20` が廃止した**ので、**同居を拒否する綴りは
// `src/kernel/referential-integrity.ts` の `ACCESS_CONTROL_EXCLUSIVE_FIELDS` から1本落ち、
// 逐語 `["st_admin_readable", "st_public"]` → `["st_public"]` になった**(拒否の通り数 2 → 1)。
//
// **`Z-G18` 限定4 が守っているのは「アクセス権管理と、**書けるが効かない**見せ方の設定を
// 同居させない」という不変条件であって、`st_admin_readable` という綴りではない。**
// **その不変条件は今日も生きている**(担い手が `st_public` 1本になっただけ)ので、
// **測る先を `st_public` へ置き直した。** **旧の検査名は下の各 `test` のコメントに逐語で残す。**

describe("V7-M5-T01 (F): 「書けるが効かない」項目とは同居できない(`Z-G18` 限定4)", () => {
  /**
   * **既存の実測は `src/server/access-control-role-precedence.test.ts` の (D2) に在る。**
   * **本ファイルでも独立に測る** —— **`Z-G18` の限定4 は本タスクの完了条件だからであり、
   * 他ファイルの緑に依存させないためである。**
   */
  test("(F-1) 宣言つきの表に `st_public` を足した差分は、適用時に拒否される", () => {
    // **旧: `test("(F-1) 宣言つきの表に `st_admin_readable` を足した差分は、適用時に拒否される")`。**
    // **旧の本体は `{ id: ADMIN_READABLE_FIELD, name: "運営可視", type: "boolean" }` を足していた。**
    const broken = manifest();
    const cases = broken.app.tables.find((table) => table.id === "cases");
    expect(cases).toBeDefined();
    (cases as { fields: unknown[] }).fields.push({
      id: PUBLIC_FIELD,
      name: "公開",
      type: "boolean",
    });
    const result = validateManifestFull(broken);
    expect(result.valid).toBe(false);
    // **差分全体が拒否される**(`Z-G9` 限定3)—— **理由が1件以上返る。**
    expect(result.valid ? [] : result.errors).not.toHaveLength(0);
  });

  test("(F-1b)【`V8-M20` の代償。正直に書く】撤去した綴りは、足しても拒否されなくなった", () => {
    // **`st_admin_readable` は今日の語彙に無い** —— **予約規約フィールドではなく、
    // ただの boolean 項目である。** **したがってアクセス権管理と同居できてしまう。**
    // **これは「同居を拒否する関門が緩んだ」のではなく、**拒否する対象そのものが消えた**
    // ということである** —— **その表で `st_admin_readable` が何かを決めることは、もう無い。**
    // **【禁止の履行】「同居の問題は解決した」とは書かない。**
    const withRetired = manifest();
    const cases = withRetired.app.tables.find((table) => table.id === "cases");
    expect(cases).toBeDefined();
    (cases as { fields: unknown[] }).fields.push({
      // **綴りを直に書く**(`ADMIN_READABLE_FIELD` は `owner-scope.ts` から消えている)。
      id: "st_admin_readable",
      name: "運営可視",
      type: "boolean",
    });
    expect(validateManifestFull(withRetired).valid).toBe(true);
  });

  test("(F-2) 同居していない今日の宣言は valid である(対照)", () => {
    expect(validateManifestFull(manifest()).valid).toBe(true);
  });

  test("(F-3) 拒否しているのは `src/kernel/referential-integrity.ts` である(本タスクの実装ではない)", async () => {
    // **旧: `expect(source.includes(ADMIN_READABLE_FIELD)).toBe(true);`** ——
    // **綴りが `st_public` に置き換わっただけで、見ているものは同じである。**
    const source = await Bun.file(
      new URL("../kernel/referential-integrity.ts", import.meta.url).pathname,
    ).text();
    expect(source.includes(`["${PUBLIC_FIELD}"]`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (G) 一覧 GET のどの分岐に入るか —— 非スコープ分岐へ落ちないことを固定する
// ---------------------------------------------------------------------------

describe("V7-M5-T01 (G): 宣言つきの表は、非スコープ分岐(DB の LIMIT/OFFSET)に落ちない", () => {
  // **【`V8-M10-T02`(台帳 `Q-G16a`)による更新。旧の中身を1バイトも消していない】**
  //
  // **旧のテスト名**: `test("(G-1) 一覧 GET には4本の分岐が在り、非スコープ分岐が最後である
  // (順序を固定する)", …)`。
  // **旧の中身(逐語)**:
  //   `const lines = APP_SOURCE.split("\n");`
  //   `const anonymous = lineOf("      if (anonymousPublic) {");`
  //   `const owned = lineOf("      if (ownerField !== undefined) {");`
  //   `const declared = lineOf("      if (accessSources !== undefined) {");`
  //   `const unscoped = lineOf("      const total = readRecordCountAndSum(source, manifest, tableId, {");`
  //   `expect(anonymous < owned && owned < declared && declared < unscoped).toBe(true);`
  //
  // **理由は「実物が変わった」側である**(「数え方が古くなった」ではない)——
  // **4本の `if` は `app.ts` から消え、`owner-scope.ts` の `recordPopulationScope` の中に
  // 同じ順序で在る。** **`app.ts` の側で行番号を数えても、今日は分岐が1本も見つからない。**
  //
  // **【緩めていない。見る場所を実物に合わせ、条件つき読取の1本を足した】** ——
  // **守っているものは1ミリも変わらない**: **宣言つきの表(匿名公開 / 個人スコープ /
  // 行アクセス権 / 条件つき読取)は、非スコープ(DB の `LIMIT` / `OFFSET`)より手前で
  // 答えが決まる。** **順序が入れ替われば、今日もここが赤くなる。**
  test("(G-1) 母集団の分類には4本の分岐が在り、非スコープ(絞り不要)が最後である(順序を固定する)", () => {
    const lines = OWNER_SCOPE_SOURCE.split("\n");
    const lineOf = (needle: string): number => {
      const index = lines.findIndex((line) => line.includes(needle));
      expect({ needle, found: index >= 0 }).toEqual({ needle, found: true });
      return index + 1;
    };
    const anonymous = lineOf("  if (params.anonymousPublic) {");
    const owned = lineOf("  if (personalOwnerField(params.table) !== undefined) {");
    const declared = lineOf("  if (params.accessSources !== undefined) {");
    const conditional = lineOf("  if (params.tableRead.conditional) {");
    const unscoped = lineOf('  return "unfiltered";');
    // **宣言つきの表の分岐は、非スコープ(絞り不要)より手前にある。**
    // **順序が入れ替われば(= 非スコープが先に `return` すれば)ここが赤くなる。**
    expect(
      anonymous < owned && owned < declared && declared < conditional && conditional < unscoped,
    ).toBe(true);
    expect({ anonymous, owned, declared, conditional, unscoped }).toEqual({
      anonymous,
      owned,
      declared,
      conditional,
      unscoped,
    });
    // **`app.ts` の側は、その答えを受けて DB のページングを外すかだけを決める。**
    expect(APP_SOURCE.includes('const postFiltered = populationScope !== "unfiltered";')).toBe(
      true,
    );
  });

  test("(G-2) 宣言つきの表では `postFiltered` が真になり、DB の LIMIT/OFFSET を外す", () => {
    // **`postFiltered` の定義に `accessSources !== undefined` が入っていること** ——
    // **入っていないと、`limit` を付けた要求だけが DB 側で切られ、判定の前に行が落ちる
    // (= `total` が可視集合と食い違う)。**
    //
    // **【期待値を書き換えた理由: `V8-M18` / 台帳 `J-G12`】**
    // **旧の期待値は1行の逐語だった**:
    //   `"const postFiltered = anonymousPublic || ownerField !== undefined || accessSources !== undefined;"`
    // **`V8-M18` が4つ目の項(`roleTableRead.conditional` —— 役割に束ねた権限の**条件**が
    // 立っている表)を足したため、定義が複数行になった。** **条件つきの読取規則も SQL に
    // 落とせないので、同じ理由で DB の LIMIT/OFFSET を外す必要がある。**
    // **主張は1ミリも弱めていない** —— **`accessSources !== undefined` が入っていることは
    // 今日も見ており、あわせて4つの項が全部在ることを見る**(1つでも消えれば赤くなる)。
    // **【`V8-M10-T02`(台帳 `Q-G16a`)による更新。旧の中身を1バイトも消していない】**
    //
    // **旧の中身(逐語)**:
    //   `const definition = APP_SOURCE.slice(`
    //     `APP_SOURCE.indexOf("const postFiltered ="),`
    //     `APP_SOURCE.indexOf("const listQuery: ListRecordsOptions"),`
    //   `);`
    //   `expect(definition.includes("anonymousPublic")).toBe(true);`
    //   `expect(definition.includes("ownerField !== undefined")).toBe(true);`
    //   `expect(definition.includes("accessSources !== undefined")).toBe(true);`
    //   `expect(definition.includes("roleTableRead.conditional")).toBe(true);`
    //
    // **【これは「赤くなったから直した」のではない。緑のまま偽になっていたのを直した】**
    // **`V8-M10-T02` は `app.ts` に旧の定義を注釈として逐語で残した。** **旧の中身は
    // `indexOf` で**最初の**出現(= その注釈)を拾うので、実装が消えても緑のままになる。**
    // **`v8-m10.md` §1 `T03` の `2'` が禁じた「生まれた時点で偽の検査」と同じ形である。**
    //
    // **理由は「実物が変わった」側である** —— **4つの項は `owner-scope.ts` の
    // `recordPopulationScope` に在り、`app.ts` は「絞り不要でないこと」だけを見ている。**
    // **主張は1ミリも弱めていない** —— **4つの項が全部在ることを今日も見る**
    // (1つでも消えれば赤くなる)。
    const definition = OWNER_SCOPE_SOURCE.slice(
      OWNER_SCOPE_SOURCE.indexOf("export function recordPopulationScope("),
      OWNER_SCOPE_SOURCE.indexOf("export function judgeRecordPopulation("),
    );
    expect(definition.length).toBeGreaterThan(0);
    expect(definition.includes("params.anonymousPublic")).toBe(true);
    expect(definition.includes("personalOwnerField(params.table) !== undefined")).toBe(true);
    expect(definition.includes("params.accessSources !== undefined")).toBe(true);
    expect(definition.includes("params.tableRead.conditional")).toBe(true);
    // **`app.ts` はその答えを1つ見るだけで、4つの項を自分で組み直していない。**
    expect(APP_SOURCE.includes('const postFiltered = populationScope !== "unfiltered";')).toBe(
      true,
    );
  });

  test("(G-3) ふるまいでも非スコープ分岐に入っていない —— `limit` を付けても `total` が可視集合である", async () => {
    // **非スコープ分岐に入ると `total` は `readRecordCountAndSum`(= filter 後の全件 11)に
    // なる。** **可視集合の 4 が返っていることが、その分岐に入っていないことの実測である。**
    const response = await get(
      `/api/apps/${APP_ID}/tables/cases/records?limit=1&offset=0`,
      actors.viewer.cookie,
    );
    const body = (await response.json()) as { records: unknown[]; total: number };
    expect({ count: body.records.length, total: body.total }).toEqual({ count: 1, total: 4 });
  });

  test("(G-4) 判定式は `app.ts` に1件も無い(`ADR-0294` 限定12。`access_control` の綴りが0)", () => {
    expect(APP_SOURCE.split("access_control").length - 1).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (Z) 「すでに満たされていた」と「本ファイルが足した」の対照 —— 誇張しないための記録
// ---------------------------------------------------------------------------

describe("V7-M5-T01 (Z): 本タスクは製品コードを1バイトも足していない", () => {
  test("(Z-1) 一覧 GET / 単件 GET の判定は `V7-M3` が置いたものである(呼び出しが今日も在る)", () => {
    // **本ファイルが実装したのではない** —— **その呼び出しが `app.ts` に在ることを確かめて
    // 固定するだけである。** **消えたら赤くなる。**
    expect(APP_SOURCE.includes("const judge = recordAccessJudge(")).toBe(true);
    expect(APP_SOURCE.includes("recordAccessSourceTables(manifest, tableId)")).toBe(true);
  });

  test("(Z-2) ページングを可視集合から切っているのも既存の実装である(`slicePage(visible,`)", () => {
    // **`total: visible.length` と `slicePage(visible, limit, offset)` が同じ集合を使う。**
    // **母集団が構造的に一致することの、実装側の根拠である。**
    expect(APP_SOURCE.includes("slicePage(visible, limit, offset)")).toBe(true);
    expect(APP_SOURCE.includes("total: visible.length")).toBe(true);
  });

  test("(Z-3) 【正直に書く】判定を受ける経路は8本ちょうどで、MCP・受信口・ワークフロー・島は今日も素通りする", async () => {
    // **`Z-G18` 限定5 の逐語である。** **本ファイルはその5本を1件も測っていない。**
    // **「誰からも見えない」と書けるのは HTTP の8経路についてだけである。**
    const source = await Bun.file(new URL("./owner-scope.ts", import.meta.url).pathname).text();
    expect(source.includes("judgeRecordAccess")).toBe(true);
    const mcp = await Bun.file(new URL("../mcp/server.ts", import.meta.url).pathname).text();
    expect(mcp.includes("judgeRecordAccess")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (H) 正直に残る限界 —— 運営ロールは「自分に付与する」ことで行を開ける
// ---------------------------------------------------------------------------

describe("V7-M5-T01 (H): 付与表そのものは宣言つきの表ではない(限界の実測)", () => {
  async function post(
    path: string,
    cookie: string,
    values: Record<string, unknown>,
  ): Promise<Response> {
    return await app.request(path, {
      method: "POST",
      headers: { cookie, origin: TEST_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify(values),
    });
  }

  test("(H-1) 運営ロールは付与表を普通に一覧できる(付与表に判定は掛からない)", async () => {
    const response = await raw(
      `/api/apps/${APP_ID}/tables/case_grant/records`,
      actors.owner.cookie,
    );
    expect(response.status).toBe(200);
    // **他人に付与された行の `_id` は、付与表の側から読める。**
    // **【正直に書く】付与0件の行は付与表に1行も現れないので、この経路では出てこない。**
    // **しかし「他人に付与された行が在ること」は、行の中身抜きで運営ロールに漏れている。**
    expect(response.body.includes(ownedByOther)).toBe(true);
    for (const id of orphans) {
      expect({ id, leaked: response.body.includes(id) }).toEqual({ id, leaked: false });
    }
  });

  test("(H-2) 【限界】運営ロールが自分に付与を作ると、その行が見えるようになる", async () => {
    const target = orphans[0] as string;
    const before = await get(
      `/api/apps/${APP_ID}/tables/cases/records/${target}`,
      actors.owner.cookie,
    );
    expect(before.status).toBe(404);

    const created = await post(
      `/api/apps/${APP_ID}/tables/case_grant/records`,
      actors.owner.cookie,
      {
        case: target,
        member: members.owner,
        permission: "reader",
      },
    );
    const createdBody = await created.text();
    const after = await get(
      `/api/apps/${APP_ID}/tables/cases/records/${target}`,
      actors.owner.cookie,
    );
    // **実測をそのまま貼る** —— **付与の作成が通るかどうかが、この限界の有無を決める。**
    // **実測**: **自分への付与は 403 で止まる**(`Z-G5` / `V7-M3-T03` が
    // 「自分に権限を付けることはできません」を返す)。**行は今日も 404 のままである。**
    expect({ create: created.status, read: after.status }).toEqual({ create: 403, read: 404 });
    expect(createdBody.includes("自分に権限を付けることはできません")).toBe(true);
  });
});

describe("V7-M5-T01 (H2): 既存の付与を自分に付け替えても開かない", () => {
  test("(H-3) 他人への付与を PATCH で自分に付け替えようとすると止まる", async () => {
    // 他人へ付与された行の付与行を引く。
    const list = (await get(
      `/api/apps/${APP_ID}/tables/case_grant/records`,
      actors.owner.cookie,
    ).then((response) => response.json())) as {
      records: { _id: string; case: string; _updated_at: string }[];
    };
    const grantRow = list.records.find((record) => record.case === ownedByOther);
    if (grantRow === undefined) {
      throw new Error("他人への付与行がフィクスチャに無い");
    }

    const response = await app.request(
      `/api/apps/${APP_ID}/tables/case_grant/records/${grantRow._id}`,
      {
        method: "PATCH",
        headers: {
          cookie: actors.owner.cookie,
          origin: TEST_ORIGIN,
          "content-type": "application/json",
          "if-match": grantRow._updated_at,
        },
        body: JSON.stringify({ member: members.owner }),
      },
    );
    const body = await response.text();
    const after = await get(
      `/api/apps/${APP_ID}/tables/cases/records/${ownedByOther}`,
      actors.owner.cookie,
    );
    // **実測**: **付け替えも 403 で止まる。** **行は今日も 404 のままである。**
    expect({ patch: response.status, read: after.status }).toEqual({ patch: 403, read: 404 });
    expect(body.includes("自分に権限を付けることはできません")).toBe(true);
  });

  test("(H-4) 自分の口座を指す利用者行を2本目に作って迂回することもできない", async () => {
    // **同じ人のメンバー行が複数あることを規約は止めていない**(`v7-m0.md` §5-2 (d))——
    // **その2本目を経由して自分に付与できてしまうと、`Z-G18` が迂回できることになる。**
    const target = orphans[1] as string;
    const second = await app.request(`/api/apps/${APP_ID}/tables/case_member/records`, {
      method: "POST",
      headers: {
        cookie: actors.owner.cookie,
        origin: TEST_ORIGIN,
        "content-type": "application/json",
      },
      body: JSON.stringify({ account: actors.owner.userId }),
    });
    expect(second.status).toBe(201);
    const secondId = ((await second.json()) as { record: { _id: string } }).record._id;

    const created = await app.request(`/api/apps/${APP_ID}/tables/case_grant/records`, {
      method: "POST",
      headers: {
        cookie: actors.owner.cookie,
        origin: TEST_ORIGIN,
        "content-type": "application/json",
      },
      body: JSON.stringify({ case: target, member: secondId, permission: "reader" }),
    });
    const createdBody = await created.text();
    const after = await get(
      `/api/apps/${APP_ID}/tables/cases/records/${target}`,
      actors.owner.cookie,
    );
    // **実測**: **2本目の利用者行を経由しても 403 である**(付与の書込判定は、相手の
    // 利用者行を `account` まで解いてから「自分かどうか」を見ている)。**行は 404 のまま。**
    expect({ create: created.status, read: after.status }).toEqual({ create: 403, read: 404 });
    expect(createdBody.includes("自分に権限を付けることはできません")).toBe(true);
  });
});
