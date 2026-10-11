/**
 * **名簿への自動登録と行の最後の管理者を、画面で確かめる**(`V23-M1-T10`。上位:
 * `docs/adr/0497-auto-enroll-and-last-row-admin.md`・計画 `docs/plan/v23/00-v23-plan.md` §4 の T10)。
 *
 * このファイルが固定すること:
 *
 * - (N-1) 名簿に `auto_enroll`(`name` つき)を宣言したアプリで、運営でない人の名簿の行の編集画面には
 *   `name` の列の入力欄だけが出る(書けない列 = `account`・グループの列は出さない)。
 * - (N-2) その画面の保存は、`name` の列だけを送る。
 * - (N-3) 陰性対照: 運営(`owner`)の編集画面は今日どおり全部の列を出す。
 * - (N-4) 陰性対照: `auto_enroll` を宣言していない名簿では、運営でない人の編集画面も今日どおり全部の列を出す。
 * - (N-5) 同じ名簿を指す宣言が2つあり、先の宣言に `auto_enroll` が無く後の宣言にだけ `name` があるときも、
 *   (N-1) と同じく `name` の列の入力欄だけが出る(サーバの判定と同じく、`name` を持つ宣言が見つかるまで探す。
 *   `V23-M1-T13`)。
 * - (A-1) 付与表の行の更新が、最後の管理者の 409 で断られたとき、その文面がフォームに出る
 *   (版の食い違いの表示に吸われない)。
 * - (A-2) 付与表の行の削除が同じ 409 で断られたとき、その文面が詳細画面に出る。
 * - (O-1) 運営は「管理者のいない行」の一覧を開け、並ぶ行に理由(管理者がいない / 付与が1件も無い)が出る。
 * - (O-2) 運営でない人には、その一覧を開く導線が出ない。
 * - (O-3) 陰性対照: 行ごとの権限を宣言していないアプリでは、運営にもその導線が出ない。
 *
 * **このファイルが証明しないこと**: `fetch` を差し替えており、本物のサーバを叩いていない。
 * サーバの判定の実測は `src/server/auto-enroll-withdraw.test.ts`・`src/server/last-row-admin.test.ts` が持ち、
 * ブラウザでの実測は `web/e2e/auto-enroll.e2e.ts` が持つ。 入力欄を出さないことは書込を止めることではない
 * (止めるのはサーバの 403)。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Manifest } from "../../src/kernel/types.ts";
import { lastRowAdminError } from "../../src/server/errors.ts";
import { App } from "../src/App.tsx";
import type { Role } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { DetailViewRenderer } from "../src/views/DetailViewRenderer.tsx";
import { FormRenderer } from "../src/views/FormRenderer.tsx";

const APP_ID = "roster-app";
const VERSION = "2026-09-29T00:00:00.000Z";
const OWNER: Role = "owner";
const MEMBER: Role = "member";

/** 利用者に見える 409 の文面(実装の1本から取る。書き写さない)。 */
const LAST_ADMIN = lastRowAdminError();

function jsonResponse(body: unknown, status = 200): Response {
  if (body === undefined) {
    return new Response(null, { status });
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 名簿 `mem`(自動登録の宣言つき/なし)と、付与表 `org_grant` を持つ組織の表 `orgs`。 */
function rosterManifest(declared: boolean): Manifest {
  const members = {
    table: "mem",
    account: "account",
    group: "team",
    ...(declared ? { auto_enroll: { roles: ["member"], name: "display" } } : {}),
  };
  return {
    app: {
      id: APP_ID,
      name: "名簿のアプリ",
      roles: [
        { id: "owner" },
        { id: "editor" },
        { id: "viewer" },
        {
          id: "member",
          name: "メンバー",
          rules: [
            { target: "table", table: "mem", can: ["read", "write"] },
            { target: "table", table: "orgs", can: ["read", "write", "delete"] },
            { target: "table", table: "org_grant", can: ["read", "write", "delete"] },
          ],
        },
      ],
      tables: [
        {
          id: "orgs",
          name: "組織",
          fields: [{ id: "title", name: "組織名", type: "text" }],
          access_control: {
            enabled: true,
            permissions: [
              { id: "reader", name: "閲覧", read: true, write: false, delete: false },
              { id: "keeper", name: "管理", read: true, write: true, delete: true },
            ],
            creator_permission: "keeper",
            grant: {
              table: "org_grant",
              target: "org",
              member: "member",
              permission: "permission",
            },
            members,
          },
        },
        {
          id: "mem",
          name: "名簿",
          fields: [
            { id: "account", name: "利用者ID", type: "text" },
            { id: "display", name: "表示名", type: "text" },
            { id: "team", name: "班", type: "text" },
          ],
        },
        {
          id: "org_grant",
          name: "組織の付与",
          fields: [
            { id: "org", name: "組織", type: "reference", reference_table: "orgs" },
            { id: "member", name: "相手", type: "reference", reference_table: "mem" },
            { id: "permission", name: "権限", type: "select", options: ["reader", "keeper"] },
          ],
        },
      ],
      views: [
        { id: "mem-form", type: "form", table: "mem", fields: ["account", "display", "team"] },
        {
          id: "grant-form",
          type: "form",
          table: "org_grant",
          fields: ["org", "member", "permission"],
        },
        { id: "grant-detail", type: "detail_view", table: "org_grant" },
      ],
    },
  } as unknown as Manifest;
}

/**
 * 同じ名簿 `mem` を指す宣言が2つあるアプリ(N-5)。 先の表 `projects` の宣言は `auto_enroll` を書かず、
 * 後の表 `orgs` の宣言にだけ `auto_enroll.name` がある(片方だけが書く形は適用時に許されている)。
 */
function twoDeclarationsManifest(): Manifest {
  const base = rosterManifest(true) as unknown as {
    app: { tables: Record<string, unknown>[] };
  };
  const projects = {
    id: "projects",
    name: "案件",
    fields: [{ id: "title", name: "案件名", type: "text" }],
    access_control: {
      enabled: true,
      permissions: [{ id: "reader", name: "閲覧", read: true, write: false, delete: false }],
      grant: { table: "org_grant", target: "org", member: "member", permission: "permission" },
      members: { table: "mem", account: "account", group: "team" },
    },
  };
  return {
    ...base,
    app: { ...base.app, tables: [projects, ...base.app.tables] },
  } as unknown as Manifest;
}

/** 行ごとの権限を1つも宣言していないアプリ(O-3 の陰性対照)。 */
function plainManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "名簿のアプリ",
      tables: [
        { id: "notes", name: "メモ", fields: [{ id: "title", name: "件名", type: "text" }] },
      ],
      views: [{ id: "note-list", type: "list_view", table: "notes", columns: ["title"] }],
    },
  } as unknown as Manifest;
}

const MEM_PATH = `/api/apps/${APP_ID}/tables/mem/records`;
const GRANT_PATH = `/api/apps/${APP_ID}/tables/org_grant/records`;
const MEM_ROW = {
  _id: "mem-alice",
  _created_at: VERSION,
  _updated_at: VERSION,
  account: "u-alice",
  display: "alice",
  team: null,
};
const GRANT_ROW = {
  _id: "grant-1",
  _created_at: VERSION,
  _updated_at: VERSION,
  org: "org-1",
  member: "mem-alice",
  permission: "keeper",
};

type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let routes: Map<string, [number, unknown]>;
let originalFetch: typeof fetch;

beforeEach(() => {
  calls = [];
  routes = new Map();
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = (typeof input === "string" ? input : input.toString()).split("?")[0] ?? "";
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    const hit = routes.get(`${method} ${url}`);
    if (hit !== undefined) {
      return jsonResponse(hit[1], hit[0]);
    }
    return jsonResponse({ errors: [{ path: "", message: `no stub for ${method} ${url}` }] }, 404);
  }) as typeof fetch;
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.history.replaceState({}, "", "/");
});

function renderForm(manifest: Manifest, viewId: string, recordId: string, role: Role) {
  const view = manifest.app.views.find((candidate) => candidate.id === viewId);
  if (view === undefined || view.type !== "form") {
    throw new Error("fixture broken");
  }
  return render(
    <RoleProvider role={role} actorId="u-alice">
      <FormRenderer appId={APP_ID} manifest={manifest} view={view} recordId={recordId} />
    </RoleProvider>,
  );
}

describe("本人の名前の列(名簿の編集画面)", () => {
  beforeEach(() => {
    routes.set(`GET ${MEM_PATH}/mem-alice`, [200, { record: MEM_ROW }]);
    routes.set(`GET /api/apps/${APP_ID}/auth/users`, [
      403,
      { errors: [{ path: "", message: "運営だけ" }] },
    ]);
  });

  test("(N-1) 宣言した名簿では、運営でない人の編集画面に name の列の入力欄だけが出る", async () => {
    renderForm(rosterManifest(true), "mem-form", "mem-alice", MEMBER);
    await waitFor(() => expect(screen.getByLabelText(/表示名/)).toBeDefined());
    expect(screen.queryByLabelText(/利用者ID/)).toBeNull();
    expect(screen.queryByLabelText(/班/)).toBeNull();
  });

  test("(N-2) その画面の保存は name の列だけを送る", async () => {
    routes.set(`PATCH ${MEM_PATH}/mem-alice`, [200, { record: { ...MEM_ROW, display: "アリス" } }]);
    renderForm(rosterManifest(true), "mem-form", "mem-alice", MEMBER);
    const input = (await screen.findByLabelText(/表示名/)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "アリス" } });
    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true));
    const patch = calls.find((call) => call.method === "PATCH");
    expect(patch?.body).toEqual({ display: "アリス" });
  });

  test("(N-3) 陰性対照: 運営の編集画面は今日どおり全部の列を出す", async () => {
    renderForm(rosterManifest(true), "mem-form", "mem-alice", OWNER);
    await waitFor(() => expect(screen.getByLabelText(/表示名/)).toBeDefined());
    expect(screen.getByLabelText(/班/)).toBeDefined();
    expect(screen.getByTestId("view-renderer-form").textContent).toContain("利用者ID");
  });

  test("(N-4) 陰性対照: 宣言していない名簿では、運営でない人の編集画面も今日どおり全部の列を出す", async () => {
    renderForm(rosterManifest(false), "mem-form", "mem-alice", MEMBER);
    await waitFor(() => expect(screen.getByLabelText(/表示名/)).toBeDefined());
    expect(screen.getByLabelText(/班/)).toBeDefined();
    expect(screen.getByTestId("view-renderer-form").textContent).toContain("利用者ID");
  });
});

describe("本人の名前の列(同じ名簿を指す宣言が2つ)", () => {
  beforeEach(() => {
    routes.set(`GET ${MEM_PATH}/mem-alice`, [200, { record: MEM_ROW }]);
    routes.set(`GET /api/apps/${APP_ID}/auth/users`, [
      403,
      { errors: [{ path: "", message: "運営だけ" }] },
    ]);
  });

  test("(N-5) 先の宣言に auto_enroll が無くても、後の宣言の name の列の入力欄だけが出る", async () => {
    renderForm(twoDeclarationsManifest(), "mem-form", "mem-alice", MEMBER);
    await waitFor(() => expect(screen.getByLabelText(/表示名/)).toBeDefined());
    expect(screen.queryByLabelText(/利用者ID/)).toBeNull();
    expect(screen.queryByLabelText(/班/)).toBeNull();
  });
});

describe("最後の管理者の 409 の文面", () => {
  beforeEach(() => {
    routes.set(`GET ${GRANT_PATH}/grant-1`, [200, { record: GRANT_ROW }]);
    routes.set(`GET /api/apps/${APP_ID}/tables/orgs/records`, [200, { records: [], total: 0 }]);
    routes.set(`GET ${MEM_PATH}`, [200, { records: [MEM_ROW], total: 1 }]);
  });

  test("(A-1) 付与の行の更新が 409 で断られたら、その文面がフォームに出る", async () => {
    routes.set(`PATCH ${GRANT_PATH}/grant-1`, [409, { errors: [LAST_ADMIN] }]);
    renderForm(rosterManifest(true), "grant-form", "grant-1", MEMBER);
    await waitFor(() => expect(screen.getByRole("button", { name: /保存/ })).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() =>
      expect(screen.getByTestId("view-renderer-form").textContent).toContain(LAST_ADMIN.message),
    );
    expect(screen.queryByTestId("write-conflict")).toBeNull();
    expect(screen.queryByTestId("write-forbidden")).toBeNull();
  });

  test("(A-2) 付与の行の削除が 409 で断られたら、その文面が詳細画面に出る", async () => {
    routes.set(`DELETE ${GRANT_PATH}/grant-1`, [409, { errors: [LAST_ADMIN] }]);
    const manifest = rosterManifest(true);
    const view = manifest.app.views.find((candidate) => candidate.id === "grant-detail");
    if (view === undefined || view.type !== "detail_view") {
      throw new Error("fixture broken");
    }
    render(
      <RoleProvider role={MEMBER} actorId="u-alice">
        <DetailViewRenderer appId={APP_ID} manifest={manifest} view={view} recordId="grant-1" />
      </RoleProvider>,
    );
    fireEvent.click(await screen.findByTestId("detail-delete"));
    fireEvent.click(screen.getByTestId("detail-delete-execute"));
    await waitFor(() => expect(document.body.textContent).toContain(LAST_ADMIN.message));
    expect(screen.queryByTestId("write-conflict")).toBeNull();
  });
});

describe("管理者のいない行の一覧(運営だけ)", () => {
  function signIn(role: string, manifest: Manifest): void {
    window.history.replaceState({}, "", `/apps/${APP_ID}`);
    routes.set(`GET /api/apps/${APP_ID}/auth/me`, [
      200,
      { user: { id: "u-owner", username: "owner", displayName: null, role } },
    ]);
    routes.set(`GET /api/apps/${APP_ID}/manifest`, [200, manifest]);
  }

  test("(O-1) 運営は一覧を開け、並ぶ行に理由が出る", async () => {
    signIn("owner", rosterManifest(true));
    routes.set(`GET /api/apps/${APP_ID}/tables/orgs/unreachable-records`, [
      200,
      {
        records: [
          {
            _id: "org-1",
            _created_at: VERSION,
            _updated_at: VERSION,
            title: "北支店",
            _orphan_reason: "no_admin",
          },
          {
            _id: "org-2",
            _created_at: VERSION,
            _updated_at: VERSION,
            title: "南支店",
            _orphan_reason: "no_grants",
          },
        ],
        total: 2,
      },
    ]);
    render(<App />);
    fireEvent.click(await screen.findByTestId("open-orphan-records"));
    const panel = await screen.findByTestId("orphan-records-admin");
    await waitFor(() => expect(panel.textContent).toContain("北支店"));
    expect(panel.textContent).toContain("組織");
    expect(panel.textContent).toContain("管理者がいません");
    expect(panel.textContent).toContain("南支店");
    expect(panel.textContent).toContain("付与が1件もありません");
    // 読取専用: 一覧から付与を書く導線を置かない。
    expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
  });

  test("(O-2) 運営でない人には一覧を開く導線が出ない", async () => {
    signIn("member", rosterManifest(true));
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("current-user")).toBeDefined());
    expect(screen.queryByTestId("open-orphan-records")).toBeNull();
  });

  test("(O-3) 陰性対照: 行ごとの権限を宣言していないアプリでは、運営にも導線が出ない", async () => {
    signIn("owner", plainManifest());
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("current-user")).toBeDefined());
    expect(screen.queryByTestId("open-orphan-records")).toBeNull();
    expect(screen.getByTestId("open-user-admin")).toBeDefined();
  });
});
