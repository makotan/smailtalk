/**
 * `V13-M1-T02`(`UM-G2`): **名簿の `account` 欄を「利用者を選ぶプルダウン」にする。**
 *
 * ## なぜ要るか(利用者から見て何が起きるか)
 *
 * 着手前は、名簿の表に人を1行足すとき、`account` 欄に**利用者ID**(`tM4nU3qS…` のような
 * 英数字)を手で書き写す必要があった。**その値は画面のどこにも出ていなかった**ので、
 * ログイン名(`user1`)を書いてしまい、**その人には一覧が全部0件になる**、という事故が
 * 実際に起きた。**この工程はその欄を利用者の一覧から選ぶプルダウンにして、
 * 書き写しを不要にする。**
 *
 * ## このファイルが固定すること
 *
 * | # | 条件 |
 * |---|---|
 * | (1) | `accountFieldFor` が**マニフェストの宣言だけ**から `account` 欄を解く |
 * | (2) | 一覧が読めるとき、`account` 欄が `<select>` になり、**保存される値は利用者ID**である |
 * | (3) | 一覧が**読めない**とき、`account` 欄は**今日どおりの `<input type="text">`** である |
 * | (4) | 現在値がどの利用者にも一致しないとき、**その値が残り、黙って変わらない** |
 * | (5) | 同じフォームの**他の `text` 項目は `<input type="text">` のまま**である |
 * | (6) | `data-testid` / `id` / `aria-required` が、プルダウンになっても今日と同じである |
 * | (7) | **名簿でない表のフォームでは、利用者の一覧を1度も読まない** |
 *
 * ## このファイルが証明しないこと(先に書く。誇張しない)
 *
 * 1. **本物の SQLite で1件も測っていない。** `fetch` を差し替えた表示層の検査である。
 * 2. **語彙を1つも増やしていない**ことは別の検査(`schemas/` と差分操作の側)が持つ ——
 *    ここが使うのは**既にマニフェストが書いている `access_control.members` の宣言だけ**である。
 * 3. **書き込んだ値が本当に一覧の絞り込みに効くこと**を1件も測っていない
 *    (それはサーバ側の担当である)。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { FormView, Manifest, ResourceId, Table } from "../../src/kernel/types.ts";
import type { AppUser, Role } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { accountFieldFor, userAccountLabel } from "../src/fields/user-account.ts";
import { FormRenderer } from "../src/views/FormRenderer.tsx";

/** 書ける立場(文字列リテラルを `role=` に直接書くと biome の a11y 規則に当たる)。 */
const WRITER_ROLE: Role = "owner";

const APP_ID = "roster-app";

const PERMISSIONS = [
  { id: "reader", name: "読める", read: true, write: false, delete: false },
  { id: "keeper", name: "任せる", read: true, write: true, delete: true },
];

/**
 * 名簿(`app_member`)を `access_control.members` で名指ししているアプリ。
 *
 * **`members.account` が指す `account` こそが、本工程でプルダウンになる欄である。**
 */
function rosterManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "名簿のあるアプリ",
      tables: [
        {
          id: "projects",
          name: "案件",
          fields: [{ id: "title", name: "名前", type: "text", required: true }],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "keeper",
            grant: {
              table: "project_grant",
              target: "project",
              member: "member",
              permission: "permission",
            },
            members: { table: "app_member", account: "account" },
          },
        },
        {
          id: "app_member",
          name: "名簿",
          fields: [
            { id: "account", name: "利用者", type: "text", required: true },
            { id: "memo", name: "覚書", type: "text" },
          ],
          representative_field: "account",
        },
        {
          id: "project_grant",
          name: "案件の付与",
          fields: [
            { id: "project", name: "対象", type: "reference", reference_table: "projects" },
            { id: "member", name: "相手", type: "reference", reference_table: "app_member" },
            { id: "permission", name: "権限", type: "select", options: ["reader", "keeper"] },
          ],
        },
        // **アクセス権管理を1バイトも宣言していない表**((7) が使う)。
        {
          id: "notes",
          name: "覚書",
          fields: [
            { id: "body", name: "本文", type: "text" },
            { id: "account", name: "書いた人", type: "text" },
          ],
        },
      ],
      views: [
        { id: "member-form", type: "form", table: "app_member", fields: ["account", "memo"] },
        { id: "note-form", type: "form", table: "notes", fields: ["body", "account"] },
      ],
      workflows: [],
    },
  } as unknown as Manifest;
}

/** 名簿の表を1つ取り出す(fixture を壊す検査で使う)。 */
function tableOf(manifest: Manifest, tableId: ResourceId): Table {
  const table = manifest.app.tables.find((candidate) => candidate.id === tableId);
  if (table === undefined) {
    throw new Error(`fixture broken: ${tableId} がない`);
  }
  return table;
}

/** 宣言を持っている表(`projects`)の `access_control`。 */
function declarationOf(manifest: Manifest) {
  const declared = tableOf(manifest, "projects").access_control;
  if (declared === undefined) {
    throw new Error("fixture broken: 宣言がない");
  }
  return declared;
}

const USER1: AppUser = {
  id: "tM4nU3qS",
  username: "user1",
  displayName: "山田 太郎",
  role: "editor",
  createdAt: "2026-09-01T00:00:00.000Z",
};
const USER2: AppUser = {
  id: "zK9pL2wD",
  username: "user2",
  displayName: null,
  role: "viewer",
  createdAt: "2026-09-02T00:00:00.000Z",
};
const USER3: AppUser = {
  id: "aB1cD2eF",
  username: "boss",
  displayName: "",
  role: "owner",
  createdAt: "2026-09-03T00:00:00.000Z",
};
const USERS: AppUser[] = [USER1, USER2, USER3];

// ---------------------------------------------------------------------------
// fetch の差し替え(`reference-candidate-permission.test.tsx` と同じ作法)
// ---------------------------------------------------------------------------

let originalFetch: typeof fetch;
let requests: string[] = [];
/** 利用者の一覧をどう返すか。`"ok"` 以外は「読めない」。 */
let usersMode: "ok" | "forbidden" | "network" = "ok";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 利用者の一覧を読みに行った回数。 */
function userListCalls(): number {
  return requests.filter((entry) => entry.includes("/auth/users")).length;
}

beforeEach(() => {
  requests = [];
  usersMode = "ok";
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    requests.push(`${method} ${raw}`);
    const url = new URL(raw, "http://localhost");
    if (method === "GET" && url.pathname.endsWith("/auth/users")) {
      if (usersMode === "network") {
        throw new TypeError("Failed to fetch");
      }
      if (usersMode === "forbidden") {
        return jsonResponse({ errors: [{ path: "", message: "owner だけが読めます" }] }, 403);
      }
      return jsonResponse({ users: USERS });
    }
    const single = url.pathname.match(/\/tables\/([^/]+)\/records\/([^/]+)$/);
    if (method === "GET" && single !== null) {
      return jsonResponse({
        record: {
          _id: single[2],
          // **どの利用者IDにも一致しない値**((4) が使う。事故の実物はログイン名だった)。
          account: "user1",
          memo: "書き写しの事故が起きた行",
          _updated_at: "2026-09-04T00:00:00.000Z",
        },
      });
    }
    const list = url.pathname.match(/\/tables\/([^/]+)\/records$/);
    if (method === "GET" && list !== null) {
      return jsonResponse({ records: [], total: 0 });
    }
    return jsonResponse({ errors: [{ path: "", message: `no stub for ${method} ${raw}` }] }, 404);
  }) as typeof fetch;
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/member-form`);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function viewOf(manifest: Manifest, viewId: string): FormView {
  const view = manifest.app.views.find((candidate) => candidate.id === viewId);
  if (view === undefined || view.type !== "form") {
    throw new Error(`fixture broken: ${viewId} がない`);
  }
  return view;
}

function renderForm(viewId: string, manifest: Manifest = rosterManifest(), recordId?: string) {
  return render(
    <RoleProvider role={WRITER_ROLE}>
      <FormRenderer
        appId={APP_ID}
        manifest={manifest}
        view={viewOf(manifest, viewId)}
        recordId={recordId}
      />
    </RoleProvider>,
  );
}

/** `account` 欄の DOM(型は問わない)。 */
function accountInput(): HTMLElement {
  return screen.getByTestId("field-input-account");
}

// ---------------------------------------------------------------------------
// (1) 宣言だけから `account` 欄を解く
// ---------------------------------------------------------------------------

describe("(1) `accountFieldFor` はマニフェストの宣言だけから解く", () => {
  test("名簿の表のフォームでは、`members.account` が名指しする項目IDを返す", () => {
    expect(accountFieldFor(rosterManifest(), "app_member")).toBe("account");
  });

  test("`enabled` が偽なら `undefined`(今日どおりのテキスト欄に倒す)", () => {
    const manifest = rosterManifest();
    declarationOf(manifest).enabled = false;
    expect(accountFieldFor(manifest, "app_member")).toBeUndefined();
  });

  test("`members` を書いていなければ `undefined`", () => {
    const manifest = rosterManifest();
    delete declarationOf(manifest).members;
    expect(accountFieldFor(manifest, "app_member")).toBeUndefined();
  });

  test("名指しの項目が名簿の表に実在しなければ `undefined`", () => {
    const manifest = rosterManifest();
    const members = declarationOf(manifest).members;
    if (members === undefined) {
      throw new Error("fixture broken");
    }
    members.account = "no_such_field";
    expect(accountFieldFor(manifest, "app_member")).toBeUndefined();
  });

  test("名指しの項目が `text` でなければ `undefined`", () => {
    const manifest = rosterManifest();
    const field = tableOf(manifest, "app_member").fields.find(
      (candidate) => candidate.id === "account",
    );
    if (field === undefined) {
      throw new Error("fixture broken");
    }
    (field as { type: string }).type = "number";
    expect(accountFieldFor(manifest, "app_member")).toBeUndefined();
  });

  test("名簿でない表のフォームでは `undefined`(同名の項目が在っても)", () => {
    expect(accountFieldFor(rosterManifest(), "notes")).toBeUndefined();
  });

  test("実在しない表を渡しても `undefined`", () => {
    expect(accountFieldFor(rosterManifest(), "no_such_table")).toBeUndefined();
  });
});

describe("(1b) 利用者のラベル", () => {
  test("表示名が非空なら「表示名(ログイン名)」", () => {
    expect(userAccountLabel(USER1)).toBe("山田 太郎(user1)");
  });

  test("表示名が `null` ならログイン名だけ", () => {
    expect(userAccountLabel(USER2)).toBe("user2");
  });

  test("表示名が空文字ならログイン名だけ", () => {
    expect(userAccountLabel(USER3)).toBe("boss");
  });
});

// ---------------------------------------------------------------------------
// (2) 一覧が読めるとき — プルダウンになり、保存される値は利用者IDである
// ---------------------------------------------------------------------------

describe("(2) 一覧が読めるとき、`account` 欄はプルダウンになる", () => {
  test("`<select>` になり、選択肢に各利用者のラベルが並ぶ", async () => {
    renderForm("member-form");
    await waitFor(() => {
      expect(accountInput().tagName).toBe("SELECT");
    });
    const select = accountInput() as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "",
      "山田 太郎(user1)",
      "user2",
      "boss",
    ]);
  });

  test("**保存される値は利用者ID**である(`<option value>` が `id`)", async () => {
    renderForm("member-form");
    await waitFor(() => {
      expect(accountInput().tagName).toBe("SELECT");
    });
    const select = accountInput() as HTMLSelectElement;
    expect(
      [...select.options].map((option) => option.value).filter((value) => value !== ""),
    ).toEqual(["tM4nU3qS", "zK9pL2wD", "aB1cD2eF"]);
    // **ログイン名は1つも値になっていない**(書き写しの事故を再現させない)。
    expect([...select.options].map((option) => option.value)).not.toContain("user1");
  });

  test("利用者の一覧はちょうど1度だけ読む", async () => {
    renderForm("member-form");
    await waitFor(() => {
      expect(accountInput().tagName).toBe("SELECT");
    });
    expect(userListCalls()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (3) 一覧が読めないとき — 今日どおりのテキスト欄のまま
// ---------------------------------------------------------------------------

describe("(3) 一覧が読めないときは今日どおりのテキスト欄に倒す", () => {
  test('403 で断られても `<input type="text">` のままである', async () => {
    usersMode = "forbidden";
    renderForm("member-form");
    await waitFor(() => {
      expect(userListCalls()).toBe(1);
    });
    const input = accountInput() as HTMLInputElement;
    expect(input.tagName).toBe("INPUT");
    expect(input.type).toBe("text");
  });

  test('通信そのものが失敗しても `<input type="text">` のままである', async () => {
    usersMode = "network";
    renderForm("member-form");
    await waitFor(() => {
      expect(userListCalls()).toBe(1);
    });
    const input = accountInput() as HTMLInputElement;
    expect(input.tagName).toBe("INPUT");
    expect(input.type).toBe("text");
  });
});

// ---------------------------------------------------------------------------
// (4) 現在値がどの利用者にも一致しないとき — 黙って消さない
// ---------------------------------------------------------------------------

describe("(4) どの利用者にも一致しない現在値は残る", () => {
  test("選択肢として残り、選び直さない限り値が変わらない", async () => {
    // **既にある行を開く** —— その行の `account` は書き写しの事故で `user1`(ログイン名)である。
    renderForm("member-form", rosterManifest(), "row-1");
    await waitFor(() => {
      expect(accountInput().tagName).toBe("SELECT");
    });
    const select = accountInput() as HTMLSelectElement;
    // **値は1バイトも変わっていない**(黙って別の利用者に付け替えていない)。
    expect(select.value).toBe("user1");
    // **一致していないことが分かるラベルが付いている。**
    const stale = [...select.options].find((option) => option.value === "user1");
    expect(stale?.textContent).toBe("user1(該当する利用者が居ません)");
    // **利用者の候補は1つも減っていない。**
    expect([...select.options].map((option) => option.value)).toContain("tM4nU3qS");
    expect([...select.options].map((option) => option.value)).toContain("zK9pL2wD");
    expect([...select.options].map((option) => option.value)).toContain("aB1cD2eF");
  });

  test("どの利用者にも一致する現在値には、余計な選択肢を足さない", async () => {
    renderForm("member-form");
    await waitFor(() => {
      expect(accountInput().tagName).toBe("SELECT");
    });
    const select = accountInput() as HTMLSelectElement;
    expect(select.options.length).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// (5)(6) 他の欄は今日どおり / 共通属性は動かない
// ---------------------------------------------------------------------------

describe("(5) プルダウンになるのは `account` 欄ちょうど1つである", () => {
  test('同じフォームの他の `text` 項目は `<input type="text">` のままである', async () => {
    renderForm("member-form");
    await waitFor(() => {
      expect(accountInput().tagName).toBe("SELECT");
    });
    const memo = screen.getByTestId("field-input-memo") as HTMLInputElement;
    expect(memo.tagName).toBe("INPUT");
    expect(memo.type).toBe("text");
  });
});

describe("(6) 共通の属性はプルダウンになっても今日と同じである", () => {
  test("`data-testid` / `id` / `aria-required` が動かない", async () => {
    renderForm("member-form");
    await waitFor(() => {
      expect(accountInput().tagName).toBe("SELECT");
    });
    const select = accountInput();
    expect(select.getAttribute("data-testid")).toBe("field-input-account");
    expect(select.getAttribute("id")).toBe("member-form-account");
    expect(select.getAttribute("aria-required")).toBe("true");
    // **エラーが無い欄には `aria-invalid` を出さない**(今日どおり)。
    expect(select.hasAttribute("aria-invalid")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (7) 名簿でない表のフォームでは1度も読まない
// ---------------------------------------------------------------------------

describe("(7) 名簿でない表のフォームでは、利用者の一覧を1度も読まない", () => {
  test("`notes` のフォームでは呼び出し回数が0である", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/note-form`);
    renderForm("note-form");
    await waitFor(() => {
      expect(screen.getByTestId("field-input-account")).toBeDefined();
    });
    const input = screen.getByTestId("field-input-account") as HTMLInputElement;
    expect(input.tagName).toBe("INPUT");
    expect(input.type).toBe("text");
    expect(userListCalls()).toBe(0);
  });
});
