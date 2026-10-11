/**
 * **重ねて出す器と宣言が、chromium で実際に効くことの実測**(`V4-M18-T01` / `T02` / `T04` / `T06`)。
 *
 * 限定の正は [`docs/adr/0094-overlay-container.md`](../../docs/adr/0094-overlay-container.md)
 * (限定4 / 限定8)と
 * [`docs/adr/0095-modal-view-declaration.md`](../../docs/adr/0095-modal-view-declaration.md)
 * (限定3 / 限定9)。
 *
 * ## なぜ要るか
 *
 * **`web/test` は happy-dom であって CSS を1バイトも計算しない。**
 * **「重なって見える」「フォーカスが本当に閉じている」「塗りつぶしの地色が実際に変わる」は、
 * 本ファイルにしか根拠が無い。**
 *
 * **`ADR-0095` 限定9 の第4列の逐語**: 「`web/e2e` に1本(宣言を持つ画面が `role="dialog"` を
 * 持つ DOM で描かれる)」。**本ファイルはそれを含む4本である。**
 *
 * ## 本ファイルが証明しないこと(**誇張しないための境界。先に書く**)
 *
 * - **読み上げソフトを1度も動かしていない。** 読んでいるのは DOM の属性と計算値だけである。
 *   **【禁止】「アクセシブルになった」と書かない**(`ADR-0094` §Decision 3 の 5)。
 * - **スクリーンショット比較をしていない**(`theme.e2e.ts` / `preset.e2e.ts` と同じ限界)。
 *   **「見た目が良くなった」を1ミリも主張しない。**
 * - **`OverlayMenu`(開くメニュー)と `OverlayNotice`(一時的な知らせ)は、今日この製品の
 *   画面から1件も呼ばれていない。** **したがって本ファイルはその2つを chromium で1度も
 *   描いていない。** **器としては実在し `web/test` が属性を測っているが、画面上の当たり先は
 *   0件である**(`ADR-0094` §6 の 8「器が3つ増えても、AI が触れる口は0本のままである」)。
 * - **【`V22-M2-T05` の追記。上の3行を1バイトも消していない】「`OverlayMenu` は今日この製品の画面から1件も
 *   呼ばれていない」は今日から偽である。** メニューの位置を上に置いたアプリ(`app.workspace.navigation`。
 *   `ADR-0486`)の「≡ メニュー」(`web/src/ViewNavigation.tsx`)が呼ぶ。 **その呼び手は出し先をテーマの器
 *   (`.app-theme`)の内側にするので、「テーマの外」でもない**(`web/src/ui/overlay.tsx` の同じ追記)。
 *   **本ファイルは今日もその呼び手を chromium で描いていない** —— 描くのは `V22-M2-T08` の
 *   `web/e2e/workspace-navigation.e2e.ts` である。 `OverlayNotice` は今日も呼ばれていない。
 */
import { type APIRequestContext, expect, test } from "@playwright/test";
import type { Diff, FormView, Manifest } from "../../src/kernel/types.ts";
import { type FixtureApp, provisionApp } from "./fixture-app.ts";

function formViewOf(manifest: Manifest): FormView {
  const view = manifest.app.views.find((candidate): candidate is FormView => {
    return candidate.type === "form";
  });
  if (view === undefined) throw new Error("フィクスチャに form が無い");
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

/**
 * **「この画面は重ねて出す」を書く差分。**
 *
 * **`menu_listed: false` を同じ差分で書いている** —— `ADR-0095` 限定5 が、
 * メニューに並ぶ画面には書けないと定めているためである(書かないと 400 で拒否される)。
 * **`DIFF_OPS` を1つも増やしていない**(`update_view` 1本だけ)。
 */
function modalDiff(viewId: string, diffId: string): Diff {
  return {
    diff_id: diffId,
    intent: "今の画面を離れずに別の判断を求められるようにしたいという要望に応えた",
    operations: [{ op: "update_view", view: viewId, changes: { menu_listed: false, modal: true } }],
  } as Diff;
}

test.describe("V4-M18 重ねて出す器と宣言", () => {
  test("(i) 宣言を持つ画面が、role=dialog / aria-modal=true の器で描かれる(ADR-0095 限定9)", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await app.authenticate(page.context());
    const view = formViewOf(app.manifest);

    await applyDiff(request, app, modalDiff(view.id, "overlay-modal"));
    await page.goto(`/apps/${app.appId}/views/${view.id}`);

    const popup = page.locator('[data-slot="overlay-dialog"]');
    await expect(popup).toBeVisible();
    await expect(popup).toHaveAttribute("role", "dialog");
    await expect(popup).toHaveAttribute("aria-modal", "true");
    // **画面の中身が器の中に居る**(器だけ出て中身が外に残る、を作らない)。
    await expect(popup.getByTestId("view-title")).toBeVisible();

    // **重ね順が実際に効いている** —— 段の名前が数値へ解決されている(限定4)。
    const zIndex = await popup.evaluate((element) => getComputedStyle(element).zIndex);
    expect(zIndex).toBe("100");
    const position = await popup.evaluate((element) => getComputedStyle(element).position);
    expect(position).toBe("fixed");

    // **器はアプリ単位テーマのスコープの内側に差さっている**(`V4-M18-T04` が実測して直した)。
    // **`document.body` の直下に差すと、25スロットも逃げ道 CSS も器に1つも届かない。**
    const insideScope = await page.evaluate(() => {
      const scope = document.querySelector(".app-theme");
      const popup = document.querySelector('[data-slot="overlay-dialog"]');
      return scope !== null && popup !== null && scope.contains(popup);
    });
    expect(insideScope).toBe(true);

    // **フォーカスが器の中に居る**(限定8)。
    const focusInside = await page.evaluate(() => {
      const popup = document.querySelector('[data-slot="overlay-dialog"]');
      return popup?.contains(document.activeElement) ?? false;
    });
    expect(focusInside).toBe(true);
  });

  test("(ii) Tab の巡回が器の中で閉じている(happy-dom では測れない分。ADR-0094 限定8)", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await app.authenticate(page.context());
    const view = formViewOf(app.manifest);
    await applyDiff(request, app, modalDiff(view.id, "overlay-trap"));
    await page.goto(`/apps/${app.appId}/views/${view.id}`);
    await expect(page.locator('[data-slot="overlay-dialog"]')).toBeVisible();

    /**
     * **器の中の焦点可能な要素の数より多く Tab を押しても、焦点は器の外へ出ない。**
     *
     * > ### **【V4-M18-T04 が実測して分かったこと。必ず待つこと】**
     * >
     * > **番人(`data-base-ui-focus-guard`)への焦点の移動と、そこから器の先頭へ戻す処理は
     * > **非同期**である**(`@base-ui-components/react` の `FloatingFocusManager` は
     * > `enqueueFocus` を使い、アニメーションフレームをまたぐ)。
     * > **`Tab` を押した直後に同期で `document.activeElement` を読むと、番人の要素
     * > (器の**外**にある `<span>`)が観測される。**
     * > **そこで待たずにもう一度 `Tab` を押すと、焦点は本当に器の外へ出ていく**
     * > (2026-08-03 に実測。`BODY` → `アプリ一覧` の `<a>` → `アプリを切り替える` の
     * > `<summary>` と3つ進んでから器へ戻った)。
     * > **【禁止】これを「フォーカストラップが壊れている」と読まない** —— **待てば閉じている。**
     * > **【禁止】待たずに測って「閉じている」と書かない** —— **測り方の問題である。**
     */
    const inside = async (): Promise<{ inside: boolean; tag: string; guard: boolean }> =>
      await page.evaluate(() => {
        const popup = document.querySelector('[data-slot="overlay-dialog"]');
        const active = document.activeElement;
        return {
          inside: popup?.contains(active) ?? false,
          tag: active?.tagName ?? "",
          guard: active?.hasAttribute("data-base-ui-focus-guard") ?? false,
        };
      });
    for (let i = 0; i < 25; i += 1) {
      await page.keyboard.press("Tab");
      // **番人からの差し戻しが非同期なので、1フレーム分待ってから読む。**
      await page.waitForTimeout(120);
      const state = await inside();
      expect(state, `Tab ${i + 1} 回目で器の外へ出た`).toEqual({
        inside: true,
        tag: state.tag,
        guard: false,
      });
    }
  });

  test("(iii) Escape で閉じる(ADR-0094 限定8)", async ({ page, request }) => {
    const app = await provisionApp(request);
    await app.authenticate(page.context());
    const view = formViewOf(app.manifest);
    await applyDiff(request, app, modalDiff(view.id, "overlay-escape"));
    await page.goto(`/apps/${app.appId}/views/${view.id}`);
    await expect(page.locator('[data-slot="overlay-dialog"]')).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.locator('[data-slot="overlay-dialog"]')).toHaveCount(0);
  });

  test("(iv) 宣言を書かない画面は、器を1つも通らない(ADR-0095 限定3)", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await app.authenticate(page.context());
    const view = formViewOf(app.manifest);
    await page.goto(`/apps/${app.appId}/views/${view.id}`);
    await expect(page.getByTestId("view-title")).toBeVisible();
    await expect(page.locator('[data-slot="overlay-dialog"]')).toHaveCount(0);
    await expect(page.locator('[data-slot="overlay-dialog-backdrop"]')).toHaveCount(0);
  });

  test("(v) 塗りつぶしのボタンの計算値が、地色と文字色で入れ替わる(V4-M18-T06)", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await app.authenticate(page.context());
    await page.goto(`/apps/${app.appId}`);
    await expect(page.locator(".app-theme")).toBeVisible();

    // **既存の画面に塗りつぶしのボタンはまだ1つも無い**ので、導出そのものを測る ——
    // **`bg-primary` / `text-primary-foreground` の計算値が、本文の文字色とページ地色の
    // 入れ替えになっていること。**(**当たり先が画面上に0件であることを隠さない。**)
    const measured = await page.evaluate(() => {
      const scope = document.querySelector(".app-theme");
      if (scope === null) throw new Error("テーマのスコープが無い");
      const probe = document.createElement("div");
      probe.className = "bg-primary text-primary-foreground";
      scope.appendChild(probe);
      const style = getComputedStyle(probe);
      const scopeStyle = getComputedStyle(scope as Element);
      const out = {
        background: style.backgroundColor,
        color: style.color,
        text: scopeStyle.getPropertyValue("--color-text").trim(),
        page: scopeStyle.getPropertyValue("--color-page-background").trim(),
      };
      probe.remove();
      return out;
    });
    // **色のリテラルを1バイトも書いていない** —— 読んだのはスロットの値そのものである。
    expect(measured.text).not.toBe("");
    expect(measured.page).not.toBe("");
    const toRgb = async (value: string): Promise<string> =>
      await page.evaluate((input) => {
        const probe = document.createElement("div");
        probe.style.color = input;
        document.body.appendChild(probe);
        const resolved = getComputedStyle(probe).color;
        probe.remove();
        return resolved;
      }, value);
    expect(measured.background).toBe(await toRgb(measured.text));
    expect(measured.color).toBe(await toRgb(measured.page));
    // **地色と文字色が同じ値でない**(= 塗りつぶしとして読める)。
    expect(measured.background).not.toBe(measured.color);
  });
  /**
   * **【V20-M9 点検の中1 の処置】小窓の地色・文字色は overlay_background / overlay_text から来る
   * (ADR-0474 §Decision 1-2)。** 点検で、導出の2行を入れ替えても(既定のテーマで小窓が黒地に白文字)
   * 元に戻しても(page-background / text)E2E は1本も赤くならなかった。
   * 前半: 既定のテーマで今日と同じ白地・黒文字。 後半: overlay_* だけを変えたテーマ
   * (page_background / body_text は既定のまま)で、小窓の地色・文字色がその値になる。
   */
  test("(vi) 小窓の地色・文字色は既定で白地・黒文字、overlay_* を変えたテーマではその値になる(ADR-0474 §1-2)", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await app.authenticate(page.context());
    const view = formViewOf(app.manifest);
    await applyDiff(request, app, modalDiff(view.id, "overlay-colors"));
    const popup = page.locator('[data-slot="overlay-dialog"]');
    const look = () =>
      popup.evaluate((element) => {
        const style = getComputedStyle(element);
        return { background: style.backgroundColor, color: style.color };
      });

    await page.goto(`/apps/${app.appId}/views/${view.id}`);
    await expect(popup).toBeVisible();
    const before = await look();
    console.log(`overlay colors default ${JSON.stringify(before)}`);
    expect(before).toEqual({ background: "rgb(255, 255, 255)", color: "rgb(0, 0, 0)" });

    await applyDiff(request, app, {
      diff_id: "overlay-colors-theme",
      intent: "小窓だけを淡い黄色の地に濃い灰の文字にしたい",
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
              primary_fill: "#ffffff",
              on_primary: "#000000",
              overlay_background: "#fffbe6",
              overlay_text: "#1a1a1a",
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
            },
          },
        },
      ],
    } as Diff);
    await page.goto(`/apps/${app.appId}/views/${view.id}`);
    await expect(popup).toBeVisible();
    await expect.poll(async () => (await look()).background).toBe("rgb(255, 251, 230)");
    const after = await look();
    console.log(`overlay colors themed ${JSON.stringify(after)}`);
    expect(after).toEqual({ background: "rgb(255, 251, 230)", color: "rgb(26, 26, 26)" });
  });
});
