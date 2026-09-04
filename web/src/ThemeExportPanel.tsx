/**
 * テーマの持ち出し口(V3-M1-T05 / D-G3b。**判定 = 将来送り・門外 Δ7**)。
 *
 * 審査の正は `docs/plan/v3/records/v3-m1-gate-a-theme.md` §5(帰属先は**表示層**であり、
 * MCP ツール `export_theme`(案#3)として出したら Δ10 で差し戻される)、完了条件の正は
 * `docs/plan/v3/records/v3-m1.md` §2 の「V3-M1-T05」節。
 *
 * ## 何をする画面か
 *
 * このアプリのマニフェストに入っているテーマ(`/app/theme`)を、**`theme.css` の形にして
 * コピーできるようにするだけ**である。**形式はコピーであってダウンロードではない**
 * (`web/src/` に `createObjectURL` / `download=` / `new Blob(` は各0件で、
 *  コピーの先例は `web/src/RequirementsDocPanel.tsx` に実在する。T05-4)。
 *
 * ## もう1つの形式(`theme.json`)はここに無い
 *
 * **`theme.json` は `get_manifest` の出力そのものである**(案#1。追加実装0件)。
 * `get_manifest` の応答の `manifest.app.theme` —— JSON Pointer で `/app/theme` —— が
 * そのまま `theme.json` であり、**新しい変換層を1つも作らない**(T05-3 / ADR-0026 の作法)。
 * したがってこのファイルは JSON を1バイトも組み立てない。
 *
 * ## カーネルの値を import しない
 *
 * 宣言名は**マニフェストのキーそのもの**である(下記の恒等写像)。したがって
 * `src/kernel/` から値を import する必要が無く、ADR-0009 限定2 と
 * `scripts/kernel-import-drift.test.ts` を1ミリも動かさない(型のみ import する)。
 *
 * ## 生成器をカーネルに置かない
 *
 * `src/kernel/` に生成器を置くと、**同じ意味論が2箇所に住む**(審査記録 §5 S3-3。
 * ADR-0025 §問2② が同型の危険を W-C と評価した)。**`src/` と `schemas/` は
 * 1バイトも変えない**(T05-12。1件でも変われば歯止め1-1 により門A へ差し戻し)。
 */
import { type ReactNode, useState } from "react";
import type { Theme } from "../../src/kernel/types.ts";
import { Button } from "./ui/button.tsx";
import { Card } from "./ui/surfaces.tsx";
import { cn } from "./ui/utils.ts";

/**
 * スロット名 → CSS カスタムプロパティ名の変換規則は**1本だけ(恒等写像)**である。
 *
 * V3-M1-T03 段階B が定義し(`web/test/theme-slot-parity.test.ts` の
 * `themeSlotToCssCustomProperty`)、T04 が製品の適用経路(`AppWorkspace` の
 * `AppThemeScope`)で使っているのと**同一の規則**である。**2本目を作ってはならない**
 * —— 作ると持ち出した `theme.css` が「形式は安定しているが当たらない」状態になる
 * (T05-4 / 審査記録 §5 S3-5)。ここでは関数にすらせず、キーをそのまま書く。
 *
 * 並びは**スロット名の昇順**にする。CSS カスタムプロパティの宣言は同一ブロック内で
 * 互いに独立(キーは一意)なので並びに意味は無いが、**生成物が一意に決まらないと
 * 「同じテーマから同じ `theme.css` が出る」と言えない**ので固定する。
 * `localeCompare` を使わないのは `web/test/styles.test.ts` と同じ理由(ICU の照合順は
 * 実行環境に依存する)。
 */
function sortedSlots(theme: Theme): [string, string][] {
  return Object.entries(theme.slots).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * 持ち出し物の注記。**含まれないものを、含まれないと書く**(T05-5 / T05-6)。
 *
 * ここに書く内容は「別実装で同じ見た目になる」という約束を**しない**ためのものである。
 * 担保できるのは**形式の安定**までであって、外部実装での見た目の一致ではない
 * (審査記録 §5 S3-2。**D-3 の文言「別実装での再利用を担保する」をそのまま満たしたとは
 *  書かない**)。**波括弧を1文字も書かない** —— 生成物の `{` / `}` はスタイル規則の
 * 1組だけであることをテストが固定している。
 */
function header(theme: Theme): string[] {
  const origin =
    theme.origin === undefined
      ? " * 由来: 記録なし(手で作られたテーマである)。"
      : ` * 由来: アプリ "${theme.origin.template_app_id}"` +
        (theme.origin.template_diff_id === undefined
          ? ""
          : ` の版 "${theme.origin.template_diff_id}"`) +
        " —— これは自己申告であり、SmAIltalk のカーネルは真偽を検証していない。";
  return [
    "/*",
    " * theme.css —— SmAIltalk のアプリのテーマ(V3-M1-T05 / ADR-0047)。",
    " *",
    " * 出所: このアプリのマニフェストの /app/theme/slots。",
    " *       get_manifest の出力の該当部分をそのまま写したものである",
    " *       (/app/theme がそのまま theme.json であり、変換層は1つも無い)。",
    origin,
    " *",
    " * 宣言名はマニフェストのスロット名そのものである(変換を1つも挟んでいない)。",
    " * スロットは有限で、増やすことはできない。",
    " *",
    " * ## これに含まれないもの(**当てても同じ描画にはならない**)",
    " *",
    // **V3-M5-T05(D-G5 / ADR-0055。Δ5)**: 旧文言は「置き場が未確定であり、現時点では
    // 逃げ道そのものが存在しない」だった。**V3-M5 で逃げ道が実在するようになったので偽である。**
    // **「含まれない」という本題は1ミリも変わっていない**(逃げ道の本文はマニフェストの外に
    // あり、この生成器はマニフェストの /app/theme しか読まない)ので、**理由だけを差し替える。**
    " * 1. 任意の CSS(逃げ道)。V3-M5 で入った owner 専用の資産であり(ADR-0055)、",
    " *    本文はマニフェストの外の content-addressed ストアにある。当たるのは画面ごとで、",
    " *    このアプリが逃げ道を使っているなら、これを当てても そのぶんの差は残る。",
    " * 2. SmAIltalk 側がスタイルシートに持っている6件 —— アプリ領域の要素で",
    " *    color / background-color / font-family / line-height を宣言し直す4件と、",
    " *    フォームコントロールに font-family: inherit / line-height: inherit を",
    " *    与える2件である。UA 既定はフォームコントロールに書体と行間を継がせない。",
    " * 3. プラットフォームシェル(アプリの外枠)の見た目。テーマの射程外である。",
    " * 4. テーマの対象外のスロット(アプリの外枠の幅・枠線の種別・",
    " *    フォーカスリングの線種)。",
    " *",
    " * したがって、これを :root に当てても SmAIltalk と同じ描画にはならない。",
    " * 担保できるのは形式の安定であって、別実装での見た目の一致ではない。",
    " */",
  ];
}

/**
 * テーマを `theme.css` の文字列にする(**この1本だけが生成器である**)。
 *
 * 値は**マニフェストの値そのまま**で、加工も既定値の補完もしない。値域
 * (色は16進・長さは px/rem/em 等)は適用時に `schemas/manifest.schema.json` の
 * `$defs/theme` が縛っているので、**ここで再検証しない** ——
 * `AppWorkspace` の `themeScopeStyle` と同じ判断である(検証を二重化すると規則が2箇所に住む)。
 */
export function buildThemeCss(theme: Theme): string {
  const lines = [...header(theme), ":root {"];
  for (const [slot, value] of sortedSlots(theme)) {
    lines.push(`  ${slot}: ${value};`);
  }
  lines.push("}", "");
  return lines.join("\n");
}

/** 生成物をクリップボードへ写すボタン(結果は文言で伝える)。 */
function CopyThemeCssButton({ css }: { css: string }): ReactNode {
  const [copied, setCopied] = useState<boolean | null>(null);

  return (
    <div className={cn("theme-export-copy", "flex-wrap")}>
      <Button
        size="sm"
        variant="secondary"
        data-testid="copy-theme-css"
        onClick={() => {
          // クリップボードは環境によって使えない(非セキュアコンテキストなど)。
          // 使えなかったことを黙って隠さず、失敗として出す(憲法6)。
          // 形は `RequirementsDocPanel` の `CopyMarkdownButton` と同一である。
          const clipboard = navigator.clipboard as Clipboard | undefined;
          if (clipboard === undefined) {
            setCopied(false);
            return;
          }
          void clipboard.writeText(css).then(
            () => setCopied(true),
            () => setCopied(false),
          );
        }}
      >
        theme.css をコピー
      </Button>
      {copied !== null && (
        <span
          className={cn("theme-export-copy-result", "text-note text-muted-foreground")}
          data-testid="copy-theme-css-result"
        >
          {copied ? "コピーしました。" : "コピーできませんでした。"}
        </span>
      )}
    </div>
  );
}

/**
 * 持ち出しの画面。
 *
 * **owner 限定にしない。** マニフェスト API は無認証(ローカル専用)で誰でも読めるので、
 * owner パネルに置くと「UI は owner 限定に見えるが API は誰でも叩ける」という、UI が
 * 嘘をつく状態になる(`RequirementsDocPanel` と同じ判断。ADR-0025 §10-2)。
 *
 * **第2の取得経路を作らない** —— テーマは `AppWorkspace` が既に取得したマニフェストの
 * 値をそのまま受け取る(ADR-0003 / D-4「マニフェストだけ読めば見た目が決まる」)。
 *
 * **【V3-M5-T05 / ADR-0055 で改訂】括弧の中の標語は、今日はテーマについてしか成り立たない。**
 * **V3-M5 で逃げ道(任意 CSS)が入り、画面に当たる見た目の一部がマニフェストの外
 * (owner 専用の content-addressed ストア)から来るようになった。** **本ファイルの判断
 * (第2の取得経路を作らない)は1バイトも変わらない** —— このパネルが持ち出すのはテーマだけで、
 * **逃げ道は持ち出さない**(だから下の生成物が「含まれないもの」としてそれを名指ししている)。
 */
export function ThemeExportPanel({
  theme,
  onClose,
}: {
  theme?: Theme | undefined;
  onClose?: () => void;
}): ReactNode {
  return (
    // **【V4-M15-T14】器を `Card` にした。`class="theme-export-css"`(`overflow-x: auto`)と
    // `class="theme-export-copy"` は1つも消していない** —— どちらも `web/src/styles.css` の
    // 当たり先である。**文言も `data-testid` も1バイトも変えていない。**
    <Card className={cn("theme-export")} data-testid="theme-export">
      <header
        className={cn("theme-export-header", "flex flex-wrap items-center justify-between gap-s2")}
      >
        <h3 className={cn("m-0")}>テーマの持ち出し</h3>
        {onClose !== undefined && (
          <Button size="sm" variant="secondary" data-testid="close-theme-export" onClick={onClose}>
            閉じる
          </Button>
        )}
      </header>

      <p
        className={cn("theme-export-preface", "m-0 text-note text-muted-foreground")}
        data-testid="theme-export-preface"
      >
        このアプリのマニフェストに入っているテーマを、CSS の形にして写せます。JSON の形で
        持ち出したいときは、get_manifest の出力の /app/theme をそのまま使ってください(変換は
        要りません)。どちらの形でも、任意の CSS(逃げ道)とプラットフォームの外枠の見た目は
        含まれないので、別の実装に当てても同じ見た目にはなりません。
      </p>

      {theme === undefined ? (
        <p
          className={cn("theme-export-empty", "m-0 text-muted-foreground")}
          data-testid="theme-export-empty"
        >
          このアプリはテーマを持っていません(既定の見た目で描画されています)。持ち出せる
          テーマはありません。
        </p>
      ) : (
        <>
          <CopyThemeCssButton css={buildThemeCss(theme)} />
          <pre
            className={cn(
              "theme-export-css",
              "m-0 rounded-ui border-[length:var(--border-width)] border-solid border-border bg-secondary p-s2 text-note",
            )}
            data-testid="theme-css"
          >
            {buildThemeCss(theme)}
          </pre>
        </>
      )}
    </Card>
  );
}
