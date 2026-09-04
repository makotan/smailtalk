/**
 * **登録の可否をアプリの定義に書く器**(`V8-M1-T02` / `V8-M1-T03`。台帳 `I-G1` / `I-G2` /
 * `I-G4` / `I-G6`。[`ADR-0334`](../../docs/adr/0334-role-signup-mode-declaration.md))。
 *
 * ## この検査が測るもの(**先に書く**)
 *
 * 1. **`$defs/app/properties/roles/items/properties` が `id` / `name` / `signup` / `rules` の
 *    4キーで閉じること**(`ADR-0334` 限定1。**着手前は3キーであった**)。
 * 2. **`signup` の値域が `["open", "invite"]` の2値ちょうどであること**(同 限定2)——
 *    **3値目(`"closed"` など)を書いた差分が拒否されること。**
 * 3. **`required` に入らず、`default` も持たないこと**(同 限定3)——
 *    **`signup` を1つも書かない既存の定義が今日どおり valid であること。**
 * 4. **`anonymous` には `signup` を書けないこと**(同 限定4。`allOf` の分岐で `false` に閉じる)。
 * 5. **書く手段は `set_roles` の全体差し替え1本であること**(同 限定5)——
 *    **`schemas/diff.schema.json` の差分は0行である**(`$ref` 1本なので自動的に受け取る)。
 * 6. **`signup` を書かない `roles` を送れば消えること**(同 限定6 = `I-G4` の「元に戻せる」)、
 *    **`undo` で前の宣言に1手戻ること。**
 * 7. **`src/kernel/` に登録の可否の判定が1バイトも無いこと**(同 限定7)。
 * 8. **他の器が1つも動いていないこと**(同 限定11)。
 *
 * ## この検査が測らないもの(**誇張しない**)
 *
 * 1. **登録の可否の判定は1バイトもここに無い。** **判定はサーバ層が持つ**
 *    ([`ADR-0335`](../../docs/adr/0335-signup-single-predicate-and-env-precedence.md))——
 *    **その検査は `src/server/signup-mode-enforcement.test.ts` にある。**
 * 2. **HTTP を1本も叩いていない。サーバを1本も起こしていない。**
 * 3. **`scripts/vocabulary-snapshot.txt` を1バイトも触っていない**(更新は `V8-M1-T07`)——
 *    **したがって `scripts/vocabulary-drift.test.ts` は赤いままで正しい**(`ADR-0301` 限定11)。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import diffSchema from "../../schemas/diff.schema.json" with { type: "json" };
import manifestSchema from "../../schemas/manifest.schema.json" with { type: "json" };
import { applyDiff } from "./apply-diff.ts";
import { applyManifest, readCurrentManifest } from "./apply-manifest.ts";
import { createApp } from "./create-app.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { DIFF_OPS, type Diff, type Manifest, type RoleDeclaration } from "./types.ts";
import { undo } from "./undo.ts";

type Any = Record<string, unknown>;

const APP_ID = "shop";

let dataRoot: string;
let store: KernelMetaStore;

function baseManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
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
  } as unknown as Manifest;
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-role-signup-"));
  store = KernelMetaStore.open(dataRoot);
  createApp(store, "店", { app_id: APP_ID });
  const applied = applyManifest(dataRoot, APP_ID, baseManifest());
  if (!applied.valid) {
    throw new Error(
      `テスト前提の初期マニフェスト投入に失敗しました: ${JSON.stringify(applied.errors)}`,
    );
  }
});

afterEach(async () => {
  store.close();
  await rm(dataRoot, { recursive: true, force: true });
});

/** `owner` の定義変更・役割配布の2本(適用時検査が要求する。`V8-M28` / `T-G16a`)。 */
const OWNER_DEFINITION_RULES: Any[] = [
  { target: "app", can: ["write"] },
  { target: "role", can: ["write"] },
];

/** 既定3本を先頭に足す(既に書かれている `id` は二重に足さない)。 */
function withDefaults(roles: Any[]): Any[] {
  const declared = new Set(roles.map((role) => role.id as string));
  return [
    ...["owner", "editor", "viewer"]
      .filter((id) => !declared.has(id))
      .map((id) =>
        id === "owner" ? { id, rules: structuredClone(OWNER_DEFINITION_RULES) } : { id },
      ),
    ...roles,
  ];
}

function setRolesDiff(roles: unknown, diffId = "d1"): Diff {
  return {
    diff_id: diffId,
    intent: "登録モードを宣言する",
    operations: [{ op: "set_roles", roles }],
  } as unknown as Diff;
}

function applyRoles(roles: Any[], diffId = "d1"): ReturnType<typeof applyDiff> {
  return applyDiff(dataRoot, APP_ID, setRolesDiff(withDefaults(roles), diffId));
}

function currentRoles(): Any[] {
  const manifest = readCurrentManifest(dataRoot, APP_ID);
  return ((manifest.app as unknown as Any).roles ?? []) as Any[];
}

function manifestDefs(): Record<string, Any> {
  return (manifestSchema as unknown as { $defs: Record<string, Any> }).$defs;
}

function rolesSchema(): Any {
  return ((manifestDefs().app?.properties as Any)?.roles ?? {}) as Any;
}

function roleItemSchema(): Any {
  return (rolesSchema().items ?? {}) as Any;
}

function signupSchema(): Any {
  return ((roleItemSchema().properties as Any).signup ?? {}) as Any;
}

// ===========================================================================
// (S-1) 器 —— `roles[]` の4キー目(`ADR-0334` 限定1 / 限定2 / 限定3)
// ===========================================================================

describe("(S-1) `roles[]` の要素は `id` / `name` / `rules` / `signup` の4キーで閉じる", () => {
  test("要素のキーは4つで、`additionalProperties` は false のままである", () => {
    expect(Object.keys(roleItemSchema().properties as Any).sort()).toEqual([
      "id",
      "name",
      "rules",
      "signup",
    ]);
    expect(roleItemSchema().additionalProperties).toBe(false);
    // **`required` は着手前と1バイトも変わらない**(限定3。`signup` は入らない)。
    expect(roleItemSchema().required).toEqual(["id"]);
  });

  test('`signup` の値域は `["open", "invite"]` の2値ちょうどである', () => {
    expect(signupSchema().enum).toEqual(["open", "invite"]);
    // **真偽値にしない**(限定2)/ **既定値をスキーマに書かない**(限定3。読み手を2つにしない)。
    expect(signupSchema().type).toBe("string");
    expect(signupSchema()).not.toHaveProperty("default");
  });

  test("旧の禁止文(`4キー目を足してはならない`)は `$comment` に1バイトも消さずに残る", () => {
    const comment = rolesSchema().$comment as string;
    expect(comment).toContain(
      "要素は id / name / rules の3キーで閉じる。4キー目を足してはならない",
    );
  });

  test("置き換えとなる新しい不変条件が、隣に新設した `$comment` に置き直されている", () => {
    // **`ADR-0013` §4c 問3 の義務**(`V8-M29` が 10→9 のときに置き直さなかった穴を繰り返さない)。
    // **旧の `$comment` は1バイトも書き換えていない**ので、置き直しは
    // **`signup` 自身の `$comment`**(= 破った明文の隣)に置く。
    const comment = signupSchema().$comment as string;
    expect(comment).toContain(
      "id / name / rules / signup の4キーで閉じる。5キー目を足してはならない",
    );
    // **破った明文を名指ししている**(隠さない)。
    expect(comment).toContain("ADR-0322 限定4");
  });
});

// ===========================================================================
// (S-2) 値域 —— 3値目は拒否 / 省略は今日どおり / `invite` は通る
// ===========================================================================

describe("(S-2) `signup` の値域", () => {
  test("3値目(`closed`)を書いた差分は拒否される", () => {
    const result = applyRoles([{ id: "member", name: "会員", signup: "closed" }]);
    expect(result.valid).toBe(false);
  });

  test("`signup` を省略した既存の定義は今日どおり valid である", () => {
    const result = applyRoles([{ id: "member", name: "会員" }]);
    expect(result.valid).toBe(true);
    const member = currentRoles().find((role) => role.id === "member");
    expect(member).toBeDefined();
    expect(member).not.toHaveProperty("signup");
  });

  test('`signup: "invite"` を書いた差分は valid で、マニフェストから読み出せる', () => {
    const result = applyRoles([{ id: "member", name: "会員", signup: "invite" }]);
    expect(result.valid).toBe(true);
    expect(currentRoles().find((role) => role.id === "member")?.signup).toBe("invite");
  });

  test('`signup: "open"` も書ける', () => {
    expect(applyRoles([{ id: "member", name: "会員", signup: "open" }]).valid).toBe(true);
    expect(currentRoles().find((role) => role.id === "member")?.signup).toBe("open");
  });

  test("予約3語(`owner` / `editor` / `viewer`)にも書ける(パターン2 の表現に要る)", () => {
    const result = applyDiff(
      dataRoot,
      APP_ID,
      setRolesDiff([
        { id: "owner", signup: "invite", rules: structuredClone(OWNER_DEFINITION_RULES) },
        { id: "editor", signup: "invite" },
        { id: "viewer", signup: "invite" },
      ]),
    );
    expect(result.valid).toBe(true);
    expect(currentRoles().map((role) => role.signup)).toEqual(["invite", "invite", "invite"]);
  });
});

// ===========================================================================
// (S-3) `anonymous` には書けない(`ADR-0334` 限定4。`ADR-0086` 限定4 の作法)
// ===========================================================================

describe("(S-3) `anonymous` に `signup` を書いた差分は拒否される", () => {
  test("スキーマの `allOf` 分岐が `signup` を `false` で閉じている", () => {
    const branches = (roleItemSchema().allOf ?? []) as Any[];
    const closed = branches.some(
      (branch) => (((branch.then as Any)?.properties ?? {}) as Any).signup === false,
    );
    expect(closed).toBe(true);
  });

  test("`anonymous` に `signup` を書くと apply が拒否される", () => {
    const result = applyRoles([{ id: "anonymous", signup: "invite" }]);
    expect(result.valid).toBe(false);
  });

  test("`anonymous` を `signup` 無しで書くのは今日どおり通る", () => {
    expect(applyRoles([{ id: "anonymous" }]).valid).toBe(true);
  });
});

// ===========================================================================
// (S-4) 書く手段は `set_roles` 1本(`ADR-0334` 限定5)/ 消せる・戻せる(限定6 = `I-G4`)
// ===========================================================================

describe("(S-4) `set_roles` の全体差し替えだけで書き、消し、戻せる", () => {
  test("差分操作は17種のままで、18種目を足していない", () => {
    expect(DIFF_OPS).toHaveLength(17);
    const ops = ((diffSchema as unknown as { $defs: Record<string, Any> }).$defs.operation as Any)
      .properties as Any;
    expect(Object.keys(ops)).toHaveLength(9);
  });

  test("`signup` を書かない `roles` を送ると `signup` は消える", () => {
    expect(applyRoles([{ id: "member", name: "会員", signup: "invite" }], "d1").valid).toBe(true);
    expect(currentRoles().find((role) => role.id === "member")?.signup).toBe("invite");

    expect(applyRoles([{ id: "member", name: "会員" }], "d2").valid).toBe(true);
    expect(currentRoles().find((role) => role.id === "member")).not.toHaveProperty("signup");
  });

  test('`undo` で前の宣言(`signup: "invite"`)に1手戻る', () => {
    expect(applyRoles([{ id: "member", name: "会員", signup: "invite" }], "d1").valid).toBe(true);
    expect(applyRoles([{ id: "member", name: "会員" }], "d2").valid).toBe(true);
    expect(currentRoles().find((role) => role.id === "member")).not.toHaveProperty("signup");

    const undone = undo(dataRoot, APP_ID);
    expect(undone.valid).toBe(true);
    expect(currentRoles().find((role) => role.id === "member")?.signup).toBe("invite");
  });
});

// ===========================================================================
// (S-5) カーネルは判定を1バイトも持たない(`ADR-0334` 限定7 / 限定10)
// ===========================================================================

describe("(S-5) `src/kernel/` に登録の可否の判定は1バイトも無い", () => {
  test("`apply-manifest.ts` は `signup` を1度も綴らない(自動付与を作らない)", () => {
    const source = readFileSync(join(import.meta.dir, "apply-manifest.ts"), "utf8");
    expect(source.includes("signup")).toBe(false);
  });

  test("`apply-diff.ts` は `signup` の値を1つも検査しない", () => {
    const source = readFileSync(join(import.meta.dir, "apply-diff.ts"), "utf8");
    expect(source.includes('"invite"')).toBe(false);
    expect(source.includes('"open"')).toBe(false);
  });

  test("`createApp` が生む新しいアプリの `roles[]` に `signup` は0件である", () => {
    createApp(store, "別の店", { app_id: "another" });
    const roles = ((readCurrentManifest(dataRoot, "another").app as unknown as Any).roles ??
      []) as Any[];
    expect(roles.length).toBeGreaterThan(0);
    expect(roles.filter((role) => "signup" in role)).toHaveLength(0);
  });
});

// ===========================================================================
// (S-7) 型は増えるが、公開エクスポートは1つも増えない(`ADR-0334` 限定7。`Δ8` 非発火)
// ===========================================================================

describe("(S-7) `RoleDeclaration` の4キー目", () => {
  test('型に `signup` があり、`"open"` / `"invite"` を代入できる(コンパイル時の担保)', () => {
    // **この2行は `bun run typecheck` で赤くなる形の担保である**
    // (`bun test` は型を1つも見ないので、実行時の `expect` は形の確認にとどまる)。
    const open: RoleDeclaration = { id: "member", signup: "open" };
    const invite: RoleDeclaration = { id: "member", signup: "invite" };
    expect(open.signup).toBe("open");
    expect(invite.signup).toBe("invite");
    // **省略できる**(限定3)。
    const omitted: RoleDeclaration = { id: "member" };
    expect(omitted.signup).toBeUndefined();
  });

  test("名前付きの型を新しく `export` していない(`Δ8` を発火させない)", () => {
    const source = readFileSync(join(import.meta.dir, "types.ts"), "utf8");
    // **インラインの union で書く** —— **`SignupMode` のような名前を1つも作らない。**
    expect(source).toContain('signup?: "open" | "invite"');
    expect(source.includes("export type SignupMode")).toBe(false);
    const snapshot = readFileSync(
      join(import.meta.dir, "..", "..", "scripts", "kernel-export-snapshot.txt"),
      "utf8",
    );
    expect(snapshot.includes("Signup")).toBe(false);
  });

  test("`foldSetRoles` は `signup` をそのまま運ぶ(全置換1行。検査を1本も足さない)", () => {
    const applied = applyRoles([{ id: "member", name: "会員", signup: "invite" }]);
    expect(applied.valid).toBe(true);
    const roles = (applied.valid ? (applied.manifest.app as unknown as Any).roles : []) as Any[];
    expect(roles.find((role) => role.id === "member")?.signup).toBe("invite");
  });
});

// ===========================================================================
// (S-6) 他の器は1つも動いていない(`ADR-0334` 限定11)
// ===========================================================================

describe("(S-6) 他の器は1つも動いていない", () => {
  test("`$defs` は 29 / `$defs/app` は 8 / `$defs/table` は 6 のままである", () => {
    // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】期待値を 29 → 30 へ書き換えた。**
    // **旧行の逐語**: `expect(Object.keys(manifestDefs())).toHaveLength(29);`
    // **書き換えた理由**: この行が固定していたのは「**その決定**が新しい `$defs` を作らなかったこと」
    // であり、**30本目を作ったのは別の決定である**(`V8-M8` が集計表の中身 `$defs/report` を新設した)。
    // **検査は消していない。**
    expect(Object.keys(manifestDefs())).toHaveLength(30);
    expect(Object.keys((manifestDefs().app as Any).properties as Any)).toHaveLength(8);
    expect(Object.keys((manifestDefs().table as Any).properties as Any)).toHaveLength(6);
  });

  test("`roles` の `minItems` / `maxItems` と `rules.items.properties` は1つも動いていない", () => {
    expect(rolesSchema().minItems).toBe(1);
    expect(rolesSchema().maxItems).toBe(12);
    const rules = (roleItemSchema().properties as Any).rules as Any;
    expect(Object.keys((rules.items as Any).properties as Any)).toHaveLength(7);
  });
});
