/**
 * **登録と役割の付与で、宣言した名簿へ自動で1行入れる**(`V23-M1-T04`。単位 `SC-G1`。上位:
 * `docs/adr/0497-auto-enroll-and-last-row-admin.md` §Decision 1、
 * `docs/adr/0510-v23-m1-guard-authorization-and-pre-start-decisions.md` §Decision 3)。
 *
 * 呼ぶのは `auth-routes.ts` の3か所だけ(passkey の登録・password の登録・`PATCH .../auth/users/:user_id`)。
 * どこも `AuthStore.runInTransaction` の中から、利用者の作成・役割の付与と同じ接続で呼ぶ。
 * 書けなければ {@link AutoEnrollRefused} を投げ、呼び手のトランザクションごと巻き戻す。
 * 宣言の無いアプリでは何もしない(1バイトも書かない)。
 */
import type { Database } from "bun:sqlite";
import {
  deleteRecord,
  type Manifest,
  quoteIdentifier,
  type ValidationError,
} from "../kernel/index.ts";
import { autoEnrollTargets, enrollUserOnDb } from "./auto-enroll-backfill.ts";
import { accessControlOf } from "./owner-scope.ts";

/** 名簿の行が書けなかったことを、トランザクションの外へ運ぶ。 */
export class AutoEnrollRefused extends Error {
  constructor(readonly errors: ValidationError[]) {
    super("名簿へ自動で入れる行を書けませんでした。");
  }
}

/** `manifestFor` が返す値(読めなければ `undefined`)を、表の一覧を持つ定義として読めるときだけ返す。 */
function asManifest(manifest: unknown): Manifest | undefined {
  const app = (manifest as { app?: { tables?: unknown } } | null | undefined)?.app;
  return Array.isArray(app?.tables) ? (manifest as Manifest) : undefined;
}

/**
 * 宣言した名簿へ、その人の行を1行入れる(対象の役割を実効で持ち、行がまだ無いときだけ)。
 * 書けなければ {@link AutoEnrollRefused} を投げる。
 */
export function enrollIfDeclared(
  db: Database,
  manifest: unknown,
  user: { id: string; username: string },
  /**
   * **【`V23-M4-T03`】名簿の行の作成が起こす発火の `$actor`**(`enrollUserOnDb` と同じ)。
   * 【`V23-M8-T03`】入口 `entry` は変更履歴の入口の値(`$actor` としては解かない)。
   */
  origin?: {
    readonly id: string;
    readonly login: string;
    readonly role: string;
    readonly entry?: "http" | "manual" | "inbound" | "on_create/on_update" | "schedule" | "mcp";
  },
): void {
  const readable = asManifest(manifest);
  if (readable === undefined) {
    return;
  }
  const refused = enrollUserOnDb(db, readable, user, origin);
  if (refused.length > 0) {
    throw new AutoEnrollRefused(refused);
  }
}

/**
 * **退会の連鎖**(`V23-M1-T06`。単位 `SC-G3`。`ADR-0497` 限定7)。
 *
 * 自動登録を宣言した名簿から、その人の行(`account` = 利用者 ID)と、その行を相手にした付与の行を消す。
 * 宣言していない名簿は今日どおり1行も消さない。 呼ぶのは `DELETE /api/apps/:app_id/auth/me` だけで、
 * 利用者の削除と同じトランザクションの中から呼ぶ(削除が断られたら、ここで消した行も戻る)。
 * 行の書込の判定(面と点・個人所有・親の関門)も自動処理も掛けない書込点である(`ADR-0510` §Decision 6)。
 */
export function withdrawFromDeclaredRosters(
  db: Database,
  manifest: unknown,
  userId: string,
  /**
   * **【`V23-M8-T03`】退会する本人**(入口 `http`)。 名簿表・付与表が変更履歴を宣言(`history: true`)して
   * いるときだけ、その表の消す行ごとに `deleteRecord` へ回す(宣言が無ければ今日の生の SQL のまま)。
   * `deleteRecord` は行の書込の判定も自動処理も掛けない。 断られたら呼び手のトランザクションごと巻き戻す。
   */
  origin?: {
    readonly id: string;
    readonly login: string;
    readonly role: string;
    readonly entry?: "http" | "manual" | "inbound" | "on_create/on_update" | "schedule" | "mcp";
  },
): void {
  const readable = asManifest(manifest);
  if (readable === undefined) {
    return;
  }
  const rosters = autoEnrollTargets(readable);
  if (rosters.length === 0) {
    return;
  }
  for (const roster of rosters) {
    const rosterIds = db
      .query<{ id: string }, [string]>(
        `SELECT ${quoteIdentifier("_id")} AS "id" FROM ${quoteIdentifier(roster.table)} WHERE ${quoteIdentifier(roster.account)} = ?`,
      )
      .all(userId)
      .map((row) => row.id);
    if (rosterIds.length === 0) {
      continue;
    }
    // その名簿を相手の表にした付与の宣言ごとに、その人の名簿の行を指す付与の行を消す。
    for (const table of readable.app.tables) {
      const declared = accessControlOf(table);
      const grantTable = declared?.grant?.table;
      const memberColumn = declared?.grant?.member;
      if (
        declared?.members?.table !== roster.table ||
        grantTable === undefined ||
        memberColumn === undefined
      ) {
        continue;
      }
      const placeholders = rosterIds.map(() => "?").join(", ");
      if (readable.app.tables.find((candidate) => candidate.id === grantTable)?.history === true) {
        const grantIds = db
          .query<{ id: string }, string[]>(
            `SELECT ${quoteIdentifier("_id")} AS "id" FROM ${quoteIdentifier(grantTable)} WHERE ${quoteIdentifier(memberColumn)} IN (${placeholders})`,
          )
          .all(...rosterIds)
          .map((row) => row.id);
        for (const grantId of grantIds) {
          throwUnlessDeleted(deleteRecord(db, readable, grantTable, grantId, undefined, origin));
        }
        continue;
      }
      db.query(
        `DELETE FROM ${quoteIdentifier(grantTable)} WHERE ${quoteIdentifier(memberColumn)} IN (${placeholders})`,
      ).run(...rosterIds);
    }
    // 【`V23-M12-T02`。`D-V23-405`】履歴の宣言の有無に関わらず `deleteRecord` で1行ずつ消す
    // (その行を相手に持つ付与・招待の後始末をカーネルの1か所で効かせる)。 旧は宣言の無いとき生の DELETE だった。
    for (const rosterId of rosterIds) {
      throwUnlessDeleted(deleteRecord(db, readable, roster.table, rosterId, undefined, origin));
    }
  }
}

/** **【`V23-M8-T03`】`deleteRecord` が断ったら、呼び手のトランザクションごと巻き戻す。** */
function throwUnlessDeleted(result: { ok: boolean; errors?: ValidationError[] }): void {
  if (!result.ok) {
    throw new AutoEnrollRefused(result.errors ?? []);
  }
}
