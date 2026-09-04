/**
 * **参照項目の検索ポップアップを、キーボードだけで通しで操作できることの実測**
 * (`K-G20` / `K-G19` / `K-G16`。`V6-M5-T02`)。
 *
 * ## なぜ要るか
 *
 * **`web/test` は happy-dom であって、`Tab` キーの巡回を1度も実行しない。**
 * **「キーボードだけで開く・探す・選ぶ・閉じるができる」の根拠は、本ファイルにしか無い**
 * (`web/test/reference-search-popup.test.tsx` の冒頭が、そう自己申告している)。
 *
 * **`v6-m4.md` §4 の 2 の逐語**: 「**ブラウザで1度も開いていない。** … **参照項目を打って
 * 絞る経路は1本も含まれていない**」。**本ファイルは、その状態を `search` の側について解く。**
 * **`type_filter` の側は今日も E2E が0本である**(本ファイルは `search` だけを開く)。
 *
 * ## 本ファイルが証明しないこと(**誇張しないための境界。先に書く**)
 *
 * - **読み上げソフトを1度も動かしていない**(`ADR-0094` §Decision 3 の 5)。
 *   **【禁止】「アクセシブルになった」と書かない。**
 * - **スクリーンショット比較をしていない。** **「見た目が良くなった」を1ミリも主張しない。**
 * - **数千件の候補を1度も描いていない。** **描画時間を1度も測っていない。**
 * - **`st_owner` / 役割の規則で見えない相手の候補を1件も作っていない**(`V8-M20` で `audience` は撤去された)
 *   (可視性は `web/test/reference-picker-visibility.test.ts` とサーバ側の検査の担当)。
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

/** 参照先テーブルの「名前」に当たる列(最初の text)。 */
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

/** 今フォーカスが当たっている要素の `data-testid`(無ければタグ名)。 */
async function focusedTestId(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const active = document.activeElement;
    return active?.getAttribute("data-testid") ?? active?.tagName ?? "";
  });
}

/** **`Tab` を押し続けて目的の口まで進む。** マウスを1度も使わない。 */
async function tabUntil(page: Page, testId: string, limit = 40): Promise<void> {
  for (let index = 0; index < limit; index += 1) {
    if ((await focusedTestId(page)) === testId) {
      return;
    }
    await page.keyboard.press("Tab");
  }
  throw new Error(`Tab を ${limit} 回押しても ${testId} に届きませんでした。`);
}

test.describe("V6-M5 参照項目の検索ポップアップ", () => {
  test("(T02) キーボードだけで、開く・探す・選ぶ・閉じるができる", async ({ page, request }) => {
    const app = await provisionApp(request);
    await app.authenticate(page.context());
    const { view, field } = formWithReference(app.manifest);
    if (field.type !== "reference") {
      throw new Error("参照項目の解決に失敗しました。");
    }
    const targetTable = field.reference_table;
    const labelField = labelFieldOf(app.manifest, targetTable);

    // **選び方を `search` にする**(`change_field` の1本だけ。`DIFF_OPS` を1つも増やさない)。
    await applyDiff(request, app, {
      diff_id: "reference-search-popup",
      intent:
        "他のテーブルから選ぶ項目を、検索ボタンから探して選べるようにしたいという要望に応えた",
      operations: [
        {
          op: "change_field",
          table: view.table,
          field: field.id,
          changes: { reference_picker: "search" },
        },
      ],
    } as Diff);

    // 候補を3件作る(打って絞れることを見るために、当たる語と当たらない語を混ぜる)。
    const wanted = await app.createRecord(targetTable, { [labelField.id]: "やまだ商会" });
    await app.createRecord(targetTable, { [labelField.id]: "たなか製作所" });
    await app.createRecord(targetTable, { [labelField.id]: "すずき工業" });

    await page.goto(`/apps/${app.appId}/views/${view.id}`);
    const trigger = page.locator(`[data-testid="field-input-${field.id}"]`);
    await expect(trigger).toBeVisible();
    // **まだ何も選んでいない。**
    await expect(trigger).toHaveAttribute("data-value", "");

    // --- 開く: `Tab` で口まで進み、`Enter` で開く(マウスを1度も使わない) ---------------
    await page.locator("body").press("Tab");
    await tabUntil(page, `field-input-${field.id}`);
    await page.keyboard.press("Enter");
    const popup = page.locator('[data-slot="overlay-dialog"]');
    await expect(popup).toBeVisible();
    await expect(popup).toHaveAttribute("role", "dialog");
    await expect(popup).toHaveAttribute("aria-modal", "true");

    // **器はアプリ単位テーマのスコープの中に在る**(完了条件 (v) を chromium で測る)。
    expect(
      await page.evaluate(() => {
        const scope = document.querySelector(".app-theme");
        const dialog = document.querySelector('[data-slot="overlay-dialog"]');
        return scope !== null && dialog !== null && scope.contains(dialog);
      }),
    ).toBe(true);

    // 3件とも出ている。
    await expect(popup.getByText("やまだ商会")).toBeVisible();
    await expect(popup.getByText("たなか製作所")).toBeVisible();

    // --- 探す: `Tab` で探す口まで進み、打つ ------------------------------------------
    await tabUntil(page, `reference-popup-search-${field.id}`);
    await page.keyboard.type("やまだ");
    await expect(popup.getByText("たなか製作所")).toHaveCount(0);
    await expect(popup.getByText("やまだ商会")).toBeVisible();

    // --- 選ぶ: `Tab` で選ぶ口まで進み、`Enter` で選ぶ -----------------------------------
    await tabUntil(page, `reference-popup-choose-${wanted}`);
    await page.keyboard.press("Enter");
    // **選ぶと閉じて値が入る**(完了条件 (ii))。
    await expect(popup).toHaveCount(0);
    await expect(trigger).toHaveAttribute("data-value", wanted);
    await expect(trigger).toContainText("やまだ商会");
    // **焦点は開いた元の口へ戻っている。**
    expect(await focusedTestId(page)).toBe(`field-input-${field.id}`);

    // --- 閉じる: もう一度開いて `Escape`。**値は1バイトも変わらない**(完了条件 (ii)) ---
    await page.keyboard.press("Enter");
    await expect(popup).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
    await expect(trigger).toHaveAttribute("data-value", wanted);
    expect(await focusedTestId(page)).toBe(`field-input-${field.id}`);

    // --- **選んだ値が実際にレコードへ入る**(器が画面を変えただけで終わっていないこと) ---
    for (const required of app.tableOf(view.table).fields) {
      if (required.required !== true) {
        continue;
      }
      await page.fill(
        `[data-testid="field-input-${required.id}"]`,
        required.type === "number" ? "1" : "キーボードだけで作った行",
      );
    }
    await page.getByRole("button", { name: "保存" }).click();
    const created = await request.get(`/api/apps/${app.appId}/tables/${view.table}/records`, {
      headers: app.authHeaders,
    });
    expect(created.status()).toBe(200);
    const rows = ((await created.json()) as { records: Record<string, unknown>[] }).records;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.[field.id]).toBe(wanted);
  });

  test("(T02) 続きをページ送りで見られ、ページ位置はマニフェストに1バイトも入らない", async ({
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

    await applyDiff(request, app, {
      diff_id: "reference-search-popup-pager",
      intent: "候補が多いときに続きをページ送りで見られるようにしたいという要望に応えた",
      operations: [
        {
          op: "change_field",
          table: view.table,
          field: field.id,
          changes: { reference_picker: "search" },
        },
      ],
    } as Diff);

    // **上限(50)を1件だけ超えさせる。** 51件目だけが2ページ目に出る。
    for (let index = 0; index < 51; index += 1) {
      await app.createRecord(targetTable, {
        [labelField.id]: `候補${String(index).padStart(3, "0")}`,
      });
    }

    await page.goto(`/apps/${app.appId}/views/${view.id}`);
    await page.locator(`[data-testid="field-input-${field.id}"]`).click();
    const popup = page.locator('[data-slot="overlay-dialog"]');
    await expect(popup).toBeVisible();

    // **黙って切らない** —— 全件と、今出している範囲が画面に出る。
    const note = page.locator(`[data-testid="reference-limit-${field.id}"]`);
    await expect(note).toContainText("51");
    // 1ページ目には50件が出ている(51件目はまだ出ていない)。
    await expect(popup.getByText("候補050", { exact: true })).toHaveCount(0);

    const next = page.locator(`[data-testid="reference-popup-next-${field.id}"]`);
    const prev = page.locator(`[data-testid="reference-popup-prev-${field.id}"]`);
    await expect(prev).toBeDisabled();
    await next.click();
    // 2ページ目には51件目だけが出て、次へは押せなくなる。
    await expect(popup.getByText("候補050", { exact: true })).toBeVisible();
    await expect(next).toBeDisabled();
    await expect(prev).toBeEnabled();

    // **ページ位置はマニフェストに1バイトも入らない**(`ADR-0042` 限定2 / §3a-2)。
    const manifest = await request.get(`/api/apps/${app.appId}/manifest`, {
      headers: app.authHeaders,
    });
    expect(manifest.status()).toBe(200);
    const body = await manifest.text();
    expect(body).not.toContain("offset");
    expect(body).not.toContain("候補050");
  });

  /**
   * **`modal: true` の入力画面の中で `search` の器を開いたときの重ね順**(`V6-M5-T04`)。
   *
   * **`v6-m2.md` §5-3 の 4 / `v6-m3.md` §5-3 の 4 / `v6-m4.md` §5-2 の 5 が、
   * 3回続けて「今日も機械で止めていない」と申し送った組み合わせである。**
   * **本テストがそれを機械で止める** —— **止めるだけであって、`modal` を1バイトも
   * 引き直していない**(`ADR-0095` 限定4 は今日も `form` 分岐だけである)。
   *
   * **【測ったこと】** 器は**2つ**になり、**外側(画面まるごとの器)が `aria-hidden` と
   * inert の下に入り、内側(探す器)だけが操作できる。** **重ね順の段は増えていない**
   * (2つの器の `z-index` の計算値が一致する = `ADR-0094` 限定4 の2段のまま)。
   */
  test("(T04) 重ねて出す入力画面の中でも器が開き、重ね順の3段目を作らない", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await app.authenticate(page.context());
    const { view, field } = formWithReference(app.manifest);
    if (field.type !== "reference") {
      throw new Error("参照項目の解決に失敗しました。");
    }
    const labelField = labelFieldOf(app.manifest, field.reference_table);

    await applyDiff(request, app, {
      diff_id: "reference-search-popup-in-modal",
      intent:
        "重ねて出す入力画面の中でも、他のテーブルから探して選べるようにしたいという要望に応えた",
      operations: [
        {
          op: "change_field",
          table: view.table,
          field: field.id,
          changes: { reference_picker: "search" },
        },
        // **`menu_listed: false` を同じ差分で書く**(`ADR-0095` 限定5)。
        { op: "update_view", view: view.id, changes: { menu_listed: false, modal: true } },
      ],
    } as Diff);
    const wanted = await app.createRecord(field.reference_table, {
      [labelField.id]: "やまだ商会",
    });

    await page.goto(`/apps/${app.appId}/views/${view.id}`);
    const dialogs = page.locator('[data-slot="overlay-dialog"]');
    // 画面まるごとの器が1つだけ開いている。
    await expect(dialogs).toHaveCount(1);

    await page.locator(`[data-testid="field-input-${field.id}"]`).click();
    await expect(dialogs).toHaveCount(2);

    const layers = await page.evaluate(() => {
      const all = [...document.querySelectorAll('[data-slot="overlay-dialog"]')];
      return all.map((element) => ({
        hidden: element.closest('[aria-hidden="true"]') !== null,
        zIndex: getComputedStyle(element).zIndex,
      }));
    });
    // **外側は隠れ、内側だけが生きている。**
    expect(layers.map((layer) => layer.hidden)).toEqual([true, false]);
    // **段は増えていない**(2つの器が同じ段に居る)。
    expect(new Set(layers.map((layer) => layer.zIndex)).size).toBe(1);

    // 内側で選べて、値が入る。
    await page.locator(`[data-testid="reference-popup-choose-${wanted}"]`).click();
    await expect(dialogs).toHaveCount(1);
    await expect(page.locator(`[data-testid="field-input-${field.id}"]`)).toHaveAttribute(
      "data-value",
      wanted,
    );
  });
});
