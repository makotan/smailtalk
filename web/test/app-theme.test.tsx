/**
 * アプリ単位テーマのスコープ要素のテスト(V3-M1-T04 / ADR-0047 / ADR-0048 §1b / §1c)。
 *
 * ## 何を固定しているか
 *
 * 1. **スコープ要素は1つである**(`AppWorkspace` の `.app-theme`)。テーマの実値は
 *    マニフェスト由来のカスタムプロパティとしてこの要素の `style` に立つ
 *    (**レンダラーの props には1つも足さない**。`web/src/views/types.ts` の禁止。T04-4)。
 * 2. **当たる画面は3つ**(認証済みワークスペース / ログイン画面 / 認証確認中)。
 * 3. **当たらない画面は2つ**(読み込み中 / マニフェストエラー)—— **原理的に当たらない。**
 *    どちらも `manifest` を参照できる行より前にあり、マニフェストがまだ無い・あるいは
 *    永久に無い状態そのものである(`web/src/AppWorkspace.tsx` の早期 return 4本のうち前2本)。
 *    **「当てられなかった」のではなく、当てる材料が存在しない。**
 * 4. **`.shell` には当てない**(ADR-0048 限定2)—— アプリのテーマがシェルへ漏れない。
 *    シェルの見た目は V3-M3(D-G6。保留のまま)の担当である。
 * 5. **変換規則は1本(写像 `web/src/theme-role-map.ts`)である**(T04-11 / V20-M8 / ADR-0473)——
 *    マニフェストのキーは役割名(`body_text` など)であり、注入されるカスタムプロパティ名の集合は
 *    `schemas/manifest.schema.json` の `$defs/theme` の properties キーを写像に通した集合と
 *    **完全一致**する。**2本目の変換規則を作らないことを、製品コードの経路で機械的に固定する**
 *    (`web/test/theme-slot-parity.test.ts` が見る写像と同一である)。
 *
 * ## このファイルが証明しないこと(誇張しない)
 *
 * - **色が実際に変わることは証明していない。** happy-dom は CSS のカスケードも継承も
 *   解かない。**描画が変わることの実証は `web/e2e/theme.e2e.ts`(chromium)である。**
 * - **テーマ対象外の3スロット**(`--shell-max-width` / `--border-style` /
 *   `--focus-outline-style`)**はテーマから当たらない。** ここで固定しているのは
 *   「注入される集合が25件ちょうどで、対象外3件を含まない」ことである。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { Manifest, Theme } from "../../src/kernel/types.ts";
import { App } from "../src/App.tsx";
import { THEME_ROLE_TO_CSS_PROPERTY } from "../src/theme-role-map.ts";

const APP_ID = "sample-app";

const REPO_ROOT = dirname(dirname(import.meta.dir));
const MANIFEST_SCHEMA_PATH = join(REPO_ROOT, "schemas", "manifest.schema.json");

/** `$defs/theme` の properties キー(**ファイルとして読む**。ADR-0009 限定2)。 */
function themeSlotNames(): string[] {
  const schema = JSON.parse(readFileSync(MANIFEST_SCHEMA_PATH, "utf-8")) as {
    $defs: { theme: { properties: Record<string, unknown> } };
  };
  return Object.keys(schema.$defs.theme.properties);
}

/**
 * スロット名(役割名)が写る CSS カスタムプロパティ名。**写像の表から引く**(対応をここに書き下さない)。
 * 表に無い名前は赤くする(スキーマと写像のずれを黙って通さない)。
 */
function cssNameOf(slot: string): string {
  const name = THEME_ROLE_TO_CSS_PROPERTY[slot];
  if (name === undefined) throw new Error(`写像に無いスロット: ${slot}`);
  return name;
}

/** 注入されるはずのカスタムプロパティ名の集合(スキーマのキーを写像に通したもの)。 */
function injectedNames(): string[] {
  return themeSlotNames().map(cssNameOf);
}

/**
 * 検証用のテーマ。**25スロット全部に値を書く**(`$defs/theme` は全キー `required`。
 * ADR-0047 の 2026-07-25 追記(2))。値はスキーマのキーから機械的に作る ——
 * 色スロットは `#123456`(ここでは形だけが要る。コントラスト検査は E2E とカーネル側の担当)。
 *
 * **色かどうかは写像の CSS 名で判定する**(V20-M8)。キーは役割名(`body_text` など)なので、
 * キーの綴り(`--color` で始まる / `-color` で終わる)で判定すると1件も当たらず、
 * 全件が長さの値になって黙って意味を失う。
 */
function sampleTheme(): Theme {
  const slots: Record<string, string> = {};
  for (const slot of themeSlotNames()) {
    const css = cssNameOf(slot);
    slots[slot] = css.startsWith("--color") || css.endsWith("-color") ? "#123456" : "7px";
  }
  // 形式が決まっているスロットは、その形式で上書きする(`$defs/theme` の pattern)。
  slots.body_font = "Georgia, serif";
  slots.body_line_height = "2";
  slots.surface_shadow = "none";
  return { slots };
}

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

/** 解決しない Promise(「読み込み中」の状態を作るためのスタブ)。 */
function pending(): Promise<Response> {
  return new Promise<Response>(() => {
    /* 解決しない */
  });
}

let originalFetch: typeof fetch;

function stub(routes: (url: string) => Promise<Response> | Response | undefined): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    const response = routes(url.split("?")[0] ?? url);
    if (response === undefined) {
      return Promise.resolve(
        jsonResponse({ errors: [{ path: "", message: `no stub for ${url}` }] }, 404),
      );
    }
    return response instanceof Promise ? response : Promise.resolve(response);
  }) as typeof fetch;
}

const meUrl = `/api/apps/${APP_ID}/auth/me`;
const manifestUrl = `/api/apps/${APP_ID}/manifest`;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  window.history.replaceState({}, "", `/apps/${APP_ID}`);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.history.replaceState({}, "", "/");
});

/** スコープ要素に立っているカスタムプロパティ名 → 値。 */
function injectedProperties(): Record<string, string> {
  const scope = screen.getByTestId("app-theme");
  const style = scope.getAttribute("style") ?? "";
  const out: Record<string, string> = {};
  for (const chunk of style.split(";")) {
    const text = chunk.trim();
    if (text === "") continue;
    const colon = text.indexOf(":");
    const name = text.slice(0, colon).trim();
    if (!name.startsWith("--")) continue;
    out[name] = text.slice(colon + 1).trim();
  }
  return out;
}

describe("当たる3画面(T04-1)", () => {
  test("認証済みワークスペースのスコープ要素にテーマが立つ", async () => {
    const theme = sampleTheme();
    stub((url) => {
      if (url === meUrl) {
        return jsonResponse({
          user: { id: "u1", username: "alice", displayName: null, role: "owner" },
        });
      }
      if (url === manifestUrl) return jsonResponse(sampleManifest(theme));
      return undefined;
    });
    render(<App />);

    await waitFor(() => expect(screen.getByTestId("view-list")).toBeDefined());
    const injected = injectedProperties();
    // 25件ちょうど。**多くも少なくもない。**
    expect(Object.keys(injected).sort()).toEqual(injectedNames().sort());
    expect(injected[cssNameOf("body_font")]).toBe("Georgia, serif");
    expect(injected[cssNameOf("body_line_height")]).toBe("2");
  });

  test("ログイン画面(未認証)のスコープ要素にもテーマが立つ", async () => {
    stub((url) => {
      if (url === meUrl) {
        return jsonResponse({ errors: [{ path: "", message: "認証されていません。" }] }, 401);
      }
      if (url === manifestUrl) return jsonResponse(sampleManifest(sampleTheme()));
      return undefined;
    });
    render(<App />);

    await waitFor(() => expect(screen.getByTestId("login-page")).toBeDefined());
    // ログイン画面がスコープ要素の**内側**にある(マニフェストは未認証でも取得できる)。
    const scope = screen.getByTestId("app-theme");
    expect(scope.contains(screen.getByTestId("login-page"))).toBe(true);
    // 【V20-M9 / ADR-0474】25 → 23(2枠 --detail-label-width / --login-max-width を語彙から外した)。旧(逐語): expect(Object.keys(injectedProperties())).toHaveLength(25);
    // 【V20-M9 / ADR-0474】23 → 27(4枠 primary_fill / on_primary / overlay_background / overlay_text を足した)。旧(逐語): expect(Object.keys(injectedProperties())).toHaveLength(23);
    expect(Object.keys(injectedProperties())).toHaveLength(27);
  });

  test("認証確認中(me が未応答)のスコープ要素にもテーマが立つ", async () => {
    stub((url) => {
      if (url === meUrl) return pending();
      if (url === manifestUrl) return jsonResponse(sampleManifest(sampleTheme()));
      return undefined;
    });
    render(<App />);

    await waitFor(() => expect(screen.getByTestId("auth-loading")).toBeDefined());
    const scope = screen.getByTestId("app-theme");
    expect(scope.contains(screen.getByTestId("auth-loading"))).toBe(true);
    // 【V20-M9 / ADR-0474】25 → 23(2枠 --detail-label-width / --login-max-width を語彙から外した)。旧(逐語): expect(Object.keys(injectedProperties())).toHaveLength(25);
    // 【V20-M9 / ADR-0474】23 → 27(4枠 primary_fill / on_primary / overlay_background / overlay_text を足した)。旧(逐語): expect(Object.keys(injectedProperties())).toHaveLength(23);
    expect(Object.keys(injectedProperties())).toHaveLength(27);
  });
});

describe("原理的に当たらない2画面(T04-1。当てられなかったのではない)", () => {
  test("マニフェスト読み込み中はスコープ要素が存在しない(まだマニフェストが無い)", async () => {
    stub((url) => {
      if (url === meUrl) {
        return jsonResponse({
          user: { id: "u1", username: "alice", displayName: null, role: "owner" },
        });
      }
      if (url === manifestUrl) return pending();
      return undefined;
    });
    render(<App />);

    await waitFor(() => expect(screen.getByText("読み込み中…")).toBeDefined());
    // **テーマの値の出所が無い**(この行は `manifest` を参照できる行より前にある)。
    expect(screen.queryByTestId("app-theme")).toBeNull();
  });

  test("マニフェストエラーの画面にはスコープ要素が存在しない(永久にマニフェストが無い)", async () => {
    stub((url) => {
      if (url === meUrl) {
        return jsonResponse({
          user: { id: "u1", username: "alice", displayName: null, role: "owner" },
        });
      }
      if (url === manifestUrl) {
        return jsonResponse({ errors: [{ path: "", message: "アプリがありません。" }] }, 404);
      }
      return undefined;
    });
    render(<App />);

    await waitFor(() => expect(screen.getByText(/アプリがありません/)).toBeDefined());
    expect(screen.queryByTestId("app-theme")).toBeNull();
  });
});

describe("テーマを持たないアプリ(既存マニフェストの後方互換)", () => {
  test("スコープ要素は在るが、カスタムプロパティは1つも立たない", async () => {
    stub((url) => {
      if (url === meUrl) {
        return jsonResponse({
          user: { id: "u1", username: "alice", displayName: null, role: "owner" },
        });
      }
      if (url === manifestUrl) return jsonResponse(sampleManifest());
      return undefined;
    });
    render(<App />);

    await waitFor(() => expect(screen.getByTestId("view-list")).toBeDefined());
    const scope = screen.getByTestId("app-theme");
    // `style` 属性そのものを付けない(既定値は `web/src/styles.css` の `:root` から来る)。
    expect(scope.getAttribute("style")).toBeNull();
  });
});

describe("シェルへ漏れない(ADR-0048 限定2 / T04-2)", () => {
  test("`.shell` はスコープ要素ではなく、テーマのカスタムプロパティを1つも持たない", async () => {
    stub((url) => {
      if (url === meUrl) {
        return jsonResponse({
          user: { id: "u1", username: "alice", displayName: null, role: "owner" },
        });
      }
      if (url === manifestUrl) return jsonResponse(sampleManifest(sampleTheme()));
      return undefined;
    });
    render(<App />);

    await waitFor(() => expect(screen.getByTestId("view-list")).toBeDefined());
    const shell = document.querySelector(".shell");
    if (shell === null) throw new Error(".shell が無い");
    const scope = screen.getByTestId("app-theme");

    // (1) シェルとスコープ要素は別の要素である。
    expect(shell).not.toBe(scope);
    // (2) スコープ要素はシェルの**子孫**である(逆ではない)。
    expect(shell.contains(scope)).toBe(true);
    expect(scope.contains(shell)).toBe(false);
    // (3) シェルに inline style が1つも無い(テーマがシェルへ立っていない)。
    expect(shell.getAttribute("style")).toBeNull();
    // (4) シェル配下でテーマを持つ要素は1つだけである(スコープ要素の二重化を防ぐ)。
    const themed = [...shell.querySelectorAll("[style]")].filter((element) =>
      (element.getAttribute("style") ?? "").includes("--"),
    );
    expect(themed).toEqual([scope]);
  });
});

describe("変換規則は写像1本だけ(T04-11 / V20-M8)", () => {
  test("注入されるプロパティ名は `$defs/theme` のキーを写像に通した CSS 名である", async () => {
    const theme = sampleTheme();
    stub((url) => {
      if (url === meUrl) {
        return jsonResponse({
          user: { id: "u1", username: "alice", displayName: null, role: "owner" },
        });
      }
      if (url === manifestUrl) return jsonResponse(sampleManifest(theme));
      return undefined;
    });
    render(<App />);

    await waitFor(() => expect(screen.getByTestId("view-list")).toBeDefined());
    const injected = injectedProperties();

    // (a) 各スロットの値が、写像の CSS 名に1件ずつ届いている(値は加工しない)。
    for (const slot of themeSlotNames()) {
      expect(injected[cssNameOf(slot)]).toBe(theme.slots[slot]);
    }
    // (a') 色の枠(CSS 名で判定)に色の値が立っている(判定が空回りしていない)。
    const colorNames = injectedNames().filter(
      (name) => name.startsWith("--color") || name.endsWith("-color"),
    );
    expect(colorNames.length).toBeGreaterThan(0);
    for (const name of colorNames) {
      expect(injected[name]).toBe("#123456");
    }
    // (b) **テーマ対象外の3件は1つも注入されない**(T04-12)。
    for (const excluded of ["--shell-max-width", "--border-style", "--focus-outline-style"]) {
      expect(Object.keys(injected)).not.toContain(excluded);
    }
  });
});
