/**
 * `V10-M6-T01b`: **配る版でも、登録の直後に候補がちょうど1本なら、その画面が自動で開く**
 * (`web/src/runner-app.tsx` の `SingleApp` から `useSignupAutoOpen` を呼ぶ)。
 *
 * ## 【この検査が測っていないこと。先に書く】
 *
 * - **配る版に案内は1バイトも足していない。** 本ファイルの `g-2` が測るのは
 *   「**今日どおり案内が1つも描かれない**」ことであって、案内が出ることではない。
 *   **これはユーザの選択である**(「配る版は自動で開くだけ」)。
 * - **ビルド成果物を1バイトも見ていない。** ここで描くのはソースの部品であり、
 *   配布物のバイト列を測るのは `web/test/runner-entry-boundary.test.ts` の担当である。
 * - **ブラウザでは1度も動かしていない。** 描いているのは happy-dom である。
 * - **候補が0本のときを測っていない**(`g-3` が測るのは2本のときだけである)。
 *   0本の経路は育成用の版と同じ述語を通るので、`web/test/signup-auto-open.test.tsx` の
 *   `c-1` が測っている —— **ただしそれは配る版のファイルを1バイトも通っていない。**
 *
 * ## 【2026-08-22 訂正(`V10-M19-T01` / `FU-G6` / `ADR-0363`)。旧文を1バイトも消していない】
 *
 * **すぐ上の3つのうち、2つは今日は偽である。**
 *
 * - **配る版にも案内を描く。** **案内の実装は `web/src/auth/SignupNextNotice.tsx` の1本で、
 *   育成用の版(`web/src/AppWorkspace.tsx`)と配る版(`web/src/runner-app.tsx`)が
 *   同じ1本を呼ぶ。** **選び直したのはユーザ決定 `D-V10-17` である**(`ADR-0363`)。
 * - **`g-2` は消していない。向きを反転させた検査へ置き換えた** ——
 *   **旧の名前の逐語は「`g-2: 配る版には案内が1つも描かれない(今日どおり)`」である。**
 * - **候補が0本のときは `g-5` が測る**(**配る版のファイルを通って** 案内が0件であること)。
 * - **候補が2本のときの案内の見え方は `g-4` が測る。**
 * - **登録ではなくログインしただけのときに案内が出ないことは `g-6` が測る**
 *   (**実装の途中で実際に赤くなった検査である。**上の `web/src/runner-app.tsx` の
 *   `signupNextForms` は「登録の直後か」を見ていない)。
 * - **ブラウザで1度も動かしていないのは今日も同じである**(そちらは
 *   `web/e2e/runner-flow.e2e.ts` の担当)。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Manifest } from "../../src/kernel/types.ts";
import { RunnerShell } from "../src/runner-app.tsx";
import { actionRead, grantRules, viewRead } from "./role-rules.ts";

const APP_ID = "shop-app";

/** 題材の下ごしらえ。**`web/test/signup-auto-open.test.tsx` と同じ形である。** */
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
 * **候補が0本**(`st_owner` を宣言した表の `form` が1本も無い)。
 *
 * **「読める画面が1枚も無い」ではない** —— **`notice-list` は読める。**
 * **候補だけが0本である局面を作る**(`web/test/customer-signup-next.test.tsx` の
 * `manifestWithoutMemberForm` と同じ作り方)。
 */
function manifestWithZeroCandidates(): Manifest {
  const built = baseManifest();
  built.app.tables = built.app.tables.filter((table) => table.id !== "member");
  built.app.views = built.app.views.filter((view) => view.id !== "member-form");
  return grantRules(built, ["customer"], [viewRead("notice-list")]);
}

/**
 * **候補が2本。ただし表が別々である**(`member` と `address`)。
 * **`FU-G7b` は表ごとに1回読むので、片方だけに行を置くにはこの形が要る。**
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

/**
 * **候補になりうる画面は在るが、その表へ「作成」を書く名前つきの操作起点が1本在る**題材
 * (`V10-M19-T03` / `FU-G8` / `ADR-0365`)。
 * **`web/test/signup-auto-open.test.tsx` の同名の関数と同じ形をもう一度書いている**
 * (複製しているものに数える)。**足しているのは題材の側の宣言だけである。**
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
 * **【`V10-M19-T02` で切り出した。既存の検査は1本も消していない】**
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
  // **【`V10-M19-T01`】ログイン(登録ではない)の口。`g-6` が使う。**
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
 * (`V10-M19-T03` / `FU-G8`)。 **落とす判断に使うのは応答コードだけである。**
 */
function anonymousStubWithForbiddenRead(manifest: Manifest): void {
  anonymousStubWith(manifest, () =>
    jsonResponse({ errors: [{ path: "", message: "閉められています。" }] }, 403),
  );
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

describe("配る版でも、登録の直後に候補が1本なら自動で開く(V10-M6-T01b / NV-G14)", () => {
  test("g-1: 候補がちょうど1本なら、その画面の URL になる", async () => {
    anonymousStub(manifestWithOneCandidate());
    render(<RunnerShell appId={APP_ID} />);
    await signUp();

    await waitFor(() => {
      expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/member-form`);
    });
  });

  /**
   * **【`V10-M19-T01` / `FU-G6` / `ADR-0363`】向きを反転させた。**
   * **旧の名前の逐語**: 「**g-2: 配る版には案内が1つも描かれない(今日どおり)**」。
   * **旧の期待値の逐語**: `expect(screen.queryByTestId("customer-signup-next")).toBeNull();`
   */
  test("g-2: 配る版にも案内が1つ描かれる(候補が1本のとき)", async () => {
    anonymousStub(manifestWithOneCandidate());
    render(<RunnerShell appId={APP_ID} />);
    await signUp();

    await waitFor(() => {
      expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/member-form`);
    });
    const notice = await screen.findByTestId("customer-signup-next");
    // **文面は育成用の版と同じ1本である**(`web/src/auth/SignupNextNotice.tsx`)。
    // **1文字も新しく作っていない**(`ADR-0363` 限定2)。
    expect(notice.textContent).toContain("登録が終わりました。");
    expect(notice.textContent).toContain("会員情報の登録");

    // **閉じられる** —— **`onDismiss` が配る版でも結線されている。**
    fireEvent.click(screen.getByTestId("customer-signup-next-dismiss"));
    await waitFor(() => {
      expect(screen.queryByTestId("customer-signup-next")).toBeNull();
    });
  });

  test("g-3: 候補が2本なら、パスは1文字も変わらない", async () => {
    anonymousStub(manifestWithTwoCandidates());
    render(<RunnerShell appId={APP_ID} />);
    await signUp();

    await settle();
    expect(window.location.pathname).toBe(`/apps/${APP_ID}`);
  });

  test("g-4: 候補が2本でも、配る版に案内が1つ描かれる(導線は2本)", async () => {
    anonymousStub(manifestWithTwoCandidates());
    render(<RunnerShell appId={APP_ID} />);
    await signUp();

    const notice = await screen.findByTestId("customer-signup-next");
    expect(notice.querySelectorAll("a").length).toBe(2);
    // **自動では開かない** —— **2本以上のときの規約を1ミリも動かしていない。**
    await settle();
    expect(window.location.pathname).toBe(`/apps/${APP_ID}`);
  });

  /**
   * **【この検査は実装の途中で赤くなった。だから残す】**
   *
   * **配る版の `signupNextForms` は「登録の直後か」を1ミリも見ていない**
   * (見張りの側が判定を持っているため)。**そのまま案内に渡す最初の実装では、
   * ただログインしただけでも案内が出続けた。** **本検査がそれを掴んだ。**
   */
  test("g-6: ログイン(登録ではない)では、配る版に案内が1つも描かれない", async () => {
    anonymousStub(manifestWithOneCandidate());
    render(<RunnerShell appId={APP_ID} />);
    await screen.findByTestId("password-login");
    fireEvent.change(screen.getByTestId("auth-username"), { target: { value: "kaimono" } });
    fireEvent.change(screen.getByTestId("auth-password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByTestId("password-login"));

    await settle();
    expect(screen.queryByTestId("customer-signup-next")).toBeNull();
    // **自動でも開かない**(登録の直後ではないため)。
    expect(window.location.pathname).toBe(`/apps/${APP_ID}`);
  });

  test("g-5: 候補が0本なら、配る版に案内が1つも描かれない", async () => {
    anonymousStub(manifestWithZeroCandidates());
    render(<RunnerShell appId={APP_ID} />);
    await signUp();

    await settle();
    // **読める画面はある**(「壊れている」局面ではない)。
    expect(screen.queryByTestId("view-list-empty")).toBeNull();
    expect(screen.queryByTestId("customer-signup-next")).toBeNull();
    expect(screen.queryByTestId("customer-signup-next-dismiss")).toBeNull();
  });
});

/**
 * `V10-M19-T02`: **配る版でも、見える範囲に行がある候補を落とす**
 * (`FU-G7b` / `ADR-0364`)。
 *
 * ## 【この検査が測っていないこと。先に書く】
 *
 * - **偽陰性も偽陽性も1件も測っていない**(`web/test/signup-auto-open.test.tsx` の
 *   同名の節に書いた理由と同じである。スタブは「誰の行か」を1つも持たない)。
 * - **ブラウザでは1度も動かしていない**(happy-dom)。
 * - **二重登録が防げることを測っていない。**
 */
describe("配る版でも、見える範囲に行がある候補を落とす(V10-M19-T02 / FU-G7b)", () => {
  test("g-7: 行が1件でも見えれば、配る版でも候補から落ちる(案内にも出ず、自動でも開かない)", async () => {
    anonymousStubWithRows(manifestWithOneCandidate(), ["member"]);
    render(<RunnerShell appId={APP_ID} />);
    await signUp();

    await settle();
    expect(screen.queryByTestId("customer-signup-next")).toBeNull();
    expect(window.location.pathname).toBe(`/apps/${APP_ID}`);
  });

  test("g-8: 候補2本のうち片方だけに行が在れば、配る版でも残る1本で自動オープンが起きる", async () => {
    anonymousStubWithRows(manifestWithTwoTables(), ["address"]);
    render(<RunnerShell appId={APP_ID} />);
    await signUp();

    await waitFor(() => {
      expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/member-form`);
    });
    const notice = await screen.findByTestId("customer-signup-next");
    expect(notice.querySelectorAll("a").length).toBe(1);
  });

  test("g-9: 読取が失敗したときは落ちない(配る版でも開いた側に倒す)", async () => {
    anonymousStubWithReadFailure(manifestWithOneCandidate());
    render(<RunnerShell appId={APP_ID} />);
    await signUp();

    await waitFor(() => {
      expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/member-form`);
    });
    expect(screen.queryByTestId("customer-signup-next")).not.toBeNull();
  });
});

/**
 * `V10-M19-T03`: **配る版でも、開く前に確かめる**(`FU-G8` / `ADR-0365`)。
 *
 * ## 【この検査が測っていないこと。先に書く】
 *
 * - **確かめた時点と開いた時点のずれを1件も測っていない。**
 * - **ログイン済みの経路を1バイトも測っていない**(直したのは登録直後の経路だけである)。
 * - **表示層とサーバの引数の差を1件も測っていない**(スタブであり、サーバの判定は通っていない)。
 * - **ブラウザでは1度も動かしていない**(happy-dom)。
 */
describe("配る版でも、開く前に確かめる(V10-M19-T03 / FU-G8)", () => {
  test("g-10: その表へ作成を書く操作起点を読めない立場では、配る版でも候補から落ちる(案内も閉じるボタンも0件)", async () => {
    anonymousStub(manifestWithCreateAction(["owner"]));
    render(<RunnerShell appId={APP_ID} />);
    await signUp();

    await settle();
    expect(screen.queryAllByTestId("customer-signup-next").length).toBe(0);
    expect(screen.queryAllByTestId("customer-signup-next-dismiss").length).toBe(0);
    expect(window.location.pathname).toBe(`/apps/${APP_ID}`);
  });

  test("g-11: 同じ操作起点が自分にも許されていれば、配る版でも今日どおり候補に残る(対照)", async () => {
    anonymousStub(manifestWithCreateAction(["owner", "customer"]));
    render(<RunnerShell appId={APP_ID} />);
    await signUp();

    await waitFor(() => {
      expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/member-form`);
    });
    expect(screen.queryByTestId("customer-signup-next")).not.toBeNull();
  });

  test("g-12: 読取が 403 を返す候補は、配る版でも落ちる", async () => {
    anonymousStubWithForbiddenRead(manifestWithOneCandidate());
    render(<RunnerShell appId={APP_ID} />);
    await signUp();

    await settle();
    expect(screen.queryAllByTestId("customer-signup-next").length).toBe(0);
    expect(window.location.pathname).toBe(`/apps/${APP_ID}`);
  });
});
