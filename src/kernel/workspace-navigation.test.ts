/**
 * **メニューの位置(左 / 上)をアプリの既定と役割ごとの上書きで宣言する**(`V22-M2-T01`。
 * [`ADR-0486`](../../../../docs/adr/0486-workspace-navigation-placement-and-19th-diff-op.md)。
 * 門A = `MN-G1` / `MN-G2`(限定採用)。ユーザの決定 `D-V22-1` / `D-V22-9` / `D-V22-10` / `D-V22-13`)。
 *
 * ## この検査が測るもの / 測らないもの(**先に書く**)
 *
 * **測るもの**:
 * 1. **設計図の形** —— `$defs/app` の10本目(末尾)`workspace`、中は `navigation` 1キー
 *    (`ADR-0486` 限定7)、`navigation` は `placement` / `by_role` の2キー、位置の値は `side` / `top` の2つ、
 *    `by_role` の要素は `role` / `placement` の2キー(限定8)。 `required` に入れない(限定1)。
 * 2. **差分操作と操作の器の本数と順序** —— `DIFF_OPS` と `op_name` は19種で、末尾が `set_workspace`、
 *    最初の18は着手前(`1af09ebc`)の並びのまま(限定3)。 操作の器は11キーで末尾が `workspace`(限定2)。
 *    分岐は19本で、既存18分岐すべてが `workspace` を `false` で禁じる(限定4)。 `$defs` は 31 / 5 のまま(限定5)。
 * 3. **受理** —— 既定だけ / 役割の上書きつき / `{}`(宣言を消す)。
 *    **【`V22-M3-T02` / `ADR-0488` §Decision 1・2(授権 `ADR-0489` 行4)】`{}` は断り、宣言を消すのは `null` である。** 旧の注釈は上の1行の逐語のまま残した。
 * 4. **拒否** —— 未知の位置の値 / 未知のキー(3段とも)/ `anonymous` / 宣言されていない役割 / 同じ役割の重複 /
 *    役割を宣言していないアプリの `by_role` / `set_roles` で参照先を消す(差分全体を断り、同じ差分で
 *    `set_workspace` も直すよう案内する)。
 * 5. **畳み込み** —— 丸ごと差し替える / `{}` でキーごと消え、定義は宣言前と1バイトも違わない / 純粋関数。
 *    **【`V22-M3-T02` / `ADR-0488` §Decision 1・2(授権 `ADR-0489` 行4)】直下のキーごとの置き換え(書いたキーの中は丸ごと)/ `null` でキーが消え、すべて消えると
 *    宣言前と1バイトも違わない。** 旧の注釈は上の1行の逐語のまま残した。
 * 6. **適用・元に戻す・移行・要件定義書** —— 適用すると定義に入る / 移行の段を1つも生まない /
 *    undo で宣言前に戻る / 要件定義書は位置を1文も述べない。
 *
 * **測らないもの(誇張しない)**:
 * 1. **画面が位置に従って描かれること**(`T04` / `T05`)。 **`GET /public` の形**(`T06`)。 **生成器**(`T07`)。
 * 2. **AI へ配る説明文**(`T03`)。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import diffSchema from "../../schemas/diff.schema.json" with { type: "json" };
import manifestSchema from "../../schemas/manifest.schema.json" with { type: "json" };
import { applyDiff, foldOperations } from "./apply-diff.ts";
import { applyManifest, readCurrentManifest } from "./apply-manifest.ts";
import { createApp } from "./create-app.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { planMigration } from "./migrate.ts";
import { generateRequirementsDoc } from "./requirements-doc.ts";
import type { Manifest, Operation } from "./types.ts";
import { DIFF_OPS } from "./types.ts";
import { undo } from "./undo.ts";
import { validateDiff, validateManifestFull } from "./validate.ts";

type Any = Record<string, unknown>;

const DEFS = "$defs";
const M = (manifestSchema as unknown as Any)[DEFS] as Any;
const D = (diffSchema as unknown as Any)[DEFS] as Any;

/** 着手前(`1af09ebc`)の `DIFF_OPS` の18種(名前も順序も動かさない。`ADR-0486` 限定3)。 */
const FIRST_18_OPS = [
  "add_table",
  "add_field",
  "add_view",
  "update_view",
  "remove_field",
  "remove_table",
  "change_table",
  "change_field",
  "remove_view",
  "add_workflow",
  "update_workflow",
  "remove_workflow",
  "add_function",
  "update_function",
  "remove_function",
  "set_theme",
  "set_roles",
  "remember_design",
];

/** 着手前の操作の器の10キー(名前も順序も動かさない)。 */
const FIRST_10_OPERATION_KEYS = [
  "op",
  "table",
  "field",
  "view",
  "changes",
  "workflow",
  "function",
  "theme",
  "roles",
  "design_memory",
];

function appWorkspace(): Any {
  return (((M.app as Any).properties as Any).workspace ?? {}) as Any;
}

function navigationDef(): Any {
  return ((appWorkspace().properties ?? {}) as Any).navigation as Any;
}

function operationDef(): Any {
  return D.operation as Any;
}

function branches(): Any[] {
  return (operationDef().allOf ?? []) as Any[];
}

function branchOp(branch: Any): string | undefined {
  return ((((branch.if as Any)?.properties ?? {}) as Any).op as Any)?.const as string | undefined;
}

function branchOf(op: string): Any | undefined {
  return branches().find((b) => branchOp(b) === op);
}

/** 既定3役割(持ち主には2行の規則が要る。類型17 の拡張)+ `staff` / `member`。 */
function roles(extra: string[] = ["staff", "member"]): Any[] {
  return [
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
    ...extra.map((id) => ({ id, name: id })),
  ];
}

function baseManifest(withRoles = true): Manifest {
  const manifest: Any = {
    app: {
      id: "shop",
      name: "店",
      tables: [
        {
          id: "orders",
          name: "注文",
          fields: [{ id: "title", name: "件名", type: "text", required: true }],
        },
      ],
      views: [{ id: "order-list", type: "list_view", table: "orders", columns: ["title"] }],
    },
  };
  if (withRoles) {
    (manifest.app as Any).roles = roles();
  }
  return manifest as unknown as Manifest;
}

function diffOf(operations: unknown[], diffId = "ws-1"): unknown {
  return { diff_id: diffId, intent: "メニューの位置を決める", operations };
}

function setWorkspace(workspace: unknown): Any {
  return { op: "set_workspace", workspace };
}

function fold(current: Manifest, operations: unknown[]): Manifest {
  const result = foldOperations(current, operations as Operation[]);
  if (!result.valid) {
    throw new Error(`畳み込みが失敗しました: ${JSON.stringify(result.errors)}`);
  }
  return result.manifest;
}

function workspaceOf(manifest: Manifest): Any | undefined {
  return (manifest.app as unknown as Any).workspace as Any | undefined;
}

/** 畳み込んだ後の定義を、適用と同じ `"incoming"` で検証する。 */
function validateFolded(current: Manifest, operations: unknown[]) {
  return validateManifestFull(fold(current, operations));
}

type ErrorLike = { path: string; message: string; allowed_values?: unknown[]; hint?: string };

function errorsOf(result: { valid: boolean }): ErrorLike[] {
  return result.valid ? [] : ((result as unknown as { errors: ErrorLike[] }).errors ?? []);
}

// =====================================================================================
// 1. 設計図の形(ADR-0486 限定1〜5・7・8)
// =====================================================================================

describe("(1) 設計図の形 —— `workspace` / `set_workspace` / 11キー目", () => {
  test("`$defs/app` の10本目(末尾)が `workspace` で、既存9キーの並びは動かない。`required` に入れない", () => {
    expect(Object.keys((M.app as Any).properties as Any)).toEqual([
      "id",
      "name",
      "tables",
      "views",
      "workflows",
      "functions",
      "theme",
      "roles",
      "design_memory",
      "workspace",
    ]);
    expect((M.app as Any).additionalProperties).toBe(false);
    expect((M.app as Any).required).toEqual(["id", "name", "tables", "views"]);
  });

  // **【`V22-M3-T02` / `ADR-0488` §Decision 1・2(授権 `ADR-0489` 行4)】`ADR-0486` 限定7 を `ADR-0488` 限定1 が引き直した。**
  // **旧の題名(逐語)**: 「限定7: `workspace` の中は `navigation` の1キーで閉じ、空の器を許さない」
  // **旧の期待(逐語)**: `expect(Object.keys((ws.properties ?? {}) as Any)).toEqual(["navigation"]);`
  test("限定7(`ADR-0488` 限定1 で引き直し): `workspace` の中は `navigation` と `my_page` の2キーで閉じ、空の器を許さない", () => {
    const ws = appWorkspace();
    expect(ws.type).toBe("object");
    expect(ws.additionalProperties).toBe(false);
    expect(ws.minProperties).toBe(1);
    // **【2026-09-30。`V23-M5-T02` / 授権 `ADR-0533` 行6】`workspace` の3つ目のキー `invitations`(自分宛ての招待の受け取り画面。`ADR-0532` 限定1)を末尾に足した。 旧の期待(逐語): `expect(Object.keys((ws.properties ?? {}) as Any)).toEqual(["navigation", "my_page"]);` 新しい値はスキーマを python で読んで得た。**
    expect(Object.keys((ws.properties ?? {}) as Any)).toEqual([
      "navigation",
      "my_page",
      "invitations",
    ]);
  });

  test("限定8: `navigation` は `placement` / `by_role` の2キー、位置は `side` / `top`、要素は `role` / `placement`", () => {
    const nav = navigationDef();
    expect(nav.type).toBe("object");
    expect(nav.additionalProperties).toBe(false);
    expect(nav.minProperties).toBe(1);
    const props = (nav.properties ?? {}) as Any;
    expect(Object.keys(props)).toEqual(["placement", "by_role"]);
    expect((props.placement as Any).enum).toEqual(["side", "top"]);
    const byRole = props.by_role as Any;
    expect(byRole.type).toBe("array");
    expect(byRole.minItems).toBe(1);
    const item = byRole.items as Any;
    expect(item.type).toBe("object");
    expect(item.additionalProperties).toBe(false);
    expect(item.required).toEqual(["role", "placement"]);
    expect(Object.keys((item.properties ?? {}) as Any)).toEqual(["role", "placement"]);
    expect(((item.properties as Any).placement as Any).enum).toEqual(["side", "top"]);
  });

  test("限定3: `DIFF_OPS` と `op_name` は19種で末尾が `set_workspace`、最初の18は着手前のまま", () => {
    expect(DIFF_OPS).toHaveLength(19);
    expect(([...DIFF_OPS] as string[]).slice(0, 18)).toEqual(FIRST_18_OPS);
    expect(DIFF_OPS[18]).toBe("set_workspace");
    expect((D.op_name as Any).enum).toEqual([...DIFF_OPS]);
  });

  test("限定2: 操作の器は11キーで、末尾(11キー目)が `workspace`。既存10キーの並びは動かない", () => {
    expect(Object.keys(operationDef().properties as Any)).toEqual([
      ...FIRST_10_OPERATION_KEYS,
      "workspace",
    ]);
  });

  test("限定4: 分岐は19本で、既存18分岐はすべて `workspace` を `false` で禁じる(ADR-0013 §4c 問2)", () => {
    expect(branches()).toHaveLength(19);
    const existing = branches().filter((b) => branchOp(b) !== "set_workspace");
    expect(existing.map(branchOp)).toEqual(FIRST_18_OPS);
    for (const branch of existing) {
      const props = ((branch.then as Any).properties ?? {}) as Any;
      expect([branchOp(branch), props.workspace]).toEqual([branchOp(branch), false]);
      // 全分岐が器の全キー(`op` を除く10)の可否を明示する(被覆)。
      expect(Object.keys(props)).toHaveLength(10);
    }
  });

  test("`set_workspace` の分岐は `workspace` を必須にし、残る9キーを `false` で禁じる", () => {
    const branch = branchOf("set_workspace");
    expect(branch).toBeDefined();
    const then = (branch?.then ?? {}) as Any;
    expect(then.required).toEqual(["workspace"]);
    const props = (then.properties ?? {}) as Any;
    expect(Object.keys(props)).toHaveLength(10);
    for (const key of FIRST_10_OPERATION_KEYS.filter((k) => k !== "op")) {
      expect([key, props[key]]).toEqual([key, false]);
    }
  });

  test("限定5: 新しい `$defs` を1本も作らない(manifest 31 / diff 5)", () => {
    expect(Object.keys(M)).toHaveLength(31);
    expect(Object.keys(D)).toHaveLength(5);
  });

  test("ADR-0013 §4c の3問の答えが操作の器の `workspace` の `$comment` に在る", () => {
    const comment = String(
      (((operationDef().properties as Any).workspace ?? {}) as Any).$comment ?? "",
    );
    expect(comment).toContain("ADR-0486");
    expect(comment).toContain("問1");
    expect(comment).toContain("問2");
    expect(comment).toContain("問3");
    expect(comment).toContain("11キー");
  });
});

// =====================================================================================
// 2. 差分の受理と、設計図が断る形
// =====================================================================================

describe("(2) `set_workspace` の受理", () => {
  test.each([
    ["既定だけ(上)", { navigation: { placement: "top" } }],
    ["既定だけ(左)", { navigation: { placement: "side" } }],
    [
      "既定 + 役割の上書き",
      {
        navigation: {
          placement: "side",
          by_role: [
            { role: "staff", placement: "top" },
            { role: "member", placement: "side" },
          ],
        },
      },
    ],
    [
      "上書きだけ(既定は左のまま)",
      { navigation: { by_role: [{ role: "staff", placement: "top" }] } },
    ],
    // **【`V22-M3-T02` / `ADR-0488` §Decision 1・2(授権 `ADR-0489` 行4)】`{}` は断る(下の「空の器 `{}` は断る」)。**
    // **旧の行(逐語)**: `["空の器(宣言を消す)", {}],`
    ["`null` で宣言を消す(`ADR-0488` §Decision 2)", { navigation: null }],
  ])("%s", (_label, workspace) => {
    const result = validateDiff(diffOf([setWorkspace(workspace)]));
    expect(errorsOf(result)).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

describe("(2) 設計図が断る形", () => {
  test("未知の位置の値(下)は断り、`side` / `top` を示す", () => {
    const result = validateDiff(diffOf([setWorkspace({ navigation: { placement: "bottom" } })]));
    expect(result.valid).toBe(false);
    const error = errorsOf(result).find((e) => e.path.endsWith("/navigation/placement"));
    expect(error).toBeDefined();
    expect(error?.allowed_values).toEqual(["side", "top"]);
  });

  test("役割の上書きの未知の位置の値も断る", () => {
    const result = validateDiff(
      diffOf([setWorkspace({ navigation: { by_role: [{ role: "staff", placement: "hidden" }] } })]),
    );
    expect(result.valid).toBe(false);
    const error = errorsOf(result).find((e) => e.path.endsWith("/by_role/0/placement"));
    expect(error?.allowed_values).toEqual(["side", "top"]);
  });

  // **【`V22-M3-T02` / `ADR-0488` §Decision 1・2(授権 `ADR-0489` 行4)】`my_page` は2つ目のキーとして受ける。 断るのは3つ目のキーである。**
  // **旧の題名(逐語)**: 「`workspace` の未知のキー(2つ目のキー)は断り、`navigation` だけを示す」
  // **旧の本体(逐語)**: `diffOf([setWorkspace({ navigation: { placement: "top" }, my_page: {} })])` /
  // `errorsOf(result).find((e) => e.message.includes("my_page"))` / `expect(error?.allowed_values).toEqual(["navigation"]);`
  test("`workspace` の未知のキー(3つ目のキー)は断り、`navigation` と `my_page` を示す", () => {
    const result = validateDiff(
      diffOf([setWorkspace({ navigation: { placement: "top" }, notifications: {} })]),
    );
    expect(result.valid).toBe(false);
    const error = errorsOf(result).find((e) => e.message.includes("notifications"));
    expect(error).toBeDefined();
    // **【2026-09-30。`V23-M5-T02` / 授権 `ADR-0533` 行7】`workspace` の3つ目のキー `invitations`(自分宛ての招待の受け取り画面。`ADR-0532` 限定1)を末尾に足した。 旧の期待(逐語): `expect(error?.allowed_values).toEqual(["navigation", "my_page"]);` 新しい値はスキーマを python で読んで得た。**
    expect(error?.allowed_values).toEqual(["navigation", "my_page", "invitations"]);
  });

  // **【`V22-M3-T02` / `ADR-0488` §Decision 1・2(授権 `ADR-0489` 行4)】受理の表の `{}` の行を、ここで断る形に移した。**
  test("空の器 `{}` は断る(何も変えない指示)", () => {
    const result = validateDiff(diffOf([setWorkspace({})]));
    expect(result.valid).toBe(false);
    expect(errorsOf(result).map((e) => e.path)).toEqual(["/operations/0/workspace"]);
  });

  test("`navigation` の未知のキー(画面ごとの位置など)は断る", () => {
    const result = validateDiff(
      diffOf([setWorkspace({ navigation: { placement: "top", by_view: [] } })]),
    );
    expect(result.valid).toBe(false);
    const error = errorsOf(result).find((e) => e.message.includes("by_view"));
    expect(error?.allowed_values).toEqual(["placement", "by_role"]);
  });

  test("`by_role` の要素の未知のキーは断る", () => {
    const result = validateDiff(
      diffOf([
        setWorkspace({
          navigation: { by_role: [{ role: "staff", placement: "top", order: 1 }] },
        }),
      ]),
    );
    expect(result.valid).toBe(false);
    const error = errorsOf(result).find((e) => e.message.includes("order"));
    expect(error?.allowed_values).toEqual(["role", "placement"]);
  });

  test("空の `navigation` と空の `by_role` は断る", () => {
    expect(validateDiff(diffOf([setWorkspace({ navigation: {} })])).valid).toBe(false);
    expect(validateDiff(diffOf([setWorkspace({ navigation: { by_role: [] } })])).valid).toBe(false);
  });

  test("`workspace` を欠いた `set_workspace` は必須の誤り", () => {
    const result = validateDiff(diffOf([{ op: "set_workspace" }]));
    expect(result.valid).toBe(false);
    expect(errorsOf(result).some((e) => e.message.includes("workspace"))).toBe(true);
  });

  test("他の op(`set_roles`)に `workspace` は書けない", () => {
    const result = validateDiff(
      diffOf([
        { op: "set_roles", roles: roles(), workspace: { navigation: { placement: "top" } } },
      ]),
    );
    expect(result.valid).toBe(false);
  });

  test("アプリの定義に直接書いた空の `workspace` は断る(空の器を残さない)", () => {
    const manifest = baseManifest() as unknown as Any;
    (manifest.app as Any).workspace = {};
    expect(validateManifestFull(manifest).valid).toBe(false);
  });
});

// =====================================================================================
// 3. 畳み込んだ後の検査(ADR-0486 §Decision 1 の 5)
// =====================================================================================

describe("(3) 畳み込んだ後の検査 —— 役割を指す参照", () => {
  test("宣言した役割だけを指す上書きは通る", () => {
    const result = validateFolded(baseManifest(), [
      setWorkspace({
        navigation: {
          placement: "side",
          by_role: [
            { role: "staff", placement: "top" },
            { role: "owner", placement: "top" },
          ],
        },
      }),
    ]);
    expect(errorsOf(result)).toEqual([]);
  });

  test("宣言されていない役割は断り、宣言された役割を示す", () => {
    const result = validateFolded(baseManifest(), [
      setWorkspace({ navigation: { by_role: [{ role: "guest", placement: "top" }] } }),
    ]);
    expect(result.valid).toBe(false);
    const errors = errorsOf(result);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("/app/workspace/navigation/by_role/0/role");
    expect(errors[0]?.message).toContain('"guest"');
    expect(errors[0]?.allowed_values).toEqual(["owner", "editor", "viewer", "staff", "member"]);
  });

  test("`anonymous` は断る(未ログインはアプリの既定。D-V22-10)", () => {
    const result = validateFolded(baseManifest(), [
      setWorkspace({ navigation: { by_role: [{ role: "anonymous", placement: "top" }] } }),
    ]);
    expect(result.valid).toBe(false);
    const errors = errorsOf(result);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("/app/workspace/navigation/by_role/0/role");
    expect(errors[0]?.message).toContain("anonymous");
    expect(errors[0]?.allowed_values).not.toContain("anonymous");
  });

  test("`anonymous` を役割として宣言したアプリでも断る", () => {
    const manifest = baseManifest() as unknown as Any;
    (manifest.app as Any).roles = [...roles(), { id: "anonymous", name: "未ログイン" }];
    const result = validateFolded(manifest as unknown as Manifest, [
      setWorkspace({ navigation: { by_role: [{ role: "anonymous", placement: "top" }] } }),
    ]);
    expect(result.valid).toBe(false);
    expect(errorsOf(result)[0]?.path).toBe("/app/workspace/navigation/by_role/0/role");
    expect(errorsOf(result)[0]?.allowed_values).not.toContain("anonymous");
  });

  test("同じ役割が2回出てくると断る(並びで勝ち負けを決めない)", () => {
    const result = validateFolded(baseManifest(), [
      setWorkspace({
        navigation: {
          by_role: [
            { role: "staff", placement: "top" },
            { role: "staff", placement: "side" },
          ],
        },
      }),
    ]);
    expect(result.valid).toBe(false);
    const errors = errorsOf(result);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("/app/workspace/navigation/by_role/1/role");
    expect(errors[0]?.message).toContain('"staff"');
  });

  test("役割を宣言していないアプリで `by_role` を書くと断る(既定だけなら通る)", () => {
    const noRoles = baseManifest(false);
    const rejected = validateFolded(noRoles, [
      setWorkspace({ navigation: { by_role: [{ role: "staff", placement: "top" }] } }),
    ]);
    expect(rejected.valid).toBe(false);
    const errors = errorsOf(rejected);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("/app/workspace/navigation/by_role");
    expect(errors[0]?.message).toContain("roles");

    const accepted = validateFolded(noRoles, [setWorkspace({ navigation: { placement: "top" } })]);
    expect(errorsOf(accepted)).toEqual([]);
  });
});

// =====================================================================================
// 4. 畳み込み(丸ごと差し替え・`{}` で消える・純粋関数)
//    【`V22-M3-T02` / `ADR-0488` §Decision 2(授権 `ADR-0489` 行4)】今日は「直下のキーごとの置き換え・`null` で消える・
//    純粋関数」。 上の見出しは逐語のまま残した。
// =====================================================================================

describe("(4) 畳み込み", () => {
  test("宣言が無いアプリに入る", () => {
    const next = fold(baseManifest(), [setWorkspace({ navigation: { placement: "top" } })]);
    expect(workspaceOf(next)).toEqual({ navigation: { placement: "top" } });
  });

  test("丸ごと差し替える(前の `by_role` は残らない)", () => {
    const first = fold(baseManifest(), [
      setWorkspace({
        navigation: { placement: "side", by_role: [{ role: "staff", placement: "top" }] },
      }),
    ]);
    const second = fold(first, [setWorkspace({ navigation: { placement: "top" } })]);
    expect(workspaceOf(second)).toEqual({ navigation: { placement: "top" } });
  });

  // **【`V22-M3-T02` / `ADR-0488` §Decision 1・2(授権 `ADR-0489` 行4)】`{}` は設計図が断るので、消すのは `null` である。**
  // **旧の題名(逐語)**: 「`{}` でキーごと消え、定義は宣言前と1バイトも違わない」
  // **旧の本体(逐語)**: `const removed = fold(declared, [setWorkspace({})]);`
  test("`null` でキーごと消え、定義は宣言前と1バイトも違わない", () => {
    const before = baseManifest();
    const declared = fold(before, [setWorkspace({ navigation: { placement: "top" } })]);
    const removed = fold(declared, [setWorkspace({ navigation: null })]);
    expect(Object.keys(removed.app)).not.toContain("workspace");
    expect(JSON.stringify(removed)).toBe(JSON.stringify(before));
  });

  // **【`V22-M3-T02` / `ADR-0488` §Decision 1・2(授権 `ADR-0489` 行4)】`{}` は設計図が断るので、`null` を送る形に移した。**
  // **旧の題名(逐語)**: 「宣言が無いアプリに `{}` を送っても器は生まれない」
  // **旧の本体(逐語)**: `const next = fold(before, [setWorkspace({})]);`
  test("宣言が無いアプリに `null` を送っても器は生まれない", () => {
    const before = baseManifest();
    const next = fold(before, [setWorkspace({ navigation: null })]);
    expect(JSON.stringify(next)).toBe(JSON.stringify(before));
  });

  test("元の定義を書き換えない(純粋関数)", () => {
    const before = baseManifest();
    const snapshot = JSON.stringify(before);
    fold(before, [setWorkspace({ navigation: { placement: "top" } })]);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  test("同じ差分に2本あれば後の1本が勝つ(先頭から順に畳む)", () => {
    const next = fold(baseManifest(), [
      setWorkspace({ navigation: { placement: "top" } }),
      setWorkspace({ navigation: { placement: "side" } }),
    ]);
    expect(workspaceOf(next)).toEqual({ navigation: { placement: "side" } });
  });
});

// =====================================================================================
// 5. 適用・`set_roles` との食い違い・元に戻す・移行・要件定義書
// =====================================================================================

describe("(5) 適用・元に戻す・移行・要件定義書", () => {
  let dataRoot: string;

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "gp-workspace-nav-"));
    const store = KernelMetaStore.open(dataRoot);
    createApp(store, "店", { app_id: "shop" });
    const applied = applyManifest(dataRoot, "shop", baseManifest());
    if (!applied.valid) {
      throw new Error(`テスト前提の初期マニフェスト投入に失敗しました: ${JSON.stringify(applied)}`);
    }
  });

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  test("適用すると定義に入り、移行の段を1つも生まない", () => {
    const result = applyDiff(
      dataRoot,
      "shop",
      diffOf([
        setWorkspace({
          navigation: { placement: "top", by_role: [{ role: "staff", placement: "side" }] },
        }),
      ]),
    );
    expect(errorsOf(result)).toEqual([]);
    if (!result.valid) {
      return;
    }
    expect(workspaceOf(result.manifest)).toEqual({
      navigation: { placement: "top", by_role: [{ role: "staff", placement: "side" }] },
    });
    expect(result.plan.add_tables).toEqual([]);
    expect(result.plan.add_fields).toEqual([]);
    expect(result.plan.steps ?? []).toEqual([]);
  });

  test("移行の計画は `set_workspace` に段を1つも生まない(直接)", () => {
    const operations = [
      setWorkspace({ navigation: { placement: "top" } }),
    ] as unknown as Operation[];
    const planned = planMigration(baseManifest(), fold(baseManifest(), operations), operations);
    expect(planned.valid).toBe(true);
    if (planned.valid) {
      expect(planned.plan.add_tables).toEqual([]);
      expect(planned.plan.add_fields).toEqual([]);
      expect(planned.plan.steps ?? []).toEqual([]);
    }
  });

  test("undo で宣言前の定義に戻る", () => {
    const before = JSON.stringify(readCurrentManifest(dataRoot, "shop"));
    const result = applyDiff(
      dataRoot,
      "shop",
      diffOf([setWorkspace({ navigation: { placement: "top" } })]),
    );
    expect(result.valid).toBe(true);
    expect(workspaceOf(readCurrentManifest(dataRoot, "shop"))).toEqual({
      navigation: { placement: "top" },
    });
    expect(undo(dataRoot, "shop").valid).toBe(true);
    const after = readCurrentManifest(dataRoot, "shop");
    expect(Object.keys(after.app)).not.toContain("workspace");
    expect(JSON.stringify(after)).toBe(before);
  });

  // **【`V22-M3-T02` / `ADR-0488` §Decision 1・2(授権 `ADR-0489` 行4)】`{}` の適用は断られ、宣言を消すのは `null` である。**
  // **旧の題名(逐語)**: 「`{}` を適用すると宣言が消え、定義は宣言前と同じになる」
  // **旧の期待(逐語)**: `expect(applyDiff(dataRoot, "shop", diffOf([setWorkspace({})], "ws-2")).valid).toBe(true);`
  test("`{}` の適用は断られ、`null` を適用すると宣言が消え、定義は宣言前と同じになる", () => {
    const before = JSON.stringify(readCurrentManifest(dataRoot, "shop"));
    expect(
      applyDiff(dataRoot, "shop", diffOf([setWorkspace({ navigation: { placement: "top" } })]))
        .valid,
    ).toBe(true);
    const declared = JSON.stringify(readCurrentManifest(dataRoot, "shop"));
    expect(applyDiff(dataRoot, "shop", diffOf([setWorkspace({})], "ws-2")).valid).toBe(false);
    expect(JSON.stringify(readCurrentManifest(dataRoot, "shop"))).toBe(declared);
    expect(
      applyDiff(dataRoot, "shop", diffOf([setWorkspace({ navigation: null })], "ws-3")).valid,
    ).toBe(true);
    expect(JSON.stringify(readCurrentManifest(dataRoot, "shop"))).toBe(before);
  });

  test("`set_roles` で上書きが指す役割を消す差分は、差分全体を断り、同じ差分で `set_workspace` を直すよう案内する", () => {
    expect(
      applyDiff(
        dataRoot,
        "shop",
        diffOf([setWorkspace({ navigation: { by_role: [{ role: "staff", placement: "top" }] } })]),
      ).valid,
    ).toBe(true);
    const snapshot = JSON.stringify(readCurrentManifest(dataRoot, "shop"));

    // `staff` を消し、`member` を足す(役割の ID を変えるのと同じ形)。
    const result = applyDiff(
      dataRoot,
      "shop",
      diffOf([{ op: "set_roles", roles: roles(["member", "clerk"]) }], "roles-2"),
    );
    expect(result.valid).toBe(false);
    const errors = errorsOf(result);
    const error = errors.find((e) => e.path === "/app/workspace/navigation/by_role/0/role");
    expect(error).toBeDefined();
    expect(error?.message).toContain('"staff"');
    expect(`${error?.message ?? ""}${error?.hint ?? ""}`).toContain("set_workspace");
    expect(`${error?.message ?? ""}${error?.hint ?? ""}`).toContain("同じ差分");
    // 差分全体を断った(定義は1バイトも動いていない)。
    expect(JSON.stringify(readCurrentManifest(dataRoot, "shop"))).toBe(snapshot);

    // 案内どおり同じ差分で `set_workspace` も直すと通る。
    const fixed = applyDiff(
      dataRoot,
      "shop",
      diffOf(
        [
          { op: "set_roles", roles: roles(["member", "clerk"]) },
          setWorkspace({ navigation: { by_role: [{ role: "clerk", placement: "top" }] } }),
        ],
        "roles-3",
      ),
    );
    expect(errorsOf(fixed)).toEqual([]);
  });

  test("要件定義書は位置を1文も述べない(履歴節には op の名前だけが出る)", () => {
    const result = applyDiff(
      dataRoot,
      "shop",
      diffOf([setWorkspace({ navigation: { placement: "top" } })]),
    );
    expect(result.valid).toBe(true);
    const doc = generateRequirementsDoc(dataRoot, "shop");
    expect(doc.markdown).toContain("set_workspace");
    expect(doc.markdown).not.toContain("by_role");
  });

  // 【`V22-M2-T09a`(独立点検の指摘 [軽-4])】要件定義書に、アプリの既定の位置を1文だけ述べる。
  // 上の題名「位置を1文も述べない」は `T01` の時点の逐語のまま残す(今日は既定の位置を1文述べる。
  // 上の検査の期待(`set_workspace` が出る / `by_role` の綴りが出ない)は今日も真)。
  const NAVIGATION_TEMPLATE = "screens.navigation_placement";

  test("要件定義書: 既定の位置を宣言すると、画面の節に1文だけ出る(位置は逐語、上書きは件数だけ)", () => {
    const result = applyDiff(
      dataRoot,
      "shop",
      diffOf([
        setWorkspace({
          navigation: { placement: "top", by_role: [{ role: "staff", placement: "side" }] },
        }),
      ]),
    );
    expect(errorsOf(result)).toEqual([]);
    const doc = generateRequirementsDoc(dataRoot, "shop");
    const own = doc.statements.filter((s) => s.template === NAVIGATION_TEMPLATE);
    expect(own.map((s) => s.text)).toEqual([
      "このアプリは、画面の一覧(メニュー)を並べる位置のアプリの既定を次のとおり宣言している(side は左、top は上)。役割ごとの上書きは `1` 件である:\n> top",
    ]);
    expect(own.map((s) => s.section)).toEqual(["screens"]);
    expect(own.map((s) => JSON.stringify(s.sources))).toEqual([
      JSON.stringify([{ kind: "manifest", pointer: "/app/workspace/navigation" }]),
    ]);
    // **上書きの役割の id は1つも出さない**(件数だけ。`ADR-0475` の「役割について出す種類を足さない」)。
    expect(own.map((s) => s.text.includes("staff"))).toEqual([false]);
  });

  test("要件定義書: 宣言が無ければ、その文は1つも出ない", () => {
    const doc = generateRequirementsDoc(dataRoot, "shop");
    expect(doc.statements.filter((s) => s.template === NAVIGATION_TEMPLATE)).toEqual([]);
    expect(doc.markdown.includes("メニュー")).toBe(false);
  });

  test("要件定義書: 役割の上書きだけの宣言では、その文は1つも出ない(`GET /public` と同じく既定を書いた宣言だけ)", () => {
    const result = applyDiff(
      dataRoot,
      "shop",
      diffOf([setWorkspace({ navigation: { by_role: [{ role: "staff", placement: "top" }] } })]),
    );
    expect(errorsOf(result)).toEqual([]);
    const doc = generateRequirementsDoc(dataRoot, "shop");
    expect(doc.statements.filter((s) => s.template === NAVIGATION_TEMPLATE)).toEqual([]);
  });
});
