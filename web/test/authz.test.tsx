/**
 * フロントの権限モデル(V1-M3-T02 / ADR-0015)のコンポーネントテスト。
 *
 * P-C の検証点:
 *   1. ロールで書込 UI を先回りで閉じる(viewer は保存/編集/削除を出さない)。
 *   2. 書込が **403(権限不足)** で拒否されたら「閲覧のみ」を明示する(401 とは別扱い)。
 *   3. ヘッダに現在ロールを出し、**owner のときだけ**ユーザ管理への導線を出す。
 *   4. ユーザ管理でロールを変更できる。**最後の owner の降格(409)**は専用文面を出す。
 *
 * E2E は P-E の担当なので、ここでは書かない(計画 §実施順)。
 * ここに出てくるアプリ固有の名前はこのファイル内だけのフィクスチャである。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Manifest, Table } from "../../src/kernel/types.ts";
import { App } from "../src/App.tsx";
import { canWriteRole, RoleProvider } from "../src/auth/authz.tsx";
import { UserAdmin } from "../src/auth/UserAdmin.tsx";
import { DetailViewRenderer } from "../src/views/DetailViewRenderer.tsx";
import { FormRenderer } from "../src/views/FormRenderer.tsx";

const APP_ID = "sample-app";
const RECORD_ID = "note-0001";

function jsonResponse(body: unknown, status = 200): Response {
  if (body === undefined) {
    return new Response(null, { status });
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** タイトルだけの最小アプリ(reference が無いので取得待ちが単純)。 */
function sampleManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "サンプル",
      tables: [
        {
          id: "notes",
          name: "メモ",
          fields: [{ id: "title", name: "タイトル", type: "text", required: true }],
        },
      ],
      views: [
        { id: "note-list", type: "list_view", table: "notes", columns: ["title"] },
        { id: "note-form", type: "form", table: "notes", fields: ["title"] },
        { id: "note-detail", type: "detail_view", table: "notes" },
      ],
    },
  };
}

const NOTES_PATH = `/api/apps/${APP_ID}/tables/notes/records`;
const NOTE_ROW = { _id: RECORD_ID, _created_at: "", _updated_at: "", title: "ひとつめ" };

let requests: { url: string; method: string }[];
let responses: Map<string, [number, unknown]>;
let originalFetch: typeof fetch;

beforeEach(() => {
  requests = [];
  responses = new Map();
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    requests.push({ url, method });
    const stubbed = responses.get(`${method} ${url}`);
    if (stubbed !== undefined) {
      return jsonResponse(stubbed[1], stubbed[0]);
    }
    if (method === "GET" && url === `${NOTES_PATH}/${RECORD_ID}`) {
      return jsonResponse({ record: NOTE_ROW }, 200);
    }
    if (method === "GET" && url.startsWith(NOTES_PATH)) {
      return jsonResponse({ records: [NOTE_ROW] }, 200);
    }
    if (method === "POST" && url === NOTES_PATH) {
      return jsonResponse({ record: { _id: "created" } }, 201);
    }
    if (method === "DELETE" && url === `${NOTES_PATH}/${RECORD_ID}`) {
      return jsonResponse(undefined, 204);
    }
    return jsonResponse({ errors: [{ path: "", message: `no stub for ${method} ${url}` }] }, 404);
  }) as typeof fetch;
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function renderForm(role: "owner" | "editor" | "viewer") {
  const manifest = sampleManifest();
  const view = manifest.app.views.find((candidate) => candidate.type === "form");
  if (view === undefined || view.type !== "form") {
    throw new Error("fixture broken");
  }
  return render(
    <RoleProvider role={role}>
      <FormRenderer appId={APP_ID} manifest={manifest} view={view} />
    </RoleProvider>,
  );
}

function renderDetail(role: "owner" | "editor" | "viewer") {
  const manifest = sampleManifest();
  const view = manifest.app.views.find((candidate) => candidate.type === "detail_view");
  if (view === undefined || view.type !== "detail_view") {
    throw new Error("fixture broken");
  }
  return render(
    <RoleProvider role={role}>
      <DetailViewRenderer appId={APP_ID} manifest={manifest} view={view} recordId={RECORD_ID} />
    </RoleProvider>,
  );
}

describe("canWriteRole", () => {
  /**
   * **【V4-M2-T06 / `ADR-0074` 限定6 で書き直した】**
   *
   * **書き直す前は「provider 外(null)は既定で可」を固定していた。それが今日は誤りである。**
   * **`ADR-0074` 限定6 の逐語**:「**`canWriteRole(null, table)` が `false` を返す。**」
   * **反転させた理由**: **未ログインでも見られる画面が入り、`RoleProvider` が包んでいない
   * subtree に `null` が流れる経路が実際にできた**(審査記録
   * `docs/plan/v4/records/v4-m2-gate-a-anonymous-view.md` §3 の S3-2a)。
   * **旧既定のままだと匿名に保存・編集・削除ボタンが出る。**
   *
   * **`ADR-0074` 限定6 の第4列が求めた「`canWriteRole(null, table)` を直接叩く
   * ユニットテスト」の本体は `web/test/anonymous-view.test.tsx` (a) にある。**
   * **ここは既存4ロールの答えが1つも動いていないことの側を持つ。**
   */
  test("owner / editor は書込可、viewer は不可。provider 外(null)は書込不可に反転した", () => {
    expect(canWriteRole("owner")).toBe(true);
    expect(canWriteRole("editor")).toBe(true);
    expect(canWriteRole("viewer")).toBe(false);
    expect(canWriteRole(null)).toBe(false);
  });

  /**
   * V3-M3-T04(D-G12b): テーブル込みの判定に拡張した。**既存3ロールの答えは1つも変えて
   * いない**ことをここで固定する。
   * **`null` の答えだけが `V4-M2-T06`(`ADR-0074` 限定6)で反転した** —— **反転したのは
   * 1件だけであることが、ここで読み取れる。**
   * customer のテーブル単位の可否は `web/test/role-visibility.test.tsx` が持つ。
   */
  test("テーブルを渡しても既存3ロールの答えは変わらない(反転したのは null だけである)", () => {
    const table: Table = {
      id: "notes",
      name: "メモ",
      fields: [{ id: "title", name: "タイトル", type: "text", required: true }],
    };
    expect(canWriteRole("owner", table)).toBe(true);
    expect(canWriteRole("editor", table)).toBe(true);
    expect(canWriteRole("viewer", table)).toBe(false);
    expect(canWriteRole(null, table)).toBe(false);
    // テーブルを渡さない呼び出し(既存の呼び出し形)も引き続き成立する。
    expect(canWriteRole(null, undefined)).toBe(false);
  });
});

describe("form の書込ガード", () => {
  test("editor は保存ボタンが出る", async () => {
    renderForm("editor");
    await waitFor(() => expect(screen.getByLabelText(/タイトル/)).toBeDefined());
    expect(screen.getByRole("button", { name: /保存/ })).toBeDefined();
    expect(screen.queryByTestId("form-read-only")).toBeNull();
  });

  test("viewer は保存ボタンを出さず、閲覧のみを明示する", async () => {
    renderForm("viewer");
    await waitFor(() => expect(screen.getByLabelText(/タイトル/)).toBeDefined());
    expect(screen.queryByRole("button", { name: /保存/ })).toBeNull();
    expect(screen.getByTestId("form-read-only")).toBeDefined();
  });

  test("保存が 403 なら write-forbidden を出す(401=失効とは別)", async () => {
    responses.set(`POST ${NOTES_PATH}`, [
      403,
      { errors: [{ path: "", message: "このアプリでは閲覧のみ許可されています。" }] },
    ]);
    renderForm("editor");
    await waitFor(() => expect(screen.getByLabelText(/タイトル/)).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(screen.getByTestId("write-forbidden")).toBeDefined());
    // 画面遷移しない(その場に留まる)。
    expect(window.location.pathname).toBe("/");
  });
});

describe("detail の書込ガード", () => {
  test("editor は編集・削除の導線が出る", async () => {
    renderDetail("editor");
    await waitFor(() => expect(screen.getByTestId("detail-edit")).toBeDefined());
    expect(screen.getByTestId("detail-delete")).toBeDefined();
    expect(screen.queryByTestId("detail-read-only")).toBeNull();
  });

  test("viewer は編集・削除の導線を出さない", async () => {
    renderDetail("viewer");
    await waitFor(() => expect(screen.getByTestId("detail-read-only")).toBeDefined());
    expect(screen.queryByTestId("detail-edit")).toBeNull();
    expect(screen.queryByTestId("detail-delete")).toBeNull();
  });

  test("削除が 403 なら write-forbidden を出す", async () => {
    responses.set(`DELETE ${NOTES_PATH}/${RECORD_ID}`, [
      403,
      { errors: [{ path: "", message: "このアプリでは閲覧のみ許可されています。" }] },
    ]);
    renderDetail("owner");
    await waitFor(() => expect(screen.getByTestId("detail-delete")).toBeDefined());
    fireEvent.click(screen.getByTestId("detail-delete"));
    fireEvent.click(screen.getByTestId("detail-delete-execute"));
    await waitFor(() => expect(screen.getByTestId("write-forbidden")).toBeDefined());
  });
});

describe("ヘッダのロール表示と管理導線", () => {
  /** App を me スタブ付きで開く(アプリを直接開く URL)。 */
  function renderAppAs(role: "owner" | "editor" | "viewer") {
    window.history.replaceState({}, "", `/apps/${APP_ID}`);
    responses.set(`GET /api/apps/${APP_ID}/auth/me`, [
      200,
      { user: { id: "u1", username: "alice", displayName: null, role } },
    ]);
    responses.set(`GET /api/apps/${APP_ID}/manifest`, [200, sampleManifest()]);
    return render(<App />);
  }

  test("現在ロールを出す。owner にはユーザ管理導線が出る", async () => {
    renderAppAs("owner");
    await waitFor(() => expect(screen.getByTestId("current-role")).toBeDefined());
    expect(screen.getByTestId("current-role").textContent).toBe("オーナー");
    expect(screen.getByTestId("open-user-admin")).toBeDefined();
  });

  test("viewer には現在ロールが出るが、ユーザ管理導線は出ない", async () => {
    renderAppAs("viewer");
    await waitFor(() => expect(screen.getByTestId("current-role")).toBeDefined());
    expect(screen.getByTestId("current-role").textContent).toBe("閲覧者");
    expect(screen.queryByTestId("open-user-admin")).toBeNull();
  });

  test("owner が導線を押すとユーザ管理画面が開く", async () => {
    responses.set(`GET /api/apps/${APP_ID}/auth/users`, [200, { users: [] }]);
    renderAppAs("owner");
    await waitFor(() => expect(screen.getByTestId("open-user-admin")).toBeDefined());
    fireEvent.click(screen.getByTestId("open-user-admin"));
    await waitFor(() => expect(screen.getByTestId("user-admin")).toBeDefined());
  });
});

describe("UserAdmin(ロール変更)", () => {
  const USERS = [
    { id: "u1", username: "alice", displayName: null, role: "owner", createdAt: "2026-01-01" },
    { id: "u2", username: "bob", displayName: "ボブ", role: "viewer", createdAt: "2026-01-02" },
  ];

  test("一覧を行ごとに出し、ロールのセレクトに現在値を入れる", async () => {
    responses.set(`GET /api/apps/${APP_ID}/auth/users`, [200, { users: USERS }]);
    render(<UserAdmin appId={APP_ID} />);
    await waitFor(() => expect(screen.getAllByTestId("user-row").length).toBe(2));
    const selects = screen.getAllByTestId("role-select") as HTMLSelectElement[];
    expect(selects[0]?.value).toBe("owner");
    expect(selects[1]?.value).toBe("viewer");
  });

  test("viewer を editor に昇格すると PATCH を送り、一覧が更新される", async () => {
    responses.set(`GET /api/apps/${APP_ID}/auth/users`, [200, { users: USERS }]);
    responses.set(`PATCH /api/apps/${APP_ID}/auth/users/u2`, [
      200,
      { user: { ...USERS[1], role: "editor" } },
    ]);
    render(<UserAdmin appId={APP_ID} />);
    await waitFor(() => expect(screen.getAllByTestId("user-row").length).toBe(2));
    const selects = screen.getAllByTestId("role-select") as HTMLSelectElement[];
    fireEvent.change(selects[1] as HTMLSelectElement, { target: { value: "editor" } });
    await waitFor(() => {
      const patched = requests.find((request) => request.method === "PATCH");
      expect(patched?.url).toBe(`/api/apps/${APP_ID}/auth/users/u2`);
    });
    await waitFor(() => {
      const updated = screen.getAllByTestId("role-select") as HTMLSelectElement[];
      expect(updated[1]?.value).toBe("editor");
    });
  });

  test("最後の owner の降格(409)は専用文面を出す", async () => {
    responses.set(`GET /api/apps/${APP_ID}/auth/users`, [200, { users: USERS }]);
    responses.set(`PATCH /api/apps/${APP_ID}/auth/users/u1`, [
      409,
      { errors: [{ path: "", message: "最後の owner は降格できません。" }] },
    ]);
    render(<UserAdmin appId={APP_ID} />);
    await waitFor(() => expect(screen.getAllByTestId("user-row").length).toBe(2));
    const selects = screen.getAllByTestId("role-select") as HTMLSelectElement[];
    fireEvent.change(selects[0] as HTMLSelectElement, { target: { value: "viewer" } });
    await waitFor(() => expect(screen.getByTestId("role-error")).toBeDefined());
    expect(screen.getByTestId("role-error").textContent).toContain("最後の管理者は降格できません");
  });
});

// ---------------------------------------------------------------------------
// 押せるが必ず失敗するボタンを出さない(E-G53 / V4-M6)
// ---------------------------------------------------------------------------
//
// **実地の実測(02 §5-9 `E-G53`)**: 運営(tencho)が注文詳細を開くと「削除」ボタンが1つ
// 出るが、押すと必ず **404**(`テーブル "order" にレコード "…" は存在しません。`)になる。
// **直前に同じ id を読めている運営には、これはバグに見える。** 原因は `web/src/auth/authz.tsx`
// の `canWriteRole` が **owner なら無条件 true** で、`st_owner`(誰の行か)を1文字も見て
// いないことである。**サーバ側は `ADR-0061` が意図して「読取2経路だけ」を開いており、
// 書込は1ミリも開いていない。**
//
// **ここで直すのは UI の食い違いだけである(閉じる向き)。** **サーバの書込を1バイトも
// 開けていない** —— 開ける側(`D-V4-19` /`D-V4-49` が求める「届けるのに必要な項目だけ
// 直せる」)は `ADR-0061` §3a-2 が門A の新規審査を要求しており、**`V4-M7` の判定を待つ。**

describe("他人の個人行には書込の導線を出さない(E-G53)", () => {
  /** `st_owner` を持つテーブル1本の最小アプリ(運営可視の宣言は UI から見えないので不要)。 */
  function ownedManifest(): Manifest {
    return {
      app: {
        id: APP_ID,
        name: "サンプル",
        tables: [
          {
            id: "orders",
            name: "注文",
            fields: [
              { id: "title", name: "題", type: "text", required: true },
              { id: "st_owner", name: "所有者", type: "text" },
            ],
          },
        ],
        views: [
          { id: "order-detail", type: "detail_view", table: "orders" },
          { id: "order-form", type: "form", table: "orders", fields: ["title"] },
        ],
      },
    };
  }

  const ORDER_ID = "order-0001";

  /** biome の a11y 規則がリテラルの `role="owner"` を ARIA ロールと見なすので変数で渡す。 */
  const OWNER_ROLE = "owner" as const;

  function renderOwnedDetail(actorId: string | undefined, rowOwner: string | null) {
    const manifest = ownedManifest();
    const view = manifest.app.views.find((candidate) => candidate.type === "detail_view");
    if (view === undefined || view.type !== "detail_view") {
      throw new Error("fixture broken");
    }
    responses.set(`GET /api/apps/${APP_ID}/tables/orders/records/${ORDER_ID}`, [
      200,
      {
        record: {
          _id: ORDER_ID,
          _created_at: "",
          _updated_at: "",
          title: "注文A",
          st_owner: rowOwner,
        },
      },
    ]);
    return render(
      <RoleProvider role={OWNER_ROLE} actorId={actorId}>
        <DetailViewRenderer appId={APP_ID} manifest={manifest} view={view} recordId={ORDER_ID} />
      </RoleProvider>,
    );
  }

  test("owner でも、他人の行では編集/削除を出さない(押せば必ず 404 になるボタン)", async () => {
    renderOwnedDetail("me", "someone-else");
    await waitFor(() => expect(screen.getByTestId("detail-fields")).toBeDefined());
    expect(screen.queryByTestId("detail-edit")).toBeNull();
    expect(screen.queryByTestId("detail-delete")).toBeNull();
    // **理由は画面に残す**(owner は「編集できる想定の人」なので注記を消さない。E-G20 と別)。
    expect(screen.getByTestId("detail-read-only")).toBeDefined();
  });

  test("owner 自身の行では今日どおり編集/削除が出る", async () => {
    renderOwnedDetail("me", "me");
    await waitFor(() => expect(screen.getByTestId("detail-edit")).toBeDefined());
    expect(screen.getByTestId("detail-delete")).toBeDefined();
  });

  test("共有行(st_owner が空)では今日どおり編集/削除が出る", async () => {
    renderOwnedDetail("me", null);
    await waitFor(() => expect(screen.getByTestId("detail-edit")).toBeDefined());
  });

  test("誰として見ているか分からないとき(provider に actorId が無い)は据え置く", async () => {
    // **既定は「今までどおり」** —— 判定材料が無いときに閉じると、各レンダラを単体で描く
    // 既存テストの前提が動く(`authz.tsx` ヘッダの既定と同じ向き)。
    renderOwnedDetail(undefined, "someone-else");
    await waitFor(() => expect(screen.getByTestId("detail-edit")).toBeDefined());
  });
});
