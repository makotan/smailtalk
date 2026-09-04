/**
 * 要件ドキュメント生成(V1-M8-T02。ADR-0025 の実装)。
 *
 * 憲法5 は「差分に意図を残す。**changelog が要件定義書**」であり、このモジュールは
 * その比喩を**機械的に検査できる主張**へ変える。現在のマニフェストと changelog を材料に、
 * 節に分かれた文書を組み立てる。
 *
 * ## この経路に LLM は1行も無い(ADR-0025 §1 / 限定5)
 *
 * 生成は純関数である。プロンプトで「出典に無いことを書くな」と命じる形の担保
 * (= 説明文に依存する担保)を採らない。ADR-0020 / ADR-0021 が capability を
 * 「説明文ではなくカーネルの実行層で遮断する」と決めたのと同じ線をここでも引く。
 *
 * ## 文字が `text` に入る経路は4つしかない(ADR-0025 §5)
 *
 * 1. `markdown = renderRequirementsMarkdown(statements)` の出力のみ(辺1)
 * 2. `text = renderStatementText(template, slots)` の出力のみ。テンプレートは**有限の定数表**で、
 *    `renderTemplate` は `{name}` の**単純置換だけ**である(辺2。限定6)
 * 3. スロットは4種・スカラのみ(限定7)。`id` は実在集合に照合して**外れれば throw**、
 *    `verbatim` は出典の値そのもの、`term` は語彙定数の要素、`number` は出典から数えた値(辺3)
 * 4. `sources` は**非空タプル型**なので、出典の無い statement は型として作れない(辺4)
 *
 * **保証されるのはここまでである。** テンプレート本文そのものが誤った主張を含んでいれば、
 * この構造は止められない(ADR-0025 §限界1)。「捏造が完全に不可能」とは書かない。
 *
 * ## 読み取り専用(限定4)/ 永続化しない(限定12)
 *
 * DB への書き込みもファイルの生成も1つも行わない。生成物は保存せず、呼ばれたときに毎回
 * その時点の状態から作る(ADR-0025 §9)。
 */
import { SYSTEM_TABLES } from "../shared/system-tables.ts";
import { readCurrentManifest } from "./apply-manifest.ts";
import { getChangelog } from "./changelog.ts";
import { CHANGELOG_KINDS, type ChangelogEntry } from "./meta-store.ts";
// ブール式 filter の深度上限。**既存の定数を共有する**(ADR-0068 B3)——
// 生成器に第2の上限を作ると、値が割れたときに誰も気づかない
// (`referential-integrity.ts` が役割の条件で同じ定数を import しているのと同じ作法)。
import { MAX_FILTER_DEPTH } from "./records.ts";
import {
  DIFF_OPS,
  FIELD_TYPES,
  type FilterCondition,
  type FilterNode,
  type FunctionDef,
  type Manifest,
  normalizeSort,
  type Operation,
  RESOURCE_KINDS,
  // **【`V8-M22`。台帳 `J-G34a` / `ADR-0315`】役割の条件の型。**
  // **`src/kernel/types.ts` の型を import するだけで、公開 export を1つも増やしていない。**
  type RoleCondition,
  SORT_ORDERS,
  type Table,
  VIEW_TYPES,
  type View,
  type Workflow,
} from "./types.ts";
import { undoneTargetSeqs } from "./undo.ts";

// --- 型(ADR-0025 §2)-----------------------------------------------------------

/** 文書の節。6つで閉じる(ADR-0025 §7)。 */
export type RequirementSection =
  | "overview"
  | "features"
  | "screens"
  | "data"
  | "automation"
  | "history";

/**
 * 識別子・表示名のグループ。各グループは「マニフェスト/changelog から構築した実在集合」を1つ持つ。
 * `*_name` グループは markdown 上で鉤括弧、それ以外はバッククォートで描かれる(ADR-0025 §4-2)。
 */
export type IdentifierGroup =
  | "app_id"
  | "table_id"
  | "field_id"
  | "view_id"
  | "workflow_id"
  | "function_id"
  | "diff_id"
  | "applied_at"
  | "app_name"
  | "table_name"
  | "field_name"
  | "view_name"
  | "workflow_name"
  | "function_name"
  | "capability_name"
  /**
   * ADR-0025 改訂1(2026-07-23)。アクションの `values` / `payload` / `input` のキー。
   *
   * **実在集合は `capability_name` と同じく自己言及的である**(§限界6 と同型)——
   * スキーマはこれらのキーに `propertyNames` 制約を1つも置いておらず
   * (`schemas/manifest.schema.json` の `workflow_action`)、参照整合性検査も
   * **キーは見ていない**(`referential-integrity.ts:539` が「キーではない」と明記)。
   * したがって実在集合はマニフェスト上のキーそのものから作るしかなく、
   * 照合できるのは「他のパスから来た値が混ざっていないこと」までである。
   * **`_name` で終わるので鉤括弧で描かれる** —— 任意の文字列を取りうるため、
   * 識別子用のバッククォートではなく表示名と同じ扱いにする(区切り文字の混入は fail-closed)。
   */
  | "action_key_name"
  /**
   * ADR-0126 A5(2026-08-04。`V4-M32-T01`)。**詳細画面の項目のまとまりの名前**
   * (`view.field_groups` のキー。`P-G17` の (C) 側 / `ADR-0092`)。
   *
   * **`action_key_name` と同型の自己言及の実在集合である**(§限界6 と同じ形)——
   * スキーマは まとまりの名前に `propertyNames` の**長さ**の制約しか置いておらず
   * (`schemas/manifest.schema.json` の `$defs/view/properties/field_groups`)、
   * 値の集合を1つも定めていない。したがって実在集合は**マニフェスト上のキーそのもの**
   * から作るしかなく、照合できるのは「他のパスから来た値が混ざっていないこと」までである。
   * **`_name` で終わるので鉤括弧で描かれる** —— 任意の文字列を取りうるため、
   * 識別子用のバッククォートではなく表示名と同じ扱いにする(区切り文字の混入は fail-closed)。
   */
  | "field_group_name"
  /**
   * ADR-0145 A4(2026-08-04。`V4-M39-T01`)。**持ち主が発行した逃げ道(任意 CSS)の資産名**
   * (`view.custom_css.asset`。`D-G5` / `ADR-0055`)。
   *
   * **`capability_name` / `action_key_name` / `field_group_name` と同型の自己言及の実在集合で
   * ある**(§限界6 と同じ形)—— **照合先(owner 専用の資産ストア)がマニフェストの外に在る**
   * ので、実在集合はマニフェスト上の値そのものから作るしかない。**照合できるのは「他のパスから
   * 来た値が混ざっていないこと」までである。**
   *
   * **【正直に書く】実在を照合しない。fail-closed しない**(`ADR-0145` A7)—— **失効した資産を
   * 指す参照にも文が出る。** 照合しに行くと資産ストアを読むことになり、`ADR-0145` A3 / B1
   * (CSS のバイト列を1バイトも読まない。憲法1)を破る。
   * **`_name` で終わるので鉤括弧で描かれる。**
   */
  | "escape_hatch_asset_name"
  /**
   * **【`V8-M22`。台帳 `J-G34a` / ユーザ決定 `D-V8-36`。`ADR-0315`】**
   * **役割の識別子**(`app.roles[].id`)と**役割の表示名**(`app.roles[].name`)、
   * および**ボタンの識別子**(`view.actions[].id`)の3グループ。
   *
   * **`role_id` の実在集合は `app.roles[].id` そのものである** —— **`action_key_name` /
   * `field_group_name` と同型の自己言及である**(§限界6 と同じ形)。**スキーマは
   * `^[a-z0-9_]{1,32}$` のパターン1本しか置いておらず、「予約4語 ∪ `app.user_kinds[].id`」
   * という値域を閉じていない**(`V8-M16` が申告済みの穴。`src/kernel/referential-integrity.ts`
   * の 2440 行台の実測コメントが「`app.roles[].id` を検査する箇所は今日1つも無い」と書く)。
   * **本モジュールはその穴を1バイトも塞いでいないし、広げてもいない** ——
   * **照合できるのは「他のパスから来た値が混ざっていないこと」までである。**
   *
   * **`view_action_id` の実在集合は `view.actions[].id` である** —— **`id` は任意キーなので、
   * 書いていないボタンは集合に入らない。** **役割の規則(`target: "action"`)が指せるのは
   * `id` を書いたボタンだけであり、それは `referential-integrity.ts` の類型16 が
   * 適用時に検査している**(だから実在集合との突き合わせは fail-closed しない)。
   *
   * **`role_name` は `_name` で終わるので鉤括弧で描かれる**(`ADR-0025` §4-2)——
   * **表示名は任意の文字列を取りうる**(スキーマは `minLength: 1` だけ)。
   * **`role_id` / `view_action_id` はバッククォートで描かれる。**
   *
   * **【正直に書く】この3グループは、要件ドキュメントの識別子グループを 23 → 26 にする。**
   * **`ADR-0300`(v7)は権限名を `verbatim` で写して識別子グループを1件も増やさなかったが、
   * 本単位はその作法を採らなかった** —— **`verbatim` はテンプレート末尾の引用ブロック1本に
   * しか置けず(`renderStatementText`)、「役割 × 対象 × 動詞」は1文に2つ以上の名前を要する。**
   * **位置(`{position}`)だけで役割を指す形も採らなかった** —— **`D-V8-36` が選んだ説明文の
   * 逐語が「会員は注文を見られます」であり、役割の名前が文に出ないとその形にならない。**
   */
  | "role_id"
  | "role_name"
  | "view_action_id"
  /**
   * ADR-0025 改訂2(2026-07-23)。**changelog の `operations` に現れた識別子**の集合。
   *
   * **マニフェストの実在集合とは別物であり、混ぜてはならない。** 履歴が語る識別子は
   * 「当時そう書かれていた」ものであって、**現在のマニフェストに存在するとは限らない**
   * —— 消された(`remove_*`)、改名された(`change_*` の `id`)、undo で巻き戻された、
   * のいずれでも現在の集合から外れる。ここでマニフェストの集合に照合すると、
   * **実際に起きた変更を述べようとしただけで fail-closed で生成が止まる。**
   *
   * それでも `verbatim` ではなく `id` として扱うのは、**これが識別子だからである**
   * —— 出典(当該 `operations` の要素)に還元されており、監査は changelog を
   * 独立に読んで同じ集合を作れる(§4-6 の循環回避は保たれる)。
   */
  | "historical_table_id"
  | "historical_field_id"
  | "historical_view_id"
  | "historical_workflow_id"
  | "historical_function_id";

/** 語彙の閉じた集合。値はカーネルの語彙定数の要素でなければならない。 */
export type VocabularyGroup =
  | "field_type"
  | "view_type"
  | "diff_op"
  | "resource_kind"
  | "sort_order"
  | "changelog_kind"
  | "trigger_type"
  | "action_type"
  | "function_input_source"
  /**
   * ADR-0126 A6(2026-08-04。`V4-M32-T01`)。**見せる相手 / 書ける相手のロール5値**
   * (`view.audience` / `field.audience` / `field.writable_by`)。
   *
   * **値域は `src/kernel/types.ts` の定数ではなく `schemas/manifest.schema.json` の
   * `$defs/view/properties/audience` の enum を写したものである** —— `audience` /
   * `writable_by` はカーネルの `View` / `Field` の型に1つも現れない(`ADR-0070` 限定5 /
   * `ADR-0071` 限定6 / `ADR-0076` 限定7 が `src/kernel/` を閉じたため、スキーマにだけ在る)。
   *
   * **写しであることの危うさを正直に書く**(`ADR-0126` Consequences 6): **スキーマ側の
   * enum が増えたのにここが古いままなら、この生成器は実在する宣言を fail-closed で拒否し、
   * 要件定義書そのものが作れなくなる**(厳しすぎる側に外れる)。**逆に、ここだけを広げても
   * スキーマが受け付けないので緩む側には外れない。** 突き合わせは
   * `requirements-doc.test.ts` が schema を読んで行う。
   *
   * ---
   *
   * **【`V8-M20`。台帳 `J-G27` / `J-G28` / `ADR-0301`。正直に書く】**
   * **この語彙グループを使うテンプレートは、今日1本も無い。** 使っていたのは
   * `screens.audience` / `data.field_audience` / `data.field_writable_by` の3本だけで、
   * その3本を本タスクが撤去した。**つまりこれは、誰も使わないまま残っているスロットである。**
   *
   * **残した理由は2つある。**
   *
   * (1) **`ADR-0301` は、撤去の各単位が台帳の単位を名指しで根拠にすることを求めている。**
   * **`V8-M20` の台帳が挙げる単位は `J-G27`〜`J-G30`(スキーマの5キーと予約規約
   * フィールド `st_admin_readable`)であり、この生成器の内部語彙グループを撤去する単位は
   * 1件も無い。** **根拠の無い撤去は行わない。**
   *
   * (2) **`scripts/audience-role-sync.test.ts` が、このファイルの `const AUDIENCE_ROLES`
   * のリテラルを正規表現で読み出し、`src/kernel/referential-integrity.ts` /
   * `scripts/cp-v1-8-audit.ts` / `src/server/owner-scope.ts` の3箇所と値が完全一致する
   * ことを検査している**(読めなければ throw する)。**`scripts/` は本タスクの触って
   * よいファイルに入っていない。**
   * **【誇張しない】** **その検査は今日すでに赤い** —— **`V8-M20` が
   * `src/server/owner-scope.ts` から `AUDIENCE_ROLES` を消したためであり、
   * 本ファイルの側を残しても緑には戻らない。** **つまり (2) は「消せない理由」ではなく
   * 「消しても得るものが無い理由」である。****赤の後始末は `scripts/` を触れる側の仕事。**
   *
   * **「使われていないから消えた」ことにはしない** —— **孤児のスロットが1件、
   * 語彙グループの数(19)に数えられたまま残っている。**
   */
  | "audience_role"
  /**
   * ADR-0126 A6(2026-08-04。`V4-M32-T01`)。**選択肢の強調の度合い4値**
   * (`field.emphasis` の値。`P-G28` / `ADR-0090`)。
   *
   * **`audience_role` と同じく `schemas/manifest.schema.json` の enum の写しであり、
   * 同じ危うさを持つ**(片方だけ直ると食い違う)。**`types.ts` はこの4値をインラインの
   * ユニオンとして持っているが、型エイリアスを export していない**(`ADR-0090` 限定)ので、
   * カーネルの定数として参照できるものは無い。
   */
  | "emphasis_level"
  /*
   * ADR-0144 A5 / A6(2026-08-04。`V4-M39-T01`)。**画面の見せ方のプリセット8軸の値。**
   *
   * **`preset_field_columns` だけは語彙グループを作らない**(A7)—— 値は `1` / `2` の整数で
   * あり、`term` にすると「1」「2」が語彙タグになって `number` スロットの存在意義と食い違う
   * (`view.page_size` が `ADR-0126` で `number` を採った先例と同型)。
   *
   * **どれも `schemas/manifest.schema.json` の `$defs/view` の enum の写しである** ——
   * `audience_role` / `emphasis_level` と同じ危うさを持つ(**スキーマ側の enum が増えたのに
   * ここが古いままなら、この生成器は実在する宣言を fail-closed で拒否する** = 厳しすぎる側に
   * 外れる。**逆に、ここだけを広げてもスキーマが受け付けないので緩む側には外れない**)。
   * 突き合わせは `requirements-doc.test.ts` が schema を読んで**順序ごと**行う。
   */
  | "column_align"
  | "column_width"
  | "pager_position"
  | "label_placement"
  | "image_size"
  | "text_preview"
  | "list_shape"
  | "density";

/**
 * 出典。**マニフェストか changelog のどちらかしかない。**
 *
 * `pointer` は RFC6901 の JSON Pointer で、`kind: "manifest"` なら manifest.json の根から、
 * `kind: "changelog"` なら当該 {@link ChangelogEntry} の根から辿る(`""` は根そのもの)。
 */
export type StatementSource =
  | { kind: "manifest"; pointer: string }
  | { kind: "changelog"; seq: number; diff_id: string; pointer: string };

/**
 * 文書中に出現しうる値の唯一の作り方。これ以外の経路で text に文字は入らない。
 *
 * `verbatim` の `from` は「`pointer` が指すオブジェクトの `field` キーの値」を意味する
 * (配列要素なら `field` は添字の文字列)。監査はこの経路でバイト一致を検査できる。
 */
export type Slot =
  | { kind: "id"; group: IdentifierGroup; value: string }
  | { kind: "verbatim"; value: string; from: { source: StatementSource; field: string } }
  | { kind: "term"; vocabulary: VocabularyGroup; value: string }
  | { kind: "number"; value: number };

/** テンプレートID。閉じた union({@link REQUIREMENT_TEMPLATES} と1対1)。 */
export type RequirementTemplateId =
  | "overview.identity"
  | "overview.created"
  | "overview.scale"
  | "features.table"
  | "features.view"
  | "features.workflow"
  | "features.function"
  /*
   * **【`V8-M22`。台帳 `J-G34a` / ユーザ決定 `D-V8-36`(2026-08-10)。`ADR-0315`】**
   * **`app.roles`(アプリの定義の9本目のキー)を述べる14本。**
   *
   * **出すと決めたのは 2026-08-10 のユーザである** —— **選ばれた見出しの逐語は
   * 「役割と、できることまで載せる」であり、説明文の逐語は「『会員は注文を見られます /
   * 書けます』のように、役割の名前と、その役割ができることが文章として出ます。
   * 条件つきの権限(担当が自分の行だけ、など)も文章になります。」である**
   * (`docs/plan/v8/03-user-decisions.md` §4e)。
   * **【禁止】これを「`V8-M15` の判定どおり」と書かない** —— **`V8-M15` は出すか出さないかを
   * 決めていない**(`V8-M16`〜`V8-M18` の3本の記録が裁定 `N-1` に倒して申し送っていた)。
   *
   * **内訳**: **名前2本**(`role` / `role_name`)+ **できること7本**(対象4種 × 書ける動詞。
   * 表 = 読取/書込/削除の3本・項目 = 読取/書込の2本・画面 = 読取1本・ボタン = 読取1本)
   * + **条件5本**(`and` / `or` / `not` / 定数との等値 / 「自分」)= **14本ちょうど。**
   *
   * **動詞は真偽ではなく列挙なので、`ADR-0300` の `_no_read` のような否定側の本数を持たない**
   * —— **`can` に書けるのは「できること」だけであり、「できないこと」を表す値が値域に1つも
   * 無い**(`ADR-0304` / 台帳 `J-G2` の限定)。**「読めない」と書ける場所が無いので、
   * 「読めないと宣言している」という文も作らない。**
   *
   * **条件は `screens.filter_*`(`ADR-0068` B群)と同じ前順走査の形を採る** ——
   * **通し番号と深さの2つの数で木を一意に復元できるので、5種目のスロットも
   * `verbatim` の構造値対応も要らない。**
   *
   * **文面は「宣言している」までしか述べない** —— **宣言は保証ではない**
   * (`ADR-0144` A4 / `ADR-0300` A6 と同じ線)。**判定が実際にどの入口で効くかを1文も書かない。**
   */
  | "features.role"
  | "features.role_name"
  | "features.role_rule_table_read"
  | "features.role_rule_table_write"
  | "features.role_rule_table_delete"
  | "features.role_rule_field_read"
  | "features.role_rule_field_write"
  | "features.role_rule_view_read"
  | "features.role_rule_action_read"
  | "features.role_condition_and"
  | "features.role_condition_or"
  | "features.role_condition_not"
  | "features.role_condition_equals"
  | "features.role_condition_equals_current_user"
  // **【`V8-M26` / `D-V8-70`】葉の3種目(その項目が空か)。**
  | "features.role_condition_is_empty"
  | "screens.target"
  | "screens.display_name"
  | "screens.column"
  | "screens.item"
  | "screens.sort"
  | "screens.filter"
  // ADR-0068 A6(V3-M11-G1)。**`view.related` / `view.actions` は v2 から1文も
  // 出ていなかった** —— 詳細画面に子一覧を出す宣言も、そこから別画面へ遷移する宣言も、
  // 書いてあるのに要件ドキュメントが1文字も述べなかった。
  | "screens.related"
  | "screens.related_column"
  | "screens.action"
  // ADR-0068 B群(V3-M11-G2)。**`list_view.filter` のブール式**(EC-G12 / ADR-0043)。
  // **前順(preorder)走査でノードごとに1文**を出し、各文が `number` スロット2つ
  // (通し番号・深さ)を持つ。**前順の訪問列と深さの列があれば木は一意に復元できる**
  // ので、5種目のスロットも `verbatim` の構造値対応も要らない(ADR-0068 §2)。
  // **ちょうど9本である**(B2。10本目を足さない)。
  | "screens.filter_and"
  | "screens.filter_or"
  | "screens.filter_not"
  | "screens.filter_equals"
  | "screens.filter_contains"
  | "screens.filter_gte"
  | "screens.filter_lte"
  | "screens.filter_in"
  | "screens.filter_in_value"
  // ADR-0126 A1(V4-M32-T01。2026-08-04)。**v4 が `$defs/view` に足した8キーを述べる11本。**
  // **`audience` / `menu_listed` / `field_groups` / `modal` / `search_fields` /
  // `page_size` / `after_save` / `sum_field` は、それぞれ別の ADR で通ったのに
  // 要件定義書には1文も出ていなかった** —— (b)「限定表が `src/kernel/` を閉じたので
  // 出せなかった」と (c)「限定表が要件ドキュメントを1点も要求しなかった」の2種の欠落である。
  // **文面は「宣言している」までしか述べない**(A4)—— **宣言は保証ではない。**
  /*
   * **【`V8-M20`。台帳 `J-G27` / `ADR-0301`】`"screens.audience"` をここから撤去した。**
   * **旧: `| "screens.audience"`(`ADR-0126` A1 が足した11本の1本目)。**
   * **撤去の理由は、根拠にしていた宣言そのものが消えたことである** ——
   * `schemas/manifest.schema.json` の `$defs/view/properties/audience` が
   * `V8-M20` で廃止された(見せる相手は `app.roles[].rules` の
   * 「役割 × 対象 × できること」へ移った)。**書けない宣言について文を出す
   * テンプレートは、出典を持てないので残せない**(`ADR-0025` §5 辺4)。
   * **`ADR-0126` A1 の「20本ちょうど」は、今日 17本になった** ——
   * その食い違いの扱いは `requirements-doc.test.ts` の `NEW_TEMPLATES` 側に書いた。
   */
  | "screens.menu_listed"
  | "screens.menu_unlisted"
  | "screens.field_group"
  | "screens.field_group_item"
  | "screens.modal"
  | "screens.non_modal"
  | "screens.search_field"
  | "screens.page_size"
  | "screens.after_save"
  | "screens.sum_field"
  // ADR-0144 A1(V4-M39-T01。2026-08-04)。**画面の見せ方のプリセット9キーを述べる9本。**
  // **`ADR-0050` 限界8 / `ADR-0068` 共通10 / `ADR-0126` B1 が「1文も出さない」と定めていた
  // ものを、門A の本審査(`V4-M39-G1` / `V4-M39-G2` = 限定採用)が覆した。**
  // **文面は「宣言している」までしか述べない**(A4)—— **宣言と描画は一致するとは限らない。**
  | "screens.preset_column_align"
  | "screens.preset_column_width"
  | "screens.preset_pager_position"
  | "screens.preset_label_placement"
  | "screens.preset_field_columns"
  | "screens.preset_image_size"
  | "screens.preset_text_preview"
  | "screens.preset_list_shape"
  | "screens.preset_density"
  // ADR-0145 A1(V4-M39-T01。2026-08-04)。**逃げ道(任意 CSS)への参照を述べる2本。**
  // **`ADR-0055` 限定14 が「要件ドキュメントを1バイトも触らない」と定めていたものを、
  // 門A の本審査(`V4-M39-G3` = 限定採用)が覆した。** **回収したのは「参照が現れる」まで
  // であり、「逸脱の列挙」は今日も実装されていない**(C2)。**CSS を1バイトも読まない**(A3)。
  | "screens.custom_css"
  | "screens.custom_css_digest"
  /*
   * `ADR-0291` A1(`V6-M6-T02`。2026-08-07)。**入力画面ごとの参照項目の選び方**
   * (`$defs/view` の29キー目 `reference_pickers`。`K-G2` / `K-G21b` / `ADR-0289`)を述べる3本。
   *
   * **有限3値のそれぞれに1本ずつ置く**(`modal` / `non_modal` / `unique` の3値と同型)——
   * **20件目の語彙グループを作らないためである**(`ADR-0144` §3a の 3 の門を通していない)。
   * **文面は「宣言している」までしか述べない**(`ADR-0126` A4)—— **宣言は保証ではない。**
   */
  | "screens.reference_picker_list"
  | "screens.reference_picker_type_filter"
  | "screens.reference_picker_search"
  /*
   * **【`V8-M13-T03`。台帳 `Q-G31a`(限定採用)/ `Q-G31b`(保留 → 本タスクで再審査して
   * 限定採用へ)。門A 本審査 = `V8-M7`】集計表(`$defs/view` の30キー目 `report`)の
   * 中身を述べる12本。**
   *
   * **着手前は1文も出ていなかった** —— **`V8-M8` が `report_view` の早期 return を置き、
   * 「集計表という画面が在る」ことしか言わせなかった**(その JSDoc が自ら申告していた)。
   * **本タスクはその早期 return を、文を出してから返す形に置き換えた。**
   *
   * **内訳**: **束ねるキー6本**(項目 / 行そのもの / 表の指定 / 粒度3値)+ **集計3本**
   * (件数 / 合計 / 表の指定)+ **突き合わせ1本** + **グラフ2本**(棒 / 折れ線)= **12本。**
   *
   * **有限値のそれぞれに1本ずつ置く**(粒度3値・グラフ2値)—— **20件目の語彙グループを
   * 作らないためである。****先例は直前の `screens.reference_picker_*` の3本
   * (`ADR-0291` A1)そのものである。**
   *
   * **`Slot` は今日も4種ちょうどである**(`ADR-0315` 限定5・限定6)——
   * **束ねるキー・集計の列・突き合わせの参照項目は `field_id`、表は `table_id`、
   * 位置は `number` で写した。****識別子グループも語彙グループも1件も増えていない。**
   *
   * **文面は「宣言している」までしか述べない**(`ADR-0126` A4 / `ADR-0144` A4)——
   * **「何件出る」「グラフがこう見える」とは1文字も書かない。** **既定を推測しない**
   * (`ADR-0126` A3)—— **`chart` を書いていない集計表に「棒グラフで描く」とは書かない**
   * (`ReportDeclaration.chart` の JSDoc が「宣言を読んだだけでは棒が出ることが分からない」
   * と申告している。**その穴を要件ドキュメントの側で埋めない**)。
   *
   * **【正直に書く】`report.filter` と `report.sort` の2キーは今日も1文も出ない。**
   * **どちらも `Q-G31a` / `Q-G31b` の射程に無く**(前者が問うのは「何を束ねて何を数えるか」、
   * 後者が問うのは「どの表とどの列を突き合わせているか」)、**門A の本審査(`V8-M7`)が
   * 出すと判定した単位が1つも無いためである。** **出すには門を改めて通すこと。**
   */
  | "screens.report_group_by"
  | "screens.report_group_by_row"
  | "screens.report_group_by_table"
  | "screens.report_group_by_day"
  | "screens.report_group_by_week"
  | "screens.report_group_by_month"
  | "screens.report_aggregate_count"
  | "screens.report_aggregate_sum"
  | "screens.report_aggregate_table"
  | "screens.report_join"
  | "screens.report_chart_bar"
  | "screens.report_chart_line"
  | "data.table"
  | "data.field"
  | "data.field_required"
  | "data.field_optional"
  | "data.field_option"
  | "data.field_reference"
  // ADR-0126 A1(V4-M32-T01。2026-08-04)。**v4 が `$defs/field` に足した6キーを述べる9本。**
  // **`unique` は3値それぞれ1文にする**(A2 の 9)—— `true` / `false` / `"owner"` を
  // 同じ文で表すと「持ち主ごと」が読めない。
  /*
   * **【`V8-M20`。台帳 `J-G28` / `ADR-0301`】旧記述をここに残す** ——
   * 旧: 「**`audience` と `writable_by` を別の文にする**(A2 の 11)——
   * `ADR-0076` §1b が『読取の値域と書込の値域は一致しない。裏返しではない』と
   * 明記しており、同じ文で表すと2つが同じものに読める。」
   * **その2本(`"data.field_audience"` / `"data.field_writable_by"`)を撤去した。**
   * **`schemas/manifest.schema.json` の `$defs/field/properties/audience` と
   * `.../writable_by`、および `schemas/diff.schema.json` の
   * `$defs/field_changes/properties/writable_by` が `V8-M20` で廃止され、
   * 項目ごとの見せる相手 / 書ける相手は `app.roles[].rules`(対象 `field`・
   * 動詞 `read` / `write` / `delete`)へ移った。** **出典を持てない文は残せない。**
   */
  | "data.field_unique"
  | "data.field_unique_owner"
  | "data.field_not_unique"
  | "data.field_unit"
  | "data.field_emphasis"
  | "data.field_hide_when_empty"
  | "data.field_show_when_empty"
  /*
   * `ADR-0291` A1(`V6-M6-T02`。2026-08-07)。**参照項目の選び方**
   * (`$defs/field` の13キー目 `reference_picker`。`K-G1` / `K-G21b` / `ADR-0288`)を述べる3本。
   *
   * **有限3値のそれぞれに1本ずつ**(上の `screens.reference_picker_*` と同じ理由)。
   * **`reference_search_fields`(探せる項目)には1本も置かない** —— **ユーザ決定
   * `D-V6-21`(要件の説明書には選び方は出す・探せる項目は出さない)と、`V6-M0` §7-11 の
   * `K-G21b` 限定2 による。****「書けるのに1文も出ない項目の宣言」が1件、決定として残る。**
   */
  | "data.field_reference_picker_list"
  | "data.field_reference_picker_type_filter"
  | "data.field_reference_picker_search"
  /*
   * **`Z-G28`(`V7-M6-T03`。2026-08-08)。この表がアクセス権管理を使うことの宣言**
   * (`$defs/table` の6キー目 `access_control`。`V7-M1-T01` / `ADR-0292`)を述べる12本。
   *
   * **出すのは宣言だけで、付与の行の中身を1文字も出さない**(`Z-G28` 限定1)——
   * **行を読むと生成物がデータに依存し、決定論的テンプレート生成の作法が崩れる。**
   *
   * **出すのは4項目に閉じる**(限定2): (a) この表がアクセス権管理を使うこと /
   * (b) 権限名とその読む・書く・消すの組 / (c) 付与表・メンバー表・グループ表の名前 /
   * (d) `inherit_from` の参照項目の名前。**5項目目を足さない** ——
   * **`creator_permission`(行を作った人に自動で与える権限名)を1文も出していないのは
   * その帰結であって、書き漏らしではない。**
   *
   * **読む / 書く / 消すは、真偽それぞれ1本のテンプレートで表す**(`hide_when_empty` が
   * 採った形と同型)—— **20件目の語彙グループも、新しい識別子グループも作らないためである。**
   * **権限名(機械が使う名前)は `verbatim` で写す** —— 実在集合を持たないので `id` に
   * できず、**閉じた語彙でもないので `term` にもできない**(`data.field_option` と同じ形)。
   * **人が読む権限名(`name`)は1文も出さない**(限定2 の4項目に閉じるため)。
   *
   * **文面は「宣言している」までしか述べる**(`ADR-0126` A4 と同じ線)——
   * **判定は HTTP の経路にだけ在り、MCP・受信口・ワークフロー・島は宣言を1つも見ない**
   * (`V7-M6-T01` の実測)。**「守られる」「安全になる」とは1文字も書かない。**
   */
  | "data.table_access_control"
  | "data.table_access_permission"
  | "data.table_access_permission_read"
  | "data.table_access_permission_no_read"
  | "data.table_access_permission_write"
  | "data.table_access_permission_no_write"
  | "data.table_access_permission_delete"
  | "data.table_access_permission_no_delete"
  | "data.table_access_grant_table"
  | "data.table_access_member_table"
  | "data.table_access_group_table"
  | "data.table_access_inherit_from"
  | "automation.workflow"
  | "automation.trigger_on_create"
  | "automation.trigger_on_update"
  | "automation.trigger_schedule"
  // **【`V5-M25-T01` / `L-G8` / `ADR-0174`】4値目 `manual` の文。**
  | "automation.trigger_manual"
  // ADR-0068 A4 / A5(V3-M11-G1)。**`schedule` の `table` と `older_than`。**
  // `on_create` / `on_update` の `table` は文になるのに、**同じ `table` キーが
  // `schedule` では0文だった**(D-G16a / ADR-0063)。`older_than`(D-G16b / ADR-0064)も同様。
  | "automation.trigger_schedule_table"
  | "automation.trigger_schedule_older_than"
  | "automation.action"
  | "automation.action_target_table"
  // ADR-0068 A1 / A2(V3-M11-G1)。**`update_record` の `target`(必須なのに0文だった)と、
  // 全アクション種で書ける `when`(EC-G5 条件分岐 / ADR-0036。0文だった)。**
  | "automation.action_target"
  | "automation.action_when"
  | "automation.action_run_function"
  // EC-G6 演算 = record 書き戻しモード(Route B。ADR-0037。V2-M3-T02)。write_back の
  // run_function は output_table 全置換ではなく、結果をきっかけのレコード自身へ書き戻す。
  | "automation.action_run_function_write_back"
  // ADR-0068 A7(V3-M11-G1)。**第3の書込モード `write_ops`**(ADR-0067)。
  // `write_back` にも `output_table` にも入らないので、**そのアクションについて
  // 「どの関数を呼ぶか」も「どこへ書くか」も1文も出なかった。**
  // **島が実際に何を書くかは書かない** —— op は実行時に島が生成するのでマニフェストに
  // 存在しない(ADR-0067 限定 A11)。
  | "automation.action_run_function_write_ops"
  // ADR-0025 改訂1(2026-07-23)。**`call_external` / `ai_transform` の詳細を述べる
  // テンプレートが union に無く、「外部へ送信する動作があるが、どこへ何を送るかは
  // 書いていない」文書になる欠落が実装中に判明したため9件足した。**
  | "automation.action_connection"
  | "automation.action_destination"
  | "automation.action_payload"
  | "automation.action_value"
  | "automation.action_ai_capability"
  | "automation.action_ai_prompt"
  | "automation.action_ai_input"
  | "automation.action_ai_output_field"
  | "automation.action_ai_fallback"
  | "automation.function"
  | "automation.function_input_table"
  | "automation.function_input_view"
  | "automation.function_input_record"
  // ADR-0068 A3(V3-M11-G1)。**`function.input` の配列形**(ADR-0062)。
  // **配列形は「足す」ではなく「減るのを止める」である** —— 単体形を配列形に書き換えると
  // 入力の文が消えていた。**単体形の3本は1バイトも変えず、位置を持つ3本を別に足す。**
  | "automation.function_input_table_at"
  | "automation.function_input_view_at"
  | "automation.function_input_record_at"
  | "automation.function_output_field"
  // ADR-0068 A7(V3-M11-G1)。**`function.output.ops`**(ADR-0067)。
  // `output: { ops: true }` の関数は出力フィールドを1つも持たないので、
  // `automation.function_output_field` の段が0行を生み、**出力について1文も出なかった。**
  | "automation.function_output_ops"
  | "automation.function_capability"
  | "history.applied"
  | "history.intent"
  | "history.operation"
  // ADR-0025 改訂2(2026-07-23)。**操作の「対象」を述べる7件。**
  // これが無いと履歴節が「`add_view` が7回」としか書かず、**どの画面を足したのかが
  // 1つも分からない** —— 履歴を前向き(差分 → 何が起きたか)に辿る経路が存在しなくなる。
  // 帰属(リソース → 差分)は逆向きなので、この代わりにはならない。
  | "history.operation_table"
  | "history.operation_field"
  | "history.operation_view"
  | "history.operation_workflow"
  | "history.operation_function"
  | "history.operation_rename_table"
  | "history.operation_rename_field"
  | "history.undo"
  | "history.undone";

export type RequirementStatement = {
  /** 生成順の連番(`S-001`。ゼロ埋め3桁以上)。 */
  id: string;
  section: RequirementSection;
  template: RequirementTemplateId;
  slots: Record<string, Slot>;
  /** `renderStatementText(template, slots)` の出力のみ。 */
  text: string;
  /** **非空タプル**。出典欄が空の記述はコンパイル時に作れない(ADR-0025 §5 辺4)。 */
  sources: [StatementSource, ...StatementSource[]];
};

/** グループごとの実在集合。**生成器が自分で構築したもの**であり、監査はこれを使わない(§4-6)。 */
export type RequirementIdentifiers = Record<IdentifierGroup, string[]>;

/** 生成物。**生成時刻・ホスト名・バージョン・パスを持たない**(ADR-0025 §6 / 限定8)。 */
export type RequirementsDoc = {
  app_id: string;
  statements: RequirementStatement[];
  markdown: string;
  identifiers: RequirementIdentifiers;
};

// --- テンプレート定数表(ADR-0025 §3)---------------------------------------------

/**
 * テンプレート本文の定数表。**ミニ言語ではない**(限定6)—— 繰り返しも条件分岐も
 * 演算子も関数呼び出しも文字列連結も1つも持たず、`{name}` の**単純置換だけ**が行われる。
 *
 * 課される不変条件は3つで、いずれも `requirements-doc.test.ts` が固定する:
 *
 * 1. **スロット記法 `{name}` を除き、バッククォート・鉤括弧・行頭の `> ` を含まない。**
 *    区切りはレンダラが与える —— 日本語には語境界が無く、部分文字列マッチが成立しない
 *    (`本` ⊂ `本一覧`)ため、区切りは文書の側が保証するしかない(ADR-0025 §4-1)。
 * 2. **`verbatim` スロットは末尾の1行にだけ置ける(テンプレート1本につき最大1つ)。**
 *    逐語引用は引用ブロックへ隔離されるので区切り文字を含んでよいが、行の途中に置けると
 *    隔離が成立しない。
 * 3. **{@link RequirementTemplateId} の union とキー集合が完全一致する。**
 *
 * **この定数表を export しているのは、上の不変条件と §4-3 の残差検査を検査するためである。**
 * 限定11 が数える「公開面」は生成の口(3関数)と型であり、ここは検査に必要な**データ**である
 * —— 定数表に到達できなければ ADR-0025 §3 が要求する「テストで固定する」が実行できない。
 */
export const REQUIREMENT_TEMPLATES: Record<RequirementTemplateId, string> = {
  "overview.identity": "アプリ {app_id}(表示名 {app_name})の要件定義書である。",
  "overview.created": "このアプリは seq {seq} の記録 {diff_id} として {applied_at} に作成された。",
  "overview.scale":
    "このアプリはテーブル {table_count} 件・画面 {view_count} 件・自動化 {workflow_count} 件・関数 {function_count} 件で構成される。",

  "features.table": "このアプリはテーブル {table_id}(表示名 {table_name})を持つ。",
  "features.view": "このアプリは画面 {view_id}(種別 {view_type})を持つ。",
  "features.workflow": "このアプリは自動化 {workflow_id}(表示名 {workflow_name})を持つ。",
  "features.function": "このアプリは関数 {function_id}(表示名 {function_name})を持つ。",

  // **【`V8-M22`。台帳 `J-G34a` / ユーザ決定 `D-V8-36`。`ADR-0315`】役割の14本。**
  // **述べるのは宣言だけである** —— **「宣言している」で止め、「守られる」「安全になる」を
  // 1文字も書かない。**
  "features.role": "このアプリは役割 {role_id} を持つ。",
  "features.role_name": "役割 {role_id} の表示名は {role_name} である。",
  "features.role_rule_table_read":
    "役割 {role_id} の {position} 番目の規則は、テーブル {table_id} の行を読めると宣言している。",
  "features.role_rule_table_write":
    "役割 {role_id} の {position} 番目の規則は、テーブル {table_id} の行を書き換えられると宣言している。",
  "features.role_rule_table_delete":
    "役割 {role_id} の {position} 番目の規則は、テーブル {table_id} の行を消せると宣言している。",
  "features.role_rule_field_read":
    "役割 {role_id} の {position} 番目の規則は、テーブル {table_id} のフィールド {field_id} を読めると宣言している。",
  "features.role_rule_field_write":
    "役割 {role_id} の {position} 番目の規則は、テーブル {table_id} のフィールド {field_id} を書き換えられると宣言している。",
  "features.role_rule_view_read":
    "役割 {role_id} の {position} 番目の規則は、画面 {view_id} を見られると宣言している。",
  "features.role_rule_action_read":
    "役割 {role_id} の {position} 番目の規則は、画面 {view_id} のボタン {view_action_id} を使えると宣言している。",
  "features.role_condition_and":
    "役割 {role_id} の {position} 番目の規則の条件の {node_position} 番目の要素(深さ {depth})は、その下に続く条件をすべて満たす行にだけ当たる。",
  "features.role_condition_or":
    "役割 {role_id} の {position} 番目の規則の条件の {node_position} 番目の要素(深さ {depth})は、その下に続く条件のいずれかを満たす行にだけ当たる。",
  "features.role_condition_not":
    "役割 {role_id} の {position} 番目の規則の条件の {node_position} 番目の要素(深さ {depth})は、その下に続く条件を満たさない行にだけ当たる。",
  "features.role_condition_equals":
    "役割 {role_id} の {position} 番目の規則の条件の {node_position} 番目の要素(深さ {depth})は、フィールド {field_id} の値が次と等しい行にだけ当たる:\n{value}",
  "features.role_condition_equals_current_user":
    "役割 {role_id} の {position} 番目の規則の条件の {node_position} 番目の要素(深さ {depth})は、フィールド {field_id} の値が要求している人と等しい行にだけ当たる。",
  // **【`V8-M26` / `D-V8-70`】葉の3種目。** **「空」の中身(null / 値が入っていない /
  // 長さ0の文字列)を文面に書き写している** —— **読む人が定義を別の場所へ探しに行かずに
  // 済むようにするためであり、`0` と `false` が空でないことも同じ1文に入れてある。**
  "features.role_condition_is_empty":
    "役割 {role_id} の {position} 番目の規則の条件の {node_position} 番目の要素(深さ {depth})は、フィールド {field_id} が空の行にだけ当たる(空とみなすのは null と、値が入っていないことと、長さ0の文字列の3つで、0 と false は空ではない)。",

  "screens.target": "画面 {view_id} は種別 {view_type} で、テーブル {table_id} を対象とする。",
  "screens.display_name": "画面 {view_id} の表示名は {view_name} である。",
  "screens.column": "画面 {view_id} は {position} 番目の列としてフィールド {field_id} を表示する。",
  "screens.item": "画面 {view_id} は {position} 番目の項目としてフィールド {field_id} を表示する。",
  "screens.sort":
    "画面 {view_id} は {position} 番目の並び順としてフィールド {field_id} を {sort_order} で使う。",
  "screens.filter":
    "画面 {view_id} は {position} 番目の絞り込み条件として、フィールド {field_id} の値が次と等しい行だけを表示する:\n{filter_value}",

  // ADR-0068 A6。**related の中身のレコードには触れない**(生成器は DB を1行も読まない)。
  "screens.related":
    "画面 {view_id} は {position} 番目の関連一覧として、テーブル {table_id} のうちフィールド {field_id} が今開いているレコードを指す行を表示する。",
  "screens.related_column":
    "画面 {view_id} の {position} 番目の関連一覧は、{column_position} 番目の列としてフィールド {field_id} を表示する。",
  "screens.action":
    "画面 {view_id} は {position} 番目の操作として画面 {form_view_id} へ遷移し、そのフィールド {field_id} に今開いているレコードを指す値をあらかじめ入れる。",

  // ADR-0068 B群。**前順走査でノードごとに1文。** `{position}` は前順の通し番号、
  // `{depth}` は根を 1 とする深さである。**この2つの数だけで木は一意に復元できる。**
  "screens.filter_and":
    "画面 {view_id} の絞り込み条件の {position} 番目の要素(深さ {depth})は、その下に続く条件をすべて満たす行だけを残す。",
  "screens.filter_or":
    "画面 {view_id} の絞り込み条件の {position} 番目の要素(深さ {depth})は、その下に続く条件のいずれかを満たす行だけを残す。",
  "screens.filter_not":
    "画面 {view_id} の絞り込み条件の {position} 番目の要素(深さ {depth})は、その下に続く条件を満たさない行だけを残す。",
  "screens.filter_equals":
    "画面 {view_id} の絞り込み条件の {position} 番目の要素(深さ {depth})は、フィールド {field_id} の値が次と等しい行だけを残す:\n{value}",
  "screens.filter_contains":
    "画面 {view_id} の絞り込み条件の {position} 番目の要素(深さ {depth})は、フィールド {field_id} の値が次を含む行だけを残す:\n{value}",
  "screens.filter_gte":
    "画面 {view_id} の絞り込み条件の {position} 番目の要素(深さ {depth})は、フィールド {field_id} の値が次以上の行だけを残す:\n{value}",
  "screens.filter_lte":
    "画面 {view_id} の絞り込み条件の {position} 番目の要素(深さ {depth})は、フィールド {field_id} の値が次以下の行だけを残す:\n{value}",
  "screens.filter_in":
    "画面 {view_id} の絞り込み条件の {position} 番目の要素(深さ {depth})は、フィールド {field_id} の値が次に挙げる {value_count} 件のいずれかである行だけを残す。",
  "screens.filter_in_value":
    "画面 {view_id} の絞り込み条件の {position} 番目の要素が挙げる {value_position} 番目の値は次のとおりである:\n{value}",

  // ADR-0126 A1 / A4(V4-M32-T01)。**述べるのは「そう宣言している」ことまでである。**
  // **「この画面は運営だけが見られる」「一覧から漏れない」とは1文字も書かない** ——
  // `ADR-0070` 限定7・限定8 / `ADR-0071` §限界1 / `ADR-0076` 限定10 により、宣言は保証では
  // ない(`GET /manifest` / MCP / 島 / ワークフローの各経路は守られない)。**要件定義書が
  // 守られない保証を述べたら、それは新しい嘘である。**
  //
  // **【`V8-M20`。台帳 `J-G27` / `ADR-0301`】`"screens.audience"` の本文を撤去した。**
  // **旧本文の逐語**: 「画面 {view_id} は、{position} 番目の見せる相手として
  // {audience_role} を宣言している。」
  // **`$defs/view/properties/audience` が廃止されたので、この文は出典を失った。**
  "screens.menu_listed": "画面 {view_id} は、メニューに並べると宣言している。",
  "screens.menu_unlisted": "画面 {view_id} は、メニューに並べないと宣言している。",
  "screens.field_group":
    "画面 {view_id} の {position} 番目の項目のまとまりの名前は {field_group_name} である。",
  "screens.field_group_item":
    "画面 {view_id} の {position} 番目の項目のまとまりは、{item_position} 番目の項目としてフィールド {field_id} を含む。",
  "screens.modal": "画面 {view_id} は、今の画面に重ねて出すと宣言している。",
  "screens.non_modal": "画面 {view_id} は、今の画面に重ねずに出すと宣言している。",
  "screens.search_field":
    "画面 {view_id} は、{position} 番目の検索対象としてフィールド {field_id} を宣言している。",
  "screens.page_size": "画面 {view_id} は、1ページに {count} 件を出すと宣言している。",
  "screens.after_save":
    "画面 {view_id} は、保存が成立したあと画面 {destination_view_id} へ移ると宣言している。",
  "screens.sum_field":
    "画面 {view_id} は、今表している集合についてフィールド {field_id} の合計を出すと宣言している。",

  /*
   * ADR-0144 A1 / A4(V4-M39-T01)。**述べるのは「そう宣言している」ことまでである。**
   *
   * **「〜のように見える」「〜が縮小して表示される」「〜が2段組で並ぶ」「〜が切り詰められる」
   * とは1文字も書かない。** 理由は4点、いずれも実測である ——
   * (i) **型とプリセットの対応を1つも検査していない**(`src/mcp/vocabulary.ts` 逐語:
   * 「いずれも拒否されず、書けるが効かない組み合わせになります」)/
   * (ii) **`columns` に載っていない列にも寄せ・幅を書ける**(`referential-integrity.ts` 類型2b)/
   * (iii) **`preset_list_shape: "card"` は列の軸を無効にする**(`manifest.schema.json` の
   * `description` 逐語)/ (iv) **`change_field` で型を変えてもプリセットは残る。**
   * **効いていることを要件定義書が主張したら、それは新しい嘘である。**
   *
   * **既定値と同じ値を書いた画面についても1文出す**(A3。2026-08-04 のユーザ決定・未採番)
   * —— **「意図して既定を選んだ」ことが読み取れるようにする。** ただし**書かなかった画面に
   * ついては1文も出さない**(既定値を推測しない)。
   */
  "screens.preset_column_align":
    "画面 {view_id} は、列 {field_id} の寄せとして {column_align} を宣言している。",
  "screens.preset_column_width":
    "画面 {view_id} は、列 {field_id} の幅として {column_width} を宣言している。",
  "screens.preset_pager_position":
    "画面 {view_id} は、件数とページ送りの位置として {pager_position} を宣言している。",
  "screens.preset_label_placement":
    "画面 {view_id} は、項目名と値の並べ方として {label_placement} を宣言している。",
  "screens.preset_field_columns": "画面 {view_id} は、項目の段組数として {count} を宣言している。",
  "screens.preset_image_size":
    "画面 {view_id} は、画像の大きさとして {image_size} を宣言している。",
  "screens.preset_text_preview":
    "画面 {view_id} は、長文の見せる長さとして {text_preview} を宣言している。",
  "screens.preset_list_shape":
    "画面 {view_id} は、一覧の器の形として {list_shape} を宣言している。",
  "screens.preset_density": "画面 {view_id} は、画面の詰まり具合として {density} を宣言している。",

  /*
   * ADR-0145 A1 / A6(V4-M39-T01)。**逃げ道(任意 CSS)への参照。**
   *
   * **「この画面は独自の見た目になっている」「持ち主が見た目を上書きしている」とは1文字も
   * 書かない** —— **資産が失効していれば当たっておらず、画面は fail-closed かつ loud になる**
   * (`ADR-0055` 限定6)。**要件定義書はその状態を1つも知らない**(A7)。
   * **書けるのは「参照すると宣言している」までである。**
   *
   * **中身の目印(sha256 の16進64桁)は末尾の逐語引用で写す**(A5)—— **切り詰めない。
   * 短縮しない。別表記に変換しない**(C3)。**CSS のバイト列は1バイトも読まない**(A3)。
   */
  "screens.custom_css":
    "画面 {view_id} は、持ち主が発行した資産 {escape_hatch_asset_name} を参照すると宣言している。",
  "screens.custom_css_digest":
    "画面 {view_id} が参照する資産 {escape_hatch_asset_name} の中身の目印は次のとおり記録されている:\n{digest}",

  /*
   * `ADR-0291` A1 / A4(`V6-M6-T02`)。**述べるのは「そう宣言している」ことまでである。**
   *
   * **「この項目は打った文字で絞り込める」「別の面が開く」とは1文字も書かない** ——
   * 理由は3点、いずれも実測である —— (i) **どの器で描くかはマニフェストに1バイトも
   * 現れず、表示層が決める**(`ADR-0288` 限定2 / `ADR-0094` 限定1)/ (ii) **探せる項目が
   * 0本のときは検索の口そのものが出ない**(`ADR-0290` / `v6-m4.md` §1-4)/
   * (iii) **`GET /manifest` も MCP も宣言を読まないので、宣言と実際の画面が
   * 一致することを誰も保証していない**(`ADR-0126` A4 と同じ理由)。
   *
   * **書かなかった画面については1文も出さない**(既定値を推測しない。`ADR-0144` A3)。
   */
  "screens.reference_picker_list":
    "画面 {view_id} は、フィールド {field_id} の参照先の選び方として一覧から選ぶ形を宣言している。",
  "screens.reference_picker_type_filter":
    "画面 {view_id} は、フィールド {field_id} の参照先の選び方として打った文字で候補を絞る形を宣言している。",
  "screens.reference_picker_search":
    "画面 {view_id} は、フィールド {field_id} の参照先の選び方として別の面を開いて探す形を宣言している。",

  /*
   * **【`V8-M13-T03`。台帳 `Q-G31a` / `Q-G31b`】集計表の中身を述べる12本。**
   *
   * **述べるのは「そう宣言している」ことまでである** —— **「群がいくつ出る」
   * 「売れていない商品が 0 で並ぶ」「上限に当たると 400 になる」とは1文字も書かない。**
   * **理由は実測である**: **上限4つのうち2つ(読む行 10,000 / 作る群 10,000)は
   * apply の時点で1つも検査されず、行が増えた日に初めて当たる**
   * (`schemas/manifest.schema.json` の `$defs/report` の追記が自ら申告している)。
   * **要件定義書が「こう出る」と述べたら、それは新しい嘘である。**
   *
   * **突き合わせの向き(順方向 / 逆方向)を1文字も書かない** —— **向きは宣言から
   * 推論されるものであって宣言に書かれていない**(`ReportJoin` の JSDoc)。
   * **書けるのは「テーブル `T` の参照フィールド `f` で結び付いた行を母集団に加える」
   * までである。**
   *
   * **表を書いていない束ねるキー・集計について「起点の表を指す」とは書かない** ——
   * **書いていないキーの文は1つも出さない**(`ADR-0126` A3)。
   */
  "screens.report_group_by":
    "画面 {view_id} の集計表は、{position} 番目の束ねるキーとしてフィールド {field_id} を宣言している。",
  "screens.report_group_by_row":
    "画面 {view_id} の集計表は、{position} 番目の束ねるキーとして行そのものを宣言している(1行が1つの群になる)。",
  "screens.report_group_by_table":
    "画面 {view_id} の集計表の {position} 番目の束ねるキーは、テーブル {table_id} の項目であると宣言している。",
  "screens.report_group_by_day":
    "画面 {view_id} の集計表の {position} 番目の束ねるキーは、日付を日ごとに束ねると宣言している。",
  "screens.report_group_by_week":
    "画面 {view_id} の集計表の {position} 番目の束ねるキーは、日付を週ごとに束ねると宣言している(週の始まりは月曜日である)。",
  "screens.report_group_by_month":
    "画面 {view_id} の集計表の {position} 番目の束ねるキーは、日付を月ごとに束ねると宣言している。",
  "screens.report_aggregate_count":
    "画面 {view_id} の集計表は、{position} 番目の集計として行の件数を数えると宣言している。",
  "screens.report_aggregate_sum":
    "画面 {view_id} の集計表は、{position} 番目の集計としてフィールド {field_id} の合計を出すと宣言している。",
  "screens.report_aggregate_table":
    "画面 {view_id} の集計表の {position} 番目の集計は、テーブル {table_id} を対象とすると宣言している。",
  "screens.report_join":
    "画面 {view_id} の集計表は、{position} 番目の突き合わせとして、テーブル {table_id} の参照フィールド {field_id} で結び付いた行を母集団に加えると宣言している。",
  "screens.report_chart_bar":
    "画面 {view_id} の集計表は、集計の結果を棒グラフで描くと宣言している。",
  "screens.report_chart_line":
    "画面 {view_id} の集計表は、集計の結果を折れ線グラフで描くと宣言している。",

  "data.table": "テーブル {table_id}(表示名 {table_name})はフィールドを {field_count} 件持つ。",
  "data.field":
    "テーブル {table_id} の {position} 番目のフィールドは {field_id}(表示名 {field_name})で、型は {field_type} である。",
  "data.field_required": "テーブル {table_id} のフィールド {field_id} は必須である。",
  "data.field_optional": "テーブル {table_id} のフィールド {field_id} は任意である。",
  "data.field_option":
    "テーブル {table_id} のフィールド {field_id} は {position} 番目の選択肢として次の値を持つ:\n{option}",
  "data.field_reference":
    "テーブル {table_id} のフィールド {field_id} はテーブル {reference_table} を参照する。",

  // ADR-0126 A1 / A4(V4-M32-T01)。**同上。「この項目は客に見えない」「この項目は書けない」
  // とは1文字も書かない** —— **落とすのはサーバの読取経路だけであり、MCP の `list_records` は
  // 宣言を1つも見ず、`GET /manifest` は未ログインでも全フィールド定義を返し続ける**
  // (`ADR-0071` 限定9 / `ADR-0076` 限定10)。
  "data.field_unique":
    "テーブル {table_id} のフィールド {field_id} は、同じ値を持つ行を2つ作れないと宣言している。",
  "data.field_unique_owner":
    "テーブル {table_id} のフィールド {field_id} は、同じ持ち主の中で同じ値を持つ行を2つ作れないと宣言している。",
  "data.field_not_unique":
    "テーブル {table_id} のフィールド {field_id} は、同じ値を持つ行を作れると宣言している。",
  //
  // **【`V8-M20`。台帳 `J-G28` / `ADR-0301`】2本の本文を撤去した。**
  // **旧本文の逐語**:
  //   `"data.field_audience"`: 「テーブル {table_id} のフィールド {field_id} は、
  //     {position} 番目の見せる相手として {audience_role} を宣言している。」
  //   `"data.field_writable_by"`: 「テーブル {table_id} のフィールド {field_id} は、
  //     {position} 番目の書ける相手として {audience_role} を宣言している。」
  // **`$defs/field` の `audience` / `writable_by` が廃止されたので、出典を失った。**
  "data.field_unit":
    "テーブル {table_id} のフィールド {field_id} の値の単位は次のとおり記録されている:\n{unit}",
  "data.field_emphasis":
    "テーブル {table_id} のフィールド {field_id} は、次の選択肢を {emphasis_level} として強調すると宣言している:\n{option}",
  "data.field_hide_when_empty":
    "テーブル {table_id} のフィールド {field_id} は、値が無いとき画面に出さないと宣言している。",
  "data.field_show_when_empty":
    "テーブル {table_id} のフィールド {field_id} は、値が無くても画面に出すと宣言している。",

  /*
   * `ADR-0291` A1 / A4(`V6-M6-T02`)。**同上。「この項目は打った文字で絞り込める」
   * とは1文字も書かない。**
   *
   * **入力画面ごとの上書き(`screens.reference_picker_*`)とは別の文である** ——
   * **優先順位は「画面 > 項目 > 既定」であり、同じ文で表すと、どちらが効くのかが
   * 読めなくなる**(`audience` と `writable_by` を別の文にしたのと同じ理由 =
   * `ADR-0126` A2 の 11)。
   */
  "data.field_reference_picker_list":
    "テーブル {table_id} のフィールド {field_id} は、参照先の選び方として一覧から選ぶ形を宣言している。",
  "data.field_reference_picker_type_filter":
    "テーブル {table_id} のフィールド {field_id} は、参照先の選び方として打った文字で候補を絞る形を宣言している。",
  "data.field_reference_picker_search":
    "テーブル {table_id} のフィールド {field_id} は、参照先の選び方として別の面を開いて探す形を宣言している。",

  /*
   * `Z-G28`(`V7-M6-T03`)。**アクセス権管理の宣言を述べる12本。**
   *
   * **述べるのは「そう宣言している」までである** —— **誰がどの行を見られるかは、この
   * 文書からは分からない**(**実際の付与は付与表の行の中にあり、行の中身は1文字も出ない**)。
   */
  "data.table_access_control":
    "テーブル {table_id} は、この表でアクセス権管理を使うと宣言している。",
  // **権限名は逐語引用で写す**(実在集合も閉じた語彙も持たないため)。
  "data.table_access_permission":
    "テーブル {table_id} の {position} 番目の権限名は次のとおり記録されている:\n{permission}",
  // **読む / 書く / 消すは真偽それぞれ1文にする** —— 3つを1文に丸めると、
  // どれが真でどれが偽なのかが読めなくなる(`unique` の3値を別の文にしたのと同じ理由)。
  "data.table_access_permission_read":
    "テーブル {table_id} の {position} 番目の権限は、行を読めると宣言している。",
  "data.table_access_permission_no_read":
    "テーブル {table_id} の {position} 番目の権限は、行を読めないと宣言している。",
  "data.table_access_permission_write":
    "テーブル {table_id} の {position} 番目の権限は、行を書き換えられると宣言している。",
  "data.table_access_permission_no_write":
    "テーブル {table_id} の {position} 番目の権限は、行を書き換えられないと宣言している。",
  "data.table_access_permission_delete":
    "テーブル {table_id} の {position} 番目の権限は、行を消せると宣言している。",
  "data.table_access_permission_no_delete":
    "テーブル {table_id} の {position} 番目の権限は、行を消せないと宣言している。",
  // **出すのは表の名前だけである** —— **どの列が何を表すかは1文も出さない**(限定2)。
  "data.table_access_grant_table":
    "テーブル {table_id} は、誰にどの行をどの権限で渡したかをテーブル {grant_table} に記録すると宣言している。",
  "data.table_access_member_table":
    "テーブル {table_id} は、利用者をテーブル {member_table} に記録すると宣言している。",
  "data.table_access_group_table":
    "テーブル {table_id} は、グループをテーブル {group_table} に記録すると宣言している。",
  "data.table_access_inherit_from":
    "テーブル {table_id} は、{position} 番目の親を辿る項目としてフィールド {field_id} を宣言している。",

  "automation.workflow":
    "自動化 {workflow_id}(表示名 {workflow_name})の実行履歴はテーブル {history_table} に記録される。",
  "automation.trigger_on_create":
    "自動化 {workflow_id} は、テーブル {table_id} にレコードが作られたとき(発火条件 {trigger_type})に動く。",
  "automation.trigger_on_update":
    "自動化 {workflow_id} は、テーブル {table_id} のレコードが更新されたとき(発火条件 {trigger_type})に動く。",
  "automation.trigger_schedule":
    "自動化 {workflow_id} は、毎日 {hour} 時 {minute} 分(発火条件 {trigger_type})に動く。",
  // **【`V5-M25-T01` / `L-G8` / `ADR-0174`】4値目 `manual` の文。**
  // **`on_create` / `on_update` と同じ形にしてある**(表 + 発火条件の2スロット)——
  // **「誰が押せるか」は1文字も書かない**(それはマニフェストに書かれていない。
  // 判定はサーバのロールと画面の `audience` で決まる)。
  "automation.trigger_manual":
    "自動化 {workflow_id} は、テーブル {table_id} の行から人が名指しで起こしたとき(発火条件 {trigger_type})に動く。",
  // ADR-0068 A4 / A5。**経過時間を計算した結果(「3日前は何月何日」)は書かない**(共通7)。
  "automation.trigger_schedule_table":
    "自動化 {workflow_id} は、発火したときテーブル {table_id} の行を1件ずつ対象にする。",
  "automation.trigger_schedule_older_than":
    "自動化 {workflow_id} が対象にするのは、フィールド {field_id} の値が発火した日から {days} 日以上前の行だけである。",
  "automation.action": "自動化 {workflow_id} の {position} 番目の動作は {action_type} である。",
  "automation.action_target_table":
    "自動化 {workflow_id} の {position} 番目の動作はテーブル {table_id} に書き込む。",
  // ADR-0068 A1 / A2。**値を解釈しない** —— `$record.<reference>` もリテラルUUIDも、
  // 出典の文字列そのものを逐語引用で写す(参照の解決は実行層の仕事である)。
  // `when` の**評価結果**(何件が該当するか)も1文字も書かない。
  "automation.action_target":
    "自動化 {workflow_id} の {position} 番目の動作が更新する対象は、次のとおり記録されている:\n{target}",
  "automation.action_when":
    "自動化 {workflow_id} の {position} 番目の動作は、フィールド {field_id} の値が次と等しいときだけ動く:\n{value}",
  "automation.action_run_function":
    "自動化 {workflow_id} の {position} 番目の動作は関数 {function_id} を実行し、結果をテーブル {table_id} に書き込む。",
  "automation.action_run_function_write_back":
    "自動化 {workflow_id} の {position} 番目の動作は関数 {function_id} を実行し、結果をきっかけのレコードに書き戻す。",
  // ADR-0068 A7。**島が実際に何を書くかは1文字も書かない**(op はマニフェストに存在しない)。
  "automation.action_run_function_write_ops":
    "自動化 {workflow_id} の {position} 番目の動作は関数 {function_id} を実行し、関数が返した更新操作をそのまま実行する。",

  // ADR-0025 改訂1(2026-07-23)。外部到達アクション(call_external)と AI 呼び出し
  // (ai_transform)の詳細。**1キー = 1 statement** であり、スロットはスカラのまま(限定7)。
  "automation.action_connection":
    "自動化 {workflow_id} の {position} 番目の動作は、接続 {capability_name} を使って外部へ送信する。",
  "automation.action_destination":
    "自動化 {workflow_id} の {position} 番目の動作の送信先は次のとおり記録されている:\n{destination}",
  "automation.action_payload":
    "自動化 {workflow_id} の {position} 番目の動作は、送信内容の項目 {action_key_name} に次の値を入れる:\n{value}",
  "automation.action_value":
    "自動化 {workflow_id} の {position} 番目の動作は、項目 {action_key_name} に次の値を書き込む:\n{value}",
  "automation.action_ai_capability":
    "自動化 {workflow_id} の {position} 番目の動作は、AI capability {capability_name} を使う。",
  "automation.action_ai_prompt":
    "自動化 {workflow_id} の {position} 番目の動作が AI に与える指示は、次のとおり記録されている:\n{prompt}",
  "automation.action_ai_input":
    "自動化 {workflow_id} の {position} 番目の動作は、AI に渡す項目 {action_key_name} に次の値を入れる:\n{value}",
  "automation.action_ai_output_field":
    "自動化 {workflow_id} の {position} 番目の動作は、AI の結果をフィールド {field_id} に書き戻す。",
  "automation.action_ai_fallback":
    "自動化 {workflow_id} の {position} 番目の動作が、AI の結果を使えなかったときに書き戻す値は次のとおりである:\n{fallback}",

  "automation.function": "関数 {function_id}(表示名 {function_name})が定義されている。",
  "automation.function_input_table":
    "関数 {function_id} はテーブル {table_id} の全行を入力に取る(入力元は {function_input_source})。",
  "automation.function_input_view":
    "関数 {function_id} は画面 {view_id} が示す行を入力に取る(入力元は {function_input_source})。",
  "automation.function_input_record":
    "関数 {function_id} はきっかけになった1レコードを入力に取る(入力元は {function_input_source})。",
  // ADR-0068 A3。**配列形の要素ごとに1文。** 単体形の3本(上)は1バイトも変えない。
  "automation.function_input_table_at":
    "関数 {function_id} の {position} 番目の入力はテーブル {table_id} の全行である(入力元は {function_input_source})。",
  "automation.function_input_view_at":
    "関数 {function_id} の {position} 番目の入力は画面 {view_id} が示す行である(入力元は {function_input_source})。",
  "automation.function_input_record_at":
    "関数 {function_id} の {position} 番目の入力はきっかけになった1レコードである(入力元は {function_input_source})。",
  "automation.function_output_field":
    "関数 {function_id} の出力の {position} 番目のフィールドは {field_id} で、型は {field_type} である。",
  // ADR-0068 A7。**返す操作の中身は書かない**(op は実行時に島が生成する)。
  "automation.function_output_ops":
    "関数 {function_id} は出力フィールドを持たず、更新操作の配列を返す。",
  "automation.function_capability": "関数 {function_id} は capability {capability_name} を使う。",

  "history.applied": "seq {seq} で差分 {diff_id} が {applied_at} に適用された。",
  "history.intent": "差分 {diff_id} の意図として次が記録されている:\n{intent}",
  "history.operation": "差分 {diff_id} の {position} 番目の操作は {diff_op} である。",

  // ADR-0025 改訂2(2026-07-23)。操作の対象。**識別子は「当時そう書かれていた」もので
  // あり、現在のマニフェストに存在するとは限らない**(§限界13)。
  "history.operation_table":
    "差分 {diff_id} の {position} 番目の操作の対象はテーブル {table_id} である。",
  "history.operation_field":
    "差分 {diff_id} の {position} 番目の操作の対象はテーブル {table_id} のフィールド {field_id} である。",
  "history.operation_view":
    "差分 {diff_id} の {position} 番目の操作の対象は画面 {view_id} である。",
  "history.operation_workflow":
    "差分 {diff_id} の {position} 番目の操作の対象は自動化 {workflow_id} である。",
  "history.operation_function":
    "差分 {diff_id} の {position} 番目の操作の対象は関数 {function_id} である。",
  "history.operation_rename_table":
    "差分 {diff_id} の {position} 番目の操作は、テーブルのIDを {table_id} から {new_id} に変えた。",
  "history.operation_rename_field":
    "差分 {diff_id} の {position} 番目の操作は、テーブル {table_id} のフィールドのIDを {field_id} から {new_id} に変えた。",
  "history.undo":
    "seq {seq} の記録 {diff_id} は、seq {undo_target_seq} の適用を取り消したものである。",
  "history.undone": "seq {seq} の差分 {diff_id} は、seq {undo_seq} で取り消された。",
};

/**
 * 参照項目の選び方の3値 → テンプレートID(**項目側**)。`ADR-0291` A2 の 1。
 *
 * **値域の正は `schemas/manifest.schema.json` の
 * `$defs/field/properties/reference_picker/enum` であり、`src/kernel/types.ts` の
 * `Field` の判別共用体がその写しである。** ここは**その3値を鍵にした表**なので、
 * **4値目が生えた日に TypeScript がこの表を赤くする**(`Record` の網羅性)。
 *
 * **語彙グループ(`VOCABULARIES`)を1件も増やしていない** —— 増やすと
 * `ADR-0144` §3a の 3 の門(監査スクリプトの独立性の確かめ直し)に当たる。
 * **`ADR-0007` の門A を通した限定表(`ADR-0291`)にその判断を書いた。**
 *
 * **`export` していない**(`K-G21b` 限定3 = `Δ8` を空に保つ)。
 */
const REFERENCE_PICKER_FIELD_TEMPLATES: Record<
  "list" | "type_filter" | "search",
  RequirementTemplateId
> = {
  list: "data.field_reference_picker_list",
  type_filter: "data.field_reference_picker_type_filter",
  search: "data.field_reference_picker_search",
};

/**
 * 同じ3値 → テンプレートID(**入力画面側の上書き**)。`ADR-0291` A2 の 2。
 *
 * **項目側と別の表にしている** —— **文が別だからである**(優先順位「画面 > 項目 > 既定」を
 * 読み手が取り違えないよう、どちらの宣言なのかを文面で分ける)。
 *
 * **`export` していない**(同上)。
 */
const REFERENCE_PICKER_VIEW_TEMPLATES: Record<
  "list" | "type_filter" | "search",
  RequirementTemplateId
> = {
  list: "screens.reference_picker_list",
  type_filter: "screens.reference_picker_type_filter",
  search: "screens.reference_picker_search",
};

/**
 * **日付を束ねる粒度3値 → テンプレートID**(`V8-M13-T03`。台帳 `Q-G31a`)。
 *
 * **有限値のそれぞれに1本ずつ置く形は、すぐ上の `REFERENCE_PICKER_*` の写しである**
 * (`ADR-0291` A1)—— **20件目の語彙グループ(`term` スロット)を作らないためである。**
 * **`export` していない**(`ADR-0025` 限定11。公開エクスポートの枠は余白0)。
 */
const GRANULARITY_TEMPLATES: Record<"day" | "week" | "month", RequirementTemplateId> = {
  day: "screens.report_group_by_day",
  week: "screens.report_group_by_week",
  month: "screens.report_group_by_month",
};

/**
 * **グラフ種別2値 → テンプレートID**(`V8-M13-T03`。台帳 `Q-G23` の宣言を `Q-G31a` の
 * 形で述べる)。
 *
 * **書いていない集計表については1文も出さない** —— **既定(棒)を推測して文を出さない**
 * (`ADR-0126` A3)。**`ReportDeclaration.chart` の JSDoc が「宣言を読んだだけでは棒が
 * 出ることが分からない」と承知した代償を申告しており、要件ドキュメントはその代償を
 * 打ち消さない。**
 *
 * **`export` していない**(同上)。
 */
const CHART_TEMPLATES: Record<"bar" | "line", RequirementTemplateId> = {
  bar: "screens.report_chart_bar",
  line: "screens.report_chart_line",
};

/**
 * 語彙グループの実体。**値はカーネルの語彙定数**である(ADR-0025 §5 辺3)。
 *
 * `trigger_type` / `action_type` / `function_input_source` だけは対応する
 * `as const` 配列がカーネルに無く、`types.ts` の判別共用体のタグとしてのみ存在する。
 * **そのために新しい語彙定数を export することはしない**(限定1 / 限定11)——
 * ここに書き下すのは型のタグの写しであって、語彙を1つも増やしていない。
 */
// **【`V5-M25-T01` / `L-G8` / `ADR-0174` 限定1】4値目 `manual` を1値足した(3 → 4)。**
// **これは型のタグの写しである** —— **スキーマが5値目を足したのにここが4値のままだと、
// その値を書いたアプリの要件定義書は `termSlot` の fail-closed で生成そのものが止まる**
// (厳しすぎる側に外れる。緩む側には外れない)。
const TRIGGER_TYPES = ["on_create", "on_update", "schedule", "manual"] as const;
const ACTION_TYPES = [
  "create_record",
  "update_record",
  "call_external",
  "ai_transform",
  "run_function",
] as const;
const FUNCTION_INPUT_SOURCES = ["table", "view", "record"] as const;

/**
 * ADR-0126 A6(V4-M32-T01)。**見せる相手 / 書ける相手のロール5値。**
 *
 * **これは `src/kernel/types.ts` の定数の写しではない** —— `audience` / `writable_by` は
 * カーネルの `View` / `Field` の型に1つも現れず、値域は
 * `schemas/manifest.schema.json` の `$defs/view/properties/audience` の enum にしかない。
 * **ここに書き下しているのはその enum の写しである。**
 *
 * **写しであることの危うさを隠さない**(`ADR-0126` Consequences 6):
 * **スキーマ側が6値目を足したのにここが5値のままだと、その値を書いたアプリの要件定義書は
 * `termSlot` の fail-closed で生成そのものが止まる**(厳しすぎる側に外れる)。
 * **逆に、ここだけを広げてもスキーマが受け付けないので緩む側には外れない。**
 * **同じ食い違いが監査スクリプト(`scripts/cp-v1-8-audit.ts`)との間にも1本ある** ——
 * `ADR-0025` §4-6 の循環回避の設計上、同じ定数を2箇所が独立に持つことになる。
 *
 * **export しない**(`TRIGGER_TYPES` / `ACTION_TYPES` / `FUNCTION_INPUT_SOURCES` と同じ作法。
 * `ADR-0126` B5 / C4 —— `src/kernel/` の新規 export を1件も足さない)。
 *
 * **【`V8-M20`。台帳 `J-G27` / `J-G28` / `ADR-0301`】この5値を読むテンプレートは
 * 今日1本も無い**(`VocabularyGroup` の `audience_role` の節に理由を書いた)。
 * **残した根拠は `VocabularyGroup` の節に書いた**(台帳に撤去の単位が無いこと。
 * `scripts/audience-role-sync.test.ts` がこのリテラルを読むことは副次的な理由に過ぎず、
 * その検査は `src/server/owner-scope.ts` の側の撤去で今日すでに赤い)。
 * **上の段落が述べる「fail-closed で生成が止まる」危うさは、今日は発火しない** ——
 * **この定数を参照する `termSlot` の呼び出しが1つも無いためである。**
 */
const AUDIENCE_ROLES = ["owner", "editor", "viewer", "customer", "anonymous"] as const;

/**
 * ADR-0126 A6(V4-M32-T01)。**選択肢の強調の度合い4値**(`field.emphasis` の値)。
 *
 * **同じくスキーマ(`$defs/field/properties/emphasis/additionalProperties/enum`)の写しで
 * あり、同じ危うさを持つ。** `types.ts` はこの4値をインラインのユニオンとして持つが、
 * **型エイリアスを export していない**(`ADR-0090` が `kernel-export-drift` を発火させない
 * ためにそうした)ので、カーネルの定数として参照できるものは1つも無い。
 */
const EMPHASIS_LEVELS = ["neutral", "info", "caution", "danger"] as const;

/*
 * ADR-0144 A5(単位A の6件)/ A6(単位B の2件)。**画面の見せ方のプリセット8軸の値。**
 *
 * **`AUDIENCE_ROLES` / `EMPHASIS_LEVELS` と同じ作法である** —— **ローカルの `as const` 配列で
 * 定義し、export しない**(`ADR-0025` 限定11 の枠は14件で余白は実測0。`Δ8` を発火させない)。
 * **値は `schemas/manifest.schema.json` の `$defs/view` の enum の写しであり、順序も写す**
 * (突き合わせは `requirements-doc.test.ts` が schema を読んで行う)。
 *
 * **9件目の語彙グループを足したくなったら `ADR-0144` §3a の 3 の門を通すこと** ——
 * **増やすたびに監査スクリプト(`scripts/cp-v1-8-audit.ts`)の独立性を1本ずつ確かめ直す
 * 必要がある**(`ADR-0025` §4-6)。
 */
const COLUMN_ALIGNS = ["left", "center", "right"] as const;
const COLUMN_WIDTHS = ["narrow", "standard", "wide"] as const;
const PAGER_POSITIONS = ["top", "bottom", "both"] as const;
const LABEL_PLACEMENTS = ["inline", "stacked"] as const;
const IMAGE_SIZES = ["thumbnail", "medium", "original"] as const;
const TEXT_PREVIEWS = ["short", "standard", "long", "full"] as const;
const LIST_SHAPES = ["table", "card"] as const;
const DENSITIES = ["comfortable", "compact"] as const;

const VOCABULARIES: Record<VocabularyGroup, readonly string[]> = {
  field_type: FIELD_TYPES,
  view_type: VIEW_TYPES,
  diff_op: DIFF_OPS,
  resource_kind: RESOURCE_KINDS,
  sort_order: SORT_ORDERS,
  changelog_kind: CHANGELOG_KINDS,
  trigger_type: TRIGGER_TYPES,
  action_type: ACTION_TYPES,
  function_input_source: FUNCTION_INPUT_SOURCES,
  audience_role: AUDIENCE_ROLES,
  emphasis_level: EMPHASIS_LEVELS,
  column_align: COLUMN_ALIGNS,
  column_width: COLUMN_WIDTHS,
  pager_position: PAGER_POSITIONS,
  label_placement: LABEL_PLACEMENTS,
  image_size: IMAGE_SIZES,
  text_preview: TEXT_PREVIEWS,
  list_shape: LIST_SHAPES,
  density: DENSITIES,
};

// --- 文書骨格(ADR-0025 §7)-------------------------------------------------------

const SECTION_ORDER: readonly RequirementSection[] = [
  "overview",
  "features",
  "screens",
  "data",
  "automation",
  "history",
];

const DOC_TITLE = "# 要件定義書";
const DOC_PREFACE =
  "この文書は、アプリのマニフェストと変更履歴だけから機械的に生成したものである。すべての記述は出典を持つ。" +
  // **【`V10-M34-T01`(2026-08-26)。台帳 `CM-G45` / `ADR-0379` §Decision 2 の (4)。
  // 旧文を1バイトも消していない】**
  // **足すのは**固定の1文**だけである** —— **`REQUIREMENT_TEMPLATES` を1本も増やさない。**
  // **コメントの出し入れの設定は `apps` 表(`comment_visibility`)に在り、
  // この生成器は材料として1件も読まない。** **固定文は材料を1つも増やさないので、
  // 直前の「マニフェストと変更履歴だけから機械的に生成した」は今日も真である。**
  // **【禁止】設定の値(出す / 出さない)を書かない** —— **読んでいないのだから書けない。**
  "コメントの書く欄と読む場所はアプリごとの設定であり、この文書はその設定を1件も読んでいない。";

const SECTION_HEADINGS: Record<RequirementSection, string> = {
  overview: "## 概要",
  features: "## 機能一覧",
  screens: "## 画面",
  data: "## データ",
  automation: "## 自動化",
  history: "## 履歴",
};

/**
 * 節ごとの定型注記。**`history` にだけ置く**(ADR-0025 §7)。
 *
 * 1本目は F-22(intent が逐語でない場合がある)の申告である。**「直った」とは書かない**
 * (ADR-0025 §F-12 の4)—— 注記があることは、劣化が無くなったことではない。
 * 2本目は ADR-0006 Consequences の限界①(`applyManifest` 経由の投入は載らない)の申告。
 */
const SECTION_NOTES: Record<RequirementSection, readonly string[]> = {
  overview: [],
  features: [],
  screens: [],
  data: [],
  automation: [],
  history: [
    "intent は当時の記録であり、逐語でない場合がある。",
    "ここに現れるのは、アプリの作成と apply_diff を経由した変更だけである。マニフェストを直接投入した変更は記録されない。",
  ],
};

const EMPTY_SECTION_NOTE = "この節に該当する記述はない。";

/**
 * `create_app` が書く第0行の `diff_id`(V1-M0-T05 / F-28)。
 *
 * `create-app.ts` の同名定数の写しである。**export して共有しない** —— 限定11 が
 * カーネルの新規 export を2群に限っており、この1文字列のために公開面を増やさない。
 * 突き合わせは `changelog.test.ts` / 本モジュールのテストが実データで行う。
 */
const CREATE_APP_DIFF_ID = "_create-app";

// --- レンダリング ------------------------------------------------------------------

const PLACEHOLDER_RE = /\{([a-z_]+)\}/g;

/** 区切り文字。値に混入していたら fail-closed する(ADR-0025 §4-5)。 */
const DELIMITERS = ["`", "「", "」", "\n"];

/** テンプレートに現れるスロット名(出現順・重複あり)。 */
function placeholderNames(body: string): string[] {
  PLACEHOLDER_RE.lastIndex = 0;
  return [...body.matchAll(PLACEHOLDER_RE)].map((match) => match[1] ?? "");
}

/**
 * 逐語引用スロットの名前(テンプレート末尾の行が `{name}` だけのとき)。
 * それ以外は `undefined`(= このテンプレートに逐語引用は置けない)。
 */
function verbatimSlotName(body: string): string | undefined {
  const lines = body.split("\n");
  if (lines.length < 2) {
    return undefined;
  }
  const last = lines[lines.length - 1] ?? "";
  const matched = /^\{([a-z_]+)\}$/.exec(last);
  return matched?.[1];
}

/** スカラースロットを markdown のスパンに変換する(ADR-0025 §4-2)。 */
function renderScalarSlot(name: string, slot: Slot): string {
  if (slot.kind === "verbatim") {
    throw new Error(
      `スロット "${name}" は逐語引用ですが、テンプレートの末尾の引用ブロック行に置かれていません。` +
        `逐語引用はテンプレート末尾の1行にだけ置けます(ADR-0025 §3 不変条件2)。`,
    );
  }
  if (slot.kind === "number") {
    if (!Number.isInteger(slot.value)) {
      throw new Error(
        `スロット "${name}" の数値 ${slot.value} が整数ではありません。` +
          `数値スロットは出典から数えた整数(件数・位置・seq・時分)だけを取ります。`,
      );
    }
    return `\`${slot.value}\``;
  }
  const value = slot.value;
  for (const delimiter of DELIMITERS) {
    if (value.includes(delimiter)) {
      throw new Error(
        `要件定義書の生成を中止しました。スロット "${name}" の値 "${value}" に区切り文字が含まれています。` +
          `識別子・表示名・語彙をバッククォートと鉤括弧で囲む規約(ADR-0025 §4-2)が壊れるため、` +
          `黙って除去せず fail-closed します(§4-5)。`,
      );
    }
  }
  if (slot.kind === "id" && slot.group.endsWith("_name")) {
    return `「${value}」`;
  }
  return `\`${value}\``;
}

/** 逐語引用を引用ブロックにする(複数行なら全行に `> ` を付ける)。 */
function renderQuoteBlock(value: string): string {
  return value
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/**
 * テンプレートとスロットから1記述の本文を作る。**`{name}` の単純置換だけを行う**(限定6)。
 *
 * 過不足のあるスロット・未知のテンプレート・区切り文字の混入はすべて throw する
 * (黙って落とすと「出典に無いことが書かれていない」ことの検査が意味を失う)。
 */
export function renderStatementText(
  template: RequirementTemplateId,
  slots: Record<string, Slot>,
): string {
  const body = REQUIREMENT_TEMPLATES[template];
  if (body === undefined) {
    throw new Error(`未知のテンプレートID "${template}" です。`);
  }

  const names = placeholderNames(body);
  const required = new Set(names);
  for (const name of required) {
    if (slots[name] === undefined) {
      throw new Error(
        `テンプレート "${template}" のスロット "${name}" に値がありません。` +
          `テンプレートのスロットとスロット表は過不足なく一致する必要があります。`,
      );
    }
  }
  for (const name of Object.keys(slots)) {
    if (!required.has(name)) {
      throw new Error(
        `テンプレート "${template}" は使わないスロット "${name}" を渡されました。` +
          `使われないスロットは出典を持ちながら文面に現れないため、黙って捨てません。`,
      );
    }
  }

  const verbatimName = verbatimSlotName(body);
  const lines = body.split("\n");
  const head = verbatimName === undefined ? body : lines.slice(0, -1).join("\n");

  PLACEHOLDER_RE.lastIndex = 0;
  const rendered = head.replace(PLACEHOLDER_RE, (_match, name: string) => {
    const slot = slots[name];
    if (slot === undefined) {
      throw new Error(`テンプレート "${template}" のスロット "${name}" に値がありません。`);
    }
    return renderScalarSlot(name, slot);
  });

  if (verbatimName === undefined) {
    return rendered;
  }
  const tail = slots[verbatimName];
  if (tail === undefined || tail.kind !== "verbatim") {
    throw new Error(
      `テンプレート "${template}" の末尾スロット "${verbatimName}" は逐語引用でなければなりません。`,
    );
  }
  return `${rendered}\n${renderQuoteBlock(tail.value)}`;
}

/**
 * statements を markdown に描く。**自由文字列を後から連結する経路を持たない**(§5 辺1)。
 *
 * 見出し・前書き・注記は statements に依存しない定数であり、残差検査(§4-3)の
 * 照合先に含まれる。**空入力に対する出力が、文書骨格定数の全体になる。**
 */
export function renderRequirementsMarkdown(statements: RequirementStatement[]): string {
  const blocks: string[] = [DOC_TITLE, DOC_PREFACE];
  for (const section of SECTION_ORDER) {
    blocks.push(SECTION_HEADINGS[section]);
    blocks.push(...SECTION_NOTES[section]);
    const own = statements.filter((statement) => statement.section === section);
    if (own.length === 0) {
      blocks.push(EMPTY_SECTION_NOTE);
    } else {
      blocks.push(...own.map((statement) => statement.text));
    }
  }
  return `${blocks.join("\n\n")}\n`;
}

// --- 実在集合(ADR-0025 §4-2)-----------------------------------------------------

type IdentifierSets = Record<IdentifierGroup, Set<string>>;

/** アクションが持つ capability の人間可読名(connection / ai_capability)。 */
function actionCapabilityNames(workflows: readonly Workflow[]): string[] {
  return workflows.flatMap((workflow) =>
    workflow.actions.flatMap((action) => {
      if (action.action === "call_external") {
        return [action.connection];
      }
      if (action.action === "ai_transform") {
        return [action.capability];
      }
      return [];
    }),
  );
}

/**
 * アクションが書き込む項目名(`values` / `payload` / `input` のキー)。
 *
 * ADR-0025 改訂1。**スキーマがキーに制約を1つも置いていない**ので、実在集合は
 * マニフェスト上のキーそのものから作る(`capability_name` と同型の自己言及。§限界6)。
 */
function actionKeyNames(workflows: readonly Workflow[]): string[] {
  return workflows.flatMap((workflow) =>
    workflow.actions.flatMap((action) => {
      if (action.action === "call_external") {
        return Object.keys(action.payload);
      }
      if (action.action === "ai_transform") {
        return Object.keys(action.input);
      }
      if (action.action === "create_record" || action.action === "update_record") {
        return Object.keys(action.values);
      }
      return [];
    }),
  );
}

/**
 * 詳細画面の項目のまとまりの名前(`view.field_groups` のキー)。
 *
 * ADR-0126 A5。**スキーマがまとまりの名前に値の制約を1つも持たない**ので、実在集合は
 * マニフェスト上のキーそのものから作る(`action_key_name` / `capability_name` と同型の
 * 自己言及。§限界6)。照合できるのは「他のパスから来た値が混ざっていないこと」までである。
 */
function fieldGroupNames(views: readonly View[]): string[] {
  return views.flatMap((view) =>
    view.type === "detail_view" && view.field_groups !== undefined
      ? Object.keys(view.field_groups)
      : [],
  );
}

/**
 * 逃げ道(任意 CSS)の資産名(`view.custom_css.asset`)。
 *
 * ADR-0145 A4。**照合先(owner 専用の資産ストア)がマニフェストの外に在る**ので、実在集合は
 * マニフェスト上の値そのものから作る(`capability_name` / `field_group_name` と同型の自己言及。
 * §限界6)。**資産の実在を1度も確かめない。fail-closed しない**(A7)——
 * **確かめに行くとストアを読むことになり、A3 / B1(CSS を1バイトも読まない)を破る。**
 * **CSS の本文はマニフェストの語彙に置き場が無い**(`ADR-0055` 限定2)ので、ここで触れるのは
 * 名前だけである。
 */
function escapeHatchAssetNames(views: readonly View[]): string[] {
  return views.flatMap((view) => (view.custom_css === undefined ? [] : [view.custom_css.asset]));
}

/**
 * ボタンの識別子(`view.actions[].id`)。**`V8-M22` / 台帳 `J-G34a` / `ADR-0315`。**
 *
 * **`id` は任意キーである**(`ADR-0304` / `J-G9` が `V8-M17` で足した)—— **書いていない
 * ボタンは実在集合に入らない。** **役割の規則(`target: "action"`)が指せるのは `id` を
 * 書いたボタンだけであり、その実在は `src/kernel/referential-integrity.ts` の類型16 が
 * 適用時に検査している**(「その画面の上にそのボタンが在るか」)。
 * **したがって、規則が指すボタンは必ずこの集合に入っている** —— **入っていないマニフェストは
 * 適用の時点で拒否されており、ディスクに載らない。**
 *
 * **`actions` を持つのは `detail_view` と `list_view` だけである**(`form` には無い)——
 * **キーの有無で判別する**(`ADR-0025` の他の関数と同じ作法。型の判別共用体に踏み込まない)。
 */
function viewActionIds(views: readonly View[]): string[] {
  return views.flatMap((view) => {
    const actions = "actions" in view ? ((view.actions ?? []) as { id?: string }[]) : [];
    return actions.flatMap((action) => (action.id === undefined ? [] : [action.id]));
  });
}

/**
 * JSON Pointer の1トークンをエスケープする(RFC 6901 §3)。
 *
 * ADR-0126。**出典の pointer に「マップのキー」が入るのは本モジュールではここが最初である**
 * (他は固定文字列と配列添字だけ)—— `view.field_groups` のまとまりの名前と
 * `field.emphasis` の選択肢の値の2つで、**どちらもスキーマが `~` も `/` も禁じていない。**
 * エスケープしないと pointer が別の場所を指し、監査(`scripts/cp-v1-8-audit.ts`)の
 * 出典解決が黙って外れる。
 *
 * **`~` → `~0` を先、`/` → `~1` を後**にする。**逆にすると二重に化ける**
 * (`/` → `~1` の後で `~` → `~0` を掛けると `~01` になる)。
 *
 * **`src/kernel/referential-integrity.ts` に同じ実装(`escapePointerToken`)が在るが、
 * import しない** —— あちらは export されておらず、export を増やすと `Δ8` が発火する
 * (`ADR-0126` B5 / C4)。**同じ4行を2箇所が持つ重複を、公開面を増やさないために選んだ。**
 */
function escapePointer(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

/** `historical_*` の5グループ。 */
type HistoricalIdentifierSets = Pick<
  IdentifierSets,
  | "historical_table_id"
  | "historical_field_id"
  | "historical_view_id"
  | "historical_workflow_id"
  | "historical_function_id"
>;

/**
 * **changelog の `operations` に現れた識別子**の集合(ADR-0025 改訂2)。
 *
 * マニフェストの実在集合とは**別に**組み立てる —— 履歴が語るのは「当時そう書かれていた」
 * 識別子であり、消された・改名された・undo で巻き戻されたものは現在の集合に無い(§限界13)。
 *
 * **集めるのは、履歴節が実際に描く識別子ちょうどである**(下の一覧がその全部)。
 * 監査スクリプトは changelog を独立に読んで**この規則をそのまま再現できる**ので、
 * §4-6 の「生成器と集合構築を共有しない」は保たれる。
 *
 * **全エントリを見る**(生きている apply に絞らない)—— 履歴節は取り消された apply も
 * 「取り消された」と明示して残すため(§8-4)、その行の操作対象も描く必要がある。
 */
function historicalIdentifierSets(entries: readonly ChangelogEntry[]): HistoricalIdentifierSets {
  const tables = new Set<string>();
  const fields = new Set<string>();
  const views = new Set<string>();
  const workflows = new Set<string>();
  const functions = new Set<string>();

  for (const entry of entries) {
    for (const operation of entry.operations) {
      switch (operation.op) {
        case "add_table":
          tables.add(operation.table.id);
          for (const field of operation.table.fields) {
            fields.add(field.id);
          }
          break;
        case "remove_table":
          tables.add(operation.table);
          break;
        case "change_table":
          tables.add(operation.table);
          if (operation.changes.id !== undefined) {
            tables.add(operation.changes.id);
          }
          break;
        case "add_field":
          tables.add(operation.table);
          fields.add(operation.field.id);
          break;
        case "remove_field":
          tables.add(operation.table);
          fields.add(operation.field);
          break;
        case "change_field":
          tables.add(operation.table);
          fields.add(operation.field);
          if (operation.changes.id !== undefined) {
            fields.add(operation.changes.id);
          }
          break;
        case "add_view":
          views.add(operation.view.id);
          break;
        case "update_view":
        case "remove_view":
          views.add(operation.view);
          break;
        case "add_workflow":
        case "update_workflow":
          workflows.add(operation.workflow.id);
          break;
        case "remove_workflow":
          workflows.add(operation.workflow.id);
          break;
        case "add_function":
        case "update_function":
          functions.add(operation.function.id);
          break;
        case "remove_function":
          functions.add(operation.function.id);
          break;
        case "set_roles":
          // **V8-M16-T03(台帳 J-G1b。18種目の op)。識別子を1つも足さない。**
          // **`set_theme` / `set_user_kinds` とまったく同じ扱いである** —— 役割の一覧は
          // app に1つしか無く対象IDを取らないので、履歴節が描く `historical_*` の集合に
          // 足すものが無い。**宣言された役割の識別子(`owner` / `member` など)を
          // 集めない**のは意図的である —— **あれはテーブル・フィールド・ビュー・
          // ワークフロー・関数のどれでもなく、`identifiers` の5つの集合のどれにも
          // 属さない。****この switch は silent な1つである**(落としても tsc も
          // bun test も教えてくれない)。
          break;
        // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11` / `T-G12`。判定値 = 廃止】**
        // **ここに在った `case "set_user_kinds":`(識別子を1つも足さない silent な分岐)を
        // 取り除いた。** **`DIFF_OPS` から op が消えたためである。**
        // **`identifiers` の5つの集合は1つも増減していない。**
        case "set_theme":
          // **V3-M1-T03(ADR-0047。16種目の op)。識別子を1つも足さない。**
          // テーマは対象IDを取らない(app に1つしか無い)ので、履歴節が描く
          // `historical_*` の集合に足すものが無い。
          //
          // **`origin.template_app_id` を集めない**のは意図的である ——
          // あれは**別アプリのID**であり、しかも**カーネルはその実在を検証しない**
          // (ADR-0047 限定7。自己申告)。集めると、要件定義書が「検証していない他アプリの
          // 存在」を識別子として語ることになり、§4-6 の照合の前提(識別子は実在集合か
          // 履歴の集合に属する)が崩れる。**この switch は3箇所のうち silent な1つであり、
          // 落としても tsc も bun test も教えてくれない**(V3-M1-T03 の完了条件5)。
          break;
      }
    }
  }

  return {
    historical_table_id: tables,
    historical_field_id: fields,
    historical_view_id: views,
    historical_workflow_id: workflows,
    historical_function_id: functions,
  };
}

/**
 * 実在集合を組み立てる。
 *
 * **システムテーブル(`_apps` / `_changelog` / `_ai_usage`)の id と列を含める** ——
 * ビューは ADR-0006 の投影を対象に取れるため、含めないと実在する画面の定義で
 * fail-closed してしまう。
 *
 * **`capability_name` の実在集合は自己言及的である**(ADR-0025 §限界6)—— capability は
 * 人間専用ストアにあってマニフェストに現れないので、マニフェスト上の値そのものから作るしかない。
 * 照合できるのは「他のパスから来た値が混ざっていないこと」までである。
 */
function buildIdentifierSets(
  manifest: Manifest,
  entries: readonly ChangelogEntry[],
): IdentifierSets {
  const app = manifest.app;
  const workflows = app.workflows ?? [];
  const functions = app.functions ?? [];
  return {
    app_id: new Set([app.id]),
    table_id: new Set([...app.tables.map((t) => t.id), ...SYSTEM_TABLES.map((t) => t.id)]),
    field_id: new Set([
      ...app.tables.flatMap((t) => t.fields.map((f) => f.id)),
      ...SYSTEM_TABLES.flatMap((t) => t.fields.map((f) => f.id)),
      // `output: { ops: true }` の関数は出力フィールドを1つも持たない(ADR-0067)。
      ...functions.flatMap((f) => (f.output.fields ?? []).map((o) => o.id)),
    ]),
    view_id: new Set(app.views.map((v) => v.id)),
    workflow_id: new Set(workflows.map((w) => w.id)),
    function_id: new Set(functions.map((f) => f.id)),
    diff_id: new Set(entries.map((e) => e.diff_id)),
    applied_at: new Set(entries.map((e) => e.applied_at)),
    app_name: new Set([app.name]),
    table_name: new Set([...app.tables.map((t) => t.name), ...SYSTEM_TABLES.map((t) => t.name)]),
    field_name: new Set([
      ...app.tables.flatMap((t) => t.fields.map((f) => f.name)),
      ...SYSTEM_TABLES.flatMap((t) => t.fields.map((f) => f.name)),
    ]),
    view_name: new Set(app.views.flatMap((v) => (v.name === undefined ? [] : [v.name]))),
    workflow_name: new Set(workflows.map((w) => w.name)),
    function_name: new Set(functions.map((f) => f.name)),
    capability_name: new Set([
      ...functions.flatMap((f) => f.capabilities ?? []),
      ...actionCapabilityNames(workflows),
    ]),
    action_key_name: new Set(actionKeyNames(workflows)),
    field_group_name: new Set(fieldGroupNames(app.views)),
    escape_hatch_asset_name: new Set(escapeHatchAssetNames(app.views)),
    // **【`V8-M22`。台帳 `J-G34a` / `ADR-0315`】役割の識別子・表示名とボタンの識別子。**
    // **`roles` は省略可である**(`ADR-0302` / `$defs/app` の `required` に入っていない)——
    // **省略しているマニフェストでは3つとも空集合になり、文が1つも出ない。**
    // **【実測。誇張しない】** **`create_app` は既定3本(`owner` / `editor` / `viewer`)を
    // 必ず書き込む**(`src/kernel/create-app.ts:137`)ので、**今日ディスクに在るアプリで
    // `role_id` が空集合になるのは、`roles` を持たない古いマニフェストだけである。**
    role_id: new Set((app.roles ?? []).map((role) => role.id)),
    role_name: new Set(
      (app.roles ?? []).flatMap((role) => (role.name === undefined ? [] : [role.name])),
    ),
    view_action_id: new Set(viewActionIds(app.views)),
    ...historicalIdentifierSets(entries),
  };
}

/** 出力用に必ず明示ソートを通す(ADR-0025 §6)。 */
function toIdentifierLists(sets: IdentifierSets): RequirementIdentifiers {
  const groups = Object.keys(sets) as IdentifierGroup[];
  const out = {} as RequirementIdentifiers;
  for (const group of groups.sort()) {
    out[group] = [...sets[group]].sort();
  }
  return out;
}

// --- スロットの構築 ----------------------------------------------------------------

function idSlot(sets: IdentifierSets, group: IdentifierGroup, value: string): Slot {
  if (!sets[group].has(value)) {
    throw new Error(
      `要件定義書の生成を中止しました。${group} の "${value}" は、` +
        `マニフェストと変更履歴から作った実在集合に含まれていません。` +
        `実在しないものについて語らないため、黙って書かずに fail-closed します(ADR-0025 §5 辺3)。`,
    );
  }
  return { kind: "id", group, value };
}

/**
 * **【`V5-M17-T07` / `G-G8` / `ADR-0159`】第3引数を足した。**
 *
 * **`audience_role` の値域だけが「実装が持つ定数」から「アプリが宣言したデータ」へ変わった**
 * (`ADR-0159` 限定2)。**`VOCABULARIES.audience_role` は運営3ロール + `customer` +
 * `anonymous` の写しのままで、そこに宣言された種類を足すことはできない**(モジュール定数
 * なのでマニフェストを知らない)。**そこで呼び出し側が「そのアプリで追加で許される値」を
 * 渡す形にした。**
 *
 * **`extraAllowed` を渡さない呼び出しの答えは1つも変わらない**(既定は空)。
 * **`src/kernel/` の公開 export を1つも増やしていない**(`ADR-0159` 限定6)。
 *
 * **【誇張しない】** **これで fail-closed が弱くなった面がある** —— **宣言された種類は
 * `VOCABULARIES` の突き合わせを通らず、呼び出し側が渡した一覧との突き合わせだけを通る。**
 * **その一覧が間違っていれば、間違ったまま通る。**
 */
function termSlot(
  vocabulary: VocabularyGroup,
  value: string,
  extraAllowed: readonly string[] = [],
): Slot {
  if (!VOCABULARIES[vocabulary].includes(value) && !extraAllowed.includes(value)) {
    throw new Error(
      `要件定義書の生成を中止しました。語彙 ${vocabulary} に "${value}" は含まれていません。`,
    );
  }
  return { kind: "term", vocabulary, value };
}

/*
 * **【`V8-M20`。台帳 `J-G27` / `J-G28` / `ADR-0301`】`declaredUserKindIds` を撤去した。**
 *
 * **旧 JSDoc の逐語**: 「**そのマニフェストが宣言した利用者の種類の id**
 * (`V5-M17-T07` / `ADR-0158`)。**`Manifest` 型は `user_kinds` を持たない**
 * (`ADR-0158` 限定6 が `src/kernel/` に1バイトの差分も許さないので型に足せない)。
 * **型の外側から `unknown` として読む** —— **`src/server/owner-scope.ts` の
 * `declaredUserKinds` と同じ形である。****判定の本体を2箇所に持つことになる** ——
 * **カーネルはサーバを import できないので、ここは写しである。****写しであることを
 * 隠さない。**」
 *
 * **唯一の呼び出し元だった3本のテンプレート**(`screens.audience` /
 * `data.field_audience` / `data.field_writable_by`)**が撤去されたので、
 * 呼ぶ側が1つも無くなった。** **`src/server/owner-scope.ts` 側の `declaredUserKinds`
 * は本タスクの射程外であり、1バイトも触っていない**(写しが2箇所から1箇所になった
 * わけではなく、この生成器が読むのをやめただけである)。
 */

function numberSlot(value: number): Slot {
  return { kind: "number", value };
}

/** 出典の値をそのまま逐語引用にする。文字列以外は `String()` で写す。 */
function verbatimSlot(raw: unknown, source: StatementSource, field: string): Slot {
  return {
    kind: "verbatim",
    value: typeof raw === "string" ? raw : String(raw),
    from: { source, field },
  };
}

function manifestSource(pointer: string): StatementSource {
  return { kind: "manifest", pointer };
}

function entrySource(entry: ChangelogEntry, pointer: string): StatementSource {
  return { kind: "changelog", seq: entry.seq, diff_id: entry.diff_id, pointer };
}

/*
 * **【`V8-M20`。台帳 `J-G27` / `J-G28` / `ADR-0301`】`declaredRoles` を撤去した。**
 *
 * **旧 JSDoc の逐語**: 「`audience` / `writable_by` の宣言を読む(ADR-0126 A2 の
 * 1 / 10 / 11)。**この2キーは `src/kernel/types.ts` の `View` / `Field` に1つも現れない**
 * —— `ADR-0070` 限定5 / `ADR-0071` 限定6 / `ADR-0076` 限定7 が「`src/kernel/` に1バイトも
 * 差分を出さない」と定めたため、**スキーマにだけ在ってカーネルの型に無い**という非対称が
 * そのまま残っている。(…)**値が配列でない / 要素が文字列でないときは fail-closed で
 * throw する**(…)。**述べるのは宣言だけである**(…)。」
 *
 * **読む先の2キーがスキーマから消えたので、この関数を呼ぶ側は1つも残っていない。**
 * **同じ理由で `declaredUserKindIds`(`ADR-0159` 限定2 が `audience_role` の値域に
 * アプリ宣言の利用者種別を足すために置いたもの)も撤去した。**
 * **`termSlot` の第3引数 `extraAllowed` は残っている** —— **今日それを渡す呼び出しは
 * 1つも無い**(既定の空配列でしか呼ばれない)。**引数を消すのは `ADR-0159` の限定表の
 * 射程であり、本タスクは触らない。**
 */

// --- 帰属(ADR-0025 §8)-----------------------------------------------------------

/**
 * フィールドの帰属表のキー区切り。
 *
 * リソースIDは英小文字始まりの限られた文字種(システムテーブルは `_` 始まり)なので、
 * この文字が id に現れることは**構造的にありえない**。したがって
 * 「テーブルID + 区切り + フィールドID」が別の組と衝突しない。
 *
 * **エスケープ記法で書く(生の NUL バイトをソースに置かない)。**
 * `scripts/no-nul-bytes.test.ts` が禁じているとおりで、生の NUL は道具を静かに壊す
 * (`kernel-export-snapshot.txt` のヘッダが記録している ajv-error-adapter.ts の事故)。
 */
const FIELD_KEY_SEPARATOR = "\u0000";

function fieldKey(tableId: string, fieldId: string): string {
  return `${tableId}${FIELD_KEY_SEPARATOR}${fieldId}`;
}

type SourceMap = Map<string, StatementSource[]>;

type Attribution = {
  tables: SourceMap;
  fields: SourceMap;
  views: SourceMap;
  workflows: SourceMap;
  functions: SourceMap;
};

function push(map: SourceMap, key: string, source: StatementSource): void {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, [source]);
  } else {
    existing.push(source);
  }
}

/** テーブルの rename に、そのテーブルのフィールドの別名も追随させる(ADR-0025 §8-3)。 */
function renameTableKeys(attribution: Attribution, oldId: string, newId: string): void {
  const moved = attribution.tables.get(oldId);
  attribution.tables.delete(oldId);
  if (moved !== undefined) {
    attribution.tables.set(newId, moved);
  }
  const prefix = `${oldId}${FIELD_KEY_SEPARATOR}`;
  for (const [key, value] of [...attribution.fields]) {
    if (key.startsWith(prefix)) {
      attribution.fields.delete(key);
      attribution.fields.set(fieldKey(newId, key.slice(prefix.length)), value);
    }
  }
}

function dropTableKeys(attribution: Attribution, tableId: string): void {
  attribution.tables.delete(tableId);
  const prefix = `${tableId}${FIELD_KEY_SEPARATOR}`;
  for (const key of [...attribution.fields.keys()]) {
    if (key.startsWith(prefix)) {
      attribution.fields.delete(key);
    }
  }
}

/** 1操作を別名表と帰属表に反映する。 */
function foldOperationIntoAttribution(
  attribution: Attribution,
  operation: Operation,
  source: StatementSource,
): void {
  switch (operation.op) {
    case "add_table":
      push(attribution.tables, operation.table.id, source);
      for (const field of operation.table.fields) {
        push(attribution.fields, fieldKey(operation.table.id, field.id), source);
      }
      return;
    case "change_table":
      push(attribution.tables, operation.table, source);
      if (operation.changes.id !== undefined && operation.changes.id !== operation.table) {
        renameTableKeys(attribution, operation.table, operation.changes.id);
      }
      return;
    case "remove_table":
      dropTableKeys(attribution, operation.table);
      return;
    case "add_field":
      push(attribution.fields, fieldKey(operation.table, operation.field.id), source);
      return;
    case "change_field": {
      const key = fieldKey(operation.table, operation.field);
      push(attribution.fields, key, source);
      const renamed = operation.changes.id;
      if (renamed !== undefined && renamed !== operation.field) {
        const moved = attribution.fields.get(key);
        attribution.fields.delete(key);
        if (moved !== undefined) {
          attribution.fields.set(fieldKey(operation.table, renamed), moved);
        }
      }
      return;
    }
    case "remove_field":
      attribution.fields.delete(fieldKey(operation.table, operation.field));
      return;
    case "add_view":
      push(attribution.views, operation.view.id, source);
      return;
    case "update_view":
      push(attribution.views, operation.view, source);
      return;
    case "remove_view":
      attribution.views.delete(operation.view);
      return;
    case "add_workflow":
    case "update_workflow":
      push(attribution.workflows, operation.workflow.id, source);
      return;
    case "remove_workflow":
      attribution.workflows.delete(operation.workflow.id);
      return;
    case "add_function":
    case "update_function":
      push(attribution.functions, operation.function.id, source);
      return;
    case "remove_function":
      attribution.functions.delete(operation.function.id);
      return;
    case "set_roles":
      // **V8-M16-T03(台帳 J-G1b。18種目の op)。帰属表に1件も足さない。**
      // 帰属表が持つのは tables / fields / views / workflows / functions の5つで、
      // **役割の宣言はそのどれでもない**(リソース種を増やしていない)。
      // **要件定義書は宣言の内容を1文も述べない**ので、出典を付ける先そのものが無い。
      // **この switch も silent な1つである。**
      return;
    // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11` / `T-G12`。判定値 = 廃止】**
    // **ここに在った `case "set_user_kinds":` を取り除いた。** **`DIFF_OPS` から op が
    // 消えたためである。** **帰属表が持つ5つの集合は1つも増減していない。**
    case "set_theme":
      // **V3-M1-T03(ADR-0047。16種目の op)。帰属表に1件も足さない。**
      // 帰属表が持つのは tables / fields / views / workflows / functions の5つで、
      // **テーマはそのどれでもない**(リソース種を増やしていない = ADR-0047 限定4)。
      // **要件定義書はテーマの内容を1文も述べない**(テンプレートを足していないため。
      // 述べるなら ADR-0025 §3 の閉じた union にテンプレートを足す判断が要る)ので、
      // 出典を付ける先そのものが無い。**この switch も silent な1つである** ——
      // 書き忘れても黙って無視され、帰属表に出典が付かないだけになる。
      // **述べていないことは、述べていないと記録に書いた**(v3-m1-t03a.md の限界)。
      return;
  }
}

/**
 * 帰属表を組み立てる。
 *
 * **使う条件は `kind === "apply"` かつ「どの undo からも指されていない」の2つだけである。**
 * `snapshot !== null` は**使わない**(ADR-0025 §8-2)—— 巻き戻し先が無いことは
 * 「undo できない」を意味するだけで、その apply が起きなかったことを意味しない。
 * `snapshot === null` の apply は `create_app` が書く第0行(V1-M0-T05 / F-28)であり、
 * **アプリが作られたという最も重要な事実そのもの**である。ここに `snapshot !== null` を
 * 混ぜると overview 節の出典が丸ごと消える。
 *
 * 走査は `seq` 昇順で、rename は別名表として追随させる(§8-3)。
 */
function buildAttribution(
  entries: readonly ChangelogEntry[],
  undone: ReadonlySet<number>,
): Attribution {
  const attribution: Attribution = {
    tables: new Map(),
    fields: new Map(),
    views: new Map(),
    workflows: new Map(),
    functions: new Map(),
  };
  for (const entry of entries) {
    if (entry.kind !== "apply" || undone.has(entry.seq)) {
      continue;
    }
    entry.operations.forEach((operation, index) => {
      foldOperationIntoAttribution(
        attribution,
        operation,
        entrySource(entry, `/operations/${index}`),
      );
    });
  }
  return attribution;
}

// --- statement の組み立て ----------------------------------------------------------

type DraftStatement = Omit<RequirementStatement, "id">;

type Context = {
  manifest: Manifest;
  entries: ChangelogEntry[];
  sets: IdentifierSets;
  undone: ReadonlySet<number>;
  attribution: Attribution;
};

/**
 * 1記述を作る。**`first` を必須引数に取ることで、出典の非空性を呼び出し形で強制する**
 * (`sources` の型が非空タプルであることの、実装側の対応物)。
 */
function draft(
  section: RequirementSection,
  template: RequirementTemplateId,
  slots: Record<string, Slot>,
  first: StatementSource,
  rest: StatementSource[] = [],
): DraftStatement {
  return {
    section,
    template,
    slots,
    text: renderStatementText(template, slots),
    sources: [first, ...rest],
  };
}

function attributionOf(map: SourceMap, key: string): StatementSource[] {
  return map.get(key) ?? [];
}

function overviewStatements(ctx: Context): DraftStatement[] {
  const app = ctx.manifest.app;
  const out: DraftStatement[] = [
    draft(
      "overview",
      "overview.identity",
      {
        app_id: idSlot(ctx.sets, "app_id", app.id),
        app_name: idSlot(ctx.sets, "app_name", app.name),
      },
      manifestSource("/app/id"),
      [manifestSource("/app/name")],
    ),
  ];

  // 第0行は `snapshot === null` だが、帰属からは落ちない(§8-2)。
  const created = ctx.entries.find(
    (entry) =>
      entry.kind === "apply" && !ctx.undone.has(entry.seq) && entry.diff_id === CREATE_APP_DIFF_ID,
  );
  if (created !== undefined) {
    out.push(
      draft(
        "overview",
        "overview.created",
        {
          seq: numberSlot(created.seq),
          diff_id: idSlot(ctx.sets, "diff_id", created.diff_id),
          applied_at: idSlot(ctx.sets, "applied_at", created.applied_at),
        },
        entrySource(created, ""),
      ),
    );
  }

  out.push(
    draft(
      "overview",
      "overview.scale",
      {
        table_count: numberSlot(app.tables.length),
        view_count: numberSlot(app.views.length),
        workflow_count: numberSlot((app.workflows ?? []).length),
        function_count: numberSlot((app.functions ?? []).length),
      },
      manifestSource("/app"),
    ),
  );
  return out;
}

function featureStatements(ctx: Context): DraftStatement[] {
  const app = ctx.manifest.app;
  const out: DraftStatement[] = [];
  app.tables.forEach((table, index) => {
    out.push(
      draft(
        "features",
        "features.table",
        {
          table_id: idSlot(ctx.sets, "table_id", table.id),
          table_name: idSlot(ctx.sets, "table_name", table.name),
        },
        manifestSource(`/app/tables/${index}`),
        attributionOf(ctx.attribution.tables, table.id),
      ),
    );
  });
  app.views.forEach((view, index) => {
    out.push(
      draft(
        "features",
        "features.view",
        {
          view_id: idSlot(ctx.sets, "view_id", view.id),
          view_type: termSlot("view_type", view.type),
        },
        manifestSource(`/app/views/${index}`),
        attributionOf(ctx.attribution.views, view.id),
      ),
    );
  });
  (app.workflows ?? []).forEach((workflow, index) => {
    out.push(
      draft(
        "features",
        "features.workflow",
        {
          workflow_id: idSlot(ctx.sets, "workflow_id", workflow.id),
          workflow_name: idSlot(ctx.sets, "workflow_name", workflow.name),
        },
        manifestSource(`/app/workflows/${index}`),
        attributionOf(ctx.attribution.workflows, workflow.id),
      ),
    );
  });
  (app.functions ?? []).forEach((fn, index) => {
    out.push(
      draft(
        "features",
        "features.function",
        {
          function_id: idSlot(ctx.sets, "function_id", fn.id),
          function_name: idSlot(ctx.sets, "function_name", fn.name),
        },
        manifestSource(`/app/functions/${index}`),
        attributionOf(ctx.attribution.functions, fn.id),
      ),
    );
  });
  out.push(...roleStatements(ctx));
  return out;
}

/**
 * 役割の条件(`app.roles[].rules[].when`)を**前順走査でノードごとに1文**へ平坦化する
 * (`V8-M22` / 台帳 `J-G34a` / ユーザ決定 `D-V8-36` / `ADR-0315`)。
 *
 * **形は `filterNodeStatements`(`ADR-0068` B群)と同じである** —— **前順の訪問列と各ノードの
 * 深さの列があれば木は一意に復元できるので、5種目のスロットも `verbatim` の構造値対応も
 * 要らない。** **深度上限も `MAX_FILTER_DEPTH` を共有する**(生成器に第2の上限を作らない。
 * `referential-integrity.ts` の類型16 の補遺が適用時に同じ上限で拒否している)。
 *
 * **【`filterNodeStatements` と統合しなかった理由】** **あちらの葉は5種
 * (`equals` / `contains` / `gte` / `lte` / `in`)、こちらの葉は2種
 * (`equals` / `equals_current_user`)であり、テンプレートIDも文面も違う。**
 * **「絞り込み」と「権限の条件」を1つの関数に畳むと、どちらかの語彙が増えたときに
 * もう一方の文面が黙って変わる。** **同じ形を2箇所が持つ重複を、そちらの危うさより選んだ。**
 *
 * **【正直に書く】評価は1バイトも行わない。** **述べるのは「そう宣言している」までである。**
 */
function roleConditionStatements(
  ctx: Context,
  roleId: string,
  rulePosition: number,
  node: RoleCondition,
  pointer: string,
  depth: number,
  counter: { next: number },
): DraftStatement[] {
  if (depth > MAX_FILTER_DEPTH) {
    throw new Error(
      `要件定義書の生成を中止しました。役割 "${roleId}" の ${rulePosition} 番目の規則の条件の` +
        `ネストが深すぎます(深度上限 ${MAX_FILTER_DEPTH} 段)。黙って切り詰めると、述べた条件と` +
        `述べていない条件が同じ文書の中で混ざるため fail-closed します(ADR-0068 B3 と同じ作法)。`,
    );
  }
  const source = manifestSource(pointer);
  const nodePosition = counter.next;
  counter.next += 1;
  const common = {
    role_id: idSlot(ctx.sets, "role_id", roleId),
    position: numberSlot(rulePosition),
    node_position: numberSlot(nodePosition),
    depth: numberSlot(depth),
  };

  if ("and" in node || "or" in node) {
    const key = "and" in node ? "and" : "or";
    const children = "and" in node ? node.and : node.or;
    return [
      draft(
        "features",
        key === "and" ? "features.role_condition_and" : "features.role_condition_or",
        common,
        source,
      ),
      ...children.flatMap((child, index) =>
        roleConditionStatements(
          ctx,
          roleId,
          rulePosition,
          child,
          `${pointer}/${key}/${index}`,
          depth + 1,
          counter,
        ),
      ),
    ];
  }
  if ("not" in node) {
    return [
      draft("features", "features.role_condition_not", common, source),
      ...roleConditionStatements(
        ctx,
        roleId,
        rulePosition,
        node.not,
        `${pointer}/not`,
        depth + 1,
        counter,
      ),
    ];
  }

  // 葉は2種ちょうど(`ADR-0306` / 台帳 `J-G13`)。**定数の値は解釈せず逐語引用で写す。**
  //
  // **【`V8-M26` / `D-V8-70`。直前の1行の「2種ちょうど」は今日は偽である。
  // 旧文を1バイトも消していない】** **葉は3種で、3つ目は `{field, is_empty}` である。**
  const field_id = idSlot(ctx.sets, "field_id", node.field);
  if ("is_empty" in node) {
    return [draft("features", "features.role_condition_is_empty", { ...common, field_id }, source)];
  }
  if ("equals_current_user" in node) {
    return [
      draft(
        "features",
        "features.role_condition_equals_current_user",
        { ...common, field_id },
        source,
      ),
    ];
  }
  return [
    draft(
      "features",
      "features.role_condition_equals",
      { ...common, field_id, value: verbatimSlot(node.equals, source, "equals") },
      source,
    ),
  ];
}

/**
 * 役割1本ぶんの記述(名前・できること・条件)。
 *
 * **`V8-M22` / 台帳 `J-G34a` / ユーザ決定 `D-V8-36`(2026-08-10)/ `ADR-0315`。**
 *
 * **出すのは3つに閉じる**: (1) 役割の名前(`id` と `name`)/ (2) その役割ができること
 * (`rules` の 対象4種 × 動詞3語)/ (3) 条件(`when`)。**4つ目を足さない。**
 *
 * **【出さないもの。書き忘れではない】** **役割の付与状況(誰がその役割を持っているか)は
 * 1文字も出ない** —— **それはアプリの定義ではなく利用者のデータである**
 * (`_auth_users.role` の行の中身)。**この生成器はマニフェストと changelog しか読まない**
 * (`ADR-0025` §5 辺5)ので、**構造的に出しようがない。**
 *
 * **【正直に書く。丸めない】**
 * - **`set_roles` の changelog 帰属を持たない** —— **出典は `/app/roles/...` の
 *   JSON Pointer 1本だけである。** **`Attribution` は表・画面・自動化・関数の4つしか
 *   持っておらず、役割を足すには型を増やすことになる**(`ADR-0315` の限界に書いた)。
 * - **既定の3役割(`owner` / `editor` / `viewer`)は `create_app` が必ず書き込む** ——
 *   **`set_roles` を1度も呼んでいないアプリの生成物も、本単位で3文増える。**
 * - **面(この規則)と点(`table.access_control` の付与)がどう重なるかを1文も出さない。**
 */
function roleStatements(ctx: Context): DraftStatement[] {
  const out: DraftStatement[] = [];
  (ctx.manifest.app.roles ?? []).forEach((role, roleIndex) => {
    const base = `/app/roles/${roleIndex}`;
    const roleIdSlot = () => idSlot(ctx.sets, "role_id", role.id);
    out.push(draft("features", "features.role", { role_id: roleIdSlot() }, manifestSource(base)));
    if (role.name !== undefined) {
      out.push(
        draft(
          "features",
          "features.role_name",
          { role_id: roleIdSlot(), role_name: idSlot(ctx.sets, "role_name", role.name) },
          manifestSource(`${base}/name`),
        ),
      );
    }
    (role.rules ?? []).forEach((rule, ruleIndex) => {
      const rulePath = `${base}/rules/${ruleIndex}`;
      const position = () => numberSlot(ruleIndex + 1);
      /*
       * **【`V8-M26` / `D-V8-66`(2026-08-10)】実在しない先を指す規則は1文も書かない。**
       *
       * **`D-V8-66` が `src/kernel/referential-integrity.ts` の類型16(役割の規則が指す先の
       * 実在)を撤去したので、`remove_view` / `remove_table` の後に「消えた画面・表を名指し
       * したままの規則」がマニフェストに残る。** **それを素直に `idSlot` へ渡すと、実在集合に
       * 無い識別子なので生成が fail-closed で止まる**(`ADR-0025` §5 辺3)——
       * **画面を1枚消しただけで要件定義書が二度と出せなくなる。**
       *
       * **ここで落とすのは「語らない」であって「黙って嘘を書く」ではない** ——
       * **`ADR-0025` §5 辺3 の「実在しないものについて語らない」を、止める代わりに
       * 沈黙で履行する。** **`historical_view_id` 系(履歴節)は1バイトも触っていないので、
       * 「いつ何を消したか」は履歴節に今日どおり残る。**
       *
       * **【誇張しない】残った規則の行そのものは、生成物のどこにも出ない。**
       * **`get_manifest` で `app.roles` を見た人だけが、存在しない画面の名前を目にする**
       * (`D-V8-66` の説明文が言っているとおり)。**塞いでいない。**
       */
      const missing =
        (rule.table !== undefined && !ctx.sets.table_id.has(rule.table)) ||
        (rule.field !== undefined && !ctx.sets.field_id.has(rule.field)) ||
        (rule.view !== undefined && !ctx.sets.view_id.has(rule.view)) ||
        (rule.action !== undefined && !ctx.sets.view_action_id.has(rule.action));
      if (missing) {
        return;
      }
      /*
       * **動詞1語につき1文である**(`can` は列挙なので、1つの規則が最大3文を生む)。
       * **「できないこと」の文は1本も無い** —— **`can` に書ける値が「できること」だけで、
       * 値域に否定が1つも無いためである**(台帳 `J-G2` の限定)。
       * **スキーマの `allOf` が対象ごとに動詞を絞っているので、ここで組み合わせを
       * 作り直さない** —— **書けない組(画面に `write` など)はディスクに載らない。**
       */
      for (const verb of rule.can) {
        if (rule.target === "table" && rule.table !== undefined) {
          const template: RequirementTemplateId =
            verb === "read"
              ? "features.role_rule_table_read"
              : verb === "write"
                ? "features.role_rule_table_write"
                : "features.role_rule_table_delete";
          out.push(
            draft(
              "features",
              template,
              {
                role_id: roleIdSlot(),
                position: position(),
                table_id: idSlot(ctx.sets, "table_id", rule.table),
              },
              manifestSource(rulePath),
            ),
          );
          continue;
        }
        if (rule.target === "field" && rule.table !== undefined && rule.field !== undefined) {
          out.push(
            draft(
              "features",
              verb === "read" ? "features.role_rule_field_read" : "features.role_rule_field_write",
              {
                role_id: roleIdSlot(),
                position: position(),
                table_id: idSlot(ctx.sets, "table_id", rule.table),
                field_id: idSlot(ctx.sets, "field_id", rule.field),
              },
              manifestSource(rulePath),
            ),
          );
          continue;
        }
        if (rule.target === "view" && rule.view !== undefined) {
          out.push(
            draft(
              "features",
              "features.role_rule_view_read",
              {
                role_id: roleIdSlot(),
                position: position(),
                view_id: idSlot(ctx.sets, "view_id", rule.view),
              },
              manifestSource(rulePath),
            ),
          );
          continue;
        }
        if (rule.target === "action" && rule.view !== undefined && rule.action !== undefined) {
          out.push(
            draft(
              "features",
              "features.role_rule_action_read",
              {
                role_id: roleIdSlot(),
                position: position(),
                view_id: idSlot(ctx.sets, "view_id", rule.view),
                view_action_id: idSlot(ctx.sets, "view_action_id", rule.action),
              },
              manifestSource(rulePath),
            ),
          );
        }
      }
      if (rule.when !== undefined) {
        out.push(
          ...roleConditionStatements(
            ctx,
            role.id,
            ruleIndex + 1,
            rule.when,
            `${rulePath}/when`,
            0,
            { next: 1 },
          ),
        );
      }
    });
  });
  return out;
}

/**
 * ブール式 filter(`FilterNode`)を**前順走査でノードごとに1文**へ平坦化する
 * (ADR-0068 B群。`V3-M11-G2` = 限定採用)。
 *
 * **なぜ平坦化で足りるのか**: 前順の訪問列と各ノードの深さの列があれば、木は**一意に
 * 復元できる**。したがって5種目のスロット(パス文字列など)も、`verbatim` を構造値へ
 * 広げること(JSON 直列化)も要らない —— `ADR-0025` 限定7 とその §5 辺3 を1バイトも
 * 緩めずに木を述べられる(ADR-0068 §2 / C2 / C3)。
 *
 * **深度上限は `MAX_FILTER_DEPTH` を共有する**(B3)。上限を超える木に出会ったら
 * **黙って落とさず fail-closed で throw する** —— 静かに切り詰めると「述べた」と
 * 「述べていない」が同じ文書の中で混ざり、読み手が区別できない(`ADR-0025` §4-5 と同じ作法)。
 *
 * `counter` は前順の通し番号(1始まり)を持ち回るための可変の入れ物である。
 */
function filterNodeStatements(
  ctx: Context,
  view: View,
  node: FilterNode,
  pointer: string,
  depth: number,
  counter: { next: number },
  attributed: StatementSource[],
): DraftStatement[] {
  if (depth > MAX_FILTER_DEPTH) {
    throw new Error(
      `要件定義書の生成を中止しました。画面 "${view.id}" の絞り込み条件のネストが深すぎます` +
        `(深度上限 ${MAX_FILTER_DEPTH} 段)。黙って切り詰めると、述べた条件と述べていない条件が` +
        `同じ文書の中で混ざるため fail-closed します(ADR-0068 B3)。`,
    );
  }
  const source = manifestSource(pointer);
  const position = counter.next;
  counter.next += 1;
  const common = {
    view_id: idSlot(ctx.sets, "view_id", view.id),
    position: numberSlot(position),
    depth: numberSlot(depth),
  };

  if ("and" in node || "or" in node) {
    const key = "and" in node ? "and" : "or";
    const children = ("and" in node ? node.and : node.or) as FilterNode[];
    return [
      draft(
        "screens",
        key === "and" ? "screens.filter_and" : "screens.filter_or",
        common,
        source,
        attributed,
      ),
      ...children.flatMap((child, index) =>
        filterNodeStatements(
          ctx,
          view,
          child,
          `${pointer}/${key}/${index}`,
          depth + 1,
          counter,
          attributed,
        ),
      ),
    ];
  }
  if ("not" in node) {
    return [
      draft("screens", "screens.filter_not", common, source, attributed),
      ...filterNodeStatements(
        ctx,
        view,
        node.not,
        `${pointer}/not`,
        depth + 1,
        counter,
        attributed,
      ),
    ];
  }

  // 葉述語(有限5種。ADR-0043 限定1)。**値は解釈せず逐語引用で写す。**
  const field_id = idSlot(ctx.sets, "field_id", node.field);
  if ("in" in node) {
    return [
      draft(
        "screens",
        "screens.filter_in",
        { ...common, field_id, value_count: numberSlot(node.in.length) },
        source,
        attributed,
      ),
      // **列挙は statement を1件ずつ生む**(ADR-0025 限定7)。配列スロットを作らない。
      ...node.in.map((value, index) =>
        draft(
          "screens",
          "screens.filter_in_value",
          {
            view_id: idSlot(ctx.sets, "view_id", view.id),
            position: numberSlot(position),
            value_position: numberSlot(index + 1),
            value: verbatimSlot(value, manifestSource(`${pointer}/in/${index}`), `${index}`),
          },
          manifestSource(`${pointer}/in/${index}`),
          attributed,
        ),
      ),
    ];
  }
  const leaf: [RequirementTemplateId, unknown] =
    "equals" in node
      ? ["screens.filter_equals", node.equals]
      : "contains" in node
        ? ["screens.filter_contains", node.contains]
        : "gte" in node
          ? ["screens.filter_gte", node.gte]
          : ["screens.filter_lte", node.lte];
  const operatorKey = leaf[0].slice("screens.filter_".length);
  return [
    draft(
      "screens",
      leaf[0],
      { ...common, field_id, value: verbatimSlot(leaf[1], source, operatorKey) },
      source,
      attributed,
    ),
  ];
}

/**
 * **集計表(`report_view`)の中身の記述**(`V8-M13-T03`。台帳 `Q-G31a` / `Q-G31b`)。
 *
 * **出す順は宣言の順である** —— **突き合わせ → 束ねるキー → 集計 → グラフ。**
 * **`report.join` を先に出すのは、それが母集団を決めるからである**(`ReportJoin` の
 * JSDoc: 「宣言の順序が評価の順序である」)。**並べ替えの判断を1つも持たない** ——
 * **`ADR-0025` §6 の決定論は「マニフェストに書かれた順」で満たす。**
 *
 * **【`_id` を `field_id` の実在集合に照合しない】** **`group_by[].field` には予約された
 * 行の番号 `_id` を書ける**(`ReportGroupBy.field` の追記。ユーザ決定 `D-V8-126`)が、
 * **`_id` はどの表の `fields` にも現れないので実在集合に入っていない。**
 * **素直に `idSlot` へ渡すと、実在する宣言について語ろうとしただけで生成が
 * fail-closed で止まる**(`ADR-0025` §5 辺3)。**そこで `_id` だけを別のテンプレート
 * (`screens.report_group_by_row`)へ分けた** —— **実在集合を1件も広げていない**
 * (広げると `_id` が「フィールド」として他の文にも現れうる)。
 *
 * **【`sum` に列が無い宣言は fail-closed で止める】** **スキーマの `required` は
 * `["type"]` だけなので、形の上では `{type: "sum"}` が書ける** —— **止めるのは
 * `src/kernel/referential-integrity.ts` であって JSON Schema ではない。**
 * **その検査を通っていないマニフェストが手元に在ったとき、合計の対象を伏せた文を
 * 黙って出さない**(`ADR-0025` §5 辺3 と同じ倒し方。**厳しすぎる側に外れる**)。
 */
function pushReportStatements(
  ctx: Context,
  view: Extract<View, { type: "report_view" }>,
  base: string,
  attributed: StatementSource[],
  viewIdSlot: () => Slot,
  out: DraftStatement[],
): void {
  const report = view.report;
  const reportBase = `${base}/report`;

  (report.join ?? []).forEach((join, index) => {
    out.push(
      draft(
        "screens",
        "screens.report_join",
        {
          view_id: viewIdSlot(),
          position: numberSlot(index + 1),
          table_id: idSlot(ctx.sets, "table_id", join.table),
          field_id: idSlot(ctx.sets, "field_id", join.via),
        },
        manifestSource(`${reportBase}/join/${index}`),
        attributed,
      ),
    );
  });

  report.group_by.forEach((groupBy, index) => {
    const position = () => numberSlot(index + 1);
    const source = manifestSource(`${reportBase}/group_by/${index}`);
    out.push(
      groupBy.field === "_id"
        ? draft(
            "screens",
            "screens.report_group_by_row",
            { view_id: viewIdSlot(), position: position() },
            source,
            attributed,
          )
        : draft(
            "screens",
            "screens.report_group_by",
            {
              view_id: viewIdSlot(),
              position: position(),
              field_id: idSlot(ctx.sets, "field_id", groupBy.field),
            },
            source,
            attributed,
          ),
    );
    if (groupBy.table !== undefined) {
      out.push(
        draft(
          "screens",
          "screens.report_group_by_table",
          {
            view_id: viewIdSlot(),
            position: position(),
            table_id: idSlot(ctx.sets, "table_id", groupBy.table),
          },
          manifestSource(`${reportBase}/group_by/${index}/table`),
          attributed,
        ),
      );
    }
    if (groupBy.granularity !== undefined) {
      out.push(
        draft(
          "screens",
          GRANULARITY_TEMPLATES[groupBy.granularity],
          { view_id: viewIdSlot(), position: position() },
          manifestSource(`${reportBase}/group_by/${index}/granularity`),
          attributed,
        ),
      );
    }
  });

  report.aggregates.forEach((aggregate, index) => {
    const position = () => numberSlot(index + 1);
    const source = manifestSource(`${reportBase}/aggregates/${index}`);
    if (aggregate.type === "sum") {
      if (aggregate.field === undefined) {
        throw new Error(
          `要件定義書の生成を中止しました。画面 "${view.id}" の ${index + 1} 番目の集計は ` +
            `合計(sum)ですが、合計する列が書かれていません。` +
            `何の合計かを伏せた文を出さないため、黙って書かずに fail-closed します(ADR-0025 §5 辺3)。`,
        );
      }
      out.push(
        draft(
          "screens",
          "screens.report_aggregate_sum",
          {
            view_id: viewIdSlot(),
            position: position(),
            field_id: idSlot(ctx.sets, "field_id", aggregate.field),
          },
          source,
          attributed,
        ),
      );
    } else {
      out.push(
        draft(
          "screens",
          "screens.report_aggregate_count",
          { view_id: viewIdSlot(), position: position() },
          source,
          attributed,
        ),
      );
    }
    if (aggregate.table !== undefined) {
      out.push(
        draft(
          "screens",
          "screens.report_aggregate_table",
          {
            view_id: viewIdSlot(),
            position: position(),
            table_id: idSlot(ctx.sets, "table_id", aggregate.table),
          },
          manifestSource(`${reportBase}/aggregates/${index}/table`),
          attributed,
        ),
      );
    }
  });

  if (report.chart !== undefined) {
    out.push(
      draft(
        "screens",
        CHART_TEMPLATES[report.chart],
        { view_id: viewIdSlot() },
        manifestSource(`${reportBase}/chart`),
        attributed,
      ),
    );
  }
}

/**
 * ビュー1つぶんの記述(種別・対象・表示名・列/項目・並び順・絞り込み・関連一覧・操作起点)。
 *
 * **【2026-08-04。`V4-M39-T01` / `ADR-0144` D7 による更新。旧記述は事実でなくなった】**
 * **文を出すのは `$defs/view` の28キー全部である。** 旧記述は「10キーである」と書いていたが、
 * それは `ADR-0068` の実装時点の数であり、`ADR-0126`(14キー)と `ADR-0144` / `ADR-0145`
 * (10キー)がその後に足した。**「書けるのに1文も出ない」キーは今日0本である。**
 * **`related`(ADR-0044)と `actions`(ADR-0045)は ADR-0068 A6 で足した** ——
 * v2 から2つのマイルストーンを越えて0文のままだったものである。
 * **プリセット9キー(ADR-0050 限界8 / ADR-0093 / ADR-0118)と `custom_css`
 * (ADR-0055 限定14)は、`ADR-0068` 共通10 / `ADR-0126` B1 が名指しで「足さない」と定めて
 * いたが、門A の本審査(`V4-M39-G1` / `G2` / `G3` = いずれも限定採用)がそれを覆した。**
 * **覆っていないのはテーマ25スロットだけである**(`ADR-0144` B1)。
 *
 * **述べるのは「そう宣言している」ことまでである** —— **宣言と描画は一致するとは限らない**
 * (`ADR-0144` A4 / C9 / `ADR-0145` A6 / C1)。
 *
 * **この判断は黙って落ちない。** view のキーは判別共用体ではないので changelog の op 側の
 * ような `const exhaustive: never` を置けないため、**`src/kernel/requirements-doc.test.ts` の
 * 「view のキーのうち要件ドキュメントに文を出すものの集合」**が、スキーマの
 * `$defs/view.properties` と「出す/出さない」の表を突き合わせて固定している。
 * **`$defs/view` に29個目のキーが増えると、判断を書くまでそのテストが赤いままになる。**
 */
function viewStatements(ctx: Context, view: View, index: number): DraftStatement[] {
  const base = `/app/views/${index}`;
  const attributed = attributionOf(ctx.attribution.views, view.id);
  const viewIdSlot = () => idSlot(ctx.sets, "view_id", view.id);
  const out: DraftStatement[] = [
    draft(
      "screens",
      "screens.target",
      {
        view_id: viewIdSlot(),
        view_type: termSlot("view_type", view.type),
        table_id: idSlot(ctx.sets, "table_id", view.table),
      },
      manifestSource(`${base}/table`),
      attributed,
    ),
  ];
  if (view.name !== undefined) {
    out.push(
      draft(
        "screens",
        "screens.display_name",
        {
          view_id: viewIdSlot(),
          view_name: idSlot(ctx.sets, "view_name", view.name),
        },
        manifestSource(`${base}/name`),
        attributed,
      ),
    );
  }

  /*
   * **【`V8-M20`。台帳 `J-G27` / `ADR-0301`】`view.audience` の発火をここから撤去した。**
   *
   * **旧記述の逐語**: 「ADR-0126 A2 の 1(`view.audience`。`B-G1` / `ADR-0070` +
   * `ADR-0074`)。**3種すべてに書ける**ので型で分岐しない。**列挙は statement を1件ずつ
   * 生む**(`ADR-0025` 限定7)—— 配列スロットを作らない。**述べるのは「そう宣言して
   * いる」ことまでである**(A4)。」
   *
   * **`$defs/view/properties/audience` そのものが `V8-M20` で廃止された** ——
   * 画面を誰に見せるかは `app.roles[].rules`(対象 `view`・動詞 `read`)へ移った。
   * **その `rules` を述べるテンプレートを本タスクは1本も足していない** ——
   * **したがって今日の要件ドキュメントは、権限について1文も書かない。**
   */

  /*
   * ADR-0126 A2 の 2(`view.menu_listed`。`E-G12` / `ADR-0084`)。
   *
   * **真偽それぞれ1文**(既存の `data.field_required` / `data.field_optional` と同型)。
   * **書かなかった画面については1文も出さない**(A3)—— 既定は「並ぶ」だが、それは
   * 実装の既定であってアプリの宣言ではない。**既定値を推測して文を出さない。**
   */
  if (view.menu_listed !== undefined) {
    out.push(
      draft(
        "screens",
        view.menu_listed ? "screens.menu_listed" : "screens.menu_unlisted",
        { view_id: viewIdSlot() },
        manifestSource(`${base}/menu_listed`),
        attributed,
      ),
    );
  }

  /*
   * ADR-0144 A2 の `preset_density`(単位B。`P-G32` / `ADR-0118`)。
   *
   * **3種すべてに書ける2キーのうちの1つ**なので型で分岐しない。**入力フォーム(form)の
   * 見せ方が要件定義書に現れるのは、この製品でここが初めてである。**
   * **書かれていなければ1文も出さない**(A3。既定値を推測しない)。
   *
   * **【`V8-M8` による追記。上の「3種すべてに書ける」は今日は偽である。旧文を1バイトも
   * 書き換えていない】** **画面種別は4種になり、4種目の集計表(`report_view`)には
   * `preset_density` を書けない**(`schemas/manifest.schema.json` の `allOf` の
   * `report_view` 分岐が `false` で閉じている)。**「型で分岐しない」という作法は
   * 保てなくなったので、集計表だけを外す1語を足してある。**
   */
  if (view.type !== "report_view" && view.preset_density !== undefined) {
    out.push(
      draft(
        "screens",
        "screens.preset_density",
        { view_id: viewIdSlot(), density: termSlot("density", view.preset_density) },
        manifestSource(`${base}/preset_density`),
        attributed,
      ),
    );
  }

  /*
   * ADR-0145 A1(`view.custom_css`。`D-G5` / `ADR-0055`)。**3種すべてに書ける。**
   *
   * **出すのは名前と中身の目印の2要素だけである**(A2)—— **CSS のバイト列を1バイトも
   * 読まない**(A3 / B1。憲法1)。**資産の実在を照合しない。fail-closed しない**(A7)。
   * **作用域を1文も出さない**(B3。owner が発行時に宣言するものでマニフェストに無い)。
   */
  const customCss = view.custom_css;
  if (customCss !== undefined) {
    const cssSource = manifestSource(`${base}/custom_css`);
    const assetSlot = () => idSlot(ctx.sets, "escape_hatch_asset_name", customCss.asset);
    out.push(
      draft(
        "screens",
        "screens.custom_css",
        { view_id: viewIdSlot(), escape_hatch_asset_name: assetSlot() },
        manifestSource(`${base}/custom_css/asset`),
        attributed,
      ),
    );
    out.push(
      draft(
        "screens",
        "screens.custom_css_digest",
        {
          view_id: viewIdSlot(),
          escape_hatch_asset_name: assetSlot(),
          digest: verbatimSlot(customCss.digest, cssSource, "digest"),
        },
        cssSource,
        attributed,
      ),
    );
  }

  /*
   * ADR-0068 A6。**操作起点は1件につき1文**(EC-G14 / ADR-0045)。
   *
   * **【V4-M20-T01 / ADR-0100】形 (ii)(値の書換 = `set`)は1文も出ない。**
   * テンプレートは「画面 X へ遷移し、そのフィールドに…」という遷移の文しか持たず、
   * 値の書換はその文に当てはまらない。**テンプレートを1本も足していない** ——
   * `modal` / `search_fields` / `page_size` / `preset_density` / `hide_when_empty` /
   * `menu_listed` / `audience` も1文も出ておらず(2026-08-04 実測: これらの語が
   * 本ファイルに0件)、**新しい宣言が要件定義書に出ないのは今日の既定の姿である。**
   * **これは自己完結性(憲法3)の後退であり、隠さずここに書く**(実装記録 §6)。
   *
   * **【V5-M21-T01 / `L-G1` / ADR-0171 で関数へ切り出した】** **上のコメントが引く
   * 「`related` / `actions` は detail_view でだけ書ける」は `actions` については
   * 今日から偽である** —— **`ADR-0171`(門A / 判定 = 限定採用)が `list_view` 分岐の
   * `"actions": false,` を解いた。****旧文を1バイトも消していない。**
   * **一覧の操作起点も要件定義書に文を出す** —— **出さないと「一覧に押せるボタンが
   * 在ることが、生成した要件定義書のどこにも現れない」ことになり、自己完結性
   * (憲法3)の後退を1つ増やす。****テンプレートを1本も足していない**(`screens.action`
   * をそのまま使う)。**文面も1文字も変えていない。**
   * **切り出したのは「同じ生成を2箇所に書かない」ためである** —— 片方だけが更新される
   * 日が必ず来る。**`form` には今日も `actions` を書けない**(`ADR-0171` 限定3)。
   */
  const pushActionOrigins = (): void => {
    if (!("actions" in view)) {
      return;
    }
    (view.actions ?? []).forEach((action, position) => {
      if (!("form" in action)) {
        return;
      }
      out.push(
        draft(
          "screens",
          "screens.action",
          {
            view_id: viewIdSlot(),
            position: numberSlot(position + 1),
            form_view_id: idSlot(ctx.sets, "view_id", action.form),
            field_id: idSlot(ctx.sets, "field_id", action.prefill.field),
          },
          manifestSource(`${base}/actions/${position}`),
          attributed,
        ),
      );
    });
  };

  if (view.type === "list_view") {
    view.columns.forEach((column, position) => {
      out.push(
        draft(
          "screens",
          "screens.column",
          {
            view_id: viewIdSlot(),
            position: numberSlot(position + 1),
            field_id: idSlot(ctx.sets, "field_id", column),
          },
          manifestSource(`${base}/columns/${position}`),
          attributed,
        ),
      );
    });
    normalizeSort(view.sort).forEach((key, position) => {
      out.push(
        draft(
          "screens",
          "screens.sort",
          {
            view_id: viewIdSlot(),
            position: numberSlot(position + 1),
            field_id: idSlot(ctx.sets, "field_id", key.field),
            sort_order: termSlot("sort_order", key.order),
          },
          manifestSource(`${base}/sort`),
          attributed,
        ),
      );
    });
    // 等値AND配列(後方互換)のときは従来どおり1葉=1文を生成する。
    // **この分岐の生成物は1バイトも変えていない**(ADR-0068 B4)。
    if (Array.isArray(view.filter)) {
      view.filter.forEach((condition: FilterCondition, position) => {
        const source = manifestSource(`${base}/filter/${position}`);
        out.push(
          draft(
            "screens",
            "screens.filter",
            {
              view_id: viewIdSlot(),
              position: numberSlot(position + 1),
              field_id: idSlot(ctx.sets, "field_id", condition.field),
              filter_value: verbatimSlot(condition.equals, source, "equals"),
            },
            source,
            attributed,
          ),
        );
      });
    } else if (view.filter !== undefined) {
      // ブール式(EC-G12 / ADR-0043)。**ADR-0068 B群で足した** —— それまでは
      // 同じ `filter` キーが、形によって出たり出なかったりしていた
      // (等値AND配列では1文 / ブール式では0文)。
      out.push(
        ...filterNodeStatements(
          ctx,
          view,
          view.filter,
          `${base}/filter`,
          1,
          { next: 1 },
          attributed,
        ),
      );
    }

    /*
     * ADR-0126 A2 の 5 / 6 / 8。**`list_view` にしか書けない3キー**
     * (`search_fields` = `ADR-0112` / `page_size` = `ADR-0113` / `sum_field` = `ADR-0104`)。
     * **TypeScript の型の上でも `ListView` にしかない**ので、型で分岐している。
     */
    (view.search_fields ?? []).forEach((field, position) => {
      out.push(
        draft(
          "screens",
          "screens.search_field",
          {
            view_id: viewIdSlot(),
            position: numberSlot(position + 1),
            field_id: idSlot(ctx.sets, "field_id", field),
          },
          manifestSource(`${base}/search_fields/${position}`),
          attributed,
        ),
      );
    });
    if (view.page_size !== undefined) {
      // **有限 enum の整数を `number` スロットで写す。** `ADR-0025` 限定8 が言う
      // 「出典から数えた整数」ではなく出典の値そのものだが、**整数であり非決定性を
      // 持たない**(`ADR-0126` §Decision 2 の 6)。
      out.push(
        draft(
          "screens",
          "screens.page_size",
          { view_id: viewIdSlot(), count: numberSlot(view.page_size) },
          manifestSource(`${base}/page_size`),
          attributed,
        ),
      );
    }
    if (view.sum_field !== undefined) {
      out.push(
        draft(
          "screens",
          "screens.sum_field",
          { view_id: viewIdSlot(), field_id: idSlot(ctx.sets, "field_id", view.sum_field) },
          manifestSource(`${base}/sum_field`),
          attributed,
        ),
      );
    }

    /*
     * ADR-0144 A2 の単位A(`list_view` に書ける5軸)+ 単位B の `preset_list_shape`。
     *
     * **マップ2キー(寄せ・幅)は要素1件につき1文**(`ADR-0025` 限定7「列挙は statement を
     * 1件ずつ生む」)。**空の `{}` を書いた画面は1文も出ない**(A3。**キーが書いてあるのに
     * 1文も出ない唯一の形であり、「設定を消した」ことは文書に現れない** —— 2026-08-04 の
     * ユーザ決定・未採番が「そのまま進める」と定めた)。
     *
     * **列は既存の `field_id` グループで照合する**(A8。新しい識別子グループを作らない)——
     * `referential-integrity.ts` 類型2b が「対象テーブルに在ること」を保証しているので
     * fail-closed には落ちない。**ただし `columns` への掲載は要求していないので、
     * 一覧に出ていない列についての文が出ることがある**(§Context 3 の 2)。
     */
    for (const [field, align] of Object.entries(view.preset_column_align ?? {})) {
      out.push(
        draft(
          "screens",
          "screens.preset_column_align",
          {
            view_id: viewIdSlot(),
            field_id: idSlot(ctx.sets, "field_id", field),
            column_align: termSlot("column_align", align),
          },
          manifestSource(`${base}/preset_column_align/${escapePointer(field)}`),
          attributed,
        ),
      );
    }
    for (const [field, width] of Object.entries(view.preset_column_width ?? {})) {
      out.push(
        draft(
          "screens",
          "screens.preset_column_width",
          {
            view_id: viewIdSlot(),
            field_id: idSlot(ctx.sets, "field_id", field),
            column_width: termSlot("column_width", width),
          },
          manifestSource(`${base}/preset_column_width/${escapePointer(field)}`),
          attributed,
        ),
      );
    }
    if (view.preset_pager_position !== undefined) {
      out.push(
        draft(
          "screens",
          "screens.preset_pager_position",
          {
            view_id: viewIdSlot(),
            pager_position: termSlot("pager_position", view.preset_pager_position),
          },
          manifestSource(`${base}/preset_pager_position`),
          attributed,
        ),
      );
    }
    if (view.preset_image_size !== undefined) {
      out.push(
        draft(
          "screens",
          "screens.preset_image_size",
          { view_id: viewIdSlot(), image_size: termSlot("image_size", view.preset_image_size) },
          manifestSource(`${base}/preset_image_size`),
          attributed,
        ),
      );
    }
    if (view.preset_text_preview !== undefined) {
      out.push(
        draft(
          "screens",
          "screens.preset_text_preview",
          {
            view_id: viewIdSlot(),
            text_preview: termSlot("text_preview", view.preset_text_preview),
          },
          manifestSource(`${base}/preset_text_preview`),
          attributed,
        ),
      );
    }
    if (view.preset_list_shape !== undefined) {
      out.push(
        draft(
          "screens",
          "screens.preset_list_shape",
          { view_id: viewIdSlot(), list_shape: termSlot("list_shape", view.preset_list_shape) },
          manifestSource(`${base}/preset_list_shape`),
          attributed,
        ),
      );
    }
    pushActionOrigins();
    return out;
  }

  /*
   * **集計表(`report_view`)**(`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`)。
   *
   * **本文に1文も出さない。** **出るのは共通部分(対象・表示名・掲載の可否・逃げ道)だけで
   * あり、束ね方も集計も1文も現れない。**
   *
   * **なぜ今日出さないのか(判断であって書き漏らしではない)**:
   * **要件定義書に集計表の中身を出すのは `V8-M13`(台帳 `Q-G31a`)の担当である。**
   * **文面(`REQUIREMENT_TEMPLATES`)を足すことは、この製品では語彙を1つ足すのと同じ
   * 重さの決定であり**(`ADR-0025` 限定11 / `ADR-0144` §3a)、**`V8-M8` の範囲に無い。**
   * **黙って出さないのではなく、`src/kernel/requirements-doc.test.ts` の
   * `VIEW_KEY_EMITS_STATEMENT` に `report` の行を足して「4形すべてで書けない
   * (`unwritable`)」と明示してある** —— **判断を書かずに増やすことは許さない、という
   * 同ファイルの規律に従っている。**
   *
   * **【正直に書く】その結果、集計表を持つアプリの要件定義書は「集計表という画面が在る」
   * ことしか言わない。** **何をどう束ねているかは1文も書かれない。**
   */
  /*
   * **【2026-08-15。`V8-M13-T03`。台帳 `Q-G31a`(限定採用)/ `Q-G31b`(保留 → 本タスクで
   * 再審査して限定採用へ)。上の JSDoc を1バイトも書き換えていない。ただし今日は偽である】**
   *
   * **旧の逐語**: `if (view.type === "report_view") { return out; }`(**`return out;` の
   * 1行だけを、下の `pushReportStatements(...)` の呼び出しに置き換えた**)。
   *
   * **上の「本文に1文も出さない」「何をどう束ねているかは1文も書かれない」は、今日は
   * 成り立たない** —— **`V8-M8` が名指しで `V8-M13` に送った担当を、本タスクが果たした。**
   * **`V8-M8` が `VIEW_KEY_EMITS_STATEMENT` に置いた `report` の行(4形すべて
   * `unwritable`)も今日は全量ではない** —— **`requirements-doc.test.ts` の第2軸に
   * 5形目 `report_view` を足し、`report/report_view` を `emits` にした。**
   *
   * **`Q-G31b` の再審査の答え**: **写せた。** **`{table, via}` は「テーブル `T` の
   * `reference` 型フィールド `f`」の対でしかなく、`id` スロット2つ(`table_id` /
   * `field_id`)と `number` スロット1つで1文に収まる** —— **`Slot` の5種目も、
   * 識別子グループの27件目も、語彙グループの20件目も要らなかった。**
   */
  if (view.type === "report_view") {
    pushReportStatements(ctx, view, base, attributed, viewIdSlot, out);
    return out;
  }

  (view.fields ?? []).forEach((field, position) => {
    out.push(
      draft(
        "screens",
        "screens.item",
        {
          view_id: viewIdSlot(),
          position: numberSlot(position + 1),
          field_id: idSlot(ctx.sets, "field_id", field),
        },
        manifestSource(`${base}/fields/${position}`),
        attributed,
      ),
    );
  });

  /*
   * ADR-0126 A2 の 4 / 7。**`form` にしか書けない2キー**
   * (`modal` = `P-G14` / `ADR-0095` / `after_save` = `E-G34` / `ADR-0102`)。
   * **ここまで来た `view` は `form` か `detail_view` のどちらかである**(`list_view` は
   * 上で `return` 済み)ので、`form` で絞る。
   *
   * **`modal` は真偽それぞれ1文**(A2 の 4。`menu_listed` と同型)。
   * **`after_save` の遷移先は `view_id` の実在集合に照合する** —— `ADR-0102` 限定8 が
   * apply 時に実在を保証しているので fail-closed には落ちない(A2 の 7)。
   */
  if (view.type === "form") {
    if (view.modal !== undefined) {
      out.push(
        draft(
          "screens",
          view.modal ? "screens.modal" : "screens.non_modal",
          { view_id: viewIdSlot() },
          manifestSource(`${base}/modal`),
          attributed,
        ),
      );
    }
    /*
     * `ADR-0291` A2 の 2。**入力画面ごとの参照項目の選び方の上書き**
     * (`K-G2` / `ADR-0289`)。**`form` にしか書けない3キー目である。**
     *
     * **項目ごとに1文**(`Object.entries` の順 = manifest.json に書かれた宣言順。
     * `ADR-0025` §6 の決定論を崩さない)。**キーのフィールドIDは `field_id` の
     * 実在集合に照合する** —— `ADR-0289` 限定2 が apply 時に実在を保証している。
     */
    for (const [fieldId, picker] of Object.entries(view.reference_pickers ?? {})) {
      out.push(
        draft(
          "screens",
          REFERENCE_PICKER_VIEW_TEMPLATES[picker],
          { view_id: viewIdSlot(), field_id: idSlot(ctx.sets, "field_id", fieldId) },
          manifestSource(`${base}/reference_pickers/${escapePointer(fieldId)}`),
          attributed,
        ),
      );
    }
    if (view.after_save !== undefined) {
      out.push(
        draft(
          "screens",
          "screens.after_save",
          {
            view_id: viewIdSlot(),
            destination_view_id: idSlot(ctx.sets, "view_id", view.after_save),
          },
          manifestSource(`${base}/after_save`),
          attributed,
        ),
      );
    }
  }

  /*
   * **書換ボタンが成立したあとの行き先**(`NV-G3a`。`V10-M1-T01` / `ADR-0358` 限定1)。
   *
   * **`form` の側(すぐ上のブロック)を1文字も変えていない**(限定7)—— **同じ
   * テンプレートを、`detail_view` のときは別のブロックから出す。**
   *
   * **「文を出す」を選んだ**(`requirements-doc.test.ts` の `VIEW_KEY_EMITS_STATEMENT` で
   * `after_save/detail_view` を `emits` にした)。**理由は2点**:
   * 1. **黙る(`silent`)を選ぶと、`ADR-0126` A10 / `ADR-0144` A9 が 0 にした
   *    `silent` が復活する。** **復活させるには `ADR-0126` §3a の 2 / `ADR-0144` §3a の 2 の
   *    門が要り、`ADR-0358` はその門を通っていない。**
   * 2. **新しい文面(`REQUIREMENT_TEMPLATES`)を足すことは、この製品では語彙を1つ足すのと
   *    同じ重さの決定である**(`ADR-0025` 限定11 / `ADR-0144` §3a。**この判断は本ファイルの
   *    `report_view` の JSDoc が既に逐語で書いている**)。**`ADR-0358` 限定4 は
   *    「新しいキーを1本も足さない」であり、専用の文面を新設する門も通っていない。**
   *
   * **【正直に書く。丸めない】その代償として、`detail_view` について出る1文は
   * `form` とまったく同じ「保存が成立したあと」である。** **詳細画面に「保存」という
   * 出来事は無く、実際に発火するのは `actions` の `set` 形の書込が成立したときだけである**
   * (`ADR-0358` 限定2)。**この製品の要件定義書は、その1点について今日ずれている。**
   * **ずれを消すには専用の文面を1本足すことになり、それは改めて `ADR-0007` の門を通す。**
   * **`ADR-0358` §Consequences の1点目(キーの名前が意味と合わなくなる)が、
   * ここにも当たっているというだけである。**
   */
  if (view.type === "detail_view" && view.after_save !== undefined) {
    out.push(
      draft(
        "screens",
        "screens.after_save",
        {
          view_id: viewIdSlot(),
          destination_view_id: idSlot(ctx.sets, "view_id", view.after_save),
        },
        manifestSource(`${base}/after_save`),
        attributed,
      ),
    );
  }

  /*
   * ADR-0144 A2 の単位A のうち、**`detail_view` と `form` の両方に書ける2軸**
   * (`preset_label_placement` / `preset_field_columns`)。
   *
   * **この2軸が form に書けるのは `ADR-0091`(門A / 限定採用)が form 分岐の `false` を
   * 外したからである** —— それまでは `unwritable` だった。
   * **`preset_field_columns` だけは `number` スロットで写す**(A7)—— 値は `1` / `2` の整数で
   * あり、`term` にすると「1」「2」が語彙タグになる。
   */
  if (view.preset_label_placement !== undefined) {
    out.push(
      draft(
        "screens",
        "screens.preset_label_placement",
        {
          view_id: viewIdSlot(),
          label_placement: termSlot("label_placement", view.preset_label_placement),
        },
        manifestSource(`${base}/preset_label_placement`),
        attributed,
      ),
    );
  }
  if (view.preset_field_columns !== undefined) {
    out.push(
      draft(
        "screens",
        "screens.preset_field_columns",
        { view_id: viewIdSlot(), count: numberSlot(view.preset_field_columns) },
        manifestSource(`${base}/preset_field_columns`),
        attributed,
      ),
    );
  }

  // **`related` / `actions` は detail_view でだけ書ける**(schema の `allOf` が
  // list_view / form では `false` にしている)。型の上でも DetailView にしか無い。
  if (view.type !== "detail_view") {
    return out;
  }

  /*
   * ADR-0144 A2 の単位A のうち、**`detail_view` にも書ける2軸**
   * (`preset_image_size` / `preset_text_preview`)。**form には書けない**(schema の `allOf`)。
   */
  if (view.preset_image_size !== undefined) {
    out.push(
      draft(
        "screens",
        "screens.preset_image_size",
        { view_id: viewIdSlot(), image_size: termSlot("image_size", view.preset_image_size) },
        manifestSource(`${base}/preset_image_size`),
        attributed,
      ),
    );
  }
  if (view.preset_text_preview !== undefined) {
    out.push(
      draft(
        "screens",
        "screens.preset_text_preview",
        { view_id: viewIdSlot(), text_preview: termSlot("text_preview", view.preset_text_preview) },
        manifestSource(`${base}/preset_text_preview`),
        attributed,
      ),
    );
  }

  // ADR-0068 A6。**関連一覧は1件につき1文 + 列ごとに1文**(既存 `screens.column` と同型)。
  // **生成器は DB を1行も読まない** —— 子レコードの中身には触れない。
  (view.related ?? []).forEach((related, position) => {
    const relatedBase = `${base}/related/${position}`;
    out.push(
      draft(
        "screens",
        "screens.related",
        {
          view_id: viewIdSlot(),
          position: numberSlot(position + 1),
          table_id: idSlot(ctx.sets, "table_id", related.table),
          field_id: idSlot(ctx.sets, "field_id", related.via),
        },
        manifestSource(relatedBase),
        attributed,
      ),
    );
    related.columns.forEach((column, columnPosition) => {
      out.push(
        draft(
          "screens",
          "screens.related_column",
          {
            view_id: viewIdSlot(),
            position: numberSlot(position + 1),
            column_position: numberSlot(columnPosition + 1),
            field_id: idSlot(ctx.sets, "field_id", column),
          },
          manifestSource(`${relatedBase}/columns/${columnPosition}`),
          attributed,
        ),
      );
    });
  });

  pushActionOrigins();

  /*
   * ADR-0126 A2 の 3(`view.field_groups`。`P-G17` の (C) 側 / `ADR-0092`)。
   *
   * **まとまり1件につき1文 + 所属項目1件につき1文。** 「名前 → 項目の配列」の1段であり、
   * **入れ子はスキーマが禁じているので深さの語彙は要らない**(`screens.filter_*` が
   * `depth` を持つのと対照的である)。
   *
   * **名前は自由文字列なので自己言及の識別子グループ `field_group_name` に入れる**
   * (A5。`action_key_name` と同型)。**pointer にはマップのキーがそのまま入るので
   * RFC6901 のエスケープを掛ける。**
   */
  for (const [position, [name, group]] of Object.entries(view.field_groups ?? {}).entries()) {
    const groupPointer = `${base}/field_groups/${escapePointer(name)}`;
    out.push(
      draft(
        "screens",
        "screens.field_group",
        {
          view_id: viewIdSlot(),
          position: numberSlot(position + 1),
          field_group_name: idSlot(ctx.sets, "field_group_name", name),
        },
        manifestSource(groupPointer),
        attributed,
      ),
    );
    /*
     * **【`CM-G24` / `V10-M24-T03`】まとまりの値は2形ある**(`ADR-0371`)—— 配列そのものか、
     * 名札を持つ `{ id?, fields }`。**出す文は `screens.field_group` と
     * `screens.field_group_item` の2種のままである**(`ADR-0374` 限定8)——
     * **名札のための3種目のテンプレートを1文も足していない。****名札を1度も読まない。**
     */
    const fields = Array.isArray(group) ? group : group.fields;
    fields.forEach((field, itemPosition) => {
      out.push(
        draft(
          "screens",
          "screens.field_group_item",
          {
            view_id: viewIdSlot(),
            position: numberSlot(position + 1),
            item_position: numberSlot(itemPosition + 1),
            field_id: idSlot(ctx.sets, "field_id", field),
          },
          manifestSource(`${groupPointer}/${itemPosition}`),
          attributed,
        ),
      );
    });
  }
  return out;
}

function screenStatements(ctx: Context): DraftStatement[] {
  return ctx.manifest.app.views.flatMap((view, index) => viewStatements(ctx, view, index));
}

/** テーブル1つぶんの記述(規模・各フィールドの型・必須・選択肢・参照先)。 */
function tableStatements(ctx: Context, table: Table, index: number): DraftStatement[] {
  const base = `/app/tables/${index}`;
  const tableIdSlot = () => idSlot(ctx.sets, "table_id", table.id);
  const out: DraftStatement[] = [
    draft(
      "data",
      "data.table",
      {
        table_id: tableIdSlot(),
        table_name: idSlot(ctx.sets, "table_name", table.name),
        field_count: numberSlot(table.fields.length),
      },
      manifestSource(base),
      attributionOf(ctx.attribution.tables, table.id),
    ),
  ];

  table.fields.forEach((field, position) => {
    const fieldBase = `${base}/fields/${position}`;
    const attributed = attributionOf(ctx.attribution.fields, fieldKey(table.id, field.id));
    const fieldIdSlot = () => idSlot(ctx.sets, "field_id", field.id);
    out.push(
      draft(
        "data",
        "data.field",
        {
          table_id: tableIdSlot(),
          position: numberSlot(position + 1),
          field_id: fieldIdSlot(),
          field_name: idSlot(ctx.sets, "field_name", field.name),
          field_type: termSlot("field_type", field.type),
        },
        manifestSource(fieldBase),
        attributed,
      ),
    );
    out.push(
      draft(
        "data",
        field.required === true ? "data.field_required" : "data.field_optional",
        { table_id: tableIdSlot(), field_id: fieldIdSlot() },
        manifestSource(fieldBase),
        attributed,
      ),
    );
    if (field.type === "select") {
      const optionsSource = manifestSource(`${fieldBase}/options`);
      field.options.forEach((option, optionIndex) => {
        out.push(
          draft(
            "data",
            "data.field_option",
            {
              table_id: tableIdSlot(),
              field_id: fieldIdSlot(),
              position: numberSlot(optionIndex + 1),
              option: verbatimSlot(option, optionsSource, String(optionIndex)),
            },
            optionsSource,
            attributed,
          ),
        );
      });
    }
    if (field.type === "reference") {
      out.push(
        draft(
          "data",
          "data.field_reference",
          {
            table_id: tableIdSlot(),
            field_id: fieldIdSlot(),
            reference_table: idSlot(ctx.sets, "table_id", field.reference_table),
          },
          manifestSource(`${fieldBase}/reference_table`),
          attributed,
        ),
      );
    }

    /*
     * ADR-0126 A2 の 9〜14。**v4 が `$defs/field` に足した6キー。**
     *
     * **キーが書かれていれば必ず1文以上出る。書かれていなければ1文も出ない**(A3)——
     * **既定値を推測して文を出さない。** 書かなかった `unique` について「同じ値を持つ行を
     * 作れる」と書かない(それは実装の既定であってアプリの宣言ではない)。
     * **`required` だけは例外で、v1 から「書かなくても『任意である』と述べる」形である**
     * —— A3 は本 ADR が足した14キーに課した不変条件であり、遡及しない。
     */

    // 9. `unique`(`EC-G8` / `ADR-0038` + owner スコープ = `ADR-0078`)。**3値それぞれ1文。**
    // **`"owner"` を別の文にする** —— 同じ文で表すと「持ち主ごと」が読めない。
    if (field.unique !== undefined) {
      out.push(
        draft(
          "data",
          field.unique === "owner"
            ? "data.field_unique_owner"
            : field.unique
              ? "data.field_unique"
              : "data.field_not_unique",
          { table_id: tableIdSlot(), field_id: fieldIdSlot() },
          manifestSource(`${fieldBase}/unique`),
          attributed,
        ),
      );
    }

    /*
     * **【`V8-M20`。台帳 `J-G28` / `ADR-0301`】10 と 11 の発火をここから撤去した。**
     *
     * **旧記述の逐語**:
     *   10.「`audience`(`B-G2` / `ADR-0071`)。**値1件につき1文**(位置つき)。」
     *   11.「`writable_by`(`ADR-0076`)。**`audience` と別のテンプレートにする** ——
     *      `ADR-0076` §1b が『読取の値域と書込の値域は一致しない。裏返しではない』と
     *      明記しており、同じ文で表すと2つが同じものに読める。」
     *
     * **項目ごとの見せる相手 / 書ける相手は `app.roles[].rules`(対象 `field`・
     * 動詞 `read` / `write`)へ移った。****その `rules` を述べるテンプレートは
     * 本タスクでは1本も足していない。**
     * **番号 10 / 11 は欠番にする** —— 12 以降を繰り上げると `ADR-0126` A2 の
     * 番号との対応が読めなくなる。
     */

    // 12. `unit`(`E-G14` / `ADR-0086`)。**`number` にだけ書ける。** 値は自由文字列
    // (8文字以下)なので、識別子でも閉じた語彙でもなく **`verbatim`** で写す(A7)。
    if (field.type === "number" && field.unit !== undefined) {
      out.push(
        draft(
          "data",
          "data.field_unit",
          {
            table_id: tableIdSlot(),
            field_id: fieldIdSlot(),
            unit: verbatimSlot(field.unit, manifestSource(fieldBase), "unit"),
          },
          manifestSource(`${fieldBase}/unit`),
          attributed,
        ),
      );
    }

    // 13. `emphasis`(`P-G28` / `ADR-0090`)。**`select` にだけ書ける。対応1件につき1文。**
    // **選択肢の値は `options` 配列の添字を指す `verbatim` にする**(`data.field_option` と
    // 同じ出典経路。A7)—— `referential-integrity.ts` が「`options` に無い値をキーに書いた
    // 差分」を拒否しているので、実在するはずである。**それでも `-1` なら fail-closed する**
    // (黙って書かない)。
    if (field.type === "select" && field.emphasis !== undefined) {
      const optionsSource = manifestSource(`${fieldBase}/options`);
      for (const [option, level] of Object.entries(field.emphasis)) {
        const optionIndex = field.options.indexOf(option);
        if (optionIndex === -1) {
          throw new Error(
            `要件定義書の生成を中止しました。テーブル "${table.id}" のフィールド ` +
              `"${field.id}" の emphasis のキーが options に実在しません("${option}")。` +
              `出典を持たない値を黙って書かないため fail-closed します(ADR-0126 A7)。`,
          );
        }
        out.push(
          draft(
            "data",
            "data.field_emphasis",
            {
              table_id: tableIdSlot(),
              field_id: fieldIdSlot(),
              emphasis_level: termSlot("emphasis_level", level),
              option: verbatimSlot(option, optionsSource, String(optionIndex)),
            },
            manifestSource(`${fieldBase}/emphasis/${escapePointer(option)}`),
            attributed,
          ),
        );
      }
    }

    // 14. `hide_when_empty`(`E-G17` / `ADR-0119`)。**真偽それぞれ1文。8型すべてに書ける。**
    if (field.hide_when_empty !== undefined) {
      out.push(
        draft(
          "data",
          field.hide_when_empty ? "data.field_hide_when_empty" : "data.field_show_when_empty",
          { table_id: tableIdSlot(), field_id: fieldIdSlot() },
          manifestSource(`${fieldBase}/hide_when_empty`),
          attributed,
        ),
      );
    }

    /*
     * 15. `reference_picker`(`K-G1` / `ADR-0288` / `ADR-0291` A2 の 1)。
     * **3値それぞれ1文**(`unique` と同型)。**`reference` 型にだけ書ける。**
     *
     * **`V6-M1` がこのキーを足した日から `V6-M6` の前日まで、この宣言は要件定義書に
     * 1文も出ていなかった**(`requirements-doc.test.ts` の被覆表が `silent` として
     * 明記していた最初の1マスである)。**ここがその是正である。**
     *
     * **16. `reference_search_fields`(探せる項目)は意図して置いていない** ——
     * **ユーザ決定 `D-V6-21` と `V6-M0` §7-11 の `K-G21b` 限定2 による**
     * (今日 `representative_field` を1件も出していない作法に合わせる)。
     * **「書き忘れ」ではない。****被覆表の `silent` が1マス残るのはこのためである。**
     */
    if (field.type === "reference" && field.reference_picker !== undefined) {
      out.push(
        draft(
          "data",
          REFERENCE_PICKER_FIELD_TEMPLATES[field.reference_picker],
          { table_id: tableIdSlot(), field_id: fieldIdSlot() },
          manifestSource(`${fieldBase}/reference_picker`),
          attributed,
        ),
      );
    }
  });

  /*
   * **`Z-G28`(`V7-M6-T03`)。`$defs/table` の6キー目 `access_control`。**
   *
   * **`enabled` が真のときだけ文を出す** —— **`enabled: false` は「宣言していない表」と
   * 同じ扱いである**(`ADR-0292` / schema の `$comment` の逐語)。**したがって
   * 宣言していない表と `enabled: false` の表では、生成物が着手前と1バイトも変わらない**
   * (`Z-G28` 限定4)。
   *
   * **出典は宣言のキーを指す JSON Pointer だけで、付与表の行を1件も読まない**(限定1)——
   * **読むと生成物がデータに依存し、決定論(`ADR-0025` §6)が崩れる。**
   *
   * **帰属は表と同じもの**(どの差分がこの表を書いたか)を使う —— **宣言専用の帰属先を
   * 新しく作らない**(`Attribution` の形を1バイトも変えていない)。
   */
  const access = table.access_control;
  if (access?.enabled) {
    const accessBase = `${base}/access_control`;
    const accessAttribution = attributionOf(ctx.attribution.tables, table.id);

    // (a) この表がアクセス権管理を使うこと。
    out.push(
      draft(
        "data",
        "data.table_access_control",
        { table_id: tableIdSlot() },
        manifestSource(`${accessBase}/enabled`),
        accessAttribution,
      ),
    );

    // (b) 権限名と、その読む / 書く / 消すの組。**1件につき4文**(名前1 + 真偽3)。
    access.permissions.forEach((permission, permissionIndex) => {
      const permissionBase = `${accessBase}/permissions/${permissionIndex}`;
      const positionSlot = () => numberSlot(permissionIndex + 1);
      out.push(
        draft(
          "data",
          "data.table_access_permission",
          {
            table_id: tableIdSlot(),
            position: positionSlot(),
            permission: verbatimSlot(permission.id, manifestSource(permissionBase), "id"),
          },
          manifestSource(permissionBase),
          accessAttribution,
        ),
      );
      out.push(
        draft(
          "data",
          permission.read
            ? "data.table_access_permission_read"
            : "data.table_access_permission_no_read",
          { table_id: tableIdSlot(), position: positionSlot() },
          manifestSource(`${permissionBase}/read`),
          accessAttribution,
        ),
      );
      out.push(
        draft(
          "data",
          permission.write
            ? "data.table_access_permission_write"
            : "data.table_access_permission_no_write",
          { table_id: tableIdSlot(), position: positionSlot() },
          manifestSource(`${permissionBase}/write`),
          accessAttribution,
        ),
      );
      out.push(
        draft(
          "data",
          permission.delete
            ? "data.table_access_permission_delete"
            : "data.table_access_permission_no_delete",
          { table_id: tableIdSlot(), position: positionSlot() },
          manifestSource(`${permissionBase}/delete`),
          accessAttribution,
        ),
      );
    });

    // (c) 付与表・メンバー表・グループ表の**名前**。**列の役割は1文も出さない。**
    out.push(
      draft(
        "data",
        "data.table_access_grant_table",
        { table_id: tableIdSlot(), grant_table: idSlot(ctx.sets, "table_id", access.grant.table) },
        manifestSource(`${accessBase}/grant/table`),
        accessAttribution,
      ),
    );
    if (access.members !== undefined) {
      out.push(
        draft(
          "data",
          "data.table_access_member_table",
          {
            table_id: tableIdSlot(),
            member_table: idSlot(ctx.sets, "table_id", access.members.table),
          },
          manifestSource(`${accessBase}/members/table`),
          accessAttribution,
        ),
      );
    }
    if (access.groups !== undefined) {
      out.push(
        draft(
          "data",
          "data.table_access_group_table",
          {
            table_id: tableIdSlot(),
            group_table: idSlot(ctx.sets, "table_id", access.groups.table),
          },
          manifestSource(`${accessBase}/groups/table`),
          accessAttribution,
        ),
      );
    }

    // (d) `inherit_from` の参照項目の名前。**1本につき1文**(位置つき)。
    (access.inherit_from ?? []).forEach((fieldId, inheritIndex) => {
      out.push(
        draft(
          "data",
          "data.table_access_inherit_from",
          {
            table_id: tableIdSlot(),
            position: numberSlot(inheritIndex + 1),
            field_id: idSlot(ctx.sets, "field_id", fieldId),
          },
          manifestSource(`${accessBase}/inherit_from/${inheritIndex}`),
          accessAttribution,
        ),
      );
    });
  }
  return out;
}

function dataStatements(ctx: Context): DraftStatement[] {
  return ctx.manifest.app.tables.flatMap((table, index) => tableStatements(ctx, table, index));
}

/**
 * `values` / `payload` / `input` の**1キーを1 statement** にする(ADR-0025 改訂1)。
 *
 * スロットはスカラのまま(限定7)—— 連想配列をそのままスロットに入れず、キーごとに
 * 記述を1件生む。**キーは `action_key_name`(鉤括弧)、値は逐語引用**である。
 * 値が `$record.<フィールドID>` の参照でもリテラルでも、出典の文字列そのものを写す
 * (解釈しない —— 参照の解決は実行層の仕事であって、要件定義書の仕事ではない)。
 *
 * 反復順は `Object.entries`(= manifest.json に書かれた宣言順)であり、
 * 同一入力に対して常に同じ順になる(§6)。
 */
function mapEntryStatements(
  ctx: Context,
  template: RequirementTemplateId,
  workflow: Workflow,
  position: number,
  entries: Record<string, string>,
  pointer: string,
  attributed: StatementSource[],
): DraftStatement[] {
  const source = manifestSource(pointer);
  return Object.entries(entries).map(([key, value]) =>
    draft(
      "automation",
      template,
      {
        workflow_id: idSlot(ctx.sets, "workflow_id", workflow.id),
        position: numberSlot(position + 1),
        action_key_name: idSlot(ctx.sets, "action_key_name", key),
        value: verbatimSlot(value, source, key),
      },
      source,
      attributed,
    ),
  );
}

/** ワークフロー1つぶんの記述(実行履歴・発火条件・動作)。 */
function workflowStatements(ctx: Context, workflow: Workflow, index: number): DraftStatement[] {
  const base = `/app/workflows/${index}`;
  const attributed = attributionOf(ctx.attribution.workflows, workflow.id);
  const workflowIdSlot = () => idSlot(ctx.sets, "workflow_id", workflow.id);
  const out: DraftStatement[] = [
    draft(
      "automation",
      "automation.workflow",
      {
        workflow_id: workflowIdSlot(),
        workflow_name: idSlot(ctx.sets, "workflow_name", workflow.name),
        history_table: idSlot(ctx.sets, "table_id", workflow.history_table),
      },
      manifestSource(base),
      attributed,
    ),
  ];

  const trigger = workflow.trigger;
  const triggerSource = manifestSource(`${base}/trigger`);
  if (trigger.type === "schedule") {
    out.push(
      draft(
        "automation",
        "automation.trigger_schedule",
        {
          workflow_id: workflowIdSlot(),
          hour: numberSlot(trigger.at.hour),
          minute: numberSlot(trigger.at.minute),
          trigger_type: termSlot("trigger_type", trigger.type),
        },
        triggerSource,
        attributed,
      ),
    );
    // ADR-0068 A4(D-G16a / ADR-0063)。**同じ `table` キーが `on_create` では1文に
    // なるのに、`schedule` では0文だった。**
    if (trigger.table !== undefined) {
      out.push(
        draft(
          "automation",
          "automation.trigger_schedule_table",
          {
            workflow_id: workflowIdSlot(),
            table_id: idSlot(ctx.sets, "table_id", trigger.table),
          },
          manifestSource(`${base}/trigger/table`),
          attributed,
        ),
      );
    }
    // ADR-0068 A5(D-G16b / ADR-0064)。**経過時間を計算した結果は書かない**(共通7)。
    if (trigger.older_than !== undefined) {
      out.push(
        draft(
          "automation",
          "automation.trigger_schedule_older_than",
          {
            workflow_id: workflowIdSlot(),
            field_id: idSlot(ctx.sets, "field_id", trigger.older_than.field),
            days: numberSlot(trigger.older_than.days),
          },
          manifestSource(`${base}/trigger/older_than`),
          attributed,
        ),
      );
    }
  } else {
    out.push(
      draft(
        "automation",
        // **【`V5-M25-T01` / `ADR-0174`】4値目 `manual` を1本足した。**
        trigger.type === "on_create"
          ? "automation.trigger_on_create"
          : trigger.type === "manual"
            ? "automation.trigger_manual"
            : "automation.trigger_on_update",
        {
          workflow_id: workflowIdSlot(),
          table_id: idSlot(ctx.sets, "table_id", trigger.table),
          trigger_type: termSlot("trigger_type", trigger.type),
        },
        triggerSource,
        attributed,
      ),
    );
  }

  workflow.actions.forEach((action, position) => {
    const actionSource = manifestSource(`${base}/actions/${position}`);
    out.push(
      draft(
        "automation",
        "automation.action",
        {
          workflow_id: workflowIdSlot(),
          position: numberSlot(position + 1),
          action_type: termSlot("action_type", action.action),
        },
        actionSource,
        attributed,
      ),
    );
    // ADR-0068 A2(EC-G5 条件分岐 / ADR-0036)。**5種すべてで書けるのに1文も出て
    // いなかった。** `field` は id スロット・`equals` は逐語引用であり、
    // **条件の評価結果(何件が該当するか)は1文字も書かない。**
    if (action.when !== undefined) {
      const whenSource = manifestSource(`${base}/actions/${position}/when`);
      out.push(
        draft(
          "automation",
          "automation.action_when",
          {
            workflow_id: workflowIdSlot(),
            position: numberSlot(position + 1),
            field_id: idSlot(ctx.sets, "field_id", action.when.field),
            value: verbatimSlot(action.when.equals, whenSource, "equals"),
          },
          whenSource,
          attributed,
        ),
      );
    }
    if (action.action === "create_record" || action.action === "update_record") {
      out.push(
        draft(
          "automation",
          "automation.action_target_table",
          {
            workflow_id: workflowIdSlot(),
            position: numberSlot(position + 1),
            table_id: idSlot(ctx.sets, "table_id", action.table),
          },
          actionSource,
          attributed,
        ),
      );
      // ADR-0068 A1。**`update_record` の必須キーなのに1文も出ていなかった。**
      // **値を解釈しない** —— `$record._id` / `$record.<reference>` / 定数UUID の
      // どれであっても、出典の文字列そのものを逐語引用で写す(解決は実行層の仕事)。
      if (action.action === "update_record") {
        out.push(
          draft(
            "automation",
            "automation.action_target",
            {
              workflow_id: workflowIdSlot(),
              position: numberSlot(position + 1),
              target: verbatimSlot(action.target, actionSource, "target"),
            },
            actionSource,
            attributed,
          ),
        );
      }
      out.push(
        ...mapEntryStatements(
          ctx,
          "automation.action_value",
          workflow,
          position,
          action.values,
          `${base}/actions/${position}/values`,
          attributed,
        ),
      );
    }
    if (action.action === "call_external") {
      const destinationSource = actionSource;
      out.push(
        draft(
          "automation",
          "automation.action_connection",
          {
            workflow_id: workflowIdSlot(),
            position: numberSlot(position + 1),
            capability_name: idSlot(ctx.sets, "capability_name", action.connection),
          },
          actionSource,
          attributed,
        ),
        draft(
          "automation",
          "automation.action_destination",
          {
            workflow_id: workflowIdSlot(),
            position: numberSlot(position + 1),
            destination: verbatimSlot(action.destination, destinationSource, "destination"),
          },
          destinationSource,
          attributed,
        ),
        ...mapEntryStatements(
          ctx,
          "automation.action_payload",
          workflow,
          position,
          action.payload,
          `${base}/actions/${position}/payload`,
          attributed,
        ),
      );
    }
    if (action.action === "ai_transform") {
      out.push(
        draft(
          "automation",
          "automation.action_ai_capability",
          {
            workflow_id: workflowIdSlot(),
            position: numberSlot(position + 1),
            capability_name: idSlot(ctx.sets, "capability_name", action.capability),
          },
          actionSource,
          attributed,
        ),
        draft(
          "automation",
          "automation.action_ai_prompt",
          {
            workflow_id: workflowIdSlot(),
            position: numberSlot(position + 1),
            prompt: verbatimSlot(action.prompt, actionSource, "prompt"),
          },
          actionSource,
          attributed,
        ),
        ...mapEntryStatements(
          ctx,
          "automation.action_ai_input",
          workflow,
          position,
          action.input,
          `${base}/actions/${position}/input`,
          attributed,
        ),
        draft(
          "automation",
          "automation.action_ai_output_field",
          {
            workflow_id: workflowIdSlot(),
            position: numberSlot(position + 1),
            field_id: idSlot(ctx.sets, "field_id", action.output_field),
          },
          actionSource,
          attributed,
        ),
        draft(
          "automation",
          "automation.action_ai_fallback",
          {
            workflow_id: workflowIdSlot(),
            position: numberSlot(position + 1),
            fallback: verbatimSlot(action.fallback, actionSource, "fallback"),
          },
          actionSource,
          attributed,
        ),
      );
    }
    if (action.action === "run_function") {
      if (action.write_back !== undefined) {
        // EC-G6 record 書き戻しモード(Route B。ADR-0037)。output_table を持たず、
        // 結果をきっかけのレコード自身へ書き戻す —— table_id スロットは無い。
        out.push(
          draft(
            "automation",
            "automation.action_run_function_write_back",
            {
              workflow_id: workflowIdSlot(),
              position: numberSlot(position + 1),
              function_id: idSlot(ctx.sets, "function_id", action.function),
            },
            actionSource,
            attributed,
          ),
        );
      } else if (action.output_table !== undefined) {
        out.push(
          draft(
            "automation",
            "automation.action_run_function",
            {
              workflow_id: workflowIdSlot(),
              position: numberSlot(position + 1),
              function_id: idSlot(ctx.sets, "function_id", action.function),
              table_id: idSlot(ctx.sets, "table_id", action.output_table),
            },
            actionSource,
            attributed,
          ),
        );
      } else if (action.write_ops === true) {
        // ADR-0068 A7(ADR-0067 の第3の書込モード)。**どちらの既存分岐にも入らないので、
        // 「どの関数を呼ぶか」も「どこへ書くか」も1文も出ていなかった。**
        // **島が実際に何を書くかは書かない** —— op は実行時に島が生成するので
        // マニフェストに存在しない(ADR-0067 限定 A11)。
        out.push(
          draft(
            "automation",
            "automation.action_run_function_write_ops",
            {
              workflow_id: workflowIdSlot(),
              position: numberSlot(position + 1),
              function_id: idSlot(ctx.sets, "function_id", action.function),
            },
            actionSource,
            attributed,
          ),
        );
      }
    }
  });
  return out;
}

/** 関数1つぶんの記述(定義・入力・出力・capability)。 */
function functionStatements(ctx: Context, fn: FunctionDef, index: number): DraftStatement[] {
  const base = `/app/functions/${index}`;
  const attributed = attributionOf(ctx.attribution.functions, fn.id);
  const functionIdSlot = () => idSlot(ctx.sets, "function_id", fn.id);
  const out: DraftStatement[] = [
    draft(
      "automation",
      "automation.function",
      {
        function_id: functionIdSlot(),
        function_name: idSlot(ctx.sets, "function_name", fn.name),
      },
      manifestSource(base),
      attributed,
    ),
  ];

  const inputSource = manifestSource(`${base}/input`);
  /*
   * **ADR-0062(複数入力)により `input` は配列形も取りうる。**
   *
   * **【2026-08-01。ADR-0068 A3 による改訂】** **配列形は、要素ごとに1文を出す。**
   * それまでは配列形のとき入力の文が**1つも出ず**、単体形を配列形に書き換えるだけで
   * 要件ドキュメントから入力の記述が消えていた —— **「足りない」ではなく「それまで
   * 載っていたものが載らなくなる」欠落である**(ADR-0068 Consequences の悪い点5)。
   *
   * **単体形の生成物は1バイトも変えていない**(A3 の禁止形)。位置を持つテンプレートは
   * 別に3本足してあり、単体形の3本には `{position}` を1つも入れていない。
   */
  const declaredInput = fn.input;
  if (Array.isArray(declaredInput)) {
    declaredInput.forEach((element, position) => {
      const elementSource = manifestSource(`${base}/input/${position}`);
      const sourceTerm = termSlot("function_input_source", element.source);
      const common = { function_id: functionIdSlot(), position: numberSlot(position + 1) };
      if (element.source === "table") {
        out.push(
          draft(
            "automation",
            "automation.function_input_table_at",
            {
              ...common,
              table_id: idSlot(ctx.sets, "table_id", element.table),
              function_input_source: sourceTerm,
            },
            elementSource,
            attributed,
          ),
        );
      } else if (element.source === "view") {
        out.push(
          draft(
            "automation",
            "automation.function_input_view_at",
            {
              ...common,
              view_id: idSlot(ctx.sets, "view_id", element.view),
              function_input_source: sourceTerm,
            },
            elementSource,
            attributed,
          ),
        );
      } else {
        out.push(
          draft(
            "automation",
            "automation.function_input_record_at",
            { ...common, function_input_source: sourceTerm },
            elementSource,
            attributed,
          ),
        );
      }
    });
  }
  if (!Array.isArray(declaredInput)) {
    const sourceTerm = termSlot("function_input_source", declaredInput.source);
    if (declaredInput.source === "table") {
      out.push(
        draft(
          "automation",
          "automation.function_input_table",
          {
            function_id: functionIdSlot(),
            table_id: idSlot(ctx.sets, "table_id", declaredInput.table),
            function_input_source: sourceTerm,
          },
          inputSource,
          attributed,
        ),
      );
    } else if (declaredInput.source === "view") {
      out.push(
        draft(
          "automation",
          "automation.function_input_view",
          {
            function_id: functionIdSlot(),
            view_id: idSlot(ctx.sets, "view_id", declaredInput.view),
            function_input_source: sourceTerm,
          },
          inputSource,
          attributed,
        ),
      );
    } else {
      out.push(
        draft(
          "automation",
          "automation.function_input_record",
          { function_id: functionIdSlot(), function_input_source: sourceTerm },
          inputSource,
          attributed,
        ),
      );
    }
  }

  // `output: { ops: true }`(更新操作の配列を返す関数。ADR-0067)は出力フィールドを
  // 1つも持たないので、この段は0行を生む。**そのぶんを ADR-0068 A7 の1文が受ける**
  // —— それまでは出力について1文も出なかった。**返す操作の中身は書かない**
  // (op は実行時に島が生成するのでマニフェストに存在しない)。
  if (fn.output.ops === true) {
    out.push(
      draft(
        "automation",
        "automation.function_output_ops",
        { function_id: functionIdSlot() },
        manifestSource(`${base}/output/ops`),
        attributed,
      ),
    );
  }
  (fn.output.fields ?? []).forEach((field, position) => {
    out.push(
      draft(
        "automation",
        "automation.function_output_field",
        {
          function_id: functionIdSlot(),
          position: numberSlot(position + 1),
          field_id: idSlot(ctx.sets, "field_id", field.id),
          field_type: termSlot("field_type", field.type),
        },
        manifestSource(`${base}/output/fields/${position}`),
        attributed,
      ),
    );
  });

  (fn.capabilities ?? []).forEach((capability, position) => {
    out.push(
      draft(
        "automation",
        "automation.function_capability",
        {
          function_id: functionIdSlot(),
          capability_name: idSlot(ctx.sets, "capability_name", capability),
        },
        manifestSource(`${base}/capabilities/${position}`),
        attributed,
      ),
    );
  });
  return out;
}

function automationStatements(ctx: Context): DraftStatement[] {
  const app = ctx.manifest.app;
  return [
    ...(app.workflows ?? []).flatMap((workflow, index) => workflowStatements(ctx, workflow, index)),
    ...(app.functions ?? []).flatMap((fn, index) => functionStatements(ctx, fn, index)),
  ];
}

/**
 * 操作の**対象**を述べる(ADR-0025 改訂2)。
 *
 * これが無いと履歴節は「`add_view` が7回」としか書かず、**どの画面を足したのかが
 * 1つも分からない。** 帰属(リソース → 差分)は逆向きなので代わりにならない ——
 * 「この差分で何が起きたか」を前向きに辿る経路が、これである。
 *
 * 識別子は `historical_*` グループで照合する。**マニフェストの実在集合には照合しない**
 * —— 消された画面・改名前のフィールド・undo で巻き戻された差分の対象は、現在の
 * マニフェストに存在しないので、そこに照合すると**実際に起きた変更を述べようとしただけで
 * 生成が止まる**(§限界13)。
 */
function operationTargetStatements(
  ctx: Context,
  entry: ChangelogEntry,
  operation: Operation,
  position: number,
): DraftStatement[] {
  const source = entrySource(entry, `/operations/${position}`);
  const diffId = () => idSlot(ctx.sets, "diff_id", entry.diff_id);
  const at = () => numberSlot(position + 1);
  const table = (id: string) => idSlot(ctx.sets, "historical_table_id", id);
  const field = (id: string) => idSlot(ctx.sets, "historical_field_id", id);

  const tableTarget = (id: string): DraftStatement =>
    draft(
      "history",
      "history.operation_table",
      { diff_id: diffId(), position: at(), table_id: table(id) },
      source,
    );
  const fieldTarget = (tableId: string, fieldId: string): DraftStatement =>
    draft(
      "history",
      "history.operation_field",
      { diff_id: diffId(), position: at(), table_id: table(tableId), field_id: field(fieldId) },
      source,
    );

  switch (operation.op) {
    case "add_table":
      return [tableTarget(operation.table.id)];
    case "remove_table":
      return [tableTarget(operation.table)];
    case "change_table": {
      const out = [tableTarget(operation.table)];
      const renamed = operation.changes.id;
      if (renamed !== undefined && renamed !== operation.table) {
        out.push(
          draft(
            "history",
            "history.operation_rename_table",
            {
              diff_id: diffId(),
              position: at(),
              table_id: table(operation.table),
              new_id: table(renamed),
            },
            source,
          ),
        );
      }
      return out;
    }
    case "add_field":
      return [fieldTarget(operation.table, operation.field.id)];
    case "remove_field":
      return [fieldTarget(operation.table, operation.field)];
    case "change_field": {
      const out = [fieldTarget(operation.table, operation.field)];
      const renamed = operation.changes.id;
      if (renamed !== undefined && renamed !== operation.field) {
        out.push(
          draft(
            "history",
            "history.operation_rename_field",
            {
              diff_id: diffId(),
              position: at(),
              table_id: table(operation.table),
              field_id: field(operation.field),
              new_id: field(renamed),
            },
            source,
          ),
        );
      }
      return out;
    }
    case "add_view":
    case "update_view":
    case "remove_view":
      return [
        draft(
          "history",
          "history.operation_view",
          {
            diff_id: diffId(),
            position: at(),
            view_id: idSlot(
              ctx.sets,
              "historical_view_id",
              operation.op === "add_view" ? operation.view.id : operation.view,
            ),
          },
          source,
        ),
      ];
    case "add_workflow":
    case "update_workflow":
    case "remove_workflow":
      return [
        draft(
          "history",
          "history.operation_workflow",
          {
            diff_id: diffId(),
            position: at(),
            workflow_id: idSlot(ctx.sets, "historical_workflow_id", operation.workflow.id),
          },
          source,
        ),
      ];
    case "add_function":
    case "update_function":
    case "remove_function":
      return [
        draft(
          "history",
          "history.operation_function",
          {
            diff_id: diffId(),
            position: at(),
            function_id: idSlot(ctx.sets, "historical_function_id", operation.function.id),
          },
          source,
        ),
      ];
    case "set_roles":
      // **V8-M16-T03(台帳 J-G1b。18種目の op)。対象を述べる文を1つも作らない。**
      // **ここが3箇所のうち loud な1つである** —— case を書かないと返り値型の
      // 網羅性が崩れて `tsc --noEmit` が落ちる。
      //
      // **述べないのは、述べる対象が無いからである** —— 役割の一覧は app に1つしか
      // 無いので「どれ」が存在せず、**履歴節には `history.operation`(差分 X の N 番目の
      // 操作は set_roles である)がそのまま出る**(`diff_op` の語彙は `DIFF_OPS` から
      // 来るので自動追随する)。
      //
      // **宣言の中身(役割の識別子と表示名)を述べる文も作っていない。** 作るには
      // `ADR-0025` §3 の閉じた union にテンプレートを足すことになり、それは本タスクの
      // 範囲外である。**「要件定義書が役割を説明する」とは書かない。**
      return [];
    // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11` / `T-G12`。判定値 = 廃止】**
    // **ここに在った `case "set_user_kinds":`(3箇所のうち loud な1つ)を取り除いた。**
    // **`Operation` の union から `SetUserKindsOperation` が消えたので、残したままだと
    // 到達不能な case として `tsc --noEmit` が落ちる。**
    // **要件ドキュメントに、撤去した語彙についての文は1つも出ない**
    // (`src/kernel/user-kinds-retirement.test.ts` の (6) が機械で固定する)。
    case "set_theme":
      // **V3-M1-T03(ADR-0047。16種目の op)。対象を述べる文を1つも作らない。**
      // ここが3箇所のうち **loud** な1つである —— case を書かないと返り値型の網羅性が
      // 崩れて `tsc --noEmit` が落ちる(だから「落としても気づかない」ことは起きない)。
      //
      // **述べないのは、述べる対象が無いからである** —— 改訂2 が `history.operation_*` を
      // 足した動機は「`add_view` が7回としか書いておらず、**どの画面**を足したのかが
      // 1つも分からない」ことだった。テーマは app に1つしか無いので「どれ」が存在せず、
      // **履歴節には `history.operation`(差分 X の N 番目の操作は set_theme である)が
      // そのまま出る**(`diff_op` の語彙は `DIFF_OPS` から来るので自動追随する)。
      //
      // **テーマの中身(25スロットの値)を述べる文も作っていない。** 作るには
      // ADR-0025 §3 の閉じた union にテンプレートを足すことになり、それは本タスクの
      // 範囲外である。**「要件定義書がテーマを説明する」とは書かない**(v3-m1-t03a.md
      // の限界に、述べていないこととして記録した)。
      return [];
  }
}

/**
 * 履歴。**全行を出す**(ADR-0025 §8-4)—— 取り消された apply も履歴からは消さず、
 * 「取り消された」と明示して残す。取り消された apply は帰属の出典には使わないが、
 * 履歴としては事実である。
 *
 * **intent はここに逐語引用としてしか現れない**(限定10 / §F-12 の生命線)——
 * どの statement の主張の根拠にもしていない。`history.intent` が主張しているのは
 * 「この差分の意図として次が**記録されている**」だけである。
 */
function historyStatements(ctx: Context): DraftStatement[] {
  const undoBySeq = new Map<number, ChangelogEntry>();
  for (const entry of ctx.entries) {
    if (entry.kind === "undo" && entry.undo_target_seq !== null) {
      undoBySeq.set(entry.undo_target_seq, entry);
    }
  }

  const out: DraftStatement[] = [];
  for (const entry of ctx.entries) {
    const self = entrySource(entry, "");
    const diffIdSlot = () => idSlot(ctx.sets, "diff_id", entry.diff_id);
    if (entry.kind === "apply") {
      out.push(
        draft(
          "history",
          "history.applied",
          {
            seq: numberSlot(entry.seq),
            diff_id: diffIdSlot(),
            applied_at: idSlot(ctx.sets, "applied_at", entry.applied_at),
          },
          self,
        ),
      );
    } else if (entry.kind === "undo" && entry.undo_target_seq !== null) {
      // redo エントリも `undo_target_seq` を持つ(やり直した undo の seq。ADR-0032 §3)が、
      // それは「取り消し」ではないので history.undo としては描かない(kind を明示的に見る)。
      out.push(
        draft(
          "history",
          "history.undo",
          {
            seq: numberSlot(entry.seq),
            diff_id: diffIdSlot(),
            undo_target_seq: numberSlot(entry.undo_target_seq),
          },
          self,
        ),
      );
    }

    out.push(
      draft(
        "history",
        "history.intent",
        { diff_id: diffIdSlot(), intent: verbatimSlot(entry.intent, self, "intent") },
        self,
      ),
    );

    entry.operations.forEach((operation, position) => {
      out.push(
        draft(
          "history",
          "history.operation",
          {
            diff_id: diffIdSlot(),
            position: numberSlot(position + 1),
            diff_op: termSlot("diff_op", operation.op),
          },
          entrySource(entry, `/operations/${position}`),
        ),
      );
      out.push(...operationTargetStatements(ctx, entry, operation, position));
    });

    const undoEntry = undoBySeq.get(entry.seq);
    if (entry.kind === "apply" && undoEntry !== undefined) {
      out.push(
        draft(
          "history",
          "history.undone",
          {
            seq: numberSlot(entry.seq),
            diff_id: diffIdSlot(),
            undo_seq: numberSlot(undoEntry.seq),
          },
          self,
          [entrySource(undoEntry, "")],
        ),
      );
    }
  }
  return out;
}

// --- 公開API -----------------------------------------------------------------------

/**
 * 指定アプリの要件定義書を、その時点のマニフェストと changelog から生成する。
 *
 * **状態を1バイトも変えない参照系API**であり、生成物を保存しない(限定4 / 限定12)。
 * 配列順はマニフェスト由来のものが宣言順、changelog 由来のものが `seq` 昇順で、
 * 出力に生成時刻・ホスト名・バージョン・パスを1つも含めない(§6)。
 *
 * @param dataRoot データルート(`data/` 相当)。環境変数に依存させず必ず引数で受ける。
 * @param appId 対象アプリのID。
 * @throws `appId` が台帳に登録されていない場合、マニフェストが読めない場合、
 *         および実在集合から外れた識別子・区切り文字の混入を検出した場合(fail-closed)
 */
export function generateRequirementsDoc(dataRoot: string, appId: string): RequirementsDoc {
  const entries = getChangelog(dataRoot, appId);
  const manifest = readCurrentManifest(dataRoot, appId);
  const undone = undoneTargetSeqs(entries);
  const ctx: Context = {
    manifest,
    entries,
    sets: buildIdentifierSets(manifest, entries),
    undone,
    attribution: buildAttribution(entries, undone),
  };

  const drafts = [
    ...overviewStatements(ctx),
    ...featureStatements(ctx),
    ...screenStatements(ctx),
    ...dataStatements(ctx),
    ...automationStatements(ctx),
    ...historyStatements(ctx),
  ];
  const statements: RequirementStatement[] = drafts.map((item, index) => ({
    id: `S-${String(index + 1).padStart(3, "0")}`,
    ...item,
  }));

  return {
    app_id: manifest.app.id,
    statements,
    markdown: renderRequirementsMarkdown(statements),
    identifiers: toIdentifierLists(ctx.sets),
  };
}
