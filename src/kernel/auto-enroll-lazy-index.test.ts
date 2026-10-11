/**
 * **名簿の一意索引を書ける接続で遅延で張る**(`V23-M1-T08`。`D-V23-35`・`D-V23-38`。上位:
 * `docs/adr/0497-auto-enroll-and-last-row-admin.md` 限定6、計画 `docs/plan/v23/00-v23-plan.md` §1 の
 * 「データの置き場の形が変わる段」の4項目と §4 の T08)。
 *
 * - (L-1) 差分の適用を通らない `apply_manifest`(定義の丸ごとの投入)では索引が無いが、名簿への最初の
 *   書込(作成・更新)の前に張られる。
 * - (L-2) 移行器(`scripts/migrate-volume.ts`。後段なしで定義を当てる)の後も同じく、最初の書込で張られる。
 *   移行器の手順も版の数も変えていない。
 * - (L-3) 遅延で張るときに既に同じ利用者の行が複数あれば、名簿への作成・更新を断り(1バイトも書かない)、
 *   重複を知らせる。 削除は断らない(重複を消して直せる)。 消した後は書け、索引が張られる。
 * - (L-4) 読取専用で `app.sqlite` を開く6経路は、宣言があって索引の無い DB でも落ちず、索引を張らない。
 * - (L-5) 陰性対照: 自動登録を宣言しない表への書込では索引を張らない。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateVolume } from "../../scripts/migrate-volume.ts";
import { checkRunnerVersionGate } from "../server/runner-version-gate.ts";
import { RUNNER_BUILD_VERSION } from "../shared/runner-build-version.ts";
import { applyDiff, foldOperations } from "./apply-diff.ts";
import { applyManifest, readCurrentManifest } from "./apply-manifest.ts";
import { createApp } from "./create-app.ts";
import { dryRunDiff } from "./dry-run.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { readRecordList } from "./read-records.ts";
import { createRecord, deleteRecord, updateRecord } from "./records.ts";
import { auditAppSnapshots } from "./snapshot-orphans.ts";
import { appDbPath, appDir, appManifestPath, kernelDbPath } from "./storage-paths.ts";
import type { Manifest, Operation } from "./types.ts";
import { previewUndo } from "./undo.ts";

const APP_ID = "lazy-index";
const INDEX = "_auto_enroll__mem__account";

const OWNER_RULES = [
  { target: "app", can: ["write"] },
  { target: "role", can: ["write"] },
  { target: "table", table: "orgs", can: ["read", "write", "delete"] },
  { target: "table", table: "mem", can: ["read", "write", "delete"] },
  { target: "table", table: "og", can: ["read", "write", "delete"] },
  { target: "table", table: "notes", can: ["read", "write", "delete"] },
];

function manifest(declared: boolean): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "遅延の索引",
      tables: [
        {
          id: "orgs",
          name: "組織",
          fields: [{ id: "title", name: "名", type: "text" }],
          access_control: {
            enabled: true,
            permissions: [{ id: "keeper", name: "管理", read: true, write: true, delete: true }],
            creator_permission: "keeper",
            creatable_by_roles: ["member"],
            grant: { table: "og", target: "org", member: "member", permission: "permission" },
            members: {
              table: "mem",
              account: "account",
              ...(declared ? { auto_enroll: { roles: ["member"] } } : {}),
            },
          },
        },
        {
          id: "mem",
          name: "名簿",
          fields: [
            { id: "account", name: "利用者", type: "text" },
            { id: "display", name: "表示名", type: "text" },
          ],
        },
        {
          id: "og",
          name: "付与",
          fields: [
            { id: "org", name: "組織", type: "reference", reference_table: "orgs" },
            { id: "member", name: "相手", type: "reference", reference_table: "mem" },
            { id: "permission", name: "権限", type: "select", options: ["keeper"] },
          ],
        },
        { id: "notes", name: "メモ", fields: [{ id: "body", name: "本文", type: "text" }] },
      ],
      views: [],
      roles: [
        { id: "owner", name: "持ち主", rules: OWNER_RULES },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
        { id: "member", name: "会員" },
      ],
    },
  } as unknown as Manifest;
}

let root: string;
let imageRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gp-lazy-index-"));
  imageRoot = mkdtempSync(join(tmpdir(), "gp-lazy-index-image-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(imageRoot, { recursive: true, force: true });
});

function seedApp(declared: boolean): void {
  const meta = KernelMetaStore.open(root);
  try {
    createApp(meta, "遅延の索引", { app_id: APP_ID });
  } finally {
    meta.close();
  }
  const applied = applyManifest(root, APP_ID, manifest(declared));
  if (!applied.valid) {
    throw new Error(JSON.stringify(applied.errors));
  }
}

function withDb<T>(fn: (db: Database) => T, readonly = false): T {
  const db = readonly
    ? new Database(appDbPath(root, APP_ID), { readonly: true })
    : new Database(appDbPath(root, APP_ID));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function hasIndex(): boolean {
  return withDb(
    (db) =>
      db.query("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(INDEX) !== null,
    true,
  );
}

function rowsOf(table: string): Record<string, unknown>[] {
  return withDb(
    (db) => db.query<Record<string, unknown>, []>(`SELECT * FROM "${table}"`).all(),
    true,
  );
}

/** 索引の無いまま同じ利用者の行を2行置く(生の SQL。検査の台を組むためだけ)。 */
function seedDuplicateRows(): void {
  withDb((db) => {
    for (const id of ["dup-1", "dup-2"]) {
      db.run(
        `INSERT INTO "mem" ("_id", "_created_at", "_updated_at", "account", "display") VALUES (?, ?, ?, ?, ?)`,
        [id, "2026-09-29T00:00:00.000Z", "2026-09-29T00:00:00.000Z", "same-user", id],
      );
    }
  });
}

test("(L-1) apply_manifest では索引が無く、名簿への最初の作成の前に張られる(D-V23-35)", () => {
  seedApp(true);
  expect(hasIndex()).toBe(false);
  const created = withDb((db) => createRecord(db, manifest(true), "mem", { account: "alice" }));
  expect(created.ok).toBe(true);
  expect(hasIndex()).toBe(true);
  // 張られた索引は、同じ利用者の2行目を断る(書込時検査と同じ path)。
  const again = withDb((db) => createRecord(db, manifest(true), "mem", { account: "alice" }));
  expect(again.ok).toBe(false);
  expect(again.ok ? "" : again.errors[0]?.path).toBe("/account");
});

test("(L-1b) 更新でも、書く前に張られる", () => {
  seedApp(true);
  withDb((db) => {
    db.run(
      `INSERT INTO "mem" ("_id", "_created_at", "_updated_at", "account") VALUES ('m1', '2026-09-29T00:00:00.000Z', '2026-09-29T00:00:00.000Z', 'alice')`,
    );
  });
  expect(hasIndex()).toBe(false);
  const updated = withDb((db) => updateRecord(db, manifest(true), "mem", "m1", { display: "A" }));
  expect(updated.ok).toBe(true);
  expect(hasIndex()).toBe(true);
});

test("(L-2) 移行器で宣言が入ったボリュームでも、最初の書込で張られる(移行器の手順と版は変えていない)", () => {
  seedApp(false);
  const foreign = RUNNER_BUILD_VERSION + 1;
  for (const path of [kernelDbPath(root), appDbPath(root, APP_ID)]) {
    const db = new Database(path);
    try {
      db.exec(`PRAGMA user_version = ${foreign};`);
    } finally {
      db.close();
    }
  }
  const operations = [
    {
      op: "change_table",
      table: "orgs",
      changes: { access_control: manifest(true).app.tables[0]?.access_control },
    },
  ] as unknown as Operation[];
  const folded = foldOperations(readCurrentManifest(root, APP_ID), operations);
  expect(folded.valid).toBe(true);
  mkdirSync(appDir(imageRoot, APP_ID), { recursive: true });
  writeFileSync(
    appManifestPath(imageRoot, APP_ID),
    JSON.stringify(folded.valid ? folded.manifest : {}),
  );
  writeFileSync(
    join(appDir(imageRoot, APP_ID), "migration-operations.json"),
    JSON.stringify(operations),
  );
  const migrated = migrateVolume({ volumeDataRoot: root, imageDataRoot: imageRoot });
  expect(migrated.ok, JSON.stringify(migrated)).toBe(true);
  expect(checkRunnerVersionGate(root).ok).toBe(true);
  // 移行器は索引を張らない(今日の移行器のまま)。
  expect(hasIndex()).toBe(false);
  const created = withDb((db) =>
    createRecord(db, readCurrentManifest(root, APP_ID), "mem", { account: "alice" }),
  );
  expect(created.ok).toBe(true);
  expect(hasIndex()).toBe(true);
});

test("(L-3) 遅延で張るときに重複があれば、作成と更新を断り(1バイトも書かない)重複を知らせる。削除は通り、消した後は書ける", () => {
  seedApp(true);
  seedDuplicateRows();
  const created = withDb((db) => createRecord(db, manifest(true), "mem", { account: "bob" }));
  expect(created.ok).toBe(false);
  const message = created.ok ? "" : (created.errors[0]?.message ?? "");
  expect(message).toContain("同じ利用者の行が複数あります");
  expect(created.ok ? "" : created.errors[0]?.path).toBe("/account");
  const updated = withDb((db) =>
    updateRecord(db, manifest(true), "mem", "dup-1", { display: "x" }),
  );
  expect(updated.ok).toBe(false);
  expect(rowsOf("mem")).toHaveLength(2);
  expect(hasIndex()).toBe(false);
  // 削除は断らない(重複を消して直せる)。
  const removed = withDb((db) => deleteRecord(db, manifest(true), "mem", "dup-2"));
  expect(removed.ok).toBe(true);
  const after = withDb((db) => createRecord(db, manifest(true), "mem", { account: "bob" }));
  expect(after.ok).toBe(true);
  expect(hasIndex()).toBe(true);
});

test("(L-4) 読取専用で開く6経路は、宣言があって索引の無い DB でも落ちず、索引を張らない", () => {
  seedApp(true);
  withDb((db) => {
    db.run(
      `INSERT INTO "mem" ("_id", "_created_at", "_updated_at", "account") VALUES ('m1', '2026-09-29T00:00:00.000Z', '2026-09-29T00:00:00.000Z', 'alice')`,
    );
  });
  expect(hasIndex()).toBe(false);
  const current = readCurrentManifest(root, APP_ID);
  // (1) 起動の版の照合。
  expect(checkRunnerVersionGate(root).ok).toBe(true);
  // (2) 読取。
  const listed = withDb(
    (db) => readRecordList({ dataRoot: root, appDb: () => db }, current, "mem", {}),
    true,
  );
  expect(listed.ok).toBe(true);
  // (3) 差分の下見(影のデータルートで適用する)。
  const dry = dryRunDiff(root, APP_ID, {
    diff_id: "d-dry",
    intent: "下見",
    operations: [
      { op: "add_field", table: "notes", field: { id: "memo", name: "メモ", type: "text" } },
    ],
  });
  expect(dry.valid).toBe(true);
  // (4) 取り消しの下見。
  expect(() => previewUndo(root, APP_ID)).not.toThrow();
  // (6) スナップショットの監査。
  expect(() => auditAppSnapshots(root, APP_ID)).not.toThrow();
  expect(hasIndex()).toBe(false);
  // (5) 差分の適用の事前検査(一意の後付けの既存の重複を読む `checkUniqueBackfills`)。
  //     適用そのものは書ける接続で索引を張り直す(`V23-M1-T03`)。
  const applied = applyDiff(root, APP_ID, {
    diff_id: "d-unique",
    intent: "表示名に一意を足す",
    operations: [
      {
        op: "change_field",
        table: "mem",
        field: "display",
        changes: { unique: true },
      },
    ],
  });
  expect(applied.valid, JSON.stringify(applied)).toBe(true);
});

test("(L-5) 陰性対照: 自動登録を宣言しない名簿・表への書込では索引を張らない", () => {
  seedApp(false);
  expect(withDb((db) => createRecord(db, manifest(false), "mem", { account: "alice" })).ok).toBe(
    true,
  );
  expect(withDb((db) => createRecord(db, manifest(false), "notes", { body: "x" })).ok).toBe(true);
  expect(hasIndex()).toBe(false);
});
