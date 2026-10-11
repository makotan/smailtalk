/**
 * **行を相手にした付与とコードの招待の画面**(`V23-M6-T06b`。決定 `D-V23-153`〜`D-V23-156`・`D-V23-166`・`D-V23-169`、
 * 門A `ADR-0502`(`SC-G20`・`SC-G21`)を補う `ADR-0538` §Decision 1-5〜1-7。計画 §25-3 の T08(§25-6 で T06b)・§25-6 軽7)。
 *
 * このファイルが固定すること:
 *
 * - (C) 相手の行(S。部隊)の詳細画面の「この行の招待用コード」。 表がどこかの表の相手の行に指されているときだけコードを見る口を
 *   呼び、200 のときだけ描く(コードが無ければ「発行」、在れば値と「再発行」。再発行は確かめてから `POST`)。 404・403 は静かに
 *   何も描かない。 指されていない表・相手の行の無いアプリでは口を呼ばず、DOM は口が 404 のときと同じ。
 * - (P) 招待した行(R。案件)の詳細の「招待する」。 守る表が相手の行を宣言していれば、ログイン名とコードを切り替えられ、コードで
 *   出すと本文は `{code, permission}`。 未承諾の一覧でコードの招待は相手の行の代表項目(`principal_label`)で出す。 宣言が無ければ
 *   切り替えは出ず、DOM は着手前と同じ。
 * - (I) 受け取り画面(育成用の版と配る版の両方): コードの招待の1件にだけ「受ける行: <代表項目>」。 名前の招待には出ない。
 * - (L) 付与表の一覧と詳細: 相手の列は `principal_labels` / `principal_label` の代表項目で出す(「見つかりません」にしない)。
 *   キーが無ければ今日どおり。
 * - (F) 付与表の入力画面: 相手の列は読むだけ(入力欄を出さない)。 相手の行の無いアプリでは今日どおり入力欄。
 *
 * 測らないこと(誇張しない): `fetch` を差し替えている(本物のサーバの応答の形は `src/server/row-code-invitations.test.ts`・
 * `row-invite-codes.test.ts`・`principal-row-labels.test.ts`)。 happy-dom である。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import type { DetailView, FormView, ListView, Manifest } from "../../src/kernel/types.ts";
import { App } from "../src/App.tsx";
import type { Role } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { RunnerShell } from "../src/runner-app.tsx";
import { DetailViewRenderer } from "../src/views/DetailViewRenderer.tsx";
import { FormRenderer } from "../src/views/FormRenderer.tsx";
import { ListViewRenderer } from "../src/views/ListViewRenderer.tsx";

const APP_ID = "principal-app";
const OWNER_ROLE: Role = "owner";
const UNIT_ID = "unit-a1";
const PROJECT_ID = "project-1";
const GRANT_ID = "grant-1";

/** 部隊(S)・部隊の付与・案件(R。`principal` が真なら相手の行を宣言)・案件の付与。 */
function manifestOf(options: { principal: boolean; invitationsLabel?: string }): Manifest {
  const tables = [
    {
      id: "units",
      name: "部隊",
      representative_field: "title",
      fields: [{ id: "title", name: "部隊名", type: "text" }],
      access_control: {
        enabled: true,
        permissions: [
          { id: "unit_lead", name: "部隊の管理者", read: true, write: true, delete: true },
          { id: "unit_member", name: "部隊員", read: true, write: false, delete: false },
        ],
        creator_permission: "unit_lead",
        grant: { table: "unit_grants", target: "unit", member: "member", permission: "permission" },
      },
    },
    {
      id: "unit_grants",
      name: "部隊の付与",
      fields: [
        { id: "unit", name: "部隊", type: "reference", reference_table: "units" },
        { id: "member", name: "相手", type: "text" },
        { id: "permission", name: "権限", type: "select", options: ["unit_lead", "unit_member"] },
      ],
    },
    {
      id: "projects",
      name: "案件",
      representative_field: "title",
      fields: [{ id: "title", name: "件名", type: "text" }],
      access_control: {
        enabled: true,
        permissions: [
          { id: "p_admin", name: "案件の管理者", read: true, write: true, delete: true },
          { id: "p_worker", name: "担当", read: true, write: true, delete: false },
        ],
        creator_permission: "p_admin",
        grant: {
          table: "project_grants",
          target: "project",
          member: "member",
          permission: "permission",
          ...(options.principal
            ? { principal_row: { column: "unit", table: "units", via: ["unit_member"] } }
            : {}),
        },
        invitations: { grantable: ["p_worker"] },
      },
    },
    {
      id: "project_grants",
      name: "案件の付与",
      fields: [
        { id: "project", name: "案件", type: "reference", reference_table: "projects" },
        { id: "member", name: "相手", type: "text" },
        { id: "unit", name: "相手の部隊", type: "reference", reference_table: "units" },
        { id: "permission", name: "権限", type: "select", options: ["p_admin", "p_worker"] },
      ],
    },
  ];
  const views = [
    { id: "unit-detail", name: "部隊の詳細", type: "detail_view", table: "units" },
    { id: "project-detail", name: "案件の詳細", type: "detail_view", table: "projects" },
    {
      id: "grant-list",
      name: "付与の一覧",
      type: "list_view",
      table: "project_grants",
      columns: ["project", "unit", "permission"],
    },
    { id: "grant-detail", name: "付与の詳細", type: "detail_view", table: "project_grants" },
    {
      id: "grant-form",
      name: "付与の入力",
      type: "form",
      table: "project_grants",
      fields: ["project", "member", "unit", "permission"],
    },
  ];
  return {
    app: {
      id: APP_ID,
      name: "部隊と案件",
      tables,
      views,
      ...(options.invitationsLabel === undefined
        ? {}
        : { workspace: { invitations: { label: options.invitationsLabel } } }),
    },
  } as unknown as Manifest;
}

function viewOf<T>(manifest: Manifest, id: string): T {
  return manifest.app.views.find((view) => view.id === id) as unknown as T;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Call = { method: string; path: string; body: unknown };

let originalFetch: typeof fetch;
let calls: Call[];

type Handler = (call: Call) => Response | undefined;

const ROW_STAMP = { _created_at: "2026-01-01T00:00:00Z", _updated_at: "2026-01-02T00:00:00Z" };

/** 既定の口(行1件・一覧は空・それ以外は 404)の前に `handler` を当てる。 */
function stub(handler: Handler = () => undefined): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const path = url.split("?")[0] ?? "";
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const call = { method, path, body };
    calls.push(call);
    const handled = handler(call);
    if (handled !== undefined) {
      return handled;
    }
    const base = `/api/apps/${APP_ID}`;
    if (method === "GET" && path === `${base}/tables/units/records/${UNIT_ID}`) {
      return jsonResponse({ record: { _id: UNIT_ID, ...ROW_STAMP, title: "部隊A1" } });
    }
    if (method === "GET" && path === `${base}/tables/projects/records/${PROJECT_ID}`) {
      return jsonResponse({ record: { _id: PROJECT_ID, ...ROW_STAMP, title: "案件1" } });
    }
    if (method === "GET" && path.endsWith("/records")) {
      return jsonResponse({ records: [], total: 0 });
    }
    return jsonResponse({ errors: [{ path: "", message: `no stub for ${method} ${path}` }] }, 404);
  }) as typeof fetch;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls = [];
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.history.replaceState({}, "", "/");
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

function renderDetail(manifest: Manifest, viewId: string, recordId: string) {
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/${viewId}/records/${recordId}`);
  return render(
    <RoleProvider role={OWNER_ROLE}>
      <DetailViewRenderer
        appId={APP_ID}
        manifest={manifest}
        view={viewOf<DetailView>(manifest, viewId)}
        recordId={recordId}
      />
    </RoleProvider>,
  );
}

async function waitForText(text: string): Promise<void> {
  await waitFor(() => {
    expect(document.body.textContent).toContain(text);
  });
  await settle();
}

const CODE_PATH = `/api/apps/${APP_ID}/tables/units/records/${UNIT_ID}/invite-code`;
const INVITE_PATH = `/api/apps/${APP_ID}/tables/projects/records/${PROJECT_ID}/invitations`;

const codeCalls = () => calls.filter((call) => call.path === CODE_PATH);

// ---------------------------------------------------------------------------
// (C) 相手の行の詳細画面のコードの欄
// ---------------------------------------------------------------------------

describe("(C) 相手の行の詳細画面のコードの欄", () => {
  test("(C-1) コードが無ければ「まだ発行していません」と「発行」。押すと POST して、コードと「再発行」に替わる", async () => {
    stub((call) => {
      if (call.path !== CODE_PATH) {
        return undefined;
      }
      return call.method === "GET"
        ? jsonResponse({ code: null })
        : jsonResponse({ code: "K7M2Q9XA" });
    });
    renderDetail(manifestOf({ principal: true }), "unit-detail", UNIT_ID);
    const panel = await screen.findByTestId("row-invite-code");
    expect(screen.getByTestId("row-invite-code-none").textContent).toBe("まだ発行していません。");
    expect(screen.getByTestId("row-invite-code-issue").textContent).toBe("発行");
    expect(screen.queryByTestId("row-invite-code-value")).toBeNull();
    fireEvent.click(screen.getByTestId("row-invite-code-issue"));
    await waitFor(() => {
      expect(screen.getByTestId("row-invite-code-value").textContent).toBe("K7M2Q9XA");
    });
    expect(screen.getByTestId("row-invite-code-reissue").textContent).toBe("再発行");
    expect(codeCalls().map((call) => call.method)).toEqual(["GET", "POST"]);
    expect(panel.textContent).not.toContain(UNIT_ID);
  });

  test("(C-2) コードが在れば値と「再発行」。再発行は確かめてから POST する(やめれば送らない)", async () => {
    stub((call) => {
      if (call.path !== CODE_PATH) {
        return undefined;
      }
      return call.method === "GET"
        ? jsonResponse({ code: "ABCD2345" })
        : jsonResponse({ code: "WXYZ6789" });
    });
    renderDetail(manifestOf({ principal: true }), "unit-detail", UNIT_ID);
    await screen.findByTestId("row-invite-code");
    expect(screen.getByTestId("row-invite-code-value").textContent).toBe("ABCD2345");
    fireEvent.click(screen.getByTestId("row-invite-code-reissue"));
    const confirm = await screen.findByTestId("row-invite-code-confirm");
    expect(confirm.textContent).toContain("今のコードでは招待できなくなります");
    fireEvent.click(screen.getByTestId("row-invite-code-confirm-no"));
    await settle();
    expect(screen.queryByTestId("row-invite-code-confirm")).toBeNull();
    expect(codeCalls().filter((call) => call.method === "POST")).toHaveLength(0);
    fireEvent.click(screen.getByTestId("row-invite-code-reissue"));
    fireEvent.click(await screen.findByTestId("row-invite-code-confirm-yes"));
    await waitFor(() => {
      expect(screen.getByTestId("row-invite-code-value").textContent).toBe("WXYZ6789");
    });
    expect(codeCalls().filter((call) => call.method === "POST")).toEqual([
      { method: "POST", path: CODE_PATH, body: {} },
    ]);
  });

  for (const status of [404, 403]) {
    test(`(C-3) コードを見る口が ${status} なら何も描かない(静かに)`, async () => {
      stub((call) =>
        call.path === CODE_PATH
          ? jsonResponse({ errors: [{ path: "", message: "見つかりません。" }] }, status)
          : undefined,
      );
      renderDetail(manifestOf({ principal: true }), "unit-detail", UNIT_ID);
      await waitForText("部隊A1");
      expect(screen.queryByTestId("row-invite-code")).toBeNull();
      expect(document.body.textContent).not.toContain("見つかりません。");
      expect(codeCalls()).toHaveLength(1);
    });
  }

  test("(C-4 陰性対照) 相手の行の無いアプリでは口を呼ばず、DOM は口が 404 のときと同じ", async () => {
    stub();
    const { container: a } = renderDetail(manifestOf({ principal: false }), "unit-detail", UNIT_ID);
    await waitForText("部隊A1");
    const without = a.innerHTML;
    expect(codeCalls()).toHaveLength(0);
    cleanup();
    stub();
    const { container: b } = renderDetail(manifestOf({ principal: true }), "unit-detail", UNIT_ID);
    await waitForText("部隊A1");
    expect(codeCalls()).toHaveLength(1);
    expect(b.innerHTML).toBe(without);
  });

  test("(C-5 陰性対照) 指されていない表(案件)の詳細ではコードの口を呼ばない", async () => {
    stub();
    renderDetail(manifestOf({ principal: true }), "project-detail", PROJECT_ID);
    await waitForText("案件1");
    expect(calls.some((call) => call.path.endsWith("/invite-code"))).toBe(false);
    expect(screen.queryByTestId("row-invite-code")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (P) 招待した行の詳細の「招待する」
// ---------------------------------------------------------------------------

const PENDING = {
  grantable: [{ id: "p_worker", name: "担当" }],
  pending: [
    {
      id: "inv-name",
      login: "jiro",
      permission: "p_worker",
      inviter_name: "太郎",
      expires_at: "2026-10-07T03:04:00.000Z",
    },
    {
      id: "inv-code",
      login: "",
      permission: "p_worker",
      inviter_name: "太郎",
      expires_at: "2026-10-07T03:04:00.000Z",
      principal_label: "部隊A1",
    },
    {
      id: "inv-hidden",
      login: "",
      permission: "p_worker",
      inviter_name: "太郎",
      expires_at: "2026-10-07T03:04:00.000Z",
      principal_label: null,
    },
  ],
};

function stubInvitations(list: unknown = PENDING): void {
  stub((call) => {
    if (call.path !== INVITE_PATH) {
      return undefined;
    }
    return call.method === "GET"
      ? jsonResponse(list)
      : jsonResponse(
          { invitation: { permission: "p_worker", expires_at: "2026-10-07T00:00:00.000Z" } },
          202,
        );
  });
}

describe("(P) 招待した行の詳細の「招待する」", () => {
  test("(P-1) 相手の行を宣言した表では、コードに切り替えて招待でき、本文は {code, permission}", async () => {
    stubInvitations();
    renderDetail(manifestOf({ principal: true }), "project-detail", PROJECT_ID);
    await screen.findByTestId("row-invitations");
    const mode = screen.getByTestId("row-invitation-mode") as HTMLSelectElement;
    expect([...mode.querySelectorAll("option")].map((option) => option.textContent)).toEqual([
      "ログイン名で招待する",
      "相手の行のコードで招待する",
    ]);
    expect(screen.queryByTestId("row-invitation-code")).toBeNull();
    fireEvent.change(mode, { target: { value: "code" } });
    expect(screen.queryByTestId("row-invitation-login")).toBeNull();
    fireEvent.change(screen.getByTestId("row-invitation-code"), {
      target: { value: "K7M2Q9XA" },
    });
    fireEvent.click(screen.getByTestId("row-invitation-submit"));
    const issued = await screen.findByTestId("row-invitation-issued");
    expect(issued.textContent).toContain("招待しました");
    expect(calls.filter((call) => call.method === "POST")).toEqual([
      { method: "POST", path: INVITE_PATH, body: { code: "K7M2Q9XA", permission: "p_worker" } },
    ]);
    expect((screen.getByTestId("row-invitation-code") as HTMLInputElement).value).toBe("");
  });

  test("(P-2) ログイン名に戻せば今日どおり {login, permission}", async () => {
    stubInvitations();
    renderDetail(manifestOf({ principal: true }), "project-detail", PROJECT_ID);
    await screen.findByTestId("row-invitations");
    fireEvent.change(screen.getByTestId("row-invitation-login"), { target: { value: "jiro" } });
    fireEvent.click(screen.getByTestId("row-invitation-submit"));
    await screen.findByTestId("row-invitation-issued");
    expect(calls.filter((call) => call.method === "POST")).toEqual([
      { method: "POST", path: INVITE_PATH, body: { login: "jiro", permission: "p_worker" } },
    ]);
  });

  test("(P-3) 未承諾の一覧で、コードの招待は相手の行の代表項目(null なら「(表示できません)」)で出し、名前の招待はログイン名", async () => {
    stubInvitations();
    renderDetail(manifestOf({ principal: true }), "project-detail", PROJECT_ID);
    await waitFor(() => {
      expect(screen.getAllByTestId("row-invitation-pending-item")).toHaveLength(3);
    });
    const [byName, byCode, hidden] = screen.getAllByTestId("row-invitation-pending-item");
    expect(byName?.textContent).toContain("jiro");
    expect(byName?.querySelector('[data-testid="row-invitation-pending-principal"]')).toBeNull();
    expect(
      byCode?.querySelector('[data-testid="row-invitation-pending-principal"]')?.textContent,
    ).toBe("相手の行: 部隊A1");
    expect(
      hidden?.querySelector('[data-testid="row-invitation-pending-principal"]')?.textContent,
    ).toBe("相手の行: (表示できません)");
  });

  test("(P-4 陰性対照) 相手の行を宣言しない表では切り替えもコードの入力も出さず、今日どおりログイン名の入力だけ", async () => {
    stubInvitations({ ...PENDING, pending: [PENDING.pending[0]] });
    renderDetail(manifestOf({ principal: false }), "project-detail", PROJECT_ID);
    await screen.findByTestId("row-invitations");
    await settle();
    expect(screen.queryByTestId("row-invitation-mode")).toBeNull();
    expect(screen.queryByTestId("row-invitation-code")).toBeNull();
    expect(screen.queryByTestId("row-invitation-pending-principal")).toBeNull();
    expect(screen.getByTestId("row-invitation-login")).not.toBeNull();
    // 部品の中の入力欄の並び(ラベルの文)は M5 のまま。
    expect(
      [...screen.getByTestId("row-invitations").querySelectorAll("label")].map(
        (label) => label.textContent,
      ),
    ).toEqual(["相手のログイン名", "渡す権限"]);
  });
});

// ---------------------------------------------------------------------------
// (I) 受け取り画面(育成用の版と配る版)
// ---------------------------------------------------------------------------

const SHELLS: readonly { readonly label: string; readonly element: () => ReactElement }[] = [
  { label: "育成用の版 App", element: () => <App /> },
  { label: "配る版 RunnerShell", element: () => <RunnerShell appId={APP_ID} /> },
];

const INBOX = [
  {
    id: "inv-name",
    representative: "案件1",
    inviter_name: "花子",
    permission_name: "担当",
    table_name: "案件",
    expires_at: "2026-10-07T03:04:00.000Z",
    changes_group: false,
  },
  {
    id: "inv-code",
    representative: "案件2",
    inviter_name: "花子",
    permission_name: "担当",
    table_name: "案件",
    expires_at: "2026-10-07T03:04:00.000Z",
    changes_group: false,
    principal_label: "部隊A1",
  },
  {
    id: "inv-hidden",
    representative: "案件3",
    inviter_name: "花子",
    permission_name: "担当",
    table_name: "案件",
    expires_at: "2026-10-07T03:04:00.000Z",
    changes_group: false,
    principal_label: null,
  },
];

function stubShell(inbox: unknown[]): void {
  const manifest = manifestOf({ principal: true, invitationsLabel: "届いた招待" });
  stub((call) => {
    const base = `/api/apps/${APP_ID}`;
    if (call.path === `${base}/auth/me`) {
      return jsonResponse({
        user: { id: "u-1", username: "lead", displayName: "", role: "owner" },
      });
    }
    if (call.path === `${base}/manifest`) {
      return jsonResponse(manifest);
    }
    if (call.path === `${base}/invitations` && call.method === "GET") {
      return jsonResponse({ invitations: inbox });
    }
    return undefined;
  });
}

for (const shell of SHELLS) {
  describe(`(I) 受け取り画面(${shell.label})`, () => {
    test("(I-1) コードの招待の1件にだけ「受ける行: <代表項目>」(null なら「(表示できません)」)。名前の招待には出ない", async () => {
      window.history.replaceState({}, "", `/apps/${APP_ID}/invitations`);
      stubShell(INBOX);
      render(shell.element());
      await waitFor(() => {
        expect(screen.getAllByTestId("invitation-inbox-item")).toHaveLength(3);
      });
      const [byName, byCode, hidden] = screen.getAllByTestId("invitation-inbox-item");
      const principal = (element: HTMLElement | undefined) =>
        element?.querySelector('[data-testid="invitation-inbox-principal"]')?.textContent ?? null;
      expect(principal(byName)).toBeNull();
      expect(principal(byCode)).toBe("受ける行: 部隊A1");
      expect(principal(hidden)).toBe("受ける行: (表示できません)");
    });

    test("(I-2 陰性対照) 名前の招待だけなら、1件の DOM に「受ける行」は無い", async () => {
      window.history.replaceState({}, "", `/apps/${APP_ID}/invitations`);
      stubShell([INBOX[0]]);
      render(shell.element());
      await screen.findByTestId("invitation-inbox-item");
      expect(screen.queryByTestId("invitation-inbox-principal")).toBeNull();
      expect(screen.getByTestId("invitation-inbox").textContent).not.toContain("受ける行");
    });
  });
}

// ---------------------------------------------------------------------------
// (L) 付与表の一覧と詳細
// ---------------------------------------------------------------------------

const GRANT_ROWS = [
  { _id: GRANT_ID, ...ROW_STAMP, project: PROJECT_ID, unit: UNIT_ID, permission: "p_worker" },
  { _id: "grant-2", ...ROW_STAMP, project: PROJECT_ID, unit: "unit-b9", permission: "p_worker" },
];

function stubGrantList(labels: (string | null)[] | undefined): void {
  stub((call) => {
    if (
      call.method === "GET" &&
      call.path === `/api/apps/${APP_ID}/tables/project_grants/records`
    ) {
      return jsonResponse({
        records: GRANT_ROWS,
        total: 2,
        ...(labels === undefined ? {} : { principal_labels: labels }),
      });
    }
    return undefined;
  });
}

function renderList(manifest: Manifest) {
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/grant-list`);
  return render(
    <RoleProvider role={OWNER_ROLE}>
      <ListViewRenderer
        appId={APP_ID}
        manifest={manifest}
        view={viewOf<ListView>(manifest, "grant-list")}
      />
    </RoleProvider>,
  );
}

describe("(L) 付与表の一覧と詳細", () => {
  test("(L-1) 一覧の相手の列は principal_labels の代表項目(null なら「(表示できません)」)。「見つかりません」にしない", async () => {
    stubGrantList(["部隊A1", null]);
    renderList(manifestOf({ principal: true }));
    await waitForText("部隊A1");
    const list = screen.getByTestId("view-renderer-list_view");
    expect(list.textContent).toContain("(表示できません)");
    expect(list.textContent).not.toContain(`見つかりません: ${UNIT_ID}`);
    expect(list.textContent).not.toContain("見つかりません: unit-b9");
  });

  test("(L-2 陰性対照) principal_labels が無ければ今日どおり(参照切れの表示)", async () => {
    stubGrantList(undefined);
    renderList(manifestOf({ principal: true }));
    await waitForText(`見つかりません: ${UNIT_ID}`);
    expect(screen.getByTestId("view-renderer-list_view").textContent).not.toContain("部隊A1");
  });

  test("(L-3) 詳細の相手の列は principal_label の代表項目", async () => {
    stub((call) =>
      call.method === "GET" &&
      call.path === `/api/apps/${APP_ID}/tables/project_grants/records/${GRANT_ID}`
        ? jsonResponse({ record: GRANT_ROWS[0], principal_label: "部隊A1" })
        : undefined,
    );
    renderDetail(manifestOf({ principal: true }), "grant-detail", GRANT_ID);
    await waitForText("部隊A1");
    expect(document.body.textContent).not.toContain(`見つかりません: ${UNIT_ID}`);
  });

  test("(L-4 陰性対照) 詳細で principal_label が無ければ今日どおり", async () => {
    stub((call) =>
      call.method === "GET" &&
      call.path === `/api/apps/${APP_ID}/tables/project_grants/records/${GRANT_ID}`
        ? jsonResponse({ record: GRANT_ROWS[0] })
        : undefined,
    );
    renderDetail(manifestOf({ principal: true }), "grant-detail", GRANT_ID);
    await waitForText(`見つかりません: ${UNIT_ID}`);
  });
});

// ---------------------------------------------------------------------------
// (F) 付与表の入力画面
// ---------------------------------------------------------------------------

function renderForm(manifest: Manifest) {
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/grant-form`);
  return render(
    <RoleProvider role={OWNER_ROLE}>
      <FormRenderer
        appId={APP_ID}
        manifest={manifest}
        view={viewOf<FormView>(manifest, "grant-form")}
      />
    </RoleProvider>,
  );
}

describe("(F) 付与表の入力画面", () => {
  test("(F-1) 相手の行を指す欄は読むだけ(入力欄を出さず、承諾でだけ入ると書く)。ほかの欄は今日どおり", async () => {
    stub();
    renderForm(manifestOf({ principal: true }));
    await screen.findByTestId("field-input-project");
    await settle();
    expect(screen.queryByTestId("field-input-unit")).toBeNull();
    expect(screen.getByTestId("field-readonly-unit").textContent).toContain(
      "招待の承諾でだけ入ります",
    );
    expect(screen.getByTestId("field-input-member")).not.toBeNull();
    expect(screen.getByTestId("field-input-permission")).not.toBeNull();
  });

  test("(F-2 陰性対照) 相手の行の無いアプリでは、その欄も今日どおりの入力欄", async () => {
    stub();
    renderForm(manifestOf({ principal: false }));
    await screen.findByTestId("field-input-project");
    await settle();
    expect(screen.getByTestId("field-input-unit")).not.toBeNull();
    expect(screen.queryByTestId("field-readonly-unit")).toBeNull();
  });
});
