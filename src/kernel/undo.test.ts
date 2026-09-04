import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDiff } from "./apply-diff.ts";
import { applyManifest } from "./apply-manifest.ts";
import { createApp } from "./create-app.ts";
import { dryRunDiff } from "./dry-run.ts";
import { KernelMetaStore } from "./meta-store.ts";
import {
  createRecord,
  deleteRecord,
  listRecords,
  type RecordRow,
  updateRecord,
} from "./records.ts";
import { isApplyInProgress } from "./recovery.ts";
import { RESOURCE_ID_MAX_LENGTH } from "./resource-id.ts";
import { listSnapshots, takeSnapshot } from "./snapshot.ts";
import { appDbPath, appManifestPath } from "./storage-paths.ts";
import type { Diff, Manifest, Operation } from "./types.ts";
import {
  MAX_UNDOABLE_DIFF_ID_LENGTH,
  previewRedo,
  previewUndo,
  redo,
  UNDO_DIFF_ID_PREFIX,
  UNDO_PREVIEW_NOTE,
  undo,
} from "./undo.ts";

const APP_ID = "book-tracker";

let dataRoot: string;
let store: KernelMetaStore;

/** 蔵書管理アプリの初期マニフェスト(テーブル1・ビュー2)。 */
function baseManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "蔵書管理",
      tables: [
        {
          id: "books",
          name: "本",
          fields: [
            { id: "title", name: "タイトル", type: "text", required: true },
            { id: "memo", name: "メモ", type: "long_text" },
          ],
        },
      ],
      views: [
        { id: "book-list", type: "list_view", table: "books", columns: ["title"] },
        { id: "book-form", type: "form", table: "books", fields: ["title", "memo"] },
      ],
    },
  };
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-undo-"));
  store = KernelMetaStore.open(dataRoot);
  createApp(store, "蔵書管理", { app_id: APP_ID });
  const applied = applyManifest(dataRoot, APP_ID, baseManifest());
  if (!applied.valid) {
    throw new Error("テスト前提の初期マニフェスト投入に失敗しました。");
  }
});

afterEach(async () => {
  store.close();
  await rm(dataRoot, { recursive: true, force: true });
});

// --- テスト用ヘルパー ---------------------------------------------------------

function readManifestFile(): Manifest {
  return JSON.parse(readFileSync(appManifestPath(dataRoot, APP_ID), "utf-8")) as Manifest;
}

function readManifestText(): string {
  return readFileSync(appManifestPath(dataRoot, APP_ID), "utf-8");
}

function withDb<T>(fn: (db: Database) => T): T {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** マニフェスト + 全テーブル全レコードの完全なスナップショット(等価比較用)。 */
type CapturedState = { manifest: Manifest; records: Record<string, RecordRow[]> };

function captureState(): CapturedState {
  const manifest = readManifestFile();
  const records: Record<string, RecordRow[]> = {};
  withDb((db) => {
    for (const table of manifest.app.tables) {
      const result = listRecords(db, manifest, table.id, {
        sort: { field: "_id", order: "asc" },
      });
      if (!result.ok) {
        throw new Error(`レコード一覧に失敗しました: ${JSON.stringify(result.errors)}`);
      }
      records[table.id] = result.value;
    }
  });
  return { manifest, records };
}

function seed(tableId: string, input: Record<string, unknown>): RecordRow {
  return withDb((db) => {
    const result = createRecord(db, readManifestFile(), tableId, input);
    if (!result.ok) {
      throw new Error(`テスト前提のレコード投入に失敗しました: ${JSON.stringify(result.errors)}`);
    }
    return result.value;
  });
}

function removeRecord(tableId: string, id: string): void {
  withDb((db) => {
    const result = deleteRecord(db, readManifestFile(), tableId, id);
    if (!result.ok || !result.value) {
      throw new Error(`テスト前提のレコード削除に失敗しました: ${id}`);
    }
  });
}

/** ユーザフィールドを実際に編集する(_updated_at も本物の経路で進む)。 */
function editContent(tableId: string, id: string, input: Record<string, unknown>): void {
  withDb((db) => {
    const result = updateRecord(db, readManifestFile(), tableId, id, input);
    if (!result.ok) {
      throw new Error(`テスト前提のレコード更新に失敗しました: ${JSON.stringify(result.errors)}`);
    }
  });
}

/** システム列(`_updated_at`)だけを直接書き換える(ユーザフィールドは1つも触らない)。 */
function bumpUpdatedAtOnly(tableId: string, id: string, updatedAt: string): void {
  withDb((db) => {
    db.query(`UPDATE "${tableId}" SET "_updated_at" = ? WHERE "_id" = ?`).run(updatedAt, id);
  });
}

function idsOf(tableId: string): string[] {
  return withDb((db) => {
    const result = listRecords(db, readManifestFile(), tableId);
    if (!result.ok) {
      throw new Error(`レコード一覧に失敗しました: ${JSON.stringify(result.errors)}`);
    }
    return result.value.map((row) => row._id);
  });
}

function apply(diff: Diff): void {
  const result = applyDiff(dataRoot, APP_ID, diff);
  if (!result.valid) {
    throw new Error(`テスト前提の apply に失敗しました: ${JSON.stringify(result.errors)}`);
  }
}

function addFieldDiff(diffId: string, fieldId: string): Diff {
  const operations: Operation[] = [
    {
      op: "add_field",
      table: "books",
      field: { id: fieldId, name: fieldId, type: "text" },
    },
  ];
  return { diff_id: diffId, intent: `${fieldId} を記録したい`, operations };
}

// --- 計画書の中核: apply → データ追加 → undo → 状態Aと完全一致 -------------------

describe("undo(状態の巻き戻し)", () => {
  test("apply → データ追加 → undo で、追加したデータごと apply 前の状態に完全に戻る", () => {
    seed("books", { title: "既存1", memo: "m1" });
    seed("books", { title: "既存2", memo: null });
    const stateA = captureState();
    const idsBefore = idsOf("books");

    apply(addFieldDiff("d-001", "finished_at"));

    // apply 後に新しいデータを足す(これが undo で消えることを固定する)。
    const added = seed("books", { title: "apply後に追加", memo: null });
    expect(idsOf("books")).toContain(added._id);

    const result = undo(dataRoot, APP_ID);
    expect(result.valid).toBe(true);

    const after = captureState();
    // マニフェストの深い等価。
    expect(after.manifest).toEqual(stateA.manifest);
    // 全テーブル全レコードの一致。
    expect(after.records).toEqual(stateA.records);
    // undo の最も驚かれる挙動: apply 後に追加したデータも消える。
    expect(idsOf("books")).not.toContain(added._id);
    expect(idsOf("books").sort()).toEqual([...idsBefore].sort());
    expect(after.records.books).toHaveLength(2);
  });

  test("連続 undo は1つずつ古い方へ遡る(3回 apply → 3回 undo)", () => {
    seed("books", { title: "既存", memo: null });
    const state0 = captureState();

    apply(addFieldDiff("d-001", "f1"));
    const state1 = captureState();
    apply(addFieldDiff("d-002", "f2"));
    const state2 = captureState();
    apply(addFieldDiff("d-003", "f3"));
    const state3 = captureState();

    expect(state3.manifest.app.tables[0]?.fields.map((f) => f.id)).toEqual([
      "title",
      "memo",
      "f1",
      "f2",
      "f3",
    ]);

    expect(undo(dataRoot, APP_ID).valid).toBe(true);
    expect(captureState()).toEqual(state2);

    expect(undo(dataRoot, APP_ID).valid).toBe(true);
    expect(captureState()).toEqual(state1);

    expect(undo(dataRoot, APP_ID).valid).toBe(true);
    expect(captureState()).toEqual(state0);
  });

  test("undo は undo の対象にならない(トグルにならず、さらに古い方へ遡る)", () => {
    const state0 = captureState();
    apply(addFieldDiff("d-001", "f1"));
    const state1 = captureState();
    apply(addFieldDiff("d-002", "f2"));
    const state2 = captureState();

    expect(undo(dataRoot, APP_ID).valid).toBe(true);
    expect(captureState()).toEqual(state1);

    // ここで「undo を undo」すれば state2 に戻るが、ADR-0004 §1 はそれを禁じている。
    expect(undo(dataRoot, APP_ID).valid).toBe(true);
    const after = captureState();
    expect(after).toEqual(state0);
    expect(after).not.toEqual(state2);
    expect(after.manifest.app.tables[0]?.fields.map((f) => f.id)).toEqual(["title", "memo"]);
  });

  test("undo 実行直前のスナップショットが <連番>-undo-<対象diff_id> で残る", () => {
    apply(addFieldDiff("d-001", "f1"));
    const before = listSnapshots(dataRoot, APP_ID);

    const result = undo(dataRoot, APP_ID);
    if (!result.valid) {
      throw new Error("undo が失敗しました");
    }

    const after = listSnapshots(dataRoot, APP_ID);
    expect(after.length).toBe(before.length + 1);
    const created = after.filter((name) => !before.includes(name));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatch(/^\d{4}-undo-d-001$/);
    expect(result.snapshot).toBe(created[0] ?? "");
  });
});

// --- changelog への記録 --------------------------------------------------------

describe("undo の changelog 記録", () => {
  test("kind / undo_target_seq / intent / operations が ADR-0004 §3 のとおりに残る", () => {
    apply(addFieldDiff("d-001", "f1"));
    // [0] は create_app が書いた第0行(_create-app)なので、今回の apply は [1]。
    const applyEntry = store.listChangelog(APP_ID)[1];
    if (applyEntry === undefined) {
      throw new Error("apply エントリがありません");
    }

    const result = undo(dataRoot, APP_ID);
    if (!result.valid) {
      throw new Error("undo が失敗しました");
    }

    const entries = store.listChangelog(APP_ID);
    // _create-app + apply + undo の3件。
    expect(entries).toHaveLength(3);
    const undoEntry = entries[2];
    if (undoEntry === undefined) {
      throw new Error("undo エントリがありません");
    }
    expect(undoEntry.kind).toBe("undo");
    expect(undoEntry.undo_target_seq).toBe(applyEntry.seq);
    expect(undoEntry.diff_id).toBe("undo-d-001");
    // undo 用の op を発明しない。
    expect(undoEntry.operations).toEqual([]);
    // intent はカーネルの自動生成(対象の diff_id と intent を含む1文)。
    expect(undoEntry.intent).toContain("d-001");
    expect(undoEntry.intent).toContain(applyEntry.intent);
    expect(undoEntry.intent).toContain("取り消した");
    // undo 直前のスナップショットが記録されている。
    expect(undoEntry.snapshot).toBe(result.snapshot);
    // apply 側は kind: "apply" のまま。
    expect(applyEntry.kind).toBe("apply");
    expect(applyEntry.undo_target_seq).toBeNull();
  });
});

// --- redo(ADR-0032 / V1-M9-T05)------------------------------------------------

describe("redo(直前の undo のやり直し)", () => {
  test("apply → undo → redo で apply 直後の状態に完全に戻る(undo で消えたデータも戻る)", () => {
    seed("books", { title: "既存", memo: null });
    apply(addFieldDiff("d-001", "finished_at"));
    // apply 後に足したデータは undo の直前スナップショットに入る = redo で戻ってくる対象。
    const added = seed("books", { title: "apply後に追加", memo: null });
    const afterApply = captureState();
    expect(idsOf("books")).toContain(added._id);

    expect(undo(dataRoot, APP_ID).valid).toBe(true);
    // undo は apply も、その後に足したデータも巻き戻す。
    expect(idsOf("books")).not.toContain(added._id);

    const redone = redo(dataRoot, APP_ID);
    expect(redone.valid, JSON.stringify(redone)).toBe(true);
    if (!redone.valid) {
      throw new Error("redo が失敗しました");
    }
    // redo は undo 実行直前(= apply 直後 + 追加データ)の状態を丸ごと復元する。
    expect(captureState()).toEqual(afterApply);
    expect(idsOf("books")).toContain(added._id);
    // 復元元は undo が取った直前スナップショット。
    expect(redone.restored_from).toMatch(/^\d{4}-undo-d-001$/);
  });

  test("§3 の核心: apply → undo → redo → undo(再)で UNIQUE 衝突が起きず、2度目は対象なしで止まる(有限)", () => {
    apply(addFieldDiff("d-001", "f1"));
    expect(undo(dataRoot, APP_ID).valid).toBe(true);
    expect(redo(dataRoot, APP_ID).valid).toBe(true);

    const beforeSecondUndo = captureState();
    const beforeSnapshots = listSnapshots(dataRoot, APP_ID);
    const beforeChangelog = store.listChangelog(APP_ID);

    // redo は apply を undo 候補へ戻さない(redoneUndoSeqs は undoneTargetSeqs と別集合)。
    // したがって 2度目の undo は同じ apply を選ばず、`undo-d-001` の再生成 = UNIQUE 衝突が
    // 構造的に起きない。例外ではなく「取り消せる変更がありません」で静かに止まる(有限の往復)。
    const secondUndo = undo(dataRoot, APP_ID);
    expect(secondUndo.valid).toBe(false);
    if (secondUndo.valid) {
      throw new Error("2度目の undo は対象なしで拒否されるはずです");
    }
    expect(secondUndo.errors[0]?.message).toContain("取り消せる変更がありません");

    // 拒否なので状態・スナップショット・changelog はすべて不変(UNIQUE 例外で壊れていない)。
    expect(captureState()).toEqual(beforeSecondUndo);
    expect(listSnapshots(dataRoot, APP_ID)).toEqual(beforeSnapshots);
    expect(store.listChangelog(APP_ID)).toEqual(beforeChangelog);
  });

  test("redo は kind:redo と、やり直した undo エントリの seq を記録する(diff_id は前置1段)", () => {
    apply(addFieldDiff("d-001", "f1"));
    expect(undo(dataRoot, APP_ID).valid).toBe(true);
    const undoEntry = store.listChangelog(APP_ID).at(-1);
    if (undoEntry === undefined) {
      throw new Error("undo エントリがありません");
    }

    const redone = redo(dataRoot, APP_ID);
    if (!redone.valid) {
      throw new Error("redo が失敗しました");
    }

    const entries = store.listChangelog(APP_ID);
    // _create-app + apply + undo + redo の4件。
    expect(entries).toHaveLength(4);
    const redoEntry = entries[3];
    expect(redoEntry?.kind).toBe("redo");
    // 前置は1段だけ(redo-undo-... にしない)。undo-d-001 の "undo-" を "redo-" に差し替える。
    expect(redoEntry?.diff_id).toBe("redo-d-001");
    // undo_target_seq は「やり直した undo エントリの seq」を指す(列を増やさず転用)。
    expect(redoEntry?.undo_target_seq).toBe(undoEntry.seq);
    // redo を表す op は発明しない。
    expect(redoEntry?.operations).toEqual([]);
    expect(redoEntry?.intent).toContain("undo-d-001");
    expect(redoEntry?.intent).toContain("やり直した");
    // redo 実行直前のスナップショットが記録されている(<連番>-redo-<対象apply diff_id>)。
    expect(redoEntry?.snapshot).toBe(redone.snapshot);
    expect(redone.snapshot).toMatch(/^\d{4}-redo-d-001$/);
  });

  test("連続 undo のあと redo を繰り返すと新しい undo から順にやり直す(LIFO)。全て redo 済みなら対象なし", () => {
    seed("books", { title: "既存", memo: null });
    const state0 = captureState();
    apply(addFieldDiff("d-001", "f1"));
    const state1 = captureState();
    apply(addFieldDiff("d-002", "f2"));
    const state2 = captureState();

    expect(undo(dataRoot, APP_ID).valid).toBe(true); // d-002 を取り消し → state1
    expect(captureState()).toEqual(state1);
    expect(undo(dataRoot, APP_ID).valid).toBe(true); // d-001 を取り消し → state0
    expect(captureState()).toEqual(state0);

    // 1回目の redo は「最も新しい未 redo の undo」= d-001 の undo をやり直す → state1。
    expect(redo(dataRoot, APP_ID).valid).toBe(true);
    expect(captureState()).toEqual(state1);
    // 2回目の redo は d-002 の undo をやり直す → state2。
    expect(redo(dataRoot, APP_ID).valid).toBe(true);
    expect(captureState()).toEqual(state2);

    // すべての undo が redo 済み。3回目の redo は対象なしで拒否される(redo も有限)。
    const third = redo(dataRoot, APP_ID);
    expect(third.valid).toBe(false);
    if (third.valid) {
      throw new Error("3回目の redo は対象なしで拒否されるはずです");
    }
    expect(third.errors[0]?.message).toContain("やり直せる undo がありません");
  });

  test("redo 対象(やり直せる undo)が無ければ ValidationError で拒否し、状態は一切変わらない", () => {
    seed("books", { title: "既存", memo: null });
    apply(addFieldDiff("d-001", "f1")); // undo をしていないので redo 対象は無い
    const before = captureState();
    const beforeSnapshots = listSnapshots(dataRoot, APP_ID);
    const beforeChangelog = store.listChangelog(APP_ID);

    const result = redo(dataRoot, APP_ID);
    expect(result.valid).toBe(false);
    if (result.valid) {
      throw new Error("拒否されるはずです");
    }
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.path).toBe("");
    expect(result.errors[0]?.message).toContain(APP_ID);
    expect(result.errors[0]?.hint).toContain("redo");

    expect(captureState()).toEqual(before);
    expect(listSnapshots(dataRoot, APP_ID)).toEqual(beforeSnapshots);
    expect(store.listChangelog(APP_ID)).toEqual(beforeChangelog);
  });

  test("previewRedo も対象が無ければ redo と同一の ValidationError を返す", () => {
    apply(addFieldDiff("d-001", "f1"));
    const previewed = previewRedo(dataRoot, APP_ID);
    const executed = redo(dataRoot, APP_ID);
    expect(previewed.valid).toBe(false);
    expect(executed.valid).toBe(false);
    if (previewed.valid || executed.valid) {
      throw new Error("両方とも拒否されるはずです");
    }
    expect(previewed.errors).toEqual(executed.errors);
  });

  test("previewRedo は UndoPreview の形で、redo で戻る件数を restored_records に返す(状態は変えない)", () => {
    seed("books", { title: "既存", memo: null });
    apply(addFieldDiff("d-001", "f1"));
    const added = seed("books", { title: "apply後", memo: null }); // undo 直前スナップショットに入る
    expect(undo(dataRoot, APP_ID).valid).toBe(true); // added が消える
    expect(idsOf("books")).not.toContain(added._id);

    const undoEntry = store.listChangelog(APP_ID).at(-1);
    if (undoEntry === undefined) {
      throw new Error("undo エントリがありません");
    }
    const manifestBytes = readFileSync(appDbPath(dataRoot, APP_ID));
    const changelogBefore = store.listChangelog(APP_ID);

    const preview = previewRedo(dataRoot, APP_ID);
    if (!preview.valid) {
      throw new Error(`previewRedo が失敗しました: ${JSON.stringify(preview.errors)}`);
    }
    // redo は undo 直前スナップショット(2件)へ戻す → 消えた1件が戻る。
    expect(preview.preview.restored_records).toEqual({ books: 1 });
    expect(preview.preview.lost_records).toEqual({});
    // 対象は undo エントリ(operations は空、resource は名指しで消えない)。
    expect(preview.preview.target_seq).toBe(undoEntry.seq);
    expect(preview.preview.diff_id).toBe("undo-d-001");
    expect(preview.preview.operations).toEqual([]);
    expect(preview.preview.removed_resources).toEqual({
      tables: [],
      views: [],
      workflows: [],
      functions: [],
    });
    // 形は UndoPreview と同じ note を持つ。
    expect(preview.preview.note).toBe(UNDO_PREVIEW_NOTE);

    // 参照系: 呼んでも状態は1バイトも変わらない。
    expect(readFileSync(appDbPath(dataRoot, APP_ID)).equals(manifestBytes)).toBe(true);
    expect(store.listChangelog(APP_ID)).toEqual(changelogBefore);
    expect(idsOf("books")).not.toContain(added._id);
  });
});

// --- 対象なし ------------------------------------------------------------------

describe("undo 対象なし", () => {
  test("apply が1件もなければ ValidationError で拒否し、状態は一切変わらない", () => {
    seed("books", { title: "既存", memo: null });
    const before = captureState();
    const beforeSnapshots = listSnapshots(dataRoot, APP_ID);

    const result = undo(dataRoot, APP_ID);
    expect(result.valid).toBe(false);
    if (result.valid) {
      throw new Error("拒否されるはずです");
    }
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.path).toBe("");
    expect(result.errors[0]?.message).toContain(APP_ID);
    expect(result.errors[0]?.hint).toContain("redo");

    expect(captureState()).toEqual(before);
    expect(listSnapshots(dataRoot, APP_ID)).toEqual(beforeSnapshots);
    // create_app の第0行(V1-M0-T05)はあるが、それは undo の対象にならない。
    const entries = store.listChangelog(APP_ID);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.snapshot).toBeNull();
  });

  test("create_app の第0行は undo 対象にならない(V1-M0-T05 の退行防止)", () => {
    // 第0行は kind:"apply" だが snapshot が null である。これを候補に残すと、
    // 全 apply を undo し切ったあとの応答が「取り消せる変更がありません」から
    // 「スナップショットが記録されていません」に変わってしまう(退行)。
    apply(addFieldDiff("d-001", "f1"));
    expect(undo(dataRoot, APP_ID).valid).toBe(true);

    const result = undo(dataRoot, APP_ID);
    expect(result.valid).toBe(false);
    if (result.valid) {
      throw new Error("拒否されるはずです");
    }
    // noUndoTargetError の文面であること(unusableSnapshotError ではない)。
    expect(result.errors[0]?.message).toContain("取り消せる変更がありません");
    expect(result.errors[0]?.message).not.toContain("スナップショット");
    expect(result.errors[0]?.hint).toContain("redo");

    // previewUndo も同じ判定であること(ADR-0004 §2: 参照系と実行系で対象の選び方は同一)。
    const preview = previewUndo(dataRoot, APP_ID);
    expect(preview.valid).toBe(false);
    if (preview.valid) {
      throw new Error("拒否されるはずです");
    }
    expect(preview.errors[0]?.message).toContain("取り消せる変更がありません");
  });

  test("すべて取り消し済みなら ValidationError で拒否し、状態は一切変わらない", () => {
    apply(addFieldDiff("d-001", "f1"));
    expect(undo(dataRoot, APP_ID).valid).toBe(true);

    const before = captureState();
    const beforeSnapshots = listSnapshots(dataRoot, APP_ID);
    const beforeChangelog = store.listChangelog(APP_ID);

    const result = undo(dataRoot, APP_ID);
    expect(result.valid).toBe(false);

    expect(captureState()).toEqual(before);
    expect(listSnapshots(dataRoot, APP_ID)).toEqual(beforeSnapshots);
    expect(store.listChangelog(APP_ID)).toEqual(beforeChangelog);
  });

  test("レガシー行(60文字以上の diff_id を持つ apply)は、undo で例外ではなく ValidationError で拒否する", () => {
    // ADR-0028 / V1-M9-T08: apply_diff は今や59文字を超える diff_id を入口で拒否するので、
    // 通常の apply 経路からは 60文字の apply が二度と生まれない。だが**この防御を入れる前に
    // 適用された履歴**(あるいはスキーマ検証を通らない書き込み)が存在しうる —— その行に対しては
    // undo 側の unusableUndoIdError が引き続き唯一の正しい応答である(検証方法2 / §4-3)。
    // apply 側に拒否を入れた瞬間にこの防御が到達不能コードになって静かに腐らないよう、
    // **スキーマ検証を通さず appendChangelog で直接**レガシー行を作って固定する。
    const longDiffId = `d-${"x".repeat(58)}`; // 60文字。"undo-" を足すと65文字で規約違反。
    expect(longDiffId).toHaveLength(60);
    expect(longDiffId.length).toBeGreaterThan(MAX_UNDOABLE_DIFF_ID_LENGTH);

    // 実在するスナップショットディレクトリを1つ用意し、レガシー行の巻き戻し先にする
    // (resolveTargetSnapshotDir が実体の存在を確かめるため、null や架空名では
    //  unusableSnapshotError の側に落ちてしまい、狙った経路を通らない)。
    const base = takeSnapshot(dataRoot, APP_ID, "d-legacy-base");
    store.appendChangelog({
      app_id: APP_ID,
      diff_id: longDiffId,
      intent: "この防御を入れる前に適用された想定のレガシー行",
      operations: [],
      snapshot: base.name,
      kind: "apply",
      undo_target_seq: null,
    });

    const before = captureState();
    const beforeSnapshots = listSnapshots(dataRoot, APP_ID);
    const beforeChangelog = store.listChangelog(APP_ID);

    const result = undo(dataRoot, APP_ID);

    expect(result.valid).toBe(false);
    if (result.valid) {
      throw new Error("拒否されるはずです");
    }
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.path).toBe("");
    // 統一形式(例外ではない)で、対象の diff_id と入力規約(59文字以内)を伝える。
    expect(result.errors[0]?.message).toContain(longDiffId);
    expect(result.errors[0]?.hint).toContain(`${MAX_UNDOABLE_DIFF_ID_LENGTH}文字以内`);
    expect(result.errors[0]?.hint).toContain(UNDO_DIFF_ID_PREFIX);

    // 拒否なので状態は一切変わらない(スナップショットも増えない)。
    expect(captureState()).toEqual(before);
    expect(listSnapshots(dataRoot, APP_ID)).toEqual(beforeSnapshots);
    expect(store.listChangelog(APP_ID)).toEqual(beforeChangelog);
  });

  test("previewUndo も対象が無ければ undo と同一の ValidationError を返す", () => {
    const previewed = previewUndo(dataRoot, APP_ID);
    const executed = undo(dataRoot, APP_ID);
    expect(previewed.valid).toBe(false);
    expect(executed.valid).toBe(false);
    if (previewed.valid || executed.valid) {
      throw new Error("両方とも拒否されるはずです");
    }
    expect(previewed.errors).toEqual(executed.errors);
  });
});

// --- diff_id 長さ境界(ADR-0028 / V1-M9-T08)-----------------------------------

describe("diff_id 長さ境界(適用できた差分は必ず undo できる)", () => {
  /** 先頭が英小文字である必要があるので "d" + "a"×(N-1) の形で長さ N を作る。 */
  const idOfLength = (n: number) => `d${"a".repeat(n - 1)}`;

  // 通る側(下限1・実測最大32・境界内側58・境界そのもの59)。
  // 59 は "undo-" 前置で ちょうど 64 になり、undo も成立する(64は「以下」であって「未満」でない)。
  for (const n of [1, 32, 58, MAX_UNDOABLE_DIFF_ID_LENGTH]) {
    test(`長さ${n}: apply が通り、undo も通る`, () => {
      const id = idOfLength(n);
      expect(id).toHaveLength(n);

      const applied = applyDiff(dataRoot, APP_ID, addFieldDiff(id, `f_${n}`));
      expect(applied.valid).toBe(true);

      const undone = undo(dataRoot, APP_ID);
      expect(undone.valid).toBe(true);
      if (!undone.valid) {
        throw new Error(`undo が拒否されました: ${JSON.stringify(undone.errors)}`);
      }
      // undo スナップショット名 `<連番>-undo-<id>` が作れている(= 前置後も規約内)。
      expect(undone.snapshot).toContain(`${UNDO_DIFF_ID_PREFIX}${id}`);
    });
  }

  // 拒否側(境界外側60・スキーマ上限64・従来違反65)。拒否時に状態が1バイトも変わらない。
  for (const n of [
    MAX_UNDOABLE_DIFF_ID_LENGTH + 1,
    RESOURCE_ID_MAX_LENGTH,
    RESOURCE_ID_MAX_LENGTH + 1,
  ]) {
    test(`長さ${n}: apply が拒否され、状態が1バイトも変わらない`, () => {
      const id = idOfLength(n);
      expect(id).toHaveLength(n);

      const before = captureState();
      const beforeSnapshots = listSnapshots(dataRoot, APP_ID);
      const beforeChangelog = store.listChangelog(APP_ID);

      const applied = applyDiff(dataRoot, APP_ID, addFieldDiff(id, "f_reject"));
      expect(applied.valid).toBe(false);
      if (applied.valid) {
        throw new Error("拒否されるはずです");
      }
      // 統一形式で diff_id を指す(重複拒否と同型)。
      expect(applied.errors.some((error) => error.path === "/diff_id")).toBe(true);

      // 状態不変(snapshots が増えない / changelog が増えない / manifest 不変 /
      // 進行中マーカー .st-applying.json が残らない)。拒否が beginApply/takeSnapshot より前。
      expect(captureState()).toEqual(before);
      expect(listSnapshots(dataRoot, APP_ID)).toEqual(beforeSnapshots);
      expect(store.listChangelog(APP_ID)).toEqual(beforeChangelog);
      expect(isApplyInProgress(dataRoot, APP_ID).inProgress).toBe(false);
    });
  }

  test(`長さ${RESOURCE_ID_MAX_LENGTH + 1}: 従来の resource_id 上限(${RESOURCE_ID_MAX_LENGTH})違反も報告され、「59超」だけに取り違えない`, () => {
    const applied = applyDiff(
      dataRoot,
      APP_ID,
      addFieldDiff(idOfLength(RESOURCE_ID_MAX_LENGTH + 1), "f_65"),
    );
    expect(applied.valid).toBe(false);
    if (applied.valid) {
      throw new Error("拒否されるはずです");
    }
    // 60〜64 は「59文字以内」だけだが、65 は resource_id 規約(64)違反として従来どおり出る。
    expect(
      applied.errors.some((error) => error.message.includes(`${RESOURCE_ID_MAX_LENGTH}文字以内`)),
    ).toBe(true);
  });

  test("dry_run_diff と apply_diff の判定が一致する(60文字はドライランも拒否)", () => {
    const id = idOfLength(MAX_UNDOABLE_DIFF_ID_LENGTH + 1);
    const dry = dryRunDiff(dataRoot, APP_ID, addFieldDiff(id, "f_dry"));
    const real = applyDiff(dataRoot, APP_ID, addFieldDiff(id, "f_real"));
    expect(dry.valid).toBe(false);
    expect(real.valid).toBe(false);
    // 影のルート上でも本体でも状態は変わっていない(念のため changelog を確認)。
    expect(store.listChangelog(APP_ID)).toHaveLength(1); // _create-app の第0行だけ
  });

  test("create_app の第0行(_create-app)は新しい長さ検査に巻き込まれない", () => {
    // 第0行の diff_id は "_create-app"(11文字)であり 59文字以内。create_app 経路は
    // applyDiff を通らないが、長さ的にも巻き込まれないことを明示で固定する。
    const changelog = store.listChangelog(APP_ID);
    const firstRow = changelog[0];
    if (firstRow === undefined) {
      throw new Error("第0行がありません");
    }
    expect(firstRow.diff_id).toBe("_create-app");
    expect(firstRow.diff_id.length).toBeLessThanOrEqual(MAX_UNDOABLE_DIFF_ID_LENGTH);
  });
});

// --- previewUndo ---------------------------------------------------------------

describe("previewUndo(事前確認)", () => {
  test("対象の diff_id / intent / applied_at / operations と定型注記を返す", () => {
    apply(addFieldDiff("d-001", "finished_at"));
    // [0] は create_app が書いた第0行(_create-app)なので、今回の apply は [1]。
    const applyEntry = store.listChangelog(APP_ID)[1];
    if (applyEntry === undefined) {
      throw new Error("apply エントリがありません");
    }

    const result = previewUndo(dataRoot, APP_ID);
    if (!result.valid) {
      throw new Error(`previewUndo が失敗しました: ${JSON.stringify(result.errors)}`);
    }
    expect(result.preview.target_seq).toBe(applyEntry.seq);
    expect(result.preview.diff_id).toBe("d-001");
    expect(result.preview.intent).toBe(applyEntry.intent);
    expect(result.preview.applied_at).toBe(applyEntry.applied_at);
    expect(result.preview.operations).toEqual(applyEntry.operations);
    // ADR-0027: note は「何を基準に数えたか」を申告する定型文になった。
    expect(result.preview.note).toBe(UNDO_PREVIEW_NOTE);
    expect(result.preview.note).toContain("システム列");
    expect(result.preview.note).toContain("_updated_at");
    expect(result.preview.note).toContain("数えません");
  });

  test("apply 後に3件追加して2件削除したら lost=3 / restored=2(引き算なら1になる)", () => {
    const existing = [
      seed("books", { title: "既存1", memo: null }),
      seed("books", { title: "既存2", memo: null }),
      seed("books", { title: "既存3", memo: null }),
      seed("books", { title: "既存4", memo: null }),
      seed("books", { title: "既存5", memo: null }),
    ];

    apply(addFieldDiff("d-001", "finished_at"));

    // apply 後に3件追加し、apply 前からあった2件を削除する。
    seed("books", { title: "追加1", memo: null });
    seed("books", { title: "追加2", memo: null });
    seed("books", { title: "追加3", memo: null });
    removeRecord("books", existing[0]?._id ?? "");
    removeRecord("books", existing[1]?._id ?? "");

    // 件数の引き算は 6 - 5 = 1 にしかならない。集合差なら 3 と 2 に分かれる。
    expect(idsOf("books")).toHaveLength(6);
    const result = previewUndo(dataRoot, APP_ID);
    if (!result.valid) {
      throw new Error(`previewUndo が失敗しました: ${JSON.stringify(result.errors)}`);
    }
    expect(result.preview.lost_records).toEqual({ books: 3 });
    expect(result.preview.restored_records).toEqual({ books: 2 });
  });

  test("差が無ければ lost_records / restored_records は空になる", () => {
    seed("books", { title: "既存", memo: null });
    apply(addFieldDiff("d-001", "f1"));

    const result = previewUndo(dataRoot, APP_ID);
    if (!result.valid) {
      throw new Error("previewUndo が失敗しました");
    }
    expect(result.preview.lost_records).toEqual({});
    expect(result.preview.restored_records).toEqual({});
  });

  test("add_table で作られたテーブルは、その全件が lost_records に計上される", () => {
    const operations: Operation[] = [
      {
        op: "add_table",
        table: {
          id: "tags",
          name: "タグ",
          fields: [{ id: "label", name: "ラベル", type: "text", required: true }],
        },
      },
    ];
    apply({ diff_id: "d-001", intent: "タグを付けたい", operations });

    seed("tags", { label: "SF" });
    seed("tags", { label: "技術書" });
    seed("tags", { label: "小説" });

    const result = previewUndo(dataRoot, APP_ID);
    if (!result.valid) {
      throw new Error("previewUndo が失敗しました");
    }
    // スナップショット側に tags テーブルは存在しないので、現在の全件が失われる。
    expect(result.preview.lost_records).toEqual({ tags: 3 });
    expect(result.preview.restored_records).toEqual({});

    // 実際に undo するとテーブルごと消える(preview の申告どおり)。
    expect(undo(dataRoot, APP_ID).valid).toBe(true);
    expect(readManifestFile().app.tables.map((t) => t.id)).toEqual(["books"]);
  });

  test("previewUndo は状態を一切変更しない(参照系である)", () => {
    seed("books", { title: "既存", memo: null });
    apply(addFieldDiff("d-001", "f1"));
    seed("books", { title: "apply後", memo: null });

    const manifestText = readManifestText();
    const dbBytes = readFileSync(appDbPath(dataRoot, APP_ID));
    const snapshots = listSnapshots(dataRoot, APP_ID);
    const changelog = store.listChangelog(APP_ID);
    const state = captureState();

    expect(previewUndo(dataRoot, APP_ID).valid).toBe(true);
    expect(previewUndo(dataRoot, APP_ID).valid).toBe(true);

    expect(readManifestText()).toBe(manifestText);
    expect(readFileSync(appDbPath(dataRoot, APP_ID)).equals(dbBytes)).toBe(true);
    expect(listSnapshots(dataRoot, APP_ID)).toEqual(snapshots);
    expect(store.listChangelog(APP_ID)).toEqual(changelog);
    expect(captureState()).toEqual(state);
    // sidecar を残さない(次に開いた接続が状態を書き換えないこと)。
    expect(existsSync(`${appDbPath(dataRoot, APP_ID)}-wal`)).toBe(false);
  });

  test("previewUndo の申告どおりのレコードが undo で消える/戻る", () => {
    const existing = seed("books", { title: "既存", memo: null });
    apply(addFieldDiff("d-001", "f1"));
    const added = seed("books", { title: "追加", memo: null });
    removeRecord("books", existing._id);

    const preview = previewUndo(dataRoot, APP_ID);
    if (!preview.valid) {
      throw new Error("previewUndo が失敗しました");
    }
    expect(preview.preview.lost_records).toEqual({ books: 1 });
    expect(preview.preview.restored_records).toEqual({ books: 1 });

    expect(undo(dataRoot, APP_ID).valid).toBe(true);
    const ids = idsOf("books");
    expect(ids).toEqual([existing._id]);
    expect(ids).not.toContain(added._id);
  });
});

// --- V1-M9-T06 / ADR-0027: 内容だけ変わったレコードの件数(changed_records)-----------

describe("previewUndo(内容だけ変わったレコード: changed_records)", () => {
  test("ユーザフィールドを編集した行だけが changed に入り、追加/削除/システム列変更とは排他になる", () => {
    const r1 = seed("books", { title: "本1", memo: "m1" });
    const r2 = seed("books", { title: "本2", memo: "m2" });
    const r3 = seed("books", { title: "本3", memo: "m3" });
    const r4 = seed("books", { title: "本4", memo: "m4" });
    seed("books", { title: "本5", memo: "m5" }); // r5: 一切触らない(変更に数えない)

    apply(addFieldDiff("d-001", "finished_at")); // ここでスナップショットが r1..r5 を保持

    // r1 / r2: ユーザフィールドを実際に編集(= changed)。
    editContent("books", r1._id, { title: "本1(改)" });
    editContent("books", r2._id, { memo: "m2(改)" });
    // r3: システム列(_updated_at)だけ進める。**内容は変わっていないので changed に数えない**(§4)。
    bumpUpdatedAtOnly("books", r3._id, "2099-01-01T00:00:00.000Z");
    // r4: 削除(= スナップショットにあって現在に無い → restored)。
    removeRecord("books", r4._id);
    // apply 後に新規追加(= 現在にあってスナップショットに無い → lost)。
    seed("books", { title: "追加", memo: null });

    const result = previewUndo(dataRoot, APP_ID);
    if (!result.valid) {
      throw new Error(`previewUndo が失敗しました: ${JSON.stringify(result.errors)}`);
    }
    // r1 / r2 の2件だけ。r3(システム列のみ)/ r5(無変更)は数えない。
    expect(result.preview.changed_records).toEqual({ books: 2 });
    // 排他: 追加1件が lost、削除1件が restored。changed の2件はどちらにも入らない。
    expect(result.preview.lost_records).toEqual({ books: 1 });
    expect(result.preview.restored_records).toEqual({ books: 1 });
  });

  test("編集された行は changed だけに入り、lost / restored には決して入らない(排他の直接固定)", () => {
    const r1 = seed("books", { title: "本1", memo: "m1" });
    seed("books", { title: "本2", memo: "m2" });
    apply(addFieldDiff("d-001", "f1"));
    editContent("books", r1._id, { title: "本1(改)" });

    const result = previewUndo(dataRoot, APP_ID);
    if (!result.valid) {
      throw new Error("previewUndo が失敗しました");
    }
    expect(result.preview.changed_records).toEqual({ books: 1 });
    expect(result.preview.lost_records).toEqual({});
    expect(result.preview.restored_records).toEqual({});
  });

  test("_updated_at だけが進んだ no-op 更新は changed に数えない(システム列除外)", () => {
    const r1 = seed("books", { title: "本1", memo: "m1" });
    apply(addFieldDiff("d-001", "f1"));
    // ユーザフィールドは一切変えず、_updated_at だけ未来へ飛ばす。
    bumpUpdatedAtOnly("books", r1._id, "2099-12-31T23:59:59.999Z");

    const result = previewUndo(dataRoot, APP_ID);
    if (!result.valid) {
      throw new Error("previewUndo が失敗しました");
    }
    expect(result.preview.changed_records).toEqual({});
  });

  test("片側にしか無い列(apply で足したフィールド)の変更は比較対象外(共通列だけで判定)", () => {
    const r1 = seed("books", { title: "本1", memo: "m1" });
    apply(addFieldDiff("d-001", "finished_at")); // スナップショットの books は title/memo のみ
    // 現在にしか存在しない finished_at だけを埋める。共通列(title/memo)は変えない。
    editContent("books", r1._id, { finished_at: "2026-01-01" });

    const result = previewUndo(dataRoot, APP_ID);
    if (!result.valid) {
      throw new Error("previewUndo が失敗しました");
    }
    // 比較列は現在/スナップショット共通の {title, memo} のみ。finished_at は除外され、変更に数えない。
    expect(result.preview.changed_records).toEqual({});
  });

  test("差が無ければ changed_records は空になる", () => {
    seed("books", { title: "本", memo: null });
    apply(addFieldDiff("d-001", "f1"));

    const result = previewUndo(dataRoot, APP_ID);
    if (!result.valid) {
      throw new Error("previewUndo が失敗しました");
    }
    expect(result.preview.changed_records).toEqual({});
  });
});

// --- V1-M9-T06 / ADR-0027: 定義ごと消える資源の明示(removed_resources)---------------

describe("previewUndo(消える資源: removed_resources)", () => {
  test("remove_table / remove_view / remove_workflow を removed_resources に明示する", () => {
    const setupOps: Operation[] = [
      {
        op: "add_table",
        table: {
          id: "tags",
          name: "タグ",
          fields: [{ id: "label", name: "ラベル", type: "text" }],
        },
      },
      {
        op: "add_table",
        table: {
          id: "notifications",
          name: "通知",
          fields: [{ id: "title", name: "件名", type: "text" }],
        },
      },
      {
        op: "add_table",
        table: {
          id: "wf-runs",
          name: "実行履歴",
          fields: [
            { id: "ran_at", name: "実行時刻", type: "date" },
            { id: "workflow", name: "WF", type: "text" },
            { id: "trigger_type", name: "契機", type: "text" },
            { id: "status", name: "結果", type: "text" },
            { id: "error", name: "エラー", type: "long_text" },
          ],
        },
      },
      {
        op: "add_view",
        view: { id: "tag-list", type: "list_view", table: "tags", columns: ["label"] },
      },
      {
        op: "add_workflow",
        workflow: {
          id: "notify",
          name: "通知",
          trigger: { type: "on_create", table: "books" },
          history_table: "wf-runs",
          actions: [{ action: "create_record", table: "notifications", values: { title: "新着" } }],
        },
      },
    ];
    apply({ diff_id: "d-setup", intent: "タグ・通知機能を足す", operations: setupOps });

    const removeOps: Operation[] = [
      { op: "remove_view", view: "tag-list" },
      { op: "remove_workflow", workflow: { id: "notify" } },
      { op: "remove_table", table: "tags" },
    ];
    apply({ diff_id: "d-remove", intent: "タグ機能を撤去", operations: removeOps });

    const result = previewUndo(dataRoot, APP_ID);
    if (!result.valid) {
      throw new Error(`previewUndo が失敗しました: ${JSON.stringify(result.errors)}`);
    }
    // DB は読まず、operations の配列フィルタだけで導く(§3)。
    expect(result.preview.removed_resources).toEqual({
      tables: ["tags"],
      views: ["tag-list"],
      workflows: ["notify"],
      functions: [],
    });
  });

  test("消える資源が無い apply では removed_resources は全て空配列", () => {
    seed("books", { title: "本", memo: null });
    apply(addFieldDiff("d-001", "f1"));

    const result = previewUndo(dataRoot, APP_ID);
    if (!result.valid) {
      throw new Error("previewUndo が失敗しました");
    }
    expect(result.preview.removed_resources).toEqual({
      tables: [],
      views: [],
      workflows: [],
      functions: [],
    });
  });
});

// ---------------------------------------------------------------------------
// V1-M2-T05e / T05d 完了条件6(C-2): 履歴の復元に、後から足した制約を掛けない
//
// T05d §8-5 が**最も重い代償**として挙げたもの。`$defs/action_value` の `else` を
// 足した瞬間、**書かれた当時は正当だったスナップショット4本が undo できなくなる**
// (`readSnapshotManifest` が `validateManifestFull` に通して例外を投げる)。
//
// **方針: 新しい制約は「新しい入力の受理」に掛け、「履歴の復元」には掛けない。**
// undo は「書かれた当時は正当だった状態」を復元する操作である。後から足した制約で
// 履歴の読み取りを止めると、**制約を強化するたびに undo が壊れる。**
// これは今回限りではなく構造の問題なので、ここで線を引く(`validate.ts` の
// `INPUT_ONLY_SCHEMA_PATHS` を参照)。
//
// **v0 が `required` を NOT NULL 制約にしなかったのと同じ線引きである**
// (`ddl.ts` 冒頭)—— 制約は書き込み時に強制し、既に在るものには遡らない。
// ---------------------------------------------------------------------------
describe("V1-M2-T05e: 制約より古いスナップショットの undo(C-2 の救済)", () => {
  /** 口ひげ記法を含むワークフローを1本持つマニフェスト(= 制約導入前に書けたもの)。 */
  function manifestWithWorkflow(actionValue: string): Manifest {
    const base = baseManifest();
    base.app.tables.push({
      id: "notifications",
      name: "通知",
      fields: [{ id: "title", name: "件名", type: "text" }],
    });
    base.app.tables.push({
      id: "workflow-runs",
      name: "実行履歴",
      fields: [
        { id: "ran_at", name: "実行時刻", type: "date" },
        { id: "workflow", name: "ワークフロー", type: "text" },
        { id: "trigger_type", name: "契機", type: "text" },
        { id: "status", name: "結果", type: "text" },
        { id: "error", name: "エラー", type: "long_text" },
      ],
    });
    base.app.views.push({
      id: "notification-list",
      type: "list_view",
      table: "notifications",
      columns: ["title"],
    });
    base.app.workflows = [
      {
        id: "notify",
        name: "通知",
        trigger: { type: "on_create", table: "books" },
        history_table: "workflow-runs",
        actions: [
          { action: "create_record", table: "notifications", values: { title: actionValue } },
        ],
      },
    ];
    return base;
  }

  /**
   * 「制約より古い履歴」を作る。
   *
   * 制約導入後は口ひげ記法を**書き込めない**ので、正当な値で apply したうえで
   * ディスク上のファイルを字面で書き換え、**当時は正当だった状態**を再現する。
   * (実リポジトリの `data-t05-*` 配下に実在する4本と同じ形である。)
   */
  function seedLegacyHistory(): { snapshotName: string } {
    const applied = applyManifest(dataRoot, APP_ID, manifestWithWorkflow("$record.title"));
    if (!applied.valid) {
      throw new Error(`前提の投入に失敗: ${JSON.stringify(applied.errors)}`);
    }
    // apply を1回行い、直前状態(= ワークフロー入りの状態A)のスナップショットを作る。
    apply(addFieldDiff("d-legacy", "isbn"));
    const snapshots = listSnapshots(dataRoot, APP_ID);
    const snapshotName = snapshots.at(-1) ?? "";
    // スナップショット側の manifest.json を「当時の字面」に書き換える。
    const snapshotManifest = join(
      dataRoot,
      "apps",
      APP_ID,
      "snapshots",
      snapshotName,
      "manifest.json",
    );
    writeFileSync(
      snapshotManifest,
      readFileSync(snapshotManifest, "utf-8").replace('"$record.title"', '"{{record.title}}"'),
    );
    return { snapshotName };
  }

  test("口ひげ記法を含む古いスナップショットは previewUndo で例外を投げない", () => {
    seedLegacyHistory();
    const preview = previewUndo(dataRoot, APP_ID);
    expect(preview.valid).toBe(true);
  });

  test("口ひげ記法を含む古いスナップショットを undo で復元できる", () => {
    seedLegacyHistory();
    const result = undo(dataRoot, APP_ID);
    expect(result.valid).toBe(true);
    // 復元されたのは「当時の字面」そのものである。カーネルが黙って直したりしない。
    expect(readManifestText()).toContain("{{record.title}}");
  });

  /**
   * **緩めた側から不正なマニフェストが本番へ流れ込まないことの証明。**
   *
   * 復元は通るが、**その状態から次の差分を適用しようとすると、口ひげと無関係な
   * 差分であっても、適用後マニフェスト全体の検証(`apply-diff.ts` の
   * `validateManifestFull(next)`)で拒否される。**
   * すなわち緩めたのは**読み取りだけ**であり、書き込みの関門は1つも緩んでいない。
   */
  test("復元されたマニフェストは、その後の apply_diff で再び検査に掛かる", () => {
    seedLegacyHistory();
    expect(undo(dataRoot, APP_ID).valid).toBe(true);

    // 口ひげとは何の関係も無い差分。それでも通らない。
    const result = applyDiff(dataRoot, APP_ID, addFieldDiff("d-after-undo", "publisher"));
    expect(result.valid).toBe(false);
    if (result.valid) {
      throw new Error("復元後の apply_diff が通ってしまった");
    }
    const messages = result.errors.map((e) => `${e.path} ${e.message} ${e.hint ?? ""}`).join("\n");
    expect(messages).toContain("{{record.title}}");
    // 例外ではなく、直せる形のエラーとして返っていること。
    expect(messages).toContain("$record.");
  });
});
