/**
 * V3-M1-T01 の実測検査 —— **chromium で `getComputedStyle` を読む最初のテストである**
 * (`web/src/` / `web/test/` / `web/e2e/` の `getComputedStyle` / `toHaveCSS` /
 * スクリーンショット比較は、本ファイル以前は0件だった。`docs/plan/v3/03-token-slot-inventory.md`
 * §8-2 の実測)。
 *
 * ## なぜ要るか
 *
 * `web/test/styles.test.ts` の検査 (a) は **CSS のテキスト**しか見ない。新設7軸のうち
 * **ページ地色とアウトラインは (a) では「宣言の追加」に見えるだけだが、ブラウザ上の
 * 計算値は実際に変わる**(`docs/plan/v3/records/v3-m1.md` §1-1 (e))。変わったことを
 * 「変わった」と言える場所がどこにも無いと、緑のまま嘘になる(憲法6)。本ファイルが
 * その場所である。
 *
 * ## 記録する実測値(2026-07-25 / chromium。すべて本ファイルの期待値そのもの)
 *
 * | 対象 | UA 既定(スロット導入前) | 導入後 |
 * |---|---|---|
 * | `body` の `background-color` | `rgba(0, 0, 0, 0)`(**透明。白ではない**) | `rgb(255, 255, 255)` = **変わる** |
 * | `body` の `color` | `rgb(0, 0, 0)` | `rgb(0, 0, 0)` = 変わらない |
 * | `button` / `input` / `select` / `textarea` の `border-radius` | `0px` | `0px` = 変わらない |
 * | 任意要素の `box-shadow` | `none` | `none` = 変わらない |
 * | 非フォーカス時の `outline-style` | `none` | `none` = 変わらない |
 * | **`:focus-visible` の `outline`** | **`auto 1px` + UA のリング色(**環境依存**。下記)** | **`rgb(0, 95, 204) solid 2px` = 変わる** |
 *
 * **地色の既定値 `#fff` は「実測した UA 既定値」ではない** —— 要素の
 * `background-color` の UA 既定は透明であり、白は要素の色ではなくブラウザのキャンバスの色
 * である。そこで **キャンバスの色をシステム色 `Canvas` の計算値として実測**し、それを
 * 既定値の根拠にした(本文文字色は `CanvasText`、フォーカスリング色は
 * `-webkit-focus-ring-color`)。その3つを最後のテストが固定する。
 *
 * ## 【2026-07-27。V3-FIX-02 で最後のテストの主張を書き直した】
 *
 * **書き直した理由は「CI で落ちたから」ではない。** **`#005fcc` は「UA のフォーカスリング色
 * そのものである」という根拠が、実は環境依存で、macOS でしか成り立たないと分かったからである。**
 * その根拠のまま期待値を1つに固定していると、**テストは「環境に依らない事実」を主張している
 * ように読めるのに、実際には macOS でしか真でない**。**何を守る検査なのかを書き直した。**
 *
 * | 環境 | `-webkit-focus-ring-color` の計算値 | 実測 |
 * |---|---|---|
 * | **macOS** の chromium(playwright / headless) | **`rgb(0, 95, 204)`** | 2026-07-25 の V3-M1-T01 §8-1 / 2026-07-27 に再実測 |
 * | **Linux** の chromium(GitHub Actions `ubuntu-latest`) | **`rgb(16, 16, 16)`**(= `#101010`) | 2026-07-27 の実 CI(V3-M5-T06 の run 30227210705 / 30227359431 が赤で出した値) |
 *
 * **由来**: chromium の既定フォーカスリング色は**プラットフォーム依存**である
 * (blink-dev: "the default focus ring color does depend on the platform, e.g. it is blue
 * (or other colors!) on Mac, and black on Windows.")。**OS のアクセントカラーを
 * `-webkit-focus-ring-color` に流しているのは macOS だけ**で、他のプラットフォームは
 * 固定値を使う。**したがって「UA の色に合わせた」という根拠は、最初から macOS 限定だった。**
 *
 * **最後のテストが今日主張するのは次の3つである(2つは「値の固定」、1つは「環境ごとの実測の台帳」)**:
 *
 * 1. **`Canvas` / `CanvasText` は macOS と Linux の chromium で同じ値である**(実測)。
 *    したがって `--color-page-background: #fff` / `--color-text: #000` の根拠は、
 *    **この2環境については**環境に依らない。値そのものを固定する。
 * 2. **`-webkit-focus-ring-color` は環境依存である。** 期待値は**プラットフォーム別の実測表**
 *    (`OBSERVED_UA_FOCUS_RING_COLOR`)から引く。**未実測のプラットフォームでは緑にせず、
 *    「実測して表に足し、記録に書け」と言って落ちる。**
 * 3. **製品が宣言している `--focus-outline-color` の値は、環境に依らない固定のリテラルである。**
 *    **その値が UA のリング色と一致するのは macOS だけである** —— これを明示的に固定した。
 *    **つまり Linux では、この製品の宣言はリングの太さと種別だけでなく色も変えている。**
 *
 * **書き直しの途中で分かった、もう1つの環境依存(実測)**: **ブラウザが名乗る
 * プラットフォームは、この判定には使えない。** `web/e2e/playwright.config.ts` の
 * `devices["Desktop Chrome"]` が **Windows の userAgent を被せる**ので、
 * **macOS で走らせても `navigator.userAgentData.platform` は `"Windows"` を返す**
 * (最初この値で表を引く実装にしたところ、ローカルで「未実測のプラットフォーム Windows」
 * として落ちた。実測)。**UA のリング色を決めているのはホストの OS のほう**なので、
 * 表のキーは `process.platform` にした。**食い違い自体もテストで固定してある。**
 *
 * **既定値そのもの(`#005fcc`)は変えていない。** 変えると `web/src/styles.css` の `:root` に
 * 触れ、ADR-0046 / ADR-0047 の限定と `web/test/styles.test.ts` の検査に当たる。
 * **そもそも「環境に依らない正しい値」は存在しない**(環境ごとに UA の色が違うのだから、
 * どの値を選んでもどこかの環境の UA とは一致しない)。**増分の小さいほうを採った。**
 * 理由の正は `docs/plan/v3/records/v3-fix-02.md`、ADR 側の追記は
 * `docs/adr/0046-design-token-slots.md` の限界8 である。
 *
 * ## このファイルが証明しないこと(誇張しない)
 *
 * 1. **視覚的な同一性は証明していない。** 読んでいるのは計算値だけで、スクリーンショットの
 *    比較はしていない。`outline-style: auto` が実際に描く2重リングと `solid 2px` の
 *    見え方が同じかどうかは、ここでは分からない。
 * 2. **`:focus-visible` にしか宣言していないことの証明は、キーボード操作の側からだけである。**
 *    「マウスクリックでは立たない」は、ログイン画面の4つのボタンがどれも押すと認証 API を
 *    叩いてしまうため、副作用なしに確かめられなかった。代わりに **非フォーカス時に
 *    `outline-style` が `none` のままである**ことを固定した(無条件セレクタに書いていない
 *    ことはこれで分かるが、`:focus` と `:focus-visible` の差までは分からない)。
 * 3. **テーマを差し替えたときに色が変わることは、ここでは確かめない**(V3-M1-T04 の担当)。
 *    本ファイルが見るのは**既定値だけ**である。
 * 4. **`Canvas` / `CanvasText` が「どの環境でも同じ」ことは証明していない。** 実測したのは
 *    macOS と Linux の chromium の2つだけである。**chromium 自身は「システム色が OS の色に
 *    解決するのは Windows と Mac だけ」と説明しており、また `color-scheme` が dark のときは
 *    `Canvas` と `CanvasText` が入れ替わる。** Windows / ダークモード / 他ブラウザでは
 *    測っていない(**ADR-0046 限定5 により `@media` を1つも足せないので、そもそもこの製品は
 *    ダークモードに追随しない**)。
 *
 *    **【V4-M57 が 2026-08-04 に追記。門外 Δ7 / 限定採用。記録
 *    `docs/plan/v4/records/v4-m57.md`】上の括弧の中の**理由**(「`ADR-0046` 限定5 により
 *    `@media` を1つも足せない」)は今日から偽である** —— **2026-08-04 実測:
 *    `web/src/styles.css` には幅の条件の `@media` が2本ある**
 *    (`:982` 逐語 `@media (min-width: 40rem)` / `:988` 逐語 `@media (min-width: 64rem)`。
 *    どちらも `.shell` の `padding` だけを変える)。**足したのは `ADR-0089`**
 *    (`V4-M15-T07` / `D-V4-44`。2026-08-03)であり、同 ADR は自ら
 *    「**【禁止】「限定5 を1バイトも緩めていない」と書かない。緩めている。**」と書いている。
 *    **一方で帰結(「そもそもこの製品はダークモードに追随しない」)は今日も真である** ——
 *    **緩んだのは幅の条件の分だけであり、配色設定のメディア特性
 *    (`prefers-color-scheme`)は今日も1つも無い**(`web/src/styles.css` 冒頭の逐語
 *    「**配色設定のメディア特性とテーマ切り替えの属性セレクタは1バイトも動かしていない**」/
 *    `web/test/preset-boundary.test.ts` の `(ii)` 逐語「**手で書く側に、幅の条件以外の
 *    at-rule / 配色設定のメディア特性 / テーマ切り替えの属性セレクタが無い**」が
 *    実物側から固定している)。
 *    **したがって本ファイルが Windows / ダークモード / 他ブラウザを測っていないことも
 *    今日どおりである。** **旧文を1バイトも消していない**(`D-V4-188`)。
 *    **【禁止】「この製品がダークモードに追随するようになった」と読まない。**
 *    **【なぜ前の走査がここに届かなかったか。機序で書く】** **本行は `@media` の字面を
 *    含んでいる。** **取り逃したのは否定の**活用形**である** —— **可能形
 *    「1つも足**せ**ない」が `V4-M53` の交替列(`足さない` / `足していない` / `無い` /
 *    `持てない` / `使わない`)に無かった。** **`ADR-0007` 限界11 改訂7 追記が名指しした
 *    「字面を含まない」類型とは別の、走査の第2の類型である**(`D-V4-195`)。
 * 5. **UA 既定の `outline` の**短縮形**を Linux で実測してはいない。** Linux について実測した
 *    のはシステム色 `-webkit-focus-ring-color` の計算値だけである(`:focus-visible` には
 *    製品自身の宣言が当たるので、実ページから UA 既定の `outline` は読めない)。
 */
import { expect, test } from "@playwright/test";
import { provisionApp } from "./fixture-app.ts";

/** 要素の計算値をまとめて読む。 */
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

/**
 * **UA のフォーカスリング色(`-webkit-focus-ring-color`)の、プラットフォーム別の実測値。**
 *
 * **これは「どの環境でも同じ値である」という主張ではない。** その逆で、**環境ごとに違う
 * ことが分かったので、違いを表として見える形に置いた**(V3-FIX-02。冒頭 doc)。
 *
 * - **表に無いプラットフォームでは緑にしない。** 実測して1行足し、`docs/plan/v3/records/`
 *   に記録すること。**「たぶん同じだろう」で足さない。**
 * - **値が動いたら赤くなる。** chromium が既定リング色を変えたとき、あるいは実行環境が
 *   変わったときに、**黙って通らない**(この検査の元々の狙い。V3-M1-T01 §7-4)。
 *
 * **キーは `process.platform`(= ブラウザを走らせているホストの OS)である。ブラウザが
 * 名乗るプラットフォームではない。** **理由は実測である**(2026-07-27 / V3-FIX-02):
 * `web/e2e/playwright.config.ts` が `devices["Desktop Chrome"]` を使っており、**その
 * デバイス記述子は Windows の userAgent を被せる**ので、**macOS で走らせても
 * `navigator.userAgentData.platform` は `"Windows"` を返す。**
 * **一方 `-webkit-focus-ring-color` は実際のホスト OS(macOS)の値 `rgb(0, 95, 204)` を
 * 返す** —— **つまりブラウザが名乗る素性と、ブラウザが実際に使うテーマの素性は食い違う。**
 * この表を `navigator` 側で引くと、macOS と Linux が同じキーに落ちて**表が意味を失う。**
 */
const OBSERVED_UA_FOCUS_RING_COLOR: Readonly<Record<string, string>> = {
  // macOS は OS のアクセントカラーを `-webkit-focus-ring-color` に流す唯一のプラットフォーム
  // である(chromium)。既定のアクセントカラー(青)での実測値。
  darwin: "rgb(0, 95, 204)",
  // Linux には OS のアクセントカラーの経路が無く、chromium の固定値(`#101010`)になる。
  linux: "rgb(16, 16, 16)",
};

test.describe("V3-M1-T01 スロットの既定値(chromium 実測)", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "UA 既定値とシステム色の実測は chromium の値を期待値にしている",
  );

  test("ページ地色と本文文字色が body に宣言され、地色は透明から不透明に変わっている", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    // 未認証のままアプリを開くとログイン画面になる(`.login` / `input` / `button` が揃う)。
    await page.goto(`/apps/${app.appId}`);
    await expect(page.getByTestId("login-page")).toBeVisible();

    const body = await computed(page, "body", [
      "background-color",
      "color",
      "font-family",
      "line-height",
    ]);

    // **変わった軸**: UA 既定は `rgba(0, 0, 0, 0)`(透明)だった。
    expect(body["background-color"]).toBe("rgb(255, 255, 255)");
    // **変わらない軸**: UA 既定の `rgb(0, 0, 0)` と同値を宣言している。
    expect(body.color).toBe("rgb(0, 0, 0)");
    // V3-M0-T04 から引き継いだ2件(名前だけ変えた)。値が動いていないことの確認。
    expect(body["font-family"]).toBe("system-ui, sans-serif");
    expect(body["line-height"]).toBe("25.6px"); // 16px * 1.6
  });

  test("角丸と影は UA 既定と同値なので、宣言しても描画が変わらない", async ({ page, request }) => {
    const app = await provisionApp(request);
    await page.goto(`/apps/${app.appId}`);
    await expect(page.getByTestId("login-page")).toBeVisible();

    // 角丸スロットが当たる要素(`button, input, select, textarea`)。
    const input = await computed(page, '[data-testid="auth-username"]', [
      "border-top-left-radius",
      "border-bottom-right-radius",
    ]);
    // **【V4-M15 では変えなかった】** 角丸の既定値を変える案は `src/mcp/vocabulary.ts` の
    // 段階表と結び付いており、`ADR-0087` 限定1(`src/` に1バイトも触らない)と両立しない。
    // **着手前の値のまま 0px である。**
    expect(input["border-top-left-radius"]).toBe("0px");
    expect(input["border-bottom-right-radius"]).toBe("0px");

    const button = await computed(page, '[data-testid="passkey-login"]', [
      "border-top-left-radius",
      "border-bottom-right-radius",
    ]);
    expect(button["border-top-left-radius"]).toBe("0px");
    expect(button["border-bottom-right-radius"]).toBe("0px");

    // スロットが当たっていない要素は `0px` のままである(角丸の当たり先は増えていない)。
    const section = await computed(page, ".login", ["border-top-left-radius", "box-shadow"]);
    expect(section["border-top-left-radius"]).toBe("0px");
    // **【V4-M15 では変えなかった】** 影の既定値も同じ理由で着手前のままである。
    expect(section["box-shadow"]).toBe("none");

    // 寸法・余白スロットが V3-M0-T04 と同じ値に解決していること(束ねで動いていない)。
    const shell = await computed(page, ".shell", ["padding-top", "max-width"]);
    // **【V4-M15-T07 で期待値を書き換えた。16px → 32px】**
    // `.shell` の余白に幅の条件を足した(ADR-0089 / D-V4-44)。**断点は2本だけである** ——
    // 既定 `--space-2`(8px)/ 40rem 以上 `--space-4`(16px)/ 64rem 以上 `--space-6`(32px)。
    // **playwright の既定ビューポートは Desktop Chrome = 1280×720 なので 64rem 以上に当たる。**
    expect(shell["padding-top"]).toBe("32px"); // --space-6 = 2rem(64rem 以上)
    expect(shell["max-width"]).toBe("960px"); // --shell-max-width = 60rem
    const login = await computed(page, ".login", ["max-width", "margin-top"]);
    expect(login["max-width"]).toBe("352px"); // --login-max-width = 22rem
    expect(login["margin-top"]).toBe("32px"); // --space-6 = 2rem
  });

  test("アウトラインは :focus-visible のときだけ立ち、UA の auto 1px から solid 2px に変わる", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await page.goto(`/apps/${app.appId}`);
    await expect(page.getByTestId("login-page")).toBeVisible();

    // 非フォーカス時: 無条件セレクタに書いていないので UA 既定の `none` のまま。
    const idle = await computed(page, '[data-testid="auth-username"]', [
      "outline-style",
      "outline-width",
    ]);
    expect(idle["outline-style"]).toBe("none");

    // キーボードでフォーカスすると `:focus-visible` が立つ。
    await page.getByTestId("auth-username").focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");

    const focused = await page.evaluate(() => {
      const element = document.activeElement;
      if (element === null) throw new Error("フォーカス要素が無い");
      const style = getComputedStyle(element);
      return {
        testid: element.getAttribute("data-testid"),
        focusVisible: element.matches(":focus-visible"),
        width: style.outlineWidth,
        style: style.outlineStyle,
        color: style.outlineColor,
      };
    });

    expect(focused.testid).toBe("auth-username");
    expect(focused.focusVisible).toBe(true);
    // **変わった軸**: UA 既定は `auto` / `1px` だった。
    // 著者が `outline: auto` と書いても UA の値には戻らない(`rgb(0,0,0) auto 3px` になる)ので、
    // 明示の値を置いている。
    expect(focused.style).toBe("solid");
    expect(focused.width).toBe("2px");
    // **色は環境に依らずこの値である**(`styles.css` の `--focus-outline-color` のリテラル)。
    // **【2026-07-27 V3-FIX-02 で書き直した】** ここには元々「(色は同じ `rgb(0, 95, 204)`)」
    // と書いてあったが、**それは macOS 限定の話だった** —— UA のフォーカスリング色は
    // 環境依存で、Linux の chromium では `rgb(16, 16, 16)` である(実測)。**つまり Linux では
    // この宣言は色も変えている。** 環境依存であることは最後のテストが固定する。
    expect(focused.color).toBe("rgb(0, 95, 204)");
  });

  test("意味の名前に移した既存スロットが、V3-M0-T04 と同じ色に解決している", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await app.authenticate(page.context());
    await page.goto(`/apps/${app.appId}`);
    await expect(page.getByTestId("view-list")).toBeVisible();

    // `--color-text-secondary`(旧 `--color-666` の5宣言ぶん)。
    const currentUser = await computed(page, ".app-header .current-user", ["color"]);
    expect(currentUser.color).toBe("rgb(102, 102, 102)");
    const meta = await computed(page, ".view-list .meta", ["color", "font-size"]);
    expect(meta.color).toBe("rgb(102, 102, 102)");
    expect(meta["font-size"]).toBe("13.6px"); // 0.85em(親 16px)

    // `--border-width` / `--border-style` / `--color-border`(枠線の強さの軸)。
    const header = await computed(page, ".shell header", [
      "border-bottom-width",
      "border-bottom-style",
      "border-bottom-color",
    ]);
    expect(header["border-bottom-width"]).toBe("1px");
    expect(header["border-bottom-style"]).toBe("solid");
    expect(header["border-bottom-color"]).toBe("rgb(221, 221, 221)");
  });

  test("既定値の根拠にしたシステム色を固定する —— Canvas / CanvasText は2環境で同値・UA のフォーカスリング色は環境依存(実測)", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await page.goto(`/apps/${app.appId}`);
    await expect(page.getByTestId("login-page")).toBeVisible();

    // **要素の `background-color` の UA 既定は透明**なので、地色の既定値は
    // 「ブラウザのキャンバスの色」から採るしかない。それをシステム色として実測する。
    // あわせて **製品が宣言している `--focus-outline-color` をブラウザに解決させた値**も
    // 読む —— UA の色と宣言の色を、同じ場所で同じ形(`rgb(…)`)にして突き合わせるためである。
    const system = await page.evaluate(() => {
      const probe = document.createElement("span");
      document.body.appendChild(probe);
      const read = (value: string): string => {
        probe.style.color = value;
        return getComputedStyle(probe).color;
      };
      const canvas = read("Canvas");
      const canvasText = read("CanvasText");
      const declaredFocusOutline = read(
        getComputedStyle(document.documentElement).getPropertyValue("--focus-outline-color").trim(),
      );
      probe.style.color = "";
      probe.style.outlineStyle = "solid";
      probe.style.outlineColor = "-webkit-focus-ring-color";
      const focusRing = getComputedStyle(probe).outlineColor;
      probe.remove();
      // **ブラウザが名乗るプラットフォーム。判定には使わない**(`devices["Desktop Chrome"]`
      // が Windows の userAgent を被せるので、macOS でも `"Windows"` を返す。実測)。
      // **食い違いを見える形にするために読むだけである** —— 期待値は `process.platform` で引く。
      const browserPlatform =
        (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
          ?.platform ?? navigator.platform;
      return { canvas, canvasText, declaredFocusOutline, focusRing, browserPlatform };
    });
    // **ホストの OS**(`"darwin"` / `"linux"` / `"win32"`)。上表のキーである。
    const platform = process.platform;

    // ---------------------------------------------------------------------
    // (1) 環境に依らないと**実測できた**2つ —— 値そのものを固定する。
    // ---------------------------------------------------------------------
    // `--color-page-background: #fff` の根拠。**macOS / Linux の chromium で同値**
    // (Linux 側の実測は 2026-07-27 の実 CI。V3-FIX-02)。
    expect(system.canvas).toBe("rgb(255, 255, 255)");
    // `--color-text: #000` の根拠。同上。
    expect(system.canvasText).toBe("rgb(0, 0, 0)");

    // ---------------------------------------------------------------------
    // (2) 環境依存だと**実測で分かった**1つ —— 期待値をプラットフォーム別の実測表から引く。
    // ---------------------------------------------------------------------
    // **`#005fcc` は「UA のフォーカスリング色そのもの」ではない。** その主張は macOS でしか
    // 真でなかった(Linux では UA のリング色は `rgb(16, 16, 16)`)。**主張を実態に合わせて
    // 書き直したのであって、赤を消すために期待値を緩めたのではない** —— 表に無い環境では
    // 落ちるし、表の値が動いても落ちる。
    const expectedFocusRing = OBSERVED_UA_FOCUS_RING_COLOR[platform];
    if (expectedFocusRing === undefined) {
      throw new Error(
        `UA のフォーカスリング色を実測していないホスト OS "${platform}" である。` +
          `実測値は "${system.focusRing}" だった。` +
          "OBSERVED_UA_FOCUS_RING_COLOR に1行足し、docs/plan/v3/records/ に実測として記録すること。" +
          "**この表は「どこでも同じ値」という主張ではなく、環境ごとの実測の台帳である。**",
      );
    }
    expect(system.focusRing).toBe(expectedFocusRing);

    // **ブラウザが名乗るプラットフォームは、上の判定の根拠にならない**(実測。冒頭 doc)。
    // `devices["Desktop Chrome"]` が Windows の userAgent を被せるので、**ホストが macOS でも
    // Linux でもブラウザは同じ `"Windows"` を名乗る** —— それでも UA のリング色は違う。
    // **この食い違いを固定しておく**(将来デバイス記述子を変えたら赤くなり、上の判定を
    // `navigator` 側で引き直してよいかを人間が考えることになる)。
    expect(system.browserPlatform).toBe("Windows");

    // ---------------------------------------------------------------------
    // (3) 本テストが今日いちばん守りたいこと —— **製品の宣言は環境に依存しない。**
    // ---------------------------------------------------------------------
    // `--focus-outline-color: #005fcc` をブラウザに解決させた値。**どの環境でも同じ**である
    // (`styles.css` のリテラルなので UA には追随しない)。実ページのフォーカス時の
    // `outline-color` が同じ値になることは、3本目のテストが両環境で固定している。
    expect(system.declaredFocusOutline).toBe("rgb(0, 95, 204)");
    // **宣言の色が UA のリング色と一致するのは macOS だけである。** = V3-M1-T01 の
    // 「色は UA と一致させた」は macOS 限定の主張だった。**Linux ではこの製品の宣言は、
    // リングの太さと種別だけでなく色も変えている。** 別の環境で一致するようになったら
    // (あるいは macOS で一致しなくなったら)ここが赤くなり、根拠を書き直すことになる。
    expect(system.declaredFocusOutline === system.focusRing).toBe(platform === "darwin");
  });
});
