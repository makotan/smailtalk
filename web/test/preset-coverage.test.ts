/**
 * D-M2-4 の到達率の実測(V3-M2-T06)。
 *
 * 完了条件の正は `docs/plan/v3/records/v3-m2.md` §2 の「V3-M2-T06」節の1、
 * 要求リスト60件の正は `docs/plan/v3/records/v3-m2-t06.md` §2-3、
 * 限定の正は `docs/adr/0050-view-display-presets.md` §3 と `docs/adr/0051-layout-ledger-f5.md` §3。
 *
 * ## 何を測るのか
 *
 * **「こう見せたい」という要求60件のそれぞれについて、実装したプリセットだけで到達したか
 * 否かを判定する。** 要求は `docs/plan/v3/02-preset-inventory.md` §1 の37軸(接地している軸)と
 * §2 の16軸(接地できない軸)の全量に1対1で対応させ(R01〜R53)、残る7件(R54〜R60)は
 * 軸をまたぐ要求である。**「プリセットで実現できそうなものだけを書く」ができない形にしてある。**
 *
 * ## 到達の判定を何で行ったか(**実測の中身**)
 *
 * | # | 何を確かめたか | 手段 |
 * |---|---|---|
 * | (a) | 要求がマニフェストに書けること | `schemas/manifest.schema.json` の `$defs/view` のキーと `enum` の値 |
 * | (b) | 書いた値で **DOM が変わること** | 本ファイルが `office-catalog` を実際に描画して確かめる(happy-dom) |
 * | (c) | その DOM に **当たり先の CSS 規則が実在すること** | `web/src/styles.css` のセレクタと宣言 |
 * | (d) | 要求が書けないこと(未到達側) | `$defs/view` のキー集合が17で閉じ、`additionalProperties: false` であること |
 *
 * ## 本ファイルが測っていないこと(**誇張しないための境界**)
 *
 * 1. **ブラウザの計算値を1つも測っていない。** happy-dom は CSS を解決しないので、
 *    ここで `getComputedStyle` を読んでも何も証明しない。**計算値の実測は
 *    `web/e2e/preset.e2e.ts`(T02 / T03 / T04)が chromium で行っている。**
 *    本ファイルが担うのは「マニフェストの値 → DOM」と「DOM → 規則の実在」の2辺である。
 * 2. **「見やすくなったか」を1件も測っていない。** 測ったのは「指定できたか」だけである。
 * 3. **到達率の数値で合否を判定しない**(D-M2-4)。**閾値を1つも置いていない。**
 *    本ファイルが固定するのは到達件数そのものであり、「何件以上なら合格」という主張はしない。
 * 4. **未到達の46 + 5件のうち、テーマ(V3-M1)で到達しうるものがある**(`elsewhere` 欄)。
 *    **本ファイルはテーマ側での到達を1件も実測していない** —— 測ったのは
 *    「**実装したプリセットだけで**到達したか」だけである(D-M2-4 の問いの形)。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import type { DetailView, ListView, Manifest, View } from "../../src/kernel/types.ts";
import { DetailViewRenderer } from "../src/views/DetailViewRenderer.tsx";
import { ListViewRenderer } from "../src/views/ListViewRenderer.tsx";

const REPO_ROOT = dirname(dirname(import.meta.dir));
const STYLES_PATH = join(dirname(import.meta.dir), "src", "styles.css");
const MANIFEST_SCHEMA_PATH = join(REPO_ROOT, "schemas", "manifest.schema.json");

const css = readFileSync(STYLES_PATH, "utf-8");
// biome-ignore lint/suspicious/noExplicitAny: 正準スキーマの構造を動的に辿るため
const manifestSchema = JSON.parse(readFileSync(MANIFEST_SCHEMA_PATH, "utf-8")) as any;
const viewSchema = manifestSchema.$defs.view;

// ---------------------------------------------------------------------------
// 要求リスト(N = 60)。**正は docs/plan/v3/records/v3-m2-t06.md §2-3 である。**
// ---------------------------------------------------------------------------

type Requirement = {
  /** R01〜R60。記録の表と1対1で対応する。 */
  id: string;
  /** 出所。`02 §x-y` は docs/plan/v3/02-preset-inventory.md の節、`交点` は T06 が書いたもの。 */
  source: string;
  /** 要求文(要旨)。 */
  want: string;
  /** **実装したプリセットだけで到達したか。** */
  reached: boolean;
  /** 到達した場合、どのキーにどの値を書いたか。 */
  by?: { key: string; value: string | number };
  /** 未到達の場合の帰属先(どこへ行けば満たされうるか)。 */
  elsewhere?: string;
};

const REQUIREMENTS: Requirement[] = [
  // --- 02 §1-1 シェル(6軸) --------------------------------------------------
  {
    id: "R01",
    source: "02 §1-1",
    want: "一覧を画面幅いっぱいに使いたい",
    reached: false,
    elsewhere: "D-G6 / V3-M3(--shell-max-width はテーマ対象外の3件の1つ)",
  },
  {
    id: "R02",
    source: "02 §1-1",
    want: "共通ヘッダを帯にして本文と分けたい",
    reached: false,
    elsewhere: "D-G6 / V3-M3",
  },
  {
    id: "R03",
    source: "02 §1-1",
    want: "アプリ画面ヘッダを2段に折り返したい",
    reached: false,
    elsewhere: "D-G6 / V3-M3",
  },
  {
    id: "R04",
    source: "02 §1-1",
    want: "ロール表示をバッジで目立たせたい",
    reached: false,
    elsewhere: "ADR-0050 §1c の (C) 群22軸(門A 未通過)",
  },
  {
    id: "R05",
    source: "02 §1-1",
    want: "本文の書体を明朝系にしたい",
    reached: false,
    elsewhere: "V3-M1 のテーマ --font-family-base(アプリ単位。画面ごとには違えられない)",
  },
  {
    id: "R06",
    source: "02 §1-1",
    want: "リンクの下線をホバー時だけにしたい",
    reached: false,
    elsewhere: "(C) 群22軸",
  },
  // --- 02 §1-2 画面共通(3軸) ------------------------------------------------
  {
    id: "R07",
    source: "02 §1-2",
    want: "画面名を一段大きくしたい",
    reached: false,
    elsewhere: "(C) 群22軸",
  },
  {
    id: "R08",
    source: "02 §1-2",
    want: "補助テキストの薄さを変えたい",
    reached: false,
    elsewhere: "V3-M1 のテーマ --color-text-secondary / --color-text-label",
  },
  {
    id: "R09",
    source: "02 §1-2",
    want: "エラーの赤を組織色に合わせたい",
    reached: false,
    elsewhere: "V3-M1 のテーマ --color-danger",
  },
  // --- 02 §1-3 一覧と列(7軸) ------------------------------------------------
  {
    id: "R10",
    source: "02 §1-3",
    want: "text 型の表示価格の列を右寄せにしたい",
    reached: true,
    by: { key: "preset_column_align", value: "right" },
  },
  {
    id: "R11",
    source: "02 §1-3",
    want: "品名を広く・在庫を狭くしたい",
    reached: true,
    by: { key: "preset_column_width", value: "wide" },
  },
  {
    id: "R12",
    source: "02 §1-3",
    want: "セルを縦中央に揃えたい",
    reached: false,
    elsewhere: "(C) 群22軸",
  },
  {
    id: "R13",
    source: "02 §1-3",
    want: "表を詰めて行数を増やしたい",
    reached: false,
    elsewhere: "V3-M1 のテーマ --space-1 / --space-2",
  },
  {
    id: "R14",
    source: "02 §1-3",
    want: "縦罫を出したい",
    reached: false,
    elsewhere: "(C) 群22軸(--border-style はテーマ対象外)",
  },
  {
    id: "R15",
    source: "02 §1-3",
    want: "行のホバーの反応を強くしたい",
    reached: false,
    elsewhere: "V3-M1 のテーマ --color-surface-highlight",
  },
  {
    id: "R16",
    source: "02 §1-3",
    want: "件数表示を表の下にまとめたい",
    reached: true,
    by: { key: "preset_pager_position", value: "bottom" },
  },
  // --- 02 §1-4 詳細と項目(4軸) ----------------------------------------------
  {
    id: "R17",
    source: "02 §1-4",
    want: "詳細の項目名の欄を広げたい",
    reached: false,
    elsewhere: "V3-M1 のテーマ --detail-label-width",
  },
  {
    id: "R18",
    source: "02 §1-4",
    want: "項目名を値の上に積みたい",
    reached: true,
    by: { key: "preset_label_placement", value: "stacked" },
  },
  {
    id: "R19",
    source: "02 §1-4",
    want: "詳細を2カラムにしたい",
    reached: true,
    by: { key: "preset_field_columns", value: 2 },
  },
  {
    id: "R20",
    source: "02 §1-4",
    want: "詳細の項目の縦間隔を詰めたい",
    reached: false,
    elsewhere: "V3-M1 のテーマ --space-2",
  },
  // --- 02 §1-5 フォームと項目(4軸) ------------------------------------------
  {
    id: "R21",
    source: "02 §1-5",
    want: "フォームの項目の縦間隔を詰めたい",
    reached: false,
    elsewhere: "V3-M1 のテーマ --space-3(門A の判定は却下 = 今日満たせる)",
  },
  {
    id: "R22",
    source: "02 §1-5",
    want: "フォームの項目名を左に置きたい",
    reached: false,
    elsewhere: "form の3軸(門A の判定は保留)",
  },
  {
    id: "R23",
    source: "02 §1-5",
    want: "必須印を * だけにしたい",
    reached: false,
    elsewhere: "form の3軸(保留)",
  },
  {
    id: "R24",
    source: "02 §1-5",
    want: "長文の入力欄を大きくしたい",
    reached: false,
    elsewhere: "form の3軸(保留)",
  },
  // --- 02 §1-6 関連一覧(2軸) ------------------------------------------------
  {
    id: "R25",
    source: "02 §1-6",
    want: "子一覧の表の体裁を本表と揃えたい",
    reached: false,
    elsewhere: "(C) 群22軸 / ADR-0050 §4(軸1〜3 は .related-table に当たらない)",
  },
  {
    id: "R26",
    source: "02 §1-6",
    want: "子一覧の見出しを小さくしたい",
    reached: false,
    elsewhere: "(C) 群22軸",
  },
  // --- 02 §1-7 操作(4軸) ----------------------------------------------------
  {
    id: "R27",
    source: "02 §1-7",
    want: "保存ボタンを目立たせたい",
    reached: false,
    elsewhere: "(C) 群22軸",
  },
  {
    id: "R28",
    source: "02 §1-7",
    want: "操作起点ボタンの間隔を空けたい",
    reached: false,
    elsewhere: "(C) 群22軸",
  },
  {
    id: "R29",
    source: "02 §1-7",
    want: "削除ボタンを右端に離したい",
    reached: false,
    elsewhere: "(C) 群22軸",
  },
  {
    id: "R30",
    source: "02 §1-7",
    want: "閲覧のみ注記を目立たせたい",
    reached: false,
    elsewhere: "(C) 群22軸",
  },
  // --- 02 §1-8 項目の値の見せ方(7軸) ----------------------------------------
  {
    id: "R31",
    source: "02 §1-8",
    want: "未設定をダッシュにしたい",
    reached: false,
    elsewhere: "(C) 群22軸",
  },
  {
    id: "R32",
    source: "02 §1-8",
    want: "一覧の長文をもっと長く出したい",
    reached: true,
    by: { key: "preset_text_preview", value: "long" },
  },
  {
    id: "R33",
    source: "02 §1-8",
    want: "4桁の価格にもカンマを入れたい",
    reached: false,
    elsewhere: "(C) 群22軸",
  },
  {
    id: "R34",
    source: "02 §1-8",
    want: "boolean を文字で出したい",
    reached: false,
    elsewhere: "(C) 群22軸",
  },
  {
    id: "R35",
    source: "02 §1-8",
    want: "日付を和暦・日本語表記にしたい",
    reached: false,
    elsewhere: "(C) 群22軸",
  },
  {
    id: "R36",
    source: "02 §1-8",
    want: "一覧の写真を小さく出したい",
    reached: true,
    by: { key: "preset_image_size", value: "thumbnail" },
  },
  {
    id: "R37",
    source: "02 §1-8",
    want: "参照の値を区別できるようにしたい",
    reached: false,
    elsewhere: "(C) 群22軸 / リンク化は D-G11(V3-M3)",
  },
  // --- 02 §2 接地できない16軸 ------------------------------------------------
  {
    id: "R38",
    source: "02 §2",
    want: "入力欄とボタンの角を丸くしたい",
    reached: false,
    elsewhere: "V3-M1 のテーマ --control-border-radius(当たるのはフォームコントロールだけ)",
  },
  {
    id: "R39",
    source: "02 §2",
    want: "詳細の項目のかたまりを影で浮かせたい",
    reached: false,
    // **旧文言は「テーマ --surface-shadow の当たり先は .login だけ(当て先が無い)」だった。**
    // **V3-FIX-01(2026-07-26)が当たり先を5規則へ広げたので、この文は現に偽になった**
    // (`docs/plan/v3/records/v3-fix-01.md`)。**検査は `elsewhere` が空でないことしか
    // 見ないので赤にはならなかったが、緑のまま意味を失っていたので差し替えた**
    // (V3-M2-T05 が `src/mcp/vocabulary.test.ts` について下したのと同じ判断)。
    // **`reached` は false のままである** —— 影はアプリ単位テーマでしか指定できず、
    // **画面ごとに違えられない**からである(それが「未到達」の中身である)。
    elsewhere:
      "テーマ --surface-shadow(**V3-FIX-01 が当たり先を5規則へ広げた**: .login / .list-table / .detail-fields / .related-table / .record-form)。ただし**アプリ単位でしか指定できず、画面ごとに違えられない**ので未到達のまま",
  },
  {
    id: "R40",
    source: "02 §2",
    want: "フォーカスの枠を太くしたい",
    reached: false,
    elsewhere: "V3-M1 のテーマ --focus-outline-width",
  },
  {
    id: "R41",
    source: "02 §2",
    want: "暗い配色でも見られるようにしたい",
    reached: false,
    elsewhere: "01 §1 スコープ外 / ADR-0046 限定5(@media を1つも足さない)",
  },
  {
    id: "R42",
    source: "02 §2",
    want: "画面幅に応じて段組を変えたい",
    reached: false,
    elsewhere: "01 §1 スコープ外 / ADR-0050 限定9",
  },
  {
    id: "R43",
    source: "02 §2",
    want: "行を開くときにアニメーションを付けたい",
    reached: false,
    elsewhere: "01 §1 スコープ外",
  },
  {
    id: "R44",
    source: "02 §2",
    want: "ボタンを画面の右下に浮かせたい",
    reached: false,
    elsewhere: "越えてはならない線(ADR-0050 限定11)",
  },
  {
    id: "R45",
    source: "02 §2",
    want: "写真を座標で置きたい",
    reached: false,
    elsewhere: "越えてはならない線(ADR-0050 限定11)",
  },
  {
    id: "R46",
    source: "02 §2",
    want: "列見出しを固定したい",
    reached: false,
    elsewhere: "越えてはならない線(position: を1つも足さない)",
  },
  {
    id: "R47",
    source: "02 §2",
    want: "項目ごとに占める段の幅を決めたい",
    reached: false,
    elsewhere: "ADR-0050 §3a 3(既存 enum に値を足す門A)",
  },
  {
    id: "R48",
    source: "02 §2",
    want: "印刷時だけ操作ボタンを消したい",
    reached: false,
    elsewhere: "ADR-0046 限定5(@media を1つも足さない)",
  },
  {
    id: "R49",
    source: "02 §2",
    want: "在庫数を棒グラフで見たい",
    reached: false,
    elsewhere: "F-7'(v3 スコープ外。ユーザ決定 D-8)",
  },
  {
    id: "R50",
    source: "02 §2",
    want: "区分ごとにアイコンを出したい",
    reached: false,
    elsewhere: "(C) 群の外。図像資産の置き場が無い",
  },
  {
    id: "R51",
    source: "02 §2",
    want: "詳細の項目を塊に分けて折りたたみたい",
    reached: false,
    elsewhere: "DOM 階層とグルーピングの表現手段ごと不在",
  },
  {
    id: "R52",
    source: "02 §2",
    want: "列見出しのクリックで並べ替えたい",
    reached: false,
    elsewhere: "ADR-0003 の「ソート状態の保存は作らない」",
  },
  {
    id: "R53",
    source: "02 §2",
    want: "1ページの件数を20件にしたい",
    // **【V4-M22-T05 / ADR-0113。`reached` を動かさない理由を書く】**
    // **`page_size: 20` は今日から書ける。** **それでも `reached` は `false` のままである。**
    // **理由**: **本ファイルが答えている問いは「**実装したプリセットだけで**到達したか」で
    // ある**(冒頭の「本ファイルが測っていないこと」の 4 と同じ形)。**`page_size` は
    // `preset_` キーではなく、当たり先も CSS 規則ではない**(`ADR-0113` §限界7 が
    // 「`preset_` を付けなかった理由は『当たり先が CSS 規則ではないから』」と逐語で
    // 書いている)。**テーマ(`V3-M1`)で到達しうる要求を到達に数えていないのと同じ扱いで
    // ある。** **【禁止】「ページサイズが未到達のままである」と読まない** —— **到達して
    // いないのはプリセットの側だけであり、要求そのものは `ADR-0113` が満たした。**
    reached: false,
    elsewhere:
      "ページサイズ(**2026-08-03 の門A 本審査〔V4-M22 単位C。4回目〕で限定採用。ADR-0113 の `view.page_size`。10 / 20 / 50 / 100 の4値**。プリセットキーではないので本ファイルの到達には数えない)",
  },
  // --- 交点(7件) ------------------------------------------------------------
  {
    id: "R54",
    source: "交点",
    want: "一覧の写真は小さく・詳細は中くらいにしたい",
    reached: true,
    by: { key: "preset_image_size", value: "medium" },
  },
  {
    id: "R55",
    source: "交点",
    want: "詳細の写真と子一覧の写真で大きさを変えたい",
    reached: false,
    elsewhere: "ADR-0050 §4 / §3a 6(related 専用プリセットは別の門A)",
  },
  {
    id: "R56",
    source: "交点",
    want: "1列だけ広げ、他の列は今までの配分のままにしたい",
    reached: false,
    elsewhere: "ADR-0050 限定6 の代償(書いた表は table-layout: fixed になる)",
  },
  {
    id: "R57",
    source: "交点",
    want: "書いたプリセットを書く前の見た目に戻したい",
    reached: false,
    elsewhere: "undo(前進では外せない。§4-11 (k))/ ADR-0050 §3a 3(「既定へ戻す」値の追加は門A)",
  },
  {
    id: "R58",
    source: "交点",
    want: "子一覧の列を右寄せにしたい",
    reached: false,
    elsewhere: "ADR-0050 §4(軸1〜3 は detail_view に書けない)",
  },
  {
    id: "R59",
    source: "交点",
    want: "数値列の見出しも値と同じく右に揃えたい",
    reached: true,
    by: { key: "preset_column_align", value: "right" },
  },
  {
    id: "R60",
    source: "交点",
    want: "効かないプリセットを書いたら教えてほしい",
    reached: false,
    elsewhere: "型 × プリセットの対応検査は1つも無い(§4-11 (l))",
  },
];

const REACHED = REQUIREMENTS.filter((requirement) => requirement.reached);
const UNREACHED = REQUIREMENTS.filter((requirement) => !requirement.reached);

// ---------------------------------------------------------------------------
// 対象アプリ(**本 worktree で新規に作った**。ref-ec は本 worktree に存在しない)
// ---------------------------------------------------------------------------

const APP_ID = "office-catalog";
const ITEM_ID = "item-1";

/** 社内備品カタログ。02 §1 の37軸の当たり先を1つのアプリで覆う形にしてある。 */
function catalogManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "社内備品カタログ",
      tables: [
        {
          id: "vendor",
          name: "取引先",
          fields: [{ id: "vendor_name", name: "取引先名", type: "text", required: true }],
        },
        {
          id: "item",
          name: "備品",
          fields: [
            { id: "item_name", name: "品名", type: "text", required: true },
            { id: "price_label", name: "表示価格", type: "text" },
            { id: "spec", name: "仕様", type: "long_text" },
            { id: "price", name: "価格", type: "number" },
            { id: "in_stock", name: "在庫あり", type: "boolean" },
            { id: "purchased_at", name: "購入日", type: "date" },
            { id: "category", name: "区分", type: "select", options: ["家具", "PC", "文具"] },
            { id: "photo", name: "写真", type: "image" },
            { id: "vendor", name: "取引先", type: "reference", reference_table: "vendor" },
          ],
        },
        {
          id: "delivery",
          name: "納品履歴",
          fields: [
            { id: "item", name: "備品", type: "reference", reference_table: "item" },
            { id: "delivered_on", name: "納品日", type: "date" },
            { id: "delivery_photo", name: "写真", type: "image" },
            { id: "note", name: "メモ", type: "long_text" },
          ],
        },
      ],
      views: [
        {
          id: "item-list",
          type: "list_view",
          table: "item",
          columns: ["photo", "item_name", "category", "price", "price_label", "in_stock", "spec"],
        },
        {
          id: "item-detail",
          type: "detail_view",
          table: "item",
          fields: ["photo", "item_name", "category", "price", "spec", "vendor"],
          related: [
            {
              table: "delivery",
              via: "item",
              columns: ["delivered_on", "delivery_photo", "note"],
            },
          ],
        },
        { id: "item-form", type: "form", table: "item", fields: ["item_name", "price"] },
      ],
    },
  };
}

function pickView<V extends View>(manifest: Manifest, viewId: string): V {
  const view = manifest.app.views.find((candidate) => candidate.id === viewId);
  if (view === undefined) {
    throw new Error(`fixture broken: ${viewId}`);
  }
  return view as V;
}

/** `item-list` にプリセットを書いたマニフェストを作る(要求どおりに「書く」側)。 */
function listWith(presets: Partial<ListView>): Manifest {
  const manifest = catalogManifest();
  Object.assign(pickView<ListView>(manifest, "item-list"), presets);
  return manifest;
}

/** `item-detail` にプリセットを書いたマニフェストを作る。 */
function detailWith(presets: Partial<DetailView>): Manifest {
  const manifest = catalogManifest();
  Object.assign(pickView<DetailView>(manifest, "item-detail"), presets);
  return manifest;
}

const LONG_SPEC = "あ".repeat(120);

const ITEM_ROW = {
  _id: ITEM_ID,
  _created_at: "2026-01-01T00:00:00Z",
  _updated_at: "2026-01-01T00:00:00Z",
  item_name: "会議テーブル",
  price_label: "48,000",
  spec: LONG_SPEC,
  price: 48000,
  in_stock: true,
  purchased_at: "2026-04-01",
  category: "家具",
  photo: "blob-1",
  vendor: "vendor-1",
};

const VENDOR_ROWS = [
  { _id: "vendor-1", _created_at: "", _updated_at: "", vendor_name: "山田商会" },
];

const DELIVERY_ROWS = [
  {
    _id: "delivery-1",
    _created_at: "",
    _updated_at: "",
    item: ITEM_ID,
    delivered_on: "2026-04-05",
    delivery_photo: "blob-2",
    note: LONG_SPEC,
  },
];

/** 一覧の総件数。50 を超えるとページャが出る(`PAGE_SIZE = 50`)。 */
const ITEM_TOTAL = 120;

let originalFetch: typeof fetch;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes(`/tables/item/records/${ITEM_ID}`)) {
      return jsonResponse({ record: ITEM_ROW });
    }
    if (url.includes("/tables/item/records")) {
      return jsonResponse({ records: [ITEM_ROW], total: ITEM_TOTAL });
    }
    if (url.includes("/tables/vendor/records")) {
      return jsonResponse({ records: VENDOR_ROWS, total: VENDOR_ROWS.length });
    }
    if (url.includes("/tables/delivery/records")) {
      return jsonResponse({ records: DELIVERY_ROWS, total: DELIVERY_ROWS.length });
    }
    return jsonResponse({ records: [], total: 0 });
  }) as typeof fetch;
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/item-detail/records/${ITEM_ID}`);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function renderList(manifest: Manifest = catalogManifest()) {
  return render(
    createElement(ListViewRenderer, {
      appId: APP_ID,
      manifest,
      view: pickView<ListView>(manifest, "item-list"),
    }),
  );
}

function renderDetail(manifest: Manifest = catalogManifest()) {
  return render(
    createElement(DetailViewRenderer, {
      appId: APP_ID,
      manifest,
      view: pickView<DetailView>(manifest, "item-detail"),
      recordId: ITEM_ID,
    }),
  );
}

async function findListTable(): Promise<HTMLElement> {
  return await screen.findByTestId("list-table");
}

function listSection(): HTMLElement {
  return screen.getByTestId("view-renderer-list_view");
}

/** `.list-view` の直下の並び(件数表示とページャの位置を見る)。 */
function sectionOrder(): string[] {
  return [...listSection().children].map(
    (child) => child.getAttribute("data-testid") ?? child.tagName.toLowerCase(),
  );
}

/** `web/src/styles.css` に、そのセレクタを持つ規則が実在し、宣言を含むか。 */
function hasRule(selector: string, declaration: string): boolean {
  const index = css.indexOf(selector);
  if (index < 0) {
    return false;
  }
  const body = css.slice(index, css.indexOf("}", index));
  return body.includes(declaration);
}

// ---------------------------------------------------------------------------
// (1) 要求リストそのものの固定(**手順を後から動かせないようにする**)
// ---------------------------------------------------------------------------

describe("要求リスト(N = 60)", () => {
  test("要求は60件で、ID に重複が無い", () => {
    expect(REQUIREMENTS).toHaveLength(60);
    expect(new Set(REQUIREMENTS.map((requirement) => requirement.id)).size).toBe(60);
  });

  test("出所の内訳が 02 の目録と一致する(37 + 16 + 7)", () => {
    const fromInventorySection1 = REQUIREMENTS.filter((requirement) =>
      requirement.source.startsWith("02 §1"),
    );
    const fromInventorySection2 = REQUIREMENTS.filter(
      (requirement) => requirement.source === "02 §2",
    );
    const crossCutting = REQUIREMENTS.filter((requirement) => requirement.source === "交点");
    // 02 §1 の37軸 / §2 の16軸に1対1で対応させている(軸を1つも落としていない)。
    expect(fromInventorySection1).toHaveLength(37);
    expect(fromInventorySection2).toHaveLength(16);
    expect(crossCutting).toHaveLength(7);
  });

  test("到達は9件・未到達は51件(**閾値による合否判定はしない**)", () => {
    // **この数は主張であって基準ではない。** D-M2-4 は「閾値を置かない」と決めており、
    // 本テストは件数が黙って動かないように固定するだけである。
    //
    // **【V4-M22-T05 / ADR-0113。数を動かさなかったことを、理由つきで記録する】**
    // **`page_size` が入ったことで、R53(「1ページの件数を20件にしたい」)は今日から
    // マニフェストに書ける。** **それでも 9 / 51 を1件も動かしていない。**
    // **理由は本ファイルの問いの形である** —— 測っているのは「**実装したプリセットだけで**
    // 到達したか」であり、`page_size` は `preset_` キーではなく当たり先も CSS 規則ではない
    // (`ADR-0113` §限界7)。**テーマ(`V3-M1`)で到達しうる要求を到達に数えていないのと
    // 同じ扱いである**(冒頭の「本ファイルが測っていないこと」の 4)。
    // **【禁止】この 51 を「今日も51件が書けない」と読まない** —— **R53 は書ける。**
    // **R53 の `elsewhere` 欄が、どの ADR が満たしたかを名指ししている。**
    expect(REACHED).toHaveLength(9);
    expect(UNREACHED).toHaveLength(51);
    expect(REACHED.map((requirement) => requirement.id)).toEqual([
      "R10",
      "R11",
      "R16",
      "R18",
      "R19",
      "R32",
      "R36",
      "R54",
      "R59",
    ]);
  });

  test("未到達の51件すべてに帰属先が書いてある(「一部は見送った」で丸めない)", () => {
    for (const requirement of UNREACHED) {
      expect(requirement.elsewhere, requirement.id).toBeDefined();
      expect((requirement.elsewhere ?? "").length, requirement.id).toBeGreaterThan(0);
    }
  });

  test("到達の9件は、実在するプリセットキーの実在する enum 値だけで書かれている", () => {
    for (const requirement of REACHED) {
      const by = requirement.by;
      expect(by, requirement.id).toBeDefined();
      if (by === undefined) {
        continue;
      }
      const property = viewSchema.properties[by.key];
      expect(property, `${requirement.id}: ${by.key}`).toBeDefined();
      // 値そのものの入れ物は2種類ある(画面ごとの enum と、列ごとのマップの値の enum)。
      const values: unknown[] = property.enum ?? property.additionalProperties?.enum ?? [];
      expect(values, `${requirement.id}: ${by.key}`).toContain(by.value);
    }
  });
});

// ---------------------------------------------------------------------------
// (2) 未到達側の実測 —— **「書けない」ことを形で確かめる**
// ---------------------------------------------------------------------------

describe("未到達側: 要求を書き込む場所が無いこと", () => {
  // **【V3-M5-T02 / ADR-0055 による更新。理由を書く】**
  //
  // **「テストが落ちたから直した」のではない。** V3-M5-T00 の門A本審査が D-G5 を
  // **限定採用**し(ADR-0055。限定1 =「`$defs/view` に足すキーは1つだけ。17 → 18」)、
  // **語彙が1キー増えたので、閉じている件数の主張を更新した。**
  //
  // 2箇所を直した:
  // 1. **17 → 18**(件数を消さずに更新する。ADR-0055 限定1 の機械的固定がこれを名指ししている)。
  // 2. **不在キー一覧から `custom_css`(逐語コメント「逃げ道(D-G5 / V3-M5)」)を外した** ——
  //    **今日は実在するので、「無い」と主張し続けると逆向きの嘘になる。**
  //
  // **この更新は「未到達51件のうち何件が書けるようになったか」を1件も主張していない。**
  // 逃げ道で23件が書けるかどうかは V3-M7 の実測であり(ADR-0055 §4 限界8)、
  // **本ファイルの到達9件 / 未到達51件の数は1件も動かしていない。**
  // **【V4-M3-T02 / `B-G1` / ADR-0070 限定1 による更新。理由を書く】**
  //
  // **「テストが落ちたから直した」のではない。** `V4-M0-T02` の門A本審査が `B-G1` を
  // **限定採用**し(ADR-0070。限定1 =「`$defs/view` に足すキーは1本だけ。18 → 19」)、
  // **語彙が1キー増えたので、閉じている件数の主張を更新した。**
  //
  // **この更新は「未到達51件のうち何件が書けるようになったか」を1件も主張していない** ——
  // `audience` は**見せる相手**を書くキーであって**見せ方**を書くキーではないので、
  // **R01〜R55 の未到達のどれ1つも解いていない。** 到達9件 / 未到達51件の数は1件も動かない。
  // **【V4-M10-T45 / `E-G12` / ADR-0084 限定1 による更新。理由を書く】**
  //
  // **「テストが落ちたから直した」のではない。** 再審査 B8 の門A本審査が `E-G12` を
  // **限定採用**し(ADR-0084。限定1 =「`$defs/view` に足すキーは1本だけ。19 → 20」)、
  // **語彙が1キー増えたので、閉じている件数の主張を更新した。**
  //
  // **この更新も「未到達51件のうち何件が書けるようになったか」を1件も主張していない** ——
  // `menu_listed` は**メニューに出すか**を書くキーであって**見せ方**を書くキーではないので、
  // **R01〜R55 の未到達のどれ1つも解いていない。** 到達9件 / 未到達51件の数は1件も動かない。
  // **【V4-M16-T12 / `P-G17` の (C) 側 / ADR-0092 限定1 による更新。理由を書く】**
  //
  // **「テストが落ちたから直した」のではない。** `V4-M14` 本審査② の単位9 が `P-G17` を
  // **限定採用**し(`ADR-0092`。判定 = 限定採用 / 審査記録 =
  // `docs/plan/v4/records/v4-m14-gate-a-field-grouping.md` / ADR =
  // `docs/adr/0092-detail-field-grouping.md`。限定1 =「`$defs/view` に足すキーは1本だけ。
  // 20 → 21」)、**語彙が1キー増えたので、閉じている件数の主張を更新した。**
  //
  // **この更新は「未到達51件のうち何件が書けるようになったか」を1件も主張していない** ——
  // `field_groups` は**どの項目がどのまとまりに属するか**を書くキーであって、**見せ方の軸
  // (罫線・セルの縦位置・日付の表示形・ページサイズ・未設定の表し方…)を1つも解いていない。**
  // **並び順も段組も器の形も指定できない**(`ADR-0092` 限定3 / 限定6)。
  // **到達9件 / 未到達51件の数は1件も動かない。**
  /*
   * **【V4-M16-T13 / `P-G24` の (C) 側 / ADR-0093 限定1 による更新。理由を書く】**
   *
   * **「テストが落ちたから直した」のではない。** `V4-M14` 本審査② の単位11 が `P-G24` を
   * **限定採用**し(判定 = 限定採用 / 審査記録 =
   * `docs/plan/v4/records/v4-m14-gate-a-list-shape.md` / ADR =
   * `docs/adr/0093-list-view-shape.md`。限定1 =「`$defs/view` に足すキーは1本だけ。
   * 21 → 22」)、**語彙が1キー増えたので、閉じている件数の主張を更新した。**
   *
   * **この更新は「未到達51件のうち何件が書けるようになったか」を1件も主張していない** ——
   * `preset_list_shape` は**一覧の器が表かカードか**を書くキーであって、**罫線・セルの縦位置・
   * 日付の表示形・ページサイズ・未設定の表し方といった軸を1つも解いていない。**
   * **選べるのは2値だけである**(`ADR-0093` 限定3)。**到達9件 / 未到達51件の数は1件も動かない。**
   *
   * **【V4-M18-T03 / `P-G14` の (C) 側 / ADR-0095 限定1 による更新。理由を書く】**
   * `V4-M18` 単位3 が `P-G14` を**限定採用**し(判定 = 限定採用 / 審査記録 =
   * `docs/plan/v4/records/v4-m18-gate-a-modal-declaration.md` / ADR =
   * `docs/adr/0095-modal-view-declaration.md`。限定1 =「足すキーは1本だけ。22 → 23」)、
   * **語彙が1キー増えたので、閉じている件数の主張を更新した。**
   * **この更新も「未到達51件のうち何件が書けるようになったか」を1件も主張していない** ——
   * `modal` は**この画面を重ねて出すかの真偽値1つ**であって、**罫線・セルの縦位置・
   * 日付の表示形・ページサイズ・未設定の表し方といった軸を1つも解いていない。**
   * **到達9件 / 未到達51件の数は1件も動かない。**
   */
  // **【V4-M22-T01 / ADR-0112 限定1 で更新した】** `V4-M22` 単位A が `E-G7` の (C) 側を
  // **限定採用**し(判定 = 限定採用 / 審査記録 =
  // `docs/plan/v4/records/v4-m22-gate-a-view-search.md` / ADR = `docs/adr/0112-view-search-fields.md`。
  // 限定1 =「足すキーは1本だけ。実際の増分は23 → 24」)、**語彙が1キー増えたので、閉じている
  // 件数の主張を更新した。**
  // **この更新も「未到達51件のうち何件が書けるようになったか」を1件も主張していない** ——
  // `search_fields` は**検索の対象にする列(実在フィールドIDの配列)1つ**であって、
  // **罫線・セルの縦位置・日付の表示形・ページサイズ・未設定の表し方といった軸を1つも
  // 解いていない。**「ページサイズ」は別タスク(`V4-M22-T05`)の射程であり、ここでは
  // 1件も動かしていない(未到達側の主張の文言は1バイトも消していない)。
  // **到達9件 / 未到達51件の数は1件も動かない。**
  // **【V4-M22-T05 / ADR-0113 限定1 で 24 → 25 に更新した】** 門A の本審査(V4-M22 単位C。
  // **4回目の審査**。判定 = 限定採用)が25キー目 `page_size`(1ページに出す件数)を足した。
  // **本 ADR の増分ではない。**
  // **【重要・正直に書く】** 実装が足したキー名は逐語 `page_size` であって、下の絶対不在
  // リストが書く仮の名前 `preset_page_size` ではない。**したがって「不在」の主張(下の
  // `for` ループ)自体は今日も真だが、それは page_size が実在しないからではなく、
  // 名前が違う架空のキーを検査しているからである。** R53(「1ページの件数を20件にしたい」)は
  // `page_size: 20` で**今日から書ける**。**しかし本ファイルの到達9件 / 未到達51件という
  // 数え上げそのものは、本タスクの指示により1件も動かしていない**(R53 の `reached` は
  // `false` のままである)。**その判断の理由は R53 の定義のところと、到達件数の検査の
  // ところに書いた** —— **本ファイルの問いは「実装したプリセットだけで到達したか」であり、
  // `page_size` はプリセットキーではない。** **ただし `elsewhere` の文言は直した** ——
  // **旧文「門A の判定は保留」は今日から偽だからである**(2026-08-03 に限定採用された)。
  test("$defs/view は25キーで閉じており、未知のキーを書けない", () => {
    // 46件の未到達(R01〜R09 等)は「その軸を表すキーが存在しない」ことに帰着する。
    // **【V4-M19-T03 / ADR-0118 限定1 で 25 → 26 に更新した】** 門A の本審査(V4-M19 単位C。
    // 2回目の審査。前回 = V4-M14 単位7 は却下。判定 = 限定採用)が26キー目 `preset_density`
    // (画面の詰まり具合)を足した。**本 ADR の増分ではない。** **未到達51件のうち何件が
    // 書けるようになったかは1件も主張していない** —— `preset_density` は「詰まり具合」の
    // 軸であって、下の絶対不在リストが表す罫線・セルの縦位置・日付の表示形・ページサイズ・
    // 未設定の表し方のどれも解いていない。
    // **【V4-M20-T04 / ADR-0102 限定1 で 26 → 27 に更新した】** 門A の本審査(V4-M20 単位D。
    // 2回目の審査。判定 = 限定採用)が27キー目 `after_save`(保存が成立したあとに行く画面の
    // ID。form 型のビューでだけ書ける)を足した。**本 ADR の増分ではない。** **未到達51件の
    // うち何件が書けるようになったかは1件も主張していない** —— `after_save` は保存後の
    // 遷移先を書くキーであって、下の絶対不在リストが表す罫線・セルの縦位置・日付の表示形・
    // ページサイズ・未設定の表し方のどれも解いていない。
    // **【V4-M23-T01 / ADR-0104 限定1 で 27 → 28 に更新した】** 門A の本審査(判定 = 限定採用)が
    // 28キー目 `sum_field`(合計を出す列。`list_view` でだけ書ける)を足した。**本 ADR の増分では
    // ない。** **未到達51件のうち何件が書けるようになったかは1件も主張していない** ——
    // `sum_field` は number 型の列1本の合計を出すキーであって、下の絶対不在リストが表す罫線・
    // セルの縦位置・日付の表示形・ページサイズ・未設定の表し方のどれも解いていない。
    // **【`V6-M2-T01` / `K-G2` / `ADR-0289` 限定1 で 28 → 29 に更新した】** 門A の本審査
    // (`V6-M0` 単位A。判定 = 限定採用)が29キー目 `reference_pickers`(参照項目の選び方の、
    // 入力画面ごとの上書き。`form` でだけ書ける)を足した。**本 ADR の増分ではない。**
    // **未到達51件のうち何件が書けるようになったかは1件も主張していない** ——
    // `reference_pickers` は参照項目の選び方を宣言するキーであって、下の絶対不在リストが表す
    // 罫線・セルの縦位置・日付の表示形・ページサイズ・未設定の表し方のどれも解いていない。
    // **【`V8-M20` / 台帳 `J-G27`(判定 = 廃止)/ 手続きは `ADR-0301` で 29 → 28 に更新した】**
    // **本ファイルで期待値が**減る**初めての更新である**(ここまでの更新はすべて増える側だった)。
    // **旧の期待値**: `expect(Object.keys(viewSchema.properties)).toHaveLength(29);`
    // **減った1キーは `audience`(この画面を見せる相手)である** ——
    // **代わりに担うのは `app.roles[].rules` の
    // `{ target: "view", view: <画面ID>, can: ["read"] }` である。**
    // **未到達51件のうち何件が書けるようになった / 書けなくなったかは1件も主張していない** ——
    // **`audience` は「見せる相手」を書くキーであって「見せ方」を書くキーではないので、
    // 下の絶対不在リストが表す罫線・セルの縦位置・日付の表示形・ページサイズ・未設定の
    // 表し方のどれにも触れていない。** **到達9件 / 未到達51件の数は1件も動かない。**
    // **【禁止の履行】これを「語彙が減った」という成果として書かない**(`ADR-0301` 限定10)。
    // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】期待値を 28 → 29 へ書き換えた。**
    // **旧行の逐語**: `expect(Object.keys(viewSchema.properties)).toHaveLength(28);`
    // **書き換えた理由**: この行が固定していたのは「**その決定**が `$defs/view.properties` の本数 を増やさなかったこと」であり、
    // **29本目を足したのは別の決定である**(`V8-M8` が 集計表の宣言 `report` を29キー目として足した)。**検査は消していない。**
    // **【2026-08-20。`V10-M1-T02`。台帳 `NV-G4`。ADR = `0359`】期待値を 29 → 30 へ書き換えた。**
    // **旧行の逐語**: `expect(Object.keys(viewSchema.properties)).toHaveLength(29);`
    // **30本目を足したのは別の決定である**(`ADR-0359` の `after_delete` = 削除の後の
    // 行き先)。**これも「見せ方」を1ミリも表さない** —— **書けるのは行き先のビューID
    // 1つだけで、器の形も線も指定できない。****未到達の主張は1ミリも緩んでいない。**
    // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。門A 本審査 = `V10-M0` 群B。ADR = `0359` / `0360`】**
    // **期待値を 30 → 31 へ書き換えた。****旧行の逐語**: `expect(Object.keys(viewSchema.properties)).toHaveLength(30);`
    // **31本目を足したのは別の決定である**(`ADR-0359` §4b 限定1 が一続きの流れの中の段
    // `flow` を**末尾に**31キー目として足した。**`list_view` / `form` / `detail_view` の3種別で
    // 書け、集計表(`report_view`)には書けない**)。
    // **本ファイルが測っている決定の増分ではない。****検査は消していない。**
    expect(Object.keys(viewSchema.properties)).toHaveLength(31);
    expect(viewSchema.additionalProperties).toBe(false);
    for (const absent of [
      "preset_row_border", // R14 罫線
      "preset_cell_valign", // R12 セルの縦位置
      "preset_date_format", // R35 date の表示形
      "preset_page_size", // R53 ページサイズ(架空の名前。実装名は page_size。上のコメント参照)
      "preset_empty_marker", // R31 未設定の表し方
    ]) {
      expect(Object.keys(viewSchema.properties), absent).not.toContain(absent);
    }
  });

  test("逃げ道の参照(custom_css)は、CSS のバイト列を受ける口ではない(ADR-0055 限定2)", () => {
    // **「逃げ道が実在する」ことと「マニフェストに CSS を書ける」ことは別である。**
    // 未到達51件の帰属先が「書く場所が無い」から「owner が発行した資産を参照する」へ
    // 移りうるのは事実だが、**マニフェスト側は今日も2要素しか受けない。**
    const property = viewSchema.properties.custom_css;
    expect(Object.keys(property.properties)).toEqual(["asset", "digest"]);
    expect(property.additionalProperties).toBe(false);
    // 値に自由文字列(長さや形の制約だけの string)を1つも置いていない。
    expect(property.properties.digest.pattern).toBe("^[0-9a-f]{64}$");
    expect(JSON.stringify(property.properties)).not.toContain('"css"');
  });

  /**
   * **【`V4-M16-T11` / `P-G29` / `ADR-0091` 限定3 で書き換えた】**
   *
   * **着手前の本テストは題「form には7キーとも書けない(R21〜R24 の帰属先が form であること)」
   * で、form 分岐の `false` が7キー全部と一致することを見ていた。**
   * **`ADR-0091`(門A / 判定 = 限定採用)が `preset_label_placement` と
   * `preset_field_columns` の `false` を外したので、その形では実装と食い違う。**
   *
   * **期待値を緩めたのではない** —— **残る5キーの側は着手前と1バイトも同じ判定であり、
   * 通した2キーが form 分岐から消えていることも同時に見る**(両向き)。
   * **`R21`〜`R24` のうち帰属先が form のまま残るものと、`ADR-0091` が解いたものの
   * 切り分けは `docs/adr/0091-form-view-presets.md` 限定3 / 限定5 が持つ。**
   */
  test("form に書けないプリセットは6キーで、通った2キーだけが分岐から消えている", () => {
    const branches = viewSchema.allOf as { if?: unknown; then?: { properties?: unknown } }[];
    const presetKeys = Object.keys(viewSchema.properties).filter((key) =>
      key.startsWith("preset_"),
    );
    // **【V4-M16-T13 / ADR-0093 限定1 で 7 → 8 に更新した】** 着手前は逐語
    // `expect(presetKeys).toHaveLength(7);` だった。**8つ目を足したのは門A の判定である**
    // (判定 = 限定採用 / 審査記録 = `docs/plan/v4/records/v4-m14-gate-a-list-shape.md` /
    // ADR = `docs/adr/0093-list-view-shape.md`)。**form 側は1軸も通っていない** ——
    // **`preset_list_shape` は form 分岐でも `false` である**(限定2)ので、
    // form で書けないプリセットは 5 → 6 になった。
    // **【V4-M19-T03 / ADR-0118 限定1 で 8 → 9 に更新した】** 門A の本審査(V4-M19 単位C。
    // 2回目の審査。判定 = 限定採用)が9つ目の軸 `preset_density`(画面の詰まり具合)を
    // 足した。**`preset_density` は3種すべて(list_view / form / detail_view)に書ける** ——
    // `$defs/view` の `allOf` のどの分岐でも `false` にしていない。**したがって form 側は
    // 今日も1軸も通っていない**(通したのは `ADR-0091` の2軸のままである)。**form で
    // 書けないプリセットは6キーのままで、1つも動いていない。**
    expect(presetKeys).toHaveLength(9);
    const formBranch = branches.find(
      (branch) => JSON.stringify(branch.if).includes('"form"') === true,
    );
    expect(formBranch).toBeDefined();
    const properties = (formBranch?.then?.properties ?? {}) as Record<string, unknown>;
    const denied = Object.entries(properties).filter(
      ([key, value]) => key.startsWith("preset_") && value === false,
    );
    expect(denied.map(([key]) => key).sort()).toEqual([
      "preset_column_align",
      "preset_column_width",
      "preset_image_size",
      // **【V4-M16-T13 / ADR-0093 限定2 で足した6件目】** 8つ目の軸(一覧の器の形)も
      // form には書けない。**列挙を消さずに1行足して更新した。**
      "preset_list_shape",
      "preset_pager_position",
      "preset_text_preview",
    ]);
    // **通した2軸は form 分岐に1つも残っていない**(残っていると「書けるが拒否される」)。
    expect(properties.preset_label_placement).toBeUndefined();
    expect(properties.preset_field_columns).toBeUndefined();
  });

  test("R55: 詳細の写真サイズは子一覧の写真にも当たる(使い分けられない)", async () => {
    renderDetail(detailWith({ preset_image_size: "medium" }));
    const section = await screen.findByTestId("view-renderer-detail_view");
    expect(section.getAttribute("data-preset-image")).toBe("medium");
    // 規則のセレクタは `.detail-view` から始まるので、その中にある `.related-table` の
    // 画像にも当たる。**子一覧だけ別のサイズにする書き場所が無い**(ADR-0050 §4)。
    expect(hasRule('.detail-view[data-preset-image="medium"] .field-image', "max-width")).toBe(
      true,
    );
    await waitFor(() => {
      expect(section.querySelector(".related-table")).not.toBeNull();
    });
    const related = section.querySelector(".related-table") as HTMLElement;
    expect(related.closest("[data-preset-image]")).toBe(section);
    expect(related.getAttribute("data-preset-image")).toBeNull();
  });

  test("R56: 1列だけ幅を書いても、表全体が固定レイアウトになる", async () => {
    renderList(listWith({ preset_column_width: { item_name: "wide" } }));
    const table = await findListTable();
    const cols = [...table.querySelectorAll("col")];
    // `<colgroup>` は表示列の全部ぶん出る(書いた1列だけではない)。
    expect(cols).toHaveLength(7);
    expect(cols.filter((col) => col.hasAttribute("data-preset-width"))).toHaveLength(1);
    // そして `:has()` の規則が表全体に `table-layout: fixed` を掛ける = 残り6列の
    // 幅配分も「今までどおり」ではなくなる(ADR-0050 限定6 の代償)。
    expect(hasRule(".list-table:has(col[data-preset-width])", "table-layout: fixed")).toBe(true);
  });

  test("R57: 書く前の並びを表す enum 値が1つも無い(前進では戻せない)", async () => {
    renderList();
    await findListTable();
    const beforeWriting = sectionOrder();
    cleanup();
    for (const position of ["top", "bottom", "both"] as const) {
      renderList(listWith({ preset_pager_position: position }));
      await findListTable();
      // 3値のどれを書いても、書く前の並びには一致しない。
      expect(sectionOrder(), position).not.toEqual(beforeWriting);
      cleanup();
    }
    // 段組も同じ形である —— 「属性を出さない」を表す enum 値が無い。
    renderDetail();
    const plain = await screen.findByTestId("view-renderer-detail_view");
    expect(plain.querySelector(".detail-fields")?.getAttribute("data-preset-columns")).toBeNull();
    cleanup();
    for (const columns of [1, 2] as const) {
      renderDetail(detailWith({ preset_field_columns: columns }));
      const section = await screen.findByTestId("view-renderer-detail_view");
      expect(
        section.querySelector(".detail-fields")?.getAttribute("data-preset-columns"),
        String(columns),
      ).toBe(String(columns));
      cleanup();
    }
  });

  test("R58: 子一覧の列に寄せが1つも当たらない", async () => {
    // 軸1 は list_view のキーであり、detail_view には書けない(schema の allOf)。
    const detailBranch = (
      viewSchema.allOf as { if?: unknown; then?: { properties?: Record<string, unknown> } }[]
    ).find((branch) => JSON.stringify(branch.if).includes('"detail_view"'));
    expect(detailBranch?.then?.properties?.preset_column_align).toBe(false);
    renderDetail(detailWith({ preset_image_size: "medium" }));
    const section = await screen.findByTestId("view-renderer-detail_view");
    await waitFor(() => {
      expect(section.querySelector(".related-table")).not.toBeNull();
    });
    expect(section.querySelectorAll("[data-preset-align]")).toHaveLength(0);
  });

  test("R60: 効かない組み合わせを書いても、何も起こらず何も言われない", async () => {
    // 写真列を外した一覧に写真サイズを書く。**拒否されず、属性は出るが当たる画像が無い。**
    const manifest = listWith({ preset_image_size: "thumbnail" });
    const view = pickView<ListView>(manifest, "item-list");
    view.columns = ["item_name", "price"];
    renderList(manifest);
    const table = await findListTable();
    expect(listSection().getAttribute("data-preset-image")).toBe("thumbnail");
    expect(table.querySelectorAll(".field-image")).toHaveLength(0);
    // 警告も注記も1つも出ない(型 × プリセットの対応を検査していない。§4-11 (l))。
    expect(listSection().textContent).not.toContain("効きません");
  });
});

// ---------------------------------------------------------------------------
// (3) 到達側の実測 —— **書いた値で DOM が変わり、当たり先の規則が実在する**
// ---------------------------------------------------------------------------

describe("到達側: 9件を1件ずつ実測する", () => {
  test("R10 / R59 列の寄せ —— <th> と <td> の両方に当たる", async () => {
    renderList(listWith({ preset_column_align: { price_label: "right", price: "right" } }));
    const table = await findListTable();
    const headers = [...table.querySelectorAll("thead th")];
    const priceLabelIndex = 4; // columns の並び(photo, item_name, category, price, price_label, ...)
    expect(headers[3]?.getAttribute("data-preset-align")).toBe("right"); // R59 数値列の見出し
    expect(headers[priceLabelIndex]?.getAttribute("data-preset-align")).toBe("right"); // R10
    const cells = [...table.querySelectorAll("tbody tr:first-child td")];
    expect(cells[3]?.getAttribute("data-preset-align")).toBe("right");
    expect(cells[priceLabelIndex]?.getAttribute("data-preset-align")).toBe("right");
    // 書かなかった列には出ない(未指定は今までどおり)。
    expect(headers[1]?.getAttribute("data-preset-align")).toBeNull();
    expect(hasRule('.list-table th[data-preset-align="right"]', "text-align: right")).toBe(true);
  });

  test("R11 列の幅 —— 列ごとに別の段階値が出る", async () => {
    renderList(listWith({ preset_column_width: { item_name: "wide", in_stock: "narrow" } }));
    const table = await findListTable();
    const cols = [...table.querySelectorAll("col")];
    expect(cols[1]?.getAttribute("data-preset-width")).toBe("wide");
    expect(cols[5]?.getAttribute("data-preset-width")).toBe("narrow");
    expect(cols[2]?.hasAttribute("data-preset-width")).toBe(false);
    expect(hasRule('.list-table col[data-preset-width="wide"]', "width")).toBe(true);
    expect(hasRule('.list-table col[data-preset-width="narrow"]', "width")).toBe(true);
  });

  test("R16 ページャ位置 —— 件数表示とページャが表の後ろに移る", async () => {
    renderList(listWith({ preset_pager_position: "bottom" }));
    const table = await findListTable();
    expect(table).toBeDefined();
    expect(sectionOrder()).toEqual(["list-table", "list-total", "list-pager"]);
    expect(listSection().getAttribute("data-preset-pager")).toBe("bottom");
  });

  test("R18 項目名の向き —— 縦積みになる", async () => {
    renderDetail(detailWith({ preset_label_placement: "stacked" }));
    const section = await screen.findByTestId("view-renderer-detail_view");
    expect(section.querySelector(".detail-fields")?.getAttribute("data-preset-label")).toBe(
      "stacked",
    );
    expect(
      hasRule('.detail-fields[data-preset-label="stacked"] .detail-field', "flex-direction"),
    ).toBe(true);
    // 限定8 —— 縦積みのときだけラベル幅の flex-basis を無効化する規則が別にある。
    expect(
      hasRule('.detail-fields[data-preset-label="stacked"] .detail-field dt', "flex: 0 0 auto"),
    ).toBe(true);
  });

  test("R19 段組 —— 2段になる", async () => {
    renderDetail(detailWith({ preset_field_columns: 2 }));
    const section = await screen.findByTestId("view-renderer-detail_view");
    expect(section.querySelector(".detail-fields")?.getAttribute("data-preset-columns")).toBe("2");
    expect(hasRule('.detail-fields[data-preset-columns="2"]', "grid-template-columns")).toBe(true);
  });

  test("R32 切り詰め長 —— 一覧の長文が既定の40字より長く出る", async () => {
    renderList();
    const defaultCell = await screen.findByTestId("field-value-long_text");
    expect(defaultCell.textContent).toBe(`${LONG_SPEC.slice(0, 40)}…`);
    cleanup();
    renderList(listWith({ preset_text_preview: "long" }));
    const longCell = await screen.findByTestId("field-value-long_text");
    expect(longCell.textContent).toBe(`${LONG_SPEC.slice(0, 80)}…`);
    // 全文は今日も出ない(段階値の上限は80字である)。
    expect(longCell.textContent).not.toBe(LONG_SPEC);
    expect(longCell.getAttribute("title")).toBe(LONG_SPEC);
  });

  test("R36 / R54 画像サイズ —— 一覧と詳細で別の段階値を持てる", async () => {
    renderList(listWith({ preset_image_size: "thumbnail" }));
    await findListTable();
    expect(listSection().getAttribute("data-preset-image")).toBe("thumbnail");
    cleanup();
    renderDetail(detailWith({ preset_image_size: "medium" }));
    const section = await screen.findByTestId("view-renderer-detail_view");
    expect(section.getAttribute("data-preset-image")).toBe("medium");
    expect(hasRule('.list-view[data-preset-image="thumbnail"] .field-image', "max-width")).toBe(
      true,
    );
    expect(hasRule('.detail-view[data-preset-image="medium"] .field-image', "max-width")).toBe(
      true,
    );
  });

  test("プリセットを1つも書かなければ DOM に data-preset-* が1つも出ない", async () => {
    renderList();
    const table = await findListTable();
    expect(listSection().querySelectorAll("[data-preset-align]")).toHaveLength(0);
    expect(table.querySelectorAll("col")).toHaveLength(0);
    expect(listSection().getAttribute("data-preset-pager")).toBeNull();
    expect(listSection().getAttribute("data-preset-image")).toBeNull();
    cleanup();
    renderDetail();
    const section = await screen.findByTestId("view-renderer-detail_view");
    expect(section.getAttribute("data-preset-image")).toBeNull();
    const fields = section.querySelector(".detail-fields") as HTMLElement;
    expect(fields.getAttribute("data-preset-label")).toBeNull();
    expect(fields.getAttribute("data-preset-columns")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (4) 「素早く反映」への影響(T06-3。M1 の §4-8 と同じ形)
// ---------------------------------------------------------------------------

/**
 * **カーネルの値を1つも import していない**(ADR-0009 限定2 /
 * `scripts/kernel-import-drift.test.ts`)。**本物のカーネルの拒否を得るために、
 * 既存の CLI 入口(`src/cli/validate.ts`)を別プロセスで呼ぶ。** 呼ぶのは
 * `validateDiff`(差分スキーマの段)と `validateManifestFull`(参照整合性まで含む段)で
 * あり、判定ロジックを本ファイルで作り直していない。
 *
 * **測っているのは往復の「回数」であって、AI が実際にその回数で直せるかではない**
 * (M1 の T07 §2-2 と同じ限界)。
 */
type KernelError = {
  path: string;
  message: string;
  allowed_values?: unknown[];
  hint?: string;
};

const CLI_PATH = join(REPO_ROOT, "src", "cli", "validate.ts");
const TMP_DIR = mkdtempSync(join(tmpdir(), "preset-coverage-"));

function callValidateCli(kind: "diff" | "manifest", value: unknown): KernelError[] {
  const file = join(TMP_DIR, "input.json");
  writeFileSync(file, JSON.stringify(value));
  const result = Bun.spawnSync(
    [process.execPath, "run", CLI_PATH, file, "--kind", kind, "--json"],
    {
      cwd: REPO_ROOT,
    },
  );
  const parsed = JSON.parse(result.stdout.toString()) as {
    valid: boolean;
    errors?: KernelError[];
  };
  return parsed.valid ? [] : (parsed.errors ?? []);
}

// --- JSON ポインタの最小操作(エラーの `path` だけを頼りに直すため) ------------
function tokens(pointer: string): string[] {
  return pointer.split("/").filter((token) => token.length > 0);
}

// biome-ignore lint/suspicious/noExplicitAny: 任意の JSON を指し先として辿るため
function parentOf(root: any, pointer: string): { parent: any; key: string } {
  const path = tokens(pointer);
  const key = path.pop() as string;
  // biome-ignore lint/suspicious/noExplicitAny: 同上
  let node: any = root;
  for (const token of path) {
    node = node[token];
  }
  return { parent: node, key };
}

/**
 * **エラーの `path` / `message` / `allowed_values` だけを入力にして直す**
 * (`src/mcp/error-self-correction.test.ts` と同じ定義)。テスト外の知識を1文字も使わない。
 */
// biome-ignore lint/suspicious/noExplicitAny: 任意の JSON を直すため
function fixFromErrorsOnly(document: any, errors: KernelError[]): void {
  for (const error of errors) {
    const allowed = (error.allowed_values ?? []) as (string | number)[];
    const { parent, key } = parentOf(document, error.path);
    if (error.message.includes("は語彙にありません")) {
      // 値が enum の外。**許可値の先頭に置き換える。**
      parent[key] = allowed[0];
    } else if (error.message.includes("存在しません")) {
      // マップのキーが実在しないフィールドID。**キーだけを許可値の先頭へ写す。**
      const value = parent[key];
      delete parent[key];
      parent[allowed[0] as string] = value;
    } else if (error.message.includes("この種別では指定できません")) {
      // その画面種別に書けないキー。**消すしかない(= 要求そのものを諦める)。**
      delete parent[key];
    } else if (error.message.includes("未知のプロパティ")) {
      // `path` は親を指し、名前は message の中にある。**消すしかない。**
      const name = error.message.match(/"([^"]+)"/)?.[1] as string;
      parent[key][name] = undefined;
      delete parent[key][name];
    } else {
      throw new Error(`未知の拒否種別: ${error.message}`);
    }
  }
}

/** 通るまでに `apply_diff`(相当)を何回呼んだか。 */
function roundTrips(kind: "diff" | "manifest", initial: unknown): number {
  const document = JSON.parse(JSON.stringify(initial));
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const errors = callValidateCli(kind, document);
    if (errors.length === 0) {
      return attempt;
    }
    fixFromErrorsOnly(document, errors);
  }
  throw new Error("8往復でも通らなかった(収束しない)");
}

// M1 の `src/mcp/theme-roundtrip.test.ts` と**同じ `app_id` と同じ intent 文字列**を使う。
// 比較できるようにするためであり、差はオペレーションの中身だけである。
const M1_APP_ID = "roundtrip-shop";
const M1_INTENT = "このアプリの配色をこだわりどおりにしたい、という要望に応えてテーマを指定した";

/** list_view に書ける5軸を全部書いた `update_view` 1操作。 */
function listPresetChanges(): Record<string, unknown> {
  return {
    preset_column_align: { price_label: "right" },
    preset_column_width: { item_name: "wide" },
    preset_pager_position: "bottom",
    preset_image_size: "thumbnail",
    preset_text_preview: "long",
  };
}

/** detail_view に書ける4軸を全部書いた `update_view` 1操作。 */
function detailPresetChanges(): Record<string, unknown> {
  return {
    preset_label_placement: "stacked",
    preset_field_columns: 2,
    preset_image_size: "medium",
    preset_text_preview: "long",
  };
}

function presetDiff(operations: unknown[]): Record<string, unknown> {
  return { diff_id: "d-0001-preset", intent: M1_INTENT, operations };
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf-8");
}

/** 検証に通る完全なマニフェスト(CLI の `--kind manifest` に渡す形)。 */
function catalogDocument(): Record<string, unknown> {
  return JSON.parse(JSON.stringify({ ...catalogManifest() })) as Record<string, unknown>;
}

describe("§4-8 と同じ形の実測: 1往復で何を指定できるか", () => {
  test("1画面ぶんの軸は1往復で全部書ける(list は5軸・detail は4軸)", () => {
    // **画面種別ごとに書ける軸の数が違う**(7軸は「全画面に7つ」ではない)。
    expect(Object.keys(listPresetChanges())).toHaveLength(5);
    expect(Object.keys(detailPresetChanges())).toHaveLength(4);
    const diff = presetDiff([
      { op: "update_view", view: "item-list", changes: listPresetChanges() },
    ]);
    expect(callValidateCli("diff", diff)).toEqual([]);
  });

  test("複数画面のプリセットも1往復で書ける(operations に並べられる)", () => {
    const diff = presetDiff([
      { op: "update_view", view: "item-list", changes: listPresetChanges() },
      { op: "update_view", view: "item-detail", changes: detailPresetChanges() },
    ]);
    expect(callValidateCli("diff", diff)).toEqual([]);
  });

  test("1往復で送る JSON の大きさ(M1 のテーマと同じ測り方)", () => {
    const oneScreen = {
      app_id: M1_APP_ID,
      diff: presetDiff([{ op: "update_view", view: "item-list", changes: listPresetChanges() }]),
    };
    const twoScreens = {
      app_id: M1_APP_ID,
      diff: presetDiff([
        { op: "update_view", view: "item-list", changes: listPresetChanges() },
        { op: "update_view", view: "item-detail", changes: detailPresetChanges() },
      ]),
    };
    const oneAxis = {
      app_id: M1_APP_ID,
      diff: presetDiff([
        { op: "update_view", view: "item-list", changes: { preset_pager_position: "bottom" } },
      ]),
    };
    // **実測値を期待値として固定する**(変わったら差分に出る)。
    expect(bytes(listPresetChanges())).toBe(184);
    expect(bytes(oneScreen)).toBe(438);
    expect(bytes(twoScreens)).toBe(610);
    expect(bytes(oneAxis)).toBe(288);
    // M1 の実測(`src/mcp/theme-roundtrip.test.ts`): テーマ1往復 = 940 バイト。
    // **プリセットは「1軸だけ変えたいときに1軸だけ送れる」** —— テーマは25スロット必須で
    // 変更点の大小と送る量が無関係だった(ADR-0047 追記(2) の代償)。
    expect(bytes(oneAxis)).toBeLessThan(bytes(oneScreen));
  });
});

describe("§4-8 と同じ形の実測: 拒否で何往復増えるか", () => {
  test("(i) 正しく書けば1往復(拒否0回)", () => {
    expect(
      roundTrips(
        "diff",
        presetDiff([{ op: "update_view", view: "item-list", changes: listPresetChanges() }]),
      ),
    ).toBe(1);
  });

  test("(ii) 5軸すべての値を間違えても、5件が1往復で全部返り +1往復で通る", () => {
    const broken = {
      preset_column_align: { price_label: "みぎ" },
      preset_column_width: { item_name: "ひろい" },
      preset_pager_position: "した",
      preset_image_size: "ちいさい",
      preset_text_preview: "ながい",
    };
    const errors = callValidateCli(
      "diff",
      presetDiff([{ op: "update_view", view: "item-list", changes: broken }]),
    );
    expect(errors).toHaveLength(5);
    // **5件とも許可値を持っている**(エラーだけを読んで直せる)。
    for (const error of errors) {
      expect(error.allowed_values, error.path).toBeDefined();
    }
    expect(
      roundTrips("diff", presetDiff([{ op: "update_view", view: "item-list", changes: broken }])),
    ).toBe(2);
  });

  test("(iii) 語彙に無い軸は、エラーだけを読んで直すと通る形に収束しない", () => {
    const diff = presetDiff([
      { op: "update_view", view: "item-list", changes: { preset_row_border: "all" } },
    ]);
    const errors = callValidateCli("diff", diff);
    expect(errors).toHaveLength(1);
    // 許可値には15キーが並ぶが(V3-M5-T02 / ADR-0055 改訂1 で逃げ道の参照が13キー目に、
    // V4-M10-T45 / ADR-0084 限定6 で掲載の可否が14キー目に、**V4-M16-T12 / ADR-0092 限定2 で
    // 詳細画面の項目のまとまりが15キー目に**増えた)、**そのどれも「罫線」を表さない。**
    // **逃げ道は「罫線を語彙で書く」道ではない** —— owner が CSS を書けば罫線は引けるが、
    // それは AI が書ける語彙ではない。**`menu_listed` はなおさら関係が無い。**
    // **`field_groups` も罫線を1ミリも表さない** —— 書けるのは「どの項目がどのまとまりに
    // 属するか」だけで、器の形も線も指定できない(`ADR-0092` 限定6)。**R14 は未到達のままである。**
    // **【V4-M16-T13 / ADR-0093 限定2 で 15 → 16 に更新した】** `update_view` にも16キー目 `preset_list_shape` が加わった(値はカーネルが実際に運ぶ)。
    // **【V4-M18-T03 / ADR-0095 限定6 で 16 → 17 に更新した】** `update_view` にも17キー目
    // `modal` が加わった。**これも「罫線」を1ミリも表さない** —— 真偽値1つで、この画面を
    // 重ねて出すかだけを宣言する。
    // **【V4-M22-T01 / ADR-0112 限定2 で 17 → 18 に更新した】** `update_view` にも18キー目
    // `search_fields` が加わった。**これも「罫線」を1ミリも表さない** —— 検索の対象にする
    // 列(実在フィールドIDの配列)を宣言するだけで、器の形も線も指定できない。
    // **【V4-M22-T05 / ADR-0113 限定2 で 18 → 19 に更新した】** `update_view` にも19キー目
    // `page_size` が加わった(値は `applyViewChanges` の `list_view` 分岐が実際に運ぶ)。
    // **これも「罫線」を1ミリも表さない** —— 1ページに出す件数(4段階値)を宣言するだけで、
    // 器の形も線も指定できない。
    // **【V4-M19-T03 / ADR-0118 限定1 で 19 → 20 に更新した】** `update_view` にも20キー目
    // `preset_density` が加わった(値は `applyViewChanges` の list_view / form / detail_view
    // の3分岐すべてが実際に運ぶ)。**これも「罫線」を1ミリも表さない** —— 画面の詰まり具合
    // (`comfortable` / `compact` の2段階値)を宣言するだけで、罫線も器の形も指定できない。
    // **R14 は今日も未到達のままである。**
    // **【V4-M20-T04 / ADR-0102 限定2 で 20 → 21 に更新した】** `update_view` にも21キー目
    // `after_save`(保存が成立したあとに行く画面のID)が加わった。**これも「罫線」を1ミリも
    // 表さない** —— 保存後の遷移先を宣言するだけで、器の形も線も指定できない。ここでの
    // `allowed_values` は view の型で絞り込まれる前の `view_changes` 全体の列挙であり、
    // `item-list`(list_view)では書けないキーも並ぶ。**R14 は今日も未到達のままである。**
    // **【V4-M23-T01 / ADR-0104 限定2 で 21 → 22 に更新した】** `update_view` にも22キー目
    // `sum_field`(合計を出す列。`list_view` でだけ書ける)が加わった(値は `applyViewChanges` の
    // `list_view` 分岐が実際に運ぶ)。**これも「罫線」を1ミリも表さない** —— number 型の列1本の
    // 合計を出すだけで、器の形も線も指定できない。**R14 は今日も未到達のままである。**
    // **【V5-M21-T03 / `L-G4` / ADR-0172 限定1 で 22 → 23 に更新した】** `update_view` にも
    // 23キー目 `actions`(操作起点。`list_view` / `detail_view` で書ける)が加わった。
    // **これも「罫線」を1ミリも表さない** —— 押すと入力画面へ進むボタンを宣言するだけで、
    // 器の形も線も指定できない。**R14 は今日も未到達のままである。**
    // **【`V6-M2-T02` / `K-G3` / `ADR-0289` 限定1 で 23 → 24 に更新した】** `update_view` にも
    // 24キー目 `reference_pickers`(参照項目の選び方の、入力画面ごとの上書き。`form` でだけ
    // 書ける)が加わった。**これも「罫線」を1ミリも表さない** —— 参照項目をどう選ばせるかを
    // 宣言するだけで、器の形も線も指定できない。**R14 は今日も未到達のままである。**
    // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】24 → 25 に更新した。**
    // **旧行の逐語**: `expect(errors[0]?.allowed_values).toHaveLength(24);`
    // **`update_view` にも25キー目 `report`(集計表の中身。`report_view` でだけ書ける)が
    // 加わった。****これも「罫線」を1ミリも表さない** —— **束ねるキーと集計と絞り込みを
    // 宣言するだけで、器の形も線も指定できない。****R14 は今日も未到達のままである。**
    // **【2026-08-20。`V10-M1-T02`。台帳 `NV-G4`。ADR = `0359` §Decision 2】25 → 26 に更新した。**
    // **旧行の逐語**: `expect(errors[0]?.allowed_values).toHaveLength(25);`
    // **`update_view` にも26キー目 `after_delete`(削除が成立したあとの行き先。
    // `detail_view` でだけ書ける)が加わった。****これも「罫線」を1ミリも表さない。**
    // **R14 は今日も未到達のままである。**
    // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。門A 本審査 = `V10-M0` 群B。ADR = `0359` / `0360`】**
    // **期待値を 26 → 27 へ書き換えた。****旧行の逐語**: `expect(errors[0]?.allowed_values).toHaveLength(26);`
    // **27本目を足したのは別の決定である**(`flow` を `view_changes` の末尾に足した。
    // `ADR-0359` §Decision 2)。**本ファイルが測っている決定の増分ではない。**
    // **検査は消していない。**
    expect(errors[0]?.allowed_values).toHaveLength(27);
    // **エラーだけを読んで直せる手は「消す」しかない。** 消すと `changes` が空になり、
    // 次の往復で別の拒否が返る —— **要求を落とすまで通らない。**
    const document = JSON.parse(JSON.stringify(diff));
    fixFromErrorsOnly(document, errors);
    const second = callValidateCli("diff", document);
    expect(second).toHaveLength(1);
    expect(second[0]?.message).toContain("指定すべき項目がありません");
  });

  test("(iv) 書けない画面種別に書くと +1往復。これも直し方は「消す」である", () => {
    const document = catalogDocument();
    // **【V4-M16-T11 / ADR-0091 限定3 で書き換えた】着手前は `preset_field_columns = 2` を
    // form に書いていた。** **`ADR-0091` がその軸を form に通したので、今日は拒否されない。**
    // **測っているのは「書けない画面種別に書いたときの往復数」であって軸の名前ではない**ので、
    // **form で今日も書けない軸(件数表示とページャの位置)に差し替えた** ——
    // **判定の中身も期待値(1件 / 2往復)も1バイトも変えていない。**
    // biome-ignore lint/suspicious/noExplicitAny: フィクスチャを直に触るため
    ((document as any).app.views[2] as any).preset_pager_position = "top"; // form
    expect(callValidateCli("manifest", document)).toHaveLength(1);
    expect(roundTrips("manifest", document)).toBe(2);
  });

  test("(v) 値の間違いと参照の間違いが同時にあると +2往復(拒否は段階的である)", () => {
    const document = catalogDocument();
    // biome-ignore lint/suspicious/noExplicitAny: 同上
    ((document as any).app.views[0] as any).preset_column_align = { nonexistent_field: "みぎ" };
    const first = callValidateCli("manifest", document);
    // 1往復めに返るのは**値の間違いだけ**(参照整合性の段まで進んでいない)。
    expect(first).toHaveLength(1);
    expect(first[0]?.message).toContain("語彙にありません");
    expect(roundTrips("manifest", document)).toBe(3);
  });

  test("(vi) 実在しないフィールドIDへの寄せは、許可値に実在フィールドが並ぶ", () => {
    const document = catalogDocument();
    // biome-ignore lint/suspicious/noExplicitAny: 同上
    ((document as any).app.views[0] as any).preset_column_align = { nonexistent_field: "right" };
    const errors = callValidateCli("manifest", document);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.allowed_values).toContain("item_name");
    expect(roundTrips("manifest", document)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// V3-M7-T05: `length` だけを固定した検査の穴を1つ塞ぐ
//
// **出所**: `docs/plan/v3/records/v3-m6-t05.md` §11-10 の申し送り。**数え方と全量は
// `docs/plan/v3/records/v3-m7-t05.md` §4。** **本ファイルは3件のうちの1件である。**
//
// **何が素通りしていたか**: 上の「要求は60件で、ID に重複が無い」は **件数と一意性**だけを
// 固定しており、**IDそのものは1つも固定していなかった。** したがって **`R37` を `R37b` へ
// 改名しても、`R37` を消して `R61` を足しても、60件・重複なしのままなら緑だった。**
// 出所の内訳(37 / 16 / 7)も**件数だけ**なので、**要求を1件、群をまたいで移し替えても
// 気づけなかった**(移し替えた分だけ別の要求を逆向きに移せば、両方の件数が保たれる)。
//
// **到達側(REACHED)の9件は既に ID で固定されている**(上の「到達は9件・未到達は51件」)。
// **固定されていなかったのは分母の側である。**
// ---------------------------------------------------------------------------

test("V3-M7-T05: 要求IDの集合を**名前で**固定する(件数60のままの改名・入れ替えを素通りさせない)", () => {
  // R01 〜 R60 が抜けも重複も改名も無く並んでいること。**順序ごと固定する。**
  const expected = Array.from({ length: 60 }, (_, i) => `R${String(i + 1).padStart(2, "0")}`);
  expect(REQUIREMENTS.map((requirement) => requirement.id)).toEqual(expected);
});

test("V3-M7-T05: 出所の内訳を**IDで**固定する(件数 37 / 16 / 7 を保ったままの移し替えを素通りさせない)", () => {
  const idsOf = (predicate: (source: string) => boolean): string[] =>
    REQUIREMENTS.filter((requirement) => predicate(requirement.source)).map(
      (requirement) => requirement.id,
    );
  // **どの要求がどの目録から来たかは、到達率の分母の出所そのものである**(`D-M2-4`)。
  // 群をまたいで移すと「02 §1 の37軸に1対1で対応させている」という主張が黙って偽になる。
  const section1 = idsOf((source) => source.startsWith("02 §1"));
  const section2 = idsOf((source) => source === "02 §2");
  const crossCutting = idsOf((source) => source === "交点");
  // 3群が分母を過不足なく分割している(どの要求もちょうど1つの群に属する)。
  expect([...section1, ...section2, ...crossCutting].sort()).toEqual(
    REQUIREMENTS.map((requirement) => requirement.id).sort(),
  );
  expect(section1).toEqual(REQUIREMENTS.slice(0, 37).map((requirement) => requirement.id));
  expect(section2).toEqual(REQUIREMENTS.slice(37, 53).map((requirement) => requirement.id));
  expect(crossCutting).toEqual(REQUIREMENTS.slice(53, 60).map((requirement) => requirement.id));
});
