import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifest, readCurrentManifest } from "./apply-manifest.ts";
import { createApp } from "./create-app.ts";
import { quoteIdentifier } from "./ddl.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { appDbPath, appManifestPath } from "./storage-paths.ts";
import type { Manifest } from "./types.ts";

const FIXTURE_DIR = join(import.meta.dir, "..", "..", "fixtures");

function loadFixture(relativePath: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, relativePath), "utf-8")) as unknown;
}

type ColumnInfo = { cid: number; name: string; type: string; notnull: number; pk: number };

function tableNames(db: Database): string[] {
  const rows = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

function tableInfo(db: Database, tableId: string): ColumnInfo[] {
  return db.query(`PRAGMA table_info(${quoteIdentifier(tableId)})`).all() as ColumnInfo[];
}

/**
 * 「状態」= app.sqlite のスキーマ全体 + manifest.json の生バイト列。
 * 拒否の前後でこれが完全一致することを検査するために使う。
 */
type AppState = {
  schema: Record<string, ColumnInfo[]>;
  manifestText: string;
};

function captureState(dataRoot: string, appId: string): AppState {
  const db = new Database(appDbPath(dataRoot, appId), { readonly: true });
  try {
    const schema: Record<string, ColumnInfo[]> = {};
    for (const name of tableNames(db)) {
      schema[name] = tableInfo(db, name);
    }
    return { schema, manifestText: readFileSync(appManifestPath(dataRoot, appId), "utf-8") };
  } finally {
    db.close();
  }
}

let dataRoot: string;
let store: KernelMetaStore;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-apply-manifest-"));
  store = KernelMetaStore.open(dataRoot);
});

afterEach(async () => {
  store.close();
  await rm(dataRoot, { recursive: true, force: true });
});

function newApp(appId: string, name: string): void {
  createApp(store, name, { app_id: appId });
}

function bookTracker(): Manifest {
  return loadFixture("valid/book-tracker.json") as Manifest;
}

describe("readCurrentManifest", () => {
  /*
   * **【`V8-M17` / `J-G2`(`ADR-0007` 門A 本審査 = 限定採用)による追随。2026-08-09】**
   * **空マニフェストに既定の役割定義3本(`owner` / `editor` / `viewer`)が入った。**
   * **3本とも規則(`rules`)を1本も持たない**(裁定 `R-13-3`)—— **規則を持たない役割は
   * 面の管轄外(全許可)なので、ふるまいは着手前と1ミリも変わらない**(裁定 `R-4`)。
   * **`tables: []` / `views: []` の主張は1ミリも弱めていない。**
   */
  test("作成直後のアプリからは空マニフェストが読める(役割の既定3本を持つ)", () => {
    newApp("book-tracker", "蔵書管理");
    const manifest = readCurrentManifest(dataRoot, "book-tracker");
    expect(manifest).toEqual({
      app: {
        id: "book-tracker",
        name: "蔵書管理",
        tables: [],
        views: [],
        roles: [
          {
            id: "owner",
            name: "持ち主",
            rules: [
              // **【`V8-M28` / `T-G16a`】持ち主にはこの2行が必ず要る**(適用時検査 = 類型17 の拡張)。
              { target: "app", can: ["write"] },
              { target: "role", can: ["write"] },
            ],
          },
          { id: "editor", name: "編集者" },
          { id: "viewer", name: "閲覧者" },
        ],
      },
    });
  });

  test("manifest.json が存在しなければ分かりやすいエラーになる", () => {
    expect(() => readCurrentManifest(dataRoot, "no-such-app")).toThrow(/manifest\.json/);
  });

  test("manifest.json が壊れていれば分かりやすいエラーになる", () => {
    newApp("book-tracker", "蔵書管理");
    writeFileSync(appManifestPath(dataRoot, "book-tracker"), "{ これはJSONではない", "utf-8");
    expect(() => readCurrentManifest(dataRoot, "book-tracker")).toThrow(/JSON/);
  });

  test("manifest.json の中身がマニフェストの形でなければエラーになる", () => {
    newApp("book-tracker", "蔵書管理");
    writeFileSync(appManifestPath(dataRoot, "book-tracker"), '{"app": {"id": 1}}', "utf-8");
    expect(() => readCurrentManifest(dataRoot, "book-tracker")).toThrow(/manifest\.json/);
  });
});

describe("applyManifest: 初期投入", () => {
  test("空アプリに book-tracker フィクスチャを投入するとスキーマが生成される", () => {
    newApp("book-tracker", "蔵書管理");
    const result = applyManifest(dataRoot, "book-tracker", bookTracker());
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.manifest).toEqual(bookTracker());
    expect(result.plan.add_tables.map((t) => t.id)).toEqual(["books"]);
    expect(result.plan.add_fields).toEqual([]);

    const db = new Database(appDbPath(dataRoot, "book-tracker"), { readonly: true });
    try {
      expect(tableNames(db)).toEqual(["books"]);
      expect(tableInfo(db, "books").map((c) => [c.name, c.type])).toEqual([
        ["_id", "TEXT"],
        ["_created_at", "TEXT"],
        ["_updated_at", "TEXT"],
        ["title", "TEXT"],
        ["status", "TEXT"],
        ["finished_at", "TEXT"],
      ]);
    } finally {
      db.close();
    }
  });

  test("投入したマニフェストが manifest.json に永続化される", () => {
    newApp("book-tracker", "蔵書管理");
    applyManifest(dataRoot, "book-tracker", bookTracker());
    const persisted = JSON.parse(
      readFileSync(appManifestPath(dataRoot, "book-tracker"), "utf-8"),
    ) as unknown;
    expect(persisted).toEqual(bookTracker());
    // 再オープン相当。読み出しても同じ。
    expect(readCurrentManifest(dataRoot, "book-tracker")).toEqual(bookTracker());
  });

  test("fixtures/valid の全型マニフェスト(inventory)も投入できる", () => {
    newApp("inventory", "備品管理");
    const manifest = loadFixture("valid/inventory-all-field-types.json") as Manifest;
    const result = applyManifest(dataRoot, "inventory", manifest);
    expect(result.valid).toBe(true);

    const db = new Database(appDbPath(dataRoot, "inventory"), { readonly: true });
    try {
      expect(tableNames(db).sort()).toEqual(manifest.app.tables.map((t) => t.id).sort());
      for (const table of manifest.app.tables) {
        const columns = tableInfo(db, table.id).map((c) => c.name);
        for (const field of table.fields) {
          expect(columns).toContain(field.id);
        }
      }
    } finally {
      db.close();
    }
  });

  test("fixtures/valid の参照付きマニフェスト(library)も投入できる", () => {
    newApp("library", "図書館");
    const manifest = loadFixture("valid/library-with-reference.json") as Manifest;
    expect(applyManifest(dataRoot, "library", manifest).valid).toBe(true);

    const db = new Database(appDbPath(dataRoot, "library"), { readonly: true });
    try {
      expect(tableNames(db).sort()).toEqual(manifest.app.tables.map((t) => t.id).sort());
    } finally {
      db.close();
    }
  });
});

describe("applyManifest: additive 差し替え", () => {
  /** 差し替え後の book-tracker: books に列2つ追加 + tags テーブル追加。 */
  function extended(): Manifest {
    const manifest = bookTracker();
    const books = manifest.app.tables[0];
    if (books === undefined) throw new Error("fixture broken");
    books.fields.push({ id: "rating", name: "評価", type: "number" });
    books.fields.push({ id: "favorite", name: "お気に入り", type: "boolean" });
    manifest.app.tables.push({
      id: "tags",
      name: "タグ",
      fields: [{ id: "label", name: "ラベル", type: "text", required: true }],
    });
    return manifest;
  }

  type BookRow = {
    _id: string;
    _created_at: string;
    _updated_at: string;
    title: string | null;
    status: string | null;
    finished_at: string | null;
  };

  const SEED: BookRow[] = [
    {
      _id: "b-1",
      _created_at: "2026-01-01T00:00:00.000Z",
      _updated_at: "2026-01-01T00:00:00.000Z",
      title: "吾輩は猫である",
      status: "読了",
      finished_at: "2026-01-10",
    },
    {
      _id: "b-2",
      _created_at: "2026-01-02T00:00:00.000Z",
      _updated_at: "2026-01-02T00:00:00.000Z",
      title: "こころ\n複数行タイトル",
      status: "読書中",
      finished_at: null,
    },
    {
      _id: "b-3",
      _created_at: "2026-01-03T00:00:00.000Z",
      _updated_at: "2026-01-03T00:00:00.000Z",
      title: "草枕",
      status: null,
      finished_at: null,
    },
  ];

  function seedBooks(): void {
    const db = new Database(appDbPath(dataRoot, "book-tracker"));
    try {
      const stmt = db.prepare(
        'INSERT INTO "books" ("_id", "_created_at", "_updated_at", "title", "status", "finished_at")' +
          " VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const row of SEED) {
        stmt.run(row._id, row._created_at, row._updated_at, row.title, row.status, row.finished_at);
      }
    } finally {
      db.close();
    }
  }

  test("列追加+テーブル追加が適用され、既存データが全件・全値無傷で残る", () => {
    newApp("book-tracker", "蔵書管理");
    expect(applyManifest(dataRoot, "book-tracker", bookTracker()).valid).toBe(true);
    seedBooks();

    const result = applyManifest(dataRoot, "book-tracker", extended());
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.plan.add_tables.map((t) => t.id)).toEqual(["tags"]);
    expect(result.plan.add_fields.map((f) => `${f.table}.${f.field.id}`)).toEqual([
      "books.rating",
      "books.favorite",
    ]);

    const db = new Database(appDbPath(dataRoot, "book-tracker"), { readonly: true });
    try {
      expect(tableNames(db)).toEqual(["books", "tags"]);
      const rows = db.query('SELECT * FROM "books" ORDER BY "_id"').all() as (BookRow & {
        rating: number | null;
        favorite: number | null;
      })[];
      expect(rows.length).toBe(SEED.length);
      for (const [index, seed] of SEED.entries()) {
        const row = rows[index];
        expect(row).toBeDefined();
        if (row === undefined) continue;
        expect(row._id).toBe(seed._id);
        expect(row._created_at).toBe(seed._created_at);
        expect(row._updated_at).toBe(seed._updated_at);
        expect(row.title).toBe(seed.title);
        expect(row.status).toBe(seed.status);
        expect(row.finished_at).toBe(seed.finished_at);
        // 追加列は既存行では NULL。
        expect(row.rating).toBeNull();
        expect(row.favorite).toBeNull();
      }
    } finally {
      db.close();
    }

    expect(readCurrentManifest(dataRoot, "book-tracker")).toEqual(extended());
  });

  test("表示名の変更・select選択肢の追加・ビュー追加は additive として通る", () => {
    newApp("book-tracker", "蔵書管理");
    applyManifest(dataRoot, "book-tracker", bookTracker());

    const next = bookTracker();
    next.app.name = "蔵書管理(改)";
    const books = next.app.tables[0];
    const status = books?.fields[1];
    if (books === undefined || status === undefined || status.type !== "select") {
      throw new Error("fixture broken");
    }
    status.options.push("積読");
    next.app.views.push({
      id: "book-list-2",
      type: "list_view",
      table: "books",
      columns: ["title"],
    });

    const result = applyManifest(dataRoot, "book-tracker", next);
    expect(result.valid).toBe(true);
    expect(readCurrentManifest(dataRoot, "book-tracker")).toEqual(next);
  });
});

describe("applyManifest: 拒否と状態不変", () => {
  function setupApplied(): AppState {
    newApp("book-tracker", "蔵書管理");
    expect(applyManifest(dataRoot, "book-tracker", bookTracker()).valid).toBe(true);
    return captureState(dataRoot, "book-tracker");
  }

  test("非additive(フィールド削除)は拒否され、状態が一切変わらない", () => {
    const before = setupApplied();

    const next = bookTracker();
    const books = next.app.tables[0];
    if (books === undefined) throw new Error("fixture broken");
    books.fields = books.fields.filter((f) => f.id !== "finished_at");
    next.app.views = next.app.views.map((v) =>
      v.type === "list_view"
        ? { ...v, sort: { field: "title", order: "desc" } }
        : v.type === "form"
          ? { ...v, fields: ["title", "status"] }
          : v,
    );

    const result = applyManifest(dataRoot, "book-tracker", next);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.path).toBe("/app/tables/0/fields");

    expect(captureState(dataRoot, "book-tracker")).toEqual(before);
  });

  test("非additive(テーブル削除)は拒否され、状態が一切変わらない", () => {
    const before = setupApplied();

    const next = bookTracker();
    next.app.tables = [];
    next.app.views = [];

    const result = applyManifest(dataRoot, "book-tracker", next);
    expect(result.valid).toBe(false);
    expect(captureState(dataRoot, "book-tracker")).toEqual(before);
  });

  test("非additive(テーブル追加を伴う削除)でも DDL が1つも実行されない", () => {
    const before = setupApplied();

    const next = bookTracker();
    const books = next.app.tables[0];
    if (books === undefined) throw new Error("fixture broken");
    // 追加(tags)と破壊的変更(型変更)が混在するケース。追加分も適用されてはならない。
    const status = books.fields[1];
    if (status === undefined) throw new Error("fixture broken");
    books.fields[1] = { id: "status", name: "状態", type: "text" };
    next.app.tables.push({
      id: "tags",
      name: "タグ",
      fields: [{ id: "label", name: "ラベル", type: "text" }],
    });

    const result = applyManifest(dataRoot, "book-tracker", next);
    expect(result.valid).toBe(false);
    const after = captureState(dataRoot, "book-tracker");
    expect(after).toEqual(before);
    expect(Object.keys(after.schema)).toEqual(["books"]);
  });

  test("構造エラーのマニフェストは拒否され、状態が一切変わらない", () => {
    const before = setupApplied();
    const result = applyManifest(
      dataRoot,
      "book-tracker",
      loadFixture("invalid/unknown-field-type.json"),
    );
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors.length).toBeGreaterThan(0);
    expect(captureState(dataRoot, "book-tracker")).toEqual(before);
  });

  test("参照切れのマニフェストは拒否され、状態が一切変わらない", () => {
    newApp("library", "図書館");
    applyManifest(dataRoot, "library", loadFixture("valid/library-with-reference.json"));
    const before = captureState(dataRoot, "library");

    const result = applyManifest(
      dataRoot,
      "library",
      loadFixture("invalid/broken-reference-table.json"),
    );
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors.some((e) => e.path.includes("reference_table"))).toBe(true);
    expect(captureState(dataRoot, "library")).toEqual(before);
  });

  test("マニフェストですらない入力は拒否され、状態が一切変わらない", () => {
    const before = setupApplied();
    const result = applyManifest(dataRoot, "book-tracker", { hello: "world" });
    expect(result.valid).toBe(false);
    expect(captureState(dataRoot, "book-tracker")).toEqual(before);
  });

  test("app.id が対象アプリと一致しないマニフェストは拒否される", () => {
    newApp("book-tracker", "蔵書管理");
    const before = captureState(dataRoot, "book-tracker");

    const result = applyManifest(
      dataRoot,
      "book-tracker",
      loadFixture("valid/library-with-reference.json"),
    );
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors[0]?.path).toBe("/app/id");
    expect(result.errors[0]?.message).toContain("book-tracker");
    expect(captureState(dataRoot, "book-tracker")).toEqual(before);
  });

  test("空アプリへの初期投入でも app.id 不一致は拒否される(DDLが走らない)", () => {
    newApp("inventory", "備品管理");
    const result = applyManifest(dataRoot, "inventory", bookTracker());
    expect(result.valid).toBe(false);

    const db = new Database(appDbPath(dataRoot, "inventory"), { readonly: true });
    try {
      expect(tableNames(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("拒否は同一マニフェストの再投入(冪等な no-op)を妨げない", () => {
    setupApplied();
    const result = applyManifest(dataRoot, "book-tracker", bookTracker());
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.plan).toEqual({ add_tables: [], add_fields: [] });
  });
});
