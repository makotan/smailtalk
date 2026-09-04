/**
 * **利用者の種類の宣言を、差分操作から書けるようにする**(`V5-M17b`。ユーザ決定 `D-V5-87` /
 * [`ADR-0248`](../../docs/adr/0248-user-kinds-diff-op.md) = `DIFF_OPS` 16 → 17)。
 *
 * **審査記録 / 実施記録**: [`docs/plan/v5/records/v5-m17b.md`](../../docs/plan/v5/records/v5-m17b.md)。
 *
 * ## この検査が測るもの / 測らないもの(**先に書く**)
 *
 * **測るもの**:
 * 1. **17種目 `set_user_kinds` が語彙に在ること**(`DIFF_OPS` の本数と全要素名)。
 * 2. **`$defs/operation.properties` が9キーで閉じること**(`ADR-0248` 限定4)。
 * 3. **値域の定義が1箇所しか無いこと**(`ADR-0248` 限定6)—— 差分スキーマは
 *    `$defs/app/properties/user_kinds` を `$ref` で参照するだけで、値を1つも列挙しない。
 * 4. **拒否の形**(空配列 / 9種目 / 予約語 / 不正な識別子 / 他キーの同居)。
 * 5. **`undo` / `redo` / `dry_run_diff` / `_changelog` / 要件定義書が、この op をどう扱うか**
 *    (`docs/plan/v5/records/v5-m17b.md` §7 が実測として引く)。
 *
 * **測らないもの(誇張しない)**:
 * 1. **同じ `id` を2本書いた宣言は、今日も拒否できない。** `uniqueItems` はオブジェクト
 *    全体の同値でしか効かず、`id` が同じで `name` が違う2本は通る
 *    (`src/kernel/declared-user-kinds.test.ts` の冒頭が `V5-M17` の限界として名指ししている)。
 *    **本タスクはこの穴を1バイトも塞いでいない** —— 塞ぐことは `ADR-0248` の限定6
 *    (値域を1バイトも動かさない)の外である。
 * 2. **宣言を「無い状態」へ戻す手段は、今日も語彙に1つも無い**(`ADR-0248` 限定3)。
 *    `set_theme` がテーマの削除 op を持たないのと同じ形である。
 * 3. **ブラウザで画面を1枚も開いていない。**
 *
 * ---
 *
 * ## 【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a` / `T-G11` / `T-G12`。判定値 = 廃止】
 *
 * **上のドキュメントは1バイトも消していない。** **`ADR-0248` 制定時の事実であって、
 * 今日の正ではない。**
 *
 * ### このファイルが何を測っていたか(着手前)
 *
 * **差分操作 `set_user_kinds` が語彙に在り、それでマニフェストの `app.user_kinds` を
 * 丸ごと差し替えられること。** **25本の検査のうち、22本が「`set_user_kinds` が在る /
 * 効く / 値域どおりに拒否する」を主題にしていた。**
 *
 * ### 今日は何を測るか
 *
 * **同じ25本を「廃止されたことを固定する検査」に入れ替えた。** **1本も消していないし、
 * 1本も `skip` していない。**
 *
 * 1. **`DIFF_OPS` は 18 → 17 で、消えたのは `set_user_kinds` の1つだけである**
 *    (着手前の16 op と18種目 `set_roles` は1つも消えていない)。
 * 2. **`$defs/operation.properties` は 10 → 9 で、消えたのは `user_kinds` の1キーだけである。**
 * 3. **`set_user_kinds` の分岐も、17分岐に書いてあった `"user_kinds": false` も、
 *    マニフェスト側の値域(`$defs/app/properties/user_kinds`)も、今日は在らない。**
 * 4. **`set_user_kinds` を含む差分は `/operations/0/op` で拒否される**
 *    (適用 / ドライラン / 変更履歴 / 要件定義書のどこにも1バイトも残らない)。
 * 5. **代わりに立つのは `set_roles` である**(`ADR-0301` 限定2 の「取り除いたあとに
 *    何が担うか」)—— **どちらも「app に1つしか無い宣言を丸ごと差し替える」同型の op で、
 *    対象IDを取らない。**
 *
 * ### 担い手が無いもの(**このファイルで今日1バイトも測れなくなったもの。名指しで書く**)
 *
 * - **上限8種**(`ADR-0158` 限定3)…… **器ごと消えたので、8と9の境目を測る検査が
 *   今日1つも作れない。** **`app.roles` の上限は 12 であり、同じ境目ではない。**
 * - **予約4語(`owner` / `editor` / `viewer` / `anonymous`)の締め出し**(`ADR-0158` 限定1)
 *   …… **`user_kinds` の側の `not.enum` は消えた。** **`app.roles[].id` には `not` が
 *   1つも無い**(`V8-M16` が申告済みの穴)。**行ごとのアクセス権の側にだけ同じ
 *   `not.enum` が残っている**(`src/kernel/user-kinds-retirement.test.ts` の (5) が測る)。
 * - **識別子の形 `^[a-z0-9_]{1,32}$`**(`ADR-0158` 限定4)…… **`app.roles[].id` は同じ
 *   パターンを持つが、それは本ファイルの主題ではない**(`src/kernel/roles-diff-op.test.ts` が測る)。
 * - **`uniqueItems` が同じ `id` の2本を拒否できないという限界**(上の「測らないもの」1)
 *   …… **器ごと消えたので、今日1バイトも測れない。担い手は無い。**
 * - **`undo` / `redo` が宣言を戻すこと** …… **適用できない差分は履歴に1件も残らないので、
 *   戻す対象そのものが作れない。担い手は無い。**
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import diffSchema from "../../schemas/diff.schema.json" with { type: "json" };
import manifestSchema from "../../schemas/manifest.schema.json" with { type: "json" };
import { applyDiff } from "./apply-diff.ts";
import { applyManifest } from "./apply-manifest.ts";
import { createApp } from "./create-app.ts";
import { dryRunDiff } from "./dry-run.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { generateRequirementsDoc } from "./requirements-doc.ts";
import { DIFF_OPS, type Diff, type Manifest } from "./types.ts";
import { previewRedo, previewUndo, redo, undo } from "./undo.ts";

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
  dataRoot = await mkdtemp(join(tmpdir(), "gp-user-kinds-op-"));
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

const KINDS = [
  { id: "member", name: "会員" },
  { id: "supplier", name: "取引先" },
];

/**
 * **【`V8-M29` 第2波】この差分は今日、1度も適用できない。**
 * **ヘルパは1バイトも書き換えていない** —— **「同じものを送ると今日どうなるか」を
 * 測るための題材として、そのまま使い続ける。**
 */
function setKindsDiff(kinds: unknown, diffId = "d1"): Diff {
  return {
    diff_id: diffId,
    intent: "利用者の種類を宣言する",
    operations: [{ op: "set_user_kinds", user_kinds: kinds }],
  } as unknown as Diff;
}

function operationDefs(): Any {
  return ((diffSchema as unknown as { $defs: Record<string, Any> }).$defs.operation ?? {}) as Any;
}

/** `app.user_kinds` を書いたマニフェスト(**今日は `applyManifest` が拒否する**)。 */
function manifestWithKinds(kinds: unknown): Manifest {
  const m = baseManifest() as unknown as { app: Record<string, unknown> };
  m.app.user_kinds = kinds;
  return m as unknown as Manifest;
}

/** 差分の拒否が `op` の値域で起きたことを、`path` で固定する。 */
function opRejectionPath(kinds: unknown): string | undefined {
  const result = applyDiff(dataRoot, APP_ID, setKindsDiff(kinds));
  return result.valid === false ? result.errors[0]?.path : undefined;
}

// ---------------------------------------------------------------------------
// (T03-1) 語彙 —— 17種目が在る(`ADR-0248` 限定1 / 限定7)
// ---------------------------------------------------------------------------

describe("(T03-1) `DIFF_OPS` は 16 → 17 になり、増えたのは `set_user_kinds` の1つだけである", () => {
  // **【`V8-M16` / `J-G1b` / `D-V8-31`】期待値を 17 → 18 に、テスト名を実体に合わせて書き換えた。**
  // **旧テスト名の逐語は「本数は 17 である」、旧行の逐語は `expect(DIFF_OPS).toHaveLength(17);` である。**
  // **書き換えた理由**: この検査が固定していたのは「`ADR-0248` が増やしたのは1つだけである」ことであり、
  // **18種目 `set_roles` を足したのは別の決定(`V8-M16` の器の新設。門A 本審査 = 限定採用)である。**
  // **検査は消していない** —— 直下の2本が「着手前の16 op が消えていないこと」と
  // 「17種目が `set_user_kinds` であること」を今日も測る。
  //
  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11`。判定値 = 廃止】期待値を 18 → 17 に戻した。**
  // **旧テスト名の逐語**: 「本数は 18 である(`V8-M16` が18種目 `set_roles` を足した)」。
  // **旧行の逐語**: `expect(DIFF_OPS).toHaveLength(18);`
  // **書き換えた理由**: **`set_user_kinds` を語彙から取り除いたためである。**
  // **`set_roles` は消していない** —— **本数が戻ったのは、足した1本と消した1本が
  // たまたま同数だっただけである。** **【禁止の履行】これを差し引きして
  // 「語彙は変わっていない」と書かない** —— **`set_roles` は在り、`set_user_kinds` は無い。**
  test("本数は 17 である(`V8-M29` 第2波が `set_user_kinds` を取り除いた)", () => {
    expect(DIFF_OPS).toHaveLength(17);
  });

  test("着手前の16 op が1つも消えていない(名前で持つ)", () => {
    // **着手前(`e849249`)の実測値を名前の配列で持つ** —— **本数だけを数える形にしない。**
    // `v5-merge-repair-2.md` §3-2 が採った形である(後続が足しても緑・消したら赤)。
    //
    // **【`V8-M29` 第2波】この16本は今日も1つも消えていない** —— **本波が取り除いたのは
    // この16本の外側に足された17種目だけである。****この検査は1バイトも書き換えていない。**
    expect(DIFF_OPS).toEqual(
      expect.arrayContaining([
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
      ]),
    );
  });

  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11`。判定値 = 廃止】当て先を入れ替えた。**
  // **旧テスト名の逐語**: 「17種目は末尾の `set_user_kinds` である」。
  // **旧行の逐語**: `expect(DIFF_OPS[16]).toBe("set_user_kinds");`
  // **今日の17種目(末尾)は `set_roles` である** —— **これが `ADR-0301` 限定2 の
  // 「代わりに何が担うか」への答えそのものであり、同じ位置で測る。**
  test("17種目は末尾の `set_roles` である(旧: `set_user_kinds`)", () => {
    expect(DIFF_OPS[16]).toBe("set_roles");
    expect(DIFF_OPS as readonly string[]).not.toContain("set_user_kinds");
  });

  // **【この検査は `V8-M16` が正面から破った】**
  // **旧テスト名の逐語は「18種目を足していない(部分更新・削除の op は1つも無い)」である。**
  // **期待値を書き換えた根拠は `V8-M16` / `J-G1b` / `D-V8-31`** —— **18種目 `set_roles` を
  // 足した**(台帳 `J-G1b` の門A 本審査 = 限定採用。裁定 `R-1` が追跡先を `V8-M16` に割った)。
  // **検査は消していない。****`ADR-0248` 限定1 / 限定2 / 限定3 が禁じているのは
  // 「利用者の種類の部分更新・削除の op」であり、その5語は今日も1つも語彙に無い** ——
  // **そこは1バイトも緩めていない。****緩めたのは「18種目が1つも無い」という本数の主張だけである。**
  //
  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11`。判定値 = 廃止】禁止語を5 → 6にし、
  // 本数の期待値を 18 → 17 に戻した。**
  // **旧テスト名の逐語**: 「利用者の種類の部分更新・削除の op を1つも足していない
  // (`ADR-0248` 限定1 / 限定2 / 限定3)」。
  // **旧行の逐語**: `expect(DIFF_OPS).toHaveLength(18);` / `expect(DIFF_OPS[17]).toBe("set_roles");`
  // **今日は全体差し替えの `set_user_kinds` すら無い** —— **「部分更新・削除は無い」より
  // 強い状態であり、6語すべてが語彙のどこにも無い。**
  test("利用者の種類に関わる op は、全体差し替えの1本も含めて今日1つも無い", () => {
    // **`ADR-0248` 限定1 / 限定2 / 限定3 が禁じていた5語** —— **今日も1つも無い。**
    for (const forbidden of [
      "add_user_kind",
      "remove_user_kind",
      "update_user_kind",
      "unset_user_kinds",
      "change_user_kinds",
      // **【`V8-M29` 第2波が足した6語目】** **全体差し替えの op も今日は無い。**
      "set_user_kinds",
    ]) {
      expect(DIFF_OPS as readonly string[]).not.toContain(forbidden);
    }
    // **17種目は `set_roles` の1つだけである** —— **18種目は今日1つも無い。**
    expect(DIFF_OPS).toHaveLength(17);
    expect(DIFF_OPS[16]).toBe("set_roles");
  });

  test("`schemas/diff.schema.json` の `op_name.enum` は `DIFF_OPS` と同順・同内容である", () => {
    // **【`V8-M29` 第2波】片側だけを減らしていないことを、この1本がそのまま担う**
    // (**検査は1バイトも書き換えていない**)。
    const opName = (diffSchema as unknown as { $defs: Record<string, Any> }).$defs.op_name as Any;
    expect(opName.enum).toEqual([...DIFF_OPS]);
  });
});

// ---------------------------------------------------------------------------
// (T04-1) `$defs/operation.properties` は9キーで閉じる(`ADR-0248` 限定4 / 限定5)
// ---------------------------------------------------------------------------

describe("(T04-1) `$defs/operation.properties` は9キーで閉じる", () => {
  // **【`V8-M16` / `J-G1b` / `D-V8-31`】期待値に `roles` を1件足し、テスト名を実体に
  // 合わせて書き換えた。****旧テスト名の逐語は「キーは op / table / field / view /
  // changes / workflow / function / theme / user_kinds の9つ」である。**
  // **書き換えた理由**: 10キー目 `roles` を足したのは別の決定(`V8-M16`。門A 本審査 =
  // 限定採用)であり、この検査が固定していた「`ADR-0248` が足したのは9キー目1本」は
  // 今日も真である。**検査は消していない。**
  //
  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`。判定値 = 廃止】期待値から `user_kinds` を
  // 1件落とした(10 → 9)。**
  // **旧テスト名の逐語**: 「キーは op / table / field / view / changes / workflow /
  // function / theme / user_kinds / roles の10」。
  // **旧行の逐語**(配列の中身):
  //   `["op","table","field","view","changes","workflow","function","theme","user_kinds","roles"]`
  // **本数は 9 に戻ったが、9キー目は `user_kinds` ではなく `roles` である。**
  test("キーは op / table / field / view / changes / workflow / function / theme / roles の9", () => {
    expect(Object.keys(operationDefs().properties as Any)).toEqual([
      "op",
      "table",
      "field",
      "view",
      "changes",
      "workflow",
      "function",
      "theme",
      // **`V8-M29` 第2波が `user_kinds` をここから取り除いた。9キー目は `roles` である。**
      "roles",
    ]);
  });

  // **【`V8-M16` / `J-G1b` / `D-V8-31`】期待値に `set_roles` を1件足し、テスト名を実体に
  // 合わせて書き換えた(18種目を足したので、`user_kinds` を禁じる分岐が16 → 17 になった)。
  // 検査は消していない。**
  //
  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`。判定値 = 廃止】向きを反転させた。**
  // **旧テスト名の逐語**: 「`set_user_kinds` 以外の全17分岐が `user_kinds` を `false` で
  // 禁じる(限定5: 意味は1義)」。
  // **旧の期待値の逐語**(17件の配列):
  //   `["add_table","add_field","add_view","update_view","remove_field","remove_table",`
  //   ` "change_table","change_field","remove_view","add_workflow","update_workflow",`
  //   ` "remove_workflow","add_function","update_function","remove_function","set_theme","set_roles"]`
  // **今日は `user_kinds` を `false` で禁じる分岐が1つも無い** —— **キーそのものが
  // `$defs/operation.properties` から消え、`additionalProperties: false` が同じことを担う。**
  // **【禁止の履行】これを「限定5 は今日も守られている」と書かない** ——
  // **守る対象のキーが無い。**
  test("`user_kinds` を `false` で禁じる分岐は今日1つも無い(キーごと消え、`additionalProperties` が担う)", () => {
    const branches = (operationDefs().allOf ?? []) as Any[];
    const mentioned: string[] = [];
    for (const branch of branches) {
      const ifProps = ((branch.if as Any)?.properties ?? {}) as Any;
      const op = ((ifProps.op ?? {}) as Any).const as string | undefined;
      const thenProps = ((branch.then as Any)?.properties ?? {}) as Any;
      if (op !== undefined && Object.hasOwn(thenProps, "user_kinds")) {
        mentioned.push(op);
      }
    }
    expect(mentioned).toEqual([]);
    // **分岐そのものは 18 → 17 に減っただけで、他は1つも欠けていない。**
    expect(branches).toHaveLength(17);
    expect(operationDefs().additionalProperties).toBe(false);
  });

  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11`。判定値 = 廃止】当て先を `set_roles` へ移した。**
  // **旧テスト名の逐語**: 「`set_user_kinds` の分岐は他8キーをすべて `false` で禁じる
  // (限定2: 全体差し替え)」。
  // **旧の期待値の逐語**:
  //   `expect(branch).toBeDefined();`
  //   `expect(thenProps.table).toBe(false);` … `expect(thenProps.theme).toBe(false);`
  //   `expect((branch?.then as Any)?.required).toEqual(["user_kinds"]);`
  // **今日その分岐は在らない。****同型の「全体差し替え」を担うのは `set_roles` であり、
  // 他7キーを `false` で禁じ、`required` は `["roles"]` である**(`ADR-0301` 限定2)。
  test("`set_user_kinds` の分岐は今日1つも無い —— 同型の全体差し替えは `set_roles` が担う", () => {
    const branches = (operationDefs().allOf ?? []) as Any[];
    const constOf = (b: Any): string | undefined =>
      ((((b.if as Any)?.properties ?? {}) as Any).op as Any)?.const as string | undefined;
    expect(branches.find((b) => constOf(b) === "set_user_kinds")).toBeUndefined();

    const roles = branches.find((b) => constOf(b) === "set_roles");
    expect(roles).toBeDefined();
    const thenProps = ((roles?.then as Any)?.properties ?? {}) as Any;
    expect(thenProps.table).toBe(false);
    expect(thenProps.field).toBe(false);
    expect(thenProps.view).toBe(false);
    expect(thenProps.changes).toBe(false);
    expect(thenProps.workflow).toBe(false);
    expect(thenProps.function).toBe(false);
    expect(thenProps.theme).toBe(false);
    expect((roles?.then as Any)?.required).toEqual(["roles"]);
  });

  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`。判定値 = 廃止】向きを反転させた。**
  // **旧テスト名の逐語**: 「値域の定義は1箇所しか無い(限定6: 差分スキーマは `$ref` するだけ)」。
  // **旧の期待値の逐語**:
  //   `expect(payload.$ref).toBe(`
  //   `  "https://smailtalk.dev/schemas/manifest.schema.json#/$defs/app/properties/user_kinds",`
  //   `);`
  //   `expect(payload.enum).toBeUndefined();`
  //   `expect(payload.maxItems).toBeUndefined();`
  //   `expect(payload.items).toBeUndefined();`
  // **今日は、差分スキーマのどの `$ref` も `user_kinds` を指していない**(指し先が消えたので、
  // 1本でも残っていれば宙に浮いた参照になる)。**同じ形の `$ref` は `roles` について在る。**
  test("`user_kinds` を指す `$ref` は差分スキーマに1本も無い(指し先が消えた。`roles` の `$ref` は在る)", () => {
    const refs: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const child of node) {
          walk(child);
        }
        return;
      }
      if (typeof node !== "object" || node === null) {
        return;
      }
      for (const [key, value] of Object.entries(node as Any)) {
        if (key === "$ref" && typeof value === "string") {
          refs.push(value);
        } else {
          walk(value);
        }
      }
    };
    walk(diffSchema);
    expect(refs.filter((ref) => ref.includes("user_kinds"))).toEqual([]);
    expect(refs).toContain(
      "https://smailtalk.dev/schemas/manifest.schema.json#/$defs/app/properties/roles",
    );
  });

  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`。判定値 = 廃止】向きを反転させた。**
  // **旧テスト名の逐語**: 「`$defs/app/properties/user_kinds` の値域は1バイトも動いていない(限定6)」。
  // **旧の期待値の逐語**:
  //   `expect(kinds.minItems).toBe(1);`
  //   `expect(kinds.maxItems).toBe(8);`
  //   `expect(kinds.uniqueItems).toBe(true);`
  //   `expect(((kinds.items as Any).properties as Any).id).toMatchObject({`
  //   `  pattern: "^[a-z0-9_]{1,32}$",`
  //   `  not: { enum: ["owner", "editor", "viewer", "anonymous"] },`
  //   `});`
  // **【担い手が無いもの。名指しで書く】** **上限8種・`uniqueItems`・予約4語の締め出し・
  // 識別子の形の4つは、器ごと消えたので今日1バイトも測れない。** **`app.roles` は上限が
  // 12 で、`id` に `not` を1つも持たない** —— **同じものを担ってはいない。**
  test("`$defs/app/properties/user_kinds` は今日在らない(値域そのものが消えた)", () => {
    const app = ((manifestSchema as unknown as { $defs: Record<string, Any> }).$defs.app as Any)
      .properties as Any;
    expect(app.user_kinds).toBeUndefined();
    expect(Object.keys(app)).not.toContain("user_kinds");
    // **代わりに立つ器の値域は、同じ位置に在る**(上限は 8 ではなく 12 である)。
    const roles = app.roles as Any;
    expect(roles).toBeDefined();
    expect(roles.maxItems).toBe(12);
    // **予約4語の締め出しは、こちらには1つも無い**(`V8-M16` が申告済みの穴)。
    expect(((roles.items as Any).properties as Any).id).not.toHaveProperty("not");
  });
});

// ---------------------------------------------------------------------------
// (T04-2) 適用と拒否
// ---------------------------------------------------------------------------

describe("(T04-2) `set_user_kinds` を適用すると宣言がマニフェストに入る", () => {
  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11`。判定値 = 廃止】向きを反転させた。**
  // **旧テスト名の逐語**: 「宣言が無いアプリに初回適用できる」。
  // **旧の期待値の逐語**:
  //   `expect(result.valid).toBe(true);`
  //   `expect((manifest?.app as unknown as Any | undefined)?.user_kinds).toEqual(KINDS);`
  test("宣言が無いアプリにも適用できない —— `/operations/0/op` で拒否される", () => {
    const result = applyDiff(dataRoot, APP_ID, setKindsDiff(KINDS));
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.errors[0]?.path).toBe("/operations/0/op");
    expect(result.valid === false && result.errors[0]?.message).toContain(
      'op の値 "set_user_kinds" は語彙にありません。',
    );
  });

  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`。判定値 = 廃止】向きを反転させた。**
  // **旧テスト名の逐語**: 「既に宣言があるアプリでは丸ごと差し替わる(限定2: 部分更新ではない)」。
  // **旧の期待値の逐語**:
  //   `expect(applyDiff(dataRoot, APP_ID, setKindsDiff(KINDS)).valid).toBe(true);`
  //   `const next = [{ id: "patient", name: "患者" }];`
  //   `expect((manifest?.app as unknown as Any | undefined)?.user_kinds).toEqual(next);`
  // **今日は「既に宣言があるアプリ」を1つも作れない** —— **差分でも、マニフェストの
  // 直接投入でも、`user_kinds` は入らない。****前提そのものが成立しないことを測る。**
  test("「既に宣言があるアプリ」を今日は1つも作れない(差分でも直接投入でも入らない)", () => {
    expect(applyDiff(dataRoot, APP_ID, setKindsDiff(KINDS)).valid).toBe(false);
    const direct = applyManifest(dataRoot, APP_ID, manifestWithKinds(KINDS));
    expect(direct.valid).toBe(false);
    expect(direct.valid === false && direct.errors[0]?.path).toBe("/app");
    expect(direct.valid === false && direct.errors[0]?.message).toBe(
      '未知のプロパティ "user_kinds" は指定できません。',
    );
    expect(direct.valid === false && direct.errors[0]?.allowed_values).toEqual([
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

  // **【2026-08-11。`V8-M29` 第2波】主題は1ミリも変えていない(「何も失わない」)。**
  // **旧テスト名の逐語**: 「テーブル・ビュー・レコードを1つも失わない」。
  // **旧の期待値の逐語**: `expect(result.valid).toBe(true);` のあとに
  //   `expect(manifest?.app.tables).toHaveLength(1);` / `expect(manifest?.app.views).toHaveLength(1);`
  // **今日は「拒否された差分が、テーブル・ビュー・レコードを1つも失わない」を測る。**
  test("拒否された差分は、テーブル・ビューを1つも失わない", () => {
    expect(applyDiff(dataRoot, APP_ID, setKindsDiff(KINDS)).valid).toBe(false);
    const onDisk = JSON.parse(
      readFileSync(join(dataRoot, "apps", APP_ID, "manifest.json"), "utf8"),
    ) as Manifest;
    expect(onDisk.app.tables).toHaveLength(1);
    expect(onDisk.app.views).toHaveLength(1);
    expect((onDisk.app as unknown as Any).user_kinds).toBeUndefined();
  });

  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11`。判定値 = 廃止】拒否の理由が変わった。**
  // **旧テスト名の逐語**: 「空配列は拒否される(限定3: 宣言を消す手段を作らない)」。
  // **旧の期待値の逐語**: `expect(result.valid).toBe(false);`(拒否は `minItems: 1` が出していた)
  // **今日も拒否されるが、理由は値域ではなく `op` の名前である。**
  // **【担い手が無いもの】「宣言を消す手段を作らない」という限定3 は、宣言そのものが
  // 無くなったので今日1バイトも測れない。**
  test("空配列も拒否されるが、理由は `minItems` ではなく `op` の名前である(限定3 は測れない)", () => {
    expect(opRejectionPath([])).toBe("/operations/0/op");
  });

  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`。判定値 = 廃止】拒否の理由が変わった。**
  // **旧テスト名の逐語**: 「9種目は拒否される(`ADR-0158` 限定3 の上限8)」。
  // **旧の期待値の逐語**: `expect(applyDiff(dataRoot, APP_ID, setKindsDiff(nine)).valid).toBe(false);`
  // **【担い手が無いもの。名指しで書く】** **上限8種を測る検査は今日1件も作れない** ——
  // **8件でも9件でも、`op` の名前の時点で同じ理由で拒否されるので、境目が観測できない。**
  test("9種でも8種でも同じ理由で拒否される —— 上限8の境目は今日1バイトも観測できない", () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({ id: `k${i}`, name: `種類${i}` }));
    const eight = nine.slice(0, 8);
    expect(opRejectionPath(nine)).toBe("/operations/0/op");
    // **着手前は通っていた8件も、今日はまったく同じ `path` で拒否される。**
    expect(opRejectionPath(eight)).toBe("/operations/0/op");
  });

  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`。判定値 = 廃止】拒否の理由が変わった。**
  // **旧テスト名の逐語**: 「予約語(owner / editor / viewer / anonymous)は拒否される(`ADR-0158` 限定1)」。
  // **旧の期待値の逐語**: `expect(result.valid).toBe(false);`(拒否は `items.id.not.enum` が出していた)
  // **【担い手が無いもの】** **`user_kinds` 側の予約4語の締め出しは今日1つも無い。**
  // **`app.roles[].id` には `not` が1つも無く、行ごとのアクセス権の側にだけ同じ
  // `not.enum` が残っている**(`src/kernel/user-kinds-retirement.test.ts` の (5))。
  test("予約語も拒否されるが、理由は `not.enum` ではなく `op` の名前である(締め出しは測れない)", () => {
    for (const reserved of ["owner", "editor", "viewer", "anonymous"]) {
      expect(opRejectionPath([{ id: reserved, name: "x" }])).toBe("/operations/0/op");
    }
  });

  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`。判定値 = 廃止】拒否の理由が変わった。**
  // **旧テスト名の逐語**: 「識別子の形の外(日本語 / 空白 / 33文字)は拒否される(`ADR-0158` 限定4)」。
  // **旧の期待値の逐語**: `expect(result.valid).toBe(false);`(拒否は `items.id.pattern` が出していた)
  // **【担い手が無いもの】** **形の内と外の境目は今日1バイトも観測できない** ——
  // **正しい識別子(`member`)も、形の外(`会員`)も、同じ `path` で拒否される。**
  test("識別子の形の外も内も同じ理由で拒否される —— `pattern` の境目は今日1バイトも観測できない", () => {
    for (const bad of ["会員", "two words", "a".repeat(33), "Member"]) {
      expect(opRejectionPath([{ id: bad, name: "x" }])).toBe("/operations/0/op");
    }
    // **形の内側にある識別子も、今日はまったく同じ `path` で拒否される。**
    expect(opRejectionPath([{ id: "member", name: "会員" }])).toBe("/operations/0/op");
  });

  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11`。判定値 = 廃止】拒否の理由が変わった。**
  // **旧テスト名の逐語**: 「`changes` を同居させると拒否される(限定2)」。
  // **旧の期待値の逐語**: `expect(applyDiff(dataRoot, APP_ID, diff).valid).toBe(false);`
  // **今日も拒否されるが、`changes` の同居ではなく `op` の名前で拒否される。**
  test("`changes` を同居させても拒否されるが、理由は同居ではなく `op` の名前である", () => {
    const diff = {
      diff_id: "d9",
      intent: "x",
      operations: [{ op: "set_user_kinds", user_kinds: KINDS, changes: { name: "y" } }],
    } as unknown as Diff;
    const result = applyDiff(dataRoot, APP_ID, diff);
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.errors[0]?.path).toBe("/operations/0/op");
  });
});

// ---------------------------------------------------------------------------
// (T06) undo / redo / dry_run_diff / 変更履歴 / 要件定義書 —— **実測**
// ---------------------------------------------------------------------------

describe("(T06) 差分操作を足すと当たる先(**実測。推測を書かない**)", () => {
  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11`。判定値 = 廃止】向きを反転させた。**
  // **旧テスト名の逐語**: 「`dry_run_diff` は状態を1バイトも変えずに valid を返す」。
  // **旧の期待値の逐語**: `expect(dry.valid).toBe(true);`
  // **「状態を1バイトも変えない」の側は1ミリも変わっていない** —— **そこは今日も測る。**
  test("`dry_run_diff` は状態を1バイトも変えずに invalid を返す(旧: valid)", () => {
    const dry = dryRunDiff(dataRoot, APP_ID, setKindsDiff(KINDS));
    expect(dry.valid).toBe(false);
    expect(dry.valid === false && dry.errors[0]?.path).toBe("/operations/0/op");
    // **状態は今日も1バイトも変わっていない。**
    const manifestPath = join(dataRoot, "apps", APP_ID, "manifest.json");
    const onDisk = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    expect((onDisk.app as unknown as Any).user_kinds).toBeUndefined();
  });

  // **【2026-08-11。`V8-M29` 第2波】主題(「適用前に弾く」)は1ミリも変えていない。**
  // **旧テスト名の逐語**: 「`dry_run_diff` は不正な宣言を適用前に弾く」。
  // **旧の期待値の逐語**: `expect(dryRunDiff(dataRoot, APP_ID, setKindsDiff([])).valid).toBe(false);`
  // **今日は宣言の中身に依らず弾く** —— **正しい宣言も空配列も同じである。**
  test("`dry_run_diff` は宣言の中身に依らず適用前に弾く(正しい宣言も空配列も同じ)", () => {
    expect(dryRunDiff(dataRoot, APP_ID, setKindsDiff([])).valid).toBe(false);
    expect(dryRunDiff(dataRoot, APP_ID, setKindsDiff(KINDS)).valid).toBe(false);
  });

  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11`。判定値 = 廃止】向きを反転させた。**
  // **旧テスト名の逐語**: 「`undo` は宣言を「宣言が無い状態」へ戻す」。
  // **旧の期待値の逐語**:
  //   `expect(applyDiff(dataRoot, APP_ID, setKindsDiff(KINDS)).valid).toBe(true);`
  //   `expect(preview.valid).toBe(true);`
  //   `expect(result.valid).toBe(true);`
  //   `expect((manifest?.app as unknown as Any | undefined)?.user_kinds).toBeUndefined();`
  // **【担い手が無いもの】** **戻す対象そのものが今日は作れない** ——
  // **拒否された差分は取り消せる変更として1件も積まれない。**
  test("`undo` の対象になる変更が1件も積まれない(拒否された差分は履歴に残らない)", () => {
    expect(applyDiff(dataRoot, APP_ID, setKindsDiff(KINDS)).valid).toBe(false);
    const preview = previewUndo(dataRoot, APP_ID);
    expect(preview.valid).toBe(false);
    expect(undo(dataRoot, APP_ID).valid).toBe(false);
  });

  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11`。判定値 = 廃止】向きを反転させた。**
  // **旧テスト名の逐語**: 「`redo` は宣言を戻す」。
  // **旧の期待値の逐語**:
  //   `expect(undo(dataRoot, APP_ID).valid).toBe(true);`
  //   `expect(preview.valid).toBe(true);`
  //   `expect((manifest?.app as unknown as Any | undefined)?.user_kinds).toEqual(KINDS);`
  // **【担い手が無いもの】** **やり直す `undo` が無いので、`redo` で宣言が戻ることは
  // 今日ありえない。**
  test("`redo` でやり直せる `undo` も1件も無い(宣言は今日どうやっても戻らない)", () => {
    expect(applyDiff(dataRoot, APP_ID, setKindsDiff(KINDS)).valid).toBe(false);
    expect(previewRedo(dataRoot, APP_ID).valid).toBe(false);
    expect(redo(dataRoot, APP_ID).valid).toBe(false);
  });

  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11`。判定値 = 廃止】向きを反転させた。**
  // **旧テスト名の逐語**: 「`_changelog` に op 名と宣言の中身がそのまま残る」。
  // **旧の期待値の逐語**:
  //   `expect(JSON.stringify(last?.operations)).toContain("set_user_kinds");`
  //   `expect(JSON.stringify(last?.operations)).toContain("member");`
  test("`_changelog` に op 名も宣言の中身も1バイトも残らない(適用の行が1件も増えない)", () => {
    const before = store.listChangelog(APP_ID).filter((e) => e.kind === "apply").length;
    expect(applyDiff(dataRoot, APP_ID, setKindsDiff(KINDS)).valid).toBe(false);
    const applied = store.listChangelog(APP_ID).filter((e) => e.kind === "apply");
    expect(applied).toHaveLength(before);
    expect(JSON.stringify(applied)).not.toContain("set_user_kinds");
    expect(JSON.stringify(applied)).not.toContain("member");
  });

  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G12`。判定値 = 廃止】向きを反転させた。**
  // **旧テスト名の逐語**: 「要件定義書の履歴節に op 名が出る(`diff_op` の語彙は `DIFF_OPS` から来る)」。
  // **旧の期待値の逐語**: `expect(doc.markdown).toContain("set_user_kinds");`
  // **`diff_op` の語彙が `DIFF_OPS` から来るという性質は1ミリも変わっていない** ——
  // **`DIFF_OPS` からこの1語が消えたので、要件定義書にも出なくなった。**
  test("要件定義書の履歴節に op 名が1度も出ない(`DIFF_OPS` から消えたため)", () => {
    expect(applyDiff(dataRoot, APP_ID, setKindsDiff(KINDS)).valid).toBe(false);
    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    expect(doc.markdown).not.toContain("set_user_kinds");
  });

  // **【2026-08-11。`V8-M29` 第2波】主題は変えていないが、検出力は落ちた(隠さない)。**
  // **旧テスト名の逐語**: 「要件定義書は宣言の**中身**を1文も述べない(**述べていないことを書く**)」。
  // **旧の期待値の逐語**: `expect(text).not.toContain("会員");` / `expect(text).not.toContain("取引先");`
  // **旧は「適用に成功した宣言の中身を述べない」を測っていた。****今日は適用そのものが
  // できないので、この2行は「入りようのないものが入っていない」を測っている** ——
  // **検出力は落ちている。****それでも消さない**(要件定義書の生成器が撤去した語彙の文を
  // 作らないことは `src/kernel/user-kinds-retirement.test.ts` の (6) が別に測る)。
  test("要件定義書は宣言の**中身**を1文も述べない(適用できないので、入りようがない)", () => {
    expect(applyDiff(dataRoot, APP_ID, setKindsDiff(KINDS)).valid).toBe(false);
    const text = generateRequirementsDoc(dataRoot, APP_ID).markdown;
    expect(text).not.toContain("会員");
    expect(text).not.toContain("取引先");
  });
});
