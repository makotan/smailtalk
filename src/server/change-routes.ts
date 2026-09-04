/**
 * **編集系 HTTP ルート**(`V5-M3-T01` / `R-G1` のサーバ側。契約は
 * `docs/plan/v5/records/v5-m0.md` §2-1 / §6-3)。
 *
 * **`src/server/app.ts` から切り出しただけである。** **ルートの本体は1行も書き換えていない**
 * —— **`registerAuthRoutes`(`auth-routes.ts`)/ `registerInboundRoute`(`inbound-route.ts`)と
 * 同じく、ルート群を別ファイルへ出し、必要なクロージャだけを受け取る形**にした。
 *
 * ## なぜ切り出すのか
 *
 * **実行専用の起動プロファイル(`createServerApp({ profile: "runner" })`)がこの5本を
 * 1本も登録しないため**である。**「登録しない」を、`if` を5箇所に書くのではなく
 * 「この関数を呼ばない」1箇所で表す。** 検査は `src/server/runner-profile.test.ts`。
 *
 * ## **この切り出しが主張しないこと(丸めない)**
 *
 * - **「編集できない」ではない。** **環境変数 `ST_SERVER_PROFILE` を外せば、同じ実行
 *   ファイルがこの5本を登録する。** **`Dockerfile` を書き換えれば配布物にも入る。**
 * - **`GET /undo/preview` / `GET /changelog` / `GET /requirements` は今日も未認証で通る。**
 *   **本ファイルはその3本に認証を1バイトも足していない**(`01` §7 の `V5-M3` 行)。
 *   **`runner` プロファイルで登録しないだけであって、塞いだのではない。**
 *
 * ## カーネル関数を引数で受け取っている理由(**設計上の最善ではない。制約への適合である**)
 *
 * **`auth-routes.ts` / `inbound-route.ts` は `src/kernel/` を直接 import している。**
 * **本ファイルだけが `applyDiff` などを `deps.kernel` で受け取るのは、直接 import すると
 * `scripts/kernel-import-snapshot.txt` の行が `src/server/app.ts:applyDiff` から
 * `src/server/change-routes.ts:applyDiff` へ**移動**し、同ファイルの更新が必要になるためである**
 * (`ADR-0009` 限定2 の受け皿。**更新には審査が要る**と当該ファイルの冒頭が定めている)。
 * **`V5-M3` の発注書はこのファイルの更新を停止条件にしている。** **層またぎの本数を1本も
 * 増やさないまま切り出すために、注入の形を採った。**
 */
import type { Hono } from "hono";
import type { MiddlewareHandler } from "hono/types";
import type {
  applyDiff as applyDiffFn,
  generateRequirementsDoc as generateRequirementsDocFn,
  getChangelog as getChangelogFn,
  previewUndo as previewUndoFn,
  RecordResult,
  RequirementSection,
  RequirementStatement,
  renderRequirementsMarkdown as renderRequirementsMarkdownFn,
  undo as undoFn,
  ValidationError,
} from "../kernel/index.ts";
import type { AuthEnv } from "./auth-context.ts";

/** ADR-0003 §3: エラーは常に `{ errors: [...] }`。1件でも配列。 */
function errorBody(errors: ValidationError[]): { errors: ValidationError[] } {
  return { errors };
}

// --- `?format=` / `?section=` のデコード(`app.ts` から移設。1行も変えていない)---------

/**
 * 要件定義書の節(ADR-0025 §7 の6つ)。**`?section=` の受理集合である。**
 *
 * カーネルは節の一覧を配列として export していない(ADR-0025 限定11 が新規 export を
 * 2群に限っており、この1クエリのために公開面を増やさない)。そこで**型の網羅性で写しを
 * 固定する** —— `Record<RequirementSection, true>` はキーの過不足をどちらもコンパイル
 * エラーにするので、カーネルの union が動けばここが必ず赤くなる。
 */
const REQUIREMENT_SECTION_KEYS: Record<RequirementSection, true> = {
  overview: true,
  features: true,
  screens: true,
  data: true,
  automation: true,
  history: true,
};

const REQUIREMENT_SECTIONS = Object.keys(REQUIREMENT_SECTION_KEYS) as RequirementSection[];

const REQUIREMENT_FORMATS = ["markdown", "json"] as const;
type RequirementFormat = (typeof REQUIREMENT_FORMATS)[number];

type RequirementsQuery = {
  format: RequirementFormat;
  section: RequirementSection | undefined;
};

/**
 * `?format=` / `?section=` をデコードする。**トランスポート層のデコードだけ**である
 * (ADR-0003 §7)—— 文書の中身に関わる判定は1つもここに無い。
 *
 * 語彙外の値は**黙って既定へ落とさず**、受理集合を添えて断る(憲法6)。黙って落とすと
 * 「section を指定したのに全節が返ってきた」ことに呼び出し側が気づけない。
 */
function parseRequirementsQuery(params: URLSearchParams): RecordResult<RequirementsQuery> {
  const errors: ValidationError[] = [];

  const rawFormat = params.get("format");
  let format: RequirementFormat = "markdown";
  if (rawFormat !== null) {
    if ((REQUIREMENT_FORMATS as readonly string[]).includes(rawFormat)) {
      format = rawFormat as RequirementFormat;
    } else {
      errors.push({
        path: "/format",
        message: `形式 "${rawFormat}" は指定できません。`,
        allowed_values: [...REQUIREMENT_FORMATS],
        hint: "省略すると markdown になります。",
      });
    }
  }

  const rawSection = params.get("section");
  let section: RequirementSection | undefined;
  if (rawSection !== null) {
    if ((REQUIREMENT_SECTIONS as readonly string[]).includes(rawSection)) {
      section = rawSection as RequirementSection;
    } else {
      errors.push({
        path: "/section",
        message: `節 "${rawSection}" は要件定義書にありません。`,
        allowed_values: [...REQUIREMENT_SECTIONS],
        hint: "省略すると全節を返します。",
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: { format, section } };
}

/** 編集系ルートが依存するもの(app スコープで用意して注入する)。 */
export type ChangeRouteDeps = {
  /** データルート(`data/` 相当)。 */
  dataRoot: string;
  /** アプリの実在確認。実在すれば null、しなければ 404 用のエラー(`app.ts` と共有)。 */
  ensureApp: (appId: string) => ValidationError | null;
  /**
   * **`POST /diffs` / `POST /undo` に掛かる owner 必須の関門**(`V4-FIX1` 項目(5))。
   * **`app.ts` が組み立てたものをそのまま受け取る** —— **判定の写しを2つ作らない。**
   */
  changeAuthMiddleware: MiddlewareHandler<AuthEnv>;
  /**
   * **締め出しの防止の2本目**(`V8-M30`。台帳 `T-G29` / ユーザ決定 `D-V8-47`)。
   *
   * **差分を当てたら「人に役割を配れる人」が0人になるかどうかを答える** ——
   * **0人になるなら 409 用のエラーを、ならないなら `null` を返す。**
   *
   * **判定そのものは `app.ts` 側が組み立てる**(`judgeRoleAccess` 1本 +
   * `AuthStore.countRoleGranters`)—— **本ファイルは規則も利用者も1バイトも読まない**
   * (冒頭の doc の「層またぎの本数を1本も増やさない」に倣う)。
   */
  rejectGrantLockout: (appId: string, diff: unknown) => ValidationError | null;
  /** ボディを JSON として読むだけの関数(`app.ts` と共有。文面を2箇所に持たない)。 */
  readJsonBody: (
    request: Request,
  ) => Promise<{ ok: true; value: unknown } | { ok: false; errors: ValidationError[] }>;
  /**
   * **カーネル関数**(冒頭の doc のとおり、直接 import せず注入で受ける)。
   * **`app.ts` が `../kernel/index.ts` から取ったものをそのまま渡す。**
   */
  kernel: {
    applyDiff: typeof applyDiffFn;
    undo: typeof undoFn;
    previewUndo: typeof previewUndoFn;
    getChangelog: typeof getChangelogFn;
    generateRequirementsDoc: typeof generateRequirementsDocFn;
    renderRequirementsMarkdown: typeof renderRequirementsMarkdownFn;
  };
};

/**
 * 編集系5ルート(+ owner 必須の関門2本)を登録する。
 *
 * **`createServerApp` の `profile` が `"full"` のときだけ呼ばれる。** `"runner"` では
 * 呼ばれないので、**この5本は1本も登録されない**(検査: `runner-profile.test.ts`)。
 */
export function registerChangeRoutes(app: Hono<AuthEnv>, deps: ChangeRouteDeps): void {
  const { dataRoot, ensureApp, changeAuthMiddleware, readJsonBody, kernel, rejectGrantLockout } =
    deps;

  // --- 変更系(V0-P4-T06 / ADR-0003 §4「Phase 4 での変更」)-------------------------
  //
  // Phase 3 では「マニフェストを変更する HTTP エンドポイントは作らない」と決めていたが、
  // Phase 4 で apply_diff / undo をブラウザ稼働中に効かせる必要が出たため、下記4本だけを
  // 追加した。いずれもカーネル関数1本への薄い委譲であり、additive 判定・スナップショット・
  // changelog 記録・エラー文面はすべてカーネルにある。**アプリの作成・削除は追加していない。**
  //
  // 認証は無いままなので、`127.0.0.1` バインドが唯一の防御である点は Phase 3 と変わらない。
  // ただし変更系が生えたぶん、その前提の重みは増している(ADR-0003 §8 / Consequences)。
  //
  // **【V4-FIX1 項目(5) による改訂。上の2行は制定時の記述であり1バイトも書き換えていない】**
  // **`POST /diffs` と `POST /undo` には `changeAuthMiddleware`(未認証 401 / owner 以外 403)が
  // 掛かった。** **`127.0.0.1` バインドが唯一の防御ではなくなったが、消えてもいない** ——
  // **`GET /undo/preview` / `GET /changelog` / `GET /requirements` は今日も未認証で通る。**
  // **MCP はこの HTTP を1本も叩かない(カーネル直呼び)ので1ミリも影響を受けない。**
  //
  // **【`V5-M3-T01` による移設。上の記述は1バイトも書き換えていない】**
  // **本ブロックは `src/server/app.ts` から移設しただけである。** **`app.use` の2本も
  // 一緒に移した** —— **ルートだけ外して関門を残すと、`runner` プロファイルで
  // 未認証の `POST /diffs` が 404 ではなく 401 になり、「その口はあるが認証が要る」に
  // 見えてしまう。**
  app.use("/api/apps/:app_id/diffs", changeAuthMiddleware);
  app.use("/api/apps/:app_id/undo", changeAuthMiddleware);

  // 10. 差分の適用(apply_diff)
  app.post("/api/apps/:app_id/diffs", async (c) => {
    const appId = c.req.param("app_id");
    const unknownApp = ensureApp(appId);
    if (unknownApp !== null) {
      return c.json(errorBody([unknownApp]), 404);
    }

    // 差分の形(オブジェクトか、op が語彙内か、intent があるか)は検証しない。
    // それは `applyDiff` → `validateDiff` の担当で、ここは JSON に戻すだけ。
    const body = await readJsonBody(c.req.raw);
    if (!body.ok) {
      return c.json(errorBody(body.errors), 400);
    }

    // =====================================================================================
    // **【`V8-M30`。台帳 `T-G29` = 限定採用。ユーザ決定 `D-V8-47`】締め出しの防止の2本目**
    // =====================================================================================
    //
    // **`set_roles` は役割の宣言を丸ごと差し替える op なので、`role` + `write` を持つ役割を
    // 全部落とした宣言を書ける。** **そうなったアプリでは誰も人に役割を配れなくなる。**
    //
    // **`countOwners()`(`'owner'` という綴りを数える1本目)はこれを1件も止めない** ——
    // **数えているのが「綴り」であって「配れること」ではないからである**
    // (`docs/plan/v8/records/v8-m25.md` §5-2 の (4))。
    //
    // **【1本目を1バイトも置き換えていない】** **`src/auth/store.ts` の `countOwners` /
    // `ensureOwnerExists` / `LastOwnerError` は今日も在り、SQL の `'owner'` も残っている**
    // (`D-V8-47` の逐語「今と同じ仕掛けを外側に残します」)。
    //
    // **【`undo` は今日もここを1度も通らない】** —— **`POST /undo` にこの検査を掛けて
    // いない**(`D-V8-51` = 巻き戻しの迂回は実測して記録するだけ。塞がない)。
    const lockout = rejectGrantLockout(appId, body.value);
    if (lockout !== null) {
      return c.json(errorBody([lockout]), 409);
    }

    const result = kernel.applyDiff(dataRoot, appId, body.value);
    if (!result.valid) {
      return c.json(errorBody(result.errors), 400);
    }
    return c.json(
      {
        change: {
          manifest: result.manifest,
          plan: result.plan,
          snapshot: result.snapshot,
          entry: result.entry,
          // **【`V8-M18` / 台帳 `J-G16`。裁定 `R-17-6`】誰も通さない条件・全員を通す条件の知らせ。**
          // **限定の逐語は「書いた人に返る形で伝える」であり、裁定は「MCP と HTTP の応答に出す」
          // と書いている。** **MCP は `src/mcp/tools/write.ts` が既に出しており、ここが HTTP の側。**
          // **拒否ではない** —— **応答は今日どおり 201 であり、適用は通っている。**
          // **矛盾が無ければ空配列が返る。欄そのものは常に在る**(「黙って何もしない」を作らない)。
          //
          // **【`change` の内側に置いた理由】** **`ADR-0003` §3 が「返るのは単一キー `change` に
          // 包んだ適用結果」と定めており、`src/server/change-api.test.ts` が
          // `Object.keys(body)` を `["change"]` で固定している。** **外に並べるとその不変条件を
          // 破る** —— **本タスクは既存の期待値を緩めない側を採った。**
          role_condition_notices: result.role_condition_notices,
        },
      },
      201,
    );
  });

  // 11. 取り消し(undo)
  app.post("/api/apps/:app_id/undo", (c) => {
    const appId = c.req.param("app_id");
    const unknownApp = ensureApp(appId);
    if (unknownApp !== null) {
      return c.json(errorBody([unknownApp]), 404);
    }

    // ボディは読まない。undo の対象は changelog から一意に決まる(ADR-0004 §3)ので、
    // 「どれを取り消すか」を HTTP から指定させる余地を作らない。
    const result = kernel.undo(dataRoot, appId);
    if (!result.valid) {
      return c.json(errorBody(result.errors), 400);
    }
    return c.json({
      undo: {
        manifest: result.manifest,
        entry: result.entry,
        snapshot: result.snapshot,
        restored_from: result.restored_from,
      },
    });
  });

  // 12. 取り消しの事前確認(preview_undo)。参照系なので GET。
  //     `POST /undo` に dry_run フラグを足す形にはしない(ADR-0004 §2)。
  app.get("/api/apps/:app_id/undo/preview", (c) => {
    const appId = c.req.param("app_id");
    const unknownApp = ensureApp(appId);
    if (unknownApp !== null) {
      return c.json(errorBody([unknownApp]), 404);
    }

    const result = kernel.previewUndo(dataRoot, appId);
    if (!result.valid) {
      return c.json(errorBody(result.errors), 400);
    }
    return c.json({ preview: result.preview });
  });

  // 13. 変更履歴の取得(get_changelog)。apply も undo も、記録された順にそのまま返す。
  app.get("/api/apps/:app_id/changelog", (c) => {
    const appId = c.req.param("app_id");
    const unknownApp = ensureApp(appId);
    if (unknownApp !== null) {
      return c.json(errorBody([unknownApp]), 404);
    }
    return c.json({ changelog: kernel.getChangelog(dataRoot, appId) });
  });

  // 14. 要件定義書の生成(V1-M8-T02 / ADR-0025 §10)。
  //
  // **認可は changelog / manifest と同列のローカル専用(認証なし)である**(§10-1)。
  // 要件定義書が含むのは changelog と manifest の再構成であって、新しい情報を1バイトも
  // 作らない。owner 検査を足すには「changelog より厳しい理由」が要るが、その理由が無い。
  //
  // **そのうえで隠さずに書く**: これは ADR-0006 Consequences が記録した「無認証で全アプリの
  // 変更意図が読める」状態の**影響拡大**である。要件定義書は intent を逐語引用として含むので、
  // 業務上の意図がより読みやすい形で無認証に出る。認証の不在は `127.0.0.1` バインドのみで
  // 防がれている。**解決していない。記録する。**
  //
  // 生成物は保存しない(限定12)。呼ばれるたびにその時点の状態から作り直す。
  app.get("/api/apps/:app_id/requirements", (c) => {
    const appId = c.req.param("app_id");
    const unknownApp = ensureApp(appId);
    if (unknownApp !== null) {
      return c.json(errorBody([unknownApp]), 404);
    }

    const query = parseRequirementsQuery(new URL(c.req.url).searchParams);
    if (!query.ok) {
      return c.json(errorBody(query.errors), 400);
    }
    const { format, section } = query.value;

    const doc = kernel.generateRequirementsDoc(dataRoot, appId);
    const statements: RequirementStatement[] =
      section === undefined
        ? doc.statements
        : doc.statements.filter((statement) => statement.section === section);
    // 節で絞ったときは markdown も絞った statements から**カーネルに描き直させる**
    // (入口層で markdown を切り貼りしない。ADR-0025 限定9)。
    const markdown =
      section === undefined ? doc.markdown : kernel.renderRequirementsMarkdown(statements);

    if (format === "json") {
      return c.json({
        requirements: {
          app_id: doc.app_id,
          format,
          section: section ?? null,
          statements,
          markdown,
          identifiers: doc.identifiers,
        },
      });
    }

    // markdown 単体では出典欄が消えるので、記述ごとの出典表を必ず添える
    // (「全記述が出典を持つ」ことがこの生成物の主張そのものである)。
    return c.json({
      requirements: {
        app_id: doc.app_id,
        format,
        section: section ?? null,
        markdown,
        sources: statements.map((statement) => ({
          statement_id: statement.id,
          text: statement.text,
          sources: statement.sources,
        })),
      },
    });
  });
}
