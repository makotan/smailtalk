/**
 * 配布物用の `data/` を、**配るアプリ1件分だけ**で組み立てる(`V5-M2-T02` = `R-G5`)。
 *
 * 門A本審査(`docs/plan/v5/records/v5-m0.md` §2-5)の判定は **門外(記録)** である。
 * 判定の根拠は「Δ1 / Δ2 / Δ3 / Δ8 がすべて空」であり、本ファイルはその宣言に従って
 * **`src/kernel/` に関数を1本も足さず、`scripts/` のビルド時スクリプトとして置く。**
 *
 * ## 何を解くのか
 *
 * `kernel.sqlite` は全アプリ共有である(`ADR-0006` §6b)。そのまま配ると、配布先の
 * `_changelog` に**他アプリの依頼文の逐語**が載る(`V5-M0` §2-5 S3 の 3)。
 * ここは「1アプリ分だけを持つ `kernel.sqlite` を組み立てる手段」であって、
 * **`kernel.sqlite` の構造そのものは1バイトも変えない**(`ADR-0006` §6b を書き換えない)。
 *
 * ## 取り出しの単一ソース
 *
 * **`APP_SCOPED_KERNEL_TABLES`(`src/kernel/delete-app.ts`)である。** 配列をコピーして
 * 別の一覧をここに作らない(`V5-M0` §2-5 の逐語「配列をコピーして別の一覧を作らない」)。
 * `deleteApp` が「消す側」で使う集合を、ここは「残す側」で使う ——
 * **`deleteApp` の逆である**(同 S3 の 2)。
 *
 * ## 「消してから配る」ではなく「空へ流し込む」を採る
 *
 * `kernel.sqlite` をコピーしてから他アプリの行を `DELETE` すると、**削除済みページの
 * 残骸としてバイト列がファイルに残りうる。** `_changelog` の `intent` は依頼文の逐語
 * なので、行として見えなくてもファイルを覗けば読める形が残る。したがって
 * **空の DB に DDL を張り直し、1アプリ分の行だけを `INSERT ... SELECT` で流し込む**
 * (`V5-M0` §2-5 S4 ② が W-A と等級づけた2案のうちの後者)。
 * `scripts/build-runner-data.test.ts` が、他アプリの `intent` の逐語が出力の
 * バイト列に1回も現れないことを固定している。
 *
 * ## やらないこと(先に書く)
 *
 * - **原子性を取らない。** `kernel.sqlite` の組み立て(単一 tx)とアプリディレクトリの
 *   コピー(ファイルシステム)は1つのトランザクションに入らない。`deleteApp` が
 *   `ADR-0031` で受容したのと同型の構造制約である(`V5-M0` §2-5 S3 の 2)。
 *   **途中で失敗したら、作りかけの出力先を消してから throw する。**
 * - ~~**`apps/<appId>/snapshots/` を選り分けない。** アプリディレクトリを丸ごとコピーする。~~
 *   **【`V5-M7f-T02` の追記(2026-08-06)】この一文は今日の正ではない。**
 *   **`D-V5-97`(ユーザ決定)により、配る器に `apps/<appId>/snapshots/` を入れない。**
 *   **選り分ける**(`cpSync` の `filter`)。**外した件数は `excludedSnapshots` として返す。**
 *   **代償**: **配った先で「配る前の状態に戻す」ことはできなくなる。**
 *   元の `data/` の控えは1件も消さない(読むだけである)。
 * - **`PRAGMA user_version` をコピーしない。** 今日 `kernel.sqlite` の `user_version` を
 *   読む箇所は `src` / `scripts` / `web` に0件である(2026-08-06 実測)。
 *   **【`V5-M5-T04` の追記(2026-08-06)】この一文はコピーについては今日も成立するが、
 *   後半の「読む箇所が0件」は成立しなくなった** —— `src/server/runner-version-gate.ts` が
 *   起動時に読む(`ADR-0251`)。**コピーはしないが、出力の `kernel.sqlite` には
 *   `RUNNER_BUILD_VERSION` を刻む** —— ここは DDL を張り直して**新しく作る**ので、
 *   刻まなければ組み立てた配布物そのものがゲートに止められる(実測済み)。
 *   **これは「印の無い DB の救済」ではない**(`ADR-0251` 限定6)—— **この Runner が
 *   今この場で作った DB に、作った時点で刻んでいる。**
 *   ~~**`app.sqlite` は刻み直さない**(`cpSync` で元の版がヘッダごと運ばれる)。~~
 *   **【`V5-M7f-T01` の追記(2026-08-06)】この一文は今日の正ではない。**
 *   **`app.sqlite` も、印が有って器の版と食い違うときは刻み直す**(下の `restampAppDb`)。
 *   刻み直さないままだと、**版を上げてから `--from` で組み直した器が、空のボリュームで
 *   起動しない** —— `kernel.sqlite` だけが新しい版になり、`app.sqlite` が古い版のまま
 *   運ばれるためである(`docs/evidence/cp-v5.md` §5-8 の 1 の実測)。
 *   **印が無い(`user_version = 0`)ものには1バイトも書かない**(限定6)。
 * - **`APP_SCOPED_KERNEL_TABLES` に載っていないテーブルの行を1行もコピーしない。**
 *   DDL は張るので**空のテーブルとして存在する。** 該当したテーブル名は
 *   `skippedTables` として返す。**これは報告であって検査ではない** ——
 *   「次に足し忘れたら赤くなる」検査は `V5-M0` §2-14 が禁じている。
 *   **【`V10-M33-T02` の追記(2026-08-26)】上の一文だけでは今日の正を言い切れない。**
 *   **`RUNNER_EXCLUDED_TABLES` に載っているテーブルも、単一ソースに載っているのに
 *   行を1行もコピーしない**(`D-V10-39` / `CM-G43`)。今日それに当たるのは
 *   `gp_comments` 1本である。**DDL は張るので表そのものは配布データにも在り、
 *   配った先で新しくコメントを書ける**(`D-V10-38` の土台)。持ち込まないのは
 *   **元の環境で書かれた過去の行**だけである。
 *
 * ## 使い方
 *
 * ```
 * mise exec -- bun run scripts/build-runner-data.ts <元のdata> <出力先のdata> <app_id>
 * ```
 */
import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { sep } from "node:path";
import { quoteIdentifier } from "../src/kernel/ddl.ts";
import { APP_SCOPED_KERNEL_TABLES } from "../src/kernel/delete-app.ts";
import { appDbPath, appDir, appSnapshotsDir, kernelDbPath } from "../src/kernel/storage-paths.ts";
import { RUNNER_BUILD_VERSION } from "../src/shared/runner-build-version.ts";

/** `apps` 自身。`APP_SCOPED_KERNEL_TABLES` は「`apps` を除く」集合なので別に持つ。 */
const APPS_TABLE = "apps";

/**
 * **配布データに行を1件も入れない表**(`D-V10-39` / `CM-G43` / `V10-M33-T02`)。
 * **`APP_SCOPED_KERNEL_TABLES` からは1要素も落とさない** —— 落とすとアプリ削除時の掃除が漏れる
 * (審査の限定。`ADR-0007:1678`)。**外すのはコピーの対象からだけである。**
 */
export const RUNNER_EXCLUDED_TABLES = ["gp_comments"] as const;

export type BuildRunnerDataOptions = {
  /** 元のデータルート(`data/` 相当)。全アプリを持つ `kernel.sqlite` がある。 */
  sourceDataRoot: string;
  /** 出力先のデータルート。**既に `kernel.sqlite` があれば拒否する**(上書きしない)。 */
  targetDataRoot: string;
  /** 配るアプリのID。 */
  appId: string;
};

export type BuildRunnerDataResult = {
  appId: string;
  targetDataRoot: string;
  /** テーブルごとのコピー行数(`apps` + 単一ソースのうち元に実在したもの)。 */
  copiedRows: Record<string, number>;
  /**
   * 元の `kernel.sqlite` に在ったが、**単一ソースに載っていないため1行もコピーしなかった**
   * テーブル。**報告であって検査ではない**(冒頭「やらないこと」)。
   *
   * **【`V10-M33-T02` の追記(2026-08-26)】上の一文は今日の正ではない。**
   * 理由は2つに増えた。**1行もコピーしなかったテーブル**であることは今日も変わらないが、
   * その理由は「単一ソースに載っていない」だけではない ——
   * **`RUNNER_EXCLUDED_TABLES` に載っているものは、単一ソースに載っていてもここに入る。**
   * 今日それに当たるのは `gp_comments` 1本だけである(`D-V10-39` / `CM-G43`)。
   */
  skippedTables: string[];
  /**
   * 焼いた `app.sqlite` の `PRAGMA user_version`(**出力側の値**)。
   * **`0` は「印が無い」であり、起動時のゲートに止められる**(`ADR-0251` 限定6)。
   */
  appDbUserVersion: number;
  /**
   * `app.sqlite` の印を刻み直したときの**刻み直す前の値**。刻み直していなければ `null`。
   * **印が無い(`0`)ものは刻み直さない** —— そのとき `null` である。
   */
  restampedAppDbFrom: number | null;
  /**
   * **器に入れなかった過去の控えの件数**(`D-V5-97`)。`apps/<appId>/snapshots/` の直下の
   * エントリ数である。**元の `data/` から消した件数ではない**(元は1件も消さない)。
   */
  excludedSnapshots: number;
};

/** `sqlite_master` の1行(DDL の張り直しに使う分だけ)。 */
type MasterRow = { type: string; name: string; sql: string };

/**
 * **焼いた `app.sqlite` の印を、この器の版に合わせる**(`V5-M7f-T01`)。
 *
 * ## 何を直しているのか
 *
 * `kernel.sqlite` は DDL を張り直して**新しく作る**ので、その場で `RUNNER_BUILD_VERSION`
 * を刻める。**`app.sqlite` は `cpSync` で複製されるので、元の印がヘッダごと運ばれる。**
 * **`RUNNER_BUILD_VERSION` を上げてから `--from` で組み直すと、器の中で
 * `kernel.sqlite` = 新しい版 / `app.sqlite` = 古い版に割れる。** 起動口はそれを空の
 * ボリュームへ撒くので、**器がその場で自分のゲートに止められる**
 * (`docs/evidence/cp-v5.md` §5-8 の 1 の実測。**受け取った人はイメージの中で移行器を
 * 打てない** —— 移行器はイメージに入っていない。`ADR-0252` 限定4)。
 *
 * ## 【これは「印の無い DB の救済」ではない】(`ADR-0251` 限定6)
 *
 * **書き換えるのは「印が有って、器の版と食い違っている」ものだけである。**
 * **`user_version = 0`(印が無い)には1バイトも書かない。** 印の無い元データから組んだ
 * 器は、今日どおりゲートに止められる —— **`D-V5-13`(既存アプリは配布しない)の帰結は
 * 1ミリも変わっていない。**
 *
 * ## 【迂回口ではない】(`ADR-0251` 限定5)
 *
 * **照合する側(`src/server/runner-version-gate.ts`)に1バイトも触っていない。**
 * `--force` も無効化の環境変数も「警告だけ出して続行」も1つも作っていない。
 * ここが触るのは**器がこれから焼くデータ**であって、**利用者のボリュームではない。**
 *
 * ## 【この形が確かめていないこと。隠さない】
 *
 * **刻み直しは「このデータが新しい版のコードで正しく動く」ことを1ミリも確かめない。**
 * 確かめずに印だけを合わせている。**`ADR-0251` 限定8(版が合っていて中身が違う
 * ボリュームは素通りする)が受容した範囲そのものである。**
 */
function restampAppDb(path: string): {
  appDbUserVersion: number;
  restampedAppDbFrom: number | null;
} {
  if (!existsSync(path)) {
    return { appDbUserVersion: 0, restampedAppDbFrom: null };
  }
  const db = new Database(path);
  try {
    const before =
      db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
    // **印が無いものは救済しない**(限定6)/ **既に合っているものは触らない。**
    if (before === 0 || before === RUNNER_BUILD_VERSION) {
      return { appDbUserVersion: before, restampedAppDbFrom: null };
    }
    db.exec(`PRAGMA user_version = ${RUNNER_BUILD_VERSION};`);
    return { appDbUserVersion: RUNNER_BUILD_VERSION, restampedAppDbFrom: before };
  } finally {
    db.close();
  }
}

/**
 * 元の `kernel.sqlite` を読み取り専用で開き、実在確認と DDL の採取だけを行う。
 * **出力先には1バイトも書かない**(実在しない app_id を渡したときに作りかけを残さない)。
 */
function inspectSource(sourceDbPath: string, appId: string): { ddl: string[]; tables: string[] } {
  const src = new Database(sourceDbPath, { readonly: true });
  try {
    const found = src
      .query<{ app_id: string }, [string]>(`SELECT "app_id" FROM "apps" WHERE "app_id" = ?`)
      .get(appId);
    if (found === undefined) {
      const all = src
        .query<{ app_id: string }, []>(`SELECT "app_id" FROM "apps" ORDER BY "app_id"`)
        .all()
        .map((row) => row.app_id);
      throw new Error(
        `配るアプリ "${appId}" が元の kernel.sqlite の台帳に在りません。` +
          `実在する app_id: ${all.length === 0 ? "(0件)" : all.join(" / ")}`,
      );
    }
    // `sqlite_sequence` などの内部テーブルは除く(`_` は LIKE のワイルドカードなので ESCAPE する)。
    const master = src
      .query<MasterRow, []>(
        `SELECT "type", "name", "sql" FROM "sqlite_master"
          WHERE "sql" IS NOT NULL AND "name" NOT LIKE 'sqlite~_%' ESCAPE '~'
          ORDER BY CASE "type" WHEN 'table' THEN 0 ELSE 1 END, "name"`,
      )
      .all();
    return {
      ddl: master.map((row) => row.sql),
      tables: master.filter((row) => row.type === "table").map((row) => row.name),
    };
  } finally {
    src.close();
  }
}

/**
 * 配るアプリ1件分だけを持つ `data/` を組み立てる。
 *
 * @throws 元の `kernel.sqlite` が無い / 配るアプリが台帳に無い / 出力先に既に
 *   `kernel.sqlite` がある / アプリディレクトリが元に無い場合。
 */
export function buildRunnerData(options: BuildRunnerDataOptions): BuildRunnerDataResult {
  const { sourceDataRoot, targetDataRoot, appId } = options;
  const sourceDbPath = kernelDbPath(sourceDataRoot);
  const targetDbPath = kernelDbPath(targetDataRoot);

  if (!existsSync(sourceDbPath)) {
    throw new Error(`元の kernel.sqlite が見つかりません: ${sourceDbPath}`);
  }
  if (existsSync(targetDbPath)) {
    throw new Error(
      `出力先に kernel.sqlite が既に在ります(上書きしません): ${targetDbPath}。` +
        `別の空のディレクトリを指定するか、先に消してください。`,
    );
  }
  const sourceAppDir = appDir(sourceDataRoot, appId);
  if (!existsSync(sourceAppDir)) {
    throw new Error(
      `配るアプリ "${appId}" の台帳行は在りますが、実体ディレクトリが在りません: ${sourceAppDir}`,
    );
  }

  // **過去の控えは器に入れない**(`D-V5-97`)。**元の `data/` からは1件も消さない。**
  const sourceSnapshotsDir = appSnapshotsDir(sourceDataRoot, appId);
  const excludedSnapshots = existsSync(sourceSnapshotsDir)
    ? readdirSync(sourceSnapshotsDir).length
    : 0;

  const { ddl, tables } = inspectSource(sourceDbPath, appId);
  const copyTargets = [APPS_TABLE, ...APP_SCOPED_KERNEL_TABLES]
    .filter((table) => !(RUNNER_EXCLUDED_TABLES as readonly string[]).includes(table))
    .filter((table) => tables.includes(table));
  const skippedTables = tables.filter((table) => !copyTargets.includes(table));

  mkdirSync(targetDataRoot, { recursive: true });
  const copiedRows: Record<string, number> = {};
  const out = new Database(targetDbPath, { create: true });
  try {
    for (const sql of ddl) {
      out.run(sql);
    }
    out.run(`ATTACH DATABASE ? AS "src"`, [sourceDbPath]);
    // `apps` を先に入れる(`changelog` が `apps("app_id")` を FK 参照する。`deleteApp` が
    // `apps` を最後に消すのとちょうど逆順である)。
    const copy = out.transaction(() => {
      for (const table of copyTargets) {
        const quoted = quoteIdentifier(table);
        out.run(`INSERT INTO "main".${quoted} SELECT * FROM "src".${quoted} WHERE "app_id" = ?`, [
          appId,
        ]);
        copiedRows[table] =
          out.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM "main".${quoted}`).get()?.c ?? 0;
      }
    });
    copy();
    out.run(`DETACH DATABASE "src"`);
    // 新しく作った `kernel.sqlite` に Runner のビルド単位の版を刻む(`V5-M5-T04` /
    // `ADR-0251` 限定7)。`KernelMetaStore.open` が新規作成時にだけ刻むのと同じ規則である。
    out.exec(`PRAGMA user_version = ${RUNNER_BUILD_VERSION};`);
    out.close();
    // ここから先はファイルシステム。**単一 tx に入らない**(冒頭「やらないこと」)。
    cpSync(sourceAppDir, appDir(targetDataRoot, appId), {
      recursive: true,
      // **`apps/<appId>/snapshots/` を1件も入れない**(`D-V5-97`)。ディレクトリを
      // `false` で落とすと、その下は1ファイルも歩かれない。
      filter: (src) => src !== sourceSnapshotsDir && !src.startsWith(`${sourceSnapshotsDir}${sep}`),
    });
    const restamped = restampAppDb(appDbPath(targetDataRoot, appId));
    return {
      appId,
      targetDataRoot,
      copiedRows,
      skippedTables,
      excludedSnapshots,
      ...restamped,
    };
  } catch (cause) {
    out.close();
    // 作りかけの出力を残さない(黙って半端にしない)。
    rmSync(targetDbPath, { force: true });
    rmSync(appDir(targetDataRoot, appId), { recursive: true, force: true });
    throw cause;
  }
}

if (import.meta.main) {
  const [sourceDataRoot, targetDataRoot, appId] = process.argv.slice(2);
  if (sourceDataRoot === undefined || targetDataRoot === undefined || appId === undefined) {
    console.error(
      "使い方: bun run scripts/build-runner-data.ts <元のdata> <出力先のdata> <app_id>",
    );
    process.exit(2);
  }
  const result = buildRunnerData({ sourceDataRoot, targetDataRoot, appId });
  console.log(JSON.stringify(result, null, 2));
}
