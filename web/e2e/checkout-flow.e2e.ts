/**
 * **買い物の流れ5段を、本物のブラウザ(chromium)で端から端まで押し切る**
 * (`V10-M7-T03`。`NV-G9` / `NV-G11` / `ADR-0359` §4b / `ADR-0360`)。
 *
 * ## 既存ファイルとの違い(**重ならない側だけを足す**)
 *
 * **`web/e2e/flow-steps.e2e.ts` が既に実測しているものを、ここでは1本も書き直していない。**
 * 同ファイルが持っているのは次の3本である:
 *
 * | `flow-steps.e2e.ts` が既に測っているもの | 本ファイルの扱い |
 * |---|---|
 * | **4段**(`list_view` → `form` → `detail_view`(`confirm`)→ `list_view`)を端から端まで押す | **書き直さない。** ここは**5段**で、**`detail_view` が2枚続く**形である |
 * | 段2(`form`)の「戻る」を押すと段1 の URL へ戻る | **押していない。** ここは**「戻る」が出ない段を数える**側だけを足す |
 * | 段2 の URL を直接開くと「戻る」が効かない(履歴が無い場合) | **触れていない。** `location.replace` を1度も使っていない |
 *
 * **本ファイルが新しく足すのは次の4点である**(いずれも `flow-steps.e2e.ts` に1本も無い):
 *
 * 1. **段が5つある流れ**(同ファイルは4段まで)。**`flow-position` の総数が `全5段` になる。**
 * 2. **`detail_view` が2枚続く形** —— **段3(`kind: "input"`)と段4(`kind: "confirm"`)が
 *    同じ表の別の詳細画面であり、段2 で保存した行の `_id` が両方の URL に載る。**
 *    同ファイルの `detail_view` は1枚だけである。
 * 3. **段3 に進み口が2つ同時に並ぶこと**(「次へ」と操作起点の `set`)。
 *    同ファイルの `detail_view` は `kind: "confirm"` なので「次へ」が出ず、**2つ並ぶ状態が
 *    1度も現れない。**
 * 4. **`st_owner`(個人所有の規約フィールド)を後から足した表で、段5 に何行見えるか。**
 *    同ファイルは `st_owner` を1文字も書いていない(既定セッション owner の1人しか居ない)。
 *
 * ## 建てる5段
 *
 * | 段 | 種別 | `flow.kind` | 進み方 |
 * |---:|---|---|---|
 * | 1 | `list_view` | `input` | 「次へ」 |
 * | 2 | `form` | `input` | 保存(行が1つできる) |
 * | 3 | `detail_view` | `input` | 操作起点 `set`。**「次へ」も同時に出る** |
 * | 4 | `detail_view` | `confirm` | 操作起点 `set`。「次へ」は出ない |
 * | 5 | `list_view` | `input` | —— |
 *
 * ## 製品の規則(**この形でないと通らない。実装を1バイトも変えていない**)
 *
 * - **行を運べるのは「次の段が同じ表の `detail_view`」のときだけである**
 *   (`web/src/views/flow.ts:70`-`:72`)—— **`form` へは運ばれない。**
 * - **確認の段(`kind: "confirm"`)と入力画面(`form`)には「次へ」が出ない**
 *   (`web/src/views/ViewHost.tsx:112`-`:114` の逐語
 *   `here.kind !== "confirm" && view.type !== "form" &&`)。
 * - **「戻る」(`flow-back` / `flow-back-button`)は `form` にしか無い**
 *   (`web/src/views/FormRenderer.tsx:503`-`:507`)—— **`detail_view` にも `list_view` にも
 *   1ピクセルも出ない。**
 *   **【2026-08-21 訂正(`V10-M18-T03` / `FU-G3`)。上の3行は1バイトも消していない】**
 *   **その字面は今日は偽である。** **「戻る」は `web/src/views/ViewHost.tsx` の1本になり、
 *   段を宣言した `list_view` / `detail_view` / `form` の3種別すべてに出る。**
 *   **出ないのは「段を宣言していない画面」と「重ねて出す画面」だけである**
 *   (実測は下の「「戻る」は段を宣言した3種別すべてに出る…」の本)。
 * - **詳細画面の操作起点(`set`)が成立すると段が進む**(`web/src/views/DetailViewRenderer.tsx:608`-`:612`。
 *   **`after_save` より段が優先される**)。
 * - **`step` は1から始まる連番である** —— **重複・欠番は差分の適用時に拒否される。**
 *
 * ## このファイルが証明しないこと(**誇張しないための境界**)
 *
 * 1. **「買い物ができるようになった」と書かない。** **ここで確かめているのは、
 *    宣言した5段を人が押し切れることと、そのとき画面に何が出る / 出ないかだけである。**
 *    **在庫も金額も決済も1つも動かしていない**(題材はフィクスチャの備品の表である)。
 * 2. **`run` 形の確定を1度も押していない**(押しても次の段へ進まない。`V10-M4` の決8)。
 * 3. **未ログイン・`viewer`・`customer` の DOM を1度も見ていない。**
 *    測っているのは既定セッション(owner)と、追加で仕込んだ1人だけである。
 * 4. **視覚的な良し悪し・置かれた位置のピクセルを1つも見ていない。**
 * 5. **ブラウザの履歴を Playwright から直に動かす口(「戻る」/「進む」に当たる2つの
 *    メソッド)を1度も呼んでいない** —— **動いているのは画面の上のボタンだけである。**
 *    **綴りをここに書かない** —— **このファイルにその2語が1文字も無いことを、
 *    完了条件が `grep` で数えているからである。**
 *
 * ## 名前の出どころ
 *
 * **対象の表・画面・項目はフィクスチャの JSON から機械的に導く**
 * (`flow-steps.e2e.ts:100`-`:137` と同じ形)。**アプリ固有の名前をこのファイルに
 * 1つも書かない。** 書いてあるのは、**この差分が新しく作る画面のID(`flow5-confirm` /
 * `flow5-done`)と流れのID(`kaimono`)、そしてサーバ規約のフィールドID(`st_owner`)だけ**である。
 *
 * **`set_roles` を1度も使っていない**(`flow-steps.e2e.ts:61`-`:65` と同じ理由)。
 * **差分は `POST /api/apps/:app_id/diffs`(HTTP)で入れている。**
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
import { type FixtureApp, provisionApp, seedRoleSession } from "./fixture-app.ts";

/** この差分が作る流れの名前と、足す2画面のID(**フィクスチャ由来ではない**)。 */
const FLOW_ID = "kaimono";
const STEP4_VIEW_ID = "flow5-confirm";
const STEP5_VIEW_ID = "flow5-done";

/** 個人所有を表すフィールドID(サーバ規約 `src/server/owner-scope.ts` の `OWNER_FIELD`)。 */
const OWNER_FIELD = "st_owner";

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

/** 段3 の確定で書き換える項目(**`boolean` の項目1本**)。 */
function flagFieldOf(table: Table): Field {
  const field = table.fields.find((candidate) => candidate.type === "boolean");
  if (field === undefined) {
    throw new Error("フィクスチャに boolean の項目がありません(このテストの前提)。");
  }
  return field;
}

/** 段4 の確定で書き換える項目(**`long_text` の項目1本**。段3 と別の項目にする)。 */
function memoFieldOf(table: Table): Field {
  const field = table.fields.find((candidate) => candidate.type === "long_text");
  if (field === undefined) {
    throw new Error("フィクスチャに long_text の項目がありません(このテストの前提)。");
  }
  return field;
}

/** 段5 の一覧に出す列(**`text` の項目1本**)。 */
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
      return `${field.id}-kaimono`;
    case "number":
      return "5";
    case "date":
      return "2026-01-01";
    default:
      throw new Error(
        `必須項目 ${field.id} の型 ${field.type} は、このテストがブラウザから埋められません。`,
      );
  }
}

/** 5段の宣言が済んだアプリと、そこで使う画面・項目。 */
type FiveSteps = {
  app: FixtureApp;
  tableId: string;
  table: Table;
  step1: ListView;
  step2: FormView;
  step3: DetailView;
  flag: Field;
  memo: Field;
  /** 段4 の確定が書き込む値(**型から機械的に導いた1つのリテラル**)。 */
  confirmedValue: string;
  requiredFields: Field[];
};

test.describe("V10-M7-T03 買い物の流れ5段を端から端まで押す(chromium 実測)", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "段の遷移の実測は1つのブラウザで足りる(`flow-steps.e2e.ts` と同じ理由)",
  );

  /**
   * **5段を宣言する**(既存の3画面に `flow` を足し、`detail_view` と `list_view` を1本ずつ足す)。
   *
   * `ownerField` を真にすると、**同じ差分で `st_owner` を足す**(個人所有の規約)。
   */
  async function declareFiveSteps(
    request: APIRequestContext,
    options: { ownerField: boolean; diffId: string },
  ): Promise<FiveSteps> {
    const app = await provisionApp(request);
    const step1 = listViewOf(app.manifest);
    const tableId = step1.table;
    const table = app.tableOf(tableId);
    const step2 = formOf(app.manifest, tableId);
    const step3 = detailOf(app.manifest, tableId);
    const flag = flagFieldOf(table);
    const memo = memoFieldOf(table);
    const column = textFieldOf(table);
    const confirmedValue = `${memo.id}-confirmed`;
    const requiredFields = table.fields.filter((field) => field.required === true);
    expect(requiredFields.length).toBeGreaterThan(0);

    const operations: unknown[] = [];
    if (options.ownerField) {
      // **サーバ規約は「`id` が `st_owner`・型 `text`・`required` でない」**
      // (`web/e2e/owner-scope.e2e.ts` の逐語と同じ形)。
      operations.push({
        op: "add_field",
        table: tableId,
        field: { id: OWNER_FIELD, name: "所有者", type: "text" },
      });
    }
    operations.push(
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
          // **段3 は入力の段である** —— **「次へ」と操作起点が同時に出る唯一の段。**
          flow: { id: FLOW_ID, step: 3, kind: "input" },
          actions: [{ set: { field: flag.id, value: true }, name: "進める" }],
        },
      },
      {
        op: "add_view",
        view: {
          id: STEP4_VIEW_ID,
          type: "detail_view",
          table: tableId,
          // **段3 と同じ表の、別の `detail_view` である**(だから段3 から行が運ばれる)。
          flow: { id: FLOW_ID, step: 4, kind: "confirm" },
          actions: [{ set: { field: memo.id, value: confirmedValue }, name: "確定する" }],
        },
      },
      {
        op: "add_view",
        view: {
          id: STEP5_VIEW_ID,
          type: "list_view",
          table: tableId,
          columns: [column.id],
          flow: { id: FLOW_ID, step: 5, kind: "input" },
        },
      },
    );

    const diff = {
      diff_id: options.diffId,
      intent: "買う流れを、一覧 → 入力 → 確認前 → 確認 → 完了 の5段にしたい",
      operations,
    } as unknown as Diff;
    const applied = await request.post(`/api/apps/${app.appId}/diffs`, {
      data: diff,
      headers: app.authHeaders,
    });
    expect(applied.status(), await applied.text()).toBe(201);

    return {
      app,
      tableId,
      table,
      step1,
      step2,
      step3,
      flag,
      memo,
      confirmedValue,
      requiredFields,
    };
  }

  /**
   * **入力画面が「読み込み中」を抜けるまで待つ。**
   *
   * **【実測で1度落ちた。隠さない】** **`FormRenderer.tsx` は読み込み中にも
   * `data-testid="view-renderer-form"` の `<section>` を出す**(同ファイルの
   * `state.status === "loading"` の分岐)。**その分岐には「戻る」(`flow-back`)も
   * 入力欄も1つも無い** —— **`view-renderer-form` の出現だけを待つと、
   * 「戻る」を数えたときに 0 が返る**(そう書いて実際に赤くなった)。
   * **したがって最初の必須項目の入力欄が出るまで待つ。**
   *
   * **【2026-08-21 訂正(`V10-M18-T03` / `FU-G3`)。上の行は1バイトも消していない】**
   * **待つ必要は今日も在るが、理由の半分は失効した。** **「戻る」は器
   * (`web/src/views/ViewHost.tsx`)へ移り、本体の**外**に出るようになったので、
   * **読み込み中でも `flow-back` は 1 と数えられる**(0 にならない)。
   * **今日この待ちが要るのは、入力欄そのものを埋める段取りのためである。**
   */
  async function expectFormReady(page: Page, steps: FiveSteps): Promise<void> {
    const first = steps.requiredFields[0];
    if (first === undefined) {
      throw new Error("必須項目が1つもありません(このテストの前提)。");
    }
    await expect(page.getByTestId(`field-input-${first.id}`)).toBeVisible();
  }

  /**
   * **詳細画面が「読み込み中」を抜けるまで待つ。**
   *
   * **【実測で1度、数が揺れた。隠さない】** **`DetailViewRenderer.tsx` も読み込み中に
   * `data-testid="view-renderer-detail_view"` の `<section>`(骨組み)を出す** ——
   * **その中には操作起点(`action-set-*`)も編集ボタンも「閲覧のみ」注記も1つも無い。**
   * **`view-renderer-detail_view` の出現だけを待って数えると、同じ筋書きで
   * `action-set=1` と `action-set=0` の両方が出た**(2回の実行で実際に割れた)。
   * **したがって項目の一覧(`detail-fields`)が出るまで待つ。**
   */
  async function expectDetailReady(page: Page): Promise<void> {
    await expect(page.getByTestId("detail-fields")).toBeVisible();
  }

  /**
   * **段1 →(「次へ」)→ 段2 →(保存)→ 段3** まで押して、段3 で開いている行の `_id` を返す。
   *
   * **`page.goto` を打つのは段1 に入るときの1回だけである。**
   */
  async function walkToStep3(page: Page, steps: FiveSteps): Promise<string> {
    await page.goto(`/apps/${steps.app.appId}/views/${steps.step1.id}`);
    await page.getByTestId("flow-next-button").click();
    await expectFormReady(page, steps);
    for (const field of steps.requiredFields) {
      await page.getByTestId(`field-input-${field.id}`).fill(browserValue(field));
    }
    await page.getByRole("button", { name: "保存" }).click();
    await expect(page.getByTestId("view-renderer-detail_view")).toBeVisible();
    await expectDetailReady(page);
    const match = new URL(page.url()).pathname.match(
      new RegExp(`^/apps/${steps.app.appId}/views/${steps.step3.id}/records/(.+)$`),
    );
    expect(match, `段3 の URL に行が載っていない: ${page.url()}`).not.toBeNull();
    return (match as RegExpMatchArray)[1] ?? "";
  }

  test("段1 → 段2 → 段3 → 段4 → 段5 を、すべてボタンで押し切る", async ({ page, request }) => {
    const steps = await declareFiveSteps(request, { ownerField: false, diffId: "checkout-flow-5" });
    await steps.app.authenticate(page.context());
    const appId = steps.app.appId;

    // --- 段1: 一覧 -----------------------------------------------------------------
    await page.goto(`/apps/${appId}/views/${steps.step1.id}`);
    await expect(page.getByTestId("flow-position")).toHaveText("1段目 / 全5段");
    expect(page.url()).not.toContain(FLOW_ID);
    expect(page.url()).not.toContain("step");
    await page.getByTestId("flow-next-button").click();

    // --- 段2: 入力 -----------------------------------------------------------------
    await expectFormReady(page, steps);
    expect(new URL(page.url()).pathname).toBe(`/apps/${appId}/views/${steps.step2.id}`);
    await expect(page.getByTestId("flow-position")).toHaveText("2段目 / 全5段");
    // **入力画面には「次へ」が出ない**(`ViewHost.tsx:112`-`:114` の `view.type !== "form"`)。
    expect(await page.getByTestId("flow-next").count()).toBe(0);
    expect(page.url()).not.toContain(FLOW_ID);
    expect(page.url()).not.toContain("step");
    const typed = new Map<string, string>();
    for (const field of steps.requiredFields) {
      const value = browserValue(field);
      typed.set(field.id, value);
      await page.getByTestId(`field-input-${field.id}`).fill(value);
    }
    await page.getByRole("button", { name: "保存" }).click();

    // --- 段3: 詳細(入力の段)-------------------------------------------------------
    await expect(page.getByTestId("flow-position")).toHaveText("3段目 / 全5段");
    await expect(page.getByTestId("view-renderer-detail_view")).toBeVisible();
    await expectDetailReady(page);
    const step3Url = new URL(page.url());
    const match = step3Url.pathname.match(
      new RegExp(`^/apps/${appId}/views/${steps.step3.id}/records/(.+)$`),
    );
    expect(match, `段3 の URL に行が載っていない: ${step3Url.pathname}`).not.toBeNull();
    const recordId = (match as RegExpMatchArray)[1] ?? "";
    expect(recordId.length).toBeGreaterThan(0);
    // **段2 で打った値がそのまま開いている。**
    for (const [fieldId, value] of typed) {
      await expect(page.getByTestId(`detail-field-${fieldId}`)).toContainText(value);
    }
    expect(step3Url.search).toBe("");
    expect(step3Url.href).not.toContain(FLOW_ID);
    expect(step3Url.href).not.toContain("step");
    // **進むのは操作起点である**(「次へ」も出ているが、押すのは `set` の側)。
    await page.getByTestId(`action-set-${steps.flag.id}`).click();

    // --- 段4: 詳細(確認の段)-------------------------------------------------------
    /*
     * **`view-renderer-detail_view` の出現を待つだけでは足りない**(実測で1度落ちた)——
     * **段3 も段4 も同じ `data-testid` の詳細画面であり、押した直後はまだ段3 が
     * 描かれている。** **段が動いたことは `flow-position` の数でしか見分けられない。**
     */
    await expect(page.getByTestId("flow-position")).toHaveText("4段目 / 全5段");
    await expect(page.getByTestId("view-renderer-detail_view")).toBeVisible();
    await expectDetailReady(page);
    const step4Url = new URL(page.url());
    // **段2 で保存した行の `_id` が、段3 と段4 の**両方**の URL に載る**
    // (`flow.ts:70`-`:72`。次の段が同じ表の `detail_view` だから運ばれた)。
    expect(step4Url.pathname).toBe(`/apps/${appId}/views/${STEP4_VIEW_ID}/records/${recordId}`);
    // **確認の段に「次へ」は1つも出ない**(`ViewHost.tsx` の `here.kind !== "confirm"`)。
    expect(await page.getByTestId("flow-next").count()).toBe(0);
    expect(step4Url.search).toBe("");
    expect(step4Url.href).not.toContain(FLOW_ID);
    expect(step4Url.href).not.toContain("step");
    const commit = page.getByTestId(`action-set-${steps.memo.id}`);
    await expect(commit).toHaveText("確定する");
    await commit.click();

    // --- 段5: 完了 -----------------------------------------------------------------
    await expect(page.getByTestId("flow-position")).toHaveText("5段目 / 全5段");
    await expect(page.getByTestId("view-renderer-list_view")).toBeVisible();
    const step5Url = new URL(page.url());
    expect(step5Url.pathname).toBe(`/apps/${appId}/views/${STEP5_VIEW_ID}`);
    // **最後の段なので「次へ」は出ない。**
    expect(await page.getByTestId("flow-next").count()).toBe(0);
    expect(step5Url.search).toBe("");
    expect(step5Url.href).not.toContain(FLOW_ID);
    expect(step5Url.href).not.toContain("step");
    expect(step5Url.href).not.toContain("/records/");

    // **2つの確定が本当に書けている**(表示層の遷移だけを見て「確定できた」と書かない)。
    const read = await request.get(
      `/api/apps/${appId}/tables/${steps.tableId}/records/${recordId}`,
      { headers: steps.app.authHeaders },
    );
    expect(read.status(), await read.text()).toBe(200);
    const body = (await read.json()) as { record: Record<string, unknown> };
    expect(body.record[steps.flag.id]).toBe(true);
    expect(body.record[steps.memo.id]).toBe(steps.confirmedValue);
  });

  test("段3 には進み口が2つ同時に並ぶ(「次へ」と操作起点)", async ({ page, request }) => {
    const steps = await declareFiveSteps(request, {
      ownerField: false,
      diffId: "checkout-flow-2ways",
    });
    await steps.app.authenticate(page.context());
    await walkToStep3(page, steps);

    // **同時に出ていることを数で示す。**
    const next = page.getByTestId("flow-next-button");
    const action = page.getByTestId(`action-set-${steps.flag.id}`);
    await expect(next).toBeVisible();
    await expect(action).toBeVisible();
    expect(await next.count()).toBe(1);
    expect(await action.count()).toBe(1);
    // **押せる進み口はこの2つだけである**(器の「次へ」1つ + 宣言した操作起点1つ)。
    expect(await page.getByTestId("flow-next").count()).toBe(1);
    // **「次へ」の文言は表示層のリテラルであり、マニフェストから1文字も取っていない。**
    await expect(next).toHaveText("次へ");
    // **操作起点の文言は `actions[].name`(既存語彙)から出ている。**
    await expect(action).toHaveText("進める");
  });

  /**
   * **【2026-08-21 に名前ごと書き換えた(`V10-M18-T03` / `FU-G3`)】**
   *
   * **旧の検査名を逐語で控える**:
   * `「戻る」が出るのは段2 だけである(段3 / 段4 / 段5 では0個)`
   *
   * **偽になった理由**: **「戻る」の実装が入力画面の中から器
   * (`web/src/views/ViewHost.tsx`)へ移り、段を宣言していれば種別を問わず出るように
   * なった。** **旧の本文が 0 を期待していた4箇所(段1 / 段3 / 段4 / 段5)は、
   * **すべて 1 になる。**
   *
   * **この本が測らないこと**: **押した先へ1度も行っていない**(押した後の挙動は
   * `web/e2e/flow-steps.e2e.ts` の2本が持つ)。
   */
  test("「戻る」は段を宣言した5段すべてに出る(種別を問わない。押さない)", async ({
    page,
    request,
  }) => {
    const steps = await declareFiveSteps(request, {
      ownerField: false,
      diffId: "checkout-flow-back",
    });
    await steps.app.authenticate(page.context());

    // --- 段1 → 段2 ------------------------------------------------------------------
    await page.goto(`/apps/${steps.app.appId}/views/${steps.step1.id}`);
    // **段1(`list_view`)にも1つ出る**(器へ移す前は 0 だった)。
    await expect(page.getByTestId("flow-position")).toHaveText("1段目 / 全5段");
    expect(await page.getByTestId("flow-back").count()).toBe(1);
    await expect(page.getByTestId("flow-back-button")).toBeVisible();
    // **文言は表示層のリテラル1つである**(マニフェストから1文字も取っていない)。
    await expect(page.getByTestId("flow-back-button")).toHaveText("戻る");
    await page.getByTestId("flow-next-button").click();
    await expectFormReady(page, steps);
    // **段2(`form`)には今日どおり1つ出る。****押さない** —— 押した先の挙動は
    // `flow-steps.e2e.ts` の2本が既に測っている。
    expect(await page.getByTestId("flow-back").count()).toBe(1);
    await expect(page.getByTestId("flow-back-button")).toBeVisible();
    // **入力画面では、本体の `<section>` の**外**に出た**(`FU-G3` の移送で DOM が
    // 変わった唯一の並びの点。**隠さない**)。
    expect(await page.getByTestId("view-renderer-form").getByTestId("flow-back").count()).toBe(0);

    // --- 段3 -------------------------------------------------------------------------
    for (const field of steps.requiredFields) {
      await page.getByTestId(`field-input-${field.id}`).fill(browserValue(field));
    }
    await page.getByRole("button", { name: "保存" }).click();
    await expect(page.getByTestId("view-renderer-detail_view")).toBeVisible();
    await expect(page.getByTestId("flow-position")).toHaveText("3段目 / 全5段");
    await expectDetailReady(page);
    // **段3(`detail_view` / `kind: "input"`)にも1つ出る。**
    expect(await page.getByTestId("flow-back").count()).toBe(1);

    // --- 段4 -------------------------------------------------------------------------
    await page.getByTestId(`action-set-${steps.flag.id}`).click();
    await expect(page.getByTestId("flow-position")).toHaveText("4段目 / 全5段");
    await expectDetailReady(page);
    // **確認の段(`kind: "confirm"`)にも1つ出る**(段の種類で分岐していない)。
    expect(await page.getByTestId("flow-back").count()).toBe(1);

    // --- 段5 -------------------------------------------------------------------------
    await page.getByTestId(`action-set-${steps.memo.id}`).click();
    await expect(page.getByTestId("view-renderer-list_view")).toBeVisible();
    await expect(page.getByTestId("flow-position")).toHaveText("5段目 / 全5段");
    await expect(page.getByTestId("list-total")).toBeVisible();
    // **最後の段(`list_view`)にも1つ出る**(段の位置で分岐していない)。
    expect(await page.getByTestId("flow-back").count()).toBe(1);
  });

  /**
   * **段5(`list_view`)の行を押しても、段3 / 段4 の詳細画面へ着地しない**
   * (`V10-M18-T01`。`FU-G1a` / `ADR-0362` §Decision 1 の遷移点1・§Decision 3)。
   *
   * **この5段の題材は、その条件を素で満たしている** —— **段5 の表の `detail_view` は
   * 段3 と段4 の2枚だけであり、どちらも `flow` を宣言しているからである。**
   * **したがって候補が0枚になり、行はクリックできなくなる。**
   *
   * **【禁止】これを「注文の中身が見られるようになった」と読まない**
   * (`ADR-0362` §Consequences)—— **消えたのは「押すと確認の段へ戻る」という症状で
   * あって、同時に中身を開く道も消えている。** **埋め合わせ(一覧の行に操作起点を1本
   * 置く)は本タスクが1バイトも実装していない**(`ADR-0362` 限定4)。
   *
   * **このテストが言えないこと**: **段を1つも宣言していない一覧の行が今日どおり押せる
   * ことは、ここでは1度も押していない**(それは `web/e2e/record-navigation.e2e.ts` と
   * `web/test/list-view.test.tsx` が持つ)。
   */
  test("段5 の行を押しても、段3 / 段4 の詳細へ着地しない(FU-G1a / ADR-0362)", async ({
    page,
    request,
  }) => {
    const steps = await declareFiveSteps(request, {
      ownerField: false,
      diffId: "checkout-flow-rowclick",
    });
    await steps.app.authenticate(page.context());

    // --- 段1 → 段5 まで押し切って、段5 に行を1つ作る -----------------------------------
    await walkToStep3(page, steps);
    await page.getByTestId(`action-set-${steps.flag.id}`).click();
    await expect(page.getByTestId("flow-position")).toHaveText("4段目 / 全5段");
    await expectDetailReady(page);
    await page.getByTestId(`action-set-${steps.memo.id}`).click();
    await expect(page.getByTestId("flow-position")).toHaveText("5段目 / 全5段");
    await expect(page.getByTestId("list-total")).toBeVisible();
    expect(await page.getByTestId("list-row").count()).toBe(1);

    // --- 行を押す -------------------------------------------------------------------
    const before = page.url();
    const row = page.getByTestId("list-row").first();
    // **押せる印が1つも付いていない**(`ListViewRenderer` の `interactive`)。
    expect(await page.locator(".list-row-interactive").count()).toBe(0);
    expect(await row.getAttribute("tabindex")).toBeNull();
    await row.click();
    // **URL が1文字も動かない** —— **段3 にも段4 にも着地しない。**
    expect(page.url()).toBe(before);
    expect(page.url()).not.toContain(steps.step3.id);
    expect(page.url()).not.toContain(STEP4_VIEW_ID);
    expect(page.url()).not.toContain("/records/");
    // **別の画面へ倒していない**(`ADR-0362` §Decision 3)—— **段5 のままである。**
    await expect(page.getByTestId("view-renderer-list_view")).toBeVisible();
    await expect(page.getByTestId("flow-position")).toHaveText("5段目 / 全5段");
    // **Enter でも開かない**(キーボードの経路も同じ判定1本である)。
    await row.press("Enter");
    expect(page.url()).toBe(before);
  });

  /**
   * **`st_owner`(個人所有の規約)を後から足したときに、段が何を見せるかを測る。**
   *
   * **このテストは「こうなるはず」を1つも決め打ちしていない。** **まず実際の値を出し、
   * 出た値をそのまま期待値として固定した**(3回続けて同じ値が出ることを確かめてある)。
   * **躓きに当たった箇所を「直して」いない** —— **製品コード(`web/src/` / `src/` /
   * `schemas/`)を1バイトも書き換えていない。**
   */
  test("`st_owner` を足した表で、買った人と運営が段5 に何行見るか", async ({
    page,
    request,
    browser,
  }) => {
    const steps = await declareFiveSteps(request, {
      ownerField: true,
      diffId: "checkout-flow-owner",
    });
    const appId = steps.app.appId;
    // **買った人**(既定セッションの owner とは別のユーザ)。
    const buyer = await seedRoleSession(request, appId, "editor");
    await buyer.authenticate(page.context());

    // --- 買った人が段3 まで押す -------------------------------------------------------
    const recordId = await walkToStep3(page, steps);

    /*
     * **【躓き (i) を実測した。直していない】`st_owner` は詳細画面の編集・削除を消す。**
     *
     * **買った人自身が今この場で保存した行なのに、「閲覧のみ(書き込み権限がありません)」
     * が出て、編集ボタンも削除ボタンも1つも出ない。**
     *
     * **原因は下の `st_owner` の値である**(すぐ下で実測して固定している)——
     * **サーバが `st_owner` に書いたのは `seedRoleSession` が返す `userId` ではなく
     * `username` の側の文字列であり、画面側の判定(`web/src/auth/authz.tsx` の
     * `canWriteRowScope` → `isOwnerVisible`)が持つ id と一致しない。**
     * **一致しないので「他人の個人行」と見なされ、編集/削除の導線が消える。**
     *
     * **それでも流れは止まらない** —— **操作起点(`action-set-*`)は出ている。**
     * **`DetailViewRenderer.tsx` の `writableActions` は行の持ち主を1度も見ておらず、
     * `canWriteRole` 1本で決まるからである**(編集/削除だけが行の持ち主を見る)。
     * **したがって「編集は押せないが、流れは押し切れる」という食い違った画面になる。**
     */
    expect(await page.getByTestId(`action-set-${steps.flag.id}`).count()).toBe(1);
    expect(await page.getByTestId("flow-next-button").count()).toBe(1);
    expect(await page.getByTestId("detail-edit").count()).toBe(0);
    expect(await page.getByTestId("detail-delete").count()).toBe(0);
    expect(await page.getByTestId("detail-read-only").count()).toBe(1);
    await expect(page.getByTestId("detail-read-only")).toHaveText(
      "閲覧のみ(書き込み権限がありません)。",
    );

    // --- 段4 → 段5(買った人は最後まで押し切れる)-------------------------------------
    await page.getByTestId(`action-set-${steps.flag.id}`).click();
    await expect(page.getByTestId("flow-position")).toHaveText("4段目 / 全5段");
    await expectDetailReady(page);
    await page.getByTestId(`action-set-${steps.memo.id}`).click();
    await expect(page.getByTestId("flow-position")).toHaveText("5段目 / 全5段");
    await expect(page.getByTestId("list-total")).toBeVisible();
    // **買った人は、段5 で自分の行を1件見られる。**
    expect(await page.getByTestId("list-row").count()).toBe(1);
    await expect(page.getByTestId("list-total")).toHaveText("1–1 件 / 全 1 件");

    /*
     * **【躓き (ii) を実測した。直していない】`st_owner` と付与の重ね方。**
     *
     * **運営(owner)が同じ段5 を開くと、買った人の行が**そのまま1行見える。**
     * **「運営には1行も見えない」でも「買った人の行だけが伏せられる」でもない。**
     *
     * **理由は2つが噛み合った結果である**(どちらも実装の逐語に書かれている):
     *
     * 1. **`st_owner` を `add_field` で後から足した表には、役割の付与に条件が付かない**
     *    (`src/kernel/apply-diff.ts` の「`add_field` で後から `st_owner` を足した表には
     *    条件が付かない(自動付与は `add_table` の時点で入るので、そのときの姿しか
     *    見ていない)」)。**この題材では `web/e2e/fixture-server.ts` が払い出しの時点で
     *    「表 × 読取」を条件なしで配っており、その時点でこの表はまだ `st_owner` を
     *    宣言していない。**
     * 2. **面の規則が読取を許している表では、`st_owner` の絞り込みを**読取についてだけ**
     *    越える**(`src/server/owner-scope.ts` の `roleReadCrossesOwnerScope`)。
     *    **その関数は `owner` を1文字も特別扱いしていない** —— **越えるのは
     *    「表 × 読取」を持つ役割**全員**である。**
     *
     * **したがって、買った人(`editor`)にも運営(`owner`)にも同じ1行が見える。**
     * **書込の側は越えない**(上の編集ボタンが消えているのがその現れである)。
     *
     * ## **【2026-09-08。`V17-M5-T05` / 台帳 `AC-G33`(`:1862`)/ `ADR-0423`。
     *    上の段落を1バイトも消していない。期待値を反転させた】**
     *
     * **上の理由 1 は今日は偽である。** **`V17-M5-T05` が補完の呼び出しを
     * `foldOperations` の出口へ移したので、`add_field` で後から `st_owner` を足した表にも
     * 「自分の行、または持ち主が空の行」という条件が付く**(**補ったことは
     * `apply_diff` / `POST /diffs` の応答の `role_condition_notices` に
     * 4種目 `owner_scope_supplied` として載って返る**)。
     * **理由 2(`roleReadCrossesOwnerScope` が `owner` を特別扱いしない)は今日も真である** ——
     * **`src/server/owner-scope.ts` は1バイトも動いていない。**
     * **変わったのは、その関数が読む規則に条件が入ったことだけである。**
     *
     * **今日の実測**: **買った人は自分の行を1件見る(上の期待値は動いていない)。**
     * **運営(`owner`)は0件になる** —— **`owner` の規則にも同じ条件が補われるからである。**
     * **【誇張しない】これは「運営から隠す機能を足した」のではない** ——
     * **既定3役割のうち `owner` だけを補完から外していないので、
     * 運営も「自分の行と持ち主が空の行」しか見なくなった、という副作用である。**
     * **【この題材が今日も示していないこと】** **`st_owner` に書かれている値は
     * `username` の側であり、画面の判定が持つ `userId` と一致しない**(躓き (i))——
     * **その食い違いは1バイトも直っていない。**
     *
     * **旧の期待値(逐語)**:
     *   ```
     *   expect(await adminPage.getByTestId("list-row").count()).toBe(1);
     *   await expect(adminPage.getByTestId("list-total")).toHaveText("1–1 件 / 全 1 件");
     *   ```
     */
    const adminContext = await browser.newContext();
    await steps.app.authenticate(adminContext);
    const adminPage = await adminContext.newPage();
    await adminPage.goto(`/apps/${appId}/views/${STEP5_VIEW_ID}`);
    await expect(adminPage.getByTestId("list-total")).toBeVisible();
    expect(await adminPage.getByTestId("list-row").count()).toBe(0);
    await expect(adminPage.getByTestId("list-total")).toHaveText("0 件");
    await adminContext.close();

    /*
     * **サーバから見た姿も同じである**(画面だけを見て「分離されていない」と書かない)。
     * **そして `st_owner` に入っている値そのものを固定する** —— **躓き (i) の原因は
     * これであり、推測ではなく実測である。**
     *
     * **【2026-09-08。`V17-M5-T05` / `AC-G33` / `ADR-0423`。旧の本体を逐語で残す】**
     * **旧: 買った人と運営の2つのヘッダを同じ `for` で回し、どちらも `total = 1` を撃っていた。**
     *   ```
     *   for (const headers of [buyer.authHeaders, steps.app.authHeaders]) {
     *     const listed = await request.get(`/api/apps/${appId}/tables/${steps.tableId}/records`, {
     *       headers,
     *     });
     *     expect(listed.status(), await listed.text()).toBe(200);
     *     const body = (await listed.json()) as {
     *       records: { _id: string; [key: string]: unknown }[];
     *       total: number;
     *     };
     *     expect(body.total).toBe(1);
     *     expect(body.records[0]?._id).toBe(recordId);
     *     // **書き込まれたのは `username` の側であって、`userId` の側ではない。**
     *     expect(body.records[0]?.[OWNER_FIELD]).toBe(buyer.username);
     *     expect(body.records[0]?.[OWNER_FIELD]).not.toBe(buyer.userId);
     *   }
     *   ```
     * **今日は2人の答えが割れたので、同じ `for` では回せない** ——
     * **買った人は 1 件、運営は 0 件である。** **どちらも 200 で返る**(拒否ではない)。
     */
    const listedByBuyer = await request.get(`/api/apps/${appId}/tables/${steps.tableId}/records`, {
      headers: buyer.authHeaders,
    });
    expect(listedByBuyer.status(), await listedByBuyer.text()).toBe(200);
    const buyerBody = (await listedByBuyer.json()) as {
      records: { _id: string; [key: string]: unknown }[];
      total: number;
    };
    expect(buyerBody.total).toBe(1);
    expect(buyerBody.records[0]?._id).toBe(recordId);
    // **書き込まれたのは `username` の側であって、`userId` の側ではない。**
    // **この食い違いは `V17-M5-T05` で1バイトも直っていない。**
    expect(buyerBody.records[0]?.[OWNER_FIELD]).toBe(buyer.username);
    expect(buyerBody.records[0]?.[OWNER_FIELD]).not.toBe(buyer.userId);

    const listedByAdmin = await request.get(`/api/apps/${appId}/tables/${steps.tableId}/records`, {
      headers: steps.app.authHeaders,
    });
    // **拒否ではない** —— **200 の空一覧である**(`ADR-0305` 限定11 と同じ向き)。
    expect(listedByAdmin.status(), await listedByAdmin.text()).toBe(200);
    const adminBody = (await listedByAdmin.json()) as {
      records: { _id: string; [key: string]: unknown }[];
      total: number;
    };
    expect(adminBody.total).toBe(0);
    expect(adminBody.records).toEqual([]);
  });
});
