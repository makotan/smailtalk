import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
 * **既定配色ではない。** 既定の `border_color`(`#ddd`)は非テキスト閾値 3:1 を
 * 通らない(ADR-0046 の 2026-07-25 追記「限界7」。実証は本ファイル末尾の
 * 「条件19」の describe)。ここでは枠線を `#767676` に、`#666` 系を `#595959` に
 * 濃くしてある。
 */
function passingTheme(): Theme {
  return {
    slots: {
      danger: "#a00000",
      body_text: "#000000",
      label_text: "#595959",
      placeholder_text: "#595959",
      secondary_text: "#595959",
      border_color: "#767676",
      page_background: "#ffffff",
      highlight_surface: "#f2f2f2",
      // 【V20-M9 / ADR-0474 §1-2】足した4枠(今日の見た目と同じ値 = ページ地色の地に本文の文字色)。
      primary_fill: "#ffffff",
      on_primary: "#000000",
      overlay_background: "#ffffff",
      overlay_text: "#000000",
      body_font: "system-ui, sans-serif",
      note_font_size: "0.875rem",
      secondary_font_size: "0.85em",
      body_line_height: "1.6",
      space_1: "0.25rem",
      space_2: "0.5rem",
      space_3: "0.75rem",
      space_4: "1rem",
      space_5: "1.25rem",
      space_6: "2rem",
      border_width: "1px",
      control_radius: "4px",
      surface_shadow: "none",
      focus_ring: "#005fcc",
      focus_ring_width: "2px",
      // 【V20-M9 / ADR-0474 §1-3】語彙から外した枠。旧(逐語): "--detail-label-width": "8rem",
      // 【V20-M9 / ADR-0474 §1-3】語彙から外した枠。旧(逐語): "--login-max-width": "22rem",
    },
  };
}

/** 2つ目のテーマ(全体差し替えが「置き換え」であることと、undo/redo の往復を見るため)。 */
function secondTheme(): Theme {
  const theme = passingTheme();
  theme.slots.space_1 = "0.5rem";
  theme.slots.control_radius = "0";
  theme.slots.danger = "#b00020";
  theme.origin = { template_app_id: "org-theme", template_diff_id: "d-0007" };
  return theme;
}

/**
 * **閾値未満のテーマ** —— `border_color` を既定の `#ddd` に戻したもの。
 *
 * `#ddd` は `#ffffff` に対して 1.36:1、`#f2f2f2` に対して 1.21:1 で、
 * 非テキスト閾値 3:1 を下回る(V3-M1-T02 の実測)。**2組が落ちるので errors は2件になる。**
 */
function failingTheme(): Theme {
  const theme = passingTheme();
  theme.slots.border_color = "#ddd";
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
      body_text: "#000",
      secondary_text: "#666",
      label_text: "#666",
      placeholder_text: "#666",
      danger: "#a00",
      page_background: "#fff",
      highlight_surface: "#f2f2f2",
      // 【V20-M9 / ADR-0474 §1-2】足した4枠(今日の見た目と同じ値 = ページ地色の地に本文の文字色)。
      primary_fill: "#fff",
      on_primary: "#000",
      overlay_background: "#fff",
      overlay_text: "#000",
      border_color: "#ddd",
      body_font: "system-ui, sans-serif",
      secondary_font_size: "0.85em",
      note_font_size: "0.875rem",
      body_line_height: "1.6",
      space_1: "0.25rem",
      space_2: "0.5rem",
      space_3: "0.75rem",
      space_4: "1rem",
      space_5: "1.25rem",
      space_6: "2rem",
      border_width: "1px",
      control_radius: "0",
      surface_shadow: "none",
      focus_ring_width: "2px",
      focus_ring: "#005fcc",
      // 【V20-M9 / ADR-0474 §1-3】語彙から外した枠。旧(逐語): "--login-max-width": "22rem",
      // 【V20-M9 / ADR-0474 §1-3】語彙から外した枠。旧(逐語): "--detail-label-width": "8rem",
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
    // 【V20-M9 / ADR-0474 §1-8 の 3】2 → 3(`border_color` × `overlay_background` の小窓の組が増えた)。
    // 旧(逐語): expect(result.errors).toHaveLength(2);
    expect(result.errors).toHaveLength(3);
    for (const error of result.errors) {
      expect(error.path).toBe("/app/theme/slots/border_color");
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
    // 【V20-M9 / ADR-0474 §1-8 の 3(式P14)】既定値で落ちる組は `border_color` の組だけで、2 → 3 組
    // (小窓の組 `border_color` × `overlay_background` を足した。既定の小窓の地色は #fff なので 1.36)。
    // 旧(逐語): `expect(result.errors).toHaveLength(2);` と path 2件、「落ちるのは … 2組だけである」。
    expect(result.errors).toHaveLength(3);
    expect(result.errors.map((error) => error.path)).toEqual([
      "/app/theme/slots/border_color",
      "/app/theme/slots/border_color",
      "/app/theme/slots/border_color",
    ]);
    // 落ちるのは `border_color`(`#ddd`)の3組だけである(比の実測値)。
    // 【V20-M8 / ADR-0473】旧(逐語): errors[0] が "1.36"、errors[1] が "1.21"。組を役割名の名前順に作るので
    // ホバー地色(highlight_surface)の組が先に来る。比は変わらない。
    expect(result.errors[0]?.message).toContain("1.21");
    expect(result.errors[1]?.message).toContain("1.36");
    expect(result.errors[1]?.message).toContain("overlay_background");
    expect(result.errors[2]?.message).toContain("1.36");
    // 拒否なので「全か無か」がここでも成立する。
    expect(captureBytes()).toEqual(before);
  });

  test("枠線を `#767676` まで濃くすると通る(通せる最短の直し方の実測)", () => {
    // **要素別の例外で逃げていない**(ADR-0046 限定4)—— 直したのは値である。
    const theme = defaultsAsTheme();
    theme.slots.border_color = "#767676";
    const result = applyDiff(dataRoot, APP_ID, setThemeDiff("d-0001", theme));
    expect(result.valid, JSON.stringify(result)).toBe(true);
    // **区切り線は既定(`#ddd`)より濃くなる。** これがテーマを指定したときの帰結である。
    expect(readManifestFile().app.theme?.slots.border_color).toBe("#767676");
  });
});

/**
 * **【V20-M8 / ユーザ決定 `D-V20-26` / `ADR-0473`】保存済みの旧名テーマを読み替えない。**
 *
 * `app.theme.slots` のキーは V20-M8 で CSS カスタムプロパティ名(`--color-text` など)から役割名
 * (`body_text` など)に変わった。**旧名で保存されたテーマは読み替えも移行もしない**
 * (`D-V20-26`)。したがって旧名テーマを持つ `manifest.json` は `"stored"` の検証で拒否され、
 * `readCurrentManifest` が例外を投げる —— **そのアプリは開けない。**
 * これは意図した代償であり、穴として `unfixed-holes.md` に書く(H-V20-94)。
 * **読み替えを足して直した日には、下の1本目が反転して赤くなる**(それが直したことの合図である)。
 *
 * **下の旧名25件は「旧名がマニフェストのキーとして残っていないか」を数える除外一覧に入れる**
 * (この test は旧名を持つこと自体が目的である)。
 */
describe("D-V20-26: 旧名のテーマを保存したアプリは開けない(読み替えない)", () => {
  /** V20-M8 より前の形(旧名)で保存されたテーマ。値は `passingTheme()` と同じ。 */
  const LEGACY_SLOTS: Readonly<Record<string, string>> = {
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
    // 【V20-M9 / ADR-0474 §1-3】語彙から外した枠。旧(逐語): "--detail-label-width": "8rem",
    // 【V20-M9 / ADR-0474 §1-3】語彙から外した枠。旧(逐語): "--login-max-width": "22rem",
  };

  let legacyRoot = "";
  const LEGACY_APP_ID = "legacy-theme-app";

  beforeEach(async () => {
    legacyRoot = await mkdtemp(join(tmpdir(), "gp-legacy-theme-"));
  });

  afterEach(async () => {
    await rm(legacyRoot, { recursive: true, force: true });
  });

  function writeStoredManifest(slots: Readonly<Record<string, string>>): void {
    const manifest = baseManifest();
    manifest.app.id = LEGACY_APP_ID;
    (manifest.app as { theme?: Theme }).theme = { slots: { ...slots } };
    const path = appManifestPath(legacyRoot, LEGACY_APP_ID);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(manifest, null, 2));
  }

  test("H-V20-94(旧名テーマのアプリは開けない。直したら反転する): 旧名テーマの manifest.json は readCurrentManifest が例外にする", () => {
    writeStoredManifest(LEGACY_SLOTS);
    let message = "";
    try {
      readCurrentManifest(legacyRoot, LEGACY_APP_ID);
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).toContain("マニフェストとして不正です");
    expect(message).toContain("/app/theme/slots");
    expect(message).toContain("--color-text");
    expect(message).toContain("未知のプロパティ");
  });

  test("陽性対照: 同じ値を役割名で書いた manifest.json は読める", () => {
    writeStoredManifest(passingTheme().slots);
    const manifest = readCurrentManifest(legacyRoot, LEGACY_APP_ID);
    expect(manifest.app.theme?.slots.body_text).toBe("#000000");
    expect(Object.keys(manifest.app.theme?.slots ?? {})).toEqual(Object.keys(passingTheme().slots));
  });
});
