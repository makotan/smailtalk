import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APPLIED_MANIFEST_PATH_NOTE,
  annotateAppliedManifestError,
  applyDiff,
  DESTRUCTIVE_NO_CASCADE_NOTE,
  foldOperations,
} from "./apply-diff.ts";
import { applyManifest } from "./apply-manifest.ts";
import { createApp } from "./create-app.ts";
import { dryRunDiff } from "./dry-run.ts";
import type { ValidationError } from "./errors.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { createRecord, listRecords, type RecordRow } from "./records.ts";
import { listSnapshots } from "./snapshot.ts";
import { appDbPath, appManifestPath, kernelDbPath, snapshotDir } from "./storage-paths.ts";
import type { Diff, Manifest } from "./types.ts";
import { undo } from "./undo.ts";

const APP_ID = "book-tracker";

let dataRoot: string;
let store: KernelMetaStore;

/** 蔵書管理アプリの初期マニフェスト(テーブル1・ビュー2)。 */
function baseManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "蔵書管理",
      tables: [
        {
          id: "books",
          name: "本",
          fields: [
            { id: "title", name: "タイトル", type: "text", required: true },
            { id: "memo", name: "メモ", type: "long_text" },
          ],
        },
      ],
      views: [
        { id: "book-list", type: "list_view", table: "books", columns: ["title"] },
        { id: "book-form", type: "form", table: "books", fields: ["title", "memo"] },
      ],
    },
  };
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-apply-diff-"));
  store = KernelMetaStore.open(dataRoot);
  createApp(store, "蔵書管理", { app_id: APP_ID });
  const applied = applyManifest(dataRoot, APP_ID, baseManifest());
  if (!applied.valid) {
    throw new Error("テスト前提の初期マニフェスト投入に失敗しました。");
  }
});

afterEach(async () => {
  store.close();
  await rm(dataRoot, { recursive: true, force: true });
});

/** ディスク上の manifest.json をそのまま読む(applyDiff の戻り値ではなく永続化結果を見る)。 */
function readManifestFile(): Manifest {
  return JSON.parse(readFileSync(appManifestPath(dataRoot, APP_ID), "utf-8")) as Manifest;
}

/** manifest.json のバイト列(不変アサート用)。 */
function readManifestText(): string {
  return readFileSync(appManifestPath(dataRoot, APP_ID), "utf-8");
}

/** app.sqlite の実スキーマ(テーブル→列名の並び)を PRAGMA で読む。 */
function readSchema(): Record<string, string[]> {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    const tables = db
      .query<{ name: string }, []>(
        `SELECT "name" FROM "sqlite_master" WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%' ORDER BY "name"`,
      )
      .all()
      .map((row) => row.name);
    const schema: Record<string, string[]> = {};
    for (const table of tables) {
      schema[table] = db
        .query<{ name: string }, []>(`PRAGMA table_info("${table}")`)
        .all()
        .map((row) => row.name);
    }
    return schema;
  } finally {
    db.close();
  }
}

/** アプリDBを開いて処理する(呼び出しごとに閉じる)。 */
function withDb<T>(fn: (db: Database) => T): T {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** books テーブルへレコードを1件入れる。 */
function seedBook(input: Record<string, unknown>): RecordRow {
  return withDb((db) => {
    const result = createRecord(db, readManifestFile(), "books", input);
    if (!result.ok) {
      throw new Error(`テスト前提のレコード投入に失敗しました: ${JSON.stringify(result.errors)}`);
    }
    return result.value;
  });
}

/** books テーブルの全件を _id 昇順で読む。 */
function allBooks(): RecordRow[] {
  return withDb((db) => {
    const result = listRecords(db, readManifestFile(), "books");
    if (!result.ok) {
      throw new Error(`レコード一覧に失敗しました: ${JSON.stringify(result.errors)}`);
    }
    return [...result.value].sort((a, b) => a._id.localeCompare(b._id));
  });
}

const ADD_FIELD_DIFF: Diff = {
  diff_id: "d-0002",
  intent: "読了日で並べ替えたいという要望",
  operations: [
    {
      op: "add_field",
      table: "books",
      field: { id: "finished_at", name: "読了日", type: "date" },
    },
    {
      op: "update_view",
      view: "book-list",
      changes: {
        columns: ["title", "finished_at"],
        sort: { field: "finished_at", order: "desc" },
      },
    },
  ],
};

describe("foldOperations(現行マニフェスト + operations → 次のマニフェスト)", () => {
  test("4種の op を畳み込んだ次のマニフェストを返す", () => {
    const result = foldOperations(baseManifest(), [
      {
        op: "add_table",
        table: {
          id: "authors",
          name: "著者",
          fields: [{ id: "full_name", name: "氏名", type: "text", required: true }],
        },
      },
      {
        op: "add_field",
        table: "books",
        field: { id: "author", name: "著者", type: "reference", reference_table: "authors" },
      },
      { op: "add_view", view: { id: "book-detail", type: "detail_view", table: "books" } },
      { op: "update_view", view: "book-list", changes: { columns: ["title", "author"] } },
    ]);

    expect(result.valid).toBe(true);
    if (!result.valid) {
      return;
    }
    expect(result.manifest.app.tables.map((t) => t.id)).toEqual(["books", "authors"]);
    expect(result.manifest.app.tables[0]?.fields.map((f) => f.id)).toEqual([
      "title",
      "memo",
      "author",
    ]);
    expect(result.manifest.app.views.map((v) => v.id)).toEqual([
      "book-list",
      "book-form",
      "book-detail",
    ]);
    const listView = result.manifest.app.views[0];
    expect(listView?.type).toBe("list_view");
    expect(listView && "columns" in listView ? listView.columns : undefined).toEqual([
      "title",
      "author",
    ]);
  });

  test("現行マニフェストを書き換えない(純粋関数)", () => {
    const current = baseManifest();
    const before = JSON.stringify(current);
    foldOperations(current, [
      { op: "add_field", table: "books", field: { id: "isbn", name: "ISBN", type: "text" } },
    ]);
    expect(JSON.stringify(current)).toBe(before);
  });

  test("既存テーブルへの add_table は operation を指す JSON Pointer で拒否される", () => {
    const result = foldOperations(baseManifest(), [
      { op: "add_field", table: "books", field: { id: "isbn", name: "ISBN", type: "text" } },
      { op: "add_table", table: { id: "books", name: "本(重複)", fields: [] } },
    ]);

    expect(result.valid).toBe(false);
    if (result.valid) {
      return;
    }
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.path).toBe("/operations/1/table/id");
    expect(result.errors[0]?.message).toContain("books");
    expect(result.errors[0]?.hint).toBeDefined();
  });

  test("既存フィールドへの add_field は拒否される", () => {
    const result = foldOperations(baseManifest(), [
      { op: "add_field", table: "books", field: { id: "title", name: "題名", type: "text" } },
    ]);

    expect(result.valid).toBe(false);
    if (result.valid) {
      return;
    }
    expect(result.errors[0]?.path).toBe("/operations/0/field/id");
    expect(result.errors[0]?.message).toContain("title");
  });

  test("存在しないテーブルへの add_field は allowed_values 付きで拒否される", () => {
    const result = foldOperations(baseManifest(), [
      { op: "add_field", table: "novels", field: { id: "isbn", name: "ISBN", type: "text" } },
    ]);

    expect(result.valid).toBe(false);
    if (result.valid) {
      return;
    }
    expect(result.errors[0]?.path).toBe("/operations/0/table");
    expect(result.errors[0]?.allowed_values).toEqual(["books"]);
  });

  test("既存IDへの add_view は拒否される", () => {
    const result = foldOperations(baseManifest(), [
      { op: "add_view", view: { id: "book-list", type: "detail_view", table: "books" } },
    ]);

    expect(result.valid).toBe(false);
    if (result.valid) {
      return;
    }
    expect(result.errors[0]?.path).toBe("/operations/0/view/id");
  });

  test("存在しないビューへの update_view は allowed_values 付きで拒否される", () => {
    const result = foldOperations(baseManifest(), [
      { op: "update_view", view: "nope", changes: { columns: ["title"] } },
    ]);

    expect(result.valid).toBe(false);
    if (result.valid) {
      return;
    }
    expect(result.errors[0]?.path).toBe("/operations/0/view");
    expect(result.errors[0]?.allowed_values).toEqual(["book-list", "book-form"]);
  });

  test("ビュー種別が持てない項目の update_view は拒否される(list_view に fields)", () => {
    const result = foldOperations(baseManifest(), [
      { op: "update_view", view: "book-list", changes: { fields: ["title"] } },
    ]);

    expect(result.valid).toBe(false);
    if (result.valid) {
      return;
    }
    expect(result.errors[0]?.path).toBe("/operations/0/changes/fields");
    // **V3-M2-T01(ADR-0050)で list_view の許可キーに5つのプリセットが増えた。**
    // `CHANGE_KEYS_BY_VIEW_TYPE` の実装がそのまま `allowed_values` に出るので、
    // 期待値もその全量である(親切なエラーの中身が黙って古くならないように固定する)。
    // **V3-M5-T02(ADR-0055 改訂1)で逃げ道の参照 custom_css が3種すべてに増えた。**
    expect(result.errors[0]?.allowed_values).toEqual([
      "name",
      "columns",
      "sort",
      "filter",
      "preset_column_align",
      "preset_column_width",
      "preset_pager_position",
      "preset_image_size",
      "preset_text_preview",
      // **V4-M16-T13(`P-G24` の (C) 側 / ADR-0093 限定2)で一覧の器の形 preset_list_shape が
      // list_view にだけ増えた** —— **門A の本審査(`V4-M14` 本審査② の単位11。
      // 判定 = 限定採用)を通った増分である。** form / detail_view の同じ列挙には現れない。
      "preset_list_shape",
      // **V4-M22-T01(`E-G7` の (C) 側 / ADR-0112 限定2・限定3)で検索の対象にする列
      // search_fields が list_view にだけ増えた** —— **門A の本審査(V4-M22 単位A。
      // 判定 = 限定採用)を通った増分である。** form / detail_view の同じ列挙には現れない。
      "search_fields",
      // **【V4-M22-T05 / ADR-0113 限定2・限定7 で更新した】** `page_size`(1ページに出す
      // 件数)が list_view にだけ増えた —— 門A の本審査(V4-M22 単位C。**4回目の審査**。
      // 判定 = 限定採用)を通った増分である。form / detail_view の同じ列挙には現れない。
      "page_size",
      // **【V4-M23-T01 / ADR-0104 限定1・限定3 で更新した】** 28キー目 `sum_field`
      // (合計を出す列)が list_view にだけ増えた —— 門A の本審査(判定 = 限定採用)を
      // 通った増分である。**`list_view` でだけ書ける** —— form / detail_view の同じ列挙には
      // 現れない。
      "sum_field",
      // **【V4-M19-T03 / ADR-0118 限定1・限定6 で更新した】** `preset_density`(画面の
      // 詰まり具合)が3種すべてに増えた —— 門A の本審査(V4-M19 単位C。2回目の審査。
      // 判定 = 限定採用)を通った増分である。**本 ADR の増分ではない。**
      "preset_density",
      "custom_css",
      // **V4-M10-T45(E-G12 / ADR-0084 限定6)で掲載の可否 menu_listed が3種すべてに増えた。**
      "menu_listed",
      // **【V5-M21-T03 / `L-G4` / ADR-0172 限定1・限定4 で更新した】** 23キー目 `actions`
      // (操作起点)が `list_view` と `detail_view` に増えた —— 門A の本審査(`V5-M20`
      // 面1 の `L-G4`。判定 = 限定採用)を通った増分である。**form の同じ列挙には現れない**
      // (`ADR-0172` 限定4)。
      "actions",
      // **【2026-08-20。`V10-M4-T01` / `NV-G9` / `ADR-0359` §4b 限定1・限定3 /
      // `ADR-0360` 限定2 で足した】** `flow`(一続きの流れの中の段)が `list_view` の受付表に
      // 加わった —— 門A の本審査(`V10-M0` 群B。判定 = 限定採用)を通った増分である。
      // **`list_view` / `form` / `detail_view` の3種別に入る**(`after_delete` より
      // 波及が広い)。**`report_view` の同じ列挙には現れない**(`V10-M4` の決1。
      // **集計表は流れの段になれない**)。
      // **`schemas/diff.schema.json` の `view_changes` にも同名を1本足してある。**
      "flow",
    ]);
  });

  /*
   * detail_view の fields は **後からも**変えられる(V1-M0-T09 の追補)。
   *
   * V1-M0-T09 本体は `CHANGE_KEYS_BY_VIEW_TYPE.detail_view` を `[]` のままにしたため、
   * `fields` を指定できるのは `add_view` の時だけだった(記録 §6-2 の限界2)。
   * `DIFF_OPS` は増やしていない —— `update_view` は既存の op である。
   */
  test("update_view で detail_view の fields を差し替えられる", () => {
    const current = baseManifest();
    current.app.views.push({
      id: "book-detail",
      type: "detail_view",
      table: "books",
      fields: ["title"],
    });
    const result = foldOperations(current, [
      { op: "update_view", view: "book-detail", changes: { fields: ["memo", "title"] } },
    ]);

    expect(result.valid).toBe(true);
    if (!result.valid) {
      return;
    }
    const view = result.manifest.app.views[2];
    expect(view?.type).toBe("detail_view");
    expect(view && "fields" in view ? view.fields : undefined).toEqual(["memo", "title"]);
  });

  test("fields を持たない detail_view にも update_view で fields を足せる", () => {
    const current = baseManifest();
    current.app.views.push({ id: "book-detail", type: "detail_view", table: "books" });
    const result = foldOperations(current, [
      { op: "update_view", view: "book-detail", changes: { fields: ["memo"] } },
    ]);

    expect(result.valid).toBe(true);
    if (!result.valid) {
      return;
    }
    const view = result.manifest.app.views[2];
    expect(view && "fields" in view ? view.fields : undefined).toEqual(["memo"]);
  });

  test("detail_view が持てない項目の update_view は allowed_values 付きで拒否される", () => {
    const current = baseManifest();
    current.app.views.push({ id: "book-detail", type: "detail_view", table: "books" });
    const result = foldOperations(current, [
      { op: "update_view", view: "book-detail", changes: { columns: ["title"] } },
    ]);

    expect(result.valid).toBe(false);
    if (result.valid) {
      return;
    }
    expect(result.errors[0]?.path).toBe("/operations/0/changes/columns");
    // **V3-M5-T02(ADR-0055 改訂1)で逃げ道の参照 custom_css が3種すべてに増えた。**
    expect(result.errors[0]?.allowed_values).toEqual([
      "name",
      "fields",
      "preset_label_placement",
      "preset_field_columns",
      "preset_image_size",
      "preset_text_preview",
      "custom_css",
      // **V4-M10-T45(E-G12 / ADR-0084 限定6)で掲載の可否 menu_listed が3種すべてに増えた。**
      "menu_listed",
      // **V4-M16-T12(`P-G17` の (C) 側 / ADR-0092 限定2)で項目のまとまり field_groups が
      // detail_view にだけ増えた** —— **門A の本審査(`V4-M14` 本審査② の単位9。
      // 判定 = 限定採用)を通った増分である。** `list_view` / form の同じ列挙には現れない。
      "field_groups",
      // **【V4-M19-T03 / ADR-0118 限定1・限定6 で更新した】** `preset_density`(画面の
      // 詰まり具合)が3種すべてに増えた —— 門A の本審査(V4-M19 単位C。2回目の審査。
      // 判定 = 限定採用)を通った増分である。**本 ADR の増分ではない。**
      "preset_density",
      // **【V5-M21-T03 / `L-G4` / ADR-0172 限定1・限定4 で更新した】** 23キー目 `actions`
      // (操作起点)が `list_view` と `detail_view` に増えた —— 門A の本審査(`V5-M20`
      // 面1 の `L-G4`。判定 = 限定採用)を通った増分である。**form の同じ列挙には現れない**
      // (`ADR-0172` 限定4)。
      "actions",
      // **【2026-08-20。`V10-M1-T01` / `NV-G3a` / `ADR-0358` 限定1・限定8 で足した】**
      // `after_save`(この画面の書換ボタンが成立したあとの行き先)が `detail_view` の
      // 受付表にも加わった —— 門A の本審査(`V10-M0` 群A。判定 = 限定採用)を通った
      // 増分である。**`list_view` / `report_view` の同じ列挙には今日も現れない**
      // (限定1。`NV-G3b` = **却下**)。**`schemas/diff.schema.json` には1バイトも
      // 触っていない** —— **`after_save` は着手前から `view_changes` に在り、
      // 変えたのは `apply-diff.ts` の受付表(`CHANGE_KEYS_BY_VIEW_TYPE`)だけである。**
      "after_save",
      // **【2026-08-20。`V10-M1-T02` / `NV-G4` / `ADR-0359` §4a 限定2・限定10 で足した】**
      // `after_delete`(削除が成立したあとの行き先)が `detail_view` の受付表に加わった
      // —— 門A の本審査(`V10-M0` 群A。判定 = 限定採用)を通った増分である。
      // **`list_view` / `form` / `report_view` の同じ列挙には現れない**(限定2)。
      // **`schemas/diff.schema.json` の `view_changes` にも同名を1本足してある**
      // (`ADR-0359` §Decision 2)—— **`after_save` のときと違い、こちらは差分スキーマにも
      // 触っている。**
      "after_delete",
      // **【2026-08-20。`V10-M4-T01` / `NV-G9` / `ADR-0359` §4b 限定1・限定3 /
      // `ADR-0360` 限定2 で足した】** `flow`(一続きの流れの中の段)が `detail_view` の受付表に
      // 加わった —— 門A の本審査(`V10-M0` 群B。判定 = 限定採用)を通った増分である。
      // **`list_view` / `form` / `detail_view` の3種別に入る**(`after_delete` より
      // 波及が広い)。**`report_view` の同じ列挙には現れない**(`V10-M4` の決1。
      // **集計表は流れの段になれない**)。
      // **`schemas/diff.schema.json` の `view_changes` にも同名を1本足してある。**
      "flow",
    ]);
  });

  /*
   * ===========================================================================
   * V3-M2-T01(D-G4 / ADR-0050): 画面ごとのプリセット
   * ===========================================================================
   *
   * **軸ごとに独立したキーにした**のは、1キー案(`presets` 1つ)だと
   * `applyViewChanges` がキー単位の全置換なので「1軸だけ書くと他軸が黙って既定へ戻る」
   * からである(ADR-0050 §2 (c) / 審査記録 §6-2)。**その独立性をここで固定する** ——
   * 独立でなくなった瞬間に憲法6(できないことは正直に言う)に触れる挙動が生まれる。
   */
  test("update_view で list_view のプリセットを差し替えられる(ADR-0050)", () => {
    const result = foldOperations(baseManifest(), [
      {
        op: "update_view",
        view: "book-list",
        changes: {
          preset_column_align: { title: "center" },
          preset_column_width: { title: "wide" },
          preset_pager_position: "both",
          preset_image_size: "thumbnail",
          preset_text_preview: "long",
        },
      },
    ]);

    expect(result.valid, JSON.stringify(result)).toBe(true);
    if (!result.valid) {
      return;
    }
    expect(result.manifest.app.views[0]).toEqual({
      id: "book-list",
      type: "list_view",
      table: "books",
      columns: ["title"],
      preset_column_align: { title: "center" },
      preset_column_width: { title: "wide" },
      preset_pager_position: "both",
      preset_image_size: "thumbnail",
      preset_text_preview: "long",
    });
  });

  test("update_view で detail_view のプリセットを差し替えられる(ADR-0050)", () => {
    const current = baseManifest();
    current.app.views.push({ id: "book-detail", type: "detail_view", table: "books" });
    const result = foldOperations(current, [
      {
        op: "update_view",
        view: "book-detail",
        changes: {
          preset_label_placement: "stacked",
          preset_field_columns: 2,
          preset_image_size: "medium",
          preset_text_preview: "short",
        },
      },
    ]);

    expect(result.valid, JSON.stringify(result)).toBe(true);
    if (!result.valid) {
      return;
    }
    expect(result.manifest.app.views[2]).toEqual({
      id: "book-detail",
      type: "detail_view",
      table: "books",
      preset_label_placement: "stacked",
      preset_field_columns: 2,
      preset_image_size: "medium",
      preset_text_preview: "short",
    });
  });

  test("1軸だけ書いた update_view は他の軸を1つも消さない(軸ごとの独立。ADR-0050 §2 (c))", () => {
    const current = baseManifest();
    const first = foldOperations(current, [
      {
        op: "update_view",
        view: "book-list",
        changes: {
          preset_column_align: { title: "right" },
          preset_column_width: { title: "narrow" },
          preset_pager_position: "top",
          preset_image_size: "original",
          preset_text_preview: "short",
        },
      },
    ]);
    expect(first.valid).toBe(true);
    if (!first.valid) {
      return;
    }

    // **寄せだけ直す。** 幅・ページャ位置・画像サイズ・切り詰め長は書かない。
    const second = foldOperations(first.manifest, [
      { op: "update_view", view: "book-list", changes: { preset_column_align: { title: "left" } } },
    ]);
    expect(second.valid, JSON.stringify(second)).toBe(true);
    if (!second.valid) {
      return;
    }
    const view = second.manifest.app.views[0] as Record<string, unknown>;
    expect(view.preset_column_align).toEqual({ title: "left" });
    // **黙って既定へ戻っていない**(1キー案を採っていたらここが落ちる)。
    expect(view.preset_column_width).toEqual({ title: "narrow" });
    expect(view.preset_pager_position).toBe("top");
    expect(view.preset_image_size).toBe("original");
    expect(view.preset_text_preview).toBe("short");
    // 既存キー(columns / name)も巻き添えにならない。
    expect(view.columns).toEqual(["title"]);
  });

  test("プリセットの update_view は既存の columns / sort / filter を1つも動かさない", () => {
    const current = baseManifest();
    const listView = current.app.views[0] as Record<string, unknown>;
    listView.sort = { field: "title", order: "asc" };
    listView.name = "本の一覧";
    const result = foldOperations(current, [
      { op: "update_view", view: "book-list", changes: { preset_pager_position: "bottom" } },
    ]);

    expect(result.valid).toBe(true);
    if (!result.valid) {
      return;
    }
    const view = result.manifest.app.views[0] as Record<string, unknown>;
    expect(view.columns).toEqual(["title"]);
    expect(view.sort).toEqual({ field: "title", order: "asc" });
    expect(view.name).toBe("本の一覧");
    expect(view.preset_pager_position).toBe("bottom");
  });

  test("list_view に detail 専用のプリセットを書くと allowed_values 付きで拒否される", () => {
    const result = foldOperations(baseManifest(), [
      { op: "update_view", view: "book-list", changes: { preset_field_columns: 2 } },
    ]);

    expect(result.valid).toBe(false);
    if (result.valid) {
      return;
    }
    expect(result.errors[0]?.path).toBe("/operations/0/changes/preset_field_columns");
    expect(result.errors[0]?.allowed_values).toContain("preset_column_align");
    expect(result.errors[0]?.allowed_values).not.toContain("preset_field_columns");
  });

  /**
   * **【`V4-M16-T11` / `ADR-0091` 限定3 で書き換えた】** 着手前の本テストは題
   * 「form にはプリセットを1つも書けない(form の4軸は別の門。ADR-0050 §3a 2)」で、
   * **7キーすべてを列挙していた。** **`ADR-0091`(門A / 判定 = 限定採用)が
   * `preset_label_placement` と `preset_field_columns` を form にも通したので、
   * その2キーを列挙から外した** —— **残る5キーの判定は着手前と1バイトも同じである。**
   * **通した2軸が実際に運ばれることは `src/kernel/form-view-presets.test.ts` の (h) が見る。**
   */
  test("form に書けないプリセット5軸は update_view でも拒否される(ADR-0091 限定3)", () => {
    for (const key of [
      "preset_column_align",
      "preset_column_width",
      "preset_pager_position",
      "preset_image_size",
      "preset_text_preview",
    ]) {
      const value = key.endsWith("_align")
        ? { title: "left" }
        : key.endsWith("_width")
          ? { title: "wide" }
          : key === "preset_field_columns"
            ? 2
            : "top";
      const result = foldOperations(baseManifest(), [
        { op: "update_view", view: "book-form", changes: { [key]: value } },
      ]);
      expect(result.valid, key).toBe(false);
    }
  });

  /*
   * V1-M0-T02(F-1): `view.name` の限定採用。**3種すべてで対称に扱う。**
   * `name` を「list_view だけ」等に絞ると、`table.name` / `field.name` との非対称を
   * 解消するはずの変更が、ビュー種別の間に新しい非対称を作ってしまう。
   */
  test("add_view で name を指定でき、畳み込み後のマニフェストに残る(完了条件1)", () => {
    const result = foldOperations(baseManifest(), [
      {
        op: "add_view",
        view: { id: "book-detail", name: "本の詳細", type: "detail_view", table: "books" },
      },
    ]);

    expect(result.valid).toBe(true);
    if (!result.valid) {
      return;
    }
    expect(result.manifest.app.views[2]?.name).toBe("本の詳細");
  });

  test("update_view で3種すべてのビューの name を後から付けられる(完了条件1)", () => {
    const current = baseManifest();
    current.app.views.push({ id: "book-detail", type: "detail_view", table: "books" });
    const result = foldOperations(current, [
      { op: "update_view", view: "book-list", changes: { name: "蔵書一覧" } },
      { op: "update_view", view: "book-form", changes: { name: "本を登録" } },
      { op: "update_view", view: "book-detail", changes: { name: "本の詳細" } },
    ]);

    expect(result.valid).toBe(true);
    if (!result.valid) {
      return;
    }
    expect(result.manifest.app.views.map((view) => view.name)).toEqual([
      "蔵書一覧",
      "本を登録",
      "本の詳細",
    ]);
  });

  test("update_view で name だけを変えても他のキーは変わらない", () => {
    const result = foldOperations(baseManifest(), [
      { op: "update_view", view: "book-list", changes: { name: "蔵書一覧" } },
    ]);

    expect(result.valid).toBe(true);
    if (!result.valid) {
      return;
    }
    expect(result.manifest.app.views[0]).toEqual({
      id: "book-list",
      type: "list_view",
      table: "books",
      columns: ["title"],
      name: "蔵書一覧",
    });
  });

  test("name を持たないビューは畳み込み後も name を持たない(完了条件2・限定3)", () => {
    const result = foldOperations(baseManifest(), [
      { op: "update_view", view: "book-list", changes: { columns: ["memo"] } },
    ]);

    expect(result.valid).toBe(true);
    if (!result.valid) {
      return;
    }
    expect("name" in (result.manifest.app.views[0] ?? {})).toBe(false);
  });

  test("複数の異常はまとめて返る(1往復で直せる)", () => {
    const result = foldOperations(baseManifest(), [
      { op: "add_table", table: { id: "books", name: "重複", fields: [] } },
      { op: "update_view", view: "missing-view", changes: { columns: ["title"] } },
    ]);

    expect(result.valid).toBe(false);
    if (result.valid) {
      return;
    }
    expect(result.errors.map((e) => e.path)).toEqual([
      "/operations/0/table/id",
      "/operations/1/view",
    ]);
  });
});

describe("applyDiff 正常系", () => {
  test("マニフェスト・SQLiteスキーマ・changelog・スナップショットがすべて揃う", () => {
    const before = readManifestText();
    const result = applyDiff(dataRoot, APP_ID, ADD_FIELD_DIFF);

    expect(result.valid).toBe(true);
    if (!result.valid) {
      return;
    }

    // 1. 永続化されたマニフェスト。
    const manifest = readManifestFile();
    expect(readManifestText()).not.toBe(before);
    expect(manifest.app.tables[0]?.fields.map((f) => f.id)).toEqual([
      "title",
      "memo",
      "finished_at",
    ]);
    const listView = manifest.app.views[0];
    expect(listView && "columns" in listView ? listView.columns : undefined).toEqual([
      "title",
      "finished_at",
    ]);
    expect(listView && "sort" in listView ? listView.sort : undefined).toEqual({
      field: "finished_at",
      order: "desc",
    });
    expect(result.manifest).toEqual(manifest);

    // 2. 実スキーマ(PRAGMA table_info)。
    expect(readSchema().books).toEqual([
      "_id",
      "_created_at",
      "_updated_at",
      "title",
      "memo",
      "finished_at",
    ]);

    // 3. changelog。entries[0] は create_app が書いた第0行(_create-app)なので、
    // 今回の diff は2件目になる。
    const entries = store.listChangelog(APP_ID);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.diff_id).toBe("_create-app");
    const entry = entries[1];
    expect(entry?.diff_id).toBe("d-0002");
    expect(entry?.intent).toBe("読了日で並べ替えたいという要望");
    expect(entry?.operations).toEqual(ADD_FIELD_DIFF.operations);
    expect(entry?.kind).toBe("apply");
    expect(entry?.undo_target_seq).toBeNull();
    expect(entry?.snapshot).toBe("0001-d-0002");
    expect(result.entry).toEqual(entry as NonNullable<typeof entry>);

    // 4. スナップショットが実在し、2ファイルが揃っている。
    expect(listSnapshots(dataRoot, APP_ID)).toEqual(["0001-d-0002"]);
    const dir = snapshotDir(dataRoot, APP_ID, "0001-d-0002");
    expect(existsSync(join(dir, "manifest.json"))).toBe(true);
    expect(existsSync(join(dir, "app.sqlite"))).toBe(true);
    // スナップショットは「適用前」の状態である。
    const snapshotManifest = JSON.parse(
      readFileSync(join(dir, "manifest.json"), "utf-8"),
    ) as Manifest;
    expect(snapshotManifest).toEqual(baseManifest());
    expect(result.snapshot).toBe("0001-d-0002");
  });

  test("add_table でテーブルが作られる", () => {
    const result = applyDiff(dataRoot, APP_ID, {
      diff_id: "d-add-table",
      intent: "著者を別テーブルで管理したい",
      operations: [
        {
          op: "add_table",
          table: {
            id: "authors",
            name: "著者",
            fields: [{ id: "full_name", name: "氏名", type: "text", required: true }],
          },
        },
      ],
    });

    expect(result.valid).toBe(true);
    expect(readManifestFile().app.tables.map((t) => t.id)).toEqual(["books", "authors"]);
    expect(readSchema().authors).toEqual(["_id", "_created_at", "_updated_at", "full_name"]);
  });

  test("add_field で列が増える", () => {
    const result = applyDiff(dataRoot, APP_ID, {
      diff_id: "d-add-field",
      intent: "価格を記録したい",
      operations: [
        { op: "add_field", table: "books", field: { id: "price", name: "価格", type: "number" } },
      ],
    });

    expect(result.valid).toBe(true);
    expect(readSchema().books).toContain("price");
  });

  test("add_view はスキーマを変えずにビューだけ増やす", () => {
    const schemaBefore = readSchema();
    const result = applyDiff(dataRoot, APP_ID, {
      diff_id: "d-add-view",
      intent: "1冊の詳細を見たい",
      operations: [
        { op: "add_view", view: { id: "book-detail", type: "detail_view", table: "books" } },
      ],
    });

    expect(result.valid).toBe(true);
    expect(readManifestFile().app.views.map((v) => v.id)).toEqual([
      "book-list",
      "book-form",
      "book-detail",
    ]);
    expect(readSchema()).toEqual(schemaBefore);
  });

  /*
   * V1-M0-T09 の追補: 限界1(記録 §6-1)を閉じたことの実機での確認。
   * 本体の実装では、この diff は **通って**しまい(applyDiff が valid)、
   * 詳細画面を開いた時点で初めてエラーになっていた。
   */
  test("add_view の detail_view.fields に不在フィールドIDがあると apply_diff の時点で弾かれる", () => {
    const viewsBefore = readManifestFile().app.views.length;
    const result = applyDiff(dataRoot, APP_ID, {
      diff_id: "d-detail-bad-fields",
      intent: "詳細にタイトルだけ出したい",
      operations: [
        {
          op: "add_view",
          view: { id: "book-detail", type: "detail_view", table: "books", fields: ["titel"] },
        },
      ],
    });

    expect(result.valid).toBe(false);
    if (result.valid) {
      return;
    }
    const error = result.errors.find((candidate) => candidate.path.includes("/fields/0"));
    expect(error).toBeDefined();
    expect(error?.message).toContain("titel");
    expect(error?.allowed_values).toEqual(["title", "memo"]);
    expect(error?.hint).toBeDefined();
    // 書き込みは一切行われていない。
    expect(readManifestFile().app.views.length).toBe(viewsBefore);
  });

  test("detail_view.fields は add_view で通り、update_view で後から差し替えられる", () => {
    expect(
      applyDiff(dataRoot, APP_ID, {
        diff_id: "d-detail-add",
        intent: "詳細にタイトルだけ出したい",
        operations: [
          {
            op: "add_view",
            view: { id: "book-detail", type: "detail_view", table: "books", fields: ["title"] },
          },
        ],
      }).valid,
    ).toBe(true);

    expect(
      applyDiff(dataRoot, APP_ID, {
        diff_id: "d-detail-update",
        intent: "詳細にメモも出したい",
        operations: [
          { op: "update_view", view: "book-detail", changes: { fields: ["title", "memo"] } },
        ],
      }).valid,
    ).toBe(true);

    const view = readManifestFile().app.views.find((candidate) => candidate.id === "book-detail");
    expect(view && "fields" in view ? view.fields : undefined).toEqual(["title", "memo"]);
  });

  test("update_view で detail_view.fields に不在フィールドIDを入れると弾かれる", () => {
    expect(
      applyDiff(dataRoot, APP_ID, {
        diff_id: "d-detail-add-2",
        intent: "詳細画面がほしい",
        operations: [
          { op: "add_view", view: { id: "book-detail", type: "detail_view", table: "books" } },
        ],
      }).valid,
    ).toBe(true);

    const result = applyDiff(dataRoot, APP_ID, {
      diff_id: "d-detail-update-bad",
      intent: "詳細の項目を変えたい",
      operations: [{ op: "update_view", view: "book-detail", changes: { fields: ["nope"] } }],
    });

    expect(result.valid).toBe(false);
    if (result.valid) {
      return;
    }
    expect(result.errors.some((error) => error.message.includes("nope"))).toBe(true);
  });

  test("update_view で許された範囲だけが差し替わる", () => {
    const result = applyDiff(dataRoot, APP_ID, {
      diff_id: "d-update-view",
      intent: "メモも一覧に出したい",
      operations: [
        {
          op: "update_view",
          view: "book-list",
          changes: { columns: ["title", "memo"], filter: [{ field: "title", equals: "銀河" }] },
        },
      ],
    });

    expect(result.valid).toBe(true);
    const view = readManifestFile().app.views[0];
    expect(view?.id).toBe("book-list");
    expect(view?.type).toBe("list_view");
    expect(view && "columns" in view ? view.columns : undefined).toEqual(["title", "memo"]);
    expect(view && "filter" in view ? view.filter : undefined).toEqual([
      { field: "title", equals: "銀河" },
    ]);
  });

  test("複数 diff を連続適用でき、changelog とスナップショットが積み上がる", () => {
    expect(applyDiff(dataRoot, APP_ID, ADD_FIELD_DIFF).valid).toBe(true);
    expect(
      applyDiff(dataRoot, APP_ID, {
        diff_id: "d-0003",
        intent: "貸出中かどうかを持ちたい",
        operations: [
          {
            op: "add_field",
            table: "books",
            field: { id: "lent", name: "貸出中", type: "boolean" },
          },
        ],
      }).valid,
    ).toBe(true);

    // 先頭は create_app が書いた第0行(_create-app)。
    expect(store.listChangelog(APP_ID).map((e) => e.diff_id)).toEqual([
      "_create-app",
      "d-0002",
      "d-0003",
    ]);
    expect(listSnapshots(dataRoot, APP_ID)).toEqual(["0001-d-0002", "0002-d-0003"]);
  });
});

describe("applyDiff は既存データを壊さない", () => {
  test("add_field + update_view の後も既存レコードが全件全値そのままで、新列は null", () => {
    const first = seedBook({ title: "銀河鉄道の夜", memo: "宮沢賢治" });
    const second = seedBook({ title: "こころ", memo: null });
    const before = allBooks();
    expect(before).toHaveLength(2);

    expect(applyDiff(dataRoot, APP_ID, ADD_FIELD_DIFF).valid).toBe(true);

    const after = allBooks();
    expect(after).toHaveLength(2);
    for (const [index, row] of after.entries()) {
      const original = before[index];
      expect(row._id).toBe(original?._id as string);
      expect(row._created_at).toBe(original?._created_at as string);
      expect(row.title).toBe(original?.title as string);
      expect(row.memo).toBe(original?.memo as string);
      // 新しく増えた列は既存行では null。
      expect(row.finished_at).toBeNull();
    }
    expect(after.map((r) => r._id).sort()).toEqual([first._id, second._id].sort());
  });
});

describe("applyDiff 事前検証失敗(状態は一切変わらない)", () => {
  /** 検証失敗の前後で「すべて」が不変であることを確認するためのスナップショット。 */
  function captureState(): {
    manifest: string;
    schema: Record<string, string[]>;
    books: RecordRow[];
    changelog: number;
    snapshots: string[];
  } {
    return {
      manifest: readManifestText(),
      schema: readSchema(),
      books: allBooks(),
      changelog: store.listChangelog(APP_ID).length,
      snapshots: listSnapshots(dataRoot, APP_ID),
    };
  }

  beforeEach(() => {
    seedBook({ title: "銀河鉄道の夜", memo: "宮沢賢治" });
  });

  test("スキーマ違反(語彙外の op)は拒否され、状態が変わらない", () => {
    const before = captureState();
    const result = applyDiff(dataRoot, APP_ID, {
      diff_id: "d-bad",
      intent: "メモを消したい",
      operations: [{ op: "remove_field", table: "books", field: "memo" }],
    });

    expect(result.valid).toBe(false);
    if (result.valid) {
      return;
    }
    expect(result.errors.length).toBeGreaterThan(0);
    expect(captureState()).toEqual(before);
    expect(listSnapshots(dataRoot, APP_ID)).toEqual([]);
  });

  test("intent 欠落は拒否され、状態が変わらない", () => {
    const before = captureState();
    const result = applyDiff(dataRoot, APP_ID, {
      diff_id: "d-no-intent",
      operations: [
        { op: "add_field", table: "books", field: { id: "isbn", name: "ISBN", type: "text" } },
      ],
    });

    expect(result.valid).toBe(false);
    if (result.valid) {
      return;
    }
    expect(result.errors.some((e) => e.path === "" || e.path.includes("intent"))).toBe(true);
    expect(captureState()).toEqual(before);
  });

  test("参照切れを生む op(存在しないテーブルを指す add_view)は適用前に拒否される", () => {
    const before = captureState();
    const result = applyDiff(dataRoot, APP_ID, {
      diff_id: "d-dangling",
      intent: "雑誌の一覧を出したい",
      operations: [
        {
          op: "add_view",
          view: { id: "magazine-list", type: "list_view", table: "magazines", columns: ["title"] },
        },
      ],
    });

    expect(result.valid).toBe(false);
    if (result.valid) {
      return;
    }
    expect(captureState()).toEqual(before);
    expect(listSnapshots(dataRoot, APP_ID)).toEqual([]);
  });

  test("存在しないフィールドを指す update_view は適用前に拒否される", () => {
    const before = captureState();
    const result = applyDiff(dataRoot, APP_ID, {
      diff_id: "d-bad-column",
      intent: "読了日を一覧に出したい",
      operations: [{ op: "update_view", view: "book-list", changes: { columns: ["finished_at"] } }],
    });

    expect(result.valid).toBe(false);
    expect(captureState()).toEqual(before);
  });

  test("畳み込み異常(既存フィールドへの add_field)は適用前に拒否される", () => {
    const before = captureState();
    const result = applyDiff(dataRoot, APP_ID, {
      diff_id: "d-dup-field",
      intent: "タイトルをもう一度足したい",
      operations: [
        { op: "add_field", table: "books", field: { id: "title", name: "題名", type: "text" } },
      ],
    });

    expect(result.valid).toBe(false);
    if (result.valid) {
      return;
    }
    expect(result.errors[0]?.path).toBe("/operations/0/field/id");
    expect(captureState()).toEqual(before);
  });
});

describe("applyDiff diff_id の重複", () => {
  test("同じ diff_id の再適用は自己修正可能な統一形式エラーになり、状態が変わらない", () => {
    expect(applyDiff(dataRoot, APP_ID, ADD_FIELD_DIFF).valid).toBe(true);

    const manifestAfterFirst = readManifestText();
    const schemaAfterFirst = readSchema();
    const snapshotsAfterFirst = listSnapshots(dataRoot, APP_ID);

    const again = applyDiff(dataRoot, APP_ID, {
      diff_id: "d-0002",
      intent: "同じIDを使い回してしまった",
      operations: [
        { op: "add_field", table: "books", field: { id: "isbn", name: "ISBN", type: "text" } },
      ],
    });

    expect(again.valid).toBe(false);
    if (again.valid) {
      return;
    }
    expect(again.errors).toHaveLength(1);
    expect(again.errors[0]?.path).toBe("/diff_id");
    expect(again.errors[0]?.message).toContain("d-0002");
    expect(again.errors[0]?.hint).toBeDefined();

    // 2回目は何も起こしていない(スナップショットも増えない)。
    expect(readManifestText()).toBe(manifestAfterFirst);
    expect(readSchema()).toEqual(schemaAfterFirst);
    expect(listSnapshots(dataRoot, APP_ID)).toEqual(snapshotsAfterFirst);
    // _create-app(第0行) + 1回目の d-0002。2回目は拒否されて増えない。
    expect(store.listChangelog(APP_ID)).toHaveLength(2);
  });
});

describe("applyDiff 途中失敗からの自動復帰(部分適用を残さない)", () => {
  test("マイグレーション(DDL)が失敗したら、適用前の状態のまま何も残らない", () => {
    seedBook({ title: "銀河鉄道の夜", memo: "宮沢賢治" });
    const manifestBefore = readManifestText();
    const booksBefore = allBooks();

    // 障害の注入: マニフェストには存在しないテーブル "authors" を app.sqlite に先に作る。
    // 事前検証(マニフェスト同士の比較)はこれを知らないので通り、
    // CREATE TABLE の実行時に初めて衝突して失敗する = 適用の途中で落ちる。
    withDb((db) => {
      db.exec(`CREATE TABLE "authors" ("_id" TEXT PRIMARY KEY)`);
    });

    expect(() =>
      applyDiff(dataRoot, APP_ID, {
        diff_id: "d-conflict",
        intent: "著者テーブルを足したい",
        operations: [
          {
            op: "add_table",
            table: {
              id: "authors",
              name: "著者",
              fields: [{ id: "full_name", name: "氏名", type: "text", required: true }],
            },
          },
        ],
      }),
    ).toThrow();

    // マニフェストもデータも適用前のまま。changelog に中途半端なエントリは残らない
    // (create_app が書いた第0行(_create-app)だけが残る)。
    expect(readManifestText()).toBe(manifestBefore);
    expect(allBooks()).toEqual(booksBefore);
    expect(store.listChangelog(APP_ID)).toHaveLength(1);
  });

  test("マニフェスト更新・DDL の後(changelog 記録)で失敗したら、スナップショットから自動復帰する", () => {
    seedBook({ title: "銀河鉄道の夜", memo: "宮沢賢治" });
    seedBook({ title: "こころ", memo: null });
    const manifestBefore = readManifestText();
    const schemaBefore = readSchema();
    const booksBefore = allBooks();

    // 障害の注入: アプリの実体(manifest.json / app.sqlite)は残したまま、
    // 台帳から行だけを消す。applyDiff は 1〜4(検証・スナップショット・マニフェスト更新・
    // マイグレーション)を最後まで完了したうえで、5 の changelog 追記
    // (changelog.app_id は apps への外部キー)で初めて失敗する。
    // = マニフェストと DDL が既に適用済みの状態からのロールバックを強制するテスト。
    // V1-M0-T05: create_app が書いた第0行(_create-app)も apps を参照する changelog 行
    // なので、先にそれを消しておかないと apps 行の DELETE 自体が外部キー違反で失敗する。
    const kernel = new Database(kernelDbPath(dataRoot), { readwrite: true, create: false });
    try {
      kernel.exec(`PRAGMA foreign_keys = ON`);
      kernel.query(`DELETE FROM "changelog" WHERE "app_id" = ?`).run(APP_ID);
      kernel.query(`DELETE FROM "apps" WHERE "app_id" = ?`).run(APP_ID);
    } finally {
      kernel.close();
    }

    expect(() => applyDiff(dataRoot, APP_ID, ADD_FIELD_DIFF)).toThrow();

    // スナップショットは実際に取得されていた(= 1〜2 を通過したことの裏取り)。
    expect(listSnapshots(dataRoot, APP_ID)).toEqual(["0001-d-0002"]);

    // 復帰の確認: マニフェストはバイト単位で適用前と一致。
    expect(readManifestText()).toBe(manifestBefore);
    // 追加された列は消えている(DDL も巻き戻っている)。
    expect(readSchema()).toEqual(schemaBefore);
    expect(readSchema().books).not.toContain("finished_at");
    // データは全件全値そのまま。
    expect(allBooks()).toEqual(booksBefore);
    // changelog に中途半端なエントリは残らない。
    const kernelAfter = new Database(kernelDbPath(dataRoot), { readwrite: true, create: false });
    try {
      const count = kernelAfter
        .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM "changelog" WHERE "app_id" = ?`)
        .get(APP_ID);
      expect(count?.n).toBe(0);
    } finally {
      kernelAfter.close();
    }
  });
});

describe("適用後マニフェスト由来のエラーには「パスの根が違う」注釈が必ず付く", () => {
  test("hint を既に持つ参照整合性エラーにも注釈が付き、既存 hint も残る", () => {
    const result = applyDiff(dataRoot, APP_ID, {
      diff_id: "d-annotate-hinted",
      intent: "読了日を一覧に出したい",
      operations: [{ op: "update_view", view: "book-list", changes: { columns: ["finished_at"] } }],
    });

    expect(result.valid).toBe(false);
    if (result.valid) {
      return;
    }
    const error = result.errors[0];
    // 根が「適用後マニフェスト」であることの確認(この前提が崩れたらテストの意味が変わる)。
    expect(error?.path.startsWith("/app/")).toBe(true);
    const hint = error?.hint ?? "";
    // 注釈が付いていること。
    expect(hint).toContain(APPLIED_MANIFEST_PATH_NOTE);
    // 既存 hint(何をどう直すか)の情報が失われていないこと。
    expect(hint).toContain("add_field");
  });

  test("hint を持たないエラーにも従来どおり注釈が付く", () => {
    const annotated = annotateAppliedManifestError({
      path: "/app/views/0/columns/1",
      message: "テスト用のメッセージ。",
    });

    expect(annotated.hint).toBe(APPLIED_MANIFEST_PATH_NOTE);
    expect(annotated.message).toBe("テスト用のメッセージ。");
  });

  test("差分スキーマ違反(/operations が根)には注釈が付かない", () => {
    const untouched = annotateAppliedManifestError({
      path: "/operations/0/op",
      message: "語彙にない op です。",
      hint: "additive な op を使ってください。",
    });

    expect(untouched.hint).toBe("additive な op を使ってください。");
    expect(untouched.hint ?? "").not.toContain(APPLIED_MANIFEST_PATH_NOTE);
  });

  test("二重に適用しても注釈が重複しない", () => {
    const once = annotateAppliedManifestError({
      path: "/app/views/0/columns/1",
      message: "テスト用のメッセージ。",
      hint: "元のヒント。",
    });
    const twice = annotateAppliedManifestError(once);

    expect(twice).toEqual(once);
    const occurrences = (twice.hint ?? "").split(APPLIED_MANIFEST_PATH_NOTE).length - 1;
    expect(occurrences).toBe(1);
  });

  test("applyDiff 経由(参照切れを生む add_view)でも注釈が返る", () => {
    const result = applyDiff(dataRoot, APP_ID, {
      diff_id: "d-annotate-e2e",
      intent: "雑誌の一覧を出したい",
      operations: [
        {
          op: "add_view",
          view: { id: "magazine-list", type: "list_view", table: "magazines", columns: ["title"] },
        },
      ],
    });

    expect(result.valid).toBe(false);
    if (result.valid) {
      return;
    }
    expect(result.errors.length).toBeGreaterThan(0);
    for (const error of result.errors) {
      expect(error.hint ?? "").toContain(APPLIED_MANIFEST_PATH_NOTE);
    }
  });
});

// ===========================================================================
// V1-M1-T03: 破壊的 op(remove_field / remove_table / change_table / change_field)
//
// ADR-0010 が定めた4 op の実行エンジン。**完了条件は op ごとに別々に立てる**
// (詳細化 §3: 束ねたことで1件が他に埋もれるのを防ぐため)。
// ===========================================================================

/** 破壊的 op の検証で使う、参照とビューを持つマニフェスト。 */
function richManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "蔵書管理",
      tables: [
        {
          id: "authors",
          name: "著者",
          fields: [{ id: "name", name: "氏名", type: "text" }],
        },
        {
          id: "books",
          name: "本",
          fields: [
            { id: "title", name: "タイトル", type: "text", required: true },
            { id: "memo", name: "メモ", type: "long_text" },
            { id: "qty", name: "数量", type: "text" },
            { id: "status", name: "状態", type: "select", options: ["未読", "読了"] },
            { id: "author", name: "著者", type: "reference", reference_table: "authors" },
          ],
        },
      ],
      views: [
        {
          id: "book-list",
          type: "list_view",
          table: "books",
          columns: ["title", "memo", "qty"],
          sort: { field: "qty", order: "desc" },
          filter: [{ field: "status", equals: "読了" }],
        },
        { id: "book-form", type: "form", table: "books", fields: ["title", "memo", "qty"] },
        { id: "book-detail", type: "detail_view", table: "books", fields: ["title", "qty"] },
      ],
    },
  };
}

/** rich マニフェストへ差し替えてから、レコードを投入する。 */
function setupRich(rows: Record<string, unknown>[] = []): void {
  const applied = applyManifest(dataRoot, APP_ID, richManifest());
  if (!applied.valid) {
    throw new Error(`rich マニフェストの投入に失敗: ${JSON.stringify(applied.errors)}`);
  }
  withDb((db) => {
    const manifest = readManifestFile();
    const author = createRecord(db, manifest, "authors", { name: "アダムズ" });
    if (!author.ok) {
      throw new Error("著者の投入に失敗");
    }
    for (const row of rows) {
      const result = createRecord(db, manifest, "books", {
        ...row,
        author: row.author === "@" ? author.value._id : row.author,
      });
      if (!result.ok) {
        throw new Error(`本の投入に失敗: ${JSON.stringify(result.errors)}`);
      }
    }
  });
}

/** 破壊的 op の差分を作る。 */
function destructive(diffId: string, operations: unknown[]): unknown {
  return { diff_id: diffId, intent: "破壊的変更の要望", operations };
}

/** テーブルの列名を読む。 */
function columnsOf(table: string): string[] {
  return readSchema()[table] ?? [];
}

/** 拒否され、かつ状態が1バイトも変わっていないことを確かめる。 */
function expectRejectedNoop(diff: unknown): ValidationError[] {
  const beforeManifest = readManifestText();
  const beforeSchema = readSchema();
  const beforeSnapshots = listSnapshots(dataRoot, APP_ID);

  const result = applyDiff(dataRoot, APP_ID, diff);
  expect(result.valid).toBe(false);
  if (result.valid) {
    throw new Error("破壊的差分が適用されてしまいました。");
  }
  expect(readManifestText()).toBe(beforeManifest);
  expect(readSchema()).toEqual(beforeSchema);
  // ADR-0010 §6b: 拒否は事前検証で行う。スナップショットより前である。
  expect(listSnapshots(dataRoot, APP_ID)).toEqual(beforeSnapshots);
  return result.errors;
}

describe("V1-M1-T03 完了条件A: remove_field", () => {
  test("フィールド定義と SQLite の列が消え、他の列のデータは無傷である", () => {
    setupRich([
      { title: "銀河", memo: "42", qty: "3", status: "読了", author: "@" },
      { title: "軽さ", memo: "", qty: "1", status: "未読", author: "@" },
    ]);
    const before = allBooks().map((row) => ({ title: row.title, qty: row.qty }));

    const result = applyDiff(
      dataRoot,
      APP_ID,
      destructive("d-rf", [
        // memo はビューから参照されているので、先に外す(カスケード削除は採らない)。
        { op: "update_view", view: "book-list", changes: { columns: ["title", "qty"] } },
        { op: "update_view", view: "book-form", changes: { fields: ["title", "qty"] } },
        { op: "remove_field", table: "books", field: "memo" },
      ]),
    );

    expect(result.valid).toBe(true);
    if (!result.valid) {
      return;
    }
    const fields = result.manifest.app.tables[1]?.fields.map((f) => f.id);
    expect(fields).toEqual(["title", "qty", "status", "author"]);
    expect(columnsOf("books")).not.toContain("memo");
    expect(allBooks().map((row) => ({ title: row.title, qty: row.qty }))).toEqual(before);
  });

  test("ビューから参照されているフィールドの削除は拒否される(カスケード削除は採らない。§7a)", () => {
    setupRich([{ title: "銀河", memo: "42", qty: "3", status: "読了", author: "@" }]);
    const errors = expectRejectedNoop(
      destructive("d-rf2", [{ op: "remove_field", table: "books", field: "memo" }]),
    );
    // 何を先に直すべきかが分かること(hint に update_view が出る)。
    expect(errors.some((e) => (e.hint ?? "").includes("update_view"))).toBe(true);
  });

  test("存在しないフィールドの削除は拒否され、実在するIDが候補として返る", () => {
    setupRich();
    const errors = expectRejectedNoop(
      destructive("d-rf3", [{ op: "remove_field", table: "books", field: "ghost" }]),
    );
    expect(errors[0]?.path).toBe("/operations/0/field");
    expect(errors[0]?.allowed_values).toEqual(["title", "memo", "qty", "status", "author"]);
  });

  test("システムテーブルを対象にした remove_field は拒否される(限定8)", () => {
    setupRich();
    const errors = expectRejectedNoop(
      destructive("d-rf4", [{ op: "remove_field", table: "_changelog", field: "intent" }]),
    );
    expect(errors[0]?.path).toBe("/operations/0/table");
    expect(errors[0]?.message).toContain("_changelog");
  });

  test("DROP COLUMN が使えない環境でも再構築経路で同じ結果になる(§5a)", () => {
    // 実行環境の可用性に依存しないことを、両経路の結果が一致することで示す。
    setupRich([{ title: "銀河", memo: "42", qty: "3", status: "読了", author: "@" }]);
    applyDiff(
      dataRoot,
      APP_ID,
      destructive("d-rf5", [
        { op: "update_view", view: "book-list", changes: { columns: ["title", "qty"] } },
        { op: "update_view", view: "book-form", changes: { fields: ["title", "qty"] } },
        { op: "remove_field", table: "books", field: "memo" },
      ]),
    );
    // 列が消え、残りの列の並びと値が保たれている。
    expect(columnsOf("books")).toEqual([
      "_id",
      "_created_at",
      "_updated_at",
      "title",
      "qty",
      "status",
      "author",
    ]);
    expect(allBooks()[0]?.title).toBe("銀河");
  });
});

describe("V1-M1-T03 完了条件B: remove_table", () => {
  test("テーブル定義と SQLite のテーブルが消える", () => {
    setupRich([{ title: "銀河", memo: "", qty: "1", status: "未読", author: "@" }]);
    const result = applyDiff(
      dataRoot,
      APP_ID,
      destructive("d-rt", [
        // books は authors を参照し、ビューも持つので、books の方を消す。
        { op: "remove_table", table: "books" },
      ]),
    );
    // books を消すと book-list / book-form / book-detail が参照切れになるので拒否される。
    expect(result.valid).toBe(false);
  });

  test("ビューと参照を先に外せばテーブルを削除できる", () => {
    setupRich([{ title: "銀河", memo: "", qty: "1", status: "未読", author: "@" }]);
    // authors を消すには、books.author(reference)を先に消す必要がある。
    const result = applyDiff(
      dataRoot,
      APP_ID,
      destructive("d-rt2", [
        { op: "remove_field", table: "books", field: "author" },
        { op: "remove_table", table: "authors" },
      ]),
    );
    expect(result.valid).toBe(true);
    if (!result.valid) {
      return;
    }
    expect(result.manifest.app.tables.map((t) => t.id)).toEqual(["books"]);
    expect(Object.keys(readSchema())).not.toContain("authors");
  });

  test("他テーブルから reference されているテーブルの削除は拒否される", () => {
    setupRich();
    const errors = expectRejectedNoop(
      destructive("d-rt3", [{ op: "remove_table", table: "authors" }]),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  test("存在しないテーブルの削除は拒否され、実在するIDが候補として返る", () => {
    setupRich();
    const errors = expectRejectedNoop(
      destructive("d-rt4", [{ op: "remove_table", table: "ghost" }]),
    );
    expect(errors[0]?.path).toBe("/operations/0/table");
    expect(errors[0]?.allowed_values).toEqual(["authors", "books"]);
  });

  test("システムテーブルを対象にした remove_table は拒否される(限定8)", () => {
    setupRich();
    const errors = expectRejectedNoop(
      destructive("d-rt5", [{ op: "remove_table", table: "_apps" }]),
    );
    expect(errors[0]?.path).toBe("/operations/0/table");
  });
});

// ===========================================================================
// V1-M1-remove-view(ADR-0012): remove_view
//
// **データを1バイトも失わない op である。** 破壊的4種(remove_field /
// remove_table / change_table / change_field)とは性質が違い、SQLite スキーマにも
// レコードにも触らない。カスケードもしない(ADR-0012 §4 限定4)。
// ===========================================================================

describe("ADR-0012 完了条件A: remove_view はビューだけを消す", () => {
  test("ビュー定義が消え、テーブル・フィールド・レコードは1バイトも変わらない", () => {
    setupRich([
      { title: "銀河", memo: "42", qty: "3", status: "読了", author: "@" },
      { title: "軽さ", memo: "", qty: "1", status: "未読", author: "@" },
    ]);
    const beforeSchema = readSchema();
    const beforeTables = readManifestFile().app.tables;
    const beforeRows = allBooks();

    const result = applyDiff(
      dataRoot,
      APP_ID,
      destructive("d-rv1", [{ op: "remove_view", view: "book-detail" }]),
    );
    expect(result.valid).toBe(true);
    if (!result.valid) {
      return;
    }

    // 消えたのは名指しした1画面だけ。
    expect(result.manifest.app.views.map((v) => v.id)).toEqual(["book-list", "book-form"]);
    // テーブル定義・物理スキーマ・レコードは1バイトも変わらない。
    expect(result.manifest.app.tables).toEqual(beforeTables);
    expect(readSchema()).toEqual(beforeSchema);
    expect(allBooks()).toEqual(beforeRows);
    // ビューは SQLite スキーマに影響しないので、実行計画は空である。
    expect(result.plan.add_tables).toEqual([]);
    expect(result.plan.add_fields).toEqual([]);
  });

  test("カスケードしない —— remove_view は他のビューもテーブルも消さない", () => {
    setupRich([{ title: "銀河", memo: "42", qty: "3", status: "読了", author: "@" }]);
    const result = applyDiff(
      dataRoot,
      APP_ID,
      destructive("d-rv2", [{ op: "remove_view", view: "book-list" }]),
    );
    expect(result.valid).toBe(true);
    if (!result.valid) {
      return;
    }
    expect(result.manifest.app.views.map((v) => v.id)).toEqual(["book-form", "book-detail"]);
    expect(result.manifest.app.tables.map((t) => t.id)).toEqual(["authors", "books"]);
  });

  test("存在しないビューIDは統一形式で拒否され、状態を1バイトも変えない", () => {
    setupRich();
    const errors = expectRejectedNoop(destructive("d-rv3", [{ op: "remove_view", view: "ghost" }]));
    expect(errors[0]?.path).toBe("/operations/0/view");
    expect(errors[0]?.message).toContain("ghost");
    expect(errors[0]?.allowed_values).toEqual(["book-list", "book-form", "book-detail"]);
    expect(errors[0]?.hint).toBeDefined();
  });
});

describe("ADR-0012 完了条件B: remove_view + remove_table を同じ差分に並べる", () => {
  test("ビューが載っているテーブルを、同じ差分の中で削除できる(本審査の目的)", () => {
    setupRich([{ title: "銀河", memo: "42", qty: "3", status: "読了", author: "@" }]);
    const result = applyDiff(
      dataRoot,
      APP_ID,
      destructive("d-rv4", [
        { op: "remove_view", view: "book-list" },
        { op: "remove_view", view: "book-form" },
        { op: "remove_view", view: "book-detail" },
        { op: "remove_table", table: "books" },
      ]),
    );
    expect(result.valid).toBe(true);
    if (!result.valid) {
      return;
    }
    expect(result.manifest.app.views).toEqual([]);
    expect(result.manifest.app.tables.map((t) => t.id)).toEqual(["authors"]);
    expect(Object.keys(readSchema())).not.toContain("books");
  });

  test("ビューを残したまま remove_table すると拒否され、hint が remove_view を案内する", () => {
    // **V1-M1-T06 §10-3 の是正。** 旧 hint は remove_table に対しても
    // 「update_view で columns から外せ」と案内していたが、それは実行不能である
    // (ビューの table は変えられず、columns は空にできない)。
    setupRich();
    const errors = expectRejectedNoop(
      destructive("d-rv5", [{ op: "remove_table", table: "books" }]),
    );
    const hints = errors.map((e) => e.hint ?? "").join(" ");
    expect(hints).toContain("remove_view");
    expect(hints).toContain(DESTRUCTIVE_NO_CASCADE_NOTE);
  });

  test("remove_field は従来どおり update_view を案内する(文面を変えていない)", () => {
    setupRich();
    const errors = expectRejectedNoop(
      destructive("d-rv6", [{ op: "remove_field", table: "books", field: "memo" }]),
    );
    const hints = errors.map((e) => e.hint ?? "").join(" ");
    expect(hints).toContain("update_view");
    expect(hints).toContain(DESTRUCTIVE_NO_CASCADE_NOTE);
  });

  test("remove_field と remove_table を両方含む差分では、両方の手順が案内される", () => {
    setupRich();
    const errors = expectRejectedNoop(
      destructive("d-rv7", [
        { op: "remove_field", table: "books", field: "memo" },
        { op: "remove_table", table: "authors" },
      ]),
    );
    const hints = errors.map((e) => e.hint ?? "").join(" ");
    expect(hints).toContain("update_view");
    expect(hints).toContain("remove_view");
  });
});

describe("V1-M1-T03 完了条件C: change_table", () => {
  test("changes.name は表示名だけを変え、スキーマもデータも変えない", () => {
    setupRich([{ title: "銀河", memo: "", qty: "1", status: "未読", author: "@" }]);
    const beforeSchema = readSchema();
    const beforeRows = allBooks();

    const result = applyDiff(
      dataRoot,
      APP_ID,
      destructive("d-ct", [{ op: "change_table", table: "books", changes: { name: "蔵書" } }]),
    );
    expect(result.valid).toBe(true);
    if (!result.valid) {
      return;
    }
    expect(result.manifest.app.tables[1]?.name).toBe("蔵書");
    expect(readSchema()).toEqual(beforeSchema);
    expect(allBooks()).toEqual(beforeRows);
  });

  test("changes.id はテーブルをリネームし、マニフェスト内の参照が自動追随する(§5d)", () => {
    setupRich([{ title: "銀河", memo: "", qty: "1", status: "未読", author: "@" }]);

    const result = applyDiff(
      dataRoot,
      APP_ID,
      destructive("d-ct2", [{ op: "change_table", table: "books", changes: { id: "volumes" } }]),
    );
    expect(result.valid).toBe(true);
    if (!result.valid) {
      return;
    }
    expect(result.manifest.app.tables.map((t) => t.id)).toEqual(["authors", "volumes"]);
    // ビューの table が追随している(追随しなければ参照整合性で落ちるが、落ちることに頼らない)。
    expect(result.manifest.app.views.map((v) => v.table)).toEqual([
      "volumes",
      "volumes",
      "volumes",
    ]);
    // 物理テーブルもリネームされ、行が残っている。
    expect(Object.keys(readSchema()).sort()).toEqual(["authors", "volumes"]);
    expect(
      withDb((db) => db.query(`SELECT COUNT(*) AS n FROM "volumes"`).get() as { n: number }).n,
    ).toBe(1);
  });

  test("参照されているテーブルをリネームすると reference_table も追随する(§5d)", () => {
    setupRich();
    const result = applyDiff(
      dataRoot,
      APP_ID,
      destructive("d-ct3", [{ op: "change_table", table: "authors", changes: { id: "writers" } }]),
    );
    expect(result.valid).toBe(true);
    if (!result.valid) {
      return;
    }
    const author = result.manifest.app.tables[1]?.fields.find((f) => f.id === "author");
    expect(author?.type === "reference" ? author.reference_table : undefined).toBe("writers");
  });

  test("リネーム先のIDが既存テーブルと衝突する場合は拒否される", () => {
    setupRich();
    const errors = expectRejectedNoop(
      destructive("d-ct4", [{ op: "change_table", table: "books", changes: { id: "authors" } }]),
    );
    expect(errors[0]?.path).toBe("/operations/0/changes/id");
  });

  test("システムテーブルを対象にした change_table は拒否される(限定8)", () => {
    setupRich();
    expectRejectedNoop(
      destructive("d-ct5", [{ op: "change_table", table: "_apps", changes: { name: "x" } }]),
    );
  });
});

describe("V1-M1-T03 完了条件D: change_field", () => {
  test("changes.name は表示名だけを変える", () => {
    setupRich([{ title: "銀河", memo: "", qty: "1", status: "未読", author: "@" }]);
    const beforeSchema = readSchema();
    const result = applyDiff(
      dataRoot,
      APP_ID,
      destructive("d-cf", [
        { op: "change_field", table: "books", field: "memo", changes: { name: "覚書" } },
      ]),
    );
    expect(result.valid).toBe(true);
    if (!result.valid) {
      return;
    }
    expect(result.manifest.app.tables[1]?.fields[1]?.name).toBe("覚書");
    expect(readSchema()).toEqual(beforeSchema);
  });

  test("changes.id は列をリネームし、ビューの columns / fields / sort / filter が追随する(§5d)", () => {
    setupRich([{ title: "銀河", memo: "", qty: "7", status: "読了", author: "@" }]);
    const result = applyDiff(
      dataRoot,
      APP_ID,
      destructive("d-cf2", [
        { op: "change_field", table: "books", field: "qty", changes: { id: "amount" } },
      ]),
    );
    expect(result.valid).toBe(true);
    if (!result.valid) {
      return;
    }
    const [list, form, detail] = result.manifest.app.views;
    expect(list?.type === "list_view" ? list.columns : []).toEqual(["title", "memo", "amount"]);
    expect(list?.type === "list_view" ? list.sort : undefined).toEqual({
      field: "amount",
      order: "desc",
    });
    expect(form?.type === "form" ? form.fields : []).toEqual(["title", "memo", "amount"]);
    expect(detail?.type === "detail_view" ? detail.fields : []).toEqual(["title", "amount"]);
    // 値が保たれたまま列名だけが変わる。
    expect(columnsOf("books")).toContain("amount");
    expect(columnsOf("books")).not.toContain("qty");
    expect(allBooks()[0]?.amount).toBe("7");
  });

  test("filter の field も追随する(§5d)", () => {
    setupRich();
    const result = applyDiff(
      dataRoot,
      APP_ID,
      destructive("d-cf3", [
        { op: "change_field", table: "books", field: "status", changes: { id: "state" } },
      ]),
    );
    expect(result.valid).toBe(true);
    if (!result.valid) {
      return;
    }
    const list = result.manifest.app.views[0];
    expect(list?.type === "list_view" ? list.filter : undefined).toEqual([
      { field: "state", equals: "読了" },
    ]);
  });

  test("層1の型変更(text → date)は DDL 無操作で、値が1バイトも変わらない", () => {
    setupRich([{ title: "銀河", memo: "2026-07-19", qty: "1", status: "未読", author: "@" }]);
    const beforeRows = allBooks();
    const result = applyDiff(
      dataRoot,
      APP_ID,
      destructive("d-cf4", [
        { op: "change_field", table: "books", field: "memo", changes: { type: "date" } },
      ]),
    );
    expect(result.valid).toBe(true);
    if (!result.valid) {
      return;
    }
    expect(result.manifest.app.tables[1]?.fields[1]?.type).toBe("date");
    expect(allBooks()).toEqual(beforeRows);
  });

  test("層2の型変更(text → number)はテーブルを再構築し、値を数値にする", () => {
    setupRich([
      { title: "銀河", memo: "", qty: "42", status: "未読", author: "@" },
      { title: "軽さ", memo: "", qty: "7", status: "読了", author: "@" },
    ]);
    const result = applyDiff(
      dataRoot,
      APP_ID,
      destructive("d-cf5", [
        { op: "change_field", table: "books", field: "qty", changes: { type: "number" } },
      ]),
    );
    expect(result.valid).toBe(true);
    if (!result.valid) {
      return;
    }
    const types = withDb((db) =>
      Object.fromEntries(
        db
          .query<{ name: string; type: string }, []>(`PRAGMA table_info("books")`)
          .all()
          .map((row) => [row.name, row.type]),
      ),
    );
    expect(types.qty).toBe("NUMERIC");
    expect(
      allBooks()
        .map((row) => row.qty)
        .sort(),
    ).toEqual([42, 7].sort());
    // 他の列と行数が保たれている。
    expect(allBooks()).toHaveLength(2);
    expect(columnsOf("books")).toEqual([
      "_id",
      "_created_at",
      "_updated_at",
      "title",
      "memo",
      "qty",
      "status",
      "author",
    ]);
  });

  test("変換不能値があると全体が中止され、スナップショットが1つも作られない(§6b)", () => {
    setupRich([
      { title: "銀河", memo: "", qty: "42", status: "未読", author: "@" },
      { title: "軽さ", memo: "", qty: "たくさん", status: "読了", author: "@" },
    ]);
    const errors = expectRejectedNoop(
      destructive("d-cf6", [
        { op: "change_field", table: "books", field: "qty", changes: { type: "number" } },
      ]),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("たくさん");
    // 該当行の _id が返る(ADR-0010 §7 失敗4)。
    expect(errors[0]?.message).toMatch(/_id "[^"]+"/);
    // データも1行も変わっていない。
    expect(allBooks()).toHaveLength(2);
  });

  test("不能セル(date → number)は1行も無くても拒否される", () => {
    setupRich();
    const errors = expectRejectedNoop(
      destructive("d-cf7", [
        { op: "change_field", table: "books", field: "memo", changes: { type: "date" } },
        { op: "change_field", table: "books", field: "memo", changes: { type: "number" } },
      ]),
    );
    expect(errors.some((e) => e.message.includes("語彙として認めていません"))).toBe(true);
  });

  test("options から選択肢を削除できるが、その値を持つ行があれば拒否される(§5c)", () => {
    setupRich([{ title: "銀河", memo: "", qty: "1", status: "読了", author: "@" }]);
    // 「読了」を持つ行があるので削除は拒否。
    const errors = expectRejectedNoop(
      destructive("d-cf8", [
        { op: "change_field", table: "books", field: "status", changes: { options: ["未読"] } },
      ]),
    );
    expect(errors[0]?.message).toContain("読了");

    // 追加は無条件で通る。
    const added = applyDiff(
      dataRoot,
      APP_ID,
      destructive("d-cf9", [
        {
          op: "change_field",
          table: "books",
          field: "status",
          changes: { options: ["未読", "読了", "積読"] },
        },
      ]),
    );
    expect(added.valid).toBe(true);
  });

  test("required の格上げは、空値を持つ行があれば拒否される(§5c)", () => {
    setupRich([{ title: "銀河", memo: "", qty: "1", status: "未読", author: "@" }]);
    // memo は空文字 = isMissingValue に該当する。
    const errors = expectRejectedNoop(
      destructive("d-cfa", [
        { op: "change_field", table: "books", field: "memo", changes: { required: true } },
      ]),
    );
    expect(errors[0]?.message).toContain("必須");

    // 格下げは無条件で通る。
    const ok = applyDiff(
      dataRoot,
      APP_ID,
      destructive("d-cfb", [
        { op: "change_field", table: "books", field: "title", changes: { required: false } },
      ]),
    );
    expect(ok.valid).toBe(true);
  });

  test("reference_table の変更は、既存の値が新しい参照先に実在する場合のみ通る", () => {
    setupRich([{ title: "銀河", memo: "", qty: "1", status: "未読", author: "@" }]);
    const errors = expectRejectedNoop(
      destructive("d-cfc", [
        { op: "add_table", table: { id: "publishers", name: "出版社", fields: [] } },
        {
          op: "change_field",
          table: "books",
          field: "author",
          changes: { reference_table: "publishers" },
        },
      ]),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  test("存在しないフィールドを対象にすると拒否される", () => {
    setupRich();
    const errors = expectRejectedNoop(
      destructive("d-cfd", [
        { op: "change_field", table: "books", field: "ghost", changes: { name: "x" } },
      ]),
    );
    expect(errors[0]?.path).toBe("/operations/0/field");
  });

  test("リネーム先のフィールドIDが同一テーブル内で衝突する場合は拒否される", () => {
    setupRich();
    const errors = expectRejectedNoop(
      destructive("d-cfe", [
        { op: "change_field", table: "books", field: "memo", changes: { id: "title" } },
      ]),
    );
    expect(errors[0]?.path).toBe("/operations/0/changes/id");
  });

  test("システムテーブルを対象にした change_field は拒否される(限定8)", () => {
    setupRich();
    expectRejectedNoop(
      destructive("d-cff", [
        { op: "change_field", table: "_changelog", field: "intent", changes: { name: "x" } },
      ]),
    );
  });

  test("型変更とリネームを同時に指定できる(層2 + rename)", () => {
    setupRich([{ title: "銀河", memo: "", qty: "42", status: "未読", author: "@" }]);
    const result = applyDiff(
      dataRoot,
      APP_ID,
      destructive("d-cfg", [
        {
          op: "change_field",
          table: "books",
          field: "qty",
          changes: { id: "amount", type: "number", name: "数" },
        },
      ]),
    );
    expect(result.valid).toBe(true);
    if (!result.valid) {
      return;
    }
    expect(columnsOf("books")).toContain("amount");
    expect(allBooks()[0]?.amount).toBe(42);
  });
});

describe("V1-M1-T03: 部分適用の禁止(完了条件: 変換不能ケースで適用前状態が完全に保たれる)", () => {
  test("正当な op と変換不能な op を混ぜると、正当な側も適用されない", () => {
    setupRich([{ title: "銀河", memo: "", qty: "たくさん", status: "未読", author: "@" }]);
    const errors = expectRejectedNoop(
      destructive("d-mix", [
        { op: "add_field", table: "books", field: { id: "isbn", name: "ISBN", type: "text" } },
        { op: "change_field", table: "books", field: "qty", changes: { type: "number" } },
      ]),
    );
    expect(errors.length).toBeGreaterThan(0);
    // add_field 側も適用されていない。
    expect(columnsOf("books")).not.toContain("isbn");
  });

  test("changelog にもスナップショットにも痕跡が残らない", () => {
    setupRich([{ title: "銀河", memo: "", qty: "たくさん", status: "未読", author: "@" }]);
    const before = store.listChangelog(APP_ID).length;
    applyDiff(
      dataRoot,
      APP_ID,
      destructive("d-mix2", [
        { op: "change_field", table: "books", field: "qty", changes: { type: "number" } },
      ]),
    );
    const reader = KernelMetaStore.open(dataRoot);
    try {
      expect(reader.listChangelog(APP_ID)).toHaveLength(before);
    } finally {
      reader.close();
    }
    expect(listSnapshots(dataRoot, APP_ID)).toEqual([]);
  });
});

// ===========================================================================
// V1-M1-T03: プロパティテスト(検証方法の後半)
//
// 計画書 §V1-M1-T03 の検証方法:「プロパティテスト(ランダムデータでの
// **適用 → undo → 元と一致**)」。
//
// ## なぜ「バイト単位で一致するはず」なのか
//
// **undo は差分の逆適用ではない**(`undo.ts:12-15` / ADR-0004 §4)。対象 apply の
// **直前スナップショットを DB 全体として書き戻す**だけである。したがって
// 「元と一致」は論理的な同値ではなく **`manifest.json` のバイト列と `app.sqlite` の
// 内容がそのまま戻ること**を意味する。**成立しなければ、それ自体が発見である。**
//
// ## 何が一致し、何が一致しないか(明示する)
//
// | 観測項目 | 一致するか | 理由 |
// |---|---|---|
// | `manifest.json` のバイト列 | **する** | スナップショットからのファイルコピー |
// | PRAGMA の実スキーマ | **する** | `app.sqlite` ごと書き戻す |
// | 全テーブルの全行 | **する** | 同上 |
// | **changelog** | **しない** | **undo 自身が1行足す**(`kind: "undo"`)。
// |   |   | changelog は `kernel.sqlite` にあり、スナップショットの対象外である。
// |   |   | apply で1行、undo で1行増えるので **+2 行**になる。
// |   |   | これは欠陥ではなく憲法5(履歴は追記専用)の帰結である |
// | スナップショットディレクトリ | **しない** | apply が取った1件が残る。
// |   |   | 「失敗の痕跡も成功の痕跡も黙って消さない」(`apply-diff.ts` の方針) |
// ===========================================================================

/** 再現可能な擬似乱数(mulberry32)。落ちたときに同じ列を再現できることが要件。 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** アプリDBの全テーブルの全行を、テーブル名昇順・_id 昇順で読む。 */
function readAllRows(): Record<string, Record<string, unknown>[]> {
  return withDb((db) => {
    const tables = db
      .query<{ name: string }, []>(
        `SELECT "name" FROM "sqlite_master" WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%' ORDER BY "name"`,
      )
      .all()
      .map((row) => row.name);
    const out: Record<string, Record<string, unknown>[]> = {};
    for (const table of tables) {
      out[table] = db
        .query<Record<string, unknown>, []>(`SELECT * FROM "${table}" ORDER BY "_id"`)
        .all();
    }
    return out;
  });
}

/** PRAGMA の実スキーマ(列名 + 宣言型)。列型が戻ることまで見る。 */
function readSchemaWithTypes(): Record<string, [string, string][]> {
  return withDb((db) => {
    const tables = db
      .query<{ name: string }, []>(
        `SELECT "name" FROM "sqlite_master" WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%' ORDER BY "name"`,
      )
      .all()
      .map((row) => row.name);
    const out: Record<string, [string, string][]> = {};
    for (const table of tables) {
      out[table] = db
        .query<{ name: string; type: string }, []>(`PRAGMA table_info("${table}")`)
        .all()
        .map((row) => [row.name, row.type] as [string, string]);
    }
    return out;
  });
}

function readChangelogRows(): { diff_id: string; kind: string }[] {
  const reader = KernelMetaStore.open(dataRoot);
  try {
    return reader.listChangelog(APP_ID).map((entry) => ({
      diff_id: entry.diff_id,
      kind: entry.kind,
    }));
  } finally {
    reader.close();
  }
}

describe("V1-M1-T03 プロパティテスト: 適用 → undo → 元と一致", () => {
  /**
   * ランダムな行データに対して、破壊的 op を1つ適用し、undo して元に戻ることを見る。
   *
   * **op はランダムに選ぶが、「適用が成功する」ものだけを対象にする。** 拒否された
   * 差分は状態を変えないので、undo の検査にならない(それは
   * `destructive-rejection.test.ts` の担当である)。
   */
  const DESTRUCTIVE_CASES: { name: string; operations: unknown[] }[] = [
    {
      name: "remove_field(列とデータが消える)",
      operations: [
        // **sort / filter も外さないと通らない。** カスケード削除を採らないので
        // (ADR-0010 §7a)、qty を指している場所を1つでも残すと参照整合性で落ちる。
        {
          op: "update_view",
          view: "book-list",
          changes: { columns: ["title"], sort: { field: "title", order: "desc" } },
        },
        { op: "update_view", view: "book-form", changes: { fields: ["title"] } },
        { op: "update_view", view: "book-detail", changes: { fields: ["title"] } },
        { op: "remove_field", table: "books", field: "qty" },
      ],
    },
    {
      name: "remove_table(テーブルごと消える)",
      operations: [
        { op: "remove_field", table: "books", field: "author" },
        { op: "remove_table", table: "authors" },
      ],
    },
    {
      name: "change_table(テーブルのリネーム)",
      operations: [{ op: "change_table", table: "books", changes: { id: "volumes" } }],
    },
    {
      name: "change_field(列のリネーム。層1)",
      operations: [{ op: "change_field", table: "books", field: "memo", changes: { id: "note" } }],
    },
    {
      name: "change_field(型変更 text → number。層2 = テーブル再構築)",
      operations: [
        { op: "change_field", table: "books", field: "qty", changes: { type: "number" } },
      ],
    },
    {
      name: "change_field(型変更 + リネーム同時。層2)",
      operations: [
        {
          op: "change_field",
          table: "books",
          field: "qty",
          changes: { id: "amount", type: "number", name: "数" },
        },
      ],
    },
  ];

  for (const [caseIndex, testCase] of DESTRUCTIVE_CASES.entries()) {
    test(`${testCase.name}: undo でバイト単位に元へ戻る`, () => {
      const random = makeRandom(0x5eed + caseIndex);
      // ランダムな行数・ランダムな値。qty は必ず数値としてパースできる文字列にする
      // (層2 の変換が成功する必要があるため。変換不能ケースは別テストが見ている)。
      const rowCount = 1 + Math.floor(random() * 12);
      const rows: Record<string, unknown>[] = [];
      for (let index = 0; index < rowCount; index += 1) {
        rows.push({
          title: `本${Math.floor(random() * 100000)}`,
          memo: random() < 0.3 ? "" : `メモ${Math.floor(random() * 1000)}`,
          qty: String(Math.floor(random() * 500)),
          status: random() < 0.5 ? "未読" : "読了",
          author: "@",
        });
      }
      setupRich(rows);

      // --- 適用前の状態を、4つの読み方で観測する ---------------------------
      const beforeManifest = readManifestText();
      const beforeSchema = readSchemaWithTypes();
      const beforeRows = readAllRows();
      const beforeChangelog = readChangelogRows();

      const applied = applyDiff(
        dataRoot,
        APP_ID,
        destructive(`d-prop-${caseIndex}`, testCase.operations),
      );
      expect(applied.valid).toBe(true);
      if (!applied.valid) {
        return;
      }

      // 適用によって**実際に何かが変わった**ことを先に確かめる。
      // これが無いと「何も起きなかったものを undo した」を緑にしてしまう。
      const changed =
        readManifestText() !== beforeManifest ||
        JSON.stringify(readSchemaWithTypes()) !== JSON.stringify(beforeSchema);
      expect(changed).toBe(true);

      // --- undo ------------------------------------------------------------
      const undone = undo(dataRoot, APP_ID);
      expect(undone.valid).toBe(true);

      // --- 一致するもの: マニフェストのバイト列・実スキーマ・全行 -----------
      expect(readManifestText()).toBe(beforeManifest);
      expect(readSchemaWithTypes()).toEqual(beforeSchema);
      expect(readAllRows()).toEqual(beforeRows);

      // --- 一致しないもの: changelog(undo 自身が1行足す)-------------------
      const afterChangelog = readChangelogRows();
      expect(afterChangelog).not.toEqual(beforeChangelog);
      expect(afterChangelog).toHaveLength(beforeChangelog.length + 2);
      expect(afterChangelog.at(-2)?.kind).toBe("apply");
      expect(afterChangelog.at(-1)?.kind).toBe("undo");
      // 先頭部分は1バイトも書き換わっていない(履歴は追記専用。憲法5)。
      expect(afterChangelog.slice(0, beforeChangelog.length)).toEqual(beforeChangelog);

      // --- 一致しないもの: スナップショット ---------------------------------
      // **実測して分かったこと: 2件になる。** apply が取った1件だけではなく、
      // **undo 自身も戻す前にスナップショットを取る**(`undo.ts`)。
      // undo は DB 全体を巻き戻す破壊的な操作なので、その直前状態も残す ——
      // 「失敗の痕跡も成功の痕跡も黙って消さない」という `apply-diff.ts` の方針が
      // undo 側にも一貫して効いている。
      expect(listSnapshots(dataRoot, APP_ID)).toHaveLength(2);
    });
  }

  test("同じ破壊的 op を連続適用 → 連続 undo でも、最初の状態にバイト単位で戻る", () => {
    setupRich([
      { title: "銀河", memo: "42", qty: "3", status: "読了", author: "@" },
      { title: "軽さ", memo: "", qty: "1", status: "未読", author: "@" },
    ]);
    const beforeManifest = readManifestText();
    const beforeSchema = readSchemaWithTypes();
    const beforeRows = readAllRows();

    // 2回に分けて壊す。
    expect(
      applyDiff(
        dataRoot,
        APP_ID,
        destructive("d-prop-a", [
          { op: "change_field", table: "books", field: "qty", changes: { type: "number" } },
        ]),
      ).valid,
    ).toBe(true);
    expect(
      applyDiff(
        dataRoot,
        APP_ID,
        destructive("d-prop-b", [
          { op: "change_table", table: "books", changes: { id: "volumes" } },
        ]),
      ).valid,
    ).toBe(true);

    // 連続 undo は古い方へ1つずつ遡る(ADR-0004 §1)。
    expect(undo(dataRoot, APP_ID).valid).toBe(true);
    expect(undo(dataRoot, APP_ID).valid).toBe(true);

    expect(readManifestText()).toBe(beforeManifest);
    expect(readSchemaWithTypes()).toEqual(beforeSchema);
    expect(readAllRows()).toEqual(beforeRows);
  });

  test("undo は apply 以降に追加されたレコードも消す(ADR-0004 §4 の危険が破壊的 op でも同じであること)", () => {
    // **これは「戻る」ことの確認ではなく、「戻しすぎる」ことの確認である。**
    // ADR-0010 §2(a) が不利な材料として挙げた性質そのものを、実測で固定する。
    setupRich([{ title: "銀河", memo: "", qty: "3", status: "読了", author: "@" }]);
    expect(
      applyDiff(
        dataRoot,
        APP_ID,
        destructive("d-prop-c", [
          { op: "change_field", table: "books", field: "qty", changes: { type: "number" } },
        ]),
      ).valid,
    ).toBe(true);

    // apply の後に人間がレコードを1件入れる。
    withDb((db) => {
      const result = createRecord(db, readManifestFile(), "books", {
        title: "あとから入れた本",
        qty: 99,
      });
      if (!result.ok) {
        throw new Error(JSON.stringify(result.errors));
      }
    });
    expect(allBooks()).toHaveLength(2);

    expect(undo(dataRoot, APP_ID).valid).toBe(true);

    // **消える。** スキーマは戻るが、その間に入力されたデータも一緒に失われる。
    expect(allBooks()).toHaveLength(1);
    expect(allBooks().map((row) => row.title)).toEqual(["銀河"]);
  });
});

// ===========================================================================
// V1-M1-T03: T02 の申し送りへの回答
//
// `records/v1-m1-t02.md` §9 限界1:
//   「実際の変換不能値でドライランを1度も走らせていない。…… T03 が実測すること ——
//    具体的には、change_field { type } で変換不能行があるケースについて
//    dryRunDiff と applyDiff の errors が toEqual であることを、T03 側のテストで固定する。」
// ===========================================================================

describe("V1-M1-T03: 変換不能値でのドライランと実適用の一致(T02 §9 限界1 への回答)", () => {
  test("change_field { type } の変換不能ケースで、dryRunDiff と applyDiff の errors が一致する", () => {
    setupRich([
      { title: "銀河", memo: "", qty: "42", status: "未読", author: "@" },
      { title: "軽さ", memo: "", qty: "たくさん", status: "読了", author: "@" },
      { title: "壊れ", memo: "", qty: "いっぱい", status: "未読", author: "@" },
    ]);
    const diff = destructive("d-dry-unconvertible", [
      { op: "change_field", table: "books", field: "qty", changes: { type: "number" } },
    ]);

    const dry = dryRunDiff(dataRoot, APP_ID, diff);
    const applied = applyDiff(dataRoot, APP_ID, diff);

    expect(dry.valid).toBe(false);
    expect(applied.valid).toBe(false);
    if (dry.valid || applied.valid) {
      return;
    }
    // **一字一句同じであること。** T02 が「論証であって実測ではない」と申告した箇所。
    expect(dry.errors).toEqual(applied.errors);
    // 中身が空でないこと(両方 [] でも toEqual は通ってしまう)。
    expect(dry.errors).toHaveLength(1);
    expect(dry.errors[0]?.message).toContain("たくさん");
    expect(dry.errors[0]?.message).toContain("いっぱい");
  });

  test("options 削除 / required 格上げ / 不能セルでも errors が一致する", () => {
    setupRich([{ title: "銀河", memo: "", qty: "1", status: "読了", author: "@" }]);
    const cases: unknown[] = [
      destructive("d-dry-options", [
        { op: "change_field", table: "books", field: "status", changes: { options: ["未読"] } },
      ]),
      destructive("d-dry-required", [
        { op: "change_field", table: "books", field: "memo", changes: { required: true } },
      ]),
      destructive("d-dry-impossible", [
        { op: "change_field", table: "books", field: "memo", changes: { type: "date" } },
        { op: "change_field", table: "books", field: "memo", changes: { type: "number" } },
      ]),
    ];
    for (const diff of cases) {
      const dry = dryRunDiff(dataRoot, APP_ID, diff);
      const applied = applyDiff(dataRoot, APP_ID, diff);
      expect(dry.valid).toBe(false);
      expect(applied.valid).toBe(false);
      if (dry.valid || applied.valid) {
        continue;
      }
      expect(dry.errors).toEqual(applied.errors);
      expect(dry.errors.length).toBeGreaterThan(0);
    }
  });

  test("成功する破壊的 op でも、ドライランのレポートが実適用と一致する", () => {
    setupRich([
      { title: "銀河", memo: "", qty: "42", status: "未読", author: "@" },
      { title: "軽さ", memo: "", qty: "7", status: "読了", author: "@" },
    ]);
    const diff = destructive("d-dry-ok", [
      { op: "change_field", table: "books", field: "qty", changes: { type: "number" } },
    ]);

    const dry = dryRunDiff(dataRoot, APP_ID, diff);
    expect(dry.valid).toBe(true);
    if (!dry.valid) {
      return;
    }
    // 本体は1バイトも変わっていない(ドライランの本質)。
    const beforeManifest = readManifestText();
    const beforeSchema = readSchemaWithTypes();

    const applied = applyDiff(dataRoot, APP_ID, diff);
    expect(applied.valid).toBe(true);
    if (!applied.valid) {
      return;
    }
    expect(beforeManifest).not.toBe(readManifestText());
    expect(dry.report.manifest).toEqual(applied.manifest);
    expect(dry.report.plan).toEqual(applied.plan);
    // 実 SQLite スキーマ(列の並び)まで一致する。
    expect(dry.report.schema).toEqual(readSchema());
    // 層2 の再構築でも列型が一致する(NUMERIC になっている)。
    expect(beforeSchema.books?.find(([name]) => name === "qty")?.[1]).toBe("TEXT");
    expect(readSchemaWithTypes().books?.find(([name]) => name === "qty")?.[1]).toBe("NUMERIC");
  });
});

/**
 * **列ごとのプリセットのマップキーは、`columns` と同じく参照整合性の対象である**
 * (V3-M2-T01 追加分。D-G4 / ADR-0050)。
 *
 * 検査を足すと**2つの既存の意味論に当たる**ので、両方をここで固定する:
 *
 * 1. **`remove_field` はカスケードしない**(ADR-0010 §7a)—— まだ画面から参照されている
 *    フィールドを消そうとすると差分全体が拒否される。**プリセットもその「参照」に入る。**
 *    したがって **`stored` 読み取りが後から壊れることはない**(過去の undo は壊れない)——
 *    参照が残ったままフィールドが消える状態を、そもそも作れない。
 * 2. **`change_field` の rename は追随する**(§5d)—— `columns` / `sort` / `filter` /
 *    `fields` が新IDへ写るのと同じく、**プリセットのマップキーも写る。**
 *    追随させないと「プリセットを1つ書いた画面があるだけで rename が拒否される」ことになる。
 */
describe("V3-M2-T01: 列ごとのプリセットと破壊的 op の相互作用(ADR-0050)", () => {
  /** rich マニフェストの list_view にプリセットを2軸書いた状態にする。 */
  function setupWithPresets(): void {
    setupRich([{ title: "銀河", memo: "", qty: "7", status: "読了", author: "@" }]);
    const applied = applyDiff(dataRoot, APP_ID, {
      diff_id: "d-preset",
      intent: "一覧の見せ方を選ぶ",
      operations: [
        {
          op: "update_view",
          view: "book-list",
          changes: {
            preset_column_align: { title: "left", qty: "right" },
            preset_column_width: { qty: "narrow" },
          },
        },
      ],
    });
    expect(applied.valid, JSON.stringify(applied)).toBe(true);
  }

  test("プリセットだけが参照しているフィールドの remove_field は拒否される(カスケードしない)", () => {
    setupWithPresets();
    // `qty` は columns / sort / fields からも参照されているので、**プリセットだけが
    // 参照している状態**を先に作る —— columns / sort / filter / fields から外す。
    const detached = applyDiff(dataRoot, APP_ID, {
      diff_id: "d-detach",
      intent: "qty を画面の項目から外す",
      operations: [
        {
          op: "update_view",
          view: "book-list",
          changes: { columns: ["title", "memo"], sort: { field: "title", order: "asc" } },
        },
        { op: "update_view", view: "book-form", changes: { fields: ["title", "memo"] } },
        { op: "update_view", view: "book-detail", changes: { fields: ["title"] } },
      ],
    });
    expect(detached.valid, JSON.stringify(detached)).toBe(true);

    const errors = expectRejectedNoop(
      destructive("d-rm", [{ op: "remove_field", table: "books", field: "qty" }]),
    );
    // **プリセットの参照だけで拒否される。** ここが緑にならないと「黙って通って黙って効かない」。
    const preset = errors.filter((error) => error.path.startsWith("/app/views/0/preset_"));
    expect(preset.map((error) => error.path).sort()).toEqual([
      "/app/views/0/preset_column_align/qty",
      "/app/views/0/preset_column_width/qty",
    ]);
    // **hint が実行可能な手順を示している**(ADR-0012 が「実行不能な手順は『できません』より
    // 悪い」と定めた形)。プリセットに触れずに columns だけ直しても直らないので、
    // 案内にプリセットが出ていなければ AI は同じ壁に当たり続ける。
    for (const error of preset) {
      expect(error.hint).toContain("update_view");
      expect(error.hint).toContain("preset_column_align");
      expect(error.hint).toContain("preset_column_width");
    }
  });

  test("プリセットから先に外せば remove_field は通る(逃げ道が実在する)", () => {
    setupWithPresets();
    const result = applyDiff(dataRoot, APP_ID, {
      diff_id: "d-rm2",
      intent: "qty を消す。先に画面から外す",
      operations: [
        {
          op: "update_view",
          view: "book-list",
          changes: {
            columns: ["title", "memo"],
            sort: { field: "title", order: "asc" },
            preset_column_align: { title: "left" },
            preset_column_width: { title: "wide" },
          },
        },
        { op: "update_view", view: "book-form", changes: { fields: ["title", "memo"] } },
        { op: "update_view", view: "book-detail", changes: { fields: ["title"] } },
        { op: "remove_field", table: "books", field: "qty" },
      ],
    });
    expect(result.valid, JSON.stringify(result)).toBe(true);
    if (!result.valid) {
      return;
    }
    expect(columnsOf("books")).not.toContain("qty");
  });

  test("change_field の rename にプリセットのマップキーが追随する(§5d)", () => {
    setupWithPresets();
    const result = applyDiff(
      dataRoot,
      APP_ID,
      destructive("d-cf-preset", [
        { op: "change_field", table: "books", field: "qty", changes: { id: "amount" } },
      ]),
    );
    expect(result.valid, JSON.stringify(result)).toBe(true);
    if (!result.valid) {
      return;
    }
    const list = result.manifest.app.views[0];
    if (list?.type !== "list_view") {
      throw new Error("fixture broken");
    }
    // **キーが新IDへ写る**(値は1バイトも変わらない)。追随しなければ参照整合性で拒否され、
    // 「プリセットを書いた画面があるだけで rename ができない」ことになる。
    expect(list.preset_column_align).toEqual({ title: "left", amount: "right" });
    expect(list.preset_column_width).toEqual({ amount: "narrow" });
    // 既存の追随(columns / sort)も壊れていない。
    expect(list.columns).toEqual(["title", "memo", "amount"]);
  });

  test("rename の追随は同じテーブルを見ているビューにだけ掛かる(別テーブルの同名キーは動かない)", () => {
    setupWithPresets();
    // authors を見る list_view を足し、books と同名の `title` キーをプリセットに持たせる。
    const added = applyDiff(dataRoot, APP_ID, {
      diff_id: "d-add-view",
      intent: "著者の一覧を足す",
      operations: [
        {
          op: "add_view",
          view: {
            id: "author-list",
            type: "list_view",
            table: "authors",
            columns: ["name"],
            preset_column_align: { name: "left" },
          },
        },
      ],
    });
    expect(added.valid, JSON.stringify(added)).toBe(true);

    const result = applyDiff(
      dataRoot,
      APP_ID,
      destructive("d-cf-other", [
        { op: "change_field", table: "authors", field: "name", changes: { id: "full_name" } },
      ]),
    );
    expect(result.valid, JSON.stringify(result)).toBe(true);
    if (!result.valid) {
      return;
    }
    const bookList = result.manifest.app.views[0];
    const authorList = result.manifest.app.views.find((view) => view.id === "author-list");
    if (bookList?.type !== "list_view" || authorList?.type !== "list_view") {
      throw new Error("fixture broken");
    }
    expect(authorList.preset_column_align).toEqual({ full_name: "left" });
    // books 側は1バイトも動かない(別テーブルの同名フィールドは別のフィールドである)。
    expect(bookList.preset_column_align).toEqual({ title: "left", qty: "right" });
  });

  test("add_view で実在しないフィールドIDをプリセットのキーに書くと拒否される", () => {
    setupRich();
    const errors = expectRejectedNoop(
      destructive("d-add-bad", [
        {
          op: "add_view",
          view: {
            id: "bad-list",
            type: "list_view",
            table: "books",
            columns: ["title"],
            preset_column_align: { titel: "left" },
          },
        },
      ]),
    );
    expect(errors.some((error) => error.path === "/app/views/3/preset_column_align/titel")).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// V3-M5-T02(門A 差し戻し後の再開): update_view で逃げ道の参照を運ぶ
// ---------------------------------------------------------------------------
//
// **判定の出所**: `docs/adr/0055-escape-hatch-custom-css.md` **改訂1**(限定3 に禁止形を
// 足した。**`view_changes` は 12 → 13。足す形は manifest 側の `$ref` に限る**)/
// 索引 [`v3-m5-gate-a.md`](../../docs/plan/v3/records/v3-m5-gate-a.md) §6-1。
//
// **`DIFF_OPS` は16のままである** —— 新しい差分操作を1つも作っていない(限定3)。

describe("V3-M5-T02: update_view で逃げ道の参照を付与・差し替え・除去する(ADR-0055 改訂1)", () => {
  const DIGEST_A = "a".repeat(64);
  const DIGEST_B = "b".repeat(64);

  /** 逃げ道の参照を差し替える update_view 1本だけの差分。 */
  function updateCssDiff(
    diffId: string,
    viewId: string,
    custom: { asset: string; digest: string },
    intent = "印刷の体裁を整えたい",
  ): Diff {
    return {
      diff_id: diffId,
      intent,
      operations: [{ op: "update_view", view: viewId, changes: { custom_css: custom } }],
    };
  }

  test("既存の list_view に参照を付与できる(remove_view + add_view を要しない)", () => {
    const result = applyDiff(
      dataRoot,
      APP_ID,
      updateCssDiff("d-css-1", "book-list", { asset: "print", digest: DIGEST_A }),
    );
    expect(result.valid).toBe(true);
    const view = readManifestFile().app.views.find((v) => v.id === "book-list");
    expect(view?.custom_css).toEqual({ asset: "print", digest: DIGEST_A });
    // **他のキーは1バイトも動いていない**(キー単位の差し替えであり全置換ではない)。
    expect(view?.type === "list_view" ? view.columns : undefined).toEqual(["title"]);
  });

  test("既存の form にも付与できる(プリセット7軸が1つも書けない画面種である)", () => {
    const result = applyDiff(
      dataRoot,
      APP_ID,
      updateCssDiff("d-css-2", "book-form", { asset: "print", digest: DIGEST_A }),
    );
    expect(result.valid).toBe(true);
    const view = readManifestFile().app.views.find((v) => v.id === "book-form");
    expect(view?.custom_css).toEqual({ asset: "print", digest: DIGEST_A });
    expect(view?.type === "form" ? view.fields : undefined).toEqual(["title", "memo"]);
  });

  test("detail_view にも付与できる(3種すべてで書ける)", () => {
    expect(
      applyDiff(dataRoot, APP_ID, {
        diff_id: "d-css-3a",
        intent: "詳細画面を足す",
        operations: [
          { op: "add_view", view: { id: "book-detail", type: "detail_view", table: "books" } },
        ],
      }).valid,
    ).toBe(true);
    expect(
      applyDiff(
        dataRoot,
        APP_ID,
        updateCssDiff("d-css-3b", "book-detail", { asset: "print", digest: DIGEST_A }),
      ).valid,
    ).toBe(true);
    const view = readManifestFile().app.views.find((v) => v.id === "book-detail");
    expect(view?.custom_css).toEqual({ asset: "print", digest: DIGEST_A });
  });

  test("参照を別の版へ差し替えられる(1 op で済む。2 op の回避路は要らなくなった)", () => {
    applyDiff(
      dataRoot,
      APP_ID,
      updateCssDiff("d-css-4a", "book-list", { asset: "print", digest: DIGEST_A }),
    );
    const result = applyDiff(
      dataRoot,
      APP_ID,
      updateCssDiff(
        "d-css-4b",
        "book-list",
        { asset: "print", digest: DIGEST_B },
        "字間を広げた版に差し替える",
      ),
    );
    expect(result.valid).toBe(true);
    expect(readManifestFile().app.views[0]?.custom_css).toEqual({
      asset: "print",
      digest: DIGEST_B,
    });
    // **undo で1つ前の版に戻る**(op が1つなので戻り方も1つである)。
    expect(undo(dataRoot, APP_ID).valid).toBe(true);
    expect(readManifestFile().app.views[0]?.custom_css).toEqual({
      asset: "print",
      digest: DIGEST_A,
    });
  });

  test("**除去は前進ではできない** —— キーを消す手段が語彙に無い(プリセット7キーと同じ性質)", () => {
    applyDiff(
      dataRoot,
      APP_ID,
      updateCssDiff("d-css-5", "book-list", { asset: "print", digest: DIGEST_A }),
    );

    // (a) `null` を書いて消すことはできない(型不正で拒否される)。
    const nulled = applyDiff(dataRoot, APP_ID, {
      diff_id: "d-css-5a",
      intent: "逃げ道をやめたい",
      operations: [{ op: "update_view", view: "book-list", changes: { custom_css: null } }],
    } as unknown as Diff);
    expect(nulled.valid).toBe(false);

    // (b) 空オブジェクトも書けない(2要素とも required)。
    const emptied = applyDiff(dataRoot, APP_ID, {
      diff_id: "d-css-5b",
      intent: "逃げ道をやめたい",
      operations: [{ op: "update_view", view: "book-list", changes: { custom_css: {} } }],
    } as unknown as Diff);
    expect(emptied.valid).toBe(false);

    // (c) 書かなければ「触らない」の意味なので、参照は残ったままである。
    expect(
      applyDiff(dataRoot, APP_ID, {
        diff_id: "d-css-5c",
        intent: "列だけ変える",
        operations: [
          { op: "update_view", view: "book-list", changes: { columns: ["title", "memo"] } },
        ],
      }).valid,
    ).toBe(true);
    expect(readManifestFile().app.views[0]?.custom_css).toEqual({
      asset: "print",
      digest: DIGEST_A,
    });

    // (d) **外す道は2つ**: undo で戻すか、`remove_view` + `add_view` で作り直すか。
    expect(
      applyDiff(dataRoot, APP_ID, {
        diff_id: "d-css-5d",
        intent: "標準の体裁に戻す",
        operations: [
          { op: "remove_view", view: "book-list" },
          {
            op: "add_view",
            view: {
              id: "book-list",
              type: "list_view",
              table: "books",
              columns: ["title", "memo"],
            },
          },
        ],
      }).valid,
    ).toBe(true);
    expect(
      readManifestFile().app.views.find((v) => v.id === "book-list")?.custom_css,
    ).toBeUndefined();
  });

  test("参照の追加・差し替えが changelog に intent つきで載る(憲法5)", () => {
    applyDiff(
      dataRoot,
      APP_ID,
      updateCssDiff(
        "d-css-6a",
        "book-list",
        { asset: "print", digest: DIGEST_A },
        "印刷の体裁を整えたい",
      ),
    );
    applyDiff(
      dataRoot,
      APP_ID,
      updateCssDiff(
        "d-css-6b",
        "book-list",
        { asset: "print", digest: DIGEST_B },
        "字間を広げたいと言われた",
      ),
    );

    const entries = store.listChangelog(APP_ID);
    const added = entries.find((e) => e.diff_id === "d-css-6a");
    const swapped = entries.find((e) => e.diff_id === "d-css-6b");
    expect(added?.intent).toBe("印刷の体裁を整えたい");
    expect(JSON.stringify(added?.operations)).toContain(DIGEST_A);
    expect(swapped?.intent).toBe("字間を広げたいと言われた");
    expect(JSON.stringify(swapped?.operations)).toContain(DIGEST_B);
    // **1 op で読める** —— remove_view + add_view の2 op ではない(可読性の回復)。
    expect(swapped?.operations).toHaveLength(1);
  });

  test("形の縛りは manifest 側と同じである(定義を二重に持たない = 改訂1 の禁止形)", () => {
    for (const bad of [
      { asset: "print" },
      { digest: DIGEST_A },
      { asset: "print", digest: "not-a-sha256" },
      { asset: "Print", digest: DIGEST_A },
      { asset: "print", digest: DIGEST_A, css: ".x{}" },
      ".x { color: red }",
    ]) {
      const result = applyDiff(dataRoot, APP_ID, {
        diff_id: "d-css-bad",
        intent: "壊れた参照",
        operations: [{ op: "update_view", view: "book-list", changes: { custom_css: bad } }],
      } as unknown as Diff);
      expect(result.valid, JSON.stringify(bad)).toBe(false);
    }
  });
});

/*
 * **`V7-M1-T03` / `Z-G37`**: **すでに使っている表に、あとからアクセス権管理を有効にできる。**
 *
 * **本 describe が測るのは「値が適用後マニフェストに**実際に残る**か」だけである。**
 * **`representative_field` が作った「受理はされるが残らない」穴を繰り返さないための検査である**
 * (`ADR-0080` 限定6 の帰結。`schemas/diff.schema.json` の当該 `$comment` が逐語で申告している)。
 *
 * **【証明しないこと。先に書く】** **判定の実装は今日1バイトも無い** —— **この宣言を書いても、
 * 行の読取・書込・削除のふるまいは今日どおりである。** **指した表・列の実在も型も
 * 今日は1つも検査していない**(`V7-M1-T05` の担当)。**下の (6) / (7) がその「今日どうなるか」を
 * そのまま固定している。**
 */
describe("V7-M1-T03: change_table / add_table で書いた access_control が適用後マニフェストに残る(Z-G37)", () => {
  /** `v7-m0.md` §5-2 (a) の確定形を、この蔵書アプリの表名で書いたもの。 */
  const ACCESS_CONTROL = {
    enabled: true,
    permissions: [
      { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
      { id: "writer", name: "編集可", read: true, write: true, delete: false },
    ],
    creator_permission: "writer",
    grant: { table: "book_grant", target: "target", member: "member", permission: "permission" },
    members: { table: "member", account: "account", group: "group" },
    groups: { table: "team" },
    inherit_from: [],
  };

  /** 付与表・利用者表・グループ表を先に置く(**アクセス権管理はまだ有効にしない**)。 */
  function setupAccessTables(): void {
    const result = applyDiff(dataRoot, APP_ID, {
      diff_id: "d-ac-setup",
      intent: "付与・利用者・グループの表を置く",
      operations: [
        {
          op: "add_table",
          table: {
            id: "team",
            name: "グループ",
            fields: [{ id: "title", name: "名前", type: "text" }],
          },
        },
        {
          op: "add_table",
          table: {
            id: "member",
            name: "利用者",
            fields: [
              { id: "account", name: "ログイン", type: "text" },
              { id: "group", name: "グループ", type: "reference", reference_table: "team" },
            ],
          },
        },
        {
          op: "add_table",
          table: {
            id: "book_grant",
            name: "本の付与",
            fields: [
              { id: "target", name: "本", type: "reference", reference_table: "books" },
              { id: "member", name: "利用者", type: "reference", reference_table: "member" },
              { id: "permission", name: "権限", type: "select", options: ["reader", "writer"] },
            ],
          },
        },
      ],
    } as unknown as Diff);
    if (!result.valid) {
      throw new Error(`前提の表の投入に失敗: ${JSON.stringify(result.errors)}`);
    }
  }

  /** **ディスクに書かれた適用後マニフェスト**から、表の宣言をそのまま読む。 */
  function declarationOf(tableId: string): unknown {
    const table = readManifestFile().app.tables.find((candidate) => candidate.id === tableId);
    if (table === undefined) {
      throw new Error(`表 "${tableId}" が適用後マニフェストに無い`);
    }
    return (table as unknown as Record<string, unknown>).access_control;
  }

  function changeTable(diffId: string, tableId: string, changes: unknown) {
    return applyDiff(dataRoot, APP_ID, {
      diff_id: diffId,
      intent: "すでに使っている表にアクセス権管理を有効にする",
      operations: [{ op: "change_table", table: tableId, changes }],
    } as unknown as Diff);
  }

  test("(1) change_table で後から足した宣言が、ディスクの適用後マニフェストに残る", () => {
    setupAccessTables();
    // **有効にする前は宣言が無い**(オプトイン)。
    expect(declarationOf("books")).toBeUndefined();

    const result = changeTable("d-ac-1", "books", { access_control: ACCESS_CONTROL });
    expect(result.valid, JSON.stringify(result)).toBe(true);
    if (!result.valid) {
      return;
    }
    // 戻り値と**ディスクの両方**で測る(「受理はされるが残らない」を見逃さないため)。
    expect(
      (
        result.manifest.app.tables.find((t) => t.id === "books") as unknown as Record<
          string,
          unknown
        >
      ).access_control,
    ).toEqual(ACCESS_CONTROL);
    expect(declarationOf("books")).toEqual(ACCESS_CONTROL);
    // **他の表は1つも宣言を持たない。**
    expect(declarationOf("book_grant")).toBeUndefined();
    expect(declarationOf("member")).toBeUndefined();
  });

  test("(2) enabled: false に戻す change_table も効く(宣言は残り、enabled だけが false になる)", () => {
    setupAccessTables();
    expect(changeTable("d-ac-2a", "books", { access_control: ACCESS_CONTROL }).valid).toBe(true);
    const stopped = { ...ACCESS_CONTROL, enabled: false };
    expect(changeTable("d-ac-2b", "books", { access_control: stopped }).valid).toBe(true);
    expect(declarationOf("books")).toEqual(stopped);
  });

  test("(3) 丸ごと差し替える change_table は全置換である(前の任意キーが1つも残らない)", () => {
    setupAccessTables();
    expect(changeTable("d-ac-3a", "books", { access_control: ACCESS_CONTROL }).valid).toBe(true);
    // **【`V7-M1-T05` による更新】** **`grant.member` と `members` を落とせなくなった** ——
    // **相手を1人も指せない付与表は適用時検査(項目9)が拒否するためである。**
    // **本検査が測っているのは「全置換であること」であり、そこは1ミリも変わっていない**
    // (`groups` / `inherit_from` / `members.group` が残らないことで測る)。
    const minimal = {
      enabled: true,
      permissions: [{ id: "reader", name: "参照のみ", read: true, write: false, delete: false }],
      creator_permission: "reader",
      grant: { table: "book_grant", target: "target", member: "member", permission: "permission" },
      members: { table: "member", account: "account" },
    };
    expect(changeTable("d-ac-3b", "books", { access_control: minimal }).valid).toBe(true);
    // **併合ではない** —— 前に書いた groups / inherit_from も members.group も残らない。
    expect(declarationOf("books")).toEqual(minimal);
  });

  test("(4) add_table で最初から書いた宣言も、適用後マニフェストに残る", () => {
    setupAccessTables();
    // **【`V7-M1-T05` による更新】** **`ACCESS_CONTROL` をそのまま使えなくなった** ——
    // **`grant.target` は「その保護対象表を指す reference 項目」でなければならず、
    // `book_grant.target` は `books` を指しているためである**(適用時検査の項目3)。
    // **したがって `notes` 用の付与表を同じ差分の中で先に足す。**
    // **本検査が測っているのは「`add_table` で最初から書いた宣言が残ること」であり、
    // そこは1ミリも変わっていない。**
    const notesAccessControl = {
      ...ACCESS_CONTROL,
      grant: { table: "note_grant", target: "target", member: "member", permission: "permission" },
    };
    const result = applyDiff(dataRoot, APP_ID, {
      diff_id: "d-ac-4",
      intent: "最初から有効にした表を足す",
      operations: [
        {
          op: "add_table",
          table: {
            id: "note_grant",
            name: "覚え書きの付与",
            fields: [
              { id: "target", name: "覚え書き", type: "reference", reference_table: "notes" },
              { id: "member", name: "利用者", type: "reference", reference_table: "member" },
              { id: "permission", name: "権限", type: "select", options: ["reader", "writer"] },
            ],
          },
        },
        {
          op: "add_table",
          table: {
            id: "notes",
            name: "覚え書き",
            fields: [{ id: "title", name: "件名", type: "text" }],
            access_control: notesAccessControl,
          },
        },
      ],
    } as unknown as Diff);
    expect(result.valid, JSON.stringify(result)).toBe(true);
    expect(declarationOf("notes")).toEqual(notesAccessControl);
  });

  test("(5) access_control を書かない change_table は、既存の宣言を1バイトも触らない", () => {
    setupAccessTables();
    expect(changeTable("d-ac-5a", "books", { access_control: ACCESS_CONTROL }).valid).toBe(true);
    expect(changeTable("d-ac-5b", "books", { name: "蔵書" }).valid).toBe(true);
    expect(declarationOf("books")).toEqual(ACCESS_CONTROL);
  });

  test("(6) 指している列を remove_field で消す差分は拒否される(V7-M1-T05 が止めた)", () => {
    // **【`V7-M1-T05` による期待値の更新。検査は1本も消していない】**
    // **着手前はここが「今日は通り、宣言は指したまま残る」を測っていた**
    // (`V7-M1-T03` の記録 §2-3 (g) が実測して `V7-M1-T05` へ送った宿題)。
    // **今日は差分**全体**が拒否される** —— 適用後マニフェストが規約から外れるためである。
    setupAccessTables();
    expect(changeTable("d-ac-6a", "books", { access_control: ACCESS_CONTROL }).valid).toBe(true);
    const result = applyDiff(dataRoot, APP_ID, {
      diff_id: "d-ac-6b",
      intent: "付与表から権限の列を消す",
      operations: [{ op: "remove_field", table: "book_grant", field: "permission" }],
    } as unknown as Diff);
    expect(result.valid).toBe(false);
    if (result.valid) {
      return;
    }
    expect(result.errors.map((error) => error.path)).toContain(
      "/app/tables/0/access_control/grant/permission",
    );
    // **列も宣言も1バイトも変わっていない**(差分全体が拒否されたので当然だが、実測する)。
    expect(declarationOf("books")).toEqual(ACCESS_CONTROL);
    expect(
      readManifestFile()
        .app.tables.find((t) => t.id === "book_grant")
        ?.fields.map((f) => f.id),
    ).toEqual(["target", "member", "permission"]);
  });

  test("(7) 指している表を change_table でリネームする差分は拒否される(V7-M1-T05 が止めた)", () => {
    // **【`V7-M1-T05` による期待値の更新。検査は1本も消していない】**
    // **着手前はここが「リネームは通り、宣言は追随せず古い表名のまま残る」を測っていた。**
    // **今日は差分**全体**が拒否される。** **【誇張しない】止まっただけであって、
    // 宣言が新しい表名に**追随するようにはなっていない** —— リネームしたければ
    // `access_control` の側も同じ差分の中で書き換える必要がある。
    setupAccessTables();
    expect(changeTable("d-ac-7a", "books", { access_control: ACCESS_CONTROL }).valid).toBe(true);
    const result = changeTable("d-ac-7b", "team", { id: "teams" });
    expect(result.valid).toBe(false);
    if (result.valid) {
      return;
    }
    expect(result.errors.map((error) => error.path)).toContain(
      "/app/tables/0/access_control/groups/table",
    );
    // **表の名前も宣言も1バイトも変わっていない。**
    expect((declarationOf("books") as { groups: { table: string } }).groups.table).toBe("team");
    expect(readManifestFile().app.tables.map((t) => t.id)).toContain("team");
    expect(readManifestFile().app.tables.map((t) => t.id)).not.toContain("teams");
  });

  test("(8) 同じ差分の中で宣言も一緒に書き換えれば、表のリネームは通る(逃げ道が在ることの実測)", () => {
    setupAccessTables();
    expect(changeTable("d-ac-8a", "books", { access_control: ACCESS_CONTROL }).valid).toBe(true);
    const renamed = { ...ACCESS_CONTROL, groups: { table: "teams" } };
    const result = applyDiff(dataRoot, APP_ID, {
      diff_id: "d-ac-8b",
      intent: "グループの表の名前を変え、宣言も一緒に書き換える",
      operations: [
        { op: "change_table", table: "team", changes: { id: "teams" } },
        { op: "change_table", table: "books", changes: { access_control: renamed } },
      ],
    } as unknown as Diff);
    expect(result.valid, JSON.stringify(result)).toBe(true);
    expect(declarationOf("books")).toEqual(renamed);
    expect(readManifestFile().app.tables.map((t) => t.id)).toContain("teams");
  });
});
