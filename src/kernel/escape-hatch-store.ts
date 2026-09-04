/**
 * 逃げ道(任意 CSS)の資産ストア(V3-M5-T01 / ADR-0055 限定4・5・7・9・11)。
 *
 * **`capability-store.ts`(送信 = connection)/ `inbound-store.ts`(受信 = endpoint)に続く
 * 3例目である。** ADR-0055 §1 の4層のうち、本モジュールは下2層を持つ:
 *
 * | 層 | 置き場 | 誰が書けるか |
 * |---|---|---|
 * | 逃げ道の**本体**(CSS のバイト列) | `apps/<appId>/escape-hatch/<sha256>`(content-addressed) | **owner だけ**(`requireOwner` を通した HTTP ルート1本) |
 * | 逃げ道の**登録**(資産名 + ダイジェスト + 作用域) | `kernel.sqlite` の `escape_hatch_assets` | 同上 |
 * | AI の**申請** | `kernel.sqlite` の `escape_hatch_asset_requests` | **AI が申請だけ** |
 *
 * (逃げ道の**参照**をマニフェストの `$defs/view` に書く層は本モジュールの担当ではない ——
 * V3-M5-T02 が持つ。)
 *
 * **逃げ道の資産は人間(owner)専用である。**MCP ツール / `apply_diff` 経路から**発行に**
 * 到達させてはならない(ADR-0055 限定5 = ADR-0020 §2b/§8c-3・ADR-0041 限定1 と同型)。
 * AI が到達できるのは `requestEscapeHatchAsset`(申請)までで、発行(`issueEscapeHatchAsset`
 * と `putEscapeHatchBody`)は人間 owner の HTTP ルートだけが行う。**担保は説明文ではなく
 * 経路の不在であり、`src/server/escape-hatch-issuance.test.ts` がソースの上でそれを固定する。**
 *
 * 置き場は `kernel.sqlite`(ADR-0055 限定4)。理由:
 * - AI 不可視・人間専用・**undo 非対象**の3制約を既定で満たすのは kernel.sqlite だけ
 *   (undo は `app.sqlite` と `manifest.json` しか書き戻さない。ADR-0004)。
 * - **`SYSTEM_TABLE_IDS` を増やさず、ユーザランドに `_` 始まりのテーブルを1つも作らない**
 *   (限定4)。`CREATE TABLE IF NOT EXISTS` を足すだけで、既存の `apps` / `changelog` /
 *   `connections` / `inbound_endpoints` には一切触れない。
 *
 * **secret を保管する列を1つも作らない(ADR-0055 には secret が無い)。**
 * `capability-store.ts:16`〜`:18` の規律(secret 本体を保存せず取得元の参照だけを持つ)を
 * 読んだうえでの判定は「**逃げ道の資産に secret は無い**」である —— CSS のバイト列は
 * 見た目の宣言であって認証情報ではなく、use-time に解決する外部の値も持たない。
 * したがって `secret_source_kind` / `secret_source_value` に相当する列を置かない。
 * **本体を平文で持つのは、それが secret ではないからである**(記録: `v3-m5-t01.md` §5)。
 *
 * **カーネルは CSS を1バイトも解釈しない**(ADR-0055 憲法1 / 限定8)。この層が持つのは
 * 「バイト列を content-addressed に置く・読む・在るか見る」と「名前 + ダイジェスト + 作用域を
 * 記録する」だけで、**CSS プロパティの許可リストも拒否リストも作らない。**
 *
 * capability-store.ts / inbound-store.ts / blob-store.ts に倣い:
 * - ドライバは Bun 組み込みの `bun:sqlite`(外部依存を足さない)
 * - 日時は ISO8601 UTC 文字列(`created_at`)で TEXT 保存
 * - SQL 識別子は常にダブルクォート、値は必ずプレースホルダでバインド
 * - 実体の書込は tmp→rename の原子的書込。**既存実体を上書きしない**(`putBlob` の作法)
 * - 検出するのは呼び出し側のプログラミングエラーと I/O エラーなので例外で失敗させる
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appEscapeHatchDir, kernelDbPath } from "./storage-paths.ts";

/**
 * 逃げ道の資産テーブル(`connections` と同型)。**CSS のバイト列の列は無い** ——
 * 本体は content-addressed なファイルで、ここが持つのは `digest`(参照)だけである。
 *
 * `scope_views` は**作用域**(この資産を当ててよい画面の集合。JSON 配列文字列)。
 * `connections.allowed_hosts` の鏡写しだが、**既定を空にしない** —— 空の宣言は
 * `issueEscapeHatchAsset` が拒否する(ADR-0055 限定7:「宣言を持たない発行を受理しない」)。
 *
 * UNIQUE は `(app_id, name, digest)` である。`connections` の `(app_id, name)` と違って
 * **name だけでは一意にしない** —— 同じ名前の別の版(別ダイジェスト)が並べることが、
 * 「過去の版を上書き破壊しない」(限定9)の登録側の表現だからである。
 *
 * `escape_hatch_asset_requests` は `connection_requests` の対称。**AI はこれを積むだけ**で、
 * 発行(`escape_hatch_assets` への書き込み)には到達しない。
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS "escape_hatch_assets" (
  "id"          TEXT PRIMARY KEY,
  "app_id"      TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "digest"      TEXT NOT NULL,
  "scope_views" TEXT NOT NULL,
  "created_at"  TEXT NOT NULL,
  UNIQUE ("app_id", "name", "digest")
);

CREATE INDEX IF NOT EXISTS "escape_hatch_assets_app_id" ON "escape_hatch_assets" ("app_id");

CREATE TABLE IF NOT EXISTS "escape_hatch_asset_requests" (
  "id"                    TEXT PRIMARY KEY,
  "app_id"                TEXT NOT NULL,
  "requested_name"        TEXT NOT NULL,
  "purpose"               TEXT NOT NULL,
  "suggested_scope_views" TEXT NOT NULL,
  "status"                TEXT NOT NULL CHECK("status" IN ('pending','approved','rejected')),
  "created_at"            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS "escape_hatch_asset_requests_app_status"
  ON "escape_hatch_asset_requests" ("app_id", "status");
`;

/** content-addressed 名の形式(sha256 の16進64文字)。`blob-store.ts` と同じ。 */
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** 発行済みの逃げ道の資産1行(参照。CSS のバイト列は持たない)。 */
export interface EscapeHatchAsset {
  id: string;
  appId: string;
  /** 資産名(マニフェストの参照が名指しする人間可読名)。 */
  name: string;
  /** 本体の sha256 hex(content-addressed な実体名)。 */
  digest: string;
  /** 作用域: この資産を当ててよい画面(view id)の集合。**空にならない**(限定7)。 */
  scopeViews: string[];
  createdAt: string;
}

/** 資産発行の入力。`id` / `createdAt` は内部生成する。 */
export interface IssueEscapeHatchAssetInput {
  appId: string;
  name: string;
  digest: string;
  scopeViews: string[];
}

type EscapeHatchAssetRow = {
  id: string;
  app_id: string;
  name: string;
  digest: string;
  scope_views: string;
  created_at: string;
};

/**
 * 逃げ道の**申請**(`connection_requests` の対称。ADR-0055 限定5)。
 *
 * **AI が到達できるのはここまでである。**AI(MCP `request_custom_css`)は申請
 * (`status="pending"`)を作れるだけで、**発行(`escape_hatch_assets` への書き込みと
 * 本体の配置)には到達しない**(発行は owner の HTTP 操作だけが行う)。
 * `suggestedScopeViews` は AI の提案であり、owner は発行時にこれを狭めても・上書きしても
 * よい。**CSS のバイト列はこの申請に含まれない** —— 本文を書くのは owner である。
 */
export interface EscapeHatchAssetRequest {
  id: string;
  appId: string;
  requestedName: string;
  purpose: string;
  /** 当ててほしい画面の**提案**。**必須ではない**(必須なのは owner の発行側。限定7)。 */
  suggestedScopeViews: string[];
  status: "pending" | "approved" | "rejected";
  createdAt: string;
}

/** 申請作成の入力。`id` / `createdAt` / `status`("pending")は内部生成する。 */
export interface RequestEscapeHatchAssetInput {
  appId: string;
  requestedName: string;
  purpose: string;
  suggestedScopeViews: string[];
}

type EscapeHatchAssetRequestRow = {
  id: string;
  app_id: string;
  requested_name: string;
  purpose: string;
  suggested_scope_views: string;
  status: string;
  created_at: string;
};

/** ISO8601 UTC(ミリ秒つき)の現在時刻。 */
function nowIso(): string {
  return new Date().toISOString();
}

/** バイト列の sha256 を16進文字列で返す(`blob-store.ts` と同じ計算)。 */
function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * 本体の最終パスを返す(検証つき)。
 *
 * `putEscapeHatchBody` が自ら計算した値、またはマニフェストに載ったダイジェストしか
 * 渡ってこない想定だが、パストラバーサル(`../` 等)を構造的に排除するため
 * **16進64文字以外は拒否**する(`blob-store.ts:48` の多層防御と同じ)。
 * 不正なら `null` を返し、呼び出し側は「実在しない」として扱う。
 */
function bodyPath(dataRoot: string, appId: string, sha256: string): string | null {
  if (!SHA256_HEX_RE.test(sha256)) {
    return null;
  }
  return join(appEscapeHatchDir(dataRoot, appId), sha256);
}

/**
 * 逃げ道の本体(CSS のバイト列)を content-addressed に保存し、その sha256 hex を返す。
 *
 * **`putBlob`(`src/kernel/blob-store.ts:59`)の作法をそのまま踏襲する** ——
 * 同一内容が既にあれば書かずに返し(de-dup)、**既存実体を上書きしない**(名前が内容を
 * 決めるので不変)。書込は tmp→rename で原子的なので、中途半端な内容の実体が最終名で
 * 観測されることがない。
 *
 * **この関数を呼べるのは owner の HTTP ルートだけである**(ADR-0055 限定5。担保は
 * 経路の不在で、`src/server/escape-hatch-issuance.test.ts` が固定する)。
 * **CSS の中身は1バイトも解釈しない**(限定8 / 憲法1)。
 */
export function putEscapeHatchBody(dataRoot: string, appId: string, data: Uint8Array): string {
  const hash = sha256Hex(data);
  const dir = appEscapeHatchDir(dataRoot, appId);
  const finalPath = join(dir, hash);
  if (existsSync(finalPath)) {
    return hash; // de-dup: 既存実体は不変なので上書きしない。
  }
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.tmp-${hash}-${crypto.randomUUID()}`);
  try {
    writeFileSync(tmpPath, data);
    renameSync(tmpPath, finalPath);
  } catch (error) {
    // 失敗しても中途半端な tmp を残さない(観測されるのは最終名だけ)。
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // クリーンアップ失敗は本エラーを覆い隠さない。
    }
    throw error;
  }
  return hash;
}

/** 逃げ道の本体を読む。実在しなければ `null`(エラーではない)。不正な名前も `null`。 */
export function getEscapeHatchBody(
  dataRoot: string,
  appId: string,
  sha256: string,
): Uint8Array | null {
  const path = bodyPath(dataRoot, appId, sha256);
  if (path === null || !existsSync(path)) {
    return null;
  }
  return readFileSync(path);
}

/**
 * その sha256 の本体が存在するか。不正な名前は `false`。
 *
 * **失効(`deleteEscapeHatchAsset`)はこの実体を消さない** —— 消すと過去のスナップショットが
 * 参照する版を復元できなくなる(ADR-0055 限定10 / T01 完了条件5)。
 */
export function escapeHatchBodyExists(dataRoot: string, appId: string, sha256: string): boolean {
  const path = bodyPath(dataRoot, appId, sha256);
  return path !== null && existsSync(path);
}

/** DB 行 → EscapeHatchAsset。scope_views は JSON。 */
function toAsset(row: EscapeHatchAssetRow): EscapeHatchAsset {
  return {
    id: row.id,
    appId: row.app_id,
    name: row.name,
    digest: row.digest,
    scopeViews: JSON.parse(row.scope_views) as string[],
    createdAt: row.created_at,
  };
}

/** DB 行 → EscapeHatchAssetRequest。status は CHECK 制約が守る。 */
function toRequest(row: EscapeHatchAssetRequestRow): EscapeHatchAssetRequest {
  return {
    id: row.id,
    appId: row.app_id,
    requestedName: row.requested_name,
    purpose: row.purpose,
    suggestedScopeViews: JSON.parse(row.suggested_scope_views) as string[],
    status: toRequestStatus(row.status),
    createdAt: row.created_at,
  };
}

/** DB の status 列を EscapeHatchAssetRequest の status へ写す(CHECK 制約外の値は例外)。 */
function toRequestStatus(status: string): EscapeHatchAssetRequest["status"] {
  if (status === "pending" || status === "approved" || status === "rejected") {
    return status;
  }
  throw new Error(`escape_hatch_asset_requests.status に未知の値 "${status}" が入っています。`);
}

/**
 * 発行時の作用域の宣言を検査する(ADR-0055 限定7)。
 *
 * **宣言を持たない発行を受理しない。ワイルドカード全許可を既定にしない。**
 * `connections.allowed_hosts` は空配列(= 何も許可しない)を既定に採れたが、逃げ道では
 * 空を「全部許可」とも「何も許可しない」とも解釈させない —— **発行そのものを拒む。**
 * 呼び出し側(HTTP ルート)が 400 で返すのとは別に、ここでも構造的に拒む
 * (経路を1本足された日に既定の全許可が生えないようにする)。
 */
function assertScopeDeclared(scopeViews: string[]): void {
  if (scopeViews.length === 0) {
    throw new Error(
      "逃げ道の資産には作用域(この資産を当ててよい画面)の宣言が必須です。空の宣言では発行できません。",
    );
  }
  for (const view of scopeViews) {
    if (view === "" || view.trim() === "") {
      throw new Error("逃げ道の資産の作用域に空の画面IDは指定できません。");
    }
    if (view === "*") {
      throw new Error(
        '逃げ道の資産の作用域にワイルドカード "*" は指定できません。当ててよい画面を1つずつ列挙してください。',
      );
    }
  }
}

/**
 * 逃げ道(任意 CSS)の資産ストア。開く DB(kernel.sqlite)は必ず `dataRoot` 引数で受け取る
 * (環境変数・ハードコードに依存しない)。テストは一時ディレクトリを渡してリポジトリの
 * `data/` を汚さずに動かせる。
 */
export class EscapeHatchStore {
  private readonly db: Database;

  private constructor(db: Database) {
    this.db = db;
  }

  /**
   * `<dataRoot>/kernel.sqlite` を開き(なければ作る)、逃げ道のテーブルを用意する。
   * meta-store.ts / capability-store.ts と同じ WAL DB を別ハンドルで開くため、PRAGMA を倣う。
   * `CREATE TABLE IF NOT EXISTS` なので既存の apps / changelog / connections /
   * inbound_endpoints テーブルには触れない。
   */
  static openForKernel(dataRoot: string): EscapeHatchStore {
    mkdirSync(dataRoot, { recursive: true });
    const db = new Database(kernelDbPath(dataRoot), { create: true });
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(SCHEMA);
    return new EscapeHatchStore(db);
  }

  /** DB を閉じる。以後の操作はエラーになる。 */
  close(): void {
    this.db.close();
  }

  // --- 資産の発行(人間 owner 専用。ADR-0055 限定5)--------------------------------
  //
  // **AI 経路(requestEscapeHatchAsset)からはここに到達しない。**発行は owner の
  // HTTP 操作だけが呼ぶ(`POST /api/apps/:app_id/escape-hatch-assets`)。

  /**
   * 逃げ道の資産を発行する。`id`(uuid)と `createdAt`(ISO8601)は内部生成する。
   * **CSS のバイト列は受け取らない** —— 本体は `putEscapeHatchBody` が先に置き、
   * ここが記録するのはその `digest`(sha256 hex)である(限定9)。
   * `scopeViews` は必須で、空・空文字・`"*"` は受け付けない(限定7)。
   * @throws digest が sha256 hex でない場合 / 作用域の宣言が無い場合 /
   *         同一 app 内で `name` + `digest` が重複する場合(UNIQUE 違反)
   */
  issueEscapeHatchAsset(input: IssueEscapeHatchAssetInput): EscapeHatchAsset {
    if (!SHA256_HEX_RE.test(input.digest)) {
      throw new Error(
        `逃げ道の資産のダイジェストは sha256 の16進64文字である必要があります: ${JSON.stringify(input.digest)}`,
      );
    }
    assertScopeDeclared(input.scopeViews);
    const asset: EscapeHatchAsset = {
      id: crypto.randomUUID(),
      appId: input.appId,
      name: input.name,
      digest: input.digest,
      scopeViews: input.scopeViews,
      createdAt: nowIso(),
    };
    try {
      this.db
        .query(
          `INSERT INTO "escape_hatch_assets"
             ("id", "app_id", "name", "digest", "scope_views", "created_at")
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          asset.id,
          asset.appId,
          asset.name,
          asset.digest,
          JSON.stringify(asset.scopeViews),
          asset.createdAt,
        );
    } catch (error) {
      if (error instanceof Error && /UNIQUE/i.test(error.message)) {
        throw new Error(
          `app "${input.appId}" に同じ内容の逃げ道の資産 "${input.name}" は既に存在します。`,
        );
      }
      throw error;
    }
    return asset;
  }

  /** id で資産を取得する。未登録なら undefined。 */
  getEscapeHatchAsset(id: string): EscapeHatchAsset | undefined {
    const row = this.db
      .query<EscapeHatchAssetRow, [string]>(
        `SELECT "id", "app_id", "name", "digest", "scope_views", "created_at"
         FROM "escape_hatch_assets" WHERE "id" = ?`,
      )
      .get(id);
    return row === null ? undefined : toAsset(row);
  }

  /** 指定アプリの資産を created_at 昇順(同時刻は id 昇順)で返す。 */
  listEscapeHatchAssets(appId: string): EscapeHatchAsset[] {
    return this.db
      .query<EscapeHatchAssetRow, [string]>(
        `SELECT "id", "app_id", "name", "digest", "scope_views", "created_at"
         FROM "escape_hatch_assets" WHERE "app_id" = ?
         ORDER BY "created_at" ASC, "id" ASC`,
      )
      .all(appId)
      .map(toAsset);
  }

  /**
   * app スコープ内で資産を**名前 + ダイジェスト**で引く(V3-M5-T02 の配信が使う)。
   * マニフェストの参照が持つのがこの2要素だからである(ADR-0055 限定2)。
   * 未登録なら undefined —— **配信側はこれを fail-closed の合図として扱う**(限定6)。
   */
  findEscapeHatchAsset(appId: string, name: string, digest: string): EscapeHatchAsset | undefined {
    const row = this.db
      .query<EscapeHatchAssetRow, [string, string, string]>(
        `SELECT "id", "app_id", "name", "digest", "scope_views", "created_at"
         FROM "escape_hatch_assets" WHERE "app_id" = ? AND "name" = ? AND "digest" = ?`,
      )
      .get(appId, name, digest);
    return row === null ? undefined : toAsset(row);
  }

  /**
   * 資産を失効(削除)する(冪等。`deleteConnection` と同型)。人間 owner の操作。
   *
   * **消すのは登録だけで、本体(`apps/<appId>/escape-hatch/<sha256>`)は消さない。**
   * 消すと過去のスナップショットが参照する版を復元できなくなる(ADR-0055 限定10 は
   * 「孤児の自動刈り取りを入れない。検出のみ」と決めており、孤児が蓄積することは
   * 同 ADR §4 限界5 が「解決した」と書いてはならない債務として申告している)。
   */
  deleteEscapeHatchAsset(id: string): void {
    this.db.query(`DELETE FROM "escape_hatch_assets" WHERE "id" = ?`).run(id);
  }

  // --- 逃げ道の申請(AI 経路。ADR-0055 限定5)--------------------------------------
  //
  // **AI が到達できる上限がこの4メソッドである。**申請は作れる(requestEscapeHatchAsset)が、
  // 発行(issueEscapeHatchAsset / putEscapeHatchBody)には**別経路(owner の HTTP)からしか**
  // 到達しない。markEscapeHatchAssetRequest は承認/却下の記録であって、それ自体は発行しない
  // —— 発行は owner ルートが issueEscapeHatchAsset で行い、そのついでに mark(id,"approved") する。

  /**
   * 逃げ道の申請を作成する(`status="pending"`)。`id`(uuid)/ `createdAt`(ISO8601)は内部生成。
   * **CSS のバイト列は受け取らない**(本文を書くのは owner である)。
   * `suggestedScopeViews` は提案なので**空でもよい** —— 必須なのは owner の発行側である(限定7)。
   */
  requestEscapeHatchAsset(input: RequestEscapeHatchAssetInput): EscapeHatchAssetRequest {
    const request: EscapeHatchAssetRequest = {
      id: crypto.randomUUID(),
      appId: input.appId,
      requestedName: input.requestedName,
      purpose: input.purpose,
      suggestedScopeViews: input.suggestedScopeViews,
      status: "pending",
      createdAt: nowIso(),
    };
    this.db
      .query(
        `INSERT INTO "escape_hatch_asset_requests"
           ("id", "app_id", "requested_name", "purpose", "suggested_scope_views", "status", "created_at")
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        request.id,
        request.appId,
        request.requestedName,
        request.purpose,
        JSON.stringify(request.suggestedScopeViews),
        request.status,
        request.createdAt,
      );
    return request;
  }

  /** 指定アプリの**未承認**(status="pending")の申請を created_at 昇順(同時刻は id 昇順)で返す。 */
  listPendingEscapeHatchAssetRequests(appId: string): EscapeHatchAssetRequest[] {
    return this.db
      .query<EscapeHatchAssetRequestRow, [string]>(
        `SELECT "id", "app_id", "requested_name", "purpose", "suggested_scope_views",
                "status", "created_at"
         FROM "escape_hatch_asset_requests" WHERE "app_id" = ? AND "status" = 'pending'
         ORDER BY "created_at" ASC, "id" ASC`,
      )
      .all(appId)
      .map(toRequest);
  }

  /** id で申請を取得する。未登録なら undefined。 */
  getEscapeHatchAssetRequest(id: string): EscapeHatchAssetRequest | undefined {
    const row = this.db
      .query<EscapeHatchAssetRequestRow, [string]>(
        `SELECT "id", "app_id", "requested_name", "purpose", "suggested_scope_views",
                "status", "created_at"
         FROM "escape_hatch_asset_requests" WHERE "id" = ?`,
      )
      .get(id);
    return row === null ? undefined : toRequest(row);
  }

  /** 申請の status を承認/却下に更新する(冪等)。owner の審査経路。 */
  markEscapeHatchAssetRequest(id: string, status: "approved" | "rejected"): void {
    this.db
      .query(`UPDATE "escape_hatch_asset_requests" SET "status" = ? WHERE "id" = ?`)
      .run(status, id);
  }
}
