import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SYSTEM_TABLES } from "../shared/system-tables.ts";
import { foldOperations } from "./apply-diff.ts";
import { applyManifest } from "./apply-manifest.ts";
import { createApp } from "./create-app.ts";
import type { ValidationError, ValidationResult } from "./errors.ts";
import { APP_STATUSES, CHANGELOG_KINDS, KernelMetaStore } from "./meta-store.ts";
import { createRecord, deleteRecord, updateRecord } from "./records.ts";
import { appDbPath } from "./storage-paths.ts";
import { DIFF_OPS, type Diff, type Manifest, type Operation, type ViewChanges } from "./types.ts";
import { validateDiff, validateManifestFull } from "./validate.ts";

/**
 * システムテーブル導入によって壊れてはならない保証を1箇所に集めたテスト(ADR-0006)。
 *
 * - 憲法1 の3点(§3): 一方向依存 / 定義の出所 / 書き込み経路の不在
 * - L3(§8): `_` 始まりIDは `add_table` / `add_field` で定義できない
 * - `update_view` はビューの対象テーブルを変更できない(§8 の保証の前提)
 *
 * これらは「実装したから通る」のではなく「将来ほどけたら落ちる」ために置いてある。
 */

const bookTracker: Manifest = {
  app: {
    id: "book-tracker",
    name: "蔵書管理",
    tables: [
      {
        id: "books",
        name: "書籍",
        fields: [
          { id: "title", name: "タイトル", type: "text", required: true },
          { id: "status", name: "状態", type: "select", options: ["未読", "読了"] },
        ],
      },
    ],
    views: [{ id: "book-list", type: "list_view", table: "books", columns: ["title"] }],
  },
};

function clone(manifest: Manifest): Manifest {
  return structuredClone(manifest);
}

function expectInvalid(result: ValidationResult): ValidationError[] {
  if (result.valid) {
    throw new Error("無効を期待しましたが valid でした。");
  }
  return result.errors;
}

function diff(operations: Operation[]): Diff {
  return { diff_id: "d-001", intent: "テスト用の差分", operations };
}

function fold(operations: Operation[]): ReturnType<typeof foldOperations> {
  return foldOperations(clone(bookTracker), operations);
}

describe("憲法1-1: 一方向依存", () => {
  test("システムテーブルを参照するビューが1つも無いマニフェストは従来どおり valid", () => {
    expect(validateManifestFull(bookTracker)).toEqual({ valid: true });
  });

  test("アプリが1つも無くてもシステムテーブルの定義は変わらない", () => {
    // 定義は定数であり、`data/` にもマニフェストにも一切依存しない。
    const before = structuredClone(SYSTEM_TABLES);
    const empty: Manifest = { app: { id: "empty", name: "空", tables: [], views: [] } };
    validateManifestFull(empty);
    expect(SYSTEM_TABLES).toEqual(before);
  });

  test("システムテーブルを参照するビューを足しても、他のビューの検証は変わらない", () => {
    const withSystemView = clone(bookTracker);
    withSystemView.app.views.push({
      id: "app-list",
      type: "list_view",
      table: "_apps",
      columns: ["name"],
    });
    expect(validateManifestFull(withSystemView)).toEqual({ valid: true });
  });
});

describe("憲法1-2: 定義の出所は TypeScript の定数", () => {
  test("apply_diff で _apps に列を増やせない(スキーマ段階で落ちる)", () => {
    const errors = expectInvalid(
      validateDiff(
        diff([
          {
            op: "add_field",
            table: "_apps",
            field: { id: "owner", name: "所有者", type: "text" },
          },
        ]),
      ),
    );
    expect(errors.some((error) => error.path === "/operations/0/table")).toBe(true);
  });

  test("スキーマ検証をすり抜けても畳み込みが「読み取り専用」で拒否する(ADR-0006 §7 #13)", () => {
    const result = fold([
      { op: "add_field", table: "_apps", field: { id: "owner", name: "所有者", type: "text" } },
    ]);
    if (result.valid) {
      throw new Error("拒否を期待しましたが成功しました。");
    }
    const error = result.errors.find((e) => e.path === "/operations/0/table");
    expect(error?.message).toContain("読み取り専用");
    expect(error?.message).not.toContain("存在しません");
    // L3 で必ず弾かれる add_table へ誘導しない(憲法6)。
    expect(error?.hint ?? "").not.toContain("add_table");
    expect(error?.allowed_values).toEqual(["books"]);
  });

  test("マニフェストに _apps を宣言し直すことはできない", () => {
    const redefined = clone(bookTracker);
    redefined.app.tables.push({
      id: "_apps",
      name: "偽の台帳",
      fields: [{ id: "x", name: "X", type: "text" }],
    });
    const errors = expectInvalid(validateManifestFull(redefined));
    expect(errors.some((error) => error.path === "/app/tables/1/id")).toBe(true);
  });

  test("投影の選択肢は KernelMetaStore の値域と一致する", () => {
    const status = SYSTEM_TABLES.find((t) => t.id === "_apps")?.fields.find(
      (f) => f.id === "status",
    );
    const kind = SYSTEM_TABLES.find((t) => t.id === "_changelog")?.fields.find(
      (f) => f.id === "kind",
    );
    expect(status?.type === "select" ? status.options : undefined).toEqual([...APP_STATUSES]);
    expect(kind?.type === "select" ? kind.options : undefined).toEqual([...CHANGELOG_KINDS]);
  });
});

describe("憲法1-3 / L3: 書き込み経路と定義経路の不在", () => {
  test("add_table で _apps を再定義できない(スキーマの pattern)", () => {
    const errors = expectInvalid(
      validateDiff(
        diff([
          {
            op: "add_table",
            table: {
              id: "_apps",
              name: "偽の台帳",
              fields: [{ id: "x", name: "X", type: "text" }],
            },
          },
        ]),
      ),
    );
    expect(errors.some((error) => error.path === "/operations/0/table/id")).toBe(true);
  });

  test("add_field で _ 始まりのフィールドIDを足せない(スキーマの pattern)", () => {
    const errors = expectInvalid(
      validateDiff(
        diff([{ op: "add_field", table: "books", field: { id: "_id", name: "ID", type: "text" } }]),
      ),
    );
    expect(errors.some((error) => error.path === "/operations/0/field/id")).toBe(true);
  });
});

describe("add_view: システムテーブルを参照する画面は実際に追加できる", () => {
  test("_apps を参照する list_view を追加できる", () => {
    const operations: Operation[] = [
      {
        op: "add_view",
        view: { id: "app-list", type: "list_view", table: "_apps", columns: ["name", "status"] },
      },
    ];
    expect(validateDiff(diff(operations))).toEqual({ valid: true });

    const folded = fold(operations);
    if (!folded.valid) {
      throw new Error(`畳み込みに失敗しました: ${JSON.stringify(folded.errors)}`);
    }
    expect(validateManifestFull(folded.manifest)).toEqual({ valid: true });
    expect(folded.manifest.app.views.map((view) => view.table)).toContain("_apps");
    // 投影なので、マニフェストの tables には現れない(ADR-0006 §5)。
    expect(folded.manifest.app.tables.map((table) => table.id)).toEqual(["books"]);
  });

  test("_changelog を参照する detail_view を追加できる", () => {
    const operations: Operation[] = [
      { op: "add_view", view: { id: "log-detail", type: "detail_view", table: "_changelog" } },
    ];
    expect(validateDiff(diff(operations))).toEqual({ valid: true });
    const folded = fold(operations);
    if (!folded.valid) {
      throw new Error(`畳み込みに失敗しました: ${JSON.stringify(folded.errors)}`);
    }
    expect(validateManifestFull(folded.manifest)).toEqual({ valid: true });
  });

  test("_changelog を app_id で絞る list_view を追加できる(DoD-4 のアプリ別履歴)", () => {
    const operations: Operation[] = [
      {
        op: "add_view",
        view: {
          id: "log-list",
          type: "list_view",
          table: "_changelog",
          columns: ["applied_at", "intent"],
          sort: { field: "applied_at", order: "desc" },
          filter: [{ field: "app_id", equals: "book-tracker" }],
        },
      },
    ];
    expect(validateDiff(diff(operations))).toEqual({ valid: true });
    const folded = fold(operations);
    if (!folded.valid) {
      throw new Error(`畳み込みに失敗しました: ${JSON.stringify(folded.errors)}`);
    }
    expect(validateManifestFull(folded.manifest)).toEqual({ valid: true });
  });

  test("add_view で form がシステムテーブルを指すと、適用後マニフェストの検証で落ちる(L2)", () => {
    const operations: Operation[] = [
      { op: "add_view", view: { id: "app-form", type: "form", table: "_apps", fields: ["name"] } },
    ];
    // 差分スキーマ単体は通る。止めるのは適用後マニフェストの参照整合性(L2)である。
    expect(validateDiff(diff(operations))).toEqual({ valid: true });
    const folded = fold(operations);
    if (!folded.valid) {
      throw new Error(`畳み込みに失敗しました: ${JSON.stringify(folded.errors)}`);
    }
    const errors = expectInvalid(validateManifestFull(folded.manifest));
    expect(errors.some((error) => error.message.includes("読み取り専用"))).toBe(true);
  });
});

describe("update_view はビューの対象テーブルを変更できない(ADR-0006 §8)", () => {
  test("ViewChanges に table が無い(型の上での保証)", () => {
    // 型に無いことをテストで固定する。`table` が足された瞬間にここが破綻し、
    // 「読み取り専用の保証が静かに壊れた」ことに気付ける。
    //
    // **V3-M2-T01(ADR-0050)で手書き配列を更新した。** プリセット7キーが `ViewChanges` に
    // 増えたのに配列を放置すると、**「これが `ViewChanges` の全量である」という主張が
    // 薄まる**(`docs/plan/v3/records/v3-m2.md` §2-10 (B) が「触るか触らないかを明示する」
    // と指示していた箇所)。**触ると決めた。** あわせて、以前は落ちていた `name` も入れて
    // 全12キーにし、「全量である」ことを字面でも成り立たせた。**`table` は今日も無い。**
    //
    // **【2026-07-27。V3-M5-T05 で 12 → 13 に更新した。ADR-0055 改訂1】**
    // **V3-M5-T02 が逃げ道の参照 `custom_css` を `$defs/view_changes` に足した**(12 → 13)。
    // **その時点で上の「全12キーにし、『全量である』ことを字面でも成り立たせた」は偽になった** ——
    // **しかし、どの検査も赤くならなかった。** `(keyof ViewChanges)[]` は**部分集合を許す**ので
    // 型検査は通り、`toHaveLength(12)` も配列自身の長さを見ているだけなので通る。
    // **緑のまま静かに偽になっていた**(門A審査 [`v3-m5-gate-a.md`](../../docs/plan/v3/records/v3-m5-gate-a.md)
    // §6-2 (3) の (B)1 が全走査で特定し、T05 の担当と定めた)。
    // **壊れたのは「全量である」という副次的な主張だけで、`table` が無いことを保証する本来の
    // 意図(ADR-0006 §8)は無傷である** —— 下の `toContain` / `not.toContain` がそれを見ている。
    // **「テストが赤くなったから直した」ではない。実装によって字面が偽になったので直した。**
    const keys: (keyof ViewChanges)[] = [
      "name",
      "columns",
      "sort",
      "filter",
      "fields",
      "preset_column_align",
      "preset_column_width",
      "preset_pager_position",
      "preset_label_placement",
      "preset_field_columns",
      "preset_image_size",
      "preset_text_preview",
      // V3-M5-T02(D-G5 / ADR-0055 限定1・限定3 改訂1)。**逃げ道の参照**であって本体ではない。
      "custom_css",
    ];
    expect(keys).toHaveLength(13);
    // **本来の意図(`table` が無い)を字面ではなく型と集合で見る。**
    // `keys` は手書きなので放置すると再び黙って古くなる —— **`table` が `ViewChanges` に
    // 足された瞬間に `keyof` へ現れ、ここへ書き足さない限り「全量」の主張が崩れる。**
    expect(keys).not.toContain("table");
    // 重複で件数を水増ししていないこと(手書き配列の事故を止める)。
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("差分スキーマが changes.table を拒否する", () => {
    const errors = expectInvalid(
      validateDiff({
        diff_id: "d-001",
        intent: "既存の一覧を _apps へ向け直したい",
        // biome-ignore lint/suspicious/noExplicitAny: 語彙外の changes を意図的に投げる
        operations: [{ op: "update_view", view: "book-list", changes: { table: "_apps" } } as any],
      }),
    );
    expect(errors.some((error) => error.path.startsWith("/operations/0/changes"))).toBe(true);
  });

  test("畳み込みでも既存ビューの table は変わらない", () => {
    const folded = fold([
      { op: "update_view", view: "book-list", changes: { columns: ["title", "status"] } },
    ]);
    if (!folded.valid) {
      throw new Error(`畳み込みに失敗しました: ${JSON.stringify(folded.errors)}`);
    }
    expect(folded.manifest.app.views[0]?.table).toBe("books");
  });
});

/**
 * V1-M0-T05(F-28)の歯止め。
 *
 * create_app が changelog を書くようになった = **カーネル内部に追記経路が1本増えた**。
 * それによって「語彙が増えていないこと」(ADR-0007 Δ1)と「外部から書けないこと」
 * (ADR-0006 §8 の L1)が壊れていないことを、ここで固定する。
 */
describe("V1-M0-T05: create_app の changelog 追記が語彙と書き込み経路を広げていない", () => {
  /**
   * **V1-M1-T03 で期待値を書き換えた。実装を直したのではない。**
   *
   * このテストの主張は「**create_app が changelog を書くようになったことによって**
   * 語彙が増えていないこと」である。M0-T05 の時点では「4種のまま」と書けば済んだが、
   * V1-M1(ADR-0010)が **ADR-0007 の門A を正面から通して** `DIFF_OPS` を 4 → 8 に
   * したので、数の固定はもう主張の役に立たない。
   *
   * **主張を保つために、数ではなく「増えた op が門A を通ったものであること」を固定する。**
   * V1-M1-remove-view(ADR-0012)が 8 → 9 にした(`remove_view`)。
   * **V1-M2-T07(ADR-0013)が 9 → 12 にした**(`add_workflow` / `update_workflow` /
   * `remove_workflow`)。ADR-0013 は ADR-0007 門A の**本審査**であり、判定は限定採用。
   * **V1-M6-T05(ADR-0024)が 12 → 15 にした**(`add_function` / `update_function` /
   * `remove_function`)。ADR-0024 も ADR-0007 門A を通した増分であり、判定は限定採用。
   * **V3-M1-T03(ADR-0047)が 15 → 16 にした**(`set_theme`。アプリのテーマの全体差し替え)。
   * **16種目は門A を通っている** —— 根拠は `docs/adr/0047-app-theme-manifest.md`
   * (審査単位 D-G2 の門A **本審査**。判定は**限定採用**(限定12点)。審査記録は
   * `docs/plan/v3/records/v3-m1-gate-a-theme.md` §3、台帳の行は
   * `docs/adr/0007-vocabulary-governance.md` §8 の 2026-07-25 の追記行 + 注15)。
   * **ここに17種目が現れたら、それは門A を通っていない増分である。**
   *
   * **【`V8-M16-T03` による改訂の理由 —— 消さずに残す】** 直上の1行は制定時の文であり、
   * **17種目(`set_user_kinds` / `ADR-0248`)も18種目(`set_roles` / `V8-M16`)も現に
   * 現れたので、そのままでは嘘になる**(憲法6)。**18種目は門A を通っている** ——
   * 根拠は台帳 `docs/adr/0007-vocabulary-governance.md` §8 の `J-G1b`(門A **本審査**。
   * 判定は**限定採用**)とユーザ決定 `D-V8-31`、審査記録は
   * `docs/plan/v8/records/v8-m15.md`。**ここに19種目が現れたら、それは門A を通っていない
   * 増分である。****嘘を消すために書き換えたのであって、番人を緩めたのではない。**
   *
   * **【V3-M1-T03 による改訂の理由 —— 消さずに残す】**旧文は「ここに16種目が現れたら、
   * それは門A を通っていない増分である」だった。**16種目が現に現れたので、旧文は
   * そのままでは嘘になる**(憲法6)。**嘘を消すために書き換えたのであって、番人を
   * 緩めたのではない** —— 更新したのは「次に現れたら疑う数」であり、
   * **増分がどの ADR の門A を通ったかを同じ場所に書く**作法は
   * `scripts/kernel-export-snapshot.txt` の追記行と同型である。
   * この箇所は `docs/plan/v3/records/v3-m1.md` が数え落としており、
   * 審査(V3-M1-T00)が §10 の規則1 の注意として指摘した。
   *
   * **このテストが `SYSTEM_TABLES` の検査と同じファイルに置かれていることには意味がある。**
   * ADR-0013 限定9 は「ワークフローのためにシステムテーブルを1本も足さない」と定めており
   * (`_workflow_runs` / `_notifications` を却下)、**同ファイルの `SYSTEM_TABLES` 検査が
   * `_apps` / `_changelog` の2本のままであることが、その限定が守られていることの
   * 機械的な証拠である**(CP-V1-2 確認方法6)。**ADR-0024 も限定10 で
   * `SYSTEM_TABLES` を2本のまま保つ(関数のために予約名を1つも足さない)ので、
   * op 語彙が 12 → 15 に増えてもシステムテーブルは1本も増えていない、という
   * 対比がこのファイルの主張になる。**
   */
  // **【`V5-M17b` / `ADR-0248`】旧テスト名の逐語は「DIFF_OPS は16種(additive 4 + ADR-0010 の破壊的 4 + ADR-0012 の remove_view + ADR-0013 のワークフロー 3 + ADR-0024 の関数 3 + ADR-0047 の set_theme 1)」。**
  // **【`V8-M16-T03` / `J-G1b` / `D-V8-31`】旧テスト名の逐語は「DIFF_OPS は17種(additive 4 + ADR-0010 の破壊的 4 + ADR-0012 の remove_view + ADR-0013 のワークフロー 3 + ADR-0024 の関数 3 + ADR-0047 の set_theme 1 + ADR-0248 の set_user_kinds 1)」である。**
  // **テスト名も実体に合わせて直した** —— **数で書いた記述は静かに嘘になる**(`ADR-0013` §4c 問2 の作法)。**検査は消していない。**
  test("DIFF_OPS は18種(additive 4 + ADR-0010 の破壊的 4 + ADR-0012 の remove_view + ADR-0013 のワークフロー 3 + ADR-0024 の関数 3 + ADR-0047 の set_theme 1 + ADR-0248 の set_user_kinds 1 + V8-M16 の set_roles 1)", () => {
    expect([...DIFF_OPS]).toEqual([
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
      // **V5-M17b(ADR-0248)が足した17種目。****`SYSTEM_TABLES` は今日も2本のままである**
      // —— **op 語彙が 16 → 17 に増えても予約名は1本も増えていない、という対比が
      // このファイルの主張であり、本決定はその対比を1ミリも崩していない**(限定7)。
      // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11`。判定値 = 廃止】**
      // **旧(逐語)**: `"set_user_kinds",` —— 語彙から撤去されたので期待値から1行外した(18 → 17)。
      // **`SYSTEM_TABLES` は今日も2本のままである** —— **op 語彙が 18 → 17 に**減っても**
      // 予約名は1本も減っていない。**このファイルの主張(op 語彙とシステムテーブルの
      // 本数は連動しない)は、増えた側だけでなく減った側でも今日そのまま立っている。**
      // **テスト名の「18種」と「ADR-0248 の set_user_kinds 1」は当時の逐語である**(テスト名は書き換えない)。
      // **V8-M16-T03(台帳 `J-G1b` / `D-V8-31`)が足した18種目。****`SYSTEM_TABLES` は
      // 今日も2本のままである** —— **op 語彙が 17 → 18 に増えても予約名は1本も増えて
      // いない、という対比がこのファイルの主張であり、本決定はその対比を1ミリも
      // 崩していない。**
      "set_roles",
    ]);
  });

  test("CHANGELOG_KINDS は apply / undo / redo の3種(第4の kind は足していない)", () => {
    // **V1-M9-T05 で期待値を書き換えた。壊れたのではなく、門を通った申告である。**
    // このテストは「値域が門を通らずに増えていないこと」を固定する番人であり、
    // ADR-0007 の門A を通過した増分のときだけ期待値を更新してよい(:305 の DIFF_OPS 番人と同型)。
    // **ADR-0032(V1-M9-T05)が redo を足した** —— ADR-0004 §1「redo は v0 では作らない」の
    // 明示的な改訂で、判定は ADR-0007 門A の限定採用(Δ8: `src/kernel/` に redo / previewRedo が
    // 増える + CHANGELOG_KINDS の値域拡張)。ADR-0004 §1 の理由「v0 の op は additive のみなので
    // 同じ差分の再適用で足りる」が M1 の破壊的 op 解禁で失効したことが、改訂の唯一かつ十分な理由。
    // **ここに第4の kind が現れたら、それは門A を通っていない増分である。**
    expect([...CHANGELOG_KINDS]).toEqual(["apply", "undo", "redo"]);
  });

  test("createApp が第0行を書いた後も、_changelog への外部書き込みは拒否される", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "gp-t05-readonly-"));
    const store = KernelMetaStore.open(dataRoot);
    try {
      const { app } = createApp(store, "蔵書管理", { app_id: "book-tracker" });
      // 第0行が実際に書かれていること(= 内部の追記経路が開いた状態であること)。
      expect(store.listChangelog(app.app_id)).toHaveLength(1);

      const applied = applyManifest(dataRoot, app.app_id, bookTracker);
      if (!applied.valid) {
        throw new Error(`前提のマニフェスト投入に失敗しました: ${JSON.stringify(applied.errors)}`);
      }
      const manifest = applied.manifest;

      const db = new Database(appDbPath(dataRoot, app.app_id));
      try {
        for (const tableId of ["_changelog", "_apps", "_ai_usage"] as const) {
          for (const result of [
            createRecord(db, manifest, tableId, { intent: "偽の履歴" }),
            updateRecord(db, manifest, tableId, "1", { intent: "改竄" }),
            deleteRecord(db, manifest, tableId, "1"),
          ]) {
            expect(result.ok).toBe(false);
            if (result.ok) {
              throw new Error(`${tableId} への書き込みが通ってしまいました。`);
            }
            expect(result.errors).toHaveLength(1);
            expect(result.errors[0]?.message).toContain("読み取り専用");
          }
        }
      } finally {
        db.close();
      }

      // 拒否されたので、履歴は第0行のままである(件数も内容も変わっていない)。
      expect(store.listChangelog(app.app_id)).toHaveLength(1);
    } finally {
      store.close();
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  test("createApp の変更は records.ts の読み取り専用判定に触れていない", () => {
    // 読み取り専用の判定は SYSTEM_TABLE_IDS ただ1箇所に由来し、create_app の追記経路とは
    // 無関係である。判定の出所が増えていない(= `_` 始まりのシステムテーブルは2つのまま)
    // ことを固定する。create_app が使う diff_id も `_` 始まりだが、それは changelog の
    // **行の値**であってテーブルIDではないので、この集合には現れない。
    expect(SYSTEM_TABLES.map((table) => table.id)).toEqual(["_apps", "_changelog", "_ai_usage"]);
  });
});
