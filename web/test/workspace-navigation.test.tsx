/**
 * **メニューの位置(左 / 上)をアプリの既定と役割ごとの上書きで決める画面の検査**(`V22-M2-T05`)。
 *
 * 根拠: 計画 `docs/plan/v22/00-v22-plan.md` の V22-M2「画面(web)」の 2〜4 / `ADR-0486` §Decision 1 の 6・11 と
 * 限定14 / ユーザ決定 `D-V22-9`(アプリの既定+役割ごとの上書き)・`D-V22-10`(未ログインはアプリの既定)・
 * `D-V22-11`(40rem 未満は常に「≡ メニュー」、40rem 以上ははみ出したら「≡ メニュー」、浮かせて開く)・
 * `D-V22-12`(本文は外枠の幅まで)。
 *
 * **happy-dom は CSS を計算しない。** したがって「40rem 未満では常に ≡」は `sm:` の組のクラスが付いていることまでしか
 * 見られない(実際の幅での見え方は `T08` の e2e が見る)。 はみ出しの判定は `clientWidth` / `scrollWidth` を差し替えて見る。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Manifest, View } from "../../src/kernel/types.ts";
import { App } from "../src/App.tsx";
import { navigate } from "../src/navigation.tsx";
import { RunnerShell } from "../src/runner-app.tsx";
import {
  resolveNavigationPlacement,
  shouldCollapseTopNav,
  ViewNavigation,
} from "../src/ViewNavigation.tsx";
import { grantRules, viewRead } from "./role-rules.ts";

const APP_ID = "nav-place";
const WEB_ROOT = dirname(import.meta.dir);
const APP_ROOT = dirname(WEB_ROOT);

type WorkspaceDeclaration = NonNullable<Manifest["app"]["workspace"]>;

const ENTRY_TABLE = {
  id: "entries",
  name: "エントリ",
  fields: [{ id: "label", name: "ラベル", type: "text" as const, required: true }],
};

/** 画面3枚(並び: 一覧 → 登録 → 隠した一覧)。 3枚目は `menu_listed: false`(メニューに並べない)。 */
function manifestWith(workspace: WorkspaceDeclaration | undefined): Manifest {
  const base: Manifest = {
    app: {
      id: APP_ID,
      name: "位置の店",
      tables: [ENTRY_TABLE],
      views: [
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
        {
          id: "entry-hidden",
          name: "隠した一覧",
          type: "list_view",
          table: "entries",
          columns: ["label"],
          menu_listed: false,
        },
      ],
      ...(workspace === undefined ? {} : { workspace }),
    },
  };
  return grantRules(
    base,
    ["owner", "editor"],
    [viewRead("entry-list"), viewRead("entry-form"), viewRead("entry-hidden")],
  );
}

const PUBLIC_VIEWS = [
  {
    id: "entry-list",
    name: "エントリ一覧",
    type: "list_view",
    table: "entries",
    columns: ["label"],
    tables: [ENTRY_TABLE],
  },
  {
    id: "entry-list-2",
    name: "新着",
    type: "list_view",
    table: "entries",
    columns: ["label"],
    tables: [ENTRY_TABLE],
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

function stubAnonymous(extra: Record<string, unknown>): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input).split("?")[0] ?? "";
    if (url === `/api/apps/${APP_ID}/auth/me` || url === `/api/apps/${APP_ID}/manifest`) {
      return Promise.resolve(
        jsonResponse({ errors: [{ path: "", message: "認証されていません。" }] }, 401),
      );
    }
    if (url === `/api/apps/${APP_ID}/public`) {
      return Promise.resolve(
        jsonResponse({ app: { id: APP_ID, name: "位置の店" }, views: PUBLIC_VIEWS, ...extra }),
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

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

/** メニュー(`view-list`)が置かれた位置。 上なら `data-navigation-placement="top"` の器の中に在る。 */
function placementOf(): "top" | "side" | "unknown" {
  const nav = screen.getByTestId("view-list");
  if (nav.closest('[data-navigation-placement="top"]') !== null) return "top";
  if (nav.parentElement?.classList.contains("workspace-body") === true) return "side";
  return "unknown";
}

// ---------------------------------------------------------------------------
// (P) 位置を決める関数(1本)
// ---------------------------------------------------------------------------

describe("(P) resolveNavigationPlacement", () => {
  test("(P-1) 宣言が無い・空・位置を書いていない → 左", () => {
    expect(resolveNavigationPlacement(undefined, null)).toBe("side");
    expect(resolveNavigationPlacement(undefined, "owner")).toBe("side");
    expect(resolveNavigationPlacement({}, "owner")).toBe("side");
    expect(resolveNavigationPlacement({ navigation: {} }, null)).toBe("side");
  });

  test("(P-2) アプリの既定を上にすると、ログインした人も未ログインも上", () => {
    const workspace: WorkspaceDeclaration = { navigation: { placement: "top" } };
    expect(resolveNavigationPlacement(workspace, "owner")).toBe("top");
    expect(resolveNavigationPlacement(workspace, null)).toBe("top");
  });

  test("(P-3) 役割の上書きが勝つ。 指定の無い役割はアプリの既定", () => {
    const workspace: WorkspaceDeclaration = {
      navigation: { placement: "side", by_role: [{ role: "staff", placement: "top" }] },
    };
    expect(resolveNavigationPlacement(workspace, "staff")).toBe("top");
    expect(resolveNavigationPlacement(workspace, "owner")).toBe("side");
    const reversed: WorkspaceDeclaration = {
      navigation: { placement: "top", by_role: [{ role: "staff", placement: "side" }] },
    };
    expect(resolveNavigationPlacement(reversed, "staff")).toBe("side");
    expect(resolveNavigationPlacement(reversed, "owner")).toBe("top");
  });

  test("(P-4) 未ログイン(役割 null)は役割の上書きを見ず、アプリの既定", () => {
    const workspace: WorkspaceDeclaration = {
      navigation: { by_role: [{ role: "staff", placement: "top" }] },
    };
    expect(resolveNavigationPlacement(workspace, null)).toBe("side");
    expect(resolveNavigationPlacement(workspace, "staff")).toBe("top");
  });

  test("(P-5) 知らない値は左に倒す", () => {
    const unknownDefault = {
      navigation: { placement: "bottom" },
    } as unknown as WorkspaceDeclaration;
    expect(resolveNavigationPlacement(unknownDefault, null)).toBe("side");
    const unknownOverride = {
      navigation: { placement: "top", by_role: [{ role: "staff", placement: "left" }] },
    } as unknown as WorkspaceDeclaration;
    expect(resolveNavigationPlacement(unknownOverride, "staff")).toBe("side");
    expect(resolveNavigationPlacement(null as unknown as WorkspaceDeclaration, "staff")).toBe(
      "side",
    );
  });

  test("(P-6) 位置を役割から導く関数は製品にちょうど1本(ADR-0486 限定14 の式と同じ正規表現)", () => {
    const pattern = /(?:function|const|let|var)\s+(resolveNavigationPlacement[A-Za-z0-9_]*)/g;
    const found: string[] = [];
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return walk(path);
        return (name.endsWith(".ts") || name.endsWith(".tsx")) && !name.endsWith(".test.ts")
          ? [path]
          : [];
      });
    for (const root of [join(APP_ROOT, "src"), join(WEB_ROOT, "src")]) {
      for (const file of walk(root)) {
        for (const match of readFileSync(file, "utf8").matchAll(pattern)) {
          found.push(`${file.slice(APP_ROOT.length + 1)}:${match[1]}`);
        }
      }
    }
    expect(found).toEqual(["web/src/ViewNavigation.tsx:resolveNavigationPlacement"]);
  });
});

// ---------------------------------------------------------------------------
// (C) 折りたたみの判定(純関数)
// ---------------------------------------------------------------------------

describe("(C) shouldCollapseTopNav", () => {
  test("(C-1) 要る幅が使える幅を超えたら畳む。 収まれば畳まない", () => {
    expect(shouldCollapseTopNav({ available: 500, required: 800 })).toBe(true);
    expect(shouldCollapseTopNav({ available: 500, required: 501 })).toBe(true);
    expect(shouldCollapseTopNav({ available: 500, required: 500 })).toBe(false);
    expect(shouldCollapseTopNav({ available: 800, required: 500 })).toBe(false);
  });

  test("(C-2) 測れていない(幅0)ときは畳まない", () => {
    expect(shouldCollapseTopNav({ available: 0, required: 800 })).toBe(false);
    expect(shouldCollapseTopNav({ available: 500, required: 0 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (W) 育成用の版のログイン中の画面
// ---------------------------------------------------------------------------

describe("(W) 育成用の版のログイン中の画面", () => {
  test("(W-1) 宣言が無いアプリは左(workspace-body の器のまま)", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/entry-list`);
    stubSignedIn(manifestWith(undefined), "owner");
    render(<App />);
    await screen.findByTestId("view-list");
    expect(placementOf()).toBe("side");
    expect(document.querySelector("[data-navigation-placement]")).toBeNull();
  });

  test("(W-2) アプリの既定を上にすると上。 本文(workspace-main)はメニューの下で、外枠の幅いっぱい", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/entry-list`);
    stubSignedIn(manifestWith({ navigation: { placement: "top" } }), "owner");
    render(<App />);
    await screen.findByTestId("view-list");
    expect(placementOf()).toBe("top");
    const frame = screen.getByTestId("view-list").closest('[data-navigation-placement="top"]');
    expect(frame?.getAttribute("class")).toBe("flex flex-col gap-s4");
    expect([...(frame?.children ?? [])].map((child) => child.getAttribute("data-testid"))).toEqual([
      "view-list",
      "workspace-main",
    ]);
    expect(document.querySelector(".workspace-body")).toBeNull();
  });

  test("(W-3) 役割の上書き: 既定は左・editor だけ上", async () => {
    const manifest = manifestWith({
      navigation: { placement: "side", by_role: [{ role: "editor", placement: "top" }] },
    });
    for (const [role, expected] of [
      ["editor", "top"],
      ["owner", "side"],
    ] as const) {
      window.history.replaceState({}, "", `/apps/${APP_ID}/views/entry-list`);
      stubSignedIn(manifest, role);
      const view = render(<App />);
      await screen.findByTestId("view-list");
      expect(placementOf()).toBe(expected);
      view.unmount();
    }
  });

  test("(W-4) 上でも、並べない印の画面(menu_listed: false)は並ばず、並びは定義の順のまま・選択中に aria-current", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/entry-form`);
    stubSignedIn(manifestWith({ navigation: { placement: "top" } }), "owner");
    render(<App />);
    const items = await screen.findByTestId("view-list-items");
    const rows = [...items.querySelectorAll("li")];
    expect(rows.map((row) => row.querySelector("a")?.getAttribute("href"))).toEqual([
      `/apps/${APP_ID}/views/entry-list`,
      `/apps/${APP_ID}/views/entry-form`,
    ]);
    expect(rows.map((row) => row.getAttribute("aria-current"))).toEqual([null, "page"]);
  });

  test("(W-5) ≡ メニュー: 見える「≡」は読み上げに隠し、文字は「メニュー」。 40rem 未満で出す sm: の組のクラス", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/entry-list`);
    stubSignedIn(manifestWith({ navigation: { placement: "top" } }), "owner");
    render(<App />);
    const toggle = await screen.findByTestId("view-menu-toggle");
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle.textContent).toBe("≡メニュー");
    const mark = toggle.querySelector('[aria-hidden="true"]');
    expect(mark?.textContent).toBe("≡");
    // 畳んでいない(はみ出していない)ときは、40rem 以上で ≡ を隠し、一覧を横一列で出す。
    expect(screen.getByTestId("view-menu").getAttribute("class")).toBe("flex sm:hidden");
    expect(screen.getByTestId("view-list-items").getAttribute("class")).toContain("hidden sm:flex");
  });

  test("(W-6) ≡ を押すとテーマの器(.app-theme)の内側に浮かせて開き、項目は定義の順・選択中に aria-current", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/entry-form`);
    stubSignedIn(manifestWith({ navigation: { placement: "top" } }), "owner");
    render(<App />);
    fireEvent.click(await screen.findByTestId("view-menu-toggle"));
    await settle();
    const menu = document.querySelector('[data-slot="overlay-menu"]');
    expect(menu).not.toBeNull();
    expect(menu?.closest(".app-theme")).not.toBeNull();
    const items = [...document.querySelectorAll('[data-testid="view-menu-item"]')];
    expect(items.map((item) => item.getAttribute("role"))).toEqual(["menuitem", "menuitem"]);
    expect(items.map((item) => item.textContent)).toEqual([
      "エントリ一覧 一覧",
      "エントリの登録 フォーム",
    ]);
    expect(items.map((item) => item.getAttribute("aria-current"))).toEqual([null, "page"]);
  });

  test("(W-7) Escape で閉じ、フォーカスは ≡ のボタンに戻る", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/entry-list`);
    stubSignedIn(manifestWith({ navigation: { placement: "top" } }), "owner");
    render(<App />);
    const toggle = await screen.findByTestId("view-menu-toggle");
    fireEvent.click(toggle);
    await settle();
    expect(document.querySelector('[data-slot="overlay-menu"]')).not.toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await settle();
    expect(document.querySelector('[data-slot="overlay-menu"]')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("view-menu-toggle"));
  });

  test("(W-8) 項目を選ぶとその画面へ移り、メニューは閉じる", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/entry-list`);
    stubSignedIn(manifestWith({ navigation: { placement: "top" } }), "owner");
    render(<App />);
    fireEvent.click(await screen.findByTestId("view-menu-toggle"));
    await settle();
    const target = [...document.querySelectorAll('[data-testid="view-menu-item"]')][1];
    if (target === undefined) throw new Error("2つ目の項目が無い");
    fireEvent.click(target);
    await settle();
    expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/entry-form`);
    expect(document.querySelector('[data-slot="overlay-menu"]')).toBeNull();
    await waitFor(() =>
      expect(
        [...screen.getByTestId("view-list-items").querySelectorAll("li")].map((row) =>
          row.getAttribute("aria-current"),
        ),
      ).toEqual([null, "page"]),
    );
  });

  test("(W-9) 開いたまま別の画面へ移る(戻るなど)と閉じる", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/entry-list`);
    stubSignedIn(manifestWith({ navigation: { placement: "top" } }), "owner");
    render(<App />);
    fireEvent.click(await screen.findByTestId("view-menu-toggle"));
    await settle();
    expect(document.querySelector('[data-slot="overlay-menu"]')).not.toBeNull();
    act(() => {
      navigate({ kind: "view", appId: APP_ID, viewId: "entry-form" });
    });
    await settle();
    expect(document.querySelector('[data-slot="overlay-menu"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (N) 未ログイン(GET /public 経由)はアプリの既定
// ---------------------------------------------------------------------------

describe("(N) 未ログインはアプリの既定(D-V22-10)", () => {
  test("(N-1) GET /public が位置(上)を返すと上", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/entry-list`);
    stubAnonymous({ workspace: { navigation: { placement: "top" } } });
    render(<App />);
    await screen.findByTestId("anonymous-workspace");
    expect(placementOf()).toBe("top");
  });

  test("(N-2) GET /public が位置を返さなければ左", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/entry-list`);
    stubAnonymous({});
    render(<App />);
    await screen.findByTestId("anonymous-workspace");
    expect(placementOf()).toBe("side");
  });

  test("(N-3) 配る版も同じ(GET /public が上を返すと上)", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/entry-list`);
    stubAnonymous({ workspace: { navigation: { placement: "top" } } });
    render(<RunnerShell appId={APP_ID} />);
    await screen.findByTestId("anonymous-workspace");
    expect(placementOf()).toBe("top");
  });
});

// ---------------------------------------------------------------------------
// (R) 配る版のログイン中
// ---------------------------------------------------------------------------

describe("(R) 配る版のログイン中", () => {
  test("(R-1) 役割の上書きが効く(editor は上 / owner は既定の左)", async () => {
    const manifest = manifestWith({
      navigation: { by_role: [{ role: "editor", placement: "top" }] },
    });
    for (const [role, expected] of [
      ["editor", "top"],
      ["owner", "side"],
    ] as const) {
      window.history.replaceState({}, "", `/apps/${APP_ID}/views/entry-list`);
      stubSignedIn(manifest, role);
      const view = render(<RunnerShell appId={APP_ID} />);
      await screen.findByTestId("view-list");
      expect(placementOf()).toBe(expected);
      view.unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// (M) 40rem 以上ではみ出したら畳む(ResizeObserver と幅の差し替え)
// ---------------------------------------------------------------------------

describe("(M) はみ出しの測り方", () => {
  type Observer = { callback: () => void; targets: Element[] };
  const observers: Observer[] = [];
  let originalResizeObserver: typeof globalThis.ResizeObserver | undefined;
  const saved: Record<string, PropertyDescriptor | undefined> = {};
  /** 画面の幅(nav の幅)と、項目を横一列に並べるのに要る幅。 */
  const widths = { nav: 1000, required: 600 };

  /** 一覧が見えているか(40rem 以上の幅を想定する。`hidden` だけなら見えない)。 */
  function listShown(element: Element): boolean {
    const classes = (element.getAttribute("class") ?? "").split(" ");
    return classes.includes("sm:flex");
  }

  beforeEach(() => {
    observers.length = 0;
    widths.nav = 1000;
    widths.required = 600;
    originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      private readonly entry: Observer;
      constructor(callback: () => void) {
        this.entry = { callback, targets: [] };
        observers.push(this.entry);
      }
      observe(target: Element) {
        this.entry.targets.push(target);
      }
      unobserve() {}
      disconnect() {
        this.entry.targets = [];
      }
    } as unknown as typeof ResizeObserver;
    for (const key of ["clientWidth", "scrollWidth"]) {
      saved[key] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, key);
    }
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get(this: HTMLElement) {
        const id = this.getAttribute("data-testid");
        if (id === "view-list") return widths.nav;
        if (id === "view-list-items") return listShown(this) ? widths.nav : 0;
        return 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get(this: HTMLElement) {
        const id = this.getAttribute("data-testid");
        if (id === "view-list") return widths.nav;
        if (id === "view-list-items") return listShown(this) ? widths.required : 0;
        return 0;
      },
    });
  });

  afterEach(() => {
    globalThis.ResizeObserver = originalResizeObserver as typeof ResizeObserver;
    for (const key of ["clientWidth", "scrollWidth"]) {
      const descriptor = saved[key];
      if (descriptor === undefined) {
        delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
      } else {
        Object.defineProperty(HTMLElement.prototype, key, descriptor);
      }
    }
  });

  function fireResize(): void {
    act(() => {
      for (const observer of observers) {
        if (observer.targets.length > 0) observer.callback();
      }
    });
  }

  const VIEWS: View[] = [
    { id: "a", name: "一つ目", type: "list_view", table: "entries", columns: ["label"] },
    { id: "b", name: "二つ目", type: "list_view", table: "entries", columns: ["label"] },
  ];

  function renderTop(views: readonly View[]) {
    return render(
      <div className="app-theme">
        <ViewNavigation
          appId={APP_ID}
          views={views}
          viewId="a"
          placement="top"
          label={(view) => view.name ?? view.id}
        >
          <p>本文</p>
        </ViewNavigation>
      </div>,
    );
  }

  function collapsed(): boolean {
    return screen.getByTestId("view-menu").getAttribute("class") === "flex";
  }

  test("(M-1) 収まるときは畳まない(40rem 以上では横一列)", () => {
    renderTop(VIEWS);
    expect(collapsed()).toBe(false);
    expect(screen.getByTestId("view-list-items").getAttribute("class")).toContain("sm:flex");
  });

  test("(M-2) はみ出すと畳む(40rem 以上でも ≡ メニュー・一覧は隠す)", () => {
    widths.required = 1400;
    renderTop(VIEWS);
    expect(collapsed()).toBe(true);
    const listClasses = (screen.getByTestId("view-list-items").getAttribute("class") ?? "").split(
      " ",
    );
    expect(listClasses).toContain("hidden");
    expect(listClasses).not.toContain("sm:flex");
  });

  test("(M-3) 畳んだ後に幅が広がったら、覚えておいた要る幅と比べて戻す", () => {
    widths.required = 1400;
    renderTop(VIEWS);
    expect(collapsed()).toBe(true);
    widths.nav = 1200;
    fireResize();
    expect(collapsed()).toBe(true);
    widths.nav = 1500;
    fireResize();
    expect(collapsed()).toBe(false);
    // 戻した後に狭めると、また畳む。
    widths.nav = 900;
    fireResize();
    expect(collapsed()).toBe(true);
  });

  test("(M-4) 画面の並びが変わったら測り直す(項目が減って収まれば戻る)", () => {
    widths.required = 1400;
    const view = renderTop(VIEWS);
    expect(collapsed()).toBe(true);
    widths.required = 400;
    view.rerender(
      <div className="app-theme">
        <ViewNavigation
          appId={APP_ID}
          views={VIEWS.slice(0, 1)}
          viewId="a"
          placement="top"
          label={(entry) => entry.name ?? entry.id}
        >
          <p>本文</p>
        </ViewNavigation>
      </div>,
    );
    expect(collapsed()).toBe(false);
  });

  test("(M-5) 左のときは測らない(ResizeObserver を1つも作らない)", () => {
    render(
      <ViewNavigation
        appId={APP_ID}
        views={VIEWS}
        viewId="a"
        placement="side"
        label={(view) => view.name ?? view.id}
      />,
    );
    expect(observers.filter((observer) => observer.targets.length > 0)).toHaveLength(0);
    expect(screen.queryByTestId("view-menu")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (S) 書き方の縛り(静的なクラス・断点を増やさない)
// ---------------------------------------------------------------------------

describe("(S) 書き方の縛り", () => {
  // **注釈を落としてからコードだけを見る**(注釈は「書かない」ことを名指しで書いているため)。
  const source = readFileSync(join(WEB_ROOT, "src", "ViewNavigation.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  test("(S-1) クラス名を値から組み立てない(テンプレート文字列のクラス名が無い)", () => {
    expect(source.includes("className={`")).toBe(false);
    expect(/className=\{[^}]*\+/.test(source)).toBe(false);
  });

  test("(S-2) 新しい断点・@media・@container を書かない(使う断点は sm: だけ)", () => {
    expect(source.includes("@media")).toBe(false);
    expect(source.includes("@container")).toBe(false);
    for (const prefix of ["md:", "lg:", "xl:", "2xl:", "max-sm:", "min-["]) {
      expect(source.includes(prefix), prefix).toBe(false);
    }
    expect(source.includes("sm:")).toBe(true);
  });
});
