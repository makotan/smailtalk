/**
 * `V4-M13` / `V4-M17` の**見た目の計測器**(`D-V4-14` / `D-V4-26` / `D-V4-27`)。**テストではない。**
 *
 * ## なぜ在るのか
 *
 * `D-V4-14`(ユーザ決定。逐語は `03` §2-1a): **「着手前と後を全画面計測し、変化を全件記録する。
 * 合格ラインは置かない」**。**閾値を置かないことは「測らない」ことではない** —— **変化を全件
 * 出せる形にすること自体が充足条件である。** そのため本スクリプトは、
 *
 * - **合否を1つも判定しない**(`throw` するのは計測が成立しなかったときだけ)。
 * - **値をそのまま JSON に落とす**(丸めない・間引かない)。
 *
 * 対象は **`D-V4-26` により参照ショップ(`scripts/ref-ec/`)だけ**である。
 * **実地インスタンス `data/apps/ichishioya` は測らない。**
 * **スクリーンショットは `D-V4-27` により残すが、判定には1枚も使わない。**
 *
 * ## 転用元と、変えたところ
 *
 * 骨格は `scripts/cp-v3/t02-probe.ts`(v3 の `CP-V3` の計測器)である。**元ファイルは1バイトも
 * 触っていない**(v3 のエビデンスの再現性を壊さないため)。04 §3-14b が挙げた「転用を阻む
 * 実測事実4件」に対して、本スクリプトは次のように作り替えた:
 *
 * | 04 §3-14b の阻害 | 本スクリプトの対処 |
 * |---|---|
 * | (1) 測る先のアプリがディスク上に無い | `V4-M1-T00` が `scripts/ref-ec/serve.ts` を作った。本スクリプトは**起動済みのサーバに繋ぐだけ**である |
 * | (2) 画面一覧が決め打ちで19本が404になる | **`GET /api/apps/ref-ec/manifest` を読んで画面を機械的に生成する。** ビューが増減しても追随する(`D-V4-23` で2本増えたことも自動で拾う) |
 * | (3) 差分計算スクリプトが無い | 別ファイル `scripts/cp-v4/t13-diff.ts` に置いた |
 * | (4) セレクタが置き換え対象の DOM に依存している | **1つの計測点に複数のセレクタ候補を宣言し、当たった順に採る。** どれが当たったかを `matchedSelector` として記録に残すので、着手後に当たり先が変わったこと自体が差分に出る |
 *
 * ## 使い方(着手前も着手後もこの1本)
 *
 * ```
 * # 1) 参照ショップを起動する(別プロセス。ポート 3211)
 * mise exec -- bun run serve:ref-ec
 *
 * # 2) 計測する(--label を before / after で使い分ける)
 * #    **`--out-dir` は必須である**(V9-M3-T01。既定で docs/ へ書かない)。
 * mise exec -- bun run apps/smailtalk/scripts/cp-v4/t13-probe.ts \
 *     --label before --out-dir docs/evidence/cp-v4-ui
 * mise exec -- bun run apps/smailtalk/scripts/cp-v4/t13-probe.ts \
 *     --label after --out-dir docs/evidence/cp-v4-ui
 *
 * # 3) 変化を全件出す
 * mise exec -- bun run apps/smailtalk/scripts/cp-v4/t13-diff.ts \
 *     docs/evidence/cp-v4-ui/t13-measurements-before.json \
 *     docs/evidence/cp-v4-ui/t13-measurements-after.json \
 *     docs/evidence/cp-v4-ui/t13-changes.json
 * ```
 *
 * > **【2026-08-04 追記(`V4-M52` / ユーザ決定 `D-V4-178`)】** **上の「# 3」が入力に名指ししている
 * > `docs/evidence/cp-v4-ui/t13-measurements-before.json` と `t13-measurements-after.json` は、
 * > `V4-M30`(ユーザ決定 `D-V4-112`)が 2026-08-04 に作業ツリーから削除した**(削除コミット
 * > **`7e3738b`**)。**したがって上の「# 3」は、今日そのまま貼っても入力ファイルが無くて走らない。**
 * > **今日の `docs/evidence/cp-v4-ui/` に実在するのは `t13-changes.json` /
 * > `t18-bundle-size-v4-m17.json` / `t19-a11y.json` の3本だけである**(2026-08-04 実測)。
 * > **今日の正**: **変化の全件は `docs/evidence/cp-v4-ui/t13-changes.json` に残っている**
 * > (`docs/evidence/cp-v4-ui.md` §2-15)。**集計は `docs/plan/v4/records/v4-m13-baseline.md` §3 と
 * > `docs/plan/v4/records/v4-m17-measure.md` §4 に在る。**
 * > **削除後に生値を取り出す手順**: `git show f9c9eef:docs/evidence/cp-v4-ui/t13-measurements-before.json`
 * > (3,942,532 B)/ `git show cd073bf:docs/evidence/cp-v4-ui/t13-measurements-after.json`
 * > (4,306,734 B)。**取り出しの実測と経緯は `docs/plan/v4/records/v4-m30.md` §4 に在る。**
 * > **「# 1」「# 2」は今日もそのまま走る** —— 本スクリプトを走らせれば `--out-dir` に生値が作り直される。
 * > **本追記はコメントだけであり、本スクリプトの動作を1バイトも変えていない。**
 * >
 * > **【2026-08-17 追記(`V9-M3-T01`。群D)】** **上の一文が言っていた「`--out-dir` の既定は
 * > `docs/evidence/cp-v4-ui` のままである」は、今日はもう成り立たない。** `V9-M2` が
 * > 器を `apps/smailtalk/scripts/` へ移した一方で `docs/` は正本のルートに残ったため、
 * > **既定値を撤去して `--out-dir` を必須にした。** 上のコマンド例には既に付けてある。
 *
 * | 引数 | 既定 | 意味 |
 * |---|---|---|
 * | `--label <名前>` | (必須) | 出力ファイル名に入る名前。`before` / `after` |
 * | `--base-url <URL>` | `http://localhost:3211` | 参照ショップの所在。**`localhost` にすること** |
 * | `--out-dir <パス>` | (必須。`V9-M3-T01` が既定を撤去した) | JSON の置き場(**git に入れる**) |
 * | `--shots-dir <パス>` | `data-cp-v4-ui-shots` | PNG の置き場(**`.gitignore` の `data-*` パターン に掛かる = git に入らない**) |
 * | `--no-shots` | (未指定) | 付けるとスクリーンショットを撮らない |
 * | `--widths <数,数>` | `1280,390` | 計測する画面幅(px)。`D-V4-44`(スマホ対応を v4 でやる)により**複数幅で測る** |
 *
 * ## 何を測るか / 測らないか(誇張しない)
 *
 * - 測る: **本物の chromium の計算後スタイル**(`getComputedStyle` の 63プロパティ)/ 実寸
 *   (`getBoundingClientRect`)/ 当たった要素の個数・タグ・クラス・全属性・テキスト長 /
 *   画面直下の DOM の並び / 一覧の行のホバー中の値 / フォームの先頭入力欄のフォーカス中の値 /
 *   ページ全体の横スクロールの有無(`scrollWidth` 対 `clientWidth`)。
 * - 測らない: **色の見え方の良し悪し**(判定しない)/ **スクリーンショットの中身**
 *   (撮るだけで読まない。`D-V4-27`)/ **Linux の chromium での値**(ここで動かすのは
 *   このマシンの chromium である)/ **実地インスタンス**(`D-V4-26` で対象外)。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { REF_EC_CUSTOMER, REF_EC_OWNER } from "../ref-ec/serve.ts";

// --- 引数 ---------------------------------------------------------------------

type Options = {
  label: string;
  baseUrl: string;
  outDir: string;
  shotsDir: string;
  shots: boolean;
  widths: number[];
};

// **`DEFAULT_OUT_DIR` は在った所から撤去した**(`V9-M3-T01`。群D)。
//
// 旧: `export const DEFAULT_OUT_DIR = "docs/evidence/cp-v4-ui";`
// **`V9-M1` / `V9-M2` が製品と器を `apps/smailtalk/` へ移したが、`docs/` は正本のルートに
// 残る** —— 公開単位(`apps/smailtalk/`)の中の計測器が、既定値だけで公開単位の外へ書く
// 形になる。**書き先は `--out-dir` で名指しさせる**(下の `parseArgs` が必須にしている)。
// **撤去であって移設ではない**(どこへ書くべきかは呼ぶ側が決める)。

/** 既定の PNG 置き場。**`.gitignore` の `data-*` パターン に掛かる名前でなければならない。** */
export const DEFAULT_SHOTS_DIR = "data-cp-v4-ui-shots";
/** 既定の計測幅。広い方は v3 と同じ 1280、狭い方はスマホ相当の 390(`D-V4-44`)。 */
export const DEFAULT_WIDTHS = [1280, 390] as const;
/** 既定の所在。`127.0.0.1` にしない(Origin 検査で POST が全部 403 になる)。 */
export const DEFAULT_BASE_URL = "http://localhost:3211";
/** 参照ショップのアプリ ID。 */
const APP_ID = "ref-ec";

export function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    label: "",
    baseUrl: DEFAULT_BASE_URL,
    outDir: "",
    shotsDir: DEFAULT_SHOTS_DIR,
    shots: true,
    widths: [...DEFAULT_WIDTHS],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--label":
        options.label = next ?? "";
        i += 1;
        break;
      case "--base-url":
        options.baseUrl = next ?? options.baseUrl;
        i += 1;
        break;
      case "--out-dir":
        options.outDir = next ?? options.outDir;
        i += 1;
        break;
      case "--shots-dir":
        options.shotsDir = next ?? options.shotsDir;
        i += 1;
        break;
      case "--widths":
        options.widths = (next ?? "")
          .split(",")
          .map((piece) => Number(piece.trim()))
          .filter((value) => Number.isInteger(value) && value > 0);
        i += 1;
        break;
      case "--no-shots":
        options.shots = false;
        break;
      default:
        throw new Error(`知らない引数です: ${arg}`);
    }
  }
  if (options.label === "") {
    throw new Error(
      "usage: t13-probe.ts --label <before|after> --out-dir DIR [--base-url URL] [--shots-dir DIR] [--no-shots] [--widths 1280,390]",
    );
  }
  // **`--out-dir` は必須である**(`V9-M3-T01`)。**既定で公開単位の外(`docs/`)へ書かない。**
  if (options.outDir === "") {
    throw new Error(
      "--out-dir は必須です(書き先を黙って決めません)。例: --out-dir docs/evidence/cp-v4-ui",
    );
  }
  if (options.widths.length === 0) {
    throw new Error("--widths に有効な数値が1つもありません。");
  }
  return options;
}

// --- 計測するプロパティ ----------------------------------------------------------

/**
 * 計算後の値を採る CSS プロパティ(**63件**)。
 *
 * v3 の `t02-probe.ts` の48件を出発点に、**15件を足した**。足した理由は `V4-M13` の審査単位が
 * 名指ししている欠落を、着手前の値として先に残しておくためである:
 *
 * - `transition-property` / `transition-duration` / `animation-name`(**3件**) —— `P-G13`
 *   (変化が瞬間的で追えない)の着手前の値。
 * - `border-right-width` / `border-left-width` / `border-top-color` / `border-collapse` /
 *   `border-spacing`(**5件**) —— `P-G34`(宣言の完全一致固定)と境界線の実態。
 * - `letter-spacing` / `text-transform` / `font-variant-numeric`(**3件**) —— 書体まわり。
 * - `align-items` / `justify-content` / `box-sizing`(**3件**) —— 余白と器の実態。
 * - `background-image`(**1件**) —— 地の模様・図の有無。
 *
 * **3 + 5 + 3 + 3 + 1 = 15。48 + 15 = 63 である**(実際に数えた)。
 *
 * **【禁止】この集合を着手後に変えないこと。** 変えると「変化した点」の分母が動く。
 */
export const PROPS = [
  "color",
  "background-color",
  "background-image",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-variant-numeric",
  "letter-spacing",
  "text-transform",
  "line-height",
  "text-align",
  "text-decoration-line",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-top-color",
  "border-bottom-color",
  "border-bottom-style",
  "border-radius",
  "border-collapse",
  "border-spacing",
  "box-shadow",
  "box-sizing",
  "outline-color",
  "outline-width",
  "outline-style",
  "max-width",
  "min-height",
  "width",
  "height",
  "display",
  "flex-direction",
  "flex-basis",
  "align-items",
  "justify-content",
  "column-count",
  "column-gap",
  "row-gap",
  "gap",
  "table-layout",
  "grid-template-columns",
  "text-overflow",
  "white-space",
  "overflow-x",
  "overflow-y",
  "position",
  "cursor",
  "list-style-type",
  "opacity",
  "visibility",
  "transition-property",
  "transition-duration",
  "animation-name",
] as const;

// --- 計測点の宣言 ---------------------------------------------------------------

/**
 * 1つの計測点。
 *
 * **`selectors` は候補の配列である**(04 §3-14b の阻害(4) への対処)。先頭から順に試し、
 * 1つでも当たったらそれを採り、`matchedSelector` に記録する。**今日のレンダラーのクラス名
 * (`.list-table` など)が置き換えで消えても、構造で当たる候補(`main table` など)が残れば
 * 計測は続く** —— そして「当たり先が変わったこと」自体が着手後の差分に出る。
 */
export type ProbeSpec = {
  /** 記録上の名前。着手前と着手後をこの名前で突き合わせる。**改名しないこと。** */
  key: string;
  /** セレクタ候補(先頭優先)。 */
  selectors: string[];
  /** 同じセレクタが複数当たるときの位置(既定 0)。 */
  index?: number;
};

const probe = (key: string, selectors: string[], index?: number): ProbeSpec =>
  index === undefined ? { key, selectors } : { key, selectors, index };

/** どの画面でも測る計測点(外枠・ナビ・見出し)。 */
function shellProbes(): ProbeSpec[] {
  return [
    probe("body", ["body"]),
    probe("app-theme", [".app-theme", "[data-testid=app-theme]"]),
    probe("shell", [".shell"]),
    probe("shell-header", [".shell header", "header"]),
    probe("app-header", [".app-header"]),
    probe("app-header-h2", [".app-header h2", "header h2", "h2"]),
    probe("current-user", [".current-user", "[data-testid=current-user]"]),
    probe("current-role", [".current-role", "[data-testid=current-role]"]),
    probe("view-list", [".view-list", "[data-testid=view-list]", "nav"]),
    probe("view-list-link", [".view-list a", "[data-testid=view-list] a", "nav a"]),
    probe("workspace-main", [".workspace-main", "[data-testid=workspace-main]", "main"]),
    probe("button-0", ["button"], 0),
    probe("errors", [".errors", "[role=alert]"]),
    probe("hint", [".hint"]),
  ];
}

/** 一覧画面(`list_view`)の計測点。 */
function listProbes(): ProbeSpec[] {
  return [
    probe("list-view", [".list-view", "main section", "section"]),
    probe("list-view-h3", [".list-view h3", "main h3", "h3"]),
    probe("list-total", [".list-total"]),
    probe("list-pager", [".list-pager"]),
    probe("list-pager-button", [".list-pager button", "button"]),
    probe("list-table", [".list-table", "main table", "table"]),
    probe("th-0", [".list-table thead th", "table thead th"], 0),
    probe("th-1", [".list-table thead th", "table thead th"], 1),
    probe("th-2", [".list-table thead th", "table thead th"], 2),
    probe("tr-0", [".list-table tbody tr", "table tbody tr"], 0),
    probe("tr-1", [".list-table tbody tr", "table tbody tr"], 1),
    probe("td-0", [".list-table tbody td", "table tbody td"], 0),
    probe("td-1", [".list-table tbody td", "table tbody td"], 1),
    probe("td-2", [".list-table tbody td", "table tbody td"], 2),
    probe("td-3", [".list-table tbody td", "table tbody td"], 3),
    probe("td-4", [".list-table tbody td", "table tbody td"], 4),
    probe("col-0", [".list-table col", "table col"], 0),
    probe("col-1", [".list-table col", "table col"], 1),
    probe("list-link", [".list-table a", "table a"]),
    probe("field-empty", [".field-empty"]),
    probe("field-number", [".field-number"]),
    probe("field-boolean", [".field-boolean"]),
    probe("field-long-text", [".field-long-text"]),
    probe("field-image", [".field-image", "table img"]),
    probe("field-unresolved", [".field-unresolved"]),
    // **【`V10-M18-T02`(`FU-G2`)の注記。この計測点を1つも消していない】**
    // **今日この計測点は候補2つとも当たらない** —— `V10-M18-T02` が注記そのものを画面から
    // 出さなくしたので、DOM に当たり先が1つも無い(CSS の規則は残っている)。
    // **`docs/evidence/cp-v4-ui/` の当時の測定結果は1バイトも書き換えていない** ——
    // **あれは `V4-M13` / `V4-M17` の時点の実測であって、今日の実物ではない。**
    // **このスクリプトは合否を1つも判定しない**(`D-V4-14`)ので、当たらないこと自体が
    // 再実行時の記録に `matchedSelector` の欠落として出る。
    probe("detail-target-note", [".list-detail-target-note", ".detail-target-note"]),
  ];
}

/** 単票画面(`detail_view`)の計測点。 */
function detailProbes(): ProbeSpec[] {
  return [
    probe("detail-view", [".detail-view", "main section", "section"]),
    probe("detail-fields", [".detail-fields", "main dl", "dl"]),
    probe("detail-field-0", [".detail-field", "dl > div"], 0),
    probe("detail-field-1", [".detail-field", "dl > div"], 1),
    probe("dt-0", [".detail-field dt", "dl dt"], 0),
    probe("dt-1", [".detail-field dt", "dl dt"], 1),
    probe("dd-0", [".detail-field dd", "dl dd"], 0),
    probe("dd-1", [".detail-field dd", "dl dd"], 1),
    probe("field-empty", [".field-empty"]),
    probe("field-number", [".field-number"]),
    probe("field-boolean", [".field-boolean"]),
    probe("field-long-text", [".field-long-text"]),
    probe("field-image", [".field-image", "main img"]),
    probe("detail-actions", [".detail-actions"]),
    probe("detail-action-btn-0", [".detail-actions button", "main button"], 0),
    probe("detail-action-btn-1", [".detail-actions button", "main button"], 1),
    probe("related-list", [".related-list"]),
    probe("related-heading", [".related-heading", ".related-list h4", "h4"]),
    probe("related-table", [".related-table", "main table", "table"]),
    probe("related-th-0", [".related-table th", "table th"], 0),
    probe("related-td-0", [".related-table td", "table td"], 0),
    // **【`V10-M18-T02`(`FU-G2`)の注記】** 上の一覧側と同じ理由で、**今日この計測点は
    // 当たらない**(注記を画面から出さなくした)。**計測点も当時の測定結果も1バイトも
    // 消していない。**
    probe("detail-target-note", [".detail-target-note"]),
  ];
}

/** 入力フォーム(`form`)の計測点。 */
function formProbes(): ProbeSpec[] {
  return [
    probe("record-form", [".record-form", "main form", "form"]),
    probe("field-0", [".record-form .field", "form > div"], 0),
    probe("field-1", [".record-form .field", "form > div"], 1),
    probe("label-0", [".record-form label", "form label"], 0),
    probe("label-1", [".record-form label", "form label"], 1),
    probe("required-0", [".record-form .required", "form .required"], 0),
    probe("input-0", [".record-form input", "form input"], 0),
    probe("input-1", [".record-form input", "form input"], 1),
    probe("input-number", ["form input[type=number]"]),
    probe("input-checkbox", ["form input[type=checkbox]"]),
    probe("input-file", ["form input[type=file]"]),
    probe("input-date", ["form input[type=date]"]),
    probe("select-0", [".record-form select", "form select"], 0),
    probe("textarea-0", [".record-form textarea", "form textarea"], 0),
    probe("submit", [".record-form button[type=submit]", "form button[type=submit]"]),
    probe("form-button-0", [".record-form button", "form button"], 0),
  ];
}

/** アプリのトップ画面の計測点(外枠だけ)。 */
function workspaceProbes(): ProbeSpec[] {
  return [
    probe("workspace-links", [".workspace-links", "[data-testid=workspace-links]"]),
    probe("view-list-li", [".view-list li", "nav li"]),
    probe("view-list-empty", ["[data-testid=view-list-empty]"]),
  ];
}

// --- 画面の生成(マニフェスト由来) ------------------------------------------------

type ViewKind = "list_view" | "detail_view" | "form";

type ManifestView = { id: string; type: ViewKind; table: string; name?: string };

type ScreenSpec = {
  /** 記録上の画面 ID(= ビュー ID。トップは `workspace`)。 */
  id: string;
  kind: ViewKind | "workspace";
  table?: string;
  /** 単票のときだけ入る。行が1件も見えない役割では `undefined` のまま URL を組む。 */
  path: string;
  probes: ProbeSpec[];
  /** ポインタを乗せてもう1度測る対象。 */
  hover?: { key: string; selectors: string[]; index?: number };
  /** フォーカスを当ててもう1度測る対象。 */
  focus?: { key: string; selectors: string[]; index?: number };
};

/** ビュー1本を画面1本に写す。**判断はビューの `type` だけで機械的に決まる。** */
export function screenForView(view: ManifestView, recordId: string | undefined): ScreenSpec {
  const base = `/apps/${APP_ID}/views/${view.id}`;
  switch (view.type) {
    case "list_view":
      return {
        id: view.id,
        kind: "list_view",
        table: view.table,
        path: base,
        probes: [...shellProbes(), ...listProbes()],
        hover: {
          key: "tr-0-hover",
          selectors: [".list-table tbody tr", "table tbody tr"],
          index: 0,
        },
      };
    case "detail_view":
      return {
        id: view.id,
        kind: "detail_view",
        table: view.table,
        path: recordId === undefined ? base : `${base}/records/${recordId}`,
        probes: [...shellProbes(), ...detailProbes()],
        hover: {
          key: "detail-action-btn-0-hover",
          selectors: [".detail-actions button", "main button"],
          index: 0,
        },
      };
    case "form":
      return {
        id: view.id,
        kind: "form",
        table: view.table,
        path: base,
        probes: [...shellProbes(), ...formProbes()],
        focus: { key: "input-0-focus", selectors: [".record-form input", "form input"], index: 0 },
        hover: {
          key: "submit-hover",
          selectors: [".record-form button[type=submit]", "form button[type=submit]"],
        },
      };
  }
}

// --- 計測の結果の形 -------------------------------------------------------------

export type Measured = {
  found: boolean;
  /** 当たったセレクタ(候補のうち最初に1つ以上ヒットしたもの)。 */
  matchedSelector?: string;
  /** そのセレクタのヒット総数。 */
  count: number;
  tag?: string;
  className?: string;
  attrs?: Record<string, string>;
  text?: string;
  textLength?: number;
  rect?: { x: number; y: number; w: number; h: number };
  css?: Record<string, string>;
};

type ScreenResult = {
  screenId: string;
  kind: string;
  role: string;
  width: number;
  height: number;
  url: string;
  title: string;
  /** 単票で行が解決できたか。**解決できなくても計測は続ける**(空の画面として測る)。 */
  recordResolved?: boolean;
  /** ページ全体が横にはみ出しているか(狭い幅の計測で効く)。 */
  page: { scrollWidth: number; clientWidth: number; horizontalOverflow: boolean };
  /** 画面直下の DOM の並び。 */
  domOrder: string[];
  probes: Record<string, Measured>;
};

// --- 本体 ---------------------------------------------------------------------

type Account = { role: string; username: string; password: string };

const ACCOUNTS: Account[] = [
  { role: "owner", username: REF_EC_OWNER.username, password: REF_EC_OWNER.password },
  { role: "customer", username: REF_EC_CUSTOMER.username, password: REF_EC_CUSTOMER.password },
];

/** HTTP でログインして `st_session` の値を返す。 */
async function login(baseUrl: string, account: Account): Promise<string> {
  const response = await fetch(`${baseUrl}/api/apps/${APP_ID}/auth/password/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ username: account.username, password: account.password }),
  });
  if (response.status !== 200) {
    throw new Error(
      `${account.username} のログインに失敗しました(${response.status})。参照ショップが ${baseUrl} で起動しているか確認してください。`,
    );
  }
  for (const raw of response.headers.getSetCookie()) {
    const [pair] = raw.split(";");
    const [name, value] = (pair ?? "").split("=");
    if (name === "st_session" && value !== undefined) {
      return value;
    }
  }
  throw new Error(`${account.username} のログインで st_session が発行されませんでした。`);
}

/** マニフェストのビュー一覧を読む(**画面は決め打ちにしない**)。 */
async function fetchViews(baseUrl: string, cookieValue: string): Promise<ManifestView[]> {
  const response = await fetch(`${baseUrl}/api/apps/${APP_ID}/manifest`, {
    headers: { cookie: `st_session=${cookieValue}` },
  });
  if (response.status !== 200) {
    throw new Error(`マニフェストを読めませんでした(${response.status})。`);
  }
  // 返るのは `{ app: { … } }` そのものである(`{ manifest: … }` で包まれていない。実測)。
  const body = (await response.json()) as {
    app?: { views?: ManifestView[] };
    manifest?: { app?: { views?: ManifestView[] } };
  };
  const views = body.app?.views ?? body.manifest?.app?.views;
  if (views === undefined || views.length === 0) {
    throw new Error("マニフェストにビューが1本もありません。");
  }
  return views;
}

/** その役割から見える先頭の行の `_id`。**見えなければ `undefined`**(0件であることも記録に残す)。 */
async function firstRecordId(
  baseUrl: string,
  cookieValue: string,
  table: string,
): Promise<string | undefined> {
  const response = await fetch(`${baseUrl}/api/apps/${APP_ID}/tables/${table}/records?limit=1`, {
    headers: { cookie: `st_session=${cookieValue}` },
  });
  if (response.status !== 200) {
    return undefined;
  }
  const body = (await response.json()) as { records?: { _id?: string }[] };
  return (body.records ?? [])[0]?._id;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const sessions = new Map<string, string>();
  for (const account of ACCOUNTS) {
    sessions.set(account.role, await login(options.baseUrl, account));
  }
  const ownerCookie = sessions.get("owner");
  if (ownerCookie === undefined) {
    throw new Error("owner のセッションが取れませんでした。");
  }
  const views = await fetchViews(options.baseUrl, ownerCookie);

  const browser = await chromium.launch();
  const hostname = new URL(options.baseUrl).hostname;
  const results: ScreenResult[] = [];

  const shotsRoot = join(options.shotsDir, options.label);
  if (options.shots) {
    mkdirSync(shotsRoot, { recursive: true });
  }

  for (const account of ACCOUNTS) {
    const cookieValue = sessions.get(account.role);
    if (cookieValue === undefined) {
      throw new Error(`${account.role} のセッションが取れませんでした。`);
    }

    // 単票の `_id` は**役割ごとに解決する** —— `st_owner` のスコープが効くので、
    // owner から見えない表(カートなど)は 0件になる。**そのことも記録に残す。**
    const recordIds = new Map<string, string | undefined>();
    for (const view of views) {
      if (view.type === "detail_view" && !recordIds.has(view.table)) {
        recordIds.set(view.table, await firstRecordId(options.baseUrl, cookieValue, view.table));
      }
    }

    const screens: ScreenSpec[] = [
      {
        id: "workspace",
        kind: "workspace",
        path: `/apps/${APP_ID}`,
        probes: [...shellProbes(), ...workspaceProbes()],
      },
      ...views.map((view) =>
        screenForView(view, view.type === "detail_view" ? recordIds.get(view.table) : undefined),
      ),
    ];

    for (const width of options.widths) {
      const height = width >= 900 ? 900 : 844;
      const context = await browser.newContext({ viewport: { width, height } });
      await context.addCookies([
        { name: "st_session", value: cookieValue, domain: hostname, path: "/" },
      ]);
      const page = await context.newPage();

      for (const screen of screens) {
        const url = `${options.baseUrl}${screen.path}`;
        await page.goto(url, { waitUntil: "networkidle" });

        const measured = await page.evaluate(
          ({ probes, props }) => {
            const result: Record<string, Measured> = {};
            for (const spec of probes) {
              let nodes: NodeListOf<Element> | undefined;
              let matched: string | undefined;
              for (const selector of spec.selectors) {
                const found = document.querySelectorAll(selector);
                if (found.length > 0) {
                  nodes = found;
                  matched = selector;
                  break;
                }
              }
              const node = nodes?.[spec.index ?? 0];
              if (!(node instanceof Element)) {
                result[spec.key] = {
                  found: false,
                  count: nodes?.length ?? 0,
                  ...(matched === undefined ? {} : { matchedSelector: matched }),
                };
                continue;
              }
              const computed = window.getComputedStyle(node);
              const css: Record<string, string> = {};
              for (const prop of props) {
                css[prop] = computed.getPropertyValue(prop);
              }
              const rect = node.getBoundingClientRect();
              const attrs: Record<string, string> = {};
              for (const attr of Array.from(node.attributes)) {
                attrs[attr.name] = attr.value;
              }
              const text = node.textContent ?? "";
              result[spec.key] = {
                found: true,
                matchedSelector: matched ?? "",
                count: nodes?.length ?? 0,
                tag: node.tagName.toLowerCase(),
                className: node.getAttribute("class") ?? "",
                attrs,
                text: text.slice(0, 240),
                textLength: text.length,
                rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
                css,
              };
            }
            return result;
          },
          { probes: screen.probes, props: PROPS as unknown as string[] },
        );

        // ホバー中の値(押せる見た目が在るか。`P-G5` の着手前の値)。
        if (screen.hover !== undefined) {
          const hover = screen.hover;
          for (const selector of hover.selectors) {
            const target = page.locator(selector).nth(hover.index ?? 0);
            if ((await target.count()) === 0) {
              continue;
            }
            await target.hover({ timeout: 5_000 }).catch(() => undefined);
            break;
          }
          measured[hover.key] = await page.evaluate(
            ({ selectors, index, props }) => {
              for (const selector of selectors) {
                const nodes = document.querySelectorAll(selector);
                const node = nodes[index];
                if (node instanceof Element) {
                  const computed = window.getComputedStyle(node);
                  const css: Record<string, string> = {};
                  for (const prop of props) {
                    css[prop] = computed.getPropertyValue(prop);
                  }
                  return { found: true, matchedSelector: selector, count: nodes.length, css };
                }
              }
              return { found: false, count: 0 };
            },
            {
              selectors: hover.selectors,
              index: hover.index ?? 0,
              props: PROPS as unknown as string[],
            },
          );
          await page.mouse.move(0, 0);
        }

        // フォーカス中の値(`:focus-visible` の着手前の値)。
        if (screen.focus !== undefined) {
          const focus = screen.focus;
          for (const selector of focus.selectors) {
            const target = page.locator(selector).nth(focus.index ?? 0);
            if ((await target.count()) === 0) {
              continue;
            }
            await target.focus({ timeout: 5_000 }).catch(() => undefined);
            break;
          }
          measured[focus.key] = await page.evaluate(
            ({ selectors, index, props }) => {
              for (const selector of selectors) {
                const nodes = document.querySelectorAll(selector);
                const node = nodes[index];
                if (node instanceof Element) {
                  const computed = window.getComputedStyle(node);
                  const css: Record<string, string> = {};
                  for (const prop of props) {
                    css[prop] = computed.getPropertyValue(prop);
                  }
                  return { found: true, matchedSelector: selector, count: nodes.length, css };
                }
              }
              return { found: false, count: 0 };
            },
            {
              selectors: focus.selectors,
              index: focus.index ?? 0,
              props: PROPS as unknown as string[],
            },
          );
          await page.evaluate(() => {
            (document.activeElement as HTMLElement | null)?.blur();
          });
        }

        const pageMetrics = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          horizontalOverflow:
            document.documentElement.scrollWidth > document.documentElement.clientWidth,
        }));

        const domOrder = await page.evaluate(() => {
          const host =
            document.querySelector(".list-view") ??
            document.querySelector(".detail-view") ??
            document.querySelector(".record-form") ??
            document.querySelector(".app-theme") ??
            document.body;
          return Array.from(host.children).map(
            (child) => `${child.tagName.toLowerCase()}.${child.getAttribute("class") ?? ""}`,
          );
        });

        const entry: ScreenResult = {
          screenId: screen.id,
          kind: screen.kind,
          role: account.role,
          width,
          height,
          url,
          title: await page.title(),
          page: pageMetrics,
          domOrder,
          probes: measured,
        };
        if (screen.kind === "detail_view") {
          entry.recordResolved = screen.path.includes("/records/");
        }
        results.push(entry);

        if (options.shots) {
          await page.screenshot({
            path: join(shotsRoot, `${account.role}-w${width}-${screen.id}.png`),
            fullPage: true,
          });
        }
        console.error(
          `[t13-probe:${options.label}] ${account.role} w${width} ${screen.id} (${Object.keys(measured).length} probes)`,
        );
      }

      await page.close();
      await context.close();
    }
  }

  await browser.close();

  mkdirSync(options.outDir, { recursive: true });
  const outPath = join(options.outDir, `t13-measurements-${options.label}.json`);
  const payload = {
    label: options.label,
    baseUrl: options.baseUrl,
    appId: APP_ID,
    capturedAt: new Date().toISOString(),
    widths: options.widths,
    roles: ACCOUNTS.map((account) => account.role),
    props: PROPS,
    /** 何本測ったか(記録に書く数の出どころ)。 */
    counts: {
      views: views.length,
      screensPerRoleAndWidth: views.length + 1,
      screenRuns: results.length,
      probeRecords: results.reduce((sum, entry) => sum + Object.keys(entry.probes).length, 0),
    },
    screenshots: options.shots
      ? { dir: shotsRoot, committed: false, note: "D-V4-27 により残すが判定には使わない" }
      : null,
    results,
  };
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.error(
    `[t13-probe:${options.label}] wrote ${outPath} (${payload.counts.screenRuns} screen runs / ${payload.counts.probeRecords} probe records)`,
  );
}

if (import.meta.main) {
  await main();
}
