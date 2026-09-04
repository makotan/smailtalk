/**
 * テーマの持ち出し口(`theme.css`)のテスト(V3-M1-T05 / D-G3b。**門外 Δ7**)。
 *
 * 完了条件の正は `docs/plan/v3/records/v3-m1.md` §2 の「V3-M1-T05」節、審査の正は
 * `docs/plan/v3/records/v3-m1-gate-a-theme.md` §5(判定 = 将来送り / 帰属先 = 表示層)。
 *
 * ## 何を固定しているか
 *
 * 1. **生成規則は1本(恒等写像)である**(T05-4)—— 出てくる宣言名の集合は
 *    `schemas/manifest.schema.json` の `$defs/theme` の properties キー集合と**完全一致**し、
 *    変換を1つも挟まない。**2本目の変換規則を作ると赤になる**(実測は実施記録 §TDD)。
 *    T03 段階B が `web/test/theme-slot-parity.test.ts` で定義し、T04 が製品経路
 *    (`web/test/app-theme.test.tsx`)で固定したのと**同一の規則**である。
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

/** 25スロット全部に値を書いたテーマ(`$defs/theme` は全キー `required`)。 */
function sampleTheme(origin?: Theme["origin"]): Theme {
  const slots: Record<string, string> = {};
  for (const slot of themeSlotNames()) {
    slots[slot] = slot.startsWith("--color") || slot.endsWith("-color") ? "#123456" : "7px";
  }
  slots["--font-family-base"] = "Georgia, serif";
  slots["--line-height-base"] = "2";
  slots["--surface-shadow"] = "none";
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
// 生成規則(恒等写像1本)
// ---------------------------------------------------------------------------

describe("theme.css の生成規則(T05-4。変換規則は T03 段階B の1本だけ)", () => {
  test("宣言名の集合が $defs/theme の properties キー集合と完全一致する(恒等写像)", () => {
    const theme = sampleTheme();
    const declarations = declarationsOf(buildThemeCss(theme));

    expect(declarations.map((d) => d.name).sort()).toEqual(themeSlotNames().sort());
    // 25件ちょうど。**多くも少なくもない**(テーマ対象外の3スロットは入らない)。
    expect(declarations).toHaveLength(25);
    // 名前は CSS カスタムプロパティ名そのもの(写しを1つも挟んでいない)。
    for (const declaration of declarations) {
      expect(declaration.name).toMatch(/^--[a-z][a-z0-9-]*$/);
    }
  });

  test("値はマニフェストの値そのままである(加工しない)", () => {
    const theme = sampleTheme();
    const byName = new Map(declarationsOf(buildThemeCss(theme)).map((d) => [d.name, d.value]));
    for (const [slot, value] of Object.entries(theme.slots)) {
      expect(byName.get(slot)).toBe(value);
    }
    expect(byName.get("--font-family-base")).toBe("Georgia, serif");
    expect(byName.get("--line-height-base")).toBe("2");
  });

  test("並びはスロット名の昇順で、キーの並び順に依存しない(生成物が一意に決まる)", () => {
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
