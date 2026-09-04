/**
 * テーマの取り込み口が**実際のブラウザで働くこと**の chromium 実測(V3-M6-T04 / D-G9)。
 *
 * 完了条件の正は `docs/plan/v3/records/v3-m6.md` §2 の「V3-M6-T04」節(9点)、判定の正は
 * `docs/adr/0007-vocabulary-governance.md` §8 の 2026-07-30 の `D-G9` の行
 * (**門 = A / 判定 = 将来送り / 帰属先はユーザランド + 表示層 + 文書層**)、審査の正は
 * `docs/plan/v3/records/v3-m6-gate-a.md` §4 と §8-1(越えてはならない線12点)である。
 *
 * ## なぜ要るか
 *
 * `web/test/theme-import-panel.test.tsx` は happy-dom 上の検査で、**CSS のカスケードも
 * 継承も解かない。** 「プレビューが変わる」「リロード後も見た目が保たれている」と言うためには、
 * **計算値(`getComputedStyle`)を本物のブラウザで読む**必要がある
 * (`web/e2e/theme.e2e.ts` / `web/e2e/theme-preview.e2e.ts` と同じ理由)。
 *
 * ## 何を測るか
 *
 * 1. **owner が取り込みを完了できる**(完了条件1)—— 提案(25スロットの JSON)を貼る →
 *    **プレビューの枠だけが変わり、製品の枠はまだ変わっていない** → 適用 →
 *    **リロード後も見た目が保たれている**(= マニフェストに入っている。HTTP でも突合する)。
 * 2. **コントラスト検査に落ちる提案は、理由が見える形で拒否される**(完了条件2)——
 *    fail-closed(1バイトも入らない)かつ loud(比・閾値・直し方が画面に出る)。
 *    **プレビューは検査ではない**(落ちる配色でもプレビューは描く。線10)ことも同時に測る。
 * 3. **JSON として読めない貼り付けも黙って落ちない**(同 loud の別経路)。
 * 4. **入口は owner 限定だが、それは遮断ではない** —— UI の外から同じ差分を投げれば今日も
 *    `201` が返る(`theme-preview.e2e.ts` (iv) と同型の実測。`v3-m6.md` §0-4 の6)。
 *    **【V4-FIX1 項目(5) による改訂。上の2行は制定時の記述であり1バイトも書き換えていない】**
 *    **今日は viewer の cookie で投げると 403 になる**(`POST /diffs` に認証境界が入った)。
 *    **owner なら今日も `201` である** —— 塞いだのはロールであって、UI を通さない経路ではない。
 *
 * ## 何を測らないか(誇張しない。`v3-m6.md` §0-4)
 *
 * - **本物の LLM を1度も呼ばない**(§0-4 の1)。**このファイルは「抽出済みの値が取り込める」
 *   ことしか測らない。** **「AI が抽出できることをテストで示した」と書いてはならない。**
 *   抽出そのものは会話側 AI が1度だけ行い、経過は `docs/plan/v3/records/v3-m6-t04.md`
 *   §live transcript にある(**テストではない**)。
 * - **抽出の正しさを1件も検証しない**(§0-4 の5)。下の {@link PROPOSAL} が
 *   `fixtures/theme-import/brand-guide.md` の**正しい読み**であることを測る機械は無い。
 *   ここで測るのは「この25値が入って、当たって、残る」ことだけである。
 * - **時間を1秒も測らない**(§0-4 の2)。**人がどう感じたかも測らない**(同3)。
 * - **既存サイト(URL)を1件も開かない**(§0-4 の8)。資産はリポジトリ内のファイルだけで、
 *   **このファイルは資産のファイルすら読まない**(読むのは `web/test/theme-import.test.ts`)。
 * - **`--border-style` / `--focus-outline-style` / `--shell-max-width` は測らない** ——
 *   **テーマ語彙に無いので取り込めない**(§0-4 の9)。ブランドガイドはこの3つを指定して
 *   いるが、下の {@link PROPOSAL} には1つも入っていない。
 * - **`data-demo/` を1度も使わない**(§0-4 の4)。フィクスチャは `fixture-app.ts` である。
 */
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import type { Manifest } from "../../src/kernel/types.ts";
import { type FixtureApp, provisionApp, seedRoleSession } from "./fixture-app.ts";

/**
 * 取り込む提案(25スロット全部)。
 *
 * **これは会話側 AI が `fixtures/theme-import/brand-guide.md` を読んで組み立てた実値である**
 * (`docs/plan/v3/records/v3-m6-t04.md` §live transcript-A。**V3-M6-T01 の
 * `web/test/theme-import.test.ts` の `IMPORTED_SLOTS` と同一の値である**)。
 *
 * **`web/test/theme-import.test.ts` から import しない** —— `.e2e.ts` は playwright の
 * プロセスで動き、あちらは `bun:test` の import を持つ(`theme-export.e2e.ts` /
 * `theme-preview.e2e.ts` が同じ理由で値を並べ直しているのと同型)。**値がずれたら
 * このファイルの assert が落ちる**(下の (i) が HTTP のマニフェストと1バイト単位で突合する)。
 */
const PROPOSAL: Record<string, string> = {
  "--color-text": "#14281d",
  "--color-text-secondary": "#405146",
  "--color-text-label": "#33443a",
  "--color-text-placeholder": "#4d5e53",
  "--color-danger": "#8c1d18",
  "--color-page-background": "#fffdf8",
  "--color-surface-highlight": "#eef2ea",
  "--color-border": "#6b7a70",
  "--focus-outline-color": "#1a5fb4",
  "--focus-outline-width": "2px",
  "--font-family-base": "Hiragino Sans, Yu Gothic, sans-serif",
  "--font-size-secondary": "0.875rem",
  "--font-size-note": "0.75rem",
  "--line-height-base": "1.7",
  "--space-1": "0.25rem",
  "--space-2": "0.5rem",
  "--space-3": "0.75rem",
  "--space-4": "1rem",
  "--space-5": "1.5rem",
  "--space-6": "2.5rem",
  "--border-width": "1px",
  "--control-border-radius": "6px",
  "--surface-shadow": "0 1px 2px #14281d1a",
  "--detail-label-width": "9rem",
  "--login-max-width": "24rem",
};

/** `#fffdf8` / `#14281d` の chromium の計算値(`theme.e2e.ts` と同じく chromium 限定の期待値)。 */
const PROPOSED_BACKGROUND = "rgb(255, 253, 248)";
const PROPOSED_TEXT = "rgb(20, 40, 29)";
/** テーマを持たないアプリの計算値(`styles.css` の `:root` の `#fff` / `#000`)。 */
const DEFAULT_BACKGROUND = "rgb(255, 255, 255)";
const DEFAULT_TEXT = "rgb(0, 0, 0)";

/**
 * コントラスト検査に落ちる提案。
 *
 * **落とすのは1スロットだけで、値は「この製品自身の既定の枠線色」である**
 * (`web/src/styles.css` の `--color-border: #ddd`)。**ADR-0046 の 2026-07-25 追記
 * 「限界7」が言うとおり、既定配色はテーマとして表せない** —— **取り込みの側から見ると
 * 「今の見た目をそのまま提案として貼ることはできない」ということである**
 * (`v3-m6.md` §0-4 の10)。**架空の悪い値を作らずに、製品自身の値で落とせる。**
 */
const FAILING_PROPOSAL: Record<string, string> = { ...PROPOSAL, "--color-border": "#ddd" };

function jsonOf(slots: Record<string, string>): string {
  return JSON.stringify(slots, null, 2);
}

/** スコープ要素の計算値を読む(枠は入れ子なので `data-testid` で一意に採る)。 */
async function computed(
  page: Page,
  testId: string,
): Promise<{ background: string; color: string }> {
  return await page.evaluate((id) => {
    const element = document.querySelector(`[data-testid="${id}"]`);
    if (element === null) {
      throw new Error(`要素が無い: ${id}`);
    }
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, color: style.color };
  }, testId);
}

/** HTTP のマニフェストからテーマを読む(画面の主張をサーバの状態で裏を取る)。 */
async function themeOf(
  request: APIRequestContext,
  app: FixtureApp,
): Promise<Manifest["app"]["theme"]> {
  // **【`V8-M21` の後半 / `J-G24a` / `D-V8-21`】`GET /manifest` は今日からログインを
  // 要求する。** **足したのはセッションの cookie 1本だけで、期待値は1つも緩めていない。**
  const response = await request.get(`/api/apps/${app.appId}/manifest`, {
    headers: app.authHeaders,
  });
  expect(response.status(), await response.text()).toBe(200);
  const body = (await response.json()) as Manifest;
  return body.app.theme;
}

async function openImport(page: Page, app: FixtureApp): Promise<void> {
  await page.goto(`/apps/${app.appId}`);
  await expect(page.getByTestId("view-list")).toBeVisible();
  await page.getByTestId("open-theme-import").click();
  await expect(page.getByTestId("theme-import")).toBeVisible();
}

test.describe("V3-M6-T04 テーマの取り込み(chromium 実測)", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "計算値の期待値は chromium の値である(`theme.e2e.ts` と同じ理由)",
  );

  test("(i) 提案を貼るとプレビューが変わり、適用してリロードしても見た目が保たれる", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await app.authenticate(page.context());

    // 着手前: このアプリはテーマを持たない(= `styles.css` の既定で描かれている)。
    expect(await themeOf(request, app)).toBeUndefined();
    await openImport(page, app);
    expect(await computed(page, "app-theme")).toEqual({
      background: DEFAULT_BACKGROUND,
      color: DEFAULT_TEXT,
    });

    // 貼っただけではまだ何も変わらない(プレビューを押す前に枠は生えない)。
    await page.getByTestId("theme-import-json").fill(jsonOf(PROPOSAL));
    await expect(page.getByTestId("theme-import-preview")).toHaveCount(0);

    // (1) **プレビューの枠だけが変わる** —— 製品の枠はまだ既定のままである。
    await page.getByTestId("preview-theme-import").click();
    const preview = page.getByTestId("theme-import-preview");
    await expect(preview).toBeVisible();
    expect(await computed(page, "theme-import-preview")).toEqual({
      background: PROPOSED_BACKGROUND,
      color: PROPOSED_TEXT,
    });
    expect(await computed(page, "app-theme")).toEqual({
      background: DEFAULT_BACKGROUND,
      color: DEFAULT_TEXT,
    });
    // **プレビューしただけではサーバに1バイトも入っていない。**
    expect(await themeOf(request, app)).toBeUndefined();

    // (2) 適用する。**何が起きたかを画面が言う**(黙って成功にしない)。
    await page.getByTestId("apply-theme-import").click();
    const result = page.getByTestId("theme-import-result");
    await expect(result).toBeVisible();
    await expect(result).toContainText("取り込みました");
    await expect(page.getByTestId("errors")).toHaveCount(0);

    // (3) **リロード後も見た目が保たれている** —— マニフェストに入っている証拠である。
    await page.reload();
    await expect(page.getByTestId("view-list")).toBeVisible();
    expect(await computed(page, "app-theme")).toEqual({
      background: PROPOSED_BACKGROUND,
      color: PROPOSED_TEXT,
    });

    // (4) サーバの状態でも裏を取る —— **25スロットが1バイトも変わらずに入っている**
    //     (恒等写像。web は値を加工していない)。
    const stored = await themeOf(request, app);
    expect(stored?.slots).toEqual(PROPOSAL);
    // **`origin` は貼っていないので入っていない**(自己申告の由来。ADR-0047 限定7)。
    expect(stored?.origin).toBeUndefined();

    // (5) **既存の履歴機構がそのまま効く** —— 専用の差分操作も専用の取り消し経路も無い。
    const changelog = await request.get(`/api/apps/${app.appId}/changelog`);
    expect(changelog.status(), await changelog.text()).toBe(200);
    const entries = (await changelog.json()) as {
      changelog: { diff_id: string; intent: string }[];
    };
    const entry = entries.changelog.find((candidate) => {
      return candidate.diff_id.startsWith("theme-import-");
    });
    expect(entry, JSON.stringify(entries.changelog)).toBeDefined();
    // **web が自動生成した定型文であることを、intent 自身が言っている。**
    expect(entry?.intent).toContain("人間が書いた意図ではない");
    expect(entry?.intent).toContain("どの資産のどこから取った値かは、この差分には残らない");

    const undone = await request.post(`/api/apps/${app.appId}/undo`, { headers: app.authHeaders });
    expect(undone.status(), await undone.text()).toBe(200);
    await page.reload();
    await expect(page.getByTestId("view-list")).toBeVisible();
    expect(await computed(page, "app-theme")).toEqual({
      background: DEFAULT_BACKGROUND,
      color: DEFAULT_TEXT,
    });
    expect(await themeOf(request, app)).toBeUndefined();
  });

  test("(ii) コントラスト検査に落ちる提案は、理由が見える形で拒否され、1バイトも入らない", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await app.authenticate(page.context());
    await openImport(page, app);

    await page.getByTestId("theme-import-json").fill(jsonOf(FAILING_PROPOSAL));

    // **プレビューは検査ではない**(線10)—— 落ちる配色でも枠は描かれ、地色は当たる。
    // **web に判定の写しを作っていないことの実測である。**
    await page.getByTestId("preview-theme-import").click();
    await expect(page.getByTestId("theme-import-preview")).toBeVisible();
    expect((await computed(page, "theme-import-preview")).background).toBe(PROPOSED_BACKGROUND);
    await expect(page.getByTestId("errors")).toHaveCount(0);

    // 適用しようとすると、**サーバ(= カーネル)が拒否する。**
    await page.getByTestId("apply-theme-import").click();
    const errors = page.getByTestId("errors");
    await expect(errors).toBeVisible();
    // **loud である** —— どのスロットが / いくつで / 閾値がいくつで / どう直すかが出る。
    await expect(errors).toContainText("--color-border");
    await expect(errors).toContainText("#ddd");
    await expect(errors).toContainText("コントラスト比");
    await expect(errors).toContainText("下回ります");
    await expect(errors).toContainText("3:1");
    // **背景が2つあるので、落ちた対は2件出る**(1件目で打ち切らない)。
    await expect(errors).toContainText("--color-page-background");
    await expect(errors).toContainText("--color-surface-highlight");
    // 成功したとは書かれていない。
    await expect(page.getByTestId("theme-import-result")).toHaveCount(0);

    // **fail-closed かつ全か無かである**(ADR-0047 限定9)—— 落ちなかった24スロットも
    // 1つも入っていない。**部分適用は無い。**
    expect(await themeOf(request, app)).toBeUndefined();
    await page.reload();
    await expect(page.getByTestId("view-list")).toBeVisible();
    expect(await computed(page, "app-theme")).toEqual({
      background: DEFAULT_BACKGROUND,
      color: DEFAULT_TEXT,
    });
  });

  test("(iii) JSON として読めない貼り付けも、黙って落ちずに理由が出る", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await app.authenticate(page.context());
    await openImport(page, app);

    await page.getByTestId("theme-import-json").fill("ブランドガイドの本文をそのまま貼った");
    await page.getByTestId("preview-theme-import").click();

    const errors = page.getByTestId("errors");
    await expect(errors).toBeVisible();
    await expect(errors).toContainText("JSON として読めません");
    // **プレビューの枠も、適用のボタンも出ない**(見ていないものを当てさせない)。
    await expect(page.getByTestId("theme-import-preview")).toHaveCount(0);
    await expect(page.getByTestId("apply-theme-import")).toHaveCount(0);

    // 貼り直すとエラーは消える(古い理由を残さない)。
    await page.getByTestId("theme-import-json").fill(jsonOf(PROPOSAL));
    await expect(errors).toHaveCount(0);
  });

  test("(iv) 入口は owner 限定で、viewer は UI の外からも入れられない(V4-FIX1 で変わった)", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    const viewer = await seedRoleSession(request, app.appId, "viewer");
    await viewer.authenticate(page.context());

    await page.goto(`/apps/${app.appId}`);
    await expect(page.getByTestId("view-list")).toBeVisible();
    await expect(page.getByTestId("current-role")).toHaveAttribute("data-role", "viewer");
    await expect(page.getByTestId("open-theme-import")).toHaveCount(0);

    // **【V3-M6 制定時の記述。1バイトも書き換えない】**
    //   > **しかしこれは遮断ではない**(`v3-m6.md` §0-4 の6 / 裁定10)。UI の外から同じ差分を
    //   > 投げれば、**cookie が viewer のままでも `201` が返る。**
    //   > **V3-M6 は `src/server/` を1バイトも変えていない**(v0 からの状態である)。
    //
    // **【V4-FIX1 項目(5) による改訂。今日の正はこちらである】**
    // **`POST /api/apps/:app_id/diffs` は今日、認証を要求する**(未認証 401 / owner 以外 403)。
    // **したがって viewer の cookie で投げると 403 になる。** 上の記述は今日から偽である。
    const postedByViewer = await request.post(`/api/apps/${app.appId}/diffs`, {
      headers: viewer.authHeaders,
      data: {
        diff_id: "theme-import-from-outside-ui-viewer",
        intent: "UI を通さずに viewer が投げた取り込み差分(サーバが 403 で止める実測)",
        operations: [{ op: "set_theme", theme: { slots: PROPOSAL } }],
      },
    });
    expect(postedByViewer.status(), await postedByViewer.text()).toBe(403);

    // **【誇張しない】** **owner なら今日も UI の外から通せる** —— 塞いだのはロールであって、
    // 「UI を通さない経路」そのものではない。
    const postedByOwner = await request.post(`/api/apps/${app.appId}/diffs`, {
      headers: app.authHeaders,
      data: {
        diff_id: "theme-import-from-outside-ui",
        intent: "UI を通さずに owner が投げた取り込み差分(owner には今日も通ることの実測)",
        operations: [{ op: "set_theme", theme: { slots: PROPOSAL } }],
      },
    });
    expect(postedByOwner.status(), await postedByOwner.text()).toBe(201);

    // owner が入れたテーマは、viewer のブラウザでもリロードすれば見える(今日どおり)。
    await page.reload();
    await expect(page.getByTestId("view-list")).toBeVisible();
    expect(await computed(page, "app-theme")).toEqual({
      background: PROPOSED_BACKGROUND,
      color: PROPOSED_TEXT,
    });
  });
});
