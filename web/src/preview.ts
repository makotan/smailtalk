/**
 * **下見の画面の状態**(`V20-M13-T02c`。計画 `docs/plan/v20/15-v20-m13-plan.md` §9-6 / §10-4、
 * ユーザ決定 `D-V20-43` / `D-V20-45` / `D-V20-46`、変更 ADR `ADR-0476`)。
 *
 * - **下見かどうかは、URL のアプリID の綴り(`pv-` + 16進32桁)と、API の応答の頭
 *   `X-Smailtalk-Preview: mode=<real|sample>; expires_at=<ISO>` の両方で決める。** 綴りだけでは決めない
 *   —— 前段(`src/server/preview-front.ts`)は本体に同じ綴りのアプリが実在すると受けないので、
 *   そのとき頭は来ず、帯は出ない(本物のアプリに帯を出さない)。
 * - **期限切れ**は、下見の綴りの API が **410** を返したことで知る(前段の 410 には頭が付かない)。
 *   一度期限切れになったら戻らない(前段は以後も 410 を返す)。
 * - **新しい HTTP の口を足さない。** 画面が今日叩いている応答を `web/src/api.ts` が見せるだけである。
 * - 状態はアプリID ごとにこのモジュールの中に1つ持つ(`useSyncExternalStore` で読む)。
 *   **マニフェストにもサーバにも何も送らない。**
 */
import { useSyncExternalStore } from "react";
import type { ValidationError } from "../../src/kernel/errors.ts";

/** 前段が付ける応答の頭の名前(`src/server/preview-front.ts` の `PREVIEW_HEADER` と同じ綴り)。 */
export const PREVIEW_HEADER_NAME = "X-Smailtalk-Preview";

/** 下見のアプリID の綴り(前段 `parsePreviewAppId` と同じ `^pv-[0-9a-f]{32}$`)。 */
const PREVIEW_APP_ID_PATTERN = /^pv-[0-9a-f]{32}$/;

/** 下見のアプリID の綴りか(綴りだけ。下見であることの判定には頭も要る)。 */
export function isPreviewAppId(appId: string | undefined): boolean {
  return appId !== undefined && PREVIEW_APP_ID_PATTERN.test(appId);
}

export type PreviewInfo = { mode: "real" | "sample"; expiresAt: string };

/** 応答の頭を読む。**形が違えば `null`**(無いのと同じ = 帯を出さない)。 */
export function parsePreviewHeader(value: string | null | undefined): PreviewInfo | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const pairs = new Map<string, string>();
  for (const part of value.split(";")) {
    const at = part.indexOf("=");
    if (at > 0) {
      pairs.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
    }
  }
  const mode = pairs.get("mode");
  const expiresAt = pairs.get("expires_at");
  if ((mode !== "real" && mode !== "sample") || expiresAt === undefined) {
    return null;
  }
  if (Number.isNaN(new Date(expiresAt).getTime())) {
    return null;
  }
  return { mode, expiresAt };
}

/** 期限を利用者の時計の `HH:MM` にする。 */
export function formatPreviewDeadline(expiresAt: string): string {
  const at = new Date(expiresAt);
  const hh = String(at.getHours()).padStart(2, "0");
  const mm = String(at.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** 帯の本文(`D-V20-45` の逐語)。見本のときは「見本のデータで表示中」を添える。 */
export const PREVIEW_SAMPLE_NOTE = "見本のデータで表示中";

export function previewBannerHead(info: PreviewInfo): string {
  return `下見(適用前)。保存されません。期限 ${formatPreviewDeadline(info.expiresAt)}`;
}

export function previewBannerText(info: PreviewInfo): string {
  const head = previewBannerHead(info);
  return info.mode === "sample" ? `${head}。${PREVIEW_SAMPLE_NOTE}` : head;
}

export type PreviewState =
  | { status: "none" }
  | { status: "active"; info: PreviewInfo }
  | { status: "expired"; errors: ValidationError[] };

const NONE: PreviewState = Object.freeze({ status: "none" });
const states = new Map<string, PreviewState>();
const listeners = new Set<() => void>();

function publish(appId: string, next: PreviewState): void {
  states.set(appId, next);
  for (const listener of listeners) {
    listener();
  }
}

/** 下見の綴りの応答が頭を持っていた(`api.ts` が呼ぶ)。期限切れの後は動かさない。 */
export function notePreviewHeader(appId: string, header: string | null): void {
  const info = parsePreviewHeader(header);
  if (info === null) {
    return;
  }
  const current = states.get(appId);
  if (current?.status === "expired") {
    return;
  }
  if (
    current?.status === "active" &&
    current.info.mode === info.mode &&
    current.info.expiresAt === info.expiresAt
  ) {
    return;
  }
  publish(appId, { status: "active", info });
}

/** 下見の綴りの応答が 410 だった(`api.ts` が呼ぶ)。 */
export function notePreviewExpired(appId: string, errors: ValidationError[]): void {
  if (states.get(appId)?.status === "expired") {
    return;
  }
  publish(appId, { status: "expired", errors });
}

export function previewStateOf(appId: string | undefined): PreviewState {
  return appId === undefined ? NONE : (states.get(appId) ?? NONE);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** いま開いているアプリの下見の状態。 */
export function usePreviewState(appId: string | undefined): PreviewState {
  return useSyncExternalStore(
    subscribe,
    () => previewStateOf(appId),
    () => previewStateOf(appId),
  );
}

/** 検査のための初期化(製品は呼ばない)。 */
export function resetPreviewStates(): void {
  states.clear();
  for (const listener of listeners) {
    listener();
  }
}

/** `/api/apps/<id>/…` の `<id>`(URL 符号化を解いたもの)。 */
export function previewAppIdOfPath(path: string): string | undefined {
  const matched = /^\/api\/apps\/([^/?#]+)\//.exec(path);
  if (matched === null) {
    return undefined;
  }
  let appId: string;
  try {
    appId = decodeURIComponent(matched[1] ?? "");
  } catch {
    return undefined;
  }
  return isPreviewAppId(appId) ? appId : undefined;
}
