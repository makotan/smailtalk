/**
 * MCP 実地検証ハーネスの共有型(V0-P6-T03a)。
 *
 * CP-5 の実地検証は一時ファイルの使い捨てスクリプトで行われ、
 * 「ファイル系ツールを全面禁止する」という**検証成立の必須条件が口伝**だった
 * (docs/evidence/cp-5.md §0-(a))。ここではその条件を型とコードに固定し、
 * 実行(run.ts)と判定(judge.ts)を再実行可能な仕組みにする。
 *
 * 判定を人間の主観から切り離すため、**証跡はすべて機械が読める形**で残す。
 * - stream-json の生ログ(AI が何をしたか)
 * - 実行前後の ST_DATA_ROOT 全ファイルの SHA-256 と mtime(人間が何をしたか)
 */

/** シナリオ定義(scenarios/*.md の frontmatter + ターン本文)。 */
export interface Scenario {
  /** シナリオID。試行ディレクトリ名にも使う(例: `001-bootstrap`)。 */
  id: string;
  /** 人間が読む題名。 */
  title: string;
  /** このシナリオの狙い(判定には使わない。README とレポートの見出し用)。 */
  purpose: string;
  /** `--allowedTools` に渡す値。シナリオごとに変えられる(4番は get_manifest を外す)。 */
  allowedTools: string[];
  /** `--disallowedTools` に渡す値。ファイル系ツールの全面禁止はここで担保する。 */
  disallowedTools: string[];
  /**
   * `system/init` の実効ツール一覧に**現れてはいけない**ツール名。
   * 「設定した値」ではなく「効いた値」を judge が検証するための期待値。
   */
  expectedAbsentTools: string[];
  /** 人間が打つプロンプト。要素1つ = 1ターン。2つ目以降は `--resume` で繋ぐ。 */
  turns: string[];
}

/** 実行前後に採取する1ファイルの状態。 */
export interface FileState {
  /** ST_DATA_ROOT からの相対パス(区切りは `/` に正規化)。 */
  path: string;
  sha256: string;
  /** epoch ミリ秒。 */
  mtimeMs: number;
  size: number;
}

/** ST_DATA_ROOT 配下の全ファイルの状態。 */
export interface Snapshot {
  /** ターンの前か後か。 */
  phase: "before" | "after";
  /** 1始まりのターン番号。 */
  turn: number;
  /** 採取時刻(ISO8601)。 */
  takenAt: string;
  files: FileState[];
}

/** 1試行の証跡メタデータ(meta.json)。 */
export interface TrialMeta {
  /** 連番付きの試行ID(例: `001-bootstrap`)。破棄した試行も連番として残す。 */
  trialId: string;
  scenarioId: string;
  scenarioTitle: string;
  /** 会話を1本に繋ぐためのセッションID。ターン2以降は `--resume` にこれを渡す。 */
  sessionId: string;
  /** 評価専用のデータルート(リポジトリの `data/` とは必ず別)。 */
  dataRoot: string;
  startedAt: string;
  endedAt: string;
  /** シナリオが設定した値。実効値は transcript の `system/init` から judge が読む。 */
  allowedTools: string[];
  disallowedTools: string[];
  expectedAbsentTools: string[];
  /** 実際に送ったプロンプト本文(judge がコードブロック混入を検査する対象)。 */
  turns: string[];
  /** 実行した claude CLI の引数(ターンごと)。 */
  argv: string[][];
  /** ターンごとの前後スナップショット。ターン間の改変検出に使う。 */
  snapshots: Snapshot[];
  /** 破棄した試行に人間が付けるメモ(任意)。 */
  note?: string;
  /**
   * 説明書(skill)の腕(任意)。**`--skill` を付けたときだけ入る。**
   *
   * 腕は `argv` の `--allowedTools ... Skill` からも復元できるが、
   * **2腕の比較は meta.json を並べて行う**ので、引数列を読み直さずに分かる形を持たせる。
   * 付けなかった試行(既存34本)には**入らない** —— 「腕を付けていない」と
   * 「allow の腕だった」を、欄の有無で区別できるようにするため。
   */
  skillArm?: "allow" | "deny";
  /**
   * MCP サーバに渡した名乗り(`ST_MCP_ACTOR`。任意)。
   *
   * **秘密ではない**(認証ではなく認可であり、証明を求めていない。`src/mcp/actor-guard.ts`)ので、
   * 証跡にそのまま残す。名乗りが違えば同じ差分でも通り方が変わるため、
   * **後から読む人が「誰として動いた試行か」を meta.json だけで言える**必要がある。
   */
  actor?: string;
}

/** transcript から抽出したツール呼び出し。 */
export interface ToolCall {
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
  /** 1始まりのターン番号(`system/init` の出現回数で決まる)。 */
  turn: number;
  /** transcript 上の通し番号(0始まり)。 */
  index: number;
  /**
   * 呼び出しを含む assistant イベントの時刻(ISO8601)。**証跡に無ければ undefined**。
   * V1-M0-T06 (b) / F-30。**0 で埋めないこと** —— 埋めると「測った」と「測っていない」が区別できなくなる。
   */
  timestamp?: string;
}

/** transcript から抽出したツール結果。 */
export interface ToolResult {
  toolUseId: string;
  isError: boolean;
  /** 結果本文(テキスト化したもの)。 */
  text: string;
  /** 結果を含む user イベントの時刻(ISO8601)。証跡に無ければ undefined。 */
  timestamp?: string;
}

/** `system/init` イベントから読んだ実効値。 */
export interface InitEvent {
  turn: number;
  /** **効いた**ツール一覧。設定値ではない。 */
  tools: string[];
  mcpServers: { name: string; status: string }[];
  sessionId: string;
  model: string;
}

/** 解析済み transcript。 */
export interface ParsedTranscript {
  inits: InitEvent[];
  calls: ToolCall[];
  results: ToolResult[];
  /** AI の応答テキスト(thinking は含めない)。 */
  assistantTexts: { turn: number; text: string }[];
  /** ターンの最終応答(`type:"result"` イベント)。 */
  turnResults: { turn: number; subtype: string; isError: boolean; text: string }[];
  /** JSON として読めなかった行(あってはならない)。 */
  malformedLines: number[];
}

/** 判定違反。1件でもあれば「検証無効」。 */
export interface Violation {
  code: ViolationCode;
  message: string;
  /** 該当箇所(パス・ツール名・プロンプト抜粋など)。 */
  detail?: string;
}

export type ViolationCode =
  /** transcript で説明できないファイル変化があった(本命の判定) */
  | "unexplained_change"
  /** ターンとターンの間にファイルが変化した(= 人間が会話の外で触った) */
  | "change_between_turns"
  /** 変化したファイルの mtime が実行時間帯の外にある */
  | "mtime_outside_run"
  /** 実効ツール一覧に MCP 以外の書き込み経路が現れた */
  | "forbidden_tool_effective"
  /** シナリオが「無いこと」を期待したツールが実効一覧に現れた */
  | "expected_absent_tool_present"
  /** MCP サーバに繋がっていない */
  | "mcp_server_not_connected"
  /** 人間のプロンプトにコードブロック / JSON リテラルが含まれる */
  | "prompt_contains_code"
  /** 判定に必要な証跡が欠けている */
  | "evidence_missing";

/** judge の最終レポート。 */
export interface JudgeReport {
  trialId: string;
  scenarioId: string;
  /** `invalid` = 検証無効。violations が空なら `valid`。 */
  verdict: "valid" | "invalid";
  violations: Violation[];
  /** 無効にはしないが人間が見るべき事象。 */
  warnings: string[];
  extraction: Extraction;
}

/** V0-P6-T04(つまずきの記録)の一次ソースになる機械抽出。 */
export interface Extraction {
  /** 呼ばれたツールと回数。 */
  toolUsage: { name: string; count: number; errorCount: number }[];
  /** `is_error: true` の全件と、直後に自己修正が成立したか。 */
  errorEpisodes: ErrorEpisode[];
  /** AI が要求を断った候補(ターン単位の証跡照合で抽出。最終判断は人間)。 */
  refusals: RefusalFinding[];
  /** やり直し(同じツールを失敗のあと再送した連鎖)。 */
  retries: RetryEpisode[];
  /** 人間ターン数と全文。 */
  humanTurns: { turn: number; text: string }[];
  /** 実効ツール一覧(ターンごと)。 */
  effectiveTools: { turn: number; tools: string[] }[];
  /** 観測されたファイル変化と、それを説明するツール呼び出し。 */
  changeAttribution: ChangeAttribution[];
}

/**
 * 断りの種類。
 * - `capability_denial` … 「できない」という**限界の言明**。帰属先(scope)とセットで判定する。
 * - `action_withheld` … 頼まれた変更を**実行せずに問い返した**。本文の語ではなく証跡で判定する
 *   (F-27 #1 = 006/T2。本文に判定語が1つも現れない)。
 */
export type RefusalKind = "capability_denial" | "action_withheld";

/** 断りの言明1文。**語だけでは断りにしない**ので、帰属先と根拠を必ず持つ。 */
export interface RefusalStatement {
  /** 言明を含む1文(前後を切らずに残す)。 */
  sentence: string;
  /** 一致した否定の**形態**(語彙の1語ではなく語尾の型)。例: `せません` / `られません`。 */
  marker: string;
  /** その否定が**誰の・何の限界**を言っているか。空なら断りと見なさない。 */
  scope: string[];
  /** なぜ断りと判定したか(機械が付ける説明)。 */
  rationale: string;
}

/**
 * V1-M0-T06 (a) の抽出単位。**1ターンにつき1件**にまとめる。
 * `docs/v0-bootstrap-log.md` §6-2 の人間の台帳が「試行/ターン」単位なので、突き合わせの単位を揃える。
 */
export interface RefusalFinding {
  turn: number;
  kinds: RefusalKind[];
  /** **何に対する断りか** —— そのターンで人間が打った要求の本文。分からなければ空文字。 */
  requested: string;
  /** 断りの言明(`action_withheld` だけの場合は空になりうる)。 */
  statements: RefusalStatement[];
  /** 判定の入力になった、そのターンのツール呼び出しの有無・結果(条件1)。 */
  evidence: {
    toolCallCount: number;
    writeCallCount: number;
    successfulWriteCallCount: number;
    errorCount: number;
    /** ターン最後の応答が問いで終わっているか。 */
    askedBack: boolean;
  };
}

/** やり直し1エピソード。時刻は**証跡にあるときだけ**入る(F-30 / V1-M0-T06 (b))。 */
export interface RetryEpisode {
  tool: string;
  turn: number;
  attempts: number;
  succeeded: boolean;
  /** 最初の試行の呼び出し時刻。 */
  startedAt?: string;
  /** 最後の試行の結果時刻。 */
  endedAt?: string;
  /** `startedAt` → `endedAt` の全体所要時間(ミリ秒)。 */
  durationMs?: number;
  /** やり直しの回数(= attempts - 1)。 */
  redoCount?: number;
  /** **やり直し1回あたりの所要時間**(失敗の結果 → 次の試行の結果)。完了条件4 の本体。 */
  redoMs?: number[];
  /** `redoMs` の平均(小数は四捨五入)。 */
  meanRedoMs?: number;
  /** ツール実行そのものに費やされた時間の合計(呼び出し→結果)。残りはモデルの再生成である。 */
  toolExecMs?: number;
}

export interface ErrorEpisode {
  turn: number;
  tool: string;
  toolUseId: string;
  /** エラー本文(長い場合は先頭を切る)。 */
  errorText: string;
  /** 同じツールの次の呼び出しが成功したか。 */
  selfCorrected: boolean;
  /** 自己修正が成立した呼び出しの ID。 */
  correctedBy?: string;
  /** エラーと修正の間に人間の入力があったか(あれば「自力の修正」ではない)。 */
  humanInputBetween: boolean;
  /**
   * エラーが起きた段階(V1-M0-T13)。
   * - `input-parse`: ツール入力が JSON としてパースできず、**MCP サーバに到達する前**に落ちた(F-17 / F-24)
   * - `server`: 呼び出しは MCP サーバに届き、サーバ/カーネルがエラーを返した
   *
   * CP-7 は F-17 を「証跡に残らない」と判定したが、これは誤りである。
   * パース層で落ちた呼び出しは `__unparsedToolInput` という**構造**として transcript に残っており、
   * この段階を分けることで「F-17 が再発したか」を機械的に問える。
   */
  stage: "input-parse" | "server";
  /** `input-parse` のとき、クライアントが保持していた未パースの生入力(切り詰めない)。 */
  unparsedInput?: { raw: string; len: number };
}

export interface ChangeAttribution {
  path: string;
  kind: "added" | "modified" | "removed";
  /** `kernel` / `app:<app_id>` / `unknown`。 */
  scope: string;
  /** この変化を説明するツール呼び出し(空なら説明不能)。 */
  explainedBy: string[];
  /**
   * 説明が弱いか。SQLite の実体ファイルは参照系ツールでも動くため、
   * 参照系の呼び出しだけで説明が付いた場合は `true` になる(judge が警告として出す)。
   */
  weak: boolean;
}
