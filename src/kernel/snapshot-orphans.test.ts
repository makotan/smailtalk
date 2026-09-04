import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFilesTableSql, FILES_TABLE_ID } from "../shared/files-table.ts";
import { applyDiff } from "./apply-diff.ts";
import { applyManifest, readCurrentManifest } from "./apply-manifest.ts";
import { getBlob, putBlob } from "./blob-store.ts";
import { createApp } from "./create-app.ts";
import { escapeHatchBodyExists, putEscapeHatchBody } from "./escape-hatch-store.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { createRecord, listRecords, updateRecord } from "./records.ts";
import { takeSnapshot } from "./snapshot.ts";
import {
  auditAllSnapshots,
  auditAppBlobs,
  auditAppEscapeHatch,
  auditAppSnapshots,
  deleteAppBlobs,
  deleteAppSnapshots,
} from "./snapshot-orphans.ts";
import { appBlobsDir, appDbPath, appDir, appSnapshotsDir, snapshotDir } from "./storage-paths.ts";
import type { Diff, Manifest } from "./types.ts";
import { undo } from "./undo.ts";

let dataRoot: string;
let store: KernelMetaStore;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-orphan-"));
  store = KernelMetaStore.open(dataRoot);
});

afterEach(async () => {
  store.close();
  await rm(dataRoot, { recursive: true, force: true });
});

function manifestOf(appId: string): Manifest {
  return {
    app: {
      id: appId,
      name: "蔵書管理",
      tables: [
        {
          id: "books",
          name: "本",
          fields: [{ id: "title", name: "タイトル", type: "text", required: true }],
        },
      ],
      views: [],
    },
  };
}

/** アプリを作り、マニフェストを投入する(まだスナップショットは無い)。 */
function newApp(appId: string): void {
  createApp(store, "蔵書管理", { app_id: appId });
  const applied = applyManifest(dataRoot, appId, manifestOf(appId));
  if (!applied.valid) {
    throw new Error(`テスト前提のマニフェスト投入に失敗: ${JSON.stringify(applied.errors)}`);
  }
}

/**
 * changelog に参照を残す「正規の」スナップショットを1つ作る。
 *
 * `takeSnapshot` はディスクにディレクトリを作るだけで changelog を書かない。
 * 本物の apply 経路と同じく、取得したスナップショット名を changelog の
 * `snapshot` として追記することで「参照される」状態を作る。
 */
function takeReferencedSnapshot(appId: string, diffId: string): string {
  const ref = takeSnapshot(dataRoot, appId, diffId);
  store.appendChangelog({
    app_id: appId,
    diff_id: diffId,
    intent: `${diffId} を適用した`,
    operations: [],
    snapshot: ref.name,
    kind: "apply",
  });
  return ref.name;
}

describe("auditAppSnapshots: 孤児の検出", () => {
  test("changelog に参照されないスナップショットは orphans に出る", () => {
    const appId = "orphan-app";
    newApp(appId);

    const referenced = takeReferencedSnapshot(appId, "d-001");
    // takeSnapshot だけを呼ぶ(= changelog に追記しない)と孤児になる。
    // これは apply の途中失敗やクラッシュ復旧で残る痕跡と同じ形である(ゲート §1 (b-2))。
    const orphan = takeSnapshot(dataRoot, appId, "d-002-orphan").name;

    const audit = auditAppSnapshots(dataRoot, appId);
    expect(audit.on_disk).toEqual([referenced, orphan].sort());
    expect(audit.referenced).toEqual([referenced]);
    expect(audit.orphans).toEqual([orphan]);
    expect(audit.dangling_references).toEqual([]);
    expect(audit.undo_snapshots).toEqual([]);
    expect(audit.bytes).toBeGreaterThan(0);
  });

  test("孤児がまったく無ければ orphans は空(data-demo の 0件 に対応)", () => {
    const appId = "clean-app";
    newApp(appId);
    takeReferencedSnapshot(appId, "d-001");
    takeReferencedSnapshot(appId, "d-002");

    const audit = auditAppSnapshots(dataRoot, appId);
    expect(audit.on_disk).toHaveLength(2);
    expect(audit.referenced).toHaveLength(2);
    expect(audit.orphans).toEqual([]);
    expect(audit.undo_snapshots).toEqual([]);
    expect(audit.dangling_references).toEqual([]);
  });

  test("スナップショットが1つも無いアプリは全欄が空・bytes は 0", () => {
    const appId = "no-snap";
    newApp(appId);
    const audit = auditAppSnapshots(dataRoot, appId);
    expect(audit).toEqual({
      app_id: appId,
      on_disk: [],
      referenced: [],
      orphans: [],
      dangling_references: [],
      undo_snapshots: [],
      bytes: 0,
    });
  });
});

describe("auditAppSnapshots: 死蔵(-undo-)は orphans と別欄", () => {
  test("undo が残した -undo- スナップショットは undo_snapshots に出て orphans には出ない", () => {
    const appId = "undo-app";
    newApp(appId);
    takeReferencedSnapshot(appId, "d-001");

    // undo を実行すると `<連番>-undo-d-001` が取られ、undo エントリから参照される。
    const undone = undo(dataRoot, appId);
    expect(undone.valid, JSON.stringify(undone)).toBe(true);

    const audit = auditAppSnapshots(dataRoot, appId);
    // -undo- は「死蔵」= 参照されるが戻り先として二度と使われない。別欄に出す。
    expect(audit.undo_snapshots).toEqual(["0002-undo-d-001"]);
    expect(audit.orphans).toEqual([]);
    // -undo- は changelog(undo エントリ)から参照されるので referenced にも入る。
    expect(audit.referenced).toContain("0002-undo-d-001");
    expect(audit.dangling_references).toEqual([]);
  });

  test("changelog 未参照でも -undo- 命名なら orphans ではなく undo_snapshots に分類する", () => {
    // undo の changelog 追記が失敗して痕跡だけ残った、のような壊れ方を模す。
    // 「孤児」と「死蔵」を絶対に混ぜないための固定(ゲート §5)。
    const appId = "stray-undo";
    newApp(appId);
    const stray = takeSnapshot(dataRoot, appId, "undo-d-999").name; // changelog に載せない

    const audit = auditAppSnapshots(dataRoot, appId);
    expect(audit.undo_snapshots).toEqual([stray]);
    expect(audit.orphans).toEqual([]);
  });
});

describe("auditAppSnapshots: 宙吊り参照", () => {
  test("changelog が参照するがディスクに無いものは dangling_references に出る", () => {
    const appId = "dangling-app";
    const name = (() => {
      newApp(appId);
      return takeReferencedSnapshot(appId, "d-001");
    })();

    // ディスク側のスナップショットだけを消す(changelog の参照は残す)。
    rmSync(snapshotDir(dataRoot, appId, name), { recursive: true, force: true });

    const audit = auditAppSnapshots(dataRoot, appId);
    expect(audit.on_disk).toEqual([]);
    expect(audit.referenced).toEqual([name]);
    expect(audit.dangling_references).toEqual([name]);
    expect(audit.orphans).toEqual([]);
  });
});

describe("deleteAppSnapshots: アプリ単位の削除プリミティブ", () => {
  test("削除後は検出が空を返す(T09 検証方法2 の下地)", () => {
    const appId = "delete-app";
    newApp(appId);
    takeReferencedSnapshot(appId, "d-001");
    takeSnapshot(dataRoot, appId, "d-002-orphan"); // 孤児も混ぜておく

    expect(auditAppSnapshots(dataRoot, appId).on_disk).toHaveLength(2);
    expect(existsSync(appSnapshotsDir(dataRoot, appId))).toBe(true);

    deleteAppSnapshots(dataRoot, appId);

    expect(existsSync(appSnapshotsDir(dataRoot, appId))).toBe(false);
    const audit = auditAppSnapshots(dataRoot, appId);
    expect(audit.on_disk).toEqual([]);
    expect(audit.orphans).toEqual([]);
    expect(audit.undo_snapshots).toEqual([]);
    expect(audit.bytes).toBe(0);
  });

  test("冪等: 2回呼んでも壊れない / snapshots が無いアプリでも throw しない", () => {
    const appId = "idempotent";
    newApp(appId);
    takeReferencedSnapshot(appId, "d-001");

    deleteAppSnapshots(dataRoot, appId);
    expect(() => deleteAppSnapshots(dataRoot, appId)).not.toThrow();

    // 一度もスナップショットを取っていないアプリでも force で無害。
    const fresh = "fresh";
    newApp(fresh);
    expect(() => deleteAppSnapshots(dataRoot, fresh)).not.toThrow();
  });

  test("T09 が appDir を丸ごと消したあとに呼んでも二重削除で壊れない", () => {
    const appId = "double-delete";
    newApp(appId);
    takeReferencedSnapshot(appId, "d-001");

    // T09 のアプリ完全削除(appDir を rmSync)を先に行う。
    rmSync(appDir(dataRoot, appId), { recursive: true, force: true });
    // その従属操作として本プリミティブを呼んでも例外にならない。
    expect(() => deleteAppSnapshots(dataRoot, appId)).not.toThrow();
  });
});

describe("auditAllSnapshots: 全アプリ横断", () => {
  test("各アプリぶんの監査結果を返す", () => {
    newApp("app-a");
    newApp("app-b");
    takeReferencedSnapshot("app-a", "d-001");
    takeSnapshot(dataRoot, "app-b", "d-001-orphan");

    const all = auditAllSnapshots(dataRoot);
    const byApp = new Map(all.map((audit) => [audit.app_id, audit]));
    expect(byApp.get("app-a")?.orphans).toEqual([]);
    expect(byApp.get("app-a")?.referenced).toHaveLength(1);
    expect(byApp.get("app-b")?.orphans).toEqual(["0001-d-001-orphan"]);
  });

  test("apps ディレクトリが無いデータルートでは空配列", async () => {
    const empty = await mkdtemp(join(tmpdir(), "gp-orphan-empty-"));
    try {
      expect(auditAllSnapshots(empty)).toEqual([]);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  test("ディスクに直置きされた非スナップショットのゴミは on_disk に数えない", () => {
    // listSnapshots は `<4桁>-<diff_id>` 形式のディレクトリだけを見る。
    const appId = "junk";
    newApp(appId);
    mkdirSync(appSnapshotsDir(dataRoot, appId), { recursive: true });
    // 連番形式に合致しないディレクトリ・ファイルは対象外(監査の母数に混ぜない)。
    mkdirSync(join(appSnapshotsDir(dataRoot, appId), "not-a-snapshot"), { recursive: true });
    writeFileSync(join(appSnapshotsDir(dataRoot, appId), "README.txt"), "noise");

    const audit = auditAppSnapshots(dataRoot, appId);
    expect(audit.on_disk).toEqual([]);
    expect(audit.orphans).toEqual([]);
  });
});

// --- orphan blob 検出と undo の整合(V2-M2-T04 / ADR-0035 §4)-----------------------

/** image フィールドを1つ持つアプリのマニフェスト。 */
function imageManifest(appId: string): Manifest {
  return {
    app: {
      id: appId,
      name: "商品カタログ",
      tables: [
        {
          id: "products",
          name: "商品",
          fields: [
            { id: "name", name: "名前", type: "text", required: true },
            { id: "photo", name: "写真", type: "image" },
          ],
        },
      ],
      views: [],
    },
  };
}

/** image アプリを作る(まだ blob/レコードは無い)。 */
function newImageApp(appId: string): Manifest {
  createApp(store, "商品カタログ", { app_id: appId });
  const manifest = imageManifest(appId);
  const applied = applyManifest(dataRoot, appId, manifest);
  if (!applied.valid) {
    throw new Error(`前提のマニフェスト投入に失敗: ${JSON.stringify(applied.errors)}`);
  }
  return manifest;
}

/** blob 実体を置き、`_files` に1行入れて file_id を返す(サーバのアップロード API 相当)。 */
function uploadBlob(appId: string, bytes: number[], fileId: string): string {
  const sha256 = putBlob(dataRoot, appId, new Uint8Array(bytes));
  const db = new Database(appDbPath(dataRoot, appId), { readwrite: true, create: false });
  try {
    db.exec(createFilesTableSql());
    db.query(
      `INSERT INTO "${FILES_TABLE_ID}" ("file_id","sha256","mime","size","filename","created_at") VALUES (?,?,?,?,?,?)`,
    ).run(fileId, sha256, "image/png", bytes.length, "x.png", new Date().toISOString());
  } finally {
    db.close();
  }
  return sha256;
}

/** app.sqlite を直接触るヘルパ(_files 行の物理削除など)。 */
function withAppDb<T>(appId: string, fn: (db: Database) => T): T {
  const db = new Database(appDbPath(dataRoot, appId), { readwrite: true, create: false });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

describe("auditAppBlobs: orphan blob の検出", () => {
  test("現行 `_files` が参照する blob は orphan ではない", () => {
    const appId = "blob-ref-current";
    newImageApp(appId);
    const sha = uploadBlob(appId, [0x89, 0x50, 0x4e, 0x47], "file-a");

    const audit = auditAppBlobs(dataRoot, appId);
    expect(audit.on_disk).toEqual([sha]);
    expect(audit.referenced).toEqual([sha]);
    expect(audit.orphans).toEqual([]);
    expect(audit.bytes).toBeGreaterThan(0);
  });

  test("どこからも参照されない blob は orphan に出る(検出のみ・消さない)", () => {
    const appId = "blob-orphan";
    newImageApp(appId);
    // `_files` に登録せず blob 実体だけを置く(参照ゼロ)。
    const orphanSha = putBlob(dataRoot, appId, new Uint8Array([0x47, 0x49, 0x46]));

    const audit = auditAppBlobs(dataRoot, appId);
    expect(audit.on_disk).toEqual([orphanSha]);
    expect(audit.referenced).toEqual([]);
    expect(audit.orphans).toEqual([orphanSha]);
    // **検出しただけで消えていない**(自動刈り取りは無い。ADR-0035 §3 限定7)。
    expect(existsSync(join(appBlobsDir(dataRoot, appId), orphanSha))).toBe(true);
  });

  test("現行が参照しなくても snapshot の `_files` が参照する blob は orphan ではない(undo 安全)", () => {
    const appId = "blob-ref-snapshot";
    newImageApp(appId);
    const sha = uploadBlob(appId, [0x89, 0x50, 0x4e, 0x47], "file-a");

    // この時点の app.sqlite(_files に file-a)をスナップショットに残す。
    takeSnapshot(dataRoot, appId, "d-keep");

    // 現行から _files 行を物理削除する(現行はもう file-a を参照しない)。
    withAppDb(appId, (db) => {
      db.query(`DELETE FROM "${FILES_TABLE_ID}" WHERE "file_id" = ?`).run("file-a");
    });

    const audit = auditAppBlobs(dataRoot, appId);
    // 現行だけを見れば参照ゼロだが、**全 snapshot の _files を見るので referenced に入る**。
    expect(audit.referenced).toEqual([sha]);
    // したがって orphan ではない —— これが「全 snapshot 参照を見ることが undo の正しさを守る」。
    expect(audit.orphans).toEqual([]);
  });

  test("現行にも全 snapshot にも参照が無くなって初めて orphan になる", () => {
    const appId = "blob-truly-orphan";
    newImageApp(appId);
    const sha = uploadBlob(appId, [0x89, 0x50, 0x4e, 0x47], "file-a");
    takeSnapshot(dataRoot, appId, "d-keep");
    withAppDb(appId, (db) => {
      db.query(`DELETE FROM "${FILES_TABLE_ID}" WHERE "file_id" = ?`).run("file-a");
    });
    // snapshot も消せば、現行にも全 snapshot にも参照が無くなる。
    deleteAppSnapshots(dataRoot, appId);

    const audit = auditAppBlobs(dataRoot, appId);
    expect(audit.referenced).toEqual([]);
    expect(audit.orphans).toEqual([sha]);
  });

  test("blobs/ が無い(画像未アップロード)アプリは空の監査になる", () => {
    const appId = "blob-none";
    newImageApp(appId);
    const audit = auditAppBlobs(dataRoot, appId);
    expect(audit).toEqual({
      app_id: appId,
      on_disk: [],
      referenced: [],
      orphans: [],
      bytes: 0,
    });
  });
});

describe("deleteAppBlobs: アプリ単位の blob 全消し(冪等)", () => {
  test("blobs/ を丸ごと消す。存在しなくても二重呼び出しでも壊れない", () => {
    const appId = "blob-delete";
    newImageApp(appId);
    uploadBlob(appId, [0x89, 0x50, 0x4e, 0x47], "file-a");
    expect(existsSync(appBlobsDir(dataRoot, appId))).toBe(true);

    deleteAppBlobs(dataRoot, appId);
    expect(existsSync(appBlobsDir(dataRoot, appId))).toBe(false);
    // 冪等: もう無くても、二度呼んでも例外にならない。
    expect(() => deleteAppBlobs(dataRoot, appId)).not.toThrow();
  });
});

describe("undo 往復で画像が戻る(blob が刈られない。ADR-0035 §4)", () => {
  test("画像アップロード→紐付け→変更→undo で、画像がまだ配信できる", () => {
    const appId = "undo-image";
    const manifest = newImageApp(appId);
    const sha = uploadBlob(appId, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a], "file-a");

    // 画像をレコードに紐付ける。
    const created = withAppDb(appId, (db) => {
      const result = createRecord(db, manifest, "products", { name: "たまご", photo: "file-a" });
      if (!result.ok) {
        throw new Error(`レコード作成に失敗: ${JSON.stringify(result.errors)}`);
      }
      return result.value;
    });

    // apply(add_field)で「変更」を入れる —— この直前の状態(photo=file-a)がスナップショットに残る。
    const diff: Diff = {
      diff_id: "d-add-note",
      intent: "備考を足したい",
      operations: [
        { op: "add_field", table: "products", field: { id: "note", name: "備考", type: "text" } },
      ],
    };
    const applied = applyDiff(dataRoot, appId, diff);
    expect(applied.valid).toBe(true);

    // apply 後にさらに画像リンクを外す(現行では photo が空になる)。
    withAppDb(appId, (db) => {
      const afterManifest: Manifest = {
        app: {
          ...manifest.app,
          tables: manifest.app.tables.map((t) =>
            t.id === "products"
              ? { ...t, fields: [...t.fields, { id: "note", name: "備考", type: "text" as const }] }
              : t,
          ),
        },
      };
      const result = updateRecord(db, afterManifest, "products", created._id, { photo: null });
      if (!result.ok) {
        throw new Error(`レコード更新に失敗: ${JSON.stringify(result.errors)}`);
      }
    });

    // undo で apply 直前(photo=file-a)へ戻す。
    const result = undo(dataRoot, appId);
    expect(result.valid).toBe(true);

    // (1) レコードの image フィールドが file-a に戻っている。
    const row = withAppDb(appId, (db) => {
      const listed = listRecords(db, manifest, "products");
      if (!listed.ok) {
        throw new Error(`一覧に失敗: ${JSON.stringify(listed.errors)}`);
      }
      return listed.value[0];
    });
    expect(row?.photo).toBe("file-a");

    // (2) blob 実体が blobs/ に残っており、配信できる(getBlob が中身を返す)。
    expect(getBlob(dataRoot, appId, sha)).not.toBeNull();

    // (3) orphan 監査でも referenced 側(現行 _files が file-a→sha を参照)であり orphan ではない。
    const audit = auditAppBlobs(dataRoot, appId);
    expect(audit.orphans).toEqual([]);
    expect(audit.referenced).toContain(sha);
  });
});

// ---------------------------------------------------------------------------
// V3-M5-T02: 逃げ道(任意 CSS)の資産の孤児検出(D-G5 / ADR-0055 限定10)
// ---------------------------------------------------------------------------
//
// **`auditAppBlobs` を流用できない**(V3-M5-T01 の申し送り2)—— 本体の籠が `blobs/` と
// 分かれている(`apps/<id>/escape-hatch/`)ため、参照集合の読み先も `_files.sha256` ではなく
// **view の逃げ道の参照(`custom_css.digest`)**になる。形は同型で、中身が違う。

describe("auditAppEscapeHatch: 逃げ道の孤児資産の検出(ADR-0055 限定10)", () => {
  const CSS_A = ".gp-print { color: #111 }";
  const CSS_B = ".gp-print { color: #222 }";

  /** 逃げ道の参照を持つ(または持たない)ビュー1枚のマニフェスト。 */
  function cssManifest(appId: string, css?: { asset: string; digest: string }): Manifest {
    const view: Manifest["app"]["views"][number] = {
      id: "book-list",
      type: "list_view",
      table: "books",
      columns: ["title"],
    };
    if (css !== undefined) {
      view.custom_css = css;
    }
    return { app: { ...manifestOf(appId).app, views: [view] } };
  }

  function newCssApp(appId: string, css?: { asset: string; digest: string }): void {
    createApp(store, "蔵書管理", { app_id: appId });
    const applied = applyManifest(dataRoot, appId, cssManifest(appId, css));
    if (!applied.valid) {
      throw new Error(`前提のマニフェスト投入に失敗: ${JSON.stringify(applied.errors)}`);
    }
  }

  test("現行マニフェストが参照するダイジェストは orphan ではない", () => {
    const appId = "hatch-ref-current";
    createApp(store, "蔵書管理", { app_id: appId });
    const digest = putEscapeHatchBody(dataRoot, appId, new TextEncoder().encode(CSS_A));
    const applied = applyManifest(dataRoot, appId, cssManifest(appId, { asset: "print", digest }));
    expect(applied.valid).toBe(true);

    const audit = auditAppEscapeHatch(dataRoot, appId);
    expect(audit.on_disk).toEqual([digest]);
    expect(audit.referenced).toEqual([digest]);
    expect(audit.orphans).toEqual([]);
    expect(audit.bytes).toBeGreaterThan(0);
  });

  test("どこからも参照されない実体は orphan に出る(検出のみ・自動で刈らない)", () => {
    const appId = "hatch-orphan";
    newCssApp(appId);
    const digest = putEscapeHatchBody(dataRoot, appId, new TextEncoder().encode(CSS_A));

    const audit = auditAppEscapeHatch(dataRoot, appId);
    expect(audit.on_disk).toEqual([digest]);
    expect(audit.referenced).toEqual([]);
    expect(audit.orphans).toEqual([digest]);
    // **検出しただけで消えていない**(ADR-0055 限定10。ADR-0035 限定7 と同型)。
    expect(escapeHatchBodyExists(dataRoot, appId, digest)).toBe(true);
  });

  test("現行が参照しなくても snapshot の manifest.json が参照していれば orphan ではない(undo 安全)", () => {
    const appId = "hatch-ref-snapshot";
    createApp(store, "蔵書管理", { app_id: appId });
    const digest = putEscapeHatchBody(dataRoot, appId, new TextEncoder().encode(CSS_A));
    applyManifest(dataRoot, appId, cssManifest(appId, { asset: "print", digest }));

    // この時点の manifest.json(参照あり)をスナップショットに残す。
    takeSnapshot(dataRoot, appId, "d-keep");
    // 現行から参照を外す(参照の無い画面へ書き換える)。
    applyManifest(dataRoot, appId, cssManifest(appId));

    const audit = auditAppEscapeHatch(dataRoot, appId);
    // 現行だけを見れば参照ゼロだが、**全 snapshot の manifest.json を見るので referenced に入る**。
    expect(audit.referenced).toEqual([digest]);
    expect(audit.orphans).toEqual([]);
  });

  test("現行にも全 snapshot にも参照が無くなって初めて orphan になる", () => {
    const appId = "hatch-truly-orphan";
    createApp(store, "蔵書管理", { app_id: appId });
    const digest = putEscapeHatchBody(dataRoot, appId, new TextEncoder().encode(CSS_A));
    applyManifest(dataRoot, appId, cssManifest(appId, { asset: "print", digest }));
    takeSnapshot(dataRoot, appId, "d-keep");
    applyManifest(dataRoot, appId, cssManifest(appId));
    deleteAppSnapshots(dataRoot, appId);

    const audit = auditAppEscapeHatch(dataRoot, appId);
    expect(audit.referenced).toEqual([]);
    expect(audit.orphans).toEqual([digest]);
  });

  test("escape-hatch/ が無い(逃げ道を一度も発行していない)アプリは空の監査になる", () => {
    const appId = "hatch-none";
    newCssApp(appId);
    expect(auditAppEscapeHatch(dataRoot, appId)).toEqual({
      app_id: appId,
      on_disk: [],
      referenced: [],
      orphans: [],
      bytes: 0,
    });
  });

  test("同じ view id で作り直された別物の画面に、孤児が黙って再付着しない(V3-M0-T07 §5-3)", () => {
    const appId = "hatch-recreate";
    createApp(store, "蔵書管理", { app_id: appId });
    const digestA = putEscapeHatchBody(dataRoot, appId, new TextEncoder().encode(CSS_A));
    applyManifest(dataRoot, appId, cssManifest(appId, { asset: "print", digest: digestA }));
    takeSnapshot(dataRoot, appId, "d-old");

    // **同じ view id を、別の資産で作り直す。**
    const digestB = putEscapeHatchBody(dataRoot, appId, new TextEncoder().encode(CSS_B));
    applyManifest(dataRoot, appId, cssManifest(appId, { asset: "print", digest: digestB }));

    // (1) **現行が参照するのは B だけである** —— 名前が同じでもダイジェストが違えば別物で
    //     あり、**古い実体が同じ view id に再付着することはない**(参照は内容で決まる)。
    const current = readCurrentManifest(dataRoot, appId);
    expect(current.app.views[0]?.custom_css).toEqual({ asset: "print", digest: digestB });
    expect(digestA).not.toBe(digestB);

    // (2) A は現行から外れたが、**snapshot が参照しているので孤児ではない**(undo の戻り先)。
    const audit = auditAppEscapeHatch(dataRoot, appId);
    expect(audit.on_disk).toEqual([digestA, digestB].sort());
    expect(audit.referenced).toEqual([digestA, digestB].sort());
    expect(audit.orphans).toEqual([]);
  });

  test("逃げ道の実体は auditAppBlobs の孤児に1件も出ない(籠を分けたことの担保)", () => {
    // **同じ籠に入れると、`_files` の孤児検出が逃げ道の実体を「参照の無い画像」と
    // 必ず誤って挙げる**(V3-M5-T01 §3-1 の3)。籠を分けたので、そうならない。
    const appId = "hatch-not-blob";
    newCssApp(appId);
    putEscapeHatchBody(dataRoot, appId, new TextEncoder().encode(CSS_A));

    const blobs = auditAppBlobs(dataRoot, appId);
    expect(blobs.on_disk).toEqual([]);
    expect(blobs.orphans).toEqual([]);
  });

  test("壊れた manifest.json を持つ snapshot があっても監査は落ちない(参照ゼロとして数える)", () => {
    const appId = "hatch-broken-snapshot";
    createApp(store, "蔵書管理", { app_id: appId });
    const digest = putEscapeHatchBody(dataRoot, appId, new TextEncoder().encode(CSS_A));
    applyManifest(dataRoot, appId, cssManifest(appId, { asset: "print", digest }));
    const snapshot = takeSnapshot(dataRoot, appId, "d-broken").name;
    writeFileSync(join(snapshotDir(dataRoot, appId, snapshot), "manifest.json"), "{ broken");

    const audit = auditAppEscapeHatch(dataRoot, appId);
    // 現行が参照しているので orphan にはならない。**壊れた1本は参照ゼロとして数える。**
    expect(audit.referenced).toEqual([digest]);
    expect(audit.orphans).toEqual([]);
  });
});
