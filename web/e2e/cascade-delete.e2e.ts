/**
 * **親を消そうとしたときに、子が残っていることが画面で利用者に伝わり、その場でまとめて消せる**
 * (`V18-M7-T05` / `PM-G5` / `ADR-0444` §Decision 3 の ④ → ⑥。**`CP-V18` 条件13**)。
 *
 * ## この台を**新しく作った**理由(**既存の台に足さなかった**)
 *
 * **`ADR-0444` 授権の表 行22 は既存の4本(`web/test/detail-view.test.tsx` /
 * `web/test/row-grant-detail-buttons.test.tsx` / `web/e2e/detail-view.e2e.ts` /
 * `web/e2e/after-save-delete.e2e.ts`)を触ってよいと書いているが、**本ファイルはその4本を
 * 1バイトも触っていない**。** **理由は設計図である** ——
 *
 * | 既存の台 | 足せない理由 |
 * |---|---|
 * | `web/e2e/detail-view.e2e.ts` / `web/e2e/after-save-delete.e2e.ts` | **どちらも共有フィクスチャ
 *   (`web/e2e/fixture-app.ts` が読む1本の JSON)の上で動いており、親子関係(`access_control` の
 *   `inherit_from`)を1本も宣言していない。** **そこに宣言を足すと、同じフィクスチャを読む
 *   **ほかの e2e 全部**の行の見え方が変わる**(`access_control` を宣言した表は付与が無いと読めなく
 *   なる)—— **`ADR-0444` 授権の表 行8 の「`test(` の総数を減らさない」を守れない恐れがある。** |
 * | `web/e2e/access-control-servicedesk.e2e.ts` | **`inherit_from` を宣言している唯一の既存 e2e で
 *   あるが、**ブラウザを1枚も開いていない**(`APIRequestContext` だけで撃つ台である)。**
 *   **`CP-V18` 条件13 が問うているのは「**画面で**利用者に伝わること」なので、この台では測れない。** |
 *
 * **本ファイルは自分のアプリを `POST /api/apps/:app_id/diffs` で1本払い出す。**
 * **既存の台の設計図を1バイトも動かしていない。**
 *
 * ## 測る往復(**今日この往復を撃つ e2e は1本も無い**)
 *
 * **一覧 → 親の詳細 → 「削除」→「削除する」→ **サーバが件数つきで断る** → **件数と子の居る表が
 * 画面に出る** → 「中身ごとまとめて消す」→ 親も子も消える。**
 *
 * ## この台が証明しないこと(**誇張しない**)
 *
 * 1. **③(中に自分には消せない行がある)の画面を1度も開いていない。** **それを測っているのは
 *    `web/test/detail-delete-cascade.test.tsx` の (C) である。**
 * 2. **段(孫)を1段しか作っていない。** **`D-V18-32` の「いちばん下まで」を画面から押していない。**
 * 3. **`AI` の口・受信口・自動処理・島・時刻起動を1バイトも叩いていない**(`ADR-0444` 限定8)。
 * 4. **【禁止】これを「安全になった」と読まない** —— **止めているのはサーバであり、この台が測って
 *    いるのは「断りが画面に出て、利用者が選べる」ところまでである。**
 */
import { type APIRequestContext, expect, test } from "@playwright/test";
import { type FixtureApp, provisionApp } from "./fixture-app.ts";

const port = Number(process.env.ST_E2E_PORT ?? 3210);
const ORIGIN = `http://localhost:${port}`;

/** 親(`decks`)と子(`cards`)。**子だけが `inherit_from` を持つ。** */
const PARENT_TABLE = "decks";
const CHILD_TABLE = "cards";
const PARENT_LIST = "deck-list";
const PARENT_DETAIL = "deck-detail";

const PERMISSIONS = [
  { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
  { id: "remover", name: "消せる", read: true, write: true, delete: true },
] as const;

/** 保護対象の表に載せる宣言(`web/e2e/access-control-servicedesk.e2e.ts` と同じ形)。 */
function declaration(
  target: "deck" | "card",
  inheritFrom?: readonly string[],
): Record<string, unknown> {
  return {
    enabled: true,
    permissions: PERMISSIONS.map((permission) => ({ ...permission })),
    creator_permission: "remover",
    grant: {
      table: "cascade_grants",
      target,
      member: "member",
      group: "group",
      permission: "permission",
    },
    members: { table: "cascade_members", account: "account", group: "group" },
    groups: { table: "cascade_groups" },
    // **根の表には「行を作れる立場」を書く**(書かないと既定が「誰も作れない」である。`ADR-0432`)。
    // **引き継ぐ側に書くと適用時検査が差分ごと拒否する。**
    ...(inheritFrom === undefined
      ? { creatable_by_roles: ["owner", "editor"] }
      : { inherit_from: [...inheritFrom] }),
  };
}

/** 表5本と画面2枚。**参照される側を先に置く**(1つの差分に畳んで送るため)。 */
const OPERATIONS: readonly Record<string, unknown>[] = [
  {
    op: "add_table",
    table: {
      id: "cascade_groups",
      name: "グループ",
      fields: [{ id: "name", name: "名前", type: "text", required: true }],
    },
  },
  {
    op: "add_table",
    table: {
      id: "cascade_members",
      name: "メンバー",
      fields: [
        { id: "display_name", name: "表示名", type: "text", required: true },
        { id: "account", name: "ログインアカウント", type: "text" },
        { id: "group", name: "グループ", type: "reference", reference_table: "cascade_groups" },
      ],
    },
  },
  {
    op: "add_table",
    table: {
      id: PARENT_TABLE,
      name: "台帳",
      fields: [{ id: "title", name: "件名", type: "text", required: true }],
      access_control: declaration("deck"),
    },
  },
  {
    op: "add_table",
    table: {
      id: CHILD_TABLE,
      name: "明細",
      fields: [
        { id: "label", name: "内容", type: "text", required: true },
        { id: "deck", name: "台帳", type: "reference", reference_table: PARENT_TABLE },
      ],
      access_control: declaration("card", ["deck"]),
    },
  },
  {
    op: "add_table",
    table: {
      id: "cascade_grants",
      name: "付与",
      fields: [
        { id: "deck", name: "台帳", type: "reference", reference_table: PARENT_TABLE },
        { id: "card", name: "明細", type: "reference", reference_table: CHILD_TABLE },
        { id: "member", name: "相手", type: "reference", reference_table: "cascade_members" },
        { id: "group", name: "グループ", type: "reference", reference_table: "cascade_groups" },
        { id: "permission", name: "権限", type: "select", options: ["reader", "remover"] },
      ],
    },
  },
  {
    op: "add_view",
    view: { id: PARENT_LIST, type: "list_view", table: PARENT_TABLE, columns: ["title"] },
  },
  { op: "add_view", view: { id: PARENT_DETAIL, type: "detail_view", table: PARENT_TABLE } },
];

/** 親1件 + 子2件が入ったアプリを払い出す。 */
async function setup(
  request: APIRequestContext,
): Promise<{ app: FixtureApp; parentId: string; childIds: string[] }> {
  const app = await provisionApp(request);
  const applied = await request.post(`/api/apps/${app.appId}/diffs`, {
    data: {
      diff_id: "v18-m7-cascade-delete",
      intent: "V18-M7-T05 の画面実測用に、親子(inherit_from)を1段だけ持つアプリを入れる",
      operations: OPERATIONS,
    },
    headers: { ...app.authHeaders, origin: ORIGIN, "content-type": "application/json" },
  });
  expect(applied.status(), await applied.text()).toBe(201);

  // **owner 自身のメンバー行**(付与の相手として指せるようにする)。
  await app.createRecord("cascade_members", { display_name: "所有者", account: app.userId });
  const parentId = await app.createRecord(PARENT_TABLE, { title: "親の台帳" });
  const childIds = [
    await app.createRecord(CHILD_TABLE, { label: "明細その1", deck: parentId }),
    await app.createRecord(CHILD_TABLE, { label: "明細その2", deck: parentId }),
  ];
  return { app, parentId, childIds };
}

test("V18-M7-T05 —— 親を消そうとすると子の件数が画面に出て、そのまま中身ごと消せる", async ({
  page,
  context,
  request,
}) => {
  const { app, parentId, childIds } = await setup(request);
  await app.authenticate(context);

  const detailUrl = `/apps/${app.appId}/views/${PARENT_DETAIL}/records/${parentId}`;
  await page.goto(detailUrl);
  await expect(page.getByTestId("view-renderer-detail_view")).toBeVisible();

  // --- 1つ目の状態(着手前と1バイトも同じ)----------------------------------------
  await page.getByTestId("detail-delete").click();
  await expect(page.getByTestId("detail-delete-confirm")).toBeVisible();
  await expect(page.getByTestId("detail-delete-confirm")).toContainText(
    "このレコードを削除します。元に戻せません。",
  );
  // **断られる前に2つ目の状態は1つも出ていない。**
  await expect(page.getByTestId("detail-delete-children")).toHaveCount(0);

  // --- 断られる → 2つ目の状態(件数)---------------------------------------------
  await page.getByTestId("detail-delete-execute").click();

  // **【`CP-V18` 条件13】** **子が残っていることが、件数と表のIDで画面に出る。**
  const children = page.getByTestId("detail-delete-children");
  await expect(children).toBeVisible();
  await expect(children).toContainText("2 件");
  await expect(children).toContainText(CHILD_TABLE);
  await expect(children).toContainText("取り消しでは戻りません");
  // **パネルは閉じていない。1つ目のボタンは消え、2つ目に置き換わっている。**
  await expect(page.getByTestId("detail-delete-confirm")).toBeVisible();
  await expect(page.getByTestId("detail-delete-execute")).toHaveCount(0);
  await expect(page.getByTestId("detail-delete-children-execute")).toHaveText(
    "中身ごとまとめて消す",
  );
  // **版不一致の表示に吸われていない**(吸われると利用者は版を直しに行ってしまう)。
  await expect(page.getByTestId("write-conflict")).toHaveCount(0);
  await expect(page.getByTestId("write-forbidden")).toHaveCount(0);

  // **【1行も消えていない】** **断られただけの時点で、親も子も残っている。**
  expect(
    (
      await request.get(`/api/apps/${app.appId}/tables/${PARENT_TABLE}/records/${parentId}`, {
        headers: app.authHeaders,
      })
    ).status(),
  ).toBe(200);
  await expect(page).toHaveURL(new RegExp(`${detailUrl}$`));

  // --- 「中身ごとまとめて消す」→ 親も子も消える ------------------------------------
  await page.getByTestId("detail-delete-children-execute").click();
  await expect(page).toHaveURL(new RegExp(`/apps/${app.appId}/views/${PARENT_LIST}$`));
  await expect(page.getByTestId("list-row")).toHaveCount(0);

  // **画面の見かけだけでないことを API でも確かめる。**
  const parentAfter = await request.get(
    `/api/apps/${app.appId}/tables/${PARENT_TABLE}/records/${parentId}`,
    { headers: app.authHeaders },
  );
  expect(parentAfter.status()).toBe(404);
  for (const childId of childIds) {
    const childAfter = await request.get(
      `/api/apps/${app.appId}/tables/${CHILD_TABLE}/records/${childId}`,
      { headers: app.authHeaders },
    );
    expect(childAfter.status(), await childAfter.text()).toBe(404);
  }
});
