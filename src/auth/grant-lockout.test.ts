/**
 * **「人に役割を配れる人が0人」を、役割の規則の外側で数え直す**(`V8-M30`。台帳 `T-G29`
 * = **限定採用**。ユーザ決定 `D-V8-47`)。**保存の側の検査。**
 *
 * ## この検査が固定する規則(**2本目の不変条件。1本目は1バイトも動かさない**)
 *
 * > **`countOwners()`(`'owner'` という綴りの役割を持つ**人**の数)は1バイトも変えない。**
 * > **その隣に「`role` + `write` を持つ役割を実効ロール集合に持つ人の数」を数える2本目を立てる。**
 * > **2本を `AND` で結ばない** —— **どちらか一方でも0になる操作を拒否する。**
 *
 * **根拠**(`docs/plan/v8/records/v8-m25.md` §5-2 の (4) の逐語):
 *
 * > **今日の数え方を1バイトも変えず、`D-V8-49` の新しい対象「人の役割」に対する配る動詞を
 * > 許された役割を数える2本目の不変条件を隣に立てる。** **2本の `AND` にしない**
 * > (`AND` にすると片方が0でも通る)。
 *
 * ## この検査が測らないもの(**誇張しない。先に書く**)
 *
 * 1. **`undo` を1度も呼んでいない。** **巻き戻しがこの2本目を迂回できるかどうかは、
 *    本ファイルは1件も測っていない**(`D-V8-51` = 実測して記録するだけ。塞がない)。
 * 2. **`src/auth/` は役割の規則を1バイトも読まない。** **「その人が配れるか」の判定は
 *    **注入**で受け取る**(`src/server/owner-scope.ts` の `judgeRoleAccess` を包んだもの)。
 *    **本ファイルはその判定の中身を1件も検査していない。**
 * 3. **判定を注入していない `AuthStore` では、2本目は1件も発火しない。** **したがって
 *    カーネル層を直接叩く経路(MCP など)はこの2本目を1ミリも通らない。**
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore, LastGranterError, LastOwnerError } from "./store.ts";
import type { Role } from "./types.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gp-grant-lockout-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * **「配れる人」の判定を、役割の綴りの集合で組み立てる。**
 * **これは `src/server` 側で `judgeRoleAccess({ target: "role", verb: "write" })` が
 * 答えるものの、検査用の代役である** —— **本ファイルは規則の読み方を検査しない。**
 */
function judgeOf(granting: readonly string[]): (roles: readonly Role[]) => boolean {
  return (roles) => roles.some((role) => granting.includes(role));
}

// ---------------------------------------------------------------------------
// (1) 2本目の不変条件が実在すること
// ---------------------------------------------------------------------------

describe("(1) 配れる人が0人になる操作を拒否する(2本目の不変条件)", () => {
  test("最後の「配れる人」から配れる役割を外す `setUserRoles` は `LastGranterError`", () => {
    const store = AuthStore.open(":memory:");
    try {
      // **持ち主は2人いる**(1本目の不変条件はここでは発火しない)。
      const alice = store.createUser({ username: "alice", role: "owner" });
      store.createUser({ username: "bob", role: "owner" });
      // **配れるのは `desk` だけである** —— **`owner` は「配れる役割」ではない。**
      // **この形のマニフェストは今日 `set_roles` からは書けない**(`T-G16a` が `owner` から
      // `role` + `write` を抜けなくしている)**が、`undo` が古い定義を書き戻せば実在しうる。**
      store.setRoleGrantJudge(judgeOf(["desk"]));
      store.grantRole(alice.id, "desk");

      expect(store.countOwners()).toBe(2);
      expect(store.countRoleGranters(judgeOf(["desk"]))).toBe(1);

      expect(() => store.setUserRoles(alice.id, ["owner"])).toThrow(LastGranterError);
      // **拒否されたのだから、書込は1バイトも残っていない**(トランザクションが巻き戻る)。
      expect(store.effectiveRoles(alice.id).slice().sort()).toEqual(["desk", "owner"]);
      expect(store.countRoleGranters(judgeOf(["desk"]))).toBe(1);
      expect(store.countOwners()).toBe(2);
    } finally {
      store.close();
    }
  });

  test("最後の「配れる人」の退会(`deleteUser`)も `LastGranterError`", () => {
    const store = AuthStore.open(":memory:");
    try {
      const alice = store.createUser({ username: "alice", role: "desk" });
      store.createUser({ username: "bob", role: "viewer" });
      store.setRoleGrantJudge(judgeOf(["desk"]));

      // **持ち主は0人である** —— **1本目の不変条件はここで1度も発火しない。**
      expect(store.countOwners()).toBe(0);
      expect(() => store.deleteUser(alice.id)).toThrow(LastGranterError);
      expect(store.findUserById(alice.id)).not.toBeUndefined();
    } finally {
      store.close();
    }
  });

  test("`setUserRole`(列だけを変える形)でも発火する", () => {
    const store = AuthStore.open(":memory:");
    try {
      const alice = store.createUser({ username: "alice", role: "desk" });
      store.createUser({ username: "bob", role: "owner" });
      store.setRoleGrantJudge(judgeOf(["desk"]));

      expect(store.countRoleGranters(judgeOf(["desk"]))).toBe(1);
      expect(() => store.setUserRole(alice.id, "viewer")).toThrow(LastGranterError);
      expect(store.findUserById(alice.id)?.role).toBe("desk");
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// (2) 1本目(`LastOwnerError`)は1バイトも変わっていない
// ---------------------------------------------------------------------------

describe("(2) 持ち主が0人になる操作は今日どおり拒否される", () => {
  test("最後の持ち主の降格は `LastOwnerError`(判定を注入していても変わらない)", () => {
    const store = AuthStore.open(":memory:");
    try {
      const alice = store.createUser({ username: "alice", role: "owner" });
      store.setRoleGrantJudge(judgeOf(["owner"]));
      expect(() => store.setUserRoles(alice.id, ["viewer"])).toThrow(LastOwnerError);
    } finally {
      store.close();
    }
  });

  test("判定を1つも注入していない `AuthStore` では、2本目は1件も止めない", () => {
    const store = AuthStore.open(":memory:");
    try {
      const alice = store.createUser({ username: "alice", role: "desk" });
      store.createUser({ username: "bob", role: "owner" });
      // **`setRoleGrantJudge` を呼んでいない。**
      expect(() => store.setUserRoles(alice.id, ["viewer"])).not.toThrow();
      expect(store.effectiveRoles(alice.id)).toEqual(["viewer"]);
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// (3) 2本は `AND` ではない —— **片方だけ0になる操作も拒否される。2方向とも固定する**
// ---------------------------------------------------------------------------

describe("(3) 2本の不変条件は `AND` で結ばれていない", () => {
  test("方向1: 持ち主が0人になるが、配れる人は残る操作 —— 拒否される(`LastOwnerError`)", () => {
    const store = AuthStore.open(":memory:");
    try {
      const alice = store.createUser({ username: "alice", role: "owner" });
      const bob = store.createUser({ username: "bob", role: "desk" });
      // **`owner` も `desk` も配れる。**
      store.setRoleGrantJudge(judgeOf(["owner", "desk"]));

      expect(store.countOwners()).toBe(1);
      expect(store.countRoleGranters(judgeOf(["owner", "desk"]))).toBe(2);

      // **alice を降ろすと持ち主は0人になるが、配れる人は bob が残って1人である。**
      // **`AND`(両方が0のときだけ拒否)なら通ってしまう。** **今日は拒否される。**
      expect(() => store.setUserRoles(alice.id, ["viewer"])).toThrow(LastOwnerError);
      expect(store.countOwners()).toBe(1);
      expect(store.effectiveRoles(bob.id)).toEqual(["desk"]);
    } finally {
      store.close();
    }
  });

  test("方向2: 配れる人が0人になるが、持ち主は残る操作 —— 拒否される(`LastGranterError`)", () => {
    const store = AuthStore.open(":memory:");
    try {
      const alice = store.createUser({ username: "alice", role: "owner" });
      store.createUser({ username: "bob", role: "owner" });
      store.grantRole(alice.id, "desk");
      // **配れるのは `desk` だけである**(`owner` は配れない)。
      store.setRoleGrantJudge(judgeOf(["desk"]));

      expect(store.countOwners()).toBe(2);
      expect(store.countRoleGranters(judgeOf(["desk"]))).toBe(1);

      // **alice から `desk` を外すと配れる人は0人になるが、持ち主は2人のままである。**
      // **`AND` なら通ってしまう。** **今日は拒否される。**
      expect(() => store.setUserRoles(alice.id, ["owner"])).toThrow(LastGranterError);
      expect(store.countRoleGranters(judgeOf(["desk"]))).toBe(1);
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// (4) 2本目も**列と表の両方**を数える(`ADR-0303` 限定7 の逐語)
// ---------------------------------------------------------------------------

describe("(4) `countRoleGranters` は列と表の両方を数える", () => {
  test("「列にだけ」「表にだけ」「両方」のどれでも 0人 と判定しない", () => {
    const store = AuthStore.open(":memory:");
    try {
      const judge = judgeOf(["desk"]);
      // (a) 列にだけ居る。
      const columnOnly = store.createUser({ username: "column-only", role: "desk" });
      expect(store.countRoleGranters(judge)).toBe(1);

      // (b) 表にだけ居る。
      const tableOnly = store.createUser({ username: "table-only", role: "viewer" });
      store.grantRole(tableOnly.id, "desk");
      expect(store.countRoleGranters(judge)).toBe(2);

      // (c) 両方に居る人を1人に数える(行ではなく人を数える)。
      store.grantRole(columnOnly.id, "desk");
      expect(store.countRoleGranters(judge)).toBe(2);
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// (5) **回復経路を塞がない** —— 既に0人の状態では、2本目は1件も止めない
// ---------------------------------------------------------------------------

describe("(5) 既に配れる人が0人の状態からは、締め出しの防止が止めない", () => {
  test("0人 → 0人 の操作は通る(止めるのは「0人にする操作」だけである)", () => {
    const store = AuthStore.open(":memory:");
    try {
      const alice = store.createUser({ username: "alice", role: "owner" });
      store.createUser({ username: "bob", role: "owner" });
      // **配れる役割 `desk` を誰も持っていない** —— **配れる人は最初から0人である。**
      store.setRoleGrantJudge(judgeOf(["desk"]));
      expect(store.countRoleGranters(judgeOf(["desk"]))).toBe(0);

      expect(() => store.setUserRoles(alice.id, ["viewer"])).not.toThrow();
      expect(store.countRoleGranters(judgeOf(["desk"]))).toBe(0);
    } finally {
      store.close();
    }
  });

  test("0人 → 1人 の操作(回復そのもの)も通る", () => {
    const store = AuthStore.open(":memory:");
    try {
      const alice = store.createUser({ username: "alice", role: "owner" });
      store.setRoleGrantJudge(judgeOf(["desk"]));
      expect(store.countRoleGranters(judgeOf(["desk"]))).toBe(0);
      expect(() => store.setUserRoles(alice.id, ["owner", "desk"])).not.toThrow();
      expect(store.countRoleGranters(judgeOf(["desk"]))).toBe(1);
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// (6) **`'owner'` の SQL 焼き込みは残す**(`D-V8-47` の逐語「今と同じ仕掛けを外側に残します」)
// ---------------------------------------------------------------------------

describe("(6) `countOwners` の SQL に焼き込まれた `'owner'` が今日も在る", () => {
  test("`_auth_users.role = 'owner'` と `_auth_user_roles.role = 'owner'` の2箇所が残っている", async () => {
    const source = await Bun.file(new URL("./store.ts", import.meta.url)).text();
    // **本 MS は `countOwners` の SQL を1バイトも変えない。** **残すと決めたので、
    // 残っていることを検査で固定する**(`T-G29` の帰属先の逐語)。
    expect(source).toContain(`WHERE u."role" = 'owner'`);
    expect(source).toContain(`WHERE g."user_id" = u."id" AND g."role" = 'owner'`);
    // **`ensureOwnerExists` の昇格 SQL も今日どおりである。**
    expect(source).toContain(`UPDATE "_auth_users" SET "role" = 'owner' WHERE "id" = ?`);
  });
});
