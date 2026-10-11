/**
 * テーマの持ち出し口(`theme.css`)のテスト(V3-M1-T05 / D-G3b。**門外 Δ7**)。
 *
 * 完了条件の正は `docs/plan/v3/records/v3-m1.md` §2 の「V3-M1-T05」節、審査の正は
 * `docs/plan/v3/records/v3-m1-gate-a-theme.md` §5(判定 = 将来送り / 帰属先 = 表示層)。
 *
 * ## 何を固定しているか
 *
 * 1. **生成規則は1本(写像 `web/src/theme-role-map.ts`)である**(T05-4 / V20-M8 / ADR-0473)——
 *    出てくる宣言名の集合は `schemas/manifest.schema.json` の `$defs/theme` の properties キー
 *    (役割名)を写像に通した CSS 名の集合と**完全一致**する。**2本目の変換規則を作ると赤になる。**
 *    `web/test/theme-slot-parity.test.ts` と製品経路(`web/test/app-theme.test.tsx`)が
 *    見ているのと**同一の写像**である。
 * 2. **カーネルの値を1つも import しない**(ADR-0009 限定2 / `scripts/kernel-import-drift.test.ts`)
 *    —— 生成はマニフェストのキーから組み立てる。ここで読むのは**スキーマのファイル**だけである。
 * 3. **持ち出し物が自分の限界を明記している**(T05-5 / T05-6)—— 逃げ道(D-G5)を含まないこと・
 *    `:root` に当てるだけでは同じ描画にならないことが、生成物そのものに書かれている。
 * 4. **コピーである**(T05-4。ダウンロードではない)。先例は `web/src/RequirementsDocPanel.tsx`。
 *
 * ## このファイルが証明しないこと(誇張しない)
 *
 * - **別実装での見た目の一致は1つも証明していない。** 担保できるのは形式の安定までである
 *   (審査記録 §5 S3-2。D-3 の文言「別実装での再利用を担保する」をそのまま満たしたとは書かない)。
 * - **`theme.json` の側はここで扱わない。** 案#1 は `get_manifest` の出力そのものであり、
 *   追加実装が0件である(T05-3)。往復の実測は `web/test/theme-template.test.ts` にある。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Manifest, Theme } from "../../src/kernel/types.ts";
import { App } from "../src/App.tsx";
import { buildThemeCss, ThemeExportPanel } from "../src/ThemeExportPanel.tsx";
import { THEME_ROLE_TO_CSS_PROPERTY } from "../src/theme-role-map.ts";

const APP_ID = "sample-app";
const REPO_ROOT = dirname(dirname(import.meta.dir));
const MANIFEST_SCHEMA_PATH = join(REPO_ROOT, "schemas", "manifest.schema.json");

/**
 * `$defs/theme` の properties キー(**ファイルとして読む**。ADR-0009 限定2)。
 * `web/test/app-theme.test.tsx` / `web/test/theme-slot-parity.test.ts` と同じ読み方である。
 */
function themeSlotNames(): string[] {
  const schema = JSON.parse(readFileSync(MANIFEST_SCHEMA_PATH, "utf-8")) as {
    $defs: { theme: { properties: Record<string, unknown> } };
  };
  return Object.keys(schema.$defs.theme.properties);
}

/** スロット名(役割名)が写る CSS カスタムプロパティ名。**写像の表から引く**(書き下さない)。 */
function cssNameOf(slot: string): string {
  const name = THEME_ROLE_TO_CSS_PROPERTY[slot];
  if (name === undefined) throw new Error(`写像に無いスロット: ${slot}`);
  return name;
}

/**
 * 25スロット全部に値を書いたテーマ(`$defs/theme` は全キー `required`)。
 *
 * **色かどうかは写像の CSS 名で判定する**(V20-M8)。キーは役割名なので、キーの綴りで
 * 判定すると1件も当たらず黙って意味を失う。
 */
function sampleTheme(origin?: Theme["origin"]): Theme {
  const slots: Record<string, string> = {};
  for (const slot of themeSlotNames()) {
    const css = cssNameOf(slot);
    slots[slot] = css.startsWith("--color") || css.endsWith("-color") ? "#123456" : "7px";
  }
  slots.body_font = "Georgia, serif";
  slots.body_line_height = "2";
  slots.surface_shadow = "none";
  const theme: Theme = { slots };
  if (origin !== undefined) {
    theme.origin = origin;
  }
  return theme;
}

/** 生成物の `:root { … }` ブロックの中の宣言を (名前, 値) に割る。 */
function declarationsOf(css: string): { name: string; value: string }[] {
  const block = /:root\s*\{([\s\S]*?)\}/.exec(css);
  if (block === null) {
    throw new Error(`:root ブロックが無い:\n${css}`);
  }
  const out: { name: string; value: string }[] = [];
  for (const chunk of (block[1] ?? "").split(";")) {
    const text = chunk.trim();
    if (text === "") continue;
    const colon = text.indexOf(":");
    if (colon < 0) {
      throw new Error(`宣言として読めない断片: ${text}`);
    }
    out.push({ name: text.slice(0, colon).trim(), value: text.slice(colon + 1).trim() });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 生成規則(写像1本)
// ---------------------------------------------------------------------------

describe("theme.css の生成規則(T05-4。変換規則は写像1本だけ)", () => {
  test("宣言名の集合が $defs/theme の properties キーを写像に通した CSS 名の集合と完全一致する", () => {
    const theme = sampleTheme();
    const declarations = declarationsOf(buildThemeCss(theme));

    expect(declarations.map((d) => d.name).sort()).toEqual(themeSlotNames().map(cssNameOf).sort());
    // 25件ちょうど。**多くも少なくもない**(テーマ対象外の3スロットは入らない)。
    // 【V20-M9 / ADR-0474】25 → 23(2枠 --detail-label-width / --login-max-width を語彙から外した)。旧(逐語): expect(declarations).toHaveLength(25);
    // 【V20-M9 / ADR-0474】23 → 27(4枠 primary_fill / on_primary / overlay_background / overlay_text を足した)。旧(逐語): expect(declarations).toHaveLength(23);
    expect(declarations).toHaveLength(27);
    // 名前は CSS カスタムプロパティ名である(役割名のまま出していない)。
    for (const declaration of declarations) {
      expect(declaration.name).toMatch(/^--[a-z][a-z0-9-]*$/);
    }
    // 色の枠(CSS 名で判定)に色の値が入っている(判定が空回りしていない)。
    const colors = declarations.filter(
      (d) => d.name.startsWith("--color") || d.name.endsWith("-color"),
    );
    expect(colors.length).toBeGreaterThan(0);
    for (const declaration of colors) {
      expect(declaration.value).toBe("#123456");
    }
  });

  test("値はマニフェストの値そのままである(加工しない)", () => {
    const theme = sampleTheme();
    const byName = new Map(declarationsOf(buildThemeCss(theme)).map((d) => [d.name, d.value]));
    for (const [slot, value] of Object.entries(theme.slots)) {
      expect(byName.get(cssNameOf(slot))).toBe(value);
    }
    expect(byName.get(cssNameOf("body_font"))).toBe("Georgia, serif");
    expect(byName.get(cssNameOf("body_line_height"))).toBe("2");
  });

  test("並びは CSS 名の昇順で、キーの並び順に依存しない(生成物が一意に決まる)", () => {
    const theme = sampleTheme();
    const reversed: Theme = {
      slots: Object.fromEntries(Object.entries(theme.slots).reverse()),
    };
    expect(buildThemeCss(reversed)).toBe(buildThemeCss(theme));

    const names = declarationsOf(buildThemeCss(theme)).map((d) => d.name);
    expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  test("スロットが0件でも例外を投げず、宣言が0件のブロックを出す(嘘をつかない)", () => {
    // **カーネルは部分テーマを許さない**(`$defs/theme` は全キー required)が、
    // この関数は与えられたものをそのまま写すだけで、検証を二重化しない
    // (`web/src/AppWorkspace.tsx` の `themeScopeStyle` と同じ判断)。
    expect(declarationsOf(buildThemeCss({ slots: {} }))).toEqual([]);
  });

  test("【V20-M9-T02 / ADR-0474 §1-6】生の色は --palette-… の宣言として出て、参照は var(--palette-…) のまま出る(解かない)", () => {
    const theme = sampleTheme();
    theme.slots.palette_brand = "#1d4ed8";
    theme.slots.palette_ocean_700 = "$palette_brand";
    theme.slots.primary_fill = "$palette_ocean_700";
    const css = buildThemeCss(theme);
    const byName = new Map(declarationsOf(css).map((d) => [d.name, d.value]));
    expect(css).toContain("--palette-brand:");
    expect(byName.get("--palette-brand")).toBe("#1d4ed8");
    // 生の色どうしの参照も、役割の枠の参照も、CSS の変数参照へ写すだけ(表示層は解決器を呼ばない)。
    expect(byName.get("--palette-ocean-700")).toBe("var(--palette-brand)");
    expect(byName.get(cssNameOf("primary_fill"))).toBe("var(--palette-ocean-700)");
    expect(css).toContain("var(--palette-brand)");
    // 参照の綴りそのもの($palette_…)は生成物に残らない。
    expect(css).not.toContain("$palette_");
  });
});

// ---------------------------------------------------------------------------
// 持ち出し物が自分の限界を明記していること
// ---------------------------------------------------------------------------

describe("持ち出し物の注記(T05-5 / T05-6。**生成物そのものに書く**)", () => {
  // **【V3-M5-T05 / ADR-0055 で改訂】** 旧テスト名は「その**置き場が未確定である**ことを
  // 書いている」だった。**V3-M5-T01〜T03 で逃げ道が実在するようになり、置き場も確定した**ので、
  // **固定していた主張のほうが偽になった。** **「テストが赤くなったから直した」のではない** ——
  // このテストは `toContain("逃げ道")` / `toContain("V3-M5")` しか見ていないので**今日も緑である。**
  // **実装によって文言が偽になったので、文言(`ThemeExportPanel.tsx` の生成物)とテスト
  // (名前と意図)を同時に直した。** **弱めていない** —— 「含まれない」という本題は残し、
  // **理由の側だけを今日の実測に合わせたうえで、旧文言の復活を赤にする逆向きの固定を足した。**
  test("逃げ道(任意 CSS)を含まないことと、その本文がマニフェストの外にあることを書いている", () => {
    const css = buildThemeCss(sampleTheme());
    expect(css).toContain("逃げ道");
    expect(css).toContain("V3-M5");
    // 実装→記述: 含まれない理由(本文がマニフェストの外にある)が書かれている。
    expect(css).toContain("マニフェストの外");
    // 逆向き: 「逃げ道は存在しない」という旧文言が書き戻されたら赤くする。
    expect(css).not.toContain("逃げ道そのものが存在しない");
    expect(css).not.toContain("置き場が未確定");
  });

  test(":root に当てるだけでは同じ描画にならないことを書いている(T04 の申し送り)", () => {
    const css = buildThemeCss(sampleTheme());
    expect(css).toContain("同じ描画にはならない");
    // 含まれない6件(スコープ要素の再宣言4件 + フォームコントロールの inherit 2件)。
    expect(css).toContain("font-family: inherit");
    expect(css).toContain("line-height: inherit");
  });

  test("出所がマニフェストの JSON Pointer で書かれている(案#1 との対応)", () => {
    expect(buildThemeCss(sampleTheme())).toContain("/app/theme/slots");
  });

  test("由来(origin)は自己申告であることを添えて書く / 無ければ無いと書く", () => {
    const withOrigin = buildThemeCss(
      sampleTheme({ template_app_id: "org-theme", template_diff_id: "d-0007" }),
    );
    expect(withOrigin).toContain("org-theme");
    expect(withOrigin).toContain("d-0007");
    expect(withOrigin).toContain("自己申告");

    const withoutOrigin = buildThemeCss(sampleTheme());
    expect(withoutOrigin).toContain("由来: 記録なし");
    expect(withoutOrigin).not.toContain("org-theme");
  });

  test("生成物は CSS として壊れない(コメントの閉じ忘れ・ブロックの数)", () => {
    const css = buildThemeCss(
      sampleTheme({ template_app_id: "org-theme", template_diff_id: "d-0007" }),
    );
    expect((css.match(/\/\*/g) ?? []).length).toBe((css.match(/\*\//g) ?? []).length);
    expect((css.match(/\{/g) ?? []).length).toBe(1);
    expect((css.match(/\}/g) ?? []).length).toBe(1);
    expect(css.endsWith("\n")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 取り出し口(パネル。コピーである)
// ---------------------------------------------------------------------------

/** `navigator.clipboard.writeText` に渡された文字列。 */
let copied: string[];
let originalClipboard: PropertyDescriptor | undefined;

function stubClipboard(): void {
  copied = [];
  originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: (text: string) => {
        copied.push(text);
        return Promise.resolve();
      },
    },
  });
}

function restoreClipboard(): void {
  if (originalClipboard === undefined) {
    Reflect.deleteProperty(navigator, "clipboard");
  } else {
    Object.defineProperty(navigator, "clipboard", originalClipboard);
  }
}

describe("ThemeExportPanel(取り出し口。先例は RequirementsDocPanel のコピー)", () => {
  beforeEach(stubClipboard);
  afterEach(() => {
    cleanup();
    restoreClipboard();
  });

  test("生成した theme.css がそのまま画面に出る", () => {
    const theme = sampleTheme();
    render(<ThemeExportPanel theme={theme} />);
    expect(screen.getByTestId("theme-css").textContent).toBe(buildThemeCss(theme));
  });

  test("コピーボタンで生成物と1バイト違わない文字列がクリップボードへ渡る", async () => {
    const theme = sampleTheme({ template_app_id: "org-theme" });
    render(<ThemeExportPanel theme={theme} />);

    fireEvent.click(screen.getByTestId("copy-theme-css"));
    await waitFor(() => expect(screen.getByTestId("copy-theme-css-result")).toBeDefined());
    expect(copied).toEqual([buildThemeCss(theme)]);
    expect(screen.getByTestId("copy-theme-css-result").textContent).toContain("コピーしました");
  });

  test("クリップボードが無い環境では失敗として出す(黙って隠さない)", async () => {
    // **`Reflect.deleteProperty` では消えない** —— happy-dom は `Navigator` の
    // プロトタイプに `clipboard` の getter を持っており、自前のプロパティを消すと
    // それが再び見えるようになる(実測)。したがって「無い」状態は
    // `value: undefined` の自前プロパティで作る。
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    render(<ThemeExportPanel theme={sampleTheme()} />);

    fireEvent.click(screen.getByTestId("copy-theme-css"));
    await waitFor(() => expect(screen.getByTestId("copy-theme-css-result")).toBeDefined());
    expect(screen.getByTestId("copy-theme-css-result").textContent).toContain(
      "コピーできませんでした",
    );
  });

  test("クリップボードへの書き込みが失敗した場合も失敗として出す", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("拒否された")) },
    });
    render(<ThemeExportPanel theme={sampleTheme()} />);

    fireEvent.click(screen.getByTestId("copy-theme-css"));
    await waitFor(() => expect(screen.getByTestId("copy-theme-css-result")).toBeDefined());
    expect(screen.getByTestId("copy-theme-css-result").textContent).toContain(
      "コピーできませんでした",
    );
  });

  test("テーマを持たないアプリでは、無いと明示してコピーボタンを出さない", () => {
    render(<ThemeExportPanel />);
    expect(screen.getByTestId("theme-export-empty")).toBeDefined();
    expect(screen.queryByTestId("theme-css")).toBeNull();
    expect(screen.queryByTestId("copy-theme-css")).toBeNull();
  });

  test("閉じるボタンは渡されたときだけ出る(RequirementsDocPanel と同じ作法)", () => {
    render(<ThemeExportPanel theme={sampleTheme()} />);
    expect(screen.queryByTestId("close-theme-export")).toBeNull();
    cleanup();

    let closed = 0;
    render(<ThemeExportPanel theme={sampleTheme()} onClose={() => (closed += 1)} />);
    fireEvent.click(screen.getByTestId("close-theme-export"));
    expect(closed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 導線(AppWorkspace から開ける)
// ---------------------------------------------------------------------------

function sampleManifest(theme?: Theme): Manifest {
  const manifest: Manifest = {
    app: {
      id: APP_ID,
      name: "サンプル",
      tables: [
        {
          id: "entries",
          name: "エントリ",
          fields: [{ id: "label", name: "ラベル", type: "text", required: true }],
        },
      ],
      views: [
        {
          id: "entry-list",
          name: "エントリ一覧",
          type: "list_view",
          table: "entries",
          columns: ["label"],
        },
      ],
    },
  };
  if (theme !== undefined) {
    manifest.app.theme = theme;
  }
  return manifest;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("導線(AppWorkspace のビュー一覧と同じ階層。ロールで出し分けない)", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    stubClipboard();
    originalFetch = globalThis.fetch;
    window.history.replaceState({}, "", `/apps/${APP_ID}`);
  });

  afterEach(() => {
    cleanup();
    restoreClipboard();
    globalThis.fetch = originalFetch;
    window.history.replaceState({}, "", "/");
  });

  function stub(theme?: Theme): void {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input).split("?")[0] ?? "";
      if (url === `/api/apps/${APP_ID}/auth/me`) {
        return Promise.resolve(
          jsonResponse({ user: { id: "u1", username: "alice", displayName: null, role: "owner" } }),
        );
      }
      if (url === `/api/apps/${APP_ID}/manifest`) {
        return Promise.resolve(jsonResponse(sampleManifest(theme)));
      }
      return Promise.resolve(jsonResponse({ errors: [{ path: "", message: url }] }, 404));
    }) as typeof fetch;
  }

  test("ボタンを押すとパネルが開き、マニフェストのテーマがそのまま出る", async () => {
    const theme = sampleTheme({ template_app_id: "org-theme", template_diff_id: "d-0007" });
    stub(theme);
    render(<App />);

    await waitFor(() => expect(screen.getByTestId("open-theme-export")).toBeDefined());
    fireEvent.click(screen.getByTestId("open-theme-export"));

    await waitFor(() => expect(screen.getByTestId("theme-export")).toBeDefined());
    // **第2の取得経路を作っていない** —— パネルは既に取得済みのマニフェストの値を読むだけである。
    expect(screen.getByTestId("theme-css").textContent).toBe(buildThemeCss(theme));

    fireEvent.click(screen.getByTestId("close-theme-export"));
    await waitFor(() => expect(screen.getByTestId("view-list")).toBeDefined());
  });

  test("テーマを持たないアプリでもボタンは出て、無いことが分かる", async () => {
    stub();
    render(<App />);

    await waitFor(() => expect(screen.getByTestId("open-theme-export")).toBeDefined());
    fireEvent.click(screen.getByTestId("open-theme-export"));
    await waitFor(() => expect(screen.getByTestId("theme-export-empty")).toBeDefined());
  });
});

// 【V20-M9-T05】持ち出した theme.css の頭書きの「スロットは有限で、増やすことはできない。」は、
// 生の色(palette_…)を開けた V20-M9 で偽になった(役割の枠は増やせないが、生の色は名前を付けて足せる)。
test("V20-M9: theme.css の頭書きは「スロットは有限」と言い切らず、役割の枠と生の色を分けて書く", () => {
  const css = buildThemeCss(sampleTheme());
  expect(css).not.toContain("スロットは有限で、増やすことはできない。");
  expect(css).toContain("役割の枠は決まった名前だけで、増やすことはできない。");
  expect(css).toContain("palette_");
});
