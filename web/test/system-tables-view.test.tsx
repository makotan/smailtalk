/**
 * システムテーブル(`_apps` / `_changelog`)をフロントが描けることのテスト
 * (V0-P6-T02 / ADR-0006 §7 のフロント4箇所・§8 の L4)。
 *
 * ここが落ちると、サーバ側が完璧でも**画面は空のまま**になり DoD-4 が未達になる。
 * `ListViewRenderer` は対象テーブルをマニフェストからしか探していなかったため、
 * `_apps` を指す list_view はレコードAPI を**一度も叩かずに**
 * 「マニフェストにありません」を描画して終わっていた(ADR-0006 §7 の #9)。
 *
 * 確認するのは次の4点:
 *   1. `_apps` を指す list_view が実データを描く(テーブルが解決され API が呼ばれる)
 *   2. `_changelog` を指す list_view が intent 付きで描かれ、`filter` がクエリに載る
 *   3. システムテーブルの detail_view に**削除ボタンが無い**(L4)
 *   4. システムテーブルの detail_view に**編集ボタンが無い**
 *      (form はカーネルの L2 が拒否するので、そもそもマニフェストに存在しえない)
 *
 * ユーザテーブル側の既存挙動は `list-view.test.tsx` / `detail-view.test.tsx` が固定している。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { DetailView, ListView, Manifest } from "../../src/kernel/types.ts";
import { DetailViewRenderer } from "../src/views/DetailViewRenderer.tsx";
import { ListViewRenderer } from "../src/views/ListViewRenderer.tsx";

const APP_ID = "sample-app";

/**
 * システムテーブルを参照するビューだけを持つマニフェスト。
 *
 * `tables` にユーザテーブルを1つ置いてあるのは、システムテーブルが
 * `manifest.app.tables` に**現れない**(ADR-0006 §5)ことを崩さずに、
 * 「宣言テーブルとは別経路で解決されている」ことを示すためである。
 */
function systemManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "プラットフォーム管理",
      tables: [
        {
          id: "memos",
          name: "メモ",
          fields: [{ id: "body", name: "本文", type: "text", required: true }],
        },
      ],
      views: [
        {
          id: "app-list",
          type: "list_view",
          table: "_apps",
          columns: ["app_id", "name", "status"],
          sort: { field: "created_at", order: "desc" },
        },
        {
          id: "changelog-list",
          type: "list_view",
          table: "_changelog",
          columns: ["seq", "app_id", "intent", "kind"],
          filter: [{ field: "app_id", equals: "book-tracker" }],
        },
        { id: "app-detail", type: "detail_view", table: "_apps" },
      ],
    },
  };
}

function listView(manifest: Manifest, viewId: string): ListView {
  const view = manifest.app.views.find((candidate) => candidate.id === viewId);
  if (view === undefined || view.type !== "list_view") {
    throw new Error(`fixture broken: ${viewId}`);
  }
  return view;
}

function detailView(manifest: Manifest, viewId: string): DetailView {
  const view = manifest.app.views.find((candidate) => candidate.id === viewId);
  if (view === undefined || view.type !== "detail_view") {
    throw new Error(`fixture broken: ${viewId}`);
  }
  return view;
}

const APP_ROWS = [
  {
    _id: "book-tracker",
    _created_at: "2026-07-01T00:00:00Z",
    _updated_at: "2026-07-01T00:00:00Z",
    app_id: "book-tracker",
    name: "読書記録",
    created_at: "2026-07-01T00:00:00Z",
    status: "active",
  },
  {
    _id: "old-app",
    _created_at: "2026-06-01T00:00:00Z",
    _updated_at: "2026-06-01T00:00:00Z",
    app_id: "old-app",
    name: "むかしのアプリ",
    created_at: "2026-06-01T00:00:00Z",
    status: "archived",
  },
];

const CHANGELOG_ROWS = [
  {
    _id: "1",
    _created_at: "2026-07-02T00:00:00Z",
    _updated_at: "2026-07-02T00:00:00Z",
    seq: 1,
    app_id: "book-tracker",
    diff_id: "d-001",
    intent: "読み終わった日を記録したい",
    applied_at: "2026-07-02T00:00:00Z",
    kind: "apply",
    undo_target_seq: null,
  },
];

let requests: { url: string; method: string }[];
let originalFetch: typeof fetch;

const APPS_PATH = `/api/apps/${APP_ID}/tables/_apps/records`;
const CHANGELOG_PATH = `/api/apps/${APP_ID}/tables/_changelog/records`;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  requests = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    requests.push({ url, method: init?.method ?? "GET" });
    if (url.startsWith(`${APPS_PATH}/`)) {
      const recordId = decodeURIComponent(url.slice(`${APPS_PATH}/`.length));
      const record = APP_ROWS.find((candidate) => candidate._id === recordId);
      if (record === undefined) {
        return jsonResponse({ errors: [{ path: "", message: "no record" }] }, 404);
      }
      return jsonResponse({ record });
    }
    if (url.startsWith(APPS_PATH)) {
      return jsonResponse({ records: APP_ROWS });
    }
    if (url.startsWith(CHANGELOG_PATH)) {
      return jsonResponse({ records: CHANGELOG_ROWS });
    }
    return jsonResponse({ errors: [{ path: "", message: `no stub for ${url}` }] }, 404);
  }) as typeof fetch;
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/app-list`);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("_apps を指す list_view", () => {
  test("マニフェストに宣言されていなくてもテーブルが解決され、実データが描かれる", async () => {
    const manifest = systemManifest();
    render(
      <ListViewRenderer appId={APP_ID} manifest={manifest} view={listView(manifest, "app-list")} />,
    );
    await screen.findByTestId("list-table");
    const headers = screen.getAllByRole("columnheader").map((cell) => cell.textContent);
    expect(headers).toEqual(["アプリID", "アプリ名", "状態"]);
    const rows = screen.getAllByTestId("list-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("読書記録");
    expect(rows[1]?.textContent).toContain("archived");
  });

  test("レコードAPI を実際に叩く(叩かずにエラーを描いて終わらない)", async () => {
    const manifest = systemManifest();
    render(
      <ListViewRenderer appId={APP_ID} manifest={manifest} view={listView(manifest, "app-list")} />,
    );
    await screen.findByTestId("list-table");
    expect(requests.some((request) => request.url.startsWith(APPS_PATH))).toBe(true);
    expect(screen.queryByTestId("errors")).toBeNull();
  });

  test("sort はそのままクエリに載る(フロントで並べ替えない)", async () => {
    const manifest = systemManifest();
    render(
      <ListViewRenderer appId={APP_ID} manifest={manifest} view={listView(manifest, "app-list")} />,
    );
    await screen.findByTestId("list-table");
    const url = requests.find((request) => request.url.startsWith(APPS_PATH))?.url;
    expect(url).toContain("sort=created_at");
    expect(url).toContain("order=desc");
  });
});

describe("_changelog を指す list_view", () => {
  test("intent 付きで描かれる", async () => {
    const manifest = systemManifest();
    render(
      <ListViewRenderer
        appId={APP_ID}
        manifest={manifest}
        view={listView(manifest, "changelog-list")}
      />,
    );
    await screen.findByTestId("list-table");
    const headers = screen.getAllByRole("columnheader").map((cell) => cell.textContent);
    expect(headers).toEqual(["連番", "アプリID", "意図", "種別"]);
    expect(screen.getAllByTestId("list-row")[0]?.textContent).toContain(
      "読み終わった日を記録したい",
    );
  });

  test("アプリ別の絞り込み(filter)がクエリに載る", async () => {
    const manifest = systemManifest();
    render(
      <ListViewRenderer
        appId={APP_ID}
        manifest={manifest}
        view={listView(manifest, "changelog-list")}
      />,
    );
    await screen.findByTestId("list-table");
    const url = requests.find((request) => request.url.startsWith(CHANGELOG_PATH))?.url;
    expect(url).toContain("filter.app_id=book-tracker");
  });
});

describe("システムテーブルの detail_view(ADR-0006 §8 の L4)", () => {
  function renderAppDetail() {
    const manifest = systemManifest();
    return render(
      <DetailViewRenderer
        appId={APP_ID}
        manifest={manifest}
        view={detailView(manifest, "app-detail")}
        recordId="book-tracker"
      />,
    );
  }

  test("全フィールドが描かれる(テーブルが解決されている)", async () => {
    renderAppDetail();
    expect((await screen.findByTestId("detail-field-name")).textContent).toBe("読書記録");
    expect(screen.getByTestId("detail-field-status").textContent).toBe("active");
  });

  test("削除ボタンを出さない", async () => {
    renderAppDetail();
    await screen.findByTestId("detail-field-name");
    expect(screen.queryByTestId("detail-delete")).toBeNull();
    expect(screen.queryByTestId("detail-delete-execute")).toBeNull();
  });

  test("編集ボタンを出さない(form はカーネルの L2 が拒否するので存在しえない)", async () => {
    renderAppDetail();
    await screen.findByTestId("detail-field-name");
    expect(screen.queryByTestId("detail-edit")).toBeNull();
  });

  test("form を持つマニフェストを与えても編集ボタンを出さない(L2 がほどけても壊れない)", async () => {
    // カーネルの検証を通らない形のマニフェストを、あえてフロントへ直接渡す。
    // 「到達しないはず」に安全性を預けないための一段(ADR-0006 §7 の #11 / #12 と同じ方針)。
    const manifest = systemManifest();
    manifest.app.views.push({
      id: "app-form",
      type: "form",
      table: "_apps",
      fields: ["name"],
    });
    render(
      <DetailViewRenderer
        appId={APP_ID}
        manifest={manifest}
        view={detailView(manifest, "app-detail")}
        recordId="book-tracker"
      />,
    );
    await screen.findByTestId("detail-field-name");
    expect(screen.queryByTestId("detail-edit")).toBeNull();
  });

  test("読み取りの導線は残る(エラーにならない)", async () => {
    renderAppDetail();
    await screen.findByTestId("detail-field-name");
    await waitFor(() => {
      expect(screen.queryByTestId("errors")).toBeNull();
    });
    expect(screen.getByTestId("view-renderer-detail_view")).toBeDefined();
  });
});
