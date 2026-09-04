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
