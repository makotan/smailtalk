/**
 * 要件定義書の画面(V1-M8-T02 / ADR-0025 §10)。
 *
 * 憲法5 の「**changelog が要件定義書**」を、人間が実際に読める形で出す口である。
 * サーバの `GET /api/apps/:app_id/requirements?format=json` を叩き、返ってきた
 * `statements` を**節ごとに構造描画**する。各記述には必ず出典(マニフェストの
 * JSON Pointer、または changelog の seq / diff_id / Pointer)が並ぶ。
 *
 * ## この画面が持たないもの(ADR-0025 限定9)
 *
 * - **ロジックを持たない。** 文書の組み立て・節分け・文面はすべてカーネルの
 *   `generateRequirementsDoc` の出力そのままで、ここは並べ替えも書き換えもしない。
 * - **markdown をパースしない。ライブラリも足さない。** `markdown` はコピー用の
 *   文字列としてだけ持つ。構造は `statements` から描くので、パーサは1つも要らない。
 * - **カーネルからは型のみ import する**(`api.ts` 経由の再エクスポート)。値の
 *   import は `normalizeSort` の1件だけという ADR-0009 限定2 の不変条件を壊さない。
 *
 * ## owner 限定にしない(ADR-0025 §10-2)
 *
 * API は changelog / manifest と同列の**無認証(ローカル専用)**である。owner
 * パネルに置くと「UI は owner 限定に見えるが API は誰でも叩ける」という、UI が
 * 嘘をつく状態になる。したがって導線は `AppWorkspace` のビュー一覧と同じ階層に置く。
 *
 * **【`V17-M4-T02` による訂正。上の3行は1バイトも消していない】** **台帳 `AC-G20`** ——
 * **API はもう無認証ではない。** **3本(changelog / manifest / 要件定義書)が同列である
 * ことは今日も真で、その同列の位置が「無認証」から「ログインが要る」へ動いた。**
 * **owner 限定にしない判断は覆っていない** —— **掛かった関門は役割を1つも見ないので、
 * ログインしていれば誰でも読める。** **「UI が嘘をつく状態になる」も今日どおりである。**
 *
 * ## 【V4-M15-T14】部品体系で組み直した(`ADR-0087`)
 *
 * **文言も `data-testid` も1バイトも変えていない。** **`class` も1つも消していない** ——
 * `requirement-text`(`white-space: pre-wrap` の当たり先)/ `requirements-doc-preface` /
 * `requirement-sources` / `requirement-statements` / `requirements-copy` はすべて
 * `web/src/styles.css` の規則が当たっており、消すと逐語引用の改行が潰れる。
 * **部品のクラスは既存クラスに「足す」形でしか入れていない。**
 *
 * **足したのは、読み込み中の `Skeleton`(着手前 0件)と、器の `Card` / `Button` である。**
 */
import { useEffect, useState } from "react";
import {
  fetchRequirementsDoc,
  type RequirementSection,
  type RequirementStatement,
  type RequirementsDocResponse,
  type StatementSource,
} from "./api.ts";
import { type AsyncState, toValidationErrors } from "./async.ts";
import { ErrorList } from "./ErrorList.tsx";
import { Button } from "./ui/button.tsx";
import { Card, Skeleton } from "./ui/surfaces.tsx";
import { cn } from "./ui/utils.ts";

/**
 * 節の表示名と並び順(ADR-0025 §7 の6つ)。**カーネルの節分類そのもの**なので、
 * 増えることはない —— 増やすには ADR-0025 の改訂(門A)が要る。
 *
 * `Record<RequirementSection, string>` はキーの過不足をどちらもコンパイルエラーに
 * するので、カーネルの union が動けばここが必ず赤くなる。
 */
const SECTION_LABELS: Record<RequirementSection, string> = {
  overview: "概要",
  features: "機能一覧",
  screens: "画面",
  data: "データ",
  automation: "自動化",
  history: "履歴",
};

const SECTION_ORDER = Object.keys(SECTION_LABELS) as RequirementSection[];

/**
 * 出典1件の表示文字列。
 *
 * **どこを見ればこの記述の根拠に辿り着けるか**を、そのまま読める形で出す
 * (マニフェストなら JSON Pointer、changelog なら seq と diff_id と Pointer)。
 * 値は API 応答のものをそのまま連結するだけで、解釈も要約もしない。
 */
function sourceLabel(source: StatementSource): string {
  const pointer = source.pointer === "" ? "(全体)" : source.pointer;
  if (source.kind === "manifest") {
    return `マニフェスト ${pointer}`;
  }
  return `変更履歴 seq ${source.seq} / ${source.diff_id} ${pointer}`;
}

/**
 * 出典に描画用の鍵を付ける。
 *
 * **出典は同じ値の重複を許す**(同じ操作が2度出典になりうる)ので、値そのものからは
 * 一意な鍵を作れない。この配列は API 応答そのままで並べ替えも挿入もされないため、
 * 記述ID + 位置が安定した識別子になる。
 */
function keyedSources(statement: RequirementStatement): { key: string; source: StatementSource }[] {
  return statement.sources.map((source, position) => ({
    key: `${statement.id}-${position}`,
    source,
  }));
}

/** 記述1件(本文 + 出典欄)。**出典欄が空になる経路はこの画面に存在しない。** */
function StatementItem({ statement }: { statement: RequirementStatement }) {
  return (
    <li
      className={cn("requirement-statement", "flex flex-col gap-s1")}
      data-testid="requirement-statement"
      data-statement-id={statement.id}
      data-template={statement.template}
    >
      {/* 逐語引用は改行を含むので、そのまま出す(白空白は CSS で保つ)。 */}
      <p className={cn("requirement-text", "m-0")} data-testid="requirement-text">
        {statement.text}
      </p>
      {/*
       * **`display` を1つも足さない。** `.requirement-sources` は既存の CSS で
       * 箇条書きの記号(`list-item`)を保っており、`flex` にすると記号が消える。
       */}
      <ul className={cn("requirement-sources")} data-testid="requirement-sources">
        {keyedSources(statement).map(({ key, source }) => (
          <li
            key={key}
            className={cn("requirement-source", "text-note text-muted-foreground")}
            data-testid="requirement-source"
            data-source-kind={source.kind}
          >
            {sourceLabel(source)}
          </li>
        ))}
      </ul>
    </li>
  );
}

/** 節1つ。該当する記述が無い節も、無いと明示して出す(黙って消さない)。 */
function SectionBlock({
  section,
  statements,
}: {
  section: RequirementSection;
  statements: RequirementStatement[];
}) {
  return (
    <section
      className={cn("requirement-section", "flex flex-col gap-s1")}
      data-testid="requirement-section"
      data-section={section}
    >
      <h4 className={cn("m-0")}>{SECTION_LABELS[section]}</h4>
      {statements.length === 0 ? (
        <p
          className={cn("requirement-section-empty", "m-0 text-muted-foreground")}
          data-testid="requirement-section-empty"
        >
          この節に該当する記述はありません。
        </p>
      ) : (
        <ul className={cn("requirement-statements", "flex flex-col gap-s2")}>
          {statements.map((statement) => (
            <StatementItem key={statement.id} statement={statement} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** markdown 全文をクリップボードへ写すボタン(結果は文言で伝える)。 */
function CopyMarkdownButton({ markdown }: { markdown: string }) {
  const [copied, setCopied] = useState<boolean | null>(null);

  return (
    <div className={cn("requirements-copy", "flex-wrap")}>
      <Button
        size="sm"
        variant="secondary"
        data-testid="copy-requirements-markdown"
        onClick={() => {
          // クリップボードは環境によって使えない(非セキュアコンテキストなど)。
          // 使えなかったことを黙って隠さず、失敗として出す(憲法6)。
          const clipboard = navigator.clipboard as Clipboard | undefined;
          if (clipboard === undefined) {
            setCopied(false);
            return;
          }
          void clipboard.writeText(markdown).then(
            () => setCopied(true),
            () => setCopied(false),
          );
        }}
      >
        Markdown をコピー
      </Button>
      {copied !== null && (
        <span
          className={cn("requirements-copy-result", "text-note text-muted-foreground")}
          data-testid="copy-result"
        >
          {copied ? "コピーしました。" : "コピーできませんでした。"}
        </span>
      )}
    </div>
  );
}

export function RequirementsDocPanel({ appId, onClose }: { appId: string; onClose?: () => void }) {
  const [state, setState] = useState<AsyncState<RequirementsDocResponse>>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    fetchRequirementsDoc(appId).then(
      (value) => {
        if (!cancelled) {
          setState({ status: "ready", value });
        }
      },
      (reason: unknown) => {
        if (!cancelled) {
          setState({ status: "error", errors: toValidationErrors(reason) });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [appId]);

  return (
    <Card className={cn("requirements-doc")} data-testid="requirements-doc">
      <header
        className={cn(
          "requirements-doc-header",
          "flex flex-wrap items-center justify-between gap-s2",
        )}
      >
        <h3 className={cn("m-0")}>要件定義書</h3>
        {onClose !== undefined && (
          <Button
            size="sm"
            variant="secondary"
            data-testid="close-requirements-doc"
            onClick={onClose}
          >
            閉じる
          </Button>
        )}
      </header>

      {/*
       * **この文書が何であるかを、読む前に伝える。** 生成に AI は関与せず、
       * すべての記述が出典を持つ —— それがこの画面の主張そのものである。
       */}
      <p
        className={cn("requirements-doc-preface", "m-0 text-note")}
        data-testid="requirements-preface"
      >
        この文書は、アプリのマニフェストと変更履歴だけから機械的に生成したものです。すべての記述に出典が付きます。
      </p>

      {state.status === "loading" && (
        // **文言は1文字も変えていない。骨組みを3本足しただけである**(V4-M15-T14)。
        <div className={cn("flex flex-col gap-s2")}>
          <p className={cn("m-0", "text-note text-muted-foreground")}>読み込み中…</p>
          {["head", "body-1", "body-2"].map((slot) => (
            <Skeleton key={slot} className="h-4 w-full" />
          ))}
        </div>
      )}
      {state.status === "error" && <ErrorList errors={state.errors} />}
      {state.status === "ready" && (
        <>
          <CopyMarkdownButton markdown={state.value.markdown} />
          {SECTION_ORDER.map((section) => (
            <SectionBlock
              key={section}
              section={section}
              statements={state.value.statements.filter(
                (statement) => statement.section === section,
              )}
            />
          ))}
        </>
      )}
    </Card>
  );
}
