/**
 * **`V7-M7-T02`〜`V7-M7-T09`**: **依頼文の条件を1行ずつ、`API` から直接叩いて測る8シナリオ。**
 *
 * **正は `docs/plan/v7/records/v7-m7.md` の `V7-M7-T02`〜`T09` の表である。**
 *
 * ## **本ファイルの作法(先に宣言する)**
 *
 * - **ブラウザを1度も開かない。** **`page` フィクスチャを1つの `test()` も受け取らない** ——
 *   **`T09` の完了条件が「『画面にボタンが出ない』を根拠にしない」であり、画面を開かないこと
 *   そのものが要件だからである。** **叩くのは Playwright の `request`
 *   (`APIRequestContext`。ブラウザの cookie を共有しない)だけである。**
 * - **本物の `SQLite` を使う。** **`web/e2e/fixture-server.ts` が `fs.mkdtemp` で作った
 *   一時データルートの上で `src/server/app.ts` をそのまま起動しており、レコードは
 *   `<dataRoot>/apps/<app_id>/app.sqlite` に入る。** **モックは1つも挟んでいない。**
 *   **リポジトリの `data/` には1バイトも触れない。**
 * - **生の応答を残す。** **1回の要求ごとに `curl -i` 相当の行(打った要求 / ステータス /
 *   本文の先頭)を {@link transcript} に積み、テストの最後に標準出力へ流す。** **主要な
 *   `expect()` にはその写しを message として渡してあるので、落ちたときも何が返ったかが出る。**
 *
 * ## **アプリの組み方(`V7-M7-T01` の写しをどう再現したか)**
 *
 * **`V7-M7-T01` はメイン作業ツリーの `data/` に `servicedesk-v7` を作った。**
 * **`data/` は worktree に複製されないので、本ファイルは**同じ形**を一時データルートに
 * 組み直す。** 組み方は **`POST /api/apps/:app_id/diffs`(製品の HTTP 経路)** である
 * (**`MCP` は接続中のサーバが `access_control` を知らないため使えない**)。
 * **差分は owner のセッションで送る**(`changeAuthMiddleware`: 未認証 401 / owner 以外 403)。
 *
 * **表は7本**: `notices`(**`access_control` を1つも書かない** = オプトインの母数)/
 * `desk_groups` / `desk_members` / `projects` / `issues` / `comments` / `grants`。
 * **宣言は3本**(`projects` / `issues` / `comments`)。
 *
 * **【写しと1つだけ違う点。隠さない】** **払い出し(`POST /__e2e__/apps`)は
 * `fixtures/valid/inventory-all-field-types.json` のアプリを作るので、**上の7本に加えて
 * フィクスチャの `categories` / `items` が同じアプリに残っている。** **どちらも
 * `access_control` を1バイトも宣言しておらず、本ファイルの判定に1度も現れない。**
 * **さらに `T09` だけは、自分のアプリに `issues.attachment`(`file`)を1項目だけ足す**
 * ——**添付の配信が付与で絞られることを測るためであり、他の7シナリオのアプリには無い。**
 *
 * ## **本ファイルが測っていないもの(誇張しない)**
 *
 * - **`MCP` / 受信口 / ワークフロー / コードの島から同じ行を読み書きする経路。**
 *   **1バイトも叩いていない。**
 * - **画面(`web/src/`)の挙動。** **1枚も開いていない。**
 * - **`_auth_users` の id が再利用されないことの「実験による」証明** —— **`T05` が示すのは
 *   ソースの逐語(乱数32バイト)と、退会 → 同名で再登録したときに id が現に変わることの
 *   1回の実測である。** **総当たりで衝突しないことを測ってはいない。**
 */
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type APIRequestContext, type APIResponse, expect, test } from "@playwright/test";
import { type FixtureApp, provisionApp, seedRoleSession } from "./fixture-app.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** ブラウザと同じ既定 port(`playwright.config.ts` / `fixture-server.ts` と揃える)。 */
const port = Number(process.env.ST_E2E_PORT ?? 3210);

/**
 * 状態変更に付ける `Origin`。
 *
 * **`fixture-server.ts` が `ST_AUTH_EXPECTED_ORIGIN` をこの値に固定している。**
 * **`127.0.0.1` にすると `ST_AUTH_RP_ID`(WebAuthn の rpID)の検査で起動できないので
 * `localhost` である。** **付けずに送ると Origin 検査は素通りする**(ヘッダが無いときは
 * 検査しない設計)**が、ブラウザに近い形で測りたいので必ず付ける。**
 */
const ORIGIN = `http://localhost:${port}`;

// ---------------------------------------------------------------------------
// 生の応答を残す(`curl -i` 相当)
// ---------------------------------------------------------------------------

/** 本文をどこまで写すか。長い一覧で出力が埋まらないようにするためだけの上限。 */
const BODY_CLIP = 600;

type Exchange = {
  readonly status: number;
  readonly body: string;
  readonly headers: Record<string, string>;
  /** 本文を JSON として読む(壊れていたら本文ごと投げる)。 */
  json<T>(): T;
};

type Transcript = {
  /** 1往復を写して、ステータス・本文・ヘッダを返す。 */
  record(label: string, method: string, path: string, response: APIResponse): Promise<Exchange>;
  /** ここまでの全往復(`curl -i` 相当の生出力)。 */
  text(): string;
  /** 標準出力に流す(`bun run test:e2e` の出力に残す)。 */
  flush(): void;
};

function transcript(id: string): Transcript {
  const lines: string[] = [`===== ${id} 生の応答(curl -i 相当) =====`];
  return {
    async record(label, method, path, response) {
      const body = await response.text();
      const headers = response.headers();
      const clipped = body.length > BODY_CLIP ? `${body.slice(0, BODY_CLIP)}…(以下略)` : body;
      lines.push(
        `[${id}] ${label}`,
        `  $ curl -i -X ${method} '${ORIGIN}${path}'`,
        `  < HTTP ${response.status()}`,
        `  < ${clipped === "" ? "(本文なし)" : clipped}`,
      );
      return {
        status: response.status(),
        body,
        headers,
        json<T>(): T {
          try {
            return JSON.parse(body) as T;
          } catch {
            throw new Error(`JSON として読めない本文: ${body}`);
          }
        },
      };
    },
    text: () => lines.join("\n"),
    flush: () => {
      console.log(lines.join("\n"));
    },
  };
}

/** 1往復。**必ず {@link Transcript} に写してから返す。** */
async function api(
  request: APIRequestContext,
  tr: Transcript,
  label: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  init: { data?: unknown; headers?: Record<string, string>; multipart?: unknown } = {},
): Promise<Exchange> {
  const response = await request.fetch(path, {
    method,
    ...(init.data === undefined ? {} : { data: init.data }),
    ...(init.multipart === undefined ? {} : { multipart: init.multipart as never }),
    headers: init.headers ?? {},
  });
  return tr.record(label, method, path, response);
}

// ---------------------------------------------------------------------------
// 実証用サービスデスク(`servicedesk-v7`)の形
// ---------------------------------------------------------------------------

/** **3本の宣言の共通部分**。権限名は3個で、動詞の増え方が3段になっている。 */
const PERMISSIONS = [
  { id: "reader", name: "参照のみ(読むだけ)", read: true, write: false, delete: false },
  { id: "writer", name: "編集できる(読む+書く)", read: true, write: true, delete: false },
  { id: "remover", name: "消せる(読む+書く+消す)", read: true, write: true, delete: true },
] as const;

/**
 * 保護対象の表に載せる宣言。
 *
 * **付与表 `grants` は1本で、3本の宣言が同じ表を名指しし、対象の列(`target`)だけが違う。**
 * **メンバー表・グループ表も1本ずつで、列の役割は宣言が名指しする**(規約の綴りではない)。
 */
function declaration(
  target: "project" | "issue" | "comment",
  creatorPermission: "reader" | "writer" | "remover",
  inheritFrom?: readonly string[],
): Record<string, unknown> {
  return {
    enabled: true,
    permissions: PERMISSIONS.map((permission) => ({ ...permission })),
    creator_permission: creatorPermission,
    grant: {
      table: "grants",
      target,
      member: "member",
      group: "group",
      permission: "permission",
    },
    members: { table: "desk_members", account: "account", group: "group" },
    groups: { table: "desk_groups" },
    ...(inheritFrom === undefined ? {} : { inherit_from: [...inheritFrom] }),
  };
}

/** 表7本。**参照される側を先に置く**(1つの差分に畳んで送るため)。 */
const SERVICEDESK_TABLES: readonly Record<string, unknown>[] = [
  {
    // **オプトインの母数。`access_control` を1バイトも書かない。**
    id: "notices",
    name: "お知らせ",
    fields: [
      { id: "title", name: "件名", type: "text", required: true },
      { id: "body", name: "本文", type: "long_text" },
    ],
  },
  {
    id: "desk_groups",
    name: "グループ",
    fields: [
      { id: "name", name: "名前", type: "text", required: true },
      { id: "note", name: "メモ", type: "text" },
    ],
  },
  {
    id: "desk_members",
    name: "メンバー",
    fields: [
      { id: "display_name", name: "表示名", type: "text", required: true },
      // **ここに入るのはメールアドレスではなく `_auth_users.id` である**
      // (不透明なランダム32バイト。当時 `src/auth/store.ts:189` → 今日 `src/auth/store.ts:226`
      //  の `randomId()`。`V8-M16` が同ファイルに行を足したため下にずれた)。
      { id: "account", name: "ログインアカウント", type: "text" },
      { id: "group", name: "グループ", type: "reference", reference_table: "desk_groups" },
    ],
  },
  {
    id: "projects",
    name: "プロジェクト",
    fields: [
      { id: "name", name: "名前", type: "text", required: true },
      { id: "summary", name: "概要", type: "long_text" },
    ],
    access_control: declaration("project", "remover"),
  },
  {
    id: "issues",
    name: "課題",
    fields: [
      { id: "title", name: "件名", type: "text", required: true },
      { id: "detail", name: "詳細", type: "long_text" },
      { id: "project", name: "プロジェクト", type: "reference", reference_table: "projects" },
      { id: "assignee", name: "担当者", type: "reference", reference_table: "desk_members" },
      { id: "state", name: "状態", type: "select", options: ["受付", "対応中", "完了"] },
    ],
    access_control: declaration("issue", "writer", ["project"]),
  },
  {
    id: "comments",
    name: "コメント",
    fields: [
      { id: "body", name: "本文", type: "long_text", required: true },
      { id: "issue", name: "課題", type: "reference", reference_table: "issues" },
    ],
    access_control: declaration("comment", "writer", ["issue"]),
  },
  {
    // **付与表そのものは `access_control` を宣言していない** ——
    // **3本の宣言から `grant.table` として名指しされているだけである。**
    id: "grants",
    name: "付与",
    fields: [
      { id: "project", name: "プロジェクト", type: "reference", reference_table: "projects" },
      { id: "issue", name: "課題", type: "reference", reference_table: "issues" },
      { id: "comment", name: "コメント", type: "reference", reference_table: "comments" },
      { id: "member", name: "相手", type: "reference", reference_table: "desk_members" },
      { id: "group", name: "グループ", type: "reference", reference_table: "desk_groups" },
      {
        id: "permission",
        name: "権限",
        type: "select",
        options: ["reader", "writer", "remover"],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// 土台(払い出し → 差分の適用 → 登場人物)
// ---------------------------------------------------------------------------

/** このアプリの API パスを組む。 */
function paths(appId: string) {
  return {
    records: (table: string) => `/api/apps/${appId}/tables/${table}/records`,
    record: (table: string, recordId: string) =>
      `/api/apps/${appId}/tables/${table}/records/${recordId}`,
    diffs: `/api/apps/${appId}/diffs`,
    files: `/api/apps/${appId}/files`,
    file: (fileId: string) => `/api/apps/${appId}/files/${fileId}`,
  };
}

/**
 * テスト1件専用のアプリを払い出し、**`POST /diffs` で7本の表を入れる。**
 *
 * **差分は owner のセッションで送る** —— **未認証では 401、owner 以外では 403 で通らない
 * (`changeAuthMiddleware`)。**
 */
async function setupServicedesk(
  request: APIRequestContext,
  tr: Transcript,
): Promise<{ app: FixtureApp; p: ReturnType<typeof paths> }> {
  const app = await provisionApp(request);
  const p = paths(app.appId);
  const applied = await api(request, tr, "owner が7本の表を差分で入れる", "POST", p.diffs, {
    data: {
      diff_id: "v7-m7-servicedesk",
      intent: "V7-M7-T01 の実証用サービスデスクと同じ形を E2E の一時データルートに再現する",
      operations: SERVICEDESK_TABLES.map((table) => ({ op: "add_table", table })),
    },
    headers: { ...app.authHeaders, origin: ORIGIN },
  });
  expect(applied.status, tr.text()).toBe(201);
  return { app, p };
}

/** このアプリに居る1人。**メンバー表の行を必ず持つ**(持たないと保護表に行を作れない)。 */
type Actor = {
  readonly label: string;
  readonly userId: string;
  readonly username: string;
  readonly headers: { cookie: string };
  /** `desk_members` の行 `_id`(付与の相手として指す)。 */
  readonly memberId: string;
};

/**
 * 利用者を1人増やす。
 *
 * **ロールは既定で `editor`** —— **`viewer` と「宣言された利用者の種類」は
 * `records` の書込に届かない**(`ADR-0015`。付与の作成も 403「閲覧のみ」で止まる)。
 * **`desk_members.account` には `_auth_users.id` をそのまま入れる。**
 */
async function addActor(
  request: APIRequestContext,
  app: FixtureApp,
  label: string,
  options: { role?: "owner" | "editor" | "viewer"; groupId?: string } = {},
): Promise<Actor> {
  const session = await seedRoleSession(request, app.appId, options.role ?? "editor");
  const memberId = await app.createRecord("desk_members", {
    display_name: label,
    account: session.userId,
    ...(options.groupId === undefined ? {} : { group: options.groupId }),
  });
  return {
    label,
    userId: session.userId,
    username: session.username,
    headers: session.authHeaders,
    memberId,
  };
}

/** 書込のヘッダ(cookie + Origin + JSON)。 */
function writeHeaders(actor: { headers: { cookie: string } }): Record<string, string> {
  return { ...actor.headers, origin: ORIGIN, "content-type": "application/json" };
}

/** 作成応答から `_id` を取り出す。 */
function createdId(exchange: Exchange): string {
  return exchange.json<{ record: { _id: string } }>().record._id;
}

/** 一覧応答の `_id` の集合と件数。 */
function listed(exchange: Exchange): { ids: string[]; total: number } {
  const body = exchange.json<{ records: { _id: string }[]; total: number }>();
  return { ids: body.records.map((record) => record._id), total: body.total };
}

// ---------------------------------------------------------------------------
// T02 —— (i) プロジェクトを作成できる
// ---------------------------------------------------------------------------

test("V7-M7-T02 (i) プロジェクトを作成できる —— 作成が 201 で、作った本人がその行を読める", async ({
  request,
}) => {
  const tr = transcript("T02");
  try {
    const { app, p } = await setupServicedesk(request, tr);
    const alice = await addActor(request, app, "アリス");

    const created = await api(
      request,
      tr,
      "アリスがプロジェクトを作る",
      "POST",
      p.records("projects"),
      {
        data: { name: "受付システム刷新", summary: "問い合わせ導線を整える" },
        headers: writeHeaders(alice),
      },
    );
    expect(created.status, tr.text()).toBe(201);
    const projectId = createdId(created);

    // **作っただけで終わりにしない** —— **作成者に `creator_permission`(`remover`)の付与が
    // 自動で1件立つので、本人はその行を読める。**
    const readBack = await api(
      request,
      tr,
      "アリスが作ったプロジェクトを読む",
      "GET",
      p.record("projects", projectId),
      { headers: alice.headers },
    );
    expect(readBack.status, tr.text()).toBe(200);

    const grants = await api(
      request,
      tr,
      "owner が付与表を見る(作成者への自動付与が立っているか)",
      "GET",
      `${p.records("grants")}?filter.project=${encodeURIComponent(projectId)}`,
      { headers: app.authHeaders },
    );
    expect(grants.status, tr.text()).toBe(200);
    const rows = grants.json<{
      records: { member: string; permission: string }[];
      total: number;
    }>();
    expect({ total: rows.total, first: rows.records[0] }, tr.text()).toEqual({
      total: 1,
      first: expect.objectContaining({ member: alice.memberId, permission: "remover" }),
    });
  } finally {
    tr.flush();
  }
});

// ---------------------------------------------------------------------------
// T03 —— (ii) プロジェクトの中に issue を作成できる
// ---------------------------------------------------------------------------

test("V7-M7-T03 (ii) プロジェクトの中に issue を作成できる —— 作成が 201", async ({ request }) => {
  const tr = transcript("T03");
  try {
    const { app, p } = await setupServicedesk(request, tr);
    const alice = await addActor(request, app, "アリス");

    const project = await api(
      request,
      tr,
      "アリスがプロジェクトを作る",
      "POST",
      p.records("projects"),
      { data: { name: "受付システム刷新" }, headers: writeHeaders(alice) },
    );
    expect(project.status, tr.text()).toBe(201);
    const projectId = createdId(project);

    const issue = await api(
      request,
      tr,
      "アリスがそのプロジェクトの中に課題を作る",
      "POST",
      p.records("issues"),
      {
        data: {
          title: "問い合わせフォームが送信できない",
          detail: "確認ボタンで止まる",
          project: projectId,
          assignee: alice.memberId,
          state: "受付",
        },
        headers: writeHeaders(alice),
      },
    );
    expect(issue.status, tr.text()).toBe(201);
    const issueId = createdId(issue);

    const readBack = await api(
      request,
      tr,
      "アリスがその課題を読む",
      "GET",
      p.record("issues", issueId),
      { headers: alice.headers },
    );
    expect(readBack.status, tr.text()).toBe(200);
    expect(readBack.json<{ record: { project: string } }>().record.project, tr.text()).toBe(
      projectId,
    );
  } finally {
    tr.flush();
  }
});

// ---------------------------------------------------------------------------
// T04 —— (iii) 権限の無い人を指定した付与が拒否される
// ---------------------------------------------------------------------------

test("V7-M7-T04 (iii) プロジェクトを読めない人への課題の付与は 403 —— 先に読ませれば 201 になる", async ({
  request,
}) => {
  const tr = transcript("T04");
  try {
    const { app, p } = await setupServicedesk(request, tr);
    const alice = await addActor(request, app, "アリス(作成者)");
    const bob = await addActor(request, app, "ボブ(プロジェクトへの権限が1件も無い)");

    const projectId = createdId(
      await api(request, tr, "アリスがプロジェクトを作る", "POST", p.records("projects"), {
        data: { name: "受付システム刷新" },
        headers: writeHeaders(alice),
      }),
    );
    // **課題の `assignee` にボブを指しても、それだけでは権限は1ミリも動かない。**
    const issueId = createdId(
      await api(
        request,
        tr,
        "アリスが課題を作る(担当者にボブを指す)",
        "POST",
        p.records("issues"),
        {
          data: {
            title: "受付が止まる",
            project: projectId,
            assignee: bob.memberId,
            state: "受付",
          },
          headers: writeHeaders(alice),
        },
      ),
    );

    // --- 拒否される側 -------------------------------------------------------
    const denied = await api(
      request,
      tr,
      "アリスがボブへ課題の付与を作る(ボブは親のプロジェクトを1ミリも読めない)",
      "POST",
      p.records("grants"),
      {
        data: { issue: issueId, member: bob.memberId, permission: "writer" },
        headers: writeHeaders(alice),
      },
    );
    expect(denied.status, tr.text()).toBe(403);

    // **1行も増えていない。**
    const afterDenied = listed(
      await api(
        request,
        tr,
        "owner が課題への付与を数える(拒否のあと)",
        "GET",
        `${p.records("grants")}?filter.issue=${encodeURIComponent(issueId)}`,
        { headers: app.authHeaders },
      ),
    );
    expect(afterDenied.total, tr.text()).toBe(1); // アリス自身の作成者付与だけ

    // --- 通る側(拒否側だけを測らない)---------------------------------------
    const onParent = await api(
      request,
      tr,
      "アリスがボブへ親のプロジェクトの参照権限を渡す",
      "POST",
      p.records("grants"),
      {
        data: { project: projectId, member: bob.memberId, permission: "reader" },
        headers: writeHeaders(alice),
      },
    );
    expect(onParent.status, tr.text()).toBe(201);

    const allowed = await api(
      request,
      tr,
      "同じ課題の付与をもう一度作る(親を読めるようになった後)",
      "POST",
      p.records("grants"),
      {
        data: { issue: issueId, member: bob.memberId, permission: "writer" },
        headers: writeHeaders(alice),
      },
    );
    expect(allowed.status, tr.text()).toBe(201);
  } finally {
    tr.flush();
  }
});

// ---------------------------------------------------------------------------
// T05 —— (iii-b) 相手が消えたあとの付与で通らない
// ---------------------------------------------------------------------------

test("V7-M7-T05 (iii-b) 退会したあと同じ username で登録し直しても、権限は復活しない", async ({
  request,
  playwright,
}) => {
  const tr = transcript("T05");
  try {
    const { app, p } = await setupServicedesk(request, tr);
    const alice = await addActor(request, app, "アリス(作成者)");
    const carol = await addActor(request, app, "キャロル(あとで退会する)");

    const projectId = createdId(
      await api(request, tr, "アリスがプロジェクトを作る", "POST", p.records("projects"), {
        data: { name: "受付システム刷新" },
        headers: writeHeaders(alice),
      }),
    );
    const grantId = createdId(
      await api(request, tr, "アリスがキャロルへ参照権限を渡す", "POST", p.records("grants"), {
        data: { project: projectId, member: carol.memberId, permission: "reader" },
        headers: writeHeaders(alice),
      }),
    );

    const before = await api(
      request,
      tr,
      "キャロルがプロジェクトを読む(退会前)",
      "GET",
      p.record("projects", projectId),
      { headers: carol.headers },
    );
    expect(before.status, tr.text()).toBe(200);

    // --- 退会 → 同じ username で登録し直す ----------------------------------
    // **cookie の入れ物を本体と分ける** —— `request` は明示 header だけで叩き続けたいので、
    // Set-Cookie を受け取る往復は使い捨ての context で行う。
    const authCtx = await playwright.request.newContext({ baseURL: ORIGIN });
    let reborn: { id: string; cookie: string };
    try {
      const withdrawn = await api(
        authCtx,
        tr,
        "キャロルが退会する(DELETE /auth/me)",
        "DELETE",
        `/api/apps/${app.appId}/auth/me`,
        { headers: { ...carol.headers, origin: ORIGIN } },
      );
      expect(withdrawn.status, tr.text()).toBe(200);

      const registered = await api(
        authCtx,
        tr,
        `同じ username(${carol.username})で登録し直す`,
        "POST",
        `/api/apps/${app.appId}/auth/password/register`,
        {
          data: { username: carol.username, password: "rebornPassw0rd!" },
          headers: { origin: ORIGIN, "content-type": "application/json" },
        },
      );
      expect(registered.status, tr.text()).toBe(200);
      const rebornId = registered.json<{ user: { id: string } }>().user.id;
      const setCookie = (await authCtx.storageState()).cookies.find(
        (cookie) => cookie.name === "st_session",
      );
      expect(setCookie, tr.text()).toBeDefined();
      reborn = { id: rebornId, cookie: `st_session=${setCookie?.value ?? ""}` };
    } finally {
      await authCtx.dispose();
    }

    // **id は再利用されない**(根拠はこのあとの逐語検査)。
    expect(reborn.id, tr.text()).not.toBe(carol.userId);

    // --- 権限は復活しない ---------------------------------------------------
    const afterSingle = await api(
      request,
      tr,
      "登録し直した人がプロジェクトを読む",
      "GET",
      p.record("projects", projectId),
      { headers: { cookie: reborn.cookie } },
    );
    expect(afterSingle.status, tr.text()).toBe(404);

    const afterList = listed(
      await api(request, tr, "登録し直した人の一覧", "GET", p.records("projects"), {
        headers: { cookie: reborn.cookie },
      }),
    );
    expect({ ids: afterList.ids, total: afterList.total }, tr.text()).toEqual({
      ids: [],
      total: 0,
    });

    // **付与行もメンバー行も1件も消えていない** —— **消えたのは `_auth_users` の1行だけで、
    // 付与は古い id を指したまま残る。** **「権限が消えたから見えない」のではなく、
    // 「その id を持つ人がもう居ない」ので届かない。**
    const survivingGrant = await api(
      request,
      tr,
      "owner が付与行を確かめる(退会後も残っている)",
      "GET",
      p.record("grants", grantId),
      { headers: app.authHeaders },
    );
    expect(survivingGrant.status, tr.text()).toBe(200);
    expect(survivingGrant.json<{ record: { member: string } }>().record.member, tr.text()).toBe(
      carol.memberId,
    );
    const survivingMember = await api(
      request,
      tr,
      "owner がメンバー行を確かめる(account は退会した id のまま)",
      "GET",
      p.record("desk_members", carol.memberId),
      { headers: app.authHeaders },
    );
    expect(survivingMember.json<{ record: { account: string } }>().record.account, tr.text()).toBe(
      carol.userId,
    );

    // --- **id が再利用されない根拠(行番号 + 逐語)** -------------------------
    //
    // **行番号がずれた理由(2026-08-09 に `grep -n` で測り直した)** —— **`V8-M16`(1人が複数の
    // 役割を持てるようにする)が `src/auth/store.ts` に `_auth_*` の7本目の表
    // (`_auth_user_roles`)と、実効ロールの和union(`_auth_users.role` の1値 ∪ その表の付与)を
    // 足したため**、下に並ぶ逐語がすべて下方向へ動いた。**旧い行番号は消さずに併記する。**
    //
    // **当時 `src/auth/store.ts:189`〜`193` → 今日 `src/auth/store.ts:226`〜`230`**:
    //
    //     226: export function randomId(): string {     (当時 189)
    //     227:   const bytes = new Uint8Array(32);      (当時 190)
    //     228:   crypto.getRandomValues(bytes);         (当時 191)
    //     229:   return toBase64Url(bytes);             (当時 192)
    //     230: }                                       (当時 193)
    //
    // **【`V8-M21` の後半による更新。旧の行番号を1つも消していない】**
    // **`V8-M21` が `src/auth/store.ts` に `effectiveRolesOnDb`(生 `Database` から実効ロール
    // 集合を読む1本。自動処理と島に面を効かせるために足した)を入れたため、
    // `createUser` から下の逐語が **+52行** 動いた。** **`randomId` の4行(226〜229)は
    // 足した位置より上に在るので1行も動いていない。**
    // **旧: `620` / `621` / `622` → 今日: `672` / `673` / `674`。**
    //
    // **当時 `src/auth/store.ts:561`〜`563` → 今日 `src/auth/store.ts:672`〜`674`**
    // —— **ユーザの id はこの関数が作る**:
    //
    //     672:   createUser(input: { username: string; displayName?: string | null; role?: Role }): User {   (当時 561)
    //     673:     const user: User = {                                                                      (当時 562)
    //     674:       id: randomId(),                                                                         (当時 563)
    //
    // **【`V8-M30`(2026-08-11。台帳 `T-G29`)による更新。旧の行番号を1つも消していない】**
    // **`V8-M30` が `src/auth/store.ts` に `RoleGrantJudge` / `LastGranterError`
    // (締め出しの防止の2本目)を `LastOwnerError` の直後へ足したため、`createUser` から
    // 下の逐語が **+32行** 動いた。** **`randomId` の4行(226〜229)は足した位置より上に
    // 在るので1行も動いていない。**
    // **旧: `672` / `673` / `674` → 今日: `704` / `705` / `706`。**
    //
    // **【`V8-M2`(2026-08-14。台帳 `I-G9` / `ADR-0336`)による更新。旧の行番号を1つも
    // 消していない】** **`V8-M2` が `src/auth/store.ts` に `_auth_*` の8本目の表
    // (`_auth_invitations` = 招待)と、招待コードの生成器(`randomInvitationCode` /
    // `INVITATION_CODE_ALPHABET`)を **`randomId` の上**へ足したため、
    // **`randomId` 自身を含めて下の逐語がすべて +111行 動いた。**
    // **旧: `226`〜`229` → 今日: `337`〜`340`。**
    // **`createUser` の `id: randomId(),`: 旧 `706` → 今日 `845`。**
    // **`createUser(input:` の行: 旧 `704` → 今日 `843`。**
    //
    // **すなわち id は 256bit の暗号乱数であり、連番でも `AUTOINCREMENT` でもない。**
    // **`deleteUser`(当時 `src/auth/store.ts:706` → `V8-M16` 後 `:926` → `V8-M21` 後 `:978`
    // → `V8-M30` 後 `:1091` → 今日 `:1230`)は行を消す
    // だけで、空いた id を配り直す経路は 1本も無い。** **下の検査は、この逐語が今日もその行に
    // 在ることを機械で固定する**(行が動いたら赤くなる = コメントが古びたまま残らない)。
    const storeLines = readFileSync(resolve(repoRoot, "src/auth/store.ts"), "utf8").split("\n");
    const at = (lineNumber: number): string => storeLines[lineNumber - 1] ?? "";
    expect(
      {
        // **【`V8-M2`】旧の期待値(逐語)**: `226: at(226),` 〜 `229: at(229),` / `706: at(706),`
        337: at(337),
        338: at(338),
        339: at(339),
        340: at(340),
        // **【`V8-M30`】旧の期待値(逐語)**: `674: at(674),` / `674: "      id: randomId(),",`
        845: at(845),
      },
      "src/auth/store.ts の逐語が動いた(T05 のコメントを直すこと)",
    ).toEqual({
      337: "export function randomId(): string {",
      338: "  const bytes = new Uint8Array(32);",
      339: "  crypto.getRandomValues(bytes);",
      340: "  return toBase64Url(bytes);",
      845: "      id: randomId(),",
    });
    // **【`V8-M30`】旧の期待値(逐語)**: `expect(at(672)).toContain("createUser(input:");`
    // **【`V8-M2`】旧の期待値(逐語)**: `expect(at(704)).toContain("createUser(input:");`
    expect(at(843)).toContain("createUser(input:");
    // **連番の痕跡が1つも無い**(`_auth_users` の DDL を含めてファイル全体で)。
    expect(storeLines.join("\n")).not.toContain("AUTOINCREMENT");
  } finally {
    tr.flush();
  }
});

// ---------------------------------------------------------------------------
// T06 —— (iv) アサインされた人が参照・コメントできる
// ---------------------------------------------------------------------------

test("V7-M7-T06 (iv) アサインされた人は課題を GET でき、コメントの POST が通る", async ({
  request,
}) => {
  const tr = transcript("T06");
  try {
    const { app, p } = await setupServicedesk(request, tr);
    const alice = await addActor(request, app, "アリス(作成者)");
    const bob = await addActor(request, app, "ボブ(担当者)");
    const dave = await addActor(request, app, "デイブ(付与が1件も無い)");

    const projectId = createdId(
      await api(request, tr, "アリスがプロジェクトを作る", "POST", p.records("projects"), {
        data: { name: "受付システム刷新" },
        headers: writeHeaders(alice),
      }),
    );
    const issueId = createdId(
      await api(request, tr, "アリスが課題を作る(担当者はボブ)", "POST", p.records("issues"), {
        data: { title: "受付が止まる", project: projectId, assignee: bob.memberId, state: "受付" },
        headers: writeHeaders(alice),
      }),
    );
    // **アサインは権限ではない** —— **親のプロジェクトの参照権限と、課題への編集権限を、
    // 付与として明示的に渡す。**
    expect(
      (
        await api(request, tr, "アリスがボブへ親の参照権限を渡す", "POST", p.records("grants"), {
          data: { project: projectId, member: bob.memberId, permission: "reader" },
          headers: writeHeaders(alice),
        })
      ).status,
      tr.text(),
    ).toBe(201);
    expect(
      (
        await api(request, tr, "アリスがボブへ課題の編集権限を渡す", "POST", p.records("grants"), {
          data: { issue: issueId, member: bob.memberId, permission: "writer" },
          headers: writeHeaders(alice),
        })
      ).status,
      tr.text(),
    ).toBe(201);

    // --- 参照できる ---------------------------------------------------------
    const seen = await api(request, tr, "ボブが課題を読む", "GET", p.record("issues", issueId), {
      headers: bob.headers,
    });
    expect(seen.status, tr.text()).toBe(200);
    const seenList = listed(
      await api(request, tr, "ボブの課題一覧", "GET", p.records("issues"), {
        headers: bob.headers,
      }),
    );
    expect({ ids: seenList.ids, total: seenList.total }, tr.text()).toEqual({
      ids: [issueId],
      total: 1,
    });

    // --- コメントできる -----------------------------------------------------
    const commented = await api(
      request,
      tr,
      "ボブが課題にコメントする",
      "POST",
      p.records("comments"),
      { data: { body: "再現しました。調査します。", issue: issueId }, headers: writeHeaders(bob) },
    );
    expect(commented.status, tr.text()).toBe(201);
    const commentId = createdId(commented);
    const readComment = await api(
      request,
      tr,
      "ボブが自分のコメントを読む",
      "GET",
      p.record("comments", commentId),
      { headers: bob.headers },
    );
    expect(readComment.status, tr.text()).toBe(200);

    // --- 全部通っているわけではない(対照)----------------------------------
    const outsider = await api(
      request,
      tr,
      "付与が1件も無いデイブが同じ課題を読む",
      "GET",
      p.record("issues", issueId),
      { headers: dave.headers },
    );
    expect(outsider.status, tr.text()).toBe(404);

    // --- **【止めていない。実測して固定する】** ------------------------------
    // **コメントを作ることそのものは、親の課題への権限で絞られていない。**
    // **その課題を1ミリも読めないデイブでも、`issue` にその id を書いたコメントを作れる**
    // (作成者への自動付与が立つので、**自分が書いたコメントは読める**)。
    // **見えない行に紐づく行を増やせるということであり、本ファイルはそれを1ミリも
    // 止めていない。** **判定の当たり先は「作られた行の読み書き」であって「作れるか」では
    // ないためである。**
    const strangerComment = await api(
      request,
      tr,
      "【限界】付与の無いデイブが、読めない課題にコメントを作る",
      "POST",
      p.records("comments"),
      { data: { body: "見えないはずの課題に書く", issue: issueId }, headers: writeHeaders(dave) },
    );
    expect(strangerComment.status, tr.text()).toBe(201);
    // **ただし、その課題そのものは今も読めない**(コメントを作れても親は開かない)。
    const stillInvisible = await api(
      request,
      tr,
      "【限界の裏】コメントを作ったあともデイブは課題を読めない",
      "GET",
      p.record("issues", issueId),
      { headers: dave.headers },
    );
    expect(stillInvisible.status, tr.text()).toBe(404);
  } finally {
    tr.flush();
  }
});

// ---------------------------------------------------------------------------
// T07 —— (v) プロジェクトの既定の権限が issue にも効く
// ---------------------------------------------------------------------------

test("V7-M7-T07 (v) 親(プロジェクト)に付けた付与だけで、子(課題)も孫(コメント)も見える", async ({
  request,
}) => {
  const tr = transcript("T07");
  try {
    const { app, p } = await setupServicedesk(request, tr);
    const alice = await addActor(request, app, "アリス(作成者)");
    const bob = await addActor(request, app, "ボブ(親にだけ付与を受ける)");

    const projectId = createdId(
      await api(request, tr, "アリスがプロジェクトAを作る", "POST", p.records("projects"), {
        data: { name: "受付システム刷新" },
        headers: writeHeaders(alice),
      }),
    );
    const issueId = createdId(
      await api(request, tr, "アリスがAの課題を作る", "POST", p.records("issues"), {
        data: { title: "受付が止まる", project: projectId, state: "受付" },
        headers: writeHeaders(alice),
      }),
    );
    const commentId = createdId(
      await api(request, tr, "アリスがその課題にコメントする", "POST", p.records("comments"), {
        data: { body: "一次切り分け済み", issue: issueId },
        headers: writeHeaders(alice),
      }),
    );
    // **別のプロジェクト**(親の付与が横に漏れていないことの対照)。
    const otherProjectId = createdId(
      await api(request, tr, "アリスがプロジェクトBを作る", "POST", p.records("projects"), {
        data: { name: "別件" },
        headers: writeHeaders(alice),
      }),
    );
    const otherIssueId = createdId(
      await api(request, tr, "アリスがBの課題を作る", "POST", p.records("issues"), {
        data: { title: "別件の課題", project: otherProjectId, state: "受付" },
        headers: writeHeaders(alice),
      }),
    );

    // **付与はプロジェクトAへの1件だけ。** **課題にもコメントにも1件も作らない。**
    expect(
      (
        await api(request, tr, "アリスがボブへAの参照権限だけを渡す", "POST", p.records("grants"), {
          data: { project: projectId, member: bob.memberId, permission: "reader" },
          headers: writeHeaders(alice),
        })
      ).status,
      tr.text(),
    ).toBe(201);
    const bobGrants = listed(
      await api(
        request,
        tr,
        "owner がボブ宛の付与を数える(1件だけであること)",
        "GET",
        `${p.records("grants")}?filter.member=${encodeURIComponent(bob.memberId)}`,
        { headers: app.authHeaders },
      ),
    );
    expect(bobGrants.total, tr.text()).toBe(1);

    // --- 親 → 子 → 孫(3段)------------------------------------------------
    const parent = await api(
      request,
      tr,
      "ボブが親を読む",
      "GET",
      p.record("projects", projectId),
      {
        headers: bob.headers,
      },
    );
    const child = await api(request, tr, "ボブが子を読む", "GET", p.record("issues", issueId), {
      headers: bob.headers,
    });
    const grandchild = await api(
      request,
      tr,
      "ボブが孫を読む",
      "GET",
      p.record("comments", commentId),
      { headers: bob.headers },
    );
    expect(
      { parent: parent.status, child: child.status, grandchild: grandchild.status },
      tr.text(),
    ).toEqual({ parent: 200, child: 200, grandchild: 200 });

    // --- 一覧は「その親の下だけ」------------------------------------------
    const issues = listed(
      await api(request, tr, "ボブの課題一覧", "GET", p.records("issues"), {
        headers: bob.headers,
      }),
    );
    expect({ ids: issues.ids, total: issues.total }, tr.text()).toEqual({
      ids: [issueId],
      total: 1,
    });
    const comments = listed(
      await api(request, tr, "ボブのコメント一覧", "GET", p.records("comments"), {
        headers: bob.headers,
      }),
    );
    expect({ ids: comments.ids, total: comments.total }, tr.text()).toEqual({
      ids: [commentId],
      total: 1,
    });
    const otherChild = await api(
      request,
      tr,
      "ボブが別プロジェクトの課題を読む",
      "GET",
      p.record("issues", otherIssueId),
      { headers: bob.headers },
    );
    expect(otherChild.status, tr.text()).toBe(404);

    // --- 届くのは権限名の動詞だけ(`reader` は書けない)----------------------
    const version = child.headers.etag;
    expect(version, tr.text()).toBeDefined();
    const write = await api(
      request,
      tr,
      "ボブ(参照のみ)が子を書き換えようとする",
      "PATCH",
      p.record("issues", issueId),
      {
        data: { state: "対応中" },
        headers: { ...writeHeaders(bob), "if-match": version ?? "" },
      },
    );
    expect(write.status, tr.text()).toBe(403);
  } finally {
    tr.flush();
  }
});

// ---------------------------------------------------------------------------
// T08 —— (vi) グループとユーザを複数選んで付与できる
// ---------------------------------------------------------------------------

test("V7-M7-T08 (vi) 1つのプロジェクトの行に、ユーザへの付与とグループへの付与が同時に立つ", async ({
  request,
}) => {
  const tr = transcript("T08");
  try {
    const { app, p } = await setupServicedesk(request, tr);
    const groupId = await app.createRecord("desk_groups", {
      name: "一次受付班",
      note: "電話とメールの一次対応",
    });
    const alice = await addActor(request, app, "アリス(作成者)");
    const bob = await addActor(request, app, "ボブ(ユーザとして直接もらう)");
    const dave = await addActor(request, app, "デイブ(一次受付班の一員)", { groupId });
    const erin = await addActor(request, app, "エリン(班にも入らず付与も無い)");

    const projectId = createdId(
      await api(request, tr, "アリスがプロジェクトを作る", "POST", p.records("projects"), {
        data: { name: "受付システム刷新" },
        headers: writeHeaders(alice),
      }),
    );

    const toUser = await api(
      request,
      tr,
      "アリスがボブ(ユーザ)へ参照権限を渡す",
      "POST",
      p.records("grants"),
      {
        data: { project: projectId, member: bob.memberId, permission: "reader" },
        headers: writeHeaders(alice),
      },
    );
    expect(toUser.status, tr.text()).toBe(201);
    const toGroup = await api(
      request,
      tr,
      "アリスが一次受付班(グループ)へ編集権限を渡す",
      "POST",
      p.records("grants"),
      {
        data: { project: projectId, group: groupId, permission: "writer" },
        headers: writeHeaders(alice),
      },
    );
    expect(toGroup.status, tr.text()).toBe(201);

    // --- **1行に複数の付与が立っている** -----------------------------------
    const onProject = await api(
      request,
      tr,
      "owner がこのプロジェクトへの付与を全部見る",
      "GET",
      `${p.records("grants")}?filter.project=${encodeURIComponent(projectId)}`,
      { headers: app.authHeaders },
    );
    const rows = onProject.json<{
      records: { member: string | null; group: string | null; permission: string }[];
      total: number;
    }>();
    expect(rows.total, tr.text()).toBe(3); // アリスの作成者付与 + ボブ + 一次受付班
    expect(
      rows.records.map((row) => ({
        member: row.member,
        group: row.group,
        permission: row.permission,
      })),
      tr.text(),
    ).toEqual(
      expect.arrayContaining([
        { member: alice.memberId, group: null, permission: "remover" },
        { member: bob.memberId, group: null, permission: "reader" },
        { member: null, group: groupId, permission: "writer" },
      ]),
    );

    // --- 直接の相手も、グループ経由の人も見える -----------------------------
    const byUser = await api(
      request,
      tr,
      "ボブが読む(直接の付与)",
      "GET",
      p.record("projects", projectId),
      { headers: bob.headers },
    );
    const byGroup = await api(
      request,
      tr,
      "デイブが読む(グループ経由)",
      "GET",
      p.record("projects", projectId),
      { headers: dave.headers },
    );
    const neither = await api(
      request,
      tr,
      "エリンが読む(班にも入らず付与も無い)",
      "GET",
      p.record("projects", projectId),
      { headers: erin.headers },
    );
    expect(
      { byUser: byUser.status, byGroup: byGroup.status, neither: neither.status },
      tr.text(),
    ).toEqual({ byUser: 200, byGroup: 200, neither: 404 });

    // **グループには編集権限を渡したので、グループ経由の人は書ける**
    // (ユーザとして参照権限だけをもらったボブは書けない)。
    const version = byGroup.headers.etag ?? "";
    const groupWrite = await api(
      request,
      tr,
      "デイブが書き換える(グループ経由の編集権限)",
      "PATCH",
      p.record("projects", projectId),
      {
        data: { summary: "一次受付班が更新" },
        headers: { ...writeHeaders(dave), "if-match": version },
      },
    );
    expect(groupWrite.status, tr.text()).toBe(200);
    const userWrite = await api(
      request,
      tr,
      "ボブが書き換えようとする(参照のみ)",
      "PATCH",
      p.record("projects", projectId),
      {
        data: { summary: "ボブが更新" },
        headers: { ...writeHeaders(bob), "if-match": groupWrite.headers.etag ?? version },
      },
    );
    expect(userWrite.status, tr.text()).toBe(403);
  } finally {
    tr.flush();
  }
});

// ---------------------------------------------------------------------------
// T09 —— (vii) 権限を持たない人には API から直接叩いても見えない
// ---------------------------------------------------------------------------

test("V7-M7-T09 (vii) 権限を持たない人は、一覧0件 / 単件404 / PATCH / DELETE / 添付配信まで届かない", async ({
  request,
}) => {
  const tr = transcript("T09");
  try {
    const { app, p } = await setupServicedesk(request, tr);

    // **このテストだけ、課題に添付の項目を1本足す**(添付の配信を測るため)。
    const extended = await api(request, tr, "owner が課題に添付の項目を足す", "POST", p.diffs, {
      data: {
        diff_id: "v7-m7-issue-attachment",
        intent: "添付の配信が付与で絞られることを E2E で測るため、課題に file 項目を1本足す",
        operations: [
          {
            op: "add_field",
            table: "issues",
            field: { id: "attachment", name: "添付", type: "file" },
          },
        ],
      },
      headers: { ...app.authHeaders, origin: ORIGIN },
    });
    expect(extended.status, tr.text()).toBe(201);

    const alice = await addActor(request, app, "アリス(作成者)");
    const mallory = await addActor(request, app, "マロリー(付与が1件も無い)");

    const projectId = createdId(
      await api(request, tr, "アリスがプロジェクトを作る", "POST", p.records("projects"), {
        data: { name: "受付システム刷新", summary: "外に出したくない要約" },
        headers: writeHeaders(alice),
      }),
    );
    const issueId = createdId(
      await api(request, tr, "アリスが課題を作る", "POST", p.records("issues"), {
        data: { title: "外に出したくない件名", project: projectId, state: "受付" },
        headers: writeHeaders(alice),
      }),
    );
    // 宣言していない表(オプトインの母数)にも1行置く。
    const noticeId = await app.createRecord("notices", {
      title: "年末年始の受付時間",
      body: "12/29 から 1/3 は休業します。",
    });

    // --- 添付を1つ置く ------------------------------------------------------
    const uploaded = await api(request, tr, "アリスが添付を上げる", "POST", p.files, {
      multipart: {
        kind: "file",
        file: {
          name: "手順.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("社外秘の調査手順", "utf8"),
        },
      },
      headers: { ...alice.headers, origin: ORIGIN },
    });
    expect(uploaded.status, tr.text()).toBe(201);
    const fileId = uploaded.json<{ file_id: string }>().file_id;

    const aliceIssue = await api(
      request,
      tr,
      "アリスが課題を読む(版を取る)",
      "GET",
      p.record("issues", issueId),
      { headers: alice.headers },
    );
    expect(aliceIssue.status, tr.text()).toBe(200);
    const attached = await api(
      request,
      tr,
      "アリスが課題に添付を結び付ける",
      "PATCH",
      p.record("issues", issueId),
      {
        data: { attachment: fileId },
        headers: { ...writeHeaders(alice), "if-match": aliceIssue.headers.etag ?? "" },
      },
    );
    expect(attached.status, tr.text()).toBe(200);

    // --- **権限を持たない人から、API を直接叩く** ---------------------------
    const projectList = listed(
      await api(request, tr, "マロリーのプロジェクト一覧", "GET", p.records("projects"), {
        headers: mallory.headers,
      }),
    );
    expect({ ids: projectList.ids, total: projectList.total }, tr.text()).toEqual({
      ids: [],
      total: 0,
    });
    const issueList = listed(
      await api(request, tr, "マロリーの課題一覧", "GET", p.records("issues"), {
        headers: mallory.headers,
      }),
    );
    expect({ ids: issueList.ids, total: issueList.total }, tr.text()).toEqual({
      ids: [],
      total: 0,
    });

    const single = await api(
      request,
      tr,
      "マロリーが単件を取る",
      "GET",
      p.record("projects", projectId),
      { headers: mallory.headers },
    );
    expect(single.status, tr.text()).toBe(404);
    // **本文に行の中身が1文字も乗っていない。**
    expect(single.body, tr.text()).not.toContain("外に出したくない要約");

    const version = aliceIssue.headers.etag ?? "";
    const patched = await api(
      request,
      tr,
      "マロリーが書き換えようとする",
      "PATCH",
      p.record("projects", projectId),
      {
        data: { summary: "書き換えた" },
        headers: { ...writeHeaders(mallory), "if-match": version },
      },
    );
    expect([403, 404], tr.text()).toContain(patched.status);
    const removed = await api(
      request,
      tr,
      "マロリーが消そうとする",
      "DELETE",
      p.record("projects", projectId),
      { headers: { ...mallory.headers, origin: ORIGIN, "if-match": version } },
    );
    expect([403, 404], tr.text()).toContain(removed.status);

    // **添付の配信も届かない**(行が見えない人には file も渡らない)。
    const fileToMallory = await api(request, tr, "マロリーが添付を取る", "GET", p.file(fileId), {
      headers: mallory.headers,
    });
    expect(fileToMallory.status, tr.text()).toBe(404);
    const fileToAlice = await api(request, tr, "アリスが添付を取る", "GET", p.file(fileId), {
      headers: alice.headers,
    });
    expect(fileToAlice.status, tr.text()).toBe(200);

    // --- **全部拒否では緑にならない** ---------------------------------------
    // **宣言していない表(`notices`)は今日どおり読める** = オプトインが効いている。
    const notices = listed(
      await api(request, tr, "マロリーがお知らせ一覧を読む", "GET", p.records("notices"), {
        headers: mallory.headers,
      }),
    );
    expect({ ids: notices.ids, total: notices.total }, tr.text()).toEqual({
      ids: [noticeId],
      total: 1,
    });
    const notice = await api(
      request,
      tr,
      "マロリーがお知らせ単件を読む",
      "GET",
      p.record("notices", noticeId),
      { headers: mallory.headers },
    );
    expect(notice.status, tr.text()).toBe(200);

    // --- **【見えている物がある。丸めない】** -------------------------------
    // **付与表 `grants` は `access_control` を1バイトも宣言していない**(3本の宣言から
    // `grant.table` として名指しされているだけである)。**したがって権限を1つも持たない
    // マロリーでも、付与表を一覧でき、そこに書かれた**プロジェクトの `_id`・相手の
    // メンバー行の `_id`・権限名**を読める。** **行の中身(`name` / `summary`)は届かない
    // が、「その行が在ること」と「誰が持っているか」は伏せられていない。**
    // **メンバー表 `desk_members` も同じである** —— **`account`(= `_auth_users.id`)まで
    // 読める。** **本ファイルはこれを1ミリも止めていない。実測して残す。**
    const grantLeak = listed(
      await api(request, tr, "【限界】マロリーが付与表を一覧する", "GET", p.records("grants"), {
        headers: mallory.headers,
      }),
    );
    expect(grantLeak.total, tr.text()).toBeGreaterThan(0);
    const memberLeak = listed(
      await api(
        request,
        tr,
        "【限界】マロリーがメンバー表を一覧する",
        "GET",
        p.records("desk_members"),
        { headers: mallory.headers },
      ),
    );
    expect(memberLeak.total, tr.text()).toBeGreaterThan(0);

    // **ただし、そこから自分に権限を付け直すことはできない** —— **見えない行への付与は
    // 存在を伏せて断られる。**
    const selfGrant = await api(
      request,
      tr,
      "マロリーが自分にプロジェクトの権限を付けようとする",
      "POST",
      p.records("grants"),
      {
        data: { project: projectId, member: mallory.memberId, permission: "remover" },
        headers: writeHeaders(mallory),
      },
    );
    expect([403, 404], tr.text()).toContain(selfGrant.status);
    const afterSelfGrant = await api(
      request,
      tr,
      "付け直しのあともマロリーは読めない",
      "GET",
      p.record("projects", projectId),
      { headers: mallory.headers },
    );
    expect(afterSelfGrant.status, tr.text()).toBe(404);

    // 未認証は判定より手前の認証の壁で止まる(401。404 ではない)。
    const anonymous = await api(
      request,
      tr,
      "未認証で単件を取る",
      "GET",
      p.record("projects", projectId),
      {},
    );
    expect(anonymous.status, tr.text()).toBe(401);
  } finally {
    tr.flush();
  }
});
