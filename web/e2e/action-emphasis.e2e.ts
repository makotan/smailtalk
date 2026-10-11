/**
 * 詳細画面のボタンの強調(`action_emphasis`)の chromium 実測(`V20-M2-T03` (c))。
 *
 * `web/test/action-emphasis.test.tsx` は happy-dom で `data-variant` の属性を読むだけで、
 * **CSS を1バイトも計算しない。** 本ファイルは実ブラウザの `getComputedStyle` で、
 * **宣言した主(`primary`)と副(`secondary`)の地色か枠線の色が実際に違う**ことを測る。
 *
 * ## この1本が証明するもの
 *
 * | # | 何を見るか |
 * |---|---|
 * | (i) | 主と副で、計算後の `background-color` か `border-color` の少なくとも一方が違う |
 * | (ii) | 宣言を書かないボタンの計算値は、副と宣言したボタンの計算値と同じである(主を出さない) |
 *
 * ## このファイルが証明しないこと(誇張しないための境界)
 *
 * - **見分けが付くか(コントラスト比・視認性)を1件も測っていない。** 違う色であることだけを見る。
 * - **危険(`danger`)の色は数を取るだけで、主・副との違いを合否にしていない。**
 * - **一覧の行のボタンは1つも見ていない**(一覧には強調を書けない。スキーマが拒否する)。
 *
 * ## 名前の出どころ
 *
 * 対象の詳細画面・テーブル・真偽値の項目は**フィクスチャの JSON から機械的に導く**
 * (`web/e2e/list-create-origin.e2e.ts` と同じ形)。
 */
import { expect, type Page, test } from "@playwright/test";
import type { DetailView, Diff, Field, Manifest, Table } from "../../src/kernel/types.ts";
import { buildRecord, ensureReferenceTargets, provisionApp } from "./fixture-app.ts";

/** 定義順の先頭の `detail_view` と、その表と、その表の先頭の真偽値の項目。 */
function targetOf(manifest: Manifest): { view: DetailView; table: Table; flag: Field } {
  for (const view of manifest.app.views) {
    if (view.type !== "detail_view") {
      continue;
    }
    const table = manifest.app.tables.find((candidate) => candidate.id === view.table);
    const flag = table?.fields.find((field) => field.type === "boolean");
    if (table !== undefined && flag !== undefined) {
      return { view, table, flag };
    }
  }
  throw new Error(
    "フィクスチャに真偽値の項目を持つ表の detail_view がありません(このテストの前提)。",
  );
}

type Painted = { background: string; border: string };

async function paintedOf(page: Page, name: string): Promise<Painted> {
  const button = page.getByRole("button", { name, exact: true });
  await expect(button).toBeVisible();
  return button.evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, border: style.borderTopColor };
  });
}

test.describe("V20-M2-T03 詳細画面のボタンの強調(chromium 実測)", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "計算値の実測は1つのブラウザで足りる(`preset.e2e.ts` と同じ理由)",
  );

  test("(i)(ii) 主と副は計算後の地色か枠線の色が違い、宣言の無いボタンは副と同じ色である", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await app.authenticate(page.context());
    const { view, table, flag } = targetOf(app.manifest);

    const diff: Diff = {
      diff_id: "action-emphasis-e2e",
      intent: "詳細画面のボタンに主・副・危険を名指しし、1つは書かずに置く",
      operations: [
        {
          op: "update_view",
          view: view.id,
          changes: {
            actions: [
              {
                set: { field: flag.id, value: false },
                name: "副にしたボタン",
                action_emphasis: "secondary",
              },
              {
                set: { field: flag.id, value: true },
                name: "主にしたボタン",
                action_emphasis: "primary",
              },
              {
                set: { field: flag.id, value: false },
                name: "危険にしたボタン",
                action_emphasis: "danger",
              },
              { set: { field: flag.id, value: true }, name: "書かないボタン" },
            ],
          },
        },
      ],
    } as Diff;
    const applied = await request.post(`/api/apps/${app.appId}/diffs`, {
      data: diff,
      headers: app.authHeaders,
    });
    expect(applied.status(), await applied.text()).toBe(201);

    const refs = await ensureReferenceTargets(app, table);
    const recordId = await app.createRecord(table.id, buildRecord(table, 0, refs));

    await page.goto(`/apps/${app.appId}/views/${view.id}/records/${recordId}`);
    await expect(page.getByTestId("detail-action-origins")).toBeVisible();

    const primary = await paintedOf(page, "主にしたボタン");
    const secondary = await paintedOf(page, "副にしたボタン");
    const danger = await paintedOf(page, "危険にしたボタン");
    const undeclared = await paintedOf(page, "書かないボタン");
    // **記録に貼るために計算値を印字する**(合否は下の expect だけで決まる)。
    console.log(
      `action-emphasis computed ${JSON.stringify({ primary, secondary, danger, undeclared })}`,
    );

    // (i) 主と副は、地色か枠線の色の少なくとも一方が違う。
    expect(primary.background !== secondary.background || primary.border !== secondary.border).toBe(
      true,
    );
    // (ii) 宣言の無いボタンは副と同じ色である(主を出さない)。
    expect(undeclared).toEqual(secondary);

    // **data-variant も読む**(計算値と属性が同じボタンを指していることの確かめ)。
    const variants = await page
      .getByTestId("detail-action-origins")
      .locator("button[data-variant]")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-variant")));
    // 【V20-M9 / ADR-0474 §1-7】主の variant を "default" → "emphasis" に打ち直した。
    // 旧(逐語): expect(variants).toEqual(["secondary", "default", "destructive", "secondary"]);
    expect(variants).toEqual(["secondary", "emphasis", "destructive", "secondary"]);
  });

  /**
   * **【V20-M9-T01 / ADR-0474 §Decision 1-7】主ボタンを新しい2枠(`primary_fill` / `on_primary`)で描く。**
   * 既定値(`#fff` / `#000`)のままなら、平常時の見た目は今日(`default` の見た目)と同じ:
   * 白地・黒文字・枠線は `border_color`(`#ddd`)。 hover では地色と文字色を変えず、枠線だけが
   * 本文の文字色(黒)になる(今日の `default` の hover は地色が `highlight_surface` に変わっていた)。
   */
  test("(iii) 主ボタンの既定の計算値は今日と同じ(白地・黒文字・枠線 #ddd)で、hover では枠線だけが黒くなる", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await app.authenticate(page.context());
    const { view, table, flag } = targetOf(app.manifest);
    const diff: Diff = {
      diff_id: "action-emphasis-e2e-primary-fill",
      intent: "詳細画面のボタンに主を名指しし、既定の見た目を実測する",
      operations: [
        {
          op: "update_view",
          view: view.id,
          changes: {
            actions: [
              {
                set: { field: flag.id, value: true },
                name: "主にしたボタン",
                action_emphasis: "primary",
              },
            ],
          },
        },
      ],
    } as Diff;
    const applied = await request.post(`/api/apps/${app.appId}/diffs`, {
      data: diff,
      headers: app.authHeaders,
    });
    expect(applied.status(), await applied.text()).toBe(201);
    const refs = await ensureReferenceTargets(app, table);
    const recordId = await app.createRecord(table.id, buildRecord(table, 0, refs));
    await page.goto(`/apps/${app.appId}/views/${view.id}/records/${recordId}`);
    const button = page.getByRole("button", { name: "主にしたボタン", exact: true });
    await expect(button).toBeVisible();
    const look = () =>
      button.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          background: style.backgroundColor,
          color: style.color,
          border: style.borderTopColor,
        };
      });
    const resting = await look();
    console.log(`action-emphasis primary resting ${JSON.stringify(resting)}`);
    expect(resting).toEqual({
      background: "rgb(255, 255, 255)",
      color: "rgb(0, 0, 0)",
      border: "rgb(221, 221, 221)",
    });
    await button.hover();
    await expect.poll(async () => (await look()).border).toBe("rgb(0, 0, 0)");
    const hovered = await look();
    expect(hovered.background).toBe("rgb(255, 255, 255)");
    expect(hovered.color).toBe("rgb(0, 0, 0)");
  });

  /**
   * **【V20-M9-T02 / ADR-0474 §Decision 1-5 / 1-6】生の色を参照した `primary_fill` のテーマを当てると、
   * 主ボタンの地色がその生の色になる。** カーネルは `incoming` で参照を解いてコントラストを測り
   * (`on_primary` の白 × 濃い青 = 通る)、保存は参照の綴りのまま。表示層は `--palette-brand` の宣言と
   * `var(--palette-brand)` に写すだけで、ブラウザが解く。**同じテストの前半で、テーマを当てる前は
   * 今日と同じ白地であることを測る**(既定の見た目が動いていないことの対照)。
   */
  test("(iv) 生の色を参照した primary_fill のテーマを当てると主ボタンの地色が rgb(29, 78, 216) になる(当てる前は白)", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await app.authenticate(page.context());
    const { view, table, flag } = targetOf(app.manifest);
    const post = async (diff: Diff) => {
      const applied = await request.post(`/api/apps/${app.appId}/diffs`, {
        data: diff,
        headers: app.authHeaders,
      });
      expect(applied.status(), await applied.text()).toBe(201);
    };
    await post({
      diff_id: "action-emphasis-e2e-palette-view",
      intent: "詳細画面のボタンに主を名指しする",
      operations: [
        {
          op: "update_view",
          view: view.id,
          changes: {
            actions: [
              {
                set: { field: flag.id, value: true },
                name: "主にしたボタン",
                action_emphasis: "primary",
              },
              // 【V20-M9 点検の軽2】「主ボタンだけが変わる」の「だけ」の側の対照。主を名指ししないボタン。
              {
                set: { field: flag.id, value: false },
                name: "名指しの無いボタン",
              },
            ],
          },
        },
      ],
    } as Diff);
    const refs = await ensureReferenceTargets(app, table);
    const recordId = await app.createRecord(table.id, buildRecord(table, 0, refs));
    const url = `/apps/${app.appId}/views/${view.id}/records/${recordId}`;
    const button = page.getByRole("button", { name: "主にしたボタン", exact: true });
    const look = () =>
      button.evaluate((element) => {
        const style = getComputedStyle(element);
        return { background: style.backgroundColor, color: style.color };
      });
    const other = page.getByRole("button", { name: "名指しの無いボタン", exact: true });
    const otherLook = () =>
      other.evaluate((element) => {
        const style = getComputedStyle(element);
        return { background: style.backgroundColor, color: style.color };
      });

    // 前半: テーマを当てる前(既定のテーマ)は今日と同じ白地・黒文字。
    await page.goto(url);
    await expect(button).toBeVisible();
    const before = await look();
    console.log(`action-emphasis primary before-palette ${JSON.stringify(before)}`);
    expect(before).toEqual({ background: "rgb(255, 255, 255)", color: "rgb(0, 0, 0)" });
    await expect(other).toBeVisible();
    const otherBefore = await otherLook();
    console.log(`action-emphasis other before-palette ${JSON.stringify(otherBefore)}`);

    // 後半: 生の色 palette_brand を参照した primary_fill のテーマを当てる(コントラスト検査を通る27枠)。
    await post({
      diff_id: "action-emphasis-e2e-palette-theme",
      intent: "主ボタンだけをブランドの青にしたい",
      operations: [
        {
          op: "set_theme",
          theme: {
            slots: {
              danger: "#a00000",
              body_text: "#000000",
              label_text: "#595959",
              placeholder_text: "#595959",
              secondary_text: "#595959",
              border_color: "#767676",
              page_background: "#ffffff",
              highlight_surface: "#f2f2f2",
              primary_fill: "$palette_brand",
              on_primary: "#ffffff",
              overlay_background: "#ffffff",
              overlay_text: "#000000",
              body_font: "system-ui, sans-serif",
              note_font_size: "0.875rem",
              secondary_font_size: "0.85em",
              body_line_height: "1.6",
              space_1: "0.25rem",
              space_2: "0.5rem",
              space_3: "0.75rem",
              space_4: "1rem",
              space_5: "1.25rem",
              space_6: "2rem",
              border_width: "1px",
              control_radius: "4px",
              surface_shadow: "none",
              focus_ring: "#005fcc",
              focus_ring_width: "2px",
              palette_brand: "#1d4ed8",
            },
          },
        },
      ],
    } as Diff);
    await page.goto(url);
    await expect(button).toBeVisible();
    await expect.poll(async () => (await look()).background).toBe("rgb(29, 78, 216)");
    const after = await look();
    console.log(`action-emphasis primary after-palette ${JSON.stringify(after)}`);
    expect(after).toEqual({ background: "rgb(29, 78, 216)", color: "rgb(255, 255, 255)" });
    // 「だけ」の側: 同じ画面の名指しの無いボタン(副 = secondary。地色は highlight_surface)は、
    // テーマを当てた後も当てる前と同じ地色・文字色で、主ボタンの青にならない。
    await expect(other).toBeVisible();
    const otherAfter = await otherLook();
    console.log(`action-emphasis other after-palette ${JSON.stringify(otherAfter)}`);
    expect(otherBefore).toEqual({ background: "rgb(242, 242, 242)", color: "rgb(0, 0, 0)" });
    expect(otherAfter).toEqual(otherBefore);
  });
});
