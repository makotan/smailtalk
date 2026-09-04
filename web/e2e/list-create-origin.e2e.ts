/**
 * 一覧の上部に立つ「新規作成」の口の chromium 実測(`V10-M3-T01(c)` / `NV-G8b`)。
 *
 * `V10-M3-T01(a)` が `web/src/views/ListViewRenderer.tsx` に足したのは、**宣言のキーを
 * 1つも持たない表示層の既定挙動**である —— 一覧画面(`list_view`)の `.list-view` の
 * **直下の先頭**に「新規作成」のボタンが立ち、押すと同じテーブルの入力画面(`form`)へ移る。
 *
 * ## この2本が証明するもの
 *
 * | # | 何を見るか |
 * |---|---|
 * | (i) | 一覧を開くと口が**見え**、押すと `/apps/<appId>/views/<formId>` へ移る —— **クエリ文字列が1文字も付かず、`/records/` も含まない**(どの行でもない・運ぶ値が1つも無い) |
 * | (ii) | その表に `st_no_direct_create` を足すと、**同じ一覧から口が1つも出なくなる** |
 *
 * ## このファイルが証明しないこと(誇張しないための境界)
 *
 * - **サーバが実際に作成を拒むかどうかは1度も見ていない。** (ii) が見ているのは
 *   **画面から口が消えること**だけである。**`st_no_direct_create` を宣言した表への
 *   `POST` が 403 になることの実証は `src/server/direct-create-suppression.test.ts` が持つ。**
 *   **【禁止】本ファイルを根拠に「押しても必ず失敗する導線を消した」と書かない。**
 * - **見えない相手(viewer / 未ログイン / 役割不明)の DOM を1度も見ていない。**
 *   条件3(`canUseView`)と条件4(`canWriteRole`)が落ちる側は
 *   `web/test/list-create-origin.test.tsx`(happy-dom)の担当である。
 * - **`form` が2本以上あるときにどちらへ行くかを見ていない**(規約は定義順の先頭)。
 *   フィクスチャの対象テーブルに `form` は1本しか無い。
 * - **視覚的な良し悪し・置かれた位置のピクセルを見ていない。** 見ているのは
 *   `.list-view` の直下に器(`list-create`)が在るかどうかと、押した後の URL だけである。
 *
 * ## 名前の出どころ
 *
 * 対象の一覧・入力画面・テーブルは**フィクスチャの JSON から機械的に導く**
 * (`web/e2e/preset.e2e.ts` と同じ形)。アプリ固有の名前はこのファイルに書かない。
 *
 * **`set_roles` を1度も使っていない** —— それは役割の**全体差し替え**であり、
 * `web/e2e/fixture-server.ts` が起動時に配っている「全画面 × 読取」の規則を丸ごと
 * 消してしまう(`web/e2e` に前例は0件である)。**既定セッションは owner なので、
 * 条件3 / 条件4 は追加の付与なしで満たされる。**
 */
import { expect, test } from "@playwright/test";
import type { Diff, FormView, ListView, Manifest } from "../../src/kernel/types.ts";
import { provisionApp } from "./fixture-app.ts";

/** 検証対象の一覧(定義順の先頭の `list_view`)。 */
function listViewOf(manifest: Manifest): ListView {
  const view = manifest.app.views.find(
    (candidate): candidate is ListView => candidate.type === "list_view",
  );
  if (view === undefined) {
    throw new Error("フィクスチャに list_view がありません(このテストの前提)。");
  }
  return view;
}

/** 一覧と同じテーブルの入力画面(定義順の先頭の `form`)= 押した先の行き先。 */
function createFormOf(manifest: Manifest, view: ListView): FormView {
  const form = manifest.app.views.find(
    (candidate): candidate is FormView =>
      candidate.type === "form" && candidate.table === view.table,
  );
  if (form === undefined) {
    throw new Error("フィクスチャに一覧と同じテーブルの form がありません(このテストの前提)。");
  }
  return form;
}

test.describe("V10-M3-T01 一覧の上部の「新規作成」の口(chromium 実測)", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "押した後の URL の実測は1つのブラウザで足りる(`preset.e2e.ts` と同じ理由)",
  );

  test("(i) 一覧の口を押すと、クエリも `/records/` も付かない入力画面の URL へ移る", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await app.authenticate(page.context());
    const view = listViewOf(app.manifest);
    const form = createFormOf(app.manifest, view);

    // **レコードを1件も作っていない** —— **口が出る5条件に行の有無は1つも入っていない。**
    // 取得が終わったことは「0件」の表示(`list-empty`)で見る(表は0件では描かれない)。
    await page.goto(`/apps/${app.appId}/views/${view.id}`);
    await expect(page.getByTestId("list-empty")).toBeVisible();

    // **器は `.list-view` の直下の先頭に在る**(1つだけ)。
    const create = page.getByTestId("list-create");
    await expect(create).toBeVisible();
    expect(await page.locator(".list-view > [data-testid='list-create']").count()).toBe(1);
    expect(
      await page.evaluate(() => {
        const section = document.querySelector(".list-view");
        if (section === null) throw new Error("一覧の器が無い");
        return section.children[0]?.getAttribute("data-testid") ?? null;
      }),
    ).toBe("list-create");

    // **文言はマニフェストから1文字も取っていない**(表示層に固定の文字列)。
    const button = page.getByTestId("list-create-button");
    await expect(button).toHaveText("新規作成");

    await button.click();
    await expect(page.getByTestId("view-renderer-form")).toBeVisible();

    const url = new URL(page.url());
    expect(url.pathname).toBe(`/apps/${app.appId}/views/${form.id}`);
    // **クエリ文字列が1文字も無い**(運ぶ値が1つも無い = `prefill` を渡していない)。
    expect(url.search).toBe("");
    expect(page.url()).not.toContain("?");
    // **どの行でもない**(`recordId` を渡していない)。
    expect(page.url()).not.toContain("/records/");
  });

  test("(ii) 表が `st_no_direct_create` を宣言すると、同じ一覧から口が1つも出なくなる", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await app.authenticate(page.context());
    const view = listViewOf(app.manifest);

    await page.goto(`/apps/${app.appId}/views/${view.id}`);
    await expect(page.getByTestId("list-empty")).toBeVisible();
    await expect(page.getByTestId("list-create")).toBeVisible();

    // **予約規約フィールドを1本足すだけ**(`boolean`・**`required` を書かない**)。
    // 列も画面も1つも触っていない。
    const diff: Diff = {
      diff_id: "list-create-no-direct-create",
      intent: "この表へは画面から直接作らせないようにしたい",
      operations: [
        {
          op: "add_field",
          table: view.table,
          field: { id: "st_no_direct_create", name: "直接作成の遮断", type: "boolean" },
        },
      ],
    } as Diff;
    const applied = await request.post(`/api/apps/${app.appId}/diffs`, {
      data: diff,
      headers: app.authHeaders,
    });
    expect(applied.status(), await applied.text()).toBe(201);

    // **リロードするだけで口が消える**(サーバも再起動していないし、再ビルドもしていない)。
    await page.reload();
    await expect(page.getByTestId("list-empty")).toBeVisible();
    expect(await page.getByTestId("list-create").count()).toBe(0);
    expect(await page.getByTestId("list-create-button").count()).toBe(0);
  });
});
