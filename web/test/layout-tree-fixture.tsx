/**
 * **並べ方の木(`layout`)の描画検査の題材**(`V20-M5-T03`)。
 *
 * **`web/test/layout-tree.test.tsx` と、着手前の DOM を撮る一時の手順が同じ題材を使うために
 * 分けてある。** **この題材を変えると、着手前の DOM(`__fixtures__/layout-undeclared-before.dom.txt`)
 * との比較が無意味になる** —— 変えるなら着手前の DOM を土台の写しで撮り直すこと。
 *
 * 題材は入力フォーム・詳細画面・一覧(表 / カード)の4通り。**詳細画面と一覧には識別子(`id`)を
 * 持つ宣言ボタンを置いてある**(木の葉 `action:<id>` がボタンを動かすことを撃つため。
 * 木を書かない画面ではボタンが今日の場所に在ることも、同じ題材で着手前の DOM に写っている)。
 *
 * **`import type` だけを使う**(`scripts/kernel-import-drift.test.ts` のスナップショットを動かさない)。
 */
import { expect } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import type { DetailView, FormView, ListView, Manifest } from "../../src/kernel/types.ts";
import type { Role } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { DetailViewRenderer } from "../src/views/DetailViewRenderer.tsx";
import { FormRenderer } from "../src/views/FormRenderer.tsx";
import { ListViewRenderer } from "../src/views/ListViewRenderer.tsx";
import { actionRead, grantRules, viewRead } from "./role-rules.ts";

export const LAYOUT_APP_ID = "layout-app";
export const RECORD_ID = "entry-0001";
const ENTRIES_PATH = `/api/apps/${LAYOUT_APP_ID}/tables/entries/records`;
const TARGETS_PATH = `/api/apps/${LAYOUT_APP_ID}/tables/targets/records`;
const OWNER_ROLE: Role = "owner";

/** 表示項目(入力フォーム・詳細画面・一覧で同じ7本)。 */
export const ALL_FIELDS = ["f_a", "f_b", "f_c", "f_d", "f_e", "f_f", "f_g"];

/** 遷移の宣言ボタン(識別子 `to_target`)。詳細画面と一覧の両方に置く。 */
export const TO_TARGET = {
  id: "to_target",
  form: "target-form",
  prefill: { field: "parent" },
  name: "参照先を作る",
};
/** 値の書換の宣言ボタン(識別子 `mark`)。詳細画面だけに置く。 */
export const MARK = { id: "mark", set: { field: "f_e", value: "赤" }, name: "赤にする" };

export type ViewKind = "form" | "detail" | "list";

const VIEW_INDEX: Record<ViewKind, number> = { form: 0, detail: 1, list: 2 };

/**
 * **着手前の DOM を撮ったときと1バイトも違わないマニフェスト**(`extra` を足さない限り)。
 * `extra` は `kind` が指す画面1つにだけ足す。
 */
export function layoutManifest(kind: ViewKind, extra: Record<string, unknown> = {}): Manifest {
  const views: Record<string, unknown>[] = [
    { id: "entry-form", type: "form", table: "entries", fields: ALL_FIELDS },
    {
      id: "entry-detail",
      type: "detail_view",
      table: "entries",
      fields: ALL_FIELDS,
      actions: [TO_TARGET, MARK],
    },
    {
      id: "entry-list",
      type: "list_view",
      table: "entries",
      columns: ALL_FIELDS,
      actions: [TO_TARGET],
    },
    { id: "target-form", type: "form", table: "targets", fields: ["label", "parent"] },
  ];
  views[VIEW_INDEX[kind]] = { ...views[VIEW_INDEX[kind]], ...extra };
  const built = {
    app: {
      id: LAYOUT_APP_ID,
      name: "並べ方のサンプル",
      tables: [
        {
          id: "entries",
          name: "エントリ",
          fields: [
            { id: "f_a", name: "項目A", type: "text", required: true },
            { id: "f_b", name: "項目B", type: "text" },
            { id: "f_c", name: "項目C", type: "number" },
            { id: "f_d", name: "項目D", type: "long_text" },
            { id: "f_e", name: "項目E", type: "select", options: ["赤", "青"] },
            { id: "f_f", name: "項目F", type: "boolean" },
            { id: "f_g", name: "項目G", type: "date" },
          ],
        },
        {
          id: "targets",
          name: "参照先",
          fields: [
            { id: "label", name: "名前", type: "text", required: true },
            { id: "parent", name: "親", type: "reference", reference_table: "entries" },
          ],
        },
      ],
      views,
    },
  } as unknown as Manifest;
  return grantRules(
    built,
    ["owner"],
    [
      viewRead("entry-form"),
      viewRead("entry-detail"),
      viewRead("entry-list"),
      viewRead("target-form"),
      actionRead("entry-detail", "to_target"),
      actionRead("entry-detail", "mark"),
      actionRead("entry-list", "to_target"),
    ],
  );
}

export const ENTRY_ROW = {
  _id: RECORD_ID,
  _created_at: "2026-01-01T00:00:00Z",
  _updated_at: "2026-01-02T00:00:00Z",
  f_a: "あ",
  f_b: "い",
  f_c: 3,
  f_d: "長い文",
  f_e: "赤",
  f_f: true,
  f_g: "2026-01-03",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let originalFetch: typeof fetch | undefined;

export function installLayoutFetch(): void {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const path = url.split("?")[0];
    if (method === "GET" && path === `${ENTRIES_PATH}/${RECORD_ID}`) {
      return json({ record: ENTRY_ROW });
    }
    if (method === "GET" && url.startsWith(ENTRIES_PATH)) {
      return json({ records: [ENTRY_ROW], total: 1 });
    }
    if (method === "GET" && url.startsWith(TARGETS_PATH)) {
      return json({ records: [], total: 0 });
    }
    return json({ errors: [{ path: "", message: `no stub for ${method} ${url}` }] }, 404);
  }) as typeof fetch;
}

export function restoreLayoutFetch(): void {
  if (originalFetch !== undefined) {
    globalThis.fetch = originalFetch;
  }
}

/** 入力フォームを描いて、画面の器(`view-renderer-form`)を返す。 */
export async function renderLayoutForm(manifest: Manifest): Promise<HTMLElement> {
  window.history.replaceState({}, "", `/apps/${LAYOUT_APP_ID}/views/entry-form`);
  render(
    <RoleProvider role={OWNER_ROLE}>
      <FormRenderer
        appId={LAYOUT_APP_ID}
        manifest={manifest}
        view={manifest.app.views[0] as FormView}
      />
    </RoleProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("view-renderer-form")).toBeDefined());
  await waitFor(() => expect(screen.getByTestId("field-label-f_a")).toBeDefined());
  return screen.getByTestId("view-renderer-form");
}

/** 詳細画面を描いて、画面の器(`view-renderer-detail_view`)を返す。 */
export async function renderLayoutDetail(manifest: Manifest): Promise<HTMLElement> {
  window.history.replaceState(
    {},
    "",
    `/apps/${LAYOUT_APP_ID}/views/entry-detail/records/${RECORD_ID}`,
  );
  render(
    <RoleProvider role={OWNER_ROLE}>
      <DetailViewRenderer
        appId={LAYOUT_APP_ID}
        manifest={manifest}
        view={manifest.app.views[1] as DetailView}
        recordId={RECORD_ID}
      />
    </RoleProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("detail-field-f_a")).toBeDefined());
  return screen.getByTestId("view-renderer-detail_view");
}

/** 一覧を描いて、画面の器(`view-renderer-list_view`)を返す。 */
export async function renderLayoutList(manifest: Manifest): Promise<HTMLElement> {
  window.history.replaceState({}, "", `/apps/${LAYOUT_APP_ID}/views/entry-list`);
  render(
    <RoleProvider role={OWNER_ROLE}>
      <ListViewRenderer
        appId={LAYOUT_APP_ID}
        manifest={manifest}
        view={manifest.app.views[2] as ListView}
      />
    </RoleProvider>,
  );
  await waitFor(() =>
    expect(screen.queryByTestId("list-table") ?? screen.queryByTestId("list-cards")).not.toBeNull(),
  );
  return screen.getByTestId("view-renderer-list_view");
}
