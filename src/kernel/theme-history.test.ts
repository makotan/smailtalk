import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDiff } from "./apply-diff.ts";
import { applyManifest, readCurrentManifest } from "./apply-manifest.ts";
import { createApp } from "./create-app.ts";
import { dryRunDiff } from "./dry-run.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { listSnapshots } from "./snapshot.ts";
import { appDbPath, appManifestPath, snapshotDir } from "./storage-paths.ts";
import type { Diff, Manifest, Theme } from "./types.ts";
import { redo, undo } from "./undo.ts";

/**
 * **テーマ機構が「効く」ことの実証**(V3-M1-T03 **段階B**。完了条件8 / 9 / 10 / 11 / 19)。
 *
 * 段階A(`theme-fold.test.ts`)は畳み込みと適用経路までを固定した。**本ファイルは
 * 「既存機構がそのまま効く」ことを、アプリを1つ用意して実際に確かめる。**
 * 上位は `docs/plan/v3/records/v3-m1.md` §2 の V3-M1-T03 節、限定の正は
 * `docs/adr/0047-app-theme-manifest.md` §3(限定8 / 限定9)。
 *
 * ## 何を実証するか(完了条件との対応)
 *
 * - **条件8**: 拒否が「**全か無か**」である —— 閾値未満のテーマを含む `apply_diff` を
 *   投げても、`manifest.json` と `app.sqlite` が**1バイトも変わらず**、スナップショットも
 *   `_changelog` も1件も増えない。**バイト列のハッシュで比べる**(件数比較ではない)。
 * - **条件9**: `dry_run_diff` で**同じ判定**が出る(`errors` が完全一致する)。
 * - **条件10(D-4 の充足)**: (i) `dry_run_diff` に出る (ii) `_changelog` に載る
 *   (iii) `undo` で戻る (iv) `redo` で戻る (v) スナップショットに含まれる —— の5点。
 *   **「効くはず」で済ませない。**
 * - **条件11**: `theme` を持たないマニフェストの後方互換と、**既存 op の挙動が変わらないこと。**
 * - **条件19**: **この製品自身の既定配色が自らの検査を通らない**ことの実測
 *   (ADR-0046 の 2026-07-25 追記「限界7」)。
 *
 * ## 何を実証しないか(誇張しない)
 *
 * - **画面が変わることは実証していない。** 表示層への適用は **V3-M1-T04** であり、
 *   本ファイルの時点では**マニフェストにテーマを入れても画面は1ピクセルも変わらない。**
 *   名前の食い違いを塞ぐのは `web/test/theme-slot-parity.test.ts` と
 *   `theme-contrast.test.ts` の照合2本である。
 * - **「読みやすい配色になる」ことは実証していない。** 検査が担保するのは
 *   「閾値未満の配色を適用できないこと」だけである(ADR-0046 §1c)。
 */

const APP_ID = "look-demo";

let dataRoot: string;
let store: KernelMetaStore;

/**
 * 初期マニフェスト。**`theme` キーを持たない** —— 「テーマが無い状態」から始めることで、
 * 後方互換(条件11)を全ケースの前提として兼ねさせる。
 */
function baseManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "見た目の実証",
      tables: [
        {
          id: "notes",
          name: "メモ",
          fields: [
            { id: "title", name: "題名", type: "text", required: true },
            { id: "body", name: "本文", type: "long_text" },
          ],
        },
      ],
      views: [
        { id: "note-list", type: "list_view", table: "notes", columns: ["title"] },
        { id: "note-form", type: "form", table: "notes", fields: ["title", "body"] },
      ],
    },
  };
}

/**
 * **コントラスト検査を通る**テーマ(25スロット全部)。
 *
 * **既定配色ではない。** 既定の `--color-border`(`#ddd`)は非テキスト閾値 3:1 を
 * 通らない(ADR-0046 の 2026-07-25 追記「限界7」。実証は本ファイル末尾の
 * 「条件19」の describe)。ここでは枠線を `#767676` に、`#666` 系を `#595959` に
 * 濃くしてある。
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

/** 2つ目のテーマ(全体差し替えが「置き換え」であることと、undo/redo の往復を見るため)。 */
function secondTheme(): Theme {
  const theme = passingTheme();
  theme.slots["--space-1"] = "0.5rem";
  theme.slots["--control-border-radius"] = "0";
  theme.slots["--color-danger"] = "#b00020";
  theme.origin = { template_app_id: "org-theme", template_diff_id: "d-0007" };
  return theme;
}

/**
 * **閾値未満のテーマ** —— `--color-border` を既定の `#ddd` に戻したもの。
 *
 * `#ddd` は `#ffffff` に対して 1.36:1、`#f2f2f2` に対して 1.21:1 で、
 * 非テキスト閾値 3:1 を下回る(V3-M1-T02 の実測)。**2組が落ちるので errors は2件になる。**
 */
function failingTheme(): Theme {
  const theme = passingTheme();
  theme.slots["--color-border"] = "#ddd";
  return theme;
}

/**
 * **`web/src/styles.css` の `:root` の既定値をそのままテーマにしたもの**(条件19)。
 *
 * 値の出所は `docs/plan/v3/03-token-slot-inventory.md` §9-1 の確定表(V3-M1-T01)である。
 * **テーマ対象外の3件(`--shell-max-width` / `--border-style` / `--focus-outline-style`)は
 * 含まない** —— `$defs/theme` に無いキーは `additionalProperties: false` で拒否される。
 */
function defaultsAsTheme(): Theme {
  return {
    slots: {
      "--color-text": "#000",
      "--color-text-secondary": "#666",
      "--color-text-label": "#666",
      "--color-text-placeholder": "#666",
      "--color-danger": "#a00",
      "--color-page-background": "#fff",
      "--color-surface-highlight": "#f2f2f2",
      "--color-border": "#ddd",
      "--font-family-base": "system-ui, sans-serif",
      "--font-size-secondary": "0.85em",
      "--font-size-note": "0.875rem",
      "--line-height-base": "1.6",
      "--space-1": "0.25rem",
      "--space-2": "0.5rem",
      "--space-3": "0.75rem",
      "--space-4": "1rem",
      "--space-5": "1.25rem",
      "--space-6": "2rem",
      "--border-width": "1px",
      "--control-border-radius": "0",
      "--surface-shadow": "none",
      "--focus-outline-width": "2px",
      "--focus-outline-color": "#005fcc",
      "--login-max-width": "22rem",
      "--detail-label-width": "8rem",
    },
  };
}

function diffWith(diffId: string, intent: string, ...operations: Diff["operations"]): Diff {
  return { diff_id: diffId, intent, operations };
}

function setThemeDiff(diffId: string, theme: Theme): Diff {
  return diffWith(diffId, "見た目を指定する", { op: "set_theme", theme });
}

function readManifestFile(): Manifest {
  return JSON.parse(readFileSync(appManifestPath(dataRoot, APP_ID), "utf-8")) as Manifest;
}

/** スナップショットの中の `manifest.json`(戻せる状態そのもの)。 */
function readSnapshotManifest(name: string): Manifest {
  return JSON.parse(
    readFileSync(join(snapshotDir(dataRoot, APP_ID, name), "manifest.json"), "utf-8"),
  ) as Manifest;
}

/**
 * **バイト列そのもののハッシュ**。
 *
 * 「1バイトも変わらない」を件数比較や JSON の等価比較で代用しない —— キーの並び替えや
 * 空白の変化も検出したいので、ファイルを Buffer として読んで SHA-256 を取る。
 */
function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

type ByteState = {
  manifest: string;
  manifestBytes: number;
  db: string;
  dbBytes: number;
  snapshots: string[];
  changelog: unknown[];
};

function captureBytes(): ByteState {
  const manifestPath = appManifestPath(dataRoot, APP_ID);
  const dbPath = appDbPath(dataRoot, APP_ID);
  return {
    manifest: sha256(manifestPath),
    manifestBytes: readFileSync(manifestPath).byteLength,
    db: sha256(dbPath),
    dbBytes: readFileSync(dbPath).byteLength,
    snapshots: listSnapshots(dataRoot, APP_ID),
    changelog: store.listChangelog(APP_ID),
  };
}

function apply(diff: Diff): void {
  const result = applyDiff(dataRoot, APP_ID, diff);
  expect(result.valid, JSON.stringify(result)).toBe(true);
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-theme-history-"));
  store = KernelMetaStore.open(dataRoot);
  createApp(store, "見た目の実証", { app_id: APP_ID });
  expect(applyManifest(dataRoot, APP_ID, baseManifest()).valid).toBe(true);
});

afterEach(async () => {
  store.close();
  await rm(dataRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 条件10: 既存機構がそのまま効くことの実証(D-4 の充足。5点)
// ---------------------------------------------------------------------------

describe("完了条件10: dry_run / changelog / undo / redo / snapshot の5点(1つのアプリで実際に確かめる)", () => {
  test("(i) dry_run_diff の報告にテーマが出る(本体は1バイトも変わらない)", () => {
    const before = captureBytes();

    const report = dryRunDiff(dataRoot, APP_ID, setThemeDiff("d-0001", passingTheme()));
    expect(report.valid, JSON.stringify(report)).toBe(true);
    if (!report.valid) {
      return;
    }
    // **`dry-run.ts` は影のデータルート上で本物の `applyDiff` を呼ぶ**ので、
    // 報告のマニフェストは「実際に永続化されたもの」である(予測ではない)。
    expect(report.report.manifest.app.theme).toEqual(passingTheme());
    // ドライランは本体を触らない(`DRY_RUN_NOTE` が主張していることの機械的確認)。
    expect(captureBytes()).toEqual(before);
    expect(readManifestFile().app.theme).toBeUndefined();
  });

  test("(ii) _changelog に set_theme の操作がそのまま載る", () => {
    apply(setThemeDiff("d-0001", passingTheme()));

    const entries = store.listChangelog(APP_ID);
    // [0] は create_app が書いた第0行(`_create-app`)なので、今回の apply は [1]。
    const entry = entries[1];
    expect(entry?.diff_id).toBe("d-0001");
    expect(entry?.kind).toBe("apply");
    // **op 専用の記録形を発明していない** —— `operations` を JSON として持つだけなので
    // テーマの実値がそのまま履歴に載る(D-4 = 全部履歴対象)。
    expect(entry?.operations).toEqual([{ op: "set_theme", theme: passingTheme() }]);
  });

  test("(iii) undo でテーマが元に戻る(テーマ無し → テーマ有り → undo)", () => {
    apply(setThemeDiff("d-0001", passingTheme()));
    expect(readManifestFile().app.theme).toEqual(passingTheme());

    expect(undo(dataRoot, APP_ID).valid).toBe(true);

    // **キーが `undefined` に戻る**(空のテーマが残るのではない)。
    expect(readManifestFile().app.theme).toBeUndefined();
    expect(Object.keys(readManifestFile().app)).not.toContain("theme");
  });

  test("(iii-b) テーマ有り → 別テーマ → undo で1つ前のテーマに戻る", () => {
    apply(setThemeDiff("d-0001", passingTheme()));
    apply(setThemeDiff("d-0002", secondTheme()));
    expect(readManifestFile().app.theme).toEqual(secondTheme());

    expect(undo(dataRoot, APP_ID).valid).toBe(true);

    // 全体差し替えの op なので、**1つ前のテーマが丸ごと戻る**(部分マージではない)。
    expect(readManifestFile().app.theme).toEqual(passingTheme());
  });

  test("(iv) redo でテーマが戻る(undo の直前の状態に丸ごと戻る)", () => {
    apply(setThemeDiff("d-0001", passingTheme()));
    const afterApply = readManifestFile();

    expect(undo(dataRoot, APP_ID).valid).toBe(true);
    expect(readManifestFile().app.theme).toBeUndefined();

    const redone = redo(dataRoot, APP_ID);
    expect(redone.valid, JSON.stringify(redone)).toBe(true);
    expect(readManifestFile()).toEqual(afterApply);
    expect(readManifestFile().app.theme).toEqual(passingTheme());
  });

  test("(v) スナップショットにテーマが含まれる(適用前は含まれず、適用後の次の差分では含まれる)", () => {
    apply(setThemeDiff("d-0001", passingTheme()));
    // `d-0001` のスナップショットは**適用前**の状態 = テーマ無し。
    const first = listSnapshots(dataRoot, APP_ID).find((name) => name.endsWith("-d-0001"));
    expect(first).toBeDefined();
    expect(readSnapshotManifest(first ?? "").app.theme).toBeUndefined();

    // 次の差分のスナップショットは**テーマ有り**の状態を丸ごと持つ
    // (`snapshot.ts` が `manifest.json` をファイルごとコピーするため)。
    apply(
      diffWith("d-0002", "メモに日付を足す", {
        op: "add_field",
        table: "notes",
        field: { id: "due", name: "期限", type: "date" },
      }),
    );
    const second = listSnapshots(dataRoot, APP_ID).find((name) => name.endsWith("-d-0002"));
    expect(second).toBeDefined();
    expect(readSnapshotManifest(second ?? "").app.theme).toEqual(passingTheme());
  });

  test("5点が同じアプリの1本の流れで通る(dry_run → apply → changelog → undo → redo → snapshot)", () => {
    // **1点ずつ別のテストで示すと「同じアプリで通ったのか」が残らない**ので、
    // 通しの流れも1本置く(`cp-*-scenario.test.ts` の作法と同型)。
    const dry = dryRunDiff(dataRoot, APP_ID, setThemeDiff("d-0001", passingTheme()));
    expect(dry.valid).toBe(true);

    apply(setThemeDiff("d-0001", passingTheme()));
    expect(store.listChangelog(APP_ID).at(-1)?.diff_id).toBe("d-0001");

    apply(setThemeDiff("d-0002", secondTheme()));
    expect(undo(dataRoot, APP_ID).valid).toBe(true);
    expect(readManifestFile().app.theme).toEqual(passingTheme());
    expect(redo(dataRoot, APP_ID).valid).toBe(true);
    expect(readManifestFile().app.theme).toEqual(secondTheme());

    const snapshots = listSnapshots(dataRoot, APP_ID);
    const beforeSecond = snapshots.find((name) => name.endsWith("-d-0002"));
    expect(readSnapshotManifest(beforeSecond ?? "").app.theme).toEqual(passingTheme());
  });
});

// ---------------------------------------------------------------------------
// 条件8: 拒否が「全か無か」であること
// ---------------------------------------------------------------------------

describe("完了条件8: 閾値未満のテーマの拒否は「全か無か」(バイト列で比べる)", () => {
  test("manifest.json / app.sqlite が1バイトも変わらず、snapshot も _changelog も増えない", () => {
    // 先に**テーマを1つ持たせ、レコードも入れた**状態を作る —— 「何も無い状態で何も
    // 起きなかった」ではなく、**在るものが1バイトも動かない**ことを示すため。
    apply(setThemeDiff("d-0001", passingTheme()));
    apply(
      diffWith("d-0002", "メモに日付を足す", {
        op: "add_field",
        table: "notes",
        field: { id: "due", name: "期限", type: "date" },
      }),
    );

    const before = captureBytes();
    expect(before.snapshots.length).toBeGreaterThan(0);
    expect(before.changelog.length).toBeGreaterThan(0);

    const result = applyDiff(dataRoot, APP_ID, setThemeDiff("d-0003", failingTheme()));
    expect(result.valid).toBe(false);
    if (result.valid) {
      return;
    }
    // 落ちたのは**コントラスト検査**である(スキーマや参照整合性ではない)。
    expect(result.errors).toHaveLength(2);
    for (const error of result.errors) {
      expect(error.path).toBe("/app/theme/slots/--color-border");
      expect(error.message).toContain("下回ります");
    }

    const after = captureBytes();
    // **バイト列のハッシュとサイズが一致する**(JSON の等価比較で代用していない)。
    expect(after.manifest).toBe(before.manifest);
    expect(after.manifestBytes).toBe(before.manifestBytes);
    expect(after.db).toBe(before.db);
    expect(after.dbBytes).toBe(before.dbBytes);
    // スナップショットは1つも増えていない(`validateManifestFull` は `takeSnapshot` より前)。
    expect(after.snapshots).toEqual(before.snapshots);
    // `_changelog` に行が増えていない。
    expect(after.changelog).toEqual(before.changelog);
    expect(after).toEqual(before);
  });

  test("既存のテーマは書き換わらない(部分適用が無いことの内容側の確認)", () => {
    apply(setThemeDiff("d-0001", passingTheme()));
    const rejected = applyDiff(dataRoot, APP_ID, setThemeDiff("d-0002", failingTheme()));
    expect(rejected.valid).toBe(false);
    // 「枠線だけが書き換わって残りは元のまま」のような**中間状態が無い。**
    expect(readManifestFile().app.theme).toEqual(passingTheme());
  });

  test("同じ差分に既存 op を混ぜても、その既存 op も適用されない(差分全体の拒否)", () => {
    const before = captureBytes();
    const mixed = diffWith(
      "d-0001",
      "見た目と項目を同時に変える",
      { op: "add_field", table: "notes", field: { id: "due", name: "期限", type: "date" } },
      { op: "set_theme", theme: failingTheme() },
    );

    const result = applyDiff(dataRoot, APP_ID, mixed);
    expect(result.valid).toBe(false);

    // **フィールドも増えていない** —— 「テーマだけ拒否して他は通す」ことをしない
    // (ADR-0010 限定7 の作法と同型)。
    expect(readManifestFile().app.tables[0]?.fields.map((f) => f.id)).toEqual(["title", "body"]);
    expect(captureBytes()).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// 条件9: dry_run_diff で同じ判定が出る
// ---------------------------------------------------------------------------

describe("完了条件9: dry_run_diff と apply_diff の判定が一致する", () => {
  test("閾値未満のテーマは dry_run_diff でも拒否され、errors が完全に一致する", () => {
    const diff = setThemeDiff("d-0001", failingTheme());

    const dry = dryRunDiff(dataRoot, APP_ID, diff);
    const applied = applyDiff(dataRoot, APP_ID, diff);

    expect(dry.valid).toBe(false);
    expect(applied.valid).toBe(false);
    if (dry.valid || applied.valid) {
      return;
    }
    // **`dry-run.ts` が影のデータルート上で本物の `applyDiff` を呼ぶので、判定は
    // 構造的に一致する**(追加実装0)。**それでも「一致する」ことをここで1本示す** ——
    // 将来どちらかに独自の前処理が入ったら赤くなる。
    expect(dry.errors).toEqual(applied.errors);
  });

  test("通るテーマは dry_run_diff でも通り、報告のマニフェストが apply 後と一致する", () => {
    const diff = setThemeDiff("d-0001", passingTheme());

    const dry = dryRunDiff(dataRoot, APP_ID, diff);
    expect(dry.valid).toBe(true);
    apply(diff);

    if (!dry.valid) {
      return;
    }
    expect(dry.report.manifest).toEqual(readManifestFile());
    // テーマは物理スキーマに影響しないので、影響表は空のままである(条件6 の対)。
    expect(dry.report.plan.add_tables).toEqual([]);
    expect(dry.report.plan.add_fields).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 条件11: 後方互換と、既存 op の挙動の不変
// ---------------------------------------------------------------------------

describe("完了条件11: `theme` を持たないマニフェストの後方互換", () => {
  test("theme を持たないマニフェストは valid で、readCurrentManifest が例外を投げない", () => {
    // `$defs/app.required` に `theme` を入れていない(限定2。`workflows` / `functions`
    // と同じ先例)。**入れると既存マニフェストが全部 invalid になる。**
    const current = readCurrentManifest(dataRoot, APP_ID);
    expect(current.app.theme).toBeUndefined();
    expect(Object.keys(current.app)).not.toContain("theme");
    // 読み取り経路(`stored`)で例外にならないことを、実ファイルの読みで示す。
    expect(() => readCurrentManifest(dataRoot, APP_ID)).not.toThrow();
  });

  test("既存 op(add_field)の結果に theme キーが1つも生えない", () => {
    apply(
      diffWith("d-0001", "メモに日付を足す", {
        op: "add_field",
        table: "notes",
        field: { id: "due", name: "期限", type: "date" },
      }),
    );
    const manifest = readManifestFile();
    expect(manifest.app.theme).toBeUndefined();
    expect(readFileSync(appManifestPath(dataRoot, APP_ID), "utf-8")).not.toContain('"theme"');
  });

  test("既存 op はテーマを1バイトも書き換えない(テーマを持つアプリでも)", () => {
    apply(setThemeDiff("d-0001", passingTheme()));
    const themeText = JSON.stringify(readManifestFile().app.theme);

    // additive / 表示設定の差し替え / 破壊的(フィールド削除 + テーブル改名)を1本ずつ通す。
    apply(
      diffWith("d-0002", "メモに日付を足す", {
        op: "add_field",
        table: "notes",
        field: { id: "due", name: "期限", type: "date" },
      }),
    );
    apply(
      diffWith("d-0003", "一覧の列を変える", {
        op: "update_view",
        view: "note-list",
        changes: { columns: ["title", "due"] },
      }),
    );
    // 削除はカーネルが画面から自動で外さないので、先に画面の側を片付ける(既存の作法)。
    apply(
      diffWith("d-0004", "入力欄から本文を外す", {
        op: "update_view",
        view: "note-form",
        changes: { fields: ["title"] },
      }),
    );
    apply(diffWith("d-0005", "本文を消す", { op: "remove_field", table: "notes", field: "body" }));
    apply(
      diffWith("d-0006", "テーブル名を変える", {
        op: "change_table",
        table: "notes",
        changes: { name: "覚書" },
      }),
    );

    expect(JSON.stringify(readManifestFile().app.theme)).toBe(themeText);
    expect(readManifestFile().app.theme).toEqual(passingTheme());
  });

  test("既存 op の拒否の形も変わらない(存在しないテーブルへの add_field)", () => {
    const result = applyDiff(
      dataRoot,
      APP_ID,
      diffWith("d-0001", "無いテーブルに足す", {
        op: "add_field",
        table: "ghosts",
        field: { id: "x", name: "X", type: "text" },
      }),
    );
    expect(result.valid).toBe(false);
    if (result.valid) {
      return;
    }
    // **エラーの形(path / メッセージの断片)に変化が無い** —— 新 op を足したことで
    // 既存 op のエラー文面が動いていないことを1本固定する。
    expect(result.errors[0]?.path).toBe("/operations/0/table");
    expect(result.errors[0]?.message).toContain("ghosts");
  });

  test("undo は theme が無い時代の状態へも戻れる(制約を遡らせていないことの確認)", () => {
    apply(
      diffWith("d-0001", "メモに日付を足す", {
        op: "add_field",
        table: "notes",
        field: { id: "due", name: "期限", type: "date" },
      }),
    );
    apply(setThemeDiff("d-0002", passingTheme()));
    expect(undo(dataRoot, APP_ID).valid).toBe(true);
    expect(undo(dataRoot, APP_ID).valid).toBe(true);
    const manifest = readManifestFile();
    expect(manifest.app.theme).toBeUndefined();
    expect(manifest.app.tables[0]?.fields.map((f) => f.id)).toEqual(["title", "body"]);
  });
});

// ---------------------------------------------------------------------------
// 条件19: 既定配色が自らの検査を通らないことの実測
// ---------------------------------------------------------------------------

describe("完了条件19: この製品自身の既定配色は、自らの検査を通らない(ADR-0046 限界7)", () => {
  test("`styles.css` の既定値をそのままテーマとして投げると、実際に拒否される", () => {
    const before = captureBytes();

    const result = applyDiff(dataRoot, APP_ID, setThemeDiff("d-0001", defaultsAsTheme()));

    // **これは「拒否されるべき」という主張ではなく、実測の記録である。**
    // 既定配色は `web/src/styles.css` にあってマニフェストには無いので、
    // 今日の描画は何も壊れていない(検査は `purpose === "incoming"` にだけ掛かる)。
    // **しかし「既定の見た目をテーマとして表す」ことはできない。**
    // **したがって「テーマで現在の見た目を再現できる」と書いてはならない。**
    expect(result.valid).toBe(false);
    if (result.valid) {
      return;
    }
    expect(result.errors).toHaveLength(2);
    expect(result.errors.map((error) => error.path)).toEqual([
      "/app/theme/slots/--color-border",
      "/app/theme/slots/--color-border",
    ]);
    // 落ちるのは `--color-border`(`#ddd`)の2組だけである(比の実測値)。
    expect(result.errors[0]?.message).toContain("1.36");
    expect(result.errors[1]?.message).toContain("1.21");
    // 拒否なので「全か無か」がここでも成立する。
    expect(captureBytes()).toEqual(before);
  });

  test("枠線を `#767676` まで濃くすると通る(通せる最短の直し方の実測)", () => {
    // **要素別の例外で逃げていない**(ADR-0046 限定4)—— 直したのは値である。
    const theme = defaultsAsTheme();
    theme.slots["--color-border"] = "#767676";
    const result = applyDiff(dataRoot, APP_ID, setThemeDiff("d-0001", theme));
    expect(result.valid, JSON.stringify(result)).toBe(true);
    // **区切り線は既定(`#ddd`)より濃くなる。** これがテーマを指定したときの帰結である。
    expect(readManifestFile().app.theme?.slots["--color-border"]).toBe("#767676");
  });
});
