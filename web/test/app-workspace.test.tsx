/**
 * AppWorkspace の per-app 認証ゲートのテスト(V1-M3-T01 / ADR-0014 改訂 = per-app)。
 *
 * 認証はアプリ単位で、ゲートは各アプリの作業画面に閉じている。検証点:
 *   1. **anonymous**(そのアプリの me が 401)→ そのアプリのログイン画面を出す
 *      (アプリ名見出し付き。manifest は非保護なので取得できる)
 *   2. **authenticated**(me 200)→ ビュー一覧を描画し、ユーザ名 + ログアウトを出す
 *   3. **records 401(セッション失効)**→ authenticated からログイン画面へ落ちる
 *
 * app-list(/)は認証不要なので、ここではアプリを直接開いた URL から検証する。
 * fetch は url ルーティング型スタブ。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { Manifest } from "../../src/kernel/types.ts";
import { App } from "../src/App.tsx";
import { ADMIN_ROLES, grantRules, viewRead } from "./role-rules.ts";

const APP_ID = "sample-app";

function sampleManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "サンプル",
      tables: [
        {
          id: "entries",
          name: "エントリ",
          fields: [{ id: "label", name: "ラベル", type: "text", required: true }],
        },
      ],
      views: [
        {
          id: "entry-list",
          name: "エントリ一覧",
          type: "list_view",
          table: "entries",
          columns: ["label"],
        },
      ],
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let originalFetch: typeof fetch;

/** url → Response のルーティング型スタブ。未登録は 404。 */
function stub(routes: (url: string) => Response | undefined): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    const response = routes(url.split("?")[0] ?? url);
    return Promise.resolve(
      response ?? jsonResponse({ errors: [{ path: "", message: `no stub for ${url}` }] }, 404),
    );
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

describe("anonymous(そのアプリに未ログイン)", () => {
  test("me 401 なら、そのアプリのログイン画面(アプリ名見出し付き)を出す", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}`);
    stub((url) => {
      if (url === `/api/apps/${APP_ID}/auth/me`) {
        return jsonResponse({ errors: [{ path: "", message: "認証されていません。" }] }, 401);
      }
      if (url === `/api/apps/${APP_ID}/manifest`) {
        return jsonResponse(sampleManifest());
      }
      return undefined;
    });
    render(<App />);

    const loginPage = await screen.findByTestId("login-page");
    // manifest からアプリ名が取れるので、見出しに出る。
    expect(loginPage.textContent).toContain("サンプルにログイン");
    // ワークスペース本体(ビュー一覧)は出ない。
    expect(screen.queryByTestId("view-list")).toBeNull();
  });
});

describe("authenticated(そのアプリにログイン済み)", () => {
  test("me 200 ならビュー一覧・ユーザ名・ログアウトを出す", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}`);
    stub((url) => {
      if (url === `/api/apps/${APP_ID}/auth/me`) {
        return jsonResponse({
          user: { id: "u1", username: "alice", displayName: null, role: "owner" },
        });
      }
      if (url === `/api/apps/${APP_ID}/manifest`) {
        return jsonResponse(sampleManifest());
      }
      return undefined;
    });
    render(<App />);

    await waitFor(() => expect(screen.getByTestId("view-list")).toBeDefined());
    expect(screen.getByTestId("current-user").textContent).toBe("alice");
    expect(screen.getByTestId("logout")).toBeDefined();
    expect(screen.queryByTestId("login-page")).toBeNull();
  });

  /**
   * V3-M3-T04(D-G12b)の非破壊性。**画面一覧はロールで絞られるようになったが、
   * customer 以外では1件も減らない。** このアプリのテーブルは `st_owner` も `st_public` も
   * 持たない(= customer から見れば denied)ので、customer で絞れば0件になる ——
   * その差がそのまま「絞りが効いているが、既存ロールには当たらない」ことの証拠である。
   * 出し分けの本体は `web/test/role-visibility.test.tsx` が持つ。
   */
  test("ビュー一覧はロールで減らない(owner / editor / viewer とも1件)", async () => {
    // **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65`。旧の題材を逐語で残す】**
    // **旧の題材(逐語)**: `sampleManifest()`(= **`app.roles` を1本も持たない**)。
    // **旧はそれで owner / editor / viewer とも1件だった** —— **面の既定が
    // 「規則を1本も書いていない対象は管轄外(全許可)」だったからである。**
    //
    // **今日は既定が「閉じる」側へ倒れたので、規則の無い画面は3ロールとも0件になる。**
    // **本テストが測る問い(3つの運営ロールのあいだで画面一覧が減らない)は1ミリも
    // 変えていない** —— **その問いが成り立つ題材、すなわち3ロールとも同じ画面を名指しした
    // 題材にした。** **足すのは画面 × 読取の1本だけで、表・項目・ボタンの規則は1本も
    // 足していない。**
    //
    // **【誇張しない】これは「向きが変わっていない」ことの証拠ではない。**
    // **規則を1本も書かない題材では、今日この3ロールとも0件である**
    // (その実測は下の「セッション失効」の2本目が持つ)。
    const declared = grantRules(sampleManifest(), ADMIN_ROLES, [viewRead("entry-list")]);
    for (const role of ["owner", "editor", "viewer"] as const) {
      window.history.replaceState({}, "", `/apps/${APP_ID}`);
      stub((url) => {
        if (url === `/api/apps/${APP_ID}/auth/me`) {
          return jsonResponse({ user: { id: "u1", username: "alice", displayName: null, role } });
        }
        if (url === `/api/apps/${APP_ID}/manifest`) {
          return jsonResponse(declared);
        }
        return undefined;
      });
      const view = render(<App />);
      await waitFor(() => expect(screen.getByTestId("view-list")).toBeDefined());
      expect(screen.getByTestId("view-list").querySelectorAll("li").length).toBe(1);
      view.unmount();
    }
  });
});

describe("セッション失効(records 401)", () => {
  /** 失効を起こすスタブ(マニフェストだけ差し替えられる)。 */
  function stubExpiry(manifest: Manifest): void {
    stub((url) => {
      if (url === `/api/apps/${APP_ID}/auth/me`) {
        return jsonResponse({
          user: { id: "u1", username: "alice", displayName: null, role: "owner" },
        });
      }
      if (url === `/api/apps/${APP_ID}/manifest`) {
        return jsonResponse(manifest);
      }
      if (url === `/api/apps/${APP_ID}/tables/entries/records`) {
        // 保護 API がセッション失効の 401 を返す。
        return jsonResponse({ errors: [{ path: "", message: "認証されていません。" }] }, 401);
      }
      return undefined;
    });
  }

  test("authenticated から records 401 でログイン画面へ落ちる", async () => {
    // **【`V8-M20` / 台帳 `J-G27`(判定 = 廃止)/ 手続きは `ADR-0301` で題材を差し替えた。
    // 旧の逐語を1バイトも消していない】**
    // **旧の題材**: `sampleManifest()`(役割の規則を1本も持たない)。
    // **旧のコメント(逐語)**: 「records の 401 が per-app 失効ハンドラを発火 → anonymous →
    // ログイン画面へ。」
    //
    // **今日**: **`view.audience` の閉じる向きの既定(`ADR-0074` 限定7)が撤去され、
    // 未ログインの可視集合も面(`app.roles[].rules`)で決まる。** **規則を1本も書いて
    // いない画面は未ログインに開くので、規則の無い題材ではログイン画面に落ちない。**
    // **本テストが測る問い(失効したら authenticated から落ちる)は1ミリも変えていない** ——
    // **落ちた先がログイン画面であることを見るために、画面を運営が名指しする題材にした。**
    const closed = sampleManifest();
    closed.app.roles = [
      { id: "owner", rules: [{ target: "view", view: "entry-list", can: ["read"] }] },
    ];
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/entry-list`);
    stubExpiry(closed);
    render(<App />);

    // records の 401 が per-app 失効ハンドラを発火 → anonymous → ログイン画面へ。
    await waitFor(() => expect(screen.getByTestId("login-page")).toBeDefined());
  });

  test("【`V8-M26` で向きがもう一度変わった】規則の無い画面では、失効後にログイン画面へ落ちる", async () => {
    // **【`V8-M20` / `J-G27` が足した1本。誇張しない】**
    // **旧は同じ題材(規則を1本も持たないアプリ)でログイン画面に落ちていた。**
    // **今日は落ちない** —— **面の既定は「規則を1本も書いていない対象は管轄外(全許可)」で
    // あり、未ログインもその画面を開けるからである。**
    // **【禁止の履行】これを「同じ挙動を保った」と書かない。**
    // **【誇張しない】ログイン済みの状態は落ちている** —— **ログアウト等の導線が消え、
    // ログインへの導線が出る。** **行が返るかどうかは別の話で、匿名に返るのは今日も
    // `st_public` が真の行だけである。**
    //
    // ## 【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65`。台帳 `T-G26a`。
    //    上の段落は今日から偽である。1バイトも消していない】
    //
    // **既定がもう一度反転した** —— **`src/server/owner-scope.ts` の `judgeRoleAccess` は
    // 規則を1本も名指ししていない画面を今日「閉じる」側で返し、その向きは未ログイン
    // (`anonymous`)にも同じだけ及ぶ**(台帳 `T-G26a`)。**したがって規則を1本も持たない
    // この題材でも、失効した先の未ログインはその画面を開けず、ログイン画面へ落ちる。**
    //
    // **【期待値を反転させた。旧の期待値を逐語で残す】**
    // ```
    // await waitFor(() => expect(screen.getByTestId("anonymous-login-link")).toBeDefined());
    // expect(screen.queryByTestId("login-page")).toBeNull();
    // for (const id of ["logout", "open-account", "current-role"]) {
    //   expect(screen.queryByTestId(id), id).toBeNull();
    // }
    // ```
    // **旧のテスト名(逐語)**: 「**【向きが変わった】規則の無い画面では、失効後に未ログインの
    // ままその画面が残る**」。
    //
    // **【誇張しない】これは `V8-M20` 以前の姿に戻った、ではない。** **旧は画面ごとの
    // 宣言(`view.audience`)の閉じる向きの既定が止めていたのに対し、今日止めているのは
    // 役割の規則の側の既定である** —— **見た目の結果が一致しただけで、止めている層は別である。**
    // **本テストが測る問い(失効したら authenticated から落ちる)は1ミリも変えていない。**
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/entry-list`);
    stubExpiry(sampleManifest());
    render(<App />);

    await waitFor(() => expect(screen.getByTestId("login-page")).toBeDefined());
    // **ログイン済みの導線は1つも残らない**(この3つが `null` であることは反転前後で同じ)。
    for (const id of ["logout", "open-account", "current-role"]) {
      expect(screen.queryByTestId(id), id).toBeNull();
    }
  });
});

/**
 * **画面一覧を左カラムに置く**(`V4-M2-T03` / 単位 `B-G4`。**門外 Δ7・条件付き**)。
 *
 * 台帳(`docs/adr/0007-vocabulary-governance.md` §8)が `B-G4` について逐語で書いた
 * 完了条件6点のうち、(1)(4)(5) をここで機械的に固定する。(2)(3) は
 * `web/test/styles.test.ts` の `@` 検査と `web/test/theme-slot-parity.test.ts` の
 * `toHaveLength(28)` が既に持っており、**本ファイルでは重複させない**。
 *
 * **jsdom はレイアウトを計算しない。** したがって「左に出る」ことそのものは測れない。
 * ここが測るのは**左カラムになるための必要条件**である:
 *
 * 1. **`nav.view-list` が `.workspace-body` の先頭の要素の子である**(横並びの器の中で
 *    文書順が先頭 = 左端)。
 * 2. **残り(`nav.workspace-links` と選択中の画面)が `.workspace-main` に入る**。
 * 3. **`.workspace-body` が横並びの器である**(`display: flex` + 折り返し)。
 *    **`flex-direction` を `row-reverse` / `column` に倒していない** —— 倒すと文書順が
 *    先頭でも左端にならない。
 * 4. **`.shell` に当たる規則を1つも足していない**(台帳 (4) / `D-V4-5` / `D-V4-24`)。
 *
 * **実ブラウザでの見え方は本ファイルの射程外である**(`V4-M2-T04` が chromium で踏む)。
 */
describe("画面一覧を左カラムに置く(V4-M2-T03 / B-G4)", () => {
  test("nav.view-list は .workspace-body の先頭の子で、残りは .workspace-main に入る", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}`);
    stub((url) => {
      if (url === `/api/apps/${APP_ID}/auth/me`) {
        return jsonResponse({
          user: { id: "u1", username: "alice", displayName: null, role: "owner" },
        });
      }
      if (url === `/api/apps/${APP_ID}/manifest`) {
        return jsonResponse(sampleManifest());
      }
      return undefined;
    });
    render(<App />);

    const list = await screen.findByTestId("view-list");
    const body = list.parentElement;
    expect(body).not.toBeNull();
    expect(body?.className).toBe("workspace-body");
    // 先頭の要素の子 = 横並びの器の左端。
    expect(body?.firstElementChild).toBe(list);
    // 2番目が本文の器で、通常導線はその中にある。
    const main = screen.getByTestId("workspace-main");
    expect(body?.children[1]).toBe(main);
    expect(main.contains(screen.getByTestId("workspace-links"))).toBe(true);
    // 画面一覧は本文の器の中に**入っていない**(入ると左カラムにならない)。
    expect(main.contains(list)).toBe(false);
  });

  test(".workspace-body が横並びの器であり、.shell に当たる規則を足していない", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const css = readFileSync(join(dirname(import.meta.dir), "src", "styles.css"), "utf-8");

    // `.workspace-body` の宣言ブロックを取り出す(コメントは除く)。
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const block = withoutComments.match(/\.workspace-body\s*\{([^}]*)\}/);
    expect(block).not.toBeNull();
    const declarations = (block?.[1] ?? "").replace(/\s+/g, " ");
    expect(declarations).toContain("display: flex");
    // **折り返しで幅に追随する**(`@media` を1つも書かないための手段。台帳 (2))。
    expect(declarations).toContain("flex-wrap: wrap");
    // **文書順の先頭が左端であること**を壊す向きに倒していない。
    expect(declarations).not.toContain("row-reverse");
    expect(declarations).not.toContain("flex-direction: column");

    // `.view-list` を左カラムとして扱う規則が実在する(台帳 (1) の機械判定)。
    expect(withoutComments).toContain(".workspace-body > .view-list");

    // **`.shell` に当たるセレクタ**(台帳 (4)。**`B-G4` は1本も足していない**)。
    //
    // **【V4-M15-T07 で期待値を書き換えた。2本 → 4本】**
    // 増えた2本は**幅の条件の中の `.shell` だけ**である(`ADR-0089` / `D-V4-44`)——
    // `@media (min-width: 40rem)` と `@media (min-width: 64rem)` の中で `padding` を
    // 段階的に広げている。**新しいセレクタは1つも作っておらず、当たり先は `.shell` のままである。**
    const shellSelectors = [...withoutComments.matchAll(/([^{}]*\.shell[^{}]*)\{/g)].map((m) =>
      m[1]?.trim(),
    );
    expect(shellSelectors).toEqual([".shell", ".shell header", ".shell", ".shell"]);
    // **`.workspace-body` 側には幅の条件を1つも掛けていない**(台帳 (1) の器は幅で変わらない)。
    for (const block of withoutComments.matchAll(/@media[^{]*\{([\s\S]*?\})\s*\}/g)) {
      expect((block[1] ?? "").includes(".workspace-body")).toBe(false);
    }
  });
});
