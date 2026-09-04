/**
 * **配る版(お客様に配る実行専用の版)を、本物のブラウザで建てて押す**
 * (`V10-M7-T05`。ユーザ決定 `D-V10-14`)。
 *
 * ## 【なぜ足したか。着手前の実測】
 *
 * **着手前、配る版の証拠は部品単位の検査(happy-dom)止まりであり、
 * ブラウザで1度も動かしていなかった** ——
 * `web/test/runner-entry-boundary.test.ts` が測るのは**成果物のバイト列**、
 * `web/test/runner-signup-auto-open.test.tsx` が測るのは**部品を happy-dom に描いた姿**である。
 * **`web/e2e/` が建てていたのは育成用の版(`web/dist`)だけだった。**
 * **本ファイルが、配る版(`web/runner/dist`)を chromium で開く最初の1本である。**
 *
 * ## 【どうやって建てているか。行き止まりを3つ踏んである】
 *
 * 1. **配る版はビルド時にアプリIDを焼き込む**(`web/vite.config.ts` の `runner` モードの
 *    `define` が `GP_RUNNER_APP_ID` を入れる)。**実行時に差し替える口は1つも無い。**
 *    → **`package.json` の `test:e2e` が固定のID({@link RUNNER_APP_ID})で
 *    `bun run build:runner` を走らせ、`web/e2e/fixture-server.ts` が同じIDのアプリを1本入れる。**
 *    **払い出し(`provisionApp`)は使えない** —— **毎回違うIDになるからである。**
 *    **結果として、下の4本は1本のアプリを共有する**(独立の作り方は後述)。
 * 2. **`web/runner/dist` には `index.html` が無く `runner.html` しか無い。**
 *    **`src/server/app.ts` の SPA フォールバックが見るのは `index.html` 1本だけである。**
 *    → **`Dockerfile` が埋めているのと同じ穴(`mv runner.html index.html`)を
 *    `test:e2e` の前段でも踏む。**
 * 3. **別の待ち受けから配ると Origin 検査で 403 になる。**
 *    → **`web/e2e/fixture-server.ts` が期待オリジンを2つ立てる**(`,` 区切り)。
 *
 * ## 【4本が互いの順序に依らないようにした作り】
 *
 * **`applyManifest` は追加しか許さない**(`src/kernel/apply-manifest.ts` の 3.)——
 * **一度足した `st_owner` は、後の検査から取り除けない。**
 * **そこで「候補が何本か」を `st_owner` の有無ではなく、
 * **一般利用者(`customer`)がどの画面を読めるか**で作り分ける** ——
 * **役割の規則は物理スキーマではないので、何度でも書き換えられる。**
 * **候補は「`st_owner` を宣言した表の `form` で、その立場が読めるもの」なので
 * (`web/src/auth/signup-next.ts` の `signupNextFormViews`)、
 * 読める画面の側を差し替えれば 0本にも1本にもできる。**
 * **どの検査から先に走らせても結果が変わらない。**
 *
 * ## 【ここで測っていないこと。先に書く】
 *
 * - **配る版の Passkey 登録を1度も押していない**(押しているのはパスワード登録のボタンだけ)。
 * - **配る版で「候補が2本以上」のときの見え方を1件も測っていない。**
 * - **配る版の見た目(配色・位置・ピクセル)を1つも見ていない。**
 * - **配る版を Docker のイメージから起動していない** —— **建てているのは
 *   `createServerApp({ profile: "runner" })` であり、`Dockerfile` の成果物そのものではない。**
 * - **アプリを2本以上入れたときに配る版がどう振る舞うかを測っていない**(焼き込みは1本)。
 *
 * ## 【2026-08-22 訂正(`V10-M19-T01` / `FU-G6` / `ADR-0363`)。旧文を1バイトも消していない】
 *
 * - **「配る版で「候補が2本以上」のときの見え方を1件も測っていない。」は今日は偽である** ——
 *   **5本目が、候補を2本にしたうえで配る版に案内が1つ出ることをブラウザで測る。**
 * - **`:21` の「結果として、下の4本は1本のアプリを共有する」の「4本」も今日は偽である** ——
 *   **本ファイルの検査は 6 本になった**(**本数を数える式をこの doc に書き写していない** ——
 *   **書き写すとこの行まで数えられ、書いたその場で値が動く。式の全文は `ADR-0363`
 *   §Decision 5 の限定6 に在る**)。
 *   **1本のアプリを共有していること自体は1ミリも変わっていない** —— **共有するのが6本になった。**
 *   **足した2本も、他の5本と順序に依らない**(候補の本数は役割の規則で作り分けており、
 *   **`st_owner` を足す表を1つも増やしていない**)。
 * - **配る版に案内が1つも出ないことを固定していた4本目は、向きを反転させた**
 *   (**旧の名前の逐語**: 「**配る版に、育成用の版に出る案内(customer-signup-next)が
 *   1つも出ない**」)。**候補が0本のときに両方の版で出ないことは6本目が測る。**
 * - **配る版の見た目(配色・位置・ピクセル)を1つも見ていないのは今日も同じである** ——
 *   **測るのは「在るか / 何本か」だけである。**
 *
 * ## 【2026-08-26 訂正(`V10-M33-T01` / `CM-G43`)。旧文を1バイトも消していない】
 *
 * - **`:21` の「下の4本」も、上の訂正が言う「6 本」も、今日は偽である** ——
 *   **本ファイルの検査は 7 本になった**(**本数を数える式をこの doc に書き写していない** ——
 *   **書き写すとこの行まで数えられ、書いたその場で値が動く**)。
 *   **1本のアプリを共有していること自体は1ミリも変わっていない。**
 * - **7本目は、コメントの書く欄が配る版に1要素も出ないことを測る。**
 *   **設定(`comment_visibility.write`)を ON に倒したうえで測り、同じアプリ・同じ設定・
 *   同じ立場を育成用の版で開くと欄が1つ出ることを対照として並べる。**
 * - **7本目は他の6本と順序に依らない** —— **表を1つも増やさず、役割の規則を1本も
 *   書き換えない。** **触るのは `apps` 台帳の1列(`comment_visibility`)だけであり、
 *   他の6本はその列を1度も読まない。**
 * - **【誇張しない】7本目は「配る版では書けない」ことを1ミリも示していない** ——
 *   **書く口(`POST /api/apps/:app_id/comments`)は今日も1バイトも閉じていない**
 *   (`D-V10-38`)。**止まっているのは画面に欄を出すことだけである。**
 */
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import type { FormView, ListView, Manifest, RoleRule } from "../../src/kernel/types.ts";
import { fixture } from "./fixture-app.ts";

/**
 * **配る版が描くアプリのID。**
 *
 * **`package.json` の `test:e2e` が `GP_RUNNER_APP_ID` に渡す値と、
 * `web/e2e/fixture-server.ts` の `RUNNER_APP_ID` と、同じ綴りでなければならない**
 * (焼き込みなので、実行時に合わせ直す手段が無い)。
 */
const RUNNER_APP_ID = "runner-e2e";

/** ブラウザがアクセスする育成用の版の port(`playwright.config.ts` と同じ既定値)。 */
const port = Number(process.env.ST_E2E_PORT ?? 3210);
/** **配る版の port は育成用の版の隣**(`web/e2e/fixture-server.ts` と同じ組み方。数字を書かない)。 */
const runnerPort = port + 1;
const runnerBase = `http://localhost:${runnerPort}`;
/** 配る版の絶対 URL(`baseURL` は育成用の版を指しているので、相対では届かない)。 */
const runnerUrl = (path: string): string => `${runnerBase}${path}`;

/** **アプリIDが焼き込まれていないときに配る版が描く文言**(`web/src/runner-main.tsx` の逐語)。 */
const MISSING_APP_ID_MESSAGE = "どのアプリを表示するかが与えられていません。";

/**
 * **配る版の題材にする画面をフィクスチャから導く**(アプリ固有の名前を1つも書かない)。
 *
 * - `step1` … 定義順の先頭の `list_view`。
 * - `step2` … その表の `form`(流れの2段目)。
 * - `soloForm` … **参照を1つも持たない表の `form`** ——
 *   **自動で開いた先の描画が「参照先の表を読めるか」に左右されないようにするため**
 *   (`web/e2e/customer-signup.e2e.ts` の同じ選び方に倣う)。
 * - `otherForm` … 別の表の `form`(候補に入らない側)。
 */
const formViews = fixture.app.views.filter((view): view is FormView => view.type === "form");
const step1 = fixture.app.views.find((view): view is ListView => view.type === "list_view");
if (step1 === undefined) {
  throw new Error("フィクスチャが変わりました: list_view が1本もありません。");
}
const step2 = formViews.find((view) => view.table === step1.table);
if (step2 === undefined) {
  throw new Error("フィクスチャが変わりました: 一覧と同じ表の form がありません。");
}
const fixtureTable = (tableId: string) =>
  fixture.app.tables.find((candidate) => candidate.id === tableId);
const soloForm = formViews.find((view) =>
  (fixtureTable(view.table)?.fields ?? []).every((field) => field.type !== "reference"),
);
if (soloForm === undefined) {
  throw new Error("フィクスチャが変わりました: 参照を持たない表の form が1本もありません。");
}
const otherForm = formViews.find((view) => view.table !== soloForm.table);
if (otherForm === undefined) {
  throw new Error("フィクスチャが変わりました: 別の表の form が1本もありません。");
}

/** 配る版のアプリに owner のセッションを1つ仕込み、その cookie の材料を返す。 */
async function seedOwner(
  request: APIRequestContext,
): Promise<{ name: string; value: string; path: string; headers: { cookie: string } }> {
  const seeded = await request.post(`/__e2e__/apps/${RUNNER_APP_ID}/session`);
  expect(seeded.status(), await seeded.text()).toBe(201);
  const spec = (await seeded.json()) as { name: string; value: string; path: string };
  return { ...spec, headers: { cookie: `${spec.name}=${spec.value}` } };
}

/**
 * **配る版が描いていることを確かめる共通の関門**(完了条件 (c))。
 *
 * **焼き込みが外れたビルドを掴んでいると、配る版は白くならずに
 * 「{@link MISSING_APP_ID_MESSAGE}」と書く**(`web/src/runner-main.tsx`)——
 * **`bun test` の `web/test/runner-entry-boundary.test.ts` が
 * `web/runner/dist` をアプリID無しで建て直すので、この取り違えは実際に起こりうる。**
 */
async function expectRunnerRendered(page: Page): Promise<void> {
  expect(await page.getByText(MISSING_APP_ID_MESSAGE).count()).toBe(0);
}

test.describe("V10-M7-T05 配る版を本物のブラウザで押す(chromium 実測)", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "配る版の実測は1つのブラウザで足りる(`web/e2e/flow-steps.e2e.ts` と同じ理由)",
  );

  /**
   * **配る版のマニフェストを差し替える**(口は育成用の版の側にある `/__e2e__/*` である)。
   *
   * **いま適用されている定義を読んでから書き換える** —— **`applyManifest` は追加しか
   * 許さないので、フィクスチャの素の JSON を投げ直すと、先に走った検査が足した
   * `st_owner` を消すことになり拒否される。**
   *
   * **一般利用者(`customer`)の規則は追記ではなく差し替えである** ——
   * **候補の本数をここ1箇所で決めるためである。**
   */
  async function declare(
    request: APIRequestContext,
    options: {
      personalTables: string[];
      customerViews: string[];
      /**
       * **既存の `form` を種にして、同じ表の `form` をもう1本足す**
       * (**候補を2本にするため**。`V10-M19-T01`)。
       *
       * **表を1つも増やさない** —— **`st_owner` を足す表は種と同じなので、
       * 「候補が0本」を作る他の検査(3本目 / 6本目)の前提を1バイトも動かさない。**
       * **既に在れば足さない**(`applyManifest` は追加しか許さない)。
       */
      cloneForm?: { source: string; id: string };
    },
  ): Promise<void> {
    const { headers } = await seedOwner(request);
    const got = await request.get(`/api/apps/${RUNNER_APP_ID}/manifest`, { headers });
    expect(got.status(), await got.text()).toBe(200);
    const next = (await got.json()) as Manifest;

    for (const tableId of options.personalTables) {
      const table = next.app.tables.find((candidate) => candidate.id === tableId);
      if (table === undefined) {
        throw new Error(`配る版のアプリに表 ${tableId} がありません。`);
      }
      // **既に在れば足さない**(2度目の追加はスキーマの重複で拒否される)。
      if (!table.fields.some((field) => field.id === "st_owner")) {
        table.fields.push({ id: "st_owner", name: "所有者", type: "text" });
      }
    }

    if (options.cloneForm !== undefined) {
      const { source, id } = options.cloneForm;
      if (!next.app.views.some((candidate) => candidate.id === id)) {
        const seed = next.app.views.find((candidate) => candidate.id === source);
        if (seed === undefined) {
          throw new Error(`配る版のアプリに画面 ${source} がありません。`);
        }
        next.app.views.push({ ...seed, id });
      }
    }

    const rules: RoleRule[] = options.customerViews.map(
      (viewId) => ({ target: "view", view: viewId, can: ["read"] }) as unknown as RoleRule,
    );
    const roles = next.app.roles ?? [];
    const customer = roles.find((role) => role.id === "customer");
    if (customer === undefined) {
      roles.push({ id: "customer", rules } as unknown as (typeof roles)[number]);
    } else {
      customer.rules = rules;
    }
    next.app.roles = roles;

    // ===================================================================================
    // **【`V10-M31-T03`。2026-08-25。旧行は下に逐語で残してある —— 1バイトも消していない】**
    //
    // **`GET /api/apps/:app_id/manifest` の応答は、`V10-M31-T01`(台帳 `CM-G38`)から
    // **マニフェストそのものではない** —— 定義(`app`)の隣に、アプリごとのコメントの
    // 設定(`comment_visibility`)が兄弟キーとして載るからである。**
    // **設定は `apps` 台帳の列であって定義ではない** —— **したがって、定義を差し替える口
    // (`POST /__e2e__/apps/:app_id/manifest`)へ渡してはいけない。`applyManifest` の
    // トップレベルは `app` のみを許すので、渡すと 400 で弾かれる**(実測でそうなった)。
    // **フィクスチャの受け口の側で黙って落とす形は採らなかった** —— **未知のトップレベルの
    // キーを飲み込むと、いま表に出たのと同じ型のずれが、次からは赤くならなくなるためである。**
    //
    // **旧行(逐語)**:
    //   const applied = await request.post(`/__e2e__/apps/${RUNNER_APP_ID}/manifest`, { data: next });
    const applied = await request.post(`/__e2e__/apps/${RUNNER_APP_ID}/manifest`, {
      data: { app: next.app },
    });
    expect(applied.status(), await applied.text()).toBe(200);
  }

  /** 配る版で、セルフサインアップ(**パスワード登録**)を押して一般利用者として入る。 */
  async function signUpOnRunner(page: Page, prefix: string): Promise<void> {
    await page.goto(runnerUrl(`/apps/${RUNNER_APP_ID}`));
    await expect(page.getByTestId("login-page")).toBeVisible();
    await page.getByTestId("auth-username").fill(`${prefix}-${Date.now()}`);
    await page.getByTestId("auth-password").fill("correct-horse-battery-staple");
    await page.getByTestId("customer-password-register").click();
  }

  // ===================================================================================
  // 1本目: 段の位置と「戻る」
  // ===================================================================================
  test("配る版で、いま何段目かと、段1・段2 の「戻る」が出る", async ({ page, request }) => {
    const owner = await seedOwner(request);
    const headers = owner.headers;

    // --- 2段の流れを宣言する(段1 = 一覧 / 段2 = 入力)-------------------------------
    const got = await request.get(`/api/apps/${RUNNER_APP_ID}/manifest`, { headers });
    expect(got.status(), await got.text()).toBe(200);
    const next = (await got.json()) as Manifest;
    for (const [index, viewId] of [step1.id, step2.id].entries()) {
      const view = next.app.views.find((candidate) => candidate.id === viewId);
      if (view === undefined) {
        throw new Error(`配る版のアプリに画面 ${viewId} がありません。`);
      }
      (view as { flow?: unknown }).flow = { id: "checkout", step: index + 1, kind: "input" };
    }
    // **【`V10-M31-T03`】`GET /manifest` の応答は `app` の隣に `comment_visibility` が載るので、
    // そのままでは定義を差し替える口へ渡せない**(400 になる)。**理由の全文は、同ファイルの
    // `declare()` が `POST /__e2e__/apps/:app_id/manifest` を呼ぶ直前の注記に在る**(写さない)。
    // **旧行(逐語)**:
    //   const applied = await request.post(`/__e2e__/apps/${RUNNER_APP_ID}/manifest`, { data: next });
    const applied = await request.post(`/__e2e__/apps/${RUNNER_APP_ID}/manifest`, {
      data: { app: next.app },
    });
    expect(applied.status(), await applied.text()).toBe(200);

    // --- **(b) の対照。配る版を測っていることの証拠** --------------------------------
    //
    // **定義を書き換える口(`POST /diffs`)は、`profile: "runner"` では1本も登録されない**
    // (`src/server/app.ts` の `profile === "full"` の分岐)。
    // **`GET` は SPA フォールバックで 200 になりうるので `POST` を採る。**
    // **育成用の版の側で同じ `POST` が 404 にならないことも並べる** ——
    // **並べないと「その口がそもそも無い」との区別がつかない。**
    const emptyDiff = { diff_id: "runner-probe", intent: "配る版かどうかを測る", operations: [] };
    const onRunner = await request.post(runnerUrl(`/api/apps/${RUNNER_APP_ID}/diffs`), {
      data: emptyDiff,
      headers,
    });
    expect([404, 405]).toContain(onRunner.status());
    const onGrowth = await request.post(`/api/apps/${RUNNER_APP_ID}/diffs`, {
      data: emptyDiff,
      headers,
    });
    expect(onGrowth.status()).not.toBe(404);
    expect(onGrowth.status()).not.toBe(405);

    // --- 段1 -----------------------------------------------------------------------
    // **cookie は port を区別しない** —— **育成用の版の URL で入れた cookie は、
    // 配る版の待ち受けにもそのまま飛ぶ**(`src/server/auth-routes.ts` の `setCookie` は
    // `path=/api/apps/:app_id` だけを指定し、domain を指定していない)。
    await page.context().addCookies([
      {
        name: owner.name,
        value: owner.value,
        url: `http://localhost:${port}${owner.path}`,
      },
    ]);
    await page.goto(runnerUrl(`/apps/${RUNNER_APP_ID}/views/${step1.id}`));
    await expectRunnerRendered(page);
    await expect(page.getByTestId("view-renderer-list_view")).toBeVisible();
    // **いま何段目 / 全部で何段**(`V10-M5-T02`)。**配る版でも出る。**
    await expect(page.getByTestId("flow-position")).toHaveText("1段目 / 全2段");
    expect(await page.getByTestId("flow-position").count()).toBe(1);
    // **押せる要素が1つも無い**(`<p>` である)。
    expect(await page.getByTestId("flow-position").locator("button, a, input").count()).toBe(0);
    // **【2026-08-21 に足した(`V10-M18-T03` / `FU-G3`)】** **段1(`list_view`)にも
    // 「戻る」が1つ出る。** **配る版に組み込まれた版でも、器へ移した実装が効いている**
    // (**この1行が、移送が配りものにも届いたことの実測である**)。
    expect(await page.getByTestId("flow-back").count()).toBe(1);
    await page.getByTestId("flow-next-button").click();

    // --- 段2 -----------------------------------------------------------------------
    await expect(page.getByTestId("view-renderer-form")).toBeVisible();
    await expect(page.getByTestId("flow-position")).toHaveText("2段目 / 全2段");
    const back = page.getByTestId("flow-back-button");
    await expect(back).toBeVisible();
    // **文言はマニフェストから1文字も取っていない**(表示層に固定の文字列)。
    await expect(back).toHaveText("戻る");

    // **押すのは画面上のボタンである**(`page.goBack()` を1度も呼んでいない)。
    await back.click();
    await expect(page.getByTestId("view-renderer-list_view")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(`/apps/${RUNNER_APP_ID}/views/${step1.id}`);
    // **戻った先も配る版のまま**(育成用の版へ飛び移っていない)。
    expect(new URL(page.url()).port).toBe(String(runnerPort));
  });

  // ===================================================================================
  // 2本目: 候補がちょうど1本なら自動で開く
  // ===================================================================================
  test("配る版で、会員登録の直後に候補がちょうど1本なら、その入力画面が自動で開く", async ({
    page,
    request,
  }) => {
    await declare(request, {
      personalTables: [soloForm.table],
      customerViews: [soloForm.id],
    });

    await signUpOnRunner(page, "runner-solo");
    await expectRunnerRendered(page);
    await expect(page.getByTestId("current-role")).toHaveAttribute("data-role", "customer");

    // **URL がその `form` のものになっている**(押していないのに、そこに着いている)。
    await expect(page).toHaveURL(
      new RegExp(`^${runnerBase}/apps/${RUNNER_APP_ID}/views/${soloForm.id}$`),
    );
    // **その画面が実際に描かれている**(URL だけが変わったのではない)。
    await expect(page.getByTestId("view-renderer-form")).toBeVisible();
  });

  // ===================================================================================
  // 3本目: 候補が0本のときは何も起きない(**今日まで誰も測っていない**)
  // ===================================================================================
  test("配る版で、会員登録の直後に候補が0本なら、何も起きない", async ({ page, request }) => {
    // **一般利用者が読める `form` は在るが、その表は個人ごとに行を持たない** ——
    // **したがって候補は0本である。** **「画面が1枚も無い」ではないことを、下で示す。**
    await declare(request, { personalTables: [], customerViews: [otherForm.id] });

    await signUpOnRunner(page, "runner-zero");
    await expectRunnerRendered(page);
    await expect(page.getByTestId("current-role")).toHaveAttribute("data-role", "customer");

    // **画面の並びには、その `form` が1本出ている**(読める画面はある)。
    await expect(page.getByTestId("view-list")).toBeVisible();
    expect(await page.getByTestId("view-list-empty").count()).toBe(0);

    // **URL は1文字も変わっていない。** **何も起きないことを測るので、待ってから見る。**
    const landed = page.url();
    expect(landed).toBe(runnerUrl(`/apps/${RUNNER_APP_ID}`));
    await page.waitForTimeout(500);
    expect(page.url()).toBe(landed);
    expect(await page.getByTestId("view-renderer-form").count()).toBe(0);
  });

  // ===================================================================================
  // 4本目: 育成用の版に出る案内が、配る版にも出る(**向きを反転させた**)
  // ===================================================================================
  /**
   * **根拠は `D-V10-11` ではなく `V10-M6` の実装である。**
   *
   * **`D-V10-11` の選択肢の逐語は、配る版について1文字も述べていない。**
   * **「配る版には案内を1バイトも足していない」と書いているのは
   * `web/src/runner-app.tsx` の doc であり、案内(`customer-signup-next`)を描く
   * `<Alert>` は `web/src/AppWorkspace.tsx` にしか無い**(2026-08-21 実測:
   * `data-testid="customer-signup-next"` の当たりは `web/src/` で1ファイル1箇所)。
   * **本検査はその実装をブラウザで確かめるものであって、決定の字面を確かめるものではない。**
   *
   * ## 【2026-08-22 訂正(`V10-M19-T01` / `FU-G6` / `ADR-0363`)。旧文を1バイトも消していない】
   *
   * **すぐ上の実測は今日は偽である。** **案内を描く `<Alert>` は
   * `web/src/auth/SignupNextNotice.tsx` に移り、育成用の版と配る版の両方がその1本を呼ぶ**
   * (`data-testid="customer-signup-next"` の当たりは今日も `web/src/` で1ファイル1箇所だが、
   * **そのファイルは `AppWorkspace.tsx` ではない**)。
   * **旧の名前の逐語**: 「**配る版に、育成用の版に出る案内(customer-signup-next)が1つも出ない**」。
   * **旧の期待値の逐語**:
   * `expect(await page.getByTestId("customer-signup-next").count()).toBe(0);`
   * **選び直したのはユーザ決定 `D-V10-17` である。**
   */
  test("配る版にも、育成用の版と同じ案内(customer-signup-next)が出る", async ({
    page,
    request,
  }) => {
    // **候補が1本ある状態にする** —— **育成用の版なら案内が出る局面である**
    // (0本の局面で測ると、「配る版だから出ない」のか「候補が無いから出ない」のか区別できない)。
    await declare(request, {
      personalTables: [soloForm.table],
      customerViews: [soloForm.id],
    });

    // --- 配る版: 出る ---------------------------------------------------------------
    await signUpOnRunner(page, "runner-notice");
    await expectRunnerRendered(page);
    await expect(page.getByTestId("current-role")).toHaveAttribute("data-role", "customer");
    // 自動で開いた先(候補1本なので開く)。**案内は自動遷移の後も残る。**
    await expect(page.getByTestId("view-renderer-form")).toBeVisible();
    const runnerNotice = page.getByTestId("customer-signup-next");
    await expect(runnerNotice).toBeVisible();
    expect(await runnerNotice.count()).toBe(1);
    // **文面は育成用の版と同じ1本である**(`ADR-0363` 限定1 / 限定2)。
    await expect(runnerNotice).toContainText("登録が終わりました。");
    // **閉じられる。** **閉じたら消える**(セッションのあいだ居座らせない)。
    await page.getByTestId("customer-signup-next-dismiss").click();
    await expect(runnerNotice).toHaveCount(0);

    // --- 対照。育成用の版: 同じアプリ・同じ定義・同じ押し方で出る ---------------------
    await page.getByTestId("logout").click();
    await expect(page.getByTestId("login-page")).toBeVisible();

    await page.goto(`/apps/${RUNNER_APP_ID}`);
    await expect(page.getByTestId("login-page")).toBeVisible();
    await page.getByTestId("auth-username").fill(`growth-notice-${Date.now()}`);
    await page.getByTestId("auth-password").fill("correct-horse-battery-staple");
    await page.getByTestId("customer-password-register").click();
    await expect(page.getByTestId("current-role")).toHaveAttribute("data-role", "customer");
    await expect(page.getByTestId("customer-signup-next")).toBeVisible();
  });

  // ===================================================================================
  // 5本目: 候補が2本のときの配る版の見え方(**今日まで誰も測っていない**)
  // ===================================================================================
  /**
   * **本ファイルの冒頭が「配る版で「候補が2本以上」のときの見え方を1件も測っていない」と
   * 自認していた穴を、ここで塞ぐ**(`CP-V10-FOLLOWUP` 条件6)。
   *
   * **表を1つも増やしていない** —— **種の `form` と同じ表に `form` をもう1本足すだけである。**
   * **したがって「候補が0本」を作る3本目 / 6本目の前提(その表に `st_owner` が無いこと)を
   * 1バイトも動かさない。**
   */
  test("配る版で、候補が2本なら案内が1つ出て、導線が2本並ぶ", async ({ page, request }) => {
    const secondFormId = `${soloForm.id}-2`;
    await declare(request, {
      personalTables: [soloForm.table],
      customerViews: [soloForm.id, secondFormId],
      cloneForm: { source: soloForm.id, id: secondFormId },
    });

    await signUpOnRunner(page, "runner-two");
    await expectRunnerRendered(page);
    await expect(page.getByTestId("current-role")).toHaveAttribute("data-role", "customer");

    // **自動では開かない** —— **URL は1文字も変わらない**(2本以上のときの規約)。
    expect(page.url()).toBe(runnerUrl(`/apps/${RUNNER_APP_ID}`));
    const notice = page.getByTestId("customer-signup-next");
    await expect(notice).toBeVisible();
    expect(await notice.count()).toBe(1);
    // **候補が2本とも導線として並ぶ**(1本に決め打っていない)。
    expect(await notice.locator("a").count()).toBe(2);
  });

  // ===================================================================================
  // 6本目: 候補が0本なら、どちらの版でも案内が1つも出ない
  // ===================================================================================
  /**
   * **`ADR-0363` §Decision 3(ユーザ決定 `D-V10-24`)を、両方の版でブラウザから固定する。**
   * **「画面が1枚も無い」ではないことも並べる** —— **読める `form` は1本ある。**
   */
  test("候補が0本なら、配る版でも育成用の版でも案内が1つも出ない", async ({ page, request }) => {
    await declare(request, { personalTables: [], customerViews: [otherForm.id] });

    // --- 配る版 ---------------------------------------------------------------------
    await signUpOnRunner(page, "runner-none");
    await expectRunnerRendered(page);
    await expect(page.getByTestId("current-role")).toHaveAttribute("data-role", "customer");
    await expect(page.getByTestId("view-list")).toBeVisible();
    expect(await page.getByTestId("view-list-empty").count()).toBe(0);
    expect(await page.getByTestId("customer-signup-next").count()).toBe(0);
    expect(await page.getByTestId("customer-signup-next-dismiss").count()).toBe(0);

    // --- 育成用の版: 同じ定義・同じ押し方でも出ない ----------------------------------
    await page.getByTestId("logout").click();
    await expect(page.getByTestId("login-page")).toBeVisible();

    await page.goto(`/apps/${RUNNER_APP_ID}`);
    await expect(page.getByTestId("login-page")).toBeVisible();
    await page.getByTestId("auth-username").fill(`growth-none-${Date.now()}`);
    await page.getByTestId("auth-password").fill("correct-horse-battery-staple");
    await page.getByTestId("customer-password-register").click();
    await expect(page.getByTestId("current-role")).toHaveAttribute("data-role", "customer");
    await expect(page.getByTestId("view-list")).toBeVisible();
    expect(await page.getByTestId("customer-signup-next").count()).toBe(0);
  });

  // ===================================================================================
  // 7本目: 配る版には、設定を ON に倒しても書く欄が1要素も出ない
  // ===================================================================================
  /**
   * **`V10-M33-T01`。台帳 `CM-G43`。利用者決定 `D-V10-39`。**
   *
   * ## **何を測るのか**
   *
   * **配る版の画面に、コメントの書く欄が1要素も出ないこと。**
   * **設定(`comment_visibility.write`)を ON に倒したうえで測る** ——
   * **OFF のまま測ると、「配る版だから出ない」のか「設定が OFF だから出ない」のかを
   * 1ミリも区別できない**(4本目が案内について踏んだのと同じ理由)。
   * **同じアプリ・同じ設定・同じ立場を育成用の版で開くと欄が1つ出ることを、対照として
   * 並べる** —— **並べないと、この検査は「そもそも画面が描けていない」でも緑になる。**
   *
   * ## **【誇張しない】ここで測っていないこと**
   *
   * 1. **書く口(`POST /api/apps/:app_id/comments`)を1バイトも閉じていない**
   *    (`D-V10-38`)—— **配る版でもその口は今日どおり応答を返す。**
   *    **止まっているのは画面に欄を出すことだけである。**
   * 2. **`web/runner/dist` のバイト列を1バイトも見ていない** —— **それは
   *    `web/test/runner-entry-boundary.test.ts` の (b) の担当である**(本検査はブラウザで
   *    描かれた DOM だけを見る)。**片方だけでは足りない** —— **DOM に出ないことは
   *    「入っていない」ことを意味しないし、バイト列に無いことは「描かれない」ことの
   *    ブラウザでの実測ではない。**
   * 3. **読む場所(`comment-list` / `open-comment-list`)は配る版で1度も測っていない** ——
   *    **それは育成用の版の器(`web/src/AppWorkspace.tsx`)にしか無く、配る版は
   *    着手前から1要素も描いていない**(`V10-M33-T01` が外したのではない)。
   */
  test("配る版には、設定を ON に倒しても書く欄が1要素も出ない(育成用の版では出る)", async ({
    page,
    request,
  }) => {
    const owner = await seedOwner(request);

    // --- 設定を ON に倒す(E2E の足場の口。製品の HTTP には書く口が1本も無い)-------
    // **綴りは `web/e2e/fixture-server.ts` の `COMMENT_VISIBILITY_PATH_PATTERN` と
    // 1バイトも違ってはならない。**
    const flipped = await request.post(`/__e2e__/apps/${RUNNER_APP_ID}/comment-visibility`, {
      data: { write: true },
    });
    expect(flipped.status(), await flipped.text()).toBe(200);
    const payload = (await flipped.json()) as {
      comment_visibility: { write: boolean; read: boolean };
    };
    // **倒した後の実物が返る**(カーネルが `UPDATE` の後に読み直した値)。
    expect(payload.comment_visibility.write).toBe(true);

    await page.context().addCookies([
      {
        name: owner.name,
        value: owner.value,
        url: `http://localhost:${port}${owner.path}`,
      },
    ]);

    // --- 配る版: 1要素も出ない -------------------------------------------------------
    await page.goto(runnerUrl(`/apps/${RUNNER_APP_ID}/views/${step1.id}`));
    await expectRunnerRendered(page);
    // **画面そのものは出ている** —— **「欄が0要素」が「読み込みに失敗した」ことの
    // 言い換えでないことを、先に固定する。**
    await expect(page.getByTestId("view-renderer-list_view")).toBeVisible();
    // **0要素である**(`toBeHidden` ではない —— **描いてから隠しているのではなく、
    // 器が `null` を返して1要素も作っていない**)。
    expect(await page.getByTestId("comment-panel").count()).toBe(0);
    expect(await page.getByTestId("comment-body").count()).toBe(0);
    expect(await page.getByTestId("comment-submit").count()).toBe(0);
    expect(await page.getByTestId("comment-sent").count()).toBe(0);
    // **前置きの文言も1つも出ない**(`data-testid` を持たないので文字列で見る)。
    expect(await page.getByText("直したいところを書いて送れます").count()).toBe(0);
    // **配る版のまま測っている**(育成用の版へ飛び移っていない)。
    expect(new URL(page.url()).port).toBe(String(runnerPort));

    // --- 対照。育成用の版: 同じアプリ・同じ設定・同じ立場で出る ----------------------
    await page.goto(`/apps/${RUNNER_APP_ID}/views/${step1.id}`);
    await expect(page.getByTestId("view-renderer-list_view")).toBeVisible();
    await expect(page.getByTestId("comment-panel")).toBeVisible();
    await expect(page.getByTestId("comment-body")).toBeVisible();
    await expect(page.getByTestId("comment-submit")).toBeVisible();
    expect(new URL(page.url()).port).toBe(String(port));
  });
});
