/**
 * **書換・保存・削除が成立したあとの行き先を、本物のブラウザ(chromium)で押して確かめる**
 * (`V10-M7-T04`。`NV-G3a` / `NV-G1` / `NV-G4` / `ADR-0358` / `ADR-0357` / `ADR-0359` §4a)。
 *
 * ## 着手前の実測(**このファイルが存在する理由**)
 *
 * ```
 * LC_ALL=C /usr/bin/grep -o "after_save\|after_delete" web/e2e/*.e2e.ts | wc -l
 * → 1
 * ```
 *
 * **その 1 は `web/e2e/checkout-flow.e2e.ts:49` の doc 中の言及であり、
 * 差分に書かれた宣言ではない。** **つまり `after_save`(書換 / 保存の後の行き先)も
 * `after_delete`(削除の後の行き先)も、ブラウザで1度も押されたことが無い。**
 * **本ファイルが、その2つの語彙に対する最初の chromium 実測である。**
 *
 * ## 既存ファイルとの違い(**重ならない側だけを足す**)
 *
 * | 既存ファイルが既に測っているもの | 本ファイルの扱い |
 * |---|---|
 * | `web/e2e/checkout-flow.e2e.ts` —— **段(`flow`)を宣言した画面**で、保存 / 操作起点の後に次の段へ進む | **段を1つも宣言しない。** 段があると `flowNextRoute` が先に効き、**`after_save` は無視される**(`web/src/views/DetailViewRenderer.tsx:608`-`:617`)。**本ファイルはその分岐に1度も入らない側を測る** |
 * | `web/e2e/flow-steps.e2e.ts` —— 4段の流れを端から端まで押す / 段2 の「戻る」 | **`flow` を1文字も書いていない。**「戻る」を1度も押していない |
 * | `web/e2e/detail-view.e2e.ts:164`-`:171` —— 削除して**既定の行き先**(同じ表の `list_view`)へ落ちる | **書き直さない。** 本ファイルは **`after_delete` を宣言した場合**だけを測り、**既定の行き先ではない方**へ着地することを期待値にする |
 * | `web/e2e/ref-ec-cart-to-order.e2e.ts:552` `(C-6)` —— **一覧の行き先**に別テーブルの単票を書くと、押した先が壊れる | **こちらは入力画面(`form`)の保存後である。** 壊れ方も違う:`(C-6)` は**押した行の `_id` が載ったまま**別表を引くので「レコードは存在しません」になり、**本ファイルの (d) は `_id` が1バイトも載らない**ので「URL に対象のレコードが指定されていません」になる(**別の文言・別の経路**) |
 *
 * ## 測る4本(**それぞれ独立した `test(`**)
 *
 * | | 測るもの |
 * |---|---|
 * | (a) | **詳細画面の書換ボタン(`actions` の `set`)が成立したあと、`after_save` で宣言した画面へ移る**(段は1つも無い) |
 * | (b) | **削除が成立したあと、`after_delete` で宣言した画面へ移る**(**既定の行き先ではない方**へ) |
 * | (c) | **入力画面(`form`)で保存した行の `_id` が、`after_save` に宣言した「同じ表の `detail_view`」の URL に載る** |
 * | (d) | **`after_save` に「別の表の `detail_view`」を宣言すると、`_id` が載らず、その画面が読めない** |
 *
 * ## 製品の規則(**この形でないと通らない。実装を1バイトも変えていない**)
 *
 * - **詳細画面の `after_save` が発火するのは `set` 形の書込が成立したときだけである**
 *   (`ADR-0358` 限定6。`run` 形の後は1ミリも移らない)。**押しても行は運ばれない**
 *   (`DetailViewRenderer.tsx:611`-`:614` は `recordId` を渡していない)—— **(a) の
 *   期待値は「`/records/` が URL に無いこと」である。**
 * - **`after_delete` を書けるのは `detail_view` だけで、行き先にできるのは
 *   `list_view` か `report_view` だけである**(`ADR-0359` §4a 限定2・限定4)。
 * - **`form` の `after_save` が行を運ぶのは「同じ表の `detail_view`」のときだけである**
 *   (`ADR-0357` 限定3a-1 / 限定3a-2。`FormRenderer.tsx:825`-`:831`)——
 *   **別表の `detail_view` へは1バイトも渡らない。**
 * - **`after_save` / `after_delete` は `update_view` で後から書ける**
 *   (`apply-diff.ts` の `detail_view` 分岐)。
 *
 * ## このファイルが証明しないこと(**誇張しないための境界**)
 *
 * 1. **段(`flow`)との優先順位を1度も押していない。** **それを測っているのは
 *    `checkout-flow.e2e.ts` と `web/test/flow-confirm-step.test.tsx` である。**
 * 2. **`run` 形(自動処理の起動)を1度も押していない**(押しても移らないことは、
 *    ここでは測っていない)。
 * 3. **`report_view` を行き先に書いていない**(`after_delete` は許すが、本ファイルは
 *    `list_view` の側だけを押した)。
 * 4. **宣言した画面が「この人には配られなかった」場合に既定へ倒れる経路を
 *    1度も通っていない** —— **測っているのは既定セッション(owner)だけである。**
 * 5. **視覚的な良し悪し・置かれた位置のピクセルを1つも見ていない。**
 * 6. **ブラウザの履歴を Playwright から直に動かす口(「戻る」/「進む」に当たる2つの
 *    メソッド)を1度も呼んでいない** —— **動いているのは画面の上のボタンだけである。**
 *    **綴りをここに書かない** —— **このファイルにその2語が1文字も無いことを、
 *    完了条件が `grep` で数えているからである。**
 *
 * ## 名前の出どころ
 *
 * **対象の表・画面・項目はフィクスチャの JSON から機械的に導く**
 * (`checkout-flow.e2e.ts:100`-`:156` と同じ形)。**アプリ固有の名前をこのファイルに
 * 1つも書かない。** 書いてあるのは、**この差分が新しく作る3画面のID
 * (`after-save-landing` / `after-delete-landing` / `other-table-detail`)だけ**である。
 *
 * **`set_roles` を1度も使っていない。** **差分は `POST /api/apps/:app_id/diffs`(HTTP)で入れている。**
 */
import type { APIRequestContext, Page } from "@playwright/test";
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

/** (a) の `after_save` が指す着地先(**フィクスチャ由来ではない**)。 */
const AFTER_SAVE_LANDING = "after-save-landing";
/** (b) の `after_delete` が指す着地先(**同じ表の既定の一覧とは別の画面**)。 */
const AFTER_DELETE_LANDING = "after-delete-landing";
/** (d) の `after_save` が指す「別の表の詳細画面」。 */
const OTHER_TABLE_DETAIL = "other-table-detail";

/** 主題の表を決める一覧(定義順の先頭の `list_view`)。 */
function listViewOf(manifest: Manifest): ListView {
  const view = manifest.app.views.find(
    (candidate): candidate is ListView => candidate.type === "list_view",
  );
  if (view === undefined) {
    throw new Error("フィクスチャに list_view がありません(このテストの前提)。");
  }
  return view;
}

/** 主題の表の入力画面(同じ表の、定義順の先頭の `form`)。 */
function formOf(manifest: Manifest, tableId: string): FormView {
  const view = manifest.app.views.find(
    (candidate): candidate is FormView => candidate.type === "form" && candidate.table === tableId,
  );
  if (view === undefined) {
    throw new Error("フィクスチャに一覧と同じ表の form がありません(このテストの前提)。");
  }
  return view;
}

/** 主題の表の詳細画面(同じ表の、定義順の先頭の `detail_view`)。 */
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

/** (d) が使う「別の表」(主題の表ではない、定義順の先頭の表)。 */
function otherTableOf(manifest: Manifest, tableId: string): Table {
  const table = manifest.app.tables.find((candidate) => candidate.id !== tableId);
  if (table === undefined) {
    throw new Error("フィクスチャに表が2つ以上ありません(このテストの前提)。");
  }
  return table;
}

/** 書換ボタン(`set`)が書き換える項目(**`boolean` の項目1本**)。 */
function flagFieldOf(table: Table): Field {
  const field = table.fields.find((candidate) => candidate.type === "boolean");
  if (field === undefined) {
    throw new Error("フィクスチャに boolean の項目がありません(このテストの前提)。");
  }
  return field;
}

/** 着地先の一覧に出す列(**`text` の項目1本**)。 */
function textFieldOf(table: Table): Field {
  const field = table.fields.find((candidate) => candidate.type === "text");
  if (field === undefined) {
    throw new Error("フィクスチャに text の項目がありません(このテストの前提)。");
  }
  return field;
}

/** ブラウザの入力欄に打ち込む値。**型から機械的に導く**(値を発明しない)。 */
function browserValue(field: Field): string {
  switch (field.type) {
    case "text":
    case "long_text":
      return `${field.id}-after-save`;
    case "number":
      return "7";
    case "date":
      return "2026-02-02";
    default:
      throw new Error(
        `必須項目 ${field.id} の型 ${field.type} は、このテストがブラウザから埋められません。`,
      );
  }
}

/** API から1件作るときの値。**ブラウザに打ち込む値と同じ規則から導く**。 */
function apiValue(field: Field): string | number {
  const typed = browserValue(field);
  return field.type === "number" ? Number(typed) : typed;
}

/** 必須項目だけを埋めたレコード(**任意項目は1つも入れない**)。 */
function requiredOnlyRecord(table: Table): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const field of table.fields) {
    if (field.required === true) {
      record[field.id] = apiValue(field);
    }
  }
  return record;
}

/** 主題の表とその3画面(**段を1つも宣言していない**)。 */
type Subject = {
  app: FixtureApp;
  tableId: string;
  table: Table;
  list: ListView;
  form: FormView;
  detail: DetailView;
  requiredFields: Field[];
};

test.describe("V10-M7-T04 書換・保存・削除のあとの行き先(chromium 実測)", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "行き先の遷移の実測は1つのブラウザで足りる(`checkout-flow.e2e.ts` と同じ理由)",
  );

  /** アプリを1つ払い出し、主題の表と3画面を機械的に選ぶ。**差分はまだ入れない。** */
  async function pickSubject(request: APIRequestContext): Promise<Subject> {
    const app = await provisionApp(request);
    const list = listViewOf(app.manifest);
    const tableId = list.table;
    const table = app.tableOf(tableId);
    const requiredFields = table.fields.filter((field) => field.required === true);
    expect(requiredFields.length).toBeGreaterThan(0);
    return {
      app,
      tableId,
      table,
      list,
      form: formOf(app.manifest, tableId),
      detail: detailOf(app.manifest, tableId),
      requiredFields,
    };
  }

  /** 差分を1本入れる。**201 でなければ本文をそのまま出して落とす。** */
  async function applyDiff(
    request: APIRequestContext,
    subject: Subject,
    diffId: string,
    intent: string,
    operations: unknown[],
  ): Promise<void> {
    const diff = { diff_id: diffId, intent, operations } as unknown as Diff;
    const applied = await request.post(`/api/apps/${subject.app.appId}/diffs`, {
      data: diff,
      headers: subject.app.authHeaders,
    });
    expect(applied.status(), await applied.text()).toBe(201);
  }

  /**
   * **詳細画面が「読み込み中」を抜けるまで待つ。**
   *
   * **`DetailViewRenderer.tsx` は読み込み中にも `data-testid="view-renderer-detail_view"`
   * の `<section>`(骨組み)を出す** —— **その中には書換ボタン(`action-set-*`)も
   * 削除ボタン(`detail-delete`)も1つも無い。****器の出現だけを待って数えると
   * 数が揺れる**(`checkout-flow.e2e.ts:324`-`:335` が同じことで1度落ちている)。
   * **したがって項目の一覧(`detail-fields`)が出るまで待つ。**
   */
  async function expectDetailReady(page: Page): Promise<void> {
    await expect(page.getByTestId("detail-fields")).toBeVisible();
  }

  /**
   * **入力画面が「読み込み中」を抜けるまで待つ。**
   *
   * **`FormRenderer.tsx` も読み込み中に同じ `data-testid="view-renderer-form"` を出す。**
   * **したがって最初の必須項目の入力欄が出るまで待つ**(同上)。
   */
  async function expectFormReady(page: Page, subject: Subject): Promise<void> {
    const first = subject.requiredFields[0];
    if (first === undefined) {
      throw new Error("必須項目が1つもありません(このテストの前提)。");
    }
    await expect(page.getByTestId(`field-input-${first.id}`)).toBeVisible();
  }

  /** 一覧が「読み込み中」を抜けるまで待つ(**表が出るか、空だと言うまで**)。 */
  async function expectListReady(page: Page): Promise<void> {
    await expect(page.getByTestId("list-table").or(page.getByTestId("list-empty"))).toBeVisible();
  }

  /** 入力画面の必須項目をすべて埋めて「保存」を押す。 */
  async function fillAndSave(page: Page, subject: Subject): Promise<void> {
    await expectFormReady(page, subject);
    for (const field of subject.requiredFields) {
      await page.getByTestId(`field-input-${field.id}`).fill(browserValue(field));
    }
    await page.getByRole("button", { name: "保存" }).click();
  }

  test("(a) 詳細画面の書換ボタンが成立すると、`after_save` に宣言した画面へ移る", async ({
    page,
    request,
  }) => {
    const subject = await pickSubject(request);
    const flag = flagFieldOf(subject.table);
    const column = textFieldOf(subject.table);
    await applyDiff(
      request,
      subject,
      "after-save-detail",
      "この画面で値を書き換えたら、別の一覧へ移ってほしい",
      [
        {
          op: "add_view",
          view: {
            id: AFTER_SAVE_LANDING,
            type: "list_view",
            table: subject.tableId,
            columns: [column.id],
          },
        },
        {
          op: "update_view",
          view: subject.detail.id,
          changes: {
            // **段(`flow`)を1バイトも書いていない** —— 段があると `flowNextRoute` が
            // 先に効き、`after_save` はこの経路に届かない。
            actions: [{ set: { field: flag.id, value: true }, name: "書き換える" }],
            after_save: AFTER_SAVE_LANDING,
          },
        },
      ],
    );

    const appId = subject.app.appId;
    const recordId = await subject.app.createRecord(
      subject.tableId,
      requiredOnlyRecord(subject.table),
    );
    await subject.app.authenticate(page.context());
    await page.goto(`/apps/${appId}/views/${subject.detail.id}/records/${recordId}`);
    await expectDetailReady(page);

    await page.getByTestId(`action-set-${flag.id}`).click();

    // --- 画面が入れ替わったことを先に確かめる(**押した直後に DOM を数えない**)-------
    await expect(page).toHaveURL(`/apps/${appId}/views/${AFTER_SAVE_LANDING}`);
    await expectListReady(page);
    // **行は運ばれない**(`ADR-0358`。`DetailViewRenderer.tsx` は `recordId` を渡さない)。
    expect(page.url()).not.toContain("/records/");
    // **元の詳細画面には居ない。**
    expect(page.url()).not.toContain(`/views/${subject.detail.id}`);

    // --- 書換が本当に成立していること(**画面だけの見かけでないこと**)---------------
    const stored = await request.get(
      `/api/apps/${appId}/tables/${subject.tableId}/records/${recordId}`,
      { headers: subject.app.authHeaders },
    );
    expect(stored.status(), await stored.text()).toBe(200);
    const body = (await stored.json()) as { record: Record<string, unknown> };
    expect(body.record[flag.id]).toBe(true);
  });

  test("(b) 削除が成立すると、`after_delete` に宣言した画面へ移る(既定の一覧ではない)", async ({
    page,
    request,
  }) => {
    const subject = await pickSubject(request);
    const column = textFieldOf(subject.table);
    await applyDiff(
      request,
      subject,
      "after-delete-detail",
      "この画面で消したら、別の一覧へ移ってほしい",
      [
        {
          op: "add_view",
          view: {
            id: AFTER_DELETE_LANDING,
            type: "list_view",
            table: subject.tableId,
            columns: [column.id],
          },
        },
        {
          op: "update_view",
          view: subject.detail.id,
          // **行き先にできるのは1件の行を必要としない画面だけである**(`ADR-0359` §4a 限定4)。
          changes: { after_delete: AFTER_DELETE_LANDING },
        },
      ],
    );

    const appId = subject.app.appId;
    const recordId = await subject.app.createRecord(
      subject.tableId,
      requiredOnlyRecord(subject.table),
    );
    await subject.app.authenticate(page.context());
    await page.goto(`/apps/${appId}/views/${subject.detail.id}/records/${recordId}`);
    await expectDetailReady(page);

    await page.getByTestId("detail-delete").click();
    // **確認を挟む**(押した瞬間には消えない。`ADR-0359` §4a 限定6 は確認に触れていない)。
    await expect(page.getByTestId("detail-delete-confirm")).toBeVisible();
    await expect(page).toHaveURL(`/apps/${appId}/views/${subject.detail.id}/records/${recordId}`);

    await page.getByTestId("detail-delete-execute").click();

    // --- 画面が入れ替わったことを先に確かめる ----------------------------------------
    await expect(page).toHaveURL(`/apps/${appId}/views/${AFTER_DELETE_LANDING}`);
    await expectListReady(page);
    // **既定の行き先(同じ表の定義順の先頭の `list_view`)ではない** ——
    // **宣言が既定を上書きしたことが、この1行の主題である。**
    expect(subject.list.id).not.toBe(AFTER_DELETE_LANDING);
    expect(page.url()).not.toContain(`/views/${subject.list.id}`);
    // **着地先の一覧に、消した行は1つも出ない**(このアプリは空になる)。
    await expect(page.getByTestId("list-row")).toHaveCount(0);

    // --- 本当に消えていること(**画面だけの見かけでないこと**)-----------------------
    const stored = await request.get(
      `/api/apps/${appId}/tables/${subject.tableId}/records/${recordId}`,
      { headers: subject.app.authHeaders },
    );
    expect(stored.status()).toBe(404);
  });

  test("(c) 入力画面で保存した行の `_id` が、同じ表の詳細画面の URL に載る", async ({
    page,
    request,
  }) => {
    const subject = await pickSubject(request);
    await applyDiff(
      request,
      subject,
      "after-save-form-same-table",
      "入力して保存したら、いま保存した行の詳細を開いてほしい",
      [
        {
          op: "update_view",
          view: subject.form.id,
          changes: { after_save: subject.detail.id },
        },
      ],
    );

    const appId = subject.app.appId;
    await subject.app.authenticate(page.context());
    await page.goto(`/apps/${appId}/views/${subject.form.id}`);
    await fillAndSave(page, subject);

    // --- 画面が入れ替わったことを先に確かめる ----------------------------------------
    await expect(page).toHaveURL(
      new RegExp(`/apps/${appId}/views/${subject.detail.id}/records/[^/]+$`),
    );
    await expectDetailReady(page);

    // **URL に載った `_id` が、いま保存された行そのものであること。**
    const match = new URL(page.url()).pathname.match(
      new RegExp(`^/apps/${appId}/views/${subject.detail.id}/records/(.+)$`),
    );
    expect(match, `詳細画面の URL に行が載っていない: ${page.url()}`).not.toBeNull();
    const carried = (match as RegExpMatchArray)[1] ?? "";

    const stored = await request.get(
      `/api/apps/${appId}/tables/${subject.tableId}/records/${carried}`,
      { headers: subject.app.authHeaders },
    );
    expect(stored.status(), await stored.text()).toBe(200);
    const body = (await stored.json()) as { record: Record<string, unknown> };
    for (const field of subject.requiredFields) {
      expect(body.record[field.id]).toBe(apiValue(field));
    }
    // **画面にも、いま打った値が出ている。**
    const first = subject.requiredFields[0] as Field;
    await expect(page.getByTestId(`detail-field-${first.id}`)).toHaveText(browserValue(first));
  });

  test("(d) 入力画面の `after_save` に別の表の詳細画面を書くと、`_id` が載らず読めない", async ({
    page,
    request,
  }) => {
    const subject = await pickSubject(request);
    const other = otherTableOf(subject.app.manifest, subject.tableId);
    await applyDiff(
      request,
      subject,
      "after-save-form-other-table",
      "入力して保存したら、別の表の詳細画面を開いてほしい(行き先を間違えた宣言)",
      [
        {
          op: "add_view",
          view: { id: OTHER_TABLE_DETAIL, type: "detail_view", table: other.id },
        },
        {
          op: "update_view",
          view: subject.form.id,
          changes: { after_save: OTHER_TABLE_DETAIL },
        },
      ],
    );

    const appId = subject.app.appId;
    await subject.app.authenticate(page.context());
    await page.goto(`/apps/${appId}/views/${subject.form.id}`);
    await fillAndSave(page, subject);

    // --- 画面が入れ替わったことを先に確かめる ----------------------------------------
    // **行は1バイトも運ばれない**(`ADR-0357` 限定3a-2。同じ表の詳細のときだけ運ぶ)。
    await expect(page).toHaveURL(`/apps/${appId}/views/${OTHER_TABLE_DETAIL}`);
    const detail = page.getByTestId("view-renderer-detail_view");
    await expect(detail).toBeVisible();
    expect(page.url()).not.toContain("/records/");

    // **項目の並びは1つも描かれない** —— **どの行を出すのかを URL が言っていないためである。**
    await expect(page.getByTestId("detail-fields")).toHaveCount(0);
    // **【出る文言はそのまま貼る。丸めない】**(`DetailViewRenderer.tsx:405`-`:417`)
    await expect(detail).toContainText(
      `ビュー "${OTHER_TABLE_DETAIL}" は1件のレコードを表示する画面ですが、URL に対象のレコードが指定されていません。`,
    );
    await expect(detail).toContainText("一覧から行を選ぶと、そのレコードの詳細が開きます。");

    // --- 保存そのものは成立している(**壊れているのは行き先だけである**)-------------
    const listed = await request.get(`/api/apps/${appId}/tables/${subject.tableId}/records`, {
      headers: subject.app.authHeaders,
    });
    expect(listed.status(), await listed.text()).toBe(200);
    const body = (await listed.json()) as { records: Record<string, unknown>[] };
    expect(body.records).toHaveLength(1);
  });
});
