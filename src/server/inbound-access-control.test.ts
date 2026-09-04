/**
 * **受信口(`POST /inbound/:endpoint_id`)にアクセス権の判定を配線したことの検査**
 * (`V8-M21`。台帳 `J-G21` の限定採用 / ユーザ決定 `D-V8-18` / メインの裁定 `R-8`)。
 *
 * ## 台帳 `J-G21` の限定の逐語(**これが仕様である**)
 *
 * > `src/server/inbound-route.ts` の作成直前1箇所。判定の家は `src/server/owner-scope.ts` の
 * > 既存1本。**主体は受信口が今日持っている1つに固定し、その主体がメンバー表に行を持つときだけ通す**
 *
 * **受信口が持っている主体は1つだけである**(`system:inbound`。`ADR-0041` 限定9 / `D-G4b`)——
 * **人間の主体は1つも無く、payload の名乗りは今日どおり採らない**(`inbound-owner-scope.test.ts`)。
 *
 * ## **先に認めること(隠さない。裁定 `R-8`)**
 *
 * - **これは fail-closed である。** **行ごとのアクセス権を宣言した表を書込先にしている
 *   受信口は、今日から 403 で止まる** —— **`system:inbound` のメンバー行を作るまで通らない。**
 * - **宣言していない表への受信は1ミリも変わらない**(オプトイン。下の (C) が固定する)。
 *
 * ## **この検査が測っていないもの(誇張しない)**
 *
 * - **【`V8-M21` の後半で偽になった。旧文を1バイトも消していない】** 旧の逐語:
 *   > **面(役割に束ねた権限。`app.roles[].rules`)は受信口に1バイトも掛けていない** ——
 *   > **`system:inbound` は認証アカウントではないので実効ロール集合を持たない。**
 *   > **掛けると、規則で名指しされた表への受信が「未ログイン扱い」で全部落ちる。**
 *   > **限定の逐語が要求しているのはメンバー表の1点だけである。**
 *
 *   **後半が面を掛けた。** **旧文が予告したとおりの帰結がそのまま起きる** ——
 *   **面が「役割 × 表 × 書込」を宣言した表への受信は、面の側からは決して通らない**
 *   (下の (F-5))。**通す道は点の側だけである**(参加者の表に `system:inbound` の行を作る)。
 *   **合成は `OR` なので、点が通せば今日どおり通る**(下の (F-6))。
 * - **受信で入った行に付与を1件も作らない** —— **入った行は誰からも読めないままである**
 *   (`D-V4-92` の逐語「解けないと書く」は今日も真である)。
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboundStore } from "../kernel/inbound-store.ts";
import {
  appDbPath,
  applyManifest,
  createApp,
  createRecord,
  KernelMetaStore,
  listRecords,
  type Manifest,
} from "../kernel/index.ts";
import { createServerApp } from "./app.ts";

const APP_ID = "inbound-guard";
const SIGNING_KEY = "test-inbound-guard-key";
const KEY_ENV_VAR = "ST_TEST_INBOUND_GUARD_KEY";

const PERMISSIONS = [
  { id: "keeper", name: "作った人", read: true, write: true, delete: true },
] as const;

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "受信の門",
      tables: [
        {
          // **行ごとのアクセス権を宣言した受信先**(判定が効く側)。
          id: "inbox",
          name: "受信箱",
          fields: [
            { id: "event_id", name: "イベントID", type: "text", required: true, unique: true },
            { id: "body", name: "本文", type: "text" },
          ],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "keeper",
            grant: {
              table: "inbox_grant",
              target: "inbox",
              member: "member",
              permission: "permission",
            },
            members: { table: "inbox_member", account: "account" },
          },
        },
        {
          // **宣言していない受信先**(オプトインの対照。今日どおり通る)。
          id: "open_inbox",
          name: "素の受信箱",
          fields: [
            { id: "event_id", name: "イベントID", type: "text", required: true, unique: true },
            { id: "body", name: "本文", type: "text" },
          ],
        },
        {
          id: "inbox_grant",
          name: "受信箱の付与",
          fields: [
            { id: "inbox", name: "行", type: "reference", reference_table: "inbox" },
            { id: "member", name: "相手", type: "reference", reference_table: "inbox_member" },
            { id: "permission", name: "権限", type: "select", options: ["keeper"] },
          ],
        },
        {
          id: "inbox_member",
          name: "参加者",
          fields: [{ id: "account", name: "ログイン", type: "text" }],
        },
        {
          // **【`V8-M21` の後半】面(役割の規則)だけを宣言した受信先。**
          // **点(行ごとのアクセス権)は1つも宣言していない。**
          id: "role_inbox",
          name: "役割で守る受信箱",
          fields: [
            { id: "event_id", name: "イベントID", type: "text", required: true, unique: true },
            { id: "body", name: "本文", type: "text" },
          ],
        },
        {
          // **【`D-V8-67`】持ち主(`owner`)に書込の規則が在る受信先。**
          // **点(行ごとのアクセス権)は1つも宣言していない** —— **面だけで通る道を測る。**
          id: "owner_inbox",
          name: "持ち主で守る受信箱",
          fields: [
            { id: "event_id", name: "イベントID", type: "text", required: true, unique: true },
            { id: "body", name: "本文", type: "text" },
          ],
        },
      ],
      views: [{ id: "inbox-list", type: "list_view", table: "inbox", columns: ["body"] }],
      // **【`V8-M21` の後半】面の宣言。** **規則を書いたのは `editor` だけである** ——
      // **受信の主体は役割を1つも持たないので、この表への受信は面の側からは通らない。**
      roles: [
        {
          id: "owner",
          name: "持ち主",
          // **【`D-V8-67`】受信口は「持ち主が書いている」として扱う** —— **持ち主に書込の
          // 規則が在る表へは、署名の正しい通知がそのまま入る。**
          // **`open_inbox` は (i-c) が「点はオプトインのまま」を測るために要る**
          // (点を1バイトも宣言せず、面だけで通す)。
          rules: [
            // **【`V8-M28` / `T-G16a`】持ち主にはこの2行が必ず要る**(類型17 の拡張)。
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
            { target: "table", table: "owner_inbox", can: ["write"] },
            { target: "table", table: "open_inbox", can: ["write"] },
          ],
        },
        {
          id: "editor",
          name: "編集者",
          rules: [{ target: "table", table: "role_inbox", can: ["write"] }],
        },
        { id: "viewer", name: "閲覧者" },
      ],
    },
  } as unknown as Manifest;
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;
let endpointId: string;
let openEndpointId: string;
/** **面だけを宣言した受信先**(`V8-M21` の後半)。 */
let roleEndpointId: string;
/** **持ち主(`owner`)に書込の規則が在る受信先**(`D-V8-67`)。 */
let ownerEndpointId: string;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-inbound-guard-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "受信の門", { app_id: APP_ID });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP_ID, manifest()).valid).toBe(true);
  process.env[KEY_ENV_VAR] = SIGNING_KEY;
  const inbound = InboundStore.openForKernel(dataRoot);
  try {
    endpointId = inbound.issueInboundEndpoint({
      appId: APP_ID,
      name: "guarded",
      secretSource: { kind: "env", value: KEY_ENV_VAR },
      targetTable: "inbox",
    }).id;
    openEndpointId = inbound.issueInboundEndpoint({
      appId: APP_ID,
      name: "open",
      secretSource: { kind: "env", value: KEY_ENV_VAR },
      targetTable: "open_inbox",
    }).id;
    roleEndpointId = inbound.issueInboundEndpoint({
      appId: APP_ID,
      name: "role-guarded",
      secretSource: { kind: "env", value: KEY_ENV_VAR },
      targetTable: "role_inbox",
    }).id;
    ownerEndpointId = inbound.issueInboundEndpoint({
      appId: APP_ID,
      name: "owner-ruled",
      secretSource: { kind: "env", value: KEY_ENV_VAR },
      targetTable: "owner_inbox",
    }).id;
  } finally {
    inbound.close();
  }
  app = createServerApp({ dataRoot });
});

afterEach(async () => {
  delete process.env[KEY_ENV_VAR];
  await rm(dataRoot, { recursive: true, force: true });
});

function signatureFor(rawBody: string): string {
  return `sha256=${createHmac("sha256", SIGNING_KEY).update(Buffer.from(rawBody, "utf-8")).digest("hex")}`;
}

/** **署名は正しい**要求を送る(止まるのが署名ではなく権限であることを分けて測るため)。 */
function postInbound(payload: Record<string, unknown>, target = endpointId): Promise<Response> {
  const rawBody = JSON.stringify(payload);
  return Promise.resolve(
    app.request(
      new Request(`http://localhost/inbound/${target}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Mock-PSP-Signature": signatureFor(rawBody),
        },
        body: rawBody,
      }),
    ),
  );
}

/** 表の行数を**本物の SQLite** から数える(HTTP の射影を通さない)。 */
function rowCount(tableId: string): number {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readonly: true });
  try {
    const result = listRecords(db, manifest(), tableId, {});
    return result.ok ? result.value.length : -1;
  } finally {
    db.close();
  }
}

/** **受信の主体をメンバー表に登録する**(= 権限を配る側の唯一の入口)。 */
function seedInboundMember(): void {
  const db = new Database(appDbPath(dataRoot, APP_ID));
  try {
    const created = createRecord(db, manifest(), "inbox_member", { account: "system:inbound" });
    expect(created.ok).toBe(true);
  } finally {
    db.close();
  }
}

// --- (i-a) 権限が無い相手として動いたとき、落ちる -----------------------------------

test("(i-a) 署名は正しいが権限が無い受信は 403 で止まり、1行も書かれない", async () => {
  const res = await postInbound({ event_id: "evt_1", body: "外から" });
  expect(res.status).toBe(403);
  const body = (await res.json()) as { errors: { message: string; hint?: string }[] };
  // **署名の失敗(401)と混ぜない** —— 文面が権限の話であることを固定する。
  expect(body.errors[0]?.message).toContain("アクセス権");
  expect(rowCount("inbox")).toBe(0);
});

// --- (i-b) 権限が在れば通る ----------------------------------------------------------

test("(i-b) 主体がメンバー表に行を持てば、同じ要求が 201 で通る", async () => {
  seedInboundMember();
  const res = await postInbound({ event_id: "evt_2", body: "外から" });
  expect(res.status).toBe(201);
  expect(rowCount("inbox")).toBe(1);
});

// --- (i-c) 宣言していない表は今日どおり(オプトイン)---------------------------------

test("(i-c) アクセス権を宣言していない表への受信は今日どおり 201 である", async () => {
  const res = await postInbound({ event_id: "evt_3", body: "素の受信" }, openEndpointId);
  /*
   * **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-58` / `D-V8-65`。期待値を反転させた】**
   *
   * **旧(逐語)**: **`expect(res.status).toBe(201);`** / **`expect(rowCount("open_inbox")).toBe(1);`**
   *
   * **この検査の名前が主張していた「オプトイン」は、今日は成り立たない。**
   * **点(行ごとのアクセス権)は今日もオプトインのままである** —— **`open_inbox` は
   * `access_control` を1バイトも宣言していないので、点は1度も掛からない。**
   * **しかし面(役割に束ねた権限)の既定が閉じたので、規則を1本も名指ししていない
   * `open_inbox` は面が拒否する。** **受信の主体は `anonymous` として評価され、
   * `anonymous` に `write` の規則は書けない**(schema が `can` を `["read"]` に閉じている)
   * **ので、面から通す道は無い。**
   *
   * **【失われたものを、丸めずに書く】** **「行ごとのアクセス権を1つも使っていない
   * ふつうのアプリの受信口」は、今日は署名が正しくても1行も書けない。**
   * **通す道は `access_control` を宣言して参加者の表に `system:inbound` を入れることだけで
   * あり、それは (i-b) が測っている道と同じである** —— **つまり「宣言していない表」という
   * 選択肢が、受信口については消えた。**
   *
   * =====================================================================================
   * **【`D-V8-67` により再び戻した(2026-08-10)。上の反転の記述は1バイトも消していない】**
   * =====================================================================================
   *
   * **ユーザ決定 `D-V8-67` の見出しの逐語: 「受信口は「持ち主が書いている」として扱う」。**
   * **受信の主体は今日 `anonymous` ではなく **持ち主(`owner`)** として面の判定を受ける。**
   * **したがって「面から通す道は無い」は今日は偽である** —— **持ち主に規則を1本書けば通る。**
   *
   * **【この検査が今日測っているものが1つずれた。丸めない】** —— **`open_inbox` は
   * `access_control` を1バイトも宣言していない**(= **点はオプトインのまま**)**が、
   * 面の既定は今日も閉じているので、持ち主の規則
   * (`{ target: "table", table: "open_inbox", can: ["write"] }`)を題材に足した。**
   * **「規則を1本も持たない表への受信が通る」ことは、今日は測っていないし、通らない**
   * —— **それを測っているのは下の (G-2) である。**
   */
  expect(res.status).toBe(201);
  expect(rowCount("open_inbox")).toBe(1);
});

// =====================================================================================
// (G-1) / (G-2) **受信口は「持ち主が書いている」として扱う**(ユーザ決定 `D-V8-67`)
//
// **選ばれた説明文の逐語(代償を含めて、そのまま写す)**:
// > **受信口は持ち主が承認して作ったものなので、届いた通知は持ち主の権限で書き込みます。
// > 新しい言葉を覚える必要がなく、自動で入る持ち主の行でそのまま通ります。ただし受信口を
// > 一つ作ると、そこに届いたものは持ち主の広さで書けることになります(受信口ごとに絞れません)。**
// =====================================================================================

test("(G-1) 持ち主に書込の規則が在る表へは、署名の正しい通知がそのまま入る(D-V8-67)", async () => {
  // **点(行ごとのアクセス権)は1バイトも宣言していない** —— **面だけで通っている。**
  const res = await postInbound({ event_id: "evt_o1", body: "持ち主として" }, ownerEndpointId);
  expect(res.status).toBe(201);
  expect(rowCount("owner_inbox")).toBe(1);
});

test("(G-2) 持ち主に規則が無い表へは、今日も1行も書けない(素通りにしていない)", async () => {
  // **`role_inbox` を名指ししている規則は `editor` の1本だけである** ——
  // **持ち主(`owner`)は1本も持たない。** **受信は 403 で止まり、1行も入らない。**
  // **【これが `D-V8-67` の射程の端である】** —— **「持ち主として扱う」は「素通りさせる」では
  // ない。** **持ち主に許されていない書込は、受信口からも通らない。**
  const res = await postInbound({ event_id: "evt_o2", body: "持ち主に規則なし" }, roleEndpointId);
  expect(res.status).toBe(403);
  const body = (await res.json()) as { errors: { message: string }[] };
  expect(body.errors[0]?.message).toContain("role");
  expect(rowCount("role_inbox")).toBe(0);
});

// --- (i-d) 止めているのが署名ではないことを分けて測る --------------------------------

test("(i-d) 署名が違えば今日どおり 401 である(権限の 403 と混ざっていない)", async () => {
  seedInboundMember();
  const rawBody = JSON.stringify({ event_id: "evt_4", body: "偽署名" });
  const res = await app.request(
    new Request(`http://localhost/inbound/${endpointId}`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Mock-PSP-Signature": "sha256=deadbeef" },
      body: rawBody,
    }),
  );
  expect(res.status).toBe(401);
  expect(rowCount("inbox")).toBe(0);
});

// =====================================================================================
// (F-5) / (F-6) **面(役割に束ねた権限)が受信口にも効く**(`V8-M21` の後半。3経路目)
//
// **自動処理とコードの島の側は `src/server/automation-access-control.test.ts` の
// (F-1) / (F-2) / (F-3) / (F-4) が測る**(3経路のうちの2経路)。**本ファイルが3経路目である。**
// =====================================================================================

test("(F-5) 面だけを宣言した表への受信は 403 で止まる(点は1つも宣言していない)", async () => {
  const res = await postInbound({ event_id: "evt_5", body: "役割で守る" }, roleEndpointId);
  expect(res.status).toBe(403);
  const body = (await res.json()) as { errors: { message: string; hint?: string }[] };
  // **止めた層が面(`role`)であることを、文面で名指ししている。**
  expect(body.errors[0]?.message).toContain("role");
  // **【隠さない】** **面の側から通す道は無い** —— **受信の主体は役割を1つも持たないので、
  // 規則をどう書いても通らない。** **その旨が `hint` に書いてある。**
  //
  // **【`D-V8-67` により期待値を戻した(2026-08-10)。上の2行は1バイトも消していない】** ——
  // **受信の主体は今日 **持ち主(`owner`)** として評価されるので、上の逐語
  // 「役割の規則(面)の側からは通せません」は今日は偽であり、`hint` からも消えた。**
  // **通す道は在る** —— **持ち主にその表の書込の規則を1本書けばよい**(下の (G-1))。
  // **`role_inbox` が今日も 403 なのは、規則を持っているのが `editor` だけだからである。**
  expect(body.errors[0]?.hint).toContain("持ち主");
  expect(rowCount("role_inbox")).toBe(0);
});

test("(F-6) 面が止めても、点が通せば受信は通る(OR は書ける側に倒れる)", async () => {
  // **`inbox` は点を宣言しており、面の規則は1本も無い** —— **面は管轄外である。**
  // **参加者の表に受信の主体を足すと、点が通す。**
  //
  // **【`V8-M26`。上の1文の後半は今日は偽である。旧文を1バイトも消していない】**
  // **規則を1本も名指ししていない表は、今日は「管轄外」ではなく「管轄内で拒否」である**
  // (`CLOSED_ROLE_ACCESS` は `governed: true`)。**したがって本検査が実際に測っているのは
  // 「面が**拒否**しても点が通せば通る」であり、`OR` が書ける側に倒れることの、より強い実測に
  // なっている**(期待値は1バイトも変えていない)。
  seedInboundMember();
  expect((await postInbound({ event_id: "evt_6", body: "点で" })).status).toBe(201);
  expect(rowCount("inbox")).toBe(1);
});
