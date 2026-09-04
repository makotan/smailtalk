/**
 * **1人が複数の役割を持てるようにする**(`V8-M16-T05` / `T06`。`J-G3`)。**実 HTTP の検査。**
 *
 * ## 固定する規則(**今日どこにも定義されていなかった。`V8-M16` が初めて定義する**)
 *
 * > **実効ロール集合 = `{_auth_users.role の1値}` ∪ `{_auth_user_roles に在る付与}`。**
 * > **判定は「実効ロール集合と宣言集合の積が空でなければ通る」の1本に閉じる。**
 *
 * **根拠**: 門A の限定 `J-G3` の逐語「**複数の役割は和集合1本で合成する**」。
 *
 * ## 付け外しの口 —— **HTTP の口を1本も足していない**
 *
 * **`J-G4`(付け外しに口を足す)は門A が却下した。** したがって既存の
 * `PATCH /api/apps/:app_id/auth/users/:user_id` の**引数を広げた**(`roles` を受ける)。
 * **`HTTP_ENTRY_POINTS` の46本は `V8-M16` で1本も動いていない**
 * (機械的な確認は `src/server/entry-point-inventory.test.ts`)。
 *
 * ## この検査が測らないもの(**誇張しない**)
 *
 * - **undo / snapshot との交差を1度も試していない。** 付与は `app.sqlite` に同居するので、
 *   **付与を足した直後に巻き戻せば付与も消える。**
 * - **`_auth_user_roles` へ HTTP から直接書く口は無い**(付与は `PATCH` の引数経由だけ)。
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore } from "../auth/store.ts";
import type { Role } from "../auth/types.ts";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "inventory";

function inventoryManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "備品管理",
      // **【`V8-M29` 第2波】旧(逐語)**: `user_kinds: [{ id: "customer", name: "お客様" }],`
      // **語彙 `app.user_kinds` は廃止された** —— **代わりに立つのは `app.roles`
      // (差分操作 `set_roles`)である。****`customer` はここに書き足していない** ——
      // **`baseRoleValues()` が常に `["owner","editor","viewer","customer"]` を返すので、
      // `customer` は宣言しなくても値域に入る**(本波の唯一の値域の変化。着手前は
      // `user_kinds` を宣言したアプリで `customer` が値域から外れた)。
      tables: [
        {
          id: "items",
          name: "備品",
          fields: [
            { id: "name", name: "備品名", type: "text", required: true },
            // **項目ごとの「見せる相手」。** 和集合で判定されることを見るための宣言。
            // **【`V8-M20` / `J-G28` / `ADR-0301`】旧: `audience: ["editor"]` をここに
            // 書いていた。****その語彙は廃止されたので、下の `roles` から名指しする。**
            { id: "memo", name: "内部メモ", type: "text" },
          ],
        },
      ],
      views: [{ id: "item-list", type: "list_view", table: "items", columns: ["name"] }],
      // **【`V8-M20` / `J-G28` / `ADR-0301`】項目の「見せる相手」の置き直し先。**
      // **既定3ロール(`owner` / `editor` / `viewer`)は消せない。**
      // **`editor` にだけ `items.memo` を開ける** —— **旧 `audience: ["editor"]` と同じ相手。**
      // **`can` に `write` も入れている理由**: **対象を名指しした時点でその項目は全動詞が
      // allow-list になるので、`read` だけだと (T05-3) の下ごしらえ(`memo` を持つ行の作成)が
      // 403 で落ちる。**
      // **表(`items`)の規則は1本も書かない** —— **書くと `D-V8-35` に触れるうえ、
      // 既存ロールの 403/201 の期待値(和集合の検査そのもの)が巻き添えで変わる。**
      // **【`V8-M26` による訂正。上の2行は1バイトも消していない】** **既定が閉じたので、
      // 表の規則を書かないと誰も行を作れない。** **下の `beforeEach` が
      // `withDefaultRoleRules` で既定3役割の表の規則を足している** ——
      // **手で書いているわけではないが、「1本も無い」ではもう無い。**
      // **実測した結果、和算の期待値(403 / 201)は1つも変わらなかった** ——
      // **既定の規則が配る動詞が、固定ロールの層が元々許していた動詞と同じだからである。**
      // **【`V8-M28` 第2波(2026-08-11)。1宣言だけ足した。理由を書く】**
      // **`reception`(受付係)は `role`+`write` だけを持つ** ——
      // **人に役割を配れるが、表も画面も1つも名指ししていない。**
      // **なぜ要るのか**: **ユーザ決定 `D-V8-76` により、自分自身の役割は誰も書き換えられ
      // なくなった。** **したがって「最後の持ち主を降ろせない(409)」を API から測るには、
      // **本人ではない**配布者が要る。** **既定3役割のうち `role`+`write` を持つのは
      // `owner` だけなので、持ち主でない配布者をここで1人宣言する。**
      // **旧: 「`user_kinds` は1バイトも触っていない(役割の識別子が `user_kinds` に実在
      // するかを見る検査は今日1つも無い。`referential-integrity.ts` の類型16 の doc の逐語)。」**
      // **【`V8-M29` 第2波】その `user_kinds` そのものが廃止されたので、上の1文は
      // 主語を失った。**(逐語は消さずに残す。)
      // **この宣言は表・画面・項目を1つも名指ししないので、(T05-*) の測定に載らない。**
      roles: [
        { id: "reception", name: "受付係", rules: [{ target: "role", can: ["write"] }] },
        { id: "owner", name: "持ち主" },
        {
          id: "editor",
          name: "編集者",
          rules: [{ target: "field", table: "items", field: "memo", can: ["read", "write"] }],
        },
        { id: "viewer", name: "閲覧者" },
      ],
    },
  } as unknown as Manifest;
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-multi-role-http-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "備品管理", { app_id: APP_ID });
  } finally {
    store.close();
  }
  // **【`V8-M26`】既定が「閉じる」側へ倒れたので、題材へ既定3役割の**表と画面**の規則を足す。**
  // **旧: `expect(applyManifest(dataRoot, APP_ID, inventoryManifest()).valid).toBe(true);`**
  //
  // **本ファイルの主題は「1人が複数の役割を持てること(和集合)」であって面ではない** ——
  // **`items` の表の規則が1本も無いと、`owner` すら行を作れず和集合を1件も測れなくなる。**
  // **足すのは `apply-diff.ts` の自動付与とまったく同じ規則である**
  // (**持ち主 = 読み書き消す / 編集者 = 読み書き / 閲覧者 = 読むだけ**)——
  // **「全部に全許可」を配ってはいない。** **項目(`memo`)の規則は1本も足していない** ——
  // **上の `roles` が手で書いた `editor` だけの1本のままであり、(T05-3) の主題は無傷である。**
  expect(applyManifest(dataRoot, APP_ID, withDefaultRoleRules(inventoryManifest())).valid).toBe(
    true,
  );
  app = createServerApp({ dataRoot });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

const R = `/api/apps/${APP_ID}/tables/items/records`;
const USERS = `/api/apps/${APP_ID}/auth/users`;

function req(
  cookie: string | undefined,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { origin: TEST_ORIGIN };
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return Promise.resolve(app.request(new Request(`http://localhost${path}`, init)));
}

/** 列の役割 + 付与表の役割を持つユーザを1人作り、cookie を返す。 */
function seed(role: Role, grants: readonly Role[] = [], username?: string) {
  return seedSession(dataRoot, APP_ID, {
    role,
    grants,
    ...(username === undefined ? {} : { username }),
  });
}

// ---------------------------------------------------------------------------
// (T05-1) 1人に役割を2つ付けると、両方が効く
// ---------------------------------------------------------------------------

test("(T05-1) 列 `viewer` + 付与 `editor` の1人は、閲覧も書込も通る(和集合)", async () => {
  const only = seed("viewer");
  // **付与が無ければ今日どおり書けない**(比較のための基準)。
  expect((await req(only.cookie, "POST", R, { name: "机" })).status).toBe(403);

  const both = seed("viewer", ["editor"]);
  expect((await req(both.cookie, "GET", R)).status).toBe(200);
  const post = await req(both.cookie, "POST", R, { name: "机" });
  expect(post.status).toBe(201);
});

// **【`V8-M27-T04` / `T-G5`。期待値を1つ反転させた。旧のテスト名と旧の期待値を逐語で残す】**
// **旧のテスト名**: `(T05-2) 列が非予約(\`customer\`)でも、付与に予約ロールが1つ在れば運営側として扱われる`
// **旧の期待値(逐語)**: `expect((await req(customer.cookie, "GET", R)).status).toBe(403);`
// **旧の説明(逐語)**: `// \`items\` は \`st_owner\` を持たない運営テーブルなので、非予約ロール単独では GET も 403。`
// **根拠**: **`V8-M27` / 台帳 `T-G5` / ユーザ決定 `D-V8-38`。**
// **「運営側として扱われる」という言い方そのものが今日は成り立たない** ——
// **可否を決めるのは役割の綴りではなく、その役割に書かれた規則である。**
// **`customer` 単独の GET は 403 ではなく「200 + 0件」になる**(`ADR-0305` 限定11)。
// **`editor` の付与が効く(= 和集合1本。`J-G3`)ことは今日も真であり、
// 行が見えるようになることでそれを測り続ける。**
test("(T05-2 の反転) 付与された予約ロールの規則が和集合で効く(単独では 200 + 0件)", async () => {
  const customer = seed("customer");
  const alone = await req(customer.cookie, "GET", R);
  expect(alone.status).toBe(200);
  expect(((await alone.json()) as { records: unknown[] }).records).toEqual([]);

  const promoted = seed("customer", ["editor"]);
  expect((await req(promoted.cookie, "GET", R)).status).toBe(200);
  expect((await req(promoted.cookie, "POST", R, { name: "椅子" })).status).toBe(201);
});

test("(T05-3) 項目の「見せる相手」も和集合で判定される", async () => {
  const author = seed("owner", ["editor"]);
  const created = await req(author.cookie, "POST", R, { name: "机", memo: "原価は非公開" });
  expect(created.status).toBe(201);

  // 列 `viewer` だけの人には `memo` が落ちる(宣言は `["editor"]`)。
  const viewer = seed("viewer");
  const hidden = (await (await req(viewer.cookie, "GET", R)).json()) as {
    records: Record<string, unknown>[];
  };
  expect(hidden.records[0]).not.toHaveProperty("memo");

  // 列 `viewer` + 付与 `editor` の人には出る(**積が空でない**)。
  const union = seed("viewer", ["editor"]);
  const shown = (await (await req(union.cookie, "GET", R)).json()) as {
    records: Record<string, unknown>[];
  };
  expect(shown.records[0]?.memo).toBe("原価は非公開");
});

// ---------------------------------------------------------------------------
// (T05-2) 付け外しの口 —— 既存の `PATCH` の引数を広げた
// ---------------------------------------------------------------------------

test("(T06-1) `GET /auth/users` の応答に実効ロール集合が出る", async () => {
  const owner = seed("owner", [], "owner-user");
  const member = seed("viewer", ["editor"], "member-user");

  const res = await req(owner.cookie, "GET", USERS);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    users: { id: string; role: Role; roles: Role[] }[];
  };
  const shown = body.users.find((user) => user.id === member.userId);
  // **既存の `role`(列の1値)は1バイトも消していない。**
  expect(shown?.role).toBe("viewer");
  expect(shown?.roles).toEqual(["viewer", "editor"]);
  expect(body.users.find((user) => user.id === owner.userId)?.roles).toEqual(["owner"]);
});

test("(T06-2) `PATCH /auth/users/:id` は `roles` で複数の役割を付け外しできる", async () => {
  const owner = seed("owner", [], "owner-user");
  const member = seed("viewer", [], "member-user");

  // 付ける。
  const added = await req(owner.cookie, "PATCH", `${USERS}/${member.userId}`, {
    roles: ["viewer", "editor"],
  });
  expect(added.status).toBe(200);
  expect(((await added.json()) as { user: { roles: Role[] } }).user.roles).toEqual([
    "viewer",
    "editor",
  ]);
  expect((await req(member.cookie, "POST", R, { name: "机" })).status).toBe(201);

  // 外す。
  const removed = await req(owner.cookie, "PATCH", `${USERS}/${member.userId}`, {
    roles: ["viewer"],
  });
  expect(removed.status).toBe(200);
  expect(((await removed.json()) as { user: { roles: Role[] } }).user.roles).toEqual(["viewer"]);
  expect((await req(member.cookie, "POST", R, { name: "椅子" })).status).toBe(403);
});

test("(T06-3) `role` 1値の `PATCH` は今日どおり動く(引数を広げただけ)", async () => {
  const owner = seed("owner", [], "owner-user");
  const member = seed("viewer", [], "member-user");
  const res = await req(owner.cookie, "PATCH", `${USERS}/${member.userId}`, { role: "editor" });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { user: { role: Role; roles: Role[] } };
  expect(body.user.role).toBe("editor");
  expect(body.user.roles).toEqual(["editor"]);
});

test("(T06-4) 宣言に無い役割は 400、対象不在は 404、`roles` が空配列も 400", async () => {
  const owner = seed("owner", [], "owner-user");
  const member = seed("viewer", [], "member-user");
  expect(
    (await req(owner.cookie, "PATCH", `${USERS}/${member.userId}`, { roles: ["superuser"] }))
      .status,
  ).toBe(400);
  expect(
    (await req(owner.cookie, "PATCH", `${USERS}/${member.userId}`, { roles: [] })).status,
  ).toBe(400);
  expect(
    (await req(owner.cookie, "PATCH", `${USERS}/no-such-user`, { roles: ["viewer"] })).status,
  ).toBe(404);
});

test("(T06-5) 付与でだけ持ち主になった人も、運営専用の口を通る", async () => {
  const owner = seed("owner", [], "owner-user");
  const granted = seed("viewer", ["owner"], "granted-owner");
  // **`requireOwner` は実効ロール集合を見る。**
  expect((await req(granted.cookie, "GET", USERS)).status).toBe(200);
  // 列にだけ owner が居る人も今日どおり通る。
  expect((await req(owner.cookie, "GET", USERS)).status).toBe(200);
});

// ---------------------------------------------------------------------------
// (T06-6/7) 不変条件を **API から** 示す —— 持ち主が列にだけ / 表にだけ の2状態
// ---------------------------------------------------------------------------

// **【`V8-M28` 第2波(2026-08-11)。下の2本の「誰が PATCH を撃つか」を変えた。旧を逐語で残す】**
//
// **旧 (T06-6) の逐語**:
//
//     // 列の持ち主を降ろす(表に持ち主が居るので通る)。
//     const demote = await req(columnOwner.cookie, "PATCH", `${USERS}/${columnOwner.userId}`, {
//       roles: ["viewer"],
//     });
//     expect(demote.status).toBe(200);
//     …
//     // 残った持ち主は**表にだけ**居る。その1人を降ろそうとすると 409。
//     const last = await req(tableOwner.cookie, "PATCH", `${USERS}/${tableOwner.userId}`, {
//       roles: ["viewer"],
//     });
//     expect(last.status).toBe(409);
//
// **旧 (T06-7) の逐語**:
//
//     expect(
//       (await req(owner.cookie, "PATCH", `${USERS}/${owner.userId}`, { role: "viewer" })).status,
//     ).toBe(409);
//     expect(
//       (await req(owner.cookie, "PATCH", `${USERS}/${owner.userId}`, { roles: ["viewer", "editor"] }))
//         .status,
//     ).toBe(409);
//
// **根拠**: **ユーザ決定 `D-V8-76` / 台帳 `T-G20`** —— **どちらも「本人が本人を降ろす」形
// だったので、今日は 409 の前に 403(自分自身)で止まる。**
// **測っている主題(最後の1人は降ろせない = `LastOwnerError` の 409)は1ミリも変えていない**
// —— **撃つ人を、`role`+`write` を持つ別人(`reception`)に替えただけである。**
// **自己降格が 403 になったことは、下に新しい行として足して固定した。**
test("(T06-6) 持ち主が**表にだけ**居る状態を作り、最後の1人を降ろせないことを API から示す", async () => {
  const columnOwner = seed("owner", [], "column-owner");
  const tableOwner = seed("viewer", ["owner"], "table-owner");
  // **本人ではない配布者**(`role`+`write` だけを持つ)。
  const clerk = seed("reception", [], "clerk-6");

  // **【`V8-M28` / `D-V8-76`】本人が本人を降ろすことは、今日は 403 である。**
  expect(
    (
      await req(columnOwner.cookie, "PATCH", `${USERS}/${columnOwner.userId}`, {
        roles: ["viewer"],
      })
    ).status,
  ).toBe(403);

  // 列の持ち主を降ろす(表に持ち主が居るので通る)。
  const demote = await req(clerk.cookie, "PATCH", `${USERS}/${columnOwner.userId}`, {
    roles: ["viewer"],
  });
  expect(demote.status).toBe(200);

  // **列を数えるだけの実装だと、ここで最古昇格が走って `column-owner` が owner に戻る。**
  const store = AuthStore.openForApp(dataRoot, APP_ID);
  try {
    expect(store.effectiveRoles(columnOwner.userId)).toEqual(["viewer"]);
    expect(store.countOwners()).toBe(1);
  } finally {
    store.close();
  }

  // 残った持ち主は**表にだけ**居る。その1人を降ろそうとすると 409。
  const last = await req(clerk.cookie, "PATCH", `${USERS}/${tableOwner.userId}`, {
    roles: ["viewer"],
  });
  expect(last.status).toBe(409);

  // 退会も 409(退会ガードも表を数える)。
  const leave = await req(tableOwner.cookie, "DELETE", `/api/apps/${APP_ID}/auth/me`);
  expect(leave.status).toBe(409);
});

test("(T06-7) 持ち主が**列にだけ**居る状態でも、最後の1人は降ろせず退会もできない", async () => {
  const owner = seed("owner", [], "column-only-owner");
  seed("viewer", [], "bystander");
  const clerk = seed("reception", [], "clerk-7");

  // **【`V8-M28` / `D-V8-76`】本人からの2形は、今日は 403 である**(旧はどちらも 409)。
  expect(
    (await req(owner.cookie, "PATCH", `${USERS}/${owner.userId}`, { role: "viewer" })).status,
  ).toBe(403);
  expect(
    (await req(owner.cookie, "PATCH", `${USERS}/${owner.userId}`, { roles: ["viewer", "editor"] }))
      .status,
  ).toBe(403);

  // **別人(`role`+`write`)から降ろそうとすると、今日どおり 409。**
  expect(
    (await req(clerk.cookie, "PATCH", `${USERS}/${owner.userId}`, { role: "viewer" })).status,
  ).toBe(409);
  expect(
    (await req(clerk.cookie, "PATCH", `${USERS}/${owner.userId}`, { roles: ["viewer", "editor"] }))
      .status,
  ).toBe(409);
  expect((await req(owner.cookie, "DELETE", `/api/apps/${APP_ID}/auth/me`)).status).toBe(409);
});
