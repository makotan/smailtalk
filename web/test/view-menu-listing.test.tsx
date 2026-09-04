/**
 * 画面をメニューへ出す/出さないの宣言を、**表示層の一覧が読む**ことの検査
 * (`E-G12` / `V4-M10-T45` / `ADR-0084`)。
 *
 * **限定表の正は [`docs/adr/0084-view-menu-listing.md`](../../docs/adr/0084-view-menu-listing.md) §Decision 2(10点)。**
 *
 * ## このファイルが固定すること
 *
 * 1. **限定4**: 掲載 = `canUseView(role, manifest, view)` **かつ** `menu_listed` が偽でない。
 *    **AND 1本である** —— 「どちらが勝つか」の規則を1つも作らない。
 * 2. **限定5**: **可否を1ミリも変えない** —— `canUseView` は `menu_listed: false` の画面にも
 *    今日どおり `true` を返し、**その画面は行クリック / URL 直叩きで開ける。**
 * 3. **限定3**: **宣言を1つも持たないマニフェストで一覧の本数が今日と1本も変わらない。**
 * 4. **匿名にも同じ AND が当たる**(`v4-m10.md` §4d 申し送り3 が実装者に決定を求めた点)。
 *
 * ## このファイルが証明しないこと(先に書く。誇張しない)
 *
 * - **一覧から外すことは遮断ではない。** サーバの応答は1バイトも変わらない(限定8)——
 *   `GET /manifest` は今日どおり全ビュー定義を返し、レコードAPI は今日どおり答える。
 * - **`menu_listed: false` を書いた画面へ到達する導線をアプリが持っているかは、
 *   アプリ側の宿題である**(`V4-M11`)。**本キーは導線を1本も作らない。**
 */
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import type { Manifest, View } from "../../src/kernel/types.ts";
import { ANONYMOUS, canUseView, visibleViewsForRole } from "../src/auth/authz.tsx";
import { ADMIN_ROLES, grantAllViews } from "./role-rules.ts";

const WEB_ROOT = dirname(import.meta.dir);

afterEach(cleanup);

/**
 * 題材。**`member-detail` は「マイページ」に相当する自分の会員情報**であり、
 * **`V4-M10-T27`(ビュー種別で一律に外す案)が消してしまうと名指しされた画面である**
 * (`ADR-0084` §Context 2)。**宣言の側なら、この画面だけを一覧に残せる。**
 */
/**
 * **本ファイルが測る相手**(4ロール + 匿名)。
 *
 * **【`V8-M26`(2026-08-10)。ユーザ決定 `D-V8-45` / `D-V8-65`】**
 * **`judgeRoleAccess` の既定が閉じる側へ倒れたので、規則を1本も書いていない題材では
 * `canUseView` が全員に偽を返し、掲載(`menu_listed`)の検査が**掲載の前段で**落ちる。**
 * **本ファイルの主題は `menu_listed` であって面ではないので、題材に「画面 × 読取」だけを
 * 足して前段を通す** —— **表・項目・ボタンの規則は1本も足していない。**
 */
const MENU_ROLES = [...ADMIN_ROLES, "customer", "anonymous"] as const;

function manifest(): Manifest {
  const built: Manifest = {
    app: {
      id: "menu-shop",
      name: "メニューの店",
      tables: [
        {
          id: "member",
          name: "会員",
          fields: [
            { id: "name", name: "氏名", type: "text", required: true },
            { id: "st_owner", name: "持ち主", type: "text" },
          ],
        },
      ],
      views: [
        {
          id: "member-list",
          name: "会員一覧",
          type: "list_view",
          table: "member",
          columns: ["name"],
        },
        // **単体で開く画面。行クリックで開くので、一覧に並べる必要が無い。**
        {
          id: "member-detail",
          name: "会員の詳細",
          type: "detail_view",
          table: "member",
          fields: ["name"],
        },
        {
          id: "order-detail",
          name: "注文の詳細",
          type: "detail_view",
          table: "member",
          fields: ["name"],
          menu_listed: false,
        } as never,
      ],
    },
  };
  // **【`V8-M26`】3画面すべてに「開ける」規則を足す**(掲載の判定の前段を通すため)。
  // **掲載の宣言(`menu_listed`)は1バイトも触っていない** —— **落ちる/落ちないの差は
  // 今日も本キーだけが作る。**
  return grantAllViews(built, MENU_ROLES);
}

/** 宣言を1つも持たない題材(限定3 の対照)。 */
function undeclared(): Manifest {
  const base = manifest();
  base.app.views = base.app.views.map((view) => {
    const { menu_listed: _dropped, ...rest } = view as View & { menu_listed?: boolean };
    return rest as View;
  });
  return base;
}

// --- 限定3: 書かなかった画面は今日どおり並ぶ -------------------------------------------

test("限定3: 宣言を1つも持たないマニフェストで一覧の本数が1本も変わらない(4ロール + 匿名)", () => {
  const target = undeclared();
  for (const role of ["owner", "editor", "viewer", "customer"] as const) {
    expect(visibleViewsForRole(role, target).map((v) => v.id)).toEqual(
      target.app.views.filter((v) => canUseView(role, target, v)).map((v) => v.id),
    );
  }
  // **【`V8-M20` / `J-G27` で期待値を反転させた。旧の逐語を1バイトも消していない】**
  // **旧のコメント**: 「匿名は `audience` に `anonymous` と書いた画面だけなので0件のまま
  // (既定は変えない)。」
  // **旧の期待値**: `expect(visibleViewsForRole(ANONYMOUS, target)).toHaveLength(0);`
  // **今日**: **`view.audience` は撤去され、匿名も面(`app.roles[].rules`)で決まる。**
  // **面の既定は「規則を1本も書いていない対象は管轄外(全許可)」なので、規則を1本も
  // 書いていない題材では、匿名にもログイン済みと同じ集合が並ぶ。**
  // **【禁止の履行】これを「同じ挙動を保った」と書かない。向きは変わった。**
  // **本ファイルが測っている問い(掲載の宣言を持たないと本数が変わらない)は1ミリも
  // 変えていない** —— **匿名の枝でも `canUseView` との突き合わせで見る。**
  expect(visibleViewsForRole(ANONYMOUS, target).map((v) => v.id)).toEqual(
    target.app.views.filter((v) => canUseView(ANONYMOUS, target, v)).map((v) => v.id),
  );
  expect(visibleViewsForRole(ANONYMOUS, target)).toHaveLength(3);
});

test("限定3: 既定は「出す」 —— menu_listed を書かなかった画面は owner の一覧に並ぶ", () => {
  const listed = visibleViewsForRole("owner", manifest()).map((v) => v.id);
  expect(listed).toContain("member-list");
  expect(listed).toContain("member-detail");
});

// --- 限定4: AND 1本 -------------------------------------------------------------------

test("限定4: menu_listed: false の画面は owner の一覧から落ちる(1本だけ減る)", () => {
  const target = manifest();
  expect(visibleViewsForRole("owner", target).map((v) => v.id)).toEqual([
    "member-list",
    "member-detail",
  ]);
  expect(visibleViewsForRole("owner", undeclared())).toHaveLength(3);
});

test("限定4: 掲載の判定は canUseView との AND 1本であり、優先順位の規則を1つも持たない", () => {
  const source = readFileSync(join(WEB_ROOT, "src", "auth", "authz.tsx"), "utf8");
  // **AND の右辺は本キーの真偽だけである。**「どちらが勝つか」を表す語(else / 優先 /
  // override)を掲載の判定に1つも置かない。
  expect(source).toContain("canUseView(role, manifest, view) && isViewMenuListed(view)");
});

test("限定4: 匿名にも同じ AND が当たる(枝ごとに別の規則を作らない)", () => {
  const target = manifest();
  // **【`V8-M20` / `J-G27` で宣言の置き場を移した。旧の逐語を1バイトも消していない】**
  // **旧のコメント**: 「`audience` に `anonymous` を足したうえで、掲載だけを落とす。」
  // **旧の書き方**: 対象2画面に `audience: ["anonymous"]` を足していた。
  // **今日**: 面の規則(`app.roles[].rules` の `target: "view"` × `read`)で名指しする。
  // **`member-detail` を owner が名指ししているのは、面の既定が「名指しの無い画面は
  // 全員に見える」だからである**(旧は宣言を書かないだけで匿名から隠れていた)。
  target.app.roles = [
    {
      id: "anonymous",
      rules: [
        { target: "view", view: "order-detail", can: ["read"] },
        { target: "view", view: "member-list", can: ["read"] },
      ],
    },
    { id: "owner", rules: [{ target: "view", view: "member-detail", can: ["read"] }] },
  ];
  expect(visibleViewsForRole(ANONYMOUS, target).map((v) => v.id)).toEqual(["member-list"]);
  // **可否は変わっていない** —— 匿名でも `order-detail` は開ける。
  const orderDetail = target.app.views.find((v) => v.id === "order-detail") as View;
  expect(canUseView(ANONYMOUS, target, orderDetail)).toBe(true);
});

// --- 限定5: 可否を1ミリも変えない -----------------------------------------------------

test("限定5: canUseView は menu_listed: false の画面にも true を返す(遮断ではない)", () => {
  const target = manifest();
  const hidden = target.app.views.find((v) => v.id === "order-detail") as View;
  for (const role of ["owner", "editor", "viewer"] as const) {
    expect(canUseView(role, target, hidden)).toBe(true);
  }
});

test("限定5: 一覧から外した画面も、画面IDを直に指せば今日どおり描ける(行クリック / URL 直叩き)", () => {
  const target = manifest();
  const hidden = target.app.views.find((v) => v.id === "order-detail") as View;
  // **表示層は本キーを1ミリも見ない** —— 見るのは一覧を組む側だけである。
  render(
    <section>
      <h3>{hidden.name}</h3>
      <p data-testid="reachable">{canUseView("owner", target, hidden) ? "開ける" : "開けない"}</p>
    </section>,
  );
  expect(screen.getByTestId("reachable").textContent).toBe("開ける");
});

// --- 限定9: 2本目の「隠す」規則を作らない ---------------------------------------------

test("限定9: 一覧を組む場所は visibleViewsForRole 1本のままである(2本目の絞り込みを作らない)", () => {
  const workspace = readFileSync(join(WEB_ROOT, "src", "AppWorkspace.tsx"), "utf8");
  // **`menu_listed` の知識を画面側に1つも置かない**(`AppWorkspace.tsx` のコメントが
  // 「ここには可否の知識を1つも置かない」と書いており、実装後もそれが真であること)。
  expect(workspace).not.toContain("menu_listed");
});
