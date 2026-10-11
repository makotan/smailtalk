/**
 * URL ↔ 画面状態(V0-P3-T03)。
 *
 * URL 空間は ADR-0003 と同じ「アプリの内容に依存しない」形にしてある。
 * アプリID・ビューID は**パスパラメータ**であって、アプリごとに生成された
 * パスではない。したがってフロントにアプリ固有の名前は現れない。
 *
 *   /                                    アプリ一覧
 *   /apps/<app_id>                       そのアプリのビュー一覧
 *   /apps/<app_id>/views/<view_id>       個別のビュー
 *   /apps/<app_id>/views/<view_id>/records/<record_id>
 *                                        対象レコードを1件指定したビュー
 *
 * **【V5-M24-T01 / L-G17 の追記】パスの4形はここから1つも増えていない。**
 * 操作起点のプリフィルは**クエリ文字列**(`?prefill.<field>=<value>`)に載る。
 * パスは今日も上の4形だけであり、`ADR-0003` の「アプリの内容に依存しない URL 空間」
 * (アプリID・ビューID がパスパラメータであること)は1バイトも変えていない。
 *
 * **【`V21-M4` / `ADR-0482` §5(`AN-G5`)/ `D-V21-17` の追記。上の段落を1バイトも消していない】**
 * **パスの形が1つ増えた**: `/apps/<app_id>/login`(ログイン画面の専用の場所)。 **上の「パスの4形は
 * ここから1つも増えていない」は今日から偽である。** **ただし `Route` の種別は4つのまま**で、
 * `app` 種別の中の印(`login: true`)で表す(`ADR-0482` §5-2)。 URL はアプリの内容に依存しない
 * (`ADR-0003` の URL 空間には当たらない。`ADR-0482` §破る条文 23)。
 *
 * 画面状態が完全に URL に載っているので、ブラウザのリロードで同じ画面に戻る
 * (V0-P3-T07 の前提)。
 *
 * **レコードID を第一級の画面状態にしている**(V0-P3-T06)。detail_view は
 * 「どのレコードを見ているか」、form は「どのレコードを編集しているか」が
 * 画面状態そのものであり、これが URL に無いと詳細画面をリロードできず、
 * アプリ内から特定レコードの編集画面にリンクすることもできない。
 * どのビュー種別がレコードID を使うかは**マニフェストが決める**ことなので、
 * URL 空間は種別で分けず「ビューに対象レコードが付くことがある」形にしてある。
 */

/**
 * ビューからの操作起点のプリフィル(EC-G14 / ADR-0045)。
 *
 * detail_view の操作起点(`this を〜する`ボタン)を押して form へ遷移するときに運ぶ、
 * **遷移時の一時状態**である。`field`(遷移先 form の対象テーブル上の reference フィールド)に
 * `value`(今開いているレコードの `_id`)を入れて form を開く。**参照フィールド1つ × `_id`** に
 * 固定され、条件付き・複数・既定値式・`_id` 以外の値は持たない(ADR-0045 限定2/3)。
 *
 * **【V5-M24-T01 / L-G17。ここに書いてあった判断を差し替えた】**
 * 着手前(`64fd1a4`)のこの段落は「**これは URL 空間には載せない。**`routePath`/`parseRoute` は
 * 既存6セグメントだけを扱い、prefill を1バイトも書かない」と書いており、運搬は
 * `web/src/navigation.tsx` が `history.state` 経由で行っていた。**今日は URL に載る。**
 *
 * **載せ方**: `?prefill.<field>=<value>` の**クエリ文字列**1本。**パスの4形は1つも増やさない**
 * (6セグメントのまま)。`prefill.` 接頭辞と「鍵は1本だけ」の規則は `ADR-0003:149` が
 * HTTP API のクエリについて採った `filter.<field>` の作法をそのまま借りたもので、
 * フィールドID は `^[a-z][a-z0-9_-]*$`(`src/kernel/resource-id.ts`)なのでドットを含まず、
 * 将来の制御パラメータと衝突しない。
 *
 * **`prefill` を持たない `Route` には、クエリ文字列が1文字も付かない。** これは MCP の
 * `get_preview_url` / `create_app` の `preview_url` の応答を変えないための条件である(L-G18)。
 */
export type RoutePrefill = {
  field: string;
  value: string;
};

export type Route =
  | { kind: "app-list" }
  | {
      kind: "app";
      appId: string;
      /**
       * **ログイン画面の専用の場所 `/apps/<app_id>/login`**(`V21-M4` / `ADR-0482` §5 / `D-V21-17`)。
       * **種別を増やさず `app` の中の印で表す**(§5-2。`ADR-0465` 限定1 の5種目の枠は下見の器の
       * ためのもので、ここでは使わない)。 **印の無い `app` の URL は今日と1バイトも同じ**
       * (MCP の `get_preview_url` / `create_app` はこの印を付けない)。
       */
      login?: true | undefined;
      /**
       * **【`V22-M3-T05`】マイページの場所 `/apps/<app_id>/my-page`**(`ADR-0488` §Decision 1 の 6 /
       * `D-V22-6`・`D-V22-20`)。 **`login` と同じく種別を増やさず `app` の中の印で表す**(限定15)。
       * **`login` と同時には成り立たない** —— `parseRoute` は3階層目が1つなのでどちらか一方しか作らず、
       * `routePath` は両方立っていたら `login` を優先する。 **印の無い `app` の URL は今日と1バイトも同じ。**
       */
      myPage?: true | undefined;
      /**
       * **【`V23-M5-T06`】招待の受け取り画面の場所 `/apps/<app_id>/invitations`**(`D-V23-129`・`ADR-0532` §Decision 1-8)。
       * **`myPage` と同じく種別を増やさず `app` の中の印で表す。** `login`・`myPage` と同時には成り立たず、
       * `routePath` は `login`、次に `myPage` を優先する。 **印の無い `app` の URL は今日と1バイトも同じ。**
       */
      invitations?: true | undefined;
    }
  | {
      kind: "view";
      appId: string;
      viewId: string;
      /** 対象レコードの `_id`。付かないこともある(一覧・新規作成フォーム)。 */
      recordId?: string | undefined;
      /**
       * 操作起点のプリフィル(EC-G14 / ADR-0045)。**URL のクエリ文字列に載る画面状態**で、
       * `parseRoute` が読み、`routePath` が書き戻す(V5-M24-T01)。付かないこともある。
       */
      prefill?: RoutePrefill | undefined;
    }
  /** 解釈できないパス。黙ってアプリ一覧に化けさせない(憲法6)。 */
  | { kind: "not-found"; path: string };

const APPS_SEGMENT = "apps";
const VIEWS_SEGMENT = "views";
const RECORDS_SEGMENT = "records";
/** `/apps/<app_id>/login` の3階層目(`V21-M4`)。 */
const LOGIN_SEGMENT = "login";
/** `/apps/<app_id>/my-page` の3階層目(`V22-M3-T05`)。 */
const MY_PAGE_SEGMENT = "my-page";
/** `/apps/<app_id>/invitations` の3階層目(`V23-M5-T06`)。 */
const INVITATIONS_SEGMENT = "invitations";

/**
 * プリフィルを載せるクエリの鍵の接頭辞(V5-M24-T01)。
 *
 * `ADR-0003:149` が HTTP API のクエリについて `filter.<field>` を採ったのと同じ作法である。
 */
const PREFILL_PARAM_PREFIX = "prefill.";

/**
 * クエリ文字列から操作起点のプリフィルを読む。
 *
 * **`prefill.` で始まる鍵がちょうど1本のときだけ**プリフィルとして扱う。0本なら無し、
 * 2本以上なら**無しとして扱う** —— `ADR-0045` 限定2/3 が「参照フィールド1つ × `_id` 1つ」に
 * 固定しているので、2本目が来た URL は意図が読めない。最後の1つを採ることも AND で重ねる
 * ことも書き手に対する嘘になる(`ADR-0003:151` が同じ状況で 400 を選んだのと同じ理由。
 * ここは画面なので、エラーにせず「プリフィル無しの画面」に落とす)。
 * 鍵にフィールド名が無い(`prefill.=`)場合と値が空の場合も無しとして扱う。
 */
function parsePrefill(search: string): RoutePrefill | undefined {
  if (search === "") {
    return undefined;
  }
  const entries = [...new URLSearchParams(search).entries()].filter(([key]) =>
    key.startsWith(PREFILL_PARAM_PREFIX),
  );
  if (entries.length !== 1) {
    return undefined;
  }
  const [key, value] = entries[0] as [string, string];
  const field = key.slice(PREFILL_PARAM_PREFIX.length);
  if (field === "" || value === "") {
    return undefined;
  }
  return { field, value };
}

/**
 * URL(`location.pathname` + `location.search`)を画面状態に読み替える。
 *
 * **クエリ文字列を渡さなくても着手前と同じ結果になる** —— プリフィルが無いだけである。
 * **`prefill.` 以外のクエリは画面状態にしない**(読まないし `routePath` で書き戻さない)。
 */
export function parseRoute(url: string): Route {
  const queryStart = url.indexOf("?");
  const pathname = queryStart === -1 ? url : url.slice(0, queryStart);
  const search = queryStart === -1 ? "" : url.slice(queryStart + 1);
  const segments = pathname.split("/").filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    return { kind: "app-list" };
  }
  const [root, appId, views, viewId, records, recordId] = segments;
  if (root === APPS_SEGMENT && appId !== undefined) {
    if (segments.length === 2) {
      return { kind: "app", appId };
    }
    // **【`V21-M4`】ログイン画面の専用の場所。** クエリ文字列は画面状態にしない(prefill も載せない)。
    if (segments.length === 3 && views === LOGIN_SEGMENT) {
      return { kind: "app", appId, login: true };
    }
    // **【`V22-M3-T05`】マイページの場所。** ログイン画面と同じく、クエリ文字列は画面状態にしない。
    if (segments.length === 3 && views === MY_PAGE_SEGMENT) {
      return { kind: "app", appId, myPage: true };
    }
    // **【`V23-M5-T06`】招待の受け取り画面の場所。** マイページと同じく、クエリ文字列は画面状態にしない。
    if (segments.length === 3 && views === INVITATIONS_SEGMENT) {
      return { kind: "app", appId, invitations: true };
    }
    if (views === VIEWS_SEGMENT && viewId !== undefined) {
      const prefill = parsePrefill(search);
      const withPrefill = prefill === undefined ? {} : { prefill };
      if (segments.length === 4) {
        return { kind: "view", appId, viewId, ...withPrefill };
      }
      if (segments.length === 6 && records === RECORDS_SEGMENT && recordId !== undefined) {
        return { kind: "view", appId, viewId, recordId, ...withPrefill };
      }
    }
  }
  // 解釈できないパスは**クエリ文字列ごと**持ち帰る(黙って捨てると往復しない)。
  return { kind: "not-found", path: url };
}

/** 画面状態を URL に戻す(`parseRoute` と往復する)。 */
export function routePath(route: Route): string {
  switch (route.kind) {
    case "app-list":
      return "/";
    case "app":
      // **印が無ければ今日と1バイトも同じ**(`V21-M4`。MCP の応答を変えない)。
      // **【`V22-M3-T05`】旧の逐語(1バイトも消していない)**:
      //   `return route.login === true`
      //   `  ? \`/${APPS_SEGMENT}/${route.appId}/${LOGIN_SEGMENT}\``
      //   `  : \`/${APPS_SEGMENT}/${route.appId}\`;`
      // **マイページの印を足した。 両方立っていたら `login` を優先する**(計画の点検 軽-1)。
      if (route.login === true) {
        return `/${APPS_SEGMENT}/${route.appId}/${LOGIN_SEGMENT}`;
      }
      // **【`V23-M5-T06`】旧の逐語(1バイトも消していない)**:
      //   `return route.myPage === true`
      //   `  ? \`/${APPS_SEGMENT}/${route.appId}/${MY_PAGE_SEGMENT}\``
      //   `  : \`/${APPS_SEGMENT}/${route.appId}\`;`
      // **招待の受け取り画面の印を足した。 `myPage` と両方立っていたら `myPage` を優先する。**
      if (route.myPage === true) {
        return `/${APPS_SEGMENT}/${route.appId}/${MY_PAGE_SEGMENT}`;
      }
      return route.invitations === true
        ? `/${APPS_SEGMENT}/${route.appId}/${INVITATIONS_SEGMENT}`
        : `/${APPS_SEGMENT}/${route.appId}`;
    case "view": {
      const base = `/${APPS_SEGMENT}/${route.appId}/${VIEWS_SEGMENT}/${route.viewId}`;
      const path =
        route.recordId === undefined ? base : `${base}/${RECORDS_SEGMENT}/${route.recordId}`;
      if (route.prefill === undefined) {
        // **prefill が無ければクエリ文字列は1文字も付かない。** MCP の `get_preview_url` /
        // `create_app` の `preview_url` はここを通るので、この分岐が応答の不変を担保する(L-G18)。
        return path;
      }
      const query = new URLSearchParams([
        [`${PREFILL_PARAM_PREFIX}${route.prefill.field}`, route.prefill.value],
      ]);
      return `${path}?${query.toString()}`;
    }
    case "not-found":
      return route.path;
  }
}
