import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appDbPath } from "../kernel/storage-paths.ts";
import {
  AuthStore,
  ensureAuthActivitySchema,
  fromBase64Url,
  LastOwnerError,
  randomId,
  recordActivity,
  toBase64Url,
} from "./store.ts";

/** kernel の create-app に倣って、DELETE モードの空 app.sqlite を用意する。 */
function makeAppSqlite(dataRoot: string, appId: string): void {
  mkdirSync(join(dataRoot, "apps", appId), { recursive: true });
  const db = new Database(appDbPath(dataRoot, appId), { create: true });
  try {
    db.exec("PRAGMA journal_mode = DELETE;");
    db.exec("VACUUM;");
  } finally {
    db.close();
  }
}

describe("AuthStore", () => {
  const appId = "app-under-test";
  let dataRoot: string;
  let store: AuthStore;

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "gp-auth-store-"));
    makeAppSqlite(dataRoot, appId);
    store = AuthStore.openForApp(dataRoot, appId);
  });

  afterEach(async () => {
    store.close();
    await rm(dataRoot, { recursive: true, force: true });
  });

  describe("randomId / base64url", () => {
    test("randomId は毎回異なる base64url を返す", () => {
      const a = randomId();
      const b = randomId();
      expect(a).not.toBe(b);
      expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    test("base64url は Uint8Array と往復する", () => {
      const bytes = new Uint8Array([0, 1, 2, 250, 251, 255]);
      const roundTripped = fromBase64Url(toBase64Url(bytes));
      expect(Array.from(roundTripped)).toEqual(Array.from(bytes));
    });
  });

  describe("users", () => {
    test("作成したユーザを id / username で取得できる", () => {
      const user = store.createUser({ username: "alice", displayName: "Alice" });
      expect(user.id).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(user.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(store.findUserById(user.id)).toEqual(user);
      expect(store.findUserByUsername("alice")).toEqual(user);
    });

    test("displayName 省略時は null", () => {
      const user = store.createUser({ username: "bob" });
      expect(user.displayName).toBeNull();
    });

    test("未登録の取得は undefined", () => {
      expect(store.findUserById("nope")).toBeUndefined();
      expect(store.findUserByUsername("nope")).toBeUndefined();
    });

    test("username の重複は throw(UNIQUE 違反)", () => {
      store.createUser({ username: "alice" });
      expect(() => store.createUser({ username: "alice" })).toThrow(/既に使われています/);
    });

    test("countUsers は登録数を返す(初回ユーザ判定用)", () => {
      expect(store.countUsers()).toBe(0);
      store.createUser({ username: "alice" });
      expect(store.countUsers()).toBe(1);
      store.createUser({ username: "bob" });
      expect(store.countUsers()).toBe(2);
    });
  });

  describe("roles", () => {
    test("role 未指定は 'viewer' 既定", () => {
      const user = store.createUser({ username: "alice" });
      expect(user.role).toBe("viewer");
      expect(store.findUserById(user.id)?.role).toBe("viewer");
      expect(store.findUserByUsername("alice")?.role).toBe("viewer");
    });

    test("role を指定すればその値で作成される", () => {
      const owner = store.createUser({ username: "alice", role: "owner" });
      const editor = store.createUser({ username: "bob", role: "editor" });
      expect(owner.role).toBe("owner");
      expect(store.findUserById(editor.id)?.role).toBe("editor");
    });

    test("新規 DB で role='customer' のユーザを作成できる(EC-G2 / ADR-0033 限定1)", () => {
      const customer = store.createUser({ username: "carol", role: "customer" });
      expect(customer.role).toBe("customer");
      expect(store.findUserById(customer.id)?.role).toBe("customer");
      expect(store.findUserByUsername("carol")?.role).toBe("customer");
    });

    test("setUserRole で customer へ変更できる(customer は owner 不変条件に影響しない)", () => {
      store.createUser({ username: "alice", role: "owner" });
      const bob = store.createUser({ username: "bob", role: "viewer" });
      const updated = store.setUserRole(bob.id, "customer");
      expect(updated.role).toBe("customer");
      expect(store.findUserById(bob.id)?.role).toBe("customer");
    });

    test("不正な role は CHECK 制約で弾かれる", () => {
      // 型を迂回して不正値を渡す(DB の CHECK が最後の防御であることを検証)。
      // **【`V5-M17-T03` / `ADR-0158` 限定5 / `ADR-0233` で題材を差し替えた】**
      // **旧い題材は `"superuser"` だった。** **`CHECK` が値の列挙ではなく識別子の形
      // (小文字英数と `_`・1〜32文字)を見るようになったので、`superuser` は今日は通る**
      // —— **アプリが `superuser` という種類を宣言していれば正当な値だからである。**
      // **DB が弾けるのは「形を外れた値」だけになった** —— **「宣言された種類か」を見るのは
      // サーバ層である**(`resolveRequestedUserKind` / `isRole`)。**弱くなった面を隠さない。**
      // **題材は形を外れたもの(大文字・空白・日本語・33文字)に差し替えた。**
      for (const bad of ["Mallory", "super user", "管理者", "a".repeat(33), ""]) {
        expect(() =>
          store.createUser({ username: `mallory-${bad}`, role: bad as unknown as "owner" }),
        ).toThrow();
      }
    });

    test("listUsers は created_at 昇順で全ユーザを返す", () => {
      const alice = store.createUser({ username: "alice", role: "owner" });
      const bob = store.createUser({ username: "bob", role: "viewer" });
      const carol = store.createUser({ username: "carol", role: "editor" });
      // 同一ミリ秒の tie-break(`V9-M11-T05` / `ADR-0356` で rowid = 挿入順になった)に
      // 依存させず、created_at を明示的にずらす。tie-break 自体は
      // owner-promotion-order.test.ts が同着を人工的に起こして測る。
      const raw = new Database(appDbPath(dataRoot, appId));
      try {
        const upd = raw.query(`UPDATE "_auth_users" SET "created_at" = ? WHERE "id" = ?`);
        upd.run("2026-01-01T00:00:00.000Z", alice.id);
        upd.run("2026-01-02T00:00:00.000Z", bob.id);
        upd.run("2026-01-03T00:00:00.000Z", carol.id);
      } finally {
        raw.close();
      }
      const users = store.listUsers();
      expect(users.map((u) => u.username)).toEqual(["alice", "bob", "carol"]);
      expect(users.map((u) => u.role)).toEqual(["owner", "viewer", "editor"]);
    });

    test("countOwners は owner 数を返す", () => {
      expect(store.countOwners()).toBe(0);
      store.createUser({ username: "alice", role: "owner" });
      store.createUser({ username: "bob", role: "viewer" });
      expect(store.countOwners()).toBe(1);
      store.createUser({ username: "carol", role: "owner" });
      expect(store.countOwners()).toBe(2);
    });

    test("setUserRole で昇格・降格ができ、更新後 User を返す", () => {
      const alice = store.createUser({ username: "alice", role: "owner" });
      const bob = store.createUser({ username: "bob", role: "viewer" });
      const promoted = store.setUserRole(bob.id, "editor");
      expect(promoted.role).toBe("editor");
      expect(store.findUserById(bob.id)?.role).toBe("editor");
      // owner が2人いれば片方を降格できる。
      store.setUserRole(promoted.id, "owner");
      const demoted = store.setUserRole(alice.id, "editor");
      expect(demoted.role).toBe("editor");
    });

    test("最後の owner を降格しようとすると LastOwnerError", () => {
      const alice = store.createUser({ username: "alice", role: "owner" });
      store.createUser({ username: "bob", role: "viewer" });
      expect(() => store.setUserRole(alice.id, "viewer")).toThrow(LastOwnerError);
      // 状態は変わっていない(トランザクションで守られる)。
      expect(store.findUserById(alice.id)?.role).toBe("owner");
    });

    test("最後の owner を owner のまま setUserRole するのは許可(no-op 更新)", () => {
      const alice = store.createUser({ username: "alice", role: "owner" });
      const same = store.setUserRole(alice.id, "owner");
      expect(same.role).toBe("owner");
    });

    test("存在しないユーザへの setUserRole は throw", () => {
      expect(() => store.setUserRole("nope", "editor")).toThrow();
    });
  });

  describe("ensureOwnerExists", () => {
    test("owner ゼロ + users>0 なら最古(created_at→rowid 昇順)を owner に昇格", () => {
      const alice = store.createUser({ username: "alice", role: "viewer" });
      const bob = store.createUser({ username: "bob", role: "viewer" });
      // createUser の created_at は同一ミリ秒になりうる。仕様の tie-break を検証するため
      // 別接続で created_at を明示的にずらし、alice を厳密に最古にする。
      const raw = new Database(appDbPath(dataRoot, appId));
      try {
        raw
          .query(`UPDATE "_auth_users" SET "created_at" = ? WHERE "id" = ?`)
          .run("2026-01-01T00:00:00.000Z", alice.id);
        raw
          .query(`UPDATE "_auth_users" SET "created_at" = ? WHERE "id" = ?`)
          .run("2026-01-02T00:00:00.000Z", bob.id);
      } finally {
        raw.close();
      }
      expect(store.countOwners()).toBe(0);
      store.ensureOwnerExists();
      expect(store.countOwners()).toBe(1);
      expect(store.findUserById(alice.id)?.role).toBe("owner");
      expect(store.findUserById(bob.id)?.role).toBe("viewer");
    });

    test("owner が既にいれば無変更", () => {
      const alice = store.createUser({ username: "alice", role: "viewer" });
      const bob = store.createUser({ username: "bob", role: "owner" });
      store.ensureOwnerExists();
      expect(store.findUserById(alice.id)?.role).toBe("viewer");
      expect(store.findUserById(bob.id)?.role).toBe("owner");
      expect(store.countOwners()).toBe(1);
    });

    test("users ゼロなら何もしない", () => {
      expect(() => store.ensureOwnerExists()).not.toThrow();
      expect(store.countOwners()).toBe(0);
    });
  });

  describe("activity (監査)", () => {
    test("別接続の recordActivity を AuthStore.listActivity が読める(同一 app.sqlite)", () => {
      const user = store.createUser({ username: "alice", role: "editor" });
      // openForApp で _auth_activity は既に作られている前提。server が withAppDb で
      // 開く「別の生 Database 接続」を模す。
      const raw = new Database(appDbPath(dataRoot, appId));
      let created: ReturnType<typeof recordActivity>;
      try {
        created = recordActivity(raw, {
          userId: user.id,
          username: user.username,
          action: "create_record",
          tableId: "books",
          recordId: "book-1",
        });
      } finally {
        raw.close();
      }
      expect(created.id).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(created.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      const rows = store.listActivity();
      expect(rows.length).toBe(1);
      expect(rows[0]).toEqual(created);
    });

    test("listActivity は at 昇順で返す", () => {
      // recordActivity の at はミリ秒精度で同一になりうるため、ORDER BY を厳密に
      // 検証すべく別々の at を直接 INSERT して、投入順とは逆順で入れる。
      const raw = new Database(appDbPath(dataRoot, appId));
      try {
        const insert = raw.query(
          `INSERT INTO "_auth_activity"
             ("id","user_id","username","action","table_id","record_id","at")
           VALUES (?,?,?,?,?,?,?)`,
        );
        insert.run("a3", "u", "alice", "delete_record", "t", "r1", "2026-03-03T00:00:00.000Z");
        insert.run("a1", "u", "alice", "create_record", "t", "r1", "2026-01-01T00:00:00.000Z");
        insert.run("a2", "u", "alice", "update_record", "t", "r1", "2026-02-02T00:00:00.000Z");
      } finally {
        raw.close();
      }
      const ats = store.listActivity().map((a) => a.at);
      expect(ats).toEqual([
        "2026-01-01T00:00:00.000Z",
        "2026-02-02T00:00:00.000Z",
        "2026-03-03T00:00:00.000Z",
      ]);
    });
  });

  describe("ensureAuthActivitySchema + recordActivity(生 Database)", () => {
    test(":memory: に ensure → record → 直接 SELECT で1件読める(record_id null 可)", () => {
      const db = new Database(":memory:");
      try {
        ensureAuthActivitySchema(db);
        // 冪等(2回呼んでも壊れない)。
        ensureAuthActivitySchema(db);
        const rec = recordActivity(db, {
          userId: "u1",
          username: "alice",
          action: "delete_record",
          tableId: "books",
          recordId: null,
        });
        expect(rec.recordId).toBeNull();
        const row = db
          .query<
            {
              id: string;
              user_id: string;
              username: string;
              action: string;
              record_id: string | null;
              at: string;
            },
            []
          >(`SELECT "id", "user_id", "username", "action", "record_id", "at" FROM "_auth_activity"`)
          .get();
        expect(row?.id).toBe(rec.id);
        expect(row?.user_id).toBe("u1");
        expect(row?.username).toBe("alice");
        expect(row?.action).toBe("delete_record");
        expect(row?.record_id).toBeNull();
        expect(row?.at).toBe(rec.at);
      } finally {
        db.close();
      }
    });
  });

  describe("webauthn credentials", () => {
    test("公開鍵は base64url ⇄ Uint8Array で往復して保存・復元される", () => {
      const user = store.createUser({ username: "alice" });
      const publicKey = new Uint8Array([10, 20, 30, 200, 255, 0]);
      store.addWebauthnCredential({
        id: "cred-1",
        userId: user.id,
        publicKey,
        counter: 0,
        transports: ["internal", "hybrid"],
        deviceType: "multiDevice",
        backedUp: true,
      });
      const fetched = store.getWebauthnCredentialById("cred-1");
      expect(fetched).toBeDefined();
      expect(Array.from(fetched?.publicKey ?? [])).toEqual(Array.from(publicKey));
      expect(fetched?.transports).toEqual(["internal", "hybrid"]);
      expect(fetched?.deviceType).toBe("multiDevice");
      expect(fetched?.backedUp).toBe(true);
      expect(fetched?.counter).toBe(0);
    });

    test("任意項目を省略しても保存・復元できる", () => {
      const user = store.createUser({ username: "alice" });
      store.addWebauthnCredential({
        id: "cred-min",
        userId: user.id,
        publicKey: new Uint8Array([1]),
        counter: 5,
      });
      const fetched = store.getWebauthnCredentialById("cred-min");
      expect(fetched?.transports).toBeUndefined();
      expect(fetched?.deviceType).toBeUndefined();
      expect(fetched?.backedUp).toBeUndefined();
      expect(fetched?.lastUsedAt).toBeUndefined();
    });

    test("ユーザ単位で一覧できる", () => {
      const alice = store.createUser({ username: "alice" });
      const bob = store.createUser({ username: "bob" });
      store.addWebauthnCredential({
        id: "a1",
        userId: alice.id,
        publicKey: new Uint8Array([1]),
        counter: 0,
      });
      store.addWebauthnCredential({
        id: "a2",
        userId: alice.id,
        publicKey: new Uint8Array([2]),
        counter: 0,
      });
      store.addWebauthnCredential({
        id: "b1",
        userId: bob.id,
        publicKey: new Uint8Array([3]),
        counter: 0,
      });
      expect(
        store
          .getWebauthnCredentialsByUser(alice.id)
          .map((c) => c.id)
          .sort(),
      ).toEqual(["a1", "a2"]);
    });

    test("counter を更新すると last_used_at も記録される", () => {
      const user = store.createUser({ username: "alice" });
      store.addWebauthnCredential({
        id: "cred-1",
        userId: user.id,
        publicKey: new Uint8Array([1]),
        counter: 3,
      });
      store.updateCredentialCounter("cred-1", 7);
      const fetched = store.getWebauthnCredentialById("cred-1");
      expect(fetched?.counter).toBe(7);
      expect(fetched?.lastUsedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe("password credentials", () => {
    test("設定・取得・上書きができる", () => {
      const user = store.createUser({ username: "alice" });
      expect(store.getPassword(user.id)).toBeUndefined();
      store.setPassword(user.id, "hash-1");
      expect(store.getPassword(user.id)?.passwordHash).toBe("hash-1");
      store.setPassword(user.id, "hash-2");
      expect(store.getPassword(user.id)?.passwordHash).toBe("hash-2");
    });
  });

  describe("sessions", () => {
    test("発行したセッションを取得できる", () => {
      const user = store.createUser({ username: "alice" });
      const session = store.createSession(user.id, 3600);
      expect(store.findSession(session.id)).toEqual(session);
    });

    test("期限切れセッションは無効扱い(undefined)で掃除される", () => {
      const user = store.createUser({ username: "alice" });
      const expired = store.createSession(user.id, -1);
      expect(store.findSession(expired.id)).toBeUndefined();
      // 掃除済みなので再取得も undefined
      expect(store.findSession(expired.id)).toBeUndefined();
    });

    test("失効(delete)後は取得できない", () => {
      const user = store.createUser({ username: "alice" });
      const session = store.createSession(user.id, 3600);
      store.deleteSession(session.id);
      expect(store.findSession(session.id)).toBeUndefined();
    });

    test("ユーザ単位で全失効できる", () => {
      const user = store.createUser({ username: "alice" });
      const s1 = store.createSession(user.id, 3600);
      const s2 = store.createSession(user.id, 3600);
      store.deleteSessionsByUser(user.id);
      expect(store.findSession(s1.id)).toBeUndefined();
      expect(store.findSession(s2.id)).toBeUndefined();
    });
  });

  describe("pending challenges", () => {
    test("保存したチャレンジは1回だけ取得できる(使い捨て)", () => {
      const pending = store.savePendingChallenge({
        challenge: "chal-abc",
        purpose: "registration",
        username: "alice",
        ttlSec: 300,
      });
      const first = store.takePendingChallenge(pending.id);
      expect(first?.challenge).toBe("chal-abc");
      expect(first?.purpose).toBe("registration");
      expect(store.takePendingChallenge(pending.id)).toBeUndefined();
    });
  });

  describe("purgeExpired", () => {
    test("期限切れの pending と session を掃除する", () => {
      const user = store.createUser({ username: "alice" });
      store.createSession(user.id, -1);
      store.createSession(user.id, 3600);
      store.savePendingChallenge({ challenge: "old", purpose: "authentication", ttlSec: -1 });
      store.savePendingChallenge({ challenge: "new", purpose: "registration", ttlSec: 300 });
      const removed = store.purgeExpired();
      expect(removed).toBe(2);
    });
  });

  describe("reserved tables", () => {
    test("作成されるテーブルはすべて _auth_ プレフィックス", () => {
      store.createUser({ username: "alice" });
      const path = appDbPath(dataRoot, appId);
      const db = new Database(path, { readonly: true });
      try {
        const names = db
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
          )
          .all()
          .map((r) => r.name)
          .filter((n) => !n.startsWith("sqlite_"));
        // **【期待値を書き換えた理由: `V8-M16` / `J-G3`(2026-08-09)】**
        // **7本目 `_auth_user_roles`(役割の付与)を足した。** 根拠は門A の限定 `J-G3` の
        // 逐語「**複数の役割は和集合1本で合成する**」であり、**`_auth_users` は1バイトも
        // 作り直していない**(列は今日どおり残り、実効ロール集合の1本目になる)。
        // **検査は消していない・`skip` にしていない・条件も緩めていない** ——
        // 「作られる表はすべて `_auth_` プレフィックス」という問いはそのままである。
        //
        // **【期待値を書き換えた理由: `V8-M2` / `I-G9` / `ADR-0336`(2026-08-14)】**
        // **8本目 `_auth_invitations`(招待)を足した。**
        // **旧の期待値(7本。逐語で残す)**:
        //
        //     expect(names).toEqual([
        //       "_auth_activity",
        //       "_auth_password_credentials",
        //       "_auth_pending_challenges",
        //       "_auth_sessions",
        //       "_auth_user_roles",
        //       "_auth_users",
        //       "_auth_webauthn_credentials",
        //     ]);
        //
        // **これは [`ADR-0303`](../../docs/adr/0303-multi-role-grant-table.md) 限定1 の
        // 「**`_auth_*` の8本目を作らない**」を正面から破ったということである** ——
        // **`ADR-0336` がその引き直しを行い、`ADR-0303` の front matter に `amended_by` を
        // 入れた。** **【禁止】これを「同じ作法の2度目」とだけ書かない。**
        // **【この検査は1バイトも緩めていない】** **消していない・`skip` にしていない・
        // 「すべて `_auth_` プレフィックス」という問いもそのままである** ——
        // **期待値の配列に1要素を足しただけである。**
        expect(names).toEqual([
          "_auth_activity",
          "_auth_invitations",
          "_auth_password_credentials",
          "_auth_pending_challenges",
          "_auth_sessions",
          "_auth_user_roles",
          "_auth_users",
          "_auth_webauthn_credentials",
        ]);
      } finally {
        db.close();
      }
    });
  });
});

describe("AuthStore.openForApp — app データとの共存", () => {
  let dataRoot: string;

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "gp-auth-coexist-"));
  });

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  test("既存の app データテーブル(books)を壊さず _auth_* を共存させる", () => {
    const appId = "library";
    mkdirSync(join(dataRoot, "apps", appId), { recursive: true });
    const path = appDbPath(dataRoot, appId);

    // app データ(books)を先に用意して1件入れておく。
    const seed = new Database(path, { create: true });
    try {
      seed.exec("PRAGMA journal_mode = DELETE;");
      seed.exec('CREATE TABLE "books" ("id" TEXT PRIMARY KEY, "title" TEXT NOT NULL);');
      seed.query('INSERT INTO "books" ("id", "title") VALUES (?, ?)').run("b1", "SQLite本");
    } finally {
      seed.close();
    }

    // 認証ストアを開いて _auth_* を作成し、ユーザを1件作る。
    const store = AuthStore.openForApp(dataRoot, appId);
    try {
      const user = store.createUser({ username: "alice" });
      expect(store.findUserById(user.id)).toEqual(user);
    } finally {
      store.close();
    }

    // 既存の books データは無傷で、_auth_users も共存している。
    const check = new Database(path, { readonly: true });
    try {
      const book = check
        .query<{ id: string; title: string }, [string]>('SELECT * FROM "books" WHERE "id" = ?')
        .get("b1");
      expect(book).toEqual({ id: "b1", title: "SQLite本" });

      const names = check
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => r.name);
      expect(names).toContain("books");
      expect(names).toContain("_auth_users");
    } finally {
      check.close();
    }
  });
});

describe("AuthStore — role 列の移行(T01 既存 app.sqlite)", () => {
  let dataRoot: string;
  const appId = "legacy";

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "gp-auth-migrate-"));
  });

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  /** T01 当時のスキーマ(role 列なし)の _auth_users を手で作り、user を1件入れる。 */
  function makeLegacyDb(): { userId: string } {
    mkdirSync(join(dataRoot, "apps", appId), { recursive: true });
    const path = appDbPath(dataRoot, appId);
    const db = new Database(path, { create: true });
    const userId = randomId();
    try {
      db.exec("PRAGMA journal_mode = DELETE;");
      db.exec(`CREATE TABLE IF NOT EXISTS "_auth_users" (
        "id"           TEXT PRIMARY KEY,
        "username"     TEXT UNIQUE NOT NULL,
        "display_name" TEXT,
        "created_at"   TEXT NOT NULL
      );`);
      db.query(
        `INSERT INTO "_auth_users" ("id","username","display_name","created_at") VALUES (?,?,?,?)`,
      ).run(userId, "legacy-alice", "Alice", "2026-01-01T00:00:00.000Z");
    } finally {
      db.close();
    }
    return { userId };
  }

  test("role 列なしの既存 DB を開くと ALTER で role 列が足され、既存 user は 'viewer'", () => {
    const { userId } = makeLegacyDb();
    const store = AuthStore.openForApp(dataRoot, appId);
    try {
      const cols = new Database(appDbPath(dataRoot, appId), { readonly: true });
      try {
        const names = cols
          .query<{ name: string }, []>(`PRAGMA table_info("_auth_users")`)
          .all()
          .map((c) => c.name);
        expect(names).toContain("role");
      } finally {
        cols.close();
      }
      expect(store.findUserById(userId)?.role).toBe("viewer");
      // 移行直後は owner ゼロ。ensureOwnerExists で最古が owner に昇格。
      expect(store.countOwners()).toBe(0);
      store.ensureOwnerExists();
      expect(store.findUserById(userId)?.role).toBe("owner");
    } finally {
      store.close();
    }
  });

  test("open(path) 経路でも role 列が移行される", () => {
    makeLegacyDb();
    const store = AuthStore.open(appDbPath(dataRoot, appId));
    try {
      expect(store.findUserByUsername("legacy-alice")?.role).toBe("viewer");
    } finally {
      store.close();
    }
  });
});

/**
 * SQLite CHECK 後方互換の限界を顕在化する(ADR-0033 §4 / v2-m1.md T01 完了条件3)。
 *
 * SQLite は既存の role 列に付いた CHECK 制約を ALTER TABLE で変更できない。したがって
 * **role 列を既に3値 CHECK 付きで持っている古い DB**(M3-T02 で role 列を得た DB)を
 * migrateUserRole(= openForApp/open が呼ぶ prepare)に通しても、CHECK は3値のままで、
 * customer の INSERT は CHECK に弾かれうる。
 *
 * 採用方針は ADR-0033 §4 (a):「**新規 DB / role 列未取得の DB でのみ customer を有効**」。
 * table rebuild((b))は app.sqlite 同居ゆえ snapshot/undo と交差しリスクが高く、本タスクの
 * スコープ外。ここでは (a) の限界を「解決したふり」をせず、テストで正直に固定する(憲法6)。
 */
describe("AuthStore — SQLite CHECK 後方互換の限界(ADR-0033 §4・対処(a))", () => {
  let dataRoot: string;
  const appId = "legacy-3value-check";

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "gp-auth-check-compat-"));
  });

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  /**
   * 「customer を知らない古い DB」= role 列を**3値 CHECK 付きで既に持つ** _auth_users を
   * 手で作る(M3-T02 当時の DDL を再現)。migrateUserRole は role 列が在れば何もしない。
   */
  function makeLegacy3ValueCheckDb(): void {
    mkdirSync(join(dataRoot, "apps", appId), { recursive: true });
    const db = new Database(appDbPath(dataRoot, appId), { create: true });
    try {
      db.exec("PRAGMA journal_mode = DELETE;");
      db.exec(`CREATE TABLE IF NOT EXISTS "_auth_users" (
        "id"           TEXT PRIMARY KEY,
        "username"     TEXT UNIQUE NOT NULL,
        "display_name" TEXT,
        "role"         TEXT NOT NULL DEFAULT 'viewer' CHECK("role" IN ('owner','editor','viewer')),
        "created_at"   TEXT NOT NULL
      );`);
    } finally {
      db.close();
    }
  }

  test("3値 CHECK の古い DB は移行され、customer が通る(**限界を実装で覆した**)", () => {
    // **【`V5-M17-T03` / `ADR-0233` で反転した。旧テスト名と旧本体を先に書く】**
    //
    // **旧テスト名**: 「3値 CHECK の古い DB では customer が CHECK で弾かれる
    // (限界。対処(a)で customer は新規 DB 限定)」。
    // **旧本体**: `expect(() => store.createUser({ username: "buyer", role: "customer" }))
    //   .toThrow(/CHECK/i);`
    //
    // **上の describe の doc コメント(`ADR-0033` §4 (a) を採る)を1バイトも書き換えて
    // いない。** **偽になったのは「table rebuild はスコープ外」という1点である** ——
    // **`V5-M17` の発注がテーブル再構築による移行を指示した**(`CLAUDE.md` = ユーザの要求を
    // ADR より優先する)。**変更 ADR は `docs/adr/0233-auth-role-check-migration.md`。**
    //
    // **【`ADR-0033` §4 が挙げたリスクは消えていない】** **`_auth_users` は `app.sqlite` に
    // 同居するので、移行の直後に巻き戻せば `CHECK` も古い形へ戻る。****それを確かめた
    // 検査は1本も無い**(`src/auth/role-check-migration.test.ts` の冒頭が限界として名指し)。
    makeLegacy3ValueCheckDb();
    const store = AuthStore.open(appDbPath(dataRoot, appId));
    try {
      expect(store.createUser({ username: "legacy-viewer", role: "viewer" }).role).toBe("viewer");
      expect(store.createUser({ username: "buyer", role: "customer" }).role).toBe("customer");
      // **宣言された種類も通る**(値の列挙ではなく形を見る `CHECK` になったため)。
      expect(store.createUser({ username: "kaiin", role: "member" }).role).toBe("member");
    } finally {
      store.close();
    }
  });

  test("新規 DB(4値 CHECK)なら同じ customer INSERT が通る(対称の確認)", () => {
    const freshAppId = "fresh-4value-check";
    mkdirSync(join(dataRoot, "apps", freshAppId), { recursive: true });
    const store = AuthStore.open(appDbPath(dataRoot, freshAppId));
    try {
      expect(store.createUser({ username: "buyer", role: "customer" }).role).toBe("customer");
    } finally {
      store.close();
    }
  });
});
