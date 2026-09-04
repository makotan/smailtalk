/**
 * 要件定義書パネルのコンポーネントテスト(V1-M8-T02 / ADR-0025 §10)。
 *
 * 検証点:
 *   1. `statements` が**節ごとに**構造描画される(節見出し6つ + 各記述)。
 *   2. **全記述に出典が表示される**(出典欄が空の記述が1件も無い)。CP-V1-8 確認方法2 の画面側。
 *   3. 該当する記述の無い節も、黙って消さずに「ありません」と出す。
 *   4. コピーボタンが **markdown 全文**をクリップボードへ渡す(パースも整形もしない)。
 *   5. `AppWorkspace` の導線が**ロールによらず**出る(ADR-0025 §10-2。API が無認証なので
 *      owner 限定 UI にすると UI が嘘をつく)。
 *   6. API がエラーを返したら、サーバの統一文面をそのまま出す。
 *
 * `connection-admin.test.tsx` の fetch 差し替え(ルート別 `jsonResponse`)を手本にする。
 * **期待値はスタブ応答から導き、記述の本文をこのファイルに焼き込まない** —— 文面を
 * 決めているのはカーネルであって画面ではない。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Manifest } from "../../src/kernel/types.ts";
import { App } from "../src/App.tsx";
import type { RequirementStatement } from "../src/api.ts";
import { RequirementsDocPanel } from "../src/RequirementsDocPanel.tsx";

const APP_ID = "sample-app";
const REQUIREMENTS_PATH = `/api/apps/${APP_ID}/requirements?format=json`;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sampleManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "サンプル",
      tables: [
        {
          id: "notes",
          name: "メモ",
          fields: [{ id: "title", name: "タイトル", type: "text", required: true }],
        },
      ],
      views: [{ id: "note-list", type: "list_view", table: "notes", columns: ["title"] }],
    },
  };
}

/**
 * カーネルが返す形の statements。**3節ぶんだけ埋める** —— 残る3節が「ありません」と
 * 出ることが検証点3 なので、意図的に空のまま残す。
 */
const STATEMENTS: RequirementStatement[] = [
  {
    id: "S-001",
    section: "overview",
    template: "overview.identity",
    slots: {
      app_id: { kind: "id", group: "app_id", value: APP_ID },
      app_name: { kind: "id", group: "app_name", value: "サンプル" },
    },
    text: `アプリ \`${APP_ID}\`(表示名 「サンプル」)の要件定義書である。`,
    sources: [
      { kind: "manifest", pointer: "/app/id" },
      { kind: "manifest", pointer: "/app/name" },
    ],
  },
  {
    id: "S-002",
    section: "features",
    template: "features.table",
    slots: {
      table_id: { kind: "id", group: "table_id", value: "notes" },
      table_name: { kind: "id", group: "table_name", value: "メモ" },
    },
    text: "このアプリはテーブル `notes`(表示名 「メモ」)を持つ。",
    sources: [{ kind: "manifest", pointer: "/app/tables/0" }],
  },
  {
    id: "S-003",
    section: "history",
    template: "history.applied",
    slots: {
      seq: { kind: "number", value: 1 },
      diff_id: { kind: "id", group: "diff_id", value: "_create-app" },
      applied_at: { kind: "id", group: "applied_at", value: "2026-07-23T00:00:00.000Z" },
    },
    text: "seq `1` で差分 `_create-app` が `2026-07-23T00:00:00.000Z` に適用された。",
    sources: [{ kind: "changelog", seq: 1, diff_id: "_create-app", pointer: "" }],
  },
];

const MARKDOWN = "# 要件定義書\n\nこの文書は…\n";

function requirementsBody(): unknown {
  return {
    requirements: {
      app_id: APP_ID,
      format: "json",
      section: null,
      statements: STATEMENTS,
      markdown: MARKDOWN,
      identifiers: { app_id: [APP_ID] },
    },
  };
}

let responses: Map<string, [number, unknown]>;
let originalFetch: typeof fetch;
/** `navigator.clipboard.writeText` に渡された文字列。 */
let copied: string[];
let originalClipboard: PropertyDescriptor | undefined;

beforeEach(() => {
  responses = new Map();
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const stubbed = responses.get(`${method} ${url}`);
    if (stubbed !== undefined) {
      return jsonResponse(stubbed[1], stubbed[0]);
    }
    if (method === "GET" && url === REQUIREMENTS_PATH) {
      return jsonResponse(requirementsBody(), 200);
    }
    return jsonResponse({ errors: [{ path: "", message: `no stub for ${method} ${url}` }] }, 404);
  }) as typeof fetch;

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
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  if (originalClipboard === undefined) {
    Reflect.deleteProperty(navigator, "clipboard");
  } else {
    Object.defineProperty(navigator, "clipboard", originalClipboard);
  }
});

describe("RequirementsDocPanel(節ごとの構造描画と出典)", () => {
  test("記述が節ごとに描かれ、件数は応答の statements と一致する", async () => {
    render(<RequirementsDocPanel appId={APP_ID} />);
    await waitFor(() => expect(screen.getAllByTestId("requirement-statement").length).toBe(3));

    // 節は ADR-0025 §7 の6つ。空の節も枠として出る。
    expect(screen.getAllByTestId("requirement-section").length).toBe(6);

    // 各記述が「自分の節の中」に描かれていること(節をまたいで混ざらない)。
    for (const statement of STATEMENTS) {
      const block = document.querySelector(`[data-section="${statement.section}"]`);
      expect(block).not.toBeNull();
      expect(block?.textContent).toContain(statement.text);
    }
  });

  test("全記述に出典が表示される(出典欄が空の記述が0件)", async () => {
    render(<RequirementsDocPanel appId={APP_ID} />);
    await waitFor(() => expect(screen.getAllByTestId("requirement-statement").length).toBe(3));

    for (const item of screen.getAllByTestId("requirement-statement")) {
      const sources = item.querySelectorAll('[data-testid="requirement-source"]');
      expect(sources.length).toBeGreaterThan(0);
      for (const source of sources) {
        expect((source.textContent ?? "").trim().length).toBeGreaterThan(0);
      }
    }
    // 出典の総数は応答から導く(件数を焼き込まない)。
    expect(screen.getAllByTestId("requirement-source").length).toBe(
      STATEMENTS.reduce((total, statement) => total + statement.sources.length, 0),
    );
  });

  test("出典は種別ごとに、辿れる位置まで出す(manifest は Pointer / changelog は seq と diff_id)", async () => {
    render(<RequirementsDocPanel appId={APP_ID} />);
    await waitFor(() =>
      expect(screen.getAllByTestId("requirement-source").length).toBeGreaterThan(0),
    );

    const texts = screen.getAllByTestId("requirement-source").map((el) => el.textContent ?? "");
    expect(texts.some((text) => text.includes("/app/tables/0"))).toBe(true);
    expect(texts.some((text) => text.includes("seq 1") && text.includes("_create-app"))).toBe(true);
  });

  test("該当する記述が無い節も、黙って消さずに出す", async () => {
    render(<RequirementsDocPanel appId={APP_ID} />);
    await waitFor(() => expect(screen.getAllByTestId("requirement-section").length).toBe(6));

    // スタブが埋めていない節の数だけ「ありません」が出る。
    const filled = new Set(STATEMENTS.map((statement) => statement.section));
    expect(screen.getAllByTestId("requirement-section-empty").length).toBe(6 - filled.size);
  });

  test("コピーボタンは markdown 全文をそのまま渡す(整形もパースもしない)", async () => {
    render(<RequirementsDocPanel appId={APP_ID} />);
    await waitFor(() => expect(screen.getByTestId("copy-requirements-markdown")).toBeDefined());

    fireEvent.click(screen.getByTestId("copy-requirements-markdown"));
    await waitFor(() => expect(copied.length).toBe(1));
    expect(copied[0]).toBe(MARKDOWN);
    await waitFor(() =>
      expect(screen.getByTestId("copy-result").textContent).toContain("コピーしました"),
    );
  });

  test("API のエラーはサーバの統一文面をそのまま出す", async () => {
    responses.set(`GET ${REQUIREMENTS_PATH}`, [
      404,
      { errors: [{ path: "", message: 'アプリ "nope" は存在しません。' }] },
    ]);
    render(<RequirementsDocPanel appId={APP_ID} />);
    await waitFor(() => expect(document.body.textContent).toContain("は存在しません"));
    expect(screen.queryByTestId("requirement-statement")).toBeNull();
  });
});

describe("AppWorkspace の要件定義書導線(ADR-0025 §10-2)", () => {
  function renderAppAs(role: "owner" | "editor" | "viewer") {
    window.history.replaceState({}, "", `/apps/${APP_ID}`);
    responses.set(`GET /api/apps/${APP_ID}/auth/me`, [
      200,
      { user: { id: "u1", username: "alice", displayName: null, role } },
    ]);
    responses.set(`GET /api/apps/${APP_ID}/manifest`, [200, sampleManifest()]);
    return render(<App />);
  }

  // **owner 限定にしない**ことがこのタスクの判断そのものなので、3ロール全部で見る。
  for (const role of ["owner", "editor", "viewer"] as const) {
    test(`${role} にも要件定義書の導線が出る(owner 限定 UI にしない)`, async () => {
      renderAppAs(role);
      await waitFor(() => expect(screen.getByTestId("open-requirements-doc")).toBeDefined());
    });
  }

  test("導線を押すと要件定義書が開く", async () => {
    renderAppAs("viewer");
    await waitFor(() => expect(screen.getByTestId("open-requirements-doc")).toBeDefined());
    fireEvent.click(screen.getByTestId("open-requirements-doc"));
    await waitFor(() => expect(screen.getByTestId("requirements-doc")).toBeDefined());
    await waitFor(() => expect(screen.getAllByTestId("requirement-statement").length).toBe(3));
  });

  test("閉じるとビュー一覧に戻る", async () => {
    renderAppAs("owner");
    await waitFor(() => expect(screen.getByTestId("open-requirements-doc")).toBeDefined());
    fireEvent.click(screen.getByTestId("open-requirements-doc"));
    await waitFor(() => expect(screen.getByTestId("requirements-doc")).toBeDefined());
    fireEvent.click(screen.getByTestId("close-requirements-doc"));
    await waitFor(() => expect(screen.getByTestId("view-list")).toBeDefined());
  });
});
