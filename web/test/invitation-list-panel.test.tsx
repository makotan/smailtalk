/**
 * **運営者の画面に発行済みの招待が一覧で出ることの固定**(`V19-M3-T01`。台帳 `SV-G2`)。
 *
 * ## この検査が固定するもの(**先に書く**)
 *
 * 1. **一覧を取る口が、相手の一覧と一緒に招待も受け取って返す**(起票の完了条件 (a))——
 *    **着手前の受け皿は `{ users }` だけで、サーバが載せていた招待をその場で捨てていた。**
 * 2. **画面に5列が出る**(相手 / 立場 / 期限 / 発行者 / 状態。起票の完了条件 (b))。
 * 3. **状態の欄はサーバの `state` を読む**(計画の上乗せ3)——
 *    **【禁止の履行】使用の時刻の有無から状態を組み立てていない。**
 *    その証明として、**時刻が同じで `state` だけが違う2件**と、
 *    **時刻が空なのに `state` が取り消しである1件**を撃つ。
 * 4. **一覧にコードが1件も出ない**(起票の完了条件 (d) の単体側)——
 *    **サーバが一覧の応答にコードを1バイトも載せていない**ので、
 *    **画面が別経路で出していないこと**を DOM の側から数える。
 * 5. **使用済み・取り消し済みを1件も落とさない**(`ADR-0336` 限定16 / 個別限定③)——
 *    **絞り込みも「未使用だけ」の既定も持たない。**
 * 6. **招待のキーごと落ちた応答でも画面が壊れない**(サーバは持ち主でなければ
 *    `invitations` をキーごと落とす)。
 *
 * ## この検査が測らないもの(**誇張しない**)
 *
 * - **サーバが何を載せるかは1つも測っていない**(`src/server/` の検査の担当)——
 *   **本ファイルはサーバの応答を差し替えて画面の側だけを見ている。**
 * - **ブラウザで実際に撃ったことは1つも測っていない**
 *   (`web/e2e/invitation-list.e2e.ts` の担当。起票の完了条件 (c) / (d))。
 * - **出し直し / 取り消しの操作は1つも測っていない**(`V19-M3-T02` / `T03` の担当)——
 *   **本ファイルが見るのは読み取って並べるところまでである。**
 * - **コードを伏せる側は1つも測っていない**(`SV-G7b` = `V19-M3-T04` の担当)。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type AppUser, listAppUsers } from "../src/api.ts";
import { UserAdmin } from "../src/auth/UserAdmin.tsx";

const APP_ID = "sample-app";
const USERS_URL = `/api/apps/${APP_ID}/auth/users`;
const ISSUE_URL = `/api/apps/${APP_ID}/auth/invitations`;

const OWNER: AppUser = {
  id: "u1",
  username: "boss",
  displayName: null,
  role: "owner",
  createdAt: "2026-09-18T00:00:00.000Z",
};

/**
 * **サーバが一覧で返す招待の1件**(`invitationView` が返す7つのキーちょうど)。
 * **コードは1バイトも載っていない** —— 載せるのは発行の応答だけである。
 */
type ListedInvitation = {
  username: string;
  role: string;
  expiresAt: string;
  issuedBy: string;
  issuedAt: string;
  usedAt: string | null;
  state: string;
};

const UNUSED: ListedInvitation = {
  username: "newcomer",
  role: "viewer",
  expiresAt: "2026-09-19T00:00:00.000Z",
  issuedBy: "u1",
  issuedAt: "2026-09-18T00:00:00.000Z",
  usedAt: null,
  state: "unused",
};

const USED: ListedInvitation = {
  username: "joined",
  role: "editor",
  expiresAt: "2026-09-19T02:00:00.000Z",
  issuedBy: "u1",
  issuedAt: "2026-09-18T02:00:00.000Z",
  usedAt: "2026-09-18T03:00:00.000Z",
  state: "used",
};

const REVOKED: ListedInvitation = {
  username: "cancelled",
  role: "viewer",
  expiresAt: "2026-09-19T04:00:00.000Z",
  issuedBy: "u1",
  issuedAt: "2026-09-18T04:00:00.000Z",
  usedAt: "2026-09-18T05:00:00.000Z",
  state: "revoked",
};

/** 発行の応答(**コードを載せる唯一の形**)。一覧に漏れていないことを数えるために使う。 */
const ISSUED_CODE = "WXYZ6789";
const ISSUED = {
  invitation: { ...UNUSED, code: ISSUED_CODE },
  signupUrl: `http://localhost:3210/apps/${APP_ID}`,
};

/** 一覧の口が返す本文(テストごとに差し替える)。 */
let usersBody: Record<string, unknown>;
/** 一覧の口を叩いた回数(取り直しを数える)。 */
let userListCalls: number;
let originalFetch: typeof fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  usersBody = { users: [OWNER], invitations: [UNUSED, USED, REVOKED] };
  userListCalls = 0;
  originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "GET" && url === USERS_URL) {
      userListCalls += 1;
      return Promise.resolve(jsonResponse(usersBody));
    }
    if (method === "POST" && url === ISSUE_URL) {
      return Promise.resolve(jsonResponse(ISSUED));
    }
    return Promise.resolve(jsonResponse({ errors: [] }, 500));
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

/** 招待の節が描き終わるまで待つ。 */
async function renderReady(): Promise<HTMLElement> {
  render(<UserAdmin appId={APP_ID} />);
  return await screen.findByTestId("user-admin-invitations");
}

// --- (0) 一覧を取る口が招待を受け取って返す(完了条件 (a))---------------------------------

describe("(0) 一覧を取る口が招待を捨てない", () => {
  test("(0-a) `listAppUsers` は相手の一覧と招待の両方を返す", async () => {
    const list = await listAppUsers(APP_ID);
    expect(list.users.map((user) => user.username)).toEqual(["boss"]);
    expect(list.invitations?.map((invitation) => invitation.username)).toEqual([
      "newcomer",
      "joined",
      "cancelled",
    ]);
  });

  test("(0-b) 招待のキーごと落ちた応答では、招待は `undefined` で返る(空配列に化けない)", async () => {
    usersBody = { users: [OWNER] };
    const list = await listAppUsers(APP_ID);
    expect(list.users.length).toBe(1);
    expect(list.invitations).toBeUndefined();
  });

  test("(0-c) 受け取った招待の1件は、サーバが載せた7つのキーをそのまま持つ", async () => {
    const list = await listAppUsers(APP_ID);
    expect(list.invitations?.[0]).toEqual(UNUSED as never);
  });
});

// --- (1) 画面に5列が出る(完了条件 (b))---------------------------------------------------

describe("(1) 発行済みの招待が一覧で出る", () => {
  test("(1-a) 招待の表の見出しは5本である(相手 / 立場 / 期限 / 発行者 / 状態)", async () => {
    const section = await renderReady();
    const headers = within(section)
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent);
    expect(headers).toEqual(["相手", "立場", "期限", "発行者", "状態"]);
  });

  test("(1-b) 応答の3件が、応答の順序どおり3行出る", async () => {
    const section = await renderReady();
    const shown = within(section)
      .getAllByTestId("invitation-row")
      .map((row) => row.getAttribute("data-username"));
    expect(shown).toEqual(["newcomer", "joined", "cancelled"]);
  });

  test("(1-c) 使用済みも取り消し済みも1件も落ちない(絞り込みを既定に持たない)", async () => {
    const section = await renderReady();
    // **`ADR-0336` 限定16 の履行** —— 3件のうち2件は既に使われた / 取り消された行である。
    expect(within(section).getAllByTestId("invitation-row").length).toBe(3);
  });

  test("(1-d) 相手・立場・期限の欄は、応答の値をそのまま出す", async () => {
    const section = await renderReady();
    const row = within(section).getAllByTestId("invitation-row")[1] as HTMLElement;
    expect(within(row).getByTestId("invitation-row-username").textContent).toBe("joined");
    expect(within(row).getByTestId("invitation-row-expires").textContent).toBe(USED.expiresAt);
    // 立場は行のロール変更セレクトと同じ表示名の土台から引く。
    expect(within(row).getByTestId("invitation-row-role").textContent).toBe("編集者");
  });
});

// --- (2) 状態の欄はサーバの `state` を読む(計画の上乗せ3)-----------------------------------

describe("(2) 状態の欄は応答の `state` を読む", () => {
  test("(2-a) 3値がそれぞれの表示になる", async () => {
    const section = await renderReady();
    const shown = within(section)
      .getAllByTestId("invitation-row-state")
      .map((cell) => cell.textContent);
    expect(shown).toEqual(["未使用", "使用済み", "取り消し済み"]);
  });

  test("(2-b) 使用の時刻が同じでも、`state` が違えば表示が変わる", async () => {
    // **同じ時刻を持つ2件。** **時刻から状態を組み立てていたら、この2件は同じ表示になる。**
    const sameAt = "2026-09-18T03:00:00.000Z";
    usersBody = {
      users: [OWNER],
      invitations: [
        { ...USED, username: "a", usedAt: sameAt, state: "used" },
        { ...REVOKED, username: "b", usedAt: sameAt, state: "revoked" },
      ],
    };
    const section = await renderReady();
    const shown = within(section)
      .getAllByTestId("invitation-row-state")
      .map((cell) => cell.textContent);
    expect(shown).toEqual(["使用済み", "取り消し済み"]);
  });

  test("(2-c) 使用の時刻が空でも、`state` が取り消しなら取り消し済みと出る", async () => {
    // **時刻の有無だけを見ていたら「未使用」と出てしまう1件。**
    usersBody = {
      users: [OWNER],
      invitations: [{ ...UNUSED, usedAt: null, state: "revoked" }],
    };
    const section = await renderReady();
    expect(within(section).getByTestId("invitation-row-state").textContent).toBe("取り消し済み");
  });

  test("(2-d) 知らない値が来たら、受け取った値をそのまま出す(黙って別の状態に化けさせない)", async () => {
    usersBody = {
      users: [OWNER],
      invitations: [{ ...UNUSED, state: "somethingelse" }],
    };
    const section = await renderReady();
    expect(within(section).getByTestId("invitation-row-state").textContent).toBe("somethingelse");
  });
});

// --- (3) 一覧にコードが1件も出ない(完了条件 (d) の単体側)----------------------------------

describe("(3) 一覧にコードが1件も出ない", () => {
  test("(3-a) 招待の節に、コードを出す目印が1件も無い", async () => {
    const section = await renderReady();
    expect(within(section).queryAllByTestId("invite-code").length).toBe(0);
  });

  test("(3-b) 発行した直後でも、招待の節の文字列にコードが1度も現れない", async () => {
    await renderReady();
    fireEvent.change(screen.getByTestId("invite-username"), { target: { value: "newcomer" } });
    fireEvent.click(screen.getByTestId("invite-submit"));
    // 発行の結果はその場に出る(`V19-M3-T00` の節)。
    expect((await screen.findByTestId("invite-code")).textContent).toBe(ISSUED_CODE);
    // **一覧の側には1度も現れない。**
    await waitFor(() => {
      expect(screen.getByTestId("user-admin-invitations").textContent).not.toContain(ISSUED_CODE);
    });
  });
});

// --- (4) 招待のキーが無い / 空の応答 --------------------------------------------------------

describe("(4) 招待を受け取らなかったとき", () => {
  test("(4-a) キーごと落ちた応答でも画面は壊れず、相手の一覧は今日どおり出る", async () => {
    usersBody = { users: [OWNER] };
    render(<UserAdmin appId={APP_ID} />);
    await screen.findByTestId("user-row");
    expect(screen.queryByTestId("user-admin-invitations")).toBeNull();
  });

  test("(4-b) 招待が0件なら、表を出さずに一言だけ出す", async () => {
    usersBody = { users: [OWNER], invitations: [] };
    const section = await renderReady();
    expect(within(section).queryAllByTestId("invitation-row").length).toBe(0);
    expect(within(section).queryAllByRole("columnheader").length).toBe(0);
    expect(screen.getByTestId("user-admin-invitations-empty")).toBeDefined();
  });
});

// --- (5) 既存の表を1バイトも動かしていない -------------------------------------------------

describe("(5) 既存の一覧を壊さない", () => {
  test("(5-a) 相手の表の見出しは着手前と同じ4本のままである", async () => {
    await renderReady();
    const userTable = screen.getAllByTestId("user-row")[0]?.closest("table") as HTMLElement;
    const headers = within(userTable)
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent);
    expect(headers).toEqual(["ユーザ名", "表示名", "ロール", "利用者ID"]);
  });

  test("(5-b) 行を指す目印の個数は利用者の人数のままである(添字で行を指す検査を壊さない)", async () => {
    await renderReady();
    expect(screen.getAllByTestId("role-select").length).toBe(1);
  });
});

// --- (6) 発行のあと、一覧が取り直される ----------------------------------------------------

describe("(6) 発行した相手が一覧に出る", () => {
  test("(6-a) 発行に成功すると一覧を取り直し、発行した相手の行が出る", async () => {
    usersBody = { users: [OWNER], invitations: [] };
    await renderReady();
    expect(userListCalls).toBe(1);

    // サーバ側は発行で1件増えた状態になる。
    usersBody = { users: [OWNER], invitations: [UNUSED] };
    fireEvent.change(screen.getByTestId("invite-username"), { target: { value: "newcomer" } });
    fireEvent.click(screen.getByTestId("invite-submit"));

    await waitFor(() => {
      const rows = within(screen.getByTestId("user-admin-invitations")).getAllByTestId(
        "invitation-row",
      );
      expect(rows.map((row) => row.getAttribute("data-username"))).toEqual(["newcomer"]);
    });
    expect(userListCalls).toBe(2);
  });
});

// --- (7) 発行者の欄 -------------------------------------------------------------------------

describe("(7) 発行者の欄", () => {
  test("(7-a) 手元の一覧に居る人なら、その人の名前で出る", async () => {
    const section = await renderReady();
    const row = within(section).getAllByTestId("invitation-row")[0] as HTMLElement;
    expect(within(row).getByTestId("invitation-row-issuer").textContent).toBe("boss");
  });

  test("(7-b) 手元の一覧に居なければ、受け取った値をそのまま出す(名前を発明しない)", async () => {
    usersBody = {
      users: [OWNER],
      invitations: [{ ...UNUSED, issuedBy: "u-gone" }],
    };
    const section = await renderReady();
    expect(within(section).getByTestId("invitation-row-issuer").textContent).toBe("u-gone");
  });
});
