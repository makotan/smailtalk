/**
 * **1人が複数の役割を持てるようにする**(`V8-M16-T04` / `J-G3`)。**保存の側の検査。**
 *
 * ## この検査が固定する規則(**今日どこにも定義されていなかった。ここで初めて定義する**)
 *
 * > **実効ロール集合 = `{_auth_users.role の1値}` ∪ `{_auth_user_roles に在る付与}`。**
 * > **判定は「実効ロール集合と宣言集合の積が空でなければ通る」の1本に閉じる。**
 *
 * **根拠**: 門A の限定 `J-G3` の逐語「**複数の役割は和集合1本で合成する**」
 * (`docs/adr/0007-vocabulary-governance.md` §8 の台帳)。**メインの裁定 `R-3` が実装の形を割った。**
 *
 * ## この検査が測らないもの(**誇張しない。先に書く**)
 *
 * 1. **スナップショット / undo との交差を1度も試していない。** `_auth_user_roles` は
 *    `app.sqlite` に同居するので、**付与を足した直後に巻き戻せば付与も一緒に消える**
 *    (`src/kernel/snapshot.ts` の `VACUUM INTO` はファイル丸ごとを写す)。
 *    **`_auth_users` について `ADR-0033` §4 が「スコープ外」とした理由は、7本目の表でも消えていない。**
 * 2. **移行の途中で電源が落ちた場合を1度も試していない。**
 * 3. **同時に2接続から付与を書き換える競合を1度も試していない。**
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore, LastGranterError, LastOwnerError } from "./store.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gp-multi-role-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** その DB に在るテーブル名の全量(`sqlite_master`)。 */
function tableNames(dbPath: string): string[] {
  const db = new Database(dbPath);
  try {
    return db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
      )
      .all()
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

/** `V2-M1-T01` 当時の `_auth_users` だけを持つ**本物の** app.sqlite を作り、行を入れて閉じる。 */
function seedLegacyApp(appId: string, roles: readonly string[]): string {
  const dir = join(root, "apps", appId);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "app.sqlite");
  const db = new Database(dbPath, { create: true });
  db.exec(`
    CREATE TABLE "_auth_users" (
      "id"           TEXT PRIMARY KEY,
      "username"     TEXT UNIQUE NOT NULL,
      "display_name" TEXT,
      "role" TEXT NOT NULL DEFAULT 'viewer' CHECK("role" IN ('owner','editor','viewer','customer')),
      "created_at"   TEXT NOT NULL
    );
  `);
  roles.forEach((role, index) => {
    db.query(
      `INSERT INTO "_auth_users" ("id","username","display_name","role","created_at")
       VALUES (?, ?, ?, ?, ?)`,
    ).run(`u${index}`, `user${index}`, `表示${index}`, role, `2026-01-0${index + 1}T00:00:00.000Z`);
  });
  db.close();
  return dbPath;
}

// ---------------------------------------------------------------------------
// (T04-1) 7本目の表 —— **既存 DB を開いた瞬間に足され、行を1件も失わない**
// ---------------------------------------------------------------------------

describe("(T04-1) `_auth_*` の7本目の表(役割の付与)", () => {
  test("新しい DB を開くと `_auth_user_roles` が在る(常設7本になった)", () => {
    const dbPath = join(root, "apps", "fresh", "app.sqlite");
    const store = AuthStore.open(dbPath);
    store.close();
    const names = tableNames(dbPath);
    expect(names).toContain("_auth_user_roles");
    // **常設の `_auth_*` は7本ちょうどである**(移行の一時表 `_auth_users_migrated` は残らない)。
    //
    // **【期待値を書き換えた理由: `V8-M2` / `I-G9` / `ADR-0336`(2026-08-14)】**
    // **8本目 `_auth_invitations`(招待)を足したので、常設は8本になった。**
    // **旧の期待値(7本。逐語で残す)**:
    //
    //     expect(names.filter((name) => name.startsWith("_auth_")).sort()).toEqual([
    //       "_auth_activity",
    //       "_auth_password_credentials",
    //       "_auth_pending_challenges",
    //       "_auth_sessions",
    //       "_auth_user_roles",
    //       "_auth_users",
    //       "_auth_webauthn_credentials",
    //     ]);
    //
    // **検査は消していない・`skip` にしていない・「移行の一時表が残らない」という問いも
    // そのままである** —— **期待値の配列に1要素を足しただけである。**
    expect(names.filter((name) => name.startsWith("_auth_")).sort()).toEqual([
      "_auth_activity",
      "_auth_invitations",
      "_auth_password_credentials",
      "_auth_pending_challenges",
      "_auth_sessions",
      "_auth_user_roles",
      "_auth_users",
      "_auth_webauthn_credentials",
    ]);
  });

  test("**本物の SQLite**: 役割が列にだけ在る既存 DB を開くと、表が足され既存の行が1件も失われない", () => {
    const dbPath = seedLegacyApp("legacy", ["owner", "editor", "viewer", "customer"]);
    expect(tableNames(dbPath)).not.toContain("_auth_user_roles");

    const store = AuthStore.open(dbPath);
    try {
      // **既存ユーザの行が1件も失われていない**(4人・名前も役割も順序もそのまま)。
      const users = store.listUsers();
      expect(users.map((user) => user.username)).toEqual(["user0", "user1", "user2", "user3"]);
      expect(users.map((user) => user.role)).toEqual(["owner", "editor", "viewer", "customer"]);
      expect(users.map((user) => user.displayName)).toEqual(["表示0", "表示1", "表示2", "表示3"]);
      // **付与は1件も無い**(列にだけ在る状態が保たれる)。
      expect(store.roleGrants(users[0]?.id ?? "")).toEqual([]);
      expect(store.effectiveRoles(users[0]?.id ?? "")).toEqual(["owner"]);
    } finally {
      store.close();
    }
    expect(tableNames(dbPath)).toContain("_auth_user_roles");
  });

  test("2度開いても行が増えも減りもしない(冪等)", () => {
    const dbPath = seedLegacyApp("twice", ["owner", "viewer"]);
    const first = AuthStore.open(dbPath);
    const alice = first.listUsers()[0];
    first.grantRole(alice?.id ?? "", "editor");
    first.close();

    const second = AuthStore.open(dbPath);
    try {
      expect(second.listUsers()).toHaveLength(2);
      expect(second.roleGrants(alice?.id ?? "")).toEqual(["editor"]);
    } finally {
      second.close();
    }
  });
});

// ---------------------------------------------------------------------------
// (T04-2) 実効ロールの和集合
// ---------------------------------------------------------------------------

describe("(T04-2) 実効ロール集合 = 列の1値 ∪ 付与表", () => {
  test("付与が無ければ列の1値だけ / 足すと和集合になる(列が1本目)", () => {
    const store = AuthStore.open(":memory:");
    try {
      const user = store.createUser({ username: "alice", role: "viewer" });
      expect(store.effectiveRoles(user.id)).toEqual(["viewer"]);

      store.grantRole(user.id, "editor");
      expect(store.effectiveRoles(user.id)).toEqual(["viewer", "editor"]);
      expect(store.roleGrants(user.id)).toEqual(["editor"]);

      // **列と同じ値を付与しても重複しない。**
      store.grantRole(user.id, "viewer");
      expect(store.effectiveRoles(user.id)).toEqual(["viewer", "editor"]);

      // **同じ付与を2度足しても増えない(冪等)。** 並びは付与した順(rowid 順)。
      store.grantRole(user.id, "editor");
      expect(store.roleGrants(user.id)).toEqual(["editor", "viewer"]);

      store.revokeRole(user.id, "editor");
      expect(store.effectiveRoles(user.id)).toEqual(["viewer"]);
    } finally {
      store.close();
    }
  });

  test("存在しないユーザの実効ロール集合は空である", () => {
    const store = AuthStore.open(":memory:");
    try {
      expect(store.effectiveRoles("no-such-user")).toEqual([]);
    } finally {
      store.close();
    }
  });

  test("`setUserRoles` は実効集合を丸ごと置き換える(列は既定の1本目として残る)", () => {
    const store = AuthStore.open(":memory:");
    try {
      const user = store.createUser({ username: "alice", role: "viewer" });
      store.setUserRoles(user.id, ["viewer", "editor", "customer"]);
      expect(store.findUserById(user.id)?.role).toBe("viewer");
      expect(store.effectiveRoles(user.id)).toEqual(["viewer", "editor", "customer"]);

      // 列の値が集合から外れたら、集合の先頭が列の値になる。
      store.setUserRoles(user.id, ["editor", "customer"]);
      expect(store.findUserById(user.id)?.role).toBe("editor");
      expect(store.effectiveRoles(user.id)).toEqual(["editor", "customer"]);
    } finally {
      store.close();
    }
  });

  test("全ユーザの付与を1度に読める(一覧の口が N+1 を撃たないため)", () => {
    const store = AuthStore.open(":memory:");
    try {
      const a = store.createUser({ username: "a", role: "owner" });
      const b = store.createUser({ username: "b", role: "viewer" });
      store.grantRole(b.id, "editor");
      const map = store.roleGrantsByUser();
      expect(map.get(a.id)).toBeUndefined();
      expect(map.get(b.id)).toEqual(["editor"]);
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// (T04-3) 3つの不変条件 —— **列と表の両方を数える**
// ---------------------------------------------------------------------------

describe("(T04-3) 持ち主の不変条件は列と表の両方を数える", () => {
  test("`countOwners` は「列にだけ」「表にだけ」「両方」のどれでも 0人 と判定しない", () => {
    const store = AuthStore.open(":memory:");
    try {
      // (a) 列にだけ居る。
      const columnOnly = store.createUser({ username: "column-only", role: "owner" });
      expect(store.countOwners()).toBe(1);

      // (b) 表にだけ居る。
      const tableOnly = store.createUser({ username: "table-only", role: "viewer" });
      store.grantRole(tableOnly.id, "owner");
      expect(store.countOwners()).toBe(2);

      // (c) 両方に居る人を1人に数える(行ではなく人を数える)。
      store.grantRole(columnOnly.id, "owner");
      expect(store.countOwners()).toBe(2);

      store.setUserRoles(columnOnly.id, ["viewer"]);
      expect(store.countOwners()).toBe(1);
      expect(store.effectiveRoles(tableOnly.id)).toEqual(["viewer", "owner"]);
    } finally {
      store.close();
    }
  });

  test("降格ガード: 持ち主が**表にだけ**居ても、最後の1人は降ろせない", () => {
    const store = AuthStore.open(":memory:");
    try {
      const user = store.createUser({ username: "alice", role: "viewer" });
      store.grantRole(user.id, "owner");
      expect(store.countOwners()).toBe(1);
      // 列を書き換えても、表に付与が残るので実効集合は owner を含む → 通る。
      expect(store.setUserRole(user.id, "editor").role).toBe("editor");
      expect(store.effectiveRoles(user.id)).toEqual(["editor", "owner"]);
      // 表からも外そうとすると、実効集合から owner が消える → 拒否。
      expect(() => store.setUserRoles(user.id, ["editor"])).toThrow(LastOwnerError);
      expect(store.countOwners()).toBe(1);
    } finally {
      store.close();
    }
  });

  test("降格ガード: 持ち主が**列にだけ**居ても、最後の1人は降ろせない", () => {
    const store = AuthStore.open(":memory:");
    try {
      const user = store.createUser({ username: "alice", role: "owner" });
      expect(() => store.setUserRole(user.id, "viewer")).toThrow(LastOwnerError);
      expect(() => store.setUserRoles(user.id, ["viewer", "editor"])).toThrow(LastOwnerError);
      expect(store.countOwners()).toBe(1);
    } finally {
      store.close();
    }
  });

  test("降格ガード: 他方に持ち主が居れば降ろせる(列だけ↔表だけを跨ぐ)", () => {
    const store = AuthStore.open(":memory:");
    try {
      const columnOwner = store.createUser({ username: "a", role: "owner" });
      const tableOwner = store.createUser({ username: "b", role: "viewer" });
      store.grantRole(tableOwner.id, "owner");
      // 列の持ち主を降ろせる(表に持ち主が居るから)。
      expect(store.setUserRole(columnOwner.id, "viewer").role).toBe("viewer");
      expect(store.countOwners()).toBe(1);
      // 残った1人(表にだけ)は降ろせない。
      expect(() => store.setUserRoles(tableOwner.id, ["viewer"])).toThrow(LastOwnerError);
    } finally {
      store.close();
    }
  });

  test("最古昇格: 持ち主が**表にだけ**居るとき `ensureOwnerExists` は誰も昇格させない", () => {
    const store = AuthStore.open(":memory:");
    try {
      const oldest = store.createUser({ username: "oldest", role: "viewer" });
      const later = store.createUser({ username: "later", role: "viewer" });
      store.grantRole(later.id, "owner");
      store.ensureOwnerExists();
      // **列を数えるだけの実装だと、ここで `oldest` が owner に昇格してしまう。**
      expect(store.findUserById(oldest.id)?.role).toBe("viewer");
      expect(store.effectiveRoles(oldest.id)).toEqual(["viewer"]);
      expect(store.countOwners()).toBe(1);
    } finally {
      store.close();
    }
  });

  test("最古昇格: 列にも表にも持ち主が居なければ昇格させる(今日どおり)", () => {
    const store = AuthStore.open(":memory:");
    try {
      // **1人だけにする** —— `created_at` はミリ秒精度で、同一ミリ秒だと並びが id 順に落ちる。
      // 「最古の誰か」ではなく「昇格が起きること」を測る検査なので、曖昧さを持ち込まない。
      const only = store.createUser({ username: "only", role: "viewer" });
      expect(store.countOwners()).toBe(0);
      store.ensureOwnerExists();
      expect(store.findUserById(only.id)?.role).toBe("owner");
      expect(store.countOwners()).toBe(1);
    } finally {
      store.close();
    }
  });

  // -------------------------------------------------------------------------
  // **【`V8-M30`(2026-08-11)。台帳 `T-G29` = 限定採用。ユーザ決定 `D-V8-47`】**
  // **`ADR-0303` 限定7 の見出しの逐語は「**3つの不変条件**は列と表の**両方**を数える」で
  // ある。** **今日、その数は **4つ** になった。**
  //
  // **足したのは「人に役割を配れる人が0人にならない」1本である。**
  // **3つ(「最初に登録した人が持ち主になる」「持ち主が0人にならない」「最後の持ち主を
  // 降ろせない」)は1バイトも動かしていない** —— **この describe の他の検査が、その3つを
  // 着手前と同じ期待値で押さえたまま緑である。**
  //
  // **【禁止の履行】** **本検査は「締め出しが起きない」ことを1文字も主張しない** ——
  // **主張するのは「4本目が実在し、それも列と表の両方を数える」までである。**
  // -------------------------------------------------------------------------
  test("**4本目**: 「配れる人が0人にならない」が今日足された(3つ → 4つ)", () => {
    const store = AuthStore.open(":memory:");
    try {
      // **配れるのは `desk` だけ、という判定を注入する**(`owner` は配れない)。
      store.setRoleGrantJudge((roles) => roles.includes("desk"));

      // (a) 列にだけ居る。
      const columnOnly = store.createUser({ username: "column-only", role: "desk" });
      expect(store.countRoleGranters((roles) => roles.includes("desk"))).toBe(1);
      // (b) 表にだけ居る。
      const tableOnly = store.createUser({ username: "table-only", role: "owner" });
      store.grantRole(tableOnly.id, "desk");
      expect(store.countRoleGranters((roles) => roles.includes("desk"))).toBe(2);
      // (c) 両方に居る人を1人に数える(行ではなく人を数える)。
      store.grantRole(columnOnly.id, "desk");
      expect(store.countRoleGranters((roles) => roles.includes("desk"))).toBe(2);

      // **1本ずつ外していくと、最後の1人で止まる** —— **`countOwners()` は1件も関与しない
      // (持ち主は `tableOnly` の1人のままである)。**
      store.setUserRoles(columnOnly.id, ["viewer"]);
      expect(store.countRoleGranters((roles) => roles.includes("desk"))).toBe(1);
      expect(() => store.setUserRoles(tableOnly.id, ["owner"])).toThrow(LastGranterError);
      expect(store.countOwners()).toBe(1);
    } finally {
      store.close();
    }
  });

  test("退会ガード: 持ち主が**表にだけ**居ても、最後の1人は退会できない", () => {
    const store = AuthStore.open(":memory:");
    try {
      const user = store.createUser({ username: "alice", role: "viewer" });
      store.grantRole(user.id, "owner");
      expect(() => store.deleteUser(user.id)).toThrow(LastOwnerError);
      expect(store.countUsers()).toBe(1);
    } finally {
      store.close();
    }
  });

  test("退会ガード: 持ち主が**列にだけ**居ても、最後の1人は退会できない", () => {
    const store = AuthStore.open(":memory:");
    try {
      const user = store.createUser({ username: "alice", role: "owner" });
      expect(() => store.deleteUser(user.id)).toThrow(LastOwnerError);
      expect(store.countUsers()).toBe(1);
    } finally {
      store.close();
    }
  });

  test("退会は付与行を道連れにする(外部キーの `ON DELETE` は今日も無い)", () => {
    const store = AuthStore.open(":memory:");
    try {
      store.createUser({ username: "keeper", role: "owner" });
      const leaving = store.createUser({ username: "leaving", role: "viewer" });
      store.grantRole(leaving.id, "editor");
      store.deleteUser(leaving.id);
      expect(store.findUserById(leaving.id)).toBeUndefined();
      expect(store.roleGrants(leaving.id)).toEqual([]);
      expect(store.roleGrantsByUser().get(leaving.id)).toBeUndefined();
    } finally {
      store.close();
    }
  });
});
