/**
 * **`V8-M26-T04` —— 作るたびに、既定3役割の規則を自動で足すことの検査。**
 *
 * ユーザ決定 `D-V8-56` / `D-V8-60` / `D-V8-61` / `D-V8-62`
 * (逐語の正は `docs/plan/v8/03-user-decisions.md` §4i〜§4l)が仕様である。
 *
 * ## なぜ要るのか
 *
 * **`V8-M26-T03` が面の既定を「閉じる」側へ倒した** —— **表・画面・ボタンは、規則を1本も
 * 書いていなければ誰にも見えない。** **その埋め合わせがこれである** ——
 * **`add_table` / `add_view` / `update_view`(ボタン)で作った直後から、既定3役割に見える。**
 *
 * ## 足す動詞(**非対称を先に書く**)
 *
 * | 対象 | 持ち主(`owner`) | 編集者(`editor`) | 閲覧者(`viewer`) |
 * |---|---|---|---|
 * | 表(`table`) | `read` / `write` / `delete` | `read` / `write` | `read` |
 * | 画面(`view`) | `read` | `read` | `read` |
 * | ボタン(`action`) | `read` | `read` | `read` |
 *
 * **`D-V8-62`「持ち主は 見る・書く・消す の3つとも」は、表にしか履行できない** ——
 * **`schemas/manifest.schema.json` が画面(`:235`)とボタン(`:251`)の `can` を
 * `{ "const": "read" }` に閉じているからである。** **下の (i) がそれを実測で固定する。**
 *
 * ## この検査が固定していないこと(**誇張しない**)
 *
 * - **`T03` より前に作られた表・画面・ボタンには1本も入らない**(移行の口は今日1つも無い)。
 * - **`remove_table` / `remove_view` は自動で足した規則を1本も外さない** ——
 *   **その結果どうなるかは (l) が実測で残す。塞いでいない。**
 *   **【`D-V8-66`(2026-08-10)で挙動が変わった】旧の逐語は「**【重い】作ってから消そうと
 *   すると、適用時検査が差分**全体**を拒否する** —— **同じ差分に `set_roles` を先に並べる
 *   以外の回避が今日1つも無い。**」**今日は消せる。ただし規則の行はアプリに残る** ——
 *   **残った行の扱いは `src/kernel/role-rule-stale-target.test.ts` が全部持つ。**
 * - **`applyManifest` には1バイトも入れていない** —— **(k) がそれを実測で固定する
 *   (毎回の適用で規則が復活しない = あとから規則を外せる)。**
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import manifestSchema from "../../schemas/manifest.schema.json" with { type: "json" };
import { applyDiff } from "./apply-diff.ts";
import { applyManifest } from "./apply-manifest.ts";
import { createApp } from "./create-app.ts";
import { KernelMetaStore } from "./meta-store.ts";
import type { Diff, Manifest, RoleDeclaration, RoleRule } from "./types.ts";

const APP_ID = "grant-shop";

type Any = Record<string, unknown>;

/** 既定3役割(規則は1本も持たない)。 */
function defaultRoles(): RoleDeclaration[] {
  return [
    // **【`V8-M28` / `T-G16a`(2026-08-11)】旧の逐語: `{ id: "owner", name: "持ち主" },`** ——
    // **今日は持ち主に `app`+`write` / `role`+`write` の2本が要る**(類型17 の拡張)。
    // **本ファイルが数えるのは「対象を名指しした規則の本数」なので、
    // 名指しする対象を持たないこの2本は、下の数え方(`rulesFor` の絞り込み)に載らない。**
    {
      id: "owner",
      name: "持ち主",
      rules: [
        { target: "app", can: ["write"] },
        { target: "role", can: ["write"] },
      ],
    },
    { id: "editor", name: "編集者" },
    { id: "viewer", name: "閲覧者" },
  ];
}

/** **既定引数を持たない** —— 明示的な `undefined` は「`app.roles` を書かない」を意味する。 */
function baseManifest(roles: RoleDeclaration[] | undefined): Manifest {
  const app: Any = {
    id: APP_ID,
    name: "自動付与の店",
    tables: [
      {
        id: "seed",
        name: "土台",
        fields: [{ id: "title", name: "件名", type: "text", required: true }],
      },
    ],
    views: [{ id: "seed-list", type: "list_view", table: "seed", columns: ["title"] }],
  };
  if (roles !== undefined) {
    app.roles = roles;
  }
  return { app } as unknown as Manifest;
}

let dataRoot: string;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-role-default-grant-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "自動付与の店", { app_id: APP_ID });
  } finally {
    store.close();
  }
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

function boot(roles: RoleDeclaration[] = defaultRoles()): void {
  const applied = applyManifest(dataRoot, APP_ID, baseManifest(roles));
  if (!applied.valid) {
    throw new Error(`前提のマニフェスト投入に失敗: ${JSON.stringify(applied.errors)}`);
  }
}

/**
 * **`app.roles` を1つも持たないアプリ**(`V8-M26` より前に作られた既存アプリの姿)。
 *
 * **`boot(undefined)` と書けない** —— **既定引数は明示的な `undefined` にも当たるからである**
 * (本ファイルが実際にそれで一度赤くなった)。
 */
function bootWithoutRoles(): void {
  const applied = applyManifest(dataRoot, APP_ID, baseManifest(undefined));
  if (!applied.valid) {
    throw new Error(`前提のマニフェスト投入に失敗: ${JSON.stringify(applied.errors)}`);
  }
}

function apply(diff: Diff): Manifest {
  const result = applyDiff(dataRoot, APP_ID, diff as unknown);
  if (!result.valid) {
    throw new Error(`差分の適用に失敗: ${JSON.stringify(result.errors)}`);
  }
  return result.manifest;
}

function rulesOf(manifest: Manifest, roleId: string): RoleRule[] {
  return [...((manifest.app.roles ?? []).find((role) => role.id === roleId)?.rules ?? [])];
}

/**
 * **対象を名指しした規則だけを数える**(`V8-M28`。台帳 `T-G16a`)。
 *
 * **本ファイルが測るのは「表・画面・ボタンを作るたびに自動で入る規則」である。**
 * **`V8-M28` が持ち主に入れた `app` / `role` の2行は、名指しする対象を持たず、
 * 自動付与とは無関係である** —— **数えると本数の主張が2ずれるので、ここで外す。**
 * **【禁止】これを「2行を無かったことにした」と読まない** —— **2行が在ることは
 * `src/kernel/role-rules.test.ts` の (T-13) と `create-app.test.ts` が測っている。**
 */
function namedRulesOf(manifest: Manifest, roleId: string): RoleRule[] {
  return rulesOf(manifest, roleId).filter(
    (rule) => rule.target === "table" || rule.target === "view" || rule.target === "action",
  );
}

/** その役割がその対象について持っている動詞(**1本も無ければ `undefined`**)。 */
function verbsFor(
  manifest: Manifest,
  roleId: string,
  target:
    | { target: "table"; table: string }
    | { target: "view"; view: string }
    | {
        target: "action";
        view: string;
        action: string;
      },
): string[] | undefined {
  const found = rulesOf(manifest, roleId).find((rule) => {
    if (rule.target !== target.target) return false;
    if (target.target === "table") return rule.table === target.table;
    if (target.target === "view") return rule.view === target.view;
    return rule.view === target.view && rule.action === target.action;
  });
  return found === undefined ? undefined : [...found.can];
}

const addTable = (id: string, diffId = "d-table"): Diff =>
  ({
    diff_id: diffId,
    intent: "表を作る",
    operations: [
      {
        op: "add_table",
        table: {
          id,
          name: id,
          fields: [{ id: "title", name: "件名", type: "text", required: true }],
        },
      },
    ],
  }) as unknown as Diff;

// ---------------------------------------------------------------------------
// (a) `add_table` —— 3役割それぞれに1本ずつ入る
// ---------------------------------------------------------------------------

test("(a) add_table を適用すると、既定3役割それぞれに表の規則が1本ずつ入る", () => {
  boot();
  const manifest = apply(addTable("orders"));
  expect(verbsFor(manifest, "owner", { target: "table", table: "orders" })).toEqual([
    "read",
    "write",
    "delete",
  ]);
  expect(verbsFor(manifest, "editor", { target: "table", table: "orders" })).toEqual([
    "read",
    "write",
  ]);
  expect(verbsFor(manifest, "viewer", { target: "table", table: "orders" })).toEqual(["read"]);
});

test("(a-2) 足すのは1役割あたり1本ちょうどである(表1つにつき3本)", () => {
  boot();
  const manifest = apply(addTable("orders"));
  for (const roleId of ["owner", "editor", "viewer"]) {
    // **【`V8-M28`】旧の逐語: `expect(rulesOf(manifest, roleId).length).toBe(1);`** ——
    // **持ち主には `app` / `role` の2行が別に在るので、名指しした規則だけを数える。**
    expect(namedRulesOf(manifest, roleId).length).toBe(1);
  }
});

// ---------------------------------------------------------------------------
// (b) `add_view` —— 画面の規則3本 + ボタンの規則3本
// ---------------------------------------------------------------------------

test("(b) add_view で画面の規則が3本入る。ボタンつきの画面ならボタンの規則も入る", () => {
  boot();
  apply(addTable("orders"));
  const manifest = apply({
    diff_id: "d-view",
    intent: "画面を作る",
    operations: [
      {
        op: "add_view",
        view: {
          id: "order-list",
          type: "list_view",
          table: "orders",
          columns: ["title"],
          actions: [{ id: "open-detail", view: "seed-list", name: "開く" }],
        },
      },
    ],
  } as unknown as Diff);
  for (const roleId of ["owner", "editor", "viewer"]) {
    // **画面もボタンも `read` 1語である**(スキーマがそう閉じている。(i) を見よ)。
    expect(verbsFor(manifest, roleId, { target: "view", view: "order-list" })).toEqual(["read"]);
    expect(
      verbsFor(manifest, roleId, {
        target: "action",
        view: "order-list",
        action: "open-detail",
      }),
    ).toEqual(["read"]);
  }
});

test("(b-2) 識別子(id)を持たないボタンには1本も足さない(面から名指しできないため)", () => {
  boot();
  apply(addTable("orders"));
  const manifest = apply({
    diff_id: "d-view-noid",
    intent: "IDの無いボタンを持つ画面を作る",
    operations: [
      {
        op: "add_view",
        view: {
          id: "order-list",
          type: "list_view",
          table: "orders",
          columns: ["title"],
          actions: [{ view: "seed-list", name: "開く" }],
        },
      },
    ],
  } as unknown as Diff);
  expect(rulesOf(manifest, "owner").filter((rule) => rule.target === "action").length).toBe(0);
  // **画面の規則は入っている**(ボタンだけが入らない)。
  expect(verbsFor(manifest, "owner", { target: "view", view: "order-list" })).toEqual(["read"]);
});

// ---------------------------------------------------------------------------
// (c) `update_view` —— ボタンを足すと、そのボタンの規則が入る
// ---------------------------------------------------------------------------

test("(c) update_view でボタンを足すと、そのボタンの規則が3役割に入る", () => {
  boot();
  const manifest = apply({
    diff_id: "d-update",
    intent: "ボタンを足す",
    operations: [
      {
        op: "update_view",
        view: "seed-list",
        changes: { actions: [{ id: "go-seed", view: "seed-list", name: "開く" }] },
      },
    ],
  } as unknown as Diff);
  for (const roleId of ["owner", "editor", "viewer"]) {
    expect(
      verbsFor(manifest, roleId, { target: "action", view: "seed-list", action: "go-seed" }),
    ).toEqual(["read"]);
  }
  // **画面そのものの規則は `update_view` では入らない**(`add_view` が「作るたび」である)。
  expect(verbsFor(manifest, "owner", { target: "view", view: "seed-list" })).toBeUndefined();
});

// ---------------------------------------------------------------------------
// (d) `anonymous` には1本も入らない
// ---------------------------------------------------------------------------

test("(d) anonymous を宣言していても、自動で足す規則は1本も入らない", () => {
  boot([...defaultRoles(), { id: "anonymous", name: "未ログイン" }]);
  const manifest = apply(addTable("orders"));
  expect(rulesOf(manifest, "anonymous")).toEqual([]);
  // **既定3役割には入っている**(入らないのは `anonymous` だけである)。
  expect(verbsFor(manifest, "owner", { target: "table", table: "orders" })).toBeDefined();
});

// ---------------------------------------------------------------------------
// (e) 既に同じ対象の規則がある役割には重複して入らない
// ---------------------------------------------------------------------------

test("(e) 同じ対象の規則を既に持つ役割には足さない(動詞が違っていても上書きしない)", () => {
  boot([
    // **`owner` は `orders` について `read` だけを持つ**(作者が意図して絞った宣言)。
    {
      id: "owner",
      name: "持ち主",
      rules: [
        // **【`V8-M28` / `T-G16a`】この2行は抜けない**(類型17 の拡張)。
        { target: "app", can: ["write"] },
        { target: "role", can: ["write"] },
        { target: "table", table: "seed", can: ["read"] },
      ],
    },
    { id: "editor", name: "編集者" },
    { id: "viewer", name: "閲覧者" },
  ]);
  // **`seed` は既に在る表なので `add_table` できない** —— 代わりに `seed` を名指しした
  // 規則を持ったまま別の表を作り、`seed` の規則が1バイトも動かないことを見る。
  const manifest = apply(addTable("orders"));
  expect(verbsFor(manifest, "owner", { target: "table", table: "seed" })).toEqual(["read"]);
  // **【`V8-M28`】旧の逐語: `expect(rulesOf(manifest, "owner").length).toBe(2);`**
  expect(namedRulesOf(manifest, "owner").length).toBe(2);
});

test("(e-2) 同じ差分で同じ表を2回作ろうとしても、規則は1本しか入らない(2回目は失敗する)", () => {
  boot();
  const manifest = apply(addTable("orders"));
  const result = applyDiff(dataRoot, APP_ID, addTable("orders", "d-again") as unknown);
  expect(result.valid).toBe(false);
  // **【`V8-M28`】旧の逐語: `expect(rulesOf(manifest, "owner").length).toBe(1);`**
  expect(namedRulesOf(manifest, "owner").length).toBe(1);
});

// ---------------------------------------------------------------------------
// (f) 役割を消したアプリには足さない
// ---------------------------------------------------------------------------

test("(f) app.roles を1つも持たないアプリには1本も足さない(roles を勝手に生やさない)", () => {
  bootWithoutRoles();
  const manifest = apply(addTable("orders"));
  expect(manifest.app.roles).toBeUndefined();
  // **表そのものは今日どおり作られる**(自動付与が失敗しても差分は通る)。
  expect(manifest.app.tables.some((table) => table.id === "orders")).toBe(true);
});

/**
 * **【正直に書く】「その役割が実在するときだけ足す」条件は、今日どの口からも到達しない。**
 *
 * **`V8-M17` の適用時検査(`referential-integrity.ts` の類型17)が、既定3役割の欠落を
 * `set_roles` でも `applyManifest` でも拒否するからである**(台帳 `J-G2` / `D-V8-26`)。
 * **したがって実装側の `if (declaration === undefined) continue;` は**防御であって
 * 今日効いている分岐ではない**。**
 *
 * **本検査はその「到達しないこと」を実測で残す** —— **消せると書かない。**
 */
test("(f-2) 既定3役割は今日どの口からも消せない(自動付与の『役割が無いとき』は到達しない)", () => {
  const applied = applyManifest(dataRoot, APP_ID, baseManifest([{ id: "owner", name: "持ち主" }]));
  expect(applied.valid).toBe(false);
  expect(
    (applied as { errors: { message: string }[] }).errors.some((error) =>
      error.message.includes("既定の役割"),
    ),
  ).toBe(true);
});

// ---------------------------------------------------------------------------
// (i) 画面とボタンで `read` しか書けない非対称(**スキーマの実測**)
// ---------------------------------------------------------------------------

test("(i) スキーマが画面とボタンの can を read 1語に閉じている(D-V8-62 の『消す』を書けない)", () => {
  const rulesItems = (
    (
      (((manifestSchema as unknown as { $defs: Any }).$defs.app as Any).properties as Any)
        .roles as Any
    ).items as Any
  ).properties as Any;
  const branches = ((rulesItems.rules as Any).items as Any).allOf as Any[];
  const canOf = (targetName: string): Any => {
    const branch = branches.find(
      (b) => ((((b.if as Any).properties as Any).target as Any).const as string) === targetName,
    );
    if (branch === undefined) {
      throw new Error(`分岐が見つからない: ${targetName}`);
    }
    return (((branch.then as Any).properties as Any).can as Any).items as Any;
  };
  expect(canOf("view")).toEqual({ const: "read" });
  expect(canOf("action")).toEqual({ const: "read" });
  // **表だけが3語を書ける** —— **非対称はここに在る。**
  expect(canOf("table")).toEqual({ enum: ["read", "write", "delete"] });
});

test("(i-2) 画面に write を書いた差分は、畳み込んだ後の検証が拒否する(全か無か)", () => {
  boot();
  const result = applyDiff(dataRoot, APP_ID, {
    diff_id: "d-bad",
    intent: "画面に書込を与えようとする",
    operations: [
      {
        op: "set_roles",
        roles: [
          {
            id: "owner",
            name: "持ち主",
            rules: [{ target: "view", view: "seed-list", can: ["read", "write"] }],
          },
          { id: "editor" },
          { id: "viewer" },
        ],
      },
    ],
  } as unknown as Diff);
  expect(result.valid).toBe(false);
});

// ---------------------------------------------------------------------------
// (j) 上限(`maxItems: 1024`)に当たったときの実測
// ---------------------------------------------------------------------------

test("(j) rules の上限 1024 を越えると、差分全体がスキーマ検証で拒否される(黙って落ちない)", () => {
  // **`owner` に 1024 本ちょうどの規則を先に入れておく**(表を名指しした規則で埋める)。
  const filler: RoleRule[] = [];
  const tables: Any[] = [
    { id: "seed", name: "土台", fields: [{ id: "title", name: "件名", type: "text" }] },
  ];
  // **【`V8-M28` / `T-G16a`】旧の逐語: `for (let i = 0; i < 1024; i += 1) {`** ——
  // **持ち主には `app` / `role` の2行が必ず入るので、埋める本数は 1022 である**
  // (1022 + 2 = 1024 ちょうど)。**上限そのものは1バイトも動かしていない。**
  filler.push({ target: "app", can: ["write"] } as unknown as RoleRule);
  filler.push({ target: "role", can: ["write"] } as unknown as RoleRule);
  for (let i = 0; i < 1022; i += 1) {
    const id = `filler_${i}`;
    tables.push({ id, name: id, fields: [{ id: "title", name: "件名", type: "text" }] });
    filler.push({ target: "table", table: id, can: ["read"] } as RoleRule);
  }
  const applied = applyManifest(dataRoot, APP_ID, {
    app: {
      id: APP_ID,
      name: "上限の店",
      tables,
      views: [{ id: "seed-list", type: "list_view", table: "seed", columns: ["title"] }],
      roles: [
        { id: "owner", name: "持ち主", rules: filler },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
      ],
    },
  } as unknown as Manifest);
  expect(applied.valid).toBe(true);

  // **1025 本目を自動で足そうとする** —— **表を1つ作るだけである。**
  const result = applyDiff(dataRoot, APP_ID, addTable("overflow") as unknown);
  expect(result.valid).toBe(false);
  // **拒否の理由が `owner` の `rules` の本数であることを名指しで残す。**
  const errors = (result as { errors: { path: string; message: string }[] }).errors;
  expect(errors.some((error) => error.path.includes("/app/roles/0/rules"))).toBe(true);

  // **表そのものも作られていない**(「全か無か」)。
  const after = applyDiff(dataRoot, APP_ID, {
    diff_id: "d-noop",
    intent: "現状を読む",
    operations: [{ op: "update_view", view: "seed-list", changes: { name: "土台一覧" } }],
  } as unknown as Diff);
  expect(after.valid).toBe(true);
  expect(
    (after as { manifest: Manifest }).manifest.app.tables.some((t) => t.id === "overflow"),
  ).toBe(false);
});

// ---------------------------------------------------------------------------
// (k) `applyManifest` には1バイトも入れていない —— **あとから規則を外せる**
// ---------------------------------------------------------------------------

test("(k) 一度外した規則は、次の適用で復活しない(自動付与は『作るたび』であって『常に』ではない)", () => {
  boot();
  const created = apply(addTable("orders"));
  expect(verbsFor(created, "viewer", { target: "table", table: "orders" })).toEqual(["read"]);

  // **`set_roles` で `viewer` の規則だけを外す。**
  const stripped = apply({
    diff_id: "d-strip",
    intent: "閲覧者の規則を外す",
    operations: [
      {
        op: "set_roles",
        roles: [
          {
            id: "owner",
            name: "持ち主",
            rules: rulesOf(created, "owner"),
          },
          { id: "editor", name: "編集者", rules: rulesOf(created, "editor") },
          { id: "viewer", name: "閲覧者" },
        ],
      },
    ],
  } as unknown as Diff);
  expect(verbsFor(stripped, "viewer", { target: "table", table: "orders" })).toBeUndefined();

  // **別の差分を打っても復活しない。**
  const later = apply({
    diff_id: "d-later",
    intent: "画面の名前を変える",
    operations: [{ op: "update_view", view: "seed-list", changes: { name: "土台一覧" } }],
  } as unknown as Diff);
  expect(verbsFor(later, "viewer", { target: "table", table: "orders" })).toBeUndefined();
});

// ---------------------------------------------------------------------------
// (l) **塞いでいない穴** —— 自動で足した規則は、消すときに自動では外れない
// ---------------------------------------------------------------------------

/**
 * **【期待値を反転させた。黙って書き換えていない。2026-08-10】**
 *
 * **旧の test 名の逐語**: 「(l) 【塞いでいない穴】T04 の後に作った画面は、規則を先に外さないと
 * remove_view で消せない」。
 * **旧の期待値の逐語**:
 *   `expect(removed.valid).toBe(false);`
 *   `expect(errors.some((error) => error.message.includes("規則が指すビュー"))).toBe(true);`
 *   `expect(errors.filter((error) => error.message.includes("規則が指すビュー")).length).toBe(3);`
 * **旧の doc の逐語(2案のうち案2 が採られた)**:
 *   「(案2)類型16 を「実在しない先を指す規則は無視する」に緩める
 *    —— **`ADR-0086` 限定4「書けるが必ず効かない宣言を1つも作らない」に当たる。**」
 *
 * **反転の根拠**: **ユーザ決定 `D-V8-66`(2026-08-10)が案2 を選んだ。**
 * **破られた明文の所在は `docs/adr/0086-field-value-unit.md:120`。**
 * **撤去箇所は `src/kernel/referential-integrity.ts` の類型16。**
 *
 * **カスケードは今日も1バイトも入れていない**(`ADR-0012` 限定4 の逐語「**カスケードしない**」
 * は生きている)—— **消せるようになったが、規則の行は残る。**
 * **残ることの実測は `src/kernel/role-rule-stale-target.test.ts` の (B) 群が持つ。**
 */
test("(l) 【`D-V8-66` で反転】T04 の後に作った画面は、規則を先に外さなくても remove_view で消せる", () => {
  boot();
  apply(addTable("orders"));
  apply({
    diff_id: "d-view2",
    intent: "画面を作る",
    operations: [
      {
        op: "add_view",
        view: { id: "order-list", type: "list_view", table: "orders", columns: ["title"] },
      },
    ],
  } as unknown as Diff);

  const removed = applyDiff(dataRoot, APP_ID, {
    diff_id: "d-rm-view",
    intent: "画面を消す",
    operations: [{ op: "remove_view", view: "order-list" }],
  } as unknown as Diff);
  expect(removed.valid).toBe(true);
  if (removed.valid) {
    // **画面は消えている。**
    expect(removed.manifest.app.views.some((view) => view.id === "order-list")).toBe(false);
    // **自動で入った3本は残る**(カスケードしないので、外れない)。
    expect(
      (["owner", "editor", "viewer"] as const).map(
        (roleId) =>
          rulesOf(removed.manifest, roleId).filter((rule) => rule.view === "order-list").length,
      ),
    ).toEqual([1, 1, 1]);
  }
});

// **【`D-V8-66` 以後】この形は今日「回避」ではない**(何もしなくても消せる)——
// **それでも残す**: **規則を残したくない人が取れる道が今日も在ることを固定している。**
// 旧の test 名の逐語: 「(l-2) 回避は今日1本だけ —— 同じ差分で set_roles を先に並べれば消せる」。
test("(l-2) 同じ差分で set_roles を先に並べれば、規則を残さずに消せる", () => {
  boot();
  apply(addTable("orders"));
  const withView = apply({
    diff_id: "d-view3",
    intent: "画面を作る",
    operations: [
      {
        op: "add_view",
        view: { id: "order-list", type: "list_view", table: "orders", columns: ["title"] },
      },
    ],
  } as unknown as Diff);

  const strip = (roleId: string) =>
    rulesOf(withView, roleId).filter((rule) => rule.view !== "order-list");
  const removed = apply({
    diff_id: "d-rm-view-ok",
    intent: "規則を外してから画面を消す",
    operations: [
      {
        op: "set_roles",
        roles: [
          { id: "owner", name: "持ち主", rules: strip("owner") },
          { id: "editor", name: "編集者", rules: strip("editor") },
          { id: "viewer", name: "閲覧者", rules: strip("viewer") },
        ],
      },
      { op: "remove_view", view: "order-list" },
    ],
  } as unknown as Diff);
  expect(removed.app.views.some((view) => view.id === "order-list")).toBe(false);
});

// ---------------------------------------------------------------------------
// (m) 〜 (n) **`D-V8-68` —— 自動付与が「行ごとの設定」を踏み潰さないようにする**
//
// **ユーザ決定 `D-V8-68`(2026-08-10)。選ばれた見出しの逐語**:
// 「**自動で入れるが「自分の行だけ」に絞る**」。
// **選ばれた説明文の逐語**: 「「作った人だけの表」には、自動の1行に「自分の行だけ」の条件を
// 付けて入れます。作った直後から使えて、他人の行は見えません。ただし運営が全件を見たいときは、
// 別に1行書くことになります。」
//
// **前段の担当が見つけた実測**: **自動付与は表の種類を見ていなかった** ——
// **`st_owner`(作った人だけの表)にも、行ごとのアクセス権を宣言した表にも、**無条件の**規則が
// 入っていた。** **面と点は `OR` なので、行ごとの設定が既定3役割に対して事実上無効になる。**
// ---------------------------------------------------------------------------

/** **`st_owner`(作った人だけの表)を持つ表を作る差分。** */
const addOwnerScopedTable = (id: string, diffId = "d-owner-table"): Diff =>
  ({
    diff_id: diffId,
    intent: "作った人だけの表を作る",
    operations: [
      {
        op: "add_table",
        table: {
          id,
          name: id,
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "st_owner", name: "持ち主", type: "text" },
          ],
        },
      },
    ],
  }) as unknown as Diff;

/** その役割のその表の規則の `when`(**1本も無ければ `undefined`**)。 */
function whenFor(manifest: Manifest, roleId: string, tableId: string): unknown {
  const found = rulesOf(manifest, roleId).find(
    (rule) => rule.target === "table" && rule.table === tableId,
  );
  return found === undefined ? undefined : found.when;
}

test("(m) `st_owner` を持つ表を add_table すると、3役割の規則に「自分の行だけ」の条件が付く", () => {
  boot();
  const manifest = apply(addOwnerScopedTable("orders"));
  for (const roleId of ["owner", "editor", "viewer"]) {
    // **【`V8-M26` / ユーザ決定 `D-V8-70`(2026-08-11)。旧の期待値を逐語で残す】**
    // **旧: `toEqual({ field: "st_owner", equals_current_user: true })`。**
    // **今日は「自分の行、**または**持ち主が空の行」である** ——
    // **`D-V8-68` の「自分の行だけ」が、共有行(`st_owner` を空にして「みんなのもの」に
    // した行)を誰にも見えなくしていたためである**(実測は
    // `web/e2e/owner-scope.e2e.ts` の「共有化すると双方に見える(API)」)。
    // **`test` 名の逐語(「自分の行だけ」)は1バイトも書き換えていない。**
    expect(whenFor(manifest, roleId, "orders")).toEqual({
      or: [
        { field: "st_owner", equals_current_user: true },
        { field: "st_owner", is_empty: true },
      ],
    });
  }
});

/**
 * **【`V8-M26` / ユーザ決定 `D-V8-70`】自動の1行が「他人の個人行」まで開けていないこと。**
 *
 * **`or` の左は「自分」のままである** —— **戻したのは共有行だけであり、
 * 他人が持ち主の行に当たる枝を1本も足していない。**
 */
test("(m-1b) 自動の条件は「自分」と「空」の2枝ちょうどで、3枝目を持たない", () => {
  boot();
  const manifest = apply(addOwnerScopedTable("orders"));
  const when = whenFor(manifest, "owner", "orders") as { or: Record<string, unknown>[] };
  expect(when.or).toHaveLength(2);
  // **どちらの枝も見ているのは `st_owner` 1本だけである**(別の項目を見る枝は無い)。
  expect(when.or.map((leaf) => leaf.field)).toEqual(["st_owner", "st_owner"]);
  // **`is_empty` に書いてあるのは `true` だけである**(「空でない」を書いていない)。
  expect(when.or[1]?.is_empty).toBe(true);
});

test("(m-2) 動詞は今日どおりである(条件を足しただけで、`can` を1語も減らしていない)", () => {
  boot();
  const manifest = apply(addOwnerScopedTable("orders"));
  expect(verbsFor(manifest, "owner", { target: "table", table: "orders" })).toEqual([
    "read",
    "write",
    "delete",
  ]);
  expect(verbsFor(manifest, "editor", { target: "table", table: "orders" })).toEqual([
    "read",
    "write",
  ]);
  expect(verbsFor(manifest, "viewer", { target: "table", table: "orders" })).toEqual(["read"]);
});

test("(m-3) 3役割の条件は別々のオブジェクトである(1本を書き換えても他の2本に波及しない)", () => {
  boot();
  const manifest = apply(addOwnerScopedTable("orders"));
  const conditions = ["owner", "editor", "viewer"].map((roleId) =>
    whenFor(manifest, roleId, "orders"),
  );
  expect(conditions[0]).not.toBe(conditions[1]);
  expect(conditions[1]).not.toBe(conditions[2]);
});

test("(m-4) `st_owner` を持たない表には条件が1つも付かない(今日どおり無条件で入る)", () => {
  boot();
  const manifest = apply(addTable("orders"));
  for (const roleId of ["owner", "editor", "viewer"]) {
    expect(whenFor(manifest, roleId, "orders")).toBeUndefined();
  }
});

test("(m-5) 画面とボタンには条件を1つも付けない(判定する行が1つも無いため)", () => {
  boot();
  apply(addOwnerScopedTable("orders"));
  const manifest = apply({
    diff_id: "d-owner-view",
    intent: "画面を作る",
    operations: [
      {
        op: "add_view",
        view: {
          id: "order-list",
          type: "list_view",
          table: "orders",
          columns: ["title"],
          actions: [{ id: "open-detail", view: "seed-list", name: "開く" }],
        },
      },
    ],
  } as unknown as Diff);
  for (const roleId of ["owner", "editor", "viewer"]) {
    const rules = rulesOf(manifest, roleId).filter((rule) => rule.target !== "table");
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.when).toBeUndefined();
    }
  }
});

// ---------------------------------------------------------------------------
// (n) **行ごとのアクセス権を宣言した表には、自動付与を1本も入れない**
//
// **【これはメインの裁定であって、ユーザ決定ではない】** —— **ユーザ決定 `D-V8-68` が
// 述べているのは「自動の行が行ごとの設定を踏み潰さない」までである。**
// **今日の `when` は葉が2形(「項目が値と等しい」「項目が自分と等しい」)しかなく
// (`schemas/manifest.schema.json` の `$defs/role_condition`)、「行ごとに付与された相手だけ」を
// 条件として書く手段が1つも無い。** **したがってその趣旨を今日の語彙で履行する道は
// 「入れない」しかない。**
//
// **【帰結。丸めない】** **その表は作った直後、持ち主にも見えない。**
// **`D-V8-56` の「作った直後から本人には見えます」は、行ごとのアクセス権を宣言した表に
// ついては成り立たない。**
//
// **【実測(2026-08-10)。実 HTTP で、入れていた頃と入れない今日を並べて測った】**
// **「作った直後、持ち主にも使えない」は、この変更が作った帰結ではない** ——
// **自動付与が入っていた頃も、利用者表に行を持たない人の作成は 400・一覧は 200 の空一覧
// だった**(止めていたのは点の側)。
// **失われたのは「付与を1件も持たない相手が、他人の行を全部読めること」1つである** ——
// **入れていた頃は別人が作った行が `total: 1` で見えていた。今日は空一覧である。**
// **これが「踏み潰し」の実体であり、`D-V8-68` が止めよと言っているものそのものである。**
// ---------------------------------------------------------------------------

/** 規約どおりの宣言(`src/kernel/access-control-declaration.test.ts` の確定形の写し)。 */
const DECLARATION: Record<string, unknown> = {
  enabled: true,
  permissions: [
    { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
    { id: "writer", name: "編集可", read: true, write: true, delete: false },
  ],
  creator_permission: "writer",
  grant: { table: "project_grant", target: "target", member: "member", permission: "permission" },
  members: { table: "member", account: "account" },
};

/** 守られる表 + 付与表 + 利用者表を、**1つの差分で**まとめて作る。 */
const addAccessControlledTables = (declaration: Record<string, unknown>): Diff =>
  ({
    diff_id: "d-access-control",
    intent: "行ごとのアクセス権を宣言した表を作る",
    operations: [
      {
        op: "add_table",
        table: {
          id: "project",
          name: "案件",
          fields: [{ id: "title", name: "件名", type: "text" }],
          access_control: declaration,
        },
      },
      {
        op: "add_table",
        table: {
          id: "project_grant",
          name: "案件の付与",
          fields: [
            { id: "target", name: "案件", type: "reference", reference_table: "project" },
            { id: "member", name: "利用者", type: "reference", reference_table: "member" },
            { id: "permission", name: "権限", type: "select", options: ["reader", "writer"] },
          ],
        },
      },
      {
        op: "add_table",
        table: {
          id: "member",
          name: "利用者",
          fields: [{ id: "account", name: "ログイン", type: "text" }],
        },
      },
    ],
  }) as unknown as Diff;

test("(n) 行ごとのアクセス権を宣言した表には、自動付与の規則が1本も入らない", () => {
  boot();
  const manifest = apply(addAccessControlledTables(DECLARATION));
  for (const roleId of ["owner", "editor", "viewer"]) {
    expect(verbsFor(manifest, roleId, { target: "table", table: "project" })).toBeUndefined();
  }
});

test("(n-2) 同じ差分で作った付与表・利用者表には、今日どおり自動付与が入る(止めるのは守られる表だけ)", () => {
  boot();
  const manifest = apply(addAccessControlledTables(DECLARATION));
  for (const tableId of ["project_grant", "member"]) {
    expect(verbsFor(manifest, "owner", { target: "table", table: tableId })).toEqual([
      "read",
      "write",
      "delete",
    ]);
  }
});

test("(n-3) `enabled: false` は宣言していない表と同じ扱いである(自動付与が今日どおり入る)", () => {
  boot();
  const manifest = apply(addAccessControlledTables({ ...DECLARATION, enabled: false }));
  expect(verbsFor(manifest, "owner", { target: "table", table: "project" })).toEqual([
    "read",
    "write",
    "delete",
  ]);
});

// ---------------------------------------------------------------------------
// (o) **`set_roles` で書いた「条件を1つも持たない表の規則」に、自動で同じ条件を補う**
//     (`V8-M40`。台帳 `F-G10`。ユーザ決定 `D-V8-98`。`ADR-0331`)
//
// **塞ぐもの(枠 §D の逐語)**: 「**後から足した役割にも、自動で入る規則と同じ条件の扱いを
// 揃える(または宣言時に警告する)**」。
//
// **【なぜ要るか。実測が先に在る】** **`docs/evidence/cp-v8-unify.md:2216` の逐語**:
// 「**同時刻の4相手で数え直した** —— **`alice`(owner)16 / `bob`(editor)10 /
// `carol`(viewer)8 / **`dave`(reviewer)19**。** **owner より reviewer のほうが
// 多く読める。**」 —— **`V8-M40` が自分の台で再現した実数は
// `alice` 6 / `bob` 5 / `carol` 2 / `dave` 9 である**(同じ向きの逆転)。
//
// **【補う対象は全役割である。`DEFAULT_ROLE_IDS` の3語に限らない】**
// **`v8-m35.md` §5-4 の `S3` の3点目の逐語**: 「**「後から足した」を機械的に見分ける
// 手段が無い。** **`set_roles` は全置換なので、既定3語と後から足した語の区別は
// `DEFAULT_ROLE_IDS` への所属だけで付く。**」 —— **本実装はその区別を1度も使わない。**
// **補うのは「条件を1つも書かなかった規則」だけであり、書けば必ず外れる**((o-2))。
//
// **【`ADR-0318` 限定12 との関係】** **逐語「カーネルは作者の宣言を上書きしない。
// 既に在る規則の動詞を1語も書き換えない・1本も消さない。足すだけである」** ——
// **本実装は動詞を1語も書き換えず、規則を1本も消さない**((o-8))。 **足すのは `when` 1つ
// だけである。** **それでも「書いていないものを補う」ことは限定12 が守る線の同じ側に
// 立つ** —— **その正面衝突は `ADR-0331` に書いた。**
// ---------------------------------------------------------------------------

/** **自動で入る条件(`defaultTableGrantPlan` が `st_owner` の表に付けるもの)の逐語。** */
const OWNER_SCOPE_CONDITION = {
  or: [
    { field: "st_owner", equals_current_user: true },
    { field: "st_owner", is_empty: true },
  ],
};

/** **その表を名指しした「条件なし・`read` だけ」の規則を持つ役割を1つ足す差分。** */
const setRolesAdding = (
  roleId: string,
  rules: Any[],
  base: RoleDeclaration[] = defaultRoles(),
  diffId = "d-set-roles",
): Diff =>
  ({
    diff_id: diffId,
    intent: "役割を宣言し直す",
    operations: [
      {
        op: "set_roles",
        roles: [...structuredClone(base), { id: roleId, name: roleId, rules }],
      },
    ],
  }) as unknown as Diff;

test("(o) `set_roles` で足した役割の、`st_owner` を持つ表の条件なしの規則に、自動で同じ条件が補われる", () => {
  boot();
  apply(addOwnerScopedTable("orders"));
  const manifest = apply(
    setRolesAdding("reviewer", [{ target: "table", table: "orders", can: ["read"] }]),
  );
  expect(whenFor(manifest, "reviewer", "orders")).toEqual(OWNER_SCOPE_CONDITION);
});

test("(o-2) 条件を自分で書いた規則には1バイトも補わない(逃げ道。書けば必ず外れる)", () => {
  boot();
  apply(addOwnerScopedTable("orders"));
  // **「常に真」の条件**(`or` の右が左の否定)。**今日の語彙だけで書ける。**
  const alwaysTrue = {
    or: [{ field: "st_owner", is_empty: true }, { not: { field: "st_owner", is_empty: true } }],
  };
  const manifest = apply(
    setRolesAdding("auditor", [
      { target: "table", table: "orders", can: ["read"], when: structuredClone(alwaysTrue) },
    ]),
  );
  expect(whenFor(manifest, "auditor", "orders")).toEqual(alwaysTrue);
});

test("(o-3) 補うのは全役割に一律である(既定3役割が条件なしで書き直されても補う)", () => {
  boot();
  apply(addOwnerScopedTable("orders"));
  const manifest = apply({
    diff_id: "d-set-roles-defaults",
    intent: "既定3役割を条件なしで書き直す",
    operations: [
      {
        op: "set_roles",
        roles: [
          {
            id: "owner",
            name: "持ち主",
            rules: [
              { target: "app", can: ["write"] },
              { target: "role", can: ["write"] },
              { target: "table", table: "orders", can: ["read", "write", "delete"] },
            ],
          },
          {
            id: "editor",
            name: "編集者",
            rules: [{ target: "table", table: "orders", can: ["read"] }],
          },
          {
            id: "viewer",
            name: "閲覧者",
            rules: [{ target: "table", table: "orders", can: ["read"] }],
          },
        ],
      },
    ],
  } as unknown as Diff);
  for (const roleId of ["owner", "editor", "viewer"]) {
    expect(whenFor(manifest, roleId, "orders")).toEqual(OWNER_SCOPE_CONDITION);
  }
});

test("(o-4) `st_owner` を持たない表の規則には1つも補わない", () => {
  boot();
  apply(addTable("orders"));
  const manifest = apply(
    setRolesAdding("reviewer", [{ target: "table", table: "orders", can: ["read"] }]),
  );
  expect(whenFor(manifest, "reviewer", "orders")).toBeUndefined();
});

test("(o-5) 行ごとのアクセス権を宣言した表の規則には1つも補わない(`skip` と同じ扱い)", () => {
  boot();
  apply(addAccessControlledTables(DECLARATION));
  const manifest = apply(
    setRolesAdding("reviewer", [{ target: "table", table: "project", can: ["read"] }]),
  );
  expect(whenFor(manifest, "reviewer", "project")).toBeUndefined();
});

test("(o-6) `add_field` で後から `st_owner` を足した表にも補う(doc が自認していた穴)", () => {
  boot();
  apply(addTable("orders"));
  apply({
    diff_id: "d-add-owner-field",
    intent: "後から持ち主の項目を足す",
    operations: [
      { op: "add_field", table: "orders", field: { id: "st_owner", name: "持ち主", type: "text" } },
    ],
  } as unknown as Diff);
  // **`add_field` の時点では、既定3役割の規則に条件は付いていない**(自動付与は
  // `add_table` の時点でしか走らない。`defaultTableGrantPlan` の doc が自認している穴)。
  const manifest = apply(
    setRolesAdding("reviewer", [{ target: "table", table: "orders", can: ["read"] }]),
  );
  expect(whenFor(manifest, "reviewer", "orders")).toEqual(OWNER_SCOPE_CONDITION);
});

test("(o-7) 実在しない表を名指しした規則には補わない(落ちない。拒否も増やさない)", () => {
  boot();
  const result = applyDiff(
    dataRoot,
    APP_ID,
    setRolesAdding("reviewer", [
      { target: "table", table: "no-such-table", can: ["read"] },
    ]) as unknown,
  );
  // **【`V8-M40` の実測。隠さない】** **役割の規則が実在しない表を名指ししても、
  // 今日の適用時検査は差分を拒否しない**(`valid: true` で通る)。
  // **本実装はこの穴を1バイトも塞いでいない** —— **`F-G10` の限定は「自動で同じ条件を
  // 補う」だけであり、拒否を1本も増やさない。** **補う側は表を引けないので何もしない。**
  expect(result.valid).toBe(true);
  if (!result.valid) {
    return;
  }
  expect(whenFor(result.manifest, "reviewer", "no-such-table")).toBeUndefined();
});

test("(o-8) 動詞を1語も書き換えない・規則を1本も消さない(`ADR-0318` 限定12)", () => {
  boot();
  apply(addOwnerScopedTable("orders"));
  const manifest = apply(
    setRolesAdding("reviewer", [
      { target: "table", table: "orders", can: ["read", "write", "delete"] },
      { target: "table", table: "seed", can: ["read"] },
    ]),
  );
  const rules = rulesOf(manifest, "reviewer");
  expect(rules).toHaveLength(2);
  expect(rules[0]?.can).toEqual(["read", "write", "delete"]);
  expect(rules[1]?.can).toEqual(["read"]);
});

test("(o-9) 補った条件は規則ごとに別のオブジェクトである(1本を書き換えても波及しない)", () => {
  boot();
  apply(addOwnerScopedTable("orders"));
  apply(addOwnerScopedTable("invoices", "d-owner-table-2"));
  const manifest = apply(
    setRolesAdding("reviewer", [
      { target: "table", table: "orders", can: ["read"] },
      { target: "table", table: "invoices", can: ["read"] },
    ]),
  );
  expect(whenFor(manifest, "reviewer", "orders")).not.toBe(
    whenFor(manifest, "reviewer", "invoices"),
  );
});

test("(o-10) 表(`table`)以外の対象には1つも補わない(画面・ボタン・app・role)", () => {
  boot();
  apply(addOwnerScopedTable("orders"));
  const manifest = apply(
    setRolesAdding("reviewer", [
      { target: "view", view: "seed-list", can: ["read"] },
      { target: "app", can: ["write"] },
    ]),
  );
  for (const rule of rulesOf(manifest, "reviewer")) {
    expect(rule.when).toBeUndefined();
  }
});

test("(o-11) 同じ差分で `set_roles` を `add_table` より先に並べると補われない(順序に依る。隠さない)", () => {
  boot();
  const manifest = apply({
    diff_id: "d-set-roles-before-table",
    intent: "役割を先に、表を後に並べる",
    operations: [
      {
        op: "set_roles",
        roles: [
          ...structuredClone(defaultRoles()),
          {
            id: "reviewer",
            name: "reviewer",
            rules: [{ target: "table", table: "seed", can: ["read"] }],
          },
        ],
      },
      {
        op: "add_field",
        table: "seed",
        field: { id: "st_owner", name: "持ち主", type: "text" },
      },
    ],
  } as unknown as Diff);
  // **`set_roles` を畳み込んだ時点で `seed` はまだ `st_owner` を持っていない。**
  // **後から同じ差分で足しても、遡って補いはしない。**
  expect(whenFor(manifest, "reviewer", "seed")).toBeUndefined();
});
