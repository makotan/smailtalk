/**
 * **`V8-M26` —— 自動処理の書き手を1人立てるための、カーネル検査の共通の下ごしらえ。**
 *
 * **【このファイルは検査を1本も持たない。ヘルパだけの器である。】**
 * **`.test.ts` という名前なのは意図である** —— **`ADR-0007` §1b の Δ8(`src/kernel/` の公開
 * エクスポートが増える)は `*.test.ts` を明示的に除いており**(`scripts/kernel-export-drift.test.ts`
 * の `targetFiles()` が `!name.endsWith(".test.ts")` で同じ除外を機械化している)、
 * **ここに `export` を置いても門A は発火しない。** **製品コードは1バイトも増えていない。**
 *
 * ## なぜ要るのか(**実測。2026-08-10**)
 *
 * **`V8-M26-T03` が面(役割に束ねた権限)の既定を「閉じる」側へ倒した** ——
 * **`judgeRoleAccess` は、規則を1本も名指ししていない `table` を `allowed: false` /
 * `governed: true` で返す。****役割を1つも宣言していないアプリも閉じる**(`D-V8-65`)。
 *
 * **その結果、ワークフローとコードの島の書込が全部止まった。** **理由は2段である**:
 *
 *  1. **書き手が特定できない** —— **`resolveWorkflowActor` の既定は「トリガー元の行の
 *     `st_owner`」1本であり**(`ADR-0079` 限定4)、**その列が無い題材では空文字 = `null` になる。**
 *  2. **`null` の書き手は面から見て `anonymous` である**(`roleSubjectsOf`)——
 *     **`anonymous` には書込の規則を1本も書けない**(`schemas/manifest.schema.json` の
 *     `J-G11` の分岐が `can` を `read` 1語に閉じている)。**したがって規則をいくら足しても
 *     通らない。**
 *
 * **だから「規則を足す」だけでは足りず、「書き手を1人立てる」ことがセットで要る。**
 * **これは実装を緩めたのではなく、題材(マニフェストと DB)を今日の面に合わせたものである。**
 *
 * ## 何を配るか(**誇張しない**)
 *
 * **{@link grantOwnerAllTables} はその題材の**全テーブル**に `owner` の読み書き削除を配る。**
 * **これは「閉じたこと」を測る配り方ではない** —— **面の既定が閉じたことを測るのは
 * `src/kernel/role-rules.test.ts` / `src/kernel/role-default-grant.test.ts` /
 * `src/server/role-default-closed.test.ts` の担当であり、本ヘルパを使う検査の主題は
 * ワークフロー・島・バッチの**ふるまい**である。** **主題でない壁を題材の側で開けている。**
 * **【禁止】本ヘルパを、面の既定を測る検査に使わない。**
 */

import type { Database } from "bun:sqlite";
import type { Manifest, RoleDeclaration } from "./types.ts";

/** 下ごしらえで立てる書き手の識別子。**題材の中で1人だけ**。 */
export const FIXTURE_ACTOR_ID = "fixture-actor";

/**
 * **持ち主の列**(`st_owner`)。**`ADR-0079` の既定が読む唯一の列である。**
 * **`required` を付けない** —— **既存の題材が値を書かずに行を作る箇所を壊さないため。**
 */
export const OWNER_FIELD = { id: "st_owner", name: "持ち主(下ごしらえ)", type: "text" } as const;

/**
 * **`_auth_users` / `_auth_user_roles` を作り、書き手を1人だけ登録する。**
 *
 * **`effectiveRolesOnDb`(`src/auth/store.ts`)がこの2表を読む** —— **どちらかが無いと
 * 例外を握りつぶして `null`(= 未ログインと同じ主体)に倒れるので、2表とも要る。**
 * **列は読まれる分だけ作る**(`_auth_users.id` / `_auth_users.role` /
 * `_auth_user_roles.user_id` / `_auth_user_roles.role`)。**認証層の本物のスキーマの写しではない。**
 */
export function seedAutomationActor(
  db: Database,
  actorId: string = FIXTURE_ACTOR_ID,
  role: "owner" | "editor" | "viewer" = "owner",
): string {
  db.run(`CREATE TABLE IF NOT EXISTS "_auth_users" ("id" TEXT PRIMARY KEY, "role" TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS "_auth_user_roles" ("user_id" TEXT, "role" TEXT)`);
  db.run(`INSERT OR REPLACE INTO "_auth_users" ("id", "role") VALUES (?, ?)`, [actorId, role]);
  return actorId;
}

/**
 * **その題材の全テーブルへの読み書き削除を、既定3役割に配る**(`owner` は3動詞、
 * `editor` は読み書き、`viewer` は読取)。
 *
 * **`app.roles` を宣言していない題材には新しく生やす。** **既に宣言があれば、
 * まだ名指ししていないテーブルの分だけを足す**(書かれている宣言を1本も上書きしない)。
 * **呼ぶのは、テーブルを足し終えた後である** —— **後から足したテーブルには当たらない。**
 */
export function grantOwnerAllTables(manifest: Manifest): void {
  const app = manifest.app as unknown as { roles?: RoleDeclaration[] };
  if (app.roles === undefined) {
    app.roles = [
      { id: "owner", name: "持ち主" },
      { id: "editor", name: "編集者" },
      { id: "viewer", name: "閲覧者" },
    ] as RoleDeclaration[];
  }
  const verbs: Record<string, readonly string[]> = {
    owner: ["read", "write", "delete"],
    editor: ["read", "write"],
    viewer: ["read"],
  };
  // **【`V8-M28` / `T-G16a`(2026-08-11)】持ち主にはアプリの設定と人の役割の2行が要る** ——
  // **適用時検査(`referential-integrity.ts` の類型17 の拡張)が両方の実在を要求するので、
  // 足さないと題材のマニフェストが丸ごと拒否される。** **判定は1ミリも緩めていない。**
  {
    const owner = app.roles.find((declaration) => declaration.id === "owner");
    if (owner !== undefined) {
      const rules = (owner.rules ?? []) as Record<string, unknown>[];
      for (const target of ["app", "role"]) {
        if (rules.some((rule) => rule.target === target)) {
          continue;
        }
        rules.push({ target, can: ["write"] });
      }
      (owner as { rules?: unknown }).rules = rules;
    }
  }
  for (const declaration of app.roles) {
    const can = verbs[declaration.id];
    if (can === undefined) {
      continue;
    }
    const rules = (declaration.rules ?? []) as Record<string, unknown>[];
    for (const table of manifest.app.tables) {
      const already = rules.some((rule) => rule.target === "table" && rule.table === table.id);
      if (already) {
        continue;
      }
      rules.push({ target: "table", table: table.id, can: [...can] });
    }
    (declaration as { rules?: unknown }).rules = rules;
  }
}

/**
 * **持ち主の列を足す。** **足した列は表示名(`name`)で見分けられるようにする**
 * ({@link isFixtureOwnerTable})。
 *
 * **区別が要る理由(実測)**: **題材が元から `st_owner` を持つテーブルには、
 * 「持ち主が空の共有行」を作ることが主題の検査がある**(例: `run-function.test.ts` の
 * 「共有行(`st_owner` が空)は書き換えられる」)。**そこへ書き手を勝手に入れると、
 * 主題そのものが消える。** **だから入れてよいのは、この下ごしらえが足した列だけである。**
 *
 * **印を表示名に置いた理由(実測)**: **オブジェクトの同一性(`WeakSet`)では駄目だった** ——
 * **`applyManifest` を通す題材はマニフェストをディスクへ書いて読み直すので、
 * 印を付けたオブジェクトがその時点で別物になる。** **表示名なら往復しても残る。**
 *
 * **足さないのは2種類**: **既に `st_owner` を持つテーブル**(題材の主題を壊さない)と、
 * **履歴テーブル**(`ran_at` を持つ表。「規約5列」を測る検査を壊さない)。
 */
export function armOwnerColumns(manifest: Manifest): void {
  for (const table of manifest.app.tables) {
    const isHistory = table.fields.some((field) => field.id === "ran_at");
    const already = table.fields.some((field) => field.id === OWNER_FIELD.id);
    if (isHistory || already) {
      continue;
    }
    (table.fields as unknown[]).push({ ...OWNER_FIELD });
  }
}

/** **その表の持ち主の列を、この下ごしらえが足したか**(表示名で見分ける)。 */
export function isFixtureOwnerTable(manifest: Manifest, tableId: string): boolean {
  const table = manifest.app.tables.find((candidate) => candidate.id === tableId);
  const field = table?.fields.find((candidate) => candidate.id === OWNER_FIELD.id);
  return field?.name === OWNER_FIELD.name;
}

/**
 * **題材のマニフェストに、壁を開ける3つを一度に入れる。**
 *
 *  1. 持ち主の列({@link armOwnerColumns})。
 *  2. 既定3役割への規則({@link grantOwnerAllTables})。
 *  3. **ワークフローの `create_record` が作る行にも書き手を入れる** ——
 *     **これが無いと、その行が起こす**次の**発火の書き手が `null` になり、連鎖が途切れる。**
 *
 * **テーブルやワークフローを後から足す題材があるので、何度呼んでも同じ結果になる**(冪等)。
 */
export function armManifestForAutomation(manifest: Manifest): void {
  armOwnerColumns(manifest);
  grantOwnerAllTables(manifest);
  for (const workflow of manifest.app.workflows ?? []) {
    for (const action of (workflow.actions ?? []) as Record<string, unknown>[]) {
      if (action.action !== "create_record" || typeof action.table !== "string") {
        continue;
      }
      if (!isFixtureOwnerTable(manifest, action.table)) {
        continue;
      }
      const values = (action.values ?? {}) as Record<string, unknown>;
      if (values[OWNER_FIELD.id] === undefined) {
        action.values = { ...values, [OWNER_FIELD.id]: FIXTURE_ACTOR_ID };
      }
    }
  }
}

/**
 * **行を作るときの値に書き手を足す**(**この下ごしらえが持ち主の列を足した表にだけ**)。
 * **題材が明示した持ち主は1バイトも上書きしない。**
 */
export function fixtureOwnerValues(
  manifest: Manifest,
  tableId: string,
  values: Record<string, unknown>,
): Record<string, unknown> {
  if (!isFixtureOwnerTable(manifest, tableId) || values[OWNER_FIELD.id] !== undefined) {
    return values;
  }
  return { ...values, [OWNER_FIELD.id]: FIXTURE_ACTOR_ID };
}
