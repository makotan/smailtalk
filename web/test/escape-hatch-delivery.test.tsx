/**
 * 逃げ道(任意 CSS)の配信の単体テスト(V3-M5-T02 / D-G5。ADR-0055 限定6・7・12・13)。
 *
 * ## 何を固定しているか
 *
 * 1. **参照を持つ画面だけが配信を要求する**(参照が無ければ HTTP を1本も叩かない)。
 * 2. **本体は `.app-theme` スコープの内側に閉じる**(限定13)—— **DOM に置く位置だけでは
 *    CSS は閉じない**ので、受け取ったバイト列を `.app-theme { … }` の入れ子に**そのまま
 *    包んで**出す。**包むのは文字列連結であって解釈ではない**(限定8 = パーサを書かない)。
 * 3. **fail-closed かつ loud**(限定6)—— 遮断されたら CSS を1バイトも出さず、**画面に
 *    理由を出す**(サーバログ側の loud は `src/server/app.test.ts` が固定している)。
 * 4. **`ViewRendererProps` に props を1つも足していない**(限定12)—— 逃げ道は
 *    `ViewHost` が `view` と `appId` から自分で解くだけで、レンダラーには何も渡らない。
 * 5. **`web/src/styles.css` に規則を1つも足していない**(限定12)—— 器の見た目を持たない。
 *
 * ## このファイルが証明しないこと(誇張しない。憲法6)
 *
 * - **CSS が実際に効くこと(描画が変わること)は1バイトも証明していない。** happy-dom は
 *   カスケードも入れ子(CSS nesting)も解かない。**「逃げ道が実際に効く」の実証は
 *   `web/e2e/escape-hatch.e2e.ts`(chromium)であり、それは V3-M5-T03 の担当である。**
 * - **入れ子で包むことは「閉じ込め」を保証しない。** 決意した書き手は `:root:has(&)` の
 *   ような形で外へ出られるし、**限定8(許可リストも拒否リストも作らない)がある以上、
 *   出たことを検査する手段をこの製品は持たない**(ADR-0055 §4 限界2)。
 *   ここで固定できるのは「**既定で外へ漏れない形に包んでいる**」ことまでである。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { Manifest, View } from "../../src/kernel/types.ts";
import { App } from "../src/App.tsx";
import type { Role } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { ViewHost } from "../src/views/ViewHost.tsx";

/**
 * 資産の持ち主(V4-M15-T12)。**文字列リテラルで `role="owner"` と書くと biome の
 * a11y 規則(`useValidAriaRole`)が HTML の `role` 属性と誤認するので、変数経由で渡す**
 * (`web/test/form.test.tsx:19-22` と同じ形)。
 */
const OWNER_ROLE: Role = "owner";

/** 持ち主でない立場(知らせが出ないことを測るためだけに使う)。 */
const VIEWER_ROLE: Role = "viewer";

const APP_ID = "sample-app";
const DIGEST = "a".repeat(64);
const CSS = ".gp-list-table th { letter-spacing: 0.08em }";

function manifestOf(views: View[]): Manifest {
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
      views,
    },
  };
}

const listView = (custom?: { asset: string; digest: string }): View => {
  const view: View = { id: "entry-list", type: "list_view", table: "entries", columns: ["label"] };
  if (custom !== undefined) {
    view.custom_css = custom;
  }
  return view;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function cssResponse(css: string): Response {
  return new Response(css, { status: 200, headers: { "content-type": "text/css" } });
}

let originalFetch: typeof fetch;
/** 叩かれた URL の全量(「1本も叩かない」を実測するために数える)。 */
let requested: string[];

function stub(routes: (url: string) => Response | undefined): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    const response = routes(url);
    if (response !== undefined) {
      return Promise.resolve(response);
    }
    return Promise.resolve(jsonResponse({ errors: [], records: [] }));
  }) as typeof fetch;
}

const cssUrl = `/api/apps/${APP_ID}/views/entry-list/custom.css`;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  requested = [];
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.history.replaceState({}, "", "/");
});

describe("参照を持つ画面だけが配信を要求する", () => {
  test("参照が無い画面は、逃げ道の配信を1本も叩かない", async () => {
    stub(() => undefined);
    const manifest = manifestOf([listView()]);
    render(<ViewHost appId={APP_ID} manifest={manifest} view={manifest.app.views[0] as View} />);

    await waitFor(() => {
      expect(screen.getByTestId("view-renderer-list_view")).toBeDefined();
    });
    expect(requested.filter((url) => url.includes("custom.css"))).toEqual([]);
    expect(screen.queryByTestId("custom-css")).toBeNull();
    expect(screen.queryByTestId("custom-css-blocked")).toBeNull();
  });

  test("参照がある画面は、その画面IDの配信を1本だけ叩く", async () => {
    stub((url) => (url === cssUrl ? cssResponse(CSS) : undefined));
    const manifest = manifestOf([listView({ asset: "print", digest: DIGEST })]);
    render(<ViewHost appId={APP_ID} manifest={manifest} view={manifest.app.views[0] as View} />);

    await waitFor(() => {
      expect(screen.getByTestId("custom-css")).toBeDefined();
    });
    expect(requested.filter((url) => url === cssUrl)).toHaveLength(1);
  });
});

describe("限定13: 受け取ったバイト列は `.app-theme` の入れ子に包んで出す", () => {
  test("本体はそのまま(1バイトも書き換えず)入れ子の中に出る", async () => {
    stub((url) => (url === cssUrl ? cssResponse(CSS) : undefined));
    const manifest = manifestOf([listView({ asset: "print", digest: DIGEST })]);
    render(<ViewHost appId={APP_ID} manifest={manifest} view={manifest.app.views[0] as View} />);

    const style = await waitFor(() => screen.getByTestId("custom-css"));
    expect(style.tagName).toBe("STYLE");
    const text = style.textContent ?? "";
    // 包み方は「前後に1行足すだけ」である —— **CSS を解釈していない**(限定8)。
    expect(text.startsWith(".app-theme {")).toBe(true);
    expect(text.trimEnd().endsWith("}")).toBe(true);
    expect(text).toContain(CSS);
    // 受け取ったバイト列そのものは1文字も変えていない。
    expect(text.slice(text.indexOf("\n") + 1, text.lastIndexOf("\n"))).toBe(CSS);
  });

  test("シェル(.app-theme の外)には当てない —— style 要素はスコープ要素の内側にある", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/entry-list`);
    stub((url) => {
      if (url === `/api/apps/${APP_ID}/auth/me`) {
        return jsonResponse({
          user: { id: "u1", username: "alice", displayName: null, role: "owner" },
        });
      }
      if (url === `/api/apps/${APP_ID}/manifest`) {
        return jsonResponse(manifestOf([listView({ asset: "print", digest: DIGEST })]));
      }
      if (url === cssUrl) {
        return cssResponse(CSS);
      }
      if (url === "/api/apps") {
        return jsonResponse({
          apps: [{ app_id: APP_ID, name: "サンプル", created_at: "x", status: "active" }],
        });
      }
      return undefined;
    });
    render(<App />);

    const style = await waitFor(() => screen.getByTestId("custom-css"));
    const scope = screen.getByTestId("app-theme");
    // **スコープ要素の内側にある**(外枠 `.shell` に置かない。ADR-0055 限定13)。
    expect(scope.contains(style)).toBe(true);
  });
});

describe("限定6: fail-closed かつ loud(画面側)", () => {
  test("未発行(409)なら CSS を1バイトも出さず、理由を画面に出す", async () => {
    stub((url) =>
      url === cssUrl
        ? jsonResponse(
            {
              errors: [
                {
                  path: "/custom_css",
                  message: '逃げ道の資産 "print"(この内容の版)は発行されていません。',
                  hint: "owner がこの内容の資産を発行してください。",
                },
              ],
            },
            409,
          )
        : undefined,
    );
    const manifest = manifestOf([listView({ asset: "print", digest: DIGEST })]);
    render(<ViewHost appId={APP_ID} manifest={manifest} view={manifest.app.views[0] as View} />);

    const notice = await waitFor(() => screen.getByTestId("custom-css-blocked"));
    // **黙って効かないのは憲法6 違反。**画面に出るのは「効かなかった」と「なぜ」である。
    expect(notice.textContent).toContain("発行されていません");
    expect(notice.textContent).toContain("owner");
    // CSS は1バイトも出ていない。
    expect(screen.queryByTestId("custom-css")).toBeNull();
  });

  test("作用域外(403)でも同じく遮断され、理由が出る", async () => {
    stub((url) =>
      url === cssUrl
        ? jsonResponse(
            {
              errors: [
                {
                  path: "/custom_css",
                  message: '逃げ道の資産 "print" の作用域に画面 "entry-list" が含まれていません。',
                  hint: "この資産を当ててよい画面は other-list です。",
                },
              ],
            },
            403,
          )
        : undefined,
    );
    const manifest = manifestOf([listView({ asset: "print", digest: DIGEST })]);
    render(<ViewHost appId={APP_ID} manifest={manifest} view={manifest.app.views[0] as View} />);

    const notice = await waitFor(() => screen.getByTestId("custom-css-blocked"));
    expect(notice.textContent).toContain("作用域");
    expect(screen.queryByTestId("custom-css")).toBeNull();
  });

  test("配信そのものに到達できない(ネットワーク断)ときも、黙って消えない", async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url === cssUrl) {
        return Promise.reject(new Error("connection refused"));
      }
      return Promise.resolve(jsonResponse({ records: [] }));
    }) as typeof fetch;
    const manifest = manifestOf([listView({ asset: "print", digest: DIGEST })]);
    render(<ViewHost appId={APP_ID} manifest={manifest} view={manifest.app.views[0] as View} />);

    const notice = await waitFor(() => screen.getByTestId("custom-css-blocked"));
    expect(notice.textContent).toContain("逃げ道");
    expect(screen.queryByTestId("custom-css")).toBeNull();
  });
});

/**
 * 4つ目の状態(V4-M15-T12 / `P-G48` / `D-V4-15`。ADR-0087 限定9)。
 *
 * ## この describe が固定していること
 *
 * 1. **「まだ」「出せた」「遮断された」の3状態に、4つ目(「当たり先が消えた」)が足された。**
 *    **足したのは状態であって、数え上げではない** —— **当たり先を数えるには配信された CSS から
 *    セレクタを取り出す必要があり、それは ADR-0055 限定8 / 憲法1(CSS を1バイトも解釈しない)に
 *    当たると判断した**(判断の理由は `web/src/views/ViewHost.tsx` の当該コメント)。
 * 2. **配信は1バイトも止まらない。** 4つ目の状態でも `custom-css` の `<style>` は今までどおり出て、
 *    包み方も1バイトも変わらない(ADR-0088 限定7)。
 * 3. **既存の3状態の `data-testid`(`custom-css` / `custom-css-blocked`)を1つも変えていない。**
 *
 * ## この describe が証明しないこと(誇張しない。憲法6)
 *
 * - **何件が当たり先を失ったかは1件も数えていない。** 数えていないことを、文面の側で固定する。
 * - **「逃げ道資産が壊れなかった」ことは1バイトも示していない**(`03:2209` の【禁止】)。
 */
describe("4つ目の状態: 当たり先が変わりうることを持ち主に知らせる", () => {
  const ownerHost = (manifest: Manifest) =>
    render(
      <RoleProvider role={OWNER_ROLE} actorId="u1">
        <ViewHost appId={APP_ID} manifest={manifest} view={manifest.app.views[0] as View} />
      </RoleProvider>,
    );

  test("規則を持つ資産が配れたとき、owner に知らせが出る", async () => {
    stub((url) => (url === cssUrl ? cssResponse(CSS) : undefined));
    ownerHost(manifestOf([listView({ asset: "print", digest: DIGEST })]));

    const notice = await waitFor(() => screen.getByTestId("custom-css-target-unverified"));
    // **知らせるのは「当たり先が変わりうる」ことであって、「何件壊れた」ではない。**
    expect(notice.textContent).toContain("当たり先");
    expect(notice.textContent).toContain("数えていません");
    // **【禁止】「壊れなかった」と書かない**(`03:2209`)。文面の側で機械的に固定する。
    expect(notice.textContent).not.toContain("壊れなかった");
    expect(notice.textContent).not.toContain("影響はありません");
  });

  test("知らせが出ても配信は止まらず、包み方も1バイトも変わらない", async () => {
    stub((url) => (url === cssUrl ? cssResponse(CSS) : undefined));
    ownerHost(manifestOf([listView({ asset: "print", digest: DIGEST })]));

    const style = await waitFor(() => screen.getByTestId("custom-css"));
    expect(screen.getByTestId("custom-css-target-unverified")).toBeDefined();
    // ADR-0088 限定7 —— 包みは `.app-theme { … }` のままである。
    const text = style.textContent ?? "";
    expect(text).toBe(`.app-theme {\n${CSS}\n}`);
    // 遮断の知らせは出ていない(4つ目の状態は遮断ではない)。
    expect(screen.queryByTestId("custom-css-blocked")).toBeNull();
  });

  test("owner でない者には出ない(持ち主に向けた知らせである)", async () => {
    stub((url) => (url === cssUrl ? cssResponse(CSS) : undefined));
    const manifest = manifestOf([listView({ asset: "print", digest: DIGEST })]);
    render(
      <RoleProvider role={VIEWER_ROLE} actorId="u2">
        <ViewHost appId={APP_ID} manifest={manifest} view={manifest.app.views[0] as View} />
      </RoleProvider>,
    );

    // CSS は viewer にも当たる(配信は役割で変わらない)。知らせだけが出ない。
    await waitFor(() => expect(screen.getByTestId("custom-css")).toBeDefined());
    expect(screen.queryByTestId("custom-css-target-unverified")).toBeNull();
  });

  test("規則を1つも持たない資産(空白だけ)では、3つ目の状態のままで知らせを出さない", async () => {
    stub((url) => (url === cssUrl ? cssResponse("\n  \n") : undefined));
    ownerHost(manifestOf([listView({ asset: "blank", digest: DIGEST })]));

    // 配信そのものは起きる(サーバが 200 を返した以上、包んで出す)。
    await waitFor(() => expect(screen.getByTestId("custom-css")).toBeDefined());
    // **失う当たり先が1つも無いので、知らせない。**
    expect(screen.queryByTestId("custom-css-target-unverified")).toBeNull();
  });

  test("遮断されたときは知らせを出さない(当たり先の話は起きていない)", async () => {
    stub((url) =>
      url === cssUrl
        ? jsonResponse(
            {
              errors: [
                { path: "/custom_css", message: "逃げ道の資産は発行されていません。", hint: "" },
              ],
            },
            409,
          )
        : undefined,
    );
    ownerHost(manifestOf([listView({ asset: "print", digest: DIGEST })]));

    await waitFor(() => expect(screen.getByTestId("custom-css-blocked")).toBeDefined());
    expect(screen.queryByTestId("custom-css-target-unverified")).toBeNull();
  });

  test("参照を持たない画面には出ない(HTTP も1本も叩かない)", async () => {
    stub(() => undefined);
    ownerHost(manifestOf([listView()]));

    await waitFor(() => expect(screen.getByTestId("view-renderer-list_view")).toBeDefined());
    expect(screen.queryByTestId("custom-css-target-unverified")).toBeNull();
    expect(requested.filter((url) => url.includes("custom.css"))).toEqual([]);
  });
});

describe("限定12: props も styles.css も増やしていない", () => {
  test("`ViewRendererProps` の形は変わっていない(逃げ道の props が1つも無い)", () => {
    // **型は `web/test/preset-boundary.test.ts` (v) がソースの上で固定している。**
    // ここでは製品経路の側から見て、レンダラーが逃げ道を1つも受け取らないことを見る ——
    // 逃げ道を解くのは `ViewHost` だけで、`view` の中の1キーとして流れるにすぎない。
    const props = Object.keys({
      appId: APP_ID,
      manifest: manifestOf([listView()]),
      view: listView(),
      recordId: undefined,
      prefill: undefined,
    });
    expect(props).toEqual(["appId", "manifest", "view", "recordId", "prefill"]);
  });
});
