/**
 * **参照項目を「打って絞る」形(`reference_picker: "type_filter"`)が、実ブラウザで
 * 実際に動くことの実測**(`K-G11` / `K-G13` / `K-G14` / `K-G15` / `K-G17`。`V6-M7b`)。
 *
 * ## なぜ要るか
 *
 * **`docs/evidence/cp-v6.md` §6 が、`CP-V6` の完了条件6 を「部分的に満たす」と判定した。**
 * **理由は逐語で「`type_filter`(打って絞る)の E2E が0本」である** ——
 * プルダウンは `web/e2e/form.e2e.ts:114`、ポップアップ(`search`)は
 * `web/e2e/reference-search-popup.e2e.ts` の3件が示していたが、**3つの選び方の
 * 真ん中の1つだけが、実ブラウザで1度も動かされていなかった。**
 *
 * **`web/test/reference-type-filter.test.tsx` の冒頭が、その状態を自己申告している**
 * (逐語: 「**本物の SQLite で1件も測っていない。** `fetch` を差し替えた表示層の検査である」)。
 * **本ファイルは、その「本物を1度も通っていない」を `type_filter` の側について解く。**
 *
 * ## 本ファイルが証明しないこと(**誇張しないための境界。先に書く**)
 *
 * - **`type_filter` は今日も `<select>` を捨てていない。** **打つ口(`type="search"`)が
 *   1本増え、その下の `<select>` に絞られた候補が並ぶ形である**
 *   (`web/src/fields/input.tsx` の `ReferenceTypeFilterInput`。`ADR-0087` 限定8)。
 *   **【禁止】「プルダウンが打ち込める欄に置き換わった」と書かない。置き換わっていない。**
 *   **本ファイルが測るのは「既定(`list`)では打つ口が0本で、`type_filter` にすると
 *   打つ口が現れ、打つと候補が減る」ことである。**
 * - **読み上げソフトを1度も動かしていない。スクリーンショット比較を1度もしていない。**
 * - **描画時間を1度も測っていない。** **上限の値(50)が妥当かどうかを測っていない。**
 * - **`st_owner` / 役割の規則で見えない相手の候補を1件も作っていない**(`V8-M20` で `audience` は撤去された)
 *   (可視性は `web/test/reference-picker-visibility.test.ts` の担当)。
 * - **ページ送りを1度も押していない**(`type_filter` にページ送りは無い。`K-G16` は
 *   `search` の側の話であり、`reference-search-popup.e2e.ts` が測っている)。
 */
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import type { Diff, Field, FormView, Manifest } from "../../src/kernel/types.ts";
import { type FixtureApp, provisionApp } from "./fixture-app.ts";

/** 参照項目を持つ最初の form(フィクスチャから機械的に導く。名前を書かない)。 */
function formWithReference(manifest: Manifest): { view: FormView; field: Field } {
  for (const view of manifest.app.views) {
    if (view.type !== "form") {
      continue;
    }
    const table = manifest.app.tables.find((candidate) => candidate.id === view.table);
    const field = table?.fields.find(
      (candidate) => candidate.type === "reference" && view.fields.includes(candidate.id),
    );
    if (field !== undefined) {
      return { view, field };
    }
  }
  throw new Error("フィクスチャに reference 項目を持つ form がありません。");
}

/** 参照先テーブルの「名前」に当たる列(最初の text = 代表項目)。 */
function labelFieldOf(manifest: Manifest, tableId: string): Field {
  const table = manifest.app.tables.find((candidate) => candidate.id === tableId);
  const field = table?.fields.find((candidate) => candidate.type === "text");
  if (field === undefined) {
    throw new Error(`参照先 ${tableId} に text の列がありません。`);
  }
  return field;
}

async function applyDiff(request: APIRequestContext, app: FixtureApp, diff: Diff): Promise<void> {
  const applied = await request.post(`/api/apps/${app.appId}/diffs`, {
    data: diff,
    headers: app.authHeaders,
  });
  expect(applied.status(), await applied.text()).toBe(201);
}

/**
 * **代表項目ではない列**(`code`)を参照先に1本足し、その1本だけを「探せる項目」にして
 * 選び方を `type_filter` に切り替える差分。
 *
 * **`V6-M6` の実地が「商品番号で 27 → 1 に絞れた」を確かめている**
 * (`docs/plan/v6/records/v6-m6.md`)。**本ファイルはその性質を E2E で固定する** ——
 * **表示に出るのは代表項目(名前)のままで、当たるのは代表ではない列である。**
 */
const SEARCH_FIELD_ID = "code";

async function switchToTypeFilter(
  request: APIRequestContext,
  app: FixtureApp,
  params: { diffId: string; table: string; field: string; referenceTable: string },
): Promise<void> {
  await applyDiff(request, app, {
    diff_id: params.diffId,
    intent: "他のテーブルから選ぶ項目を、商品番号を打って絞り込めるようにしたいという要望に応えた",
    operations: [
      {
        op: "add_field",
        table: params.referenceTable,
        field: { id: SEARCH_FIELD_ID, name: "商品番号", type: "text" },
      },
      {
        op: "change_field",
        table: params.table,
        field: params.field,
        changes: {
          reference_picker: "type_filter",
          reference_search_fields: [SEARCH_FIELD_ID],
        },
      },
    ],
  } as Diff);
}

/** 入力画面の必須項目を、参照項目以外すべて埋める(保存を通すため)。 */
async function fillOtherRequiredFields(
  page: Page,
  app: FixtureApp,
  tableId: string,
  skipFieldId: string,
): Promise<void> {
  for (const required of app.tableOf(tableId).fields) {
    if (required.required !== true || required.id === skipFieldId) {
      continue;
    }
    await page.fill(
      `[data-testid="field-input-${required.id}"]`,
      required.type === "number" ? "1" : "打って絞って作った行",
    );
  }
}

test.describe("V6-M7b 参照項目を打って絞る(type_filter)", () => {
  test("既定では打つ口が0本で、type_filter にすると打つ口が出て、代表ではない列で絞れて保存できる", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await app.authenticate(page.context());
    const { view, field } = formWithReference(app.manifest);
    if (field.type !== "reference") {
      throw new Error("参照項目の解決に失敗しました。");
    }
    const targetTable = field.reference_table;
    const labelField = labelFieldOf(app.manifest, targetTable);
    const searchBox = page.locator(`[data-testid="reference-search-${field.id}"]`);
    const picker = page.locator(`[data-testid="field-input-${field.id}"]`);

    // --- 既定(`list`)の姿を先に測る。**打つ口は1本も無い**(完了条件6 の「プルダウン」側) ---
    await page.goto(`/apps/${app.appId}/views/${view.id}`);
    await expect(picker).toBeVisible();
    expect(await picker.evaluate((element) => element.tagName)).toBe("SELECT");
    await expect(searchBox).toHaveCount(0);

    // --- 選び方を `type_filter` にし、探せる列を**代表ではない列**にする -------------------
    await switchToTypeFilter(request, app, {
      diffId: "reference-type-filter",
      table: view.table,
      field: field.id,
      referenceTable: targetTable,
    });

    // 候補を3件。**名前と商品番号がまったく別の語である**(どちらで当たったかを混ぜない)。
    await app.createRecord(targetTable, { [labelField.id]: "やまだ商会", code: "A-001" });
    const wanted = await app.createRecord(targetTable, {
      [labelField.id]: "たなか製作所",
      code: "B-002",
    });
    await app.createRecord(targetTable, { [labelField.id]: "すずき工業", code: "C-003" });

    await page.goto(`/apps/${app.appId}/views/${view.id}`);

    // **打ち込める口が出ている**(既定では0本だったもの)。**`<select>` は今日も在る。**
    await expect(searchBox).toBeVisible();
    await expect(searchBox).toHaveAttribute("type", "search");
    expect(await picker.evaluate((element) => element.tagName)).toBe("SELECT");

    // 絞る前は3件とも候補に出ている(先頭の空欄を足して4つ)。
    await expect(picker.locator("option")).toHaveCount(4);

    // --- 打つと絞られる。**当たるのは代表ではない列(商品番号)である** --------------------
    await searchBox.fill("B-002");
    await expect(picker.locator("option")).toHaveCount(2);
    // **表示に出るのは今日どおり代表項目(名前)である。**
    await expect(picker.locator("option", { hasText: "たなか製作所" })).toHaveCount(1);
    await expect(picker.locator("option", { hasText: "やまだ商会" })).toHaveCount(0);

    // **代表項目(名前)を打っても当たらない** —— 探す対象は宣言した1本だけである。
    await searchBox.fill("たなか");
    await expect(picker.locator("option")).toHaveCount(1);

    // --- 選ぶと値が入り、**実際にレコードへ保存できる**(「書ける」と「動く」を混ぜない) ---
    await searchBox.fill("B-002");
    await expect(picker.locator("option")).toHaveCount(2);
    await picker.selectOption(wanted);
    await expect(picker).toHaveValue(wanted);

    await fillOtherRequiredFields(page, app, view.table, field.id);
    await page.getByRole("button", { name: "保存" }).click();

    const created = await request.get(`/api/apps/${app.appId}/tables/${view.table}/records`, {
      headers: app.authHeaders,
    });
    expect(created.status()).toBe(200);
    const rows = ((await created.json()) as { records: Record<string, unknown>[] }).records;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.[field.id]).toBe(wanted);

    // **打った語はマニフェストに1バイトも入らない**(`K-G12`)。
    const manifest = await request.get(`/api/apps/${app.appId}/manifest`, {
      headers: app.authHeaders,
    });
    expect(manifest.status()).toBe(200);
    expect(await manifest.text()).not.toContain("B-002");
  });

  test("上限に当たったことが画面に出て、選んだ値は絞り込みの外へ出ても消えず保存される", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await app.authenticate(page.context());
    const { view, field } = formWithReference(app.manifest);
    if (field.type !== "reference") {
      throw new Error("参照項目の解決に失敗しました。");
    }
    const targetTable = field.reference_table;
    const labelField = labelFieldOf(app.manifest, targetTable);

    await switchToTypeFilter(request, app, {
      diffId: "reference-type-filter-limit",
      table: view.table,
      field: field.id,
      referenceTable: targetTable,
    });

    // **上限(50)を1件だけ超えさせる。**
    const ids: string[] = [];
    for (let index = 0; index < 51; index += 1) {
      const suffix = String(index).padStart(3, "0");
      ids.push(
        await app.createRecord(targetTable, {
          [labelField.id]: `候補${suffix}`,
          code: `X-${suffix}`,
        }),
      );
    }
    const first = ids[0];
    if (first === undefined) {
      throw new Error("候補の作成に失敗しました。");
    }

    await page.goto(`/apps/${app.appId}/views/${view.id}`);
    const searchBox = page.locator(`[data-testid="reference-search-${field.id}"]`);
    const picker = page.locator(`[data-testid="field-input-${field.id}"]`);
    await expect(searchBox).toBeVisible();

    // --- **黙って切らない**(`K-G15`)—— 全件と、出している件数が画面に出る -------------
    const note = page.locator(`[data-testid="reference-limit-${field.id}"]`);
    await expect(note).toBeVisible();
    await expect(note).toContainText("51");
    await expect(note).toContainText("50");
    // 候補は上限ぶんだけ(先頭の空欄を足して51)。
    await expect(picker.locator("option")).toHaveCount(51);

    // --- 1件選んでから、**その値が当たらない語**で絞る(`K-G17`) -----------------------
    await picker.selectOption(first);
    await expect(picker).toHaveValue(first);
    await searchBox.fill("X-030");
    // 絞り込みの結果は1件。**それでも選択済みの値は候補に残っている**(空欄 + 選択済み + 1件)。
    await expect(picker.locator("option")).toHaveCount(3);
    await expect(picker.locator("option", { hasText: "候補030" })).toHaveCount(1);
    await expect(picker.locator("option", { hasText: "候補000" })).toHaveCount(1);
    // **値は1バイトも変わっていない。**
    await expect(picker).toHaveValue(first);
    // 全部出ているので、件数の案内は1文字も出ない。
    await expect(note).toHaveCount(0);

    // --- **絞り込みの外にある値のまま保存できる** ---------------------------------------
    await fillOtherRequiredFields(page, app, view.table, field.id);
    await page.getByRole("button", { name: "保存" }).click();

    const created = await request.get(`/api/apps/${app.appId}/tables/${view.table}/records`, {
      headers: app.authHeaders,
    });
    expect(created.status()).toBe(200);
    const rows = ((await created.json()) as { records: Record<string, unknown>[] }).records;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.[field.id]).toBe(first);
  });
});
