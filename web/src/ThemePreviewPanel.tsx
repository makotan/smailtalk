/**
 * 実物プレビュー選択の画面(V3-M4-T01 / D-G7。**判定 = 将来送り・門外 Δ7**)。
 *
 * 審査の正は `docs/plan/v3/records/v3-m4-gate-a-intake.md` §3(帰属先は**表示層**であり、
 * 候補集合を `src/mcp/` の説明文層に置いたら Δ10 で差し戻される)、完了条件の正は
 * `docs/plan/v3/records/v3-m4.md` §2 の「V3-M4-T01」節である。
 *
 * ## 何をする画面か
 *
 * **このアプリの画面を1つ選び、組み込みの候補ぶんだけ同時に描く**(ユーザ決定 D-M4-3 =
 * 1画面を N 枚同時。**切替式にしない**)。並んだ中から1つを選ぶと、既存の `apply_diff`
 * 経路に `set_theme` の差分が1件飛ぶ。
 *
 * ## 「実物」と言えること / 言えないこと(誇張しない)
 *
 * - **枠の中身は当該アプリの実データである** —— 枠は製品と同じ `ViewHost` を描き、
 *   レコードは製品と同じ API 経路から来る。サンプルデータを別に持っていない。
 * - **並ぶのは1画面だけである。** アプリが持つ画面すべてを並べるのではなく、
 *   いま選んでいる画面(選んでいなければ画面一覧の先頭)を候補の数だけ描く。
 * - **候補の配色はこのリポジトリのコードが持つ値であって、利用者の組織の色ではない**
 *   (`theme-candidates.ts` 冒頭)。**選べるのは「出発点」までである。**
 *
 * ## 代償(D-M4-3。打ち消していない)
 *
 * **枠が1つ増えるごとに、その画面ぶんの API 呼び出しがそのまま増える。** `ViewHost` の
 * 配下(`ListViewRenderer` など)は自分でデータを取るので、候補が3件なら3倍である
 * (実測は `web/test/theme-preview.test.tsx`)。**この緊張を打ち消す設計は選んでいない。**
 *
 * ## 入口が owner 限定であることの意味(完了条件11)
 *
 * この画面への導線は `AppWorkspace` の `isOwner` 分岐の中にある。**しかし
 * `POST /api/apps/:app_id/diffs` は認証を要求しない** —— v0 からの状態であり、
 * **本タスクは `src/server/` を1バイトも変えていない。「安全にした」のではない。**
 * UI が押させないことは、サーバ側の遮断の代わりにならない。
 * **【V4-FIX1 項目(5) による改訂。上の記述は制定時のものであり1バイトも書き換えていない】**
 * **`POST /api/apps/:app_id/diffs` は今日、認証を要求する**(未認証 401 / owner 以外 403)。
 * **ユーザ決定「書き換えの口は塞ぐ …(必須)」の履行であり、担保はサーバ側にある。**
 * **それでも「安全にした」とは書かない** —— `GET /manifest` / `GET /changelog` /
 * `GET /undo/preview` / `GET /requirements` は今日も未認証で通り、MCP 経路は1ミリも守られない。
 *
 * ## 変換規則(恒等写像)は2本目を作っていない
 *
 * 枠に立てるのは候補のスロットそのままで、名前の変換を1つも挟まない(`AppWorkspace` の
 * `AppThemeScope` と同一の規則)。**規則が2本に割れていないことは
 * `web/test/theme-preview.test.tsx` が機械的に固定している**(枠に立つ名前の集合が
 * `schemas/manifest.schema.json` の `$defs/theme` の properties キー集合と完全一致する)。
 *
 * ## 【V4-M15-T14】枠の中身に見た目の宣言を1つも足していない(`ADR-0054` 限定2)
 *
 * **部品体系に載せ替えたのは、枠の**外**(パネルの見出し・閉じる・注記・結果)だけである。**
 * **`ThemePreviewFrame` の中身(見出し・注記・「このテーマにする」)は1バイトも触っていない**
 * —— **枠の中に立つのは候補のスロットの実値だけであり、そこに製品側の宣言を足すと
 * 「候補どうしを見比べる」ことが成り立たなくなる**(`web/src/styles.css` の
 * `.theme-preview-list` の注記が「器の並べ方だけを書き、枠の中の見た目を1宣言も持たない」と
 * 定めた線そのものである)。
 *
 * **`.theme-preview-list`(器の並べ方)にも1クラスも足していない** —— 並べ方は
 * `web/src/styles.css` の `grid-template-columns: repeat(auto-fit, …)` が既に持っており、
 * **同じことを2箇所に書かない。**
 */
import { type CSSProperties, type ReactNode, useState } from "react";
import type { Manifest, View } from "../../src/kernel/types.ts";
import { applyThemeDiff, type ValidationError } from "./api.ts";
import { toValidationErrors } from "./async.ts";
import { ErrorList } from "./ErrorList.tsx";
import {
  newDiffSuffix,
  THEME_CANDIDATES,
  type ThemeCandidate,
  themeCandidateDiff,
} from "./theme-candidates.ts";
import { Button } from "./ui/button.tsx";
import { Card } from "./ui/surfaces.tsx";
import { cn } from "./ui/utils.ts";
import { ViewHost } from "./views/ViewHost.tsx";

/** 適用が成功したときに画面へ出す内容。 */
type AppliedState = { candidate: ThemeCandidate; diffId: string };

export function ThemePreviewPanel({
  appId,
  manifest,
  views,
  viewId,
  onClose,
}: {
  appId: string;
  manifest: Manifest;
  /** プレビューに使える画面(ロールで絞ったあとのもの)。 */
  views: readonly View[];
  /** いま選んでいる画面。無ければ `views` の先頭を描く。 */
  viewId?: string | undefined;
  onClose?: () => void;
}): ReactNode {
  const [applied, setApplied] = useState<AppliedState | null>(null);
  const [errors, setErrors] = useState<ValidationError[] | null>(null);
  const [busy, setBusy] = useState(false);

  const view = views.find((candidate) => candidate.id === viewId) ?? views[0];

  function apply(candidate: ThemeCandidate): void {
    setBusy(true);
    setApplied(null);
    setErrors(null);
    // 差分IDは押すたびに新しく採る(同一ミリ秒の連打で衝突しない)。
    applyThemeDiff(appId, themeCandidateDiff(candidate, newDiffSuffix())).then(
      ({ diffId }) => {
        setApplied({ candidate, diffId });
        setBusy(false);
      },
      (reason: unknown) => {
        setErrors(toValidationErrors(reason));
        setBusy(false);
      },
    );
  }

  return (
    <Card className={cn("theme-preview")} data-testid="theme-preview">
      <header
        className={cn("theme-preview-header", "flex flex-wrap items-center justify-between gap-s2")}
      >
        <h3 className={cn("m-0")}>テーマ候補のプレビュー</h3>
        {onClose !== undefined && (
          <Button size="sm" variant="secondary" data-testid="close-theme-preview" onClick={onClose}>
            閉じる
          </Button>
        )}
      </header>

      <p
        className={cn("theme-preview-preface", "m-0 text-note text-muted-foreground")}
        data-testid="theme-preview-preface"
      >
        このアプリの画面を、組み込みの候補{THEME_CANDIDATES.length}種で同時に描いています。
        候補はこの製品のコードが持っている固定の表で、増やすことはできません。中身はこのアプリの
        実データです。選ぶとテーマが差し替わり、その変更は変更履歴に残って undo で戻せます。
        なお、候補を並べているあいだは同じ画面を{THEME_CANDIDATES.length}回描くので、
        データの取得もその回数だけ行われます。
      </p>

      {errors !== null && <ErrorList errors={errors} />}
      {/*
       * **適用できたことを、枠のある器で出す**(着手前は素の `<p>` で、当たる CSS 規則は
       * 0件だった)。**`Alert` を使っていない** —— `Alert` は `role="alert"` を持ち、
       * それは読み上げへの割り込みを1つ増やすことになる。**足したのは枠と余白だけである。**
       * **文言も `data-testid` も1バイトも変えていない。**
       */}
      {applied !== null && (
        <p
          className={cn(
            "theme-preview-result",
            "m-0 rounded-ui border-[length:var(--border-width)] border-solid border-border p-s2 text-note",
          )}
          data-testid="theme-preview-result"
        >
          候補「{applied.candidate.name}」を適用しました(差分ID: {applied.diffId})。この画面の
          外側に反映するには再読み込みしてください。取り消しはこの画面ではできません —— 変更履歴の
          undo で戻します。
        </p>
      )}

      {view === undefined ? (
        <p
          className={cn("theme-preview-empty", "m-0 text-muted-foreground")}
          data-testid="theme-preview-empty"
        >
          並べられる画面がありません。テーマは画面の中身に当たるものなので、画面が1つも
          無いあいだは見比べるものがありません。
        </p>
      ) : (
        <div className="theme-preview-list" data-testid="theme-preview-list">
          {THEME_CANDIDATES.map((candidate) => (
            <ThemePreviewFrame
              key={candidate.id}
              appId={appId}
              manifest={manifest}
              view={view}
              candidate={candidate}
              busy={busy}
              onApply={apply}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

/** 候補1件ぶんの枠。**スロットはインラインスタイルへそのまま立てる(恒等写像)。** */
function ThemePreviewFrame({
  appId,
  manifest,
  view,
  candidate,
  busy,
  onApply,
}: {
  appId: string;
  manifest: Manifest;
  view: View;
  candidate: ThemeCandidate;
  busy: boolean;
  onApply: (candidate: ThemeCandidate) => void;
}): ReactNode {
  return (
    <section
      // `app-theme` は製品のスコープ要素と同じ器である(同じ CSS 規則が当たる)。
      // **`data-testid="app-theme"` は付けない** —— 製品のスコープ要素は常に1つだけである
      // という既存の実測(`web/e2e/theme.e2e.ts` (iii))を、この画面が壊さないため。
      className="app-theme"
      data-testid="theme-preview-frame"
      data-candidate-id={candidate.id}
      style={{ ...candidate.slots } as CSSProperties}
    >
      <h4>{candidate.name}</h4>
      <p className="theme-preview-note">{candidate.note}</p>
      <button
        type="button"
        data-testid="apply-theme-candidate"
        disabled={busy}
        onClick={() => onApply(candidate)}
      >
        このテーマにする
      </button>
      <ViewHost appId={appId} manifest={manifest} view={view} />
    </section>
  );
}
