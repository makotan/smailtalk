/**
 * **子の表に行を作れる権限の、画面の出し分け**(`V23-M7-T05b`。`ADR-0542` §Decision 4-5・限定5・限定7。
 * 決定 `D-V23-179`・`D-V23-180`・`D-V23-184`・`D-V23-189`。計画 §26-6 軽5・軽6)。
 *
 * ## このファイルが固定すること
 *
 * 1. 親の詳細の form+prefill の「新規作成へ」ボタンは、遷移先の form の表が行の判定の5つ目のキー
 *    `create_child` の鍵にあるときだけ、その値が偽なら出さない。鍵が無い子の表・5つ目のキーが無い行・判定が無い行は今日どおり出る。
 * 2. 子の作成フォームの親の参照の選択肢は、同じ条件のときだけ値が真の親に絞る。鍵の無い行は今日どおり並ぶ。
 * 3. 編集フォームは絞らない(付け替えは今日どおり書込権で決まる)。
 *
 * ## このファイルが証明しないこと(先に書く)
 *
 * - サーバの遮断を1件も測っていない(`fetch` を差し替えた表示層の検査である)。ボタンを隠すことは作成を止めることではない。
 * - 画面はマニフェストのアクセス権の宣言を読まない。題材のマニフェストにも宣言を書いていない(5つ目のキーの有無だけで決まる)。
 * - 一覧の「新規作成」と子の一覧の導線は出し分けの範囲の外である(面の判定だけ)。本ファイルは撃たない。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { DetailView, FormView, Manifest } from "../../src/kernel/types.ts";
import type { Role, RowAccess } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { DetailViewRenderer } from "../src/views/DetailViewRenderer.tsx";
import { FormRenderer } from "../src/views/FormRenderer.tsx";
import { grantRules, viewRead } from "./role-rules.ts";

const WRITER_ROLE: Role = "owner";
const APP_ID = "create-child-screen";

function manifest(): Manifest {
  const built = {
    app: {
      id: APP_ID,
      name: "子を作れる権限の画面",
      tables: [
        {
          id: "orgs",
          name: "組織",
          representative_field: "title",
          fields: [{ id: "title", name: "名前", type: "text" }],
        },
        {
          id: "notices",
          name: "告知",
          fields: [
            { id: "title", name: "件名", type: "text" },
            { id: "org", name: "組織", type: "reference", reference_table: "orgs" },
          ],
        },
        {
          // **【`V23-M7-T07`】同じ親の表を指す参照の項目を2つ持つ子の表**(親を辿る項目は片方だけの想定。
          // 画面はどちらが親を辿る項目かを知らない)。
          id: "memos",
          name: "連絡",
          fields: [
            { id: "title", name: "件名", type: "text" },
            { id: "org", name: "組織", type: "reference", reference_table: "orgs" },
            { id: "partner", name: "相手の組織", type: "reference", reference_table: "orgs" },
          ],
        },
        {
          id: "reports",
          name: "報告",
          fields: [
            { id: "title", name: "件名", type: "text" },
            { id: "org", name: "組織", type: "reference", reference_table: "orgs" },
          ],
        },
      ],
      views: [
        {
          id: "org-detail",
          type: "detail_view",
          table: "orgs",
          actions: [
            { form: "notice-form", prefill: { field: "org" }, name: "告知を追加" },
            { form: "report-form", prefill: { field: "org" }, name: "報告を追加" },
          ],
        },
        { id: "notice-form", type: "form", table: "notices", fields: ["title", "org"] },
        { id: "report-form", type: "form", table: "reports", fields: ["title", "org"] },
        { id: "memo-form", type: "form", table: "memos", fields: ["title", "org", "partner"] },
      ],
    },
  } as unknown as Manifest;
  return grantRules(
    built,
    ["owner"],
    [viewRead("notice-form"), viewRead("report-form"), viewRead("memo-form")],
  );
}

const BASE: RowAccess = { read: true, write: false, delete: false, grant_write: false };

function orgRow(id: string): Record<string, unknown> {
  return {
    _id: id,
    _created_at: "2026-01-01T00:00:00Z",
    _updated_at: "2026-01-02T00:00:00Z",
    title: `組織${id}`,
  };
}

let originalFetch: typeof fetch;
/** 組織の行の `_id` → サーバが返す判定。`undefined` の行は `access` に載せない。 */
let orgAccess: Map<string, RowAccess | undefined>;
let orgIds: string[];

beforeEach(() => {
  orgAccess = new Map();
  orgIds = ["O1", "O2", "O3"];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const url = new URL(raw, "http://localhost");
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    const accessOf = (ids: string[]) => {
      const entries = ids.flatMap((id) => {
        const value = orgAccess.get(id);
        return value === undefined ? [] : [[id, value] as const];
      });
      return entries.length === 0 ? {} : { access: Object.fromEntries(entries) };
    };
    const single = url.pathname.match(/\/tables\/([^/]+)\/records\/([^/]+)$/);
    if (method === "GET" && single !== null) {
      const [, table, id] = single;
      if (table === "orgs") {
        return json({ record: orgRow(id ?? ""), ...accessOf([id ?? ""]) });
      }
      if (table === "notices") {
        return json({
          record: { _id: id, _updated_at: "2026-01-02T00:00:00Z", title: "告知", org: "O1" },
        });
      }
    }
    const list = url.pathname.match(/\/tables\/([^/]+)\/records$/);
    if (method === "GET" && list !== null) {
      if (list[1] === "orgs") {
        return json({ records: orgIds.map(orgRow), total: orgIds.length, ...accessOf(orgIds) });
      }
      return json({ records: [], total: 0 });
    }
    return json({ errors: [{ path: "", message: `no stub for ${method} ${raw}` }] }, 404);
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function viewOf<T extends DetailView | FormView>(built: Manifest, id: string): T {
  const view = built.app.views.find((candidate) => candidate.id === id);
  if (view === undefined) {
    throw new Error(`fixture broken: ${id} がない`);
  }
  return view as T;
}

async function renderDetail(recordId = "O1"): Promise<void> {
  const built = manifest();
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/org-detail/records/${recordId}`);
  render(
    <RoleProvider role={WRITER_ROLE}>
      <DetailViewRenderer
        appId={APP_ID}
        manifest={built}
        view={viewOf<DetailView>(built, "org-detail")}
        recordId={recordId}
      />
    </RoleProvider>,
  );
  await waitFor(() => expect(screen.getAllByTestId("detail-field-title")).toHaveLength(1));
}

const NOTICE_BUTTON = "action-origin-notice-form";
const REPORT_BUTTON = "action-origin-report-form";

describe("V23-M7-T05b (S) 親の詳細の「新規作成へ」ボタン", () => {
  test("(S-1) 行の create_child で遷移先の表が偽なら出さない。鍵の無い子の表(報告)は今日どおり出る", async () => {
    orgAccess.set("O1", { ...BASE, create_child: { notices: false } });
    await renderDetail();
    await waitFor(() => expect(screen.getAllByTestId(REPORT_BUTTON)).toHaveLength(1));
    expect(screen.queryByTestId(NOTICE_BUTTON)).toBeNull();
  });

  test("(S-2) 値が真なら出る(親に書けない人でも)", async () => {
    orgAccess.set("O1", { ...BASE, create_child: { notices: true } });
    await renderDetail();
    await waitFor(() => expect(screen.getAllByTestId(NOTICE_BUTTON)).toHaveLength(1));
    expect(screen.getAllByTestId(REPORT_BUTTON)).toHaveLength(1);
  });

  test("(S-3) 陰性対照: 5つ目のキーの無い判定(4キー)・判定の無い行では今日どおり両方出る", async () => {
    orgAccess.set("O1", { ...BASE });
    await renderDetail();
    await waitFor(() => expect(screen.getAllByTestId(NOTICE_BUTTON)).toHaveLength(1));
    expect(screen.getAllByTestId(REPORT_BUTTON)).toHaveLength(1);
    cleanup();
    await renderDetail("O2");
    await waitFor(() => expect(screen.getAllByTestId(NOTICE_BUTTON)).toHaveLength(1));
    expect(screen.getAllByTestId(REPORT_BUTTON)).toHaveLength(1);
  });
});

function renderForm(viewId: string, recordId?: string): void {
  const built = manifest();
  render(
    <RoleProvider role={WRITER_ROLE}>
      <FormRenderer
        appId={APP_ID}
        manifest={built}
        view={viewOf<FormView>(built, viewId)}
        {...(recordId === undefined ? {} : { recordId })}
      />
    </RoleProvider>,
  );
}

async function orgOptions(fieldId = "org"): Promise<string[]> {
  let values: string[] = [];
  await waitFor(() => {
    const select = screen.getByTestId(`field-input-${fieldId}`) as HTMLSelectElement;
    values = [...select.options].map((option) => option.value).filter((value) => value !== "");
    expect(values.length).toBeGreaterThan(0);
  });
  return values;
}

describe("V23-M7-T05b (F) 子の作成フォームの親の選択肢", () => {
  test("(F-1) 作成フォーム: 鍵があれば値が真の親だけ。鍵の無い行は今日どおり並ぶ", async () => {
    orgAccess.set("O1", { ...BASE, create_child: { notices: true } });
    orgAccess.set("O2", { ...BASE, create_child: { notices: false } });
    orgAccess.set("O3", { ...BASE });
    renderForm("notice-form");
    expect(await orgOptions()).toEqual(["O1", "O3"]);
  });

  test("(F-2) 鍵に名の無い子の表(報告)の作成フォームは絞らない", async () => {
    orgAccess.set("O1", { ...BASE, create_child: { notices: true } });
    orgAccess.set("O2", { ...BASE, create_child: { notices: false } });
    renderForm("report-form");
    expect(await orgOptions()).toEqual(["O1", "O2", "O3"]);
  });

  test("(F-3) 編集フォームは絞らない(付け替えは今日どおり書込権で決まる)", async () => {
    orgAccess.set("O1", { ...BASE, create_child: { notices: true } });
    orgAccess.set("O2", { ...BASE, create_child: { notices: false } });
    renderForm("notice-form", "N1");
    expect(await orgOptions()).toEqual(["O1", "O2", "O3"]);
  });

  test("(F-4) 陰性対照: 5つ目のキーが無い・判定が無い一覧では今日どおり全部並ぶ", async () => {
    orgAccess.set("O1", { ...BASE });
    orgAccess.set("O2", { ...BASE });
    renderForm("notice-form");
    expect(await orgOptions()).toEqual(["O1", "O2", "O3"]);
    cleanup();
    orgAccess.clear();
    renderForm("notice-form");
    expect(await orgOptions()).toEqual(["O1", "O2", "O3"]);
  });
});

/**
 * **【`V23-M7-T07`】同じ親の表を指す参照の項目が2つある子の表**(`T05b` の判断点2 を撃つ)。
 *
 * 選択肢は参照先の表ごとに1組で、画面はどちらの項目が親を辿る項目かを知らない(マニフェストのアクセス権の宣言を読まない)。
 * 親の関門が掛かるのは親を辿る項目だけなので、もう片方の項目まで絞ると、作れる行の選択肢を消してしまう。
 * **作る表が同じ親の表を指す参照の項目を2つ以上持つときは、どちらも絞らない**(今日どおり全部並び、作れない親は保存で断られる)。
 */
describe("V23-M7-T07 (G) 同じ親の表を指す参照の項目が2つある子の作成フォーム", () => {
  test("(G-1) 親を辿る項目でない方(相手の組織)は絞らない", async () => {
    orgAccess.set("O1", { ...BASE, create_child: { memos: true } });
    orgAccess.set("O2", { ...BASE, create_child: { memos: false } });
    orgAccess.set("O3", { ...BASE, create_child: { memos: false } });
    renderForm("memo-form");
    expect(await orgOptions("partner")).toEqual(["O1", "O2", "O3"]);
  });

  test("(G-2) どちらが親を辿る項目かを画面が知らないので、もう片方(組織)も絞らない(保存で断られる今日の形)", async () => {
    orgAccess.set("O1", { ...BASE, create_child: { memos: true } });
    orgAccess.set("O2", { ...BASE, create_child: { memos: false } });
    renderForm("memo-form");
    expect(await orgOptions("org")).toEqual(["O1", "O2", "O3"]);
  });

  test("(G-3) 陰性対照: 参照の項目が1つの子の表(告知)は今日の T05b どおり絞る", async () => {
    orgAccess.set("O1", { ...BASE, create_child: { notices: true, memos: true } });
    orgAccess.set("O2", { ...BASE, create_child: { notices: false, memos: false } });
    renderForm("notice-form");
    expect(await orgOptions()).toEqual(["O1", "O3"]);
  });
});
