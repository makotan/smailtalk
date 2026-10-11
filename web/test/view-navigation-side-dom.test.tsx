/**
 * **メニューが「左」のときの DOM を固定する**(`V22-M2-T04`。計画 `docs/plan/v22/00-v22-plan.md` の
 * V22-M2「画面(web)」の 1 / `ADR-0486` §Decision 1 の 11「左のときの見た目と DOM は今日と同じ」)。
 *
 * **この検査は抜き出す前のコード(`f7bb4136`)で緑であることを先に確かめてから、共通の部品
 * (`web/src/ViewNavigation.tsx`)への抜き出しを行った。** 抜き出した後も同じ文字列であることを見る。
 *
 * 当てる場所は3か所(と、その中の空の表し方の3通り):
 *
 * - 育成用の版のログイン中の画面(`web/src/AppWorkspace.tsx` の `AuthenticatedWorkspace`)
 *   —— 画面あり / 画面が1つも無い(`data-reason="none"`)/ この役割で使える画面が無い(`data-reason="role"`)
 * - 育成用の版の未ログインの画面(同 `AnonymousWorkspace`。`GET /public` 経由)
 * - 配る版(`web/src/runner-app.tsx` の `Body`)—— ログイン中 / 画面が無い / 未ログイン(`GET /public` 経由)
 *
 * **固定するもの**: `nav[data-testid="view-list"]` の `outerHTML` まるごと(`aria-current` の当たり先・
 * 画面の種別の添え書き・空のときの文面と `data-reason` を含む)と、`.workspace-body` の開始タグと
 * 直下の子の開始タグ(`view-list` / `workspace-main` の並び)。 **本文(`workspace-main` の中身)は
 * 画面の描画に依るので固定しない。**
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { Manifest } from "../../src/kernel/types.ts";
import { App } from "../src/App.tsx";
import { RunnerShell } from "../src/runner-app.tsx";
import { grantRules, viewRead } from "./role-rules.ts";

const APP_ID = "side-dom";

function baseManifest(withViews: boolean): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "左の器",
      tables: [
        {
          id: "entries",
          name: "エントリ",
          fields: [{ id: "label", name: "ラベル", type: "text", required: true }],
        },
      ],
      views: withViews
        ? [
            {
              id: "entry-list",
              name: "エントリ一覧",
              type: "list_view",
              table: "entries",
              columns: ["label"],
            },
            {
              id: "entry-form",
              name: "エントリの登録",
              type: "form",
              table: "entries",
              fields: ["label"],
            },
          ]
        : [],
    },
  };
}

function grantedManifest(): Manifest {
  return grantRules(
    baseManifest(true),
    ["owner"],
    [viewRead("entry-list"), viewRead("entry-form")],
  );
}

const PUBLIC_TABLE = {
  id: "entries",
  name: "エントリ",
  fields: [{ id: "label", name: "ラベル", type: "text", required: true }],
};

const PUBLIC_VIEWS = [
  {
    id: "entry-list",
    name: "エントリ一覧",
    type: "list_view",
    table: "entries",
    columns: ["label"],
    tables: [PUBLIC_TABLE],
  },
  {
    id: "entry-list-2",
    name: "新着",
    type: "list_view",
    table: "entries",
    columns: ["label"],
    tables: [PUBLIC_TABLE],
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let originalFetch: typeof fetch;

function stubSignedIn(manifest: Manifest, role: string): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input).split("?")[0] ?? "";
    if (url === `/api/apps/${APP_ID}/auth/me`) {
      return Promise.resolve(
        jsonResponse({ user: { id: "u1", username: "alice", displayName: null, role } }),
      );
    }
    if (url === `/api/apps/${APP_ID}/manifest`) {
      return Promise.resolve(jsonResponse(manifest));
    }
    if (url === `/api/apps/${APP_ID}/tables/entries/records`) {
      return Promise.resolve(jsonResponse({ records: [], total: 0 }));
    }
    return Promise.resolve(jsonResponse({ errors: [{ path: "", message: "no stub" }] }, 404));
  }) as typeof fetch;
}

function stubAnonymous(): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input).split("?")[0] ?? "";
    if (url === `/api/apps/${APP_ID}/auth/me` || url === `/api/apps/${APP_ID}/manifest`) {
      return Promise.resolve(
        jsonResponse({ errors: [{ path: "", message: "認証されていません。" }] }, 401),
      );
    }
    if (url === `/api/apps/${APP_ID}/public`) {
      return Promise.resolve(
        jsonResponse({ app: { id: APP_ID, name: "左の器" }, views: PUBLIC_VIEWS }),
      );
    }
    if (url === `/api/apps/${APP_ID}/tables/entries/records`) {
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

/** 開始タグだけ(属性の並びごと)。 */
function openingTag(element: Element): string {
  const html = element.outerHTML;
  return html.slice(0, html.indexOf(">") + 1);
}

/** 固定する形: `.workspace-body` の開始タグ / 直下の子の開始タグ / `nav` の outerHTML。 */
async function sideShape(): Promise<{ body: string; children: string[]; nav: string }> {
  const nav = await screen.findByTestId("view-list");
  const body = nav.parentElement;
  if (body === null) throw new Error("view-list に親が無い");
  return {
    body: openingTag(body),
    children: [...body.children].map(openingTag),
    nav: nav.outerHTML,
  };
}

const SIDE_CHILDREN = [
  '<nav class="view-list" data-testid="view-list">',
  '<div class="workspace-main" data-testid="workspace-main">',
];

describe("(S) 育成用の版のログイン中の画面(AuthenticatedWorkspace)", () => {
  test("(S-1) 画面あり・選択中の画面に aria-current", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/entry-list`);
    stubSignedIn(grantedManifest(), "owner");
    render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId("view-list").querySelectorAll("li").length).toBe(2),
    );
    const shape = await sideShape();
    expect(shape.body).toBe('<div class="workspace-body">');
    expect(shape.children).toEqual(SIDE_CHILDREN);
    expect(shape.nav).toBe(PINNED.workspaceWithViews);
  });

  test("(S-2) 画面が1つも無い(data-reason=none)", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}`);
    stubSignedIn(baseManifest(false), "owner");
    render(<App />);
    await screen.findByTestId("view-list-empty");
    const shape = await sideShape();
    expect(shape.body).toBe('<div class="workspace-body">');
    expect(shape.children).toEqual(SIDE_CHILDREN);
    expect(shape.nav).toBe(PINNED.workspaceEmptyNone);
  });

  test("(S-3) この役割で使える画面が無い(data-reason=role)", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}`);
    stubSignedIn(grantedManifest(), "viewer");
    render(<App />);
    await screen.findByTestId("view-list-empty");
    const shape = await sideShape();
    expect(shape.body).toBe('<div class="workspace-body">');
    expect(shape.children).toEqual(SIDE_CHILDREN);
    expect(shape.nav).toBe(PINNED.workspaceEmptyRole);
  });
});

describe("(A) 育成用の版の未ログインの画面(AnonymousWorkspace。GET /public 経由)", () => {
  test("(A-1) 公開の画面2枚・選択中に aria-current", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/entry-list-2`);
    stubAnonymous();
    render(<App />);
    await screen.findByTestId("anonymous-workspace");
    const shape = await sideShape();
    expect(shape.body).toBe('<div class="workspace-body">');
    expect(shape.children).toEqual(SIDE_CHILDREN);
    expect(shape.nav).toBe(PINNED.anonymousWorkspace);
  });
});

describe("(R) 配る版(runner-app.tsx の Body)", () => {
  test("(R-1) ログイン中・画面あり・選択中に aria-current", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/entry-form`);
    stubSignedIn(grantedManifest(), "owner");
    render(<RunnerShell appId={APP_ID} />);
    await waitFor(() =>
      expect(screen.getByTestId("view-list").querySelectorAll("li").length).toBe(2),
    );
    const shape = await sideShape();
    expect(shape.body).toBe('<div class="workspace-body">');
    expect(shape.children).toEqual(SIDE_CHILDREN);
    expect(shape.nav).toBe(PINNED.runnerWithViews);
  });

  test("(R-2) ログイン中・使える画面が無い", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}`);
    stubSignedIn(baseManifest(false), "owner");
    render(<RunnerShell appId={APP_ID} />);
    await screen.findByTestId("view-list-empty");
    const shape = await sideShape();
    expect(shape.body).toBe('<div class="workspace-body">');
    expect(shape.children).toEqual(SIDE_CHILDREN);
    expect(shape.nav).toBe(PINNED.runnerEmpty);
  });

  test("(R-3) 未ログイン(GET /public 経由)", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/entry-list`);
    stubAnonymous();
    render(<RunnerShell appId={APP_ID} />);
    await screen.findByTestId("anonymous-workspace");
    const shape = await sideShape();
    expect(shape.body).toBe('<div class="workspace-body">');
    expect(shape.children).toEqual(SIDE_CHILDREN);
    expect(shape.nav).toBe(PINNED.runnerAnonymous);
  });
});

/** **抜き出す前のコード(`f7bb4136`)で描いた文字列をそのまま写した。** */
const PINNED = {
  workspaceWithViews:
    '<nav class="view-list" data-testid="view-list"><ul class="flex flex-col gap-s1"><li class="flex flex-wrap items-baseline gap-s1" aria-current="page"><a href="/apps/side-dom/views/entry-list">エントリ一覧 <span class="meta text-muted-foreground">一覧</span></a></li><li class="flex flex-wrap items-baseline gap-s1"><a href="/apps/side-dom/views/entry-form">エントリの登録 <span class="meta text-muted-foreground">フォーム</span></a></li></ul></nav>',
  workspaceEmptyNone:
    '<nav class="view-list" data-testid="view-list"><p data-testid="view-list-empty" data-reason="none" class="m-0 text-muted-foreground">このアプリにはまだ画面がありません。壊れているわけではありません ―― 画面を作ると、ここに並びます。</p><ul class="flex flex-col gap-s1"></ul></nav>',
  workspaceEmptyRole:
    '<nav class="view-list" data-testid="view-list"><p data-testid="view-list-empty" data-reason="role" class="m-0 text-muted-foreground">いまのロールで使える画面がありません。壊れているわけではありません ―― 表示できるものが無いだけです。見たい画面がある場合は、このアプリの運営者に 問い合わせてください。</p><ul class="flex flex-col gap-s1"></ul></nav>',
  anonymousWorkspace:
    '<nav class="view-list" data-testid="view-list"><ul class="flex flex-col gap-s1"><li class="flex flex-wrap items-baseline gap-s1"><a href="/apps/side-dom/views/entry-list">エントリ一覧 <span class="meta text-muted-foreground">一覧</span></a></li><li class="flex flex-wrap items-baseline gap-s1" aria-current="page"><a href="/apps/side-dom/views/entry-list-2">新着 <span class="meta text-muted-foreground">一覧</span></a></li></ul></nav>',
  runnerWithViews:
    '<nav class="view-list" data-testid="view-list"><ul class="flex flex-col gap-s1"><li class="flex flex-wrap items-baseline gap-s1"><a href="/apps/side-dom/views/entry-list">エントリ一覧</a></li><li class="flex flex-wrap items-baseline gap-s1" aria-current="page"><a href="/apps/side-dom/views/entry-form">エントリの登録</a></li></ul></nav>',
  runnerEmpty:
    '<nav class="view-list" data-testid="view-list"><p data-testid="view-list-empty" class="m-0 text-muted-foreground">いま使える画面がありません。壊れているわけではありません。</p><ul class="flex flex-col gap-s1"></ul></nav>',
  runnerAnonymous:
    '<nav class="view-list" data-testid="view-list"><ul class="flex flex-col gap-s1"><li class="flex flex-wrap items-baseline gap-s1" aria-current="page"><a href="/apps/side-dom/views/entry-list">エントリ一覧</a></li><li class="flex flex-wrap items-baseline gap-s1"><a href="/apps/side-dom/views/entry-list-2">新着</a></li></ul></nav>',
};
