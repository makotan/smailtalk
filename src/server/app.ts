/**
 * HTTP API(V0-P3-T02 / ADR-0003)。
 *
 * この層の責務は **「HTTP ⇄ カーネル内部API の変換」だけ**である(ADR-0003 §7):
 *
 * 1. URL(パスパラメータ・クエリ)をカーネル関数の引数にデコードする
 * 2. リクエストボディの JSON を `RecordInput` として渡す
 * 3. `RecordResult` を HTTP ステータス + JSON ボディに変換する
 * 4. 静的ファイルを配信する
 *
 * バリデーション・参照整合性・DDL・エラー文面はすべてカーネル(`src/kernel/`)にあり、
 * ここには**1行も置かない**。カーネルが返した `ValidationError[]` は無加工で
 * `{ errors: [...] }` に入れて返す。SQL もここには書かない。
 *
 * マニフェストを**変更する**エンドポイントは、Phase 4(V0-P4-T06)で apply_diff / undo /
 * preview_undo / changelog取得 の4本だけ追加した(ADR-0003 §4「Phase 4 での変更」)。
 * 変更手段はこの4本に閉じており、いずれもカーネル(`applyDiff` / `undo` / `previewUndo` /
 * `getChangelog`)へそのまま委譲する。**アプリの作成・削除は今も HTTP からは行えない**
 * (MCP の担当)。
 *
 * データルートは必ず `createServerApp({ dataRoot })` の引数で受け取る。グローバル状態も
 * 固定パスも持たないので、テストは一時ディレクトリを渡して実データを汚さずに動かせる。
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import type { Context } from "hono";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { MiddlewareHandler } from "hono/types";
import { type AuthConfig, loadAuthConfig } from "../auth/config.ts";
import { resolveSession } from "../auth/session.ts";
import { AuthStore, ensureAuthActivitySchema, recordActivity } from "../auth/store.ts";
// **【`V8-M27-T04` / `T-G5`】`Role` 型の import も撤去した。**
// **旧(逐語)**: `import type { ActivityAction, ActivityChange, Role } from "../auth/types.ts";`
// **このファイルで `Role` を使っていたのは `hasAdminWriteRole(roles: readonly Role[])` の
// 1箇所だけであり、その関数ごと消えた**(実測。`tsc` の `noUnusedLocals` が教えた)。
import type { ActivityAction, ActivityChange } from "../auth/types.ts";
// **【`V8-M27-T04` / `T-G5`】`isReservedRole` の値 import は撤去した。**
// **旧: `import { isReservedRole } from "../auth/types.ts";`** —— **このファイルの
// 4箇所(レコード経路 / 手動起動 / ファイル配信 / `FileViewer` の代入)が使っていた。**
// **`Role` 型の import は今日も残る**(応答の型に要る)。
/*
 * 逃げ道(任意 CSS)の配信に要る2つ(V3-M5-T02 / ADR-0055)。**`src/kernel/index.ts` は
 * 1バイトも触っていない**ので、T01 と同じくモジュールを直接 import する
 * (`v3-m5-t01.md` §2 の「消費側は escape-hatch-store.ts を直接 import する」と同じ作法)。
 */
import type { EscapeHatchAsset } from "../kernel/escape-hatch-store.ts";
import { EscapeHatchStore, getEscapeHatchBody } from "../kernel/escape-hatch-store.ts";
import {
  type ApplyStatus,
  appDbPath,
  applyDiff,
  type BatchOp,
  type BatchWrittenOp,
  // **【`V5-M25-T03` / `V5-M25-T05`】手動起動の在席台帳**(`ADR-0175` 限定1)。
  // **在席を取るのは入口(下の `manualRunAuthMiddleware`)である** —— **理由と代償は
  // `src/kernel/workflow-runner.ts` の `manualRunsInFlight` の doc に書いた。**
  beginManualRun,
  CONCURRENT_WRITE_WAIT_PRAGMA,
  // **【`V8-M8` / 台帳 `Q-G1`】集計表の計算。** **入口はこれを1回呼ぶだけで、
  // 束ね方も丸め方も1バイトも持たない**(判定・計算を2箇所に住まわせない)。
  computeReport,
  concurrentWriteBusyErrors,
  createRecord,
  deleteRecord,
  type FilterNode,
  generateRequirementsDoc,
  getBlob,
  getChangelog,
  getRecord,
  isApplyInProgress,
  KernelMetaStore,
  unknownTableError as kernelUnknownTableError,
  type ListRecordsOptions,
  type Manifest,
  previewUndo,
  putBlob,
  type ReadSource,
  type RecordInput,
  type RecordResult,
  // **【`V8-M13-T02` / 台帳 `Q-G28`】切り出した `readVisibleReport()` の引数の型。**
  // **`import type` である** —— **`scripts/kernel-import-snapshot.txt` は値の import だけを
  // 採るので、この1行はそこに現れない。**
  type ReportView,
  readCurrentManifest,
  readOnlyTableError,
  readRecord,
  readRecordCountAndSum,
  readRecordList,
  renderRequirementsMarkdown,
  resetWorkflowHistoryFailureHandler,
  resolveTable,
  // **【`V5-M25-T01`】手動起動の実行**(`ADR-0174`)。
  runManualWorkflow,
  setWorkflowHistoryFailureHandler,
  type Table,
  undo,
  updateRecord,
  type ValidationError,
  type View,
  type Workflow,
  type WorkflowHistoryWriteFailure,
  writeRecords,
} from "../kernel/index.ts";
/*
 * **読取のリクエスト引数に現れたフィールドIDを取り出す2本**(`V4-M28-T01` / `ADR-0120` 限定1)。
 * **`src/kernel/index.ts` を1バイトも触らないため、モジュールを直接 import する** ——
 * **限定4 が `src/kernel/` の0行差分を求めており、re-export を1本足すことも差分である**
 * (`escape-hatch-store.ts` を直接 import しているのと同じ作法)。
 * **カーネルの走査をそのまま使う** —— filter の深さ・結合・葉の読み方が2通りに割れない。
 *
 * **`sortErrorPath` は取っていない** —— **`ADR-0009` 限定2 が「層をまたいで値として
 * import してよいのは `normalizeSort` のみ。`sortErrorPath` / `validateSortKeys` は
 * `src/kernel/` 内部からのみ参照する」と明文で禁じており、`scripts/kernel-import-drift.test.ts`
 * が条文の言葉でそれを固定している。** **path の組み立ては `hiddenFieldQueryErrors` の中へ
 * 写した(写しであることを同関数のコメントに明記してある)。**
 */
import { filterFieldRefs, normalizeSort } from "../kernel/types.ts";
import {
  ALLOWED_IMAGE_MIME,
  type AllowedImageMime,
  DEFAULT_UPLOAD_MIME,
  isAllowedImageMime,
  isUploadKind,
  MAX_FILE_UPLOAD_BYTES,
  MAX_UPLOAD_BYTES,
  UPLOAD_KINDS,
  type UploadKind,
} from "../shared/files-table.ts";
import { isSystemTableId } from "../shared/system-tables.ts";
import type { AuthEnv, AuthUser } from "./auth-context.ts";
import { registerAuthRoutes, signupFacts, signupKindValues } from "./auth-routes.ts";
// **編集系5ルート**(`V5-M3-T01`)。**`profile === "full"` のときだけ呼ぶ。**
import { registerChangeRoutes } from "./change-routes.ts";
// **`A-G1` / `ADR-0249` の 403 だけがここに在る**(発注書 `v5-m28.md` §6-2 `T02` の指定)。
// **既存の `…Error()` 組み立て関数は1本も動かしていない** —— それらは今日も本ファイル内にある。
// **【`V8-M10-T05`】集計表の上限に当たったときの応答文も、同じ1本のファイルが翻訳する。**
import { recordAccessLimitError, reportLimitError } from "./errors.ts";
import { ensureFilesTable, getFileMeta, insertFileRecord, sniffImageMime } from "./files-store.ts";
import { registerInboundRoute } from "./inbound-route.ts";
import {
  // **【`V8-M39` / 台帳 `F-G8`】止めた層の名前の型**(`"role" | "grant"`)。
  // **型だけを取る** —— **判定を行う述語を1本も増やしていない。**
  type AccessLayerName,
  type ActorRoles,
  type CombinedRecordAccessResolution,
  type CreateParentAccessVerdict,
  type CreatorGrantPlan,
  combineRoleAndGrantAccess,
  creatorGrantPlan,
  // **【`V8-M29` 第1波 / 台帳 `T-G10`】役割の識別子を読む1本**(`declaredUserKinds` の隣)。
  // **【`V8-M29` 第2波 / 台帳 `T-G9a`】旧(逐語)**: この直後に `effectiveUserKindIds,` が在った。
  declaredRoleIds,
  type GrantWriteOp,
  type GrantWriteVerdict,
  grantsWithExistingGroups,
  // **【`V8-M37` / 台帳 `F-G5`】旧(逐語)**: `isAllowedOwnerUpdate,`
  // **単件 `PATCH` の唯一の呼び出し側が `judgeOwnerUpdateWithDisplay` に替わったので、
  // このファイルからの参照が0件になった。** **`src/server/owner-scope.ts` の本体は
  // 1バイトも触っていない**(`ADR-0079` 限定5)—— **消えたのはこの import だけである。**
  // **`src/mcp/tools/write.ts` と `judgeOwnerScopedOp` は今日も直に呼んでいる。**
  isCreatorGrantReachable,
  isDeleteProtectedRow,
  isDirectCreateSuppressed,
  // **【`V8-M37` / 台帳 `F-G3`】他人を持ち主にした**作成**を断る述語。**
  isOwnerSpoofedOnCreate,
  isOwnerVisible,
  isPublicRow,
  isRoleActionWriteAllowed,
  isRoleGovernedField,
  isSharedOwner,
  // **【`V15-M2-T02` / `CR-G1` / `ADR-0404`】行を作るときに、親の行へ書けるかを問う1本。**
  // **前提の関門である** —— **`combineRoleAndGrantAccess` の `OR` の中には入らない。**
  judgeCreateParentAccess,
  judgeGrantWrite,
  judgeOwnerScopedOp,
  // **【`V8-M37` / 台帳 `F-G5`】表示名のままの書き戻しを、付け替えと見なさない判定。**
  judgeOwnerUpdateWithDisplay,
  judgeRecordAccess,
  // **【`V8-M10-T02` / 台帳 `Q-G16a`】母集団(だれの目に、どの行が入るか)を決める1本。**
  // **レコード一覧の5分岐は、今日この1本を通る。**
  judgeRecordPopulation,
  judgeRoleAccess,
  judgeRoleFieldWrite,
  // **【`V8-M27-T04` / `T-G5`】`nonAdminTableAccess` の import は撤去した**(関数ごと消えた)。
  OWNER_FIELD,
  ownerDisplayName,
  personalOwnerField,
  projectForAnonymous,
  projectForRoleFields,
  projectOwnerDisplay,
  publicField,
  type RecordAccessResolution,
  type RecordAccessSourceTables,
  // **【`V14-M1-T01`】行と並べて返す判定の形(その組み立ては `recordRowAccessMap`)。**
  type RecordRowAccess,
  recordAccessSourceTables,
  // **【`V8-M10-T02`】「絞りが要るか」を読取の**前**に決める(行を1件も見ない)。**
  recordPopulationScope,
  recordRowAccessMap,
  resolveCombinedRecordAccess,
  resolveRecordUnreachableByRoles,
  resolveRecordWithoutGrants,
  roleGateBlocksWithoutGrants,
  roleReadCrossesOwnerScope,
  rowGrantWriteJudge,
  scrubHiddenFieldIds,
} from "./owner-scope.ts";
import {
  clientKeyFromHeader,
  RateLimiter,
  type RateLimitOptions,
  rateLimitError,
} from "./rate-limit.ts";
// **【`V8-M10-T05` / 台帳 `Q-G17`〜`Q-G19`】集計表が読取時に当たる上限2本。**
// **数値も述語もあちらに在り、ここには1つも書かない**(置き場所を決めた理由は
// `src/server/report-limits.ts` の冒頭)。
import {
  exceedsReportGroups,
  exceedsReportScannedRows,
  type ReportLimitKind,
} from "./report-limits.ts";

/**
 * **起動プロファイル**(`V5-M3-T02` / `R-G1` のサーバ側。契約は `v5-m0.md` §2-1 / §6-3)。
 *
 * - **`full`** —— 今日どおり。**編集系5ルート**(`POST /diffs` / `POST /undo` /
 *   `GET /undo/preview` / `GET /changelog` / `GET /requirements`)を登録する。**既定。**
 * - **`runner`** —— **その5本を1本も登録しない。** 実行系は1本も落とさない。
 *
 * **【この2値が主張しないこと。丸めない】**
 *
 * - **「編集できない」ではない**(`01` §8-1 の禁止1)。**`ST_SERVER_PROFILE` を外せば、
 *   同じ実行ファイルが5本を登録する。** **`Dockerfile` を書き換えれば配布物にも入る。**
 * - **未認証で通る口を1つも塞いでいない。** **`GET /undo/preview` / `GET /changelog` /
 *   `GET /requirements` は `full` では今日も未認証で通る。** **`runner` は登録しないだけである。**
 * - **`runner` は「1アプリだけ」を意味しない。** **`GET /api/apps` は `runner` にも残る**
 *   (実行系として扱った)。**1アプリに絞るのはイメージのデータ配置の話であり、
 *   `V5-M7` の担当である。**
 */
export const SERVER_PROFILES = ["full", "runner"] as const;
export type ServerProfile = (typeof SERVER_PROFILES)[number];

/** 起動プロファイルを外から与える環境変数の名前。 */
export const SERVER_PROFILE_ENV = "ST_SERVER_PROFILE";

/**
 * 環境変数の値を起動プロファイルに読む。**未設定・空文字は `full`**(今日どおり)。
 *
 * **語彙外の値は黙って `full` へ落とさず、受理集合を添えて投げる**(憲法6)。黙って
 * 落とすと、`ST_SERVER_PROFILE=Runner` の綴り違いが「編集系が入ったまま配られた」に
 * なって、誰も気づけない。
 */
export function resolveServerProfile(raw: string | undefined): ServerProfile {
  if (raw === undefined || raw === "") {
    return "full";
  }
  if ((SERVER_PROFILES as readonly string[]).includes(raw)) {
    return raw as ServerProfile;
  }
  throw new Error(
    `環境変数 ${SERVER_PROFILE_ENV} の値 "${raw}" は起動プロファイルとして読めません。` +
      `指定できるのは ${SERVER_PROFILES.join(" / ")} のいずれかです` +
      `(省略すると ${SERVER_PROFILES[0]} になります)。`,
  );
}

export type CreateServerAppOptions = {
  /** データルート(`data/` 相当)。`kernel.sqlite` と `apps/<app_id>/` がこの下にある。 */
  dataRoot: string;
  /**
   * 起動プロファイル(`V5-M3-T02`)。省略時は環境変数 `ST_SERVER_PROFILE` を読み、
   * それも無ければ `full`(今日どおり)。**引数は環境変数より優先する。**
   */
  profile?: ServerProfile;
  /**
   * フロント(Vite)のビルド成果物ディレクトリ。ADR-0003 §2 のとおり配信元は1箇所だけ。
   *
   * **既定は「起動したときの現在地」ではなく「サーバ自身の場所」から解く**(`V9-M3`)——
   * `src/server/app.ts` から2つ上(`src/server` → `src` → `apps/smailtalk`)の
   * `web/dist`(`web/vite.config.ts` の出力先と一致させてある)。
   *
   * **cwd 相対をやめた理由**: `V9-M1` が製品コードを `apps/smailtalk/` へ移したので、
   * cwd 相対だと**正本のルートから起動したときだけ画面が1枚も出ない**(`<正本のルート>/web/dist`
   * を見にいく)。それを避けて `apps/smailtalk` を現在地にすると、今度は `index.ts` の
   * `dataRoot` の既定 `"data"` が `apps/smailtalk/data` を指し、`.mcp.json`
   * (`<正本のルート>/data`)と**保管場所が2つに割れる** —— アプリは作れているのに
   * Web UI に何も出てこない、という壊れ方になる。**直したのは配信元の探し方だけで、
   * `dataRoot` の既定は cwd 相対のまま**(正本のルートから起動すれば `<正本のルート>/data`)。
   *
   * **配布物(Dockerfile)も同じ形で当たる**: イメージの中は `WORKDIR /app` に対して
   * `/app/src` と `/app/web/dist` が並ぶので、`/app/src/server` の2つ上は `/app` である。
   *
   * `bun run build:web` 前でディレクトリが無ければ、静的配信も SPA フォールバックも
   * 404 相当になる。
   */
  webDistDir?: string;
  /**
   * 認証設定(ADR-0014)。省略時は `loadAuthConfig(process.env)` を使う。
   * 起動時の妥当性検証(`validateAuthConfig`)は `index.ts` が fail-fast で行う。
   */
  authConfig?: AuthConfig;
  /**
   * 最低限レート制限の設定(V2-M1-T05 / ADR-0034 限定4)。省略時は下記の既定
   * (`DEFAULT_PUBLIC_GET_RATE_LIMIT` / `DEFAULT_AUTH_RATE_LIMIT`)を使う。テストは小さい窓と
   * 注入 `now` を渡して窓リセットを制御する。この設定はサーバインスタンスごとに独立
   * (グローバル状態を持たない)。
   */
  rateLimit?: {
    /** 匿名公開 GET 経路のレート制限。 */
    publicGet?: RateLimitOptions;
    /** サインアップ/ログイン経路のレート制限。 */
    auth?: RateLimitOptions;
    /** 受信口 `POST /inbound/:endpoint_id` のレート制限(D-G4c / ADR-0041 限定10)。 */
    inbound?: RateLimitOptions;
  };
};

/**
 * レート制限の既定(ADR-0034 §92-4「最低限」)。ローカル前提では全リクエストが同一キーに
 * なりうるので、通常操作を妨げない緩めの窓にする —— これは DoS 対策の完成ではなく、匿名経路
 * とサインアップを開く以上の最低限の抑制である。外部公開時は前段プロキシ + 別途の対策が要る。
 */
const DEFAULT_PUBLIC_GET_RATE_LIMIT: RateLimitOptions = { limit: 300, windowMs: 60_000 };
const DEFAULT_AUTH_RATE_LIMIT: RateLimitOptions = { limit: 100, windowMs: 60_000 };

/**
 * **実効ロール集合に「書ける運営ロール」(`editor` / `owner`)が1つでも在るか**
 * (`V8-M16` / `J-G3`)。
 *
 * **【この規則は着手時点でどこにも定義されていなかった。`V8-M16` が初めて定義する】** ——
 * **根拠は門A の限定 `J-G3` の逐語「複数の役割は和集合1本で合成する」である**
 * (メインの裁定 `R-3`)。**「今日どおり」とは書かない。**
 *
 * **着手前は `user.role !== "editor" && user.role !== "owner"` の等値2本が複数箇所に
 * 散っていた**(1ユーザ1値だったので、それで足りていた)。**複数持てるようになると
 * 「どれか1つでも当たれば通す」のか「全部当たらないと通さない」のかが分かれるので、
 * 規則を1本に閉じる。**
 *
 * **規則: 実効ロール集合と宣言集合の積が空でなければ通る。** ここでの宣言集合は
 * `["editor", "owner"]` の2値である。**実効ロール集合 = 列の1値 ∪ 付与表。**
 */
// --- 【`V8-M27-T04` / `T-G5`】この関門は**撤去した**。**上の説明文を1バイトも消していない** ---
//
// **ここに在ったもの(逐語)**:
//
//     function hasAdminWriteRole(roles: readonly Role[]): boolean {
//       return roles.some((role) => role === "editor" || role === "owner");
//     }
//
// **呼び出しは4箇所だった**(**すべて同じタスクで消した**): レコード経路の書込 /
// 手動起動 / まとめ書き込み / ファイルのアップロード。
//
// **なぜ消せたか**: **4経路すべてに面(`app.roles[].rules`)の判定が配線され**
// (レコードは `V8-M17`、手動起動は `V8-M17` / `V8-M20`、まとめ書き込みとアップロードは
// `V8-M27-T03` / `D-V8-71`)、**`V8-M26` が面の既定を「閉じる」側へ倒した**ためである。
//
// **【実際に変わったこと。誇張しない】** **`viewer` が書けるようになった** ——
// **面が書込を許した表に限る。** **旧はロールの綴りだけで決まっており、規則を何本
// 書いても届かなかった。** **`owner` / `editor` が黙って何でも書けるわけではない**
// —— **規則を1本も書いていない表では、今日は `owner` でも 403 である。**

/** ADR-0003 §3: エラーは常に `{ errors: [...] }`。1件でも配列。 */
type ErrorBody = { errors: ValidationError[] };

function errorBody(errors: ValidationError[]): ErrorBody {
  return { errors };
}

// --- 認証境界のエラー(ADR-0014 §5/§6)------------------------------------------

/** 未認証アクセス(401)。統一形式で、そのアプリのログイン誘導の hint を載せる。 */
function unauthenticatedError(appId: string): ValidationError {
  return {
    path: "",
    message: "認証が必要です。ログインしてください。",
    hint: `POST /api/apps/${appId}/auth/password/login または Passkey でログインしてから再度お試しください。`,
  };
}

/**
 * 認証済みだが権限不足(403)。records 書込に editor/owner ロールが要るのに viewer だった場合。
 * 未認証(401)と明確に区別する(こちらは「ログインはしている」)。
 */
/**
 * アプリの作り(テーブル・画面・ワークフロー・テーマ)を書き換える口に owner が要るのに
 * 満たない場合(403)。**`V4-FIX1` 項目(5)。** データの書込不足(`forbiddenWriteError`)と
 * 区別する —— **こちらは「データ」ではなく「アプリの作り」を変える操作である。**
 */
/*
 * =====================================================================================
 * **【`V8-M28` 第2波(2026-08-11)。台帳 `T-G15` / ユーザ決定 `D-V8-40`。
 * 本文を打ち直した。旧の文面を1バイトも消していない】**
 * =====================================================================================
 *
 * **旧の本文(逐語)**:
 *
 *     function appChangeOwnerRequiredError(): ValidationError {
 *       return {
 *         path: "",
 *         message: "アプリの作りを変更できるのは owner のみです。",
 *         allowed_values: ["owner"],
 *         hint: "テーブル・画面・ワークフロー・テーマの変更と、その取り消しには owner ロールが必要です。owner に依頼してください。",
 *       };
 *     }
 *
 * **打ち直した理由**: **可否を決めるのは役割の綴りではなく、その役割に書かれた規則
 * (`app.roles[].rules` の `target: "app"` / `can: ["write"]`)になった。**
 * **`allowed_values` に役割の綴りを焼き込むと嘘になる** —— **誰が通るかはアプリごとの
 * 規則で決まるので、固定の一覧を返せない。** **したがってキーごと落とした**
 * (**`allowed_values` は任意キーであり、他の 403 も持たないものが在る**)。
 *
 * **【禁止】ここに `["owner"]` を書き戻さない。**
 */
function appChangeRuleRequiredError(): ValidationError {
  return {
    path: "",
    message:
      "アプリの作りを変更できるのは、その権限を役割の規則で与えられた人だけです。あなたの役割には与えられていません。",
    hint: 'テーブル・画面・ワークフロー・テーマの変更と、その取り消しには、役割の規則(app の roles)に「アプリの設定を変更できる」(target: "app" / can: ["write"])が要ります。規則を書ける人に依頼してください。',
  };
}

// --- 【`V8-M27-T04` / `T-G5`】この応答体は**撤去した**。**上の説明文を1バイトも消していない** ---
//
// **ここに在ったもの(逐語)**:
//
//     function forbiddenWriteError(): ValidationError {
//       return {
//         path: "",
//         message: "この操作を行う権限がありません(閲覧のみ)。",
//         allowed_values: ["editor", "owner"],
//         hint: "データの作成・更新・削除には editor 以上のロールが必要です。owner にロールの変更を依頼してください。",
//       };
//     }
//
// **呼び出し元が0本になったので消した** —— **`hasAdminWriteRole` と `nonAdminTableAccess`
// の撤去で、この文面を返す経路が1つも残らなかった。**
// **`allowed_values: ["editor","owner"]` はロールの綴りを応答に焼き込んでおり、
// 「役割はアプリが宣言する」という今日の形とそもそも噛み合わない。**
//
// **代わりに返るのは `forbiddenRoleAccessError(what, verb)` である**
// (「… に対する書き込みは、あなたの役割に許されていません。」)—— **`allowed_values` を
// 持たず、直し方(「役割に規則を足す」)を hint に書く。**

/**
 * 個人スコープ(st_owner)の付け替え拒否(403)。V1-M3-T04 / ADR-0016。
 * 自分の行を共有(null)にはできるが、他ユーザ所有への付け替えや共有行の私物化はできない。
 */
function forbiddenOwnerError(): ValidationError {
  return {
    path: `/${OWNER_FIELD}`,
    message: "この所有者(st_owner)への変更は許可されていません。",
    allowed_values: ["(自分)", "(共有=null)"],
    hint: "自分が所有する行は共有(st_owner を null)にできますが、他ユーザ所有への付け替えや共有行の私物化はできません。",
  };
}

/**
 * **他人を持ち主にした作成を断る(403)。** `V8-M37` / 台帳 `F-G3` / ユーザ決定 `D-V8-96`。
 *
 * **判定そのものは `owner-scope.ts` の `isOwnerSpoofedOnCreate` 1本が持つ**
 * (`ADR-0061` 限定4)—— **ここにあるのは、判定結果を HTTP の応答へ翻訳することだけである。**
 *
 * **【文面に内部の綴りを1文字も出さない】**(`src/server/app.ts` の
 * `notAMemberError` / `forbiddenDirectCreateError` が課している作法)——
 * **予約規約フィールドの綴りも、述語名も、審査単位の記号も、相手の利用者IDも書かない。**
 * **`forbiddenOwnerError`(更新側)はその綴りを本文に持つが、あちらは1バイトも触っていない**
 * —— **新しく作るこちらだけが作法に従う。**
 *
 * **【`allowed_values` を持たせない】** —— **許される値は「自分」と「空」だけであり、
 * それを列挙すると利用者IDの形を応答から学べてしまう。** **hint で言葉として書く。**
 */
function forbiddenOwnerSpoofError(): ValidationError {
  return {
    path: "",
    message: "ほかの利用者を持ち主にした登録はできません。",
    hint: "持ち主の欄は空のままにしてください —— 登録した本人が持ち主になります。",
  };
}

/**
 * **行ごとのアクセス権で「書く」を持たない相手の `PATCH` を拒む(403)。**
 * `Z-G11` / `V7-M2-T02`。
 *
 * **判定そのものは `owner-scope.ts` の `judgeRecordAccess` 1本が持つ**(`ADR-0061` 限定4)——
 * **ここにあるのは、判定結果を HTTP の応答へ翻訳することだけである**
 * (`forbiddenOwnerError` / `forbiddenDirectCreateError` と同じ役割分担)。
 *
 * **【文面で誇張しない】**
 *  - **止まったのはこの1本の `PATCH` だけである。** **`POST` / `DELETE` / 画面の操作起点 /
 *    バッチ / ファイル配信の5経路には、判定が1バイトも掛かっていない**(`V7-M3` 以降)。
 *  - **MCP / 受信口 / ワークフロー / コードの島は今日どおり同じ行に書ける**
 *    (`Z-G21`〜`Z-G24`)。**「この行は守られている」とは書かない。**
 *  - **誰が権限を持っているかを応答に列挙しない**(付与の一覧が漏れる)。
 */
function forbiddenRecordWriteError(): ValidationError {
  return {
    path: "",
    message: "この行を書き換える権限がありません(読むことはできます)。",
    hint: "この行を編集できる権限を、この行を作った人か運営者に付けてもらってください。",
  };
}

/**
 * **行ごとのアクセス権で「消す」を持たない相手の `DELETE` を拒む(403)。**
 * `Z-G34` / `V7-M3-T06`。
 *
 * **判定そのものは `owner-scope.ts` の `judgeRecordAccess` 1本が持つ**(`ADR-0061` 限定4)。
 * **ここにあるのは、判定結果を HTTP の応答へ翻訳することだけである。**
 *
 * **【`forbiddenRecordWriteError` と別建てにした理由】** —— **`ADR-0077` §3a-2 の逐語
 * 「**「作れない」と「直せない」「消せない」は別の要求である**」。** **「書き換える権限が
 * ありません」と言われた人が消せてしまう / その逆を、文面が取り違えないようにする。**
 *
 * **【文面で誇張しない】**
 *  - **止まったのは HTTP の `DELETE` だけである。** **MCP / 受信口 / ワークフロー /
 *    コードの島は今日も同じ行を消せる**(`Z-G21`〜`Z-G24`)。**「この行は守られている」
 *    とは書かない。**
 *  - **誰が権限を持っているかを応答に列挙しない**(付与の一覧が漏れる)。
 */
function forbiddenRecordDeleteError(): ValidationError {
  return {
    path: "",
    message: "この行を消す権限がありません(読むことはできます)。",
    hint: "この行を消せる権限を、この行を作った人か運営者に付けてもらってください。",
  };
}

/**
 * **「誰にも見えない行」を探す運営専用の口を、運営以外に開かない(403)。**
 * `Z-G19` / `V7-M5-T02`(限定3: **開くのは予約ロールの `owner` だけ**)。
 *
 * **【文面で誇張しない】**
 *  - **この口は行を**見つける**だけであり、付与を1件も作らない**(限定2: 読取専用)。
 *  - **どの表がこの口を持つかを、拒否の文面で明かさない** —— **表の名前も宣言の有無も
 *    1文字も載せない。**
 */
function forbiddenUnreachableListError(): ValidationError {
  return {
    path: "",
    message: "この一覧は運営者だけが見られます。",
    allowed_values: ["owner"],
    hint: "誰も開けなくなった行の一覧が必要なときは、運営者に依頼してください。",
  };
}

/**
 * **その表には運営専用の口が無い(404)。** `Z-G19` 限定5 / `V7-M5-T02`。
 *
 * **アクセス権の宣言をしていない表と `enabled: false` の表は、この口の対象外である**
 * (オプトイン)。**403 ではなく 404 にするのは、「この表は宣言している / していない」を
 * 応答コードの差で数え上げられないようにするためである** —— **`resolveTableForRoute` が
 * 実在しない表に返すのと同じ 404 に揃える。**
 *
 * **【文面で誇張しない】** —— **「この表は安全だ」とは1文字も書かない。**
 * **この口が無いことと、その表の行が守られていることは、まったく別のことである。**
 *
 * =====================================================================================
 * **【2026-08-13 追記(`V8-M41`。台帳 `F-G13`)。上の doc を1バイトも消していない。**
 * **ただし上の第1段落の「アクセス権の宣言をしていない表と `enabled: false` の表は、この口の
 * 対象外である(オプトイン)」は、今日は偽である】**
 * =====================================================================================
 *
 * **`F-G13` が口の入口条件を広げたので、この 404 が残るのは**2つだけ**になった** ——
 * **(1) 実在しない表**(そちらは `resolveTableForRoute` の別の文面が返る)/
 * **(2) システムが持つ表**(面の判定を1度も受けないので、取り残しが構造上ありえない)。
 * **宣言していない表と `enabled: false` の表は、今日は 200 を返す。**
 *
 * **旧の `hint`(逐語)**: 「**アクセス権の管理を有効にしたテーブルにだけ、この一覧が
 * あります。**」 —— **この案内は今日は嘘である**(**宣言していない表にもこの一覧が在る**)。
 * **嘘の案内を残すと、読み手は「宣言すれば一覧が出る」と読んで、要らない宣言を書く。**
 * **`message` は1バイトも動かしていない。**
 *
 * **【403 と 404 の差で数え上げられないようにする、という上の理由はどうなったか】** ——
 * **今日はもっと強い**: **宣言している表もしていない表も、同じ 200 を返す。**
 * **応答コードの差から読めるのは「プラットフォームが持つ表かどうか」だけであり、
 * それは表IDの綴り(先頭の `_`)からもマニフェストからも既に読める。**
 */
function unreachableListUnavailableError(tableId: string): ValidationError {
  return {
    path: "",
    message: `テーブル "${tableId}" には、誰も開けなくなった行の一覧はありません。`,
    hint: "この一覧があるのは、アプリが自分で作ったテーブルだけです(プラットフォームが持つテーブルにはありません)。",
  };
}

/**
 * **メンバー表に行が無い人の作成を拒む(400)。** `V7-M3-T02` / `v7-m0.md` §5-5 (a)。
 *
 * **文面は裁定の逐語である** —— 「**あなたはこのアプリのメンバー表に登録されていないため、
 * この表に行を作れません**」。**内部記号(宣言のキー名・表ID・述語名・審査単位の記号)を
 * 1文字も出さない。**
 *
 * **【400 にする理由】** —— **通すと「作った本人にも見えない行」が黙って生まれる**
 * (`v7-m0.md` §5-5 (a) の逐語)。**403 ではないのは、止めているのが「その人の権限」ではなく
 * 「この表に行を作るのに要る登録が済んでいないこと」だからである。**
 *
 * =====================================================================================
 * **【2026-08-13 追記(`V8-M41`。台帳 `F-G12` = 限定採用・門外(`Δ7`))。**
 * **上の doc は1バイトも消していない。旧の文面もここに逐語で残す】**
 * =====================================================================================
 *
 * **旧の `message`(逐語)**:
 * 「**あなたはこのアプリのメンバー表に登録されていないため、この表に行を作れません。**」
 * **旧の `hint`(逐語)**:
 * 「**この表を使えるようにするには、アプリの管理者にあなたを利用者として登録してもらって
 * ください。**」
 *
 * **`v8-m35.md` §5-1 の `F-G12` の限定の逐語**: 「**断りの文面と手引きだけ。**
 * **持ち主の特別扱いを戻さない。自動メンバー登録もしない**」。
 *
 * **【何が足りなかったか。丸めない】** **旧の文面は「アプリの管理者に登録してもらえ」と
 * しか言わない。** **`v8-m33.md` §1-A の `A-1` を踏んだのは**持ち主(運営者)自身**であり、
 * その人に「管理者に頼め」と言っても次の一手が出てこない。** **さらに、登録の行に書く値が
 * **ログイン名ではなく利用者ID**であることをどこにも書いておらず、ログイン名を書いた人は
 * まったく同じ 400 をもう一度受け取る**(`cp-v8-unify.md` §20-D の 3 が実際に踏んだ罠である)。
 *
 * **【今日の文面が足したもの】** **(1) 行き先(利用者の表)/ (2) 足せる人(運営者。
 * 自分が運営者なら自分で足せる)/ (3) 書く値(ログイン名ではなく利用者ID)。**
 *
 * **【`A-1` は実装の欠陥ではない。実装を1バイトも変えていない】** ——
 * **`v8-m35.md` §4-2 が3つの独立な裏づけで「利用者の表に利用者IDで1行入れれば作れる」を
 * 確かめており、`V8-M41` が実 HTTP でも確かめた。** **`creatorGrantPlan`
 * (`src/server/owner-scope.ts`)に持ち主の分岐を1本も足していない。自動でメンバー行を
 * 入れる処理も1バイトも書いていない**(`ADR-0318` 限定5 を1ミリも動かしていない)。
 *
 * **【内部記号を出していないことの確認】** **宣言のキー名(行ごとのアクセス権の宣言そのものの
 * 綴りを含む)/ 表ID / 述語名 / 審査単位の記号を1文字も書いていない**(固定は
 * `src/server/not-a-member-guidance.test.ts` の (B-1))。 **「利用者ID」はこの4分類の
 * どれでもない** —— **`src/mcp/actor-guard.ts` が呼び出し側へ返す文面でも同じ語を使っている。**
 *
 * **【この文面だけでは自己完結しない。正直に書く】** —— **「どの表が利用者の表なのか」
 * (表IDは内部記号なので出せない)と「自分の利用者IDをどこで確かめるか」は、この文面に
 * 書けない。** **その2つは手引き(`docs/manual.md` §6.1 の `V8-M41` の追記)が持つ。**
 *
 * **【応答コードは変えていない】** —— **今日も 400 である**(上の「400 にする理由」は
 * そのまま生きている)。**`ValidationError` のキーも4キーのままで、5キー目を足していない。**
 *
 * **【射程。誇張しない】** —— **この関数を通るのは HTTP の2経路(単件の作成 / まとめ書込)
 * だけである。** **受信口は自分の文面を持ち**(`src/server/inbound-route.ts` の
 * `inboundAccessDenied`)、**AI(MCP)は同じ文面の**写し**を別に持つ**
 * (`src/mcp/tools/write.ts` の同名関数)。**本 MS はそのどちらも1バイトも触っていない** ——
 * **したがって AI 経由の文面は今日も旧のままである。** **【禁止】「AI 経由も直った」と書かない。**
 */
function notAMemberError(): ValidationError {
  return {
    path: "",
    message:
      "この表に行を作れるのは、このアプリの利用者の表に登録されている人だけです。あなたはまだ登録されていません。",
    hint:
      "利用者の表にあなたの行を1件足すと作れるようになります。足せるのは運営者だけです" +
      "(あなた自身が運営者なら、自分で足せます)。" +
      "足すときに書くのはログイン名ではなく利用者IDです —— ログイン名を書いた行では、この断りは変わりません。",
  };
}

/**
 * **作った人に権限が1つも渡らない設定の表への作成を拒む(400)。** `V7-M3-T02`。
 *
 * **当たるのは2つの場合である**: (1) 付与を書き込む先が宣言から決まらない /
 * (2) 作成者に渡すと宣言した権限名が、読む・書く・消すのどれも与えない。
 * **どちらも通すと「作った本人にも見えない行」が生まれる** —— **fail-closed に倒す。**
 */
function creatorGrantUnreachableError(): ValidationError {
  return {
    path: "",
    message: "この表は、行を作った人に権限が1つも渡らない設定になっているため、行を作れません。",
    hint: "アプリを作った人に、行を作った人へ渡す権限の設定を見直してもらってください。",
  };
}

/**
 * **元になる行に書けないので、その行を作れない(403)。** `V15-M2-T05` / `CR-G1` /
 * `ADR-0404`。
 *
 * **判定そのものは `owner-scope.ts` の `judgeCreateParentAccess` 1本が持つ**
 * (`ADR-0061` 限定4)—— **ここにあるのは、判定結果を HTTP の応答文へ翻訳することだけである。**
 *
 * **【文面の作法。`ADR-0404` 限定9 が固定している】** —— **内部の記号を1文字も出さない**
 * (宣言のキー名 / 表ID / 述語名 / 審査単位の記号)。**`ValidationError` に5キー目を
 * 足していない。**
 *
 * **【したがって診断にならない。丸めない】** —— **「どの元の行に書けないのか」を本文に
 * 1文字も書けない**(表IDが内部記号だからである。`src/server/not-a-member-guidance.test.ts`
 * の (B-1) が禁止語にしている)。**`ADR-0404` §6 の 4 が、書けるようにする提案を
 * 「越えてはならない線」として名指ししており、書くには改めて門A が要る。**
 *
 * **【文面で誇張しない】**
 *  - **止まったのはこの1件の作成だけである。** **行は1件も消えていないし、権限も1つも
 *    変わっていない。**
 *  - **運営ロールも同じ壁で止まる**(前提の関門である)—— **「管理者に頼めば作れる」とは
 *    書かない。** **要るのは元の行への権限であって、役割ではない。**
 */
function forbiddenCreateParentAccessError(): ValidationError {
  return {
    path: "",
    message:
      "この表の行は、元になる行に書き込める人だけが作れます。あなたには、指定された元の行を書き換える権限がありません。",
    hint: "元になる行の権限を持っている人に、あなたへその行の書き込みの権限を渡してもらってください(役割を変えても作れるようにはなりません)。",
  };
}

/**
 * **元になる行には書けるが、アプリが名指しした種類の権限を持っていないので作れない(403)。**
 * `V15-M6B-T03` / `CR-G2` の判定側 / `ADR-0404`。
 *
 * **判定そのものは `owner-scope.ts` の `judgeCreateParentAccess` 1本が持つ**
 * (`ADR-0061` 限定4)—— **ここにあるのは、判定結果を HTTP の応答文へ翻訳することだけである。**
 *
 * **【なぜ3本目の文面を作ったか。実測が理由である】** —— **着手前、この場合には上の
 * {@link forbiddenCreateParentAccessError} がそのまま返っていた。** **その本文は
 * 「あなたには、指定された元の行を書き換える権限がありません。」であり、**事実として偽**で
 * あった** —— **実地(`docs/plan/v15/records/v15-m6.md` §2 の 7b)で、同じ人が同じ親の行を
 * `PATCH` して 200 を得ている。** **応答が嘘をつくと、受け取った人は「その行への書込権限を
 * もらう」という、直らない一手を取る。**
 * **`V15-M2` が `ungoverned_parent` に2本目を分けたのとまったく同じ理由である** ——
 * **次の一手だけが違うことを、内部記号を出さずに書き分けている。**
 *
 * **【文面の作法。`ADR-0404` 限定9 が固定している】** —— **内部の記号を1文字も出さない**
 * (宣言のキー名 / 表ID / 述語名 / 審査単位の記号)。**`ValidationError` に5キー目を
 * 足していない。** **したがって「どの種類の権限が要るのか」を本文に1文字も書けない**
 * —— **権限名はアプリが宣言した文字列であり、表IDと同じく内部記号だからである。**
 *
 * **【文面で誇張しない】**
 *  - **止まったのはこの1件の作成だけである。** **行は1件も消えていないし、権限も1つも
 *    変わっていない。**
 *  - **応答コードは 403 のままで、止まる人も1人も増減していない**(`V15-M6B` が変えたのは
 *    文面だけである)。
 *  - **運営ロールも同じ壁で止まる** —— **「管理者に頼めば作れる」とは書かない。**
 */
function forbiddenNamedPermissionMissingError(): ValidationError {
  return {
    path: "",
    message:
      "この表の行は、元になる行に対してアプリが決めた種類の権限を持つ人だけが作れます。あなたは元になる行を書き換えられますが、その種類の権限を持っていません。",
    hint: "元になる行の権限を渡せる人に、この表が求めている種類の権限をあなたへ渡してもらってください(どの種類が要るかはアプリを作った人が決めています。書き込みの権限を持っているだけでは作れません)。",
  };
}

/**
 * **元になる行の側で、誰が何をできるかが決まっていないので作れない(403)。** `V15-M2-T05` /
 * `CR-G3` / `D-V15-6`(fail-closed)。
 *
 * **【なぜ通さないか】** —— **権限を宣言していない表への判定は「この判定は何も絞らない」を
 * 返す。** **それを作成の関門で通すと、宣言していない親を1つ挟むだけで壁が丸ごと消える**
 * (読取の側が同じ理由で打ち切っている。`src/server/access-control-inheritance.test.ts` の (D))。
 *
 * **【代金を隠さない】** —— **この形のアプリでは、持ち主(`owner`)を含む誰も、その表に
 * 行を作れなくなる。** **その形を作らせない適用時検査は今日1本も無いので、差分は今日どおり
 * 通り、行を作れなくなる日だけが後から来る**(`ADR-0404` `S3` (2) の3)。
 *
 * **【断りを2つに分けた理由。判断と理由を書く】** —— **上の
 * {@link forbiddenCreateParentAccessError} と同じ文面にすると、アプリを作る人が
 * 「権限を渡せば直る」と読む。** **こちらは誰に何を渡しても直らず、直せるのはアプリの
 * 設定だけである。** **内部記号を出さずに、次の一手だけが違うことを書き分けている。**
 */
function forbiddenUngovernedParentError(): ValidationError {
  return {
    path: "",
    message:
      "この表の行は、元になる行の側で「誰が何をできるか」が決められていないため、今は誰も作れません。",
    hint: "アプリを作った人に、元になる行を持つ表にも権限の設定を入れてもらってください(権限を渡しても、この断りは変わりません)。",
  };
}

/**
 * **行を作るときの「親の行へ書けるか」の判定を、HTTP の応答へ翻訳する**(`V15-M2-T04` /
 * `CR-G6`。`ADR-0404` §Decision の 8)。
 *
 * **通す場合は `null` を返す。** **止める場合は本文と応答コードを返す。**
 * **書き方は先に在る {@link grantWriteDenial} と同じ形である** —— **判定は1つも行わず、
 * 4つの状態を応答へ写しているだけである。**
 *
 * **【`V15-M6B-T03` による訂正。上の行を1バイトも消していない】** —— **「4つの状態」は
 * 今日は偽である。** **写すのは **5つ**であり、5つ目が
 * {@link forbiddenNamedPermissionMissingError}(親には書けるが、名指しの権限名が無い)である。**
 * **判定は今日も1つも行っていない** —— **`owner-scope.ts` の述語が返した `kind` を、
 * 応答へ写しているだけである**(`ADR-0404` 限定1・限定13)。
 *
 * **応答コードの決め方**(`v15-m0.md` §5-1 の表 / `ADR-0404` §Decision の 3 の答え2):
 *  - **段数・行数の上限に当たった → 400 + 既存の `recordAccessLimitError`**
 *    (**新しいエラーの形を1つも作らない**)。
 *  - **親に書けない → 403。**
 *  - **親の表が宣言していない → 403**(fail-closed。**文面だけを分ける**)。
 *
 * **【3状態にしても、循環していることは応答から読めない】** —— **5段を超える環は段数の
 * 上限として現れる**(`ADR-0298` §限界。**本 MS はそれを解消しない**)。
 */
function createParentDenial(
  verdict: CreateParentAccessVerdict,
): { readonly errors: ValidationError[]; readonly status: 400 | 403 } | null {
  if (verdict.kind === "allowed") {
    return null;
  }
  if (verdict.kind === "limit_exceeded") {
    return { errors: [recordAccessLimitError(verdict.limit)], status: 400 };
  }
  if (verdict.kind === "ungoverned_parent") {
    return { errors: [forbiddenUngovernedParentError()], status: 403 };
  }
  if (verdict.kind === "missing_named_permission") {
    return { errors: [forbiddenNamedPermissionMissingError()], status: 403 };
  }
  return { errors: [forbiddenCreateParentAccessError()], status: 403 };
}

/**
 * **行は作れたのに、作成者への付与を書けなかったときの応答(500)。** `V7-M3-T02`。
 *
 * **【正直に書く。ここは補償していない】** —— **付与の書込は行の作成と同じ
 * トランザクションに入っていない**(作成できた行の `_id` が決まらないと付与を書けないため)。
 * **したがってこの応答が返ったとき、行は残り、その行は誰にも見えない。**
 * **消して戻す処理を1バイトも書いていない。**
 */
function creatorGrantWriteFailedError(): ValidationError {
  return {
    path: "",
    message:
      "行は作成しましたが、作成者への権限を付けられませんでした。この行は今、誰にも見えない状態です。",
    hint: "アプリの管理者に連絡してください。権限を記録する表の設定が原因の可能性があります。",
  };
}

/**
 * **付与を作れるのは行の作成者と運営ロールだけである、を伝える(403)。** `Z-G5` /
 * `V7-M3-T03` / `D-V7-14`。
 *
 * **判定そのものは `owner-scope.ts` の `judgeGrantWrite` 1本が持つ**(`ADR-0061` 限定4)——
 * **ここにあるのは、判定結果を HTTP の応答へ翻訳することだけである。**
 *
 * **【文面で誇張しない】** —— **止まったのは HTTP の書込3経路とバッチだけである。**
 * **MCP / 受信口 / ワークフロー / 島は今日も同じ表に書ける**(`Z-G21`〜`Z-G24`)。
 * **誰が権限を持っているかを応答に列挙しない**(付与の一覧が漏れる)。
 */
/**
 * **参加者の表・グループの表そのものへの書込を、運営者以外に通さないことを伝える(403)。**
 * `V8-M19` / `J-G33` / `D-V8-28` / `U-2`。
 *
 * **判定そのものは `owner-scope.ts` の `judgeGrantWrite` 1本が持つ**(`ADR-0061` 限定4)——
 * **ここにあるのは、判定結果を HTTP の応答へ翻訳することだけである。**
 *
 * **【文面で誇張しない】** —— **止まったのは HTTP の書込3経路とバッチだけである。**
 * **MCP / 受信口 / ワークフロー / 島は今日も同じ表に書ける**(`V8-M21` の担当)。
 * **読取は1ミリも絞っていない** —— **参加者の表は今日も誰でも一覧できる。**
 */
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

function forbiddenGrantWriteError(): ValidationError {
  return {
    path: "",
    message: "この行の権限を他の人に渡せるのは、この行を作った人と運営者だけです。",
    hint: "この行を作った人か、アプリの運営者に頼んでください。",
  };
}

/**
 * **自分に権限を付ける要求を拒む(403)。** `V7-M3-T03`。
 *
 * **運営ロールも例外にしない**(判断と理由は `docs/plan/v7/records/v7-m3.md` §2-3)。
 *
 * **【正直に書く】** —— **これは権限昇格を塞いでいない。** **自分の属するグループへの付与は
 * 今日も作れ、メンバー表への書込も1ミリも絞っていない。**
 */
function forbiddenSelfGrantError(): ValidationError {
  return {
    path: "",
    message: "自分に権限を付けることはできません。",
    hint: "他の人やグループに権限を渡すことはできます。自分の権限は、この行を作った人か運営者に付けてもらってください。",
  };
}

/**
 * **権限を渡す相手が、利用者の表(またはグループの表)の行として解決できない(400)。**
 * `V7-M3-T03` / `ADR-0016` 却下 (iv)(逐語「他人の id を詰めて送る spoof で任意の行を
 * 他人名義にできる / 自分名義に奪える」)。
 *
 * **クライアントが送った id を信用せず、サーバが実在を確かめた結果である。**
 */
function unknownGrantHolderError(): ValidationError {
  return {
    path: "",
    message: "権限を渡す相手が、このアプリの利用者として登録されていません。",
    hint: "先に相手を利用者として登録するか、実在するグループを選んでから、もう一度試してください。",
  };
}

/**
 * **相手が、引き継ぎ元(`inherit_from`)の親の行を読めないときに拒む(403)。**
 * `Z-G33` / `V7-M3-T04` / 依頼文 `L6`(逐語「issue はプロジェクトへのアクセス権限がある人しか
 * アサインできない」)。
 *
 * **判定そのものは `owner-scope.ts` の `judgeGrantWrite` 1本が持つ。**
 *
 * **【文面で誇張しない】** —— **止めたのは書込の時点だけである。** **書いたあとに相手が
 * 親の権限を失っても、この付与は残る**(`v7-m0.md` §6-2 の `Z-G33` `S3` の1)。
 * **どの行が親なのか・誰が権限を持っているのかを応答に列挙しない。**
 */
function forbiddenGrantParentAccessError(): ValidationError {
  return {
    path: "",
    message: "この相手は、元になっている行を見る権限を持っていないため、ここには追加できません。",
    hint: "先に元の行の権限をこの相手に渡してから、もう一度試してください。",
  };
}

/** **どの行への権限かが決まらない付与を拒む(400)。** `V7-M3-T03`(fail-closed)。 */
function unknownGrantTargetError(): ValidationError {
  return {
    path: "",
    message: "どの行に対する権限なのかが決まらないため、権限を渡せません。",
    hint: "権限を渡したい行を選んでから、もう一度試してください。",
  };
}

/**
 * 直接作成の遮断を宣言した表への `POST` / `/batch` の create op を拒む(403)。
 * `E-G49` / `V4-M10-T04` / `ADR-0077` 限定3。
 *
 * **判定そのものは `owner-scope.ts` の `isDirectCreateSuppressed` 1本が持つ**(限定6)。
 * **宣言フィールドの id をここに書かない** —— `ADR-0061` 限定4 の走査(`owner-scope.test.ts`
 * の `(V3-M8-T01 j)` と同型)が「宣言の名前が `owner-scope.ts` 以外の非テスト製品コードに
 * 現れない」ことを固定しているためである。
 *
 * **止めるのは create だけである** —— `PATCH` / `DELETE` / `/batch` の update op は1バイトも
 * 変わらない(「作れない」と「直せない」「消せない」は別の要求である)。
 */
function forbiddenDirectCreateError(tableId: string): ValidationError {
  return {
    path: "",
    message: `テーブル "${tableId}" は、画面や API から直接レコードを作れないと宣言されています。`,
    hint:
      "この表の行は、決められた自動処理(ワークフロー / run_function)を通してだけ作られます。" +
      "読み取り・更新・削除は今日どおりできます。",
  };
}

// **【`V8-M20` / `J-G28`】`forbiddenFieldWriteError`(項目単位の書込制御 `writable_by` による
// 403)を撤去した。** **代わりに立つのは下の `forbiddenRoleAccessError`** ——
// **役割 x 対象(項目)x 書込。** **手続きは `ADR-0301`。**

/**
 * **面の層の名前**(`V8-M39` / 台帳 `F-G8`)。
 *
 * **綴りを手で書かずに `AccessLayerName`(`src/server/owner-scope.ts` の
 * `"role" | "grant"`)で型を付けている** —— **層の名前が増減した日に、この定数が
 * 型検査で落ちる側にしておくためである。** **値そのものは1語ちょうどであり、
 * 判定を行う述語を1本も増やしていない。**
 */
const ROLE_ACCESS_LAYER: AccessLayerName = "role";

/**
 * **面(役割に束ねた権限)が止めた**(403)。`V8-M17` / 台帳 `J-G6`〜`J-G11`。
 *
 * **判定そのものは `owner-scope.ts` の `judgeRoleAccess` 1本が持つ** —— ここにあるのは、
 * 判定結果を HTTP の応答へ翻訳することだけである(`ADR-0076` の先例と同じ分担)。
 *
 * **【文面で「拒否された」と書かない】** **面には引き算(deny)の値域が1つも無い**
 * (`J-G2` の限定)—— **止まったのは「この役割にその動詞が書かれていないから」であって、
 * 誰かが明示的に禁じたからではない。** **直し方は「役割の規則を足す」だけである。**
 *
 * =====================================================================================
 * **【`V8-M39` / 台帳 `F-G8`(限定採用・門外 `Δ7`)。止めた層を文面に出す】**
 * =====================================================================================
 *
 * **`v8-m35.md` §5-1 の限定の逐語**: 「**文面にだけ出す。`ValidationError` の4キーを
 * 動かさない。403 のときだけ**(404 と空一覧には出さない)」。
 *
 * **【着手前の `message` の逐語。1バイトも消していない】**
 *
 *     message: `${what} に対する${verb}は、あなたの役割に許されていません。`,
 *
 * **形は既に在る3箇所から写した** —— **`src/server/inbound-route.ts` の
 * `` `書き込む権限がありません(止めた層: ${combined.blockedBy.join(" / ")})。` `` /
 * `src/kernel/workflow-runner.ts` の2箇所。** **新しい表現を1つも発明していない。**
 * **層の名前は英字のままである**(既存3箇所が `AccessLayerName` の値をそのまま
 * `join(" / ")` して出しており、日本語に訳している箇所は1つも無い)。
 *
 * **【`ValidationError` に5キー目を足していない】** —— **層の名前は `message` の中の
 * 文字列であって、機械可読な欄ではない。** **`src/kernel/errors.ts` は1バイトも変えていない。**
 * **したがって `ADR-0308` 限界6 の逐語「**機械可読な層の名前は今日も載せていない**」は
 * 今日も真である。**
 *
 * **【本関数は面(`role`)専用である。だから層は定数で足りる】** —— **`owner-scope.ts` の
 * `AccessLayerName` は `"role" | "grant"` の2値だが、この応答体を組み立てる呼び出しは
 * 今日すべて面の判定(`judgeRoleAccess` / `roleGateBlocksWithoutGrants` /
 * `isRoleActionWriteAllowed` / `judgeRoleFieldWrite`)の直後にある。** **点(`grant`)が
 * 止めた 403 はこの関数を1度も通らない**(`forbiddenRecordWriteError` /
 * `forbiddenRecordDeleteError` が別に立つ)。**述語の戻り値の型を1つも変えず、
 * 判定を行う述語も1本も増やしていない**(`F-G7` の限定「判定の家を増やさない」)。
 *
 * **【正直に書く。`F-G8` が塞いでいない側】** —— **点(`grant`)が止めた 403 の文面には、
 * 今日も層の名前が1文字も出ていない。** **`ADR-0308` 限界6 が塞がったのは「面が止めた
 * 403」だけである。**
 */
function forbiddenRoleAccessError(what: string, verb: string): ValidationError {
  return {
    path: "",
    message: `${what} に対する${verb}は、あなたの役割に許されていません(止めた層: ${ROLE_ACCESS_LAYER})。`,
    hint:
      "アプリの役割の一覧(roles)で、この対象にその操作を許す規則(rules)を持つ役割が要ります。" +
      "規則は足すことしかできません(拒否は書けません) —— set_roles で役割に規則を足してください。",
  };
}

/**
 * customer が運営テーブル(st_owner も st_public も無いテーブル)を GET しようとした(403)。
 * V2-M1-T03 / ADR-0033 限定5。未認証(401)や権限不足の書込(forbiddenWriteError)と区別する
 * ―― これは「ログインはしているが、このテーブルは顧客に閲覧を許していない」。
 */
// --- 【`V8-M27-T04` / `T-G5`】この応答体は**撤去した**。**上の説明文を1バイトも消していない** ---
//
// **ここに在ったもの(逐語)**:
//
//     function forbiddenNonAdminReadError(): ValidationError {
//       return {
//         path: "",
//         message: "このテーブルの閲覧は許可されていません。",
//         hint: "顧客(customer)が閲覧できるのは、自分の行を持つテーブルと公開テーブルだけです。運営用のテーブルは閲覧できません。",
//       };
//     }
//
// **呼び出し元が0本になったので消した。** **唯一の呼び出しは `recordsAuthMiddleware` の
// 非運営分岐であり、そこごと撤去した。**
//
// **【この文面が消えたことの代償。隠さない】** **読めない表の `GET` は今日 403 を返さない** ——
// **一覧は「200 + 0件」、単件は 404 である**(`ADR-0305` 限定11)。**したがって
// 「なぜ見えないのか」を告げる文面が応答から消えた。** **`V3-M0` の審査記録が
// `D-M3-1` について書いた緊張(「隠すと『無い』と『見えない』が区別できなくなる」)が、
// サーバの応答の側にも及んだ形である。**

/**
 * **システムが持つ表を、持ち主(`owner`)でない相手が読もうとした(403)。**
 * **ユーザ決定 `D-V8-74`(2026-08-11)。`V8-M27` / 台帳 `T-G5` の副作用を塞ぐ1本。**
 *
 * **上の `forbiddenNonAdminReadError` の跡地にわざとこれを置いている** —— **撤去した層が
 * 偶然塞いでいた3本(`_apps` / `_changelog` / `_ai_usage`)を、今度は**名指しの限定で**
 * 塞ぎ直すからである。** **読む人が跡地から本体まで1画面で辿れるようにする。**
 *
 * ## **なぜ 403 なのか(`ADR-0305` 限定11 の作法を採らなかった。決めた理由を書く)**
 *
 * **`ADR-0305` 限定11 は「一覧は応答から落とし、単件は 404 で伏せる」と定める。**
 * **その目的は「**その表が在ること**を役割の外へ漏らさない」ことである** —— **アプリの表の
 * 識別子は**アプリの作者が付けた名前**であり、在ることを知られるだけで内部の作りを
 * 教えてしまう場合がある。**
 *
 * **システムが持つ表は違う。** **在ることが**製品の仕様として公開されている**:**
 *
 *  1. **`src/shared/system-tables.ts` は**フロントエンドが値として import** している**
 *     (`web/src/table-resolution.ts` が `isSystemTableId` をそのまま再 export する)——
 *     **ブラウザに配るバンドルに3本の綴りが入っている。**
 *  2. **画面の実装(`web/src/views/DetailViewRenderer.tsx`)が `isSystemTableId` で
 *     読み取り専用の表示に切り替える** —— **UI が名前を知っている前提で書かれている。**
 *  3. **書込は今日も 400「読み取り専用」で返る**(下の `resolved.system` の3箇所)——
 *     **`POST` すれば表が在ることは誰にでも分かる。** **`GET` だけ伏せても筋が通らない。**
 *
 * **したがって伏せても何も守れず、「なぜ見えないのか」を告げる文面だけが失われる。**
 * **`forbiddenNonAdminReadError` を消したときに払った代償(直上の段落)を、
 * ここでは払わない側に倒した。**
 *
 * ## **【正直に書く】この文面はロールの綴りを1語持っている**
 *
 * **`hint` に `owner` と書いてある。** **`V8-M27` は「運営か否か」の層をアプリの表から
 * 撤去したが、**システムの表についてだけ役割の綴りを見る判定が1つ残る**
 * (`D-V8-74` が自らそう述べている)。** **【禁止】総括に「役割の綴りを見る判定を
 * 全部なくした」と書かない。** **書けるのは「アプリの表からは無くなった」までである。**
 *
 * **`allowed_values` は持たせない** —— **撤去した `forbiddenWriteError` の
 * `allowed_values: ["editor","owner"]` は「役割はアプリが宣言する」という今日の形と
 * 噛み合わなかった。** **同じ形を作り直さない。**
 */
function forbiddenSystemTableReadError(tableId: string): ValidationError {
  return {
    path: "",
    message: `システムが持つ表 "${tableId}" を読めるのは、このアプリの持ち主(owner)だけです。`,
    hint:
      "変更履歴・アプリ一覧・AI 利用量は、アプリの定義を変えられる人だけが読めます。" +
      "役割の規則(rules)を書いても開きません —— システムが持つ表は役割の規則の管轄外です。",
  };
}

// --- 名乗られた画面の検査(`?view=<view_id>`)-------------------------------------------
//
// **渡し方はクエリパラメータ `?view=<view_id>` である**(未決 A-9 の決着。
// `docs/plan/v4/records/v4-m3-t01.md`)。
//
// **【`V8-M20` / `J-G27`】画面ごとの「見せる相手」(`view.audience`。`ADR-0070`)は撤去した。**
// **今日ここに残っているのは「実在するか」「URL の表と一致するか」の2つだけであり、
// 「その相手に見せるか」の判定は面(`judgeRoleAccess` の `target: "view"`)が持つ。**
//
// **【この判定が遮断しないもの。誇張しない】**
//   - **`?view=` を渡さない要求は今日どおり通る**(`ADR-0070` 限定4 と同じ形が面にも残る)。
//   - **`GET /api/apps/:app_id/manifest` は未ログインで全ビュー定義を返し続ける**(限定7)。
//   - **MCP / ワークフロー / 島 / バッチ書込は `?view=` を渡さないので1ミリも守られない**(限定8)。

/** 名乗られた画面が実在しない(400)。**黙って素通りさせない。** */
function unknownViewError(viewId: string): ValidationError {
  return {
    path: "",
    message: `画面 "${viewId}" はこのアプリに存在しません。`,
    hint: "GET /api/apps/<app_id>/manifest で実在する画面IDを確認してください。view を省略すれば画面の宣言は判定に使われません。",
  };
}

/** 名乗られた画面の対象テーブルが URL のテーブルと食い違う(400)。 */
function viewTableMismatchError(viewId: string, viewTableId: string, tableId: string) {
  return {
    path: "",
    message: `画面 "${viewId}" が対象とするテーブルは "${viewTableId}" で、URL のテーブル "${tableId}" と一致しません。`,
    hint: "画面IDと URL のテーブルIDを合わせてください。別の画面を名乗って別のテーブルを読むことはできません。",
  } satisfies ValidationError;
}

// **【`V8-M20` / `J-G27`】`forbiddenViewAudienceError`(画面の「見せる相手」による 403)を
// 撤去した。** **代わりに立つのは `forbiddenRoleAccessError`** —— **役割 x 対象(画面)x 読取。**
// **手続きは `ADR-0301`。**

// --- 手動起動の入口のエラー(`V5-M25-T05` / `L-G12` / `ADR-0176`)---------------------

/**
 * **監査記録(`_auth_activity`)に書く4つ目の `action` の綴り**(ユーザ決定 `D-V5-83`)。
 *
 * **`create_record` / `update_record` / `delete_record` の3値に4値目を足した。**
 * **綴りを `run_workflow` にしていない** —— **それは `DIFF_OPS` に足してはならないと
 * 名指しされている op 名であり**(`ADR-0013` 限定2 / `ADR-0174` 限定6)、
 * **同じ綴りが「差分の op ではない」と「監査の action である」の2つの意味を持つと、
 * 読む側が取り違える。**
 *
 * **【この値域の拡張はどの門A審査も通っていない。隠さない】**
 * **`V5-M20` の審査は `L-G11b`(押した人を記録に残す)を**保留**にした。**
 * **`D-V5-83` はその保留を覆さずに「別の場所に残す」を選んだユーザ決定であり、
 * 本定数はその実装である。** **`ActivityAction` は `RESOURCE_KINDS` /
 * `FIELD_TYPES` / `DIFF_OPS` のどれでもないので `ADR-0007` の `Δ1` には当たらないが、
 * **値域が1つ増えたことは事実である。** **記録に実数で書く**
 * (`docs/plan/v5/records/v5-m25.md` §3)。
 */
const MANUAL_RUN_ACTIVITY_ACTION = "manual_run" as const;

/**
 * その画面に置かれた**自動処理を起こす操作起点**(4形目)だけを取り出す。
 *
 * **`View` は3種の合併で、`form` は `actions` を1つも持たない**(schema が
 * `"actions": false,` で閉じている。`ADR-0171` 限定3)。**ここで narrowing を1箇所に
 * 閉じ込め、入口の判定から形の詮索を追い出す。**
 * **【`V8-M20` / `J-G29`】`audience` を持ち回るのをやめた** —— **ボタンの「見せる相手」は
 * 撤去され、面(`judgeRoleAccess` の `target: "action"`)が `id` で名指しして判定する。**
 */
function declaredRunActions(view: View): { run: string; id?: string }[] {
  const actions = (view as { actions?: unknown[] }).actions ?? [];
  return actions.filter(
    (action): action is { run: string; id?: string } =>
      typeof action === "object" && action !== null && "run" in action,
  );
}

/**
 * その画面に置かれた **`set` 型の操作起点(2形目 = 値の書換)** を、識別子で1つ引く
 * (`V8-M38` / `F-G6` / 裁定 `F-11` / 本審査 `docs/plan/v8/records/v8-m35.md` §5-2)。
 *
 * ## **なぜ足したか**(**`declaredRunActions` を1バイトも書き換えていない**)
 *
 * **着手前、`run` の口は `declaredRunActions` の一致だけを見ていたので、`set` 型の
 * ボタンを名指しした要求は `manualRunNotDeclaredError` の 400 で落ちていた** ——
 * **ボタンの面の判定(`judgeRoleAccess` の `target: "action"`)に1度も到達せず、
 * **そのボタンの規則を持つ人と持たない人の応答が1バイト違わなかった**
 * (`docs/plan/v8/records/v8-m35-prestate-m33.md` §C-2 の (2a) / (2b) が実測)。
 *
 * **`declaredRunActions` を広げなかった理由は1つである** ——
 * **戻り値の `run` を `declaredRuns`(= `allowed_values` の中身)にそのまま使っており、
 * 広げると「起こせる自動処理の一覧」に自動処理でないものが混ざる。**
 * **`allowed_values` の中身は着手前と1バイトも変わっていない。**
 *
 * ## **射程を `set` 型に限っている**(本審査 §5-2 の逐語に従う)
 *
 * **`form + prefill`(遷移)と `view`(行き先の宣言)の2形は、今日も着手前と同じ 400 に
 * 落ちる。** **同じ形の穴が残っていることを隠さない**(`manual-trigger-route.test.ts`
 * の (F) 群の doc)。
 *
 * **識別子(`id`)を書いていない `set` 型のボタンは引けない** —— **`workflow` に渡せる
 * 文字列が1つも無いためである**((C-3) が `run` 型について測っている穴と同じ形)。
 */
function declaredSetActionById(view: View, actionId: string): { id: string } | undefined {
  const actions = (view as { actions?: unknown[] }).actions ?? [];
  return actions.find(
    (action): action is { id: string } =>
      typeof action === "object" &&
      action !== null &&
      "set" in action &&
      !("run" in action) &&
      (action as { id?: unknown }).id === actionId,
  );
}

/** 起動する自動処理と対象行のどちらかが指定されていない(400)。 */
function manualRunMissingParamsError(declaredRuns: readonly string[]): ValidationError {
  return {
    path: "",
    message: "起動する自動処理(workflow)と対象の行(record)を1つずつ指定してください。",
    allowed_values: [...declaredRuns],
    hint: "この入口は押した行1行だけを対象にします。複数行をまとめて起こすことはできません。",
  };
}

/**
 * その画面が宣言していない自動処理を起こそうとした(400)。
 *
 * **「どのワークフローでも起こせる」を作らない**(`ADR-0174` 限定2)——
 * **起こせるのは、その画面の操作起点に書かれているものだけである。**
 */
function manualRunNotDeclaredError(
  viewId: string,
  workflowId: string,
  declaredRuns: readonly string[],
): ValidationError {
  return {
    path: "",
    message: `画面 "${viewId}" には、自動処理 "${workflowId}" を起こすボタンが1つも置かれていません。`,
    allowed_values: [...declaredRuns],
    hint: "画面の操作起点(actions の run)に書かれている自動処理だけを起こせます。",
  };
}

/**
 * **`set` 型のボタン(値の書換)を、自動処理を起こす入口で名指しした(400)。**
 * (`V8-M38` / `F-G6`。本審査 `docs/plan/v8/records/v8-m35.md` §5-2 の限定2)
 *
 * **この 400 は、ボタンの面の判定を**通った**相手にだけ返る** ——
 * **通らない相手は1段手前の 403 で断られる**(判定の順序: 宣言の確認 → 面の判定 →
 * 起こせるかの確認)。
 *
 * **`ValidationError` の4キー(`path` / `message` / `allowed_values` / `hint`)を
 * 1つも増やしていない。** **`allowed_values` の中身は `manualRunNotDeclaredError` と
 * 同じ「その画面の `run` 型の一覧」である**(着手前と1バイトも変えていない)。
 *
 * **【禁止】これを「`set` 型のボタンが起こせるようになった」と読まない** ——
 * **`set` 型はワークフローを持たないので、この口からは今日も1度も走らない。**
 * **`ADR-0174` 限定2 / 限定4(引数を1つも受けない / その画面の操作起点に書かれている
 * ものだけ)を1バイトも動かしていない。**
 */
function manualRunNotRunnableActionError(
  viewId: string,
  actionId: string,
  declaredRuns: readonly string[],
): ValidationError {
  return {
    path: "",
    message: `画面 "${viewId}" のボタン "${actionId}" は、項目に値を入れるボタンであり、自動処理を起こすボタンではありません。`,
    allowed_values: [...declaredRuns],
    hint: "この入口が起こせるのは、画面の操作起点に run(自動処理)として書かれているボタンだけです。項目に値を入れるボタンは、画面から押してください(押すと通常のレコード更新として処理されます)。",
  };
}

/** `manual` と宣言されていない自動処理を起こそうとした(400)。 */
function manualRunNotManualError(
  workflowId: string,
  declaredRuns: readonly string[],
): ValidationError {
  return {
    path: "",
    message: `自動処理 "${workflowId}" は、画面のボタンから起こせる設定になっていません(発火条件が manual ではありません)。`,
    allowed_values: [...declaredRuns],
    hint: "作成時・更新時・時刻をきっかけにする自動処理を、手動で起こすことはできません。",
  };
}

/**
 * 同じ自動処理を同じ行に対して重ねて起こそうとした(409。`ADR-0175` §6-2)。
 *
 * **【禁止】この 409 を「二重押しが防げる」と読まない**(`ADR-0175` §限界2)——
 * **断るのは処理が重なったときだけで、1本目が終わってから押せば2回目は普通に走る。**
 */
function manualRunInProgressError(workflowId: string, recordId: string): ValidationError {
  return {
    path: "",
    message: `自動処理 "${workflowId}" は、この行(${recordId})に対して今まさに実行中です。`,
    hint: "終わるまで待ってから、もう一度押してください(終わってから押せば普通に動きます)。",
  };
}

// --- アップロード(V2-M2-T02 / ADR-0035 §1・限定5)---------------------------------

/**
 * allowlist 外の MIME(415)。申告 mime か、マジックナンバー判定が allowlist 外/不一致のとき。
 *
 * **【`V5-M16-T06` / `G-G14`】この 415 が起きるのは `kind=image` のときだけである。**
 * **`kind=file`(一般のファイル)では、受け入れる種類の制限が0件なので 415 を1度も返さない**
 * (`D-V5-84`)。**hint から「商品画像」という前提を外した** —— **画像の項目は商品に限らない。**
 */
function unsupportedImageMimeError(declared: string | undefined): ValidationError {
  return {
    path: "",
    message: `画像として受け取れるのは ${ALLOWED_IMAGE_MIME.join(" / ")} だけです。${
      declared !== undefined ? `受け取った種別: ${JSON.stringify(declared)}。` : ""
    }`,
    allowed_values: [...ALLOWED_IMAGE_MIME],
    hint: "画像(kind=image)は JPEG / PNG / WebP / GIF のいずれかで、種別の申告と実体(先頭バイト)が一致している必要があります。種類を問わず添付したいときは kind=file で送ってください(こちらは種類を制限しませんが、配信は必ずダウンロードになります)。",
  };
}

/**
 * サイズ上限超過(413)。
 *
 * **上限は入口ごとに違う**(`V5-M16` / `ADR-0161` 限定2 / 限定7)——
 * `kind=image` は 5 MiB、`kind=file` は 20,000,000 バイト。
 */
function payloadTooLargeError(size: number, kind: UploadKind): ValidationError {
  const limit = kind === "image" ? MAX_UPLOAD_BYTES : MAX_FILE_UPLOAD_BYTES;
  return {
    path: "",
    message: `ファイルサイズ(${size} バイト)が上限(${limit} バイト)を超えています。`,
    hint:
      kind === "image"
        ? `画像は ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MiB 以下にしてください。`
        : `添付は ${MAX_FILE_UPLOAD_BYTES} バイト以下にしてください。`,
  };
}

/** `kind` パートの値域外(422)。 */
function unknownUploadKindError(kind: string): ValidationError {
  return {
    path: "/kind",
    message: `アップロードの種類 ${JSON.stringify(kind)} は指定できません。`,
    allowed_values: [...UPLOAD_KINDS],
    hint: "kind は image(画像。4種の画像だけを受け取り、公開行が参照していれば未認証にも配信します)か file(一般のファイル。種類を制限せず、配信は必ずダウンロードになります)のどちらかです。省略すると image になります。",
  };
}

/**
 * **ダウンロードとして返すための `Content-Disposition` ヘッダ値**(`V5-M16-T03`)。
 *
 * **ヘッダ注入を構造で塞ぐ。** ファイル名は利用者が決めるので、改行(CR / LF)・引用符・
 * 制御文字がそのまま入りうる。**そこで ASCII 側は「安全な文字だけを残した写し」にし、
 * 元の名前は RFC 5987 の `filename*=UTF-8''<percent-encoded>` で運ぶ**
 * (`encodeURIComponent` は CR / LF / `"` を必ず %XX に変えるので、注入は成立しない)。
 *
 * **名前が無い(`null`)ときは `filename` を1つも出さない** —— 出さないことと、
 * 空文字を出すことは違う。
 */
function attachmentDisposition(filename: string | null): string {
  if (filename === null || filename === "") {
    return "attachment";
  }
  // ASCII の安全な文字だけを残す(古いクライアント向けの写し)。空になったら省く。
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const quoted = ascii.trim() === "" ? "" : `; filename="${ascii}"`;
  return `attachment${quoted}; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** multipart の file パートが無い/読めない(422)。 */
function missingUploadFileError(): ValidationError {
  return {
    path: "/file",
    message: "アップロードするファイルが multipart/form-data の file パートにありません。",
    hint: 'multipart/form-data で name="file" のファイルパートを1つ含めてください。',
  };
}

/** Origin/Referer 不一致(403)。CSRF 多重防御(SameSite=Strict と合わせる)。 */
function originRejectedError(origin: string, expected: string[]): ValidationError {
  return {
    path: "",
    message: `リクエスト元 "${origin}" は許可されていません。`,
    allowed_values: [...expected],
    // **【2026-09-06】文面を実態に合わせた。`message` と `allowed_values` は1文字も
    // 変えていない。** 旧文は「同一オリジンからアクセスしてください(クロスサイトの
    // リクエストは拒否されます)。」だった —— **実地でこの 403 を踏むのは
    // `http://127.0.0.1:3000` で開いた本人であって、クロスサイトの攻撃者ではない。**
    // **本人から見れば同一オリジンなので、旧文を読んでも原因に辿り着けなかった。**
    hint:
      "ブラウザで開いているアドレスが、書き込みを許可している出所(allowed_values)と" +
      "一致していません。許可されている方のアドレスで開き直すか、環境変数 " +
      "ST_AUTH_EXPECTED_ORIGIN に開きたいアドレスを渡してサーバを起動し直してください。" +
      "127.0.0.1 は指定できません —— localhost で開いてください。",
  };
}

// --- 同時実行の保護(V1-M9-T02 / ADR-0017)---------------------------------------
//
// 楽観ロックの衝突(版不一致)は**カーネルが返す** `versionConflictError` をそのまま
// 使うので、HTTP と MCP の文面は定義上一致する。ここで定義するのは配線層でしか
// 生じない2つ ——「If-Match が無い」(HTTP 固有。MCP は if_match 引数)と「適用中」——
// である。**適用中エラーは MCP(`src/mcp/tools/write.ts`)と message/hint を完全一致させる
// 必要がある**(ADR-0003 §7)。両者は同一文字列を持ち、`src/mcp/tools/write.test.ts` の
// 一致 assert がドリフトを検出する。

/**
 * 適用中(apply 窓)エラー。HTTP 409 / MCP のどちらでも同一の message/hint を返す。
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

/** If-Match(期待する版)が無い場合の 400。HTTP 固有(MCP は if_match 引数の欠落として扱う)。 */
function missingIfMatchError(): ValidationError {
  return {
    path: "",
    message: "If-Match(期待する版)が必要です。",
    hint: "更新・削除するレコードの現在の版を If-Match ヘッダに指定してください。版は GET 応答の ETag ヘッダ、または本文の _updated_at で得られます。",
  };
}

/** Referer ヘッダからオリジン(scheme://host[:port])を取り出す。読めなければ undefined。 */
function refererOrigin(referer: string | undefined): string | undefined {
  if (referer === undefined) {
    return undefined;
  }
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}

// --- 存在確認(ADR-0003 §6)-----------------------------------------------------
//
// カーネルの `RecordResult` は「存在しない」と「値が不正」を型で区別しないため、
// HTTP として意味のあるステータス(404 と 400)を返すにはサーバ層で存在確認をする。
// 行うのは「実在するか」の単純な照合だけで、妥当性の判定は一切含まない。

/** アプリが台帳に存在しない場合のエラー。実在する app_id を allowed_values に載せる。 */
function unknownAppError(store: KernelMetaStore, appId: string): ValidationError {
  return {
    path: "",
    message: `アプリ "${appId}" は存在しません。`,
    allowed_values: store.listApps().map((app) => app.app_id),
    hint: "GET /api/apps で実在するアプリ一覧を取得できます。",
  };
}

/**
 * テーブルがマニフェストに存在しない場合のエラー。
 *
 * 文面(`message`)と `allowed_values` はカーネルの `unknownTableError` をそのまま使い、
 * HTTP 経由と MCP 経由で表現が割れないようにする。上書きするのは HTTP 固有の `hint` だけ。
 */
function unknownTableError(manifest: Manifest, tableId: string): ValidationError {
  return {
    ...kernelUnknownTableError(manifest, tableId),
    hint: "GET /api/apps/<app_id>/manifest で実在するテーブルIDを確認できます。",
  };
}

/**
 * file が存在しない/配信対象でない場合の 404(V2-M2-T03 / ADR-0035 §1c)。
 *
 * **存在秘匿**のため、公開行の未参照・非公開行の参照・`_files` 不在・file_id 不在のいずれでも
 * 同一文面を返す —— 未認証者が file_id を叩いて「在るが要認証(401)」と「不在(404)」を
 * 区別できると存在を列挙できてしまうので、区別しない側(一律 404)を選ぶ(§限界3/4)。
 */
function unknownFileError(fileId: string): ValidationError {
  return {
    path: "",
    message: `ファイル "${fileId}" は存在しないか、配信できません。`,
    hint: "公開行(st_public)の画像(image)は未認証でも配信されますが、添付(file)は未認証には1件も配信されません。非公開の行が参照するファイルと、どの行からも参照されていないファイルも配信されません。",
  };
}

/** レコードが存在しない場合のエラー。 */
function unknownRecordError(tableId: string, recordId: string): ValidationError {
  return {
    path: "",
    message: `テーブル "${tableId}" にレコード "${recordId}" は存在しません。`,
    hint: "一覧(GET .../records)で実在する _id を確認してください。",
  };
}

/**
 * 削除不可規約(`st_undeletable`)により `DELETE` を止めたときの応答(V4-M4-T05 / ADR-0073)。
 *
 * **403 ではなく 409 を返す** —— 止めているのは**行の状態**であって actor の権限ではない
 * (運営が叩いても止まる)。同ハンドラの 409 は既に「版不一致(CAS)」「適用中」に使われて
 * おり、いずれも「今の状態では実行できない」の意味である。**同じ意味の3本目である。**
 *
 * **`hint` に「取り消し」への案内を書く** —— `D-V4-2` 逐語「**消すのではなく『取り消し』に
 * する**」であり、**行を残したまま状態を動かす経路が在ることを、拒否と同じ場所で伝える。**
 */
function deleteProtectedRecordError(tableId: string, recordId: string): ValidationError {
  return {
    path: "",
    message: `テーブル "${tableId}" のレコード "${recordId}" は削除できません(削除不可の状態です)。`,
    hint: "この行は消さずに残ります。状態を変えるには、この行を更新(PATCH)できる権限を持つ運営に取り消しを申し込んでください。",
  };
}

/**
 * テーブル解決の結果を HTTP の応答に落とすための判定(ADR-0006 §7)。
 *
 * レコード系5ルートはこれまで `manifest.app.tables` を直接引いていたため、
 * システムテーブルに対して必ず「存在しません」を返していた。**`_apps` は存在する。
 * ただ書けないだけである**ので、「存在しない(404)」と「書けない(400)」を分ける。
 * 書き込み系はカーネルの `readOnlyTableError` をそのまま使い、HTTP 経由と MCP 経由で
 * 文面が割れないようにする(ADR-0003 §7)。
 */
type TableResolution =
  | { ok: true; table: Table; system: boolean }
  | { ok: false; status: 404; errors: ValidationError[] };

function resolveTableForRoute(manifest: Manifest, tableId: string): TableResolution {
  const table = resolveTable(manifest, tableId);
  if (table === undefined) {
    return { ok: false, status: 404, errors: [unknownTableError(manifest, tableId)] };
  }
  return { ok: true, table, system: isSystemTableId(tableId) };
}

/**
 * **未ログインへ開いた画面1枚を描くのに要る表の定義**(`V8-M26-T05` / 台帳 `T-G27b` /
 * ユーザ決定 `D-V8-57`。判定の再審査は `ADR-0319`)。
 *
 * **返すのは表の**定義**だけである。行(データ)は1行も入っていない** ——
 * **`D-V8-64` の逐語「その画面が使う表についても「ログインなしでも見せる」を1行書いて
 * 初めてデータが並びます」の線であり、行は今日どおりレコードの口が判定する。**
 *
 * **集めるのは2種だけである**(**名指しする。3種目を黙って足さない**):
 *   1. **その画面が載っている表**(`view.table`)。
 *   2. **その画面が子一覧として描く表**(`detail_view` の `related[].table`)。
 *
 * **【集めないもの。正直に書く】** **参照(`reference`)型の項目が指す先の表は集めていない。**
 * **したがって未ログインの公開画面では、参照の列は参照先の代表項目ではなく、今日どおり
 * 行IDのまま出る場合がある**(参照先の行は、参照先の表に `st_public` の窓が開いていなければ
 * そもそも読めない)。**集めれば「その画面を描くために要るものだけ」の線が1段広がるので、
 * ここでは広げていない**(台帳 `T-G27b` の限定4)。
 *
 * **判定を1つも持たない** —— **どの画面をこの関数に渡すかは呼び出し側の
 * `judgeRoleAccess` が決めており、ここに規則を読む条件式は1行も無い**(`ADR-0314` 限定4)。
 */
function publicTablesForView(manifest: Manifest, view: View): Table[] {
  const wanted: string[] = [view.table];
  for (const related of (view as { related?: { table?: unknown }[] }).related ?? []) {
    if (typeof related.table === "string") {
      wanted.push(related.table);
    }
  }
  const seen = new Set<string>();
  const tables: Table[] = [];
  for (const tableId of wanted) {
    if (seen.has(tableId)) {
      continue;
    }
    seen.add(tableId);
    const table = manifest.app.tables.find((candidate) => candidate.id === tableId);
    if (table !== undefined) {
      tables.push(structuredClone(table));
    }
  }
  return tables;
}

// --- クエリのデコード(ADR-0003 §5)---------------------------------------------

const SORT_ORDER_VALUES = ["asc", "desc"];
const FILTER_PREFIX = "filter.";
/**
 * ブール式フィルタ(EC-G12 / ADR-0043)を渡す口。URL では and/or/not のネストを
 * `filter.<field>=` の平坦形で表せないため、**構造化 filter は JSON 1個で受ける**。
 * `filter.<field>=`(等値の後方互換)と `filter=<JSON>`(ブール式)は排他。
 * ここで行うのは JSON の復元だけで、フィールド実在・値の型はカーネルが判定する。
 */
const FILTER_JSON_KEY = "filter";
/**
 * **合計を出す列を指す読取パラメータ**(`V4-M23-T02` / `ADR-0104` 限定3)。
 * **画面の `list_view.sum_field` を表示層がここへ翻訳して渡す**(`filter` / `sort` /
 * `limit` と同じ分担)。**渡さなければ応答に `sum` は1バイトも載らない。**
 */
const SUM_FIELD_KEY = "sum";

/**
 * `sort` / `order` / `filter.<field>` を `ListRecordsOptions` に写す。
 *
 * ここで行うのは「HTTP のテキスト表現を型付き値に戻す」トランスポート層のデコードだけ。
 * 値が妥当か(select の選択肢内か、reference 先が実在するか、そもそもそのフィールドが
 * あるか)の判定はカーネル(`listRecords`)の担当なので、ここでは触れない。
 * 未知のクエリパラメータは無視する(v0 の語彙に制御パラメータが無いため)。
 */
function parseListOptions(table: Table, params: URLSearchParams): RecordResult<ListRecordsOptions> {
  const errors: ValidationError[] = [];
  const fieldsById = new Map(table.fields.map((field) => [field.id, field]));

  // --- filter=<JSON>(ブール式。EC-G12 / ADR-0043)---
  // 値の妥当性(フィールド実在・型・演算子・深度)はカーネル(listRecords の compileFilter)が
  // 判定するので、ここでは JSON の復元だけを行う。壊れた JSON はトランスポート層の誤りとして弾く。
  let jsonFilter: FilterNode | undefined;
  const jsonFilterRaw = params.get(FILTER_JSON_KEY);
  if (jsonFilterRaw !== null) {
    try {
      jsonFilter = JSON.parse(jsonFilterRaw) as FilterNode;
    } catch {
      errors.push({
        path: `/${FILTER_JSON_KEY}`,
        message: "filter パラメータが JSON として解釈できません。",
        hint: "filter には and/or/not と葉 {field, <演算子>} からなる JSON を URL エンコードして渡してください。",
      });
    }
  }

  // --- filter.<field>(等値の後方互換)---
  const filter: { field: string; equals: string | number | boolean }[] = [];
  const seen = new Set<string>();
  for (const [key, raw] of params.entries()) {
    if (key === FILTER_JSON_KEY || !key.startsWith(FILTER_PREFIX)) {
      continue;
    }
    const fieldId = key.slice(FILTER_PREFIX.length);
    if (seen.has(fieldId)) {
      // AND で重ねることも最後の1つを採ることも利用者への嘘になるので、黙って解釈しない。
      errors.push({
        path: `/filter/${fieldId}`,
        message: `絞り込み条件 "filter.${fieldId}" が複数回指定されています。`,
        hint: "同じフィールドへの等値条件は1つだけ指定してください。",
      });
      continue;
    }
    seen.add(fieldId);

    const equals = decodeFilterValue(fieldsById.get(fieldId)?.type, fieldId, raw, errors);
    if (equals !== undefined) {
      filter.push({ field: fieldId, equals });
    }
  }

  // --- sort / order ---
  //
  // 複合ソート(V1-M0-T03 / F-8)は **sort= と order= の組を繰り返す**形で表す。
  //   ?sort=rating&order=desc&sort=finished_on&order=desc
  // 既存の1キーの形はこの形の特殊ケースなので、v0 の URL は1バイトも変えずに通る。
  // ここで行うのはトランスポート層のデコードだけで、フィールドが実在するかは
  // カーネル(`listRecords`)が判定する —— この分担も v0 のまま変えていない。
  const sortFields = params.getAll("sort");
  const orders = params.getAll("order");
  if (sortFields.length === 0 && orders.length > 0) {
    errors.push({
      path: "/sort/order",
      message: "order は sort と一緒に指定してください(sort なしの order は効きません)。",
      hint: "並び替えるフィールドを sort=<field_id> で指定してください。",
    });
  }
  orders.forEach((order, index) => {
    if (!SORT_ORDER_VALUES.includes(order)) {
      errors.push({
        path: orders.length > 1 ? `/sort/${index}/order` : "/sort/order",
        message: `order の値 "${order}" は並び順の語彙ではありません。`,
        allowed_values: [...SORT_ORDER_VALUES],
        hint: "asc(昇順)または desc(降順)を指定してください。",
      });
    }
  });
  // order を全部省く(= 全キー asc)か、キーと同数書くかのどちらかしか受けない。
  // 足りないぶんを黙って asc で埋めると、**どのキーに掛かった order なのかが
  // 利用者に見えないまま結果が変わる**。数が合わないことは誤りとして返す。
  if (sortFields.length > 0 && orders.length > 0 && orders.length !== sortFields.length) {
    errors.push({
      path: "/sort/order",
      message: `sort は ${sortFields.length} 個、order は ${orders.length} 個指定されています。`,
      hint:
        "order は省略する(すべて昇順になります)か、sort と同じ数だけ" +
        "sort=<field_id>&order=<asc|desc> の組で並べて指定してください。",
    });
  }

  // --- limit / offset(ページネーション。EC-G11 / ADR-0042)---
  // 0 以上の整数だけを受ける。非整数・負数は黙って化けさせず 400 で弾く(値の妥当性そのものは
  // カーネル(listRecords の validatePageParam)も検査するが、トランスポート層で先に整数に
  // デコードできなければ数値として渡せないため、ここで文字列→整数の復元と範囲検査を行う)。
  const limit = decodePageParam("limit", params.get("limit"), errors);
  const offset = decodePageParam("offset", params.get("offset"), errors);

  // ブール式 filter(JSON)と等値 filter.<field> の同時指定は、どちらを採っても
  // 利用者への嘘になるので黙って解釈しない(sort/order の重複と同じ方針)。
  if (jsonFilter !== undefined && filter.length > 0) {
    errors.push({
      path: `/${FILTER_JSON_KEY}`,
      message: "filter(ブール式 JSON)と filter.<field>(等値)は同時に指定できません。",
      hint: "どちらか一方だけを指定してください(ブール式なら等値も and で表現できます)。",
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const options: ListRecordsOptions = {};
  if (jsonFilter !== undefined) {
    options.filter = jsonFilter;
  } else if (filter.length > 0) {
    options.filter = filter;
  }
  if (limit !== undefined) {
    options.limit = limit;
  }
  if (offset !== undefined) {
    options.offset = offset;
  }
  if (sortFields.length === 1) {
    // キー1つのときは v0 と同じ**単数オブジェクト**で渡す。エラーの path も
    // `/sort/field` のまま変わらない(`fixtures/catalog.json` の期待値が生きる)。
    const order = orders[0];
    options.sort = { field: sortFields[0] as string, order: order === "desc" ? "desc" : "asc" };
  } else if (sortFields.length > 1) {
    options.sort = sortFields.map((field, index) => ({
      field,
      order: orders[index] === "desc" ? "desc" : "asc",
    }));
  }
  return { ok: true, value: options };
}

/**
 * **【`V8-M20` / `T02` の置き直し】面の規則が名指しした項目**(旧: `$defs/field.audience`
 * を宣言した項目)**が、読取のリクエスト引数の
 * 絞り込み・並べ替えの条件に現れていないかを見る**(`V4-M28-T01`。`D-V4-93` /
 * **`ADR-0120` 限定1〜3・限定8**)。**現れていたら、その全件を `ValidationError` で返す。**
 *
 * - **止めるのは読取のリクエスト引数だけである**(限定1)—— **マニフェストの
 *   `view.filter` / `view.sort` は1バイトも触っていない。宣言は今日どおり適用できる。**
 * - **ロールを1つも見ない**(限定2)—— **`sum_field` の判定(下の読取経路)と同じ形であり、
 *   owner の要求も同じ 400 になる。** **同じ URL が相手によって 200 と 400 に割れない。**
 * - **【`V8-M20` / `T02` の置き直し】述語を `fieldAudience` から
 *   `isRoleGovernedField`(面が項目を名指ししているか)へ差し替えた。**
 *   **`owner-scope.ts` の1本を再利用する形は1ミリも変えていない。**
 * - **エラーの本文に、要求された「値」を1バイトも載せない**(限定8)—— **載せると
 *   エラー文そのものが新しいオラクルになる。** 載せるのはフィールドIDと JSON Pointer だけである。
 * - **宣言していない項目は1ミリも変わらない**(限定12)。**既定は今日どおり「書ける」である。**
 *
 * **【この判定が塞がないもの。誇張しない】** **書込(`POST` / `PATCH` / `/batch`)の応答・
 * MCP の `list_records`・`?sort=` の 400 の `allowed_values` は1バイトも変えていない**
 * (限定7 / 限定11 / 限定9)。**アプリが `view.sort` に宣言つき項目を書いた画面の順序から
 * 大小関係が漏れることも、ここでは塞がらない**(`ADR-0120` §限界3)。
 */
function hiddenFieldQueryErrors(
  manifest: Manifest,
  table: Table,
  options: ListRecordsOptions,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const isDeclared = (fieldId: string): boolean => isRoleGovernedField(manifest, table.id, fieldId);

  if (options.filter !== undefined) {
    // 平坦形(`filter.<field>=`)は配列に落ちている。**path は書かれた形をそのまま指す** ——
    // 配列なら `/filter/<field>`(重複指定のエラーと同じ形)、ブール式ならネストを写した Pointer。
    const flat = Array.isArray(options.filter);
    for (const ref of filterFieldRefs(options.filter)) {
      if (!isDeclared(ref.field)) {
        continue;
      }
      errors.push({
        path: flat ? `/${FILTER_JSON_KEY}/${ref.field}` : `/${FILTER_JSON_KEY}${ref.path}`,
        message: `絞り込みに指定されたフィールド "${ref.field}" は、役割の規則が名指ししています。規則の対象になっている項目で絞り込むことはできません。`,
        hint: "役割の規則(roles の rules)が名指ししていないフィールドを条件に指定してください。",
      });
    }
  }

  // 並べ替えは単数オブジェクト / 配列の2表記があるので、`normalizeSort` で揃えてから見る。
  // **path は書かれた形をそのまま指す** —— 単数なら `/sort/field`、配列なら `/sort/<index>/field`
  // (**カーネルの `sortErrorPath` と同じ規則である。値 import は `ADR-0009` 限定2 が禁じて
  // いるので写した** —— 写しであることが分かるようにここに書いておく)。
  normalizeSort(options.sort).forEach((key, index) => {
    if (!isDeclared(key.field)) {
      return;
    }
    const sortPath = Array.isArray(options.sort) ? `/sort/${index}` : "/sort";
    errors.push({
      path: `${sortPath}/field`,
      message: `並べ替えに指定されたフィールド "${key.field}" は、役割の規則が名指ししています。規則の対象になっている項目で並べ替えることはできません。`,
      hint: "役割の規則(roles の rules)が名指ししていないフィールドを指定してください。",
    });
  });

  return errors;
}

/**
 * `limit` / `offset` クエリを 0 以上の整数へデコードする(ページネーション。EC-G11 / ADR-0042)。
 * 未指定(null)は `undefined`(= 指定なし)。非整数・負数は 400 として `errors` に積む
 * (黙って 0 や全件に化けさせない。憲法6)。
 */
function decodePageParam(
  name: "limit" | "offset",
  raw: string | null,
  errors: ValidationError[],
): number | undefined {
  if (raw === null) {
    return undefined;
  }
  // `Number()` は "1.5" / "1e2" / " 3 " も通してしまうので、10進整数の並びだけを受ける。
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value)) {
    errors.push({
      path: `/${name}`,
      message: `${name} は 0 以上の整数で指定してください(受け取った値: ${JSON.stringify(raw)})。`,
      hint:
        name === "limit"
          ? "1ページに返す最大件数を 0 以上の整数で指定してください(省略すると全件返します)。"
          : "先頭からスキップする件数を 0 以上の整数で指定してください(省略すると先頭から返します)。",
    });
    return undefined;
  }
  return value;
}

/**
 * `offset..offset+limit` を切り出す(ページネーション。EC-G11 / ADR-0042)。
 *
 * 匿名公開 / 個人スコープの post-filter 分岐で、可視集合を JS でページングするために使う
 * (カーネルの LIMIT/OFFSET と同じ意味論)。`limit` 未指定なら末尾まで返す(後方互換)。
 */
function slicePage<T>(rows: T[], limit: number | undefined, offset: number | undefined): T[] {
  const start = offset ?? 0;
  const end = limit === undefined ? undefined : start + limit;
  return rows.slice(start, end);
}

/**
 * **集計表の読取が受ける並べ替え**(`V8-M11-T03`。台帳 `Q-G21a`(束ねた結果の並べ替え)/
 * `Q-G12`(集計値での並べ替え)。**ユーザ決定 `D-V8-130`**:
 * 「並べ替えは宣言で固定するのではなく、見ている人が押して変えられる」)。
 *
 * **宣言(`report.sort`)と1バイトも同じ形である** —— **`{target, index, order}` の3キーで、
 * 指し方は**添字**である**(`v8-m11.md` §1-0c の決定2)。**項目名を1つも受け取らない。**
 *
 * **【`Q-G22` の読取側。決定8】** —— **この関数が「項目名」を受ける口を1つも持たないことが、
 * 読取時に見せない項目を指せないことの担保である。** **【禁止】これを「読取時に壁を立てた」と
 * 書かない** —— **壁を要する入力を作らなかったのであって、検査を1本置いたのではない。**
 * **機械的な固定は `src/server/report-declaration-boundary.test.ts` の (44)。**
 */
type ReportSortQuery = {
  target: "group_by" | "aggregate";
  index: number;
  order: "asc" | "desc";
};

const REPORT_SORT_TARGETS = ["group_by", "aggregate"] as const;
const REPORT_SORT_ORDERS = ["asc", "desc"] as const;

/**
 * **集計表が1回の要求で返す群の既定の数**(`V8-M11-T04`。台帳 `Q-G21b`。
 * **ユーザ決定 `D-V8-129`** の逐語: 「**画面の上に出る全体の合計は、100件分ではなく
 * 全部を数えた値を出します**」)。
 *
 * **これは**上限ではない** —— **`?limit=` に大きい値を書けば、そのまま返る**
 * (クランプを1つも置いていない。**既存のレコード経路と同じ向き**)。
 * **上限は `src/server/report-limits.ts` の2本であり、ページ送りでは回避できない**
 * (`v8-m11.md` §1-0c の決定5)。**そのため、この定数はそちらに置いていない。**
 *
 * **一覧(`GET …/records`)の既定と違う** —— **一覧は `limit` を書かなければ全件返す。**
 * **集計表だけが既定を持つ理由は、群が1万個できうるからである**(上限がその数である)。
 *
 * **【`V8-M13-T02`(台帳 `Q-G28`)で `export` にした】** —— **MCP の `read_report` が
 * **同じ既定**を使うためである。** **値は1文字も変えていない。**
 * **2つ目の定数を作らない** —— **作れば「HTTP は 100、MCP は別」という割れが生まれ、
 * `ADR-0003` §7(入口を何本生やしても振る舞いが一致する)に正面から反する。**
 */
export const REPORT_DEFAULT_GROUP_LIMIT = 100;

/**
 * **集計表の `?limit=` が壊れていたときの hint**(`V8-M11-T04`。乙2 の宿題)。
 *
 * **`decodePageParam` の hint の逐語「省略すると全件返します」は、集計表では嘘になる。**
 * **関数の側を1バイトも書き換えず、集計表ルートの側で差し替えている** ——
 * **一覧の読取ルートの文面は着手前と1バイトも同じである。**
 */
const REPORT_LIMIT_HINT = `1ページに返す最大件数を 0 以上の整数で指定してください(集計表では、省略すると先頭 ${REPORT_DEFAULT_GROUP_LIMIT} 群を返します)。`;

/**
 * **3つのクエリを並べ替えの宣言1つに戻す**(`V8-M11-T03`)。
 *
 * **全か無かである** —— **3つそろっていなければ 400 で、部分的に効かせない**
 * (一覧の `sort` / `order` の数が合わないときに 400 にしているのと同じ向き。
 * **黙って既定に化けさせない**。憲法6)。
 *
 * **値域は宣言と同じ 12通りに閉じている**(2 × 3 × 2)。**さらに、`index` が
 * **その画面が宣言した本数**の内側であることまで見る** —— **`201` で通った宣言が読取時に
 * 壊れる形を作らないのと同じ理由で、「受け取れるが効かない要求」を1つも通さない**
 * (apply 時の同じ壁は `src/kernel/referential-integrity.ts` に在る。甲3)。
 *
 * **3つとも書かれていなければ `undefined` を返す** —— **そのとき順序を決めるのは
 * 宣言(`report.sort`)であり、宣言も無ければ着手前の既定順である**(決定3)。
 */
function decodeReportSort(
  raw: { target: string | null; index: string | null; order: string | null },
  declared: { group_by: number; aggregates: number },
  errors: ValidationError[],
): ReportSortQuery | undefined {
  const given: [string, string | null][] = [
    ["sort_target", raw.target],
    ["sort_index", raw.index],
    ["sort_order", raw.order],
  ];
  const missing = given.filter(([, value]) => value === null).map(([name]) => name);
  if (missing.length === 3) {
    return undefined;
  }
  if (missing.length > 0) {
    // **足りない名前をそのまま返す** —— **「3つのうち何個受け取った」ではなく
    // **どれが無いか**を書く**(書き手が次に何をすればよいかが1文で決まる)。
    errors.push({
      path: `/${missing[0]}`,
      message:
        "並べ替えを指定するときは sort_target / sort_index / sort_order の3つを全部指定してください" +
        `(足りないのは ${missing.join(" / ")} です)。`,
      hint: "例: ?sort_target=group_by&sort_index=0&sort_order=desc(3つのうち1つでも欠けると効きません)。",
    });
    return undefined;
  }
  const target = REPORT_SORT_TARGETS.find((candidate) => candidate === raw.target);
  if (target === undefined) {
    errors.push({
      path: "/sort_target",
      message: `sort_target の値 ${JSON.stringify(raw.target)} は並べ替えの対象の語彙ではありません。`,
      allowed_values: [...REPORT_SORT_TARGETS],
      hint: "束ねるキーで並べるなら group_by、集計した値で並べるなら aggregate を指定してください。",
    });
  }
  const order = REPORT_SORT_ORDERS.find((candidate) => candidate === raw.order);
  if (order === undefined) {
    errors.push({
      path: "/sort_order",
      message: `sort_order の値 ${JSON.stringify(raw.order)} は並び順の語彙ではありません。`,
      allowed_values: [...REPORT_SORT_ORDERS],
      hint: "asc(昇順)または desc(降順)を指定してください。",
    });
  }
  // **`Number()` は "1.5" / " 1 " / "1e0" も通すので、10進整数の並びだけを受ける**
  // (`decodePageParam` と同じ作法。**負数もここで落ちる**)。
  const index = /^\d+$/.test(raw.index ?? "") ? Number(raw.index) : Number.NaN;
  if (!Number.isSafeInteger(index) || index > 2) {
    errors.push({
      path: "/sort_index",
      message: `sort_index の値 ${JSON.stringify(raw.index)} は 0 以上 2 以下の整数ではありません。`,
      hint: "並べ替えに使うものを、宣言に書いた順の番号(先頭が 0)で指定してください。",
    });
    return undefined;
  }
  if (target === undefined || order === undefined) {
    return undefined;
  }
  // **宣言した本数の内側であること** —— **値域(0..2)の内側でも、宣言の外なら効かない。**
  const declaredCount = target === "group_by" ? declared.group_by : declared.aggregates;
  if (index >= declaredCount) {
    errors.push({
      path: "/sort_index",
      message: `sort_index の値 ${index} は、この集計表が宣言した ${target} の本数(${declaredCount})の外側です。`,
      hint: `0 以上 ${declaredCount - 1} 以下の番号を指定してください(先頭が 0 です)。`,
    });
    return undefined;
  }
  return { target, index, order };
}

/**
 * クエリ文字列の値を、マニフェストのフィールド型に応じて `string | number | boolean` に戻す。
 * 型が判らない(マニフェストにないフィールド)場合は文字列のまま通し、
 * 「そんなフィールドは無い」の判定はカーネルに任せる。
 */
function decodeFilterValue(
  type: Table["fields"][number]["type"] | undefined,
  fieldId: string,
  raw: string,
  errors: ValidationError[],
): string | number | boolean | undefined {
  switch (type) {
    case "number": {
      const value = Number(raw);
      if (!Number.isFinite(value) || raw.trim() === "") {
        errors.push({
          path: `/filter/${fieldId}/equals`,
          message: `絞り込み条件 "filter.${fieldId}" の値 ${JSON.stringify(raw)} を数値として読めません。`,
          hint: "このフィールドの型は number です。10 や 1.5 のような数値を指定してください。",
        });
        return undefined;
      }
      return value;
    }
    case "boolean": {
      if (raw === "true") {
        return true;
      }
      if (raw === "false") {
        return false;
      }
      errors.push({
        path: `/filter/${fieldId}/equals`,
        message: `絞り込み条件 "filter.${fieldId}" の値 ${JSON.stringify(raw)} を真偽値として読めません。`,
        allowed_values: ["true", "false"],
        hint: "このフィールドの型は boolean です。true または false を指定してください。",
      });
      return undefined;
    }
    default:
      // text / long_text / select / date / reference、および型不明はそのまま文字列。
      return raw;
  }
}

// --- リクエストボディのデコード ---------------------------------------------------

type BodyResult = { ok: true; value: RecordInput } | { ok: false; errors: ValidationError[] };
type JsonBodyResult = { ok: true; value: unknown } | { ok: false; errors: ValidationError[] };

/**
 * ボディを JSON として読むだけ。**中身が何であるべきかは判定しない。**
 *
 * 差分(`POST /diffs`)はこれをそのまま使い、形の検証はカーネルの `validateDiff` に任せる。
 * サーバ層で「オブジェクトであること」を先に判定すると、同じ検査がカーネルと二重になり、
 * HTTP 経由と MCP 経由で文面が割れる(ADR-0003 §7)。
 */
async function readJsonBody(request: Request): Promise<JsonBodyResult> {
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return {
      ok: false,
      errors: [
        {
          path: "",
          message: "リクエストボディが JSON として解釈できません。",
          hint: "Content-Type: application/json で、正しい JSON オブジェクトを送ってください。",
        },
      ],
    };
  }
}

/** ボディを JSON オブジェクト(= レコード入力)として読む。非オブジェクトは同じ統一形式で返す。 */
async function readJsonObject(request: Request): Promise<BodyResult> {
  const body = await readJsonBody(request);
  if (!body.ok) {
    return body;
  }
  const parsed = body.value;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      errors: [
        {
          path: "",
          message: "リクエストボディは JSON オブジェクトでなければなりません。",
          hint: '{ "<field_id>": value, ... } の形で送ってください。',
        },
      ],
    };
  }
  return { ok: true, value: parsed as RecordInput };
}

// --- カーネルへの接続 -------------------------------------------------------------

/**
 * リクエストごとに台帳・アプリDBを開いて閉じる。
 *
 * 接続を跨いで持ち回らないのは、サーバ層にグローバル状態を持たせないため
 * (テストが `createServerApp` を何度呼んでも独立に動く)。v0 のローカル・
 * シングルユーザ前提では、この開き直しのコストは問題にならない。
 */
function withStore<T>(dataRoot: string, run: (store: KernelMetaStore) => T): T {
  const store = KernelMetaStore.open(dataRoot);
  try {
    return run(store);
  } finally {
    store.close();
  }
}

function withAppDb<T>(dataRoot: string, appId: string, run: (db: Database) => T): T {
  const db = new Database(appDbPath(dataRoot, appId), { readwrite: true, create: false });
  // 同じアプリへの同時書込は「待たずに落ちる」のではなく「順番待ちの上限まで待つ」
  // (V3-M13-T15 / ADR-0069 §Decision 2)。**値も PRAGMA 文もカーネルの定数1つに閉じている**
  // (限定2 / 限定12)—— ここに数値リテラルを置くと、入口が増えたときに値がずれる。
  db.exec(CONCURRENT_WRITE_WAIT_PRAGMA);
  try {
    return run(db);
  } finally {
    db.close();
  }
}

/**
 * ワークフロー実行履歴の書き込み失敗を、**その1回の同期書き込みが生んだぶんだけ**集める
 * (V1-M9-T12。`src/mcp/tools/write.ts` の同名ヘルパーと同じ形 —— `withAppDb` を両層で
 * 写しているのと同じ理由で、カーネルへの依存だけを共有し実体は入口ごとに置く)。
 *
 * 既定の `historyFailureHandler` は `console.error` するだけで会話にも画面にも届かない。
 * ここで収集用ハンドラを書き込みの直前に差し込み、直後に既定へ戻す。**この install→
 * 書き込み→collect→restore は1つの同期区間(`withAppDb` の同期コールバック内)で完結
 * させること** —— このプロセスでは `startWorkflowScheduler` のタイマーが同居するが、JS は
 * 単一スレッドで、同期区間に `setInterval` コールバックは割り込めない。よって `schedule`
 * 由来の失敗が HTTP レスポンスに混入しない。起動時に1つ据える global バッファ方式は
 * この混入を招くので採らない。
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
    resetWorkflowHistoryFailureHandler();
  }
}

/**
 * 監査に残す値の上限(文字数)。**超えたぶんは切り詰めて `…` を付ける**(`E-G53` / V4-M6)。
 *
 * **監査行を本文の写しにしない**ための上限である —— 長文(`long_text`)や画像 id を丸ごと
 * 写すと、消したはずの本文が監査に残り続ける。**「全文が残る」とは書けない。**
 */
const ACTIVITY_VALUE_MAX = 120;

/** 監査に残す1つの値の表現。`null` / `undefined` は `null`、それ以外は切り詰めた文字列。 */
function activityValue(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  return text.length > ACTIVITY_VALUE_MAX ? `${text.slice(0, ACTIVITY_VALUE_MAX)}…` : text;
}

/**
 * 更新の前後を比べて、**実際に値が変わった項目**だけを監査用に並べる
 * (`E-G53` / ユーザ決定 `D-V4-49`「変更内容まで記録に残す」)。
 *
 * **残すもの**: 更新後の行に在るフィールドのうち、更新前と値が違うもの(`field` / `from` / `to`)。
 *
 * **残さないもの(**「全項目の差分を残す」とは書かない**)**:
 * - **送ったが値が同じだった項目**(変更ではない)。
 * - **システム列**(`_id` / `_created_at` / `_updated_at`)—— `_updated_at` は書込のたびに必ず
 *   変わるので、載せると毎行に無意味な差分が1つ増える。
 * - **上限を超えた文字**({@link ACTIVITY_VALUE_MAX})。
 *
 * **並びは更新後の行のキー順である**(安定させるためであって、意味のある順序ではない)。
 */
function describeRecordChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): ActivityChange[] | null {
  const system = new Set(["_id", "_created_at", "_updated_at"]);
  const changes: ActivityChange[] = [];
  for (const [field, next] of Object.entries(after)) {
    if (system.has(field)) {
      continue;
    }
    const previous = before[field];
    if (previous === next) {
      continue;
    }
    changes.push({ field, from: activityValue(previous), to: activityValue(next) });
  }
  return changes.length === 0 ? null : changes;
}

/**
 * records 書込(create/update/delete)と `_auth_activity` への監査 INSERT を、**同一接続・
 * 同一トランザクション**で行う(ADR-0015 / 計画 v2 §監査配線)。カーネル書込が失敗
 * (例外)したら監査行も残らない —— トランザクションごと巻き戻る。書込が `ok: false`
 * (バリデーション不合格など。DB には何も書かれない)なら監査は記録しない。
 *
 * SQL は書かない(app.ts の規約): スキーマ保証 `ensureAuthActivitySchema` と INSERT
 * `recordActivity` はどちらも `src/auth/store.ts` の関数に閉じている。withAppDb の生 `db` は
 * SCHEMA が流れていない(auth 未初期化 / T01 世代)ことがあるので、書込前に必ず ensure する。
 */
function writeWithAudit<V>(
  db: Database,
  actor: AuthUser | undefined,
  action: ActivityAction,
  tableId: string,
  write: () => RecordResult<V>,
  recordIdOf: (value: V) => string | null,
  shouldRecord: (value: V) => boolean = () => true,
  /**
   * **その更新で実際に値が変わった項目**(`E-G53` / `D-V4-49` / V4-M6)。**更新経路だけが渡す。**
   * 渡さなければ着手前と同じ(`changes` は NULL)。**何を残すかの判断は呼び出し側にある** ——
   * ここは受け取ったものをそのまま監査行へ載せる。
   */
  changesOf: (value: V) => ActivityChange[] | null = () => null,
): RecordResult<V> {
  ensureAuthActivitySchema(db);
  const tx = db.transaction((): RecordResult<V> => {
    const result = write();
    if (!result.ok) {
      return result;
    }
    if (actor !== undefined && shouldRecord(result.value)) {
      recordActivity(db, {
        userId: actor.id,
        username: actor.username,
        action,
        tableId,
        recordId: recordIdOf(result.value),
        changes: changesOf(result.value),
      });
    }
    return result;
  });
  // **BEGIN IMMEDIATE**(V3-M13-T15 / ADR-0069 §Decision 1 = ADR-0018 D2(a) の実適用)。
  //
  // deferred のままだと、この tx の中で先に走る検証の SELECT が SHARED を取り、
  // 続く INSERT/UPDATE が RESERVED へ昇格しようとした時点で **SQLite は待つとデッドロックに
  // なるので busy handler を呼ばず即 `SQLITE_BUSY` を返す**(ADR-0018 (2) のロック昇格
  // デッドロック)。**その結果、上の `busy_timeout` が1ミリ秒も効かない** —— V3-M13-T15 が
  // 在庫の create パスで実測した(外側 deferred tx + bt=5000 でも負けた側は 1ms で落ちる)。
  // BEGIN 時に書込ロックを取れば昇格が起きないので、busy handler が呼ばれて実際に待つ。
  //
  // **IMMEDIATE にするのは入口層のこの tx と `inbound-route.ts` の2本だけである**(限定3)。
  // **`src/kernel/records.ts` の器は deferred のまま**(ADR-0066 限定2 を1バイトも破らない)。
  // **器の本数も増やしていない**(ADR-0066 限定1 の凍結検査は綴りを grep で数えるので、
  // このコメントはその綴りを1度も書かない)—— 変えたのは既にある器の開き方だけである。
  return tx.immediate();
}

/**
 * 読み取りファサード(`readRecordList` / `readRecord`)に渡す `ReadSource` を組む。
 *
 * `appDb` を**呼ばれたときに初めて開く**のが要点である(ADR-0006 §7b)。`withAppDb` は
 * `create: false` なので、`app.sqlite` が無い / 壊れているアプリでは開いた時点で例外に
 * なり、統一形式ですらない 500 になる。システムテーブルの投影元は `kernel.sqlite` だけ
 * なので、`_apps` を眺めるだけでそうなるのは筋が悪い ―― 管理ツールは壊れた状態を
 * 見に行くための道具でもある。開かなければ閉じる必要も無いので、`finally` も遅延側に揃える。
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
 * **行1件の判定(`Z-G11` / `V7-M2-T02`)に要る行を読んで、判定関数を1つ返す配管。**
 *
 * **ここに判定式は1行も無い** —— **判定は `owner-scope.ts` の `judgeRecordAccess` 1本が
 * 持つ**(`ADR-0061` 限定4 の逐語「判定は `src/server/owner-scope.ts` に集約する /
 * `app.ts` に条件式を書かない」)。**本ファイルは「どの表を読むか」を述語に聞き、読んだ行を
 * そのまま渡すだけである。**
 *
 * **`undefined` を返したら、その表には判定が1バイトも掛からない**(= 表がこの仕組みを
 * 使うと宣言していない。**オプトインの実体**)。**呼び出し側は今日どおりの処理を続ける。**
 *
 * **【代償を正直に書く】** **付与表と利用者表、および**グループ表**を毎回**全件**読む**
 * (**グループ表は `V7-M3-T05` が足した1本である。** **グループを宣言していない表では
 * 1行も読まない**)。 **DB 側では解かない**
 * (`v7-m0.md` §5-4 (i) の post-filter 裁定。`compileFilter` に落とすと `ADR-0043` の
 * 「葉演算子はちょうど5種・深度上限8」を破る)。**したがって一覧は
 * `ADR-0042` §限界2 の「可視分岐は全件をメモリに読む」の上に、さらに2表の全件読みが乗る。**
 * **行1件ごとに付与行を走査するので、計算量は (行数 × 付与行数) である。**
 * **どこで遅くなるかは1件も測っていない。**
 * **読取は1回のリクエストの中で1度だけ行う**(行ごとに読み直さない)。
 */
function recordAccessRows(
  source: ReadSource,
  manifest: Manifest,
  tableId: string,
  sources: RecordAccessSourceTables,
): {
  readonly grantRows: readonly Record<string, unknown>[];
  readonly memberRows: Record<string, unknown>[];
} {
  const rowsOf = (id: string | undefined): Record<string, unknown>[] => {
    if (id === undefined) {
      return [];
    }
    const result = readRecordList(source, manifest, id, {});
    // **読めない表は「行が0件」に倒す** —— **判定そのものは掛かり続け、
    // `judgeRecordAccess` が fail-closed(付与が解決できない = 見えない)に倒す。**
    return result.ok ? (result.value as Record<string, unknown>[]) : [];
  };
  // **消えたグループ行を指す付与を、判定の手前で無効にする**(`Z-G32` / `V7-M3-T05`)——
  // **ここに条件式は1行も無い。** **どの項目がグループを指すかを知っているのは
  // `owner-scope.ts` の `grantsWithExistingGroups` 1本である。**
  return {
    grantRows: grantsWithExistingGroups({
      manifest,
      tableId,
      grantRows: rowsOf(sources.grantTable),
      groupRows: rowsOf(sources.groupTable),
    }),
    memberRows: rowsOf(sources.memberTable),
  };
}

/**
 * **【`V7-M4-T02` / `Z-G14` が変えた点】**
 *
 * **旧の中身は2行であった** —— **`recordAccessRows` で付与行と利用者行を読み、その2つを
 * `judgeRecordAccess` へ渡して閉じる形である**(**親を1段も辿らない**)。
 * **旧の綴りをこの doc に写していない** —— **写すと `app.ts` の文字列を数えている
 * 既存の検査**(`access-control-paths.test.ts` の (B-3) / `access-control-stale-grant.test.ts`
 * の (E-3))**が、実行されないコメントの行を実物として数えてしまうためである。**
 * **旧の形は git の履歴と `docs/plan/v7/records/v7-m4.md` に残る。**
 *
 * **今日は `resolveRecordAccess`(`owner-scope.ts`)を呼ぶ** —— **親(`inherit_from`)を
 * 辿って各段の判定を OR で重ねるのはあちらの仕事であり、**ここに判定式は今日も1行も無い**。**
 * **8経路はすべて今日もこの1本を通る**(`access-control-paths.test.ts` が機械的に固定)。
 *
 * **【読む表のメモ化。ここが本タスクで増えた唯一の仕掛けである】** ——
 * **`resolveRecordAccess` は段ごとに `readRows` を呼ぶので、素朴に書くと同じ付与表を
 * 段の数だけ読み直す。** **1回の要求のあいだ表ごとに1度だけ読み、`_id` の索引も一緒に
 * 作って持ち回る**(親の行は `readRow` で引く)。**読み方そのものは
 * {@link recordAccessRows} と同じ `readRecordList(source, manifest, id, {})` である。**
 *
 * **【代償を正直に書く。丸めない】**
 *  - **メモ化しても「全件をメモリに読む」ことは1ミリも変わっていない**(`ADR-0042` §限界2)。
 *    **親の表も丸ごと読む** —— **読む表の本数が段の数だけ増えた。**
 *  - **行1件ごとに親を辿るので、計算量は (行数 × 段数) である。**
 *  - **段数と読む行数の上限は今日1つも無い**(`Z-G17` / `V7-M4-T04` の担当)。
 *  - **どこで遅くなるかは1件も測っていない。**
 *
 * **【`V7-M4-T04`(`Z-G17`)による更新。旧文を1バイトも消していない】**
 *
 * **上の「段数と読む行数の上限は今日1つも無い」は `V7-M4-T02` を書いた時点の記述である。**
 * **今日は上限が2本ある**(段数5 / 辿って読む行の合計 1000)。
 * **本配管が返す関数の戻り値は `RecordAccessVerdict` ではなく `RecordAccessResolution`
 * (判別可能なユニオン)になった** —— **上限に当たったことを、呼び出し側が
 * 「見えない」に丸められない形で受け取るためである。** **各経路は
 * `kind === "limit_exceeded"` を 4xx に翻訳する**(翻訳は `errors.ts` の1本)。
 */
function recordAccessJudge(
  source: ReadSource,
  manifest: Manifest,
  tableId: string,
  actorId: string | null,
  sources: RecordAccessSourceTables | undefined,
  roles: ActorRoles = null,
): ((row: Record<string, unknown>) => CombinedRecordAccessResolution) | undefined {
  if (sources === undefined) {
    return undefined;
  }
  const { readRows, readRow } = memoizedRowReaders(source, manifest);
  // **【`V8-M19` / `J-G18` / `D-V8-23`】面と点をここで `OR` に重ねる。**
  //
  // **`V8-M17` は面をそれぞれの層の場所で別々に止めていた**(= 点とは `AND`)。
  // **`V8-M19` は、行を手元に持っている判定を1本の関数へ寄せ、(行, 要求している人, 動詞)
  // ちょうどの単位で `OR` にした** —— **重ねるのは `owner-scope.ts` の
  // `resolveCombinedRecordAccess` 1本であり、ここに合成の式は1行も無い。**
  // **旧4層との重ね順は今日も `AND` である**(撤去は `V8-M20`)。
  return (row) =>
    resolveCombinedRecordAccess({
      manifest,
      tableId,
      row,
      actorId,
      roles,
      sources,
      readRows,
      readRow,
    });
}

/**
 * **「その行に付与を配れるか」を答える配管**(`V14-M1-T01` / `V14-M1-T03`。台帳 `RB-G3`)。
 *
 * **{@link recordAccessJudge} と同じ形である** —— **DB を読む手を持っているのは
 * サーバ層だけなので、読み手をここで組み、判定そのものは `owner-scope.ts` の1本
 * ({@link rowGrantWriteJudge})に渡す。** **ここに条件式を1行も書かない**
 * (`ADR-0061` 限定4)。
 *
 * **`sources` が `undefined`(= その表は宣言していない)なら `undefined` を返す** ——
 * **呼び出し側は着手前と1バイトも変わらない応答を返す。**
 *
 * **【誇張しない】** **返る真は「押せば必ず作れる」ではない** ——
 * **{@link rowGrantWriteJudge} の doc に、見ていない関門3つを名指しで書いてある。**
 * **書込の壁は今日も `judgeGrantWrite` 1本であり、本配管はその手前にも後ろにも立たない。**
 */
function recordGrantWritePipe(
  source: ReadSource,
  manifest: Manifest,
  tableId: string,
  actorId: string | null,
  sources: RecordAccessSourceTables | undefined,
  roles: ActorRoles = null,
): ((row: Record<string, unknown>) => boolean) | undefined {
  if (sources === undefined) {
    return undefined;
  }
  const { readRows } = memoizedRowReaders(source, manifest);
  return rowGrantWriteJudge({ manifest, tableId, actorId, roles, readRows });
}

/**
 * **1回の要求のあいだ、表ごとに1度だけ行を読む読み手を1組つくる**(`V7-M4-T02` が
 * {@link recordAccessJudge} の中に書いたものを、`V7-M5-T02` がここへ出した)。
 *
 * **読み方を1バイトも変えていない** —— **`readRecordList(source, manifest, id, {})` で全件を
 * 読み、`_id` の索引を一緒に作って持ち回る。** **読めない表は「行が0件」に倒す**
 * (**判定そのものは掛かり続け、fail-closed になる**)。
 *
 * **【なぜ出したか】** —— **運営専用の口(`Z-G19`)も同じ読み方で親を辿る必要が出たため
 * である。** **別々に書くと、判定と一覧で読む表がずれうる。**
 *
 * **【代償は今日も同じ】** —— **全件をメモリに読む**(`ADR-0042` §限界2)。
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
    // **読めない表は「行が0件」に倒す** —— **判定そのものは掛かり続け、fail-closed になる。**
    const rows = result.ok ? (result.value as Record<string, unknown>[]) : [];
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

/**
 * **付与表への書込(`Z-G5` / `V7-M3-T03`)の配管。** **判定は `owner-scope.ts` の
 * `judgeGrantWrite` 1本が持つ** —— **ここにあるのは「行を読む」ことだけで、条件式は1行も無い。**
 *
 * **`undefined` を返したら、その表は付与表として名指しされていない**(= 今日どおり素通り)。
 *
 * **【代償を正直に書く】** —— **付与表・利用者の表・グループの表を毎回**全行**読む。**
 * **読取経路の配管(`recordAccessJudge`)と同じ post-filter の作法であり、DB 側では解かない。**
 * **書込1件ごとに読むので、バッチでは op の数だけ繰り返す。** **どこで遅くなるかは1件も
 * 測っていない。**
 */
function grantWriteVerdict(
  source: ReadSource,
  db: Database,
  manifest: Manifest,
  tableId: string,
  op: GrantWriteOp,
  values: Record<string, unknown>,
  actor: AuthUser | undefined,
): GrantWriteVerdict | undefined {
  return judgeGrantWrite({
    manifest,
    tableId,
    op,
    values,
    actorId: actor?.id ?? null,
    // **【`V8-M16` / `J-G3`】実効ロール集合を渡す(和集合1本)。**
    role: actor?.roles ?? null,
    readRows: (id) => {
      const result = readRecordList(source, manifest, id, {});
      return result.ok ? (result.value as Record<string, unknown>[]) : [];
    },
    readRow: (id, recordId) => {
      const existing = getRecord(db, manifest, id, recordId);
      return existing.ok && existing.value !== null
        ? (existing.value as Record<string, unknown>)
        : undefined;
    },
  });
}

/**
 * **付与表への書込の判定を、HTTP の応答へ翻訳する**(`V7-M3-T03`)。
 *
 * **通す場合は `null` を返す。** **止める場合は本文と応答コードを返す。**
 *
 * **応答コードの決め方(自分で決めた。理由は `v7-m3.md` §2-3)**:
 *  - **付与が指す行が見えない人 → 404**(**存在を伏せる**。403 を返すと、その行が在ることが
 *    漏れる。単件 `PATCH` の並びと1ミリも違えない)。
 *  - **行は見えるが作成者でも運営でもない人 → 403。**
 *  - **相手・対象が解決できない → 400**(**その人の権限ではなく、要求の中身の問題である**)。
 */
function grantWriteDenial(
  verdict: GrantWriteVerdict | undefined,
): { readonly errors: ValidationError[]; readonly status: 400 | 403 | 404 } | null {
  if (verdict === undefined || verdict.kind === "allowed") {
    return null;
  }
  if (verdict.kind === "invisible_target") {
    return {
      errors: [unknownRecordError(verdict.tableId, verdict.recordId)],
      status: 404,
    };
  }
  if (verdict.kind === "not_creator") {
    return { errors: [forbiddenGrantWriteError()], status: 403 };
  }
  if (verdict.kind === "self") {
    return { errors: [forbiddenSelfGrantError()], status: 403 };
  }
  if (verdict.kind === "membership_locked") {
    // **【`V8-M19` / `J-G33` / `U-2`】所属の書き換えは 403。** **存在を伏せる必要は無い**
    // —— **要求した人はその表を今日も読めている**(読取は1ミリも絞っていない)。
    return { errors: [forbiddenMembershipWriteError(verdict.role)], status: 403 };
  }
  if (verdict.kind === "no_target") {
    return { errors: [unknownGrantTargetError()], status: 400 };
  }
  if (verdict.kind === "parent_denied") {
    // **相手の権限の問題であり、対象の行はこの actor には見えている** —— **403。**
    // **存在を伏せる必要は無い**(親の行の id を文面に出さない)。
    return { errors: [forbiddenGrantParentAccessError()], status: 403 };
  }
  return { errors: [unknownGrantHolderError()], status: 400 };
}

// --- 画像配信の可視範囲(V2-M2-T03 / ADR-0035 §1c・限定6)---------------------------

/** cookie から per-app セッションのユーザを解決する。未認証/無効は undefined(配信の匿名判定に使う)。 */
function resolveSessionUser(
  dataRoot: string,
  appId: string,
  c: Context<AuthEnv>,
): AuthUser | undefined {
  const sessionId = getCookie(c, "st_session");
  if (sessionId === undefined || sessionId === "") {
    return undefined;
  }
  const store = AuthStore.openForApp(dataRoot, appId);
  try {
    const session = resolveSession(store, sessionId);
    if (session === null) {
      return undefined;
    }
    const user = store.findUserById(session.userId);
    if (user === undefined) {
      return undefined;
    }
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      // **実効ロール集合**(`V8-M16` / `J-G3`)。**列の1値 ∪ 付与表。**
      roles: store.effectiveRoles(user.id),
    };
  } finally {
    store.close();
  }
}

/**
 * 参照ベースの配信可視範囲。
 *
 * **【`V7-M3-T07` / `Z-G36` による逐語の是正。旧文を1バイトも消していない】**
 *
 * **旧**(`V2-M2-T03` 以来の1行。**逐語を1バイトも変えずに残す**):
 * 「参照ベースの配信可視範囲。owner/editor/viewer は全 file なのでこの判定を通さない。」
 *
 * **今日は違う** —— **予約3ロールもこの判定を通る。** **変わったのは「宣言した表
 * (行ごとのアクセス権を使うと宣言した表)の行から参照されている file」だけである** ——
 * **その file は、その行を読める人にしか配信しない**(`ADR-0061:120` が「本 ADR はこれを
 * 解かない」と書いた穴を v7 が引き取った)。
 * **宣言していない表の行から参照されている file と、どの行からも参照されていない file は、
 * 予約3ロールに今日どおり全部配信する**(`V7-M3-T07` の完了条件 (ii))。
 */
// **【`V5-M17-T06` / `G-G7`】判別子から EC 固有語を外した。**
// **旧: `{ kind: "customer"; actorId: string }`。** **判定の中身は1バイトも変えていない。**
//
// **【`V7-M3-T07` が型ごと直した】** —— **`FileViewer` はロールを1バイトも持っておらず、
// `isOwnerVisible` のシグネチャ変更ではこの経路を捕まえられなかった**(`v7-m0.md` §4-6 /
// §5-4 の (viii))。**そこで「予約3ロールか」を1つだけ持たせた** —— **ロールの綴り
// (`owner` / `editor` / `viewer`)は持たせない。** **持たせると、種類ごとの分岐が
// 走査の中に生まれる**(`ADR-0295` 限定4)。
//
// --- 【`V8-M27-T04` / `T-G5`】**`reservedRole` は撤去した。旧文を1バイトも消していない** ---
//
// **旧: `| { kind: "signed_in"; actorId: string; reservedRole: boolean };`。**
// **上の段落が述べている「予約3ロールか」を1つだけ持たせる、という形はもう無い。**
// **`FileViewer` は今日、ロールを1バイトも持たない** —— **表単位の可否を決めるのは
// 面(`app.roles[].rules`)であり、それは走査へ渡す述語(`judgeFor` /
// `crossesOwnerScope`)の中にある。**
type FileViewer = { kind: "anonymous" } | { kind: "signed_in"; actorId: string };

/**
 * **ファイル配信の走査の答え**(`Z-G17` / `V7-M4-T04`)。
 *
 * **【`boolean` から変えた理由】** —— **`boolean` のままだと「上限に当たった」を
 * `false` に丸めるしかなく、その 404 が「本当に参照されていない / 読めない」の 404 と
 * 区別できなくなる**(完了条件 (iii))。**3つ目の答えを型で持たせる。**
 *
 *  - `deliver` … 今日どおり配信する(旧 `true`)。
 *  - `withhold` … 存在秘匿の 404(旧 `false`)。**エラー本文を持たない。**
 *  - `limit_exceeded` … 引き継ぎの上限に当たったので判定を出せなかった。**4xx + 上限の種別。**
 */
type FileVisibility =
  | { readonly kind: "deliver" }
  | { readonly kind: "withhold" }
  | { readonly kind: "limit_exceeded"; readonly limit: "depth" | "rows" };

/**
 * file_id が「viewer に見えるレコードの image / file フィールド」から参照されているか
 * (V2-M2-T03。**V5-M16-T04 で `file` 型の扱いを足した**)。
 *
 * - anonymous: **公開テーブル(st_public を持つ)の公開行(st_public=真)**の **image が参照する
 *   file のみ。** **`file` 型の列は1本も見ない**(`ADR-0161` 限定5 逐語「`st_public` の公開行が
 *   参照していても、`file` 型が指すファイルは未認証で配信しない。**`image` より狭い。**」)。
 * - customer : 自分の scoped 行(st_owner=自分/共有)+ 公開行(st_public=真)の
 *   **image と file の両方**が参照する file。
 *
 * **【`ADR-0161` が決めていないことを、ここで決めている】** **限定5 が書いているのは
 * 「未認証で配信しない」だけで、`customer` をどう扱うかは審査が1文字も書いていない。**
 * **`customer` に `file` を配信しないと、自分宛ての請求書PDFを本人が落とせない。**
 * **そこで `customer` には image と同じ可視範囲(自分の行 + 公開行)を `file` にも当てる。**
 * **これは `V5-M16` の判断であり、審査の限定を写したものではない**
 * (記録: `docs/plan/v5/records/v5-m16.md` §8)。
 *
 * これはレコード読み取り(ADR-0034/0016)の可視範囲を image 参照に写したもの。判定は純粋述語
 * (`isPublicRow` / `isOwnerVisible` / `publicField` / `personalOwnerField`)を再利用する。scoped と
 * public を両持ちするテーブルは `nonAdminTableAccess` と同じく scoped(自分の行)を優先する。
 *
 * **計算量**: 対象の型の列を持つテーブルだけを走査し各行を1回見る(O(該当テーブルの行数))。
 * 参照の逆引き索引は持たない —— owner-scope の post-filter が全行をメモリに載せるのと同オーダーで、
 * v2(127.0.0.1・リファレンス EC)には十分。大規模化するなら WHERE 押し下げ/参照索引を別途入れる。
 */
function isFileReferencedByVisibleRow(
  dataRoot: string,
  appId: string,
  manifest: Manifest,
  fileId: string,
  viewer: FileViewer,
  judgeFor: (
    source: ReadSource,
    tableId: string,
  ) => ((row: Record<string, unknown>) => RecordAccessResolution) | undefined,
  /**
   * **【`V8-M27-T04` / `T-G5`】面の規則が、その表の読取について `st_owner` の絞り込みを
   * 越えるか**(`roleReadCrossesOwnerScope`。`D-V8-35`)。
   *
   * **撤去した `reservedRole` の跡地に置いた1本である。** **旧は「予約3ロールなら全行」
   * という**ロールの綴り**で決めていた** —— **今日は「面がその表の読取を許しているか」で
   * 決まる。** **判定式はここに1行も無い**(`ADR-0061` 限定4)—— **呼び出し側が
   * `owner-scope.ts` の述語をそのまま渡す。**
   *
   * **これを渡さないと、レコード経路(`app.ts` の一覧・単件)は面で `st_owner` を越えるのに、
   * ファイル配信だけが越えないという食い違いが生まれる**(= **運営が読める行の画像だけが
   * 404 になる**)。**同じ問いに2つの答えを持たせないために渡している。**
   */
  crossesOwnerScope: (tableId: string) => boolean,
): FileVisibility {
  // **匿名には `image` の列しか見せない**(`ADR-0161` 限定5)。
  // **この1行が「`file` は未認証配信しない」の本体である** —— 走査対象から外れた列が
  // 参照する file は、どの行が公開でも見つからず 404 に倒れる。
  const deliverableTypes: readonly string[] =
    viewer.kind === "anonymous" ? ["image"] : ["image", "file"];
  // --- 【`V8-M27-T04` / `T-G5`】**この1行は撤去した。旧文を1バイトも消していない** ---
  //
  // **ここに在ったもの(逐語)**:
  //
  //     const reserved = viewer.kind === "signed_in" && viewer.reservedRole;
  //
  // **この旗が効いていたのは3箇所である**(すべて同じタスクで書き換えた):
  //  (1) 走査の中の `else if (reserved) { rowVisible = () => true; }`
  //      —— **予約3ロールは全行が見える、という表単位の可否そのものだった。**
  //  (2) 走査の末尾の `else { continue; }`(「運営テーブルは customer に見せない」)
  //      —— **(1) の裏側であり、同じ層の反対の面である。**
  //  (3) 最後の `return reserved && !governedReference ? deliver : withhold;`
  //      —— **どの行からも参照されていない file を予約3ロールにだけ配っていた。**
  return withReadSource<FileVisibility>(dataRoot, appId, (source) => {
    // **宣言した表の行から参照されているか / そのうち1行でも読めるか**(`Z-G36`)。
    let governedReference = false;
    let governedVisible = false;
    for (const table of manifest.app.tables) {
      const imageFields = table.fields.filter((field) => deliverableTypes.includes(field.type));
      if (imageFields.length === 0) {
        continue;
      }
      const ownerField = personalOwnerField(table);
      const isPublicTable = publicField(table) !== undefined;
      let rowVisible: (row: Record<string, unknown>) => boolean;
      if (viewer.kind === "anonymous") {
        if (!isPublicTable) {
          continue; // 匿名に開くのは公開テーブルだけ(ADR-0034 と同じゲート)
        }
        rowVisible = (row) => isPublicRow(row);
      } else if (ownerField !== undefined && !crossesOwnerScope(table.id)) {
        rowVisible = (row) => isOwnerVisible(row[OWNER_FIELD], viewer.actorId);
      } else {
        // --- 【`V8-M27-T04` / `T-G5`】**ログイン済みの枝を4本から2本に畳んだ** ---
        //
        // **旧(逐語。1バイトも消していない)**:
        //
        //     } else if (reserved) {
        //       // **予約3ロールは今日どおり「全行」である**(`V2-M2-T03` の水準を1ミリも狭めない)。
        //       // **狭まるのは、下で `judge` が付く表(= 宣言した表)だけである。**
        //       rowVisible = () => true;
        //     } else if (ownerField !== undefined) {
        //       rowVisible = (row) => isOwnerVisible(row[OWNER_FIELD], viewer.actorId);
        //     } else if (isPublicTable) {
        //       rowVisible = (row) => isPublicRow(row);
        //     } else {
        //       continue; // 運営テーブルは customer に見せない
        //     }
        //
        // **旧の4枝のうち後ろ3枝は、`reserved` が真なら1度も踏まれない** ——
        // **つまり「予約3ロールなら全行 / そうでなければ `st_owner`・`st_public` で絞り、
        // どちらも無ければ見せない」という、役割の綴りで分かれる層そのものだった。**
        // **`V8-M27` はその層を撤去するので、3枝(`reserved` / `isPublicTable` /
        // 末尾の `continue`)を**一緒に**落とす** —— **1本だけ落とすと壊れる。**
        //
        // **残したのは `st_owner`(個人スコープ)の1枝だけである** ——
        // **`st_owner` は予約規約フィールドであって、役割を1文字も見ない別物だからである。**
        // **そこに `roleReadCrossesOwnerScope`(`D-V8-35`)を掛けているのは、
        // レコード経路(この `app.ts` の一覧・単件)が今日そうしているのと**同じ規則**だから
        // である** —— **同じ問いに2つの答えを持たせない。**
        //
        // **【実際に変わったこと。誇張も過小評価もしない】**
        //  1. **`st_public` を持つ表の「公開でない行」が参照する file が、ログイン済みの
        //     非運営の役割にも配信されるようになった**(旧: 404)。
        //     **これはレコード経路に揃えた形である** —— **`isPublicRow` の絞り込みは
        //     レコード経路では**未認証のときにしか掛かっていない**(`anonymousPublic`)。
        //     **旧のファイル配信だけが、ログイン済みの相手にも公開行の絞り込みを掛けていた。**
        //     **【正直に書く】これは広がりである。**
        //  2. **`st_owner` も `st_public` も持たない表(旧「運営テーブル」)の file が、
        //     面が読取を許した相手に配信されるようになった**(旧: 非運営には必ず 404)。
        //     **面が許していなければ今日も 404 である**(下の `judge` が落とす)。
        //  3. **予約3ロールは、面が読取を書いていない表の file を受け取れなくなった** ——
        //     **旧は `reserved` の1枝で全行が見えていた。** **これは狭まりである。**
        //
        // **未ログイン(`anonymous`)の枝は1バイトも変えていない**(`ADR-0034` / `ADR-0161`)。
        rowVisible = () => true;
      }
      // **行ごとのアクセス権(`Z-G36` / `V7-M3-T07`)。** **`undefined` なら、その表は
      // この仕組みを使うと宣言していない** = **今日どおりの可視範囲だけで決める。**
      // **判定式はここに1行も無い** —— 呼び出し側が組んだ述語を当てるだけである
      // (`ADR-0061` 限定4)。
      const judge = judgeFor(source, table.id);
      const result = readRecordList(source, manifest, table.id);
      if (!result.ok) {
        continue;
      }
      for (const row of result.value) {
        if (!imageFields.some((field) => row[field.id] === fileId)) {
          continue;
        }
        if (judge === undefined) {
          if (rowVisible(row)) {
            return { kind: "deliver" };
          }
          continue;
        }
        governedReference = true;
        if (!rowVisible(row)) {
          continue;
        }
        const access = judge(row);
        // **上限に当たったら「見えない」に丸めない**(`Z-G17` / `V7-M4-T04`)——
        // **404 に混ぜると、上限に当たった状態と「本当に参照されていない」状態が
        // 応答の上で区別できなくなる。** **走査の途中でも、その場で打ち切って返す。**
        if (access.kind === "limit_exceeded") {
          return { kind: "limit_exceeded", limit: access.limit };
        }
        if (access.verdict.read) {
          governedVisible = true;
        }
      }
    }
    if (governedVisible) {
      return { kind: "deliver" };
    }
    // **予約3ロールは、宣言した表の行から参照されていない file は今日どおり受け取れる**
    // (**どの行からも参照されていない file を含む**。`V7-M3-T07` の完了条件 (ii))。
    // **参照されているのが「宣言した表の、その人には読めない行」だけなら、配信しない。**
    //
    // --- 【`V8-M27-T04` / `T-G5`】**条件からロールを外した。旧文を1バイトも消していない** ---
    //
    // **旧(逐語)**: `return reserved && !governedReference ? { kind: "deliver" } : { kind: "withhold" };`
    //
    // **今日は「ログインしているか」だけを見る** —— **`reserved`(予約3ロールか)を外した。**
    //
    // **なぜ `withhold` に倒しきらなかったか(**決めたのは実装側である。理由を書く**)**:
    // **どの行からも参照されていない file とは、実際には「上げたばかりで、まだどの行にも
    // 保存していないファイル」である。** **`V8-M27-T03` がアップロードの口を面で開いた
    // 結果、`viewer` と宣言された種類も上げられるようになった** —— **その人が自分で
    // 上げた直後のプレビューを 404 にすると、上げる口だけが開いていて中身を確かめられない、
    // という状態になる。**
    //
    // **【正直に書く。これは広がりである】** **旧は予約3ロールだけが受け取れた。**
    // **今日はログインしている全員が、file_id を知っていれば受け取れる**
    // (**ただし「どの行からも参照されていない」ものに限る**)。
    // **file_id は乱数の識別子であり、当てることを前提にした守りではない。**
    // **未ログインは今日どおり1件も受け取れない**(`viewer.kind === "anonymous"`)。
    return viewer.kind === "signed_in" && !governedReference
      ? { kind: "deliver" }
      : { kind: "withhold" };
  });
}

// --- 集計表を「見える行だけ」で計算する(`V8-M13-T02`。台帳 `Q-G28`)-------------------

/**
 * **集計表を1つ、要求している人に見える行だけで計算する。**
 *
 * ## **【`V8-M13-T02` による切り出し。挙動を1つも変えていない】**
 *
 * **着手前、本関数の中身はすべて `GET /api/apps/:app_id/views/:view_id/report` の
 * ハンドラの中にインラインで書かれていた**(`V8-M10-T03` / `T04` / `T05` が置いたもの)。
 * **`Q-G28`(MCP から集計を読む)の限定5 が「可視性の判定を必ず通す」と定めており、
 * `src/kernel/report.ts` の `computeReport()` を MCP から直接呼ぶと、その注入を1ミリも
 * 通らない。** **そこで、注入と上限の判定を含む処理をここへ出し、HTTP と MCP の
 * **両方が同じ1本を呼ぶ**形にした。**
 *
 * **【純粋な移動である】** —— **中の行は1行も足していない・消していない・並べ替えていない。**
 * **`app.ts` の外に出していない**(`withReadSource` / `recordAccessJudge` は本ファイルの
 * 非公開関数であり、別ファイルへ移すと循環 import になる)。
 * **ハンドラに残したのはクエリの復元(`decodePageParam` / `decodeReportSort`)と
 * ページの切り出し(`slicePage`)だけである** —— **`GET` の応答は1バイトも変わらない**
 * (トップレベルのキーは今日どおり `groups` / `total_groups` / `totals` の3つちょうど。
 * `src/server/report-declaration-boundary.test.ts` の (24) が `toEqual` で固定している)。
 *
 * **【4つの失敗はすべて 400 である】** —— **着手前のハンドラは
 * (1) 引き継ぎの上限 → (2) 集計表の上限 → (3) 計算の失敗 → (4) 群の数の上限 の順で
 * 4つとも 400 を返していた。** **本関数はその順序のまま `RecordResult` の失敗として返し、
 * ハンドラは1本の `if (!result.ok)` で 400 に翻訳する。** **どれが先に返るかは
 * 着手前と1バイトも同じである。**
 *
 * **【`view` は「クエリを当てた1枚」を受け取る】** —— **並べ替えのクエリを解くのは
 * ハンドラの責務のままである**(`D-V8-130`)。**MCP はクエリを1つも受けないので、
 * 宣言そのものを渡す。**
 */
export function readVisibleReport(params: {
  readonly dataRoot: string;
  readonly manifest: Manifest;
  /** **読む1枚**(HTTP は並べ替えのクエリを当てた写し、MCP は宣言そのもの)。 */
  readonly view: ReportView;
  readonly roles: ActorRoles;
  /** **要求している人**(`_id`)。**未ログインは `null`。** */
  readonly subject: string | null;
  readonly anonymousPublic: boolean;
}): ReturnType<typeof computeReport> {
  const { dataRoot, manifest, view } = params;
  const reportRoles = params.roles;
  const reportSubject = params.subject;
  const reportAnonymousPublic = params.anonymousPublic;
  // **上限は注入の中では返せない**(返り値が行の配列だから)ので、ここで受け取る。
  let reportLimit: "depth" | "rows" | undefined;
  // **【`V8-M10-T05` / `Q-G17`〜`Q-G19`】集計表そのものの上限**(引き継ぎの上限とは別物)。
  // **同じ形で受け取る** —— **注入の中で当たっても、返せるのは行の配列だけである。**
  let reportScanLimit: ReportLimitKind | undefined;
  const result = withReadSource(dataRoot, manifest.app.id, (source) => {
    // **表ごとの絞り(1度だけ組んで使い回す)。**
    //
    // **メモ化しているのは「判定の組み立て」であって、判定の答えではない** ——
    // **行ごとの答えは毎回 `judgeRecordPopulation` が出す。**
    // **1つの表が1回の要求で2度読まれることは今日は無いが、
    // 組み立て(付与表の読み手を作る `recordAccessJudge`)を表の数だけに抑える。**
    const judgedTables = new Map<
      string,
      (rows: Record<string, unknown>[]) => Record<string, unknown>[]
    >();
    const visibleRowsOf = (
      readTableId: string,
    ): ((rows: Record<string, unknown>[]) => Record<string, unknown>[]) => {
      const memoized = judgedTables.get(readTableId);
      if (memoized !== undefined) {
        return memoized;
      }
      const accessSources = recordAccessSourceTables(manifest, readTableId);
      const tableRead = judgeRoleAccess({
        manifest,
        roles: reportRoles,
        target: { target: "table", table: readTableId },
        verb: "read",
      });
      // **面の関門に当たった人には、空の母集団を渡す**(`D-V8-128`)——
      // **403 にしない。** **`computeReport` が 0 行から 合計0・件数0・群0 を作る** ——
      // **「読める行が無い」の答えを2箇所で作らないためである**(0 を返す分岐を
      // ここに書くと、集計の作り方がカーネルとサーバの2箇所に住む)。
      // **結合先の表でこれに当たると、その表の行は1つも結び付かない** ——
      // **順方向なら親が `null`、逆方向なら子が落ちて親が1行残る**
      // (`v8-m10.md` §1-0c の決定5。**行そのものを落とさない**)。
      const gateBlocks = roleGateBlocksWithoutGrants({
        role: tableRead,
        grantGoverned: !reportAnonymousPublic && accessSources !== undefined,
      });
      // **判定の配管**(`recordAccessJudge`)—— **一覧の読取ルートと同じ2行である。**
      // **`ReadSource` は絞りの掛かっていない側を渡す** —— **付与表と利用者表を読むのは
      // この配管であり、そこに可視性を掛けると「自分に見える付与だけで判定する」という
      // 循環になる**(付与が見えない人は誰も何も読めなくなる)。
      // **`T04` でもここは1バイトも変えていない** —— **渡しているのは注入を組む**前**の
      // `source` そのものである。**
      const judge = recordAccessJudge(
        source,
        manifest,
        readTableId,
        reportSubject,
        accessSources,
        reportRoles,
      );
      const resolvedTable = resolveTable(manifest, readTableId);
      const visible = (rows: Record<string, unknown>[]): Record<string, unknown>[] => {
        // **【`V8-M10-T05`。数える2箇所のうちの (i)】** **DB から読んだ生の行数** ——
        // **可視性の**前**である。** **ここで止めないと、上限が守る対象(メモリと時間)を
        // 1ミリも守らない** —— **母集団の判定そのものが行の数だけ働くからである。**
        // **面の関門より**先**に見る** —— **読んでしまったあとの行数を数えるのがこの上限で
        // あり、関門に当たる人にだけ費用を免除する理由が無い。**
        // **応答には「どの表か」を1バイトも載せない**(`v8-m10.md` §1-0c の決定2 の 1')。
        if (exceedsReportScannedRows(rows.length)) {
          reportScanLimit = "scanned_rows";
          return [];
        }
        if (resolvedTable === undefined || gateBlocks) {
          return [];
        }
        const population = judgeRecordPopulation({
          manifest,
          table: resolvedTable,
          tableId: readTableId,
          rows,
          anonymousPublic: reportAnonymousPublic,
          actorId: reportSubject,
          roles: reportRoles,
          accessSources,
          tableRead,
          judge,
        });
        if (population.kind === "limit_exceeded") {
          reportLimit = population.limit;
          return [];
        }
        // **「絞りは要らない」(分岐5 = 非スコープ)は、読んだ行をそのまま母集団にする**
        // (`v8-m10.md` §1 `T02` の `2'` の逐語)。
        const populationRows = population.kind === "unfiltered" ? rows : population.rows;
        // **【`V8-M10-T05`。数える2箇所のうちの (ii)】** **可視性の post-filter を通した
        // **後**の行数。** **【正直に書く】今日ここは1度も発火しない** ——
        // **可視性は行を増やさないので `(ii) ≤ (i)` が常に成り立ち、同じ上限を見ている
        // (i) が先に返す。** **それでも書いてあるのは、§1-0c の決定2 が「表ごとに2箇所で
        // 数える」と定めており、(i) を緩めた日にここが最後の歯止めになるからである。**
        if (exceedsReportScannedRows(populationRows.length)) {
          reportScanLimit = "scanned_rows";
          return [];
        }
        return populationRows;
      };
      judgedTables.set(readTableId, visible);
      return visible;
    };
    return computeReport(
      {
        ...source,
        // **可視な行だけを返す読取元**(`v8-m10.md` §1-0c の決定1)。
        // **この関数の中に条件式は1つも無い** —— **母集団の答えは
        // `owner-scope.ts` の1本が出す。**
        // **起点の表も結合先の表も、同じこの1本を通る**(`V8-M10-T04` / `Q-G14`)。
        // **`as typeof rows` は「行を1つも作り替えていない」ことの表明である** ——
        // **母集団の1本は `Record<string, unknown>` として行を扱う**(システムの列を
        // 知らない側に置いてある)**が、返しているのは**読んだ行そのもの**であって、
        // 別の形に写した行ではない。**
        visibleRows: (readTableId, rows) => visibleRowsOf(readTableId)(rows) as typeof rows,
      },
      manifest,
      // **【`V8-M11-T03`】読むのは「クエリを当てた1枚」である**(`D-V8-130`)——
      // **クエリを書かなければ `view` そのものが渡る**(着手前と1バイトも同じ値)。
      view,
    );
  });
  if (reportLimit !== undefined) {
    // **1行でも上限に当たったら要求全体を 4xx にする**(`Z-G17`)——
    // **一覧の読取ルートと同じ翻訳1本(`errors.ts`)を使う。**
    return { ok: false, errors: [recordAccessLimitError(reportLimit)] };
  }
  // **【`V8-M10-T05`】集計表そのものの上限に当たった** —— **要求全体を 400 にする。**
  // **部分的な結果を1バイトも返さない**(`T05` 完了条件2)。**引き継ぎの上限とは
  // 別の文面で返すので、6種類が応答本文で機械的に区別できる**(同 3')。
  if (reportScanLimit !== undefined) {
    return { ok: false, errors: [reportLimitError(reportScanLimit)] };
  }
  if (!result.ok) {
    return result;
  }
  // **【`V8-M10-T05`】作る群の数の上限。** **【正直に書く】数えているのは
  // **作り終えたあと**である** —— **`src/kernel/report.ts` に上限も判定も1文字も
  // 置かない(§1-0c の決定1 と同じ向き)ことを優先した。**
  // **メモリの上では行の上限が先に効いている** —— **群の数は結合した行の数を超えず、
  // 逆方向の結合は apply 時に1本までに閉じてあるので、群はおよそ 20,000 を超えない。**
  if (exceedsReportGroups(result.value.total_groups)) {
    return { ok: false, errors: [reportLimitError("groups")] };
  }
  return result;
}

// --- アプリ本体 -------------------------------------------------------------------

/**
 * Hono アプリを組み立てて返す(HTTP サーバは起動しない)。
 * 起動は `src/server/index.ts`(Bun.serve)の担当で、こちらは `app.request()` で
 * サーバを立てずにテストできる。
 */
export function createServerApp(options: CreateServerAppOptions): Hono<AuthEnv> {
  const { dataRoot } = options;
  const webDistDir = options.webDistDir ?? join(import.meta.dir, "..", "..", "web", "dist");
  const authConfig = options.authConfig ?? loadAuthConfig(process.env);
  // **起動プロファイル**(`V5-M3-T02`)。引数が無ければ環境変数を読む —— `authConfig` が
  // `loadAuthConfig(process.env)` を既定にしているのと同じ作法である。**語彙外の値は
  // 黙って `full` へ落とさず、ここで止める**(`resolveServerProfile`。憲法6)。
  const profile = options.profile ?? resolveServerProfile(process.env[SERVER_PROFILE_ENV]);
  const app = new Hono<AuthEnv>();

  // 最低限レート制限(V2-M1-T05 / ADR-0034 限定4)。**インスタンスごとに独立**(グローバル
  // 状態を持たない — テストは createServerApp を何度呼んでも独立に動く)。掛ける先は
  // (a) 匿名公開 GET 窓 と (b) サインアップ/ログイン経路の2つだけ。認証済み records CRUD は
  // 非対象(条件7)。
  const publicGetLimiter = new RateLimiter(
    options.rateLimit?.publicGet ?? DEFAULT_PUBLIC_GET_RATE_LIMIT,
  );
  const authLimiter = new RateLimiter(options.rateLimit?.auth ?? DEFAULT_AUTH_RATE_LIMIT);

  /**
   * アプリの実在確認だけ(ADR-0003 §6)。実在すれば `null`、しなければ 404 用のエラー。
   * 変更系(apply_diff / undo)と changelog取得は、カーネル側が「無いアプリ」を例外に
   * するので、ここで先に確かめて 500 ではなく 404 を返す。
   */
  const ensureApp = (appId: string): ValidationError | null =>
    withStore(dataRoot, (store) =>
      store.getApp(appId) === undefined ? unknownAppError(store, appId) : null,
    );

  /** アプリの実在確認 + 現行マニフェストの読み取り(全レコード系エンドポイント共通の前処理)。 */
  const loadManifest = (appId: string): RecordResult<Manifest> => {
    const known = ensureApp(appId);
    if (known !== null) {
      return { ok: false, errors: [known] };
    }
    return { ok: true, value: readCurrentManifest(dataRoot, appId) };
  };

  /**
   * **ADR-0016 §6 の表示名解決**(V3-M8-T03)。行の `st_owner`(= `_auth_users.id` という
   * 不透明なランダム。ADR-0014 §4)を `_auth_users` 由来の表示名に置き換えた行を返す。
   *
   * **掛ける先は ADR-0061 限定7 のとおり、限定1 が開いた読取2経路の運営可視のときだけである**
   * —— 呼び出しは一覧・単件の2箇所しかなく、書込応答(POST / PATCH / DELETE / batch)と
   * 既存経路(購入者が自分の行を読む / 未宣言テーブル)には掛けない。
   *
   * **`_auth_users` は1リクエストにつき最大1回しか読まない**(`listUsers` の1クエリで
   * id → 表示名の写像を作る)—— 行ごとに引き当てると N+1 になるためである。**他人の id が
   * ページに1つも無ければ DB を開かない**(共有行と actor 自身の行しか無いページを含む)。
   * **整形は `st_owner` のキー1つにしか触らない**ので、`_updated_at`(ETag / 楽観ロックの版)
   * には1バイトも影響しない。**actor 自身の id は置き換えない**(2026-07-30 のメインの差し戻し。
   * 理由は `projectOwnerDisplay` の doc)。
   *
   * **【2026-08-13。`V8-M37` / 台帳 `F-G5`。上の段落を1バイトも消していない】**
   * **最後の1文(「actor 自身の id は置き換えない」)は今日の実装を説明していない** ——
   * **自分の行も表示名になる。** **したがって「他人の id がページに1つも無ければ DB を
   * 開かない」も、今日は「**持ち主のある行**がページに1つも無ければ開かない」である**
   * (共有行だけのページでは今日も開かない)。**`src/server/owner-scope.test.ts` の (m) が
   * その差を実測している。**
   */
  const resolveOwnerDisplays = (
    appId: string,
    rows: Record<string, unknown>[],
    actorId: string,
  ): Record<string, unknown>[] => {
    // **【`V8-M37` / `F-G5`】旧(逐語)**:
    //     const needsResolve = (row: Record<string, unknown>): boolean => {
    //       const rowOwner = row[OWNER_FIELD];
    //       return !isSharedOwner(rowOwner) && rowOwner !== actorId;
    //     };
    // **`rowOwner !== actorId` を落とした** —— **落とさないと、自分の行しか無いページで
    // 写像を作らないまま `projectOwnerDisplay` を通し、自分の id が
    // `UNRESOLVED_OWNER_DISPLAY` に化ける。** **判定の家(`owner-scope.ts`)から枝を
    // 落としたら、引き金の側も同じ形に揃える。**
    const needsResolve = (row: Record<string, unknown>): boolean =>
      !isSharedOwner(row[OWNER_FIELD]);
    if (!rows.some(needsResolve)) {
      return rows;
    }
    const store = AuthStore.openForApp(dataRoot, appId);
    let displayNames: ReadonlyMap<string, string>;
    try {
      displayNames = new Map(
        store
          .listUsers()
          .map((user) => [user.id, ownerDisplayName(user.displayName, user.username)]),
      );
    } finally {
      store.close();
    }
    return rows.map((row) => projectOwnerDisplay(row, displayNames, actorId));
  };

  /**
   * **持ち主1人ぶんの表示名を引く**(`V8-M37` / 台帳 `F-G5`)。
   *
   * **用途は「読んだ内容のままの書き戻し」の判定1つだけである** ——
   * **`judgeOwnerUpdateWithDisplay` が、更新側の既存の答えで決着しなかったときにだけ呼ぶ。**
   * **したがって、ふつうの `PATCH`(持ち主を送らない / 据え置き / 共有化)では
   * `_auth_users` を1度も開かない。**
   *
   * **`resolveOwnerDisplays` と同じ `listUsers()` を使う** —— **id で1件引く口を
   * `AuthStore` に足していない**(`Δ8` 相当の増分をサーバ層でも作らない)。
   * **1件のためにユーザ全件を読むのは代償である** —— **呼ばれるのが上の1形だけなので、
   * 読取の回数はほぼ増えない。**
   */
  const ownerDisplayFor = (appId: string, ownerId: unknown): string | undefined => {
    if (typeof ownerId !== "string" || ownerId === "") {
      return undefined;
    }
    const store = AuthStore.openForApp(dataRoot, appId);
    try {
      const user = store.listUsers().find((candidate) => candidate.id === ownerId);
      return user === undefined ? undefined : ownerDisplayName(user.displayName, user.username);
    } finally {
      store.close();
    }
  };

  // --- per-app 認証 middleware(ADR-0014 v3 / アプリ単位認証)----------------------
  //
  // v2 の `app.use("/api/*")` グローバル認証を撤去し、**そのアプリのデータ(レコード)を
  // 読み書きする経路(`/api/apps/:app_id/tables/:table_id/records*`)だけ**に per-app
  // セッションを要求する。manifest / diffs / undo / changelog / list_apps はローカル専用
  // (認証なし)に戻す —— これらはアプリ自体を操作する管理・カーネル操作である。
  //
  // 認証状態は**各アプリの app.sqlite 内**の `_auth_*` テーブルに置く(`openForApp`)。
  // したがって cookie は app_id ごとに独立(サーバ側は Path=/api/apps/:app_id で分離する)。
  //
  // --- システムテーブルの扱い(V4-M1 / `B-G6`。2026-08-02 に変えた)------------------
  //
  // **V4-M1 より前**: システムテーブル(`_apps` / `_changelog` / `_ai_usage`)はカーネル台帳の
  // 読み取り専用投影=管理データなので**認証しなかった**(per-app セッション解決の手前で
  // `isSystemTableId(tableId)` なら素通しにしていた)。**その素通しをやめる。**
  //
  // **やめる理由**: 3投影はいずれも**プラットフォーム全体**を返す(`src/kernel/read-records.ts`
  // が読むのは `source.dataRoot` の `kernel.sqlite` 全体であって app 単位ではない)。
  // したがって `/api/apps/<任意のapp>/tables/_changelog/records` で**全アプリの依頼文の逐語**が、
  // `_ai_usage` で**誰がいくら使ったか**(`actor` と `cost_usd`)が、未認証で読めていた。
  // **`_ai_usage` は V1-M5-T03 が `SYSTEM_TABLES` に足した時点で、素通しが自動的に3本目へ
  // 広がったものである** —— 意図して開けた窓ではない。
  //
  // **壊してはいけない性質**(`ADR-0006:251` の無番号節「システムテーブル読み取り時に
  // `app.sqlite` を開かない」。**§7b ではない**): 逐語の目的は「**`_apps` を眺めるだけで
  // 統一形式でない 500 になる**のは筋が悪い。管理ツールは壊れた状態を見に行くための道具でも
  // ある」である。**読み取り経路そのものは今日も `app.sqlite` を開かない**(`withReadSource`
  // の遅延 `appDb()` は、システムテーブルでは1度も呼ばれない)。**変わったのは認証層だけ**で、
  // 認証層は `AuthStore.openForApp` を使うため `app.sqlite` に触りうる。そこで下の
  // `resolveRecordsUser` で2つを守る:
  //
  //   1. **`app.sqlite` が無ければ開かない**(`openForApp` は `create:true` なので、開くと
  //      **空のファイルを作ってしまう**。04 §3-2 #9 が実測した「`openForApp` の失敗で分岐する案」
  //      が成立しない理由でもある)。
  //   2. **セッション解決が失敗しても 500 にしない** —— 「セッション無し」に倒し、統一形式の
  //      401 を返す。壊れた `app.sqlite` が非統一の 500 を生む経路をここで閉じる。
  //
  // **その結果、壊れた/無い `app.sqlite` を持つアプリの URL では 401 になる。** 管理ツールが
  // 壊れた状態を見に行く道は**健全な別アプリの URL**に残る —— 投影はプラットフォーム全体を
  // 返すので、`GET /api/apps/<健全なapp>/tables/_apps/records` に壊れたアプリの行がそのまま
  // 載る(`src/server/auth-boundary.test.ts` の破壊試験3本が固定している)。
  //
  // **`src/shared/system-tables.ts` は1バイトも触っていない**(`ADR-0007` の Δ2 を発火させない)。

  /**
   * per-app セッションからユーザを解決する(records の認証境界用)。
   *
   * **`app.sqlite` を開けないことを 500 にしない**(上のコメント 1 / 2)。無い場合は開かず
   * (= 作らず)`undefined`、壊れている場合も `undefined` を返す。**呼び出し側はこれを
   * 「未認証」として扱い、統一形式の 401 を返す。**
   *
   * これは `resolveSessionUser`(画像配信用。`:868`)と目的が違う —— あちらは匿名判定で
   * あり、`app.sqlite` の健全性を前提にしてよい経路である。**同じ関数に寄せない**のは、
   * 失敗の倒し方(例外を投げる / 未認証に倒す)が経路ごとに違うためである。
   */
  const resolveRecordsUser = (appId: string, c: Context<AuthEnv>): AuthUser | undefined => {
    const sessionId = getCookie(c, "st_session");
    if (sessionId === undefined || sessionId === "") {
      return undefined;
    }
    // 存在検査を先に置く。`openForApp` は `create:true` なので、無いときに呼ぶと作ってしまう。
    if (!existsSync(appDbPath(dataRoot, appId))) {
      return undefined;
    }
    let store: AuthStore;
    try {
      store = AuthStore.openForApp(dataRoot, appId);
    } catch {
      // 壊れた app.sqlite(SQLite ではないバイト列 / スキーマを用意できない)。未認証に倒す。
      return undefined;
    }
    try {
      const session = resolveSession(store, sessionId);
      if (session === null) {
        return undefined;
      }
      const user = store.findUserById(session.userId);
      if (user === undefined) {
        return undefined;
      }
      return {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        // **実効ロール集合**(`V8-M16` / `J-G3`)。**列の1値 ∪ 付与表。**
        roles: store.effectiveRoles(user.id),
      };
    } catch {
      return undefined;
    } finally {
      store.close();
    }
  };

  /**
   * `?view=<view_id>` で名乗られた画面を検査する(**`V8-M20` / `J-G27` で `view.audience`
   * の判定は撤去した。今日ここに残るのは実在と表の一致だけで、可否は面が持つ**)(`B-G1` /
   * `ADR-0070` 限定3)。**通ってよいなら `null`、拒否なら返すべき `Response` を返す。**
   *
   * **判定の家は1つである** —— `recordsAuthMiddleware` と `batchAuthMiddleware` が同じ
   * この関数を呼ぶ(`ADR-0003` §7「入口を何本生やしても振る舞いが一致する」)。
   * **`V4-FIX1` 項目(1) より前は、この判定が `recordsAuthMiddleware` にしか無く、
   * `POST /api/apps/:app_id/batch` が同じ画面IDを名乗って通り抜けていた**
   * (`docs/evidence/cp-v4.md` §6-3 の #10 が同一セッション・同一画面IDで実測)。
   *
   * @param urlTableId URL が名指ししている表(単件・一覧経路)。**バッチは1リクエストで
   *   複数テーブルを跨ぐので `undefined` を渡す** —— そのとき表の一致は検査しない
   *   (比べる相手が1つに決まらない。この限界は `batch-view-audience.test.ts` (Y) が固定する)。
   */
  const rejectNamedView = (
    appId: string,
    urlTableId: string | undefined,
    c: Context<AuthEnv>,
    // **【`V8-M16` / `J-G3`】実効ロール集合を受ける**(判定は `judgeRoleAccess` 1本)。
    actorRole: ActorRoles,
  ): Response | null => {
    const namedViewId = c.req.query("view");
    if (namedViewId === undefined || namedViewId === "") {
      return null;
    }
    // マニフェストが読めない(JSON 破損等)なら「実在しない画面」に倒す(fail-closed)。
    // **未認証に 500 の内部状態を見せない**という既存の規律(下の公開窓)と同じ向きである。
    let namedView: View | undefined;
    // **【`V8-M17` / `J-G8`】面の判定にはマニフェストそのものが要る**(役割の一覧を読むため)。
    // **読み直さない** —— 同じ1回の `loadManifest` の結果を持ち回る。
    let namedViewManifest: Manifest | undefined;
    try {
      const loaded = loadManifest(appId);
      namedViewManifest = loaded.ok ? loaded.value : undefined;
      namedView = loaded.ok
        ? loaded.value.app.views.find((view) => view.id === namedViewId)
        : undefined;
    } catch {
      namedView = undefined;
    }
    if (namedView === undefined) {
      return c.json(errorBody([unknownViewError(namedViewId)]), 400);
    }
    // **画面の対象テーブルと URL のテーブルが一致していること。**
    // **これを見ないと「無害な画面を名乗って別の表を読む」ができ、判定が飾りになる。**
    if (urlTableId !== undefined && namedView.table !== urlTableId) {
      return c.json(
        errorBody([viewTableMismatchError(namedViewId, namedView.table, urlTableId)]),
        400,
      );
    }
    // --- 面(役割に束ねた権限)の**画面**の規則(`V8-M17` / `J-G8`)-------------------
    //
    // **旧層(`view.audience`)とまったく同じ場所・同じ形・同じ 403 で足す** ——
    // **止める場所を2箇所に割らない。** **旧層の実装は1バイトも消していない**(撤去は `V8-M20`)。
    // **重ね順は AND である**(`04` §7-1 (乙) の決定)—— **どちらかが止めれば止まる。**
    // **【旧文(`V8-M17` が書いた予告)。1バイトも消していない】**
    // **「【この AND は `V8-M19` で面と点の間だけが OR に変わる。中間状態である】
    //   (メインの裁定 `R-13-4`。**旧層との AND は `V8-M20` の撤去まで残る**)。」**
    // **【`V8-M19` が変えた。ただしこの層には及んでいない】** —— **`OR` にしたのは
    // 面と**点**(行ごとの付与)のあいだだけであり、**点は行にしか無い。**
    // **画面には点が1つも無いので、ここは今日も旧層との AND だけである**(撤去は `V8-M20`)。
    // **判定は `owner-scope.ts` の1本**(ここに規則を読む条件式を1つも書かない)。
    if (
      !judgeRoleAccess({
        manifest: namedViewManifest,
        roles: actorRole,
        target: { target: "view", view: namedViewId },
        verb: "read",
      }).allowed
    ) {
      return c.json(errorBody([forbiddenRoleAccessError(`画面 "${namedViewId}"`, "閲覧")]), 403);
    }
    return null;
  };

  const recordsAuthMiddleware: MiddlewareHandler<AuthEnv> = async (c, next) => {
    // middleware は `:app_id` / `:table_id` を持つ経路にだけ張るので、実行時は必ず在る。
    const appId = c.req.param("app_id") as string;
    const tableId = c.req.param("table_id") as string;
    const method = c.req.method;

    // app が存在しなければ 404。openForApp が空の app.sqlite を作ってしまわないよう、
    // セッション解決の**前に**確かめる。
    const appError = ensureApp(appId);
    if (appError !== null) {
      return c.json(errorBody([appError]), 404);
    }

    // 状態変更(POST/PATCH/DELETE)は Origin(無ければ Referer)を検査する。ヘッダが
    // **在る**ときだけ照合し、無ければ通す(非ブラウザ/テスト用。ブラウザのクロスサイト
    // POST は必ず Origin を送るので CSRF 防御は保たれる。ADR-0014 §5)。
    if (method === "POST" || method === "PATCH" || method === "DELETE") {
      const origin = c.req.header("origin") ?? refererOrigin(c.req.header("referer"));
      if (origin !== undefined && !authConfig.expectedOrigins.includes(origin)) {
        return c.json(errorBody([originRejectedError(origin, authConfig.expectedOrigins)]), 403);
      }
    }

    // per-app セッション解決 → 有効なら context にユーザを載せる(完了条件3)。
    // **システムテーブルもここを通る**(V4-M1 / B-G6。素通しの分岐を撤去した。上のコメント)。
    const resolved = resolveRecordsUser(appId, c);
    if (resolved !== undefined) {
      c.set("user", resolved);
    }

    // --- 画面ごとの「見せる相手」(`B-G1` / V4-M3-T03 / ADR-0070 限定3)-----------------
    //
    // **`?view=<view_id>` を渡された要求だけを判定する。渡さなければ今日どおり**(限定4)。
    // **4メソッドすべてに掛ける** —— 限定3 の逐語はメソッドを絞っておらず、目的文
    // (`D-V4-39`「客が運営用の画面を開けないようにするため」)は運営用の入力フォームからの
    // 書込にも当たる(判断の記録は `docs/plan/v4/records/v4-m3-t01.md` §4-4)。
    //
    // **未認証(`user === undefined`)にも掛かる。** 値域に `anonymous` が無いので
    // (`ADR-0070` 限定2)、**宣言のある画面はどれも未認証には開かない = fail-closed。**
    // **`ADR-0074`(`B-G5`)が値域に `anonymous` を足すのは `V4-M2` であり、ここではない。**
    // **判定の本体は `rejectNamedView`(上)に置く** —— バッチ経路が同じ1本を呼ぶ。
    // **【`V8-M16` / `J-G3`】実効ロール集合を渡す**(限定「複数の役割は和集合1本で合成する」)。
    const viewRejection = rejectNamedView(appId, tableId, c, resolved?.roles ?? null);
    if (viewRejection !== null) {
      return viewRejection;
    }

    // 未認証なら 401(そのアプリのレコード API はここで塞がれる。ADR-0014 §6)。
    const user = c.get("user");
    if (user === undefined) {
      // 匿名公開読み取り窓(V2-M1-T04 / ADR-0034 §1)。**GET かつ対象テーブルが公開規約
      // フィールド(st_public)を持つ場合に限って**未認証でも通す。POST/PATCH/DELETE は
      // ここに落ちても 401 のまま —— 書込ハンドラを公開側に一切結線しない(read-only を
      // 構造で守る。限定2)。窓を開けるときだけレート制限を掛ける(限定4。単独禁止)。
      if (method === "GET") {
        // マニフェスト読取が壊れている(JSON 破損等)場合は公開窓を開けず、従来どおり 401 に
        // 倒す(未認証に 500 の内部状態を見せない)。app 不在は上の ensureApp で既に 404 済み。
        let table: Table | undefined;
        try {
          const loaded = loadManifest(appId);
          table = loaded.ok ? resolveTable(loaded.value, tableId) : undefined;
        } catch {
          table = undefined;
        }
        if (table !== undefined && publicField(table) !== undefined) {
          const decision = publicGetLimiter.hit(
            clientKeyFromHeader(c.req.header("x-forwarded-for")),
          );
          if (!decision.allowed) {
            c.header("Retry-After", String(decision.retryAfterSec));
            return c.json(errorBody([rateLimitError(decision.retryAfterSec)]), 429);
          }
          c.set("anonymousPublic", true);
          await next();
          return;
        }
      }
      return c.json(errorBody([unauthenticatedError(appId)]), 401);
    }

    // --- 面(役割に束ねた権限)の**表**の規則 —— 書込と削除(`V8-M17` / `J-G6`)---------
    //
    // **置き場は固定ロールの層(`nonAdminTableAccess` / `hasAdminWriteRole`)と同じこの
    // middleware である** —— **表単位の可否を決める層はここに集まっており、`POST` / `PATCH` /
    // `DELETE` の3経路が同じ1箇所を通る。** **既存の層は1バイトも消していない**(撤去は `V8-M20`)。
    // **固定ロールとの重ね順は今日も AND**(`04` §7-1 (乙))—— **固定ロールが通しても面が
    // 止めれば止まる。** **旧4層との AND も `V8-M20` の撤去まで残る。**
    //
    // **【`V8-M19` が面と点の間だけを OR に変えた。予告ではなく、変えたあとの姿である】**
    // (`D-V8-23` / 裁定 `R-15-2`)—— **この関門は行を手元に持っていない**ので、**点が
    // 管轄内(その表が行ごとの付与を宣言している)なら、ここで止めてはならない。**
    // **止めると OR が AND に戻る**(点だけで通る行を、行を見る前に落としてしまう)。
    // **そのときの判定は、行を手元に持つ下流が (行, 要求している人, 動詞) の単位で行う** ——
    // **`PATCH` / `DELETE` は配管(`recordAccessJudge`)の合成判定、`POST` は作成の下見。**
    // **止めてよいかの判断も `owner-scope.ts` の述語1本である**(ここに式を書かない)。
    //
    // **読取(`GET`)はここで止めない** —— **一覧は応答から落とし、単件は 404 で伏せる**
    // (それぞれのハンドラ。**403 にすると「その表が在る」ことが役割の外へ漏れる**)。
    //
    // **下の1行はメソッドを動詞へ写すだけの対応表であって、規則を1バイトも読まない**
    // (バッチの `opWriteKind` と同じ形)。
    const roleTableVerb: "write" | "delete" | undefined =
      method === "POST" || method === "PATCH"
        ? "write"
        : method === "DELETE"
          ? "delete"
          : undefined;
    if (roleTableVerb !== undefined) {
      let roleManifest: Manifest | undefined;
      try {
        const loaded = loadManifest(appId);
        roleManifest = loaded.ok ? loaded.value : undefined;
      } catch {
        roleManifest = undefined;
      }
      if (
        roleGateBlocksWithoutGrants({
          role: judgeRoleAccess({
            manifest: roleManifest,
            roles: user.roles,
            target: { target: "table", table: tableId },
            verb: roleTableVerb,
          }),
          grantGoverned:
            roleManifest !== undefined &&
            recordAccessSourceTables(roleManifest, tableId) !== undefined,
        })
      ) {
        return c.json(
          errorBody([
            forbiddenRoleAccessError(
              `表 "${tableId}"`,
              roleTableVerb === "delete" ? "削除" : "書き込み",
            ),
          ]),
          403,
        );
      }
    }

    // --- 【`V8-M27-T04` / `T-G5`】古い層は**ここから撤去した**。**旧文を1バイトも消していない** ---
    //
    // **ここに在ったもの(逐語)**:
    //
    //     // customer(V2-M1-T03 / ADR-0033 限定4/5): 既存3ロールと違い**テーブル単位**で可否が分かれる。
    //     // ここで対象テーブルを解決し `nonAdminTableAccess`(owner-scope.ts の純粋判定)1本で分岐する
    //     // ―― 「1件でも運営テーブルへ customer の GET/書込を通さない」を、この1箇所の集約で構造保証する。
    //     //   - scoped(st_owner)  : GET は下流ハンドラの post-filter で自分の行/共有のみ、書込も
    //     //                          スタンプ/owner ガードで自分の行のみに絞られる → 通す。
    //     //   - public(st_public) : GET は可、書込は不可(公開テーブルは read-only)。
    //     //   - denied(運営テーブル): GET も書込も 403。
    //     // テーブル解決に失敗(manifest 破損等)したら fail-closed で denied に倒す(運営データを守る側)。
    //     if (!user.roles.some(isReservedRole)) {
    //       let table: Table | undefined;
    //       try {
    //         const loaded = loadManifest(appId);
    //         table = loaded.ok ? resolveTable(loaded.value, tableId) : undefined;
    //       } catch { table = undefined; }
    //       const access = table === undefined ? "denied" : nonAdminTableAccess(table);
    //       if (method === "GET") {
    //         if (access === "denied") { return c.json(errorBody([forbiddenNonAdminReadError()]), 403); }
    //       } else if (access !== "scoped") {
    //         return c.json(errorBody([forbiddenWriteError()]), 403);
    //       }
    //       await next();
    //       return;
    //     }
    //     // 書込(POST/PATCH/DELETE)は editor/owner のみ。viewer は 403(V1-M3-T02)。
    //     if (method === "POST" || method === "PATCH" || method === "DELETE") {
    //       if (!hasAdminWriteRole(user.roles)) {
    //         return c.json(errorBody([forbiddenWriteError()]), 403);
    //       }
    //     }
    //
    // **代わりに何が受けるか**:
    //  - **書込・削除**: **すぐ上の面(`judgeRoleAccess` の `target: "table"`)である。**
    //    **`V8-M26` が既定を閉じたので、規則を1本も書いていない表は今日も 403 になる。**
    //  - **読取**: **ここでは止めない。** **一覧は応答から落とし、単件は 404 で伏せる**
    //    (`ADR-0305` 限定11。**403 にすると「その表が在る」ことが役割の外へ漏れる**)。
    //    **旧層はここで 403 を返していたので、非運営の役割が規則の無い表を GET したときの
    //    応答は 403 から「200 + 0件」/ 404 に変わった。****これは緩めではない**
    //    —— **`ADR-0305` 限定11 が定めた伏せ方に揃えただけである。**
    //
    // **【この撤去で実際に変わったこと。誇張も過小評価もしない】**
    //  1. **`viewer` が書けるようになった** —— **面が書込を許した表に限る。**
    //     **`hasAdminWriteRole` が「`editor` / `owner` でなければ必ず 403」を持っていた。**
    //  2. **非運営の役割が、`st_owner` も `st_public` も持たない表を読み書きできるようになった**
    //     —— **面が許した表に限る。** **旧は表の作りだけで決まっており、規則を何本書いても
    //     届かなかった。**
    //  3. **`forbiddenNonAdminReadError`(「このテーブルの閲覧は許可されていません。」)と
    //     `forbiddenWriteError`(「この操作を行う権限がありません(閲覧のみ)。」)は
    //     **どちらも呼び出し元が0本になったので消した**(実測。`grep` で確かめた)。
    //     **代わりに返るのは `forbiddenRoleAccessError` である。**

    // --- 【`D-V8-74`】システムが持つ表の**読取**は、持ち主(`owner`)だけに許す ------------
    //
    // **ユーザ決定 `D-V8-74`(2026-08-11)。選ばれた見出しの逐語**: **「持ち主にだけ見せる」。**
    // **選ばれた説明文の逐語**:
    // > **もっと狭くして、持ち主にだけ見せます。変更履歴を追えるのが持ち主1人だけに
    // > なりますが、定義を変えられるのも今日持ち主だけなので、見る人と変える人が揃います。**
    //
    // ## **なぜここに1本要るのか(実測。2026-08-11)**
    //
    // **すぐ上で撤去した層が、システムが持つ表3本(`_apps` / `_changelog` / `_ai_usage`)を
    // **偶然**塞いでいた** —— **3本は `st_owner` も `st_public` も持たないので
    // `nonAdminTableAccess` が `"denied"` を返し、非運営の役割の `GET` が 403 になっていた。**
    // **層を外した瞬間、購入者などの一般の利用者に3本が読めるようになった。**
    // **面(`app.roles[].rules`)は受け止められない** —— **先行のユーザ決定 `D-V8-69`
    // (見出しの逐語「システムの表は権限の外に置く」)により、`judgeRoleAccess` は
    // システムが持つ表を**1度も判定しない**(`owner-scope.ts` の `targetsSystemTable`)。**
    // **そもそも `{ target: "table", table: "_apps" }` は識別子の値域
    // (`^[a-z][a-z0-9_-]*$`)に合わず、規則として書くことすらできない。**
    //
    // **【禁止の履行】これを「実装の不具合」と書かない** —— **撤去は依頼どおりに行われ、
    // `D-V8-69` も依頼どおりに履行されている。** **2つの決定が交差したところに穴が開いた。**
    // **【禁止の履行】逆に「決定の不備」とも書かない** —— **`D-V8-69` を決めた時点で層は
    // まだ生きており、この交差は見えていなかった。**
    //
    // ## **`D-V8-69` の説明文と食い違う点。黙って合わせない**
    //
    // **`D-V8-69` の説明文の逐語は「変更履歴やアプリ一覧は**今までどおり**見えます」であった。**
    // **その「今までどおり」は**運営3ロール(`owner` / `editor` / `viewer`)に見えること**を
    // 指していた** —— **当時それを決めていたのは、すぐ上で撤去した `isReservedRole` の層である。**
    // **本決定 `D-V8-74` はそれより**狭い**(持ち主だけ)。**
    // **【禁止の履行】どちらかを「誤り」と書かない。両方を残す。**
    // **【`D-V8-74` が減らすもの】** **選ばれた説明文の逐語「変更履歴を追えるのが持ち主
    // 1人だけになります」。** **編集者・閲覧者は、誰がいつ何を変えたかを追えなくなる。**
    //
    // ## **【越えてはならない線】撤去した層を復活させていない**
    //
    // **この判定は `isSystemTableId(tableId)` が真のときにしか評価されない** ——
    // **アプリの表(`manifest.app.tables`)には**1バイトも掛からない**。**
    // **`isSystemTableId` は表の**識別子**だけを見る純粋な述語であり、`nonAdminTableAccess`
    // (表の**作り**から「運営テーブルか」を導いていた)とは別物である。**
    // **取り違えようもない** —— **ユーザ定義のIDは `^[a-z][a-z0-9_-]*$` なので、
    // `_` 始まりのIDを持つアプリの表は**定義したくてもできない**。**
    //
    // **アプリの表の可否は撤去直後(`8c380ab`)と同じままである**:
    //  - **規則を1本書けば、旧「運営テーブル」も非運営の役割に読める。**
    //  - **規則が1本も無い表は 403 ではなく「200 + 0件」/ 単件 404**(`ADR-0305` 限定11)。
    // **これを `src/server/system-table-owner-read.test.ts` の (e) が実 HTTP で固定する。**
    //
    // ## **【今日どおり保つもの。1バイトも変えていない】**
    //
    //  1. **書込は今日どおり 400「読み取り専用」である**(**403 にしない**)——
    //     **だから `method === "GET"` で絞っている。** **書込は下流の `resolved.system`
    //     3箇所とカーネルの `readOnlyTableError` がこれまでどおり止める。**
    //  2. **未認証は今日どおり 401 である** —— **この分岐は 401 の**あと**に在る。**
    //     **システムが持つ表は `st_public` を持たないので、上の匿名公開窓にも1度も落ちない。**
    //  3. **`D-V8-69` の免除そのもの(面がシステムの表を判定しないこと)は1バイトも
    //     触っていない** —— **`owner-scope.ts` は無関係のままである。** **本決定は
    //     面の**外側**に1本置いただけであり、`judgeRoleAccess` を呼んでもいない。**
    //
    // ## **【正直に書く】ここは役割の綴りを1語見ている**
    //
    // **`"owner"` の等値比較が1つ残る。** **`V8-M27` は「運営か否か」の層を撤去したが、
    // **システムの表についてだけ役割の綴りを見る判定が1つ残る**(`D-V8-74` が自らそう
    // 述べている)。** **【禁止】総括に「役割の綴りを見る判定を全部なくした」と書かない。**
    // **書けるのは「アプリの表からは無くなった」までである。**
    // **`isReservedRole`(予約3ロールか)は使っていない** —— **使うと編集者・閲覧者まで
    // 通り、選ばれなかった見出し「運営の人にだけ見せる」の実装になってしまう。**
    // **実効ロール集合で判定する**(`V8-M16` / `J-G3`。**列の1値 ∪ 付与表の和集合1本**)。
    if (method === "GET" && isSystemTableId(tableId) && !user.roles.includes("owner")) {
      return c.json(errorBody([forbiddenSystemTableReadError(tableId)]), 403);
    }

    // --- 【`V8-M10-T02` / `Q-G16a` の条件5】集計表の経路にも同じ1本を掛ける ------------
    //
    // **`V8-M8` はここを素通りさせていた。** **下の `app.use(… /report)` の doc に
    // 逐語で残っている**: **「`D-V8-74`(システムが持つ表の読取は持ち主だけ)の分岐は
    // `isSystemTableId(undefined)` が偽になるので、1度も評価されない」。**
    //
    // ## **【発火しない分岐ではない。実測で示した】**
    //
    // **`v8-m10.md` §1 `T02` の 5' は「集計表の宣言にシステムの表を名指しできないなら
    // 到達しないと書け。1つでも通ったらそのときだけ足せ」と定めた。** **実測したら通った。**
    //  - **画面の対象表の値域は `$defs/view_table_id` = `^(_apps|_changelog|[a-z][a-z0-9_-]*)$`
    //    であり、`resource_id`(`^[a-z][a-z0-9_-]*$`)ではない** —— **`_apps` と
    //    `_changelog` を**通す**。
    //  - **実際に `add_view` で `{ type: "report_view", table: "_apps" }` を打つと 201 で
    //    通り、`GET …/views/<id>/report` が 200 で群と合計を返した。**
    //    **別アプリを1つ作ると `count` が 1 → 2 に増えた** —— **アプリの外の行を数えていた。**
    //  - **`join[].table` / `group_by[].table` / `aggregates[].table` / `reference_table` は
    //    `resource_id` なので、3本とも 400 で拒まれる**(実測)。**`_ai_usage` は
    //    `view.table` でも 400 である。**
    // **したがって今日この分岐が塞ぐのは `_apps` と `_changelog` の2本である**
    // (**`_ai_usage` はそもそも宣言できない**)。
    //
    // **【越えてはならない線は上と同じ】** **`isSystemTableId` は表の識別子だけを見る。**
    // **アプリの表には1バイトも掛からない**(`_` 始まりのIDは定義できない)。
    // **判定の綴りも上と同じ1本(`forbiddenSystemTableReadError`)であり、2本目の
    // 判定を作っていない。**
    const reportViewId = c.req.param("view_id");
    if (method === "GET" && reportViewId !== undefined && !user.roles.includes("owner")) {
      let reportTableId: string | undefined;
      try {
        const loaded = loadManifest(appId);
        reportTableId = loaded.ok
          ? loaded.value.app.views.find((candidate) => candidate.id === reportViewId)?.table
          : undefined;
      } catch {
        reportTableId = undefined;
      }
      if (reportTableId !== undefined && isSystemTableId(reportTableId)) {
        return c.json(errorBody([forbiddenSystemTableReadError(reportTableId)]), 403);
      }
    }
    await next();
  };
  app.use("/api/apps/:app_id/tables/:table_id/records", recordsAuthMiddleware);
  app.use("/api/apps/:app_id/tables/:table_id/records/:record_id", recordsAuthMiddleware);
  /*
   * **集計表の読み取りも、レコードの読み取りとまったく同じ認証の扱いにする**
   * (`V8-M8`。台帳 `Q-G1`)—— **同じ middleware を1行足すだけで、2本目の判定を作らない。**
   *
   * **【この経路では `:table_id` が無い。何が起きるかを名指しで書く】**
   *  - `rejectNamedView` は `urlTableId === undefined` を受ける形になっている(既存)ので、
   *    **`?view=` を書いた要求では画面の面の規則が今日どおり効き、表との一致だけが見られない。**
   *  - **未認証は必ず 401 である** —— **匿名公開の窓(`st_public`)は対象の表を解決してから
   *    開くが、この経路には表が無いので1度も開かない。** **閉じる側に倒れている。**
   *  - **`D-V8-74`(システムが持つ表の読取は持ち主だけ)の分岐は `isSystemTableId(undefined)`
   *    が偽になるので、1度も評価されない。** **集計表の対象表がシステムの表であっても
   *    ここでは止まらない** —— **【正直に書く】これは今日開いている穴である。**
   *    **`V8-M10` が可視性を掛けるときに、ここも一緒に見ること。**
   *    **【`V8-M10-T02` による引き直し。上の3行を1バイトも消していない】** ——
   *    **`:table_id` を見る分岐が評価されないことは今日も真だが、その**すぐ下**に
   *    `:view_id` から対象表を引く分岐を1本足した。** **穴は塞がっている。**
   *    **足す前に、実際に `{ type: "report_view", table: "_apps" }` の差分が 201 で通り、
   *    `GET …/report` が 200 を返すことを実測した**(`v8-m10.md` §3)——
   *    **画面の対象表の値域は `resource_id` ではなく `view_table_id` であり、
   *    `_apps` / `_changelog` を通すからである。** **発火しない分岐ではない。**
   *    **実 HTTP の検査は `src/server/system-table-owner-read.test.ts` の (g)。**
   *
   * **【正直に書く】この middleware が担うのは「ログインしているか」までである。**
   * **`V8-M8` は集計に可視性(誰に何が見えるか)を1つも掛けていない** —— **掛けるのは
   * `V8-M10` である**(実測は `src/server/report-declaration-boundary.test.ts` の (28))。
   *
   * **【2026-08-16 訂正(`V8-M13-T04`。台帳 `Q-G30`)。直前の2行を1バイトも書き換えていない】**
   * **その `V8-M10` はここである** —— **集計の母集団には、この middleware を通った人が
   * 読める行だけが入るので、見る人によって数が変わる。** **この middleware 自身が担うのは
   * 今日も「ログインしているか」までであり、そこは1ミリも変わっていない。**
   * **【禁止】これを「集計に権限が効くようになった」と書かない** —— **島が `output_table` へ
   * 書いた表には1ミリも掛からず、受信口・ワークフロー・`schedule` は今日も素通りである。**
   */
  app.use("/api/apps/:app_id/views/:view_id/report", recordsAuthMiddleware);

  // --- バッチ書込の認証境界(V2-M4-T01 / ADR-0039)-----------------------------------
  //
  // `POST /api/apps/:app_id/batch`(複数テーブルへの原子書込)は **認証必須 + editor/owner
  // のみ**。バッチは1リクエストで**複数テーブル・複数行**を跨ぐので、records middleware の
  // ような**テーブル単位**の customer/public スコープ判定(owner-scope の post-filter /
  // スタンプ)を1経路で正しくは掛けられない —— **T01 では fail-closed で運営ロール(editor/
  // owner)に限定**し、customer/viewer/未認証は 403/401 で塞ぐ(個人スコープ横断は T01 の
  // 範囲外。§申し送り)。POST なので Origin 検査(records と同一規律。ADR-0014 §5)を掛ける。
  const batchAuthMiddleware: MiddlewareHandler<AuthEnv> = async (c, next) => {
    const appId = c.req.param("app_id") as string;
    const appError = ensureApp(appId);
    if (appError !== null) {
      return c.json(errorBody([appError]), 404);
    }
    // 状態変更(POST)は Origin(無ければ Referer)を検査する(records と同一規律)。
    const origin = c.req.header("origin") ?? refererOrigin(c.req.header("referer"));
    if (origin !== undefined && !authConfig.expectedOrigins.includes(origin)) {
      return c.json(errorBody([originRejectedError(origin, authConfig.expectedOrigins)]), 403);
    }
    // per-app セッション解決 → 有効なら context にユーザを載せる(records と同型)。
    const sessionId = getCookie(c, "st_session");
    if (sessionId !== undefined && sessionId !== "") {
      const store = AuthStore.openForApp(dataRoot, appId);
      try {
        const session = resolveSession(store, sessionId);
        if (session !== null) {
          const user = store.findUserById(session.userId);
          if (user !== undefined) {
            c.set("user", {
              id: user.id,
              username: user.username,
              displayName: user.displayName,
              role: user.role,
              // **実効ロール集合**(`V8-M16` / `J-G3`)。**列の1値 ∪ 付与表。**
              roles: store.effectiveRoles(user.id),
            });
          }
        }
      } finally {
        store.close();
      }
    }
    // --- 画面ごとの「見せる相手」(`B-G1` / `ADR-0070` 限定3)---------------------------
    //
    // **`V4-FIX1` 項目(1) で足した。** それまで**この判定はバッチ経路に1行も無く**、
    // `docs/evidence/cp-v4.md` §6-3 の #10 が**同一セッション・同一画面IDの対照**で
    // 「`GET .../records?view=X` = 403 / `POST .../batch?view=X` = 200(行が作られた)」を
    // 実測していた。**宣言した境界がバッチ経路で迂回できていた。**
    //
    // **判定は単件経路と同じ `rejectNamedView` 1本**(述語を2箇所に書かない)。
    // **順序も単件経路に合わせる** —— 画面の判定を 401 の**手前**に置く
    // (`ADR-0003` §7「入口を何本生やしても振る舞いが一致する」)。
    //
    // **URL の表を渡さない**(`undefined`)—— バッチは1リクエストで複数テーブルを跨ぐので
    // 比べる相手が1つに決まらない。**したがって表の一致は検査していない**
    // (`batch-view-audience.test.ts` (Y) がこの限界を固定する)。
    // **語彙は1つも増えていない**(`schemas/` と `src/kernel/` に0バイト)。
    const batchUser = c.get("user");
    // **【`V8-M16` / `J-G3`】実効ロール集合を渡す。**
    const viewRejection = rejectNamedView(appId, undefined, c, batchUser?.roles ?? null);
    if (viewRejection !== null) {
      return viewRejection;
    }

    const user = c.get("user");
    if (user === undefined) {
      return c.json(errorBody([unauthenticatedError(appId)]), 401);
    }
    // 書込は editor/owner のみ(viewer / customer は 403)。バッチに公開/匿名窓は開けない。
    // **【`V8-M16` / `J-G3`】実効ロール集合で判定する(和集合1本)。**
    //
    // **【`V8-M27-T03` / ユーザ決定 `D-V8-71`。この middleware に面の判定を足さなかった理由】**
    //
    // **表の面の判定はこの middleware には置けない** —— **可否は要求の中身(`ops` が触る表)で
    // 決まるが、ここは本体を1バイトも読んでいない**(読むと、下流の `c.req.raw` の
    // ストリームの扱いが1本増える)。**したがって表の面は 7.1 のハンドラ(この middleware の
    // 下流にある同じパスの登録)が op ごとに当てており、その doc に「どの表の権限を見るか」の
    // 決定を書いた。** **【この doc に経路の登録の字面を書かない】** ——
    // **`src/server/entry-point-inventory.test.ts` の口の数え上げは `app.ts` を正規表現で
    // 走査しており、コメントの中の登録の字面まで1本として数える**(実測。48本になって赤くなった)。
    // **`V8-M27-T03` の着手時に実測したところ、その配線は `V8-M17` / `V8-M19` の時点で
    // 既に在り、`src/server/batch-files-role-access.test.ts` の (a) / (b) / (c) は
    // 1バイトも足さずに緑だった** —— **本タスクがまとめ書き込みへ足したのは検査と、
    // この決定の記述だけである。**
    //
    // **画面の面(`{target:"view"}`)はこの middleware が当てている** —— **すぐ上の
    // `rejectNamedView` がそれであり、`judgeRoleAccess` を呼ぶのはその中である**
    // (**この関数の本文に `judgeRoleAccess` の字面が無いのは、判定を持っていないからではない**)。
    //
    // **【この時点で壁が2枚並んでいる。事実として書く】** —— **下の `hasAdminWriteRole`
    // (古い層)と、ハンドラの面の判定が、同じ要求に順に掛かる = 今日の可否は2枚の AND である。**
    // **古い層の撤去は `V8-M27` の次のタスクであり、それまでは面が許した相手も
    // `viewer` / 宣言された種類であればこの1行で止まる。**
    //
    // --- 【`V8-M27-T04` / `T-G5`】**上の段落は今日から偽である。旧文を1バイトも消していない** ---
    //
    // **ここに在ったもの(逐語)**:
    //
    //     if (!hasAdminWriteRole(user.roles)) {
    //       return c.json(errorBody([forbiddenWriteError()]), 403);
    //     }
    //
    // **壁は1枚になった** —— **残ったのは 7.1 のハンドラが op ごとに当てる面の判定である**
    // (`D-V8-71` の逐語「まとめ書き込みとファイルのアップロードにも役割の規則を効かせてから、
    // 古い層を外します」の後半の履行)。**`viewer` と宣言された種類は、面が
    // 「触る表すべてに書込を許している」ときだけ通る**(`AND`。要求が表を名指ししている)。
    // **未認証は今日どおり 401 である**(すぐ上の1行。**認証境界は1バイトも開いていない**)。
    await next();
  };
  app.use("/api/apps/:app_id/batch", batchAuthMiddleware);

  // --- 手動起動の入口(`V5-M25-T05` / `L-G12` / `ADR-0176`)---------------------------
  //
  // **入口は HTTP に1本だけである**(限定1)。**MCP には1本も足していない**(限定2)——
  // **帰属先の申告(`ADR-0007` §1d 歯止め3)は `ADR-0176` §Context 2 が済ませている**
  // (答え = **MCP 層には帰属しない**)。**本数を機械的に固定する検査は
  // `src/server/entry-point-inventory.test.ts` の1本だけである**(限定6)。
  //
  // ## **判定の順序と、それぞれが何を守るか**
  //
  //  1. アプリの実在(404)/ Origin(403)—— **既存のレコード経路と同じ規律**(`ADR-0014` §5)。
  //  2. セッション解決 → **未ログインは 401**(限定4。**匿名からは1本も通さない**)。
  //  3. **画面単位の面の規則**(403)—— **判定は `owner-scope.ts` の `judgeRoleAccess` 1本**
  //     (ここに条件式を書かない)。**開けない画面からは起こせない。**
  //     **【`V8-M20` / `J-G27`】旧層(`view.audience`)はここから撤去した。**
  //  4. **その画面がその自動処理を宣言しているか**(400)—— **宣言していないものは起こせない。**
  //     **これが「どのワークフローでも起こせる」を作らない側の実行時の担保である**
  //     (apply 時の側は `referential-integrity.ts`)。
  //  5. **操作起点単位の `audience`**(403)。**【ここが `V5-M23` と非対称である。隠さない】**
  //     **`ADR-0177` 限定6 は「サーバの応答を1バイトも変えない」と定め、`V5-M23-T05` は
  //     レコード経路がこの宣言を1バイトも読まないことを実測した**(`v5-m23.md` §5 の (C) 群)。
  //     **本入口はそれを読む。** **既存の応答は1バイトも変わっていない**(読むのはこの新しい
  //     経路だけで、`src/server/owner-scope.ts` は1バイトも書き換えていない)が、
  //     **同じ宣言が経路によって効いたり効かなかったりする状態になった。**
  //     **そう決めた理由**: **`ADR-0176` 限定5 の逐語「一覧にボタンが出ない相手が入口を
  //     直接叩いても 403 になる検査」であり、先回りガードを**処理を起こす経路**で
  //     防御に格上げしないと「見えないだけで叩けば処理が走る」が残るからである。**
  //     **【禁止】これを「`audience` が権限になった」と書かない** ——
  //     **レコードの読み書きでは今日も先回りガードのままである。**
  //  6. **ロール**(403)—— **書ける相手だけが起こせる。** **`viewer` は起こせない。**
  //     **`customer` は対象表が個人スコープ(`st_owner`)のときだけ起こせる**
  //     (`customerTableAccess` = レコード経路と同じ1本)。
  //  7. **在席台帳**(409)—— **`ADR-0175` の規則。** **最後に置く** —— **断られる相手に
  //     在席を持たせない**(持たせると、権限の無い要求が正当な要求を締め出せる)。
  //
  // ## **在席の窓は「要求の処理が入口を通ってから応答を返すまで」である**
  //
  // **`await next()` を挟むので、重なった要求は実際に重なる。** **カーネルの中で取って
  // 中で返すと、実行が同期なので窓に入る余地が構造的に無く、規則が飾りになる**
  // (`workflow-runner.ts` の `manualRunsInFlight` の doc に理由を書いた)。
  // **【正直に書く】プロセスが2本立つ配布物では1ミリも効かない**(`ADR-0175` §限界3)。
  const manualRunAuthMiddleware: MiddlewareHandler<AuthEnv> = async (c, next) => {
    const appId = c.req.param("app_id") as string;
    const viewId = c.req.param("view_id") as string;

    const appError = ensureApp(appId);
    if (appError !== null) {
      return c.json(errorBody([appError]), 404);
    }
    const origin = c.req.header("origin") ?? refererOrigin(c.req.header("referer"));
    if (origin !== undefined && !authConfig.expectedOrigins.includes(origin)) {
      return c.json(errorBody([originRejectedError(origin, authConfig.expectedOrigins)]), 403);
    }

    const resolved = resolveRecordsUser(appId, c);
    if (resolved !== undefined) {
      c.set("user", resolved);
    }
    const user = c.get("user");
    if (user === undefined) {
      // **公開窓を1つも開けない**(限定4)—— **匿名の窓は読み取りだけであり、
      // 処理を起こす経路にその窓は無い。**
      return c.json(errorBody([unauthenticatedError(appId)]), 401);
    }

    let manifest: Manifest | undefined;
    try {
      const loaded = loadManifest(appId);
      manifest = loaded.ok ? loaded.value : undefined;
    } catch {
      manifest = undefined;
    }
    const view = manifest?.app.views.find((candidate) => candidate.id === viewId);
    if (manifest === undefined || view === undefined) {
      return c.json(errorBody([unknownViewError(viewId)]), 404);
    }
    // **【`V8-M20` / `J-G27`】旧層(`view.audience`)の 403 は撤去した。**
    // **【`V8-M17` / `J-G8`】面の**画面**の規則。**
    // **開けない画面からは起こせない**(この入口の判定の順序 3 と同じ趣旨)。
    if (
      !judgeRoleAccess({
        manifest,
        roles: user.roles,
        target: { target: "view", view: viewId },
        verb: "read",
      }).allowed
    ) {
      return c.json(errorBody([forbiddenRoleAccessError(`画面 "${viewId}"`, "閲覧")]), 403);
    }

    const workflowId = c.req.query("workflow") ?? "";
    const recordId = c.req.query("record") ?? "";
    const runActions = declaredRunActions(view);
    const declaredRuns = runActions.map((action) => action.run);
    if (workflowId === "" || recordId === "") {
      return c.json(errorBody([manualRunMissingParamsError(declaredRuns)]), 400);
    }
    // **その画面が宣言している操作起点だけを受ける**(`ADR-0174` 限定2 / 限定4)。
    const declared = runActions.find((action) => action.run === workflowId);
    if (declared === undefined) {
      // --- 【`V8-M38` / `F-G6`】**`set` 型のボタンを、判定の前に黙って落とすのをやめた** ---
      //
      // **着手前ここは、この行の直後の 400 だけであった**(旧の逐語):
      //
      //     if (declared === undefined) {
      //       return c.json(errorBody([manualRunNotDeclaredError(viewId, workflowId, declaredRuns)]), 400);
      //     }
      //
      // **その結果、`set` 型のボタンを名指しした要求は、そのボタンの規則を持つ人と
      // 持たない人で応答が1バイト違わなかった**(`v8-m35-prestate-m33.md` §C-2)。
      //
      // **今日の判定の順序は「宣言の確認 → 面の判定 → 起こせるかの確認」である。**
      // **面の判定は既存の `judgeRoleAccess` 1本をそのまま呼ぶ**(ここに条件式の家を作らない)。
      //
      // **【禁止】これを「ボタンの規則が効くようになった」と書かない** ——
      // **効くようになったのは `run` の口の入口の判定だけである。**
      // **`PATCH …/records` 経路の同じ規則の評価(`owner-scope.ts` の
      // `isRoleActionWriteAllowed`)は着手前から在り、`V8-M38` は1バイトも触っていない。**
      const setAction = declaredSetActionById(view, workflowId);
      if (setAction !== undefined) {
        if (
          !judgeRoleAccess({
            manifest,
            roles: user.roles,
            target: { target: "action", view: viewId, action: setAction.id },
            verb: "read",
          }).allowed
        ) {
          // **【`V8-M39` / 台帳 `F-G7`】旧(逐語)**:
          //
          //     return c.json(errorBody([forbiddenRoleAccessError(`ボタン "${viewId}"`, "実行")]), 403);
          //
          // **`viewId` は**画面**のIDであって、ボタンのIDではない**
          // (`cp-v8-unify.md` §20-D の 1 が実測した欠陥)。**直上の判定が名指ししている
          // のは `setAction.id` のほうであり、それは既にこの枝で読めている。**
          return c.json(
            errorBody([forbiddenRoleAccessError(`ボタン "${setAction.id}"`, "実行")]),
            403,
          );
        }
        return c.json(
          errorBody([manualRunNotRunnableActionError(viewId, setAction.id, declaredRuns)]),
          400,
        );
      }
      return c.json(errorBody([manualRunNotDeclaredError(viewId, workflowId, declaredRuns)]), 400);
    }
    // **【`V8-M20` / `J-G29`】操作起点単位の `audience` の 403 は撤去した。**
    // **【`V8-M17` / `J-G9`】面の**ボタン**の規則。**
    // **識別子(`view_action.id`)を書いていない操作起点は面から名指しできないので、
    // ここでは管轄外(全許可)になる** —— **`judgeRoleAccess` がそう返す。**
    //
    // **【`V8-M39` / 台帳 `F-G7`】ボタンのIDを1本の `const` に束ねた。旧(逐語)**:
    //
    //     if (
    //       typeof (declared as unknown as { id?: unknown }).id === "string" &&
    //       !judgeRoleAccess({
    //         manifest,
    //         roles: user.roles,
    //         target: {
    //           target: "action",
    //           view: viewId,
    //           action: (declared as unknown as { id: string }).id,
    //         },
    //         verb: "read",
    //       }).allowed
    //     ) {
    //       return c.json(errorBody([forbiddenRoleAccessError(`ボタン "${viewId}"`, "実行")]), 403);
    //     }
    //
    // **判定の中身は1ミリも変えていない**(同じ `judgeRoleAccess` を同じ引数で1回呼ぶ)——
    // **変えたのは、文面に渡す文字列が `viewId`(**画面**のID)から
    // `declaredActionId`(**ボタン**のID)になったことだけである。**
    const declaredActionId = (declared as unknown as { id?: unknown }).id;
    if (
      typeof declaredActionId === "string" &&
      !judgeRoleAccess({
        manifest,
        roles: user.roles,
        target: { target: "action", view: viewId, action: declaredActionId },
        verb: "read",
      }).allowed
    ) {
      return c.json(
        errorBody([forbiddenRoleAccessError(`ボタン "${declaredActionId}"`, "実行")]),
        403,
      );
    }

    const workflow = (manifest.app.workflows ?? []).find(
      (candidate) => candidate.id === workflowId,
    );
    if (workflow === undefined || workflow.trigger.type !== "manual") {
      return c.json(errorBody([manualRunNotManualError(workflowId, declaredRuns)]), 400);
    }
    const triggerTable = resolveTable(manifest, workflow.trigger.table);
    if (triggerTable === undefined) {
      return c.json(
        errorBody([kernelUnknownTableError(manifest, workflow.trigger.table)]),
        400 as const,
      );
    }
    // **ロール。** **判定は既存の述語をそのまま呼ぶ**(ここに条件式の家を作らない)。
    // **【`V5-M17-T05` / `T06` によるマージ時の追随。`V5-M25` の判定を1ミリも変えていない】**
    // **`V5-M25` が書いた逐語は `if (user.role === "customer") { if (customerTableAccess(...)` で
    // あった。****`V5-M17` が (a) 等値比較を `isReservedRole` の否定に置き換え、
    // (b) `customerTableAccess` を `nonAdminTableAccess` に改名したので、その2点だけを当てた。**
    // **宣言された種類も `customer` とまったく同じ判定を受ける**(`ADR-0158` 限定2)。
    // **【`V8-M16` / `J-G3`】実効ロール集合で判定する(和集合1本)。**
    //
    // --- 【`V8-M27-T04` / `T-G5`】**この段(6. ロール)は撤去した。旧文を1バイトも消していない** ---
    //
    // **ここに在ったもの(逐語)**:
    //
    //     if (!user.roles.some(isReservedRole)) {
    //       if (nonAdminTableAccess(triggerTable) !== "scoped") {
    //         return c.json(errorBody([forbiddenWriteError()]), 403);
    //       }
    //     } else if (!hasAdminWriteRole(user.roles)) {
    //       return c.json(errorBody([forbiddenWriteError()]), 403);
    //     }
    //
    // **代わりに受けるのは、この middleware に既に在る 3.(画面の面)と 5.(ボタンの面)である**
    // —— **どちらも `judgeRoleAccess` 1本であり、`V8-M26` が既定を閉じたので、規則を1本も
    // 書いていない画面・ボタンからは今日も起こせない。**
    //
    // **【実際に変わったこと】**
    //  - **`viewer` が起こせるようになった**(旧: `hasAdminWriteRole` が必ず 403)。
    //  - **非運営の役割が、`st_owner` を持たない表からも起こせるようになった**
    //    (旧: `nonAdminTableAccess(triggerTable) !== "scoped"` で必ず 403。
    //    **表の作りだけで決まっており、規則を何本書いても届かなかった**)。
    //
    // **【正直に書く】この段の撤去で `triggerTable` を可否に使う箇所は0本になった** ——
    // **`triggerTable` は今日も解決している**(実在しない表を 400 で弾く 4. の一部であり、
    // **そちらは可否の判定ではない**)。
    //
    // **【禁止の履行】「上の入口が守っている」と書かない** —— **守っているのは
    // 画面とボタンの2つの面だけであり、対象の表そのものを見る判定は1本も残っていない。**
    // **その表に書込の規則を持たない相手でも、画面とボタンが開いていれば起こせる**
    // (自動処理が何を書くかは、この入口が1バイトも見ていないためである)。

    // **在席台帳(`ADR-0175`)。** **最後に取り、`finally` で必ず返す。**
    const release = beginManualRun({ app: appId, workflow: workflowId, record: recordId });
    if (release === null) {
      return c.json(errorBody([manualRunInProgressError(workflowId, recordId)]), 409);
    }
    try {
      await next();
    } finally {
      release();
    }
  };
  app.use("/api/apps/:app_id/views/:view_id/actions/run", manualRunAuthMiddleware);

  /*
   * **手動起動(`V5-M25-T01` / `V5-M25-T05` / `V5-M25-T06`)。**
   *
   * **HTTP ルートの45本目である**(44 → 45。`ADR-0176` 限定1)。
   * **対象は押した行1行だけである**(`ADR-0174` 限定3)—— `record` は1つしか受けない。
   * **引数を1つも受けない**(限定4)—— **本文を1バイトも読まない。**
   * **一括起動・状態照会・取り消しの口を1つも作っていない**(`ADR-0176` 限定1)。
   */
  app.post("/api/apps/:app_id/views/:view_id/actions/run", (c) => {
    const appId = c.req.param("app_id");
    const workflowId = c.req.query("workflow") as string;
    const recordId = c.req.query("record") as string;
    const loaded = loadManifest(appId);
    if (!loaded.ok) {
      return c.json(errorBody(loaded.errors), 404);
    }
    const manifest = loaded.value;
    // middleware が既に「実在する / `manual` である / この画面が宣言している」を確かめている。
    const workflow = (manifest.app.workflows ?? []).find(
      (candidate) => candidate.id === workflowId,
    ) as Workflow;
    const tableId = workflow.trigger.table as string;
    const table = resolveTable(manifest, tableId) as Table;
    const actor = c.get("user") as AuthUser;

    // 適用中(apply 窓)なら1バイトも走らせずに 409(既存の書込経路と同じ規律。`ADR-0017`)。
    const applying = isApplyInProgress(dataRoot, manifest.app.id);
    if (applying.inProgress) {
      return c.json(errorBody([applyInProgressError(applying)]), 409);
    }

    return withAppDb(dataRoot, manifest.app.id, (db) => {
      const existing = getRecord(db, manifest, tableId, recordId);
      if (!existing.ok) {
        return c.json(errorBody(existing.errors), 400);
      }
      if (existing.value === null) {
        return c.json(errorBody([unknownRecordError(tableId, recordId)]), 404);
      }
      // **個人スコープ**(`ADR-0016`)—— **他人 / 不可視の行は 404 で伏せる**
      // (レコード経路と同じ判定。**見えない行を対象に処理を起こせない**)。
      if (
        personalOwnerField(table) !== undefined &&
        !isOwnerVisible(existing.value[OWNER_FIELD], actor.id)
      ) {
        return c.json(errorBody([unknownRecordError(tableId, recordId)]), 404);
      }
      // **行ごとのアクセス権**(`Z-G11` / `V7-M3-T02`)—— **個人スコープの直後に置く。**
      // **関門の順序は「(1) 見えないなら 404 → (2) 見えるが書けないなら 403」**
      // (単件 `PATCH` とまったく同じ並び。`v7-m0.md` §5-4 (vi) の (2)(3))。
      // **判定は `owner-scope.ts` の1本**(ここに条件式を書かない。`ADR-0061` 限定4)。
      //
      // **【`write` で止める裁定は `V7-M3-T02` が下した。理由を書く】** ——
      // **操作起点は「押した行1行に対して処理を起こす」入口であり、その処理は行を書き換える
      // ことができる**(`ADR-0174` 限定3)。**読むだけの人が書き換えを起こせる形を作らない。**
      // **【正直に書く。これは強い側に倒した判断である】** —— **1行も書かないワークフロー
      // (通知だけ、など)も、読むだけの人からは起こせなくなる。** **起こせる範囲を
      // ワークフローの中身で見分ける仕組みは1つも無い。**
      {
        const judge = recordAccessJudge(
          { dataRoot, appDb: () => db },
          manifest,
          tableId,
          actor.id,
          recordAccessSourceTables(manifest, tableId),
          // **【`V8-M19`】面をここへ渡す** —— **合成は `owner-scope.ts` の1本が行う。**
          actor.roles,
        );
        if (judge !== undefined) {
          const access = judge(existing.value as Record<string, unknown>);
          // **上限に当たったら「見えない」に丸めない**(`Z-G17` / `V7-M4-T04`)——
          // **黙って打ち切ると「隠れた行がある」と区別できない。**
          if (access.kind === "limit_exceeded") {
            return c.json(errorBody([recordAccessLimitError(access.limit)]), 400);
          }
          if (!access.verdict.read) {
            return c.json(errorBody([unknownRecordError(tableId, recordId)]), 404);
          }
          if (!access.verdict.write) {
            return c.json(errorBody([forbiddenRecordWriteError()]), 403);
          }
        }
      }

      /*
       * **押した人を既存の監査記録に残す**(ユーザ決定 `D-V5-83`。`V5-M25-T06`)。
       *
       * **変更履歴(`_workflow_history` の5列)は1バイトも触っていない**
       * (`ADR-0072` 限定3 / `ADR-0174` 限定10 / `ADR-0175` 限定5)——
       * **`L-G11b` の保留を1ミリも覆していない。**
       * **したがって履歴画面には出ない** —— **運営者は管理画面の操作記録
       * (`GET /api/apps/:app_id/auth/activity`。owner のみ)を見に行く必要がある。**
       * **【禁止】「誰が押したかが記録に残るようになった」を、履歴画面について書かない。**
       *
       * **カーネルの実行と同じ接続で、実行の前に書く。** **`writeWithAudit` を使わない**
       * のは、あれが「レコード書込1件 + 監査1行」を1つの tx に束ねる器であり、
       * **手動起動はレコード書込ではない**からである(束ねる相手が違う)。
       * **【正直に書く】したがって、この監査行とワークフローの書込は同じ tx に無い** ——
       * **ワークフローのアクションが失敗しても、この行は残る。** **それは意図した側である**
       * (「押されたこと」は成否によらず起きた事実である)。**成否はこの行に1文字も入らない。**
       */
      ensureAuthActivitySchema(db);
      recordActivity(db, {
        userId: actor.id,
        username: actor.username,
        action: MANUAL_RUN_ACTIVITY_ACTION,
        tableId,
        recordId,
      });

      /*
       * **押した人を渡す**(`V5-M25-T04` / `L-G11a` / `ADR-0175` §6-3)。
       * **`act_as` の宣言があればそれが勝ち、無ければこの人として書かれる。**
       * **【隠さない】押した人と `act_as` が違うとき、利用者にはそれが見えない**
       * (`ADR-0175` §限界5: 本 ADR は表示を1つも作っていない)。
       */
      const failures = runManualWorkflow(db, manifest, workflow, existing.value, actor.id);
      return c.json({ workflow: workflowId, record: recordId, failures });
    });
  });

  // --- アップロード認証境界(V2-M2-T02 / ADR-0035 §1・限定5)-------------------------
  //
  // `POST /api/apps/:app_id/files`(画像と一般のファイルのアップロード)は **認証必須**
  // (未認証 401)で、**書込は一切公開しない**。認可は records 書込と同水準(editor/owner のみ)
  // —— ファイルのアップロードはアプリを育てる側の操作なので viewer/customer は 403。
  //
  // **【`V5-M16-T06` / `G-G14`】旧コメントは「商品画像のアップロードは運営操作」「customer の
  // アップロードは EC スコープ外」と書いていた。** **この前提は今日の語彙には合わない**
  // —— **`file` 型は業種を選ばず、customer が自分で添付を上げたい場面は普通にある。**
  // **ただし今日それは実装していない**(customer は今日も 403 である)。
  // **できないことを、できないと書く。**
  // POST なので Origin 検査(records と同一規律。ADR-0014 §5)を掛ける。配信(GET /files/:file_id)
  // は T03 の担当で別パスなのでこの middleware には掛からない(read-only を経路分離で守る)。
  const filesAuthMiddleware: MiddlewareHandler<AuthEnv> = async (c, next) => {
    const appId = c.req.param("app_id") as string;
    const method = c.req.method;

    const appError = ensureApp(appId);
    if (appError !== null) {
      return c.json(errorBody([appError]), 404);
    }

    if (method === "POST" || method === "PATCH" || method === "DELETE") {
      const origin = c.req.header("origin") ?? refererOrigin(c.req.header("referer"));
      if (origin !== undefined && !authConfig.expectedOrigins.includes(origin)) {
        return c.json(errorBody([originRejectedError(origin, authConfig.expectedOrigins)]), 403);
      }
    }

    const sessionId = getCookie(c, "st_session");
    if (sessionId !== undefined && sessionId !== "") {
      const store = AuthStore.openForApp(dataRoot, appId);
      try {
        const session = resolveSession(store, sessionId);
        if (session !== null) {
          const user = store.findUserById(session.userId);
          if (user !== undefined) {
            c.set("user", {
              id: user.id,
              username: user.username,
              displayName: user.displayName,
              role: user.role,
              // **実効ロール集合**(`V8-M16` / `J-G3`)。**列の1値 ∪ 付与表。**
              roles: store.effectiveRoles(user.id),
            });
          }
        }
      } finally {
        store.close();
      }
    }

    const user = c.get("user");
    if (user === undefined) {
      return c.json(errorBody([unauthenticatedError(appId)]), 401);
    }
    // 書込と同水準の認可(editor/owner)。viewer / customer は 403。
    // **【`V8-M16` / `J-G3`】実効ロール集合で判定する(和集合1本)。**
    //
    // --- 【`V8-M27-T04` / `T-G5`】**この2行は撤去した。旧文を1バイトも消していない** ---
    //
    // **ここに在ったもの(逐語)**:
    //
    //     if (!hasAdminWriteRole(user.roles)) {
    //       return c.json(errorBody([forbiddenWriteError()]), 403);
    //     }
    //
    // **代わりに受けるのは、すぐ下の面の判定である**(`D-V8-71` / `V8-M27-T03` が配線した)。
    // **`viewer` と宣言された種類は、`image` / `file` 項目を持つ表のどれか1つにでも
    // 面が書込を許していれば上げられる**(`OR`。理由は下の doc)。
    // **未認証は今日どおり 401 である**(すぐ上の1行)。
    // --- 面(役割に束ねた権限)の規則(`V8-M27-T03` / ユーザ決定 `D-V8-71`)-----------------
    //
    // **`D-V8-71` の説明文の逐語**:
    // > **まとめ書き込みとファイルのアップロードにも役割の規則を効かせてから、古い層を外します。**
    // > **穴が一瞬も開きませんが、この回の作業が増えます。**
    //
    // **【この時点で壁が2枚並んでいる。事実として書く】** —— **すぐ上の
    // `hasAdminWriteRole`(「運営の予約3ロールか否か」の古い層)と、下の面の判定が、
    // 同じ要求に順に掛かる。** **要求は両方を通らなければ先へ進まない = 今日の可否は
    // 2枚の AND である。** **古い層の撤去は `V8-M27` の次のタスクである** ——
    // **したがって今日は、面が許しても `viewer` / 宣言された種類のユーザは上の1行で
    // 止まる。** **面だけを見て「この人は上げられる」と読んではならない。**
    //
    // ## 「どの表の権限を見るか」(**本タスクで決めた。決定の主体は実装側である**)
    //
    // **まず実測**: **この要求は表を1つも名乗らない。** **`multipart` のパートは `kind` と
    // `file` の2つだけで**(7.5 のハンドラ)、**書き込む先はシステムテーブル `_files` である。**
    // **`_files` は `D-V8-69` により面の管轄外なので、`{target:"table", table:"_files"}` を
    // 判定に掛けても必ず「管轄外 = 全許可」が返る**(= **判定にならない**)。
    // **したがって「アップロードが結び付く表」は、要求からは決まらない。**
    //
    // **決めたこと**: **上げたファイルが最終的に着地しうる先 —— `image` / `file` 型の項目を
    // 持つ表 —— を全部集め、そのうち1つでも書込が許されていれば通す**(`OR`)。
    // **1つも許されていなければ 403。** **着地しうる表が0件のアプリも 403 である。**
    //
    // **理由**: **`file_id` は行の `image` / `file` 項目に書いて初めて意味を持つ。**
    // **どの表にも書けない人が上げた `file_id` は、どこにも着地できない** ——
    // **それでも受け取ると、blob だけが積み上がる。** **0件のアプリを通さないのも同じ理由で、
    // **`V8-M26` が採った向き(「書いていなければ通らない」)に揃えている。**
    //
    // **`AND`(全部の表に書込が要る)を採らなかった理由**: **要求は1つの表も名乗っていない** ——
    // **`AND` にすると「`image` 項目を持つ表を1つ足した日に、それまで上げられていた人が
    // 上げられなくなる」** = **要求の中身と関係のない所で可否が動く。**
    // **まとめ書き込み(`AND`)と向きが違うのは、あちらが触る表を要求そのものが名指しして
    // いるからである**(7.1 のハンドラの doc)。
    //
    // **判定のロジックを2本目に作っていない**(`ADR-0305` 限定3)—— **`judgeRoleAccess` と
    // `roleGateBlocksWithoutGrants` をそのまま呼んでおり、ここに規則を読む条件式は1行も無い。**
    // **`roleGateBlocksWithoutGrants` を通しているので、点(行ごとの付与)が管轄内の表では
    // 面の拒否で短絡しない**(`OR` を `AND` に戻さない。`D-V8-23`)。
    //
    // **【この判定がしないこと。誇張しない】**
    //  - **項目(`field`)の規則を1バイトも見ていない** —— **どの項目に着地するかも要求から
    //    決まらないためである。** **項目の規則は着地の時(行の作成・更新)に掛かる。**
    //  - **`kind`(`image` / `file`)で候補の表を分けていない** —— **`image` 項目と `file` 項目を
    //    まとめて1つの候補集合にしている。** **`kind=image` で上げた `file_id` を `file` 項目へ
    //    書くことを、今日のカーネルは拒まない**(実在確認だけである)。
    //  - **配信(`GET /files/:file_id`)には1バイトも掛かっていない** —— **別経路であり、
    //    そちらは今日どおり参照元の行の可視性で決まる。**
    let filesManifest: Manifest | undefined;
    try {
      const loaded = loadManifest(appId);
      filesManifest = loaded.ok ? loaded.value : undefined;
    } catch {
      filesManifest = undefined;
    }
    // **マニフェストが読めなければ候補を1つも数えられない** —— **fail-closed で 403 に倒す**
    // (`recordsAuthMiddleware` の `nonAdminTableAccess` が壊れた manifest を `denied` に
    // 倒しているのと同じ向き)。
    const uploadLandingTables = (filesManifest?.app.tables ?? []).filter((table) =>
      table.fields.some((field) => field.type === "image" || field.type === "file"),
    );
    if (
      filesManifest === undefined ||
      !uploadLandingTables.some(
        (table) =>
          !roleGateBlocksWithoutGrants({
            role: judgeRoleAccess({
              manifest: filesManifest,
              roles: user.roles,
              target: { target: "table", table: table.id },
              verb: "write",
            }),
            grantGoverned: recordAccessSourceTables(filesManifest, table.id) !== undefined,
          }),
      )
    ) {
      // **表の名前を1つも書かない** —— **「どの表が在るか」を役割の外へ漏らさないためである。**
      return c.json(
        errorBody([forbiddenRoleAccessError("ファイルのアップロード", "書き込み")]),
        403,
      );
    }
    await next();
  };
  app.use("/api/apps/:app_id/files", filesAuthMiddleware);

  // --- アプリの作りを書き換える口の認証境界(V4-FIX1 項目(5))------------------------
  //
  // **ユーザ決定の逐語**(本タスクの指示):
  //   > **書き換えの口は塞ぐ。どんな画面が存在するのかを未ログインでも見せていいです。**
  //   > **アクセスしたらログイン必須です。書き換えの口をふさぐは必須です**
  //
  // **直す前の実測**(`docs/evidence/cp-v4.md` §9 の 14):**未認証の `POST /diffs`(正当な
  // `add_view` 1本)= 201(実際に画面が1本増えた)。未認証の `POST /undo` = 200。**
  // **アプリの作り(テーブル・画面・ワークフロー・テーマ)を、誰でも書き換えられた。**
  //
  // **`ADR-0014` §2 の免除リスト(manifest / diffs / undo / changelog / list_apps)のうち、
  // 書き換えの2本だけをここで塞ぐ。** **読取(manifest / changelog / undo/preview /
  // list_apps / requirements)は1本も塞いでいない** —— ユーザ決定が「どんな画面が存在するのかは
  // 未ログインでも見せてよい」と明言しているためである。**`E-G6`(`GET /manifest` を塞ぐ)は
  // 本タスクで1ミリも実施していない**(`ADR-0070` §3a-4 / `ADR-0074` §3a-3 / `ADR-0075` 限定6 が
  // 要求する3者の突き合わせを行っていないので、行ってはならない)。
  //
  // **`ADR-0075` §限界6 の逐語**「**`ADR-0014` §2 の免除リスト … を1行も見直していない。**」
  // —— **本タスクが見直した。** **`ADR-0014:84`(`ADR-0075` §2 が両方向にした歯止め)に従い、
  // `src/server/auth-boundary.test.ts` の境界表に #24 を追記した。**
  //
  // **ロールは owner。** 画面側は既に owner 専用だったが(`web/src/AppWorkspace.tsx` の
  // コメント逐語「**それでも担保はサーバ側に無い**」)、**サーバは1件も見ていなかった。**
  // 逃げ道 CSS / AI 能力 / 接続の管理(いずれも `requireOwner`)と同じ水準に揃える。
  //
  // **【MCP は1ミリも壊れない】** **MCP サーバは HTTP を1本も叩かず、カーネルを直接呼ぶ**
  // (`src/mcp/tools/write.ts` が `applyDiff` / `undo` / `redo` をカーネルから import。
  // 2026-08-03 に `src/mcp/` を走査して実測。HTTP クライアント呼び出しは0件)。
  // **したがって `ADR-0014` §3(MCP / ローカル HTTP に認証を掛けない)のうち、
  // MCP 側は1ミリも変わらない。** **変わったのはブラウザから叩く HTTP だけである。**
  //
  // **【塞いでいないもの。誇張しない】** **`GET /api/apps/:app_id/undo/preview` は今日も
  // 未認証で通る**(読取なので本タスクの射程外。ユーザ決定は書き換えの口だけを必須とした)。
  // **`GET /changelog` / `GET /requirements` も今日どおり未認証で、依頼文の逐語が読める。**
  const changeAuthMiddleware: MiddlewareHandler<AuthEnv> = async (c, next) => {
    const appId = c.req.param("app_id") as string;
    const appError = ensureApp(appId);
    if (appError !== null) {
      return c.json(errorBody([appError]), 404);
    }
    // 状態変更なので Origin(無ければ Referer)を検査する(records / batch / files と同一規律)。
    const origin = c.req.header("origin") ?? refererOrigin(c.req.header("referer"));
    if (origin !== undefined && !authConfig.expectedOrigins.includes(origin)) {
      return c.json(errorBody([originRejectedError(origin, authConfig.expectedOrigins)]), 403);
    }
    // per-app セッション解決。**`resolveRecordsUser` を使う** —— `app.sqlite` が無い/壊れて
    // いても 500 にせず「未認証」に倒す(`B-G6` が入れた規律をそのまま引き継ぐ)。
    const resolved = resolveRecordsUser(appId, c);
    if (resolved !== undefined) {
      c.set("user", resolved);
    }
    const user = c.get("user");
    if (user === undefined) {
      return c.json(errorBody([unauthenticatedError(appId)]), 401);
    }
    // =====================================================================================
    // **【`V8-M28` 第2波(2026-08-11)。台帳 `T-G15` / ユーザ決定 `D-V8-40` / `D-V8-49`。
    // 判定を役割の規則へ移した。旧の2行を逐語で残す】**
    // =====================================================================================
    //
    // **旧(逐語)**:
    //
    //     // **【`V8-M16` / `J-G3`】実効ロール集合に `owner` が1つでも在れば通る(和集合1本)。**
    //     if (!user.roles.includes("owner")) {
    //       return c.json(errorBody([appChangeOwnerRequiredError()]), 403);
    //     }
    //
    // **根拠**: **ユーザ決定 `D-V8-40` の依頼文の逐語「**定義を変えられる人を役割の規則で
    // かけるようにしたいです**」。** **器の取り方は `D-V8-49`(対象の値域を4種から6種へ)。**
    // **台帳 `ADR-0007` §8 の `T-G15`(門外・限定採用)。**
    //
    // **【この関門が掛かる口は2本である】** —— **`POST /api/apps/:app_id/diffs` と
    // `POST /api/apps/:app_id/undo`**(`src/server/change-routes.ts:188` / `:189` の `app.use`)。
    // **両方の挙動が今日から変わる。**
    //
    // **【判定の家は1本である】**(`ADR-0305` 限定3)—— **ここに規則を読む条件式を1行も
    // 書いていない。** **`judgeRoleAccess` が返した `allowed` を見るだけである。**
    //
    // **【マニフェストの取り方は既存の経路に倣った】** —— **手動起動の入口
    // (`POST /api/apps/:app_id/views/:view_id/run`)とまったく同じ形である**
    // (`loadManifest` を `try` で包み、読めなければ `undefined` に倒す)。**新しい読み方を
    // 発明していない。**
    //
    // **【読めないマニフェストは閉じる側に倒れる。隠さない】** —— **`undefined` を渡すと
    // `judgeRoleAccess` は「役割の宣言が0件」として `CLOSED_ROLE_ACCESS` を返す
    // (`D-V8-59` / `D-V8-65` の既定閉じ)。** **着手前は、マニフェストが壊れていても
    // `owner` なら書き換えられた。** **今日は 403 になる。** **アプリの実在そのものは
    // 上の `ensureApp` が既に 404 で分けているので、これは「壊れた定義を直す口」だけの話である。**
    //
    // **【未認証は今日どおり 401 である】** —— **上の `user === undefined` の分岐は
    // 1バイトも動かしていない。**
    let manifest: Manifest | undefined;
    try {
      const loaded = loadManifest(appId);
      manifest = loaded.ok ? loaded.value : undefined;
    } catch {
      manifest = undefined;
    }
    if (
      !judgeRoleAccess({
        manifest,
        roles: user.roles,
        target: { target: "app" },
        verb: "write",
      }).allowed
    ) {
      return c.json(errorBody([appChangeRuleRequiredError()]), 403);
    }
    await next();
  };
  // --- 認証エンドポイントの Origin 検査(CSRF 多重防御。ADR-0014 §5)-----------------
  //
  // 認証エンドポイント(register/login/logout)は状態変更なので、SameSite=Strict cookie に
  // 加えて Origin も検査する(records と同じ CSRF 多重防御)。認証そのものは要求しない
  // (これらは未認証で叩けなければ意味がない)。
  app.use("/api/apps/:app_id/auth/*", async (c, next) => {
    const method = c.req.method;
    if (method === "POST" || method === "PATCH" || method === "DELETE") {
      const origin = c.req.header("origin") ?? refererOrigin(c.req.header("referer"));
      if (origin !== undefined && !authConfig.expectedOrigins.includes(origin)) {
        return c.json(errorBody([originRejectedError(origin, authConfig.expectedOrigins)]), 403);
      }
    }
    return next();
  });

  // --- capability(connection)ルートの Origin 検査(CSRF 多重防御。V1-M4-T04 / ADR-0020 §2b)---
  //
  // `/api/apps/:app_id/connections*` は capability の**発行**経路(owner 限定)であり、
  // 状態変更を含む。auth/* と同型に、SameSite=Strict cookie に加えて Origin も検査する
  // (ヘッダが**在る**ときだけ照合する既存挙動に倣う)。owner 検査自体は各 handler が行う。
  // **2パターン登録する** —— `/connections/*` は末尾セグメントを要求するため、bare な
  // `POST /connections`(発行そのもの)を取りこぼす。bare パスも明示的に張る。
  const connectionsOriginGuard: MiddlewareHandler<AuthEnv> = async (c, next) => {
    const method = c.req.method;
    if (method === "POST" || method === "PATCH" || method === "DELETE") {
      const origin = c.req.header("origin") ?? refererOrigin(c.req.header("referer"));
      if (origin !== undefined && !authConfig.expectedOrigins.includes(origin)) {
        return c.json(errorBody([originRejectedError(origin, authConfig.expectedOrigins)]), 403);
      }
    }
    return next();
  };
  app.use("/api/apps/:app_id/connections", connectionsOriginGuard);
  app.use("/api/apps/:app_id/connections/*", connectionsOriginGuard);

  // --- AI capability ルートの Origin 検査(CSRF 多重防御。V1-M5-T04 / ADR-0021 §2b)---
  // `/api/apps/:app_id/ai-capabilities*` は AI capability の**発行・上限変更**経路
  // (owner 限定)であり、connections と同型に扱う(同じガードを使い回す)。
  app.use("/api/apps/:app_id/ai-capabilities", connectionsOriginGuard);
  app.use("/api/apps/:app_id/ai-capabilities/*", connectionsOriginGuard);

  // --- 逃げ道(任意 CSS)ルートの Origin 検査(CSRF 多重防御。V3-M5-T01 / ADR-0055 限定5)---
  // `/api/apps/:app_id/escape-hatch-assets*` は逃げ道の資産の**発行・失効**経路
  // (owner 限定)であり、connections と同型に扱う(同じガードを使い回す)。
  // bare パスも張るのは、`/escape-hatch-assets/*` が末尾セグメントを要求するため
  // **発行そのもの(bare な POST)を取りこぼす**からである(connections と同じ理由)。
  app.use("/api/apps/:app_id/escape-hatch-assets", connectionsOriginGuard);
  app.use("/api/apps/:app_id/escape-hatch-assets/*", connectionsOriginGuard);

  // --- 受信口の**発行**ルートの Origin 検査(CSRF 多重防御。`V8-M41` / 台帳 `F-G14` /
  //     `ADR-0332` / `ADR-0041` §1)---------------------------------------------------
  //
  // `/api/apps/:app_id/inbound-endpoints` は受信口の**発行**経路(owner 限定)であり、
  // connections と同型に扱う(**同じガードを使い回す。新しいガードを1本も書いていない**)。
  //
  // **【bare パスだけを張る。connections / escape-hatch-assets と1点だけ違う】**
  // **`/inbound-endpoints/*` を張っていない** —— **末尾セグメントを持つ口が1本も無いからである**
  // (**再発行・失効の口を1本も作らないと `ADR-0332` 限定3 が定めた**)。 **`/*` を張ると、
  // 「いつか末尾セグメントの口が生える」前提を先に置くことになる。** **置かない。**
  // **【この行が番人でもある】** **末尾セグメントの口を後から足すと、その口だけ CSRF の
  // ガードが掛からない状態で生まれる** —— **`src/server/inbound-endpoint-issuance.test.ts` の
  // (6) が、その4本が今日 404 であることを機械的に固定している。**
  app.use("/api/apps/:app_id/inbound-endpoints", connectionsOriginGuard);

  // --- サインアップ/ログイン経路のレート制限(V2-M1-T05 / ADR-0034 限定4)-----------------
  //
  // 匿名経路(公開 GET)と対で、**サインアップ(register)/ログイン(login)の POST** に
  // 最低限のレート制限を掛ける(単独禁止)。対象は register/login だけで、logout / me /
  // users(管理)/ connections / ai-capabilities には掛けない(認証済み管理経路は非対象。
  // 条件7)。read-only の GET(auth 系には無い)や logout の冪等 POST を巻き込まないよう、
  // パスを名指しで限定する。**顧客経路 `/auth/signup/*` は register のみ**(customer 用の
  // login は無く共通の password/passkey login を使う)なので customer/* をまとめて掛ける。
  const authRateLimitGuard: MiddlewareHandler<AuthEnv> = async (c, next) => {
    if (c.req.method === "POST") {
      const decision = authLimiter.hit(clientKeyFromHeader(c.req.header("x-forwarded-for")));
      if (!decision.allowed) {
        c.header("Retry-After", String(decision.retryAfterSec));
        return c.json(errorBody([rateLimitError(decision.retryAfterSec)]), 429);
      }
    }
    return next();
  };
  app.use("/api/apps/:app_id/auth/password/register", authRateLimitGuard);
  app.use("/api/apps/:app_id/auth/password/login", authRateLimitGuard);
  app.use("/api/apps/:app_id/auth/passkey/register/*", authRateLimitGuard);
  app.use("/api/apps/:app_id/auth/passkey/login/*", authRateLimitGuard);
  app.use("/api/apps/:app_id/auth/signup/*", authRateLimitGuard);

  // =========================================================================================
  // **【`V8-M5-T03`。台帳 `I-G27` / `I-G8`。ユーザ決定 `D-V8-114`。`ADR-0338` §3-1】**
  // **役割の読み方を2本の名前付き式に括り出した。** **読み方を1バイトも変えていない** ——
  // **下の `registerAuthRoutes` の注入と、`GET /api/apps/:app_id/public` の両方が
  // この同じ1本を呼ぶ**(**同じ読み方を2箇所に書かない**。`ADR-0334` 限定8 の作法)。
  // **旧はこの2本が `registerAuthRoutes(...)` の引数の中に無名で書かれていた** ——
  // **中身は1文字も変えていない**(下の注入の側に旧の位置の注記をそのまま残してある)。
  // =========================================================================================
  /** そのアプリが宣言した役割の識別子(宣言が無ければ空。読めないアプリでも空)。 */
  const declaredRoleIdsFor = (appId: string): readonly string[] => {
    try {
      const loaded = loadManifest(appId);
      return loaded.ok ? declaredRoleIds(loaded.value) : [];
    } catch {
      return [];
    }
  };
  /** そのアプリで `signup: "invite"` が書かれた役割(宣言が無ければ空)。 */
  const inviteOnlyRoleIdsFor = (appId: string): readonly string[] => {
    try {
      const loaded = loadManifest(appId);
      if (!loaded.ok) {
        return [];
      }
      return (loaded.value.app.roles ?? [])
        .filter((role) => role.signup === "invite")
        .map((role) => role.id);
    } catch {
      return [];
    }
  };
  /**
   * **役割の識別子 → 表示名。** **`name` は今日も任意である**(`D-V8-79`)——
   * **書かれていない役割はこの表に載らず、識別子がそのまま画面に出る。**
   */
  const roleNamesFor = (appId: string): ReadonlyMap<string, string> => {
    const names = new Map<string, string>();
    try {
      const loaded = loadManifest(appId);
      if (!loaded.ok) {
        return names;
      }
      for (const role of loaded.value.app.roles ?? []) {
        if (typeof role.name === "string" && role.name !== "") {
          names.set(role.id, role.name);
        }
      }
    } catch {
      return names;
    }
    return names;
  };

  // 認証エンドポイント(`/api/apps/:app_id/auth/*`)+ capability ルート。app_id ごとに openForApp する。
  registerAuthRoutes(app, {
    authConfig,
    dataRoot,
    ensureApp,
    // **【`V5-M3b` / `D-V5-96`(2026-08-06)】逃げ道CSSの発行・失効・一覧・申請一覧の4本は、
    // 実行専用の起動プロファイルでは登録しない。** **残る運営者の口は12本である**
    // (利用者の管理3本 / 外部との連携4本 / AI の能力5本)。
    escapeHatchAssetRoutes: profile === "full",
    // **【2026-08-11。`V8-M29` 第2波 / 台帳 `T-G9a`。判定値 = 廃止】ここに在った
    // 注入1本 `userKindIds` を取り除いた。****旧(逐語)**:
    //
    //     userKindIds: (appId) => {
    //       try {
    //         const loaded = loadManifest(appId);
    //         return loaded.ok ? effectiveUserKindIds(loaded.value) : effectiveUserKindIds(undefined);
    //       } catch {
    //         return effectiveUserKindIds(undefined);
    //       }
    //     },
    //
    // **代わりに立つのはすぐ下の `roleIds` である**(`ADR-0301` 限定2)——
    // **マニフェストの取り方も、読めないときに倒す先を持つことも同型である。**
    // **【`V8-M29` 第1波 / 台帳 `T-G10`】そのアプリが宣言した役割の識別子**
    // (宣言が無ければ空。**そのとき値域は着手前と1文字も変わらない**)。
    // **マニフェストの取り方は、すぐ上の `userKindIds` とまったく同じ形にしてある**
    // (新しい読み方を発明していない)。**読めないアプリでは空に倒す** ——
    // **認証経路を 500 にせず、値域を着手前と同じところへ落とす。**
    //
    // **【`V8-M5-T03`】旧の逐語(1バイトも消していない。ここに直に書かれていた)**:
    // ```
    //     roleIds: (appId) => {
    //       try {
    //         const loaded = loadManifest(appId);
    //         return loaded.ok ? declaredRoleIds(loaded.value) : [];
    //       } catch {
    //         return [];
    //       }
    //     },
    // ```
    // **今日は同じ式をすぐ上の `declaredRoleIdsFor` に括り出して呼んでいる** ——
    // **`GET /public` が同じ読み方を必要とし、2箇所に書かないためである。**
    roleIds: declaredRoleIdsFor,
    // **【`V8-M1-T04`。台帳 `I-G1` / `I-G5` / `I-G6` / `I-G26`。`ADR-0334` / `ADR-0335`】**
    // **そのアプリで `signup: "invite"` が書かれた役割**(宣言が無ければ空)。
    //
    // **マニフェストの取り方は、すぐ上の `roleIds` とまったく同じ形にしてある**
    // (新しい読み方を発明していない)。**読めないアプリでは空に倒す** ——
    // **認証経路を 500 にせず、応答を着手前と同じところへ落とす**(`roleIds` と同じ向き。
    // **`canDistributeRoles` と違って閉じる側には倒さない** —— **倒すと、読めない
    // マニフェストのアプリが登録できなくなる**)。
    //
    // **【`src/server/owner-scope.ts` の `export` を1つも増やしていない】**
    // (`ADR-0334` 限定8)—— **読み方はここにインラインで書く。**
    // **値域の検査は `schemas/manifest.schema.json` だけが持つ**(同 限定7)ので、
    // **ここでは `"invite"` の1語との等値だけを見る。**
    //
    // **【`V8-M5-T03`】旧の逐語(1バイトも消していない。ここに直に書かれていた)**:
    // ```
    //     inviteOnlyRoleIds: (appId) => {
    //       try {
    //         const loaded = loadManifest(appId);
    //         if (!loaded.ok) {
    //           return [];
    //         }
    //         return (loaded.value.app.roles ?? [])
    //           .filter((role) => role.signup === "invite")
    //           .map((role) => role.id);
    //       } catch {
    //         return [];
    //       }
    //     },
    // ```
    // **今日は同じ式をすぐ上の `inviteOnlyRoleIdsFor` に括り出して呼んでいる。**
    inviteOnlyRoleIds: inviteOnlyRoleIdsFor,
    // **【`V8-M28` 第2波】人に役割を配ってよいか**(台帳 `T-G18` /
    // ユーザ決定 `D-V8-41` / `D-V8-49` / `D-V8-77`)。
    //
    // **判定は `judgeRoleAccess` 1本である**(`ADR-0305` 限定3)。**マニフェストの取り方は
    // すぐ上の `userKindIds` とまったく同じ形にしてある**(新しい読み方を発明していない)。
    //
    // **【読めないマニフェストは閉じる側に倒れる。隠さない】** —— **`undefined` を渡すと
    // `judgeRoleAccess` は「役割の宣言が0件」として閉じる**(`D-V8-59` / `D-V8-65`)。
    // **`userKindIds` が既定に倒す(開く側)のと向きが逆である** —— **こちらは可否の判定
    // だからである。**
    canDistributeRoles: (appId, roles) => {
      let manifest: Manifest | undefined;
      try {
        const loaded = loadManifest(appId);
        manifest = loaded.ok ? loaded.value : undefined;
      } catch {
        manifest = undefined;
      }
      return judgeRoleAccess({
        manifest,
        roles: [...roles],
        target: { target: "role" },
        verb: "write",
      }).allowed;
    },
    // **【`V10-M15-T05` / `CM-G21` / `ADR-0370`】そのアプリのマニフェスト**
    // (`GET /api/apps/:app_id/comments` が {@link visibleComments} へ渡す)。
    //
    // **読み方はすぐ上の `canDistributeRoles` とまったく同じ形にしてある**(新しい
    // 読み方を発明していない)。**読めないアプリでは `undefined` に倒す**(閉じる側。
    // `roleIds` と違って開く側に倒さない —— 開くと、読めないマニフェストのアプリで
    // 全件が見えてしまう)。
    manifestFor: (appId) => {
      try {
        const loaded = loadManifest(appId);
        return loaded.ok ? loaded.value : undefined;
      } catch {
        return undefined;
      }
    },
  });

  // 受信 HTTP ルート(`POST /inbound/:endpoint_id`。V2-M5-T02 / ADR-0041)。**署名で認証する**
  // (ロール認証を通さない)ので `/api/*` の認証 middleware とは別経路に置く。署名検証は書込直前・
  // 実行層で、人間 owner が発行した inbound endpoint の下で書込先テーブル1つへ1行 create する。
  registerInboundRoute(app, { dataRoot, rateLimit: options.rateLimit?.inbound });

  // 1. アプリ一覧
  //
  // **【`V5-M3b` / `D-V5-96`(2026-08-06)】`profile === "runner"` では登録しない。**
  // **`01` §1 のスコープ外表が逐語で「アプリ切替の画面も、`GET /api/apps` の一覧も、
  // 配布物には入れない(`R-G8`)」と名指ししている。**
  // **【禁止】「アプリ一覧は見られない」と読まないこと** —— **`ST_SERVER_PROFILE` を外せば
  // 同じ実行ファイルがこの口を登録する。** **`Dockerfile` を書き換えれば配布物にも入る。**
  // **なお、他所の 404 の hint(逐語「GET /api/apps で実在するアプリ一覧を取得できます。」)は
  // `runner` でも今日どおり出る** —— **そこは1バイトも直していない。**
  if (profile === "full") {
    app.get("/api/apps", (c) => {
      return c.json({ apps: withStore(dataRoot, (store) => store.listApps()) });
    });
  }

  // --- 定義の取得の認証境界(`V8-M21` / 台帳 `J-G24a` / ユーザ決定 `D-V8-21`)-----------
  //
  // **`D-V8-21` の逐語**(選ばれた見出し = **塞ぐ(ログインを要求)**):
  //   > 「今日、ログインしていない人でも『どんな表と項目があり、どんな権限が宣言されて
  //   > いるか』を丸ごと読めます。これを塞ぎますか?」
  //   > 「アプリの定義を読むにはログインを必要にする。v7 で唯一『保留』になった項目で、
  //   > 今は権限の宣言そのものが外から丸見えです。」
  //
  // **着手前の実測(2026-08-10。本物の TCP ソケット)**: **未認証の
  // `GET /api/apps/shop/manifest` = **200**。** 応答本文に **表・項目名・自動処理・
  // 全画面・`app.roles[].rules`(誰にどの画面が開いているか)**がそのまま載っていた。
  //
  // **`V8-M20` が広げた漏れ**(`V8-M20` の記録 §9 の 4 の逐語):
  //   > 「`GET /manifest` の漏れは広がった。未ログインに `app.roles[].rules` がそのまま
  //   > 返るので、『どの役割にどの画面が開いているか』まで読める。」
  // **本middleware がその漏れごと塞ぐ。**
  //
  // **要求するのはセッションだけである** —— **ロールを1つも見ない。**
  // **viewer も customer も定義が読めなければ自分の画面を描けない**(`ADR-0015` §1 で
  // records に書けない役割も、読取はする)。**`filesAuthMiddleware` のような
  // `hasAdminWriteRole` の関門をここに置かない。**
  //
  // **【この middleware が塞がないもの。誇張しない】**
  //  - **`GET /api/apps/:app_id/changelog` / `undo/preview` / `requirements` は今日も
  //    未認証で読める** —— **本単位(`J-G24a`)の射程は定義の取得1本である。**
  //  - **MCP は HTTP を1本も叩かない**(`get_manifest` は今日も素通りである。`D-V8-20`)。
  const manifestAuthMiddleware: MiddlewareHandler<AuthEnv> = async (c, next) => {
    const appId = c.req.param("app_id") as string;
    // アプリが無ければ 404(セッション解決の前に確かめる。`recordsAuthMiddleware` と同型)。
    const appError = ensureApp(appId);
    if (appError !== null) {
      return c.json(errorBody([appError]), 404);
    }
    if (resolveRecordsUser(appId, c) === undefined) {
      return c.json(errorBody([unauthenticatedError(appId)]), 401);
    }
    await next();
  };
  app.use("/api/apps/:app_id/manifest", manifestAuthMiddleware);

  // 2. マニフェスト取得(読み取り専用。変更する手段は HTTP に存在しない)
  //
  // **【`V8-M21` / `J-G24a`】今日から `manifestAuthMiddleware` が前段に立つ** ——
  // **ハンドラそのものは1バイトも変えていない**(未認証はここへ到達しない)。
  //
  // **【`V10-M31-T01`(台帳 `CM-G38`)。2026-08-25。上の2行は1バイトも消していない】**
  // **今日から、応答の**外側**に兄弟キー `comment_visibility` を1本だけ足して返す。**
  // **なぜここでマージするのか**: 設定の器は台帳(`apps` 表の列2本 / `ADR-0377`)であって
  // アプリの定義ではない。**`src/kernel/types.ts` の `Manifest` に足すと器と型が連動し、
  // `CM-G38` が課した「`src/kernel/` と `schemas/` を1バイトも触らない」(= 門外(`Δ7`)の根拠)
  // を守れなくなる。** そこで**定義はそのまま**返し、サーバ層が組み立てるときだけ隣に置く。
  // **設定が1度も倒されていない(`undefined`)なら既定と同じ OFF に倒す。**
  //
  // **【2026-08-25。独立点検を受けて打ち直した。上の1行は1バイトも消していない】**
  // **直前の1文(「設定が1度も倒されていない(`undefined`)なら既定と同じ OFF に倒す」)は偽である。**
  // **この倒し先は到達しない** —— 下のハンドラは `loadManifest` を先に呼び、`loadManifest` は
  // `ensureApp`(= `KernelMetaStore.getApp`)で **同じ `apps` 表の同じ行** を見る。行が無ければ
  // そこで **404** を返して抜けるので、`getCommentVisibility` まで来ない。行が在れば、列2本は
  // `INTEGER NOT NULL DEFAULT 0`(`src/kernel/meta-store.ts` の列定義)なので `getCommentVisibility`
  // は `undefined` を返さない。**したがって `?? false` の右辺が選ばれる経路は今日1本も無い。**
  // **それでも `?? false` を落とさない** —— `getCommentVisibility` の戻り型が
  // `CommentVisibility | undefined` である以上、型を絞るために要る。
  // **【この「到達しない」ことを示す検査は1本も無い】** —— 独立点検が `?? false` を `?? true` に
  // 書き換えて `bun test` を打ち、**0 fail** だった(2026-08-25 の実測)。**誰も止めていない。**
  // **【隠さない】** 実在確認と設定の読み取りは **別々の `withStore`** である。その2回の間に
  // アプリの行が消える経路だけが理屈の上では残るが、**それは実測していない。**
  // **`comment_visibility.write` は「書く欄を出すか」の合図であって、
  // `POST /api/apps/:app_id/comments` を止める壁ではない**(利用者決定 `D-V10-38`)。
  //
  // **旧のハンドラ本文(逐語。1バイトも消していない)**:
  // ```
  //     const loaded = loadManifest(c.req.param("app_id"));
  //     if (!loaded.ok) {
  //       return c.json(errorBody(loaded.errors), 404);
  //     }
  //     return c.json(loaded.value);
  // ```
  // **登録の行そのもの(下の1行)は1バイトも変えていないので、ここに写していない。**
  // **写せない理由も書いておく**: `src/server/entry-point-inventory.test.ts` の
  // `scanRoutes` / `registrationsOf` は **`app.ts` の**本文テキスト**を正規表現で走査する**ので、
  // **コメントの中に登録の行を逐語で写すと「同じ口が2本ある」と数えられて赤くなる**
  // (2026-08-25 に実際に赤くした。`ADR-0176` 限定1 が 49 → 50 と出た)。
  // **口は1本も増えていない。**
  app.get("/api/apps/:app_id/manifest", (c) => {
    const appId = c.req.param("app_id");
    const loaded = loadManifest(appId);
    if (!loaded.ok) {
      return c.json(errorBody(loaded.errors), 404);
    }
    // **読み口は既存の `KernelMetaStore.getCommentVisibility` 1本だけである**
    // (`withStore` はリクエストごとに台帳を開いて閉じる。新しい `open` を書いていない)。
    const visibility = withStore(dataRoot, (store) => store.getCommentVisibility(appId));
    return c.json({
      ...loaded.value,
      comment_visibility: {
        write: visibility?.write ?? false,
        read: visibility?.read ?? false,
      },
    });
  });

  // 2b. **未ログインへ渡す最小限**(`V8-M21` / 台帳 `J-G24b` / ユーザ決定 `D-V8-34`)。
  //
  // **`D-V8-34` の逐語**(選ばれた見出し = **ログイン画面に要る分だけ渡す**):
  //   > 「アプリ名と、『未ログインでも見せる』と決めた画面の名前だけを渡し、項目名・
  //   > 自動処理・他の画面は渡さない。ログイン画面も公開ページも今どおり出る。以前
  //   > 『どんな画面が存在するのかは未ログインでも見せていい』と決めていた件を、
  //   > 部分的に覆すことになる。」
  //
  // **口は1本だけ足した**(`HTTP_ENTRY_POINTS` は **46 → 47**。`J-G24b` の限定
  // 「口を足すなら1本」)。**2本目を足していない。**
  //
  // **返すもの(全量。これ以外は1バイトも返さない)**:
  //   - **アプリ名**(`app.name`)と、**URL が既に名指ししているアプリID**(`app.id`)。
  //   - **未ログインでも見せると決めた画面の `id` と `name`。**
  //
  // **【「未ログインでも見せると決めた画面」の今日の定義】** —— **役割の一覧に
  // `anonymous` を主体とする `{ target: "view", view: "…", can: ["read"] }` の規則が
  // 在る画面である。** **`V8-M20` が `view.audience` を廃止したので、これが今日の
  // 唯一の宣言である**(`J-G27` / `ADR-0301`)。**判定は `owner-scope.ts` の
  // `judgeRoleAccess` 1本であり、ここに規則を読む条件式を1つも書いていない。**
  //
  // **【返さないもの。名指しする】** **項目名 / 表 / 自動処理(ワークフロー・関数)/
  // 未ログインに開いていない画面 / `app.roles`(権限の宣言そのもの)/
  // 画面の中身(列・絞り込み・並べ替え・操作)。**
  //
  // **【テーマ(配色)は返す。メインが決めた。黙って足していない】**
  //
  // **`V8-M21` の後半の実装は、いったん配色も返さない形にした。** **その結果、
  // 未ログインのログイン画面と公開ページから配色が消えた**(実測: `web/e2e/theme.e2e.ts` の
  // (iii) / (iv) / (v) が落ちた)。**それをメインへ戻し、メインが「足す」と判断した。**
  //
  // **メインが挙げた根拠(3つ)**:
  //  1. **`D-V8-34` の説明文の逐語は「アプリ名と、「未ログインでも見せる」と決めた画面の
  //     名前だけを渡し、**項目名・自動処理・他の画面は渡さない**。**ログイン画面も公開ページも
  //     今どおり出る**。」である。** **渡さないと名指しされたのは3つであり、配色は入っていない。**
  //  2. **`D-V8-21` の問いの逐語は「どんな**表と項目**があり、どんな**権限**が宣言されて
  //     いるか」であり、配色はその射程に無い。**
  //  3. **配色が消えるとログイン画面と公開ページの見た目が変わる。** **「今どおり出る」に反する。**
  //
  // **【正直に書く】** **配色は「アプリ名と、未ログインでも見せると決めた画面の名前**だけ**」の
  // 「だけ」の外にある。** **足したのは `D-V8-34` の逐語「ログイン画面も公開ページも今どおり
  // 出る」を根拠にした**メインの判断**であって、限定の逐語から自動的に出るものではない。**
  // **応答のキーは 2つ → **3つ** になった**(`app` / `views` / `theme`)。**口は1本も増えていない。**
  //
  // **【この口が認証を要求しない理由】** **「ログインするために定義が要り、定義を得るために
  // ログインが要る」を避けるためである**(`D-V8-34` の問いそのもの)。**だから渡す中身を
  // 上の2つに絞った。**
  //
  // **【禁止】この口を「manifest の代わり」として使わない** —— **画面を描くには足りない。**
  //
  // ============================================================================================
  // **【2026-08-11 追記(`V8-M26-T05`。台帳 `T-G27b` の再審査 / ユーザ決定 `D-V8-57` /
  //   `D-V8-64` / `ADR-0319`)。上の旧文を1バイトも消していない】**
  // ============================================================================================
  //
  // **旧文のうち今日は偽になったもの**(**名指しする。丸めない**):
  //   - **「返すもの(全量)…**未ログインでも見せると決めた画面の `id` と `name`**」** ——
  //     **今日は画面の定義そのもの(種別・対象の表・列・並べ替え・絞り込み・プリセット・
  //     子一覧・操作)と、その画面が描くのに要る表の定義(項目を含む)を返す。**
  //   - **「【返さないもの。名指しする】**項目名 / 表 / …**」** —— **項目名と表は今日返る。**
  //     **返さないままなのは、自動処理(ワークフロー・関数)/ 未ログインに開いていない画面 /
  //     `app.roles`(権限の宣言そのもの)/ この画面が使わない表 である。**
  //   - **「【禁止】この口を「manifest の代わり」として使わない —— 画面を描くには足りない。」**
  //     —— **今日は「未ログインに開いた画面については」足りる。** **開いていない画面については
  //     今日も1バイトも足りない。**
  //
  // **【この実装が正面から当たった明文。逐語で書く】**
  //
  // **`ADR-0314` 限定2**(`docs/adr/0314-app-definition-login-required.md:244`。**逐語**):
  //   > **未ログインへ渡るキーは3つちょうど** | `app` / `views` / `theme`。**4つ目を足さない。**
  //   > **`app` のキーは `id` / `name` の2つ、画面のキーも `id` / `name` の2つちょうど**
  //
  // **破ったのは後半である** —— **画面のキーは今日「`id` / `name` の2つちょうど」ではない。**
  // **破っていないのは前半である** —— **トップレベルのキーは今日も `app` / `views` / `theme` の
  // 3つちょうどであり、4つ目を足していない。** **`app` のキーも `id` / `name` の2つのままである。**
  // **`ADR-0319` 限定5(「厚くするのは `views` の要素だけであり、応答のトップレベルのキーは
  // 3つのままである」)の形をそのまま採った** —— **表の定義は `views[].tables` として
  // 画面の中に入れてある。** **【正直に書く】同じ限定5 の後段「`tables` / `fields` …を
  // 1バイトも渡さない」は、`D-V8-57` を満たすと必ず破れる。** **破っている。**
  //
  // **破ってよい根拠は `D-V8-57` である**(`docs/plan/v8/03-user-decisions.md` §4i。**逐語**):
  //   > 「未ログインで公開画面の中身が見られるようにします。公開の商品一覧のような画面が
  //   > 本当に作れますが、**未ログインの相手に画面の作り(項目の並びなど)が渡ります**。
  //   > 作業が1本増えます。」
  // **「画面の作り(項目の並びなど)が渡ります」は、ユーザ決定が代償として名指ししたものである。**
  //
  // **【`D-V8-64` の線。ここで守る】**(同 §4k。**逐語**):
  //   > 「画面を「公開」と書いただけでは、枠は開きますが中身は空です。その画面が使う表に
  //   > ついても「ログインなしでも見せる」を1行書いて初めてデータが並びます。…」
  // **したがって、この口は表の**行**を1行も返さない。** **返すのは表の**定義**だけである。**
  // **行は今日どおりレコードの口から取り、そこで面の既定(閉じる)と `st_public` の窓が効く。**
  //
  // **【今日1本も隠せないもの。検査で固定した】** **未ログインには**項目**の規則を1本も
  // 書けない**(`schemas/manifest.schema.json` の `anonymous` 分岐が `target` を
  // `["table","view","action"]` に閉じ、`field` を `false` schema にしている)。
  // **実測の拒否メッセージ2件**: 「target の値 "field" は語彙にありません。」/
  // 「プロパティ "field" は、この種別では指定できません。」
  // **したがって公開画面に載せた項目は、運営メモであっても1本も隠せない。**
  // **この事実は `src/server/anonymous-public-view.test.ts` の (e) が固定する。**
  //
  // **【動かしていないもの】** **HTTP の口は 47 のまま**(`entry-point-inventory.test.ts:221`)。
  // **非保護の台帳も5本のまま。** **判定は `judgeRoleAccess` 1本のままであり、この口に
  // 規則を読む条件式を1つも足していない**(`ADR-0314` 限定4)。
  app.get("/api/apps/:app_id/public", (c) => {
    const appId = c.req.param("app_id");
    const loaded = loadManifest(appId);
    if (!loaded.ok) {
      return c.json(errorBody(loaded.errors), 404);
    }
    const manifest = loaded.value;
    const views = manifest.app.views
      .filter((view) => {
        // **主体は「未ログイン」である** —— **`roles: null` を渡すと `judgeRoleAccess` は
        // 予約語 `anonymous` を主体として評価する**(`J-G11`)。
        const decision = judgeRoleAccess({
          manifest,
          roles: null,
          target: { target: "view", view: view.id },
          verb: "read",
        });
        // **管轄外(規則が1本も無い画面)は「見せると決めた」ではない。**
        // **`judgeRoleAccess` は管轄外を全許可で返すので、`governed` で絞る** ——
        // **`V8-M20` が開けた後退「規則の無い画面が未ログインにも開く」を、
        // この口では踏まない。**
        return decision.allowed && decision.governed;
      })
      // **【`V8-M26-T05` / `D-V8-57`】旧の逐語(1バイトも消していない)**:
      //   `.map((view) => ({ id: view.id, name: view.name ?? view.id }));`
      // **今日は画面の定義そのものを渡す** —— **名前だけでは画面を描けないからである**
      // (`web/src/AppWorkspace.tsx` の同じ逐語)。
      .map((view) => ({
        // **画面の定義を丸ごと渡す**(種別・対象の表・列・並べ替え・絞り込み・プリセット・
        // 子一覧・操作)。**この画面のものだけである。**
        ...structuredClone(view),
        // **名前が無い画面は ID を名前にする**(旧の形をそのまま残す)。
        name: view.name ?? view.id,
        // **この画面が描くのに要る表の定義**(項目を含む)。**`ADR-0319` 限定5 の形を採り、
        // トップレベルに4つ目のキーを作らずに画面の中へ入れてある。**
        // **行(データ)は1行も入っていない** —— **`D-V8-64` の線である。**
        tables: publicTablesForView(manifest, view),
      }));
    // **テーマは宣言されていなければキーごと出さない**(マニフェストの側と同じ形)。
    const theme = manifest.app.theme;
    // =====================================================================================
    // **【`V8-M5-T03`。台帳 `I-G27`(却下だが `D-V8-112` により実施)/ `I-G8`(却下)。**
    // **ユーザ決定 `D-V8-114` / `D-V8-115`。`ADR-0338` §3-1】**
    // **登録に要る事実を、この口の4つ目のキーとして渡す。**
    //
    // **【`ADR-0319` 限定1 を正面から破っている。隠さない】** **同 限定の逐語は
    // 「応答のトップレベルのキーを4つ目にしない」であり、ここが4つ目である。**
    // **破ってよい根拠はユーザ決定 `D-V8-115`(選ばれた見出し = 変更として記録して進める)
    // であり、引き直しは `ADR-0338` が担う**(front matter は双方向で入っている)。
    // **`ADR-0319` の本文は1バイトも書き換えていない。**
    //
    // **【この応答は全アプリで変わる。丸めない】** **招待制を1つも宣言していないアプリでも
    // このキーは増える**(そのとき `kinds` は既定の1つ、`adminInvite` は `false` である)。
    // **【禁止】「既存アプリの応答は1バイトも変わらない」と書かない**(裁定 `M5-1`)。
    //
    // **【値域を2箇所に書いていない】** **`signupKindValues` はサーバが登録の口で受理する
    // 値そのものを組む式であり、ここはそれを呼ぶだけである**(`ADR-0338` 限定4)。
    // **`web/` の側でも組み直さない** —— **層をまたぐ import を1本も足さず、値は HTTP で渡す。**
    //
    // **【行を1行も渡さない】**(`D-V8-64` / `ADR-0319` 限定3)—— **渡すのは役割の識別子と
    // 表示名と招待の要否の3つだけである。** **利用者の一覧も招待の一覧もコードも渡さない。**
    // =====================================================================================
    const signup = signupFacts({
      kinds: signupKindValues(declaredRoleIdsFor(appId)),
      inviteOnlyRoleIds: inviteOnlyRoleIdsFor(appId),
      roleNames: roleNamesFor(appId),
      // **【`V8-M5-T07`。`D-V8-116`】宣言されていない立場(組み込みの既定)の招待の要否は、
      // 予約3語の宣言で決まる。** **画面が読む事実も、サーバの判定と同じ1本から出す。**
      declaredRoleIds: declaredRoleIdsFor(appId),
    });
    return c.json({
      app: { id: manifest.app.id, name: manifest.app.name },
      views,
      ...(theme === undefined ? {} : { theme }),
      signup,
    });
  });

  // 3. レコード一覧
  app.get("/api/apps/:app_id/tables/:table_id/records", (c) => {
    const tableId = c.req.param("table_id");
    const loaded = loadManifest(c.req.param("app_id"));
    if (!loaded.ok) {
      return c.json(errorBody(loaded.errors), 404);
    }
    const manifest = loaded.value;
    const resolved = resolveTableForRoute(manifest, tableId);
    if (!resolved.ok) {
      return c.json(errorBody(resolved.errors), resolved.status);
    }

    const parsed = parseListOptions(resolved.table, new URL(c.req.url).searchParams);
    if (!parsed.ok) {
      // **(c) `V4-M35` / `D-V4-124`**: **400 の `allowed_values` から「見せない項目」の
      // IDを落とす。** **判定は `owner-scope.ts` の1本**(ここに条件式を書かない。
      // `ADR-0061` 限定4)。**ロールを1つも見ない**(`ADR-0120` 限定2 と同じ形)。
      return c.json(errorBody(scrubHiddenFieldIds(manifest, resolved.table, parsed.errors)), 400);
    }
    const options = parsed.value;
    /**
     * **「客に見せない」と宣言した項目を、読取の要求の条件に書かせない**(`V4-M28-T01`。
     * `D-V4-93` / **`ADR-0120` 限定1〜3**)。**判定は下の `sum_field` とまったく同じ層・
     * 同じ述語(`isRoleGovernedField`)で、ロールを1つも見ない**(限定2。**owner も同じ 400**)。
     *
     * **拒否は全か無かである**(限定3)—— **条件を部分的に落として 200 を返さない。**
     * **黙って結果を変えない**(憲法6)。
     *
     * **【正直に書く】** **表示層は `view.sort` / `view.filter` を同じ読取パラメータへ翻訳して
     * 投げるので、宣言つき項目を条件に書いた画面の一覧要求も、ここで 400 になる。**
     * **サーバから見ると「画面が出した要求」と「住所欄に手で書いた要求」は1バイトも違わない。**
     * **`ADR-0120` 限定1 の第4列後半(その画面が今日どおり描けること)は満たせていない** ——
     * **正は `docs/plan/v4/records/v4-m28.md` §4 / §9 である。**
     */
    const hiddenQueryErrors = hiddenFieldQueryErrors(manifest, resolved.table, options);
    if (hiddenQueryErrors.length > 0) {
      return c.json(errorBody(hiddenQueryErrors), 400);
    }
    const { limit, offset } = options;
    // filter だけを取り出す(total は filter 適用後の件数。EC-G11 / ADR-0042 限定3)。
    const filterOnly = options.filter !== undefined ? { filter: options.filter } : {};

    /**
     * **合計を出す列**(`V4-M23-T02`。`D-V4-89` / `E-G31` / `ADR-0104` 限定3・限定5・限定7)。
     *
     * **画面の宣言(`list_view.sum_field`)は、`filter` / `sort` / `limit` と同じく
     * 表示層が読取パラメータへ翻訳して渡す**(`web/src/api.ts` の `buildListQuery`。
     * `ADR-0003` §5 以来の分担であり、本タスクはそれを1ミリも変えていない)。
     * **渡されなければ応答に `sum` は1バイトも載らず、着手前と同じ形である。**
     *
     * **【`V8-M20` / `T02` の置き直し】面が名指しした項目はここで止める** ——
     * **旧は `audience` を宣言した項目だった。** **カーネルは実在と `number` 型を
     * 見るが、見せる相手の射影は持たない**(それは `owner-scope.ts` の担当である)。
     * **止めないと「行では伏せている列の合計だけが見える」ことになる。**
     *
     * **【`V8-M20`。旧文を1バイトも消さずに引き直す】** **旧文はここに
     * 「**宣言の側は `referential-integrity.ts` が apply 時に同じ判定で止めている。**」と
     * 書いていた。** **今日その apply 時の検査が見ている宣言は面の側へ置き直されており、
     * ここ(読取のとき)と同じ述語を見ている。** **「止まる場所が2つある」ことは今日も
     * 真だが、見ている宣言は `field.audience` ではない。**
     */
    const sumParam = new URL(c.req.url).searchParams.get(SUM_FIELD_KEY);
    let sumField: string | undefined;
    if (sumParam !== null && sumParam !== "") {
      const target = resolved.table.fields.find((field) => field.id === sumParam);
      if (target !== undefined && isRoleGovernedField(manifest, resolved.table.id, target.id)) {
        return c.json(
          errorBody([
            {
              path: `/${SUM_FIELD_KEY}`,
              message: `合計を出す列 "${sumParam}" は、役割の規則が名指ししています。規則の対象になっている項目の合計は出せません。`,
              hint: "役割の規則(rules)が名指ししていない number のフィールドを指定してください。",
            },
          ]),
          400,
        );
      }
      sumField = sumParam;
    }
    /**
     * **post-filter 分岐の合計**(限定7)—— **SQL で合計しない。**
     * **`total` を数えている同じ可視集合(`visible`)をそのまま足す** ので、
     * **母集団は構造的に一致する**(限定5)。**追加の DB 往復は0である。**
     * **値が数でない行は飛ばし、`0` から始める** —— `countAndSumRecords` の
     * `SUM()`(NULL を無視し、0件なら `0`)と同じ意味論である。
     */
    const sumVisible = (rows: Record<string, unknown>[]): number => {
      if (sumField === undefined) {
        return 0;
      }
      let total = 0;
      for (const row of rows) {
        const value = row[sumField];
        if (typeof value === "number" && Number.isFinite(value)) {
          total += value;
        }
      }
      return total;
    };
    /** 合計を求められたときだけ応答に載せる(求められなければキーごと出さない)。 */
    const withSum = <T extends object>(body: T, value: number): T | (T & { sum: number }) =>
      sumField === undefined ? body : { ...body, sum: value };
    /**
     * **返す行ぶんだけの判定を取り出す**(`V14-M1-T01`)。**ページを切ったあとに掛ける**
     * —— **母集団の側は可視行の全量ぶんを持っているが、応答に載せるのは返した行だけで
     * よい**(`resolveOwnerDisplays` をページの後に掛けているのと同じ理由)。
     * **可否を1ミリも決めていない** —— **鍵で引くだけである。**
     */
    const accessForPage = (
      page: Record<string, unknown>[],
      all: Record<string, RecordRowAccess> | undefined,
    ): Record<string, RecordRowAccess> => {
      const picked: Record<string, RecordRowAccess> = {};
      if (all === undefined) {
        return picked;
      }
      for (const row of page) {
        const recordId = row._id;
        const entry = typeof recordId === "string" ? all[recordId] : undefined;
        if (typeof recordId === "string" && entry !== undefined) {
          picked[recordId] = entry;
        }
      }
      return picked;
    };

    // 匿名公開 / 個人スコープは JS の post-filter で可視行を決めるため、**その可視集合を母集団として**
    // total を数え・ページングする。可視性(st_public / st_owner)は SQL に落とせないので、これらの
    // 分岐では DB の LIMIT/OFFSET を使わず、filter 済みの全行を読んでから post-filter → ページング
    // する(ADR-0042 §限界2 の正直な代償: 可視分岐は全件をメモリに読む)。非スコープ(既定・
    // システムテーブル)は post-filter が無いので DB の LIMIT/OFFSET を使い、total は countRecords。
    const anonymousPublic = c.get("anonymousPublic") === true;
    // **【`V8-M10-T02` / `Q-G16a`。旧の1行を逐語で残す】**
    // **旧**: `const ownerField = anonymousPublic ? undefined : personalOwnerField(resolved.table);`
    // **母集団の分岐を決める判定は `owner-scope.ts` の `recordPopulationScope` へ移した** ——
    // **この行が在ると、同じ判定が2箇所に住む**(`ADR-0061` 限定4)。
    // **`personalOwnerField` を見る順序(匿名が先)は、あちらが1バイトも同じ形で持っている。**
    // **行ごとのアクセス権(`Z-G11` / `V7-M2-T02`)。** **宣言していない表では `undefined`
    // であり、以下の分岐は着手前と1バイトも変わらない**(オプトイン)。**判定は
    // `owner-scope.ts` の1本**(ここに条件式を書かない。`ADR-0061` 限定4)。
    const accessSources = recordAccessSourceTables(manifest, tableId);

    // **項目ごとの読取の射影。**
    // **3つの分岐(匿名 / 個人スコープ / 非スコープ)すべてに掛ける** —— 1本でも抜けると
    // その経路だけ静かに漏れる。**射影そのものは `owner-scope.ts` の1本である。**
    // **匿名は `roles = null` として扱う**(`anonymous` として判定される。`J-G11`)。
    // **【`V8-M20` / `J-G28`】旧層(`projectForFieldAudience`)は撤去した。**
    // **残っているのは面(`projectForRoleFields`)の1本だけである。**
    const readerRoles: ActorRoles = (c.get("user") as AuthUser | undefined)?.roles ?? null;
    // **【`V8-M18` / `J-G13`】条件の「自分」が指す相手。未ログインは `null`**(偽に評価される)。
    const roleSubject = (c.get("user") as AuthUser | undefined)?.id ?? null;
    // **面の**項目**の規則。** **判定は `owner-scope.ts` の1本**
    // (ここに規則を読む条件式を1つも書かない)。
    const dropHidden = (row: Record<string, unknown>): Record<string, unknown> =>
      projectForRoleFields({
        manifest,
        table: resolved.table,
        row,
        roles: readerRoles,
        // **【`V8-M18`】項目の規則に条件が書いてあれば行ごとに効く。**
        subject: roleSubject,
      });

    // --- 面(役割に束ねた権限)の**表**の規則 —— 読取(`V8-M17` / `J-G6`)-----------------
    //
    // **読めない表は 403 にしない** —— **応答から落とす**(空の一覧)。**「その表が在る」ことを
    // 役割の外へ漏らさない側に倒す**(単件経路の 404 と同じ向き)。
    // **`total` も `sum` も可視集合から採るので、0件のときは 0 である**(母集団を割らない)。
    //
    // **【`V8-M18` / `J-G12`】この1回は**行を渡していない** —— **表そのものが管轄外か、
    // どの役割にも読取が書かれていないかを見る関門である。** **条件つきの規則しか無い場合、
    // この関門は `conditional: true` を返して**通す** —— **行ごとの判定は下の post-filter が
    // 行う。** **判定は `owner-scope.ts` の1本**(ここに条件式を1つも書かない)。
    const roleTableRead = judgeRoleAccess({
      manifest,
      roles: readerRoles,
      target: { target: "table", table: tableId },
      verb: "read",
    });
    //
    // **【`V8-M19`】点が管轄内の表では、この関門で止めない**(`D-V8-23` の `OR`)——
    // **行ごとの付与だけで見える行があるからである。** **その場合の絞り込みは、下の
    // post-filter が (行, 要求している人, 動詞) の単位で行う。**
    //
    // **【匿名公開の分岐は例外である。理由を書く】** —— **未ログインの読取は点(行ごとの付与)を
    // 1度も判定しない**(要求している人が居ないので付与を引けない)。**そこで面を短絡させると、
    // 面が閉じた表が未ログインに開いてしまう** —— **点が「通す」と言っていないのに通ることに
    // なるので、`OR` の意味からも外れる。** **匿名の分岐では面が最終の答えである。**
    //
    // **【この分岐は今日、実際には起こらない。誇張しない】** —— **カーネルの適用時検査が
    // 「行ごとの付与を有効にした表に公開規約フィールドを同居させる」宣言を拒否している**
    // (`src/kernel/referential-integrity.ts` の同居検査)。**したがってこの1行は、
    // その検査が緩んだときに備えた歯止めであって、今日通る経路を塞いだものではない。**
    if (
      roleGateBlocksWithoutGrants({
        role: roleTableRead,
        grantGoverned: !anonymousPublic && accessSources !== undefined,
      })
    ) {
      return c.json(withSum({ records: [] as Record<string, unknown>[], total: 0 }, 0));
    }

    // **【`V8-M10-T02` / `Q-G16a`。旧の実装を逐語で残す】**
    // **旧はここに、行ごとの読取判定(`roleRowReadable`)と、4分岐の論理和として組んだ
    // `postFiltered` の定義が在った**:
    //   `const roleRowReadable = (row: Record<string, unknown>): boolean =>`
    //     `!roleTableRead.conditional || judgeRoleAccess({ …, row, subject: roleSubject }).allowed;`
    //   `const postFiltered =`
    //     `anonymousPublic || ownerField !== undefined || accessSources !== undefined ||`
    //     `roleTableRead.conditional;`
    // **どちらも `owner-scope.ts` の1本(`judgeRecordPopulation` / `recordPopulationScope`)
    // へ移した。** **主張は1ミリも弱めていない** —— **4つの項は今日もあちらに在り、
    // 順序も1バイトも同じである**(`record-population-home.test.ts` の (A-1) が固定)。
    //
    // **条件つきの読取規則は SQL に落とせない**(`owner-scope.ts` の裁定「DB 側には1バイトも
    // 落とさない」)。**したがって `st_public` / `st_owner` / 行ごとの付与とまったく同じ形で、
    // 全行を読んでから JS で絞り、絞ったあとの集合を母集団として `total` を数える。**
    // **「絞りが要るか」は母集団の分類がそのまま答える** —— **`"unfiltered"`(分岐5)だけが
    // DB の `LIMIT` / `OFFSET` を使ってよい。**
    const populationScope = recordPopulationScope({
      manifest,
      table: resolved.table,
      anonymousPublic,
      accessSources,
      tableRead: roleTableRead,
    });
    const postFiltered = populationScope !== "unfiltered";

    // post-filter 分岐ではページング前の全行が要るので、limit/offset を外した条件で読む。
    const listQuery: ListRecordsOptions = { ...options };
    if (postFiltered) {
      delete listQuery.limit;
      delete listQuery.offset;
    }

    const body = withReadSource(dataRoot, manifest.app.id, (source) => {
      const result = readRecordList(source, manifest, tableId, listQuery);
      if (!result.ok) {
        // **(c) `V4-M35`**: 実在しない項目を指した 400 が、隠した項目のIDを数え上げさせない。
        return {
          status: 400 as const,
          json: errorBody(scrubHiddenFieldIds(manifest, resolved.table, result.errors)),
        };
      }

      // **【`V8-M10-T02` / `Q-G16a`】母集団を決めるのは `owner-scope.ts` の1本である。**
      // **ここに可視性の条件式を1つも書かない**(`ADR-0061` 限定4)。
      //
      // **【旧の5分岐の見出しを逐語で残す。消していない】**
      //   `if (anonymousPublic) {` … 匿名公開読み取り(ADR-0034 §3 限定3)
      //   `if (ownerField !== undefined) {` … 個人スコープ(ADR-0016 / `D-V8-35`)
      //   `if (accessSources !== undefined) {` … 行ごとのアクセス権(`Z-G11` / `V7-M2-T02`)
      //   `if (roleTableRead.conditional) {` … 条件つきの読取規則だけが立っている表(`J-G12`)
      //   (5本目 = 非スコープ。**下の `readRecordCountAndSum` の1文がそれである**)
      // **絞り方の中身(`isPublicRow` / `isOwnerVisible` / `roleReadCrossesOwnerScope` /
      // 条件つき規則の行ごとの評価 / 上限の見つけ方)は、1つ残らずあちらへ移した。**
      //
      // **【ここに残るもの(集約しないもの)。逐語で書く】** —— **射影(`dropHidden` /
      // `projectForAnonymous`)・表示名の解決(`resolveOwnerDisplays`)・ページ切り
      // (`slicePage`)・件数と合計の採り方。**
      //
      // **判定の配管(`recordAccessJudge`)はここで組む** —— **DB を読む手を持っているのは
      // サーバ層だけであり、`owner-scope.ts` は `src/kernel/` から値を1つも import しない。**
      const judge = recordAccessJudge(
        source,
        manifest,
        tableId,
        roleSubject,
        accessSources,
        readerRoles,
      );
      // **【`V14-M1-T01` / 台帳 `RB-G3`】「その行に付与を配れるか」の配管。**
      // **`judge` と同じく、読む手はサーバ層が持ち、判定は `owner-scope.ts` の1本である。**
      // **宣言していない表では `undefined` であり、応答は着手前と1バイトも変わらない。**
      const grantWrite = recordGrantWritePipe(
        source,
        manifest,
        tableId,
        roleSubject,
        accessSources,
        readerRoles,
      );
      const population = judgeRecordPopulation({
        manifest,
        table: resolved.table,
        tableId,
        rows: result.value,
        anonymousPublic,
        actorId: roleSubject,
        roles: readerRoles,
        accessSources,
        tableRead: roleTableRead,
        judge,
        grantWrite,
      });
      // **1行でも上限に当たったら要求全体を 4xx にする**(`Z-G17` / `V7-M4-T04`)——
      // **黙って行を落とすと、上限に当たった状態と「本当に見えない」状態が
      // 応答の上で区別できなくなる。** **翻訳は `errors.ts` の1本。**
      if (population.kind === "limit_exceeded") {
        return {
          status: 400 as const,
          json: errorBody([recordAccessLimitError(population.limit)]),
        };
      }
      if (population.kind === "visible") {
        switch (population.scope) {
          case "anonymous_public": {
            // 匿名公開読み取り(ADR-0034 §3 限定3): 予約規約フィールドを伏せて返す。
            const visible = population.rows.map(projectForAnonymous).map(dropHidden);
            return {
              status: 200 as const,
              // **合計は SQL ではなく、`total` を数えている同じ `visible` から採る**
              // (`V4-M23-T02` / `ADR-0104` 限定7)。**追加の DB 往復は0である。**
              json: withSum(
                { records: slicePage(visible, limit, offset), total: visible.length },
                sumVisible(visible),
              ),
            };
          }
          case "owner_scoped": {
            const actor = c.get("user") as AuthUser;
            // **表の単位で1回見る**(表示名の解決に使う)。**行ごとの判定は母集団の側。**
            const roleCrossesOwner = roleReadCrossesOwnerScope({
              manifest,
              roles: actor.roles,
              table: tableId,
            });
            const visible = population.rows;
            // **他人の行が見えうるときだけ** owner id を表示名に解決する(V3-M8-T03 /
            // ADR-0016 §6 / ADR-0061 限定7 と同じ形)。**ページを切ったあとに掛ける** ——
            // 解決するのは返す行だけでよい。
            const page = slicePage(visible, limit, offset);
            const resolvedPage = roleCrossesOwner
              ? resolveOwnerDisplays(manifest.app.id, page, actor.id)
              : page;
            return {
              status: 200 as const,
              // **合計は `total` を数えている同じ `visible` から採る**(限定7)——
              // **ページを切る前・射影を掛ける前の可視集合であり、`total` と構造的に
              // 同じ母集団である**(限定5)。
              json: withSum(
                {
                  // **E-G54(V4-M6)**: 「書けるが効かない値」を読取応答に残さない。
                  // **射影は `owner-scope.ts` の1本**(ADR-0061 限定4)。
                  records: resolvedPage.map((row) => dropHidden(row)),
                  total: visible.length,
                  // **【`V14-M1-T05` / 台帳 `RB-G1`】この枝も行ごとの判定を並べる。**
                  // **`V14-M1-T01` はここを空けていた** —— **空けたままだと、個人所有と
                  // 宣言を併せ持つ表で issue と同じ「出るのに押せない」が残る。**
                  // **母集団が組まなかったとき(= 点が管轄外。`st_owner` は在るが
                  // 行ごとのアクセス権を宣言していない表)は、キーごと足さない** ——
                  // **`undefined` を代入して `JSON.stringify` が落とすのに頼らない**
                  // (応答は着手前と1バイトも同じである、を明示的に組む)。
                  // **引くのは `page` である**(`resolvedPage` は表示名を解決した写しで
                  // あり、`_id` は同じだが、判定の引き先は射影前の行に固定しておく)。
                  ...(population.access === undefined
                    ? {}
                    : { access: accessForPage(page, population.access) }),
                },
                sumVisible(visible),
              ),
            };
          }
          case "record_access": {
            // **【`V14-M1-T01` / 台帳 `RB-G1` / `RB-G2`】この枝だけが `access` を載せる。**
            //
            // **【旧の姿を逐語で残す。消していない】** —— **着手前、この `case` は
            // 下の `role_conditional` と束ねられており、注記はこうだった**:
            //   `// **行ごとのアクセス権(`Z-G11`)と、条件つきの読取規則だけが立っている表`
            //   `// (`J-G12`)は、返し方が1バイトも同じである** —— **着手前も2つの分岐の`
            //   `// `return` は同じ形だった。** **違うのは母集団の決め方だけであり、それは`
            //   `// `owner-scope.ts` の側に在る。**`
            // **今日、返し方は同じではない** —— **こちらだけが行ごとの判定を並べる。**
            // **束ねを割ったのは、`role_conditional` 枝が判定のクロージャを1度も
            // 呼んでおらず、載せようとすると全行ぶんの判定を新しく走らせることになる
            // からである**(計画 `A-8b` の実測)。
            const visible = population.rows;
            const page = slicePage(visible, limit, offset);
            return {
              status: 200 as const,
              json: withSum(
                {
                  records: page.map((row) => dropHidden(row)),
                  total: visible.length,
                  access: accessForPage(page, population.access),
                },
                sumVisible(visible),
              ),
            };
          }
          case "role_conditional": {
            // **条件つきの読取規則だけが立っている表(`J-G12`)。**
            // **`access` は載せない**(この枝は判定のクロージャを1度も呼んでいない。
            // **そもそもこの表は行ごとの付与を宣言していないので、点が無い**)。
            const visible = population.rows;
            return {
              status: 200 as const,
              json: withSum(
                {
                  records: slicePage(visible, limit, offset).map((row) => dropHidden(row)),
                  total: visible.length,
                },
                sumVisible(visible),
              ),
            };
          }
          default: {
            // **網羅を型で固定する**(`v8-m10.md` §2-7 の「構造的な死角」への手当て)。
            const exhaustive: never = population.scope;
            throw new Error(`未知の母集団の分類: ${String(exhaustive)}`);
          }
        }
      }
      // 非スコープ(既定・システムテーブル): DB 層で LIMIT/OFFSET 済み。total は filter 適用後の全件。
      // **件数と合計は同じ1文で採る**(`V4-M23-T02` / `ADR-0104` 限定6)—— `readRecordCountAndSum`
      // が `SELECT COUNT(*) AS n, SUM(<列>) AS s … WHERE …` を1回だけ投げる。
      // **合計を求めていないときは着手前と同じ `SELECT COUNT(*) AS n …` の1文である。**
      // **母集団は `total` とまったく同じ `filterOnly` である**(限定5)。
      const total = readRecordCountAndSum(source, manifest, tableId, {
        ...filterOnly,
        ...(sumField === undefined ? {} : { sumField }),
      });
      if (!total.ok) {
        // **(c) `V4-M35`**: 件数・合計の 400 も同じ扱いにする(`?sum=` の 400 が主な当たり先)。
        return {
          status: 400 as const,
          json: errorBody(scrubHiddenFieldIds(manifest, resolved.table, total.errors)),
        };
      }
      return {
        status: 200 as const,
        json: withSum(
          {
            records: result.value.map((row) => dropHidden(row)),
            total: total.value.count,
          },
          total.value.sum ?? 0,
        ),
      };
    });
    return c.json(body.json, body.status);
  });

  // 4. レコード1件取得
  app.get("/api/apps/:app_id/tables/:table_id/records/:record_id", (c) => {
    const tableId = c.req.param("table_id");
    const recordId = c.req.param("record_id");
    const loaded = loadManifest(c.req.param("app_id"));
    if (!loaded.ok) {
      return c.json(errorBody(loaded.errors), 404);
    }
    const manifest = loaded.value;
    const resolved = resolveTableForRoute(manifest, tableId);
    if (!resolved.ok) {
      return c.json(errorBody(resolved.errors), resolved.status);
    }

    // 行ごとのアクセス権(`Z-G11` / `V7-M2-T02`)。**行を読んだのと同じ `ReadSource` の中で
    // 付与を読む** —— 開き直しを増やさないためである。**判定は `owner-scope.ts` の1本**
    // (ここに条件式を書かない。`ADR-0061` 限定4)。**宣言していない表では `undefined` で、
    // 以下は着手前と1バイトも変わらない。**
    const actor = c.get("user") as AuthUser | undefined;
    // --- 面(役割に束ねた権限)の**表**の規則 —— 読取(`V8-M17` / `J-G6`)-----------------
    //
    // **見えない行と同じ 404 で伏せる**(`v7-m0.md` §5-4 (vi) の関門順序と同じ向き)——
    // **403 を返すと「その行が在る」ことが役割の外へ漏れる。**
    // **判定は `owner-scope.ts` の1本**(ここに規則を読む条件式を1つも書かない)。
    // **【`V8-M19`】点が管轄内なら止めない**(`D-V8-23` の `OR`。下の合成判定が決める)。
    const singleSources = recordAccessSourceTables(manifest, tableId);
    if (
      roleGateBlocksWithoutGrants({
        role: judgeRoleAccess({
          manifest,
          roles: actor?.roles ?? null,
          target: { target: "table", table: tableId },
          verb: "read",
        }),
        grantGoverned: singleSources !== undefined,
      })
    ) {
      return c.json(errorBody([unknownRecordError(tableId, recordId)]), 404);
    }
    // --- 面の**条件**(`V8-M18` / `J-G12` / `J-G13`)----------------------------------------
    //
    // **上の関門は行を渡していない**(表そのものが読めるか)。**ここで初めて行が手元に在るので、
    // 同じ判定にその行を渡して条件を確定させる。** **一覧の post-filter とまったく同じ答えに
    // なる** —— **判定は `owner-scope.ts` の1本であり、ここに条件式を1つも書かない。**
    // **見えない行と同じ 404 で伏せる**(403 にすると「その行が在る」ことが漏れる)。
    // **【`V8-M19`】点が管轄内の表では当てない**(下の合成判定が `OR` で重ねている)。
    //
    // **【`V8-M19` が置き場所だけを動かした。1文字も消していない】** —— **上の段落は、下の
    // `if (singleSources === undefined && !judgeRoleAccess(…))` の説明である。**
    // **説明する側の `if` は行を読んだあとに在り、置き場所を動かしたのは、判定の戻り値を
    // 捨てていないことを綴りの距離で数えている既存の検査
    // (`access-control-paths.test.ts` の (C-1))の窓に収めるためである。**
    const loadedRecord = withReadSource(dataRoot, manifest.app.id, (source) => {
      const read = readRecord(source, manifest, tableId, recordId);
      if (!read.ok || read.value === null) {
        return { result: read, access: undefined, grantWrite: false };
      }
      const judge = recordAccessJudge(
        source,
        manifest,
        tableId,
        actor?.id ?? null,
        singleSources,
        actor?.roles ?? null,
      );
      // **【`V14-M1-T01` / `V14-M1-T03`】「その行に付与を配れるか」も、同じ `ReadSource`
      // の中で答える** —— **開き直しを増やさないためである**(判定の配管と同じ理由)。
      // **宣言していない表では `undefined` であり、以下は着手前と1バイトも変わらない。**
      const grantWrite = recordGrantWritePipe(
        source,
        manifest,
        tableId,
        actor?.id ?? null,
        singleSources,
        actor?.roles ?? null,
      );
      return {
        result: read,
        access: judge === undefined ? undefined : judge(read.value as Record<string, unknown>),
        grantWrite:
          grantWrite === undefined ? false : grantWrite(read.value as Record<string, unknown>),
      };
    });
    const result = loadedRecord.result;
    if (!result.ok) {
      return c.json(errorBody(result.errors), 400);
    }
    if (result.value === null) {
      return c.json(errorBody([unknownRecordError(tableId, recordId)]), 404);
    }
    if (
      singleSources === undefined &&
      !judgeRoleAccess({
        manifest,
        roles: actor?.roles ?? null,
        target: { target: "table", table: tableId },
        verb: "read",
        row: result.value as Record<string, unknown>,
        subject: actor?.id ?? null,
      }).allowed
    ) {
      return c.json(errorBody([unknownRecordError(tableId, recordId)]), 404);
    }
    // 匿名公開読み取り(ADR-0034 §3 限定3): 非公開行(st_public!==true)は**存在も値も出さない**
    // ため 404 で伏せる。公開行は予約規約フィールドを伏せて返す(ETag は付けない —— 匿名は
    // 書込に使えない)。認証済みの分岐(st_owner 可視性)より前に置く。
    if (c.get("anonymousPublic") === true) {
      if (!isPublicRow(result.value)) {
        return c.json(errorBody([unknownRecordError(tableId, recordId)]), 404);
      }
      return c.json({
        // **【`V8-M17` / `J-G7`】面の項目の規則を旧層の射影の隣で当てる**(未ログインは
        // `anonymous` として判定される。`J-G11`)。
        record: projectForRoleFields({
          manifest,
          table: resolved.table,
          row: projectForAnonymous(result.value),
          roles: null,
          // **【`V8-M18` / `J-G13`】未ログインは `null`** —— **「自分」は偽に評価される。**
          subject: null,
        }),
      });
    }
    // 個人スコープ(ADR-0016): 他人の個人行は「存在しない」として 404(ETag を付ける前)。
    // **【`V8-M20` / `J-G30` / `D-V8-35`】一覧とまったく同じ形で、面の規則が**読取**を
    // 許している表では owner 軸を越える。** **判定は `owner-scope.ts` の
    // `roleReadCrossesOwnerScope` 1本**(ここに条件式を書かない)。
    const ownerField = personalOwnerField(resolved.table);
    let roleCrossesOwner = false;
    if (ownerField !== undefined) {
      const owner = actor as AuthUser;
      roleCrossesOwner = roleReadCrossesOwnerScope({
        manifest,
        roles: owner.roles,
        table: tableId,
        row: result.value as Record<string, unknown>,
        subject: owner.id,
      });
      if (!isOwnerVisible(result.value[OWNER_FIELD], owner.id) && !roleCrossesOwner) {
        return c.json(errorBody([unknownRecordError(tableId, recordId)]), 404);
      }
    }
    // 行ごとのアクセス権(`Z-G11` / `V7-M2-T02`): **付与の無い行は存在を伏せて 404。**
    // **403 にしない** —— `app.ts` の `DELETE` 側の逐語(「他人の守られた行に 409 を返すと
    // 『守られた行がそこに在る』ことが漏れる」)と同じ理由で、**存在を伏せる層が先に立つ。**
    // **所有者スコープの 404 と隣に置く**(`v7-m0.md` §5-4 (vi) の関門順序 (1)(2))。
    // **上限に当たったら「見えない」に丸めない**(`Z-G17` / `V7-M4-T04`)—— **404 に
    // 混ぜると、上限に当たった状態と「本当に見えない」状態が応答の上で区別できなくなる。**
    if (loadedRecord.access?.kind === "limit_exceeded") {
      return c.json(errorBody([recordAccessLimitError(loadedRecord.access.limit)]), 400);
    }
    if (loadedRecord.access !== undefined && !loadedRecord.access.verdict.read) {
      return c.json(errorBody([unknownRecordError(tableId, recordId)]), 404);
    }
    // 現在の版を ETag で返す(PATCH/DELETE の If-Match に使える。M5)。**版は整形前の行から
    // 取る** —— 表示名解決は `st_owner` の1キーしか触らないので CAS には混ざらない(V3-M8-T03)。
    const version = (result.value as { _updated_at?: unknown })._updated_at;
    if (typeof version === "string") {
      c.header("ETag", version);
    }
    // **他人の行が見えうるときだけ** owner id を表示名に解決する(ADR-0016 §6 / ADR-0061 限定7)。
    const resolvedRecord = roleCrossesOwner
      ? (resolveOwnerDisplays(manifest.app.id, [result.value], (actor as AuthUser).id)[0] as Record<
          string,
          unknown
        >)
      : result.value;
    // **E-G54(V4-M6)**: 一覧と同じく、運営可視の宣言フィールドを読取応答に残さない。
    // **版(ETag)は射影の前に取ってある** —— 射影は `_updated_at` を1バイトも触らない。
    // **`B-G2`(V4-M3-T06 / ADR-0071 限定5)**: あわせて、その相手に見せないと宣言された
    // 項目も落とす。**判定は `owner-scope.ts` の1本**(ここに条件式を書かない)。
    // **【`V14-M1-T02` / 台帳 `RB-G1`】行ごとの判定を、行と**並べて**返す。**
    // **既存キー `record` の形は1バイトも変えていない** —— **足したのは兄弟の
    // `access` 1本であり、一覧と同じく行の `_id` を鍵にした写像である。**
    // **宣言していない表では、このキーごと存在しない**(`singleSources` が `undefined`
    // なら判定そのものが `undefined` である)。
    // **匿名公開の分岐はこの手前で `return` しており、そちらには載せていない** ——
    // **一覧の `anonymous_public` 枝と同じ扱いである。**
    const singleAccess =
      loadedRecord.access === undefined
        ? undefined
        : recordRowAccessMap({
            entries: [
              {
                row: result.value as Record<string, unknown>,
                verdict: loadedRecord.access.verdict,
              },
            ],
            grantWrite: () => loadedRecord.grantWrite,
          });
    return c.json({
      // **【`V8-M17` / `J-G7`】面の項目の規則を旧層の射影の隣で当てる**(重ね順は AND)。
      record: projectForRoleFields({
        manifest,
        table: resolved.table,
        row: resolvedRecord,
        roles: actor?.roles ?? null,
        // **【`V8-M18`】項目の規則に条件が書いてあれば行ごとに効く。**
        subject: actor?.id ?? null,
      }),
      ...(singleAccess === undefined ? {} : { access: singleAccess }),
    });
  });

  /**
   * **4b. 「誰にも見えない行」を見つける、運営専用の口**(`Z-G19` / `V7-M5-T02` /
   * `D-V7-15`)。**`Z-G18` が閉じた行のうち、付与が1件も無いものだけを一覧で返す。**
   *
   * **【母集団の定義。2つを**両方**満たす行だけである】**
   *  - **(a)** その行を直接指す付与が0件。
   *  - **(b)** **引き継ぎ(`inherit_from`)を辿った先のどの段にも、付与が1件も無い。**
   *
   * **【(b) を足した理由と、限定(1) を破っていないことの逐語】** ——
   * **`Z-G19` 限定(1) は「並ぶのは付与が0件の行だけ」である。** **これは**必要条件**で
   * あって十分条件ではなく、(b) を足して母集団を**狭める**のは限定(1) に1ミリも反しない**
   * (**並ぶ行はすべて「付与が0件の行」のままである**)。**狭めた根拠は
   * `docs/plan/v7/01-record-access-grant-baseline.md` §7 の `V7-M5` の完了の考え方 (ii) の
   * 逐語「**『誰にも見えない行』を見つける道が実在し、それが (i) の壁を迂回する新しい
   * 抜け道になっていないこと。**」である。** **(b) が無いと、親にだけ付与が在る子の行が
   * 並び、他人には見えているその行の中身を運営がこの口から読めてしまう**(**初版で実測した
   * 穴である**。`record-access-orphans.test.ts` の (Y-1) がその行が並ばないことと、同じ行が
   * 他人からは 200 で読めることを、同じテストの中で並べて固定する)。
   *
   * **【置き場所。`/records` の下ではなく兄弟にした理由】** —— **`/records/:record_id` と
   * 同じ深さに置くと、単件 `GET` のルート照合が `unreachable-records` を `:record_id` として
   * 拾いうる。** **兄弟のパス(区切りの数が1つ少ない)なら、どちらの向きにもぶつからない。**
   * **実測は `src/server/record-access-orphans.test.ts` の (I-1)〜(I-3)。**
   *
   * **【この口が守っている限定(`v7-m0.md` §6-3 `Z-G19`)】**
   *  1. **並ぶのは付与が0件の行だけ**(判断は `owner-scope.ts` の
   *     `resolveRecordWithoutGrants` 1本。**ここに条件式を書かない**。`ADR-0061` 限定4)。
   *  2. **読取専用** —— **このパスに `GET` 以外を1本も生やしていない**(`PATCH` /
   *     `DELETE` / `POST` は「エンドポイントがありません」の 404 になる)。
   *  3. **開くのは予約ロールの `owner` だけ**(`editor` / `viewer` / 宣言された種類は 403)。
   *  5. **アクセス権の管理を有効にしたと宣言した表だけが対象**(それ以外は 404。
   *     オプトイン)。**宣言のキーの綴りをこのファイルに1文字も書かない**
   *     (`ADR-0294` 限定12。知っているのは `owner-scope.ts` の述語だけである)。
   *  6. **付与の突き合わせは判定と同じ1本を通り**(`grantsTargetingRecord`)、**辿りも
   *     判定と同じ1本を通る**(`walkAccessInheritance`。訪問済み集合・段数5・読む行1000)
   *     —— **第2の述語も、第2の辿りも、新しい上限も1つも書いていない。**
   *
   * **【上限に当たったときの形】** —— **要求全体を 400 にする**(`V7-M4-T04` が単件・
   * 一覧で採った形にそろえた)。**黙って落とすと「辿りきれなかった行」が「取り残しは
   * 無い」と読める応答になり、運営者が取り残しを見落とす。**
   *
   * **【誇張しない。この口が意味しないこと】**
   *  - **「運営が回復できる」ことを1ミリも意味しない** —— **付与を作れるのは行の作成者と
   *    運営である**(`D-V7-14`)が、**作成者が消えた行の回復手順は v7 の射程外である。**
   *  - **付与は在るが相手が解決できない行(相手のメンバー行が消えた行)は、この口に
   *    1件も並ばない** —— **付与が0件ではないためである。**
   *  - **`st_public` はこの口の相手ではない** —— **`st_public` と宣言の同居は適用時に
   *    拒否される**(`V7-M1-T05` の適用時検査。実測は同テストの (Y-5))。**したがって
   *    「公開表で未認証がこのハンドラまで届く」場合分けは、今日は到達できない。**
   */
  app.get("/api/apps/:app_id/tables/:table_id/unreachable-records", recordsAuthMiddleware, (c) => {
    const tableId = c.req.param("table_id");
    const loaded = loadManifest(c.req.param("app_id"));
    if (!loaded.ok) {
      return c.json(errorBody(loaded.errors), 404);
    }
    const manifest = loaded.value;
    const resolved = resolveTableForRoute(manifest, tableId);
    if (!resolved.ok) {
      return c.json(errorBody(resolved.errors), resolved.status);
    }
    // **ロールの関門を先に置く** —— **後ろに置くと、「宣言している表」と「していない表」の
    // 区別が 403 と 404 の差になって運営以外に漏れる。**
    const actor = c.get("user") as AuthUser | undefined;
    // **【`V8-M16` / `J-G3`】実効ロール集合に `owner` が1つでも在れば通る(和集合1本)。**
    if (actor === undefined || !actor.roles.includes("owner")) {
      return c.json(errorBody([forbiddenUnreachableListError()]), 403);
    }
    // **宣言していない表 / `enabled: false` の表には、この口が無い**(オプトイン)。
    // **どの表を読めばよいかを知っているのは `owner-scope.ts` の述語1本である。**
    //
    // ===================================================================================
    // **【`V8-M41` / 台帳 `F-G13` = 限定採用・門外(`Δ7`)。2026-08-13。直前の2行の
    //   コメントも、下の旧の2行も、1バイトも消していない】**
    // ===================================================================================
    //
    // **旧(逐語)**:
    //
    //     const accessSources = recordAccessSourceTables(manifest, tableId);
    //     if (accessSources === undefined) {
    //       return c.json(errorBody([unreachableListUnavailableError(tableId)]), 404);
    //     }
    //
    // **`v8-m33.md` §12 の `D-13` が実測した欠陥である** —— **逐語「`diaries` には行が
    // 1行実在するのに 404 を返す。この口が拾うのは(行ごとのアクセス権を)宣言した表だけで
    // ある」**(**引用のうち宣言のキーの綴りだけを言い換えた** —— **このファイルにその綴りを
    // 1文字も書かない作法があり、`access-control-stale-grant.test.ts` の (E-1) が固定している。
    // `ADR-0294` 限定12)。
    // **`cp-v8-unify.md` §20-D の 4 が本物の HTTP で同じものを再現している。**
    //
    // **`undefined` は2つの意味を同時に持っていた** —— **(1)「点(行ごとの付与)を宣言して
    // いない表」と、(2)「取り残しが在りえない表」。** **(2) は今日は成り立たない** ——
    // **`V8-M26`(`D-V8-45` / `D-V8-58` / `D-V8-65`)が面の既定を閉じたので、その表を
    // 名指しした規則が1本も無ければ、どの役割からもその行は読めなくなる。**
    //
    // **`v8-m35.md` §5-1 の `F-G13` の限定の逐語**: 「**運営専用の口だけを広げる。**
    // **一般の一覧・単件の伏せ方(`ADR-0317` 限定5)を1バイトも動かさない**」。
    //
    // **【何を変えたか。3行で書く】**
    //  1. **点を宣言した表**: **1バイトも変えていない**(下の `resolveRecordWithoutGrants`
    //     の枝がそのまま残る)。
    //  2. **点を宣言していない表**: **404 をやめ、面の判定で「誰にも届かない行」を拾う**
    //     (`resolveRecordUnreachableByRoles`。**判定は `owner-scope.ts` の1本**。
    //     ここに規則を読む条件式を1つも書かない。`ADR-0061` 限定4)。
    //  3. **システムが持つ表**: **今日どおり 404 のままにした** —— **面の判定を1度も
    //     受けない表であり**(`judgeRoleAccess` の `targetsSystemTable`)、**取り残しが
    //     構造上ありえない。** **応答を1バイトも動かさない側に倒した。**
    //
    // **【404 が残る条件の全量】** **実在しない表**(上の `resolveTableForRoute`)と、
    // **システムが持つ表**(この直下)の**2つだけ**である。
    //
    // **【伏せ方と衝突していないこと】** —— **`ADR-0305` 限定11 / `ADR-0317` 限定5 が
    // 伏せているのは「一般の相手から」であって「運営から」ではない。** **一覧の 200 の
    // 空一覧も、単件の 404 も、この口の 403 も、1バイトも動かしていない**
    // (実測は `src/server/role-unreachable-records.test.ts` の (B-1)〜(B-4))。
    // **【禁止】これを「伏せ方を緩めた」と読まない** —— **緩めていない。**
    // **【禁止】逆に「運営が回復できるようになった」とも書かない** —— **並んだ行に規則を
    // 足す手段を1つも増やしていない**(`Z-G19` の「誇張しない」をそのまま引き継ぐ)。
    const accessSources = recordAccessSourceTables(manifest, tableId);
    const grantGoverned = accessSources !== undefined;
    if (!grantGoverned && resolved.system) {
      return c.json(errorBody([unreachableListUnavailableError(tableId)]), 404);
    }
    // **読取の要求の作法は一覧 `GET` と同じ1本を通す**(`limit` / `offset` / 並べ替え /
    // 絞り込み / 「見せない項目」を条件に書かせない検査)。**新しい方言を作らない。**
    const parsed = parseListOptions(resolved.table, new URL(c.req.url).searchParams);
    if (!parsed.ok) {
      return c.json(errorBody(scrubHiddenFieldIds(manifest, resolved.table, parsed.errors)), 400);
    }
    const options = parsed.value;
    const hiddenQueryErrors = hiddenFieldQueryErrors(manifest, resolved.table, options);
    if (hiddenQueryErrors.length > 0) {
      return c.json(errorBody(hiddenQueryErrors), 400);
    }
    const { limit, offset } = options;
    // **母集団は「付与0件の行」の集合である** —— **一覧 `GET` の post-filter 分岐と同じく、
    // ページングの前に全行を読む**(`ADR-0042` §限界2 の代償をここでも引き受ける)。
    const listQuery: ListRecordsOptions = { ...options };
    delete listQuery.limit;
    delete listQuery.offset;

    const body = withReadSource(dataRoot, manifest.app.id, (source) => {
      const result = readRecordList(source, manifest, tableId, listQuery);
      if (!result.ok) {
        return {
          status: 400 as const,
          json: errorBody(scrubHiddenFieldIds(manifest, resolved.table, result.errors)),
        };
      }
      // **行の読み方は判定の配管とまったく同じ1本である**(`memoizedRowReaders`)——
      // **付与表も親の表も、1回の要求のあいだ表ごとに1度だけ読む。**
      // **母集団の判断は `owner-scope.ts` の1本**(**引き継ぎのどの段にも付与が無いか**を
      // 見る。ここに条件式を書かない。`ADR-0061` 限定4)。
      const { readRows, readRow } = memoizedRowReaders(source, manifest);
      // **【`V8-M41` / 台帳 `F-G13`】着手前は、この `orphan` に点の側の述語だけが
      // 枝分かれ無しで置かれていた**(下の3項演算子の**真の側**が、その1行そのままである)。
      //
      // **【旧の1行を逐語で貼らなかった理由。黙って省いていない】** ——
      // **`src/server/access-control-limit-honesty.test.ts` の (E-4) が、このファイルに
      // 出てくる点の側の述語の**呼び出し回数**を `1` に固定している。** **逐語のコメントを
      // 置くと、その検査がコメントを呼び出しとして数えて赤くなり、期待値を `2` に緩める
      // ことになる** —— **緩めると「打ち切りを丸めた呼び出しが増えた」ことを検出できなく
      // なる。** **検査の側を弱めるより、こちらを散文で書く側に倒した。**
      //
      // **点を宣言した表では、着手前と1バイトも同じ1本が今日も通る。** **宣言していない表でだけ、
      // 面の側の母集団の述語を通す** —— **どちらも `owner-scope.ts` の述語であり、
      // ここに条件式を1つも書いていない**(`ADR-0061` 限定4)。
      const scanned = (result.value as Record<string, unknown>[]).map((row) => ({
        row,
        orphan: grantGoverned
          ? resolveRecordWithoutGrants({ manifest, tableId, row, readRows, readRow })
          : resolveRecordUnreachableByRoles({ manifest, tableId, row }),
      }));
      // **1行でも上限に当たったら要求全体を 400 にする** —— **`V7-M4-T04`(`Z-G17`)が
      // 単件・一覧で採った形にそろえた。** **黙って落とすと、「辿りきれなかった行」が
      // 「取り残しは無い」と読める応答になり、運営者が取り残しを見落とす。**
      const limited = scanned.find((entry) => entry.orphan.kind === "limit_exceeded")?.orphan;
      if (limited?.kind === "limit_exceeded") {
        return { status: 400 as const, json: errorBody([recordAccessLimitError(limited.limit)]) };
      }
      const visible = scanned
        .filter((entry) => entry.orphan.kind === "orphan" && entry.orphan.orphan)
        .map((entry) => entry.row);
      return {
        status: 200 as const,
        // **応答の形は既存の一覧 `GET` とそろえる**(`records` と `total`)。
        // **隠し項目の落とし方も同じ2本を通す** —— **新しい射影を書いていない。**
        json: {
          records: slicePage(visible, limit, offset).map((row) =>
            // **【`V8-M17` / `J-G7`】面の項目の規則を旧層の射影の隣で当てる**(重ね順は AND)。
            projectForRoleFields({
              manifest,
              table: resolved.table,
              row,
              roles: actor.roles,
              // **【`V8-M18`】項目の規則に条件が書いてあれば行ごとに効く。**
              subject: actor.id,
            }),
          ),
          total: visible.length,
        },
      };
    });
    return c.json(body.json, body.status);
  });

  // 5. レコード作成
  app.post("/api/apps/:app_id/tables/:table_id/records", async (c) => {
    const tableId = c.req.param("table_id");
    const loaded = loadManifest(c.req.param("app_id"));
    if (!loaded.ok) {
      return c.json(errorBody(loaded.errors), 404);
    }
    const manifest = loaded.value;
    const resolved = resolveTableForRoute(manifest, tableId);
    if (!resolved.ok) {
      return c.json(errorBody(resolved.errors), resolved.status);
    }
    if (resolved.system) {
      return c.json(errorBody([readOnlyTableError(manifest, tableId)]), 400);
    }

    // 直接作成の遮断(E-G49 / ADR-0077 限定3)。**ボディを読む前に当てる** —— 判定は表の
    // 宣言だけで決まり、行の値もロールも見ない(限定9)。**判定は `owner-scope.ts` の1本**
    // (ここに条件式を書かない。限定6)。
    if (isDirectCreateSuppressed(resolved.table)) {
      return c.json(errorBody([forbiddenDirectCreateError(tableId)]), 403);
    }

    // --- 面(役割に束ねた権限)の**ボタン**の規則(`V8-M17` / `J-G9`)---------------------
    //
    // **【`V8-M20` / `J-G29`】旧層(`view_action.audience`)の壁は撤去した。**
    // **壁は(アプリ, 表, 書込の種類)だけで決まり、要求が画面を名乗ったかどうかを1ミリも見ない。**
    // **`ADR-0077` の1つ上の関門とまったく同じ形で置く** —— **ボディを読む前**、かつ **401 の後**。
    // **判定は `owner-scope.ts` の1本**(ここに規則を読む条件式を1つも書かない)。
    if (
      !isRoleActionWriteAllowed(
        manifest,
        tableId,
        "create",
        (c.get("user") as AuthUser | undefined)?.roles ?? null,
      )
    ) {
      // --- 【`V8-M39` / 台帳 `F-G7`】**文面が名指しする層を、判定した層に合わせた** ---
      //
      // **旧(逐語)**:
      //
      //     return c.json(errorBody([forbiddenRoleAccessError(`表 "${tableId}"`, "作成")]), 403);
      //
      // **`v8-m33.md` §12 の `D-8` が実測した欠陥である** —— **表への書込を確かに許された
      // 役割に「表 "…" に対する作成は、あなたの役割に許されていません」が返るが、
      // 止めていたのは**ボタンの規則**(`isRoleActionWriteAllowed`)である。**
      //
      // **【なぜボタンIDを書かないか。嘘にならない側に倒した】** ——
      // **`isRoleActionWriteAllowed` の戻り値は `boolean` であり、「どのボタンが止めたか」を
      // 返さない**(`owner-scope.ts`)。**壁は「この表を書き先とする、面が名指しした
      // ボタンの**いずれか**を読めるか」で立つので、止めた1本を特定する概念がそもそも無い。**
      // **`v8-m35.md` §5-1 の `F-G7` の限定「**文面の引数を差し替えるだけ。判定の家を
      // 増やさない**」に従い、述語の戻り値の型を1バイトも変えていない** ——
      // **そのぶん、文面は「表 "…" のボタン」と**層**だけを名指しし、特定のボタンIDを
      // 騙らない。**
      return c.json(errorBody([forbiddenRoleAccessError(`表 "${tableId}" のボタン`, "作成")]), 403);
    }

    const body = await readJsonObject(c.req.raw);
    if (!body.ok) {
      return c.json(errorBody(body.errors), 400);
    }

    // 適用中(apply 窓)なら書込まず 409(ADR-0017 / M3: create こそ silent-loss の主対象)。
    // 監査行も残さないよう、カーネル書込の**前に**確かめる。
    const applying = isApplyInProgress(dataRoot, manifest.app.id);
    if (applying.inProgress) {
      return c.json(errorBody([applyInProgressError(applying)]), 409);
    }

    const actor = c.get("user");
    // **【`V8-M20` / `J-G28`】旧層(`writable_by` の `judgeFieldWrite`)は撤去した。**
    // **【`V8-M17` / `J-G7`】面の項目の規則。** **`st_owner` のスタンプより前に当てる** ——
    // 判定の対象はクライアントが送った入力であって、サーバが後から書く値ではない。
    // **止まれば要求全体が 403 になり、1バイトも書き込まれない。**
    const roleFieldWrite = judgeRoleFieldWrite({
      manifest,
      table: resolved.table,
      values: body.value,
      roles: (actor as AuthUser | undefined)?.roles ?? null,
    });
    if (roleFieldWrite.kind === "denied") {
      return c.json(
        errorBody([
          forbiddenRoleAccessError(
            `項目 ${roleFieldWrite.fields.map((id: string) => `"${id}"`).join(" / ")}`,
            "書き込み",
          ),
        ]),
        403,
      );
    }
    // 個人スコープ(ADR-0016): 個人所有テーブルは作成時に st_owner を actor.id で必ず上書きする
    // (クライアントが送った値=他人 id 詐称 も含めて矯正)。非個人テーブルは素通り。
    //
    // **【`V8-M37` / 台帳 `F-G3` / ユーザ決定 `D-V8-96`。上の2行は着手前の逐語であり、
    //   1バイトも消していない】**
    // **上の説明のうち「他人 id 詐称 も含めて矯正」は今日は成り立たない** ——
    // **他人の id を送った作成は、矯正されずに 403 で断られる。**
    // **矯正(スタンプ)そのものは今日も残る** —— **書かなかった / 空文字 / `null` を送った
    // 作成は今日どおり 201 で本人の行になる**(閉じすぎない)。
    // **判定は `owner-scope.ts` の1本**(ここに条件式を書かない。`ADR-0061` 限定4)——
    // **どの値を断るかの真理値表は `isOwnerSpoofedOnCreate` の doc が持つ。**
    // **射程は HTTP のこの口だけである** —— **MCP / まとめ書込 / 受信口は1バイトも触っていない。**
    const ownerField = personalOwnerField(resolved.table);
    if (ownerField !== undefined) {
      if (isOwnerSpoofedOnCreate(body.value, (actor as AuthUser).id)) {
        return c.json(errorBody([forbiddenOwnerSpoofError()]), 403);
      }
      body.value[OWNER_FIELD] = (actor as AuthUser).id;
    }
    // 行ごとのアクセス権(`Z-G11` / `V7-M3-T02`)。**関門は「作った人に何が渡るか」1つである。**
    //
    // **順序**: **(1) メンバー表に行が無ければ 400 →(2) 作った人に何も渡らない設定なら 400
    // →(3) 行を作る →(4) 作成者への付与を同じ処理の中で1件入れる**
    // (`D-V7-23` / `v7-m0.md` §5-5 (a))。
    //
    // **判定は `owner-scope.ts` の1本である**(ここに条件式を書かない。`ADR-0061` 限定4)——
    // **「これから作る行」と「これから入れる付与」の下見を組むのは `creatorGrantPlan` で、
    // その2つに `judgeRecordAccess` を当てているだけである。** **新しい述語を作っていない。**
    //
    // **【書く前に判定する理由】** —— **書いた後で「作った本人に見えない」と分かっても、
    // 行は既にディスクに在る。** **下見なら1行も書かずに止められる。**
    //
    // **【正直に書く。原子性は無い】** —— **(3) と (4) は別々の書込である**(付与は作成できた
    // 行の `_id` を要るため)。**(4) が失敗したら行だけが残る** —— **そのときは 500 を返すが、
    // 行を消して戻す処理は1バイトも書いていない**(`creatorGrantWriteFailedError` の doc)。
    const accessSources = recordAccessSourceTables(manifest, tableId);
    // V1-M9-T12: on_create の履歴書き込み失敗を、この同期書き込みが生んだぶんだけ収集する。
    // install→書き込み→collect→restore を withAppDb の同期コールバック内に閉じる(§4-2)。
    const outcome = withAppDb(dataRoot, manifest.app.id, (db) => {
      const actorId = (actor as AuthUser | undefined)?.id ?? null;
      // **付与表への書込を絞る(`Z-G5` / `V7-M3-T03`)。** **付与が指す行への権限で決める** ——
      // **判定は `owner-scope.ts` の1本**(ここに条件式を書かない。`ADR-0061` 限定4)。
      // **書く前に判定する** —— **拒否されたとき1行も書かれない。**
      {
        const denial = grantWriteDenial(
          grantWriteVerdict(
            { dataRoot, appDb: () => db },
            db,
            manifest,
            tableId,
            "create",
            body.value,
            actor as AuthUser | undefined,
          ),
        );
        if (denial !== null) {
          return { denied: denial.errors, status: denial.status };
        }
      }
      // **【`V15-M2-T04` / `CR-G1` / `CR-G3` / `CR-G6`。`ADR-0404`】親の行への書込を要求する。**
      //
      // **前提の関門である**(`AND`)—— **`isDirectCreateSuppressed` /
      // `isRoleActionWriteAllowed` とまったく同じ置き方で、**合成(`OR`)より先に落とす**。
      // **`OR` の後ろに置くと、その表を名指しした役割の規則が1本あるだけで素通りする。**
      // **判定は `owner-scope.ts` の1本**(ここに条件式を書かない。`ADR-0077` 限定6)——
      // **本ファイルは行を読む手を渡し、返ってきた4状態を応答へ写しているだけである。**
      // **書く前に判定する** —— **拒否されたとき1行も書かれない。**
      //
      // **【射程。誇張しない】** —— **効くのは HTTP のこの口だけである。**
      // **まとめ書き(`POST /batch`)は `V15-M3` が同じ1本を呼ぶまで素通りする。**
      // **MCP / 受信口 / ワークフロー / 島は `D-V15-3` が射程外にしたので今日も素通りする。**
      //
      // **【`V15-M3-T02` による訂正。上の3行は1バイトも消していない】** ——
      // **前2行は今日は偽である。** **`V15-M3` がまとめ書き(`POST /batch`)の `create` op
      // にも同じ `judgeCreateParentAccess` を配線した** —— **効くのは HTTP の2経路
      // (単件 `POST` / `POST /batch`)であり、この口だけではない**(`ADR-0404` 限定7 /
      // 限定13。**述語は1本のままで、判定の式を1バイトも写していない**)。
      // **3行目(MCP / 受信口 / ワークフロー / 島)は今日も真である。**
      {
        const readers = memoizedRowReaders({ dataRoot, appDb: () => db }, manifest);
        const denial = createParentDenial(
          judgeCreateParentAccess({
            manifest,
            tableId,
            values: body.value,
            actorId,
            readRows: readers.readRows,
            readRow: readers.readRow,
          }),
        );
        if (denial !== null) {
          return { denied: denial.errors, status: denial.status };
        }
      }
      const rows =
        accessSources === undefined
          ? undefined
          : recordAccessRows({ dataRoot, appDb: () => db }, manifest, tableId, accessSources);
      const plan =
        rows === undefined
          ? undefined
          : creatorGrantPlan({ manifest, tableId, actorId, memberRows: rows.memberRows });
      if (plan?.kind === "no_member") {
        return { denied: [notAMemberError()], status: 400 as const };
      }
      if (plan?.kind === "unusable") {
        return { denied: [creatorGrantUnreachableError()], status: 400 as const };
      }
      if (plan?.kind === "grant") {
        const verdict = judgeRecordAccess({
          manifest,
          tableId,
          row: plan.previewRow,
          actorId,
          grantRows: [plan.previewGrant],
          memberRows: rows?.memberRows ?? [],
        });
        // **【`V8-M19` / `D-V8-23`】面と点を `OR` で重ねる**(実測A の合流点(2)。**作成の下見**)。
        //
        // **点(この下見)が「作った本人に何も渡らない」と言っても、面が表の書込を通して
        // いれば作れる** —— **逆に、面が止めていても下見が何かを渡すなら作れる。**
        // **合成は `owner-scope.ts` の1本であり、ここに式は無い。**
        // **【正直に書く】** **作成には「その行」がまだ無いので、合成の単位の「行」は
        // これから作る行の下見である** —— **既存の行についての `OR` とは材料が違う。**
        // **【`V15-M2-T03` / `CR-G4` 限定1 / `ADR-0405`】fail-closed を独立の前提の関門に
        // した。** **旧(逐語)**:
        //
        //     const reachable = verdict.read || verdict.write || verdict.delete;
        //
        // **式そのものは1バイトも変えずに `owner-scope.ts` の `isCreatorGrantReachable` へ
        // 移した**(ここに条件式を書かない)。**変えたのは順序である** ——
        // **「作った本人に何も渡らない」なら、合成(`OR`)に入る前に断る。**
        // **今日までは `OR` の中に畳まれており、面(役割の規則)が表の書込を許していれば、
        // その設定の表にも行を作れていた。**
        //
        // **【`T03` の実測。丸めない】** —— **葉タスクは「`grant` に `undefined` を渡す形を
        // 試し、既存の検査が3本以内なら採る」と定めていた。** **実測は **94本** であり、
        // 4本以上なので**採っていない**。** **したがって `grant` に渡る値は今日のまま
        // (`creator_permission` から導いた到達可能性)であり、**「兼用をやめた」と書けるのは
        // 意味の側だけである。** **【禁止】合成に渡る材料まで分けた、と書かない。**
        const reachable = isCreatorGrantReachable(verdict);
        if (!reachable) {
          return { denied: [creatorGrantUnreachableError()], status: 400 as const };
        }
        const combined = combineRoleAndGrantAccess({
          role: judgeRoleAccess({
            manifest,
            roles: (actor as AuthUser | undefined)?.roles ?? null,
            target: { target: "table", table: tableId },
            verb: "write",
          }),
          grant: { read: reachable, write: reachable, delete: reachable },
          verb: "write",
        });
        if (!combined.allowed) {
          return { denied: [creatorGrantUnreachableError()], status: 400 as const };
        }
      }
      const written = collectWorkflowHistoryFailures(() =>
        writeWithAudit(
          db,
          actor,
          "create_record",
          tableId,
          () => createRecord(db, manifest, tableId, body.value),
          (record) => record._id,
        ),
      );
      if (written.value.ok && plan?.kind === "grant") {
        const granted = createRecord(
          db,
          manifest,
          plan.grantTable,
          plan.grantValues(written.value.value._id),
        );
        if (!granted.ok) {
          return { denied: [creatorGrantWriteFailedError()], status: 500 as const };
        }
      }
      return written;
    });
    if ("denied" in outcome) {
      return c.json(errorBody(outcome.denied), outcome.status);
    }
    const { value: result, failures } = outcome;
    if (!result.ok) {
      // **(c) `V4-M35` / `ADR-0135` 限定1**: **書込の 400 / 409 には1バイトも掛けない。**
      // **理由 = その項目は今日も書ける**(単位C は保留)**ので、「使える項目」の一覧から
      // 落とすと一覧が事実と食い違う**(憲法6 / `ADR-0086` 限定4 の原理。同 §2 の表)。
      // **落とすのは「読取の要求のデコードで出た 400」だけである。**
      return c.json(errorBody(result.errors), 400);
    }
    // 書き込みは成功しているので 201 のまま。履歴失敗は成功レスポンスの明示項目に載せる
    // (失敗が無ければ項目を付けない)。§6: エラーでない情報をエラー形式で返さない。
    //
    // **(b) `V4-M35` / `D-V4-124`**: **書込の応答にも、読取とまったく同じ射影を掛ける。**
    // **`ADR-0071` 限定4 /`ADR-0120` 限定7 が「書込の応答は1バイトも変えない」と書いた
    // 場所である** —— **`D-V4-124` がそれを引き直した。****射影は `owner-scope.ts` の
    // 1本で、読取経路(`dropHidden`)が呼ぶものと同一である**(`ADR-0061` 限定4)。
    // **【`V8-M17` / `J-G7`】面の項目の規則も、読取とまったく同じ隣り合わせで掛ける。**
    const createdRecord = projectForRoleFields({
      manifest,
      table: resolved.table,
      row: result.value,
      roles: (actor as AuthUser | undefined)?.roles ?? null,
      // **【`V8-M18`】項目の規則に条件が書いてあれば行ごとに効く。**
      subject: (actor as AuthUser | undefined)?.id ?? null,
    });
    return c.json(
      failures.length > 0
        ? { record: createdRecord, workflow_history_failures: failures }
        : { record: createdRecord },
      201,
    );
  });

  // 6. レコード部分更新(PUT を名乗らない: カーネルに全体置換は存在しない)
  app.patch("/api/apps/:app_id/tables/:table_id/records/:record_id", async (c) => {
    const tableId = c.req.param("table_id");
    const recordId = c.req.param("record_id");
    const loaded = loadManifest(c.req.param("app_id"));
    if (!loaded.ok) {
      return c.json(errorBody(loaded.errors), 404);
    }
    const manifest = loaded.value;
    const resolved = resolveTableForRoute(manifest, tableId);
    if (!resolved.ok) {
      return c.json(errorBody(resolved.errors), resolved.status);
    }
    // 読み取り専用拒否は**レコードの存在確認より前**に置く(ADR-0006 §7)。
    // 存在しないレコードIDへの PATCH が 404 で返ると、「レコードさえあれば書ける」という
    // 誤った推論を許してしまう。ADR-0003 §6 の「不在=404 / 不正=400」はここでは
    // 「そもそも書けない」が先に決まるので、400 が正しい。
    if (resolved.system) {
      return c.json(errorBody([readOnlyTableError(manifest, tableId)]), 400);
    }

    // **【`V8-M20` / `J-G29`】旧層(`view_action.audience`)の更新の壁は撤去した。**
    // **【`V8-M17` / `J-G9`】面のボタンの規則。`POST` 側とまったく同じ形・同じ並びで置く。**
    if (
      !isRoleActionWriteAllowed(
        manifest,
        tableId,
        "update",
        (c.get("user") as AuthUser | undefined)?.roles ?? null,
      )
    ) {
      // --- 【`V8-M39` / 台帳 `F-G7`】**旧(逐語)** ------------------------------------
      //
      //     return c.json(errorBody([forbiddenRoleAccessError(`表 "${tableId}"`, "更新")]), 403);
      //
      // **理由と、ボタンIDを書かない理由は、単件 `POST` 側の同じ関門の注記に書いた。**
      // **`D-8` が実測したのはこちらの `PATCH` の側である**(`表 "memos" に対する更新は…`)。
      return c.json(errorBody([forbiddenRoleAccessError(`表 "${tableId}" のボタン`, "更新")]), 403);
    }

    // If-Match(期待する版)は必須(ADR-0017 / 完了条件2)。無ければ 400。
    // 版一致 CAS を配線層で強制する唯一の入口であり、省略を許すと LWW に落ちる。
    const ifMatch = c.req.header("if-match");
    if (ifMatch === undefined || ifMatch === "") {
      return c.json(errorBody([missingIfMatchError()]), 400);
    }

    const body = await readJsonObject(c.req.raw);
    if (!body.ok) {
      return c.json(errorBody(body.errors), 400);
    }

    // 適用中(apply 窓)なら書込まず 409(ADR-0017 / M3)。
    const applying = isApplyInProgress(dataRoot, manifest.app.id);
    if (applying.inProgress) {
      return c.json(errorBody([applyInProgressError(applying)]), 409);
    }

    // **【`V8-M20` / `J-G28`】旧層(`writable_by` の `judgeFieldWrite`)は撤去した。**
    // **【`V8-M17` / `J-G7`】面の項目の規則。`POST` 側とまったく同じ形・同じ並びで置く。**
    // **行を読む前に当てる** —— 判定は入力だけで決まる(行の現在値を読まないので
    // TOCTOU の窓を1つも増やさない)。
    const roleFieldWrite = judgeRoleFieldWrite({
      manifest,
      table: resolved.table,
      values: body.value,
      roles: (c.get("user") as AuthUser | undefined)?.roles ?? null,
    });
    if (roleFieldWrite.kind === "denied") {
      return c.json(
        errorBody([
          forbiddenRoleAccessError(
            `項目 ${roleFieldWrite.fields.map((id: string) => `"${id}"`).join(" / ")}`,
            "書き込み",
          ),
        ]),
        403,
      );
    }

    return withAppDb(dataRoot, manifest.app.id, (db) => {
      // 「不在」を 404、「不正」を 400 に分けるための存在確認(ADR-0003 §6)。
      const existing = getRecord(db, manifest, tableId, recordId);
      if (!existing.ok) {
        return c.json(errorBody(existing.errors), 400);
      }
      if (existing.value === null) {
        return c.json(errorBody([unknownRecordError(tableId, recordId)]), 404);
      }
      // 個人スコープ(ADR-0016): 個人所有テーブルは (1) 他人/不可視の行は 404 で伏せ、
      // (2) st_owner を書き換える PATCH は「据え置き or 共有化」だけ許し、他人への付け替えや
      //     共有行の私物化(claim)は 403。非個人テーブルは ownerField=undefined で素通り。
      const ownerField = personalOwnerField(resolved.table);
      if (ownerField !== undefined) {
        const actor = c.get("user") as AuthUser;
        if (!isOwnerVisible(existing.value[OWNER_FIELD], actor.id)) {
          return c.json(errorBody([unknownRecordError(tableId, recordId)]), 404);
        }
        // **【`V8-M37` / 台帳 `F-G5`】旧(逐語)**:
        //     if (
        //       Object.hasOwn(body.value, OWNER_FIELD) &&
        //       !isAllowedOwnerUpdate(body.value[OWNER_FIELD], existing.value[OWNER_FIELD])
        //     ) {
        //       return c.json(errorBody([forbiddenOwnerError()]), 403);
        //     }
        //
        // **`F-G5` が読取の側で「自分の行も表示名で返す」ようにしたので、
        // 読んだ内容をそのまま書き戻すと持ち主の欄が表示名になって届く。**
        // **旧の判定はそれを他人への付け替えと見なして 403 にした**(実測で再現した退行)。
        // **`judgeOwnerUpdateWithDisplay` は「現在の持ち主の表示名のままの書き戻し」1形だけを
        // 通し、通したときは保存される値を現在の持ち主の id に戻す。**
        // **他人への付け替えは、表示名でも id でも1つも通らない。**
        // **判定は `owner-scope.ts` の1本**(ここに条件式を書かない。`ADR-0061` 限定4)——
        // **`Object.hasOwn` の分岐も述語の中へ引き上げた。**
        const currentOwner = existing.value[OWNER_FIELD];
        if (
          !judgeOwnerUpdateWithDisplay(body.value, currentOwner, () =>
            ownerDisplayFor(manifest.app.id, currentOwner),
          )
        ) {
          return c.json(errorBody([forbiddenOwnerError()]), 403);
        }
      }
      // 行ごとのアクセス権(`Z-G11` / `V7-M2-T02`)。**関門の順序は
      // 「(1) 見えないなら 404 → (2) 見えるが書けないなら 403」**(`v7-m0.md` §5-4 (vi) の
      // (2)(3) と同じ並び)—— **見えない行に 403 を返すと、その行が在ることが漏れる。**
      // **判定は `owner-scope.ts` の1本**(ここに条件式を書かない。`ADR-0061` 限定4)。
      // **項目単位の書込制御(面の `judgeRoleFieldWrite`)を1バイトも上書きしない** —— **重ね順は
      // AND であり、あちらは既に上で当たっている**(`v7-m0.md` §5-4 (iv))。
      {
        const judge = recordAccessJudge(
          { dataRoot, appDb: () => db },
          manifest,
          tableId,
          (c.get("user") as AuthUser | undefined)?.id ?? null,
          recordAccessSourceTables(manifest, tableId),
          // **【`V8-M19`】面をここへ渡す** —— **合成は `owner-scope.ts` の1本が行う。**
          (c.get("user") as AuthUser | undefined)?.roles ?? null,
        );
        if (judge !== undefined) {
          const access = judge(existing.value as Record<string, unknown>);
          // **上限に当たったら「見えない」に丸めない**(`Z-G17` / `V7-M4-T04`)。
          if (access.kind === "limit_exceeded") {
            return c.json(errorBody([recordAccessLimitError(access.limit)]), 400);
          }
          if (!access.verdict.read) {
            return c.json(errorBody([unknownRecordError(tableId, recordId)]), 404);
          }
          if (!access.verdict.write) {
            return c.json(errorBody([forbiddenRecordWriteError()]), 403);
          }
        }
      }
      // **付与表への書込を絞る(`Z-G5` / `V7-M3-T03`)。** **判定に渡すのは「書き込んだあとの
      // 姿」である** —— **既存行に送られた値を重ねたものを渡す。** **そうしないと、相手だけを
      // 自分に付け替える `PATCH` が「相手が書かれていない」として素通りする。**
      // **判定は `owner-scope.ts` の1本**(ここに条件式を書かない)。
      {
        const denial = grantWriteDenial(
          grantWriteVerdict(
            { dataRoot, appDb: () => db },
            db,
            manifest,
            tableId,
            "update",
            { ...(existing.value as Record<string, unknown>), ...body.value },
            c.get("user") as AuthUser | undefined,
          ),
        );
        if (denial !== null) {
          return c.json(errorBody(denial.errors), denial.status);
        }
      }
      // **【`V15-M8-T03` / `CR-G9`。`ADR-0408`】更新で親の参照を書き入れる要求にも、
      // 作成とまったく同じ前提の関門を掛ける。**
      //
      // **塞ぐ穴は実物で再現している** —— **参照を空にしたまま行を作り(`(b-3)`。今日も
      // `201`)、その行を `PATCH` して書けない親の `_id` を書き入れると、その行は壁の内側に
      // 入っていた**(`src/server/create-parent-write.test.ts` の `(i-1)`)。
      //
      // **判定は `owner-scope.ts` の1本**(ここに条件式を書かない。`ADR-0077` 限定6)——
      // **作成の2箇所が呼ぶのとまったく同じ述語であり、2本目の判定の家を作っていない。**
      // **翻訳も作成と同じ `createParentDenial` 1本である**(断り文を1本も増やさない)。
      //
      // **`existing.value` を渡すのが要である** —— **述語はそれを受け取ったときだけ、
      // 要求が参照の値を**変える**要素に絞って見る。** **参照を1文字も変えない更新
      // (項目を送らない / 同じ値を送り直す)には1ミリも掛からない**(`(j-4)`)。
      //
      // **置き場所は行ごとの判定(見えない → 404 / 見えるが書けない → 403)の**後ろ**である**
      // —— **前に置くと、見えない行の存在が 403 で漏れる**(`v7-m0.md` §5-4 の (vi) の並び)。
      // **書く前に判定する** —— **拒否されたとき1バイトも書かれない。**
      //
      // **【射程。誇張しない】** —— **効くのは HTTP の4経路(作成2本 + 更新2本)である。**
      // **MCP / 受信口 / ワークフロー / 島は `D-V15-3` により今日も素通りする。**
      // **`DELETE` にも掛けていない。** **参照を**空にする**更新(壁の内側から抜き出す)は
      // 今日も通る**(`ADR-0408` §限界3)。
      {
        const readers = memoizedRowReaders({ dataRoot, appDb: () => db }, manifest);
        const denial = createParentDenial(
          judgeCreateParentAccess({
            manifest,
            tableId,
            values: body.value,
            previous: existing.value as Record<string, unknown>,
            actorId: (c.get("user") as AuthUser | undefined)?.id ?? null,
            readRows: readers.readRows,
            readRow: readers.readRow,
          }),
        );
        if (denial !== null) {
          return c.json(errorBody(denial.errors), denial.status);
        }
      }
      // V1-M9-T12: on_update の履歴書き込み失敗を、この同期書き込みが生んだぶんだけ収集する
      // (この withAppDb コールバックは同期。§4-2 の同期区間の規律を満たす)。
      const { value: result, failures } = collectWorkflowHistoryFailures(() =>
        writeWithAudit(
          db,
          c.get("user"),
          "update_record",
          tableId,
          () => updateRecord(db, manifest, tableId, recordId, body.value, ifMatch),
          () => recordId,
          () => true,
          // **E-G53 / D-V4-49**: 「どの項目を何から何に変えたか」を監査に残す。
          // **更新前の行(`existing.value`)は既に読んである** —— 比較のための2度目の読取を
          // 足さない(TOCTOU の窓を増やさない)。
          (updated) =>
            describeRecordChanges(existing.value ?? {}, updated as Record<string, unknown>),
        ),
      );
      if (!result.ok) {
        // 版不一致(CAS 衝突)は 409。通常のバリデーション失敗(400)と区別する。
        // **(c) `V4-M35` / `ADR-0135` 限定1**: **書込の 400 / 409 には1バイトも掛けない**
        // (`POST` と同じ理由。**その項目は今日も書けるので、落とすと一覧が嘘になる**)。
        return c.json(errorBody(result.errors), result.conflict === true ? 409 : 400);
      }
      // 更新後の版を ETag で返す(次の If-Match に使える。M5)。
      c.header("ETag", result.value._updated_at);
      // 書き込みは成功しているので 200 のまま。履歴失敗は成功レスポンスの明示項目に載せる
      // (失敗が無ければ項目を付けない)。§6: エラーでない情報をエラー形式で返さない。
      //
      // **(b) `V4-M35` / `D-V4-124`**: **読取とまったく同じ射影を掛ける。**
      // **`_updated_at` は落ちない**(予約規約フィールドでも宣言つき項目でもない)ので、
      // **次の `If-Match` を組む手が消えることはない。**
      // **【`V8-M17` / `J-G7`】面の項目の規則も、読取とまったく同じ隣り合わせで掛ける。**
      const updatedRecord = projectForRoleFields({
        manifest,
        table: resolved.table,
        row: result.value,
        roles: (c.get("user") as AuthUser | undefined)?.roles ?? null,
        // **【`V8-M18`】項目の規則に条件が書いてあれば行ごとに効く。**
        subject: (c.get("user") as AuthUser | undefined)?.id ?? null,
      }) as typeof result.value;
      return c.json(
        failures.length > 0
          ? { record: updatedRecord, workflow_history_failures: failures }
          : { record: updatedRecord },
      );
    });
  });

  // 7. レコード削除
  app.delete("/api/apps/:app_id/tables/:table_id/records/:record_id", (c) => {
    const tableId = c.req.param("table_id");
    const recordId = c.req.param("record_id");
    const loaded = loadManifest(c.req.param("app_id"));
    if (!loaded.ok) {
      return c.json(errorBody(loaded.errors), 404);
    }
    const manifest = loaded.value;
    const resolved = resolveTableForRoute(manifest, tableId);
    if (!resolved.ok) {
      return c.json(errorBody(resolved.errors), resolved.status);
    }
    if (resolved.system) {
      return c.json(errorBody([readOnlyTableError(manifest, tableId)]), 400);
    }

    // If-Match(期待する版)は必須(ADR-0017 / 完了条件2)。無ければ 400。
    const ifMatch = c.req.header("if-match");
    if (ifMatch === undefined || ifMatch === "") {
      return c.json(errorBody([missingIfMatchError()]), 400);
    }

    // 適用中(apply 窓)なら書込まず 409(ADR-0017 / M3)。
    const applying = isApplyInProgress(dataRoot, manifest.app.id);
    if (applying.inProgress) {
      return c.json(errorBody([applyInProgressError(applying)]), 409);
    }

    const actor = c.get("user");
    return withAppDb(dataRoot, manifest.app.id, (db) => {
      // 個人スコープ(ADR-0016): 個人所有テーブルで、対象が実在するのに他人/不可視なら、
      // 存在を伏せて 404(deleteRecord の前に判定)。非個人テーブルは ownerField=undefined で素通り。
      const ownerField = personalOwnerField(resolved.table);
      if (ownerField !== undefined) {
        const existing = getRecord(db, manifest, tableId, recordId);
        if (
          existing.ok &&
          existing.value !== null &&
          !isOwnerVisible(existing.value[OWNER_FIELD], (actor as AuthUser).id)
        ) {
          return c.json(errorBody([unknownRecordError(tableId, recordId)]), 404);
        }
      }
      // 行ごとのアクセス権の「消す」(`Z-G34` / `V7-M3-T06`)。
      //
      // **関門の順序は `v7-m0.md` §5-4 の (vi) に固定されている**:
      //   **(1) 所有者スコープの 404 →(2) 付与の可視性 404 →(3) 付与の「消す」403
      //    →(4) 削除保護 409**
      //
      // **(1)(2) を隣に置くのは、どちらも「存在を伏せる」層だからである** —— 下の
      // 削除保護のコメントが述べる「**他人の守られた行に 409 を返すと『守られた行が
      // そこに在る』ことが漏れる**」が、そのまま (2) にも当たる。
      //
      // **(3) を (4) より前に置く理由**: **見えている行に対しては「あなたには消す権限が
      // 無い」と言うほうが、「この行は消せません」より正確だからである。**
      //
      // **判定は `owner-scope.ts` の1本**(ここに条件式を書かない。`ADR-0061` 限定4)。
      //
      // **【境界。`Z-G25` の中身である】** —— **項目ごとの書込宣言(`ADR-0076`)を
      // `DELETE` に1バイトも配線しない。** **§3a-2 が門にしているのは「項目単位の判定を
      // `DELETE` に掛ける」提案であり、ここで掛けるのは**行単位**の判定で、項目を1つも
      // 見ない**(`v7-m0.md` §5-9)。**画面の操作起点の壁(`ADR-0249` 限定1)も今日どおり
      // 掛からない。** **この2つの述語の綴りは、本ハンドラの中に1文字も無い** ——
      // **それを機械で固定しているのが `src/server/access-control-delete.test.ts` の (E) で
      // あり、綴りをコメントに書くだけでも赤くなる**(だから名前をここに書いていない)。
      //
      // **【TOCTOU は解決していない】** —— **`DELETE` 経路は今日もトランザクションを1つも
      // 開かない**(下の逐語)。**関門を1本増やしても窓は残る。**
      {
        const judge = recordAccessJudge(
          { dataRoot, appDb: () => db },
          manifest,
          tableId,
          (actor as AuthUser | undefined)?.id ?? null,
          recordAccessSourceTables(manifest, tableId),
          // **【`V8-M19`】面をここへ渡す** —— **合成は `owner-scope.ts` の1本が行う。**
          (actor as AuthUser | undefined)?.roles ?? null,
        );
        if (judge !== undefined) {
          const existing = getRecord(db, manifest, tableId, recordId);
          if (existing.ok && existing.value !== null) {
            const access = judge(existing.value as Record<string, unknown>);
            // **上限に当たったら「見えない」に丸めない**(`Z-G17` / `V7-M4-T04`)。
            if (access.kind === "limit_exceeded") {
              return c.json(errorBody([recordAccessLimitError(access.limit)]), 400);
            }
            if (!access.verdict.read) {
              return c.json(errorBody([unknownRecordError(tableId, recordId)]), 404);
            }
            if (!access.verdict.delete) {
              return c.json(errorBody([forbiddenRecordDeleteError()]), 403);
            }
          }
        }
      }
      // 削除不可規約(V4-M4-T05 / ADR-0073 = `B-G8`): **行の状態が `DELETE` を止める。**
      //
      // **位置**: `If-Match` の CAS と個人スコープの事前判定の**後ろ**、`writeWithAudit` の
      // **手前**(ADR-0073 限定10: 既存の2つの関門を1バイトも変えない)。順序をこうするのは
      // **他人の守られた行に 409 を返すと「守られた行がそこに在る」ことが漏れる**からで、
      // 個人スコープの 404(存在を伏せる)が先に立つ必要がある。
      //
      // **判定式をここに書かない**(限定5)—— `owner-scope.ts` の `isDeleteProtectedRow` 1本を
      // 呼ぶだけである。**actor もロールも渡さない: 止めるのは行の状態であって誰かではない。**
      //
      // **DELETE 経路は今日もトランザクションを1つも開かない**(`V4-M4-T00` §2-2 の実測)ので、
      // ここの読み出しは `writeWithAudit` の外にある —— **単件 PATCH / バッチと同じ TOCTOU の
      // 窓が残る**(`judgeOwnerScopedOp` の `readRow` と同型)。**解決していない。**
      {
        const existing = getRecord(db, manifest, tableId, recordId);
        if (
          existing.ok &&
          existing.value !== null &&
          isDeleteProtectedRow(resolved.table, existing.value)
        ) {
          return c.json(errorBody([deleteProtectedRecordError(tableId, recordId)]), 409);
        }
      }
      // **付与表からの削除を絞る(`Z-G5` / `V7-M3-T03`)。**
      //
      // **【これは `V7-M3-T06` の配線ではない。混ぜないこと】** —— **本経路が今日見るのは
      // 「この行が誰かの付与かどうか」だけである。** **`DELETE` に行ごとのアクセス権
      // (`judgeRecordAccess` の `delete`)を掛けるのは `V7-M3-T06` の担当であり、
      // 本タスクは1バイトも掛けていない** —— **`delete` を持たない権限名の actor は、
      // 今日も保護対象の行を消せる。**
      {
        const existing = getRecord(db, manifest, tableId, recordId);
        const denial =
          existing.ok && existing.value !== null
            ? grantWriteDenial(
                grantWriteVerdict(
                  { dataRoot, appDb: () => db },
                  db,
                  manifest,
                  tableId,
                  "delete",
                  existing.value as Record<string, unknown>,
                  actor as AuthUser | undefined,
                ),
              )
            : null;
        if (denial !== null) {
          return c.json(errorBody(denial.errors), denial.status);
        }
      }
      const result = writeWithAudit(
        db,
        actor,
        "delete_record",
        tableId,
        () => deleteRecord(db, manifest, tableId, recordId, ifMatch),
        () => recordId,
        // 実際に削除できたときだけ記録する(存在しない id の no-op DELETE は監査しない)。
        (deleted) => deleted,
      );
      if (!result.ok) {
        // 版不一致(CAS 衝突)は 409。通常のバリデーション失敗(400)と区別する。
        return c.json(errorBody(result.errors), result.conflict === true ? 409 : 400);
      }
      if (!result.value) {
        return c.json(errorBody([unknownRecordError(tableId, recordId)]), 404);
      }
      return c.body(null, 204);
    });
  });

  // 7.1 バッチ書込(V2-M4-T01 / ADR-0039。EC-G7 複数行の原子書込)
  //
  // **明示リストの create/update op を1 IMMEDIATE トランザクションで全成功か全失敗で書く。**
  // MCP `write_records` と同じカーネル関門 `writeRecords` を通る(ADR-0003 §7)。認証・認可
  // (editor/owner)・Origin 検査は `batchAuthMiddleware` が済ませている。監査 INSERT は
  // `onWritten` フックでバッチと**同一 tx**に束ねる(既存 `writeWithAudit` と同じ粒度。ただし
  // `writeWithAudit` 自体は1バイトも変えない —— バッチは deferred のネストを避けるため別経路)。
  app.post("/api/apps/:app_id/batch", async (c) => {
    const loaded = loadManifest(c.req.param("app_id"));
    if (!loaded.ok) {
      return c.json(errorBody(loaded.errors), 404);
    }
    const manifest = loaded.value;

    // ボディは { "ops": [ ... ] }。ops の中身(op 種別・table・values・target・if_match)の
    // 検証は**カーネル `writeRecords` に委ねる**(ADR-0003 §7。検証を1関門に集約する)。
    const raw = await readJsonBody(c.req.raw);
    if (!raw.ok) {
      return c.json(errorBody(raw.errors), 400);
    }
    const parsed = raw.value;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      !Array.isArray((parsed as { ops?: unknown }).ops)
    ) {
      return c.json(
        errorBody([
          {
            path: "/ops",
            message:
              'リクエストボディは { "ops": [ ... ] } の形で、ops に操作の配列を含めてください。',
            hint: 'ops の各要素は { "op": "create"|"update", "table": "<table_id>", "values": {...} } です。',
          },
        ]),
        400,
      );
    }
    const ops = (parsed as { ops: unknown[] }).ops as unknown as BatchOp[];

    // 適用中(apply 窓)なら1件も書かず 409(ADR-0017 / M3。create/update と同一意味論)。
    const applying = isApplyInProgress(dataRoot, manifest.app.id);
    if (applying.inProgress) {
      return c.json(errorBody([applyInProgressError(applying)]), 409);
    }

    const actor = c.get("user") as AuthUser;
    return withAppDb(dataRoot, manifest.app.id, (db) => {
      // 個人スコープ(ADR-0016)をバッチ経路にも当てる(V3-M8-T01b。審査は
      // `docs/plan/v3/records/v3-m8-gate-a-batch-owner-guard.md` = 門外(Δ7)/ 却下 = 帰属先は
      // サーバ層。射程の確定は ADR-0061 改訂1)。**単件 POST(スタンプ)/ 単件 PATCH
      // (可視性・付け替え)と同じ判定関数を、同じ順序で当てる** —— 新しい述語を1本も作らない
      // (ADR-0033 §Consequences「st_owner の有無で分岐する判定を新しく別経路に書かない」)。
      //
      //   create op: 個人所有テーブルなら `st_owner` を actor.id で**必ず**上書き(spoof 遮断。
      //              ADR-0016 §却下(iv)「クライアント送信を信用する経路は最初から作らない」)
      //   update op: (1) 可視性 —— 不可視なら **404**(存在そのものを伏せる)
      //              (2) `st_owner` の付け替え / 共有行の私物化(claim)なら **403**
      //
      // **(1) を (2) より先に置く。** 逆にすると、不可視の行が実在することが 403 で漏れる。
      //
      // **`roleReadCrossesOwnerScope` を渡さない。** **`D-V8-35` が開いたのは読取だけであり、
      //  面が読取を許した表でも書込は1ミリも開かない**(メインの裁定「越えるのは読取だけ」)。
      // **見えても書けない。** **この非対称は `ADR-0061` 限定1 が採っていた形と同じである。**
      //
      // **op の構造検証はここで行わない**(ADR-0003 §7。検証はカーネル `writeRecords` の1関門に
      // 集約する)。形が不正な op・実在しないテーブル・実在しない target は素通りさせ、従来どおり
      // カーネルに 400 を出させる —— ここで別の検証を始めると関門が2つになる。
      //
      // **正直な限界2点**: (i) この事前読取は `writeRecords` が開く IMMEDIATE tx の**外**にあり、
      // **TOCTOU 窓が残る**(単件 PATCH と同じ窓だが、op が N 件あるぶん窓は長い)。
      // (ii) **`if_match` は任意のままである** —— ADR-0017 が単件経路に課した If-Match 必須は
      // バッチ経路に掛かっておらず、本ガードはそれを直さない。
      //
      // **【V3-M13-T10 / ADR-0067 限定 A5】判定そのもの(述語 + 当てる順序)は
      // `owner-scope.ts` の `judgeOwnerScopedOp` 1本へ引き上げた** —— 島が返した op も
      // 同じ1本を通る(`src/kernel/workflow-runner.ts`)。**ここに残っているのは、判定結果を
      // HTTP のステータスへ翻訳することだけである。**
      // **行ごとのアクセス権(`Z-G11` / `V7-M3-T02`)で、create op に付ける作成者への付与。**
      // **op の索引を鍵にして覚え、`writeRecords` が成功したあとで1件ずつ入れる**
      // (`onWritten` の中で書かないのは、あちらが `writeRecords` の IMMEDIATE tx の**中**で
      // あり、`createRecord` が自前の tx を開くためである)。
      // **【`V15-M3-T02` / `CR-G5`。`ADR-0404`】作成の関門が行を読む手を、ループの**外**で
      // 1度だけ作る。**
      //
      // **op ごとに作り直すと記憶(memo)が効かず、op 数に比例して同じ表を読み直す**
      // (`ADR-0404` `S3` (4) の 計算量 = (op 数 × 行数 × 段数) が、そのまま効いてくる)。
      // **ループの中では1行も書かない** —— **書込は下の `writeRecords` が1 IMMEDIATE tx で
      // 行うので、記憶を op を跨いで持ち回っても古い値にならない。**
      // **単件 `POST` が使うのとまったく同じ `memoizedRowReaders` である**(新しい読み手を
      // 1本も作らない)。
      const batchRowReaders = memoizedRowReaders({ dataRoot, appDb: () => db }, manifest);
      const creatorPlans = new Map<number, Extract<CreatorGrantPlan, { kind: "grant" }>>();
      for (const [opIndex, rawOp] of (ops as unknown[]).entries()) {
        const rawTableId =
          typeof rawOp === "object" && rawOp !== null && !Array.isArray(rawOp)
            ? (rawOp as Record<string, unknown>).table
            : undefined;
        // 項目単位の書込制御(E-G48 / ADR-0076 限定4)。**`judgeOwnerScopedOp` より前に
        // 当てる** —— あちらは create op の `values.st_owner` を破壊的に上書きするので、
        // 後に置くとサーバが書いた値を判定してしまう。**判定は `owner-scope.ts` の1本。**
        const opTable =
          typeof rawTableId === "string" ? resolveTable(manifest, rawTableId) : undefined;
        const opValues =
          typeof rawOp === "object" && rawOp !== null && !Array.isArray(rawOp)
            ? (rawOp as Record<string, unknown>).values
            : undefined;
        // 直接作成の遮断(E-G49 / ADR-0077 限定3)。**create op だけを見る** —— update op は
        // 1バイトも変わらない。**判定は `owner-scope.ts` の1本**(ここに条件式を書かない)。
        const opKind =
          typeof rawOp === "object" && rawOp !== null && !Array.isArray(rawOp)
            ? (rawOp as Record<string, unknown>).op
            : undefined;
        if (opKind === "create" && opTable !== undefined && isDirectCreateSuppressed(opTable)) {
          return c.json(errorBody([forbiddenDirectCreateError(opTable.id)]), 403);
        }
        // 操作起点の「見せる相手」から立った書込の壁(`A-G1` / `ADR-0249` 限定1・限定6)。
        // **単件 `POST`(`:2606`)/ 単件 `PATCH`(`:2711`)とまったく同じ形で当てる** ——
        // **`create` op には作成の壁、`update` op には更新の壁**(`ADR-0249` §Decision 4 =
        // 作成の壁と更新の壁は別に数える)。**判定は `owner-scope.ts` の1本**(ここに条件式を
        // 書かない。限定6)。**要求が画面を名乗ったかどうかを1ミリも見ない**(限定7)。
        //
        // **壁は 401 の後である** —— 未認証は `batchAuthMiddleware` が今日どおり 401 で落とし、
        // `viewer` / `customer` は同 middleware が 403 で落とす(限定8)。
        //
        // **部分適用は起きない**: この `return` はカーネルの `writeRecords`(1 IMMEDIATE tx)を
        // 開く**前**にループごと抜ける —— **既存の 403 群(`forbiddenDirectCreateError` /
        // `forbiddenRoleAccessError` / `forbiddenOwnerError`)とまったく同じ抜け方であり、
        // **1つでも当たれば1行も書かれない。**
        //
        // **下の1行は op 種別を書込の種類へ写すだけの対応表である。**
        // **【`V8-M20` / `J-G29`】旧層(`view_action.audience`)の壁はここからも撤去した。**
        const opWriteKind: "create" | "update" | undefined =
          opKind === "create" || opKind === "update" ? opKind : undefined;
        // --- 面(役割に束ねた権限)の規則(`V8-M17` / `J-G6` / `J-G7` / `J-G9`)-----------
        //
        // **【`V8-M27-T03` / ユーザ決定 `D-V8-71`。「どの表の権限を見るか」の決定をここに書く】**
        //
        // **`D-V8-71` の説明文の逐語**:
        // > **まとめ書き込みは複数の表をまたぐので、どの表の権限を見るかを決める必要があります。**
        //
        // **決めたこと**: **要求に含まれる op が触る表を全部集め、そのすべてについて、
        // op の動詞ごとの判定を通す。** **1つでも通らなければ要求全体を拒否する**(`AND`)。
        // **通るはずだった他の op も1行も書かれない。**
        //
        // **理由**: **`writeRecords` は1 IMMEDIATE トランザクションであり、部分適用を作らないのが
        // 今日の作法である**(`ADR-0039`)。**可否だけを op ごとに分けて「通った op だけ書く」に
        // すると、原子性が権限の側から崩れる。** **「全部通るか、1行も書かないか」に揃えた。**
        // **`OR`(どれか1つの表に書けたら通す)は採っていない** —— **採ると、書ける表を1つ
        // 持っているだけで、書けない表へ同じ要求で書けてしまう。**
        //
        // **この形は `V8-M17` / `V8-M19` が既に置いていたものであり、`V8-M27-T03` は
        // 1バイトも動かしていない** —— **足したのは、この決定の記述と、それを固定する検査
        // (`src/server/batch-files-role-access.test.ts` の (a) / (b) / (c))である。**
        // **ファイルのアップロードは向きが違う**(あちらは `OR`)—— **理由は
        // `filesAuthMiddleware` の doc に書いた。要求が表を1つも名乗らないからである。**
        //
        // **【この関門が見ていないもの。誇張しない】** —— **表を解決できなかった op
        // (`opTable === undefined`)には1バイトも掛からない。** **形の不正・実在しない表・
        // システムテーブルはカーネルが 400 で落とすので書込にはならないが、
        // **「面が見た」とは書けない。** **`ops` が空配列の要求も、この関門を0回通る。**
        //
        // **単件 `POST` / 単件 `PATCH` / `DELETE` とまったく同じ判定を、同じ順序で当てる** ——
        // **入口を何本生やしても振る舞いが一致する**(`ADR-0003` §7)。**表の規則は単件では
        // `recordsAuthMiddleware` が当てているが、バッチは1要求で複数の表を跨ぐので
        // op ごとにここで当てる**(`isDirectCreateSuppressed` と同じ位置取り)。
        // **旧4層・固定ロールとの重ね順は今日も AND**(`04` §7-1 (乙))。**部分適用は起きない**
        // —— **この `return` はカーネルの `writeRecords`(1 IMMEDIATE tx)を開く**前**に
        // ループごと抜ける。**
        //
        // **【`V8-M19`】点が管轄内の表では、この関門で止めない**(`D-V8-23` の `OR`)——
        // **単件 `PATCH` / `DELETE` の中継層とまったく同じ判断であり、下流の合成判定
        // (update op)と作成の下見(create op)が (行, 要求している人, 動詞) の単位で決める。**
        const opRoleVerb: "write" | "delete" | undefined =
          opKind === "delete" ? "delete" : opWriteKind !== undefined ? "write" : undefined;
        if (
          opRoleVerb !== undefined &&
          opTable !== undefined &&
          roleGateBlocksWithoutGrants({
            role: judgeRoleAccess({
              manifest,
              roles: actor.roles,
              target: { target: "table", table: opTable.id },
              verb: opRoleVerb,
            }),
            // **【バッチの `delete` op は例外である。理由を書く】** —— **バッチは今日、
            // `delete` op に点の判定を1バイトも掛けていない**(掛かるのは `update` と
            // `create` だけである。v7 の実装のまま)。**そこで面を短絡させると、点も面も
            // 見ない `delete` ができてしまう** —— **穴を開けない側に倒し、`delete` op では
            // 面が最終の答えである**(単件 `DELETE` は下流が点を判定するので短絡してよい)。
            grantGoverned:
              opKind !== "delete" && recordAccessSourceTables(manifest, opTable.id) !== undefined,
          })
        ) {
          return c.json(
            errorBody([
              forbiddenRoleAccessError(
                `表 "${opTable.id}"`,
                opRoleVerb === "delete" ? "削除" : "書き込み",
              ),
            ]),
            403,
          );
        }
        if (
          opWriteKind !== undefined &&
          opTable !== undefined &&
          !isRoleActionWriteAllowed(manifest, opTable.id, opWriteKind, actor.roles)
        ) {
          // --- 【`V8-M39` / 台帳 `F-G7`】**旧(逐語)**: `` `表 "${opTable.id}"` `` ---
          //
          // **単件 `POST` / 単件 `PATCH` とまったく同じ取り違えが、まとめ書込にも在った。**
          // **`v8-m35.md` §5-1 が名指ししていたのは単件の2箇所だけだが、本 MS が
          // 全呼び出しを1件ずつ読み直して見つけた3箇所目である**(`F-G7` の (1) の逐語は
          // 「403 の文面が止めた層を誤って名指ししないようにする」であり、口を限っていない)。
          // **判定は単件と同じ `isRoleActionWriteAllowed`(ボタンの規則)である。**
          return c.json(
            errorBody([
              forbiddenRoleAccessError(
                `表 "${opTable.id}" のボタン`,
                opWriteKind === "create" ? "作成" : "更新",
              ),
            ]),
            403,
          );
        }
        const roleFieldWrite = judgeRoleFieldWrite({
          manifest,
          table: opTable,
          values: opValues,
          roles: actor.roles,
        });
        if (roleFieldWrite.kind === "denied") {
          return c.json(
            errorBody([
              forbiddenRoleAccessError(
                `項目 ${roleFieldWrite.fields.map((id: string) => `"${id}"`).join(" / ")}`,
                "書き込み",
              ),
            ]),
            403,
          );
        }
        const verdict = judgeOwnerScopedOp({
          table: opTable,
          op: rawOp,
          actorId: actor.id,
          readRow: (tableId, recordId) => {
            const existing = getRecord(db, manifest, tableId, recordId);
            return existing.ok && existing.value !== null ? existing.value : undefined;
          },
        });
        if (verdict.kind === "invisible") {
          return c.json(errorBody([unknownRecordError(verdict.tableId, verdict.target)]), 404);
        }
        // `no_actor` は HTTP 経路では起こらない(認証済みの actor が必ず居る)。**起きたら
        // 403 に倒す** —— 「actor が特定できないのに書けた」を作らない。
        if (verdict.kind === "forbidden" || verdict.kind === "no_actor") {
          return c.json(errorBody([forbiddenOwnerError()]), 403);
        }
        // **行ごとのアクセス権(`Z-G11` / `V7-M3-T02`)。** **単件 `POST` / 単件 `PATCH` と
        // 同じ判定関数を、同じ順序で当てる**(`v7-m0.md` §5-4 の (v)。**新しい述語を1本も
        // 作らない**)—— **update op は「(1) 見えないなら 404 → (2) 見えるが書けないなら
        // 403」、create op は「作った人に何が渡るか」1つ**である。
        // **所有者スコープ(`judgeOwnerScopedOp`)の後ろに置く** —— **存在を伏せる層の
        // 並びを、単件 `PATCH` と1ミリも違えないためである。**
        //
        // **部分適用は起きない**: この `return` はカーネルの `writeRecords`(1 IMMEDIATE tx)を
        // 開く**前**にループごと抜ける(既存の 403 群とまったく同じ抜け方)。
        // **付与表への書込を絞る(`Z-G5` / `V7-M3-T03`)。** **単件 `POST` / `PATCH` と
        // 同じ判定関数を、同じ順序で当てる**(新しい述語を1本も作らない)。
        // **`update` op には「既存行に送られた値を重ねたもの」を渡す**(単件 `PATCH` と同型)。
        // **部分適用は起きない**: この `return` は `writeRecords` の tx を開く前である。
        if (typeof rawTableId === "string" && opWriteKind !== undefined) {
          const opTarget = (rawOp as Record<string, unknown>).target;
          const before =
            opKind === "update" && typeof opTarget === "string"
              ? getRecord(db, manifest, rawTableId, opTarget)
              : undefined;
          const merged: Record<string, unknown> = {
            ...(before?.ok === true && before.value !== null
              ? (before.value as Record<string, unknown>)
              : {}),
            ...(typeof opValues === "object" && opValues !== null && !Array.isArray(opValues)
              ? (opValues as Record<string, unknown>)
              : {}),
          };
          const denial = grantWriteDenial(
            grantWriteVerdict(
              { dataRoot, appDb: () => db },
              db,
              manifest,
              rawTableId,
              opKind === "create" ? "create" : "update",
              merged,
              actor,
            ),
          );
          if (denial !== null) {
            return c.json(errorBody(denial.errors), denial.status);
          }
        }
        // **【`V15-M3-T02` / `CR-G5` / `CR-G1` / `CR-G3` / `CR-G6`。`ADR-0404`】親の行への
        // 書込を要求する。** **単件 `POST`(`:5944`)とまったく同じ述語を、まったく同じ
        // 相対位置(付与表の関門の**直後**・`opAccessSources` を引く**前**)で当てる。**
        //
        // **前提の関門である**(`AND`)—— **`isDirectCreateSuppressed` /
        // `isRoleActionWriteAllowed` と同じ置き方で、**合成(`OR`)より先に落とす**。
        // **判定は `owner-scope.ts` の1本**(ここに条件式を書かない。`ADR-0077` 限定6)——
        // **`ADR-0404` 限定13 の逐語「述語は1本。2箇所から呼ぶだけで、判定の式を写さない」。**
        // **翻訳も単件と同じ `createParentDenial` 1本である**(2本目を作らない)。
        //
        // **`create` op だけを見る** —— **`update` op / `delete` op は1バイトも変わらない。**
        //
        // **部分適用は起きない**: **この `return` はカーネルの `writeRecords`(1 IMMEDIATE
        // tx)を開く**前**にループごと抜ける** —— **既存の 403 群とまったく同じ抜け方であり、
        // 1つでも当たれば1行も書かれない。** **同じ要求の中で作るつもりの親は、まだ
        // ディスクに無いので判定からは見えない**(`ADR-0404` §Decision の 答え1「下見を
        // 作らない / これから作る行を鎖の一部として辿らない」と同じ向きである)。
        //
        // **【射程。誇張しない】** —— **本 MS が足したのはこの2経路目までである。**
        // **MCP / 受信口 / ワークフロー / 島は `D-V15-3` が射程外にしたので今日も素通りする。**
        if (opKind === "create" && typeof rawTableId === "string") {
          const denial = createParentDenial(
            judgeCreateParentAccess({
              manifest,
              tableId: rawTableId,
              values:
                typeof opValues === "object" && opValues !== null && !Array.isArray(opValues)
                  ? (opValues as Record<string, unknown>)
                  : {},
              actorId: actor.id,
              readRows: batchRowReaders.readRows,
              readRow: batchRowReaders.readRow,
            }),
          );
          if (denial !== null) {
            return c.json(errorBody(denial.errors), denial.status);
          }
        }
        const opAccessSources =
          typeof rawTableId === "string"
            ? recordAccessSourceTables(manifest, rawTableId)
            : undefined;
        if (opAccessSources !== undefined && typeof rawTableId === "string") {
          const opSource: ReadSource = { dataRoot, appDb: () => db };
          if (opKind === "update") {
            const target = (rawOp as Record<string, unknown>).target;
            const existing =
              typeof target === "string" ? getRecord(db, manifest, rawTableId, target) : undefined;
            const judge = recordAccessJudge(
              opSource,
              manifest,
              rawTableId,
              actor.id,
              opAccessSources,
              // **【`V8-M19`】面をここへ渡す** —— **合成は `owner-scope.ts` の1本が行う。**
              actor.roles,
            );
            if (judge !== undefined && existing?.ok === true && existing.value !== null) {
              const resolution = judge(existing.value as Record<string, unknown>);
              // **上限に当たったら「見えない」に丸めない**(`Z-G17` / `V7-M4-T04`)——
              // **バッチは1本の要求なので、1件でも上限に当たったら要求全体を 4xx にする。**
              if (resolution.kind === "limit_exceeded") {
                return c.json(errorBody([recordAccessLimitError(resolution.limit)]), 400);
              }
              if (!resolution.verdict.read) {
                return c.json(errorBody([unknownRecordError(rawTableId, target as string)]), 404);
              }
              if (!resolution.verdict.write) {
                return c.json(errorBody([forbiddenRecordWriteError()]), 403);
              }
            }
            // **【`V15-M8-T03` / `CR-G9`。`ADR-0408`】まとめ書きの `update` op にも、
            // 単件 `PATCH` とまったく同じ述語を、まったく同じ相対位置(行ごとの
            // 404 / 403 の**後ろ**)で当てる。** **判定は `owner-scope.ts` の1本であり、
            // ここに条件式を1つも書いていない**(`ADR-0077` 限定6)。
            //
            // **この口は版の照合(`If-Match`)を1度も要求しない** —— **`(i-2)` が
            // 実測したとおりであり、回り込みはこちらのほうが手数が少ない。**
            //
            // **部分適用は起きない**: **この `return` はカーネルの `writeRecords`
            // (1 IMMEDIATE tx)を開く**前**にループごと抜ける。**
            // **更新前の行が読めない op には1バイトも掛けない** —— **その op は
            // 今日どおりカーネルが断る**(応答コードを1つも動かさない)。
            if (existing?.ok === true && existing.value !== null) {
              const denial = createParentDenial(
                judgeCreateParentAccess({
                  manifest,
                  tableId: rawTableId,
                  values:
                    typeof opValues === "object" && opValues !== null && !Array.isArray(opValues)
                      ? (opValues as Record<string, unknown>)
                      : {},
                  previous: existing.value as Record<string, unknown>,
                  actorId: actor.id,
                  readRows: batchRowReaders.readRows,
                  readRow: batchRowReaders.readRow,
                }),
              );
              if (denial !== null) {
                return c.json(errorBody(denial.errors), denial.status);
              }
            }
          }
          if (opKind === "create") {
            const rows = recordAccessRows(opSource, manifest, rawTableId, opAccessSources);
            const plan = creatorGrantPlan({
              manifest,
              tableId: rawTableId,
              actorId: actor.id,
              memberRows: rows.memberRows,
            });
            if (plan?.kind === "no_member") {
              return c.json(errorBody([notAMemberError()]), 400);
            }
            if (plan?.kind === "unusable") {
              return c.json(errorBody([creatorGrantUnreachableError()]), 400);
            }
            if (plan?.kind === "grant") {
              const access = judgeRecordAccess({
                manifest,
                tableId: rawTableId,
                row: plan.previewRow,
                actorId: actor.id,
                grantRows: [plan.previewGrant],
                memberRows: rows.memberRows,
              });
              // **【`V8-M19` / `D-V8-23`】単件 `POST` とまったく同じ `OR` を、同じ順序で当てる**
              // (実測A の合流点(2)の2本目)。**入口を何本生やしても振る舞いが一致する。**
              //
              // **【`V15-M3-T03` / `CR-G4` 限定1 / `ADR-0405`】fail-closed を、まとめ書き側でも
              // 独立の前提の関門にした。** **旧(逐語。1バイトも消していない)**:
              //
              //     const reachable = access.read || access.write || access.delete;
              //
              // **式そのものは1バイトも変えずに `owner-scope.ts` の `isCreatorGrantReachable`
              // を呼ぶ形に揃えた**(ここに条件式を書かない)。**変えたのは順序である** ——
              // **「作った本人に何も渡らない」なら、合成(`OR`)に入る前に断る。**
              // **`V15-M2` が単件側だけを並べ替えたので、着手時のまとめ書きは `OR` の中に
              // 畳んだままであった** —— **その結果、同じ設定の表が単件では 400、まとめ書きでは
              // 通る、という食い違いが実際に在った**(`batch-create-parent-write.test.ts`
              // の `(q-1)` が着手前に「単件 400 / まとめ書き ok」を実測している)。
              // **すぐ上の逐語「入口を何本生やしても振る舞いが一致する」(`V8-M19` /
              // `D-V8-23`)が、今日ここで実際に成り立つようになった。**
              //
              // **`combineRoleAndGrantAccess` に渡る `grant` の値は今日のままである** ——
              // **`V15-M2-T03` の実測(`undefined` を渡すと既存の検査が **94本** 赤くなる)に
              // より、その形は採らないと決まっている**(`v15-m2.md` §2。再実験していない)。
              // **`combineRoleAndGrantAccess` の本体を1バイトも変えていない**(`ADR-0404` 限定2)。
              const reachable = isCreatorGrantReachable(access);
              if (!reachable) {
                return c.json(errorBody([creatorGrantUnreachableError()]), 400);
              }
              if (
                !combineRoleAndGrantAccess({
                  role: judgeRoleAccess({
                    manifest,
                    roles: actor.roles,
                    target: { target: "table", table: rawTableId },
                    verb: "write",
                  }),
                  grant: { read: reachable, write: reachable, delete: reachable },
                  verb: "write",
                }).allowed
              ) {
                return c.json(errorBody([creatorGrantUnreachableError()]), 400);
              }
              creatorPlans.set(opIndex, plan);
            }
          }
        }
      }
      // 監査スキーマ保証は writeRecords の tx の**外**で行う(`writeWithAudit` と同じ順序)。
      ensureAuthActivitySchema(db);
      // 各 op の成功直後に、バッチと同一 IMMEDIATE tx 内で監査行を書く。後続 op が失敗して
      // tx が巻き戻れば、この監査行も一緒に巻き戻る(部分適用ゼロ)。
      // **(b) `V4-M35` / `ADR-0134` 限定5**: **バッチは1リクエストで複数テーブルを跨ぐので、
      // 書けた行がどの表のものだったかを覚えておく。**
      //
      // **`0d05b1b` は `push` で積んでおり、「カーネルが `results.push` の直後に `onWritten`
      // を呼ぶ」という順序に暗黙に依存していた**(審査記録 §5-4 の #1)。**今日は
      // `BatchWrittenOp.index`(カーネルが渡す op の索引)を鍵にして明示的に置く** ——
      // **`writeRecords` は op を順に処理し、成功した op の結果だけを `results` に押すので、
      // `results` の索引と op の索引は一致する**(`src/kernel/batch.ts`)。**順序への暗黙の
      // 依存が1つ減る。**
      const writtenTables: (Table | undefined)[] = [];
      const onWritten = (written: BatchWrittenOp): void => {
        writtenTables[written.index] = resolveTable(manifest, written.op.table);
        recordActivity(db, {
          userId: actor.id,
          username: actor.username,
          action: written.op.op === "create" ? "create_record" : "update_record",
          tableId: written.op.table,
          recordId: written.record._id,
        });
      };
      const { value: result, failures } = collectWorkflowHistoryFailures(() =>
        writeRecords(db, manifest, ops, { onWritten }),
      );
      if (!result.ok) {
        // 版不一致(CAS 衝突)は 409、それ以外の検証失敗は 400(create/update と同一)。
        //
        // **(c) `V4-M35` / `ADR-0135` 限定1**: **書込の 400 / 409 には1バイトも掛けない**
        // (`POST` / `PATCH` と同じ理由)。**`0d05b1b` はここでエラーの `path` から表を
        // 引き直す13行のインラインの式を持っていたが、審査記録 §5-4 の #5 が限定表の外と
        // 判定したので取り消した** —— **判定を呼び出し側に書かない**(`ADR-0077` 限定6)
        // という向きにも、取り消した側が一致する。
        return c.json(errorBody(result.errors), result.conflict === true ? 409 : 400);
      }
      // **作成者への自動付与(`D-V7-23` / `V7-M3-T02`)。** **単件 `POST` とまったく同じ形で
      // ある** —— **行が書けたあとに、作成者への付与を1件入れる。**
      // **【正直に書く。原子性は無い】** —— **ここは `writeRecords` の IMMEDIATE tx の外で
      // ある。** **付与の書込が失敗したら、行だけが残る**(単件 `POST` と同じ限界)。
      for (const [index, plan] of creatorPlans) {
        const row = result.results[index];
        if (row === undefined) {
          continue;
        }
        const granted = createRecord(db, manifest, plan.grantTable, plan.grantValues(row._id));
        if (!granted.ok) {
          return c.json(errorBody([creatorGrantWriteFailedError()]), 500);
        }
      }
      // **(b) `V4-M35` / `D-V4-124`**: **書込の応答にも読取と同じ射影を掛ける。**
      // **表ごとに判定する** —— 1リクエストの中で表が変われば宣言も変わる。
      //
      // **`ADR-0134` 限定5(fail-open にしない)**: **表が決まらなかった行を黙って素通りさせると、
      // 隠すと宣言した値がその1行だけ応答に出る。** **今日この枝は到達しない**(成功した op には必ず
      // `onWritten` が来て、`resolveTable` はマニフェスト検証を通った表IDを必ず引ける)
      // **が、到達したら素通りではなく内部エラーで止める。**
      const batchRecords: Record<string, unknown>[] = [];
      for (const [index, row] of result.results.entries()) {
        const table = writtenTables[index];
        if (table === undefined) {
          return c.json(
            errorBody([
              {
                path: `/ops/${index}`,
                message:
                  "書けた行の表を特定できませんでした。応答を組み立てられないため中止しました。",
              },
            ]),
            500,
          );
        }
        // **【`V8-M17` / `J-G7`】面の項目の規則も、単件経路とまったく同じ隣り合わせで掛ける。**
        batchRecords.push(
          projectForRoleFields({
            manifest,
            table,
            row,
            roles: actor.roles,
            // **【`V8-M18`】項目の規則に条件が書いてあれば行ごとに効く。**
            subject: actor.id,
          }),
        );
      }
      return c.json(
        failures.length > 0
          ? { records: batchRecords, workflow_history_failures: failures }
          : { records: batchRecords },
        200,
      );
    });
  });

  // 7.5 ファイルのアップロード(V2-M2-T02 / ADR-0035 §1・限定5。
  //     **V5-M16-T02 / ADR-0161 + D-V5-84 で入口が2つになった**)。
  //
  // 認証・認可(editor/owner)・Origin 検査は `filesAuthMiddleware` が済ませている。ここでは
  // multipart を読み、size 上限(413)を検査し、受理したら sha256 を計算して blob へ保存
  // (de-dup)→ `_files` に1行 create → file_id を返す。
  // **file_id は sha256 とは別の UUID**(同一内容を別 filename で複数回上げても別 file_id。
  // blob 実体は sha256 で共有)。upload/delivery は kernel の CRUD 語彙(DIFF_OPS/MCP)を増やさず
  // server 層 HTTP に閉じる(限定5)。
  //
  // ## 入口は `kind` パートで2つに分かれる(V5-M16-T02)
  //
  // - **`kind` 省略 / `kind=image`**: **今日までの挙動と1バイトも違わない。**
  //   4種の画像 allowlist + マジックナンバー(415)/ 5 MiB(413)。
  // - **`kind=file`**: **受け入れる種類の制限は0件である**(`D-V5-84` が `ADR-0161` 限定6 の
  //   「4種の有限列挙」を覆した)。**HTML も SVG も zip も実行形式も 415 にならない。**
  //   上限は 20,000,000 バイト(限定7)。
  //
  // **危険は「上げさせない」ではなく「実行させない」で塞ぐ。** 蓄積型 XSS(他人のログイン情報を
  // 盗む攻撃)は **配信側**(7.6)が「実体が4種の画像と判定できないなら必ずダウンロードで返す」
  // ことで成立させない。**これは種類の制限ではない** —— **上げられる種類は今日も無制限である。**
  app.post("/api/apps/:app_id/files", async (c) => {
    const appId = c.req.param("app_id");

    let form: FormData;
    try {
      form = await c.req.raw.formData();
    } catch {
      return c.json(errorBody([missingUploadFileError()]), 422);
    }

    // `kind` は省略できる(既定 `image`)。**既存のクライアントを1バイトも変えないため。**
    const kindPart = form.get("kind");
    const kindRaw = typeof kindPart === "string" && kindPart !== "" ? kindPart : "image";
    if (!isUploadKind(kindRaw)) {
      return c.json(errorBody([unknownUploadKindError(kindRaw)]), 422);
    }
    const kind: UploadKind = kindRaw;
    const sizeLimit = kind === "image" ? MAX_UPLOAD_BYTES : MAX_FILE_UPLOAD_BYTES;

    const filePart = form.get("file");
    if (!(filePart instanceof File)) {
      return c.json(errorBody([missingUploadFileError()]), 422);
    }

    // size 上限(413)。File.size は本体を全読みせず分かる(第一関門)。
    if (filePart.size > sizeLimit) {
      return c.json(errorBody([payloadTooLargeError(filePart.size, kind)]), 413);
    }

    // 申告 MIME。**Bun の `req.formData()` は File.type を multipart パートの
    // Content-Type ヘッダではなく「ファイル名の拡張子」から導く**ため、ここでの「申告 MIME」は
    // 実質的に拡張子由来である(V2-M2-T02 実測。ブラウザが送る part の Content-Type は Bun が
    // 無視する)。したがって申告値は信用しきらない。
    const declaredMime = filePart.type !== "" ? filePart.type : undefined;
    // **`kind=image` のときだけ allowlist を掛ける**(415)。`kind=file` は1件も弾かない。
    if (kind === "image" && (declaredMime === undefined || !isAllowedImageMime(declaredMime))) {
      return c.json(errorBody([unsupportedImageMimeError(declaredMime)]), 415);
    }

    const data = new Uint8Array(await filePart.arrayBuffer());
    // 実バイト長でも上限を確かめる(Content-Length / File.size 詐称に対する二重チェック)。
    if (data.byteLength > sizeLimit) {
      return c.json(errorBody([payloadTooLargeError(data.byteLength, kind)]), 413);
    }

    // マジックナンバー検査(先頭バイト)。**`kind=image` では実体が allowlist の画像でなければ
    // 415。** これが「Content-Type を信用しすぎない」の本体で、拡張子/ヘッダ偽装を弾く。
    // **保存する MIME は実体判定(sniffed)を正とする**(申告と食い違っても実体を信頼)。
    //
    // **`kind=file` では1件も弾かない。** 保存する MIME は申告値をそのまま入れる
    // (拡張子が無ければ `application/octet-stream`)——
    // **`_files.mime` は「上げた側の申告の記録」であって、配信の形を決める権限を持たない。**
    // **配信の形は 7.6 が実体の先頭バイトだけを見て決める。**
    const sniffed = sniffImageMime(data);
    if (kind === "image" && sniffed === null) {
      return c.json(errorBody([unsupportedImageMimeError(declaredMime)]), 415);
    }

    const mime: string =
      kind === "image" ? (sniffed as AllowedImageMime) : (declaredMime ?? DEFAULT_UPLOAD_MIME);
    const filename = filePart.name !== "" ? filePart.name : null;
    // 先に blob 実体を保存(content-addressed・de-dup)。INSERT が失敗しても実体は
    // orphan blob として T04 の検出プリミティブで拾える(実体無しのメタ行より安全側)。
    const sha256 = putBlob(dataRoot, appId, data);
    const fileId = crypto.randomUUID();
    withAppDb(dataRoot, appId, (db) => {
      // 既存アプリ(本機能導入前作成)の遅延マイグレーション。新規アプリは create-app が作成済み。
      ensureFilesTable(db);
      insertFileRecord(db, { file_id: fileId, sha256, mime, size: data.byteLength, filename });
    });

    return c.json({ file_id: fileId, sha256, mime, size: data.byteLength, filename }, 201);
  });

  // 7.6 画像配信(V2-M2-T03 / ADR-0035 §1c・限定6)。
  //
  // **配信は GET のみ**。`/files/:file_id` への POST/PATCH/DELETE 経路は置かない —— アップロードは
  // 上の `POST /files`(認証必須)、削除は blob 刈り取り(T04)に閉じる。read-only を経路分離で守る。
  // `_files` を引き blob 実体を **sniff 済み mime** で返し、`X-Content-Type-Options: nosniff` を付ける。
  //
  // 可視範囲(最小性):
  //   - owner/editor/viewer : 全 file 配信可(records GET を認証済み全ロールに許すのと同じ水準)。
  //     **【`V7-M3-T07` / `Z-G36` の追記。上の行を1バイトも消していない】** ——
  //     **行ごとのアクセス権を使うと宣言した表の行から参照されている file は、この「全 file」
  //     から外れる。** **その file は、その行を読める人にしか配信しない**(**運営3ロールも
  //     付与を迂回しない**。`D-V7-22`)。**宣言していない表の file と、どの行からも参照されて
  //     いない file は今日どおり全部配信する。**
  //   - customer            : 自分の scoped 行(st_owner)+ 公開行(st_public=真)が参照する file のみ。
  //   - 未認証(匿名)       : 公開行(st_public=真)が参照する file のみ。**匿名経路なので publicGet
  //                           レート制限を掛ける**(ADR-0034 限定4 と同じ規律・単独禁止)。
  // 非公開/未参照/`_files`不在/file_id不在は **一律 404**(存在秘匿=列挙耐性の側。§限界3/4)。
  app.get("/api/apps/:app_id/files/:file_id", (c) => {
    const appId = c.req.param("app_id");
    const fileId = c.req.param("file_id");

    const appError = ensureApp(appId);
    if (appError !== null) {
      return c.json(errorBody([appError]), 404);
    }

    const user = resolveSessionUser(dataRoot, appId, c);

    // 匿名は高価な参照走査の前に流量を絞る(限定4。単独禁止)。
    if (user === undefined) {
      const decision = publicGetLimiter.hit(clientKeyFromHeader(c.req.header("x-forwarded-for")));
      if (!decision.allowed) {
        c.header("Retry-After", String(decision.retryAfterSec));
        return c.json(errorBody([rateLimitError(decision.retryAfterSec)]), 429);
      }
    }

    const meta = withAppDb(dataRoot, appId, (db) => getFileMeta(db, fileId));
    if (meta === null) {
      return c.json(errorBody([unknownFileError(fileId)]), 404);
    }

    // 認可: owner/editor/viewer は全 file、customer/匿名は参照ベース。
    // **【`V5-M17-T05`】等値比較 → `isReservedRole` の否定(上と同じ理由)。**
    //
    // **【`V7-M3-T07` / `Z-G36` が構造を変えた。旧文を1バイトも消していない】**
    //
    // **旧の分岐**: `if (user === undefined || !isReservedRole(user.role)) {` ——
    // **予約3ロールはこの中に1度も入らず、参照走査を通らなかった**(`v7-m0.md` §4-6)。
    // **今日は全員が走査を通る。** **予約3ロールかどうかは `FileViewer` が持ち、走査の中で
    // 「宣言していない表では今日どおり全行」に効く** —— **狭まるのは宣言した表だけである。**
    {
      // マニフェスト読取が壊れている(JSON 破損等)場合は配信せず 404 に倒す(未認証/customer に
      // 500 の内部状態を見せない。recordsAuthMiddleware の公開窓と同じ規律)。
      let manifest: Manifest | undefined;
      try {
        const loaded = loadManifest(appId);
        manifest = loaded.ok ? loaded.value : undefined;
      } catch {
        manifest = undefined;
      }
      const viewer: FileViewer =
        user === undefined
          ? { kind: "anonymous" }
          : // --- 【`V8-M27-T04` / `T-G5`】**代入を1本消した。旧文を1バイトも消していない** ---
            //
            // **旧(逐語)**:
            //
            //     {
            //       kind: "signed_in",
            //       actorId: user.id,
            //       // **【`V8-M16` / `J-G3`】実効ロール集合に予約ロールが1つでも在れば運営側。**
            //       reservedRole: user.roles.some(isReservedRole),
            //     }
            //
            // **`FileViewer` はロールを1バイトも持たない。**
            { kind: "signed_in", actorId: user.id };
      // **判定は `owner-scope.ts` の1本**(ここに条件式を書かない。`ADR-0061` 限定4)。
      // **表ごとに「読むべき表」を宣言から引き、付与行を読んで述語を組む**のは既存の配管
      // (`recordAccessJudge`)であり、走査には述語だけを渡す。
      const judgeFor = (
        source: ReadSource,
        tableId: string,
      ): ((row: Record<string, unknown>) => RecordAccessResolution) | undefined => {
        if (manifest === undefined) {
          return undefined;
        }
        // --- 面(役割に束ねた権限)の**表**の規則(`V8-M17` / `J-G6`)-------------------
        //
        // **読めない表の行は、この走査では1件も「見えている行」に数えない** ——
        // **数えると、表の規則で閉じた表の行が参照する画像だけが配信され続ける。**
        // **判定は `owner-scope.ts` の1本**(ここに規則を読む条件式を1つも書かない)。
        //
        // **【`V8-M19`】点が管轄内の表では、面だけで落とさない**(`D-V8-23` の `OR`)——
        // **行ごとの付与だけで見える行が参照する画像は、配信されなければならない。**
        // **その表の判定は下の配管(合成判定)が行ごとに行う。**
        if (
          roleGateBlocksWithoutGrants({
            role: judgeRoleAccess({
              manifest,
              roles: user?.roles ?? null,
              target: { target: "table", table: tableId },
              verb: "read",
            }),
            grantGoverned: recordAccessSourceTables(manifest, tableId) !== undefined,
          })
        ) {
          return () => ({
            kind: "verdict" as const,
            verdict: { read: false, write: false, delete: false },
          });
        }
        return recordAccessJudge(
          source,
          manifest,
          tableId,
          user?.id ?? null,
          recordAccessSourceTables(manifest, tableId),
          // **【`V8-M19`】面をここへ渡す** —— **合成は `owner-scope.ts` の1本が行う。**
          user?.roles ?? null,
        );
      };
      if (manifest === undefined) {
        // **【正直に書く。ここは fail-open である】** —— **マニフェストが読めないと「どの表が
        // 宣言しているか」を1つも知れないので、判定の入力が作れない。** **予約3ロールには
        // 今日どおり配信する**(完了条件 (ii) の「宣言していない表は着手前と同一」を、
        // 宣言の読めない場合にも当てた)。**塞いでいない穴として記録に書く。**
        //
        // --- 【`V8-M27-T04` / ユーザ決定 `D-V8-73`(2026-08-11)】-------------------------
        // **上の段落は今日から偽である。旧文を1バイトも消していない。**
        //
        // **旧(逐語)**: `if (viewer.kind === "anonymous" || !viewer.reservedRole) {`
        //
        // **`D-V8-73` の選ばれた説明文の逐語**:
        // > 「定義が読めないときは、画像や添付ファイルを誰にも配りません。この軸の
        // >  「書いていなければ見えない」と向きが揃いますが、**定義が壊れたときに運営が
        // >  中身を確かめる手段が1つ減ります**。」
        //
        // **したがって条件そのものを外し、fail-closed(誰にも配らない)に倒した。**
        // **代償は上の逐語のとおりである** —— **マニフェストが壊れた日、運営は
        // ブラウザから画像の中身を1件も確かめられない**(ファイル本体は
        // `<dataRoot>/apps/<appId>/blobs/` に今日どおり残っており、失われてはいない)。
        return c.json(errorBody([unknownFileError(fileId)]), 404);
      }
      {
        const visibility = isFileReferencedByVisibleRow(
          dataRoot,
          appId,
          manifest,
          fileId,
          viewer,
          judgeFor,
          // **【`V8-M27-T04`】面が `st_owner` の絞り込みを読取について越えるか**
          // (`D-V8-35` の述語をそのまま渡す。**ここに条件式を書かない**)。
          (tableId) =>
            roleReadCrossesOwnerScope({ manifest, roles: user?.roles ?? null, table: tableId }),
        );
        // **上限に当たったら「見えない」に丸めない**(`Z-G17` / `V7-M4-T04`)——
        // **404 の存在秘匿とは応答の形を変える。**
        if (visibility.kind === "limit_exceeded") {
          return c.json(errorBody([recordAccessLimitError(visibility.limit)]), 400);
        }
        if (visibility.kind === "withhold") {
          return c.json(errorBody([unknownFileError(fileId)]), 404);
        }
      }
    }

    const blob = getBlob(dataRoot, appId, meta.sha256);
    if (blob === null) {
      // メタは在るが実体が無い(orphan メタ)。存在秘匿の 404。
      return c.json(errorBody([unknownFileError(fileId)]), 404);
    }
    // **配信の形は実体の先頭バイトだけで決める(V5-M16-T03 / D-V5-84 の申し添え)。**
    //
    // **`_files.mime`(上げた側の申告)を根拠にしない** —— 申告は上げる側が自由に決められる
    // ので、`evil.png` という名前の HTML を `Content-Type: image/png` で返す判断の材料に
    // してはならない。**バイト列だけが正である。**
    //
    // - 先頭バイトが4種の画像と判定できた → **今日どおり inline**(`Content-Type` は判定した
    //   画像 MIME + `nosniff`)。**画像4種はどれも script を実行しない。**
    // - 判定できない → **必ずダウンロード**(`application/octet-stream` +
    //   `Content-Disposition: attachment` + `nosniff`)。
    //   **HTML / SVG を同じサイトから開かせると蓄積型 XSS が成立する**ので、
    //   **ブラウザ内で開かせない。** **PDF も CSV も同じ扱いである** ——
    //   **「危ない種類だけを落とす」という選別をしない**(選別はいつか漏れる)。
    //
    // **【これは種類の制限ではない】** **上げられる種類は今日も無制限である**(7.5)。
    // 変わったのは返し方だけである。
    const sniffedForDelivery = sniffImageMime(blob);
    const headers: Record<string, string> = {
      "Content-Type": sniffedForDelivery ?? "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    };
    if (sniffedForDelivery === null) {
      headers["Content-Disposition"] = attachmentDisposition(meta.filename);
    }
    // Uint8Array を(ArrayBuffer 裏付けの新配列に写して)Blob で包み BodyInit にする
    // —— TS lib の BodyInit/BlobPart は素の `Uint8Array<ArrayBufferLike>` を受けない。
    return new Response(new Blob([new Uint8Array(blob)]), { status: 200, headers });
  });

  // 7.7 逃げ道(任意 CSS)の配信(V3-M5-T02 / D-G5。ADR-0055 限定2・6・7・13)
  //
  // **これが配信の唯一の経路である。** マニフェストに在るのは参照(資産名 + 内容ダイジェスト)
  // だけで、本体は owner 専用の content-addressed ストアにある —— この GET が両者を
  // 突き合わせ、**突き合わない場合は CSS を1バイトも出さずに loud に断る。**
  //
  // ## fail-closed かつ loud(限定6)—— loud の宛先は2つである
  //
  // 1. **サーバログ**(`console.warn` に `[escape-hatch]` 前置で、どのアプリのどの画面の
  //    どの資産が、なぜ遮断されたかを出す)。
  // 2. **応答の本文**(既存の `{ errors: [...] }` 形式。画面側がそのまま人間に見せられる)。
  //
  // **「何も出さないだけ」で済ませない**(黙って効かないのは憲法6 違反)。
  // `workflow-runner.ts` の「未発行:遮断」と同じ扱いである。
  // **ただし「参照がそもそも無い」は遮断ではない** —— それは逃げ道を使っていない普通の
  // 画面であり、loud にすると全画面でログが鳴り続けて loud の意味が消える。404 で静かに返す。
  //
  // ## 作用域の封じ込め(限定7)
  //
  // **AI は参照をどの画面にも書けるが、owner が宣言した画面にしか当たらない。** 宣言外の
  // 画面では**この配信層が拒否する**(`allowedHosts` の鏡写し。既定の全許可は無い)。
  //
  // ## 認証を要求しない(manifest と同じ扱い)
  //
  // 参照そのものは非保護の `GET /manifest` に既に載っており、本体は owner が発行した
  // **見た目の宣言**である。**レコードのデータを1バイトも含まない**ので、records / files と
  // 同じ可視範囲の規律は掛けていない。**「CSS に秘密を書いてはいけない」ことを機械で
  // 禁止する手段は無い**(限定8 により CSS を解釈しないため。V3-M5-T01 §5 の正直な申告)。
  /**
   * **集計表を1つ計算して返す**(`V8-M8`。台帳 `Q-G1` / `Q-G4` / `Q-G35`。
   * ユーザ決定 `D-V8-5` / `D-V8-122`。門A 本審査 = `V8-M7`)。
   *
   * **この入口は計算を1バイトも持たない** —— **`computeReport`(`src/kernel/report.ts`)を
   * 1回呼ぶだけである。** **束ね方も日付の丸めも並び順も、判定はカーネルの1箇所にある。**
   *
   * **応答の形**:
   * ```json
   * { "groups": [ { "keys": [{ "field": "category", "value": "A" }],
   *                 "aggregates": [{ "type": "sum", "field": "amount", "value": 1200 },
   *                                { "type": "count", "value": 3 }] } ],
   *   "total_groups": 12,
   *   "totals": [{ "type": "sum", "field": "amount", "value": 5000 },
   *              { "type": "count", "value": 40 }] }
   * ```
   *
   * **`totals` は全体の合計である**(`D-V8-122`)—— **群ごとの値の和ではない。**
   *
   * **状態を1バイトも変えない**(`Q-G35`)—— **`GET` だけを結線してあり、
   * `POST` / `PATCH` / `DELETE` は1本も登録していない**(叩くと 404 になる)。
   * **キャッシュを1つも置いていない**(`D-V8-5`)—— **要求のたびに読み直して数え直す。**
   *
   * **返す状態コード**:
   * - アプリが無ければ **404**(`loadManifest` が失敗する。middleware も先に 404 を返す)。
   * - 画面が無ければ **404**(`custom.css` の経路と同じ形・同じ文面の作り方)。
   * - 画面が集計表でなければ **400** —— **黙って空を返さない**(憲法6)。
   * - 絞り込みが読取経路で拒否されたら **400**(実在しない列・深すぎるネスト)。
   *   **既存の `compileFilter` がそのまま止める**(SQ-M4 より前は、システムテーブルだけ
   *   `applyOptions` という別の実装が止めていた)——
   *   **集計表専用のフィルタコンパイラを1本も作っていない。**
   *
   * ## **【`V8-M10-T03` / 台帳 `Q-G13` / `Q-G15`】見える行だけを数える**
   *
   * **`V8-M8` / `V8-M9` は可視性を1ミリも掛けていなかった** —— **同じ集計表を誰が開いても
   * 応答が1バイト同一で、1行も読めない人にも全行の合計が出ていた**(実測は
   * `v8-m10.md` §2-6 の「着手前は、集計表の応答が3人とも1バイト同一である」)。
   *
   * **掛け方**(`v8-m10.md` §1-0c の決定1):
   *  - **母集団を決めるのは `owner-scope.ts` の1本(`judgeRecordPopulation`)である** ——
   *    **ここに可視性の条件式を1つも書かない**(`ADR-0061` 限定4)。
   *  - **`src/kernel/report.ts` には判定を1文字も書かない** —— **`app.ts` が
   *    「可視な行だけを返す読取元」を組んで `computeReport` に渡す**(注入)。
   *    **カーネルから `owner-scope` を import する先例(`workflow-runner.ts:76`)は採らない。**
   *  - **可視性は**群化の前**に掛かる**(`Q-G21d`)—— **注入は行を読んだ直後に当たり、
   *    群を作るのはそのあとである。** **「群を作ってから絞る」形を1つも作っていない。**
   *
   * **【`T03` が掛けるのは起点の表だけである】** —— **結合先の表は今日も素通しで全件読む**
   * (`Q-G14` = `T04`)。**注入は結合先の読取でも呼ばれるが、`T03` はそのまま返している。**
   *
   * ## **【`V8-M10-T04` / 台帳 `Q-G14`】結合の向こう側にも効く(上の2行は今日は偽である)**
   *
   * **【禁止】上の `T03` の2行を書き換えない** —— **旧文は `T03` の時点の事実である。**
   * **今日の正は本節である。**
   *
   * **注入は**表ごとに**判定を引き直す** —— **起点の表と結合先の表で、面の規則も
   * 点の管轄も別々に効く。** **掛ける場所は1箇所のままである**(`report.ts` の `readRows`)。
   *
   * **見えない相手の倒し方**(`v8-m10.md` §1-0c の決定5):
   *  - **順方向(子 → 親)**: **見えない親は `null` に倒れる** —— **子の行は1行も落ちない。**
   *  - **逆方向(親 → 子)**: **見えない子は落ち、親は1行として残る** —— **件数が 0 になる。**
   *  - **どちらも `D-V8-120`(相手が無い行も 0 で並べる)と同じ向きである。**
   *
   * **【正直に書く】その結果、「相手は居るが見えない」と「相手が最初から居ない」は
   * 応答の上で区別できない**(実測は `src/server/report-join-boundary.test.ts` の (32))。
   *
   * **【一対多の重複は消えていない】** —— **可視性を掛けても、起点の行は**見える**子の数だけ
   * 数えられる**(実測は同 (33))。**【禁止】「重複しない」と書かない。**
   *
   * **返す状態コード(可視性による追加は1つも無い)**:
   * - **読める行が1行も無い人にも 200 を返す**(**合計0・件数0・群0**)——
   *   **`D-V8-128`(ユーザ決定・2026-08-15)。403 にしない。** **レコード一覧が空の一覧を
   *   200 で返しているのと振る舞いを揃える側である。**
   * - **未ログインは今日どおり 401** —— **`D-V8-127`(ユーザ決定・2026-08-15)。**
   *   **一覧は公開規約フィールド(`st_public`)を持つ表なら匿名に開くのに、その集計だけは
   *   開かない、という食い違いが残る。** **本マイルストーンはこの窓を開けない。**
   * - **行ごとの付与の上限に当たったら 400**(`Z-G17`)—— **黙って行を落とすと、
   *   上限に当たった状態と「本当に見えない」状態が応答の上で区別できなくなる。**
   */
  app.get("/api/apps/:app_id/views/:view_id/report", (c) => {
    const appId = c.req.param("app_id");
    const viewId = c.req.param("view_id");

    const loaded = loadManifest(appId);
    if (!loaded.ok) {
      return c.json(errorBody(loaded.errors), 404);
    }
    const manifest = loaded.value;
    const view = manifest.app.views.find((candidate) => candidate.id === viewId);
    if (view === undefined) {
      return c.json(
        errorBody([
          {
            path: "",
            message: `ビュー "${viewId}" はこのアプリのマニフェストにありません。`,
            allowed_values: manifest.app.views.map((candidate) => candidate.id),
          },
        ]),
        404,
      );
    }
    if (view.type !== "report_view") {
      return c.json(
        errorBody([
          {
            path: "/type",
            message: `画面 "${viewId}" は集計表(report_view)ではありません(${view.type})。`,
            allowed_values: manifest.app.views
              .filter((candidate) => candidate.type === "report_view")
              .map((candidate) => candidate.id),
            hint: "集計表の画面IDを指定するか、その画面に report を宣言した report_view を add_view で追加してください。",
          },
        ]),
        400,
      );
    }

    // --- 【`V8-M11-T03`】読取のたびに順序を受ける口(`D-V8-130`)---------------------
    //
    // **クエリを読むのはこの1本だけである** —— **家の作法どおり
    // `new URL(c.req.url)` の側から取る**(一覧の読取ルートが3箇所でそう書いている)。
    // **ここで読む名前は5つちょうどで、そのどれも「項目名」ではない**
    // (`Q-G22` の読取側。`v8-m11.md` §1-0c の決定8)。
    // **【禁止】ここに「見せない項目を条件に書かせない」検査を通したと書かない** ——
    // **通していない。** **通す対象になる入力(項目名)を1つも受け取らないからである。**
    // **機械的な固定は `src/server/report-declaration-boundary.test.ts` の (44)。**
    const reportQuery = new URL(c.req.url).searchParams;
    const reportQueryErrors: ValidationError[] = [];
    const querySort = decodeReportSort(
      {
        target: reportQuery.get("sort_target"),
        index: reportQuery.get("sort_index"),
        order: reportQuery.get("sort_order"),
      },
      { group_by: view.report.group_by.length, aggregates: view.report.aggregates.length },
      reportQueryErrors,
    );
    // --- 【`V8-M11-T04`】ページ送り(`Q-G21b` / `D-V8-129`)-------------------------
    //
    // **数の復元は既存の1本(`decodePageParam`)を再利用している** ——
    // **2本目のパーサを作っていない**(乙2)。**同関数の実装は1バイトも変えていない。**
    // **違うのは「書かなかったとき」だけである** —— **一覧は全件、集計表は先頭 100 群。**
    // **その差は下の `??` の1行が作っており、関数の側は今日も何も知らない。**
    const reportPageLimit =
      decodePageParam("limit", reportQuery.get("limit"), reportQueryErrors) ??
      REPORT_DEFAULT_GROUP_LIMIT;
    const reportPageOffset = decodePageParam(
      "offset",
      reportQuery.get("offset"),
      reportQueryErrors,
    );
    if (reportQueryErrors.length > 0) {
      // **`limit` の hint だけを、集計表の既定を説明する1文に差し替える**(乙2 の宿題)。
      // **`decodePageParam` の逐語「省略すると全件返します」は、集計表では嘘になる** ——
      // **省略すると先頭 100 群しか返らないからである。**
      // **関数の側を書き換えず、呼び出し側で差し替えている** —— **一覧の読取ルートの
      // 文面は着手前と1バイトも同じである**(実測は `report-limit-boundary.test.ts` の (F-7))。
      for (const queryError of reportQueryErrors) {
        if (queryError.path === "/limit") {
          queryError.hint = REPORT_LIMIT_HINT;
        }
      }
      return c.json(errorBody(reportQueryErrors), 400);
    }
    /**
     * **クエリが宣言の既定を上書きする**(`D-V8-130`)。
     *
     * **上書きは「読むときの1枚」に対してだけ効く** —— **マニフェストは1バイトも
     * 書き換わらない**(次の要求は宣言の既定に戻る)。**画面の並べ替えを押しても
     * 定義が書き換わらないのは、一覧の並べ替えと同じ作法である。**
     * **`computeReport` の引数の形も1バイトも変えていない** —— **カーネルは
     * 「宣言に書いてある順序」だけを見る。** **クエリという語をカーネルは知らない。**
     */
    const readView =
      querySort === undefined ? view : { ...view, report: { ...view.report, sort: querySort } };

    // --- 【`V8-M10-T03` / `Q-G13`】母集団を、要求している人ごとに決める --------------
    //
    // **一覧の読取ルートとまったく同じ4つを、同じ綴りで聞く** ——
    // **`recordAccessSourceTables`(点の管轄)/ `judgeRoleAccess`(面の表の規則)/
    // `roleGateBlocksWithoutGrants`(面の関門)/ `judgeRecordPopulation`(母集団)。**
    // **判定は1つもここに書いていない。** **`app.ts` は「どの表を、誰として読むか」を
    // 渡すだけである**(`ADR-0061` 限定4)。
    //
    // **【`V8-M10-T04` / `Q-G14` による引き直し。`T03` の形を消していない】**
    // **`T03` は上の4つを**起点の表について1度だけ**組み、注入の中で
    // `if (readTableId !== view.table) { return rows; }` として結合先を素通しにしていた。**
    // **今日は**表ごとに引き直す** —— **4つの答えはどれも表IDに依存するので、
    // 起点の答えを結合先に流用すると、別の表の規則で別の表の行を絞ることになる。**
    // **【逐語で残す。実コードから外した1行】**: `if (readTableId !== view.table) {`
    const reportActor = c.get("user") as AuthUser | undefined;
    const reportRoles: ActorRoles = reportActor?.roles ?? null;
    const reportSubject = reportActor?.id ?? null;
    // **【この経路では常に偽である。それでも聞く】** —— **未ログインは middleware が 401 で
    // 止める**(`D-V8-127`)。**「常に偽だから書かない」にすると、窓を開けた日に
    // 分岐1 だけが素通りする。** **一覧と同じ形にしておく。**
    const reportAnonymousPublic = c.get("anonymousPublic") === true;
    // --- 【`V8-M13-T02` / `Q-G28`】注入と上限の判定は `readVisibleReport` の中にある ----
    //
    // **【切り出した。中身を1行も変えていない】** **着手前、ここには注入(`visibleRows`)を
    // 組む 100行あまりと、上限の判定4本がインラインで書かれていた。**
    // **`Q-G28`(MCP から集計を読む)の限定5 が「可視性の判定を必ず通す」と定めており、
    // MCP から `computeReport()` を直接呼ぶとその注入を1ミリも通らない。**
    // **そこで本ファイルの `readVisibleReport()`(モジュール直下)へ出し、
    // **HTTP と MCP が同じ1本を呼ぶ**形にした。** **応答は1バイトも変わっていない。**
    //
    // **【ここに残したもの】** **クエリの復元(上の `decodeReportSort` /
    // `decodePageParam`)と、下のページの切り出し(`slicePage`)だけである** ——
    // **どちらも HTTP にしか存在しない入力であり、MCP はクエリを1つも受けない。**
    //
    // **【逐語で残す。実コードからここへ移した4行】**:
    //   `const reportActor = c.get("user") as AuthUser | undefined;` は今日もここに在る。
    //   `let reportLimit: "depth" | "rows" | undefined;` /
    //   `let reportScanLimit: ReportLimitKind | undefined;` /
    //   `const result = withReadSource(dataRoot, manifest.app.id, (source) => {` は
    //   `readVisibleReport()` の中へ移った。
    const result = readVisibleReport({
      dataRoot,
      manifest,
      // **【`V8-M11-T03`】読むのは「クエリを当てた1枚」である**(`D-V8-130`)——
      // **クエリを書かなければ `view` そのものが渡る**(着手前と1バイトも同じ値)。
      view: readView,
      roles: reportRoles,
      subject: reportSubject,
      anonymousPublic: reportAnonymousPublic,
    });
    // **【4つの失敗はすべて 400 である。着手前と同じ順序で返る】** ——
    // **(1) 引き継ぎの上限 / (2) 集計表の上限 / (3) 計算の失敗 / (4) 群の数の上限。**
    // **どれが先かを決めているのは `readVisibleReport()` の中の並びであり、
    // 着手前のこのハンドラの並びをそのまま移したものである。**
    if (!result.ok) {
      return c.json(errorBody(result.errors), 400);
    }
    /*
     * **【`V8-M11-T04`】ページを切る**(`Q-G21b` / `D-V8-129`)。
     *
     * **切るのは `groups` だけである** —— **`total_groups` も `totals` も
     * **切る前の全体**のままである**(§1-0c の決定6。`D-V8-129` の説明文の逐語
     * 「画面の上に出る全体の合計は、100件分ではなく全部を数えた値を出します」)。
     *
     * **【上限より後ろに置いてある】** **上の群の上限はページ送りでは回避できない**
     * (決定5)—— **上限は「作った群の数」の上限であって「返す群の数」の上限ではない。**
     * **【禁止】「ページ送りを付ければ重い集計表も開ける」と書かない。**
     *
     * **応答に `limit` / `offset` を1バイトもエコーしていない** —— **応答のキーは
     * 着手前と同じ3つちょうどである**(`report-declaration-boundary.test.ts` の (24) が
     * `toEqual` で完全一致を固定しており、エコーするとその検査が赤くなる)。
     * **切り出しは既存の `slicePage` 1本で、実装を1バイトも変えていない。**
     */
    return c.json({
      ...result.value,
      groups: slicePage(result.value.groups, reportPageLimit, reportPageOffset),
    });
  });

  app.get("/api/apps/:app_id/views/:view_id/custom.css", (c) => {
    const appId = c.req.param("app_id");
    const viewId = c.req.param("view_id");

    const loaded = loadManifest(appId);
    if (!loaded.ok) {
      return c.json(errorBody(loaded.errors), 404);
    }
    const manifest = loaded.value;
    const view = manifest.app.views.find((candidate) => candidate.id === viewId);
    if (view === undefined) {
      return c.json(
        errorBody([
          {
            path: "",
            message: `ビュー "${viewId}" はこのアプリのマニフェストにありません。`,
            allowed_values: manifest.app.views.map((candidate) => candidate.id),
          },
        ]),
        404,
      );
    }

    const reference = view.custom_css;
    if (reference === undefined) {
      // **遮断ではない。** この画面は逃げ道を使っていないだけである(loud にしない)。
      return c.json(
        errorBody([
          {
            path: "",
            message: `画面 "${viewId}" には逃げ道(任意 CSS)の参照がありません。`,
            hint: "当てたい場合は、owner が資産を発行してから、その資産名とダイジェストを画面の custom_css に書いてください。",
          },
        ]),
        404,
      );
    }

    /** 遮断を loud に伝える(宛先2つ: サーバログ + 応答本文)。 */
    const blocked = (status: 403 | 409, message: string, hint: string): Response => {
      console.warn(
        `[escape-hatch] 遮断: app="${appId}" view="${viewId}" asset="${reference.asset}" digest=${reference.digest} — ${message}`,
      );
      return c.json(errorBody([{ path: "/custom_css", message, hint }]), status);
    };

    const hatch = EscapeHatchStore.openForKernel(dataRoot);
    let asset: EscapeHatchAsset | undefined;
    try {
      asset = hatch.findEscapeHatchAsset(appId, reference.asset, reference.digest);
    } finally {
      hatch.close();
    }
    if (asset === undefined) {
      // 未発行(一度も発行されていない / 別の版を指している / owner が失効させた)。
      // **3つを区別して返さない** —— 区別すると「どのダイジェストが実在するか」を
      // 未認証の窓から探れる。人間への説明は hint で足りる。
      return blocked(
        409,
        `逃げ道の資産 "${reference.asset}"(この内容の版)は発行されていません。`,
        "owner がこの内容の資産を発行するか、画面の custom_css を発行済みの版のダイジェストに書き換えてください。失効させた資産を undo で呼び戻すことはできません(参照は戻りますが実体の登録は戻りません)。",
      );
    }
    if (!asset.scopeViews.includes(viewId)) {
      return blocked(
        403,
        `逃げ道の資産 "${reference.asset}" の作用域に画面 "${viewId}" が含まれていません。`,
        `この資産を当ててよい画面は ${asset.scopeViews.join(" / ")} です。ほかの画面にも当てるなら、owner が作用域を宣言し直して発行してください。`,
      );
    }

    const body = getEscapeHatchBody(dataRoot, appId, reference.digest);
    if (body === null) {
      // 登録は在るのに実体が無い(ディスクの破損など)。**中途半端に出さない。**
      return blocked(
        409,
        `逃げ道の資産 "${reference.asset}" の実体が見つかりません。`,
        "owner が同じ内容を発行し直すと復旧します(内容が同じなら同じダイジェストになります)。",
      );
    }
    return new Response(new Blob([new Uint8Array(body)]), {
      status: 200,
      headers: {
        "Content-Type": "text/css; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  // --- 編集系(`V5-M3-T01` で `src/server/change-routes.ts` へ移設)-----------------
  //
  // **`POST /diffs` / `POST /undo` / `GET /undo/preview` / `GET /changelog` /
  // `GET /requirements` の5本と、`POST /diffs` / `POST /undo` に掛かる `changeAuthMiddleware`
  // の2本は、`registerChangeRoutes` が登録する。** **本ファイルには1本も残っていない**
  // (検査: `src/server/runner-profile.test.ts` の (a))。
  //
  // **`profile === "runner"` のときは呼ばない** —— **そのとき編集系は1本も登録されない。**
  // **【これは「編集できない」ではない】** **環境変数 `ST_SERVER_PROFILE` を外せば、
  // 同じ実行ファイルが5本を登録する。** **書けるのは「この起動の形では登録されない」
  // までである**(`01` §8-1 の禁止1)。
  if (profile === "full") {
    registerChangeRoutes(app, {
      dataRoot,
      ensureApp,
      changeAuthMiddleware,
      readJsonBody,
      // =====================================================================================
      // **【`V8-M30`。台帳 `T-G29` = 限定採用。ユーザ決定 `D-V8-47`】締め出しの防止の2本目**
      // =====================================================================================
      //
      // **数えるのは「`role` + `write` を許された役割を実効ロール集合に持つ人」である** ——
      // **`'owner'` という綴りは1文字も見ない。** **1本目(`src/auth/store.ts` の
      // `countOwners`。SQL に `'owner'` を焼き込んでいる)は1バイトも触っていない。**
      //
      // **【判定の家は1本である】**(`ADR-0305` 限定3)—— **`judgeRoleAccess`
      // (`target: "role"` / `verb: "write"`)を呼ぶだけであり、規則を読む条件式を1行も
      // 書いていない。** **`src/server/owner-scope.ts` を1バイトも触っていない。**
      //
      // **【止めるのは「0人にする差分」だけである。誇張しない】**
      //  1. **`set_roles` を含まない差分は1件も見ない**(表・画面・ワークフローの差分は素通り)。
      //  2. **既に0人のアプリでは1件も止めない** —— **止めると回復そのものが通らなくなる。**
      //  3. **`POST /undo` には掛けていない**(`D-V8-51`)。
      //  4. **MCP(`src/mcp/tools/write.ts`)はカーネルを直接叩くので、ここを1度も通らない。**
      rejectGrantLockout: (appId, diff) => {
        const operations = (diff as { operations?: unknown } | null | undefined)?.operations;
        if (!Array.isArray(operations)) {
          return null;
        }
        // **`set_roles` は全体差し替えである。** **同じ差分に2本並べば、後に書いたほうが残る。**
        let nextRoles: unknown;
        let found = false;
        for (const operation of operations) {
          const op = (operation as { op?: unknown } | null | undefined)?.op;
          if (op === "set_roles") {
            nextRoles = (operation as { roles?: unknown }).roles;
            found = true;
          }
        }
        if (!found) {
          return null;
        }
        let current: Manifest | undefined;
        try {
          const loaded = loadManifest(appId);
          current = loaded.ok ? loaded.value : undefined;
        } catch {
          current = undefined;
        }
        const store = AuthStore.openForApp(dataRoot, appId);
        try {
          const granters = (manifest: unknown): number =>
            store.countRoleGranters(
              (roles) =>
                judgeRoleAccess({
                  manifest,
                  roles: [...roles],
                  target: { target: "role" },
                  verb: "write",
                }).allowed,
            );
          if (granters(current) === 0) {
            // **既に0人である。** **この差分が0人にしたのではない。**
            return null;
          }
          if (granters({ app: { roles: nextRoles } }) > 0) {
            return null;
          }
          return {
            path: "/operations",
            message:
              "この差分を当てると、役割を配れる人が0人になります。役割を配れる人が0人になる操作はできません。",
            hint: '"role" + "write" の規則を持つ役割を、今その役割を持っている人から全部外すことになります。set_roles を書き直して、誰か1人が「人に役割を配れる」役割を持ち続けるようにしてください。',
          };
        } finally {
          store.close();
        }
      },
      kernel: {
        applyDiff,
        undo,
        previewUndo,
        getChangelog,
        generateRequirementsDoc,
        renderRequirementsMarkdown,
      },
    });
  }

  // 8/9. 静的ファイル配信と SPA フォールバック。
  //
  // `/api/**` は対象外(未定義の API パスは JSON の 404)。SPA フォールバックは GET のみに
  // 適用する。POST/PATCH/DELETE に index.html を返すと、フロント側で「HTML を JSON として
  // パースして失敗する」という診断しにくい壊れ方になるため。
  app.notFound(async (c) => {
    const path = new URL(c.req.url).pathname;
    const isApi = path === "/api" || path.startsWith("/api/");
    if (c.req.method === "GET" && !isApi) {
      const served = await serveStaticOrIndex(webDistDir, path);
      if (served !== null) {
        return served;
      }
    }
    return c.json(
      errorBody([
        {
          path: "",
          message: `${c.req.method} ${path} に対応するエンドポイントはありません。`,
          hint: "エンドポイント一覧は MANUAL.md の「HTTP の口」の節を参照してください。",
        },
      ]),
      404,
    );
  });

  // 想定外の例外(I/O 失敗、マニフェスト破損、カーネルが投げた例外、サーバのバグ)は
  // ここで一括して 500 にする。ボディに内部情報(スタックトレース、ファイルパス)は
  // 載せず、詳細はサーバ側のログにだけ出す。
  app.onError((error, c) => {
    // 順番待ちの上限を過ぎた書込だけを、業務の言葉の統一エラーへ翻訳する
    // (V3-M13-T15 / ADR-0069 §Decision 3)。**ここ1箇所で全部の書込ルートを覆う** ——
    // ルートごとに try/catch を書くと、ルートが増えたときに書き忘れる
    // (ADR-0066 §3a-1 が名指しした「書き忘れた経路が静かにずれる」)。
    //
    // **文面は1文字も持たない**(限定12。出所は `errors.ts` の `concurrentWriteBusyErrors`)。
    // **ステータスは既存の 409 を使う**(限定7。`applyInProgressError` が「今は書けない」に
    // 使っているのと同じ意味であり、新しいステータスを1つも作らない)。
    // **`SQLITE_BUSY` 以外は今日どおり 500 である**(限定13。握り潰す方向へ動かさない)。
    const busy = concurrentWriteBusyErrors(error);
    if (busy !== null) {
      return c.json(errorBody(busy), 409);
    }
    console.error("[server] 想定外のエラー:", error);
    return c.json(errorBody([{ path: "", message: "サーバ内部エラー" }]), 500);
  });

  return app;
}

/**
 * ビルド成果物ディレクトリから静的ファイルを返す。無ければ `index.html`(SPA フォールバック)。
 * どちらも存在しなければ `null` を返し、呼び出し側が 404 にする。
 *
 * SPA フォールバックがあるので、フロントが History API で作った深い URL
 * (`/apps/<app_id>/views/<view_id>`)を直接開いてもリロードしても `index.html` が返り、
 * 同じ画面に戻る(V0-P3-T03 / T07)。
 */
async function serveStaticOrIndex(distDir: string, urlPath: string): Promise<Response | null> {
  const direct = safeJoin(distDir, urlPath);
  if (direct !== null) {
    const file = Bun.file(direct);
    if (await file.exists()) {
      return new Response(file);
    }
  }
  const indexHtml = Bun.file(join(distDir, "index.html"));
  if (await indexHtml.exists()) {
    return new Response(indexHtml);
  }
  return null;
}

/** ディレクトリの外に出る URL パス(`..` を含むもの等)を弾いて結合する。 */
function safeJoin(distDir: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) {
    return null;
  }
  const root = resolve(distDir);
  const candidate = resolve(root, `.${normalize(decoded)}`);
  return candidate === root || candidate.startsWith(root + sep) ? candidate : null;
}
