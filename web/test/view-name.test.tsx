/**
 * `view.name`(表示名)の描画テスト(V1-M0-T02 / F-1)。
 *
 * **このファイルが完了条件1 の本体である。** スキーマに `name` を足しただけでは
 * 「AI が書ける」だけで「ユーザに見える」ことにはならない。v0 の所見 F-1 は
 * 「表示名を付けたい」という要求であって「スキーマに書きたい」という要求ではないので、
 * **画面に出て初めて要求が満たされる**。
 *
 * 同時に完了条件2(フォールバック)も固定する。`name` を持たない既存マニフェストは
 * 無改変で valid のままなので、**画面側は必ず両方を描けなければならない**。
 * 既定挙動は「`name` が無ければ `id` を出す」である —— 空欄にすると、v0 から
 * 存在するビューが画面上で無名になり、後退になる。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { Manifest } from "../../src/kernel/types.ts";
import { App } from "../src/App.tsx";
import { ViewHost, viewDisplayName } from "../src/views/ViewHost.tsx";
import { grantRules, viewRead } from "./role-rules.ts";

const APP_ID = "sample-app";

/**
 * ビュー3種のうち先頭2つに `name` があり、3つ目は v0 のまま `name` を持たない。
 *
 * **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65`】面の既定が「閉じる」側へ倒れたので、
 * 規則を1本も持たない題材では画面一覧が空になり、表示名も id も1文字も出ない。**
 * **本ファイルの主題(`name` があれば表示名・無ければ id)は権限ではないので、
 * 題材の側に規則を足して主題を保つ。** **期待値は1文字も変えていない。**
 *
 * **宛先の役割が `anonymous` なのは、この題材の `me` が `role` を1つも返さないためである**
 * (下の `beforeEach` の `/auth/me`)—— **`src/server/owner-scope.ts` の `roleSubjectsOf` は
 * 役割を1つも持たない相手を `anonymous` 1語として判定する。** **`owner` に足しても当たらない。**
 * **足すのは画面 × 読取の3本だけで、表・項目・ボタンの規則は1本も足していない。**
 */
function mixedManifest(): Manifest {
  const built: Manifest = {
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
        {
          id: "entry-form",
          name: "エントリを登録",
          type: "form",
          table: "entries",
          fields: ["label"],
        },
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

function viewOf(manifest: Manifest, viewId: string) {
  const view = manifest.app.views.find((candidate) => candidate.id === viewId);
  if (view === undefined) {
    throw new Error(`fixture broken: ${viewId}`);
  }
  return view;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  const routes: Record<string, unknown> = {
    // per-app 認証ゲート(ADR-0014 改訂)を通すため、そのアプリの me を認証済みで返す。
    [`/api/apps/${APP_ID}/auth/me`]: { user: { id: "u1", username: "tester", displayName: null } },
    "/api/apps": {
      apps: [
        { app_id: APP_ID, name: "サンプル", created_at: "2026-01-01T00:00:00Z", status: "active" },
      ],
    },
    [`/api/apps/${APP_ID}/manifest`]: mixedManifest(),
  };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    return jsonResponse(routes[url] ?? { errors: [{ path: "", message: `no stub for ${url}` }] });
  }) as typeof fetch;
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("表示名の決定(viewDisplayName)", () => {
  const manifest = mixedManifest();

  test("name があればそれを返す", () => {
    expect(viewDisplayName(viewOf(manifest, "entry-list"))).toBe("エントリ一覧");
  });

  test("name が無ければ id へフォールバックする(完了条件2 の既定挙動)", () => {
    expect(viewDisplayName(viewOf(manifest, "entry-detail"))).toBe("entry-detail");
  });
});

describe("ビューの見出し(ViewHost)", () => {
  const manifest = mixedManifest();

  test("name を持つビューは表示名が見出しに出る(完了条件1)", () => {
    render(<ViewHost appId={APP_ID} manifest={manifest} view={viewOf(manifest, "entry-list")} />);
    expect(screen.getByTestId("view-title").textContent).toBe("エントリ一覧");
    // 見出しが出ても、描画そのものは従来どおりディスパッチされる。
    expect(screen.getByTestId("view-renderer-list_view")).toBeDefined();
  });

  test("name を持たないビューは id が見出しに出る(完了条件2)", () => {
    render(<ViewHost appId={APP_ID} manifest={manifest} view={viewOf(manifest, "entry-detail")} />);
    expect(screen.getByTestId("view-title").textContent).toBe("entry-detail");
    expect(screen.getByTestId("view-renderer-detail_view")).toBeDefined();
  });
});

describe("ビュー一覧のタブ(AppWorkspace)", () => {
  test("name があるビューは表示名で、無いビューは id でリンクが出る", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}`);
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("view-list")).toBeDefined();
    });
    const viewList = screen.getByTestId("view-list");
    expect(viewList.textContent).toContain("エントリ一覧");
    expect(viewList.textContent).toContain("エントリを登録");
    // name を持たないビューは従来どおり id が出る(後退させない)。
    expect(viewList.textContent).toContain("entry-detail");
    // name を持つビューについては、ID は表示名に置き換わる(両方は出さない)。
    expect(viewList.textContent).not.toContain("entry-list");
  });
});
