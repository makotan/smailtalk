/**
 * **積まれたコメントを1枚のパネルで読み返す導線**の描画テスト(`V10-M32-T01`)。
 *
 * ## この検査が主張すること
 *
 * > **ログインした人が、そのアプリで自分に見えるコメントを、ブラウザの1枚のパネルで読み返せる。**
 * > **読む先は `GET /api/apps/:app_id/comments`(`V10-M15-T05` / `CM-G21` が
 * > `src/server/auth-routes.ts` に足した口)の1本だけである。**
 *
 * ## この検査が主張**しない**こと(**先に書く。丸めない**)
 *
 * 1. **「画面が絞っている」とは1文字も主張しない。** **読める範囲を決めるのは
 *    `src/server/comment-visibility.ts` の可視集合1本だけであり、この画面は
 *    サーバが返した配列を返ってきた順にそのまま並べる。** 下の (g) と (j) がそれを測る。
 * 2. **「出し入れ(ON/OFF)が効く」とは1文字も主張しない。** **本工程では出し入れを
 *    1バイトも掛けておらず、導線は常に出る。** **掛けるのは `V10-M32-T02` である。**
 * 3. **「状態を変えられる」とは1文字も主張しない。** **承認画面(`CM-G13`)は門A で
 *    却下されており、このパネルは状態を変える口を1つも持たない。**
 *
 * ## 【`V10-M32-T02`(2026-08-26)。台帳 `CM-G40`】**上の 2. は今日の正ではない**
 *
 * **上の 1.〜3. は1バイトも書き換えていない**(制定時の記述としてそのまま残す)。
 * **今日は 2. だけが偽である** —— **`comment_visibility.read` の設定で導線を出し入れする
 * ようになった。** **「本工程では出し入れを1バイトも掛けておらず、導線は常に出る」は
 * 2026-08-25 の `V10-M32-T01` の時点の記述であり、今日は次のとおりである:**
 *
 * - **設定が OFF なら `open-comment-list` は0要素である**((k))。**ON なら1要素**((l)。陽性対照)。
 * - **provider の外・設定が届いていない、のどちらでも出さない**((m) / (m-2)。fail-closed)。
 * - **`write` と `read` は別である**((n))。
 * - **OFF のときは開く経路が消えるだけでなく、三項連鎖の枝そのものが出ない**((o))。
 *
 * **1. と 3. は今日も真である。**
 *
 * ## **【誇張しない】これは書込も読取も止める壁ではない**(`D-V10-38`)
 *
 * **止まるのは画面に出すことだけである** —— **`GET /api/apps/:app_id/comments` も
 * MCP の `list_comments` も1バイトも閉じていない。** **設定が OFF のままでも
 * `listComments` を直に叩けば今日どおり応答が返る**((p) がそれを実測する)。
 *
 * ## 【`V10-M32-T03`(2026-08-26)】**`CommentList.tsx` の doc を守る検査を足さなかった**
 *
 * **本ファイルは1本も検査を増やしていない。** **足さないことも判断なので、理由を残す。**
 *
 * **`V10-M32-T03` は `web/src/CommentList.tsx` の doc にあった3文
 * (「この導線は、ログインしていれば常に出る」ほか)を訂正した。**
 * **その訂正が「今日の正」であり続けることを走査で守る検査を考えたが、**
 * **次の2点で、書いても赤くならないか、生まれた時点で偽になる:**
 *
 * 1. **「古い文が無いこと」を数える形は作れない。** **このリポジトリの作法は
 *    「本文を1バイトも消さず、後ろに訂正を足す」であり、古い3文は今日も
 *    `CommentList.tsx` に逐語で残っている**(消したら作法違反である)。
 *    **したがって古い綴りを `grep` する検査は、正しく訂正されている今日も赤くなる** ——
 *    **生まれた時点で偽である**(この型の事故はこのリポジトリで既に出ている)。
 * 2. **「訂正の文が在ること」を数える形は、赤くなる理由を持たない。**
 *    **`V10-M32-T03` という綴りが1つ在ることを固定しても、doc が実装とずれた日に
 *    その綴りは在るままである** —— **嘘になるのはテスト名だけで、検査は緑のままになる。**
 *
 * **代わりに、doc が主張している中身の方は既に別の検査が数で押さえている:**
 *
 * - **「設定が OFF なら導線も枝も出ない」** —— **(k) / (m) / (m-2) / (o)。**
 * - **「`write` と `read` は別」** —— **(n)。**
 * - **「口は閉じていない」** —— **(p)。**
 * - **「本物のブラウザでも同じ」** —— **`web/e2e/comment-read.e2e.ts` の2〜4本目。**
 *
 * **つまり、doc の文が実装からずれた日に赤くなるのは、doc を走査する検査ではなく
 * この5本である** —— **doc の文言そのものを守る検査は足さない。**
 * **【正直に書く】その帰結として、「doc の文言だけが古くなる」ことを止める仕掛けは
 * 今日1つも無い**(このリポジトリで繰り返し出ている型であり、隠さずに書いておく)。
 *
 * ## 【`V10-M32-T04`(2026-08-26)】**直前の節の「1本も検査を増やしていない」は今日の正ではない**
 *
 * **上の節を1バイトも消していない。** **旧の逐語はこの1文である:**
 *
 * > **「本ファイルは1本も検査を増やしていない。」**
 *
 * **これは `V10-M32-T03` の時点の記述であり、本工程(`V10-M32-T04`)が偽にした** ——
 * **独立点検が実物の上で見つけた5件を直すために、9本足した**((q) / (q-2) / (r) / (s) /
 * (t) / (u) / (u-1) / (u-2) / (u-3))。**直前の節が「足さない」と書いた対象は
 * 「`CommentList.tsx` の doc の文言そのものを走査で守る検査」であって、そちらは今日も0本である**
 * (足した9本はどれも doc の綴りを `grep` していない)。
 *
 * **足した9本が主張すること:**
 *
 * - **応答に `comments` が1本も無い 200 でも画面が丸ごと消えず、統一のエラー表示が1つ出る**((q)。陽性対照 = (q-2))。
 * - **走査(`stripComments`)は `//` から行末までだけを落とし、同じ行の実コードを食わない**((r))。
 * - **(j) の検出器そのものに陽性対照が掛かっている**((s)。4本の needle が合成した題材で非0)。
 * - **部品を持たない宛先は形の名前ちょうどが出る**((t))。
 * - **`reason` の欠落と、器が知らない `state` を黙って消さない**((u) / (u-2)。陽性対照 = (u-1) / (u-3))。
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Manifest } from "../../src/kernel/types.ts";
import { App } from "../src/App.tsx";
// **【`V10-M32-T02`】旧(逐語。1バイトも消していない)**:
//   `import type { CommentSummary } from "../src/api.ts";`
// **(p) が読む口を直に叩くので、型だけでなく値(`listComments`)も1本 import する。**
// **`src/kernel/` からの値の import は1本も増えていない**(`scripts/kernel-import-drift.test.ts`
// の基準ファイルを1行も動かさない)。
import { type CommentSummary, listComments } from "../src/api.ts";
import { CommentList } from "../src/CommentList.tsx";
// **【2026-08-26。`V10-M33-T01`。台帳 `CM-G43`】書く欄の部品は、器へ静的 `import` では
// なくコンテキストのスロット(`CommentVisibilityProvider` の `panel`)で渡すようになった
// (**配る版の成果物から書く欄のバイト列を落とすため**)。**`panel` は必須なので、この器を
// 張る検査はここでも部品を渡す** —— **渡さないと「設定が ON なら書く欄が1要素である」の
// 陽性対照が測れなくなる。** **測るものを1ミリも弱めていない**(製品では
// `web/src/AppWorkspace.tsx` が同じ `CommentPanel` を渡している)。
import { CommentPanel } from "../src/CommentPanel.tsx";
import { CommentVisibilityProvider, useCommentReadEnabled } from "../src/views/ViewHost.tsx";

const APP_ID = "sample-app";
const COMMENTS_PATH = `/api/apps/${APP_ID}/comments`;
const WEB_SRC = join(import.meta.dir, "..", "src");

/**
 * **応答の並び**。**`createdAt` の順でも `id` の順でもない** —— **画面が並べ替えて
 * いないことを測るために、わざと崩してある。**
 */
const COMMENTS: CommentSummary[] = [
  {
    id: "c-3",
    appId: APP_ID,
    anchorForm: "view",
    anchorParts: ["note-list"],
    body: "3番目に作られたのに、応答では先頭に来る",
    createdAt: "2026-08-26T03:00:00.000Z",
    writer: "bob",
    state: "not_applicable",
    reason: "この画面は仕様どおりです。",
    diffId: null,
  },
  {
    id: "c-1",
    appId: APP_ID,
    anchorForm: "view_field",
    anchorParts: ["note-list", "title"],
    body: "1行目\n2行目",
    createdAt: "2026-08-26T01:00:00.000Z",
    writer: null,
    state: "open",
    reason: null,
    diffId: null,
  },
  {
    id: "c-2",
    appId: APP_ID,
    anchorForm: "app",
    anchorParts: [],
    body: "当てた分",
    createdAt: "2026-08-26T02:00:00.000Z",
    writer: "carol",
    state: "applied",
    reason: null,
    diffId: "d-9",
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sampleManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "サンプル",
      tables: [
        {
          id: "notes",
          name: "メモ",
          fields: [{ id: "title", name: "タイトル", type: "text", required: true }],
        },
      ],
      views: [{ id: "note-list", type: "list_view", table: "notes", columns: ["title"] }],
    },
  };
}

let responses: Map<string, [number, unknown]>;
let seen: { method: string; url: string }[];
let originalFetch: typeof fetch;

beforeEach(() => {
  responses = new Map();
  seen = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    seen.push({ method, url });
    const stubbed = responses.get(`${method} ${url}`);
    if (stubbed !== undefined) {
      return jsonResponse(stubbed[1], stubbed[0]);
    }
    if (method === "GET" && url === COMMENTS_PATH) {
      // **`total` は可視集合の長さである**(母集団ではない)。画面はこの値を1度も使わない。
      return jsonResponse({ comments: COMMENTS, total: COMMENTS.length }, 200);
    }
    return jsonResponse({ errors: [{ path: "", message: `no stub for ${method} ${url}` }] }, 404);
  }) as typeof fetch;
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// (a) 読み込み中
// ---------------------------------------------------------------------------

test("(a) V10-M32-T01: 取りに行っているあいだは読み込み中の骨組みが出る", () => {
  render(<CommentList appId={APP_ID} />);
  expect(screen.getByTestId("comment-list").textContent).toContain("読み込み中");
  expect(document.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(3);
});

// ---------------------------------------------------------------------------
// (b) 応答の順序をそのまま保つ
// ---------------------------------------------------------------------------

test("(b) V10-M32-T01: 応答の3件が、返ってきた順のまま3件描かれる", async () => {
  render(<CommentList appId={APP_ID} />);
  await waitFor(() => expect(screen.getAllByTestId("comment-list-item")).toHaveLength(3));

  const ids = screen
    .getAllByTestId("comment-list-item")
    .map((element) => element.getAttribute("data-comment-id"));
  // **期待値は応答そのものから導く**(並びをこのファイルに焼き込まない)。
  expect(ids).toEqual(COMMENTS.map((comment) => comment.id));
  // **応答は `createdAt` 昇順にも `id` 昇順にもなっていない**(題材が崩れていないことの確認)。
  expect(ids).not.toEqual([...COMMENTS].sort((a, b) => a.id.localeCompare(b.id)).map((c) => c.id));
});

// ---------------------------------------------------------------------------
// (c) 0件
// ---------------------------------------------------------------------------

test("(c) V10-M32-T01: 0件のときは、黙って空にせず1件も無いと出す", async () => {
  responses.set(`GET ${COMMENTS_PATH}`, [200, { comments: [], total: 0 }]);
  render(<CommentList appId={APP_ID} />);
  await waitFor(() => expect(screen.getAllByTestId("comment-list-empty")).toHaveLength(1));
  expect(screen.getByTestId("comment-list-empty").textContent).toContain(
    "まだコメントは1件もありません。",
  );
  expect(screen.queryAllByTestId("comment-list-item")).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// (d) 名乗りなし
// ---------------------------------------------------------------------------

test("(d) V10-M32-T01: 書いた人が `null` の行は「(名乗りなし)」と出る", async () => {
  render(<CommentList appId={APP_ID} />);
  await waitFor(() => expect(screen.getAllByTestId("comment-list-item")).toHaveLength(3));

  const anonymous = document.querySelector('[data-comment-id="c-1"]');
  expect(anonymous).not.toBeNull();
  expect(anonymous?.querySelector('[data-testid="comment-item-writer"]')?.textContent).toBe(
    "(名乗りなし)",
  );
  // **名乗りがある行はその文字列がそのまま出る**(陽性対照)。
  const named = document.querySelector('[data-comment-id="c-2"]');
  expect(named?.querySelector('[data-testid="comment-item-writer"]')?.textContent).toBe("carol");
});

// ---------------------------------------------------------------------------
// (e) 状態の3値
// ---------------------------------------------------------------------------

test("(e) V10-M32-T01: 3値の状態がそれぞれ日本語で出る", async () => {
  render(<CommentList appId={APP_ID} />);
  await waitFor(() => expect(screen.getAllByTestId("comment-list-item")).toHaveLength(3));

  const labelOf = (id: string): string | undefined =>
    document.querySelector(`[data-comment-id="${id}"] [data-testid="comment-item-state"]`)
      ?.textContent ?? undefined;
  expect(labelOf("c-1")).toBe("未対応");
  expect(labelOf("c-3")).toBe("対応できない");
  expect(labelOf("c-2")).toBe("当てた");
  // **器の綴りは属性に残す**(表示の言葉と、器の値を混ぜない)。
  expect(document.querySelector('[data-comment-id="c-3"]')?.getAttribute("data-state")).toBe(
    "not_applicable",
  );
});

// ---------------------------------------------------------------------------
// (f) 理由
// ---------------------------------------------------------------------------

test("(f) V10-M32-T01: 理由は非 `null` の行にだけ出る", async () => {
  render(<CommentList appId={APP_ID} />);
  await waitFor(() => expect(screen.getAllByTestId("comment-list-item")).toHaveLength(3));

  expect(
    document.querySelectorAll('[data-comment-id="c-1"] [data-testid="comment-item-reason"]'),
  ).toHaveLength(0);
  expect(
    document.querySelectorAll('[data-comment-id="c-3"] [data-testid="comment-item-reason"]'),
  ).toHaveLength(1);
  expect(
    document.querySelector('[data-comment-id="c-3"] [data-testid="comment-item-reason"]')
      ?.textContent,
  ).toContain("この画面は仕様どおりです。");
  // **理由を持つ行は、応答の中で1件だけである**(件数を焼き込まない)。
  expect(screen.getAllByTestId("comment-item-reason")).toHaveLength(
    COMMENTS.filter((comment) => comment.reason !== null).length,
  );
});

// ---------------------------------------------------------------------------
// (g) 画面が1件も落としていない
// ---------------------------------------------------------------------------

test("(g) V10-M32-T01: 状態も書いた人も混ざった応答から、画面は1件も落とさない", async () => {
  render(<CommentList appId={APP_ID} />);
  await waitFor(() => expect(screen.getAllByTestId("comment-list-item")).toHaveLength(3));

  // **題材に「対応できない」の行と「別人が書いた」行が混ざっている**ことを先に固定する。
  expect(COMMENTS.some((comment) => comment.state === "not_applicable")).toBe(true);
  expect(new Set(COMMENTS.map((comment) => comment.writer)).size).toBeGreaterThan(1);

  const rendered = new Set(
    screen
      .getAllByTestId("comment-list-item")
      .map((element) => element.getAttribute("data-comment-id")),
  );
  expect(rendered).toEqual(new Set(COMMENTS.map((comment) => comment.id)));
  // **宛先も1つも丸めない**(形と部品をつないだ文字列がそのまま出る)。
  expect(
    document.querySelector('[data-comment-id="c-1"] [data-testid="comment-item-anchor"]')
      ?.textContent,
  ).toBe("view_field / note-list / title");
  // **日時は整形しない**(器が返した文字列そのまま)。
  expect(
    document.querySelector('[data-comment-id="c-1"] [data-testid="comment-item-created-at"]')
      ?.textContent,
  ).toBe("2026-08-26T01:00:00.000Z");
});

// ---------------------------------------------------------------------------
// (h) 取りに行くのは1回だけ
// ---------------------------------------------------------------------------

test("(h) V10-M32-T01: コメントを取りに行くのはちょうど1回で、2本目の経路が無い", async () => {
  render(<CommentList appId={APP_ID} />);
  await waitFor(() => expect(screen.getAllByTestId("comment-list-item")).toHaveLength(3));

  const reads = seen.filter((entry) => entry.method === "GET" && entry.url.includes("/comments"));
  expect(reads).toHaveLength(1);
  expect(reads[0]?.url).toBe(COMMENTS_PATH);
  // **書込の口を1度も叩かない**(このパネルは読むだけである)。
  expect(seen.filter((entry) => entry.method !== "GET")).toEqual([]);
});

test("(h-2) V10-M32-T01: エラーはサーバの統一文面をそのまま出す", async () => {
  responses.set(`GET ${COMMENTS_PATH}`, [
    401,
    { errors: [{ path: "", message: "ログインしてください。" }] },
  ]);
  render(<CommentList appId={APP_ID} />);
  await waitFor(() => expect(document.body.textContent).toContain("ログインしてください。"));
  expect(screen.queryAllByTestId("comment-list-item")).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// (i) 器に配線されている
// ---------------------------------------------------------------------------

/**
 * **アプリごとの設定**。**`"absent"` は「応答に `comment_visibility` が1本も載っていない」
 * 場合である** —— **合成したマニフェストや古いサーバから来る形の実測であり、(m-2) が見るのは
 * これである。**
 */
type Visibility = { write: boolean; read: boolean } | "absent";

/**
 * **【`V10-M32-T02`(2026-08-26)】設定を1つ受け取れるようにした。**
 *
 * **旧(逐語。1バイトも消していない)**:
 *
 * ```
 * function renderAppAs(role: "owner" | "editor" | "viewer") {
 *   …
 *   responses.set(`GET /api/apps/${APP_ID}/manifest`, [200, sampleManifest()]);
 *   …
 * }
 * ```
 *
 * **既定を `{ write: false, read: true }` にしたのは、既に在る (i) / (i-2) が測っていた
 * 「3つの立場すべてで導線が出る」を1本も落とさないためである** —— **今日はそこに
 * 「設定が ON なら」という条件が1つ増えた。** **OFF 側は (k) が測る。**
 * **既定の `write` を `false` にしてあるのは、この検査が書く欄について1つも主張しないためである。**
 */
function renderAppAs(
  role: "owner" | "editor" | "viewer",
  visibility: Visibility = { write: false, read: true },
) {
  window.history.replaceState({}, "", `/apps/${APP_ID}`);
  responses.set(`GET /api/apps/${APP_ID}/auth/me`, [
    200,
    { user: { id: "u1", username: "alice", displayName: null, role } },
  ]);
  responses.set(`GET /api/apps/${APP_ID}/manifest`, [
    200,
    visibility === "absent"
      ? sampleManifest()
      : { ...sampleManifest(), comment_visibility: visibility },
  ]);
  return render(<App />);
}

// **運営者だけに絞っていない**ので、3つの立場すべてで導線が出ることを見る。
// **【`V10-M32-T02`(2026-08-26)】上の1行は1バイトも消していない。** **今日も運営者だけに
// 絞っていない** —— **足したのは「アプリごとの設定が ON なら」という条件1つだけである。**
// **したがって (i) / (i-2) は今日「設定 ON のときに3つの立場すべてで出る」を測る検査である**
// (`renderAppAs` の既定が `{ write: false, read: true }`)。**OFF 側は (k) が測る。**
for (const role of ["owner", "editor", "viewer"] as const) {
  test(`(i) V10-M32-T01: ${role} にもコメントの導線が出る`, async () => {
    renderAppAs(role);
    await waitFor(() => expect(screen.getByTestId("open-comment-list")).toBeDefined());
  });
}

test("(i-2) V10-M32-T01: 導線を押すとコメントのパネルが開き、閉じると画面一覧に戻る", async () => {
  renderAppAs("viewer");
  await waitFor(() => expect(screen.getByTestId("open-comment-list")).toBeDefined());
  fireEvent.click(screen.getByTestId("open-comment-list"));
  await waitFor(() => expect(screen.getByTestId("comment-list")).toBeDefined());
  await waitFor(() => expect(screen.getAllByTestId("comment-list-item")).toHaveLength(3));
  fireEvent.click(screen.getByTestId("close-comment-list"));
  await waitFor(() => expect(screen.getByTestId("view-list")).toBeDefined());
});

// ---------------------------------------------------------------------------
// (j) 完了条件2 の走査 —— 画面に条件式が1行も無い
// ---------------------------------------------------------------------------

/**
 * **コメントを落とす**(逐語の残置が走査を騙す先例が3度出ているので、必ず先に落とす)。
 *
 * **文字列リテラルの中の `//` は落とさない** —— 当て先の2本にも陽性対照にも
 * URL リテラルが1つも無いことを、下の検査が件数で確かめている。
 */
// **【`V10-M32-T04`(2026-08-26)。独立点検の指摘2】すぐ上の doc も旧の本体も1バイトも消していない。**
//
// **旧の本体(逐語)**:
//   `return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\n)[^\n]*?\/\/[^\n]*/g, "$1");`
//
// **旧の2本目は「行頭から `//` の先まで」を丸ごと落としていた** —— **`//` の**前**にある実コードも
// 一緒に食う。** 点検の実測はこうである:
//
//   元: `const a = 1;\nreturn xs.filter((c) => c.state === "open"); // 絞る\nconst b = 2;`
//   後: `const a = 1;\n\nconst b = 2;`      ← **コードごと消えた**
//
// **その帰結として、絞り込みを「行末に `//` のコメントが付いた行」に書くと、(j) の走査が
// 素通りしていた。** **今日は `//` から行末までだけを落とす**((r) が数で固定する)。
//
// **すぐ上の doc の「文字列リテラルの中の `//` は落とさない」は、旧でも新でも偽である** ——
// **旧はその行ごと食い、新は `//` から行末までを落とすので、`"https://…"` のような
// リテラルは今日も巻き込む。** **それでも当て先と対照が壊れないのは、実測で URL リテラルが
// 1つも無いからである**(2026-08-26 実測。当て先2本 = `web/src/CommentList.tsx` と
// `web/src/api.ts` の `listComments`、陽性対照 = `web/src/views/ListViewRenderer.tsx`、
// (o) が当てる `web/src/AppWorkspace.tsx`、いずれも `//` を含む文字列リテラルが **0件**)。
// **URL を1本でも書いた日に、この前提は黙って崩れる** —— 隠さずに書いておく。
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** `export async function <name>(` から、桁0 の `}` までを切り出す。 */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  if (start < 0) {
    throw new Error(`題材が壊れている: ${name} が無い`);
  }
  const end = source.indexOf("\n}", start);
  if (end < 0) {
    throw new Error(`題材が壊れている: ${name} の終端が無い`);
  }
  return source.slice(start, end + 2);
}

/**
 * 条件式らしき綴りの出現数(コメントを落としたあとで数える)。
 *
 * **【`V10-M32-T04`(2026-08-26)】上の1行は1バイトも消していない**(すぐ下の型の doc として
 * そのまま残す)。**足したのは、この検出器自身に陽性対照が掛かったという事実の記録だけである**
 * —— **(s) が4本の needle すべてを合成した題材で数えるので、綴りが外れた日に赤くなる。**
 */
type ConditionHits = {
  filterCall: number;
  roleWord: number;
  writerEquals: number;
  stateEquals: number;
};

function conditionHits(code: string): ConditionHits {
  const stripped = stripComments(code);
  const count = (needle: string): number => stripped.split(needle).length - 1;
  return {
    filterCall: count(".filter("),
    roleWord: count("role"),
    writerEquals: count("writer ==="),
    stateEquals: count("state ==="),
  };
}

test("(j) V10-M32-T01: 読む画面と読む関数に、絞り込みの条件式が1つも無い", () => {
  const panel = readFileSync(join(WEB_SRC, "CommentList.tsx"), "utf-8");
  const api = readFileSync(join(WEB_SRC, "api.ts"), "utf-8");

  for (const [name, code] of [
    ["CommentList.tsx", panel],
    ["api.ts の listComments", functionBody(api, "listComments")],
  ] as const) {
    const hits = conditionHits(code);
    expect(hits, name).toEqual({ filterCall: 0, roleWord: 0, writerEquals: 0, stateEquals: 0 });
  }

  // **陽性対照** —— **同じ走査関数を、絞り込みを実際に持つファイルに当てる。**
  // **非0 が返らなければ、上の0件は「測れていない」ことを意味する。**
  const control = readFileSync(join(WEB_SRC, "views", "ListViewRenderer.tsx"), "utf-8");
  const controlHits = conditionHits(control);
  expect(controlHits.filterCall).toBeGreaterThan(0);
  expect(controlHits.roleWord).toBeGreaterThan(0);

  // **コメントを落とす手当てが効いていること**(落とす前後で陽性対照の `role` が減る)。
  const raw = control.split("role").length - 1;
  expect(raw).toBeGreaterThan(controlHits.roleWord);
});

test("(j-2) V10-M32-T01: 読む画面は状態を変える口を1つも持たない(`CM-G13` は却下)", async () => {
  render(<CommentList appId={APP_ID} />);
  await waitFor(() => expect(screen.getAllByTestId("comment-list-item")).toHaveLength(3));

  // **ボタンは「閉じる」の0本または1本だけである**(`onClose` を渡していないので0本)。
  expect(document.querySelectorAll("button")).toHaveLength(0);
  const panel = stripComments(readFileSync(join(WEB_SRC, "CommentList.tsx"), "utf-8"));
  // **`not_applicable` はこの一覧に入れない** —— **状態の表示名の対応表(`STATE_LABELS`)が
  // 器の3値を鍵に持つので、綴りそのものは画面に在る**(在ることが型検査の担保である)。
  for (const forbidden of ["PATCH", "sendJson", "updateComment", "createComment"]) {
    expect(panel.includes(forbidden), forbidden).toBe(false);
  }
});

// ---------------------------------------------------------------------------
// (k)〜(p) アプリごとの設定で「読む場所」を出し入れする(`V10-M32-T02`。台帳 `CM-G40`)
// ---------------------------------------------------------------------------

/**
 * **`read` の判定だけを裸で描く器**(**provider の外に置くためだけに在る**)。
 *
 * **`AuthenticatedWorkspace` は export されていないので、「provider の外で器を描く」を
 * `<App />` 経由では作れない。** **判定そのものを1つだけ描けば、fail-closed の向きを
 * 器の都合抜きで測れる。** **この器は本番のコードから1度も呼ばれない。**
 */
function ReadProbe() {
  return <span data-testid="read-probe">{useCommentReadEnabled() ? "on" : "off"}</span>;
}

test("(k) V10-M32-T02: 設定が OFF なら open-comment-list が0要素である", async () => {
  renderAppAs("owner", { write: false, read: false });
  await waitFor(() => expect(screen.getByTestId("view-list")).toBeDefined());
  expect(screen.queryAllByTestId("open-comment-list")).toHaveLength(0);
  // **器そのものは消していない** —— **要件定義書とテーマの持ち出しは今日どおり出る**
  // (`platformPortAudience` を1バイトも書き換えていないことの実測)。
  expect(screen.getAllByTestId("workspace-links")).toHaveLength(1);
  expect(screen.getAllByTestId("open-requirements-doc")).toHaveLength(1);
  expect(screen.getAllByTestId("open-theme-export")).toHaveLength(1);
});

test("(l) V10-M32-T02: 設定が ON なら open-comment-list が1要素である(陽性対照)", async () => {
  renderAppAs("owner", { write: false, read: true });
  await waitFor(() => expect(screen.getAllByTestId("open-comment-list")).toHaveLength(1));
  // **押せばパネルが開く**((i-2) と同じ経路が、設定 ON のときは今日も生きている)。
  fireEvent.click(screen.getByTestId("open-comment-list"));
  await waitFor(() => expect(screen.getAllByTestId("comment-list")).toHaveLength(1));
  // **取りに行った結果が届くところまで待つ**((i-2) と同じ形にそろえる)。
  // **【正直に書く】この行を足す前も足したあとも、本ファイルの `act(...)` 警告は消えない** ——
  // **`bun test web/test/comment-list.test.tsx -t 'V10-M32-T02'` は警告0で、
  // `-t 'V10-M32-T01'` の側だけが出す**(**警告の出どころは既存の検査であって、
  // 本工程が足した8本ではない**)。**既存側は本タスクの射程外なので触っていない。**
  await waitFor(() => expect(screen.getAllByTestId("comment-list-item")).toHaveLength(3));
});

test("(m) V10-M32-T02: provider の外で描くと判定は false である(fail-closed)", () => {
  render(<ReadProbe />);
  expect(screen.getByTestId("read-probe").textContent).toBe("off");
});

test("(m-1) V10-M32-T02: provider の内側で `read` を立てれば true になる(陽性対照)", () => {
  render(
    // **【2026-08-26。`V10-M33-T01`】旧行の逐語(1バイトも消していない)**:
    //   `<CommentVisibilityProvider value={{ write: false, read: true }}>`
    // **`panel` を1本足しただけである** —— **この (m-1) は読む側の判定だけを見ており、
    // 書く欄を1要素も描いていない**(`write` は今日も `false` のままである)。
    <CommentVisibilityProvider value={{ write: false, read: true }} panel={CommentPanel}>
      <ReadProbe />
    </CommentVisibilityProvider>,
  );
  expect(screen.getByTestId("read-probe").textContent).toBe("on");
});

test("(m-2) V10-M32-T02: 応答に comment_visibility が1本も載っていなければ0要素である", async () => {
  renderAppAs("owner", "absent");
  await waitFor(() => expect(screen.getByTestId("view-list")).toBeDefined());
  expect(screen.queryAllByTestId("open-comment-list")).toHaveLength(0);
});

test("(n) V10-M32-T02: `write` だけ倒しても読む場所の導線には1要素も出ない", async () => {
  renderAppAs("owner", { write: true, read: false });
  await waitFor(() => expect(screen.getByTestId("view-list")).toBeDefined());
  expect(screen.queryAllByTestId("open-comment-list")).toHaveLength(0);

  // **陽性対照** —— **同じ器で `read` だけを立てれば1要素出る**(`D-V10-36`。2つが別であることの実測)。
  cleanup();
  renderAppAs("owner", { write: false, read: true });
  await waitFor(() => expect(screen.getAllByTestId("open-comment-list")).toHaveLength(1));
});

test("(o) V10-M32-T02: OFF のときは開く経路が無いだけでなく、三項連鎖の枝そのものが出ない", async () => {
  renderAppAs("owner", { write: false, read: false });
  await waitFor(() => expect(screen.getByTestId("view-list")).toBeDefined());
  expect(screen.queryAllByTestId("open-comment-list")).toHaveLength(0);
  expect(screen.queryAllByTestId("comment-list")).toHaveLength(0);

  // **枝が判定の下に在ることを、ソースの走査でも固定する** ——
  // **ボタンだけを包むと「開く経路が消えるだけで枝は残る」形になり、
  // 設定を読む箇所が2つに割れる**(`ADR-0379` 限定2 との緊張が1つ増える)。
  const workspace = readFileSync(join(WEB_SRC, "AppWorkspace.tsx"), "utf-8");
  const stripped = stripComments(workspace);
  const count = (needle: string): number => stripped.split(needle).length - 1;

  // **設定を読む呼び出しは、この器の中で1つちょうどである。**
  expect(count("useCommentReadEnabled()")).toBe(1);
  expect(count("const commentReadEnabled = useCommentReadEnabled();")).toBe(1);
  // **三項連鎖の枝は1本で、必ず判定の下に在る。**
  expect(count("commentListOpen ? (")).toBe(1);
  expect(count("commentReadEnabled && commentListOpen ? (")).toBe(1);
  // **導線のボタンも同じ判定の下に在る。**
  expect(count('data-testid="open-comment-list"')).toBe(1);
  expect(count("{commentReadEnabled && (")).toBe(1);

  // **陽性対照** —— **コメントを落とす手当てが効いている**(落とす前の方が出現数が多い)。
  expect(workspace.split("commentListOpen").length - 1).toBeGreaterThan(
    stripped.split("commentListOpen").length - 1,
  );
});

test("(p) V10-M32-T02: OFF でも読む口は1バイトも閉じていない(`D-V10-38`)", async () => {
  renderAppAs("owner", { write: false, read: false });
  await waitFor(() => expect(screen.getByTestId("view-list")).toBeDefined());
  // **画面には導線が1本も無い。**
  expect(screen.queryAllByTestId("open-comment-list")).toHaveLength(0);
  const before = seen.filter((entry) => entry.url === COMMENTS_PATH).length;
  expect(before).toBe(0);

  // **その状態のまま、読む口を直に叩く。**
  const comments = await listComments(APP_ID);
  expect(comments.map((comment) => comment.id)).toEqual(COMMENTS.map((comment) => comment.id));
  expect(
    seen.filter((entry) => entry.method === "GET" && entry.url === COMMENTS_PATH),
  ).toHaveLength(1);
  // **【誇張しない】止まったのは画面に出すことだけである** —— **口は今日も応答を返す。**
  // **MCP の `list_comments` も同様に1バイトも閉じていない**(本タスクは `src/` を1バイトも触っていない)。
});

// ---------------------------------------------------------------------------
// (q) 応答に `comments` が1本も無い 200(**独立点検の指摘1**。`V10-M32-T04`)
// ---------------------------------------------------------------------------

test("(q) V10-M32-T04: `comments` が無い 200 でも画面は消えず、統一のエラー表示が1つ出る", async () => {
  // **`total` だけが載った本文**(点検が複製の上で実測した形そのままである)。
  responses.set(`GET ${COMMENTS_PATH}`, [200, { total: 0 }]);
  render(<CommentList appId={APP_ID} />);

  // **統一のエラー表示(`ErrorList` の `data-testid="errors"`)が1つ出る** ——
  // **2本目のエラー表現を作っていないことの実測でもある。**
  await waitFor(() => expect(screen.getAllByTestId("errors")).toHaveLength(1));

  // **画面が丸ごと消えない**(見出しが残る)。
  const panel = screen.getByTestId("comment-list");
  expect(panel.textContent).toContain("コメント");
  // **「壊れている」と分かる文面である**(憲法6)。
  expect(panel.textContent).toContain("壊れて");
  // **「1件も無い」とは区別が付く** —— 0件の文面も 0件の器も出ない。
  expect(panel.textContent).not.toContain("まだコメントは1件もありません。");
  expect(screen.queryAllByTestId("comment-list-empty")).toHaveLength(0);
  expect(screen.queryAllByTestId("comment-list-item")).toHaveLength(0);
});

test("(q-2) V10-M32-T04: 正しい応答なら今日どおり3件並ぶ(陽性対照)", async () => {
  render(<CommentList appId={APP_ID} />);
  await waitFor(() => expect(screen.getAllByTestId("comment-list-item")).toHaveLength(3));
  expect(screen.queryAllByTestId("errors")).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// (r) 走査そのものの検査(**独立点検の指摘2**。`V10-M32-T04`)
// ---------------------------------------------------------------------------

test("(r) V10-M32-T04: 走査は `//` から行末までだけを落とし、同じ行の実コードを食わない", () => {
  // **点検が実測に使った題材そのままである。**
  const source = 'const a = 1;\nreturn xs.filter((c) => c.state === "open"); // 絞る\nconst b = 2;';
  const stripped = stripComments(source);

  // **行末に `//` が付いていても、その前の実コードは残る**(旧はここごと消していた)。
  expect(stripped).toContain(".filter(");
  expect(stripped).toContain('c.state === "open"');
  // **`//` から行末までは落ちる。**
  expect(stripped).not.toContain("絞る");
  // **前後の行も1バイトも失われない。**
  expect(stripped).toContain("const a = 1;");
  expect(stripped).toContain("const b = 2;");

  // **陽性対照** —— **行全体がコメントの行は、中身が落ちる。**
  const wholeLine = 'const a = 1;\n// xs.filter((c) => c.state === "open");\nconst b = 2;';
  const strippedWholeLine = stripComments(wholeLine);
  expect(strippedWholeLine).not.toContain(".filter(");
  expect(strippedWholeLine).not.toContain('c.state === "open"');
  expect(strippedWholeLine).toContain("const a = 1;");
  expect(strippedWholeLine).toContain("const b = 2;");

  // **`/* … */` は今日どおり落ちる**(こちらは1バイトも変えていない)。
  expect(stripComments("const a = 1; /* xs.filter((c) => c) */ const b = 2;")).not.toContain(
    ".filter(",
  );
});

// ---------------------------------------------------------------------------
// (s) 検出器そのものの陽性対照(**独立点検の指摘3**。`V10-M32-T04`)
// ---------------------------------------------------------------------------

/**
 * **4本の needle を全部含む合成した題材**(**製品のファイルではない**)。
 *
 * **(j) の陽性対照は `ListViewRenderer.tsx` に当てるが、そこに在るのは `.filter(` と
 * `role` の2本だけである** —— **`writer ===` と `state ===` は当て先でも対照でも0件で、
 * 綴りを絶対に当たらないタイポに差し替えても検査は緑のままだった**(点検が実測した)。
 * **つまり (j) の「0件」は、「当て先に無い」のか「検出器が壊れている」のか区別が付かない。**
 *
 * **この合成題材は、その区別を付けるためだけに在る** —— **4本とも非0 を返さなければ、
 * 検出器の側が壊れている。**
 */
const SYNTHETIC_CONDITIONS = [
  "const kept = rows.filter((row) => row.visible);",
  'if (viewer.role === "owner") { return rows; }',
  'const mine = row.writer === "alice";',
  'const open = row.state === "open";',
].join("\n");

test("(s) V10-M32-T04: 検出器は4本の needle すべてを実際に数えられる(合成した陽性対照)", () => {
  const hits = conditionHits(SYNTHETIC_CONDITIONS);

  // **4本とも非0** —— **1本でも0なら、その needle は綴りが外れている。**
  expect(hits.filterCall, ".filter(").toBeGreaterThan(0);
  expect(hits.roleWord, "role").toBeGreaterThan(0);
  expect(hits.writerEquals, "writer ===").toBeGreaterThan(0);
  expect(hits.stateEquals, "state ===").toBeGreaterThan(0);

  // **題材が4本とも1件ちょうどであることも固定する**(合成なので数まで言い切れる)。
  expect(hits).toEqual({ filterCall: 1, roleWord: 1, writerEquals: 1, stateEquals: 1 });

  // **陰性対照** —— **同じ4本を `//` の後ろに置けば、走査が落として全部0になる。**
  const commentedOut = SYNTHETIC_CONDITIONS.split("\n")
    .map((line) => `// ${line}`)
    .join("\n");
  expect(conditionHits(commentedOut)).toEqual({
    filterCall: 0,
    roleWord: 0,
    writerEquals: 0,
    stateEquals: 0,
  });
});

// ---------------------------------------------------------------------------
// (t) 部品を持たない宛先(**独立点検の指摘4**。`V10-M32-T04`)
// ---------------------------------------------------------------------------

test("(t) V10-M32-T04: 部品を持たない宛先は、形の名前ちょうどが出る", async () => {
  render(<CommentList appId={APP_ID} />);
  await waitFor(() => expect(screen.getAllByTestId("comment-list-item")).toHaveLength(3));

  // **題材の c-2 は `anchorForm: "app"` / `anchorParts: []` である**(前提を先に固定する)。
  expect(COMMENTS.find((comment) => comment.id === "c-2")?.anchorParts).toEqual([]);
  // **区切りの `/` を出さない** —— **`CommentList.tsx` の doc が言っている
  // 「形の名前だけが残る」を、今日は実際にそうする。**
  expect(
    document.querySelector('[data-comment-id="c-2"] [data-testid="comment-item-anchor"]')
      ?.textContent,
  ).toBe("app");

  // **陽性対照** —— **部品が1つ以上あれば、今日どおり `/` で連ねる。**
  expect(
    document.querySelector('[data-comment-id="c-1"] [data-testid="comment-item-anchor"]')
      ?.textContent,
  ).toBe("view_field / note-list / title");
  expect(
    document.querySelector('[data-comment-id="c-3"] [data-testid="comment-item-anchor"]')
      ?.textContent,
  ).toBe("view / note-list");
});

// ---------------------------------------------------------------------------
// (u) 欠落と未知値を黙って消さない(**独立点検の指摘5**。`V10-M32-T04`)
// ---------------------------------------------------------------------------

/**
 * **器の型からは外れた1行**(**`as unknown as` で作る**)。
 *
 * - **`reason` キーそのものが無い**(`undefined`)。**`!== null` は `undefined` に対して
 *   真になるので、旧は空の理由欄を1つ出していた**(点検の実測 = `P5 reason 要素数 = 1`)。
 * - **`state` が器の3値のどれでもない。** **旧は `STATE_LABELS` の引き当てが外れて
 *   空文字になっていた**(点検の実測 = `P4 state text = ""`)。
 *
 * **型の上ではあり得ないが、応答は実行時に届く値であって型ではない** —— **旧サーバ・
 * 合成した応答・器の 3値が動いた直後、のいずれでも今日この形は届きうる。**
 */
const BROKEN_ROW = {
  id: "c-broken",
  appId: APP_ID,
  anchorForm: "app",
  anchorParts: [],
  body: "型から外れた1行",
  createdAt: "2026-08-26T04:00:00.000Z",
  writer: null,
  state: "escalated",
  diffId: null,
} as unknown as CommentSummary;

test("(u) V10-M32-T04: 理由のキーが無い行に、空の理由欄を出さない", async () => {
  responses.set(`GET ${COMMENTS_PATH}`, [200, { comments: [BROKEN_ROW], total: 1 }]);
  render(<CommentList appId={APP_ID} />);
  await waitFor(() => expect(screen.getAllByTestId("comment-list-item")).toHaveLength(1));

  // **題材に `reason` キーが1つも無いことを先に固定する。**
  expect("reason" in (BROKEN_ROW as unknown as Record<string, unknown>)).toBe(false);
  // **「無い」は欄そのものが出ない**(`null` と同じ扱い)。
  expect(screen.queryAllByTestId("comment-item-reason")).toHaveLength(0);
});

test("(u-1) V10-M32-T04: 理由がある行では今日どおり欄が1つ出る(陽性対照)", async () => {
  render(<CommentList appId={APP_ID} />);
  await waitFor(() => expect(screen.getAllByTestId("comment-list-item")).toHaveLength(3));
  expect(
    document.querySelector('[data-comment-id="c-3"] [data-testid="comment-item-reason"]')
      ?.textContent,
  ).toBe("この画面は仕様どおりです。");
});

test("(u-2) V10-M32-T04: 器が知らない状態値は、その値そのものが出る(空にしない)", async () => {
  responses.set(`GET ${COMMENTS_PATH}`, [200, { comments: [BROKEN_ROW], total: 1 }]);
  render(<CommentList appId={APP_ID} />);
  await waitFor(() => expect(screen.getAllByTestId("comment-list-item")).toHaveLength(1));

  const label = document.querySelector('[data-testid="comment-item-state"]')?.textContent;
  // **空文字にしない** —— **「無い」と「知らない値が来た」を画面上で区別できる。**
  expect(label).not.toBe("");
  expect(label).toBe("escalated");
  // **器の綴りは今日どおり属性にも残る。**
  expect(document.querySelector('[data-comment-id="c-broken"]')?.getAttribute("data-state")).toBe(
    "escalated",
  );
});

test("(u-3) V10-M32-T04: 器の3値は今日どおり日本語の表示名が出る(陽性対照)", async () => {
  render(<CommentList appId={APP_ID} />);
  await waitFor(() => expect(screen.getAllByTestId("comment-list-item")).toHaveLength(3));
  const labelOf = (id: string): string | undefined =>
    document.querySelector(`[data-comment-id="${id}"] [data-testid="comment-item-state"]`)
      ?.textContent ?? undefined;
  expect(labelOf("c-1")).toBe("未対応");
  expect(labelOf("c-3")).toBe("対応できない");
  expect(labelOf("c-2")).toBe("当てた");
});
