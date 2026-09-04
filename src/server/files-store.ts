/**
 * アップロード API のサーバ層ヘルパ(V2-M2-T02 / ADR-0035 §1・限定5)。
 *
 * `_files`(app.sqlite 内の物理テーブル)への遅延マイグレーション + INSERT と、
 * **マジックナンバー(先頭バイト)による MIME 検査**を持つ。DDL/スキーマの単一ソースは
 * `src/shared/files-table.ts`(kernel の create-app と共有)。blob 実体の保存は
 * kernel の `putBlob`(content-addressed)が行い、ここはメタ行だけを扱う。
 *
 * upload/delivery を **server 層の HTTP ルート**に置く(kernel の CRUD 語彙 = DIFF_OPS/MCP を
 * 増やさない。ADR-0035 §3 限定5)ため、DB を直接叩くこの薄いヘルパも server 層に置く。
 */
import type { Database } from "bun:sqlite";
import {
  type AllowedImageMime,
  createFilesTableSql,
  FILES_PK,
  FILES_TABLE_ID,
} from "../shared/files-table.ts";

/** `_files` の1行(API が返す形と一致)。 */
export type FileRecord = {
  file_id: string;
  sha256: string;
  /**
   * **`V5-M16` / `ADR-0161` で `AllowedImageMime` から `string` に広げた。**
   * `kind=image` では今日どおり実体判定(sniff)の結果しか入らないが、
   * **`kind=file` は種類を1つも制限しない**(`D-V5-84`)ので、任意の申告値
   * (拡張子が無ければ `application/octet-stream`)が入る。
   * **この値は配信の `Content-Type` を決めない** —— 決めるのは実体の先頭バイトである
   * (`src/server/app.ts` の配信ハンドラ)。
   */
  mime: string;
  size: number;
  filename: string | null;
};

/**
 * `_files` テーブルを用意する(`CREATE TABLE IF NOT EXISTS`)。
 *
 * 新規アプリは `create-app.ts` が作成時に流すが、**本機能導入前に作られた既存アプリ**には
 * `_files` が無い。アップロードのたびに INSERT の前へ流すことで遅延マイグレーションになる
 * (`ensureAuthActivitySchema` が `_auth_activity` を遅延生成するのと同型)。冪等。
 */
export function ensureFilesTable(db: Database): void {
  db.exec(createFilesTableSql());
}

/**
 * `_files` に1行 INSERT する。**file_id は sha256 とは別の UUID**(呼び出し側が発行)—— 同一内容を
 * 別 filename で複数回上げても別 file_id にできる(blob 実体は sha256 で共有)。`created_at` は
 * ISO8601 UTC。`_files` は `_` 始まりで `quoteIdentifier` を通せないため固定リテラルを直接埋め、
 * 値は必ずプレースホルダにする(SQL インジェクション防御)。
 */
export function insertFileRecord(db: Database, record: FileRecord): void {
  const now = new Date().toISOString();
  db.query(
    `INSERT INTO "${FILES_TABLE_ID}" ` +
      `("${FILES_PK}", "sha256", "mime", "size", "filename", "created_at") ` +
      `VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(record.file_id, record.sha256, record.mime, record.size, record.filename, now);
}

/**
 * 配信(GET /files/:file_id)が `_files` から引く最小メタ(V2-M2-T03 / ADR-0035 §1c)。
 *
 * **`V5-M16-T03` で `filename` を足した** —— ダウンロードで返すときの
 * `Content-Disposition: attachment; filename=...` に要る。**`mime` は残してあるが、
 * 配信の `Content-Type` はこれではなく実体の先頭バイトから決まる。**
 */
export type FileDeliveryMeta = { sha256: string; mime: string; filename: string | null };

/**
 * `_files` から file_id のメタ(sha256 / mime)を引く。配信 API が blob 実体の場所(sha256)と
 * Content-Type(mime = アップロード時の sniff 済み)を得るために使う(V2-M2-T03)。
 *
 * **`_files` は遅延生成**(画像を一度もアップロードしていないアプリには存在しない)。その場合と
 * file_id が無い場合はどちらも `null` を返し、配信側は 404 に倒す(存在秘匿)。`ensureFilesTable`
 * を**呼ばない** —— 配信は読み取り専用で、テーブルを勝手に作らない(空テーブルを生む副作用を避ける)。
 */
export function getFileMeta(db: Database, fileId: string): FileDeliveryMeta | null {
  const tableRow = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(FILES_TABLE_ID);
  if (tableRow === null) {
    return null; // `_files` 未生成(画像未アップロードのアプリ)
  }
  const row = db
    .query(
      `SELECT "sha256" AS sha256, "mime" AS mime, "filename" AS filename ` +
        `FROM "${FILES_TABLE_ID}" WHERE "${FILES_PK}" = ?`,
    )
    .get(fileId) as FileDeliveryMeta | null;
  return row ?? null;
}

/**
 * 先頭バイト(マジックナンバー)から画像 MIME を判定する(ADR-0035 §3 限定5)。
 *
 * **Content-Type ヘッダを信用しすぎない**ための検査。判定できたのが allowlist の型で、かつ
 * 申告 MIME と一致することをアップロードハンドラが確かめる。判定できなければ `null`。
 *
 * **`V5-M16-T03` から、配信側もこの関数を使う。** **配信は「これが `null` を返したら必ず
 * ダウンロードで返す」** —— 4種の画像はどれも script を実行しないので inline にでき、
 * それ以外は(HTML / SVG を含めて)ブラウザ内で開かせない。
 */
export function sniffImageMime(data: Uint8Array): AllowedImageMime | null {
  // JPEG: FF D8 FF
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  ) {
    return "image/png";
  }
  // GIF: "GIF87a" / "GIF89a"
  if (
    data.length >= 6 &&
    data[0] === 0x47 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x38 &&
    (data[4] === 0x37 || data[4] === 0x39) &&
    data[5] === 0x61
  ) {
    return "image/gif";
  }
  // WEBP: "RIFF" .... "WEBP"
  if (
    data.length >= 12 &&
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}
