/**
 * **マイページのあるアプリで、開ける画面が0枚のときのメニュー**(`V22-M4-T02` / `ADR-0494` §Decision 2 /
 * ユーザ決定 `D-V22-30`・メインの裁定 `D-V22-40`)。
 *
 * - 役割が開ける画面0枚(`data-reason="role"`)と、アプリに画面0枚(`data-reason="none"`)の両方で、
 *   マイページがあれば「使える画面がありません」の文(`view-list-empty`)を出さず、メニューに「マイページ」だけを出す。
 * - 左・上(横一列)・「≡ メニュー」のどれでも。 育成用の版(`App`)と配る版(`RunnerShell`)の両方。
 * - **陰性対照**: マイページの無いアプリは、今日どおり `view-list-empty` が出る(`data-reason` も同じ)。
 *
 * **測らないこと(誇張しない)**: 幅で「≡」と横一列のどちらが見えるかは jsdom では測れない(DOM に両方が在る)。
 * 実ブラウザの幅は e2e。 本物のサーバには当てていない(`fetch` の差し替え)。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import type { Manifest } from "../../src/kernel/types.ts";
import { App } from "../src/App.tsx";
import { RunnerShell } from "../src/runner-app.tsx";
import { grantRules, viewRead } from "./role-rules.ts";

const APP_ID = "empty-menu-app";

type NavigationDeclaration = NonNullable<Manifest["app"]["workspace"]>["navigation"];

/**
 * 題材。 `withViews` が偽ならアプリに画面が0枚。 画面があるときは `member` だけが開ける
 * (`guest` は画面の規則を1本も持たないので、開ける画面が0枚になる。既定で閉じる)。
 */
function manifestWith(options: {
  myPage: boolean;
  withViews: boolean;
  navigation?: NavigationDeclaration;
}): Manifest {
  const workspace = {
    ...(options.navigation === undefined ? {} : { navigation: options.navigation }),
    ...(options.myPage ? { my_page: {} } : {}),
  };
  const base: Manifest = {
    app: {
      id: APP_ID,
      name: "空の店",
      tables: [
        {
          id: "notes",
          name: "メモ",
          fields: [
            { id: "title", name: "題", type: "text", required: true },
            { id: "st_owner", name: "所有者", type: "text" },
          ],
        },
      ],
      views: options.withViews
        ? [
            {
              id: "note-list",
              name: "メモ一覧",
              type: "list_view",
              table: "notes",
              columns: ["title"],
            },
          ]
        : [],
      ...(Object.keys(workspace).length === 0 ? {} : { workspace }),
    },
  };
  return options.withViews ? grantRules(base, ["member"], [viewRead("note-list")]) : base;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let originalFetch: typeof fetch;

function stub(manifest: Manifest, role: string): void {
  const user = { id: "u-1", username: "taro", displayName: "太郎", role };
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = String(input).split("?")[0] ?? "";
    if (path === `/api/apps/${APP_ID}/auth/me`) {
      return Promise.resolve(jsonResponse({ user }));
    }
    if (path === `/api/apps/${APP_ID}/manifest`) {
      return Promise.resolve(jsonResponse(manifest));
    }
    if (path.startsWith(`/api/apps/${APP_ID}/tables/`)) {
      return Promise.resolve(jsonResponse({ records: [], total: 0 }));
    }
    return Promise.resolve(jsonResponse({ errors: [{ path: "", message: "no stub" }] }, 404));
  }) as typeof fetch;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
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

/** 役割が開ける画面0枚(`role`)と、アプリに画面0枚(`none`)。 */
const CASES: readonly { readonly reason: "role" | "none"; readonly withViews: boolean }[] = [
  { reason: "role", withViews: true },
  { reason: "none", withViews: false },
];

for (const shell of SHELLS) {
  for (const { reason, withViews } of CASES) {
    describe(`画面0枚(${reason})のメニュー(${shell.label})`, () => {
      test(`(${reason}-左) マイページがあれば空の文を出さず、メニューはマイページだけ`, async () => {
        window.history.replaceState({}, "", `/apps/${APP_ID}`);
        stub(manifestWith({ myPage: true, withViews }), "guest");
        render(shell.element());
        const nav = await screen.findByTestId("view-list");
        await settle();
        expect(screen.queryAllByTestId("view-list-empty")).toHaveLength(0);
        expect(screen.queryAllByTestId("view-list-my-page")).toHaveLength(1);
        expect([...nav.querySelectorAll("li")].map((row) => row.textContent)).toEqual([
          "マイページ",
        ]);
      });

      test(`(${reason}-上と≡) マイページがあれば空の文を出さず、横一列と「≡ メニュー」はマイページだけ`, async () => {
        window.history.replaceState({}, "", `/apps/${APP_ID}`);
        stub(manifestWith({ myPage: true, withViews, navigation: { placement: "top" } }), "guest");
        render(shell.element());
        const items = await screen.findByTestId("view-list-items");
        await settle();
        expect(screen.queryAllByTestId("view-list-empty")).toHaveLength(0);
        expect(
          [...items.querySelectorAll("li")].map((row) => row.getAttribute("data-testid")),
        ).toEqual(["view-list-my-page"]);
        fireEvent.click(screen.getByTestId("view-menu-toggle"));
        await settle();
        const menu = document.querySelector('[data-slot="overlay-menu"]');
        const menuItems = [...(menu?.querySelectorAll('[role="menuitem"]') ?? [])];
        expect(menuItems.map((item) => item.getAttribute("data-testid"))).toEqual([
          "view-menu-my-page",
        ]);
        expect(screen.queryAllByTestId("view-list-empty")).toHaveLength(0);
      });

      test(`(${reason}-陰性対照) マイページの無いアプリは今日どおり空の文が出る`, async () => {
        window.history.replaceState({}, "", `/apps/${APP_ID}`);
        stub(manifestWith({ myPage: false, withViews }), "guest");
        render(shell.element());
        const empty = await screen.findByTestId("view-list-empty");
        expect(screen.queryAllByTestId("view-list-empty")).toHaveLength(1);
        expect(screen.queryByTestId("view-list-my-page")).toBeNull();
        if (shell.label.startsWith("育成用")) {
          expect(empty.getAttribute("data-reason")).toBe(reason);
        } else {
          expect(empty.textContent).toContain("いま使える画面がありません。");
        }
      });

      test(`(${reason}-陰性対照・上) マイページの無いアプリは上のメニューでも今日どおり空の文が出て、≡ は出ない`, async () => {
        window.history.replaceState({}, "", `/apps/${APP_ID}`);
        stub(manifestWith({ myPage: false, withViews, navigation: { placement: "top" } }), "guest");
        render(shell.element());
        await screen.findByTestId("view-list-empty");
        expect(screen.queryAllByTestId("view-list-empty")).toHaveLength(1);
        expect(screen.queryByTestId("view-menu")).toBeNull();
      });
    });
  }
}
