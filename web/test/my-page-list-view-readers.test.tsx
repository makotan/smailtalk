/**
 * **【`V22-M4-T06`】表ごとに「その表の一覧画面を1本以上開ける役割」を、本体の `canUseView` で出して固定する**
 * (`ADR-0494` §Decision 4 の 4 と §Decision 4-1 の「本体の `canUseView` に合わせる」/ メインの裁定 `D-V22-45`)。
 *
 * 書き出したアプリ(隣の生成器の単位)は、生成のときにこの並びを焼いて `?my_page=1` を 403 で断る
 * (`src/predicates.ts` の `myPageListViewReadersOf`)。 **生成器の検査は本体を import しない**(`ADR-0494` 式J)ので、
 * 本体の答えはここで `toEqual` に固定し、**同じ値と同じ題材を生成器の検査(生成器の単位の `predicates.test.ts`)に
 * 焼く。** 題材の JSON の SHA-256 を両方の検査に焼き、片方の題材だけが変わったら赤くする。
 *
 * この検査が明記する2点:
 *
 * - **画面の規則が1本も無い役割は開けない**(既定で閉じる。`ADR-0387` 限定7 / `V8-M26`)—— 題材の viewer。
 * - **`menu_listed: false` の一覧画面も開ける数に入る**(`canUseView` は掲載を見ない。`ADR-0084` 限定5)—— 表 b。
 *
 * ほかに: 詳細画面だけを開ける役割は一覧を開けない(guest の `a_detail`)/ `read` を含まない画面の規則は開けない
 * (guest の `b_hidden_list` の `write`)/ 一覧画面の無い表は誰も開けない(表 c)。
 */
import { expect, test } from "bun:test";
import type { Manifest } from "../../src/kernel/types.ts";
import { canUseView } from "../src/auth/authz.tsx";

/**
 * **題材の定義**(生成器の単位の `predicates.test.ts` の同じ名前の定数と1バイトも違わない写し。
 * 片方だけを変えると、下の SHA-256 の検査が赤くなる)。
 */
const LIST_VIEW_READERS_SUBJECT = {
  app: {
    id: "list-view-readers",
    name: "一覧画面を開ける役割の題材",
    roles: [
      {
        id: "owner",
        name: "管理者",
        rules: [
          { target: "app", can: ["write"] },
          { target: "role", can: ["write"] },
          { target: "table", table: "a", can: ["read", "write"] },
          { target: "table", table: "b", can: ["read"] },
          { target: "view", view: "a_list", can: ["read"] },
          { target: "view", view: "b_hidden_list", can: ["read"] },
        ],
      },
      {
        id: "editor",
        name: "編集者",
        rules: [
          { target: "table", table: "a", can: ["read"] },
          { target: "view", view: "a_second_list", can: ["read"] },
          { target: "view", view: "a_detail", can: ["read"] },
        ],
      },
      { id: "viewer", name: "閲覧者", rules: [{ target: "table", table: "a", can: ["read"] }] },
      {
        id: "guest",
        name: "来客",
        rules: [
          { target: "view", view: "a_detail", can: ["read"] },
          { target: "view", view: "b_hidden_list", can: ["write"] },
        ],
      },
    ],
    tables: [
      { id: "a", name: "表A", fields: [{ id: "title", name: "件名", type: "text" }] },
      { id: "b", name: "表B", fields: [{ id: "title", name: "件名", type: "text" }] },
      { id: "c", name: "表C", fields: [{ id: "title", name: "件名", type: "text" }] },
    ],
    views: [
      { id: "a_list", type: "list_view", table: "a", columns: ["title"] },
      { id: "a_second_list", type: "list_view", table: "a", columns: ["title"] },
      { id: "a_detail", type: "detail_view", table: "a", fields: ["title"] },
      {
        id: "b_hidden_list",
        type: "list_view",
        table: "b",
        columns: ["title"],
        menu_listed: false,
      },
      { id: "c_form", type: "form", table: "c", fields: ["title"] },
    ],
  },
};

/** 題材の `JSON.stringify` の SHA-256(生成器の単位の `predicates.test.ts` にも同じ値を焼いた)。 */
const LIST_VIEW_READERS_SUBJECT_SHA256 =
  "814a40c833078d0374ff2a38b6d9f65030ba44183a1ba91890e7a884b57c0668";

/** 本体の `canUseView` が返す、表ごとの「一覧画面を1本以上開ける役割」(役割の宣言の順)。 */
const LIST_VIEW_READERS_BY_TABLE = {
  a: ["owner", "editor"],
  b: ["owner"],
  c: [],
};

test("題材の SHA-256 が、生成器の検査に焼いた値と同じ", () => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(JSON.stringify(LIST_VIEW_READERS_SUBJECT));
  expect(hasher.digest("hex")).toBe(LIST_VIEW_READERS_SUBJECT_SHA256);
});

test("本体の `canUseView` で、表ごとに一覧画面を1本以上開ける役割を出すと、焼いた値になる", () => {
  const manifest = LIST_VIEW_READERS_SUBJECT as unknown as Manifest;
  const roles = manifest.app.roles?.map((role) => role.id) ?? [];
  const byTable = Object.fromEntries(
    manifest.app.tables.map((table) => [
      table.id,
      roles.filter((role) =>
        manifest.app.views.some(
          (view) =>
            view.type === "list_view" &&
            view.table === table.id &&
            canUseView(role as Parameters<typeof canUseView>[0], manifest, view),
        ),
      ),
    ]),
  );
  expect(byTable).toEqual(LIST_VIEW_READERS_BY_TABLE);
});

test("画面の規則が1本も無い役割(viewer)は開けない・`menu_listed: false` の一覧画面(b_hidden_list)も開ける数に入る", () => {
  const manifest = LIST_VIEW_READERS_SUBJECT as unknown as Manifest;
  const view = (id: string) => {
    const found = manifest.app.views.find((candidate) => candidate.id === id);
    if (found === undefined) {
      throw new Error(`${id} が題材に無い`);
    }
    return found;
  };
  expect(canUseView("viewer", manifest, view("a_list"))).toBe(false);
  expect(canUseView("viewer", manifest, view("a_second_list"))).toBe(false);
  expect(canUseView("owner", manifest, view("b_hidden_list"))).toBe(true);
  expect(canUseView("guest", manifest, view("b_hidden_list"))).toBe(false);
  expect(canUseView("guest", manifest, view("a_detail"))).toBe(true);
});
