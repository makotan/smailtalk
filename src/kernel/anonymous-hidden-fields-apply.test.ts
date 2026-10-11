/**
 * **`V21-M2B-T00`(`ADR-0482` §2-2 / §2-5)—— 隠す項目(`hidden_fields`)の書き方と適用時の参照整合。TDD の赤。**
 *
 * | 題 | 期待 | 根拠 |
 * |---|---|---|
 * | (S-1) 未ログインの表の読取規則に書く | 通る | §2-2 の適用の例 |
 * | (S-2) ログインした人の役割に書く | 拒否(スキーマ) | §2-2 の拒否の例2 |
 * | (S-3) 表以外の規則(画面)に書く | 拒否(スキーマ) | §2-2 の拒否の例3 |
 * | (S-4) 空の並び・重複 | 拒否(スキーマ) | §2-2 の `minItems` / `uniqueItems` |
 * | (R-1) 実在しない項目 | 拒否 | §2-5 の実在 / 拒否の例1 |
 * | (R-2) 隠した項目を消す `remove_field` | 拒否 | §2-5 の消去 |
 * | (R-3) 同じ差分の `set_roles` で外していれば通る(順序に依らない) | 通る | §2-5(差分全体を適用した後で判定) |
 * | (R-4) 項目の改名 | 隠す並びが新しい名前へ追随 | §2-5 の改名 |
 * | (R-5) 未ログインの規則の条件に、同じ表の隠した項目を書く | 拒否 | §2-5 の `when` との組 |
 * | (R-6) 隠していない項目を条件に書く | 通る(対照) | 同上 |
 * | (Q-1) 要件定義書 | 隠す項目を1項目1文で述べる | §2-7 / §7 の追1 |
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDiff } from "./apply-diff.ts";
import { applyManifest } from "./apply-manifest.ts";
import { createApp } from "./create-app.ts";
import { generateRequirementsDoc, readCurrentManifest } from "./index.ts";
import { KernelMetaStore } from "./meta-store.ts";
import type { Manifest } from "./types.ts";

const APP_ID = "anon-hidden-apply";

type Any = Record<string, unknown>;

const OWNER: Any = {
  id: "owner",
  name: "持ち主",
  rules: [
    { target: "app", can: ["write"] },
    { target: "role", can: ["write"] },
    { target: "table", table: "product", can: ["read", "write", "delete"] },
  ],
};
const EDITOR: Any = { id: "editor", name: "編集者" };
const VIEWER: Any = { id: "viewer", name: "閲覧者" };

function anonymous(rules: Any[]): Any {
  return { id: "anonymous", name: "ログインしていない人", rules };
}

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "隠す項目の適用",
      tables: [
        {
          id: "product",
          name: "商品",
          fields: [
            { id: "name", name: "名前", type: "text" },
            { id: "status", name: "状態", type: "text" },
            { id: "cost", name: "仕入れ値", type: "number" },
            { id: "staff_memo", name: "店用メモ", type: "text" },
          ],
        },
      ],
      views: [{ id: "product-list", type: "list_view", table: "product", columns: ["name"] }],
      roles: [
        OWNER,
        EDITOR,
        VIEWER,
        anonymous([{ target: "table", table: "product", can: ["read"] }]),
      ],
    },
  } as unknown as Manifest;
}

let dataRoot: string;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-anon-hidden-apply-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "隠す項目の適用", { app_id: APP_ID });
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
    diff_id: `d-anon-hidden-apply-${seq}`,
    intent: "隠す項目の適用時検査",
    operations,
  });
}

function setRoles(anonRules: Any[], extra: Any[] = []): Any {
  return { op: "set_roles", roles: [OWNER, EDITOR, VIEWER, ...extra, anonymous(anonRules)] };
}

const HIDE_COST_MEMO: Any = {
  target: "table",
  table: "product",
  can: ["read"],
  hidden_fields: ["cost", "staff_memo"],
};

function anonymousRulesNow(): Any[] {
  const current = readCurrentManifest(dataRoot, APP_ID) as unknown as {
    app: { roles: Any[] };
  };
  const anon = current.app.roles.find((role) => role.id === "anonymous") as Any;
  return anon.rules as Any[];
}

function expectRejected(result: ReturnType<typeof apply>, ...needles: string[]): void {
  expect(result.valid, JSON.stringify(result)).toBe(false);
  const text = JSON.stringify(result);
  for (const needle of needles) {
    expect(text).toContain(needle);
  }
}

// --- (S) 書ける場所 --------------------------------------------------------------------------

test("(S-1) 未ログインの表の読取規則に hidden_fields を書く差分は通る", () => {
  const result = apply([setRoles([HIDE_COST_MEMO])]);
  expect(result.valid, JSON.stringify(result)).toBe(true);
  expect(anonymousRulesNow()[0]?.hidden_fields).toEqual(["cost", "staff_memo"]);
});

test("(S-2) ログインした人の役割(viewer)に hidden_fields を書く差分は拒否", () => {
  const viewer = {
    id: "viewer",
    name: "閲覧者",
    rules: [{ target: "table", table: "product", can: ["read"], hidden_fields: ["cost"] }],
  };
  const result = apply([
    {
      op: "set_roles",
      roles: [
        OWNER,
        EDITOR,
        viewer,
        anonymous([{ target: "table", table: "product", can: ["read"] }]),
      ],
    },
  ]);
  expectRejected(result, "hidden_fields");
});

test("(S-3) 未ログインの画面の規則に hidden_fields を書く差分は拒否", () => {
  const result = apply([
    setRoles([
      { target: "table", table: "product", can: ["read"] },
      { target: "view", view: "product-list", can: ["read"], hidden_fields: ["cost"] },
    ]),
  ]);
  expectRejected(result, "hidden_fields");
});

test("(S-4) 空の並び・同じ項目の重複は拒否", () => {
  expectRejected(
    apply([setRoles([{ target: "table", table: "product", can: ["read"], hidden_fields: [] }])]),
    "hidden_fields",
  );
  expectRejected(
    apply([
      setRoles([
        { target: "table", table: "product", can: ["read"], hidden_fields: ["cost", "cost"] },
      ]),
    ]),
    "hidden_fields",
  );
});

// --- (R) 適用時の参照整合 --------------------------------------------------------------------

test("(R-1) 実在しない項目を名指しした差分は拒否", () => {
  const result = apply([
    setRoles([
      { target: "table", table: "product", can: ["read"], hidden_fields: ["no_such_field"] },
    ]),
  ]);
  expectRejected(result, "no_such_field", "hidden_fields");
});

test("(R-2) 隠した項目を消す remove_field は拒否", () => {
  expect(apply([setRoles([HIDE_COST_MEMO])]).valid).toBe(true);
  const result = apply([{ op: "remove_field", table: "product", field: "cost" }]);
  expectRejected(result, "cost", "hidden_fields");
});

test("(R-3) 同じ差分の set_roles で隠す並びから外していれば、順序に依らず通る", () => {
  expect(apply([setRoles([HIDE_COST_MEMO])]).valid).toBe(true);
  const narrowed = { ...HIDE_COST_MEMO, hidden_fields: ["staff_memo"] };
  const after = apply([
    { op: "remove_field", table: "product", field: "cost" },
    setRoles([narrowed]),
  ]);
  expect(after.valid, JSON.stringify(after)).toBe(true);
  const before = apply([
    setRoles([{ ...HIDE_COST_MEMO, hidden_fields: ["staff_memo", "status"] }]),
  ]);
  expect(before.valid, JSON.stringify(before)).toBe(true);
  const reordered = apply([
    setRoles([narrowed]),
    { op: "remove_field", table: "product", field: "status" },
  ]);
  expect(reordered.valid, JSON.stringify(reordered)).toBe(true);
});

test("(R-4) 項目の改名は隠す並びへ追随する", () => {
  expect(apply([setRoles([HIDE_COST_MEMO])]).valid).toBe(true);
  const result = apply([
    { op: "change_field", table: "product", field: "cost", changes: { id: "purchase_cost" } },
  ]);
  expect(result.valid, JSON.stringify(result)).toBe(true);
  expect(anonymousRulesNow()[0]?.hidden_fields).toEqual(["purchase_cost", "staff_memo"]);
});

test("(R-5) 未ログインの規則の条件に、同じ表の隠した項目を書いた差分は拒否", () => {
  const result = apply([
    setRoles([
      HIDE_COST_MEMO,
      {
        target: "table",
        table: "product",
        can: ["read"],
        when: { field: "staff_memo", equals: "公開" },
      },
    ]),
  ]);
  expectRejected(result, "staff_memo", "hidden_fields");
});

test("(R-6) 隠していない項目を条件に書くのは通る(対照)", () => {
  const result = apply([
    setRoles([{ ...HIDE_COST_MEMO, when: { field: "status", equals: "open" } }]),
  ]);
  expect(result.valid, JSON.stringify(result)).toBe(true);
});

// --- (Q) 要件定義書 --------------------------------------------------------------------------

test("(Q-1) 要件定義書は隠す項目を1項目1文で述べる(宣言が無ければ1文も無い)", () => {
  const before = generateRequirementsDoc(dataRoot, APP_ID).statements.filter(
    (statement) => statement.template === "features.role_rule_hidden_field",
  );
  expect(before).toEqual([]);
  expect(apply([setRoles([HIDE_COST_MEMO])]).valid).toBe(true);
  const after = generateRequirementsDoc(dataRoot, APP_ID).statements.filter(
    (statement) => statement.template === "features.role_rule_hidden_field",
  );
  expect(after).toHaveLength(2);
  const text = JSON.stringify(after);
  expect(text).toContain("cost");
  expect(text).toContain("staff_memo");
  expect(text).toContain("anonymous");
});
