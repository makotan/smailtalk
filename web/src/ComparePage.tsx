/**
 * **見比べの画面**(`V20-M14-T01C`。計画 `docs/plan/v20/16-v20-m14-plan.md` §9-3 / §10-3、
 * ユーザ決定 `D-V20-47`〜`D-V20-54`、変更 ADR `ADR-0478`)。
 *
 * ## 何を描くか
 *
 * - 上端の帯「見比べ(適用前)。選んで確認するとアプリに反映されます。期限 HH:MM」(`D-V20-51`)。
 * - 幅の切り替え「モバイル(390px)」「デスクトップ(1280px)」(既定はモバイル)。
 * - 案ごとに、名前・トレードオフ(**切らずに折り返して全部出す**)・注意(件数と文)・
 *   `<iframe src="/apps/pv-<案>/">`(中は `V20-M13` の1案の下見そのまま。下見の帯も中に出る)・「この案にする」。
 * - 1案でも出して選べる(`D-V20-53`)。
 *
 * ## 見た目(**`web/src/styles.css` に1規則も足さない**。`ADR-0478` §Decision 4)
 *
 * **Tailwind の部品体系の既存のクラスと、要素の `style` 属性と、既存の部品(`Button` / `Card` / `OverlayDialog` /
 * `ErrorList`)だけで書く。** `style` に立てるのは枠の幅・高さ・縮め(`transform: scale`)とその起点、
 * 外側の箱の幅と高さだけである。 **幅の切り替えが変えるのは iframe の幅だけで、iframe の中(案の画面)には
 * 1宣言も足さない** —— 中の描画が幅で変わるのは、中の画面の Tailwind の `sm` / `lg` の断点による。
 * `<style>` 要素を使わない(`web/test/style-sources.test.ts` の集合3)。
 *
 * ## 適用(`D-V20-48` / `D-V20-49` / `D-V20-50` / `D-V20-54`)
 *
 * 「この案にする」→ 確認の小窓(名前・トレードオフ・変更の意図・変更の一覧・注意・理由の欄)→ OK →
 * **`/compare` をもう一度引いてその案の `stale` を見る**(古い・居なければ送らない)→ **候補の `diff` の
 * `operations` の末尾に、選んだ記録 `{ op: "remember_design", design_memory: { choice: { name, tradeoff,
 * reason? } } }` を1本足したもの**を本物の `POST /api/apps/<本物>/diffs` へ送る(`web/src/api.ts` の
 * `applyCandidateDiff`。同一オリジン・cookie)。 **OK を1回押すごとに1回、成功(201)は束の中で1回だけ**
 * (`ADR-0479` §Decision 4-5 が `ADR-0478` §Decision 1-8 の「候補の `diff` をそのまま1回だけ」を引き直した。
 * 決定 `D-V20-56`)。 **前段を通らない**。 **判定と適用の間に別の変更が割り込む窓は残る**(`D-V20-49` の代償3)。
 *
 * **小窓は成功するまで閉じず、理由の入力を保つ**(計画 `docs/plan/v20/17-v20-m15-plan.md` §10-5 の中10)。
 * 古い・400・401・403・409 は小窓の中に出し、押し直せる(押し直すたびに `/compare` を引き直す)。 送っている間は
 * OK を止める。 成功したら小窓を閉じ、この画面では残りの案を選べなくする。
 *
 * 理由の欄(`D-V20-57`)は1行・任意。 前後の空白を落とし、空なら `reason` を送らない。 字数は画面で止めない。
 * 欄の上に固定文(選んだ記録に残すこと)、下に注意書き(`D-V20-63`。ログインできる人なら誰でも読める)。
 * 案の `off_pattern` が真なら見出しに「このアプリの型と違う」(`D-V20-59`。外れた案も選べる)。
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ApiError, applyCandidateDiff, fetchPreviewCompare, type ValidationError } from "./api.ts";
import { toValidationErrors } from "./async.ts";
import { ErrorList } from "./ErrorList.tsx";
import { isPreviewAppId } from "./preview.ts";
import {
  COMPARE_CHOICE_NOTE,
  COMPARE_DEFAULT_WIDTH,
  COMPARE_FRAME_HEIGHT,
  COMPARE_OFF_PATTERN_LABEL,
  COMPARE_REASON_NOTICE,
  COMPARE_STALE_MESSAGE,
  COMPARE_WIDTHS,
  type CompareCandidate,
  type CompareLookup,
  type CompareNotice,
  type CompareWidthKey,
  classifyApplyFailure,
  compareBannerText,
  compareLayout,
  describeCompareOperations,
  ensureCompareLookup,
  noteCompare,
  type PreviewCompare,
  useCompareLookup,
  withDesignChoice,
} from "./preview-compare.ts";
import { Button } from "./ui/button.tsx";
import { Input, Label } from "./ui/form-controls.tsx";
import { OverlayDialog } from "./ui/overlay.tsx";
import { Badge, Card, Skeleton } from "./ui/surfaces.tsx";
import { cn } from "./ui/utils.ts";

/** `/compare` を引いて、画面の分かれ目(見比べ / 1案の下見 / 期限切れ)を返す。 */
async function loadCompare(
  appId: string,
): Promise<Exclude<CompareLookup, { status: "unknown" } | { status: "loading" }>> {
  try {
    const compare = await fetchPreviewCompare(appId);
    return compare === null ? { status: "single" } : { status: "compare", compare };
  } catch (error) {
    if (error instanceof ApiError && error.status === 410) {
      // 期限切れの画面は `PreviewGate` が出す(`apiFetch` が下見の状態へ知らせ済み)。
      return { status: "expired" };
    }
    // 想定外の失敗は今日どおり1案の下見として描く(見比べを勝手に作らない)。
    return { status: "single" };
  }
}

/** 上端の帯(束を引けたときだけ出る)。 */
export function CompareBanner({ appId }: { appId: string | undefined }) {
  const lookup = useCompareLookup(isPreviewAppId(appId) ? appId : undefined);
  if (lookup.status !== "compare") {
    return null;
  }
  return (
    <div
      role="status"
      data-testid="compare-banner"
      className={cn(
        "font-sans font-bold bg-muted text-foreground border-b-2 border-border",
        "px-s3 py-s2",
      )}
    >
      {compareBannerText(lookup.compare.expires_at)}
    </div>
  );
}

/**
 * 下見の綴りの画面で、先に `/compare` を1回引いてから描く。 束なら見比べの画面、そうでなければ今日どおり
 * `children`(1案の下見の作業画面)。 **下見の綴りでないアプリでは何も引かずに `children` を描く。**
 */
export function PreviewCompareGate({
  appId,
  children,
}: {
  appId: string;
  children: React.ReactNode;
}) {
  const preview = isPreviewAppId(appId);
  const lookup = useCompareLookup(preview ? appId : undefined);
  useEffect(() => {
    if (preview) {
      ensureCompareLookup(appId, () => loadCompare(appId));
    }
  }, [appId, preview]);
  if (!preview) {
    return <>{children}</>;
  }
  switch (lookup.status) {
    case "unknown":
    case "loading":
      return (
        <div data-testid="compare-loading" className={cn("flex flex-col gap-s1")}>
          <p className={cn("m-0", "text-note text-muted-foreground")}>読み込み中…</p>
          <Skeleton className="h-4 w-full" />
        </div>
      );
    case "compare":
      return <ComparePage appId={appId} compare={lookup.compare} />;
    case "expired":
      // `PreviewGate`(外側)が期限切れの画面を出す。ここでは何も描かない。
      return null;
    case "single":
      return <>{children}</>;
  }
}

/** 適用の結果(画面の上に1つ出す)。 */
type Outcome =
  | { kind: "applied"; name: string }
  | { kind: "stale" }
  | { kind: "login" }
  | { kind: "origin" }
  | { kind: "forbidden" }
  | { kind: "errors"; errors: ValidationError[] };

/**
 * 並べる器の間(`gap-s3` = `--space-3` の既定 0.75rem = 12px)。 **計算値を読まない**
 * (`getComputedStyle` を `web/src` で使わない。`web/test/report-view.test.tsx` の (T04-7))。
 * 詰め具合で間が広がっても、縮める比が少し大きくなって段が折れるだけである。
 */
const COMPARE_GAP_PX = 12;

/** 並べる器の幅を測る(測れない環境では 0 = 縮めない)。 */
function useAvailableWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) {
      return undefined;
    }
    const measure = () => {
      setWidth(element.clientWidth);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      return undefined;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);
  return [ref, width];
}

export function ComparePage({ appId, compare }: { appId: string; compare: PreviewCompare }) {
  const [widthKey, setWidthKey] = useState<CompareWidthKey>(COMPARE_DEFAULT_WIDTH);
  const [confirming, setConfirming] = useState<CompareCandidate | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  /** 画面の上に出す結果(成功だけ)。 */
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  /** 小窓の中に出す結果(古い・断り。小窓は閉じない)。 */
  const [dialogOutcome, setDialogOutcome] = useState<Outcome | null>(null);
  /** 送っている間の二度押しを止める(状態の更新を待たずに効く)。 */
  const sending = useRef(false);
  const [listRef, available] = useAvailableWidth();
  const reasonId = useId();

  const frameWidth = COMPARE_WIDTHS.find((width) => width.key === widthKey)?.px ?? 390;
  const { scale } = compareLayout({
    available,
    gap: COMPARE_GAP_PX,
    count: compare.candidates.length,
    frameWidth,
  });
  const applied = outcome?.kind === "applied";
  // 引き直した束で、小窓の案が古い・居ないなら OK を止める。
  const confirmingNow =
    confirming === null
      ? undefined
      : compare.candidates.find((entry) => entry.id === confirming.id);
  const confirmingStale = confirmingNow === undefined || confirmingNow.stale;

  function openConfirm(candidate: CompareCandidate): void {
    setReason("");
    setDialogOutcome(null);
    setConfirming(candidate);
  }

  function closeConfirm(): void {
    if (sending.current) {
      return; // 送っている間は閉じない(結果を小窓に出すため)。
    }
    setConfirming(null);
    setReason("");
    setDialogOutcome(null);
  }

  async function apply(chosen: CompareCandidate): Promise<void> {
    if (sending.current) {
      return;
    }
    sending.current = true;
    setBusy(true);
    setDialogOutcome(null);
    try {
      // **OK を押すたびに `/compare` を引き直して、その案が古くなっていないかを見る**(`D-V20-49` / 中10)。
      let fresh: PreviewCompare | null;
      try {
        fresh = await fetchPreviewCompare(appId);
      } catch (error) {
        if (error instanceof ApiError && error.status === 410) {
          return; // 期限切れの画面は `PreviewGate` が出す。
        }
        setDialogOutcome({ kind: "errors", errors: toValidationErrors(error) });
        return;
      }
      if (fresh !== null) {
        noteCompare(appId, fresh);
      }
      const current = fresh?.candidates.find((entry) => entry.id === chosen.id);
      if (current === undefined || current.stale) {
        setDialogOutcome({ kind: "stale" });
        return;
      }
      try {
        await applyCandidateDiff(
          compare.app_id,
          withDesignChoice(
            current.diff,
            { name: current.name, tradeoff: current.tradeoff },
            reason,
          ),
        );
        sending.current = false;
        setConfirming(null);
        setReason("");
        setOutcome({ kind: "applied", name: current.name });
      } catch (error) {
        if (error instanceof ApiError) {
          const failure = classifyApplyFailure(error.status, error.errors);
          setDialogOutcome(
            failure.kind === "errors" ? { kind: "errors", errors: error.errors } : failure,
          );
        } else {
          setDialogOutcome({ kind: "errors", errors: toValidationErrors(error) });
        }
      }
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  return (
    <section data-testid="compare-page" className={cn("flex flex-col gap-s3 font-sans")}>
      <div data-testid="compare-width" className={cn("flex flex-wrap items-center gap-s2")}>
        <span className={cn("text-sm text-muted-foreground")}>表示幅</span>
        {COMPARE_WIDTHS.map((width) => (
          <Button
            key={width.key}
            size="sm"
            variant={width.key === widthKey ? "primary" : "default"}
            aria-pressed={width.key === widthKey}
            onClick={() => setWidthKey(width.key)}
          >
            {width.label}
          </Button>
        ))}
      </div>

      {outcome !== null && <OutcomeView outcome={outcome} realAppId={compare.app_id} />}

      <div
        ref={listRef}
        data-testid="compare-list"
        className={cn("flex flex-wrap items-start gap-s3")}
      >
        {compare.candidates.map((candidate) => (
          <CandidateCard
            key={candidate.id}
            candidate={candidate}
            frameWidth={frameWidth}
            scale={scale}
            disabled={candidate.stale || applied || busy}
            onChoose={() => openConfirm(candidate)}
          />
        ))}
      </div>

      <OverlayDialog
        title="この案にしますか"
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) {
            closeConfirm();
          }
        }}
      >
        {confirming !== null && (
          <div data-testid="compare-confirm" className={cn("flex flex-col gap-s2")}>
            <p className={cn("m-0 font-semibold break-words")}>{confirming.name}</p>
            <p className={cn("m-0 break-words")}>{confirming.tradeoff}</p>
            <div className={cn("flex flex-col gap-s1")}>
              <span className={cn("text-sm text-muted-foreground")}>変更の意図</span>
              <p className={cn("m-0 break-words")} data-testid="compare-confirm-intent">
                {confirming.intent}
              </p>
            </div>
            <OperationList diff={confirming.diff} />
            <NoticeList notices={confirming.design_notices} />
            <div className={cn("flex flex-col gap-s1")}>
              <p
                data-testid="compare-confirm-choice-note"
                className={cn("m-0 text-sm text-muted-foreground break-words")}
              >
                {COMPARE_CHOICE_NOTE}
              </p>
              <Label htmlFor={reasonId}>理由(任意)</Label>
              <Input
                id={reasonId}
                type="text"
                data-testid="compare-confirm-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
              <p
                data-testid="compare-confirm-reason-notice"
                className={cn("m-0 text-sm text-muted-foreground break-words")}
              >
                {COMPARE_REASON_NOTICE}
              </p>
            </div>
            {dialogOutcome !== null && (
              <OutcomeView outcome={dialogOutcome} realAppId={compare.app_id} />
            )}
            <p className={cn("m-0 text-sm text-muted-foreground")}>
              OK を押すと、この案の変更をアプリに反映します。
            </p>
            <div className={cn("flex flex-wrap justify-end gap-s2")}>
              <Button
                data-testid="compare-confirm-cancel"
                disabled={busy}
                onClick={() => closeConfirm()}
              >
                やめる
              </Button>
              <Button
                variant="primary"
                data-testid="compare-confirm-ok"
                disabled={busy || confirmingStale || applied}
                onClick={() => {
                  void apply(confirming);
                }}
              >
                OK
              </Button>
            </div>
          </div>
        )}
      </OverlayDialog>
    </section>
  );
}

/**
 * **案の変更の一覧**(`D-V20-55`。`V20-M14` 点検の処置 中3)。 op ごとに1行、種類の言い方と対象の名前まで。
 * 役割と権限の設定・自動処理の変更には「要確認」の印を付ける(並んだ下見の画面を見ても違いが分からないため)。
 * 読まずに OK を押すことは止めない。 **型の変更(`remember_design` の `patterns`)も「型を変える」と印**
 * (`D-V20-64`)。 **画面が足す選んだ記録の1本はここに混ぜない**(小窓の固定文で示す)。
 */
function OperationList({ diff }: { diff: unknown }) {
  const lines = describeCompareOperations(diff);
  if (lines.length === 0) {
    return null;
  }
  const flagged = lines.some((line) => line.flagged);
  return (
    <div data-testid="compare-confirm-operations" className={cn("flex flex-col gap-s1 text-sm")}>
      <span className={cn("text-muted-foreground")}>この案が行う変更 {lines.length}件</span>
      <ul className={cn("m-0 flex flex-col gap-s1")}>
        {lines.map((line, index) => (
          <li
            // 同じ op が並びうるので、並びの位置で区別する(並びは変わらない)。
            // biome-ignore lint/suspicious/noArrayIndexKey: 差分の op の並びは固定
            key={index}
            data-testid="compare-confirm-operation"
            data-op={line.op}
            className={cn("flex flex-wrap items-center gap-s1 break-words")}
          >
            <span>{line.target === "" ? line.label : `${line.label}: ${line.target}`}</span>
            {line.flagged && (
              <Badge variant="destructive" data-testid="compare-confirm-operation-flag">
                要確認
              </Badge>
            )}
          </li>
        ))}
      </ul>
      {flagged && (
        <p className={cn("m-0 text-muted-foreground")}>
          「要確認」の変更(権限の設定・自動処理・型)は、並んだ画面を見ても違いが分かりません。
        </p>
      )}
    </div>
  );
}

function NoticeList({ notices }: { notices: readonly CompareNotice[] }) {
  if (notices.length === 0) {
    return null;
  }
  return (
    <div data-testid="compare-candidate-notices" className={cn("flex flex-col gap-s1 text-sm")}>
      <span className={cn("font-semibold")}>注意 {notices.length}件</span>
      <ul className={cn("m-0 flex flex-col gap-s1")}>
        {notices.map((notice, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 注意は識別子を持たず、並び順(サーバが返した順)が同一性である
          <li key={index} className={cn("break-words")}>
            {notice.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CandidateCard({
  candidate,
  frameWidth,
  scale,
  disabled,
  onChoose,
}: {
  candidate: CompareCandidate;
  frameWidth: number;
  scale: number;
  disabled: boolean;
  onChoose: () => void;
}) {
  const boxWidth = Math.floor(frameWidth * scale);
  const boxHeight = Math.floor(COMPARE_FRAME_HEIGHT * scale);
  return (
    <article
      data-testid="compare-candidate"
      data-candidate-id={candidate.id}
      className={cn("flex min-w-0 flex-col gap-s2")}
      style={{ width: `${boxWidth}px` }}
    >
      <Card className={cn("flex flex-col gap-s2 p-s3")}>
        <h2
          data-testid="compare-candidate-name"
          className={cn("m-0 text-base font-semibold break-words")}
        >
          {candidate.name}
        </h2>
        {candidate.off_pattern === true && (
          <Badge variant="outline" data-testid="compare-candidate-off-pattern">
            {COMPARE_OFF_PATTERN_LABEL}
          </Badge>
        )}
        <p
          data-testid="compare-candidate-tradeoff"
          className={cn("m-0 whitespace-normal break-words")}
        >
          {candidate.tradeoff}
        </p>
        <NoticeList notices={candidate.design_notices} />
        {candidate.stale && (
          <p data-testid="compare-candidate-stale" className={cn("m-0 text-sm text-destructive")}>
            {COMPARE_STALE_MESSAGE}
          </p>
        )}
        <div>
          <Button
            variant="primary"
            data-testid="compare-choose"
            disabled={disabled}
            onClick={onChoose}
          >
            この案にする
          </Button>
        </div>
      </Card>
      {/* 外側の箱は縮めた後の大きさを持つ(縮めても下の要素が重ならない)。 */}
      <div
        data-testid="compare-frame-box"
        className={cn("overflow-hidden")}
        style={{ width: `${boxWidth}px`, height: `${boxHeight}px` }}
      >
        <iframe
          src={candidate.url}
          title={`${candidate.name} の下見`}
          referrerPolicy="no-referrer"
          style={{
            width: `${frameWidth}px`,
            height: `${COMPARE_FRAME_HEIGHT}px`,
            transform: `scale(${scale})`,
            transformOrigin: "0 0",
          }}
        />
      </div>
    </article>
  );
}

function OutcomeView({ outcome, realAppId }: { outcome: Outcome; realAppId: string }) {
  const realUrl = `/apps/${encodeURIComponent(realAppId)}/`;
  switch (outcome.kind) {
    case "applied":
      return (
        <div role="status" data-testid="compare-result" className={cn("flex flex-wrap gap-s2")}>
          <span>適用しました({outcome.name})。</span>
          <a href={realUrl}>アプリを開く</a>
        </div>
      );
    case "stale":
      return (
        <div role="alert" data-testid="compare-result">
          <ErrorList errors={[{ path: "", message: COMPARE_STALE_MESSAGE }]} />
        </div>
      );
    case "login":
      return (
        <div role="alert" data-testid="compare-result" className={cn("flex flex-col gap-s1")}>
          <ErrorList
            errors={[
              {
                path: "",
                message: "適用するにはログインが要ります",
                hint: "アプリを別のタブで開いてログインしてから、この画面で押し直してください。",
              },
            ]}
          />
          <a href={realUrl} target="_blank" rel="noopener noreferrer">
            アプリを別のタブで開く
          </a>
        </div>
      );
    case "origin":
      return (
        <div role="alert" data-testid="compare-result">
          <ErrorList
            errors={[
              {
                path: "",
                message: "この画面からは適用できません",
                hint: "書き込みを許可しているアドレスで見比べの画面を開き直してください。",
              },
            ]}
          />
        </div>
      );
    case "forbidden":
      return (
        <div role="alert" data-testid="compare-result">
          <ErrorList
            errors={[
              {
                path: "",
                message: "権限がありません",
                hint: "アプリの設定を変えられる人がログインして押してください。",
              },
            ]}
          />
        </div>
      );
    case "errors":
      return (
        <div role="alert" data-testid="compare-result">
          <ErrorList errors={outcome.errors} />
        </div>
      );
  }
}
