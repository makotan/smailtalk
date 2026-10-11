/**
 * **行の変更履歴の内部表 `_record_history`**(サーバの層。HTTP の口も MCP の道具も1本も置かない)。
 *
 * - 内部表は `app.sqlite` に置く。 `_auth_` で始めず、システム表にもしない(records の口・`view.table`・
 *   一括・MCP の書込と読取の道具からは名指しできない。 `_` で始まる名前は今日どの口からも断られる)。
 * - 作るのは、`history: true` の表へ書く直前(と、その表の行の招待を書く直前)の `CREATE TABLE IF NOT EXISTS`
 *   だけ。 宣言の無いアプリの `app.sqlite` は1バイトも変えない。 古いスナップショットへ戻した後もこれで書ける。
 * - 書くのは、`records.ts` の作成・更新・削除の器の中と、行の招待の書込の器の中(どちらも書込と同じ
 *   トランザクション)。 記録が落ちれば、業務の書込も成り立たない。
 * - カーネルの公開の識別子を増やさないため、カーネルの外のこのファイルに置く(`records.ts` は今日すでに
 *   サーバの層の `owner-scope.ts` を読んでいる)。
 */
import type { Database } from "bun:sqlite";
import { AuthStore } from "../auth/store.ts";
import {
  isSharedOwner,
  OWNER_FIELD,
  ownerDisplayName,
  UNRESOLVED_OWNER_DISPLAY,
} from "./owner-scope.ts";

const RECORD_HISTORY_DDL = `CREATE TABLE IF NOT EXISTS _record_history (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  op TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_login TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  entry TEXT NOT NULL,
  at TEXT NOT NULL,
  changes TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS _record_history_by_row ON _record_history (table_id, record_id, seq);`;

/** 履歴の1件の操作(作成・更新・削除と、行の招待の4つ。7値)。 */
type HistoryOp =
  | "create"
  | "update"
  | "delete"
  | "invite"
  | "invite_accept"
  | "invite_decline"
  | "invite_revoke";

/** 入口(6値)。 */
type HistoryEntryPoint = "http" | "manual" | "inbound" | "on_create/on_update" | "schedule" | "mcp";

/** 項目ごとの変更(値は今日の読み出しの形のまま)。 */
type FieldChange = { field: string; before: unknown; after: unknown };

/** 招待の記録の中身(項目を持たない。招かれた人と配る権限名)。 */
type InviteChange = { invitee: string; permission: string };

/** 記録の1件。 */
type HistoryRecord = {
  tableId: string;
  recordId: string;
  op: HistoryOp;
  actor: { readonly id: string; readonly login: string; readonly role: string } | undefined;
  entry: HistoryEntryPoint;
  at: string;
  changes: readonly FieldChange[] | readonly InviteChange[];
};

/**
 * 履歴を1件足す(表が無ければ作る)。 **呼び手の器(トランザクション)の中で呼ぶ** —— 落ちれば書込ごと巻き戻る。
 * 操作者が無ければ3つとも空文字。
 */
export function appendRecordHistory(db: Database, record: HistoryRecord): void {
  db.exec(RECORD_HISTORY_DDL);
  db.query(
    `INSERT INTO _record_history (table_id, record_id, op, actor_id, actor_login, actor_role, entry, at, changes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.tableId,
    record.recordId,
    record.op,
    record.actor?.id ?? "",
    record.actor?.login ?? "",
    record.actor?.role ?? "",
    record.entry,
    record.at,
    JSON.stringify(record.changes),
  );
}
/**
 * **行の招待の書込と、その行の履歴の1件を同じ器で書く**(招待の発行・辞退・取消は、今日は器の外で書いている)。
 * 招待の先の行の表が宣言していない(`record` が `undefined`)ときは器を開かず、書込だけを今日の形で呼ぶ。
 * 書込が成り立たなかったとき(`written` が偽)は履歴を足さない。
 */
export function withInvitationHistory<T>(
  db: Database,
  write: () => T,
  record: HistoryRecord | undefined,
  written: (result: T) => boolean,
): T {
  if (record === undefined) {
    return write();
  }
  return db.transaction((): T => {
    const result = write();
    if (written(result)) {
      appendRecordHistory(db, record);
    }
    return result;
  })();
}

// =====================================================================================
// **読む側**(`V23-M8-T05`。HTTP の単件 GET の `?history=1` と MCP の `list_record_history` の両方から呼ぶ)
// =====================================================================================

/** 読み出した1件(HTTP と MCP で同じ形)。 */
type HistoryItem = {
  seq: number;
  op: HistoryOp;
  /** 変えた人の名前(表示名、無ければログイン名。引けなければ「(不明なユーザ)」。操作者の無い書込は空)。 */
  actor: string;
  entry: HistoryEntryPoint;
  at: string;
  changes: FieldChange[] | InviteChange[];
};

/** 1ページ(HTTP は `history` の鍵の下、MCP は応答そのもの)。 */
type HistoryPage = { items: HistoryItem[]; total: number; offset: number; limit: number };

/** 内部表が在るか(読む側は作らない。 無ければ0件として扱う)。 */
function hasRecordHistoryTable(db: Database): boolean {
  return (
    (db
      .query<{ n: number }, []>(
        "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = '_record_history'",
      )
      .get()?.n ?? 0) > 0
  );
}

/**
 * **利用者の id から名前への写像**(更新者の欄の差し替えと同じ引き当て。 `_auth_users` を1回だけ読む)。
 */
export function recordHistoryDisplayNames(
  dataRoot: string,
  appId: string,
): () => ReadonlyMap<string, string> {
  let names: ReadonlyMap<string, string> | undefined;
  return () => {
    if (names === undefined) {
      const store = AuthStore.openForApp(dataRoot, appId);
      try {
        names = new Map(
          store
            .listUsers()
            .map((user) => [user.id, ownerDisplayName(user.displayName, user.username)]),
        );
      } finally {
        store.close();
      }
    }
    return names;
  };
}

/**
 * **消した行の最後の姿**(最も新しい削除の記録の変更前の値)。 消した行の履歴を運営が読むとき、
 * 隠す項目を決める「今の行」の代わりに使う。 削除の記録が無ければ `undefined`。
 */
export function deletedRowSnapshot(
  db: Database,
  tableId: string,
  recordId: string,
): Record<string, unknown> | undefined {
  if (!hasRecordHistoryTable(db)) {
    return undefined;
  }
  const found = db
    .query<{ changes: string }, [string, string]>(
      "SELECT changes FROM _record_history WHERE table_id = ? AND record_id = ? AND op = 'delete' ORDER BY seq DESC LIMIT 1",
    )
    .get(tableId, recordId);
  if (found === null) {
    return undefined;
  }
  const row: Record<string, unknown> = { _id: recordId };
  for (const change of JSON.parse(found.changes) as FieldChange[]) {
    row[change.field] = change.before;
  }
  return row;
}

/**
 * **1行の履歴を新しい順に読み、項目を落としてからページを切る。**
 *
 * - `hidden`(今の行に項目の規則を1回当てて落ちた項目)と、今のマニフェストに無い項目(`known` に無い項目。
 *   消した項目)は、変更前と変更後の両方を落とす。
 * - 落とした後に変更が1つも残らない更新は出さない。 `total` は絞った後の数(全件を読んでから絞り、ページを切る)。
 * - 招待の記録は項目を持たないので落ちない。 招かれた人は名前に差し替える(まだ居ない人の名前・行の鍵はそのまま)。
 * - 変えた人と `st_owner` の値は名前に差し替える(引けない id は「(不明なユーザ)」、空は空)。
 * - 内部表が無ければ0件(作らない)。
 */
export function readRecordHistoryPage(
  db: Database,
  input: {
    tableId: string;
    recordId: string;
    known: ReadonlySet<string>;
    hidden: ReadonlySet<string>;
    displayNames: () => ReadonlyMap<string, string>;
    /**
     * **【`V23-M12-T04`。`D-V23-357`・`D-V23-367`・`D-V23-401`】行のコードの招待の相手(`row:<表>:<行ID>`)の名前**。
     * 見せてよい人にだけ名前(行が消えた・代表項目が隠れるなら「(表示できません)」)を返し、`undefined` なら行の鍵のまま。
     * 渡さない呼び出し(AI の口。`D-V23-402`)は今日どおり行の鍵。
     */
    principalName?: (tableId: string, recordId: string) => string | undefined;
    offset: number;
    limit: number;
  },
): HistoryPage {
  if (!hasRecordHistoryTable(db)) {
    return { items: [], total: 0, offset: input.offset, limit: input.limit };
  }
  const rows = db
    .query<
      {
        seq: number;
        op: HistoryOp;
        actor_id: string;
        entry: HistoryEntryPoint;
        at: string;
        changes: string;
      },
      [string, string]
    >(
      "SELECT seq, op, actor_id, entry, at, changes FROM _record_history WHERE table_id = ? AND record_id = ? ORDER BY seq DESC",
    )
    .all(input.tableId, input.recordId);
  const nameOf = (id: string): string =>
    id === "" ? "" : (input.displayNames().get(id) ?? UNRESOLVED_OWNER_DISPLAY);
  const ownerValue = (value: unknown): unknown =>
    isSharedOwner(value) || typeof value !== "string" ? value : nameOf(value);
  // 【`V23-M12-T04`】行のコードの招待の相手は、`principalName` が名前を返したときだけ名前(招待・承諾・辞退・取消の4つとも)。
  const principalInviteeOf = (invitee: string): string => {
    const rest = invitee.slice("row:".length);
    const at = rest.indexOf(":");
    if (input.principalName === undefined || at <= 0) {
      return invitee;
    }
    return input.principalName(rest.slice(0, at), rest.slice(at + 1)) ?? invitee;
  };
  // 招かれた人: 利用者の id は名前に。 まだ居ない人は記録の時の名前(`login:<名前>`)、行のコードの招待は行の鍵のまま。
  // 【`V23-M12-T04` 訂正(2026-10-04)。直前の1行を消していない】行のコードの招待は、見せてよい人には相手の行の名前。
  const inviteeOf = (invitee: string): string =>
    invitee.startsWith("login:")
      ? invitee.slice("login:".length)
      : invitee.startsWith("row:")
        ? principalInviteeOf(invitee)
        : nameOf(invitee);
  const items: HistoryItem[] = [];
  for (const row of rows) {
    const parsed = JSON.parse(row.changes) as unknown[];
    let changes: FieldChange[] | InviteChange[];
    if (row.op.startsWith("invite")) {
      changes = (parsed as InviteChange[]).map((change) => ({
        invitee: inviteeOf(change.invitee),
        permission: change.permission,
      }));
    } else {
      changes = (parsed as FieldChange[])
        .filter((change) => input.known.has(change.field) && !input.hidden.has(change.field))
        .map((change) =>
          change.field === OWNER_FIELD
            ? {
                field: change.field,
                before: ownerValue(change.before),
                after: ownerValue(change.after),
              }
            : change,
        );
      if (row.op === "update" && changes.length === 0) {
        continue;
      }
    }
    items.push({
      seq: row.seq,
      op: row.op,
      actor: nameOf(row.actor_id),
      entry: row.entry,
      at: row.at,
      changes,
    });
  }
  return {
    items: items.slice(input.offset, input.offset + input.limit),
    total: items.length,
    offset: input.offset,
    limit: input.limit,
  };
}
