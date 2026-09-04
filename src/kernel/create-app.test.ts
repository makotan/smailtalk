import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFilesTableSql } from "../shared/files-table.ts";
import { applyDiff } from "./apply-diff.ts";
import { getChangelog } from "./changelog.ts";
import { createApp } from "./create-app.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { isValidResourceId } from "./resource-id.ts";
import { appDbPath, appDir, appManifestPath, appSnapshotsDir } from "./storage-paths.ts";
import { validateManifestFull } from "./validate.ts";

describe("createApp", () => {
  let dataRoot: string;
  let store: KernelMetaStore;

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "gp-create-app-"));
    store = KernelMetaStore.open(dataRoot);
  });

  afterEach(async () => {
    store.close();
    await rm(dataRoot, { recursive: true, force: true });
  });

  describe("ADR-0002 どおりのファイル作成", () => {
    test("manifest.json / app.sqlite / snapshots/ が disk 上に存在する", () => {
      const result = createApp(store, "蔵書管理");
      const id = result.app.app_id;

      expect(existsSync(appDir(dataRoot, id))).toBe(true);
      expect(existsSync(appManifestPath(dataRoot, id))).toBe(true);
      expect(existsSync(appDbPath(dataRoot, id))).toBe(true);
      expect(existsSync(appSnapshotsDir(dataRoot, id))).toBe(true);
      expect(statSync(appSnapshotsDir(dataRoot, id)).isDirectory()).toBe(true);
    });

    test("app.sqlite は開ける SQLite ファイルである", () => {
      const result = createApp(store, "蔵書管理");
      // 空でも SQLite ヘッダを持つ有効なDBファイルであること。
      expect(statSync(appDbPath(dataRoot, result.app.app_id)).size).toBeGreaterThan(0);
    });

    test("リポジトリの data/ ではなく渡されたデータルートに作る", () => {
      const result = createApp(store, "蔵書管理");
      expect(result.appDir.startsWith(dataRoot)).toBe(true);
    });

    // V2-M2-T02 / ADR-0035: `_files`(画像メタ)は **遅延生成**である。create-app は作らず、
    // アップロード API が最初の書込前に `CREATE TABLE IF NOT EXISTS` で用意する(新規/既存アプリを
    // 1機構で覆い、画像を持たないアプリの app.sqlite に `_files` を撒かない)。ここでは create-app
    // が `_files` を撒かないこと(= 遅延の前提)を固定し、共有 DDL がその形で作れることを確かめる。
    test("create-app は `_files` を作らず、共有 DDL が T01 申し送りのスキーマで遅延生成する", () => {
      const result = createApp(store, "商店");
      const db = new Database(appDbPath(dataRoot, result.app.app_id), { readwrite: true });
      try {
        const before = db
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='_files'",
          )
          .get();
        expect(before).toBeNull(); // 撒かない(遅延)。

        db.exec(createFilesTableSql()); // アップロード API がやる遅延生成に相当。
        const cols = db
          .query<{ name: string; type: string; pk: number }, []>('PRAGMA table_info("_files")')
          .all();
        const byName = new Map(cols.map((c) => [c.name, c]));
        expect([...byName.keys()].sort()).toEqual(
          ["created_at", "file_id", "filename", "mime", "sha256", "size"].sort(),
        );
        expect(byName.get("file_id")?.pk).toBe(1);
      } finally {
        db.close();
      }
    });
  });

  describe("空マニフェスト", () => {
    /*
     * **【`V8-M17` / `J-G2`(`ADR-0007` 門A 本審査 = 限定採用)による追随。2026-08-09】**
     * **新しいアプリの役割の一覧に、既定の役割定義3本(`owner` / `editor` / `viewer`)が
     * 最初から入るようになった** —— **`J-G2` の限定の逐語「新しいアプリの役割の一覧に、
     * 3つを既定の役割定義として最初から入れる」の履行である。**
     * **3本とも規則(`rules`)を1本も持たない**(メインの裁定 `R-13-3`)——
     * **裁定 `R-4` により、規則を持たない役割は面の管轄外(全許可)であり、
     * したがって新しいアプリのふるまいは着手前と1ミリも変わらない。**
     * **`tables: []` / `views: []` の主張は1ミリも弱めていない。**
     */
    test("tables:[] views:[] と役割の既定3本を持ち、app.id は発行された app_id", async () => {
      const result = createApp(store, "蔵書管理");
      const written = JSON.parse(
        await readFile(appManifestPath(dataRoot, result.app.app_id), "utf-8"),
      );
      expect(written).toEqual({
        app: {
          id: result.app.app_id,
          name: "蔵書管理",
          tables: [],
          views: [],
          roles: [
            // **【`V8-M28`(2026-08-11)。ユーザ決定 `D-V8-59`。旧の期待値を逐語で残す】**
            // **旧: `{ id: "owner", name: "持ち主" },`**(**`rules` を1本も持たない箱**)。
            // **今日は `owner` にだけ2行が最初から入る。**
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
          ],
        },
      });
      expect(result.manifest).toEqual(written);
    });

    test("既定3本のうち `owner` にだけ規則2本が入る(`D-V8-59`)。`editor` / `viewer` は0本", () => {
      // **旧テスト名の逐語**: 「**既定3本は規則(`rules`)を1本も持たない(`J-G2` /
      // 裁定 `R-13-3`)**」。**旧本体の逐語**: `for (const role of roles ?? []) {`
      // `  expect(role.rules).toBeUndefined();` `}`
      // **旧コメントの逐語**: 「**既定に規則を入れると、面が全アプリで即座に働き始める** ——
      // そのとき「着手前と同じ集合が読める」ことを `API` から証明する義務が生じる
      // (裁定 `N-2`)。**既定は「名前だけ用意しておく箱」である。**」
      //
      // **【`V8-M28`(2026-08-11)。ユーザ決定 `D-V8-59` / 台帳 `T-G16a`】**
      // **`ADR-0304` 限定11(既定3本は `rules` を持たない箱)は今日から成り立たない。**
      // **旧の期待値を1バイトも消していない。**
      const result = createApp(store, "蔵書管理");
      const roles = (
        result.manifest.app as unknown as { roles?: { id: string; rules?: unknown }[] }
      ).roles;
      expect(roles).toHaveLength(3);
      for (const role of roles ?? []) {
        if (role.id === "owner") {
          expect(role.rules).toEqual([
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
          ]);
        } else {
          expect(role.rules).toBeUndefined();
        }
      }
    });

    test("既定に `anonymous` は入らない(要るときだけアプリの作者が書く)", () => {
      const result = createApp(store, "蔵書管理");
      const roles = (result.manifest.app as unknown as { roles?: { id: string }[] }).roles ?? [];
      expect(roles.map((role) => role.id)).toEqual(["owner", "editor", "viewer"]);
    });

    test("生成された空マニフェストは validateManifestFull を通る", async () => {
      const result = createApp(store, "蔵書管理");
      const written = JSON.parse(
        await readFile(appManifestPath(dataRoot, result.app.app_id), "utf-8"),
      );
      expect(validateManifestFull(written)).toEqual({ valid: true });
      expect(validateManifestFull(result.manifest)).toEqual({ valid: true });
    });
  });

  describe("台帳登録", () => {
    test("作成後に台帳から引ける", () => {
      const result = createApp(store, "蔵書管理");
      expect(store.getApp(result.app.app_id)).toEqual(result.app);
      expect(store.listApps().map((app) => app.app_id)).toEqual([result.app.app_id]);
      expect(result.app.name).toBe("蔵書管理");
      expect(result.app.status).toBe("active");
    });

    test("再オープンした台帳からも引ける", () => {
      const result = createApp(store, "蔵書管理");
      store.close();
      store = KernelMetaStore.open(dataRoot);
      expect(store.getApp(result.app.app_id)?.name).toBe("蔵書管理");
    });
  });

  describe("app_id の採番", () => {
    test("日本語名『蔵書管理』でも有効な app_id が発行される", () => {
      const result = createApp(store, "蔵書管理");
      expect(isValidResourceId(result.app.app_id)).toBe(true);
      expect(result.app.app_id).toBe("app");
    });

    test("英字名は slug 化される", () => {
      expect(createApp(store, "Book Shelf").app.app_id).toBe("book-shelf");
    });

    test("同名アプリを連続作成してもIDが衝突しない", () => {
      const ids = [
        createApp(store, "Books"),
        createApp(store, "Books"),
        createApp(store, "Books"),
      ].map((r) => r.app.app_id);
      expect(ids).toEqual(["books", "books-2", "books-3"]);
      expect(new Set(ids).size).toBe(3);
      for (const id of ids) {
        expect(existsSync(appManifestPath(dataRoot, id))).toBe(true);
      }
      expect(store.listApps()).toHaveLength(3);
    });

    test("日本語名を連続作成してもIDが衝突しない", () => {
      const ids = [
        createApp(store, "蔵書管理"),
        createApp(store, "蔵書管理"),
        createApp(store, "在庫管理"),
      ].map((r) => r.app.app_id);
      expect(ids).toEqual(["app", "app-2", "app-3"]);
      expect(new Set(ids).size).toBe(3);
    });

    test("台帳になくてもディレクトリが既にあるIDは避ける", () => {
      mkdirSync(appDir(dataRoot, "books"), { recursive: true });
      expect(createApp(store, "Books").app.app_id).toBe("books-2");
    });
  });

  describe("app_id の明示指定", () => {
    test("明示 app_id で作成でき、その ID で台帳から引ける", () => {
      const result = createApp(store, "在庫管理", { app_id: "inventory" });
      expect(result.app.app_id).toBe("inventory");
      expect(store.getApp("inventory")).toEqual(result.app);
      expect(existsSync(appManifestPath(dataRoot, "inventory"))).toBe(true);
    });

    test("「蔵書管理」+ 明示 book-tracker で handover 3.4 と同じ ID になる", () => {
      const result = createApp(store, "蔵書管理", { app_id: "book-tracker" });
      expect(result.app.app_id).toBe("book-tracker");
      expect(result.manifest).toEqual({
        app: {
          id: "book-tracker",
          name: "蔵書管理",
          tables: [],
          views: [],
          roles: [
            // **【`V8-M28`(2026-08-11)。ユーザ決定 `D-V8-59`。旧の期待値を逐語で残す】**
            // **旧: `{ id: "owner", name: "持ち主" },`**(**`rules` を1本も持たない箱**)。
            // **今日は `owner` にだけ2行が最初から入る。**
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
          ],
        },
      });
    });

    test.each([
      ["大文字を含む", "Inventory"],
      ["先頭がハイフン", "-inventory"],
      ["65文字以上", "a".repeat(65)],
      ["空文字", ""],
      ["先頭が数字", "1inventory"],
    ])("不正な app_id (%s) は規約を示すエラーで拒否される", (_label, badId) => {
      expect(() => createApp(store, "在庫管理", { app_id: badId })).toThrow(
        /[Rr]esource[Ii]d|リソースID|規約/,
      );
      expect(store.listApps()).toEqual([]);
    });

    test("既存 app_id (台帳登録済み) の明示指定は連番にせずエラーで拒否する", () => {
      createApp(store, "在庫管理", { app_id: "inventory" });

      expect(() => createApp(store, "別の在庫管理", { app_id: "inventory" })).toThrow(
        /既に(使用|使われて)/,
      );
      // 連番を勝手に振っていないこと。
      expect(store.hasApp("inventory-2")).toBe(false);
      expect(store.listApps()).toHaveLength(1);
    });

    test("既存 app_id (台帳未登録・ディレクトリのみ存在) の明示指定もエラーで拒否する", () => {
      mkdirSync(appDir(dataRoot, "orphan"), { recursive: true });

      expect(() => createApp(store, "何か", { app_id: "orphan" })).toThrow(/既に(使用|使われて)/);
      expect(store.hasApp("orphan-2")).toBe(false);
    });
  });

  describe("異常系", () => {
    test("空のアプリ名は拒否する", () => {
      expect(() => createApp(store, "  ")).toThrow();
      expect(store.listApps()).toEqual([]);
    });
  });

  /**
   * V1-M0-T05(F-28)。履歴の第0行が「アプリを作った」で始まること。
   *
   * ここで固定するのは3つの決定である(詳細はタスク記録):
   * 1. 第0行の intent はカーネルが固定文で書く(引数で受け取らない)
   * 2. operations は空・kind は "apply"・diff_id は `_` 始まり・snapshot は null
   * 3. 既存アプリの履歴は遡及補完しない(1バイトも変えない)
   */
  describe("changelog の第0行(V1-M0-T05 / F-28)", () => {
    test("createApp 直後に履歴が1件あり、intent がアプリ作成を表す", () => {
      const { app } = createApp(store, "蔵書管理", { app_id: "book-tracker" });
      const entries = getChangelog(dataRoot, app.app_id);

      expect(entries).toHaveLength(1);
      const first = entries[0];
      // アプリ名が入っていること(何を作ったのかが履歴だけで読めること)。
      expect(first?.intent).toContain("蔵書管理");
      // ユーザの発話ではないことを行自身が言うこと(憲法6 / INTENT_VERBATIM を汚さない)。
      expect(first?.intent).toContain("カーネル");
      expect(first?.intent).toContain("ユーザの発話ではない");
    });

    test("第0行は operations:[] / kind:apply / diff_id は _ 始まり / snapshot:null", () => {
      const { app } = createApp(store, "蔵書管理", { app_id: "book-tracker" });
      const first = getChangelog(dataRoot, app.app_id)[0];

      // 「アプリを作る」を表す op は DIFF_OPS に無い。発明しない(undo と同じ手口)。
      expect(first?.operations).toEqual([]);
      // CHANGELOG_KINDS に第3の値を足さない。
      expect(first?.kind).toBe("apply");
      expect(first?.undo_target_seq).toBeNull();
      // ユーザ由来の diff_id は resource_id 規約(^[a-z]...)に縛られていて `_` 始まりを
      // 作れない。したがって衝突しないことが規約ではなく構造で保証される。
      expect(first?.diff_id.startsWith("_")).toBe(true);
      expect(isValidResourceId(first?.diff_id ?? "")).toBe(false);
      // 巻き戻し先は存在しない(アプリ作成前の状態というものが無い)。
      expect(first?.snapshot).toBeNull();
    });

    test("applied_at は台帳の created_at に揃う", () => {
      const createdAt = "2026-01-02T03:04:05.000Z";
      const { app } = createApp(store, "蔵書管理", {
        app_id: "book-tracker",
        created_at: createdAt,
      });
      expect(app.created_at).toBe(createdAt);
      expect(getChangelog(dataRoot, app.app_id)[0]?.applied_at).toBe(createdAt);
    });

    test("createApp → applyDiff の順なら、最古行が create_app で2行目が apply_diff", () => {
      // F-28 が言う「最古行がビュー追加になっている」の逆を明示的に固定する。
      const { app } = createApp(store, "蔵書管理", { app_id: "book-tracker" });
      const applied = applyDiff(dataRoot, app.app_id, {
        diff_id: "d-001",
        intent: "本を記録したい",
        operations: [
          {
            op: "add_table",
            table: {
              id: "books",
              name: "本",
              fields: [{ id: "title", name: "タイトル", type: "text", required: true }],
            },
          },
        ],
      });
      expect(applied.valid).toBe(true);

      const entries = getChangelog(dataRoot, app.app_id);
      expect(entries).toHaveLength(2);
      // seq 昇順で返る = 最古行が先頭。第0行が最小 seq であること。
      expect(entries[0]?.seq).toBeLessThan(entries[1]?.seq ?? 0);
      expect(entries[0]?.intent).toContain("蔵書管理");
      expect(entries[0]?.operations).toEqual([]);
      expect(entries[1]?.diff_id).toBe("d-001");
      expect(entries[1]?.intent).toBe("本を記録したい");
      expect(entries[1]?.operations).toHaveLength(1);
    });

    test("既存アプリの履歴を遡及補完しない(別アプリの createApp で1バイトも変わらない)", () => {
      const existing = createApp(store, "蔵書管理", { app_id: "book-tracker" }).app;
      const applied = applyDiff(dataRoot, existing.app_id, {
        diff_id: "d-001",
        intent: "本を記録したい",
        operations: [
          {
            op: "add_table",
            table: {
              id: "books",
              name: "本",
              fields: [{ id: "title", name: "タイトル", type: "text", required: true }],
            },
          },
        ],
      });
      expect(applied.valid).toBe(true);

      const before = getChangelog(dataRoot, existing.app_id);
      expect(before).toHaveLength(2);

      createApp(store, "レシピ帳", { app_id: "recipe-box" });

      const after = getChangelog(dataRoot, existing.app_id);
      // 件数・seq・intent を含めて完全に不変であること。
      expect(after).toEqual(before);
      // 新しいアプリの第0行は当然その新しいアプリのものであり、既存アプリに紛れ込まない。
      expect(getChangelog(dataRoot, "recipe-box")).toHaveLength(1);
      expect(after.every((entry) => entry.app_id === existing.app_id)).toBe(true);
    });
  });
});
