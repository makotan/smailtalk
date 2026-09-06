/**
 * `V14-M2-T04` / `V14-M2-T05`(`RB-G2` / `RB-G3` / `RB-G4`):
 * **一覧画面が「行ごとの判定」でボタンを出し分ける。**
 *
 * **正は `ADR-0402` §Decision 5(4形ごとに見る対象)/ §Decision 6(面は1回・行は後段)**
 * であり、**計画の正は `docs/plan/v14/01-v14-m2-tasks.md` §4(`T04`)と §5(`T05`)** である。
 *
 * ## このファイルが固定すること
 *
 * | # | 条件 |
 * |---|---|
 * | (1) | **同じ一覧の中で**、行ごとに出たり出なかったりする(完了条件 2(a) そのもの) |
 * | (2) | **カード形式と表形式の両方**に当たっている(`ADR-0402` 限定15。片方だけに当てない) |
 * | (3) | `access` が載っていない一覧は着手前と1バイトも同じ(限定4) |
 * | (4) | **行ごとの追加の問い合わせを1本も作っていない**(限定12。往復は今日どおり1回) |
 * | (5) | **4形を別々のデータで撃つ**(限定27。`set` の検査で代用しない) |
 *
 * ## **【`set` 形をこのファイルが1度も撃たない理由】**
 *
 * **一覧に `set` 形は書けない** —— **`schemas/manifest.schema.json` の `list_view` 分岐が
 * `items.properties.set: false` で閉じている**(`ADR-0171` 限定10 の順序拘束。
 * `ListViewRenderer.tsx` の `writableActions` の doc に逐語が在る)。
 * **したがって `(RB-G2/list-1)` は `form` 形(付与表行き)で撃つ。**
 * **`set` 形を撃つのは詳細画面の側**(`web/test/row-grant-detail-buttons.test.tsx`)である。
 *
 * ## **【誇張しない。`view` 形は今日1件も落とさない】**
 *
 * **`view` 形は `access[id].read` を見る**(`ADR-0402` §Decision 5 が命じている)。
 * **しかし一覧に返ってきている行は、定義上その人が読める行である** ——
 * **サーバが読めない行を一覧に載せないからである。**
 * **したがって `read: false` の行は今日の実地では1行も現れず、この1本は1件も落とさない。**
 * **【禁止】これを「`view` 形も出し分けている」と書かない。** **実装はするが、出し分けの
 * 実績は0件である。** **`(RB-G2/list-6)` は「写像が当たっていること」だけを撃っており、
 * その入力(`read: false` の行)は検査が人工的に作ったものである。**
 *
 * ## このファイルが証明しないこと(先に書く。誇張しない)
 *
 * 1. **サーバの遮断を1件も測っていない。** **`fetch` をスタブしているので、
 *    「サーバが実際に拒む」ことは1件も起きていない。** **ボタンを隠すことは書込を
 *    止めることではない**(`ADR-0402` 限定7)—— **最終防衛線は今日どおり 403 / 404 である。**
 * 2. **本物のブラウザで1度も押していない**(ここは happy-dom)。**実地は `V14-M4` である。**
 * 3. **判定そのものの正しさを1件も測っていない** —— **`access` の値は検査が手で書いた
 *    ものであり、`resolveCombinedRecordAccess` を1度も通していない。**
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { RecordRow } from "../../src/kernel/records.ts";
import type { ListView, Manifest } from "../../src/kernel/types.ts";
import type { Role, RowAccess } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { ListViewRenderer } from "../src/views/ListViewRenderer.tsx";
import { rowActionVerb } from "../src/views/row-action-verb.ts";
import { grantRules, viewRead } from "./role-rules.ts";

const APP_ID = "grant-list";
const RECORDS_PATH = `/api/apps/${APP_ID}/tables/projects/records`;

/** 4形ぶんの `access` を組み立てる下ごしらえ(既定は全部真)。 */
function access(overrides: Partial<RowAccess> = {}): RowAccess {
  return { read: true, write: true, delete: true, grant_write: true, ...overrides };
}

/** 行1つ。**形ごとに別々の `_id` と名前を使う**(`ADR-0402` 限定27)。 */
function row(id: string, title: string): RecordRow {
  return {
    _id: id,
    _created_at: "2026-01-01T00:00:00Z",
    _updated_at: "2026-01-02T00:00:00Z",
    title,
  } as unknown as RecordRow;
}

/**
 * 題材。
 *
 * - `projects` … **`grant.table` に `project_grant` を名指ししている**(保護対象の表)。
 *   **`inherit_from` も `grant.member` も書いていない** —— **サーバの `rowGrantWriteJudge` は
 *   その2つを1度も見ない**(計画 §0a)。
 * - `project_grant` … **付与表**。`project-grant-form` の書込先である。
 * - `memos` … **アクセス権管理を1バイトも宣言していない**(付与表でない `form` の行き先)。
 */
function manifest(): Manifest {
  const built = {
    app: {
      id: APP_ID,
      name: "案件",
      tables: [
        {
          id: "projects",
          name: "案件",
          fields: [{ id: "title", name: "名前", type: "text" }],
          access_control: {
            enabled: true,
            permissions: [
              { id: "reader", name: "読める", read: true, write: false, delete: false },
              { id: "keeper", name: "任せる", read: true, write: true, delete: true },
            ],
            creator_permission: "keeper",
            grant: {
              table: "project_grant",
              target: "project",
              member: "member",
              permission: "permission",
            },
          },
        },
        {
          id: "project_grant",
          name: "案件の付与",
          fields: [
            { id: "project", name: "対象", type: "reference", reference_table: "projects" },
            { id: "member", name: "相手", type: "text" },
            { id: "permission", name: "権限", type: "select", options: ["reader", "keeper"] },
          ],
        },
        { id: "memos", name: "備忘", fields: [{ id: "body", name: "本文", type: "text" }] },
      ],
      views: [
        { id: "projects-list", type: "list_view", table: "projects", columns: ["title"] },
        { id: "project-detail", type: "detail_view", table: "projects" },
        { id: "project-grant-form", type: "form", table: "project_grant", fields: ["project"] },
        { id: "memo-form", type: "form", table: "memos", fields: ["body"] },
      ],
      workflows: [
        {
          id: "notify",
          name: "知らせる",
          trigger: { type: "manual", table: "projects" },
          actions: [],
        },
      ],
    },
  } as unknown as Manifest;
  // **足すのは主題に要る最小限の面の規則だけである**(`V8-M26` の既定は「閉じる」)。
  return grantRules(
    built,
    ["owner"],
    [viewRead("project-grant-form"), viewRead("memo-form"), viewRead("project-detail")],
  );
}

/** **1回の描画で走った `fetch` の本数**(限定12 を撃つために数える)。 */
let fetchCalls = 0;
let originalFetch: typeof fetch;
/** その描画でサーバが返す本体(`access` を持つか持たないかを検査ごとに差し替える)。 */
let responseBody: { records: RecordRow[]; total: number; access?: Record<string, RowAccess> } = {
  records: [],
  total: 0,
};

beforeEach(() => {
  fetchCalls = 0;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls += 1;
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (method === "GET" && url.startsWith(RECORDS_PATH)) {
      return json(responseBody);
    }
    return json({ errors: [{ path: "", message: `no stub for ${method} ${url}` }] }, 404);
  }) as typeof fetch;
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/projects-list`);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

async function renderList(options: {
  actions: unknown[];
  records: RecordRow[];
  access?: Record<string, RowAccess>;
  /** カード形式で描くか(`ADR-0402` 限定15。既定は表形式)。 */
  cards?: boolean;
  role?: Role;
}): Promise<void> {
  responseBody = {
    records: options.records,
    total: options.records.length,
    ...(options.access === undefined ? {} : { access: options.access }),
  };
  const built = manifest();
  const target = {
    ...(built.app.views[0] as ListView),
    actions: options.actions,
    ...(options.cards === true ? { preset_list_shape: "card" } : {}),
  } as unknown as ListView;
  render(
    <RoleProvider role={options.role ?? "owner"}>
      <ListViewRenderer appId={APP_ID} manifest={built} view={target} />
    </RoleProvider>,
  );
  await waitFor(() =>
    expect(
      screen.getAllByTestId(options.cards === true ? "list-card" : "list-row").length,
    ).toBeGreaterThanOrEqual(options.records.length),
  );
}

/** `form` 形(**付与表行き**)。**`(RB-G2/list-1)` / `(RB-G3/form-1)` が使う。** */
const GRANT_FORM = {
  form: "project-grant-form",
  prefill: { field: "project" },
  name: "権限を配る",
};

// ---------------------------------------------------------------------------
// T04(`RB-G2`)—— 一覧が行ごとに出し分ける
// ---------------------------------------------------------------------------

test("(RB-G2/list-1) 同じ一覧の中で、付与を持つ行にはボタンが出て、持たない行には出ない", async () => {
  const rows = [row("p-open", "配れる案件"), row("p-shut", "配れない案件")];
  await renderList({
    actions: [GRANT_FORM],
    records: rows,
    access: {
      "p-open": access({ grant_write: true }),
      "p-shut": access({ grant_write: false }),
    },
  });
  const buttons = screen.getAllByTestId("list-action-origin-project-grant-form");
  expect(buttons).toHaveLength(1);
  expect(buttons[0]?.closest("[data-testid='list-row']")?.textContent).toContain("配れる案件");
});

test("(RB-G2/list-2) カード形式でも同じことが起きる", async () => {
  const rows = [row("c-open", "カード:配れる"), row("c-shut", "カード:配れない")];
  await renderList({
    actions: [GRANT_FORM],
    records: rows,
    access: {
      "c-open": access({ grant_write: true }),
      "c-shut": access({ grant_write: false }),
    },
    cards: true,
  });
  const buttons = screen.getAllByTestId("list-action-origin-project-grant-form");
  expect(buttons).toHaveLength(1);
  expect(buttons[0]?.closest("[data-testid='list-card']")?.textContent).toContain("カード:配れる");
});

test("(RB-G2/list-3) 表形式でも同じことが起きる", async () => {
  const rows = [row("t-open", "表:配れる"), row("t-shut", "表:配れない")];
  await renderList({
    actions: [GRANT_FORM],
    records: rows,
    access: {
      "t-open": access({ grant_write: true }),
      "t-shut": access({ grant_write: false }),
    },
  });
  const buttons = screen.getAllByTestId("list-action-origin-project-grant-form");
  expect(buttons).toHaveLength(1);
  // **セルは2行とも在る**(列数を壊していない。既存の注記が許している「セルは在るが
  // ボタンが0本の行」である)。
  expect(screen.getAllByTestId("list-action-cell")).toHaveLength(2);
  expect(buttons[0]?.closest("[data-testid='list-row']")?.textContent).toContain("表:配れる");
});

test("(RB-G2/list-4) access が載っていない一覧では、着手前と同じくすべての行に出る", async () => {
  const rows = [row("n-1", "宣言なし1"), row("n-2", "宣言なし2")];
  await renderList({ actions: [GRANT_FORM], records: rows });
  expect(screen.getAllByTestId("list-action-origin-project-grant-form")).toHaveLength(2);
});

test("(RB-G2/list-5) 追加の問い合わせが1本も起きない", async () => {
  const rows = [row("q-1", "問合せ1"), row("q-2", "問合せ2"), row("q-3", "問合せ3")];
  await renderList({
    actions: [GRANT_FORM],
    records: rows,
    access: {
      "q-1": access({ grant_write: true }),
      "q-2": access({ grant_write: false }),
      "q-3": access({ grant_write: true }),
    },
  });
  // **行が3行あっても往復は1回である**(`ADR-0402` 限定12)。
  expect(fetchCalls).toBe(1);
});

test("(RB-G2/list-6) view 形は read を見る(ただし今日1件も落とさない —— 上の doc)", async () => {
  const rows = [row("v-read", "読める行"), row("v-hide", "読めない行")];
  await renderList({
    actions: [{ view: "project-detail", name: "開く" }],
    records: rows,
    access: {
      "v-read": access({ read: true }),
      "v-hide": access({ read: false }),
    },
  });
  const buttons = screen.getAllByTestId("list-action-link-project-detail");
  expect(buttons).toHaveLength(1);
  expect(buttons[0]?.closest("[data-testid='list-row']")?.textContent).toContain("読める行");
});

// ---------------------------------------------------------------------------
// T05(`RB-G4` / `RB-G3`)—— `run` と `form` を別々のデータで撃つ(限定27)
// ---------------------------------------------------------------------------

test("(RB-G4/run-1) 一覧で run 形は write: false の行に出ない", async () => {
  const rows = [row("r-yes", "起こせる行"), row("r-no", "起こせない行")];
  await renderList({
    actions: [{ run: "notify", name: "知らせる" }],
    records: rows,
    access: {
      "r-yes": access({ write: true }),
      "r-no": access({ write: false }),
    },
  });
  const buttons = screen.getAllByTestId("list-action-run-notify");
  expect(buttons).toHaveLength(1);
  expect(buttons[0]?.closest("[data-testid='list-row']")?.textContent).toContain("起こせる行");
});

test("(RB-G4/run-2) run が見る動詞は write ちょうど1つである", () => {
  const built = manifest();
  // **`run` 専用の動詞が無い**(`ADR-0402` 限定24)—— **`set` と同じ `write` を見る。**
  expect(rowActionVerb(built, "projects", { run: "notify" })).toBe("write");
  // **写像が返しうる全量を固定する**(4形を1つずつ通した結果の全量)。
  expect([
    rowActionVerb(built, "projects", { set: { field: "title", value: "x" } }),
    rowActionVerb(built, "projects", { run: "notify" }),
    rowActionVerb(built, "projects", { view: "project-detail" }),
    rowActionVerb(built, "projects", GRANT_FORM),
  ]).toEqual(["write", "write", "read", "grant_write"]);
});

test("(RB-G3/form-1) 一覧で form 形(付与表行き)は grant_write: false の行に出ない", async () => {
  const rows = [row("f-yes", "配れる行"), row("f-no", "配れない行")];
  await renderList({
    actions: [GRANT_FORM],
    records: rows,
    access: {
      "f-yes": access({ grant_write: true, write: false }),
      "f-no": access({ grant_write: false, write: true }),
    },
  });
  // **`grant_write` を `write` と混ぜていない**(`ADR-0402` 限定18)——
  // **出たのは `write: false` だが `grant_write: true` の行である。**
  const buttons = screen.getAllByTestId("list-action-origin-project-grant-form");
  expect(buttons).toHaveLength(1);
  expect(buttons[0]?.closest("[data-testid='list-row']")?.textContent).toContain("配れる行");
});

test("(RB-G3/form-2) grant_write: false でも、作る先が付与表でない form 形は今日どおり出る", async () => {
  const rows = [row("m-1", "備忘1"), row("m-2", "備忘2")];
  await renderList({
    actions: [{ form: "memo-form", prefill: { field: "body" }, name: "備忘を作る" }],
    records: rows,
    access: {
      "m-1": access({ grant_write: false }),
      "m-2": access({ grant_write: false }),
    },
  });
  // **写像が `undefined` を返す形なので、行の判定を1つも当てない**(今日どおり面だけ)。
  expect(screen.getAllByTestId("list-action-origin-memo-form")).toHaveLength(2);
});
