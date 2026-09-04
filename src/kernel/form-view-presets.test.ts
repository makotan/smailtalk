/**
 * form に通した2軸が、**カーネルで実際に運ばれる**ことの検査
 * (`V4-M16-T11` / `ADR-0091` 限定3。**新設ファイル**)。
 *
 * ## なぜ別ファイルにしたか
 *
 * **`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは値が運ばれない** ——
 * `applyViewChanges` は種別ごとの分岐でキーを1つずつ写しており、**分岐に書き足さなければ
 * 「`update_view` は通るが適用後のマニフェストに残らない」状態になる。**
 * これは実在した穴で、`ADR-0076`(`writable_by`)と `ADR-0080`(`representative_field`)が
 * 現にそうなっている(`src/kernel/apply-diff.ts` の `applyViewChanges` 冒頭のコメント)。
 *
 * **本ファイルはその穴を「書けるが効かない」の側から塞ぐ** —— 見るのは
 * **適用後のマニフェストファイルに値が実在すること**であって、拒否されないことではない。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDiff } from "./apply-diff.ts";
import { applyManifest } from "./apply-manifest.ts";
import { createApp } from "./create-app.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { appManifestPath } from "./storage-paths.ts";
import type { Manifest } from "./types.ts";

const APP_ID = "book-tracker";

let dataRoot: string;
let store: KernelMetaStore;

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

function readManifestFile(): Manifest {
  return JSON.parse(readFileSync(appManifestPath(dataRoot, APP_ID), "utf-8")) as Manifest;
}

function formView(): Record<string, unknown> {
  const view = readManifestFile().app.views.find((candidate) => candidate.id === "book-form");
  if (view === undefined) {
    throw new Error("book-form が無い");
  }
  return view as unknown as Record<string, unknown>;
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-form-presets-"));
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

// ---------------------------------------------------------------------------
// (h) `add_view` でも `update_view` でも書けて、**値が実際に残る**
// ---------------------------------------------------------------------------

test("(h) add_view で form に2軸を書ける(値が適用後のマニフェストに残る)", () => {
  const result = applyDiff(dataRoot, APP_ID, {
    diff_id: "d-form-preset-add",
    intent: "入力フォームを足す",
    operations: [
      {
        op: "add_view",
        view: {
          id: "book-form-2",
          type: "form",
          table: "books",
          fields: ["title", "memo"],
          preset_label_placement: "inline",
          preset_field_columns: 2,
          // **`as any` を書いていない** —— `FormView` が2軸を持つようになったので、
          // **型の側でも form に書けることが表れている**(型と正準スキーマが割れていない)。
        },
      },
    ],
  });
  expect(result.valid).toBe(true);
  const view = readManifestFile().app.views.find((candidate) => candidate.id === "book-form-2");
  expect((view as unknown as Record<string, unknown>).preset_label_placement).toBe("inline");
  expect((view as unknown as Record<string, unknown>).preset_field_columns).toBe(2);
});

test("(h) update_view で書いた2軸が、適用後のマニフェストに実際に残る", () => {
  const result = applyDiff(dataRoot, APP_ID, {
    diff_id: "d-form-preset-update",
    intent: "入力フォームの項目名の向きと段組数を選ぶ",
    operations: [
      {
        op: "update_view",
        view: "book-form",
        changes: { preset_label_placement: "stacked", preset_field_columns: 1 },
      },
    ],
  });
  expect(result.valid).toBe(true);
  // **「書けるが効かない」を作っていないことの実測。**
  expect(formView().preset_label_placement).toBe("stacked");
  expect(formView().preset_field_columns).toBe(1);
  // **他のキーは1バイトも動いていない**(キー単位の差し替えである)。
  expect(formView().fields).toEqual(["title", "memo"]);
});

test("(h) 軸ごとに独立して差し替わる(片方だけ書いても他方が消えない)", () => {
  expect(
    applyDiff(dataRoot, APP_ID, {
      diff_id: "d-form-preset-1",
      intent: "向きと段組数を選ぶ",
      operations: [
        {
          op: "update_view",
          view: "book-form",
          changes: { preset_label_placement: "inline", preset_field_columns: 2 },
        },
      ],
    }).valid,
  ).toBe(true);
  expect(
    applyDiff(dataRoot, APP_ID, {
      diff_id: "d-form-preset-2",
      intent: "向きだけ変える",
      operations: [
        { op: "update_view", view: "book-form", changes: { preset_label_placement: "stacked" } },
      ],
    }).valid,
  ).toBe(true);
  expect(formView().preset_label_placement).toBe("stacked");
  // **書かなかった軸は「触らない」**(黙って既定へ戻らない)。
  expect(formView().preset_field_columns).toBe(2);
});

test("(h) form で今日も書けない5軸は update_view でも拒否され、allowed_values に2軸が並ぶ", () => {
  const result = applyDiff(dataRoot, APP_ID, {
    diff_id: "d-form-preset-denied",
    intent: "書けない軸を書いてみる",
    operations: [
      { op: "update_view", view: "book-form", changes: { preset_pager_position: "top" } },
    ],
  });
  expect(result.valid).toBe(false);
  if (result.valid) {
    return;
  }
  // **拒否のエラーに、form で書ける6キーが並ぶ**(`name` / `fields` / 通した2軸 /
  // `custom_css` / `menu_listed`)。**5軸は1つも並ばない。**
  //
  // **【V4-M18-T03 / ADR-0095 限定6 で6キー → 7キーに更新した】** `CHANGE_KEYS_BY_VIEW_TYPE.form`
  // に `modal`(重ねて出す宣言)が加わったので、末尾に1本足した。**5軸(プリセット側)は
  // 今日も1つも並ばない ―— `modal` はプリセット(`preset_` 前置)ではない。**
  // **【V4-M19-T03 / ADR-0118 限定1 で7キー → 8キーに更新した】** `CHANGE_KEYS_BY_VIEW_TYPE.form`
  // に `preset_density`(画面の詰まり具合)が加わったので、末尾に1本足した。**form で書けない
  // 5軸(preset_column_align / preset_column_width / preset_pager_position /
  // preset_image_size / preset_text_preview)は今日も1つも並ばない** —— `preset_density` は
  // form でも書ける9つ目の `preset_` キーである。**本 ADR の増分ではない。**
  // **【V4-M20-T04 / ADR-0102 限定1 / 限定3 で8キー → 9キーに更新した】** `CHANGE_KEYS_BY_VIEW_TYPE.form`
  // に `after_save`(保存が成立したあとに行く画面のID)が加わったので、末尾に1本足した。
  // **門A の本審査(V4-M20 単位D。2回目の審査。判定 = 限定採用)を通った増分である。**
  // **form で書けない5軸(プリセット側)は今日も1つも並ばない** —— `after_save` は
  // `preset_` 前置ではなく、保存後の遷移先を1つ書くキーである。
  expect(result.errors[0]?.allowed_values).toEqual([
    "name",
    "fields",
    "preset_label_placement",
    "preset_field_columns",
    "custom_css",
    "menu_listed",
    "modal",
    "preset_density",
    "after_save",
    // **【`V6-M2-T02` / `K-G3` / `ADR-0289` 限定1・限定4 で9キー → 10キーに更新した】**
    // `CHANGE_KEYS_BY_VIEW_TYPE.form` に `reference_pickers`(参照項目の選び方の、入力画面
    // ごとの上書き)が加わったので、末尾に1本足した。**門A の本審査(`V6-M0` 単位A。
    // 判定 = 限定採用)を通った増分である。**
    // **form で書けない5軸(プリセット側)は今日も1つも並ばない** —— `reference_pickers` は
    // `preset_` 前置ではなく、参照項目の選び方を項目ごとに書くキーである。
    "reference_pickers",
    // **【2026-08-20。`V10-M4-T01` / `NV-G9` / `ADR-0359` §4b 限定1 で10キー → 11キーに
    // 更新した】** `CHANGE_KEYS_BY_VIEW_TYPE.form` に `flow`(一続きの流れの中の段)が
    // 加わったので、末尾に1本足した。**門A の本審査(`V10-M0` 群B。判定 = 限定採用)を
    // 通った増分である。**
    // **form で書けない5軸(プリセット側)は今日も1つも並ばない** —— `flow` は
    // `preset_` 前置ではなく、流れの中の位置を書くキーである。
    // **`form` に置ける段は入力の段だけである**(確認の段は `detail_view` だけ。
    // `ADR-0360` 限定2)—— **その縛りはスキーマの `allOf` が持ち、受付表は持たない。**
    "flow",
  ]);
});

test("(h) form で今日も書けない5軸は add_view でも拒否される", () => {
  for (const preset of [
    { preset_column_align: { title: "left" } },
    { preset_column_width: { title: "wide" } },
    { preset_pager_position: "top" },
    { preset_image_size: "medium" },
    { preset_text_preview: "short" },
  ]) {
    const key = Object.keys(preset)[0] as string;
    const result = applyDiff(dataRoot, APP_ID, {
      diff_id: `d-form-denied-${key}`,
      intent: "書けない軸を書いてみる",
      operations: [
        {
          op: "add_view",
          view: {
            id: `book-form-${key}`,
            type: "form",
            table: "books",
            fields: ["title"],
            ...preset,
            // biome-ignore lint/suspicious/noExplicitAny: 型で弾かれる形を意図的に作るため
          } as any,
        },
      ],
    });
    expect(result.valid, key).toBe(false);
  }
});

test("(h) list_view には2軸を書けないままである(form に通したことで緩んでいない)", () => {
  for (const changes of [
    { preset_label_placement: "stacked" as const },
    { preset_field_columns: 1 as const },
  ]) {
    const result = applyDiff(dataRoot, APP_ID, {
      diff_id: `d-list-denied-${Object.keys(changes)[0]}`,
      intent: "一覧に書いてみる",
      operations: [{ op: "update_view", view: "book-list", changes }],
    });
    expect(result.valid, JSON.stringify(changes)).toBe(false);
  }
});
