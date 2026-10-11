/**
 * **下見の前段**(`V20-M13-T02b`。計画 `docs/plan/v20/15-v20-m13-plan.md` §9-1・§9-4・§10-2・§10-4 /
 * `ADR-0476` §Decision 1 / `ADR-0465` 限定1「足す口は1本ちょうど」)。
 *
 * `dry_run_diff` に `preview` を付けて作った下見の URL は `<origin>/apps/pv-<16進32桁>/` である。
 * 画面(SPA の `index.html`)は今日の配り方で出る。**画面が叩く API `/api/apps/pv-<16進32桁>/*` を、
 * この前段1本が受ける。**
 *
 * ## 受ける条件(**両方**)
 *
 * 1. アプリID の綴りが `^pv-[0-9a-f]{32}$`(`parsePreviewAppId`)。
 * 2. **本体に同じ綴りのアプリが実在しない**(`dataRoot/apps/<その綴り>` が無い)。
 *    **実在すれば `next()` で今日の口へ渡す**(本物のアプリの振る舞いは1バイトも変えない)。
 *
 * ## 動き(順序どおり)
 *
 * 1. **要求のたびに置き場の `meta.json` を引く。** 無い・期限切れ・壊れている → メモリの2本目を捨て、
 *    残骸なら置き場を消して **410**「この下見は期限切れです」。
 * 2. **`GET` / `HEAD` 以外は 403**「下見なので保存されません」(`ADR-0003` §3 の形。`D-V20-46`)。
 *    **写しの2本目には1バイトも渡さない** —— オリジンにも認証にも依存しない1か所で「見るだけ」を固定する
 *    (T00 §3-2 の結論4)。
 * 3. **`GET` / `HEAD` でも、描画に要る読み物の許可リスト({@link PREVIEW_READ_ALLOWLIST})の外は 403**
 *    「下見では開けません」(`ADR-0476` 2-1。利用者一覧・操作の記録・接続・AI 能力・コメント・変更履歴・
 *    巻き戻しの下見・要件定義書・取り残された行・付与の出どころは外)。 **行の2形の `:table_id` が
 *    システムの表か `_` 始まりなら許可リストの外**(`V20-M13` 点検の処置 重1)。
 * 4. 許可リスト内は、**写しを `dataRoot` にした2本目の `createServerApp`**(識別子ごとにメモリに1本。
 *    `profile` は同じ。2本目には前段を載せない)へ、**パスのアプリID を本物に書き換え**、**届いた
 *    `Cookie` を必ず上書きして**頼んだ人のセッション(`meta.session_id`。クッキー名 `st_session`)を
 *    付けて渡す(`ADR-0476` §Decision 1 の 2。**ブラウザのクッキーは写しに届かない**)。
 * 5. 応答は {@link toPreviewResponse} で整える: `Set-Cookie` を落とし、`Referrer-Policy: no-referrer`・
 *    `Cache-Control: no-store`・下見の頭 {@link PREVIEW_HEADER}(`mode=<real|sample>; expires_at=<ISO>`)を
 *    付ける。**画面の帯(`T02c`)はこの頭を読む。** **新しい HTTP の口は足さない。**
 *
 * ## 見比べの束(`V20-M14-T01B`。計画 `16-v20-m14-plan.md` §9-2・§10-2 / `ADR-0478` §Decision 1-4〜1-7)
 *
 * **分岐の順**: 綴り → **束の登録か**(置き場に `group.json` が在る)→ 案の識別子への `/compare` は 404 →
 * 上の 1〜5。
 *
 * - **束**: `GET` / `HEAD` の {@link PREVIEW_COMPARE_PATH} にだけ、**写しへ渡さずに前段が自分で答える**
 *   (応答のキーは `ADR-0478` §Decision 1-5 の全量ちょうど。{@link compareResponse})。 束への他の `GET` / `HEAD`
 *   は 403「見比べの画面では開けません」、`GET` / `HEAD` 以外は上の 2 と同じ 403、期限切れ・壊れた登録は 410。
 *   **束の応答には下見の頭 {@link PREVIEW_HEADER} を付けない**(付けると画面の api 層が「保存されません」の帯を
 *   出す。見比べの画面は自分の帯を出す。`D-V20-51`)。
 * - **案の識別子(1案の下見)への `/compare` は 404**(`ADR-0003` §3 の形)。 画面はこれを見て1案の下見を描く。
 *   **登録の無い識別子への `/compare` は今日どおり 410**(不在)。
 * - **`/compare` は許可リスト({@link PREVIEW_READ_ALLOWLIST}。写しへ渡す8本)に入れない。** 前段が自分で
 *   答える読み物は {@link PREVIEW_FRONT_OWN_READS} の1本だけ(`ADR-0478` 2-1 の歯止め)。
 *
 * **`profile === "full"` のときだけ登録する**(`app.ts`)。**配る版(`runner`)には1本も登録しない**
 * (`ADR-0419` 限定3。配る版に MCP は無く、下見は作られない)。
 *
 * ## 取りこぼしは閉じる側に倒れる
 *
 * 書き換え漏れの要求は、存在しないアプリID(`pv-…`)として本体に当たるだけで、本体のデータに届かない
 * (T00 §4-1)。**許可リストに無い読み物は、写しの2本目に渡す前に断る**(2本目を作りもしない)。
 */

import type { Context, Hono, Next } from "hono";
import { isSystemTableId } from "../shared/system-tables.ts";
import type { AuthEnv } from "./auth-context.ts";
import {
  findGroup,
  findPreview,
  isGroupEntry,
  type PreviewClock,
  type PreviewGroup,
  type PreviewMeta,
  parsePreviewAppId,
  previewAppId,
  purgePreviewIfStale,
  readCandidate,
} from "./preview-store.ts";

/** 下見であること・モード・期限を載せる応答の頭の名前。**画面の帯(`T02c`)が読む。** */
export const PREVIEW_HEADER = "X-Smailtalk-Preview";

/** `GET` / `HEAD` 以外を断るときの文言(`D-V20-46` / 計画 §10-4)。 */
export const PREVIEW_READ_ONLY_MESSAGE = "下見なので保存されません";

/** 許可リスト外の `GET` を断るときの文言(`V20-M13-T02b` が決めた。記録 §2)。 */
export const PREVIEW_NOT_READABLE_MESSAGE = "下見では開けません";

/**
 * **頼んだ人のログイン名の代わりに見せる文言**(`V20-M13` 点検の処置 軽2)。 前段は `/auth/me` の応答の
 * `username` と `displayName` をこの文言に置き換える(ログイン名はパスワードと組になる資格情報の片方で、
 * URL を持つ人に渡さない)。 役割(`role` / `roles`)と `id` は画面の出し分けに要るので残す。
 */
export const PREVIEW_REQUESTER_LABEL = "下見";

/**
 * **前段が写しへ渡さずに自分で答える読み物**(`V20-M14-T01B` / `ADR-0478` §Decision 1-4)。 束の識別子への
 * `GET` / `HEAD` だけ。 **許可リスト({@link PREVIEW_READ_ALLOWLIST})とは別の定数**(許可リストは8本のまま)。
 */
export const PREVIEW_COMPARE_PATH = "/compare";

/** 前段が自分で答える読み物の全量(**1本ちょうど。超えない**。`ADR-0478` 2-1 の歯止め)。 */
export const PREVIEW_FRONT_OWN_READS: readonly string[] = [PREVIEW_COMPARE_PATH];

/** 束の識別子への `/compare` 以外の読み物を断る文言(`ADR-0478` §Decision 1-4)。 */
export const COMPARE_NOT_READABLE_MESSAGE = "見比べの画面では開けません";

/** 案の識別子(1案の下見)への `/compare` の 404 の文言(`V20-M14-T01B` が決めた)。 */
export const COMPARE_NOT_FOUND_MESSAGE = "この下見は見比べの束ではありません";

/** 期限切れ・不明な識別子の文言(`D-V20-43` / 計画 §10-4)。 */
export const PREVIEW_EXPIRED_MESSAGE = "この下見は期限切れです";

const READ_ONLY_HINT =
  "下見は差分を当てた後の画面を見せるだけで、本体にも写しにも書き込みません。" +
  "変更を本当に当てるには、MCP の apply_diff で適用してください。";
const NOT_READABLE_HINT =
  "下見で開けるのは画面の描画に要る読み物(定義・行・集計表・ファイル・見た目・自分の情報)だけです。" +
  "利用者の一覧・操作の記録・変更履歴・コメント・接続などは、本物のアプリにログインして開いてください。";
const EXPIRED_HINT =
  "下見は作ってから1時間で消えます(識別子が違っても同じ答えです)。" +
  "もう一度見るには、dry_run_diff に preview を付けて下見を作り直してください。" +
  // **【`V20-M13` 点検の処置 軽4】** 直前の2文は1バイトも変えていない。 作った側(MCP)と開く側
  // (Web サーバ)で置き場の根が食い違うと、作った直後でもここに来る。
  "作った直後なのにこの答えになるときは、下見を作った側(MCP)と開く側(Web サーバ)で置き場" +
  "(ST_PREVIEW_ROOT)が違うと期限切れに見えます。両方の起動時の印字「下見の置き場」が同じかを確かめてください。";

const COMPARE_NOT_READABLE_HINT =
  "見比べの束の URL で開けるのは、案の一覧(/compare)だけです。" +
  "各案の画面は、一覧の各案の URL(/apps/pv-<案>/)で開いてください。";
const COMPARE_NOT_FOUND_HINT =
  "この URL は1案の下見です(見比べの束ではありません)。" +
  "束で見比べるには、dry_run_diff の compare が返した束の URL(compare.url)を開いてください。";

/** 頼んだ人のセッションを載せるクッキーの名前(`src/server/auth-routes.ts` の `SESSION_COOKIE`)。 */
const SESSION_COOKIE = "st_session";

/**
 * **描画に要る読み物の許可リスト(8本)。** `web/src` が実際に叩く `GET` を数えて確定した
 * (記録 `docs/plan/v20/records/v20-m13-t02b.md` §2 の表)。**`ADR-0476` 2-1 の「超えない」の上限は
 * この本数である** —— 広げる葉は本 ADR を根拠にできず、変更 ADR か門A を通す(同 §限界 4)。
 *
 * `pattern` は `/api/apps/:app_id` より後ろ。`:name` は `/` を含まない1区切り。
 */
export const PREVIEW_READ_ALLOWLIST: readonly { pattern: string; why: string }[] = [
  { pattern: "/manifest", why: "画面の定義(web/src/api.ts fetchManifest)" },
  { pattern: "/public", why: "未ログインのときの入口の名前(web/src/api.ts fetchPublicAppInfo)" },
  { pattern: "/auth/me", why: "自分の情報(web/src/api.ts の authMe。useAppAuth が最初に1回叩く)" },
  { pattern: "/tables/:table_id/records", why: "行の一覧(一覧・参照の選択肢)" },
  { pattern: "/tables/:table_id/records/:record_id", why: "1行(詳細・編集フォームの初期値)" },
  { pattern: "/views/:view_id/report", why: "集計表(web/src/api.ts fetchReport)" },
  { pattern: "/views/:view_id/custom.css", why: "逃げ道の CSS(web/src/views/ViewHost.tsx)" },
  { pattern: "/files/:file_id", why: "画像・添付の配信(web/src/fields/display.tsx)" },
];

const ALLOWLIST_MATCHERS: readonly RegExp[] = PREVIEW_READ_ALLOWLIST.map(
  (entry) =>
    new RegExp(
      `^${entry.pattern
        .split("/")
        .map((part) =>
          part.startsWith(":") ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        )
        .join("/")}$`,
    ),
);

/**
 * 行の一覧と1行の2形(`/tables/:table_id/records` と `/:record_id`)の `:table_id` を取り出す。
 * **`%5F` などの符号化を解いてから返す**(写しの2本目は解いた綴りで表を引く)。 解けなければ `null`。
 */
const RECORDS_TABLE_ID = /^\/tables\/([^/]+)\/records(?:\/[^/]+)?$/;

function recordsTableIdOf(rest: string): string | null {
  const matched = RECORDS_TABLE_ID.exec(rest);
  if (matched === null) return null;
  try {
    return decodeURIComponent(matched[1] as string);
  } catch {
    return "_"; // 解けない綴りは閉じる側(システムの表と同じく断る)に倒す。
  }
}

/**
 * `/api/apps/:app_id` より後ろのパスが許可リストに当たるか。
 *
 * **【`V20-M13` 点検の処置 重1】** 行の一覧と1行の2形は、`:table_id` が **システムの表**
 * (`isSystemTableId`。`_apps` / `_changelog` / `_ai_usage`)**か `_` で始まる綴り**なら当たらない
 * (403「下見では開けません」)。 頼んだ人が owner だと、写しの2本目は owner にだけ開くシステムの表を
 * 答え、変更履歴の意図の本文が URL を持つ人に渡っていた(`ADR-0476` §Decision 1 の 3 は変更履歴を
 * 許可リストの外と書く)。 利用者の定義できる表の綴りは `_` で始まれない(`src/shared/system-tables.ts`
 * 冒頭)ので、`_` 始まりを全部断っても作り手の表は1つも欠けない。
 */
function isAllowedRead(rest: string): boolean {
  if (!ALLOWLIST_MATCHERS.some((matcher) => matcher.test(rest))) {
    return false;
  }
  const tableId = recordsTableIdOf(rest);
  if (tableId !== null && (tableId.startsWith("_") || isSystemTableId(tableId))) {
    return false;
  }
  return true;
}

/**
 * **`/auth/me` の応答から頼んだ人のログイン名を外す**(`V20-M13` 点検の処置 軽2)。 `user.username` と
 * `user.displayName` を {@link PREVIEW_REQUESTER_LABEL} に置き換え、`id`・`role`・`roles` は残す
 * (画面の出し分けに要る)。 **JSON でない・`user` が無い応答は1バイトも変えない。**
 */
async function maskRequesterName(inner: Response): Promise<Response> {
  const text = await inner.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return new Response(text, {
      status: inner.status,
      statusText: inner.statusText,
      headers: inner.headers,
    });
  }
  const user = (body as { user?: unknown } | null)?.user;
  if (typeof user !== "object" || user === null) {
    return new Response(text, {
      status: inner.status,
      statusText: inner.statusText,
      headers: inner.headers,
    });
  }
  const masked = user as Record<string, unknown>;
  masked.username = PREVIEW_REQUESTER_LABEL;
  masked.displayName = PREVIEW_REQUESTER_LABEL;
  const headers = new Headers(inner.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(body), {
    status: inner.status,
    statusText: inner.statusText,
    headers,
  });
}

/** 写しに答える2本目。`fetch` だけを使う(`Hono` の `request` 互換)。 */
export type PreviewInnerApp = { fetch(request: Request): Response | Promise<Response> };

/** 識別子 → 写しの2本目(メモリに1本)。検査は外から渡して中身を見る。 */
export type PreviewFrontCache = Map<string, { app: PreviewInnerApp; shadowDataRoot: string }>;

export type PreviewFrontOptions = {
  /** 置き場の根(`ST_PREVIEW_ROOT` か `<dataRoot>.previews`)。 */
  root: string;
  /** 本体に同じ綴りのアプリが実在するか(実在すれば前段は受けない)。 */
  realAppExists: (appId: string) => boolean;
  /** 写しを `dataRoot` にした2本目を作る(`app.ts` の `createServerApp`。循環 import を避けて受け取る)。 */
  createInnerApp: (shadowDataRoot: string) => PreviewInnerApp;
  /**
   * **本物のアプリの `manifest.json` の生バイトの sha256**(`V20-M14-T01B`。`preview-store.ts` の
   * `manifestSha256` を `dataRoot` で包んだもの)。 `/compare` の `stale` の材料。 **省略時は常に `null`
   * (= 全案が古い。閉じる側)。**
   */
  manifestSha?: (appId: string) => string | null;
  /** 時計(検査で期限の前後を撃つ)。 */
  now?: PreviewClock;
  /** 2本目の置き場(検査で「捨てた」を見る)。 */
  cache?: PreviewFrontCache;
};

/** 前段自身が返す応答(断り・期限切れ)にも、転送した応答にも付ける頭。 */
function applyPreviewHeaders(headers: Headers, meta: PreviewMeta | null): void {
  headers.delete("set-cookie");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Cache-Control", "no-store");
  if (meta !== null) {
    headers.set(PREVIEW_HEADER, `mode=${meta.mode}; expires_at=${meta.expires_at}`);
  } else {
    headers.delete(PREVIEW_HEADER);
  }
}

/**
 * 写しの2本目が返した応答を、下見の応答に整える(`Set-Cookie` を落とし、頭を付ける)。
 * **本文は1バイトも変えない。**(`/auth/me` のログイン名の置き換えは、この手前の
 * {@link maskRequesterName} が行う。`V20-M13` 点検の処置 軽2)
 */
export function toPreviewResponse(inner: Response, meta: PreviewMeta): Response {
  const headers = new Headers(inner.headers);
  applyPreviewHeaders(headers, meta);
  return new Response(inner.body, {
    status: inner.status,
    statusText: inner.statusText,
    headers,
  });
}

function refusal(status: 403 | 404 | 410, message: string, hint: string, meta: PreviewMeta | null) {
  const headers = new Headers({ "content-type": "application/json; charset=UTF-8" });
  applyPreviewHeaders(headers, meta);
  return new Response(JSON.stringify({ errors: [{ path: "", message, hint }] }), {
    status,
    headers,
  });
}

/**
 * **`/compare` の応答**(`V20-M14-T01B` / `ADR-0478` §Decision 1-5〜1-7)。 **キーはトップ `compare` の1・中5・
 * 案8 の全量ちょうど**(足さない)。 **【`V20-M15-T01B` / `ADR-0479` §Decision 4-4】案は `off_pattern` を足して9キー
 * (これを超えない。トップ1・中5は動かさない)。 票に無ければ `false`(`readCandidate` が補う)。** 案は束の登録の順(作った順)。 **案の票・置き場が読めない案は並べない**
 * (その案の画面は開けないため)。 `stale` は本物の `manifest.json` の sha と作成時の sha の比較
 * (本物が無ければ `true`)。 頭は `Referrer-Policy` と `Cache-Control` の2本だけ(下見の頭は付けない)。
 */
function compareResponse(
  group: PreviewGroup,
  root: string,
  now: PreviewClock,
  manifestSha: (appId: string) => string | null,
  method: "GET" | "HEAD",
): Response {
  const current = manifestSha(group.app_id);
  const candidates = group.candidates.flatMap((id) => {
    const candidate = readCandidate(root, id);
    if (candidate === null || findPreview(root, id, now) === null) {
      return [];
    }
    const intent = (candidate.diff as { intent?: unknown } | null)?.intent;
    return [
      {
        id: previewAppId(id),
        url: `/apps/${previewAppId(id)}/`,
        name: candidate.name,
        tradeoff: candidate.tradeoff,
        intent: typeof intent === "string" ? intent : "",
        diff: candidate.diff,
        design_notices: candidate.design_notices,
        off_pattern: candidate.off_pattern,
        stale: current === null || current !== candidate.base_manifest_sha,
      },
    ];
  });
  const body = {
    compare: {
      group: previewAppId(group.group_id),
      app_id: group.app_id,
      mode: group.mode,
      expires_at: group.expires_at,
      candidates,
    },
  };
  const headers = new Headers({ "content-type": "application/json; charset=UTF-8" });
  applyPreviewHeaders(headers, null);
  return new Response(method === "HEAD" ? null : JSON.stringify(body), { status: 200, headers });
}

/**
 * 前段を1本登録する。**`app.ts` の `createServerApp` の先頭(既存の関門より前)で、
 * `profile === "full"` のときだけ呼ぶ。**
 */
export function registerPreviewFront(app: Hono<AuthEnv>, options: PreviewFrontOptions): void {
  const cache: PreviewFrontCache = options.cache ?? new Map();
  const now: PreviewClock = options.now ?? (() => new Date());
  const manifestSha = options.manifestSha ?? (() => null);

  app.all("/api/apps/:app_id/*", async (c: Context<AuthEnv>, next: Next) => {
    const urlAppId = c.req.param("app_id");
    const previewId = urlAppId === undefined ? null : parsePreviewAppId(urlAppId);
    if (urlAppId === undefined || previewId === null || options.realAppExists(urlAppId)) {
      await next();
      return;
    }

    const method = c.req.method.toUpperCase();
    const url = new URL(c.req.url);
    const prefix = `/api/apps/${urlAppId}`;
    const rest = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : "";

    // 0. **【`V20-M14-T01B`】束の登録か**(`group.json` が在る)。 束は写しを持たないので、2本目へは1本も渡さない。
    if (isGroupEntry(options.root, previewId)) {
      const group = findGroup(options.root, previewId, now);
      if (group === null) {
        purgePreviewIfStale(options.root, previewId, now);
        return refusal(410, PREVIEW_EXPIRED_MESSAGE, EXPIRED_HINT, null);
      }
      if (method !== "GET" && method !== "HEAD") {
        return refusal(403, PREVIEW_READ_ONLY_MESSAGE, READ_ONLY_HINT, null);
      }
      if (rest !== PREVIEW_COMPARE_PATH) {
        return refusal(403, COMPARE_NOT_READABLE_MESSAGE, COMPARE_NOT_READABLE_HINT, null);
      }
      return compareResponse(group, options.root, now, manifestSha, method);
    }

    // 1. 要求のたびに meta を引く。
    const meta = findPreview(options.root, previewId, now);
    if (meta === null) {
      cache.delete(previewId);
      purgePreviewIfStale(options.root, previewId, now);
      return refusal(410, PREVIEW_EXPIRED_MESSAGE, EXPIRED_HINT, null);
    }

    // 1b. **【`V20-M14-T01B`】案の識別子(1案の下見)への `/compare` は 404**(写しへ渡さない)。
    if ((method === "GET" || method === "HEAD") && rest === PREVIEW_COMPARE_PATH) {
      return refusal(404, COMPARE_NOT_FOUND_MESSAGE, COMPARE_NOT_FOUND_HINT, meta);
    }

    // 2. GET / HEAD 以外は断る(写しへ渡さない)。
    if (method !== "GET" && method !== "HEAD") {
      return refusal(403, PREVIEW_READ_ONLY_MESSAGE, READ_ONLY_HINT, meta);
    }

    // 3. 許可リストの外は断る。
    if (!isAllowedRead(rest)) {
      return refusal(403, PREVIEW_NOT_READABLE_MESSAGE, NOT_READABLE_HINT, meta);
    }

    // 4. 写しの2本目へ(アプリID を本物に書き換え、クッキーは頼んだ人のセッションだけ)。
    let entry = cache.get(previewId);
    if (entry === undefined || entry.shadowDataRoot !== meta.shadow_data_root) {
      entry = {
        app: options.createInnerApp(meta.shadow_data_root),
        shadowDataRoot: meta.shadow_data_root,
      };
      cache.set(previewId, entry);
    }
    const forwardedUrl = new URL(url.toString());
    forwardedUrl.pathname = `/api/apps/${encodeURIComponent(meta.app_id)}${rest}`;
    const headers = new Headers(c.req.raw.headers);
    headers.delete("cookie");
    headers.set("cookie", `${SESSION_COOKIE}=${meta.session_id}`);
    const fetched = await entry.app.fetch(new Request(forwardedUrl, { method, headers }));
    // 頼んだ人のログイン名は見る人に渡さない(`GET /auth/me` の本文だけ。`HEAD` は本文が無い)。
    const inner =
      method === "GET" && rest === "/auth/me" ? await maskRequesterName(fetched) : fetched;

    // 5. 応答を整える。
    return toPreviewResponse(inner, meta);
  });
}
