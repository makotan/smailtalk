/**
 * テーマの持ち出し口が**実際のブラウザで働くこと**の chromium 実測(V3-M1-T05 / D-G3b)。
 *
 * 完了条件の正は `docs/plan/v3/records/v3-m1.md` §2 の「V3-M1-T05」節(T05-4 / T05-5 / T05-6)、
 * 審査の正は `docs/plan/v3/records/v3-m1-gate-a-theme.md` §5(**門外 Δ7・帰属先は表示層**)。
 *
 * ## なぜ要るか
 *
 * `web/test/theme-export.test.tsx` は happy-dom 上の検査で、**クリップボードは
 * スタブである。** 「コピーできる」と言うためには本物のブラウザで1度確かめる必要がある
 * (T04 が「画面が変わる」を chromium でだけ言えたのと同じ理由)。
 *
 * ## 何を測るか
 *
 * 1. **製品の HTTP API で入れたテーマが、そのまま `theme.css` として画面に出る**
 *    —— 25宣言・恒等写像(スロット名がそのまま宣言名)・値が1バイトも変わらないこと。
 * 2. **本物の `navigator.clipboard` へ書けること**、および書いた中身が画面の文字列と一致すること。
 * 3. **持ち出し物が自分の限界を書いていること**(逃げ道を含まない / `:root` に当てるだけでは
 *    同じ描画にならない)。
 *
 * ## 何を測らないか(誇張しない)
 *
 * - **持ち出した `theme.css` を別実装に当てて見た目を比べていない。** 担保できるのは
 *   形式の安定までである(審査記録 §5 S3-2)。
 * - **`theme.json` の側はここに無い**(案#1 = `get_manifest` の出力そのもの。追加実装0件。
 *   往復の実測は `web/test/theme-template.test.ts`)。
 */
import { type APIRequestContext, expect, test } from "@playwright/test";
import type { Diff } from "../../src/kernel/types.ts";
import { type FixtureApp, provisionApp } from "./fixture-app.ts";

/**
 * 持ち出し用のテーマ(25スロット全部)。**コントラスト検査を通る値である**
 * (既定配色は通らない。ADR-0046 の 2026-07-25 追記「限界7」)。
 */
const THEME: Record<string, string> = {
  "--color-text": "#101010",
  "--color-text-secondary": "#595959",
  "--color-text-label": "#595959",
  "--color-text-placeholder": "#595959",
  "--color-danger": "#a00000",
  "--color-page-background": "#ffffff",
  "--color-surface-highlight": "#f2f2f2",
  "--color-border": "#767676",
  "--focus-outline-color": "#005fcc",
  "--focus-outline-width": "2px",
  "--font-family-base": "Georgia, serif",
  "--font-size-secondary": "0.85em",
  "--font-size-note": "0.875rem",
  "--line-height-base": "1.6",
  "--space-1": "0.25rem",
  "--space-2": "0.5rem",
  "--space-3": "0.75rem",
  "--space-4": "1rem",
  "--space-5": "1.25rem",
  "--space-6": "2rem",
  "--border-width": "1px",
  "--control-border-radius": "4px",
  "--surface-shadow": "none",
  "--detail-label-width": "8rem",
  "--login-max-width": "22rem",
};

function setThemeDiff(diffId: string): Diff {
  return {
    diff_id: diffId,
    intent: "組織で作った見た目を持ち出せるようにしたい、という要望に応えてテーマを設定した",
    operations: [{ op: "set_theme", theme: { slots: THEME, origin: { template_app_id: "org" } } }],
  };
}

/** 製品の HTTP API で差分を適用する(テスト専用経路ではない)。 */
async function applyDiff(request: APIRequestContext, app: FixtureApp, diff: Diff): Promise<void> {
  const applied = await request.post(`/api/apps/${app.appId}/diffs`, {
    data: diff,
    headers: app.authHeaders,
  });
  expect(applied.status(), await applied.text()).toBe(201);
}

/** `:root { … }` ブロックの宣言を (名前, 値) に割る。 */
function declarationsOf(css: string): Record<string, string> {
  const block = /:root\s*\{([\s\S]*?)\}/.exec(css);
  expect(block, `:root ブロックが無い:\n${css}`).not.toBeNull();
  const out: Record<string, string> = {};
  for (const chunk of (block?.[1] ?? "").split(";")) {
    const text = chunk.trim();
    if (text === "") continue;
    const colon = text.indexOf(":");
    out[text.slice(0, colon).trim()] = text.slice(colon + 1).trim();
  }
  return out;
}

test.describe("V3-M1-T05 テーマの持ち出し口(chromium 実測)", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "クリップボードの許可の与え方が chromium 固有である(`theme.e2e.ts` と同じ理由)",
  );

  test("マニフェストのテーマがそのまま theme.css として出て、コピーできる", async ({
    page,
    request,
    context,
  }) => {
    const app = await provisionApp(request);
    await applyDiff(request, app, setThemeDiff("theme-export"));
    await app.authenticate(context);
    // **本物のクリップボードを使う** —— 許可を与えないと writeText は拒否され、
    // 画面は「コピーできませんでした。」を出す(それは別の状態である)。
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);

    await page.goto(`/apps/${app.appId}`);
    await expect(page.getByTestId("open-theme-export")).toBeVisible();
    await page.getByTestId("open-theme-export").click();

    const shown = (await page.getByTestId("theme-css").textContent()) ?? "";

    // (1) 25宣言ちょうど・恒等写像・値がマニフェストのまま。
    const declarations = declarationsOf(shown);
    expect(Object.keys(declarations).sort()).toEqual(Object.keys(THEME).sort());
    expect(declarations).toEqual(THEME);

    // (2) 限界が生成物そのものに書かれている。
    //
    // **【V3-M5-T05 / ADR-0055 で改訂】** ここが固定していたのは「逃げ道は**含まれない**」で
    // あって「逃げ道は**存在しない**」ではないので、**assert そのものは今日も緑である。**
    // **偽になったのは生成物の側の理由の文言**(旧: 「置き場が未確定であり、現時点では
    // 逃げ道そのものが存在しない」)で、**実装によって偽になったので文言とテストを同時に直した。**
    // **弱めていない** —— 本題(含まれない)を残したまま、**旧文言の復活を赤にする逆向きの
    // 固定を足した**(単体側の同名テストと対になっている)。
    expect(shown).toContain("逃げ道");
    expect(shown).toContain("V3-M5");
    expect(shown).toContain("マニフェストの外");
    expect(shown).not.toContain("逃げ道そのものが存在しない");
    expect(shown).toContain("同じ描画にはならない");
    // 由来は自己申告であることも書かれている(このテーマは origin を持つ)。
    expect(shown).toContain("自己申告");

    // (3) 本物のクリップボードへ書ける。
    await page.getByTestId("copy-theme-css").click();
    await expect(page.getByTestId("copy-theme-css-result")).toHaveText("コピーしました。");
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toBe(shown);
  });

  test("テーマを持たないアプリでは、持ち出せるものが無いと出る", async ({
    page,
    request,
    context,
  }) => {
    const app = await provisionApp(request);
    await app.authenticate(context);

    await page.goto(`/apps/${app.appId}`);
    await page.getByTestId("open-theme-export").click();

    await expect(page.getByTestId("theme-export-empty")).toBeVisible();
    await expect(page.getByTestId("theme-css")).toHaveCount(0);
    await expect(page.getByTestId("copy-theme-css")).toHaveCount(0);
  });
});
