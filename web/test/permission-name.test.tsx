/**
 * **付与の表の権限の欄の値を、宣言の名前で出す**(`V23-M12-T03`。決定 `D-V23-356`、門A `ADR-0571` §Decision 1-3)。
 *
 * - P1: 一覧(行とカード)・詳細・子の一覧・入力フォームの選択肢の見出し・変更履歴の項目の変更前と変更後・
 *   変更履歴の招待の件の「権限:」が、宣言の名前(`permissions[].name`)で出る。
 * - P2: 1つの付与の表を2つの表が使う定義で、子の一覧は親の表(子の一覧の `via` が指す表)の宣言の名を引き、
 *   親の決まらない画面(一覧・詳細・フォーム)は、同じ ID に違う名が付いていればその ID だけ ID のまま出す。
 *   宣言に無い ID はそのまま出す。
 * - N1: 宣言の無い表の `select`・付与の表でも権限の欄でない `select` は今日どおり(値のまま)。
 * - N2: 選んで保存した値は ID(フォームが送る本文を見る)。 HTTP と AI の口の応答が ID のままであることは
 *   `src/server/last-row-admin.test.ts` の `V23-M12-T03` の節が持つ(サーバは1バイトも変えていない)。
 *
 * **このファイルが証明しないこと**: `fetch` を差し替えており、本物のサーバを叩いていない。 happy-dom であり、
 * chromium では `web/e2e/permission-name.e2e.ts` が見る。 ここに出てくるアプリ固有の名前はこのファイル内だけの題材である。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Manifest } from "../../src/kernel/types.ts";
import type { Role } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { DetailViewRenderer } from "../src/views/DetailViewRenderer.tsx";
import { FormRenderer } from "../src/views/FormRenderer.tsx";
import { ListViewRenderer } from "../src/views/ListViewRenderer.tsx";

const APP_ID = "perm-name-app";
const OWNER: Role = "owner";
const VERSION = "2026-10-04T00:00:00.000Z";
const API = `/api/apps/${APP_ID}/tables`;

/** 付与の表 `grants` を、組織(`orgs`)と案件(`projects`)の2つの表が使う。 `shared` だけ名が割れる。 */
function manifest(options: { cardList?: boolean } = {}): Manifest {
  const grant = (target: string) => ({
    table: "grants",
    target,
    member: "member",
    permission: "perm",
  });
  return {
    app: {
      id: APP_ID,
      name: "権限の名の題材",
      tables: [
        {
          id: "members",
          name: "名簿",
          representative_field: "name",
          fields: [{ id: "name", name: "名前", type: "text" }],
        },
        {
          id: "orgs",
          name: "組織",
          history: true,
          representative_field: "title",
          fields: [{ id: "title", name: "組織名", type: "text" }],
          access_control: {
            enabled: true,
            permissions: [
              { id: "owner", name: "オーナー", read: true, write: true, delete: true },
              { id: "member", name: "メンバー", read: true, write: false, delete: false },
              { id: "shared", name: "組織の共有", read: true, write: false, delete: false },
            ],
            creator_permission: "owner",
            grant: grant("target_org"),
          },
        },
        {
          id: "projects",
          name: "案件",
          representative_field: "title",
          fields: [{ id: "title", name: "案件名", type: "text" }],
          access_control: {
            enabled: true,
            permissions: [
              { id: "owner", name: "オーナー", read: true, write: true, delete: true },
              { id: "shared", name: "案件の共有", read: true, write: false, delete: false },
            ],
            creator_permission: "owner",
            grant: grant("target_proj"),
          },
        },
        {
          id: "grants",
          name: "付与",
          history: true,
          fields: [
            { id: "target_org", name: "組織", type: "reference", reference_table: "orgs" },
            { id: "target_proj", name: "案件", type: "reference", reference_table: "projects" },
            { id: "member", name: "相手", type: "reference", reference_table: "members" },
            {
              id: "perm",
              name: "権限",
              type: "select",
              options: ["owner", "member", "shared", "zz"],
            },
            { id: "note_kind", name: "種別", type: "select", options: ["owner", "x"] },
          ],
        },
        {
          id: "tasks",
          name: "作業",
          fields: [{ id: "status", name: "状態", type: "select", options: ["owner", "done"] }],
        },
      ],
      views: [
        {
          id: "grant-list",
          type: "list_view",
          table: "grants",
          columns: ["perm", "note_kind"],
          ...(options.cardList === true ? { preset_list_shape: "card" } : {}),
        },
        {
          id: "grant-detail",
          type: "detail_view",
          table: "grants",
          fields: ["perm", "note_kind"],
          history: true,
        },
        { id: "grant-form", type: "form", table: "grants", fields: ["perm", "note_kind"] },
        {
          id: "org-detail",
          type: "detail_view",
          table: "orgs",
          fields: ["title"],
          history: true,
          related: [{ table: "grants", via: "target_org", columns: ["perm", "note_kind"] }],
        },
        {
          id: "proj-detail",
          type: "detail_view",
          table: "projects",
          fields: ["title"],
          related: [{ table: "grants", via: "target_proj", columns: ["perm", "note_kind"] }],
        },
        { id: "task-list", type: "list_view", table: "tasks", columns: ["status"] },
      ],
    },
  } as unknown as Manifest;
}

const row = (id: string, values: Record<string, unknown>) => ({
  _id: id,
  _created_at: VERSION,
  _updated_at: VERSION,
  ...values,
});

const ORG = row("org-1", { title: "北の組織" });
const PROJ = row("proj-1", { title: "東の案件" });
const ORG_GRANTS = [
  row("g1", { target_org: "org-1", perm: "owner", note_kind: "owner" }),
  row("g2", { target_org: "org-1", perm: "member", note_kind: "x" }),
  row("g3", { target_org: "org-1", perm: "shared", note_kind: "x" }),
];
const PROJ_GRANTS = [row("g4", { target_proj: "proj-1", perm: "shared", note_kind: "owner" })];
const ALL_GRANTS = [...ORG_GRANTS, ...PROJ_GRANTS, row("g5", { perm: "zz", note_kind: "x" })];
const TASK = row("t1", { status: "owner" });

/** 履歴の1ページ(表ごと)。 */
let historyItems: Record<string, unknown[]>;
let sent: { method: string; url: string; body: unknown }[];
let originalFetch: typeof fetch;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  historyItems = {};
  sent = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
      sent.push({ method, url, body });
      return json({ record: row("g-new", body as Record<string, unknown>) }, 201);
    }
    const [path, query = ""] = url.split("?");
    const params = new URLSearchParams(query);
    const single = (record: Record<string, unknown>, table: string) => {
      const items = historyItems[table];
      return json(
        params.get("history") === "1" && items !== undefined
          ? { record, history: { items, total: items.length, offset: 0, limit: 50 } }
          : { record },
      );
    };
    if (path === `${API}/orgs/records/org-1`) {
      return single(ORG, "orgs");
    }
    if (path === `${API}/projects/records/proj-1`) {
      return single(PROJ, "projects");
    }
    if (path?.startsWith(`${API}/grants/records/`)) {
      const id = path.slice(`${API}/grants/records/`.length);
      const found = ALL_GRANTS.find((item) => item._id === id);
      return found === undefined ? json({ errors: [] }, 404) : single(found, "grants");
    }
    if (path === `${API}/grants/records`) {
      if (params.get("filter.target_org") === "org-1") {
        return json({ records: ORG_GRANTS, total: ORG_GRANTS.length });
      }
      if (params.get("filter.target_proj") === "proj-1") {
        return json({ records: PROJ_GRANTS, total: PROJ_GRANTS.length });
      }
      return json({ records: ALL_GRANTS, total: ALL_GRANTS.length });
    }
    if (path === `${API}/tasks/records`) {
      return json({ records: [TASK], total: 1 });
    }
    if (path?.endsWith("/records")) {
      return json({ records: [], total: 0 });
    }
    return json({ errors: [{ path: "", message: `no stub for ${method} ${url}` }] }, 404);
  }) as typeof fetch;
  window.history.replaceState({}, "", `/apps/${APP_ID}`);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.history.replaceState({}, "", "/");
});

function viewOf(built: Manifest, id: string) {
  const view = built.app.views.find((candidate) => candidate.id === id);
  if (view === undefined) {
    throw new Error(`fixture broken: ${id}`);
  }
  return view;
}

function renderList(viewId: string, options: { cardList?: boolean } = {}) {
  const built = manifest(options);
  const view = viewOf(built, viewId);
  if (view.type !== "list_view") {
    throw new Error("fixture broken");
  }
  return render(
    <RoleProvider role={OWNER} actorId="u-owner">
      <ListViewRenderer appId={APP_ID} manifest={built} view={view} />
    </RoleProvider>,
  );
}

function renderDetail(viewId: string, recordId: string) {
  const built = manifest();
  const view = viewOf(built, viewId);
  if (view.type !== "detail_view") {
    throw new Error("fixture broken");
  }
  return render(
    <RoleProvider role={OWNER} actorId="u-owner">
      <DetailViewRenderer appId={APP_ID} manifest={built} view={view} recordId={recordId} />
    </RoleProvider>,
  );
}

function renderForm() {
  const built = manifest();
  const view = viewOf(built, "grant-form");
  if (view.type !== "form") {
    throw new Error("fixture broken");
  }
  return render(
    <RoleProvider role={OWNER} actorId="u-owner">
      <FormRenderer appId={APP_ID} manifest={built} view={view} />
    </RoleProvider>,
  );
}

/** 器の中の `select` の値の表示を、出た順に読む。 */
function selectTexts(container: HTMLElement): string[] {
  return within(container)
    .queryAllByTestId("field-value-select")
    .map((element) => element.textContent ?? "");
}

describe("V23-M12-T03 D-V23-356: 付与の表の権限の欄は宣言の名前で出る", () => {
  test("P1 D-V23-356: 一覧の行で、権限の欄は宣言の名前、権限の欄でない select は値のまま(P2: 名の割れる ID と宣言に無い ID は値のまま)", async () => {
    renderList("grant-list");
    await waitFor(() => expect(screen.getAllByTestId("list-row")).toHaveLength(5));
    const rows = screen.getAllByTestId("list-row").map(selectTexts);
    expect(rows).toEqual([
      ["オーナー", "owner"],
      ["メンバー", "x"],
      ["shared", "x"],
      ["shared", "owner"],
      ["zz", "x"],
    ]);
  });

  test("P1 D-V23-356: 一覧のカードでも同じ", async () => {
    renderList("grant-list", { cardList: true });
    await waitFor(() => expect(screen.getAllByTestId("list-card")).toHaveLength(5));
    const cards = screen.getAllByTestId("list-card").map(selectTexts);
    expect(cards).toEqual([
      ["オーナー", "owner"],
      ["メンバー", "x"],
      ["shared", "x"],
      ["shared", "owner"],
      ["zz", "x"],
    ]);
  });

  test("P1 D-V23-356: 詳細で、権限の欄は宣言の名前、権限の欄でない select は値のまま", async () => {
    renderDetail("grant-detail", "g1");
    const perm = await screen.findByTestId("detail-field-perm");
    await waitFor(() => expect(selectTexts(perm)).toEqual(["オーナー"]));
    expect(selectTexts(screen.getByTestId("detail-field-note_kind"))).toEqual(["owner"]);
  });

  test("P2 D-V23-356: 子の一覧は親の表の宣言の名を引く(組織の詳細では「組織の共有」、案件の詳細では「案件の共有」)", async () => {
    renderDetail("org-detail", "org-1");
    await waitFor(() => expect(screen.getAllByTestId("related-row")).toHaveLength(3));
    expect(screen.getAllByTestId("related-row").map(selectTexts)).toEqual([
      ["オーナー", "owner"],
      ["メンバー", "x"],
      ["組織の共有", "x"],
    ]);
    cleanup();
    renderDetail("proj-detail", "proj-1");
    await waitFor(() => expect(screen.getAllByTestId("related-row")).toHaveLength(1));
    expect(screen.getAllByTestId("related-row").map(selectTexts)).toEqual([
      ["案件の共有", "owner"],
    ]);
  });

  test("P1 D-V23-356: 入力フォームの選択肢の見出しは宣言の名前、値は ID。権限の欄でない select の見出しは値のまま", async () => {
    renderForm();
    const perm = (await screen.findByTestId("field-input-perm")) as HTMLSelectElement;
    const options = [...perm.querySelectorAll("option")];
    expect(options.map((option) => option.value)).toEqual(["", "owner", "member", "shared", "zz"]);
    expect(options.map((option) => option.textContent)).toEqual([
      "",
      "オーナー",
      "メンバー",
      "shared",
      "zz",
    ]);
    const kind = screen.getByTestId("field-input-note_kind") as HTMLSelectElement;
    expect([...kind.querySelectorAll("option")].map((option) => option.textContent)).toEqual([
      "",
      "owner",
      "x",
    ]);
  });

  test("N2 D-V23-356: 名前の見出しを選んで保存すると、送る本文の値は ID", async () => {
    renderForm();
    const perm = (await screen.findByTestId("field-input-perm")) as HTMLSelectElement;
    fireEvent.change(perm, { target: { value: "member" } });
    expect(perm.selectedOptions[0]?.textContent).toBe("メンバー");
    fireEvent.click(await screen.findByRole("button", { name: /保存/ }));
    await waitFor(() => expect(sent.length).toBeGreaterThan(0));
    expect(sent[0]?.method).toBe("POST");
    expect((sent[0]?.body as Record<string, unknown> | undefined)?.perm).toBe("member");
  });

  test("P1 D-V23-356: 変更履歴の項目の変更前と変更後は、権限の欄なら宣言の名前、権限の欄でない select は値のまま", async () => {
    historyItems.grants = [
      {
        seq: 1,
        op: "update",
        actor: "人1",
        entry: "http",
        at: "2026-10-04T01:02:03.000Z",
        changes: [
          { field: "perm", before: "member", after: "owner" },
          { field: "note_kind", before: "owner", after: "x" },
        ],
      },
    ];
    renderDetail("grant-detail", "g1");
    const panel = await screen.findByTestId("record-history");
    await waitFor(() =>
      expect(within(panel).getAllByTestId("record-history-item")).toHaveLength(1),
    );
    expect(selectTexts(panel)).toEqual(["メンバー", "オーナー", "owner", "x"]);
  });

  test("P1 D-V23-356: 変更履歴の招待の件の「権限:」は、その行の表の宣言の名前(宣言に無い ID は値のまま)", async () => {
    historyItems.orgs = [
      {
        seq: 2,
        op: "invite",
        actor: "人1",
        entry: "http",
        at: "2026-10-04T01:02:03.000Z",
        changes: [
          { invitee: "佐藤", permission: "shared" },
          { invitee: "鈴木", permission: "zz" },
        ],
      },
    ];
    renderDetail("org-detail", "org-1");
    const panel = await screen.findByTestId("record-history");
    await waitFor(() =>
      expect(within(panel).getAllByTestId("record-history-invite")).toHaveLength(2),
    );
    expect(
      within(panel)
        .getAllByTestId("record-history-invite")
        .map((item) => item.textContent),
    ).toEqual(["招かれた人: 佐藤 / 権限: 組織の共有", "招かれた人: 鈴木 / 権限: zz"]);
  });

  test("N3 D-V23-356: 権限の欄に宣言した強調(emphasis。鍵は ID)は、名前で出しても今日どおり当たる", async () => {
    const built = manifest();
    const grants = built.app.tables.find((table) => table.id === "grants");
    const perm = grants?.fields.find((field) => field.id === "perm") as
      | { emphasis?: Record<string, string> }
      | undefined;
    if (perm === undefined) {
      throw new Error("fixture broken");
    }
    perm.emphasis = { owner: "danger" };
    const view = viewOf(built, "grant-list");
    if (view.type !== "list_view") {
      throw new Error("fixture broken");
    }
    render(
      <RoleProvider role={OWNER} actorId="u-owner">
        <ListViewRenderer appId={APP_ID} manifest={built} view={view} />
      </RoleProvider>,
    );
    await waitFor(() => expect(screen.getAllByTestId("list-row")).toHaveLength(5));
    const first = within(screen.getAllByTestId("list-row")[0] as HTMLElement).getAllByTestId(
      "field-value-select",
    )[0];
    expect(first?.textContent).toBe("オーナー");
    expect(first?.getAttribute("data-emphasis")).toBe("danger");
  });

  test("N1 D-V23-356: 宣言の無い表の select は値のまま(同じ綴りの ID が宣言にあっても)", async () => {
    renderList("task-list");
    await waitFor(() => expect(screen.getAllByTestId("list-row")).toHaveLength(1));
    expect(screen.getAllByTestId("list-row").map(selectTexts)).toEqual([["owner"]]);
  });
});
