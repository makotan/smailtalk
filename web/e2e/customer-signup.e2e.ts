/**
 * 顧客セルフサインアップ導線とロール変更 UI の4値化の E2E(V3-M3-T03 / D-G12a)。
 *
 * 完了条件7(`docs/plan/v3/records/v3-m3.md` §2 の T03)が要求するのは
 * 「**E2E で実際に customer を作ってログインし、customer ロールが付くことを確かめる**」
 * である。単体(happy-dom)は fetch のスタブ越しにしか見ていないので、**サーバの
 * `CUSTOMER_SIGNUP.resolveRole` が本当に `customer` を返し、それがヘッダに出る**ところまでは
 * ここでしか実証できない。
 *
 * 検証点:
 *   1. パスワードで顧客登録 → ワークスペースに入り、**現在ロールが「顧客」**になる。
 *   2. ログアウト → 同じ資格情報でログインし直しても customer のまま(付いたロールは残る)。
 *   3. **Passkey でも**顧客登録できる(D-M3-2 = 両方)。実 WebAuthn 儀式を CDP の仮想
 *      オーセンティケータで通す(`auth.e2e.ts` と同じ作法。chromium 専用)。
 *   4. 同じ画面の**管理登録は customer にならない**(区別が実際に効いている)。
 *   5. owner が既存ユーザを customer にするとき、**警告と確認を挟む**(D-M3-3)。
 *      **やめれば PATCH は飛ばず、確認すれば飛ぶ** —— 構造で禁じてはいない。
 *
 * ## ここで証明していないこと(先に書く)
 *
 * - **customer になった後にどの画面が見え、どの操作が 403 になるか**は見ていない
 *   (それは D-G12b / V3-M3-T04 と `web/e2e/owner-scope.e2e.ts` の担当)。
 * - **登録が禁止された環境(`ST_AUTH_ALLOW_REGISTRATION=false`)の挙動**は見ていない。
 *   E2E のフィクスチャサーバは既定(=登録可)で動いており、env を切り替える経路を
 *   本タスクでは作っていない。403 の表示は単体(`web/test/customer-signup.test.tsx`)止まりである。
 */
import { type CDPSession, expect, type Page, test } from "@playwright/test";
import type { Manifest, RoleRule } from "../../src/kernel/types.ts";
import { buildRecord, fixture, provisionApp, seedRoleSession } from "./fixture-app.ts";

test.describe("顧客セルフサインアップ(D-G12a)", () => {
  test("パスワードで顧客登録すると customer ロールが付く", async ({ page, request }) => {
    const app = await provisionApp(request);

    await page.goto(`/apps/${app.appId}`);
    await expect(page.getByTestId("login-page")).toBeVisible();
    // 画面の中に「どちらを押すか」の説明がある(完了条件2)。
    await expect(page.getByTestId("customer-signup")).toBeVisible();
    await expect(page.getByTestId("admin-signup-note")).toBeVisible();

    const username = `shopper-${Date.now()}`;
    const password = "correct-horse-battery-staple";

    await page.getByTestId("auth-username").fill(username);
    await page.getByTestId("auth-password").fill(password);
    await page.getByTestId("customer-password-register").click();

    // 登録成功 = 認証済みワークスペースに遷移し、ヘッダのロールが customer の表示名になる。
    //
    // **【`V5-M13` / `G-G4`】着手前は逐語 `toHaveText("顧客")` だった。** 表示名が
    // 「一般利用者」に変わったので文字列を差し替えた(`docs/plan/v5/records/v5-m13.md` §5)。
    // **正は `web/src/auth/authz.tsx` の `ROLE_LABELS.customer` である** —— ここから
    // `import` していないのは、`web/e2e/` が `web/src/` を1本も import していない
    // (2026-08-05 実測: `grep -rn 'from "../src' web/e2e/*.ts` が0件)ためで、
    // playwright の変換に React 部品を持ち込む先例を本タスクで作らない判断による。
    // **したがってこの1行は表示名を二重に持っている。`V5-M17` が表示名を作り替えるとき、
    // ここも直す必要がある**(単体側 `web/test/customer-signup.test.tsx` は `ROLE_LABELS`
    // から引いているので自動で追従するが、この行は追従しない)。
    //
    // **【`V5-M17` が読んで確かめた。文字列は変えていない】** **`ROLE_LABELS` は
    // `roleLabels(kinds)` に置き換わり、固定4値のマップではなくなった**(`ADR-0159` 限定5)。
    // **それでも「宣言が無いアプリの非運営の表示名」は今日も「一般利用者」である**
    // (`web/src/auth/authz.tsx` の `DEFAULT_USER_KIND_LABEL`)。**このアプリ
    // (`web/e2e/` が立てる参照アプリ)は `user_kinds` を1つも宣言していないので、
    // 期待値は1文字も変わらない。****正の置き場は `ROLE_LABELS.customer` から
    // `DEFAULT_USER_KIND_LABEL` に移った。**
    // **`data-role` が `customer` のままであることも、宣言が無いアプリの既定が
    // `customer` だからである**(`ADR-0158` 限定3)。
    // **【この e2e を1度も実行していない】** —— `V5-M17` は playwright を1度も走らせて
    // いない(記録 `docs/plan/v5/records/v5-m17.md` §13 の 3)。
    await expect(page.getByTestId("current-user")).toHaveText(username);
    await expect(page.getByTestId("current-role")).toHaveAttribute("data-role", "customer");
    await expect(page.getByTestId("current-role")).toHaveText("一般利用者");
    // customer なので owner 専用導線は出ない(既存の出し分け。T03 は触っていない)。
    await expect(page.getByTestId("open-user-admin")).toHaveCount(0);

    // --- ログアウト → 同じ資格情報でログイン ------------------------------------
    await page.getByTestId("logout").click();
    await expect(page.getByTestId("login-page")).toBeVisible();
    await page.getByTestId("auth-username").fill(username);
    await page.getByTestId("auth-password").fill(password);
    await page.getByTestId("password-login").click();
    await expect(page.getByTestId("current-role")).toHaveAttribute("data-role", "customer");
  });

  test("同じ画面の管理登録は customer にならない(区別が効いている)", async ({ page, request }) => {
    const app = await provisionApp(request);

    await page.goto(`/apps/${app.appId}`);
    await expect(page.getByTestId("login-page")).toBeVisible();

    const username = `staff-${Date.now()}`;
    await page.getByTestId("auth-username").fill(username);
    await page.getByTestId("auth-password").fill("correct-horse-battery-staple");
    await page.getByTestId("password-register").click();

    await expect(page.getByTestId("current-user")).toHaveText(username);
    // 払い出し時に owner が1人居るので、管理経路の2人目は viewer になる。
    // 見たいのは「customer ではない」ことなので、値そのものより否定を固定する。
    const role = await page.getByTestId("current-role").getAttribute("data-role");
    expect(role).not.toBe("customer");
  });

  test("Passkey でも顧客登録できる(D-M3-2 = 両方)", async ({ page, request, browserName }) => {
    test.skip(browserName !== "chromium", "WebAuthn 仮想オーセンティケータは chromium(CDP)専用");
    const app = await provisionApp(request);

    const client: CDPSession = await page.context().newCDPSession(page);
    await client.send("WebAuthn.enable");
    const { authenticatorId } = await client.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: false,
      },
    });

    await page.goto(`/apps/${app.appId}`);
    await expect(page.getByTestId("login-page")).toBeVisible();

    const username = `pk-shopper-${Date.now()}`;
    await page.getByTestId("auth-username").fill(username);
    await client.send("WebAuthn.setAutomaticPresenceSimulation", {
      authenticatorId,
      enabled: true,
    });
    try {
      await page.getByTestId("customer-passkey-register").click();
      await expect(page.getByTestId("current-user")).toHaveText(username);
    } finally {
      await client.send("WebAuthn.setAutomaticPresenceSimulation", {
        authenticatorId,
        enabled: false,
      });
    }
    await expect(page.getByTestId("current-role")).toHaveAttribute("data-role", "customer");
    // 資格情報が実際に1件作られている(儀式が本当に通った)。
    const { credentials } = await client.send("WebAuthn.getCredentials", { authenticatorId });
    expect(credentials.length).toBe(1);
  });
});

test.describe("ロール変更 UI の4値化と降格警告(D-M3-3)", () => {
  test("owner が editor を customer にするとき、警告と確認を挟む", async ({ page, request }) => {
    const app = await provisionApp(request); // 既定セッション = owner
    const editor = await seedRoleSession(request, app.appId, "editor");

    // -----------------------------------------------------------------------------------
    // **【2026-08-13。`V8-M38`。台帳 `F-G9`。判定値 = 限定採用(門外 `Δ7`)】**
    // **この4行を足した。** **下の検査は1本も消していない。**
    //
    // **`baseRoleValues()` が `customer` を無条件に足すのをやめたので、`customer` を
    // 1度も宣言していないアプリのセレクトは3値になった** ——
    // **E2E のフィクスチャ(`fixtures/valid/inventory-all-field-types.json`)は
    // `customer` を宣言していない**(`web/e2e/fixture-server.ts` の注入も、
    // 個人所有・公開の表を1つも持たないこの題材には `customer` の規則を足さない)。
    //
    // **測っている中身(4値目が出る / 降格に確認を挟む / 確認すれば本当に変わる)を
    // 1ミリも変えないために、題材の側に `customer` を宣言させる。**
    // **差し替えの口は既存のもの**(`POST /__e2e__/apps/:app_id/manifest`。
    // `record-navigation.e2e.ts` / `owner-scope.e2e.ts` と同じ作法)。
    // -----------------------------------------------------------------------------------
    const declared = structuredClone(app.manifest) as typeof app.manifest & {
      app: { roles?: { id: string; name?: string; rules?: unknown[] }[] };
    };
    const roles = declared.app.roles ?? [];
    if (!roles.some((role) => role.id === "customer")) {
      roles.push({
        id: "customer",
        rules: [{ target: "view", view: app.manifest.app.views[0]?.id, can: ["read"] }],
      });
    }
    declared.app.roles = roles;
    const withCustomer = await request.post(`/__e2e__/apps/${app.appId}/manifest`, {
      data: declared,
    });
    expect(withCustomer.status(), await withCustomer.text()).toBe(200);

    await app.authenticate(page.context());
    await page.goto(`/apps/${app.appId}`);
    await page.getByTestId("open-user-admin").click();
    await expect(page.getByTestId("user-admin")).toBeVisible();

    const editorRow = page.locator(`[data-testid="user-row"][data-user-id="${editor.userId}"]`);
    const roleSelect = editorRow.getByTestId("role-select");
    await expect(roleSelect).toHaveValue("editor");
    // 4値目(顧客)が選択肢に出ている。
    await expect(roleSelect.locator("option")).toHaveCount(4);
    await expect(roleSelect.locator('option[value="customer"]')).toHaveCount(1);

    // --- 選ぶと警告が出る。まだ変わっていない --------------------------------
    await roleSelect.selectOption("customer");
    await expect(page.getByTestId("role-demotion-warning")).toBeVisible();
    await expect(page.getByTestId("role-demotion-warning")).toContainText("運営");
    await expect(roleSelect).toHaveValue("editor");

    // --- やめる: ロールは元のまま ---------------------------------------------
    await page.getByTestId("cancel-role-demotion").click();
    await expect(page.getByTestId("role-demotion-warning")).toHaveCount(0);
    await expect(roleSelect).toHaveValue("editor");
    // サーバ側でも変わっていない(その editor は依然として書ける = 403 にならない)。
    const stillEditor = await request.get(`/api/apps/${app.appId}/auth/me`, {
      headers: editor.authHeaders,
    });
    expect(stillEditor.status()).toBe(200);
    expect(((await stillEditor.json()) as { user: { role: string } }).user.role).toBe("editor");

    // --- 確認すると本当に customer になる(構造では禁じていない)---------------
    await roleSelect.selectOption("customer");
    await expect(page.getByTestId("role-demotion-warning")).toBeVisible();
    await page.getByTestId("confirm-role-demotion").click();
    await expect(page.getByTestId("role-demotion-warning")).toHaveCount(0);
    await expect(roleSelect).toHaveValue("customer");

    const nowCustomer = await request.get(`/api/apps/${app.appId}/auth/me`, {
      headers: editor.authHeaders,
    });
    expect(((await nowCustomer.json()) as { user: { role: string } }).user.role).toBe("customer");
  });
});

/**
 * **登録の直後、行き先の候補がちょうど1本のときだけ、その画面が自動で開く**
 * (`V10-M6-T02` / `NV-G14`。実装は `web/src/auth/signup-next.ts` の `useSignupAutoOpen`)。
 *
 * ## 【なぜここに足すのか】
 *
 * **単体(`web/test/signup-auto-open.test.tsx`)は happy-dom であり、実ブラウザの
 * `history.pushState` を1度も通していない**(そのファイルの冒頭が自分でそう書いている)。
 * **本ファイルは実ブラウザでセルフサインアップを押す唯一の場所である**ので、
 * 「登録を押したら本当にその画面に着く」ところはここでしか実証できない。
 *
 * ## 【題材の作り方。名前を書かずに導く】
 *
 * **フィクスチャはどの表にも `st_owner` を宣言していないので、候補は既定で0本である。**
 * **そこで `POST /__e2e__/apps/:app_id/manifest` で `st_owner` を**1本の表にだけ**足す**
 * (差し替えの口は既存のもの。`record-navigation.e2e.ts` / 上の `D-M3-3` と同じ作法)。
 * **役割の規則は1本も書かない** —— **`web/e2e/fixture-server.ts` の `grantFixtureRoleRules` が
 * 「個人ごとに行を持つ表」と「その表の画面」に既定の規則を配る。**
 * **表を名指しした規則を自分で書くと、その配りが丸ごと止まる**(`namedTable` が真になる)。
 *
 * ## 【ここで測っていないこと。先に書く】
 *
 * - **配る版(実行専用の版。`web/src/runner-app.tsx`)をブラウザで1度も動かしていない。**
 *   **`web/e2e/` が立てるのは育成用の版だけである**(配る版の実証は単体
 *   `web/test/runner-signup-auto-open.test.tsx` 止まりである)。
 * - **Passkey 登録の直後に自動で開くかを測っていない**(押しているのはパスワード登録のボタンだけ)。
 * - **候補が2本以上のときの並び順を1件も測っていない**(先頭を選ぶ規約が無いので、測る対象が無い)。
 */
test.describe("登録の直後に自動で開く(NV-G14)", () => {
  /**
   * **自動で開く先に選ぶ画面**(名前を書かずにフィクスチャから導く)。
   *
   * **`reference` を1つも持たない表の `form`** を選ぶ —— **自動で開いた先の描画が
   * 「参照先の表を読めるか」に左右されないようにするためである。**
   */
  const formViews = fixture.app.views.filter((view) => view.type === "form");
  const fixtureTable = (tableId: string | undefined) =>
    fixture.app.tables.find((candidate) => candidate.id === tableId);
  const soloForm = formViews.find((view) =>
    (fixtureTable(view.table)?.fields ?? []).every((field) => field.type !== "reference"),
  );
  if (soloForm === undefined || soloForm.table === undefined) {
    throw new Error("フィクスチャが変わりました: 参照を持たない表の form が1本もありません。");
  }
  /** もう1本の候補に使う `form`(別の表のもの)。 */
  const otherForm = formViews.find((view) => view.table !== soloForm.table);
  if (otherForm === undefined || otherForm.table === undefined) {
    throw new Error("フィクスチャが変わりました: 別の表の form が1本もありません。");
  }

  /**
   * **指定した表に `st_owner`(個人ごとに行を持つ規約)を足し、その表の `form` を
   * 一般利用者(`customer`)に開かせるマニフェストを返す。**
   *
   * **【`grantFixtureRoleRules` に任せられない。理由を書く】**
   * **`provisionApp` が返すマニフェストには、既に `grantFixtureRoleRules` が配った
   * 面の規則が入っている**(払い出しのときに1度通っている)。**その規則は表も画面も
   * 名指ししているので、差し替えのときにもう1度通しても `namedTable` / `namedView` が
   * 真になり、1本も足されない** —— **`st_owner` を後から足しても、一般利用者の規則は
   * 生えてこない。** **したがってここで自分で足す。**
   *
   * **足すのは画面の読取だけで、表は名指ししない**(`canUseView` は今日
   * `judgeRoleAccess(view, read)` 1本で決まる。`web/src/auth/authz.tsx` の
   * `canReadTableRole` は常に真を返す)。
   */
  function withPersonalTables(source: Manifest, tableIds: string[]): Manifest {
    const next = structuredClone(source);
    const viewIds: string[] = [];
    for (const tableId of tableIds) {
      const table = next.app.tables.find((candidate) => candidate.id === tableId);
      if (table === undefined) {
        throw new Error(`払い出したアプリに表 ${tableId} がありません。`);
      }
      table.fields.push({ id: "st_owner", name: "所有者", type: "text" });
      for (const view of next.app.views) {
        if (view.type === "form" && view.table === tableId) {
          viewIds.push(view.id);
        }
      }
    }
    const roles = next.app.roles ?? [];
    const rules: RoleRule[] = viewIds.map((viewId) => ({
      target: "view",
      view: viewId,
      can: ["read"],
    }));
    const customer = roles.find((role) => role.id === "customer");
    if (customer === undefined) {
      roles.push({ id: "customer", rules });
    } else {
      customer.rules = [...(customer.rules ?? []), ...rules];
    }
    next.app.roles = roles;
    return next;
  }

  /** セルフサインアップ(パスワード)を押して、一般利用者として入る。 */
  async function signUpAsCustomer(page: Page, appId: string): Promise<void> {
    await page.goto(`/apps/${appId}`);
    await expect(page.getByTestId("login-page")).toBeVisible();
    await page.getByTestId("auth-username").fill(`auto-open-${Date.now()}`);
    await page.getByTestId("auth-password").fill("correct-horse-battery-staple");
    await page.getByTestId("customer-password-register").click();
  }

  test("候補がちょうど1本なら、登録の直後にその入力画面が開く", async ({ page, request }) => {
    const app = await provisionApp(request);
    // **候補が1本になるように、`st_owner` を1本の表にだけ足す。**
    // もう一方の表は規約を持たないので、その `form` は候補に入らない。
    const replaced = await request.post(`/__e2e__/apps/${app.appId}/manifest`, {
      data: withPersonalTables(app.manifest, [soloForm.table as string]),
    });
    expect(replaced.status(), await replaced.text()).toBe(200);

    await signUpAsCustomer(page, app.appId);

    // 一般利用者として入っている(登録そのものは既存の検査と同じ形)。
    await expect(page.getByTestId("current-role")).toHaveAttribute("data-role", "customer");

    // **URL がその `form` のものになっている**(押していないのに、そこに着いている)。
    await expect(page).toHaveURL(new RegExp(`/apps/${app.appId}/views/${soloForm.id}$`));
    // **その画面が実際に描かれている**(URL だけが変わったのではない)。
    await expect(page.getByTestId("view-renderer-form")).toBeVisible();
    // 自動で開いても案内は消えない(候補が1本でも今日どおり描かれる)。
    await expect(page.getByTestId("customer-signup-next")).toBeVisible();

    // **【`V10-M6-T02` 完了条件(e)の実測】**
    // **保存を押さずに居るあいだ、行は1件も作られない** —— **自動で開くのは入力画面であって、
    // 自動処理の起点ではない。** 運営(owner)のセッションで数えるので、`st_owner` の
    // 絞り込みで見えていないだけ、ということが起きない(持ち主が空の行も読める規則が付く)。
    const rows = await request.get(
      `/api/apps/${app.appId}/tables/${soloForm.table as string}/records`,
      { headers: app.authHeaders },
    );
    expect(rows.status(), await rows.text()).toBe(200);
    expect(((await rows.json()) as { total: number }).total).toBe(0);
  });

  test("候補が2本なら自動で開かず、案内に2本並ぶ", async ({ page, request }) => {
    const app = await provisionApp(request);
    // **両方の表に `st_owner` を足す** → **候補は2本**になる。
    const replaced = await request.post(`/__e2e__/apps/${app.appId}/manifest`, {
      data: withPersonalTables(app.manifest, [soloForm.table as string, otherForm.table as string]),
    });
    expect(replaced.status(), await replaced.text()).toBe(200);

    await signUpAsCustomer(page, app.appId);
    await expect(page.getByTestId("current-role")).toHaveAttribute("data-role", "customer");

    // **案内には2本並ぶ**(どちらを先に出すかを決める口が1つも無いので、順序は問わない)。
    const notice = page.getByTestId("customer-signup-next");
    await expect(notice).toBeVisible();
    await expect(notice.locator("a")).toHaveCount(2);

    // **URL は1文字も変わっていない**(自動では開かない)。
    await expect(page).toHaveURL(new RegExp(`/apps/${app.appId}$`));
  });
});

/**
 * **登録の直後の候補から、見える範囲に行がある候補を落とす**
 * (`V10-M19-T02` / `FU-G7b` / `ADR-0364`。実装は `web/src/auth/signup-next.ts` の
 * `useSignupNextCandidates`)。
 *
 * ## 【題材の作り方。なぜ「共有行」なのか。丸めない】
 *
 * **ブリーフが求めた形は「同じ利用者で2度登録の導線を通す」だったが、それは製品では
 * 成り立たない** —— **案内と自動オープンが出る窓(`justSignedUpAsCustomer`)は
 * **アカウントが作られた瞬間**にだけ開き、作られたばかりの利用者は行を1件も持たない。**
 * **同じ利用者で2度アカウントを作ることはできない**(2度目は利用者名の重複で断られる)。
 * **したがって「2度目の登録」を実ブラウザで再現する道は無い。**
 *
 * **代わりに、登録した瞬間に**その人から見えている行**を1件用意する** ——
 * **`st_owner` を足す**前**に行を1件作ると、その行の持ち主は空のまま(共有行)になり、
 * 誰から見ても見える**(`src/server/owner-scope.ts` の `isOwnerVisible` /
 * `isSharedOwner`)。 **これは `ADR-0364` §S3 の 4 が「偽陽性」として名指しした経路
 * そのものである** —— **自分の行が1件も無くても候補が落ちる。**
 * **【禁止】これを「二重登録が防げることの実証」と読まない。** **ここで実証しているのは
 * 「登録直後の窓の中で、見える範囲に行がある候補が落ちる」ことだけである。**
 *
 * ## 【ここで測っていないこと。先に書く】
 *
 * - **偽陰性を1件も測っていない**(付与表を併用する表で、行が在っても0件に見える経路)。
 * - **配る版(`web/src/runner-app.tsx`)をブラウザで1度も動かしていない。**
 * - **読取の往復の回数を数えていない**(1候補につき1回であることは単体側の設計であり、
 *   ここでは「1本は返ってきた」ことしか待っていない)。
 */
test.describe("見える範囲に行がある候補を落とす(FU-G7b)", () => {
  const formViews = fixture.app.views.filter((view) => view.type === "form");
  const fixtureTable = (tableId: string | undefined) =>
    fixture.app.tables.find((candidate) => candidate.id === tableId);
  /** **参照を1つも持たない表の `form`** —— 自動で開いた先の描画が参照先に左右されない。 */
  const soloForm = formViews.find((view) =>
    (fixtureTable(view.table)?.fields ?? []).every((field) => field.type !== "reference"),
  );
  if (soloForm === undefined || soloForm.table === undefined) {
    throw new Error("フィクスチャが変わりました: 参照を持たない表の form が1本もありません。");
  }
  const otherForm = formViews.find((view) => view.table !== soloForm.table);
  if (otherForm === undefined || otherForm.table === undefined) {
    throw new Error("フィクスチャが変わりました: 別の表の form が1本もありません。");
  }

  /**
   * **指定した表に `st_owner` を足し、その表の `form` を一般利用者に開かせ、
   * かつその表の**行**を一般利用者に読ませる。**
   *
   * **【上の `NV-G14` の節の同名の関数との違い。実測で分かった。丸めない】**
   * **あちらは「画面の読取だけで、表は名指ししない」と書いており、あちらを1バイトも
   * 書き換えていない。** **本節はそれでは成り立たない** —— **表の規則が1本も無いと、
   * `GET .../records` は 200 で**必ず0件**を返す**(`src/server/app.ts` の
   * `roleGateBlocksWithoutGrants` が空の一覧に倒す)。 **実測**:
   * 表の規則を足す前は `{"records":[],"total":0}`、足したあとは同じ行が1件返った。
   * **したがって、表の規則を1本も持たない一般利用者では、この5つ目の関門は
   * 1度も発火しない**(候補は落ちない)。
   *
   * **【その代償も measured 通りに書く】** **条件を1つも書かない表の読取規則は
   * 所有者スコープを越える**(`roleReadCrossesOwnerScope`)—— **実測で、
   * 一般利用者に**他人が持ち主の行**まで見えた。** **本節の題材では行の見え方が
   * 広いので、落ちる条件も広い。** **【禁止】これを「自分の行が在るから落ちた」と読まない。**
   */
  function withPersonalTables(source: Manifest, tableIds: string[]): Manifest {
    const next = structuredClone(source);
    const viewIds: string[] = [];
    const readTables: string[] = [];
    for (const tableId of tableIds) {
      const table = next.app.tables.find((candidate) => candidate.id === tableId);
      if (table === undefined) {
        throw new Error(`払い出したアプリに表 ${tableId} がありません。`);
      }
      table.fields.push({ id: "st_owner", name: "所有者", type: "text" });
      readTables.push(tableId);
      for (const view of next.app.views) {
        if (view.type === "form" && view.table === tableId) {
          viewIds.push(view.id);
        }
      }
    }
    const roles = next.app.roles ?? [];
    const rules: RoleRule[] = [
      ...viewIds.map<RoleRule>((viewId) => ({
        target: "view",
        view: viewId,
        can: ["read"],
      })),
      ...readTables.map<RoleRule>((tableId) => ({
        target: "table",
        table: tableId,
        can: ["read"],
      })),
    ];
    const customer = roles.find((role) => role.id === "customer");
    if (customer === undefined) {
      roles.push({ id: "customer", rules });
    } else {
      customer.rules = [...(customer.rules ?? []), ...rules];
    }
    next.app.roles = roles;
    return next;
  }

  test("候補2本のうち片方に行が見えれば、その1本だけが落ち、残る1本が自動で開く", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    const seededTable = otherForm.table as string;
    // **`st_owner` を足す**前**に1行だけ作る** → **持ち主が空の行(誰からも見える)。**
    await app.createRecord(seededTable, buildRecord(app.tableOf(seededTable), 1, new Map()));

    const replaced = await request.post(`/__e2e__/apps/${app.appId}/manifest`, {
      data: withPersonalTables(app.manifest, [soloForm.table as string, seededTable]),
    });
    expect(replaced.status(), await replaced.text()).toBe(200);

    await page.goto(`/apps/${app.appId}`);
    await expect(page.getByTestId("login-page")).toBeVisible();
    await page.getByTestId("auth-username").fill(`existing-row-${Date.now()}`);
    await page.getByTestId("auth-password").fill("correct-horse-battery-staple");
    await page.getByTestId("customer-password-register").click();

    await expect(page.getByTestId("current-role")).toHaveAttribute("data-role", "customer");

    // **行が見えた候補は落ち、残る1本で自動オープンが起きる**
    // (候補が2本のままなら、URL は1文字も変わらない —— 上の `NV-G14` の節の検査が
    // その形を測っている)。
    await expect(page).toHaveURL(new RegExp(`/apps/${app.appId}/views/${soloForm.id}$`));
    await expect(page.getByTestId("view-renderer-form")).toBeVisible();
    // **案内の導線も1本だけになっている**(落ちた候補は案内にも出ない)。
    const notice = page.getByTestId("customer-signup-next");
    await expect(notice).toBeVisible();
    await expect(notice.locator("a")).toHaveCount(1);
  });

  test("候補が1本だけで、その表に行が見えれば、案内も自動オープンも起きない", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    const seededTable = soloForm.table as string;
    await app.createRecord(seededTable, buildRecord(app.tableOf(seededTable), 1, new Map()));

    const replaced = await request.post(`/__e2e__/apps/${app.appId}/manifest`, {
      data: withPersonalTables(app.manifest, [seededTable]),
    });
    expect(replaced.status(), await replaced.text()).toBe(200);

    await page.goto(`/apps/${app.appId}`);
    await expect(page.getByTestId("login-page")).toBeVisible();
    await page.getByTestId("auth-username").fill(`existing-row-solo-${Date.now()}`);
    await page.getByTestId("auth-password").fill("correct-horse-battery-staple");

    // **【この待ちが無いと、下の「0件」は空振りで通る】** —— **案内は読取が返ってから
    // 描かれるので、読取を待たずに数えると、実装が何もしていなくても0件に見える。**
    const read = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        response.url().includes(`/api/apps/${app.appId}/tables/${seededTable}/records`),
    );
    await page.getByTestId("customer-password-register").click();
    await expect(page.getByTestId("current-role")).toHaveAttribute("data-role", "customer");
    await read;
    // **描画が落ち着くまでの余白**(負の検査なので、待たないと空振りする)。
    await page.waitForTimeout(500);

    // **案内が1つも出ない**(落ちた結果0本。落ちた理由の文面も1文字も出さない)。
    await expect(page.getByTestId("customer-signup-next")).toHaveCount(0);
    await expect(page.getByTestId("customer-signup-next-dismiss")).toHaveCount(0);
    // **自動でも開かない** —— **URL は1文字も変わっていない。**
    await expect(page).toHaveURL(new RegExp(`/apps/${app.appId}$`));
  });
});

/**
 * **登録の直後に自動で開く先を、開く前に確かめる**
 * (`V10-M19-T03` / `FU-G8` / `ADR-0365`。実装は `web/src/auth/signup-next.ts` の
 * `useSignupNextCandidates`)。
 *
 * ## 【この節が示すもの】
 *
 * **`CP-V10-FOLLOWUP` 条件7 (b) が要求する「読めない利用者・書けない利用者で試し、
 * その候補が落ちることを応答コードつきで示す」を、本物のブラウザと本物のサーバで撃つ。**
 * **応答コードは想像で書かず、同じセッションで実際に叩いて確かめる。**
 *
 * ## 【ここで測っていないこと。先に書く。丸めない】
 *
 * - **「読めない」側で候補を落としているのは、本タスクが足した 403 の分岐ではない。**
 *   **落としているのは着手前から在る同期の関門(`canUseView`)である** ——
 *   **その立場に画面の読取の規則が1本も無い候補は、読取を1度も走らせずに落ちる。**
 *   **【正直に書く】したがって本節の 403 は「候補が落ちた原因」ではなく、
 *   「その候補を実際に読みに行ったらサーバが何を返すか」の実測である。**
 * - **確かめた時点と開いた時点のずれを1件も測っていない**(`ADR-0365` §S3 の 4)。
 * - **ログイン済みの経路を1バイトも測っていない**(直したのは登録直後の経路だけである)。
 * - **配る版(`web/src/runner-app.tsx`)をブラウザで1度も動かしていない。**
 */
test.describe("開く前に確かめる(FU-G8)", () => {
  /** **参照フィールドを1つ以上持つ表の `form`** —— 操作起点の遷移の形を組むのに要る。 */
  const personalForm = fixture.app.views.find(
    (view) =>
      view.type === "form" &&
      (fixture.app.tables.find((table) => table.id === view.table)?.fields ?? []).some(
        (field) => field.type === "reference",
      ),
  );
  if (personalForm === undefined || personalForm.table === undefined) {
    throw new Error("フィクスチャが変わりました: 参照を持つ表の form が1本もありません。");
  }
  const personalTableId = personalForm.table;
  const referenceField = (
    fixture.app.tables.find((table) => table.id === personalTableId)?.fields ?? []
  ).find((field) => field.type === "reference");
  const referencedTableId = (referenceField as { reference_table?: string } | undefined)
    ?.reference_table;
  if (referenceField === undefined || referencedTableId === undefined) {
    throw new Error("フィクスチャが変わりました: 参照先を持つ reference フィールドがありません。");
  }
  const referencedColumn = (fixture.app.tables.find((table) => table.id === referencedTableId)
    ?.fields ?? [])[0];
  if (referencedColumn === undefined) {
    throw new Error("フィクスチャが変わりました: 参照先の表にフィールドが1本もありません。");
  }
  // **絞り込んだ結果を「必ず在る」型の定数に写す** —— **下の関数宣言は巻き上げられるので、
  // `undefined` を落とした型がその中まで届かない**(実測で `tsc` が赤くなった)。
  const formViewId: string = personalForm.id;
  const refTableId: string = referencedTableId;
  const refFieldId: string = referenceField.id;
  const refColumnId: string = referencedColumn.id;

  /** 本節が足す画面とボタンの識別子(フィクスチャに同名が無いことを確かめてある)。 */
  const ACTION_HOST_VIEW = "fu-g8-action-host";
  const CREATE_ACTION = "fu-g8-create";

  /** 役割宣言に規則を足す(既存の宣言があれば併合する)。 */
  function grant(next: Manifest, roleId: string, rules: readonly RoleRule[]): void {
    const roles = next.app.roles ?? [];
    const declaration = roles.find((role) => role.id === roleId);
    if (declaration === undefined) {
      roles.push({ id: roleId, rules: [...rules] });
    } else {
      declaration.rules = [...(declaration.rules ?? []), ...rules];
    }
    next.app.roles = roles;
  }

  /**
   * **その表を「個人ごとに行を持つ表」にする**(`st_owner` を1本足す)。
   *
   * **`web/e2e/fixture-server.ts` の自動付与は、既に名指しされている対象に1本も足さない。**
   * **払い出し済みのアプリでは表も画面も既に名指しされているので、購入者(`customer`)の
   * 規則は本節が明示的に足す** —— **足さないと `GET .../records` は 200 で必ず0件を返す。**
   */
  function withPersonalTable(source: Manifest): Manifest {
    const next = structuredClone(source);
    const table = next.app.tables.find((candidate) => candidate.id === personalTableId);
    if (table === undefined) {
      throw new Error(`払い出したアプリに表 ${personalTableId} がありません。`);
    }
    table.fields.push({ id: "st_owner", name: "所有者", type: "text" });
    return next;
  }

  async function signUpAsCustomer(page: Page, appId: string, tag: string): Promise<void> {
    await page.goto(`/apps/${appId}`);
    await expect(page.getByTestId("login-page")).toBeVisible();
    await page.getByTestId("auth-username").fill(`${tag}-${Date.now()}`);
    await page.getByTestId("auth-password").fill("correct-horse-battery-staple");
    await page.getByTestId("customer-password-register").click();
    await expect(page.getByTestId("current-role")).toHaveAttribute("data-role", "customer");
  }

  /**
   * **その表へ「作成」を書く名前つきの操作起点を1本置き、名指しした役割にだけ許す。**
   * **`actionRoles` に `customer` を入れなければ、その立場の保存は必ず 403 になる。**
   */
  function withCreateAction(source: Manifest, actionRoles: readonly string[]): Manifest {
    const next = withPersonalTable(source);
    next.app.views.push({
      id: ACTION_HOST_VIEW,
      name: "操作起点の置き場",
      type: "list_view",
      table: refTableId,
      columns: [refColumnId],
      actions: [
        {
          id: CREATE_ACTION,
          name: "1件作る",
          form: formViewId,
          prefill: { field: refFieldId },
        },
      ],
    });
    // **購入者には、画面の読取と表の読み書きを明示的に許す** ——
    // **これを足さないと、落ちた理由が「ボタンの規則」なのか「表の規則」なのか分からない。**
    grant(next, "customer", [
      { target: "view", view: formViewId, can: ["read"] },
      { target: "table", table: personalTableId, can: ["read", "write"] },
    ]);
    for (const roleId of actionRoles) {
      grant(next, roleId, [
        { target: "action", view: ACTION_HOST_VIEW, action: CREATE_ACTION, can: ["read"] },
      ]);
    }
    return next;
  }

  test("書けない利用者では候補が落ちる —— 保存の口は 403 を返す", async ({ page, request }) => {
    const app = await provisionApp(request);
    const replaced = await request.post(`/__e2e__/apps/${app.appId}/manifest`, {
      // **ボタンを読めるのは持ち主だけ** —— **購入者はこの表に作成を書けない。**
      data: withCreateAction(app.manifest, ["owner"]),
    });
    expect(replaced.status(), await replaced.text()).toBe(200);

    await signUpAsCustomer(page, app.appId, "fu-g8-write");
    // **描画が落ち着くまでの余白**(負の検査なので、待たないと空振りする)。
    await page.waitForTimeout(500);

    // **候補が0本になったので、案内も閉じるボタンも1つも出ない**
    // (`CP-V10-FOLLOWUP` 条件6 (d) の「書込の関門で0本になる形」)。
    await expect(page.getByTestId("customer-signup-next")).toHaveCount(0);
    await expect(page.getByTestId("customer-signup-next-dismiss")).toHaveCount(0);
    // **自動でも開かない** —— **URL は1文字も変わっていない。**
    await expect(page).toHaveURL(new RegExp(`/apps/${app.appId}$`));

    // **応答コードを実際に確かめる**(同じブラウザのセッションで叩く)。
    // **ボディを読む前に壁が当たるので、空のボディでよい。**
    const created = await page.request.post(
      `/api/apps/${app.appId}/tables/${personalTableId}/records`,
      { data: {} },
    );
    expect(created.status(), await created.text()).toBe(403);
  });

  test("同じボタンを自分にも許せば、今日どおり自動で開く(対照)", async ({ page, request }) => {
    const app = await provisionApp(request);
    const replaced = await request.post(`/__e2e__/apps/${app.appId}/manifest`, {
      data: withCreateAction(app.manifest, ["owner", "customer"]),
    });
    expect(replaced.status(), await replaced.text()).toBe(200);

    await signUpAsCustomer(page, app.appId, "fu-g8-write-ok");

    // **候補は落ちない** —— **その画面が開き、案内も出る。**
    await expect(page).toHaveURL(new RegExp(`/apps/${app.appId}/views/${formViewId}$`));
    await expect(page.getByTestId("view-renderer-form")).toBeVisible();
    await expect(page.getByTestId("customer-signup-next")).toBeVisible();
  });

  test("読めない利用者では候補が落ちる —— 画面を名乗った読取は 403、名乗らない読取は 200 で0件", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    const next = withPersonalTable(app.manifest);
    // **表の読取だけを許す。画面の読取は1本も許さない** ——
    // **その画面を名指しする規則は(持ち主の側に)既に在るので、名乗った読取は 403 になる。**
    grant(next, "customer", [{ target: "table", table: personalTableId, can: ["read"] }]);
    const replaced = await request.post(`/__e2e__/apps/${app.appId}/manifest`, { data: next });
    expect(replaced.status(), await replaced.text()).toBe(200);

    await signUpAsCustomer(page, app.appId, "fu-g8-read");
    await page.waitForTimeout(500);

    // **候補が0本なので、案内も自動オープンも起きない。**
    await expect(page.getByTestId("customer-signup-next")).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/apps/${app.appId}$`));

    // **応答コードを実際に確かめる。** **名乗ったときだけ 403 である**(`ADR-0365` §S3 の 2)。
    const named = await page.request.get(
      `/api/apps/${app.appId}/tables/${personalTableId}/records?view=${formViewId}`,
    );
    expect(named.status(), await named.text()).toBe(403);

    // **名乗らなければ 403 にならない** —— **200 で0件が返る**
    // (「その表が在る」ことを役割の外へ漏らさないための既存の設計である)。
    const unnamed = await page.request.get(
      `/api/apps/${app.appId}/tables/${personalTableId}/records`,
    );
    expect(unnamed.status(), await unnamed.text()).toBe(200);
    expect(((await unnamed.json()) as { total: number }).total).toBe(0);
  });
});
