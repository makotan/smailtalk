/**
 * `_files` メタテーブルの単一ソース(V2-M2 / ADR-0035 §1)。
 *
 * ファイルの実体(blob)は `apps/<appId>/blobs/<sha256>` に content-addressed で置き、
 * その**メタデータ**(file_id / sha256 / mime / size / filename / created_at)を `app.sqlite`
 * 内の**物理システムテーブル** `_files` に持つ。image / file フィールドの値は `_files.file_id` を
 * 指す文字列で、`src/kernel/records.ts` の `fileExists` が実在確認に使う(reference が
 * 参照先 `_id` を引くのと同型)。
 *
 * ## なぜ `src/shared/` なのか
 *
 * `_files` の DDL とスキーマ定数は **カーネル(`create-app.ts` の新規アプリ初期化)** と
 * **サーバ層(アップロード API の遅延マイグレーション + INSERT)** の両方が要る。両者に
 * 同じ SQL 文字列を写すと、片方だけ直したときに列がずれる。ここに1本化することで
 * スキーマの単一ソースになる。`src/shared/system-tables.ts` と同じく **`bun:sqlite` を
 * import しない**(値の文字列/定数のみ)ため、フロント(web)が `accept` 属性や表示に
 * `ALLOWED_IMAGE_MIME` を値 import してもビルドが壊れない。
 *
 * ## 【`V17-M4-T03b`(`AC-G21`)による訂正。上の段落を1バイトも消していない】
 *
 * **上の「カーネル(`create-app.ts` の新規アプリ初期化)」は、今日すでに偽である。**
 * **`src/kernel/create-app.ts` は `_files` も本ファイルも1文字も参照していない**
 * (実測: `LC_ALL=C /usr/bin/grep -c "_files\\|files-table" src/kernel/create-app.ts` = **0**)。
 * **`_files` を実際に作るのはサーバ層の遅延マイグレーション1本だけである**
 * (`src/server/files-store.ts` の `ensureFilesTable`。アップロード API が INSERT の前に流す)。
 * **したがって「両方が要る」の実体は今日「サーバ層だけが要る」であり、
 * 単一ソースであることの意味は変わらない。**
 *
 * ## 投影しない(物理テーブルのみ)
 *
 * `_files` は `_apps` / `_changelog` / `_ai_usage`(`SYSTEM_TABLES`)のような**カーネル状態の
 * 読み取り投影ではなく**、`_auth_*`(`src/auth/store.ts`)と同じ **app.sqlite 内の物理インフラ
 * テーブル**である。したがって `SYSTEM_TABLES` には足さない —— image 値の実在確認に必要なのは
 * 物理テーブルの存在だけで、userland(MCP/API のレコード語彙)から見せる駆動要件が無い
 * (ADR-0035 §3 限定4 の投影は最小に留める判断。判断の記録は V2-M2 完了報告)。
 * `_` 始まりのため `src/kernel/resource-id.ts` の規約でユーザ定義と構造的に衝突しない。
 */

/** `_files` テーブルのID(物理テーブル名)。`records.ts` の `FILES_TABLE` と一致させる。 */
export const FILES_TABLE_ID = "_files";

/** `_files` の主キー列名。image 値が指す file_id。`records.ts` の `FILES_PK` と一致させる。 */
export const FILES_PK = "file_id";

/**
 * アップロードを受理する画像 MIME の allowlist(ADR-0035 §3 限定5)。
 * これ以外は 415。**申告 Content-Type の照合に加え、先頭バイト(マジックナンバー)でも検査する**
 * (`sniffImageMime`。Content-Type ヘッダを信用しすぎない)。
 */
export const ALLOWED_IMAGE_MIME = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

export type AllowedImageMime = (typeof ALLOWED_IMAGE_MIME)[number];

/** その MIME が allowlist に含まれるか。 */
export function isAllowedImageMime(mime: string): mime is AllowedImageMime {
  return (ALLOWED_IMAGE_MIME as readonly string[]).includes(mime);
}

/**
 * **画像**アップロードの上限(バイト)。超過は 413(ADR-0035 §3 限定5)。
 * v2 は商品画像の保存が目的で、変換・最適化はスコープ外。DoS 対策の完成ではない(§限界4)。
 *
 * **`V5-M16` / `ADR-0161` 限定2 により、この値は1バイトも変えていない。**
 * 一般のファイル(`kind=file`)の上限は下の `MAX_FILE_UPLOAD_BYTES` である。
 */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MiB

/**
 * **アップロードの2つの入口**(`V5-M16` / `ADR-0161`)。
 *
 * `POST /api/apps/:app_id/files` の multipart に `kind` パートで書く。**省略時は `image`** ——
 * **今日までに書かれたクライアントは1バイトも変えずに動く。**
 *
 * | `kind` | 受け入れる種別 | 上限 | 配信 |
 * |---|---|---|---|
 * | `image`(既定) | JPEG / PNG / WebP / GIF の4種。**先頭バイトも照合する** | `MAX_UPLOAD_BYTES`(5 MiB) | 公開行が参照していれば未認証でも配信する |
 * | `file` | **制限0件**(`D-V5-84`) | `MAX_FILE_UPLOAD_BYTES`(20,000,000 バイト) | **未認証には1件も配信しない**(`ADR-0161` 限定5) |
 *
 * **`kind` はフィールド型ではない。** `_files` の行に `kind` 列は無く、**保存後は
 * どちらの入口から来たかを区別しない** —— **配信の形は実体の先頭バイトだけで決まる**
 * (`src/server/app.ts` の配信ハンドラ)。
 */
export const UPLOAD_KINDS = ["image", "file"] as const;

export type UploadKind = (typeof UPLOAD_KINDS)[number];

/** その文字列が `kind` の値域に入るか。 */
export function isUploadKind(kind: string): kind is UploadKind {
  return (UPLOAD_KINDS as readonly string[]).includes(kind);
}

/**
 * **一般のファイル**(`kind=file`)アップロードの上限(バイト)。超過は 413。
 *
 * **`ADR-0161` 限定7 が確定させた値**(`D-V5-71` は「1件 20MB」としか決めておらず単位を
 * 決めていなかったので、`ADR-0161` が **`1000` 基数**で確定させた)。
 *
 * **`MAX_UPLOAD_BYTES`(画像 = 5 MiB)より約3.8倍大きい。** **1リクエストで受け入れる
 * バイト数が増えた分だけ、サービス停止の面は広がっている** —— **「DoS 対策が完成した」
 * とは書かない**(`ADR-0161` §1 (c) / 限定12。実測は `docs/plan/v5/records/v5-m16.md` §5)。
 */
export const MAX_FILE_UPLOAD_BYTES = 20 * 1000 * 1000; // 20 MB(1000 基数)

/**
 * 種別が分からないファイルに割り当てる MIME。
 *
 * **`kind=file` は種類を1つも制限しない**(`D-V5-84`)ので、拡張子が無い/未知の
 * ファイルも受け取る。そのとき `_files.mime` にはこの値を入れる。
 * **これは拒否ではない** —— **受け取ったうえで、種別が分からないと記録するだけである。**
 */
export const DEFAULT_UPLOAD_MIME = "application/octet-stream";

/**
 * `_files` の DDL(`IF NOT EXISTS`)。
 *
 * `IF NOT EXISTS` にすることで、**新規アプリの初期化**(`create-app.ts`)と
 * **既存アプリの遅延マイグレーション**(アップロード API がアクセス前に流す)の
 * 両方で同一 SQL を使える。列は T01 の申し送り(`records.ts` の前提)どおり:
 * `file_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, mime TEXT NOT NULL,
 *  size INTEGER NOT NULL, filename TEXT, created_at TEXT NOT NULL`。
 *
 * **【`V17-M4-T03b`(`AC-G21`)による訂正。上の3行を1バイトも消していない】**
 *
 * **「新規アプリの初期化(`create-app.ts`)」は今日すでに偽である**(上の訂正と同じ実測)。
 * **同一 SQL を使うのは、遅延マイグレーションの1本だけである。**
 *
 * **ディスク上の `_files` は 6列 → 7列になった。** **7本目は `uploaded_by TEXT`(NULL 許容)
 * = 上げた人である**(ユーザ決定 `D4` / `D2`)。
 * **`NOT NULL` にしていない** —— **`ALTER TABLE ADD COLUMN` は既定値の無い `NOT NULL` を
 * 受け付けず、列を足す前に上げた行には値が無いからである。**
 * **NULL は「上げた人が分からない」を意味し、その未参照ファイルは誰にも配らない**
 * (**運営者も例外にしない**)。
 *
 * **【7本目をこの `CREATE TABLE` に書いていない。理由を書く】**
 *
 * **7本目は `ensureFilesTable()`(`src/server/files-store.ts`)の
 * `ALTER TABLE ADD COLUMN` **1本だけ**が足す。** **新規のアプリでも、`_files` は
 * `CREATE`(6列)→ `ALTER`(7列目)の順で作られる** —— **`_files` を作る経路は
 * `ensureFilesTable()` ただ1つだから、ディスク上の `_files` はどれも7列になる。**
 *
 * **`CREATE TABLE` の側に書かなかったのは、`src/kernel/create-app.test.ts` が
 * この関数の作る列の一覧を逐語で凍結しており、`V17-M4` は `src/kernel/` に
 * 1バイトも差分を出せない**(`CP-V17` 条件7)**からである。**
 * **計画 `docs/plan/v17/05-v17-m4-plan.md` §3-3 の (3) は「`createFilesTableSql()` に
 * 1列足す」と書いていたが、その計画は検査を1度も走らせていない**(同 §1-2 の 1)——
 * **実行して初めて分かった衝突であり、実施担当が置き場だけを変えた。**
 * **列の綴りは今日も1本(`FILES_UPLOADED_BY_COLUMN_DDL`)であり、単一ソースは保たれている。**
 * `required` を DDL の NOT NULL にする方針は `ddl.ts` のユーザテーブルとは別 ——
 * `_files` はカーネル/サーバが直接 INSERT する内部テーブルで additive マイグレーションの
 * 対象外なので、ここは NOT NULL を素直に付けて不変条件を DB に固定する。
 */
/**
 * **`_files` の7本目の列の DDL 断片**(`V17-M4-T03b` / `AC-G21`)。
 *
 * **`CREATE TABLE` と `ALTER TABLE ADD COLUMN` の両方がこの1本を使う** ——
 * **同じ列の綴りを2箇所に写すと、片方だけ直したときに列がずれる**(このファイルの主旨)。
 * **先例は `src/auth/store.ts` の `ACTIVITY_CHANGES_COLUMN_DDL` である。**
 *
 * **【`V17-M4-T06` による訂正。上の3行を1バイトも消していない】**
 *
 * **「`CREATE TABLE` と `ALTER TABLE ADD COLUMN` の両方がこの1本を使う」は、
 * これを書いたその場で偽である。** **今日この定数を使うのは `ensureFilesTable()` の
 * `ALTER TABLE ADD COLUMN` の**1つだけ**であり、`createFilesTableSql()` は今日も6列のまま
 * この定数を1度も読まない**(下の関数の本体がそのとおりである)。
 * **そう書けない理由は、この doc の30行ほど上に自分で正しく書いてある** ——
 * **`src/kernel/create-app.test.ts` が `createFilesTableSql()` の列を逐語で凍結しており、
 * `V17-M4` は `src/kernel/` に1バイトも差分を出せないからである。**
 * **単一ソースであること(綴りを2箇所に写さない)自体は今日も真であり、
 * 2箇所目ができたときにこの定数を読ませればよい。** **独立点検の指摘。**
 */
export const FILES_UPLOADED_BY_COLUMN_DDL = '"uploaded_by" TEXT';

/** `_files` の「上げた人」列の名前。**NULL は「上げた人が分からない」を意味する。** */
export const FILES_UPLOADED_BY = "uploaded_by";

export function createFilesTableSql(): string {
  return (
    `CREATE TABLE IF NOT EXISTS "${FILES_TABLE_ID}" (\n` +
    `  "${FILES_PK}" TEXT PRIMARY KEY,\n` +
    `  "sha256" TEXT NOT NULL,\n` +
    `  "mime" TEXT NOT NULL,\n` +
    `  "size" INTEGER NOT NULL,\n` +
    `  "filename" TEXT,\n` +
    `  "created_at" TEXT NOT NULL\n` +
    `)`
  );
}
