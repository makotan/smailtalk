/**
 * URL ↔ 画面状態の対応(V0-P3-T03)。
 *
 * ここが可逆であることが「ブラウザのリロードで同じ画面に戻れる」の土台になる
 * (V0-P3-T07 の前提)。アプリID・ビューID は URL のパスパラメータであり、
 * アプリ固有の名前はコードのどこにも現れない。
 */
import { describe, expect, test } from "bun:test";
import { parseRoute, type Route, routePath } from "./route.ts";

describe("parseRoute", () => {
  test("ルートはアプリ一覧", () => {
    expect(parseRoute("/")).toEqual({ kind: "app-list" });
  });

  test("/apps/<app_id> はアプリのビュー一覧", () => {
    expect(parseRoute("/apps/sample-app")).toEqual({ kind: "app", appId: "sample-app" });
  });

  test("/apps/<app_id>/views/<view_id> は個別ビュー", () => {
    expect(parseRoute("/apps/sample-app/views/entry-list")).toEqual({
      kind: "view",
      appId: "sample-app",
      viewId: "entry-list",
    });
  });

  test("/apps/<app_id>/views/<view_id>/records/<record_id> は対象レコード付きのビュー", () => {
    expect(parseRoute("/apps/sample-app/views/entry-detail/records/entry-0001")).toEqual({
      kind: "view",
      appId: "sample-app",
      viewId: "entry-detail",
      recordId: "entry-0001",
    });
  });

  test("レコードID の無いビューには recordId が付かない", () => {
    const route = parseRoute("/apps/sample-app/views/entry-list");
    expect(route.kind === "view" ? route.recordId : "そもそもビューではない").toBeUndefined();
  });

  test("末尾スラッシュがあっても同じ画面に解決する", () => {
    expect(parseRoute("/apps/sample-app/")).toEqual({ kind: "app", appId: "sample-app" });
    expect(parseRoute("/apps/sample-app/views/entry-detail/records/entry-0001/")).toEqual({
      kind: "view",
      appId: "sample-app",
      viewId: "entry-detail",
      recordId: "entry-0001",
    });
  });

  test("知らないパスは not-found(黙ってアプリ一覧に化けない)", () => {
    expect(parseRoute("/nope/deeper")).toEqual({ kind: "not-found", path: "/nope/deeper" });
  });

  test("records の下が空、またはさらに深いパスは not-found", () => {
    expect(parseRoute("/apps/sample-app/views/entry-detail/records").kind).toBe("not-found");
    expect(parseRoute("/apps/sample-app/views/entry-detail/records/a/b").kind).toBe("not-found");
  });

  test("records を名乗らない4階層目は not-found(黙ってビューに化けない)", () => {
    expect(parseRoute("/apps/sample-app/views/entry-detail/nope/entry-0001").kind).toBe(
      "not-found",
    );
  });
});

describe("routePath", () => {
  test("parseRoute と往復できる", () => {
    for (const path of [
      "/",
      "/apps/sample-app",
      "/apps/sample-app/views/entry-form",
      "/apps/sample-app/views/entry-detail/records/entry-0001",
    ]) {
      expect(routePath(parseRoute(path))).toBe(path);
    }
  });

  test("recordId を持つビューの URL にレコードID が載る", () => {
    expect(
      routePath({
        kind: "view",
        appId: "sample-app",
        viewId: "entry-detail",
        recordId: "entry-0001",
      }),
    ).toBe("/apps/sample-app/views/entry-detail/records/entry-0001");
  });

  test("recordId が undefined ならレコードの階層を付けない", () => {
    expect(
      routePath({
        kind: "view",
        appId: "sample-app",
        viewId: "entry-list",
        recordId: undefined,
      }),
    ).toBe("/apps/sample-app/views/entry-list");
  });

  test("prefill(EC-G14 / ADR-0045)はパスに現れない —— 6セグメントを増やさず、クエリ文字列に載る", () => {
    /*
     * **【V5-M24-T01 / L-G17 で書き換えたテストである】**
     * 着手前のテスト名は「prefill(EC-G14 / ADR-0045)は URL に現れない —— 一時状態であり
     * 6セグメントを増やさない」だった(`src/shared/route.test.ts:102-113`)。
     * **前段(「URL に現れない」)は偽になった。後段(「6セグメントを増やさない」)は今日も真である。**
     * プリフィルはパスではなく**クエリ文字列**に載る(`V5-M20` の判定。`v5-m20.md` §2-5)。
     */
    expect(
      routePath({
        kind: "view",
        appId: "sample-app",
        viewId: "cart-form",
        prefill: { field: "product", value: "prod-1" },
      }),
    ).toBe("/apps/sample-app/views/cart-form?prefill.product=prod-1");
  });

  test("prefill を持たないビューの URL にクエリ文字列は1文字も付かない(MCP の応答を変えないための条件)", () => {
    // `get_preview_url` / `create_app` の `preview_url` はここを通る。prefill を持たない
    // `Route` に対する出力が着手前と1バイトも違うと、MCP の応答が変わる(L-G18)。
    expect(routePath({ kind: "app-list" })).toBe("/");
    expect(routePath({ kind: "app", appId: "sample-app" })).toBe("/apps/sample-app");
    expect(routePath({ kind: "view", appId: "sample-app", viewId: "entry-list" })).toBe(
      "/apps/sample-app/views/entry-list",
    );
    expect(
      routePath({
        kind: "view",
        appId: "sample-app",
        viewId: "entry-detail",
        recordId: "entry-0001",
        prefill: undefined,
      }),
    ).toBe("/apps/sample-app/views/entry-detail/records/entry-0001");
  });

  test("レコード付きのビューでも prefill はクエリ文字列に載る(パスは6セグメントのまま)", () => {
    expect(
      routePath({
        kind: "view",
        appId: "sample-app",
        viewId: "cart-form",
        recordId: "line-0001",
        prefill: { field: "product", value: "prod-1" },
      }),
    ).toBe("/apps/sample-app/views/cart-form/records/line-0001?prefill.product=prod-1");
  });

  test("prefill の値に記号が入っていてもエスケープされ、往復で元に戻る", () => {
    const route: Route = {
      kind: "view",
      appId: "sample-app",
      viewId: "cart-form",
      prefill: { field: "product", value: "a b&c=d/e" },
    };
    const path = routePath(route);
    expect(path).toBe("/apps/sample-app/views/cart-form?prefill.product=a+b%26c%3Dd%2Fe");
    expect(parseRoute(path)).toEqual(route);
  });
});

describe("プリフィルを載せた URL(V5-M24 / L-G17・L-G19)", () => {
  test("parseRoute はクエリ文字列の prefill.<field>=<value> を読む", () => {
    expect(parseRoute("/apps/sample-app/views/cart-form?prefill.product=prod-1")).toEqual({
      kind: "view",
      appId: "sample-app",
      viewId: "cart-form",
      prefill: { field: "product", value: "prod-1" },
    });
  });

  test("prefill 付きの URL は parseRoute → routePath で往復する(再読込・共有で同じ画面。L-G19)", () => {
    for (const path of [
      "/apps/sample-app/views/cart-form?prefill.product=prod-1",
      "/apps/sample-app/views/cart-form/records/line-0001?prefill.product=prod-1",
    ]) {
      expect(routePath(parseRoute(path))).toBe(path);
    }
  });

  test("prefill の鍵が2本以上あるときは黙って片方を採らない(プリフィルなしとして扱う)", () => {
    // ADR-0045 限定2/3 が「参照フィールド1つ × `_id` 1つ」に固定しているので、2本目が
    // 来た URL は意図が読めない。最後の1つを採ることも AND で重ねることも嘘になる。
    const route = parseRoute(
      "/apps/sample-app/views/cart-form?prefill.product=prod-1&prefill.shop=shop-1",
    );
    expect(route).toEqual({ kind: "view", appId: "sample-app", viewId: "cart-form" });
  });

  test("prefill の値が空、または鍵にフィールド名が無いときはプリフィルなしとして扱う", () => {
    for (const path of [
      "/apps/sample-app/views/cart-form?prefill.product=",
      "/apps/sample-app/views/cart-form?prefill.=prod-1",
    ]) {
      expect(parseRoute(path)).toEqual({
        kind: "view",
        appId: "sample-app",
        viewId: "cart-form",
      });
    }
  });

  test("prefill 以外のクエリは画面状態にしない(読まないし、書き戻さない)", () => {
    const route = parseRoute("/apps/sample-app/views/entry-list?record=item-0001");
    expect(route).toEqual({ kind: "view", appId: "sample-app", viewId: "entry-list" });
    expect(routePath(route)).toBe("/apps/sample-app/views/entry-list");
  });

  test("ビュー以外のパスに付いた prefill は無視する(アプリ一覧・アプリ画面は prefill を持たない)", () => {
    expect(parseRoute("/?prefill.product=prod-1")).toEqual({ kind: "app-list" });
    expect(parseRoute("/apps/sample-app?prefill.product=prod-1")).toEqual({
      kind: "app",
      appId: "sample-app",
    });
  });

  test("解釈できないパスはクエリ文字列ごと not-found として持ち帰る(黙って捨てない)", () => {
    expect(parseRoute("/nope/deeper?prefill.product=prod-1")).toEqual({
      kind: "not-found",
      path: "/nope/deeper?prefill.product=prod-1",
    });
  });
});

describe("URL のクエリの鍵の集合(V10-M20-T02 / FU-G9b)", () => {
  test("routePath が出す URL のクエリの鍵は prefill の1形だけである(鍵の集合を凍結する)", () => {
    /*
     * **鍵の集合の凍結**(`FU-G9b`)。`NV-G13` 限定3 の逐語「URLに1文字も載せない(パスの形も
     * クエリの鍵も増やさない)」のうち、**クエリの鍵の側**を測る。パスの形の側は
     * `web/test/intake-boundary.test.ts` の `routeKinds()` が凍結している。
     *
     * **接頭辞は製品コードの出力から取り出す。** `route.ts` の `PREFILL_PARAM_PREFIX` は
     * モジュール私有で `export` されていない。`export` させると `route.ts` に手が入るので
     * (`FU-G9b` 限定2)、`prefill` を持つ `Route` を `routePath` に通し、返った鍵から
     * フィールド名ぶんを末尾から落として接頭辞を得る。**綴りを検査側に二重に書かない。**
     */
    const queryKeysOf = (path: string): string[] => {
      const queryStart = path.indexOf("?");
      return queryStart === -1 ? [] : [...new URLSearchParams(path.slice(queryStart + 1)).keys()];
    };

    const probeField = "product";
    const probeKey = queryKeysOf(
      routePath({
        kind: "view",
        appId: "sample-app",
        viewId: "cart-form",
        prefill: { field: probeField, value: "prod-1" },
      }),
    ).find((key) => key.endsWith(probeField));
    // ここで取り出した値が `route.ts` の `PREFILL_PARAM_PREFIX` である。
    const prefillParamPrefix = probeKey === undefined ? "" : probeKey.slice(0, -probeField.length);
    expect(prefillParamPrefix.length).toBeGreaterThan(0);

    // `Route` の全 kind(view は素 / recordId あり / prefill あり / 両方 の4形)。
    const allRoutes: Route[] = [
      { kind: "app-list" },
      { kind: "app", appId: "sample-app" },
      { kind: "view", appId: "sample-app", viewId: "entry-list" },
      { kind: "view", appId: "sample-app", viewId: "entry-detail", recordId: "entry-0001" },
      {
        kind: "view",
        appId: "sample-app",
        viewId: "cart-form",
        prefill: { field: "product", value: "prod-1" },
      },
      {
        kind: "view",
        appId: "sample-app",
        viewId: "cart-form",
        recordId: "line-0001",
        prefill: { field: "shop", value: "shop-1" },
      },
      { kind: "not-found", path: "/nope/deeper" },
    ];

    // 鍵をフィールド名の違いで割らないよう、`<接頭辞><field>` の**形**に畳んでから凍結する。
    const keyShapes = [
      ...new Set(
        allRoutes
          .flatMap((route) => queryKeysOf(routePath(route)))
          .map((key) =>
            key.startsWith(prefillParamPrefix) ? `${prefillParamPrefix}<field>` : key,
          ),
      ),
    ].sort();

    // **1形だけ。**鍵が1本でも増えると、この突合が落ちる。
    expect(keyShapes).toEqual([`${prefillParamPrefix}<field>`]);
  });
});

describe("ログイン画面の専用の場所 /apps/<app_id>/login(V21-M4 / ADR-0482 §5 / D-V21-17)", () => {
  /*
   * **`Route` の種別は4つのまま**(`ADR-0482` §5-2)。 **`/apps/<id>/login` は `app` 種別の中の印
   * (`login: true`)で表す。** 5種目の枠(`ADR-0465` 限定1)は下見の器のためのものなので使わない。
   */
  test("parseRoute は /apps/<app_id>/login を app 種別の印つきに読む", () => {
    expect(parseRoute("/apps/sample-app/login")).toEqual({
      kind: "app",
      appId: "sample-app",
      login: true,
    });
  });

  test("末尾スラッシュ・クエリ文字列が付いていても同じに読む(prefill は載せない)", () => {
    expect(parseRoute("/apps/sample-app/login/")).toEqual({
      kind: "app",
      appId: "sample-app",
      login: true,
    });
    expect(parseRoute("/apps/sample-app/login?prefill.product=prod-1")).toEqual({
      kind: "app",
      appId: "sample-app",
      login: true,
    });
  });

  test("routePath は印つきの app を /apps/<app_id>/login に戻す(往復する)", () => {
    expect(routePath({ kind: "app", appId: "sample-app", login: true })).toBe(
      "/apps/sample-app/login",
    );
    expect(routePath(parseRoute("/apps/sample-app/login"))).toBe("/apps/sample-app/login");
  });

  test("印の無い app は今日と1バイトも同じ URL(MCP の routePath の出力を変えない)", () => {
    expect(routePath({ kind: "app", appId: "sample-app" })).toBe("/apps/sample-app");
    expect(parseRoute("/apps/sample-app")).toEqual({ kind: "app", appId: "sample-app" });
  });

  // **【`V22-M3-T05`。授権 `ADR-0489` 行44】旧題の逐語**: `login の下の階層・login 以外の3階層目は今日どおり not-found`
  // **`my-page` の3階層目は今日から `app` 種別の印になる**(下の `V22-M3` の describe)。 期待値は1つも変えていない。
  test("login の下の階層・login 以外の3階層目(my-page を除く)は今日どおり not-found", () => {
    expect(parseRoute("/apps/sample-app/login/deeper").kind).toBe("not-found");
    expect(parseRoute("/apps/sample-app/logout").kind).toBe("not-found");
  });

  test("印つきの URL のクエリの鍵は0本(鍵の集合を増やさない)", () => {
    expect(routePath({ kind: "app", appId: "sample-app", login: true })).not.toContain("?");
  });
});

describe("マイページの場所 /apps/<app_id>/my-page(V22-M3 / ADR-0488 §Decision 1 の 6)", () => {
  test("parseRoute は /apps/<app_id>/my-page を app 種別の印つきに読む(種別は4つのまま)", () => {
    expect(parseRoute("/apps/sample-app/my-page")).toEqual({
      kind: "app",
      appId: "sample-app",
      myPage: true,
    });
    expect(parseRoute("/apps/sample-app/my-page/")).toEqual({
      kind: "app",
      appId: "sample-app",
      myPage: true,
    });
    expect(parseRoute("/apps/sample-app/my-page?prefill.x=1")).toEqual({
      kind: "app",
      appId: "sample-app",
      myPage: true,
    });
  });

  test("routePath は印つきの app を /apps/<app_id>/my-page に戻す(往復する)", () => {
    expect(routePath({ kind: "app", appId: "sample-app", myPage: true })).toBe(
      "/apps/sample-app/my-page",
    );
    expect(routePath(parseRoute("/apps/sample-app/my-page"))).toBe("/apps/sample-app/my-page");
  });

  test("login と myPage は同時に成り立たない: parseRoute はどちらか一方だけを作り、routePath は両方立っていたら login を優先する", () => {
    expect(parseRoute("/apps/sample-app/login")).not.toHaveProperty("myPage");
    expect(parseRoute("/apps/sample-app/my-page")).not.toHaveProperty("login");
    expect(routePath({ kind: "app", appId: "sample-app", login: true, myPage: true })).toBe(
      "/apps/sample-app/login",
    );
  });

  test("my-page の下の階層は not-found", () => {
    expect(parseRoute("/apps/sample-app/my-page/deeper").kind).toBe("not-found");
  });
});

// **【`V23-M5-T06`(画面)。`D-V23-129`・`ADR-0532` §Decision 1-8】受け取り画面の場所。**
// マイページと同じ作法で、種別を増やさず `app` の中の印で表す。 旧の検査は1本も書き換えていない(追加だけ)。
describe("招待の受け取り画面の場所 /apps/<app_id>/invitations(V23-M5)", () => {
  test("parseRoute は /apps/<app_id>/invitations を app 種別の印つきに読む(種別は4つのまま)", () => {
    expect(parseRoute("/apps/sample-app/invitations")).toEqual({
      kind: "app",
      appId: "sample-app",
      invitations: true,
    });
    expect(parseRoute("/apps/sample-app/invitations/")).toEqual({
      kind: "app",
      appId: "sample-app",
      invitations: true,
    });
    expect(parseRoute("/apps/sample-app/invitations?prefill.x=1")).toEqual({
      kind: "app",
      appId: "sample-app",
      invitations: true,
    });
  });

  test("routePath は印つきの app を /apps/<app_id>/invitations に戻す(往復する)", () => {
    expect(routePath({ kind: "app", appId: "sample-app", invitations: true })).toBe(
      "/apps/sample-app/invitations",
    );
    expect(routePath(parseRoute("/apps/sample-app/invitations"))).toBe(
      "/apps/sample-app/invitations",
    );
  });

  test("login・myPage とは同時に成り立たない: routePath は login、次に myPage を優先する", () => {
    expect(parseRoute("/apps/sample-app/invitations")).not.toHaveProperty("myPage");
    expect(parseRoute("/apps/sample-app/invitations")).not.toHaveProperty("login");
    expect(parseRoute("/apps/sample-app/my-page")).not.toHaveProperty("invitations");
    expect(routePath({ kind: "app", appId: "sample-app", login: true, invitations: true })).toBe(
      "/apps/sample-app/login",
    );
    expect(routePath({ kind: "app", appId: "sample-app", myPage: true, invitations: true })).toBe(
      "/apps/sample-app/my-page",
    );
  });

  test("invitations の下の階層は not-found、印の無い app の URL は今日と同じ", () => {
    expect(parseRoute("/apps/sample-app/invitations/deeper").kind).toBe("not-found");
    expect(routePath({ kind: "app", appId: "sample-app" })).toBe("/apps/sample-app");
  });
});
