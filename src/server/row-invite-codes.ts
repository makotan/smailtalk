/**
 * **行の招待用コードの内部表 `_row_invite_codes`**(`V23-M6-T05`。`ADR-0538` §Decision 1-5。決定 `D-V23-153`・
 * `D-V23-167`・`D-V23-169`)。 **この内部表の SQL はこのファイルにだけ置く**(`ADR-0538` 式11)。 口は置かない
 * (口は `app.ts` の2本。誰が見られるかの判定は判定の家 `owner-scope.ts` の `rowInvitationAccess`)。
 *
 * - 置き場は `app.sqlite`。 `_auth_` で始めず、システム表にもしない(`src/auth/store.ts` には置かない)。
 * - **表を作るのは、発行の口が書く接続の中で `CREATE TABLE IF NOT EXISTS` を流すときだけ**(見る口は表を作らない)。
 *   口は、どこかの表の `grant.principal_row.table` がその表を指すアプリでしか開かない。
 * - 行ごとにコードを1つ(期限は無い)。 **再発行は置き換えで、旧コードは引けなくなる。** 旧コードの頃に作られた
 *   付与の行には触れない。
 * - 形式は登録用の招待コードと同じ32字表の8文字(生成は既存の {@link randomInvitationCode} をそのまま使う)。
 */
import type { Database } from "bun:sqlite";
import { randomInvitationCode } from "../auth/invitations.ts";

const ROW_INVITE_CODES_DDL = `CREATE TABLE IF NOT EXISTS _row_invite_codes (
  table_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  issued_by TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  PRIMARY KEY (table_id, record_id)
)`;

/** 内部表を作る(在れば何もしない)。 **発行の口の書く器の中でだけ呼ぶ。** */
export function ensureRowInviteCodesTable(db: Database): void {
  db.exec(ROW_INVITE_CODES_DDL);
}

/** 表が在るか(見るだけ。作らない)。 */
function hasRowInviteCodesTable(db: Database): boolean {
  return (
    db
      .query<{ n: number }, []>(
        "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = '_row_invite_codes'",
      )
      .get()?.n === 1
  );
}

/** **その行のコードを見る(書かない)。** 表が無い・コードが無ければ `null`(`D-V23-169`)。 */
export function readRowInviteCode(db: Database, tableId: string, recordId: string): string | null {
  if (!hasRowInviteCodesTable(db)) {
    return null;
  }
  const found = db
    .query<{ code: string }, [string, string]>(
      "SELECT code FROM _row_invite_codes WHERE table_id = ? AND record_id = ?",
    )
    .get(tableId, recordId);
  return found?.code ?? null;
}

/**
 * **その行のコードを発行する(在れば置き換える)。** 新しいコードを返す。 表は呼ぶ側が
 * {@link ensureRowInviteCodesTable} で作ってから呼ぶ。 偶然ほかの行のコードと重なったら引き直す。
 */
export function issueRowInviteCode(
  db: Database,
  tableId: string,
  recordId: string,
  issuedBy: string,
  nowIso: string,
): string {
  let code = randomInvitationCode();
  while (findRowByInviteCode(db, code) !== undefined) {
    code = randomInvitationCode();
  }
  db.query(
    `INSERT INTO _row_invite_codes (table_id, record_id, code, issued_by, issued_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (table_id, record_id) DO UPDATE SET
         code = excluded.code, issued_by = excluded.issued_by, issued_at = excluded.issued_at`,
  ).run(tableId, recordId, code, issuedBy, nowIso);
  return code;
}

/** **コードから行を引く**(コードの招待で使う。表が無い・無いコードは `undefined`)。 */
export function findRowByInviteCode(
  db: Database,
  code: string,
): { table_id: string; record_id: string } | undefined {
  if (!hasRowInviteCodesTable(db)) {
    return undefined;
  }
  return (
    db
      .query<{ table_id: string; record_id: string }, [string]>(
        "SELECT table_id, record_id FROM _row_invite_codes WHERE code = ?",
      )
      .get(code) ?? undefined
  );
}

/** **【`V23-M12-T02`。`D-V23-354`】行が消えたとき、その行の招待用コードを消す**(表が無ければ何もしない)。 */
export function deleteRowInviteCodeForRow(db: Database, tableId: string, recordId: string): number {
  if (!hasRowInviteCodesTable(db)) {
    return 0;
  }
  return db
    .query("DELETE FROM _row_invite_codes WHERE table_id = ? AND record_id = ?")
    .run(tableId, recordId).changes;
}
