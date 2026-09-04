/**
 * **未ログインでも見られる画面を作れること**の、サーバ側の契約の検査。
 *
 * ## 【`V8-M20` / 台帳 `J-G27`(判定 = 廃止)/ `ADR-0301` / ユーザ決定 `D-V8-35`】
 *
 * **本ファイルが元々測っていた `view.audience` の5値目 `anonymous`(`B-G5` / `ADR-0074`)は、
 * `view.audience` ごと撤去された。**
 * **代わりに立つのは 役割 x 対象(画面)x 読取 であり、`anonymous` は `app.roles[].id` に
 * 書ける予約4語(`owner` / `editor` / `viewer` / `anonymous`)の1つになった。**
 *
 * **「未ログインに画面を開ける」という問いは、面の側でそのまま置き直せた**(実測)——
 * `src/server/app.ts` の `rejectNamedView` は **401 の手前**で呼ばれ、未ログインには
 * `roles: null` が渡り、`judgeRoleAccess` の中で `anonymous` 1語の主体に写される
 * (`roleSubjectsOf`)。**したがって `{"id":"anonymous", rules:[{target:"view", …}]}` は
 * 未ログインの要求に実際に効く。** **HTTP 実測は `view-audience-enforcement.test.ts` の (C)。**
 *
 * ## **【塞げていない穴。誇張しない】旧層にあった「閉じる向きの既定」は面に無い**
 *
 * **旧 `ADR-0074` 限定5 / 限定7 は「宣言を書いていない画面は匿名に1画面も見せない」
 * =「匿名の可視集合は `anonymous` と書いた画面だけ」という、閉じる向きの既定を持っていた。**
 * **面にはそれが無い** —— **規則を1本も書いていない画面は管轄外(全許可)なので、
 * 未ログインにも開く側に倒れる。** **下の (c) がその事実を実測で固定する。**
 * **これは `V8-M20` が塞いでいない穴である。**
 *
 * ## この検査が言わないこと(誇張しない)
 *
 * - **`GET /api/apps/:app_id/manifest` は今日も未ログインで全ビュー定義を返す。**
 *   **`app.roles` の規則もそのまま返る**(`view-audience-enforcement.test.ts` の (Y))。
 * - **MCP 経路は1ミリも守られない。**
 * - **匿名に返る行は今日どおり `st_public` が真の表に限られる。**
 *   **画面を開くことと行を返すことは別である。**
 */
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { ANONYMOUS_AUDIENCE, judgeRoleAccess } from "./owner-scope.ts";

/** `src/server/view-audience.test.ts` と同じ理由でパスを組んで読む(層またぎを1本も増やさない)。 */
const MANIFEST_SCHEMA_FILE = join(import.meta.dir, "..", "..", "schemas", "manifest.schema.json");

function schema(): {
  $defs: Record<string, { properties?: Record<string, unknown> }>;
} {
  return JSON.parse(readFileSync(MANIFEST_SCHEMA_FILE, "utf-8")) as never;
}

// --- (a) 「未ログイン」を表す語がどこに在るか(`J-G27` / `J-G11`)------------------------

test("(a) 未ログインを表す語は audience の値ではなく roles[].id の予約語になった(V8-M20 / J-G27)", () => {
  const s = schema();
  // **【`V8-M20` / `J-G27` / `ADR-0301`】この test は置き直しである。**
  // **旧テスト名(逐語)**: 「(a) 増えたのは audience の値域の1値だけである($defs もキーも1つも増えていない)」。
  // **旧本体**:
  //   - `expect(Object.keys(s.$defs.view.properties)).not.toContain("anonymous")`(匿名専用キーを作らない)
  //   - `expect(s.$defs.view.properties.audience.items.enum).toBeUndefined()`
  //   - `expect(s.$defs.view.properties.audience.items.pattern).toBe("^[a-z0-9_]{1,32}$")`
  //   - `expect(s.$defs.field.properties.audience.$ref).toBe("#/$defs/view/properties/audience")`
  // **`audience` は `view` からも `field` からも消えたので、上の4行はどれも今日は書けない。**
  // **問い(「未ログインの見せ分けの宣言はどこに在るか」)を、面の側で置き直す。**
  const viewKeys = Object.keys(s.$defs.view?.properties ?? {});
  expect(viewKeys).not.toContain("audience");
  expect(viewKeys).not.toContain("anonymous");
  expect(Object.keys(s.$defs.field?.properties ?? {})).not.toContain("audience");

  // **置き場は `app.roles[].id` である。** **値域は `^[a-z0-9_]{1,32}$` の1本で、
  // 予約4語(`owner` / `editor` / `viewer` / `anonymous`)を書ける。**
  const roles = (s.$defs.app?.properties as Record<string, never> | undefined)?.roles as
    | {
        items?: {
          properties?: { id?: { pattern?: string } };
          allOf?: { if?: { properties?: { id?: { const?: string } } } }[];
        };
      }
    | undefined;
  expect(roles?.items?.properties?.id?.pattern).toBe("^[a-z0-9_]{1,32}$");
  // **未ログインの非対称は、この `allOf` の1分岐が持つ**(`J-G11`)——
  // **項目の規則を書けず、動詞は読取だけ。**
  expect(roles?.items?.allOf?.[0]?.if?.properties?.id?.const).toBe("anonymous");

  // **`ANONYMOUS_AUDIENCE` は `owner-scope.ts` に今日も在る**(`V8-M20` で消えていない)——
  // **`view.audience` の値域であると同時に、面が未ログインの主体を表す1語でもあるからである。**
  expect(ANONYMOUS_AUDIENCE).toBe("anonymous");
});

// --- (b) マニフェストに書けること -------------------------------------------------------

const APP_ID = "anon-audience-app";

/** 画面2つ・表1つ。`roles` を渡して適用できるかを見る。 */
function manifestWith(roles?: unknown): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "匿名宣言テスト",
      tables: [
        {
          id: "product",
          name: "商品",
          fields: [{ id: "name", name: "名称", type: "text", required: true }],
        },
      ],
      views: [
        { id: "catalog-list", type: "list_view", table: "product", columns: ["name"] },
        { id: "admin-list", type: "list_view", table: "product", columns: ["name"] },
      ],
      ...(roles === undefined ? {} : { roles }),
    },
  } as unknown as Manifest;
}

const DEFAULTS = [
  {
    id: "owner",
    name: "持ち主",
    rules: [
      // **【`V8-M28` / `T-G16a`】持ち主にはこの2行が必ず要る**(適用時検査 = 類型17 の拡張)。
      { target: "app", can: ["write"] },
      { target: "role", can: ["write"] },
    ],
  },
  { id: "editor", name: "編集者" },
  { id: "viewer", name: "閲覧者" },
];

function applyIn(manifest: Manifest): boolean {
  const dataRoot = mkdtempSync(join(tmpdir(), "gp-anon-audience-"));
  try {
    const store = KernelMetaStore.open(dataRoot);
    try {
      createApp(store, "匿名宣言テスト", { app_id: APP_ID });
    } finally {
      store.close();
    }
    return applyManifest(dataRoot, APP_ID, manifest).valid;
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

test("(b) anonymous に画面の読取規則を書いたマニフェストが適用できる(V8-M20 / J-G27)", () => {
  // **【`V8-M20` / `J-G27`】この test は置き直しである。**
  // **旧テスト名(逐語)**: 「(b) audience に anonymous を書いたマニフェストが適用できる(ADR-0074 限定1)」。
  // **旧本体**: `applyIn(manifestWith(["anonymous"]))` と
  //   `applyIn(manifestWith(["anonymous","customer"]))` が `true` であることを測っていた。
  expect(
    applyIn(
      manifestWith([
        ...DEFAULTS,
        {
          id: "anonymous",
          name: "未ログイン",
          rules: [{ target: "view", view: "catalog-list", can: ["read"] }],
        },
      ]),
    ),
  ).toBe(true);
  // **表の読取も書ける**(非対称は項目と動詞にだけ在る)。
  expect(
    applyIn(
      manifestWith([
        ...DEFAULTS,
        {
          id: "anonymous",
          name: "未ログイン",
          rules: [
            { target: "view", view: "catalog-list", can: ["read"] },
            { target: "table", table: "product", can: ["read"] },
          ],
        },
      ]),
    ),
  ).toBe(true);
});

test("(b) 未ログインには項目の規則も書込・削除も書けない(J-G11 の非対称)", () => {
  // **【`V8-M20` / `J-G27`】この test は置き直しである。**
  // **旧テスト名(逐語)**: 「(b) 値域は5値で閉じている(6値目・空配列・重複は今日も書けない)」。
  // **旧本体**: `["guest"]` / `["ANONYMOUS"]` / `[]` / `["anonymous","anonymous"]` が
  //   どれも `false` であることを測っていた。
  // **もう1本の旧テスト名(逐語)**: 「(b) 項目単位(field.audience)には anonymous を1ミリも
  //   広げていない(ADR-0074 §3a-4)」。
  // **その旧本体**: `field.audience` に `["anonymous"]` / `["owner","anonymous"]` を書くと
  //   `false`、`["owner"]` / 4ロール全部なら `true` であることを測っていた。
  // **2本の旧テストが測っていた「匿名は項目単位には広がらない」「値域が閉じている」は、
  // 面では schema の `allOf`(`id: "anonymous"` の分岐)が持つ。**
  const anon = (rules: unknown[]) => [...DEFAULTS, { id: "anonymous", name: "未ログイン", rules }];
  // **項目の規則は書けない**(`target` の値域から `field` が除かれ、`field: false`)。
  expect(
    applyIn(
      manifestWith(anon([{ target: "field", table: "product", field: "name", can: ["read"] }])),
    ),
  ).toBe(false);
  // **書込・削除は書けない**(`can.items` が `{"const":"read"}` に絞られる)。
  expect(applyIn(manifestWith(anon([{ target: "table", table: "product", can: ["write"] }])))).toBe(
    false,
  );
  expect(
    applyIn(manifestWith(anon([{ target: "table", table: "product", can: ["delete"] }]))),
  ).toBe(false);
  // **空の規則の配列は書けない**(`minItems: 1`)。
  expect(applyIn(manifestWith(anon([])))).toBe(false);
  // **同じ役割IDを2度書けない**(適用時検査 = 類型5 の補遺)。
  expect(
    applyIn(
      manifestWith([
        ...DEFAULTS,
        { id: "anonymous", name: "未ログイン" },
        { id: "anonymous", name: "未ログイン(2)" },
      ]),
    ),
  ).toBe(false);
  // **ログイン済みの役割には、今日も項目の規則も書込も書ける**(非対称は `anonymous` にだけ当たる)。
  expect(
    applyIn(
      manifestWith([
        {
          id: "owner",
          name: "持ち主",
          rules: [
            // **【`V8-M28` / `T-G16a`】持ち主にはこの2行が必ず要る**(適用時検査 = 類型17 の拡張)。
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
            { target: "field", table: "product", field: "name", can: ["read", "write"] },
            { target: "table", table: "product", can: ["read", "write", "delete"] },
          ],
        },
        ...DEFAULTS.slice(1),
      ]),
    ),
  ).toBe(true);
});

// --- (c) 未ログインの可視集合(**閉じる向きの既定が消えた**)-----------------------------

/** 画面 `v` について、未ログイン(`roles: null`)が通るか。 */
function anonymousMaySee(roles: unknown): boolean {
  return judgeRoleAccess({
    manifest: { app: { roles } },
    roles: null,
    target: { target: "view", view: "v" },
    verb: "read",
  }).allowed;
}

test("(c)【塞げていない穴】規則を1本も書いていない画面は、今日は未ログインにも開く", () => {
  // **【`V8-M20` / `J-G27` / `ADR-0301`】この test は置き直しであり、答えが反転している。**
  // **旧テスト名(逐語)**: 「(c) 宣言を書いていない画面は、匿名に1画面も見せない(限定5)」。
  // **旧本体**: `isViewAnonymousVisible({id:"v",type:"list_view",table:"t"})` が `false`、
  //   `audience:["owner"]` でも `false`、`audience:["owner","customer"]` でも `false`。
  // **旧層は「宣言を書いていない画面は匿名に1画面も見せない」という閉じる向きの既定を
  // 持っていた**(`ADR-0074` 限定5 / 限定7)。**面にはそれが無い。**
  // **規則を1本も書いていない対象は管轄外(全許可)なので、未ログインにも開く側に倒れる。**
  // **【禁止】これを「代わりが立った」と書かない** —— **旧層が閉じていた向きは、今日は開いている。**
  // **`schemas/manifest.schema.json` の `roles[].rules[].view` の `$comment` が、
  // 同じことを製品側でも申告している。**
  //
  // **【`V8-M26` / ユーザ決定 `D-V8-45` / `D-V8-65` / 台帳 `T-G26a`。期待値を3行とも
  // 反転させた。旧文を1バイトも消していない】**
  // **旧(逐語)**:
  //   `expect(anonymousMaySee(undefined)).toBe(true);`
  //   `expect(anonymousMaySee([{ id: "owner" }, { id: "editor" }, { id: "viewer" }])).toBe(true);`
  //   `).toBe(true);`(3本目の「他の画面にだけ規則が在る」ケース)
  // **この test の名前が名指ししていた穴(`ADR-0074` 限定5 / 限定7 の閉じる向きの既定が
  // 面には無い、という穴)は、`V8-M26` が既定を閉じる側へ倒したことで塞がった** ——
  // **したがって test 名の「【塞げていない穴】」も、直上の3行のコメント
  // (「管轄外(全許可)なので、未ログインにも開く側に倒れる」)も、今日は偽である。**
  // **旧の名前と旧のコメントは1バイトも消していない。**
  // **`D-V8-65` により、役割を1つも宣言していない1本目のケースも閉じる。**
  expect(anonymousMaySee(undefined)).toBe(false);
  expect(anonymousMaySee([{ id: "owner" }, { id: "editor" }, { id: "viewer" }])).toBe(false);
  // **他の画面にだけ規則が在るときも、`v` は管轄外のままである**(対象ごとに独立)。
  expect(
    anonymousMaySee([
      { id: "owner", rules: [{ target: "view", view: "other", can: ["read"] }] },
      { id: "editor" },
      { id: "viewer" },
    ]),
  ).toBe(false);
});

test("(c) 他の役割にだけ規則を書いた画面は、未ログインには開かない(allow-list が締まる)", () => {
  // **【`V8-M20` / `J-G27`】この test は置き直しである。**
  // **旧テスト名(逐語)**: 「(c) anonymous と書いた画面だけが匿名に見える(限定7)」。
  // **旧本体**: `audience:["anonymous"]` と `audience:["anonymous","customer"]` について
  //   `isViewAnonymousVisible(...)` が `true` であることを測っていた。
  // **面では「その画面に規則が1本でも在る」ことが allow-list の引き金である** ——
  // **`anonymous` に書けば開き、書かなければ閉じる。**
  expect(
    anonymousMaySee([
      { id: "owner", rules: [{ target: "view", view: "v", can: ["read"] }] },
      { id: "editor" },
      { id: "viewer" },
    ]),
  ).toBe(false);
  // **`anonymous` に書けば開く。**
  expect(
    anonymousMaySee([
      { id: "owner", rules: [{ target: "view", view: "v", can: ["read"] }] },
      { id: "editor" },
      { id: "viewer" },
      { id: "anonymous", rules: [{ target: "view", view: "v", can: ["read"] }] },
    ]),
  ).toBe(true);
});

// --- (d) 述語(サーバ層の `?view=` の遮断が呼ぶ1本)--------------------------------------

test("(d) 未ログインは anonymous に規則のある画面だけを名乗れる(ログイン済みは恩恵を受けない)", () => {
  // **【`V8-M20` / `J-G27`】この test は置き直しである。**
  // **旧テスト名(逐語)**: 「(d) 未認証は anonymous と書かれた画面だけを名乗れる(ADR-0070 限定3 を引き継ぐ)」。
  // **旧本体**: `isViewAudienceAllowed(open, null) === true` /
  //   `isViewAudienceAllowed(closed, null) === false` / 宣言の無い画面は `null` でも `true` /
  //   `isViewAudienceAllowed(open, "owner") === false` /
  //   `isViewAudienceAllowed(closed, "owner") === true` /
  //   owner / editor / viewer / customer のどれも `open` を名乗れない。
  // **同じ形が面でそのまま言える** —— **`anonymous` は5番目のロールではなく「役割を持たない者」
  // の1語であり、ログイン済みの誰かが `anonymous` の規則で通ることはない。**
  const roles = [
    { id: "owner", name: "持ち主", rules: [{ target: "view", view: "closed", can: ["read"] }] },
    { id: "editor", name: "編集者" },
    { id: "viewer", name: "閲覧者" },
    {
      id: "anonymous",
      name: "未ログイン",
      rules: [{ target: "view", view: "open", can: ["read"] }],
    },
  ];
  const judge = (view: string, actor: readonly string[] | null) =>
    judgeRoleAccess({
      manifest: { app: { roles } },
      roles: actor as never,
      target: { target: "view", view },
      verb: "read",
    }).allowed;

  expect(judge("open", null)).toBe(true);
  expect(judge("closed", null)).toBe(false);
  // **規則の無い画面は今日どおり全員に許す**(裁定 `R-4` の管轄外)。
  // **【`V8-M26` / `D-V8-45` / `D-V8-58`。期待値を反転させた。旧文を1バイトも消していない】**
  // **旧(逐語)**: `expect(judge("no-rule", null)).toBe(true);`
  // **今日は、規則の無い画面は誰にも開かない**(直上のコメント1行は今日は偽)。
  expect(judge("no-rule", null)).toBe(false);
  // **反転が未ログインに限らないことを、同じ画面をログイン済みの `owner` で1件押さえる。**
  expect(judge("no-rule", ["owner"])).toBe(false);
  // **ログイン済みのロールの答えは、旧層と同じ向きである。**
  expect(judge("open", ["owner"])).toBe(false);
  expect(judge("closed", ["owner"])).toBe(true);
  for (const role of ["owner", "editor", "viewer", "customer"] as const) {
    expect(judge("open", [role]), role).toBe(false);
  }
});

test("(d) 未ログインの主体の綴りは owner-scope.ts の1語に閉じている(ANONYMOUS_AUDIENCE)", () => {
  // **【`V8-M20` / `J-G27`】この test は置き直しである。**
  // **旧テスト名(逐語)**: 「(d) 宣言の読み手は2本あり、`anonymous` を含めるのは片方だけである」。
  // **旧本体**: `viewAudienceDeclaration(...)`(宣言そのまま。`anonymous` を含む)と
  //   `viewAudience(...)`(ロールだけ。`anonymous` を除く)の2本の読み手の差を測っていた ——
  //   `["anonymous","owner"]` に対して前者は `["anonymous","owner"]`、後者は `["owner"]`。
  //   `["anonymous"]` だけの画面では後者が `[]` になり、403 の `allowed_values` が空になる
  //   という限界も、そこに書かれていた。
  // **読み手を2本に割る必要は面には無い**(判定は `judgeRoleAccess` の1本しか無い)ので、
  // **2本の差を測る検査は意味を失った。** **残るのは「未ログインを表す綴りが1語に閉じている」
  // ことであり、それをここで固定する。**
  // **`ADR-0301` は `ANONYMOUS_AUDIENCE` を消していない** —— **`web/src/auth/authz.tsx` が
  // `ANONYMOUS` として再輸出しており、匿名の概念は `view.audience` の撤去では消えない。**
  const source = readFileSync(join(import.meta.dir, "owner-scope.ts"), "utf-8");
  expect(ANONYMOUS_AUDIENCE).toBe("anonymous");
  expect(source).toContain('export const ANONYMOUS_AUDIENCE = "anonymous" as const;');
  // **撤去された述語は1本も export されていない。**
  // **【文字列としては今日も残っている】** —— このリポジトリは**本文を1バイトも書き換えない**
  // 作法なので、`owner-scope.ts` のコメントには撤去した記号の名前が経緯として残る。
  // **したがって「綴りがファイルに無いこと」では測れない。** **`export` の宣言で測る。**
  for (const removed of [
    "viewAudienceDeclaration",
    "isViewAnonymousVisible",
    "isViewAudienceAllowed",
    "viewAudience",
  ]) {
    expect(source, removed).not.toMatch(new RegExp(`^export function ${removed}\\b`, "m"));
  }
  expect(source).not.toMatch(/^export const VIEW_AUDIENCE_VALUES\b/m);
  expect(source).not.toMatch(/^export type ViewAudienceValue\b/m);
});

// --- (f) 予約規約フィールド --------------------------------------------------------------

test("(f) 予約規約フィールドは 4本である(V8-M20 / J-G30 で st_admin_readable が消えた)", () => {
  // **【`V8-M20` / `J-G30` / `ADR-0301` による更新】**
  // **旧テスト名(逐語)**: 「(f) `B-G5` は予約規約フィールドを1本も足していない(ADR-0074 限定3)」。
  // **旧本体**: `expect(declared.sort()).toEqual(["ADMIN_READABLE_FIELD","NO_DIRECT_CREATE_FIELD",
  //   "OWNER_FIELD","PUBLIC_FIELD","UNDELETABLE_FIELD"]);`(5本)。
  // **`st_admin_readable`(運営には全員分の行を見せる)を廃止したので 4本になった。**
  // **代わりに立つのは 役割 x 対象(表)x 読取 である**(`D-V8-35`: 面が読取を許した表では
  // `st_owner` の絞り込みが読取についてだけ効かなくなる)。
  // **この test の元の趣旨(「未ログインに画面を開ける仕組みは予約規約フィールドに置かれて
  // いない」)は今日も真である。**
  const source = readFileSync(join(import.meta.dir, "owner-scope.ts"), "utf-8");
  const declared = [...source.matchAll(/^export const ([A-Z_]+_FIELD) = "(st_[a-z_]+)";$/gm)].map(
    (m) => m[1] as string,
  );
  expect(declared.sort()).toEqual([
    "NO_DIRECT_CREATE_FIELD",
    "OWNER_FIELD",
    "PUBLIC_FIELD",
    "UNDELETABLE_FIELD",
  ]);
  expect(declared).not.toContain("ADMIN_READABLE_FIELD");
  // **未ログインの宣言は予約規約フィールドではなく `app.roles[].id` の予約語に置かれている。**
  expect(declared.filter((name) => name.includes("ANON"))).toEqual([]);
  expect(source).not.toContain('_FIELD = "st_anonymous"');
  expect(source).not.toContain('_FIELD = "st_anon"');
});

// --- (g) 触っていないもの ----------------------------------------------------------------

test("(g) 匿名公開 GET の窓とレート制限に1バイトも触っていない", () => {
  // **ここは「窓とレート制限が今日も実在すること」を字面で押さえるだけである**
  // (**消えていないことの提示**であって、遮断の実証ではない)。
  // **`V8-M20` はこの窓を1バイトも動かしていない。**
  const appSource = readFileSync(join(import.meta.dir, "app.ts"), "utf-8");
  expect(appSource).toContain("匿名公開読み取り窓");
  expect(appSource).toContain("publicGetLimiter.hit(");
  // **`GET /api/apps/:app_id/manifest` は今日も未認証で全ビュー定義を返す。**
  // **これは面が守らない経路である**(`view-audience-enforcement.test.ts` の (Y) が実測する)。
  expect(appSource).toContain('app.get("/api/apps/:app_id/manifest"');
});
