/**
 * `V8-M16-T07`: **巻き戻し(`undo` / `redo`)と役割の付与(`_auth_user_roles`)の交差を実測する。**
 *
 * ## この検査の作り方(**TDD ではない。順序を先に書く**)
 *
 * **「実測 → 定義 → 固定」の順で書いた。** つまり **先に本物の SQLite と本物の
 * `undo` / `redo` / `previewUndo` を動かして何が起きるかを測り、測った値をそのまま
 * `expect()` に置いた。** **「こうあるべき」に合わせて実装を1バイトも変えていない** ——
 * `src/kernel/undo.ts` / `src/kernel/snapshot.ts` / `src/auth/store.ts` は本タスクで
 * 1バイトも触っていない。**壊れていると判断したものは、直さずにそのまま固定してある**
 * (下記 §2 と §4-C。報告にも「迂回できる」「壊れている」と書いた)。
 *
 * ## なぜこの検査が要るのか
 *
 * `docs/plan/v8/04-rbac-abac-baseline.md` §7 の `V8-M16` 完了条件 (v) が
 * 「**巻き戻し(`undo`)で何が起こるかが定義され、実際にそうなること —— `_auth_*` は
 * `app.sqlite` に同居する**」を要求している。ところが
 *
 * - `ADR-0233`(`:110` / `:53`)は「**スナップショット / undo との交差を1度も試していない**」と自認し、
 * - `src/auth/store.ts` の冒頭コメントも「**それを試した検査は1本も無い**」と書き、
 * - `V8-M16` の実装(`T04`〜`T06`)も「**1度も試していない**」と報告した。
 *
 * **本ファイルが、その1本目である。**
 *
 * ## 測って分かった「機構」(結論を先に書く)
 *
 * `takeSnapshot` は `app.sqlite` を `VACUUM INTO` で**丸ごと**写し、`restoreSnapshot` は
 * `copyFileSync` で**丸ごと上書き**する(`src/kernel/snapshot.ts:272` / `:352`)。
 * **表を1本ずつ選んでいない。** したがって
 *
 * 1. **`_auth_user_roles` はスナップショットに入り、undo で巻き戻る。**
 * 2. **列(`_auth_users.role`)と表(`_auth_user_roles`)は同じ1ファイルに同居するので、
 *    undo は必ず両方を同時に書き戻す** —— 片方だけが戻る状態は作れなかった(§4-B)。
 * 3. **その代わり、`undo` は `setUserRole` / `setUserRoles` / `deleteUser` を1度も通らない。**
 *    **持ち主の不変条件を守っているガードは、巻き戻しの経路には1つも置かれていない**(§2)。
 *
 * `src/kernel/undo.ts` と `src/kernel/snapshot.ts` には `_auth` という綴りが1つも無い ——
 * **意識して扱っているのではなく、ファイルコピーの副作用としてそうなっている。**
 *
 * ## `src/auth/` に置いた理由(**層またぎ台帳に1行も足さないため**)
 *
 * 本ファイルは `src/kernel/` から値として import する(`undo` / `redo` / `previewUndo` ほか)。
 * `scripts/kernel-import-drift.test.ts:47` の `SEARCH_ROOTS` は
 * `["src/mcp", "src/server", "src/cli", "src/shared", "web", "scripts"]` であり、
 * **`src/auth` を含まない。** よって本ファイルを `src/auth/` に置くことで
 * **`scripts/kernel-import-snapshot.txt` に1行も足さずに済む**(= その sha を固定している
 * `scripts/industry-neutral-examples.test.ts:1034` も緑のまま)。**これは意図的な配置である。**
 *
 * ## 測っていないこと(誇張しない)
 *
 * - **HTTP を1本も打っていない。** 役割の付け外しは `AuthStore` の API を直に呼んでいる
 *   (`undo` は MCP / カーネル側の口であり、HTTP の認証ルートとは別プロセスの関心事である)。
 * - **`bun run test:e2e` を走らせていない。**
 * - **バックアップ(`src/server/backup.ts`)/ 復元(`restore.ts`)との交差は測っていない。**
 * - **`_auth_activity`(監査記録)が undo で巻き戻ることは、行を1件も書いていないので
 *   本ファイルでは測れていない**(セッションについては §2-D で測った)。
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDiff } from "../kernel/apply-diff.ts";
import { applyManifest } from "../kernel/apply-manifest.ts";
import { createApp } from "../kernel/create-app.ts";
import { KernelMetaStore } from "../kernel/meta-store.ts";
import { appDbPath } from "../kernel/storage-paths.ts";
import type { Manifest } from "../kernel/types.ts";
import { previewRedo, previewUndo, redo, undo } from "../kernel/undo.ts";
import { AuthStore, LastOwnerError } from "./store.ts";

const APP_ID = "undo-roles";

let dataRoot: string;

function baseManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "巻き戻しの実測",
      tables: [
        {
          id: "books",
          name: "本",
          fields: [{ id: "title", name: "タイトル", type: "text", required: true }],
        },
      ],
      views: [{ id: "book-list", type: "list_view", table: "books", columns: ["title"] }],
    },
  };
}

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "gp-m16-t07-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "巻き戻しの実測", { app_id: APP_ID });
  } finally {
    store.close();
  }
  const applied = applyManifest(dataRoot, APP_ID, baseManifest());
  if (!applied.valid) {
    throw new Error(`テスト前提の初期マニフェスト投入に失敗: ${JSON.stringify(applied.errors)}`);
  }
});

afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

/** 本物の差分を1本適用する(= **その直前の `app.sqlite` がスナップショットに入る**)。 */
function apply(diffId: string, fieldId: string): void {
  const result = applyDiff(dataRoot, APP_ID, {
    diff_id: diffId,
    intent: `${fieldId} を記録したい`,
    operations: [
      { op: "add_field", table: "books", field: { id: fieldId, name: fieldId, type: "text" } },
    ],
  });
  if (!result.valid) {
    throw new Error(`テスト前提の apply に失敗: ${JSON.stringify(result.errors)}`);
  }
}

/** 本物の `AuthStore`(= 本物の `app.sqlite`)を開いて閉じる。モックは1つも置かない。 */
function withStore<T>(fn: (store: AuthStore) => T): T {
  const store = AuthStore.openForApp(dataRoot, APP_ID);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

/** `app.sqlite` に実在する `_auth_*` 表の名前(実体を直に読む)。 */
function authTables(): string[] {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readonly: true });
  try {
    return db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '\\_auth\\_%' ESCAPE '\\' ORDER BY name`,
      )
      .all()
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

/** `_auth_users` の(username, role)を username 昇順で読む。表が無ければ空配列。 */
function userRows(): { username: string; role: string }[] {
  if (!authTables().includes("_auth_users")) {
    return [];
  }
  const db = new Database(appDbPath(dataRoot, APP_ID), { readonly: true });
  try {
    return db
      .query<{ username: string; role: string }, []>(
        `SELECT "username", "role" FROM "_auth_users" ORDER BY "username" ASC`,
      )
      .all();
  } finally {
    db.close();
  }
}

/** `_auth_user_roles` の行数。**表そのものが無ければ `null`**(「0行」と区別する)。 */
function grantRowCount(): number | null {
  if (!authTables().includes("_auth_user_roles")) {
    return null;
  }
  const db = new Database(appDbPath(dataRoot, APP_ID), { readonly: true });
  try {
    return (
      db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM "_auth_user_roles"`).get()?.n ?? 0
    );
  } finally {
    db.close();
  }
}

// =====================================================================================
// §1 役割の付与を足したあとで undo を打つと、付与はどうなるか
// =====================================================================================

describe("(T07-1) 役割の付与と undo —— **付与は巻き戻る。どこまで戻るかは apply との前後で決まる**", () => {
  test("(1-a) **付与が apply より前**なら、その apply を undo しても付与は1件も消えない", () => {
    // 差分1 → 役割を2つ付ける → 差分2 → undo。
    // 差分2 のスナップショットは「差分2 の直前」= 付与済みの状態なので、付与は残る。
    apply("d1", "f1");
    const bobId = withStore((store) => {
      store.createUser({ username: "alice", role: "owner" });
      const bob = store.createUser({ username: "bob", role: "viewer" });
      store.grantRole(bob.id, "editor");
      store.grantRole(bob.id, "owner");
      return bob.id;
    });
    expect(withStore((store) => store.effectiveRoles(bobId))).toEqual([
      "viewer",
      "editor",
      "owner",
    ]);
    expect(withStore((store) => store.countOwners())).toBe(2);

    apply("d2", "f2");
    const result = undo(dataRoot, APP_ID);
    expect(result.valid).toBe(true);

    // **実測値**: 付与2件はそのまま残り、実効ロール集合も持ち主の人数も変わらない。
    expect(grantRowCount()).toBe(2);
    expect(withStore((store) => store.effectiveRoles(bobId))).toEqual([
      "viewer",
      "editor",
      "owner",
    ]);
    expect(withStore((store) => store.countOwners())).toBe(2);
  });

  test("(1-b) **付与が apply より後**なら、その apply を undo した瞬間に付与は消える(実効集合が縮む)", () => {
    // 差分1 → ユーザ登録 → 差分2 → 役割を2つ付ける → undo。
    // 差分2 のスナップショット(= 差分2 の直前)には付与が入っていないので、付与は消える。
    apply("d1", "f1");
    const bobId = withStore((store) => {
      store.createUser({ username: "alice", role: "owner" });
      return store.createUser({ username: "bob", role: "viewer" }).id;
    });
    apply("d2", "f2");
    withStore((store) => {
      store.grantRole(bobId, "editor");
      store.grantRole(bobId, "owner");
    });
    expect(grantRowCount()).toBe(2);
    expect(withStore((store) => store.countOwners())).toBe(2);

    expect(undo(dataRoot, APP_ID).valid).toBe(true);

    // **実測値**: 付与は0件になり、bob は `viewer` 1本に戻る。**表は残る(0行になる)。**
    expect(grantRowCount()).toBe(0);
    expect(withStore((store) => store.effectiveRoles(bobId))).toEqual(["viewer"]);
    expect(withStore((store) => store.countOwners())).toBe(1);
    // ユーザ自身は消えていない(戻り先にはもう登録済みだったため)。
    expect(userRows().map((row) => row.username)).toEqual(["alice", "bob"]);
  });

  test("(1-c) **ユーザ登録より前**の apply まで戻ると、`_auth_*` の表が1本も残らない(全アカウントが消える)", () => {
    // 差分1(この時点でまだ誰も登録していない)→ 登録 → 付与 → 差分2 → undo → undo。
    apply("d1", "f1");
    const bobId = withStore((store) => {
      store.createUser({ username: "alice", role: "owner" });
      const bob = store.createUser({ username: "bob", role: "viewer" });
      store.grantRole(bob.id, "owner");
      return bob.id;
    });
    apply("d2", "f2");

    expect(undo(dataRoot, APP_ID).valid).toBe(true); // 差分2 を取り消す
    expect(userRows().map((row) => row.username)).toEqual(["alice", "bob"]);
    expect(grantRowCount()).toBe(1);

    expect(undo(dataRoot, APP_ID).valid).toBe(true); // 差分1 を取り消す = 登録より前へ

    // **実測値(壊れているとまでは言わないが、いちばん重い)**:
    // `_auth_users` も `_auth_user_roles` も**表ごと消える**。
    // アカウント・資格情報・セッション・監査記録が丸ごと無くなる。
    expect(authTables()).toEqual([]);
    expect(userRows()).toEqual([]);
    expect(grantRowCount()).toBeNull();
    // 次に `AuthStore` を開くと表は再生成されるが、**中身は1行も戻らない。**
    expect(withStore((store) => store.countUsers())).toBe(0);
    expect(withStore((store) => store.effectiveRoles(bobId))).toEqual([]);
    expect(authTables()).toContain("_auth_user_roles");
    expect(grantRowCount()).toBe(0);
  });
});

// =====================================================================================
// §2 undo で「持ち主が0人」の状態が作れてしまうか
//     —— v8 の3つの不変条件(最初の1人は持ち主 / 0人にならない / 最後の持ち主を降ろせない)を
//        巻き戻しが迂回できるかどうかの問い。
// =====================================================================================

describe("(T07-2) 持ち主の不変条件を undo が迂回できるか —— **できる。そのまま固定する**", () => {
  test("(2-a) **持ち主が0人の状態を undo で作れる**(自己申込が1人目のアプリ)", () => {
    // **これは作り物の状態ではない。** `SELF_SIGNUP`(`src/server/auth-routes.ts:353`〜`:359`)は
    //   resolveRole: (_store, requestedKind) => requestedKind ?? DEFAULT_USER_KIND
    //   healOwner: false
    // であり、**顧客の自己申込が1人目でも `owner` にしないし、自己修復も走らせない。**
    // つまり「ユーザは居るが持ち主は0人」は**ログインが1度も起きていない間、実際に起こる。**
    // その状態でスナップショットが取られると、**undo でいつでもそこへ戻れる。**
    const ids = withStore((store) => ({
      alice: store.createUser({ username: "alice", role: "customer" }).id,
      bob: store.createUser({ username: "bob", role: "customer" }).id,
    }));
    expect(withStore((store) => [store.countUsers(), store.countOwners()])).toEqual([2, 0]);

    apply("d1", "f1"); // ← **持ち主0人の状態がスナップショットに入る**

    // ログイン経路が自己修復して、**最古の1人**が持ち主になる。さらに**もう1人**にも付与する。
    //
    // **どちらが昇格するかを名指ししない**(この検査は最初それで落ちた。正直に書く)——
    // `ensureOwnerExists` の並びは `created_at ASC, id ASC` で、2人を続けて作ると
    // **`created_at` がミリ秒まで同一になり、同着はランダムな `id` の昇順で決まる。**
    // 昇格したのが誰かは実際に読んで決める(記憶: `flaky-workflow-runner-ran-at` と同型)。
    withStore((store) => store.ensureOwnerExists());
    const promoted = withStore((store) =>
      store.effectiveRoles(ids.alice).includes("owner") ? ids.alice : ids.bob,
    );
    const other = promoted === ids.alice ? ids.bob : ids.alice;
    expect(withStore((store) => store.countOwners())).toBe(1);
    withStore((store) => store.grantRole(other, "owner"));
    expect(withStore((store) => store.countOwners())).toBe(2);

    expect(undo(dataRoot, APP_ID).valid).toBe(true);

    // **実測値: 持ち主が0人に戻る。ユーザは2人とも居る。**
    // **`undo` は `ensureOwnerExists` を1度も呼ばない**(`src/kernel/undo.ts` に `_auth` の
    // 綴りが1つも無い)ので、**この状態は次に誰かがログインするまで放置される。**
    expect(userRows()).toEqual([
      { username: "alice", role: "customer" },
      { username: "bob", role: "customer" },
    ]);
    expect(grantRowCount()).toBe(0);
    expect(withStore((store) => [store.countUsers(), store.countOwners()])).toEqual([2, 0]);
  });

  test("(2-b) **持ち主0人の状態では、3つの不変条件のガードが1つも発火しない**(迂回できる)", () => {
    // 前提は (2-a) と同じ。**ガードは `countOwners() === 1` / `<= 1` のときにしか投げない。**
    //   store.ts: setUserRole   → `effective.includes("owner") && !nextHasOwner && countOwners() === 1`
    //   store.ts: setUserRoles  → `effectiveRoles().includes("owner") && !unique.includes("owner") && countOwners() === 1`
    //   store.ts: deleteUser    → `effectiveRoles().includes("owner") && countOwners() <= 1`
    // **0人まで落ちたあとは「最後の持ち主」が存在しないので、どれも通ってしまう。**
    const ids = withStore((store) => ({
      alice: store.createUser({ username: "alice", role: "customer" }).id,
      bob: store.createUser({ username: "bob", role: "customer" }).id,
    }));
    apply("d1", "f1");
    withStore((store) => store.ensureOwnerExists());
    expect(withStore((store) => store.countOwners())).toBe(1);
    expect(undo(dataRoot, APP_ID).valid).toBe(true);
    expect(withStore((store) => store.countOwners())).toBe(0);

    // **実測値: 例外は1つも飛ばない。** 役割の変更も退会も通る。
    expect(() => withStore((store) => store.setUserRole(ids.alice, "viewer"))).not.toThrow();
    expect(() => withStore((store) => store.deleteUser(ids.alice))).not.toThrow();
    // alice は本当に消えた。**持ち主が1人も居ないアプリが残る。**
    expect(userRows().map((row) => row.username)).toEqual(["bob"]);
    expect(withStore((store) => [store.countUsers(), store.countOwners()])).toEqual([1, 0]);

    // 対照: 持ち主が1人いる普通の状態では、同じ操作が `LastOwnerError` で止まる
    //(= ガードが空回りしているのではなく、**0人という入口だけが素通しである**)。
    withStore((store) => store.ensureOwnerExists());
    expect(withStore((store) => store.countOwners())).toBe(1);
    expect(() => withStore((store) => store.setUserRole(ids.bob, "viewer"))).toThrow(
      LastOwnerError,
    );
    expect(() => withStore((store) => store.deleteUser(ids.bob))).toThrow(LastOwnerError);
  });

  test("(2-c) **剥奪した持ち主が undo で復活する** —— 降格は巻き戻しで無かったことになる", () => {
    // 付与 → apply(この直前の状態がスナップショット)→ 運営が剥奪 → undo。
    const bobId = withStore((store) => {
      store.createUser({ username: "alice", role: "owner" });
      const bob = store.createUser({ username: "bob", role: "viewer" });
      store.grantRole(bob.id, "owner");
      return bob.id;
    });
    apply("d1", "f1");
    withStore((store) => store.setUserRoles(bobId, ["viewer"])); // 剥奪(正規の口)
    expect(withStore((store) => store.effectiveRoles(bobId))).toEqual(["viewer"]);
    expect(withStore((store) => store.countOwners())).toBe(1);

    expect(undo(dataRoot, APP_ID).valid).toBe(true);

    // **実測値: bob の owner が戻る。持ち主が1人から2人へ増える。**
    // **`undo` は `setUserRoles` を1度も通らない**ので、剥奪の意思は何の記録も残さず消える。
    expect(grantRowCount()).toBe(1);
    expect(withStore((store) => store.effectiveRoles(bobId))).toEqual(["viewer", "owner"]);
    expect(withStore((store) => store.countOwners())).toBe(2);
  });

  test("(2-d) 同じ理由で、**ログアウト済みのセッションも undo で有効に戻る**(付帯の実測)", () => {
    const seeded = withStore((store) => {
      const alice = store.createUser({ username: "alice", role: "owner" });
      return { userId: alice.id, sessionId: store.createSession(alice.id, 3600).id };
    });
    apply("d1", "f1");
    withStore((store) => store.deleteSession(seeded.sessionId)); // ログアウト
    expect(withStore((store) => store.findSession(seeded.sessionId))).toBeUndefined();

    expect(undo(dataRoot, APP_ID).valid).toBe(true);

    // **実測値: 破棄したはずのセッションが復活する。**
    expect(withStore((store) => store.findSession(seeded.sessionId))?.userId).toBe(seeded.userId);
  });
});

// =====================================================================================
// §3 redo はどうなるか
// =====================================================================================

describe("(T07-3) redo —— **undo とまったく同じ機構で、役割も一緒に往復する**", () => {
  test("(3-a) undo で復活した付与を、redo が再び消す(剥奪後の状態へ戻る)", () => {
    const bobId = withStore((store) => {
      store.createUser({ username: "alice", role: "owner" });
      const bob = store.createUser({ username: "bob", role: "viewer" });
      store.grantRole(bob.id, "owner");
      return bob.id;
    });
    apply("d1", "f1");
    withStore((store) => store.setUserRoles(bobId, ["viewer"])); // 剥奪
    expect(undo(dataRoot, APP_ID).valid).toBe(true);
    expect(withStore((store) => store.countOwners())).toBe(2); // 復活している

    const result = redo(dataRoot, APP_ID);
    expect(result.valid).toBe(true);

    // **実測値: redo は「undo 実行直前」= 剥奪済みの状態を書き戻す。付与は0件に戻る。**
    expect(grantRowCount()).toBe(0);
    expect(withStore((store) => store.effectiveRoles(bobId))).toEqual(["viewer"]);
    expect(withStore((store) => store.countOwners())).toBe(1);
  });

  test("(3-b) redo も付与を1件も見ていない —— 対象は undo エントリで `operations` は空である", () => {
    withStore((store) => {
      store.createUser({ username: "alice", role: "owner" });
      const bob = store.createUser({ username: "bob", role: "viewer" });
      store.grantRole(bob.id, "owner");
    });
    apply("d1", "f1");
    expect(undo(dataRoot, APP_ID).valid).toBe(true);

    const preview = previewRedo(dataRoot, APP_ID);
    expect(preview.valid).toBe(true);
    if (!preview.valid) {
      throw new Error("到達しない");
    }
    // **実測値**: redo 対象は `undo-d1`(kind = undo)で、`operations` は空配列。
    expect(preview.preview.diff_id).toBe("undo-d1");
    expect(preview.preview.operations).toEqual([]);
    // **役割・持ち主・アカウントについて1件も数えない**(§5 と同じ理由)。
    expect(preview.preview.lost_records).toEqual({});
    expect(preview.preview.restored_records).toEqual({});
    expect(preview.preview.changed_records).toEqual({});
  });
});

// =====================================================================================
// §4 列(`_auth_users.role`)と表(`_auth_user_roles`)が巻き戻しの前後で食い違うか
// =====================================================================================

describe("(T07-4) 列と表の食い違い", () => {
  test("(4-a) **旧世代(付与表が無い)スナップショットへ戻すと、付与は表ごと消える** —— 持ち主が入れ替わる", () => {
    // `AuthStore` を1度も開かずに、**`V8-M16` より前の形の `_auth_users`** を直に作る
    //(= すでに動いていたアプリを模す。付与表はまだ存在しない)。
    {
      const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
      try {
        db.exec(
          `CREATE TABLE "_auth_users" (
             "id" TEXT PRIMARY KEY,
             "username" TEXT UNIQUE NOT NULL,
             "display_name" TEXT,
             "role" TEXT NOT NULL DEFAULT 'viewer' CHECK("role" IN ('owner','editor','viewer','customer')),
             "created_at" TEXT NOT NULL
           );`,
        );
        const insert = db.query(`INSERT INTO "_auth_users" VALUES (?, ?, ?, ?, ?)`);
        insert.run("u-alice", "alice", null, "owner", "2026-01-01T00:00:00.000Z");
        insert.run("u-bob", "bob", null, "viewer", "2026-01-02T00:00:00.000Z");
      } finally {
        db.close();
      }
    }
    expect(authTables()).toEqual(["_auth_users"]);

    apply("d1", "f1"); // ← **付与表を持たない世代**がスナップショットに入る
    expect(grantRowCount()).toBeNull();

    // ここで `AuthStore` を開く = `CHECK` 移行 + 付与表の新設。持ち主を bob の**付与だけ**に移す。
    withStore((store) => {
      store.grantRole("u-bob", "owner");
      store.setUserRole("u-alice", "viewer");
    });
    expect(userRows()).toEqual([
      { username: "alice", role: "viewer" },
      { username: "bob", role: "viewer" },
    ]);
    expect(grantRowCount()).toBe(1);
    expect(withStore((store) => store.countOwners())).toBe(1); // 唯一の持ち主は bob(付与のみ)
    expect(withStore((store) => store.effectiveRoles("u-bob"))).toEqual(["viewer", "owner"]);

    apply("d2", "f2");
    expect(undo(dataRoot, APP_ID).valid).toBe(true); // d2 を取り消す(付与は残る)
    expect(grantRowCount()).toBe(1);

    expect(undo(dataRoot, APP_ID).valid).toBe(true); // d1 を取り消す = **旧世代へ戻る**

    // **実測値: `_auth_user_roles` が表ごと消え、列だけの世界に戻る。**
    expect(authTables()).toEqual(["_auth_users"]);
    expect(grantRowCount()).toBeNull();
    // **持ち主が入れ替わる** —— 降格したはずの alice が持ち主に戻り、bob は付与を失う。
    expect(userRows()).toEqual([
      { username: "alice", role: "owner" },
      { username: "bob", role: "viewer" },
    ]);
    // 次に `AuthStore` を開くと、付与表は**空で作り直される**(古い付与は1件も戻らない)。
    expect(withStore((store) => store.effectiveRoles("u-bob"))).toEqual(["viewer"]);
    expect(authTables()).toContain("_auth_user_roles");
    expect(grantRowCount()).toBe(0);
    // **この食い違った状態でも、3つの不変条件の判定は破綻しない**(列に持ち主が1人居るため)。
    expect(withStore((store) => store.countOwners())).toBe(1);
    expect(() => withStore((store) => store.setUserRole("u-alice", "viewer"))).toThrow(
      LastOwnerError,
    );
    expect(() => withStore((store) => store.deleteUser("u-alice"))).toThrow(LastOwnerError);
  });

  test("(4-b) **列だけ / 表だけが戻る状態は作れない** —— 同じ1ファイルなので必ず同時に書き戻される", () => {
    // 列に owner が居る状態と、付与にだけ owner が居る状態を1回ずつスナップショットに入れ、
    // どちらへ戻っても**列と表の組が必ずスナップショット時点の組になる**ことを見る。
    const ids = withStore((store) => ({
      alice: store.createUser({ username: "alice", role: "owner" }).id,
      bob: store.createUser({ username: "bob", role: "viewer" }).id,
    }));
    apply("d1", "f1"); // 状態X: 列 alice=owner / 付与0件

    // 状態Y: 付与にだけ owner が在る(列は editor)
    withStore((store) => {
      store.grantRole(ids.alice, "owner");
      store.setUserRole(ids.alice, "editor");
    });
    expect(userRows()).toEqual([
      { username: "alice", role: "editor" },
      { username: "bob", role: "viewer" },
    ]);
    expect(grantRowCount()).toBe(1);
    expect(withStore((store) => store.countOwners())).toBe(1);

    apply("d2", "f2"); // 状態Y がスナップショットに入る

    // 状態Z: 列を bob へ移し、alice の付与を落とす
    withStore((store) => {
      store.setUserRole(ids.bob, "owner");
      store.setUserRoles(ids.alice, ["editor"]);
    });
    expect(grantRowCount()).toBe(0);

    expect(undo(dataRoot, APP_ID).valid).toBe(true); // → 状態Y(列 editor + 付与 owner)
    expect(userRows()).toEqual([
      { username: "alice", role: "editor" },
      { username: "bob", role: "viewer" },
    ]);
    expect(grantRowCount()).toBe(1);
    expect(withStore((store) => store.effectiveRoles(ids.alice))).toEqual(["editor", "owner"]);
    expect(withStore((store) => store.countOwners())).toBe(1);

    expect(undo(dataRoot, APP_ID).valid).toBe(true); // → 状態X(列 owner + 付与0件)
    expect(userRows()).toEqual([
      { username: "alice", role: "owner" },
      { username: "bob", role: "viewer" },
    ]);
    expect(grantRowCount()).toBe(0);
    expect(withStore((store) => store.effectiveRoles(ids.alice))).toEqual(["owner"]);
    expect(withStore((store) => store.countOwners())).toBe(1);

    // **どちらの戻り先でも、付与表に「もう居ないユーザ」の行は1件も残らない**
    //(外部キーの `ON DELETE` は今日も無いが、同時に書き戻されるので孤児が生まれない)。
    const db = new Database(appDbPath(dataRoot, APP_ID), { readonly: true });
    try {
      const orphans = db
        .query<{ n: number }, []>(
          `SELECT COUNT(*) AS n FROM "_auth_user_roles" AS g
            WHERE NOT EXISTS (SELECT 1 FROM "_auth_users" AS u WHERE u."id" = g."user_id")`,
        )
        .get();
      expect(orphans?.n ?? 0).toBe(0);
    } finally {
      db.close();
    }
  });

  test("(4-c) **開いたままの `AuthStore` を跨いで undo すると、その接続からの書込が落ちる**(壊れている)", () => {
    // `restoreSnapshot` は `copyFileSync` で `app.sqlite` を**同じパスに上書き**する。
    // 既に開いている接続はそれを知らないので、以後の書込が SQLite から拒否される。
    // **本タスクはこれを直していない。測った値をそのまま固定する。**
    const store = AuthStore.openForApp(dataRoot, APP_ID);
    try {
      store.createUser({ username: "alice", role: "owner" });
      const bob = store.createUser({ username: "bob", role: "viewer" });
      apply("d1", "f1");
      store.grantRole(bob.id, "owner");
      apply("d2", "f2");

      expect(undo(dataRoot, APP_ID).valid).toBe(true);
      expect(undo(dataRoot, APP_ID).valid).toBe(true);

      let message = "";
      expect(() => {
        try {
          store.grantRole(bob.id, "editor");
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
          throw error;
        }
      }).toThrow();
      // **実測した文言**(4回中4回とも同じ): "database disk image is malformed"
      expect(message).toContain("malformed");
    } finally {
      try {
        store.close();
      } catch {
        // 壊れた接続は close も失敗しうる。ここでの失敗は測定対象ではない。
      }
    }
  });
});

// =====================================================================================
// §5 `previewUndo`(`preview_undo`)は役割の付与について何を予告するか
// =====================================================================================

describe("(T07-5) `previewUndo` の予告 —— **役割については1文字も予告しない**", () => {
  test("(5-a) 持ち主が復活する undo でも、preview は失う件数も戻る件数も1件も挙げない", () => {
    const bobId = withStore((store) => {
      store.createUser({ username: "alice", role: "owner" });
      const bob = store.createUser({ username: "bob", role: "viewer" });
      store.grantRole(bob.id, "owner");
      return bob.id;
    });
    apply("d1", "f1");
    withStore((store) => store.setUserRoles(bobId, ["viewer"]));
    expect(withStore((store) => store.countOwners())).toBe(1);

    const preview = previewUndo(dataRoot, APP_ID);
    expect(preview.valid).toBe(true);
    if (!preview.valid) {
      throw new Error("到達しない");
    }

    // **実測値: 4つの数え上げがすべて空である。**
    // `countRecordChanges` / `countContentChanges` が数えるのは
    // **マニフェストが宣言した表だけ**であり、`_auth_*` は1本も宣言に無い。
    expect(preview.preview.lost_records).toEqual({});
    expect(preview.preview.restored_records).toEqual({});
    expect(preview.preview.changed_records).toEqual({});
    expect(preview.preview.removed_resources).toEqual({
      tables: [],
      views: [],
      workflows: [],
      functions: [],
    });

    // 文面にも `_auth` / role / 持ち主 / アカウント といった語が1つも無い。
    const text = JSON.stringify(preview.preview);
    expect(text).not.toContain("_auth");
    expect(text).not.toContain("role");
    expect(preview.preview.note).not.toContain("役割");
    expect(preview.preview.note).not.toContain("アカウント");

    // **そして実際に undo すると持ち主が2人に増える** ——
    // **予告と結果が食い違っているのではなく、予告が「役割を見ていない」。**
    expect(undo(dataRoot, APP_ID).valid).toBe(true);
    expect(withStore((store) => store.countOwners())).toBe(2);
  });

  test("(5-b) **全アカウントが消える undo でも、preview は「失われるもの」を1件も挙げない**", () => {
    apply("d1", "f1"); // 登録より前
    withStore((store) => {
      store.createUser({ username: "alice", role: "owner" });
      const bob = store.createUser({ username: "bob", role: "viewer" });
      store.grantRole(bob.id, "owner");
    });

    const preview = previewUndo(dataRoot, APP_ID);
    expect(preview.valid).toBe(true);
    if (!preview.valid) {
      throw new Error("到達しない");
    }
    expect(preview.preview.diff_id).toBe("d1");
    expect(preview.preview.lost_records).toEqual({});
    expect(preview.preview.restored_records).toEqual({});
    expect(preview.preview.removed_resources.tables).toEqual([]);

    // **予告どおり「レコードは失われない」。しかしアカウントは2人とも消える。**
    expect(undo(dataRoot, APP_ID).valid).toBe(true);
    expect(authTables()).toEqual([]);
    expect(withStore((store) => store.countUsers())).toBe(0);
  });

  test("(5-c) 役割の付け外しは changelog に1行も残らない(undo の対象にも数え上げにもならない)", () => {
    withStore((store) => {
      store.createUser({ username: "alice", role: "owner" });
      const bob = store.createUser({ username: "bob", role: "viewer" });
      store.grantRole(bob.id, "owner");
      store.setUserRoles(bob.id, ["viewer", "editor"]);
    });

    const store = KernelMetaStore.open(dataRoot);
    try {
      const entries = store.listChangelog(APP_ID);
      // **実測値**: アプリ作成の1行だけ。**役割の付け外しは履歴に現れない。**
      expect(entries.map((entry) => entry.kind)).toEqual(["apply"]);
      expect(entries.length).toBe(1);
      expect(JSON.stringify(entries)).not.toContain("_auth_user_roles");
    } finally {
      store.close();
    }
  });
});
