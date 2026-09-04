/**
 * **本物のブラウザで、画面からコメントを1件書く**(`V10-M11-T01` の2手目。台帳 `CM-G4` =
 * **門外**(`Δ7`)/ 判定値 = 限定採用)。
 *
 * ## なぜこの1本が要るか
 *
 * **確定形(`docs/plan/v10/records/v10-m9.md:15847`)の完了条件 (1) の逐語は
 * 「本物のサーバを起こし、**運営者でない利用者**でログインして**画面から**コメントを1件書き、
 * 応答コードと本文を貼り、器に行が在ることを別の経路で示す」である。**
 * **単体の描画テスト(`web/test/comment-panel.test.tsx`)は `fetch` を差し替えているので、
 * 「画面から本物のサーバへ届いた」ことを1バイトも示さない。** **本ファイルがそこを埋める。**
 *
 * ## この E2E が測らないこと(**誇張しない**)
 *
 * - **書いたコメントを読み返していない** —— **HTTP にコメントを読む口が今日1本も無い**
 *   (足すのは `V10-M15-T05` / `CM-G21`)。 **器に行が在ることの裏取りは、
 *   応答本文(器が `addComment` から返したその行)と、本物の SQLite を直読みする
 *   `src/server/comment-api.test.ts` の側が持つ。**
 *
 *   **--- 【`V10-M32-T01`(2026-08-26)】上の4行を1バイトも消していない。訂正を後ろに足す ---**
 *
 *   **「HTTP にコメントを読む口が今日1本も無い」は既に偽である** ——
 *   **`GET /api/apps/:app_id/comments` が `src/server/auth-routes.ts` に在る
 *   (`V10-M15-T05` / `CM-G21` が 2026-08-24 に足した)。**
 *   **それでも「このファイルが書いたコメントを読み返していない」ことは今日も真である** ——
 *   **この E2E は書く欄(`comment-panel`)しか開かず、読み返す導線(`open-comment-list`)を
 *   1度も押していない。** **したがって下の (4) の「読み出しの口を1度も叩いていない」は
 *   今日も緑である**(**押していないから0本**であって、**口が無いから0本ではない**)。
 *   **読む側の実測は `web/test/comment-list.test.tsx` が持つ**(`fetch` を差し替えた
 *   描画テストであり、本物のサーバへ届いたことは1バイトも示さない —— **本工程はここを
 *   埋めていない。隠さずに書いておく**)。
 *
 *   **--- 【`V10-M32-T03`(2026-08-26)】上の行を1バイトも消していない。行き先だけ足す ---**
 *
 *   **「本工程はここを埋めていない」は `V10-M32-T01` についての記述であり、今日もその
 *   ままである。** **その穴を埋めたのは `web/e2e/comment-read.e2e.ts` の1本目
 *   (`V10-M32-T03` が新設)である** —— **本物のサーバに積まれた1件が、本物のブラウザで
 *   `open-comment-list` を押した先の一覧に出るところまでを通している。**
 *   **本ファイルの (4) の0本は今日も緑のままである**(**本ファイルはその導線を今日も
 *   1度も押していない**)。
 *   **【誇張しない】その一覧は `comment_visibility.read` が OFF なら1要素も出ない
 *   (既定は OFF。`D-V10-40`)。** **止まるのは画面に出すことだけで、
 *   `GET /api/apps/:app_id/comments` は1バイトも閉じていない**(`D-V10-38`)。
 *   **読めるのも「その人に見える範囲」であって、「自分が書いたもの」とは一致しない** ——
 *   **書き手が自分かで絞る規則は今日1本も無い。**
 * - **未ログインの枝を測っていない** —— **`V10-M11-T01` では 401 であり、
 *   開けるのは `V10-M11-T03`(`CM-G6`)である。** **未ログインに導線が出ないことは
 *   `web/test/comment-panel.test.tsx` が固定する。**
 * - **`app` 以下10形の宛先を測っていない** —— **画面から指せるのは `view` の1形だけである。**
 */
import { expect, test } from "@playwright/test";
import type { ListView } from "../../src/kernel/types.ts";
import { fixture, provisionApp, seedRoleSession } from "./fixture-app.ts";

/** 検証対象の list_view(フィクスチャから機械的に選ぶ。アプリ固有の名前は書かない)。 */
const list = ((): ListView => {
  const view = fixture.app.views.find(
    (candidate): candidate is ListView => candidate.type === "list_view",
  );
  if (view === undefined) {
    throw new Error("フィクスチャが壊れています: list_view がありません。");
  }
  return view;
})();

const BODY = "ここは数量を先に出したい(E2E)";

test("V10-M11-T01: 運営者でない利用者が、画面からコメントを1件書ける(chromium 実測)", async ({
  page,
  request,
}) => {
  const app = await provisionApp(request);
  // **運営者ではない立場**(`viewer`)を1人仕込み、その人としてブラウザを開く。
  const viewer = await seedRoleSession(request, app.appId, "viewer");
  await viewer.authenticate(page.context());

  // **【`V10-M31-T03`。2026-08-25。上の行を1バイトも消していない】書く欄を出す設定を ON に倒す。**
  //
  // **`V10-M31-T02` から、書く欄はアプリごとの設定(`comment_visibility.write`)が
  // 真のときにしか出ない。** **既定は OFF(利用者決定 `D-V10-40`)なので、
  // 払い出したままのアプリでは `comment-panel` が0要素になる**(段0 の実測:
  // このファイルの `:64` が `element(s) not found` で落ちた)。
  // **口は1バイトも閉じていない** —— **止まったのは欄を出すことだけで、
  // `POST /api/apps/:app_id/comments` は今日も設定を1度も見ない**(利用者決定 `D-V10-38`)。
  // **`page.goto` より前に倒す** —— **設定が読まれるのは `/manifest` を取るときだけなので、
  // 開いた後に倒しても、その画面には届かない。**
  await app.setCommentVisibility({ write: true });

  const commentsPath = `/api/apps/${app.appId}/comments`;
  /** **このページが `/comments` に対して出した要求を全部数える**(読出が0本であることの裏取り)。 */
  const touched: { method: string; url: string }[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/comments")) {
      touched.push({ method: req.method(), url: req.url() });
    }
  });

  await page.goto(`/apps/${app.appId}/views/${list.id}`);
  await expect(page.getByTestId("view-renderer-list_view")).toBeVisible();

  // --- 1. 導線が画面に出ている(運営者でなくても) ------------------------------
  const panel = page.getByTestId("comment-panel");
  await expect(panel).toBeVisible();

  // --- 2. 書いて送る。本物の応答を捕まえる ------------------------------------
  await page.getByTestId("comment-body").fill(BODY);
  const [response] = await Promise.all([
    page.waitForResponse(
      (res) => res.url().includes(commentsPath) && res.request().method() === "POST",
    ),
    page.getByTestId("comment-submit").click(),
  ]);

  expect(response.status()).toBe(201);
  const payload = (await response.json()) as {
    comment: { id: string; appId: string; anchorForm: string; anchorParts: string[]; body: string };
  };
  // **器が積んだその行が返ってくる**(`addComment` の返り値そのもの)。
  expect(payload.comment.appId).toBe(app.appId);
  expect(payload.comment.anchorForm).toBe("view");
  expect(payload.comment.anchorParts).toEqual([list.id]);
  // **本文は1バイトも変わらない**(器も口も画面も、文字を1つも組み立てない)。
  expect(payload.comment.body).toBe(BODY);
  expect(payload.comment.id).not.toBe("");

  // --- 3. 受け付けた旨が画面に出て、入力欄が空に戻る ---------------------------
  await expect(page.getByTestId("comment-sent")).toBeVisible();
  await expect(page.getByTestId("comment-body")).toHaveValue("");

  // --- 4. 読み出しの口を1度も叩いていない -------------------------------------
  // **【`V10-M32-T01`】この0本は「読む導線を押していない」ことの帰結である** ——
  // **`open-comment-list` を押せば `GET /comments` が1本飛ぶ**(押していない)。
  expect(touched.filter((entry) => entry.method !== "POST")).toEqual([]);
  expect(touched.filter((entry) => entry.method === "POST")).toHaveLength(1);
});
