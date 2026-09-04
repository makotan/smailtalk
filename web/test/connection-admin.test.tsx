/**
 * 接続(capability)発行 UX のコンポーネントテスト(V1-M4-T04 / ADR-0020)。
 *
 * 検証点:
 *   1. 未承認の申請が一覧表示される(requestedName / purpose / suggestedHosts)。
 *   2. 「承認して発行」で発行フォームに requestedName / suggestedHosts がプレフィルされる。
 *   3. 発行フォーム送信で **POST /connections が正しい body**(name / allowedHosts 配列 /
 *      secretSource{kind,value} / requestId)で呼ばれる。
 *   4. 発行済み接続が一覧表示され、失効ボタンで **DELETE** が呼ばれる。
 *   5. 409(同名重複)/ 400(不正入力)のサーバ文面が表示される。
 *   6. AppWorkspace は **owner のときだけ**「接続の管理」導線を出す(非 owner では出さない)。
 *
 * `authz.test.tsx` の fetch 差し替え(ルート別 `jsonResponse`)を手本にする。
 * secret 解決値はサーバが一切返さないので、ここでも取得元の参照しか出てこない。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Manifest } from "../../src/kernel/types.ts";
import { App } from "../src/App.tsx";
import { ConnectionAdmin } from "../src/auth/ConnectionAdmin.tsx";

const APP_ID = "sample-app";

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

const REQUESTS_PATH = `/api/apps/${APP_ID}/connections/requests`;
const CONNECTIONS_PATH = `/api/apps/${APP_ID}/connections`;

const REQUEST = {
  id: "req-1",
  appId: APP_ID,
  requestedName: "weather",
  purpose: "天気APIに問い合わせる",
  suggestedHosts: ["api.weather.example.com", "cdn.weather.example.com"],
  status: "pending",
  createdAt: "2026-07-01",
};

const CONNECTION = {
  id: "conn-1",
  name: "stripe",
  allowedHosts: ["api.stripe.com"],
  secretSource: { kind: "env", value: "STRIPE_API_KEY" },
  createdAt: "2026-07-02",
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
    if (method === "GET" && url === CONNECTIONS_PATH) {
      return jsonResponse({ connections: [CONNECTION] }, 200);
    }
    if (method === "POST" && url === CONNECTIONS_PATH) {
      return jsonResponse({ connection: { ...CONNECTION, id: "conn-new" } }, 200);
    }
    if (method === "DELETE" && url.startsWith(`${CONNECTIONS_PATH}/`)) {
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

describe("ConnectionAdmin(申請一覧・発行フォーム・発行済み)", () => {
  test("未承認の申請が一覧表示される(requestedName / purpose / suggestedHosts)", async () => {
    render(<ConnectionAdmin appId={APP_ID} />);
    await waitFor(() => expect(screen.getAllByTestId("connection-request-row").length).toBe(1));
    const row = screen.getByTestId("connection-request-row");
    expect(row.textContent).toContain("weather");
    expect(row.textContent).toContain("天気APIに問い合わせる");
    expect(row.textContent).toContain("api.weather.example.com");
  });

  test("「承認して発行」で発行フォームに requestedName / suggestedHosts がプレフィルされる", async () => {
    render(<ConnectionAdmin appId={APP_ID} />);
    await waitFor(() => expect(screen.getByTestId("approve-request")).toBeDefined());
    fireEvent.click(screen.getByTestId("approve-request"));
    const nameInput = screen.getByTestId("connection-name-input") as HTMLInputElement;
    const hostsInput = screen.getByTestId("connection-hosts-input") as HTMLTextAreaElement;
    expect(nameInput.value).toBe("weather");
    expect(hostsInput.value).toContain("api.weather.example.com");
    expect(hostsInput.value).toContain("cdn.weather.example.com");
  });

  test("value 欄の補助テキストが取得元(secret 本体ではない)であることを明示する", async () => {
    render(<ConnectionAdmin appId={APP_ID} />);
    await waitFor(() => expect(screen.getByTestId("secret-value-hint")).toBeDefined());
    expect(screen.getByTestId("secret-value-hint").textContent).toContain("取得元");
  });

  test("発行フォーム送信で POST /connections が正しい body で呼ばれる", async () => {
    render(<ConnectionAdmin appId={APP_ID} />);
    await waitFor(() => expect(screen.getByTestId("approve-request")).toBeDefined());
    // 申請からプレフィル(requestId も載る)。
    fireEvent.click(screen.getByTestId("approve-request"));

    const nameInput = screen.getByTestId("connection-name-input") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "weather" } });
    const hostsInput = screen.getByTestId("connection-hosts-input") as HTMLTextAreaElement;
    fireEvent.change(hostsInput, {
      target: { value: "api.weather.example.com, cdn.weather.example.com" },
    });
    fireEvent.click(screen.getByTestId("secret-kind-command"));
    const valueInput = screen.getByTestId("secret-value-input") as HTMLInputElement;
    fireEvent.change(valueInput, { target: { value: "op read weather-key" } });

    fireEvent.click(screen.getByTestId("issue-connection"));

    await waitFor(() => {
      expect(requests.some((r) => r.method === "POST" && r.url === CONNECTIONS_PATH)).toBe(true);
    });
    const posted = requests.find((r) => r.method === "POST" && r.url === CONNECTIONS_PATH);
    expect(posted?.body).toEqual({
      name: "weather",
      allowedHosts: ["api.weather.example.com", "cdn.weather.example.com"],
      secretSource: { kind: "command", value: "op read weather-key" },
      requestId: "req-1",
    });
  });

  test("発行済み接続が表示され、失効ボタンで DELETE が呼ばれる", async () => {
    render(<ConnectionAdmin appId={APP_ID} />);
    await waitFor(() => expect(screen.getByTestId("connection-row")).toBeDefined());
    const row = screen.getByTestId("connection-row");
    expect(row.textContent).toContain("stripe");
    expect(row.textContent).toContain("api.stripe.com");
    // secretSource の参照(env 名)は出るが、secret 値そのものは出ない。
    expect(row.textContent).toContain("STRIPE_API_KEY");

    fireEvent.click(screen.getByTestId("revoke-connection"));
    await waitFor(() => {
      expect(
        requests.some((r) => r.method === "DELETE" && r.url === `${CONNECTIONS_PATH}/conn-1`),
      ).toBe(true);
    });
  });

  test("409(同名重複)のサーバ文面を出す", async () => {
    responses.set(`POST ${CONNECTIONS_PATH}`, [
      409,
      { errors: [{ path: "/name", message: "同名の接続が既にあります。" }] },
    ]);
    render(<ConnectionAdmin appId={APP_ID} />);
    await waitFor(() => expect(screen.getByTestId("connection-name-input")).toBeDefined());
    fireEvent.change(screen.getByTestId("connection-name-input"), {
      target: { value: "stripe" },
    });
    fireEvent.change(screen.getByTestId("secret-value-input"), {
      target: { value: "STRIPE_API_KEY" },
    });
    fireEvent.click(screen.getByTestId("issue-connection"));
    await waitFor(() => expect(screen.getByTestId("issue-error")).toBeDefined());
    expect(screen.getByTestId("issue-error").textContent).toContain("同名の接続が既にあります");
  });

  test("400(不正入力)のサーバ文面を出す", async () => {
    responses.set(`POST ${CONNECTIONS_PATH}`, [
      400,
      { errors: [{ path: "/name", message: "name は必須です(1文字以上の接続名)。" }] },
    ]);
    render(<ConnectionAdmin appId={APP_ID} />);
    await waitFor(() => expect(screen.getByTestId("connection-name-input")).toBeDefined());
    fireEvent.change(screen.getByTestId("secret-value-input"), {
      target: { value: "X" },
    });
    fireEvent.click(screen.getByTestId("issue-connection"));
    await waitFor(() => expect(screen.getByTestId("issue-error")).toBeDefined());
    expect(screen.getByTestId("issue-error").textContent).toContain("name は必須です");
  });
});

describe("AppWorkspace の owner 導線(接続の管理)", () => {
  function renderAppAs(role: "owner" | "editor" | "viewer") {
    window.history.replaceState({}, "", `/apps/${APP_ID}`);
    responses.set(`GET /api/apps/${APP_ID}/auth/me`, [
      200,
      { user: { id: "u1", username: "alice", displayName: null, role } },
    ]);
    responses.set(`GET /api/apps/${APP_ID}/manifest`, [200, sampleManifest()]);
    return render(<App />);
  }

  test("owner には接続の管理導線が出る", async () => {
    renderAppAs("owner");
    await waitFor(() => expect(screen.getByTestId("open-connection-admin")).toBeDefined());
  });

  test("viewer には接続の管理導線が出ない", async () => {
    renderAppAs("viewer");
    await waitFor(() => expect(screen.getByTestId("current-role")).toBeDefined());
    expect(screen.queryByTestId("open-connection-admin")).toBeNull();
  });

  test("owner が導線を押すと接続管理画面が開く", async () => {
    renderAppAs("owner");
    await waitFor(() => expect(screen.getByTestId("open-connection-admin")).toBeDefined());
    fireEvent.click(screen.getByTestId("open-connection-admin"));
    await waitFor(() => expect(screen.getByTestId("connection-admin")).toBeDefined());
  });
});
