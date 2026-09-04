/**
 * EC-G8 一意制約(`unique: boolean`・アプリ層書込時検査。ADR-0038)の TDD テスト。
 *
 * 検証観点(`docs/plan/v2/records/v2-m3.md` §1 T03):
 * - `unique: true` フィールドへの重複値書込が拒否される(create / update)
 * - null は複数許す(未設定は重複対象にしない = SQL の UNIQUE と同じ)
 * - update 時は自分自身の行を除外(自分の値のまま更新しても通る)
 * - 後付け unique(change_field で false → true)で既存重複があれば**差分全体を拒否**
 *   (部分適用なし = 1バイトも変わらない・スナップショットも作られない)
 * - 既存重複が無ければ後付け成功で unique が永続する
 * - **DDL に UNIQUE / CHECK が増えていない**(ddl.ts の生成 SQL に UNIQUE が出ない)
 *
 * MCP / HTTP 両経路での拒否は `src/mcp/tools/unique-dual-path.test.ts` が見る
 * (どちらもこの `records.ts` の関門を通る = ADR-0003 §7)。
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDiff } from "./apply-diff.ts";
import { applyManifest } from "./apply-manifest.ts";
import { createApp } from "./create-app.ts";
import { createTableSql } from "./ddl.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { createRecord, listRecords, updateRecord } from "./records.ts";
import { listSnapshots } from "./snapshot.ts";
import { appDbPath, appManifestPath } from "./storage-paths.ts";
import type { Diff, Manifest, Table } from "./types.ts";

const APP_ID = "members-app";

let dataRoot: string;
let store: KernelMetaStore;

/** email に unique を付けたテーブルを持つマニフェスト。 */
function uniqueManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "会員管理",
      tables: [
        {
          id: "members",
          name: "会員",
          fields: [
            { id: "email", name: "メール", type: "text", unique: true },
            { id: "name", name: "氏名", type: "text", required: true },
          ],
        },
      ],
      views: [],
    },
  };
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-unique-"));
  store = KernelMetaStore.open(dataRoot);
  createApp(store, "会員管理", { app_id: APP_ID });
});

afterEach(async () => {
  store.close();
  await rm(dataRoot, { recursive: true, force: true });
});

function db(): Database {
  return new Database(appDbPath(dataRoot, APP_ID));
}

// ---------------------------------------------------------------------------
// 書込時検査(records.ts)
// ---------------------------------------------------------------------------

describe("unique フィールドへの書込時検査(EC-G8 / ADR-0038)", () => {
  beforeEach(() => {
    const applied = applyManifest(dataRoot, APP_ID, uniqueManifest());
    if (!applied.valid) {
      throw new Error(`テスト前提のマニフェスト投入に失敗: ${JSON.stringify(applied.errors)}`);
    }
  });

  test("create: unique フィールドの重複値は拒否される", () => {
    const conn = db();
    const manifest = uniqueManifest();
    try {
      const first = createRecord(conn, manifest, "members", {
        email: "a@example.com",
        name: "田中",
      });
      expect(first.ok).toBe(true);

      const dup = createRecord(conn, manifest, "members", { email: "a@example.com", name: "佐藤" });
      expect(dup.ok).toBe(false);
      if (dup.ok) {
        throw new Error("重複が通ってしまった");
      }
      expect(dup.errors[0]?.path).toBe("/email");
      expect(dup.errors[0]?.message).toContain("一意");

      // 拒否時は1バイトも書かれない —— members は1件のまま。
      const rows = listRecords(conn, manifest, "members");
      expect(rows.ok && rows.value.length).toBe(1);
    } finally {
      conn.close();
    }
  });

  test("create: null(未設定)は複数許す(SQL の UNIQUE と同じ)", () => {
    const conn = db();
    const manifest = uniqueManifest();
    try {
      const a = createRecord(conn, manifest, "members", { name: "未設定A" });
      const b = createRecord(conn, manifest, "members", { name: "未設定B" });
      const c = createRecord(conn, manifest, "members", { email: null, name: "明示null" });
      expect(a.ok && b.ok && c.ok).toBe(true);
      const rows = listRecords(conn, manifest, "members");
      expect(rows.ok && rows.value.length).toBe(3);
    } finally {
      conn.close();
    }
  });

  test("update: 自分自身の行は除外される(自分の値のまま更新しても通る)", () => {
    const conn = db();
    const manifest = uniqueManifest();
    try {
      const created = createRecord(conn, manifest, "members", {
        email: "self@example.com",
        name: "自分",
      });
      if (!created.ok) {
        throw new Error("前提の作成に失敗");
      }
      const id = created.value._id;
      // 同じ email のまま name だけ更新 —— 自分の行なので重複にならない。
      const updated = updateRecord(conn, manifest, "members", id, {
        email: "self@example.com",
        name: "自分(改名)",
      });
      expect(updated.ok).toBe(true);
      expect(updated.ok && updated.value.name).toBe("自分(改名)");
    } finally {
      conn.close();
    }
  });

  test("update: 他行が既に使っている値へは拒否される", () => {
    const conn = db();
    const manifest = uniqueManifest();
    try {
      createRecord(conn, manifest, "members", { email: "taken@example.com", name: "先客" });
      const mine = createRecord(conn, manifest, "members", {
        email: "mine@example.com",
        name: "私",
      });
      if (!mine.ok) {
        throw new Error("前提の作成に失敗");
      }
      const conflict = updateRecord(conn, manifest, "members", mine.value._id, {
        email: "taken@example.com",
      });
      expect(conflict.ok).toBe(false);
      if (conflict.ok) {
        throw new Error("重複更新が通ってしまった");
      }
      expect(conflict.errors[0]?.path).toBe("/email");

      // 拒否時は1バイトも変わらない —— 私の email は据え置き。
      const rows = listRecords(conn, manifest, "members");
      const me = rows.ok ? rows.value.find((r) => r._id === mine.value._id) : undefined;
      expect(me?.email).toBe("mine@example.com");
    } finally {
      conn.close();
    }
  });

  test("update: unique フィールドを入力に含めない部分更新は照会しない(値が変わらない)", () => {
    const conn = db();
    const manifest = uniqueManifest();
    try {
      const a = createRecord(conn, manifest, "members", { email: "x@example.com", name: "X" });
      if (!a.ok) {
        throw new Error("前提の作成に失敗");
      }
      // email を触らず name だけ更新 —— 既存の x@example.com は自分の値なので、
      // そもそも照会対象にならない(部分更新で入力に無い列は検査しない)。
      const updated = updateRecord(conn, manifest, "members", a.value._id, { name: "X2" });
      expect(updated.ok).toBe(true);
    } finally {
      conn.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 後付け unique(apply-diff.ts / change_field)
// ---------------------------------------------------------------------------

/** email に unique を付けていない(後付け前の)テーブルを持つマニフェスト。 */
function plainManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "会員管理",
      tables: [
        {
          id: "members",
          name: "会員",
          fields: [
            { id: "email", name: "メール", type: "text" },
            { id: "name", name: "氏名", type: "text", required: true },
          ],
        },
      ],
      views: [],
    },
  };
}

const makeUniqueDiff: Diff = {
  diff_id: "make-email-unique",
  intent: "会員のメールを一意にする",
  operations: [{ op: "change_field", table: "members", field: "email", changes: { unique: true } }],
};

describe("後付け unique(change_field で false → true。ADR-0038 / ADR-0010 限定7)", () => {
  beforeEach(() => {
    const applied = applyManifest(dataRoot, APP_ID, plainManifest());
    if (!applied.valid) {
      throw new Error(`テスト前提のマニフェスト投入に失敗: ${JSON.stringify(applied.errors)}`);
    }
  });

  test("既存重複があれば差分全体を拒否し、1バイトも変えない(部分適用なし)", () => {
    const conn = db();
    try {
      // 同じ email を持つ2行を先に作る(この時点では unique 制約が無い)。
      createRecord(conn, plainManifest(), "members", { email: "dup@example.com", name: "A" });
      createRecord(conn, plainManifest(), "members", { email: "dup@example.com", name: "B" });
    } finally {
      conn.close();
    }

    const manifestBefore = readFileSync(appManifestPath(dataRoot, APP_ID), "utf-8");
    const snapshotsBefore = listSnapshots(dataRoot, APP_ID).length;

    const result = applyDiff(dataRoot, APP_ID, makeUniqueDiff);
    expect(result.valid).toBe(false);
    if (result.valid) {
      throw new Error("既存重複があるのに後付け unique が通ってしまった");
    }
    expect(result.errors[0]?.message).toContain("dup@example.com");

    // 1バイトも変わっていない —— マニフェストは同一で、スナップショットも作られていない。
    expect(readFileSync(appManifestPath(dataRoot, APP_ID), "utf-8")).toBe(manifestBefore);
    expect(listSnapshots(dataRoot, APP_ID).length).toBe(snapshotsBefore);

    // 既存重複は黙って1件に潰されていない —— 2行のまま残っている。
    const conn2 = db();
    try {
      const rows = listRecords(conn2, plainManifest(), "members");
      expect(rows.ok && rows.value.length).toBe(2);
    } finally {
      conn2.close();
    }
  });

  test("既存重複が無ければ後付け成功で unique が永続する", () => {
    const conn = db();
    try {
      createRecord(conn, plainManifest(), "members", { email: "u1@example.com", name: "A" });
      createRecord(conn, plainManifest(), "members", { email: "u2@example.com", name: "B" });
    } finally {
      conn.close();
    }

    const result = applyDiff(dataRoot, APP_ID, makeUniqueDiff);
    expect(result.valid).toBe(true);

    // 適用後マニフェストに unique が残っている。
    const persisted = JSON.parse(
      readFileSync(appManifestPath(dataRoot, APP_ID), "utf-8"),
    ) as Manifest;
    const emailField = persisted.app.tables[0]?.fields.find((f) => f.id === "email");
    expect(emailField?.unique).toBe(true);

    // 以後、重複書込が拒否される(後付けが実際に効いている)。
    const conn2 = db();
    try {
      const dup = createRecord(conn2, persisted, "members", {
        email: "u1@example.com",
        name: "C",
      });
      expect(dup.ok).toBe(false);
    } finally {
      conn2.close();
    }
  });

  test("null は既存重複検査の対象にしない(複数 null があっても後付けできる)", () => {
    const conn = db();
    try {
      createRecord(conn, plainManifest(), "members", { name: "null1" });
      createRecord(conn, plainManifest(), "members", { name: "null2" });
      createRecord(conn, plainManifest(), "members", { email: "only@example.com", name: "one" });
    } finally {
      conn.close();
    }
    const result = applyDiff(dataRoot, APP_ID, makeUniqueDiff);
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DDL は unique を1バイトも見ない(ADR-0010 限定5/6 維持)
// ---------------------------------------------------------------------------

describe("DDL に UNIQUE / CHECK を落とさない(ADR-0038 限定3 / ADR-0010 限定5)", () => {
  test("unique フィールドの CREATE TABLE SQL に UNIQUE が出ない", () => {
    const table: Table = {
      id: "members",
      name: "会員",
      fields: [
        { id: "email", name: "メール", type: "text", unique: true },
        { id: "name", name: "氏名", type: "text", required: true },
      ],
    };
    const sql = createTableSql(table);
    expect(sql).not.toContain("UNIQUE");
    expect(sql).not.toContain("CHECK");
    // email 列は素の TEXT 列として作られる(制約なし)。
    expect(sql).toContain('"email" TEXT');
  });
});
