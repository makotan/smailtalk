/**
 * **下見の画面の帯・期限切れ・開けない画面**(`V20-M13-T02c`。計画 `docs/plan/v20/15-v20-m13-plan.md`
 * §9-6 / §10-4、ユーザ決定 `D-V20-43` / `D-V20-45` / `D-V20-46`)。
 *
 * ## 帯の置き場(上端の帯との関係)
 *
 * - **画面の器(`App.tsx` の `main.shell`)の最初の子に置く** —— シェルの見出し(アプリ一覧・切り替え)と
 *   アプリの上端の帯(`app-header`。明暗のスイッチが在る帯)の**さらに上**である。
 * - **アプリの上端の帯の中に入れない理由**: その帯は認証の状態ごとに別の器(`AuthenticatedWorkspace` /
 *   `AnonymousWorkspace` / ログイン画面)が描き、読み込み中・期限切れの画面には無い。**帯は「実データでも
 *   見本でも必ず出る」**(`D-V20-45`)ので、どの状態でも描かれる器の側に1本だけ置く。
 * - **明暗のスイッチは今日どおりアプリの上端の帯に在る**(動かしていない)。帯はスイッチの状態に従う
 *   (`<html>` の属性 / OS の設定で `:root` の色の変数が入れ替わる)。
 *
 * ## 色
 *
 * **Tailwind の役割の色の組だけで描く**(`bg-muted` = `--color-surface-highlight` /
 * `text-foreground` = `--color-text` / `border-border` = `--color-border`。`web/src/tailwind.css`)。
 * **新しい色の値を1つも足さない。`web/src/styles.css` を触らない。** 前景 `body_text` と背景
 * `highlight_surface` は、コントラストの検査(`src/kernel/theme-contrast.ts`)が「ページの面」の組として
 * 測る組である(明るい既定・暗い既定・テーマの両方の組)。
 *
 * ## Referer
 *
 * 下見の綴り(`pv-…`)の画面を開いている間、`<head>` に `<meta name="referrer" content="no-referrer">` を
 * 1本置く(`V20-M13-T02b` の記録 §6 の 3)。画面から外へのリンクを踏んでも識別子入りの URL が
 * `Referer` で出ない。**綴りだけで置く**(頭が届く前・期限切れの画面でも効かせる)。
 */
import { useEffect } from "react";
import { ErrorList } from "./ErrorList.tsx";
import {
  isPreviewAppId,
  PREVIEW_SAMPLE_NOTE,
  previewBannerHead,
  usePreviewState,
} from "./preview.ts";
import { cn } from "./ui/utils.ts";

/** 下見の綴りの画面の間だけ `meta referrer=no-referrer` を置く。 */
function useNoReferrer(active: boolean): void {
  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const meta = document.createElement("meta");
    meta.name = "referrer";
    meta.content = "no-referrer";
    meta.setAttribute("data-preview", "true");
    document.head.appendChild(meta);
    return () => {
      meta.remove();
    };
  }, [active]);
}

/** 上端の帯。下見の頭を受けたときだけ出る。 */
export function PreviewBanner({ appId }: { appId: string | undefined }) {
  useNoReferrer(isPreviewAppId(appId));
  const state = usePreviewState(isPreviewAppId(appId) ? appId : undefined);
  if (state.status !== "active") {
    return null;
  }
  const { info } = state;
  return (
    <div
      role="status"
      data-testid="preview-banner"
      data-preview-mode={info.mode}
      className={cn(
        "font-sans font-bold bg-muted text-foreground border-b-2 border-border",
        "px-s3 py-s2 flex flex-wrap items-baseline gap-s2",
      )}
    >
      <span>{previewBannerHead(info)}</span>
      {info.mode === "sample" && (
        <span data-testid="preview-banner-sample">{PREVIEW_SAMPLE_NOTE}</span>
      )}
    </div>
  );
}

/**
 * 下見の綴りの画面で、期限切れ(410)を受けたら中身の代わりに期限切れの画面を出す。
 * **黙って空の画面やログイン画面にしない**(`D-V20-43`)。文言はサーバの本文をそのまま出す。
 */
export function PreviewGate({
  appId,
  children,
}: {
  appId: string | undefined;
  children: React.ReactNode;
}) {
  const state = usePreviewState(isPreviewAppId(appId) ? appId : undefined);
  if (state.status === "expired") {
    return (
      <div data-testid="preview-expired" className={cn("font-sans")}>
        <ErrorList errors={state.errors} />
      </div>
    );
  }
  return <>{children}</>;
}

/**
 * 下見なのに頼んだ人として開けなかった(401 が来た)ときの画面。
 * **本物のアプリのログイン画面へ誘導しない。**
 */
export function PreviewUnavailable() {
  return (
    <div data-testid="preview-unavailable" className={cn("font-sans")}>
      <ErrorList
        errors={[
          {
            path: "",
            message: "この下見は、頼んだ人の見え方で開けませんでした。",
            hint: "下見の URL を作り直してください。下見の画面から本物のアプリのログイン画面には移りません。",
          },
        ]}
      />
    </div>
  );
}
