import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFilesTableSql, FILES_TABLE_ID } from "../shared/files-table.ts";
import { applyManifest, readCurrentManifest } from "./apply-manifest.ts";
import { putBlob } from "./blob-store.ts";
import { createApp } from "./create-app.ts";
import { KernelMetaStore } from "./meta-store.ts";
import {
  createRecord,
  deleteRecord,
  listRecords,
  type RecordRow,
  updateRecord,
} from "./records.ts";
import { listSnapshots, restoreSnapshot, takeSnapshot } from "./snapshot.ts";
import { appBlobsDir, appDbPath, appManifestPath, snapshotDir } from "./storage-paths.ts";
import type { Manifest } from "./types.ts";

let dataRoot: string;
let store: KernelMetaStore;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-snapshot-"));
  store = KernelMetaStore.open(dataRoot);
});

afterEach(async () => {
  store.close();
  await rm(dataRoot, { recursive: true, force: true });
});

/** 全フィールド型を1つずつ含むマニフェスト(reference の参照先も含む)。 */
function manifestOf(appId: string): Manifest {
  return {
    app: {
      id: appId,
      name: "蔵書管理",
      tables: [
        {
          id: "authors",
          name: "著者",
          fields: [{ id: "full_name", name: "氏名", type: "text", required: true }],
        },
        {
          id: "books",
          name: "本",
          fields: [
            { id: "title", name: "タイトル", type: "text", required: true },
            { id: "memo", name: "メモ", type: "long_text" },
            { id: "price", name: "価格", type: "number" },
            { id: "read", name: "読了", type: "boolean" },
            { id: "published_on", name: "刊行日", type: "date" },
            { id: "status", name: "状態", type: "select", options: ["未読", "読書中", "読了"] },
            { id: "author", name: "著者", type: "reference", reference_table: "authors" },
          ],
        },
      ],
      views: [],
    },
  };
}

/** アプリを作り、全型のマニフェストを投入する。 */
function newApp(appId: string): Manifest {
  createApp(store, "蔵書管理", { app_id: appId });
  const manifest = manifestOf(appId);
  const applied = applyManifest(dataRoot, appId, manifest);
  if (!applied.valid) {
    throw new Error(`テスト前提のマニフェスト投入に失敗: ${JSON.stringify(applied.errors)}`);
  }
  return manifest;
}

function openApp(appId: string): Database {
  return new Database(appDbPath(dataRoot, appId), { readwrite: true, create: false });
}

function must<T>(result: { ok: true; value: T } | { ok: false; errors: unknown[] }): T {
  if (!result.ok) {
    throw new Error(`レコード操作に失敗: ${JSON.stringify(result.errors)}`);
  }
  return result.value;
}

/** 全テーブルの全レコード。ラウンドトリップの完全一致判定に使う。 */
function dumpAll(db: Database, manifest: Manifest): Record<string, RecordRow[]> {
  const dump: Record<string, RecordRow[]> = {};
  for (const table of manifest.app.tables) {
    dump[table.id] = must(listRecords(db, manifest, table.id));
  }
  return dump;
}

/** 状態A(著者2件・本2件、全フィールド型に値が入っている)を作る。 */
function seedStateA(db: Database, manifest: Manifest): void {
  const author = must(createRecord(db, manifest, "authors", { full_name: "夏目漱石" }));
  must(createRecord(db, manifest, "authors", { full_name: "森鴎外" }));
  must(
    createRecord(db, manifest, "books", {
      title: "こころ",
      memo: "複数行の\nメモ",
      price: 1234.5,
      read: true,
      published_on: "1914-08-11",
      status: "読了",
      author: author._id,
    }),
  );
  must(
    createRecord(db, manifest, "books", {
      title: "未設定だらけの本",
      memo: null,
      price: null,
      read: false,
      published_on: null,
      status: null,
      author: null,
    }),
  );
}

describe("takeSnapshot / restoreSnapshot のラウンドトリップ", () => {
  test("状態A→スナップショット→変更→復元 で状態Aと完全一致する", () => {
    const appId = "roundtrip";
    const manifest = newApp(appId);

    const db = openApp(appId);
    seedStateA(db, manifest);
    const stateA = dumpAll(db, manifest);
    const manifestA = readCurrentManifest(dataRoot, appId);
    db.close();

    const ref = takeSnapshot(dataRoot, appId, "d1");
    expect(ref.name).toBe("0001-d1");

    // 変更: 追加・更新・削除をすべて行い、マニフェストも additive に進める。
    const db2 = openApp(appId);
    const books = must(listRecords(db2, manifest, "books"));
    const first = books[0];
    const second = books[1];
    if (first === undefined || second === undefined) {
      throw new Error("テスト前提が壊れています");
    }
    must(createRecord(db2, manifest, "books", { title: "追加された本" }));
    must(updateRecord(db2, manifest, "books", first._id, { title: "書き換えられた", read: false }));
    must(deleteRecord(db2, manifest, "books", second._id));
    db2.close();

    const evolved = manifestOf(appId);
    evolved.app.tables[1]?.fields.push({ id: "tags", name: "タグ", type: "text" });
    const applied = applyManifest(dataRoot, appId, evolved);
    expect(applied.valid).toBe(true);

    // 復元。
    restoreSnapshot(dataRoot, appId, ref.name);

    const restoredManifest = readCurrentManifest(dataRoot, appId);
    expect(restoredManifest).toEqual(manifestA);

    const db3 = openApp(appId);
    try {
      expect(dumpAll(db3, restoredManifest)).toEqual(stateA);
    } finally {
      db3.close();
    }
  });
});

describe("SQLite の整合性", () => {
  test("別接続の書き込みトランザクション中(RESERVED)でもスナップショットが壊れない", () => {
    const appId = "in-txn";
    const manifest = newApp(appId);

    const db = openApp(appId);
    seedStateA(db, manifest);
    const committed = dumpAll(db, manifest);

    // 未コミットの書き込みトランザクションを開いたまま取得する。
    //
    // ページキャッシュを明示的に大きく取るのが要点である。rollback journal モードでは
    // キャッシュが溢れる(cache spill)と、書き手は未コミットのページを本体ファイルへ
    // 書き出すために RESERVED から **EXCLUSIVE へ昇格し、トランザクション終了まで
    // それを手放さない**。そうなると読み手は SELECT すら通らなくなり、
    // 「未コミット分を除いた整合コピーが取れる」という本テストの検証対象そのものが
    // 成立しなくなる(その状況は次のテストで別途検証する)。
    //
    // ここで検証したいのは「書き手が RESERVED どまりのとき、コピーは
    // コミット済みの状態だけを写す」ことなので、溢れない条件を明示的に作る。
    const dbPath = appDbPath(dataRoot, appId);
    const writer = openApp(appId);
    writer.exec("PRAGMA cache_size = -20000;");
    writer.exec("BEGIN IMMEDIATE;");
    const sizeBeforeWrites = statSync(dbPath).size;
    for (let i = 0; i < 500; i++) {
      must(createRecord(writer, manifest, "authors", { full_name: `未コミットの著者${i}` }));
    }
    // 前提の明示。本体ファイルが伸びていない = キャッシュが溢れていない = RESERVED どまり。
    // ここが崩れたら、以降の assert が何を確かめているのか分からなくなるので必ず見る。
    expect(statSync(dbPath).size).toBe(sizeBeforeWrites);

    let ref: { name: string };
    try {
      ref = takeSnapshot(dataRoot, appId, "d1");
    } finally {
      writer.exec("ROLLBACK;");
      writer.close();
      db.close();
    }

    // スナップショットは整合状態で読め、未コミット分は含まない。
    const snap = new Database(join(snapshotDir(dataRoot, appId, ref.name), "app.sqlite"), {
      readonly: true,
    });
    try {
      const check = snap.query("PRAGMA integrity_check").get() as { integrity_check: string };
      expect(check.integrity_check).toBe("ok");
      expect(dumpAll(snap, manifest)).toEqual(committed);
    } finally {
      snap.close();
    }
  });

  test("別接続が EXCLUSIVE を保持している間は、半端なスナップショットを残さず失敗する", () => {
    const appId = "exclusive";
    const manifest = newApp(appId);

    const db = openApp(appId);
    seedStateA(db, manifest);

    // `BEGIN EXCLUSIVE` は cache spill の有無に関係なく、SQLite の版にも OS にも依らず
    // 決定的に EXCLUSIVE ロックを取る。この状態では SQLite が読み取り自体を拒むので、
    // 整合コピーは原理的に取得できない。
    //
    // 取得できないときに何が起きるべきかが、ここで固定したい契約である。
    // スナップショットは undo の土台なので、**黙って壊れたものを残すくらいなら
    // 失敗して何も残さない**のが正しい。busy_timeout はテスト条件として明示的に
    // 短くする(既定値のまま待つとテストが無意味に遅くなるだけで、
    // 単一スレッドのこのテストではロックは決して解けない)。
    const writer = openApp(appId);
    writer.exec("BEGIN EXCLUSIVE;");

    try {
      expect(() => takeSnapshot(dataRoot, appId, "d1", { busyTimeoutMs: 50 })).toThrow(
        /ロックを保持/,
      );
    } finally {
      writer.exec("ROLLBACK;");
      writer.close();
      db.close();
    }

    // 作りかけのディレクトリが残っていないこと(残ると「戻せるつもりで戻せない」)。
    expect(listSnapshots(dataRoot, appId)).toEqual([]);
    expect(existsSync(snapshotDir(dataRoot, appId, "0001-d1"))).toBe(false);
  });

  test("ロック競合時は即座に諦めず busy_timeout の分だけ待つ", () => {
    const appId = "busy-timeout";
    const manifest = newApp(appId);

    const db = openApp(appId);
    seedStateA(db, manifest);

    // busy_timeout が設定されていなければ(SQLite の既定は 0)、ロック競合は
    // 待たずに即 SQLITE_BUSY になる。他接続が一瞬ロックを握っただけで
    // apply 直前のスナップショットが落ちるのは弱すぎるので、待つことを契約にする。
    //
    // 検証は**下限だけ**にする。上限(「N ミリ秒以内に返る」)は CI の負荷で
    // 容易に揺れるうえ、ここで守りたい性質でもない。
    const writer = openApp(appId);
    writer.exec("BEGIN EXCLUSIVE;");

    const waitMs = 300;
    const startedAt = Date.now();
    try {
      expect(() => takeSnapshot(dataRoot, appId, "d1", { busyTimeoutMs: waitMs })).toThrow();
    } finally {
      writer.exec("ROLLBACK;");
      writer.close();
      db.close();
    }
    const elapsed = Date.now() - startedAt;

    // 待たずに諦めていたら数ミリ秒で返ってくる。余裕を見て 8 割で判定する。
    expect(elapsed).toBeGreaterThanOrEqual(waitMs * 0.8);
  });

  test("WALモードでコミット済みの直近の書き込みがスナップショットに含まれる", () => {
    const appId = "wal-regression";
    const manifest = newApp(appId);

    // app.sqlite を WAL に切り替え、接続を開いたまま(=チェックポイントされていない)にする。
    const db = openApp(appId);
    db.exec("PRAGMA journal_mode = WAL;");
    seedStateA(db, manifest);
    must(createRecord(db, manifest, "authors", { full_name: "WALにだけ居る著者" }));
    const expected = dumpAll(db, manifest);

    const ref = takeSnapshot(dataRoot, appId, "d1");
    db.close();

    const snap = new Database(join(snapshotDir(dataRoot, appId, ref.name), "app.sqlite"), {
      readonly: true,
    });
    try {
      expect(dumpAll(snap, manifest)).toEqual(expected);
    } finally {
      snap.close();
    }
  });

  test("復元時に古い -wal / -shm が復元後の状態を汚染しない", () => {
    const appId = "stale-wal";
    const manifest = newApp(appId);

    const db = openApp(appId);
    seedStateA(db, manifest);
    const stateA = dumpAll(db, manifest);
    db.close();

    const ref = takeSnapshot(dataRoot, appId, "d1");

    // スナップショット後に WAL モードで書き込み、-wal を残したまま復元する。
    const lingering = openApp(appId);
    lingering.exec("PRAGMA journal_mode = WAL;");
    must(createRecord(lingering, manifest, "authors", { full_name: "復元で消えるべき著者" }));
    expect(existsSync(`${appDbPath(dataRoot, appId)}-wal`)).toBe(true);

    restoreSnapshot(dataRoot, appId, ref.name);

    expect(existsSync(`${appDbPath(dataRoot, appId)}-wal`)).toBe(false);
    expect(existsSync(`${appDbPath(dataRoot, appId)}-shm`)).toBe(false);

    const fresh = new Database(appDbPath(dataRoot, appId), { readonly: true });
    try {
      expect(dumpAll(fresh, manifest)).toEqual(stateA);
    } finally {
      fresh.close();
      lingering.close();
    }
  });
});

describe("連番と一覧", () => {
  test("同一アプリで取得を重ねると 0001, 0002, ... と増える", () => {
    const appId = "seq";
    newApp(appId);

    expect(takeSnapshot(dataRoot, appId, "first").name).toBe("0001-first");
    expect(takeSnapshot(dataRoot, appId, "second").name).toBe("0002-second");
    const third = takeSnapshot(dataRoot, appId, "third");
    expect(third.name).toBe("0003-third");
    expect(third.sequence).toBe(3);
    expect(third.diff_id).toBe("third");
    expect(third.dir).toBe(snapshotDir(dataRoot, appId, "0003-third"));

    expect(listSnapshots(dataRoot, appId)).toEqual(["0001-first", "0002-second", "0003-third"]);
    // 文字列ソート順がそのまま時系列順になっていること。
    const names = listSnapshots(dataRoot, appId);
    expect([...names].sort()).toEqual(names);
  });

  test("スナップショットは manifest.json と app.sqlite の2ファイルを持つ", () => {
    const appId = "files";
    newApp(appId);
    const ref = takeSnapshot(dataRoot, appId, "d1");
    expect(readFileSync(join(ref.dir, "manifest.json"), "utf-8")).toBe(
      readFileSync(appManifestPath(dataRoot, appId), "utf-8"),
    );
    expect(existsSync(join(ref.dir, "app.sqlite"))).toBe(true);
  });

  test("別アプリの連番は互いに干渉しない", () => {
    newApp("app-a");
    newApp("app-b");

    expect(takeSnapshot(dataRoot, "app-a", "x").name).toBe("0001-x");
    expect(takeSnapshot(dataRoot, "app-a", "y").name).toBe("0002-y");
    expect(takeSnapshot(dataRoot, "app-b", "z").name).toBe("0001-z");
    expect(takeSnapshot(dataRoot, "app-a", "w").name).toBe("0003-w");

    expect(listSnapshots(dataRoot, "app-a")).toEqual(["0001-x", "0002-y", "0003-w"]);
    expect(listSnapshots(dataRoot, "app-b")).toEqual(["0001-z"]);
  });

  test("スナップショットが1つも無ければ listSnapshots は空配列", () => {
    newApp("empty");
    expect(listSnapshots(dataRoot, "empty")).toEqual([]);
  });
});

describe("エラー", () => {
  test("存在しないスナップショットの復元は例外になる", () => {
    const appId = "missing";
    newApp(appId);
    takeSnapshot(dataRoot, appId, "d1");
    expect(() => restoreSnapshot(dataRoot, appId, "0099-nope")).toThrow(/0099-nope/);
  });

  test("リソースID規約に反する diff_id は拒否される", () => {
    const appId = "bad-diff-id";
    newApp(appId);
    expect(() => takeSnapshot(dataRoot, appId, "../escape")).toThrow();
    expect(listSnapshots(dataRoot, appId)).toEqual([]);
  });

  test("存在しないアプリのスナップショット取得は例外になる", () => {
    expect(() => takeSnapshot(dataRoot, "no-such-app", "d1")).toThrow(/no-such-app/);
  });
});

/**
 * 画像 blob とスナップショットの非対称(V2-M2-T04 / ADR-0035 §4「(snapshot)」)。
 *
 * **snapshot は blob 実体をコピーしない**(肥大回避)一方で、file_id→sha256 の `_files` メタは
 * app.sqlite 内なので snapshot に**含まれる**。これを実データで固定する。
 */
describe("画像 blob の非コピー(スナップショット非肥大)", () => {
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

  /** image アプリを作り、blob を1つ置き、`_files` に1行入れて image レコードを作る。 */
  function newImageApp(appId: string): { manifest: Manifest; fileId: string; sha256: string } {
    createApp(store, "商品カタログ", { app_id: appId });
    const manifest = imageManifest(appId);
    const applied = applyManifest(dataRoot, appId, manifest);
    if (!applied.valid) {
      throw new Error(`前提のマニフェスト投入に失敗: ${JSON.stringify(applied.errors)}`);
    }
    // blob 実体を content-addressed で保存(sha256 = 実体名)。
    const sha256 = putBlob(dataRoot, appId, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    const fileId = "file-0001";
    const db = openApp(appId);
    // `_files` は遅延生成なので、テスト側で用意して1行入れる(サーバのアップロード API 相当)。
    db.exec(createFilesTableSql());
    db.query(
      `INSERT INTO "${FILES_TABLE_ID}" ("file_id","sha256","mime","size","filename","created_at") VALUES (?,?,?,?,?,?)`,
    ).run(fileId, sha256, "image/png", 4, "p.png", new Date().toISOString());
    must(createRecord(db, manifest, "products", { name: "たまご", photo: fileId }));
    db.close();
    return { manifest, fileId, sha256 };
  }

  test("snapshot を撃っても blobs/ に実体が複製されない(snapshots 配下は manifest+app.sqlite のみ)", () => {
    const appId = "img-nonbloat";
    const { sha256 } = newImageApp(appId);

    // 取得前後で blobs/ の中身(実体1つ)が増えないことを固定する。
    const blobsBefore = readdirSync(appBlobsDir(dataRoot, appId)).sort();
    expect(blobsBefore).toEqual([sha256]);

    const ref = takeSnapshot(dataRoot, appId, "d-snap");

    // (1) blobs/ は増えていない(実体は1つのまま)。
    expect(readdirSync(appBlobsDir(dataRoot, appId)).sort()).toEqual([sha256]);
    // (2) snapshot ディレクトリは manifest.json + app.sqlite の2ファイルだけ。blob 実体は無い。
    const snapEntries = readdirSync(ref.dir).sort();
    expect(snapEntries).toEqual(["app.sqlite", "manifest.json"]);
    // (3) 念のため snapshot 配下に sha256 名のファイル(= blob 実体の複製)が無い。
    expect(snapEntries).not.toContain(sha256);
  });

  test("snapshot の app.sqlite には `_files` メタ(file_id→sha256)が含まれる", () => {
    const appId = "img-meta";
    const { fileId, sha256 } = newImageApp(appId);
    const ref = takeSnapshot(dataRoot, appId, "d-meta");

    const snapDb = new Database(join(ref.dir, "app.sqlite"), { readonly: true });
    try {
      const row = snapDb
        .query(`SELECT "sha256" AS sha256 FROM "${FILES_TABLE_ID}" WHERE "file_id" = ?`)
        .get(fileId) as { sha256: string } | null;
      // メタが snapshot に写っているので、undo 復元後も file_id→sha256 が生きる。
      expect(row?.sha256).toBe(sha256);
    } finally {
      snapDb.close();
    }
  });
});
