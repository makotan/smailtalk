/**
 * 既にある見た目の資産の取り込み口(V3-M6-T02 / D-G9。**判定 = 門A / 将来送り**)。
 *
 * 判定の正は `docs/adr/0007-vocabulary-governance.md` §8 の 2026-07-30 の `D-G9` の行、
 * 審査の正は `docs/plan/v3/records/v3-m6-gate-a.md` §4 と **§8-1(越えてはならない線12点)**、
 * 完了条件の正は `docs/plan/v3/records/v3-m6.md` §2 の「V3-M6-T02」節(10点)である。
 *
 * ## 何をする画面か
 *
 * **owner が取り込み提案(25スロットの JSON)を貼り、当たった姿を見てから適用する**だけである。
 * 貼るものを作るのは**会話側 AI か owner**であって、この製品ではない —— **カーネルもサーバも
 * 外部を1バイトも取得しない**(線1。`src/mcp/vocabulary.ts` の `CANNOT_DO` を嘘にしない)。
 *
 * 適用は**既存の `applyThemeDiff`**(`web/src/api.ts`)= `POST /api/apps/:app_id/diffs` に
 * `set_theme` 1操作を送るだけである。**専用のエンドポイントも新しい差分操作も作っていない**
 * ので、`dry_run` / `_changelog` / `undo` / `redo` / スナップショットはそのまま効く。
 *
 * ## 【最重要】owner 確認は構造の担保ではない(完了条件4)
 *
 * **書けるのは3文である。1文に丸めてはならない**(審査本体
 * `docs/plan/v3/records/v3-m6-gate-a-import.md` §3 問1 (c) の逐語):
 *
 * > **(1) AI は今日も `apply_diff` で `set_theme` を直接書ける。**
 * >     **本マイルストーンはその経路を1本も塞がない。**
 * > **(2) owner 確認 UI は編集上の関門であって、構造の担保ではない。** 担保しているのは
 * >     `127.0.0.1` バインドだけであり、それは v0 からの状態で、本マイルストーンはそれを
 * >     1ミリも直さない。
 * > **(3) 構造で言えることは1つだけある** —— **コントラスト検査**
 * >     (`src/kernel/theme-contrast.ts`。`purpose === "incoming"` で fail-closed)。
 * >     **「読めない配色を取り込むことはできない」は言える。「正しい配色を取り込める」は
 * >     言えない。**
 *
 * **実測(V3-M6-T02 が自分で測った。実施記録 `v3-m6-t02.md` §4)**: この画面が叩く
 * `POST /api/apps/:app_id/diffs` に `set_theme` を投げると、**cookie 無し(未認証)/ viewer /
 * customer / editor の4通りとも `201` で書けた。** 同じ実測の対照として、
 * 逃げ道の発行(`POST /escape-hatch-assets`)は viewer で `403` になる。
 * **V3-M5 の逃げ道(`requireOwner` + 経路の不在)とは担保の質が違う** —— あちらはサーバが
 * 拒否し、こちらは誰でも通る。**この画面の owner 限定は先回りにすぎない。**
 *
 * ## web 側にコントラスト検査の写しを作らない(線10)
 *
 * **プレビューは検査ではない。** 落ちる配色でもプレビューは描く —— 判定を web にも置くと
 * 同じ規則が2箇所に住み、片方だけが古くなる(`ThemeExportPanel` / `themeScopeStyle` が
 * 値域の再検証をしないのと同じ判断)。**拒否するのはサーバの1箇所だけで、拒否は全か無かである**
 * (ADR-0047 限定9)。**迂回路も、警告だけで通す道も1本も作っていない。**
 *
 * ## `theme.json` を出す口をここに置かない(線9)
 *
 * **入口を作っても、出口に JSON の口は足さない。** 理由4点は審査本体 §4-2 にある(要旨:
 * `theme.json` は `get_manifest` の出力**そのもの**であり、画面に口を置くと変換層が1本生まれ、
 * それは `D-G3b` の再審査条件 (d) が正面から禁じている)。**owner が JSON を取るには
 * `get_manifest` か `GET /api/apps/:app_id/manifest` を使う** —— 不便を残す判断である。
 *
 * ## 新しいレンダラーを作らない(完了条件2)
 *
 * プレビューは**製品と同じ `AppThemeScope`**(`web/src/AppWorkspace.tsx`。スロットを
 * inline style へ写す恒等写像 `themeScopeStyle` を内側で使う)と**製品と同じ `ViewHost`** で
 * 描く。**変換規則の2本目を作らない** —— 作るとプレビューと本番で当たり方が割れる。
 */
import { type ReactNode, useState } from "react";
import type { Manifest, Theme, View } from "../../src/kernel/types.ts";
import { AppThemeScope } from "./AppWorkspace.tsx";
import { applyThemeDiff, type ValidationError } from "./api.ts";
import { toValidationErrors } from "./async.ts";
import { ErrorList } from "./ErrorList.tsx";
// **候補集合(`THEME_CANDIDATES`)には結線しない**(線8)。ここで借りるのは差分IDの後半を
// 採る関数1本だけで、候補の表には1バイトも触らない(機械的な固定は
// `web/test/theme-import-panel.test.tsx` の「線8」のテスト)。
import { newDiffSuffix } from "./theme-candidates.ts";
import { Button } from "./ui/button.tsx";
import { Label, Textarea } from "./ui/form-controls.tsx";
import { Card } from "./ui/surfaces.tsx";
import { cn } from "./ui/utils.ts";
import { ViewHost } from "./views/ViewHost.tsx";

/** 貼られた文字列を読んだ結果。**読めなければ理由を返す**(黙って落とさない)。 */
export type ParsedImport = { ok: true; theme: Theme } | { ok: false; errors: ValidationError[] };

function failure(message: string, path = "", hint?: string): ParsedImport {
  const error: ValidationError = { path, message };
  if (hint !== undefined) {
    error.hint = hint;
  }
  return { ok: false, errors: [error] };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 由来(`origin`)を読む。**省略できる。**
 *
 * **カーネルは真偽を1つも検証しない**(ADR-0047 限定7)—— 実在しないアプリIDでも通る。
 * したがってここで確かめられるのは**形**だけである。形が読めないものは通さない(fail-closed)。
 */
function readOrigin(value: unknown): { ok: true; origin?: Theme["origin"] } | { ok: false } {
  if (value === undefined) {
    return { ok: true };
  }
  if (!isPlainObject(value) || typeof value.template_app_id !== "string") {
    return { ok: false };
  }
  const origin: NonNullable<Theme["origin"]> = { template_app_id: value.template_app_id };
  if (value.template_diff_id !== undefined) {
    if (typeof value.template_diff_id !== "string") {
      return { ok: false };
    }
    origin.template_diff_id = value.template_diff_id;
  }
  return { ok: true, origin };
}

/**
 * 貼られた文字列を {@link Theme} として読む。
 *
 * **受け取る形は2つあるが、違いはラッパの有無だけである**(値を1バイトも加工しない):
 *
 * 1. **25スロットの JSON**(会話側 AI が資産から組み立てて渡す形)。
 * 2. **`{ "slots": … , "origin"?: … }`**(= `get_manifest` の出力の `/app/theme` そのまま)。
 *
 * **スロット名・件数・値域・コントラストは1つも見ない。** それは
 * `schemas/manifest.schema.json` の `$defs/theme`(全キー `required` /
 * `additionalProperties: false` / `pattern`)と `src/kernel/theme-contrast.ts` の担当であり、
 * **web に写しを作ると規則が2箇所に住む**(線10)。ここで見るのは
 * **「プレビューを描くために最低限必要な形」**、すなわち「オブジェクトであること」と
 * 「値が文字列であること」だけである。
 */
export function parseImportedTheme(text: string): ParsedImport {
  const trimmed = text.trim();
  if (trimmed === "") {
    return failure(
      "取り込み提案が貼り付けられていません。25スロットの JSON を貼り付けてください。",
      "",
      "スロットの一覧と値の形は get_manifest の出力の /app/theme と同じです。",
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch (reason) {
    return failure(
      `貼り付けられた内容が JSON として読めません: ${reason instanceof Error ? reason.message : String(reason)}`,
      "",
      "先頭と末尾の { } が揃っているか、末尾に余分なカンマが無いかを確かめてください。",
    );
  }

  if (!isPlainObject(raw)) {
    return failure(
      "取り込み提案は JSON のオブジェクトである必要があります(配列やそれ以外の値は受け取れません)。",
    );
  }

  // ラッパの有無を見分ける。25スロットの名前はすべて `--` で始まるので、`slots` キーの
  // 有無で一意に決まる(**中間表現を作っているのではない。置き場も1つも作っていない**。線3)。
  const wrapped = "slots" in raw;
  const slotsSource = wrapped ? raw.slots : raw;
  if (!isPlainObject(slotsSource)) {
    return failure(
      "slots の中身が JSON のオブジェクトではありません。",
      "/app/theme/slots",
      "25スロットの名前と値の組を書いてください。",
    );
  }

  const errors: ValidationError[] = [];
  const slots: Record<string, string> = {};
  for (const [name, value] of Object.entries(slotsSource)) {
    if (typeof value !== "string") {
      errors.push({
        path: `/app/theme/${name}`,
        message: `スロット ${name} の値が文字列ではありません(受け取ったのは ${typeof value})。`,
        hint: '行間や太さのような数も、JSON では文字列として書きます(例: "1.7")。',
      });
      continue;
    }
    slots[name] = value;
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const origin = readOrigin(wrapped ? raw.origin : undefined);
  if (!origin.ok) {
    return failure(
      "origin(由来)の形が読めません。template_app_id を文字列で書いてください。",
      "/app/theme/origin",
      "origin は省略できます。カーネルはこの内容の真偽を検証しません(自己申告です)。",
    );
  }

  const theme: Theme = { slots };
  if (origin.origin !== undefined) {
    theme.origin = origin.origin;
  }
  return { ok: true, theme };
}

/**
 * 取り込みの `intent`(憲法5)。
 *
 * **これは人間の意図ではない。** ブラウザが自動で組み立てた定型文であり、そう自ら書く
 * (`web/src/theme-candidates.ts` の `themeCandidateIntent` と同じ作法)。
 *
 * **資産(ブランドガイド・スクリーンショット)を指す情報は1バイトも入らない** ——
 * カーネルは資産を1度も読んでおらず、`origin` の2キーはどちらもアプリ内の ID を指す形しか
 * 持たない(ファイルを指す由来の書き方は今日1つも無い。T01 の限界3)。
 */
function themeImportIntent(): string {
  return (
    "取り込みの画面で、owner が貼り付けた25スロットの提案をプレビューで確認して適用した。" +
    "この文はブラウザが自動で組み立てた定型文であり、人間が書いた意図ではない。" +
    "どの資産のどこから取った値かは、この差分には残らない。"
  );
}

/** 貼られたテーマを適用するための差分1件(**普通の差分である**)。 */
export function themeImportDiff(theme: Theme, suffix: string) {
  return {
    diff_id: `theme-import-${suffix}`,
    intent: themeImportIntent(),
    operations: [{ op: "set_theme", theme }] as const,
  };
}

/** 適用が成功したときに画面へ出す内容。 */
type AppliedState = { diffId: string };

export function ThemeImportPanel({
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
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<Theme | null>(null);
  const [errors, setErrors] = useState<ValidationError[] | null>(null);
  const [applied, setApplied] = useState<AppliedState | null>(null);
  const [busy, setBusy] = useState(false);

  const view = views.find((candidate) => candidate.id === viewId) ?? views[0];

  /** 貼り直したらプレビューと結果を捨てる(**見たものと違うものを当てない**)。 */
  function edit(next: string): void {
    setText(next);
    setPreview(null);
    setErrors(null);
    setApplied(null);
  }

  function showPreview(): void {
    const parsed = parseImportedTheme(text);
    setApplied(null);
    if (!parsed.ok) {
      setPreview(null);
      setErrors(parsed.errors);
      return;
    }
    setErrors(null);
    setPreview(parsed.theme);
  }

  function apply(theme: Theme): void {
    setBusy(true);
    setApplied(null);
    setErrors(null);
    // 差分IDは押すたびに新しく採る(同一ミリ秒の連打で衝突しない)。
    applyThemeDiff(appId, themeImportDiff(theme, newDiffSuffix())).then(
      ({ diffId }) => {
        setApplied({ diffId });
        setBusy(false);
      },
      (reason: unknown) => {
        // **黙って落ちない。** サーバ(= カーネル)が書いた理由をそのまま出す ——
        // コントラスト検査に落ちた対と、直し方(hint)がここに出る。
        setErrors(toValidationErrors(reason));
        setBusy(false);
      },
    );
  }

  return (
    // **【V4-M15-T14】器を `Card` にした。文言も `data-testid` も1バイトも変えていない。**
    <Card className={cn("theme-import")} data-testid="theme-import">
      <header
        className={cn("theme-import-header", "flex flex-wrap items-center justify-between gap-s2")}
      >
        <h3 className={cn("m-0")}>テーマの取り込み</h3>
        {onClose !== undefined && (
          <Button size="sm" variant="secondary" data-testid="close-theme-import" onClick={onClose}>
            閉じる
          </Button>
        )}
      </header>

      {/*
       * **画面にも同じことを書く(完了条件4)。** ここで「owner だけが見た目を変えられます」と
       * 書くと UI が嘘をつくことになる —— 実測で誰でも書けるからである。
       */}
      <p
        className={cn("theme-import-preface", "m-0 text-note text-muted-foreground")}
        data-testid="theme-import-preface"
      >
        取り込み提案(25スロットの JSON)を貼り付けて、プレビューで当たった姿を見てから適用します。
        資産(ブランドガイドやスクリーンショット)を読むのは、この製品ではなく会話相手の AI か
        あなた自身です —— SmAIltalk が外部のファイルや URL を取りに行くことはありません。
        なお、この画面は AI の書き込み経路を塞いでいません。AI は apply_diff の set_theme で
        直接テーマを書けますし、テーマを書く HTTP 経路は今日も認証を要求しません。ここで
        構造として言えるのは「コントラスト比の閾値を下回る配色は適用できない」ことだけで、
        「取り込んだ配色が正しい」ことは誰も検査していません。
      </p>

      {/*
       * **貼り付け欄はラベルと紐づける**(完了条件8 の最低線)。`htmlFor` / `id` の対で
       * 結ぶので、ラベルを押しても欄に入れるし、支援技術からも名前が読める。
       * **体系的な保証は行わない**(01 §1 スコープ外)。
       *
       * **ファイル選択の口は1つも置かない**(線2)—— 置くと「資産のファイルを製品に読ませる」
       * 形になり、`image` 型を抽出の入力にしないという線と紛れる。貼るのは文字だけである。
       */}
      <div className={cn("theme-import-field", "flex flex-col gap-s1")}>
        <Label htmlFor="theme-import-json">取り込み提案(25スロットの JSON)</Label>
        <Textarea
          id="theme-import-json"
          data-testid="theme-import-json"
          rows={10}
          value={text}
          onChange={(event) => edit(event.target.value)}
        />
      </div>

      <div
        className={cn("theme-import-actions", "flex flex-col gap-s2 sm:flex-row sm:items-center")}
      >
        <Button
          variant="secondary"
          className="w-full sm:w-auto"
          data-testid="preview-theme-import"
          onClick={showPreview}
        >
          プレビューする
        </Button>
        {preview !== null && (
          <Button
            className="w-full sm:w-auto"
            data-testid="apply-theme-import"
            disabled={busy}
            onClick={() => apply(preview)}
          >
            このテーマにする
          </Button>
        )}
      </div>

      {errors !== null && <ErrorList errors={errors} />}
      {/*
       * **適用できたことを、枠のある器で出す**(`03` §4-1 の実測では成功表示は着手前 0件)。
       * **文言も `data-testid` も1バイトも変えていない。**
       *
       * **`Alert` を使っていない** —— `Alert` は `role="alert"` を持ち、それは支援技術に
       * 割り込む読み上げになる。**本タスクは読み上げの割り込みを1つも増やさない**
       * (`aria-live` を足さない、という規律の同じ側)。**足したのは枠と余白だけである。**
       */}
      {applied !== null && (
        <p
          className={cn(
            "theme-import-result",
            "m-0 rounded-ui border-[length:var(--border-width)] border-solid border-border p-s2 text-note",
          )}
          data-testid="theme-import-result"
        >
          取り込みました(差分ID: {applied.diffId})。この画面の外側に反映するには再読み込みして
          ください。取り消しはこの画面ではできません —— 変更履歴の undo で戻します。
        </p>
      )}

      {preview !== null &&
        (view === undefined ? (
          <p
            className={cn("theme-import-empty", "m-0 text-muted-foreground")}
            data-testid="theme-import-preview-empty"
          >
            当てて見せられる画面がありません。テーマは画面の中身に当たるものなので、画面が1つも
            無いあいだは見比べるものがありません(適用そのものはできます)。
          </p>
        ) : (
          /*
           * **製品と同じスコープ要素・同じ `ViewHost` である**(完了条件2)。
           * `data-testid` を差し替えているのは、**製品のスコープ要素は常に1つだけ**という
           * 既存の実測(`web/e2e/theme.e2e.ts` (iii))をこの画面が壊さないためである。
           *
           * **代償**: 枠を1つ描くぶん、その画面ぶんの API 呼び出しがそのまま増える
           * (`ThemePreviewPanel` が候補の数だけ増やしたのと同型。打ち消していない)。
           */
          <AppThemeScope theme={preview} testId="theme-import-preview">
            <h4>プレビュー(まだ適用していません)</h4>
            <p className="theme-import-note">
              この枠の中はこのアプリの実データです。枠の外(プラットフォームの外枠)には
              テーマは当たりません。
            </p>
            <ViewHost appId={appId} manifest={manifest} view={view} />
          </AppThemeScope>
        ))}
    </Card>
  );
}
