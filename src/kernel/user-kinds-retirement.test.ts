/**
 * **立場の一覧(`app.user_kinds`)と、それを書き込む差分操作(`set_user_kinds`)の廃止**
 * (`V8-M29` 第2波。台帳 `T-G9a` / `T-G11` / `T-G12` / `T-G13`。
 * 判定値 = **廃止**(`ADR-0301` が `ADR-0007` §3c に足した6つ目))。
 *
 * **このリポジトリで語彙が減るのは2度目である。**
 * **1度目は `ADR-0310`(宣言4層の撤去)** —— 本ファイルはその作法(撤去した綴りが
 * 「無い」ことを、綴りの検査と実物の応答の両方で固定する)をそのまま踏む。
 *
 * ## この検査が測るもの
 *
 * 1. **`user_kinds` を書いたマニフェストが、今日から拒否されること**
 *    (`$defs/app` の `additionalProperties: false` による。**エラーの `path` も見る**)。
 * 2. **`set_user_kinds` の差分が、今日から拒否されること**(`op` の値域から消えた)。
 * 3. **器の本数** —— `$defs/app.properties` **9 → 8** / `$defs/operation.properties`
 *    **10 → 9** / `DIFF_OPS` **18 → 17** / `$defs` **29 のまま** / `$defs/table.properties`
 *    **6 のまま**。
 * 4. **代わりが立っていること**(第1波が立てた4点が今日も緑であること)。
 *    **本体の実測は `src/server/role-value-domain.test.ts`(実 HTTP)であり、
 *    ここでは値域を組む関数の側だけを測る**(二重に測るのではなく、撤去で
 *    引数が1本減ったあとも同じ答えを返すことを固定する)。
 * 5. **予約4語の締め出しが、行ごとのアクセス権の側には残っていること**
 *    (`$defs/table/.../permissions/items/properties/id` の `not.enum`。**1バイトも触っていない**)。
 * 6. **要件ドキュメントの生成器に、撤去した語彙についての文が1つも残らないこと**
 *    (`V8-M22` / `J-G34b` が置いた番人 `B1`〜`B4` と同じ形を、本廃止についても置く)。
 *
 * ## この検査が測らないもの(**先に書く。丸めない**)
 *
 * - **`user_kinds` を書いて保存されている既存アプリが、今日から読めなくなること**の
 *   救済は1バイトも測っていない。**救済そのものが実装に無い**
 *   (`ADR-0301` 限定6 の ④ = 担い手が無い。本ファイル末尾の describe が名指しで固定する)。
 * - **`docs/` に残る綴り**は1件も見ていない(本文不改変の作法により残る)。
 * - **ブラウザで画面を1枚も開いていない。**
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import diffSchema from "../../schemas/diff.schema.json" with { type: "json" };
import manifestSchema from "../../schemas/manifest.schema.json" with { type: "json" };
import { applyDiff } from "./apply-diff.ts";
import { applyManifest } from "./apply-manifest.ts";
import { createApp } from "./create-app.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { REQUIREMENT_TEMPLATES } from "./requirements-doc.ts";
import { DIFF_OPS, type Diff, type Manifest } from "./types.ts";

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
  };
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-user-kinds-retire-"));
  store = KernelMetaStore.open(dataRoot);
  createApp(store, "店", { app_id: APP_ID });
  const applied = applyManifest(dataRoot, APP_ID, baseManifest());
  if (!applied.valid) {
    throw new Error("テスト前提の初期マニフェスト投入に失敗しました。");
  }
});

afterEach(async () => {
  store.close();
  await rm(dataRoot, { recursive: true, force: true });
});

function manifestDefs(): Any {
  return (manifestSchema as unknown as { $defs: Record<string, Any> }).$defs;
}

function diffDefs(): Any {
  return (diffSchema as unknown as { $defs: Record<string, Any> }).$defs;
}

// ---------------------------------------------------------------------------
// (1) `user_kinds` を書いたマニフェストが拒否される
// ---------------------------------------------------------------------------

describe("(1) 立場の一覧を書いたマニフェストは、今日から拒否される", () => {
  test("`app.user_kinds` を書くと invalid になり、`path` は `/app/user_kinds` である", () => {
    const manifest = baseManifest() as unknown as Any;
    (manifest.app as Any).user_kinds = [{ id: "member", name: "会員" }];
    const result = applyManifest(dataRoot, APP_ID, manifest as unknown as Manifest);
    expect(result.valid).toBe(false);
    if (result.valid) {
      return;
    }
    // **止めているのは `$defs/app` の `additionalProperties: false` である** ——
    // **`user_kinds` という名前を名指しで拒む行は1つも書いていない**(器ごと消えたので、
    // 未知のキーとして落ちる)。**この形は `ADR-0310` が宣言4層で採ったものと同じである。**
    // **実測した逐語**(`path` は `/app` であって `/app/user_kinds` ではない ——
    // 未知プロパティのエラーは**親の位置**を指す):
    //
    //     { "path": "/app",
    //       "message": "未知のプロパティ \"user_kinds\" は指定できません。",
    //       "allowed_values": ["id","name","tables","views","workflows","functions","theme","roles"],
    //       "hint": "この位置で指定できるのは allowed_values のプロパティだけです。…" }
    const [error] = result.errors;
    expect(error?.path).toBe("/app");
    expect(error?.message).toBe('未知のプロパティ "user_kinds" は指定できません。');
    // **`allowed_values` は器そのものである** —— **8キーで、`user_kinds` は入っていない。**
    expect(error?.allowed_values).toEqual([
      "id",
      "name",
      "tables",
      "views",
      "workflows",
      "functions",
      "theme",
      "roles",
    ]);
  });

  test("`$defs/app` から `user_kinds` のキーが消えている(綴りで測る)", () => {
    const appProperties = (manifestDefs().app as Any).properties as Any;
    expect(Object.hasOwn(appProperties, "user_kinds")).toBe(false);
    // **`roles` は在る**(代わりに立つ側。`ADR-0301` 限定2 の「何が担うか」)。
    expect(Object.hasOwn(appProperties, "roles")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (2) `set_user_kinds` の差分が拒否される
// ---------------------------------------------------------------------------

describe("(2) 立場の一覧を書き換える差分操作は、今日から拒否される", () => {
  test("`set_user_kinds` を含む差分は invalid になる", () => {
    const diff = {
      diff_id: "d1",
      intent: "廃止された op を書く",
      operations: [{ op: "set_user_kinds", user_kinds: [{ id: "member", name: "会員" }] }],
    } as unknown as Diff;
    const result = applyDiff(dataRoot, APP_ID, diff);
    expect(result.valid).toBe(false);
    if (result.valid) {
      return;
    }
    expect(result.errors.map((error) => error.path)).toContain("/operations/0/op");
  });

  test("`op` の値域(`$defs/op_name.enum`)から `set_user_kinds` が消えている", () => {
    const opNames = (diffDefs().op_name as Any).enum as string[];
    expect(opNames).not.toContain("set_user_kinds");
    // **代わりに立つのは `set_roles` である**(同型の全体差し替え。台帳 `T-G11` の帰属先)。
    expect(opNames).toContain("set_roles");
  });

  test("`DIFF_OPS` と `op_name.enum` は今日も同順・同内容である(片側だけ減らしていない)", () => {
    expect((diffDefs().op_name as Any).enum as string[]).toEqual([...DIFF_OPS]);
  });
});

// ---------------------------------------------------------------------------
// (3) 器の本数
// ---------------------------------------------------------------------------

describe("(3) 器の本数(減った側と、動かなかった側を別々に固定する)", () => {
  test("`$defs/app.properties` は 9 → 8 である", () => {
    // **旧の期待値(逐語)**: `9`(`id` / `name` / `tables` / `views` / `workflows` /
    // `functions` / `theme` / `user_kinds` / `roles`)。
    const keys = Object.keys((manifestDefs().app as Any).properties as Any);
    expect(keys).toEqual([
      "id",
      "name",
      "tables",
      "views",
      "workflows",
      "functions",
      "theme",
      "roles",
    ]);
  });

  test("`$defs/operation.properties` は 10 → 9 である", () => {
    // **旧の期待値(逐語)**: `op` / `table` / `field` / `view` / `changes` / `workflow` /
    // `function` / `theme` / `user_kinds` / `roles` の10キー。
    const keys = Object.keys((diffDefs().operation as Any).properties as Any);
    expect(keys).toEqual([
      "op",
      "table",
      "field",
      "view",
      "changes",
      "workflow",
      "function",
      "theme",
      "roles",
    ]);
  });

  test("`DIFF_OPS` は 18 → 17 である", () => {
    expect(DIFF_OPS).toHaveLength(17);
    expect(DIFF_OPS as readonly string[]).not.toContain("set_user_kinds");
  });

  test("`$defs/operation.allOf` の分岐は 18 → 17 である", () => {
    expect((diffDefs().operation as Any).allOf as unknown[]).toHaveLength(17);
  });

  test("`$defs` は 29 のまま・`$defs/table.properties` は 6 のままである(減らしすぎの検出)", () => {
    // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】期待値を 29 → 30 へ書き換えた。**
    // **旧行の逐語**: `expect(Object.keys(manifestDefs())).toHaveLength(29);`
    // **書き換えた理由**: この行が固定していたのは「**その決定**が新しい `$defs` を作らなかったこと」
    // であり、**30本目を作ったのは別の決定である**(`V8-M8` が集計表の中身 `$defs/report` を新設した)。
    // **検査は消していない。**
    expect(Object.keys(manifestDefs())).toHaveLength(30);
    expect(Object.keys((manifestDefs().table as Any).properties as Any)).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// (5) 予約4語の締め出しは、行ごとのアクセス権の側に残る
// ---------------------------------------------------------------------------

describe("(5) 予約4語の締め出しは、行ごとのアクセス権の側に今日も在る", () => {
  test("`$defs/table/.../permissions/items/properties/id` の `not.enum` は1バイトも動いていない", () => {
    const permissionId = (
      (
        (
          (((manifestDefs().table as Any).properties as Any).access_control as Any)
            .properties as Any
        ).permissions as Any
      ).items as Any
    ).properties as Any;
    expect((permissionId.id as Any).not).toEqual({
      enum: ["owner", "editor", "viewer", "anonymous"],
    });
  });

  test("`app.roles[].id` には `not` が今日も1つも無い(本廃止は役割の側を1バイトも触っていない)", () => {
    const roleId = ((((manifestDefs().app as Any).properties as Any).roles as Any).items as Any)
      .properties as Any;
    expect(Object.hasOwn(roleId.id as Any, "not")).toBe(false);
  });

  test("マニフェスト全体で、予約4語を締め出す `not.enum` は 2箇所 → 1箇所である", () => {
    // **【`ADR-0301` 限定6 の ④(担い手が無い)を機械で固定する】**
    // **消えたのは「立場という器に予約4語を書けない」という禁止1件であり、
    // 器ごと消えたので担い手が無い。** **予約そのものは `RESERVED_ROLES`(3語)/
    // `DEFAULT_ROLE_IDS`(3語)/ `countOwners` の SQL の `'owner'` /
    // 下の `permissions` 側の `not.enum` に残る。**
    const hits: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (node === null || typeof node !== "object") {
        return;
      }
      if (Array.isArray(node)) {
        node.forEach((item, index) => {
          walk(item, `${path}/${index}`);
        });
        return;
      }
      const record = node as Any;
      const not = record.not as Any | undefined;
      if (
        not &&
        Array.isArray(not.enum) &&
        (not.enum as string[]).join(",") === "owner,editor,viewer,anonymous"
      ) {
        hits.push(path);
      }
      for (const [key, value] of Object.entries(record)) {
        walk(value, `${path}/${key}`);
      }
    };
    walk(manifestSchema, "");
    // **旧の実測(逐語)**: 2箇所
    // (`/$defs/app/properties/user_kinds/items/properties/id` と
    //  `/$defs/table/properties/access_control/properties/permissions/items/properties/id`)。
    expect(hits).toEqual([
      "/$defs/table/properties/access_control/properties/permissions/items/properties/id",
    ]);
  });
});

// ---------------------------------------------------------------------------
// (6) 要件ドキュメントの生成器に、撤去した語彙についての文が1つも残らない
// ---------------------------------------------------------------------------

describe("(6) 要件ドキュメントの生成器に、撤去した語彙についての文が1つも残らない", () => {
  test("テンプレートIDにも本文にも `user_kinds` / `set_user_kinds` / 「利用者の種類」が1件も無い", () => {
    // **`V8-M22` / `J-G34b` の番人 `B1` とまったく同じ形である**(綴りと日本語の両方を見る)。
    for (const [id, body] of Object.entries(REQUIREMENT_TEMPLATES)) {
      for (const retired of ["user_kinds", "利用者の種類"]) {
        expect(`${id}:${body}`).not.toContain(retired);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// **担い手が無いもの(`ADR-0301` 限定2 / 限定6 の ④)を、機械で名指しする**
// ---------------------------------------------------------------------------

describe("担い手が無いもの —— 撤去で消える機能を名指しで固定する", () => {
  test("立場の一覧を「無かったこと」にして書き直す差分操作は、今日1つも無い", () => {
    // **【消える機能。担い手 = ④(何も担わない)】**
    // **`user_kinds` を書いて保存されている既存アプリのマニフェストは、今日から
    // `applyManifest` が invalid にする**(上の (1))。
    // **移行(読み替え・書き換え・除去)の op は語彙に1つも無い** —— **`set_roles` は
    // `app.roles` を差し替えるだけで、`app.user_kinds` を1バイトも消さない。**
    // **`ADR-0248` 限定3 が「宣言を『無い状態』へ戻す手段は語彙に1つも無い」と
    // 書いていたことが、廃止の側でそのまま代償になった。**
    const migrationOps = (DIFF_OPS as readonly string[]).filter(
      (op) => op.includes("migrate") || op.includes("remove_app") || op.includes("patch_manifest"),
    );
    expect(migrationOps).toEqual([]);
  });
});
