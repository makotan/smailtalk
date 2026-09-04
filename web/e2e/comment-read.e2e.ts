/**
 * **本物のブラウザで、書いたコメントを同じ画面から読み返すところまでを通す**
 * (`V10-M32-T03`。台帳 `CM-G40` / `CM-G41`。利用者決定 `D-V10-36` / `D-V10-38` /
 * `D-V10-40`)。
 *
 * ## この4本が何を埋めるのか
 *
 * **`V10-M32-T01` が読む場所(`web/src/CommentList.tsx` と `open-comment-list` の導線)を、
 * `V10-M32-T02` がその出し入れ(`comment_visibility.read`)を足した。**
 * **しかし `V10-M32-T02` までの検査は全部 `web/test/comment-list.test.tsx` の単体であり、
 * `fetch` を差し替えている** —— **「本物のサーバに積まれた1件が、本物のブラウザの画面に
 * 出た」ことを1バイトも示していない。** **本ファイルがそこを埋める。**
 *
 * **`comment-to-change.e2e.ts` は「画面から書いた1件が、あとで**一覧の口**に出てくる」
 * ところまでで、段2 は HTTP である**(そのファイルの表がそう書いている)。
 * **本ファイルは段2 もブラウザで踏む** —— **押すのは `open-comment-list` である。**
 *
 * ## **どの段をブラウザで通し、どの段を HTTP で叩いたか**(**混ぜて読ませない**)
 *
 * | 本 | 何を測るか | **どちらで通したか** |
 * |---|---|---|
 * | 1 | 書いた1件が、同じブラウザで開いた一覧に出る | **ブラウザ(chromium)。書くのも読むのも画面の操作である。** |
 * | 2 | 既定 OFF では読む導線が0要素・ON なら出る | **ブラウザ。**(倒すのは E2E の足場の口) |
 * | 3 | `write` と `read` が別である | **ブラウザ。**(同上) |
 * | 4 | OFF でも読む口は 200 を返す | **HTTP。**(ブラウザを1度も開いていない) |
 *
 * ## **設定を倒しているのは E2E の足場である**(**誇張しない**)
 *
 * **設定を書く口は今日 MCP の道具 `set_comment_visibility` 1本だけで、HTTP には
 * 書く口も読む口も1本も無い**(`ADR-0378`)。 **本ファイルが叩いているのは
 * `POST /__e2e__/apps/:app_id/comment-visibility`(`web/e2e/fixture-server.ts` が
 * 前段に持つ、テスト専用の口)である** —— **`web/e2e/fixture-app.ts` の
 * `setCommentVisibility` 1本を借りているだけで、足場を1バイトも足していない。**
 * **【禁止】この4本を「画面から設定を切り替えられる」と読まない。** **切り替える画面は1枚も無い。**
 *
 * ## **可視集合は `OR` である**(**台の作り方の理由。丸めない**)
 *
 * **コメントが見えるのは **(a) 宛先の画面を読める人** または **(b) アプリの作りを
 * 書き換えられる人** である**(`src/server/comment-visibility.ts`)。
 * **本ファイルの1本目は `viewer`(運営者でない)で読むので、(b) では1件も通らない** ——
 * **通っているのは (a) である。** **その条件を作っているのは `fixture-server.ts` の
 * `grantFixtureRoleRules` であり、名指しの無い画面には `owner` / `editor` / `viewer` の
 * 3役に `{target:"view", view:<id>, can:["read"]}` を無条件で入れる。**
 * **本ファイルは `set_roles` を1度も呼んでおらず、可視性の合成を網羅もしていない。**
 *
 * ## **この4本が測っていないこと**(**7件。誇張しない**)
 *
 * 1. **「自分が書いたものだけが出る」ことを1ミリも測っていない** —— **書き手が自分かで
 *    絞る規則は今日1本も無い。** **1本目が「1件出る」で通るのは、その台に他の書き手が
 *    1人も居ないからであって、絞りが効いたからではない。**
 * 2. **未ログインの枝を1度も踏んでいない** —— **`CommentVisibilityProvider` は
 *    ログイン済みの枝(`AppWorkspace.tsx`)にしか置かれておらず、未ログインには
 *    設定に関わらず導線が出ない。** その向きは `web/test/comment-panel.test.tsx` の持ち物である。
 * 3. **`applied` / `not_applicable` に倒した行の見え方を1度も見ていない** ——
 *    **3値のうち `open` しか画面に出していない。** **状態で割れることの実測は
 *    `comment-to-change.e2e.ts`(HTTP)の持ち物である。**
 * 4. **`view` 以外の宛先を1つも測っていない** —— **画面から指せるのは `view` の1形だけである**
 *    (`CommentPanel.tsx` の `ANCHOR_FORM`)。**11形のうち10形は画面から指せない。**
 * 5. **配る版(`web/src/runner-app.tsx`)を1度も開いていない** —— **利用者決定 `D-V10-39`
 *    が provider を置かないと決めており、配る版には導線が出ない。**
 * 6. **MCP の道具(`set_comment_visibility` / `list_comments`)を1度も呼んでいない。**
 * 7. **倒した瞬間に開いている画面へ効くかを測っていない** —— **押し出す仕掛けは今日1つも
 *    無く、本ファイルは倒してから `page.goto` / `page.reload` している。**
 *    **その限界の実測は `comment-visibility.e2e.ts` の3本目が持つ。**
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

const BODY = "この一覧に絞り込みが欲しい(E2E。書いた本人が画面で読み返す1件)";

// =====================================================================================
// 1本目: **書いた1件が、同じブラウザで開いた一覧に出る**(**完了条件1 の実測**)。
// =====================================================================================

test("V10-M32-T03: 運営者でない人が画面から書いた1件を、同じブラウザの一覧で読み返せる(chromium 実測)", async ({
  page,
  request,
}) => {
  const app = await provisionApp(request);
  // **運営者ではない立場**(`viewer`)を1人仕込み、その人としてブラウザを開く。
  // **`app.authenticate` を呼んでいない** —— **呼ぶと owner の cookie が同じ context に
  // 入り、(b) の枝で通ってしまう。**
  const viewer = await seedRoleSession(request, app.appId, "viewer");
  await viewer.authenticate(page.context());

  // **書く欄と読む導線の両方を出す。** **既定はどちらも OFF である**(`D-V10-40`)。
  // **`page.goto` より前に倒す** —— **設定が読まれるのは `/manifest` を取るときだけである。**
  expect(await app.setCommentVisibility({ write: true, read: true })).toEqual({
    write: true,
    read: true,
  });

  await page.goto(`/apps/${app.appId}/views/${list.id}`);
  await expect(page.getByTestId("view-renderer-list_view")).toBeVisible();

  // --- 1. 画面から1件書く(ブラウザの操作。HTTP を直に叩いていない) --------------
  await expect(page.getByTestId("comment-panel")).toBeVisible();
  await page.getByTestId("comment-body").fill(BODY);
  const [posted] = await Promise.all([
    page.waitForResponse(
      (res) =>
        res.url().includes(`/api/apps/${app.appId}/comments`) && res.request().method() === "POST",
    ),
    page.getByTestId("comment-submit").click(),
  ]);
  expect(posted.status()).toBe(201);
  const written = (await posted.json()) as { comment: { id: string; body: string } };
  await expect(page.getByTestId("comment-sent")).toBeVisible();

  // --- 2. **同じブラウザで**読む導線を押す(ページを読み込み直していない) --------
  const [read] = await Promise.all([
    page.waitForResponse(
      (res) =>
        res.url().includes(`/api/apps/${app.appId}/comments`) && res.request().method() === "GET",
    ),
    page.getByTestId("open-comment-list").click(),
  ]);
  expect(read.status()).toBe(200);

  // --- 3. **その1件が画面に出ている** -------------------------------------------
  await expect(page.getByTestId("comment-list")).toBeVisible();
  const items = page.getByTestId("comment-list-item");
  await expect(items).toHaveCount(1);
  // **本文が1バイトも変わらずに出る**(器も口も画面も、文字を1つも組み立てない)。
  await expect(items.getByTestId("comment-item-body")).toHaveText(BODY);
  expect(written.comment.body).toBe(BODY);
  // **画面が並べたのは器が返したその行である**(`_id` で突き合わせる)。
  await expect(items).toHaveAttribute("data-comment-id", written.comment.id);
  // **「まだ1件もありません」の枝ではない**(0件でも同じ `comment-list` が出るので、
  // これが無いと「開けた」だけで「読めた」の言い換えになる)。
  expect(await page.getByTestId("comment-list-empty").count()).toBe(0);
});

// =====================================================================================
// 2本目: **既定 OFF では読む導線が1要素も出ない**(**完了条件3 の実測**)。
// =====================================================================================

test("V10-M32-T03: 払い出したままのアプリ(既定 OFF)では open-comment-list が1要素も出ない(陽性対照 = ON なら出る)", async ({
  page,
  request,
}) => {
  const app = await provisionApp(request);
  // **設定を1度も倒していない** —— **`provisionApp` は `setCommentVisibility` を呼ばない。**
  // **したがってこのアプリは製品の既定(OFF)そのものである**(`D-V10-40`)。
  await app.authenticate(page.context());

  await page.goto(`/apps/${app.appId}/views/${list.id}`);
  // **画面そのものは今日どおり出ている** —— **「導線が0要素」が「読み込みに失敗した」
  // ことの言い換えでないことを、先に固定する。**
  await expect(page.getByTestId("view-renderer-list_view")).toBeVisible();

  // **0要素である**(`toBeHidden` ではない —— **描いてから隠しているのではなく、
  // 器が1要素も作っていない**)。
  expect(await page.getByTestId("open-comment-list").count()).toBe(0);
  // **器そのものは消していない** —— **要件定義書とテーマの持ち出しは今日どおり出る**
  // (`platformPortAudience` を1バイトも書き換えていないことの実測)。
  await expect(page.getByTestId("open-requirements-doc")).toBeVisible();
  await expect(page.getByTestId("open-theme-export")).toBeVisible();

  // --- **陽性対照**: `read` を ON に倒して開き直すと出る -------------------------
  // **これが無いと、上の0要素が「そもそも導線を足していない」ことの言い換えになる。**
  // **サーバを1度も起こし直していない** —— **変わったのは `apps` 台帳の1行だけである。**
  expect(await app.setCommentVisibility({ read: true })).toEqual({ write: false, read: true });
  await page.reload();
  await expect(page.getByTestId("view-renderer-list_view")).toBeVisible();
  await expect(page.getByTestId("open-comment-list")).toBeVisible();
});

// =====================================================================================
// 3本目: **`write` と `read` は別である**(`D-V10-36` の実測)。
// =====================================================================================

test("V10-M32-T03: `write` だけ ON なら書く欄だけ・`read` だけ ON なら読む導線だけが出る(D-V10-36)", async ({
  page,
  request,
}) => {
  const app = await provisionApp(request);
  await app.authenticate(page.context());

  // --- 1. `write` だけ ON。**書く欄は出るが、読む導線は0要素** -------------------
  expect(await app.setCommentVisibility({ write: true })).toEqual({ write: true, read: false });
  await page.goto(`/apps/${app.appId}/views/${list.id}`);
  await expect(page.getByTestId("view-renderer-list_view")).toBeVisible();
  await expect(page.getByTestId("comment-panel")).toBeVisible();
  expect(await page.getByTestId("open-comment-list").count()).toBe(0);
  // **枝そのものも出ない**(開く経路が消えるだけではない)。
  expect(await page.getByTestId("comment-list").count()).toBe(0);

  // --- 2. **逆に倒す**。`read` だけ ON。**読む導線は出るが、書く欄は0要素** ------
  // **片側だけ渡せるので、2本の呼び出しで両方を倒し直す**(`setCommentVisibility` は
  // 省いた側を今の値のまま残す)。
  expect(await app.setCommentVisibility({ write: false, read: true })).toEqual({
    write: false,
    read: true,
  });
  await page.reload();
  await expect(page.getByTestId("view-renderer-list_view")).toBeVisible();
  await expect(page.getByTestId("open-comment-list")).toBeVisible();
  expect(await page.getByTestId("comment-panel").count()).toBe(0);
  expect(await page.getByTestId("comment-body").count()).toBe(0);
  expect(await page.getByTestId("comment-submit").count()).toBe(0);
});

// =====================================================================================
// 4本目: **OFF のままでも読む口は通る**(**止めていないことの実測**。`D-V10-38`)。
// =====================================================================================

/**
 * **利用者決定 `D-V10-38` の実測** —— **設定が止めるのは「画面に出すこと」だけであり、
 * `GET /api/apps/:app_id/comments` は今日も設定を1度も見ない。**
 *
 * **この1本は HTTP である**(ブラウザを1度も開いていない)—— **測りたいのは
 * 「画面に導線が無いときでも口が通る」ことであり、画面から押せないものを画面から測れない。**
 */
test("V10-M32-T03: OFF のままでも読む口は 200 で通る(陽性対照 = ON でも 200。HTTP)", async ({
  request,
}) => {
  const app = await provisionApp(request);
  const path = `/api/apps/${app.appId}/comments`;

  // **中身を1件積んでおく** —— **0件のまま 200 を見ると、「口が空を返しただけ」と
  // 「口が読めた」の区別が付かない。**
  const posted = await request.post(path, {
    data: { anchorForm: "view", anchorParts: [list.id], body: "口は閉じていない(E2E)" },
    headers: app.authHeaders,
  });
  expect(posted.status(), await posted.text()).toBe(201);

  // --- 1. OFF のまま(倒していない)。**200 で、積んだ1件が返る** ----------------
  const whileOff = await request.get(path, { headers: app.authHeaders });
  expect(whileOff.status(), await whileOff.text()).toBe(200);
  const offPayload = (await whileOff.json()) as { comments: { id: string }[]; total: number };
  expect(offPayload.total).toBe(1);

  // --- 2. **陽性対照**: ON に倒しても同じく 200 で、同じ1件が返る ----------------
  // **これが無いと、1段目の 200 が「そもそも設定と無関係の口を叩いた」だけに見える。**
  expect(await app.setCommentVisibility({ read: true })).toEqual({ write: false, read: true });
  const whileOn = await request.get(path, { headers: app.authHeaders });
  expect(whileOn.status(), await whileOn.text()).toBe(200);
  const onPayload = (await whileOn.json()) as { comments: { id: string }[]; total: number };
  expect(onPayload.total).toBe(1);
  expect(onPayload.comments.map((comment) => comment.id)).toEqual(
    offPayload.comments.map((comment) => comment.id),
  );

  // --- 3. **戻しても通る** ------------------------------------------------------
  // **`false` に倒し直しても口は 200 のままである** —— **壁ではないことの3点目。**
  expect(await app.setCommentVisibility({ read: false })).toEqual({ write: false, read: false });
  const backOff = await request.get(path, { headers: app.authHeaders });
  expect(backOff.status(), await backOff.text()).toBe(200);
  expect(((await backOff.json()) as { total: number }).total).toBe(1);
});
