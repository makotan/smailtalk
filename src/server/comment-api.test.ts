/**
 * **`V10-M11-T01`(台帳 `CM-G4`。**門外**(`Δ7`)/ 判定値 = 限定採用)。**
 * **HTTP に「コメントを1件書く口」を1本だけ足したことの検査。**
 *
 * ## この検査が主張すること
 *
 * > **`POST /api/apps/:app_id/comments` が1本だけ在り、ログイン済みの利用者(運営者でなくてよい)が
 * > コメントを1件書ける。** **口は器の書込関数(`CommentStore.addComment`)を1本呼ぶだけで、
 * > マニフェストを1度も読まず、役割の規則も1度も見ない。**
 *
 * ## この検査が主張**しない**こと(**先に書く。丸めない**)
 *
 * 1. **「未ログインでも書ける」とは1文字も主張しない。** **今日は 401 である** ——
 *    **開けるのは `V10-M11-T03`(`CM-G6`)であり、本工程ではない。**
 *    **`V10-M11-T01` が最初から未認証で通る形にすると、`V10-M11-T03` の実装が0バイトになり、
 *    その完了条件 (1) が空虚に真になる。**
 * 2. **「誰に見えるか」を1ミリも決めていない**(`CM-G5` = `V10-M11-T02`)。
 *    **この口は書くだけであり、読み出しの口は HTTP に1本も無い**(足すのは `V10-M15-T05`)。
 * 3. **状態(`open` / `not_applicable` / `applied`)と理由を更新する枝は1行も無い** ——
 *    **今日、器に状態の列も理由の列も無く**(`gp_comments` は7列ちょうど)、
 *    **`CM-G4` 限定4 が本工程に `src/kernel/` 0バイトを課している。**
 *    **`M9-T11-DECISIONS.md` 決定2(「同じ1本の口が新規と更新の両方を受ける」)は、
 *    「2本目の口を作らない」ことで履行する** —— **それを下の「書込の口は1本ちょうど」が機械に固定する。**
 *    **状態・理由の枝を同じ口に足すのは `V10-M13-T02` / `V10-M13-T03` である。**
 * 4. **画面(ブラウザ)からの書込導線は1本も作っていない。** **測っているのは HTTP だけである。**
 *
 * ## 拒否しているのは「器」か「口」か(**書き分ける**)
 *
 * | 何を送ったか | 応答 | **拒否したのは** |
 * |---|---|---|
 * | `anchorForm` / `anchorParts` / `body` の**型**が違う(文字列でない・配列でない) | 400 | **口**(器を呼ぶ前に落とす。呼べないため) |
 * | 登録簿に無い宛先の形 | 400 | **器**(`CommentStore.addComment` が投げた例外を口が写すだけ) |
 * | 部品の数が形と合わない | 400 | **器**(同上) |
 * | 本文が空 | 400 | **器**(同上) |
 * | 実在しないアプリ | 404 | **口**(`ensureApp`。既存の口と同型) |
 *
 * **口の側に2本目の検証を書いていない** —— **`CM-G4` 限定5(「口は器の書込関数を1本呼ぶだけ。
 * 判定も整形もこの口に書かない」)を守るためである。**
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMMENT_ANCHOR_FORMS,
  COMMENT_STATES,
  type Comment,
  CommentStore,
} from "../kernel/comment-store.ts";
import {
  applyManifest,
  createApp,
  KernelMetaStore,
  type Manifest,
  validateDiff,
} from "../kernel/index.ts";
import { appDbPath } from "../kernel/storage-paths.ts";
import { createServerApp } from "./app.ts";
import { visibleComments } from "./comment-visibility.ts";
import { seedSession, TEST_ORIGIN } from "./test-helpers.ts";

const APP_ID = "shop";
const PATH = `/api/apps/${APP_ID}/comments`;

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "売り場",
      tables: [],
      views: [],
      roles: [
        {
          id: "owner",
          name: "持ち主",
          rules: [
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
          ],
        },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
      ],
    },
  } as unknown as Manifest;
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-comment-api-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "売り場", { app_id: APP_ID });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP_ID, manifest()).valid).toBe(true);
  app = createServerApp({ dataRoot });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

/** 器を**直接**読む(HTTP の読み出しの口は今日1本も無いので、これが唯一の別経路である)。 */
function rowsInStore(): Comment[] {
  const store = CommentStore.openForKernel(dataRoot);
  try {
    return store.listComments(APP_ID);
  } finally {
    store.close();
  }
}

/** `cookie` が `undefined` なら Cookie を1バイトも送らない(= 未ログイン)。 */
function post(body: unknown, options: { cookie?: string; path?: string } = {}): Promise<Response> {
  const headers = new Headers({ origin: TEST_ORIGIN, "content-type": "application/json" });
  if (options.cookie !== undefined) {
    headers.set("cookie", options.cookie);
  }
  return Promise.resolve(
    app.request(
      new Request(`http://localhost${options.path ?? PATH}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
    ),
  );
}

/**
 * `GET /api/apps/:app_id/comments`(`V10-M15-T05`)。**`cookie` が `undefined` なら
 * Cookie を1バイトも送らない**(`post` と同じ作法)。`query` は `state=...` の形で渡す。
 */
function get(options: { cookie?: string; path?: string; query?: string } = {}): Promise<Response> {
  const headers = new Headers({ origin: TEST_ORIGIN });
  if (options.cookie !== undefined) {
    headers.set("cookie", options.cookie);
  }
  const path = options.path ?? PATH;
  const url =
    options.query === undefined
      ? `http://localhost${path}`
      : `http://localhost${path}?${options.query}`;
  return Promise.resolve(app.request(new Request(url, { method: "GET", headers })));
}

/** **運営者でない利用者**(`viewer`。役割の規則を1本も持たない)。 */
function viewerCookie(): string {
  return seedSession(dataRoot, APP_ID, { role: "viewer", username: "u-viewer" }).cookie;
}

// ---------------------------------------------------------------------------
// (1) 本丸 —— 運営者でない利用者が1件書ける
// ---------------------------------------------------------------------------

test("V10-M11-T01: 運営者でない利用者がログインして POST /api/apps/:app_id/comments を叩くと 201 で、器に1行できる", async () => {
  expect(rowsInStore()).toHaveLength(0);
  const res = await post(
    { anchorForm: "view_field", anchorParts: ["cart", "qty"], body: "ここは数量を先に出したい" },
    { cookie: viewerCookie() },
  );
  expect(res.status).toBe(201);
  const payload = (await res.json()) as { comment: Comment };
  expect(payload.comment.appId).toBe(APP_ID);
  expect(payload.comment.anchorForm).toBe("view_field");
  expect(payload.comment.anchorParts).toEqual(["cart", "qty"]);
  expect(payload.comment.body).toBe("ここは数量を先に出したい");

  // **別の経路(器の直読み)で、同じ1行が在ることを確かめる。**
  const rows = rowsInStore();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toEqual(payload.comment);
});

test("V10-M11-T01: 部品を持たない形(app)も、同じ口で書ける", async () => {
  const res = await post(
    { anchorForm: "app", anchorParts: [], body: "アプリ全体への注文" },
    { cookie: viewerCookie() },
  );
  expect(res.status).toBe(201);
  expect(rowsInStore()).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// (2) 未ログインは今日 401(開けるのは V10-M11-T03)
// ---------------------------------------------------------------------------

test("V10-M11-T01: 未ログインは今日 401 である(開けるのは V10-M11-T03。ここで開けるとその実装が0バイトになる)", async () => {
  // **【`V10-M11-T03`(2026-08-24。台帳 `CM-G6` / `ADR-0367`)。この検査の名前を1バイトも
  // 書き換えていない】**
  // **2026-08-24 に `V10-M11-T03` が偽にした** —— **この口は今日、未ログインで 201 である。**
  // **`ADR-0367` §Decision 1 が「匿名に開けるのは新設の書込の口1本ちょうど」と決め、
  // その1本がこの口である。**
  // **旧の期待値(逐語。1バイトも消していない)**:
  //   `expect(res.status).toBe(401);`
  //   `expect(rowsInStore()).toHaveLength(0);`
  // **名前の「今日 401 である」は制定時の記述であり、書き換えていない**
  //(`ADR-0007` §6 規律1 と同じ作法。**今日の正は下の式と、`V10-M11-T03` の検査1 である**)。
  const res = await post({ anchorForm: "app", anchorParts: [], body: "未ログインの注文" });
  expect(res.status).toBe(201);
  expect(rowsInStore()).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// (3)〜(5) 拒否 —— **器が拒否しているものと、口が拒否しているものを分けて書く**
// ---------------------------------------------------------------------------

test("V10-M11-T01: 【器が拒否】登録簿に無い宛先の形は 400 で、受け付ける形の名前が全部応答に出る(件数は登録簿から導く)", async () => {
  const res = await post(
    { anchorForm: "view_footer", anchorParts: ["cart"], body: "知らない形" },
    { cookie: viewerCookie() },
  );
  expect(res.status).toBe(400);
  const payload = (await res.json()) as { errors: { message: string }[] };
  const message = payload.errors.map((e) => e.message).join("\n");
  // **手で焼いた 11 に依らない** —— **登録簿(`COMMENT_ANCHOR_FORMS`)から導く。**
  const missing = COMMENT_ANCHOR_FORMS.map((entry) => entry.form).filter(
    (form) => !message.includes(form),
  );
  expect(missing).toEqual([]);
  expect(message).toContain(`${COMMENT_ANCHOR_FORMS.length}つ`);
  expect(rowsInStore()).toHaveLength(0);
});

test("V10-M11-T01: 【器が拒否】部品の数が形と合わないと 400 で、器に1行も増えない", async () => {
  const res = await post(
    { anchorForm: "view_field", anchorParts: ["cart"], body: "部品が1つ足りない" },
    { cookie: viewerCookie() },
  );
  expect(res.status).toBe(400);
  expect(rowsInStore()).toHaveLength(0);
});

test("V10-M11-T01: 【器が拒否】本文が空だと 400 で、器に1行も増えない", async () => {
  const res = await post(
    { anchorForm: "app", anchorParts: [], body: "   " },
    { cookie: viewerCookie() },
  );
  expect(res.status).toBe(400);
  expect(rowsInStore()).toHaveLength(0);
});

test("V10-M11-T01: 【口が拒否】本文の形が違う(anchorParts が配列でない)と 400 で、器を1度も呼ばない", async () => {
  const res = await post(
    { anchorForm: "app", anchorParts: "cart", body: "型が違う" },
    { cookie: viewerCookie() },
  );
  expect(res.status).toBe(400);
  expect(rowsInStore()).toHaveLength(0);
});

test("V10-M11-T01: 【口が拒否】実在しないアプリは 404(ログインの有無より先に落ちる)", async () => {
  const res = await post(
    { anchorForm: "app", anchorParts: [], body: "無いアプリ" },
    { path: "/api/apps/no-such-app/comments" },
  );
  expect(res.status).toBe(404);
  // **本文まで見る** —— **口が無いときの Hono の既定の 404 と区別できないと、この検査は
  // 実装0バイトでも緑になる**(実装前に実際に緑だった)。 **見ているのは `ensureApp` の応答である。**
  const payload = (await res.json()) as { errors?: { message: string }[] };
  expect(payload.errors?.[0]?.message).toContain("no-such-app");
});

// ---------------------------------------------------------------------------
// (6)〜(8) ソース走査 —— 限定5 / 口の本数 / 読み出しの口の増分
// ---------------------------------------------------------------------------

const SERVER_DIR = import.meta.dir;
const AUTH_ROUTES_TS = readFileSync(join(SERVER_DIR, "auth-routes.ts"), "utf-8");
const APP_TS = readFileSync(join(SERVER_DIR, "app.ts"), "utf-8");

/**
 * **`entry-point-inventory.test.ts` の `ROUTE_FILES` と同じ4本**を、同じ正規表現で走査する。
 * **台帳(`HTTP_ENTRY_POINTS`)ではなく実物のソースを見る** —— 台帳の書き漏らしに引きずられないため。
 */
const ROUTE_FILES = ["app.ts", "auth-routes.ts", "change-routes.ts", "inbound-route.ts"];

function scanRoutes(): string[] {
  const found: string[] = [];
  for (const name of ROUTE_FILES) {
    const source = readFileSync(join(SERVER_DIR, name), "utf-8");
    for (const match of source.matchAll(/app\.(get|post|patch|delete|put)\("([^"]+)"/g)) {
      found.push(`${(match[1] as string).toUpperCase()} ${match[2]}`);
    }
  }
  return found.sort();
}

/** **新設ハンドラの本文だけ**を切り出す(`CM-G4` 限定5 は「ハンドラの中に」を射程にしている)。 */
const HANDLER_BEGIN = "V10-M11-T01 ハンドラ ここから";
const HANDLER_END = "V10-M11-T01 ハンドラ ここまで";

function handlerSource(): string {
  const begin = AUTH_ROUTES_TS.indexOf(HANDLER_BEGIN);
  const end = AUTH_ROUTES_TS.indexOf(HANDLER_END);
  expect(begin).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(begin);
  return AUTH_ROUTES_TS.slice(begin, end);
}

function count(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

test("V10-M11-T01: 限定5 —— ハンドラは器の書込関数を1本だけ呼び、マニフェストを1度も読まない", () => {
  const handler = handlerSource();
  expect(count(handler, "addComment")).toBe(1);
  expect(count(handler, "readCurrentManifest")).toBe(0);
  // **`judgeRoleAccess` は0件である。****限定5 の条文は「1件ちょうど」と書いているが、
  // 本工程の口は役割の規則を1つも見ない**(`D-V10-5` = 使う人も含めて誰でも書ける)——
  // **可視性の合成は `CM-G5`(`V10-M11-T02`)の持ち物であり、そちらは**読出**に効く。**
  // **食い違いは記録(`docs/plan/v10/records/v10-m11.md`)に1件立てる。**
  expect(count(handler, "judgeRoleAccess")).toBe(0);

  // **陽性対照 —— 切り出しが実際に効いていること**(ファイル全体では0件ではない)。
  expect(count(AUTH_ROUTES_TS, "judgeRoleAccess")).toBeGreaterThan(0);
  // **陽性対照 —— `readCurrentManifest` は実在する綴りであり、探し方が空振りしていない。**
  expect(count(APP_TS, "readCurrentManifest")).toBeGreaterThan(0);
});

test("V10-M11-T01: コメントの書込の口は1本ちょうどである(状態・理由の更新は V10-M13 が同じ口に載せる。2本目を作らない)", () => {
  // **`POST` と組で数える** —— **`V10-M15-T05`(`CM-G21`)が読み出しの口を足しても、
  // この検査は緑のままでなければならない**(そちらは `GET` である)。
  const writes = scanRoutes().filter(
    (entry) => entry.startsWith("POST ") && entry.includes("/comments"),
  );
  expect(writes).toEqual(["POST /api/apps/:app_id/comments"]);
});

test("V10-M11-T01: 本工程は HTTP の読み出しの口を1本も足していない(GET の増分が0本。V10-M15-T05 がここを動かす)", () => {
  // **【`V10-M15-T05`(2026-08-24。台帳 `CM-G21` / `ADR-0370`。**門A** / 限定採用)。
  // 2026-08-24 に `V10-M15-T05` が偽にした】** —— **この工程から GET の増分が1本になった。**
  // **テスト名(制定時の記述)は1バイトも書き換えていない**(`ADR-0007` §6 規律1 と同じ作法)。
  // **旧の期待値(逐語。1バイトも消していない)**: `expect(reads).toEqual([]);`
  const reads = scanRoutes().filter(
    (entry) => entry.startsWith("GET ") && entry.includes("/comments"),
  );
  expect(reads).toEqual(["GET /api/apps/:app_id/comments"]);
});

// ===========================================================================
// `V10-M11-T03`(台帳 `CM-G6` / `ADR-0367`。**門A** / 判定値 = 限定採用)
//
// > **この口だけは、ログインしていなくても書ける。** **読取は1ミリも開けない。**
// > **どのレート制限にも入れない**(`ADR-0367` 限定4 / ユーザ決定 `D-V10-31`)。
//
// **【この節が主張しないこと】**
// 1. **「荒らし対策を入れた」とは1文字も主張しない。** **入れていない。**
//    **下の検査4 が測っているのは「遮断されないこと」であって、遮断できることではない。**
// 2. **`st_public` の公開経路を1ミリも動かしていない**(`ADR-0367` 限定1 / 限界1)。
//    **既存の未認証書込は今日どおり 401 である** —— それを検査3 が固定する。
// ===========================================================================

test("V10-M11-T03: ログインせずに POST /api/apps/:app_id/comments を叩くと 201 になり、器に1行できる", async () => {
  expect(rowsInStore()).toHaveLength(0);
  // **Cookie を1バイトも送らない**(`post()` は `cookie` を省くと `cookie` ヘッダを付けない)。
  const res = await post({
    anchorForm: "view_field",
    anchorParts: ["cart", "qty"],
    body: "未ログインから書いた",
  });
  expect(res.status).toBe(201);
  const payload = (await res.json()) as { comment: Comment };
  expect(payload.comment.appId).toBe(APP_ID);
  expect(payload.comment.body).toBe("未ログインから書いた");

  // **別の経路(器の直読み)で、同じ1行が在ることを確かめる。**
  const rows = rowsInStore();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toEqual(payload.comment);

  // **陽性対照 —— 未ログインで通るのはこの口だけである。**
  // **同じ Cookie 無しで既存の書込を叩くと今日どおり 401 になる**(検査3 が全量を回す)。
  const diffs = await app.request(
    new Request(`http://localhost/api/apps/${APP_ID}/diffs`, {
      method: "POST",
      headers: { origin: TEST_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
  );
  expect(diffs.status).toBe(401);
});

test("V10-M11-T03: 未ログインはコメントを1件も読めない(合成が0件を返し、HTTP の読出の口が0本である)", async () => {
  // 未ログインで1件書く(= 読めないことを測る母集団を空にしない)。
  expect(
    (await post({ anchorForm: "app", anchorParts: [], body: "未ログインの注文" })).status,
  ).toBe(201);
  const comments = rowsInStore();
  expect(comments).toHaveLength(1);

  // (i) **合成が0件を返す**(`CM-G5` = `V10-M11-T02` の短絡)。
  expect(visibleComments({ manifest: manifest(), roles: null, comments })).toEqual([]);
  expect(visibleComments({ manifest: manifest(), roles: [], comments })).toEqual([]);

  // (ii) **`anonymous` に read と app write の両方を宣言した題材でも0件である。**
  //      **【禁止】`anonymous` を宣言していない題材だけで「未ログインには見えない」と書かない**
  //      (空虚に真になる。`RULINGS-M11.md` 裁定3)。
  const anonDeclared = manifest();
  (anonDeclared.app as unknown as { roles: unknown[] }).roles = [
    {
      id: "owner",
      name: "持ち主",
      rules: [
        { target: "app", can: ["write"] },
        { target: "role", can: ["write"] },
      ],
    },
    {
      id: "anonymous",
      name: "名乗らない人",
      rules: [
        { target: "app", can: ["write"] },
        { target: "view", view: "cart", can: ["read"] },
      ],
    },
  ];
  expect(visibleComments({ manifest: anonDeclared, roles: null, comments })).toEqual([]);
  // **陰性対照** —— 名乗りが在れば、同じ題材で見える(短絡が一律の0件ではない)。
  expect(visibleComments({ manifest: anonDeclared, roles: ["owner"], comments })).toHaveLength(1);

  // (iii) **【`V10-M15-T05`(2026-08-24。台帳 `CM-G21` / `ADR-0370`。**門A** / 限定採用)。
  // 2026-08-24 に `V10-M15-T05` が偽にした】** —— **この工程から HTTP の読出の口が1本
  // 在るが、未ログインでは 401 である(404 ではない)。** **テスト名(制定時の記述。
  // 「HTTP の読出の口が0本である」)は1バイトも書き換えていない**(`ADR-0007` §6
  // 規律1 と同じ作法。今日の正はこの式である)。
  // **旧の期待値(逐語。1バイトも消していない)**:
  //   `expect(read.status).toBe(404);`
  //   `expect(scanRoutes().filter((entry) => entry.includes("/comments"))).toEqual([`
  //   `  "POST /api/apps/:app_id/comments",`
  //   `]);`
  const read = await app.request(new Request(`http://localhost${PATH}`, { method: "GET" }));
  expect(read.status).toBe(401);
  expect(
    scanRoutes()
      .filter((entry) => entry.includes("/comments"))
      .sort(),
  ).toEqual(["GET /api/apps/:app_id/comments", "POST /api/apps/:app_id/comments"]);
});

/**
 * **既存の未認証書込8本**(`CP-V10-COMMENT` 条件3 (c) の数え方)。
 * **records 5系統 + `POST /diffs` + `POST /undo` + `POST /files` である。**
 * **`T03` はこの8本を1本も開けていない。**
 */
const EXISTING_UNAUTH_WRITES: { label: string; method: string; path: string; body?: unknown }[] = [
  {
    label: "#3 GET records(list)",
    method: "GET",
    path: `/api/apps/${APP_ID}/tables/items/records`,
  },
  {
    label: "#4 GET record",
    method: "GET",
    path: `/api/apps/${APP_ID}/tables/items/records/x`,
  },
  {
    label: "#5 POST record",
    method: "POST",
    path: `/api/apps/${APP_ID}/tables/items/records`,
    body: { name: "机" },
  },
  {
    label: "#6 PATCH record",
    method: "PATCH",
    path: `/api/apps/${APP_ID}/tables/items/records/x`,
    body: { name: "机" },
  },
  {
    label: "#7 DELETE record",
    method: "DELETE",
    path: `/api/apps/${APP_ID}/tables/items/records/x`,
  },
  { label: "#24 POST diffs", method: "POST", path: `/api/apps/${APP_ID}/diffs`, body: {} },
  { label: "#24 POST undo", method: "POST", path: `/api/apps/${APP_ID}/undo`, body: {} },
  { label: "#16 POST files", method: "POST", path: `/api/apps/${APP_ID}/files` },
];

test("V10-M11-T03: 既存の未認証書込8本は今日どおり 401 である", async () => {
  // **数え方を先に宣言する** —— **records 5系統(読取2本を含む)+ diffs + undo + files = 8本。**
  expect(EXISTING_UNAUTH_WRITES).toHaveLength(8);
  for (const ep of EXISTING_UNAUTH_WRITES) {
    const init: RequestInit = { method: ep.method, headers: { origin: TEST_ORIGIN } };
    if (ep.body !== undefined) {
      init.headers = { origin: TEST_ORIGIN, "content-type": "application/json" };
      init.body = JSON.stringify(ep.body);
    }
    const res = await app.request(new Request(`http://localhost${ep.path}`, init));
    expect(res.status, ep.label).toBe(401);
  }
});

test("V10-M11-T03: 匿名のコメント書込は、同じ窓で連続して投げても遮断されない(陽性対照: password/login は 429)", async () => {
  // **窓を小さくした別インスタンスで測る**(`limit=2`。`public-read.test.ts` の `makeApp` と同型)。
  // **この設定は既存の3リミッタの**窓の大きさ**だけを縮めるものであって、
  // 新設の口に制限を1つも掛けていない** —— **掛かっていないことを、下の 201 × 5 が示す。**
  const clock = { value: 0, now: () => clock.value };
  const limited = createServerApp({
    dataRoot,
    rateLimit: {
      publicGet: { limit: 2, windowMs: 1_000, now: clock.now },
      auth: { limit: 2, windowMs: 1_000, now: clock.now },
    },
  });
  const postComment = () =>
    limited.request(
      new Request(`http://localhost${PATH}`, {
        method: "POST",
        headers: { origin: TEST_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ anchorForm: "app", anchorParts: [], body: "連続" }),
      }),
    );
  const codes: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    codes.push((await postComment()).status);
  }
  expect(codes).toEqual([201, 201, 201, 201, 201]);
  expect(rowsInStore()).toHaveLength(5);

  // **陽性対照 —— 同じインスタンス・同じ窓で、リミッタの掛かっている口は 429 になる。**
  // **これが無いと「窓が大きすぎて 429 に届かなかっただけ」と区別できない。**
  const login = () =>
    limited.request(
      new Request(`http://localhost/api/apps/${APP_ID}/auth/password/login`, {
        method: "POST",
        headers: { origin: TEST_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ username: "nobody", password: "nope" }),
      }),
    );
  const loginCodes: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    loginCodes.push((await login()).status);
  }
  expect(loginCodes).toEqual([401, 401, 429, 429, 429]);
});

// ===========================================================================
// `V10-M13-T01`(台帳 `CM-G10`。**門A**(`Δ8`)/ 判定値 = 限定採用。`ADR-0369`)
//
// **同じ1本の口に「書き手」を渡す枝を足した。口は書き手を1度も検証しない。**
// ===========================================================================

test("V10-M13-T01: ログインして POST /api/apps/:app_id/comments を叩くと writer にセッションの利用者IDが入る", async () => {
  const seeded = seedSession(dataRoot, APP_ID, { role: "viewer", username: "u-writer" });
  const res = await post(
    { anchorForm: "app", anchorParts: [], body: "ログインして書いた1件(writer検査)" },
    { cookie: seeded.cookie },
  );
  expect(res.status).toBe(201);
  const payload = (await res.json()) as { comment: Comment };
  expect(payload.comment.writer).toBe(seeded.userId);

  // 別の経路(器の直読み)でも同じ値が入っていることを確かめる。
  const rows = rowsInStore();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.writer).toBe(seeded.userId);
});

test("V10-M13-T01: 未ログインで POST すると 201 になり、writer は null のままである", async () => {
  const res = await post({
    anchorForm: "app",
    anchorParts: [],
    body: "未ログインの1件(writer検査)",
  });
  expect(res.status).toBe(201);
  const payload = (await res.json()) as { comment: Comment };
  expect(payload.comment.writer).toBeNull();

  const rows = rowsInStore();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.writer).toBeNull();
});

test("V10-M13-T01: 口は書き手を1度も検証しない(存在しない利用者のセッションでも 201 になり writer は null になる)", async () => {
  // **本人であるユーザを1件作ってセッションを発行したあと、そのセッション行だけを残して
  // ユーザ本体を直接消す**(`AuthStore.deleteUser` はセッションも道連れに消すので使えない
  // —— ここでは「セッションは有効だが指す利用者がもう居ない」状態を意図的に作る)。
  const seeded = seedSession(dataRoot, APP_ID, { role: "viewer", username: "u-orphan" });
  const db = new Database(appDbPath(dataRoot, APP_ID));
  try {
    db.exec("PRAGMA foreign_keys = OFF;");
    db.query(`DELETE FROM "_auth_users" WHERE "id" = ?`).run(seeded.userId);
  } finally {
    db.close();
  }

  const res = await post(
    { anchorForm: "app", anchorParts: [], body: "宙に浮いたセッションで書いた1件" },
    { cookie: seeded.cookie },
  );
  // **口は `requireUser` を呼んでいないので 401 にならない**(この口はログイン必須ではない)。
  expect(res.status).toBe(201);
  const payload = (await res.json()) as { comment: Comment };
  // **`resolveOptionalUser` はセッションの指す利用者が実在しないので `null` を返す**
  // ——**セッションIDの正しさは1ミリも検証の対象ではない**(限定2の実地の担保)。
  expect(payload.comment.writer).toBeNull();
});

// ===========================================================================
// `V10-M13-T02`(台帳 `CM-G19`。**門A**(`Δ8`)/ 判定値 = 限定採用。`ADR-0369`)
//
// **同じ1本の口に、状態を書き換える枝を足した。** **`comment_id` が本文に在れば
// update、無ければ create(今日どおり)。** **update はログイン必須(未ログインは 401。
// 裁定F)。** **`state` の値域検査は器がやる。口は文字列をそのまま渡す**
// (型で絞らない。create 枝の `anchorForm` と同じ設計)。
//
// ## この節が主張しないこと
//
// 1. **`PATCH` を足していない。** **口は今日も `POST` の1本ちょうどである** ——
//    これは `V10-M11-T01` が既に置いた検査(「コメントの書込の口は1本ちょうどである」)
//    が固定しており、**本節は同じ主張を2本目の検査として作らない**(実物を見て決めた。
//    `CHECK-M13.md` B-10)。
// 2. **役割の規則を1つも掛けていない**(裁定G)。 **ログインしてさえいれば、他人が
//    書いたコメントの状態も倒せる** —— これは限界であり、記録に書く。
// ===========================================================================

test("V10-M13-T02: 同じ POST の口に comment_id を送ると状態が倒れ、201 ではなく 200 が返る", async () => {
  const seeded = seedSession(dataRoot, APP_ID, { role: "viewer", username: "u-updater" });
  const created = await post(
    { anchorForm: "app", anchorParts: [], body: "状態を倒す1件" },
    { cookie: seeded.cookie },
  );
  expect(created.status).toBe(201);
  const createdPayload = (await created.json()) as { comment: Comment };
  expect(createdPayload.comment.state).toBe(COMMENT_STATES[0]);

  // **`V10-M13-T03` の波及**: 対応できないという値(`COMMENT_STATES[1]`)は理由が
  // 必須になったので、ここでも渡す。
  const updated = await post(
    {
      comment_id: createdPayload.comment.id,
      state: COMMENT_STATES[1],
      reason: "同じ口に状態を倒す枝が乗ることを確かめるための理由",
    },
    { cookie: seeded.cookie },
  );
  expect(updated.status).toBe(200);
  const updatedPayload = (await updated.json()) as { comment: Comment };
  expect(updatedPayload.comment.state).toBe(COMMENT_STATES[1]);
  expect(updatedPayload.comment.id).toBe(createdPayload.comment.id);

  // 別の経路(器の直読み)でも同じ値が入っていることを確かめる。
  const rows = rowsInStore();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.state).toBe(COMMENT_STATES[1]);
});

test("V10-M13-T02: 4値目を送ると 400 で、器の行の状態が1バイトも変わらない", async () => {
  const seeded = seedSession(dataRoot, APP_ID, { role: "viewer", username: "u-invalid-state" });
  const created = await post(
    { anchorForm: "app", anchorParts: [], body: "拒否を試す1件" },
    { cookie: seeded.cookie },
  );
  const createdPayload = (await created.json()) as { comment: Comment };

  const res = await post(
    { comment_id: createdPayload.comment.id, state: "done" },
    { cookie: seeded.cookie },
  );
  expect(res.status).toBe(400);
  const payload = (await res.json()) as { errors: { message: string }[] };
  const message = payload.errors.map((e) => e.message).join("\n");
  const missing = COMMENT_STATES.filter((state) => !message.includes(state));
  expect(missing).toEqual([]);

  const rows = rowsInStore();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.state).toBe(COMMENT_STATES[0]);
});

test("V10-M13-T02: 未ログインでは状態を倒せない(401。新しいコメントは今日どおり書ける)", async () => {
  const seeded = seedSession(dataRoot, APP_ID, { role: "viewer", username: "u-anon-target" });
  const created = await post(
    { anchorForm: "app", anchorParts: [], body: "未ログインで倒そうとされる1件" },
    { cookie: seeded.cookie },
  );
  const createdPayload = (await created.json()) as { comment: Comment };

  // 未ログイン(Cookie を1バイトも送らない)で状態を倒そうとすると 401。
  const res = await post({ comment_id: createdPayload.comment.id, state: COMMENT_STATES[2] });
  expect(res.status).toBe(401);
  const rows = rowsInStore();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.state).toBe(COMMENT_STATES[0]);

  // 陽性対照 —— 新しいコメントは今日どおり未ログインで書ける(create 枝は影響を受けていない)。
  const anotherCreate = await post({
    anchorForm: "app",
    anchorParts: [],
    body: "未ログインでも今日どおり書ける",
  });
  expect(anotherCreate.status).toBe(201);
  expect(rowsInStore()).toHaveLength(2);
});

test("V10-M13-T02: 未登録の comment_id は 404", async () => {
  const seeded = seedSession(dataRoot, APP_ID, { role: "viewer", username: "u-404" });
  const res = await post(
    { comment_id: "no-such-comment-id", state: COMMENT_STATES[0] },
    { cookie: seeded.cookie },
  );
  expect(res.status).toBe(404);
  const payload = (await res.json()) as { errors?: { message: string }[] };
  expect(payload.errors?.[0]?.message).toContain("no-such-comment-id");
});

// ---------------------------------------------------------------------------
// `V10-M13-T03`(台帳 `CM-G20`。**門A**(`Δ8`)/ 判定値 = 限定採用。`ADR-0369`)。
// **同じ口に、理由をそのまま渡す枝を足した。** **口は理由を1度も組み立てない**
// —— 本文からそのまま `CommentStore.updateCommentState` の第3引数へ渡すだけである。
// ---------------------------------------------------------------------------

test("V10-M13-T03: 対応できない状態へ倒すとき理由が無いと 400 で、行の状態が1バイトも変わらない", async () => {
  const seeded = seedSession(dataRoot, APP_ID, { role: "viewer", username: "u-t03-no-reason" });
  const created = await post(
    { anchorForm: "app", anchorParts: [], body: "理由なしで倒そうとする1件" },
    { cookie: seeded.cookie },
  );
  const createdPayload = (await created.json()) as { comment: Comment };

  const res = await post(
    { comment_id: createdPayload.comment.id, state: COMMENT_STATES[1] },
    { cookie: seeded.cookie },
  );
  expect(res.status).toBe(400);

  const rows = rowsInStore();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.state).toBe(COMMENT_STATES[0]);
  expect(rows[0]?.reason).toBeNull();

  // 陽性対照 —— 空白だけの理由でも同じく 400。
  const resBlank = await post(
    { comment_id: createdPayload.comment.id, state: COMMENT_STATES[1], reason: "   " },
    { cookie: seeded.cookie },
  );
  expect(resBlank.status).toBe(400);

  // 陽性対照 —— 非空の理由なら 200(値域さえ守れば同じ口が通す)。
  const resOk = await post(
    {
      comment_id: createdPayload.comment.id,
      state: COMMENT_STATES[1],
      reason: "対応できない理由",
    },
    { cookie: seeded.cookie },
  );
  expect(resOk.status).toBe(200);
  const rowsAfterOk = rowsInStore();
  expect(rowsAfterOk[0]?.state).toBe(COMMENT_STATES[1]);
  expect(rowsAfterOk[0]?.reason).toBe("対応できない理由");
});

test("V10-M13-T03: 他の2値に理由を送ると 400", async () => {
  const seeded = seedSession(dataRoot, APP_ID, {
    role: "viewer",
    username: "u-t03-reason-on-other",
  });
  const created = await post(
    { anchorForm: "app", anchorParts: [], body: "他の2値に理由を送る1件" },
    { cookie: seeded.cookie },
  );
  const createdPayload = (await created.json()) as { comment: Comment };

  const res = await post(
    { comment_id: createdPayload.comment.id, state: COMMENT_STATES[0], reason: "なにか" },
    { cookie: seeded.cookie },
  );
  expect(res.status).toBe(400);

  const rows = rowsInStore();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.state).toBe(COMMENT_STATES[0]);
  expect(rows[0]?.reason).toBeNull();

  // 陽性対照 —— 理由を付けずに(この2値のどちらへ)倒すのは 200。
  const resOk = await post(
    { comment_id: createdPayload.comment.id, state: COMMENT_STATES[2] },
    { cookie: seeded.cookie },
  );
  expect(resOk.status).toBe(200);
});

test("V10-M13-T03: validateDiff が返した message を人が理由欄へ写せる（器が自動で写したのではない）", async () => {
  // ① 機械が理由を出す(人がこれを読む)。今日の語彙に無いキーを渡し、拒否の日本語文を得る。
  const result = validateDiff({
    diff_id: "d-t03-http-example",
    intent: "画面に説明文を付けたい(今日の語彙に無いキー)",
    operations: [
      { op: "update_view", view: "book-list", changes: { description: "この画面の説明" } },
    ],
  });
  expect(result.valid).toBe(false);
  const message = result.valid === false ? result.errors[0]?.message : undefined;
  expect(typeof message).toBe("string");
  if (message === undefined) {
    throw new Error("validateDiff が message を返さなかった(テストの前提が崩れている)");
  }

  // ② 人がその文字列を口へ写す(別のコマンドである。ここが「人が写した」の実体)。
  const seeded = seedSession(dataRoot, APP_ID, {
    role: "viewer",
    username: "u-t03-validate-diff",
  });
  const created = await post(
    { anchorForm: "app", anchorParts: [], body: "語彙に無いキーが必要という1件" },
    { cookie: seeded.cookie },
  );
  const createdPayload = (await created.json()) as { comment: Comment };
  const res = await post(
    { comment_id: createdPayload.comment.id, state: COMMENT_STATES[1], reason: message },
    { cookie: seeded.cookie },
  );
  expect(res.status).toBe(200);
  const payload = (await res.json()) as { comment: Comment };
  expect(payload.comment.reason).toBe(message);

  // ③ 器が自動で写す経路が1本も無いこと(comment-store.ts は validateDiff を1度も呼ばない。
  // §6-3 (3) と同じ式)。
  const commentStoreSource = readFileSync(
    join(import.meta.dir, "..", "kernel", "comment-store.ts"),
    "utf-8",
  );
  expect(commentStoreSource.match(/validateDiff/g) ?? []).toHaveLength(0);
});

// ===========================================================================
// `V10-M15-T01`(台帳 `CM-G14`。**門A**(`Δ8`)/ 判定値 = 限定採用。`ADR-0370`)
//
// **同じ1本の口に、差分に繋ぐ枝を足した。** **`comment_id` と `diff_id` が本文に
// 在れば繋ぎ、`state` は今日どおり別枝。** **`state` と `diff_id` は同時に送れない**
// (1回の呼びで2つの列を倒さない)。**繋ぎを書く枝もログイン必須である**(裁定F と同じ扱い)。
//
// ## この節が主張しないこと
//
// 1. **「コメント → 案 → 差分 の3点が繋がった」とは1文字も主張しない。** **繋ぐのは
//    コメント → 差分 の2点である**(中央の「案」に識別子は無い。`CM-G8` = 却下)。
// 2. **差分が実在するかを1ミリも確かめない**(限定4)。**`undo` で取り消された差分を
//    指したままの繋ぎが残る**(限界。下の検査8がそれを実出力で示す)。
// ===========================================================================

/** 最小の差分。`shop` マニフェスト(テーブル0本)に1本だけテーブルを足す。 */
function minimalDiff(diffId: string): Record<string, unknown> {
  return {
    diff_id: diffId,
    intent: "コメントと差分を繋ぐ検査のためのテーブルを1本足す",
    operations: [
      {
        op: "add_table",
        table: {
          id: "notes",
          name: "メモ",
          fields: [{ id: "title", name: "見出し", type: "text", required: true }],
        },
      },
    ],
  };
}

/** owner セッションで `POST /api/apps/:app_id/diffs` を叩く。 */
function postDiff(cookie: string, body: Record<string, unknown>): Promise<Response> {
  return Promise.resolve(
    app.request(
      new Request(`http://localhost/api/apps/${APP_ID}/diffs`, {
        method: "POST",
        headers: { origin: TEST_ORIGIN, "content-type": "application/json", cookie },
        body: JSON.stringify(body),
      }),
    ),
  );
}

test("V10-M15-T01: 同じ POST の口に comment_id と diff_id を送ると繋ぎが入り、201 ではなく 200 が返る", async () => {
  const seeded = seedSession(dataRoot, APP_ID, { role: "owner", username: "u-link-01" });
  const created = await post(
    { anchorForm: "app", anchorParts: [], body: "差分に繋ぐ1件" },
    { cookie: seeded.cookie },
  );
  expect(created.status).toBe(201);
  const createdPayload = (await created.json()) as { comment: Comment };
  expect(createdPayload.comment.diffId).toBeNull();

  const diffRes = await postDiff(seeded.cookie, minimalDiff("d-link-basic"));
  expect(diffRes.status).toBe(201);

  const linked = await post(
    { comment_id: createdPayload.comment.id, diff_id: "d-link-basic" },
    { cookie: seeded.cookie },
  );
  expect(linked.status).toBe(200);
  const linkedPayload = (await linked.json()) as { comment: Comment };
  expect(linkedPayload.comment.id).toBe(createdPayload.comment.id);
  expect(linkedPayload.comment.diffId).toBe("d-link-basic");

  // 別の経路(器の直読み)でも同じ値が入っていることを確かめる。
  const rows = rowsInStore();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.diffId).toBe("d-link-basic");
});

test("V10-M15-T01: 未ログインでは繋ぎを書けない(401。新しいコメントは今日どおり書ける)", async () => {
  const seeded = seedSession(dataRoot, APP_ID, { role: "owner", username: "u-link-anon-target" });
  const created = await post(
    { anchorForm: "app", anchorParts: [], body: "未ログインで繋がれようとする1件" },
    { cookie: seeded.cookie },
  );
  const createdPayload = (await created.json()) as { comment: Comment };
  await postDiff(seeded.cookie, minimalDiff("d-link-anon"));

  // 未ログイン(Cookie を1バイトも送らない)で繋ごうとすると 401。
  const res = await post({ comment_id: createdPayload.comment.id, diff_id: "d-link-anon" });
  expect(res.status).toBe(401);
  const rows = rowsInStore();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.diffId).toBeNull();

  // 陽性対照 —— 新しいコメントは今日どおり未ログインで書ける(create 枝は影響を受けていない)。
  const anotherCreate = await post({
    anchorForm: "app",
    anchorParts: [],
    body: "未ログインでも今日どおり書ける(繋ぎの検査)",
  });
  expect(anotherCreate.status).toBe(201);
  expect(rowsInStore()).toHaveLength(2);
});

test("V10-M15-T01: 未登録の comment_id に繋ぎを書こうとすると 404 で、器に1行も増えない", async () => {
  const seeded = seedSession(dataRoot, APP_ID, { role: "owner", username: "u-link-404" });
  await postDiff(seeded.cookie, minimalDiff("d-link-404"));
  expect(rowsInStore()).toHaveLength(0);

  const res = await post(
    { comment_id: "no-such-comment-id", diff_id: "d-link-404" },
    { cookie: seeded.cookie },
  );
  expect(res.status).toBe(404);
  const payload = (await res.json()) as { errors?: { message: string }[] };
  expect(payload.errors?.[0]?.message).toContain("no-such-comment-id");
  expect(rowsInStore()).toHaveLength(0);
});

test("V10-M15-T01: diff_id と state を同時に送ると 400 で、どちらの列も1バイトも変わらない", async () => {
  const seeded = seedSession(dataRoot, APP_ID, { role: "owner", username: "u-link-conflict" });
  const created = await post(
    { anchorForm: "app", anchorParts: [], body: "両方送る1件" },
    { cookie: seeded.cookie },
  );
  const createdPayload = (await created.json()) as { comment: Comment };
  await postDiff(seeded.cookie, minimalDiff("d-link-conflict"));

  const res = await post(
    {
      comment_id: createdPayload.comment.id,
      diff_id: "d-link-conflict",
      state: COMMENT_STATES[2],
    },
    { cookie: seeded.cookie },
  );
  expect(res.status).toBe(400);

  const rows = rowsInStore();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.diffId).toBeNull();
  expect(rows[0]?.state).toBe(COMMENT_STATES[0]);
});

test("V10-M15-T01: 空白だけの diff_id は 400 で、器の行の diff_id が null のまま変わらない", async () => {
  const seeded = seedSession(dataRoot, APP_ID, { role: "owner", username: "u-link-blank" });
  const created = await post(
    { anchorForm: "app", anchorParts: [], body: "空白だけを送る1件" },
    { cookie: seeded.cookie },
  );
  const createdPayload = (await created.json()) as { comment: Comment };

  const res = await post(
    { comment_id: createdPayload.comment.id, diff_id: "   " },
    { cookie: seeded.cookie },
  );
  expect(res.status).toBe(400);

  const rows = rowsInStore();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.diffId).toBeNull();

  // 陽性対照 —— 実在する差分の識別子なら 200 で通る(同じ口・同じコメント)。
  await postDiff(seeded.cookie, minimalDiff("d-link-blank-ok"));
  const ok = await post(
    { comment_id: createdPayload.comment.id, diff_id: "d-link-blank-ok" },
    { cookie: seeded.cookie },
  );
  expect(ok.status).toBe(200);
});

test("V10-M15-T01: 繋ぎの枝を足しても HTTP の口は 51本のままで、GET は1本も増えていない", () => {
  // **陽性対照は既存の `V10-M11-T01` の2本が既に置いている**(コメントの POST は1本
  // ちょうど・GET は0本)。**本検査は「口の全量が51本のまま」を追加で固定する。**
  //
  // **【`V10-M15-T05`(2026-08-24。台帳 `CM-G21` / `ADR-0370`。**門A** / 限定採用)。
  // 2026-08-24 に `V10-M15-T05` が偽にした】** —— **この工程で GET が1本増え、口の
  // 全量は 51本 → 52本になった。** **テスト名(制定時の記述。`T01` が「51本のまま」を
  // 固定した節)は1バイトも書き換えていない**(`ADR-0007` §6 規律1 と同じ作法。
  // **`BRIEF-M15-T05.md` が名指しした2本(`:320` / `:370` 相当)には本テストは
  // 入っていなかったが、`scanRoutes()` を直接呼ぶ検査であるため、`V10-M15-T05` の
  // 実装後は放置すると赤くなる。同じ作法で打ち直す**)。
  // **旧の期待値(逐語。1バイトも消していない)**:
  //   `expect(scanRoutes()).toHaveLength(51);`
  //   `const reads = scanRoutes().filter(`
  //   `  (entry) => entry.startsWith("GET ") && entry.includes("/comments"),`
  //   `);`
  //   `expect(reads).toEqual([]);`
  expect(scanRoutes()).toHaveLength(52);
  const writes = scanRoutes().filter(
    (entry) => entry.startsWith("POST ") && entry.includes("/comments"),
  );
  expect(writes).toEqual(["POST /api/apps/:app_id/comments"]);
  const reads = scanRoutes().filter(
    (entry) => entry.startsWith("GET ") && entry.includes("/comments"),
  );
  expect(reads).toEqual(["GET /api/apps/:app_id/comments"]);
});

test("V10-M15-T01: コメントの行 → diff_id → 適用の記録の行 の2点を、識別子で繋いで辿れる(3点ではない)", async () => {
  const seeded = seedSession(dataRoot, APP_ID, { role: "owner", username: "u-link-trace" });

  // 1. 差分を1件当てる。
  const diffId = "d-link-trace-01";
  const diffRes = await postDiff(seeded.cookie, minimalDiff(diffId));
  expect(diffRes.status).toBe(201);

  // 2. 既存の口(GET /changelog)で、当てた差分が記録に実在することを採る
  //    (新しい層またぎを1本も作らない)。
  const changelogRes = await app.request(
    new Request(`http://localhost/api/apps/${APP_ID}/changelog`),
  );
  expect(changelogRes.status).toBe(200);
  const changelogPayload = (await changelogRes.json()) as {
    changelog: { diff_id: string }[];
  };
  const changelogEntry = changelogPayload.changelog.find((entry) => entry.diff_id === diffId);
  if (changelogEntry === undefined) {
    throw new Error("changelog に当てた差分のエントリが見つからなかった(前提が崩れている)");
  }

  // 3. コメントを1件書く。
  const created = await post(
    { anchorForm: "app", anchorParts: [], body: "2点を辿る検査" },
    { cookie: seeded.cookie },
  );
  const createdPayload = (await created.json()) as { comment: Comment };

  // 4. 同じ口に繋ぎを送る。
  const linked = await post(
    { comment_id: createdPayload.comment.id, diff_id: diffId },
    { cookie: seeded.cookie },
  );
  expect(linked.status).toBe(200);
  const linkedPayload = (await linked.json()) as { comment: Comment };

  // 5. 器の行の diffId と、changelog の行の diff_id が1バイトも違わないことを示す
  //    (辿った3つの値を逐語で残す)。
  expect(linkedPayload.comment.id).toBe(createdPayload.comment.id);
  expect(linkedPayload.comment.diffId).toBe(diffId);
  expect(changelogEntry.diff_id).toBe(diffId);
  expect(linkedPayload.comment.diffId).toBe(changelogEntry.diff_id);

  // 6. 中央の「案」の識別子が存在しないこと(器の列名に proposal が0件)。
  const commentStoreSource = readFileSync(
    join(import.meta.dir, "..", "kernel", "comment-store.ts"),
    "utf-8",
  );
  expect((commentStoreSource.match(/proposal/g) ?? []).length).toBe(0);
});

test("V10-M15-T01: undo で取り消した差分を指したままの繋ぎが残る(器は取り消しに追随しない。限界)", async () => {
  const seeded = seedSession(dataRoot, APP_ID, { role: "owner", username: "u-link-undo" });

  const diffId = "d-link-undo-target";
  const diffRes = await postDiff(seeded.cookie, minimalDiff(diffId));
  expect(diffRes.status).toBe(201);

  const created = await post(
    { anchorForm: "app", anchorParts: [], body: "取り消される差分に繋ぐ1件" },
    { cookie: seeded.cookie },
  );
  const createdPayload = (await created.json()) as { comment: Comment };

  const linked = await post(
    { comment_id: createdPayload.comment.id, diff_id: diffId },
    { cookie: seeded.cookie },
  );
  expect(linked.status).toBe(200);
  const linkedPayload = (await linked.json()) as { comment: Comment };
  expect(linkedPayload.comment.diffId).toBe(diffId);

  // **差分を取り消す**(器は changelog を1度も読まないので、この undo に1ミリも追随しない)。
  const undoRes = await app.request(
    new Request(`http://localhost/api/apps/${APP_ID}/undo`, {
      method: "POST",
      headers: { origin: TEST_ORIGIN, "content-type": "application/json", cookie: seeded.cookie },
      body: JSON.stringify({}),
    }),
  );
  expect(undoRes.status).toBe(200);

  // **限界の実出力**: undo の後も、コメントの行は取り消された diffId を指したままである。
  const rows = rowsInStore();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.diffId).toBe(diffId);
});

// ===========================================================================
// `V10-M15-T05`(台帳 `CM-G21` / `ADR-0370`。**門A** / 判定値 = 限定採用)。
// **対応できないまま残ったコメントを一覧する読出の口を1本作る**
// (`GET /api/apps/:app_id/comments`)。
//
// > **クエリは `state` だけ**(任意。省略すると全部)。**`limit` / `offset` を置かない**
// > (量の歯止めが1つも無いことを限界に書く)。**応答は `200` で
// > `{ comments, total }`。`total` は絞ったあとの長さ**(母集団を割らない)。
// > **必ず `visibleComments` を通す。** **削除・編集・状態を変える機能を1つも持たない。**
// ===========================================================================

test("V10-M15-T05: 書いた本人でない相手が、対応できない状態のコメントを一覧できる(実 HTTP の 200 と本文)", async () => {
  const writer = seedSession(dataRoot, APP_ID, { role: "viewer", username: "u-t05-writer" });
  const owner = seedSession(dataRoot, APP_ID, { role: "owner", username: "u-t05-owner" });
  expect(writer.userId).not.toBe(owner.userId);

  const created = await post(
    { anchorForm: "app", anchorParts: [], body: "今日の語彙では対応できない要望" },
    { cookie: writer.cookie },
  );
  expect(created.status).toBe(201);
  const createdPayload = (await created.json()) as { comment: Comment };

  // **書いた本人ではない相手(owner)が、同じ口の update 枝で対応できない値へ倒す。**
  const updated = await post(
    {
      comment_id: createdPayload.comment.id,
      state: COMMENT_STATES[1],
      reason: "今日の語彙では対応できません",
    },
    { cookie: owner.cookie },
  );
  expect(updated.status).toBe(200);

  // **一覧するのも書いた本人(writer)ではない相手(owner)である。**
  const res = await get({ cookie: owner.cookie, query: `state=${COMMENT_STATES[1]}` });
  expect(res.status).toBe(200);
  const payload = (await res.json()) as { comments: Comment[]; total: number };
  expect(payload.total).toBe(1);
  expect(payload.comments).toHaveLength(1);
  expect(payload.comments[0]?.id).toBe(createdPayload.comment.id);
  expect(payload.comments[0]?.state).toBe(COMMENT_STATES[1]);
});

test("V10-M15-T05: 入れた本文が1バイトも変わらずに返る(逐語で突き合わせる)", async () => {
  const writer = seedSession(dataRoot, APP_ID, { role: "viewer", username: "u-t05-verbatim-w" });
  const owner = seedSession(dataRoot, APP_ID, { role: "owner", username: "u-t05-verbatim-o" });
  const body = "改行\nタブ\t絵文字🎯記号!@#$%^&*()を含む本文。空白  も  含む。";
  const created = await post(
    { anchorForm: "app", anchorParts: [], body },
    { cookie: writer.cookie },
  );
  const createdPayload = (await created.json()) as { comment: Comment };
  await post(
    { comment_id: createdPayload.comment.id, state: COMMENT_STATES[1], reason: "逐語確認用" },
    { cookie: owner.cookie },
  );
  const res = await get({ cookie: owner.cookie, query: `state=${COMMENT_STATES[1]}` });
  const payload = (await res.json()) as { comments: Comment[] };
  expect(payload.comments[0]?.body).toBe(body);
  expect(payload.comments[0]?.body.length).toBe(body.length);
});

test("V10-M15-T05: 未ログインは 401 である(読取を1ミリも開けていない)", async () => {
  const res = await get();
  expect(res.status).toBe(401);
});

test("V10-M15-T05: 見えない相手には0件が返り、total も 0 である(母集団を割らない)", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner", username: "u-t05-pop-owner" });
  await post(
    { anchorForm: "app", anchorParts: [], body: "見えない側のテスト1" },
    { cookie: owner.cookie },
  );
  await post(
    { anchorForm: "app", anchorParts: [], body: "見えない側のテスト2" },
    { cookie: owner.cookie },
  );
  expect(rowsInStore()).toHaveLength(2);

  // **`viewer` は役割の規則を1本も持たない**(`viewerCookie` と同じ形)。
  const viewer = seedSession(dataRoot, APP_ID, { role: "viewer", username: "u-t05-pop-viewer" });
  const res = await get({ cookie: viewer.cookie });
  expect(res.status).toBe(200);
  const payload = (await res.json()) as { comments: Comment[]; total: number };
  expect(payload.comments).toEqual([]);
  expect(payload.total).toBe(0);
});

test("V10-M15-T05: 値域に無い state は 400 で、器の文面がそのまま返る", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner", username: "u-t05-badstate" });
  const res = await get({ cookie: owner.cookie, query: "state=done" });
  expect(res.status).toBe(400);
  const payload = (await res.json()) as { errors: { message: string }[] };
  const message = payload.errors.map((e) => e.message).join("\n");
  // **手で焼いた3値に依らない** —— **登録簿(`COMMENT_STATES`)から導く。**
  const missing = COMMENT_STATES.filter((state) => !message.includes(state));
  expect(missing).toEqual([]);
});

test("V10-M15-T05: 実在しないアプリは 404", async () => {
  const res = await get({ path: "/api/apps/no-such-app/comments" });
  expect(res.status).toBe(404);
  const payload = (await res.json()) as { errors?: { message: string }[] };
  expect(payload.errors?.[0]?.message).toContain("no-such-app");
});

test("V10-M15-T05: この口は削除・編集・状態を変える機能を1つも持たない(同じパスの PATCH / DELETE / PUT が 404)", async () => {
  for (const method of ["PATCH", "DELETE", "PUT"]) {
    const res = await app.request(
      new Request(`http://localhost${PATH}`, { method, headers: { origin: TEST_ORIGIN } }),
    );
    expect(res.status, method).toBe(404);
  }
});

test("V10-M15-T05: 状態で「対応できない」と「まだ着手していない」を区別して一覧できる", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner", username: "u-t05-distinguish" });
  const openOne = await post(
    { anchorForm: "app", anchorParts: [], body: "まだ着手していない要望" },
    { cookie: owner.cookie },
  );
  const openPayload = (await openOne.json()) as { comment: Comment };
  const naOne = await post(
    { anchorForm: "app", anchorParts: [], body: "対応できない要望" },
    { cookie: owner.cookie },
  );
  const naPayload = (await naOne.json()) as { comment: Comment };
  await post(
    { comment_id: naPayload.comment.id, state: COMMENT_STATES[1], reason: "対応できない理由" },
    { cookie: owner.cookie },
  );

  const openRes = await get({ cookie: owner.cookie, query: `state=${COMMENT_STATES[0]}` });
  const openBody = (await openRes.json()) as { comments: Comment[]; total: number };
  expect(openBody.comments.map((c) => c.id)).toEqual([openPayload.comment.id]);
  expect(openBody.total).toBe(1);

  const naRes = await get({ cookie: owner.cookie, query: `state=${COMMENT_STATES[1]}` });
  const naBody = (await naRes.json()) as { comments: Comment[]; total: number };
  expect(naBody.comments.map((c) => c.id)).toEqual([naPayload.comment.id]);
  expect(naBody.total).toBe(1);
});

test("V10-M15-T05: state を省くと3値すべてが返る(絞りは口が持ち、可視性は合成が持つ)", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner", username: "u-t05-allstates" });
  const ids: string[] = [];
  for (const state of COMMENT_STATES) {
    const created = await post(
      { anchorForm: "app", anchorParts: [], body: `${state} の1件` },
      { cookie: owner.cookie },
    );
    const payload = (await created.json()) as { comment: Comment };
    ids.push(payload.comment.id);
    if (state !== COMMENT_STATES[0]) {
      const updateBody: Record<string, unknown> = { comment_id: payload.comment.id, state };
      if (state === COMMENT_STATES[1]) {
        updateBody.reason = "3値すべてが返るかを確かめる理由";
      }
      await post(updateBody, { cookie: owner.cookie });
    }
  }
  const res = await get({ cookie: owner.cookie });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { comments: Comment[]; total: number };
  expect(body.total).toBe(3);
  expect(body.comments.map((c) => c.id).sort()).toEqual([...ids].sort());
  expect(body.comments.map((c) => c.state).sort()).toEqual([...COMMENT_STATES].sort());
});
// ---------------------------------------------------------------------------
// (7) `V10-M27-T02` —— 規則を1本も書いていないアプリの読出の口を、未ログインに開く
//     (`ADR-0375`)
// ---------------------------------------------------------------------------
//
// **開く条件は2つの `AND` である**(`comment-visibility.ts` の `declaresNoRules`)——
// **(i) 定義が読めていること / (ii) 役割の規則の要素の総数が 0 であること。**
// **口は条件式を1つも持たない** —— **呼ぶのは合成が公開している述語1本だけである。**
//
// **【この節が主張しないこと】** **「未ログインに全部のアプリのコメントを開いた」とは
// 1文字も主張しない。** **規則が1本でも在るアプリは今日どおり 401 である**(下の陽性対照)。

/** **役割の宣言を1つも持たないアプリ**(`roles` を省略する)。 */
const UNRULED_APP_ID = "kiosk";
const UNRULED_PATH = `/api/apps/${UNRULED_APP_ID}/comments`;

/**
 * 規則ゼロのアプリを1本立てる。**`create_app` は持ち主に2行入れるので、`applyManifest` で
 * `roles` を省いた定義に差し替える** —— **これは「役割の宣言を落とした古いアプリ」と
 * 同じ形である**(`set_roles` を1度も打っていないアプリ)。
 * **`roles` を書いたうえで規則だけを空にすることは、今日の適用時検査(持ち主に2行必須)が
 * 拒む** —— **したがって規則ゼロに到達できる形はこれ1つである。**
 */
function seedUnruledApp(): void {
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "売店", { app_id: UNRULED_APP_ID });
  } finally {
    store.close();
  }
  const unruled = {
    app: { id: UNRULED_APP_ID, name: "売店", tables: [], views: [] },
  } as unknown as Manifest;
  expect(applyManifest(dataRoot, UNRULED_APP_ID, unruled).valid).toBe(true);
}

/** 規則ゼロのアプリの器を直読みする(HTTP と別経路で数えるため)。 */
function unruledRowsInStore(): Comment[] {
  const store = CommentStore.openForKernel(dataRoot);
  try {
    return store.listComments(UNRULED_APP_ID);
  } finally {
    store.close();
  }
}

test("V10-M27-T02: 規則ゼロのアプリでは Cookie を1バイトも送らない GET が 200 で、total が器の行数と一致する", async () => {
  seedUnruledApp();
  // 未ログインで3件書く(読めることを測る母集団を空にしない)。
  for (const body of ["1件目", "2件目", "3件目"]) {
    expect(
      (await post({ anchorForm: "app", anchorParts: [], body }, { path: UNRULED_PATH })).status,
    ).toBe(201);
  }
  const rows = unruledRowsInStore();
  expect(rows).toHaveLength(3);

  const res = await get({ path: UNRULED_PATH });
  expect(res.status).toBe(200);
  const payload = (await res.json()) as { comments: Comment[]; total: number };
  expect(payload.total).toBe(3);
  expect(payload.comments).toEqual(rows);
});

test("V10-M27-T02: 規則ゼロのアプリでは、ログイン済みの利用者にも同じ全件が返る", async () => {
  seedUnruledApp();
  expect(
    (
      await post(
        { anchorForm: "app", anchorParts: [], body: "未ログインの1件" },
        { path: UNRULED_PATH },
      )
    ).status,
  ).toBe(201);
  const cookie = seedSession(dataRoot, UNRULED_APP_ID, {
    role: "viewer",
    username: "u-unruled-viewer",
  }).cookie;
  const res = await get({ path: UNRULED_PATH, cookie });
  expect(res.status).toBe(200);
  const payload = (await res.json()) as { comments: Comment[]; total: number };
  expect(payload.total).toBe(1);
  expect(payload.comments).toEqual(unruledRowsInStore());
});

test("V10-M27-T02: 陽性対照 —— 規則が在るアプリの GET は、今日どおり Cookie 無しで 401 である", async () => {
  // 同じサーバ・同じ実行で、規則ゼロのアプリと規則の在るアプリを並べて叩く。
  seedUnruledApp();
  expect((await get({ path: UNRULED_PATH })).status).toBe(200);
  const ruled = await get();
  expect(ruled.status).toBe(401);
  // **塞ぎを緩めていない** —— 書き換えの口は規則ゼロのアプリでも今日どおり 401 である。
  const diffs = await app.request(
    new Request(`http://localhost/api/apps/${UNRULED_APP_ID}/diffs`, {
      method: "POST",
      headers: { origin: TEST_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
  );
  expect(diffs.status).toBe(401);
});

test("V10-M27-T02: 口は1本も増えていない(/comments の経路は GET と POST の2本のまま)", () => {
  expect(
    scanRoutes()
      .filter((entry) => entry.includes("/comments"))
      .sort(),
  ).toEqual(["GET /api/apps/:app_id/comments", "POST /api/apps/:app_id/comments"]);
});
