/**
 * **表示層のボタンの判定とサーバのボタンの判定を、同じ入力で突き合わせる**
 * (`V8-M20` の後始末。**`scripts/ref-ec/audience-crosscheck.test.ts` の置き直しである**)。
 *
 * ## 置き直す前に何が在ったか(**逐語で残す。`ADR-0301` 限定8 の作法**)
 *
 * **`scripts/ref-ec/audience-crosscheck.test.ts`(4テスト)がここに在った。** そのヘッダの逐語:
 *
 * > **表示層の判定(`isActionAudienceAllowed`)とサーバの判定(`isViewAudienceAllowed`)が
 * > 同じ結果を返すことは、今日も1件も測られていない**(`ADR-0241` §限界2)。
 * > **突き合わせるべき理由は、同じオブジェクトが両方に渡るからである。**
 * > **述語は2本あり、実装は別ファイルにある。**
 *
 * **消したテスト名(逐語)**:
 *  - `(X-1) 突き合わせた組合せの総数は 12 宣言 × 6 ロール = 72 である`
 *  - `(X-2) 食い違う組合せを全件列挙する(丸めない)`
 *  - `(X-3) ログイン済みのロード(\`role !== null\`)に限れば、食い違いは 0 件である`
 *  - `(X-4) 対照: 2つの述語は、同じ入力に対して実際に別々の答えを出しうる`
 *
 * **消した理由**: **両方の述語が今日1つも存在しない。** **`isViewAudienceAllowed` は
 * `V8-M20`(台帳 `J-G27`)が撤去し、`web/src/views/action-audience.ts` はファイルごと
 * 消えた**(`web/src/auth/authz.tsx` の逐語:「**`web/src/views/action-audience.ts`
 * (表示層の再実装)を消した代わりである。** … **今日は表示層に判定を1バイトも持たない**
 * —— **サーバと同じ `judgeRoleAccess` を呼ぶ。**」)。
 *
 * ## このファイルが測るもの(**問いの形は変えていない。答えの前提が変わった**)
 *
 * **旧は「述語が2本ある。食い違いを全件列挙する」だった。**
 * **今日は「述語が1本しかない。表示層とサーバが本当に同じ1本を見ているか」である。**
 *
 *  1. **(Y-1)** **宣言 × ロールの全組合せ**で、表示層の `canUseAction` と、サーバの入口が
 *     使う判定(`judgeRoleAccess` の `target: "action"` × `read`)の答えを突き合わせる。
 *     **食い違いを「無い」と決めつけていない** —— **在れば表に出す。**
 *  2. **(Y-2)** **表示層が判定を再実装していない**ことを、ソースをテキストとして読んで固定する。
 *     **(Y-1) は「今日たまたま一致していること」しか言えない** —— **表示層が明日自前の
 *     読み方を書いても、値が同じなら緑のままである。** **その形そのものをここで止める。**
 *  3. **(Y-3)** **対照**: 述語が空回りしていない(同じ入力で実際に答えが割れる組がある)。
 *
 * ## 測っていないこと(誇張しない)
 *
 * - **HTTP を1度も通していない。** 呼んでいるのは2つの関数である。
 * - **ブラウザを1度も開いていない。**
 * - **画面単位(`target: "view"`)と項目単位(`target: "field"`)の突合をしていない。**
 *   **測ったのはボタン1本ぶんの規則だけである**(旧ファイルと同じ範囲)。
 * - **書込の壁(`isRoleActionWriteAllowed`)を1件も測っていない** ——
 *   **それは `checkout-journey.test.ts` の (E) 群が本物の HTTP で測っている。**
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Manifest, RoleDeclaration } from "../../src/kernel/types.ts";
import { type ActorRoles, judgeRoleAccess } from "../../src/server/owner-scope.ts";
import { canUseAction } from "../../web/src/auth/authz.tsx";

const REPO_ROOT = dirname(dirname(import.meta.dir));

/** 突き合わせる入力を作る。**画面1枚 + ボタン1本**の最小形。 */
function manifestWith(roles: RoleDeclaration[]): Manifest {
  return {
    app: {
      id: "role-crosscheck",
      name: "面の突合",
      tables: [{ id: "item", name: "もの", fields: [{ id: "name", name: "名前", type: "text" }] }],
      views: [
        {
          id: "item-list",
          type: "list_view",
          name: "もの一覧",
          table: "item",
          columns: ["name"],
          actions: [{ id: "act", form: "item-form", prefill: { field: "ref" }, name: "足す" }],
        },
      ],
      roles,
    },
  } as unknown as Manifest;
}

/** 突き合わせる宣言。**規則なし**と**空でない規則**を混ぜない。 */
const DECLARATIONS: readonly { label: string; roles: RoleDeclaration[] }[] = [
  { label: "役割を1つも宣言していない", roles: [] },
  {
    label: "規則を1本も持たない役割だけ",
    roles: [{ id: "owner" }, { id: "editor" }, { id: "viewer" }],
  },
  {
    label: '["owner"] に読取',
    roles: [
      {
        id: "owner",
        rules: [{ target: "action", view: "item-list", action: "act", can: ["read"] }],
      },
      { id: "editor" },
      { id: "viewer" },
    ],
  },
  {
    label: '["customer"] に読取',
    roles: [
      { id: "owner" },
      { id: "editor" },
      { id: "viewer" },
      {
        id: "customer",
        rules: [{ target: "action", view: "item-list", action: "act", can: ["read"] }],
      },
    ],
  },
  {
    label: '["owner","customer"] に読取',
    roles: [
      {
        id: "owner",
        rules: [{ target: "action", view: "item-list", action: "act", can: ["read"] }],
      },
      { id: "editor" },
      { id: "viewer" },
      {
        id: "customer",
        rules: [{ target: "action", view: "item-list", action: "act", can: ["read"] }],
      },
    ],
  },
  {
    label: '["anonymous"] に読取(未ログインの主体を名指しする)',
    roles: [
      { id: "owner" },
      { id: "editor" },
      { id: "viewer" },
      {
        id: "anonymous",
        rules: [{ target: "action", view: "item-list", action: "act", can: ["read"] }],
      },
    ],
  },
  {
    label: "別のボタンだけを名指しした規則(この起点は管轄外)",
    roles: [
      {
        id: "owner",
        rules: [{ target: "action", view: "item-list", action: "other", can: ["read"] }],
      },
      { id: "editor" },
      { id: "viewer" },
    ],
  },
];

/** 突き合わせるロール。**`null` は「未ログイン」である。** */
const ROLES: readonly (string | null)[] = [null, "owner", "editor", "viewer", "customer"];

type Divergence = { declaration: string; role: string; display: boolean; server: boolean };

/**
 * **サーバの入口がボタンについて下している判定**(`src/server/app.ts` の手動起動の入口の逐語)。
 *
 * **識別子(`id`)を書いていない起点は面から名指しできないので管轄外(全許可)である** ——
 * **その分岐まで写す**(写さないと、突合が「入口の形」ではなく「述語の形」だけを見てしまう)。
 */
function serverAllowsAction(
  manifest: Manifest,
  viewId: string,
  action: unknown,
  roles: ActorRoles,
): boolean {
  const actionId = (action as { id?: unknown } | null | undefined)?.id;
  if (typeof actionId !== "string") {
    return true;
  }
  return judgeRoleAccess({
    manifest,
    roles,
    target: { target: "action", view: viewId, action: actionId },
    verb: "read",
  }).allowed;
}

function collectDivergences(): Divergence[] {
  const found: Divergence[] = [];
  for (const { label, roles } of DECLARATIONS) {
    const manifest = manifestWith(roles);
    const action = (manifest.app.views[0] as unknown as { actions: Record<string, unknown>[] })
      .actions[0];
    for (const role of ROLES) {
      const display = canUseAction(
        manifest,
        "item-list",
        action,
        role as Parameters<typeof canUseAction>[3],
      );
      const server = serverAllowsAction(manifest, "item-list", action, role as ActorRoles);
      if (display !== server) {
        found.push({ declaration: label, role: role ?? "(未ログイン)", display, server });
      }
    }
  }
  return found;
}

test("(Y-1) 突き合わせた組合せの総数は 7 宣言 × 5 ロール = 35 で、食い違いは全件列挙する", () => {
  expect(DECLARATIONS.length * ROLES.length).toBe(35);
  // **食い違いを「無い」と決めつけていない。** **在れば、そのまま失敗の本文に出る。**
  //
  // **【実測: 0 件である。旧ファイルは 2 件だった】** **旧の 2 件は「`anonymous` を含む
  // 宣言 × 未ログイン」で、表示層が `role === null` を中身を見ずに `false` に倒していた
  // ことによる**(旧ファイルの doc の逐語)。**今日その分岐は表示層に無い** ——
  // **`canUseAction` は未ログインを `roles: null` として同じ `judgeRoleAccess` へ渡し、
  // 面はそれを `anonymous` という主体として判定する**(`J-G11`)。
  expect(collectDivergences()).toEqual([]);
});

test("(Y-2) 表示層は判定を1バイトも再実装していない(サーバの述語を import している)", () => {
  const authz = readFileSync(join(REPO_ROOT, "web", "src", "auth", "authz.tsx"), "utf-8");
  // **サーバの述語を import している。**
  expect(authz).toContain("judgeRoleAccess");
  expect(authz).toContain('from "../../../src/server/owner-scope.ts"');
  // **規則を自分で読んでいない** —— **`rules` / `can` / `target` を読むコードが1行も無い。**
  // **コメントの中の綴りは数に入れない**ため、`//` と ` * ` で始まる行を落としてから数える。
  const code = authz
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !(trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*"));
    })
    .join("\n");
  for (const spelling of [".rules", '"can"', ".can", "role.rules"]) {
    expect(code.includes(spelling), `表示層が規則を自分で読んでいる: ${spelling}`).toBe(false);
  }
});

test("(Y-3) 対照: 同じ入力で答えが実際に割れる(突合器が空回りしていない)", () => {
  const manifest = manifestWith([
    {
      id: "owner",
      rules: [{ target: "action", view: "item-list", action: "act", can: ["read"] }],
    },
    { id: "editor" },
    { id: "viewer" },
  ]);
  const action = (manifest.app.views[0] as unknown as { actions: unknown[] }).actions[0];
  expect(
    canUseAction(manifest, "item-list", action, "owner" as Parameters<typeof canUseAction>[3]),
  ).toBe(true);
  expect(
    canUseAction(manifest, "item-list", action, "customer" as Parameters<typeof canUseAction>[3]),
  ).toBe(false);
  expect(serverAllowsAction(manifest, "item-list", action, "owner")).toBe(true);
  expect(serverAllowsAction(manifest, "item-list", action, "customer" as ActorRoles)).toBe(false);
});
