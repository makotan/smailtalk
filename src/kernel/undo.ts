/**
 * undo と事前確認API(V0-P4-T04)。ADR-0004「undo のセマンティクス」の実装。
 *
 * ADR-0004 の決定をそのままコードに写すことがこのモジュールの仕事であり、
 * ここで意味論を足したり緩めたりしない。特に次の3点は ADR の直訳である。
 *
 * 1. **対象の選び方**(§3): 「どの undo エントリからも `undo_target_seq` で
 *    参照されていない、最大 `seq` の `kind: "apply"` エントリ」。この定義**だけ**を
 *    実装する。「何回目の undo か」「どこまで戻ったか」というカーソルを持たない。
 *    連続undoが古い方へ1つずつ遡ること(§1)も、undo が undo の対象にならないこと(§1)も、
 *    この1つの選び方から導かれるのであって、別の仕組みで実現するのではない。
 * 2. **undo の実体**(§4): 対象 apply エントリの `snapshot`(= その apply の直前状態)を
 *    `restoreSnapshot` で書き戻すだけ。マニフェストの逆適用も DDL の逆操作もしない。
 *    したがって**その apply 以降に追加・編集されたユーザデータも一緒に消える**。
 * 3. **消える/戻る件数は `_id` の集合差**(§6): 「現在件数 − スナップショット件数」の
 *    引き算はしない。引き算は「3件追加して2件削除」を1件と申告し、事前確認が過小申告になる。
 *    これに加えて **内容だけ変わったレコードの件数**(`changed_records`)を返す
 *    (ADR-0027 / V1-M9-T06)。こちらは「両方に同じ `_id` で在り、ユーザフィールドの値が
 *    異なる行」を sql-attach(ATTACH + 1本のJOIN)で数える。`_updated_at` だけの差は
 *    「変更」に数えない —— `_updated_at` は保存のたびに進むので、含めると no-op PATCH まで
 *    過大申告になる(ADR-0027 §4。ADR-0004 §6 が引き算を退けた過小申告と対称の失敗)。
 *
 * ## 参照系と実行系を分ける(§2)
 *
 * `previewUndo` は状態を1バイトも変えない。`dry_run` フラグで実行系と同居させない理由は
 * ADR §2 のとおりで、フラグを落としたときに起きるのが「確認せず実行」ではなく
 * 「実行できない」になるようにするためである。
 *
 * ## エラー方針
 *
 * 「取り消せる変更がない」「対象のスナップショットが無い」は呼び出し側(将来のAI)が
 * 判断を変えれば済む種類の失敗なので、統一形式(`ValidationError[]`)で返す。
 * I/O 失敗や changelog 追記の失敗はカーネル/環境側の異常なので、状態を戻したうえで
 * 例外にする(`apply-diff.ts` と同じ方針)。
 */
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readCurrentManifest } from "./apply-manifest.ts";
import { quoteIdentifier, SYSTEM_COLUMNS } from "./ddl.ts";
import type { ValidationError } from "./errors.ts";
import { type ChangelogEntry, KernelMetaStore } from "./meta-store.ts";
import { isValidResourceId, RESOURCE_ID_MAX_LENGTH } from "./resource-id.ts";
import { restoreSnapshot, takeSnapshot } from "./snapshot.ts";
import { appDbPath, snapshotDir } from "./storage-paths.ts";
import type { Manifest, Operation, ResourceId } from "./types.ts";
import { validateManifestFull } from "./validate.ts";

/** スナップショットディレクトリ内のファイル名(`snapshot.ts` と同じ1組)。 */
const SNAPSHOT_MANIFEST = "manifest.json";
const SNAPSHOT_DB = "app.sqlite";

/**
 * undo のスナップショット名の前置語(ADR-0004 §5)。undo は実行直前状態を
 * `undo-<対象diff_id>` という名前で保存する。**この前置という制約を所有しているのは
 * undo モジュールである**から、由来をここに集約する(ADR-0028 / V1-M9-T08 §4-4)。
 */
export const UNDO_DIFF_ID_PREFIX = "undo-";

/**
 * redo のスナップショット名の前置語(ADR-0032 §3)。redo は実行直前状態を
 * `redo-<対象apply diff_id>` という名前で保存する。**前置は1段だけに保つ** ——
 * `redo-undo-<diff_id>` のように undo の前置に重ねると、`undo-` で 59 になる長さ上限
 * (ADR-0028 / {@link MAX_UNDOABLE_DIFF_ID_LENGTH})が 54 まで下がる(ゲート §3)。
 * `redo-` は `undo-` と同じ5文字なので、undo できた差分は redo でも名前を作れる
 * (`undo-<X>` が規約に収まるなら `redo-<X>` も収まる)。
 */
const REDO_DIFF_ID_PREFIX = "redo-";

/**
 * undo できる `diff_id` の最大長(= {@link RESOURCE_ID_MAX_LENGTH} − `"undo-".length` = 59)。
 *
 * `diff_id` 自体はリソースID規約(最大 {@link RESOURCE_ID_MAX_LENGTH} 文字)を満たしていても、
 * undo のスナップショット名 `undo-<diff_id>` を作る時点で規約長を超えることがある。**適用は
 * 成功するのに undo だけができない**という憲法4(常に戻せる)の静かな破れを構成で塞ぐため、
 * `apply_diff` はこの長さを超える `diff_id` を入口で拒否する(ADR-0028 / V1-M9-T08)。
 *
 * **この式が59の唯一の由来である。**数字リテラルとしてコードに置かない —— かつては
 * `undo.ts` のエラー文言の中に `RESOURCE_ID_MAX_LENGTH - "undo-".length` という式の評価値と
 * してだけ現れ、宣言された契約(スキーマ上限64)と実際の振る舞い(59)が食い違っていた
 * (ADR-0028 §1)。`schemas/diff.schema.json` の `diff_id.maxLength` はこの値の写しであり、
 * 一致は `validate.test.ts` が機械的に固定する。値を変えるときは両方を同時に直すこと。
 */
export const MAX_UNDOABLE_DIFF_ID_LENGTH = RESOURCE_ID_MAX_LENGTH - UNDO_DIFF_ID_PREFIX.length;

/**
 * `previewUndo` が必ず返す定型の注記文(ADR-0004 §6 / ADR-0027)。
 *
 * **役割が変わった(ADR-0027)。** かつては「両方に居るが内容だけ変わったレコードを
 * 件数として出せない」ことの申告だったが、V1-M9-T06 で内容比較を実装したため、
 * その申告は嘘になる。いまの note は「**何を基準に数えたか**」の申告である ——
 * 内容変更の判定にはシステム列(`_id`/`_created_at`/`_updated_at`)を含めず、
 * テーブル定義のユーザフィールドの値一致で行う(値が保存されただけで変わっていない
 * レコードは数えない)。**限定を持つ判定を、限定を明示せずに数字だけ返すのは別の形の
 * 不正確さになる**ので、憲法6の実装として note を残す。文面を変えるときは ADR-0027 の
 * §note(と ADR-0004 §6 との関係)も同時に直すこと。
 */
export const UNDO_PREVIEW_NOTE =
  "内容が変わったレコードの件数(changed_records)は、" +
  "_created_at・_updated_at を含むシステム列を除いた、" +
  "テーブル定義のフィールド値の一致で判定しています。" +
  "値が保存されただけで実際には変わっていないレコードは数えません。";

/** テーブルID → 件数。件数が 0 のテーブルは含めない(ADR-0004 §6)。 */
export type RecordCounts = Record<string, number>;

/** `previewUndo` が返す「undo で何が起きるか」(ADR-0004 §6 の表)。 */
export type UndoPreview = {
  /** 対象 apply エントリの `seq`。 */
  target_seq: number;
  /** 対象の `diff_id`。 */
  diff_id: string;
  /** 対象の `intent`(ユーザが何を意図してこの変更を入れたか)。 */
  intent: string;
  /** 対象の適用日時(ISO8601 UTC)。 */
  applied_at: string;
  /** 対象の `operations`(取り消されるスキーマ・ビュー変更そのもの)。 */
  operations: Operation[];
  /** undo によって消えるレコード件数のテーブル別内訳(`_id` がスナップショットに無い行)。 */
  lost_records: RecordCounts;
  /** undo によって復活するレコード件数のテーブル別内訳(`_id` が現在に無い行)。 */
  restored_records: RecordCounts;
  /**
   * undo によって**内容が編集前に戻る**レコード件数のテーブル別内訳(ADR-0027 / V1-M9-T06)。
   *
   * 対象は「現在とスナップショットの**両方**に同じ `_id` で存在し、ユーザフィールドの値が
   * 異なる行」だけである。両方に存在する行だけを数えるので、`lost_records` /
   * `restored_records` とは `_id` で排他になる(完了条件3)。比較列はマニフェストの
   * ユーザフィールドの現在/スナップショット共通部分から動的に導き、システム列
   * (`_id`/`_created_at`/`_updated_at`)は除く(`note` が申告する判定基準。§4)。
   */
  changed_records: RecordCounts;
  /**
   * undo によって**定義ごと消えるリソース**(ADR-0027 / V1-M9-T06 完了条件9)。
   *
   * 対象 apply の `operations` から `remove_table` / `remove_view` / `remove_workflow` /
   * `remove_function` を抽出しただけの、DB を読まない機械的な集合である
   * (`operations` の推論を呼び出し側に強いないための明示フィールド)。各配列は operations の
   * 出現順のまま対象IDを並べる。空配列は「その種類の資源は消えない」を意味する。
   *
   * **型は意図的に inline にしている(Δ8)。** 名前付きで export すると `src/kernel/` の
   * 公開面が1つ増え、ADR-0007 改訂2 の Δ8(門A)に掛かる。previewUndo 内で完結させ、
   * 参照が要る呼び出し側は `UndoPreview["removed_resources"]` で取れる(ADR-0027 §Δ8)。
   */
  removed_resources: {
    /** `remove_table` で定義ごと消えるテーブルのID。 */
    tables: ResourceId[];
    /** `remove_view` で消える画面(ビュー)のID。 */
    views: ResourceId[];
    /** `remove_workflow` で消える自動化(ワークフロー)のID。 */
    workflows: ResourceId[];
    /** `remove_function` で消える関数(コードの島)のID。 */
    functions: ResourceId[];
  };
  /** 内容変更を「何を基準に数えたか」を伝える定型文(`UNDO_PREVIEW_NOTE`。ADR-0027)。 */
  note: string;
};

/** `previewUndo` の結果。失敗形は `ValidationResult` と同一。 */
export type PreviewUndoResult =
  | { valid: true; preview: UndoPreview }
  | { valid: false; errors: ValidationError[] };

/** `undo` の結果。失敗形は `ValidationResult` と同一。 */
export type UndoResult =
  | {
      valid: true;
      /** 復元後の(= 対象 apply の直前の)マニフェスト。 */
      manifest: Manifest;
      /** 追記された undo の changelog エントリ。 */
      entry: ChangelogEntry;
      /** undo 実行**直前**の状態を保存したスナップショットのディレクトリ名(ADR-0004 §5)。 */
      snapshot: string;
      /** 復元元となった、対象 apply エントリのスナップショットのディレクトリ名。 */
      restored_from: string;
    }
  | { valid: false; errors: ValidationError[] };

/** `redo` の結果(ADR-0032)。失敗形は `UndoResult` と同一。 */
export type RedoResult =
  | {
      valid: true;
      /** 復元後の(= 対象 undo 実行直前の)マニフェスト。 */
      manifest: Manifest;
      /** 追記された redo の changelog エントリ。 */
      entry: ChangelogEntry;
      /** redo 実行**直前**の状態を保存したスナップショットのディレクトリ名。 */
      snapshot: string;
      /** 復元元となった、対象 undo エントリのスナップショットのディレクトリ名。 */
      restored_from: string;
    }
  | { valid: false; errors: ValidationError[] };

// --- 対象の選択(ADR-0004 §3)---------------------------------------------------

/**
 * undo エントリが `undo_target_seq` で指す seq の集合を返す。
 *
 * **これは構文的事実の抽出であって、「生きている apply」の判定ではない。**
 * 返すのは「取り消しの矢印がどの seq を指しているか」だけであり、そこから
 * 「どの apply が現在の状態の根拠として生きているか」を導くのは**呼び出し側の解釈**である。
 *
 * ここに解釈を持ち込まないのは、`changelog.ts` が名指しした失敗
 * (「同じ意味論を2箇所に書けば必ず食い違う」)を、**共有しているつもりの解釈が
 * 片方の都合で変わる**という形で再現しないためである(ADR-0025 §8-1)。
 * このモジュールは ADR-0004 §3 の直訳であり続ける —— `selectUndoTarget` は
 * この集合に**自分の追加条件**(`snapshot !== null`)を自分で重ねる。
 * 一方 `requirements-doc.ts` の帰属は `snapshot !== null` を**使わない**
 * (巻き戻し先が無いことは、その apply が起きなかったことを意味しない。ADR-0025 §8-2)。
 *
 * 消費者は undo だけではない(ADR-0004 の注記)。
 */
export function undoneTargetSeqs(entries: ChangelogEntry[]): Set<number> {
  return new Set(
    entries.flatMap((entry) =>
      entry.kind === "undo" && entry.undo_target_seq !== null ? [entry.undo_target_seq] : [],
    ),
  );
}

/**
 * undo の対象を選ぶ。ADR-0004 §3 の定義をそのまま写した唯一の場所。
 *
 * > 「どの undo エントリからも `undo_target_seq` で参照されていない、
 * >  最大 `seq` の `kind: "apply"` エントリ」
 *
 * `listChangelog` は `seq` 昇順なので、条件を満たす最後の要素が最大 seq になる。
 * カーソルも「何回目か」の状態も持たない。changelog そのものが唯一の状態である。
 */
function selectUndoTarget(entries: ChangelogEntry[]): ChangelogEntry | undefined {
  const undoneSeqs = undoneTargetSeqs(entries);
  // `snapshot === null` の apply エントリは候補から外す。
  //
  // ADR-0004 §4 の undo の実体は「対象 apply の `snapshot` を書き戻す」ことなので、
  // 巻き戻し先が記録されていないエントリは定義上 undo できない。`applyDiff` は必ず実在の
  // スナップショット名を記録するため、`snapshot === null` の apply は
  // create_app が書く第0行(V1-M0-T05 / F-28。アプリ作成の「直前状態」は存在しない)である。
  //
  // これを候補に残すと、すべての apply を undo し切ったあとに第0行が選ばれてしまい、
  // 「取り消せる変更がありません」(noUndoTargetError)だった応答が
  // 「スナップショットが記録されていません」(unusableSnapshotError)に変わる。
  // それは異常を疑わせる文面であり、正常な終端の説明として誤りである。
  return entries
    .filter(
      (entry) => entry.kind === "apply" && entry.snapshot !== null && !undoneSeqs.has(entry.seq),
    )
    .at(-1);
}

/** 対象が無いときのエラー(ADR-0004 §4)。preview と undo で完全に同じものを返す。 */
function noUndoTargetError(appId: string): ValidationError {
  return {
    path: "",
    message:
      `アプリ "${appId}" には取り消せる変更がありません。` +
      `適用済みの差分がないか、すべて取り消し済みです。`,
    hint:
      `get_changelog で履歴を確認してください。取り消しをやり直したい(直前の undo を戻したい)` +
      `場合は redo を使ってください。新しく変更を入れたい場合は新しい diff_id で apply_diff してください。`,
  };
}

// --- redo の対象選択(ADR-0032 §3)----------------------------------------------

/**
 * redo エントリが `undo_target_seq` で指す「やり直し済みの undo」の seq 集合を返す。
 *
 * `undoneTargetSeqs`(apply が取り消し済みかの判定)と対称の構文的事実の抽出であり、
 * redo エントリの `undo_target_seq` は**やり直した undo エントリの seq** を指す(ADR-0032 §3)。
 * **`undoneTargetSeqs` は `kind === "undo"` だけを見るので、redo の `undo_target_seq` は
 * apply の取り消し判定に混ざらない** —— したがって redo は apply を undo 候補へ戻さない
 * (同じ apply を二度 undo して `undo-<diff_id>` が再生成される衝突が起きない。§3)。
 */
function redoneUndoSeqs(entries: ChangelogEntry[]): Set<number> {
  return new Set(
    entries.flatMap((entry) =>
      entry.kind === "redo" && entry.undo_target_seq !== null ? [entry.undo_target_seq] : [],
    ),
  );
}

/**
 * redo の対象を選ぶ(ADR-0032 §3)。
 *
 * > 「どの redo エントリからも指されていない、最大 `seq` の `kind: "undo"` エントリ」
 *
 * `selectUndoTarget`(apply を選ぶ)と対称で、redo は undo を選ぶ。undo が undo の対象に
 * ならないのと同様、redo エントリ自身は redo の候補に入らない(候補を `kind: "undo"` に限る)。
 * 連続 undo したときは新しい undo(seq が大きい方)から順に redo される(LIFO)。
 * `snapshot === null` の undo は戻り先が無いので候補から外す(通常 undo は必ず取得するが防御)。
 */
function selectRedoTarget(entries: ChangelogEntry[]): ChangelogEntry | undefined {
  const redone = redoneUndoSeqs(entries);
  return entries
    .filter((entry) => entry.kind === "undo" && entry.snapshot !== null && !redone.has(entry.seq))
    .at(-1);
}

/** redo 対象(やり直せる undo)が無いときのエラー。preview と redo で同じものを返す。 */
function noRedoTargetError(appId: string): ValidationError {
  return {
    path: "",
    message:
      `アプリ "${appId}" にはやり直せる undo がありません。` +
      `undo をまだ実行していないか、直前の undo が既に redo 済みです。`,
    hint:
      `get_changelog で履歴を確認してください。redo は直前の undo をやり直す操作なので、` +
      `対象の undo が無ければ実行できません。新しく変更を入れたい場合は新しい diff_id で apply_diff してください。`,
  };
}

/**
 * redo の戻り先(undo 実行直前のスナップショット)が使えないときのエラー。
 *
 * **これは V1-M9-T04(世代管理)との依存点そのものである**(ゲート §7)—— redo の戻り先は
 * undo エントリの `snapshot`(`<連番>-undo-<対象diff_id>` ディレクトリ)であり、世代管理が
 * これを削除すると redo が「戻り先が無い」で失敗する。黙って別の状態へ巻き戻すことはしない(憲法6)。
 */
function unusableRedoSnapshotError(appId: string, target: ChangelogEntry): ValidationError {
  const detail =
    target.snapshot === null
      ? `この undo にはスナップショットが記録されていません(snapshot が null です)。`
      : `記録されているスナップショット "${target.snapshot}" の実体が見つかりません` +
        `(世代管理などで削除された可能性があります)。`;
  return {
    path: "",
    message:
      `アプリ "${appId}" の undo "${target.diff_id}" をやり直せません。${detail}` +
      `redo は undo 実行直前のスナップショットを復元する操作なので、それが無ければ実行できません。`,
    hint:
      `別のスナップショットへ勝手に巻き戻すことはしません。` +
      `snapshots ディレクトリの中身を確認してください。`,
  };
}

/** redo 用のスナップショット名を作れないときのエラー(unusableUndoIdError の redo 版)。 */
function unusableRedoIdError(
  appId: string,
  target: ChangelogEntry,
  redoDiffId: string,
): ValidationError {
  return {
    path: "",
    message:
      `アプリ "${appId}" の undo "${target.diff_id}" をやり直せません。` +
      `redo のスナップショット名 "${redoDiffId}" が${RESOURCE_ID_MAX_LENGTH}文字を超えるため、` +
      `記録先のディレクトリ名を作れません。`,
    hint: `この undo は redo できませんが、状態は一切変更していません。`,
  };
}

/**
 * 対象の `snapshot` が使えないときのエラー(ADR-0004 §4)。
 * 「黙って別のスナップショットへ巻き戻す」ことは絶対にしない(憲法6)。
 */
function unusableSnapshotError(appId: string, target: ChangelogEntry): ValidationError {
  const detail =
    target.snapshot === null
      ? `この差分にはスナップショットが記録されていません(snapshot が null です)。`
      : `記録されているスナップショット "${target.snapshot}" の実体が見つかりません。`;
  return {
    path: "",
    message:
      `アプリ "${appId}" の差分 "${target.diff_id}" を取り消せません。${detail}` +
      `undo は記録された時点のスナップショットを復元する操作なので、それが無ければ実行できません。`,
    hint:
      `別のスナップショットへ勝手に巻き戻すことはしません。` +
      `snapshots ディレクトリの中身を確認してください。`,
  };
}

/**
 * undo 用のスナップショット名を作れないときのエラー。
 *
 * undo のスナップショット名は `undo-<対象diff_id>` である(ADR-0004 §5)。対象の diff_id 自体は
 * リソースID規約(最大 {@link RESOURCE_ID_MAX_LENGTH} 文字)を満たしていても、`undo-` を
 * 前置した時点で超えることがある。`takeSnapshot` はディレクトリ名の安全性を守るために
 * ここで例外を投げるが、それを素通しすると「対象なし」「スナップショットが使えない」が
 * `ValidationError` なのに、この1件だけ例外という不統一が生まれる。**呼び出し側が
 * 判断を変えれば済む失敗はすべて統一形式で返す**という方針(このモジュール冒頭)に揃える。
 */
function unusableUndoIdError(
  appId: string,
  target: ChangelogEntry,
  undoDiffId: string,
): ValidationError {
  return {
    path: "",
    message:
      `アプリ "${appId}" の差分 "${target.diff_id}" を取り消せません。` +
      `undo のスナップショット名 "${undoDiffId}" が${RESOURCE_ID_MAX_LENGTH}文字を超えるため、` +
      `記録先のディレクトリ名を作れません。`,
    hint:
      `diff_id は "${UNDO_DIFF_ID_PREFIX}" を前置しても規約に収まる長さ` +
      `(${MAX_UNDOABLE_DIFF_ID_LENGTH}文字以内)にしてください。` +
      `この差分は undo できませんが、状態は一切変更していません。`,
  };
}

/** 対象のスナップショットが2ファイル揃って実在するか。揃っていなければ `undefined`。 */
function resolveTargetSnapshotDir(
  dataRoot: string,
  appId: string,
  target: ChangelogEntry,
): string | undefined {
  if (target.snapshot === null) {
    return undefined;
  }
  const dir = snapshotDir(dataRoot, appId, target.snapshot);
  if (!existsSync(join(dir, SNAPSHOT_MANIFEST)) || !existsSync(join(dir, SNAPSHOT_DB))) {
    return undefined;
  }
  return dir;
}

// --- 件数の集計(ADR-0004 §6)---------------------------------------------------

/**
 * スナップショット内の `manifest.json` を読む。
 *
 * `readCurrentManifest`(apply-manifest.ts)と同じく、検証を通してからマニフェストとして扱う。
 * 壊れているのは LLM が差分を直して解決する種類の失敗ではないので例外にする。
 *
 * **検証の目的は `"stored"` である**(V1-M2-T05e)。**undo は「書かれた当時は正当だった
 * 状態」を復元する操作**であり、後から足した制約を復元の入口で掛けると、
 * **制約を1つ強化するたびに過去の undo が壊れる。**
 * 「壊れている」(= JSON として読めない / 当時も不正だった)と
 * 「当時は正当だったが、今の語彙では新たには書けない」を区別する線がここである。
 * 何を外すかは `validate.ts` の `INPUT_ONLY_SCHEMA_PATHS` が一覧で持つ。
 */
function readSnapshotManifest(dir: string): Manifest {
  const path = join(dir, SNAPSHOT_MANIFEST);
  const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
  const result = validateManifestFull(parsed, "stored");
  if (!result.valid) {
    throw new Error(
      `スナップショットの manifest.json がマニフェストとして不正です: ${path}。` +
        `スナップショットが壊れている可能性があります。`,
    );
  }
  return parsed as Manifest;
}

/**
 * テーブルの `_id` の集合を読む。テーブルがその DB に物理的に無ければ `undefined`。
 *
 * ADR-0004 §6 の「スナップショット側にテーブルが存在しない」を判定する実体がこれである
 * (マニフェストにあるのに実体が無い、という壊れ方でも「存在しない」側に倒す)。
 * 識別子は `quoteIdentifier` で検証してから埋め込む。
 */
function readIdSet(db: Database, tableId: ResourceId): Set<string> | undefined {
  const exists = db
    .query<{ name: string }, [string]>(
      `SELECT "name" FROM "sqlite_master" WHERE "type" = 'table' AND "name" = ?`,
    )
    .get(tableId);
  if (exists === null) {
    return undefined;
  }
  const idColumn = quoteIdentifier(SYSTEM_COLUMNS.id);
  const rows = db
    .query<{ id: string }, []>(`SELECT ${idColumn} AS "id" FROM ${quoteIdentifier(tableId)}`)
    .all();
  return new Set(rows.map((row) => row.id));
}

/** `a` にあって `b` に無い要素の数。`b` が無い(= テーブルごと無い)場合は `a` の全件。 */
function countOnlyInFirst(a: Set<string>, b: Set<string> | undefined): number {
  if (b === undefined) {
    return a.size;
  }
  let count = 0;
  for (const id of a) {
    if (!b.has(id)) {
      count += 1;
    }
  }
  return count;
}

/** 0 件のテーブルを落としつつ内訳に積む(ADR-0004 §6: 0 は表示上のノイズなので省く)。 */
function put(counts: RecordCounts, tableId: string, value: number): void {
  if (value > 0) {
    counts[tableId] = value;
  }
}

/**
 * 現在の DB とスナップショットの DB を `_id` の集合差で比べる(ADR-0004 §6)。
 *
 * **引き算(現在件数 − スナップショット件数)にしないこと。** apply 後に3件追加して
 * 2件削除した場合、引き算は「1件失われる」と答えるが、実際には追加した3件が消え、
 * 削除した2件が戻る。事前確認での過小申告は ADR が防ごうとしている事故そのものである。
 */
function countRecordChanges(
  currentDbPath: string,
  snapshotDbPath: string,
  currentManifest: Manifest,
  snapshotManifest: Manifest,
): { lost: RecordCounts; restored: RecordCounts } {
  // 対象テーブル集合 = 現在のマニフェストのテーブル ∪ スナップショットのマニフェストのテーブル。
  const tableIds = [
    ...new Set([
      ...currentManifest.app.tables.map((table) => table.id),
      ...snapshotManifest.app.tables.map((table) => table.id),
    ]),
  ];

  const lost: RecordCounts = {};
  const restored: RecordCounts = {};

  // どちらも読み取りしかしない(preview が状態を変えないことの担保)。
  const currentDb = new Database(currentDbPath, { readonly: true });
  try {
    const snapshotDb = new Database(snapshotDbPath, { readonly: true });
    try {
      for (const tableId of tableIds) {
        const currentIds = readIdSet(currentDb, tableId) ?? new Set<string>();
        const snapshotIds = readIdSet(snapshotDb, tableId);
        // 消える = 現在にあってスナップショットに無い(テーブルごと無いなら現在の全件)。
        put(lost, tableId, countOnlyInFirst(currentIds, snapshotIds));
        // 戻る = スナップショットにあって現在に無い。スナップショット側に無いテーブルは 0。
        if (snapshotIds !== undefined) {
          put(restored, tableId, countOnlyInFirst(snapshotIds, currentIds));
        }
      }
    } finally {
      snapshotDb.close();
    }
  } finally {
    currentDb.close();
  }

  return { lost, restored };
}

// --- 内容だけ変わったレコードの集計(ADR-0027 / V1-M9-T06)-------------------------

/** ATTACH でスナップショットDBをぶら下げるときのスキーマ名(固定の定数)。 */
const SNAPSHOT_SCHEMA = "snap";

/**
 * あるテーブルの「比較対象になるユーザフィールド列」を導く(ADR-0027 §4)。
 *
 * **ハードコードしない。** 現在マニフェストとスナップショットマニフェストの当該テーブルの
 * フィールド定義の**共通部分**を動的に取る。`add_field` / `remove_field` / `change_field`
 * を挟んだ apply では現在とスナップショットで列集合が一致しないことがあるので、
 * **片側にしか無い列は比較不能として除外**する。システム列(`_id`/`_created_at`/
 * `_updated_at`)はそもそもマニフェストの `fields` に現れないので自然に除外される。
 */
function comparableColumns(
  currentManifest: Manifest,
  snapshotManifest: Manifest,
  tableId: string,
): string[] {
  const snapshotFields = new Set(fieldIdsOf(snapshotManifest, tableId));
  return fieldIdsOf(currentManifest, tableId).filter((fieldId) => snapshotFields.has(fieldId));
}

/** マニフェストの当該テーブルのユーザフィールドID一覧(定義順)。テーブルが無ければ空。 */
function fieldIdsOf(manifest: Manifest, tableId: string): string[] {
  const table = manifest.app.tables.find((candidate) => candidate.id === tableId);
  return table === undefined ? [] : table.fields.map((field) => field.id);
}

/** 指定スキーマにその名前の物理テーブルが存在するか(`main` / `snap` のどちらも見られる)。 */
function physicalTableExists(db: Database, schema: string, tableId: string): boolean {
  const row = db
    .query<{ name: string }, [string]>(
      `SELECT "name" FROM ${quoteIdentifier(schema)}."sqlite_master" ` +
        `WHERE "type" = 'table' AND "name" = ?`,
    )
    .get(tableId);
  return row !== null;
}

/**
 * 「両方に同じ `_id` で存在し、共通ユーザフィールドの値が異なる行」をテーブル別に数える。
 *
 * **sql-attach 方式(ADR-0027 §2)** —— スナップショットDBを同一接続へ `ATTACH` し、1本の
 * JOIN で数える。`naive-js`(全列をJSへ読み出して Map 比較)より 2.3〜2.9 倍安い(判断ゲート
 * §2-2 の実測)。`JOIN` で突き合わせるのは `_id` が両側に在る行だけなので、集合として
 * `lost` / `restored` と自然に排他になる(完了条件3)。
 *
 * 現在DBだけを開き(readonly)、そこへスナップショットDBを attach する。どちらも読み取りしか
 * しない(preview が状態を変えないことの担保)。
 */
function countContentChanges(
  currentDbPath: string,
  snapshotDbPath: string,
  currentManifest: Manifest,
  snapshotManifest: Manifest,
): RecordCounts {
  // 内容が変わりうるのは「現在にもスナップショットにも定義があるテーブル」だけ。
  // 片方にしか無いテーブルは add_table / remove_table 相当で lost / restored の仕事。
  const currentTables = new Set(currentManifest.app.tables.map((table) => table.id));
  const sharedTables = snapshotManifest.app.tables
    .map((table) => table.id)
    .filter((tableId) => currentTables.has(tableId));

  const changed: RecordCounts = {};
  const db = new Database(currentDbPath, { readonly: true });
  try {
    db.run(`ATTACH DATABASE ? AS ${SNAPSHOT_SCHEMA}`, [snapshotDbPath]);
    try {
      for (const tableId of sharedTables) {
        const columns = comparableColumns(currentManifest, snapshotManifest, tableId);
        // 比較できる共通列が無ければ「内容が変わった」を判定できない = 数えない。
        if (columns.length === 0) {
          continue;
        }
        // マニフェストに定義があっても物理テーブルが無ければ JOIN は組めない。
        // (通常はマニフェストと実体が一致するが、壊れ方に対して安全側へ倒す。)
        if (
          !physicalTableExists(db, "main", tableId) ||
          !physicalTableExists(db, SNAPSHOT_SCHEMA, tableId)
        ) {
          continue;
        }
        put(changed, tableId, countChangedRows(db, tableId, columns));
      }
    } finally {
      db.run(`DETACH DATABASE ${SNAPSHOT_SCHEMA}`);
    }
  } finally {
    db.close();
  }
  return changed;
}

/** 1テーブル分の「共通列のどれかが違う行」を JOIN 1本で数える。 */
function countChangedRows(db: Database, tableId: string, columns: string[]): number {
  const table = quoteIdentifier(tableId);
  const idColumn = quoteIdentifier(SYSTEM_COLUMNS.id);
  // `IS NOT` は SQLite の NULL 安全な非等価比較(NULL と値の差も拾う)。
  const whereClause = columns
    .map((column) => `c.${quoteIdentifier(column)} IS NOT s.${quoteIdentifier(column)}`)
    .join(" OR ");
  const row = db
    .query<{ n: number }, []>(
      `SELECT COUNT(*) AS n ` +
        `FROM ${table} c ` +
        `JOIN ${quoteIdentifier(SNAPSHOT_SCHEMA)}.${table} s ON c.${idColumn} = s.${idColumn} ` +
        `WHERE ${whereClause}`,
    )
    .get();
  return row?.n ?? 0;
}

// --- 定義ごと消える資源の抽出(ADR-0027 / V1-M9-T06 完了条件9)----------------------

/**
 * 対象 apply の `operations` から「定義ごと消える資源」を抽出する。
 *
 * **DB は1バイトも読まない。** `operations` の配列フィルタだけで足りる(判断ゲート §3)。
 * `remove_table` / `remove_view` / `remove_workflow` は完了条件9 が要求する3種、
 * `remove_function` は同じコストで拾える附帯(ゲート §3 の提案)。
 */
function extractRemovedResources(operations: Operation[]): UndoPreview["removed_resources"] {
  const tables: ResourceId[] = [];
  const views: ResourceId[] = [];
  const workflows: ResourceId[] = [];
  const functions: ResourceId[] = [];
  for (const operation of operations) {
    switch (operation.op) {
      case "remove_table":
        tables.push(operation.table);
        break;
      case "remove_view":
        views.push(operation.view);
        break;
      case "remove_workflow":
        workflows.push(operation.workflow.id);
        break;
      case "remove_function":
        functions.push(operation.function.id);
        break;
      default:
        break;
    }
  }
  return { tables, views, workflows, functions };
}

// --- 公開API -------------------------------------------------------------------

/**
 * undo を実行したら何が起きるかを返す(ADR-0004 §2 / §6)。**状態を一切変更しない。**
 *
 * スナップショットの復元も changelog への追記も行わない。これを呼ぶことは undo 実行の
 * 前提条件ではなく(カーネルは「先に確認したか」を状態として持たない)、確認を挟むかどうかは
 * 呼び出し側の責務である(ADR-0004 §2 / 検証観点への回答)。
 *
 * @param dataRoot データルート(`data/` 相当)。環境変数に依存させず必ず引数で受ける。
 * @param appId 対象アプリのID。
 * @throws マニフェストやスナップショットが読めない/壊れている場合
 */
export function previewUndo(dataRoot: string, appId: string): PreviewUndoResult {
  const store = KernelMetaStore.open(dataRoot);
  let target: ChangelogEntry | undefined;
  try {
    target = selectUndoTarget(store.listChangelog(appId));
  } finally {
    store.close();
  }

  if (target === undefined) {
    return { valid: false, errors: [noUndoTargetError(appId)] };
  }
  const dir = resolveTargetSnapshotDir(dataRoot, appId, target);
  if (dir === undefined) {
    return { valid: false, errors: [unusableSnapshotError(appId, target)] };
  }
  return { valid: true, preview: computePreview(dataRoot, appId, target, dir) };
}

/**
 * redo(= 直前の undo のやり直し)を実行したら何が起きるかを返す(ADR-0032)。**状態を一切変更しない。**
 *
 * 比較の相手が「対象 undo エントリのスナップショット」(undo 実行直前 = 取り消された変更が
 * 入っていた時点)である点だけが `previewUndo` と異なる。**返す形は `UndoPreview` にそろえる**
 * (ゲート §5-4)—— `restored_records` に「redo で戻ってくる件数」、`lost_records` に
 * 「redo で失われる(= undo のあとに追加した)件数」が入る。metadata は対象の undo エントリの
 * もの(`operations` は空、`removed_resources` も空)であり、redo は resource を名指しで消す操作
 * ではない(戻り先の状態を丸ごと復元する)。**「redo があるので undo は安全」とは言わない** ——
 * redo は直前の undo が消した状態を戻すだけで、undo の巻き添えそのものは減らさない(§2-5)。
 */
export function previewRedo(dataRoot: string, appId: string): PreviewUndoResult {
  const store = KernelMetaStore.open(dataRoot);
  let target: ChangelogEntry | undefined;
  try {
    target = selectRedoTarget(store.listChangelog(appId));
  } finally {
    store.close();
  }

  if (target === undefined) {
    return { valid: false, errors: [noRedoTargetError(appId)] };
  }
  const dir = resolveTargetSnapshotDir(dataRoot, appId, target);
  if (dir === undefined) {
    return { valid: false, errors: [unusableRedoSnapshotError(appId, target)] };
  }
  return { valid: true, preview: computePreview(dataRoot, appId, target, dir) };
}

/**
 * 「現在の状態」と「対象エントリのスナップショット」を突き合わせて `UndoPreview` を組む。
 *
 * undo(対象 = apply エントリ。戻り先 = その apply の直前)も redo(対象 = undo エントリ。
 * 戻り先 = その undo の直前)も、構造は「対象の `snapshot` を書き戻すと何が変わるか」で
 * 同一なので、この計算を1箇所に集約する(同じ意味論を2箇所に書かない)。
 */
function computePreview(
  dataRoot: string,
  appId: string,
  target: ChangelogEntry,
  dir: string,
): UndoPreview {
  const currentManifest = readCurrentManifest(dataRoot, appId);
  const snapshotManifest = readSnapshotManifest(dir);
  const currentDbPath = appDbPath(dataRoot, appId);
  const snapshotDbPath = join(dir, SNAPSHOT_DB);

  const { lost, restored } = countRecordChanges(
    currentDbPath,
    snapshotDbPath,
    currentManifest,
    snapshotManifest,
  );
  // 内容だけ変わったレコード(両方に在る `_id` のユーザフィールド差)。sql-attach 方式。
  const changed = countContentChanges(
    currentDbPath,
    snapshotDbPath,
    currentManifest,
    snapshotManifest,
  );

  return {
    target_seq: target.seq,
    diff_id: target.diff_id,
    intent: target.intent,
    applied_at: target.applied_at,
    operations: target.operations,
    lost_records: lost,
    restored_records: restored,
    changed_records: changed,
    // DB を読まず operations の配列フィルタだけで導く(完了条件9)。undo 対象なら apply の
    // remove_* が入り、redo 対象(undo エントリ)は operations が空なので全て空配列になる。
    removed_resources: extractRemovedResources(target.operations),
    note: UNDO_PREVIEW_NOTE,
  };
}

/**
 * まだ取り消されていない直前の apply を取り消す(ADR-0004 §1 / §3 / §4 / §5)。
 *
 * 実体は「対象 apply エントリの `snapshot` を `restoreSnapshot` で書き戻す」ことであり、
 * **その apply 以降に追加・編集されたユーザデータも一緒に消える**。何が消えるかを
 * 事前に知りたい場合は `previewUndo` を使う(カーネルはそれを強制しない)。
 *
 * 拒否された場合(対象なし / スナップショットが使えない)は状態を一切変更しない。
 *
 * @param dataRoot データルート(`data/` 相当)。環境変数に依存させず必ず引数で受ける。
 * @param appId 対象アプリのID。
 * @throws スナップショットの取得・復元・changelog 追記に失敗した場合。
 *         復元後に失敗した場合は undo 直前の状態へ戻したうえで投げ直す。
 */
export function undo(dataRoot: string, appId: string): UndoResult {
  const store = KernelMetaStore.open(dataRoot);
  try {
    const target = selectUndoTarget(store.listChangelog(appId));
    if (target === undefined) {
      return { valid: false, errors: [noUndoTargetError(appId)] };
    }
    const targetSnapshot = target.snapshot;
    if (
      targetSnapshot === null ||
      resolveTargetSnapshotDir(dataRoot, appId, target) === undefined
    ) {
      return { valid: false, errors: [unusableSnapshotError(appId, target)] };
    }

    // ADR-0004 §5: undo も状態を変える操作なので、実行**直前**のスナップショットを取る。
    // ディレクトリ名は `<連番>-undo-<対象diff_id>`。ここへ戻る API は作らない(= redo)。
    // 対象になった apply は以後永久に候補から外れるため、この名前は一意になる(§3)。
    const undoDiffId = `${UNDO_DIFF_ID_PREFIX}${target.diff_id}`;
    // 名前を作れないことは入口で検出する。takeSnapshot の例外に任せると、
    // 他の拒否理由と違ってここだけ例外になり、エラーチャネルが不統一になる。
    if (!isValidResourceId(undoDiffId)) {
      return { valid: false, errors: [unusableUndoIdError(appId, target, undoDiffId)] };
    }
    const before = takeSnapshot(dataRoot, appId, undoDiffId);

    try {
      // ADR-0004 §4: 差分の逆適用ではなく、その apply の直前状態そのものを書き戻す。
      restoreSnapshot(dataRoot, appId, targetSnapshot);

      const entry = store.appendChangelog({
        app_id: appId,
        diff_id: undoDiffId,
        // intent はカーネルが自動生成する。呼び出し側から受け取らない(§3)。
        intent: `${target.diff_id}(${target.intent})を取り消した`,
        // undo を表す op は v0 の語彙に存在しないので発明しない。何を取り消したかは
        // undo_target_seq が指す(§3)。
        operations: [],
        snapshot: before.name,
        kind: "undo",
        undo_target_seq: target.seq,
      });

      return {
        valid: true,
        manifest: readCurrentManifest(dataRoot, appId),
        entry,
        snapshot: before.name,
        restored_from: targetSnapshot,
      };
    } catch (error) {
      // 復元は済んだが changelog に残せなかった、という状態を放置すると
      // 「履歴に現れない巻き戻し」になる(憲法5が壊れる)。undo 直前へ戻してから投げ直す。
      rollback(dataRoot, appId, before.name);
      throw error;
    }
  } finally {
    store.close();
  }
}

/**
 * 直前の undo をやり直す(redo。ADR-0032)。ADR-0004 §1「redo は v0 では作らない」の改訂。
 *
 * 実体は「対象 undo エントリの `snapshot`(= undo 実行直前 = 取り消された変更が入っていた状態)を
 * `restoreSnapshot` で書き戻す」ことである。**戻り先のデータは物理的に残っている**(undo が
 * 実行直前に取ったスナップショット。ADR-0004 §5)ので、実質は「戻る API を足す」だけである。
 *
 * ## UNIQUE(app_id, diff_id) と往復ポリシー(ADR-0032 §3。完了条件4 かつ 5)
 *
 * redo は apply を undo 候補へ戻さない(`redoneUndoSeqs` は `undoneTargetSeqs` と別の集合で、
 * `selectUndoTarget` はこれを見ない)。したがって **apply → undo → redo → undo(再)** で
 * 2度目の undo は同じ apply を選ばず、`undo-<diff_id>` が再生成されて `UNIQUE` に衝突すること
 * が構造的に起きない —— 2度目の undo は「取り消せる変更が無い」で止まる(**有限**の往復)。
 * redo エントリの diff_id は `redo-<対象apply diff_id>` の**1段前置**で、undo が redo され得るのは
 * 各 undo につき1度きり(`selectRedoTarget` が redo 済みを除く)なので、これも一意である。
 *
 * 拒否された場合(対象なし / スナップショットが使えない)は状態を一切変更しない。
 *
 * @param dataRoot データルート(`data/` 相当)。環境変数に依存させず必ず引数で受ける。
 * @param appId 対象アプリのID。
 * @throws スナップショットの取得・復元・changelog 追記に失敗した場合。
 *         復元後に失敗した場合は redo 直前の状態へ戻したうえで投げ直す。
 */
export function redo(dataRoot: string, appId: string): RedoResult {
  const store = KernelMetaStore.open(dataRoot);
  try {
    const target = selectRedoTarget(store.listChangelog(appId));
    if (target === undefined) {
      return { valid: false, errors: [noRedoTargetError(appId)] };
    }
    const targetSnapshot = target.snapshot;
    if (
      targetSnapshot === null ||
      resolveTargetSnapshotDir(dataRoot, appId, target) === undefined
    ) {
      return { valid: false, errors: [unusableRedoSnapshotError(appId, target)] };
    }

    // redo の diff_id は `redo-<対象apply diff_id>`。undo の diff_id `undo-<X>` の前置だけを
    // 差し替える(前置を重ねない。§3)。`redo-` は `undo-` と同じ5文字なので長さは増えない。
    const originalId = target.diff_id.startsWith(UNDO_DIFF_ID_PREFIX)
      ? target.diff_id.slice(UNDO_DIFF_ID_PREFIX.length)
      : target.diff_id;
    const redoDiffId = `${REDO_DIFF_ID_PREFIX}${originalId}`;
    if (!isValidResourceId(redoDiffId)) {
      return { valid: false, errors: [unusableRedoIdError(appId, target, redoDiffId)] };
    }
    // redo も状態を変える操作なので、実行**直前**のスナップショットを取る(ADR-0004 §5 と同じ精神)。
    const before = takeSnapshot(dataRoot, appId, redoDiffId);

    try {
      // ADR-0032: 対象 undo エントリの snapshot(= undo 実行直前の状態)そのものを書き戻す。
      restoreSnapshot(dataRoot, appId, targetSnapshot);

      const entry = store.appendChangelog({
        app_id: appId,
        diff_id: redoDiffId,
        // intent はカーネルが自動生成する。何をやり直したかは undo_target_seq が指す(§3)。
        intent: `${target.diff_id}(${target.intent})をやり直した`,
        // redo を表す op は語彙に存在しないので発明しない(undo と同じ扱い)。
        operations: [],
        snapshot: before.name,
        kind: "redo",
        // やり直した undo エントリの seq(列を増やさず undo_target_seq を転用する。§3)。
        undo_target_seq: target.seq,
      });

      return {
        valid: true,
        manifest: readCurrentManifest(dataRoot, appId),
        entry,
        snapshot: before.name,
        restored_from: targetSnapshot,
      };
    } catch (error) {
      // 復元は済んだが changelog に残せなかった状態を放置すると「履歴に現れない巻き戻し」に
      // なる(憲法5が壊れる)。redo 直前へ戻してから投げ直す(undo と同じ方針)。
      rollback(dataRoot, appId, before.name);
      throw error;
    }
  } finally {
    store.close();
  }
}

/**
 * undo 直前のスナップショットへ書き戻す(`apply-diff.ts` の rollback と同じ考え方)。
 * 巻き戻しにも失敗したら、元の失敗を `cause` に残したまま「戻せなかった」ことを明示する。
 */
function rollback(dataRoot: string, appId: string, snapshotName: string): void {
  try {
    restoreSnapshot(dataRoot, appId, snapshotName);
  } catch (cause) {
    throw new Error(
      `undo に失敗し、さらにスナップショット "${snapshotName}" への巻き戻しにも失敗しました。` +
        `アプリ "${appId}" は中途半端な状態のままです。` +
        `${appId} のスナップショットディレクトリから手動で復元してください。`,
      { cause },
    );
  }
}
