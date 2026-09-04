import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSystemTable } from "../shared/system-tables.ts";
import { APP_SCOPED_KERNEL_TABLES } from "./delete-app.ts";
// **旧行(逐語)**: `import { KernelMetaStore } from "./meta-store.ts";`
// **【`V10-M31` の中で打った `V10-M30` の積み残しの直し。葉タスクではない】** 下の `visibilityViaSecondConnection` の戻り型を素の
// `CommentVisibility` に絞るため、型だけを同じ口から足して引く。
import { type CommentVisibility, KernelMetaStore } from "./meta-store.ts";
import { kernelDbPath } from "./storage-paths.ts";
import type { Operation } from "./types.ts";

const OPERATIONS: Operation[] = [
  {
    op: "add_field",
    table: "books",
    field: { id: "finished_at", name: "読了日", type: "date" },
  },
  {
    op: "update_view",
    view: "book-list",
    changes: { sort: { field: "finished_at", order: "desc" } },
  },
];

describe("KernelMetaStore", () => {
  let dataRoot: string;
  let store: KernelMetaStore;

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "gp-meta-store-"));
    store = KernelMetaStore.open(dataRoot);
  });

  afterEach(async () => {
    store.close();
    await rm(dataRoot, { recursive: true, force: true });
  });

  describe("初期化", () => {
    test("データルート配下に kernel.sqlite を作る", () => {
      expect(existsSync(kernelDbPath(dataRoot))).toBe(true);
    });

    test("dataRoot を保持する(create_app などが参照する)", () => {
      expect(store.dataRoot).toBe(dataRoot);
    });

    test("既存のファイルに対して再オープンしてもテーブル作成で失敗しない", () => {
      const again = KernelMetaStore.open(dataRoot);
      expect(again.listApps()).toEqual([]);
      again.close();
    });
  });

  describe("アプリ台帳", () => {
    test("登録したアプリを app_id で取得できる", () => {
      const registered = store.registerApp({ app_id: "books", name: "蔵書管理" });
      expect(registered.app_id).toBe("books");
      expect(registered.name).toBe("蔵書管理");
      expect(registered.status).toBe("active");
      expect(registered.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

      expect(store.getApp("books")).toEqual(registered);
    });

    test("未登録の app_id は undefined", () => {
      expect(store.getApp("nope")).toBeUndefined();
    });

    test("一覧は created_at 昇順・同時刻でも登録順で安定する", () => {
      const at = "2026-07-18T06:00:00.000Z";
      store.registerApp({ app_id: "a", name: "A", created_at: at });
      store.registerApp({ app_id: "b", name: "B", created_at: at });
      store.registerApp({ app_id: "c", name: "C", created_at: at });
      expect(store.listApps().map((app) => app.app_id)).toEqual(["a", "b", "c"]);
    });

    test("created_at と status は明示指定できる", () => {
      const app = store.registerApp({
        app_id: "books",
        name: "蔵書管理",
        created_at: "2026-07-18T06:00:00.000Z",
        status: "archived",
      });
      expect(app.created_at).toBe("2026-07-18T06:00:00.000Z");
      expect(app.status).toBe("archived");
    });

    test("app_id が重複する登録は拒否する", () => {
      store.registerApp({ app_id: "books", name: "蔵書管理" });
      expect(() => store.registerApp({ app_id: "books", name: "別のアプリ" })).toThrow();
      expect(store.listApps()).toHaveLength(1);
    });

    test("リソースID規約に反する app_id は拒否する", () => {
      expect(() => store.registerApp({ app_id: "Books", name: "蔵書管理" })).toThrow();
      expect(() => store.registerApp({ app_id: "", name: "蔵書管理" })).toThrow();
    });

    test("hasApp で存在判定できる", () => {
      expect(store.hasApp("books")).toBe(false);
      store.registerApp({ app_id: "books", name: "蔵書管理" });
      expect(store.hasApp("books")).toBe(true);
    });
  });

  describe("changelog", () => {
    beforeEach(() => {
      store.registerApp({ app_id: "books", name: "蔵書管理" });
    });

    test("追記したエントリを app_id 指定で取得できる", () => {
      const appended = store.appendChangelog({
        app_id: "books",
        diff_id: "d-0042",
        intent: "読了日で並べたいという要望",
        operations: OPERATIONS,
        snapshot: "0001-d-0042",
      });

      expect(appended.seq).toBe(1);
      expect(appended.snapshot).toBe("0001-d-0042");
      expect(appended.operations).toEqual(OPERATIONS);

      const entries = store.listChangelog("books");
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual(appended);
    });

    test("operations は Operation[] としてラウンドトリップする", () => {
      store.appendChangelog({
        app_id: "books",
        diff_id: "d-0001",
        intent: "初期投入",
        operations: OPERATIONS,
      });
      const entry = store.listChangelog("books")[0];
      expect(entry?.operations).toEqual(OPERATIONS);
      // JSON文字列ではなくパース済みの配列で返る。
      expect(Array.isArray(entry?.operations)).toBe(true);
    });

    test("snapshot 未指定なら null", () => {
      const entry = store.appendChangelog({
        app_id: "books",
        diff_id: "d-0001",
        intent: "スナップショットなし",
        operations: [],
      });
      expect(entry.snapshot).toBeNull();
    });

    test("同一ミリ秒でも適用順(seq)が一意に定まる", () => {
      const at = "2026-07-18T06:00:00.000Z";
      for (const diffId of ["d-1", "d-2", "d-3", "d-4", "d-5"]) {
        store.appendChangelog({
          app_id: "books",
          diff_id: diffId,
          intent: "同時刻",
          operations: [],
          applied_at: at,
        });
      }
      const entries = store.listChangelog("books");
      expect(entries.map((e) => e.diff_id)).toEqual(["d-1", "d-2", "d-3", "d-4", "d-5"]);
      expect(entries.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    });

    test("他アプリのエントリは混ざらない", () => {
      store.registerApp({ app_id: "other", name: "別アプリ" });
      store.appendChangelog({ app_id: "books", diff_id: "d-1", intent: "本", operations: [] });
      store.appendChangelog({ app_id: "other", diff_id: "d-2", intent: "別", operations: [] });

      expect(store.listChangelog("books").map((e) => e.diff_id)).toEqual(["d-1"]);
      expect(store.listChangelog("other").map((e) => e.diff_id)).toEqual(["d-2"]);
    });

    test("台帳にないアプリへの追記は拒否する", () => {
      expect(() =>
        store.appendChangelog({ app_id: "ghost", diff_id: "d-1", intent: "x", operations: [] }),
      ).toThrow();
    });

    test("同じアプリ内での diff_id 重複は拒否する", () => {
      store.appendChangelog({ app_id: "books", diff_id: "d-1", intent: "x", operations: [] });
      expect(() =>
        store.appendChangelog({ app_id: "books", diff_id: "d-1", intent: "y", operations: [] }),
      ).toThrow();
    });
  });

  describe("永続性(プロセス再起動相当)", () => {
    test("書き込み→close→同じパスで再オープン→読み出しでデータが残る", () => {
      store.registerApp({
        app_id: "books",
        name: "蔵書管理",
        created_at: "2026-07-18T06:00:00.000Z",
      });
      store.appendChangelog({
        app_id: "books",
        diff_id: "d-0042",
        intent: "読了日で並べたいという要望",
        operations: OPERATIONS,
        applied_at: "2026-07-18T06:00:01.000Z",
        snapshot: "0001-d-0042",
      });
      store.close();

      const reopened = KernelMetaStore.open(dataRoot);
      try {
        expect(reopened.getApp("books")).toEqual({
          app_id: "books",
          name: "蔵書管理",
          created_at: "2026-07-18T06:00:00.000Z",
          status: "active",
        });
        const entries = reopened.listChangelog("books");
        expect(entries).toHaveLength(1);
        expect(entries[0]?.operations).toEqual(OPERATIONS);
        expect(entries[0]?.snapshot).toBe("0001-d-0042");
        expect(entries[0]?.applied_at).toBe("2026-07-18T06:00:01.000Z");
      } finally {
        reopened.close();
        // afterEach の close() が二重にならないよう開き直しておく。
        store = KernelMetaStore.open(dataRoot);
      }
    });

    test("再オープン後の追記は seq が継続する", () => {
      store.registerApp({ app_id: "books", name: "蔵書管理" });
      store.appendChangelog({ app_id: "books", diff_id: "d-1", intent: "x", operations: [] });
      store.close();

      store = KernelMetaStore.open(dataRoot);
      const second = store.appendChangelog({
        app_id: "books",
        diff_id: "d-2",
        intent: "y",
        operations: [],
      });
      expect(second.seq).toBe(2);
      expect(store.listChangelog("books").map((e) => e.diff_id)).toEqual(["d-1", "d-2"]);
    });
  });

  describe("kind / undo_target_seq(ADR-0004)", () => {
    beforeEach(() => {
      store.registerApp({ app_id: "books", name: "蔵書管理" });
    });

    test("省略時は kind: apply / undo_target_seq: null", () => {
      const entry = store.appendChangelog({
        app_id: "books",
        diff_id: "d-1",
        intent: "読了日を足す",
        operations: OPERATIONS,
      });
      expect(entry.kind).toBe("apply");
      expect(entry.undo_target_seq).toBeNull();
      expect(store.listChangelog("books")[0]?.kind).toBe("apply");
      expect(store.listChangelog("books")[0]?.undo_target_seq).toBeNull();
    });

    test("undo エントリは kind: undo と対象 seq を保持する", () => {
      const applied = store.appendChangelog({
        app_id: "books",
        diff_id: "d-1",
        intent: "読了日を足す",
        operations: OPERATIONS,
      });
      const undone = store.appendChangelog({
        app_id: "books",
        diff_id: `undo-${applied.diff_id}`,
        intent: "d-1(読了日を足す)を取り消した",
        operations: [],
        kind: "undo",
        undo_target_seq: applied.seq,
      });

      expect(undone.kind).toBe("undo");
      expect(undone.undo_target_seq).toBe(applied.seq);

      const entries = store.listChangelog("books");
      expect(entries.map((e) => e.kind)).toEqual(["apply", "undo"]);
      expect(entries.map((e) => e.undo_target_seq)).toEqual([null, applied.seq]);
      expect(entries[1]).toEqual(undone);
    });
  });

  describe("スキーマ移行(既存DBへの列追加)", () => {
    /** kind / undo_target_seq を持たない旧スキーマの kernel.sqlite を作る。 */
    function createLegacyDb(root: string): void {
      const db = new Database(kernelDbPath(root), { create: true });
      try {
        db.exec(`
          CREATE TABLE "apps" (
            "app_id"     TEXT PRIMARY KEY,
            "name"       TEXT NOT NULL,
            "created_at" TEXT NOT NULL,
            "status"     TEXT NOT NULL,
            "ledger_seq" INTEGER NOT NULL
          );
          CREATE TABLE "changelog" (
            "seq"        INTEGER PRIMARY KEY AUTOINCREMENT,
            "app_id"     TEXT NOT NULL REFERENCES "apps"("app_id"),
            "diff_id"    TEXT NOT NULL,
            "intent"     TEXT NOT NULL,
            "operations" TEXT NOT NULL,
            "applied_at" TEXT NOT NULL,
            "snapshot"   TEXT,
            UNIQUE ("app_id", "diff_id")
          );
          INSERT INTO "apps" VALUES ('books', '蔵書管理', '2026-07-18T06:00:00.000Z', 'active', 1);
          INSERT INTO "changelog"
            ("app_id", "diff_id", "intent", "operations", "applied_at", "snapshot")
            VALUES ('books', 'd-old', '旧スキーマ時代の変更', '[]',
                    '2026-07-18T06:00:01.000Z', '0001-d-old');
        `);
      } finally {
        db.close();
      }
    }

    let legacyRoot: string;

    beforeEach(async () => {
      legacyRoot = await mkdtemp(join(tmpdir(), "gp-meta-store-legacy-"));
      createLegacyDb(legacyRoot);
    });

    afterEach(async () => {
      await rm(legacyRoot, { recursive: true, force: true });
    });

    test("旧スキーマのDBを開いても壊れず、既存行は kind: apply / undo_target_seq: null になる", () => {
      const legacy = KernelMetaStore.open(legacyRoot);
      try {
        const entries = legacy.listChangelog("books");
        expect(entries).toHaveLength(1);
        expect(entries[0]?.diff_id).toBe("d-old");
        expect(entries[0]?.intent).toBe("旧スキーマ時代の変更");
        expect(entries[0]?.snapshot).toBe("0001-d-old");
        expect(entries[0]?.kind).toBe("apply");
        expect(entries[0]?.undo_target_seq).toBeNull();
      } finally {
        legacy.close();
      }
    });

    test("旧スキーマのDBを開いた後、新しい列を使った追記ができる", () => {
      const legacy = KernelMetaStore.open(legacyRoot);
      try {
        const undone = legacy.appendChangelog({
          app_id: "books",
          diff_id: "undo-d-old",
          intent: "d-old を取り消した",
          operations: [],
          kind: "undo",
          undo_target_seq: 1,
        });
        expect(undone.kind).toBe("undo");
        expect(undone.undo_target_seq).toBe(1);
      } finally {
        legacy.close();
      }
    });

    test("2回開いても壊れない(移行は冪等)", () => {
      const first = KernelMetaStore.open(legacyRoot);
      first.close();
      const second = KernelMetaStore.open(legacyRoot);
      try {
        expect(second.listChangelog("books")).toHaveLength(1);
        expect(second.listChangelog("books")[0]?.kind).toBe("apply");
      } finally {
        second.close();
      }

      // 3回目(= 既に新スキーマになっているDB)でも列が二重に足されない。
      const third = KernelMetaStore.open(legacyRoot);
      try {
        const columns = new Database(kernelDbPath(legacyRoot), { readwrite: true })
          .query<{ name: string }, []>(`PRAGMA table_info("changelog")`)
          .all()
          .map((row) => row.name);
        expect(columns.filter((name) => name === "kind")).toHaveLength(1);
        expect(columns.filter((name) => name === "undo_target_seq")).toHaveLength(1);
      } finally {
        third.close();
      }
    });
  });
});

/**
 * 全アプリ横断の changelog 読み取り(ADR-0006 §6b)。
 *
 * `_changelog` は閲覧中のアプリに閉じない。T03 の完了条件「**各アプリの** diff 履歴が
 * intent 付きで読める」は、単一アプリに閉じた `listChangelog(appId)` では満たせない。
 */
describe("KernelMetaStore.listAllChangelog", () => {
  let dataRoot: string;
  let store: KernelMetaStore;

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "gp-meta-store-all-"));
    store = KernelMetaStore.open(dataRoot);
  });

  afterEach(async () => {
    store.close();
    await rm(dataRoot, { recursive: true, force: true });
  });

  test("エントリが1件も無ければ空配列", () => {
    expect(store.listAllChangelog()).toEqual([]);
  });

  test("全アプリのエントリを seq 昇順で返す", () => {
    store.registerApp({ app_id: "books", name: "蔵書管理" });
    store.registerApp({ app_id: "expenses", name: "経費" });
    store.appendChangelog({ app_id: "books", diff_id: "d-001", intent: "一覧", operations: [] });
    store.appendChangelog({ app_id: "expenses", diff_id: "d-002", intent: "帳簿", operations: [] });
    store.appendChangelog({ app_id: "books", diff_id: "d-003", intent: "並び順", operations: [] });

    const entries = store.listAllChangelog();
    expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(entries.map((entry) => entry.app_id)).toEqual(["books", "expenses", "books"]);
    expect(entries.map((entry) => entry.intent)).toEqual(["一覧", "帳簿", "並び順"]);
  });

  test("単一アプリ版と同じ形のエントリを返す(operations も復元される)", () => {
    store.registerApp({ app_id: "books", name: "蔵書管理" });
    store.appendChangelog({
      app_id: "books",
      diff_id: "d-001",
      intent: "読了日で並べ替えたい",
      operations: OPERATIONS,
      kind: "apply",
    });
    expect(store.listAllChangelog()).toEqual(store.listChangelog("books"));
  });
});

/**
 * アプリごとのコメント表示設定(`V10-M30-T01` = `CM-G36` / `ADR-0377`)。
 *
 * 器は **`apps` 表の列2本ちょうど**である(`ADR-0377` 限定1)。`kernel.sqlite` に表を
 * 1本も足していないので、`APP_SCOPED_KERNEL_TABLES` も `_apps` 投影も1バイトも動かない
 * ——**その2つを動かさなかったこと自体をここで固定する**(限定2 / 限定4。下の2本)。
 *
 * **`D-V10-36` が「切り替えは書く側と読む側の2つであり、1つに畳まない」と述べている**
 * ので、1本の列に畳んだ実装はここで赤くなる(書くだけ true / 読むだけ true の2本)。
 * **`D-V10-40` により既定は OFF** である(限定7)。
 */
describe("KernelMetaStore のコメント表示設定(ADR-0377)", () => {
  let dataRoot: string;
  let store: KernelMetaStore;

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "gp-meta-store-cv-"));
    store = KernelMetaStore.open(dataRoot);
  });

  afterEach(async () => {
    store.close();
    await rm(dataRoot, { recursive: true, force: true });
  });

  /** その DB の `apps` 表の実列(宣言順)。`PRAGMA table_info` の実出力である。 */
  function appsColumnsOf(root: string): string[] {
    const db = new Database(kernelDbPath(root), { readwrite: true });
    try {
      return db
        .query<{ name: string }, []>(`PRAGMA table_info("apps")`)
        .all()
        .map((row) => row.name);
    } finally {
      db.close();
    }
  }

  test("(cv1) 新しく作った DB の apps 表の列は7本ちょうどで、末尾2本が設定である", () => {
    // **列の本数そのものを固定する**(限定1「列2本ちょうど」)。3本目を足すとここが赤くなる。
    expect(appsColumnsOf(dataRoot)).toEqual([
      "app_id",
      "name",
      "created_at",
      "status",
      "ledger_seq",
      "comment_write_enabled",
      "comment_read_enabled",
    ]);
  });

  test("(cv2) 新しく登録したアプリは、書く=false / 読む=false から始まる(D-V10-40)", () => {
    store.registerApp({ app_id: "books", name: "蔵書管理" });
    expect(store.getCommentVisibility("books")).toEqual({ write: false, read: false });
  });

  test("(cv3) 列が5本しかない古い DB を開くと、行を1件も失わずに列が2本足され、既定は OFF", async () => {
    const legacyRoot = await mkdtemp(join(tmpdir(), "gp-meta-store-cv-legacy-"));
    try {
      // **後から足した列を持たない `apps`** を手で作る(`migrateAppsColumns` の対象)。
      // `changelog` は `SCHEMA` 側が `IF NOT EXISTS` で用意するので、ここでは作らない。
      const seed = new Database(kernelDbPath(legacyRoot), { create: true });
      try {
        seed.exec(`
          CREATE TABLE "apps" (
            "app_id"     TEXT PRIMARY KEY,
            "name"       TEXT NOT NULL,
            "created_at" TEXT NOT NULL,
            "status"     TEXT NOT NULL,
            "ledger_seq" INTEGER NOT NULL
          );
          INSERT INTO "apps" VALUES ('books', '蔵書管理', '2026-07-18T06:00:00.000Z', 'active', 1);
        `);
        // **前提を先に固定する** —— 開く前は5本である(検査の空回りを塞ぐ)。
        expect(
          seed
            .query<{ name: string }, []>(`PRAGMA table_info("apps")`)
            .all()
            .map((row) => row.name),
        ).toHaveLength(5);
      } finally {
        seed.close();
      }

      const legacy = KernelMetaStore.open(legacyRoot);
      try {
        expect(appsColumnsOf(legacyRoot)).toHaveLength(7);
        // **行が落ちていない**(列を足すのに表を作り直していない)。
        expect(legacy.listApps().map((app) => app.app_id)).toEqual(["books"]);
        expect(legacy.getApp("books")?.name).toBe("蔵書管理");
        // **既存アプリの初期状態は全部 OFF**(`D-V10-40` / 限定7)。
        expect(legacy.getCommentVisibility("books")).toEqual({ write: false, read: false });
      } finally {
        legacy.close();
      }
    } finally {
      await rm(legacyRoot, { recursive: true, force: true });
    }
  });

  test("(cv4) 同じ DB を2度開いても投げず、列も値も増えない(移行は冪等)", async () => {
    const legacyRoot = await mkdtemp(join(tmpdir(), "gp-meta-store-cv-idem-"));
    try {
      const seed = new Database(kernelDbPath(legacyRoot), { create: true });
      try {
        seed.exec(`
          CREATE TABLE "apps" (
            "app_id"     TEXT PRIMARY KEY,
            "name"       TEXT NOT NULL,
            "created_at" TEXT NOT NULL,
            "status"     TEXT NOT NULL,
            "ledger_seq" INTEGER NOT NULL
          );
          INSERT INTO "apps" VALUES ('books', '蔵書管理', '2026-07-18T06:00:00.000Z', 'active', 1);
        `);
      } finally {
        seed.close();
      }

      const first = KernelMetaStore.open(legacyRoot);
      first.setCommentVisibility("books", { write: true });
      first.close();

      // 2度目。**`ALTER TABLE` が二重に走らない**(走ると "duplicate column name" で投げる)。
      const second = KernelMetaStore.open(legacyRoot);
      try {
        const columns = appsColumnsOf(legacyRoot);
        expect(columns).toHaveLength(7);
        expect(columns.filter((name) => name === "comment_write_enabled")).toHaveLength(1);
        expect(columns.filter((name) => name === "comment_read_enabled")).toHaveLength(1);
        // **開き直しても倒した値が戻らない**(移行が既存の値を踏まない)。
        expect(second.getCommentVisibility("books")).toEqual({ write: true, read: false });
      } finally {
        second.close();
      }
    } finally {
      await rm(legacyRoot, { recursive: true, force: true });
    }
  });

  test("(cv5) 書く側だけを true にできる(読む側は false のまま。D-V10-36)", () => {
    store.registerApp({ app_id: "books", name: "蔵書管理" });
    expect(store.setCommentVisibility("books", { write: true })).toEqual({
      write: true,
      read: false,
    });
    expect(store.getCommentVisibility("books")).toEqual({ write: true, read: false });
  });

  test("(cv6) 読む側だけを true にできる(書く側は false のまま。D-V10-36)", () => {
    store.registerApp({ app_id: "books", name: "蔵書管理" });
    expect(store.setCommentVisibility("books", { read: true })).toEqual({
      write: false,
      read: true,
    });
    expect(store.getCommentVisibility("books")).toEqual({ write: false, read: true });
  });

  test("(cv7) 同じストアのまま false → true → false と3回倒せる", () => {
    store.registerApp({ app_id: "books", name: "蔵書管理" });
    expect(store.getCommentVisibility("books")).toEqual({ write: false, read: false });
    store.setCommentVisibility("books", { write: true, read: true });
    expect(store.getCommentVisibility("books")).toEqual({ write: true, read: true });
    store.setCommentVisibility("books", { write: false, read: false });
    expect(store.getCommentVisibility("books")).toEqual({ write: false, read: false });
  });

  test("(cv8) 実在しないアプリは読むと undefined・倒すと投げる", () => {
    expect(store.getCommentVisibility("nope")).toBeUndefined();
    expect(() => store.setCommentVisibility("nope", { write: true })).toThrow(/nope/);
  });

  test("(cv9) deleteApp の後、そのアプリの設定は読めない", () => {
    store.registerApp({ app_id: "books", name: "蔵書管理" });
    store.setCommentVisibility("books", { write: true, read: true });
    store.deleteApp("books", APP_SCOPED_KERNEL_TABLES);
    expect(store.getCommentVisibility("books")).toBeUndefined();
  });

  /** **別に開いた読み口**(このストアとは別の接続)で今の設定を読む。 */
  // **旧行(逐語)**:
  //   `  function visibilityViaSecondConnection(`
  //   `    root: string,`
  //   `    appId: string,`
  //   `  ): { write: boolean; read: boolean } | undefined {`
  //   `    const second = KernelMetaStore.open(root);`
  //   `    try {`
  //   `      return second.getCommentVisibility(appId);`
  //   `    } finally {`
  //   `      second.close();`
  //   `    }`
  //   `  }`
  // **【`V10-M31` の中で打った `V10-M30` の積み残しの直し。葉タスクではない ——
  // 初稿は `V10-M31-T02` と名乗っていたが、その葉タスクは本ファイルを1バイトも触っていない】**
  // `V10-M30`(`012bfa7`)が残した型検査の赤2件を、担保を1ミリも
  // 弱めずに畳む。** `getCommentVisibility` は **`apps` に行が無いとき `undefined` を返す**
  // (`cv8` = 実在しないアプリ / `cv9` = `deleteApp` の後。この2本がその挙動を押さえている)。
  // `cv12` が渡すのは登録済みの `books` だけなので `undefined` は来ないはずだが、**来たら
  // 握りつぶさずその場で落とす** —— `as` / `!` / `?? {…}` で黙らせると、「別に開いた読み口が
  // 何も返さなかった」という**この見張りが最も捕まえたい壊れ方**が緑のまま通ってしまう。
  // (`if` は `expect` が投げた後には届かない。TypeScript に型を絞らせるためだけに置いている。)
  function visibilityViaSecondConnection(root: string, appId: string): CommentVisibility {
    const second = KernelMetaStore.open(root);
    try {
      const visibility = second.getCommentVisibility(appId);
      expect(visibility).toBeDefined();
      if (visibility === undefined) {
        throw new Error(`別に開いた読み口が ${appId} の設定を返さなかった`);
      }
      return visibility;
    } finally {
      second.close();
    }
  }

  test("(cv12) 倒した返り値は、別に開いた読み口の値と一致する(計算値ではなく実DBを返す)", () => {
    // **【`V10-M30` の独立点検 B-5(2026-08-25)】**
    // 直す前、`setCommentVisibility` は `UPDATE` の後に **`patch` から計算した値**を
    // そのまま返していた。**`ADR-0378` は読む道具を2本目に足さないと決めた**ので、
    // **この返り値が「今どうなっているか」を知る唯一の手立てである** ——
    // 実DBと割れてはいけない。ここがその見張りである。
    store.registerApp({ app_id: "books", name: "蔵書管理" });
    for (const patch of [
      { write: true },
      { read: true },
      { write: false },
      { write: true, read: false },
    ]) {
      const returned = store.setCommentVisibility("books", patch);
      expect(returned).toEqual(visibilityViaSecondConnection(dataRoot, "books"));
    }

    // **陽性対照** —— **DB 側が「書いた値と違う値」を持つように仕向ける。**
    // `comment_read_enabled` を書いた直後に0へ倒し直すトリガを別接続で仕掛けると、
    // 「`patch` から計算した値」と「実DBの値」が割れる。**読み直していれば実DBの値
    // (`read: false`)が返り、計算値をそのまま返していれば `read: true` が返って赤くなる。**
    const rigger = new Database(kernelDbPath(dataRoot), { readwrite: true });
    try {
      rigger.exec(
        `CREATE TRIGGER "force_read_off" AFTER UPDATE OF "comment_read_enabled" ON "apps"
         BEGIN
           UPDATE "apps" SET "comment_read_enabled" = 0 WHERE "app_id" = NEW."app_id";
         END;`,
      );
    } finally {
      rigger.close();
    }
    const rigged = store.setCommentVisibility("books", { read: true });
    expect(rigged).toEqual({ write: true, read: false });
    expect(rigged).toEqual(visibilityViaSecondConnection(dataRoot, "books"));
  });

  test("(cv10) APP_SCOPED_KERNEL_TABLES は13要素のまま(限定4。列を足しただけで表は増えない)", () => {
    expect(APP_SCOPED_KERNEL_TABLES).toHaveLength(13);
  });

  test("(cv11) _apps 投影のフィールドは4本のまま(限定2。5本目・6本目を出さない)", () => {
    const projected = findSystemTable("_apps");
    expect(projected?.fields.map((field) => field.id)).toEqual([
      "app_id",
      "name",
      "created_at",
      "status",
    ]);
  });
});
