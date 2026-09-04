/**
 * `V10-M6-T01a`: **登録の直後、行き先の候補がちょうど1本のときだけ、その画面を自動で開く**
 * (表示層。`web/src/auth/signup-next.ts` の {@link useSignupAutoOpen})。
 *
 * ## 【この検査が測っていないこと。先に書く】
 *
 * - **配る版(`web/src/runner-main.tsx`)は1バイトも通っていない。** **別ファイルであり、
 *   本ファイルは `web/src/App.tsx` の経路しか描いていない**(配る版は別タスク `T01b` の担当)。
 * - **ブラウザでは1度も動かしていない。** 描いているのは happy-dom であり、
 *   実ブラウザの `history.pushState` / `popstate` の挙動は1つも測っていない。
 * - **候補が2本以上のときの並び順を測っていない。** 本ファイルが測るのは
 *   「**2本のときは1文字も動かない**」だけで、「どちらが先頭か」は1件も検査していない
 *   (先頭を選ぶ規約を採っていないので、測る対象が無い)。
 * - **サーバの遮断を1つも測っていない。** ここで測るのは表示層の候補の数だけであり、
 *   自動で開いた画面が実際に読めるかどうか(403 / 404)は1件も見ていない。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Manifest } from "../../src/kernel/types.ts";
import { App } from "../src/App.tsx";
import { actionRead, grantRules, viewRead } from "./role-rules.ts";

const APP_ID = "shop-app";

/**
 * 題材の下ごしらえ。**`web/test/customer-signup-next.test.tsx` の形をそのまま借りている**
 * (`<App />` を描いて登録ボタンを押す)。
 */
function baseManifest(): Manifest {
  return {
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
        {
          id: "notice",
          name: "お知らせ",
          fields: [{ id: "body", name: "本文", type: "text" }],
        },
      ],
      views: [
        {
          id: "notice-list",
          name: "お知らせ一覧",
          type: "list_view",
          table: "notice",
          columns: ["body"],
        },
        {
          id: "member-form",
          name: "会員情報の登録",
          type: "form",
          table: "member",
          fields: ["display_name"],
        },
      ],
    },
  };
}

/** 候補がちょうど1本(`member-form` だけが `st_owner` つきの表の `form`)。 */
function manifestWithOneCandidate(): Manifest {
  return grantRules(
    baseManifest(),
    ["customer"],
    [viewRead("member-form"), viewRead("notice-list")],
  );
}

/** 候補が2本(同じ `st_owner` つきの表に `form` を2本置く)。 */
function manifestWithTwoCandidates(): Manifest {
  const built = baseManifest();
  built.app.views.push({
    id: "member-form-2",
    name: "会員情報の登録(その2)",
    type: "form",
    table: "member",
    fields: ["display_name"],
  });
  return grantRules(built, ["customer"], [viewRead("member-form"), viewRead("member-form-2")]);
}

/**
 * **候補が2本。ただし表が別々である**(`member` と `address`)。
 * **`FU-G7b` は表ごとに1回読むので、片方だけに行を置くにはこの形が要る**
 * (`manifestWithTwoCandidates` は同じ表に `form` を2本置いており、片方だけ落とせない)。
 */
function manifestWithTwoTables(): Manifest {
  const built = baseManifest();
  built.app.tables.push({
    id: "address",
    name: "住所",
    fields: [
      { id: "line", name: "住所", type: "text", required: true },
      { id: "st_owner", name: "所有者", type: "text" },
    ],
  });
  built.app.views.push({
    id: "address-form",
    name: "住所の登録",
    type: "form",
    table: "address",
    fields: ["line"],
  });
  return grantRules(built, ["customer"], [viewRead("member-form"), viewRead("address-form")]);
}

/** 候補が0本(`st_owner` を持つ表そのものが無い)。 */
function manifestWithNoCandidate(): Manifest {
  const built = baseManifest();
  built.app.tables = built.app.tables.filter((table) => table.id !== "member");
  built.app.views = built.app.views.filter((view) => view.id !== "member-form");
  return grantRules(built, ["customer"], [viewRead("notice-list")]);
}

/**
 * 候補になりうる画面は在るが、**その立場に読取の規則が1本も無い**題材
 * (`canUseView` を迂回していないことを測るための題材)。
 */
function manifestWithoutCustomerRule(): Manifest {
  return grantRules(baseManifest(), ["owner"], [viewRead("member-form")]);
}

/** `st_owner` を持たない表の `form` しか無い題材(`personalOwnerField` の側)。 */
function manifestWithoutOwnerField(): Manifest {
  const built = baseManifest();
  built.app.tables = built.app.tables.map((table) =>
    table.id === "member"
      ? { ...table, fields: table.fields.filter((field) => field.id !== "st_owner") }
      : table,
  );
  return grantRules(built, ["customer"], [viewRead("member-form"), viewRead("notice-list")]);
}

/**
 * **候補になりうる画面は在るが、その表へ「作成」を書く名前つきの操作起点が1本在る**題材
 * (`V10-M19-T03` / `FU-G8` / `ADR-0365`)。
 *
 * **`actionRoles` にその操作起点の読取を許す。** **`customer` を入れなければ
 * 「その表に作成を書く操作起点を1本も読めない立場」になり、`form` の保存は必ず 403 になる**
 * (壁は(アプリ, 表, 書込の種類)だけで決まり、要求が画面を名乗ったかどうかを1ミリも見ない)。
 *
 * **足しているのは題材の側の宣言だけであり、判定を1バイトも緩めていない。**
 * **判定の式そのものはここに書き写していない** —— **式の在処は `ADR-0365` §Decision 4 である。**
 */
function manifestWithCreateAction(actionRoles: readonly string[]): Manifest {
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
            {
              id: "notice_ref",
              name: "お知らせ",
              type: "reference",
              reference_table: "notice",
            },
            { id: "st_owner", name: "所有者", type: "text" },
          ],
        },
        {
          id: "notice",
          name: "お知らせ",
          fields: [{ id: "body", name: "本文", type: "text" }],
        },
      ],
      views: [
        {
          id: "notice-list",
          name: "お知らせ一覧",
          type: "list_view",
          table: "notice",
          columns: ["body"],
          actions: [
            {
              id: "add-member",
              name: "会員情報を作る",
              form: "member-form",
              prefill: { field: "notice_ref" },
            },
          ],
        },
        {
          id: "member-form",
          name: "会員情報の登録",
          type: "form",
          table: "member",
          fields: ["display_name"],
        },
      ],
    },
  };
  const granted = grantRules(
    built,
    ["customer"],
    [viewRead("member-form"), viewRead("notice-list")],
  );
  return grantRules(granted, actionRoles, [actionRead("notice-list", "add-member")]);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let originalFetch: typeof fetch;

function stub(routes: (url: string) => Response | undefined): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    const response = routes(url.split("?")[0] ?? url);
    return Promise.resolve(
      response ?? jsonResponse({ errors: [{ path: "", message: `no stub for ${url}` }] }, 404),
    );
  }) as typeof fetch;
}

/**
 * **認証と定義の口だけを返す**(表の読取は呼び出し側が決める)。
 *
 * **【`V10-M19-T02` で切り出した。既存の検査は1本も消していない】**
 * **`anonymousStub` の中身をそのままここへ移し、表の読取だけを差し替えられるようにした**
 * —— **`FU-G7b` の検査は「その表に行が見えるか」を題材ごとに変える必要がある。**
 */
function authRoutes(manifest: Manifest, url: string): Response | undefined {
  if (url === `/api/apps/${APP_ID}/auth/me`) {
    return jsonResponse({ errors: [{ path: "", message: "認証されていません。" }] }, 401);
  }
  if (url === `/api/apps/${APP_ID}/manifest`) {
    return jsonResponse(manifest);
  }
  if (url === `/api/apps/${APP_ID}/auth/signup/password/register`) {
    return jsonResponse({ user: { id: "u-1", username: "kaimono", role: "customer" } });
  }
  if (url === `/api/apps/${APP_ID}/auth/password/login`) {
    return jsonResponse({ user: { id: "u-1", username: "kaimono", role: "customer" } });
  }
  return undefined;
}

/** URL から表の id を取り出す(`/api/apps/:app_id/tables/:table_id/records`)。 */
function tableIdOf(url: string): string {
  return url.slice(`/api/apps/${APP_ID}/tables/`.length).split("/")[0] ?? "";
}

/** 未ログイン → その manifest を返し、表の読取は渡された関数が決める。 */
function anonymousStubWith(manifest: Manifest, tableResponse: (tableId: string) => Response): void {
  stub((url) => {
    const authed = authRoutes(manifest, url);
    if (authed !== undefined) {
      return authed;
    }
    if (url.startsWith(`/api/apps/${APP_ID}/tables/`)) {
      return tableResponse(tableIdOf(url));
    }
    return undefined;
  });
}

/** 未ログイン → その manifest を返す、という最小のルーティング(表の行は0件)。 */
function anonymousStub(manifest: Manifest): void {
  anonymousStubWith(manifest, () => jsonResponse({ records: [], total: 0 }));
}

/** 指定した表だけ「行が1件見える」ルーティング。 */
function anonymousStubWithRows(manifest: Manifest, tablesWithRows: readonly string[]): void {
  anonymousStubWith(manifest, (tableId) =>
    tablesWithRows.includes(tableId)
      ? jsonResponse({ records: [{ _id: "row-1" }], total: 1 })
      : jsonResponse({ records: [], total: 0 }),
  );
}

/** 表の読取が失敗する(500)ルーティング。 */
function anonymousStubWithReadFailure(manifest: Manifest): void {
  anonymousStubWith(manifest, () =>
    jsonResponse({ errors: [{ path: "", message: "サーバの都合で読めません。" }] }, 500),
  );
}

/**
 * **表の読取が 403(その立場には許されていない)を返すルーティング**
 * (`V10-M19-T03` / `FU-G8`)。 **文面はサーバの実物に寄せていない** ——
 * **落とす判断に使うのは応答コードだけである。**
 */
function anonymousStubWithForbiddenRead(manifest: Manifest): void {
  anonymousStubWith(manifest, () =>
    jsonResponse({ errors: [{ path: "", message: "閉められています。" }] }, 403),
  );
}

/**
 * **指定した表の読取だけを止めたまま返さないルーティング。**
 * **返り値を呼ぶと、そこで初めて応答(0件)が返る。**
 */
function anonymousStubDeferringTable(manifest: Manifest, tableId: string): () => void {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = () => {
      resolve();
    };
  });
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    const path = url.split("?")[0] ?? url;
    const authed = authRoutes(manifest, path);
    if (authed !== undefined) {
      return Promise.resolve(authed);
    }
    if (path === `/api/apps/${APP_ID}/tables/${tableId}/records`) {
      return gate.then(() => jsonResponse({ records: [], total: 0 }));
    }
    if (path.startsWith(`/api/apps/${APP_ID}/tables/`)) {
      return Promise.resolve(jsonResponse({ records: [], total: 0 }));
    }
    return Promise.resolve(
      jsonResponse({ errors: [{ path: "", message: `no stub for ${url}` }] }, 404),
    );
  }) as typeof fetch;
  return release;
}

async function signUp(): Promise<void> {
  await screen.findByTestId("customer-password-register");
  fireEvent.change(screen.getByTestId("auth-username"), { target: { value: "kaimono" } });
  fireEvent.change(screen.getByTestId("auth-password"), { target: { value: "pw" } });
  fireEvent.click(screen.getByTestId("customer-password-register"));
}

/** 画面が落ち着くまで待つ(自動遷移が起きるなら、この間に起きる)。 */
async function settle(): Promise<void> {
  await waitFor(() => {
    expect(screen.queryByTestId("current-user")).not.toBeNull();
  });
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  window.history.replaceState({}, "", `/apps/${APP_ID}`);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.history.replaceState({}, "", "/");
});

describe("登録の直後、候補が1本のときだけ自動で開く", () => {
  test("a-1: 候補がちょうど1本なら、その画面が開く", async () => {
    anonymousStub(manifestWithOneCandidate());
    render(<App />);
    await signUp();

    await waitFor(() => {
      expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/member-form`);
    });
  });

  test("a-2: 自動で開いても、案内は消えない", async () => {
    anonymousStub(manifestWithOneCandidate());
    render(<App />);
    await signUp();

    await waitFor(() => {
      expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/member-form`);
    });
    expect(screen.queryByTestId("customer-signup-next")).not.toBeNull();
  });

  test("b-1: 候補が2本なら、パスは1文字も変わらない(案内のリンクは2本)", async () => {
    anonymousStub(manifestWithTwoCandidates());
    render(<App />);
    await signUp();

    const notice = await screen.findByTestId("customer-signup-next");
    await settle();
    expect(window.location.pathname).toBe(`/apps/${APP_ID}`);
    expect(notice.querySelectorAll("a").length).toBe(2);
  });

  test("c-1: 候補が0本なら、パスは変わらない", async () => {
    anonymousStub(manifestWithNoCandidate());
    render(<App />);
    await signUp();

    await settle();
    expect(window.location.pathname).toBe(`/apps/${APP_ID}`);
  });

  test("d-1: ログイン(登録ではない)では、候補が1本でもパスが変わらない", async () => {
    anonymousStub(manifestWithOneCandidate());
    render(<App />);
    await screen.findByTestId("password-login");
    fireEvent.change(screen.getByTestId("auth-username"), { target: { value: "kaimono" } });
    fireEvent.change(screen.getByTestId("auth-password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByTestId("password-login"));

    await settle();
    expect(window.location.pathname).toBe(`/apps/${APP_ID}`);
  });

  test("e-1: 自分で別の画面へ移ったあと、引き戻されない", async () => {
    anonymousStub(manifestWithOneCandidate());
    render(<App />);
    await signUp();

    await waitFor(() => {
      expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/member-form`);
    });

    // **製品の導線で移す** —— 左ナビのリンクを押す(`navigate()` の直呼びで移すと
    // 「利用者が移った」と書けない)。
    const nav = await screen.findByTestId("view-list");
    const link = [...nav.querySelectorAll("a")].find(
      (candidate) => candidate.getAttribute("href") === `/apps/${APP_ID}/views/notice-list`,
    );
    expect(link).not.toBeUndefined();
    fireEvent.click(link as HTMLAnchorElement);

    await waitFor(() => {
      expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/notice-list`);
    });
    await settle();
    expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/notice-list`);
  });

  test("f-1: `canUseView` を迂回しない(読取の規則が1本も無ければ候補0本)", async () => {
    anonymousStub(manifestWithoutCustomerRule());
    render(<App />);
    await signUp();

    await settle();
    expect(screen.queryByTestId("customer-signup-next")).toBeNull();
    expect(window.location.pathname).toBe(`/apps/${APP_ID}`);
  });

  test("f-2: `personalOwnerField` を迂回しない(`st_owner` の無い表の form は候補にしない)", async () => {
    anonymousStub(manifestWithoutOwnerField());
    render(<App />);
    await signUp();

    await settle();
    expect(screen.queryByTestId("customer-signup-next")).toBeNull();
    expect(window.location.pathname).toBe(`/apps/${APP_ID}`);
  });
});

/**
 * `V10-M19-T02`: **見える範囲に行がある候補を、案内からも自動オープンからも落とす**
 * (`FU-G7b` / `ADR-0364`。実装は `web/src/auth/signup-next.ts` の `useSignupNextCandidates`)。
 *
 * ## 【この検査が測っていないこと。先に書く】
 *
 * - **偽陰性を1件も測っていない。** **付与表を併用する表では、行が在ってもサーバの
 *   絞り込みで0件が返りうる**(`ADR-0364` §S3 の 3)。 **ここで描いているのは fetch の
 *   スタブであり、サーバの絞り込みは1バイトも通っていない。**
 * - **偽陽性を1件も測っていない。** **共有行(`st_owner` が `null` / 空文字)は全員に見えるので、
 *   自分の行が1件も無くても候補が落ちる**(同 4)。 **スタブは「誰の行か」を1つも持っていない。**
 * - **ブラウザでは1度も動かしていない**(happy-dom)。
 * - **二重登録が防げることを測っていない。** **測っているのは「登録直後の窓の中で、
 *   見える範囲に行がある候補が落ちる」ことだけである。**
 */
describe("登録の直後、見える範囲に行がある候補を落とす(V10-M19-T02 / FU-G7b)", () => {
  test("h-1: 行が1件も無ければ、今日どおり候補に残る(自動で開き、案内にも出る)", async () => {
    anonymousStubWithRows(manifestWithOneCandidate(), []);
    render(<App />);
    await signUp();

    await waitFor(() => {
      expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/member-form`);
    });
    expect(screen.queryByTestId("customer-signup-next")).not.toBeNull();
  });

  test("h-2: 行が1件でも見えれば、候補から落ちる(案内にも出ず、自動でも開かない)", async () => {
    anonymousStubWithRows(manifestWithOneCandidate(), ["member"]);
    render(<App />);
    await signUp();

    await settle();
    expect(screen.queryByTestId("customer-signup-next")).toBeNull();
    expect(window.location.pathname).toBe(`/apps/${APP_ID}`);
  });

  test("h-3: 候補2本のうち片方だけに行が在れば、残る1本で自動オープンが起きる", async () => {
    anonymousStubWithRows(manifestWithTwoTables(), ["address"]);
    render(<App />);
    await signUp();

    await waitFor(() => {
      expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/member-form`);
    });
    // **案内にも、残った1本しか並ばない。**
    const notice = await screen.findByTestId("customer-signup-next");
    expect(notice.querySelectorAll("a").length).toBe(1);
  });

  test("h-4: 落ちた結果0本になったら、案内が1つも出ない", async () => {
    anonymousStubWithRows(manifestWithTwoTables(), ["member", "address"]);
    render(<App />);
    await signUp();

    await settle();
    expect(screen.queryByTestId("customer-signup-next")).toBeNull();
    expect(screen.queryByTestId("customer-signup-next-dismiss")).toBeNull();
    expect(window.location.pathname).toBe(`/apps/${APP_ID}`);
  });

  test("h-5: 読取が失敗したときは落ちない(開いた側に倒す)", async () => {
    anonymousStubWithReadFailure(manifestWithOneCandidate());
    render(<App />);
    await signUp();

    await waitFor(() => {
      expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/member-form`);
    });
    expect(screen.queryByTestId("customer-signup-next")).not.toBeNull();
  });

  test("h-6: 読み終える前に自動で開かない(読取を止めているあいだ、パスは1文字も変わらない)", async () => {
    const release = anonymousStubDeferringTable(manifestWithOneCandidate(), "member");
    render(<App />);
    await signUp();

    await settle();
    // **読取が返っていないので、まだ開かない**(`ADR-0364` 限定5 の前半)。
    expect(window.location.pathname).toBe(`/apps/${APP_ID}`);

    release();
    await waitFor(() => {
      expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/member-form`);
    });
  });

  test("h-7: 読んでいるあいだに自分で別の画面へ移ったら、読み終えても引き戻されない", async () => {
    const release = anonymousStubDeferringTable(manifestWithOneCandidate(), "member");
    render(<App />);
    await signUp();
    await settle();

    // **製品の導線で移す** —— 左ナビのリンクを押す(`e-1` と同じ作法)。
    const nav = await screen.findByTestId("view-list");
    const link = [...nav.querySelectorAll("a")].find(
      (candidate) => candidate.getAttribute("href") === `/apps/${APP_ID}/views/notice-list`,
    );
    expect(link).not.toBeUndefined();
    fireEvent.click(link as HTMLAnchorElement);
    await waitFor(() => {
      expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/notice-list`);
    });

    // **ここで読取が返る** —— **読み始めた時点と現在地が違うので、自動では開かない**
    // (`ADR-0364` 限定5 の後半)。**案内そのものは出る**(消していない)。
    release();
    await settle();
    expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/notice-list`);
    expect(screen.queryByTestId("customer-signup-next")).not.toBeNull();
  });
});

/**
 * `V10-M19-T03`: **開く前に確かめる** —— **(a) 書けない候補を同期の述語で落とし、
 * (b) 読取が 403 を返す候補を `V10-M19-T02` と同じ1回の読取で落とす**
 * (`FU-G8` / `ADR-0365`。実装は `web/src/auth/signup-next.ts` の `useSignupNextCandidates`)。
 *
 * ## 【この検査が測っていないこと。先に書く】
 *
 * - **確かめた時点と開いた時点のずれを1件も測っていない。** **1回聞いた直後に役割の規則が
 *   変われば、開いた先は今日どおり 403 になる**(`ADR-0365` §S3 の 4)。
 * - **ログイン済みの経路を1バイトも測っていない。** **直したのは登録直後の経路だけであり、
 *   `SelectedView` には可視性の門が今日も1つも無い**(同 1)。
 * - **表示層とサーバで判定に渡す引数が違うことを1件も測っていない**(表示層は役割の文字列1つ、
 *   サーバは実効ロール集合。同 3)。 **ここで描いているのは fetch のスタブであり、
 *   サーバの判定は1バイトも通っていない。**
 * - **ブラウザでは1度も動かしていない**(happy-dom)。
 */
describe("登録の直後、開く前に確かめる(V10-M19-T03 / FU-G8)", () => {
  test("i-1: その表へ作成を書く操作起点を読めない立場では、候補から落ちる(案内にも出ず、自動でも開かない)", async () => {
    anonymousStub(manifestWithCreateAction(["owner"]));
    render(<App />);
    await signUp();

    await settle();
    expect(screen.queryAllByTestId("customer-signup-next").length).toBe(0);
    expect(window.location.pathname).toBe(`/apps/${APP_ID}`);
  });

  test("i-2: 同じ操作起点が自分にも許されていれば、今日どおり候補に残る(対照)", async () => {
    anonymousStub(manifestWithCreateAction(["owner", "customer"]));
    render(<App />);
    await signUp();

    await waitFor(() => {
      expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/member-form`);
    });
    expect(screen.queryByTestId("customer-signup-next")).not.toBeNull();
  });

  test("i-3: 書込の関門で0本になったら、案内も閉じるボタンも1つも出ない", async () => {
    anonymousStub(manifestWithCreateAction(["owner"]));
    render(<App />);
    await signUp();

    await settle();
    expect(screen.queryAllByTestId("customer-signup-next").length).toBe(0);
    expect(screen.queryAllByTestId("customer-signup-next-dismiss").length).toBe(0);
    expect(window.location.pathname).toBe(`/apps/${APP_ID}`);
  });

  test("i-4: 読取が 403 を返す候補は落ちる(案内にも出ず、自動でも開かない)", async () => {
    anonymousStubWithForbiddenRead(manifestWithOneCandidate());
    render(<App />);
    await signUp();

    await settle();
    expect(screen.queryAllByTestId("customer-signup-next").length).toBe(0);
    expect(window.location.pathname).toBe(`/apps/${APP_ID}`);
  });

  test("i-5: 403 以外の失敗(500)では落ちない(対照。`h-5` と同じ向きを `FU-G8` の側からも固定する)", async () => {
    anonymousStubWithReadFailure(manifestWithOneCandidate());
    render(<App />);
    await signUp();

    await waitFor(() => {
      expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/member-form`);
    });
    expect(screen.queryByTestId("customer-signup-next")).not.toBeNull();
  });
});
