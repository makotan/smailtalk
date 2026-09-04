/**
 * 更新系ツール(V0-P5-T03 で4つ / V1-M0-T01 で update_record・delete_record の2つ。ADR-0005)。
 *
 * 参照系(`read.ts`)と同じく、この層の責務は「MCP ⇄ カーネル」の変換だけである。
 * ただし更新系には、参照系には無い**契約**がいくつかある。ここに書き出しておく。
 *
 * ## 契約1: `isError: true` は「何も変わっていない」を意味する
 *
 * カーネルの変更系(`applyDiff` / `undo`)は検証を全部通してから初めて書くので、
 * エラーで返ったときディスクは1バイトも動いていない。この性質を MCP の
 * `isError` にそのまま持ち上げることで、**LLM はエラーを見たら安全に再試行できる**。
 * この規約があるからこそ `insert_sample_data` の部分成功を `isError: true` に
 * できない(契約3)。
 *
 * ## 契約2: 例外を漏らさない
 *
 * `createApp` は空のアプリ名・規約違反の app_id・ID衝突で**素の `Error` を投げる**
 * (`src/kernel/create-app.ts`)。カーネル単体としては妥当な判断
 * (「差分を直せば解決する」種類の失敗ではないため)だが、MCP の入口では話が違う。
 * LLM は名前もIDも自由に組み立てて渡してくるので、これらは実際には**最も頻度の高い
 * 入力ミス**であり、しかも `path` さえ返せば1往復で自己修正できる。
 * したがってここで捕まえて統一形式に変換する。`requireApp`(R1)と同じ発想である。
 *
 * ## 契約3: 部分成功を失敗と呼ばない(R7)
 *
 * `insert_sample_data` は行ごとに独立して検証・挿入するため、
 * 「3行のうち1行だけ落ちる」が普通に起きる。ここで `isError: true` を立てると
 * 契約1と意味が衝突し、LLM は「何も入っていない」と読んで `rows` 全体を再送する。
 * 結果、成功していた行が**重複して二重に入る**。だから部分成功は `isError: false` で
 * `{ inserted, failed }` を返し、「再試行は failed の index の行だけ」と
 * description に明記する。
 *
 * ## 入力スキーマを浅くしてある理由
 *
 * `diff.operations` と `rows` は、zod では `z.array(z.record(z.string(), z.unknown()))`
 * という**ほぼ何でも通る形**にしてある。手抜きではなく意図的な設計である。
 * 深い zod スキーマを書くと、入力が壊れているときに LLM が受け取るのは
 * zod のメッセージ(英語・JSON Path ではない・`allowed_values` が無い)になり、
 * Phase 1 で統一した形式(`path` + `message` + `allowed_values`)が**入口で上書き
 * されてしまう**。それは ADR-0003 §7(バリデーションはカーネルにしか置かない)への
 * 違反でもある。浅く受けてカーネルに渡し、カーネルの統一形式エラーをそのまま
 * 返すのが正しい。`intent` の必須・非空も同じ理由で **zod では課さない**
 * (V0-P5-T05 で実測: 課すと SDK が handler 手前で弾き、`structuredContent` の無い
 * 英語の zod エラーが返って統一形式が壊れる)。handler 側で統一形式を組み立てる。
 * ただし description には「必須である」ことを書き続ける —— `tools/list` に出る
 * 説明は LLM への指示として機能し、スキーマの緩さとは別の話だからである。
 */
import { Database } from "bun:sqlite";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Role } from "../../auth/types.ts";
import { AiCapabilityStore } from "../../kernel/ai-capability-store.ts";
import { CapabilityStore } from "../../kernel/capability-store.ts";
import { EscapeHatchStore } from "../../kernel/escape-hatch-store.ts";
import { InboundStore } from "../../kernel/inbound-store.ts";
import {
  type ApplyStatus,
  appDbPath,
  applyDiff,
  type BatchOp,
  CONCURRENT_WRITE_WAIT_PRAGMA,
  concurrentWriteBusyErrors,
  createApp,
  createRecord,
  deleteApp,
  deleteRecord,
  getRecord,
  isApplyInProgress,
  isValidResourceId,
  KernelMetaStore,
  listRecords,
  type Manifest,
  previewRedo,
  previewUndo,
  type RecordRow,
  readCurrentManifest,
  readOnlyTableError,
  redo,
  resetWorkflowHistoryFailureHandler,
  setWorkflowHistoryFailureHandler,
  undo,
  unknownTableError,
  updateRecord,
  type ValidationError,
  type WorkflowHistoryWriteFailure,
  writeRecords,
} from "../../kernel/index.ts";
import { recordAccessLimitError } from "../../server/errors.ts";
import {
  combineRoleAndCreatorGrant,
  creatorGrantPlan,
  type GrantWriteOp,
  isAllowedOwnerUpdate,
  isOwnerVisible,
  judgeGrantWrite,
  judgeOwnerScopedOp,
  judgeRoleAccess,
  judgeRoleFieldWrite,
  OWNER_FIELD,
  personalOwnerField,
  recordAccessSourceTables,
  resolveCombinedRecordAccess,
  roleGateBlocksWithoutGrants,
} from "../../server/owner-scope.ts";
import { routePath } from "../../shared/route.ts";
import { isSystemTableId } from "../../shared/system-tables.ts";
import { requireActor, requireActorAndApp } from "../actor-guard.ts";
import { toolError, toolOk } from "../result.ts";
import type { CreateMcpServerOptions } from "../server.ts";
import {
  AFTER_DELETE_GUIDE,
  APP_ID_CONFLICT_CONSENT,
  APPLY_DIFF_OP_EXAMPLES,
  DELETE_APP_SHOW_CONTENTS_FIRST,
  DELETE_RECORD_SHOW_TARGET_FIRST,
  DESTRUCTIVE_CHANGE_FLOW,
  describeTool,
  INTENT_VERBATIM,
  RECORD_WRITE_NOT_IN_CHANGELOG,
  RECORD_WRITE_SELF_REPORT,
  RECORD_WRITE_SYSTEM_TABLE_READONLY,
  SAMPLE_DATA_NO_ESCAPE,
  UNDO_ROLLBACK_LIMIT,
  UPDATE_VIEW_ACCEPTED_KEYS,
} from "../vocabulary.ts";

/** app_id 引数の共通定義(`read.ts` と同じ説明にそろえる)。 */
const appIdArg = z.string().describe("対象アプリのID。list_apps で取得できる。");

/**
 * 差分の入力スキーマ。
 *
 * `operations` を浅くしてある理由はファイル冒頭を参照。`intent` も同様に浅く受けるが、
 * **必須・非空であること自体は譲らない** —— changelog の中身そのもの
 * (憲法5「changelog が要件定義書」)であり、空文字で通すと「なぜこの変更を入れたか」が
 * 永久に失われる。検査を zod ではなく handler で行うだけである(下の注記を参照)。
 */
const diffArg = z
  .object({
    diff_id: z.string().describe(
      'この変更を識別するID。例: "d-003-tags"。' +
        // ADR-0028 / V1-M9-T08: undo は "undo-<diff_id>" という名前でスナップショットを
        // 取るため、59文字を超える diff_id は適用できても undo できなくなる(憲法4)。
        // 入力規約として先に告げる(拒否時の取り違えを減らす)。
        "undo できるよう59文字以内にすること(60文字以上は apply_diff が拒否する)。",
    ),
    // `.min(1)` を**あえて課さない**(V0-P5-T05)。zod で必須・非空を課すと、
    // 違反時に SDK が handler を呼ぶ前に弾き、クライアントには
    // `MCP error -32602: Input validation error: ... "message": "Too small: expected
    // string to have >=1 characters"` という **zod の英語メッセージ**が返る。
    // これは `content` にテキストが入るだけで `structuredContent` が無く、`path` も
    // JSON Pointer ではなく `["diff","intent"]` という配列で、`hint` も無い。
    // つまり Phase 1 で統一したエラー形式(`path` + `message` + `allowed_values`)が
    // **入口で丸ごと上書きされる**。ファイル冒頭「入力スキーマを浅くしてある理由」で
    // operations について述べたのとまったく同じ問題が、intent でも起きていた。
    // よってスキーマ上は optional にして SDK に横取りさせず、handler 側で
    // 統一形式のエラーを組み立てる(`create_app` の空名ガードと同じ形)。
    // description は残す —— `tools/list` に出る「必須である」という説明は
    // それ自体が LLM への指示として価値があり、失うべきではない。
    intent: z
      .string()
      .optional()
      .describe(
        "この変更で何をしたいのか、ユーザの言葉のままの日本語。" +
          "要約や機械語への言い換えをせずに書くこと。変更履歴にそのまま残り、" +
          "後から「なぜこうなっているか」を答える唯一の記録になる。" +
          // V0-P7-T04 / F-22。実地では「言い換えるな」だけでは足りず、AI は
          // 良かれと思って語尾や接続詞を整えていた。禁止する操作を名指しする。
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

/** アプリ内DBを開いて処理し、必ず閉じる(`src/server/app.ts` の `withAppDb` と同じ形)。 */
function withAppDb<T>(dataRoot: string, appId: string, run: (db: Database) => T): T {
  const db = new Database(appDbPath(dataRoot, appId), { readwrite: true, create: false });
  // 同じアプリへの同時書込を待たせる(V3-M13-T15 / ADR-0069 §Decision 2)。
  // **値も PRAGMA 文もカーネルの定数1つに閉じている**(限定2 / 限定12)——
  // `src/server/app.ts` の同名ヘルパーと**同じ定数**を流すので、入口で値がずれない。
  // **この経路には外側 tx が無いので、待ち時間だけで昇格デッドロックは起きない**
  // (`createRecord` / `updateRecord` は検証の SELECT を器の外で行う)。
  db.exec(CONCURRENT_WRITE_WAIT_PRAGMA);
  try {
    return run(db);
  } finally {
    db.close();
  }
}

/**
 * ワークフロー実行履歴の書き込み失敗を、**その1回の同期書き込みが生んだぶんだけ**集める
 * (V1-M9-T12。`src/server/app.ts` の同名ヘルパーと同じ形 —— `withAppDb` を両層で写している
 * のと同じ理由で、カーネルへの依存だけを共有し実体は入口ごとに置く)。
 *
 * 既定の `historyFailureHandler` は `console.error` するだけで会話に届かない。ここで
 * 収集用ハンドラを**書き込みの直前に差し込み、直後に既定へ戻す**(`setWorkflowClock` と
 * 同じ install→呼び出し→collect→restore の作法)。`run` は同期でなければならない ——
 * `await` を挟むと収集窓が開いたまま他の発火(別プロセスなら無関係だが、同一プロセスの
 * スケジューラ発火など)が割り込みうる。単一の同期区間に閉じることで、混入せず取りこぼさない。
 *
 * `createRecord` / `updateRecord` とその内側の `runWorkflows` はすべて同期なので、この
 * 制約は自然に満たされる(`insert_sample_data` は行ループ全体を1区間で包み、全行ぶんの
 * 失敗をまとめて集める)。
 */
function collectWorkflowHistoryFailures<T>(run: () => T): {
  value: T;
  failures: WorkflowHistoryWriteFailure[];
} {
  const failures: WorkflowHistoryWriteFailure[] = [];
  setWorkflowHistoryFailureHandler((failure) => failures.push(failure));
  try {
    return { value: run(), failures };
  } finally {
    // 前ハンドラ(本番では常に既定の `console.error`)へ戻す。カーネルには getter を
    // 足さない(門外の担保)ので、reset で既定へ復帰する = 本番では前ハンドラへの復帰と一致。
    resetWorkflowHistoryFailureHandler();
  }
}

// --- 同時実行の保護(V1-M9-T02 / ADR-0017)---------------------------------------
//
// 楽観ロックの衝突(版不一致)は**カーネルが返す** `versionConflictError` をそのまま
// `toolError` に載せるので、HTTP 409 と message/hint が定義上一致する(ADR-0003 §7)。
// ここで定義するのは配線層でしか生じない2つ ——「if_match が無い」(MCP 固有。HTTP は
// If-Match ヘッダ)と「適用中」—— である。
//
// **`applyInProgressError` は HTTP(`src/server/app.ts`)と message/hint を完全一致させる。**
// 両者は同一文字列を持ち、`src/mcp/tools/write.test.ts` の一致 assert がドリフトを検出する
// (共有モジュールを置くと server↔mcp の依存辺ができるため、あえて同一文字列 + assert で担保)。

/**
 * 適用中(apply 窓)エラー。**HTTP 側 `applyInProgressError` と同一の message/hint。**
 * `startedAt` はマーカーの `started_at`(あれば括弧で添える)。
 */
export function applyInProgressError(status: ApplyStatus): ValidationError {
  const suffix = status.startedAt !== undefined ? `(開始 ${status.startedAt})` : "";
  return {
    path: "",
    message: `このアプリは現在変更を適用中です${suffix}。少し待って再試行してください。`,
    hint: "変更の適用(apply_diff)が完了するまで、レコードの作成・更新・削除はできません。数秒待ってから同じ操作をやり直してください。",
  };
}

/** if_match(期待する版)が無い場合のエラー。MCP 固有(HTTP は If-Match ヘッダの欠落)。 */
function missingIfMatchError(): ValidationError {
  return {
    path: "/if_match",
    message: "if_match(期待する版)が必要です。",
    hint: "更新・削除するレコードの現在の版(list_records で得られる _updated_at)を if_match に指定してください。先に読み直した最新の版を渡すことで、他の操作を黙って上書きしません。",
  };
}

// --- 判定の断り文(`V8-M31-T04` / `T05`)-------------------------------------------
//
// **文面は HTTP(`src/server/app.ts`)の同じ事象の応答体から逐語で写した。**
// **写す理由は `delete_record` の「存在しません」と同じである** —— **同じ事象が入口ごとに
// 別の文章になると、AI は2つの別々の失敗だと学習する。** **`hint` だけを MCP の道具名
// (`set_roles` / `list_records`)に差し替える。**
//
// **【なぜ import ではなく写しなのか】** —— **`src/server/app.ts` のこれらの関数は
// モジュール私有(`export` されていない)であり、export を足すと本 MS が
// `src/server/app.ts` を書き換えることになる。** **`applyInProgressError` が同じ理由で
// 「同一文字列 + 突き合わせ assert」を採っている**(このファイルの上の注記)。
// **写しである以上、片方だけを変えると黙ってずれる。**

/** アプリの設定に触る権限が役割の規則に無い(HTTP の `appChangeRuleRequiredError` の写し)。 */
function appChangeRuleRequiredError(): ValidationError {
  return {
    path: "",
    message:
      "アプリの作りを変更できるのは、その権限を役割の規則で与えられた人だけです。あなたの役割には与えられていません。",
    hint: 'テーブル・画面・ワークフロー・テーマの変更と、その取り消しには、役割の規則(app の roles)に「アプリの設定を変更できる」(target: "app" / can: ["write"])が要ります。規則を書ける人に依頼してください。',
  };
}

/**
 * **アプリの設定に触れるか**(**(B)群8本**。`T-G23a`)。
 *
 * **HTTP の `changeAuthMiddleware`(`src/server/app.ts` の `POST /diffs` / `POST /undo`)と
 * まったく同じ呼び方である** —— **`judgeRoleAccess` が返した `allowed` を見るだけ。**
 *
 * **【読めないマニフェストは閉じる側に倒れる。隠さない】** —— **HTTP は `loadManifest` を
 * `try` で包み、読めなければ `undefined` を渡す。** **`undefined` を渡すと
 * `judgeRoleAccess` は「役割の宣言が0件」として閉じる**(`D-V8-59` / `D-V8-65`)。
 * **MCP でも同じ向きに倒す** —— **アプリの実在そのものは `requireActorAndApp` が既に
 * 分けているので、ここで閉じるのは「壊れた定義を直す口」だけの話である。**
 *
 * =====================================================================================
 * **【`V10-M28-T01`。`registerWriteTools` の閉包から、この位置へ出した】**
 * =====================================================================================
 *
 * **参照系(`src/mcp/tools/read.ts` の `dry_run_diff`)が、更新系(`apply_diff`)と
 * **同じ1本**を通るためである。** **`export` していなければ、向こうに同じ条件式を
 * 書き写すことになる** —— **それは「判定の家の2軒目」であり、このファイルの
 * `registerWriteTools` の中の doc が名指しで禁じている形である。**
 *
 * **【実装は1バイトも変えていない】** —— **`dataRoot` を閉包から捕まえる代わりに
 * 引数で受ける。それだけである。** **判定の呼び方も、断り文も、閉じる向きも同じ。**
 *
 * **【正直に書く。これは「参照系が書込の判定を通る」ことである】** —— **`dry_run_diff` は
 * 本体を1バイトも変えない参照系のままだが、**返す中身**は「変えたらどうなるか」であり、
 * 変えられない相手に返す理由が無い。** **登録先(`registerReadTools`)も
 * `WRITE_TOOLS` の一覧も1バイトも動かしていない。**
 *
 * @param dataRoot データルート。**閉包で捕まえず、必ず引数で受ける**(`app-guard.ts` と同じ作法)。
 */
export function denyAppSettingWrite(
  dataRoot: string,
  appId: string,
  roles: Role[],
): ValidationError[] | null {
  let manifest: Manifest | undefined;
  try {
    manifest = readCurrentManifest(dataRoot, appId);
  } catch {
    manifest = undefined;
  }
  return judgeRoleAccess({ manifest, roles, target: { target: "app" }, verb: "write" }).allowed
    ? null
    : [appChangeRuleRequiredError()];
}

/**
 * 面(役割に束ねた権限)がその対象を許していない(HTTP の `forbiddenRoleAccessError` の写し)。
 *
 * **【`V8-M39` / 台帳 `F-G8`。写しを追随させた】**
 * **旧の `message`(逐語)**: `` `${what} に対する${verb}は、あなたの役割に許されていません。` ``
 *
 * **HTTP 側(`src/server/app.ts`)が 403 の文面の末尾に `(止めた層: role)` を出すように
 * なったので、こちらも同じ文字列にした** —— **上の注記の逐語「**写しである以上、
 * 片方だけを変えると黙ってずれる。**」の履行である。**
 *
 * **【正直に書く。ここは HTTP の 403 ではない】** —— **`F-G8` の限定は
 * 「**403 のときだけ**(404 と空一覧には出さない)」であり、MCP には HTTP の応答コードが
 * 無い。** **本関数が返るのは HTTP の 403 と1対1で対応する事象(面が止めた書込)だけであり、
 * MCP 側の「見えない行」は今日どおり `invisibleRecordError`(= HTTP の 404 の写し)が
 * 返すので、伏せ方は1バイトも変わっていない。**
 * **層の名前を綴りで書いているのは、この写しが `src/server/` の定数を1つも import して
 * いないためである**(上の注記の「import ではなく写し」の理由と同じ)。
 */
function forbiddenRoleAccessError(what: string, verb: string): ValidationError {
  return {
    path: "",
    message: `${what} に対する${verb}は、あなたの役割に許されていません(止めた層: role)。`,
    hint:
      "アプリの役割の一覧(roles)で、この対象にその操作を許す規則(rules)を持つ役割が要ります。" +
      "規則は足すことしかできません(拒否は書けません) —— set_roles で役割に規則を足してください。",
  };
}

/** 行ごとのアクセス権で「書く」を持たない(HTTP の `forbiddenRecordWriteError` の写し)。 */
function forbiddenRecordWriteError(): ValidationError {
  return {
    path: "",
    message: "この行を書き換える権限がありません(読むことはできます)。",
    hint: "この行を編集できる権限を、この行を作った人か運営者に付けてもらってください。",
  };
}

/** 行ごとのアクセス権で「消す」を持たない(HTTP の `forbiddenRecordDeleteError` の写し)。 */
function forbiddenRecordDeleteError(): ValidationError {
  return {
    path: "",
    message: "この行を消す権限がありません(読むことはできます)。",
    hint: "この行を消せる権限を、この行を作った人か運営者に付けてもらってください。",
  };
}

/**
 * **見えない行は「存在しない」と同じ文面で伏せる**(HTTP の `unknownRecordError` の写し。
 * `hint` だけ MCP の道具名にする)。**403 を返すと「その行が在る」ことが漏れる。**
 */
function invisibleRecordError(tableId: string, recordId: string): ValidationError {
  return {
    path: "",
    message: `テーブル "${tableId}" にレコード "${recordId}" は存在しません。`,
    hint: "list_records で実在する _id を確認してください(既に削除済みの可能性もあります)。",
  };
}

/**
 * **個人スコープ(`st_owner`)の付け替え拒否**(HTTP の `forbiddenOwnerError` の写し。
 * **`V8-M31` 第6波・裁定 `M31-13`**)。
 *
 * **`path` / `message` / `allowed_values` / `hint` を1文字も変えずに写した** ——
 * **この4つに HTTP の言葉も道具名も1つも含まれていない**(上の `invisibleRecordError` が
 * `hint` だけ差し替えているのとは事情が違う)。**写しである以上、片方だけを変えると
 * 黙ってずれる。**
 */
function forbiddenOwnerError(): ValidationError {
  return {
    path: `/${OWNER_FIELD}`,
    message: "この所有者(st_owner)への変更は許可されていません。",
    allowed_values: ["(自分)", "(共有=null)"],
    hint: "自分が所有する行は共有(st_owner を null)にできますが、他ユーザ所有への付け替えや共有行の私物化はできません。",
  };
}

/** メンバー表に登録が無い(HTTP の `notAMemberError` の写し)。 */
function notAMemberError(): ValidationError {
  return {
    path: "",
    message: "あなたはこのアプリのメンバー表に登録されていないため、この表に行を作れません。",
    hint: "この表を使えるようにするには、アプリの管理者にあなたを利用者として登録してもらってください。",
  };
}

/** 作った人に権限が1つも渡らない(HTTP の `creatorGrantUnreachableError` の写し)。 */
function creatorGrantUnreachableError(): ValidationError {
  return {
    path: "",
    message: "この表は、行を作った人に権限が1つも渡らない設定になっているため、行を作れません。",
    hint: "アプリを作った人に、行を作った人へ渡す権限の設定を見直してもらってください。",
  };
}

// --- 付与表への書込の断り文(`V8-M31` 第3波)---------------------------------------
//
// **6本とも HTTP(`src/server/app.ts`)の同名関数から逐語で写した。**
// **`hint` も1文字も変えていない** —— **この6本の `hint` は HTTP の言葉も道具名も
// 1つも含んでいないからである**(上の7本は `hint` だけ MCP の道具名に差し替えている)。
// **写しである以上、片方だけを変えると黙ってずれる。**

/** 参加者・グループの表そのものへの書込(HTTP の `forbiddenMembershipWriteError` の写し)。 */
function forbiddenMembershipWriteError(kind: "member" | "group"): ValidationError {
  const what = kind === "member" ? "参加者" : "グループ";
  return {
    path: "",
    message: `${what}の表は、アプリの運営者だけが書き換えられます。`,
    hint:
      "自分の所属や、自分のアカウントの結びつきを自分で書き換えることはできません" +
      "(書き換えられると、他の人に配ってある権限を受け取れてしまうためです)。" +
      "変更が必要なときは、アプリの運営者に頼んでください。",
  };
}

/** 作成者でも運営者でもない(HTTP の `forbiddenGrantWriteError` の写し)。 */
function forbiddenGrantWriteError(): ValidationError {
  return {
    path: "",
    message: "この行の権限を他の人に渡せるのは、この行を作った人と運営者だけです。",
    hint: "この行を作った人か、アプリの運営者に頼んでください。",
  };
}

/** 自分に権限を付ける要求(HTTP の `forbiddenSelfGrantError` の写し)。**運営者も例外ではない。** */
function forbiddenSelfGrantError(): ValidationError {
  return {
    path: "",
    message: "自分に権限を付けることはできません。",
    hint: "他の人やグループに権限を渡すことはできます。自分の権限は、この行を作った人か運営者に付けてもらってください。",
  };
}

/** 相手が利用者の表の行として解決できない(HTTP の `unknownGrantHolderError` の写し)。 */
function unknownGrantHolderError(): ValidationError {
  return {
    path: "",
    message: "権限を渡す相手が、このアプリの利用者として登録されていません。",
    hint: "先に相手を利用者として登録するか、実在するグループを選んでから、もう一度試してください。",
  };
}

/** 相手が引き継ぎ元の親の行を読めない(HTTP の `forbiddenGrantParentAccessError` の写し)。 */
function forbiddenGrantParentAccessError(): ValidationError {
  return {
    path: "",
    message: "この相手は、元になっている行を見る権限を持っていないため、ここには追加できません。",
    hint: "先に元の行の権限をこの相手に渡してから、もう一度試してください。",
  };
}

/** どの行への権限かが決まらない(HTTP の `unknownGrantTargetError` の写し)。 */
function unknownGrantTargetError(): ValidationError {
  return {
    path: "",
    message: "どの行に対する権限なのかが決まらないため、権限を渡せません。",
    hint: "権限を渡したい行を選んでから、もう一度試してください。",
  };
}

/**
 * **判定に要る表を全件読む**(`src/kernel/workflow-runner.ts` の `accessSourceRows` と同じ形)。
 *
 * **読めない表は「行が0件」に倒す** —— **判定そのものは掛かり続け、fail-closed になる**
 * (`src/server/app.ts` の `memoizedRowReaders` と同じ向き)。
 *
 * **【代償を隠さない】** —— **全件をメモリに読む**(`ADR-0042` §限界2)。
 * **メモ化していないので、`write_records` は op の数だけ読み直す。** **どこで遅くなるかは
 * 1件も測っていない。**
 */
function accessSourceRows(
  db: Database,
  manifest: Manifest,
  tableId: string,
): readonly Record<string, unknown>[] {
  const result = listRecords(db, manifest, tableId, {});
  return result.ok ? (result.value as unknown as Record<string, unknown>[]) : [];
}

/**
 * `createApp` が投げた例外を統一形式に変換する(契約2)。
 *
 * どの引数が悪かったのかは例外の型からは分からないので、**同じ述語をもう一度
 * 評価して `path` を決める**。カーネルの判断をここで再実装しているのではなく、
 * 「カーネルが下した NO を、どの引数のせいかに割り当て直している」だけである。
 * `message` は必ずカーネルの文面をそのまま使い、書き換えない
 * (ADR-0003 §7: エラー文面は入口層に置かない)。
 */
function createAppFailure(
  store: KernelMetaStore,
  appId: string | undefined,
  error: unknown,
): ValidationError[] {
  const message = error instanceof Error ? error.message : String(error);

  if (appId === undefined) {
    // app_id 未指定で失敗する経路は `generateAppId` だけで、その原因は名前である。
    return [
      {
        path: "/name",
        message,
        hint: "アプリ名は日本語で構いません。IDを自分で決めたい場合は app_id を指定してください。",
      },
    ];
  }

  if (!isValidResourceId(appId)) {
    return [
      {
        path: "/app_id",
        message,
        hint: 'app_id は英小文字で始まり [a-z0-9_-] だけを使う1〜64文字。例: "book-tracker"。app_id を省略すればアプリ名から自動採番されます。',
      },
    ];
  }

  // ここに来るのはID衝突。**衝突相手を名指しする**ことが要点で、
  // 「既に使われている」だけでは LLM は次に何を試せばよいか決められない。
  const taken = store.listApps().map((app) => app.app_id);
  return [
    {
      path: "/app_id",
      message,
      hint:
        `app_id "${appId}" は既存アプリと衝突しています。使用済みの app_id: ${taken.join(" / ")}。` +
        "別の app_id を指定するか、app_id を省略して自動採番に任せてください。" +
        // V0-P7-T04 / F-25。既存の逃げ道2つは**残したまま**足す(置換ではない)。
        // 実地(005/T1)で AI が取ったのはこのどちらでもない第3の道 ——
        // 「では既存アプリを使う」—— で、しかも人間に確認せずに切り替えた。
        // 文面が言及していない選択肢は禁止にも許可にもならないので、名指しする。
        APP_ID_CONFLICT_CONSENT,
    },
  ];
}

/** 更新系6ツールをサーバに登録する。 */
export function registerWriteTools(server: McpServer, options: CreateMcpServerOptions): void {
  const { dataRoot, previewBaseUrl, actor } = options;

  // ===========================================================================
  // **名乗りと主体の解決**(`V8-M31-T02` / `V8-M31-T03`。台帳 `T-G21a` / `T-G21b` / `T-G22`)
  // ===========================================================================
  //
  // **各ツールの冒頭に在った次の4行は、`requireActorAndApp` の中へそのまま入った**(逐語):
  //
  //       const missing = requireApp(dataRoot, app_id);
  //       if (missing !== null) {
  //         return toolError(missing);
  //       }
  //
  // 前後に足したのは **(1) 名乗りの有無**(無ければ `isError`。**起動は成功する**。
  // `D-V8-46` の逐語「指定を忘れると**何もできない状態で立ち上がります**」)と、
  // **(2) 主体の解決**(`findUserById` → `findUserByUsername`。**IDを優先**。`D-V8-83`)
  // の2つだけである。**解決は `requireApp` の後に置く** —— `AuthStore.openForApp` は
  // `CREATE TABLE` を走らせるので、先に置くとタイプミスした app_id でファイルが生える。
  //
  // **【この波で入ったのは、ここまでである】**
  //
  // - **役割の面の判定(`app` + `write`)は、まだ1本も入っていない**(`T04`)。
  // - **行ごとの判定は、まだ1本も入っていない**(`T05`)—— **したがって、解決できた主体は
  //   今日どおり他人の行を書き換えられる。** **この波を「AI 経由を塞いだ」と読まないこと。**
  // - **監査(誰の権限で動いたか)は `_auth_activity` に1行も残らない**(裁定 `M31-9`)。
  //
  // **`create_app` は名乗りが要るが解決しない** —— `D-V8-53` の逐語「AI は**空のアプリの
  // 器だけ**を作る」「**名乗らずにできることが1つも残りません**」。**まだアプリが無いので、
  // そのアプリの利用者に解決しようがない。**

  // ===========================================================================
  // **判定**(`V8-M31-T04` / `T05`。台帳 `T-G23a` / `T-G23b` / `T-G24`)
  // ===========================================================================
  //
  // **【判定の家を1つも増やしていない】** —— **可否を計算するのは `src/server/owner-scope.ts`
  // の関数だけであり、ここに規則を読む条件式を1行も書いていない**(`ADR-0305` 限定3 /
  // `ADR-0061` 限定4 の作法をそのまま引き継いだ)。
  //
  // **【なぜ `registerWriteTools` の内側に置くのか】** —— **`src/server/entry-point-inventory.test.ts`
  // の `bodyForRoute` が、この関数の宣言から次の行頭 `}` までを切り出して判定の綴りを数える。**
  // **別ファイルや前方のヘルパへ括り出すと、実装が正しくても「判定を受けていない」と
  // 測られる。** **置き場所は測り方の都合であり、判定そのものの都合ではない。**
  //
  // **【この波で入っていないもの。誇張しない】**
  //  - **`undo` / `delete_app` は `app` × `write` だけで他人の行を全部消せる。**
  //    **行を書く4本を絞っても、この2本から同じ結果に到達できる。**
  //  - **個人スコープ(`st_owner`)のスタンプと絞り込みは1バイトも入っていない**
  //    (`ADR-0016` 実装追記 (E) の既知の非対称)。
  //  - **作成できた行に「作成者への付与」を1件も書いていない**(HTTP の単件 `POST` は書く)。
  //    **したがって、点を宣言した表に MCP から作った行は、作った本人にも見えないことがある。**
  //  - **監査(誰の権限で動いたか)は `_auth_activity` に1行も残らない**(裁定 `M31-9`)。

  // --- 【`V10-M28-T01`】**`denyAppSettingWrite` はこの位置から**モジュールの外**へ出た ---
  //
  // **上の doc コメント(この関数群を `registerWriteTools` の内側に置く理由)は1バイトも
  // 消していない。** **ただし、この1本にはもう当てはまらない。**
  //
  // **ここに在ったもの(逐語。実装は1バイトも変えずに、`dataRoot` を引数で受ける形に
  // しただけである)**:
  //
  //     const denyAppSettingWrite = (appId: string, roles: Role[]): ValidationError[] | null => {
  //       let manifest: Manifest | undefined;
  //       try {
  //         manifest = readCurrentManifest(dataRoot, appId);
  //       } catch {
  //         manifest = undefined;
  //       }
  //       return judgeRoleAccess({ manifest, roles, target: { target: "app" }, verb: "write" }).allowed
  //         ? null
  //         : [appChangeRuleRequiredError()];
  //     };
  //
  // **出した理由**: **参照系(`src/mcp/tools/read.ts` の `dry_run_diff`)が同じ判定を通る
  // 必要が出た。** **閉包の中に在ると参照系から呼べず、向こうに条件式を書き写すことに
  // なる** —— **それは「判定の家の2軒目」であり、上の doc が禁じている形そのものである。**
  //
  // **【測り方への影響を先に測った。0件である】** —— **`src/server/entry-point-inventory.test.ts`
  // の `no: 14`(AI(MCP))は `registerWriteTools` の本文に判定の綴りが在るかを見るが、
  // 数える綴りは `AUTOMATION_JUDGE_SPELLINGS`(`resolveCombinedRecordAccess(` ほか)であり、
  // `judgeRoleAccess(` はその一覧に無い。** **本文に残る `denyRecordWrite` /
  // `denyRecordCreate` が今日も `resolveCombinedRecordAccess(` を呼ぶので、
  // この行は `judged: true` のままである**(実測)。
  //
  // **【呼び出しの意味は8箇所とも1つも変わっていない】** —— **渡す `dataRoot` は、
  // これまで閉包が捕まえていたものと同一の値である**(`registerWriteTools` の引数)。

  /**
   * **面(役割に束ねた権限)の**表**の関門**(**(D)群**。`T-G23b`)。
   *
   * **HTTP の `recordsAuthMiddleware`(`src/server/app.ts`)と同じ形である** ——
   * **点(行ごとの付与)が管轄内の表では、ここで止めない**(`D-V8-23` の `OR`)。
   * **止めると `OR` が `AND` に戻る**(点だけで通る行を、行を見る前に落としてしまう)。
   */
  const denyRoleTableWrite = (
    manifest: Manifest,
    tableId: string,
    roles: Role[],
    verb: "write" | "delete",
  ): ValidationError[] | null =>
    roleGateBlocksWithoutGrants({
      role: judgeRoleAccess({ manifest, roles, target: { target: "table", table: tableId }, verb }),
      grantGoverned: recordAccessSourceTables(manifest, tableId) !== undefined,
    })
      ? [forbiddenRoleAccessError(`表 "${tableId}"`, verb === "delete" ? "削除" : "書き込み")]
      : null;

  /**
   * **既存の行1件を書き換える/消せるか**(面と点を重ねた合成判定)。
   *
   * **関門の順序は HTTP の単件 `PATCH` / `DELETE` と同じ**:
   * **(1) 見えないなら「存在しません」→(2) 見えるが書けない/消せないなら権限の断り。**
   * **見えない行に「権限がありません」を返すと、その行が在ることが漏れる。**
   *
   * **行の読み方はカーネルの先例(`src/kernel/workflow-runner.ts` の `judgeAutomationWrite`)と
   * 同じで、生の `Database` から `readRows` / `readRow` を組む** —— **HTTP の
   * `memoizedRowReaders` は `ReadSource` を前提にした server 内部の非 export 関数であり、
   * MCP からは呼べない。** **メモ化していないぶんだけ、同じ表を段の数だけ読み直す。**
   */
  const denyRecordWrite = (
    db: Database,
    manifest: Manifest,
    tableId: string,
    row: Record<string, unknown>,
    actorId: string,
    roles: Role[],
    verb: "write" | "delete",
  ): ValidationError[] | null => {
    const sources = recordAccessSourceTables(manifest, tableId);
    if (sources === undefined) {
      // **宣言していない表 / `enabled: false` の表**(オプトイン)—— **今日どおり通す。**
      return null;
    }
    const resolved = resolveCombinedRecordAccess({
      manifest,
      tableId,
      row,
      actorId,
      roles,
      sources,
      readRows: (id) => accessSourceRows(db, manifest, id),
      readRow: (id, recordId) => {
        const found = getRecord(db, manifest, id, recordId);
        return found.ok && found.value !== null
          ? (found.value as unknown as Record<string, unknown>)
          : undefined;
      },
    });
    if (resolved.kind === "limit_exceeded") {
      // **上限に当たったことを「権限が無い」に丸めない**(`Z-G17` の作法)。
      return [recordAccessLimitError(resolved.limit)];
    }
    if (!resolved.verdict.read) {
      return [invisibleRecordError(tableId, String(row._id))];
    }
    if (verb === "delete" ? !resolved.verdict.delete : !resolved.verdict.write) {
      return [verb === "delete" ? forbiddenRecordDeleteError() : forbiddenRecordWriteError()];
    }
    return null;
  };

  /**
   * **その表に行を作れるか**(**作成の下見**)。
   *
   * **関門の順序は HTTP の単件 `POST` と同じ**: **(1) メンバー表に行が無ければ断る →
   * (2) 作った人に何も渡らない設定なら断る →(3) 面と点を `OR` で重ねる。**
   * **書く前に判定する** —— **書いた後で「作った本人に見えない」と分かっても、行はもう在る。**
   *
   * **【HTTP と揃っていない点。黙って揃えない】** —— **HTTP は (3) で、下見の行と下見の
   * 付与を点の判定に直に掛け、「作成者に渡すと宣言した権限が読む・書く・消すのどれも
   * 与えない」場合を断る。** **ここは `combineRoleAndCreatorGrant` を呼ぶので、その場合も
   * 通る**(裁定 `M31-8` が綴りを固定しており、点の判定そのものを名指しで呼べない ——
   * **その綴りが `src/mcp/**` に1文字も無いことを、別の番人が substring で見張っている**)。
   * **カーネルの自動処理の関門とは同じ向きである。**
   */
  const denyRecordCreate = (
    db: Database,
    manifest: Manifest,
    tableId: string,
    actorId: string,
    roles: Role[],
  ): ValidationError[] | null => {
    const sources = recordAccessSourceTables(manifest, tableId);
    if (sources === undefined) {
      return null;
    }
    const plan = creatorGrantPlan({
      manifest,
      tableId,
      actorId,
      memberRows:
        sources.memberTable === undefined
          ? []
          : accessSourceRows(db, manifest, sources.memberTable),
    });
    if (plan?.kind === "no_member") {
      return [notAMemberError()];
    }
    if (plan?.kind === "unusable") {
      return [creatorGrantUnreachableError()];
    }
    return combineRoleAndCreatorGrant({
      role: judgeRoleAccess({
        manifest,
        roles,
        target: { target: "table", table: tableId },
        verb: "write",
        subject: actorId,
      }),
      plan,
    }).allowed
      ? null
      : [creatorGrantUnreachableError()];
  };

  /**
   * **付与表への書込を絞る**(`Z-G5`。**`V8-M31` 第3波で入った**)。
   *
   * **判定は `owner-scope.ts` の `judgeGrantWrite` 1本が持つ** —— **ここにあるのは
   * 「行を読む」ことと「結果を MCP の断り文へ翻訳する」ことだけで、条件式は1行も無い。**
   * **HTTP の `grantWriteVerdict` + `grantWriteDenial`(`src/server/app.ts`)を、
   * 応答コードの部分だけ落として写したものである。**
   *
   * **`undefined`(= その表は付与表として名指しされていない)なら今日どおり通す。**
   *
   * @param values **`create` は送られた値、`update` は「既存行に送られた値を重ねたもの」、
   *   `delete` は既存行**を渡すこと(**相手と対象は、書き込んだあとの姿で判定する**)。
   *
   * **【代償を隠さない】** —— **付与表・利用者の表・グループの表を毎回**全行**読む**
   * (HTTP と同じ post-filter の作法)。**メモ化していないので、まとめ書きでは
   * op の数だけ読み直す。** **どこで遅くなるかは1件も測っていない。**
   */
  const denyGrantWrite = (
    db: Database,
    manifest: Manifest,
    tableId: string,
    op: GrantWriteOp,
    values: Record<string, unknown>,
    actorId: string,
    roles: Role[],
  ): ValidationError[] | null => {
    const verdict = judgeGrantWrite({
      manifest,
      tableId,
      op,
      values,
      actorId,
      role: roles,
      readRows: (id) => accessSourceRows(db, manifest, id),
      readRow: (id, recordId) => {
        const found = getRecord(db, manifest, id, recordId);
        return found.ok && found.value !== null
          ? (found.value as unknown as Record<string, unknown>)
          : undefined;
      },
    });
    if (verdict === undefined || verdict.kind === "allowed") {
      return null;
    }
    if (verdict.kind === "invisible_target") {
      // **見えない行への付与は「存在しません」で伏せる**(HTTP は 404)。
      return [invisibleRecordError(verdict.tableId, verdict.recordId)];
    }
    if (verdict.kind === "not_creator") {
      return [forbiddenGrantWriteError()];
    }
    if (verdict.kind === "self") {
      return [forbiddenSelfGrantError()];
    }
    if (verdict.kind === "membership_locked") {
      return [forbiddenMembershipWriteError(verdict.role)];
    }
    if (verdict.kind === "no_target") {
      return [unknownGrantTargetError()];
    }
    if (verdict.kind === "parent_denied") {
      return [forbiddenGrantParentAccessError()];
    }
    return [unknownGrantHolderError()];
  };

  /**
   * **項目単位の書込を絞る**(`J-G7` / `J-G28`。**`V8-M31` 第3波で入った**)。
   *
   * **判定は `owner-scope.ts` の `judgeRoleFieldWrite` 1本が持つ。**
   * **HTTP の単件 `POST` / `PATCH` / バッチとまったく同じ呼び方である。**
   *
   * **【並びを HTTP と揃えた】** —— **行を読む前・行の判定より前に当てる。**
   * **判定は送られた入力だけで決まるので、行の現在値を1行も読まない。**
   *
   * **【HTTP と同じ穴を引き継ぐ。黙って直さない】** —— **`delete_record` には掛けない**
   * (HTTP の `DELETE` も掛けていない。`src/server/access-control-delete.test.ts` の
   * `(E-1)` が「`DELETE` ハンドラの中にこの綴りが1件も無い」を固定している)。
   */
  const denyFieldWrite = (
    manifest: Manifest,
    tableId: string,
    values: unknown,
    roles: Role[],
  ): ValidationError[] | null => {
    const verdict = judgeRoleFieldWrite({
      manifest,
      table: manifest.app.tables.find((table) => table.id === tableId),
      values,
      roles,
    });
    return verdict.kind === "denied"
      ? [
          forbiddenRoleAccessError(
            `項目 ${verdict.fields.map((id: string) => `"${id}"`).join(" / ")}`,
            "書き込み",
          ),
        ]
      : null;
  };

  /**
   * **個人スコープ(`st_owner`)—— 作成時に、名乗った人を行に書く**
   * (**`V8-M31` 第6波・裁定 `M31-13`**)。
   *
   * **HTTP の単件 `POST /records` の2行をそのまま写した**(逐語):
   *
   *       const ownerField = personalOwnerField(resolved.table);
   *       if (ownerField !== undefined) {
   *         body.value[OWNER_FIELD] = (actor as AuthUser).id;
   *       }
   *
   * **送られてきた値は読まずに捨てる** —— **`ADR-0016` §却下(iv) の逐語「クライアント
   * 送信を信用する経路は最初から作らない」を、値を捨てることで実現している。**
   * **着手前の実測(`m31-after.md` §5-1 (c))では、MCP からは他人の id を書けた。**
   *
   * **`st_owner` を持たない表(= `personalOwnerField` が `undefined`)は素通りする。**
   */
  const stampOwner = (
    manifest: Manifest,
    tableId: string,
    values: Record<string, unknown>,
    actorId: string,
  ): void => {
    const table = manifest.app.tables.find((candidate) => candidate.id === tableId);
    if (table !== undefined && personalOwnerField(table) !== undefined) {
      values[OWNER_FIELD] = actorId;
    }
  };

  /**
   * **個人スコープ(`st_owner`)—— 既存の行1件を書き換える/消せるか**
   * (**`V8-M31` 第6波・裁定 `M31-13`**)。
   *
   * **HTTP の単件 `PATCH` / `DELETE` と**同じ述語**を**同じ順序**で当てる** ——
   * **(1) 見えない行(他人の個人行)は「存在しません」で伏せる**(HTTP は 404)
   * **→(2) `st_owner` の付け替え・共有行の私物化は断る**(HTTP は 403)。
   * **逆にすると、不可視の行が実在することが (2) の断りから漏れる。**
   *
   * **判定は `owner-scope.ts` の `isOwnerVisible` / `isAllowedOwnerUpdate` が持ち、
   * ここに条件式を1行も書いていない**(`ADR-0061` 限定4 の作法)。
   *
   * @param values **更新なら送られた変更、削除なら `undefined`。**
   *   **`undefined` のときは (2) を当てない** —— **HTTP の `DELETE` も当てていない
   *   (消す要求は `st_owner` を書き換えないため)。**
   *
   * **【`roleReadCrossesOwnerScope` を渡していない。HTTP の書込と同じである】** ——
   * **`D-V8-35` が開いたのは読取だけであり、書込・削除は今日も `AND` である**
   * (`src/server/app.ts` の `PATCH` / `DELETE` / バッチにもこの綴りは1つも無い)。
   */
  const denyOwnerScopedWrite = (
    manifest: Manifest,
    tableId: string,
    row: Record<string, unknown>,
    values: Record<string, unknown> | undefined,
    actorId: string,
  ): ValidationError[] | null => {
    const table = manifest.app.tables.find((candidate) => candidate.id === tableId);
    if (table === undefined || personalOwnerField(table) === undefined) {
      return null;
    }
    if (!isOwnerVisible(row[OWNER_FIELD], actorId)) {
      return [invisibleRecordError(tableId, String(row._id))];
    }
    if (
      values !== undefined &&
      Object.hasOwn(values, OWNER_FIELD) &&
      !isAllowedOwnerUpdate(values[OWNER_FIELD], row[OWNER_FIELD])
    ) {
      return [forbiddenOwnerError()];
    }
    return null;
  };

  // --- 7. create_app --------------------------------------------------------------

  server.registerTool(
    "create_app",
    {
      description: describeTool(
        "新しいアプリを作ります。作られるのは中身が空のアプリ(テーブルもビューも0件)なので、" +
          "続けて apply_diff でテーブルとビューを追加してください。" +
          "app_id を省略するとアプリ名から自動で採番されます。日本語のアプリ名でも構いません。",
      ),
      inputSchema: {
        name: z.string().describe("人間向けのアプリ名。日本語可。画面に表示される。"),
        app_id: z
          .string()
          .optional()
          .describe(
            '省略可。URLやディレクトリ名になるID。英小文字で始まる [a-z0-9_-] のみ、1〜64文字。例: "book-tracker"。',
          ),
      },
    },
    ({ name, app_id }) => {
      // **名乗りは要る。解決はしない**(`D-V8-53`。上のまとめを参照)。
      // **「名乗らずにできることが1つも残りません」を満たす最後の1本がここである** ——
      // ここを開けたままにすると、名乗らない AI が空のアプリを作り続けられる。
      const unnamed = requireActor(actor);
      if (unnamed !== null) {
        return toolError(unnamed);
      }

      // 空のアプリ名は `createApp` が弾いてくれる……のは app_id 未指定のときだけで、
      // app_id を明示すると `generateAppId` を通らないため素通りしてしまう。
      // 名前の無いアプリは一覧で識別できず人間に不利益しかないので、入口で揃えて弾く。
      if (name.trim() === "") {
        return toolError([
          {
            path: "/name",
            message: "アプリ名が空です。1文字以上の名前を指定してください。",
            hint: "ユーザが呼んでいる名前をそのまま使ってください(日本語可)。",
          },
        ]);
      }

      // R3: 呼び出しごとに open し、`finally` で close する。
      const store = KernelMetaStore.open(dataRoot);
      try {
        const created =
          app_id === undefined ? createApp(store, name) : createApp(store, name, { app_id });
        return toolOk({
          app: created.app,
          manifest: created.manifest,
          // 作った直後に人間へ見せられるURLを一緒に返す。会話の中で
          // 「作りました → ここで見られます」が1往復で終わる形にするため。
          preview_url: `${previewBaseUrl}${routePath({ kind: "app", appId: created.app.app_id })}`,
        });
      } catch (error) {
        return toolError(createAppFailure(store, app_id, error));
      } finally {
        store.close();
      }
    },
  );

  // --- 8. apply_diff --------------------------------------------------------------

  server.registerTool(
    "apply_diff",
    {
      description: describeTool(
        "差分パッチをアプリに適用します。テーブル・フィールド・ビュー・ワークフローを" +
          "追加・変更・削除する唯一の手段です。" +
          "適用前の状態は自動でスナップショットに保存されます。" +
          "operations に書けるのは add_table / add_field / add_view / update_view(足すだけ)と、" +
          "remove_view(画面の定義だけを消す)と、" +
          "remove_field / remove_table / change_table / change_field(既存の定義とデータを" +
          "実際に変更・削除する)と、" +
          "add_workflow / update_workflow / remove_workflow(自動化の定義を変える)と、" +
          // **V3-M5-T05(Δ5。門A審査の申し送り8 が「真偽未確認」として送ってきた1件)**:
          // **確認したら偽だった。** 列挙は12個で止まっていたが `DIFF_OPS` は今日 **16** である
          // —— **add_function / update_function / remove_function(V1-M6 / ADR-0024)と
          // set_theme(V3-M1 / ADR-0047)の4つが列挙から落ちていた。**
          // **どのテストもこの数を守っていなかった**(`grep "計12"` のヒットは本ファイル1件だけ)
          // ので、**赤にならずに古くなっていた。** `VOCABULARY_SCOPE` の側は `DIFF_OPS` から
          // 組み立てるので自動追随しており、**食い違っていたのはこの散文だけである。**
          "add_function / update_function / remove_function(関数=コードの島の定義を変える)と、" +
          "set_theme(アプリ単位のテーマを丸ごと差し替える)と、" +
          // **【`V5-M17b` / `ADR-0248`。Δ5】** **旧文の逐語は「set_theme(アプリ単位の
          // テーマを丸ごと差し替える)の計16だけです。」および「上の16に当てはめて
          // ください。」である。** **17種目 `set_user_kinds` が入ったので、数と列挙を
          // 追随させた。** **上の V3-M5-T05 の注記が言う「散文だけが赤にならずに
          // 古くなっていた」という事故を繰り返さないよう、`src/mcp/tools/write.test.ts` に
          // 「この散文が `DIFF_OPS` の全 op 名を含む」という検査を足してある。**
          "set_user_kinds(このアプリが扱う利用者の種類の宣言を丸ごと差し替える)と、" +
          // **【`V8-M16-T03`。Δ5】** **旧文の逐語は「set_user_kinds(このアプリが扱う
          // 利用者の種類の宣言を丸ごと差し替える)の計17だけです。」および「上の17に
          // 当てはめてください。」である。** **18種目 `set_roles` が入ったので、数と
          // 列挙を追随させた。**
          "set_roles(このアプリが宣言する役割の一覧を丸ごと差し替える)の" +
          "計18だけです。" +
          "delete_table / rename_field / change_field_type / remove_app のような操作名は" +
          "**存在しません**。書いても検証で弾かれるだけなので、上の18に当てはめてください。" +
          // **【`V8-M32-T02`(2026-08-12)。台帳 `T-G11` の波及。旧文を1バイトも消していない】**
          // **`V8-M29` が `set_user_kinds` を `DIFF_OPS` から取り除いた(18 → 17。`ADR-0325`)。**
          // **列挙も「計18」も「上の18」も追記で訂正する。数字は1文字も書き換えていない。**
          "**訂正します。上の set_user_kinds と「計18」「上の18」は今日は偽です** —— " +
          "**set_user_kinds は廃止され、operations に書けるのは set_roles までの計17だけです** " +
          "(利用者の種類の宣言という語彙そのものがありません)。" +
          "足すだけの4つでは既存のデータは失われません(追加された列は既存レコードでは空になります)。" +
          "remove_view でも失われません —— 消えるのは画面の定義だけで、" +
          "テーブル・フィールド・レコードには触れず、add_view で作り直せます。" +
          "**破壊的な4つでは失われます。**先に dry_run_diff で影響を実測し、" +
          "ユーザの同意を得てから呼んでください。" +
          "ワークフローの3つでは適用の時点で何も失われませんが、" +
          "**適用が終わったあとも動き続けます** —— " +
          "何がいつ動くようになるか/動かなくなるかを伝え、同意を得てから呼んでください。" +
          "エラーが返った場合、アプリは1バイトも変わっていないので" +
          "(変換できない値が1件でもあれば差分全体が拒否され、部分適用はされません)、" +
          "エラーの path と message を読んで差分を直し、そのまま再実行して構いません。\n" +
          // V1-M1-T06: 推奨フローと undo の限界。**焼き込んでも守られはしない**(F-41)。
          // 実際にこの順で使うかを見るのが本タスクの検証方法である
          // (証跡は `docs/evidence/cp-v1-1/transcripts/`)。
          DESTRUCTIVE_CHANGE_FLOW +
          "\n" +
          UNDO_ROLLBACK_LIMIT +
          "\n" +
          // V0-P7-T04 / F-23。op 名の一覧だけでは形が決まらない。update_view の
          // 二層構造は他3 op から類推できず、実地で5セッション独立に外している。
          APPLY_DIFF_OP_EXAMPLES +
          "\n" +
          // **【`V6-M12-T01` / `H-G12` 限定5 / `ADR-0287`】**
          // **`update_view` の受付キーの列挙を、このツールの固有説明に置いた。**
          // **`instructions` から `VOCABULARY_SCOPE` を外した以上、この列挙が
          // 接続直後に渡らなくなる。** 限定5 は「消さない・件数に丸めない・
          // `apply_diff` のツール固有 description に列挙のまま移す」を課しており、
          // **`update_view` を書く唯一のツールがここである以上、置き場はここが正しい。**
          // **列挙の実体は `UPDATE_VIEW_ACCEPTED_KEYS` ただ1つで、`VOCABULARY_SCOPE` の側も
          // 同じ定数を読む** —— **1本目の軸(`K-G3`)が24キー目を足す先はこの定数である。**
          `update_view の operation に書けるキーは ${UPDATE_VIEW_ACCEPTED_KEYS.join(" / ")} の` +
          `${UPDATE_VIEW_ACCEPTED_KEYS.length}キーだけです` +
          "(**この一覧が全量です。件数だけを覚えず、名前で確かめてください**)。" +
          "ここに無いキーを書いた差分は、適用されずに拒否されます。" +
          "\n" +
          // **【`V10-M21-T02`(`FU-G14` / `ADR-0359` §4a)】**
          // **`after_delete`(削除が成立したあとの行き先)の**意味**を、接続直後に届ける。**
          // **着手前、このキーは上の `UPDATE_VIEW_ACCEPTED_KEYS` の列挙の中に名前として
          // 2回現れるだけで、書ける画面も値域も既定も1文字も届いていなかった**
          // (`CP-V10-FOLLOWUP` 条件12)。
          // **置き場がここである理由は、上の限定5 の注記とまったく同じである** ——
          // **`after_delete` を書ける op(`add_view` / `update_view`)を通す唯一のツールが
          // `apply_diff` だからである。**
          // **他の23本には1バイトも足していない**(散文を全ツールへ複写しない ——
          // それは `V10-M21-T01` が畳んだばかりの形である)。
          // **`{ withFullVocabulary: true }` の引数は1文字も触っていない。**
          AFTER_DELETE_GUIDE,
        { withFullVocabulary: true },
      ),
      inputSchema: { app_id: appIdArg, diff: diffArg },
    },
    ({ app_id, diff }) => {
      const guard = requireActorAndApp(dataRoot, app_id, actor);
      if (!guard.ok) {
        return toolError(guard.errors);
      }

      // **アプリの設定に触れるか**(`V8-M31-T04`)。**HTTP の `POST /diffs` と同じ判定。**
      const forbidden = denyAppSettingWrite(dataRoot, app_id, guard.value.roles);
      if (forbidden !== null) {
        return toolError(forbidden);
      }

      // intent の必須・非空(V0-P5-T05)。カーネルの差分スキーマも同じ制約を持つが、
      // そちらの `path` は差分オブジェクトを根とする(欠落時は `""`、空文字時は
      // `/intent`)ため、**LLM が実際に送った引数の位置とずれる**。ここでは引数空間の
      // `/diff/intent` を指す。`requireApp` が `/app_id` を指すのと同じ考え方である。
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

      // R3: `applyDiff` は内部で `KernelMetaStore` を開閉するので、外側では開かない。
      const result = applyDiff(dataRoot, app_id, diff);
      if (!result.valid) {
        return toolError(result.errors);
      }
      return toolOk({
        manifest: result.manifest,
        plan: result.plan,
        snapshot: result.snapshot,
        entry: result.entry,
        // **`V8-M18` / 台帳 `J-G16` の限定の逐語「**書いた人に返る形で伝える**」。**
        // **誰も通さない条件・全員を通す条件を書いたとき、ここに知らせが載る。**
        // **拒否ではない** —— **差分は適用済みであり、`isError` にはしない。**
        // **矛盾が1つも見つからなければ空配列である**(**欄そのものは常に在る** ——
        // **「黙って何もしない」を作らない**)。**検出できる形と検出できない形の全量は
        // `src/kernel/apply-diff.ts` の `collectRoleConditionNotices` の doc コメントに
        // 名指しで書いてある。****「矛盾を全部見つける」わけではない。**
        role_condition_notices: result.role_condition_notices,
      });
    },
  );

  // --- 9. undo --------------------------------------------------------------------

  server.registerTool(
    "undo",
    {
      description: describeTool(
        "直前に適用した変更を取り消し、その適用前のスナップショットに戻します。" +
          "戻るのはマニフェストだけではなく**データベース全体**です。" +
          "そのため、取り消す変更を適用したあとに追加されたレコードは失われます。" +
          "実行前に必ず preview_undo で失われるものを確認し、ユーザの同意を取ってください。" +
          "取り消したこと自体も変更履歴に残ります(履歴は消えません)。" +
          // V1-M9-T05 / ADR-0032(Δ5): redo が入ったので「undo の undo はできない」は嘘。
          // ただし「redo があるので undo は安全」には緩めない —— redo は直前の undo が消した
          // 状態を戻すだけで、undo の巻き添えそのものは減らさない(ゲート §2-5)。
          "戻しすぎた場合は redo でこの undo をやり直せます(redo は直前の undo が消した状態を復元します)。" +
          "ただし redo も preview_redo で確認してから実行してください。\n" +
          // V1-M1-T06。破壊的 op を戻す唯一の手段がここなので、限界とフローを明示する。
          UNDO_ROLLBACK_LIMIT +
          "\n" +
          DESTRUCTIVE_CHANGE_FLOW,
      ),
      // R9: `confirm` のような引数は置かない。意味が未定義な引数はLLMに誤用され、
      // 「confirm: true を付ければ安全」という誤った学習を生む。同意を取るのは
      // preview_undo を人間に見せることであって、引数のフラグではない。
      inputSchema: { app_id: appIdArg },
    },
    ({ app_id }) => {
      const guard = requireActorAndApp(dataRoot, app_id, actor);
      if (!guard.ok) {
        return toolError(guard.errors);
      }

      // **アプリの設定に触れるか**(`V8-M31-T04`)。**HTTP の `POST /undo` と同じ判定。**
      // **これは行の判定ではない** —— **通った相手は、この `undo` で他人の行を巻き添えに
      // 消せる**(`preview` の `lost_records` がその件数を返す)。
      const forbidden = denyAppSettingWrite(dataRoot, app_id, guard.value.roles);
      if (forbidden !== null) {
        return toolError(forbidden);
      }

      // R2: preview は undo の**前に**取る。`previewUndo` は現在のDBと復元先の
      // スナップショットを突き合わせて差分を数えるので、undo したあとに呼ぶと
      // 両者が一致してしまい「何も失われなかった」ように見える。
      // 「何が失われたか」を人間に報告できる状態で返すのはこの順序だけである(憲法6)。
      const preview = previewUndo(dataRoot, app_id);
      if (!preview.valid) {
        return toolError(preview.errors);
      }

      const result = undo(dataRoot, app_id);
      if (!result.valid) {
        return toolError(result.errors);
      }

      // `previewUndo` と `undo` は、どちらも changelog から独立に対象を選び直す。
      // 通常は同じものを選ぶが、万一ずれていれば、返そうとしている preview は
      // **実際に起きたこととは別の変更の予告**になる。それを黙って返すのは
      // 「嘘の報告」なので、ここで検出して知らせる。
      //
      // なお、この分岐だけは `isError: true` でも undo は実行済みである
      // (契約1 の唯一の例外)。message でその旨を明示している。
      if (preview.preview.target_seq !== result.entry.undo_target_seq) {
        return toolError([
          {
            path: "",
            message:
              `undo は実行されました(seq=${String(result.entry.undo_target_seq)} を取り消し)が、` +
              `直前に取得した preview は seq=${preview.preview.target_seq} を対象にしていました。` +
              "他のプロセスが同時にこのアプリを変更した可能性があります。",
            hint: "get_manifest と get_changelog で現在の状態を確認してからユーザに報告してください。",
          },
        ]);
      }

      return toolOk({
        preview: preview.preview,
        manifest: result.manifest,
        entry: result.entry,
        snapshot: result.snapshot,
        restored_from: result.restored_from,
      });
    },
  );

  // --- 9b. redo(V1-M9-T05 / ADR-0032)---------------------------------------------
  //
  // ADR-0004 §1「redo は v0 では作らない」の改訂。戻り先は直前の undo が実行直前に取った
  // スナップショット(データは物理的に残っている。ADR-0004 §5)。**「redo があるので undo は
  // 安全」とは説明文に書かない**(ゲート §2-5)—— redo は undo の巻き添えを減らさない。

  server.registerTool(
    "redo",
    {
      description: describeTool(
        "直前に実行した undo をやり直します(redo)。undo で取り消した変更を復元し、" +
          "その undo を実行した直前の状態に戻します。" +
          "戻るのはマニフェストだけではなく**データベース全体**なので、" +
          "その undo のあとに追加したレコードは redo で失われることがあります。" +
          "実行前に必ず preview_redo で「戻るもの(restored_records)」と「失われるもの(lost_records)」を" +
          "確認し、ユーザの同意を取ってください。やり直したこと自体も変更履歴に残ります。" +
          "対象は「直前の(まだ redo していない)undo」1つだけで、redo 自体を undo / redo することはできません。" +
          "連続して undo した場合は、redo を繰り返すと新しい undo から順にやり直します。" +
          "同じ undo を二度やり直すことはできません(やり直せる undo が無いときは redo できません)。" +
          "**redo は undo の巻き添えを無くすものではありません** —— " +
          "戻せるのは直前の undo が消した状態だけなので、「redo があるから undo は安全」と説明してはいけません。\n" +
          UNDO_ROLLBACK_LIMIT +
          "\n" +
          DESTRUCTIVE_CHANGE_FLOW,
      ),
      // R9: undo と同じく `confirm` のような引数は置かない。同意は preview_redo を人間に
      // 見せることで取るのであって、引数のフラグではない。
      inputSchema: { app_id: appIdArg },
    },
    ({ app_id }) => {
      const guard = requireActorAndApp(dataRoot, app_id, actor);
      if (!guard.ok) {
        return toolError(guard.errors);
      }

      // **アプリの設定に触れるか**(`V8-M31-T04`)。**HTTP には redo の口が無い** ——
      // **前例は無いが、`redo` が戻すのは `undo` が取り消した定義そのものである**
      // (`undo` と同じ器を逆向きに動かす)。**同じ関門を当てないと、`undo` を断られた
      // 相手が `redo` で定義を動かせる。**
      const forbidden = denyAppSettingWrite(dataRoot, app_id, guard.value.roles);
      if (forbidden !== null) {
        return toolError(forbidden);
      }

      // R2: preview は redo の**前に**取る(undo と同じ理由。現在DBと復元先を突き合わせて
      // 数えるので、redo したあとに呼ぶと両者が一致して「何も変わらなかった」ように見える)。
      const preview = previewRedo(dataRoot, app_id);
      if (!preview.valid) {
        return toolError(preview.errors);
      }

      const result = redo(dataRoot, app_id);
      if (!result.valid) {
        return toolError(result.errors);
      }

      // preview と redo は changelog から独立に対象を選び直す。ずれていれば、返そうとしている
      // preview は実際に起きたこととは別の予告になる(undo と同じ検出。契約1 の唯一の例外)。
      if (preview.preview.target_seq !== result.entry.undo_target_seq) {
        return toolError([
          {
            path: "",
            message:
              `redo は実行されました(undo seq=${String(result.entry.undo_target_seq)} をやり直し)が、` +
              `直前に取得した preview は seq=${preview.preview.target_seq} を対象にしていました。` +
              "他のプロセスが同時にこのアプリを変更した可能性があります。",
            hint: "get_manifest と get_changelog で現在の状態を確認してからユーザに報告してください。",
          },
        ]);
      }

      return toolOk({
        preview: preview.preview,
        manifest: result.manifest,
        entry: result.entry,
        snapshot: result.snapshot,
        restored_from: result.restored_from,
      });
    },
  );

  // --- 10. insert_sample_data -----------------------------------------------------

  server.registerTool(
    "insert_sample_data",
    {
      description: describeTool(
        "テーブルにレコードをまとめて投入します(動作確認用のサンプルデータ投入を想定)。" +
          "各行は独立に検証されるため、一部の行だけが失敗することがあります。" +
          "その場合でもエラーにはならず、inserted に成功した行、failed に " +
          "{ index, errors } が入ります。**失敗しても成功した行は残る。" +
          "再試行は failed の index の行だけを送ること**。" +
          "rows 全体を送り直すと、成功していた行が二重に入ります。" +
          "inserted には作られたレコードが _id 付きで入るので、" +
          "reference 型のフィールドを埋めるときはその _id を使ってください。" +
          "読み取り専用のシステムテーブル(_apps / _changelog)には投入できません。" +
          // V0-P7-T04 / F-24。限界の併記込みで1つの定数にしてある(憲法6)。
          SAMPLE_DATA_NO_ESCAPE,
      ),
      inputSchema: {
        app_id: appIdArg,
        table_id: z.string().describe("投入先テーブルのID。get_manifest で取得できる。"),
        // 浅く受けてカーネルに検証させる(ファイル冒頭「入力スキーマを浅くしてある理由」)。
        rows: z
          .array(z.record(z.string(), z.unknown()))
          .describe(
            "投入するレコードの配列。各行は フィールドID → 値 のオブジェクト。" +
              "_id / _created_at / _updated_at は自動で付くので含めないこと。",
          ),
      },
    },
    ({ app_id, table_id, rows }) => {
      const guard = requireActorAndApp(dataRoot, app_id, actor);
      if (!guard.ok) {
        return toolError(guard.errors);
      }

      // R6: `createRecord` はマニフェストを要求する(型・必須・参照の検証に使う)。
      const manifest: Manifest = readCurrentManifest(dataRoot, app_id);

      // システムテーブルは「存在しない」のではなく「書けない」(ADR-0006 §7)。
      // ここで unknownTableError を返すと、`_apps` は実在するのに「存在しません」と
      // 嘘をつき、しかも hint が add_table へ誘導する ―― L3 で必ず弾かれる操作である。
      if (isSystemTableId(table_id)) {
        return toolError([readOnlyTableError(manifest, table_id)]);
      }

      // テーブル自体が無いのは「行ごとの失敗」ではなく引数の間違いである。
      // 全行を failed で埋めて返すと、LLM は行の中身を疑って直そうとしてしまう。
      // 1行も入っていない = 契約1 の `isError: true` が正しく当てはまる。
      if (!manifest.app.tables.some((table) => table.id === table_id)) {
        return toolError([unknownTableError(manifest, table_id)]);
      }

      // 適用中(apply 窓)なら1行も投入しない(ADR-0017 / M3: create こそ silent-loss の主対象)。
      // HTTP の POST /records と同一意味論。契約1(isError=何も変わっていない)を満たす。
      const applying = isApplyInProgress(dataRoot, app_id);
      if (applying.inProgress) {
        return toolError([applyInProgressError(applying)]);
      }

      // **面(役割に束ねた権限)の表の関門**(`V8-M31-T05`。HTTP の `POST /records` と同じ)。
      const forbidden = denyRoleTableWrite(manifest, table_id, guard.value.roles, "write");
      if (forbidden !== null) {
        return toolError(forbidden);
      }

      // **項目単位の書込の判定**(`V8-M31` 第3波)。**HTTP の単件 `POST` は DB を開く前に
      // これを当てる** —— **同じ位置に置く。**
      //
      // **【HTTP と揃えられない差。黙って揃えない】** —— **HTTP の `POST /records` は
      // 1要求 = 1行だが、この道具は N 行を1要求で受ける。** **1行でも書けない項目を
      // 含んでいたら、要求全体を断る**(裁定 `M31-5` と同じ向き)—— **`failed` に
      // 混ぜない。** **理由: 権限で落ちた行を「行ごとの検証の失敗」として返すと、
      // AI は値を直せば通ると学習する(直しても通らない)。**
      for (const row of rows) {
        const deniedFields = denyFieldWrite(manifest, table_id, row, guard.value.roles);
        if (deniedFields !== null) {
          return toolError(deniedFields);
        }
      }

      // **個人スコープ(`st_owner`)のスタンプ**(`V8-M31` 第6波・裁定 `M31-13`)。
      // **HTTP の単件 `POST /records` と同じ位置である** —— **項目単位の判定の**あと**、
      // 付与表の判定と作成の下見の**前**。** **順序が要るのは、下の `denyGrantWrite` /
      // `denyRecordCreate` が「書き込んだあとの姿」を見るからである。**
      // **行ごとに当てる**(この道具は N 行を1要求で受ける。HTTP は1要求 = 1行)。
      for (const row of rows) {
        stampOwner(manifest, table_id, row, guard.value.id);
      }

      // R6: DBは全行で**1回だけ**開き、`finally` で閉じる。行ごとに開閉すると
      // 行数ぶんのファイルハンドルとWALの生成・破棄が起き、投入も遅くなる。
      return withAppDb(dataRoot, app_id, (db) => {
        // **付与表への書込の判定**(`V8-M31` 第3波)。**HTTP の単件 `POST` は
        // 作成の下見(`creatorGrantPlan`)より**前**にこれを当てる** —— **同じ並びにする。**
        // **行ごとに値が違うので、行の数だけ問う。** **1件でも拒否があれば1行も書かない。**
        for (const row of rows) {
          const deniedGrant = denyGrantWrite(
            db,
            manifest,
            table_id,
            "create",
            row,
            guard.value.id,
            guard.value.roles,
          );
          if (deniedGrant !== null) {
            return toolError(deniedGrant);
          }
        }
        // **作成の下見**(`V8-M31-T05`)。**行の内容に依らないので、行ループの外で1度だけ
        // 問う** —— **判定は (表, 作る人) に閉じており、`rows` の中身を1バイトも見ない。**
        // **1件でも作る前に断る**(契約1: `isError` は「何も変わっていない」)。
        const denied = denyRecordCreate(db, manifest, table_id, guard.value.id, guard.value.roles);
        if (denied !== null) {
          return toolError(denied);
        }
        const inserted: RecordRow[] = [];
        const failed: { index: number; errors: ValidationError[] }[] = [];

        // V1-M9-T12: on_create の履歴書き込み失敗を、この行ループ全体を1つの同期区間として
        // 収集する(行ごとに開閉せず、全行ぶんの失敗をまとめる)。
        const { failures } = collectWorkflowHistoryFailures(() => {
          for (const [index, row] of rows.entries()) {
            const created = createRecord(db, manifest, table_id, row);
            if (created.ok) {
              inserted.push(created.value);
            } else {
              failed.push({ index, errors: created.errors });
            }
          }
        });

        // R7: 部分成功でも `isError` は立てない。理由はファイル冒頭の契約3を参照。
        // V1-M9-T12: 履歴書き込み失敗は「操作は成功したが記録の一部が残らなかった」なので
        // `toolError` にせず、成功戻り値の明示項目に載せる(失敗が無ければ項目そのものを付けない)。
        return toolOk(
          failures.length > 0
            ? { inserted, failed, workflow_history_failures: failures }
            : { inserted, failed },
        );
      });
    },
  );

  // --- 11. update_record / 12. delete_record(V1-M0-T01 / F-13 / F-37)-------------
  //
  // **入口を開ける作業であって、能力を作る作業ではない。** `updateRecord` /
  // `deleteRecord` は v0 からカーネルにあり、HTTP 側(`src/server/app.ts` の
  // PATCH / DELETE)は既に同じ関数を開けている。ここで足すのは MCP の入口だけである。
  //
  // ## 判定順序をここで作り直さない(ADR-0006 §7)
  //
  // カーネルは **読み取り専用の拒否をレコードの存在確認より前**に置いている
  // (`src/kernel/records.ts` の `updateRecord` / `deleteRecord` 冒頭)。
  // したがって MCP 層では `isSystemTableId` の事前判定を**置かない**。置くと
  // 判定が2箇所になり、順序を将来どちらか一方だけ直せてしまう。
  //
  // `insert_sample_data` が事前判定を持っているのは、`createRecord` が
  // システムテーブルを弾く前に別のエラー(unknownTable)を返しうるからではなく、
  // **行ごとの失敗**という別の失敗モードと混ざるのを避けるためである。
  // ここには行ループが無いので、その理由は当てはまらない。
  //
  // ## この2つは changelog にもスナップショットにも載らない
  //
  // `applyDiff` と違い、スナップショットを取らず changelog も書かない。
  // **カーネルがそう作られている**(ADR-0006 §7 / 憲法5: changelog は
  // スキーマ変更の記録である)。T01 はその非対称を**説明文で告知する**だけで、
  // カーネルの側を変えない(門外を保つ)。

  /** record_id 引数の共通定義。 */
  const recordIdArg = z
    .string()
    .describe("対象レコードの _id。list_records で実在する値を確認できる。");

  /** table_id 引数の共通定義(`insert_sample_data` と同じ説明にそろえる)。 */
  const recordTableIdArg = z.string().describe("対象テーブルのID。get_manifest で取得できる。");

  server.registerTool(
    "update_record",
    {
      description: describeTool(
        "既存のレコード1件を部分更新します。**投入したデータの誤りを直す唯一の手段**です。" +
          "changes に入れたフィールドだけが更新され、入れなかったフィールドは元の値のまま残ります" +
          "(消えません)。1つの項目を直すために、他の項目を書き直す必要はありません。" +
          "_id / _created_at は変更できず、_updated_at は自動で進みます。" +
          "対象は record_id(レコードの _id)で1件だけ指定します。" +
          "条件に当てはまる複数件をまとめて直す方法はないので、" +
          "先に list_records で _id を引き、1件ずつ呼んでください。" +
          "エラーが返った場合、レコードは1バイトも変わっていないので、" +
          "エラーの path と message を読んで changes を直し、そのまま再実行して構いません。\n" +
          // V1-M9-T02 / ADR-0017: 楽観ロック(CAS)。**if_match は必須**である。
          "更新には if_match(あなたが読んだレコードの現在の版 = _updated_at)を必ず渡してください。" +
          "他の誰かがあなたの取得後にこのレコードを変更していると、版が一致せず更新は拒否されます" +
          "(黙って上書きしないための保護)。その場合は list_records で最新を読み直し、" +
          "新しい _updated_at を if_match にして再実行してください。成功すると返り値の record に" +
          "更新後の新しい _updated_at が入るので、続けて更新するならそれを次の if_match に使えます。\n" +
          RECORD_WRITE_SYSTEM_TABLE_READONLY +
          "\n" +
          RECORD_WRITE_NOT_IN_CHANGELOG +
          "\n" +
          RECORD_WRITE_SELF_REPORT,
      ),
      // 完了条件4: `confirm` のようなフラグ引数は置かない(F-38 / §7-4)。
      inputSchema: {
        app_id: appIdArg,
        table_id: recordTableIdArg,
        record_id: recordIdArg,
        // if_match は**必須**だが、zod では `.optional()` にして handler で検査する
        // (`intent` と同じ理由: zod で必須にすると SDK が handler 前に英語エラーで弾き、
        // 統一形式が壊れる。V0-P5-T05)。description には必須と書き続ける。
        if_match: z
          .string()
          .optional()
          .describe(
            "**必須**。更新前に読んだレコードの現在の版(_updated_at)。" +
              "list_records / update_record の返り値で得られる。他の操作が先に変更していれば" +
              "版が合わず更新は拒否される(黙って上書きしないための保護)。",
          ),
        // 浅く受けてカーネルに検証させる(ファイル冒頭「入力スキーマを浅くしてある理由」)。
        changes: z
          .record(z.string(), z.unknown())
          .describe(
            "更新する フィールドID → 値 のオブジェクト。**含めたフィールドだけが変わる**。" +
              "_id / _created_at / _updated_at は指定できない(カーネルが管理する)。",
          ),
      },
    },
    ({ app_id, table_id, record_id, changes, if_match }) => {
      const guard = requireActorAndApp(dataRoot, app_id, actor);
      if (!guard.ok) {
        return toolError(guard.errors);
      }

      // if_match は必須(ADR-0017)。省略を許すと LWW に落ち、後発の変更を黙って上書きする。
      if (if_match === undefined || if_match === "") {
        return toolError([missingIfMatchError()]);
      }

      // R6: `updateRecord` はマニフェストを要求する(型・必須・参照の検証に使う)。
      const manifest: Manifest = readCurrentManifest(dataRoot, app_id);

      // 適用中(apply 窓)なら書込まない(ADR-0017 / M3。HTTP と同一意味論)。
      const applying = isApplyInProgress(dataRoot, app_id);
      if (applying.inProgress) {
        return toolError([applyInProgressError(applying)]);
      }

      // **表の実在検査を、権限の判定より前に置く**(`V8-M31` 第4波・裁定 `M31-12`)。
      // **旧(第2波・第3波): 実在検査は無く、`denyRoleTableWrite` が最初の関門だった** ——
      // **その結果、表IDのタイプミス(`table_id: "nope"`)に「権限が足りません」が返り、
      // `allowed_values` が付かず、AI が自分で直せなかった。**
      // **並べ替えた理由は2つ:**
      // **(1) `get_manifest` は設計図を丸ごと返すと決まっている(`D-V8-55` / `D-V8-85`)。
      //     同じ呼び出し元が表の一覧をいつでも読めるので、表の実在を隠しても何も守れない。**
      // **(2) エラーからの自己訂正は製品の性質として検査で固定されている(`ADR-0005`)。
      //     期待値を反転させるより、同じファイルの `insert_sample_data` と並びを揃えるほうが
      //     失うものが小さい。**
      // **【正直に書く】これは HTTP との差を1件増やす** —— **HTTP の `PATCH` は
      // `recordsAuthMiddleware` が先に立つので、実在しない表にも権限の断りを返す。**
      // **システムテーブルはここで捕まえない**(実在するのに「存在しません」と嘘になる)——
      // **読み取り専用の断りは今日どおりカーネルが返す。**
      if (!isSystemTableId(table_id) && !manifest.app.tables.some((t) => t.id === table_id)) {
        return toolError([unknownTableError(manifest, table_id)]);
      }

      // **面(役割に束ねた権限)の表の関門**(`V8-M31-T05`。HTTP の `PATCH` と同じ)。
      const forbidden = denyRoleTableWrite(manifest, table_id, guard.value.roles, "write");
      if (forbidden !== null) {
        return toolError(forbidden);
      }

      // **項目単位の書込の判定**(`V8-M31` 第3波)。**HTTP の `PATCH` と同じ位置** ——
      // **行を読む前に当てる**(判定は入力だけで決まるので TOCTOU の窓を1つも増やさない)。
      const deniedFields = denyFieldWrite(manifest, table_id, changes, guard.value.roles);
      if (deniedFields !== null) {
        return toolError(deniedFields);
      }

      return withAppDb(dataRoot, app_id, (db) => {
        // **行1件の合成判定**(`V8-M31-T05`)。**行が無ければ判定しない** ——
        // **「その _id は無い」を返すのはカーネルの仕事であり、ここで先回りすると文面が
        // 二重管理になる。**
        {
          const existing = getRecord(db, manifest, table_id, record_id);
          if (existing.ok && existing.value !== null) {
            // **個人スコープ(`st_owner`)**(`V8-M31` 第6波・裁定 `M31-13`)。
            // **HTTP の `PATCH` は、行ごとのアクセス権(点)の判定より**前**にこれを当てる** ——
            // **同じ並びにする。** **どちらも「存在を伏せる」層だが、`st_owner` のほうが
            // 先に立つのが HTTP の実物である**(`src/server/app.ts` の `PATCH`)。
            const deniedOwner = denyOwnerScopedWrite(
              manifest,
              table_id,
              existing.value as unknown as Record<string, unknown>,
              changes as Record<string, unknown>,
              guard.value.id,
            );
            if (deniedOwner !== null) {
              return toolError(deniedOwner);
            }
            const denied = denyRecordWrite(
              db,
              manifest,
              table_id,
              existing.value as unknown as Record<string, unknown>,
              guard.value.id,
              guard.value.roles,
              "write",
            );
            if (denied !== null) {
              return toolError(denied);
            }
            // **付与表への書込の判定**(`V8-M31` 第3波)。**HTTP の `PATCH` と同じく
            // 行の判定の**あと**に置き、「書き込んだあとの姿」を渡す** ——
            // **既存行に送られた値を重ねないと、相手だけを自分に付け替える更新が
            // 「相手が書かれていない」として素通りする。**
            const deniedGrant = denyGrantWrite(
              db,
              manifest,
              table_id,
              "update",
              {
                ...(existing.value as unknown as Record<string, unknown>),
                ...(changes as Record<string, unknown>),
              },
              guard.value.id,
              guard.value.roles,
            );
            if (deniedGrant !== null) {
              return toolError(deniedGrant);
            }
          }
        }
        // 読み取り専用拒否・テーブル不在・レコード不在・値の検証は**すべてカーネル側**。
        // ここで先回りすると、順位も文面も二重管理になる。版不一致(conflict)も
        // カーネルの `versionConflictError` をそのまま返す = HTTP 409 と同一 message/hint。
        // V1-M9-T12: on_update の履歴書き込み失敗を、この同期書き込みが生んだぶんだけ収集する。
        const { value: result, failures } = collectWorkflowHistoryFailures(() =>
          updateRecord(db, manifest, table_id, record_id, changes, if_match),
        );
        if (!result.ok) {
          return toolError(result.errors);
        }
        // 履歴失敗は成功戻り値の明示項目に載せる(失敗が無ければ項目を付けない)。理由は
        // `insert_sample_data` と同じ(操作は成功しているので `toolError` にしない)。
        return toolOk(
          failures.length > 0
            ? { record: result.value, workflow_history_failures: failures }
            : { record: result.value },
        );
      });
    },
  );

  server.registerTool(
    "delete_record",
    {
      description: describeTool(
        "レコード1件を完全に削除します。**取り消せません。**" +
          "undo はスキーマ変更を戻すためのもので、この削除には効きません" +
          "(undo するとデータベース全体が巻き戻るため、削除した行が戻る代わりに" +
          "そのスナップショット以降に入れた行がすべて消えます。訂正の手段としては使えません)。" +
          "対象は record_id(レコードの _id)で1件だけ指定します。" +
          "条件でまとめて消す方法はないので、先に list_records で _id を引き、1件ずつ呼んでください。" +
          "誤って投入した行を消すよりも、update_record で正しい値に直せないかを先に検討してください" +
          "(直せるなら、消さないほうが失うものが少ない)。\n" +
          // V1-M9-T02 / ADR-0017: 楽観ロック(CAS)。**if_match は必須**である。
          "削除には if_match(あなたが読んだレコードの現在の版 = _updated_at)を必ず渡してください。" +
          "他の誰かがあなたの取得後にこのレコードを変更していると、版が一致せず削除は拒否されます" +
          "(黙って消さないための保護)。その場合は list_records で最新を読み直してから再検討してください。\n" +
          DELETE_RECORD_SHOW_TARGET_FIRST +
          "\n" +
          RECORD_WRITE_SYSTEM_TABLE_READONLY +
          "\n" +
          RECORD_WRITE_NOT_IN_CHANGELOG +
          "\n" +
          RECORD_WRITE_SELF_REPORT,
      ),
      // 完了条件4: `confirm` を置かない。同意は list_records の提示で取る(F-38)。
      inputSchema: {
        app_id: appIdArg,
        table_id: recordTableIdArg,
        record_id: recordIdArg,
        // if_match は**必須**(update_record と同じ理由で zod は optional・handler で検査)。
        if_match: z
          .string()
          .optional()
          .describe(
            "**必須**。削除前に読んだレコードの現在の版(_updated_at)。" +
              "他の操作が先に変更していれば版が合わず削除は拒否される(黙って消さないための保護)。",
          ),
      },
    },
    ({ app_id, table_id, record_id, if_match }) => {
      const guard = requireActorAndApp(dataRoot, app_id, actor);
      if (!guard.ok) {
        return toolError(guard.errors);
      }

      // if_match は必須(ADR-0017)。省略を許すと版を確かめずに削除してしまう。
      if (if_match === undefined || if_match === "") {
        return toolError([missingIfMatchError()]);
      }

      const manifest: Manifest = readCurrentManifest(dataRoot, app_id);

      // 適用中(apply 窓)なら書込まない(ADR-0017 / M3。HTTP と同一意味論)。
      const applying = isApplyInProgress(dataRoot, app_id);
      if (applying.inProgress) {
        return toolError([applyInProgressError(applying)]);
      }

      // **表の実在検査を、権限の判定より前に置く**(`V8-M31` 第4波・裁定 `M31-12`)。
      // **旧(第2波・第3波): 実在検査は無く、`denyRoleTableWrite` が最初の関門だった** ——
      // **理由は `update_record` に書いたものと同一である**(`get_manifest` が表の一覧を
      // 丸ごと返す以上、表の実在は隠しても守れない / 自己訂正は検査で固定された性質)。
      // **【正直に書く】これは HTTP との差を1件増やす** —— **HTTP の `DELETE` は
      // `recordsAuthMiddleware` が先に立つので、実在しない表にも権限の断りを返す。**
      if (!isSystemTableId(table_id) && !manifest.app.tables.some((t) => t.id === table_id)) {
        return toolError([unknownTableError(manifest, table_id)]);
      }

      // **面(役割に束ねた権限)の表の関門**(`V8-M31-T05`。HTTP の `DELETE` と同じ)。
      const forbidden = denyRoleTableWrite(manifest, table_id, guard.value.roles, "delete");
      if (forbidden !== null) {
        return toolError(forbidden);
      }

      return withAppDb(dataRoot, app_id, (db) => {
        // **行1件の合成判定**(`V8-M31-T05`)。**関門の順序は HTTP の `DELETE` と同じで、
        // 「見えないなら存在しない → 見えるが消せないなら権限の断り」である。**
        {
          const existing = getRecord(db, manifest, table_id, record_id);
          if (existing.ok && existing.value !== null) {
            // **個人スコープ(`st_owner`)**(`V8-M31` 第6波・裁定 `M31-13`)。
            // **HTTP の `DELETE` は `deleteRecord` の前・点の判定の前にこれを当てる** ——
            // **同じ並びにする。** **`values` を渡さない** —— **消す要求は `st_owner` を
            // 書き換えないので、付け替えの判定は当たらない(HTTP も当てていない)。**
            const deniedOwner = denyOwnerScopedWrite(
              manifest,
              table_id,
              existing.value as unknown as Record<string, unknown>,
              undefined,
              guard.value.id,
            );
            if (deniedOwner !== null) {
              return toolError(deniedOwner);
            }
            const denied = denyRecordWrite(
              db,
              manifest,
              table_id,
              existing.value as unknown as Record<string, unknown>,
              guard.value.id,
              guard.value.roles,
              "delete",
            );
            if (denied !== null) {
              return toolError(denied);
            }
            // **付与表からの削除の判定**(`V8-M31` 第3波。HTTP の `DELETE` と同じ位置)。
            // **渡すのは既存行である**(`delete` は「相手が誰か」を見ない ——
            // **自分の権限を手放すことは止めない**。`judgeGrantWrite` の doc)。
            //
            // **【項目単位の書込の判定はここに無い。HTTP と同じである】** ——
            // **`src/server/access-control-delete.test.ts` の `(E-1)` が、HTTP の `DELETE`
            // ハンドラにその綴りが1件も無いことを固定している。** **揃えた。**
            const deniedGrant = denyGrantWrite(
              db,
              manifest,
              table_id,
              "delete",
              existing.value as unknown as Record<string, unknown>,
              guard.value.id,
              guard.value.roles,
            );
            if (deniedGrant !== null) {
              return toolError(deniedGrant);
            }
          }
        }
        // 版不一致(conflict)はカーネルの `versionConflictError` をそのまま返す = HTTP 409 と同一。
        const result = deleteRecord(db, manifest, table_id, record_id, if_match);
        if (!result.ok) {
          return toolError(result.errors);
        }
        if (!result.value) {
          // `deleteRecord` は「対象が無かった」を **エラーではなく `false`** で返す
          // (カーネルの契約)。LLM に向けては、消せなかったことを黙って成功と
          // 報告させるわけにいかないので、入口でエラーに変える。
          //
          // **文面はカーネルの `updateRecord` が同じ事象に対して返すものと合わせる。**
          // 新しい言い回しを発明すると、同じ「その _id は無い」が update と delete で
          // 別の文章になり、LLM は2つの別々の失敗だと学習する。hint だけを
          // MCP の道具名(list_records)に差し替える —— HTTP 側(`src/server/app.ts`
          // の `unknownRecordError`)が hint だけを HTTP の言葉に差し替えているのと
          // まったく同じ扱いである。
          return toolError([
            {
              path: "",
              message: `テーブル "${table_id}" にレコード "${record_id}" は存在しません。`,
              hint: "list_records で実在する _id を確認してください(既に削除済みの可能性もあります)。",
            },
          ]);
        }
        return toolOk({ deleted: true, table_id, record_id });
      });
    },
  );

  // --- 12c. write_records(V2-M4-T01 / ADR-0039。EC-G7 バッチ原子書込)-----------------
  //
  // **明示的に列挙された有限個**のレコード操作(create / update)を、**1つの IMMEDIATE
  // トランザクション**で全成功か全失敗で書く。親の行1件 + 子の行 N件 + 参照先の行の残数更新
  // M件のような「1つの手続きの原子書込」を、部分適用ゼロで書ける唯一の入口である。
  //
  // **カーネルの1関門 `writeRecords` を通る**(HTTP `POST /apps/:app_id/batch` と同じ関門。
  // ADR-0003 §7。経路で振る舞いが割れない)。ops の構造検証も値検証もすべてカーネル側。
  // 契約1(isError=何も変わっていない)を満たす —— 失敗時はディスクが1バイトも動かない。
  //
  // **反復/ループ/where 句/一括更新は無い。** N の生成は呼び出し側の ops 列挙で行う。
  // 「今の値 − 変化分」の**演算は呼び出し側**が行い(カーネルは式言語を持たない)、
  // update op には計算済みの新しい値 + if_match(取りこぼし防止の CAS)を渡す。

  server.registerTool(
    "write_records",
    {
      description: describeTool(
        "複数のレコード操作(作成・更新)を**1つのトランザクションで全成功か全失敗**にまとめて書きます。" +
          "1つの手続きの確定(親の行1件 + 子の行 N件 + 参照先の行の更新 M件)のように、複数のテーブル・複数の行を" +
          "**原子的に**書きたいときに使います。ops に操作を明示的に並べてください —— " +
          "1件でも失敗すると全体が巻き戻り、1バイトも書かれません(部分的に書かれることはありません)。\n" +
          '各操作は { op, table, values } で、op は "create"(新規作成)または "update"(部分更新)の2種だけです。' +
          "delete やスキーマ変更は混ぜられません(削除は delete_record、テーブル変更は apply_diff)。\n" +
          "update には target(更新対象レコードの _id)を指定し、if_match(あなたが読んだ現在の版 = _updated_at)を" +
          "添えてください。他の操作が先に変更していれば版が合わず、バッチ全体が拒否されます" +
          "(黙って上書きしない保護 = 読んでから書くまでの間に他が更新した分の取りこぼしもこれで防ぎます)。\n" +
          "**条件に合う複数行をまとめて更新する方法はありません** —— 対象は ops に列挙した行だけです。" +
          "値を減らすといった計算(例: 残り = 今の値 - 変化分)はこのツールではできません。" +
          "あなたが計算した結果の値を values に入れてください(このツールは計算済みの値を原子的に書くだけです)。",
      ),
      inputSchema: {
        app_id: appIdArg,
        // 浅く受けてカーネルに検証させる(ファイル冒頭「入力スキーマを浅くしてある理由」)。
        ops: z
          .array(z.record(z.string(), z.unknown()))
          .describe(
            "実行する操作の配列(明示列挙)。各要素は " +
              '{ "op": "create"|"update", "table": "<table_id>", "values": { <field_id>: value, ... } }。' +
              'update のときは "target"(対象の _id)と "if_match"(現在の版 _updated_at)も指定する。' +
              "先頭から順に実行され、1件でも失敗すると全体が巻き戻る。",
          ),
      },
    },
    ({ app_id, ops }) => {
      const guard = requireActorAndApp(dataRoot, app_id, actor);
      if (!guard.ok) {
        return toolError(guard.errors);
      }

      const manifest: Manifest = readCurrentManifest(dataRoot, app_id);

      // 適用中(apply 窓)なら1件も書かない(ADR-0017 / M3。HTTP と同一意味論)。
      const applying = isApplyInProgress(dataRoot, app_id);
      if (applying.inProgress) {
        return toolError([applyInProgressError(applying)]);
      }

      // **バッチだけは自前の IMMEDIATE tx を持つ**(`batch.ts:256`。ADR-0039 限定3)ので、
      // 順番待ちの上限を過ぎたときの `SQLITE_BUSY` は `writeRecords` の外へ投げられる
      // (`batch.ts` には1バイトも足さない = ADR-0066 限定8)。**ここで受けて業務の言葉へ
      // 翻訳する**(V3-M13-T15 / ADR-0069 §Decision 3。文面の出所は `errors.ts` の1関数)。
      // **`SQLITE_BUSY` 以外は素通しする**(限定13)。他の単件書込ツールは外側 tx を持たず、
      // `records.ts` の器が同じ関数で翻訳して `ok:false` を返すので、ここだけで足りる。
      try {
        return withAppDb(dataRoot, app_id, (db) => {
          // **バッチの判定**(`V8-M31-T05`。裁定 `M31-5`)。
          //
          // **要求に含まれる op が触る表を全部集め、そのすべてについて、op の動詞ごとの
          // 判定を通す。** **1つでも通らなければ要求全体を拒否する**(`AND`)——
          // **通るはずだった他の op も1行も書かれない。** **HTTP の `POST /batch` と
          // まったく同じ向きである**(`writeRecords` は1 IMMEDIATE トランザクションであり、
          // 可否だけを op ごとに分けると原子性が権限の側から崩れる)。
          //
          // **部分適用は起きない**: **この `return` はカーネルの `writeRecords` を呼ぶ**前**に
          // ループごと抜ける。**
          //
          // **【この関門が見ていないもの。誇張しない】** —— **`op` / `table` の形が不正で
          // 表を解決できなかった op には1バイトも掛からない**(形の不正はカーネルが落とす)。
          // **`ops` が空配列の要求も、この関門を0回通る**(HTTP と同じ穴)。
          //
          // **【2026-08-11(第5波)に書き換えた。旧の記述を逐語で残す】** 旧はこうだった:
          //
          //   **「【この関門が見ていないもの。誇張しない】** —— **表を解決できなかった op には
          //   1バイトも掛からない**(形の不正・実在しない表はカーネルが落とす)。
          //   **`ops` が空配列の要求も、この関門を0回通る**(HTTP と同じ穴)。」
          //
          // **旧のうち「実在しない表はカーネルが落とす」は今日は成り立たない** ——
          // **下の実在検査が `denyRoleTableWrite` より前に立つようになったためである**
          // (第5波・裁定 `M31-12` の適用)。**「形の不正」の側は今日も成り立つ。**
          for (const raw of ops) {
            const opKind = raw.op;
            const opTable = typeof raw.table === "string" ? raw.table : undefined;
            if (opTable === undefined || (opKind !== "create" && opKind !== "update")) {
              continue;
            }
            // **表の実在検査を、権限の判定より前に置く**(`V8-M31` 第5波・裁定 `M31-12` の適用)。
            // **旧(第2波〜第4波): この op 単位のループに実在検査は無く、`denyRoleTableWrite` が
            // 最初の関門だった** —— **その結果、表IDのタイプミス(`table: "nope"`)を含むバッチは
            // 権限の断り(**実測の逐語: 「表 "nope" に対する書き込みは、あなたの役割に
            // 許されていません。」**)で落ち、`allowed_values` が付かず、AI が自分で直せなかった。**
            // **理由は `update_record` / `delete_record` に書いたものと同一である:**
            // **(1) `get_manifest` は設計図を丸ごと返すと決まっている(`D-V8-55` / `D-V8-85`)。
            //     同じ呼び出し元が表の一覧をいつでも読めるので、表の実在を隠しても何も守れない。**
            // **(2) エラーからの自己訂正は製品の性質として検査で固定されている(`ADR-0005`)。**
            // **(3) 第4波で単件の2本だけを揃えた結果、`write_records` だけが逆を向いていた ——
            //     **MCP の中で道具ごとに向きが割れている状態のほうが悪い**(裁定の逐語)。**
            // **【正直に書く】これは HTTP との差をもう1件増やす** —— **HTTP の
            // `POST /apps/:app_id/batch` は `recordsAuthMiddleware` が先に立つので、
            // 実在しない表にも権限の断りを返す。** **第4波の2件と合わせて差は3件になった。**
            // **システムテーブルはここで捕まえない**(実在するのに「存在しません」と嘘になる)——
            // **読み取り専用の断りは今日どおりカーネルが返す。**
            if (!isSystemTableId(opTable) && !manifest.app.tables.some((t) => t.id === opTable)) {
              return toolError([unknownTableError(manifest, opTable)]);
            }

            const forbidden = denyRoleTableWrite(manifest, opTable, guard.value.roles, "write");
            if (forbidden !== null) {
              return toolError(forbidden);
            }
            const opValues = raw.values;
            // **項目単位の書込の判定**(`V8-M31` 第3波。HTTP の `POST /batch` と同じ並びで、
            // 表の関門の直後・行の判定より前に置く)。
            const deniedFields = denyFieldWrite(manifest, opTable, opValues, guard.value.roles);
            if (deniedFields !== null) {
              return toolError(deniedFields);
            }
            // **個人スコープ(`st_owner`)**(`V8-M31` 第6波・裁定 `M31-13`)。
            // **HTTP の `POST /apps/:app_id/batch` とまったく同じ呼び方・同じ位置である** ——
            // **項目単位の判定の**あと**、行ごとのアクセス権(点)の判定と付与表の判定の**前**。**
            // **`create` op の `values.st_owner` はここで名乗った人に**破壊的に上書きされる**
            // ので、下の `denyGrantWrite` と `writeRecords` には矯正後の値が渡る。**
            // **判定も順序も `owner-scope.ts` の `judgeOwnerScopedOp` 1本が持つ**
            // (`ADR-0067` 限定 A5 の逐語「判定を2箇所に書かない」)。
            const ownerVerdict = judgeOwnerScopedOp({
              table: manifest.app.tables.find((candidate) => candidate.id === opTable),
              op: raw,
              actorId: guard.value.id,
              readRow: (tableId, recordId) => {
                const found = getRecord(db, manifest, tableId, recordId);
                return found.ok && found.value !== null
                  ? (found.value as unknown as Record<string, unknown>)
                  : undefined;
              },
            });
            if (ownerVerdict.kind === "invisible") {
              return toolError([invisibleRecordError(ownerVerdict.tableId, ownerVerdict.target)]);
            }
            // **`no_actor` はこの経路では起こらない**(`requireActorAndApp` が主体を解決
            // できなければ、ここに来る前に断っている)。**それでも閉じる側に倒す** ——
            // **HTTP のバッチも同じ倒し方をしている**(逐語のコメント「**起きたら 403 に
            // 倒す** —— 「actor が特定できないのに書けた」を作らない」)。
            if (ownerVerdict.kind === "forbidden" || ownerVerdict.kind === "no_actor") {
              return toolError([forbiddenOwnerError()]);
            }
            const opValueObject: Record<string, unknown> =
              typeof opValues === "object" && opValues !== null && !Array.isArray(opValues)
                ? (opValues as Record<string, unknown>)
                : {};
            if (opKind === "create") {
              const denied = denyRecordCreate(
                db,
                manifest,
                opTable,
                guard.value.id,
                guard.value.roles,
              );
              if (denied !== null) {
                return toolError(denied);
              }
              // **付与表への書込の判定**(`V8-M31` 第3波)。**create は送られた値そのもの。**
              const deniedGrant = denyGrantWrite(
                db,
                manifest,
                opTable,
                "create",
                opValueObject,
                guard.value.id,
                guard.value.roles,
              );
              if (deniedGrant !== null) {
                return toolError(deniedGrant);
              }
              continue;
            }
            const target = typeof raw.target === "string" ? raw.target : undefined;
            if (target === undefined) {
              continue;
            }
            const existing = getRecord(db, manifest, opTable, target);
            if (!existing.ok || existing.value === null) {
              continue;
            }
            const denied = denyRecordWrite(
              db,
              manifest,
              opTable,
              existing.value as unknown as Record<string, unknown>,
              guard.value.id,
              guard.value.roles,
              "write",
            );
            if (denied !== null) {
              return toolError(denied);
            }
            // **付与表への書込の判定**(`V8-M31` 第3波)。**update は「既存行に送られた値を
            // 重ねたもの」を渡す**(HTTP の `POST /batch` と同型)。
            const deniedGrant = denyGrantWrite(
              db,
              manifest,
              opTable,
              "update",
              {
                ...(existing.value as unknown as Record<string, unknown>),
                ...opValueObject,
              },
              guard.value.id,
              guard.value.roles,
            );
            if (deniedGrant !== null) {
              return toolError(deniedGrant);
            }
          }
          // カスケードの履歴書き込み失敗を、この同期区間が生んだぶんだけ収集する(他ツールと同型)。
          // 監査記録(recordActivity)は MCP では付けない —— 既存の update_record / insert_sample_data と
          // 同じ非対称(MCP は無認証。監査は HTTP owner 経路だけが付ける)。
          // **【`V8-M32-T02`(2026-08-12)。`V8-M31` / `ADR-0327` の波及。旧文を1バイトも
          // 消していない】** **「MCP は無認証」の部分は今日は不正確である** —— **`ST_MCP_ACTOR`
          // の名乗りが必須になり、名乗った人の権限で判定される(ただし名乗りに証明は要らないので、
          // これは認可であって認証ではない)。** **監査を付けないことは今日も正である**
          // (`v8-m31.md` §13 の 8。MCP の書込15回で `_auth_activity` は0行)。
          const { value: result, failures } = collectWorkflowHistoryFailures(() =>
            writeRecords(db, manifest, ops as unknown as BatchOp[]),
          );
          if (!result.ok) {
            return toolError(result.errors);
          }
          return toolOk(
            failures.length > 0
              ? { records: result.results, workflow_history_failures: failures }
              : { records: result.results },
          );
        });
      } catch (error) {
        const busy = concurrentWriteBusyErrors(error);
        if (busy === null) {
          throw error;
        }
        return toolError(busy);
      }
    },
  );

  // --- 12b. delete_app(V1-M9-T09 / ADR-0031)---------------------------------------
  //
  // **カーネルの `deleteApp` への入口を開けるだけ**である(門A で `deleteApp` 自体を
  // 審査済み。ADR-0031)。アプリ単位の完全削除で、`data/apps/<app_id>/` ディレクトリ・
  // 台帳行・changelog 行・横断テーブル(ai_* / connections / …)の当該行・スナップショットを
  // まとめて消す。**取り消せない。**
  //
  // ## preview は既存の参照系ツールの合成で取る(confirm フラグを置かない)
  //
  // `delete_record` が `list_records` を preview 役にしたのと同型 —— 消える中身は
  // get_manifest / list_records / get_changelog で組み立てられるので、`preview_delete_app`
  // のような専用ツールは新設しない(語彙を増やさない。憲法2)。同意は「消える中身を人間に
  // 見せる」ことで取り、引数に boolean 型のフラグ(confirm 相当)を1つも置かない
  // (M0-T01 が `delete_record` で置いた機械検査。`tools/write.test.ts`)。
  //
  // ## 権限(M3 後)
  //
  // MCP / ローカル操作は無認証・無認可のまま(ADR-0015 / ADR-0005 §7)。HTTP に削除ルートは
  // 作らない(ADR-0003 §8)ので owner/editor/viewer のロール分岐は掛からない —— 消せるのは
  // 「MCP プロセスを起動できるローカルの信頼された利用者」であり、create_app / apply_diff /
  // undo と同じ前提である(ADR-0031 §MCP 無認証の権限前提)。
  //
  // **【`V8-M32-T02`(2026-08-12)。`V8-M31` / `ADR-0327` の波及。旧文を1バイトも消していない】**
  // **上の2文は今日は偽である** —— **`ST_MCP_ACTOR` の名乗りが必須になり、`delete_app` は
  // `judgeRoleAccess({target:{target:"app"},verb:"write"})` を通る(群B の8本)。**
  // **消せるのは「MCP プロセスを起動できる人」ではなく「名乗った人がその権限を持つとき」である。**
  // **無認可ではなくなったが、無認証であることは今日も変わらない**(名乗りに証明は要らない。
  // `D-V8-54`)。**素通りは今日1本(決まった時刻に動く処理)であり0本ではない**(`ADR-0328` 限定1)。
  // **`delete_app` は、名乗った人が読めない行まで消す**(`v8-m31.md` §13 の 2)。

  server.registerTool(
    "delete_app",
    {
      description: describeTool(
        "アプリを1個まるごと完全に削除します。**取り消せません。**" +
          "消えるのはそのアプリのすべて —— テーブル・フィールド・レコード・ビュー・ワークフロー・" +
          "関数・変更履歴(changelog)・スナップショット、そしてそのアプリの接続や AI capability・" +
          "使用量・送信予約(outbox)の記録も含みます。" +
          "undo はスキーマ変更を戻すためのもので、この削除には効きません" +
          "(スナップショットごと消えるため、巻き戻し先が無くなります)。" +
          "消したいのが1件のレコードなら delete_record を、画面(ビュー)や項目なら apply_diff の" +
          "remove_view / remove_field を使ってください —— アプリごと消すのは最後の手段です。\n" +
          DELETE_APP_SHOW_CONTENTS_FIRST,
      ),
      // 完了条件4 / F-38: `confirm` のような boolean フラグ引数は置かない。
      // 同意は「消える中身を人間に見せる」ことで取る(undo / delete_record と同じ判断)。
      inputSchema: { app_id: appIdArg },
    },
    ({ app_id }) => {
      const guard = requireActorAndApp(dataRoot, app_id, actor);
      if (!guard.ok) {
        return toolError(guard.errors);
      }

      // **アプリの設定に触れるか**(`V8-M31-T04`)。**HTTP には削除の口が無い**
      // (`ADR-0003` §8)。**前例は無いが、`delete_app` はそのアプリの定義を丸ごと消す** ——
      // **`apply_diff` で1本ずつ消すのと同じことが1回でできる以上、`apply_diff` より
      // 緩い関門にはできない。**
      // **【この関門が守っていないもの。誇張しない】** —— **通った相手は、この1回で
      // 他人の行を1件残らず消せる。** **行の判定は1度も通らない。**
      const forbidden = denyAppSettingWrite(dataRoot, app_id, guard.value.roles);
      if (forbidden !== null) {
        return toolError(forbidden);
      }

      // 削除は `deleteApp` が内部で `KernelMetaStore` を開閉するので、外側では開かない。
      // 存在確認・apply 窓ガード・部分失敗(窓A)の報告はすべてカーネル側の統一形式に従う。
      const result = deleteApp(dataRoot, app_id);
      if (!result.valid) {
        return toolError(result.errors);
      }
      return toolOk({ deleted: true, app_id: result.app_id, name: result.name });
    },
  );

  // --- 13. request_connection(V1-M4-T04 / ADR-0020 §2b・§5・§8c-3)-----------------
  //
  // **AI はここで「申請」しかできない。**このツールは connection_requests に
  // pending な申請を1件足すだけで、connections(発行済みの接続)には1バイトも書かない。
  // 発行は owner の HTTP 操作(`POST /api/apps/:app_id/connections`)だけが行う ——
  // その経路は MCP / apply_diff に1本も結線されていない(§8c-3)。したがって、
  // 会話がどう汚染されても(プロンプトインジェクションで何を作らされても)、AI が
  // 到達できる最大は「pending な申請の作成」までである(§2b の経路の不在)。
  //
  // **説明文に「申請しかできない」と書くが、それは担保ではない**(F-41: プロンプトは
  // 担保にならない)。担保は上記の経路の不在であり、`descriptions.test.ts` /
  // `capability-issuance.test.ts` がそれを固定する。ここで正直に書くのは、F-41 の教訓
  // 「説明文は担保ではないが、正直さは要る」に従うためである。

  server.registerTool(
    "request_connection",
    {
      description: describeTool(
        "外部サービスへの接続(capability)を **申請** します。" +
          "会話で外部接続を要する機能(例: 外部APIへ送信するワークフロー)を頼まれたら、" +
          "このツールで申請を出してください。" +
          "**接続(capability)は申請しかできません。発行(有効化)は人間(owner)だけが UI で行います。" +
          "この申請だけでは外部送信は一切起きません。**" +
          "owner が承認して接続を発行して初めて、その接続を使うワークフローが実際に送信できるようになります。" +
          "申請には name(申請する接続名)/ purpose(なぜ必要か)/ hosts(送信先ホストの提案)を添えてください。" +
          "hosts はあくまで提案で、owner は承認時により狭いホワイトリストへ絞ることができます。" +
          "secret(APIキー等)はこの申請に含めないでください —— 取得元は owner が承認時に指定します。" +
          "申請を出したら、ユーザに「owner の承認が必要である」ことを伝えてください。",
      ),
      inputSchema: {
        app_id: appIdArg,
        name: z
          .string()
          .describe("申請する接続名。ワークフローの call_external がこの名前で参照する。"),
        purpose: z
          .string()
          .describe("なぜこの接続が必要か。owner が承認/却下を判断するための説明。"),
        hosts: z
          .array(z.string())
          .describe(
            '送信先ホストの提案(ホワイトリスト)。例: ["api.example.com"]。' +
              "owner は承認時にこれを狭められる。",
          ),
      },
    },
    ({ app_id, name, purpose, hosts }) => {
      const guard = requireActorAndApp(dataRoot, app_id, actor);
      if (!guard.ok) {
        return toolError(guard.errors);
      }

      // **アプリの設定に触れるか**(`V8-M31-T04`)。**HTTP には申請の口が無い**
      // (申請を作れるのは MCP だけである)。**前例は無いが、申請は「このアプリに外部への
      // 接続を足してください」という、アプリの設定についての提案である** —— **owner の
      // 承認待ちの列に自分の名前で1件積む操作を、定義を変えられない相手に開けない。**
      // **【正直に書く】これは HTTP より厳しい側への変更ではない** —— **比べる相手が
      // 存在しない。** **「HTTP と同じ判定」とは書けない。**
      const forbidden = denyAppSettingWrite(dataRoot, app_id, guard.value.roles);
      if (forbidden !== null) {
        return toolError(forbidden);
      }

      // R3: 呼び出しごとに open し、`finally` で close する。
      // **createRequest は connection_requests にだけ書く。connections には触れない**
      // (発行は owner HTTP 経路のみ。§8c-3)。
      const store = CapabilityStore.openForKernel(dataRoot);
      try {
        const request = store.createRequest({
          appId: app_id,
          requestedName: name,
          purpose,
          suggestedHosts: hosts,
        });
        return toolOk({
          requestId: request.id,
          message: "申請を受け付けました。owner の承認後にのみ有効になります。",
        });
      } finally {
        store.close();
      }
    },
  );

  // --- 14. request_ai_capability(V1-M5-T04 / ADR-0021 §2b・§5・§8c-3)---------------
  //
  // **AI はここで「申請」しかできない**(request_connection と同型)。このツールは
  // ai_requests に pending な申請を1件足すだけで、ai_capabilities(発行済み)にも
  // 上限にも1バイトも書かない。発行・上限変更は owner の HTTP 操作だけが行い、その経路は
  // MCP / apply_diff に1本も結線されていない(§8c-3)。会話がどう汚染されても、AI が
  // 到達できる最大は「pending な申請の作成」までである(§2b の経路の不在)。
  // **説明文は担保ではない**(F-41)。担保は経路の不在で、テストが固定する。

  server.registerTool(
    "request_ai_capability",
    {
      description: describeTool(
        "機能内で AI を呼ぶための能力(AI capability)を **申請** します。" +
          "会話で AI 呼び出しを要する機能(例: 入力文を自動分類して select フィールドを埋める " +
          "ai_transform ワークフロー)を頼まれたら、このツールで申請を出してください。" +
          "**AI capability は申請しかできません。発行(プロバイダ・モデル・日次上限の設定)は " +
          "人間(owner)だけが UI で行います。この申請だけでは AI 呼び出しは一切起きません。**" +
          "owner が承認して capability を発行して初めて、それを使う ai_transform が実際に AI を呼べます。" +
          "**上限(コスト・回数)を変更できるのも人間だけです。**" +
          "申請には name(申請する capability 名)/ purpose(なぜ必要か)を添え、" +
          "provider(claude_cli / openai_compatible)や model は任意で提案できます(owner が決めます)。" +
          "APIキー等の secret はこの申請に含めないでください —— 取得元は owner が承認時に指定します。" +
          "申請を出したら、ユーザに「owner の承認が必要である」ことを伝えてください。",
      ),
      inputSchema: {
        app_id: appIdArg,
        name: z
          .string()
          .describe("申請する capability 名。ワークフローの ai_transform がこの名前で参照する。"),
        purpose: z
          .string()
          .describe("なぜこの AI 呼び出しが必要か。owner が承認/却下を判断するための説明。"),
        provider: z
          .string()
          .optional()
          .describe("希望プロバイダの提案(claude_cli / openai_compatible)。owner が決める。"),
        model: z.string().optional().describe("希望モデルの提案。owner が決める。"),
      },
    },
    ({ app_id, name, purpose, provider, model }) => {
      const guard = requireActorAndApp(dataRoot, app_id, actor);
      if (!guard.ok) {
        return toolError(guard.errors);
      }
      // **アプリの設定に触れるか**(`V8-M31-T04`。`request_connection` と同型。**前例は無い**)。
      const forbidden = denyAppSettingWrite(dataRoot, app_id, guard.value.roles);
      if (forbidden !== null) {
        return toolError(forbidden);
      }
      // **createRequest は ai_requests にだけ書く。ai_capabilities / 上限には触れない**
      // (発行・上限変更は owner HTTP 経路のみ。§8c-3)。
      const store = AiCapabilityStore.openForKernel(dataRoot);
      try {
        const request = store.createRequest({
          appId: app_id,
          requestedName: name,
          purpose,
          suggestedProvider: provider ?? null,
          suggestedModel: model ?? null,
        });
        return toolOk({
          requestId: request.id,
          message:
            "AI capability の申請を受け付けました。owner が発行(プロバイダ・モデル・上限の設定)して初めて有効になります。",
        });
      } finally {
        store.close();
      }
    },
  );

  // --- 15. request_inbound_endpoint(V2-M5-T01 / ADR-0041 限定1・§1)-----------------
  //
  // **AI はここで「申請」しかできない**(request_connection の鏡写し。送信 ADR-0020 §2b/§8c-3
  // の対称)。このツールは inbound_endpoint_requests に pending な申請を1件足すだけで、
  // inbound_endpoints(発行済みの受信口)には1バイトも書かない。発行(署名検証鍵の取得元・
  // 書込先テーブルの確定)は owner の HTTP 操作だけが行い、その経路は MCP / apply_diff に
  // 1本も結線されていない。会話がどう汚染されても、AI が到達できる最大は「pending な申請の
  // 作成」までである(経路の不在)。**説明文は担保ではない**(F-41)。担保は経路の不在で、
  // `write.test.ts` / `inbound-store.test.ts` がそれを固定する。

  server.registerTool(
    "request_inbound_endpoint",
    {
      description: describeTool(
        // **V5-M15(`G-G11`。門外・実施する / `D-V5-85`)**: **枕と例示から特定の業種の前提を外し、
        // 受けられない署名の形を書き足した。** 04 §4-3 の逐語「**受信口の申請ツールの説明文から、
        // 決済に固有の前提を外す**」+ `D-V5-85` の逐語「**AI 向け説明文が実際より広く読める件は
        // `G-G11`(門外・実施する)の射程内なので、そちらで文言を狭める。**」
        "外部サービスからの通知を受け取る口(inbound capability)を **申請** します。" +
          "会話で外部からの受信を要する機能(例: 別のサービスで起きた出来事の通知を受けて、その1件を表に1行足す)を" +
          "頼まれたら、このツールで申請を出してください。" +
          "**受信口は申請しかできません。発行(署名検証鍵の取得元・書込先テーブルの確定)は " +
          "人間(owner)だけが UI で行います。この申請だけでは受信は一切起きません。**" +
          "owner が承認して受信口を発行して初めて、署名検証を通った Webhook が実際に書き込めるようになります。" +
          "申請には name(申請する受信口名)/ purpose(なぜ必要か)/ target_table(書込先テーブルの提案)を" +
          "添えてください。target_table はあくまで提案で、owner は承認時に別テーブルへ変えることができます。" +
          "secret(署名検証鍵)はこの申請に含めないでください —— 取得元は owner が承認時に指定します。" +
          // **狭める側**(`ADR-0160` 限定3 / 限定5)。**書かないと、AI は受けられない送り手を
          // 前提にした機能を組んでしまう。**
          "**受けられる署名の形は決まっています** —— 署名が載るヘッダの名前は3つ、値の書き表し方は3つで、" +
          "owner が受信口ごとに1つずつ宣言します(この宣言も申請には書けません)。" +
          "**署名アルゴリズムは HMAC-SHA256 の1種だけで、選べません。HMAC の入力は受信した本文そのものに固定です** —— " +
          "**時刻の印などを本文に連結してから署名する送り手からの通知は、今日1つも受け取れません。**" +
          "**その送り手からの通知を前提にした機能を約束せず、受け取れないことをユーザに伝えてください。**" +
          "申請を出したら、ユーザに「owner の承認が必要である」ことを伝えてください。",
      ),
      inputSchema: {
        app_id: appIdArg,
        name: z.string().describe("申請する受信口名。owner が発行時にこの名前で受信口を作る。"),
        purpose: z
          .string()
          .describe("なぜこの受信口が必要か。owner が承認/却下を判断するための説明。"),
        target_table: z
          .string()
          .describe(
            "受信した1件を書き込む先のテーブルIDの提案。" +
              "owner は承認時にこれを別テーブルへ変えられる。",
          ),
      },
    },
    ({ app_id, name, purpose, target_table }) => {
      const guard = requireActorAndApp(dataRoot, app_id, actor);
      if (!guard.ok) {
        return toolError(guard.errors);
      }

      // **アプリの設定に触れるか**(`V8-M31-T04`。`request_connection` の鏡写し。**前例は無い**)——
      // **申請には書込先テーブルの提案(`target_table`)が載る。** **定義を変えられない相手が
      // 「この表に外から書かせてください」を積める形にしない。**
      const forbidden = denyAppSettingWrite(dataRoot, app_id, guard.value.roles);
      if (forbidden !== null) {
        return toolError(forbidden);
      }

      // 呼び出しごとに open し、`finally` で close する。
      // **requestInboundEndpoint は inbound_endpoint_requests にだけ書く。inbound_endpoints
      // には触れない**(発行は owner HTTP 経路のみ。ADR-0041 限定1)。
      const store = InboundStore.openForKernel(dataRoot);
      try {
        const request = store.requestInboundEndpoint({
          appId: app_id,
          requestedName: name,
          purpose,
          suggestedTargetTable: target_table,
        });
        return toolOk({
          requestId: request.id,
          message: "受信口の申請を受け付けました。owner の承認・発行後にのみ受信が有効になります。",
        });
      } finally {
        store.close();
      }
    },
  );

  // --- 16. request_custom_css(V3-M5-T01 / ADR-0055 限定5・限定7)---------------------
  //
  // **AI はここで「申請」しかできない**(request_connection / request_inbound_endpoint と同型)。
  // このツールは `escape_hatch_asset_requests` に pending な申請を1件足すだけで、
  // **発行済み資産(`escape_hatch_assets`)にも CSS のバイト列にも1バイトも書かない。**
  // 発行(本文の投入・作用域の宣言)は owner の HTTP 操作
  // (`POST /api/apps/:app_id/escape-hatch-assets`)だけが行い、その経路は MCP / apply_diff に
  // 1本も結線されていない(ADR-0055 限定5)。会話がどう汚染されても、AI が到達できる最大は
  // 「pending な申請の作成」までである(経路の不在)。
  //
  // **CSS の本文をこのツールで受け取らない**のは意図的である —— 引数に本文を置くと、
  // 「AI が書いた CSS が pending テーブルに載る」= 本体を書く経路が MCP 側に半分できる。
  // 申請に載るのは「何をしたいか(purpose)」と「どの画面か(views)」だけで、
  // **本文を書くのは owner である。**
  //
  // **説明文は担保ではない**(F-41)。担保は経路の不在で、
  // `src/server/escape-hatch-issuance.test.ts` がソースの上で固定する。

  server.registerTool(
    "request_custom_css",
    {
      description: describeTool(
        "プリセットにもテーマにも収まらない見た目の調整(任意 CSS の「逃げ道」)を **申請** します。" +
          "会話で、用意された選択肢(add_view / update_view の preset_ キーや set_theme の25スロット)の" +
          "外にある見た目を頼まれ、言い換えでも収まらないと分かったときに、このツールで申請を出してください。" +
          "**逃げ道は申請しかできません。CSS を書いて有効化するのは人間(owner)だけです。" +
          "AI は CSS の本文をどこにも書けず、この申請だけでは見た目は1ピクセルも変わりません。**" +
          "owner が CSS を書いて資産を発行し、さらにどの画面に当ててよいか(作用域)を宣言して初めて、" +
          "その資産を参照する画面に効くようになります。" +
          "申請には name(申請する資産名)/ purpose(どんな見た目にしたいか・なぜ必要か)/ " +
          "views(当ててほしい画面IDの提案)を添えてください。" +
          "**CSS の本文はこの申請に含められません** —— 本文を書くのは owner です。" +
          "views はあくまで提案で、owner は発行時に別の画面へ変えることも、狭めることもできます。" +
          "申請を出したら、ユーザに「owner が CSS を書いて発行する必要がある」ことを伝えてください。",
      ),
      inputSchema: {
        app_id: appIdArg,
        name: z.string().describe("申請する資産名。owner が発行するときにこの名前で資産を作る。"),
        purpose: z
          .string()
          .describe(
            "どんな見た目にしたいか・なぜ必要か。owner が CSS を書き、承認/却下を判断するための説明。",
          ),
        views: z
          .array(z.string())
          .describe(
            '当ててほしい画面(ビュー)IDの提案。例: ["books-list"]。' +
              "owner は発行時にこれを狭めたり別の画面に変えたりできる。空でもよい(提案なので)。",
          ),
      },
    },
    ({ app_id, name, purpose, views }) => {
      const guard = requireActorAndApp(dataRoot, app_id, actor);
      if (!guard.ok) {
        return toolError(guard.errors);
      }

      // **アプリの設定に触れるか**(`V8-M31-T04`。`request_connection` と同型。**前例は無い**)——
      // **申請には当ててほしい画面(`views`)が載る。** **見た目もアプリの設定である以上、
      // 定義を変えられない相手の提案を、owner の列に積める形にしない。**
      const forbidden = denyAppSettingWrite(dataRoot, app_id, guard.value.roles);
      if (forbidden !== null) {
        return toolError(forbidden);
      }

      // 呼び出しごとに open し、`finally` で close する。
      // **requestEscapeHatchAsset は escape_hatch_asset_requests にだけ書く。
      // escape_hatch_assets にも `apps/<id>/escape-hatch/` にも触れない**
      // (発行は owner HTTP 経路のみ。ADR-0055 限定5)。
      const store = EscapeHatchStore.openForKernel(dataRoot);
      try {
        const request = store.requestEscapeHatchAsset({
          appId: app_id,
          requestedName: name,
          purpose,
          suggestedScopeViews: views,
        });
        return toolOk({
          requestId: request.id,
          message:
            "逃げ道(任意 CSS)の申請を受け付けました。owner が CSS を書いて発行し、作用域を宣言するまで見た目は変わりません。",
        });
      } finally {
        store.close();
      }
    },
  );

  // --- 14. set_comment_visibility(V10-M30-T02 / ADR-0378 = 台帳 `CM-G37`)-------------
  //
  // **アプリごとの「コメントを書く欄・読む場所を画面に出すか」を倒す道具である。**
  // **切り替えの口は AI 側にしか無い**(`D-V10-37`。切り替え用の画面を作らない)。
  //
  // ## この道具が「口を閉じない」ことを、説明文にも書く(`D-V10-38` / `ADR-0378` 限界3)
  //
  // **OFF にして止まるのは画面の表示だけである。** **外から直接送れば今日どおり書けるし、
  // AI は今日どおり読める。** ここで「コメントを止められる」と書くと、AI はそれを担保として
  // 会話に持ち出す —— **説明文は担保ではない**(F-41)が、**嘘を書いてよい理由にはならない。**
  //
  // ## 器を1本も作らない(`ADR-0378` 限定6)
  //
  // **書く先は `V10-M30-T01`(`ADR-0377`)が置いた `apps` 表の列2本ちょうどである。**
  // **この道具は `Database` を1度も直に開かず、`KernelMetaStore` のメソッドだけを呼ぶ** ——
  // **SQL も PRAGMA も1文字も書かない**(器の中の1本に閉じる)。
  //
  // ## 可否の条件式を1行も書かない(`ADR-0378` 限定4)
  //
  // **`delete_app` / `apply_diff` とまったく同じ形で `denyAppSettingWrite` を通す。**
  // **この道具の中に「誰なら倒せるか」を判断する式は1つも無い** —— **在るのは呼び出し1行だけで、
  // 判定の家は今日も1軒である**(このファイルの `denyAppSettingWrite` の doc)。
  //
  // ## 名乗りを渡す引数を1本も置かない(`ADR-0378` 限定3)
  //
  // **`actor` / `as` / `act_as` / `user` / `user_id` / `role` / `roles` を1語も置かない。**
  // **名乗りは今日どおり `ST_MCP_ACTOR` 1本である**(`ADR-0346` 限定3 / `ADR-0368` 限定4 と同じ向き)。
  //
  // ## 倒した後の値を返す理由
  //
  // **読む道具を2本目に足していない**(`ADR-0378` 限定1: 足すのは1本ちょうど)。
  // **したがって、この返り値が「今どうなっているか」を AI が知る唯一の手立てである。**

  server.registerTool(
    "set_comment_visibility",
    {
      description: describeTool(
        "このアプリで、利用者がコメントを書く欄(comment_write)と、書かれたコメントを読む場所" +
          "(comment_read)を画面に出すかどうかを切り替えます。" +
          "片方だけ渡せば、渡さなかったほうは今の値のまま残ります(両方省略はできません)。" +
          "**OFF にしても口は閉じません** —— 止まるのは画面の表示だけで、" +
          "外から直接送れば今日どおり書け、AI は今日どおり読めます。" +
          "**この切り替えの記録はどこにも残りません**(変更履歴に載らず、undo でも戻りません)。" +
          "倒したあとの値をそのまま返すので、今どうなっているかはその返り値で確かめてください。" +
          // **【`V10-M30` の独立点検 B-6(2026-08-25)】既定を1文だけ足す。**
          // **読み口が AI にも HTTP にも1本も無い**ので、これが無いと AI は
          // 「誰も倒していないから OFF」なのか「誰かが OFF にした」のかを、
          // **書き込まずに判別できない。**
          "**どちらの欄も、初めは OFF です**(今あるアプリも、これから作るアプリも同じ)——" +
          "この道具は今の値を読むことができないので、倒さずに今の値を知る手立ては1本もありません。",
      ),
      // **7語(actor / as / act_as / user / user_id / role / roles)を1つも置かない**
      // (`ADR-0378` 限定3。`src/mcp/tools/write.test.ts` の (CV-8) が固定する)。
      inputSchema: {
        app_id: appIdArg,
        comment_write: z
          .boolean()
          .optional()
          .describe("コメントを書く欄を画面に出すか。省略すると今の値のまま。"),
        comment_read: z
          .boolean()
          .optional()
          .describe("書かれたコメントを読む場所を画面に出すか。省略すると今の値のまま。"),
      },
    },
    ({ app_id, comment_write, comment_read }) => {
      const guard = requireActorAndApp(dataRoot, app_id, actor);
      if (!guard.ok) {
        return toolError(guard.errors);
      }

      // **アプリの設定に触れるか**(`delete_app` と同じ1本。`ADR-0378` 限定4)。
      // **コメントを画面に出すかどうかは、そのアプリの見え方の設定である** ——
      // **定義を変えられない相手に倒させない。**
      const forbidden = denyAppSettingWrite(dataRoot, app_id, guard.value.roles);
      if (forbidden !== null) {
        return toolError(forbidden);
      }

      // **両方省略は断る**(何も倒さない)。**zod では課さない** —— 課すと SDK が handler の
      // 手前で弾き、`structuredContent` の無い英語の zod エラーになって統一形式が壊れる
      // (このファイル冒頭の「入力スキーマを浅くしてある理由」と同じ判断)。
      if (comment_write === undefined && comment_read === undefined) {
        return toolError([
          {
            path: "",
            message: "comment_write と comment_read の少なくとも一方を指定してください。",
            hint: "どちらも省略すると倒すものが1つもありません。片方だけ渡せば、渡さなかったほうは今の値のまま残ります。",
          },
        ]);
      }

      // **省略された側はキーごと落とす** —— **`exactOptionalPropertyTypes` の下では
      // `{ write: undefined }` と「キーが無い」は別物であり、器の「省いた側は今の値を
      // そのまま残す」という契約(`ADR-0377`)に乗せるには後者でなければならない。**
      const patch: { write?: boolean; read?: boolean } = {};
      if (comment_write !== undefined) {
        patch.write = comment_write;
      }
      if (comment_read !== undefined) {
        patch.read = comment_read;
      }

      // 呼び出しごとに open し、`finally` で close する(`list_apps` と同じ形)。
      const store = KernelMetaStore.open(dataRoot);
      try {
        return toolOk({ app_id, comment_visibility: store.setCommentVisibility(app_id, patch) });
      } catch (error) {
        // **【`V10-M30` の独立点検 B-1(2026-08-25)。上の行は1バイトも消していない】**
        // **器(`KernelMetaStore`)が投げた素の `Error` を統一形式に写す。** ここが無いと、
        // 別接続が `BEGIN IMMEDIATE` を保持している最中の `database is locked` が
        // **`structuredContent` も `path` も `hint` も無い生のエラー**として AI に返っていた
        // (点検の実測。直す前の返り値は `{ content: [{ type: "text", text: "database is locked" }],
        // isError: true }` ちょうどで、機械が読める項目が1つも無い)。
        //
        // **形はこのファイルの `write_records` と1文字も変えていない**(新しい書き方を発明しない)——
        // `concurrentWriteBusyErrors` に写せたものだけを `toolError` にし、**写せないものは
        // そのまま投げ直す。** **文面はこの層に1文字も持たない**(出所は `src/kernel/errors.ts`。
        // `ADR-0003` §7: エラー文面は入口層に置かない)。
        const busy = concurrentWriteBusyErrors(error);
        if (busy === null) {
          throw error;
        }
        return toolError(busy);
      } finally {
        store.close();
      }
    },
  );
}
