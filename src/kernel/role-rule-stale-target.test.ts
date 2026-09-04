/**
 * **`V8-M26` / `D-V8-66` —— 実在しない対象を指す「役割の規則」を拒否しないことの検査。**
 *
 * ## ユーザ決定(2026-08-10)の逐語
 *
 * > 画面はそのまま消せますが、それを名指ししていた権限の行がアプリに残ります。
 * > 残った行は何の効果も持ちませんが、権限の一覧を見た人は存在しない画面の名前を目にします。
 * > この基盤は『書けるが必ず効かない宣言を1つも作らない』を明文で守っており、そこを破ります。
 *
 * ## 何を破っているか(**隠さずに書く**)
 *
 * **破る明文**: `docs/adr/0086-field-value-unit.md:120`(限定4 の根拠の欄)の逐語
 * 「**「書けるが効かない組み合わせ」を1つも作らない**」。
 * **同じ作法を役割の規則について引き受けていたのが `src/kernel/referential-integrity.ts` の
 * 類型16 であり、`D-V8-66` はそこだけを開ける。**
 *
 * ## 開けるのは1箇所だけである
 *
 * **緩めるのは `app.roles[].rules` の `table` / `field` / `view` / `action` の実在検査だけ。**
 * **表・項目・画面そのものの参照整合性(画面が指す表、列が指す項目、ワークフローが指す表、
 * 関数が指す表 …)は1バイトも緩めていない** —— **(D) 群がそれを実測で固定する。**
 *
 * ## 誇張しない
 *
 * - **残った行が「必ず」効かないのは、その識別子を持つ対象がアプリに1つも無いあいだだけである。**
 *   **同じ識別子で作り直すと、残っていた行がそのまま効く**((E) が実測で残す)。
 *   **`D-V8-66` はこの復活を止めていない。**
 * - **カスケードで規則を外す実装は1バイトも入れていない**(`ADR-0012` 限定4
 *   「カスケードしない」は今日どおり)。**残るのは仕様である。**
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDiff } from "./apply-diff.ts";
import { applyManifest } from "./apply-manifest.ts";
import { createApp } from "./create-app.ts";
import { KernelMetaStore } from "./meta-store.ts";
import type { Diff, Manifest, RoleDeclaration, RoleRule } from "./types.ts";

const APP_ID = "stale-shop";

type Any = Record<string, unknown>;

function defaultRoles(): RoleDeclaration[] {
  return [
    // **【`V8-M28` / `T-G16a`】旧の逐語: `{ id: "owner", name: "持ち主" },`** ——
    // **今日は持ち主に2行が要る**(類型17 の拡張)。
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

function baseManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "残る行の店",
      tables: [
        {
          id: "seed",
          name: "土台",
          fields: [{ id: "title", name: "件名", type: "text", required: true }],
        },
      ],
      views: [{ id: "seed-list", type: "list_view", table: "seed", columns: ["title"] }],
      roles: defaultRoles(),
    },
  } as unknown as Manifest;
}

let dataRoot: string;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-role-stale-target-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "残る行の店", { app_id: APP_ID });
  } finally {
    store.close();
  }
  const applied = applyManifest(dataRoot, APP_ID, baseManifest());
  if (!applied.valid) {
    throw new Error(`前提のマニフェスト投入に失敗: ${JSON.stringify(applied.errors)}`);
  }
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

function apply(diff: Diff): Manifest {
  const result = applyDiff(dataRoot, APP_ID, diff as unknown);
  if (!result.valid) {
    throw new Error(`差分の適用に失敗: ${JSON.stringify(result.errors)}`);
  }
  return result.manifest;
}

function tryApply(diff: Diff): { valid: boolean; messages: string[] } {
  const result = applyDiff(dataRoot, APP_ID, diff as unknown);
  if (result.valid) {
    return { valid: true, messages: [] };
  }
  const errors = (result as { errors: { message: string }[] }).errors;
  return { valid: false, messages: errors.map((error) => error.message) };
}

function rulesOf(manifest: Manifest, roleId: string): RoleRule[] {
  return [...((manifest.app.roles ?? []).find((role) => role.id === roleId)?.rules ?? [])];
}

const addOrdersTable = (): Diff =>
  ({
    diff_id: "d-table",
    intent: "表を作る",
    operations: [
      {
        op: "add_table",
        table: {
          id: "orders",
          name: "注文",
          fields: [{ id: "title", name: "件名", type: "text", required: true }],
        },
      },
    ],
  }) as unknown as Diff;

const addOrderList = (diffId = "d-view"): Diff =>
  ({
    diff_id: diffId,
    intent: "画面を作る",
    operations: [
      {
        op: "add_view",
        view: { id: "order-list", type: "list_view", table: "orders", columns: ["title"] },
      },
    ],
  }) as unknown as Diff;

// ---------------------------------------------------------------------------
// (A) 自動付与が入った画面を `remove_view` で消せる
// ---------------------------------------------------------------------------

test("(A) 自動付与が入った画面は、規則を先に外さなくても remove_view で消せる", () => {
  apply(addOrdersTable());
  const withView = apply(addOrderList());
  // **前提**: 自動付与が3役割ぶん入っている(入っていなければ本検査は何も測れない)。
  expect(
    (["owner", "editor", "viewer"] as const).map(
      (roleId) => rulesOf(withView, roleId).filter((rule) => rule.view === "order-list").length,
    ),
  ).toEqual([1, 1, 1]);

  const removed = tryApply({
    diff_id: "d-rm-view",
    intent: "画面を消す",
    operations: [{ op: "remove_view", view: "order-list" }],
  } as unknown as Diff);
  expect(removed.valid).toBe(true);
});

test("(A-2) ボタンの規則が自動で入った画面も、そのまま消せる", () => {
  apply(addOrdersTable());
  apply({
    diff_id: "d-detail",
    intent: "詳細画面を作る",
    operations: [
      {
        op: "add_view",
        view: {
          id: "order-detail",
          type: "detail_view",
          table: "orders",
          fields: ["title"],
          actions: [{ id: "mark-done", set: { field: "title", value: "済" } }],
        },
      },
    ],
  } as unknown as Diff);

  const removed = tryApply({
    diff_id: "d-rm-detail",
    intent: "詳細画面を消す",
    operations: [{ op: "remove_view", view: "order-detail" }],
  } as unknown as Diff);
  expect(removed.valid).toBe(true);
});

test("(A-3) 自動付与が入った表も、画面を先に消せば remove_table で消せる", () => {
  apply(addOrdersTable());
  const removed = tryApply({
    diff_id: "d-rm-table",
    intent: "表を消す",
    operations: [{ op: "remove_table", table: "orders" }],
  } as unknown as Diff);
  expect(removed.valid).toBe(true);
});

// ---------------------------------------------------------------------------
// (B) 消したあとも規則の行が残っている
// ---------------------------------------------------------------------------

test("(B) 消したあとも、その画面を名指しした規則の行が3役割ぶん残る", () => {
  apply(addOrdersTable());
  apply(addOrderList());
  const after = apply({
    diff_id: "d-rm-view",
    intent: "画面を消す",
    operations: [{ op: "remove_view", view: "order-list" }],
  } as unknown as Diff);

  expect(after.app.views.some((view) => view.id === "order-list")).toBe(false);
  for (const roleId of ["owner", "editor", "viewer"] as const) {
    const stale = rulesOf(after, roleId).filter((rule) => rule.view === "order-list");
    expect(stale).toHaveLength(1);
    expect(stale[0]?.target).toBe("view");
  }
});

test("(B-2) 表を消したあとも、その表を名指しした規則の行が残る", () => {
  apply(addOrdersTable());
  const after = apply({
    diff_id: "d-rm-table",
    intent: "表を消す",
    operations: [{ op: "remove_table", table: "orders" }],
  } as unknown as Diff);

  expect(after.app.tables.some((table) => table.id === "orders")).toBe(false);
  for (const roleId of ["owner", "editor", "viewer"] as const) {
    expect(rulesOf(after, roleId).filter((rule) => rule.table === "orders")).toHaveLength(1);
  }
});

test("(B-3) 残った行を後から `set_roles` で外すことはできる(残りっぱなしを強制しない)", () => {
  apply(addOrdersTable());
  apply(addOrderList());
  const after = apply({
    diff_id: "d-rm-view",
    intent: "画面を消す",
    operations: [{ op: "remove_view", view: "order-list" }],
  } as unknown as Diff);

  const strip = (roleId: string) =>
    rulesOf(after, roleId).filter((rule) => rule.view !== "order-list");
  const cleaned = apply({
    diff_id: "d-clean",
    intent: "残った行を外す",
    operations: [
      {
        op: "set_roles",
        roles: [
          { id: "owner", name: "持ち主", rules: strip("owner") },
          { id: "editor", name: "編集者", rules: strip("editor") },
          { id: "viewer", name: "閲覧者", rules: strip("viewer") },
        ],
      },
    ],
  } as unknown as Diff);
  for (const roleId of ["owner", "editor", "viewer"] as const) {
    expect(rulesOf(cleaned, roleId).filter((rule) => rule.view === "order-list")).toHaveLength(0);
  }
});

// ---------------------------------------------------------------------------
// (C) 残った行は判定に1ミリも効かない
// ---------------------------------------------------------------------------

/**
 * **面(`judgeRoleAccess`)は `src/server/` に在り、カーネルの検査からは呼ばない**
 * (`src/kernel/*.test.ts` は今日1本も `src/server/` を import していない)。
 * **ここが測るのは、面が効きようのない形になっていることである** ——
 * **その識別子を持つ画面・表がマニフェストに1つも無いので、名指しできる対象が無い。**
 */
test("(C) 残った行が指す先は、マニフェストのどの画面・表とも一致しない(効かせる対象が無い)", () => {
  apply(addOrdersTable());
  apply(addOrderList());
  const after = apply({
    diff_id: "d-rm-both",
    intent: "画面と表を消す",
    operations: [
      { op: "remove_view", view: "order-list" },
      { op: "remove_table", table: "orders" },
    ],
  } as unknown as Diff);

  const viewIds = new Set(after.app.views.map((view) => view.id));
  const tableIds = new Set(after.app.tables.map((table) => table.id));
  const stale = (["owner", "editor", "viewer"] as const).flatMap((roleId) =>
    rulesOf(after, roleId).filter(
      (rule) =>
        (rule.view !== undefined && !viewIds.has(rule.view)) ||
        (rule.table !== undefined && !tableIds.has(rule.table)),
    ),
  );
  // **残っている**(0 本なら (B) が嘘になる)。
  expect(stale.length).toBeGreaterThan(0);
  // **どの行も、実在する対象を1つも名指ししていない。**
  for (const rule of stale) {
    if (rule.view !== undefined) expect(viewIds.has(rule.view)).toBe(false);
    if (rule.table !== undefined) expect(tableIds.has(rule.table)).toBe(false);
  }
});

// ---------------------------------------------------------------------------
// (D) 他の参照整合性は1バイトも緩めない
// ---------------------------------------------------------------------------

test("(D-1) 実在しない表を指す画面は、今日どおり拒否される", () => {
  const result = tryApply({
    diff_id: "d-bad-view",
    intent: "存在しない表の画面",
    operations: [
      {
        op: "add_view",
        view: { id: "ghost-list", type: "list_view", table: "ghosts", columns: ["title"] },
      },
    ],
  } as unknown as Diff);
  expect(result.valid).toBe(false);
});

test("(D-2) 実在しない項目を指す列は、今日どおり拒否される", () => {
  apply(addOrdersTable());
  const result = tryApply({
    diff_id: "d-bad-column",
    intent: "存在しない項目の列",
    operations: [
      {
        op: "add_view",
        view: { id: "order-list", type: "list_view", table: "orders", columns: ["ghost"] },
      },
    ],
  } as unknown as Diff);
  expect(result.valid).toBe(false);
});

test("(D-3) 画面から名指しされている表は、今日どおり remove_table で消せない", () => {
  apply(addOrdersTable());
  apply(addOrderList());
  const result = tryApply({
    diff_id: "d-rm-table-used",
    intent: "画面が残ったまま表を消す",
    operations: [{ op: "remove_table", table: "orders" }],
  } as unknown as Diff);
  expect(result.valid).toBe(false);
});

test("(D-4) 実在しない表を指すワークフローは、今日どおり拒否される", () => {
  const result = tryApply({
    diff_id: "d-bad-workflow",
    intent: "存在しない表のワークフロー",
    operations: [
      {
        op: "add_workflow",
        workflow: {
          id: "ghost-flow",
          name: "幽霊",
          trigger: { on: "record_created", table: "ghosts" },
          actions: [{ type: "create_record", table: "ghosts", values: { title: "x" } }],
          enabled: true,
        },
      },
    ],
  } as unknown as Diff);
  expect(result.valid).toBe(false);
});

test("(D-5) 役割の規則の条件(`when`)が指す項目の実在は、今日どおり検査される", () => {
  apply(addOrdersTable());
  const result = tryApply({
    diff_id: "d-bad-when",
    intent: "条件が存在しない項目を指す",
    operations: [
      {
        op: "set_roles",
        roles: [
          { id: "owner", name: "持ち主" },
          { id: "editor", name: "編集者" },
          {
            id: "viewer",
            name: "閲覧者",
            rules: [
              {
                target: "table",
                table: "orders",
                can: ["read"],
                when: { field: "ghost", equals: "x" },
              },
            ],
          },
        ],
      },
    ],
  } as unknown as Diff);
  expect(result.valid).toBe(false);
});

// ---------------------------------------------------------------------------
// (E) 誇張しない —— 同じ識別子で作り直すと、残っていた行がそのまま効く
// ---------------------------------------------------------------------------

test("(E) 【塞いでいない】同じ識別子で画面を作り直すと、残っていた行がそのまま当たる", () => {
  apply(addOrdersTable());
  apply(addOrderList());
  apply({
    diff_id: "d-rm-view",
    intent: "画面を消す",
    operations: [{ op: "remove_view", view: "order-list" }],
  } as unknown as Diff);

  // **`viewer` の残った行を「読める」から「読めない」へ書き換えられないので**
  // (画面の `can` は `read` 1語に閉じている)、**行を1本足して痕跡を作る。**
  const revived = apply(addOrderList("d-view-again"));
  for (const roleId of ["owner", "editor", "viewer"] as const) {
    // **自動付与は「同じ対象を名指しした規則が既に在るなら足さない」ので、
    //   復活後も1本のままである** —— **残っていた行がそのまま効いている証拠。**
    expect(rulesOf(revived, roleId).filter((rule) => rule.view === "order-list")).toHaveLength(1);
  }
  expect(revived.app.views.some((view) => view.id === "order-list")).toBe(true);
});

// ---------------------------------------------------------------------------
// (F) 手で書いた規則も同じ扱いである(自動付与に限らない)
// ---------------------------------------------------------------------------

test("(F) 最初から実在しない先を名指しした `set_roles` も通る(旧: 拒否されていた)", () => {
  // **旧の期待値の逐語**: 「実在しない画面IDは拒否される」(`valid === false`)。
  // **反転の根拠**: `D-V8-66`(2026-08-10)。
  const result = tryApply({
    diff_id: "d-ghost-rule",
    intent: "存在しない画面を名指しする",
    operations: [
      {
        op: "set_roles",
        roles: [
          // **【`V8-M28` / `T-G16a`】旧の逐語: `{ id: "owner", name: "持ち主" },`。**
          ...defaultRoles().slice(0, 2),
          {
            id: "viewer",
            name: "閲覧者",
            rules: [{ target: "view", view: "ghost-list", can: ["read"] }],
          },
        ],
      },
    ],
  } as unknown as Diff);
  expect(result.valid).toBe(true);
});

test("(F-2) `applyManifest` に直に渡しても通る(差分だけの緩めではない)", () => {
  const manifest = baseManifest();
  ((manifest.app as unknown as Any).roles as RoleDeclaration[])[2] = {
    id: "viewer",
    name: "閲覧者",
    rules: [
      { target: "table", table: "ghosts", can: ["read"] },
      { target: "field", table: "seed", field: "ghost", can: ["read"] },
      { target: "view", view: "ghost-list", can: ["read"] },
      { target: "action", view: "seed-list", action: "ghost", can: ["read"] },
    ],
  } as RoleDeclaration;
  expect(applyManifest(dataRoot, APP_ID, manifest).valid).toBe(true);
});
