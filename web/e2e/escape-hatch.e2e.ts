/**
 * 逃げ道(任意 CSS)が**実際に画面へ効くこと**の chromium 実測(V3-M5-T03 / D-G5)。
 *
 * 完了条件の正は `docs/plan/v3/records/v3-m5.md` §2 の「V3-M5-T03」節、限定の正は
 * `docs/adr/0055-escape-hatch-custom-css.md` §2 の限定表14点(特に 5 / 6 / 7 / 12 / 13)と
 * 同 §限界3(owner が失効させたあとの undo)。
 *
 * ## なぜ要るか(**このファイルにしか無い根拠**)
 *
 * V3-M5-T02 が終わった時点で、逃げ道は**マニフェストに書けて・配信されて・遮断もされる**が、
 * **「見た目が変わる」ことは1バイトも実証されていなかった**(`v3-m5-t02.md` §4-4)。
 * 単体テスト(happy-dom)は **CSS のカスケードも入れ子(CSS nesting)も解かない** ——
 * `<style>` の中身が文字列として正しいことしか見ておらず、**その文字列が要素に効いたか**は
 * 原理的に測れない。**「逃げ道が効く」と言える根拠はここにしか無い。**
 *
 * したがって本ファイルは **`getComputedStyle` の計算後の値**だけを判定に使う。
 * 「DOM に文字列が入っている」で済ませない(それは T02 が既にやっている)。
 *
 * ## 5本が何を証明するか
 *
 * | # | テスト | 証明するもの |
 * |---|---|---|
 * | (i) | 発行 → 参照 → 描画 | **owner がブラウザで発行し、参照を書くと、計算後スタイルが変わる**(完了条件1 / 4)|
 * | (ii) | 失効 | **owner がブラウザで失効させると、その場で効かなくなり loud に断られる**(完了条件1 / 5)|
 * | (iii) | 未発行 / 作用域外 | **fail-closed かつ loud**(限定6 / 限定7。完了条件5)|
 * | (iv) | 非 owner | **導線が出ない。かつ UI を迂回した直接リクエストが 403**(完了条件2)|
 * | (v) | 失効後の undo | **参照は戻るが実体は無い → 「戻せなかったことが分かる」**(ADR-0055 §限界3)|
 *
 * ## **(iv) の書き分け** —— UI が出ないことは担保ではない
 *
 * (iv) は2つを別々に測る。**「導線が出ない」は先回りであって遮断ではない。** 担保は
 * サーバの `requireOwner` であり、それを示すのは**ブラウザから同じ URL を直接叩いて 403 を
 * 受け取る**側である(`page.evaluate` の `fetch` を使うので、実オリジンの Origin ヘッダも
 * cookie も本物である = UI を迂回した本物のリクエストになる)。
 *
 * ## このファイルが証明しないこと(誇張しない。憲法6)
 *
 * - **視覚的な良し悪しは1つも測っていない。** 読んでいるのは計算値だけで、
 *   スクリーンショット比較はしていない(`theme.e2e.ts` と同じ限界)。
 * - **CSS の閉じ込めを保証していない。** 測ったのは「既定の書き方では外枠に漏れない」ことまで
 *   である。決意した書き手は `:root:has(&)` のような形で外へ出られ、**限定8(許可リストも
 *   拒否リストも作らない)がある以上その検査は書けない**(ADR-0055 §限界2)。
 * - **本物の LLM を1度も呼んでいない。** AI 側の申請は MCP ツールの経路の不在で示されており
 *   (`src/server/escape-hatch-issuance.test.ts`)、ここでは AI を1度も動かしていない。
 */
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import {
  REF_EC_ESCAPE_HATCH_CSS,
  REF_EC_ESCAPE_HATCH_DIGEST,
} from "../../scripts/ref-ec/manifest.ts";
import type { Diff, ListView, Manifest } from "../../src/kernel/types.ts";
import {
  buildRecord,
  ensureReferenceTargets,
  type FixtureApp,
  provisionApp,
  seedRoleSession,
} from "./fixture-app.ts";

/** 逃げ道の資産名(`$defs/resource_id` の形。UI もこの形しか通さない)。 */
const ASSET_NAME = "print-layout";

/** 版A の本文。**一覧の升目の地色**を赤にする(既定は透明なので、変化が一意に読める)。 */
const CSS_RED = ".list-table td { background-color: #ff0000; }";
/** 版B の本文。同じ資産名で内容だけが違う(= 別のダイジェスト = 別の版)。 */
const CSS_BLUE = ".list-table td { background-color: #0000ff; }";

/** 既定の升目の地色(chromium の実測値。宣言が1つも当たっていない状態)。 */
const TRANSPARENT = "rgba(0, 0, 0, 0)";
const RED = "rgb(255, 0, 0)";
const BLUE = "rgb(0, 0, 255)";

function listViewOf(manifest: Manifest): ListView {
  const view = manifest.app.views.find((candidate): candidate is ListView => {
    return candidate.type === "list_view";
  });
  if (view === undefined) throw new Error("フィクスチャに list_view が無い");
  return view;
}

/** 製品の HTTP API で差分を適用する(テスト専用経路ではない)。 */
async function applyDiff(request: APIRequestContext, app: FixtureApp, diff: Diff): Promise<void> {
  const applied = await request.post(`/api/apps/${app.appId}/diffs`, {
    data: diff,
    headers: app.authHeaders,
  });
  expect(applied.status(), await applied.text()).toBe(201);
}

/** 画面に逃げ道の参照を書く差分(既存語彙の `update_view` 1 op。専用の op は無い)。 */
function referenceDiff(viewId: string, digest: string, diffId: string): Diff {
  return {
    diff_id: diffId,
    intent: "プリセットで収まらないこだわりを、owner が発行した逃げ道でこの画面に当てたい",
    operations: [
      {
        op: "update_view",
        view: viewId,
        changes: { custom_css: { asset: ASSET_NAME, digest } },
      },
    ],
  } as Diff;
}

/** 要素の計算後スタイルを読む(**判定に使うのはこの値だけである**)。 */
async function computed(page: Page, selector: string, property: string): Promise<string> {
  return await page.evaluate(
    ({ selector, property }) => {
      const element = document.querySelector(selector);
      if (element === null) throw new Error(`要素が見つからない: ${selector}`);
      return getComputedStyle(element).getPropertyValue(property);
    },
    { selector, property },
  );
}

/** 一覧画面を開いて、表が描かれるまで待つ。 */
async function openList(page: Page, app: FixtureApp, viewId: string): Promise<void> {
  await page.goto(`/apps/${app.appId}/views/${viewId}`);
  await expect(page.getByTestId("list-table")).toBeVisible();
}

/** 一覧に1件データを入れる(表は行が1件以上ないと描かれない)。 */
async function seedOneRow(app: FixtureApp, view: ListView): Promise<void> {
  const table = app.tableOf(view.table);
  const referenceIds = await ensureReferenceTargets(app, table);
  await app.createRecord(table.id, buildRecord(table, 1, referenceIds));
}

/** owner の管理画面を開く(ワークスペースの導線から。**ブラウザ操作である**)。 */
async function openAdmin(page: Page, app: FixtureApp): Promise<void> {
  await page.goto(`/apps/${app.appId}`);
  await expect(page.getByTestId("open-escape-hatch-admin")).toBeVisible();
  await page.getByTestId("open-escape-hatch-admin").click();
  await expect(page.getByTestId("escape-hatch-admin")).toBeVisible();
  // **発行済み一覧が読み終わるまで待つ。** 待たないと「読み込み中…」の 0 件を
  // 「まだ1件も無い」と読んでしまい、発行の前後の差分が取れなくなる。
  await expect(
    page
      .locator('[data-testid="escape-hatch-assets-empty"], [data-testid="escape-hatch-row"]')
      .first(),
  ).toBeVisible();
}

/**
 * **owner がブラウザで逃げ道を発行する**(完了条件1)。返すのは発行された版のダイジェスト
 * —— マニフェストの参照はこの値を書く必要があるので、**画面がこれを出せなければ
 * 逃げ道は使えない。**
 */
async function issueViaUi(
  page: Page,
  app: FixtureApp,
  input: { css: string; scopeViews: string[] },
): Promise<string> {
  await openAdmin(page, app);
  await page.getByTestId("escape-hatch-name-input").fill(ASSET_NAME);
  await page.getByTestId("escape-hatch-css-input").fill(input.css);
  await page.getByTestId("escape-hatch-scope-input").fill(input.scopeViews.join(", "));
  const before = await issuedDigests(page);
  await page.getByTestId("issue-escape-hatch").click();
  await expect(page.getByTestId("escape-hatch-row")).toHaveCount(before.length + 1);
  // **一覧の並び順に依存させない**(同名の版が2つ並ぶので「最後の行」は当てにならない)。
  // 発行の前後の**集合の差**を取るので、並びがどうであれ新しい版が一意に決まる。
  const added = (await issuedDigests(page)).filter((digest) => !before.includes(digest));
  expect(added, "発行で1件だけ増えている").toHaveLength(1);
  const digest = added[0] as string;
  expect(digest, "画面が発行済み資産のダイジェストを出している").toMatch(/^[0-9a-f]{64}$/);
  return digest;
}

/** いま画面に出ている発行済み資産のダイジェストの全量。 */
async function issuedDigests(page: Page): Promise<string[]> {
  return await page
    .getByTestId("escape-hatch-row")
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-asset-digest") ?? ""));
}

test.describe("V3-M5-T03 逃げ道(任意 CSS)が実際に効く(chromium 実測)", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "計算後スタイルの期待値は chromium の値である(`theme.e2e.ts` と同じ理由)",
  );

  test("(i) owner がブラウザで発行し、参照を書くと、計算後スタイルが変わる", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const app = await provisionApp(request);
    await app.authenticate(page.context());
    const view = listViewOf(app.manifest);
    await seedOneRow(app, view);

    // --- (a) 逃げ道を当てる前 = 既定の描画(升目の地色は透明)-------------------
    await openList(page, app, view.id);
    expect(await computed(page, ".list-table td", "background-color")).toBe(TRANSPARENT);
    // 逃げ道を使っていない画面なので、style 要素も遮断の知らせも出ていない。
    await expect(page.getByTestId("custom-css")).toHaveCount(0);
    await expect(page.getByTestId("custom-css-blocked")).toHaveCount(0);

    // --- (b) owner がブラウザで発行する(作用域はこの画面1つだけ)---------------
    const digest = await issueViaUi(page, app, { css: CSS_RED, scopeViews: [view.id] });

    // --- (c) 発行しただけでは1ピクセルも変わらない ------------------------------
    //   **参照を書くまで当たらない**(発行と適用は別である)。
    await openList(page, app, view.id);
    expect(await computed(page, ".list-table td", "background-color")).toBe(TRANSPARENT);

    // --- (d) 参照を書く(既存語彙の update_view 1 op)---------------------------
    await applyDiff(request, app, referenceDiff(view.id, digest, "escape-hatch-apply"));

    // --- (e) 画面を開くと**見た目が変わっている** --------------------------------
    await openList(page, app, view.id);
    await expect(page.getByTestId("custom-css")).toHaveCount(1);
    await expect(page.getByTestId("custom-css-blocked")).toHaveCount(0);
    // **これが本タスクの核心の1行である** —— DOM の文字列ではなく、計算後の値が変わった。
    await expect
      .poll(async () => await computed(page, ".list-table td", "background-color"))
      .toBe(RED);

    // --- (f) 外枠(シェル)には漏れていない(限定13)-----------------------------
    //   `.shell` は `.app-theme` の外側にあるので、入れ子に包んだ規則は当たらない。
    expect(await computed(page, ".shell", "background-color")).toBe(TRANSPARENT);
    expect(await computed(page, "body", "background-color")).toBe("rgb(255, 255, 255)");
  });

  test("(ii) owner がブラウザで失効させると、その場で効かなくなり loud に断られる", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const app = await provisionApp(request);
    await app.authenticate(page.context());
    const view = listViewOf(app.manifest);
    await seedOneRow(app, view);

    const digest = await issueViaUi(page, app, { css: CSS_RED, scopeViews: [view.id] });
    await applyDiff(request, app, referenceDiff(view.id, digest, "escape-hatch-apply"));
    await openList(page, app, view.id);
    await expect
      .poll(async () => await computed(page, ".list-table td", "background-color"))
      .toBe(RED);

    // --- owner がブラウザで失効させる(完了条件1 の「失効」)---------------------
    await openAdmin(page, app);
    await page.getByTestId("revoke-escape-hatch").first().click();
    await expect(page.getByTestId("escape-hatch-assets-empty")).toBeVisible();

    // --- 参照はマニフェストに残ったままだが、**当たらなくなり、loud に断られる** ---
    await openList(page, app, view.id);
    await expect(page.getByTestId("custom-css-blocked")).toBeVisible();
    await expect(page.getByTestId("custom-css")).toHaveCount(0);
    expect(await computed(page, ".list-table td", "background-color")).toBe(TRANSPARENT);
    const notice = await page.getByTestId("custom-css-blocked").textContent();
    expect(notice ?? "").toContain("発行されていません");
  });

  test("(iii) 未発行の参照と作用域外の参照は fail-closed かつ loud である", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const app = await provisionApp(request);
    await app.authenticate(page.context());
    const view = listViewOf(app.manifest);
    await seedOneRow(app, view);

    // --- (a) 一度も発行されていないダイジェストを指す参照 -----------------------
    await applyDiff(request, app, referenceDiff(view.id, "0".repeat(64), "escape-hatch-unissued"));
    await openList(page, app, view.id);
    await expect(page.getByTestId("custom-css-blocked")).toBeVisible();
    // **CSS は1バイトも出ていない**(黙って効かないのでも、中途半端に効くのでもない)。
    await expect(page.getByTestId("custom-css")).toHaveCount(0);
    expect(await computed(page, ".list-table td", "background-color")).toBe(TRANSPARENT);
    expect((await page.getByTestId("custom-css-blocked").textContent()) ?? "").toContain(
      "発行されていません",
    );

    // --- (b) 発行済みだが、この画面が作用域に入っていない(限定7)---------------
    //   **owner が許した画面にしか当たらない** —— 参照は AI が書けるが、宣言は owner のもの。
    const otherViewId = app.manifest.app.views.find((candidate) => candidate.id !== view.id)?.id;
    expect(otherViewId, "フィクスチャに2つ目の画面がある").toBeDefined();
    const digest = await issueViaUi(page, app, {
      css: CSS_RED,
      scopeViews: [otherViewId as string],
    });
    await applyDiff(request, app, referenceDiff(view.id, digest, "escape-hatch-out-of-scope"));

    await openList(page, app, view.id);
    await expect(page.getByTestId("custom-css-blocked")).toBeVisible();
    await expect(page.getByTestId("custom-css")).toHaveCount(0);
    expect(await computed(page, ".list-table td", "background-color")).toBe(TRANSPARENT);
    expect((await page.getByTestId("custom-css-blocked").textContent()) ?? "").toContain("作用域");
  });

  test("(iv) 非 owner には導線が出ない。**かつ UI を迂回した直接リクエストが 403 になる**", async ({
    page,
    request,
    browser,
  }) => {
    test.setTimeout(120_000);
    const app = await provisionApp(request);
    const view = listViewOf(app.manifest);

    // owner が1件発行しておく(失効の 403 を測るために資産IDが要る)。
    await app.authenticate(page.context());
    await issueViaUi(page, app, { css: CSS_RED, scopeViews: [view.id] });
    const assetId = await page
      .getByTestId("escape-hatch-row")
      .first()
      .getAttribute("data-asset-id");
    expect(assetId).not.toBeNull();

    for (const role of ["editor", "viewer"] as const) {
      const session = await seedRoleSession(request, app.appId, role);
      const context = await browser.newContext();
      await session.authenticate(context);
      const rolePage = await context.newPage();
      await rolePage.goto(`/apps/${app.appId}`);
      await expect(rolePage.getByTestId("current-role")).toBeVisible();

      // --- (a) UI の出し分け(**先回りであって担保ではない**)---------------------
      await expect(rolePage.getByTestId("open-escape-hatch-admin")).toHaveCount(0);

      // --- (b) **担保はサーバの `requireOwner`** -----------------------------------
      //   ブラウザから同じ URL を直接叩く(Origin も cookie も本物 = UI の迂回そのもの)。
      const base = `/api/apps/${app.appId}/escape-hatch-assets`;
      const statuses = await rolePage.evaluate(
        async ({ base, assetId }) => {
          const out: Record<string, number> = {};
          out.list = (await fetch(base, { credentials: "include" })).status;
          out.requests = (await fetch(`${base}/requests`, { credentials: "include" })).status;
          out.issue = (
            await fetch(base, {
              method: "POST",
              credentials: "include",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                name: "sneaky",
                css: ".list-table td { background-color: #00ff00 }",
                scopeViews: ["anything"],
              }),
            })
          ).status;
          out.revoke = (
            await fetch(`${base}/${assetId}`, { method: "DELETE", credentials: "include" })
          ).status;
          return out;
        },
        { base, assetId: assetId as string },
      );
      expect(statuses, `${role} は4本とも 403 になる`).toEqual({
        list: 403,
        requests: 403,
        issue: 403,
        revoke: 403,
      });

      await context.close();
    }

    // --- (c) 迂回した発行が1件も通っていないこと(owner の一覧が1件のまま)---------
    await openAdmin(page, app);
    await expect(page.getByTestId("escape-hatch-row")).toHaveCount(1);
    expect(await page.getByTestId("escape-hatch-row-name").first().textContent()).toBe(ASSET_NAME);
  });

  test("(v) owner が失効させたあとに undo すると、参照は戻るが実体は無い(ADR-0055 §限界3)", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const app = await provisionApp(request);
    await app.authenticate(page.context());
    const view = listViewOf(app.manifest);
    await seedOneRow(app, view);

    // --- 同じ資産名で2つの版を発行する(内容が違うので別のダイジェストになる)-----
    const digestRed = await issueViaUi(page, app, { css: CSS_RED, scopeViews: [view.id] });
    const digestBlue = await issueViaUi(page, app, { css: CSS_BLUE, scopeViews: [view.id] });
    expect(digestRed).not.toBe(digestBlue);

    // --- 版A を当てる → 赤 ------------------------------------------------------
    await applyDiff(request, app, referenceDiff(view.id, digestRed, "escape-hatch-v1"));
    await openList(page, app, view.id);
    await expect
      .poll(async () => await computed(page, ".list-table td", "background-color"))
      .toBe(RED);

    // --- 版B へ差し替える → 青(content-addressing なので版A の実体は壊れない)----
    await applyDiff(request, app, referenceDiff(view.id, digestBlue, "escape-hatch-v2"));
    await openList(page, app, view.id);
    await expect
      .poll(async () => await computed(page, ".list-table td", "background-color"))
      .toBe(BLUE);

    // --- owner が**版A を失効させる**(ブラウザ操作)------------------------------
    await openAdmin(page, app);
    await page
      .locator(`[data-testid="escape-hatch-row"][data-asset-digest="${digestRed}"]`)
      .getByTestId("revoke-escape-hatch")
      .click();
    await expect(page.getByTestId("escape-hatch-row")).toHaveCount(1);

    // --- undo(版B への差し替えを戻す)-------------------------------------------
    const undone = await request.post(`/api/apps/${app.appId}/undo`, { headers: app.authHeaders });
    expect(undone.status(), await undone.text()).toBe(200);

    // **参照はマニフェストの上で完全に戻っている**(憲法4 は参照については守られている)。
    // **【`V8-M21` の後半 / `J-G24a` / `D-V8-21`】`GET /manifest` は今日からログインを
    // 要求する。** **足したのはセッションの cookie 1本だけで、期待値は1つも緩めていない。**
    const manifest = (await (
      await request.get(`/api/apps/${app.appId}/manifest`, { headers: app.authHeaders })
    ).json()) as {
      app: { views: { id: string; custom_css?: { asset: string; digest: string } }[] };
    };
    const restored = manifest.app.views.find((candidate) => candidate.id === view.id);
    expect(restored?.custom_css).toEqual({ asset: ASSET_NAME, digest: digestRed });

    // --- **しかし実体の登録は戻らない。「戻った」ではなく「戻せなかったことが分かる」** ---
    await openList(page, app, view.id);
    await expect(page.getByTestId("custom-css-blocked")).toBeVisible();
    await expect(page.getByTestId("custom-css")).toHaveCount(0);
    // 赤でも青でもなく、既定に落ちている(**中途半端に効かない** = fail-closed)。
    expect(await computed(page, ".list-table td", "background-color")).toBe(TRANSPARENT);
    const notice = (await page.getByTestId("custom-css-blocked").textContent()) ?? "";
    expect(notice).toContain("発行されていません");
    // **人間に「なぜ戻らなかったか」が伝わる**(黙って効かないのは憲法6 違反)。
    expect(notice).toContain("失効させた資産を undo で呼び戻すことはできません");
  });
});

/**
 * 4つ目の状態(`custom-css-target-unverified`)を**本物のブラウザで見る**
 * (V4-M30 / `D-V4-113` / `P-G48` / `D-V4-15`)。
 *
 * ## なぜ要るか(**ここでしか取れない分**)
 *
 * **着手前、`web/e2e/` に `target_unverified` は1度も出てこなかった**(`grep -rn` が0件)。
 * 4つ目の状態を測っているのは `web/test/escape-hatch-delivery.test.tsx` の5本だけで、
 * **それは happy-dom であって実ブラウザではない。** 本 describe は実 chromium で、
 * 実際の HTTP 配信を経由して知らせが出るところまでを測る。
 *
 * ## **これは「壊してみせた」実演ではない**(誇張しない。憲法6)
 *
 * `web/src/views/ViewHost.tsx` の分岐は **「配信された CSS が空白を除いて1文字でもあるか」**
 * だけであり、**当たり先を1件も数えていない**(実装のコメントが「当たり先は1件も数えない。
 * 知らせるのは『当たり先が変わりうる』ことだけである」と明記している)。
 * **したがって、資産を発行して参照した瞬間から、壊れる前でもこの知らせは出る。**
 * (ii) はその性質を**空白1文字の資産**で逆から固定する。
 *
 * ## `CP-V4-UI` の条件16 を満たすものではない
 *
 * 条件16 の本文は「**発行済みの逃げ道資産のうち、当たり先が消えたものを全件数えて
 * 記録していること**」である。**本 describe は当たり先を1件も数えていない**し、数える手段を
 * 足してもいない(数えるには CSS の解釈が要り、`ADR-0055` 限定8 / 憲法1 の引き直しになる)。
 *
 * ## 見本の本文は参照ショップと同一である
 *
 * 配信するバイト列は `scripts/ref-ec/manifest.ts` の `REF_EC_ESCAPE_HATCH_CSS` そのもので、
 * **発行して返ってきたダイジェストが `REF_EC_ESCAPE_HATCH_DIGEST` と一致すること**を
 * 判定に入れている。**フィクスチャのアプリは毎回作り捨てだが、バイト列は参照ショップに
 * 置いた見本と同一である**ことが、この一致で言える。
 */
test.describe("V4-M30 逃げ道の見本と、持ち主向けの4つ目の知らせ(chromium 実測)", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "計算後スタイルの期待値は chromium の値である(`theme.e2e.ts` と同じ理由)",
  );

  test("(i) 参照ショップの見本と同じバイト列を当てると、**持ち主にだけ**4つ目の知らせが出る", async ({
    page,
    request,
    browser,
  }) => {
    test.setTimeout(120_000);
    const app = await provisionApp(request);
    await app.authenticate(page.context());
    const view = listViewOf(app.manifest);
    await seedOneRow(app, view);

    // --- 当てる前は知らせが1要素も無い ------------------------------------------
    await openList(page, app, view.id);
    await expect(page.getByTestId("custom-css-target-unverified")).toHaveCount(0);

    // --- owner がブラウザで発行する(本文は参照ショップの見本と同一)--------------
    const digest = await issueViaUi(page, app, {
      css: REF_EC_ESCAPE_HATCH_CSS,
      scopeViews: [view.id],
    });
    expect(digest, "参照ショップに置いた見本と同じバイト列である").toBe(REF_EC_ESCAPE_HATCH_DIGEST);
    await applyDiff(request, app, referenceDiff(view.id, digest, "escape-hatch-sample"));

    // --- owner の画面: 配信されており、かつ知らせが出ている ----------------------
    await openList(page, app, view.id);
    await expect(page.getByTestId("custom-css")).toHaveCount(1);
    await expect(page.getByTestId("custom-css-blocked")).toHaveCount(0);
    // **これが本タスクの核心の1行である** —— 4つ目の状態が実ブラウザに出た。
    await expect(page.getByTestId("custom-css-target-unverified")).toBeVisible();

    // 文面が「数えていない」ことと「undo で戻らない」ことを自分で言っている。
    const notice = (await page.getByTestId("custom-css-target-unverified").textContent()) ?? "";
    expect(notice).toContain("当たり先が変わっているかもしれません");
    expect(notice).toContain("数えていません");
    expect(notice).toContain("undo の対象外");
    // **「壊れた」とは1文字も書いていない**(`03:2209` の【禁止】に接地する)。
    expect(notice).not.toContain("壊れ");

    // --- 見本は実際に効いている(計算後スタイルで確かめる)------------------------
    //   `.list-total` の太さは既定では 700 ではない。見本が当たったことの実測である。
    await expect.poll(async () => await computed(page, ".list-total", "font-weight")).toBe("700");

    // --- 非 owner: **CSS は当たるが、知らせは1要素も出ない** ----------------------
    for (const role of ["editor", "viewer"] as const) {
      const session = await seedRoleSession(request, app.appId, role);
      const context = await browser.newContext();
      await session.authenticate(context);
      const rolePage = await context.newPage();
      await openList(rolePage, app, view.id);
      await expect(rolePage.getByTestId("custom-css")).toHaveCount(1);
      await expect(
        rolePage.getByTestId("custom-css-target-unverified"),
        `${role} には知らせが出ない`,
      ).toHaveCount(0);
      await context.close();
    }
  });

  test("(ii) この知らせは壊れたことを1件も見ていない —— 空白1文字なら出ず、遮断なら3つ目に落ちる", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const app = await provisionApp(request);
    await app.authenticate(page.context());
    const view = listViewOf(app.manifest);
    await seedOneRow(app, view);

    // --- (a) 空白1文字の資産 = 規則を1つも持たない ------------------------------
    //   **当たり先を失いようがないので、知らせは出ない。** 分岐が見ているのが
    //   「壊れたか」ではなく「空白以外が1文字でもあるか」だけであることの、逆からの固定。
    const blankDigest = await issueViaUi(page, app, { css: " ", scopeViews: [view.id] });
    await applyDiff(request, app, referenceDiff(view.id, blankDigest, "escape-hatch-blank"));
    await openList(page, app, view.id);
    await expect(page.getByTestId("custom-css")).toHaveCount(1);
    await expect(page.getByTestId("custom-css-target-unverified")).toHaveCount(0);
    await expect(page.getByTestId("custom-css-blocked")).toHaveCount(0);

    // --- (b) 一度も発行されていないダイジェスト = 遮断(3つ目の状態)--------------
    //   **4つ目は出ない。** 「配信されなかった」と「当たり先が変わりうる」は別物である。
    await applyDiff(request, app, referenceDiff(view.id, "0".repeat(64), "escape-hatch-missing"));
    await openList(page, app, view.id);
    await expect(page.getByTestId("custom-css-blocked")).toBeVisible();
    await expect(page.getByTestId("custom-css-target-unverified")).toHaveCount(0);
    await expect(page.getByTestId("custom-css")).toHaveCount(0);
  });
});
