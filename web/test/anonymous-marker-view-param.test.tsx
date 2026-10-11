/**
 * **未ログインに開く一覧は、レコード取得の要求に `?view=` を載せて画面を名乗る**(`V23-M9-T02`。
 * ユーザ決定 `D-V23-261`。`ADR-0550` §Decision 4-1 の「画面の側」)。
 *
 * サーバは、未ログインが送った「消せない」「直接作れない」の印の2列の並べ替え・絞り込みを、
 * 名乗った画面の宣言と同じときだけ通す。 画面は宣言の並べ替え・絞り込みも利用者が打ったものと同じ
 * 引数で送るので、未ログインに開く一覧が名乗っていなければ、印の列で並べる・絞ると宣言した公開画面が
 * 断られる。 ここでは、画面の URL を1バイトも変えずに名乗っていることを確かめる。
 *
 * - 未ログインに開く画面(`canUseView(ANONYMOUS, …)` が真)は、規則が名指しした画面なので
 *   `viewIdForRecordRequest` が画面 ID を返す(規則が名指ししない画面は閉じる。`D-V8-45`・`D-V8-65`)。
 * - 実際に描くと、宣言の並べ替え・絞り込みと一緒に `view=<画面 ID>` が載る。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { Manifest, View } from "../../src/kernel/types.ts";
import { ANONYMOUS, canUseView, RoleProvider, viewIdForRecordRequest } from "../src/auth/authz.tsx";
import { ListViewRenderer } from "../src/views/ListViewRenderer.tsx";

const APP_ID = "marker-view-param";

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "印の名乗り",
      tables: [
        {
          id: "flags",
          name: "公開の印の表",
          fields: [
            { id: "title", name: "件名", type: "text" },
            { id: "st_undeletable", name: "消せない", type: "boolean" },
            { id: "st_no_direct_create", name: "直接作れない", type: "boolean" },
            { id: "st_public", name: "公開", type: "boolean" },
          ],
        },
      ],
      views: [
        {
          id: "public-sorted",
          name: "印で並べる",
          type: "list_view",
          table: "flags",
          columns: ["title"],
          sort: [
            { field: "st_undeletable", order: "desc" },
            { field: "title", order: "asc" },
          ],
        },
        {
          id: "public-filtered",
          name: "印で絞る",
          type: "list_view",
          table: "flags",
          columns: ["title"],
          filter: [{ field: "st_no_direct_create", equals: true }],
        },
        {
          id: "staff-list",
          name: "運営の一覧",
          type: "list_view",
          table: "flags",
          columns: ["title"],
        },
      ],
      roles: [
        {
          id: "anonymous",
          name: "未ログイン",
          rules: [
            { target: "view", view: "public-sorted", can: ["read"] },
            { target: "view", view: "public-filtered", can: ["read"] },
            { target: "table", table: "flags", can: ["read"] },
          ],
        },
        {
          id: "owner",
          name: "運営",
          rules: [
            { target: "view", view: "staff-list", can: ["read"] },
            { target: "table", table: "flags", can: ["read", "write", "delete"] },
          ],
        },
      ],
    },
  } as unknown as Manifest;
}

function listViewOf(id: string): Extract<View, { type: "list_view" }> {
  const view = manifest().app.views.find((candidate) => candidate.id === id);
  if (view === undefined || view.type !== "list_view") {
    throw new Error("fixture broken");
  }
  return view;
}

let requestedUrls: string[];
let originalFetch: typeof fetch;

beforeEach(() => {
  requestedUrls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    requestedUrls.push(url);
    return new Response(JSON.stringify({ records: [], total: 0 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("D-V23-261: 未ログインに開く画面は、どれもレコード取得で画面を名乗る", () => {
  const source = manifest();
  const opened = source.app.views.filter((view) => canUseView(ANONYMOUS, source, view));
  expect(opened.map((view) => view.id)).toEqual(["public-sorted", "public-filtered"]);
  for (const view of opened) {
    expect(viewIdForRecordRequest(source, view)).toBe(view.id);
  }
});

for (const [viewId, declared] of [
  ["public-sorted", "sort=st_undeletable&order=desc&sort=title&order=asc"],
  ["public-filtered", "filter.st_no_direct_create=true"],
] as const) {
  test(`D-V23-261: 未ログインで ${viewId} を描くと、宣言の引数と一緒に view= が載る`, async () => {
    render(
      <RoleProvider role={ANONYMOUS}>
        <ListViewRenderer appId={APP_ID} manifest={manifest()} view={listViewOf(viewId)} />
      </RoleProvider>,
    );
    await waitFor(() => {
      expect(requestedUrls.some((url) => url.includes("/tables/flags/records"))).toBe(true);
    });
    const recordUrl = requestedUrls.find((url) => url.includes("/tables/flags/records")) ?? "";
    expect(recordUrl).toContain(declared);
    expect(recordUrl).toContain(`view=${viewId}`);
  });
}
