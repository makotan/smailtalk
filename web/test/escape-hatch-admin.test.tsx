/**
 * 逃げ道(任意 CSS)の owner 発行 UI の単体テスト(V3-M5-T03 / D-G5。ADR-0055 限定5・6・7・12)。
 *
 * 手本は `web/test/connection-admin.test.tsx`(同型の画面である `ConnectionAdmin` のテスト)。
 * ルート別に `fetch` を差し替え、送られた body をそのまま突き合わせる。
 *
 * ## 何を固定しているか
 *
 * 1. **AI の申請(pending)が owner の画面に出て、承認で発行フォームにプレフィルされる**
 *    (完了条件3)。
 * 2. **owner が発行できる**(`POST /escape-hatch-assets` に name / css / scopeViews /
 *    requestId が正しく載る。完了条件1)。
 * 3. **作用域の宣言が必須である**(空のまま送らせない。ADR-0055 限定7 の UI 側の先回り)。
 * 4. **失効できる**(`DELETE /escape-hatch-assets/:id`。完了条件1)。
 * 5. **owner 以外には導線が出ない**(完了条件2 の**先回り**の側)。
 *
 * ## このファイルが証明しないこと(**誇張しない**。憲法6)
 *
 * - **「UI が出ない」ことは owner 限定の担保ではない**(計画 §1-1 の3点目)。担保は
 *   サーバ側の `requireOwner` であり、**UI を迂回した直接リクエストが 403 になること**は
 *   ここでは1バイトも確かめていない —— それを確かめるのは
 *   `web/e2e/escape-hatch.e2e.ts`(chromium から実サーバへ直接叩く)と
 *   `src/server/escape-hatch-issuance.test.ts` である。
 * - **「逃げ道が実際に効く」ことは1バイトも証明していない。** happy-dom はカスケードも
 *   入れ子も解かない。実証は `web/e2e/escape-hatch.e2e.ts`(chromium)である。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Manifest } from "../../src/kernel/types.ts";
import { App } from "../src/App.tsx";
import { EscapeHatchAdmin } from "../src/auth/EscapeHatchAdmin.tsx";

const APP_ID = "sample-app";
const DIGEST = "b".repeat(64);

function jsonResponse(body: unknown, status = 200): Response {
  if (body === undefined) {
    return new Response(null, { status });
  }
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

const ASSETS_PATH = `/api/apps/${APP_ID}/escape-hatch-assets`;
const REQUESTS_PATH = `${ASSETS_PATH}/requests`;

/** AI が `request_custom_css` で出した申請(**CSS の本文を含まない**。ADR-0055 限定5)。 */
const REQUEST = {
  id: "ehreq-1",
  appId: APP_ID,
  requestedName: "print-layout",
  purpose: "一覧を印刷向けに詰めたい",
  suggestedScopeViews: ["note-list"],
  status: "pending",
  createdAt: "2026-07-27T00:00:00.000Z",
};

const ASSET = {
  id: "eh-1",
  name: "print-layout",
  digest: DIGEST,
  scopeViews: ["note-list"],
  createdAt: "2026-07-27T00:01:00.000Z",
};

let requests: { url: string; method: string; body: unknown }[];
let responses: Map<string, [number, unknown]>;
let originalFetch: typeof fetch;

beforeEach(() => {
  requests = [];
  responses = new Map();
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    requests.push({ url, method, body });
    const stubbed = responses.get(`${method} ${url}`);
    if (stubbed !== undefined) {
      return jsonResponse(stubbed[1], stubbed[0]);
    }
    if (method === "GET" && url === REQUESTS_PATH) {
      return jsonResponse({ requests: [REQUEST] }, 200);
    }
    if (method === "GET" && url === ASSETS_PATH) {
      return jsonResponse({ assets: [ASSET] }, 200);
    }
    if (method === "POST" && url === ASSETS_PATH) {
      return jsonResponse({ asset: { ...ASSET, id: "eh-new" } }, 200);
    }
    if (method === "DELETE" && url.startsWith(`${ASSETS_PATH}/`)) {
      return jsonResponse({ ok: true }, 200);
    }
    return jsonResponse({ errors: [{ path: "", message: `no stub for ${method} ${url}` }] }, 404);
  }) as typeof fetch;
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

/** 発行フォームを埋める(name / css / scopeViews)。 */
function fillIssueForm(values: { name?: string; css?: string; scope?: string }): void {
  if (values.name !== undefined) {
    fireEvent.change(screen.getByTestId("escape-hatch-name-input"), {
      target: { value: values.name },
    });
  }
  if (values.css !== undefined) {
    fireEvent.change(screen.getByTestId("escape-hatch-css-input"), {
      target: { value: values.css },
    });
  }
  if (values.scope !== undefined) {
    fireEvent.change(screen.getByTestId("escape-hatch-scope-input"), {
      target: { value: values.scope },
    });
  }
}

describe("EscapeHatchAdmin(申請一覧・発行フォーム・発行済み)", () => {
  test("AI が出した申請(pending)が一覧表示される(名前 / 目的 / 提案された作用域)", async () => {
    render(<EscapeHatchAdmin appId={APP_ID} />);
    await waitFor(() => expect(screen.getAllByTestId("escape-hatch-request-row").length).toBe(1));
    const row = screen.getByTestId("escape-hatch-request-row");
    expect(row.textContent).toContain("print-layout");
    expect(row.textContent).toContain("一覧を印刷向けに詰めたい");
    expect(row.textContent).toContain("note-list");
  });

  test("申請には CSS の本文が無いことを画面が明示する(本文を書くのは owner である)", async () => {
    render(<EscapeHatchAdmin appId={APP_ID} />);
    await waitFor(() => expect(screen.getByTestId("escape-hatch-css-hint")).toBeDefined());
    expect(screen.getByTestId("escape-hatch-css-hint").textContent).toContain("owner");
  });

  test("「承認して発行」で名前と提案された作用域がプレフィルされる(CSS 本文は空のまま)", async () => {
    render(<EscapeHatchAdmin appId={APP_ID} />);
    await waitFor(() => expect(screen.getByTestId("approve-escape-hatch-request")).toBeDefined());
    fireEvent.click(screen.getByTestId("approve-escape-hatch-request"));
    expect((screen.getByTestId("escape-hatch-name-input") as HTMLInputElement).value).toBe(
      "print-layout",
    );
    expect((screen.getByTestId("escape-hatch-scope-input") as HTMLTextAreaElement).value).toContain(
      "note-list",
    );
    // **申請は CSS の本文を運ばない**(ADR-0055 限定5)。プレフィルされるはずがない。
    expect((screen.getByTestId("escape-hatch-css-input") as HTMLTextAreaElement).value).toBe("");
  });

  test("発行フォーム送信で POST /escape-hatch-assets が正しい body で呼ばれる(承認の締めつき)", async () => {
    render(<EscapeHatchAdmin appId={APP_ID} />);
    await waitFor(() => expect(screen.getByTestId("approve-escape-hatch-request")).toBeDefined());
    fireEvent.click(screen.getByTestId("approve-escape-hatch-request"));
    fillIssueForm({ css: ".list-table td { background-color: #ff0000 }" });
    fireEvent.click(screen.getByTestId("issue-escape-hatch"));

    await waitFor(() => {
      expect(requests.some((r) => r.method === "POST" && r.url === ASSETS_PATH)).toBe(true);
    });
    const posted = requests.find((r) => r.method === "POST" && r.url === ASSETS_PATH);
    expect(posted?.body).toEqual({
      name: "print-layout",
      css: ".list-table td { background-color: #ff0000 }",
      scopeViews: ["note-list"],
      requestId: "ehreq-1",
    });
  });

  test("作用域を空のまま送れない(限定7 の先回り。HTTP を1本も叩かない)", async () => {
    render(<EscapeHatchAdmin appId={APP_ID} />);
    await waitFor(() => expect(screen.getByTestId("escape-hatch-name-input")).toBeDefined());
    fillIssueForm({ name: "print-layout", css: ".x{}", scope: "  " });
    fireEvent.click(screen.getByTestId("issue-escape-hatch"));

    await waitFor(() => expect(screen.getByTestId("escape-hatch-issue-error")).toBeDefined());
    expect(screen.getByTestId("escape-hatch-issue-error").textContent).toContain("作用域");
    expect(requests.some((r) => r.method === "POST")).toBe(false);
  });

  test('作用域にワイルドカード "*" を書けない(既定の全許可を作らない)', async () => {
    render(<EscapeHatchAdmin appId={APP_ID} />);
    await waitFor(() => expect(screen.getByTestId("escape-hatch-name-input")).toBeDefined());
    fillIssueForm({ name: "print-layout", css: ".x{}", scope: "*" });
    fireEvent.click(screen.getByTestId("issue-escape-hatch"));

    await waitFor(() => expect(screen.getByTestId("escape-hatch-issue-error")).toBeDefined());
    expect(requests.some((r) => r.method === "POST")).toBe(false);
  });

  test("マニフェストから参照できない資産名を送らせない(V3-M5-T02 §7 の申し送り3)", async () => {
    render(<EscapeHatchAdmin appId={APP_ID} />);
    await waitFor(() => expect(screen.getByTestId("escape-hatch-name-input")).toBeDefined());
    // 大文字と空白を含む名前は `$defs/resource_id` に一致しないので、発行できても
    // **マニフェストから永久に参照できない**(= 発行成功なのに1ピクセルも変わらない)。
    fillIssueForm({ name: "Print Layout", css: ".x{}", scope: "note-list" });
    fireEvent.click(screen.getByTestId("issue-escape-hatch"));

    await waitFor(() => expect(screen.getByTestId("escape-hatch-issue-error")).toBeDefined());
    expect(screen.getByTestId("escape-hatch-issue-error").textContent).toContain("資産名");
    expect(requests.some((r) => r.method === "POST")).toBe(false);
  });

  test("発行済み資産が表示され(名前 / ダイジェスト / 作用域)、失効ボタンで DELETE が呼ばれる", async () => {
    render(<EscapeHatchAdmin appId={APP_ID} />);
    await waitFor(() => expect(screen.getByTestId("escape-hatch-row")).toBeDefined());
    const row = screen.getByTestId("escape-hatch-row");
    expect(row.textContent).toContain("print-layout");
    // **ダイジェストを画面に出す** —— マニフェストの参照はこの値を書く必要がある。
    expect(screen.getByTestId("escape-hatch-row-digest").textContent).toBe(DIGEST);
    expect(row.textContent).toContain("note-list");
    // **CSS の本文は一覧に出ない**(サーバが返さない。V3-M5-T01 §5)。
    expect(row.textContent).not.toContain("background-color");

    fireEvent.click(screen.getByTestId("revoke-escape-hatch"));
    await waitFor(() => {
      expect(requests.some((r) => r.method === "DELETE" && r.url === `${ASSETS_PATH}/eh-1`)).toBe(
        true,
      );
    });
  });

  test("409(同名・同内容)のサーバ文面をそのまま出す(フロントで作り直さない)", async () => {
    responses.set(`POST ${ASSETS_PATH}`, [
      409,
      { errors: [{ path: "/name", message: "同名・同内容の資産が既にあります。" }] },
    ]);
    render(<EscapeHatchAdmin appId={APP_ID} />);
    await waitFor(() => expect(screen.getByTestId("escape-hatch-name-input")).toBeDefined());
    fillIssueForm({ name: "print-layout", css: ".x{}", scope: "note-list" });
    fireEvent.click(screen.getByTestId("issue-escape-hatch"));
    await waitFor(() => expect(screen.getByTestId("escape-hatch-issue-error")).toBeDefined());
    expect(screen.getByTestId("escape-hatch-issue-error").textContent).toContain(
      "同名・同内容の資産が既にあります",
    );
  });

  test("400(作用域の宣言が無い)のサーバ文面をそのまま出す", async () => {
    responses.set(`POST ${ASSETS_PATH}`, [
      400,
      {
        errors: [
          {
            path: "/scopeViews",
            message: "scopeViews を空にはできません(作用域の宣言が無い発行は受理しません)。",
          },
        ],
      },
    ]);
    render(<EscapeHatchAdmin appId={APP_ID} />);
    await waitFor(() => expect(screen.getByTestId("escape-hatch-name-input")).toBeDefined());
    fillIssueForm({ name: "print-layout", css: ".x{}", scope: "note-list" });
    fireEvent.click(screen.getByTestId("issue-escape-hatch"));
    await waitFor(() => expect(screen.getByTestId("escape-hatch-issue-error")).toBeDefined());
    expect(screen.getByTestId("escape-hatch-issue-error").textContent).toContain(
      "作用域の宣言が無い発行は受理しません",
    );
  });

  test("画面が「UI は担保ではない」ことを自分で書いている(担保はサーバの requireOwner)", async () => {
    render(<EscapeHatchAdmin appId={APP_ID} />);
    await waitFor(() => expect(screen.getByTestId("escape-hatch-guard-note")).toBeDefined());
    const note = screen.getByTestId("escape-hatch-guard-note").textContent ?? "";
    expect(note).toContain("サーバ");
    expect(note).toContain("owner");
  });
});

describe("AppWorkspace の owner 導線(逃げ道の管理)", () => {
  function renderAppAs(role: "owner" | "editor" | "viewer") {
    window.history.replaceState({}, "", `/apps/${APP_ID}`);
    responses.set(`GET /api/apps/${APP_ID}/auth/me`, [
      200,
      { user: { id: "u1", username: "alice", displayName: null, role } },
    ]);
    responses.set(`GET /api/apps/${APP_ID}/manifest`, [200, sampleManifest()]);
    return render(<App />);
  }

  test("owner には逃げ道の管理導線が出る", async () => {
    renderAppAs("owner");
    await waitFor(() => expect(screen.getByTestId("open-escape-hatch-admin")).toBeDefined());
  });

  test("editor には逃げ道の管理導線が出ない", async () => {
    renderAppAs("editor");
    await waitFor(() => expect(screen.getByTestId("current-role")).toBeDefined());
    expect(screen.queryByTestId("open-escape-hatch-admin")).toBeNull();
  });

  test("viewer には逃げ道の管理導線が出ない", async () => {
    renderAppAs("viewer");
    await waitFor(() => expect(screen.getByTestId("current-role")).toBeDefined());
    expect(screen.queryByTestId("open-escape-hatch-admin")).toBeNull();
  });

  test("owner が導線を押すと逃げ道の管理画面が開く", async () => {
    renderAppAs("owner");
    await waitFor(() => expect(screen.getByTestId("open-escape-hatch-admin")).toBeDefined());
    fireEvent.click(screen.getByTestId("open-escape-hatch-admin"));
    await waitFor(() => expect(screen.getByTestId("escape-hatch-admin")).toBeDefined());
  });
});
