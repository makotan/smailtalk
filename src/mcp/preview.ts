/**
 * **下見を作る**(`V20-M13-T02a`。計画 §9-3・§9-4・§10-3・§10-6 / `ADR-0476` §Decision 1 の 2・3)。
 *
 * `dry_run_diff` に `preview` を付けて呼ばれたとき、次の順で1つ作る:
 *
 * 1. **置き場を予約する**(`src/server/preview-store.ts`。大きさ・個数の上限はここで断る)。
 * 2. **残す指定で `dryRunDiff` を呼ぶ**(カーネルは今日どおりの全量のレポートを返す)。
 *    **拒否なら置き場を消して、今日と同じ errors を返す。**
 * 3. `sample` なら **見本を入れる差し込み口** を呼ぶ(既定は {@link fillSampleCopy}: `_auth_*` 以外の
 *    表を空にし、見本の行を生の SQL で入れ、変更履歴・コメント・外への送信・AI の依頼を消す。`T03`)。
 * 4. **写しを整える**({@link scrubPreviewCopy}): 頼んだ人を写しの利用者へ写す → 秘密の表を空に →
 *    頼んだ人のセッションを1行 → `snapshots/` を消す → `kernel.sqlite` から他のアプリを消す →
 *    (`V20-M13` 点検の処置 軽1)対象のアプリの変更履歴・AI の依頼と使用量・外への送信・コメントも消す →
 *    `wal_checkpoint(TRUNCATE)` と `VACUUM`。**写せなければ作らずに理由を返す**
 *    (黙って広い権限で見せない)。 **【`V20-M15-T01B`】写しの `manifest.json` から選んだ記録
 *    (`app.design_memory.choices`)を外す**({@link stripDesignChoices}。型 `patterns` は残す)。
 * 5. `meta.json` を書いて登録を終える。
 *
 * **消す処理はカーネルの外に置く**(`ADR-0476` 2-6。`dry-run.ts` でレポートの中身を落とさない)。
 */

import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAuthTableName } from "../auth/types.ts";
import { APP_SCOPED_KERNEL_TABLES } from "../kernel/delete-app.ts";
import type { ValidationError } from "../kernel/errors.ts";
import {
  appDbPath,
  type DryRunReport,
  dryRunDiff,
  kernelDbPath,
  type Manifest,
  readCurrentManifest,
} from "../kernel/index.ts";
import { appManifestPath, appSnapshotsDir } from "../kernel/storage-paths.ts";
import {
  commitPreview,
  discardPreview,
  PREVIEW_TTL_SECONDS,
  type PreviewClock,
  type PreviewMeta,
  type PreviewMode,
  reservePreview,
} from "../server/preview-store.ts";
import { buildSampleRows, type SamplePlan } from "./sample-rows.ts";

/**
 * **写しの `_auth_*` のうち、残す表の許可リスト**(`ADR-0476` §Decision 1 の 3)。
 *
 * - `_auth_users`: 利用者の行(ID・ログイン名・表示名・役割の1値・作った時刻)。**秘密の値を
 *   1つも持たない**(パスワードの控えは `_auth_password_credentials`、Passkey は
 *   `_auth_webauthn_credentials` に在る)。頼んだ人の見え方で描くのに、役割の判定と
 *   行の持ち主の表示が要る。
 * - `_auth_user_roles`: 役割の付与(実効ロール集合 = 列の1値 ∪ 付与)。役割の判定に要る。
 *
 * **消す側を列挙しない**(`ADR-0376` 限定5)。`isAuthTableName` に当たる表のうち、ここに無いもの
 * は全部空にする。**9本目の `_auth_*` が足された日は、黙って漏れるのではなく、黙って消える。**
 * 今日(2026-09-26)空にするのは6本: `_auth_sessions`(頼んだ人の1行を足し直す)/
 * `_auth_password_credentials` / `_auth_webauthn_credentials` / `_auth_pending_challenges` /
 * `_auth_invitations` / `_auth_activity`(操作の記録)。
 */
export const PREVIEW_KEPT_AUTH_TABLES: ReadonlySet<string> = new Set([
  "_auth_users",
  "_auth_user_roles",
]);

/** `kernel.sqlite` の資格情報の欄の綴り(接続・AI・受信口の3表が同じ綴りを持つ)。 */
const CREDENTIAL_COLUMN = "secret_source_value";

/**
 * **見本を入れる差し込み口**。当てた後の写しと、当てた後のマニフェストと、頼んだ人の利用者 ID を受ける。
 * 既定は {@link fillSampleCopy}(`V20-M13-T03`)。
 */
export type SampleFiller = (
  shadowDataRoot: string,
  appId: string,
  manifest: Manifest,
  requesterUserId: string,
) => void;

/**
 * **見本のモードでも `kernel.sqlite` に残す、アプリの設定の表**(計画 §10-6)。
 *
 * 接続・AI の能力・受信口・見た目の資材(逃げ道の CSS)と、それぞれの申請。**作り手が書いた
 * 設定であって、利用者のデータを持たない**(資格情報の欄は {@link scrubPreviewCopy} が空にする)。
 *
 * **消す側を列挙しない**: カーネルの単一ソース `APP_SCOPED_KERNEL_TABLES`(`delete-app.ts`)のうち、
 * ここに無い表は見本のモードで対象のアプリの行を全部消す。今日消えるのは5本 ——
 * 変更履歴(意図・操作・スナップショット)/ AI の依頼(入力)/ AI の使用量(誰が使ったか)/
 * 外への送信(本文)/ コメント(本文)。**新しい表が単一ソースに足された日は、黙って消える側に倒れる。**
 */
export const SAMPLE_KEPT_KERNEL_TABLES: ReadonlySet<string> = new Set([
  "ai_capabilities",
  "ai_requests",
  "connections",
  "connection_requests",
  "escape_hatch_assets",
  "escape_hatch_asset_requests",
  "inbound_endpoints",
  "inbound_endpoint_requests",
]);

/** 見本のモードで対象のアプリの行を消す `kernel.sqlite` の表(単一ソースから許可リストを引いた残り)。 */
export const SAMPLE_CLEARED_KERNEL_TABLES: readonly string[] = APP_SCOPED_KERNEL_TABLES.filter(
  (table) => !SAMPLE_KEPT_KERNEL_TABLES.has(table),
);

/**
 * **見本の行を生の SQL で入れる**(`V20-M13-T03`)。**カーネルの `createRecord` を通さない** ——
 * 自動処理・関数・AI・外への送信を1つも走らせない。写しに無い表・欄は飛ばす。
 * 呼び出し側がトランザクションで包む。真偽はカーネルと同じく 1 / 0 で入れる。
 */
export function insertSamplePlan(db: Database, plan: SamplePlan): void {
  for (const table of plan.tables) {
    const existing = new Set(columnsOf(db, table.table).map((c) => c.name));
    if (existing.size === 0) continue;
    for (const row of table.rows) {
      const entries = Object.entries(row.values).filter(([key]) => existing.has(key));
      const columns = ["_id", "_created_at", "_updated_at", ...entries.map(([key]) => key)];
      const values = [
        row._id,
        row._created_at,
        row._updated_at,
        ...entries.map(([, value]) => (typeof value === "boolean" ? (value ? 1 : 0) : value)),
      ];
      db.query(
        `INSERT INTO ${quote(table.table)} (${columns.map(quote).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      ).run(...values);
    }
  }
}

/**
 * **見本のモードの写しを作る**(`V20-M13-T03`。計画 §9-5・§10-6 / `D-V20-44`「見本だけにする」)。
 *
 * 1. `app.sqlite`: **`_auth_*` 以外の表を全部空にする**(作り手の表・`_files`・その他。
 *    表を列挙しない —— 後から足された表も黙って消える側に倒れる)。`_auth_*` は
 *    {@link scrubPreviewCopy} が許可リストで整える(操作の記録 `_auth_activity` はそこで空になる)。
 * 2. {@link buildSampleRows} の見本を**生の SQL** で入れる。
 * 3. `kernel.sqlite`: {@link SAMPLE_CLEARED_KERNEL_TABLES}(変更履歴・コメント・外への送信・AI の依頼と
 *    使用量)から対象のアプリの行を消す。
 *
 * `wal_checkpoint(TRUNCATE)` と `VACUUM` は後に続く {@link scrubPreviewCopy} が両 DB で行う
 * (T02a の順を崩さない)。
 */
export const fillSampleCopy: SampleFiller = (shadowDataRoot, appId, manifest, requesterUserId) => {
  const plan = buildSampleRows(manifest, requesterUserId);
  const db = new Database(appDbPath(shadowDataRoot, appId), { readwrite: true, create: false });
  try {
    db.exec("PRAGMA foreign_keys = OFF;");
    db.exec("PRAGMA secure_delete = ON;");
    db.transaction(() => {
      for (const table of tableNames(db)) {
        if (!isAuthTableName(table)) {
          db.exec(`DELETE FROM ${quote(table)};`);
        }
      }
      insertSamplePlan(db, plan);
    })();
  } finally {
    db.close();
  }
  const kernelPath = kernelDbPath(shadowDataRoot);
  if (!existsSync(kernelPath)) return;
  const kernel = new Database(kernelPath, { readwrite: true, create: false });
  try {
    kernel.exec("PRAGMA foreign_keys = OFF;");
    kernel.exec("PRAGMA secure_delete = ON;");
    const names = tableNames(kernel);
    kernel.transaction(() => {
      for (const table of SAMPLE_CLEARED_KERNEL_TABLES) {
        if (!names.includes(table)) continue;
        if (!columnsOf(kernel, table).some((c) => c.name === "app_id")) continue;
        kernel.query(`DELETE FROM ${quote(table)} WHERE "app_id" = ?`).run(appId);
      }
    })();
  } finally {
    kernel.close();
  }
};

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function tableNames(db: Database): string[] {
  return db
    .query<{ name: string }, []>(
      `SELECT "name" FROM "sqlite_master" WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%' ORDER BY "name"`,
    )
    .all()
    .map((row) => row.name);
}

function columnsOf(db: Database, table: string): { name: string; notnull: number }[] {
  return db
    .query<{ name: string; notnull: number }, []>(`PRAGMA table_info(${quote(table)})`)
    .all();
}

/** 消した行を WAL にも空きページにも残さない。 */
function compact(db: Database): void {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  db.exec("VACUUM;");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
}

/**
 * **写しの `manifest.json` から選んだ記録を外す**(`V20-M15-T01B`。計画 §9-3-6 / `D-V20-62` / `ADR-0479` §影響の調査の
 * `ADR-0476` §Decision 1-6 の行)。
 *
 * - `app.design_memory.choices` を取り除く。 **型(`patterns`)は残す。** 取り除いて器が空なら `design_memory` ごと消す。
 * - **`choices` を持たない写し(`design_memory` を持たない / 型だけ)は1バイトも書き直さない。**
 * - **書き直したマニフェストが、読む側と同じ検証(`readCurrentManifest` = 保存済みの読み)を通ることを確かめる。**
 *   通らなければ理由を返す(呼ぶ側は下見を作らない。黙って壊れた写しを見せない)。 理由に置き場の絶対パスを載せない。
 * - **本物には触れない。** `stale` の材料は本物の生バイトだけであり、写し側の sha を材料にしない(計画 §9-6 の罠 R9)。
 */
export function stripDesignChoices(
  shadowDataRoot: string,
  appId: string,
): { ok: true } | { ok: false; reason: string } {
  const refused = {
    ok: false as const,
    reason:
      "下見の写しから選んだ記録(design_memory.choices)を外した定義を確かめられなかったため、下見を作りませんでした。" +
      "本物のアプリの定義は変わっていません。",
  };
  const path = appManifestPath(shadowDataRoot, appId);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return refused;
  }
  const app = (parsed as { app?: unknown } | null)?.app;
  if (typeof app !== "object" || app === null) {
    return refused;
  }
  const record = app as Record<string, unknown>;
  const memory = record.design_memory;
  if (typeof memory !== "object" || memory === null || !("choices" in memory)) {
    return { ok: true };
  }
  const { choices: _dropped, ...rest } = memory as Record<string, unknown>;
  if (Object.keys(rest).length === 0) {
    delete record.design_memory;
  } else {
    record.design_memory = rest;
  }
  try {
    writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
    readCurrentManifest(shadowDataRoot, appId);
  } catch {
    return refused;
  }
  return { ok: true };
}

/** 写しを整えた結果。 */
export type ScrubResult = { ok: true; sessionId: string } | { ok: false; reason: string };

/**
 * **写しから秘密と他のアプリを消し、頼んだ人のセッションを1行だけ足す**(計画 §10-3)。
 *
 * **頼んだ人を写しの利用者に写せないときは、写しに1バイトも足さずに断る。**
 */
export function scrubPreviewCopy(input: {
  shadowDataRoot: string;
  appId: string;
  requesterUserId: string;
  sessionExpiresAt: string;
  now?: PreviewClock;
}): ScrubResult {
  const { shadowDataRoot, appId } = input;
  const now = (input.now ?? (() => new Date()))();
  const sessionId = randomBytes(32).toString("base64url");

  const app = new Database(appDbPath(shadowDataRoot, appId), { readwrite: true, create: false });
  try {
    app.exec("PRAGMA foreign_keys = OFF;");
    const names = tableNames(app);
    const requester = names.includes("_auth_users")
      ? app
          .query<{ id: string }, [string]>(`SELECT "id" FROM "_auth_users" WHERE "id" = ?`)
          .get(input.requesterUserId)
      : null;
    if (requester === null) {
      return {
        ok: false,
        reason:
          "下見を頼んだ人(MCP の名乗り)を、写しの中の利用者に写せなかったため、下見を作りませんでした。" +
          "広い権限で見せることはしません。名乗りがこのアプリに登録済みの利用者であることを確かめてください。",
      };
    }
    app.exec("PRAGMA secure_delete = ON;");
    app.transaction(() => {
      for (const table of names) {
        if (isAuthTableName(table) && !PREVIEW_KEPT_AUTH_TABLES.has(table)) {
          app.exec(`DELETE FROM ${quote(table)};`);
        }
      }
      app
        .query(
          `INSERT INTO "_auth_sessions" ("id", "user_id", "created_at", "expires_at") VALUES (?, ?, ?, ?)`,
        )
        .run(sessionId, input.requesterUserId, now.toISOString(), input.sessionExpiresAt);
    })();
    compact(app);
  } finally {
    app.close();
  }

  // 巻き戻しの下見は許可リストの外。写しの `snapshots/` には整える前の全量が在る。
  rmSync(appSnapshotsDir(shadowDataRoot, appId), { recursive: true, force: true });

  // **【`V20-M15-T01B` / `D-V20-62`】写しの定義から選んだ記録と理由を外す**(型は残す)。 確かめられなければ作らない。
  const stripped = stripDesignChoices(shadowDataRoot, appId);
  if (!stripped.ok) {
    return stripped;
  }

  const kernelPath = kernelDbPath(shadowDataRoot);
  if (existsSync(kernelPath)) {
    const kernel = new Database(kernelPath, { readwrite: true, create: false });
    try {
      kernel.exec("PRAGMA foreign_keys = OFF;");
      kernel.exec("PRAGMA secure_delete = ON;");
      kernel.transaction(() => {
        for (const table of tableNames(kernel)) {
          const columns = columnsOf(kernel, table);
          const names = columns.map((c) => c.name);
          if (!names.includes("app_id")) {
            // **app_id を持たない表は、対象のアプリのものと言えないので空にする**(閉じる側)。
            kernel.exec(`DELETE FROM ${quote(table)};`);
            continue;
          }
          kernel.query(`DELETE FROM ${quote(table)} WHERE "app_id" IS NOT ?`).run(appId);
          // **【`V20-M13` 点検の処置 軽1】`real` でも**、対象のアプリの変更履歴(意図)・AI の依頼
          // (入力)と使用量・外への送信(本文)・コメント(本文)を消す(見本のモードと同じ集合
          // {@link SAMPLE_CLEARED_KERNEL_TABLES})。 許可リストで届かなくても、写しは1時間ディスクに
          // 残るため。 描画に要る設定の表({@link SAMPLE_KEPT_KERNEL_TABLES})は残す。
          if (SAMPLE_CLEARED_KERNEL_TABLES.includes(table)) {
            kernel.query(`DELETE FROM ${quote(table)} WHERE "app_id" = ?`).run(appId);
            continue;
          }
          const credential = columns.find((c) => c.name === CREDENTIAL_COLUMN);
          if (credential !== undefined) {
            kernel.exec(
              `UPDATE ${quote(table)} SET ${quote(CREDENTIAL_COLUMN)} = ${credential.notnull === 1 ? "''" : "NULL"};`,
            );
          }
        }
      })();
      compact(kernel);
    } finally {
      kernel.close();
    }
  }
  return { ok: true, sessionId };
}

/** 下見を作った結果。 */
export type CreatePreviewResult =
  /** 差分が拒否された(置き場は残さない)。errors は残す指定の無いドライランと同じ。 */
  | { kind: "rejected"; errors: ValidationError[] }
  /** 上限・写せない人などで下見を作らなかった。`report` は取れていれば入る。 */
  | { kind: "refused"; reason: string; report?: DryRunReport }
  | { kind: "created"; report: DryRunReport; meta: PreviewMeta };

/**
 * 下見を1つ作る。**本体(`dataRoot`)には1バイトも書かない**(`dryRunDiff` の性質)。
 * **例外が出たら置き場を消してから投げ直す。**
 */
export function createPreview(input: {
  dataRoot: string;
  appId: string;
  diff: unknown;
  mode: PreviewMode;
  requesterUserId: string;
  previewRoot: string;
  now?: PreviewClock;
  fillSample?: SampleFiller;
}): CreatePreviewResult {
  const clock = input.now ?? (() => new Date());
  const reserved = reservePreview({
    root: input.previewRoot,
    dataRoot: input.dataRoot,
    appId: input.appId,
    now: clock,
  });
  if (!reserved.ok) {
    return { kind: "refused", reason: reserved.reason };
  }
  try {
    const dry = dryRunDiff(input.dataRoot, input.appId, input.diff, { keepUnder: reserved.dir });
    if (!dry.valid) {
      discardPreview(input.previewRoot, reserved.id);
      return { kind: "rejected", errors: dry.errors };
    }
    const kept = dry.kept;
    if (kept === undefined) {
      throw new Error("残す指定で当てたのに、複製の置き場が返りませんでした。");
    }
    if (input.mode === "sample") {
      (input.fillSample ?? fillSampleCopy)(
        kept.data_root,
        input.appId,
        dry.report.manifest,
        input.requesterUserId,
      );
    }
    const created = clock();
    const expiresAt = new Date(created.getTime() + PREVIEW_TTL_SECONDS * 1000).toISOString();
    const scrubbed = scrubPreviewCopy({
      shadowDataRoot: kept.data_root,
      appId: input.appId,
      requesterUserId: input.requesterUserId,
      sessionExpiresAt: expiresAt,
      now: () => created,
    });
    if (!scrubbed.ok) {
      discardPreview(input.previewRoot, reserved.id);
      return { kind: "refused", reason: scrubbed.reason, report: dry.report };
    }
    const meta = commitPreview(input.previewRoot, reserved.id, {
      app_id: input.appId,
      requester_user_id: input.requesterUserId,
      mode: input.mode,
      shadow_data_root: kept.data_root,
      session_id: scrubbed.sessionId,
      now: () => created,
    });
    return { kind: "created", report: dry.report, meta };
  } catch (error) {
    discardPreview(input.previewRoot, reserved.id);
    throw error;
  }
}
