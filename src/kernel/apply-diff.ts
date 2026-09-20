/**
 * apply_diff エンジン(V0-P4-T02)。
 *
 * 差分パッチ(`{ diff_id, intent, operations }`)を稼働中のアプリに適用する、
 * 変更モデルの中心となるカーネル内部API。憲法4「常に戻せる。applyの前に必ず
 * スナップショット」と憲法5「差分に意図を残す。changelogが要件定義書」を
 * コードにする場所である。
 *
 * ## 処理順序(計画書 V0-P4-T02 の明示要求)
 *
 * 1. **事前検証**: 差分スキーマ → operations の畳み込み → **適用後マニフェスト**の
 *    フル検証(構造 + 参照整合性)と additive 判定。ここまでは純粋な検査であり、
 *    ファイルもDBも1バイトも触らない
 * 2. **自動スナップショット**(`takeSnapshot`)
 * 3. **マニフェスト更新** / 4. **additive マイグレーション** … 既存の
 *    `applyManifest`(V0-P2-T06)がこの2つを一体で持っているのでそのまま使う
 * 5. **changelog 記録**(intent / operations / スナップショット参照 / `kind: "apply"`)
 *
 * ## 部分適用を残さない
 *
 * 1 で落ちた場合はスナップショットすら取らない(何も起きなかったのと区別がつかない)。
 * 2 以降で落ちた場合は 2 で取ったスナップショットを `restoreSnapshot` で書き戻してから
 * 例外を投げ直す。特に危ないのは「マニフェストとDDLは適用済みだが changelog 追記に
 * 失敗した」状態で、これを放置すると**履歴に現れない変更**が残る(憲法5が壊れる)。
 * 巻き戻し後もスナップショットディレクトリは消さない。失敗の痕跡を黙って消すより、
 * 「戻した元の状態がディスクに残っている」ほうが安全側に倒れるため(憲法6)。
 *
 * ## エラー方針
 *
 * 差分が直せば通る種類の失敗(スキーマ違反・畳み込み異常・参照切れ・diff_id 重複)は
 * 統一形式(`ValidationError[]`)で返す。I/O 失敗や DDL 実行失敗はカーネル/環境側の
 * 異常なので、状態を巻き戻したうえで例外にする(`meta-store.ts` / `snapshot.ts` と同じ方針)。
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { isSystemTableId } from "../shared/system-tables.ts";
import { applyManifest, readCurrentManifest } from "./apply-manifest.ts";
import {
  checkFieldConversions,
  type FieldConversion,
  UNCONVERTIBLE_SAMPLE_LIMIT,
} from "./convert.ts";
import { quoteIdentifier } from "./ddl.ts";
import type { ValidationError } from "./errors.ts";
import { type ChangelogEntry, KernelMetaStore } from "./meta-store.ts";
import { type MigrationPlan, planMigration } from "./migrate.ts";
import { beginApply, endApply, recover } from "./recovery.ts";
import { restoreSnapshot, takeSnapshot } from "./snapshot.ts";
import { appDbPath } from "./storage-paths.ts";
import type {
  DetailView,
  Diff,
  Field,
  FieldChanges,
  FormView,
  FunctionDef,
  ListView,
  Manifest,
  Operation,
  // **画面種別の4種目**(`V8-M8`。台帳 `Q-G1`)。**`applyViewChanges` の分岐が値として使う。**
  ReportView,
  // **【`V17-M5-T04`】表のIDの集合を持つのに使う型。値を1つも増やしていない。**
  ResourceId,
  RoleCondition,
  RoleConditionNotice,
  RoleDeclaration,
  RoleRule,
  RoleRuleVerb,
  Table,
  TableChanges,
  Theme,
  View,
  ViewChanges,
  Workflow,
} from "./types.ts";
// **【`V8-M26-T04`】既定3役割の識別子は `types.ts` の1本を使う**(綴りをここで宣言し直さない)。
import { DEFAULT_ROLE_IDS, renameFilterField } from "./types.ts";
import { MAX_UNDOABLE_DIFF_ID_LENGTH } from "./undo.ts";
import { validateDiff, validateManifestFull } from "./validate.ts";

/**
 * **カーネルが1本の規則へ実際に `when` を書いたことの記録**(`V17-M5-T05` / 台帳 `AC-G33`)。
 *
 * **`export` しない** —— **`scripts/kernel-export-drift.test.ts` の一覧は
 * 「`src/kernel/` の公開エクスポートが増えたか」を見るものであり、
 * 本タスクは公開面を1つも増やさない**(`ADR-0009` の層またぎも0件である)。
 *
 * **`role` / `table` は識別子、`roleIndex` / `ruleIndex` は知らせの `path` を組むための位置である。**
 */
type OwnerScopeSupply = {
  readonly role: ResourceId;
  readonly table: ResourceId;
  readonly roleIndex: number;
  readonly ruleIndex: number;
};

/**
 * `foldOperations` の結果。
 *
 * **【2026-09-08 追記(`V17-M5-T05` / 台帳 `AC-G33`(`:1862`)/ `ADR-0423`)。
 * 旧の1行を逐語で残す】**
 * **旧: `  | { valid: true; manifest: Manifest }`**
 * **成功形に `ownerScopeSupplies` を1本足した** —— **{@link supplyOwnerScopeConditions} が
 * 実際に `when` を書いた規則の一覧である。** **`applyDiff` はこれを知らせ(4種目
 * `owner_scope_supplied`)に変える。** **適用後のマニフェストだけを見ても
 * 「作者が書いた条件」と「カーネルが補った条件」は区別が付かないので、
 * 補った側が書いた時点で記録して運ぶ。**
 */
export type FoldOperationsResult =
  | { valid: true; manifest: Manifest; ownerScopeSupplies: readonly OwnerScopeSupply[] }
  | { valid: false; errors: ValidationError[] };

/** `applyDiff` の結果。失敗形は `ValidationResult` と同一。 */
export type ApplyDiffResult =
  | {
      valid: true;
      /** 適用され、`manifest.json` に永続化された次のマニフェスト。 */
      manifest: Manifest;
      /** 実際に実行した additive マイグレーションの内容。 */
      plan: MigrationPlan;
      /** 適用前スナップショットのディレクトリ名(`<連番>-<diff_id>`)。 */
      snapshot: string;
      /** 記録された changelog エントリ。 */
      entry: ChangelogEntry;
      /**
       * **誰も通さない条件・全員を通す条件の知らせ**(`V8-M18`。台帳 `J-G16` の限定の逐語
       * 「**書いた人に返る形で伝える**」)。
       *
       * **拒否ではない** —— **適用は通っている。** **矛盾が1つも見つからなければ空配列で
       * あり、欄そのものは常に在る**(**「黙って何もしない」を作らない**)。
       * **検出できる形・検出できない形の全量は `collectRoleConditionNotices` の doc
       * コメントに名指しで書いてある。** **【禁止】「矛盾を全部見つける」と読まない。**
       */
      role_condition_notices: RoleConditionNotice[];
    }
  | { valid: false; errors: ValidationError[] };

/**
 * `update_view` の `changes` のうち、ビュー種別ごとに指定できるキー。
 *
 * 範囲そのものは `schemas/diff.schema.json` の `view_changes`(name / columns / sort /
 * filter / fields と、V3-M2-T01 が足したプリセット7キー)が決めており、ここではそれを
 * **ビュー種別で絞り込む**だけである。
 * 勝手に広げないこと。マニフェストスキーマ側で list_view は fields を、
 * form は columns / sort / filter を持てないと定義されているため、
 * 種別に合わない変更はそもそも成立しない。
 *
 * `detail_view` は V1-M0-T09 の追補で `fields` を持てるようになった。それまでは `[]` で、
 * `fields` を指定できるのは `add_view` の時だけだった(記録 §6-2 の限界2)。
 *
 * `name` は V1-M0-T02 で **3種すべて**に入った。ビュー種別で絞らないのは、表示名が
 * 種別に依存しない属性だからである(`table.name` / `field.name` と同じ)。
 * **`DIFF_OPS` は増えていない** —— `update_view` は既存の op である。
 */
const CHANGE_KEYS_BY_VIEW_TYPE: Readonly<Record<View["type"], readonly (keyof ViewChanges)[]>> = {
  list_view: [
    "name",
    "columns",
    "sort",
    "filter",
    // D-G4 / F-5レイアウト(ADR-0050 限定1)。**list_view でだけ書ける3軸 + 両方で
    // 書ける2軸。** ここに並べた順がそのまま拒否エラーの `allowed_values` に出る。
    "preset_column_align",
    "preset_column_width",
    "preset_pager_position",
    "preset_image_size",
    "preset_text_preview",
    // **`P-G24` の (C) 側 / `V4-M16-T13` / `ADR-0093` 限定2**: 一覧の器の形(8つ目の
    // `preset_` キー)。**`list_view` にだけ足す** —— `detail_view` / form に「一覧の器」は
    // 無い(`ADR-0093` §Decision 4 の 3)。
    // **ここに足すだけでは値が運ばれない** —— 下の `applyViewChanges` の `list_view`
    // 分岐にも書くこと(片方だけだと「update_view は通るが適用後マニフェストに残らない」)。
    "preset_list_shape",
    // **`E-G7` の (C) 側 / `V4-M22-T01` / `ADR-0112` 限定2・限定3**: 検索の対象にする列。
    // **`list_view` にだけ足す** —— `detail_view` は自レコードのみ・form は入力なので、
    // 「検索の対象」という概念が構造的に無い(`ADR-0112` §Decision 3 の限定3)。
    // **ここに足すだけでは値が運ばれない** —— 下の `applyViewChanges` の `list_view`
    // 分岐にも書くこと(片方だけだと「update_view は通るが適用後マニフェストに残らない」)。
    "search_fields",
    // **`E-G8` / `E-G11` の (C) 側 / `V4-M22-T05` / `ADR-0113` 限定2・限定7**: 1ページの件数。
    // **`list_view` にだけ足す** —— `detail_view` には一覧が無く、form にはページャが無い。
    // **ここに足すだけでは値が運ばれない** —— 下の `applyViewChanges` の `list_view`
    // 分岐にも書くこと(片方だけだと「update_view は通るが適用後マニフェストに残らない」)。
    "page_size",
    // **`D-V4-89` / `E-G31` / `V4-M23-T01` / `ADR-0104` 限定2〜限定4**: 合計を出す列。
    // **`list_view` にだけ足す** —— `detail_view` に置くと「今開いている行に関係する集合」を
    // 指す必要が生じて相関集計になり、form は入力なので集合そのものが無い(限定4)。
    // **ここに足すだけでは値が運ばれない** —— 下の `applyViewChanges` の `list_view`
    // 分岐にも書くこと(片方だけだと「update_view は通るが適用後マニフェストに残らない」)。
    "sum_field",
    // **`P-G32` の (C) 側 / `V4-M19-T03` / `ADR-0118` 限定1・限定3**: 画面の詰まり具合。
    // **3種すべてに足す**(`name` / `custom_css` / `menu_listed` と同じ)—— 詰まり具合は
    // 画面そのものの性質であり、表・入力・詳細のどれにも器が在る(当たり先の実在 = 限定6)。
    // **ここに足すだけでは値が運ばれない** —— 下の `applyViewChanges` の当該分岐にも
    // 書くこと(片方だけだと「update_view は通るが適用後マニフェストに残らない」)。
    "preset_density",
    // D-G5 逃げ道の参照(ADR-0055 改訂1)。**3種すべてに足す** —— マニフェスト側の
    // `allOf` の3分岐がどれも `custom_css: false` を持たないためである(限定1 の帰結)。
    "custom_css",
    // **E-G12 / V4-M10-T45 / ADR-0084 限定6**: 掲載の可否。**3種すべてに足す**
    // (`name` / `custom_css` と同じ)—— 掲載は種別に依存しない属性である。
    "menu_listed",
    // **`L-G4` / `V5-M21-T03` / `ADR-0172` 限定1・限定2・限定3・限定4**: 操作起点。
    // **`list_view` と `detail_view` に足す** —— **`form` には足さない**(限定4。
    // `ADR-0171` 限定3 と対である。入力フォームには `actions` を書けない)。
    // **ここに足すだけでは値が運ばれない** —— 下の `applyViewChanges` の `list_view`
    // 分岐にも書くこと(片方だけだと「update_view は通るが適用後マニフェストに残らない」)。
    // **全置換だけである**(限定2。1件ずつ足す / 消す手段を1つも作っていない)。
    // **空配列が「全部消す」の意味である**(限定3。**他の22キーに無い性質である**)。
    // **実在照合と list_view の set 形の禁止はここで止めていない** —— **止めるのは
    // 畳み込み後のマニフェスト検証(`validateReferentialIntegrity` / schema の `allOf`)で
    // あり、`add_view` と同じ1箇所が持つ。****判定を2箇所に住まわせない。**
    "actions",
    // **`NV-G9` / `V10-M4-T01` / `ADR-0359` §4b 限定1・限定3 / `ADR-0360` 限定2**:
    // **一続きの流れの中の段。**
    // **`list_view` / `form` / `detail_view` の3種別に足す** —— **`report_view` には
    // 足さない**(マニフェスト側の `allOf` の `report_view` 分岐が `"flow": false` で
    // 閉じているので、そこに足すと「受付表は通すがマニフェスト検証が拒む」二段構えに
    // なる)。**両者を一致させてある。**
    // **ここに足すだけでは値が運ばれない** —— 下の `applyViewChanges` の同じ種別の
    // 分岐にも書くこと(片方だけだと「update_view は通るが適用後マニフェストに残らない」)。
    // **確認の段を置ける種別(`detail_view` だけ)も、位置の重複・欠番も、ここでは
    // 止めていない** —— **前者はスキーマの `allOf` が、後者は畳み込み後のマニフェスト
    // 検証(`validateReferentialIntegrity`)が持ち、`add_view` と同じ1箇所が覆う。**
    // **判定を2箇所に住まわせない。**
    "flow",
  ],
  // **form にプリセットは1キーも足していない**(ADR-0050 §1c。form の4軸は却下1 / 保留3 で別の門)。
  // **逃げ道の参照だけは足す**(ADR-0055 改訂1)—— **プリセットが1軸も当たらない form こそ
  // 逃げ道の当て先であり、ここを除くと当て先を1つも持たない画面種が残る。**
  // **掲載の可否(ADR-0084)も3種すべてに足す。**
  //
  // **【V4-M16-T11 / P-G29 / ADR-0091 限定3 で偽になった】** 上の1行目は **2026-07-26 の
  // 判定としては正しいが、今日は成り立たない** —— **ADR-0091(門A / 判定 = 限定採用)が
  // `preset_label_placement` と `preset_field_columns` の2軸を form にも通した。**
  // **旧文を1バイトも消していない。****足したのは2軸だけで、残る5軸(列の寄せ / 列の幅 /
  // 件数表示とページャの位置 / image の表示サイズ / long_text の切り詰め長)は form 分岐で
  // 今日も `false` である。****【禁止】「form のプリセットが通った」と書かない**
  // (ADR-0091 §Decision 3 の 2)。**並び順は detail_view 分岐に合わせてある** ——
  // ここに並べた順がそのまま拒否エラーの `allowed_values` に出る。
  form: [
    "name",
    "fields",
    "preset_label_placement",
    "preset_field_columns",
    "custom_css",
    "menu_listed",
    // **`P-G14` の (C) 側 / `V4-M18-T03` / `ADR-0095` 限定6**: 重ねて出す宣言。
    // **`form` にだけ足す**(限定4。一覧と詳細はメニューと行クリックから開かれる画面であり、
    // 重ねる相手が居ない場面が構造的に在る)。
    // **ここに足すだけでは値が運ばれない** —— 下の `applyViewChanges` の `form`
    // 分岐にも書くこと(片方だけだと「update_view は通るが適用後マニフェストに残らない」)。
    "modal",
    // **`P-G32` の (C) 側 / `V4-M19-T03` / `ADR-0118` 限定1・限定3**: 画面の詰まり具合。
    // **3種すべてに足す**(`name` / `custom_css` / `menu_listed` と同じ)—— 詰まり具合は
    // 画面そのものの性質であり、表・入力・詳細のどれにも器が在る(当たり先の実在 = 限定6)。
    // **ここに足すだけでは値が運ばれない** —— 下の `applyViewChanges` の当該分岐にも
    // 書くこと(片方だけだと「update_view は通るが適用後マニフェストに残らない」)。
    "preset_density",
    // **`E-G34` の (C) 側 / `V4-M20-T04` / `ADR-0102` 限定1・限定3**: 保存後の行き先。
    // **`form` にだけ足す**(限定3。一覧と詳細に「保存」という出来事が無い)。
    // **ここに足すだけでは値が運ばれない** —— 下の `applyViewChanges` の `form`
    // 分岐にも書くこと(片方だけだと「update_view は通るが適用後マニフェストに残らない」)。
    "after_save",
    // **`K-G2` / `K-G3` の (C) 側 / `V6-M2-T01` / `V6-M2-T02` / `ADR-0289` 限定1・限定4**:
    // 参照項目の選び方の、入力画面ごとの上書き。
    // **`form` にだけ足す**(限定4)—— **一覧と詳細は参照項目の値を表示するだけで、
    // 選ぶ操作が構造的に無い。****これは `actions` のちょうど裏である**(`actions` は
    // `form` にだけ書けない)。
    // **ここに足すだけでは値が運ばれない** —— 下の `applyViewChanges` の `form`
    // 分岐にも書くこと(片方だけだと「update_view は通るが適用後マニフェストに残らない」)。
    // **全置換である** —— 項目ごとに1本ずつ足す / 消す手段を1つも作っていない。
    "reference_pickers",
    // **`NV-G9` / `V10-M4-T01` / `ADR-0359` §4b 限定1・限定3 / `ADR-0360` 限定2**:
    // **一続きの流れの中の段。**
    // **`list_view` / `form` / `detail_view` の3種別に足す** —— **`report_view` には
    // 足さない**(マニフェスト側の `allOf` の `report_view` 分岐が `"flow": false` で
    // 閉じているので、そこに足すと「受付表は通すがマニフェスト検証が拒む」二段構えに
    // なる)。**両者を一致させてある。**
    // **ここに足すだけでは値が運ばれない** —— 下の `applyViewChanges` の同じ種別の
    // 分岐にも書くこと(片方だけだと「update_view は通るが適用後マニフェストに残らない」)。
    // **確認の段を置ける種別(`detail_view` だけ)も、位置の重複・欠番も、ここでは
    // 止めていない** —— **前者はスキーマの `allOf` が、後者は畳み込み後のマニフェスト
    // 検証(`validateReferentialIntegrity`)が持ち、`add_view` と同じ1箇所が覆う。**
    // **判定を2箇所に住まわせない。**
    "flow",
  ],
  // **画面種別の4種目**(`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`)。
  // **書けるのは4キーだけである** —— **集計表の中身(`report`)と、種別に依存しない
  // 3キー(`name` / `custom_css` / `menu_listed`)。**
  // **`columns` / `sort` / `filter` / `fields` / `sum_field` / `actions` / `preset_` 系を
  // 1つも足していない** —— **マニフェスト側の `allOf` の `report_view` 分岐がそれらを
  // `false` で閉じているので、ここに足すと「受付表は通すがマニフェスト検証が拒む」
  // 二段構えになる。****両者を一致させてある。**
  report_view: [
    "name",
    // **`Q-G1` / `V8-M8`**: 集計表の中身。**`report_view` にだけ足す** ——
    // 他の3種には器が無い(`allOf` が `"report": false,` で閉じている)。
    // **ここに足すだけでは値が運ばれない** —— 下の `applyViewChanges` の `report_view`
    // 分岐にも書くこと(片方だけだと「update_view は通るが適用後マニフェストに残らない」)。
    // **全置換である** —— 束ねるキーを1本だけ足す / 消す手段を1つも作っていない。
    // **実在照合・型・`granularity` の要否・役割の規則が名指ししていないこと は
    // ここで止めていない** —— **止めるのは畳み込み後のマニフェスト検証
    // (`validateReferentialIntegrity`)であり、`add_view` と同じ1箇所が持つ。**
    "report",
    "custom_css",
    "menu_listed",
  ],
  detail_view: [
    "name",
    "fields",
    // D-G4(ADR-0050 限定1)。**detail_view でだけ書ける2軸 + 両方で書ける2軸。**
    "preset_label_placement",
    "preset_field_columns",
    "preset_image_size",
    "preset_text_preview",
    // D-G5 逃げ道の参照(ADR-0055 改訂1)。
    "custom_css",
    // **E-G12 / V4-M10-T45 / ADR-0084 限定6**: 掲載の可否。
    // **今日の目的文(`D-V4-54`)が名指しした「単体で開く画面」がこの種別である。**
    "menu_listed",
    // **`P-G17` の (C) 側 / `V4-M16-T12` / `ADR-0092` 限定2**: 項目のまとまり。
    // **`detail_view` にだけ足す** —— `list_view` に「まとまり」を持ち込むと、それは列の
    // グループ化であり別の概念である(`ADR-0092` §Decision 4 の 3)。
    // **ここに足すだけでは値が運ばれない** —— 下の `applyViewChanges` の `detail_view`
    // 分岐にも書くこと(片方だけだと「update_view は通るが適用後マニフェストに残らない」)。
    "field_groups",
    // **`P-G32` の (C) 側 / `V4-M19-T03` / `ADR-0118` 限定1・限定3**: 画面の詰まり具合。
    // **3種すべてに足す**(`name` / `custom_css` / `menu_listed` と同じ)—— 詰まり具合は
    // 画面そのものの性質であり、表・入力・詳細のどれにも器が在る(当たり先の実在 = 限定6)。
    // **ここに足すだけでは値が運ばれない** —— 下の `applyViewChanges` の当該分岐にも
    // 書くこと(片方だけだと「update_view は通るが適用後マニフェストに残らない」)。
    "preset_density",
    // **`L-G4` / `V5-M21-T03` / `ADR-0172` 限定1・限定2・限定3・限定4**: 操作起点。
    // **`list_view` と `detail_view` に足す** —— **`form` には足さない**(限定4。
    // `ADR-0171` 限定3 と対である。入力フォームには `actions` を書けない)。
    // **ここに足すだけでは値が運ばれない** —— 下の `applyViewChanges` の `detail_view`
    // 分岐にも書くこと(片方だけだと「update_view は通るが適用後マニフェストに残らない」)。
    // **全置換だけである**(限定2。1件ずつ足す / 消す手段を1つも作っていない)。
    // **空配列が「全部消す」の意味である**(限定3。**他の22キーに無い性質である**)。
    // **実在照合と list_view の set 形の禁止はここで止めていない** —— **止めるのは
    // 畳み込み後のマニフェスト検証(`validateReferentialIntegrity` / schema の `allOf`)で
    // あり、`add_view` と同じ1箇所が持つ。****判定を2箇所に住まわせない。**
    "actions",
    // **`NV-G3a` の (C) 側 / `V10-M1-T01` / `ADR-0358` 限定1・限定2・限定8**:
    // **この画面の書換ボタンが成立したあとの行き先。**
    // **`form` と `detail_view` の2種別に足す** —— **`list_view` / `report_view` には
    // 今日も足さない**(限定1。マニフェスト側の `allOf` がその2分岐で `false` に
    // 閉じているので、ここに足すと「受付表は通すがマニフェスト検証が拒む」二段構えになる)。
    // **`after_save` は着手前から `view_changes` に在る** —— **足したのはこの受付表の
    // 側だけであり、`schemas/diff.schema.json` には1バイトも触っていない**(限定8)。
    // **ここに足すだけでは値が運ばれない** —— 下の `applyViewChanges` の `detail_view`
    // 分岐にも書くこと(片方だけだと「update_view は通るが適用後マニフェストに残らない」)。
    // **【意味のずれを隠さない(限定6)】詳細画面に「保存」は無い** ——
    // **発火するのは `set` 形の書込が成立したときだけで、`run` 形の後は移らない。**
    "after_save",
    // **`NV-G4` の (C) 側 / `V10-M1-T02` / `ADR-0359` §4a 限定2・限定4・限定10**:
    // **削除が成立したあとの行き先。**
    // **`detail_view` にだけ足す**(限定2。マニフェスト側の `allOf` が `list_view` /
    // `form` / `report_view` の3分岐で `false` に閉じているので、ここに足すと
    // 「受付表は通すがマニフェスト検証が拒む」二段構えになる)。
    // **ここに足すだけでは値が運ばれない** —— 下の `applyViewChanges` の `detail_view`
    // 分岐にも書くこと(片方だけだと「update_view は通るが適用後マニフェストに残らない」)。
    // **行き先の型(`list_view` / `report_view` だけ)と実在はここで止めていない** ——
    // **止めるのは畳み込み後のマニフェスト検証(`validateReferentialIntegrity`)であり、
    // `add_view` と同じ1箇所が持つ。****判定を2箇所に住まわせない。**
    "after_delete",
    // **`NV-G9` / `V10-M4-T01` / `ADR-0359` §4b 限定1・限定3 / `ADR-0360` 限定2**:
    // **一続きの流れの中の段。**
    // **`list_view` / `form` / `detail_view` の3種別に足す** —— **`report_view` には
    // 足さない**(マニフェスト側の `allOf` の `report_view` 分岐が `"flow": false` で
    // 閉じているので、そこに足すと「受付表は通すがマニフェスト検証が拒む」二段構えに
    // なる)。**両者を一致させてある。**
    // **ここに足すだけでは値が運ばれない** —— 下の `applyViewChanges` の同じ種別の
    // 分岐にも書くこと(片方だけだと「update_view は通るが適用後マニフェストに残らない」)。
    // **確認の段を置ける種別(`detail_view` だけ)も、位置の重複・欠番も、ここでは
    // 止めていない** —— **前者はスキーマの `allOf` が、後者は畳み込み後のマニフェスト
    // 検証(`validateReferentialIntegrity`)が持ち、`add_view` と同じ1箇所が覆う。**
    // **判定を2箇所に住まわせない。**
    "flow",
  ],
};

/**
 * 現行マニフェストに operations を畳み込んで「次のマニフェスト」を作る純粋関数。
 *
 * 現行マニフェストは書き換えない(深いコピーに対して適用する)。
 * op は additive 4種のみを扱う。畳み込みは**先頭から順に**行うため、
 * 同じ差分の中で「テーブルを足してからそのテーブルにフィールドを足す」も成立する。
 *
 * ここで検出するのは「マニフェスト単体の形は正しいが、現行マニフェストに対して
 * 成立しない操作」である。具体的には
 *
 * - 既に存在するテーブル/フィールド/ビューのIDを再び追加しようとしている
 * - 存在しないテーブル/ビューを対象にしている
 * - ビュー種別が持てない項目を `update_view` で変更しようとしている
 *
 * いずれも `path` は問題の operation を指す JSON Pointer(`/operations/2/table` 等)で返す。
 * 異常が複数あってもまとめて返し、LLM が1往復で直せるようにする。
 */
export function foldOperations(current: Manifest, operations: Operation[]): FoldOperationsResult {
  const manifest = structuredClone(current);
  const errors: ValidationError[] = [];

  for (const [index, operation] of operations.entries()) {
    const path = `/operations/${index}`;
    switch (operation.op) {
      case "add_table":
        foldAddTable(manifest, operation.table, path, errors);
        break;
      case "add_field":
        foldAddField(manifest, operation.table, operation.field, path, errors);
        break;
      case "add_view":
        foldAddView(manifest, operation.view, path, errors);
        break;
      case "update_view":
        foldUpdateView(manifest, operation.view, operation.changes, path, errors);
        break;
      case "remove_field":
        foldRemoveField(manifest, operation.table, operation.field, path, errors);
        break;
      case "remove_table":
        foldRemoveTable(manifest, operation.table, path, errors);
        break;
      case "change_table":
        foldChangeTable(manifest, operation.table, operation.changes, path, errors);
        break;
      case "change_field":
        foldChangeField(
          manifest,
          operation.table,
          operation.field,
          operation.changes,
          path,
          errors,
        );
        break;
      case "remove_view":
        foldRemoveView(manifest, operation.view, path, errors);
        break;
      case "add_workflow":
        foldAddWorkflow(manifest, operation.workflow, path, errors);
        break;
      case "update_workflow":
        foldUpdateWorkflow(manifest, operation.workflow, path, errors);
        break;
      case "remove_workflow":
        foldRemoveWorkflow(manifest, operation.workflow.id, path, errors);
        break;
      case "add_function":
        foldAddFunction(manifest, operation.function, path, errors);
        break;
      case "update_function":
        foldUpdateFunction(manifest, operation.function, path, errors);
        break;
      case "remove_function":
        foldRemoveFunction(manifest, operation.function.id, path, errors);
        break;
      case "set_theme":
        foldSetTheme(manifest, operation.theme);
        break;
      case "set_roles":
        foldSetRoles(manifest, operation.roles);
        break;
      default: {
        // **網羅性チェック**(V1-M2-T07 完了条件4)。`DIFF_OPS` に op を足して
        // ここに case を書き忘れたら、`operation` が `never` に落ちないので
        // `tsc --noEmit` がこの行で落ちる。**黙って無視される分岐を作らない。**
        const exhaustive: never = operation;
        throw new Error(`未知の op です: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }
  // **【2026-09-08。`V17-M5-T05` / 台帳 `AC-G33`(`:1862`)/ `ADR-0423`。
  //   旧の1行を逐語で残す】**
  // **旧: `  return { valid: true, manifest };`**
  //
  // **{@link supplyOwnerScopeConditions} の呼び出しを、`foldSetRoles` の中から
  // **ここ**(すべての op を畳み終えた出口)へ移した。** **呼ぶのは1度だけである。**
  //
  // **この1つの移動が3つを同時に直す**(台帳 `AC-G33` の当たり先3つ):
  //
  // 1. **`add_field` で後から `st_owner` を足した表** —— **`set_roles` が来なくても
  //    最後の姿を見るので補われる。**
  // 2. **順序に依る穴((o-11))** —— **同じ差分で `set_roles` を `add_table` /
  //    `add_field` より**先**に並べても、見るのは畳み終えた後の姿である。**
  // 3. **二重呼び出しが消える** —— **1つの差分に `set_roles` が2本あっても1度しか走らない。**
  //
  // **【広がった射程を正直に書く。丸めない】** **着手前は `set_roles` を含む差分でしか
  // 走らなかったが、今日は**すべての差分**の出口で走る。** **`add_view` だけの差分でも
  // 走る**(着手前の実測: そのとき補完は1本も走らず、知らせも `[]` だった)。
  // **拒否は1本も増えていない** —— **この関数はここまでで `errors` を確定させており、
  // 補完は `valid: true` の側でしか動かない。**
  const ownerScopeSupplies = supplyOwnerScopeConditions(manifest);
  return { valid: true, manifest, ownerScopeSupplies };
}

// =====================================================================================
// **【`V8-M26-T04`】作るたびに、既定3役割の規則を自動で足す**
//
// **根拠(ユーザ決定。逐語の正は `docs/plan/v8/03-user-decisions.md` §4i〜§4l)**:
//
// - `D-V8-56`「**表を作ると、持ち主がその表を扱える1行が自動で入ります**」
// - `D-V8-60`「**画面・ボタンも自動で足す**」(**対象は 表・画面・ボタンの3つちょうど**)
// - `D-V8-61`「**編集者は見る+書く、閲覧者は見るだけを、表を作るたびに自動で入れます**」
// - `D-V8-62`「**持ち主は 見る・書く・消す の3つとも**」
//
// ## **なぜ「作るたび」であって「常に足しておく」ではないのか(置き場所の理由)**
//
// **入れる場所は差分の畳み込み(`foldAddTable` / `foldAddView` / `foldUpdateView`)である。**
// **`applyManifest`(`src/kernel/apply-manifest.ts`)には1バイトも入れていない** ——
// **そこへ入れると毎回の適用で規則が復活し、あとから規則を外せなくなる。**
// **`D-V8-56` の逐語は「表を**作ると**…1行が自動で入ります」であって、
// 「常に入っている」ではない。** **外した規則は外れたままになる。**
//
// ## **`V8-M26-T03`(既定を閉じる)との関係**
//
// **`T03` が既定を反転させ、規則を1本も書いていない表・画面・ボタンは閉じるようになった。**
// **その埋め合わせがここである** —— **新しく作ったものが、作った直後から既定3役割に見える。**
// **【正直に書く】埋め合わせは新しく作るものにしか効かない** —— **`T03` より前に作られた
// 既存アプリの表・画面・ボタンには1本も入らない(移行の口は今日1つも無い)。**
// =====================================================================================

/**
 * **自動で足す規則が名指しできる対象**(表・画面・ボタンの3つちょうど)。
 *
 * **項目(`field`)は入らない** —— **`T03` が項目を閉じていないので、足す理由が1つも無い**
 * (台帳 `T-G1b` = 却下)。
 */
type DefaultRuleTarget =
  | { readonly target: "table"; readonly table: string }
  | { readonly target: "view"; readonly view: string }
  | { readonly target: "action"; readonly view: string; readonly action: string };

/**
 * **対象 × 既定3役割 → 自動で足す動詞**(`D-V8-61` / `D-V8-62`)。
 *
 * **【非対称を隠さない。これは実装の手抜きではなくスキーマの形である】**
 * **画面(`view`)とボタン(`action`)は3役割とも `read` 1語しか書けない** ——
 * **`schemas/manifest.schema.json:235`(画面)と `:251`(ボタン)が
 * `can: { "type": "array", "items": { "const": "read" } }` で閉じているからである。**
 * **したがって `D-V8-62`「持ち主は 見る・書く・消す の3つとも」は、表にしか履行できない。**
 * **画面とボタンに `write` / `delete` を書いた差分は、畳み込んだ後の
 * `validateManifestFull` が拒否する。**
 */
const DEFAULT_ROLE_RULE_VERBS: {
  readonly [K in DefaultRuleTarget["target"]]: {
    readonly [R in (typeof DEFAULT_ROLE_IDS)[number]]: readonly RoleRuleVerb[];
  };
} = {
  // **`D-V8-62`(持ち主は3つとも)/ `D-V8-61`(編集者は見る+書く・閲覧者は見るだけ)。**
  table: { owner: ["read", "write", "delete"], editor: ["read", "write"], viewer: ["read"] },
  // **画面とボタンは3役割とも `read` 1語である**(上の doc の非対称)。
  view: { owner: ["read"], editor: ["read"], viewer: ["read"] },
  action: { owner: ["read"], editor: ["read"], viewer: ["read"] },
};

// =====================================================================================
// **【`V8-M26` / `D-V8-68`】自動付与が「行ごとの設定」を踏み潰さないようにする**
//
// **ユーザ決定 `D-V8-68`(2026-08-10)。選ばれた見出しの逐語**:
// 「**自動で入れるが「自分の行だけ」に絞る**」。
// **選ばれた説明文の逐語**: 「「作った人だけの表」には、自動の1行に「自分の行だけ」の条件を
// 付けて入れます。作った直後から使えて、他人の行は見えません。ただし運営が全件を見たいときは、
// 別に1行書くことになります。」
//
// ## **なぜ要ったか(実測)**
//
// **`T04` の自動付与は表の種類を1度も見ていなかった** —— **`st_owner`(作った人だけの表)にも、
// 行ごとのアクセス権を宣言した表にも、**無条件の**規則が入っていた。**
// **面(役割に束ねた権限)と点(行ごとの付与)は `OR` で重なるので、無条件の面が1本入ると
// 行ごとの設定は既定3役割に対して事実上無効になる。**
// =====================================================================================

/**
 * **その表に自動付与を入れるか。入れるなら、どの条件を付けるか。**
 *
 * **答えは3通りである**:
 *
 *  1. **行ごとのアクセス権を宣言した表** → **`skip`(1本も入れない)。**
 *  2. **`st_owner`(作った人だけの表)を持つ表** → **`grant` + 「自分の行だけ」の条件。**
 *  3. **どちらでもない表** → **`grant`(条件なし。今日どおり)。**
 *
 * **【`V8-M26`。ユーザ決定 `D-V8-70`(2026-08-11)。選ばれた見出しの逐語
 * 「共有行も見えるようにする」。上の 2 の「『自分の行だけ』の条件」は今日から偽である。
 * 旧文を1バイトも消していない】**
 *
 * **2 が付ける条件は「自分の行、または持ち主が空の行」になった** ——
 * **`{ or: [ {field: st_owner, equals_current_user: true}, {field: st_owner, is_empty: true} ] }`。**
 *
 * **なぜ変えたか(実測)**: **`D-V8-68` の「自分の行だけ」は、`st_owner` が空の行
 * (= 共有行。`PATCH {st_owner: null}` で「みんなのもの」にした行)を誰にも見えなくした。**
 * **実測は `web/e2e/owner-scope.e2e.ts` の「2セッションで個人行が相互不可視、共有化すると
 * 双方に見える(API)」** —— **`V8-M26` の後、共有化した行が本人にも相手にも1件も出なく
 * なっていた。** **`D-V8-70` は葉に「その項目が空か」を1形足して、この道を戻した。**
 *
 * **【誇張しない】** **戻したのは「共有行が見えること」だけである** ——
 * **他人の個人行は今日も1件も見えない**(`or` の左は「自分」のままである)。
 *
 * ## **1 が「入れない」である理由。これはメインの裁定であって、ユーザ決定ではない**
 *
 * **ユーザ決定 `D-V8-68` が述べているのは「自動の行が行ごとの設定を踏み潰さない」までである。**
 * **今日の条件(`when`)は葉が2形しかない** —— **「項目が値と等しい」と「項目が自分と等しい」**
 * (`schemas/manifest.schema.json` の `$defs/role_condition`)。
 * **「行ごとに付与された相手だけ」を条件として書く手段が1つも無い**(条件から見えるのは
 * 判定している行の項目の値と要求している人の識別子の2つだけで、**付与表を1行も読めない**)。
 * **したがってユーザ決定の趣旨を今日の語彙で履行する道は「入れない」しかない。**
 *
 * ## **【その帰結。丸めない】**
 *
 * **行ごとのアクセス権を宣言した表は、作った直後、持ち主にも見えない。**
 * **`D-V8-56` の「作った直後から本人には見えます」は、その表については成り立たない。**
 * **見えるようにするには、利用者表・付与表に行を入れるか、`set_roles` で自分で規則を書く
 * ことになる。**
 *
 * ## **【実測(2026-08-10)。何が失われて、何は元から無かったか。丸めない】**
 *
 * **実 HTTP で、自動付与を入れていた頃と入れない今日を並べて測った。**
 *
 *  1. **「作った直後、持ち主にも使えない」は、この変更が作った帰結ではない** ——
 *     **自動付与が入っていた頃も、利用者表に行を持たない人の作成は 400
 *     (「メンバー表に登録されていないため、この表に行を作れません。」)、一覧は 200 の
 *     空一覧だった。** **止めていたのは点(行ごとのアクセス権)の側であり、
 *     自動で入った面の規則はこの2つを1ミリも動かしていなかった。**
 *  2. **失われたのは「付与を1件も持たない相手が、他人の行を全部読めること」である** ——
 *     **自動付与が入っていた頃、既定3役割のどれかを持つ人は、その表への付与が1件も
 *     無くても全行が一覧に出ていた**(実測: 別人が作った行が `total: 1` で見えた)。
 *     **今日は 200 の空一覧である。** **これが「踏み潰し」の実体であり、
 *     `D-V8-68` が止めよと言っているものそのものである。**
 *  3. **したがって「運営が全件を見たいときは、別に1行書くことになります」**(ユーザ決定の
 *     説明文の逐語)**は、今日から本当に要る。**
 *
 * ## **【1 と 2 が同居したときは 1 が勝つ】**
 *
 * **`st_owner` と行ごとのアクセス権の同居は適用時検査が拒否していない**
 * (`src/kernel/referential-integrity.ts` の `ACCESS_CONTROL_EXCLUSIVE_FIELDS` は `st_public`
 * 1本だけである)。**同居した表では 1 を採る** —— **踏み潰さないことのほうを優先する。**
 *
 * ## **【今日この関数が見ていないもの。塞いでいない】**
 *
 * - **`add_field` で後から `st_owner` を足した表**には条件が付かない(自動付与は
 *   `add_table` の時点で入るので、そのときの姿しか見ていない)。
 * - **`change_table` で後から行ごとのアクセス権を宣言した表**からは、既に入った自動付与が
 *   1本も外れない(カスケードしない。`ADR-0012` 限定4 と同じ作法)。
 *
 * **【2026-09-08 追記(`V17-M5-T05` / 台帳 `AC-G33`(`:1862`)/ `ADR-0423`)。
 * 上の2行は1バイトも消していない】**
 * **1つ目(「`add_field` で後から `st_owner` を足した表には条件が付かない」)は、
 * 今日は偽である。** **この関数の見え方そのものは1バイトも変わっていない**
 * (**今日もこの関数は「渡された1つの表の姿」しか見ない**)—— **変わったのは
 * {@link supplyOwnerScopeConditions} を呼ぶ位置であり、
 * {@link foldOperations} が**すべての op を畳み終えた後**に1度だけ呼ぶようになった。**
 * **したがって `add_field` で後から足した `st_owner` も、その差分の出口で
 * 条件なしの規則に補われる**(**補ったことは知らせ `owner_scope_supplied` で返る**)。
 * **2つ目(`change_table` のカスケードしない件)は今日も真である** —— **本タスクは
 * 自動付与を1本も外していない。**
 */
type DefaultTableGrantPlan =
  | { readonly kind: "skip" }
  | { readonly kind: "grant"; readonly when?: RoleCondition };

/**
 * **その表が「行ごとのアクセス権」を宣言しているか**(`access_control.enabled === true`)。
 *
 * **`enabled !== true` は「宣言していない表と同じ扱い」である**(`schemas/manifest.schema.json`
 * の逐語)。**`src/server/owner-scope.ts` の `accessControlOf` と同じ読み方であり、
 * カーネルは `src/server/` を import できない**(`ADR-0009` の層分離)ので、
 * **同じ読み方がカーネルとサーバの2箇所にある。隠さない。**
 *
 * **読む相手は2つだけである**({@link defaultTableGrantPlan} と
 * {@link collectRoleConditionNotices})—— **どちらもカーネルの内側である。**
 */
function declaresRecordGrants(table: Table): boolean {
  const declared = (table as { access_control?: unknown }).access_control;
  return (
    typeof declared === "object" &&
    declared !== null &&
    !Array.isArray(declared) &&
    (declared as { enabled?: unknown }).enabled === true
  );
}

function defaultTableGrantPlan(table: Table): DefaultTableGrantPlan {
  // **`enabled !== true` は「宣言していない表と同じ扱い」である**(schema の逐語)——
  // **`src/server/owner-scope.ts` の `accessControlOf` と同じ読み方であり、
  // 判定を1本増やしていない。** **カーネルは `src/server/` を import できない**
  // (`ADR-0009` の層分離)ので、読み方が2箇所にある。**隠さない。**
  //
  // **【2026-09-08 追記(`V17-M5-T04` / `AC-G18`)。上の4行は1バイトも消していない】**
  // **読み方の本体を {@link declaresRecordGrants} へ括り出した** —— **同じ問いを
  // `collectRoleConditionNotices` も要るようになったからである。** **カーネル側の
  // 読み方は今日も1本のままであり、`src/server/` 側と合わせて2箇所である**
  // (**3箇所目を作っていない**)。
  if (declaresRecordGrants(table)) {
    return { kind: "skip" };
  }
  if (table.fields.some((field) => field.id === OWNER_SCOPE_COLUMN)) {
    // **綴りは同じファイルの {@link OWNER_SCOPE_COLUMN} 1本を使う**(3本目を宣言しない)。
    //
    // **【`V8-M26` / `D-V8-70`。旧の1行を逐語で残す】**
    // **旧: `return { kind: "grant", when: { field: OWNER_SCOPE_COLUMN, equals_current_user: true } };`**
    // **今日は「自分の行、または持ち主が空の行」である**(共有行を締め出さないため)。
    return {
      kind: "grant",
      when: {
        or: [
          { field: OWNER_SCOPE_COLUMN, equals_current_user: true },
          { field: OWNER_SCOPE_COLUMN, is_empty: true },
        ],
      },
    };
  }
  return { kind: "grant" };
}

/**
 * **その規則が、その対象を名指ししているか**(**対象の同一性だけを見る。動詞は見ない**)。
 *
 * **`src/server/owner-scope.ts` の `ruleNamesTarget` と同じ問いである** ——
 * **あちらを import していないのは、`src/kernel/` が `src/server/` に依存できないからである**
 * (依存の向きは `server → kernel` の一方向。ADR-0006 §6)。
 * **【正直に書く】同じ問いの実装が2箇所に在る。** **片方だけを変えると黙ってずれる。**
 * **ずれないことを固定しているのは検査(`src/kernel/role-default-grant.test.ts`)だけである。**
 */
function ruleNamesDefaultTarget(rule: RoleRule, target: DefaultRuleTarget): boolean {
  if (rule.target !== target.target) {
    return false;
  }
  switch (target.target) {
    case "table":
      return rule.table === target.table;
    case "view":
      return rule.view === target.view;
    case "action":
      return rule.view === target.view && rule.action === target.action;
  }
}

/**
 * **既定3役割(`owner` / `editor` / `viewer`)に、その対象の規則を1本ずつ足す。**
 *
 * **足す条件は4つちょうどである**:
 *
 *  1. **アプリが `app.roles` を持っているときだけ足す** —— **持っていないアプリに
 *     `roles` を生やさない**(宣言そのものを勝手に作らない)。
 *  2. **その役割が実在するときだけ足す** —— **`owner` / `editor` / `viewer` のどれかが
 *     消されているアプリには、その役割の分を足さない。**
 *  3. **同じ対象を名指しした規則がその役割に既に在るなら足さない** ——
 *     **重複を作らない**(スキーマの `uniqueItems: true` に当たる)。
 *     **動詞が違っていても足さない** —— **既に書かれている宣言を上書きしない**
 *     (`J-G2` の限定「アプリの作者は既定に足すことしかできない」の裏返しで、
 *     **カーネルが作者の宣言を書き換えない**)。
 *  4. **`rules` が未定義の役割には `rules` を新設する** —— **スキーマの `minItems: 1` が
 *     あるので、空配列は作らない**(1本足すときにだけ生やす)。
 *
 * **`anonymous` には1本も足さない**(`D-V8-45` / 台帳 `T-G26a`)——
 * **未ログインの既定は閉じたままである。** **{@link DEFAULT_ROLE_IDS} が3語ちょうどで
 * あり、`anonymous` はそこに入っていない。**
 *
 * **上限(`rules` の `maxItems: 1024`)をここで見ていない** —— **超えたら畳み込んだ後の
 * `validateManifestFull` が差分**全体**を拒否する**(「全か無か」)。
 * **黙って落とさない。** **実測は `src/kernel/role-default-grant.test.ts` が持つ。**
 *
 * @param when **【`V8-M26` / `D-V8-68`】足す規則に付ける条件。省略できる。**
 *   **付くのは表(`table`)の規則だけである** —— **画面とボタンには判定する行が1つも無く、
 *   スキーマの `allOf` が `when: false` で閉じている**({@link RoleRule} の doc)。
 *   **3役割それぞれに写しを配る** —— **同じオブジェクトを3本で共有すると、
 *   あとで1本を書き換えたときに他の2本まで変わる。**
 */
function grantDefaultRoleRules(
  manifest: Manifest,
  target: DefaultRuleTarget,
  when?: RoleCondition,
): void {
  const declarations = manifest.app.roles;
  if (declarations === undefined) {
    return;
  }
  for (const roleId of DEFAULT_ROLE_IDS) {
    const declaration = declarations.find((candidate) => candidate.id === roleId);
    if (declaration === undefined) {
      continue;
    }
    if ((declaration.rules ?? []).some((rule) => ruleNamesDefaultTarget(rule, target))) {
      continue;
    }
    const rule = {
      ...target,
      can: [...DEFAULT_ROLE_RULE_VERBS[target.target][roleId]],
      ...(when === undefined ? {} : { when: structuredClone(when) }),
    } as RoleRule;
    if (declaration.rules === undefined) {
      declaration.rules = [rule];
    } else {
      declaration.rules.push(rule);
    }
  }
}

/**
 * **画面が持つボタンのうち、識別子(`id`)を持つものについて規則を足す。**
 *
 * **`id` を持たないボタンには足さない** —— **面から名指しできないからである**
 * (`web/src/auth/authz.tsx` の `canUseAction` が「識別子を持たない操作起点は面から
 * 名指しできないので、今日どおり出る」と書いているのと同じ理由)。
 * **`form` は `actions` を持てないので、ここは 0 本で抜ける。**
 */
function grantDefaultActionRules(manifest: Manifest, view: View): void {
  if (!("actions" in view)) {
    return;
  }
  for (const action of (view.actions ?? []) as readonly { id?: string }[]) {
    if (typeof action.id !== "string") {
      continue;
    }
    grantDefaultRoleRules(manifest, { target: "action", view: view.id, action: action.id });
  }
}

function foldAddTable(
  manifest: Manifest,
  table: Table,
  path: string,
  errors: ValidationError[],
): void {
  if (manifest.app.tables.some((t) => t.id === table.id)) {
    errors.push({
      path: `${path}/table/id`,
      message:
        `テーブル "${table.id}" は既に存在するため add_table で追加できません。` +
        `v0 の add_table は新しいテーブルを作る操作であり、既存テーブルの再定義や上書きはできません。`,
      hint: `既存テーブルに項目を足したいなら add_field を使ってください。別のテーブルを作りたいなら別のIDを付けてください。`,
    });
    return;
  }
  // **コピーを積む。** 参照のまま積むと、後続の `add_field` が
  // `operation.table.fields` を直接伸ばしてしまい、**呼び出し側が渡した diff が
  // 書き換わる**。その diff はそのまま changelog に記録されるので、
  // 「実際に送られた操作」と「記録された操作」がずれる(憲法5)。
  // V1-M1-T03 で `planMigration` が operations から計画を導くようになり、
  // この書き換えが `duplicate column name` として表面化した。
  manifest.app.tables.push(structuredClone(table));
  // **【`V8-M26-T04` / `D-V8-56` / `D-V8-61` / `D-V8-62`】作った直後から既定3役割に見える。**
  // **成功した後にだけ足す** —— 上の `errors.push` で抜けた経路では1本も足さない。
  // **【`V8-M26` / `D-V8-68`】表の種類で3通りに分かれる**({@link defaultTableGrantPlan})——
  // **行ごとのアクセス権を宣言した表には1本も入らず、`st_owner` の表には
  // 「自分の行だけ」の条件が付く。**
  const plan = defaultTableGrantPlan(table);
  if (plan.kind === "grant") {
    grantDefaultRoleRules(manifest, { target: "table", table: table.id }, plan.when);
  }
}

function foldAddField(
  manifest: Manifest,
  tableId: string,
  field: Table["fields"][number],
  path: string,
  errors: ValidationError[],
): void {
  // システムテーブルは存在する。ただ読み取り専用なだけである(ADR-0006 §7 #13)。
  // ここを「存在しません」で返すと、hint が「add_table しろ」と、L3 で必ず弾かれる
  // 操作へ AI を誘導する。書き込みは起きないので穴ではないが、文面は嘘である。
  if (isSystemTableId(tableId)) {
    errors.push({
      path: `${path}/table`,
      message:
        `システムテーブル "${tableId}" にはフィールドを追加できません(読み取り専用です)。` +
        `システムテーブルのスキーマはカーネルが定数として持っており、差分では変更できません。`,
      allowed_values: manifest.app.tables.map((t) => t.id),
      hint: `フィールドを追加できるのは、自分で定義したテーブルだけです。allowed_values のいずれかを指定してください。`,
    });
    return;
  }
  const table = manifest.app.tables.find((t) => t.id === tableId);
  if (table === undefined) {
    errors.push({
      path: `${path}/table`,
      message:
        `add_field の追加先テーブル "${tableId}" が存在しません。` +
        `フィールドを追加できるのは、既にマニフェストにあるテーブルだけです。`,
      allowed_values: manifest.app.tables.map((t) => t.id),
      hint: `テーブルIDの綴りを確認してください。新しいテーブルなら、先に同じ差分の中で add_table してください。`,
    });
    return;
  }
  if (table.fields.some((f) => f.id === field.id)) {
    errors.push({
      path: `${path}/field/id`,
      message:
        `テーブル "${tableId}" には既にフィールド "${field.id}" があるため add_field で追加できません。` +
        `v0 にはフィールドの再定義(型変更・リネーム)を表す op が存在しません。`,
      allowed_values: table.fields.map((f) => f.id),
      hint: `別の意味の項目なら別のIDで追加してください。表示名だけを変えたい場合は v0 の差分では扱えません。`,
    });
    return;
  }
  table.fields.push(structuredClone(field));
}

function foldAddView(
  manifest: Manifest,
  view: View,
  path: string,
  errors: ValidationError[],
): void {
  if (manifest.app.views.some((v) => v.id === view.id)) {
    errors.push({
      path: `${path}/view/id`,
      message:
        `ビュー "${view.id}" は既に存在するため add_view で追加できません。` +
        `add_view は新しい画面を作る操作であり、既存画面の差し替えはできません。`,
      hint: `既存画面を変えたいなら update_view を使ってください。別の画面を足したいなら別のIDを付けてください。`,
    });
    return;
  }
  manifest.app.views.push(structuredClone(view));
  // **【`V8-M26-T04` / `D-V8-60`】画面と、その画面が持つボタンの規則も自動で足す。**
  // **画面とボタンは3役割とも `read` 1語である**(スキーマがそう閉じている。
  // {@link DEFAULT_ROLE_RULE_VERBS} の doc)。
  grantDefaultRoleRules(manifest, { target: "view", view: view.id });
  grantDefaultActionRules(manifest, view);
}

function foldUpdateView(
  manifest: Manifest,
  viewId: string,
  changes: ViewChanges,
  path: string,
  errors: ValidationError[],
): void {
  const index = manifest.app.views.findIndex((v) => v.id === viewId);
  const view = manifest.app.views[index];
  if (view === undefined) {
    errors.push({
      path: `${path}/view`,
      message:
        `update_view の対象ビュー "${viewId}" が存在しません。` +
        `変更できるのは、既にマニフェストにある画面だけです。`,
      allowed_values: manifest.app.views.map((v) => v.id),
      hint: `画面IDの綴りを確認してください。新しい画面なら add_view で追加してください。`,
    });
    return;
  }

  const allowed = CHANGE_KEYS_BY_VIEW_TYPE[view.type];
  const rejected = (Object.keys(changes) as (keyof ViewChanges)[]).filter(
    (key) => !allowed.includes(key),
  );
  if (rejected.length > 0) {
    for (const key of rejected) {
      errors.push({
        path: `${path}/changes/${key}`,
        // V1-M0-T09 の追補で3種すべてが1つ以上の変更可能キーを持つようになったため、
        // 「変更できる項目がありません」の分岐は消えた(到達しない条件を残さない)。
        message:
          `ビュー "${viewId}" は type が "${view.type}" なので "${key}" を持てません。` +
          `update_view で "${view.type}" に指定できるのは ${allowed.join(" / ")} だけです。`,
        allowed_values: [...allowed],
        hint: `"${key}" を変えたいのであれば、その項目を持つ種別のビューを対象にしてください。`,
      });
    }
    return;
  }

  const updated = applyViewChanges(view, changes);
  manifest.app.views[index] = updated;
  // **【`V8-M26-T04` / `D-V8-60`】`update_view` でボタンを足したら、そのボタンの規則も足す。**
  // **`changes.actions` は全置換なので、ここでは「今そこに在るボタン」を見る** ——
  // **消えたボタンの規則をここで外していない**(**外すのは前進の語彙に無い。正直に書く**)。
  // **画面そのもの(`target: "view"`)の規則はここで足していない** —— **`D-V8-60` の
  // 「作るたび」に当たるのは `add_view` であり、`update_view` は画面を作らない。**
  // **したがって `T03` より前に作られた画面は、`update_view` を打っても閉じたままである。**
  if (changes.actions !== undefined) {
    grantDefaultActionRules(manifest, updated);
  }
}

/*
 * ============================================================================
 * V1-M1-T03: 破壊的 op の畳み込み(ADR-0010)
 *
 * ここが扱うのは**マニフェストの形**だけである。DDL とデータ変換は `migrate.ts` /
 * `rebuild-table.ts` / `convert.ts` が持つ。
 *
 * ## 限定8(システムテーブルは対象にできない)は resolveTable の前に判定する
 *
 * ADR-0006 §7 / §8 の順序規約をそのまま延長したものである。「存在しません」で
 * 返すと、hint が「先に add_table しろ」と、必ず弾かれる操作へ AI を誘導する
 * (`foldAddField` が同じ理由で同じ順序を採っている)。
 *
 * ## rename の参照追随(§5d)は「推論」ではなく「意味論」である
 *
 * 追随させないと rename は必ず参照整合性エラーになり、op が使えない。
 * **追随の範囲は同一マニフェスト内に限る** —— `_changelog` の過去のエントリと
 * 過去のスナップショットは書き換えない(憲法5 の追記専用性 / 過去の状態は過去の
 * IDで書かれているのが正しい)。レコードの値は `reference` が持つのが `_id` で
 * あってテーブルIDではないので、そもそも影響が無い。
 * ============================================================================
 */

/** システムテーブルを対象にした破壊的 op を弾く(限定8)。弾いたら `true`。 */
function rejectSystemTable(
  manifest: Manifest,
  tableId: string,
  path: string,
  errors: ValidationError[],
): boolean {
  if (!isSystemTableId(tableId)) {
    return false;
  }
  errors.push({
    path: `${path}/table`,
    message:
      `システムテーブル "${tableId}" は変更・削除できません(読み取り専用です)。` +
      `システムテーブルのスキーマはカーネルが定数として持っており、差分では変更できません。`,
    allowed_values: manifest.app.tables.map((t) => t.id),
    hint: `変更・削除できるのは、自分で定義したテーブルだけです。allowed_values のいずれかを指定してください。`,
  });
  return true;
}

/** 対象テーブルを解決する。見つからなければエラーを積んで `undefined` を返す。 */
function resolveTable(
  manifest: Manifest,
  tableId: string,
  op: string,
  path: string,
  errors: ValidationError[],
): Table | undefined {
  const table = manifest.app.tables.find((t) => t.id === tableId);
  if (table === undefined) {
    errors.push({
      path: `${path}/table`,
      message:
        `${op} の対象テーブル "${tableId}" が存在しません。` +
        `変更・削除できるのは、既にマニフェストにあるテーブルだけです。`,
      allowed_values: manifest.app.tables.map((t) => t.id),
      hint: `テーブルIDの綴りを確認してください。同じ差分の中で先に消していないかも確認してください。`,
    });
  }
  return table;
}

function foldRemoveField(
  manifest: Manifest,
  tableId: string,
  fieldId: string,
  path: string,
  errors: ValidationError[],
): void {
  if (rejectSystemTable(manifest, tableId, path, errors)) {
    return;
  }
  const table = resolveTable(manifest, tableId, "remove_field", path, errors);
  if (table === undefined) {
    return;
  }
  const index = table.fields.findIndex((field) => field.id === fieldId);
  if (index === -1) {
    errors.push({
      path: `${path}/field`,
      message:
        `remove_field の対象フィールド "${fieldId}" はテーブル "${tableId}" に存在しません。` +
        `削除できるのは、既にマニフェストにあるフィールドだけです。`,
      allowed_values: table.fields.map((field) => field.id),
      hint: `フィールドIDの綴りを確認してください。同じ差分の中で先に消していないかも確認してください。`,
    });
    return;
  }
  table.fields.splice(index, 1);
}

function foldRemoveTable(
  manifest: Manifest,
  tableId: string,
  path: string,
  errors: ValidationError[],
): void {
  if (rejectSystemTable(manifest, tableId, path, errors)) {
    return;
  }
  const table = resolveTable(manifest, tableId, "remove_table", path, errors);
  if (table === undefined) {
    return;
  }
  manifest.app.tables = manifest.app.tables.filter((t) => t.id !== tableId);
}

/**
 * ビューを1つ取り除く(ADR-0012)。
 *
 * **カスケードしない**(限定4)。ビューが参照していたテーブルやフィールドには
 * 一切触らない。失敗は1つだけ —— 対象のビューが存在しないこと。文面と `path` の
 * 作法は `resolveTable` / `foldUpdateView` に完全に揃える(失敗2「畳み込み不能」)。
 *
 * **システムテーブルの判定(限定8)は要らない。** それはテーブルを対象にする op の
 * 話であり、`remove_view` が対象にするのはマニフェストが定義した画面だけである。
 */
function foldRemoveView(
  manifest: Manifest,
  viewId: string,
  path: string,
  errors: ValidationError[],
): void {
  const index = manifest.app.views.findIndex((view) => view.id === viewId);
  if (index === -1) {
    errors.push({
      path: `${path}/view`,
      message:
        `remove_view の対象ビュー "${viewId}" が存在しません。` +
        `削除できるのは、既にマニフェストにある画面だけです。`,
      allowed_values: manifest.app.views.map((view) => view.id),
      hint: `画面IDの綴りを確認してください。同じ差分の中で先に消していないかも確認してください。`,
    });
    return;
  }
  manifest.app.views.splice(index, 1);
}

/*
 * ============================================================================
 * V1-M2-T07: ワークフロー3種の畳み込み(ADR-0013)
 *
 * ここが扱うのは**マニフェストの `app.workflows` の形**だけである。発火も実行も
 * この層にはいない(ADR-0013 §2)。物理スキーマへの影響は**ゼロ**であり、
 * `migrate.ts` は MigrationStep を1つも生まない。
 *
 * ## システムテーブルの判定(`rejectSystemTable` / 限定8)は要らない
 *
 * `foldRemoveView:424-425` がビューについて書いているのと**同じ理由**である ——
 * あれはテーブルIDを**対象**に取る op(remove_table / remove_field / change_table /
 * change_field)のための門であり、ワークフロー3種が対象に取るのは
 * `app.workflows` の要素だけである。
 *
 * ワークフローの中には確かにテーブルIDが3種類現れる(`trigger.table` /
 * `actions[].table` / `history_table`)が、**そこはこの層より前で閉じている** ——
 * 3つとも `schemas/manifest.schema.json` の `$defs/resource_id` を指しており、
 * その `pattern` が `_` 始まりのIDを拒否する(`$defs/view_table_id` のような
 * システムテーブルを許す定義を1つも使っていない)。したがって `_apps` /
 * `_changelog` を書いた差分は `validateDiff` / `validateManifest` の時点で落ち、
 * **畳み込みまで到達しない**(`workflow-schema.test.ts` の限定10 の4テストが実測で
 * 固定している)。ここに二重の門を置くと、`rejectSystemTable` の文面
 * (「変更・削除できるのは自分で定義したテーブルだけです」)がワークフローには
 * 噛み合わないまま増殖する。
 * ============================================================================
 */

/** 現在のワークフローID一覧。`workflows` が未定義なら空配列(省略 = 1つも無い)。 */
function workflowIds(manifest: Manifest): string[] {
  return (manifest.app.workflows ?? []).map((workflow) => workflow.id);
}

/**
 * ワークフローを1本足す(ADR-0013 §4c)。
 *
 * **`app.workflows` は optional である**(ADR-0013 §1: スキーマの `required` に
 * 入れていないので、既存マニフェストは軒並みこのキーを持たない)。未定義なら
 * ここで空配列に初期化する —— 落とすと、既存アプリに初めてワークフローを足す
 * という**最も普通の経路**が例外で死ぬ。
 */
function foldAddWorkflow(
  manifest: Manifest,
  workflow: Workflow,
  path: string,
  errors: ValidationError[],
): void {
  if ((manifest.app.workflows ?? []).some((w) => w.id === workflow.id)) {
    errors.push({
      path: `${path}/workflow/id`,
      message:
        `ワークフロー "${workflow.id}" は既に存在するため add_workflow で追加できません。` +
        `add_workflow は新しい自動化を作る操作であり、既存の自動化の再定義や上書きはできません。`,
      allowed_values: workflowIds(manifest),
      hint: `既存の自動化を変えたいなら update_workflow を使ってください。別の自動化を足したいなら別のIDを付けてください。`,
    });
    return;
  }
  if (manifest.app.workflows === undefined) {
    manifest.app.workflows = [];
  }
  // **コピーを積む**(`foldAddTable:187-193` と同じ理由)。参照のまま積むと、
  // 後続の op や呼び出し側の操作でマニフェスト側を触っただけで
  // **呼び出し側が渡した diff が書き換わる**。その diff はそのまま changelog に
  // 記録されるので、「実際に送られた操作」と「記録された操作」がずれる(憲法5)。
  manifest.app.workflows.push(structuredClone(workflow));
}

/**
 * ワークフローを1本**丸ごと置き換える**(ADR-0013 §4c)。
 *
 * `update_view` と違って `changes` を取らない —— 差分マージではなく全置換である
 * (`$defs/operation` の `workflow` キーは2義に閉じる。ADR-0013 限定3)。
 */
function foldUpdateWorkflow(
  manifest: Manifest,
  workflow: Workflow,
  path: string,
  errors: ValidationError[],
): void {
  const index = (manifest.app.workflows ?? []).findIndex((w) => w.id === workflow.id);
  if (index === -1) {
    errors.push({
      path: `${path}/workflow`,
      message:
        `update_workflow の対象ワークフロー "${workflow.id}" が存在しません。` +
        `変更できるのは、既にマニフェストにある自動化だけです。`,
      allowed_values: workflowIds(manifest),
      hint: `ワークフローIDの綴りを確認してください。新しい自動化なら add_workflow で追加してください。`,
    });
    return;
  }
  const workflows = manifest.app.workflows;
  if (workflows === undefined) {
    // index !== -1 が成立している時点で到達しない(型を絞るためだけの分岐)。
    return;
  }
  workflows[index] = structuredClone(workflow);
}

/**
 * ワークフローを1本取り除く(ADR-0013 §4c)。
 *
 * **カスケードしない**し、**消しても何も戻らない**(ADR-0013 §2(e))—— 消える
 * のはマニフェストの自動化定義だけで、そのワークフローが既に書いた行は残る。
 * 失敗は1つだけ(対象が存在しないこと)で、文面と `path` の作法は
 * `foldRemoveView` に完全に揃える。
 */
function foldRemoveWorkflow(
  manifest: Manifest,
  workflowId: string,
  path: string,
  errors: ValidationError[],
): void {
  const index = (manifest.app.workflows ?? []).findIndex((w) => w.id === workflowId);
  if (index === -1) {
    errors.push({
      path: `${path}/workflow`,
      message:
        `remove_workflow の対象ワークフロー "${workflowId}" が存在しません。` +
        `削除できるのは、既にマニフェストにある自動化だけです。`,
      allowed_values: workflowIds(manifest),
      hint: `ワークフローIDの綴りを確認してください。同じ差分の中で先に消していないかも確認してください。`,
    });
    return;
  }
  manifest.app.workflows?.splice(index, 1);
}

/*
 * ============================================================================
 * V1-M6-T05: 関数3種の畳み込み(ADR-0024)
 *
 * `foldAddWorkflow` / `foldUpdateWorkflow` / `foldRemoveWorkflow` と**完全に同型**である
 * (対象が `app.workflows` ではなく `app.functions` になるだけ)。ここが扱うのは
 * **マニフェストの `app.functions` の形**だけで、島の実行(第2段 T03)はこの層にいない。
 * 物理スキーマへの影響は**ゼロ**であり、`migrate.ts` は MigrationStep を1つも生まない。
 *
 * ## システムテーブルの判定(`rejectSystemTable` / 限定8)は要らない
 *
 * `foldAddWorkflow` 群と同じ理由である —— あれはテーブルIDを**対象**に取る op のための
 * 門であり、関数3種が対象に取るのは `app.functions` の要素だけである。関数の中に現れる
 * `input.table` / `input.view` はこの層より前で閉じている —— どちらも
 * `$defs/resource_id`(`_` 始まりを拒否する方)を指しており、システムテーブルを書いた
 * 差分は `validateDiff` / `validateManifest` の時点で落ち、畳み込みまで到達しない。
 * ============================================================================
 */

/** 現在の関数ID一覧。`functions` が未定義なら空配列(省略 = 1つも無い)。 */
function functionIds(manifest: Manifest): string[] {
  return (manifest.app.functions ?? []).map((fn) => fn.id);
}

/**
 * 関数を1本足す(ADR-0024)。
 *
 * **`app.functions` は optional である**(`foldAddWorkflow` と同じ)—— 未定義なら
 * ここで空配列に初期化する。落とすと、既存アプリに初めて関数を足すという最も普通の
 * 経路が例外で死ぬ。
 */
function foldAddFunction(
  manifest: Manifest,
  fn: FunctionDef,
  path: string,
  errors: ValidationError[],
): void {
  if ((manifest.app.functions ?? []).some((f) => f.id === fn.id)) {
    errors.push({
      path: `${path}/function/id`,
      message:
        `関数 "${fn.id}" は既に存在するため add_function で追加できません。` +
        `add_function は新しい関数を作る操作であり、既存の関数の再定義や上書きはできません。`,
      allowed_values: functionIds(manifest),
      hint: `既存の関数を変えたいなら update_function を使ってください。別の関数を足したいなら別のIDを付けてください。`,
    });
    return;
  }
  if (manifest.app.functions === undefined) {
    manifest.app.functions = [];
  }
  // **コピーを積む**(`foldAddWorkflow` と同じ理由 —— 参照のまま積むと、後続の op や
  // 呼び出し側の操作でマニフェスト側を触っただけで呼び出し側が渡した diff が書き換わり、
  // 「実際に送られた操作」と「記録された操作」がずれる。憲法5)。
  manifest.app.functions.push(structuredClone(fn));
}

/**
 * 関数を1本**丸ごと置き換える**(ADR-0024)。
 *
 * `update_view` と違って `changes` を取らない —— 差分マージではなく全置換である
 * (`$defs/operation` の `function` キーは2義に閉じる。ADR-0024 §4c)。
 */
function foldUpdateFunction(
  manifest: Manifest,
  fn: FunctionDef,
  path: string,
  errors: ValidationError[],
): void {
  const index = (manifest.app.functions ?? []).findIndex((f) => f.id === fn.id);
  if (index === -1) {
    errors.push({
      path: `${path}/function`,
      message:
        `update_function の対象関数 "${fn.id}" が存在しません。` +
        `変更できるのは、既にマニフェストにある関数だけです。`,
      allowed_values: functionIds(manifest),
      hint: `関数IDの綴りを確認してください。新しい関数なら add_function で追加してください。`,
    });
    return;
  }
  const functions = manifest.app.functions;
  if (functions === undefined) {
    // index !== -1 が成立している時点で到達しない(型を絞るためだけの分岐)。
    return;
  }
  functions[index] = structuredClone(fn);
}

/**
 * 関数を1本取り除く(ADR-0024)。
 *
 * **カスケードしない**し、**消しても何も戻らない**(ADR-0024 §8。`remove_workflow` と
 * 同型)—— 消えるのはマニフェストの関数定義だけで、その関数が既に output_table に
 * 書いた行は残る。失敗は1つだけ(対象が存在しないこと)。
 */
function foldRemoveFunction(
  manifest: Manifest,
  functionId: string,
  path: string,
  errors: ValidationError[],
): void {
  const index = (manifest.app.functions ?? []).findIndex((f) => f.id === functionId);
  if (index === -1) {
    errors.push({
      path: `${path}/function`,
      message:
        `remove_function の対象関数 "${functionId}" が存在しません。` +
        `削除できるのは、既にマニフェストにある関数だけです。`,
      allowed_values: functionIds(manifest),
      hint: `関数IDの綴りを確認してください。同じ差分の中で先に消していないかも確認してください。`,
    });
    return;
  }
  manifest.app.functions?.splice(index, 1);
}

/*
 * ============================================================================
 * V3-M1-T03: テーマの畳み込み(ADR-0047。16種目の op = set_theme)
 *
 * **失敗の形が1つも無い唯一の op である。** 他の15種は「対象が実在するか」「IDが
 * 重複しないか」を見るが、テーマは app に1つしか無く、対象IDを取らないので
 * 「対象が存在しない」も「既に存在する」も起こらない —— **テーマを持たない
 * アプリへの初回適用と、既にテーマを持つアプリの差し替えが、同じ1つの形で通る。**
 * したがって `errors` を1件も積まず、引数にも取らない。
 *
 * **値の妥当性(25スロットがそろっているか / 値域 / コントラスト比)はここで見ない。**
 * 見るのは `validateDiff`(差分の時点)と `validateManifestFull`(畳み込み後の
 * `"incoming"` 検証)であり、二重に持つと文面が割れる(`foldOperations` が op の
 * 妥当性を `planMigration` と二重に持たないのと同じ作法)。**拒否は「全か無か」で
 * あり、どちらの検査もスナップショット取得より前に走る**(ADR-0047 限定9)。
 *
 * 物理スキーマへの影響は**ゼロ**であり、`migrate.ts` は MigrationStep を1つも生まない。
 * ============================================================================
 */

/**
 * テーマを**丸ごと差し替える**(ADR-0047 限定3。部分更新の op は無い)。
 *
 * **コピーを積む**(`foldAddFunction` などと同じ理由 —— 参照のまま積むと、呼び出し側が
 * 渡した diff がマニフェスト側の操作で書き換わり、「実際に送られた操作」と
 * 「記録された操作」がずれる。憲法5)。
 */
function foldSetTheme(manifest: Manifest, theme: Theme): void {
  manifest.app.theme = structuredClone(theme);
}

/*
 * ============================================================================
 * **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11` / `T-G9a`。判定値 = 廃止】**
 *
 * **ここに在った `foldSetUserKinds`(利用者の種類の宣言の畳み込み。`ADR-0248`)と、
 * その節全体を取り除いた。** **書き込む先の `manifest.app.user_kinds` が同じ差分で
 * 消えたためである。**
 *
 * **代わりに立つのは下の `foldSetRoles` である**(`ADR-0301` 限定2)—— **失敗の形が
 * 1つも無いこと・対象IDを取らないこと・コピーを積むことまで同型である。**
 * **担い手を失う機能は本関数については0件である。**
 * ============================================================================
 */

/*
 * ============================================================================
 * V8-M16: 役割の宣言の畳み込み(台帳 J-G1b / D-V8-31。18種目の op = set_roles)
 *
 * **`foldSetTheme` / `foldSetUserKinds` と同じく、失敗の形が1つも無い。** 対象IDを
 * 取らない(役割の一覧は app に1つしか無い)ので「対象が存在しない」も「既に存在する」
 * も起こらない —— **宣言を持たないアプリへの初回適用と、既に宣言を持つアプリの
 * 差し替えが、同じ1つの形で通る。**したがって `errors` を1件も積まず、引数にも取らない。
 *
 * **値の妥当性(1〜12件 / 識別子の形)はここで見ない。**見るのは `validateDiff`
 * (差分の時点)と `validateManifestFull`(畳み込み後の `"incoming"` 検証)である。
 * **値域の定義は `schemas/manifest.schema.json` の `$defs/app/properties/roles` の
 * 1箇所だけであり、差分スキーマはそれを `$ref` するだけである。**
 *
 * **同じ `id` を2回書いた宣言は、`src/kernel/referential-integrity.ts` の適用時検査が
 * 拒否する** —— `uniqueItems` はオブジェクト全体の同値でしか効かず、`id` が同じで
 * `name` が違う2本を通してしまうためである(`user_kinds` が今日も塞げていない穴を、
 * `roles` では塞いだ)。
 *
 * 物理スキーマへの影響は**ゼロ**であり、`migrate.ts` は MigrationStep を1つも生まない。
 * **【正直に書く】認可の挙動は1バイトも変わらない** —— 規則(`rules`)は `V8-M17`、
 * 条件(`when`)は `V8-M18` が足す。**今日この宣言を書いても、行の読取・書込・削除の
 * ふるまいは1つも変わらない。**
 * ============================================================================
 */

/**
 * **条件を1つも書かなかった表の規則に、自動で入るのと同じ条件を補う。**
 *
 * **【`V8-M40`。台帳 `F-G10`。ユーザ決定 `D-V8-98`。`ADR-0331`】**
 *
 * ## **何を塞いでいるか(実測が先に在る)**
 *
 * **`docs/evidence/cp-v8-unify.md:2216` の逐語**: 「**同時刻の4相手で数え直した** ——
 * **`alice`(owner)16 / `bob`(editor)10 / `carol`(viewer)8 / **`dave`(reviewer)19**。**
 * **owner より reviewer のほうが多く読める。**」
 * **原因は `v8-m33.md:289` の逐語**: 「**この条件は既定3役割にしか付いていない。
 * アプリが足した `reviewer` / `anonymous` には1本も付いていない。**」
 *
 * **`V8-M40` が自分の台で再現した実数**: **`alice` 6 / `bob` 5 / `carol` 2 /
 * **`dave` 9**(`st_owner` を持つ表 `memos`。同じ口・同じ引数)。 **同じ向きの逆転である。**
 *
 * ## **補う条件は {@link defaultTableGrantPlan} が返すものそのものである**
 *
 * **同じ条件を2箇所が別々に持たない** —— **この関数は条件のリテラルを1つも持たず、
 * `defaultTableGrantPlan` を呼ぶ。** **したがって `add_table` の自動付与と、
 * `set_roles` の補完は、常に1バイトも違わない。**
 *
 * ## **補う対象は全役割である(`DEFAULT_ROLE_IDS` の3語に限らない)**
 *
 * **`v8-m35.md` §5-4 の `S3` の3点目の逐語**: 「**「後から足した」を機械的に見分ける
 * 手段が無い。** **`set_roles` は全置換なので、既定3語と後から足した語の区別は
 * `DEFAULT_ROLE_IDS` への所属だけで付く。** **利用者が既定3語と同名の役割を書いた場合の
 * 挙動を、本審査は測っていない。**」
 * **本関数はその区別を1度も使わない** —— **`DEFAULT_ROLE_IDS` を1バイトも読まない。**
 * **代償**: **既定3役割の規則を条件なしで書き直した作者にも補いが掛かる**
 * (`role-default-grant.test.ts` の (o-3))。 **利得**: **「後から足した」の判定が要らない。**
 *
 * ## **逃げ道(全行を見せたい作者)**
 *
 * **`when` を明示的に書けば補完は掛からない** —— **本関数が触るのは
 * `when === undefined` の規則だけである。**
 * **「常に真」の条件は今日の語彙だけで書ける**(実測。`role-default-grant.test.ts` の (o-2)):
 * **`{ or: [ {field: st_owner, is_empty: true}, { not: {field: st_owner, is_empty: true} } ] }`。**
 * **`V8-M40` は実 HTTP でも確かめた** —— **この条件を持つ役割は補完の後も全行(9件)を
 * 受け取る。**
 *
 * ## **{@link ADR-0318} 限定12 との関係(正面から当たる。隠さない)**
 *
 * **限定12 の逐語**: 「**カーネルは作者の宣言を上書きしない。既に在る規則の動詞を1語も
 * 書き換えない・1本も消さない。足すだけである。**」
 * **本関数は動詞を1語も書き換えず、規則を1本も消さない**((o-8))。 **足すのは `when` 1つ
 * だけである。** **それでも「書いていないものを補う」ことは限定12 が守る線の同じ側に
 * 立つ** —— **`ADR-0331` がこの衝突を引き受けた**(`ADR-0318` の `amended_by` に `331`)。
 *
 * ## **【今日この関数が塞いでいないもの。丸めない】**
 *
 * - **順序に依る**: **同じ差分で `set_roles` を `add_table` / `add_field` より**先**に
 *   並べると、その時点の表の姿しか見えないので補わない((o-11))。
 * - **`add_field` で後から `st_owner` を足した表は、`set_roles` が来るまで補われない** ——
 *   **`add_field` の畳み込みは規則を1本も触らない**(`defaultTableGrantPlan` の doc が
 *   自認している穴は、`set_roles` 経由でだけ塞がる)。
 * - **実在しない表を名指しした規則は今日も拒否されない**((o-7))。 **本関数は拒否を
 *   1本も増やさない** —— **表を引けないので何もしない。**
 *
 * ## **【2026-09-08 追記(`V17-M5-T05` / 台帳 `AC-G33`(`:1862`)/ `ADR-0423`)。
 *    直前の3項を1バイトも消していない】**
 *
 * **上の3項のうち、最初の2項は今日は偽である。**
 *
 * - **「順序に依る」は今日は偽である** —— **本関数を呼ぶ位置が {@link foldOperations} の
 *   出口(すべての op を畳み終えた後)へ移ったので、同じ差分で `set_roles` を
 *   `add_table` / `add_field` より先に並べても、見るのは畳み終えた後の姿である。**
 * - **「`add_field` で後から `st_owner` を足した表は、`set_roles` が来るまで補われない」も
 *   今日は偽である** —— **`set_roles` を1本も含まない差分でも、出口で1度走る。**
 *   **「`add_field` の畳み込みは規則を1本も触らない」は今日も真である**
 *   (**触るのは畳み込みが終わった後の1回だけであり、`foldAddField` は1バイトも
 *   変わっていない**)。
 * - **3項目(実在しない表を名指しした規則)は今日も真である** —— **本関数は今日も
 *   拒否を1本も増やさない。**
 *
 * **【本関数が今日も塞いでいないもの。丸めない】**
 *
 * - **一度補った条件は、あとから `st_owner` の列を消しても外れない**(カスケードしない。
 *   `defaultTableGrantPlan` の doc の `change_table` の項と同じ作法)。
 * - **作者が書いた条件と、本関数が補った条件は、適用後のマニフェストの上では
 *   1バイトも区別が付かない** —— **区別できるのは、補った差分の応答に載る知らせ
 *   (`owner_scope_supplied`)を読んだ人だけである。**
 * - **知らせは補った瞬間の1回しか出ない** —— **次の差分では既に `when` が在るので、
 *   本関数は素通りし、知らせも出ない。**
 */
function supplyOwnerScopeConditions(manifest: Manifest): OwnerScopeSupply[] {
  // **【2026-09-08 追記(`V17-M5-T05` / `AC-G33` / `ADR-0423`)。旧の1行を逐語で残す】**
  // **旧: `function supplyOwnerScopeConditions(manifest: Manifest): void {`**
  // **旧: `  for (const declaration of manifest.app.roles ?? []) {`**
  // **旧: `    for (const rule of declaration.rules ?? []) {`**
  // **書いた規則の位置を返すようにした** —— **補ったことを知らせに変えるのは
  // `applyDiff` の側であり、この関数は知らせを1件も組み立てない。**
  // **書き込む中身(`rule.when`)は1バイトも変えていない。**
  // **`for ... of` と `continue` の形はそのまま残した**(`.entries()` で位置を添えただけ
  // である)—— **`ADR-0423` 限定2 の第3列が「`rule.when !== undefined` の `continue` が
  // 残っていること」を式にしているので、`forEach` に書き換えるとその式が実装の側から
  // 偽になる**(記憶 `limit-table-checks-can-be-born-false` の同型を作らない)。
  const supplies: OwnerScopeSupply[] = [];
  for (const [roleIndex, declaration] of (manifest.app.roles ?? []).entries()) {
    for (const [ruleIndex, rule] of (declaration.rules ?? []).entries()) {
      // **表の規則だけである** —— **画面・ボタン・`app` / `role` には判定する行が1つも
      // 無く、スキーマの `allOf` が `when: false` で閉じている**({@link RoleRule} の doc)。
      if (rule.target !== "table" || rule.when !== undefined) {
        continue;
      }
      const table = manifest.app.tables.find((candidate) => candidate.id === rule.table);
      if (table === undefined) {
        continue;
      }
      const plan = defaultTableGrantPlan(table);
      if (plan.kind !== "grant" || plan.when === undefined) {
        continue;
      }
      // **規則ごとに写しを配る**({@link grantDefaultRoleRules} と同じ理由 ——
      // 同じオブジェクトを共有すると、あとで1本を書き換えたときに他まで変わる)。
      rule.when = structuredClone(plan.when);
      supplies.push({
        role: declaration.id,
        // **ここに来るのは `rule.table` が実在する表を指しているときだけである**
        // (上の `find` が `undefined` を弾いている)。
        table: table.id,
        roleIndex,
        ruleIndex,
      });
    }
  }
  return supplies;
}

/**
 * 役割の宣言を**丸ごと差し替える**(部分更新の op は無い)。
 *
 * **コピーを積む**(`foldSetTheme` / `foldSetUserKinds` と同じ理由。憲法5)。
 *
 * **【`V8-M40` / `F-G10` / `D-V8-98`。旧の1行を逐語で残す】**
 * **旧: `function foldSetRoles(manifest: Manifest, roles: RoleDeclaration[]): void {
 * manifest.app.roles = structuredClone(roles); }`**
 * **今日は写しを積んだ**後**に {@link supplyOwnerScopeConditions} を1度呼ぶ** ——
 * **呼び出し側が渡した `roles` は1バイトも書き換わらない**(補うのは写しの側である)。
 *
 * **【2026-09-08 追記(`V17-M5-T05` / 台帳 `AC-G33`(`:1862`)/ `ADR-0423`)。
 * 上の段落を1バイトも消していない】**
 * **上の「今日は写しを積んだ**後**に {@link supplyOwnerScopeConditions} を1度呼ぶ」は、
 * 今日は偽である。** **呼び出しはこの関数から外し、{@link foldOperations} の出口
 * (すべての op を畳み終えた後)へ移した。** **この関数は写しを積むだけに戻った。**
 * **「呼び出し側が渡した `roles` は1バイトも書き換わらない」は今日も真である**
 * (補うのは畳み込み後のマニフェストの側であり、引数の `roles` ではない)。
 */
function foldSetRoles(manifest: Manifest, roles: RoleDeclaration[]): void {
  // **【2026-09-08。`V17-M5-T05` / `AC-G33` / `ADR-0423`。旧の1行を逐語で残す】**
  // **旧: `  supplyOwnerScopeConditions(manifest);`**
  // **この1行を外した。** **呼ぶのは {@link foldOperations} の出口の1箇所だけである** ——
  // **`set_roles` の時点の表の姿しか見えない位置で呼んでいたことが、
  // 台帳 `AC-G33` の穴3つ(後から足した `st_owner` / 順序依存 / 二重呼び出し)の
  // 出どころそのものだった。**
  manifest.app.roles = structuredClone(roles);
}

function foldChangeTable(
  manifest: Manifest,
  tableId: string,
  changes: TableChanges,
  path: string,
  errors: ValidationError[],
): void {
  if (rejectSystemTable(manifest, tableId, path, errors)) {
    return;
  }
  const table = resolveTable(manifest, tableId, "change_table", path, errors);
  if (table === undefined) {
    return;
  }
  if (changes.name !== undefined) {
    table.name = changes.name;
  }
  /*
   * **`K-G6` / `V6-M3-T01` / `ADR-0290` 限定11**: 探せる項目の既定
   * (`reference_search_fields`)を運ぶ。
   *
   * **`representative_field` は同じ `table_changes` に在りながら、ここで運ばれない**
   * —— **`ADR-0080` 限定6 が `src/kernel/` への差分を1バイトも禁じていたためである。**
   * **その結果あちらは「受理はされるが値が適用後マニフェストに残らない」** ——
   * **`ADR-0290` の限定表は `src/kernel/` を1つも禁じていないので、本キーは同じ穴を
   * 踏まない**(限定11)。**この非対称は隠さない。**
   *
   * **全置換である** —— 書いた配列がそのまま新しい値になり、**1本ずつ足す / 消す手段を
   * 1つも作っていない。** **書かない `change_table` は既存の値を1バイトも触らない。**
   *
   * **値域(実在・`text` / `long_text`・役割の規則が名指ししていないこと)はここでは
   * 1つも見ない**(**【`V8-M20-T02`。台帳 `J-G28`】3つ目の着手前の逐語は `audience`
   * だった。そのキーは廃止されたので、同じ問いを面について問い直した**)——
   * **それは `src/kernel/referential-integrity.ts` の1箇所の担当である**(限定6)。
   */
  if (changes.reference_search_fields !== undefined) {
    table.reference_search_fields = changes.reference_search_fields;
  }
  /*
   * **`Z-G37` / `V7-M1-T03`**: **すでに使っている表に、あとからアクセス権管理を
   * 有効にする**(`schemas/diff.schema.json` の `$defs/table_changes` の**5キー目**)。
   *
   * **値を運ぶ。** **`representative_field` の「受理はされるが適用後マニフェストに
   * 残らない」穴を、新しいキーで踏み直さない**(1つ上の `reference_search_fields` の
   * コメントが同じ理由を書いている)。**実測は `src/kernel/apply-diff.test.ts` の
   * `V7-M1-T03` 群**(`change_table` / `add_table` / `enabled: false` へ戻す /
   * 丸ごと差し替える の4経路を、**ディスクの適用後マニフェスト**で測っている)。
   *
   * **コピーを積む**(`foldAddTable` / `foldSetTheme` と同じ理由。憲法5)——
   * 参照のまま積むと、**呼び出し側が渡した diff がマニフェスト側の書き換えで
   * 変わりうる。** その diff はそのまま changelog に記録される。
   *
   * **全置換である** —— 書いたオブジェクトがそのまま新しい宣言になり、**中の1本だけを
   * 足す / 消す手段を1つも作っていない。** **書かない `change_table` は既存の宣言を
   * 1バイトも触らない。**
   *
   * **値域(`permissions[].id` の重複・`creator_permission` の実在・`grant` /
   * `members` / `groups` が指した表と列の実在と型)はここでは1つも見ない** ——
   * **`V7-M1-T05`(`src/kernel/referential-integrity.ts`)の担当である。**
   * **今日は指し先が消えても通る**(実測は同テストの (6) / (7))。
   */
  if (changes.access_control !== undefined) {
    table.access_control = structuredClone(changes.access_control);
  }
  const nextId = changes.id;
  if (nextId === undefined || nextId === tableId) {
    return;
  }
  if (manifest.app.tables.some((t) => t.id === nextId)) {
    errors.push({
      path: `${path}/changes/id`,
      message:
        `テーブルIDを "${nextId}" に変更できません。同じIDのテーブルが既に存在します。` +
        `テーブルIDはアプリ内で一意である必要があります。`,
      allowed_values: manifest.app.tables.map((t) => t.id),
      hint: `別のIDを指定するか、先に既存の "${nextId}" を remove_table してください。`,
    });
    return;
  }
  table.id = nextId;
  // --- §5d: マニフェスト内の参照を追随させる -------------------------------
  for (const view of manifest.app.views) {
    if (view.table === tableId) {
      view.table = nextId;
    }
  }
  for (const other of manifest.app.tables) {
    for (const field of other.fields) {
      if (field.type === "reference" && field.reference_table === tableId) {
        field.reference_table = nextId;
      }
    }
  }
  // --- §5d: ワークフローのテーブル参照を追随させる -------------------------
  // ワークフローは同一マニフェスト内にあるので追随の範囲内である。参照は3か所
  // ある(入力1 / 出力2)—— `trigger.table` / `actions[].table` / `history_table`。
  // **3つは独立に判定する。**1つのワークフローが同じテーブルを複数の役割で参照して
  // いることがあり(例: 本の変更を本自身に記録する)、そのときは全部が動く。
  // 追随させないと参照整合性がこの rename を必ず拒否し、op が使えなくなる。
  for (const workflow of manifest.app.workflows ?? []) {
    if (workflow.trigger.type !== "schedule" && workflow.trigger.table === tableId) {
      workflow.trigger.table = nextId;
    }
    for (const action of workflow.actions) {
      // `run_function` は `table` の代わりに `output_table`(出力の書き込み先)を持つ
      // (ADR-0024)。テーブル rename に**追随させないと**参照整合性がこの rename を拒否する。
      if (action.action === "run_function") {
        if (action.output_table === tableId) {
          action.output_table = nextId;
        }
        continue;
      }
      // `call_external` / `ai_transform` は内部の書き込み先 `table` を持たない
      // (前者の宛先は connection のスコープ内の URL、後者の書き戻し先はトリガー元テーブルの
      // output_field で、下の history_table 追随ではなく change_field の追随で扱う)。
      if (
        action.action !== "call_external" &&
        action.action !== "ai_transform" &&
        action.table === tableId
      ) {
        action.table = nextId;
      }
    }
    if (workflow.history_table === tableId) {
      workflow.history_table = nextId;
    }
  }
  // --- §5d: 関数の入力テーブル参照を追随させる(ADR-0024)--------------------
  // 関数がテーブルを参照するのは `input.source === "table"` の1か所だけである
  // (`input.view` は list_view のIDで、テーブルIDではない。`source === "record"` は
  // テーブルを参照しない)。追随させないと参照整合性がこの rename を必ず拒否する。
  //
  // **ADR-0062(複数入力)により `input` は配列形も取る。** 単体形と配列形で規則を割らない
  // ため、どちらも「入力宣言の並び」に均して同じ1つの条件を当てる(**新しい規則を1つも
  // 足していない** —— 当てる条件は今日と同一の `source === "table"` である)。
  for (const fn of manifest.app.functions ?? []) {
    for (const one of Array.isArray(fn.input) ? fn.input : [fn.input]) {
      if (one.source === "table" && one.table === tableId) {
        one.table = nextId;
      }
    }
  }
  // --- §5d: 役割の規則のテーブル参照を追随させる(`V8-M26-T04` の追随)--------
  //
  // **【なぜ本タスクがこれを足したか。実測で赤くなった】**
  // **`T04` が「表を作るたびに3役割へ規則を1本ずつ足す」を入れたので、
  // `T04` より後に作られた表は必ず `app.roles[].rules` から名指しされている。**
  // **追随させないと、その表の rename を参照整合性(`referential-integrity.ts` の
  // 類型16)が**必ず**拒否し、`change_table` の rename が使えなくなる**
  // (`src/kernel/requirements-doc.test.ts` の「テーブルの rename でもフィールドの
  // 帰属を見失わない」が実際に赤くなった)。
  // **これは上の doc の逐語「追随させないと rename は必ず参照整合性エラーになり、
  // op が使えない」がそのまま当たる場面である** —— **新しい規則を1つも作っていない。**
  //
  // **`target` が `table` の規則と `field` の規則の両方が `rule.table` を持つ**
  // (スキーマの `allOf` が両方に `required: ["table"]` を課している)ので、**種類で割らない。**
  // **`rule.when` の中は1バイトも見ない** —— **あそこが持つのは項目IDであってテーブルIDではない。**
  for (const role of manifest.app.roles ?? []) {
    for (const rule of role.rules ?? []) {
      if (rule.table === tableId) {
        rule.table = nextId;
      }
    }
  }
}

function foldChangeField(
  manifest: Manifest,
  tableId: string,
  fieldId: string,
  changes: FieldChanges,
  path: string,
  errors: ValidationError[],
): void {
  if (rejectSystemTable(manifest, tableId, path, errors)) {
    return;
  }
  const table = resolveTable(manifest, tableId, "change_field", path, errors);
  if (table === undefined) {
    return;
  }
  const index = table.fields.findIndex((field) => field.id === fieldId);
  const from = table.fields[index];
  if (from === undefined) {
    errors.push({
      path: `${path}/field`,
      message:
        `change_field の対象フィールド "${fieldId}" はテーブル "${tableId}" に存在しません。` +
        `変更できるのは、既にマニフェストにあるフィールドだけです。`,
      allowed_values: table.fields.map((field) => field.id),
      hint: `フィールドIDの綴りを確認してください。新しい項目なら add_field を使ってください。`,
    });
    return;
  }
  const nextId = changes.id;
  if (nextId !== undefined && nextId !== fieldId && table.fields.some((f) => f.id === nextId)) {
    errors.push({
      path: `${path}/changes/id`,
      message:
        `フィールドIDを "${nextId}" に変更できません。テーブル "${tableId}" には同じIDのフィールドが既に存在します。` +
        `フィールドIDは同一テーブル内で一意である必要があります。`,
      allowed_values: table.fields.map((field) => field.id),
      hint: `別のIDを指定するか、先に既存の "${nextId}" を remove_field してください。`,
    });
    return;
  }

  /*
   * **`E-G14` / `V4-M10-T46` / `ADR-0086` 限定4**: **単位は `number` 型にだけ書ける。**
   *
   * **形の担保はマニフェストスキーマの `allOf` にもある**が、それは「適用後マニフェストの
   * 構造検証」であって、そこで落ちると **`unit` が原因だと読める JSON Pointer が返らない**。
   * **`ADR-0086` 限定4 は「書いたら差分全体を拒否する」だけでなく『「書けるが効かない
   * 組み合わせ」を1つも作らない』ことを求めている**ので、**ここで名指しの拒否を返す。**
   *
   * **拒否であって、値を黙って捨てる形ではない**(`ADR-0010` 限定7 と同じ側)。
   */
  const nextType = changes.type ?? from.type;
  if (changes.unit !== undefined && nextType !== "number") {
    errors.push({
      path: `${path}/changes/unit`,
      message:
        `フィールド "${fieldId}" は type が "${nextType}" なので unit(値の単位)を持てません。` +
        `unit を書けるのは number 型のフィールドだけです。`,
      allowed_values: ["number"],
      hint:
        `単位を出したいのであれば、そのフィールドの type を number にしてください。` +
        `number にできないのであれば、単位は表示名(name)に書いてください` +
        `(「税込」のような但し書きも単位ではないので name に書きます)。`,
    });
    return;
  }

  /*
   * **`P-G28` + `P-G22` / `V4-M16-T10` / `ADR-0090` 限定4**: **強調は `select` 型にだけ
   * 書ける。**
   *
   * **上の `unit` の分岐と同型の名指しの拒否である。** 形の担保はマニフェストスキーマの
   * `allOf`(4本目の分岐)にもあるが、そこで落ちると **`emphasis` が原因だと読める
   * JSON Pointer が返らない**。**`ADR-0090` 限定4 は「書いたら差分全体を拒否する」だけで
   * なく『「書けるが効かない組み合わせ」を1つも作らない』ことを求めている**ので、
   * **ここで名指しの拒否を返す。**
   *
   * **拒否であって、値を黙って捨てる形ではない**(`ADR-0010` 限定7 と同じ側)。
   * **`options` に無い値をキーに書いた場合の拒否はここではない** ——
   * **適用後マニフェストを見る `validateReferentialIntegrity` が持つ**(限定4 後段)。
   */
  if (changes.emphasis !== undefined && nextType !== "select") {
    errors.push({
      path: `${path}/changes/emphasis`,
      message:
        `フィールド "${fieldId}" は type が "${nextType}" なので emphasis(値ごとの強調)を持てません。` +
        `emphasis を書けるのは select 型のフィールドだけです。`,
      allowed_values: ["select"],
      hint:
        `値によって見た目を変えたいのであれば、そのフィールドの type を select にして、` +
        `options に選択肢を並べてください。` +
        `select にできないのであれば、強調を表す手段はありません` +
        `(色の実値も CSS も1バイトも書けません)。`,
    });
    return;
  }

  /*
   * **`K-G1` / `K-G4` / `V6-M1-T02` / `ADR-0288` 限定4**: **選び方は `reference` 型にだけ
   * 書ける。**
   *
   * **上の `unit` / `emphasis` の分岐と同型の名指しの拒否である。** 形の担保はマニフェスト
   * スキーマの `allOf`(5本目の分岐)にもあるが、そこで落ちると **`reference_picker` が
   * 原因だと読める JSON Pointer が返らない**。**`ADR-0288` 限定4 は「書いたら差分全体を
   * 拒否する」だけでなく『「書けるが効かない組み合わせ」を型の側では1つも作らない』ことを
   * 求めている**ので、**ここで名指しの拒否を返す。**
   *
   * **拒否であって、値を黙って捨てる形ではない**(`ADR-0010` 限定7 と同じ側)。
   */
  if (changes.reference_picker !== undefined && nextType !== "reference") {
    errors.push({
      path: `${path}/changes/reference_picker`,
      message:
        `フィールド "${fieldId}" は type が "${nextType}" なので reference_picker(選び方)を持てません。` +
        `reference_picker を書けるのは reference 型のフィールドだけです。`,
      allowed_values: ["reference"],
      hint:
        `他のテーブルから選ぶ形にしたいのであれば、そのフィールドの type を reference にして、` +
        `reference_table に参照先のテーブルIDを書いてください。` +
        `reference にできないのであれば、選び方を指定する手段はありません` +
        `(select の options には選び方を1つも書けません)。`,
    });
    return;
  }

  /*
   * **`K-G7` / `V6-M3-T02` / `ADR-0290` 限定11**: **「探せる項目」の上書きは `reference`
   * 型にだけ書ける。**
   *
   * **上の `reference_picker` の分岐とまったく同型の名指しの拒否である。** 形の担保は
   * マニフェストスキーマの `allOf`(6本目の分岐)にもあるが、そこで落ちると
   * **`reference_search_fields` が原因だと読める JSON Pointer が返らない。**
   *
   * **値域(実在・`text` / `long_text`・役割の規則が名指ししていないこと)はここでは
   * 1つも見ない**(**【`V8-M20-T02`。台帳 `J-G28`】3つ目の着手前の逐語は `audience`
   * だった。そのキーは廃止されたので、同じ問いを面について問い直した**)——
   * **それは `src/kernel/referential-integrity.ts` の1箇所の担当である**
   * (`ADR-0290` 限定6。**判定を2箇所に住まわせない**)。**ここが見るのは型だけである。**
   */
  if (changes.reference_search_fields !== undefined && nextType !== "reference") {
    errors.push({
      path: `${path}/changes/reference_search_fields`,
      message:
        `フィールド "${fieldId}" は type が "${nextType}" なので reference_search_fields(探せる項目)を持てません。` +
        `reference_search_fields を書けるのは reference 型のフィールドだけです。`,
      allowed_values: ["reference"],
      hint:
        `他のテーブルから選ぶ形にしたいのであれば、そのフィールドの type を reference にして、` +
        `reference_table に参照先のテーブルIDを書いてください。` +
        `reference にできないのであれば、探せる項目を指定する手段はありません。`,
    });
    return;
  }

  table.fields[index] = buildChangedField(from, changes);

  if (nextId === undefined || nextId === fieldId) {
    return;
  }
  /**
   * 列ごとのプリセットのマップ(`{<field_id>: 段階値}`)のキーだけを新IDへ写す。
   * **値の型ごとに書き分けないための局所ヘルパである**(新しい export は作らない
   * = ADR-0050 限定4)。`fieldId` を持たないマップはそのまま返す(同一性を保つ)。
   */
  const renamePresetMapKey = <T extends string>(map: Record<string, T>): Record<string, T> => {
    if (!(fieldId in map)) {
      return map;
    }
    const renamed: Record<string, T> = {};
    for (const [key, value] of Object.entries(map)) {
      renamed[key === fieldId ? nextId : key] = value;
    }
    return renamed;
  };

  // --- §5d: 同一マニフェスト内のビュー参照を追随させる ---------------------
  // 対象は「このテーブルを見ているビュー」だけである。別テーブルのビューが
  // 同名のフィールドを持っていても、それは別のフィールドである。
  for (const view of manifest.app.views) {
    if (view.table !== table.id) {
      continue;
    }
    if (view.type === "list_view") {
      view.columns = view.columns.map((id) => (id === fieldId ? nextId : id));
      if (view.sort !== undefined) {
        view.sort = Array.isArray(view.sort)
          ? view.sort.map((key) => (key.field === fieldId ? { ...key, field: nextId } : key))
          : view.sort.field === fieldId
            ? { ...view.sort, field: nextId }
            : view.sort;
      }
      if (view.filter !== undefined) {
        // filter は等値AND配列 | ブール式(EC-G12 / ADR-0043)。どちらの形でも
        // 葉の field 参照だけを新IDへ写す(演算子・結合の構造は保つ)。
        view.filter = renameFilterField(view.filter, fieldId, nextId);
      }
      // 列ごとのプリセット(D-G4 / ADR-0050)。**キーがフィールドIDのマップ**なので、
      // キーだけを新IDへ写す(値 = 段階値・寄せは1バイトも変えない)。追随させないと、
      // **プリセットを1つ書いた画面があるだけで rename が参照整合性で拒否される** ——
      // 「追随は rename の意味論そのものである」(§5d)が columns にだけ効いている状態は
      // 非対称であり、AI から見れば「なぜか rename できない画面」が生まれる。
      if (view.preset_column_align !== undefined) {
        view.preset_column_align = renamePresetMapKey(view.preset_column_align);
      }
      if (view.preset_column_width !== undefined) {
        view.preset_column_width = renamePresetMapKey(view.preset_column_width);
      }
      continue;
    }
    /*
     * **集計表(`V8-M8`。台帳 `Q-G1`)。** **束ねるキー・合計する列・絞り込みの3箇所を
     * 追随させる。**
     *
     * **追随させないと何が起きるか**: **`change_field` の rename が、その項目で束ねている
     * 集計表を1枚持っているだけで参照整合性に拒否される** —— **すぐ上の
     * `preset_column_align` のコメントが名指しした「なぜか rename できない画面」が
     * 4種目の画面にも生まれる。** **一覧の `columns` / `sort` / `filter` と同じ扱いに揃える。**
     *
     * **`filter` は一覧とまったく同じ `renameFilterField` を通す**(葉の `field` 参照だけを
     * 写し、演算子・結合の構造は保つ)—— **2本目の写し替えを書かない。**
     */
    if (view.type === "report_view") {
      view.report.group_by = view.report.group_by.map((key) =>
        key.field === fieldId ? { ...key, field: nextId } : key,
      );
      view.report.aggregates = view.report.aggregates.map((aggregate) =>
        aggregate.field === fieldId ? { ...aggregate, field: nextId } : aggregate,
      );
      if (view.report.filter !== undefined) {
        view.report.filter = renameFilterField(view.report.filter, fieldId, nextId);
      }
      continue;
    }
    if (view.fields !== undefined) {
      view.fields = view.fields.map((id) => (id === fieldId ? nextId : id));
    }
    /*
     * **【V4-M20-T01 / T02】操作起点が**この画面の対象テーブル**を指す2箇所を追随させる。**
     *
     * - `set.field`(値の書換の宛先。`ADR-0100`)
     * - `visible_when.field`(表示条件の葉。`ADR-0101`)
     *
     * **`prefill.field` は追随させない** —— **あれは遷移先 form の対象テーブルの列**であり、
     * この rename が指しているテーブルとは別である(**追随させると別テーブルの同名列を
     * 巻き添えにする**)。
     *
     * 追随させない場合に何が起きるかは、直上の `preset_column_align` のコメントと同じ
     * である —— **操作起点を1つ書いた画面があるだけで rename が参照整合性で拒否される。**
     * **「なぜか rename できない画面」を作らない。**
     */
    if (view.type === "detail_view" && view.actions !== undefined) {
      view.actions = view.actions.map((action) => {
        const renamedWhen =
          action.visible_when !== undefined && action.visible_when.field === fieldId
            ? { ...action.visible_when, field: nextId }
            : action.visible_when;
        if ("set" in action) {
          return {
            ...action,
            set: action.set.field === fieldId ? { ...action.set, field: nextId } : action.set,
            ...(renamedWhen === undefined ? {} : { visible_when: renamedWhen }),
          };
        }
        return {
          ...action,
          ...(renamedWhen === undefined ? {} : { visible_when: renamedWhen }),
        };
      });
    }
  }
  // --- §5d: ワークフローのフィールド参照を追随させる -----------------------
  // 参照は2種あり、**指しているテーブルが違う**ので判定も別である。
  //
  //   (a) `actions[].values` のキー —— **書き込み先テーブル**のフィールドIDである。
  //       対象は `action.table` がこのテーブルであるアクションだけ。別テーブルの
  //       アクションが同名のキーを持っていても、それは別のフィールドである
  //       (すぐ上のビューの判定と同じ理屈)。
  //   (b) `values` の値と `target` に書かれた `$record.<フィールドID>` ——
  //       **トリガー元テーブル**のフィールドIDである(ADR-0013 §7 / 限定12)。
  //       対象は `trigger` が `on_create` / `on_update` で、かつ `trigger.table` が
  //       このテーブルであるワークフローだけ。`schedule` にはトリガー元が無い。
  //
  // 参照整合性は `values` の中身を検査しない(ADR-0013 §8d)。**つまりここを
  // 追随させ損ねてもエラーは1つも出ず、ワークフローが黙って壊れる**(憲法6)。
  for (const workflow of manifest.app.workflows ?? []) {
    const triggersOnThisTable =
      workflow.trigger.type !== "schedule" && workflow.trigger.table === table.id;
    for (const action of workflow.actions) {
      // `run_function` はフィールドID を1つも参照しない(参照するのは function / output_table
      //  = テーブル・関数の resource_id であって、フィールドではない。ADR-0024)。
      //  出力の各フィールドは function.output.fields が定める関数自身の契約であり、
      //  output_table のフィールド rename に追随させる語彙はここに無い。よって field rename の
      //  追随対象から外す(values / payload / input / target / $record を1つも持たない)。
      if (action.action === "run_function") {
        continue;
      }
      // (a) 書き込み先テーブルのフィールドID(= values のキー)。**`call_external` /
      //     `ai_transform` は内部の書き込み先テーブルを持たない**(payload / input のキーは
      //     外部宛 / AI 宛の任意名であり、テーブルのフィールドIDではない)ので、キーの追随は
      //     create/update のみ。
      if (
        action.action !== "call_external" &&
        action.action !== "ai_transform" &&
        action.table === table.id
      ) {
        action.values = renameValueKey(action.values, fieldId, nextId);
      }
      if (!triggersOnThisTable) {
        continue;
      }
      if (action.action === "update_record") {
        action.target = renameRecordReference(action.target, fieldId, nextId);
      }
      // (c) `ai_transform` の書き戻し先 `output_field` は**トリガー元テーブルのフィールドID**
      //     である(ADR-0021 §3)。input の $record 参照(下の (b))とは別に追随させる。
      //     追随させないと書き戻し先が消え、黙って壊れる(憲法6)。
      if (action.action === "ai_transform") {
        if (action.output_field === fieldId) {
          action.output_field = nextId;
        }
        action.fallback = renameRecordReference(action.fallback, fieldId, nextId);
      }
      // (b) `$record.<フィールドID>`(= 値)はトリガー元テーブルのフィールドIDである。
      //     **`call_external` の payload / `ai_transform` の input も同じ語彙**なので、
      //     追随させないと黙って壊れる(この関数 doc の憲法6 の警告と同じ)。
      const refs =
        action.action === "call_external"
          ? action.payload
          : action.action === "ai_transform"
            ? action.input
            : action.values;
      for (const [key, value] of Object.entries(refs)) {
        refs[key] = renameRecordReference(value, fieldId, nextId);
      }
    }
  }
}

/** `values` のキーだけを差し替える(値と並び順はそのまま)。 */
function renameValueKey(
  values: Record<string, string>,
  fieldId: string,
  nextId: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key === fieldId ? nextId : key, value]),
  );
}

/**
 * `$record.<フィールドID>` を1つ書き換える。**完全一致で判定する。**
 *
 * 前方一致(`startsWith("$record." + fieldId)`)で判定すると `$record.title_kana` が
 * `title` の rename で `$record.book_title_kana` に壊れる。限定12 により値に書ける
 * 参照は `$record.<フィールドID>` の形**だけ**(演算子も連結も無い)なので、
 * 文字列全体が1つの参照であり、完全一致で過不足なく判定できる。
 *
 * `$` で始まらない文字列はリテラルなので、たまたま旧フィールドIDと同じ綴りでも
 * 一致しない。`$record._id` も `_id` がユーザ定義フィールドでない以上
 * `change_field` の対象になりえず、ここに来ない。
 */
function renameRecordReference(value: string, fieldId: string, nextId: string): string {
  return value === `$record.${fieldId}` ? `$record.${nextId}` : value;
}

/**
 * `changes` を反映した新しいフィールド定義を作る。
 *
 * 型が変わったときに `options` / `reference_table` の去就が問題になる。
 * **`select` / `reference` でなくなったなら、それらのキーは消す** —— マニフェスト
 * スキーマが「select 以外は options を持てない」と定めているので、残すと
 * 適用後マニフェストの構造検証で落ちる。
 */
function buildChangedField(from: Field, changes: FieldChanges): Field {
  const type = changes.type ?? from.type;
  const required = changes.required ?? from.required;
  // unique(EC-G8 / ADR-0038)を運ぶ。`required` と同型のフラグなので、指定があれば
  // それを、無ければ元の値を引き継ぐ。**落とすと後付け unique が適用後マニフェストに
  // 残らず、書込時検査(records.ts)が効かない**(黙って壊れる。憲法6)。
  const unique = changes.unique ?? from.unique;
  /*
   * **`E-G14` / `V4-M10-T46` / `ADR-0086` 限定8**: 単位(`unit`)を運ぶ。
   *
   * **`unique` と同型のスカラである** —— 指定があればそれを、無ければ元の値を引き継ぐ。
   * **ここで運ばないと「`field_changes` にキーは在るが `change_field` で書いても残らない」
   * 状態になる**(`ADR-0076` の `writable_by` が実際にそうなっている。あちらは限定7 が
   * `src/kernel/` への差分を1バイトも禁じていたためである)。**`ADR-0086` の限定表は
   * `src/kernel/` を1つも禁じていないので、同じ穴を踏まない。**
   *
   * **【2026-08-10 追記(`V8-M20`。台帳 `J-G28`。手続きは `ADR-0301`)。旧文を1バイトも
   * 消していない】** **前例として名指しした `writable_by` というキーは、今日はもう
   * 存在しない** —— **`V8-M20` が `manifest` 側(`$defs/field/properties/writable_by`)と
   * `diff` 側(`$defs/field_changes/properties/writable_by`)の両方を廃止した。**
   * **前例そのもの(「キーは在るが値が運ばれない」形が実在したこと)は歴史として今日も
   * 真であり、それを踏み直さないという結論も変わらない。** **代わりに担うのは
   * `app.roles[].rules` の「役割 × 対象(項目)× 書込」である。**
   * **この追記は、同じ前例を名指ししている下の段落(`hide_when_empty` / `emphasis` /
   * `reference_picker` / `reference_search_fields` / `applyViewChanges`)にも同じだけ効く。**
   *
   * **型が `number` でなくなったなら落とす** —— `options` / `reference_table` と同じ作法で
   * ある(マニフェストスキーマが「`number` 以外は `unit` を持てない」と定めているので、
   * 残すと適用後マニフェストの構造検証で落ちる)。**これは「書けるが効かない」ではない**
   * —— **その差分は `unit` を1文字も書いていない。** **明示的に `unit` を書きながら
   * `number` でない型にする差分は、上の `foldChangeField` が拒否する**(限定4)。
   * **判断の記録は `docs/plan/v4/records/v4-m10-t47.md` §5-3。**
   */
  const inheritedUnit = "unit" in from ? from.unit : undefined;
  const unit = type === "number" ? (changes.unit ?? inheritedUnit) : undefined;
  /*
   * **`E-G17` / `D-V4-84` の一部 / `V4-M19-T07` / `ADR-0119` 限定1・限定11**:
   * 値が無いときの行ごとの非表示(`hide_when_empty`)を運ぶ。
   *
   * **`unique` と同型のフラグである** —— 指定があればそれを、無ければ元の値を引き継ぐ。
   * **ここで運ばないと「`field_changes` にキーは在るが `change_field` で書いても残らない」
   * 状態になる**(`ADR-0076` の `writable_by` が実際にそうなっている。
   * **【`V8-M20`。台帳 `J-G28`】そのキーは今日はもう存在しない —— 前例は歴史として真で
   * あり、代わりに担うのは `app.roles[].rules` の「役割 × 対象(項目)× 書込」である**)。
   *
   * **`unit` / `emphasis` と違い、型で落とさない** —— **本キーは8型すべてに書ける**ので、
   * 型を変えたときに落とす理由が1つも無い。**落とすと「書いたのに黙って消える」になる。**
   * **前進で `false` に戻せる**(限定11。実測は `field-hide-when-empty.test.ts`)。
   */
  const hideWhenEmpty = changes.hide_when_empty ?? from.hide_when_empty;
  // **V4-M10-T07 / ADR-0078**: `unique` の値域が `boolean | "owner"` に広がった。
  const base: {
    id: string;
    name: string;
    required?: boolean;
    unique?: boolean | "owner";
    unit?: string;
    hide_when_empty?: boolean;
  } = {
    id: changes.id ?? from.id,
    name: changes.name ?? from.name,
  };
  if (required !== undefined) {
    base.required = required;
  }
  if (unique !== undefined) {
    base.unique = unique;
  }
  if (unit !== undefined) {
    base.unit = unit;
  }
  if (hideWhenEmpty !== undefined) {
    base.hide_when_empty = hideWhenEmpty;
  }
  if (type === "select") {
    const options = changes.options ?? (from.type === "select" ? from.options : undefined) ?? [];
    /*
     * **`P-G28` + `P-G22` / `V4-M16-T10` / `ADR-0090` 限定8 の裏**: 強調(`emphasis`)を運ぶ。
     *
     * **`unit` と同じ作法である** —— 指定があればそれを、無ければ元の値を引き継ぐ。
     * **ここで運ばないと「`field_changes` にキーは在るが `change_field` で書いても残らない」
     * 状態になる**(`ADR-0076` の `writable_by` が実際にそうなっている。
     * **【`V8-M20`。台帳 `J-G28`】そのキーは今日はもう存在しない —— 前例は歴史として真で
     * あり、代わりに担うのは `app.roles[].rules` の「役割 × 対象(項目)× 書込」である**)。
     *
     * **`select` でなくなったなら落とす** —— 下の `base` には積まないので、型が変われば
     * 自然に消える(`options` と同じ作法)。**これは「書けるが効かない」ではない** ——
     * **その差分は `emphasis` を1文字も書いていない。** **明示的に `emphasis` を書きながら
     * `select` でない型にする差分は、上の `foldChangeField` が拒否する**(限定4)。
     */
    const inheritedEmphasis = from.type === "select" ? from.emphasis : undefined;
    const emphasis = changes.emphasis ?? inheritedEmphasis;
    return emphasis === undefined
      ? { ...base, type, options }
      : { ...base, type, options, emphasis };
  }
  if (type === "reference") {
    const referenceTable =
      changes.reference_table ??
      (from.type === "reference" ? from.reference_table : undefined) ??
      "";
    /*
     * **`K-G1` / `K-G4` / `V6-M1-T02` / `ADR-0288` 限定10 の裏**: 選び方(`reference_picker`)
     * を運ぶ。
     *
     * **`emphasis` と同じ作法である** —— 指定があればそれを、無ければ元の値を引き継ぐ。
     * **ここで運ばないと「`field_changes` にキーは在るが `change_field` で書いても残らない」
     * 状態になる**(`ADR-0076` の `writable_by` が実際にそうなっている。
     * **【`V8-M20`。台帳 `J-G28`】そのキーは今日はもう存在しない —— 前例は歴史として真で
     * あり、代わりに担うのは `app.roles[].rules` の「役割 × 対象(項目)× 書込」である**)。
     * **`ADR-0288` の限定表は `src/kernel/` への差分を1つも禁じていない**ので、
     * **同じ穴を3件目として作らない。**
     *
     * **`reference` でなくなったなら落とす** —— この分岐に来ないので、型が変われば自然に
     * 消える(`options` / `emphasis` と同じ作法)。**これは「書けるが効かない」ではない**
     * —— **その差分は `reference_picker` を1文字も書いていない。** **明示的に
     * `reference_picker` を書きながら `reference` でない型にする差分は、上の
     * `foldChangeField` が拒否する**(限定4)。
     */
    const inheritedPicker = from.type === "reference" ? from.reference_picker : undefined;
    const referencePicker = changes.reference_picker ?? inheritedPicker;
    /*
     * **`K-G7` / `V6-M3-T02` / `ADR-0290` 限定11 の裏**: 探せる項目
     * (`reference_search_fields`)を運ぶ。
     *
     * **`reference_picker` とまったく同じ作法である** —— 指定があればそれを、無ければ
     * 元の値を引き継ぐ。**ここで運ばないと「`field_changes` にキーは在るが
     * `change_field` で書いても残らない」状態になる**(`ADR-0076` の `writable_by` /
     * `ADR-0080` の `representative_field` が実際にそうなっている。
     * **【`V8-M20`。台帳 `J-G28`】前者のキーは今日はもう存在しない** —— **前例は歴史と
     * して真であり、今日も残っている前例は `representative_field` の1本である**)。
     * **`ADR-0290` の限定表は `src/kernel/` への差分を1つも禁じていない**ので、
     * **同じ穴を4件目として作らない。**
     *
     * **`reference` でなくなったなら落とす** —— この分岐に来ないので、型が変われば自然に
     * 消える(`options` / `emphasis` / `reference_picker` と同じ作法)。
     * **これは「書けるが効かない」ではない** —— **その差分は
     * `reference_search_fields` を1文字も書いていない。** **明示的に書きながら
     * `reference` でない型にする差分は、上の `foldChangeField` が拒否する。**
     *
     * **全置換である** —— 書いた配列がそのまま新しい値になる。**1本ずつ足す / 消す
     * 手段を1つも作っていない。**
     */
    const inheritedSearchFields =
      from.type === "reference" ? from.reference_search_fields : undefined;
    const referenceSearchFields = changes.reference_search_fields ?? inheritedSearchFields;
    const next: Extract<Field, { type: "reference" }> = {
      ...base,
      type,
      reference_table: referenceTable,
    };
    if (referencePicker !== undefined) {
      next.reference_picker = referencePicker;
    }
    if (referenceSearchFields !== undefined) {
      next.reference_search_fields = referenceSearchFields;
    }
    return next;
  }
  return { ...base, type };
}

/**
 * ビューに `changes` を反映した新しいビューを返す(元のオブジェクトは変えない)。
 * 指定されたキーだけを差し替える。未指定のキーは現状のまま残す。
 */
function applyViewChanges(view: View, changes: ViewChanges): View {
  // 表示名は種別に依存しないので、種別ごとの分岐に入る前に一度だけ適用する(V1-M0-T02)。
  // 指定が無いビューに `name` キーが生えることはない(限定3 —— 必須にしない)。
  const renamed = changes.name === undefined ? view : { ...view, name: changes.name };
  // **`E-G12` / `V4-M10-T45` / `ADR-0084` 限定6**: 掲載の可否も種別に依存しないので、`name`
  // と同じ場所で一度だけ適用する。**ここで値を運ばないと「`view_changes` にキーは在るが
  // `update_view` で書いても残らない」状態になる** —— `ADR-0076`(`writable_by`)と
  // `ADR-0080`(`representative_field`)が実際にそうなっている(限定表が `src/kernel/` への
  // 差分を禁じていたため)。**【`V8-M20`。台帳 `J-G28`】`writable_by` というキーは今日は
  // もう存在しない** —— **前例は歴史として真であり、今日も残っている前例は
  // `representative_field` の1本である。****`ADR-0084` の限定表は `src/kernel/` を1バイトも禁じていない**
  // ので、同じ穴を踏まない(記録は `docs/plan/v4/records/v4-m10-t47.md` §5-1)。
  const named =
    changes.menu_listed === undefined ? renamed : { ...renamed, menu_listed: changes.menu_listed };
  if (named.type === "list_view") {
    const next: ListView = { ...named };
    if (changes.columns !== undefined) {
      next.columns = changes.columns;
    }
    if (changes.sort !== undefined) {
      next.sort = changes.sort;
    }
    if (changes.filter !== undefined) {
      next.filter = changes.filter;
    }
    // D-G4 / F-5レイアウト(ADR-0050)。**軸ごとに独立して差し替わる** ——
    // 指定の無い軸には一切触れないので、「1軸だけ書いたら他軸が黙って既定へ戻る」
    // ことが起きない(1キー案を採らなかった理由そのもの。ADR-0050 §2 (c))。
    if (changes.preset_column_align !== undefined) {
      next.preset_column_align = changes.preset_column_align;
    }
    if (changes.preset_column_width !== undefined) {
      next.preset_column_width = changes.preset_column_width;
    }
    if (changes.preset_pager_position !== undefined) {
      next.preset_pager_position = changes.preset_pager_position;
    }
    if (changes.preset_image_size !== undefined) {
      next.preset_image_size = changes.preset_image_size;
    }
    if (changes.preset_text_preview !== undefined) {
      next.preset_text_preview = changes.preset_text_preview;
    }
    // **【V4-M16-T13 / `P-G24` の (C) 側 / `ADR-0093` 限定2】一覧の器の形を、ここで実際に運ぶ。**
    // **`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは値が運ばれない** —— この分岐に書かないと
    // 「`update_view` は通るが適用後のマニフェストに残らない」状態になる(上のコメントが
    // 名指しした `ADR-0076` / `ADR-0080` の穴と同型である)。**軸ごとに独立して差し替わる。**
    // **`card` と列の軸(寄せ・幅)の組み合わせをここで止めていない**(限定8)——
    // **止めるには型とプリセットの対応検査が要り、それは今日この製品に1つも無い。**
    if (changes.preset_list_shape !== undefined) {
      next.preset_list_shape = changes.preset_list_shape;
    }
    // **【V4-M22-T01 / `E-G7` の (C) 側 / `ADR-0112` 限定2】検索の対象にする列を、ここで実際に運ぶ。**
    // **`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは値が運ばれない** —— この分岐に書かないと
    // 「`update_view` は通るが適用後のマニフェストに残らない」状態になる(上のコメントが
    // 名指しした `ADR-0076` / `ADR-0080` の穴と同型である)。
    // **実在照合・型(`text` / `long_text`)・役割の規則が名指ししていないこと の3つを
    // ここで止めていない**(限定5 / 限定6。**【`V8-M20-T02`。台帳 `J-G28`】3つ目の着手前の
    // 逐語は `audience` だった。そのキーは廃止されたので、同じ問いを面について問い直した**)
    // —— **止めるのは畳み込み後のマニフェスト検証(`validateReferentialIntegrity`)であり、
    // `add_view` と同じ1箇所が持つ。****判定を2箇所に住まわせない。****拒否は「全か無か」である。**
    if (changes.search_fields !== undefined) {
      next.search_fields = changes.search_fields;
    }
    // **【V4-M22-T05 / `E-G8` / `E-G11` の (C) 側 / `ADR-0113` 限定2】1ページの件数を、ここで実際に運ぶ。**
    // **`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは値が運ばれない** —— この分岐に書かないと
    // 「`update_view` は通るが適用後のマニフェストに残らない」状態になる。
    // **値域(4値の enum)は `schemas/` が閉じており、ここでは1つも判定しない** ——
    // **判定を2箇所に住まわせない。**
    if (changes.page_size !== undefined) {
      next.page_size = changes.page_size;
    }
    // **【V4-M23-T01 / `D-V4-89` / `E-G31` / `ADR-0104` 限定2〜限定4】合計を出す列を、ここで実際に運ぶ。**
    // **`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは値が運ばれない** —— この分岐に書かないと
    // 「`update_view` は通るが適用後のマニフェストに残らない」状態になる。
    // **実在照合・型(`number`)・役割の規則が名指ししていないこと の3つをここで止めて
    // いない**(**【`V8-M20-T02`。台帳 `J-G28`】3つ目の着手前の逐語は `audience` だった。
    // そのキーは廃止されたので、同じ問いを面について問い直した**)—— **止めるのは
    // 畳み込み後のマニフェスト検証(`validateReferentialIntegrity`)であり、`add_view` と
    // 同じ1箇所が持つ。****判定を2箇所に住まわせない。****拒否は「全か無か」である。**
    if (changes.sum_field !== undefined) {
      next.sum_field = changes.sum_field;
    }
    // **【V4-M19-T03 / `P-G32` の (C) 側 / `ADR-0118` 限定1】画面の詰まり具合を、ここで実際に運ぶ。**
    // **`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは値が運ばれない** —— この分岐に書かないと
    // 「`update_view` は通るが適用後のマニフェストに残らない」状態になる(上のコメントが
    // 名指しした `ADR-0076` / `ADR-0080` の穴と同型である)。**軸ごとに独立して差し替わる。**
    // **値域(2値の enum)は `schemas/` が閉じており、ここでは1つも判定しない** ——
    // **判定を2箇所に住まわせない。**
    if (changes.preset_density !== undefined) {
      next.preset_density = changes.preset_density;
    }
    // D-G5 逃げ道の参照(ADR-0055 改訂1)。**キー単位の差し替えである** ——
    // 書かなかったときに黙って消えることはない(消す手段は語彙に無く、外すのは
    // undo か `remove_view` + `add_view` である)。
    if (changes.custom_css !== undefined) {
      next.custom_css = changes.custom_css;
    }
    /*
     * **【`L-G4` / `V5-M21-T03` / `ADR-0172` 限定2・限定3】操作起点を、ここで実際に運ぶ。**
     * **`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは値が運ばれない** —— この分岐に書かないと
     * 「`update_view` は通るが適用後のマニフェストに残らない」状態になる(上のコメントが
     * 名指しした `ADR-0076` / `ADR-0080` の穴と同型である)。
     * **全置換である**(限定2)—— 書いた配列がそのまま新しい `actions` になる。
     * **空配列は「全部消す」である**(限定3)—— **キーごと消す** ので、
     * 適用後のビューに `actions` キーは1本も残らない(`"actions": []` を置き去りにしない)。
     * **これは他の22キーに無い性質である** —— 他は前進で外せない。
     */
    if (changes.actions !== undefined) {
      if (changes.actions.length === 0) {
        delete next.actions;
      } else {
        next.actions = changes.actions as NonNullable<ListView["actions"]>;
      }
    }
    /*
     * **【`V10-M4-T01` / `NV-G9` / `ADR-0359` §4b 限定1・限定3】一続きの流れの中の段を、
     * ここで実際に運ぶ。**
     * **`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは値が運ばれない** —— この分岐に書かないと
     * 「`update_view` は通るが適用後マニフェストに残らない」状態になる。
     * **3種別(`list_view` / `form` / `detail_view`)とも1バイトも同じ形である** ——
     * **種別で挙動を割らない。**
     * **確認の段を置ける種別も、位置の重複・欠番も、ここでは判定しない** ——
     * **前者はスキーマの `allOf` が、後者は畳み込み後のマニフェスト検証が持つ。**
     * **判定を2箇所に住まわせない。****拒否は「全か無か」である。**
     */
    if (changes.flow !== undefined) {
      next.flow = changes.flow;
    }
    return next;
  }
  if (named.type === "form") {
    const next: FormView = { ...named };
    if (changes.fields !== undefined) {
      next.fields = changes.fields;
    }
    // **【V4-M16-T11 / ADR-0091 限定3】form に通した2軸を、ここで実際に運ぶ。**
    // **`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは値が運ばれない** —— この分岐に書かないと
    // 「`update_view` は通るが適用後のマニフェストに残らない」状態になる(上のコメントが
    // 名指しした `ADR-0076` / `ADR-0080` の穴と同型である)。**軸ごとに独立して差し替わる。**
    if (changes.preset_label_placement !== undefined) {
      next.preset_label_placement = changes.preset_label_placement;
    }
    if (changes.preset_field_columns !== undefined) {
      next.preset_field_columns = changes.preset_field_columns;
    }
    // **【V4-M18-T03 / `P-G14` の (C) 側 / `ADR-0095` 限定6】重ねて出す宣言を、ここで実際に運ぶ。**
    // **`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは値が運ばれない** —— この分岐に書かないと
    // 「`update_view` は通るが適用後のマニフェストに残らない」状態になる(上のコメントが
    // 名指しした `ADR-0076` / `ADR-0080` の穴と同型である)。
    // **`menu_listed` との組み合わせをここで止めていない**(限定5)—— **止めるのは
    // 畳み込み後のマニフェスト検証(`validateManifestFull`)であり、`schemas/` の
    // `allOf` の4分岐目が持つ。****判定を2箇所に住まわせない。****拒否は「全か無か」である。**
    if (changes.modal !== undefined) {
      next.modal = changes.modal;
    }
    // **【V4-M19-T03 / `P-G32` の (C) 側 / `ADR-0118` 限定1】画面の詰まり具合を、ここで実際に運ぶ。**
    // **`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは値が運ばれない** —— この分岐に書かないと
    // 「`update_view` は通るが適用後のマニフェストに残らない」状態になる(上のコメントが
    // 名指しした `ADR-0076` / `ADR-0080` の穴と同型である)。**軸ごとに独立して差し替わる。**
    // **値域(2値の enum)は `schemas/` が閉じており、ここでは1つも判定しない** ——
    // **判定を2箇所に住まわせない。**
    if (changes.preset_density !== undefined) {
      next.preset_density = changes.preset_density;
    }
    // **【V4-M20-T04 / `E-G34` / `ADR-0102` 限定1・限定8】保存後の行き先を、ここで実際に運ぶ。**
    // **`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは値が運ばれない** —— この分岐に書かないと
    // 「`update_view` は通るが適用後のマニフェストに残らない」状態になる(上のコメントが
    // 名指しした `ADR-0076` / `ADR-0080` の穴と同型である)。
    // **遷移先の実在をここで判定しない** —— **判定は畳み込み後のマニフェスト検証
    // (`validateManifestFull` → `referential-integrity.ts`)の1箇所が持つ。**
    // **判定を2箇所に住まわせない。****拒否は「全か無か」である。**
    if (changes.after_save !== undefined) {
      next.after_save = changes.after_save;
    }
    // **form が差し替えられる唯一の見た目のキーである**(プリセットは1軸も書けない)。
    // **【ADR-0091 限定3 で偽になった】** 直前の1文は 2026-07-26 の判定としては正しいが、
    // 今日は成り立たない —— **上の2軸も form で差し替えられる。旧文は消していない。**
    if (changes.custom_css !== undefined) {
      next.custom_css = changes.custom_css;
    }
    /*
     * **【`V6-M2-T02` / `K-G3` / `ADR-0289` 限定1・限定4】参照項目の選び方の
     * 画面ごとの上書きを、ここで実際に運ぶ。**
     * **`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは値が運ばれない** —— この分岐に書かないと
     * 「`update_view` は通るが適用後のマニフェストに残らない」状態になる(上のコメントが
     * 名指しした `ADR-0076` / `ADR-0080` の穴と同型である)。
     * **全置換である** —— 書いたオブジェクトがそのまま新しい値になり、
     * **項目ごとに1本だけ足す / 消す手段は語彙に1つも無い。**
     * **`actions` と違い、空オブジェクトに「全部消す」の意味を与えていない** ——
     * **前進では外せない**(限定8)。
     * **値域(有限3値)も、書いたフィールドIDが実在するかも、ここでは1つも判定しない** ——
     * **値域は `schemas/` が閉じており、実在照合は今日1つも置いていない**
     * (`ADR-0289` §この ADR の限界 2。**`representative_field` と同じ穴が本キーにも在ることを
     * 隠さない**)。**判定を2箇所に住まわせない。**
     */
    if (changes.reference_pickers !== undefined) {
      next.reference_pickers = changes.reference_pickers;
    }
    /*
     * **【`V10-M4-T01` / `NV-G9` / `ADR-0359` §4b 限定1・限定3】一続きの流れの中の段を、
     * ここで実際に運ぶ。**
     * **`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは値が運ばれない** —— この分岐に書かないと
     * 「`update_view` は通るが適用後マニフェストに残らない」状態になる。
     * **3種別(`list_view` / `form` / `detail_view`)とも1バイトも同じ形である** ——
     * **種別で挙動を割らない。**
     * **確認の段を置ける種別も、位置の重複・欠番も、ここでは判定しない** ——
     * **前者はスキーマの `allOf` が、後者は畳み込み後のマニフェスト検証が持つ。**
     * **判定を2箇所に住まわせない。****拒否は「全か無か」である。**
     */
    if (changes.flow !== undefined) {
      next.flow = changes.flow;
    }
    return next;
  }
  if (named.type === "report_view") {
    const next: ReportView = { ...named };
    /*
     * **【`V8-M8` / `Q-G1`】集計表の中身を、ここで実際に運ぶ。**
     * **`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは値が運ばれない** —— この分岐に書かないと
     * 「`update_view` は通るが適用後のマニフェストに残らない」状態になる(上のコメントが
     * 名指しした `ADR-0076` / `ADR-0080` の穴と同型である)。
     * **全置換である** —— 書いたオブジェクトがそのまま新しい宣言になる。
     * **空オブジェクトに「全部消す」の意味を与えていない** —— `$defs/report` の
     * `required`(`group_by` / `aggregates`)が形の側で拒否する。**`actions` の `[]` に
     * 当たる性質は本キーに無い**(前進では外せない)。
     * **実在照合・型・`granularity` の要否・役割の規則が名指ししていないこと を
     * ここで1つも判定しない** —— **判定は畳み込み後のマニフェスト検証
     * (`validateReferentialIntegrity`)の1箇所が持つ。****判定を2箇所に住まわせない。**
     */
    if (changes.report !== undefined) {
      next.report = changes.report;
    }
    if (changes.custom_css !== undefined) {
      next.custom_css = changes.custom_css;
    }
    return next;
  }
  // detail_view: 変更できるのは name(V1-M0-T02)と fields(V1-M0-T09 の追補)、
  // そしてプリセット4軸(V3-M2-T01 / ADR-0050)。
  // 元が fields を持たない(= 全項目表示)ビューにも後から足せる。
  const next: DetailView = { ...named };
  if (changes.fields !== undefined) {
    next.fields = changes.fields;
  }
  if (changes.preset_label_placement !== undefined) {
    next.preset_label_placement = changes.preset_label_placement;
  }
  if (changes.preset_field_columns !== undefined) {
    next.preset_field_columns = changes.preset_field_columns;
  }
  if (changes.preset_image_size !== undefined) {
    next.preset_image_size = changes.preset_image_size;
  }
  if (changes.preset_text_preview !== undefined) {
    next.preset_text_preview = changes.preset_text_preview;
  }
  if (changes.custom_css !== undefined) {
    next.custom_css = changes.custom_css;
  }
  // **【V4-M16-T12 / `P-G17` の (C) 側 / `ADR-0092` 限定2】項目のまとまりを、ここで実際に運ぶ。**
  // **`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは値が運ばれない** —— この分岐に書かないと
  // 「`update_view` は通るが適用後のマニフェストに残らない」状態になる(上のコメントが
  // 名指しした `ADR-0076` / `ADR-0080` の穴と同型である)。**キー単位の差し替えであり、
  // 書かなかったときに黙って消えることはない**(外すのは undo か `remove_view` + `add_view`)。
  // **整合(同じIDが2つのまとまりに現れない / `fields` に無いIDを書かない)はここで見ない** ——
  // **適用後マニフェストを見る `validateReferentialIntegrity` が持つ**(`add_view` の経路も
  // 同じ1箇所で覆うため。限定5)。
  if (changes.field_groups !== undefined) {
    next.field_groups = changes.field_groups;
  }
  // **【V4-M19-T03 / `P-G32` の (C) 側 / `ADR-0118` 限定1】画面の詰まり具合を、ここで実際に運ぶ。**
  // **`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは値が運ばれない** —— この分岐に書かないと
  // 「`update_view` は通るが適用後のマニフェストに残らない」状態になる(上のコメントが
  // 名指しした `ADR-0076` / `ADR-0080` の穴と同型である)。**軸ごとに独立して差し替わる。**
  // **値域(2値の enum)は `schemas/` が閉じており、ここでは1つも判定しない** ——
  // **判定を2箇所に住まわせない。**
  if (changes.preset_density !== undefined) {
    next.preset_density = changes.preset_density;
  }
  /*
   * **【`L-G4` / `V5-M21-T03` / `ADR-0172` 限定2・限定3】操作起点を、ここで実際に運ぶ。**
   * **`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは値が運ばれない** —— この分岐に書かないと
   * 「`update_view` は通るが適用後のマニフェストに残らない」状態になる。
   * **全置換である**(限定2)。**空配列は「全部消す」である**(限定3。**キーごと消す**)。
   * **`list_view` 分岐と同じ規則である** —— 種別で挙動を割らない。
   * **`related` はここに無い**(`ADR-0172` 限定1。今日も `view_changes` に無い)。
   */
  if (changes.actions !== undefined) {
    if (changes.actions.length === 0) {
      delete next.actions;
    } else {
      /*
       * **【`V5-M22-T01` / `L-G5` / `ADR-0173`】キャストが1本要るようになった。**
       * `ViewChanges["actions"]` は `ListView` / `DetailView` の**和**であり、3形目
       * (行き先の宣言)は `ListView` にしか無い(`L-G7` = 却下)。**この分岐は
       * `detail_view` 側なので、和のうち3形目は型として来てはならない。**
       * **来ないことを保証するのは schema である** —— `$defs/view.allOf` の
       * `detail_view` 分岐が `actions.items.properties.view: false` で閉じており、
       * **畳み込んだ後の `validateManifestFull` が差分全体を拒否する。**
       * **判定を2箇所に住まわせない**ので、ここでは実行時に判定を1つも足さない。
       * **`list_view` 分岐(上)が同じ理由で同じ形のキャストを既に持っている。**
       */
      next.actions = changes.actions as NonNullable<DetailView["actions"]>;
    }
  }
  /*
   * **【`V10-M1-T01` / `NV-G3a` / `ADR-0358` 限定1・限定2・限定8】この画面の書換ボタンが
   * 成立したあとの行き先を、ここで実際に運ぶ。**
   * **`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは値が運ばれない** —— この分岐に書かないと
   * 「`update_view` は通るが適用後のマニフェストに残らない」状態になる(上のコメントが
   * 名指しした `ADR-0076` / `ADR-0080` の穴と同型である)。
   * **`form` 分岐(上)と1バイトも同じ形である** —— 種別で挙動を割らない。
   * **遷移先の実在をここで判定しない** —— **判定は畳み込み後のマニフェスト検証
   * (`validateManifestFull` → `referential-integrity.ts`)の1箇所が持つ。**
   * **判定を2箇所に住まわせない。****拒否は「全か無か」である。**
   * **【意味のずれを隠さない(限定6)】詳細画面に「保存」は無い** —— **発火するのは
   * `actions` の `set` 形の書込が成立したときだけであり、`run` 形の後は移らない。**
   */
  if (changes.after_save !== undefined) {
    next.after_save = changes.after_save;
  }
  /*
   * **【`V10-M1-T02` / `NV-G4` / `ADR-0359` §4a 限定2・限定4・限定10】削除が成立した
   * あとの行き先を、ここで実際に運ぶ。**
   * **`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは値が運ばれない** —— この分岐に書かないと
   * 「`update_view` は通るが適用後マニフェストに残らない」状態になる(上のコメントが
   * 名指しした `ADR-0076` / `ADR-0080` の穴と同型である)。
   * **すぐ上の `after_save` と1バイトも同じ形である** —— 種別で挙動を割らない。
   * **行き先の実在も種別(`list_view` / `report_view` だけ)もここで判定しない** ——
   * **判定は畳み込み後のマニフェスト検証(`validateManifestFull` →
   * `referential-integrity.ts`)の1箇所が持つ。****判定を2箇所に住まわせない。**
   * **拒否は「全か無か」である。**
   * **`flow` はここに1バイトも無い**(`V10-M4` の担当。`ADR-0359` §4b)。
   */
  if (changes.after_delete !== undefined) {
    next.after_delete = changes.after_delete;
  }
  /*
   * **【`V10-M4-T01` / `NV-G9` / `ADR-0359` §4b 限定1・限定3 / `ADR-0360` 限定2】
   * 一続きの流れの中の段を、ここで実際に運ぶ。**
   * **`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは値が運ばれない** —— この分岐に書かないと
   * 「`update_view` は通るが適用後マニフェストに残らない」状態になる(上のコメントが
   * 名指しした `ADR-0076` / `ADR-0080` の穴と同型である)。
   * **すぐ上の `after_save` / `after_delete` と1バイトも同じ形である** ——
   * **種別で挙動を割らない**(`list_view` / `form` / `detail_view` の3種別で書けるが、
   * どれを対象にしても同じ1行が運ぶ。**種別の絞りは受付表の側が持つ**)。
   * **確認の段を置ける種別も、位置の重複・欠番も、ここでは判定しない** ——
   * **前者はスキーマの `allOf` が、後者は畳み込み後のマニフェスト検証
   * (`validateManifestFull` → `referential-integrity.ts`)の1箇所が持つ。**
   * **判定を2箇所に住まわせない。**
   * **拒否は「全か無か」である。**
   */
  if (changes.flow !== undefined) {
    next.flow = changes.flow;
  }
  return next;
}

/**
 * 差分パッチをアプリに適用する。
 *
 * @param dataRoot データルート(`data/` 相当)。環境変数に依存させず必ず引数で受ける。
 * @param appId 対象アプリのID。
 * @param diff 差分パッチ。未検証の入力(`unknown`)を受け付ける。
 * @throws 現行 manifest.json が読めない/壊れている場合、および DDL・I/O・changelog 追記の
 *         失敗。いずれの場合も適用前の状態へ巻き戻したうえで投げ直す。
 */
/** 条件を形だけで畳んだ結果。データを1行も読まないので「わからない」が在る。 */
type ConditionTruth = "true" | "false" | "unknown";

/**
 * 条件を、書き方の違いを消した1本の文字列にする(構造の同値判定に使う)。
 *
 * **意味の同値ではない。** `{or:[A,B]}` と `{or:[B,A]}` は別物として扱う ——
 * **並べ替えまで同一視すると、何を見ているのかが説明できなくなる。**
 */
function canonicalCondition(node: RoleCondition): string {
  if ("and" in node) return `and(${node.and.map(canonicalCondition).join(",")})`;
  if ("or" in node) return `or(${node.or.map(canonicalCondition).join(",")})`;
  if ("not" in node) return `not(${canonicalCondition(node.not)})`;
  if ("equals_current_user" in node) return `me(${node.field})`;
  // **【`V8-M26` / `D-V8-70`】葉の3種目。** **この分岐を足さないと `is_empty` の葉が
  // 下の行に落ち、`eq(<項目>,undefined)` という綴りになる** —— **`equals` を書いていない
  // 葉どうしが同じ綴りに畳まれ、「構造が完全に一致する組」の判定が狂う。**
  if ("is_empty" in node) return `empty(${node.field})`;
  return `eq(${node.field},${JSON.stringify(node.equals)})`;
}

/** 直下の兄弟に「X」と「X でない」が両方いるか(`and` なら矛盾、`or` なら恒真)。 */
function hasComplementarySiblings(children: readonly RoleCondition[]): boolean {
  const seen = new Set(children.map(canonicalCondition));
  return children.some((child) => "not" in child && seen.has(canonicalCondition(child.not)));
}

/** 直下の兄弟に、同じ項目へ異なる定数を求める葉が2つ以上あるか。 */
function hasConflictingConstants(children: readonly RoleCondition[]): boolean {
  const wanted = new Map<string, unknown>();
  for (const child of children) {
    if (!("equals" in child)) continue;
    if (wanted.has(child.field) && wanted.get(child.field) !== child.equals) return true;
    wanted.set(child.field, child.equals);
  }
  return false;
}

/**
 * 条件を形だけで畳む(**データを1行も読まない**)。
 *
 * **`anonymous` のときだけ「自分」の葉を偽に畳める** —— **未ログインでは「自分」は偽に
 * 評価される**(台帳 `J-G13` の限定)。**それ以外の役割では「わからない」である。**
 */
function foldCondition(node: RoleCondition, anonymous: boolean): ConditionTruth {
  if ("and" in node) {
    const children = node.and.map((child) => foldCondition(child, anonymous));
    if (children.includes("false")) return "false";
    if (hasComplementarySiblings(node.and) || hasConflictingConstants(node.and)) return "false";
    return children.every((truth) => truth === "true") ? "true" : "unknown";
  }
  if ("or" in node) {
    const children = node.or.map((child) => foldCondition(child, anonymous));
    if (children.includes("true")) return "true";
    if (hasComplementarySiblings(node.or)) return "true";
    return children.every((truth) => truth === "false") ? "false" : "unknown";
  }
  if ("not" in node) {
    const inner = foldCondition(node.not, anonymous);
    return inner === "true" ? "false" : inner === "false" ? "true" : "unknown";
  }
  if ("equals_current_user" in node) return anonymous ? "false" : "unknown";
  // **【`V8-M26` / `D-V8-70`】葉の3種目(`is_empty`)は、`anonymous` でも「わからない」で
  // ある** —— **「自分」の葉と違い、要求している人を1バイトも見ないので、未ログインだから
  // といって偽に畳めない。** **答えは行の中身で決まり、カーネルは行を1件も読まない。**
  return "unknown";
}

/**
 * **知らせの文面に出す動詞の日本語**(`V17-M5-T04`)。
 *
 * **{@link RoleRuleVerb} の3語ちょうどに対応する** —— **4語目を足していない。**
 */
const RULE_VERB_LABELS: Readonly<Record<RoleRuleVerb, string>> = {
  read: "読取",
  write: "書込",
  delete: "削除",
};

/**
 * **行ごとのアクセス権を配っている表を、条件なしで扱う役割の規則を知らせる**
 * (`V17-M5-T04`。台帳 `AC-G17`(`:1843`)/ `AC-G18`(`:1844`)。ユーザ決定 `D-V16-6`
 * の逐語「**今の動きは変えず、設定した人に警告を出す**」。`ADR-0422`)。
 *
 * **拒否しない。適用は通る。知らせるだけである** —— **ふるまいを1ミリも変えていない。**
 * **面(役割の規則)と点(行ごとの付与)の合成の式(`src/server/owner-scope.ts` の
 * `combineRoleAndGrantAccess`)は1バイトも動いていない**(`ADR-0422` 限定1)。
 *
 * ## 出す条件(**状態で見る。差分の中身を1バイトも見ない**)
 *
 * 1. **その規則が表(`target: "table"`)を名指ししている。**
 * 2. **その表が `access_control` を `enabled: true` で宣言している。**
 * 3. **その規則が `when` を1つも持たない。**
 *
 * ## **【役割 `owner` は対象から外してある。ユーザ決定 `D3`(2026-09-08)】**
 *
 * **`owner` はアプリの運営者であり、全表を条件なしで扱えることは意図された設定である。**
 * **したがって `role.id === "owner"` の規則には、上の3つを満たしても知らせを出さない。**
 *
 * **【正直に書く。これは穴である】** **着手前の実測(計画 `06-v17-m5-plan.md` §2-1d)で、
 * ディスク上のアプリでこの形に当たる規則は3本あり、3本とも `owner` のものだった** ——
 * **したがって、その3本は着手後も1件も知らされない。** **【禁止】これを「塞いだ」と書かない。**
 *
 * ## この関数が見ていないもの(**名指しで書く**)
 *
 * - **条件を**書いてある**規則と付与の層との重なりは1件も見ない** —— **見るのは
 *   「条件を1つも書いていない」形だけである。**
 * - **項目(`target: "field"`)の規則は見ない** —— **点の単位は行であり、
 *   台帳の逐語も「表」を主語にしている。**
 * - **規則2本以上にまたがる重なりは今日も見ない**(`collectRoleConditionNotices` の
 *   「検出できない形」の 5 は今日も真である)。
 */
function collectGrantsBypassedNotice(
  notices: RoleConditionNotice[],
  grantDeclaredTables: ReadonlySet<ResourceId>,
  roleId: ResourceId,
  roleIndex: number,
  rule: RoleRule,
  ruleIndex: number,
): void {
  // **ユーザ決定 `D3`** —— **運営者の規則には知らせを出さない。**
  if (roleId === "owner") return;
  if (rule.target !== "table" || rule.table === undefined) return;
  if (!grantDeclaredTables.has(rule.table)) return;
  const verbs = rule.can.map((verb) => RULE_VERB_LABELS[verb]).join("・");
  notices.push({
    kind: "grants_bypassed",
    role: roleId,
    // **`/when` を付けない** —— **`when` が無い規則なので、指し先が存在しないからである。**
    // **既存2種(`never_matches` / `always_matches`)の `path` とは形が違う**
    // (`src/kernel/types.ts` の `path` の doc に訂正で書いてある)。
    path: `/app/roles/${roleIndex}/rules/${ruleIndex}`,
    // **【2026-09-17。`V18-M9-T11` / `ADR-0446` 授権の表 行1 / ユーザ決定 `D-V18-35`。**
    // **`message` の末尾の1文だけを書き換えた。旧の文面を逐語で残す —— 1バイトも消していない】**
    // **旧: `この規則がある間、その表に配った行ごとの権限は、この役割については意味を持ちません。`**
    // **何が偽か** —— **読取は今日も効いている。** **`ADR-0438` §誇張しない 1 が同じサーバ・
    // 同じ状態で撃って確かめている**(推論ではない): **知らせは出る(`grants_bypassed` |
    // `viewer`)のに、同じ状態での実際の読取は `user3 | projects | total= 1` であり、
    // **配りが効いている**。**
    // **「意味を持ちません」と言い切ると、利用者は「配った行が読めなくなる」と誤解する。**
    // **【動作は1ミリも変えていない】** —— **判定の側(早期 return と `verbs` の組み立て)も、
    // `kind` / `role` / `path` も、`hint` も、呼び出し(`:2969` 付近)も1文字も変えていない。**
    // **この知らせが出る条件も、出た後に起きることも、今日と1ビットも変わらない。**
    message:
      `役割 "${roleId}" の規則は、行ごとにアクセス権を配っている表 "${rule.table}" を` +
      `条件なしで ${verbs} できるようにしています。` +
      `この規則がある間、その表に配った行ごとの権限は、この役割については当てになりません` +
      `(ただし読み取りは今日も、配ったとおりに絞られます)。`,
    hint:
      "行ごとの権限で絞りたいなら、この規則に条件を付けるか、この規則ごと消してください" +
      "(適用は通っています —— 拒否ではなく、お知らせです)。",
  });
}

/**
 * **カーネルが条件を補ったことを、書いた人に返る形で伝える**(`V17-M5-T05`。台帳
 * `AC-G33`(`:1862`)。踏む条文 `ADR-0318` 限定12。引き受けは `ADR-0331`。`ADR-0423`)。
 *
 * **拒否ではない。適用は通る。知らせるだけである**(既存3種と同じ性質)。
 *
 * ## なぜ「状態で見る」側を採れないのか(**既存3種と違う唯一の点**)
 *
 * **既存3種(`never_matches` / `always_matches` / `grants_bypassed`)は、適用後の
 * マニフェストだけを見て判定できる。** **4種目はできない** —— **補った後の `when` は、
 * 作者が同じ条件を自分で書いた場合と1バイトも違わないからである。**
 * **したがってこの1種だけは、{@link supplyOwnerScopeConditions} が書いた瞬間の記録を運ぶ。**
 * **その代わり、知らせは補った差分の応答に1回しか出ない**(次の差分では既に `when` が
 * 在るので、補完も知らせも走らない)。
 *
 * ## **【役割 `owner` を対象から外していない。`AC-G18` の3種目とは向きが違う】**
 *
 * **`grants_bypassed`(3種目)はユーザ決定 `D3` により `owner` を外してある** ——
 * **あちらは「運営者が全表を条件なしで扱えるのは意図された設定である」という理由であり、
 * カーネルは何も書き換えていない。**
 * **4種目は逆である** —— **カーネルが `owner` の規則を実際に書き換え、
 * 「自分の行と持ち主が空の行だけ」へ**狭めて**いる。**
 * **ここで `owner` を外すと、運営者の規則が黙って狭まり、書いた人は1件も知らされない** ——
 * **それは本単位が塞ごうとしている「黙って」そのものである。**
 * **したがって `owner` にも出す。** **【正直に書く】この決定は `D3` を1ミリも引き直して
 * いない** —— **`D3` は3種目についての決定であり、4種目には及ばない。**
 *
 * ## この関数が見ていないもの(**名指しで書く**)
 *
 * - **補われた結果その役割が実際に何行読めるようになったか / 読めなくなったかは
 *   1件も測らない** —— **カーネルは行を1件も読まない。**
 * - **既に `when` を書いてある規則は1件も載らない**(補完の対象外であり、
 *   `ADR-0318` 限定12 の線の内側である)。
 * - **`applyManifest` の経路(差分を通さない適用)では補完も知らせも1度も走らない** ——
 *   **`applyManifest` に補完は1バイトも入っていない**(入れると毎回の適用で条件が復活し、
 *   あとから外せなくなる。{@link grantDefaultRoleRules} の doc と同じ理由である)。
 */
function collectOwnerScopeSuppliedNotices(
  notices: RoleConditionNotice[],
  supplies: readonly OwnerScopeSupply[],
): void {
  for (const supply of supplies) {
    notices.push({
      kind: "owner_scope_supplied",
      role: supply.role,
      // **既存2種と同じ `/when` 付きの形である** —— **実際に書いた `when` を指すので、
      // 指し先が存在する**(3種目 `grants_bypassed` が `/when` を付けないのとは逆である)。
      path: `/app/roles/${supply.roleIndex}/rules/${supply.ruleIndex}/when`,
      message:
        `役割 "${supply.role}" の規則に、持ち主で絞る条件を補いました` +
        `(表 "${supply.table}" は持ち主の列を持っています)。` +
        `この役割は、自分の行と持ち主が空の行だけを扱えます。`,
      hint:
        "全員の行を扱わせたいなら、条件を明示的に書き直してください" +
        "(適用は通っています —— 拒否ではなく、お知らせです)。",
    });
  }
}

/**
 * **誰も通さない条件・全員を通す条件を、書いた人に返る形で伝える**(`V8-M18`。台帳
 * `J-G16` の限定の逐語「**書いた人に返る形で伝える**」。メインの裁定 `R-17-6`)。
 *
 * **拒否しない。適用は通る。知らせるだけである。**
 * **【禁止】「黙って何もしない」を作らない** —— **黙って全員を弾く条件は、権限の穴と
 * 区別がつかない**(`04` §7 の `V8-M18` の (vi))。
 *
 * ## 検出できる形(**これが全量である**)
 *
 * 1. **`and` の直下の兄弟に、同じ項目へ異なる定数を求める葉が2つ以上ある**
 *    (例: `{and:[{field:"status",equals:"A"},{field:"status",equals:"B"}]}`)→ 誰も通さない。
 * 2. **`and` の直下の兄弟に「X」と「X でない」が両方ある**(構造が完全に一致する組)
 *    → 誰も通さない。
 * 3. **`or` の直下の兄弟に「X」と「X でない」が両方ある** → 全員を通す。
 * 4. **役割が `anonymous` で、条件が「自分」の葉に依存して偽に確定する**
 *    (例: `anonymous` に `{field:"assignee",equals_current_user:true}`)→ 誰も通さない。
 *    **未ログインでは「自分」は偽に評価される**(`J-G13` の限定)。
 * 5. **上の1〜4 が `not` / `and` / `or` の畳み込みで根まで伝播した形**
 *    (例: 誰も通さない条件を `not` で包めば全員を通す)。
 *
 * ## 検出**できない**形(**名指しで書く。「矛盾を全部見つける」とは書かない**)
 *
 * 1. **業務上両立しない2つの定数**(「進行中」と「進行済み」)—— **綴りが違えば別物
 *    としか見ない。** 逆に、実データに1件も無い値を指す条件も見つけない。
 * 2. **実データの中身に依存する形** —— **カーネルは行を1件も読まない。**
 *    「担当が自分」がログイン済みの誰にも当たらない(`assignee` が全行空)ことは分からない。
 * 3. **直下の兄弟どうしでない矛盾** —— **入れ子をまたぐ組は見つけない**
 *    (例: `{and:[{or:[A,B]},{not:A},{not:B}]}` は実際には誰も通さないが、知らせない)。
 * 4. **項目の型と定数の型の食い違い**(真偽値の項目に文字列の定数)—— 1度も突き合わせない。
 * 5. **規則2本以上にまたがる重なり** —— **規則は1本ずつしか見ない。**
 *    同じ表に「条件なしで読める」と「条件つきで読める」を並べても何も言わない。
 * 6. **役割どうしの重なり** —— **役割は1本ずつしか見ない。**
 * 7. **`or` / `and` の並べ替えを同一視しない** —— `{or:[A,B]}` と `{or:[B,A]}` は別物
 *    として扱う(`canonicalCondition` の doc コメント)。
 * 8. **面(役割の規則)以外の層との矛盾** —— v7 の行ごとの付与・`st_owner` などの
 *    予約規約フィールドの層とは1度も突き合わせない。
 *    **【`V8-M20`。台帳 `J-G27`〜`J-G30`】着手前はここに `audience` の層も並んでいた。**
 *    **その層は今日は存在しない**(`audience` / `writable_by` / `st_admin_readable` は
 *    `V8-M20` が廃止した)。**残る予約規約フィールドは4本である。**
 *
 *    **【2026-09-08。`V17-M5-T04` / `AC-G17` / `AC-G18` / `ADR-0422`。直前の項を
 *    1バイトも消していない】** **上の「1度も突き合わせない」は今日から一部が偽である。**
 *    **今日は、行ごとの付与を宣言した表(`access_control.enabled === true`)を
 *    **条件なしで**扱う規則だけを突き合わせる**(3種目 `grants_bypassed`)。
 *    **他の重なりは今日も1件も見ない** —— **`st_owner` の層とは今日も1度も
 *    突き合わせず、条件を**書いてある**規則と付与の層との重なりも1件も見ない。**
 *    **役割 `owner` の規則は、条件なしでも1件も知らせない**(ユーザ決定 `D3`)。
 *
 *    **【2026-09-08。`V17-M5-T05` / `AC-G33` / `ADR-0423`。直前の2つの段落を
 *    1バイトも消していない】** **直前の追記の「`st_owner` の層とは今日も1度も
 *    突き合わせず」は、この配列に載るものについては今日は正確ではない。**
 *    **この関数は今日も `st_owner` の層を1度も突き合わせない**(判定は1本も持たない)——
 *    **が、`st_owner` の列を持つ表について**カーネルが条件を補った**ことを、
 *    4種目 `owner_scope_supplied` として同じ配列に載せるようになった。**
 *    **載せる材料は {@link supplyOwnerScopeConditions} が畳み込みの出口で採った記録であり、
 *    この関数が突き合わせた結果ではない**({@link collectOwnerScopeSuppliedNotices})。
 *    **【禁止】これを「`st_owner` の層との矛盾を見つけるようになった」と読まない** ——
 *    **矛盾は1件も見ていない。補ったことを報告しているだけである。**
 *    **4種目は役割 `owner` にも出す**(3種目の `D3` は4種目に及ばない。理由は
 *    {@link collectOwnerScopeSuppliedNotices} の doc)。
 */
function collectRoleConditionNotices(
  manifest: Manifest,
  // **【2026-09-08 追記(`V17-M5-T05` / `AC-G33` / `ADR-0423`)。旧の1行を逐語で残す】**
  // **旧: `function collectRoleConditionNotices(manifest: Manifest): RoleConditionNotice[] {`**
  // **4種目 `owner_scope_supplied` だけは「状態で見る」ことができない** ——
  // **補った後のマニフェストの上では、作者が書いた条件と1バイトも区別が付かないからである。**
  // **したがってこの1つだけは、書いた側({@link supplyOwnerScopeConditions})が
  // 差分の畳み込みで採った記録を受け取る。** **既存3種の判定は今日どおり
  // 適用後のマニフェストだけを見ており、この引数を1度も読まない。**
  ownerScopeSupplies: readonly OwnerScopeSupply[] = [],
): RoleConditionNotice[] {
  const notices: RoleConditionNotice[] = [];
  collectOwnerScopeSuppliedNotices(notices, ownerScopeSupplies);
  // **【`V17-M5-T04` / `AC-G18`】行ごとのアクセス権を宣言した表の集合。**
  // **判定の材料は適用後のマニフェストだけである** —— **この差分が何を置いたかを
  // 1バイトも見ない**(`ADR-0422` の限定5)。**「状態で見る」側を採ったので、
  // 別の差分が置いた規則も、宣言をあとから足した表も、同じ1件として載る。**
  const grantDeclaredTables = new Set<ResourceId>();
  for (const table of manifest.app.tables ?? []) {
    if (declaresRecordGrants(table)) {
      grantDeclaredTables.add(table.id);
    }
  }
  (manifest.app.roles ?? []).forEach((role, roleIndex) => {
    const anonymous = role.id === "anonymous";
    (role.rules ?? []).forEach((rule, ruleIndex) => {
      // **【2026-09-08。`V17-M5-T04` / `AC-G18`。旧の1行を逐語で残す】**
      // **旧: `if (rule.when === undefined) return;`** —— **条件を書いていない規則を
      // 1本も見ずに素通ししていた。** **今日は素通りする前に3種目を1度だけ当てる**
      // (**当たらなければ今日どおり素通りする**)。
      if (rule.when === undefined) {
        collectGrantsBypassedNotice(
          notices,
          grantDeclaredTables,
          role.id,
          roleIndex,
          rule,
          ruleIndex,
        );
        return;
      }
      const truth = foldCondition(rule.when, anonymous);
      if (truth === "unknown") return;
      const path = `/app/roles/${roleIndex}/rules/${ruleIndex}/when`;
      notices.push(
        truth === "false"
          ? {
              kind: "never_matches",
              role: role.id,
              path,
              message:
                `役割 "${role.id}" の規則の条件は、どの行でも・どの人でも成り立ちません` +
                `(誰も通さない条件です)。この規則は許可を1件も足しません。`,
              hint:
                "条件を書き直すか、この規則ごと消してください" +
                "(適用は通っています —— 拒否ではなく、お知らせです)。" +
                (anonymous
                  ? "ログインしていない人には「自分」が1度も当てはまりません。"
                  : "同じ項目に別々の値を求めていないか、「X かつ X でない」になっていないかを確かめてください。"),
            }
          : {
              kind: "always_matches",
              role: role.id,
              path,
              message:
                `役割 "${role.id}" の規則の条件は、どの行でも・どの人でも成り立ちます` +
                `(全員を通す条件です)。条件を書かなかったのと同じ意味になります。`,
              hint:
                "絞り込むつもりだったなら条件を書き直してください。" +
                "絞らないつもりなら when ごと省略できます" +
                "(適用は通っています —— 拒否ではなく、お知らせです)。",
            },
      );
    });
  });
  return notices;
}

export function applyDiff(dataRoot: string, appId: string, diff: unknown): ApplyDiffResult {
  // --- 0. 未完了適用の巻き戻し(V1-M1-T04) ---
  // **前回がクラッシュで死んでいたら、その残骸の上に積まない。** 正常時は
  // 進行中マーカーが無いので、この呼び出しはファイルを1つも開かない(副作用ゼロ)。
  recover(dataRoot, appId);

  // --- 1. 事前検証(ここまでファイルもDBも触らない) ---
  const structural = validateDiff(diff);
  if (!structural.valid) {
    return { valid: false, errors: structural.errors };
  }
  const patch = diff as Diff;

  const current = readCurrentManifest(dataRoot, appId);

  const folded = foldOperations(current, patch.operations);
  if (!folded.valid) {
    return { valid: false, errors: folded.errors };
  }
  const next = folded.manifest;

  // 適用後マニフェストが単体で成立するか(構造 + 参照整合性)を**適用前に**確かめる。
  const validated = validateManifestFull(next);
  if (!validated.valid) {
    return {
      valid: false,
      errors: validated.errors
        .map(annotateAppliedManifestError)
        .map((error) => annotateNoCascade(error, patch.operations)),
    };
  }

  // 語彙で表現できる差分かも先に確かめる。applyManifest も同じ検査をするが、
  // 落ちる場合にスナップショットを1つも作らないために、こちらを先に通す。
  const planned = planMigration(current, next, patch.operations);
  if (!planned.valid) {
    return { valid: false, errors: planned.errors.map(annotateAppliedManifestError) };
  }

  // --- 変換可否の事前検証(ADR-0010 §6b)-----------------------------------
  // **スナップショット取得より前**に置く。ここで落ちた場合、スナップショットは
  // 1つも作られない —— `destructive-rejection.test.ts` の不変条件4 が、変換不能値に
  // よる中止でもそのまま成立する。DBは読むだけで1バイトも書かない。
  // 代償: 対象列の全行走査が apply のたびに1回増える(V1-M1-T05 の測定対象)。
  if (planned.conversions !== undefined && planned.conversions.length > 0) {
    const conversionErrors = checkConversions(dataRoot, appId, planned.conversions);
    if (conversionErrors.length > 0) {
      return { valid: false, errors: conversionErrors };
    }
  }

  // --- 後付け unique の既存重複検査(EC-G8 / ADR-0038)-----------------------
  // `change_field` で `unique` を false → true にした列に既存重複があれば、**差分全体を
  // 拒否し1バイトも変えない**(部分適用しない = ADR-0010 限定7 / 変換不能値と同型)。
  // **変換可否検査と同じく、スナップショット取得より前**に置く —— ここで落ちた場合、
  // スナップショットは1つも作られず、既存重複を黙って1件に潰すこともしない。DBは
  // readonly で開いて読むだけで1バイトも書かない(`destructive-rejection.test.ts` の
  // 不変条件と同型)。代償の TOCTOU 窓は書込時検査(records.ts)側と同じ(ADR-0038 §限界1)。
  if (planned.uniqueChecks !== undefined && planned.uniqueChecks.length > 0) {
    const uniqueErrors = checkUniqueBackfills(dataRoot, appId, planned.uniqueChecks);
    if (uniqueErrors.length > 0) {
      return { valid: false, errors: uniqueErrors };
    }
  }

  // --- undo 可能性の入口ガード(ADR-0028 / V1-M9-T08)---------------------------
  // `undo-<diff_id>` が規約長を超えると、適用は成功するのに undo だけができない
  // (憲法4「常に戻せる」の静かな破れ)。**適用できた差分は必ず undo できる**を
  // 構成上の全称命題として成立させるため、59文字を超える diff_id を入口で拒否する。
  //
  // これは `schemas/diff.schema.json` の `diff_id.maxLength: 59` と同じ判定を持つ
  // 帰属先(カーネル)側の一対である —— スキーマは外部バリデータが同じ判定を出せる
  // ようにするための宣言的な写しで、`validateDiff`(上の構造検証)が実際に先に弾く。
  // ここに置くのは、制約を所有しているのがカーネルだからであり(ADR-0007 歯止め3)、
  // MCP 層には置かない。**`beginApply` / `takeSnapshot` より前**なので、拒否時に
  // スナップショットも changelog も進行中マーカーも1バイトも変わらない(§7-1 不変条件1)。
  // `dry_run_diff` は影のデータルート上で `applyDiff` を呼ぶので判定は自動的に一致する。
  if (patch.diff_id.length > MAX_UNDOABLE_DIFF_ID_LENGTH) {
    return {
      valid: false,
      errors: [
        {
          path: "/diff_id",
          message:
            `diff_id "${patch.diff_id}" は ${patch.diff_id.length} 文字で、` +
            `undo できる上限(${MAX_UNDOABLE_DIFF_ID_LENGTH}文字)を超えています。` +
            `undo は "undo-<diff_id>" という名前でスナップショットを取るため、` +
            `この長さを超えると適用はできても取り消せなくなります(憲法4)。`,
          hint:
            `diff_id を ${MAX_UNDOABLE_DIFF_ID_LENGTH} 文字以内にして apply_diff し直してください。` +
            `状態は一切変更していません。`,
        },
      ],
    };
  }

  const store = KernelMetaStore.open(dataRoot);
  try {
    const duplicate = store.listChangelog(appId).find((entry) => entry.diff_id === patch.diff_id);
    if (duplicate !== undefined) {
      return {
        valid: false,
        errors: [
          {
            path: "/diff_id",
            message:
              `diff_id "${patch.diff_id}" はアプリ "${appId}" の履歴に既に記録されています` +
              `(${duplicate.applied_at}: ${duplicate.intent})。` +
              `changelog は「実際に起きたこと」の記録なので、同じIDを二度使うことはできません。`,
            hint:
              `別の diff_id を付け直して apply_diff してください。` +
              `以前の変更を取り消したいのであれば undo を使ってください。`,
          },
        ],
      };
    }

    // --- 2. 自動スナップショット ---
    // **マーカーはスナップショットより前に置く**(V1-M1-T04)。スナップショット取得の
    // 途中で死んだ区間を盲点にしないためである(`recovery.ts` の `beginApply`)。
    beginApply(dataRoot, appId, patch.diff_id);
    let snapshot: ReturnType<typeof takeSnapshot>;
    try {
      snapshot = takeSnapshot(dataRoot, appId, patch.diff_id);
    } catch (error) {
      // 取得に失敗した = 本体は1バイトも変わっていない。マーカーを残す理由が無い。
      endApply(dataRoot, appId);
      throw error;
    }

    try {
      // --- 3 + 4. マニフェスト更新とマイグレーション ---
      // operations を渡す。渡さないと `applyManifest` は v0 の additive 判定を行い、
      // 破壊的な差分をここで拒否してしまう(モジュール `migrate.ts` 冒頭の設計判断)。
      const applied = applyManifest(dataRoot, appId, next, patch.operations);
      if (!applied.valid) {
        // 事前検証を通っている以上ここには来ない想定。来た場合も状態を確実に戻す。
        rollback(dataRoot, appId, snapshot.name);
        endApply(dataRoot, appId);
        return { valid: false, errors: applied.errors };
      }

      // --- 5. changelog 記録 ---
      const entry = store.appendChangelog({
        app_id: appId,
        diff_id: patch.diff_id,
        intent: patch.intent,
        operations: patch.operations,
        snapshot: snapshot.name,
        kind: "apply",
        undo_target_seq: null,
      });

      // **ここが commit 点である**(V1-M1-T04)。changelog に載った時点で適用は確定し、
      // 以降にクラッシュしても `recover` は巻き戻さない(`committed` と判定する)。
      endApply(dataRoot, appId);

      return {
        valid: true,
        manifest: applied.manifest,
        plan: applied.plan,
        snapshot: snapshot.name,
        entry,
        // **`V8-M18` / 台帳 `J-G16`。****commit の後に作る** —— **知らせは適用の
        // 可否を1ミリも変えないからである(拒否ではない)。**
        // **【2026-09-08 追記(`V17-M5-T05` / `AC-G33` / `ADR-0423`)。旧の1行を逐語で残す】**
        // **旧: `        role_condition_notices: collectRoleConditionNotices(applied.manifest),`**
        // **畳み込みが採った「実際に条件を補った規則」の記録を渡す** ——
        // **役割と規則の並びは `foldOperations` の出口から `applyManifest` を通っても
        // 1バイトも入れ替わらないので、位置(`roleIndex` / `ruleIndex`)はそのまま使える。**
        role_condition_notices: collectRoleConditionNotices(
          applied.manifest,
          folded.ownerScopeSupplies,
        ),
      };
    } catch (error) {
      // 2 以降のどこで落ちても、適用前スナップショットへ戻してから投げ直す。
      // **`rollback` が投げた場合は `endApply` に到達しない** —— マーカーが残るので、
      // 次回起動時の `recover` が復旧を再試行する(`recovery.ts` の `endApply`)。
      rollback(dataRoot, appId, snapshot.name);
      endApply(dataRoot, appId);
      throw error;
    }
  } finally {
    store.close();
  }
}

/**
 * 変換可否を、**適用前の**アプリDBを読んで判定する(ADR-0010 §6b)。
 *
 * `readonly: true` で開く。**書けない接続で開くことが「1バイトも触らない」ことの
 * 担保である** —— コメントで宣言するだけだと、後から `UPDATE` を1行足せてしまう。
 */
function checkConversions(
  dataRoot: string,
  appId: string,
  conversions: readonly FieldConversion[],
): ValidationError[] {
  const path = appDbPath(dataRoot, appId);
  if (!existsSync(path)) {
    // create_app を通っていないアプリ。走査対象が存在しない。
    return [];
  }
  const db = new Database(path, { readonly: true });
  try {
    return checkFieldConversions(db, conversions);
  } finally {
    db.close();
  }
}

/**
 * 後付け unique(`false → true`)にした列の既存重複を、**適用前の**アプリDBを読んで
 * 検査する(EC-G8 / ADR-0038)。`checkConversions` と同型で `readonly: true` で開く ——
 * **書けない接続で開くことが「1バイトも触らない」ことの担保**である。1件でも重複が
 * あれば差分全体を拒否し(部分適用しない)、既存重複を黙って1件に潰さない。
 */
/**
 * 所有者スコープ付き一意(`unique: "owner"`)が使うスコープ列(**規約**。V4-M10-T07 / ADR-0078)。
 * **export しない**(限定8)。`records.ts` の同名の定数と同じ綴りである(層をまたいで
 * import しないので2箇所にある。隠さない)。
 */
const OWNER_SCOPE_COLUMN = "st_owner";

/** 実テーブルにその列が在るか(`PRAGMA table_info`)。**未知の列を SQL に書かないため。** */
function tableHasColumn(db: Database, tableId: string, column: string): boolean {
  return db
    .query<{ name: string }, []>(`PRAGMA table_info(${quoteIdentifier(tableId)})`)
    .all()
    .some((row) => row.name === column);
}

function checkUniqueBackfills(
  dataRoot: string,
  appId: string,
  checks: readonly { table: string; field: string; path: string; scope?: "owner" }[],
): ValidationError[] {
  const path = appDbPath(dataRoot, appId);
  if (!existsSync(path)) {
    // create_app を通っていないアプリ。走査対象が存在しない。
    return [];
  }
  const db = new Database(path, { readonly: true });
  try {
    const errors: ValidationError[] = [];
    for (const check of checks) {
      const tableExists =
        (db
          .query<{ n: number }, [string]>(
            'SELECT COUNT(*) AS n FROM "sqlite_master" WHERE "type" = \'table\' AND "name" = ?',
          )
          .get(check.table)?.n ?? 0) > 0;
      if (!tableExists) {
        // 適用前のDBにまだ無いテーブル(同じ差分で新設)。行が無いので重複も無い。
        continue;
      }
      // 非 null の値でグループ化し、2件以上あるものが「既存重複」である。
      // null は重複対象にしない(複数 null を許す = 書込時検査と同じ規則。ADR-0038)。
      //
      // **【V4-M10-T07 / E-G66 / ADR-0078】** **`unique: "owner"` の後付けは、持ち主ごとに
      // 数える** —— グループ化のキーに `st_owner`(共有センチネルを空文字に畳んだもの)を
      // 1つ足す。**持ち主が違う同値は「重複」ではない**(それがこの宣言の目的である)。
      // **スコープ列は `st_owner` に固定であり、列名を受け取れる形にしていない**(限定2)。
      // **表に `st_owner` が無ければスコープを掛けない**(= テーブル全体で数える。
      // 書込時検査 `records.ts` の `validateInput` と同じ判断)。
      const col = quoteIdentifier(check.field);
      const scopedByOwner =
        check.scope === "owner" && tableHasColumn(db, check.table, OWNER_SCOPE_COLUMN);
      const ownerExpr = `COALESCE(${quoteIdentifier(OWNER_SCOPE_COLUMN)}, '')`;
      const groupBy = scopedByOwner ? `${col}, ${ownerExpr}` : col;
      const dupes = db
        .query<{ value: string | number; n: number }, []>(
          `SELECT ${col} AS "value", COUNT(*) AS "n" FROM ${quoteIdentifier(check.table)} ` +
            `WHERE ${col} IS NOT NULL GROUP BY ${groupBy} HAVING COUNT(*) > 1 ORDER BY ${col}`,
        )
        .all();
      if (dupes.length === 0) {
        continue;
      }
      const shown = dupes.slice(0, UNCONVERTIBLE_SAMPLE_LIMIT);
      const samples = shown.map((d) => `${JSON.stringify(d.value)}(${d.n} 件)`).join(" / ");
      const omitted = dupes.length - shown.length;
      const tail = omitted > 0 ? ` ほか ${omitted} 種` : "";
      errors.push({
        path: check.path,
        message:
          `フィールド "${check.table}.${check.field}" を一意(unique)にできません。` +
          `既に同じ値を持つレコードが複数あります: ${samples}${tail}。` +
          `カーネルは重複を黙って1件に潰したりはしません(どの行が失われたかを後から知る手段が無いため)。`,
        hint:
          `先に update_record / delete_record で重複を解消してから、改めて同じ差分を送ってください。` +
          `一意制約を後から付けるには、既存データが既に一意でなければなりません。`,
      });
    }
    return errors;
  } finally {
    db.close();
  }
}

/**
 * 削除がビューから参照されて落ちたとき、**何を先に直すべきか**を hint に足す。
 *
 * ADR-0010 §7a: **カスケード削除は採らない。** 「フィールドを消したらビューの
 * `columns` からも自動で外す」は、rename の追随(§5d)と違って**ユーザが頼んで
 * いない削除をカーネルが追加で行うこと**である。拒否したうえで具体的な手順を返す。
 *
 * ## ADR-0012 で文面を分けた理由 —— 旧文面は remove_table に対して実行不能だった
 *
 * 旧文面は `remove_field` と `remove_table` の**両方**に「先に `update_view` で
 * 画面の項目から外せ」と案内していた。しかし `remove_table` に対してそれは
 * **実行不能な手順**である(V1-M1-T06 §10-3。実測で確認した)——
 *
 * - ビューの `table` は `update_view` の変更可能範囲外なので、別テーブルに移せない
 * - `columns` / `fields` を空にすることはできない(`field_id_list` は空配列を許さない)
 * - `change_table` の rename でも逃げられない(参照が追随するだけで、参照は残る)
 *
 * **「できません」と言うより悪い。** 手順どおりにやっても直らないので、AI は
 * 何往復も同じ壁に当たり続ける(憲法6)。ADR-0012 が `remove_view` を語彙に
 * 入れたことで、**`remove_table` に対しても実行可能な手順が初めて存在するように
 * なった。**
 *
 * ## 定数を1つに保つ(ADR-0012 限定6)
 *
 * `src/kernel/` の新規 export は `RemoveViewOperation` 型1件だけと決まっている。
 * したがって `DESTRUCTIVE_NO_CASCADE_NOTE` は**引き続き export された単一の定数**で
 * あり、両者に共通する前置き(カスケードしないという設計判断の説明)を保持する。
 * op ごとに違う手順は、**非 export の定数**として下に置き、`annotateNoCascade` が
 * 差分に含まれる op に応じて組み立てる。
 */
export const DESTRUCTIVE_NO_CASCADE_NOTE =
  "【削除は画面から自動で外れません】カーネルは、あなたが頼んでいない変更(画面を書き換えること・" +
  "画面を消すこと)を勝手に追加しません。先に画面の側を片付けてから、削除の op を送ってください" +
  "(同じ差分の中で、画面を片付ける op を先に並べても構いません)。" +
  "先に何をするかは、消したいものによって違います。";

/**
 * `remove_field` の手順。**ADR-0012 でも1文字も変えていない** —— この案内は
 * 実行可能であり、`apply-diff.test.ts` / `destructive-rejection.test.ts` が
 * 「hint に update_view が出る」ことを固定している。
 */
const REMOVE_FIELD_CASCADE_STEP =
  "【remove_field の場合】先に update_view で、対象の画面の columns / fields / sort / filter" +
  "(列ごとの見せ方を書いている画面では preset_column_align / preset_column_width も)から" +
  "その項目を外してください。そのうえで remove_field を送ってください。";

/**
 * `remove_table` の手順。**`update_view` では直らない**ことを最初に言い切る ——
 * 言わないと、上の `remove_field` の手順を流用して無限に往復する。
 */
const REMOVE_TABLE_CASCADE_STEP =
  "【remove_table の場合】update_view では直りません(画面の table は変更できず、" +
  "columns / fields を空にすることもできません)。先に remove_view で、そのテーブルに載っている" +
  "画面そのものを消してください。そのうえで remove_table を送ってください。";

/** その差分に含まれる op に応じた「先にやること」を組み立てる。両方含むなら両方返す。 */
function noCascadeHintFor(operations: readonly Operation[]): string | undefined {
  const steps: string[] = [];
  if (operations.some((operation) => operation.op === "remove_field")) {
    steps.push(REMOVE_FIELD_CASCADE_STEP);
  }
  if (operations.some((operation) => operation.op === "remove_table")) {
    steps.push(REMOVE_TABLE_CASCADE_STEP);
  }
  if (steps.length === 0) {
    return undefined;
  }
  return `${DESTRUCTIVE_NO_CASCADE_NOTE}${steps.join("")}`;
}

function annotateNoCascade(
  error: ValidationError,
  operations: readonly Operation[],
): ValidationError {
  const note = noCascadeHintFor(operations);
  if (note === undefined || !error.path.startsWith("/app/views/")) {
    return error;
  }
  if (error.hint === undefined) {
    return { ...error, hint: note };
  }
  if (error.hint.includes(DESTRUCTIVE_NO_CASCADE_NOTE)) {
    return error;
  }
  return { ...error, hint: `${error.hint} ${note}` };
}

/**
 * 適用前スナップショットへ書き戻す。
 *
 * 巻き戻し自体が失敗したら、元の失敗を `cause` に残したまま「戻せなかった」ことを
 * 明示して投げる。ここで黙って握り潰すと、部分適用が残っているのに成功したように
 * 見える最悪の壊れ方になる(憲法6)。
 */
function rollback(dataRoot: string, appId: string, snapshotName: string): void {
  try {
    restoreSnapshot(dataRoot, appId, snapshotName);
  } catch (cause) {
    throw new Error(
      `差分の適用に失敗し、さらにスナップショット "${snapshotName}" への巻き戻しにも失敗しました。` +
        `アプリ "${appId}" は中途半端な状態のままです。` +
        `${appId} のスナップショットディレクトリから手動で復元してください。`,
      { cause },
    );
  }
}

/**
 * 適用後マニフェスト由来のエラーに付ける注釈。
 *
 * このエラー群の `path` は「operations を畳み込んだ結果のマニフェスト」を根とする
 * Pointer(`/app/views/0/columns/1`)であり、**呼び出し側が送った diff を根としない**。
 * 注釈が無いと、呼び出し側(Phase 5 では LLM)は自分の送った diff の中にこのパスを
 * 探して見つけられず、自己修正の起点を失う。まずそこを伝えるのがこの文言の役目である。
 *
 * どの operation が原因かをカーネル側で逆算して付けることは**あえてしない**。
 * 推測が外れたときのほうが有害なので、「根が違う」という確かな事実だけを伝える。
 */
export const APPLIED_MANIFEST_PATH_NOTE =
  "【パスの根に注意】この path は operations を適用した“結果のマニフェスト”上の位置であり、" +
  "あなたが送った diff 上の位置ではありません(diff の中を同じパスで探しても見つかりません)。" +
  "結果マニフェストのこの位置を作り出している operation はどれかを考え、その operation を直してください。";

/**
 * 適用後マニフェストに対する検証エラーであることを、エラーを見た側に伝える。
 *
 * 元のバリデータが付けた `hint`(何をどう直すかの情報)は消さずに残し、
 * その後ろに注釈を追記する。参照整合性バリデータは軒並み `hint` を持つため、
 * 「hint があれば注釈しない」にすると**最も頻度の高いケースでちょうど注釈が落ちる**。
 *
 * `path` が `/operations` を根とするエラーには注釈を付けない。そちらは根が
 * 呼び出し側の diff と一致しており、注釈はかえって混乱のもとになる。
 * 同じエラーに二度適用しても注釈は重複しない。
 */
export function annotateAppliedManifestError(error: ValidationError): ValidationError {
  if (error.path === "/operations" || error.path.startsWith("/operations/")) {
    return error;
  }
  if (error.hint === undefined) {
    return { ...error, hint: APPLIED_MANIFEST_PATH_NOTE };
  }
  if (error.hint.includes(APPLIED_MANIFEST_PATH_NOTE)) {
    return error;
  }
  return { ...error, hint: `${error.hint} ${APPLIED_MANIFEST_PATH_NOTE}` };
}
