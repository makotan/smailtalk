/**
 * 参照系9ツール(V0-P5-T02 / ADR-0005。7つ目は V1-M1-T02 の `dry_run_diff`、
 * 8つ目は V1-M8-T02 の `generate_requirements_doc`、9つ目は V3-M5-T04 の `report_drift`)。
 *
 * この9つは**アプリの状態を1つも変えない**。LLM が「今どうなっているか」を
 * 把握するための窓であり、更新系(T03)を安全に使うための前提になる。
 *
 * **【2026-08-15。`V8-M13-T02`。台帳 `Q-G28` = 限定採用(門A)。上の2段落を1バイトも
 * 消していない】** **今日は**参照系10ツール**である** —— **10個目が `read_report`
 * (集計表を1枚読む)である。** **公開ツールの総数は 23 → 24 になった**
 * (`ADR-0176` 限定2 / `ADR-0327` の「23本」は今日から偽であり、**引き直す ADR は
 * `V8-M13-T07` が書く**。本タスクは ADR を1本も起草していない)。
 * **10個目も**アプリの状態を1つも変えない**(限定3: 書込の口を1つも作らない)。**
 *
 * ## `dry_run_diff` がここにある理由(V1-M1-T02。判断の記録は `records/v1-m1-t02.md` §1-1)
 *
 * ドライランは差分を**複製の上で**適用するので、`dataRoot` 配下のファイルを
 * 1バイトも変えない(複製は OS の一時ディレクトリに作り、終わったら消す)。
 * したがって `scripts/mcp-trial/transcript.ts` の `WRITE_TOOLS` —— **「ファイルを
 * 変える可能性があるもの」の事実の列挙** —— には**入れない**(ADR-0010 Consequences)。
 * 入れると `changeAttribution` が変更候補として列挙し、V1-M1-T08 §5 が指摘した
 * `update_record` の誤りと同じものを1件増やす。
 *
 * **登録先と `WRITE_TOOLS` は一体の判断であり、片方だけ動かしてはならない。**
 * `write-tools-drift.test.ts` の「WRITE_TOOLS に参照系ツールが混ざっていない」と、
 * `descriptions.test.ts` の「dry_run_diff は参照系として登録されている」が
 * 両側から見張っている。
 *
 * どのツールも実装は「入力を検証 → カーネルの公開APIに委譲 → 結果を MCP の形に
 * 詰め替える」の3行に収まる形にしてある。ADR-0003 §7 が入口層に置くことを
 * 禁じているもの(バリデーション・参照整合性・DDL・エラー文面)は1つも無い。
 * とくに**エラー文面をここで書き換えない**のが重要で、HTTP 経由でも MCP 経由でも
 * LLM が読むメッセージが同じになる。
 *
 * 例外は2つだけあり、どちらも「カーネルが例外を投げる場所を、統一形式に
 * 変換する」ためのものである。
 *
 * - `requireApp`(R1): app_id 不在を統一形式にする
 * - `get_preview_url` の view_id 検査: マニフェストに無いビューIDを統一形式にする
 *   (URL だけなら生成できてしまい、開くと 404 になる。それは LLM から見て
 *    「成功した」と誤認する形なので、URL を返す前に弾く)
 */
import { Database } from "bun:sqlite";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
// **【`V10-M12-T01` / 台帳 `CM-G7` / `ADR-0368`】コメントの器をここから直に開く。**
// **`src/kernel/index.ts` は1バイトも触っていない**(器は今日そこから1本も出ていない) ——
// **`src/server/auth-routes.ts` が書込の口で採っているのと同じ形である。**
// **可視性の合成(下の `visibleComments`)は器を1度も開かないので、
// 行を読む側がここに要る。**
// **【`V10-M28-T03`】** **報告から認証まわりを落とす綴りは、接頭辞1つを単一の定数から採る。**
// **表名を列挙しない**(実物は8本あり、3本だけ挙げると漏れる)——
// **綴りの正は `src/auth/types.ts` の `AUTH_TABLE_PREFIX` ただ1つである。**
import { isAuthTableName } from "../../auth/types.ts";
import { type Comment, CommentStore } from "../../kernel/comment-store.ts";
import {
  appDbPath,
  DRY_RUN_NOTE,
  type DryRunReport,
  dryRunDiff,
  generateRequirementsDoc,
  getChangelog,
  KernelMetaStore,
  type ListRecordsOptions,
  type Manifest,
  previewRedo,
  previewUndo,
  type ReadSource,
  type RequirementSection,
  type RequirementStatement,
  readCurrentManifest,
  readRecordCount,
  readRecordList,
  renderRequirementsMarkdown,
  SORT_ORDERS,
  type ViewType,
} from "../../kernel/index.ts";
// **【`V8-M13-T02` / 台帳 `Q-G28`。限定5(可視性の判定を必ず通す)の配線】**
// **`src/kernel/report.ts` の `computeReport()` をここから直接呼ぶと、可視性を1ミリも
// 通らない。** **呼ぶのは HTTP の集計表の口とまったく同じ1本である。**
// **`REPORT_DEFAULT_GROUP_LIMIT` も同じ定数を使う**(2つ目の既定を作らない)。
import { REPORT_DEFAULT_GROUP_LIMIT, readVisibleReport } from "../../server/app.ts";
// **【`V10-M12-T01` / `ADR-0368` 限定3(可視性の判定を必ず通す)の配線】**
// **`list_comments` のハンドラは可否の条件式を1行も持たない。** **呼ぶのは
// `CM-G5` が決めた合成1本ちょうどである** —— **`judgeRoleAccess` を直接呼ばない。**
import { visibleComments } from "../../server/comment-visibility.ts";
import { recordAccessLimitError } from "../../server/errors.ts";
import {
  isOwnerVisible,
  judgeRoleAccess,
  OWNER_FIELD,
  personalOwnerField,
  projectForRoleFields,
  recordAccessSourceTables,
  resolveCombinedRecordAccess,
  roleGateBlocksWithoutGrants,
  roleReadCrossesOwnerScope,
  scrubHiddenFieldIds,
} from "../../server/owner-scope.ts";
import { routePath } from "../../shared/route.ts";
import { SYSTEM_TABLES } from "../../shared/system-tables.ts";
import { requireActor, requireActorAndApp } from "../actor-guard.ts";
import { toolError, toolOk } from "../result.ts";
import type { CreateMcpServerOptions } from "../server.ts";
import {
  DESTRUCTIVE_CHANGE_FLOW,
  DRIFT_COUNTED_PRESET_KEYS,
  DRIFT_ESCAPE_HATCH_NOT_COUNTED,
  DRIFT_NO_AUTO_PROMOTION,
  DRIFT_NOT_A_GATE,
  DRIFT_NOT_COUNTED_ESCAPE_HATCH,
  DRIFT_NOT_COUNTED_NO_TARGET,
  DRIFT_NOT_COUNTED_UNKNOWN_KEY,
  DRIFT_NOT_COUNTED_VIEW_TYPE,
  DRIFT_PROMOTION_PROPOSAL,
  DRIFT_PROMOTION_THRESHOLD,
  DRIFT_REFERENCE_DECLARATIONS_NOT_COUNTED,
  DRIFT_SAMENESS_RULE,
  DRIFT_THEME_COUNTING_RULE,
  DRIFT_THEME_LIMITATION,
  DRIFT_THEME_UNIT,
  describeTool,
  INTENT_VERBATIM,
  PREVIEW_URL_VERBATIM,
  UNDO_ROLLBACK_LIMIT,
} from "../vocabulary.ts";
// **【`V10-M28-T02`】** **`dry_run_diff` の壁は、更新系(`apply_diff`)と**同じ1本**を通す。**
// **ここに条件式を1行も書いていない**(`ADR-0305` 限定3 /`ADR-0061` 限定4 の作法)——
// **可否を計算するのは `src/server/owner-scope.ts` の `judgeRoleAccess` だけであり、
// その呼び方を持つ関数は `src/mcp/tools/write.ts` に**1本だけ**在る。**
// **`diffArg` を写しで持っている理由(このファイルの `diffArg` の doc)とは判断が違う** ——
// **あちらは「同じ形であること」を検査で見張れるが、判定は同じ**関数**でなければ
// 「同じ判定を通った」ことにならない。**
import { denyAppSettingWrite } from "./write.ts";

/**
 * app_id 引数の共通定義。全ツールで同じ説明にする(ツールごとに言い回しが違うと、
 * LLM が「ツールによって指定するものが違う」と誤読する余地が生まれる)。
 */
const appIdArg = z.string().describe("対象アプリのID。list_apps で取得できる。");

/**
 * `list_records` の並び順キー1つ(V3-M12-T10)。
 *
 * **マニフェストの `$defs/sort_key` と同じ形にしてある** —— `field` と `order` の
 * 2キーだけで、どちらも必須である。ツール側だけ別の形にすると、`update_view` の
 * 書き方から一般化した AI が外す(F-2 が v0 の4試行4回で実際に起こした失敗形)。
 *
 * **新しい語彙ではない。** カーネルの `ListRecordsOptions.sort` は v1(V1-M0-T03 /
 * ADR-0009)から `Sort | Sort[]` を受けており、HTTP の `parseListOptions` は既に
 * 複合ソートを渡していた。1キーに縛られていたのは `list_records` の引数だけである
 * (`docs/plan/v1/00-m0-close-v0-gaps.md` §入口の受け皿 の #3)。
 */
const sortKeyArg = z.object({
  field: z.string().describe("並べ替えに使うフィールドID。"),
  order: z.enum(SORT_ORDERS).describe("このキーの向き(asc / desc)。"),
});

/**
 * `dry_run_diff` の差分引数(V1-M1-T02)。**`write.ts` の `diffArg` と同一である。**
 *
 * **なぜ同じものが2箇所にあるのか。** ドライランの存在意義は「同じ差分を送れば
 * 同じ結果になる」ことなので、両ツールの入力スキーマは一致していなければならない。
 * 共有する形(`write.ts` から export する / 第3のモジュールへ括り出す)を採らなかったのは、
 * V1-M1-T02 の変更予定ファイルの宣言(`records/v1-m1-t01.md` §6)が
 * **登録先を `read.ts` に確定させ、`write.ts` を含めていない**ためである。
 *
 * **写した事実がずれないことは機械的に見張っている** ―― `descriptions.test.ts` の
 * 「dry_run_diff と apply_diff の diff 入力スキーマが完全に一致する」が
 * `tools/list` の JSON 同士を突き合わせる。`write-tools-drift.test.ts` が
 * `WRITE_TOOLS` について採ったのと同じ手口である(手で写すなら、ずれを検査で塞ぐ)。
 * **括り出したくなったら T06 で行うこと**(あちらは `write.ts` を宣言に含んでいる)。
 *
 * 各フィールドを浅く受ける理由(zod にエラー形式を横取りさせない)は
 * `write.ts` の `diffArg` のコメントを参照。
 */
const diffArg = z
  .object({
    diff_id: z.string().describe(
      'この変更を識別するID。例: "d-003-tags"。' +
        // ADR-0028 / V1-M9-T08: apply_diff(write.ts)の diffArg と1文字も違えないこと
        // (dry_run_diff と apply_diff の入力スキーマ一致を descriptions.test.ts が固定する)。
        "undo できるよう59文字以内にすること(60文字以上は apply_diff が拒否する)。",
    ),
    intent: z
      .string()
      .optional()
      .describe(
        "この変更で何をしたいのか、ユーザの言葉のままの日本語。" +
          "要約や機械語への言い換えをせずに書くこと。変更履歴にそのまま残り、" +
          "後から「なぜこうなっているか」を答える唯一の記録になる。" +
          INTENT_VERBATIM,
      ),
    operations: z
      .array(z.record(z.string(), z.unknown()))
      .describe(
        "適用する操作の配列。add_table / add_field / add_view / update_view / " +
          "remove_field / remove_table / remove_view / change_table / change_field / " +
          "add_workflow / update_workflow / remove_workflow のいずれか。" +
          "先頭から順に畳み込まれるので、同じ差分の中で先に追加したテーブルを参照できる" +
          "(逆に、先に消したものは後の操作から参照できない)。" +
          "remove_field / remove_table / change_table / change_field の4つは" +
          "既存の定義とデータを実際に変更・削除する。" +
          "それらを含む場合は、先に dry_run_diff で影響を実測すること。" +
          "remove_view は画面の定義だけを消し、テーブル・フィールド・レコードには触れない。" +
          "add_workflow / update_workflow / remove_workflow は自動化の定義を変える。" +
          "適用の時点では何も消えないが、**適用が終わったあとも動き続ける** —— " +
          "何がいつ動くようになるか/動かなくなるかをユーザに伝え、同意を得てから呼ぶこと。",
      ),
  })
  .describe("適用する差分パッチ。get_manifest で現状を確認してから組み立てること。");

/**
 * プレビューURLに必ず添える注記。
 *
 * MCP サーバは Web サーバとは**別プロセス**で、相手が起動しているかを知る手段を
 * 持たない(ADR-0005 §3)。「URL を返せた = 開ける」ではないので、その前提を
 * URL と一緒に必ず渡し、LLM が「開けなかった」ときに自分で原因を推測できるようにする。
 */
const PREVIEW_NOTE =
  "このURLはブラウザで開けます。表示には Web サーバ(bun run server)が起動している必要があります。" +
  "MCP サーバは別プロセスのため、Web サーバの起動状態を確認できません。";

/**
 * 要件定義書の節(ADR-0025 §7 の6つ)。**`section` 引数の受理集合である。**
 *
 * カーネルは節の一覧を配列として export していない(ADR-0025 限定11 が新規 export を
 * 2群に限っており、この引数のために公開面を増やさない)。そこで**型の網羅性で写しを固定する**
 * —— `Record<RequirementSection, true>` はキーの過不足をどちらもコンパイルエラーにするので、
 * カーネルの union が動けばここが必ず赤くなる。`requirements-doc.ts` が `TRIGGER_TYPES` を
 * 判別共用体のタグの写しとして書き下したのと同じ手口である。
 */
const REQUIREMENT_SECTION_KEYS: Record<RequirementSection, true> = {
  overview: true,
  features: true,
  screens: true,
  data: true,
  automation: true,
  history: true,
};

const REQUIREMENT_SECTIONS = Object.keys(REQUIREMENT_SECTION_KEYS) as [
  RequirementSection,
  ...RequirementSection[],
];

/** マニフェストからテーブルIDの一覧を取り出す(エラーの allowed_values 用)。 */
function viewIds(manifest: Manifest): string[] {
  return manifest.app.views.map((view) => view.id);
}

/**
 * **集計表(`report_view`)の画面IDだけ**(`V8-M13-T02` / 台帳 `Q-G28`)。
 *
 * **`read_report` の `allowed_values` に載せる。** **HTTP の口(`src/server/app.ts`)が
 * 「集計表でない画面」の 400 に載せているのと同じ絞り方である** —— **1往復で
 * 直せる形にするため、全画面ではなく集計表だけを挙げる。**
 */
function reportViewIds(manifest: Manifest): string[] {
  return manifest.app.views.filter((view) => view.type === "report_view").map((view) => view.id);
}

/**
 * 読み取りファサードに渡す `ReadSource` を組む(`src/server/app.ts` の `withReadSource` と同じ形)。
 *
 * `appDb` は**呼ばれたときに初めて開く**。システムテーブルの投影元は `kernel.sqlite` だけ
 * なので、`app.sqlite` が無い / 壊れているアプリでも `_apps` を読めるようにするためである
 * (ADR-0006 §7b)。開かなければ閉じる必要も無い。
 */
function withReadSource<T>(dataRoot: string, appId: string, run: (source: ReadSource) => T): T {
  let db: Database | undefined;
  try {
    return run({
      dataRoot,
      appDb: () => {
        db ??= new Database(appDbPath(dataRoot, appId), { readwrite: true, create: false });
        return db;
      },
    });
  } finally {
    db?.close();
  }
}

/**
 * **ページを切る**(`src/server/app.ts` の `slicePage` と同じ形)。
 *
 * **行ごとの判定で絞った後に切る** —— **DB の LIMIT/OFFSET は使えない**(判定は SQL に
 * 落とせないので、絞る前に切ると「ページの中だけ絞った」形になり、`total` と母集団が割れる)。
 */
function slicePage<T>(rows: T[], limit: number | undefined, offset: number | undefined): T[] {
  const start = offset ?? 0;
  const end = limit === undefined ? undefined : start + limit;
  return rows.slice(start, end);
}

/**
 * **1回の要求のあいだ、表ごとに1度だけ行を読む読み手を1組つくる**
 * (`src/server/app.ts` の `memoizedRowReaders` と同じ形・同じ読み方)。
 *
 * **読み方を1バイトも変えていない** —— **`readRecordList(source, manifest, id, {})` で全件を
 * 読み、`_id` の索引を一緒に作って持ち回る。** **読めない表は「行が0件」に倒す**
 * (**判定そのものは掛かり続け、fail-closed になる**)。
 *
 * **【代償は HTTP と同じ】** —— **全件をメモリに読む**(`ADR-0042` §限界2)。
 * **メモ化は同じ表を読み直さないだけであり、読む量を1行も減らしていない。**
 */
function memoizedRowReaders(
  source: ReadSource,
  manifest: Manifest,
): {
  readRows: (tableId: string) => readonly Record<string, unknown>[];
  readRow: (tableId: string, recordId: string) => Record<string, unknown> | undefined;
} {
  const cache = new Map<string, readonly Record<string, unknown>[]>();
  const index = new Map<string, Map<string, Record<string, unknown>>>();
  const readRows = (id: string): readonly Record<string, unknown>[] => {
    const cached = cache.get(id);
    if (cached !== undefined) {
      return cached;
    }
    const result = readRecordList(source, manifest, id, {});
    const rows = result.ok ? (result.value as unknown as Record<string, unknown>[]) : [];
    cache.set(id, rows);
    const byId = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      const recordId = row._id;
      if (typeof recordId === "string") {
        byId.set(recordId, row);
      }
    }
    index.set(id, byId);
    return rows;
  };
  const readRow = (id: string, recordId: string): Record<string, unknown> | undefined => {
    readRows(id);
    return index.get(id)?.get(recordId);
  };
  return { readRows, readRow };
}

// ---------------------------------------------------------------------------
// V3-M5-T04: 逸脱の蓄積の検出と昇格の提案(`D-G10a`。ADR-0056。判定 = 将来送り・門外)
// ---------------------------------------------------------------------------
//
// **なぜ集計がここに在るのか。** 他のツールは「入力を検証 → カーネルの公開APIに委譲 →
// MCP の形に詰め替える」の3行に収まっているのに、ここだけ集計そのものを持っている。
// 理由は2つあり、どちらも判定に接地している。
//
// 1. **`src/kernel/` を1バイトも触らないことが門外(Δ7)の根拠そのものである**
//    (`docs/plan/v3/records/v3-m5-gate-a-drift.md` §2 S2-1)。カーネルに集計関数を足せば
//    Δ8 が発火し、門A へ差し戻しになる。**門A本審査が W-B と等級を付けたのは、まさに
//    「表示層 / MCP 応答がマニフェストを読んで集計する」形である**(同 §2 S4 の探索先②)。
// 2. **新しいファイルを作らなかったのは、歯止め1 の変更予定ファイルの宣言に従うためである**
//    (`docs/plan/v3/records/v3-m5.md` §2 の T04 行は `read.ts` と `vocabulary.ts` だけを挙げている)。
//
// **読む先は `readCurrentManifest`(v0 既存。2026-07-18 から在る)だけである** ——
// changelog も逃げ道の資産ストアも読まない。**逃げ道を読まないことは実装の都合ではなく、
// `D-G10b` が未達であることの帰結である**(ADR-0056 §5 / 限界1)。

/**
 * 数える対象の全キー(画面種別ごとの表を潰したもの)。表に無い `preset_*` は数えない。
 *
 * **画面種別の一覧をカーネルから値として import しない** —— 表そのもの
 * (`DRIFT_COUNTED_PRESET_KEYS`)が画面種別で引けるので、そのキー集合を使えば足りる。
 * ADR-0009 限定2 の受け皿(`scripts/kernel-import-snapshot.txt`)を、必要の無い層またぎで
 * 1行も太らせない。**表が画面種別を尽くしていることは `drift-report.test.ts` が
 * `$defs/view_type` の enum と突き合わせて固定する。**
 */
const COUNTED_VIEW_TYPES = Object.keys(DRIFT_COUNTED_PRESET_KEYS) as ViewType[];

const KNOWN_PRESET_KEYS: ReadonlySet<string> = new Set(
  COUNTED_VIEW_TYPES.flatMap((viewType) => [...DRIFT_COUNTED_PRESET_KEYS[viewType]]),
);

/**
 * テーマの群の値ラベル。
 *
 * **テーマは「同じ値が何件あるか」を数える対象ではない** —— 数える単位が `app.theme` 全体
 * (1アプリに高々1つ)なので、値は群を1つに畳むためのラベルでよい。
 * **この形が閾値に達し得ないことは `DRIFT_THEME_LIMITATION` が応答に明記する。**
 */
const THEME_VALUE_LABEL = "(テーマ全体を1件と数える)";

/** 数えた1件。**群の件数はこの配列から数え直せる**(完了条件6)。 */
export type DriftObservation = {
  /** 数える単位のキー(`preset_*` の1つ、または `app.theme`)。 */
  unit: string;
  /** 正規化した値(文字列)。 */
  value: string;
  view_id: string | null;
  view_type: ViewType | null;
  /** 列ごとのマップ形のキーのとき、その値が書かれていた列のID(昇順)。 */
  fields?: string[];
  /** `app.theme` のとき、数えた根拠としての25スロットの値。 */
  slots?: Record<string, string>;
};

/** 同趣旨(= 同じキーに同じ値)でまとめた群。 */
export type DriftGroup = {
  unit: string;
  value: string;
  count: number;
  view_ids: string[];
  reached_threshold: boolean;
};

/** 閾値に達した群に提案文を添えたもの。**提案するだけで、何も書き込まない。** */
export type DriftProposal = DriftGroup & { proposal: string };

/** 数えなかったもの(理由つき)。**数えなかったことを黙らせない**(憲法6)。 */
export type DriftNotCounted = {
  reason: string;
  view_id: string | null;
  view_type: ViewType | null;
  unit: string | null;
};

export type DriftReport = {
  app_id: string;
  threshold: number;
  counting_rule: string;
  theme_counting_rule: string;
  counted_scope: Record<ViewType, readonly string[]> & { theme: string };
  observations: DriftObservation[];
  groups: DriftGroup[];
  proposals: DriftProposal[];
  not_counted: DriftNotCounted[];
  limitations: string[];
};

function isViewType(value: unknown): value is ViewType {
  return typeof value === "string" && (COUNTED_VIEW_TYPES as readonly string[]).includes(value);
}

/**
 * マニフェストに載る調整の蓄積を数える(**読み取りだけ。1バイトも書かない**)。
 *
 * **「同趣旨」の判定規則は `DRIFT_SAMENESS_RULE` の逐語である** —— 同じキーに同じ値。
 * 1画面の同じキーは何列に書かれていても1件、値が割れていれば値ごとに1件。
 * したがって**件数は「その(キー, 値)を書いている画面の数」**であり、`observations` から
 * 数え直せる(それが完了条件6 の要求そのものである)。
 *
 * 型を `Manifest` で受けているが、**中身は `Record<string, unknown>` として読む** ——
 * 画面種別で書けないはずのキーや、将来生えた8つ目のキーが来ても落ちずに
 * 「数えなかった」側へ回すためである(落ちると、数えられないことすら分からなくなる)。
 */
export function buildDriftReport(appId: string, manifest: Manifest): DriftReport {
  const observations: DriftObservation[] = [];
  const notCounted: DriftNotCounted[] = [];

  const views = manifest.app.views as unknown as Record<string, unknown>[];
  for (const view of views) {
    const viewId = typeof view.id === "string" ? view.id : null;
    const viewType = isViewType(view.type) ? view.type : null;
    const countable: readonly string[] =
      viewType === null ? [] : DRIFT_COUNTED_PRESET_KEYS[viewType];

    // 逃げ道(V3-M5-T02 の18キー目)。**参照が在ることは見えるが、1件も数えない。**
    if (view.custom_css !== undefined && view.custom_css !== null) {
      notCounted.push({
        reason: DRIFT_NOT_COUNTED_ESCAPE_HATCH,
        view_id: viewId,
        view_type: viewType,
        unit: "custom_css",
      });
    }

    // 数える対象のキーを1つも持てない画面種別(= `form`)は、画面ごとにそう書く。
    // **【V4-M16-T11 / ADR-0091 限定3 で偽になった】** 括弧の中は今日は成り立たない ——
    // **form は2軸(項目名と値の向き / 項目の段組数)を数える対象に持つ。**
    // **旧文を消していない。****今日この分岐に入る画面種別は1つも無いが、分岐は残す**
    // (消すと、将来また0になる画面種別が生えたときに黙って混ざる)。
    if (viewType !== null && countable.length === 0) {
      notCounted.push({
        reason: DRIFT_NOT_COUNTED_NO_TARGET,
        view_id: viewId,
        view_type: viewType,
        unit: null,
      });
    }

    for (const key of Object.keys(view)
      .filter((name) => name.startsWith("preset_"))
      .sort()) {
      const raw = view[key];
      if (raw === undefined || raw === null) {
        continue;
      }
      if (!KNOWN_PRESET_KEYS.has(key)) {
        notCounted.push({
          reason: DRIFT_NOT_COUNTED_UNKNOWN_KEY,
          view_id: viewId,
          view_type: viewType,
          unit: key,
        });
        continue;
      }
      if (!countable.includes(key)) {
        // **落ちている画面種別で数えない**(完了条件1)。「書けない」と「書かれていない」を
        // 同じ0に混ぜると、件数の意味が画面種別ごとに変わってしまう。
        notCounted.push({
          reason: DRIFT_NOT_COUNTED_VIEW_TYPE,
          view_id: viewId,
          view_type: viewType,
          unit: key,
        });
        continue;
      }

      if (typeof raw === "object") {
        // 列ごとのマップ形(`preset_column_align` / `preset_column_width`)。
        // **1画面につき、値の種類ごとに1件**(同じ値が何列あっても1件)。
        const byValue = new Map<string, string[]>();
        for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
          const normalized = String(value);
          byValue.set(normalized, [...(byValue.get(normalized) ?? []), field]);
        }
        for (const value of [...byValue.keys()].sort()) {
          observations.push({
            unit: key,
            value,
            view_id: viewId,
            view_type: viewType,
            fields: [...(byValue.get(value) ?? [])].sort(),
          });
        }
      } else {
        observations.push({ unit: key, value: String(raw), view_id: viewId, view_type: viewType });
      }
    }
  }

  // テーマ。**テーマ全体で1件**(スロット単位では数えない。完了条件8)。
  const theme = (manifest.app as { theme?: { slots?: Record<string, string> } }).theme;
  if (theme !== undefined) {
    observations.push({
      unit: DRIFT_THEME_UNIT,
      value: THEME_VALUE_LABEL,
      view_id: null,
      view_type: null,
      slots: { ...(theme.slots ?? {}) },
    });
  }

  // 群にまとめる。**件数は observations を数えたものであって、別に持っている数ではない。**
  const groups: DriftGroup[] = [];
  for (const observation of observations) {
    let group = groups.find(
      (candidate) => candidate.unit === observation.unit && candidate.value === observation.value,
    );
    if (group === undefined) {
      group = {
        unit: observation.unit,
        value: observation.value,
        count: 0,
        view_ids: [],
        reached_threshold: false,
      };
      groups.push(group);
    }
    group.count += 1;
    if (observation.view_id !== null) {
      group.view_ids.push(observation.view_id);
    }
  }
  for (const group of groups) {
    group.reached_threshold = group.count >= DRIFT_PROMOTION_THRESHOLD;
  }
  groups.sort(
    (a, b) => b.count - a.count || a.unit.localeCompare(b.unit) || a.value.localeCompare(b.value),
  );

  return {
    app_id: appId,
    threshold: DRIFT_PROMOTION_THRESHOLD,
    counting_rule: DRIFT_SAMENESS_RULE,
    theme_counting_rule: DRIFT_THEME_COUNTING_RULE,
    counted_scope: {
      list_view: DRIFT_COUNTED_PRESET_KEYS.list_view,
      form: DRIFT_COUNTED_PRESET_KEYS.form,
      detail_view: DRIFT_COUNTED_PRESET_KEYS.detail_view,
      // **【`V8-M8` / 台帳 `Q-G1`】画面種別の4種目(集計表)。****中身は空配列である** ——
      // **集計表には `preset_` キーが1本も書けない。****それでも鍵を出しているのは、
      // 応答が「数える対象の全量」を名乗っているからである** —— **黙って落とすと
      // 「集計表は数えていない」のか「集計表には数える対象が無い」のかが読めなくなる。**
      report_view: DRIFT_COUNTED_PRESET_KEYS.report_view,
      theme: DRIFT_THEME_UNIT,
    },
    observations,
    groups,
    proposals: groups
      .filter((group) => group.reached_threshold)
      .map((group) => ({ ...group, proposal: DRIFT_PROMOTION_PROPOSAL })),
    not_counted: notCounted,
    limitations: [
      // **手当て (a)**(04 §8-4 / ADR-0056 §5)。応答そのものに書く。
      DRIFT_ESCAPE_HATCH_NOT_COUNTED,
      DRIFT_THEME_LIMITATION,
      DRIFT_NO_AUTO_PROMOTION,
      DRIFT_NOT_A_GATE,
      // **`V6-M6-T01`(`K-G21a`)**: **参照項目の選び方・探せる項目を1件も数えていないこと。**
      // **数える対象の表(`DRIFT_COUNTED_PRESET_KEYS`)には1語も足していない** ——
      // 足せない理由と、それでも「出す」を履行した形は同定数の doc コメントに書いた。
      DRIFT_REFERENCE_DECLARATIONS_NOT_COUNTED,
    ],
  };
}

/**
 * 参照系9ツールをサーバに登録する。
 *
 * **【2026-08-15。`V8-M13-T02` / 台帳 `Q-G28`。上の1行を1バイトも消していない】**
 * **今日登録するのは10本である**(10本目 = `read_report`)。
 */
/**
 * **ドライランの報告から、認証まわりの表を落とす**(`V10-M28-T03`)。
 *
 * **落とすのは `schema`(実 SQLite の列名)と `impacts`(影響行数)の2つだけである。**
 * **`manifest` / `plan` には `_auth_` が1件も現れない** —— **どちらも差分の操作から
 * 組み立てられ、ユーザ定義のリソースIDは `_` 始まりにできないためである。**
 *
 * **【落とす層がここである理由。カーネルではない】** —— **`src/kernel/dry-run.test.ts` と
 * `src/kernel/apply-diff.test.ts` が「`report.schema` が実 SQLite スキーマの**全量**と
 * 一致する」を固定している。** **カーネルで落とすと、その2本が確実に赤くなる** ——
 * **カーネルのレポートは「複製の上で実際に起きたことの全量」であり、それを絞ると
 * レポートと実適用の一致という土台そのものが崩れる。**
 * **絞ってよいのは「誰に何を返すか」を決める入口の層だけである。**
 *
 * **【これは権限の判定ではない】** —— **`app` × `write` を持つ相手にも落とす。**
 * **判定は上の壁(`denyAppSettingWrite`)が済ませており、ここは「アプリの作りの話に
 * 認証の器を混ぜない」ための整形である。**
 *
 * **【正直に書く。これで隠れないもの】** —— **`get_manifest` は今日どおり定義の全量を
 * 返す**(`D-V8-55` / `D-V8-85`。`U-4` として実施時期未定)。**本関数はそこを1ミリも
 * 動かしていない。** **`_auth_*` の**存在**そのものは、認証の口の応答からも分かる。**
 */
function withoutAuthTables(report: DryRunReport): DryRunReport {
  return {
    ...report,
    schema: Object.fromEntries(
      Object.entries(report.schema).filter(([table]) => !isAuthTableName(table)),
    ),
    impacts: report.impacts.filter((impact) => !isAuthTableName(impact.table)),
  };
}

export function registerReadTools(server: McpServer, options: CreateMcpServerOptions): void {
  const { dataRoot, previewBaseUrl, actor } = options;

  // ===========================================================================
  // **名乗りと主体の解決**(`V8-M31-T02` / `V8-M31-T03`。台帳 `T-G21a` / `T-G21b` / `T-G22`)
  // ===========================================================================
  //
  // **各ツールの冒頭に在った次の4行は、`requireActorAndApp` の中へそのまま入った**
  // (逐語で残す。`src/mcp/actor-guard.ts` の同関数の doc も同じ4行を引いている):
  //
  //       const missing = requireApp(dataRoot, app_id);
  //       if (missing !== null) {
  //         return toolError(missing);
  //       }
  //
  // **前後に足したのは2つだけである** —— (1) **名乗りの有無**(無ければ `isError`。
  // 起動は成功する。`D-V8-46`)、(2) **名乗りをそのアプリの利用者へ解決**(できなければ
  // `isError`。**`requireApp` の後に置く** —— `AuthStore.openForApp` は `CREATE TABLE` を
  // 走らせるので、先に置くとタイプミスした app_id でファイルが生える)。
  //
  // **【この波では、解決できた主体を1ミリも絞っていない】** —— **通ったあとは今日どおりに
  // 動く。** 参照系9本を「絞らない」と決めたのはユーザ決定 `D-V8-55`(**設計図は絞らない**)/
  // `D-V8-85`(**アプリの一覧も絞らない**)であり、**行を読む `list_records` だけは
  // `T06` で絞る**(まだ絞っていない)。
  //
  // **`list_apps` は `app_id` を取らないので解決しない**(名乗りの有無だけを見る)。

  // --- 1. list_apps ---------------------------------------------------------------

  server.registerTool(
    "list_apps",
    {
      description: describeTool(
        "このプラットフォーム上に存在するアプリの一覧(app_id / 名前 / 作成日時 / 状態)を返します。" +
          "他のツールに渡す app_id はここで取得してください。アプリが1件も無い場合は空の配列を返します。",
      ),
      inputSchema: {},
    },
    () => {
      // **解決しない**(`app_id` を取らないので、どのアプリの利用者として解決するかを
      // 決められない)。**名乗りの有無だけを見る** —— `D-V8-85` の逐語
      // 「**アプリの一覧も絞らない**」により、通ったあとは今日どおり全件返す。
      const unnamed = requireActor(actor);
      if (unnamed !== null) {
        return toolError(unnamed);
      }
      const store = KernelMetaStore.open(dataRoot);
      try {
        return toolOk({ apps: store.listApps() });
      } finally {
        store.close();
      }
    },
  );

  // --- 2. get_manifest ------------------------------------------------------------

  server.registerTool(
    "get_manifest",
    {
      description: describeTool(
        "指定したアプリの現行マニフェスト(テーブル・フィールド・ビューの定義そのもの)を返します。" +
          "差分(apply_diff)を組み立てる前に、必ずこれで現状を確認してください。" +
          "併せて system_tables に、読み取り専用のシステムテーブル(_apps / _changelog)の" +
          "列定義を返します。マニフェスト本体には現れませんが、list_view / detail_view の" +
          "table には指定できます。",
      ),
      inputSchema: { app_id: appIdArg },
    },
    ({ app_id }) => {
      const guard = requireActorAndApp(dataRoot, app_id, actor);
      if (!guard.ok) {
        return toolError(guard.errors);
      }
      // AI がソースを読めない条件下で `_apps` の存在と列名を知れる唯一の経路が
      // ここである(ADR-0006 §10)。`manifest` 本体は不変で、**兄弟フィールドとして
      // 並べる**のであってマニフェストの中に混ぜない(ADR-0006 §5 / §1 限定1)。
      return toolOk({
        manifest: readCurrentManifest(dataRoot, app_id),
        system_tables: SYSTEM_TABLES,
      });
    },
  );

  // --- 3. get_changelog -----------------------------------------------------------

  server.registerTool(
    "get_changelog",
    {
      description: describeTool(
        "指定したアプリの変更履歴(いつ・どんな意図で・どんな操作が適用されたか、" +
          "および undo の記録)を古い順に返します。undo の対象になるのは最後の apply です。",
      ),
      inputSchema: { app_id: appIdArg },
    },
    ({ app_id }) => {
      const guard = requireActorAndApp(dataRoot, app_id, actor);
      if (!guard.ok) {
        return toolError(guard.errors);
      }
      return toolOk({ changelog: getChangelog(dataRoot, app_id) });
    },
  );

  // --- 4. get_preview_url ---------------------------------------------------------

  server.registerTool(
    "get_preview_url",
    {
      description: describeTool(
        "指定したアプリ(または特定のビュー)を人間がブラウザで確認するためのURLを返します。" +
          "view_id を省略するとアプリのビュー一覧画面、指定するとそのビューの画面のURLになります。" +
          "変更を適用したあとは、このURLをユーザに提示して実物を見てもらってください。" +
          // V0-P7-T04 / F-26。002/T3 で AI が URL を手で書き写して打ち間違え、
          // 同じメッセージ内で自分で訂正した。実害は無かったが、URL は人間が
          // 実物を見るための唯一の導線なので1行足しておく。
          PREVIEW_URL_VERBATIM,
      ),
      inputSchema: {
        app_id: appIdArg,
        view_id: z
          .string()
          .optional()
          .describe("表示したいビューのID。省略するとアプリのビュー一覧画面になる。"),
      },
    },
    ({ app_id, view_id }) => {
      const guard = requireActorAndApp(dataRoot, app_id, actor);
      if (!guard.ok) {
        return toolError(guard.errors);
      }

      if (view_id === undefined) {
        return toolOk({
          url: `${previewBaseUrl}${routePath({ kind: "app", appId: app_id })}`,
          note: PREVIEW_NOTE,
        });
      }

      // 実在しないビューでも URL 自体は組み立てられてしまう。だが開けば 404 になるので、
      // 「URL が返った = 見せられる」という誤認を作らないよう、ここで弾く。
      const manifest = readCurrentManifest(dataRoot, app_id);
      if (!viewIds(manifest).includes(view_id)) {
        return toolError([
          {
            path: "/view_id",
            message: `ビュー "${view_id}" はアプリ "${app_id}" に存在しません。`,
            allowed_values: viewIds(manifest),
            hint: "get_manifest で実在するビューIDを確認するか、先に add_view でビューを追加してください。",
          },
        ]);
      }

      return toolOk({
        url: `${previewBaseUrl}${routePath({ kind: "view", appId: app_id, viewId: view_id })}`,
        note: PREVIEW_NOTE,
      });
    },
  );

  // --- 5. list_records ------------------------------------------------------------

  server.registerTool(
    "list_records",
    {
      description: describeTool(
        "指定したテーブルに入っているレコードを返します。records は limit / offset で絞られますが、" +
          "total は常にテーブル全体の件数なので、まだ見ていないレコードがあるかを判断できます。" +
          // **【`V8-M32-T02`(2026-08-12)。`V8-M31` 第6波 / `ADR-0327` の波及。
          // 旧文を1バイトも消していない】** **`total` は絞ったあとの可視集合の件数になった。**
          "**訂正します。直前の「total は常にテーブル全体の件数」は今日は偽です** —— " +
          "行ごとの付与を宣言した表と st_owner を持つ表では、" +
          "ST_MCP_ACTOR で名乗った人に見える行だけを数えた件数が返ります。" +
          "件数の多いテーブルは limit で1ページ分を取り、offset を増やして続きを取得できます" +
          "(offset + 返った件数 < total なら、まだ続きがあります)。" +
          "並べ替えたい場合は sort にフィールドIDを指定してください(order だけの指定はできません)。" +
          "複数のキーで並べ替えたい場合は、sort に " +
          '[{ "field": "<フィールドID>", "order": "asc" }, …] の配列を書きます' +
          "(update_view の sort とまったく同じ形です。先頭が第1キーで、値が同じときに次のキーで決まります)。" +
          "{ field, order } の形で書いたときは向きがキーごとに書かれているので、引数の order は指定できません。" +
          "table_id には読み取り専用のシステムテーブル(_apps / _changelog)も指定できます。",
      ),
      inputSchema: {
        app_id: appIdArg,
        table_id: z.string().describe("対象テーブルのID。get_manifest で取得できる。"),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("返すレコードの最大件数。省略すると全件。total は絞られない。"),
        offset: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            "先頭からスキップする件数(続きの取得に使う)。省略すると先頭から。total は絞られない。",
          ),
        sort: z
          .union([z.string(), sortKeyArg, z.array(sortKeyArg)])
          .optional()
          .describe(
            "並べ替え。フィールドID(文字列。向きは order 引数)/ { field, order } / " +
              "{ field, order } の配列(複合ソート)のいずれかで書く。" +
              "後ろ2つは update_view の sort とまったく同じ形で、" +
              "配列は先頭が第1キー・値が同じときに次のキーで決まる。",
          ),
        order: z
          .enum(SORT_ORDERS)
          .optional()
          .describe(
            "並べ替えの向き。sort をフィールドID(文字列)で書いたときにのみ指定できる。既定は asc。" +
              "sort を配列で書いたときは、向きは各要素の order に書く。",
          ),
      },
    },
    ({ app_id, table_id, limit, offset, sort, order }) => {
      const guard = requireActorAndApp(dataRoot, app_id, actor);
      if (!guard.ok) {
        return toolError(guard.errors);
      }

      // order だけ渡されたケースを黙って無視すると「降順で取れたつもり」の
      // 誤解が残る。何を足せば直るかを示して弾く(憲法6: 黙って化けさせない)。
      if (sort === undefined && order !== undefined) {
        return toolError([
          {
            path: "/sort",
            message:
              "order を指定する場合は、並べ替えに使うフィールドIDを sort にも指定してください。",
            hint: '例: { sort: "created_on", order: "desc" }',
          },
        ]);
      }

      // sort を { field, order } の形(単数・配列)で書いた場合、向きは**キーごと**に
      // 書かれているので、引数の order は当て先を持たない。黙って捨てると
      // 「その向きにしたつもり」の誤解が残る(上の order 単独と同じ理由)。
      if (typeof sort === "object" && order !== undefined) {
        return toolError([
          {
            path: "/order",
            message:
              "sort を { field, order } の形で書いた場合、引数の order は指定できません。" +
              "向きは各キーの order で指定してください。",
            hint: '例: { sort: [{ field: "rating", order: "desc" }, { field: "title", order: "asc" }] }',
          },
        ]);
      }

      const manifest = readCurrentManifest(dataRoot, app_id);

      // =====================================================================
      // **行の判定と項目の面**(`V8-M31-T06`。台帳 `T-G23b` / `T-G24`)
      // =====================================================================
      //
      // **HTTP の一覧(`GET /records`)と同じ形・同じ順序で当てる**(`ADR-0003` §7:
      // 入口を何本生やしても振る舞いが一致する)。**判定は `owner-scope.ts` の関数だけが
      // 持ち、ここに規則を読む条件式を1行も書いていない。**
      //
      // **【システムが持つ表(`_apps` / `_changelog`)には1バイトも掛からない】** ——
      // **`judgeRoleAccess` がシステムの表を1度も判定しない**(`D-V8-69`)ので、
      // 下の関門は素通りし、項目の射影も表の定義が無いので何も落とさない。
      // **HTTP は `D-V8-74` により、システムの表の読取を持ち主だけに絞っている** ——
      // **MCP にその1本は入れていない。揃っていない。**
      const roles = guard.value.roles;
      const actorId = guard.value.id;
      const table = manifest.app.tables.find((candidate) => candidate.id === table_id);
      // **行ごとのアクセス権(点)。宣言していない表では `undefined`**(オプトイン)。
      const accessSources = recordAccessSourceTables(manifest, table_id);
      // **面(役割に束ねた権限)の**表**の規則 —— 読取。** **この1回は行を渡していない。**
      const roleTableRead = judgeRoleAccess({
        manifest,
        roles,
        target: { target: "table", table: table_id },
        verb: "read",
      });
      // **読めない表は断らない** —— **応答から落とす**(空の一覧)。**「その表が在る」ことを
      // 役割の外へ漏らさない側に倒す**(HTTP と同じ向き。`ADR-0305` 限定11)。
      // **`total` も可視集合から採るので 0 である**(母集団を割らない)。
      // **点が管轄内の表では、ここで止めない**(`D-V8-23` の `OR`)。
      if (
        roleGateBlocksWithoutGrants({
          role: roleTableRead,
          grantGoverned: accessSources !== undefined,
        })
      ) {
        return toolOk({ records: [], total: 0 });
      }
      // **面の**項目**の規則。** **3つの分岐すべてに掛ける** —— 1本でも抜けるとその経路
      // だけ静かに漏れる。**射影は `owner-scope.ts` の1本である。**
      const dropHidden = (row: Record<string, unknown>): Record<string, unknown> =>
        projectForRoleFields({ manifest, table, row, roles, subject: actorId });
      // **個人スコープ(`st_owner`)の絞り込み**(`V8-M31` 第6波・裁定 `M31-13`)。
      //
      // **HTTP の一覧(`GET /records`)と同じ式である**(`src/server/app.ts`)——
      // **`( 自分の行 or 共有行 ) or 面が読取を許している`。** **後半は `D-V8-35` が
      // 開いた側であり、`roleReadCrossesOwnerScope` 1本に閉じている**(ここに
      // 「どのロールが / どの宣言のとき」の条件式を1行も書かない)。
      //
      // **【この1本は、今日どの形でも答えを1件も変えない。誇張しない】** ——
      // **実測(`src/mcp/actor-authz.test.ts` の (E-7b) / (E-7c))はこうである:**
      //  - **面がこの表を名指ししているとき** —— **`roleReadCrossesOwnerScope` が真になり、
      //    下の `&&` に同じ項が立っているので、`( A or B ) and B` は `B` に畳まれる。**
      //  - **面が1本も名指ししていないとき** —— **`V8-M26`(既定を閉じた)により、
      //    上の `roleGateBlocksWithoutGrants` が一覧を空にして手前で抜ける。**
      //
      // **【それでも入れる理由】** —— **HTTP の一覧(`src/server/app.ts`)にまったく同じ式が
      // 立っており、そちらも同じ理由で今日は答えを変えていない。** **片方にだけ無いと、
      // 既定の開閉や面の式が動いた日に、読取だけが静かに割れる。**
      // **着手前の実測(`m31-after.md` §5-1 (a))で MCP の一覧が絞れていたのは、
      // `st_owner` を持つ表を `add_table` したときにカーネルが3役割へ自動で足す
      // **条件つきの規則**の副作用であって、個人スコープの配線ではなかった。**
      //
      // **【代償を隠さない】** **`st_owner` を持つ表は、これ以降つねに全行を読んでから
      // JS で絞る**(`postFiltered`)—— **カーネルの `LIMIT` / `OFFSET` は使われない。**
      // **HTTP の一覧とまったく同じ代償である。**
      const ownerField = table === undefined ? undefined : personalOwnerField(table);
      const ownerVisible = (row: Record<string, unknown>): boolean =>
        ownerField === undefined ||
        isOwnerVisible(row[OWNER_FIELD], actorId) ||
        roleReadCrossesOwnerScope({ manifest, roles, table: table_id, row, subject: actorId });
      // **判定は SQL に落とせない** —— **絞る分岐では全行を読んでから JS で絞り、絞った
      // あとの集合を母集団として `total` を数える**(HTTP と同じ代償: 全件をメモリに読む)。
      // **【`V8-M31` 第6波で1項足した。旧を逐語で残す】**
      // **旧: `const postFiltered = accessSources !== undefined || roleTableRead.conditional;`**
      // **`st_owner` を持つ表も JS で絞る側に入れた**(上の `ownerVisible` を当てるため)。
      const postFiltered =
        accessSources !== undefined || roleTableRead.conditional || ownerField !== undefined;

      // `exactOptionalPropertyTypes` があるため、undefined を代入するのではなく
      // キー自体を足さない形で組み立てる。limit / offset は**読取層(カーネル)の LIMIT/OFFSET**
      // に渡す(JS slice ではなく。EC-G11 / ADR-0042 限定5: HTTP と同一意味論)。
      const listOptions: ListRecordsOptions = {};
      if (sort !== undefined) {
        // カーネルの `ListRecordsOptions.sort` は v1(V1-M0-T03 / ADR-0009)から
        // `Sort | Sort[]` を受ける。**ここは入口を開けるだけで、カーネルに1バイトも
        // 足していない**(HTTP の `parseListOptions` は既に複合ソートを渡していた。
        // 1キーに縛られていたのは MCP 層だけだった。V3-M12-T10)。
        // 表記の正規化(単数 / 配列)はカーネルの `normalizeSort` が唯一の入口なので、
        // ここでは配列に畳まずに**書かれた形のまま**渡す —— そうしないとエラーの
        // JSON Pointer が書いた形とずれる(`sortErrorPath`。ADR-0009 限定2 により
        // `normalizeSort` を MCP 層から呼ぶ必要も無い)。
        // 空配列はカーネルの `validateSortKeys` が `/sort` で弾く —— 検証の正は
        // カーネル1つなので、MCP 層で先回りして別の文言を作らない(ADR-0003 §7)。
        listOptions.sort = typeof sort === "string" ? { field: sort, order: order ?? "asc" } : sort;
      }
      // **絞る分岐ではページング前の全行が要る**(HTTP と同じ)。
      if (limit !== undefined && !postFiltered) {
        listOptions.limit = limit;
      }
      if (offset !== undefined && !postFiltered) {
        listOptions.offset = offset;
      }

      // 読み取りは3本すべてファサード経由にする。`readRecordCount` を覆い漏らすと、
      // 一覧は取れているのに total で落ちてツール全体が isError になり、`_apps` を
      // 読もうとした AI には「テーブルが存在しません」だけが見える(ADR-0006 §7b)。
      return withReadSource(dataRoot, app_id, (source) => {
        const records = readRecordList(source, manifest, table_id, listOptions);
        if (!records.ok) {
          // **隠した項目のIDを、読取の 400 から数え上げさせない**(HTTP と同じ射影)。
          return toolError(scrubHiddenFieldIds(manifest, table, records.errors));
        }
        if (postFiltered) {
          // **行ごとの判定**(`V8-M31-T06`)。**面と点は `resolveCombinedRecordAccess` の
          // 中で `OR` に重なっている** —— **ここに合成の式は1行も無い。**
          const { readRows, readRow } = memoizedRowReaders(source, manifest);
          const judged = records.value.map((row) => ({
            row: row as unknown as Record<string, unknown>,
            access:
              accessSources === undefined
                ? undefined
                : resolveCombinedRecordAccess({
                    manifest,
                    tableId: table_id,
                    row: row as unknown as Record<string, unknown>,
                    actorId,
                    roles,
                    sources: accessSources,
                    readRows,
                    readRow,
                  }),
          }));
          // **1行でも上限に当たったら要求全体を断る**(`Z-G17`)—— **黙って行を落とすと、
          // 上限に当たった状態と「本当に見えない」状態が応答の上で区別できなくなる。**
          const limited = judged.find((entry) => entry.access?.kind === "limit_exceeded")?.access;
          if (limited?.kind === "limit_exceeded") {
            return toolError([recordAccessLimitError(limited.limit)]);
          }
          const visible = judged
            .filter(
              (entry) =>
                // **【`V8-M31` 第6波で1項足した。旧を逐語で残す】** **旧はこの `ownerVisible`
                // の行が無く、下の三項演算子だけだった。** **重ね順は `AND` である** ——
                // **HTTP の一覧と同じで、個人スコープは面・点を1ミリも上書きしない。**
                ownerVisible(entry.row) &&
                (entry.access === undefined
                  ? // **条件つきの読取規則だけが立っている表**(点は管轄外)。
                    judgeRoleAccess({
                      manifest,
                      roles,
                      target: { target: "table", table: table_id },
                      verb: "read",
                      row: entry.row,
                      subject: actorId,
                    }).allowed
                  : entry.access.kind === "verdict" && entry.access.verdict.read),
            )
            .map((entry) => entry.row);
          return toolOk({
            // **合計は絞ったあとの可視集合から採る**(HTTP と同じ。母集団を割らない)——
            // **`total` はもう「テーブル全体の件数」ではない。**
            records: slicePage(visible, limit, offset).map((row) => dropHidden(row)),
            total: visible.length,
          });
        }
        // total はテーブル全体の件数(limit / offset に左右されない)。list_records は filter を
        // 受けないので、ここは全件数になる(HTTP の filter 適用後 total とは入力が違うだけで整合)。
        const total = readRecordCount(source, manifest, table_id);
        if (!total.ok) {
          return toolError(total.errors);
        }
        return toolOk({
          records: records.value.map((row) =>
            dropHidden(row as unknown as Record<string, unknown>),
          ),
          total: total.value,
        });
      });
    },
  );

  // --- 6. preview_undo ------------------------------------------------------------

  server.registerTool(
    "preview_undo",
    {
      description: describeTool(
        "直前に適用した変更を undo した場合に何が起きるかを、実際には何も変えずに返します。" +
          "返るのは、取り消される操作(operations)、失われるレコード件数(lost_records)、" +
          "復活するレコード件数(restored_records)、内容が編集前に戻るレコード件数(changed_records)、" +
          "そして定義ごと消えるテーブル・ビュー・ワークフロー・関数(removed_resources)です。" +
          "undo はレコードを失い、テーブルやビューやワークフローの定義を消すことがあるため、" +
          "実行前に必ずこれを呼び、removed_resources と各件数をそのまま(operations から推測せず)" +
          "ユーザに伝えて確認を取ってください。",
      ),
      inputSchema: { app_id: appIdArg },
    },
    ({ app_id }) => {
      const guard = requireActorAndApp(dataRoot, app_id, actor);
      if (!guard.ok) {
        return toolError(guard.errors);
      }
      const result = previewUndo(dataRoot, app_id);
      if (!result.valid) {
        return toolError(result.errors);
      }
      return toolOk({ preview: result.preview });
    },
  );

  // --- 6b. preview_redo(V1-M9-T05 / ADR-0032)-------------------------------------
  //
  // **参照系である** —— 状態を1バイトも変えない。redo の前に「戻るもの・失われるもの」を
  // 数えて人間に見せるための窓であり、返す形は preview_undo と同じ `UndoPreview` にそろえる。

  server.registerTool(
    "preview_redo",
    {
      description: describeTool(
        "直前に実行した undo をやり直した(redo)場合に何が起きるかを、実際には何も変えずに返します。" +
          "返るのは、redo で復活するレコード件数(restored_records)、失われるレコード件数(lost_records)、" +
          "内容が編集前後に戻るレコード件数(changed_records)、そして対象となる直前の undo の情報です。" +
          "redo はレコードを失うことがある(その undo のあとに追加した行など)ため、" +
          "実行前に必ずこれを呼び、各件数をそのままユーザに伝えて確認を取ってください。" +
          "やり直せる undo が無い(undo をまだ実行していない/直前の undo が既に redo 済み)ときは" +
          "その旨を返します。",
      ),
      inputSchema: { app_id: appIdArg },
    },
    ({ app_id }) => {
      const guard = requireActorAndApp(dataRoot, app_id, actor);
      if (!guard.ok) {
        return toolError(guard.errors);
      }
      const result = previewRedo(dataRoot, app_id);
      if (!result.valid) {
        return toolError(result.errors);
      }
      return toolOk({ preview: result.preview });
    },
  );

  // --- 7. dry_run_diff(V1-M1-T02)---------------------------------------------------

  server.registerTool(
    "dry_run_diff",
    {
      description: describeTool(
        "差分パッチを**適用せずに**、複製の上で実際に適用して結果を返します。" +
          "何が起きるか(適用後のテーブル定義、影響を受ける行数、拒否されるならその理由)を、" +
          "本体を1バイトも変えずに確かめる手段です。" +
          "引数は apply_diff とまったく同じなので、ここで通った差分をそのまま apply_diff へ渡せます。" +
          "拒否された場合に返るエラーは apply_diff が返すものと同一です。" +
          "レポートの impacts には、テーブルごとの適用前後の行数・増減した列・影響行数が入ります。" +
          "破壊的な op(remove_field / remove_table / change_table / change_field)を含む差分では、" +
          "**apply_diff より先に必ずこれを呼んでください。**\n" +
          // **【`V10-M28-T02` / `T03`】壁と、返さないものを、道具の説明そのものに書く。**
          // **書かないと、断られた AI は「アプリが壊れている」と読んで差分を書き直し続ける。**
          "このツールは apply_diff とまったく同じ権限を要求します —— " +
          '役割の規則に「アプリの設定を変更できる」(target: "app" / can: ["write"])が' +
          "与えられていない人は、ドライランの段で断られます" +
          "(**役割の規則を1本も書いていないアプリでは、持ち主でも断られます。" +
          "set_roles でその規則を書き戻してください**)。" +
          "レポートは、そのアプリ自身のテーブルだけを返します —— " +
          "ログイン・セッション・役割の付与などを保管する予約テーブルは含みません。\n" +
          DRY_RUN_NOTE +
          "\n" +
          // V1-M1-T06。フローの第1段がこのツールである。続きの4段もここに置く ——
          // ここに無いと、AI は「ドライランはした」で満足して確認を飛ばしうる。
          DESTRUCTIVE_CHANGE_FLOW +
          "\n" +
          UNDO_ROLLBACK_LIMIT,
      ),
      inputSchema: { app_id: appIdArg, diff: diffArg },
    },
    ({ app_id, diff }) => {
      const guard = requireActorAndApp(dataRoot, app_id, actor);
      if (!guard.ok) {
        return toolError(guard.errors);
      }

      // **アプリの設定に触れるか**(`V10-M28-T02`)。**`apply_diff` とまったく同じ判定・
      // まったく同じ順序である** —— **`intent` の検査より**前**に置く。**
      // **後ろに置くと、変更する権限を1つも持たない相手に `intent` の妥当性が返り、
      // 「この差分は形としては通る」ところまで教えることになる。**
      // **【この壁が新しく閉じるもの。隠さない】** —— **役割の規則を1本も書いていない
      // アプリでは、`judgeRoleAccess` が既定で閉じるので、**持ち主にも断られる**。
      // `apply_diff` は着手前からそうであり、ここが揃っただけである** ——
      // **`ADR-0375` が開いたアプリの集合と、ここで閉じるアプリの集合は同じである。**
      const forbidden = denyAppSettingWrite(dataRoot, app_id, guard.value.roles);
      if (forbidden !== null) {
        return toolError(forbidden);
      }

      // intent の必須・非空は apply_diff と同じ位置・同じ文面で弾く(`/diff/intent`)。
      // ここを緩めると「ドライランは通ったのに apply_diff で弾かれる」が起きる。
      if (diff.intent === undefined || diff.intent.trim() === "") {
        return toolError([
          {
            path: "/diff/intent",
            message:
              diff.intent === undefined
                ? '必須プロパティ "intent" がありません。'
                : "intent が空です。1文字以上の値を指定してください。",
            hint:
              "この変更で何をしたいのかを、ユーザの言葉のままの日本語で書いてください" +
              "(例: 「読み終わった日を記録したい」)。変更履歴にそのまま残ります。",
          },
        ]);
      }

      const result = dryRunDiff(dataRoot, app_id, diff);
      if (!result.valid) {
        return toolError(result.errors);
      }
      // **報告から認証まわりを落とす**(`V10-M28-T03`)。**カーネルが返したレポートは
      // 全量のままであり、絞っているのはこの1行だけである。**
      return toolOk({ report: withoutAuthTables(result.report) });
    },
  );

  // --- 8. generate_requirements_doc(V1-M8-T02 / ADR-0025)---------------------------

  server.registerTool(
    "generate_requirements_doc",
    {
      description: describeTool(
        "指定したアプリの要件定義書を、その時点のマニフェストと変更履歴だけから機械的に生成して返します。" +
          "概要・機能一覧・画面・データ・自動化・履歴の6節に分かれており、" +
          "**すべての記述が出典(マニフェストの JSON Pointer、または changelog の seq と diff_id)を持ちます。**" +
          "生成に AI は1つも関与しません —— 決まったテンプレートに、マニフェストと変更履歴から取った値を" +
          "差し込んでいるだけなので、出典に無いことは書かれません。" +
          "format に markdown(既定)を指定すると人間に見せられる文書本文と記述ごとの出典表を、" +
          "json を指定すると記述の配列(節・テンプレートID・スロット・出典)を返します。" +
          "section を指定すると、その節の記述だけに絞れます。" +
          "この結果は**保存されません**。呼ぶたびにその時点の状態から作り直されるので、" +
          "変更を適用したあとに呼べば必ず最新になります。" +
          "履歴に現れるのは create_app によるアプリ作成と apply_diff 経由の変更だけで、" +
          "レコードの追加・編集は要件定義書にも現れません。",
      ),
      inputSchema: {
        app_id: appIdArg,
        format: z
          .enum(["markdown", "json"])
          .optional()
          .describe(
            "返す形式。markdown(既定)は文書本文と記述ごとの出典表、json は記述の配列を返す。",
          ),
        section: z
          .enum(REQUIREMENT_SECTIONS)
          .optional()
          .describe("絞り込む節。省略すると全節を返す。"),
      },
    },
    ({ app_id, format, section }) => {
      const guard = requireActorAndApp(dataRoot, app_id, actor);
      if (!guard.ok) {
        return toolError(guard.errors);
      }

      const doc = generateRequirementsDoc(dataRoot, app_id);
      const statements: RequirementStatement[] =
        section === undefined
          ? doc.statements
          : doc.statements.filter((statement) => statement.section === section);
      // 節で絞ったときは markdown も絞った statements から**カーネルに描き直させる**
      // (入口層で markdown を切り貼りしない。ADR-0025 限定9)。
      const markdown =
        section === undefined ? doc.markdown : renderRequirementsMarkdown(statements);

      if (format === "json") {
        return toolOk({
          requirements_doc: {
            app_id: doc.app_id,
            format: "json",
            section: section ?? null,
            statements,
            markdown,
            identifiers: doc.identifiers,
          },
        });
      }

      // markdown 単体では出典欄が消えるので、記述ごとの出典表を必ず添える
      // (「全記述が出典を持つ」ことが本ツールの主張そのものである)。
      return toolOk({
        requirements_doc: {
          app_id: doc.app_id,
          format: "markdown",
          section: section ?? null,
          markdown,
          sources: statements.map((statement) => ({
            statement_id: statement.id,
            text: statement.text,
            sources: statement.sources,
          })),
        },
      });
    },
  );

  // --- 9. report_drift(V3-M5-T04 / `D-G10a`。ADR-0056)-------------------------------
  //
  // **参照系である** —— マニフェストを読んで数えるだけで、DB もファイルも1バイトも変えない。
  // **閾値は引数に置かない**(置けば呼ぶ側が値を選べてしまい、「コード定数に固定する」= 完了条件4
  // が実質破れる)。**出口は MCP 応答であって要件定義書ではない**(完了条件5。ADR-0025 限定11 /
  // 限定12 に触れずに済む側を採った。代償 = 01 §4 D-G10 行の「逸脱は要件ドキュメントに必ず
  // 列挙する」という約束は履行されない。計画側の補正は T06 へ申し送る)。

  server.registerTool(
    "report_drift",
    {
      description: describeTool(
        "指定したアプリのマニフェストを読み、画面ごとの調整(preset_ で始まるキー)とテーマが" +
          "どれだけ同じ形で繰り返されているかを数えて返します。" +
          `同じキーに同じ値が ${DRIFT_PROMOTION_THRESHOLD} 画面以上で使われていれば、` +
          "テンプレート/プリセットへの昇格を**提案**します。" +
          "**提案するだけです** —— 何もブロックせず、1バイトも書き込まず、" +
          "テンプレートが自動で書き換わることもありません。" +
          "昇格するかどうかは人間が決め、実際の変更は apply_diff で適用します。" +
          "**返るのは件数だけではありません** —— どの画面のどのキーがどの値だったかを" +
          "observations に1件ずつ全件挙げるので、groups の件数はその列挙から数え直せます。" +
          "数えなかったものは not_counted に理由つきで挙がります" +
          // **V4-M16-T11(ADR-0091 限定8。Δ5)**: 旧例は逐語「(入力フォームにはプリセットを
          // 1軸も書けない、など)。」だった。**今日から偽である**(ADR-0091 が form に2軸を
          // 通した)ので、**今日も真である例に差し替えた。**
          "(その画面種別ではスキーマがそのキーを false に落としている、など)。" +
          DRIFT_SAMENESS_RULE +
          DRIFT_THEME_COUNTING_RULE +
          "【この数え方の限界】" +
          DRIFT_ESCAPE_HATCH_NOT_COUNTED +
          DRIFT_THEME_LIMITATION +
          // **`V6-M6-T01`(`K-G21a`)**: **応答の limitations に載せるだけでなく、
          // ツールの説明文にも書く** —— **説明文だけを読む AI が「選び方の重複も
          // ここで見つかる」と読まないためである。**
          DRIFT_REFERENCE_DECLARATIONS_NOT_COUNTED,
      ),
      inputSchema: { app_id: appIdArg },
    },
    ({ app_id }) => {
      const guard = requireActorAndApp(dataRoot, app_id, actor);
      if (!guard.ok) {
        return toolError(guard.errors);
      }
      return toolOk({
        drift_report: buildDriftReport(app_id, readCurrentManifest(dataRoot, app_id)),
      });
    },
  );

  // --- 10. read_report(V8-M13-T02 / 台帳 `Q-G28`。門A 本審査 = `V8-M7`)---------------
  //
  // **集計表を1枚読む。** **道具はこれで24本になった**(限定1: 24本を超えない)。
  //
  // ## **【限定4 と限定5 の両方をどう満たしているか。ここが本ツールの要点である】**
  //
  // - **限定4(集計の計算を `src/mcp/` に1行も書かない)**: **束ね方も丸め方も並び順も、
  //   ここには1文字も無い。** **判定を呼ぶことは限定5 の帰結であって違反ではない**
  //   (`v8-m7.md:670`)。
  // - **限定5(可視性の判定を必ず通す)**: **`src/kernel/report.ts` の `computeReport()` を
  //   ここから直接呼ぶと、可視性を1ミリも通らない。** **呼ぶのは `src/server/app.ts` の
  //   `readVisibleReport()`** —— **HTTP の `GET /api/apps/:app_id/views/:view_id/report` が
  //   呼ぶのと**同じ1本**である。** **母集団の答えを出すのは `owner-scope.ts` の
  //   `judgeRecordPopulation` であり、ここに条件式は1つも無い。**
  //
  // **`src/mcp/` から `src/server/` を import する形は、着手前から4箇所実在する**
  // (`vocabulary.ts` / `read.ts` / `write.ts` の `owner-scope.ts` と `errors.ts`)——
  // **新しい種類の依存を1つも作っていない。**
  //
  // ## **主体を渡す引数を1つも作っていない**(`ADR-0327` の ③-1)
  //
  // **名乗りは起動時に一度だけ決める**(`D-V8-46` の逐語)。**引数に足すのは
  // `ADR-0327` が明示的に却下した案そのものである。** **`requireActorAndApp` が
  // 解決した主体をそのまま渡す。**
  //
  // ## **`anonymousPublic` は必ず `false` である**
  //
  // **MCP には未ログインの経路が1本も無い** —— **名乗りが無ければ手前で `isError` になり、
  // 名乗りがあれば必ず実在の利用者へ解決されている。** **HTTP 側の分岐1(匿名公開)は
  // ここからは1度も踏まれない。**
  //
  // ## **【正直に書く】揃っていないもの**
  //
  // 1. **並べ替えのクエリ(`sort_target` / `sort_index` / `sort_order`)を受けていない** ——
  //    **HTTP は受ける。** **宣言に書いた順序だけが効く。**
  // 2. **`sum_field` の側の穴は1バイトも塞いでいない**(限定6)—— **触っていない。**
  server.registerTool(
    "read_report",
    {
      description: describeTool(
        "集計表(report_view)の画面を1枚計算して、束ねた群(groups)と全体の合計(totals)を返します。" +
          "宣言に書いてある束ね方・集計・並べ替えのとおりに計算するだけで、引数で式を変えることはできません。" +
          "返る値はあなた(ST_MCP_ACTOR で名乗った利用者)に見える行だけを数えたものです" +
          "——同じ画面でも名乗る人が違えば数が変わります。" +
          "totals は全体の合計であって、返した群の合計ではありません" +
          "(groups を limit で切っても total_groups と totals は切る前の全体のままです)。" +
          "limit を省略すると先頭100群までを返します。" +
          "対象の画面が集計表でない場合や、読む行が多すぎて上限を超えた場合は、理由を errors で返します" +
          "(その場合、部分的な集計は1つも返しません)。",
      ),
      inputSchema: {
        app_id: appIdArg,
        view_id: z.string().describe("集計表(report_view)の画面ID。get_manifest で取得できる。"),
        limit: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("返す群の最大件数。省略すると先頭100群。total_groups と totals は絞られない。"),
        offset: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("先頭からスキップする群の数(続きの取得に使う)。省略すると先頭から。"),
      },
    },
    ({ app_id, view_id, limit, offset }) => {
      const guard = requireActorAndApp(dataRoot, app_id, actor);
      if (!guard.ok) {
        return toolError(guard.errors);
      }
      const manifest = readCurrentManifest(dataRoot, app_id);
      const view = manifest.app.views.find((candidate) => candidate.id === view_id);
      // **統一形式に直すのはこの2本だけである**(`get_preview_url` の view_id 検査と同型)。
      // **文面は HTTP の口(`src/server/app.ts`)と同じ作り方にしてある** ——
      // **入口が違っても LLM が読むメッセージが同じになる**(`ADR-0003` §7)。
      if (view === undefined) {
        return toolError([
          {
            path: "/view_id",
            message: `ビュー "${view_id}" はこのアプリのマニフェストにありません。`,
            allowed_values: reportViewIds(manifest),
            hint: "get_manifest で実在する集計表の画面IDを確認するか、先に add_view で report_view を追加してください。",
          },
        ]);
      }
      if (view.type !== "report_view") {
        return toolError([
          {
            path: "/view_id",
            message: `画面 "${view_id}" は集計表(report_view)ではありません(${view.type})。`,
            allowed_values: reportViewIds(manifest),
            hint: "集計表の画面IDを指定するか、その画面に report を宣言した report_view を add_view で追加してください。",
          },
        ]);
      }
      // **可視性の注入と上限の判定は、HTTP とまったく同じ1本が持つ**(限定5)。
      const result = readVisibleReport({
        dataRoot,
        manifest,
        view,
        roles: guard.value.roles,
        subject: guard.value.id,
        // **MCP に未ログインの経路は1本も無い**(上を参照)。
        anonymousPublic: false,
      });
      if (!result.ok) {
        // **部分的な結果を1バイトも返さない** —— **上限に当たったことは `message` の
        // 文面だけが語る**(「どの上限か」を載せる専用のキーは1本も無い。
        // 実測は `src/mcp/tools/read-report.test.ts` の (C-1))。
        return toolError(result.errors);
      }
      return toolOk({
        // **切るのは `groups` だけである**(`D-V8-129`)—— **`total_groups` も `totals` も
        // 切る**前**の全体のままである。** **既定は HTTP と同じ定数1本を使う。**
        groups: slicePage(result.value.groups, limit ?? REPORT_DEFAULT_GROUP_LIMIT, offset),
        total_groups: result.value.total_groups,
        totals: result.value.totals,
      });
    },
  );

  // --- 12. list_comments ----------------------------------------------------------
  //
  // **【`V10-M12-T01`。台帳 `CM-G7` = 限定採用(門A)。門A 本審査 = `V10-M9`。
  //   `docs/adr/0368-mcp-comment-read-tool.md`】**
  //
  // **25本目の道具である。** **`ADR-0346` §1 の限定1「道具は24本を超えない」を
  // `ADR-0368` が引き直した**(引き直したのは §1 の見出しと限定1 の1点ちょうどであり、
  // `ADR-0346` の限定2〜限定20 は1つも引き直していない)。
  //
  // **【この道具が持つもの・持たないもの】**
  //
  // - **可否の判定を1つも持たない**(限定3)—— **`judgeRoleAccess` を1度も呼ばず、
  //   `visibleComments()` 1本だけを通る。** **見えるかどうかの条件式はこの範囲に1行も無い。**
  // - **宛先(`anchor_form` / `view_id`)の絞りと `limit` / `offset` の切り出しは
  //   この道具が持つ** —— **合成は宛先で1件も絞らないからである。**
  //   **絞る前の集合は必ず `visibleComments()` の返り値である** ——
  //   **可視でない行が絞りをすり抜けて出る経路は1本も無い**
  //   (実測は `src/mcp/tools/list-comments.test.ts` の (A-4))。
  // - **`total` は可視集合(絞ったあと・切る前)の長さから採る**(`ADR-0368` 限定5 の作法。
  //   `list_records` の `total: visible.length,` と同じ)—— **母集団を割らない。**
  //   **「見えない相手に n件ある」を1文字も漏らさない。**
  // - **`changelog` を1度も読まない**(限定6)—— **「このコメントは対応済みか」を
  //   機械が推定する枝は1行も無い。** **器に状態の列が1本も無いからでもある。**
  // - **主体を渡す引数を1本も置かない**(限定4)—— **名乗りは `ST_MCP_ACTOR` 1本である。**
  // - **書込の口を1つも作っていない**(限定2)—— **`write.ts` は 13本のままである。**
  //
  // **【正直に書く】量の歯止めが1つも無い**(`ADR-0368` 限界2)——
  // **`limit` を渡さなければ、見えるコメントを全件返す。**
  server.registerTool(
    "list_comments",
    {
      description: describeTool(
        "アプリに積まれたコメント(画面・ボタン・項目などに宛てて書かれた要望や指摘)を読み出します。" +
          "返るのはあなた(ST_MCP_ACTOR で名乗った利用者)に見えるものだけで、" +
          "同じアプリでも名乗る人が違えば返る件数が変わります。" +
          "anchor_form を渡すとその宛先の形だけに、view_id を渡すとその画面宛てだけに絞れます。" +
          "total は絞り込んだあと・limit で切る前の件数であり、見えないコメントは1件も数えていません。" +
          "コメントを書く・状態を倒すための口はありません" +
          "——応えるかどうかを決めるのは人であり、応えるときに書くのは差分(apply_diff)です。",
      ),
      inputSchema: {
        app_id: appIdArg,
        anchor_form: z
          .string()
          .optional()
          .describe("宛先の形での絞り込み(例: app / view / view_action)。省略すると全部の形。"),
        view_id: z
          .string()
          .optional()
          .describe("その画面宛てだけに絞る画面ID。アプリ全体宛ては1件も返らない。"),
        limit: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("返す件数の上限。省略すると絞り込んだ全件。total は絞られない。"),
        offset: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("先頭からスキップする件数(続きの取得に使う)。省略すると先頭から。"),
      },
    },
    ({ app_id, anchor_form, view_id, limit, offset }) => {
      const guard = requireActorAndApp(dataRoot, app_id, actor);
      if (!guard.ok) {
        return toolError(guard.errors);
      }
      const manifest = readCurrentManifest(dataRoot, app_id);
      const store = CommentStore.openForKernel(dataRoot);
      let stored: Comment[];
      try {
        stored = store.listComments(app_id);
      } finally {
        store.close();
      }
      // **ここから先に渡るのは、必ず合成が返した可視集合だけである。**
      const visible = visibleComments({
        manifest,
        roles: guard.value.roles,
        comments: stored,
      });
      // **宛先の絞り込み。** **可否を1つも見ていない** —— 見ているのは宛先の綴りだけである。
      const addressed = visible.filter(
        (comment) =>
          (anchor_form === undefined || comment.anchorForm === anchor_form) &&
          (view_id === undefined || comment.anchorParts[0] === view_id),
      );
      return toolOk({
        // **切るのは `comments` だけである** —— **既存の `slicePage` 1本を使う**
        // (2つ目のページの切り方を作っていない)。
        comments: slicePage(addressed, limit, offset),
        total: addressed.length,
      });
    },
  );
}
