/**
 * **本物のブラウザで、「コメントの出し入れ」の設定が画面に効くところを測る**
 * (`V10-M31-T03`。台帳 `CM-G38` / `ADR-0379`。利用者決定 `D-V10-38` / `D-V10-40`)。
 *
 * ## この4本が何を埋めるのか
 *
 * **`V10-M31-T01` が `GET /api/apps/:app_id/manifest` の応答に兄弟キー
 * `comment_visibility` を載せ、`V10-M31-T02` が器(`web/src/views/ViewHost.tsx`)に
 * それを見せた。** **しかし `V10-M31-T02` までの検査は全部 `web/test/*.test.tsx` の
 * 単体であり、`fetch` を差し替えている** —— **「本物のサーバが返した設定が、
 * 本物のブラウザの画面に効いた」ことを1バイトも示していない。** **本ファイルがそこを埋める。**
 *
 * ## **設定を倒しているのは E2E の足場である**(**誇張しない**)
 *
 * **設定を書く口は今日 MCP の道具 `set_comment_visibility` 1本だけで、HTTP には
 * 書く口も読む口も1本も無い**(`ADR-0378`)。 **したがって本ファイルは
 * `POST /__e2e__/apps/:app_id/comment-visibility`(`web/e2e/fixture-server.ts` が
 * 前段に持つ、テスト専用の口)を叩いている。** **製品の口を1本も足していない**
 * —— **`HTTP_ENTRY_POINTS` は今日も 52 のままである。**
 * **【禁止】この4本を「画面から設定を切り替えられる」と読まない。** **切り替える画面は1枚も無い。**
 *
 * ## **この E2E が測っていないこと**(**4件。誇張しない**)
 *
 * 1. **`read` の側を1度も倒していない** —— **`comment_visibility.read` を見る器が
 *    今日1つも無い**(`ViewHost.tsx` が読むのは `write` だけである)。
 * 2. **未ログインの枝を1度も踏んでいない** —— **`CommentVisibilityProvider` は
 *    ログイン済みの枝(`AppWorkspace.tsx`)にしか置かれておらず、未ログインには
 *    設定に関わらず欄が出ない。** その向きは `web/test/comment-panel.test.tsx` の持ち物である。
 * 3. **配る版(`web/src/runner-app.tsx`)を1度も開いていない** —— **利用者決定 `D-V10-39`
 *    が provider を置かないと決めており、配る版には欄が出ない。**
 * 4. **MCP の道具(`set_comment_visibility`)を1度も呼んでいない** —— **叩いているのは
 *    その下にあるカーネルの1本(`KernelMetaStore.setCommentVisibility`)である。**
 */
import { expect, test } from "@playwright/test";
import type { View } from "../../src/kernel/types.ts";
import { fixture, provisionApp } from "./fixture-app.ts";

/** 検証対象の list_view(フィクスチャから機械的に選ぶ。アプリ固有の名前は書かない)。 */
const list = ((): View => {
  const view = fixture.app.views.find((candidate) => candidate.type === "list_view");
  if (view === undefined) {
    throw new Error("フィクスチャが壊れています: list_view がありません。");
  }
  return view;
})();

/**
 * **アプリの中の「別のビュー」**(画面を切り替えただけでは効かないことを測るのに使う)。
 * **`list` と違う id を持つ最初の1本を機械的に選ぶ** —— **`detail_view` は URL に
 * レコードを要求するので外す。**
 */
const other = ((): View => {
  const view = fixture.app.views.find(
    (candidate) => candidate.id !== list.id && candidate.type !== "detail_view",
  );
  if (view === undefined) {
    throw new Error("フィクスチャが壊れています: 2本目のビューがありません。");
  }
  return view;
})();

/** **このページが `/manifest` を何回取ったかを数える**(取り直していないことの裏取り)。 */
function countManifestRequests(page: import("@playwright/test").Page, appId: string): () => number {
  let count = 0;
  page.on("request", (req) => {
    if (req.method() === "GET" && req.url().includes(`/api/apps/${appId}/manifest`)) {
      count += 1;
    }
  });
  return () => count;
}

// =====================================================================================
// 1本目: **既定 OFF では、書く欄が画面に1要素も出ない。**
// =====================================================================================

test("V10-M31-T03: 払い出したままのアプリ(既定 OFF)では、書く欄が1要素も出ない(chromium 実測)", async ({
  page,
  request,
}) => {
  const app = await provisionApp(request);
  // **設定を1度も倒していない** —— **`provisionApp` は `setCommentVisibility` を呼ばない。**
  // **したがってこのアプリは製品の既定(OFF)そのものである**(利用者決定 `D-V10-40`)。
  await app.authenticate(page.context());

  await page.goto(`/apps/${app.appId}/views/${list.id}`);
  // **画面そのものは today どおり出ている** —— **「欄が0要素」が「読み込みに失敗した」
  // ことの言い換えでないことを、先に固定する。**
  await expect(page.getByTestId("view-renderer-list_view")).toBeVisible();

  // **0要素である**(`toBeHidden` ではない —— **描いてから隠しているのではなく、
  // 器が `null` を返して1要素も作っていない**)。
  expect(await page.getByTestId("comment-panel").count()).toBe(0);
  expect(await page.getByTestId("comment-body").count()).toBe(0);
  expect(await page.getByTestId("comment-submit").count()).toBe(0);
});

// =====================================================================================
// 2本目: **ON に倒して開き直すと出る。サーバは1度も起こし直していない。**
// =====================================================================================

test("V10-M31-T03: ON に倒して同じアプリを開き直すと書く欄が出る(サーバを1度も起こし直していない)", async ({
  page,
  request,
}) => {
  const app = await provisionApp(request);
  await app.authenticate(page.context());

  // --- 1. まず OFF のまま開く(同じ待ち受け・同じプロセス) ----------------------
  await page.goto(`/apps/${app.appId}/views/${list.id}`);
  await expect(page.getByTestId("view-renderer-list_view")).toBeVisible();
  expect(await page.getByTestId("comment-panel").count()).toBe(0);

  // --- 2. 倒す(HTTP。E2E の足場の口) ----------------------------------------
  // **返るのは倒した後の実物である**(カーネルが `UPDATE` の後に読み直した値)。
  const flipped = await app.setCommentVisibility({ write: true });
  expect(flipped).toEqual({ write: true, read: false });

  // --- 3. 同じ URL を開き直すだけで出る ---------------------------------------
  // **サーバを1度も止めていない** —— **`fixture-server.ts` のプロセスも `dataRoot` も
  // 1本目のときと同じである。** **変わったのは `apps` 台帳の1行だけである。**
  await page.reload();
  await expect(page.getByTestId("view-renderer-list_view")).toBeVisible();
  await expect(page.getByTestId("comment-panel")).toBeVisible();
  await expect(page.getByTestId("comment-body")).toBeVisible();
  await expect(page.getByTestId("comment-submit")).toBeVisible();
});

// =====================================================================================
// 3本目: **画面を切り替えただけでは効かない**(**限界の実測。直すべき不具合として扱わない**)。
// =====================================================================================

/**
 * **アプリの中で別のビューへ遷移しても、倒す前に取った定義のままである。**
 *
 * ## **なぜそうなるのか**(**器の作りをそのまま書く**)
 *
 * **定義を取る `useEffect`(`web/src/AppWorkspace.tsx`)の依存は `[appId]` だけである。**
 * **`viewId` はその下の `AuthenticatedWorkspace` に props として渡るだけなので、
 * 画面を切り替えても `AppWorkspace` は張り付いたまま(同じ位置・同じ型なので React が
 * 作り直さない)で、`GET /manifest` は1度も走らない。**
 * **設定は `/manifest` の応答に相乗りしているので、取り直さない限り更新されない。**
 *
 * ## **これは限界であって、不具合ではない**
 *
 * **`ADR-0379` は「設定は定義の取得のときに読む」ところまでしか決めていない** ——
 * **倒した瞬間に開いている画面へ押し出す仕掛け(購読・ポーリング・SSE)は
 * 今日1つも無く、実装も0バイトである。** **本テストはその境目を固定するために在る。**
 * **「切り替えただけでは効かない」を赤くしたいなら、それは新しい実装タスクである。**
 */
test("V10-M31-T03: 倒した後にアプリの中で画面を切り替えても効かない(定義を取り直さないから。限界の実測)", async ({
  page,
  request,
}) => {
  const app = await provisionApp(request);
  await app.authenticate(page.context());
  const manifestRequests = countManifestRequests(page, app.appId);

  // --- 1. OFF のまま1本目の画面を開く -----------------------------------------
  await page.goto(`/apps/${app.appId}/views/${list.id}`);
  await expect(page.getByTestId("view-renderer-list_view")).toBeVisible();
  expect(await page.getByTestId("comment-panel").count()).toBe(0);
  const afterFirstLoad = manifestRequests();
  expect(afterFirstLoad).toBeGreaterThan(0);

  // --- 2. 開いたまま倒す(器には何も届かない) --------------------------------
  expect(await app.setCommentVisibility({ write: true })).toEqual({ write: true, read: false });
  // **開きっぱなしの画面には出てこない**(押し出す仕掛けが1つも無い)。
  expect(await page.getByTestId("comment-panel").count()).toBe(0);

  // --- 3. **アプリの中で** 別の画面へ移る(ページの読み込み直しではない) ------
  // **`RouteLink`(`web/src/navigation.tsx`)は `history.pushState` を使うので、
  // ブラウザは1度も読み込み直さない。**
  await page
    .getByTestId("view-list")
    .getByRole("link", { name: new RegExp(other.id) })
    .click();
  await expect(page).toHaveURL(new RegExp(`/apps/${app.appId}/views/${other.id}$`));
  await expect(page.getByTestId("workspace-main")).toBeVisible();

  // --- 4. **効いていない。** 定義を1度も取り直していない -----------------------
  expect(await page.getByTestId("comment-panel").count()).toBe(0);
  // **`GET /manifest` の回数が1度も増えていない** —— **これが「効かない」ことの理由そのもの。**
  expect(manifestRequests()).toBe(afterFirstLoad);

  // --- 5. **読み込み直せば出る**(倒したこと自体は器に届いている) --------------
  // **この段が無いと、4段目の0要素が「倒せていなかった」ことの言い換えになる。**
  await page.reload();
  await expect(page.getByTestId("comment-panel")).toBeVisible();
  expect(manifestRequests()).toBeGreaterThan(afterFirstLoad);
});

// =====================================================================================
// 4本目: **OFF のままでも書込の口は今日どおり通る**(**止めていないことの実測**)。
// =====================================================================================

/**
 * **利用者決定 `D-V10-38` の実測** —— **設定が止めるのは「欄を出すこと」だけであり、
 * `POST /api/apps/:app_id/comments` は今日も設定を1度も見ない。**
 *
 * **この1本は HTTP である**(ブラウザを1度も開いていない)—— **測りたいのは
 * 「画面に欄が無いときでも口が通る」ことであり、画面から押せないものを画面から測れない。**
 */
test("V10-M31-T03: OFF のままでも書込の口は 201 で通る(陽性対照 = ON でも通る。HTTP)", async ({
  request,
}) => {
  const app = await provisionApp(request);

  const post = async (body: string) =>
    request.post(`/api/apps/${app.appId}/comments`, {
      data: { anchorForm: "view", anchorParts: [list.id], body },
      headers: app.authHeaders,
    });

  // --- 1. OFF のまま(倒していない)。**通る** ---------------------------------
  const whileOff = await post("欄が出ていなくても口は通る(E2E。OFF のまま)");
  expect(whileOff.status(), await whileOff.text()).toBe(201);
  const offPayload = (await whileOff.json()) as { comment: { id: string; body: string } };
  expect(offPayload.comment.id).not.toBe("");

  // --- 2. **陽性対照**: ON に倒しても同じく通る -------------------------------
  // **これが無いと、1段目の 201 が「そもそも設定と無関係の口を叩いた」だけに見える。**
  expect(await app.setCommentVisibility({ write: true })).toEqual({ write: true, read: false });
  const whileOn = await post("欄が出ていても口は同じに通る(E2E。ON に倒した後)");
  expect(whileOn.status(), await whileOn.text()).toBe(201);
  const onPayload = (await whileOn.json()) as { comment: { id: string } };
  expect(onPayload.comment.id).not.toBe(offPayload.comment.id);

  // --- 3. **戻しても通る** ------------------------------------------------------
  // **`false` に倒し直しても口は 201 のままである** —— **壁ではないことの3点目。**
  expect(await app.setCommentVisibility({ write: false })).toEqual({ write: false, read: false });
  const backOff = await post("倒し直しても口は通る(E2E。OFF に戻した後)");
  expect(backOff.status(), await backOff.text()).toBe(201);
});
