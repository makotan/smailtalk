/**
 * 共通ヘッダのアプリ切替(V3-M3-T01 / F-11')のコンポーネントテスト。
 *
 * 完了条件の正は `docs/plan/v3/records/v3-m3.md` §2 の「V3-M3-T01」節(7点)、
 * 判定の正は `docs/plan/v3/records/v3-m3-gate-a-shell.md` §2(門外 Δ7 / 将来送り / 送り先 T01)。
 * 置き場の決定は **ユーザ決定 D-M3-5(共通ヘッダに常設)**である。
 *
 * ## 何を固定しているか
 *
 * 1. **切替 UI が共通ヘッダに常設される**(T01-1)—— アプリ一覧・アプリ画面・ビュー画面・
 *    未知のパスの4経路すべてに出る。**アプリ内ヘッダだけ・認証済みだけ、にしない。**
 * 2. **切替先は `GET /api/apps` の結果から決まり、`/apps/<app_id>` を指す**(T01-1)——
 *    シェルにアプリ名を1つも書かない(CP-3 確認方法4 と同じ規律)。
 * 3. **切替先で未認証なら、そのアプリのログイン画面が出る**(T01-3)—— 「押せるのに
 *    入れない」導線ではない。**per-app 認証(ADR-0014 改訂)であることを画面で説明する。**
 * 4. **未認証の画面に全アプリ名が載る**(T01-4)—— **これは「漏れない」ことの検査ではなく、
 *    露出が広がったことを固定する検査である。**`GET /api/apps` は認証なしで
 *    `app_id` / `name` / `created_at` / `status` を返す(`src/server/app.ts:1295` /
 *    `src/kernel/meta-store.ts:301`)。**常設によって、それが常に画面の DOM に載るようになった。**
 * 5. **D-G6(シェルの見た目・組織テンプレートの指名)への参照を1つも持たない**(T01-5)——
 *    `web/src/App.tsx` のソースを読み、テンプレート機構・テーマ・プリセット・マニフェストの
 *    語が1つも現れないことを機械的に見る。**D-G6 は保留のままであり(D-M3-7)、本タスクは
 *    その判定を待たずに成立する。**
 *
 * ## このファイルが証明しないこと(誇張しない)
 *
 * - **「画面で切り替わる」ことは証明していない。** happy-dom は CSS を解かず、
 *   `<details>` の開閉も UA スタイルとして解決しない。**実際にブラウザで切り替わることの
 *   実証は `web/e2e/app-switcher.e2e.ts`(chromium)である。**
 * - **切替先で「入れる」ことは証明していない。** ここで確かめるのは「未認証ならログイン画面が
 *   出る」までで、ログインが通ることは認証系のテスト(`web/e2e/auth.e2e.ts`)の担当である。
 * - **アプリが何件になっても使えるかは見ていない。** 一覧はアプリ数に比例して伸びる
 *   (審査記録 §2 S3-4 が不利な材料として挙げたもの)。件数の上限も折り返しも実装していない。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Manifest } from "../../src/kernel/types.ts";
import { App } from "../src/App.tsx";

/** 認証済みで開けるアプリ。 */
const OPEN_APP = "sample-app";
/** **そのアプリのセッションを持たない**アプリ(切替先で 401 に落ちる側)。 */
const LOCKED_APP = "other-app";

const APPS_RESPONSE = {
  apps: [
    { app_id: OPEN_APP, name: "サンプル", created_at: "2026-01-01T00:00:00Z", status: "active" },
    {
      app_id: LOCKED_APP,
      name: "べつのやつ",
      created_at: "2026-01-02T00:00:00Z",
      status: "active",
    },
  ],
};

function manifestOf(appId: string, name: string): Manifest {
  return {
    app: {
      id: appId,
      name,
      tables: [
        {
          id: "entries",
          name: "エントリ",
          fields: [{ id: "label", name: "ラベル", type: "text", required: true }],
        },
      ],
      views: [{ id: "entry-list", type: "list_view", table: "entries", columns: ["label"] }],
    },
  };
}

let originalFetch: typeof fetch;
/** `/api/apps` を落としたい試験だけが立てる旗(T01 の「取得できないとき」)。 */
let appsFail: boolean;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  appsFail = false;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/apps") {
      return appsFail
        ? jsonResponse({ errors: [{ path: "", message: "台帳を読めませんでした。" }] }, 500)
        : jsonResponse(APPS_RESPONSE);
    }
    // per-app 認証(ADR-0014 改訂)。**開いている側だけ**セッションがある。
    if (url === `/api/apps/${OPEN_APP}/auth/me`) {
      return jsonResponse({ user: { id: "u1", username: "tester", displayName: null } });
    }
    if (url === `/api/apps/${LOCKED_APP}/auth/me`) {
      return jsonResponse({ errors: [{ path: "", message: "認証されていません。" }] }, 401);
    }
    if (url === `/api/apps/${OPEN_APP}/manifest`) {
      return jsonResponse(manifestOf(OPEN_APP, "サンプル"));
    }
    if (url === `/api/apps/${LOCKED_APP}/manifest`) {
      return jsonResponse(manifestOf(LOCKED_APP, "べつのやつ"));
    }
    return jsonResponse({ errors: [{ path: "", message: `no stub for ${url}` }] }, 404);
  }) as typeof fetch;
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

/** 切替 UI の中だけを見る(アプリ一覧の同名リンクと取り違えないため)。 */
async function switcher(): Promise<HTMLElement> {
  return await screen.findByTestId("app-switcher");
}

describe("T01-1 共通ヘッダに常設される(D-M3-5)", () => {
  const routes = [
    ["アプリ一覧", "/"],
    ["アプリの画面", `/apps/${OPEN_APP}`],
    ["ビューの画面", `/apps/${OPEN_APP}/views/entry-list`],
    ["未知のパス", "/no-such-path"],
  ] as const;

  for (const [label, path] of routes) {
    test(`${label}(${path})でも切替 UI が出る`, async () => {
      window.history.replaceState({}, "", path);
      render(<App />);
      expect(await switcher()).toBeDefined();
    });
  }

  test("切替 UI は共通ヘッダ(.shell > header)の中にある", async () => {
    render(<App />);
    const header = (await switcher()).closest("header");
    expect(header).not.toBeNull();
    // **【V4-M15-T01 / T18 で書き換えた1行】** 着手前は `toBe("shell")` だった。
    // `D-V4-59` の器の系統の当たり先として `group/ui` が同じ要素に付いたので、
    // 完全一致では赤くなる。**見ているもの(切替 UI が `.shell > header` の中にあること)は
    // 1バイトも変えていない** —— `.shell` の実在を `classList` で確かめる形に改めた。
    expect(header?.parentElement?.classList.contains("shell")).toBe(true);
    // **器の系統の属性は同じ要素に付く**(判定が2箇所に住まない)。
    expect(header?.parentElement?.getAttribute("data-ui-family")).toBe("comfortable");
  });
});

describe("T01-1 GET /api/apps の結果から /apps/<app_id> へ遷移する", () => {
  test("台帳の全アプリが切替先として並び、href が /apps/<app_id> を指す", async () => {
    render(<App />);
    const scope = within(await switcher());
    for (const app of APPS_RESPONSE.apps) {
      const link = await scope.findByRole("link", { name: app.name });
      expect(link.getAttribute("href")).toBe(`/apps/${app.app_id}`);
    }
  });

  test("今開いているアプリには印が付く(自分への切替であることが読める)", async () => {
    window.history.replaceState({}, "", `/apps/${OPEN_APP}`);
    render(<App />);
    const scope = within(await switcher());
    const current = (await scope.findByRole("link", { name: "サンプル" })).closest("li");
    expect(current?.getAttribute("data-current")).toBe("true");
    const other = scope.getByRole("link", { name: "べつのやつ" }).closest("li");
    expect(other?.getAttribute("data-current")).toBeNull();
  });

  test("切替リンクを押すと URL がそのアプリになる", async () => {
    window.history.replaceState({}, "", `/apps/${OPEN_APP}/views/entry-list`);
    render(<App />);
    const scope = within(await switcher());
    fireEvent.click(await scope.findByRole("link", { name: "べつのやつ" }));
    await waitFor(() => {
      expect(window.location.pathname).toBe(`/apps/${LOCKED_APP}`);
    });
  });
});

describe("T01-3 切替先で未認証のときの振る舞い", () => {
  test("説明が画面に出ている(per-app 認証であることを黙って隠さない)", async () => {
    render(<App />);
    const note = within(await switcher()).getByTestId("app-switcher-note");
    expect(note.textContent).toContain("アプリごと");
    expect(note.textContent).toContain("ログイン");
  });

  test("セッションの無いアプリへ切り替えると、そのアプリのログイン画面が出る", async () => {
    window.history.replaceState({}, "", `/apps/${OPEN_APP}`);
    render(<App />);
    // まず開いている側のワークスペースが出ていること(切替の前後を比べるため)。
    await screen.findByTestId("view-list");

    const scope = within(await switcher());
    fireEvent.click(scope.getByRole("link", { name: "べつのやつ" }));

    // **押せるのに入れない、にはしない** —— 401 を握り潰さず、そのアプリの
    // ログイン画面(per-app)へ落ちる。
    const login = await screen.findByTestId("login-page");
    expect(login.textContent).toContain("べつのやつ");
    expect(screen.queryByTestId("view-list")).toBeNull();
  });

  test("未認証の画面でも切替 UI は消えない(常設)", async () => {
    window.history.replaceState({}, "", `/apps/${LOCKED_APP}`);
    render(<App />);
    await screen.findByTestId("login-page");
    expect(await switcher()).toBeDefined();
  });
});

describe("T01-4 未認証で見える範囲(「漏れない」ことの検査ではない)", () => {
  test("未認証の画面の DOM に、台帳の全アプリ名が載る", async () => {
    window.history.replaceState({}, "", `/apps/${LOCKED_APP}`);
    render(<App />);
    await screen.findByTestId("login-page");

    // **常設の代償そのものを固定する。** ここが緑であることは「安全」を意味しない ——
    // 未認証の利用者が、台帳にあるアプリ名を全部見られる状態であることの記録である。
    const scope = within(await switcher());
    for (const app of APPS_RESPONSE.apps) {
      expect(scope.getByRole("link", { name: app.name })).toBeDefined();
    }
  });
});

describe("台帳を読めないとき(黙って空にしない)", () => {
  test("GET /api/apps が失敗しても本文は描画され、失敗が画面に出る", async () => {
    appsFail = true;
    window.history.replaceState({}, "", `/apps/${OPEN_APP}`);
    render(<App />);

    // 本文(ワークスペース)は切替 UI の失敗に巻き込まれない。
    await screen.findByTestId("view-list");
    const scope = within(await switcher());
    await waitFor(() => {
      expect(scope.getByTestId("app-switcher-error").textContent).toContain(
        "台帳を読めませんでした",
      );
    });
  });
});

describe("T01-5 D-G6 との独立性(シェルの見た目に依存しない)", () => {
  /**
   * **ソースの字面を見る検査である。** `web/src/App.tsx` が
   * テンプレート機構・テーマ・画面プリセット・マニフェストのいずれにも触れていないことを、
   * 実装の形として固定する。**D-G6 は保留のままであり(D-M3-7)、その判定が
   * どちらに転んでも本タスクの実装は動かない。**
   *
   * 併せて、`App.tsx` 冒頭の仕様宣言(「アプリ固有の知識をひとつも持たない」)が
   * 実装と食い違っていないことも見る —— 切替 UI が出すのは実行時に台帳から来る
   * アプリ**一覧**であって、アプリ**固有の知識**ではない。
   */
  const APP_TSX = readFileSync(join(dirname(import.meta.dir), "src", "App.tsx"), "utf-8");

  const FORBIDDEN = [
    "template",
    "テンプレート",
    "theme",
    "Theme",
    "preset",
    "manifest",
    "Manifest",
  ];

  for (const word of FORBIDDEN) {
    test(`App.tsx に "${word}" が1度も現れない`, () => {
      expect(APP_TSX).not.toContain(word);
    });
  }

  test("シェルはアプリ名を1つもソースに持たない(実行時に台帳から来る)", () => {
    expect(APP_TSX).not.toContain(OPEN_APP);
    expect(APP_TSX).not.toContain("サンプル");
  });

  test("冒頭の仕様宣言が残っている(ログイン導線をシェルに持たない)", () => {
    expect(APP_TSX).toContain("アプリ固有の知識をひとつも持たない");
    expect(APP_TSX).toContain("共通ヘッダにログイン/ログアウト導線も持たない");
  });
});
