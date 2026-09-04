import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDiff } from "./apply-diff.ts";
import { applyManifest } from "./apply-manifest.ts";
import { createApp } from "./create-app.ts";
import { dryRunDiff } from "./dry-run.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { listSnapshots } from "./snapshot.ts";
import { appDbPath, appManifestPath, snapshotDir } from "./storage-paths.ts";
import type { Diff, Manifest, ViewChanges } from "./types.ts";
import { redo, undo } from "./undo.ts";

/**
 * **画面ごとのプリセットに既存機構がそのまま効くことの実証**(V3-M2-T01。完了条件4 / 5)。
 *
 * 上位は `docs/plan/v3/records/v3-m2.md` §2 の V3-M2-T01 節、限定の正は
 * `docs/adr/0050-view-display-presets.md` §3(12点)/ `docs/adr/0051-layout-ledger-f5.md` §3。
 * **手本は `theme-history.test.ts`(V3-M1-T03 段階B)である** —— 5点を1本ずつ示したうえで、
 * **同じアプリの1本の流れ**でも通す。
 *
 * ## 何を実証するか
 *
 * - **完了条件4**: `update_view` でプリセットを差し替えられる。**軸ごとの独立キーなので、
 *   1軸を書いても他軸が消えない**(1キー案なら黙って既定へ戻る = ADR-0050 §2 (c))。
 * - **完了条件5**: **dry_run / changelog / undo / redo / スナップショット**が
 *   既存機構のまま効く。**`DIFF_OPS` は16のまま**であり、プリセット専用の op は無い。
 *
 * ## 何を実証しないか(誇張しない)
 *
 * - **画面が変わることは実証していない。** 表示層への適用は **V3-M2-T02 / T03 / T04** で
 *   あり、本ファイルの時点では**マニフェストにプリセットを書いても画面は1ピクセルも
 *   変わらない。**
 * - **「レイアウトを指定できた」ことは実証していない。** ここで示せるのは
 *   「7つの軸の値がマニフェストに保存され、履歴機構に載る」ことだけである。
 * - **`preset_column_align` / `preset_column_width` のキーに書いたフィールドIDが
 *   `columns` に実在するかは検査していない**(参照整合性検査を1つも足していない)。
 *   実在しないIDを書いても拒否されず、単に当たり先が無いだけである。
 */

const APP_ID = "preset-demo";

let dataRoot: string;
let store: KernelMetaStore;

/** 初期マニフェスト。**プリセットを1つも持たない**(未指定からの後方互換を全ケースの前提にする)。 */
function baseManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "見せ方の実証",
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
        { id: "note-list", type: "list_view", table: "notes", columns: ["title", "body"] },
        { id: "note-detail", type: "detail_view", table: "notes" },
        { id: "note-form", type: "form", table: "notes", fields: ["title", "body"] },
      ],
    },
  };
}

function diffWith(diffId: string, intent: string, ...operations: Diff["operations"]): Diff {
  return { diff_id: diffId, intent, operations };
}

function listPresetDiff(diffId: string, changes: Record<string, unknown>): Diff {
  return {
    diff_id: diffId,
    intent: "一覧の見せ方を選ぶ",
    // biome-ignore lint/suspicious/noExplicitAny: 差分は未検証の入力として渡す形を保つ
    operations: [{ op: "update_view", view: "note-list", changes } as any],
  };
}

function readManifestFile(): Manifest {
  return JSON.parse(readFileSync(appManifestPath(dataRoot, APP_ID), "utf-8")) as Manifest;
}

function readSnapshotManifest(name: string): Manifest {
  return JSON.parse(
    readFileSync(join(snapshotDir(dataRoot, APP_ID, name), "manifest.json"), "utf-8"),
  ) as Manifest;
}

/** ビュー1つを素の連想配列として読む(型の分岐に依存せずキーの有無を見るため)。 */
function viewOf(manifest: Manifest, id: string): Record<string, unknown> {
  const found = manifest.app.views.find((view) => view.id === id);
  expect(found, id).toBeDefined();
  return (found ?? {}) as unknown as Record<string, unknown>;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

type ByteState = {
  manifest: string;
  db: string;
  snapshots: string[];
  changelog: unknown[];
};

function captureBytes(): ByteState {
  return {
    manifest: sha256(appManifestPath(dataRoot, APP_ID)),
    db: sha256(appDbPath(dataRoot, APP_ID)),
    snapshots: listSnapshots(dataRoot, APP_ID),
    changelog: store.listChangelog(APP_ID),
  };
}

function apply(diff: Diff): void {
  const result = applyDiff(dataRoot, APP_ID, diff);
  expect(result.valid, JSON.stringify(result)).toBe(true);
}

const FULL_LIST_PRESET: ViewChanges = {
  preset_column_align: { title: "left", body: "center" },
  preset_column_width: { title: "narrow", body: "wide" },
  preset_pager_position: "both",
  preset_image_size: "thumbnail",
  preset_text_preview: "long",
};

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-preset-history-"));
  store = KernelMetaStore.open(dataRoot);
  createApp(store, "見せ方の実証", { app_id: APP_ID });
  expect(applyManifest(dataRoot, APP_ID, baseManifest()).valid).toBe(true);
});

afterEach(async () => {
  store.close();
  await rm(dataRoot, { recursive: true, force: true });
});

describe("完了条件4: update_view でプリセットを差し替えられる(軸ごとに独立)", () => {
  test("一覧の5軸を書くと、そのままマニフェストに残る", () => {
    apply(listPresetDiff("d-0001", FULL_LIST_PRESET));

    const view = viewOf(readManifestFile(), "note-list");
    expect(view.preset_column_align).toEqual({ title: "left", body: "center" });
    expect(view.preset_column_width).toEqual({ title: "narrow", body: "wide" });
    expect(view.preset_pager_position).toBe("both");
    expect(view.preset_image_size).toBe("thumbnail");
    expect(view.preset_text_preview).toBe("long");
  });

  test("詳細の4軸も同じ op で書ける(プリセット専用の op を作っていない)", () => {
    apply(
      diffWith("d-0001", "詳細の見せ方を選ぶ", {
        op: "update_view",
        view: "note-detail",
        changes: {
          preset_label_placement: "stacked",
          preset_field_columns: 2,
          preset_image_size: "medium",
          preset_text_preview: "short",
        },
      }),
    );

    const view = viewOf(readManifestFile(), "note-detail");
    expect(view.preset_label_placement).toBe("stacked");
    expect(view.preset_field_columns).toBe(2);
    expect(view.preset_image_size).toBe("medium");
    expect(view.preset_text_preview).toBe("short");
  });

  test("1軸だけ差し替えても、他の4軸は1つも消えない(1キー案なら黙って戻る箇所)", () => {
    apply(listPresetDiff("d-0001", FULL_LIST_PRESET));
    apply(listPresetDiff("d-0002", { preset_pager_position: "top" }));

    const view = viewOf(readManifestFile(), "note-list");
    expect(view.preset_pager_position).toBe("top");
    // **書かなかった4軸が残っている。** ここが落ちたら「静かに戻る」形になっており、
    // 憲法6(できないことは正直に言う)に触れる。
    expect(view.preset_column_align).toEqual({ title: "left", body: "center" });
    expect(view.preset_column_width).toEqual({ title: "narrow", body: "wide" });
    expect(view.preset_image_size).toBe("thumbnail");
    expect(view.preset_text_preview).toBe("long");
    // 既存語彙(columns)も巻き添えにならない。
    expect(view.columns).toEqual(["title", "body"]);
  });

  test("列マップは全置換である(同じ軸をもう一度書くと、その軸だけが丸ごと入れ替わる)", () => {
    apply(listPresetDiff("d-0001", FULL_LIST_PRESET));
    apply(listPresetDiff("d-0002", { preset_column_align: { body: "right" } }));

    const view = viewOf(readManifestFile(), "note-list");
    // **同じ軸の中は全置換**(`title` の指定は消える)。軸をまたいだ巻き添えは無い。
    expect(view.preset_column_align).toEqual({ body: "right" });
    expect(view.preset_column_width).toEqual({ title: "narrow", body: "wide" });
  });

  test("プリセットを書いても既存の語彙定数は1つも増えていない(add_field などが従来どおり通る)", () => {
    apply(listPresetDiff("d-0001", FULL_LIST_PRESET));
    apply(
      diffWith("d-0002", "メモに期限を足す", {
        op: "add_field",
        table: "notes",
        field: { id: "due", name: "期限", type: "date" },
      }),
    );

    const manifest = readManifestFile();
    expect(manifest.app.tables[0]?.fields.map((field) => field.id)).toEqual([
      "title",
      "body",
      "due",
    ]);
    expect(viewOf(manifest, "note-list").preset_pager_position).toBe("both");
  });
});

describe("完了条件5: dry_run / changelog / undo / redo / snapshot が既存機構のまま効く", () => {
  test("(i) dry_run_diff の報告にプリセットが出る(本体は1バイトも変わらない)", () => {
    const before = captureBytes();

    const report = dryRunDiff(dataRoot, APP_ID, listPresetDiff("d-0001", FULL_LIST_PRESET));
    expect(report.valid, JSON.stringify(report)).toBe(true);
    if (!report.valid) {
      return;
    }
    expect(viewOf(report.report.manifest, "note-list").preset_pager_position).toBe("both");
    expect(captureBytes()).toEqual(before);
    expect(viewOf(readManifestFile(), "note-list").preset_pager_position).toBeUndefined();
  });

  test("(ii) _changelog に update_view の操作がそのまま載る", () => {
    apply(listPresetDiff("d-0001", FULL_LIST_PRESET));

    // [0] は create_app が書いた第0行なので、今回の apply は [1]。
    const entry = store.listChangelog(APP_ID)[1];
    expect(entry?.diff_id).toBe("d-0001");
    expect(entry?.kind).toBe("apply");
    // **op 専用の記録形を発明していない** —— プリセットの実値がそのまま履歴に載る。
    expect(entry?.operations).toEqual([
      { op: "update_view", view: "note-list", changes: FULL_LIST_PRESET },
    ]);
  });

  test("(iii) undo でプリセットが消える(プリセット無し → 有り → undo)", () => {
    apply(listPresetDiff("d-0001", FULL_LIST_PRESET));
    expect(viewOf(readManifestFile(), "note-list").preset_pager_position).toBe("both");

    expect(undo(dataRoot, APP_ID).valid).toBe(true);

    const view = viewOf(readManifestFile(), "note-list");
    // **キー自体が消える**(空のプリセットが残るのではない)。
    expect(Object.keys(view).filter((key) => key.startsWith("preset_"))).toEqual([]);
  });

  test("(iii-b) 1軸だけの差し替えを undo すると、その軸だけが前の値に戻る", () => {
    apply(listPresetDiff("d-0001", FULL_LIST_PRESET));
    apply(listPresetDiff("d-0002", { preset_pager_position: "top" }));

    expect(undo(dataRoot, APP_ID).valid).toBe(true);

    const view = viewOf(readManifestFile(), "note-list");
    expect(view.preset_pager_position).toBe("both");
    expect(view.preset_column_width).toEqual({ title: "narrow", body: "wide" });
  });

  test("(iv) redo でプリセットが戻る", () => {
    apply(listPresetDiff("d-0001", FULL_LIST_PRESET));
    const afterApply = readManifestFile();

    expect(undo(dataRoot, APP_ID).valid).toBe(true);
    const redone = redo(dataRoot, APP_ID);
    expect(redone.valid, JSON.stringify(redone)).toBe(true);
    expect(readManifestFile()).toEqual(afterApply);
  });

  test("(v) スナップショットにプリセットが含まれる(適用前は含まれない)", () => {
    apply(listPresetDiff("d-0001", FULL_LIST_PRESET));
    const first = listSnapshots(dataRoot, APP_ID).find((name) => name.endsWith("-d-0001"));
    expect(first).toBeDefined();
    expect(
      viewOf(readSnapshotManifest(first ?? ""), "note-list").preset_pager_position,
    ).toBeUndefined();

    apply(
      diffWith("d-0002", "メモに期限を足す", {
        op: "add_field",
        table: "notes",
        field: { id: "due", name: "期限", type: "date" },
      }),
    );
    const second = listSnapshots(dataRoot, APP_ID).find((name) => name.endsWith("-d-0002"));
    expect(second).toBeDefined();
    expect(viewOf(readSnapshotManifest(second ?? ""), "note-list").preset_pager_position).toBe(
      "both",
    );
  });

  test("5点が同じアプリの1本の流れで通る(dry_run → apply → changelog → undo → redo → snapshot)", () => {
    // **1点ずつ別のテストで示すと「同じアプリで通ったのか」が残らない**ので、通しも1本置く
    // (`theme-history.test.ts` と同じ作法)。
    const dry = dryRunDiff(dataRoot, APP_ID, listPresetDiff("d-0001", FULL_LIST_PRESET));
    expect(dry.valid).toBe(true);

    apply(listPresetDiff("d-0001", FULL_LIST_PRESET));
    expect(store.listChangelog(APP_ID).at(-1)?.diff_id).toBe("d-0001");

    apply(listPresetDiff("d-0002", { preset_pager_position: "top" }));
    expect(undo(dataRoot, APP_ID).valid).toBe(true);
    expect(viewOf(readManifestFile(), "note-list").preset_pager_position).toBe("both");
    expect(redo(dataRoot, APP_ID).valid).toBe(true);
    expect(viewOf(readManifestFile(), "note-list").preset_pager_position).toBe("top");

    const beforeSecond = listSnapshots(dataRoot, APP_ID).find((name) => name.endsWith("-d-0002"));
    expect(
      viewOf(readSnapshotManifest(beforeSecond ?? ""), "note-list").preset_pager_position,
    ).toBe("both");
  });
});

describe("越えてはならない線は適用経路でも守られる(拒否は全か無か)", () => {
  test("enum の外の値を含む差分は拒否され、manifest も changelog も1バイトも変わらない", () => {
    apply(listPresetDiff("d-0001", FULL_LIST_PRESET));
    const before = captureBytes();

    for (const changes of [
      { preset_column_width: { title: "10px" } },
      { preset_column_width: { title: "50%" } },
      { preset_pager_position: "absolute" },
      { preset_image_size: "width: 120px" },
      { preset_field_columns: 3 },
      { preset_css: ".note-list { position: absolute }" },
    ]) {
      const result = applyDiff(dataRoot, APP_ID, listPresetDiff("d-9999", changes));
      expect(result.valid, JSON.stringify(changes)).toBe(false);
    }

    expect(captureBytes()).toEqual(before);
  });
});
