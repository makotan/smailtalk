/**
 * `V8-M2-T07`: **巻き戻し(`undo` / `redo`)と招待(`_auth_invitations`)の交差を実測する。**
 *
 * ## この検査の作り方(**TDD ではない。順序を先に書く**)
 *
 * **「実測 → 定義 → 固定」の順で書いた**(先例 `src/auth/undo-role-grants.test.ts` と同じ作法)。
 * **先に本物の SQLite と本物の `undo` / `redo` / `previewUndo` を動かして何が起きるかを測り、
 * 測った値をそのまま `expect()` に置いた。** **「こうあるべき」に合わせて実装を1バイトも
 * 変えていない** —— `src/kernel/undo.ts` / `src/kernel/snapshot.ts` は本タスクで1バイトも
 * 触っていない。**壊れていると判断したものは、直さずにそのまま固定してある。**
 *
 * ## なぜこの検査が要るのか
 *
 * **`ADR-0336` 限定22 が「`undo` の帰結を実測で固定する。機構に1バイトも書かない」を課している。**
 * **`ADR-0303`(7本目)は「交差面が1本増える」ことへの釣り合いとして、この実測を要求した。**
 * **【禁止の履行】これを「だから交差面は増えていない」と書かない** —— **増えている。
 * 測る手段を同時に用意しただけである。**
 *
 * ## 機構(先例が測った結論をそのまま引く)
 *
 * `takeSnapshot` は `app.sqlite` を `VACUUM INTO` で**丸ごと**写し、`restoreSnapshot` は
 * `copyFileSync` で**丸ごと上書き**する。**表を1本ずつ選んでいない。**
 * `src/kernel/undo.ts` と `src/kernel/snapshot.ts` には `_auth` という綴りが1つも無い ——
 * **意識して扱っているのではなく、ファイルコピーの副作用としてそうなっている。**
 *
 * ## **【禁止の履行】「巻き戻しは実際には起きない」と書かない**
 *
 * **`undo` は HTTP(`POST /api/apps/:app_id/undo`)と MCP(`undo`)の両方から今日到達でき、
 * MCP 側は `app` × `write` だけで通る**(`src/mcp/actor-authz.test.ts` の自認)。
 * **すなわち AI は招待を1件も読めないのに、消したり復活させたりできる。**
 *
 * ## **【禁止の履行】「`_auth_user_roles` と同じだから問題ない」と書かない**
 *
 * **役割の付与は「消えても運営者が付け直せる」が、招待は消えたことに運営者が気づく手段が無い**
 * (`previewUndo` も changelog も無言である。下の §3 が実測する)。
 * **同じ機構だが、気づけなさの度合いが違う。**
 *
 * ## `src/auth/` に置いた理由(**層またぎ台帳に1行も足さないため**)
 *
 * 本ファイルは `src/kernel/` から値として import する。`scripts/kernel-import-drift.test.ts` の
 * `SEARCH_ROOTS` は `src/auth` を含まないので、`src/auth/` に置けば
 * `scripts/kernel-import-snapshot.txt` に1行も足さずに済む(`undo-role-grants.test.ts` と
 * 同じ理由の、同じ配置である)。
 *
 * ## 測っていないこと(誇張しない)
 *
 * - **HTTP を1本も打っていない**(招待の発行は `AuthStore` の API を直に呼んでいる)。
 * - **開いたままの接続を跨いだ undo の後の挙動を測っていない**(先例 (4-c) の
 *   `"database disk image is malformed"`)。**その状態で招待に何が起きるかは未知である。**
 * - **バックアップ / 復元との交差は測っていない。**
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDiff } from "../kernel/apply-diff.ts";
import { applyManifest } from "../kernel/apply-manifest.ts";
import { createApp } from "../kernel/create-app.ts";
import { KernelMetaStore } from "../kernel/meta-store.ts";
import { appDbPath, appSnapshotsDir, snapshotDir } from "../kernel/storage-paths.ts";
import type { Manifest } from "../kernel/types.ts";
import { previewUndo, redo, undo } from "../kernel/undo.ts";
import { findUsableInvitation, INVITATION_REVOKED_PREFIX, invitationState } from "./invitations.ts";
import { AuthStore } from "./store.ts";

const APP_ID = "undo-invitations";

let dataRoot: string;

function baseManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "招待の巻き戻しの実測",
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
  dataRoot = mkdtempSync(join(tmpdir(), "gp-m2-t07-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "招待の巻き戻しの実測", { app_id: APP_ID });
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

/** 招待の行数。**表そのものが無ければ `null`**(「0行」と区別する)。 */
function invitationRowCount(): number | null {
  if (!authTables().includes("_auth_invitations")) {
    return null;
  }
  const db = new Database(appDbPath(dataRoot, APP_ID), { readonly: true });
  try {
    return (
      db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM "_auth_invitations"`).get()?.n ?? 0
    );
  } finally {
    db.close();
  }
}

/** 運営者を1人作る(招待を出す人)。 */
function seedOwner(): string {
  return withStore((store) => store.createUser({ username: "alice", role: "owner" }).id);
}

// =====================================================================================
// §1 発行した招待が undo で消える(**運営者は伝えたコードが使えないことを知れない**)
// =====================================================================================

describe("(T07-1) 発行 と undo", () => {
  test("(1-a) **発行が apply より前**なら、その apply を undo しても招待は1件も消えない", () => {
    apply("d1", "f1");
    const ownerId = seedOwner();
    const code = withStore(
      (store) => store.issueInvitation({ username: "bob", role: "editor", issuedBy: ownerId }).code,
    );
    apply("d2", "f2");

    expect(undo(dataRoot, APP_ID).valid).toBe(true);

    // **実測値**: 招待は残り、今日も使える。
    expect(invitationRowCount()).toBe(1);
    expect(withStore((store) => findUsableInvitation(store, "bob", code)?.role)).toBe("editor");
  });

  test("(1-b) **発行が apply より後**なら、その apply の undo で招待は消える(表は残る)", () => {
    apply("d1", "f1");
    const ownerId = seedOwner();
    apply("d2", "f2");
    const code = withStore(
      (store) => store.issueInvitation({ username: "bob", role: "editor", issuedBy: ownerId }).code,
    );
    expect(invitationRowCount()).toBe(1);

    expect(undo(dataRoot, APP_ID).valid).toBe(true);

    // **実測値**: 招待は0件になり、**表は残る(0行になる)。**
    expect(invitationRowCount()).toBe(0);
    expect(withStore((store) => findUsableInvitation(store, "bob", code))).toBeUndefined();
    // **運営者に通知は1つも出ない。** 運営者はコードを伝えた後で、相手から「入れない」と
    // 言われるまで、招待が消えたことを知る手段が無い。
  });

  test("(1-c) **ユーザ登録より前**の apply まで戻ると、`_auth_*` が表ごと1本も残らない", () => {
    apply("d1", "f1"); // この時点でまだ誰も登録していない
    const ownerId = seedOwner();
    withStore((store) =>
      store.issueInvitation({ username: "bob", role: "editor", issuedBy: ownerId }),
    );
    expect(invitationRowCount()).toBe(1);

    expect(undo(dataRoot, APP_ID).valid).toBe(true);

    // **実測値**: `_auth_*` が1本も残らない(招待表ごと消える)。
    expect(authTables()).toEqual([]);
    expect(invitationRowCount()).toBeNull();
    // **次に開くと空で作り直される**(8本そろって、招待は0件)。
    expect(withStore((store) => store.listInvitations())).toEqual([]);
    expect(authTables()).toEqual([
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
});

// =====================================================================================
// §2 取り消した招待が undo で復活する(**運営者から見て、取り消しが効かなくなる唯一の経路**)
// =====================================================================================

describe("(T07-2) 取り消し と undo", () => {
  test("(2-a) **取り消した招待が undo で復活し、再び使えるようになる**(24時間以内なら)", () => {
    const ownerId = seedOwner();
    const code = withStore(
      (store) => store.issueInvitation({ username: "bob", role: "editor", issuedBy: ownerId }).code,
    );
    apply("d1", "f1"); // この直前の状態(= 取り消し前)がスナップショットに入る
    withStore((store) => store.revokeInvitation("bob"));
    expect(withStore((store) => findUsableInvitation(store, "bob", code))).toBeUndefined();

    expect(undo(dataRoot, APP_ID).valid).toBe(true);

    // **実測値**: 使用時刻が消え、**同じコードがまた通る。**
    expect(withStore((store) => store.findInvitation("bob")?.usedAt)).toBeNull();
    expect(withStore((store) => findUsableInvitation(store, "bob", code)?.role)).toBe("editor");
    // **`undo` は `revokeInvitation` を1度も通らない** —— 取り消しの意思は何の記録も
    // 残さずに消える(changelog にも `_auth_activity` にも1行も無い。下の (3-c))。
  });

  test("(2-b) 使用済みの印も同じ機構で戻る(`markInvitationUsed` を通らない)", () => {
    const ownerId = seedOwner();
    const code = withStore(
      (store) => store.issueInvitation({ username: "bob", role: "editor", issuedBy: ownerId }).code,
    );
    apply("d1", "f1");
    withStore((store) => store.markInvitationUsed("bob"));

    expect(undo(dataRoot, APP_ID).valid).toBe(true);

    expect(withStore((store) => findUsableInvitation(store, "bob", code))).toBeDefined();
    // **【この機構にとって有利な材料。丸めずに書く】** **「使用済みの印だけが戻って、その
    // 招待で作られたユーザ行は残る」という状態は構造的に作れない** —— 列も表も同じ1ファイルに
    // 同居しており、`restoreSnapshot` は丸ごと上書きするので必ず同時に書き戻される。
    // **したがって undo による二重登録は、この機構では起こらない。**
    // **ただし例外が1つある** —— 開いたままの接続を跨いで undo した後の挙動は測っていない。
  });

  test("(2-c) undo で復活しても **期限は元のままである**(戻るのは行であって時計ではない)", () => {
    const ownerId = seedOwner();
    const before = withStore((store) =>
      store.issueInvitation({ username: "bob", role: "editor", issuedBy: ownerId }),
    );
    apply("d1", "f1");
    withStore((store) => store.revokeInvitation("bob"));
    expect(undo(dataRoot, APP_ID).valid).toBe(true);

    // **実測値**: 期限も発行時刻もコードも、発行時の値そのままである。
    const after = withStore((store) => store.findInvitation("bob"));
    expect(after?.expiresAt).toBe(before.expiresAt);
    expect(after?.issuedAt).toBe(before.issuedAt);
    expect(after?.code).toBe(before.code);
    // **すなわち24時間を過ぎていれば、復活しても使えない。** **24時間以内なら使える。**
  });
});

// =====================================================================================
// §3 `redo` / `previewUndo` / changelog
// =====================================================================================

describe("(T07-3) redo と予告と履歴", () => {
  test("(3-a) `redo` は同じ機構で往復する(復活した招待をもう一度取り消し済みに戻す)", () => {
    const ownerId = seedOwner();
    const code = withStore(
      (store) => store.issueInvitation({ username: "bob", role: "editor", issuedBy: ownerId }).code,
    );
    apply("d1", "f1");
    withStore((store) => store.revokeInvitation("bob"));
    expect(undo(dataRoot, APP_ID).valid).toBe(true);
    expect(withStore((store) => findUsableInvitation(store, "bob", code))).toBeDefined();

    expect(redo(dataRoot, APP_ID).valid).toBe(true);

    // **実測値**: `redo` は「undo 実行直前」= 取り消し済みの状態を書き戻す。
    expect(withStore((store) => store.findInvitation("bob")?.usedAt)).not.toBeNull();
    expect(withStore((store) => findUsableInvitation(store, "bob", code))).toBeUndefined();
  });

  test("(3-b) **`previewUndo` は招待について1件も予告しない**", () => {
    apply("d1", "f1");
    const ownerId = seedOwner();
    withStore((store) =>
      store.issueInvitation({ username: "bob", role: "editor", issuedBy: ownerId }),
    );

    const preview = previewUndo(dataRoot, APP_ID);
    expect(preview.valid).toBe(true);
    if (!preview.valid) {
      throw new Error("到達しない");
    }

    // **実測値: 4つの数え上げがすべて空である。**
    // `countRecordChanges` / `countContentChanges` が数えるのは**マニフェストが宣言した表だけ**で
    // あり、`_auth_*` は1本も宣言に無い。
    expect(preview.preview.lost_records).toEqual({});
    expect(preview.preview.restored_records).toEqual({});
    expect(preview.preview.changed_records).toEqual({});
    expect(preview.preview.removed_resources).toEqual({
      tables: [],
      views: [],
      workflows: [],
      functions: [],
    });
    // 文面にも招待の語が1つも無い。
    const text = JSON.stringify(preview.preview);
    expect(text.includes("_auth")).toBe(false);
    expect(text.includes("invitation")).toBe(false);
    expect(preview.preview.note.includes("招待")).toBe(false);

    // **そして実際に undo すると、招待は表ごと消える** ——
    // **予告と結果が食い違っているのではなく、予告が「招待を見ていない」。**
    expect(undo(dataRoot, APP_ID).valid).toBe(true);
    expect(invitationRowCount()).toBeNull();
  });

  test("(3-c) 招待の発行・取り消しは changelog に1行も残らない", () => {
    const ownerId = seedOwner();
    withStore((store) => {
      store.issueInvitation({ username: "bob", role: "editor", issuedBy: ownerId });
      store.revokeInvitation("bob");
      store.issueInvitation({ username: "carol", role: "viewer", issuedBy: ownerId });
    });

    const store = KernelMetaStore.open(dataRoot);
    try {
      const entries = store.listChangelog(APP_ID);
      // **実測値**: アプリ作成の1行だけ。**招待の発行も取り消しも履歴に現れない。**
      expect(entries.map((entry) => entry.kind)).toEqual(["apply"]);
      // **表の名前を探す**(アプリ ID そのものは `undo-invitations` なので、
      // `"invitation"` という部分文字列だけを見ると必ず当たってしまう)。
      expect(JSON.stringify(entries).includes("_auth_invitations")).toBe(false);
      expect(JSON.stringify(entries).includes("bob")).toBe(false);
    } finally {
      store.close();
    }
    // **したがって「いつ誰が招待を出したか / 取り消したか」を後から履歴で追う道は無い。**
    // **`_auth_activity`(監査記録)にも1行も書いていない**(`ADR-0336` 限定11 =
    // コードを2つ目の場所に置かない)。
  });
});

// =====================================================================================
// §4 **`V19-M2-T03` の撃ち直し**(**区別が付くようになった今日、上の §2 / §3 の前提が変わった**)
//
// **なぜ足すのか**: **`V19-M2-T00` が、取り消しの印を「素の時刻ではない値」に変えた**
// (`ADR-0452` §Decision の案 (iv)。単位 `SV-G5`)。 **上の (2-a) / (2-b) / (3-a) は
// 今日も緑のままだが、この3本で使用時刻を見ている `expect` は **2つだけ** であり
// (`:249` の `toBeNull()` と `:309` の `not.toBeNull()`)、**どちらも値の形を1ミリも
// 見ていない**。 **すなわち「取り消し」と「使用」が入れ替わっても、この3本は赤くならない。**
// **§4 はそこを固定する** —— **上の3本の期待値は1つも書き換えていない**(消していない)。
//
// **【禁止の履行】「塞がった」と1文字も書かない。** **§4 が示すのは「**今日も起こる**」ことである。**
// **`src/kernel/undo.ts` / `src/kernel/snapshot.ts` は本タスクでも **1バイトも** 触っていない。**
//
// **作り方**: **上の §1〜§3 と同じ「実測 → 定義 → 固定」である**(TDD ではない)。
// **先に本物の `undo` / `redo` / スナップショットを動かして測り、測った値をそのまま
// `expect()` に置いた。** **実装を1バイトも変えていない。**
// =====================================================================================

/** その相手の招待の状態(3値)。**行が無ければ `"none"`**(3値のどれとも区別する)。 */
function stateOf(username: string): string {
  return withStore((store) => {
    const invitation = store.findInvitation(username);
    return invitation === undefined ? "none" : invitationState(invitation);
  });
}

/** その相手の使用時刻の**生の値**。**行が無い場合も `null`**(この §4 では行は必ず在る)。 */
function usedAtOf(username: string): string | null {
  return withStore((store) => store.findInvitation(username)?.usedAt ?? null);
}

/** 写しの名前の一覧。**`listSnapshots` を取り込むと上の検査の行番号が1行ずつ動くので、ここで直に読む。** */
function snapshotNames(): string[] {
  return readdirSync(appSnapshotsDir(dataRoot, APP_ID)).sort();
}

/**
 * **スナップショットの中**の招待の行を直に読む(**現在の `app.sqlite` ではない**)。
 *
 * `restoreSnapshot` を1度も呼ばずに、過去の写しの中身だけを見るための口である。
 */
function invitationRowInSnapshot(
  snapshotName: string,
  username: string,
): { code: string; used_at: string | null } | null {
  const db = new Database(join(snapshotDir(dataRoot, APP_ID, snapshotName), "app.sqlite"), {
    readonly: true,
  });
  try {
    return db
      .query<{ code: string; used_at: string | null }, [string]>(
        `SELECT "code", "used_at" FROM "_auth_invitations" WHERE "username" = ?`,
      )
      .get(username);
  } finally {
    db.close();
  }
}

describe("(V19-T03) 区別が付いた後の撃ち直し", () => {
  test("(4-a) **取り消した招待は undo で復活し、今日も再び使える**(上の (2-a) を、印の形まで見る形で撃ち直す)", () => {
    const ownerId = seedOwner();
    const code = withStore(
      (store) => store.issueInvitation({ username: "bob", role: "editor", issuedBy: ownerId }).code,
    );
    apply("d1", "f1"); // この直前の状態(= 取り消し前)がスナップショットに入る
    withStore((store) => store.revokeInvitation("bob"));

    // **(2-a) の時点には無かった区別**: 列は空ではなく、素の時刻でもない値が入っている。
    expect(usedAtOf("bob")?.startsWith(INVITATION_REVOKED_PREFIX)).toBe(true);
    expect(stateOf("bob")).toBe("revoked");
    expect(withStore((store) => findUsableInvitation(store, "bob", code))).toBeUndefined();

    expect(undo(dataRoot, APP_ID).valid).toBe(true);

    // **実測値(2026-09-18)**: 印は列ごと消え、**同じコードがまた通る。今日も起こる。**
    expect(usedAtOf("bob")).toBeNull();
    expect(stateOf("bob")).toBe("unused");
    expect(withStore((store) => findUsableInvitation(store, "bob", code)?.role)).toBe("editor");
  });

  test("(4-b) `redo` が書き戻すのは **取り消し済み** であって「使用済み」ではない(上の (3-a) の `expect` は両者を区別しない)", () => {
    const ownerId = seedOwner();
    const code = withStore(
      (store) => store.issueInvitation({ username: "bob", role: "editor", issuedBy: ownerId }).code,
    );
    apply("d1", "f1");
    withStore((store) => store.revokeInvitation("bob"));
    expect(undo(dataRoot, APP_ID).valid).toBe(true);
    expect(stateOf("bob")).toBe("unused");

    expect(redo(dataRoot, APP_ID).valid).toBe(true);

    // **実測値**: 3値のうち**取り消しの側**に戻る。**「使用済み」には化けない。**
    expect(stateOf("bob")).toBe("revoked");
    expect(usedAtOf("bob")?.startsWith(INVITATION_REVOKED_PREFIX)).toBe(true);
    expect(withStore((store) => findUsableInvitation(store, "bob", code))).toBeUndefined();
  });

  test("(4-c) 使用済みの印は undo で消え、`redo` では **使用済み** として戻る(取り消しに化けない)", () => {
    const ownerId = seedOwner();
    const code = withStore(
      (store) => store.issueInvitation({ username: "bob", role: "editor", issuedBy: ownerId }).code,
    );
    apply("d1", "f1");
    withStore((store) => store.markInvitationUsed("bob"));

    // **使用の印は素の時刻である**(取り消しの印と同じ列に、別の値域で入る)。
    expect(stateOf("bob")).toBe("used");
    expect(usedAtOf("bob")?.startsWith(INVITATION_REVOKED_PREFIX)).toBe(false);

    expect(undo(dataRoot, APP_ID).valid).toBe(true);
    expect(stateOf("bob")).toBe("unused");
    expect(withStore((store) => findUsableInvitation(store, "bob", code))).toBeDefined();

    expect(redo(dataRoot, APP_ID).valid).toBe(true);

    // **実測値**: 戻るのは**使用済み**の側である。**取り消し済みに化けない。**
    expect(stateOf("bob")).toBe("used");
    expect(usedAtOf("bob")?.startsWith(INVITATION_REVOKED_PREFIX)).toBe(false);
  });

  test("(4-d) **取り消した後にスナップショットが取られると、出し直しても取り消しの印はその中に残る**", () => {
    const ownerId = seedOwner();
    const first = withStore((store) =>
      store.issueInvitation({ username: "bob", role: "editor", issuedBy: ownerId }),
    );
    withStore((store) => store.revokeInvitation("bob"));
    apply("d1", "f1"); // **この apply が、取り消し済みの状態を丸ごと写す**
    const second = withStore((store) =>
      store.issueInvitation({ username: "bob", role: "editor", issuedBy: ownerId }),
    );

    // **現在のファイルからは読めない**(`V19-M2-T04` が撃った側。行は1本のままである)。
    expect(stateOf("bob")).toBe("unused");
    expect(usedAtOf("bob")).toBeNull();
    expect(second.code).not.toBe(first.code);

    // **しかしスナップショットの中には残っている。**
    const names = snapshotNames();
    expect(names).toEqual(["0001-d1"]);
    const row = invitationRowInSnapshot(names[0] ?? "", "bob");
    expect(row?.code).toBe(first.code);
    expect(row?.used_at?.startsWith(INVITATION_REVOKED_PREFIX)).toBe(true);
    // **すなわち「取り消した事実がどこからも読めなくなる」は、取り消した後に差分を1本でも
    // 適用した場合には当てはまらない。** **写しは `VACUUM INTO` でファイルを丸ごと取る。**
  });

  test("(4-e) その写しへ undo すると、**出し直した新しい招待が1件も残らない**(新旧どちらのコードも通らない)", () => {
    const ownerId = seedOwner();
    const first = withStore((store) =>
      store.issueInvitation({ username: "bob", role: "editor", issuedBy: ownerId }),
    );
    withStore((store) => store.revokeInvitation("bob"));
    apply("d1", "f1");
    const second = withStore((store) =>
      store.issueInvitation({ username: "bob", role: "editor", issuedBy: ownerId }),
    );
    expect(withStore((store) => findUsableInvitation(store, "bob", second.code))).toBeDefined();

    expect(undo(dataRoot, APP_ID).valid).toBe(true);

    // **実測値**: 行は取り消し済みの側に戻る。**出し直した新しいコードは表から消える。**
    expect(stateOf("bob")).toBe("revoked");
    expect(withStore((store) => store.findInvitation("bob")?.code)).toBe(first.code);
    expect(withStore((store) => findUsableInvitation(store, "bob", first.code))).toBeUndefined();
    expect(withStore((store) => findUsableInvitation(store, "bob", second.code))).toBeUndefined();
    // **運営者に通知は1つも出ない。** **相手は、伝えられたばかりのコードで入れなくなる。**
  });
});
