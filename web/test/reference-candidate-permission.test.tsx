/**
 * `V7-M6-T02`(`Z-G27`): **付与表の「相手」の候補に、親の行に権限を持つ人だけを出す** ——
 * **表示層(`web/`)だけの検査である。**
 *
 * **審査結果の正は `docs/plan/v7/records/v7-m0.md` §6-3 の `Z-G27` の節**、
 * **完了条件の正は `docs/plan/v7/records/v7-m6.md` の `V7-M6-T02` の行**である。
 * **`Z-G27` は門外(Δ7)であり、`src/kernel/` と `schemas/` に1バイトも触らない。**
 *
 * ## 【最初に書く】**画面に出ないことを、権限の担保にしていない**
 *
 * **候補に出さないことは、書込を止めることではない。**
 * **書込を止めているのはサーバ側の `Z-G33`(`V7-M3-T04`)であって、このファイルではない。**
 * **その拒否が今日も実在することを、(3) が `src/server/access-control-grant-write.test.ts`
 * を名指しで開いて機械的に確かめる。** **本ファイルの絞り込みを1バイトも実装しなくても、
 * サーバの拒否は今日どおり効く**(`v7-m0.md` §6-2 の `Z-G33` 限定 (6) の逐語
 * 「**`Z-G27` を担保にしない**」)。
 *
 * ## このファイルが固定すること
 *
 * | # | 条件 |
 * |---|---|
 * | (1) | 親の行に権限を持つ人だけが候補に並ぶ(持たない人が候補に出ない) |
 * | (2) | 宣言していない表・`inherit_from` が空の表では、候補の集合が着手前と同じである |
 * | (3) | **サーバ側の拒否が別に実在する**(`src/server/access-control-grant-write.test.ts`) |
 * | (4) | ラベルの規則を再実装していない(`referenceLabel` の1本だけを呼ぶ) |
 * | (5) | 新しい読取経路を作っていない(`web/src/api.ts` の export が着手前と同じ) |
 *
 * ## このファイルが証明しないこと(先に書く。誇張しない)
 *
 * 1. **本物の SQLite で1件も測っていない。** `fetch` を差し替えた表示層の検査である。
 * 2. **絞り込みが効くのは既定の選び方(`list`)だけである** —— **`type_filter` /
 *    `search` の2つでは今日と1バイトも変わらない**((6) がそれを実測で固定する)。
 * 3. **候補に出ない人へ書込を試みたときのサーバの応答を、本ファイルは1件も測っていない**
 *    (それは (3) が名指しする `src/server/access-control-grant-write.test.ts` の担当)。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FormView, Manifest } from "../../src/kernel/types.ts";
import type { Role } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { grantMemberScope, restrictReferenceChoices } from "../src/fields/input.tsx";
import { FormRenderer } from "../src/views/FormRenderer.tsx";

/** 書ける立場(文字列リテラルを `role=` に直接書くと biome の a11y 規則に当たる)。 */
const WRITER_ROLE: Role = "owner";

const REPO_ROOT = dirname(dirname(import.meta.dir));
const WEB_SRC = join(dirname(import.meta.dir), "src");
const API_PATH = join(WEB_SRC, "api.ts");
const INPUT_PATH = join(WEB_SRC, "fields", "input.tsx");
/** **サーバ側の壁の実物**(`Z-G33` / `V7-M3-T04`)。**画面ではなくここが書込を止める。** */
const SERVER_GUARD_PATH = join(REPO_ROOT, "src", "server", "access-control-grant-write.test.ts");

const APP_ID = "grant-parent";

const PERMISSIONS = [
  { id: "reader", name: "読める", read: true, write: false, delete: false },
  { id: "writer", name: "書ける", read: true, write: true, delete: false },
  { id: "keeper", name: "任せる", read: true, write: true, delete: true },
  // **読めない権限**(`read: false`)。**この権限しか持たない相手は候補に出ない。**
  { id: "blocked", name: "見えない", read: false, write: false, delete: false },
];

/**
 * `V7-M3-T04`(`Z-G33`)の実証アプリと同じ形の2階層を、表示層から組む。
 *
 * **`projects`(親)→ `issues`(子。`inherit_from: ["project"]`)。**
 * **付与表 `issue_grant` の入力画面が、本ファイルの測定対象である。**
 */
function parentManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "親子のある職場",
      tables: [
        {
          id: "projects",
          name: "プロジェクト",
          fields: [{ id: "title", name: "名前", type: "text", required: true }],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "keeper",
            grant: {
              table: "project_grant",
              target: "project",
              member: "member",
              group: "team",
              permission: "permission",
            },
            members: { table: "app_member", account: "account", group: "team" },
            groups: { table: "app_team" },
          },
        },
        {
          id: "issues",
          name: "課題",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "project", name: "プロジェクト", type: "reference", reference_table: "projects" },
          ],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "keeper",
            inherit_from: ["project"],
            grant: {
              table: "issue_grant",
              target: "issue",
              member: "member",
              group: "team",
              permission: "permission",
            },
            members: { table: "app_member", account: "account", group: "team" },
            groups: { table: "app_team" },
          },
        },
        { id: "app_team", name: "班", fields: [{ id: "title", name: "名前", type: "text" }] },
        {
          id: "app_member",
          name: "利用者",
          fields: [
            { id: "account", name: "ログイン", type: "text" },
            { id: "team", name: "班", type: "reference", reference_table: "app_team" },
          ],
          representative_field: "account",
        },
        {
          id: "project_grant",
          name: "プロジェクトの付与",
          fields: [
            { id: "project", name: "対象", type: "reference", reference_table: "projects" },
            { id: "member", name: "相手", type: "reference", reference_table: "app_member" },
            { id: "team", name: "班", type: "reference", reference_table: "app_team" },
            {
              id: "permission",
              name: "権限",
              type: "select",
              options: ["reader", "writer", "keeper", "blocked"],
            },
          ],
        },
        {
          id: "issue_grant",
          name: "課題の付与",
          fields: [
            { id: "issue", name: "対象", type: "reference", reference_table: "issues" },
            { id: "member", name: "相手", type: "reference", reference_table: "app_member" },
            { id: "team", name: "班", type: "reference", reference_table: "app_team" },
            {
              id: "permission",
              name: "権限",
              type: "select",
              options: ["reader", "writer", "keeper", "blocked"],
            },
          ],
        },
        // **アクセス権管理を1バイトも宣言していない表**((2) が使う)。
        {
          id: "notes",
          name: "覚書",
          fields: [
            { id: "body", name: "本文", type: "text" },
            { id: "member", name: "相手", type: "reference", reference_table: "app_member" },
          ],
        },
      ],
      views: [
        {
          id: "issue-grant-form",
          type: "form",
          table: "issue_grant",
          fields: ["issue", "member", "permission"],
        },
        { id: "note-form", type: "form", table: "notes", fields: ["body", "member"] },
      ],
      workflows: [],
    },
  } as unknown as Manifest;
}

/** 行の器。**サーバではなく `fetch` の差し替えが返す。** */
type Rows = Record<string, Record<string, unknown>[]>;

function fixtureRows(): Rows {
  return {
    projects: [{ _id: "project-1", title: "第1案件" }],
    issues: [
      { _id: "issue-1", title: "課題A", project: "project-1" },
      // **親を1つも指していない行**(サーバも止めない = 絞らない)。
      { _id: "issue-2", title: "課題B", project: null },
    ],
    app_team: [{ _id: "team-1", title: "第1班" }],
    app_member: [
      { _id: "m-creator", account: "boss", team: null },
      { _id: "m-outsider", account: "outsider", team: null },
      { _id: "m-insider", account: "insider", team: "team-1" },
      { _id: "m-blocked", account: "blocked-user", team: null },
    ],
    project_grant: [
      // 直接の付与(読める)。
      { _id: "pg-1", project: "project-1", member: "m-creator", team: null, permission: "keeper" },
      // 班への付与(読める)—— **その班に属する利用者へ広がる。**
      { _id: "pg-2", project: "project-1", member: null, team: "team-1", permission: "reader" },
      // **読めない権限**の付与 —— **広がらない。**
      { _id: "pg-3", project: "project-1", member: "m-blocked", team: null, permission: "blocked" },
    ],
    issue_grant: [],
    notes: [],
  };
}

// ---------------------------------------------------------------------------
// fetch の差し替え(`form.test.tsx` / `reference-type-filter.test.tsx` と同じ作法)
// ---------------------------------------------------------------------------

let originalFetch: typeof fetch;
let requests: string[] = [];
let rows: Rows = {};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** `filter.<field>=<value>` の平坦形だけを解釈する(本ファイルが使う唯一の形)。 */
function applyEqualsFilter(
  table: Record<string, unknown>[],
  params: URLSearchParams,
): Record<string, unknown>[] {
  let kept = table;
  for (const [key, value] of params.entries()) {
    if (!key.startsWith("filter.")) {
      continue;
    }
    const fieldId = key.slice("filter.".length);
    kept = kept.filter((row) => String(row[fieldId] ?? "") === value);
  }
  return kept;
}

beforeEach(() => {
  requests = [];
  rows = fixtureRows();
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    requests.push(`${method} ${raw}`);
    const url = new URL(raw, "http://localhost");
    const single = url.pathname.match(/\/tables\/([^/]+)\/records\/([^/]+)$/);
    if (method === "GET" && single !== null) {
      const row = (rows[single[1] ?? ""] ?? []).find((candidate) => candidate._id === single[2]);
      return row === undefined
        ? jsonResponse({ errors: [{ path: "", message: "not found" }] }, 404)
        : jsonResponse({ record: { ...row, _updated_at: "2026-08-09T00:00:00.000Z" } });
    }
    const list = url.pathname.match(/\/tables\/([^/]+)\/records$/);
    if (method === "GET" && list !== null) {
      const kept = applyEqualsFilter(rows[list[1] ?? ""] ?? [], url.searchParams);
      return jsonResponse({ records: kept, total: kept.length });
    }
    return jsonResponse({ errors: [{ path: "", message: `no stub for ${method} ${raw}` }] }, 404);
  }) as typeof fetch;
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/issue-grant-form`);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function viewOf(manifest: Manifest, viewId: string): FormView {
  const view = manifest.app.views.find((candidate) => candidate.id === viewId);
  if (view === undefined || view.type !== "form") {
    throw new Error(`fixture broken: ${viewId} がない`);
  }
  return view;
}

function renderForm(viewId: string, manifest: Manifest = parentManifest()) {
  return render(
    <RoleProvider role={WRITER_ROLE}>
      <FormRenderer appId={APP_ID} manifest={manifest} view={viewOf(manifest, viewId)} />
    </RoleProvider>,
  );
}

/** 「相手」の `<select>` に並んでいる候補の値(空の未選択は除く)。 */
function memberOptionValues(): string[] {
  const select = screen.getByTestId("field-input-member") as HTMLSelectElement;
  return [...select.options].map((option) => option.value).filter((value) => value !== "");
}

/** 「相手」の `<select>` に並んでいる候補のラベル。 */
function memberOptionLabels(): string[] {
  const select = screen.getByTestId("field-input-member") as HTMLSelectElement;
  return [...select.options]
    .map((option) => option.textContent ?? "")
    .filter((text) => text !== "");
}

async function chooseTarget(fieldId: string, value: string): Promise<void> {
  const select = screen.getByTestId(`field-input-${fieldId}`) as HTMLSelectElement;
  fireEvent.change(select, { target: { value } });
}

// ---------------------------------------------------------------------------
// (1) 権限を持つ人だけが候補に並ぶ
// ---------------------------------------------------------------------------

describe("(1) 親の行に権限を持つ人だけが候補に並ぶ", () => {
  test("対象の課題を選ぶと、親のプロジェクトを読める人だけが「相手」の候補に残る", async () => {
    renderForm("issue-grant-form");
    // 絞り込みが掛かる前は、今日どおり利用者表の全件が並ぶ。
    await waitFor(() => {
      expect(memberOptionValues().length).toBe(4);
    });
    await chooseTarget("issue", "issue-1");
    await waitFor(() => {
      // **`m-creator`(直接の付与)と `m-insider`(班への付与)だけが残る。**
      expect(memberOptionValues()).toEqual(["m-creator", "m-insider"]);
    });
    // **付与を1つも持たない人と、読めない権限しか持たない人は並ばない。**
    expect(memberOptionValues()).not.toContain("m-outsider");
    expect(memberOptionValues()).not.toContain("m-blocked");
  });

  test("親を1つも指していない対象では絞らない(サーバも止めない形に揃える)", async () => {
    renderForm("issue-grant-form");
    await waitFor(() => {
      expect(memberOptionValues().length).toBe(4);
    });
    await chooseTarget("issue", "issue-2");
    await waitFor(() => {
      expect(requests.some((request) => request.includes("/tables/issues/records/issue-2"))).toBe(
        true,
      );
    });
    expect(memberOptionValues()).toEqual(["m-creator", "m-outsider", "m-insider", "m-blocked"]);
  });

  test("絞り込みは既存の一覧 GET と `filter` の等値1葉だけで引いている", async () => {
    renderForm("issue-grant-form");
    await waitFor(() => {
      expect(memberOptionValues().length).toBe(4);
    });
    await chooseTarget("issue", "issue-1");
    await waitFor(() => {
      expect(memberOptionValues()).toEqual(["m-creator", "m-insider"]);
    });
    const grantCall = requests.find((request) => request.includes("/tables/project_grant/records"));
    expect(grantCall).toBeDefined();
    expect(grantCall).toContain("filter.project=project-1");
    const groupCall = requests.find((request) => request.includes("filter.team=team-1"));
    expect(groupCall).toBeDefined();
    // **書込は1件も飛んでいない**(候補を絞るために何も書いていない)。
    expect(requests.filter((request) => !request.startsWith("GET "))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (2) 宣言していない表では今日と1バイトも変わらない
// ---------------------------------------------------------------------------

describe("(2) 宣言していない表では候補の集合が着手前と同じ", () => {
  test("アクセス権管理を宣言していない表の入力画面は、利用者表の全件が並ぶ", async () => {
    renderForm("note-form");
    await waitFor(() => {
      expect(memberOptionValues().length).toBeGreaterThan(0);
    });
    expect(memberOptionValues()).toEqual(["m-creator", "m-outsider", "m-insider", "m-blocked"]);
    // **付与表を1度も読みに行っていない**(絞り込みの経路に1バイトも入らない)。
    expect(requests.filter((request) => request.includes("_grant"))).toEqual([]);
  });

  test("`inherit_from` が空の付与表では絞らない(サーバの (C-1) と同じ境界)", async () => {
    const manifest = parentManifest();
    const issues = manifest.app.tables.find((table) => table.id === "issues");
    if (issues?.access_control === undefined) {
      throw new Error("fixture broken");
    }
    issues.access_control.inherit_from = [];
    expect(grantMemberScope(manifest, "issue_grant")).toBeUndefined();
    renderForm("issue-grant-form", manifest);
    await waitFor(() => {
      expect(memberOptionValues().length).toBe(4);
    });
    await chooseTarget("issue", "issue-1");
    await waitFor(() => {
      expect(memberOptionValues()).toEqual(["m-creator", "m-outsider", "m-insider", "m-blocked"]);
    });
    expect(requests.filter((request) => request.includes("/tables/project_grant/"))).toEqual([]);
  });

  test("付与表ではない表の入力画面は、絞り込みの足場を1つも持たない", () => {
    const manifest = parentManifest();
    expect(grantMemberScope(manifest, "notes")).toBeUndefined();
    expect(grantMemberScope(manifest, "issues")).toBeUndefined();
    expect(grantMemberScope(manifest, "issue_grant")).toEqual({
      protectedTableId: "issues",
      targetFieldId: "issue",
      memberFieldId: "member",
      memberTableId: "app_member",
      inheritFrom: ["project"],
    });
  });
});

// ---------------------------------------------------------------------------
// (3) 【最重要】画面に出ないことを権限の担保にしていない
// ---------------------------------------------------------------------------

describe("(3) サーバ側の拒否が別に実在する", () => {
  /**
   * **書込を止めているのはここではない。**
   *
   * **`Z-G33`(`V7-M3-T04`)が `src/server/access-control-grant-write.test.ts` に持つ
   * (C)(D) の検査が、付与の相手が親の行を読めないときに書込を拒否する。**
   * **本ファイルの絞り込みを1バイトも消しても、その拒否は今日どおり効く。**
   * **候補に出さないことは、書込を止めることではない。**
   */
  test("`src/server/access-control-grant-write.test.ts` の拒否の検査が今日も実在する", () => {
    expect(existsSync(SERVER_GUARD_PATH)).toBe(true);
    const source = readFileSync(SERVER_GUARD_PATH, "utf8");
    // **逐語で名指しする**(名前が変わったらこの検査が赤くなる)。
    const names = [
      "(C-2) 親の行に権限が無い相手を指した付与は拒否される(`L6` の逐語)",
      "(C-4) 運営ロール(owner)が作る付与も、相手が親に権限を持たなければ止まる",
      "(C-6) グループへの付与は、そのグループの全員が親に権限を持つときだけ通る",
      "(D-1) 親に権限が無い人を指した付与は 403 で、1行も増えない",
      "(D-3) 運営(owner)が出しても、相手が親に権限を持たなければ止まる",
    ];
    for (const name of names) {
      expect(source.includes(`test("${name}"`), name).toBe(true);
    }
  });

  test("表示層は書込の判定を1本も持っていない(判定の家はサーバの1本のまま)", () => {
    const source = readFileSync(INPUT_PATH, "utf8");
    for (const symbol of ["judgeRecordAccess", "judgeGrantWrite", "judgeOwnerScopedOp"]) {
      expect(source.includes(symbol), symbol).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// (4) ラベルの規則を再実装していない
// ---------------------------------------------------------------------------

describe("(4) ラベルの規則を再実装していない", () => {
  test("絞った後の候補のラベルは、絞る前のラベルと1文字も違わない", async () => {
    renderForm("issue-grant-form");
    await waitFor(() => {
      expect(memberOptionValues().length).toBe(4);
    });
    const before = new Map(
      memberOptionValues().map((value, index) => [value, memberOptionLabels()[index]]),
    );
    await chooseTarget("issue", "issue-1");
    await waitFor(() => {
      expect(memberOptionValues()).toEqual(["m-creator", "m-insider"]);
    });
    expect(memberOptionLabels()).toEqual([
      before.get("m-creator") ?? "",
      before.get("m-insider") ?? "",
    ]);
    // 代表項目(`representative_field`)の規則がそのまま効いている。
    expect(memberOptionLabels()).toEqual(["boss", "insider"]);
  });

  test("絞り込みの関数はラベルを1つも作らない(受け取った選択肢をそのまま残すだけ)", () => {
    const choices = new Map([
      [
        "app_member",
        {
          status: "ready" as const,
          value: [
            { id: "m-creator", label: "boss" },
            { id: "m-outsider", label: "outsider" },
          ],
        },
      ],
    ]);
    const restricted = restrictReferenceChoices(choices, "app_member", new Set(["m-creator"]));
    const state = restricted.get("app_member");
    expect(state?.status).toBe("ready");
    expect(state?.status === "ready" ? state.value : []).toEqual([
      { id: "m-creator", label: "boss" },
    ]);
    // 絞る集合を渡さなければ、受け取った Map をそのまま返す(今日どおり)。
    expect(restrictReferenceChoices(choices, "app_member", undefined)).toBe(choices);
    expect(restrictReferenceChoices(choices, undefined, new Set(["m-creator"]))).toBe(choices);
  });

  test("入力欄は代表項目の規則を1バイトも持っていない(`referenceLabel` の1本だけを呼ぶ)", () => {
    const source = readFileSync(INPUT_PATH, "utf8");
    expect(source.includes("representative_field")).toBe(false);
    const match = source.match(/import \{([^}]*)\} from "\.\/reference-label\.ts";/);
    expect(match).not.toBeNull();
    expect(
      (match?.[1] ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== "")
        .sort(),
    ).toEqual([
      "missingReferenceLabel",
      "referenceLabel",
      "referencePopupColumns",
      "referenceSearchFields",
    ]);
  });
});

// ---------------------------------------------------------------------------
// (5) 新しい読取経路を作っていない
// ---------------------------------------------------------------------------

describe("(5) 新しい読取経路を作っていない", () => {
  /**
   * **`web/src/api.ts` の export の全量**(`V7-M6-T02` 着手前の実測値。41本)。
   * **本タスクは1本も足していない。** **足したらこの検査が赤くなる。**
   *
   * **【`V8-M21` の後半 / 台帳 `J-G24b` / ユーザ決定 `D-V8-34` による更新。
   *   旧文を1バイトも消していない】** **宣言どおりこの検査は実際に赤くなった。**
   * **足したのは `fetchPublicAppInfo` の1本だけである**(41 → **42**)——
   * **`GET /api/apps/:app_id/manifest` が今日からログインを要求するので、未ログインの
   * ログイン画面を描くために「アプリ名と、未ログインでも見せると決めた画面の名前だけ」を
   * 取る口が要る。** **HTTP の口も1本だけ足した**(`HTTP_ENTRY_POINTS` は 46 → 47)。
   * **【緩めていない】** **突き合わせは今日も全量の集合一致であり、2本目を足せば赤くなる。**
   *
   * **【`V8-M11-T06` / 台帳 `Q-G20` による更新。上の2つの記述を1バイトも消していない】**
   * **宣言どおり、この検査は実際に赤くなった。** **足したのは `fetchReport` の1本だけである**
   * (42 → **43**)—— **着手前、`web/` は集計表の `API` を1度も呼んでいなかった**
   * (`web/src/api.ts` に `report` の綴りが0件)。**画面を描くにはその口が1本要る。**
   * **足した口が渡せるクエリは5つちょうど**(`limit` / `offset` / `sort_target` /
   * `sort_index` / `sort_order`)**で、「項目名」を渡す口を1つも持たない**(`Q-G22` の読取側)。
   * **【緩めていない】** **突き合わせは今日も全量の集合一致である。**
   */
  const API_EXPORTS = [
    // **【`V8-M11-T06` が足した1本】** **集計表を1枚読む(`web/` から見た唯一の口)。**
    "fetchReport",
    // **【`V8-M21` の後半が足した1本】** **未ログインへ渡る最小限を取る。**
    "fetchPublicAppInfo",
    "applyThemeDiff",
    "authMe",
    "changePassword",
    // **【2026-08-24。`V10-M11-T01` の2手目。台帳 `CM-G4` = 門外(`Δ7`)/ 限定採用】**
    // **`web/` から見た「画面へのコメントを1件書く」口である。**
    // **本ファイルの主題(「新しい**読取**経路を作っていない」)を1ミリも緩めていない** ——
    // **`createComment` は `POST` の**書込**であり、レコードを1件も読まない。**
    // **コメントを**読む**口は `web/src/api.ts` に今日1本も無い**(足すのは `V10-M15-T05`)。
    // **【緩めていない】** **突き合わせは今日も全量の集合一致である。**
    "createComment",
    "createConnection",
    "createRecord",
    "customerPasskeyRegister",
    "customerPasswordRegister",
    "deleteOwnAccount",
    "deleteRecord",
    "fetchApps",
    "fetchManifest",
    "fetchRecord",
    "fetchRecordPage",
    "fetchRecords",
    "fetchRequirementsDoc",
    "fileDeliveryUrl",
    "isApplyInProgress",
    "isForbidden",
    "isLastOwnerConflict",
    "isWriteConflict",
    "issueEscapeHatchAsset",
    "listAppUsers",
    // **【2026-08-26。`V10-M32-T01`。台帳 `CM-G40` = 門外(`Δ7`)/ 限定採用】**
    // **`web/` から見た「画面に付いたコメントを読む」口である。** **これは**読取**であり、
    // 本ファイルの主題(「新しい**読取**経路を作っていない」)に正面から反する1本を足した。**
    // **言い訳はしない —— 読取経路は今日1本増えた。**
    // **ただし読むのは `gp_comments` の行だけであり、レコード(`fetchRecords` 系)を1件も読まない。**
    // **参照候補の絞り込みには1バイトも関わらない**(候補の集合も、その並びも、この口では動かない)。
    // **`V10-M11-T01` の注記が「コメントを**読む**口は今日1本も無い」と書いていたのは、
    // その口が `V10-M15-T05`(台帳 `CM-G21` / `ADR-0370`・2026-08-24)で足され、
    // `web/` から繋いだのが本工程だからである**(予告どおりの追加であって、抜け道ではない)。
    // **【緩めていない】** **突き合わせは今日も全量の集合一致である**
    // (`toEqual` を `toContain` などに1バイトも緩めていない。2本目を足せばこの検査は赤くなる)。
    "listComments",
    "listConnectionRequests",
    "listConnections",
    "listEscapeHatchAssetRequests",
    "listEscapeHatchAssets",
    "logout",
    "passkeyLogin",
    "passkeyRegister",
    "passwordLogin",
    "passwordRegister",
    "revokeConnection",
    "revokeEscapeHatchAsset",
    "runViewAction",
    "setAppUserRole",
    "setUnauthorizedHandler",
    "updateRecord",
    "uploadFile",
    "writeRecordsBatch",
  ] as const;

  test("`web/src/api.ts` が export する関数は着手前と同じ集合である", () => {
    const source = readFileSync(API_PATH, "utf8");
    const names = [...source.matchAll(/^export (?:async )?function ([A-Za-z0-9_]+)/gm)].map(
      (match) => match[1] ?? "",
    );
    expect([...names].sort()).toEqual([...API_EXPORTS].sort());
  });

  test("入力欄が `../api.ts` から取る名前は既存の5本のままである", () => {
    const source = readFileSync(INPUT_PATH, "utf8");
    const match = source.match(/import \{([^}]*)\} from "\.\.\/api\.ts";/);
    expect(match).not.toBeNull();
    expect(
      (match?.[1] ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== "")
        .sort(),
    ).toEqual(["fetchRecord", "fetchRecordPage", "fetchRecords", "fileDeliveryUrl", "uploadFile"]);
  });

  test("入力欄は URL を自分で1つも組んでいない(`fetch` を直接呼ぶ行も無い)", () => {
    const source = readFileSync(INPUT_PATH, "utf8");
    expect(source.includes("fetch(")).toBe(false);
    const code = source
      .split("\n")
      .filter((line) => line.includes("/api/"))
      .filter((line) => {
        const trimmed = line.trim();
        return !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*");
      });
    expect(code).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (6) 【限界を測る】絞り込みが効かない選び方を、実測で書き残す
// ---------------------------------------------------------------------------

describe("(6) 絞り込みが効くのは既定の選び方(`list`)だけである", () => {
  test("`type_filter` の選び方では候補が1件も絞られない(今日と1バイトも変わらない)", async () => {
    const manifest = parentManifest();
    const grant = manifest.app.tables.find((table) => table.id === "issue_grant");
    const memberField = grant?.fields.find((field) => field.id === "member");
    if (memberField === undefined) {
      throw new Error("fixture broken");
    }
    (memberField as { reference_picker?: string }).reference_picker = "type_filter";
    renderForm("issue-grant-form", manifest);
    await waitFor(() => {
      expect(memberOptionValues().length).toBe(4);
    });
    await chooseTarget("issue", "issue-1");
    // **絞られない。** **これは限界であって、隠さない。**
    await waitFor(() => {
      expect(requests.some((request) => request.includes("/tables/project_grant/records"))).toBe(
        true,
      );
    });
    expect(memberOptionValues()).toEqual(["m-creator", "m-outsider", "m-insider", "m-blocked"]);
  });
});
