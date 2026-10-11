/**
 * 並べ方の木(`layout`)の chromium 実測(`V20-M5-T03` (b)。計画 `07-v20-m5-plan.md` 完了条件3)。
 *
 * `web/test/layout-tree.test.tsx` は happy-dom でクラスと DOM の形を読むだけで、**CSS を1バイトも
 * 計算しない。** 本ファイルは実ブラウザの `getBoundingClientRect` で、**同じ画面の幅を変えると
 * `sidebar` / `switcher` / `grid` の並びが組み替わる**ことを測る。
 *
 * ## この1本が証明するもの
 *
 * | # | 何を見るか |
 * |---|---|
 * | (i) | 本物のサーバに `update_view` で木を書くと受理され(201)、6種の器がすべて1つずつ描かれる |
 * | (ii) | 広い窓(1280px)では `sidebar` の脇と本文、`switcher` の子、`grid` の子が**横に並ぶ**(上端が同じ) |
 * | (iii) | 狭い窓(360px)では、同じ3種が**縦に積まれる**(後の子の上端が前の子の下端以上) |
 * | (iv) | 送信ボタンは `split` の終端に1つだけ描かれ、押すと保存される(元の場所に2つ目が無い) |
 *
 * **組み替えの条件は画面幅の at-rule ではない**(器の内側の寸法で折り返す)。 **ビルド出力の
 * 幅の条件の集合が着手前と同じであること**は `docs/plan/v20/records/v20-m5-t03.md` §4 が数える。
 *
 * ## このファイルが証明しないこと
 *
 * - `stack` / `cluster` / `split` の幅での振る舞い(幅の基準を持たない)は測っていない。
 * - 詳細画面・一覧のカードの木は測っていない(同じ部品を使う。描き分けは単体検査)。
 * - 見分けやすさ・使いやすさは1件も測っていない。
 */
import { expect, type Page, test } from "@playwright/test";
import type { Diff } from "../../src/kernel/types.ts";
import { provisionApp } from "./fixture-app.ts";

/** フィクスチャ `inventory-all-field-types.json` の入力フォーム(9項目)。 */
const FORM_ID = "item-form";

const LAYOUT = {
  type: "stack",
  gap: "md",
  children: [
    { type: "sidebar", side: "name", main: "note", side_width: "sm" },
    { type: "switcher", threshold: "md", children: ["quantity", "in_use"] },
    { type: "grid", min_item: "sm", children: ["purchased_at", "condition", "category"] },
    { type: "cluster", justify: "start", children: ["photo"] },
    { type: "split", start: ["manual"], end: ["action:submit"] },
  ],
};

type Box = { top: number; bottom: number; left: number; width: number };

/** 器(`data-layout`)の直下の子の箱を、文書順に返す。 */
async function childBoxes(page: Page, type: string): Promise<Box[]> {
  const node = page.locator(`[data-layout="${type}"]`);
  await expect(node).toHaveCount(1);
  return node.evaluate((element) =>
    [...element.children].map((child) => {
      const rect = child.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width };
    }),
  );
}

async function measure(page: Page): Promise<Record<string, Box[]>> {
  return {
    sidebar: await childBoxes(page, "sidebar"),
    switcher: await childBoxes(page, "switcher"),
    grid: await childBoxes(page, "grid"),
  };
}

/** 横並び = 全部の子の上端が同じ(小数の丸めを1px 許す)。 */
function sideBySide(boxes: Box[]): boolean {
  const first = boxes[0] as Box;
  return boxes.every((box) => Math.abs(box.top - first.top) <= 1);
}

/** 縦積み = 後の子の上端が前の子の下端以上(小数の丸めを1px 許す)。 */
function stacked(boxes: Box[]): boolean {
  return boxes.every(
    (box, index) => index === 0 || box.top >= (boxes[index - 1] as Box).bottom - 1,
  );
}

test.describe("V20-M5-T03 並べ方の木(chromium 実測)", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "計算値の実測は1つのブラウザで足りる(`preset.e2e.ts` と同じ理由)",
  );

  test("(i)〜(iv) 6種が描かれ、幅を変えると sidebar / switcher / grid が横並びと縦積みで組み替わる", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await app.authenticate(page.context());

    const diff = {
      diff_id: "layout-tree-e2e",
      intent: "入力フォームの項目を並べ方の木で6種の器に置き、送信ボタンを右端へ動かす",
      operations: [{ op: "update_view", view: FORM_ID, changes: { layout: LAYOUT } }],
    } as unknown as Diff;
    const applied = await request.post(`/api/apps/${app.appId}/diffs`, {
      data: diff,
      headers: app.authHeaders,
    });
    expect(applied.status(), await applied.text()).toBe(201);

    // (ii) 広い窓
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/apps/${app.appId}/views/${FORM_ID}`);
    await expect(page.getByTestId("view-renderer-form")).toBeVisible();
    await expect(page.locator(`label[for="${FORM_ID}-manual"]`)).toBeVisible();

    // (i) 6種がすべて1つずつ描かれる。
    for (const type of ["stack", "cluster", "sidebar", "switcher", "grid", "split"]) {
      await expect(page.locator(`[data-layout="${type}"]`), type).toHaveCount(1);
    }

    const wide = await measure(page);
    const formWidthWide = await page
      .locator("form.record-form")
      .evaluate((element) => element.getBoundingClientRect().width);

    // (iii) 狭い窓(同じ画面を開き直さずに幅だけ変える)
    await page.setViewportSize({ width: 360, height: 900 });
    await expect
      .poll(async () =>
        page
          .locator("form.record-form")
          .evaluate((element) => element.getBoundingClientRect().width),
      )
      .toBeLessThan(360);
    const narrow = await measure(page);
    const formWidthNarrow = await page
      .locator("form.record-form")
      .evaluate((element) => element.getBoundingClientRect().width);

    // **記録に貼るために計算値を印字する**(合否は下の expect だけで決まる)。
    console.log(
      `layout-tree computed ${JSON.stringify({ formWidthWide, formWidthNarrow, wide, narrow })}`,
    );

    for (const type of ["sidebar", "switcher", "grid"]) {
      const wideBoxes = wide[type] as Box[];
      const narrowBoxes = narrow[type] as Box[];
      expect(wideBoxes.length, type).toBeGreaterThanOrEqual(2);
      expect(sideBySide(wideBoxes), `${type} wide`).toBe(true);
      expect(stacked(narrowBoxes), `${type} narrow`).toBe(true);
      expect(sideBySide(narrowBoxes), `${type} narrow`).toBe(false);
    }

    // (iv) 送信ボタンは split の終端に1つだけ。押すと保存される(必須項目は名前と数量)。
    const submit = page.locator('form.record-form button[type="submit"]');
    await expect(submit).toHaveCount(1);
    await expect(
      page.locator('[data-layout="split"] > [data-layout-slot="end"] button[type="submit"]'),
    ).toHaveCount(1);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator(`#${FORM_ID}-name`).fill("並べ方の実測");
    await page.locator(`#${FORM_ID}-quantity`).fill("3");
    const saved = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/apps/${app.appId}/tables/items/records`) &&
        response.request().method() === "POST",
    );
    await submit.click();
    expect((await saved).status()).toBe(201);
  });
});
