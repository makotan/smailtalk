/**
 * **明暗のモードと、テーマの器・スイッチの結び付き**(`V20-M10-T03`。計画 §9-3 の 3 / 4、
 * §10 の 5、ユーザ決定 `D-V20-31` / `D-V20-32` / `D-V20-33`)。
 *
 * ## 何を固定しているか
 *
 * 1. **暗い側の組 `slots_dark` を持つテーマ**: 効いているモードが暗いとき、器(`data-testid="app-theme"`)に
 *    `slots_dark` を同じ写像で立てる。明るいときは `slots`。
 * 2. **`slots_dark` を持たないテーマ**(`D-V20-31`): そのアプリを開いている間は `<html>` を明るく強制し、
 *    スイッチを出さない。記憶は書き換えない。離れたら戻す。
 * 3. **テーマを持たないアプリ**: スイッチを出す(既定の暗い値は CSS が受け持つ)。
 * 4. **スイッチは各アプリの上端の帯(`app-header`)**。持ち主の画面(`AppWorkspace`)と利用者向け
 *    (`runner-app`)の両方。**アプリ一覧とログイン画面には出さない**(`D-V20-33`)。
 *    **【V20-M10-T05。上の2行を消していない】ログインせずに開ける画面(公開の画面)の帯にも出す**
 *    (メインの裁定)。右寄せはスイッチ自身のクラス `ml-auto`。
 * 5. **取り込みの事前表示(`theme-import-preview`)からは強制を呼ばない**(計画 §10 の 5)。
 *
 * ## 証明しないこと(誇張しない)
 *
 * - **色が実際に変わることは証明しない**(happy-dom は CSS を解かない)。計算値は
 *   `web/e2e/color-scheme.e2e.ts` が chromium で測る。
 * - happy-dom の OS の設定は明るい側に固定である。ここでは暗い側を「覚えた値」で作る。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Manifest, Theme } from "../../src/kernel/types.ts";
import { App } from "../src/App.tsx";
import { AppThemeScope } from "../src/AppWorkspace.tsx";
import {
  applyInitialColorScheme,
  COLOR_SCHEME_STORAGE_KEY,
  colorSchemeController,
} from "../src/color-scheme.ts";
import { RunnerShell } from "../src/runner-app.tsx";
import { THEME_ROLE_TO_CSS_PROPERTY } from "../src/theme-role-map.ts";

const APP_ID = "sample-app";
const meUrl = `/api/apps/${APP_ID}/auth/me`;
const manifestUrl = `/api/apps/${APP_ID}/manifest`;

/** 27枠の全部に値を書いたテーマの組(色は `color`、長さは `7px`)。 */
function slotsWith(color: string): Record<string, string> {
  const slots: Record<string, string> = {};
  for (const [role, css] of Object.entries(THEME_ROLE_TO_CSS_PROPERTY)) {
    slots[role] = css.startsWith("--color") || css.endsWith("-color") ? color : "7px";
  }
  slots.body_font = "Georgia, serif";
  slots.body_line_height = "2";
  slots.surface_shadow = "none";
  return slots;
}

const LIGHT_ONLY_THEME: Theme = { slots: slotsWith("#111111") };
const WITH_DARK_THEME: Theme = { slots: slotsWith("#111111"), slots_dark: slotsWith("#eeeeee") };

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
  if (theme !== undefined) manifest.app.theme = theme;
  return manifest;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let originalFetch: typeof fetch;

function stub(routes: (url: string) => Response | undefined): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    const response = routes(url.split("?")[0] ?? url);
    return Promise.resolve(
      response ?? jsonResponse({ errors: [{ path: "", message: `no stub for ${url}` }] }, 404),
    );
  }) as typeof fetch;
}

function signedIn(theme?: Theme): void {
  stub((url) => {
    if (url === meUrl) {
      return jsonResponse({
        user: { id: "u1", username: "alice", displayName: null, role: "owner" },
      });
    }
    if (url === manifestUrl) return jsonResponse(sampleManifest(theme));
    if (url.startsWith(`/api/apps/${APP_ID}/tables/`))
      return jsonResponse({ records: [], total: 0 });
    return undefined;
  });
}

function signedOut(theme?: Theme): void {
  stub((url) => {
    if (url === meUrl) {
      return jsonResponse({ errors: [{ path: "", message: "認証されていません。" }] }, 401);
    }
    if (url === manifestUrl) return jsonResponse(sampleManifest(theme));
    return undefined;
  });
}

function remember(value: "light" | "dark" | null): void {
  if (value === null) window.localStorage.removeItem(COLOR_SCHEME_STORAGE_KEY);
  else window.localStorage.setItem(COLOR_SCHEME_STORAGE_KEY, value);
  // 入口で当てるのと同じ口(保存領域を読み直す)。V20-M10 点検 中1 の処置で apply() は読み直さなくなった。
  applyInitialColorScheme();
}

function htmlAttribute(): string | null {
  return document.documentElement.getAttribute("data-theme");
}

/** 器に立っている `--color-text` の値。 */
function scopeText(testId = "app-theme"): string | undefined {
  const style = screen.getByTestId(testId).getAttribute("style") ?? "";
  const match = /--color-text:\s*([^;]+)/.exec(style);
  return match?.[1]?.trim();
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  window.history.replaceState({}, "", `/apps/${APP_ID}`);
  remember(null);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.history.replaceState({}, "", "/");
  remember(null);
});

describe("前提(happy-dom の OS の設定は明るい側)", () => {
  test("覚えた値が無ければ明るい・属性なし", () => {
    expect(colorSchemeController().preferred()).toBe("light");
    expect(htmlAttribute()).toBeNull();
  });
});

describe("暗い側の組を持つテーマ(slots_dark)", () => {
  test("暗いときは slots_dark を、スイッチで明るくすると slots を器に立てる", async () => {
    remember("dark");
    signedIn(WITH_DARK_THEME);
    render(<App />);
    const toggle = await screen.findByTestId("color-scheme-toggle");
    expect(scopeText()).toBe("#eeeeee");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(htmlAttribute()).toBe("dark");

    fireEvent.click(toggle);
    await waitFor(() => expect(scopeText()).toBe("#111111"));
    expect(screen.getByTestId("color-scheme-toggle").getAttribute("aria-pressed")).toBe("false");
    // 反対(明るい)は OS(明るい)と同じなので、記憶を消して属性を外す(D-V20-32)。
    expect(window.localStorage.getItem(COLOR_SCHEME_STORAGE_KEY)).toBeNull();
    expect(htmlAttribute()).toBeNull();
  });

  test("明るいときは slots を立て、スイッチで暗くすると slots_dark になり、覚える", async () => {
    signedIn(WITH_DARK_THEME);
    render(<App />);
    const toggle = await screen.findByTestId("color-scheme-toggle");
    expect(scopeText()).toBe("#111111");
    fireEvent.click(toggle);
    await waitFor(() => expect(scopeText()).toBe("#eeeeee"));
    expect(window.localStorage.getItem(COLOR_SCHEME_STORAGE_KEY)).toBe("dark");
    expect(htmlAttribute()).toBe("dark");
  });

  test("器に立つ名前の集合は明るい側と同じ27件(写像は1本のまま)", async () => {
    remember("dark");
    signedIn(WITH_DARK_THEME);
    render(<App />);
    await screen.findByTestId("color-scheme-toggle");
    const style = screen.getByTestId("app-theme").getAttribute("style") ?? "";
    const names = [...style.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1]).sort();
    expect(names).toEqual(Object.values(THEME_ROLE_TO_CSS_PROPERTY).sort());
  });
});

describe("別タブで切り替えた後の無関係な再描画(V20-M10 点検 中1)", () => {
  test("保存領域を外から書き換えて描き直しても、スイッチの表示・器・<html> の属性が食い違わない", async () => {
    signedIn(WITH_DARK_THEME);
    const view = render(<App />);
    const toggle = await screen.findByTestId("color-scheme-toggle");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(scopeText()).toBe("#111111");
    expect(htmlAttribute()).toBeNull();

    // 別タブがスイッチを押した代わり(この制御を通さずに保存領域へ書く)。
    window.localStorage.setItem(COLOR_SCHEME_STORAGE_KEY, "dark");
    view.rerender(<App />);
    await screen.findByTestId("color-scheme-toggle");

    const after = screen.getByTestId("color-scheme-toggle");
    expect(after.getAttribute("aria-pressed")).toBe("false");
    expect(after.textContent).toContain("オフ");
    expect(scopeText()).toBe("#111111");
    expect(htmlAttribute()).toBeNull();
  });
});

describe("暗い側の組を持たないテーマ(D-V20-31)", () => {
  test("開いている間は <html> を明るく強制し、スイッチを出さず、記憶を書き換えない。離れたら戻す", async () => {
    remember("dark");
    signedIn(LIGHT_ONLY_THEME);
    const view = render(<App />);
    await screen.findByTestId("view-list");
    expect(screen.queryByTestId("color-scheme-toggle")).toBeNull();
    expect(htmlAttribute()).toBe("light");
    expect(scopeText()).toBe("#111111");
    expect(window.localStorage.getItem(COLOR_SCHEME_STORAGE_KEY)).toBe("dark");

    view.unmount();
    expect(htmlAttribute()).toBe("dark");
    expect(window.localStorage.getItem(COLOR_SCHEME_STORAGE_KEY)).toBe("dark");
  });

  test("ログイン画面でも明るく強制する(スイッチは出さない)", async () => {
    remember("dark");
    signedOut(LIGHT_ONLY_THEME);
    render(<App />);
    await screen.findByTestId("login-page");
    expect(htmlAttribute()).toBe("light");
    expect(screen.queryByTestId("color-scheme-toggle")).toBeNull();
  });

  test("取り込みの事前表示(theme-import-preview)は強制を呼ばない", () => {
    remember("dark");
    render(
      <AppThemeScope theme={LIGHT_ONLY_THEME} testId="theme-import-preview">
        <p>見本</p>
      </AppThemeScope>,
    );
    expect(htmlAttribute()).toBe("dark");
    expect(screen.getByTestId("theme-import-preview")).toBeDefined();
  });
});

describe("テーマを持たないアプリ", () => {
  test("スイッチを出し、器には何も立てない。押すと暗く覚える", async () => {
    signedIn();
    render(<App />);
    const toggle = await screen.findByTestId("color-scheme-toggle");
    expect(screen.getByTestId("app-theme").getAttribute("style")).toBeNull();
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(screen.getByTestId("color-scheme-toggle").getAttribute("aria-pressed")).toBe("true"),
    );
    expect(htmlAttribute()).toBe("dark");
    expect(window.localStorage.getItem(COLOR_SCHEME_STORAGE_KEY)).toBe("dark");
  });
});

describe("スイッチの置き場(D-V20-33)", () => {
  test("持ち主の画面ではアプリの上端の帯(app-header)の中に1つ。押せるボタンで、見える文字で状態が分かる", async () => {
    signedIn();
    render(<App />);
    const toggle = await screen.findByTestId("color-scheme-toggle");
    expect(screen.getAllByTestId("color-scheme-toggle")).toHaveLength(1);
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle.closest(".app-header")).not.toBeNull();
    expect(toggle.textContent).toContain("暗い表示");
    expect(toggle.textContent).toContain("オフ");
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(screen.getByTestId("color-scheme-toggle").textContent).toContain("オン"),
    );
  });

  test("ログイン画面には出さない(テーマを持たないアプリでも)", async () => {
    signedOut();
    render(<App />);
    await screen.findByTestId("login-page");
    expect(screen.queryByTestId("color-scheme-toggle")).toBeNull();
  });

  test("アプリ一覧には出さない", async () => {
    window.history.replaceState({}, "", "/");
    stub((url) => {
      if (url === "/api/apps") {
        return jsonResponse({
          apps: [
            {
              app_id: APP_ID,
              name: "サンプル",
              created_at: "2026-01-01T00:00:00Z",
              status: "active",
            },
          ],
        });
      }
      return undefined;
    });
    render(<App />);
    await screen.findByTestId("app-list");
    expect(screen.queryByTestId("color-scheme-toggle")).toBeNull();
  });

  test("利用者向けの画面(runner)でもアプリの上端の帯に出す", async () => {
    signedIn();
    render(<RunnerShell appId={APP_ID} />);
    const toggle = await screen.findByTestId("color-scheme-toggle");
    expect(toggle.closest(".app-header")).not.toBeNull();
    expect(screen.getAllByTestId("color-scheme-toggle")).toHaveLength(1);
  });

  test("利用者向けの画面(runner)でも、slots_dark を持たないテーマならスイッチを出さず明るく強制する", async () => {
    remember("dark");
    signedIn(LIGHT_ONLY_THEME);
    render(<RunnerShell appId={APP_ID} />);
    await screen.findByTestId("current-user");
    expect(screen.queryByTestId("color-scheme-toggle")).toBeNull();
    expect(htmlAttribute()).toBe("light");
  });

  test("利用者向けの画面(runner)のログイン画面には出さない", async () => {
    signedOut();
    render(<RunnerShell appId={APP_ID} />);
    await screen.findByTestId("login-page");
    expect(screen.queryByTestId("color-scheme-toggle")).toBeNull();
  });
});

/*
 * **【V20-M10-T05】ログインせずに開ける画面(公開の画面)の上端の帯にも出す。**
 * メインの裁定: 公開の画面の帯もアプリの上端の帯なので、各アプリの上端の帯に置く決定の範囲に入る。
 * ログイン画面とアプリ一覧には出さない(上の2本は動かしていない)。
 * 公開の画面の帯では、ログインへの導線がスイッチの左に在り、`.current-user` が無いので、
 * 右寄せはスイッチ自身が持つ(既存の作法 `ml-auto`。`ui/overlay.tsx` と同じクラス)。
 * **happy-dom は配置を解かないので、右に寄ることは証明しない**(クラスが付いていることだけを見る)。
 * 経路は2つある: 定義が 401 で `GET /public` に倒した経路と、定義が読めて未ログインの経路。
 */
const PUBLIC_VIEW_ID = "entry-list";

function publicInfoOf(theme?: Theme) {
  const manifest = sampleManifest(theme);
  const [table] = manifest.app.tables;
  const [view] = manifest.app.views;
  return {
    app: { id: APP_ID, name: manifest.app.name },
    views: [{ ...view, tables: [table] }],
    ...(theme === undefined ? {} : { theme }),
  };
}

/** 定義は 401、`GET /public` が公開の画面を返す(今日の製品の経路)。 */
function publicOnly(theme?: Theme): void {
  stub((url) => {
    if (url === meUrl) {
      return jsonResponse({ errors: [{ path: "", message: "認証されていません。" }] }, 401);
    }
    if (url === manifestUrl) {
      return jsonResponse({ errors: [{ path: "", message: "認証が必要です。" }] }, 401);
    }
    if (url === `/api/apps/${APP_ID}/public`) return jsonResponse(publicInfoOf(theme));
    if (url.endsWith("/records")) return jsonResponse({ records: [], total: 0 });
    return undefined;
  });
}

/** 定義は読め、未ログイン。匿名が読める画面を1つ宣言している。 */
function anonymousWithManifest(theme?: Theme): void {
  const manifest = sampleManifest(theme);
  manifest.app.roles = [
    { id: "anonymous", rules: [{ target: "view", view: PUBLIC_VIEW_ID, can: ["read"] }] },
  ];
  stub((url) => {
    if (url === meUrl) {
      return jsonResponse({ errors: [{ path: "", message: "認証されていません。" }] }, 401);
    }
    if (url === manifestUrl) return jsonResponse(manifest);
    if (url.startsWith(`/api/apps/${APP_ID}/tables/`) || url.endsWith("/records"))
      return jsonResponse({ records: [], total: 0 });
    return undefined;
  });
}

async function expectToggleInAnonymousHeader(): Promise<HTMLElement> {
  const workspace = await screen.findByTestId("anonymous-workspace");
  const toggle = await screen.findByTestId("color-scheme-toggle");
  expect(screen.getAllByTestId("color-scheme-toggle")).toHaveLength(1);
  expect(toggle.tagName).toBe("BUTTON");
  const header = toggle.closest(".app-header");
  expect(header).not.toBeNull();
  expect(workspace.contains(header)).toBe(true);
  // 右寄せ(ログインへの導線の後ろ)。
  expect(toggle.className.split(/\s+/)).toContain("ml-auto");
  const link = screen.getByTestId("anonymous-login-link");
  expect(link.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  return toggle;
}

describe("ログインせずに開ける画面(公開の画面)にも出す(T05。メインの裁定)", () => {
  test("持ち主の画面: GET /public の経路で公開の画面の帯に1つ。押すと暗く覚える", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/${PUBLIC_VIEW_ID}`);
    publicOnly();
    render(<App />);
    const toggle = await expectToggleInAnonymousHeader();
    expect(screen.queryByTestId("login-page")).toBeNull();
    fireEvent.click(toggle);
    await waitFor(() => expect(htmlAttribute()).toBe("dark"));
    expect(window.localStorage.getItem(COLOR_SCHEME_STORAGE_KEY)).toBe("dark");
  });

  test("持ち主の画面: 定義が読める未ログインの経路でも帯に1つ", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/${PUBLIC_VIEW_ID}`);
    anonymousWithManifest();
    render(<App />);
    await expectToggleInAnonymousHeader();
  });

  test("持ち主の画面: slots_dark を持つテーマなら出す", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/${PUBLIC_VIEW_ID}`);
    publicOnly(WITH_DARK_THEME);
    render(<App />);
    await expectToggleInAnonymousHeader();
  });

  test("持ち主の画面: slots_dark を持たないテーマなら出さず、明るく強制する(同じ規則)", async () => {
    remember("dark");
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/${PUBLIC_VIEW_ID}`);
    publicOnly(LIGHT_ONLY_THEME);
    render(<App />);
    await screen.findByTestId("anonymous-workspace");
    expect(screen.queryByTestId("color-scheme-toggle")).toBeNull();
    expect(htmlAttribute()).toBe("light");
  });

  test("利用者向けの画面(runner): GET /public の経路で公開の画面の帯に1つ", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/${PUBLIC_VIEW_ID}`);
    publicOnly();
    render(<RunnerShell appId={APP_ID} />);
    await expectToggleInAnonymousHeader();
  });

  test("利用者向けの画面(runner): 定義が読める未ログインの経路でも帯に1つ", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/${PUBLIC_VIEW_ID}`);
    anonymousWithManifest();
    render(<RunnerShell appId={APP_ID} />);
    await expectToggleInAnonymousHeader();
  });

  test("利用者向けの画面(runner): slots_dark を持たないテーマなら出さない", async () => {
    remember("dark");
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/${PUBLIC_VIEW_ID}`);
    publicOnly(LIGHT_ONLY_THEME);
    render(<RunnerShell appId={APP_ID} />);
    await screen.findByTestId("anonymous-workspace");
    expect(screen.queryByTestId("color-scheme-toggle")).toBeNull();
    expect(htmlAttribute()).toBe("light");
  });
});
