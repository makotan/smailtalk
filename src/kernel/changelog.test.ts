import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDiff } from "./apply-diff.ts";
import { applyManifest } from "./apply-manifest.ts";
import { getChangelog } from "./changelog.ts";
import { createApp } from "./create-app.ts";
import { KernelMetaStore } from "./meta-store.ts";
import type { Diff, Manifest } from "./types.ts";
import { undo } from "./undo.ts";

const APP_ID = "book-tracker";
const OTHER_APP_ID = "recipe-box";

/** 蔵書管理アプリの初期マニフェスト(テーブル1・ビュー2)。 */
function baseManifest(appId: string, name: string): Manifest {
  return {
    app: {
      id: appId,
      name,
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

/**
 * シナリオの3差分。intent は「なぜそうしたか」が読める日本語にしてある。
 * このテストの主眼は、これらの intent が取得した履歴にそのままの語で並ぶこと
 * (= 履歴が要件定義書として読めること、憲法5 / handover.md 3.8)である。
 */
const INTENT_1 = "誰の本かを一覧で見分けたいので、著者を記録して一覧にも出す";
const INTENT_2 = "本をジャンルで分類したいので、タグの台帳を用意する";
const INTENT_3 = "読み返す価値を後から思い出せるように、5段階の評価を残せるようにする";

const DIFF_1: Diff = {
  diff_id: "d-001",
  intent: INTENT_1,
  operations: [
    { op: "add_field", table: "books", field: { id: "author", name: "著者", type: "text" } },
    { op: "update_view", view: "book-list", changes: { columns: ["title", "author"] } },
  ],
};

const DIFF_2: Diff = {
  diff_id: "d-002",
  intent: INTENT_2,
  operations: [
    {
      op: "add_table",
      table: {
        id: "tags",
        name: "タグ",
        fields: [{ id: "label", name: "名前", type: "text", required: true }],
      },
    },
    {
      op: "add_view",
      view: { id: "tag-list", type: "list_view", table: "tags", columns: ["label"] },
    },
  ],
};

const DIFF_3: Diff = {
  diff_id: "d-003",
  intent: INTENT_3,
  operations: [
    { op: "add_field", table: "books", field: { id: "rating", name: "評価", type: "number" } },
  ],
};

let dataRoot: string;
let store: KernelMetaStore;

/** 指定アプリを作り、初期マニフェストまで入れる。 */
function seedApp(appId: string, name: string): void {
  createApp(store, name, { app_id: appId });
  const applied = applyManifest(dataRoot, appId, baseManifest(appId, name));
  if (!applied.valid) {
    throw new Error(`テスト前提の初期マニフェスト投入に失敗しました(${appId})。`);
  }
}

/** 差分を適用する。失敗したらテストの前提が崩れているので即座に落とす。 */
function apply(appId: string, diff: Diff): void {
  const result = applyDiff(dataRoot, appId, diff);
  if (!result.valid) {
    throw new Error(
      `テスト前提の差分適用に失敗しました(${diff.diff_id}): ${JSON.stringify(result.errors)}`,
    );
  }
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-changelog-"));
  store = KernelMetaStore.open(dataRoot);
  seedApp(APP_ID, "蔵書管理");
});

afterEach(async () => {
  store.close();
  await rm(dataRoot, { recursive: true, force: true });
});

/** 計画書 V0-P4-T05 / CP-4 のシナリオ: 差分3回 apply → undo 1回。 */
function runScenario(): void {
  apply(APP_ID, DIFF_1);
  apply(APP_ID, DIFF_2);
  apply(APP_ID, DIFF_3);
  const result = undo(dataRoot, APP_ID);
  if (!result.valid) {
    throw new Error(`テスト前提の undo に失敗しました: ${JSON.stringify(result.errors)}`);
  }
}

describe("getChangelog: 適用した全 diff と undo が時系列で取得できる(V0-P4-T05)", () => {
  test("3回の apply と1回の undo が seq 昇順で並ぶ", () => {
    runScenario();
    const entries = getChangelog(dataRoot, APP_ID);

    // V1-M0-T05: seedApp の createApp が第0行(_create-app)を書くので、
    // 3回の apply + 1回の undo の手前にもう1行増える。
    expect(entries).toHaveLength(5);
    expect(entries.map((e) => e.diff_id)).toEqual([
      "_create-app",
      "d-001",
      "d-002",
      "d-003",
      "undo-d-003",
    ]);
    expect(entries.map((e) => e.kind)).toEqual(["apply", "apply", "apply", "apply", "undo"]);

    // seq は狭義単調増加(AUTOINCREMENT)。時系列順であることの機械的な保証。
    const seqs = entries.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);

    // applied_at も ISO8601 UTC 文字列なので、辞書順で非減少になっていること。
    const appliedAt = entries.map((e) => e.applied_at);
    expect(appliedAt).toEqual([...appliedAt].sort());
  });

  test("各 apply エントリに intent / operations / applied_at が含まれる(完了条件)", () => {
    runScenario();
    // create_app が書く第0行(_create-app)も kind: "apply" だが、operations が
    // 常に空(V1-M0-T05 の決定2)なのでここでは対象外にする。
    const applies = getChangelog(dataRoot, APP_ID).filter(
      (e) => e.kind === "apply" && e.diff_id !== "_create-app",
    );

    expect(applies).toHaveLength(3);
    for (const entry of applies) {
      expect(entry.intent).not.toBe("");
      expect(Array.isArray(entry.operations)).toBe(true);
      expect(entry.operations.length).toBeGreaterThan(0);
      // ISO8601 UTC(ミリ秒つき)。
      expect(entry.applied_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }

    // operations は保存・復元を経ても元の差分と同一の構造で読めること。
    expect(applies.map((e) => e.operations)).toEqual([
      DIFF_1.operations,
      DIFF_2.operations,
      DIFF_3.operations,
    ]);
  });

  test("intent が人間の読める要件履歴として並ぶ(憲法5・handover.md 3.8)", () => {
    runScenario();
    const entries = getChangelog(dataRoot, APP_ID);

    // entries[0] は create_app が書いた第0行(_create-app)。
    // apply の intent は呼び出し側が書いた文言がそのまま残る。
    expect(entries.slice(1, 4).map((e) => e.intent)).toEqual([INTENT_1, INTENT_2, INTENT_3]);

    // undo の intent はカーネルが生成し、「何を取り消したか」が日本語で読める。
    expect(entries[4]?.intent).toBe(`d-003(${INTENT_3})を取り消した`);
  });

  test("undo 記録は kind と undo_target_seq で「何を取り消したか」が読める(ADR-0004 §3)", () => {
    runScenario();
    const entries = getChangelog(dataRoot, APP_ID);

    const undone = entries.find((e) => e.kind === "undo");
    const target = entries.find((e) => e.diff_id === "d-003");
    expect(undone).toBeDefined();
    expect(target).toBeDefined();
    expect(undone?.undo_target_seq).toBe(target?.seq ?? -1);

    // apply エントリの undo_target_seq は常に null(ADR-0004 §3)。
    for (const entry of entries.filter((e) => e.kind === "apply")) {
      expect(entry.undo_target_seq).toBeNull();
    }
  });

  test("生の履歴をそのまま返し、畳み込み結果は持たない(ADR-0004 の申し送り)", () => {
    runScenario();
    const entries = getChangelog(dataRoot, APP_ID);

    // 取り消された d-003 も履歴からは消えない(「実際に何が起きたか」を語れること)。
    expect(entries.some((e) => e.diff_id === "d-003")).toBe(true);
    // 「今どの状態にいるか」を表す畳み込みフィールドをエントリに足していないこと。
    expect(Object.keys(entries[0] ?? {}).sort()).toEqual(
      [
        "app_id",
        "applied_at",
        "diff_id",
        "intent",
        "kind",
        "operations",
        "seq",
        "snapshot",
        "undo_target_seq",
      ].sort(),
    );
  });

  test("apply エントリにはスナップショット名が残る(undo の足場・憲法4)", () => {
    runScenario();
    // create_app が書く第0行(_create-app)には「適用前」が存在しないため、
    // ここだけ snapshot が null になる(undo.ts の selectUndoTarget が候補から外す仕様)。
    // undo の足場を持つのは実際に diff を適用した行だけなので、それらだけを見る。
    for (const entry of getChangelog(dataRoot, APP_ID).filter((e) => e.diff_id !== "_create-app")) {
      expect(entry.snapshot).not.toBeNull();
    }
  });
});

describe("getChangelog: アプリ単位の切り分け", () => {
  test("別アプリの履歴が混ざらない", () => {
    seedApp(OTHER_APP_ID, "レシピ帳");
    apply(APP_ID, DIFF_1);
    apply(OTHER_APP_ID, DIFF_2);
    apply(APP_ID, DIFF_3);

    const mine = getChangelog(dataRoot, APP_ID);
    const other = getChangelog(dataRoot, OTHER_APP_ID);

    // 各アプリの第0行(_create-app)も自分のアプリの履歴にだけ現れる。
    expect(mine.map((e) => e.diff_id)).toEqual(["_create-app", "d-001", "d-003"]);
    expect(other.map((e) => e.diff_id)).toEqual(["_create-app", "d-002"]);
    expect(mine.every((e) => e.app_id === APP_ID)).toBe(true);
    expect(other.every((e) => e.app_id === OTHER_APP_ID)).toBe(true);
  });

  test("差分をまだ適用していないアプリでは create_app の第0行だけが返る", () => {
    // beforeEach の seedApp が createApp を呼ぶ時点で第0行(_create-app)が記録されるため、
    // 「diff を1つも適用していない」状態でも changelog は空にはならない(V1-M0-T05)。
    const entries = getChangelog(dataRoot, APP_ID);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.diff_id).toBe("_create-app");
    expect(entries[0]?.snapshot).toBeNull();
  });

  test("存在しないアプリは空配列で誤魔化さず例外にする(憲法6)", () => {
    expect(() => getChangelog(dataRoot, "no-such-app")).toThrow(/no-such-app/);
    expect(() => getChangelog(dataRoot, "no-such-app")).toThrow(/台帳に登録されていません/);
  });

  test("取得は参照系であり、履歴を書き換えない", () => {
    runScenario();
    const first = getChangelog(dataRoot, APP_ID);
    const second = getChangelog(dataRoot, APP_ID);
    expect(second).toEqual(first);
  });
});
