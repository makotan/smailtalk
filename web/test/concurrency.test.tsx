/**
 * 楽観ロック(M9-T02)のフロント配線のコンポーネントテスト。
 *
 * 確認点:
 *   1. **If-Match の送出** — form の更新(PATCH)と detail の削除(DELETE)は、
 *      取得したレコードの `_updated_at` を `If-Match` ヘッダに載せる(版源)。
 *   2. **409(版不一致)** — `write-conflict` を出す(401=失効 / 403=権限 とは別扱い)。
 *   3. **409(適用中)** — `apply-in-progress` を出す(版不一致とも別扱い)。
 *
 * ここに出てくるアプリ固有の名前はこのファイル内だけのフィクスチャである。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Manifest } from "../../src/kernel/types.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { DetailViewRenderer } from "../src/views/DetailViewRenderer.tsx";
import { FormRenderer } from "../src/views/FormRenderer.tsx";

const APP_ID = "sample-app";
const RECORD_ID = "note-0001";
const VERSION = "2026-07-21T00:00:00.000Z";

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
      views: [
        { id: "note-list", type: "list_view", table: "notes", columns: ["title"] },
        { id: "note-form", type: "form", table: "notes", fields: ["title"] },
        { id: "note-detail", type: "detail_view", table: "notes" },
      ],
    },
  };
}

const NOTES_PATH = `/api/apps/${APP_ID}/tables/notes/records`;
// 版源はレコードの `_updated_at`。ここに既知の版を入れて If-Match に載ることを確かめる。
const NOTE_ROW = {
  _id: RECORD_ID,
  _created_at: "",
  _updated_at: VERSION,
  title: "ひとつめ",
};

// 文面はサーバ/カーネルの定義に合わせる(`versionConflictError` / `applyInProgressError`)。
const CONFLICT_BODY = {
  errors: [
    {
      path: "",
      message:
        'テーブル "notes" のレコード "note-0001" は、あなたが取得した後に別の操作で変更されています。',
      hint: "最新の内容を取得し直してから、変更をやり直してください。",
    },
  ],
};
const APPLYING_BODY = {
  errors: [
    {
      path: "",
      message: "このアプリは現在変更を適用中です。少し待って再試行してください。",
      hint: "変更の適用(apply_diff)が完了するまで、レコードの作成・更新・削除はできません。",
    },
  ],
};

type Call = { url: string; method: string; headers: Headers };
let requests: Call[];
let responses: Map<string, [number, unknown]>;
let originalFetch: typeof fetch;

beforeEach(() => {
  requests = [];
  responses = new Map();
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    requests.push({ url, method, headers: new Headers(init?.headers) });
    const stubbed = responses.get(`${method} ${url}`);
    if (stubbed !== undefined) {
      return jsonResponse(stubbed[1], stubbed[0]);
    }
    if (method === "GET" && url === `${NOTES_PATH}/${RECORD_ID}`) {
      return jsonResponse({ record: NOTE_ROW }, 200);
    }
    if (method === "GET" && url.startsWith(NOTES_PATH)) {
      return jsonResponse({ records: [NOTE_ROW] }, 200);
    }
    return jsonResponse({ errors: [{ path: "", message: `no stub for ${method} ${url}` }] }, 404);
  }) as typeof fetch;
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

// 書込できるロール。`role` を JSX リテラルで直書きすると biome が ARIA role と誤検知する
// (authz.test.tsx が変数経由で渡しているのと同じ理由)ので、変数にして渡す。
const WRITE_ROLE = "editor" as const;

function renderEditForm() {
  const manifest = sampleManifest();
  const view = manifest.app.views.find((candidate) => candidate.type === "form");
  if (view === undefined || view.type !== "form") {
    throw new Error("fixture broken");
  }
  return render(
    <RoleProvider role={WRITE_ROLE}>
      <FormRenderer appId={APP_ID} manifest={manifest} view={view} recordId={RECORD_ID} />
    </RoleProvider>,
  );
}

function renderDetail() {
  const manifest = sampleManifest();
  const view = manifest.app.views.find((candidate) => candidate.type === "detail_view");
  if (view === undefined || view.type !== "detail_view") {
    throw new Error("fixture broken");
  }
  return render(
    <RoleProvider role={WRITE_ROLE}>
      <DetailViewRenderer appId={APP_ID} manifest={manifest} view={view} recordId={RECORD_ID} />
    </RoleProvider>,
  );
}

/** 直近の指定メソッドの呼び出しを返す。 */
function lastRequest(method: string): Call | undefined {
  return [...requests].reverse().find((request) => request.method === method);
}

describe("form 更新の楽観ロック(M9-T02)", () => {
  test("更新は取得した版を If-Match に載せて PATCH する", async () => {
    responses.set(`PATCH ${NOTES_PATH}/${RECORD_ID}`, [200, { record: NOTE_ROW }]);
    renderEditForm();
    await waitFor(() => expect(screen.getByLabelText(/タイトル/)).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(lastRequest("PATCH")).toBeDefined());
    expect(lastRequest("PATCH")?.headers.get("if-match")).toBe(VERSION);
  });

  test("409(版不一致)なら write-conflict を出す", async () => {
    responses.set(`PATCH ${NOTES_PATH}/${RECORD_ID}`, [409, CONFLICT_BODY]);
    renderEditForm();
    await waitFor(() => expect(screen.getByLabelText(/タイトル/)).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(screen.getByTestId("write-conflict")).toBeDefined());
    expect(screen.queryByTestId("apply-in-progress")).toBeNull();
    expect(screen.queryByTestId("write-forbidden")).toBeNull();
    expect(window.location.pathname).toBe("/"); // 画面遷移しない。
  });

  test("409(適用中)なら apply-in-progress を出す", async () => {
    responses.set(`PATCH ${NOTES_PATH}/${RECORD_ID}`, [409, APPLYING_BODY]);
    renderEditForm();
    await waitFor(() => expect(screen.getByLabelText(/タイトル/)).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(screen.getByTestId("apply-in-progress")).toBeDefined());
    expect(screen.queryByTestId("write-conflict")).toBeNull();
  });
});

describe("detail 削除の楽観ロック(M9-T02)", () => {
  test("削除は取得した版を If-Match に載せて DELETE する", async () => {
    responses.set(`DELETE ${NOTES_PATH}/${RECORD_ID}`, [204, undefined]);
    renderDetail();
    fireEvent.click(await screen.findByTestId("detail-delete"));
    fireEvent.click(screen.getByTestId("detail-delete-execute"));
    await waitFor(() => expect(lastRequest("DELETE")).toBeDefined());
    expect(lastRequest("DELETE")?.headers.get("if-match")).toBe(VERSION);
  });

  test("409(版不一致)なら write-conflict を出す", async () => {
    responses.set(`DELETE ${NOTES_PATH}/${RECORD_ID}`, [409, CONFLICT_BODY]);
    renderDetail();
    fireEvent.click(await screen.findByTestId("detail-delete"));
    fireEvent.click(screen.getByTestId("detail-delete-execute"));
    await waitFor(() => expect(screen.getByTestId("write-conflict")).toBeDefined());
    expect(screen.queryByTestId("apply-in-progress")).toBeNull();
    expect(screen.queryByTestId("write-forbidden")).toBeNull();
  });

  test("409(適用中)なら apply-in-progress を出す", async () => {
    responses.set(`DELETE ${NOTES_PATH}/${RECORD_ID}`, [409, APPLYING_BODY]);
    renderDetail();
    fireEvent.click(await screen.findByTestId("detail-delete"));
    fireEvent.click(screen.getByTestId("detail-delete-execute"));
    await waitFor(() => expect(screen.getByTestId("apply-in-progress")).toBeDefined());
    expect(screen.queryByTestId("write-conflict")).toBeNull();
  });
});
