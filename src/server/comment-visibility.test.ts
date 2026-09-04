/**
 * コメントの見える相手の合成の検査(`V10-M11-T02` / `CM-G5` / `ADR-0007` §8 台帳 `:1638`)。
 *
 * ## この検査が測るもの(先に書く)
 *
 * 1. **その画面を読める利用者にはその画面宛てのコメントが見え、読めない利用者には
 *    1件も見えないこと**(完了条件 (1))。
 * 2. **件数(`total`)も可視集合から採ること**(完了条件 (2) / `CM-G5` 限定5)。
 * 3. **アプリ全体宛てのコメントは、アプリの作りを書き換えられる人にだけ見えること**
 *    (完了条件 (3) / `CM-G5` 限定3)。
 * 4. **宛先の画面を `remove_view` で消したあとの3点**(完了条件 (4))。
 *    **(c) はメインの裁定5 により読み替えている** —— 後述。
 * 5. **役割の規則を1本も宣言していないアプリでは1人にも見えないこと**(完了条件 (6))。
 * 6. **名乗りの無い相手には1件も見えないこと**(メインの裁定3)。
 *
 * ## この検査が測らないもの(誇張しない)
 *
 * - **HTTP の口も MCP の道具も1本も叩いていない。** **`V10-M11-T02` の時点で
 *   コメントを読み出せる経路は1本も存在しない** —— 読出の HTTP は `V10-M15-T05`、
 *   MCP の道具は `V10-M12-T01` の持ち物である。**したがって本検査は合成関数の単体と、
 *   器(`kernel.sqlite`)の直読みだけで打っている。**
 *   **【禁止】これを「画面で読み分けられることを確かめた」と読まない。**
 * - **ブラウザを1度も開いていない。**
 *
 * ## 読み替えた点(**黙って落とさない**)
 *
 * - **完了条件 (4) の (c)「それ以外には見えない」は、実物の `remove_view` では成立しない。**
 *   `foldRemoveView` は `app.views` から1要素を抜くだけで、その画面を名指しした
 *   役割の規則を1本も外さない。**メインの裁定5 により (c) を
 *   「`set_roles` で規則を書き戻さないかぎり、その画面を読めた役割には今日どおり見える」
 *   に読み替えた。** 本ファイルの検査4 は、**実物の `remove_view` を当てたマニフェスト**で
 *   その読み替え後の文を打ち、**`set_roles` で規則を書き戻すと見えなくなること**を
 *   陽性対照として並べる(**規則を手で外した題材は使わない**)。
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldOperations } from "../kernel/apply-diff.ts";
import { COMMENT_ANCHOR_FORMS, type Comment, CommentStore } from "../kernel/comment-store.ts";
import type { Manifest, Operation } from "../kernel/index.ts";
import { visibleComments } from "./comment-visibility.ts";
import { type ActorRoles, judgeRoleAccess } from "./owner-scope.ts";

const APP_ID = "shop";

type LooseRule = Record<string, unknown>;
type LooseRole = { id: string; name: string; rules?: LooseRule[] };

/**
 * 持ち主に必ず入る2行(`src/kernel/create-app.ts` の `OWNER_DEFAULT_RULES` と同じ形)。
 * **アプリの作りを書き換えられる人**は、この1行目を持つ人である。
 */
const OWNER_DEFINITION_RULES: readonly LooseRule[] = [
  { target: "app", can: ["write"] },
  { target: "role", can: ["write"] },
];

/** 役割の宣言と画面の並びだけを持つ題材(合成は表も行も1度も見ない)。 */
function manifestOf(roles: readonly LooseRole[] | undefined, viewIds: readonly string[]): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "店",
      tables: [
        { id: "items", name: "商品", fields: [{ id: "title", name: "名前", type: "text" }] },
      ],
      views: viewIds.map((id) => ({
        id,
        name: id,
        type: "list_view",
        table: "items",
        columns: ["title"],
      })),
      ...(roles === undefined ? {} : { roles }),
    },
  } as unknown as Manifest;
}

/** 主題の題材 —— 画面2本(`cart` / `admin`)と役割3本。 */
function shopManifest(): Manifest {
  return manifestOf(
    [
      {
        id: "owner",
        name: "持ち主",
        rules: [
          ...OWNER_DEFINITION_RULES,
          { target: "view", view: "cart", can: ["read"] },
          { target: "view", view: "admin", can: ["read"] },
        ],
      },
      {
        id: "customer",
        name: "客",
        rules: [{ target: "view", view: "cart", can: ["read"] }],
      },
      // **規則を1本も持たない役割。** `cart` は `customer` の規則が名指ししているので
      // 管轄内(`governed: true`)であり、この人は閉じる側に落ちる。
      { id: "viewer", name: "閲覧者", rules: [] },
    ],
    ["cart", "admin"],
  );
}

/** 器を一時ディレクトリに開いて処理し、必ず閉じる(`data/` を1バイトも汚さない)。 */
function withStore<T>(run: (store: CommentStore) => T): T {
  const dataRoot = mkdtempSync(join(tmpdir(), "gp-comment-visibility-"));
  const store = CommentStore.openForKernel(dataRoot);
  try {
    return run(store);
  } finally {
    store.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

/** 主題の4件を器に積む(積んだ順に返す)。 */
function seedComments(store: CommentStore): Comment[] {
  return [
    store.addComment({
      appId: APP_ID,
      anchorForm: "view",
      anchorParts: ["cart"],
      body: "カートの画面が使いにくい",
    }),
    store.addComment({
      appId: APP_ID,
      anchorForm: "view_action",
      anchorParts: ["cart", "checkout"],
      body: "会計のボタンが押しにくい",
    }),
    store.addComment({
      appId: APP_ID,
      anchorForm: "view",
      anchorParts: ["admin"],
      body: "管理画面の一覧が長い",
    }),
    store.addComment({
      appId: APP_ID,
      anchorForm: "app",
      anchorParts: [],
      body: "アプリ全体の配色を変えたい",
    }),
  ];
}

/** 見えた本文の並び(実出力として読める形で残すため)。 */
function bodiesOf(comments: readonly Comment[]): string[] {
  return comments.map((comment) => comment.body);
}

/**
 * 見えた本文を**並べ替えて**返す。
 *
 * **`listComments` は `created_at` 昇順(同時刻は `id` 昇順)で返す。**
 * 同じミリ秒に積んだ4件はランダムな uuid の順に並ぶので、
 * **「どれが見えるか」を問う検査は並びを問わない形で打つ**
 * (このリポジトリで既に踏んだ躓きである)。
 */
function sortedBodiesOf(comments: readonly Comment[]): string[] {
  return bodiesOf(comments).sort();
}

// --- 1. 画面ごとに割れる -------------------------------------------------------------

test("V10-M11-T02: その画面を読める利用者にはその画面宛てのコメントが見え、読めない利用者には1件も見えない", () => {
  withStore((store) => {
    const seeded = seedComments(store);
    const manifest = shopManifest();
    const comments = store.listComments(APP_ID);
    expect(comments).toHaveLength(4);

    // `cart` を読める `customer` —— `cart` 宛ての2件だけが見える。
    const customer = visibleComments({ manifest, roles: ["customer"], comments });
    expect(sortedBodiesOf(customer)).toEqual(
      ["カートの画面が使いにくい", "会計のボタンが押しにくい"].sort(),
    );
    expect(customer.map((comment) => comment.id).sort()).toEqual(
      [seeded[0]?.id ?? "", seeded[1]?.id ?? ""].sort(),
    );

    // どの画面も読めない `viewer` —— 1件も見えない。
    const viewer = visibleComments({ manifest, roles: ["viewer"], comments });
    expect(viewer).toEqual([]);
  });
});

// --- 2. 件数も割れる(母集団を割らない)----------------------------------------------

test("V10-M11-T02: 見えない相手では total が 0 で、見える相手では 0 でない(母集団を割らない)", () => {
  withStore((store) => {
    seedComments(store);
    const manifest = shopManifest();
    const comments = store.listComments(APP_ID);

    // **`total` は可視集合の長さそのものである**(`CM-G5` 限定5。
    // 合成が `Comment[]` しか返さないので、呼び出し側は母集団を数えようがない)。
    const viewerTotal = visibleComments({ manifest, roles: ["viewer"], comments }).length;
    const customerTotal = visibleComments({ manifest, roles: ["customer"], comments }).length;
    const ownerTotal = visibleComments({ manifest, roles: ["owner"], comments }).length;

    expect(viewerTotal).toBe(0);
    // **陽性対照**: 同じ器・同じ4件に対して、見える相手の値は 0 でない。
    expect(customerTotal).toBe(2);
    expect(ownerTotal).toBe(4);
    // **母集団(器の件数)は 4 のままで、誰にも割られていない。**
    expect(comments).toHaveLength(4);
    expect(viewerTotal).toBeLessThan(comments.length);
  });
});

// --- 3. アプリ全体宛て ----------------------------------------------------------------

test("V10-M11-T02: アプリ全体宛て(app)のコメントは、app×write を持つ人にだけ見える", () => {
  withStore((store) => {
    seedComments(store);
    const manifest = shopManifest();
    const comments = store.listComments(APP_ID);
    const appBodies = (roles: string[]): string[] =>
      bodiesOf(
        visibleComments({ manifest, roles, comments }).filter(
          (comment) => comment.anchorForm === "app",
        ),
      );

    expect(appBodies(["owner"])).toEqual(["アプリ全体の配色を変えたい"]);
    expect(appBodies(["customer"])).toEqual([]);
    expect(appBodies(["viewer"])).toEqual([]);

    // **写し先の確認**: 見えているのは `{target:"app"}` × `write` によってである。
    expect(
      judgeRoleAccess({ manifest, roles: ["owner"], target: { target: "app" }, verb: "write" })
        .allowed,
    ).toBe(true);
    expect(
      judgeRoleAccess({ manifest, roles: ["customer"], target: { target: "app" }, verb: "write" })
        .allowed,
    ).toBe(false);
  });
});

// --- 4. `remove_view` の後(**裁定5 で (c) を読み替えている**)-------------------------

test("V10-M11-T02: 宛先の画面を remove_view で消してもコメントは消えず、app×write を持つ人には見え、その画面を読めた役割には set_roles で書き戻さないかぎり今日どおり見える", () => {
  withStore((store) => {
    seedComments(store);
    const before = store.listComments(APP_ID);
    expect(before).toHaveLength(4);

    // **実物の `remove_view` を当てる**(`roles` は1バイトも手で触らない)。
    const removed = foldOperations(shopManifest(), [
      { op: "remove_view", view: "cart" },
    ] as Operation[]);
    expect(removed.valid).toBe(true);
    if (!removed.valid) {
      return;
    }
    const manifest = removed.manifest;
    expect(manifest.app.views.map((view) => view.id)).toEqual(["admin"]);
    // **役割の規則は1本も外れていない**(`foldRemoveView` は `app.roles` を1文字も触らない)。
    const customerRules = (manifest.app.roles ?? []).find((role) => role.id === "customer")?.rules;
    expect(customerRules).toEqual([{ target: "view", view: "cart", can: ["read"] }]);

    // (a) コメントは1件も消えていない。
    const after = store.listComments(APP_ID);
    expect(after).toHaveLength(4);
    expect(bodiesOf(after)).toEqual(bodiesOf(before));

    // (b) アプリの作りを書き換えられる人には今日どおり全部見える。
    expect(visibleComments({ manifest, roles: ["owner"], comments: after })).toHaveLength(4);

    // (c) **読み替え後の文** —— 規則を書き戻していないので、`cart` を読めた `customer` には
    //     消した画面宛ての2件が今日どおり見える。
    expect(
      sortedBodiesOf(visibleComments({ manifest, roles: ["customer"], comments: after })),
    ).toEqual(["カートの画面が使いにくい", "会計のボタンが押しにくい"].sort());
    // その画面を読めなかった人は、消した後も見えないままである。
    expect(visibleComments({ manifest, roles: ["viewer"], comments: after })).toEqual([]);

    // **陽性対照**: `set_roles` で規則を書き戻すと、はじめて見えなくなる。
    const rewritten = foldOperations(manifest, [
      {
        op: "set_roles",
        roles: [
          { id: "owner", name: "持ち主", rules: [...OWNER_DEFINITION_RULES] },
          { id: "customer", name: "客", rules: [] },
          { id: "viewer", name: "閲覧者", rules: [] },
        ],
      },
    ] as unknown as Operation[]);
    expect(rewritten.valid).toBe(true);
    if (!rewritten.valid) {
      return;
    }
    expect(
      visibleComments({ manifest: rewritten.manifest, roles: ["customer"], comments: after }),
    ).toEqual([]);
    // 書き戻した後も、アプリの作りを書き換えられる人には全部見える。
    expect(
      visibleComments({ manifest: rewritten.manifest, roles: ["owner"], comments: after }),
    ).toHaveLength(4);
  });
});

// --- 5. 規則を1本も宣言していないアプリ ----------------------------------------------
//
// **【`V10-M27-T01b`(2026-08-25。`ADR-0375`)。この節の主張が反転した】**
// **制定時(`V10-M11-T02`)のテスト名と式は「1人にも見えない」を固定していた。**
// **旧のテスト名(逐語。ここに写して残す)**:
//   `"V10-M11-T02: 役割の規則を1本も宣言していないアプリでは、1人にも見えない"`
// **今日の正は「全員に見える」である** —— **テスト名も式も、今日の正に合わせて書き直した**
// (名前だけ古い逐語が残ると、緑のままテスト名が嘘になる)。

test("V10-M27-T01b: 役割の規則を1本も宣言していないアプリでは、名乗りの有無を問わず全員に全件見える", () => {
  withStore((store) => {
    seedComments(store);
    const comments = store.listComments(APP_ID);

    // (i) `app.roles` そのものが無い題材。
    const noRoles = manifestOf(undefined, ["cart", "admin"]);
    for (const roles of [["owner"], ["customer"], ["viewer"], ["editor"]]) {
      expect(visibleComments({ manifest: noRoles, roles, comments })).toEqual(comments);
    }

    // (ii) 役割は3つ宣言しているが、規則を1本も持たない題材。
    const noRules = manifestOf(
      [
        { id: "owner", name: "持ち主", rules: [] },
        { id: "editor", name: "編集者", rules: [] },
        { id: "viewer", name: "閲覧者", rules: [] },
      ],
      ["cart", "admin"],
    );
    for (const roles of [["owner"], ["editor"], ["viewer"]]) {
      expect(visibleComments({ manifest: noRules, roles, comments })).toEqual(comments);
    }
    // **器の側は1件も減っていない** —— 4件在り、4件とも返っている。
    expect(store.listComments(APP_ID)).toHaveLength(4);
  });
});

// --- 5b. `V10-M27-T01b`: 開く条件は2つの AND である ------------------------------------
//
// **(i) 定義が読めていること / (ii) 規則の要素の総数が 0 であること。**
// **(i) を落とすと、定義が壊れて読めないアプリのコメントが全件見えてしまう** ——
// **`src/server/app.ts` の `manifestFor` が、読めないアプリで `undefined` を返すためである。**
// **下の陰性対照がそれを固定する。**

/** 規則を1本も持たない役割を3つ宣言した題材(`app.roles` は在る)。 */
function unruledManifest(): Manifest {
  return manifestOf(
    [
      { id: "owner", name: "持ち主", rules: [] },
      { id: "editor", name: "編集者", rules: [] },
      { id: "viewer", name: "閲覧者", rules: [] },
    ],
    ["cart", "admin"],
  );
}

test("V10-M27-T01b: 規則ゼロのアプリでは、名乗りが null / 空 / 持ち主 / 見知らぬ1語 の4通りとも全件返る", () => {
  withStore((store) => {
    seedComments(store);
    const comments = store.listComments(APP_ID);
    expect(comments).toHaveLength(4);
    // **`roles` の4通り。** `null` と `[]` は名乗りが1つも無い相手(未ログイン)であり、
    // **制定時の短絡はここで 0件 に倒していた。**
    const audiences: ActorRoles[] = [null, [], ["owner"], ["stranger"]];
    for (const roles of audiences) {
      // `app.roles` そのものが無い題材。
      expect(
        visibleComments({ manifest: manifestOf(undefined, ["cart", "admin"]), roles, comments }),
      ).toEqual(comments);
      // 役割は在るが規則が1本も無い題材。
      expect(visibleComments({ manifest: unruledManifest(), roles, comments })).toEqual(comments);
    }
    // **返るのは新しい配列であって、渡した配列そのものではない**(呼び出し側が並びを壊せない)。
    const returned = visibleComments({ manifest: unruledManifest(), roles: null, comments });
    expect(returned).not.toBe(comments);
  });
});

test("V10-M27-T01b: 陰性対照 —— 定義が読めないアプリは今日どおり閉じる(規則が0本に見えても開かない)", () => {
  withStore((store) => {
    seedComments(store);
    const comments = store.listComments(APP_ID);
    // **`manifestFor` が読めないアプリで返す値がこれである。**
    const unreadable: unknown[] = [undefined, null, {}, "shop", 42, true, [], { app: null }];
    for (const manifest of unreadable) {
      for (const roles of [null, [], ["owner"], ["stranger"]] as ActorRoles[]) {
        expect(visibleComments({ manifest, roles, comments })).toEqual([]);
      }
    }
  });
});

test("V10-M27-T01b: 陽性対照 —— 規則が1本でも在れば、着手前と1件も変わらない", () => {
  withStore((store) => {
    seedComments(store);
    const comments = store.listComments(APP_ID);
    // 規則が **1本だけ** の題材(残る2役割は0本)。**総数が 0 でないので開かない。**
    const oneRule = manifestOf(
      [
        { id: "owner", name: "持ち主", rules: [] },
        { id: "editor", name: "編集者", rules: [{ target: "view", view: "cart", can: ["read"] }] },
        { id: "viewer", name: "閲覧者", rules: [] },
      ],
      ["cart", "admin"],
    );
    // 未ログインは今日どおり0件。
    expect(visibleComments({ manifest: oneRule, roles: null, comments })).toEqual([]);
    // 規則を持たない役割も今日どおり0件。
    expect(visibleComments({ manifest: oneRule, roles: ["viewer"], comments })).toEqual([]);
    // その1本を持つ役割にだけ、`cart` 宛ての2件が見える。
    expect(visibleComments({ manifest: oneRule, roles: ["editor"], comments })).toHaveLength(2);
    // 主題の題材(規則が複数本)でも、着手前と同じ形のまま。
    expect(visibleComments({ manifest: shopManifest(), roles: null, comments })).toEqual([]);
    expect(visibleComments({ manifest: shopManifest(), roles: ["viewer"], comments })).toEqual([]);
    expect(
      visibleComments({ manifest: shopManifest(), roles: ["customer"], comments }),
    ).toHaveLength(2);
    expect(visibleComments({ manifest: shopManifest(), roles: ["owner"], comments })).toHaveLength(
      4,
    );
  });
});

// --- 6. 名乗りの無い相手(**裁定3。短絡を置いた側**)-----------------------------------

test("V10-M11-T02: 名乗りの無い相手(未ログイン)には、anonymous に read を宣言したアプリでも1件も見えない", () => {
  withStore((store) => {
    seedComments(store);
    const comments = store.listComments(APP_ID);

    // (i) `anonymous` を1行も宣言していない題材。
    expect(visibleComments({ manifest: shopManifest(), roles: null, comments })).toEqual([]);

    // (ii) **`anonymous` に画面の読取とアプリの書換の両方を宣言した題材。**
    //      **合成の先頭の短絡が閉じるので、ここでも1件も見えない。**
    const anonDeclared = manifestOf(
      [
        {
          id: "owner",
          name: "持ち主",
          rules: [...OWNER_DEFINITION_RULES, { target: "view", view: "cart", can: ["read"] }],
        },
        {
          id: "anonymous",
          name: "名乗らない人",
          rules: [
            { target: "view", view: "cart", can: ["read"] },
            { target: "view", view: "admin", can: ["read"] },
            { target: "app", can: ["write"] },
          ],
        },
      ],
      ["cart", "admin"],
    );
    expect(visibleComments({ manifest: anonDeclared, roles: null, comments })).toEqual([]);
    expect(visibleComments({ manifest: anonDeclared, roles: [], comments })).toEqual([]);

    // **陽性対照(短絡が効いていることの証拠)** —— 同じ題材・同じ相手で、
    // 判定そのものは通してしまう。閉じているのは合成の先頭の短絡である。
    expect(
      judgeRoleAccess({
        manifest: anonDeclared,
        roles: null,
        target: { target: "view", view: "cart" },
        verb: "read",
      }).allowed,
    ).toBe(true);
    expect(
      judgeRoleAccess({
        manifest: anonDeclared,
        roles: null,
        target: { target: "app" },
        verb: "write",
      }).allowed,
    ).toBe(true);

    // **陰性対照** —— 名乗りが在れば、同じ題材で見える。
    expect(visibleComments({ manifest: anonDeclared, roles: ["owner"], comments })).toHaveLength(4);
  });
});

// --- 7. 画面宛ての形は、形の登録簿から回す(**裁定8。手書きの配列を持たない**)---------

test("V10-M11-T02: 画面宛ての形(登録簿から app を除いた全部)は、同じ画面・同じ相手に対して同じ可否になる", () => {
  const viewForms = COMMENT_ANCHOR_FORMS.filter((entry) => entry.form !== "app");
  // **数も登録簿から導く。** 着手前値は 10(`COMMENT_ANCHOR_FORMS` は今日11形)。
  expect(viewForms).toHaveLength(COMMENT_ANCHOR_FORMS.length - 1);
  // **画面宛ての形は、部品の先頭がすべて `view_id` である**(合成が `anchorParts[0]` を
  // 画面IDとして渡せる根拠)。
  for (const entry of viewForms) {
    expect(entry.parts[0]).toBe("view_id");
  }

  withStore((store) => {
    for (const entry of viewForms) {
      const parts = entry.parts.map((part, index) => (index === 0 ? "cart" : `${part}-1`));
      store.addComment({
        appId: APP_ID,
        anchorForm: entry.form,
        anchorParts: parts,
        body: `${entry.form} への意見`,
      });
    }
    const manifest = shopManifest();
    const comments = store.listComments(APP_ID);
    expect(comments).toHaveLength(viewForms.length);

    // `cart` を読める人には、形が何であれ全部見える。
    const customer = visibleComments({ manifest, roles: ["customer"], comments });
    expect(customer.map((comment) => comment.anchorForm).sort()).toEqual(
      viewForms.map((entry) => entry.form).sort(),
    );
    // `cart` を読めない人には、形が何であれ1件も見えない。
    expect(visibleComments({ manifest, roles: ["viewer"], comments })).toEqual([]);
  });
});

// --- 8.(裁定4)条件つきでしか読めない相手 ------------------------------------------

test("V10-M11-T02: 条件つき(when)でしか画面を読めない相手には、その画面宛てのコメントが1件も見えない(既定を閉じる)", () => {
  withStore((store) => {
    seedComments(store);
    const comments = store.listComments(APP_ID);
    // **`when` を持つ画面の規則。** **今日の語彙はこれを受け付けない**
    // (`schemas/manifest.schema.json` の画面の分岐が `"when": false` で閉じている)ので、
    // **この題材は語彙の検査を通らない。** それでも `judgeRoleAccess` は `manifest` を
    // `unknown` として読むので、判定そのものは走る。**合成が閉じる側に倒すことを固定する。**
    const conditional = manifestOf(
      [
        {
          id: "owner",
          name: "持ち主",
          rules: [...OWNER_DEFINITION_RULES, { target: "view", view: "cart", can: ["read"] }],
        },
        {
          id: "customer",
          name: "客",
          rules: [
            {
              target: "view",
              view: "cart",
              can: ["read"],
              when: { field: "st_owner", equals: "$user" },
            },
          ],
        },
      ],
      ["cart", "admin"],
    );

    // **判定そのものは「通しうる」を返す**(行を渡さない呼び方では条件を評価できない)。
    const decision = judgeRoleAccess({
      manifest: conditional,
      roles: ["customer"],
      target: { target: "view", view: "cart" },
      verb: "read",
    });
    expect(decision.allowed).toBe(true);
    expect(decision.conditional).toBe(true);

    // **合成は見せない。** コメントには対応する行が無いので、条件を評価する材料が
    // 構造上永久に揃わないからである(既定を閉じる)。
    expect(visibleComments({ manifest: conditional, roles: ["customer"], comments })).toEqual([]);
    // **陽性対照**: 条件を外した同じ規則なら見える。
    expect(
      visibleComments({ manifest: shopManifest(), roles: ["customer"], comments }),
    ).toHaveLength(2);
  });
});

// --- 9 / 10. ソース走査 ---------------------------------------------------------------

const SOURCE_PATH = new URL("./comment-visibility.ts", import.meta.url).pathname;

test("V10-M11-T02: 合成は judgeRoleAccess だけを呼び、target は view と app の2つしか渡さない", async () => {
  const source = await Bun.file(SOURCE_PATH).text();
  // 呼び出しは2箇所ちょうど(アプリ全体で1回 + 画面ごとに1回)。
  expect(source.match(/judgeRoleAccess\(\{/g) ?? []).toHaveLength(2);
  // 写し先は2つちょうど(`CM-G5` 限定3)。3つ目の綴りは1つも無い。
  expect(source.match(/target: "view"/g) ?? []).toHaveLength(1);
  expect(source.match(/target: "app"/g) ?? []).toHaveLength(1);
  for (const forbidden of [
    'target: "field"',
    'target: "table"',
    'target: "action"',
    'target: "role"',
  ]) {
    expect(source).not.toContain(forbidden);
  }
  // 判定の家を2軒目にしない —— 他の判定関数の綴りが1つも無いこと。
  for (const other of [
    "judgeRecordAccess",
    "judgeGrantWrite",
    "judgeOwnerScopedOp",
    "judgeRoleAssignment",
    "judgeOwnerUpdateWithDisplay",
    "resolveRecordAccess",
    "resolveRecordWithoutGrants",
  ]) {
    expect(source).not.toContain(other);
  }
});

test("V10-M11-T02: 合成は持ち主の絞り込みも行ごとの付与も1度も見ない", async () => {
  const source = await Bun.file(SOURCE_PATH).text();
  for (const forbidden of [
    "st_owner",
    "OWNER_FIELD",
    "personalOwnerField",
    "isOwnerVisible",
    "roleReadCrossesOwnerScope",
    "access_control",
    "accessControlOf",
    "recordAccessSourceTables",
    "combineRoleAndGrantAccess",
    "grantsWithExistingGroups",
    "st_public",
  ]) {
    expect(source).not.toContain(forbidden);
  }
  // **陽性対照**: 同じ走査の型で、在るはずの綴りは在る。
  expect(source).toContain("judgeRoleAccess");
  expect(source).toContain("visibleComments");
});
// --- 11. `V10-M27-T01c`: 冒頭の「今日の限界」の訂正 -------------------------------------
//
// **制定時の3行は1バイトも書き換えない**(`ADR-0007` §6 規律1 と同じ作法)。
// **今日の正は、追記の側に書く。**

test("V10-M27-T01c: 制定時の限界3行は1バイトも書き換えられておらず、追記の側が限界1 を訂正している", async () => {
  const source = await Bun.file(SOURCE_PATH).text();
  // (a) 制定時の3行が逐語で残っている(**deletions が 0 であることの機械的な担保**)。
  expect(source).toContain(
    "1. **名乗りの無い相手には、アプリが何を宣言していても1件も見えない**(下の短絡)。",
  );
  expect(source).toContain("**未ログインで書いた本人は、自分のコメントを1件も読み返せない。**");
  expect(source).toContain(" * ## 今日の限界(**丸めない。3件**)");
  // (b) 追記の節が在り、限界1 が今日の正でなくなったことを書いている。
  expect(source).toContain("## 今日の限界の訂正");
  expect(source).toContain("**上の限界1 は、今日の正ではない。**");
});
