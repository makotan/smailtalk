/**
 * **一覧の束ねるキー(`group_by`)の描画検査の題材**(`V20-M4-T03`)。
 *
 * **`web/test/list-group-by.test.tsx` と、着手前の DOM を撮る一時の手順が同じ題材を使うために
 * 分けてある。** **この題材を変えると、着手前の DOM(`__fixtures__/list-undeclared-group-by-before.dom.txt`)
 * との比較が無意味になる** —— 変えるなら着手前の DOM を土台の写しで撮り直すこと。
 *
 * **`import type` だけを使う**(`scripts/kernel-import-drift.test.ts` のスナップショットを動かさない)。
 */
import { expect } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import type { RecordRow } from "../../src/kernel/records.ts";
import type { ListView, Manifest } from "../../src/kernel/types.ts";
import type { Role } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { ListViewRenderer } from "../src/views/ListViewRenderer.tsx";
import { grantRules, viewRead } from "./role-rules.ts";

export const GROUP_APP_ID = "group-app";
export const ITEMS_PATH = `/api/apps/${GROUP_APP_ID}/tables/items/records`;
const VENDORS_PATH = `/api/apps/${GROUP_APP_ID}/tables/vendors/records`;

const OWNER_ROLE: Role = "owner";

/** 行ボタン(`form` 形)。**題材に行ボタンを持たせ、操作の列が在る表で見出しの列数を撃つ。** */
export const NOTE_ACTION = { form: "note-form", prefill: { field: "item" }, name: "メモを書く" };

/** **着手前の DOM を撮ったときと1バイトも違わないマニフェスト**(`extra` を足さない限り)。 */
export function groupManifest(extra: Record<string, unknown> = {}): Manifest {
  const built = {
    app: {
      id: GROUP_APP_ID,
      name: "区切りのサンプル",
      tables: [
        {
          id: "items",
          name: "品目",
          fields: [
            { id: "name", name: "品名", type: "text" },
            { id: "category", name: "種類", type: "select", options: ["食品", "雑貨", "書籍"] },
            { id: "vendor", name: "仕入先", type: "reference", reference_table: "vendors" },
            { id: "urgent", name: "急ぎ", type: "boolean" },
            { id: "due", name: "期限", type: "date" },
          ],
        },
        {
          id: "vendors",
          name: "仕入先",
          fields: [{ id: "vendor_name", name: "名称", type: "text" }],
        },
        {
          id: "notes",
          name: "メモ",
          fields: [
            { id: "item", name: "品目", type: "reference", reference_table: "items" },
            { id: "body", name: "本文", type: "text" },
          ],
        },
      ],
      views: [
        {
          id: "item-list",
          type: "list_view",
          table: "items",
          columns: ["name", "category", "vendor", "urgent", "due"],
          actions: [NOTE_ACTION],
          ...extra,
        },
        { id: "item-detail", type: "detail_view", table: "items" },
        { id: "note-form", type: "form", table: "notes", fields: ["item", "body"] },
      ],
    },
  } as unknown as Manifest;
  return grantRules(built, ["owner"], [viewRead("item-detail"), viewRead("note-form")]);
}

function row(id: string, values: Record<string, unknown>): RecordRow {
  return {
    _id: id,
    _created_at: "2026-09-01T00:00:00Z",
    _updated_at: "2026-09-01T00:00:00Z",
    ...values,
  } as unknown as RecordRow;
}

/** 5行。**種類・仕入先・急ぎ・期限のそれぞれに、値の無い行が在る。** */
export const ITEM_ROWS: RecordRow[] = [
  row("i1", {
    name: "りんご",
    category: "食品",
    vendor: "v1",
    urgent: true,
    due: "2026-09-20",
  }),
  row("i2", {
    name: "パン",
    category: "食品",
    vendor: "v2",
    urgent: false,
    due: "2026-09-21",
  }),
  row("i3", {
    name: "はさみ",
    category: "雑貨",
    vendor: "v1",
    urgent: true,
    due: "2026-09-27",
  }),
  row("i4", {
    name: "のり",
    category: "雑貨",
    vendor: null,
    urgent: null,
    due: "2026-10-01T09:00:00Z",
  }),
  row("i5", { name: "未分類", category: null, vendor: null, urgent: false, due: null }),
];

const VENDOR_ROWS = [
  row("v1", { vendor_name: "山田商会" }),
  row("v2", { vendor_name: "田中商店" }),
];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** **一覧の本体の読取だけを記録する**(参照ラベルの読取は数えない)。 */
export const itemRequests: string[] = [];

/** 一覧の本体の読取に返す応答を、URL から組み立てる(既定は5行をそのまま)。 */
export type ItemResponder = (url: string) => unknown;

let itemResponder: ItemResponder = () => ({ records: ITEM_ROWS, total: ITEM_ROWS.length });

export function setItemResponder(responder: ItemResponder): void {
  itemResponder = responder;
}

let originalFetch: typeof fetch | undefined;

export function installGroupFetch(): void {
  itemRequests.length = 0;
  itemResponder = () => ({ records: ITEM_ROWS, total: ITEM_ROWS.length });
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith(ITEMS_PATH)) {
      itemRequests.push(url);
      return jsonResponse(itemResponder(url));
    }
    if (url.startsWith(VENDORS_PATH)) {
      return jsonResponse({ records: VENDOR_ROWS, total: VENDOR_ROWS.length });
    }
    return jsonResponse({ records: [], total: 0 });
  }) as typeof fetch;
  window.history.replaceState({}, "", `/apps/${GROUP_APP_ID}/views/item-list`);
}

export function restoreGroupFetch(): void {
  if (originalFetch !== undefined) {
    globalThis.fetch = originalFetch;
  }
}

/** 一覧を描いて、`.list-view` の器(`view-renderer-list_view`)を返す。 */
export async function renderGroupList(manifest: Manifest): Promise<HTMLElement> {
  render(
    <RoleProvider role={OWNER_ROLE}>
      <ListViewRenderer
        appId={GROUP_APP_ID}
        manifest={manifest}
        view={manifest.app.views[0] as ListView}
      />
    </RoleProvider>,
  );
  await waitFor(() =>
    expect(
      screen.queryByTestId("list-table") ??
        screen.queryByTestId("list-cards") ??
        screen.queryByTestId("list-empty"),
    ).not.toBeNull(),
  );
  return screen.getByTestId("view-renderer-list_view");
}
