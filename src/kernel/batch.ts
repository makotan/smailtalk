/**
 * バッチ書込 API(EC-G7 / ADR-0039。V2-M4-T01)。
 *
 * **明示的に列挙された有限個のレコード操作**を、**1つの IMMEDIATE トランザクション**で
 * 全成功か全失敗で書く公開関数 `writeRecords` を提供する。親の行1件 + 子の行 N件 +
 * 参照先の行の残数更新 M件のような「1つの手続きの原子書込」を、部分適用ゼロで書ける。
 *
 * ## この経路が持つもの / 持たないもの(ADR-0039 の限定表)
 *
 * - **op は create / update の2種のみ**(delete・スキーマ変更は混ぜない)。
 * - **明示リストのみ** —— where 句・条件付き一括更新・全件更新・反復/ループ構文を1つも持たない。
 *   N の生成は呼び出し側の明示列挙で行う。
 * - **1 IMMEDIATE tx で全成功か全失敗** —— 途中の1 op でも失敗(validation / unique 違反 /
 *   CAS 競合 / 参照整合性)なら全体を巻き戻し1バイトも書かない。
 * - **update op は `if_match` CAS で守る** —— 既存 `updateRecord(..., expectedVersion)` を通し、
 *   CAS 失敗(版不一致)ならバッチ全体を巻き戻す(更新の取りこぼし防止の土台)。
 * - **`$defs/action_value`(限定12)を1バイトも触らない** —— op の値は普通のレコード値で
 *   `validateInput` を通る。「今の値 − 変化分」の**演算は呼び出し側 or Route B が行い、
 *   カーネルは計算済みの値を受け取るだけ**である(式言語を1つも持たない)。
 *
 * ## なぜ IMMEDIATE をここにだけ入れるか(ADR-0018 / ADR-0039 §1b)
 *
 * バッチの read-then-CAS-update(今の値を読んで CAS で減算)は、ADR-0018 が「busy_timeout=0 で
 * 500 になるので BEGIN IMMEDIATE が実解」と述べたケースそのものである。書込ロックを BEGIN 時に
 * 取ることで昇格デッドロックが起きない。**既存の deferred `writeWithAudit`(`app.ts`)は
 * 1バイトも書き換えない** —— IMMEDIATE はこのバッチ経路にのみ導入する。
 *
 * ## なぜ `writeWithAudit` を内側で呼ばないか
 *
 * `writeWithAudit` は自前で `db.transaction(...)`(deferred)を開く。それをこの IMMEDIATE tx の
 * 内側で呼ぶと deferred tx がネストしてしまう。よってバッチは `createRecord` / `updateRecord` を
 * **直接** IMMEDIATE tx 内で呼び、監査記録は `onWritten` フック(呼び出し側=HTTP が渡す)で
 * 同じ tx に束ねる(MCP は無認証なので監査を渡さない —— 既存の MCP write ツールと同じ非対称)。
 */
import type { Database } from "bun:sqlite";
import type { ValidationError } from "./errors.ts";
import { createRecord, type RecordInput, type RecordRow, updateRecord } from "./records.ts";
import type { Manifest, ResourceId } from "./types.ts";

/** バッチの create op(同一アプリのテーブルへ1行作成)。 */
export type BatchCreateOp = {
  op: "create";
  table: ResourceId;
  values: RecordInput;
};

/**
 * バッチの update op(同一アプリのテーブルの1行を部分更新)。
 *
 * `target` は更新対象の `_id`(この T01 では定数 `_id` を想定。workflow の `$record.<field>`
 * 解決は T02 の範囲であり T01 では扱わない)。`if_match` を渡すと CAS(版一致更新)になり、
 * 版不一致ならバッチ全体が巻き戻る(更新の取りこぼし防止)。
 */
export type BatchUpdateOp = {
  op: "update";
  table: ResourceId;
  target: string;
  values: RecordInput;
  if_match?: string;
};

/** バッチ1件の操作(create / update の2種のみ)。 */
export type BatchOp = BatchCreateOp | BatchUpdateOp;

/** `onWritten` フックに渡す「書けた1件」。監査記録を同一 tx に束ねるために使う。 */
export type BatchWrittenOp = { index: number; op: BatchOp; record: RecordRow };

/** `writeRecords` のオプション。 */
export type WriteRecordsOptions = {
  /**
   * 各 op が成功した直後に**同一 IMMEDIATE tx 内で**呼ばれるフック。監査 INSERT
   * (`recordActivity`)をバッチ tx に束ねるために HTTP 経路が渡す。後続 op が失敗して
   * tx が巻き戻れば、このフックが書いた行も一緒に巻き戻る(部分適用ゼロ)。
   */
  onWritten?: (written: BatchWrittenOp) => void;
};

/** バッチ書込の結果。成功なら書けた行の配列、失敗なら統一エラー + どの op で落ちたか。 */
export type WriteRecordsResult =
  | { ok: true; results: RecordRow[] }
  | { ok: false; errors: ValidationError[]; conflict?: true; failedIndex?: number };

/**
 * 1 op の失敗を IMMEDIATE tx 内から巻き戻すために投げる内部例外。
 *
 * `createRecord` / `updateRecord` は検証失敗を**戻り値**(`ok:false`)で返すので、
 * それを tx のロールバックへつなぐには**投げる**必要がある(bun:sqlite の
 * `db.transaction(fn)` は fn が投げたときだけ巻き戻す)。tx の外でこの例外を捕まえ、
 * 統一形式の失敗へ変換する。
 */
class BatchOpFailure extends Error {
  constructor(
    readonly index: number,
    readonly errors: ValidationError[],
    readonly conflict: boolean,
  ) {
    super("batch op failed");
    this.name = "BatchOpFailure";
  }
}

/** create/update 以外の op を弾くときの統一エラー(語彙は2種のみ)。 */
function unknownBatchOpError(index: number, given: unknown): ValidationError {
  return {
    path: `/ops/${index}/op`,
    message: `バッチの操作 "${String(given)}" は語彙にありません。`,
    allowed_values: ["create", "update"],
    hint: "バッチで書けるのは create / update の2種だけです(delete やスキーマ変更は混ぜられません)。",
  };
}

/**
 * 入力 op リストの**構造**を検証する(tx を開く前)。
 *
 * ここで見るのは「明示リストであること」「op が create/update の2種であること」「必須キーが
 * 揃っていること」までで、**値そのものの検証(型・必須・参照・unique)は `createRecord` /
 * `updateRecord` に委ねる**(ADR-0003 §7。検証をカーネルの1関門に集約する)。
 */
function validateBatchStructure(
  ops: readonly unknown[],
): { ok: true; ops: BatchOp[] } | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  const validated: BatchOp[] = [];

  // **op が0件のときの判定はここに無い**(`ADR-0131` 単位A = 限定採用。V4-M34-T01)。
  // **`writeRecords` の入口で `{ ok: true, results: [] }` を返して先に抜ける** ——
  // ここへ来る `ops` は常に1件以上である。**判定を1つも複製しない。**
  ops.forEach((raw, index) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      errors.push({
        path: `/ops/${index}`,
        message: "バッチの各操作は { op, table, values, ... } のオブジェクトでなければなりません。",
        hint: 'op に "create" か "update" を、table にテーブルIDを指定してください。',
      });
      return;
    }
    const op = raw as Record<string, unknown>;
    const kind = op.op;
    if (kind !== "create" && kind !== "update") {
      errors.push(unknownBatchOpError(index, kind));
      return;
    }
    if (typeof op.table !== "string" || op.table === "") {
      errors.push({
        path: `/ops/${index}/table`,
        message: "table(書き込み先テーブルID)が必要です。",
        hint: "同一アプリに実在するテーブルIDを指定してください。",
      });
      return;
    }
    if (typeof op.values !== "object" || op.values === null || Array.isArray(op.values)) {
      errors.push({
        path: `/ops/${index}/values`,
        message: "values(フィールドID → 値 のオブジェクト)が必要です。",
        hint: '{ "<field_id>": value, ... } の形で指定してください。',
      });
      return;
    }
    if (kind === "create") {
      validated.push({ op: "create", table: op.table, values: op.values as RecordInput });
      return;
    }
    // update: target 必須・if_match は任意(あれば文字列)。
    if (typeof op.target !== "string" || op.target === "") {
      errors.push({
        path: `/ops/${index}/target`,
        message: "update には target(更新対象レコードの _id)が必要です。",
        hint: "更新するレコードの _id を target に指定してください。",
      });
      return;
    }
    if (op.if_match !== undefined && typeof op.if_match !== "string") {
      errors.push({
        path: `/ops/${index}/if_match`,
        message: "if_match(期待する版 _updated_at)は文字列で指定してください。",
        hint: "更新前に読んだレコードの _updated_at を渡すと、版一致時のみ更新します(売り越し防止)。",
      });
      return;
    }
    validated.push({
      op: "update",
      table: op.table,
      target: op.target,
      values: op.values as RecordInput,
      ...(op.if_match !== undefined ? { if_match: op.if_match as string } : {}),
    });
  });

  return errors.length > 0 ? { ok: false, errors } : { ok: true, ops: validated };
}

/** 1 op の失敗エラーに「どの op か」を示す接頭辞(`/ops/<i>`)を付ける。 */
function prefixOpErrors(index: number, errors: ValidationError[]): ValidationError[] {
  return errors.map((error) => ({ ...error, path: `/ops/${index}${error.path}` }));
}

/**
 * 明示リストの op を1 IMMEDIATE トランザクションで全成功か全失敗で書く(ADR-0039)。
 *
 * @param db       アプリの `app.sqlite` への接続(呼び出し側が開閉する)。
 * @param manifest 値検証・参照確認・カスケード発火に使う唯一の権威。
 * @param ops      **明示列挙された有限個**の create/update op。
 * @param options  `onWritten`(監査 INSERT を同一 tx に束ねるフック)など。
 *
 * @returns 成功なら書けた行の配列(op と同順)。失敗なら統一エラー・`conflict`(CAS 競合)・
 *          `failedIndex`(落ちた op の位置)。失敗時は**1バイトも書かれていない**。
 */
export function writeRecords(
  db: Database,
  manifest: Manifest,
  ops: readonly BatchOp[],
  options: WriteRecordsOptions = {},
): WriteRecordsResult {
  // 0) **「書くことが1件も無かった」指示は、0件書けた成功として受ける**(`ADR-0131` 単位A。
  //    V4-M34-T01)。**判定はこの1箇所だけが持ち、入口ごとの分岐を1つも作らない** ——
  //    HTTP バッチ / MCP `write_records` / 島の第3モード / 画面の4本の入口はすべて
  //    この同じ戻り値を受ける(単位B は却下。`ADR-0003` §7 / `workflow-runner.ts` の逐語
  //    「**判定を1つも複製しない**(重複させると経路によって語彙が割れる)」)。
  //
  //    **戻り値は `{ ok: true, results: [] }` の1形である**(限定2)——
  //    新しい形もフィールドも1つも足さない。**書いたとは主張していない**(憲法6)。
  //
  //    **ディスクを1バイトも動かさず、tx を1回も開かない**(限定3)——
  //    `onWritten` を1度も呼ばず、監査行も履歴行も1件も書かない。
  //
  //    **【失うものを正直に書く】** **呼び出し側のバグ(op を組み立て損ねた)が loud に
  //    落ちる性質は失われる**(`ADR-0131` §限界2)。**「書くことが無かった」と
  //    「組み立てられなかった」の区別は今日も明日も無い** —— 潰す先を変えただけである。
  //    **「区別できるようになった」と書いてはならない。**
  if (ops.length === 0) {
    return { ok: true, results: [] };
  }

  // 1) 構造検証(tx を開く前)。ここで落ちれば tx を1回も開かない。
  const structure = validateBatchStructure(ops);
  if (!structure.ok) {
    return { ok: false, errors: structure.errors };
  }

  // 2) 各 op を IMMEDIATE tx で実行。1 op でも失敗(戻り値 ok:false)なら投げて全巻き戻し。
  const body = (): RecordRow[] => {
    const results: RecordRow[] = [];
    structure.ops.forEach((op, index) => {
      const result =
        op.op === "create"
          ? createRecord(db, manifest, op.table, op.values)
          : updateRecord(db, manifest, op.table, op.target, op.values, op.if_match);
      if (!result.ok) {
        // 検証失敗 / CAS 競合 / 参照整合性違反 → 投げて tx をロールバックさせる。
        throw new BatchOpFailure(
          index,
          prefixOpErrors(index, result.errors),
          result.conflict === true,
        );
      }
      results.push(result.value);
      // 監査 INSERT 等を同一 tx に束ねる(HTTP 経路が onWritten を渡す。MCP は渡さない)。
      options.onWritten?.({ index, op, record: result.value });
    });
    return results;
  };

  // **BEGIN IMMEDIATE**(bun:sqlite の `transaction(fn).immediate()`)。書込ロックを begin 時に取る。
  const tx = db.transaction(body);
  try {
    const results = tx.immediate();
    return { ok: true, results };
  } catch (error) {
    if (error instanceof BatchOpFailure) {
      // op の失敗は統一形式で返す(部分適用ゼロ = ここに来た時点で tx は巻き戻っている)。
      return error.conflict
        ? { ok: false, conflict: true, errors: error.errors, failedIndex: error.index }
        : { ok: false, errors: error.errors, failedIndex: error.index };
    }
    // SQLITE_BUSY(IMMEDIATE の begin 時にロック取得失敗)やその他の想定外例外は握り潰さない
    // —— 静かな部分適用にせず、呼び出し側(配線層)へ伝播させる。
    throw error;
  }
}
