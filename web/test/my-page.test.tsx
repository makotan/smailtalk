/**
 * **マイページの画面の検査**(`V22-M3-T05`)。
 *
 * 根拠: 計画 `docs/plan/v22/00-v22-plan.md` の V22-M3「画面(作業画面と配る版)」と「T05 で見ること」/
 * `ADR-0488` §Decision 1 の 6・7(`ADR-0490` §Decision 1 の行3 が 6 を引き直した)/ ユーザ決定
 * `D-V22-3`(アカウント情報・自分の記録・作り手が選んだ画面)・`D-V22-6`(上端の「アカウント」を入れ替える)・
 * `D-V22-16`(ログインした全員)・`D-V22-18`(選んだ画面は開くボタン)・`D-V22-19`(10件+もっと見る、新しい順)・
 * `D-V22-20`(メニューの先頭にも)・`D-V22-24`(一覧画面をすべて隠した役割には出さない)・
 * `D-V22-25`(登録直後の自動オープンが先)。
 *
 * **マイページの無いアプリの DOM が変わらないことは、既存の4ファイル(`view-navigation-side-dom` /
 * `role-visibility` / `app-workspace` / `anonymous-view`)が見る。** ここでは宣言の無いアプリで
 * 「マイページ」の綴りが1つも出ないことだけを足して見る。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Manifest } from "../../src/kernel/types.ts";
import { App } from "../src/App.tsx";
import { navigate } from "../src/navigation.tsx";
import { RunnerShell } from "../src/runner-app.tsx";
import { grantRules, viewRead } from "./role-rules.ts";

const APP_ID = "mypage-app";

type MyPageDeclaration = NonNullable<NonNullable<Manifest["app"]["workspace"]>["my_page"]>;
type NavigationDeclaration = NonNullable<Manifest["app"]["workspace"]>["navigation"];

/**
 * 題材。 表は4枚:
 *  - `notes`(`st_owner` つき。一覧・詳細・入力の3画面)
 *  - `requests`(担当者の列 `assignee` を `include` で足す。一覧だけで詳細が無い → 行は押せない)
 *  - `secrets`(`st_owner` つき。一覧はあるが `member` には開けない → 節を出さない。`D-V22-24`)
 *  - `drafts`(`st_owner` つき。`exclude` で外す)
 * 画面 `staff-list` は `member` に開けない(選んだ画面から落ちる)。
 */
function manifestWith(
  myPage: MyPageDeclaration | undefined,
  navigation?: NavigationDeclaration,
): Manifest {
  const workspace = {
    ...(navigation === undefined ? {} : { navigation }),
    ...(myPage === undefined ? {} : { my_page: myPage }),
  };
  const base: Manifest = {
    app: {
      id: APP_ID,
      name: "自分の店",
      tables: [
        {
          id: "notes",
          name: "メモ",
          fields: [
            { id: "title", name: "題", type: "text", required: true },
            { id: "st_owner", name: "所有者", type: "text" },
          ],
        },
        {
          id: "requests",
          name: "依頼",
          fields: [
            { id: "subject", name: "件名", type: "text", required: true },
            { id: "assignee", name: "担当者", type: "text" },
          ],
        },
        {
          id: "secrets",
          name: "秘密",
          fields: [
            { id: "label", name: "名前", type: "text", required: true },
            { id: "st_owner", name: "所有者", type: "text" },
          ],
        },
        {
          id: "drafts",
          name: "下書き",
          fields: [
            { id: "label", name: "名前", type: "text", required: true },
            { id: "st_owner", name: "所有者", type: "text" },
          ],
        },
      ],
      views: [
        {
          id: "note-list",
          name: "メモ一覧",
          type: "list_view",
          table: "notes",
          columns: ["title"],
        },
        { id: "note-detail", name: "メモの詳細", type: "detail_view", table: "notes" },
        { id: "note-form", name: "メモを書く", type: "form", table: "notes", fields: ["title"] },
        {
          id: "request-list",
          name: "依頼一覧",
          type: "list_view",
          table: "requests",
          columns: ["subject"],
        },
        {
          id: "secret-list",
          name: "秘密一覧",
          type: "list_view",
          table: "secrets",
          columns: ["label"],
        },
        {
          id: "draft-list",
          name: "下書き一覧",
          type: "list_view",
          table: "drafts",
          columns: ["label"],
        },
        {
          id: "staff-list",
          name: "スタッフ用",
          type: "list_view",
          table: "notes",
          columns: ["title"],
        },
      ],
      ...(Object.keys(workspace).length === 0 ? {} : { workspace }),
    },
  };
  grantRules(
    base,
    ["member"],
    [
      viewRead("note-list"),
      viewRead("note-detail"),
      viewRead("note-form"),
      viewRead("request-list"),
      viewRead("draft-list"),
    ],
  );
  return grantRules(
    base,
    ["owner"],
    [
      viewRead("note-list"),
      viewRead("note-detail"),
      viewRead("note-form"),
      viewRead("request-list"),
      viewRead("secret-list"),
      viewRead("draft-list"),
      viewRead("staff-list"),
    ],
  );
}

/** 宣言の既定の形(ログイン直後に開く・`requests` を足す・`drafts` を外す・選んだ画面2つ)。 */
const FULL: MyPageDeclaration = {
  open_after_login: true,
  tables: {
    exclude: ["drafts"],
    include: [{ table: "requests", owner_field: "assignee" }],
  },
  views: ["note-form", "staff-list"],
};

const USER = { id: "u-7", username: "hanako", displayName: "花子", role: "member" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 行を作る(新しい順に並んでいる前提。サーバが並べる)。 */
function noteRows(from: number, to: number): { _id: string; title: string; st_owner: string }[] {
  const rows = [];
  for (let index = from; index < to; index += 1) {
    rows.push({ _id: `n-${index}`, title: `メモ${index}`, st_owner: USER.id });
  }
  return rows;
}

type StubOptions = {
  /** 最初からセッションが在るか(無ければ `me` は 401 で、ログインすると在るに変わる)。 */
  signedIn: boolean;
  manifest: Manifest;
  /** 未ログインの `GET /public` の画面(省略すると0枚)。 */
  publicViews?: unknown[];
  /** `notes` の自分の行の件数(既定 13)。 */
  noteCount?: number;
  role?: string;
  /**
   * 【V22-M3-T08a 軽-7】`notes` の1回目の読みの後に、新しい行をこの件数だけ先頭に足す
   * (「もっと見る」の2回目の読みで、1回目に読んだ末尾の行がもう一度返る状況を作る)。
   */
  newRowsAfterFirst?: number;
};

type Stub = { requested: string[] };

let originalFetch: typeof fetch;

function stub(options: StubOptions): Stub {
  const state = { signedIn: options.signedIn };
  const requested: string[] = [];
  const user = { ...USER, role: options.role ?? USER.role };
  const noteCount = options.noteCount ?? 13;
  let noteReads = 0;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    const path = url.split("?")[0] ?? url;
    const query = new URLSearchParams(url.includes("?") ? url.slice(url.indexOf("?") + 1) : "");
    if (path === `/api/apps/${APP_ID}/auth/me`) {
      return Promise.resolve(
        state.signedIn
          ? jsonResponse({ user })
          : jsonResponse({ errors: [{ path: "", message: "認証されていません。" }] }, 401),
      );
    }
    if (path === `/api/apps/${APP_ID}/auth/password/login`) {
      state.signedIn = true;
      return Promise.resolve(jsonResponse({ user }));
    }
    if (path === `/api/apps/${APP_ID}/auth/logout`) {
      state.signedIn = false;
      return Promise.resolve(jsonResponse({ ok: true }));
    }
    if (path === `/api/apps/${APP_ID}/manifest`) {
      return Promise.resolve(
        state.signedIn
          ? jsonResponse(options.manifest)
          : jsonResponse({ errors: [{ path: "", message: "認証されていません。" }] }, 401),
      );
    }
    if (path === `/api/apps/${APP_ID}/public`) {
      return Promise.resolve(
        jsonResponse({
          app: { id: APP_ID, name: "自分の店" },
          views: options.publicViews ?? [],
        }),
      );
    }
    if (path === `/api/apps/${APP_ID}/tables/notes/records` && query.get("my_page") === "1") {
      const offset = Number(query.get("offset") ?? "0");
      const limit = Number(query.get("limit") ?? "10");
      const added = noteReads > 0 ? (options.newRowsAfterFirst ?? 0) : 0;
      noteReads += 1;
      const fresh = [];
      for (let index = 0; index < added; index += 1) {
        fresh.push({ _id: `new-${index}`, title: `新しいメモ${index}`, st_owner: USER.id });
      }
      const all = [...fresh, ...noteRows(0, noteCount)];
      return Promise.resolve(
        jsonResponse({ records: all.slice(offset, offset + limit), total: all.length }),
      );
    }
    if (path === `/api/apps/${APP_ID}/tables/requests/records` && query.get("my_page") === "1") {
      return Promise.resolve(
        jsonResponse({
          records: [{ _id: "r-1", subject: "棚の修理", assignee: USER.id }],
          total: 1,
        }),
      );
    }
    if (path.startsWith(`/api/apps/${APP_ID}/tables/`)) {
      return Promise.resolve(jsonResponse({ records: [], total: 0 }));
    }
    return Promise.resolve(jsonResponse({ errors: [{ path: "", message: "no stub" }] }, 404));
  }) as typeof fetch;
  return { requested };
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

async function logIn(): Promise<void> {
  await screen.findByTestId("password-login");
  fireEvent.change(screen.getByTestId("auth-username"), { target: { value: USER.username } });
  fireEvent.change(screen.getByTestId("auth-password"), { target: { value: "pw" } });
  fireEvent.click(screen.getByTestId("password-login"));
  await screen.findByTestId("current-user");
  await settle();
}

// ---------------------------------------------------------------------------
// (B) 上端のボタンの入れ替え(`D-V22-6`)
// ---------------------------------------------------------------------------

describe("(B) 上端のボタン", () => {
  test("(B-1) 宣言のあるアプリでは「アカウント」の代わりに「マイページ」が出て、押すとマイページが開く", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/note-list`);
    stub({ signedIn: true, manifest: manifestWith(FULL) });
    render(<App />);
    const button = await screen.findByTestId("open-my-page");
    expect(button.textContent).toBe("マイページ");
    expect(screen.queryByTestId("open-account")).toBeNull();
    fireEvent.click(button);
    await screen.findByTestId("my-page");
    expect(window.location.pathname).toBe(`/apps/${APP_ID}/my-page`);
  });

  test("(B-2) 宣言の無いアプリでは今日どおり「アカウント」だけで、「マイページ」の綴りは1つも出ない", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/note-list`);
    stub({ signedIn: true, manifest: manifestWith(undefined) });
    render(<App />);
    await screen.findByTestId("open-account");
    expect(screen.queryByTestId("open-my-page")).toBeNull();
    expect(screen.queryByTestId("view-list-my-page")).toBeNull();
    expect(document.body.textContent).not.toContain("マイページ");
  });

  test("(B-3) 空の宣言 {} でも置く(既定どおり)", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/note-list`);
    stub({ signedIn: true, manifest: manifestWith({}) });
    render(<App />);
    await screen.findByTestId("open-my-page");
    expect(screen.queryByTestId("open-account")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (N) メニューの先頭の項目(`D-V22-20`)
// ---------------------------------------------------------------------------

describe("(N) メニューの先頭", () => {
  test("(N-1) 左: 先頭の項目がマイページで、マイページを開いているときだけ aria-current が付く", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/note-list`);
    stub({ signedIn: true, manifest: manifestWith(FULL) });
    render(<App />);
    const nav = await screen.findByTestId("view-list");
    const first = nav.querySelector("li");
    expect(first?.getAttribute("data-testid")).toBe("view-list-my-page");
    expect(first?.querySelector("a")?.getAttribute("href")).toBe(`/apps/${APP_ID}/my-page`);
    expect(first?.textContent).toBe("マイページ");
    expect(first?.getAttribute("aria-current")).toBeNull();

    fireEvent.click(first?.querySelector("a") as HTMLAnchorElement);
    await screen.findByTestId("my-page");
    const current = [...screen.getByTestId("view-list").querySelectorAll("li")].filter(
      (row) => row.getAttribute("aria-current") === "page",
    );
    expect(current.map((row) => row.getAttribute("data-testid"))).toEqual(["view-list-my-page"]);
  });

  test("(N-2) 上: 横一列の先頭と「≡ メニュー」の先頭の両方にマイページ", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/my-page`);
    stub({ signedIn: true, manifest: manifestWith(FULL, { placement: "top" }) });
    render(<App />);
    const items = await screen.findByTestId("view-list-items");
    const first = items.querySelector("li");
    expect(first?.getAttribute("data-testid")).toBe("view-list-my-page");
    expect(first?.getAttribute("aria-current")).toBe("page");
    fireEvent.click(screen.getByTestId("view-menu-toggle"));
    await settle();
    const menu = document.querySelector('[data-slot="overlay-menu"]');
    expect(menu).not.toBeNull();
    const menuItems = [...(menu?.querySelectorAll('[role="menuitem"]') ?? [])];
    expect(menuItems[0]?.getAttribute("data-testid")).toBe("view-menu-my-page");
    expect(menuItems[0]?.getAttribute("aria-current")).toBe("page");
    expect(menuItems[0]?.textContent).toBe("マイページ");
  });

  test("(N-3) 上の「≡ メニュー」でマイページを選ぶとマイページへ移る", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/note-list`);
    stub({ signedIn: true, manifest: manifestWith(FULL, { placement: "top" }) });
    render(<App />);
    fireEvent.click(await screen.findByTestId("view-menu-toggle"));
    await settle();
    fireEvent.click(document.querySelector('[data-testid="view-menu-my-page"]') as HTMLElement);
    await screen.findByTestId("my-page");
    expect(window.location.pathname).toBe(`/apps/${APP_ID}/my-page`);
  });
});

// ---------------------------------------------------------------------------
// (A) アカウントの節(`D-V22-3` / `D-V22-6`)
// ---------------------------------------------------------------------------

describe("(A) アカウントの節", () => {
  test("(A-1) 名前・役割・ログインIDが出て、パスワード変更と退会がマイページの中にある", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/my-page`);
    stub({ signedIn: true, manifest: manifestWith(FULL) });
    render(<App />);
    const account = await screen.findByTestId("my-page-account");
    expect(within(account).getByTestId("my-page-display-name").textContent).toBe("花子");
    expect(within(account).getByTestId("my-page-login-id").textContent).toBe("hanako");
    expect(within(account).getByTestId("my-page-role").textContent).toBe(
      screen.getByTestId("current-role").textContent,
    );
    const page = screen.getByTestId("my-page");
    expect(within(page).getByTestId("account-panel")).toBeDefined();
    expect(within(page).getByTestId("account-change-password")).toBeDefined();
    expect(within(page).getByTestId("account-withdraw")).toBeDefined();
    // 閉じる先が無い(マイページそのものの一部)。
    expect(within(page).queryByTestId("close-account")).toBeNull();
  });

  test("(A-2) 名前(表示名)が無ければログインIDを名前に出す", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/my-page`);
    stub({ signedIn: true, manifest: manifestWith(FULL) });
    const original = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).split("?")[0] === `/api/apps/${APP_ID}/auth/me`) {
        return Promise.resolve(jsonResponse({ user: { ...USER, displayName: null } }));
      }
      return original(input, init);
    }) as typeof fetch;
    render(<App />);
    const account = await screen.findByTestId("my-page-account");
    expect(within(account).getByTestId("my-page-display-name").textContent).toBe("hanako");
  });
});

// ---------------------------------------------------------------------------
// (R) 自分の記録(`D-V22-5` / `D-V22-19` / `D-V22-24`)
// ---------------------------------------------------------------------------

describe("(R) 自分の記録", () => {
  test("(R-1) 表ごとに ?my_page=1&limit=10&sort=_created_at&order=desc で読み、10件と「もっと見る」を出す", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/my-page`);
    const { requested } = stub({ signedIn: true, manifest: manifestWith(FULL) });
    render(<App />);
    const section = await screen.findByTestId("my-page-table-notes");
    await waitFor(() => {
      expect(within(section).getAllByTestId("my-page-row").length).toBe(10);
    });
    const noteRequests = requested.filter((url) =>
      url.startsWith(`/api/apps/${APP_ID}/tables/notes/records?`),
    );
    expect(noteRequests.length).toBe(1);
    const query = new URLSearchParams(noteRequests[0]?.split("?")[1] ?? "");
    expect(query.get("my_page")).toBe("1");
    expect(query.get("limit")).toBe("10");
    expect(query.get("sort")).toBe("_created_at");
    expect(query.get("order")).toBe("desc");
    expect(query.get("view")).toBeNull();
    expect(within(section).getByTestId("my-page-more")).toBeDefined();
  });

  test("(R-2) 「もっと見る」で次の10件(offset=10)を足し、全部読んだら消える", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/my-page`);
    const { requested } = stub({ signedIn: true, manifest: manifestWith(FULL) });
    render(<App />);
    const section = await screen.findByTestId("my-page-table-notes");
    fireEvent.click(await within(section).findByTestId("my-page-more"));
    await waitFor(() => {
      expect(within(section).getAllByTestId("my-page-row").length).toBe(13);
    });
    const second = requested.filter((url) =>
      url.startsWith(`/api/apps/${APP_ID}/tables/notes/records?`),
    )[1];
    const query = new URLSearchParams(second?.split("?")[1] ?? "");
    expect(query.get("my_page")).toBe("1");
    expect(query.get("offset")).toBe("10");
    expect(query.get("limit")).toBe("10");
    expect(within(section).queryByTestId("my-page-more")).toBeNull();
  });

  test("(R-2b) 【V22-M3-T08a 軽-7】読んでいるあいだに新しい行が入っても、「もっと見る」で同じ行を2度並べない(_id で除く)", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/my-page`);
    stub({ signedIn: true, manifest: manifestWith(FULL), newRowsAfterFirst: 1 });
    render(<App />);
    const section = await screen.findByTestId("my-page-table-notes");
    await waitFor(() => {
      expect(within(section).getAllByTestId("my-page-row").length).toBe(10);
    });
    fireEvent.click(within(section).getByTestId("my-page-more"));
    // 2回目は offset=10 で n-9〜n-12 が返る(新しい行が1件入ったので n-9 は2度目)。 n-9 は1度だけ並ぶ。
    await waitFor(() => {
      expect(within(section).getAllByTestId("my-page-row").length).toBe(13);
    });
    const labels = within(section)
      .getAllByTestId("my-page-row")
      .map((row) => row.textContent);
    expect(new Set(labels).size).toBe(labels.length);
  });

  test("(R-3) 行を押すと、その表の詳細画面(開けるもののうち定義順の先頭)を開く", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/my-page`);
    stub({ signedIn: true, manifest: manifestWith(FULL) });
    render(<App />);
    const section = await screen.findByTestId("my-page-table-notes");
    const rows = await within(section).findAllByTestId("my-page-row");
    const link = rows[0]?.querySelector("a");
    expect(link?.getAttribute("href")).toBe(`/apps/${APP_ID}/views/note-detail/records/n-0`);
    expect(link?.textContent).toBe("メモ0");
  });

  test("(R-4) 開ける詳細画面が無い表の行は押せない", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/my-page`);
    stub({ signedIn: true, manifest: manifestWith(FULL) });
    render(<App />);
    const section = await screen.findByTestId("my-page-table-requests");
    const rows = await within(section).findAllByTestId("my-page-row");
    expect(rows.length).toBe(1);
    expect(rows[0]?.querySelector("a")).toBeNull();
    expect(rows[0]?.textContent).toBe("棚の修理");
  });

  test("(R-5) 詳細画面が在っても、その役割に開けなければ押せない", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/my-page`);
    const manifest = manifestWith(FULL);
    // member から note-detail の規則を外す。
    const member = (manifest.app as { roles?: { id: string; rules?: unknown[] }[] }).roles?.find(
      (role) => role.id === "member",
    );
    if (member !== undefined) {
      member.rules = (member.rules ?? []).filter(
        (rule) => (rule as { view?: string }).view !== "note-detail",
      );
    }
    stub({ signedIn: true, manifest });
    render(<App />);
    const section = await screen.findByTestId("my-page-table-notes");
    const rows = await within(section).findAllByTestId("my-page-row");
    expect(rows[0]?.querySelector("a")).toBeNull();
  });

  test("(R-6) 0件のときは、壊れていないことが分かる文を出す", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/my-page`);
    stub({ signedIn: true, manifest: manifestWith(FULL), noteCount: 0 });
    render(<App />);
    const section = await screen.findByTestId("my-page-table-notes");
    const empty = await within(section).findByTestId("my-page-records-empty");
    expect(empty.textContent).toContain("壊れているわけではありません");
    expect(within(section).queryByTestId("my-page-more")).toBeNull();
  });

  test("(R-7) 一覧画面を1つも開けない表(secrets)と外した表(drafts)は節を出さず、読みにも行かない", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/my-page`);
    const { requested } = stub({ signedIn: true, manifest: manifestWith(FULL) });
    render(<App />);
    await screen.findByTestId("my-page-table-notes");
    await settle();
    expect(screen.queryByTestId("my-page-table-secrets")).toBeNull();
    expect(screen.queryByTestId("my-page-table-drafts")).toBeNull();
    expect(requested.some((url) => url.includes("/tables/secrets/records?"))).toBe(false);
    expect(requested.some((url) => url.includes("/tables/drafts/records?"))).toBe(false);
    // 節の並びは表の定義順。
    const sections = [...screen.getByTestId("my-page").querySelectorAll("[data-my-page-table]")];
    expect(sections.map((node) => node.getAttribute("data-my-page-table"))).toEqual([
      "notes",
      "requests",
    ]);
  });

  test("(R-8) 運営者(owner)には secrets の一覧が開けるので、その節も出る", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/my-page`);
    stub({ signedIn: true, manifest: manifestWith(FULL), role: "owner" });
    render(<App />);
    await screen.findByTestId("my-page-table-secrets");
  });

  /** `requests` の持ち主の列 `assignee` を、運営者(owner)にだけ見せる(member からは丸ごと隠れる)。 */
  function ownerOnlyAssignee(): Manifest {
    return grantRules(
      manifestWith(FULL),
      ["owner"],
      [{ target: "field", table: "requests", field: "assignee", can: ["read"] }],
    );
  }

  test("(R-9) 【V22-M3-T08a 中-2】持ち主の列がその役割から丸ごと隠れる表は、節ごと出さず、読みにも行かず、エラー枠も出さない", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/my-page`);
    const { requested } = stub({ signedIn: true, manifest: ownerOnlyAssignee() });
    render(<App />);
    await screen.findByTestId("my-page-table-notes");
    await settle();
    expect(screen.queryByTestId("my-page-table-requests")).toBeNull();
    expect(screen.queryByTestId("my-page-records-error")).toBeNull();
    expect(requested.some((url) => url.includes("/tables/requests/records?"))).toBe(false);
  });

  test("(R-10) 【V22-M3-T08a 中-2 の陰性対照】持ち主の列を見せている役割(owner)には、その節が出る", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/my-page`);
    stub({ signedIn: true, manifest: ownerOnlyAssignee(), role: "owner" });
    render(<App />);
    await screen.findByTestId("my-page-table-requests");
  });
});

// ---------------------------------------------------------------------------
// (V) 選んだ画面(`D-V22-18`)
// ---------------------------------------------------------------------------

describe("(V) 選んだ画面", () => {
  test("(V-1) 開ける画面だけを開くボタンとして並べ、押すとその画面へ移る", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/my-page`);
    stub({ signedIn: true, manifest: manifestWith(FULL) });
    render(<App />);
    const views = await screen.findByTestId("my-page-views");
    const buttons = within(views).getAllByTestId("my-page-open-view");
    // **画面を指す DOM 属性は製品に置かない**(`web/test/preset-boundary.test.ts` の (iv))ので、文言で見る。
    expect(buttons.map((button) => button.textContent)).toEqual(["メモを書く"]);
    expect(buttons[0]?.tagName).toBe("BUTTON");
    expect(buttons[0]?.textContent).toBe("メモを書く");
    expect(views.textContent).not.toContain("スタッフ用");
    fireEvent.click(buttons[0] as HTMLElement);
    await waitFor(() => {
      expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/note-form`);
    });
  });

  test("(V-2) 運営者には両方が並ぶ(定義の並び)", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/my-page`);
    stub({ signedIn: true, manifest: manifestWith(FULL), role: "owner" });
    render(<App />);
    const views = await screen.findByTestId("my-page-views");
    expect(
      within(views)
        .getAllByTestId("my-page-open-view")
        .map((button) => button.textContent),
    ).toEqual(["メモを書く", "スタッフ用"]);
  });

  test("(V-3) views を書かなければ、選んだ画面の節は出ない", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/my-page`);
    stub({ signedIn: true, manifest: manifestWith({}) });
    render(<App />);
    await screen.findByTestId("my-page");
    expect(screen.queryByTestId("my-page-views")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (L) ログイン直後に開く(`open_after_login`。`D-V22-25`)
// ---------------------------------------------------------------------------

describe("(L) ログイン直後に開く", () => {
  test("(L-1) 画面を指さずに入り(/apps/<id>)ログインすると、マイページが開く", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}`);
    stub({ signedIn: false, manifest: manifestWith(FULL) });
    render(<App />);
    await logIn();
    await waitFor(() => {
      expect(window.location.pathname).toBe(`/apps/${APP_ID}/my-page`);
    });
    await screen.findByTestId("my-page");
  });

  test("(L-2) ログイン画面の場所(/apps/<id>/login)からログインしても、マイページが開く", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/login`);
    stub({ signedIn: false, manifest: manifestWith(FULL) });
    render(<App />);
    await logIn();
    await waitFor(() => {
      expect(window.location.pathname).toBe(`/apps/${APP_ID}/my-page`);
    });
  });

  test("(L-3) open_after_login を書かなければ、ログインしても移らない", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/login`);
    stub({ signedIn: false, manifest: manifestWith({ views: ["note-form"] }) });
    render(<App />);
    await logIn();
    expect(window.location.pathname).toBe(`/apps/${APP_ID}/login`);
    expect(screen.queryByTestId("my-page")).toBeNull();
  });

  test("(L-4) 画面を指して入った(/views/<id>)ときは、その画面が優先する", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/note-list`);
    stub({ signedIn: false, manifest: manifestWith(FULL) });
    render(<App />);
    await logIn();
    expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/note-list`);
    expect(screen.queryByTestId("my-page")).toBeNull();
  });

  test("(L-5) 公開の画面を指して開き、そこからログインしたときは、マイページへ移らない", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/pub-list`);
    stub({
      signedIn: false,
      manifest: manifestWith(FULL),
      publicViews: [
        {
          id: "pub-list",
          name: "公開の一覧",
          type: "list_view",
          table: "notes",
          columns: ["title"],
          tables: [
            {
              id: "notes",
              name: "メモ",
              fields: [{ id: "title", name: "題", type: "text", required: true }],
            },
          ],
        },
      ],
    });
    render(<App />);
    fireEvent.click(await screen.findByTestId("anonymous-login-link"));
    await logIn();
    expect(window.location.pathname).toBe(`/apps/${APP_ID}/login`);
    expect(screen.queryByTestId("my-page")).toBeNull();
  });

  test("(L-6) 既にセッションが在る状態で /apps/<id> を開いても、移らない(ログインの直後ではない)", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}`);
    stub({ signedIn: true, manifest: manifestWith(FULL) });
    render(<App />);
    await screen.findByTestId("current-user");
    await settle();
    expect(window.location.pathname).toBe(`/apps/${APP_ID}`);
  });

  test("(L-7) ログインの直後に一度開いた後、自分で別の画面へ移っても引き戻さない", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}`);
    stub({ signedIn: false, manifest: manifestWith(FULL) });
    render(<App />);
    await logIn();
    await screen.findByTestId("my-page");
    const link = [...screen.getByTestId("view-list").querySelectorAll("a")].find(
      (anchor) => anchor.getAttribute("href") === `/apps/${APP_ID}/views/note-list`,
    );
    fireEvent.click(link as HTMLAnchorElement);
    await settle();
    expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/note-list`);
  });
});

// ---------------------------------------------------------------------------
// (S) 登録直後の自動オープンが先(`D-V22-25`。調停は1か所)
// ---------------------------------------------------------------------------

/** `signup-auto-open.test.tsx` の題材と同じ形(未ログインでも定義が読める古い経路)。 */
function signupManifest(forms: 0 | 1 | 2): Manifest {
  const built: Manifest = {
    app: {
      id: APP_ID,
      name: "お店",
      tables: [
        {
          id: "member",
          name: "会員",
          fields: [
            { id: "display_name", name: "表示名", type: "text", required: true },
            { id: "st_owner", name: "所有者", type: "text" },
          ],
        },
        { id: "notice", name: "お知らせ", fields: [{ id: "body", name: "本文", type: "text" }] },
      ],
      views: [
        {
          id: "notice-list",
          name: "お知らせ一覧",
          type: "list_view",
          table: "notice",
          columns: ["body"],
        },
      ],
      workspace: { my_page: { open_after_login: true } },
    },
  };
  const rules = [viewRead("notice-list")];
  for (let index = 0; index < forms; index += 1) {
    const id = index === 0 ? "member-form" : `member-form-${index + 1}`;
    built.app.views.push({
      id,
      name: `会員情報の登録${index + 1}`,
      type: "form",
      table: "member",
      fields: ["display_name"],
    });
    rules.push(viewRead(id));
  }
  return grantRules(built, ["customer"], rules);
}

function signupStub(manifest: Manifest): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = String(input).split("?")[0] ?? "";
    if (path === `/api/apps/${APP_ID}/auth/me`) {
      return Promise.resolve(
        jsonResponse({ errors: [{ path: "", message: "認証されていません。" }] }, 401),
      );
    }
    if (path === `/api/apps/${APP_ID}/manifest`) {
      return Promise.resolve(jsonResponse(manifest));
    }
    if (path === `/api/apps/${APP_ID}/auth/signup/password/register`) {
      return Promise.resolve(
        jsonResponse({ user: { id: "u-1", username: "kaimono", role: "customer" } }),
      );
    }
    if (path.startsWith(`/api/apps/${APP_ID}/tables/`)) {
      return Promise.resolve(jsonResponse({ records: [], total: 0 }));
    }
    return Promise.resolve(jsonResponse({ errors: [{ path: "", message: "no stub" }] }, 404));
  }) as typeof fetch;
}

async function signUp(): Promise<void> {
  await screen.findByTestId("customer-password-register");
  fireEvent.change(screen.getByTestId("auth-username"), { target: { value: "kaimono" } });
  fireEvent.change(screen.getByTestId("auth-password"), { target: { value: "pw" } });
  fireEvent.click(screen.getByTestId("customer-password-register"));
  await screen.findByTestId("current-user");
  await settle();
}

describe("(S) 登録直後の自動オープンとの調停", () => {
  test("(S-1) 登録直後の行き先がちょうど1本なら、その入力画面が開き、マイページへは移らない", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}`);
    signupStub(signupManifest(1));
    render(<App />);
    await signUp();
    await waitFor(() => {
      expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/member-form`);
    });
    await settle();
    expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/member-form`);
  });

  test("(S-2) 行き先が2本(自動では開かない)なら、マイページが開く", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}`);
    signupStub(signupManifest(2));
    render(<App />);
    await signUp();
    await waitFor(() => {
      expect(window.location.pathname).toBe(`/apps/${APP_ID}/my-page`);
    });
  });

  test("(S-3) 行き先が0本なら、マイページが開く", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}`);
    signupStub(signupManifest(0));
    render(<App />);
    await signUp();
    await waitFor(() => {
      expect(window.location.pathname).toBe(`/apps/${APP_ID}/my-page`);
    });
  });
});

// ---------------------------------------------------------------------------
// (U) 未ログインには出さない
// ---------------------------------------------------------------------------

describe("(U) 未ログイン", () => {
  test("(U-1) 未ログインで /my-page を開くとログイン画面で、マイページは描かない", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/my-page`);
    stub({ signedIn: false, manifest: manifestWith(FULL) });
    render(<App />);
    await screen.findByTestId("login-page");
    expect(screen.queryByTestId("my-page")).toBeNull();
  });

  test("(U-2) 公開の入口画面を持つアプリでも、/my-page はログイン画面になる", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/my-page`);
    stub({
      signedIn: false,
      manifest: manifestWith(FULL),
      publicViews: [
        {
          id: "pub-list",
          name: "公開の一覧",
          type: "list_view",
          table: "notes",
          columns: ["title"],
          tables: [
            {
              id: "notes",
              name: "メモ",
              fields: [{ id: "title", name: "題", type: "text", required: true }],
            },
          ],
        },
      ],
    });
    render(<App />);
    await screen.findByTestId("login-page");
    expect(screen.queryByTestId("anonymous-workspace")).toBeNull();
    expect(screen.queryByTestId("my-page")).toBeNull();
  });

  test("(U-3) /my-page でログインすると、そのままマイページが描かれる", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/my-page`);
    stub({ signedIn: false, manifest: manifestWith({ views: ["note-form"] }) });
    render(<App />);
    await logIn();
    await screen.findByTestId("my-page");
  });

  test("(U-4) 宣言の無いアプリで /my-page を開くと、黙って空にせず「無い」と出す", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/my-page`);
    stub({ signedIn: true, manifest: manifestWith(undefined) });
    render(<App />);
    const note = await screen.findByTestId("my-page-missing");
    expect(note.textContent).toContain("マイページがありません");
    expect(screen.queryByTestId("my-page")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (D) 配る版も同じ
// ---------------------------------------------------------------------------

describe("(D) 配る版", () => {
  test("(D-1) ボタンの入れ替えとメニューの先頭、マイページの3節", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/my-page`);
    stub({ signedIn: true, manifest: manifestWith(FULL) });
    render(<RunnerShell appId={APP_ID} />);
    const page = await screen.findByTestId("my-page");
    expect(screen.getByTestId("open-my-page").textContent).toBe("マイページ");
    expect(screen.queryByTestId("open-account")).toBeNull();
    const first = screen.getByTestId("view-list").querySelector("li");
    expect(first?.getAttribute("data-testid")).toBe("view-list-my-page");
    expect(first?.getAttribute("aria-current")).toBe("page");
    expect(within(page).getByTestId("my-page-account")).toBeDefined();
    expect(within(page).getByTestId("account-change-password")).toBeDefined();
    await within(page).findByTestId("my-page-table-notes");
    expect(within(page).getByTestId("my-page-views")).toBeDefined();
  });

  test("(D-2) 宣言の無いアプリでは今日どおり「アカウント」", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/note-list`);
    stub({ signedIn: true, manifest: manifestWith(undefined) });
    render(<RunnerShell appId={APP_ID} />);
    await screen.findByTestId("open-account");
    expect(screen.queryByTestId("open-my-page")).toBeNull();
    expect(document.body.textContent).not.toContain("マイページ");
  });

  test("(D-3) ログイン直後に開く", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}`);
    stub({ signedIn: false, manifest: manifestWith(FULL) });
    render(<RunnerShell appId={APP_ID} />);
    await logIn();
    await waitFor(() => {
      expect(window.location.pathname).toBe(`/apps/${APP_ID}/my-page`);
    });
    await screen.findByTestId("my-page");
  });

  test("(D-4) ログアウトして、画面を指さずにもう一度ログインすると、また開く", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}`);
    stub({ signedIn: false, manifest: manifestWith(FULL) });
    render(<RunnerShell appId={APP_ID} />);
    await logIn();
    await screen.findByTestId("my-page");
    fireEvent.click(screen.getByTestId("logout"));
    await screen.findByTestId("login-page");
    act(() => {
      navigate({ kind: "app", appId: APP_ID });
    });
    await logIn();
    await waitFor(() => {
      expect(window.location.pathname).toBe(`/apps/${APP_ID}/my-page`);
    });
  });

  test("(D-5) 未ログインで /my-page はログイン画面", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/my-page`);
    stub({ signedIn: false, manifest: manifestWith(FULL) });
    render(<RunnerShell appId={APP_ID} />);
    await screen.findByTestId("login-page");
    expect(screen.queryByTestId("my-page")).toBeNull();
  });

  test("(D-6) 画面を指して入ったときは、その画面が優先する", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/note-list`);
    stub({ signedIn: false, manifest: manifestWith(FULL) });
    render(<RunnerShell appId={APP_ID} />);
    await logIn();
    expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/note-list`);
  });
});

// ---------------------------------------------------------------------------
// (H) 「最新に更新」(`V22-M4-T03` / `ADR-0494` §Decision 3 / ユーザ決定 `D-V22-31`・メインの裁定 `D-V22-37`)
// ---------------------------------------------------------------------------

/** `notes` の自分の行の読みを、検査が好きな順で答えられる差し替え(他は `stub` と同じ形で即答)。 */
type HeldRead = { readonly url: string; readonly answer: (response: Response) => void };

function heldStub(): {
  held: HeldRead[];
  rows: { _id: string; title: string; st_owner: string }[];
} {
  const held: HeldRead[] = [];
  const rows = noteRows(0, 13);
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    const path = url.split("?")[0] ?? url;
    if (path === `/api/apps/${APP_ID}/auth/me`) {
      return Promise.resolve(jsonResponse({ user: USER }));
    }
    if (path === `/api/apps/${APP_ID}/manifest`) {
      return Promise.resolve(jsonResponse(manifestWith(FULL)));
    }
    if (path === `/api/apps/${APP_ID}/tables/notes/records`) {
      return new Promise<Response>((resolve) => {
        held.push({ url, answer: resolve });
      });
    }
    if (path.startsWith(`/api/apps/${APP_ID}/tables/`)) {
      return Promise.resolve(jsonResponse({ records: [], total: 0 }));
    }
    return Promise.resolve(jsonResponse({ errors: [{ path: "", message: "no stub" }] }, 404));
  }) as typeof fetch;
  return { held, rows };
}

/** 押さえた読みに、その時点の行で答える(`offset` と `limit` はその読みの URL から取る)。 */
async function answerHeld(
  read: HeldRead | undefined,
  rows: readonly { _id: string; title: string; st_owner: string }[],
): Promise<void> {
  const query = new URLSearchParams(read?.url.split("?")[1] ?? "");
  const offset = Number(query.get("offset") ?? "0");
  const limit = Number(query.get("limit") ?? "10");
  await act(async () => {
    read?.answer(jsonResponse({ records: rows.slice(offset, offset + limit), total: rows.length }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

function rowTitles(section: HTMLElement): string[] {
  return within(section)
    .queryAllByTestId("my-page-row")
    .map((row) => row.textContent ?? "");
}

describe("(H) 最新に更新", () => {
  test("(H-1) 表ごとの節に「最新に更新」が常に1つ出る(読み込み中・読めた後・0件の表のどれでも)", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/my-page`);
    const { held, rows } = heldStub();
    render(<App />);
    const notes = await screen.findByTestId("my-page-table-notes");
    // 初回読込の間も出ている(押せない)。
    expect(within(notes).getAllByTestId("my-page-refresh")).toHaveLength(1);
    await answerHeld(held[0], rows);
    await waitFor(() => expect(rowTitles(notes)).toHaveLength(10));
    expect(within(notes).getAllByTestId("my-page-refresh")).toHaveLength(1);
    // 0件の表(requests はこの差し替えでは0件)にも1つ。
    const requests = await screen.findByTestId("my-page-table-requests");
    await within(requests).findByTestId("my-page-records-empty");
    expect(within(requests).getAllByTestId("my-page-refresh")).toHaveLength(1);
    expect(within(notes).getByTestId("my-page-refresh").textContent).toBe("最新に更新");
  });

  test("(H-2) 読んだ後にサーバへ新しい行が入り、押すと先頭に出る(10件・重複なし・先頭から読み直す)", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/my-page`);
    const { held, rows } = heldStub();
    render(<App />);
    const notes = await screen.findByTestId("my-page-table-notes");
    await answerHeld(held[0], rows);
    await waitFor(() => expect(rowTitles(notes)).toHaveLength(10));
    const fresh = [{ _id: "new-0", title: "新しいメモ", st_owner: USER.id }, ...rows];
    fireEvent.click(within(notes).getByTestId("my-page-refresh"));
    expect(held).toHaveLength(2);
    const query = new URLSearchParams(held[1]?.url.split("?")[1] ?? "");
    expect({
      my_page: query.get("my_page"),
      limit: query.get("limit"),
      offset: query.get("offset"),
      sort: query.get("sort"),
      order: query.get("order"),
    }).toEqual({ my_page: "1", limit: "10", offset: null, sort: "_created_at", order: "desc" });
    await answerHeld(held[1], fresh);
    await waitFor(() => expect(rowTitles(notes)[0]).toBe("新しいメモ"));
    const titles = rowTitles(notes);
    expect(titles).toHaveLength(10);
    expect(new Set(titles).size).toBe(10);
    // 続きはサーバから受け取った行の数(10)から読む。
    fireEvent.click(within(notes).getByTestId("my-page-more"));
    const next = new URLSearchParams(held[2]?.url.split("?")[1] ?? "");
    expect(next.get("offset")).toBe("10");
  });

  test("(H-3) 初回読込の間だけ押せない", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/my-page`);
    const { held, rows } = heldStub();
    render(<App />);
    const notes = await screen.findByTestId("my-page-table-notes");
    const button = within(notes).getByTestId("my-page-refresh") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await answerHeld(held[0], rows);
    await waitFor(() => expect(rowTitles(notes)).toHaveLength(10));
    expect((within(notes).getByTestId("my-page-refresh") as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  test("(H-4) 「もっと見る」の続き読みの間も押せ、押すと続き読みの古い応答は捨てられる", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/my-page`);
    const { held, rows } = heldStub();
    render(<App />);
    const notes = await screen.findByTestId("my-page-table-notes");
    await answerHeld(held[0], rows);
    await waitFor(() => expect(rowTitles(notes)).toHaveLength(10));
    fireEvent.click(within(notes).getByTestId("my-page-more"));
    expect(held).toHaveLength(2);
    const refresh = within(notes).getByTestId("my-page-refresh") as HTMLButtonElement;
    expect(refresh.disabled).toBe(false);
    fireEvent.click(refresh);
    expect(held).toHaveLength(3);
    const fresh = [{ _id: "new-0", title: "新しいメモ", st_owner: USER.id }, ...rows];
    // 続き読みの応答(古い)を後から返しても、並びに足さない。
    await answerHeld(held[2], fresh);
    await waitFor(() => expect(rowTitles(notes)[0]).toBe("新しいメモ"));
    await answerHeld(held[1], rows);
    const titles = rowTitles(notes);
    expect(titles).toHaveLength(10);
    expect(titles[0]).toBe("新しいメモ");
    expect(new Set(titles).size).toBe(10);
  });

  test("(H-4b) 続き読みの応答が読み直しより先に返っても捨てられる", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/my-page`);
    const { held, rows } = heldStub();
    render(<App />);
    const notes = await screen.findByTestId("my-page-table-notes");
    await answerHeld(held[0], rows);
    await waitFor(() => expect(rowTitles(notes)).toHaveLength(10));
    fireEvent.click(within(notes).getByTestId("my-page-more"));
    fireEvent.click(within(notes).getByTestId("my-page-refresh"));
    await answerHeld(held[1], rows);
    expect(rowTitles(notes)).toHaveLength(10);
    const fresh = [{ _id: "new-0", title: "新しいメモ", st_owner: USER.id }, ...rows];
    await answerHeld(held[2], fresh);
    await waitFor(() => expect(rowTitles(notes)[0]).toBe("新しいメモ"));
    expect(rowTitles(notes)).toHaveLength(10);
  });

  test("(H-5) エラーのときは押せ、押すと読み直して回復する", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/my-page`);
    const { held, rows } = heldStub();
    render(<App />);
    const notes = await screen.findByTestId("my-page-table-notes");
    await act(async () => {
      held[0]?.answer(
        jsonResponse({ errors: [{ path: "", message: "一時的に読めません。" }] }, 500),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await within(notes).findByTestId("my-page-records-error");
    const refresh = within(notes).getByTestId("my-page-refresh") as HTMLButtonElement;
    expect(refresh.disabled).toBe(false);
    fireEvent.click(refresh);
    await answerHeld(held[1], rows);
    await waitFor(() => expect(rowTitles(notes)).toHaveLength(10));
    expect(within(notes).queryByTestId("my-page-records-error")).toBeNull();
  });

  test("(H-6) 新着の知らせを出さない(読み直す前にサーバの行が増えても、何も出ない)", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/my-page`);
    const { held, rows } = heldStub();
    render(<App />);
    const notes = await screen.findByTestId("my-page-table-notes");
    await answerHeld(held[0], rows);
    await waitFor(() => expect(rowTitles(notes)).toHaveLength(10));
    await settle();
    // 読み直しを押さない限り、サーバへ読みに行かない(知らせのための読みも無い)。
    expect(held).toHaveLength(1);
    expect(notes.querySelectorAll('[data-testid*="new"], [data-testid*="notice"]')).toHaveLength(0);
    expect(notes.textContent).not.toContain("新着");
  });

  test("(H-7) 配る版でも同じボタンが出て、押すと読み直す", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/my-page`);
    const { held, rows } = heldStub();
    render(<RunnerShell appId={APP_ID} />);
    const notes = await screen.findByTestId("my-page-table-notes");
    await answerHeld(held[0], rows);
    await waitFor(() => expect(rowTitles(notes)).toHaveLength(10));
    fireEvent.click(within(notes).getByTestId("my-page-refresh"));
    const fresh = [{ _id: "new-0", title: "新しいメモ", st_owner: USER.id }, ...rows];
    await answerHeld(held[1], fresh);
    await waitFor(() => expect(rowTitles(notes)[0]).toBe("新しいメモ"));
  });
});
