/**
 * 受信 HTTP ルート `POST /inbound/:endpoint_id`(V2-M5-T02 / ADR-0041 §1・§3)。
 *
 * **アプリの通常データ経路とは別の入口である。**ロール認証(cookie/session)ではなく
 * **署名で認証する** —— 人間 owner が発行した inbound capability(`InboundStore`)の下で、
 * 正しい署名の Webhook が来たときだけ、書込先テーブル1つへ**1行 create** する。公開 GET ビュー
 * (EC-G1)は匿名の読み取りだが、こちらは署名付きの**書込**である(ADR-0041 §1 の対称表)。
 *
 * 処理順序(ADR-0041 §1 入口。この順を厳守する):
 *  1. **rate-limit**(D-G4c。署名検証**前**。署名前のリクエストは誰でも投げられるので DoS 面を絞る)
 *  2. endpoint_id で `InboundStore` から endpoint を引く(無ければ 404・書込しない)
 *  3. 鍵を **use-time 解決**(`resolveSecret`)→ **署名検証**(`verifyInboundSignature`。
 *     **書込直前・実行層**)。不一致・鍵未解決なら**1バイトも書かず** 401 で遮断・記録する
 *     (鍵値をエラー・ログ・レスポンスに出さない)
 *  4. 署名 OK → endpoint の **target_table 1つ**へ **1行だけ create**(既存 `createRecord` 経路を
 *     再利用)。payload マッピングは `$record` と同形(演算/条件/連結なし。ADR-0041 限定3)
 *  5. 書込先テーブルのフィールド制約(型/required/reference/unique)で検証し、通らなければ書かず記録
 *     (`createRecord` の関門をそのまま通す。ai_transform の出力検証と同じ思想)
 *  6. **event_id は target_table の unique フィールド(EC-G8/ADR-0038)で冪等** —— 重複 Webhook の
 *     2件目は create が unique 違反で弾かれ、1行のみになる(200 で冪等吸収し二重書込しない)
 *  7. 書込 actor は **system actor**(D-G4b。`system:inbound`)で `_auth_activity` に記録・スタンプ
 *     する(外部由来の書込に対話する人間 actor はいない。ADR-0041 §限界3)
 *
 * **1行 create 限定を構造で守る**(ADR-0041 限定3・C):このルートは `createRecord` 1回しか
 * 呼ばない —— update/delete/複数行/スキーマ変更を受信経路から起こす分岐が存在しない。対応注文の
 * paid/failed 更新は受信テーブル on_create の条件分岐(EC-G5)+ target 語彙(EC-G13/ADR-0040)の
 * ワークフローに分離してある(受信は create に閉じる。ADR-0041 §1c)。
 *
 * **localhost 固定**(127.0.0.1。ADR-0014 維持)は起動側(`src/server/index.ts` の Bun.serve の
 * hostname)が担保する。受信口も外部公開しない(03 §6a)。
 */
import { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { ensureAuthActivitySchema, recordActivity } from "../auth/store.ts";
import { InboundStore } from "../kernel/inbound-store.ts";
import { verifyInboundSignature } from "../kernel/inbound-verify.ts";
import {
  appDbPath,
  CONCURRENT_WRITE_WAIT_PRAGMA,
  concurrentWriteBusyErrors,
  createRecord,
  listRecords,
  type Manifest,
  type RecordInput,
  type RecordResult,
  type RecordRow,
  type ResourceId,
  readCurrentManifest,
  type Table,
  type ValidationError,
} from "../kernel/index.ts";
import { resolveSecret } from "../kernel/secret-resolver.ts";
import type { AuthEnv } from "./auth-context.ts";
import {
  combineRoleAndCreatorGrant,
  creatorGrantPlan,
  judgeOwnerScopedOp,
  judgeRoleAccess,
  recordAccessSourceTables,
  stripInboundReservedFields,
} from "./owner-scope.ts";
import {
  clientKeyFromHeader,
  RateLimiter,
  type RateLimitOptions,
  rateLimitError,
} from "./rate-limit.ts";

/** 受信口の rate-limit 既定(D-G4c)。署名前の DoS 面を絞る最低限。外部公開時は前段が要る。 */
const DEFAULT_INBOUND_RATE_LIMIT: RateLimitOptions = { limit: 120, windowMs: 60_000 };

/**
 * 外部由来の受信書込の **system actor**(D-G4b / ADR-0041 限定9)。受信起因の行は固定 actor
 * `system:inbound` で `_auth_activity` に記録・スタンプし、監査で外部起因を識別可能にする。
 * (「誰が承認したか」に対応する人間はいない —— system actor はそれを正直に表す。ADR-0041 §限界3。)
 */
const SYSTEM_INBOUND_ACTOR = { userId: "system:inbound", username: "system:inbound" } as const;

/**
 * **面(役割に束ねた権限)から見たときの受信の主体**(ユーザ決定 `D-V8-67`。2026-08-10)。
 *
 * **受信口は持ち主が承認して作ったものなので、届いた通知は持ち主の権限で書き込む。**
 * **`SYSTEM_INBOUND_ACTOR` は1バイトも変えていない** —— **監査(`_auth_activity`)にも
 * `st_owner` にも今日どおり `system:inbound` が入る。** **変えたのは面の判定に渡す役割だけ。**
 *
 * **【説明文が自ら述べた代償。逐語】**
 * > **ただし受信口を一つ作ると、そこに届いたものは持ち主の広さで書けることになります
 * > (受信口ごとに絞れません)。**
 */
const INBOUND_FACE_ROLES = ["owner"] as const;

export type InboundRouteDeps = {
  /** データルート(`kernel.sqlite` と `apps/<app_id>/` がこの下にある)。 */
  dataRoot: string;
  /** 受信口の rate-limit 設定(省略時は `DEFAULT_INBOUND_RATE_LIMIT`)。テストは小窓 + 注入 now を渡す。 */
  rateLimit?: RateLimitOptions | undefined;
};

/** このルート内のエラー body(app.ts と同じ `{ errors: [...] }` 形。SQL も文面もカーネル/ここに閉じる)。 */
function errorBody(errors: ValidationError[]): { errors: ValidationError[] } {
  return { errors };
}

/** endpoint 不在(404)。書込しない。 */
function unknownEndpointError(endpointId: string): ValidationError {
  return {
    path: "",
    message: `受信口 "${endpointId}" は存在しません。`,
    hint: "owner が発行した inbound endpoint の ID を指定してください(受信口の発行は人間 owner のみ)。",
  };
}

/**
 * 署名検証で遮断(401)。**鍵値を絶対に含めない**(不一致・鍵未解決を1つの文面に集約し、
 * どちらであっても鍵・署名の内部を漏らさない。secret-resolver.ts の規律と同型)。
 */
function signatureRejectedError(headerName: string): ValidationError {
  return {
    path: "",
    message: "署名検証に失敗しました。受信を遮断しました(1バイトも書き込んでいません)。",
    // **ヘッダ名は受信口ごとの宣言から取る**(`V5-M15` / `G-G9` / `ADR-0160`)——
    // グローバル定数を直書きしていた頃は、宣言と食い違う名前を案内していた。
    // **鍵・署名の内部は今日も1バイトも出さない**(名前だけである)。
    hint: `正しい署名検証鍵で計算した署名を ${headerName} ヘッダに付けてください(鍵は owner が登録します)。`,
  };
}

/** payload が JSON オブジェクトでない(400)。書込しない。 */
function malformedPayloadError(): ValidationError {
  return {
    path: "",
    message: "受信 payload は JSON オブジェクトである必要があります。",
    hint: 'Webhook の body を { "event_id": ..., ... } の形の JSON オブジェクトで送ってください。',
  };
}

/**
 * 受信 1行 create を **system actor の監査 INSERT と同一トランザクション**で行う
 * (`src/server/app.ts` の `writeWithAudit` と同型。ただし actor は固定の system actor)。
 * カーネル書込が例外なら監査も残らず巻き戻り、`ok:false`(検証不合格・DB 未書込)なら監査しない。
 *
 * SQL は書かない —— スキーマ保証 `ensureAuthActivitySchema` と INSERT `recordActivity` は
 * `src/auth/store.ts` に閉じ、create は `createRecord`(カーネル関門)に閉じる(ADR-0003 §7)。
 */
function createInboundRow(
  db: Database,
  manifest: Manifest,
  tableId: string,
  input: RecordInput,
): RecordResult<RecordRow> {
  ensureAuthActivitySchema(db);
  const tx = db.transaction((): RecordResult<RecordRow> => {
    const result = createRecord(db, manifest, tableId, input);
    if (!result.ok) {
      return result;
    }
    recordActivity(db, {
      userId: SYSTEM_INBOUND_ACTOR.userId,
      username: SYSTEM_INBOUND_ACTOR.username,
      action: "create_record",
      tableId,
      recordId: result.value._id,
    });
    return result;
  });
  // **BEGIN IMMEDIATE**(V3-M13-T15 / ADR-0069 §Decision 1)。`src/server/app.ts` の
  // `writeWithAudit` と同じ理由である —— deferred のままだと検証の SELECT が SHARED を取り、
  // 続く INSERT の昇格で **`busy_timeout` を無視した即 `SQLITE_BUSY`** になる
  // (ADR-0018 (2) のロック昇格デッドロック)。**入口ごとに振る舞いが割れないよう、
  // HTTP 単件と同じ形に揃える**(ADR-0003 §7)。**器の本数は増えていない**(ADR-0066 限定1
  // の凍結検査は綴りを grep で数えるので、このコメントはその綴りを1度も書かない)。
  return tx.immediate();
}

/**
 * **受信の主体が、その表に行を作ってよいか**(`V8-M21`。台帳 `J-G21` の限定採用)。
 *
 * **限定の逐語**: 「`src/server/inbound-route.ts` の作成直前1箇所。判定の家は
 * `src/server/owner-scope.ts` の既存1本。**主体は受信口が今日持っている1つに固定し、
 * その主体がメンバー表に行を持つときだけ通す**」。
 *
 * **通れば `undefined`、止めれば 403 の本文にする1件。**
 *
 * - **行ごとのアクセス権を宣言していない表では1度も止めない**(オプトイン。今日どおり)。
 * - **主体は `SYSTEM_INBOUND_ACTOR` の1つに固定である** —— **payload の名乗りは今日どおり
 *   1文字も採らない**(`ADR-0016` §却下(iv))。**新しい主体を1つも作っていない。**
 * - **判定は既存の述語 `creatorGrantPlan` の `no_member` の枝である** ——
 *   **「作った本人に何が渡るか」を答える述語がそのまま「メンバー表に行を持つか」を答える。**
 *   **新しい判定式をこのファイルに1つも書いていない**(`ADR-0061` 限定4 の作法)。
 *
 * **【先に認めること。隠さない】** **これは fail-closed である** ——
 * **アクセス権を宣言した表を書込先にしている受信口は、`system:inbound` のメンバー行を
 * 作るまで今日から 403 で止まる。**
 *
 * ## **【`V8-M21` の後半で、面(役割に束ねた権限)も掛かるようになった。旧文を残す】**
 *
 * **旧の doc(逐語。前半の担当が書いたもの)**:
 * > **【面(役割に束ねた権限)は掛けていない】** —— **`system:inbound` は認証アカウントでは
 * > なく、実効ロール集合を持たない。** **限定が要求しているのはメンバー表の1点だけである。**
 *
 * **今日は面も点も掛かり、`OR` で重なる**({@link combineRoleAndCreatorGrant})——
 * **`V8-M19` がブラウザの経路に入れたのと同じ合成であり、入口ごとに振る舞いが割れない**
 * (`ADR-0003` §7)。**合成の規則を1つも書いていない**(`owner-scope.ts` の既存1本)。
 *
 * **【受信の主体は役割を1つも持たない。これが何を意味するか。丸めない】** ——
 * **`system:inbound` は認証アカウントではないので、実効ロール集合は空である。**
 * **面の判定はこれを予約語の主体(未ログイン)として評価する** —— **その主体に書込を
 * 許す規則は今日書けない**(未ログインの主体に書けるのは読取だけである)。
 * **したがって、面が「役割 × 表 × 書込」を宣言している表を書込先にした受信口は、
 * 面の側からは決して通らない。** **通す道は点の側(参加者の表に
 * `system:inbound` の行を作る)だけである。**
 *
 * =====================================================================================
 * **【`D-V8-67`(2026-08-10)。上の節は今日は偽である。旧文を1バイトも消していない】**
 * =====================================================================================
 *
 * **ユーザ決定 `D-V8-67` の見出しの逐語: 「受信口は「持ち主が書いている」として扱う」。**
 * **選ばれた説明文の逐語(**代償まで含めて写す。これが決定の一部である**)**:
 *
 * > **受信口は持ち主が承認して作ったものなので、届いた通知は持ち主の権限で書き込みます。
 * > 新しい言葉を覚える必要がなく、自動で入る持ち主の行でそのまま通ります。ただし受信口を
 * > 一つ作ると、そこに届いたものは持ち主の広さで書けることになります(受信口ごとに絞れません)。**
 *
 * ## 何を変えたか(**2点だけである**)
 *
 *  1. **面へ渡す実効ロール集合を `null`(未ログイン = `anonymous`)から
 *     `[OWNER_ROLE]`(持ち主)へ変えた。** **`anonymous` の `can` はスキーマが `["read"]` に
 *     閉じているので、面から受信を通す道が1本も無かった** —— **正しい署名の Webhook が
 *     403 になり、`payment_events` が0行になり、決済が完了しなかった**(実測)。
 *  2. **`!role.governed` を「素通りの合図」に使っていた早期 return を外した。** ——
 *     **`V8-M26-T03` が既定を閉じたので `governed` は常に真であり、この分岐は死んでいた。**
 *     **代わりに「持ち主として判定する」1本に置き換えた。**
 *
 * ## 【この決定が塞がないもの。説明文が自ら述べた代償を、実装のここにも書く】
 *
 * **「ただし受信口を一つ作ると、そこに届いたものは持ち主の広さで書けることになります
 * (受信口ごとに絞れません)。」** —— **受信口の粒度で権限を絞る語彙は今日1つも無い。**
 * **同じアプリに受信口が何本在っても、どれも同じ「持ち主の広さ」で書く。**
 *
 * ## 【素通りにしていない。ここが射程の端である】
 *
 * **持ち主に規則が無い表へは、今日も1行も書けない** —— **`role_inbox` のように
 * 別の役割(`editor`)だけが名指ししている表は 403 のままである。**
 * **実測は `src/server/inbound-access-control.test.ts` の (G-1) / (G-2)。**
 *
 * **主体そのものは1つも増えていない** —— **`_auth_activity` に残るのも `st_owner` に
 * 入るのも今日どおり `system:inbound` である。** **変えたのは「面がこの主体をどの役割として
 * 見るか」だけであり、`SYSTEM_INBOUND_ACTOR` は1バイトも動かしていない。**
 */
function inboundAccessDenied(
  db: Database,
  manifest: Manifest,
  tableId: ResourceId,
): ValidationError | undefined {
  const sources = recordAccessSourceTables(manifest, tableId);
  const role = judgeRoleAccess({
    manifest,
    // **【`D-V8-67`】旧: `roles: null,`**(= **未ログイン。面から通す道が1本も無かった**)。
    // **今日: 受信口は「持ち主が書いている」として面の判定を受ける。**
    roles: INBOUND_FACE_ROLES,
    target: { target: "table", table: tableId },
    verb: "write",
  });
  // **【`D-V8-67`】旧: `if (sources === undefined && !role.governed) { return undefined; }`**
  // (= **面も点も管轄外の表は素通り**)。**`V8-M26-T03` が既定を閉じてから `governed` は
  // 常に真であり、この早期 return は1度も成立しなくなっていた**(死んだ合図)。
  // **消したのであって、素通りを別の形で残したのではない** —— **判定は必ず下まで進む。**
  const memberRows =
    sources?.memberTable === undefined
      ? []
      : (() => {
          // **読めなければ空 = fail-closed**(黙って通さない)。
          const rows = listRecords(db, manifest, sources.memberTable, {});
          return rows.ok ? (rows.value as unknown as Record<string, unknown>[]) : [];
        })();
  const combined = combineRoleAndCreatorGrant({
    role,
    plan:
      sources === undefined
        ? undefined
        : creatorGrantPlan({
            manifest,
            tableId,
            actorId: SYSTEM_INBOUND_ACTOR.userId,
            memberRows,
          }),
  });
  if (combined.allowed) {
    return undefined;
  }
  return {
    path: "",
    message:
      `この受信口の書込先はアクセス権で守られていますが、受信の主体("${SYSTEM_INBOUND_ACTOR.userId}")には` +
      `書き込む権限がありません(止めた層: ${combined.blockedBy.join(" / ")})。` +
      "受信を遮断しました(1バイトも書き込んでいません)。",
    // **【`D-V8-67` で末尾の1文を差し替えた。旧の逐語をここに残す】** ——
    // **旧: 「役割の規則(面)の側からは通せません —— 受信の主体は役割を1つも持たないためです。」**
    // **今日、受信の主体は持ち主(`owner`)として面の判定を受けるので、この案内は嘘になった。**
    hint:
      `参加者の表に "${SYSTEM_INBOUND_ACTOR.userId}" の行を1件作ると、この受信口は今までどおり書き込めます` +
      "(受信で入った行を人が読むには、その行への権限を配る必要があります)。" +
      "役割の規則(面)の側からも通せます —— 持ち主(owner)にこの表への書き込みを許す規則を1本書いてください" +
      "(この受信口だけを絞ることはできません。持ち主に許した広さがそのまま効きます)。",
  };
}

/**
 * create が失敗したとき、それが「event_id 等の unique 制約の重複(= 冪等吸収すべき重複 Webhook)」
 * だけなのかを判定する(ADR-0041 限定8)。**すべてのエラーが unique フィールドのパスに載っている**
 * ときだけ true —— 型・required・不明フィールド等の**別の**制約違反(限定5 / 条件 e)が混じっていれば
 * false にし、それらは書かず 400 で正直に返す。
 */
function isIdempotentDuplicate(errors: ValidationError[], uniqueFieldIds: Set<string>): boolean {
  if (errors.length === 0) {
    return false;
  }
  return errors.every((e) => {
    const fieldId = e.path.startsWith("/") ? e.path.slice(1) : e.path;
    return uniqueFieldIds.has(fieldId);
  });
}

/**
 * 受信 HTTP ルート `POST /inbound/:endpoint_id` を登録する(`registerAuthRoutes` と同型)。
 * middleware は `/api/*` にしか張っていないので、この `/inbound/*` は認証境界を通らない
 * (署名で認証する = ロール認証を通さないのが設計。ADR-0041 §1)。
 */
export function registerInboundRoute(app: Hono<AuthEnv>, deps: InboundRouteDeps): void {
  const { dataRoot } = deps;
  // 受信口の rate-limit(D-G4c)。**インスタンスごとに独立**(グローバル状態を持たない)。
  const inboundLimiter = new RateLimiter(deps.rateLimit ?? DEFAULT_INBOUND_RATE_LIMIT);

  app.post("/inbound/:endpoint_id", async (c) => {
    // 1. rate-limit(署名検証**前**。署名前のリクエストは誰でも投げられる。D-G4c)。
    const decision = inboundLimiter.hit(clientKeyFromHeader(c.req.header("x-forwarded-for")));
    if (!decision.allowed) {
      c.header("Retry-After", String(decision.retryAfterSec));
      return c.json(errorBody([rateLimitError(decision.retryAfterSec)]), 429);
    }

    const endpointId = c.req.param("endpoint_id");

    // 2. endpoint を引く(無ければ 404・書込しない)。人間専用ストア(kernel.sqlite)を都度開閉する。
    const store = InboundStore.openForKernel(dataRoot);
    let endpoint: ReturnType<InboundStore["getInboundEndpoint"]>;
    try {
      endpoint = store.getInboundEndpoint(endpointId);
    } finally {
      store.close();
    }
    if (endpoint === undefined) {
      return c.json(errorBody([unknownEndpointError(endpointId)]), 404);
    }

    // **生バイト body を読む**(パース前。HMAC は生バイトで計算しないと一致しない。03 §3a)。
    const rawBody = new Uint8Array(await c.req.arrayBuffer());

    // 3. 鍵を use-time 解決 → 署名検証(**書込直前・実行層**)。不一致/鍵未解決は 401 で遮断し
    //    **アプリ内テーブルへ1バイトも書かない**(ADR-0041 限定2。鍵値は一切出さない)。
    //
    // **どのヘッダを読み、値をどう解釈するかは受信口ごとの宣言による**(`V5-M15` /
    // `G-G9` / `G-G10` / `ADR-0160` 限定2 / 限定4)。**宣言が無い受信口は今日どおり**
    // (`X-Mock-PSP-Signature` / `sha256=<hex>`。限定8 —— 既定はストアが入れる)。
    // **止まる場所は1ミリも動いていない** —— 鍵の use-time 解決の直後・`createRecord` の
    // 手前であり、遮断は 401 で**アプリ内テーブルへ1バイトも書かない**(限定9)。
    let secret: string;
    try {
      secret = await resolveSecret(endpoint.secretSource);
    } catch {
      // 鍵未登録/解決失敗。SecretResolutionError は鍵値を含めない設計だが、ここでも中身を出さない。
      return c.json(errorBody([signatureRejectedError(endpoint.signatureHeader)]), 401);
    }
    const signatureHeader = c.req.header(endpoint.signatureHeader);
    if (
      !verifyInboundSignature(rawBody, signatureHeader ?? null, secret, endpoint.signatureFormat)
    ) {
      return c.json(errorBody([signatureRejectedError(endpoint.signatureHeader)]), 401);
    }

    // 4. 署名 OK。ここではじめて payload をパースする(検証を通ってから中身を見る)。
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      return c.json(errorBody([malformedPayloadError()]), 400);
    }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return c.json(errorBody([malformedPayloadError()]), 400);
    }

    // 5. endpoint の target_table 1つへ 1行 create(既存 create_record 経路を再利用)。
    const manifest = readCurrentManifest(dataRoot, endpoint.appId);
    const targetTable: Table | undefined = manifest.app.tables.find(
      (t) => t.id === endpoint.targetTable,
    );
    const uniqueFieldIds = new Set(
      (targetTable?.fields ?? []).filter((f) => f.unique === true).map((f) => f.id),
    );

    // **個人所有スコープ(`ADR-0016`)を受信経路にも当てる**(`V4-FIX1` 項目(4))。
    //
    // **直す前の実測**(`docs/evidence/cp-v4.md` §9 の 7):
    // `grep -c "OWNER_FIELD\|st_owner" src/server/inbound-route.ts` = **0** ——
    // **Webhook の body がそのままレコードの入力になり、スタンプも検証も1行も無かった。**
    // **署名鍵を持つ送り手は「この行は誰のものか」を自分で名乗れ、任意の利用者の個人一覧へ
    // 行を差し込めた**(`ADR-0016` §却下(iv)「クライアント送信を信用する経路は最初から作らない」)。
    // **持ち主を書かなければ空のまま入り、共有センチネル扱いで全員に見えていた**(実測)。
    //
    // **判定は `owner-scope.ts` の `judgeOwnerScopedOp` 1本**(単件 POST / バッチ create と
    // **同じ関数・同じ向き**。新しい述語を1本も作らない。`ADR-0033` §Consequences)。
    // **actor は既存の system actor**(`SYSTEM_INBOUND_ACTOR` / `D-G4b` / `ADR-0041` 限定9)で
    // あり、**新しい actor を1つも作っていない。** **語彙は1つも増えていない**
    // (`schemas/` と `src/kernel/` に0バイト。予約規約フィールドの本数も不変)。
    //
    // **個人所有テーブルでなければ `skip` を返して1バイトも変えない**(既定は今日どおり)。
    //
    // **【塞いでいないもの。誇張しない】** **予約規約フィールドは今日 5本ある**(名前の全量は
    // `src/server/owner-scope.ts` にある —— **ここに綴りを書かない。** `ADR-0061` 限定4 の走査が
    // 「宣言の名前が `owner-scope.ts` 以外の非テスト製品コードに現れない」ことを固定している)。
    // **この経路で止まっているのはそのうち2本(所有者と公開指定)だけで、残り3本は今日も
    // payload から書ける**(`src/server/inbound-owner-scope.test.ts` の (Z) が固定している)。
    // **「予約規約フィールドは塞がれた」と書いてはならない**(`D-V4-114`)。
    //
    // **【この箇所の記述の訂正。V4-M27】** ここには `V4-FIX1` の時点の逐語で
    // 「**`st_owner` 以外の予約規約フィールドは今日も payload から書ける**(他の3本)」と
    // 書いてあった。**4本目・5本目が足された時点で本数は 5本になっており、「他の3本」は
    // 当時から今日までのどこかで古くなっていた**(`ADR-0073` / `ADR-0077`)。
    // **同じ差分で今日の正に直した。**
    judgeOwnerScopedOp({
      table: targetTable,
      op: { op: "create", table: endpoint.targetTable, values: payload },
      actorId: SYSTEM_INBOUND_ACTOR.userId,
      // create op では読まれない(`judgeOwnerScopedOp` は update のときだけ既存行を読む)。
      readRow: () => undefined,
    });

    // **外部の送り手が「誰でも見える」印(`st_public`)を立てられる穴を塞ぐ**
    // (`V4-M27` / `D-V4-92` / `D-V4-114`)。**判定は `owner-scope.ts` の1本**(ここに
    // 条件式を書かない。`ADR-0061` 限定4)—— **この経路は `st_public` の綴りを1文字も持たない。**
    //
    // **`st_owner` と向きが違う** —— あちらは system actor で**上書き**するが、こちらは
    // **無条件に取り除く**(対応する正しい値が無い)。**表の宣言も見ない・拒否もしない**
    // (`D-V4-114` = 「印だけ黙って捨てて、残りは受け取る」)。**その代償として、
    // `st_public` を持たない表への受信が 400 から 201 に変わる**(承知のうえ。関数の doc)。
    //
    // **語彙は1つも増えていない** —— `schemas/` と `src/kernel/` に0バイトで、予約規約
    // フィールドの本数も 5本のまま(1本も足していない)。
    //
    // **【`V4-M36` / `D-V4-125` による拡大】** **上の1本だけでなく、残る3本の予約規約
    // フィールドも同じやり方(黙って捨てる)で落とす。** 決定の逐語は「**外部からの受信口を
    // 通して『運営者でも消せない行』を作られる件を塞ぐ**」であり、**`D-V4-92`(「他の予約
    // 規約フィールドは今日のまま」)の射程を広げる**と明記されている。**落とす対象の全量は
    // `owner-scope.ts` の1本の定数にある —— ここに名前を1つも書かない**(`ADR-0061` 限定4 /
    // `ADR-0073` 限定5 / `ADR-0077` 限定6 の走査が、宣言の名前が `owner-scope.ts` 以外の
    // 非テスト製品コードに現れないことを固定している)。
    //
    // **【それでも塞いでいないもの。誇張しない】** **個人所有の表へ外部から行が入ること
    // 自体は今日も解けていない**(`D-V4-92` 逐語「解けないと書く」)—— 受信で入った行の
    // 持ち主は system actor なので、**運営者からは見えず `DELETE` は 404 である。**
    // **受信口にゴミ行を積まれる経路そのものは1ミリも塞いでいない。**
    stripInboundReservedFields(payload as Record<string, unknown>);

    const db = new Database(appDbPath(dataRoot, endpoint.appId), {
      readwrite: true,
      create: false,
    });
    // 同じアプリへの同時書込を待たせる(V3-M13-T15 / ADR-0069 §Decision 2)。
    // **値も PRAGMA 文もカーネルの定数1つに閉じている**(限定2 / 限定12)。
    db.exec(CONCURRENT_WRITE_WAIT_PRAGMA);
    let result: RecordResult<RecordRow>;
    try {
      // **【`V8-M21` / 台帳 `J-G21`】作成直前1箇所**(**`createInboundRow` の呼び出しの直前**)。
      // **署名(401)とは別の関門である** —— **署名が正しくても、主体が参加者の表に
      // 行を持たなければ 403 で止まる。**
      const denied = inboundAccessDenied(db, manifest, endpoint.targetTable);
      if (denied !== undefined) {
        return c.json(errorBody([denied]), 403);
      }
      result = createInboundRow(db, manifest, endpoint.targetTable, payload as RecordInput);
    } catch (error) {
      // 順番待ちの上限を過ぎた書込だけを業務の言葉へ翻訳する(ADR-0069 §Decision 3)。
      // ステータスは既存の 409(限定7)。**`SQLITE_BUSY` 以外は素通しする**(限定13)。
      const busy = concurrentWriteBusyErrors(error);
      if (busy === null) {
        throw error;
      }
      return c.json({ errors: busy }, 409);
    } finally {
      db.close();
    }

    if (result.ok) {
      // 1行 create 成功。actor は system:inbound で `_auth_activity` に記録済み(同一 tx)。
      return c.json({ record: result.value }, 201);
    }

    // 6. 失敗が unique 制約の重複だけなら冪等吸収(200)—— 重複 Webhook の2件目。**書込は増えない**
    //    (createRecord の unique 関門が既に弾いている。EC-G8/ADR-0038)。
    if (isIdempotentDuplicate(result.errors, uniqueFieldIds)) {
      return c.json({ idempotent: true, errors: result.errors }, 200);
    }
    // それ以外は書込先テーブルのフィールド制約違反(限定5 / 条件 e)。書かず 400 で正直に返す。
    return c.json(errorBody(result.errors), 400);
  });
}
