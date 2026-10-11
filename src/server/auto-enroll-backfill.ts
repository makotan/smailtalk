/**
 * **名簿への自動登録の埋め戻し**(`V23-M1-T03`。単位 `SC-G1`。上位: `docs/adr/0497-auto-enroll-and-last-row-admin.md`
 * §Decision 1、`docs/adr/0510-v23-m1-guard-authorization-and-pre-start-decisions.md` §Decision 1 の1)。
 *
 * 差分の適用と同じトランザクションの最後に、カーネルから呼ばれる後段である。 渡すのは差分を当てる
 * 2つの口(`POST /diffs` と `apply_diff`)だけ。 カーネルは利用者の表の名前を1つも知らない。
 *
 * - 自動登録を宣言した名簿ごとに、対象の役割を実効で持つ利用者のうち、名簿に行が無い人へ1行書く
 *   (`account` = 利用者 ID、`name` の列 = ログイン名、グループの列 = 空)。
 * - 利用者の表がまだ無いアプリ(人が0人)では、0件で正常に終わる。
 * - 1件でも書けなければ、拒否の配列を返す(呼び手が適用ごと巻き戻す)。
 *
 * **【2026-10-02 追記。`V23-M9-T03`・`D-V23-236`・`D-V23-252`・`D-V23-263`。上の箇条を消していない】**
 * 差分の適用では、前の定義と次の定義の自動登録の対象の組(名簿の表・役割)を比べ、次にあって前に無い組が
 * あるときだけ、その組の役割を実効で持つ人だけを入れる。 関係の無い差分・役割を減らす差分では1行も書かない
 * (運営者が消した名簿の行は、その人の役割を配り直すか名簿に手で足すまで戻らない)。
 */
import type { Database } from "bun:sqlite";
import { effectiveRolesOnDb } from "../auth/store.ts";
import {
  createRecord,
  type Manifest,
  quoteIdentifier,
  type ValidationError,
} from "../kernel/index.ts";
import { accessControlOf } from "./owner-scope.ts";

/** 宣言した名簿の表・`account` 列・`name` 列・役割の一覧(同じ名簿の表は1つにまとめる)。 */
export function autoEnrollTargets(
  manifest: Manifest,
): { table: string; account: string; name?: string; roles: string[] }[] {
  const out: { table: string; account: string; name?: string; roles: string[] }[] = [];
  for (const table of manifest.app.tables) {
    const members = accessControlOf(table)?.members;
    const auto = members?.auto_enroll;
    if (members === undefined || auto === undefined) {
      continue;
    }
    if (out.some((seen) => seen.table === members.table)) {
      continue;
    }
    out.push({
      table: members.table,
      account: members.account,
      ...(auto.name === undefined ? {} : { name: auto.name }),
      roles: [...auto.roles],
    });
  }
  return out;
}

/**
 * 1人ぶんを名簿へ書く(既に行があれば何もしない)。 役割が対象外なら何もしない。
 * 書けなければ拒否の配列を返す。 呼び手のトランザクションの中で呼ぶ。
 */
export function enrollUserOnDb(
  db: Database,
  manifest: Manifest,
  user: { id: string; username: string },
  /**
   * **【`V23-M4-T03` / `D-V23-93`】名簿の行の作成が起こす発火の `$actor`。** 自己登録・招待の承諾は
   * 登録した本人、役割の変更は操作した人、差分の適用の埋め戻しは適用した人(分からなければ空)。
   */
  origin?: { readonly id: string; readonly login: string; readonly role: string },
): ValidationError[] {
  const targets = autoEnrollTargets(manifest);
  if (targets.length === 0) {
    return [];
  }
  const roles = effectiveRolesOnDb(db, user.id) ?? [];
  const errors: ValidationError[] = [];
  for (const target of targets) {
    if (!target.roles.some((role) => (roles as string[]).includes(role))) {
      continue;
    }
    const exists = db
      .query(
        `SELECT 1 FROM ${quoteIdentifier(target.table)} WHERE ${quoteIdentifier(target.account)} = ? LIMIT 1`,
      )
      .get(user.id);
    if (exists !== null) {
      continue;
    }
    const created = createRecord(
      db,
      manifest,
      target.table,
      {
        [target.account]: user.id,
        ...(target.name === undefined ? {} : { [target.name]: user.username }),
      },
      origin,
    );
    if (!created.ok) {
      errors.push(...created.errors);
    }
  }
  return errors;
}

/** 差分の適用の後段(カーネルの `applyDiff` の `afterMigrate` に渡す)。 */
export function autoEnrollBackfill(
  db: Database,
  next: Manifest,
  /**
   * 【2026-10-02。V23-M9 D-V23-236・D-V23-252】差分を当てる前の定義。 渡されたときは、前の定義と次の定義の
   * 自動登録の対象の組(名簿の表と役割)の差を取り、増えた組があるときだけ、増えた組の役割を持つ利用者を
   * その名簿へ入れる(関係の無い差分・役割を減らす差分では1行も書かない)。
   */
  previous?: Manifest,
  /** **【`V23-M4-T03`】差分を適用した人**(`$actor`。分からなければ空。`D-V23-93`)。 */
  origin?: { readonly id: string; readonly login: string; readonly role: string },
): ValidationError[] {
  if (autoEnrollTargets(next).length === 0) {
    return [];
  }
  let effective = next;
  if (previous !== undefined) {
    const before = new Set(
      autoEnrollTargets(previous).flatMap((target) =>
        target.roles.map((role) => `${target.table}\u0000${role}`),
      ),
    );
    const added = autoEnrollTargets(next)
      .map((target) => ({
        ...target,
        roles: target.roles.filter((role) => !before.has(`${target.table}\u0000${role}`)),
      }))
      .filter((target) => target.roles.length > 0);
    if (added.length === 0) {
      return [];
    }
    effective = withAutoEnrollRoles(next, added);
  }
  const hasUsers = db
    .query(`SELECT 1 FROM "sqlite_master" WHERE "type" = 'table' AND "name" = '_auth_users'`)
    .get();
  if (hasUsers === null) {
    return [];
  }
  const users = db
    .query<{ id: string; username: string }, []>(
      `SELECT "id", "username" FROM "_auth_users" ORDER BY "rowid"`,
    )
    .all();
  const errors: ValidationError[] = [];
  for (const user of users) {
    errors.push(...enrollUserOnDb(db, effective, user, origin));
  }
  return errors;
}

/** 自動登録の役割を、増えた組の役割だけに絞った定義の写し(非 export)。 */
function withAutoEnrollRoles(
  manifest: Manifest,
  added: readonly { table: string; roles: string[] }[],
): Manifest {
  const copy = structuredClone(manifest);
  for (const table of copy.app.tables) {
    const members = accessControlOf(table)?.members;
    if (members?.auto_enroll === undefined) {
      continue;
    }
    const hit = added.find((target) => target.table === members.table);
    (members.auto_enroll as { roles: string[] }).roles = hit === undefined ? [] : [...hit.roles];
  }
  return copy;
}
