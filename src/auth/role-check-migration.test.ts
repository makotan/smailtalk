/**
 * **`_auth_users.role` の `CHECK` 制約を作り替え、既存 DB を移行する**
 * (`V5-M17-T03`。`G-G5` / [`ADR-0158`](../../docs/adr/0158-declared-user-kinds.md) 限定5)。
 *
 * ## **この検査は `ADR-0158` 限定5 の後段を実装で覆している。先に書く。**
 *
 * **`ADR-0158` 限定5 の逐語**: 「**`_auth_users` の `role` 列の `CHECK` は1度だけ作り替える**
 * … **既存 DB は移行しない**(`D-V5-38` により作り直し)。**「移行できる」と書かない**」。
 *
 * **本タスクは移行を実装した。** **根拠は `V5-M17` の発注(逐語「**`_auth_users` の `CHECK`
 * 制約(`src/auth/store.ts`)を変えるなら、既存 DB の移行を実装し、実際に既存の行が残ることを
 * 本物の SQLite で確かめること。**」)であり、`CLAUDE.md` の「既存ADRの記述よりユーザの要求を
 * 優先して必要なら変更ADRとして記述を変える」に従う。** **変更 ADR は
 * [`ADR-0233`](../../docs/adr/0233-auth-role-check-migration.md) である。**
 *
 * ## この検査が測らないもの(**誇張しない**)
 *
 * 1. **`app.sqlite` に同居する records 側のテーブルを1バイトも触らないことは、本検査が
 *    直接は測っていない**(測るのは `_auth_*` の中身だけである)。
 * 2. **移行の途中で電源が落ちた場合を1度も試していない。** 移行は1つのトランザクション内で
 *    行うが、**その原子性を本検査は再現していない。**
 * 3. **スナップショット / undo との交差を1度も試していない**(`ADR-0033` §4 が
 *    「table rebuild は snapshot/undo と交差しリスク高でスコープ外」と書いた点である)。
 *    **`_auth_users` は `app.sqlite` に同居するので、移行の直後に巻き戻すと `CHECK` も
 *    一緒に古い形へ戻る。****本検査はそれを確かめていない。**
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore, ROLE_COLUMN_DDL } from "./store.ts";

/** `V2-M1-T01` 当時(= 着手前)の `_auth_users` の DDL。**逐語で写した。** */
const LEGACY_ROLE_COLUMN_DDL_4 = `"role" TEXT NOT NULL DEFAULT 'viewer' CHECK("role" IN ('owner','editor','viewer','customer'))`;

/** `M3-T02` 当時の `_auth_users` の DDL(3値。`customer` を弾く世代)。 */
const LEGACY_ROLE_COLUMN_DDL_3 = `"role" TEXT NOT NULL DEFAULT 'viewer' CHECK("role" IN ('owner','editor','viewer'))`;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gp-role-check-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 旧世代の `_auth_users` を持つ**本物の** `app.sqlite` を作り、行を入れて閉じる。 */
function seedLegacyApp(appId: string, roleDdl: string, roles: readonly string[]): string {
  const dir = join(root, "apps", appId);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "app.sqlite");
  const db = new Database(dbPath, { create: true });
  db.exec(`
    CREATE TABLE "_auth_users" (
      "id"           TEXT PRIMARY KEY,
      "username"     TEXT UNIQUE NOT NULL,
      "display_name" TEXT,
      ${roleDdl},
      "created_at"   TEXT NOT NULL
    );
  `);
  // 参照している側のテーブルも作る(**移行が外部キーの参照を壊さないことを見るため**)。
  db.exec(`
    CREATE TABLE "_auth_password_credentials" (
      "user_id"       TEXT PRIMARY KEY REFERENCES "_auth_users"("id"),
      "password_hash" TEXT NOT NULL,
      "updated_at"    TEXT NOT NULL
    );
  `);
  roles.forEach((role, index) => {
    db.query(
      `INSERT INTO "_auth_users" ("id","username","display_name","role","created_at")
       VALUES (?, ?, ?, ?, ?)`,
    ).run(`u${index}`, `user${index}`, `表示${index}`, role, `2026-01-0${index + 1}T00:00:00.000Z`);
    db.query(
      `INSERT INTO "_auth_password_credentials" ("user_id","password_hash","updated_at")
       VALUES (?, ?, ?)`,
    ).run(`u${index}`, `hash${index}`, "2026-01-01T00:00:00.000Z");
  });
  db.close();
  return dbPath;
}

/** その DB の `_auth_users` の DDL を `sqlite_master` から読む。 */
function storedDdl(dbPath: string): string {
  const db = new Database(dbPath);
  try {
    return (
      db
        .query<{ sql: string }, []>(
          `SELECT sql FROM sqlite_master WHERE type='table' AND name='_auth_users'`,
        )
        .get()?.sql ?? ""
    );
  } finally {
    db.close();
  }
}

describe("(T03-1) 新しい `CHECK` は値の列挙ではなく識別子の形を見る(`ADR-0158` 限定5)", () => {
  test("`ROLE_COLUMN_DDL` に `IN (` の列挙が1つも無い", () => {
    expect(ROLE_COLUMN_DDL).not.toContain("IN (");
    expect(ROLE_COLUMN_DDL).not.toContain("'customer'");
  });

  test("`ROLE_COLUMN_DDL` は識別子の形(文字種と長さ)を見ている", () => {
    expect(ROLE_COLUMN_DDL).toContain("GLOB");
    expect(ROLE_COLUMN_DDL).toContain("length");
  });

  test("既定は今日どおり `viewer` である(既存3ロールの規律を変えない。限定11)", () => {
    expect(ROLE_COLUMN_DDL).toContain("DEFAULT 'viewer'");
  });
});

describe("(T03-2) 既存 DB の移行 —— **本物の SQLite で、既存の行が残ることを確かめる**", () => {
  test("4値 `CHECK` の DB を開くと、既存4行が1件も消えずに残る", () => {
    const dbPath = seedLegacyApp("legacy4", LEGACY_ROLE_COLUMN_DDL_4, [
      "owner",
      "editor",
      "viewer",
      "customer",
    ]);
    expect(storedDdl(dbPath)).toContain("IN ('owner','editor','viewer','customer')");

    const store = AuthStore.openForApp(root, "legacy4");
    try {
      const users = store.listUsers();
      expect(users).toHaveLength(4);
      // **id / username / display_name / role / created_at のすべてが残っている。**
      expect(users.map((u) => u.username).sort()).toEqual(["user0", "user1", "user2", "user3"]);
      expect(users.map((u) => u.role).sort()).toEqual(["customer", "editor", "owner", "viewer"]);
      expect(users.find((u) => u.username === "user0")?.displayName).toBe("表示0");
      expect(users.find((u) => u.username === "user0")?.id).toBe("u0");
      expect(users.find((u) => u.username === "user0")?.createdAt).toBe("2026-01-01T00:00:00.000Z");
    } finally {
      store.close();
    }

    // **移行後の DDL は識別子の形を見る新しい形になっている。**
    const after = storedDdl(dbPath);
    expect(after).not.toContain("IN ('owner','editor','viewer','customer')");
    expect(after).toContain("GLOB");
  });

  test("移行後に、宣言された種類の `INSERT` が通る(`customer` 以外の非運営ロール)", () => {
    seedLegacyApp("legacy4b", LEGACY_ROLE_COLUMN_DDL_4, ["owner"]);
    const store = AuthStore.openForApp(root, "legacy4b");
    try {
      const created = store.createUser({ username: "kaiin", role: "member" });
      expect(created.role).toBe("member");
      expect(store.findUserByUsername("kaiin")?.role).toBe("member");
    } finally {
      store.close();
    }
  });

  test("3値 `CHECK` の古い世代(`M3-T02` 当時)も移行され、既存3行が残る", () => {
    // **`src/server/auth-routes.ts:268-271`(着手前)が「この DB は customer ロールを
    // 保存できません(古い CHECK 制約により弾かれました)。」と返していた世代である。**
    seedLegacyApp("legacy3", LEGACY_ROLE_COLUMN_DDL_3, ["owner", "editor", "viewer"]);
    const store = AuthStore.openForApp(root, "legacy3");
    try {
      expect(store.listUsers()).toHaveLength(3);
      // **着手前は 500 で弾かれていた `customer` の作成が、移行後は通る。**
      expect(store.createUser({ username: "kyaku", role: "customer" }).role).toBe("customer");
    } finally {
      store.close();
    }
  });

  test("参照している側(`_auth_password_credentials`)の行も1件も消えていない", () => {
    const dbPath = seedLegacyApp("legacy4c", LEGACY_ROLE_COLUMN_DDL_4, ["owner", "customer"]);
    const store = AuthStore.openForApp(root, "legacy4c");
    store.close();
    const db = new Database(dbPath);
    try {
      expect(
        db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM "_auth_password_credentials"`).get()
          ?.n,
      ).toBe(2);
      // **外部キーの整合が壊れていない**(移行で `_auth_users` を作り直した後の実測)。
      expect(db.query(`PRAGMA foreign_key_check`).all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("移行は冪等である(2度開いても行が増えも減りもしない)", () => {
    seedLegacyApp("legacy4d", LEGACY_ROLE_COLUMN_DDL_4, ["owner", "viewer"]);
    for (let i = 0; i < 3; i += 1) {
      const store = AuthStore.openForApp(root, "legacy4d");
      try {
        expect(store.listUsers()).toHaveLength(2);
      } finally {
        store.close();
      }
    }
  });

  test("新規 DB は移行を1度も走らせない(既に新しい形で作られる)", () => {
    const store = AuthStore.openForApp(root, "fresh");
    try {
      expect(store.listUsers()).toHaveLength(0);
      expect(store.createUser({ username: "a", role: "member" }).role).toBe("member");
    } finally {
      store.close();
    }
    expect(storedDdl(join(root, "apps", "fresh", "app.sqlite"))).toContain("GLOB");
  });
});

describe("(T03-3) 新しい `CHECK` は識別子の形を外れた値を今日も弾く", () => {
  test("日本語・空白・大文字・33文字は `CHECK` で弾かれる", () => {
    const store = AuthStore.openForApp(root, "shape");
    try {
      for (const bad of ["会員", "two words", "Member", "a".repeat(33), ""]) {
        expect(() => store.createUser({ username: `u-${bad}`, role: bad })).toThrow();
      }
    } finally {
      store.close();
    }
  });
});
