/**
 * **一続きの流れ(`flow`)を、端から端まで本物のブラウザで押し切る**
 * (`V10-M4-T03(4)`。`CP-V10` 条件2。`NV-G9` / `NV-G11` / `ADR-0359` §4b / `ADR-0360`)。
 *
 * ## 何を押すか(**4段。URL を1度も直接開かずに、段1 から段4 まで押す**)
 *
 * | 段 | 種別 | 何をするか |
 * |---|---|---|
 * | 1 | `list_view`(`kind: "input"`) | 「次へ」を押す |
 * | 2 | `form`(`kind: "input"`) | 必須項目を埋めて `保存` を押す |
 * | 3 | `detail_view`(**`kind: "confirm"`**) | **保存した行が開いている**ことを確かめ、`set` 形の確定を押す |
 * | 4 | `list_view`(`kind: "input"`) | ここへ着く |
 *
 * **`page.goto` を打つのは段1 に入るときの1回だけである** —— **段2 → 段3 → 段4 は
 * すべてボタンを押した結果の遷移である**(`web/e2e/ref-ec-cart-to-order.e2e.ts` が
 * 「押すボタンが無いので URL を直接開いている」と申告していたホップが、ここには1つも無い)。
 *
 * ## このファイルが証明しないこと(**誇張しないための境界**)
 *
 * 1. **「確認の段が作れるようになった」と「注文が確かめられるようになった」を1つの文に
 *    書かない**(`ADR-0360` 限定7)。**ここで確かめているのは、宣言した4段を人が
 *    押し切れることだけである。**
 * 2. **【禁止】`E-G33` を「解けた」と書かない** —— **確定のボタンの文言は
 *    `actions[].name` の宣言(既存語彙)から出ており、`form` の送信ボタンは今日も
 *    `保存` の1つである**(`ADR-0102` 限定6 は無傷)。
 * 3. **何段目か・残り何段かは画面に1文字も出ない**(`ADR-0359` §4b 限定2)。
 *    **ここでもそれを1つも探していない。**
 *    **【2026-08-20。`V10-M5-T02` が「いま何段目 / 全部で何段」を描いた。すぐ上の2行は
 *    今日は偽である。旧文を1バイトも書き換えていない】** **今日は4段すべてで
 *    `1段目 / 全4段` … `4段目 / 全4段` を実測している**(下の `flow-position`)。
 *    **それでも段の名前・種類・進捗率・残り時間は1文字も出ず、押せる要素も1つも無い** ——
 *    **出るのは2つの数だけである**(限定2 のその半分は無傷である)。
 * 4. **`run` 形の確定は1度も押していない**(押しても次の段へ進まない。`V10-M4` の決8)。
 *    **その実測は `web/test/flow-confirm-step.test.tsx` の (d) 群が持つ。**
 * 5. **見えない相手(viewer / 未ログイン)の DOM を1度も見ていない** ——
 *    既定セッションは owner である。
 * 6. **視覚的な良し悪し・置かれた位置のピクセルを1つも見ていない。**
 *
 * ## **「戻る」の2本が言えること・言えないこと**(`V10-M5-T01` の追記)
 *
 * **言えること** —— **段2(`form`)には既定で「戻る」が1つ出る。****`page.goBack()` を
 * 1度も呼ばずに、画面上のボタンを押すだけで段1 の URL へ戻れる**(製品の導線の実測である)。
 *
 * **言えないこと(**この製品の限界をそのまま示す**)** ——
 * **段2 の URL を直接開いた場合、履歴に前の項目が無いので、同じボタンを押しても
 * URL が1文字も変わらない。****「必ず前の段に戻れる」とは書けない。**
 * **その「履歴が無い」状態は `page.goto` では作れなかった** —— **Playwright の `page` が
 * 始点に持つ `about:blank` が履歴に1つ残り、押すとアプリの外へ出る**(実測)。
 * **2本目は `location.replace` でその項目を置き換えてから測っている**(下の逐語)。
 * **さらに、戻り先を宣言する口を1つも作っていない** —— **行き先は履歴だけであり、
 * 段の並びを遡っているのではない。** **2本目の実測はそれを直接示している**
 * (段の並びを遡る実装なら、履歴が無くても段1 へ行けたはずである)。
 *
 * **【2026-08-21 追記(`V10-M18-T03` / `FU-G3`)。上の行は1バイトも消していない】**
 * **「戻る」は入力画面だけのものではなくなった** —— **実装が器
 * (`web/src/views/ViewHost.tsx`)へ移り、段を宣言した `list_view` / `detail_view` にも
 * 出る。** **1本目は段1(`list_view`)にも1つ出ることを数で足した。**
 * **押した先を測っているのは今日も段2 の1経路だけである**(段1 から押した先は
 * 1度も見ていない)。
 *
 * ## 名前の出どころ
 *
 * **対象の表・画面・項目はフィクスチャの JSON から機械的に導く**
 * (`web/e2e/list-create-origin.e2e.ts:43`-`:64` と同じ形)。
 * **アプリ固有の名前をこのファイルに1つも書かない。** 書いてあるのは、
 * **この差分が新しく作る画面のID(`flow-done`)と流れのID(`checkout`)だけ**である。
 *
 * **`set_roles` を1度も使っていない** —— それは役割の**全体差し替え**であり、
 * `web/e2e/fixture-server.ts` が起動時に配っている「全画面 × 読取」の規則を丸ごと
 * 消してしまう(`list-create-origin.e2e.ts:34`-`:37` の逐語)。**既定セッションは
 * owner であり、`add_view` で足した画面には `apply-diff.ts` の自動付与
 * (`V8-M26-T04`)が「画面 × 読取」を配る。**
 *
 * **差分は `POST /api/apps/:app_id/diffs`(HTTP)で入れている** —— MCP のツール定義を
 * 通していない(`list-create-origin.e2e.ts` と同じ経路である)。
 */
import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type {
  DetailView,
  Diff,
  Field,
  FormView,
  ListView,
  Manifest,
  Table,
} from "../../src/kernel/types.ts";
import { type FixtureApp, provisionApp } from "./fixture-app.ts";

/** この差分が作る流れの名前と、最後の段の画面ID(**フィクスチャ由来ではない**)。 */
const FLOW_ID = "checkout";
const DONE_VIEW_ID = "flow-done";

/** 段1 になる一覧(定義順の先頭の `list_view`)。 */
function listViewOf(manifest: Manifest): ListView {
  const view = manifest.app.views.find(
    (candidate): candidate is ListView => candidate.type === "list_view",
  );
  if (view === undefined) {
    throw new Error("フィクスチャに list_view がありません(このテストの前提)。");
  }
  return view;
}

/** 段2 になる入力画面(一覧と同じ表の、定義順の先頭の `form`)。 */
function formOf(manifest: Manifest, tableId: string): FormView {
  const view = manifest.app.views.find(
    (candidate): candidate is FormView => candidate.type === "form" && candidate.table === tableId,
  );
  if (view === undefined) {
    throw new Error("フィクスチャに一覧と同じ表の form がありません(このテストの前提)。");
  }
  return view;
}

/** 段3 になる詳細画面(同じ表の、定義順の先頭の `detail_view`)。 */
function detailOf(manifest: Manifest, tableId: string): DetailView {
  const view = manifest.app.views.find(
    (candidate): candidate is DetailView =>
      candidate.type === "detail_view" && candidate.table === tableId,
  );
  if (view === undefined) {
    throw new Error("フィクスチャに一覧と同じ表の detail_view がありません(このテストの前提)。");
  }
  return view;
}

/** 確定で書き換える項目(**`boolean` の項目1本**)。 */
function flagFieldOf(table: Table): Field {
  const field = table.fields.find((candidate) => candidate.type === "boolean");
  if (field === undefined) {
    throw new Error("フィクスチャに boolean の項目がありません(このテストの前提)。");
  }
  return field;
}

/** 最後の段の一覧に出す列(**`text` の項目1本**)。 */
function textFieldOf(table: Table): Field {
  const field = table.fields.find((candidate) => candidate.type === "text");
  if (field === undefined) {
    throw new Error("フィクスチャに text の項目がありません(このテストの前提)。");
  }
  return field;
}

/**
 * ブラウザの入力欄に打ち込む値。**型から機械的に導く**(値を発明しない)。
 *
 * **必須の項目にしか使わない** —— 必須でない項目は空のまま送る。
 */
function browserValue(field: Field): string {
  switch (field.type) {
    case "text":
    case "long_text":
      return `${field.id}-flow`;
    case "number":
      return "3";
    case "date":
      return "2026-01-01";
    default:
      throw new Error(
        `必須項目 ${field.id} の型 ${field.type} は、このテストがブラウザから埋められません。`,
      );
  }
}

test.describe("V10-M4-T03 一続きの流れを端から端まで押す(chromium 実測)", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "段の遷移の実測は1つのブラウザで足りる(`list-create-origin.e2e.ts` と同じ理由)",
  );

  test("段1(一覧)→ 段2(入力)→ 段3(確認)→ 段4(完了)を、すべてボタンで進む", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await app.authenticate(page.context());

    const step1 = listViewOf(app.manifest);
    const tableId = step1.table;
    const table = app.tableOf(tableId);
    const step2 = formOf(app.manifest, tableId);
    const step3 = detailOf(app.manifest, tableId);
    const flag = flagFieldOf(table);
    const column = textFieldOf(table);
    const requiredFields = table.fields.filter((field) => field.required === true);
    expect(requiredFields.length).toBeGreaterThan(0);

    // --- 4段を宣言する(既存の3画面に `flow` を足し、最後の段を1本足す)-------------
    const diff: Diff = {
      diff_id: "flow-steps-checkout",
      intent: "買う流れを、一覧 → 入力 → 確認 → 完了 の4段にしたい",
      operations: [
        {
          op: "update_view",
          view: step1.id,
          changes: { flow: { id: FLOW_ID, step: 1, kind: "input" } },
        },
        {
          op: "update_view",
          view: step2.id,
          changes: { flow: { id: FLOW_ID, step: 2, kind: "input" } },
        },
        {
          op: "update_view",
          view: step3.id,
          changes: {
            // **確認の段は `detail_view` にしか置けない**(`ADR-0360` 限定2)。
            flow: { id: FLOW_ID, step: 3, kind: "confirm" },
            // **確定は既存の語彙((ii) `set` 形)で書く**(限定3。5形目を1つも作っていない)。
            actions: [{ set: { field: flag.id, value: true }, name: "確定する" }],
          },
        },
        {
          op: "add_view",
          view: {
            id: DONE_VIEW_ID,
            type: "list_view",
            table: tableId,
            columns: [column.id],
            flow: { id: FLOW_ID, step: 4, kind: "input" },
          },
        },
      ],
    } as unknown as Diff;
    const applied = await request.post(`/api/apps/${app.appId}/diffs`, {
      data: diff,
      headers: app.authHeaders,
    });
    expect(applied.status(), await applied.text()).toBe(201);

    // --- 段1: 一覧。「次へ」を押す -------------------------------------------------
    await page.goto(`/apps/${app.appId}/views/${step1.id}`);
    // **いま何段目 / 全部で何段**(`V10-M5-T02`)。**文言はマニフェストから1文字も取っていない。**
    await expect(page.getByTestId("flow-position")).toHaveText("1段目 / 全4段");
    expect(await page.getByTestId("flow-position").count()).toBe(1);
    // **押せる要素が1つも無い**(`<p>` である)。
    expect(await page.getByTestId("flow-position").locator("button, a, input").count()).toBe(0);
    // **段の情報は URL に1文字も載らない**(流れのIDも位置も出ない)。
    expect(page.url()).not.toContain(FLOW_ID);
    expect(page.url()).not.toContain("step");
    const next = page.getByTestId("flow-next-button");
    await expect(next).toBeVisible();
    // **文言はマニフェストから1文字も取っていない**(表示層に固定の文字列)。
    await expect(next).toHaveText("次へ");
    await next.click();

    // --- 段2: 入力。必須項目を埋めて保存する ---------------------------------------
    await expect(page.getByTestId("view-renderer-form")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(`/apps/${app.appId}/views/${step2.id}`);
    // **入力の段には「次へ」を出さない**(進むのは保存が成立したときである)。
    expect(await page.getByTestId("flow-next").count()).toBe(0);
    // **「次へ」が出ない段でも、何段目かは出る。**
    await expect(page.getByTestId("flow-position")).toHaveText("2段目 / 全4段");
    expect(page.url()).not.toContain(FLOW_ID);
    expect(page.url()).not.toContain("step");
    const typed = new Map<string, string>();
    for (const field of requiredFields) {
      const value = browserValue(field);
      typed.set(field.id, value);
      await page.getByTestId(`field-input-${field.id}`).fill(value);
    }
    await page.getByRole("button", { name: "保存" }).click();

    // --- 段3: 確認。**保存した行が開いている** -------------------------------------
    await expect(page.getByTestId("view-renderer-detail_view")).toBeVisible();
    const confirmUrl = new URL(page.url());
    // **段3 は「同じ表の詳細」なので、保存が成立した行の `_id` が運ばれる**
    // (`ADR-0357` 限定1・限定2 と同じ線)。
    const match = confirmUrl.pathname.match(
      new RegExp(`^/apps/${app.appId}/views/${step3.id}/records/(.+)$`),
    );
    expect(match, `段3 の URL に行が載っていない: ${confirmUrl.pathname}`).not.toBeNull();
    const recordId = (match as RegExpMatchArray)[1] ?? "";
    expect(recordId.length).toBeGreaterThan(0);
    // **DOM でも、いま打った値がそのまま開いている。**
    for (const [fieldId, value] of typed) {
      await expect(page.getByTestId(`detail-field-${fieldId}`)).toContainText(value);
    }
    // **確認の段に「次へ」の導線は1つも出ない**(進むのは確定を押したときである)。
    expect(await page.getByTestId("flow-next").count()).toBe(0);
    // **確認の段でも、何段目かは出る。****`kind`(`confirm`)の綴りは1文字も出ない。**
    await expect(page.getByTestId("flow-position")).toHaveText("3段目 / 全4段");
    expect(await page.getByTestId("flow-position").textContent()).not.toContain("confirm");
    // **段の情報は URL に1文字も載らない**(`NV-G13` 限定3)。
    expect(confirmUrl.search).toBe("");
    expect(confirmUrl.href).not.toContain(FLOW_ID);
    expect(confirmUrl.href).not.toContain("step");

    // --- 段3 → 段4: 確定を押す ----------------------------------------------------
    const commit = page.getByTestId(`action-set-${flag.id}`);
    await expect(commit).toBeVisible();
    // **確定のボタンの文言は `actions[].name`(既存語彙)から出ている。**
    await expect(commit).toHaveText("確定する");
    await commit.click();

    // --- 段4: 完了 ----------------------------------------------------------------
    await expect(page.getByTestId("view-renderer-list_view")).toBeVisible();
    const doneUrl = new URL(page.url());
    expect(doneUrl.pathname).toBe(`/apps/${app.appId}/views/${DONE_VIEW_ID}`);
    // **最後の段なので「次へ」は出ない。**
    expect(await page.getByTestId("flow-next").count()).toBe(0);
    // **最後の段でも、何段目かは出る**(位置と総数が一致する)。
    await expect(page.getByTestId("flow-position")).toHaveText("4段目 / 全4段");
    // **段の情報は URL に1文字も載らない**(流れのIDも位置も出ない)。
    expect(doneUrl.search).toBe("");
    expect(doneUrl.href).not.toContain(FLOW_ID);
    expect(doneUrl.href).not.toContain("step");
    expect(doneUrl.href).not.toContain("/records/");

    // **確定が本当に書けている**(表示層の遷移だけを見て「確定できた」と書かない)。
    const read = await request.get(`/api/apps/${app.appId}/tables/${tableId}/records/${recordId}`, {
      headers: app.authHeaders,
    });
    expect(read.status(), await read.text()).toBe(200);
    const body = (await read.json()) as { record: Record<string, unknown> };
    expect(body.record[flag.id]).toBe(true);
  });

  /**
   * **段1 と段2 だけを宣言する**(「戻る」の実測に段3・段4 は要らない)。
   *
   * **既存の筋書きの差分を1バイトも共有していない** —— **上の test の行を1つも動かさずに
   * 足すためである。**
   */
  async function declareTwoSteps(
    request: APIRequestContext,
  ): Promise<{ app: FixtureApp; step1: ListView; step2: FormView }> {
    const app = await provisionApp(request);
    const step1 = listViewOf(app.manifest);
    const step2 = formOf(app.manifest, step1.table);
    const diff: Diff = {
      diff_id: "flow-back-checkout",
      intent: "買う流れの、一覧 → 入力 の2段だけを宣言したい",
      operations: [
        {
          op: "update_view",
          view: step1.id,
          changes: { flow: { id: FLOW_ID, step: 1, kind: "input" } },
        },
        {
          op: "update_view",
          view: step2.id,
          changes: { flow: { id: FLOW_ID, step: 2, kind: "input" } },
        },
      ],
    } as unknown as Diff;
    const applied = await request.post(`/api/apps/${app.appId}/diffs`, {
      data: diff,
      headers: app.authHeaders,
    });
    expect(applied.status(), await applied.text()).toBe(201);
    return { app, step1, step2 };
  }

  test("段2(入力)の「戻る」を押すと段1 の URL へ戻る(page.goBack を1度も使わない)", async ({
    page,
    request,
  }) => {
    const { app, step1, step2 } = await declareTwoSteps(request);
    await app.authenticate(page.context());

    // **段1 から「次へ」で段2 に入る**(URL を直接開かない = 履歴が1つ積まれている)。
    await page.goto(`/apps/${app.appId}/views/${step1.id}`);
    // **段1(`list_view`)にも「戻る」が1つ出る**(`V10-M18-T03` / `FU-G3` で足した数)。
    // **押さない** —— ここから押した先はこのファイルが1度も測っていない。
    // **`count()` は待たないので、先に1つ見えるまで待つ**(`page.goto` の直後に数えて
    // **実測で1度 0 が返った**。**隠さない**)。
    await expect(page.getByTestId("flow-back-button")).toBeVisible();
    expect(await page.getByTestId("flow-back").count()).toBe(1);
    await page.getByTestId("flow-next-button").click();
    await expect(page.getByTestId("view-renderer-form")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(`/apps/${app.appId}/views/${step2.id}`);

    // **段2 には「戻る」が1つ出る。** **文言はマニフェストから1文字も取っていない。**
    const back = page.getByTestId("flow-back-button");
    await expect(back).toBeVisible();
    await expect(back).toHaveText("戻る");
    expect(await page.getByTestId("flow-back").count()).toBe(1);

    // **押すのは画面上のボタンである**(`page.goBack()` を1度も呼んでいない)。
    await back.click();
    await expect(page.getByTestId("view-renderer-list_view")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(`/apps/${app.appId}/views/${step1.id}`);
  });

  test("段2 の URL を直接開いて「戻る」を押しても、URL が1文字も変わらない(履歴が無い場合の実測)", async ({
    page,
    request,
    baseURL,
  }) => {
    const { app, step2 } = await declareTwoSteps(request);
    await app.authenticate(page.context());

    /*
     * **段1 を1度も開かずに、段2 の URL を直接開く**(履歴に前の項目が無い状態)。
     *
     * **【`page.goto` を使っていない理由。実測した】** **Playwright の `page` は
     * `about:blank` から始まり、`page.goto` はその項目を**置き換えない** ——
     * **直後に `window.history.length` を読むと 2 であり、「戻る」を押すと
     * `about:blank`(アプリの外)へ出る。** **それはブラウザを開いた瞬間の空白ページへ
     * 戻っているだけで、「履歴が無い」の実測にならない。**
     * **`location.replace` はその空白ページの項目を置き換えるので
     * `history.length` が 1 になり、人が新しいタブに URL を貼って開いた状態と同じになる**
     * (実測: 置き換えの直後は 1、`page.goto` の直後は 2)。
     */
    await page.evaluate(
      (url) => {
        window.location.replace(url);
      },
      new URL(`/apps/${app.appId}/views/${step2.id}`, baseURL ?? "").href,
    );
    await expect(page.getByTestId("view-renderer-form")).toBeVisible();
    expect(await page.evaluate(() => window.history.length)).toBe(1);
    const before = page.url();

    const back = page.getByTestId("flow-back-button");
    await expect(back).toBeVisible();
    await back.click();
    // **何も起きないことを測るので、待ってから見る**(遷移が遅れて起きる可能性を潰す)。
    await page.waitForTimeout(500);
    expect(page.url()).toBe(before);
    await expect(page.getByTestId("view-renderer-form")).toBeVisible();
  });
});
