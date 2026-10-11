/**
 * 入力フォームの入力欄の幅(`field_width`)の chromium 実測(`V20-M3-T03` (c))。
 *
 * `web/test/form-field-width.test.tsx` は happy-dom でクラスと属性を読むだけで、**CSS を1バイトも
 * 計算しない。** 本ファイルは実ブラウザの `getComputedStyle` で、**short / medium / full の幅が
 * 実際に違う**ことを測る(`web/e2e/action-emphasis.e2e.ts` と同じ形)。
 *
 * ## この1本が証明するもの
 *
 * | # | 何を見るか |
 * |---|---|
 * | (i) | 項目の枠の計算後の `max-width` が、short / medium / full で3つとも違う |
 * | (ii) | 入力欄そのものの計算後の `width` が short < medium < full の順に並ぶ |
 * | (iii) | 幅を書かない入力欄の計算値は、medium と同じである(medium は今日の既定の幅) |
 * | (iv) | 同じ差分で書いたまとまりの見出しが入力フォームに出る(`field_sections` の描画) |
 *
 * ## このファイルが証明しないこと
 *
 * - **40rem 未満の画面は測っていない**(既定の `Desktop Chrome` の窓幅だけ)。40rem 未満では
 *   3値とも枠いっぱいになる設計であり、それは測っていない。
 * - 見分けやすさ・使いやすさは1件も測っていない。
 *
 * ## 名前の出どころ
 *
 * 対象の入力フォームと項目は**フィクスチャの JSON から機械的に導く**(型が text / number /
 * long_text / date の項目を1つずつ)。
 */
import { expect, type Page, test } from "@playwright/test";
import type { Diff, FormView, Manifest, Table } from "../../src/kernel/types.ts";
import { provisionApp } from "./fixture-app.ts";

type Target = {
  view: FormView;
  table: Table;
  short: string;
  medium: string;
  full: string;
  undeclared: string;
};

/** 定義順の先頭で、text / number / long_text / date の項目を1つずつ入力項目に持つ form。 */
function targetOf(manifest: Manifest): Target {
  for (const view of manifest.app.views) {
    if (view.type !== "form") {
      continue;
    }
    const table = manifest.app.tables.find((candidate) => candidate.id === view.table);
    if (table === undefined) {
      continue;
    }
    const pick = (type: string): string | undefined =>
      view.fields.find((id) => table.fields.find((field) => field.id === id)?.type === type);
    const short = pick("text");
    const medium = pick("number");
    const full = pick("long_text");
    const undeclared = pick("date");
    if (short && medium && full && undeclared) {
      return { view, table, short, medium, full, undeclared };
    }
  }
  throw new Error(
    "フィクスチャに text / number / long_text / date の項目を1つずつ持つ form がありません(このテストの前提)。",
  );
}

type Measured = { maxWidth: string; wrapperWidth: number; controlWidth: number };

async function measuredOf(page: Page, viewId: string, fieldId: string): Promise<Measured> {
  const label = page.locator(`label[for="${viewId}-${fieldId}"]`);
  await expect(label).toBeVisible();
  return label.evaluate((element) => {
    const wrapper = element.closest(".field") as HTMLElement;
    const control = wrapper.querySelector("input, textarea, select") as HTMLElement;
    return {
      maxWidth: getComputedStyle(wrapper).maxWidth,
      wrapperWidth: wrapper.getBoundingClientRect().width,
      controlWidth: control.getBoundingClientRect().width,
    };
  });
}

test.describe("V20-M3-T03 入力フォームの入力欄の幅(chromium 実測)", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "計算値の実測は1つのブラウザで足りる(`preset.e2e.ts` と同じ理由)",
  );

  test("(i)〜(iv) short / medium / full は計算後の幅が違い、書かない入力欄は medium と同じ幅である", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await app.authenticate(page.context());
    const target = targetOf(app.manifest);

    const diff: Diff = {
      diff_id: "form-field-width-e2e",
      intent: "入力フォームの入力欄に幅を3値で書き、1つは書かずに置く。まとまりも1つ書く",
      operations: [
        {
          op: "update_view",
          view: target.view.id,
          changes: {
            field_width: {
              [target.short]: "short",
              [target.medium]: "medium",
              [target.full]: "full",
            },
            field_sections: { 幅を見るまとまり: [target.full] },
          },
        },
      ],
    } as Diff;
    const applied = await request.post(`/api/apps/${app.appId}/diffs`, {
      data: diff,
      headers: app.authHeaders,
    });
    expect(applied.status(), await applied.text()).toBe(201);

    await page.goto(`/apps/${app.appId}/views/${target.view.id}`);
    await expect(page.getByTestId("view-renderer-form")).toBeVisible();

    const short = await measuredOf(page, target.view.id, target.short);
    const medium = await measuredOf(page, target.view.id, target.medium);
    const full = await measuredOf(page, target.view.id, target.full);
    const undeclared = await measuredOf(page, target.view.id, target.undeclared);
    // **記録に貼るために計算値を印字する**(合否は下の expect だけで決まる)。
    console.log(`form-field-width computed ${JSON.stringify({ short, medium, full, undeclared })}`);

    // (i) 項目の枠の max-width が3値で3つとも違う。
    expect(new Set([short.maxWidth, medium.maxWidth, full.maxWidth]).size).toBe(3);
    // (ii) 入力欄そのものの幅が short < medium < full。
    expect(short.controlWidth).toBeLessThan(medium.controlWidth);
    expect(medium.controlWidth).toBeLessThan(full.controlWidth);
    // (iii) 書かない入力欄は medium と同じ幅(medium は今日の既定の幅)。
    expect(undeclared.maxWidth).toBe(medium.maxWidth);
    expect(undeclared.wrapperWidth).toBe(medium.wrapperWidth);

    // (iv) まとまりの見出しが出て、full にした項目がその中に入っている。
    const section = page.getByTestId("form-field-section");
    await expect(section).toHaveCount(1);
    await expect(section.locator("h3")).toHaveText("幅を見るまとまり");
    await expect(section.locator(`label[for="${target.view.id}-${target.full}"]`)).toBeVisible();
  });
});
