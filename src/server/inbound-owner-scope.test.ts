/**
 * **外部からの受信口(`POST /inbound/:endpoint_id`)が、行の持ち主を無検証で受け入れないこと**の検査
 * (`V4-FIX1` 項目(4))。
 *
 * ## 何が通っていたか(**直す前に実測してから書いている**)
 *
 * `docs/evidence/cp-v4.md` §9 の 7 の逐語:
 *
 * > **実測(コード)**: `grep -c "OWNER_FIELD\|st_owner" src/server/inbound-route.ts` = **0**。
 * > 同 `:243` 逐語 `result = createInboundRow(db, manifest, endpoint.targetTable, payload as RecordInput);`
 * > —— **Webhook の body がそのままレコードの入力になる。** **スタンプも検証も1行も無い。**
 *
 * **つまり、署名鍵を持つ送り手は「この行は誰のものか」を自分で書けた。**
 * **個人所有テーブル(`st_owner` を持つ表)へ受信させると、任意の利用者の画面に行を差し込めた。**
 * **`ADR-0016` §却下(iv)「クライアント送信を信用する経路は最初から作らない」に正面から反する。**
 *
 * ## 直し方(**語彙を1つも増やしていない**)
 *
 * **判定は `owner-scope.ts` の既存の述語 `judgeOwnerScopedOp` 1本をそのまま通す** ——
 * 単件 POST / バッチ create と**同じ関数・同じ向き**である(新しい述語を1本も作らない。
 * `ADR-0033` §Consequences「`st_owner` の有無で分岐する判定を新しく別経路に書かない」)。
 * **actor は受信経路の既存の system actor(`system:inbound` / `D-G4b` / `ADR-0041` 限定9)である**
 * —— **新しい actor を1つも作っていない。**
 *
 * ## 【この検査が守らないもの。誇張しない】
 *
 * - **`st_owner` 以外の予約規約フィールドは、今日も payload から書ける。**
 *   **下の (X) が `st_public` について実測で固定する** —— **署名鍵を持つ送り手は、受信した行を
 *   匿名に読める行として作れる。** **本タスクはこれを塞いでいない**(項目(4) の指示は
 *   `st_owner` を名指ししており、他の3本を同時に閉じると既存アプリの受信が黙って変わる)。
 *   **審査へ回す**(記録 `docs/plan/v4/records/v4-fix1-boundary-bypass.md`)。
 * - **受信そのものの認証は今日どおり署名だけである**(`ADR-0041` §1)。**本タスクは1ミリも変えない。**
 *
 * ## 【`V4-M27`(2026-08-04)による追記。上の1点目は今日は半分だけ真である】
 *
 * **`D-V4-92` / `D-V4-114`(`docs/plan/v4/records/v4-open-questions.md` §5a / §5b)が
 * `st_public` だけを閉じた** —— **受信の payload から `st_public` を無条件に取り除く。
 * 拒否しない(400 を返さない)。** **したがって上の (X) は反転した**(消していない。
 * **何を期待値にしていたか・なぜ反転したかは (X) 自身のコメントに書いてある**)。
 *
 * **予約規約フィールドは今日 5本である**(`st_owner` / `st_public` / `st_admin_readable` /
 * `st_undeletable` / `st_no_direct_create`)。**受信経路で止まっているのは 2本だけで、
 * 残り3本は今日も素通りする** —— **下の (Z) が「塞いでいない」ことを固定する。**
 * **「予約規約フィールドは塞がれた」と書いてはならない**(`D-V4-114` の逐語)。
 *
 * ## 【`V8-M20` による追記。上の「5本」は今日は 4本である】
 *
 * **台帳 `J-G30`(判定 = 廃止)/ 手続き `ADR-0301` / ユーザ決定 `D-V8-35` が
 * `st_admin_readable`(運営可視)**1本だけ**を撤去した。**
 * **残る予約規約フィールドは4本**(`st_owner` / `st_public` / `st_undeletable` /
 * `st_no_direct_create`)、**受信 payload から落とす集合(`INBOUND_STRIPPED_RESERVED_FIELDS`)は
 * 4本 → 3本**である。**旧文は1バイトも書き換えていない**(この追記が引き受ける)。
 *
 * **代わりに立つのは「役割 × 対象(表)× 読取」**(`app.roles[].rules`)である ——
 * **受信経路には1バイトも関わらない。** **したがって本ファイルが測っている
 * 「送り手の名乗りを採らない」は、撤去の前後で1ミリも変わっていない。**
 *
 * **`D-V4-92` は「個人所有の表へ外部から任意の持ち主で書ける件はこの決定では解けない」とも
 * 書いている** —— **上の (A) / (B) が閉じたのは「payload の名乗りを採らない」ところまでで、
 * 受信口の書込先が個人所有の表であること自体は今日も owner が発行できる。**
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
  KernelMetaStore,
  type Manifest,
} from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import {
  NO_DIRECT_CREATE_FIELD,
  OWNER_FIELD,
  PUBLIC_FIELD,
  UNDELETABLE_FIELD,
} from "./owner-scope.ts";
import { seedSession, TEST_ORIGIN } from "./test-helpers.ts";

/*
 * =====================================================================================
 * **【`V8-M26`。この題材に「受信を通すための足場」を足した。理由を隠さずに書く】**
 * =====================================================================================
 *
 * **`V8-M26` が面(役割に束ねた権限)の既定を「閉じる」側へ倒した**(ユーザ決定 `D-V8-45` /
 * `D-V8-58` / `D-V8-65`)—— **規則を1本も名指ししていない表への書込は拒否される。**
 * **受信の主体(`system:inbound`)は実効ロール集合を持たないので、面はこれを未ログイン
 * (`anonymous`)として評価する。****`anonymous` の規則に `write` は書けない**
 * (schema が `can` を `["read"]` に閉じている。実測で `applyManifest` が拒否する)——
 * **面から受信を通す道は今日1本も無い。**
 *
 * **唯一残った道が、`src/server/inbound-route.ts` の 403 の hint の逐語
 * 「参加者の表に "system:inbound" の行を1件作ると、この受信口は今までどおり書き込めます」
 * である。****4つの受信先すべてに行ごとのアクセス権(点)を宣言し、参加者の表に
 * `system:inbound` を1行入れる。** **点が管轄内で書込を許すので、
 * `combineRoleAndGrantAccess` の `OR` が面の拒否を越える。**
 *
 * **面の規則を足すのは `reserved` だけである** —— **(W) の「運営者が DELETE できる」を
 * 成り立たせるには、運営者の側にも `delete` を通す層が要るからである**(点は
 * `system:inbound` にしか権限を配らない)。
 * **`ticket` / `plain` / `guarded` には面の規則を1本も足さない** —— **足すと
 * `roleReadCrossesOwnerScope` が `st_owner` の壁を越えてしまい、(A)(B)(W) が測っている
 * 「受信した行は誰の一覧にも出ない」「運営者から見えない」が丸ごと崩れる。**
 *
 * **【`V8-M26` で失われたものを、丸めずに書く】** **`V8-M26` より前、この4表は
 * `access_control` を1バイトも宣言せず、参加者の表も無しで 201 を得ていた。**
 * **今日は、行ごとのアクセス権を宣言していない表を書込先にした受信口は、署名が正しくても
 * 403 で1バイトも書けない。**
 *
 * =====================================================================================
 * **【`D-V8-67` により再び戻した(2026-08-10)。上の節を1バイトも消していない】**
 * =====================================================================================
 *
 * **ユーザ決定 `D-V8-67` の見出しの逐語: 「受信口は「持ち主が書いている」として扱う」。**
 * **選ばれた説明文の逐語**:
 * > **受信口は持ち主が承認して作ったものなので、届いた通知は持ち主の権限で書き込みます。
 * > 新しい言葉を覚える必要がなく、自動で入る持ち主の行でそのまま通ります。ただし受信口を
 * > 一つ作ると、そこに届いたものは持ち主の広さで書けることになります(受信口ごとに絞れません)。**
 *
 * **受信の主体は今日、面から見て **持ち主(`owner`)** である** —— **したがって上の節の
 * 逐語「面から受信を通す道は今日1本も無い」は今日は偽である。**
 *
 * **【題材から足場を撤去した。何をどう戻したかを書く】**
 *  - **4表に足していた `access_control` の宣言と、`inbound_member` / `*_grant` の4表を
 *    撤去した** —— **点(行ごとのアクセス権)で通す必要が無くなったからである。**
 *    **残すと (A)(B)(X) が「点で通っている」ことを測ってしまい、面の判定を1度も見なくなる。**
 *  - **代わりに `app.roles` を足した** —— **持ち主に4表の**書込**を許す。**
 *    **`ticket` / `guarded` には**読取を1バイトも配らない** ——
 *    **配ると `roleReadCrossesOwnerScope` が `st_owner` の壁を越え、
 *    (A)(B) が測っている「受信した行は誰の一覧にも出ない」が崩れる。**
 *    **`reserved` にだけ読取と削除も配る** —— **(W) の「運営者が DELETE できる」に要る。**
 */

const APP_ID = "inbound-owner-shop";
const SIGNING_KEY = "test-inbound-owner-key";
const KEY_ENV_VAR = "ST_TEST_INBOUND_OWNER_KEY";

/**
 * **個人所有テーブル(`ticket`)を受信先に置く。** —— `st_owner` を持つ表であり、
 * 通常の HTTP 経路では `st_owner` は必ずサーバがスタンプする(クライアントの値は捨てる)。
 * **受信口だけがその規律の外に居た。**
 */
function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "受信の店",
      tables: [
        {
          id: "ticket",
          name: "問い合わせ",
          fields: [
            { id: "event_id", name: "イベントID", type: "text", required: true, unique: true },
            { id: "body", name: "本文", type: "text" },
            { id: OWNER_FIELD, name: "所有者", type: "text" },
            { id: PUBLIC_FIELD, name: "公開", type: "boolean" },
          ],
          // **【`V8-M26`】ここには足せない。** **適用時検査が `st_public` と行ごとの
          // アクセス権の同居を拒否する**(逐語: 「表 "ticket" では、アクセス権管理と、
          // "st_public" の項目による見せ方の設定を、同時に使うことはできません。」)。
          // **したがって `ticket` への受信を通す道は今日1本も無く、下の (A)(B)(C)(X) は
          // 期待値を 403 へ反転させてある。**
          //
          // **【`D-V8-67` により再び戻した】** **点(行ごとのアクセス権)を足せないことは
          // 今日も真である** —— **が、通す道は面の側に在る**(持ち主に `ticket` の書込を
          // 許す規則。下の `roles`)。**(A)(B)(C)(X) の期待値は元へ戻した。**
        },
        /**
         * **`st_public` を1本も持たない表**(`V4-M27`)。**`D-V4-114` が承知した副作用を
         * 測るための表である** —— ここへ `st_public` を送ると、今日は「そんなフィールドは
         * 無い」で 400 になる。**取り除く実装にすると 201 に変わる。**
         */
        {
          id: "plain",
          name: "素の受信",
          fields: [
            { id: "event_id", name: "イベントID", type: "text", required: true, unique: true },
            { id: "body", name: "本文", type: "text" },
          ],
          // **【`V8-M26`】受信を通す唯一の道**(ファイル冒頭の節)として、ここに
          // `access_control`(点)の宣言と、それが指す付与表・参加者の表を足していた。
          // **【`D-V8-67` により撤去した】** **通す道が面の側(下の `roles`)へ移ったので、
          // 点の足場は要らなくなった** —— **残すと本群が「点で通っている」ことを測って
          // しまい、面の判定を1度も見なくなる。**
        },
        /**
         * **残り3本の予約規約フィールドを持つ表**(`V4-M27`)。**塞いでいないことを
         * 固定するための表である。** **`ticket` に足さない** —— `st_admin_readable` を
         * `ticket` に置くと `adminReadsAllRows` が owner に全行を見せ、(B) の意味が変わる。
         *
         * **【`V8-M20` / `J-G30` / `ADR-0301`】`st_admin_readable` を1本落とした(3本 → 2本)。**
         * **旧: `{ id: ADMIN_READABLE_FIELD, name: "運営可視", type: "boolean" }` を先頭に
         * 持っていた。** **`ADMIN_READABLE_FIELD` は `owner-scope.ts` から消えている。**
         * **上の「`ticket` に足さない」理由(`adminReadsAllRows`)も今日は存在しない** ——
         * **それでも表を分けたまま残す**(足すと (B) の測っているものが変わるため)。
         */
        {
          id: "reserved",
          name: "予約規約つきの受信",
          fields: [
            { id: "event_id", name: "イベントID", type: "text", required: true, unique: true },
            { id: UNDELETABLE_FIELD, name: "削除不可", type: "boolean" },
            { id: NO_DIRECT_CREATE_FIELD, name: "直接作成の遮断", type: "boolean" },
          ],
          // **【`V8-M26`】受信を通す唯一の道**(ファイル冒頭の節)として、ここに
          // `access_control`(点)の宣言と、それが指す付与表・参加者の表を足していた。
          // **【`D-V8-67` により撤去した】** **通す道が面の側(下の `roles`)へ移ったので、
          // 点の足場は要らなくなった** —— **残すと本群が「点で通っている」ことを測って
          // しまい、面の判定を1度も見なくなる。**
        },
        /**
         * **個人所有 × 削除不可の表**(`V4-M36`)。**`D-V4-92` が「解けない」と書いた側を
         * 測るための表である** —— 受信で入った行は `st_owner` が `system:inbound` になるので、
         * **運営者からは最初から見えない**(`DELETE` は 404 になる)。**本タスクはここを
         * 1ミリも変えない。**
         */
        {
          id: "guarded",
          name: "個人所有 × 削除不可の受信",
          fields: [
            { id: "event_id", name: "イベントID", type: "text", required: true, unique: true },
            { id: OWNER_FIELD, name: "所有者", type: "text" },
            { id: UNDELETABLE_FIELD, name: "削除不可", type: "boolean" },
          ],
          // **【`V8-M26`】受信を通す唯一の道**(ファイル冒頭の節)として、ここに
          // `access_control`(点)の宣言と、それが指す付与表・参加者の表を足していた。
          // **【`D-V8-67` により撤去した】** **通す道が面の側(下の `roles`)へ移ったので、
          // 点の足場は要らなくなった** —— **残すと本群が「点で通っている」ことを測って
          // しまい、面の判定を1度も見なくなる。**
        },
        // **【`V8-M26`】ここに参加者の表(`inbound_member`)と付与表3本を足していた。**
        // **【`D-V8-67` により撤去した】**(ファイル冒頭の節)。
      ],
      views: [{ id: "ticket-list", type: "list_view", table: "ticket", columns: ["body"] }],
      // =================================================================================
      // **【`D-V8-67`】面(役割に束ねた権限)の宣言。受信を通す道はここ1箇所である。**
      // =================================================================================
      //
      // **持ち主に配るのは 4表の**書込**だけである**(`reserved` にだけ読取と削除も配る)。
      //  - **`ticket` / `guarded` に**読取を1バイトも配らない** —— **配ると
      //    `roleReadCrossesOwnerScope` が `st_owner` の壁を越え、(A)(B) が測っている
      //    「受信した行は誰の一覧にも出ない」が丸ごと崩れる。**
      //  - **`reserved` には読取と削除も配る** —— **(W) の「運営者が DELETE できる」に要る。**
      //    **`reserved` は `st_owner` を持たないので、読取を配っても越える壁が無い。**
      //  - **`editor` / `viewer` には1本も配らない** —— **本ファイルの検査は使わない。**
      //    **`ADR-0301` 由来の適用時検査(既定3役割の宣言そのものは要る)を満たすために、
      //    宣言だけは3つとも置く。**
      roles: [
        {
          id: "owner",
          name: "持ち主",
          rules: [
            // **【`V8-M28` / `T-G16a`】持ち主にはこの2行が必ず要る**(類型17 の拡張)。
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
            { target: "table", table: "ticket", can: ["write"] },
            { target: "table", table: "plain", can: ["write"] },
            { target: "table", table: "reserved", can: ["read", "write", "delete"] },
            { target: "table", table: "guarded", can: ["write", "delete"] },
          ],
        },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
      ],
    },
  } as unknown as Manifest;
}

/*
 * **【`V8-M26`】ここに `manifestWithRoles()`(`withDefaultRoleRules` の呼び出し)と
 * `seedInboundMember()`(参加者の表に `system:inbound` を1行入れる)を置いていた。**
 * **【`D-V8-67` により両方とも撤去した】** —— **面の規則は `manifest()` が直接持ち、
 * 参加者の表そのものが無くなったので、種を蒔く相手が居ない。**
 */

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;
let endpointId: string;
/** `plain`(`st_public` を持たない表)を書込先にする受信口。 */
let plainEndpointId: string;
/** `reserved`(残り3本を持つ表)を書込先にする受信口。 */
let reservedEndpointId: string;
/** `guarded`(個人所有 × 削除不可の表)を書込先にする受信口(`V4-M36`)。 */
let guardedEndpointId: string;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-inbound-owner-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "受信の店", { app_id: APP_ID });
  } finally {
    store.close();
  }
  // **【`V8-M26`】旧: `applyManifest(dataRoot, APP_ID, manifestWithRoles())` +
  // `seedInboundMember()` の2行。** **【`D-V8-67` により1行に戻した】**
  expect(applyManifest(dataRoot, APP_ID, manifest()).valid).toBe(true);
  process.env[KEY_ENV_VAR] = SIGNING_KEY;
  const inbound = InboundStore.openForKernel(dataRoot);
  try {
    endpointId = inbound.issueInboundEndpoint({
      appId: APP_ID,
      name: "mock-psp",
      secretSource: { kind: "env", value: KEY_ENV_VAR },
      targetTable: "ticket",
    }).id;
    plainEndpointId = inbound.issueInboundEndpoint({
      appId: APP_ID,
      name: "mock-psp-plain",
      secretSource: { kind: "env", value: KEY_ENV_VAR },
      targetTable: "plain",
    }).id;
    reservedEndpointId = inbound.issueInboundEndpoint({
      appId: APP_ID,
      name: "mock-psp-reserved",
      secretSource: { kind: "env", value: KEY_ENV_VAR },
      targetTable: "reserved",
    }).id;
    guardedEndpointId = inbound.issueInboundEndpoint({
      appId: APP_ID,
      name: "mock-psp-guarded",
      secretSource: { kind: "env", value: KEY_ENV_VAR },
      targetTable: "guarded",
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

function postInbound(
  payload: Record<string, unknown>,
  target: string = endpointId,
): Promise<Response> {
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

/** 受信で作られた行を **本物の SQLite を直接開いて**読む(HTTP の射影を通さない)。 */
function readRow(eventId: string, tableId = "ticket"): Record<string, unknown> | undefined {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readonly: true });
  try {
    // `.get()` は該当行が無いとき `null` を返すので、`undefined` に寄せる(呼び出し側の型)。
    return (
      (db
        .query<Record<string, unknown>, [string]>(`SELECT * FROM "${tableId}" WHERE "event_id" = ?`)
        .get(eventId) as Record<string, unknown> | null) ?? undefined
    );
  } finally {
    db.close();
  }
}

/*
 * =====================================================================================
 * **【`V8-M26`。(A)(B)(C)(X) の8本は期待値を 403 へ反転させた。理由をここに1度だけ書く】**
 * =====================================================================================
 *
 * **`V8-M26` が面の既定を閉じたので、`ticket` への受信は署名が正しくても 403 で止まる。**
 * **`ticket` にだけは埋め合わせが1つも無い**(ファイル冒頭の節):
 *
 *  1. **面から通せない** —— **受信の主体は `anonymous` として評価され、`anonymous` に
 *     `write` の規則は書けない**(schema が `can` を `["read"]` に閉じている)。
 *  2. **点からも通せない** —— **`ticket` は `st_public` を持ち、適用時検査が
 *     `st_public` と行ごとのアクセス権の同居を拒否する**(逐語:「表 "ticket" では、
 *     アクセス権管理と、"st_public" の項目による見せ方の設定を、同時に使うことは
 *     できません。」)。**`plain` / `reserved` / `guarded` で使った手当てが、この表にだけ
 *     使えない。**
 *
 * **【この反転で失われたものを、丸めずに書く】**
 * **本群が測っていたのは「受信は通る。ただし送り手の名乗り(`st_owner` / `st_public`)は
 * 採らない」という**2つ組**であった。** **今日は前半(受信が通ること)が成り立たないので、
 * 後半(名乗りを採らないこと)は `ticket` については1件も測れていない。**
 * **【禁止】「送り手の名乗りを採らないことを今日も測れている」と書かない** ——
 * **`ticket` について測れているのは「1行も入らない」までである。**
 * **後半を今日も測っているのは、`plain` を使う (Y) と (W)【副作用】の2本だけである。**
 *
 * =====================================================================================
 * **【`D-V8-67` により再び戻した(2026-08-10)。上の節は1バイトも消していない】**
 * =====================================================================================
 *
 * **受信の主体は今日、面から見て **持ち主(`owner`)** である**(`D-V8-67`)——
 * **上の 1「面から通せない」は今日は偽であり、`ticket` にも持ち主の書込規則1本で道が開く。**
 * **2「点からも通せない」は今日も真である**(`st_public` との同居は今日も拒否される)——
 * **が、点で通す必要が無くなった。**
 * **したがって (A)(B)(C)(X) の8本は、期待値を反転前へ戻した。**
 *
 * **本群は今日ふたたび「受信は通る。ただし送り手の名乗り(`st_owner` / `st_public`)は
 * 採らない」という2つ組を測っている。**
 */

// --- (A) 送り手が名乗った持ち主を採らない --------------------------------------------

test("(A) payload が名指しした持ち主は採用されない(送り手の値をそのまま入れない)", async () => {
  const victim = seedSession(dataRoot, APP_ID, { role: "customer", username: "victim" });
  const res = await postInbound({ event_id: "evt_1", body: "偽装", [OWNER_FIELD]: victim.userId });
  // **旧: `expect(res.status).toBe(201);`**
  // **旧: `const row = readRow("evt_1");`**
  // **旧: `expect(row?.[OWNER_FIELD]).not.toBe(victim.userId);`**
  // **【`V8-M26` / `D-V8-45` / `D-V8-65`】** 上の節。**行そのものが入らない。**
  // **反転していたときの期待値(逐語): `expect(res.status).toBe(403);` /**
  // **`expect(readRow("evt_1")).toBeUndefined();`**
  //
  // **【`D-V8-67` により再び戻した(2026-08-10)。上の反転の記述は1バイトも消していない】**
  expect(res.status).toBe(201);
  const row = readRow("evt_1");
  expect(row?.[OWNER_FIELD]).not.toBe(victim.userId);
});

test("(A) 何が起きるか: 受信した行が、名指しされた利用者の一覧に現れない", async () => {
  // **これが本項目の目的である** —— 署名鍵を持つ外部の送り手が、任意の利用者の画面へ
  // 行を差し込めてはならない。**画面ではなくサーバの応答で測る。**
  const victim = seedSession(dataRoot, APP_ID, { role: "customer", username: "victim2" });
  // **旧: `).toBe(201);`** —— **【`V8-M26`】受信そのものが 403 で止まる。**
  // **目的(利用者の一覧に現れないこと)は今日も成り立つが、**理由が変わった** ——
  // **持ち主のスタンプではなく、そもそも1行も入らないからである。**
  // **反転していたときの期待値(逐語): `).toBe(403);`**
  //
  // **【`D-V8-67` により再び戻した(2026-08-10)。上の反転の記述は1バイトも消していない】**
  // **理由も元へ戻った** —— **行は入るが、持ち主は `system:inbound` に上書きされている。**
  expect(
    (await postInbound({ event_id: "evt_2", body: "差し込み", [OWNER_FIELD]: victim.userId }))
      .status,
  ).toBe(201);

  const list = await app.request(
    new Request(`http://localhost/api/apps/${APP_ID}/tables/ticket/records`, {
      headers: { cookie: victim.cookie },
    }),
  );
  expect(list.status).toBe(200);
  const body = (await list.json()) as { records: { event_id?: string }[] };
  expect(body.records.map((r) => r.event_id)).not.toContain("evt_2");
});

// --- (B) 持ち主を書かない受信も、無所属の行にしない -----------------------------------

test("(B) payload が持ち主を書かなくても、受信経路の system actor が持ち主として入る", async () => {
  // **無所属(空)の行を個人所有テーブルに作らない。** 空文字は共有センチネルと衝突する
  // (`owner-scope.ts` の `isSharedOwner`)ので、**黙って全員に見える行を作らせない。**
  //
  // **旧: `expect((await postInbound({ event_id: "evt_3", body: "持ち主なし" })).status).toBe(201);`**
  // **旧: `const row = readRow("evt_3");`**
  // **旧: `expect(row?.[OWNER_FIELD]).toBe("system:inbound");`**
  // **【`V8-M26`】** **持ち主のスタンプは今日 `ticket` では1度も走らない**(その手前で止まる)。
  // **反転していたときの期待値(逐語): `).toBe(403);` /**
  // **`expect(readRow("evt_3")).toBeUndefined();`**
  //
  // **【`D-V8-67` により再び戻した(2026-08-10)。上の反転の記述は1バイトも消していない】**
  // **【`D-V8-67` の射程を誤読しないこと】** **面から見た役割が `owner` になっただけで、
  // 行に入る主体は今日も `system:inbound` である**(`SYSTEM_INBOUND_ACTOR` は不変)。
  expect((await postInbound({ event_id: "evt_3", body: "持ち主なし" })).status).toBe(201);
  const row = readRow("evt_3");
  expect(row?.[OWNER_FIELD]).toBe("system:inbound");
});

test("(B) 受信した行は、誰の個人一覧にも出ない(system actor に紐づくため)", async () => {
  // **旧: `).toBe(201);`** —— **【`V8-M26`】** 上の節。
  // **反転していたときの期待値(逐語): `).toBe(403);`**
  //
  // **【`D-V8-67` により再び戻した(2026-08-10)。上の反転の記述は1バイトも消していない】**
  expect((await postInbound({ event_id: "evt_4", body: "system 所有" })).status).toBe(201);
  for (const role of ["owner", "customer"] as const) {
    const s = seedSession(dataRoot, APP_ID, { role, username: `${role}-x` });
    const list = await app.request(
      new Request(`http://localhost/api/apps/${APP_ID}/tables/ticket/records`, {
        headers: { cookie: s.cookie },
      }),
    );
    const body = (await list.json()) as { records: { event_id?: string }[] };
    expect(
      body.records.map((r) => r.event_id),
      role,
    ).not.toContain("evt_4");
  }
});

// --- (C) 受信そのものは今日どおり通る(塞ぎすぎていない)-------------------------------

test("(C) 受信は今日どおり 201 で1行 create される(遮断に倒していない)", async () => {
  const res = await postInbound({ event_id: "evt_5", body: "本文" });
  // **旧: `expect(res.status).toBe(201);`**
  // **旧: `expect(readRow("evt_5")?.body).toBe("本文");`**
  // **【`V8-M26` / `D-V8-45` / `D-V8-65`】この検査の名前は今日は成り立たない。**
  // **`V8-M26` は、まさに「遮断に倒す」方向へ既定を倒した決定である** ——
  // **`st_public` を持つ表を書込先にした受信口は、今日1行も書けない。**
  // **反転していたときの期待値(逐語): `expect(res.status).toBe(403);` /**
  // **`expect(readRow("evt_5")).toBeUndefined();`**
  //
  // **【`D-V8-67` により再び戻した(2026-08-10)。上の反転の記述は1バイトも消していない】**
  // **検査の名前は今日ふたたび成り立つ** —— **持ち主に書込を許した表への受信は通る。**
  expect(res.status).toBe(201);
  expect(readRow("evt_5")?.body).toBe("本文");
});

// --- (X) 【反転済み】外部の送り手は「誰でも見える」印を立てられない(D-V4-92 / D-V4-114)----
//
// **この検査は `V4-FIX1` の時点では逆を固定していた。** **当時の期待値は逐語で
// `expect(readRow("evt_6")?.[PUBLIC_FIELD]).toBe(1);` と
// `expect(body.records.map((r) => r.event_id)).toContain("evt_6");` であり、
// 「署名鍵を持つ送り手は、受信した行を匿名に読める行として作れる」という**穴**を、
// 消えないように固定するためのものだった**(テスト名も「【塞げていない】」で始まっていた)。
//
// **反転した理由**: **ユーザ決定 `D-V4-92`(§5a)が「受信の payload から `st_public` を
// 強制的に外す」と決め、`D-V4-114`(§5b)が「印だけ黙って捨てて、残りは受け取る」
// (= 無条件に取り除く・拒否しない)と分岐を決めたためである。**
// **検査は1本も消していない** —— 同じ送信に対する期待値を、穴の側から塞いだ側へ入れ替えた。

test("(X) 送り手が立てた「誰でも見える」印は採用されない(D-V4-92)", async () => {
  // **201 は変わらない**(`D-V4-114` = 拒否しない)。**変わるのは行の中身だけである。**
  //
  // **旧: `).toBe(201);`**
  // **旧: `expect(readRow("evt_6")?.[PUBLIC_FIELD]).not.toBe(1);`**
  // **【`V8-M26` / `D-V8-45` / `D-V8-65`】上の節。****印を取り除く実装
  // (`stripInboundPublicFlag`)は今日 `ticket` では1度も呼ばれない** —— **その手前で
  // 403 になるからである。** **印が採られないことは、`plain` を使う (Y) が今日も測っている。**
  // **反転していたときの期待値(逐語): `).toBe(403);` /**
  // **`expect(readRow("evt_6")).toBeUndefined();`**
  //
  // **【`D-V8-67` により再び戻した(2026-08-10)。上の反転の記述は1バイトも消していない】**
  // **印を取り除く実装は今日ふたたび `ticket` でも走る。**
  expect(
    (await postInbound({ event_id: "evt_6", body: "公開されない", [PUBLIC_FIELD]: true })).status,
  ).toBe(201);
  expect(readRow("evt_6")?.[PUBLIC_FIELD]).not.toBe(1);
});

test("(X) 何が起きるか: 受信した行が、未認証の公開 GET に出てこない", async () => {
  // **旧: `).toBe(201);`** —— **【`V8-M26`】** 上の節。**理由が「印を落としたから」から
  // 「1行も入らないから」に変わった。**
  // **反転していたときの期待値(逐語): `).toBe(403);`**
  //
  // **【`D-V8-67` により再び戻した(2026-08-10)。上の反転の記述は1バイトも消していない】**
  // **理由も「印を落としたから」へ戻った。**
  expect(
    (await postInbound({ event_id: "evt_7", body: "公開されない", [PUBLIC_FIELD]: true })).status,
  ).toBe(201);
  const anon = await app.request(
    new Request(`http://localhost/api/apps/${APP_ID}/tables/ticket/records`),
  );
  expect(anon.status).toBe(200);
  const body = (await anon.json()) as { records: { event_id?: string }[] };
  expect(body.records.map((r) => r.event_id)).not.toContain("evt_7");
});

test("(X) st_owner の既存の振る舞いは1バイトも変わらない(同じ payload に両方入れても)", async () => {
  // **`st_owner` は今日どおり `judgeOwnerScopedOp` が system actor で上書きする**(捨てない)。
  // **`st_public` だけが取り除かれる**(上書きする値が無いので消す)。**2つの向きは違う。**
  const victim = seedSession(dataRoot, APP_ID, { role: "customer", username: "victim3" });
  // **旧: `).toBe(201);`**
  // **旧: `const row = readRow("evt_8");`**
  // **旧: `expect(row?.[OWNER_FIELD]).toBe("system:inbound");`**
  // **旧: `expect(row?.[PUBLIC_FIELD]).not.toBe(1);`**
  // **【`V8-M26` / `D-V8-45` / `D-V8-65`】上の節。**
  // **この検査の名前(「`st_owner` の既存の振る舞いは1バイトも変わらない」)は今日は
  // 成り立たない** —— **`st_owner` のスタンプそのものが走らなくなったからである。**
  // **`st_owner` の実装は1バイトも変わっていないが、そこへ到達しない。**
  // **反転していたときの期待値(逐語): `).toBe(403);` /**
  // **`expect(readRow("evt_8")).toBeUndefined();`**
  //
  // **【`D-V8-67` により再び戻した(2026-08-10)。上の反転の記述は1バイトも消していない】**
  // **検査の名前は今日ふたたび成り立つ** —— **スタンプに到達する。**
  expect(
    (
      await postInbound({
        event_id: "evt_8",
        body: "両方入り",
        [OWNER_FIELD]: victim.userId,
        [PUBLIC_FIELD]: true,
      })
    ).status,
  ).toBe(201);
  const row = readRow("evt_8");
  expect(row?.[OWNER_FIELD]).toBe("system:inbound");
  expect(row?.[PUBLIC_FIELD]).not.toBe(1);
});

// --- (Y) 【副作用。誇張しない】400 → 201 に変わった(D-V4-114 が承知した分岐)-------------

test("(Y)【副作用】st_public を持たない表への受信は、今日の 400 ではなく 201 になる", async () => {
  // **`D-V4-114` の逐語**: 「**この結果、その印を持たない表への受信が、今までエラーだった
  // ものが黙って通るようになる。**」 —— **反転前は、この送信はカーネルの
  // 「フィールド "st_public" はテーブル "plain" に存在しません。」で 400 だった。**
  const res = await postInbound(
    { event_id: "evt_p1", body: "印を持たない表へ", [PUBLIC_FIELD]: true },
    plainEndpointId,
  );
  expect(res.status).toBe(201);
  // **行は在る。印だけが消えている**(列そのものが無い表なので、行に現れない)。
  const row = readRow("evt_p1", "plain");
  expect(row?.body).toBe("印を持たない表へ");
  expect(row).not.toHaveProperty(PUBLIC_FIELD);
});

test("(Y)【副作用の射程】印以外の未知フィールドは今日どおり 400 で弾かれる", async () => {
  // **黙って通るようになったのは `st_public` の1本だけである** —— 未知フィールド一般を
  // 受け入れるようにしたのではない(`ADR-0041` 限定5 / 条件 e の関門は動かしていない)。
  const res = await postInbound(
    { event_id: "evt_p2", body: "未知フィールド", not_a_field: true },
    plainEndpointId,
  );
  expect(res.status).toBe(400);
  expect(readRow("evt_p2", "plain")).toBeUndefined();
});

// --- (Z) 【反転済み】残り3本の予約規約フィールドも payload から採用されない(D-V4-125)------
//
// **この検査は `V4-M27` の時点では逆を固定していた。** **当時の期待値は逐語で
// `expect(row?.[ADMIN_READABLE_FIELD]).toBe(1);` / `expect(row?.[UNDELETABLE_FIELD]).toBe(1);` /
// `expect(row?.[NO_DIRECT_CREATE_FIELD]).toBe(1);` であり、テスト名は
// 「(Z)【塞いでいない】st_admin_readable / st_undeletable / st_no_direct_create は素通りする」
// だった** —— **残り3本が素通りするという穴を、消えないように固定するためのものだった。**
//
// **反転した理由**: **ユーザ決定 `D-V4-125`(§5d)が「外部からの受信口を通して『運営者でも
// 消せない行』を作られる件を塞ぐ。残る予約規約フィールド3本を、`st_public` と同じやり方
// (黙って捨てる)で処理する」と決めたためである。** **同決定は「`D-V4-92`(「他の予約規約
// フィールドは今日のまま」)の射程を今日の決定が広げる」と明記している。**
// **検査は1本も消していない** —— 同じ送信に対する期待値を、穴の側から塞いだ側へ入れ替えた。

test("(Z) st_undeletable / st_no_direct_create は採用されない(D-V4-125)", async () => {
  // **201 は変わらない**(`st_public` と同じ扱い = 拒否しない。`D-V4-114` / `D-V4-125`)。
  // **変わるのは行の中身だけである。**
  //
  // **【`V8-M20` / `J-G30` / `ADR-0301`】検査名から `st_admin_readable` を落とした。**
  // **旧: `test("(Z) st_admin_readable / st_undeletable / st_no_direct_create は採用されない(D-V4-125)")`。**
  // **旧の本体は `[ADMIN_READABLE_FIELD]: true` を送り
  // `expect(row?.[ADMIN_READABLE_FIELD]).not.toBe(1);` を見ていた。**
  // **その綴りは今日の語彙に無い**(予約規約フィールドではなくなった)ので**送れない** ——
  // **`D-V4-125` が塞いだ残りの2本については、下の2行が今日も同じことを見ている。**
  expect(
    (
      await postInbound(
        {
          event_id: "evt_r1",
          [UNDELETABLE_FIELD]: true,
          [NO_DIRECT_CREATE_FIELD]: true,
        },
        reservedEndpointId,
      )
    ).status,
  ).toBe(201);
  const row = readRow("evt_r1", "reserved");
  expect(row?.[UNDELETABLE_FIELD]).not.toBe(1);
  expect(row?.[NO_DIRECT_CREATE_FIELD]).not.toBe(1);
});

// --- (W) 【D-V4-125】外部から「運営者でも消せない行」を作られる件 --------------------------
//
// **`D-V4-125` の「起きること」の逐語**: 「**受信口の URL を知っている相手が、運営者でも
// 消せないゴミ行を積むことができなくなる。**」 —— **下の (W) がその1点を、本物の HTTP
// (受信 → 運営者の `DELETE`)で確かめる。**

test("(W) 外部が立てた「消せない」印つきの行を、運営者が DELETE できる(D-V4-125)", async () => {
  // **反転前(= 塞ぐ前)は、この `DELETE` が `409` で止まっていた** —— 受信で入った
  // `st_undeletable` の値が `isDeleteProtectedRow`(`ADR-0073`)の判定にそのまま使われる
  // ためである。**署名鍵を持つ送り手は、運営者が消せない行を無制限に積めた。**
  expect(
    (await postInbound({ event_id: "evt_w1", [UNDELETABLE_FIELD]: true }, reservedEndpointId))
      .status,
  ).toBe(201);
  const row = readRow("evt_w1", "reserved");
  expect(row).toBeDefined();
  const admin = seedSession(dataRoot, APP_ID, { role: "owner", username: "admin-w1" });
  const res = await app.request(
    new Request(`http://localhost/api/apps/${APP_ID}/tables/reserved/records/${row?._id}`, {
      method: "DELETE",
      headers: {
        origin: TEST_ORIGIN,
        cookie: admin.cookie,
        "if-match": String(row?._updated_at),
      },
    }),
  );
  expect(res.status).toBe(204);
  expect(readRow("evt_w1", "reserved")).toBeUndefined();
});

test("(W)【副作用】その3本を1本も持たない表への受信は、今日の 400 ではなく 201 になる", async () => {
  // **`st_public` のときと同じ副作用が、対象4本ぶんに広がる**(`D-V4-114` が承知した形の
  // 拡大。`D-V4-125` は「`st_public` と同じやり方」と決めている)。**反転前は、この送信は
  // カーネルの「フィールド "st_undeletable" はテーブル "plain" に存在しません。」で 400 だった。**
  //
  // **【`V8-M20` / `J-G30` / `ADR-0301`】送る印を1本落とした(4本 → 3本)。**
  // **旧: 同じ payload に `[ADMIN_READABLE_FIELD]: true,` が入っていた。**
  // **今日その綴りを送ると、落とす対象ではなくなったので `plain` に列が無く 400 になる** ——
  // **これはこの検査が測っている副作用そのものが1本ぶん狭まったということである。**
  const res = await postInbound(
    {
      event_id: "evt_p3",
      body: "印を持たない表へ",
      [UNDELETABLE_FIELD]: true,
      [NO_DIRECT_CREATE_FIELD]: true,
    },
    plainEndpointId,
  );
  expect(res.status).toBe(201);
  const row = readRow("evt_p3", "plain");
  expect(row?.body).toBe("印を持たない表へ");
  expect(row).not.toHaveProperty(UNDELETABLE_FIELD);
});

test("(W)【塞いでいない】個人所有の表に入った行は、今日どおり運営者から見えない(D-V4-92)", async () => {
  // **`D-V4-92` の逐語「個人所有の表へ外部から任意の持ち主で書ける件はこの決定では解けない
  // —— 解けないと書く」。** **`D-V4-125` もそこは解いていない。** 受信で入った行の持ち主は
  // `system:inbound` なので、**運営者の `DELETE` は 404(存在を伏せる)である** ——
  // **`st_undeletable` を落としても 404 のままで、1ミリも変わらない。**
  expect(
    (await postInbound({ event_id: "evt_g1", [UNDELETABLE_FIELD]: true }, guardedEndpointId))
      .status,
  ).toBe(201);
  const row = readRow("evt_g1", "guarded");
  expect(row?.[OWNER_FIELD]).toBe("system:inbound");
  const admin = seedSession(dataRoot, APP_ID, { role: "owner", username: "admin-g1" });
  const res = await app.request(
    new Request(`http://localhost/api/apps/${APP_ID}/tables/guarded/records/${row?._id}`, {
      method: "DELETE",
      headers: {
        origin: TEST_ORIGIN,
        cookie: admin.cookie,
        "if-match": String(row?._updated_at),
      },
    }),
  );
  expect(res.status).toBe(404);
  // **行は残る。** **受信口にゴミを積まれる経路そのものは塞がっていない。**
  expect(readRow("evt_g1", "guarded")).toBeDefined();
});
