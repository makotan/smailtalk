/**
 * **`V21-M2-T00`(`ADR-0482` §1-2b / §1-1 (iii-b))—— 保護を外す op の拒否。TDD の赤。**
 *
 * ## 本ファイルが固定するもの
 *
 * **差分を適用した後のマニフェストで、適用する前は未ログインに閉じていた表 T
 * (所有者で絞る表 / 付与を有効にした表 / 付与・名簿・グループの表 / 「自分」の条件を持つ表 /
 * 公開の印を持つ表)が閉じなくなり、かつ適用後の未ログインの要素に T を名指しした表の
 * 読取規則があるとき、その差分を拒否する**(`ADR-0482` §1-2b / 限定14)。
 *
 * | op | 拒否 | 同じ差分で規則を外すと |
 * |---|---|---|
 * | `st_owner` を外す(`remove_field`)| **(A-1)** | **(A-2)** 通る |
 * | 付与の宣言を `enabled: false` にする(`change_table`)| **(B-1)** | **(B-2)** 通る |
 * | 名簿・グループの宣言を外す(`change_table`。グループで測る)| **(C-1)** | — |
 * | ログイン済みの規則の条件から「自分」を外す(`set_roles`)| **(D-1)** | **(D-2)** 通る |
 * | `st_public` を外す(`remove_field`)| **(E-1)** | **(E-2)** 通る |
 *
 * **保護の状態を変えない無関係な差分は止めない**(**(F-1)**。`D-V8-66` の問題を起こさない)。
 *
 * **ログイン済みの規則の条件の「自分」は今日どおり書ける**(**(G-2)**)。
 * **未ログインの規則の条件に「自分」を書いた差分の拒否(`ADR-0482` §1-1 (iii-b) の後半)は
 * 本段で入れていない**(下の (G-1) の注記)。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDiff } from "./apply-diff.ts";
import { applyManifest } from "./apply-manifest.ts";
import { createApp } from "./create-app.ts";
import { KernelMetaStore } from "./meta-store.ts";
import type { Manifest } from "./types.ts";

const APP_ID = "anon-protect";

type Any = Record<string, unknown>;

const PERMISSIONS = [
  { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
  { id: "writer", name: "編集できる", read: true, write: true, delete: false },
];

function accessControl(options: { enabled: boolean; groups: boolean }): Any {
  return {
    enabled: options.enabled,
    permissions: PERMISSIONS,
    creator_permission: "writer",
    grant: {
      table: "t_ac_grant",
      target: "row",
      member: "member",
      ...(options.groups ? { group: "group" } : {}),
      permission: "permission",
    },
    members: { table: "t_ac_member", account: "account" },
    ...(options.groups ? { groups: { table: "t_ac_group" } } : {}),
  };
}

const OWNER_RULES: Any[] = [
  { target: "app", can: ["write"] },
  { target: "role", can: ["write"] },
  ...[
    "t_owner",
    "t_ac",
    "t_ac_member",
    "t_ac_group",
    "t_ac_grant",
    "t_self",
    "t_public",
    "t_plain",
  ].map((table) => ({ target: "table", table, can: ["read", "write", "delete"] })),
];

const SELF_RULE: Any = {
  target: "table",
  table: "t_self",
  can: ["read"],
  when: { field: "assignee", equals_current_user: true },
};

/** 未ログインの規則(`tables` を名指しした条件なしの読取)。 */
function anonymous(tables: readonly string[]): Any {
  return {
    id: "anonymous",
    name: "未ログイン",
    rules: tables.map((table) => ({ target: "table", table, can: ["read"] })),
  };
}

const ALL_ANON = ["t_owner", "t_ac", "t_ac_member", "t_ac_group", "t_self", "t_public"];

function roles(options: { anon: readonly string[]; editorRule?: Any }): Any[] {
  return [
    { id: "owner", name: "持ち主", rules: OWNER_RULES },
    { id: "editor", name: "編集者", rules: [options.editorRule ?? SELF_RULE] },
    { id: "viewer", name: "閲覧者" },
    anonymous(options.anon),
  ];
}

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "保護を外す op",
      tables: [
        {
          id: "t_owner",
          name: "所有者で絞る表",
          fields: [
            { id: "title", name: "題", type: "text" },
            { id: "st_owner", name: "所有者", type: "text" },
          ],
        },
        {
          id: "t_ac",
          name: "付与で守る表",
          fields: [{ id: "title", name: "題", type: "text" }],
          access_control: accessControl({ enabled: true, groups: true }),
        },
        {
          id: "t_ac_member",
          name: "利用者",
          fields: [{ id: "account", name: "ログイン", type: "text" }],
        },
        {
          id: "t_ac_group",
          name: "グループ",
          fields: [{ id: "name", name: "名前", type: "text" }],
        },
        {
          id: "t_ac_grant",
          name: "付与",
          fields: [
            { id: "row", name: "行", type: "reference", reference_table: "t_ac" },
            { id: "member", name: "相手", type: "reference", reference_table: "t_ac_member" },
            { id: "group", name: "グループ", type: "reference", reference_table: "t_ac_group" },
            { id: "permission", name: "権限", type: "select", options: ["reader", "writer"] },
          ],
        },
        {
          id: "t_self",
          name: "「自分」の条件の表",
          fields: [
            { id: "title", name: "題", type: "text" },
            { id: "assignee", name: "担当", type: "text" },
          ],
        },
        {
          id: "t_public",
          name: "公開の印の表",
          fields: [
            { id: "title", name: "題", type: "text" },
            { id: "st_public", name: "公開", type: "boolean" },
          ],
        },
        { id: "t_plain", name: "無関係な表", fields: [{ id: "title", name: "題", type: "text" }] },
      ],
      views: [],
      roles: roles({ anon: ALL_ANON }),
    },
  } as unknown as Manifest;
}

let dataRoot: string;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-anon-protect-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "保護を外す op", { app_id: APP_ID });
  } finally {
    store.close();
  }
  const applied = applyManifest(dataRoot, APP_ID, manifest());
  expect(applied.valid, JSON.stringify(applied)).toBe(true);
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

let seq = 0;
function apply(operations: Any[]) {
  seq += 1;
  return applyDiff(dataRoot, APP_ID, {
    diff_id: `d-anon-protect-${seq}`,
    intent: "保護を外す op の検査",
    operations,
  });
}

function setRoles(options: { anon: readonly string[]; editorRule?: Any }): Any {
  return { op: "set_roles", roles: roles(options) };
}

function without(table: string): string[] {
  return ALL_ANON.filter((name) => name !== table);
}

/** 拒否の文言に表 ID と「先に未ログインの規則から外す」旨が載っていること。 */
function expectRejectedFor(result: ReturnType<typeof apply>, table: string): void {
  expect(result.valid).toBe(false);
  if (result.valid) {
    return;
  }
  const text = JSON.stringify(result.errors);
  expect(text).toContain(table);
  expect(text).toContain("未ログイン");
}

// --- (A) st_owner を外す -------------------------------------------------------------------

test("(A-1) st_owner を外す差分は、未ログインの規則が残っていれば拒否", () => {
  expectRejectedFor(
    apply([{ op: "remove_field", table: "t_owner", field: "st_owner" }]),
    "t_owner",
  );
});

test("(A-2) 同じ差分で未ログインの規則から外せば通る", () => {
  const result = apply([
    { op: "remove_field", table: "t_owner", field: "st_owner" },
    setRoles({ anon: without("t_owner") }),
  ]);
  expect(result.valid, JSON.stringify(result)).toBe(true);
});

// --- (B) 付与の宣言を止める ----------------------------------------------------------------

test("(B-1) 付与の宣言を enabled: false にする差分は拒否", () => {
  expectRejectedFor(
    apply([
      {
        op: "change_table",
        table: "t_ac",
        changes: { access_control: accessControl({ enabled: false, groups: true }) },
      },
    ]),
    "t_ac",
  );
});

test("(B-2) 同じ差分で未ログインの規則から守られる表と名簿の表を外せば通る", () => {
  const result = apply([
    {
      op: "change_table",
      table: "t_ac",
      changes: { access_control: accessControl({ enabled: false, groups: true }) },
    },
    setRoles({
      anon: ALL_ANON.filter(
        (name) => name !== "t_ac" && name !== "t_ac_member" && name !== "t_ac_group",
      ),
    }),
  ]);
  expect(result.valid, JSON.stringify(result)).toBe(true);
});

// --- (C) 名簿・グループの宣言を外す(グループの宣言で測る。名簿は付与の宣言が必ず要るため外せない) ------------------------------------------------------------------

test("(C-1) グループの宣言を外す差分は、グループの表に未ログインの規則が残っていれば拒否", () => {
  expectRejectedFor(
    apply([
      {
        op: "change_table",
        table: "t_ac",
        changes: { access_control: accessControl({ enabled: true, groups: false }) },
      },
    ]),
    "t_ac_group",
  );
});

// --- (D) 「自分」の条件を外す --------------------------------------------------------------

test("(D-1) ログイン済みの規則の条件から「自分」を外す差分は拒否", () => {
  expectRejectedFor(
    apply([
      setRoles({ anon: ALL_ANON, editorRule: { target: "table", table: "t_self", can: ["read"] } }),
    ]),
    "t_self",
  );
});

test("(D-2) 同じ差分で未ログインの規則から外せば通る", () => {
  const result = apply([
    setRoles({
      anon: without("t_self"),
      editorRule: { target: "table", table: "t_self", can: ["read"] },
    }),
  ]);
  expect(result.valid, JSON.stringify(result)).toBe(true);
});

// --- (E) st_public を外す ------------------------------------------------------------------

test("(E-1) st_public を外す差分は、未ログインの規則が残っていれば拒否", () => {
  expectRejectedFor(
    apply([{ op: "remove_field", table: "t_public", field: "st_public" }]),
    "t_public",
  );
});

test("(E-2) 同じ差分で未ログインの規則から外せば通る", () => {
  const result = apply([
    { op: "remove_field", table: "t_public", field: "st_public" },
    setRoles({ anon: without("t_public") }),
  ]);
  expect(result.valid, JSON.stringify(result)).toBe(true);
});

// --- (F) 無関係な差分は止めない --------------------------------------------------------------

test("(F-1) 保護の状態を変えない差分は、保護された表に未ログインの規則があっても通る", () => {
  const result = apply([
    { op: "add_field", table: "t_plain", field: { id: "memo", name: "メモ", type: "text" } },
  ]);
  expect(result.valid, JSON.stringify(result)).toBe(true);
});

// --- (G) 未ログインの規則の条件に「自分」----------------------------------------------------

// **(G-1)「未ログインの規則の条件に『自分』を書いた差分は拒否」は `V21-M2` で入れていない**
// (`ADR-0482` §1-1 (iii-b) の後半)。 入れると授権(`ADR-0483`)の外の期待値2本が動くため、
// 記録 `docs/plan/v21/records/v21-m2.md` に未決として書いた。 **(G-2) は対照として残す。**

test("(G-2) ログイン済みの規則の条件の「自分」は今日どおり書ける", () => {
  const result = apply([
    setRoles({
      anon: ALL_ANON,
      editorRule: {
        target: "table",
        table: "t_self",
        can: ["read"],
        when: {
          or: [
            { field: "assignee", equals_current_user: true },
            { field: "title", equals: "x" },
          ],
        },
      },
    }),
  ]);
  expect(result.valid, JSON.stringify(result)).toBe(true);
});
