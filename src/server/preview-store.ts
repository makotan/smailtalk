/**
 * **下見の置き場**(`V20-M13-T01`。計画 `docs/plan/v20/15-v20-m13-plan.md` §9-2・§10-5・
 * §10-10 の2 / `ADR-0476`)。
 *
 * `dry_run_diff` に `preview` を付けて呼ぶと、当てた後の複製を消さずに残し、ここに登録する。
 * 下見の URL(`/apps/pv-<識別子>/`)を受けた Web サーバはここから複製を引く。
 * **複製を作るのは MCP のプロセス、描くのは Web サーバのプロセス** なので、このモジュールは
 * カーネルの外(`src/server/`)に置き、両方から import する。**カーネルには足さない**
 * (`ADR-0476` 2-6: `dry-run.ts` に足すのは残す指定1つだけ)。
 *
 * ## 置き場の形
 *
 * ```
 * <根>/                      ← ST_PREVIEW_ROOT。既定は <resolve(dataRoot)>.previews(0700)
 * └── <識別子>/              ← 16進32桁(128ビットの暗号的乱数)。0700
 *     ├── .smailtalk-preview ← 予約のときに書く目印(空)。掃除はこれの在る置き場だけを消す(V20-M13 中1)
 *     ├── meta.json          ← 0600。PreviewMeta
 *     ├── candidate.json     ← 0600。見比べの案のときだけ(`V20-M14-T01A`。PreviewCandidate)
 *     └── gp-dry-run-XXXX/   ← dryRunDiff の keepUnder が作った置き場
 *         └── data/          ← 複製のデータルート(meta.json の shadow_data_root)
 * ```
 *
 * **見比べの束**(`V20-M14-T01A`。計画 `16-v20-m14-plan.md` §10-2 / `ADR-0478` §Decision 1-3):
 *
 * ```
 * <根>/
 * └── <束の識別子>/          ← 下見と同じ綴り(128ビットの乱数)。0700。**写しを持たない**
 *     ├── .smailtalk-preview ← 目印(掃除の対象であることの印)
 *     └── group.json         ← 0600。PreviewGroup。**meta.json は持たない**
 * ```
 *
 * 束は最初の案を作れたときだけ作るので、**束の数 ≤ 下見の数 ≤ 20、置き場のディレクトリは最大40**。
 * 上限20は写しを持つ下見だけを数える({@link listPreviewEntryIds})。
 *
 * **既定を `dataRoot` の隣にする理由**: 2つのプロセスが同じ `ST_DATA_ROOT` を読むので、
 * 隣なら同じ場所を指す。`TMPDIR` はプロセスごとに同じである保証が無い(T00 §4-4 の4)。
 * **`dataRoot` の中に置かない**(`dry-run.ts` 冒頭「作業領域」の2つの理由)。
 *
 * ## 上限(**メインの決定。ユーザに聞いていない**。計画 §10-5)
 *
 * - **期限**: 作った時刻から {@link PREVIEW_TTL_SECONDS} 秒(定数。引数にしない)。
 * - **個数**: 根ごとに {@link PREVIEW_MAX_ENTRIES} 個。**超えたら新しい下見を断る。古いものを
 *   消さない**(「1時間見られる」の約束を守る側に倒す)。
 * - **大きさ**: 本体の `app.sqlite` が {@link PREVIEW_MAX_APP_DB_BYTES} バイトを超えるアプリでは
 *   作らない。
 *
 * **時計は注入できる**(`now`)。検査で期限の前後を撃つためである。
 */

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { appDbPath } from "../kernel/storage-paths.ts";

/** 下見の期限(秒)。**作った時刻から数える。**(`D-V20-43`) */
export const PREVIEW_TTL_SECONDS = 3600;

/** 根ごとの下見の個数の上限。**超えたら新しい下見を断る。** */
export const PREVIEW_MAX_ENTRIES = 20;

/** 下見を作れる本体の `app.sqlite` の大きさの上限(バイト)。**ちょうどは作る。** */
export const PREVIEW_MAX_APP_DB_BYTES = 100 * 1024 * 1024;

/** URL 上のアプリID の接頭辞。`pv-<識別子>` の形でアプリID の許される綴りに収まる。 */
export const PREVIEW_APP_ID_PREFIX = "pv-";

/** 置き場の中の登録票の名前。 */
export const PREVIEW_META_FILE = "meta.json";

/**
 * **下見が作った置き場の目印**(`V20-M13` 点検の処置 中1)。 予約({@link reservePreview})の時点で
 * 置き場の中に書く。 **掃除はこの目印の在る置き場だけを消す** —— `ST_PREVIEW_ROOT` に共有の
 * ディレクトリを書かれても、下見が作っていない16進32桁の名前のディレクトリを消さない。
 */
export const PREVIEW_ENTRY_MARKER_FILE = ".smailtalk-preview";

/** 見比べの束の登録票の名前(`V20-M14-T01A`。束の置き場だけが持つ)。 */
export const PREVIEW_GROUP_FILE = "group.json";

/** 見比べの案の票の名前(`V20-M14-T01A`。束に入った下見の置き場だけが持つ)。 */
export const PREVIEW_CANDIDATE_FILE = "candidate.json";

/**
 * **束の錠**(`V20-M14` 点検の処置 中1。束の置き場の中に一時だけ在る空のファイル)。 束への追記・取り除き・
 * 数え直しをこの錠の中で行う({@link withGroupLock})。 **錠を持つ間だけ在り、離すと消す。**
 */
export const PREVIEW_GROUP_LOCK_FILE = "group.lock";

/** 錠を待つ上限(ミリ秒)。 過ぎたら投げる(呼ぶ側は「もう一度呼んでください」で断る)。 */
export const PREVIEW_GROUP_LOCK_WAIT_MS = 2000;

/** これより古い錠は、持ち主が落ちた残骸とみなして外す(ミリ秒)。 */
export const PREVIEW_GROUP_LOCK_STALE_MS = 10_000;

/** 1つの束に並べられる案の数の上限(`D-V20-47`。4案目は断る)。 */
export const COMPARE_MAX_CANDIDATES = 3;

const PREVIEW_ID_PATTERN = /^[0-9a-f]{32}$/;
const PREVIEW_APP_ID_PATTERN = /^pv-([0-9a-f]{32})$/;

/** 下見のモード。`real` = 実データ、`sample` = 見本の行(`D-V20-44`)。 */
export type PreviewMode = "real" | "sample";

/** 時計。検査で差し替える。 */
export type PreviewClock = () => Date;

/** 置き場の `meta.json`。**パスは全部絶対パス**(計画 §10-8)。 */
export type PreviewMeta = {
  preview_id: string;
  app_id: string;
  /** 下見を頼んだ人の利用者ID(本体と複製の `_auth_users.id`)。 */
  requester_user_id: string;
  mode: PreviewMode;
  created_at: string;
  expires_at: string;
  /** 複製のデータルート(絶対パス)。 */
  shadow_data_root: string;
  /**
   * 複製の中にだけ作った、頼んだ人のセッションの ID。**前段がサーバの内側で付ける。
   * ブラウザには渡さない**(`ADR-0476` §Decision 1 の 2)。
   */
  session_id: string;
};

/**
 * 見比べの束の登録票 `group.json`(`V20-M14-T01A` / `ADR-0478` §Decision 1-3)。 識別子は16進32桁
 * (URL 上は `pv-` を付ける)。 **期限は最初の案と同じ。** `candidates` は作った順の案の識別子。
 */
export type PreviewGroup = {
  group_id: string;
  app_id: string;
  requester_user_id: string;
  mode: PreviewMode;
  created_at: string;
  expires_at: string;
  candidates: string[];
};

/**
 * 見比べの案の票 `candidate.json`(`V20-M14-T01A` / 計画 §9-1)。 `diff` は AI が渡した差分そのもの
 * (`intent` を含む)、`design_notices` は作成時に計算した注意、`base_manifest_sha` は作成時の本物の
 * `manifest.json` の生バイトの sha256({@link manifestSha256})、`group` は束の識別子(16進32桁)。
 * **【`V20-M15-T01B` / `ADR-0479` §Decision 4-4】`off_pattern` は案が型から外れるという AI の申告**(真偽)。
 * **読むときに無ければ(真偽でなければ)`false`**({@link readCandidate}。期限1時間の古い票を壊さない)。
 */
export type PreviewCandidate = {
  name: string;
  tradeoff: string;
  diff: unknown;
  design_notices: unknown[];
  base_manifest_sha: string;
  group: string;
  off_pattern: boolean;
};

const systemClock: PreviewClock = () => new Date();

/** 既定の置き場の根: `<resolve(dataRoot)>.previews`。 */
export function defaultPreviewRoot(dataRoot: string): string {
  return `${resolve(dataRoot)}.previews`;
}

/**
 * 置き場の根を決める。`ST_PREVIEW_ROOT` があればそれ(絶対パスに直す)、無ければ既定。
 * **環境変数を読むのは起動する側だけ**(MCP の `index.ts` / HTTP の設定 / Web サーバ)。
 */
export function resolvePreviewRoot(
  dataRoot: string,
  env: Record<string, string | undefined>,
): string {
  const declared = env.ST_PREVIEW_ROOT?.trim() ?? "";
  return declared === "" ? defaultPreviewRoot(dataRoot) : resolve(declared);
}

/** 識別子を1つ作る。**暗号的乱数 128ビット、16進32桁。**推測できないことが唯一の鍵である。 */
export function newPreviewId(): string {
  return randomBytes(16).toString("hex");
}

/** 識別子 → URL 上のアプリID(`pv-<識別子>`)。 */
export function previewAppId(previewId: string): string {
  return `${PREVIEW_APP_ID_PREFIX}${previewId}`;
}

/** URL 上のアプリID → 識別子。**形が違えば `null`**(下見として読まない)。 */
export function parsePreviewAppId(appId: string): string | null {
  const matched = PREVIEW_APP_ID_PATTERN.exec(appId);
  return matched?.[1] ?? null;
}

function isPreviewId(id: string): boolean {
  return PREVIEW_ID_PATTERN.test(id);
}

/** 根を用意する。**作ったときだけ** `0700` に絞る(既に在る根の権限は変えない)。 */
function ensureRoot(root: string): void {
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
  }
}

/** 根の下の置き場(識別子の綴りのディレクトリ)の一覧。根が無ければ空。**束も含む**(掃除が使う)。 */
function listEntryIds(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isPreviewId(entry.name))
    .map((entry) => entry.name);
}

/**
 * **上限20の数え方**(`V20-M14-T01A` / 計画 §10-2): 写しを持つ下見の置き場だけ(束 = `group.json` を
 * 持つ置き場を数えない)。 予約したばかりで `meta.json` の無い置き場は今日どおり数える。
 */
function listPreviewEntryIds(root: string): string[] {
  return listEntryIds(root).filter((id) => !isGroupEntry(root, id));
}

/** 識別子の置き場が見比べの束か(`group.json` を持つか)。**綴りが違えば `false`。** */
export function isGroupEntry(root: string, id: string): boolean {
  return isPreviewId(id) && existsSync(join(root, id, PREVIEW_GROUP_FILE));
}

function isPreviewMode(value: unknown): value is PreviewMode {
  return value === "real" || value === "sample";
}

/** `meta.json` を読む。**無い・壊れている・形が違う → `null`。** */
function readMeta(root: string, id: string): PreviewMeta | null {
  const path = join(root, id, PREVIEW_META_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const m = parsed as Record<string, unknown>;
  const strings = [
    "preview_id",
    "app_id",
    "requester_user_id",
    "created_at",
    "expires_at",
    "shadow_data_root",
    "session_id",
  ];
  for (const key of strings) {
    if (typeof m[key] !== "string") {
      return null;
    }
  }
  if (!isPreviewMode(m.mode) || m.preview_id !== id) {
    return null;
  }
  if (Number.isNaN(Date.parse(m.expires_at as string))) {
    return null;
  }
  return m as unknown as PreviewMeta;
}

function isExpired(meta: { expires_at: string }, now: Date): boolean {
  return Date.parse(meta.expires_at) <= now.getTime();
}

/**
 * 期限切れの置き場を全部消す。消した識別子を返す。
 *
 * 消すもの: 期限切れの meta / 壊れた meta / **期限を過ぎても meta の無い置き場**
 * (作る途中で落ちた残骸。**作ったばかりの meta 無しは、作っている途中かもしれないので残す**)。
 * **どれも目印({@link PREVIEW_ENTRY_MARKER_FILE})の在る置き場に限る**(`V20-M13` 点検の処置 中1。
 * 目印の無いディレクトリは、16進32桁の名前でも中身を問わず消さない)。
 */
export function purgeExpiredPreviews(root: string, now: PreviewClock = systemClock): string[] {
  const at = now();
  const removed: string[] = [];
  for (const id of listEntryIds(root)) {
    if (isStaleEntry(root, id, at)) {
      rmSync(join(root, id), { recursive: true, force: true });
      removed.push(id);
    }
  }
  purgeStaleGroupStagings(root, at);
  return removed;
}

const GROUP_STAGING_PATTERN = /^\.tmp-[0-9a-f]{32}$/;

/**
 * **束を組み立てる一時のディレクトリの残骸を消す**(`V20-M14` 点検の処置 軽5)。 {@link createGroup} は
 * `<根>/.tmp-<識別子>` で組み立ててから `rename` するので、その間に落ちると残る。 **消すのは、名前が
 * `.tmp-<16進32桁>` の形で、目印({@link PREVIEW_ENTRY_MARKER_FILE})が在り、mtime から期限
 * ({@link PREVIEW_TTL_SECONDS})を過ぎたものだけ**(目印の無いもの・作ったばかりのものは消さない)。
 * 消したものは返り値の一覧に載せない(下見でも束でもないため)。
 */
function purgeStaleGroupStagings(root: string, at: Date): void {
  if (!existsSync(root)) {
    return;
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !GROUP_STAGING_PATTERN.test(entry.name)) {
      continue;
    }
    const dir = join(root, entry.name);
    if (!existsSync(join(dir, PREVIEW_ENTRY_MARKER_FILE))) {
      continue;
    }
    let bornMs: number;
    try {
      bornMs = statSync(dir).mtimeMs;
    } catch {
      continue;
    }
    if (bornMs + PREVIEW_TTL_SECONDS * 1000 <= at.getTime()) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/**
 * 置き場1つが消してよい残骸か(期限切れの meta / 壊れた meta / 期限を過ぎても meta の無い置き場)。
 * **作ったばかりの meta 無しは、作っている途中かもしれないので残す**({@link purgeExpiredPreviews} と同じ判定)。
 */
function isStaleEntry(root: string, id: string, at: Date): boolean {
  const dir = join(root, id);
  // **【`V20-M13` 点検の処置 中1】目印の無い置き場は、中身を問わず消さない**(下見が作ったものと
  // 言えない)。 予約が目印を書くので、下見が作った置き場には必ず在る。
  if (!existsSync(join(dir, PREVIEW_ENTRY_MARKER_FILE))) {
    return false;
  }
  // **【`V20-M14-T01A`】束は `group.json` の `expires_at` で決める**(mtime を使わない)。 壊れていれば消す。
  if (existsSync(join(dir, PREVIEW_GROUP_FILE))) {
    const group = readGroup(root, id);
    return group === null || isExpired(group, at);
  }
  const metaExists = existsSync(join(dir, PREVIEW_META_FILE));
  const meta = metaExists ? readMeta(root, id) : null;
  if (meta !== null) {
    return isExpired(meta, at);
  }
  if (metaExists) {
    return true; // 壊れた meta
  }
  let bornMs: number;
  try {
    bornMs = statSync(dir).mtimeMs;
  } catch {
    return false; // 置き場が無い
  }
  return bornMs + PREVIEW_TTL_SECONDS * 1000 <= at.getTime();
}

/**
 * **当たった識別子1つだけ**、残骸なら消す(`V20-M13-T02b`。前段が要求を受けたとき。計画 §9-7 の (2))。
 * 消したら `true`。**綴りの違う識別子・置き場の無い識別子では何もしない。**
 */
export function purgePreviewIfStale(
  root: string,
  id: string,
  now: PreviewClock = systemClock,
): boolean {
  if (!isPreviewId(id) || !isStaleEntry(root, id, now())) {
    return false;
  }
  rmSync(join(root, id), { recursive: true, force: true });
  return true;
}

/** 個数の上限で断るときの理由(数える前と数え直した後で同じ文言)。 */
const TOO_MANY_REASON =
  `下見は同時に ${String(PREVIEW_MAX_ENTRIES)} 個までです。` +
  "今ある下見は期限(作ってから1時間)まで消さないので、期限が来てから作り直してください。";

/** 予約の結果。断るときは理由を返す(黙って作らない)。 */
export type ReservePreviewResult =
  | { ok: true; id: string; dir: string }
  | { ok: false; reason: string };

/**
 * 下見の置き場を1つ予約する(`<根>/<識別子>/` を `0700` で作る)。
 *
 * **順序**: 大きさの上限 → 期限切れを全部消す → 個数の上限 → 作る。
 * **断ったときは置き場を1つも作らない。**
 */
export function reservePreview(input: {
  root: string;
  dataRoot: string;
  appId: string;
  now?: PreviewClock;
  /**
   * **検査用の差し込み口**(`V20-M13` 点検の処置 軽8)。 個数を数えた直後・置き場を作る前に呼ぶ。
   * 別のプロセスが同じ根に作る競合を検査で再現するためだけに在る(本番の呼び出しは渡さない)。
   */
  afterCount?: () => void;
}): ReservePreviewResult {
  const now = input.now ?? systemClock;
  const dbPath = appDbPath(input.dataRoot, input.appId);
  let size: number;
  try {
    size = statSync(dbPath).size;
  } catch {
    return { ok: false, reason: `アプリ "${input.appId}" のデータベースが見つかりません。` };
  }
  if (size > PREVIEW_MAX_APP_DB_BYTES) {
    return {
      ok: false,
      reason:
        `このアプリのデータは ${String(Math.ceil(size / 1024 / 1024))}MB あり、` +
        `下見を作れる大きさ(100MB まで)を超えているため、下見を作りませんでした。`,
    };
  }

  purgeExpiredPreviews(input.root, now);
  if (listPreviewEntryIds(input.root).length >= PREVIEW_MAX_ENTRIES) {
    return { ok: false, reason: TOO_MANY_REASON };
  }
  input.afterCount?.();

  ensureRoot(input.root);
  const id = newPreviewId();
  const dir = join(input.root, id);
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  // 中1: 下見が作った置き場の目印(掃除はこれの在る置き場だけを消す)。
  writeFileSync(join(dir, PREVIEW_ENTRY_MARKER_FILE), "", { mode: 0o600 });

  // **【`V20-M13` 点検の処置 軽8】数え直す。** 数える・作るの間に錠が無いので、stdio と HTTP の
  // MCP が同じ根に同時に作ると上限を超えうる。 作った後に数え直し、超えていたら**自分の置き場を
  // 消して断る**(楽観的な取り消し)。 同時に作った2つが両方とも取り消すことはある(閉じる側)。
  if (listPreviewEntryIds(input.root).length > PREVIEW_MAX_ENTRIES) {
    rmSync(dir, { recursive: true, force: true });
    return { ok: false, reason: TOO_MANY_REASON };
  }
  return { ok: true, id, dir };
}

/**
 * 予約した置き場に `meta.json` を書いて登録を終える。**これを書くまで下見は引けない。**
 * 書き込みは一時ファイルからの `rename`(途中で落ちても壊れた meta を残さない)。
 */
export function commitPreview(
  root: string,
  id: string,
  input: {
    app_id: string;
    requester_user_id: string;
    mode: PreviewMode;
    shadow_data_root: string;
    session_id: string;
    now?: PreviewClock;
  },
): PreviewMeta {
  if (!isPreviewId(id)) {
    throw new Error(`下見の識別子の綴りが違います: ${id}`);
  }
  const created = (input.now ?? systemClock)();
  const meta: PreviewMeta = {
    preview_id: id,
    app_id: input.app_id,
    requester_user_id: input.requester_user_id,
    mode: input.mode,
    created_at: created.toISOString(),
    expires_at: new Date(created.getTime() + PREVIEW_TTL_SECONDS * 1000).toISOString(),
    shadow_data_root: resolve(input.shadow_data_root),
    session_id: input.session_id,
  };
  const path = join(root, id, PREVIEW_META_FILE);
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(meta, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
  return meta;
}

/** 識別子から引く。**無い・期限切れ・壊れている・綴りが違う → `null`。** */
export function findPreview(
  root: string,
  id: string,
  now: PreviewClock = systemClock,
): PreviewMeta | null {
  if (!isPreviewId(id)) {
    return null;
  }
  const meta = readMeta(root, id);
  if (meta === null || isExpired(meta, now())) {
    return null;
  }
  return meta;
}

/** 1つ消す(置き場ごと)。**綴りの違う識別子では何もしない**(根の外を消さない)。 */
export function removePreview(root: string, id: string): void {
  if (!isPreviewId(id)) {
    return;
  }
  rmSync(join(root, id), { recursive: true, force: true });
}

/** 予約を取り消す(登録の途中で失敗したとき)。{@link removePreview} と同じ。 */
export function discardPreview(root: string, id: string): void {
  removePreview(root, id);
}

// ===========================================================================
// **見比べの束と案**(`V20-M14-T01A`。計画 `16-v20-m14-plan.md` §9-1・§10-2 / `ADR-0478` §Decision 1-3・1-6)
// ===========================================================================

/**
 * JSON を一時ファイルから `rename` で 0600 に書く(途中で落ちても壊れた票を残さない)。
 *
 * **【`V20-M14` 点検の処置 中1】一時ファイルの名前は書き手ごとに一意にする**
 * (`<path>.<pid>.<16進8桁>.tmp`)。 名前が `<path>.tmp` の固定だと、同じ束へ同時に書く2つのプロセス
 * (stdio と HTTP の MCP)が同じ一時ファイルを奪い合い、負けた側の `chmod` / `rename` が `ENOENT` で投げていた。
 * 書き込みに失敗したら自分の一時ファイルを消す。
 */
function writeJsonAtomically(path: string, value: unknown): void {
  const temp = `${path}.${String(process.pid)}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** `group.json` を読む。**無い・壊れている・形が違う → `null`**(期限は見ない)。 */
function readGroup(root: string, id: string): PreviewGroup | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(root, id, PREVIEW_GROUP_FILE), "utf-8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const g = parsed as Record<string, unknown>;
  for (const key of ["group_id", "app_id", "requester_user_id", "created_at", "expires_at"]) {
    if (typeof g[key] !== "string") {
      return null;
    }
  }
  if (!isPreviewMode(g.mode) || g.group_id !== id) {
    return null;
  }
  if (Number.isNaN(Date.parse(g.expires_at as string))) {
    return null;
  }
  if (
    !Array.isArray(g.candidates) ||
    !g.candidates.every((c) => typeof c === "string" && isPreviewId(c))
  ) {
    return null;
  }
  return g as unknown as PreviewGroup;
}

/**
 * 束を1つ作る(`<根>/<束の識別子>/` に目印と `group.json`)。 **一時の名前(`.tmp-<識別子>`。16進32桁の
 * 綴りでないので数えも掃除もされない)で組み立ててから `rename` する** —— 組み立て途中の置き場が
 * 下見として上限に数えられることも、目印だけで消されることもない。 既に在れば投げる。
 * **【`V20-M14` 点検の処置 軽5】途中で落ちて残った `.tmp-<識別子>` は、目印つきで期限を過ぎたものだけ
 * 掃除が消す**({@link purgeExpiredPreviews})。
 */
export function createGroup(
  root: string,
  id: string,
  input: Omit<PreviewGroup, "group_id">,
): PreviewGroup {
  if (!isPreviewId(id)) {
    throw new Error(`束の識別子の綴りが違います: ${id}`);
  }
  ensureRoot(root);
  const group: PreviewGroup = { group_id: id, ...input, candidates: [...input.candidates] };
  const staging = join(root, `.tmp-${id}`);
  mkdirSync(staging, { mode: 0o700 });
  try {
    chmodSync(staging, 0o700);
    writeFileSync(join(staging, PREVIEW_ENTRY_MARKER_FILE), "", { mode: 0o600 });
    writeJsonAtomically(join(staging, PREVIEW_GROUP_FILE), group);
    if (existsSync(join(root, id))) {
      throw new Error(`束の識別子が既に在ります: ${id}`);
    }
    renameSync(staging, join(root, id));
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return group;
}

/** 束を引く。**無い・期限切れ・壊れている・綴りが違う → `null`。** */
export function findGroup(
  root: string,
  id: string,
  now: PreviewClock = systemClock,
): PreviewGroup | null {
  if (!isPreviewId(id)) {
    return null;
  }
  const group = readGroup(root, id);
  if (group === null || isExpired(group, now())) {
    return null;
  }
  return group;
}

/**
 * 束の末尾に案を1つ足す(一時ファイルから `rename`)。 足した後の束を返す。 **束が無い・期限切れ・壊れて
 * いれば `null`**(足さない)。 **この関数は錠を取らない** —— 呼ぶ側が {@link withGroupLock} の中で呼び、
 * 読み直して自分が並んでいるか(と何番目か)を確かめる(`V20-M14` 点検の処置 中1。錠の外で呼ぶと同時に
 * 足した2つのどちらかが消えうる)。
 */
export function appendCandidateToGroup(
  root: string,
  groupId: string,
  candidateId: string,
  now: PreviewClock = systemClock,
): PreviewGroup | null {
  const group = findGroup(root, groupId, now);
  if (group === null || !isPreviewId(candidateId)) {
    return null;
  }
  const next: PreviewGroup = { ...group, candidates: [...group.candidates, candidateId] };
  writeJsonAtomically(join(root, groupId, PREVIEW_GROUP_FILE), next);
  return next;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * **束の錠を取って `fn` を呼び、錠を離す**(`V20-M14` 点検の処置 中1)。 錠は束の置き場の中の
 * {@link PREVIEW_GROUP_LOCK_FILE} を排他で作ること(`open(…, "wx")`)で取る —— 別のプロセス(stdio と HTTP の
 * MCP)が同じ束へ同時に足しても、`group.json` の読み書きが重ならない。 取れなければ少し待って取り直し、
 * {@link PREVIEW_GROUP_LOCK_WAIT_MS} を過ぎたら投げる。 {@link PREVIEW_GROUP_LOCK_STALE_MS} より古い錠は外す。
 * **束の置き場が無ければ投げる**(錠のファイルを作れない)。 ハンドラは同期なので、待つ間はスレッドを止める。
 */
export function withGroupLock<T>(root: string, groupId: string, fn: () => T): T {
  if (!isPreviewId(groupId)) {
    throw new Error(`束の識別子の綴りが違います: ${groupId}`);
  }
  const lockPath = join(root, groupId, PREVIEW_GROUP_LOCK_FILE);
  const deadline = Date.now() + PREVIEW_GROUP_LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lockPath, "wx", 0o600));
      break;
    } catch (error) {
      if ((error as { code?: unknown }).code !== "EEXIST") {
        throw error;
      }
    }
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > PREVIEW_GROUP_LOCK_STALE_MS) {
        rmSync(lockPath, { force: true });
        continue;
      }
    } catch {
      continue; // 見ている間に離された
    }
    if (Date.now() > deadline) {
      throw new Error("見比べの束が混み合っています");
    }
    sleepSync(1 + Math.floor(Math.random() * 4));
  }
  try {
    return fn();
  } finally {
    rmSync(lockPath, { force: true });
  }
}

/** 束から案を1つ取り除く(数え直しで上限を超えたときの後始末)。 束が読めなければ何もしない。 */
export function removeCandidateFromGroup(root: string, groupId: string, candidateId: string): void {
  if (!isPreviewId(groupId)) {
    return;
  }
  const group = readGroup(root, groupId);
  if (group === null || !group.candidates.includes(candidateId)) {
    return;
  }
  writeJsonAtomically(join(root, groupId, PREVIEW_GROUP_FILE), {
    ...group,
    candidates: group.candidates.filter((c) => c !== candidateId),
  });
}

/** 案の票 `candidate.json` を下見の置き場に書く(0600。一時ファイルから `rename`)。 */
export function writeCandidate(root: string, previewId: string, candidate: PreviewCandidate): void {
  if (!isPreviewId(previewId)) {
    throw new Error(`下見の識別子の綴りが違います: ${previewId}`);
  }
  writeJsonAtomically(join(root, previewId, PREVIEW_CANDIDATE_FILE), candidate);
}

/** 案の票を読む。**無い・壊れている・形が違う → `null`。** */
export function readCandidate(root: string, previewId: string): PreviewCandidate | null {
  if (!isPreviewId(previewId)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(root, previewId, PREVIEW_CANDIDATE_FILE), "utf-8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const c = parsed as Record<string, unknown>;
  for (const key of ["name", "tradeoff", "base_manifest_sha", "group"]) {
    if (typeof c[key] !== "string") {
      return null;
    }
  }
  if (!Array.isArray(c.design_notices) || !("diff" in c)) {
    return null;
  }
  // 【`V20-M15-T01B`】`off_pattern` の無い古い票は `false` と読む(票を断らない)。
  return { ...(c as unknown as PreviewCandidate), off_pattern: c.off_pattern === true };
}

/**
 * **本物のアプリの `manifest.json` の生バイトの sha256(16進64桁)**(`V20-M14-T01A` / `ADR-0478` §Decision 1-6)。
 * **作る側(案の `base_manifest_sha`)と前段(`/compare` の `stale`)の両方がこの1本を呼ぶ。**
 * アプリが無い(読めない)→ `null`(呼ぶ側は古いとみなす)。
 *
 * **場所は `appDbPath` の隣の `manifest.json`** —— カーネルの `appManifestPath` と同じ場所
 * (`src/kernel/storage-paths.ts`: どちらも `appDir(dataRoot, appId)` の直下)。 **カーネルから値を
 * 1つも増やさないためにこう書いた**(`scripts/kernel-import-snapshot.txt` を動かさない)。 両者が
 * 同じ場所を指すことは `src/mcp/tools/dry-run-compare.test.ts` が本物のアプリの `manifest.json` で撃つ。
 */
export function manifestSha256(dataRoot: string, appId: string): string | null {
  const path = join(dirname(appDbPath(dataRoot, appId)), "manifest.json");
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    return null;
  }
  return createHash("sha256").update(bytes).digest("hex");
}
