/**
 * アプリ単位テーマが**実際に画面へ当たること**の chromium 実測(V3-M1-T04)。
 *
 * 完了条件の正は `docs/plan/v3/records/v3-m1.md` §2 の「V3-M1-T04」節、限定の正は
 * `docs/adr/0048-theme-color-ledger-f5.md` §1b / §1c / §3(限定2 / 限定3)と
 * `docs/adr/0047-app-theme-manifest.md` §3。
 *
 * ## なぜ要るか
 *
 * V3-M1-T03 が終わった時点では、**マニフェストにテーマを入れても画面は1ピクセルも
 * 変わらなかった**(`docs/plan/v3/records/v3-m1-t03.md` §11)。`_changelog` に載り
 * `undo` も効きコントラスト検査も通るのに描画には何も起きない —— **緑のまま嘘になる形**
 * (憲法6)。本ファイルがその状態を終わらせる場所であり、**「テーマが効く」と言える根拠は
 * ここにしか無い。**
 *
 * ## 5本が何を証明するか(**(v) は V3-FIX-01 が足した**)
 *
 * | # | テスト | 証明するもの |
 * |---|---|---|
 * | (i) | テーマ無し | 既定の描画(`web/src/styles.css` の `:root` の値)である |
 * | (ii) | テーマ有り | **指定した色・書体・行間・余白が計算値として現れる**。あわせて **`.shell` に漏れない**(ADR-0048 限定2)|
 * | (iii) | アプリ間の遷移 | **テーマが残留しない**(下記の書き分けを読むこと)|
 * | (iv) | `apply_diff` | **製品の HTTP API で変えたらリロードだけで反映され、`undo` で戻る** |
 * | (v) | **影の当たり先** | **指定した影が5つの面すべてで効く**(未指定なら5つとも `none`)。V3-M1 が `.login` 1箇所しか作らなかったことの是正 |
 *
 * ## (iii) が証明すること / しないこと(**書き分けないと誇張になる**)
 *
 * `web/src/App.tsx` は route で**同時に1アプリしか描かない**。したがって (iii) が証明するのは
 * **「同一 DOM 上での2アプリのテーマの共存」ではなく「アプリ間を遷移してもテーマが残留しない
 * こと」である**(ADR-0048 §1c / T04-5)。証明の形は次の3点で、**2つのアプリを並べて
 * 描いたわけではない**:
 *
 * 1. アプリA(テーマA)→ アプリB(テーマB)へ**リロードを伴わない画面遷移**(シェルの
 *    「アプリ一覧」リンク経由)をしたあと、計算値がB のものだけになっている。
 * 2. **スコープ要素は常に1つだけ**である(`[data-testid="app-theme"]` の個数 = 1)。
 * 3. B の上で A の値を1つも読めない(スコープ要素の `--color-*` を実測して確認する)。
 *
 * ## このファイルが証明しないこと(ほかに)
 *
 * - **視覚的な同一性・見やすさは証明していない。** 読んでいるのは計算値だけで、
 *   スクリーンショット比較はしていない(`theme-baseline.e2e.ts` と同じ限界)。
 * - **テーマ対象外の3スロット**(`--shell-max-width` / `--border-style` /
 *   `--focus-outline-style`)**はテーマから当たらない。** (ii) はそれを「変わらないこと」の
 *   側で実測する(`--shell-max-width` は `.shell` の外側性、残る2件は7軸に無いことが理由。
 *   `web/test/__fixtures__/styles-token-slots.txt` の「テーマ対象外」節が正)。
 * - **読み込み中とマニフェストエラーの画面には当たらない**(原理的に。`web/test/app-theme.test.tsx`
 *   が固定している)。
 */
import { type APIRequestContext, expect, test } from "@playwright/test";
import type { Diff, ListView, Manifest } from "../../src/kernel/types.ts";
import {
  buildRecord,
  ensureReferenceTargets,
  type FixtureApp,
  provisionApp,
} from "./fixture-app.ts";

/**
 * 検証用のテーマA(暗い地色)。**25スロット全部を書く**(`$defs/theme` は全キー
 * `required`。ADR-0047 の 2026-07-25 追記(2)= 部分テーマを作らない)。
 *
 * **色はコントラスト検査を通る値である**(`src/kernel/theme-contrast.ts` の14組で実測)。
 * **既定配色をそのまま流し込むことはできない** —— `--color-border`(`#ddd`)が
 * 非テキスト閾値 3:1 を下回って必ず拒否される(ADR-0046 の 2026-07-25 追記「限界7」)。
 */
const THEME_A: Record<string, string> = {
  "--color-text": "#f5f5f5",
  "--color-text-secondary": "#c8d8e8",
  "--color-text-label": "#ffd54a",
  "--color-text-placeholder": "#b0b8c0",
  "--color-danger": "#ff9a8a",
  "--color-page-background": "#102030",
  "--color-surface-highlight": "#243447",
  "--color-border": "#8fa3b8",
  "--focus-outline-color": "#7fd4ff",
  "--font-family-base": "Georgia, serif",
  "--font-size-secondary": "12px",
  "--font-size-note": "13px",
  "--line-height-base": "2",
  "--space-1": "2px",
  "--space-2": "4px",
  "--space-3": "6px",
  "--space-4": "8px",
  "--space-5": "10px",
  "--space-6": "12px",
  "--border-width": "3px",
  "--control-border-radius": "5px",
  "--surface-shadow": "0 2px 6px #000000",
  "--focus-outline-width": "4px",
  "--detail-label-width": "120px",
  "--login-max-width": "300px",
};

/** 検証用のテーマB(明るい地色)。**A と1つも同じ色を持たない。** */
const THEME_B: Record<string, string> = {
  ...THEME_A,
  "--color-text": "#1a237e",
  "--color-text-secondary": "#37474f",
  "--color-text-label": "#4a148c",
  "--color-text-placeholder": "#5d4037",
  "--color-danger": "#b00020",
  "--color-page-background": "#fff8e1",
  "--color-surface-highlight": "#ffecb3",
  "--color-border": "#6d4c41",
  "--focus-outline-color": "#00695c",
  "--font-family-base": "Courier New, monospace",
  "--line-height-base": "1.2",
};

/** テーマ対象外の3スロット(テーマから当たらないことを (ii) が実測する)。 */
const THEME_EXCLUDED = ["--shell-max-width", "--border-style", "--focus-outline-style"] as const;

function setThemeDiff(slots: Record<string, string>, diffId: string): Diff {
  return {
    diff_id: diffId,
    intent: "アプリの配色をこのアプリだけの見た目に変えたい、という要望に応えてテーマを設定した",
    operations: [{ op: "set_theme", theme: { slots } }],
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

/** 要素の計算値をまとめて読む(`theme-baseline.e2e.ts` と同じ形)。 */
async function computed(
  page: import("@playwright/test").Page,
  selector: string,
  properties: string[],
): Promise<Record<string, string>> {
  return await page.evaluate(
    ({ selector, properties }) => {
      const element = document.querySelector(selector);
      if (element === null) throw new Error(`要素が見つからない: ${selector}`);
      const style = getComputedStyle(element);
      const out: Record<string, string> = {};
      for (const property of properties) out[property] = style.getPropertyValue(property);
      return out;
    },
    { selector, properties },
  );
}

/** スコープ要素で解決されるカスタムプロパティの値(残留の検査に使う)。 */
async function customProperties(
  page: import("@playwright/test").Page,
  names: readonly string[],
): Promise<Record<string, string>> {
  return await page.evaluate((names) => {
    const element = document.querySelector('[data-testid="app-theme"]');
    if (element === null) throw new Error("スコープ要素が無い");
    const style = getComputedStyle(element);
    const out: Record<string, string> = {};
    for (const name of names) out[name] = style.getPropertyValue(name).trim();
    return out;
  }, names);
}

function listViewOf(manifest: Manifest): ListView {
  const view = manifest.app.views.find((candidate): candidate is ListView => {
    return candidate.type === "list_view";
  });
  if (view === undefined) throw new Error("フィクスチャに list_view が無い");
  return view;
}

test.describe("V3-M1-T04 テーマの表示層への適用(chromium 実測)", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "計算値の期待値は chromium の値である(`theme-baseline.e2e.ts` と同じ理由)",
  );

  test("(i) テーマを持たないアプリは既定の描画のままである", async ({ page, request }) => {
    const app = await provisionApp(request);
    await page.goto(`/apps/${app.appId}`);
    await expect(page.getByTestId("login-page")).toBeVisible();

    // スコープ要素は在るが、テーマの inline style は1つも無い。
    const scope = page.getByTestId("app-theme");
    await expect(scope).toBeVisible();
    expect(await scope.getAttribute("style")).toBeNull();

    // 既定値(`:root`)そのままで解決している。
    const values = await computed(page, '[data-testid="app-theme"]', [
      "color",
      "background-color",
      "font-family",
      "line-height",
    ]);
    expect(values.color).toBe("rgb(0, 0, 0)"); // --color-text: #000
    expect(values["background-color"]).toBe("rgb(255, 255, 255)"); // --color-page-background: #fff
    expect(values["font-family"]).toBe("system-ui, sans-serif");
    expect(values["line-height"]).toBe("25.6px"); // 1.6 × 16px

    // フォームコントロールも既定の書体・行間を継いでいる(T04-3 の追加分)。
    // **UA 既定は `Arial` / `normal` である**(chromium 実測)。
    const input = await computed(page, '[data-testid="auth-username"]', [
      "font-family",
      "line-height",
      "font-size",
    ]);
    expect(input["font-family"]).toBe("system-ui, sans-serif");
    // `line-height: 1.6` は**数値のまま継承される**ので、使用値は要素の font-size 倍である。
    // **【V4-M15-T04 で期待値を書き換えた。13.3333px → 14px / 21.3333px → 22.4px】**
    // 着手前は入力欄の文字寸が UA 既定の `13.3333px` のままだった(`styles.css` は
    // `font-family` と `line-height` しか継がせていなかった)。着手後は部品体系の
    // `text-sm`(0.875rem = 14px)が当たる。**行間は 14 × 1.6 = 22.4px。**
    // **変える値と変える理由は `docs/plan/v4/records/v4-m15-t19.md` §T10-1 に先に書いた。**
    expect(input["font-size"]).toBe("14px");
    expect(input["line-height"]).toBe("22.4px");
  });

  test("(ii) テーマを持つアプリは指定した色・書体・行間・余白で描かれ、シェルには漏れない", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await applyDiff(request, app, setThemeDiff(THEME_A, "theme-a"));
    await app.authenticate(page.context());
    const view = listViewOf(app.manifest);
    // 表(`.list-table`)は行が1件以上ないと描かれないので、1件入れておく。
    const table = app.tableOf(view.table);
    const referenceIds = await ensureReferenceTargets(app, table);
    await app.createRecord(table.id, buildRecord(table, 1, referenceIds));
    await page.goto(`/apps/${app.appId}/views/${view.id}`);
    await expect(page.getByTestId("list-table")).toBeVisible();

    // --- スコープ要素そのもの ---
    const scope = await computed(page, '[data-testid="app-theme"]', [
      "color",
      "background-color",
      "font-family",
      "line-height",
    ]);
    expect(scope.color).toBe("rgb(245, 245, 245)"); // --color-text: #f5f5f5
    expect(scope["background-color"]).toBe("rgb(16, 32, 48)"); // --color-page-background: #102030
    expect(scope["font-family"]).toBe("Georgia, serif");
    expect(scope["line-height"]).toBe("32px"); // 2 × 16px

    // --- スコープ配下の規則(`var()` を要素側で解決するもの)---
    const meta = await computed(page, ".view-list .meta", ["color", "font-size"]);
    expect(meta.color).toBe("rgb(200, 216, 232)"); // --color-text-secondary
    expect(meta["font-size"]).toBe("12px"); // --font-size-secondary
    const currentUser = await computed(page, ".app-header .current-user", ["color"]);
    expect(currentUser.color).toBe("rgb(200, 216, 232)");
    const cell = await computed(page, ".list-table td", [
      "border-bottom-width",
      "border-bottom-style",
      "border-bottom-color",
      "padding-top",
      "padding-left",
    ]);
    expect(cell["border-bottom-width"]).toBe("3px"); // --border-width
    expect(cell["border-bottom-color"]).toBe("rgb(143, 163, 184)"); // --color-border
    expect(cell["padding-top"]).toBe("2px"); // --space-1
    expect(cell["padding-left"]).toBe("4px"); // --space-2
    // **テーマ対象外**: 枠線の種別はテーマに無いので `solid` のままである。
    expect(cell["border-bottom-style"]).toBe("solid");

    // --- フォームコントロール(T04-3 の追加分が効いていること)---
    const button = await computed(page, '[data-testid="logout"]', [
      "font-family",
      "line-height",
      "border-top-left-radius",
      "color",
      "background-color",
    ]);
    expect(button["font-family"]).toBe("Georgia, serif"); // font-family: inherit の効果
    // 行間はテーマの `2` が**数値のまま**継承されるので、使用値はボタンの font-size 倍である。
    // **【V4-M15-T04 で期待値を書き換えた。26.6667px → 28px】**
    // 着手前はボタンの文字寸が UA 既定の `13.3333px` のままだった。着手後は部品体系の
    // `text-sm`(14px)が当たるので、`14 × 2 = 28px` になる。
    expect(button["line-height"]).toBe("28px"); // line-height: inherit の効果
    expect(button["border-top-left-radius"]).toBe("5px"); // --control-border-radius
    // **【V4-M15-T01 / T14 で期待値を書き換えた。この限界は今日から成り立たない】**
    //
    // **着手前の2行は次のとおりだった**(2026-08-03 実測):
    //   expect(button.color).toBe("rgb(0, 0, 0)");
    //   expect(button["background-color"]).toBe("rgb(239, 239, 239)");
    // 逐語の注記は「**`color: inherit` を足していないので、フォームコントロールの文字色と
    // 地色はテーマの `--color-text` / `--color-page-background` では変わらない**(UA の
    // システム色のまま)。暗いテーマでもボタンは UA の灰色地に黒文字である」だった。
    //
    // **部品体系のボタンは、文字色と地色を25スロットの側から必ず対で書く**ので、
    // **テーマの色がそのまま出る。** したがって上の限界は今日から成り立たない。
    //
    // ## `ADR-0046` §3a の門に当たるか(**当たらない。理由を書く**)
    //
    // `web/src/styles.css` の逐語は「**`color: inherit` を足すと『テーマの文字色 × UA の
    // フィールド地色(`field` = 白)』という対ができるが、コントラスト検査はこの対を1組も
    // 見ていない。…足すなら検査対象の対を増やすのが先であり、それは `ADR-0046` §3a の門を
    // 通す事項である**」である。**門が要る理由は「検査が見ていない対ができること」であって、
    // 「フォームコントロールに色が付くこと」ではない。**
    //
    // **本実装は `color: inherit` を足していない。** 前景も地色も**25スロットの側から
    // 明示的に対で書いている**(`bg-background` + `text-foreground` など)。
    // **その対は `src/kernel/theme-contrast.ts` の `THEME_CONTRAST_PAIRS`(前景7 × 背景2 =
    // 14組)に既に全部入っている**(2026-08-03 に列挙して実測した)。
    // **したがって検査が見ていない対は1組も増えておらず、`src/kernel/theme-contrast.ts` に
    // 1バイトも触っていない。** **穴は開いたのではなく、塞がった側である** ——
    // UA のフィールド地色が出る余地が無くなった。
    expect(button.color).toBe("rgb(245, 245, 245)"); // --color-text: #f5f5f5
    expect(button["background-color"]).toBe("rgb(16, 32, 48)"); // --color-page-background: #102030

    // --- フォーカスリング(色と太さはテーマ、種別は対象外)---
    await page.getByTestId("logout").focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => {
      const element = document.activeElement;
      if (element === null) throw new Error("フォーカス要素が無い");
      const style = getComputedStyle(element);
      return {
        testid: element.getAttribute("data-testid"),
        width: style.outlineWidth,
        style: style.outlineStyle,
        color: style.outlineColor,
      };
    });
    expect(focused.testid).toBe("logout");
    expect(focused.width).toBe("4px"); // --focus-outline-width
    expect(focused.color).toBe("rgb(127, 212, 255)"); // --focus-outline-color
    expect(focused.style).toBe("solid"); // **テーマ対象外**(種別は7軸に無い)

    // --- シェルへ漏れないこと(ADR-0048 限定2 / T04-2)---
    const shell = await computed(page, ".shell", [
      "max-width",
      "padding-top",
      "color",
      "font-family",
      "line-height",
    ]);
    // `--shell-max-width` は**テーマ対象外**なので 60rem のままである。
    expect(shell["max-width"]).toBe("960px");
    // `.shell` の余白はアプリスコープの外なので既定のままである(テーマA は 8px を
    // 指定しているが、当たらない)。**【V4-M15-T07 で期待値を書き換えた。16px → 32px】**
    // `.shell` の余白に幅の条件を足した(`ADR-0089` / `D-V4-44`)—— 既定 `--space-2`(8px)/
    // 40rem 以上 `--space-4`(16px)/ 64rem 以上 `--space-6`(32px)。
    // **playwright の既定ビューポートは Desktop Chrome = 1280×720 なので 64rem 以上に当たる。**
    // **テーマが当たらないこと(この検査が見ているもの)は1バイトも変わっていない。**
    expect(shell["padding-top"]).toBe("32px");
    // シェルの文字色・書体・行間も `body` 由来の既定のままである(射程外)。
    expect(shell.color).toBe("rgb(0, 0, 0)");
    expect(shell["font-family"]).toBe("system-ui, sans-serif");
    expect(shell["line-height"]).toBe("25.6px");
    // シェルのヘッダの下線もテーマの枠線色・太さを受けていない。
    const shellHeader = await computed(page, ".shell header", [
      "border-bottom-width",
      "border-bottom-color",
    ]);
    expect(shellHeader["border-bottom-width"]).toBe("1px");
    expect(shellHeader["border-bottom-color"]).toBe("rgb(221, 221, 221)");
    // ページ全体の地色(`body`)もテーマの地色になっていない。
    const body = await computed(page, "body", ["background-color", "color"]);
    expect(body["background-color"]).toBe("rgb(255, 255, 255)");
    expect(body.color).toBe("rgb(0, 0, 0)");

    // --- テーマ対象外の3件が `.shell` 側でも既定値であること ---
    const excluded = await page.evaluate((names) => {
      const element = document.querySelector(".shell");
      if (element === null) throw new Error(".shell が無い");
      const style = getComputedStyle(element);
      const out: Record<string, string> = {};
      for (const name of names) out[name] = style.getPropertyValue(name).trim();
      return out;
    }, THEME_EXCLUDED);
    expect(excluded).toEqual({
      "--shell-max-width": "60rem",
      "--border-style": "solid",
      "--focus-outline-style": "solid",
    });
  });

  test("(iii) アプリ間を遷移してもテーマが残留しない(同一 DOM 上の共存ではない)", async ({
    page,
    request,
  }) => {
    const appA = await provisionApp(request);
    const appB = await provisionApp(request);
    await applyDiff(request, appA, setThemeDiff(THEME_A, "theme-a"));
    await applyDiff(request, appB, setThemeDiff(THEME_B, "theme-b"));
    // --- アプリA を開く(未認証のログイン画面。ここにもテーマは当たる)---
    // **【`V8-M21` の後半。この検査は着手前の形に戻っている】** —— **いったん配色が
    // 未ログインへ渡らなくなり、この行は「ログイン済みの作業画面」を見る形に変わったが、
    // メインが `D-V8-34` の逐語「ログイン画面も公開ページも今どおり出る」を根拠に
    // `GET /public` へ配色を1キー足すと判断したので、**期待値も測る画面も元どおりである**。**
    await page.goto(`/apps/${appA.appId}`);
    await expect(page.getByTestId("login-page")).toBeVisible();
    const onA = await computed(page, '[data-testid="app-theme"]', [
      "color",
      "background-color",
      "font-family",
      "line-height",
    ]);
    expect(onA.color).toBe("rgb(245, 245, 245)");
    expect(onA["background-color"]).toBe("rgb(16, 32, 48)");
    expect(onA["font-family"]).toBe("Georgia, serif");
    expect(onA["line-height"]).toBe("32px");

    // --- リロードを伴わずにアプリB へ遷移する(シェルのアプリ一覧経由)---
    await page.getByRole("link", { name: "アプリ一覧" }).click();
    await expect(page.getByTestId("app-list")).toBeVisible();
    await page.getByRole("link", { name: appB.appName }).click();
    await expect(page.getByTestId("login-page")).toBeVisible();

    const onB = await computed(page, '[data-testid="app-theme"]', [
      "color",
      "background-color",
      "font-family",
      "line-height",
    ]);
    // B の値だけになっている(A の値は1つも残っていない)。
    expect(onB.color).toBe("rgb(26, 35, 126)"); // #1a237e
    expect(onB["background-color"]).toBe("rgb(255, 248, 225)"); // #fff8e1
    // 計算値は引用符つきで直列化される(注入した値は `Courier New, monospace`)。
    expect(onB["font-family"]).toBe('"Courier New", monospace');
    expect(onB["line-height"]).toBe("19.2px"); // 1.2 × 16px

    // カスタムプロパティの側からも残留を見る(A の値が1つも読めない)。
    const resolved = await customProperties(page, [
      "--color-text",
      "--color-page-background",
      "--font-family-base",
    ]);
    expect(resolved["--color-text"]).toBe(THEME_B["--color-text"]);
    expect(resolved["--color-page-background"]).toBe(THEME_B["--color-page-background"]);
    expect(resolved["--font-family-base"]).toBe(THEME_B["--font-family-base"]);

    // **スコープ要素は常に1つだけである**(2アプリが同一 DOM に並ぶことはない)。
    expect(await page.getByTestId("app-theme").count()).toBe(1);

    // --- A へ戻ると A のテーマに戻る(残留の逆向きも見る)---
    await page.getByRole("link", { name: "アプリ一覧" }).click();
    await expect(page.getByTestId("app-list")).toBeVisible();
    await page.getByRole("link", { name: appA.appName }).click();
    await expect(page.getByTestId("login-page")).toBeVisible();
    const backOnA = await computed(page, '[data-testid="app-theme"]', [
      "color",
      "background-color",
    ]);
    expect(backOnA.color).toBe("rgb(245, 245, 245)");
    expect(backOnA["background-color"]).toBe("rgb(16, 32, 48)");
  });

  test("(iv) 稼働中のサーバに apply_diff でテーマを設定すると、リロードだけで反映され undo で戻る", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await page.goto(`/apps/${app.appId}`);
    await expect(page.getByTestId("login-page")).toBeVisible();

    // (a) 適用前 = 既定の描画
    const before = await computed(page, '[data-testid="app-theme"]', ["color", "background-color"]);
    expect(before.color).toBe("rgb(0, 0, 0)");
    expect(before["background-color"]).toBe("rgb(255, 255, 255)");

    // (b) サーバは起動したまま、**製品の** HTTP API に差分を投げる
    //     (フロントの再ビルドもサーバの再起動もページの開き直しもしない)。
    await applyDiff(request, app, setThemeDiff(THEME_A, "theme-a"));

    // (c) リロードするだけで色が変わる
    await page.reload();
    await expect(page.getByTestId("login-page")).toBeVisible();
    const after = await computed(page, '[data-testid="app-theme"]', [
      "color",
      "background-color",
      "font-family",
    ]);
    expect(after.color).toBe("rgb(245, 245, 245)");
    expect(after["background-color"]).toBe("rgb(16, 32, 48)");
    expect(after["font-family"]).toBe("Georgia, serif");
    // ログイン画面にしか当たらないスロット3件も、リロード後の値になっている。
    const login = await computed(page, ".login", ["max-width", "margin-top", "box-shadow"]);
    expect(login["max-width"]).toBe("300px"); // --login-max-width
    expect(login["margin-top"]).toBe("12px"); // --space-6
    expect(login["box-shadow"]).toBe("rgb(0, 0, 0) 0px 2px 6px 0px"); // --surface-shadow
    // **【`V8-M21` の後半で1本だけ足した。減らしていない】** **同じ3つのスロットを、
    // 値の側(カスタムプロパティ)でも測る** —— **未ログインへ渡る配色が
    // `GET /public` 経由で本当に届いていることを、当たり先とは別に固定する。**
    const slots = await customProperties(page, [
      "--login-max-width",
      "--space-6",
      "--surface-shadow",
    ]);
    expect(slots["--login-max-width"]).toBe(THEME_A["--login-max-width"]);
    expect(slots["--space-6"]).toBe(THEME_A["--space-6"]);
    expect(slots["--surface-shadow"]).toBe(THEME_A["--surface-shadow"]);

    // (d) undo → リロードだけで既定へ戻る(`app.theme` のキーごと消える)
    const undone = await request.post(`/api/apps/${app.appId}/undo`, { headers: app.authHeaders });
    expect(undone.status(), await undone.text()).toBe(200);
    await page.reload();
    await expect(page.getByTestId("login-page")).toBeVisible();
    const restored = await computed(page, '[data-testid="app-theme"]', [
      "color",
      "background-color",
      "font-family",
    ]);
    expect(restored.color).toBe("rgb(0, 0, 0)");
    expect(restored["background-color"]).toBe("rgb(255, 255, 255)");
    expect(restored["font-family"]).toBe("system-ui, sans-serif");
    // inline style そのものが消えている(テーマを持たない状態に戻った)。
    expect(await page.getByTestId("app-theme").getAttribute("style")).toBeNull();
  });

  /**
   * (v) **V3-FIX-01。影の当たり先が `.login` 1箇所しかなかったことの是正の実測。**
   *
   * V3-M1 は影の軸(`--surface-shadow`)を新設したのに、当たり先を `.login` にしか
   * 作らなかった。**そのため利用者がテーマで影を指定しても、ログイン画面のカード以外は
   * 1ピクセルも変わらなかった**(V3-M2-T06 の R39 が実測。`docs/plan/v3/records/v3-fix-01.md`)。
   *
   * **同じアプリを、テーマを当てる前と後で測る。** 前は5面すべて `none`(= 未指定の描画は
   * 1ピクセルも変わらない)、後は5面すべて指定した影である。**「効く」と言える根拠はここにある。**
   *
   * **測らないこと**: 影が視覚的にどう見えるか(計算値しか読んでいない。本ファイルの
   * 既存の限界と同じ)。
   */
  test("(v) 影を指定すると、面と判定した5つの当たり先すべてで効く(未指定なら5つとも none)", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const app = await provisionApp(request);
    await app.authenticate(page.context());

    const list = listViewOf(app.manifest);
    const detailView = app.manifest.app.views.find((view) => view.type === "detail_view");
    const formView = app.manifest.app.views.find((view) => view.type === "form");
    if (detailView === undefined || formView === undefined) {
      throw new Error("フィクスチャに detail_view / form が無い");
    }
    const detailViewId = detailView.id;
    const formViewId = formView.id;
    const table = app.tableOf(list.table);
    const referenceIds = await ensureReferenceTargets(app, table);
    const recordId = await app.createRecord(table.id, buildRecord(table, 0, referenceIds));

    // 子一覧(`related`)の表は既存のフィクスチャに無いので、1画面だけ足す
    // (`preset.e2e.ts` の (vii) と同じ作り方)。
    const categoryId = referenceIds.get("categories");
    expect(categoryId, "参照先のカテゴリが作られている").toBeDefined();
    await applyDiff(request, app, {
      diff_id: "shadow-related-view",
      intent: "カテゴリの詳細に、そのカテゴリの備品一覧を出したい",
      operations: [
        {
          op: "add_view",
          view: {
            id: "shadow-category-detail",
            type: "detail_view",
            table: "categories",
            related: [{ table: "items", via: "category", columns: ["name"] }],
          },
        },
      ],
    } as Diff);

    /** 5つの当たり先の `box-shadow` を、それぞれの画面を開いて読む。 */
    async function shadowsOnEveryScreen(): Promise<Record<string, string>> {
      const out: Record<string, string> = {};

      // 一覧(`.list-table`)
      await page.goto(`/apps/${app.appId}/views/${list.id}`);
      await expect(page.getByTestId("list-table")).toBeVisible();
      out[".list-table"] =
        (await computed(page, ".list-table", ["box-shadow"]))["box-shadow"] ?? "";

      // 詳細の項目のかたまり(`.detail-fields`)—— **R39 が名指しした対象**
      await page.goto(`/apps/${app.appId}/views/${detailViewId}/records/${recordId}`);
      await expect(page.getByTestId("detail-fields")).toBeVisible();
      out[".detail-fields"] =
        (await computed(page, ".detail-fields", ["box-shadow"]))["box-shadow"] ?? "";

      // 詳細の子一覧の表(`.related-table`)
      await page.goto(`/apps/${app.appId}/views/shadow-category-detail/records/${categoryId}`);
      await expect(page.getByTestId("related-table")).toBeVisible();
      out[".related-table"] =
        (await computed(page, ".related-table", ["box-shadow"]))["box-shadow"] ?? "";

      // フォーム(`.record-form`)
      await page.goto(`/apps/${app.appId}/views/${formViewId}`);
      await expect(page.locator(".record-form")).toBeVisible();
      out[".record-form"] =
        (await computed(page, ".record-form", ["box-shadow"]))["box-shadow"] ?? "";

      // ログイン画面のカード(`.login`)—— **V3-M1 が置いた唯一の当たり先**。
      // 認証済みでは出ないので、cookie を消してから開く。
      await page.context().clearCookies();
      await page.goto(`/apps/${app.appId}`);
      await expect(page.getByTestId("login-page")).toBeVisible();
      out[".login"] = (await computed(page, ".login", ["box-shadow"]))["box-shadow"] ?? "";
      await app.authenticate(page.context());

      return out;
    }

    // --- (a) テーマを当てる前: 5面とも UA 既定の `none` ------------------------
    // **既定値が `none` なので、宣言を4件足しても描画は1ピクセルも変わらない。**
    // **【V4-M15 でも変えなかった】** 影の既定値を変える案は `src/mcp/vocabulary.ts` の
    // 段階表と結び付いており、`ADR-0087` 限定1 と両立しないので着手前の値へ戻した。
    expect(await shadowsOnEveryScreen()).toEqual({
      ".list-table": "none",
      ".detail-fields": "none",
      ".related-table": "none",
      ".record-form": "none",
      ".login": "none",
    });

    // --- (b) テーマA(`--surface-shadow: 0 2px 6px #000000`)を当てる ----------
    await applyDiff(request, app, setThemeDiff(THEME_A, "theme-a-shadow"));

    const shadow = "rgb(0, 0, 0) 0px 2px 6px 0px";
    // **【`V8-M21` の後半。期待値は着手前の形に戻っている】** —— **いったん `.login` だけが
    // `"none"` になった**(未ログインへ配色が渡らなくなったため)。**メインが `D-V8-34` の
    // 逐語「ログイン画面も公開ページも今どおり出る」を根拠に `GET /public` へ配色を
    // 1キー足すと判断したので、**5面すべてで効くという期待値がそのまま生きている**。**
    expect(await shadowsOnEveryScreen()).toEqual({
      ".list-table": shadow,
      ".detail-fields": shadow,
      ".related-table": shadow,
      ".record-form": shadow,
      ".login": shadow,
    });
  });
});
