/**
 * マイグレーション適用(V0-P2-T05 / V1-M1-T03)。
 *
 * ## v0(additive のみ)
 *
 * - `add_table` → `CREATE TABLE`
 * - `add_field` → `ALTER TABLE ... ADD COLUMN`
 * - 現行マニフェストと新マニフェストの比較 → 上記2つからなる `MigrationPlan` の導出
 *
 * 列追加が NOT NULL にならない(= 既存行があっても ADD COLUMN が通る)理由は
 * ddl.ts のモジュールコメントを参照。
 *
 * ## V1-M1(破壊的 op)—— かつてここに書かれていた禁止の解除
 *
 * **このモジュールは v0 では「破壊的変更(DROP / RENAME / 型変更)の呼び口はこの層に
 * 存在しない」と宣言し、実装が存在しないことによって禁止していた。** ADR-0010 が
 * ADR-0007 の門A を通したので、`remove_field` / `remove_table` / `change_table` /
 * `change_field` の4 op に**限って**実装する。**限定表(ADR-0010 §4)を破らないこと** ――
 * 特に限定1(op は4つだけ)と限定5(`NOT NULL` / `CHECK` / 外部キーを DDL に導入しない)。
 *
 * ### 破壊的な計画は「マニフェストの差分」からではなく「operations」から導く
 *
 * **これが本モジュールで最も重要な設計判断である。** マニフェストの差分だけを見ると、
 * フィールドの rename は「`a` が消えて `b` が増えた」に見える。**推論はデータ移行の
 * 指定を運べない** ―― 値を捨てるのか運ぶのかが決まらない。ADR-0010 §3a が
 * `patch_manifest` 案を却下した理由がそのまま当てはまり、§5d が
 * 「何が変わったかが op に明示されていれば意味論、op から復元するなら推論である」と
 * 線を引いている。
 *
 * したがって `planMigration` は **`operations` を受け取ったときだけ**破壊的な計画を
 * 導出する。**受け取らない呼び出し(= `applyManifest` の素の差し替え)の挙動は
 * v0 から1バイトも変わらない** ―― 破壊的な差分は今までどおり拒否される。
 * `apply_manifest` を破壊的にするかどうかは審査を受けていない(ADR-0010 限定1)。
 *
 * エラー方針: マニフェストの差分が語彙で表現できないことは、LLM が新マニフェストを
 * 直せば解決する種類の失敗なので統一形式の `ValidationResult` で返す。
 * 一方、SQL 実行の失敗(既存テーブルとの名前衝突など)はカーネル側のバグか
 * I/O 障害なので例外にする。
 */
import type { Database } from "bun:sqlite";
import { conversionLayer, type FieldConversion } from "./convert.ts";
import {
  addColumnSql,
  createTableSql,
  dropColumnSql,
  dropTableSql,
  renameColumnSql,
  renameTableSql,
} from "./ddl.ts";
import { invalid, type ValidationError, type ValidationResult, valid } from "./errors.ts";
import {
  type RebuildColumn,
  rebuildTable,
  supportsDropColumn,
  supportsRenameColumn,
} from "./rebuild-table.ts";
import type { Field, Manifest, Operation, ResourceId, Table, View } from "./types.ts";

/** 1件の列追加。 */
export type AddFieldStep = {
  /** 追加先テーブルのID。 */
  table: ResourceId;
  field: Field;
};

/**
 * 実行計画の1ステップ(V1-M1-T03)。**順序を持つ。**
 *
 * `add_tables` / `add_fields` の2配列では順序を表現できない ―― 「テーブルを rename して
 * から、その新しい名前にフィールドを足す」のような差分で、どちらを先に実行するかが
 * 決まらない。**op の順序は差分の意味の一部である**(`foldOperations` が先頭から順に
 * 畳み込むのと同じ理由)。
 */
export type MigrationStep =
  | { kind: "add_table"; table: Table }
  | { kind: "add_field"; table: ResourceId; field: Field }
  | { kind: "remove_table"; table: ResourceId }
  | { kind: "remove_field"; table: ResourceId; field: ResourceId; rest: Table }
  | { kind: "rename_table"; from: ResourceId; to: ResourceId }
  | { kind: "rename_field"; table: ResourceId; from: ResourceId; to: ResourceId }
  /** 層2(SQLite 列型が変わる)。テーブル再構築が要る(ADR-0010 §5a)。 */
  | {
      kind: "rebuild_field";
      table: ResourceId;
      from: Field;
      to: Field;
      /** 再構築後のテーブル定義(この列以外はそのまま運ぶ)。 */
      result: Table;
    };

/**
 * マイグレーションの実行計画。
 *
 * `add_tables` / `add_fields` は **v0 からの形をそのまま保つ**(呼び出し側と既存の
 * テストが読んでいる)。破壊的 op を含む計画では、加えて**順序付きの `steps`** が入る。
 *
 * **`steps` は任意である。** 存在しない場合(= `applyManifest` の素の差し替え)は
 * v0 と同じく `add_tables` → `add_fields` の順に実行する。**「キーが無い」ことが
 * 「破壊的な計画ではない」ことを表している。**
 */
export type MigrationPlan = {
  add_tables: Table[];
  add_fields: AddFieldStep[];
  steps?: MigrationStep[];
};

/**
 * `planMigration` の結果。失敗時は統一形式のエラー配列を返す。
 *
 * `conversions` は**適用前に全行走査すべき変換**の一覧である(ADR-0010 §6b)。
 * **計画を作った側が、何を検査すべきかも一緒に返す** ―― 呼び出し側が op を見て
 * 検査対象を組み立て直すと、計画と検査がずれる余地が生まれる。
 */
export type MigrationPlanResult =
  | {
      valid: true;
      plan: MigrationPlan;
      conversions?: FieldConversion[];
      /**
       * **後付け unique の既存重複検査の対象**(EC-G8 / ADR-0038)。`change_field` で
       * `unique` を `false → true` にした列について、**適用前のDBに既に重複値があれば
       * 差分全体を拒否する**(部分適用しない = ADR-0010 限定7 / 変換不能値と同型)。
       * `conversions` と同じく「計画を作った側が、何を検査すべきかも一緒に返す」——
       * 呼び出し側(`apply-diff.ts`)がスナップショット取得より前に readonly でDBを読む。
       *
       * `table` / `field` は**適用前の物理名**(rename されても走査は適用前のDBを読む)。
       * 新設テーブル・新設列(同じ差分で追加した列)は行が無いので載せない。
       * **新しい公開型を作らずインライン型で持つ**(Δ8 を発火させない。ADR-0038 S3)。
       */
      uniqueChecks?: {
        table: ResourceId;
        field: ResourceId;
        path: string;
        scope?: "owner";
      }[];
    }
  | { valid: false; errors: ValidationError[] };

/** テーブルを1つ作る(`add_table` 相当)。 */
export function applyAddTable(db: Database, table: Table): void {
  db.exec(createTableSql(table));
}

/** 列を1つ足す(`add_field` 相当)。既存行の当該列は NULL になる。 */
export function applyAddField(db: Database, tableId: ResourceId, field: Field): void {
  db.exec(addColumnSql(tableId, field));
}

/**
 * 実行計画を適用する。
 *
 * **全DDLを1トランザクションで実行する。** 途中で失敗した場合は、それまでの
 * CREATE TABLE / ADD COLUMN / DROP / RENAME / テーブル再構築も含めてすべて
 * ロールバックされ、スキーマは適用前の状態のまま残る。
 *
 * **層2 のテーブル再構築が途中で落ちても元テーブルが失われないのは、この
 * トランザクションと `rebuild-table.ts` の二重の担保による**(ADR-0010 §7 失敗6)。
 * ただし**マニフェスト(ファイル)はこのトランザクションの外にある** ―― そちらの
 * 原子性はスナップショット + 復元が担保する(§7b。M1 でこの構造は変えない)。
 */
export function applyMigrationPlan(db: Database, plan: MigrationPlan): void {
  db.transaction(() => {
    if (plan.steps !== undefined) {
      for (const step of plan.steps) {
        applyStep(db, step);
      }
      return;
    }
    // v0 経路(operations を伴わない差し替え)。順序も含めて挙動を変えない。
    for (const table of plan.add_tables) {
      applyAddTable(db, table);
    }
    for (const step of plan.add_fields) {
      applyAddField(db, step.table, step.field);
    }
  })();
}

/** 1ステップを適用する。呼び出し元が既にトランザクションを張っている前提。 */
function applyStep(db: Database, step: MigrationStep): void {
  switch (step.kind) {
    case "add_table":
      applyAddTable(db, step.table);
      return;
    case "add_field":
      applyAddField(db, step.table, step.field);
      return;
    case "remove_table":
      db.exec(dropTableSql(step.table));
      return;
    case "remove_field": {
      // ADR-0010 §5a: `ALTER TABLE ... DROP COLUMN` は SQLite 3.35 以降。
      // **可用性は実行環境に依存するので実行時に確かめ、使えなければ再構築へ落ちる。**
      if (supportsDropColumn(db)) {
        db.exec(dropColumnSql(step.table, step.field));
        return;
      }
      rebuildTable(db, step.table, step.rest, carryColumns(step.rest));
      return;
    }
    case "rename_field": {
      if (supportsRenameColumn(db)) {
        db.exec(renameColumnSql(step.table, step.from, step.to));
        return;
      }
      // 再構築経路でも同じ結果になる(列名だけを差し替えて値をそのまま運ぶ)。
      throw new Error(
        `列のリネームに対応していない SQLite です(ALTER TABLE ... RENAME COLUMN が使えません)。` +
          `テーブル "${step.table}" のフィールド "${step.from}" を "${step.to}" に変更できません。`,
      );
    }
    case "rename_table":
      db.exec(renameTableSql(step.from, step.to));
      return;
    case "rebuild_field": {
      const columns: RebuildColumn[] = step.result.fields.map((field) =>
        field.id === step.to.id
          ? { field, source: step.from.id, from: step.from }
          : { field, source: field.id },
      );
      rebuildTable(db, step.result.id, step.result, columns);
      return;
    }
  }
}

/** 再構築で「そのまま運ぶ」列の対応表を作る(列名も型も変えない)。 */
function carryColumns(table: Table): RebuildColumn[] {
  return table.fields.map((field) => ({ field, source: field.id }));
}

/**
 * 現行マニフェストと新マニフェストを比較して additive マイグレーションを適用する。
 *
 * 差分が additive でなければ**DBを一切変更せずに**統一形式エラーを返す
 * (計画の導出が先、適用はその後なので、拒否時にはDDLが1つも実行されない)。
 * V0-P2-T06 の `apply_manifest` はこの関数を使う。
 */
export function migrateSchema(db: Database, current: Manifest, next: Manifest): ValidationResult {
  const planned = planMigration(current, next);
  if (!planned.valid) {
    return invalid(planned.errors);
  }
  applyMigrationPlan(db, planned.plan);
  return valid();
}

/**
 * 現行マニフェストから新マニフェストへの差分が additive かを検査し、
 * additive なら実行計画を導出する。
 *
 * 破壊的と判定するもの(v0 の語彙に対応する op が存在しない変更):
 * - `app.id` の変更(別アプリになってしまう)
 * - テーブルの削除 / フィールドの削除
 * - フィールドの型変更、`reference_table` の変更
 * - `select` の選択肢の削除
 * - ビューの削除、ビューの `type` / `table` の変更(`update_view` の変更可能範囲外)
 *
 * **この判定は `operations` を伴わない経路(`planFromManifestDiff` = `applyManifest` を
 * マニフェスト直渡しで呼ぶ経路)のものである。** 「ビューの削除」は、`remove_view` op を
 * 使う経路(`planFromOperations`)では **ADR-0012 以降できる。** ここが破壊的と言い続けて
 * いるのは、operations が無いときは「何が起きたのか」をマニフェストの前後比較から
 * 推論するしかなく、**推論は削除の意図を運べない**からである(モジュール冒頭の設計判断)。
 * この経路の挙動は v0 から1バイトも変えていない。
 *
 * 破壊的と判定しないもの(意図的):
 * - 表示名(`app.name` / `table.name` / `field.name`)の変更 … データにもスキーマにも影響しない
 * - `select` の選択肢の追加 … 既存データはどれも有効なまま
 * - `required` の変更 … スキーマ(NOT NULL)に落としていないため DDL に影響がなく、
 *   required の強制はアプリ層(V0-P2-T07)の書き込み時ポリシー。既存データに対する
 *   遡及的な検査はこの層の責務ではないので、ここでは拒否しない
 * - ビューの `columns` / `sort` / `filter` / `fields` の変更 … `update_view` の範囲内
 */
export function planMigration(
  current: Manifest,
  next: Manifest,
  operations?: readonly Operation[],
): MigrationPlanResult {
  // **operations があるときだけ破壊的な計画を導出する**(モジュール冒頭の設計判断)。
  // 無いときの挙動は v0 から1バイトも変えない。
  if (operations !== undefined) {
    return planFromOperations(current, operations);
  }
  return planFromManifestDiff(current, next);
}

/**
 * `operations` から順序付きの実行計画を導出する(V1-M1-T03)。
 *
 * **現行マニフェストを起点に op を順に適用しながら、物理スキーマがどう動くかを追う。**
 * 追跡するのは3つ:
 *
 * 1. **現在のテーブル定義**(次の op が何を対象にしているかを解決するため)
 * 2. **適用前の物理テーブル名**(rename されても、事前検証は**適用前のDB**を読むため)
 * 3. **適用前の物理列名**(同上)
 *
 * 2 と 3 が要るのは ADR-0010 §6b が変換可否の判定を**スナップショットより前**に
 * 置いたからである。その時点でDBはまだ1バイトも変わっていないので、走査は
 * 「適用前の名前」で行わなければならない。
 *
 * **ここでは op の妥当性(対象が存在するか等)を検査しない。** それは
 * `foldOperations` が既に済ませており、二重に持つと文面が割れる。
 */
function planFromOperations(
  current: Manifest,
  operations: readonly Operation[],
): MigrationPlanResult {
  /** 現在のテーブル定義。キーは**現時点の**テーブルID。 */
  const tables = new Map<ResourceId, Table>(
    current.app.tables.map((table) => [table.id, structuredClone(table)]),
  );
  /** 現時点のテーブルID → 適用前の物理テーブル名(この差分で新設したなら `null`)。 */
  const originTable = new Map<ResourceId, ResourceId | null>(
    current.app.tables.map((table) => [table.id, table.id]),
  );
  /** 現時点の「テーブルID/フィールドID」→ 適用前の物理列名(新設なら `null`)。 */
  const originField = new Map<string, ResourceId | null>();
  for (const table of current.app.tables) {
    for (const field of table.fields) {
      originField.set(`${table.id}/${field.id}`, field.id);
    }
  }

  const steps: MigrationStep[] = [];
  const conversions: FieldConversion[] = [];
  const uniqueChecks: {
    table: ResourceId;
    field: ResourceId;
    path: string;
    /** **V4-M10-T07 / ADR-0078**: `unique: "owner"` の後付けは持ち主ごとに重複を数える。 */
    scope?: "owner";
  }[] = [];
  const addTables: Table[] = [];
  const addFields: AddFieldStep[] = [];

  for (const [index, operation] of operations.entries()) {
    const path = `/operations/${index}`;
    switch (operation.op) {
      case "add_view":
      case "update_view":
      case "remove_view":
      case "add_workflow":
      case "update_workflow":
      case "remove_workflow":
      case "add_function":
      case "update_function":
      case "remove_function":
      case "set_theme":
      // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11`】`case "set_user_kinds":` を取り除いた。**
      // **下の本文にある `set_user_kinds` の段落は `ADR-0248` 制定時の事実であり、
      // 1バイトも書き換えていない。** **代わりに立つのは `set_roles` である**(同じく
      // MigrationStep を1つも生まない)。
      case "set_roles":
        // ビューは SQLite スキーマに影響しない。**`remove_view`(ADR-0012)も同じ扱いで、
        // MigrationStep を1つも生まない** —— 消えるのはマニフェストの画面定義だけで、
        // テーブルも列もレコードも1バイトも動かない。だから変換不能値の事前検証
        // (§6b / `conversions`)にも1件も載らない。
        //
        // **ワークフロー3種(ADR-0013)も1バイトも動かさない。**動くのは
        // `app.workflows` の中身だけで、テーブルも列もレコードも増えも減りもしない
        // —— ワークフローが参照する `trigger.table` / `actions[].table` /
        // `history_table` は**どれもユーザが add_table で作った既存のテーブル**であり
        // (限定8: カーネルはテーブルを1本も自動生成しない)、ワークフローを足しても
        // 消してもそのテーブル自体には触らない。だからここも MigrationStep も
        // `conversions` も1件も生まない。
        //
        // **関数3種(ADR-0024)も同じく1バイトも動かさない。**動くのは `app.functions`
        // の中身だけで、テーブルも列もレコードも増えも減りもしない —— 関数が参照する
        // `input.table` / `input.view` はユーザが作った既存のテーブル / ビューであり、
        // 関数を足しても消してもそのテーブル自体には触らない(島の実行と output_table への
        // 書き込みは第2段 T03 の実行層の話であって、この畳み込み / マイグレーション層ではない)。
        //
        // **`set_theme`(ADR-0047。16種目)も1バイトも動かさない。**動くのは
        // `app.theme` の中身(スロットの実値と任意の由来)だけで、テーブルも列も
        // レコードも増えも減りもしない —— テーマは**どのテーブルもフィールドも
        // 参照しない**(値は色・長さ・書体の文字列だけであり、リソースIDを1つも持たない。
        // `origin` が持つのは別アプリのIDだが、カーネルはその実在を検証しない =
        // ADR-0047 限定7)。だからここも MigrationStep も `conversions` も1件も生まない。
        // **これは V3-M1-T03 の完了条件6 であり、`migrate.test.ts` が固定する。**
        //
        // **`set_user_kinds`(ADR-0248。17種目)も1バイトも動かさない。**動くのは
        // `app.user_kinds` の中身(種類の識別子と表示名)だけで、テーブルも列も
        // レコードも増えも減りもしない —— 宣言は**どのテーブルもフィールドも参照しない。**
        // **【`_auth_users` の `role` 列の `CHECK` も、この op では作り替わらない】** ——
        // `CHECK` を宣言値が通る形へ作り替えたのは `ADR-0233` / `V5-M17` であり、
        // その作り替えは **`AuthStore` を開いたとき**に1度だけ走る(`src/auth/store.ts`)。
        // **`set_user_kinds` は `_auth_users` に1バイトも触らない。**
        //
        // **`set_roles`(`V8-M16`。18種目)も1バイトも動かさない。**動くのは
        // `app.roles` の中身(役割の識別子と表示名)だけで、テーブルも列も
        // レコードも増えも減りもしない —— 宣言は**どのテーブルもフィールドも参照しない。**
        // **`_auth_users` の `role` 列にも、付与を持つ表にも1バイトも触らない**
        // (裁定 `R-3` の「`_auth_users.role` の列は1バイトも作り直さない」)。
        break;

      case "add_table": {
        const table = structuredClone(operation.table);
        tables.set(table.id, table);
        originTable.set(table.id, null);
        for (const field of table.fields) {
          originField.set(`${table.id}/${field.id}`, null);
        }
        addTables.push(table);
        steps.push({ kind: "add_table", table });
        break;
      }

      case "add_field": {
        const table = tables.get(operation.table);
        if (table === undefined) {
          break;
        }
        const field = structuredClone(operation.field);
        table.fields.push(field);
        originField.set(`${table.id}/${field.id}`, null);
        // **同じ差分の中で作ったテーブルなら DDL を出さない。** `add_table` のステップは
        // このテーブル定義を参照しており、実行時には最終形(この列を含む)になっている。
        // ここで `ADD COLUMN` も出すと `duplicate column name` で落ちる。
        // **v0 の `planFromManifestDiff` と同じ挙動である** —— あちらも新設テーブルの
        // フィールドは `add_tables` 側にだけ現れ、`add_fields` には載らない。
        if (originTable.get(table.id) === null) {
          break;
        }
        addFields.push({ table: table.id, field });
        steps.push({ kind: "add_field", table: table.id, field });
        break;
      }

      case "remove_table": {
        const table = tables.get(operation.table);
        if (table === undefined) {
          break;
        }
        const wasCreatedHere = originTable.get(table.id) === null;
        tables.delete(table.id);
        originTable.delete(table.id);
        for (const field of table.fields) {
          originField.delete(`${table.id}/${field.id}`);
        }
        if (wasCreatedHere) {
          // 同じ差分の中で作って同じ差分の中で消した。**DROP を出すのではなく、
          // 作る側のステップを取り下げる** —— 作ってから消すと、その一瞬だけ
          // テーブルが存在した痕跡が残る(トランザクション内なので外からは
          // 見えないが、DDL としては無駄である)。
          removeStepsFor(steps, table.id);
          removeAddTable(addTables, addFields, table.id);
          break;
        }
        steps.push({ kind: "remove_table", table: table.id });
        break;
      }

      case "remove_field": {
        const table = tables.get(operation.table);
        if (table === undefined) {
          break;
        }
        const sourceField = originField.get(`${table.id}/${operation.field}`) ?? null;
        table.fields = table.fields.filter((field) => field.id !== operation.field);
        originField.delete(`${table.id}/${operation.field}`);
        // 同じ差分の中で足した列を同じ差分の中で消した場合、`CREATE TABLE` /
        // `ADD COLUMN` 側が既に最終形なので DDL は要らない。
        if (originTable.get(table.id) === null) {
          break;
        }
        if (sourceField === null) {
          removeAddFieldStep(steps, addFields, table.id, operation.field);
          break;
        }
        steps.push({
          kind: "remove_field",
          table: table.id,
          field: sourceField,
          // DROP COLUMN が使えない環境での再構築に、残る列の定義が要る。
          rest: structuredClone(table),
        });
        break;
      }

      case "change_table": {
        const table = tables.get(operation.table);
        if (table === undefined) {
          break;
        }
        if (operation.changes.name !== undefined) {
          table.name = operation.changes.name;
        }
        const nextId = operation.changes.id;
        if (nextId === undefined || nextId === table.id) {
          break;
        }
        // ID を付け替える。**値は1バイトも変わらない**(ADR-0010 §5c)。
        const previousId = table.id;
        const origin = originTable.get(previousId) ?? null;
        tables.delete(previousId);
        originTable.delete(previousId);
        table.id = nextId;
        tables.set(nextId, table);
        originTable.set(nextId, origin);
        for (const field of table.fields) {
          const key = `${previousId}/${field.id}`;
          originField.set(`${nextId}/${field.id}`, originField.get(key) ?? null);
          originField.delete(key);
        }
        // 適用前のDBに存在しないテーブル(この差分で新設した)は rename しない。
        if (origin !== null) {
          steps.push({ kind: "rename_table", from: previousId, to: nextId });
        }
        break;
      }

      case "change_field": {
        const table = tables.get(operation.table);
        if (table === undefined) {
          break;
        }
        const fieldIndex = table.fields.findIndex((field) => field.id === operation.field);
        const from = table.fields[fieldIndex];
        if (from === undefined) {
          break;
        }
        const to = applyFieldChanges(from, operation.changes);
        table.fields[fieldIndex] = to;

        const originKey = `${table.id}/${operation.field}`;
        const sourceField = originField.get(originKey) ?? null;
        const sourceTable = originTable.get(table.id) ?? null;
        originField.delete(originKey);
        originField.set(`${table.id}/${to.id}`, sourceField);

        // --- 事前検証の対象(ADR-0010 §6b)---------------------------------
        // 値に影響しうる変更(型 / options / required / reference_table)が
        // 1つでもあれば、適用前のDBを全行走査する。**id / name だけの変更では
        // 走査しない** —— 値は1バイトも変わらないので走査する意味が無い(§5c)。
        if (sourceTable !== null && affectsValues(from, to)) {
          conversions.push({
            table: sourceTable,
            field: sourceField ?? to.id,
            source_missing: sourceField === null,
            from,
            to,
            path: `${path}/changes`,
          });
        }

        // --- 後付け unique の既存重複検査(EC-G8 / ADR-0038)-----------------
        // `unique` を明示的に `false → true` にしたときだけ、適用前のDBに既存重複が
        // 無いかを検査する対象に載せる(`conversions` と同じ pre-snapshot 経路に相乗り)。
        // **新設テーブル(sourceTable === null)・新設列(sourceField === null)は行が
        // 無いので載せない** —— 重複は原理的に存在しない。`changes.unique` が undefined
        // (unique を触っていない)や、既に unique だった列は載せない(§限定6)。
        // **【V4-M10-T07 / E-G66 / ADR-0078】** **値域が広がったので条件も広げた** ——
        // `false → true`(テーブル全体)だけでなく `→ "owner"`(持ち主ごと)も載せる。
        // **スコープが変わる後付け(`true → "owner"` / `"owner" → true`)も載せる** ——
        // 数える集合が変わるので、片方で通っていたデータがもう片方では重複でありうる。
        if (
          (operation.changes.unique === true || operation.changes.unique === "owner") &&
          from.unique !== operation.changes.unique &&
          sourceTable !== null &&
          sourceField !== null
        ) {
          uniqueChecks.push({
            table: sourceTable,
            field: sourceField,
            path: `${path}/changes`,
            ...(operation.changes.unique === "owner" ? { scope: "owner" as const } : {}),
          });
        }

        // --- DDL ------------------------------------------------------------
        if (sourceTable === null) {
          // この差分で新設したテーブルなので、`add_table` のステップが
          // 既に最終形を持っている。DDL は要らない。
          break;
        }
        if (conversionLayer(from.type, to.type) === 2) {
          // 層2: テーブル再構築。rename も同時に処理される。
          steps.push({
            kind: "rebuild_field",
            table: table.id,
            from: { ...from, id: sourceField ?? from.id },
            to,
            result: structuredClone(table),
          });
          break;
        }
        if (sourceField !== null && sourceField !== to.id) {
          steps.push({ kind: "rename_field", table: table.id, from: sourceField, to: to.id });
        }
        // 層1 かつ rename も無い場合、DDL は1文も発行されない(§5a 層1 = 無操作)。
        break;
      }

      default: {
        // **網羅性チェック**(V1-M2-T07 完了条件4 の読み替え)。この switch には
        // これまで `default` が無く、**case を書き忘れた op は黙って無視されていた**
        // —— 「物理スキーマに影響しないので意図して無視している」(上のビュー/
        // ワークフロー群)と「まだ書いていない」がコード上で区別できなかった。
        // `never` 代入を置くことで、前者は case に明記しない限り成立しなくなる。
        const exhaustive: never = operation;
        throw new Error(`未知の op です: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  return {
    valid: true,
    plan: { add_tables: addTables, add_fields: addFields, steps },
    conversions,
    uniqueChecks,
  };
}

/** 同じ差分の中で作って消したテーブルの、作る側のステップを取り下げる。 */
function removeStepsFor(steps: MigrationStep[], tableId: ResourceId): void {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step === undefined) {
      continue;
    }
    const target =
      step.kind === "add_table"
        ? step.table.id
        : step.kind === "rename_table"
          ? step.to
          : "table" in step
            ? step.table
            : undefined;
    if (target === tableId) {
      steps.splice(index, 1);
    }
  }
}

/** 上記に対応する、報告用配列側の取り下げ。 */
function removeAddTable(addTables: Table[], addFields: AddFieldStep[], tableId: ResourceId): void {
  const tableIndex = addTables.findIndex((table) => table.id === tableId);
  if (tableIndex !== -1) {
    addTables.splice(tableIndex, 1);
  }
  for (let index = addFields.length - 1; index >= 0; index -= 1) {
    if (addFields[index]?.table === tableId) {
      addFields.splice(index, 1);
    }
  }
}

/** 同じ差分の中で足して消した列の、足す側のステップを取り下げる。 */
function removeAddFieldStep(
  steps: MigrationStep[],
  addFields: AddFieldStep[],
  tableId: ResourceId,
  fieldId: ResourceId,
): void {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step?.kind === "add_field" && step.table === tableId && step.field.id === fieldId) {
      steps.splice(index, 1);
    }
  }
  for (let index = addFields.length - 1; index >= 0; index -= 1) {
    const entry = addFields[index];
    if (entry?.table === tableId && entry.field.id === fieldId) {
      addFields.splice(index, 1);
    }
  }
}

/** `changes` を反映した新しいフィールド定義を作る(元のオブジェクトは変えない)。 */
function applyFieldChanges(from: Field, changes: import("./types.ts").FieldChanges): Field {
  const type = changes.type ?? from.type;
  // unique(EC-G8 / ADR-0038)も運ぶ。`buildChangedField`(apply-diff.ts)と同型 ——
  // ここは計画導出用の `to` を組み立てるだけだが、両者の形を揃えておく。
  const base = {
    id: changes.id ?? from.id,
    name: changes.name ?? from.name,
    ...((changes.required ?? from.required) !== undefined
      ? { required: changes.required ?? from.required }
      : {}),
    ...((changes.unique ?? from.unique) !== undefined
      ? { unique: changes.unique ?? from.unique }
      : {}),
  };
  if (type === "select") {
    const options = changes.options ?? (from.type === "select" ? from.options : undefined) ?? [];
    return { ...base, type, options } as Field;
  }
  if (type === "reference") {
    const referenceTable =
      changes.reference_table ??
      (from.type === "reference" ? from.reference_table : undefined) ??
      "";
    return { ...base, type, reference_table: referenceTable } as Field;
  }
  return { ...base, type } as Field;
}

/** 値に影響しうる変更か(型 / options / required / reference_table のいずれかが変わったか)。 */
function affectsValues(from: Field, to: Field): boolean {
  if (from.type !== to.type) {
    return true;
  }
  if ((from.required ?? false) !== (to.required ?? false)) {
    return true;
  }
  if (from.type === "select" && to.type === "select") {
    return JSON.stringify(from.options) !== JSON.stringify(to.options);
  }
  if (from.type === "reference" && to.type === "reference") {
    return from.reference_table !== to.reference_table;
  }
  return false;
}

/** マニフェスト差分から additive な計画を導出する(v0 経路。挙動を変えない)。 */
function planFromManifestDiff(current: Manifest, next: Manifest): MigrationPlanResult {
  const errors: ValidationError[] = [];

  if (current.app.id !== next.app.id) {
    errors.push({
      path: "/app/id",
      message:
        `app.id を "${current.app.id}" から "${next.app.id}" へ変更することはできません。` +
        `app.id はアプリの同一性そのものであり、変更は別アプリへの差し替えになります。`,
      hint: `app.id は "${current.app.id}" のままにしてください。`,
    });
  }

  const nextTables = new Map(next.app.tables.map((t) => [t.id, t]));

  // テーブル削除の検出。
  const removedTables = current.app.tables.filter((t) => !nextTables.has(t.id));
  if (removedTables.length > 0) {
    errors.push({
      path: "/app/tables",
      message:
        `テーブル ${removedTables.map((t) => `"${t.id}"`).join(", ")} が新しいマニフェストから削除されています。` +
        `v0 では additive な変更(テーブル追加・フィールド追加)のみが許可されており、テーブルの削除はできません。`,
      hint: "削除したテーブルを新しいマニフェストに戻してください。使わなくなったテーブルは残したままにします。",
    });
  }

  const addTables: Table[] = [];
  const addFields: AddFieldStep[] = [];

  for (const [tableIndex, nextTable] of next.app.tables.entries()) {
    const currentTable = current.app.tables.find((t) => t.id === nextTable.id);
    if (currentTable === undefined) {
      addTables.push(nextTable);
      continue;
    }
    collectFieldChanges(currentTable, nextTable, tableIndex, addFields, errors);
  }

  collectViewChanges(current.app.views, next.app.views, errors);

  if (errors.length > 0) {
    return { valid: false, errors };
  }
  return { valid: true, plan: { add_tables: addTables, add_fields: addFields } };
}

/** 既存テーブルのフィールド差分を検査し、追加分を `addFields` に積む。 */
function collectFieldChanges(
  currentTable: Table,
  nextTable: Table,
  tableIndex: number,
  addFields: AddFieldStep[],
  errors: ValidationError[],
): void {
  const basePath = `/app/tables/${tableIndex}`;
  const nextFields = new Map(nextTable.fields.map((f) => [f.id, f]));

  const removed = currentTable.fields.filter((f) => !nextFields.has(f.id));
  if (removed.length > 0) {
    errors.push({
      path: `${basePath}/fields`,
      message:
        `テーブル "${nextTable.id}" のフィールド ${removed.map((f) => `"${f.id}"`).join(", ")} が削除されています。` +
        `v0 ではフィールドの削除はできません(既存レコードの値が失われるため)。`,
      hint: "削除したフィールドを戻してください。画面に出したくないだけなら、ビューの columns / fields から外します。",
    });
  }

  for (const [fieldIndex, nextField] of nextTable.fields.entries()) {
    const currentField = currentTable.fields.find((f) => f.id === nextField.id);
    if (currentField === undefined) {
      addFields.push({ table: nextTable.id, field: nextField });
      continue;
    }
    const fieldPath = `${basePath}/fields/${fieldIndex}`;

    if (currentField.type !== nextField.type) {
      errors.push({
        path: `${fieldPath}/type`,
        message:
          `フィールド "${nextTable.id}.${nextField.id}" の型を "${currentField.type}" から "${nextField.type}" へ変更することはできません。` +
          `v0 では型変更は破壊的変更として禁止されています(既存の値を変換できないため)。`,
        hint: `型を "${currentField.type}" に戻すか、別IDの新しいフィールドとして追加してください。`,
      });
      // 型が違う時点で options / reference_table の比較は意味を持たないので次へ。
      continue;
    }

    if (currentField.type === "select" && nextField.type === "select") {
      const kept = new Set(nextField.options);
      const dropped = currentField.options.filter((o) => !kept.has(o));
      if (dropped.length > 0) {
        errors.push({
          path: `${fieldPath}/options`,
          message:
            `フィールド "${nextTable.id}.${nextField.id}" の選択肢 ${dropped.map((o) => `"${o}"`).join(", ")} が削除されています。` +
            `既にその値を持つレコードが不正になるため、選択肢の削除はできません(追加は可能です)。`,
          hint: "削除した選択肢を options に戻してください。",
        });
      }
    }

    if (
      currentField.type === "reference" &&
      nextField.type === "reference" &&
      currentField.reference_table !== nextField.reference_table
    ) {
      errors.push({
        path: `${fieldPath}/reference_table`,
        message:
          `フィールド "${nextTable.id}.${nextField.id}" の参照先を "${currentField.reference_table}" から "${nextField.reference_table}" へ変更することはできません。` +
          `既存レコードが保持している参照先レコードIDが解決できなくなるためです。`,
        hint: `参照先を "${currentField.reference_table}" に戻すか、別IDの新しい reference フィールドとして追加してください。`,
      });
    }
  }
}

/**
 * ビュー差分を検査する。ビューは SQLite スキーマに影響しないため実行計画は生まないが、
 * 削除や `update_view` の範囲外の変更は additive ではないのでここで検出する。
 */
function collectViewChanges(
  currentViews: View[],
  nextViews: View[],
  errors: ValidationError[],
): void {
  const nextById = new Map(nextViews.map((v) => [v.id, v]));

  const removed = currentViews.filter((v) => !nextById.has(v.id));
  if (removed.length > 0) {
    errors.push({
      path: "/app/views",
      message:
        `ビュー ${removed.map((v) => `"${v.id}"`).join(", ")} が新しいマニフェストから削除されています。` +
        `マニフェストを直接渡す経路では、ビューの削除を表現できません` +
        `(前後の比較からは「消したい」のか「書き漏らした」のかを区別できないためです)。`,
      hint:
        `ビューを消したいのであれば、差分パッチの remove_view op を使ってください` +
        `(${removed.map((v) => `{ "op": "remove_view", "view": "${v.id}" }`).join(" / ")})。` +
        `消すつもりが無かったのであれば、削除したビューを新しいマニフェストに戻してください。`,
    });
  }

  /*
   * **下の2つのメッセージはキー名を直書きしている。**
   * **`$defs/view_changes` のキー集合と1対1で一致していなければならない** ——
   * V3-M2-T01 の時点でプリセット7キーが増え、`name / columns / sort / filter / fields`
   * だけを挙げていた旧文言は嘘になった(`docs/plan/v3/records/v3-m2.md` §2-10 (B))。
   * **以後、黙って古くなることは無い** —— `src/kernel/migrate.test.ts` の
   * 「マニフェスト直渡し経路のエラー文言が view_changes のキー集合と一致する」が
   * スキーマから読んだキー集合と突き合わせる。
   *
   * **【V3-M5-T02 / ADR-0055 改訂1 で2度目の追随をした】** 逃げ道の参照 `custom_css` が
   * 13キー目に増えたので、下の2つの文言も 12 → 13 に直した。**仕掛けは意図どおり働いた**
   * —— 黙って古くならず、`migrate.test.ts` が赤で止めた。**直したのは文字列だけで、
   * `planMigration` の振る舞いは1バイトも変えていない**(判定: 索引 `v3-m5-gate-a.md` §6-2)。
   *
   * **【`V4-M10-T45` / `E-G12` / `ADR-0084` 限定6 で3度目の追随をした】** 掲載の可否
   * `menu_listed` が14キー目に増えたので、下の2つの文言も 13 → 14 に直した。
   * **仕掛けは3度目も意図どおり働いた** —— 黙って古くならず、`migrate.test.ts` が赤で
   * 止めた。**直したのは文字列だけで、`planMigration` の振る舞いは1バイトも変えていない。**
   *
   * **【`V4-M18-T03` / `ADR-0095` 限定6 で4度目の追随をした】** 重ねて出す宣言 `modal` が
   * 17キー目に増えたので、下の2つの文言も `preset_list_shape` の後ろに `/ modal` を足した。
   * **仕掛けは4度目も意図どおり働いた** —— 黙って古くならず、`migrate.test.ts` が赤で
   * 止めた。**直したのは文字列だけで、`planMigration` の振る舞いは1バイトも変えていない。**
 
   *
   * **【`V4-M22-T01` / `ADR-0112` 限定2 で5度目の追随をした】** 検索の対象にする列
   * `search_fields` が18キー目に増えたので、下の2つの文言も `modal` の後ろに
   * `/ search_fields` を足した。**仕掛けは5度目も意図どおり働いた** —— 黙って古くならず、
   * `migrate.test.ts` が赤で止めた。**直したのは文字列だけで、`planMigration` の振る舞いは
   * 1バイトも変えていない。**
 
   *
   * **【`V4-M22-T05` / `ADR-0113` 限定2 で6度目の追随をした】** 1ページの件数
   * `page_size` が19キー目に増えたので、下の2つの文言も `search_fields` の後ろに
   * `/ page_size` を足した。**仕掛けは6度目も意図どおり働いた。****直したのは文字列だけで、
   * `planMigration` の振る舞いは1バイトも変えていない。**
   *
   * **【`V4-M19-T03` / `ADR-0118` 限定1 で7度目の追随をした】** 画面の詰まり具合
   * `preset_density` が20キー目に増えたので、下の2つの文言も `page_size` の後ろに
   * `/ preset_density` を足した。**仕掛けは7度目も意図どおり働いた。****直したのは
   * 文字列だけで、`planMigration` の振る舞いは1バイトも変えていない。**
   *
   * **【`V4-M20-T04` / `ADR-0102` 限定1 で8度目の追随をした】** 保存後の行き先
   * `after_save` が21キー目に増えたので、下の2つの文言も `preset_density` の後ろに
   * `/ after_save` を足した。**仕掛けは8度目も意図どおり働いた。****直したのは
   * 文字列だけで、`planMigration` の振る舞いは1バイトも変えていない。**
   *
   * **【`V4-M23-T01` / `ADR-0104` 限定1 で9度目の追随をした】** 合計を出す列
   * `sum_field` が22キー目に増えたので、下の2つの文言も `after_save` の後ろに
   * `/ sum_field` を足した。**仕掛けは9度目も意図どおり働いた。****直したのは
   * 文字列だけで、`planMigration` の振る舞いは1バイトも変えていない。**
   *
   * **【`V6-M2-T02` / `K-G3` / `ADR-0289` 限定1 で10度目の追随をした】** 参照項目の選び方の
   * 入力画面ごとの上書き `reference_pickers` が24キー目に増えたので、下の2つの文言も
   * `actions` の後ろに `/ reference_pickers` を足した。**仕掛けは10度目も意図どおり働いた。**
   * **直したのは文字列だけで、`planMigration` の振る舞いは1バイトも変えていない。**
   *
   * **【2026-08-20。`V10-M1-T02` / `NV-G4` / `ADR-0359` §Decision 2 で11度目の追随をした】**
   * 削除が成立したあとの行き先 `after_delete` が26キー目に増えたので、下の2つの文言も
   * `report` の後ろに `/ after_delete` を足した。**仕掛けは11度目も意図どおり働いた。**
   * **直したのは文字列だけで、`planMigration` の振る舞いは1バイトも変えていない。**
   * **`after_delete` を書けるのは `detail_view` だけである**(限定2)——
   * **この文言は `view_changes` の全量を述べるものであり、種別ごとの可否は述べない
   * (`report` / `modal` / `sum_field` などが既にそうである)。**
   *
   * **【2026-08-20。`V10-M4-T01` / `NV-G9` / `ADR-0359` §Decision 2 で12度目の追随をした】**
   * 一続きの流れの中の段 `flow` が27キー目に増えたので、下の2つの文言も
   * `after_delete` の後ろに `/ flow` を足した。**仕掛けは12度目も意図どおり働いた。**
   * **直したのは文字列だけで、`planMigration` の振る舞いは1バイトも変えていない。**
   * **`flow` を書けるのは `list_view` / `form` / `detail_view` の3種別である**
   * (`report_view` には書けない)—— **上と同じく、この文言は種別ごとの可否を述べない。**
   */
  for (const [index, nextView] of nextViews.entries()) {
    const currentView = currentViews.find((v) => v.id === nextView.id);
    if (currentView === undefined) {
      continue; // add_view 相当。スキーマ変更を伴わないので計画には載せない。
    }
    if (currentView.type !== nextView.type) {
      errors.push({
        path: `/app/views/${index}/type`,
        message:
          `ビュー "${nextView.id}" の type を "${currentView.type}" から "${nextView.type}" へ変更することはできません。` +
          `update_view で変更できるのは name / columns / sort / filter / fields / preset_column_align / preset_column_width / preset_pager_position / preset_label_placement / preset_field_columns / preset_image_size / preset_text_preview / custom_css / menu_listed / field_groups / preset_list_shape / modal / search_fields / page_size / preset_density / after_save / sum_field / actions / reference_pickers / report / after_delete / flow のみです。`,
        hint: `type を "${currentView.type}" に戻すか、別IDの新しいビューとして追加してください。`,
      });
      continue;
    }
    if (currentView.table !== nextView.table) {
      errors.push({
        path: `/app/views/${index}/table`,
        message:
          `ビュー "${nextView.id}" の対象テーブルを "${currentView.table}" から "${nextView.table}" へ変更することはできません。` +
          `update_view で変更できるのは name / columns / sort / filter / fields / preset_column_align / preset_column_width / preset_pager_position / preset_label_placement / preset_field_columns / preset_image_size / preset_text_preview / custom_css / menu_listed / field_groups / preset_list_shape / modal / search_fields / page_size / preset_density / after_save / sum_field / actions / reference_pickers / report / after_delete / flow のみです。`,
        hint: `table を "${currentView.table}" に戻すか、別IDの新しいビューとして追加してください。`,
      });
    }
  }
}
