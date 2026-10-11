/**
 * **行の招待の内部表**(`V23-M5-T03`。`ADR-0532` §Decision 1-6。決定 `D-V23-120`・`D-V23-122`・
 * `D-V23-132`・`D-V23-133` 中7・`D-V23-134` (5))。
 *
 * - **このファイルは内部表の SQL だけを持つ。 口(`app.get` / `app.post` / `app.use`)は1本も置かない**
 *   (口は `app.ts`。`ROUTE_FILES` は5本のまま。`ADR-0532` 式10)。
 * - 内部表 `_row_invitations` は `app.sqlite` に置く。 `_auth_` で始めず、システム表にもせず、
 *   `store.ts` にも置かない(登録用の招待 `_auth_invitations` は1バイトも変えない)。
 * - **作り方は `CREATE TABLE IF NOT EXISTS`**(undo で表ごと消えうるため、書く接続で毎回流す。先例は
 *   名簿の一意索引)。 **流すのは招待の口の中で、そのアプリが招待を宣言しているときだけ**
 *   (呼び出し側が守る。宣言の無いアプリの `app.sqlite` に表を作らない)。
 * - **行は未承諾の招待だけを持つ。** 承諾・辞退・取消で行を消す。 期限切れは招待の口のリクエストの中で消す
 *   (スケジューラを足さない)。
 * - **同じ行・同じ相手には1行。** 相手は、発行の時点で結びつけた利用者の ID(在れば)、無ければ打たれた
 *   ログイン名で見分ける。 発行し直すと権限・招待者・期限を上書きする(招待の ID は替えない)。
 * - 時刻は ISO 8601(UTC、`toISOString()`)の文字列で持ち、文字列の大小で比べる。
 */
import type { Database } from "bun:sqlite";

/** 内部表の DDL。 列を足すときは、既に在る表に効かないことに注意(`IF NOT EXISTS`)。 */
const ROW_INVITATIONS_DDL = `CREATE TABLE IF NOT EXISTS _row_invitations (
  id TEXT PRIMARY KEY,
  table_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  invitee_login TEXT NOT NULL,
  invitee_user_id TEXT NOT NULL DEFAULT '',
  invitee_key TEXT NOT NULL,
  permission TEXT NOT NULL,
  inviter_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE (table_id, record_id, invitee_key)
)`;

/** 内部表の1行。 */
export type RowInvitation = {
  id: string;
  table_id: string;
  record_id: string;
  /** 招待する人が打ったログイン名(そのまま)。 */
  invitee_login: string;
  /** 発行の時点で結びつけた利用者の ID。 その名前の利用者がいなければ空(誰にも届かない)。 */
  invitee_user_id: string;
  /**
   * **【`V23-M6-T06`】相手の見分け**(`user:<利用者ID>` / `login:<ログイン名>` / コードの招待は `row:<表>:<行ID>`)。
   * 読むときだけ持つ(書くときは {@link upsertRowInvitation} が組む)。
   */
  invitee_key: string;
  permission: string;
  inviter_id: string;
  created_at: string;
  expires_at: string;
};

/** 内部表を作る(在れば何もしない)。 招待を宣言したアプリの、招待の口の中でだけ呼ぶ。 */
export function ensureRowInvitationsTable(db: Database): void {
  db.exec(ROW_INVITATIONS_DDL);
}

/** 期限を過ぎた招待を消す(招待の口のリクエストの中で呼ぶ)。 消した行の数を返す。 */
export function purgeExpiredRowInvitations(db: Database, nowIso: string): number {
  return db.query("DELETE FROM _row_invitations WHERE expires_at <= ?").run(nowIso).changes;
}

/**
 * 招待を1行書く。 同じ行・同じ相手の未承諾の招待が在れば、権限・打たれた名前・招待者・発行時刻・期限を
 * 上書きする(ID は替えない)。
 */
export function upsertRowInvitation(
  db: Database,
  // 【2026-10-01。`V23-M6-T06`】旧の型(逐語): `invitation: Omit<RowInvitation, "id"> & { id: string },`
  // 鍵(`invitee_key`)を省けば旧と同じ鍵を組む。 コードの招待だけが {@link principalRowInviteeKey} の鍵を渡す。
  invitation: Omit<RowInvitation, "id" | "invitee_key"> & { id: string; invitee_key?: string },
): void {
  const key =
    invitation.invitee_key ??
    (invitation.invitee_user_id !== ""
      ? `user:${invitation.invitee_user_id}`
      : `login:${invitation.invitee_login}`);
  db.query(
    `INSERT INTO _row_invitations
       (id, table_id, record_id, invitee_login, invitee_user_id, invitee_key, permission, inviter_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (table_id, record_id, invitee_key) DO UPDATE SET
       invitee_login = excluded.invitee_login,
       permission = excluded.permission,
       inviter_id = excluded.inviter_id,
       created_at = excluded.created_at,
       expires_at = excluded.expires_at`,
  ).run(
    invitation.id,
    invitation.table_id,
    invitation.record_id,
    invitation.invitee_login,
    invitation.invitee_user_id,
    key,
    invitation.permission,
    invitation.inviter_id,
    invitation.created_at,
    invitation.expires_at,
  );
}

// 【2026-10-01。`V23-M6-T06`】`invitee_key` を足した(コードの招待の宛先を読むため)。 旧の列(逐語):
//   "id, table_id, record_id, invitee_login, invitee_user_id, permission, inviter_id, created_at, expires_at"
const COLUMNS =
  "id, table_id, record_id, invitee_login, invitee_user_id, invitee_key, permission, inviter_id, created_at, expires_at";

/** その行の未承諾の招待(発行の古い順)。 */
export function listRowInvitationsForRecord(
  db: Database,
  tableId: string,
  recordId: string,
): RowInvitation[] {
  return db
    .query<RowInvitation, [string, string]>(
      `SELECT ${COLUMNS} FROM _row_invitations WHERE table_id = ? AND record_id = ? ORDER BY created_at, id`,
    )
    .all(tableId, recordId);
}

/**
 * **自分宛ての未承諾の招待**(`V23-M5-T05`。発行の古い順)。 相手は発行の時点で結びつけた利用者の ID だけで
 * 見る(打たれたログイン名では引かない。`D-V23-132`)。 期限を過ぎた招待は含めない。
 */
export function listRowInvitationsForInvitee(
  db: Database,
  userId: string,
  nowIso: string,
): RowInvitation[] {
  if (userId === "") {
    return [];
  }
  return db
    .query<RowInvitation, [string, string]>(
      `SELECT ${COLUMNS} FROM _row_invitations WHERE invitee_user_id = ? AND expires_at > ? ORDER BY created_at, id`,
    )
    .all(userId, nowIso);
}

// =====================================================================================
// **【`V23-M6-T06`】コードの招待**(`ADR-0538` §Decision 1-6。決定 `D-V23-154`・`D-V23-168`)
// =====================================================================================
//
// - 列は足さない(`D-V23-168`)。 宛先の行(S)は鍵 `invitee_key` に `row:<表>:<行ID>` で持ち、
//   `invitee_login` と `invitee_user_id` は空文字。 同じ R・同じ S には1行(`UNIQUE`。発行し直すと上書き)。
// - 誰に届くか(S の管理者か)は判定の家 `owner-scope.ts` が答える。 ここは SQL と鍵の形だけ。

const PRINCIPAL_ROW_KEY_PREFIX = "row:";

/** コードの招待の鍵(`row:<表>:<行ID>`)。 */
export function principalRowInviteeKey(tableId: string, recordId: string): string {
  return `${PRINCIPAL_ROW_KEY_PREFIX}${tableId}:${recordId}`;
}

/** コードの招待なら宛先の行(S)を返す。 名前の招待は `undefined`。 */
export function principalRowOfInvitation(
  invitation: Pick<RowInvitation, "invitee_key">,
): { tableId: string; recordId: string } | undefined {
  const key = invitation.invitee_key;
  if (!key.startsWith(PRINCIPAL_ROW_KEY_PREFIX)) {
    return undefined;
  }
  const rest = key.slice(PRINCIPAL_ROW_KEY_PREFIX.length);
  const at = rest.indexOf(":");
  if (at <= 0 || at === rest.length - 1) {
    return undefined;
  }
  return { tableId: rest.slice(0, at), recordId: rest.slice(at + 1) };
}

/** **期限内のコードの招待の全部**(発行の古い順)。 誰に届くかは呼ぶ側が判定の家で絞る。 */
export function listRowCodeInvitations(db: Database, nowIso: string): RowInvitation[] {
  return db
    .query<RowInvitation, [string, string]>(
      `SELECT ${COLUMNS} FROM _row_invitations WHERE substr(invitee_key, 1, 4) = ? AND expires_at > ? ORDER BY created_at, id`,
    )
    .all(PRINCIPAL_ROW_KEY_PREFIX, nowIso);
}

/** 招待を ID で1行引く。 無ければ `undefined`。 */
export function findRowInvitation(db: Database, id: string): RowInvitation | undefined {
  return (
    db
      .query<RowInvitation, [string]>(`SELECT ${COLUMNS} FROM _row_invitations WHERE id = ?`)
      .get(id) ?? undefined
  );
}

/** 招待を ID で1行消す。 消せたら `true`。 */
export function deleteRowInvitation(db: Database, id: string): boolean {
  return db.query("DELETE FROM _row_invitations WHERE id = ?").run(id).changes === 1;
}

/**
 * **【`V23-M12-T02`。`D-V23-354`】親の行が消えたとき、その行への招待と、その行を相手にしたコードの招待を消す。**
 * 表が無ければ何もしない(作らない)。 消した行の数を返す。
 */
export function deleteRowInvitationsForRow(
  db: Database,
  tableId: string,
  recordId: string,
): number {
  const exists =
    db
      .query<{ n: number }, []>(
        "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = '_row_invitations'",
      )
      .get()?.n === 1;
  if (!exists) {
    return 0;
  }
  return db
    .query("DELETE FROM _row_invitations WHERE (table_id = ? AND record_id = ?) OR invitee_key = ?")
    .run(tableId, recordId, principalRowInviteeKey(tableId, recordId)).changes;
}
