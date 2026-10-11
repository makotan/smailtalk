/**
 * **子の一覧で、結んだ相手の行(相手の行を相手にした付与の相手)を名前で出す**(`V23-M12-T04`。決定 `D-V23-357`・
 * `D-V23-367`、門A `ADR-0571` §Decision 1-4 の1)。
 *
 * - P1: 付与の表を子の一覧に出す詳細画面で、サーバが付与の表の一覧に添えて返す相手の行の代表項目
 *   (`principal_labels`)を、相手の欄の表示に使う(一覧・詳細と同じ1本 `withPrincipalLabels`)。 値が `null`
 *   (隠れている・行が無い)なら「(表示できません)」。
 * - N1: 応答に `principal_labels` が無い(相手の行の宣言が無い表・付与の行を読めない人)なら今日どおり。
 *   見る人が相手の行を読める(参照先の一覧に在る)なら、その名前のまま(上書きしない)。
 * - N2: 相手の行の宣言の無い表の子の一覧は今日どおり(参照先の一覧の名前・無ければ「見つかりません」)。
 *
 * **このファイルが証明しないこと**: `fetch` を差し替えており、本物のサーバを叩いていない。 誰に `principal_labels` が
 * 返るか(付与の表の行を読める人だけ)は `src/server/` の検査が持つ。 ここに出てくるアプリ固有の名前はこのファイル内だけの題材である。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { Manifest } from "../../src/kernel/types.ts";
import type { Role } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { DetailViewRenderer } from "../src/views/DetailViewRenderer.tsx";

const APP_ID = "principal-name-app";
const MEMBER: Role = "editor";
const VERSION = "2026-10-04T00:00:00.000Z";
const API = `/api/apps/${APP_ID}/tables`;

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "相手の名前の題材",
      tables: [
        {
          id: "members",
          name: "名簿",
          representative_field: "name",
          fields: [{ id: "name", name: "名前", type: "text" }],
        },
        {
          id: "agencies",
          name: "評価機関",
          representative_field: "title",
          fields: [{ id: "title", name: "名前", type: "text" }],
        },
        {
          id: "orgs",
          name: "組織",
          representative_field: "title",
          fields: [{ id: "title", name: "組織名", type: "text" }],
          access_control: {
            enabled: true,
            permissions: [
              { id: "o_owner", name: "オーナー", read: true, write: true, delete: true },
              { id: "o_member", name: "メンバー", read: true, write: false, delete: false },
            ],
            creator_permission: "o_owner",
            grant: {
              table: "org_grants",
              target: "org",
              member: "member",
              permission: "permission",
              principal_row: { column: "agency", table: "agencies", via: ["ag_member"] },
            },
          },
        },
        {
          id: "org_grants",
          name: "組織の付与",
          fields: [
            { id: "org", name: "組織", type: "reference", reference_table: "orgs" },
            { id: "member", name: "相手", type: "reference", reference_table: "members" },
            { id: "agency", name: "評価機関", type: "reference", reference_table: "agencies" },
            {
              id: "permission",
              name: "権限",
              type: "select",
              options: ["o_owner", "o_member"],
            },
          ],
        },
        {
          id: "projects",
          name: "案件",
          representative_field: "title",
          fields: [{ id: "title", name: "案件名", type: "text" }],
        },
        {
          id: "project_links",
          name: "案件の結び",
          fields: [
            { id: "project", name: "案件", type: "reference", reference_table: "projects" },
            { id: "agency", name: "評価機関", type: "reference", reference_table: "agencies" },
          ],
        },
      ],
      views: [
        {
          id: "org-detail",
          type: "detail_view",
          table: "orgs",
          fields: ["title"],
          related: [{ table: "org_grants", via: "org", columns: ["agency", "permission"] }],
        },
        {
          id: "project-detail",
          type: "detail_view",
          table: "projects",
          fields: ["title"],
          related: [{ table: "project_links", via: "project", columns: ["agency"] }],
        },
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
const PROJECT = row("proj-1", { title: "東の案件" });
const GRANTS = [
  row("g1", { org: "org-1", member: "m1", permission: "o_owner" }),
  row("g2", { org: "org-1", agency: "ag-x", permission: "o_member" }),
  row("g3", { org: "org-1", agency: "ag-y", permission: "o_member" }),
  row("g4", { org: "org-1", agency: "ag-z", permission: "o_member" }),
];
const LINKS = [row("l1", { project: "proj-1", agency: "ag-x" })];

/** 付与の表の一覧に添える相手の名前(行と同じ順・同じ長さ)。 `undefined` なら応答にキーを出さない。 */
let principalLabels: (string | null)[] | undefined;
/** 見る人が読める評価機関の行(参照先の一覧)。 */
let readableAgencies: Record<string, unknown>[];
let originalFetch: typeof fetch;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  principalLabels = undefined;
  readableAgencies = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const [path] = url.split("?");
    if (method !== "GET") {
      return json({ errors: [{ path: "", message: `no stub for ${method} ${url}` }] }, 404);
    }
    if (path === `${API}/orgs/records/org-1`) {
      return json({ record: ORG });
    }
    if (path === `${API}/projects/records/proj-1`) {
      return json({ record: PROJECT });
    }
    if (path === `${API}/org_grants/records`) {
      return json({
        records: GRANTS,
        total: GRANTS.length,
        ...(principalLabels === undefined ? {} : { principal_labels: principalLabels }),
      });
    }
    if (path === `${API}/project_links/records`) {
      return json({
        records: LINKS,
        total: LINKS.length,
        // 相手の行の宣言の無い表には、サーバは名前を添えない。 添えてあっても画面は使わない(N2)。
        principal_labels: ["使わない名前"],
      });
    }
    if (path === `${API}/agencies/records`) {
      return json({ records: readableAgencies, total: readableAgencies.length });
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

function renderDetail(viewId: string, recordId: string) {
  const built = manifest();
  const view = built.app.views.find((candidate) => candidate.id === viewId);
  if (view === undefined || view.type !== "detail_view") {
    throw new Error(`fixture broken: ${viewId}`);
  }
  return render(
    <RoleProvider role={MEMBER} actorId="u-member">
      <DetailViewRenderer appId={APP_ID} manifest={built} view={view} recordId={recordId} />
    </RoleProvider>,
  );
}

/** 子の一覧の各行の最初の列(相手の欄)の文字。 */
async function agencyCells(count: number): Promise<string[]> {
  await waitFor(() => expect(screen.getAllByTestId("related-row")).toHaveLength(count));
  return screen
    .getAllByTestId("related-row")
    .map((element) => element.querySelector("td")?.textContent ?? "");
}

describe("V23-M12-T04 D-V23-357: 子の一覧で結んだ相手を名前で出す", () => {
  test("P1 D-V23-357: 付与の表の子の一覧で、相手の欄はサーバが添えた名前。 null は「(表示できません)」。 相手の欄が空の行は今日どおり「未設定」", async () => {
    principalLabels = [null, "評価機関X", "評価機関Y", null];
    renderDetail("org-detail", "org-1");
    expect(await agencyCells(4)).toEqual(["未設定", "評価機関X", "評価機関Y", "(表示できません)"]);
  });

  test("N1 D-V23-357: 名前が添えられていない応答(付与の行を読めない人・宣言の無い表)は今日どおり「見つかりません」", async () => {
    renderDetail("org-detail", "org-1");
    expect(await agencyCells(4)).toEqual([
      "未設定",
      "(見つかりません: ag-x)",
      "(見つかりません: ag-y)",
      "(見つかりません: ag-z)",
    ]);
  });

  test("N1 D-V23-357: 見る人が相手の行を読める(参照先の一覧に在る)ときは、その名前のまま(添えた名前で上書きしない)", async () => {
    principalLabels = [null, "添えた名前", null, null];
    readableAgencies = [row("ag-x", { title: "読める評価機関X" })];
    renderDetail("org-detail", "org-1");
    expect(await agencyCells(4)).toEqual([
      "未設定",
      "読める評価機関X",
      "(表示できません)",
      "(表示できません)",
    ]);
  });

  test("N2 D-V23-357: 相手の行の宣言の無い表の子の一覧は今日どおり(添えた名前があっても使わない)", async () => {
    renderDetail("project-detail", "proj-1");
    expect(await agencyCells(1)).toEqual(["(見つかりません: ag-x)"]);
  });
});
