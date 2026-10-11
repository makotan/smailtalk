/**
 * **行単位の招待の画面**(`V23-M5-T06`。決定 `D-V23-116`・`D-V23-126`・`D-V23-129`、門A `ADR-0532` §Decision 1-8)。
 *
 * このファイルが固定すること:
 *
 * - (N) メニューの「招待」1項目。 `workspace.invitations` を宣言したアプリだけに、文言は `label`。 左・上・「≡ メニュー」、
 *   育成用の版(`App`)と配る版(`RunnerShell`)の両方。 画面0枚でも「招待」が出て、空の文は出ない。 宣言の無いアプリは出ない。
 * - (I) 受け取り画面 `/apps/<id>/invitations`。 1件ごとに表の表示名・代表項目(`null` なら「(表示できません)」)・
 *   招待者・権限・期限と、「承諾」「辞退」。 承諾・辞退は `POST …/invitations/:id` の `action`。 断り(403 の理由・422 の文言)は
 *   その場に出して招待は残す。 成功すると一覧から消える。 未ログインはログイン画面。 宣言の無いアプリは口を呼ばない。
 * - (D) 行の詳細画面。 表に招待の宣言があるときだけ行の招待の一覧の口を呼び、200 なら「招待する」と未承諾の一覧(取消付き)。
 *   404・403 は何も出さない。 発行の後は相手の名前によらず同じ「招待しました」。 宣言の無い表では口を呼ばず、DOM も変えない。
 *
 * 測らないこと(誇張しない): `fetch` を差し替えている(本物のサーバの応答の形は `src/server/row-invitations.test.ts`)。
 * happy-dom であり、幅で「≡」と横一列のどちらが見えるかは測れない。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import type { DetailView, Manifest } from "../../src/kernel/types.ts";
import { App } from "../src/App.tsx";
import type { Role } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { RunnerShell } from "../src/runner-app.tsx";
import { DetailViewRenderer } from "../src/views/DetailViewRenderer.tsx";
import { grantRules, viewRead } from "./role-rules.ts";

const APP_ID = "invite-app";
const OWNER_ROLE: Role = "owner";

type NavigationDeclaration = NonNullable<Manifest["app"]["workspace"]>["navigation"];

/** 招待を宣言した表 `projects` と、宣言の無い表 `notes`。 */
function tables(options: { invitations: boolean }): Manifest["app"]["tables"] {
  return [
    {
      id: "projects",
      name: "案件",
      fields: [{ id: "title", name: "件名", type: "text" }],
      access_control: {
        enabled: true,
        permissions: [
          { id: "reader", name: "閲覧者", read: true, write: false, delete: false },
          { id: "keeper", name: "管理者", read: true, write: true, delete: true },
        ],
        creator_permission: "keeper",
        grant: {
          table: "project_grants",
          target: "project",
          member: "member",
          permission: "permission",
        },
        ...(options.invitations ? { invitations: { grantable: ["reader", "keeper"] } } : {}),
      },
    },
    {
      id: "project_grants",
      name: "案件の付与",
      fields: [
        { id: "project", name: "案件", type: "reference", reference_table: "projects" },
        { id: "member", name: "相手", type: "text" },
        { id: "permission", name: "権限", type: "select", options: ["reader", "keeper"] },
      ],
    },
    {
      id: "notes",
      name: "メモ",
      fields: [{ id: "title", name: "件名", type: "text" }],
    },
  ] as unknown as Manifest["app"]["tables"];
}

function manifestWith(options: {
  workspaceInvitations: boolean;
  withViews: boolean;
  navigation?: NavigationDeclaration;
  myPage?: boolean;
}): Manifest {
  const workspace = {
    ...(options.navigation === undefined ? {} : { navigation: options.navigation }),
    ...(options.myPage === true ? { my_page: {} } : {}),
    ...(options.workspaceInvitations ? { invitations: { label: "届いた招待" } } : {}),
  };
  const base: Manifest = {
    app: {
      id: APP_ID,
      name: "招待の店",
      tables: tables({ invitations: options.workspaceInvitations }),
      views: options.withViews
        ? [
            {
              id: "project-list",
              name: "案件一覧",
              type: "list_view",
              table: "notes",
              columns: ["title"],
            },
          ]
        : [],
      ...(Object.keys(workspace).length === 0 ? {} : { workspace }),
    } as Manifest["app"],
  };
  return options.withViews ? grantRules(base, ["member"], [viewRead("project-list")]) : base;
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

type InboxItem = {
  id: string;
  representative: string | null;
  inviter_name: string;
  permission_name: string;
  table_name: string;
  expires_at: string;
  /** 【`V23-M5-T11`】承諾で所属グループが替わるか(サーバは今日は必ず返す。省いた題材は今日以前の形)。 */
  changes_group?: boolean;
};

/**
 * 育成用の版・配る版の題材の口。 `inbox` は自分宛ての一覧、`answer` は返答の口の応答を決める。
 * `user` が `null` なら未ログイン(`/auth/me` が 401、`/public` も 401)。
 */
function stubApp(options: {
  manifest: Manifest;
  role?: string;
  user?: null;
  inbox?: InboxItem[];
  answer?: (id: string, action: string) => Response;
  /** 自分宛ての一覧の口を 404 にする(表に招待の宣言が1つも無いアプリ。`V23-M5-T10`)。 */
  inboxNotFound?: true;
}): void {
  const user =
    options.user === null
      ? null
      : { id: "u-1", username: "taro", displayName: "太郎", role: options.role ?? "member" };
  let inbox = [...(options.inbox ?? [])];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).split("?")[0] ?? "";
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (path === `/api/apps/${APP_ID}/auth/me`) {
      return Promise.resolve(
        user === null
          ? jsonResponse({ errors: [{ path: "", message: "ログインしてください。" }] }, 401)
          : jsonResponse({ user }),
      );
    }
    if (path === `/api/apps/${APP_ID}/manifest`) {
      return Promise.resolve(
        user === null
          ? jsonResponse({ errors: [{ path: "", message: "ログインしてください。" }] }, 401)
          : jsonResponse(options.manifest),
      );
    }
    if (path === `/api/apps/${APP_ID}/public`) {
      // 未ログインへ開いた公開の一覧画面1枚(入口の公開画面があっても、受け取り画面の場所ではログイン画面)。
      return Promise.resolve(
        jsonResponse({
          app: { id: APP_ID, name: "招待の店" },
          views: [
            {
              id: "public-notes",
              name: "お知らせ",
              type: "list_view",
              table: "notes",
              columns: ["title"],
              tables: [
                {
                  id: "notes",
                  name: "メモ",
                  fields: [{ id: "title", name: "件名", type: "text" }],
                },
              ],
            },
          ],
        }),
      );
    }
    if (path === `/api/apps/${APP_ID}/invitations` && method === "GET") {
      if (options.inboxNotFound === true) {
        return Promise.resolve(
          jsonResponse(
            {
              errors: [{ path: "", message: `GET ${path} に対応するエンドポイントはありません。` }],
            },
            404,
          ),
        );
      }
      return Promise.resolve(jsonResponse({ invitations: inbox }));
    }
    const answer = new RegExp(`^/api/apps/${APP_ID}/invitations/([^/]+)$`).exec(path);
    if (answer !== null && method === "POST") {
      const id = decodeURIComponent(answer[1] ?? "");
      const action = (body as { action?: string } | undefined)?.action ?? "";
      const response =
        options.answer?.(id, action) ??
        jsonResponse({ status: action === "accept" ? "accepted" : "declined" });
      if (response.ok) {
        inbox = inbox.filter((item) => item.id !== id);
      }
      return Promise.resolve(response);
    }
    if (path.startsWith(`/api/apps/${APP_ID}/tables/`)) {
      return Promise.resolve(jsonResponse({ records: [], total: 0 }));
    }
    return Promise.resolve(jsonResponse({ errors: [{ path: "", message: "no stub" }] }, 404));
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

const SHELLS: readonly { readonly label: string; readonly element: () => ReactElement }[] = [
  { label: "育成用の版 App", element: () => <App /> },
  { label: "配る版 RunnerShell", element: () => <RunnerShell appId={APP_ID} /> },
];

const INBOX: InboxItem[] = [
  {
    id: "inv-1",
    representative: "新店舗の立ち上げ",
    inviter_name: "花子",
    permission_name: "閲覧者",
    table_name: "案件",
    expires_at: "2026-10-07T03:04:00.000Z",
  },
  {
    id: "inv-2",
    representative: null,
    inviter_name: "次郎",
    permission_name: "管理者",
    table_name: "案件",
    expires_at: "2026-10-08T03:04:00.000Z",
  },
];

// ---------------------------------------------------------------------------
// (N) メニューの「招待」
// ---------------------------------------------------------------------------

for (const shell of SHELLS) {
  describe(`(N) メニューの「招待」(${shell.label})`, () => {
    test("(N-1) 宣言したアプリでは、左のメニューに label の文言で1項目出て、受け取り画面へのリンクになる", async () => {
      window.history.replaceState({}, "", `/apps/${APP_ID}`);
      stubApp({ manifest: manifestWith({ workspaceInvitations: true, withViews: true }) });
      render(shell.element());
      const nav = await screen.findByTestId("view-list");
      await settle();
      const item = screen.getByTestId("view-list-invitations");
      expect(item.textContent).toBe("届いた招待");
      expect(item.querySelector("a")?.getAttribute("href")).toBe(`/apps/${APP_ID}/invitations`);
      expect([...nav.querySelectorAll("li")].map((row) => row.textContent)).toEqual([
        "届いた招待",
        expect.stringContaining("案件一覧"),
      ]);
    });

    test("(N-2) マイページと両方あれば「マイページ」「招待」の順", async () => {
      window.history.replaceState({}, "", `/apps/${APP_ID}`);
      stubApp({
        manifest: manifestWith({ workspaceInvitations: true, withViews: false, myPage: true }),
      });
      render(shell.element());
      const nav = await screen.findByTestId("view-list");
      await settle();
      expect([...nav.querySelectorAll("li")].map((row) => row.getAttribute("data-testid"))).toEqual(
        ["view-list-my-page", "view-list-invitations"],
      );
    });

    test("(N-3) 画面0枚の人にも「招待」だけを出し、空の文は出さない(左)", async () => {
      window.history.replaceState({}, "", `/apps/${APP_ID}`);
      stubApp({ manifest: manifestWith({ workspaceInvitations: true, withViews: false }) });
      render(shell.element());
      const nav = await screen.findByTestId("view-list");
      await settle();
      expect(screen.queryAllByTestId("view-list-empty")).toHaveLength(0);
      expect([...nav.querySelectorAll("li")].map((row) => row.textContent)).toEqual(["届いた招待"]);
    });

    test("(N-4) 画面0枚の人にも、上の横一列と「≡ メニュー」に「招待」だけを出し、空の文は出さない", async () => {
      window.history.replaceState({}, "", `/apps/${APP_ID}`);
      stubApp({
        manifest: manifestWith({
          workspaceInvitations: true,
          withViews: false,
          navigation: { placement: "top" },
        }),
      });
      render(shell.element());
      const items = await screen.findByTestId("view-list-items");
      await settle();
      expect(screen.queryAllByTestId("view-list-empty")).toHaveLength(0);
      expect(
        [...items.querySelectorAll("li")].map((row) => row.getAttribute("data-testid")),
      ).toEqual(["view-list-invitations"]);
      fireEvent.click(screen.getByTestId("view-menu-toggle"));
      await settle();
      const menu = document.querySelector('[data-slot="overlay-menu"]');
      const menuItems = [...(menu?.querySelectorAll('[role="menuitem"]') ?? [])];
      expect(menuItems.map((item) => item.getAttribute("data-testid"))).toEqual([
        "view-menu-invitations",
      ]);
      expect(menuItems.map((item) => item.textContent)).toEqual(["届いた招待"]);
    });

    test("(N-5 陰性対照) 宣言の無いアプリには「招待」が出ず、画面0枚なら今日どおり空の文が出る", async () => {
      window.history.replaceState({}, "", `/apps/${APP_ID}`);
      stubApp({ manifest: manifestWith({ workspaceInvitations: false, withViews: false }) });
      render(shell.element());
      await screen.findByTestId("view-list-empty");
      await settle();
      expect(screen.queryByTestId("view-list-invitations")).toBeNull();
      expect(calls.some((call) => call.path.endsWith("/invitations"))).toBe(false);
    });

    test("(N-6) 受け取り画面を開いている間は「招待」の項目に aria-current が付く", async () => {
      window.history.replaceState({}, "", `/apps/${APP_ID}/invitations`);
      stubApp({ manifest: manifestWith({ workspaceInvitations: true, withViews: true }) });
      render(shell.element());
      await screen.findByTestId("invitation-inbox");
      expect(screen.getByTestId("view-list-invitations").getAttribute("aria-current")).toBe("page");
    });
  });
}

// ---------------------------------------------------------------------------
// (I) 受け取り画面
// ---------------------------------------------------------------------------

for (const shell of SHELLS) {
  describe(`(I) 受け取り画面(${shell.label})`, () => {
    test("(I-1) 1件ごとに表・代表項目・招待者・権限・期限と、承諾・辞退を出す(代表項目が null なら「(表示できません)」)", async () => {
      window.history.replaceState({}, "", `/apps/${APP_ID}/invitations`);
      stubApp({
        manifest: manifestWith({ workspaceInvitations: true, withViews: true }),
        inbox: INBOX,
      });
      render(shell.element());
      await waitFor(() => {
        expect(screen.getAllByTestId("invitation-inbox-item")).toHaveLength(2);
      });
      const [first, second] = screen.getAllByTestId("invitation-inbox-item");
      const text = (element: HTMLElement | undefined, id: string) =>
        element?.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;
      expect(text(first, "invitation-inbox-table")).toBe("案件");
      expect(text(first, "invitation-inbox-representative")).toBe("新店舗の立ち上げ");
      expect(text(first, "invitation-inbox-inviter")).toContain("花子");
      expect(text(first, "invitation-inbox-permission")).toContain("閲覧者");
      expect(text(first, "invitation-inbox-expires")).toMatch(/2026-10-0[78] \d\d:\d\d/);
      expect(text(second, "invitation-inbox-representative")).toBe("(表示できません)");
      expect(first?.querySelector('[data-testid="invitation-accept"]')?.textContent).toBe("承諾");
      expect(first?.querySelector('[data-testid="invitation-decline"]')?.textContent).toBe("辞退");
      expect(calls.filter((call) => call.path === `/api/apps/${APP_ID}/invitations`)).toHaveLength(
        1,
      );
    });

    test("(I-2) 承諾すると POST の action=accept を送り、一覧から消える", async () => {
      window.history.replaceState({}, "", `/apps/${APP_ID}/invitations`);
      stubApp({
        manifest: manifestWith({ workspaceInvitations: true, withViews: true }),
        inbox: INBOX,
      });
      render(shell.element());
      await waitFor(() => {
        expect(screen.getAllByTestId("invitation-inbox-item")).toHaveLength(2);
      });
      fireEvent.click(screen.getAllByTestId("invitation-accept")[0] as HTMLElement);
      await waitFor(() => {
        expect(screen.getAllByTestId("invitation-inbox-item")).toHaveLength(1);
      });
      const posted = calls.filter((call) => call.method === "POST");
      expect(posted).toEqual([
        {
          method: "POST",
          path: `/api/apps/${APP_ID}/invitations/inv-1`,
          body: { action: "accept" },
        },
      ]);
      expect(screen.getByTestId("invitation-inbox-notice").textContent).toContain("承諾しました");
    });

    test("(I-3) 辞退すると POST の action=decline を送り、一覧から消える。最後の1件が消えると空の文", async () => {
      window.history.replaceState({}, "", `/apps/${APP_ID}/invitations`);
      stubApp({
        manifest: manifestWith({ workspaceInvitations: true, withViews: true }),
        inbox: [INBOX[0] as InboxItem],
      });
      render(shell.element());
      await screen.findByTestId("invitation-inbox-item");
      fireEvent.click(screen.getByTestId("invitation-decline"));
      await screen.findByTestId("invitation-inbox-empty");
      expect(screen.queryAllByTestId("invitation-inbox-item")).toHaveLength(0);
      expect(calls.filter((call) => call.method === "POST")[0]?.body).toEqual({
        action: "decline",
      });
      expect(screen.getByTestId("invitation-inbox-notice").textContent).toContain("辞退しました");
    });

    test("(I-4) 承諾の断り(403 の理由・422 の文言)はその場に出し、招待は一覧に残る", async () => {
      window.history.replaceState({}, "", `/apps/${APP_ID}/invitations`);
      stubApp({
        manifest: manifestWith({ workspaceInvitations: true, withViews: true }),
        inbox: INBOX,
        answer: (id) =>
          id === "inv-1"
            ? jsonResponse(
                { errors: [{ path: "", message: "招待した人がこの行に招待できなくなりました。" }] },
                403,
              )
            : jsonResponse(
                {
                  kind: "app_rejected",
                  errors: [{ path: "", message: "このチームは満員です。" }],
                },
                422,
              ),
      });
      render(shell.element());
      await waitFor(() => {
        expect(screen.getAllByTestId("invitation-inbox-item")).toHaveLength(2);
      });
      fireEvent.click(screen.getAllByTestId("invitation-accept")[0] as HTMLElement);
      fireEvent.click(screen.getAllByTestId("invitation-accept")[1] as HTMLElement);
      await waitFor(() => {
        expect(screen.getAllByTestId("invitation-inbox-error")).toHaveLength(2);
      });
      const [first, second] = screen.getAllByTestId("invitation-inbox-item");
      expect(first?.querySelector('[data-testid="invitation-inbox-error"]')?.textContent).toContain(
        "招待した人がこの行に招待できなくなりました。",
      );
      expect(
        second?.querySelector('[data-testid="invitation-inbox-error"]')?.textContent,
      ).toContain("このチームは満員です。");
      expect(screen.getAllByTestId("invitation-inbox-item")).toHaveLength(2);
    });

    test("P5 D-V23-360 (7): アプリが決めた理由の断り(422 と kind: app_rejected)は、項目の綴り(/member)を前に付けず文だけを出す。 製品の断りは今日どおり", async () => {
      window.history.replaceState({}, "", `/apps/${APP_ID}/invitations`);
      stubApp({
        manifest: manifestWith({ workspaceInvitations: true, withViews: true }),
        inbox: INBOX,
        answer: (id) =>
          id === "inv-1"
            ? jsonResponse(
                {
                  kind: "app_rejected",
                  errors: [{ path: "/member", message: "既に別のグループに所属しています" }],
                },
                422,
              )
            : jsonResponse(
                {
                  errors: [
                    {
                      path: "/member",
                      message: "招待した人がこの行に招待できなくなりました。",
                      hint: "招待した人に頼んでください。",
                    },
                  ],
                },
                400,
              ),
      });
      render(shell.element());
      await waitFor(() => {
        expect(screen.getAllByTestId("invitation-inbox-item")).toHaveLength(2);
      });
      fireEvent.click(screen.getAllByTestId("invitation-accept")[0] as HTMLElement);
      fireEvent.click(screen.getAllByTestId("invitation-accept")[1] as HTMLElement);
      await waitFor(() => {
        expect(screen.getAllByTestId("invitation-inbox-error")).toHaveLength(2);
      });
      const [first, second] = screen.getAllByTestId("invitation-inbox-item");
      expect(first?.querySelector('[data-testid="invitation-inbox-error"]')?.textContent).toBe(
        "既に別のグループに所属しています",
      );
      // 陰性対照: 製品の断り(kind の無い応答)は今日どおり、位置と添える文も出す。
      expect(second?.querySelector('[data-testid="invitation-inbox-error"]')?.textContent).toBe(
        "/member招待した人がこの行に招待できなくなりました。招待した人に頼んでください。",
      );
    });

    test("(I-5) 招待が無ければ空の文", async () => {
      window.history.replaceState({}, "", `/apps/${APP_ID}/invitations`);
      stubApp({ manifest: manifestWith({ workspaceInvitations: true, withViews: true }) });
      render(shell.element());
      const empty = await screen.findByTestId("invitation-inbox-empty");
      expect(empty.textContent).toContain("届いている招待はありません");
    });

    test("(I-8) 表に招待の宣言が1つも無く、自分宛ての一覧の口が 404 なら、断りを出さずに空の文(`V23-M5-T10`)", async () => {
      window.history.replaceState({}, "", `/apps/${APP_ID}/invitations`);
      stubApp({
        manifest: manifestWith({ workspaceInvitations: true, withViews: true }),
        inboxNotFound: true,
      });
      render(shell.element());
      const empty = await screen.findByTestId("invitation-inbox-empty");
      expect(empty.textContent).toContain("届いている招待はありません");
      expect(screen.queryByTestId("invitation-inbox-load-error")).toBeNull();
      expect(screen.getByTestId("invitation-inbox").textContent).not.toContain("エンドポイント");
    });

    test("(I-9) changes_group が真の招待にだけ「承諾すると所属グループが替わる」ことを出す(グループの名前は出さない。`V23-M5-T11`)", async () => {
      window.history.replaceState({}, "", `/apps/${APP_ID}/invitations`);
      stubApp({
        manifest: manifestWith({ workspaceInvitations: true, withViews: true }),
        inbox: [
          { ...(INBOX[0] as InboxItem), changes_group: true },
          { ...(INBOX[1] as InboxItem), changes_group: false },
        ],
      });
      render(shell.element());
      await waitFor(() => {
        expect(screen.getAllByTestId("invitation-inbox-item")).toHaveLength(2);
      });
      const [first, second] = screen.getAllByTestId("invitation-inbox-item");
      const note = first?.querySelector('[data-testid="invitation-inbox-changes-group"]');
      expect(note?.textContent).toBe(
        "承諾すると所属グループが替わり、今のグループを通した権限は無くなります。",
      );
      expect(second?.querySelector('[data-testid="invitation-inbox-changes-group"]')).toBeNull();
    });

    test("(I-6) 未ログインではログイン画面を出し、自分宛ての一覧の口を呼ばない", async () => {
      window.history.replaceState({}, "", `/apps/${APP_ID}/invitations`);
      stubApp({
        manifest: manifestWith({ workspaceInvitations: true, withViews: true }),
        user: null,
        inbox: INBOX,
      });
      render(shell.element());
      await screen.findByTestId("login-page");
      await settle();
      expect(screen.queryByTestId("invitation-inbox")).toBeNull();
      expect(calls.some((call) => call.path === `/api/apps/${APP_ID}/invitations`)).toBe(false);
    });

    test("(I-7) 宣言の無いアプリの /invitations は「無い」と出し、口を呼ばない", async () => {
      window.history.replaceState({}, "", `/apps/${APP_ID}/invitations`);
      stubApp({ manifest: manifestWith({ workspaceInvitations: false, withViews: true }) });
      render(shell.element());
      const missing = await screen.findByTestId("invitations-missing");
      expect(missing.textContent).toContain("このアプリには招待の画面がありません");
      await settle();
      expect(calls.some((call) => call.path.endsWith("/invitations"))).toBe(false);
    });
  });
}

// ---------------------------------------------------------------------------
// (D) 行の詳細画面の「招待する」と未承諾の一覧
// ---------------------------------------------------------------------------

const RECORD_ID = "rec-1";

function detailManifest(options: { invitations: boolean; table?: string }): Manifest {
  const table = options.table ?? "projects";
  return {
    app: {
      id: APP_ID,
      name: "招待の店",
      tables: tables({ invitations: options.invitations }),
      views: [{ id: "detail", name: "詳細", type: "detail_view", table }],
    } as Manifest["app"],
  };
}

type RowList = {
  grantable: { id: string; name: string }[];
  pending: {
    id: string;
    login: string;
    permission: string;
    inviter_name: string;
    expires_at: string;
  }[];
};

function stubDetail(options: {
  table?: string;
  list?: () => Response;
  issue?: () => Response;
  revoke?: () => Response;
}): void {
  const table = options.table ?? "projects";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const path = url.split("?")[0] ?? "";
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const recordPath = `/api/apps/${APP_ID}/tables/${table}/records/${RECORD_ID}`;
    if (path === `${recordPath}/invitations` && method === "GET") {
      return options.list?.() ?? jsonResponse({ errors: [{ path: "", message: "no" }] }, 404);
    }
    if (path === `${recordPath}/invitations` && method === "POST") {
      return (
        options.issue?.() ??
        jsonResponse(
          { invitation: { permission: body?.permission, expires_at: "2026-10-07T00:00:00.000Z" } },
          202,
        )
      );
    }
    if (/^\/api\/apps\/[^/]+\/invitations\/[^/]+$/.test(path) && method === "POST") {
      return options.revoke?.() ?? jsonResponse({ status: "revoked" });
    }
    if (path === recordPath && method === "GET") {
      return jsonResponse({
        record: {
          _id: RECORD_ID,
          _created_at: "2026-01-01T00:00:00Z",
          _updated_at: "2026-01-02T00:00:00Z",
          title: "新店舗の立ち上げ",
        },
      });
    }
    if (method === "GET" && path.includes("/records")) {
      return jsonResponse({ records: [], total: 0 });
    }
    return jsonResponse({ errors: [{ path: "", message: `no stub for ${method} ${url}` }] }, 404);
  }) as typeof fetch;
}

function renderDetail(manifest: Manifest, appId = APP_ID) {
  window.history.replaceState({}, "", `/apps/${appId}/views/detail/records/${RECORD_ID}`);
  const view = manifest.app.views[0] as DetailView;
  return render(
    <RoleProvider role={OWNER_ROLE}>
      <DetailViewRenderer appId={appId} manifest={manifest} view={view} recordId={RECORD_ID} />
    </RoleProvider>,
  );
}

async function waitForDetail(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByTestId("view-renderer-detail_view").textContent).toContain(
      "新店舗の立ち上げ",
    );
  });
  await settle();
}

const ROW_LIST: RowList = {
  grantable: [
    { id: "reader", name: "閲覧者" },
    { id: "keeper", name: "管理者" },
  ],
  pending: [
    {
      id: "inv-9",
      login: "jiro",
      permission: "keeper",
      inviter_name: "太郎",
      expires_at: "2026-10-07T03:04:00.000Z",
    },
  ],
};

describe("(D) 行の詳細画面の招待", () => {
  test("(D-1) 表に宣言があれば行の招待の一覧の口を呼び、200 なら「招待する」と未承諾の一覧を出す", async () => {
    stubDetail({ list: () => jsonResponse(ROW_LIST) });
    renderDetail(detailManifest({ invitations: true }));
    await waitForDetail();
    const panel = await screen.findByTestId("row-invitations");
    const options = [
      ...(panel
        .querySelector('[data-testid="row-invitation-permission"]')
        ?.querySelectorAll("option") ?? []),
    ];
    expect(options.map((option) => [option.getAttribute("value"), option.textContent])).toEqual([
      ["reader", "閲覧者"],
      ["keeper", "管理者"],
    ]);
    expect(screen.getByTestId("row-invitation-submit").textContent).toBe("招待する");
    const rows = screen.getAllByTestId("row-invitation-pending-item");
    expect(rows).toHaveLength(1);
    const text = rows[0]?.textContent ?? "";
    expect(text).toContain("jiro");
    expect(text).toContain("管理者");
    expect(text).toContain("太郎");
    expect(text).toMatch(/2026-10-0[78] \d\d:\d\d/);
    expect(rows[0]?.querySelector('[data-testid="row-invitation-revoke"]')?.textContent).toBe(
      "取り消す",
    );
    expect(
      calls.filter(
        (call) =>
          call.method === "GET" &&
          call.path === `/api/apps/${APP_ID}/tables/projects/records/${RECORD_ID}/invitations`,
      ),
    ).toHaveLength(1);
  });

  test("(D-2) 発行は {login, permission} を送り、相手の名前によらず同じ「招待しました」を出して一覧を取り直す", async () => {
    stubDetail({ list: () => jsonResponse(ROW_LIST) });
    renderDetail(detailManifest({ invitations: true }));
    await waitForDetail();
    await screen.findByTestId("row-invitations");
    fireEvent.change(screen.getByTestId("row-invitation-login"), {
      target: { value: "no-such-user" },
    });
    fireEvent.change(screen.getByTestId("row-invitation-permission"), {
      target: { value: "keeper" },
    });
    fireEvent.click(screen.getByTestId("row-invitation-submit"));
    const issued = await screen.findByTestId("row-invitation-issued");
    expect(issued.textContent).toContain("招待しました");
    expect(issued.textContent).not.toContain("no-such-user");
    const posted = calls.filter((call) => call.method === "POST");
    expect(posted).toEqual([
      {
        method: "POST",
        path: `/api/apps/${APP_ID}/tables/projects/records/${RECORD_ID}/invitations`,
        body: { login: "no-such-user", permission: "keeper" },
      },
    ]);
    await waitFor(() => {
      expect(
        calls.filter((call) => call.method === "GET" && call.path.endsWith("/invitations")),
      ).toHaveLength(2);
    });
    expect((screen.getByTestId("row-invitation-login") as HTMLInputElement).value).toBe("");
  });

  test("(D-3) 発行の断り(400)は理由を出し、「招待しました」は出さない", async () => {
    stubDetail({
      list: () => jsonResponse(ROW_LIST),
      issue: () =>
        jsonResponse({ errors: [{ path: "/login", message: "自分自身は招待できません。" }] }, 400),
    });
    renderDetail(detailManifest({ invitations: true }));
    await waitForDetail();
    await screen.findByTestId("row-invitations");
    fireEvent.change(screen.getByTestId("row-invitation-login"), { target: { value: "taro" } });
    fireEvent.click(screen.getByTestId("row-invitation-submit"));
    const errors = await screen.findByTestId("row-invitation-errors");
    expect(errors.textContent).toContain("自分自身は招待できません。");
    expect(screen.queryByTestId("row-invitation-issued")).toBeNull();
  });

  test("(D-4) 取消は POST …/invitations/:id の action=revoke を送り、一覧から消える", async () => {
    let listed = ROW_LIST;
    stubDetail({
      list: () => jsonResponse(listed),
      revoke: () => {
        listed = { ...ROW_LIST, pending: [] };
        return jsonResponse({ status: "revoked" });
      },
    });
    renderDetail(detailManifest({ invitations: true }));
    await waitForDetail();
    await screen.findByTestId("row-invitation-pending-item");
    fireEvent.click(screen.getByTestId("row-invitation-revoke"));
    await screen.findByTestId("row-invitation-pending-empty");
    expect(screen.queryAllByTestId("row-invitation-pending-item")).toHaveLength(0);
    expect(calls.filter((call) => call.method === "POST")).toEqual([
      { method: "POST", path: `/api/apps/${APP_ID}/invitations/inv-9`, body: { action: "revoke" } },
    ]);
  });

  for (const status of [404, 403]) {
    test(`(D-5) 行の招待の一覧が ${status} なら何も出さない(静かに)`, async () => {
      stubDetail({
        list: () => jsonResponse({ errors: [{ path: "", message: "見つかりません。" }] }, status),
      });
      renderDetail(detailManifest({ invitations: true }));
      await waitForDetail();
      expect(screen.queryByTestId("row-invitations")).toBeNull();
      expect(document.body.textContent).not.toContain("見つかりません。");
      expect(calls.some((call) => call.path.endsWith("/invitations"))).toBe(true);
    });
  }

  test("(D-6) 下見の画面(pv-…)で 403 でも何も出さない", async () => {
    const previewId = "pv-0123456789abcdef0123456789abcdef";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).split("?")[0] ?? "";
      calls.push({ method: init?.method ?? "GET", path, body: undefined });
      if (path.endsWith("/invitations")) {
        return jsonResponse({ errors: [{ path: "", message: "下見では使えません。" }] }, 403);
      }
      if (path === `/api/apps/${previewId}/tables/projects/records/${RECORD_ID}`) {
        return jsonResponse({
          record: {
            _id: RECORD_ID,
            _created_at: "2026-01-01T00:00:00Z",
            _updated_at: "2026-01-02T00:00:00Z",
            title: "新店舗の立ち上げ",
          },
        });
      }
      return jsonResponse({ records: [], total: 0 });
    }) as typeof fetch;
    renderDetail(detailManifest({ invitations: true }), previewId);
    await waitForDetail();
    expect(screen.queryByTestId("row-invitations")).toBeNull();
    expect(document.body.textContent).not.toContain("下見では使えません。");
  });

  test("(D-7 陰性対照) 宣言の無い表では口を呼ばず、招待の部品を出さない", async () => {
    stubDetail({ table: "notes", list: () => jsonResponse(ROW_LIST) });
    renderDetail(detailManifest({ invitations: true, table: "notes" }));
    await waitForDetail();
    expect(screen.queryByTestId("row-invitations")).toBeNull();
    expect(calls.some((call) => call.path.endsWith("/invitations"))).toBe(false);
  });

  test("(D-8 陰性対照) アプリが招待を宣言していなければ(付与の宣言はある表でも)口を呼ばない", async () => {
    stubDetail({ list: () => jsonResponse(ROW_LIST) });
    renderDetail(detailManifest({ invitations: false }));
    await waitForDetail();
    expect(screen.queryByTestId("row-invitations")).toBeNull();
    expect(calls.some((call) => call.path.endsWith("/invitations"))).toBe(false);
  });

  test("(D-9) 宣言の無い表の詳細の DOM は、招待を宣言した表の口が 404 のときと同じ(部品の分だけ増えない)", async () => {
    stubDetail({});
    const { container: a } = renderDetail(detailManifest({ invitations: false }));
    await waitForDetail();
    const without = a.innerHTML;
    cleanup();
    stubDetail({ list: () => jsonResponse({ errors: [{ path: "", message: "no" }] }, 404) });
    const { container: b } = renderDetail(detailManifest({ invitations: true }));
    await waitForDetail();
    expect(b.innerHTML).toBe(without);
  });
});
