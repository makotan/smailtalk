/**
 * アプリシェルのコンポーネントテスト(V0-P3-T03)。
 *
 * 検証するのは骨格の4点だけ:
 *   1. アプリ一覧が API のレスポンスから描画される
 *   2. アプリを選ぶとそのアプリのマニフェストを **API から** 取りに行く
 *   3. マニフェストのビュー一覧が描画される
 *   4. ビュー種別ごとに正しい汎用コンポーネントへディスパッチされる
 *
 * フィクスチャの ID(`sample-app` 等)はこのテストファイル内にしか存在しない。
 * 実装側にアプリ固有の名前を持ち込まないこと(CP-3 確認方法4)。
 * スタブするレスポンスの形は `src/server/app.ts` の実際の出力
 * (`{ apps: [...] }` / マニフェスト本体 / `{ errors: [...] }`)に合わせている。
 *
 * **【V3-M3-T01 で問い合わせ先を絞った】** 共通ヘッダに**アプリ切替**が常設された
 * (F-11' / ユーザ決定 D-M3-5)ため、同じアプリ名のリンクが**アプリ一覧と切替 UI の
 * 2箇所**に出るようになり、`screen.getByRole("link", { name })` が
 * `Found multiple elements` で落ちた。**期待値は1つも緩めていない** —— 見る対象を
 * 「アプリ一覧(`app-list`)の中のリンク」に絞っただけである。切替 UI 側の固定は
 * `web/test/app-switcher.test.tsx` が持つ。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Manifest } from "../../src/kernel/types.ts";
import { App } from "../src/App.tsx";
import { ViewHost } from "../src/views/ViewHost.tsx";
import { grantRules, viewRead } from "./role-rules.ts";

const APPS_RESPONSE = {
  apps: [
    {
      app_id: "sample-app",
      name: "サンプル",
      created_at: "2026-01-01T00:00:00Z",
      status: "active",
    },
    {
      app_id: "other-app",
      name: "べつのやつ",
      created_at: "2026-01-02T00:00:00Z",
      status: "active",
    },
  ],
};

/**
 * **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65`】面の既定が「閉じる」側へ倒れたので、
 * 規則を1本も持たない題材では画面一覧が1件も描かれない。**
 * **本ファイルの主題は骨格の4点(一覧・取得・描画・ディスパッチ)であって権限ではないので、
 * 題材の側に規則を足して主題を保つ。** **期待値は1文字も変えていない。**
 *
 * **宛先の役割が `anonymous` なのは、この題材の `me` が `role` を1つも返さないためである**
 * (下の `beforeEach` の `/api/apps/sample-app/auth/me`)—— **`roleSubjectsOf`
 * (`src/server/owner-scope.ts`)は役割を1つも持たない相手を `anonymous` 1語として判定する。**
 * **足すのは画面 × 読取の3本だけで、表・項目・ボタンの規則は1本も足していない。**
 */
function sampleManifest(): Manifest {
  const built: Manifest = {
    app: {
      id: "sample-app",
      name: "サンプル",
      tables: [
        {
          id: "entries",
          name: "エントリ",
          fields: [{ id: "label", name: "ラベル", type: "text", required: true }],
        },
      ],
      views: [
        { id: "entry-list", type: "list_view", table: "entries", columns: ["label"] },
        { id: "entry-form", type: "form", table: "entries", fields: ["label"] },
        { id: "entry-detail", type: "detail_view", table: "entries" },
      ],
    },
  };
  return grantRules(
    built,
    ["anonymous"],
    [viewRead("entry-list"), viewRead("entry-form"), viewRead("entry-detail")],
  );
}

let requestedUrls: string[];
let originalFetch: typeof fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  requestedUrls = [];
  originalFetch = globalThis.fetch;
  const routes: Record<string, unknown> = {
    // アプリ一覧(/)は認証不要。アプリを開いたときの per-app 認証ゲート(ADR-0014 改訂)を
    // 通すため、そのアプリの me を認証済みで返す(このテストの主題は認証ではない)。
    "/api/apps/sample-app/auth/me": { user: { id: "u1", username: "tester", displayName: null } },
    "/api/apps": APPS_RESPONSE,
    "/api/apps/sample-app/manifest": sampleManifest(),
  };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    requestedUrls.push(url);
    const body = routes[url];
    if (body === undefined) {
      return jsonResponse({ errors: [{ path: "", message: `no stub for ${url}` }] }, 404);
    }
    return jsonResponse(body);
  }) as typeof fetch;
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

/** アプリ一覧(`/`)の中のリンクだけを見る(共通ヘッダの切替 UI と取り違えないため)。 */
async function appListLink(name: string): Promise<HTMLElement> {
  return within(await screen.findByTestId("app-list")).getByRole("link", { name });
}

describe("アプリ一覧", () => {
  test("GET /api/apps の結果をアプリ名で描画する", async () => {
    render(<App />);
    expect(await appListLink("サンプル")).toBeDefined();
    expect(await appListLink("べつのやつ")).toBeDefined();
    expect(requestedUrls).toContain("/api/apps");
  });
});

describe("アプリ選択", () => {
  test("アプリを選ぶとそのアプリのマニフェストを API から取得する", async () => {
    render(<App />);
    fireEvent.click(await appListLink("サンプル"));
    await waitFor(() => {
      expect(requestedUrls).toContain("/api/apps/sample-app/manifest");
    });
  });

  test("マニフェストのビュー一覧を描画し、URL がビュー一覧を指す", async () => {
    render(<App />);
    fireEvent.click(await appListLink("サンプル"));
    for (const viewId of ["entry-list", "entry-form", "entry-detail"]) {
      expect(await screen.findByRole("link", { name: new RegExp(viewId) })).toBeDefined();
    }
    expect(window.location.pathname).toBe("/apps/sample-app");
  });
});

describe("リロード相当(直接 URL を開く)", () => {
  test("ビューの URL を直接開くとそのビューが描画される", async () => {
    window.history.replaceState({}, "", "/apps/sample-app/views/entry-list");
    render(<App />);
    expect(await screen.findByTestId("view-renderer-list_view")).toBeDefined();
  });
});

describe("ディスパッチ層", () => {
  const manifest = sampleManifest();
  const cases = [
    ["entry-list", "list_view"],
    ["entry-form", "form"],
    ["entry-detail", "detail_view"],
  ] as const;

  for (const [viewId, viewType] of cases) {
    test(`${viewType} は専用の汎用コンポーネントに渡る`, () => {
      const view = manifest.app.views.find((candidate) => candidate.id === viewId);
      if (view === undefined) {
        throw new Error(`fixture broken: ${viewId}`);
      }
      render(<ViewHost appId={manifest.app.id} manifest={manifest} view={view} />);
      expect(screen.getByTestId(`view-renderer-${viewType}`)).toBeDefined();
      for (const other of ["list_view", "form", "detail_view"].filter((t) => t !== viewType)) {
        expect(screen.queryByTestId(`view-renderer-${other}`)).toBeNull();
      }
    });
  }
});
