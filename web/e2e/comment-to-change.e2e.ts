/**
 * **画面に書いたコメントが、一覧の口から読め、状態で割れるところまでを1本で通す**
 * (`V10-M16-T01b`。軸2 の受け入れ関門 `CP-V10-COMMENT` の **条件1 / 条件21** の
 * **実地の裏取り**)。
 *
 * ## この1本が何を埋めるのか
 *
 * **`comment-write.e2e.ts`(`V10-M11-T01`)は「画面から1件書けた」までしか通していない**
 * —— **当時 HTTP に読み出しの口が1本も無かったからである。**
 * **その後 `V10-M13-T02` / `V10-M13-T03` が状態と理由を、`V10-M15-T05` が
 * `GET /api/apps/:app_id/comments` を足した。** **本ファイルは、その3つを
 * 本物のブラウザから始まる1本の筋に繋いで測る。**
 * **単体の検査(`src/server/comment-api.test.ts`)は `app.request()` を直に叩くので、
 * 「画面から出た1件が、あとで一覧の口に出てくる」ことを1バイトも示さない。**
 *
 * ## **どの段をブラウザで通し、どの段を HTTP で叩いたか**(**混ぜて読ませない**)
 *
 * | 段 | 何をするか | **どちらで通したか** |
 * |---|---|---|
 * | 1 | コメントを2件書く | **ブラウザ(chromium)。画面の入力欄と送信ボタンを実際に操作している。** |
 * | 2 | 一覧の口から読む | **HTTP。** **ブラウザに一覧の画面が1つも無い**(`CommentPanel.tsx` は書く欄と送信ボタンだけで、読み返す要素を1つも描かない)。 |
 * | 3 | 状態を「対応できない」に倒して理由を付ける | **HTTP。** **ブラウザに承認画面が無い**(下記)。 |
 * | 4 | 一覧が状態で割れる | **HTTP。**(段2 と同じ理由) |
 *
 * **【禁止】この1本を「画面から状態を倒せる」と読まない。** **倒しているのは HTTP である。**
 * **【禁止】「画面から読み返せる」とも読まない。** **読んでいるのは HTTP である。**
 *
 * ## 【`V10-M32-T03`(2026-08-26)】**上の表の段2 と、直上の【禁止】の1行を訂正する**
 *
 * **上の表も2本の【禁止】も1バイトも消していない**(`ADR-0007` §6 規律1 と同じ作法)。
 * **偽になったのは次の2つである:**
 *
 * 1. **表の段2 の逐語「ブラウザに一覧の画面が1つも無い(`CommentPanel.tsx` は書く欄と
 *    送信ボタンだけで、読み返す要素を1つも描かない)」** —— **今日は一覧の画面が在る。**
 *    **`web/src/CommentList.tsx`(`V10-M32-T01` が新設)であり、作業画面の上にある
 *    「コメント」の導線(`data-testid="open-comment-list"`)から開く。**
 *    **括弧の中の「`CommentPanel.tsx` は書く欄と送信ボタンだけ」は今日も真である** ——
 *    **書く欄の中に読み出しの要素は1つも足されていない。** **一覧は別のパネルである。**
 * 2. **直上の【禁止】「『画面から読み返せる』とも読まない」** —— **今日は画面から読み返せる。**
 *    **ただしこの【禁止】は本ファイルの読み方の縛りとしては今日も守るべきである** ——
 *    **本ファイルの段2 / 段4 は今日も HTTP のままで、`open-comment-list` を1度も
 *    押していない。** **本ファイルを根拠に「画面から読み返せる」と言ってはならない、
 *    という縛りは1ミリも緩んでいない。**
 *
 * **偽にしたのは本ファイルではなく `V10-M32-T01`(台帳 `CM-G40`)である。**
 * **ブラウザで読み返せることの実測は `web/e2e/comment-read.e2e.ts` の1本目が持つ**
 * (`V10-M32-T03` が新設。**書くのも読むのも画面の操作であり、そちらの段2 は
 * HTTP を直に叩いていない**)。
 *
 * ## 【`V10-M32-T03`】**読み返せる場所と、読める範囲**(**誇張しない**)
 *
 * - **読み返せる場所は書く欄ではなく、作業画面の「コメント」の導線から開く一覧である。**
 * - **読めるのは「その人に見える範囲」であって、「自分が書いたもの」とは一致しない** ——
 *   **書き手が自分かで絞る規則は今日1本も無い**(絞りは `src/server/comment-visibility.ts`
 *   の可視集合だけである)。
 * - **アプリごとの設定 `comment_visibility.read` が OFF なら、導線も一覧も1要素も出ない。**
 *   **既定は OFF である**(利用者決定 `D-V10-40`)。
 * - **止めているのは画面に出すことだけで、口は1バイトも閉じていない**(`D-V10-38`)——
 *   **`GET /api/apps/:app_id/comments` は設定を今日1度も見ない。** **本ファイルの段2 / 段4 が
 *   設定を1度も倒さずに 200 で通っているのが、その実測そのものである。**
 *
 * ## **ブラウザに承認画面が無い**(`CM-G13` は**却下**)
 *
 * **コメントを見て、当てる差分を承認する画面は今日1枚も無い** —— **`CM-G13`(承認の画面)は
 * 門A の本審査で**却下**されており、実装が0バイトである。**
 * **したがって本テストは「承認して当てる」段をブラウザで1度も通らない。**
 * **`applied` に倒す段も、差分に繋ぐ段(`diff_id`)も、本ファイルは1度も踏んでいない。**
 *
 * ## この E2E が測っていないこと(**誇張しない**)
 *
 * 1. **「画面から読み返せる」ことを1ミリも測っていない** —— **測り漏らしではなく、
 *    今日そういう画面が無い。** 段2 / 段4 は HTTP である。
 * 2. **未ログインの枝を1度も踏んでいない** —— 書込の口は今日 匿名でも通る(`V10-M11-T03`)が、
 *    **一覧の口(`GET`)は `requireUser` で 401 である。** その枝は
 *    `src/server/comment-api.test.ts` の持ち物である。
 * 3. **`app` 以下の宛先を1つも測っていない** —— **画面から指せるのは `view` の1形だけである**
 *    (`CommentPanel.tsx` の `ANCHOR_FORM`)。**11形のうち10形は画面から指せない。**
 * 4. **`applied`(当てた)に倒す枝を1度も踏んでいない** —— **3値のうち2値しか触っていない。**
 *
 * ## 【`V10-M32-T03`(2026-08-26)】**直前の 1. と 2. を訂正する**
 *
 * **上の4項を1バイトも書き換えていない**(制定時の記述としてそのまま残す)。
 * **今日の正はここに書く。** **3. と 4. は今日も1ミリも動いていない。**
 *
 * **1. の訂正** —— **「『画面から読み返せる』ことを1ミリも測っていない」は今日も真である**
 * (**本ファイルは `open-comment-list` を1度も押していない**)。 **偽になったのは
 * その理由づけの逐語「測り漏らしではなく、今日そういう画面が無い」の方である** ——
 * **今日はその画面が在る**(`web/src/CommentList.tsx`。`V10-M32-T01` が新設)。
 * **したがって今日の理由は「まだ測っていない」であって「画面が無い」ではない。**
 * **その画面を本物のブラウザで測るのは `web/e2e/comment-read.e2e.ts` である**
 * (`V10-M32-T03` が新設。**本ファイルには1本も足していない**)。
 *
 * **2. の訂正** —— **「一覧の口(`GET`)は `requireUser` で 401 である」は既に偽である。**
 * **偽にしたのは本工程ではなく `V10-M27-T02`(`ADR-0375`)であり、2026-08-25 の時点で
 * 既に偽だった** —— **役割の規則を1本も書いていないアプリでは、一覧の口は未ログインを
 * 401 にしない**(`src/server/comment-visibility.ts` の `declaresNoRules` の枝)。
 * **本ファイルが使う土台のアプリはその側に居ない** —— **`fixture-server.ts` の
 * `grantFixtureRoleRules` が払い出しの時点で規則を注入するので、こちらでは今日も 401 である。**
 * **「未ログインの枝を1度も踏んでいない」ことそのものは今日も真である。**
 *
 * ## **役割の規則は E2E の土台が注入している**(**正直に書く**)
 *
 * **フィクスチャの JSON は `app.roles` を1本も持たない。** **しかし `fixture-server.ts` の
 * `grantFixtureRoleRules` が、払い出しの時点で規則を注入する**(`V8-M26` が既定を閉じた日の
 * 対処)。 **`owner` には `{ target: "app", can: ["write"] }` が入るので、一覧の口は
 * `comment-visibility.ts` の `OR` の第2項(アプリの作りを書き換えられる人には全部見える)で
 * 通っている。** **本テストは `set_roles` を1度も呼んでおらず、可視性の合成そのものを
 * 網羅もしていない** —— **踏んでいるのは第2項と、画面を読める人の第1項の2経路だけである。**
 */
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import type { Comment } from "../../src/kernel/comment-store.ts";
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

/**
 * **状態の綴りをここに直接書いている理由**(`COMMENT_STATES` を import していない)。
 *
 * **値域の出どころは `src/kernel/comment-store.ts` の `COMMENT_STATES` 1本である。**
 * **しかしそのモジュールは `bun:sqlite` を読み込む** —— **playwright は node で走るので、
 * 値として import した瞬間にこのファイルは読み込みごと落ちる**(型だけの import は
 * 消えるので `Comment` は今日どおり借りている)。 **綴りが2箇所目に増えたことは
 * 限界として記録に書く。**
 */
const OPEN = "open";
const NOT_APPLICABLE = "not_applicable";

const BODY_OPEN = "この一覧は絞り込みが欲しい(E2E。open のまま残す1件)";
const BODY_NOT_APPLICABLE = "この画面に承認ボタンを付けてほしい(E2E。対応できないに倒す1件)";
const REASON = "今日の語彙に承認の画面が無いので対応できません(E2E)";

/** 一覧の口の応答(`auth-routes.ts` の `c.json({ comments: visible, total: visible.length })`)。 */
type CommentListBody = { comments: Comment[]; total: number };

/** 一覧の口を **HTTP で** 叩く(`state` は省略できる)。 */
async function listComments(
  request: APIRequestContext,
  appId: string,
  headers: { cookie: string },
  state?: string,
): Promise<CommentListBody> {
  const path = `/api/apps/${appId}/comments`;
  const response = await request.get(state === undefined ? path : `${path}?state=${state}`, {
    headers,
  });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as CommentListBody;
}

/**
 * **画面からコメントを1件書く**(**ブラウザの操作。HTTP を1度も直に叩いていない**)。
 * 返すのは器が積んだその行(口が 201 で返した本文)。
 */
async function writeFromBrowser(page: Page, appId: string, body: string): Promise<Comment> {
  await page.getByTestId("comment-body").fill(body);
  const [response] = await Promise.all([
    page.waitForResponse(
      (res) =>
        res.url().includes(`/api/apps/${appId}/comments`) && res.request().method() === "POST",
    ),
    page.getByTestId("comment-submit").click(),
  ]);
  expect(response.status()).toBe(201);
  await expect(page.getByTestId("comment-sent")).toBeVisible();
  const payload = (await response.json()) as { comment: Comment };
  return payload.comment;
}

test("V10-M16-T01b: 画面から書いた2件が、一覧の口から読め、状態で割れる(段1=ブラウザ / 段2〜4=HTTP)", async ({
  page,
  request,
}) => {
  const app = await provisionApp(request);
  // **運営者ではない立場**(`viewer`)でブラウザを開く —— 書くのに役割は要らない。
  const viewer = await seedRoleSession(request, app.appId, "viewer");
  await viewer.authenticate(page.context());

  // **【`V10-M31-T03`。2026-08-25。上の行を1バイトも消していない】書く欄を出す設定を ON に倒す。**
  //
  // **`V10-M31-T02` から、書く欄はアプリごとの設定(`comment_visibility.write`)が
  // 真のときにしか出ない。既定は OFF である**(利用者決定 `D-V10-40`。段0 の実測:
  // このファイルの `:138` が `element(s) not found` で落ちた)。
  // **口は1バイトも閉じていない** —— **書込の口(`POST /api/apps/:app_id/comments`)も
  // 一覧の口(`GET`)も、設定を今日1度も見ない**(利用者決定 `D-V10-38`)。
  // **`page.goto` より前に倒す**(設定が読まれるのは `/manifest` を取るときだけである)。
  await app.setCommentVisibility({ write: true });

  // ------------------------------------------------------------------
  // 段1: **ブラウザ(chromium)から** コメントを2件書く。
  // ------------------------------------------------------------------
  await page.goto(`/apps/${app.appId}/views/${list.id}`);
  await expect(page.getByTestId("view-renderer-list_view")).toBeVisible();
  await expect(page.getByTestId("comment-panel")).toBeVisible();

  const kept = await writeFromBrowser(page, app.appId, BODY_OPEN);
  const flipped = await writeFromBrowser(page, app.appId, BODY_NOT_APPLICABLE);

  // **書いた直後の状態は2件とも `open` である**(器が積む既定)。
  expect(kept.state).toBe(OPEN);
  expect(flipped.state).toBe(OPEN);
  expect(kept.anchorForm).toBe("view");
  expect(kept.anchorParts).toEqual([list.id]);
  // **書き手は名乗った利用者そのものである**(`V10-M13-T01`)。
  expect(kept.writer).toBe(viewer.userId);

  // ------------------------------------------------------------------
  // 段2: **HTTP。** 画面から書いた2件が、一覧の口から読める。
  // ------------------------------------------------------------------
  const all = await listComments(request, app.appId, app.authHeaders);
  expect(all.total).toBe(2);
  expect(all.comments.map((comment) => comment.id).sort()).toEqual([kept.id, flipped.id].sort());
  // **本文は1バイトも変わらない**(器も口も画面も、文字を1つも組み立てない)。
  expect(all.comments.map((comment) => comment.body).sort()).toEqual(
    [BODY_OPEN, BODY_NOT_APPLICABLE].sort(),
  );

  // ------------------------------------------------------------------
  // 段3: **HTTP。** 片方を「対応できない」に倒し、理由を付ける。
  //      **ブラウザに承認画面が無い**(`CM-G13` = 却下)ので、この段は画面から踏めない。
  // ------------------------------------------------------------------
  const updated = await request.post(`/api/apps/${app.appId}/comments`, {
    data: { comment_id: flipped.id, state: NOT_APPLICABLE, reason: REASON },
    headers: app.authHeaders,
  });
  // **新規は 201・状態の書き換えは 200**(同じ1本の口が本文の形で分かれる)。
  expect(updated.status(), await updated.text()).toBe(200);
  const updatedPayload = (await updated.json()) as { comment: Comment };
  expect(updatedPayload.comment.id).toBe(flipped.id);
  expect(updatedPayload.comment.state).toBe(NOT_APPLICABLE);
  expect(updatedPayload.comment.reason).toBe(REASON);

  // ------------------------------------------------------------------
  // 段4: **HTTP。** 一覧が状態で割れる。
  // ------------------------------------------------------------------
  const notApplicable = await listComments(request, app.appId, app.authHeaders, NOT_APPLICABLE);
  expect(notApplicable.total).toBe(1);
  expect(notApplicable.comments[0]?.id).toBe(flipped.id);
  expect(notApplicable.comments[0]?.body).toBe(BODY_NOT_APPLICABLE);
  expect(notApplicable.comments[0]?.reason).toBe(REASON);

  const stillOpen = await listComments(request, app.appId, app.authHeaders, OPEN);
  expect(stillOpen.total).toBe(1);
  expect(stillOpen.comments[0]?.id).toBe(kept.id);
  expect(stillOpen.comments[0]?.body).toBe(BODY_OPEN);
  // **倒していない方に理由は1文字も付かない。**
  expect(stillOpen.comments[0]?.reason).toBeNull();

  // **状態を省くと2件とも返る**(絞りは口が持ち、可視性は合成が持つ)。
  const again = await listComments(request, app.appId, app.authHeaders);
  expect(again.total).toBe(2);
});

/**
 * **書いた本人(運営者でない利用者)も、一覧の口から自分のコメントを読める**
 * (`comment-visibility.ts` の `OR` の第1項 = **宛先の画面を読める人**)。
 *
 * **段1 = ブラウザ(画面から1件書く) / 段2 = HTTP(一覧の口から読む)。**
 * **画面から読み返す経路は今日1本も無い**(上の表と同じ理由)。
 *
 * **【`V10-M32-T03`(2026-08-26)】直前の1行を1バイトも消していない。訂正を後ろに足す** ——
 * **「画面から読み返す経路は今日1本も無い」は今日は偽である。**
 * **偽にしたのは本工程ではなく `V10-M32-T01`(台帳 `CM-G40`)である** ——
 * **作業画面の上の「コメント」の導線(`data-testid="open-comment-list"`)から、
 * `web/src/CommentList.tsx` の一覧が開く。**
 * **ただしこのテストの段2 は今日も HTTP のままである** —— **本ファイルはその導線を
 * 1度も押していないので、「このテストが画面から読み返している」とは読まない。**
 * **押して読むところまでを本物のブラウザで通すのは `web/e2e/comment-read.e2e.ts` の
 * 1本目であり、そちらも同じ `viewer` の台の作り方(このテストの下の4行)を写している。**
 *
 * **【誇張しない】その一覧で読めるのは「その人に見える範囲」であって、
 * 「自分が書いたもの」とは一致しない** —— **書き手が自分かで絞る規則は今日1本も無い。**
 * **このテストが `total` を 1 で受けられるのは、この台に他の書き手が1人も居ないからである。**
 * **また、その一覧は `comment_visibility.read` が OFF なら1要素も出ない(既定は OFF。
 * `D-V10-40`)** —— **止まるのは画面に出すことだけで、口は1バイトも閉じていない
 * (`D-V10-38`)。** **このテストが設定を `write` しか倒していないのに段2 が 200 で
 * 通っているのが、その実測である。**
 */
test("V10-M16-T01b: 画面から書いた本人(運営者でない)も、一覧の口から自分の1件を読める(段1=ブラウザ / 段2=HTTP)", async ({
  page,
  request,
}) => {
  const app = await provisionApp(request);
  const viewer = await seedRoleSession(request, app.appId, "viewer");
  await viewer.authenticate(page.context());

  // **【`V10-M31-T03`。2026-08-25。上の行を1バイトも消していない】書く欄を出す設定を ON に倒す。**
  // **既定は OFF である**(`V10-M31-T02` / 利用者決定 `D-V10-40`。段0 の実測:
  // このファイルの `:224` が `element(s) not found` で落ちた)。
  // **口は1バイトも閉じていない**(`D-V10-38`)。**`page.goto` より前に倒す。**
  await app.setCommentVisibility({ write: true });

  await page.goto(`/apps/${app.appId}/views/${list.id}`);
  await expect(page.getByTestId("comment-panel")).toBeVisible();
  const written = await writeFromBrowser(page, app.appId, BODY_OPEN);

  const seen = await listComments(request, app.appId, viewer.authHeaders);
  expect(seen.total).toBe(1);
  expect(seen.comments[0]?.id).toBe(written.id);
  expect(seen.comments[0]?.state).toBe(OPEN);
});
