import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDiff, foldOperations } from "./apply-diff.ts";
import { applyManifest } from "./apply-manifest.ts";
import { createApp } from "./create-app.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { planMigration } from "./migrate.ts";
import { generateRequirementsDoc } from "./requirements-doc.ts";
import { appManifestPath } from "./storage-paths.ts";
import type { Diff, Manifest, Theme } from "./types.ts";

/**
 * `set_theme`(16種目の op。ADR-0047 / V3-M1-T03 段階A)の畳み込みと適用経路の検査。
 *
 * **`workflow-fold.test.ts` / `function-fold.test.ts` と同型である** —— 実ディスク・
 * 実DB・実 changelog を使い、モックを1つも置かない。
 *
 * ## ここが担当する範囲(段階A)
 *
 * - `foldOperations` / `applyDiff` が実際にテーマを適用できること(完了条件4)
 * - `planMigration` が MigrationStep を1つも生まないこと(完了条件6)
 * - 新 op を含む changelog に対して `generateRequirementsDoc` が落ちないこと(完了条件5)
 * - `theme` を持たないマニフェストの後方互換(完了条件11 の一部)
 *
 * ## ここが担当しない範囲(段階B)
 *
 * **拒否の「全か無か」の実証(条件8)/ `dry_run_diff` の一致(条件9)/ undo・redo・
 * changelog・スナップショットの5点の実証(条件10)/ 既存 op の挙動が1バイトも
 * 変わらないことの実証(条件11 の残り)は段階B の仕事である。**
 * **したがって本ファイルは「既存機構がそのまま効く」ことを主張していない。**
 *
 * **【2026-07-25 追記。段階B】その実証は `theme-history.test.ts` が持つ。**
 * 本ファイルの上の段落は今も正しい(本ファイルは実証していない)。**どこで実証されて
 * いるかを指す行が無いと、読んだ人が「誰も実証していない」と読むのでここに1行足した。**
 */

const APP_ID = "theme-app";

let dataRoot: string;
let store: KernelMetaStore;

/**
 * 初期マニフェスト。**`theme` キーを持たない** —— 後方互換(`undefined` からの初回適用)の
 * 検査を、特別な前提を作らずに全ケースで兼ねさせるため(`function-fold.test.ts` と同じ作法)。
 */
function baseManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "テーマ検査",
      tables: [
        {
          id: "notes",
          name: "メモ",
          fields: [{ id: "title", name: "題名", type: "text", required: true }],
        },
      ],
      views: [{ id: "note-list", type: "list_view", table: "notes", columns: ["title"] }],
    },
  };
}

/**
 * コントラスト検査を通るテーマ(25スロット)。**既定配色ではない** ——
 * 既定の `--color-border`(`#ddd`)は非テキスト閾値 3:1 を通らない
 * (ADR-0046 の 2026-07-25 追記「限界7」)。
 */
function passingTheme(): Theme {
  return {
    slots: {
      "--color-danger": "#a00000",
      "--color-text": "#000000",
      "--color-text-label": "#595959",
      "--color-text-placeholder": "#595959",
      "--color-text-secondary": "#595959",
      "--color-border": "#767676",
      "--color-page-background": "#ffffff",
      "--color-surface-highlight": "#f2f2f2",
      "--font-family-base": "system-ui, sans-serif",
      "--font-size-note": "0.875rem",
      "--font-size-secondary": "0.85em",
      "--line-height-base": "1.6",
      "--space-1": "0.25rem",
      "--space-2": "0.5rem",
      "--space-3": "0.75rem",
      "--space-4": "1rem",
      "--space-5": "1.25rem",
      "--space-6": "2rem",
      "--border-width": "1px",
      "--control-border-radius": "4px",
      "--surface-shadow": "none",
      "--focus-outline-color": "#005fcc",
      "--focus-outline-width": "2px",
      "--detail-label-width": "8rem",
      "--login-max-width": "22rem",
    },
  };
}

/** 2つ目のテーマ(全体差し替えが「置き換え」であることを見るため、値をずらす)。 */
function otherTheme(): Theme {
  const theme = passingTheme();
  theme.slots["--space-1"] = "0.5rem";
  theme.slots["--control-border-radius"] = "0";
  theme.origin = { template_app_id: "org-theme", template_diff_id: "d-0007" };
  return theme;
}

function diffWith(diffId: string, intent: string, ...operations: Diff["operations"]): Diff {
  return { diff_id: diffId, intent, operations };
}

function readManifestFile(): Manifest {
  return JSON.parse(readFileSync(appManifestPath(dataRoot, APP_ID), "utf-8")) as Manifest;
}

function apply(diff: Diff): { plan: { add_tables: unknown[]; add_fields: unknown[] } } {
  const result = applyDiff(dataRoot, APP_ID, diff);
  expect(result.valid).toBe(true);
  if (!result.valid) {
    throw new Error("apply failed");
  }
  return result as unknown as { plan: { add_tables: unknown[]; add_fields: unknown[] } };
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "smailtalk-theme-fold-"));
  store = KernelMetaStore.open(dataRoot);
  createApp(store, "テーマ検査", { app_id: APP_ID });
  expect(applyManifest(dataRoot, APP_ID, baseManifest()).valid).toBe(true);
});

afterEach(async () => {
  store.close();
  await rm(dataRoot, { recursive: true, force: true });
});

describe("foldOperations: set_theme(ADR-0047 限定3。全体差し替え)", () => {
  test("theme を持たないマニフェストにテーマが生える(後方互換)", () => {
    const current = baseManifest();
    expect(current.app.theme).toBeUndefined();
    const folded = foldOperations(current, [{ op: "set_theme", theme: passingTheme() }]);
    expect(folded.valid).toBe(true);
    if (!folded.valid) {
      return;
    }
    expect(folded.manifest.app.theme).toEqual(passingTheme());
  });

  test("既にテーマがあれば丸ごと置き換わる(差分マージではない)", () => {
    const current = baseManifest();
    current.app.theme = passingTheme();
    const folded = foldOperations(current, [{ op: "set_theme", theme: otherTheme() }]);
    expect(folded.valid).toBe(true);
    if (!folded.valid) {
      return;
    }
    expect(folded.manifest.app.theme).toEqual(otherTheme());
    // 置き換えなので、前のテーマの値は1つも残らない。
    expect(folded.manifest.app.theme?.slots["--space-1"]).toBe("0.5rem");
  });

  test("現行マニフェストも渡した diff も書き換わらない(純粋関数 / 憲法5)", () => {
    const current = baseManifest();
    const theme = passingTheme();
    const folded = foldOperations(current, [{ op: "set_theme", theme }]);
    expect(folded.valid).toBe(true);
    // 現行マニフェストは触られていない。
    expect(current.app.theme).toBeUndefined();
    // 畳み込み後のマニフェストを書き換えても、呼び出し側の diff は動かない
    // (`structuredClone` を積んでいるため。記録された操作と送られた操作がずれない)。
    if (folded.valid && folded.manifest.app.theme !== undefined) {
      folded.manifest.app.theme.slots["--space-1"] = "9rem";
    }
    expect(theme.slots["--space-1"]).toBe("0.25rem");
  });

  test("同じ差分の中で2回 set_theme すると、後の1つが残る(先頭から順に畳む)", () => {
    const folded = foldOperations(baseManifest(), [
      { op: "set_theme", theme: passingTheme() },
      { op: "set_theme", theme: otherTheme() },
    ]);
    expect(folded.valid).toBe(true);
    if (!folded.valid) {
      return;
    }
    expect(folded.manifest.app.theme).toEqual(otherTheme());
  });
});

describe("applyDiff: set_theme が実ディスクのマニフェストに書かれる", () => {
  test("manifest.json に theme が入る", () => {
    apply(diffWith("d-0001", "見た目を指定する", { op: "set_theme", theme: passingTheme() }));
    expect(readManifestFile().app.theme).toEqual(passingTheme());
  });

  test("由来つきのテーマも書ける(カーネルは真偽を検証しない)", () => {
    apply(diffWith("d-0002", "組織テーマを写す", { op: "set_theme", theme: otherTheme() }));
    const written = readManifestFile().app.theme;
    expect(written?.origin).toEqual({
      template_app_id: "org-theme",
      template_diff_id: "d-0007",
    });
  });

  test("テーブル・ビュー・レコードの定義は1つも動かない", () => {
    apply(diffWith("d-0003", "見た目を指定する", { op: "set_theme", theme: passingTheme() }));
    const manifest = readManifestFile();
    expect(manifest.app.tables).toEqual(baseManifest().app.tables);
    expect(manifest.app.views).toEqual(baseManifest().app.views);
  });
});

describe("完了条件6: set_theme は MigrationStep を1つも生まない", () => {
  test("planMigration が steps / add_tables / add_fields / conversions を1件も返さない", () => {
    const current = baseManifest();
    const planned = planMigration(current, current, [{ op: "set_theme", theme: passingTheme() }]);
    expect(planned.valid).toBe(true);
    if (!planned.valid) {
      return;
    }
    expect(planned.plan.steps ?? []).toEqual([]);
    expect(planned.plan.add_tables).toEqual([]);
    expect(planned.plan.add_fields).toEqual([]);
    expect(planned.conversions ?? []).toEqual([]);
    expect(planned.uniqueChecks ?? []).toEqual([]);
  });

  test("applyDiff が返す plan も空である", () => {
    const result = apply(
      diffWith("d-0004", "見た目を指定する", { op: "set_theme", theme: passingTheme() }),
    );
    expect(result.plan.add_tables).toEqual([]);
    expect(result.plan.add_fields).toEqual([]);
  });
});

describe("完了条件5: 新 op を含む changelog でも要件定義書の生成が落ちない", () => {
  test("generateRequirementsDoc が set_theme を含む履歴を生成できる", () => {
    apply(diffWith("d-0005", "見た目を指定する", { op: "set_theme", theme: passingTheme() }));
    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    // **落ちないことが主眼である**(`requirements-doc.ts` の3つの switch のうち2つは
    // 黙って無視する = silent。落とすと `要件定義書の生成を中止しました` で fail-closed する)。
    expect(doc.statements.length).toBeGreaterThan(0);
    // 履歴節は「N 番目の操作は set_theme である」を述べる(`diff_op` の語彙は
    // `DIFF_OPS` から来るので自動追随する)。
    const operationTexts = doc.statements
      .filter((statement) => statement.template === "history.operation")
      .map((statement) => statement.text);
    expect(operationTexts.some((text) => text.includes("set_theme"))).toBe(true);
  });

  test("テーマの中身を述べる記述は1つも無い(述べていないことを、述べていないと固定する)", () => {
    apply(diffWith("d-0006", "見た目を指定する", { op: "set_theme", theme: passingTheme() }));
    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    // **要件定義書はテーマの値を1つも語らない** —— ADR-0025 §3 の閉じた union に
    // テンプレートを足していないためである(段階A の判断。記録の限界に書いた)。
    // ここを固定しておかないと、「要件定義書がテーマを説明する」と後から誤読される。
    for (const statement of doc.statements) {
      expect(statement.text).not.toContain("--color-text");
      expect(statement.text).not.toContain("#000000");
    }
    // 操作の**対象**を述べる文も無い(テーマは対象IDを取らないため)。
    expect(doc.statements.map((statement) => statement.template)).not.toContain(
      "history.operation_view",
    );
  });
});
