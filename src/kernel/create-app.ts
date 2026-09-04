/**
 * create_app(V0-P2-T03)。
 *
 * アプリ名を受け取り app_id を発行し、ADR-0002 のレイアウトどおりに
 * `<dataRoot>/apps/<app_id>/{manifest.json, app.sqlite, snapshots/}` を作り、
 * カーネル台帳に登録する。
 *
 * エラー方針: ここで失敗するのは引数エラー(空のアプリ名)と I/O エラーであり、
 * LLM が差分パッチを直して解決する種類の失敗ではないため例外で投げる。
 * `ValidationResult` は生成した空マニフェストの自己検査にのみ使う
 * (通らなければカーネルのバグなので例外に変換する)。
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { RUNNER_BUILD_VERSION } from "../shared/runner-build-version.ts";
import { generateAppId } from "./app-id.ts";
import { formatValidationErrors } from "./errors.ts";
import type { AppRecord, KernelMetaStore } from "./meta-store.ts";
import { isValidResourceId, RESOURCE_ID_MAX_LENGTH } from "./resource-id.ts";
import { appDbPath, appDir, appManifestPath, appSnapshotsDir } from "./storage-paths.ts";
import { DEFAULT_ROLE_IDS, type Manifest, type RoleDeclaration, type RoleRule } from "./types.ts";
import { validateManifestFull } from "./validate.ts";

/** create_app の結果。 */
export type CreateAppResult = {
  /** 台帳に登録された行。 */
  app: AppRecord;
  /** ディスクに書かれた空マニフェスト。 */
  manifest: Manifest;
  /** アプリのディレクトリ(`<dataRoot>/apps/<app_id>`)。 */
  appDir: string;
};

/** create_app の任意オプション。 */
export type CreateAppOptions = {
  /** 作成日時(ISO8601 UTC)。テストで固定したい場合に指定する。 */
  created_at?: string;
  /**
   * 明示的に指定する app_id。呼び出し側(将来的にはMCP経由のAI)が
   * `book-tracker` のような意味のある英語slugを渡せるようにするためのもの。
   *
   * 指定した場合:
   * - `isValidResourceId` の規約(`^[a-z][a-z0-9_-]*$`、1〜64文字)を満たさなければ
   *   規約を示すエラーを投げる
   * - 既に使われている(台帳、またはディスク上にディレクトリが存在する)場合は
   *   衝突回避の連番を付けず、明確なエラーで拒否する(黙って別のIDになるのは
   *   呼び出し側を欺くことになるため)
   *
   * 未指定の場合は現状どおりアプリ名から slug 化 + 衝突回避の連番を行う。
   */
  app_id?: string;
};

/**
 * create_app が changelog の第0行に使う `diff_id`(V1-M0-T05 / F-28)。
 *
 * `_` 始まりにしているのは、ユーザ由来の `diff_id` が `schemas/diff.schema.json` の
 * `resource_id`(`^[a-z][a-z0-9_-]*$`)に縛られており、**`_` 始まりを定義したくても
 * できない**ためである。したがって既存・将来の差分と衝突しないことが、規約(守られるとは
 * 限らない約束)ではなく構造によって保証される。`_apps` / `_changelog`(ADR-0006)と同じ手口。
 */
const CREATE_APP_DIFF_ID = "_create-app";

/**
 * 第0行の `intent`(V1-M0-T05 の決定1)。**カーネルが固定文で書く。**
 *
 * `apply_diff` の `intent` はユーザの発話を逐語で入れる規約(`INTENT_VERBATIM` / F-22)だが、
 * アプリ作成にはその発話が無いか、あっても AI の要約になる。`create_app` の引数として
 * 受け取ると、逐語のはずの欄に要約が混ざり、規約そのものが濁る。したがって
 * `undo.ts` の undo エントリ(「intent はカーネルが自動生成する」)と同じく、
 * 呼び出し側からは受け取らない。
 *
 * 文面には **これがカーネルの書いた行でありユーザの発話ではないことを明記する**(憲法6)。
 * 履歴の読み手が、逐語の行とカーネルが書いた行を取り違えないようにするため。
 */
function createAppIntent(name: string): string {
  return (
    `アプリ「${name}」を作成した(create_app)。` +
    `この行はカーネルが記録したもので、ユーザの発話ではない。`
  );
}

/**
 * 新しいアプリに最初から入れる役割の既定(`V8-M17`。台帳 `J-G2` の限定の逐語
 * 「新しいアプリの役割の一覧に、3つを既定の役割定義として最初から入れる」)。
 *
 * **3本とも `rules` を持たない**(メインの裁定 `R-13-3`)—— **既定は「名前だけ用意して
 * おく箱」である。**
 *
 * **なぜ規則を入れないのか**: **規則を既定で入れると、面(役割に束ねた権限)が全アプリで
 * 即座に働き始める。** そのとき「着手前と同じ集合が読める」ことを `API` から証明する義務
 * が生じるが、その証明は今日の4層の全挙動を宣言で再現できることを要する。**`D-V8-32` に
 * より4本の予約規約フィールドは残るので、再現ではなく二重掛けになる。**
 * **裁定 `R-4` により、規則を1本も持たない役割は面の管轄外(全許可)であり、したがって
 * 新しいアプリの既定は着手前と1ミリも変わらない。**
 *
 * **`anonymous` は既定に入れない** —— **アプリの作者が要るときだけ書く。**
 * **予約4語のうち3語だけを入れるのは、`_auth_users.role` が今日取る3値
 * (`src/auth/types.ts` の `RESERVED_ROLES`)と揃えるためである。**
 *
 * **【正直に書く】「持ち主だから見える」という分岐は、面の側に1本も無い**(`J-G2` の限定)。
 * **しかし固定ロールの層(`owner` / `editor` / `viewer` の表単位判定)は撤去の対象では
 * ないので、製品全体としては持ち主の分岐が今日も在る。**
 * **【禁止】「持ち主の特別扱いが無くなった」と書かない。**
 *
 * **【正直に書く】この既定は `set_roles` で丸ごと差し替えられる** —— **`set_roles` は
 * 全体差し替えの op であり、3本を1本も含まない宣言を書けば既定は消える。**
 * **塞いでいない**(塞ぐかどうかは本タスクの決めることではない)。
 *
 * **【2026-08-09 追記(`V8-M17`。メインの判断)。直前の段落は今日は偽である。
 * 1バイトも消していない】** **塞いだ。** **`owner` / `editor` / `viewer` の3本が
 * 1本でも欠けた宣言は、適用時検査(`src/kernel/referential-integrity.ts` の類型17)が
 * 拒否する。** **根拠は `04` §7 の `V8-M16` の完了条件 (ii)(運営3ロールが既定の役割
 * として残っていること。`D-V8-26`)と、台帳 `J-G2` の限定(足すことしかできない)である。**
 * **表示名(`name`)は変えてよい。** **既定に規則(`rules`)を足すこともできる。**
 *
 * =====================================================================================
 * **【2026-08-11 追記(`V8-M28`。ユーザ決定 `D-V8-59`。台帳 `T-G14` / `T-G17` /
 * `T-G16a`)。上の doc の「3本とも規則を1本も持たない箱である」という前提は
 * 今日から成り立たない。旧文を1バイトも消していない】**
 * =====================================================================================
 *
 * **`owner`(持ち主)にだけ、最初から2行入る。**
 * **`D-V8-59` の選ばれた見出しの逐語**: **「閉じる。持ち主には最初から2行入れておく」。**
 * **説明文の逐語**: 「何も書いていなければ誰も設定を変えられず、役割も配れません。
 * その上で、新しいアプリの持ち主にはこの2つを最初から入れておきます。
 * 表・画面・ボタンと同じ向きに揃います。」
 *
 * - **`{ target: "app", can: ["write"] }`** … **アプリの設定(定義の変更)を変えられる。**
 * - **`{ target: "role", can: ["write"] }`** … **人に役割を配れる。**
 *
 * **`editor` / `viewer` には1行も入れない**(`D-V8-59` は持ち主だけを名指ししている)。
 * **`anonymous` は今日どおり既定に入らない。**
 *
 * **【この追記が破る明文を名指しする。隠さない】** **`ADR-0304` 限定11 の逐語
 * 「**既定の役割定義3本は `rules` を1本も持たない箱として入る**」は今日から成り立たない。**
 * **加えて同 限定11 は「**既定に `rules` を足してよい**」と書いているが、
 * `V8-M28` が足した適用時検査(`referential-integrity.ts` の類型17 の拡張)により
 * **この2行だけは抜けない** —— **その意味でも限定11 を一部引き直している。**
 */
const DEFAULT_ROLE_NAMES: Record<(typeof DEFAULT_ROLE_IDS)[number], string> = {
  owner: "持ち主",
  editor: "編集者",
  viewer: "閲覧者",
};

/**
 * **持ち主に最初から入る2行**(`V8-M28`。ユーザ決定 `D-V8-59`)。
 *
 * **綴りの正は `schemas/manifest.schema.json` の `target` の `enum`(6語)と
 * `can` の `items.enum`(3語)である。** **ここに在るのは既定の値であって値域ではない。**
 * **同じ2行を要求する適用時検査は `src/kernel/referential-integrity.ts` の類型17 の
 * 拡張に在り、そちらは自分の綴りを持つ**(層が違うので import できない)——
 * **【正直に書く】同じ2行が2箇所に在る。片方だけを変えると黙ってずれる。**
 * **ずれないことを固定しているのは検査だけである。**
 */
const OWNER_DEFAULT_RULES: readonly RoleRule[] = [
  { target: "app", can: ["write"] },
  { target: "role", can: ["write"] },
];

const DEFAULT_ROLES: readonly RoleDeclaration[] = DEFAULT_ROLE_IDS.map((id) => ({
  id,
  name: DEFAULT_ROLE_NAMES[id],
  // **`owner` にだけ2行を入れる**(`D-V8-59`)。**`editor` / `viewer` は0行のままである。**
  ...(id === "owner" ? { rules: OWNER_DEFAULT_RULES.map((rule) => ({ ...rule })) } : {}),
}));

/**
 * 空のマニフェスト(テーブルもビューも持たない、有効な最小形)を作る。
 *
 * **【2026-08-09 追記(`V8-M17`。台帳 `J-G2`)】** **役割の既定3本を持つ。**
 * **`roles` は今日も省略可のままである** —— **`app.roles` を持たない既存のアプリ定義は
 * 1バイトも壊れない**(スキーマの `required` に入れていない)。
 */
export function emptyManifest(appId: string, name: string): Manifest {
  return {
    app: { id: appId, name, tables: [], views: [], roles: [...structuredClone(DEFAULT_ROLES)] },
  };
}

/**
 * アプリを新規作成する。
 *
 * @param store データルートを保持するカーネルメタストア(ここに台帳登録する)
 * @param name 人間向けのアプリ名(日本語可)
 * @throws アプリ名が空の場合、ID発行に失敗した場合、ファイル作成に失敗した場合
 */
export function createApp(
  store: KernelMetaStore,
  name: string,
  options: CreateAppOptions = {},
): CreateAppResult {
  const dataRoot = store.dataRoot;
  // 台帳とディスクの両方を見て衝突を避ける。台帳にない孤児ディレクトリを
  // 上書きしてしまわないようにするため。
  const isTaken = (candidate: string) =>
    store.hasApp(candidate) || existsSync(appDir(dataRoot, candidate));

  const appId =
    options.app_id === undefined
      ? generateAppId(name, isTaken)
      : resolveExplicitAppId(options.app_id, store, dataRoot, isTaken);

  const manifest = emptyManifest(appId, name);
  const result = validateManifestFull(manifest);
  if (!result.valid) {
    // ここに来るのはカーネル側のバグ(空マニフェストの形がスキーマと乖離した)。
    throw new Error(
      `生成した空マニフェストが不正です(カーネルのバグ):\n${formatValidationErrors(result.errors)}`,
    );
  }

  const dir = appDir(dataRoot, appId);
  mkdirSync(dir, { recursive: true });
  mkdirSync(appSnapshotsDir(dataRoot, appId), { recursive: true });
  writeFileSync(
    appManifestPath(dataRoot, appId),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf-8",
  );

  // 空でも実体のある SQLite ファイルを作っておく(ファイルコピー=スナップショットが
  // 常に成立するよう、アプリ作成直後からファイルが存在する状態にする)。
  //
  // **ここで Runner のビルド単位の版を刻む**(V5-M5-T03 / ADR-0251 限定1)。
  // 刻むのは**この Runner が今作った DB にだけ**である —— 既に在る印の無い DB を
  // 開いたときに刻み直すと「印が無い DB を新しいものとみなす」ことになり、
  // **ADR-0251 限定6 に正面から反する**(`runner-version-stamp.test.ts` が両側を固定)。
  //
  // 版は `RUNNER_BUILD_VERSION`(number リテラル)なので、`PRAGMA` に値を
  // バインドできない制約(SQLite の仕様)の下でも文字列連結が安全である。
  // `VACUUM` は `PRAGMA user_version` を保つ(docs/plan/v5/records/v5-m0.md §1-3 の (iv))ので、
  // 刻む位置は VACUUM の前でも後でも同じである。
  //
  // **この注記に日誌モードの語を書かない** —— `src/server/concurrent-write-wait.test.ts`
  // が本ファイル内のその語の出現数を 1 に固定している(`ADR-0069` 限定10)。
  const appDb = new Database(appDbPath(dataRoot, appId), { create: true });
  try {
    appDb.exec("PRAGMA journal_mode = DELETE;");
    appDb.exec(`PRAGMA user_version = ${RUNNER_BUILD_VERSION};`);
    appDb.exec("VACUUM;");
  } finally {
    appDb.close();
  }

  const created: AppRecord = store.registerApp(
    options.created_at === undefined
      ? { app_id: appId, name }
      : { app_id: appId, name, created_at: options.created_at },
  );

  // V1-M0-T05(F-28): 履歴の第0行を「アプリを作った」にする。
  // `appendChangelog` は台帳登録済みであることを要求するので、必ず registerApp の後に置く。
  store.appendChangelog({
    app_id: appId,
    diff_id: CREATE_APP_DIFF_ID,
    intent: createAppIntent(name),
    // 決定2: 「アプリを作る」を表す op は DIFF_OPS 4種に無い。**発明しない**
    // (足せば Δ1 = 門A)。undo エントリが `operations: []` なのと同じ判断である。
    // kind も "apply" / "undo" の2種のまま第3の値を足さない。
    operations: [],
    kind: "apply",
    // アプリ作成の「直前状態」というものは存在しないので、巻き戻し先も無い。
    // null であることが「この行は undo できない」を構造的に表す(undo.ts の
    // selectUndoTarget はこれを見て候補から外す)。
    snapshot: null,
    // 台帳の created_at と履歴の第0行の時刻を食い違わせない。
    ...(options.created_at === undefined ? {} : { applied_at: options.created_at }),
  });

  return { app: created, manifest, appDir: dir };
}

/**
 * 明示指定された app_id を解決する。
 *
 * 規約違反、または既に使われている(台帳 or ディスク)場合は、
 * `generateAppId` のような連番付与は行わずエラーで拒否する。
 * 明示指定なのに黙って別のIDに逃がすと、呼び出し側(将来的にはMCP経由のAI)を
 * 欺くことになるため。
 */
function resolveExplicitAppId(
  appId: string,
  store: KernelMetaStore,
  dataRoot: string,
  isTaken: (candidate: string) => boolean,
): string {
  if (!isValidResourceId(appId)) {
    throw new Error(
      `指定された app_id "${appId}" はリソースID規約に違反しています。` +
        `規約: 英小文字で始まり、使用可能文字は [a-z0-9_-]、長さは1〜${RESOURCE_ID_MAX_LENGTH}文字` +
        `(正規表現: ^[a-z][a-z0-9_-]*$)。例: "book-tracker"。`,
    );
  }

  if (!isTaken(appId)) {
    return appId;
  }

  const existing = store.getApp(appId);
  const existingInfo =
    existing === undefined
      ? `台帳には未登録ですが、ディレクトリ "${appDir(dataRoot, appId)}" が既に存在します(孤児ディレクトリの可能性があります)。`
      : `既存アプリ: name="${existing.name}", created_at=${existing.created_at}, status=${existing.status}。`;

  throw new Error(
    `指定された app_id "${appId}" は既に使用されています。${existingInfo}` +
      `明示指定された app_id には連番を付与しません。別の app_id を指定してください。`,
  );
}
