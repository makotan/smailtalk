/**
 * **招待の行から「出し直し」と「取り消し」を撃てることの固定**(`V19-M3-T02`。台帳 `SV-G3` / `SV-G4`)。
 *
 * ## この検査が固定するもの(**先に書く**。起票の完了条件 (d))
 *
 * 1. **2操作の口が画面に在る** —— **着手前、招待の一覧は読むだけで、押せるものが1つも
 *    無かった**(`web/test/invitation-list-panel.test.tsx` の「測らないもの」が自分で
 *    そう書いている)。
 * 2. **叩く口は着手前から在る1本だけである**(`POST /api/apps/:app_id/auth/invitations`)——
 *    **出し直しは `{ username, role }` の再送、取り消しは同じ口への `{ username, revoke: true }`。**
 *    **`DELETE` のルートを1本も足していない**(個別限定・取り消し①)。
 * 3. **取り消しの口は「未使用」の行にだけ出る**(`H-V19-5` を踏まない設計。計画 `§9-B-6` /
 *    メインの裁定)—— **使用済み・取り消し済みに取り消しを掛けるとサーバは `200` を返すのに
 *    何も書かない。** **押せるようにすると画面が「取り消しました」と嘘をつく。**
 *    **【禁止の履行】行そのものは1行も隠していない**(`ADR-0336` 限定16)。**隠すのはボタンだけ。**
 * 4. **出し直しの口は「使用済み」以外の行に出る** —— **取り消し済みの行から出し直せる**
 *    (これが `H-V19-1` / 罠23 の経路そのものである。**塞がずに出す**)。
 * 5. **新しいコードは発行の結果欄に出る**(`invite-result` / `invite-code`)——
 *    **一覧の行には1文字も出さない**(`ADR-0452` ⑮ の「コードの提供先は1箇所」)。
 * 6. **失敗はサーバの文面をそのまま出す** —— **画面で文面を作り直さない。**
 *
 * ## この検査が測らないもの(**誇張しない**)
 *
 * - **サーバが何を書くかは1つも測っていない** —— **本ファイルは応答を差し替えて画面の側
 *   だけを見ている。** **サーバ側の担保は `src/server/invitation-issuance.test.ts` である
 *   (本段はそこに1本も足していない)。**
 * - **ブラウザで実際に撃ったことは1つも測っていない**(`web/e2e/invitation-actions.e2e.ts`
 *   の担当。起票の完了条件 (a) / (b))。
 * - **誰が出し直せるか / 取り消せるかを1ミリも決めていない。** **決めるのはサーバの
 *   `requireOwner` である。** **【禁止】「画面に出さないこと」を制限の担保にしない。**
 * - **押し間違いを止める確認は1つも無い** —— **取り消すボタンは押した瞬間に送る。**
 *   **戻す手段は出し直しである**(行は消えないので戻せるが、**そのとき取り消した事実は消える**)。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AppUser } from "../src/api.ts";
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

/** 一覧の応答が載せる招待の1件(`invitationView` が返す7つのキーちょうど)。 */
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
  usedAt: "revoked:2026-09-18T05:00:00.000Z",
  state: "revoked",
};

/** 出し直しの応答(**コードを載せる唯一の形**)。 */
const REISSUED_CODE = "NEWCODE9";
const REISSUED = {
  invitation: { ...UNUSED, code: REISSUED_CODE },
  signupUrl: `http://localhost:3210/apps/${APP_ID}`,
};

/** 一覧の口が返す本文(テストごとに差し替える)。 */
let usersBody: Record<string, unknown>;
/** 一覧の口を叩いた回数(取り直しを数える)。 */
let userListCalls: number;
/** 招待の口に送られたもの(**メソッドと URL と本文**)。 */
let posted: { method: string; url: string; body: unknown }[];
/** 招待の口が返すもの(テストごとに差し替える)。 */
let issueResponse: [number, unknown];
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
  posted = [];
  issueResponse = [200, REISSUED];
  originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "GET" && url === USERS_URL) {
      userListCalls += 1;
      return Promise.resolve(jsonResponse(usersBody));
    }
    if (url === ISSUE_URL) {
      posted.push({
        method,
        url,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return Promise.resolve(jsonResponse(issueResponse[1], issueResponse[0]));
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

/** その相手の行を引く(**添字で指さない** —— 並びが変わったときに黙って別の行を指すため)。 */
function rowOf(section: HTMLElement, username: string): HTMLElement {
  const row = within(section)
    .getAllByTestId("invitation-row")
    .find((candidate) => candidate.getAttribute("data-username") === username);
  if (row === undefined) {
    throw new Error(`行が見つからない: ${username}`);
  }
  return row;
}

// --- (1) 出し直しの口(`SV-G3`)-------------------------------------------------------------

describe("(1) 出し直しの口が行に在る", () => {
  test("(1-a) 未使用の行に「出し直す」のボタンが在る", async () => {
    const section = await renderReady();
    const button = within(rowOf(section, "newcomer")).getByTestId("invitation-row-reissue");
    expect(button.textContent).toBe("出し直す");
  });

  test("(1-b) 取り消し済みの行にも「出し直す」が在る(罠23 の経路を塞がない)", async () => {
    const section = await renderReady();
    expect(
      within(rowOf(section, "cancelled")).queryAllByTestId("invitation-row-reissue").length,
    ).toBe(1);
  });

  test("(1-c) 使用済みの行には「出し直す」が無い(登録済みの相手に死んだコードを配らない)", async () => {
    const section = await renderReady();
    expect(within(rowOf(section, "joined")).queryAllByTestId("invitation-row-reissue").length).toBe(
      0,
    );
  });

  test("(1-d) 押すと、着手前から在る口に `{ username, role }` が POST される(行の立場をそのまま送る)", async () => {
    const section = await renderReady();
    fireEvent.click(within(rowOf(section, "cancelled")).getByTestId("invitation-row-reissue"));
    await waitFor(() => {
      expect(posted.length).toBe(1);
    });
    expect(posted[0]?.method).toBe("POST");
    expect(posted[0]?.url).toBe(ISSUE_URL);
    // **期限のキーも `revoke` も1つも乗せない**(サーバは未知のキーを 400 で拒む)。
    expect(posted[0]?.body).toEqual({ username: "cancelled", role: "viewer" });
  });

  test("(1-e) 成功すると、新しいコードが発行の結果欄にそのまま出る", async () => {
    const section = await renderReady();
    fireEvent.click(within(rowOf(section, "newcomer")).getByTestId("invitation-row-reissue"));
    expect((await screen.findByTestId("invite-code")).textContent).toBe(REISSUED_CODE);
  });

  test("(1-f) 成功すると一覧を取り直す(出し直した結果が画面に反映される)", async () => {
    await renderReady();
    expect(userListCalls).toBe(1);
    // サーバ側では取り消しが消えて未使用に戻る(**罠23 / `H-V19-1` そのもの**)。
    usersBody = {
      users: [OWNER],
      invitations: [UNUSED, USED, { ...REVOKED, usedAt: null, state: "unused" }],
    };
    fireEvent.click(
      within(rowOf(screen.getByTestId("user-admin-invitations"), "cancelled")).getByTestId(
        "invitation-row-reissue",
      ),
    );
    await waitFor(() => {
      expect(userListCalls).toBe(2);
    });
    await waitFor(() => {
      const row = rowOf(screen.getByTestId("user-admin-invitations"), "cancelled");
      expect(within(row).getByTestId("invitation-row-state").textContent).toBe("未使用");
    });
  });

  test("(1-g) 拒まれたら、サーバの文面がそのまま出てコードは1文字も出ない", async () => {
    issueResponse = [400, { errors: [{ path: "/username", message: "そんな相手はいません。" }] }];
    const section = await renderReady();
    fireEvent.click(within(rowOf(section, "newcomer")).getByTestId("invitation-row-reissue"));
    const shown = await screen.findByTestId("invitation-action-error");
    expect(shown.textContent).toContain("そんな相手はいません。");
    expect(screen.queryByTestId("invite-code")).toBeNull();
  });
});

// --- (2) 取り消しの口(`SV-G4`)-------------------------------------------------------------

describe("(2) 取り消しの口が行に在る", () => {
  test("(2-a) 未使用の行に「取り消す」のボタンが在る", async () => {
    const section = await renderReady();
    const button = within(rowOf(section, "newcomer")).getByTestId("invitation-row-revoke");
    expect(button.textContent).toBe("取り消す");
  });

  test("(2-b) 使用済み・取り消し済みの行には「取り消す」が無い(`H-V19-5` を踏まない)", async () => {
    const section = await renderReady();
    expect(within(rowOf(section, "joined")).queryAllByTestId("invitation-row-revoke").length).toBe(
      0,
    );
    expect(
      within(rowOf(section, "cancelled")).queryAllByTestId("invitation-row-revoke").length,
    ).toBe(0);
    // **【禁止の履行】行そのものは1行も落としていない。**
    expect(within(section).getAllByTestId("invitation-row").length).toBe(3);
  });

  test("(2-c) 押すと、同じ口に `{ username, revoke: true }` が POST される(`DELETE` を使わない)", async () => {
    issueResponse = [200, {}];
    const section = await renderReady();
    fireEvent.click(within(rowOf(section, "newcomer")).getByTestId("invitation-row-revoke"));
    await waitFor(() => {
      expect(posted.length).toBe(1);
    });
    expect(posted[0]?.method).toBe("POST");
    expect(posted[0]?.url).toBe(ISSUE_URL);
    expect(posted[0]?.body).toEqual({ username: "newcomer", revoke: true });
  });

  test("(2-d) 成功すると一覧を取り直し、その行の状態が「取り消し済み」になる", async () => {
    issueResponse = [200, {}];
    await renderReady();
    expect(userListCalls).toBe(1);
    usersBody = {
      users: [OWNER],
      invitations: [
        { ...UNUSED, usedAt: "revoked:2026-09-18T06:00:00.000Z", state: "revoked" },
        USED,
        REVOKED,
      ],
    };
    fireEvent.click(
      within(rowOf(screen.getByTestId("user-admin-invitations"), "newcomer")).getByTestId(
        "invitation-row-revoke",
      ),
    );
    await waitFor(() => {
      expect(userListCalls).toBe(2);
    });
    await waitFor(() => {
      const row = rowOf(screen.getByTestId("user-admin-invitations"), "newcomer");
      expect(within(row).getByTestId("invitation-row-state").textContent).toBe("取り消し済み");
    });
  });

  test("(2-e) 拒まれたら、サーバの文面がそのまま出る", async () => {
    issueResponse = [404, { errors: [{ path: "", message: "招待が見つかりません。" }] }];
    const section = await renderReady();
    fireEvent.click(within(rowOf(section, "newcomer")).getByTestId("invitation-row-revoke"));
    const shown = await screen.findByTestId("invitation-action-error");
    expect(shown.textContent).toContain("招待が見つかりません。");
  });

  test("(2-f) 取り消しは発行の結果欄に1文字も書かない(コードの出どころを増やさない)", async () => {
    issueResponse = [200, {}];
    const section = await renderReady();
    fireEvent.click(within(rowOf(section, "newcomer")).getByTestId("invitation-row-revoke"));
    await waitFor(() => {
      expect(posted.length).toBe(1);
    });
    expect(screen.queryByTestId("invite-code")).toBeNull();
    expect(screen.queryByTestId("invite-result")).toBeNull();
  });
});

// --- (3) 着手前の形を1バイトも動かしていない -----------------------------------------------

describe("(3) 既存の一覧を壊さない", () => {
  test("(3-a) 招待の表の見出しは着手前と同じ5本のままである(列を1本も足していない)", async () => {
    const section = await renderReady();
    const headers = within(section)
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent);
    expect(headers).toEqual(["相手", "立場", "期限", "発行者", "状態"]);
  });

  test("(3-b) `role-select` の個数は利用者の人数のままである(立場のプルダウンを足していない)", async () => {
    await renderReady();
    expect(screen.getAllByTestId("role-select").length).toBe(1);
  });

  test("(3-c) 状態の欄の文字列に、ボタンの文字が1文字も混ざらない", async () => {
    const section = await renderReady();
    const shown = within(section)
      .getAllByTestId("invitation-row-state")
      .map((cell) => cell.textContent);
    expect(shown).toEqual(["未使用", "使用済み", "取り消し済み"]);
  });

  test("(3-d) 出し直した直後でも、一覧の中にコードが1文字も現れない", async () => {
    const section = await renderReady();
    fireEvent.click(within(rowOf(section, "newcomer")).getByTestId("invitation-row-reissue"));
    expect((await screen.findByTestId("invite-code")).textContent).toBe(REISSUED_CODE);
    await waitFor(() => {
      expect(screen.getByTestId("user-admin-invitations").textContent).not.toContain(REISSUED_CODE);
    });
  });
});
