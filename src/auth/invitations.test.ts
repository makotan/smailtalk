/**
 * **招待の表とコードの生成器**(`V8-M2-T02` / `V8-M2-T03` / `V8-M2-T05` / `V8-M2-T06`。
 * 台帳 `I-G9` / `I-G11` / `I-G14` / `I-G15` / `I-G16` / `I-G17` / `I-G18`。`ADR-0336`)。
 *
 * ## この検査の作り方(**TDD である。順序を先に書く**)
 *
 * **先にこのファイルを書き、赤を見てから `src/auth/store.ts` に実装を入れた。**
 * **期待値は `ADR-0336` の限定表(23項)から採っており、実装を見て後から合わせたものではない。**
 *
 * ## 何を固定するのか(`ADR-0336` の限定と1対1)
 *
 * - **限定1**: **`_auth_*` は 7 → 8 ちょうど**(9本目を作らない)。
 * - **限定2**: **列は7列ちょうど**(業務データを指す列を1本も置かない)。
 * - **限定3**: **`src/shared/system-tables.ts` に1バイトも書かない**(`SYSTEM_TABLES` は3本のまま)。
 * - **限定4**: **`_auth_users` への外部キーを宣言しない**(相手はまだ登録していない)。
 * - **限定7**: **MCP ツールを1本も足さない**(23本のまま)。
 * - **限定9**: **コードは8文字・32字表ちょうど**(`0`-`9` + `A`-`Z` − `I` `L` `O` `U`)。
 * - **限定14**: **期限は24時間固定。**
 * - **限定15**: **期限の判定は既存の `isExpired` 1本だけを使う。**
 * - **限定16**: **1回きりは「使用時刻の列」で表す。行を削除しない。**
 * - **限定19**: **掃除はリクエスト内で呼び、同じ点で既存の `purgeExpired()` も呼ぶ。**
 *
 * ## **【着手前の実測を逐語で残す】`purgeExpired()` は本番から0件だった**
 *
 * **`V8-M2` の着手前(sha `a710caa`)に打った `/usr/bin/grep -rn "purgeExpired" src scripts web`
 * の全出力は、次の3行ちょうどである**(**定義1 / テスト2 / 本番0**):
 *
 * ```
 * src/auth/store.test.ts:467:  describe("purgeExpired", () => {
 * src/auth/store.test.ts:474:      const removed = store.purgeExpired();
 * src/auth/store.ts:1386:  purgeExpired(): number {
 * ```
 *
 * **この穴は 2026-08-09 の計画時点から1ミリも動いておらず、`V8-M0` が再測して同じ結果を得た**
 * (`ADR-0336` §1-4)。**下の (T05-d) が、本番からの呼び出しが実在することを機械的に見る。**
 *
 * **【禁止の履行】これを「v8 が既存の穴を塞いだ」と単独で書かない** —— **塞いだのは
 * 「掃除を呼ぶ経路が1本もない」ことだけであり、掃除が走るのは「招待を発行したとき」だけである。**
 * **招待を1度も使わないアプリでは `purgeExpired()` は今日どおり0回である。**
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTable } from "../kernel/resolve-table.ts";
import { appDbPath } from "../kernel/storage-paths.ts";
import type { Manifest } from "../kernel/types.ts";
import { SYSTEM_TABLES } from "../shared/system-tables.ts";
import { isExpired } from "./challenge.ts";
import { findUsableInvitation, INVITATION_TTL_SEC } from "./invitations.ts";
import { AuthStore, INVITATION_CODE_ALPHABET, randomInvitationCode } from "./store.ts";

const APP_ID = "invitations-under-test";

/** リポジトリの `src/`(`entry-point-inventory.test.ts` と同じ採り方)。 */
const SRC = join(import.meta.dir, "..");

/** `src/` からの相対パスでソースを読む。 */
function readSource(relative: string): string {
  return readFileSync(join(SRC, relative), "utf-8");
}

let dataRoot: string;
let store: AuthStore;

/** kernel の create-app に倣って、DELETE モードの空 app.sqlite を用意する。 */
function makeAppSqlite(root: string, appId: string): void {
  mkdirSync(join(root, "apps", appId), { recursive: true });
  const db = new Database(appDbPath(root, appId), { create: true });
  try {
    db.exec("PRAGMA journal_mode = DELETE;");
    db.exec("VACUUM;");
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-invitations-"));
  makeAppSqlite(dataRoot, APP_ID);
  store = AuthStore.openForApp(dataRoot, APP_ID);
});

afterEach(async () => {
  store.close();
  await rm(dataRoot, { recursive: true, force: true });
});

/** `app.sqlite` の表を直に読む(HTTP も `AuthStore` も通さない)。 */
function withRawDb<T>(fn: (db: Database) => T): T {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * **その招待の期限だけを過去にする**(行はそのまま。**時計を動かさない**)。
 * **本番の API を1本も足さないために、テストから生の SQL で書き換える** ——
 * **期限の値を外から受け取る経路を作らないという `ADR-0336` 限定14 を、
 * 実装側に穴を開けずに測るためである。**
 */
function forceExpire(username: string): void {
  const db = new Database(appDbPath(dataRoot, APP_ID));
  try {
    db.query(`UPDATE "_auth_invitations" SET "expires_at" = ? WHERE "username" = ?`).run(
      new Date(Date.now() - 1000).toISOString(),
      username,
    );
  } finally {
    db.close();
  }
}

// =====================================================================================
// (T02) 招待の表 —— `_auth_*` の8本目
// =====================================================================================

test("(T02-a) 招待の表が作られる(`_auth_invitations`)", () => {
  const names = withRawDb((db) =>
    db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name = '_auth_invitations'`,
      )
      .all()
      .map((row) => row.name),
  );
  expect(names).toEqual(["_auth_invitations"]);
});

test("(T02-b) 列は7列ちょうどで、業務データを指す列が1本も無い(`ADR-0336` 限定2)", () => {
  const columns = withRawDb((db) =>
    db
      .query<{ name: string }, []>(`PRAGMA table_info("_auth_invitations")`)
      .all()
      .map((row) => row.name),
  );
  // **相手のユーザID / 与える役割 / コード / 期限 / 発行者 / 発行時刻 / 使用時刻。**
  expect(columns).toEqual([
    "username",
    "role",
    "code",
    "expires_at",
    "issued_by",
    "issued_at",
    "used_at",
  ]);
  expect(columns).toHaveLength(7);

  // **業務データ(アプリのマニフェストが宣言する表・項目)を指す列が1本も無い**
  // (`D-V8-10` の逐語「招待の内容をアプリの業務データ(部署・役職など)と紐づけて
  // 持つことはできない」がそのまま制約になる)。
  for (const forbidden of ["table", "table_id", "record", "record_id", "field", "app_id", "note"]) {
    expect(columns).not.toContain(forbidden);
  }
});

test("(T02-b2) `_auth_users` への外部キーを1本も宣言していない(`ADR-0336` 限定4)", () => {
  const sql = withRawDb(
    (db) =>
      db
        .query<{ sql: string | null }, []>(
          `SELECT sql FROM sqlite_master WHERE type='table' AND name='_auth_invitations'`,
        )
        .get()?.sql ?? "",
  );
  // **相手はまだ登録していないので、参照できる行が存在しない。**
  expect(sql).not.toContain("REFERENCES");
  const foreignKeys = withRawDb((db) =>
    db.query<{ table: string }, []>(`PRAGMA foreign_key_list("_auth_invitations")`).all(),
  );
  expect(foreignKeys).toEqual([]);
});

test("(T02-c) `_auth_*` の本数が 7 → 8 になった(`ADR-0336` 限定1)", () => {
  const names = withRawDb((db) =>
    db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '\\_auth\\_%' ESCAPE '\\' ORDER BY name`,
      )
      .all()
      .map((row) => row.name),
  );
  // **【着手前の逐語】7本だった**: `_auth_activity` / `_auth_password_credentials` /
  // `_auth_pending_challenges` / `_auth_sessions` / `_auth_user_roles` / `_auth_users` /
  // `_auth_webauthn_credentials`。
  expect(names).toEqual([
    "_auth_activity",
    "_auth_invitations",
    "_auth_password_credentials",
    "_auth_pending_challenges",
    "_auth_sessions",
    "_auth_user_roles",
    "_auth_users",
    "_auth_webauthn_credentials",
  ]);
  expect(names).toHaveLength(8);
  // **9本目を作っていない**(履歴表・使用済み表を足していない)。
  expect(names.filter((name) => name.includes("invit"))).toEqual(["_auth_invitations"]);
});

test("(T02-d) `SYSTEM_TABLES`(予約名の投影)は3本のまま(`ADR-0336` 限定3。`Δ2` 非発火)", () => {
  expect(SYSTEM_TABLES.map((table) => table.id)).toEqual(["_apps", "_changelog", "_ai_usage"]);
  expect(SYSTEM_TABLES).toHaveLength(3);
  expect(readSource("shared/system-tables.ts").includes("_auth")).toBe(false);
});

// =====================================================================================
// (T03) コードの発行 —— 8文字 / 32記号
// =====================================================================================

test("(T03-a) 生成されるコードは8文字ちょうど(`ADR-0336` 限定9)", () => {
  for (let i = 0; i < 200; i += 1) {
    expect(randomInvitationCode()).toHaveLength(8);
  }
});

test("(T03-b) 32記号の外の文字が1つも出ない(`I` `L` `O` `U` は出ない)", () => {
  expect(INVITATION_CODE_ALPHABET).toBe("0123456789ABCDEFGHJKMNPQRSTVWXYZ");
  expect(INVITATION_CODE_ALPHABET).toHaveLength(32);
  expect(new Set(INVITATION_CODE_ALPHABET).size).toBe(32);
  for (const excluded of ["I", "L", "O", "U"]) {
    expect(INVITATION_CODE_ALPHABET).not.toContain(excluded);
  }
  const allowed = new Set(INVITATION_CODE_ALPHABET);
  for (let i = 0; i < 500; i += 1) {
    for (const char of randomInvitationCode()) {
      expect(allowed.has(char)).toBe(true);
    }
  }
});

test("(T03-c) 多数回発行すると32記号すべてが出る(偏りの粗い検査)", () => {
  const seen = new Set<string>();
  // 32記号 × 8桁 = 1回あたり8サンプル。2,000回で16,000サンプル。
  // **偏りが無ければ1記号あたり期待500回**なので、1度も出ない記号が在れば異常である。
  for (let i = 0; i < 2000; i += 1) {
    for (const char of randomInvitationCode()) {
      seen.add(char);
    }
  }
  expect([...seen].sort().join("")).toBe(INVITATION_CODE_ALPHABET);
  expect(seen.size).toBe(32);
});

test("(T03-d) 2回発行して同じ値にならない", () => {
  const codes = new Set<string>();
  for (let i = 0; i < 1000; i += 1) {
    codes.add(randomInvitationCode());
  }
  // **32^8 = 1.0995e12 通りなので、1,000本で衝突が出たら乱数源が壊れている。**
  expect(codes.size).toBe(1000);
});

// =====================================================================================
// (T05) 期限・1回きり・掃除
// =====================================================================================

test("(T05-a) 期限は発行時刻 + 24時間ちょうど(`ADR-0336` 限定14)", () => {
  expect(INVITATION_TTL_SEC).toBe(24 * 3600);
  const invitation = store.issueInvitation({
    username: "bob",
    role: "editor",
    issuedBy: "owner-id",
  });
  const issued = Date.parse(invitation.issuedAt);
  const expires = Date.parse(invitation.expiresAt);
  expect(expires - issued).toBe(24 * 3600 * 1000);
  // ISO8601 UTC(辞書順比較で使える形)である。
  expect(invitation.expiresAt).toBe(new Date(expires).toISOString());
});

test("(T05-b) 期限切れの招待では引き換えられない(述語の段階で確かめる)", () => {
  const invitation = store.issueInvitation({
    username: "bob",
    role: "editor",
    issuedBy: "owner-id",
  });
  // 24時間以内は通る。
  expect(findUsableInvitation(store, "bob", invitation.code)?.role).toBe("editor");

  // **期限だけを過去にする**(行はそのまま。時計を動かさない)。
  forceExpire("bob");
  expect(findUsableInvitation(store, "bob", invitation.code)).toBeUndefined();
  // **判定は既存の `isExpired` 1本である**(`ADR-0336` 限定15)。
  expect(isExpired(store.findInvitation("bob")?.expiresAt ?? "")).toBe(true);
  // **行は消えていない**(期限切れでも掃除されるまで残る)。
  expect(store.findInvitation("bob")).toBeDefined();
});

test("(T05-b2) 期限の判定関数は `src/auth/` に1本ちょうど(`ADR-0336` 限定15)", () => {
  const sources = ["auth/challenge.ts", "auth/invitations.ts", "auth/store.ts"];
  const definitions = sources.flatMap((path) =>
    readSource(path)
      .split("\n")
      .filter((line) => /^(export )?function isExpired\(/.test(line))
      .map((line) => `${path}: ${line.trim()}`),
  );
  expect(definitions).toEqual([
    "auth/challenge.ts: export function isExpired(expiresAtIso: string): boolean {",
  ]);
});

test("(T05-c) 1回使った招待は2回目に使えない(行は消さない。`ADR-0336` 限定16)", () => {
  const invitation = store.issueInvitation({
    username: "bob",
    role: "editor",
    issuedBy: "owner-id",
  });
  expect(findUsableInvitation(store, "bob", invitation.code)).toBeDefined();

  expect(store.markInvitationUsed("bob")).toBe(true);

  // 2回目は通らない。
  expect(findUsableInvitation(store, "bob", invitation.code)).toBeUndefined();
  // **行は残り、使用時刻が入っている**(`DELETE … RETURNING` 形を採らなかった)。
  const used = store.findInvitation("bob");
  expect(used?.usedAt).not.toBeNull();
  expect(store.listInvitations()).toHaveLength(1);
  // 2度目の消費は偽を返す(冪等に落とす。枠が2回使えない)。
  expect(store.markInvitationUsed("bob")).toBe(false);
});

test("(T05-c2) 取り消した招待は使えない(取り消しも同じ列で表す)", () => {
  const invitation = store.issueInvitation({
    username: "bob",
    role: "editor",
    issuedBy: "owner-id",
  });
  expect(store.revokeInvitation("bob")?.usedAt).not.toBeNull();
  expect(findUsableInvitation(store, "bob", invitation.code)).toBeUndefined();
  expect(store.listInvitations()).toHaveLength(1);
});

test("(T05-c3) 出し直しは行を差し替える(同じ相手に有効な招待が2件同時に存在しない)", () => {
  const first = store.issueInvitation({ username: "bob", role: "editor", issuedBy: "owner-id" });
  const second = store.issueInvitation({ username: "bob", role: "viewer", issuedBy: "owner-id" });
  expect(store.listInvitations()).toHaveLength(1);
  expect(second.code).not.toBe(first.code);
  // 古いコードはもう通らない。**新しいコードが通る。**
  expect(findUsableInvitation(store, "bob", first.code)).toBeUndefined();
  expect(findUsableInvitation(store, "bob", second.code)?.role).toBe("viewer");
});

test("(T05-c4) コードが違えば通らない / 相手が違えば通らない", () => {
  const invitation = store.issueInvitation({
    username: "bob",
    role: "editor",
    issuedBy: "owner-id",
  });
  expect(findUsableInvitation(store, "bob", "AAAAAAAA")).toBeUndefined();
  expect(findUsableInvitation(store, "carol", invitation.code)).toBeUndefined();
});

test("(T05-e) 掃除は期限切れの招待だけを消す(有効な招待と使用済みの有効な招待は残す)", () => {
  store.issueInvitation({ username: "alive", role: "editor", issuedBy: "owner-id" });
  store.issueInvitation({ username: "used", role: "editor", issuedBy: "owner-id" });
  store.markInvitationUsed("used");
  store.issueInvitation({ username: "stale", role: "editor", issuedBy: "owner-id" });
  forceExpire("stale");

  expect(store.purgeExpiredInvitations()).toBe(1);
  expect(store.listInvitations().map((invitation) => invitation.username)).toEqual([
    "alive",
    "used",
  ]);
});

test("(T05-d) 掃除の呼び出しが本番(非テスト)に実在する", () => {
  // **着手前は「定義1 / テスト2 / 本番0」だった**(このファイル冒頭に全出力を逐語で貼ってある)。
  const routes = readSource("server/auth-routes.ts");
  // **巨大な文字列を `toContain` に渡すと、落ちたときに全文が出る**ので真偽で見る。
  expect(routes.includes("store.purgeExpired()")).toBe(true);
  expect(routes.includes("store.purgeExpiredInvitations()")).toBe(true);
  // **5本目のスケジューラを足していない**(`ADR-0336` 限定19)。
  const index = readSource("server/index.ts");
  expect(index.includes("purgeExpired")).toBe(false);
  expect(index.includes("nvitation")).toBe(false);
});

// =====================================================================================
// (T06) AI から見えないこと(`I-G11`)
// =====================================================================================

test("(T06-a) MCP の道具は23本のまま(招待に触れる道具を1本も作っていない)", () => {
  const source = readSource("mcp/descriptions.test.ts");
  const start = source.indexOf("const EXPECTED_TOOL_NAMES");
  const block = source.slice(start, source.indexOf("] as const;", start));
  const names = block
    .split("\n")
    .map((line) => /^\s{2}"([a-z_]+)",$/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);
  /*
   * **【2026-08-15。`V8-M13-T02`。台帳 `Q-G28` = 限定採用(門A)。旧文を1バイトも
   *   消していない】** **旧行の逐語**: `expect(names).toHaveLength(23);`
   *
   * **【軸2 が軸1 の限定を偽にした】** —— **`ADR-0336` 限定7 の逐語は「**MCP ツールを
   *   1本も足さない**(23本のまま)」であり、本ファイルの冒頭(`:16`)がその写しである。**
   *   **軸1(招待)は今日も1本も足していない** —— **足したのは軸2(集計表)の
   *   `read_report` 1本であり、招待には1文字も触れていない。**
   * **【したがって限定7 の意図(招待に触れる道具を作らない)は今日も守られている】** ——
   *   **偽になったのは「23本のまま」という**本数の言い方**のほうだけである。**
   *   **下の2行(招待の綴りが1つも無いこと)は1バイトも緩めていない。**
   * **【`ADR-0336` 限定7 の引き直しは `V8-M13-T07` へ渡す】** —— **本タスクは ADR を
   *   1本も起草していない。** **`ADR-0176` 限定2 / `ADR-0327` と同じ束で扱われる。**
   * **テスト名は1バイトも書き換えていない**(「23本のまま」は 2026-08-14 までの事実)。
   */
  /*
   * **【2026-08-24。`V10-M12-T01`。台帳 `CM-G7` = 限定採用(門A)。`ADR-0368`】**
   * **期待値を 24 → 25 へ書き換えた。** **旧行の逐語**: `expect(names).toHaveLength(24);`
   * **25本目は `list_comments`(積まれたコメントを読む参照系)1本であり、招待には
   * 1文字も触れていない。** **下の2行(招待の綴りが1つも無いこと)は1バイトも緩めていない。**
   */
  /*
   * **【2026-08-25。`V10-M30-T02`。台帳 `CM-G37` = 限定採用(門A)。`ADR-0378`】**
   * **期待値を 25 → 26 へ書き換えた。** **旧行の逐語**: `expect(names).toHaveLength(25);`
   * **26本目は `set_comment_visibility`(アプリごとのコメントの出し入れを切り替える更新系)
   * 1本であり、招待には1文字も触れていない。** **下の2行(招待の綴りが1つも無いこと)は
   * 1バイトも緩めていない。**
   */
  expect(names).toHaveLength(26);
  expect(names.filter((name) => name.includes("invit"))).toEqual([]);
  // `src/mcp/` に招待の綴りが1つも無い(**0バイトの担保**)。
  expect(readSource("mcp/vocabulary.ts").includes("_auth_invitations")).toBe(false);
});

test("(T06-b) 招待の表は `resolveTable` の射程に入らない(`list_records` から読めない)", () => {
  const manifest = {
    app: {
      id: APP_ID,
      name: "招待の射程",
      tables: [{ id: "books", name: "本", fields: [{ id: "title", name: "題", type: "text" }] }],
      views: [],
    },
  } as unknown as Manifest;
  // **解決できる集合 = `SYSTEM_TABLES`(3本)∪ `manifest.app.tables`。**
  expect(resolveTable(manifest, "_auth_invitations")).toBeUndefined();
  expect(resolveTable(manifest, "_auth_users")).toBeUndefined();
  expect(resolveTable(manifest, "books")?.id).toBe("books");
  expect(resolveTable(manifest, "_apps")?.id).toBe("_apps");
});
