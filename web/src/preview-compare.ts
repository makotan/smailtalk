/**
 * **見比べの画面の状態と純粋な部品**(`V20-M14-T01C`。計画 `docs/plan/v20/16-v20-m14-plan.md` §9-3 / §10-3、
 * ユーザ決定 `D-V20-47`〜`D-V20-54`、変更 ADR `ADR-0478`)。
 *
 * - **下見の綴り(`pv-` + 16進32桁)の画面を開いたら、先に前段の `GET /api/apps/pv-<id>/compare` を1回引く**
 *   (`V20-M14-T01B`)。 200 なら見比べの画面、404(案の識別子 = 1案の下見)とそれ以外の失敗は今日どおり
 *   1案の下見、410 は期限切れ(`web/src/api.ts` の `apiFetch` が下見の状態へ知らせ、`PreviewGate` が出す)。
 * - 引いた結果はアプリID ごとにこのモジュールの中に1つ持つ(`useSyncExternalStore` で読む)。 **同じ頁の中で
 *   画面を移っても引き直さない**(iframe の中で1案の下見を操作しても `/compare` は1回だけ)。
 * - **案の名前・トレードオフ・変更の意図・注意は、前段の応答(AI が `dry_run_diff` の `compare` に書いたもの)を
 *   そのまま出す。 製品は文面を1つも持たない**(計画 §4 の 10)。
 * - **マニフェストにもサーバにも何も書かない。** 書くのは「この案にする」の OK の後の本物の `POST /diffs` 1本だけで、
 *   それは `ComparePage.tsx` が `web/src/api.ts` の `applyCandidateDiff` 越しに送る。
 *
 * **【V20-M15-T01C の追記。上の文を消していない】**(計画 `docs/plan/v20/17-v20-m15-plan.md` §9・§10-5 の中10、
 * 変更 ADR `ADR-0479` §Decision 4-5・4-6、決定 `D-V20-56`・`D-V20-57`・`D-V20-59`・`D-V20-64`)。
 * 送る本文は「案の差分の `operations` の末尾に、選んだ記録(`remember_design` の `choice` だけ)を1本足したもの」
 * になった({@link withDesignChoice})。 記録に入れる名前とトレードオフも前段の応答のまま(製品は文面を持たない)。
 * 案の変更の一覧は18種目 `remember_design`(型の変更)を「型を変える」で出す。
 */
import { useSyncExternalStore } from "react";
import { formatPreviewDeadline } from "./preview.ts";

/** 案に添えられた注意(`src/shared/design-notices.ts` の `DesignNotice` のうち画面が読むもの)。 */
export type CompareNotice = {
  rule?: string;
  view?: string;
  path?: string;
  count?: number;
  message: string;
};

/** 前段の `/compare` が返す案1つ(`ADR-0478` §Decision 1-5 のキーの全量)。 */
export type CompareCandidate = {
  id: string;
  url: string;
  name: string;
  tradeoff: string;
  intent: string;
  diff: unknown;
  design_notices: CompareNotice[];
  stale: boolean;
  /**
   * AI が「このアプリの型から外れる」と申告した案か(`V20-M15-T01B` で9キー目。`D-V20-59`)。
   * 古い応答に無いときは偽と読む(`off_pattern === true` だけを見る)。
   */
  off_pattern?: boolean;
};

/** 前段の `/compare` が返す束。 */
export type PreviewCompare = {
  group: string;
  app_id: string;
  mode: "real" | "sample";
  expires_at: string;
  candidates: CompareCandidate[];
};

/** 表示幅の選び方(`D-V20-39` の最終要望 3。モバイル 390px / デスクトップ 1280px の2つ)。 */
export const COMPARE_WIDTHS = Object.freeze([
  Object.freeze({ key: "mobile", label: "モバイル(390px)", px: 390 }),
  Object.freeze({ key: "desktop", label: "デスクトップ(1280px)", px: 1280 }),
] as const);

export type CompareWidthKey = (typeof COMPARE_WIDTHS)[number]["key"];

/** 既定の幅(モバイル)。 */
export const COMPARE_DEFAULT_WIDTH: CompareWidthKey = "mobile";

/** iframe の高さ(固定。中はスクロールする。計画 §10-3)。 */
export const COMPARE_FRAME_HEIGHT = 800;

/** これより小さく縮めるくらいなら段を折る(1段に並べる数を減らす)。 */
export const COMPARE_MIN_SCALE = 0.5;

/** 見比べの帯の本文(`D-V20-51` の逐語)。 */
export function compareBannerText(expiresAt: string): string {
  return `見比べ(適用前)。選んで確認するとアプリに反映されます。期限 ${formatPreviewDeadline(expiresAt)}`;
}

/** 型から外れた案の印(`D-V20-59`。`ADR-0479` §Decision 4-6)。 */
export const COMPARE_OFF_PATTERN_LABEL = "このアプリの型と違う";

/** 確認の小窓の理由の欄の上の固定文(`ADR-0479` §Decision 4-6 の逐語)。 */
export const COMPARE_CHOICE_NOTE =
  "この案の名前とトレードオフを、このアプリの選んだ記録に残します(最新20件まで)。";

/** 確認の小窓の理由の欄の下の注意書き(`D-V20-63` の逐語)。 */
export const COMPARE_REASON_NOTICE =
  "ここに書いた文は、このアプリにログインできる人なら誰でも読めます";

/** 古くなった案の文言(`D-V20-49` の逐語)。 */
export const COMPARE_STALE_MESSAGE = "案が古くなりました。AI に作り直してもらってください";

/**
 * **並べ方**。 並べられる幅 `available` に、幅 `frameWidth` の枠を `count` 個、間 `gap` で並べるときの
 * 1段の数と縮める比。
 *
 * - 全部を1段に並べて縮めずに収まるなら、そのまま(比 1)。
 * - 収まらないなら、1段の数を多い方から試し、縮める比が {@link COMPARE_MIN_SCALE} 以上になる最大の数を採る。
 *   どれも足りなければ1段に1つ(比は幅に合わせる)。
 * - 幅を測れない(0 以下)なら縮めない(1段に1つ・比 1)。
 *
 * **縮めるのは枠の外の `transform: scale` だけで、iframe の中の幅判定(Tailwind の `sm` / `lg`)は変わらない。**
 */
export function compareLayout(input: {
  available: number;
  gap: number;
  count: number;
  frameWidth: number;
}): { columns: number; scale: number } {
  const { available, gap, frameWidth } = input;
  const count = Math.max(1, input.count);
  if (!(available > 0) || !(frameWidth > 0)) {
    return { columns: 1, scale: 1 };
  }
  for (let columns = count; columns >= 1; columns -= 1) {
    const each = (available - gap * (columns - 1)) / columns;
    const scale = Math.min(1, each / frameWidth);
    if (scale >= COMPARE_MIN_SCALE || columns === 1) {
      return { columns, scale: columns === 1 ? Math.min(1, available / frameWidth) : scale };
    }
  }
  return { columns: 1, scale: 1 };
}

// --- アプリID ごとの「/compare を引いた結果」---------------------------------------------

export type CompareLookup =
  | { status: "unknown" }
  | { status: "loading" }
  | { status: "compare"; compare: PreviewCompare }
  | { status: "single" }
  | { status: "expired" };

const UNKNOWN: CompareLookup = Object.freeze({ status: "unknown" });
const lookups = new Map<string, CompareLookup>();
const listeners = new Set<() => void>();

function publish(appId: string, next: CompareLookup): void {
  lookups.set(appId, next);
  for (const listener of listeners) {
    listener();
  }
}

export function compareLookupOf(appId: string | undefined): CompareLookup {
  return appId === undefined ? UNKNOWN : (lookups.get(appId) ?? UNKNOWN);
}

/**
 * まだ引いていなければ1回だけ引く。 `load` は `/compare` を引いて結果を返す(`ComparePage.tsx` が
 * `web/src/api.ts` の `fetchPreviewCompare` を渡す)。
 */
export function ensureCompareLookup(
  appId: string,
  load: () => Promise<Exclude<CompareLookup, { status: "unknown" } | { status: "loading" }>>,
): void {
  if (lookups.has(appId)) {
    return;
  }
  publish(appId, { status: "loading" });
  load().then(
    (result) => {
      publish(appId, result);
    },
    () => {
      // 読めなかった(想定外の失敗)。 **今日どおり1案の下見として描く**(見比べを勝手に作らない)。
      publish(appId, { status: "single" });
    },
  );
}

/** OK の直後に引き直した束で置き換える(古くなった案のボタンを止めるため)。 */
export function noteCompare(appId: string, compare: PreviewCompare): void {
  publish(appId, { status: "compare", compare });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useCompareLookup(appId: string | undefined): CompareLookup {
  return useSyncExternalStore(
    subscribe,
    () => compareLookupOf(appId),
    () => compareLookupOf(appId),
  );
}

/** 検査のための初期化(製品は呼ばない)。 */
export function resetCompareLookups(): void {
  lookups.clear();
  for (const listener of listeners) {
    listener();
  }
}

// --- 適用の断りの読み分け -----------------------------------------------------------------

/** Origin の照合の断り(`src/server/app.ts` の `originRejectedError`)の `message` の頭。 */
const ORIGIN_REJECTED_PREFIX = "リクエスト元 ";

export type ApplyFailure =
  | { kind: "login" }
  | { kind: "origin" }
  | { kind: "forbidden" }
  | { kind: "errors" };

/**
 * 本物の `POST /diffs` の断りを読み分ける(計画 §10-3)。 401 → ログイン / 403 → 本文の `errors` が Origin の
 * 不一致(`message` が「リクエスト元 "…" は許可されていません。」で `allowed_values` を持つ)なら出どころ、
 * それ以外は権限 / 他(400・409 など)→ サーバのエラー一覧をそのまま出す。
 */
export function classifyApplyFailure(
  status: number,
  errors: readonly { message: string; allowed_values?: string[] | undefined }[],
): ApplyFailure {
  if (status === 401) {
    return { kind: "login" };
  }
  if (status === 403) {
    const origin = errors.some(
      (error) =>
        error.message.startsWith(ORIGIN_REJECTED_PREFIX) && Array.isArray(error.allowed_values),
    );
    return { kind: origin ? "origin" : "forbidden" };
  }
  return { kind: "errors" };
}

// --- 案の変更の一覧(`D-V20-55`。`V20-M14` 点検の処置 中3) ---------------------------------------

/**
 * 確認の小窓に出す、案の変更の1行。 `label` は op の種類の日本語の言い方、`target` は差分から取れる対象の名前
 * (表・項目・画面・自動処理・関数・役割。取れなければ空)、`flagged` は「要確認」の印を付けるか。
 */
export type CompareOperationLine = {
  op: string;
  label: string;
  target: string;
  flagged: boolean;
};

/**
 * **op の日本語の言い方**(`D-V20-55`)。 既存の画面と MCP の文面に op 名の日本語の対応表は無かったので、
 * これが1本目である(2本目を作らない)。 データが失われる4 op は見比べの束に入らない(`D-V20-52`)が、
 * 形の上では並べられるので言い方を持つ。
 *
 * **18種目 `remember_design` は「型を変える」**(`V20-M15-T01C`。`ADR-0479` §Decision 4-6)。 案の中に入れられる
 * のは型の書き換え(`patterns`)だけで、選んだ記録(`choice`)を含む案は作る時点で断られる(`D-V20-64`)。
 */
export const COMPARE_OPERATION_LABELS: Readonly<Record<string, string>> = {
  add_table: "表を足す",
  add_field: "項目を足す",
  add_view: "画面を足す",
  update_view: "画面を変える",
  remove_view: "画面を消す",
  remove_field: "項目を消す",
  remove_table: "表を消す",
  change_table: "表を変える",
  change_field: "項目を変える",
  add_workflow: "自動処理を足す",
  update_workflow: "自動処理を変える",
  remove_workflow: "自動処理を消す",
  add_function: "関数を足す",
  update_function: "関数を変える",
  remove_function: "関数を消す",
  set_theme: "配色を変える",
  set_roles: "権限の設定を変える",
  remember_design: "型を変える",
  // **【`V22-M2-T05`】19種目 `set_workspace`(メニューの置き方。`ADR-0486`)。** 着手前は「その他の変更(set_workspace)」と出た。
  set_workspace: "メニューの置き方を変える",
};

/**
 * **「要確認」の印を付ける op**(`D-V20-55`)。 役割と権限の設定・自動処理の変更は、並んだ下見の画面を見ても
 * 違いが分からないため。
 */
const COMPARE_FLAGGED_OPS: ReadonlySet<string> = new Set([
  "set_roles",
  "add_workflow",
  "update_workflow",
  "remove_workflow",
]);

/** 案の中の `remember_design` が型(`patterns`)を持つなら、その配列。 */
function patternsOf(operation: Record<string, unknown>): unknown[] | null {
  const patterns = asRecord(operation.design_memory)?.patterns;
  return Array.isArray(patterns) ? patterns : null;
}

/**
 * 「要確認」の印を付けるか。 **op の名前だけでなく中身を見る**(`ADR-0479` §Decision 4-6): `remember_design` は
 * 型(`patterns`)を持つときだけ印を付ける。
 */
function isFlagged(op: string, operation: Record<string, unknown>): boolean {
  if (op === "remember_design") {
    return patternsOf(operation) !== null;
  }
  return COMPARE_FLAGGED_OPS.has(op);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 文字列ならそのまま、定義なら「名前(ID)」(名前が無ければ ID)。 */
function nameOf(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  const record = asRecord(value);
  if (record === null) {
    return "";
  }
  const id = typeof record.id === "string" ? record.id : "";
  const name = typeof record.name === "string" ? record.name : "";
  if (name !== "" && id !== "") {
    return `${name}(${id})`;
  }
  return name !== "" ? name : id;
}

function targetOf(op: string, operation: Record<string, unknown>): string {
  switch (op) {
    case "add_table":
    case "remove_table":
    case "change_table":
      return nameOf(operation.table);
    case "add_field":
    case "remove_field":
    case "change_field": {
      const table = nameOf(operation.table);
      const field = nameOf(operation.field);
      return table === "" ? field : `${table} の ${field}`;
    }
    case "add_view":
    case "update_view":
    case "remove_view":
      return nameOf(operation.view);
    case "add_workflow":
    case "update_workflow":
    case "remove_workflow":
      return nameOf(operation.workflow);
    case "add_function":
    case "update_function":
    case "remove_function":
      return nameOf(operation.function);
    case "remember_design": {
      // **型の文そのものは出さず、件数だけ**(`ADR-0479` §Decision 4-6)。
      const patterns = patternsOf(operation);
      if (patterns === null) {
        return "";
      }
      return patterns.length === 0 ? "型をすべて外す" : `型 ${patterns.length} 件`;
    }
    case "set_roles":
      return Array.isArray(operation.roles)
        ? operation.roles
            .map(nameOf)
            .filter((name) => name !== "")
            .join("、")
        : "";
    default:
      return "";
  }
}

/**
 * **案の差分を、確認の小窓に出す変更の一覧に直す**(`D-V20-55`)。 op ごとに1行、種類の言い方と対象の名前まで。
 * **中身の細部(条件式・自動処理の手順・色の値)は出さない。** 形の違う差分でも投げない。
 */
export function describeCompareOperations(diff: unknown): CompareOperationLine[] {
  const operations = asRecord(diff)?.operations;
  if (!Array.isArray(operations)) {
    return [];
  }
  return operations.map((raw) => {
    const operation = asRecord(raw) ?? {};
    const op = typeof operation.op === "string" ? operation.op : String(operation.op ?? "");
    const label = COMPARE_OPERATION_LABELS[op] ?? `その他の変更(${op})`;
    return {
      op,
      label,
      target: op in COMPARE_OPERATION_LABELS ? targetOf(op, operation) : "",
      flagged: isFlagged(op, operation),
    };
  });
}

// --- 送る本文(`D-V20-56` / `D-V20-57`。`ADR-0479` §Decision 4-5) -----------------------------------

/**
 * **確認の小窓の OK で送る本文**。 案の差分の `operations` の末尾に
 * `{ op: "remember_design", design_memory: { choice: { name, tradeoff, reason? } } }` を1本足したもの
 * (`diff_id` と `intent` は案のまま)。 理由は前後の空白を落とし、空なら `reason` のキーを持たない。
 * **字数は画面で止めない**(サーバの 400 を小窓の中に出す)。 元の差分は書き換えない。
 * `operations` を持たない形の違う差分は、そのまま返す(サーバが断る)。
 */
export function withDesignChoice(
  diff: unknown,
  chosen: { name: string; tradeoff: string },
  reason: string,
): unknown {
  const record = asRecord(diff);
  if (record === null || !Array.isArray(record.operations)) {
    return diff;
  }
  const trimmed = reason.trim();
  const choice =
    trimmed === ""
      ? { name: chosen.name, tradeoff: chosen.tradeoff }
      : { name: chosen.name, tradeoff: chosen.tradeoff, reason: trimmed };
  return {
    ...record,
    operations: [...record.operations, { op: "remember_design", design_memory: { choice } }],
  };
}
