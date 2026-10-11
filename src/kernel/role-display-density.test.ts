/**
 * **役割ごとの詰め具合を役割の宣言に書く器**(`V20-M11-T01` / `T02`。
 * [`ADR-0464`](../../docs/adr/0464-role-display-axis-declaration.md)。ユーザ決定 `D-V20-34` / `D-V20-35`)。
 *
 * ## この検査が測るもの(**先に書く**)
 *
 * 1. **`$defs/app/properties/roles/items/properties` が `id` / `name` / `rules` / `signup` /
 *    `density` の5キーで閉じること**(宣言順。`ADR-0464` 限定1。**着手前は4キーであった**)。
 * 2. **`density` の値域が `["comfortable", "compact"]` の2値ちょうどで、キーの直下に在ること**
 *    (`$ref` にしない。同 限定2)—— **値域の外(`spacious` など)を書いた差分が拒否されること。**
 * 3. **`required` に入らず、`default` も持たないこと** —— **`density` を書かない既存の定義が
 *    今日どおり valid であること。**
 * 4. **未ログイン(`anonymous`)には `density` を書けないこと**(`allOf` の分岐で `false` に閉じる)。
 *    **理由**: 未ログインの画面に渡る定義には役割の一覧が入らず、書いても効かない。
 * 5. **色の値域を1つも持たないこと**(同 限定3)。
 * 6. **旧の `$comment`(4キーで閉じる)を1バイトも消さず、隣に「6キー目を足さない」を置き直したこと。**
 *
 * ## この検査が測らないもの(**誇張しない**)
 *
 * 1. **画面の描き方は1バイトもここに無い。** **判定は `web/src/ui/family.ts` の `resolveUiFamily`
 *    1箇所に在り、その検査は `web/test/role-density.test.tsx` に在る。**
 * 2. **色が変わらないことの計算値の実測はここに無い**(chromium の担当)。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import manifestSchema from "../../schemas/manifest.schema.json" with { type: "json" };
import { applyDiff } from "./apply-diff.ts";
import { applyManifest, readCurrentManifest } from "./apply-manifest.ts";
import { createApp } from "./create-app.ts";
import { KernelMetaStore } from "./meta-store.ts";
import type { Diff, Manifest, RoleDeclaration } from "./types.ts";

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
  dataRoot = await mkdtemp(join(tmpdir(), "gp-role-density-"));
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

/** `owner` の定義変更・役割配布の2本(適用時検査が要求する)。 */
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

function applyRoles(roles: Any[], diffId = "d1"): ReturnType<typeof applyDiff> {
  return applyDiff(dataRoot, APP_ID, {
    diff_id: diffId,
    intent: "役割ごとの詰め具合を宣言する",
    operations: [{ op: "set_roles", roles: withDefaults(roles) }],
  } as unknown as Diff);
}

function currentRoles(): Any[] {
  const manifest = readCurrentManifest(dataRoot, APP_ID);
  return ((manifest.app as unknown as Any).roles ?? []) as Any[];
}

function roleItemSchema(): Any {
  const defs = (manifestSchema as unknown as { $defs: Record<string, Any> }).$defs;
  const roles = ((defs.app?.properties as Any)?.roles ?? {}) as Any;
  return (roles.items ?? {}) as Any;
}

function densitySchema(): Any {
  return ((roleItemSchema().properties as Any).density ?? {}) as Any;
}

function signupSchema(): Any {
  return ((roleItemSchema().properties as Any).signup ?? {}) as Any;
}

describe("(D-1) 役割の要素は5キーで閉じ、5キー目は density である", () => {
  test("要素のキーは5つで、`additionalProperties` は false のまま、`required` は動かない", () => {
    expect(Object.keys(roleItemSchema().properties as Any)).toEqual([
      "id",
      "name",
      "rules",
      "signup",
      "density",
    ]);
    expect(roleItemSchema().additionalProperties).toBe(false);
    expect(roleItemSchema().required).toEqual(["id"]);
  });

  test("`density` の値域はキーの直下の enum 2値ちょうどで、`$ref` にも既定値にもしない", () => {
    const density = densitySchema();
    expect(density.enum).toEqual(["comfortable", "compact"]);
    expect(density.type).toBe("string");
    expect(density).not.toHaveProperty("$ref");
    expect(density).not.toHaveProperty("default");
    expect(typeof density.description).toBe("string");
    // **説明は日本語で書き、画面の宣言が勝つことを述べる**(`D-V20-34`)。
    expect(density.description as string).toContain("preset_density");
  });

  test("色の値域を1つも持たない(16進の綴りが役割の要素に0件)", () => {
    expect(JSON.stringify(roleItemSchema()).split("0-9a-fA-F").length - 1).toBe(0);
  });

  test("旧の `$comment`(4キーで閉じる)は1バイトも消えず、隣に6キー目を止める文が置き直されている", () => {
    const signupComment = signupSchema().$comment as string;
    expect(signupComment).toContain(
      "id / name / rules / signup の4キーで閉じる。5キー目を足してはならない",
    );
    const densityComment = densitySchema().$comment as string;
    expect(densityComment).toContain("5キー目 density(ADR-0464)。6キー目を足さない");
  });
});

describe("(D-2) 値域と省略", () => {
  test('`density: "compact"` を書いた差分は valid で、マニフェストから読み出せる', () => {
    const result = applyRoles([{ id: "member", name: "会員", density: "compact" }]);
    expect(result.valid).toBe(true);
    const member = currentRoles().find((role) => role.id === "member") as RoleDeclaration;
    expect(member.density).toBe("compact");
  });

  test("値域の外(`spacious`)を書いた差分は拒否される", () => {
    expect(applyRoles([{ id: "member", density: "spacious" }]).valid).toBe(false);
  });

  test("長さのリテラル(`4px`)も真偽値も拒否される(自由記述を1バイトも受けない)", () => {
    expect(applyRoles([{ id: "member", density: "4px" }]).valid).toBe(false);
    expect(applyRoles([{ id: "member", density: true }], "d2").valid).toBe(false);
  });

  test("`density` を省略した既存の定義は今日どおり valid で、キーは生えない", () => {
    expect(applyRoles([{ id: "member", name: "会員" }]).valid).toBe(true);
    const member = currentRoles().find((role) => role.id === "member");
    expect(member).not.toHaveProperty("density");
  });

  test("6キー目(`display`)は今日どおり拒否される", () => {
    expect(applyRoles([{ id: "member", display: "compact" }]).valid).toBe(false);
  });
});

describe("(D-3) 未ログイン(`anonymous`)には `density` を書けない", () => {
  test("`anonymous` に `density` を書くと apply が拒否される", () => {
    expect(applyRoles([{ id: "anonymous", density: "compact" }]).valid).toBe(false);
  });

  test("`anonymous` 以外(予約の `editor`)には書ける", () => {
    expect(applyRoles([{ id: "editor", density: "compact" }]).valid).toBe(true);
  });
});
