/**
 * v0 リソース語彙の TypeScript 型(handover.md 3.4 / 3.5)。
 *
 * 正準(single source of truth)は `schemas/manifest.schema.json` と
 * `schemas/diff.schema.json` の JSON Schema であり、この型定義はそれに
 * 手書きで対応させたもの。スキーマを変更したらこの型も必ず合わせること。
 *
 * 語彙は意図的に狭く保つ。**リソース種5・フィールド型7・差分op9**を拡張しない。
 * (差分op は V1-M1 / ADR-0010 で additive 4種 → 8種になり、ADR-0012 で
 * `remove_view` が加わって9種になった。`RESOURCE_KINDS` は1つも増えていない ——
 * ADR-0010 限定4 / ADR-0012 限定5。`FIELD_TYPES` は V2-M2 / ADR-0035 で `image` が
 * 8種目として加わり、**V5-M16 / ADR-0161 で `file` が9種目として加わった** ——
 * ADR-0035 §3 限定1 の「汎用 file 型は足さない」は ADR-0161 が無効化した。)
 */

/**
 * フィールド型の語彙(9種)。
 *
 * **`image` は V2-M2 / ADR-0035 が足した8種目である**(EC-G3。商品画像)。値は
 * `_files` に実在する file_id を指す TEXT であり、reference が `_id` を指すのと同型の
 * 実在制約を持つ(ADR-0035 §1b)。**画像変換・多画像モデルを足してはならない**
 * (ADR-0035 §3a)。
 *
 * **`file` は V5-M16 / ADR-0161 が足した9種目である**(`G-G12` / `G-G13`。画像に限らない
 * 一般のファイル)。値の形は `image` とまったく同じ(`_files` に実在する file_id を指す
 * TEXT)。**違うのは受け入れる種別・大きさの上限・配信の形の3点だけである**:
 *
 * - **受け入れる種別の制限は0件である**(`D-V5-84`。ADR-0161 限定6 =「4種の有限列挙」を
 *   ユーザ決定が覆し、ADR-0214 が無効化した)。**HTML も SVG も zip も 415 にならない。**
 * - **上限は 1件 20,000,000 バイト**(ADR-0161 限定7)。**`image` の 5 MiB は1バイトも
 *   変わっていない**(限定2)。
 * - **配信は「実体が4種の画像と判定できないなら必ずダウンロード」である**
 *   (`Content-Disposition: attachment` + `application/octet-stream` + `nosniff`)。
 *   **蓄積型 XSS を成立させないための実装の前提であって、種類の制限ではない。**
 * - **`file` は未認証配信しない**(ADR-0161 限定5)。**`image` より狭い。**
 *
 * **10種目を足すには門A の新規審査 + 個別 ADR を要する**(ADR-0161 §3a の 1。
 * **「`file` が通ったから」は理由にならない**)。
 */
export const FIELD_TYPES = [
  "text",
  "long_text",
  "number",
  "boolean",
  "date",
  "select",
  "reference",
  "image",
  "file",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/**
 * 画面(ビュー)種別の語彙(3種)。app / table と合わせてリソース種5種になる。
 *
 * **【2026-08-14 追記(`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`)。上の1行は今日は偽である。
 * 旧文を1バイトも書き換えていない】** **今日は4種である** —— **`report_view`(集計表)が
 * 4種目として加わった。** **足した理由は1つだけである**: **束ねて数える画面は、行を1行ずつ
 * 並べる `list_view` の `columns` / `sort` / `sum_field` のどれでも表せない**(束ねるキーを
 * 書く場所そのものが無い)。**`sum_field`(`ADR-0104` 限定8)は `group_by` を1バイトも
 * 開いていないと明記しており、開くには新しい器が要った。**
 *
 * **置き換えとなる新しい不変条件: 5種目を足してはならない。** 足すには `ADR-0007` の門A を
 * 改めて通し、個別 ADR を書くこと —— **`chart_view` / `dashboard` / `pivot_view` を
 * 「同じ理由で」足してはならない**(グラフは本種別が返す集計値の**描き方**であって、
 * 画面種別ではない)。
 *
 * **並び順は意味を持つ** —— **語彙外エラーの `allowed_values` がこの順で出る**
 * (`src/kernel/validate.test.ts` が `schemas/manifest.schema.json` の `$defs/view_type` の
 * `enum` と `toEqual` で突き合わせている)。**追加された順序を保つため末尾に足してある。**
 */
export const VIEW_TYPES = ["form", "list_view", "detail_view", "report_view"] as const;
export type ViewType = (typeof VIEW_TYPES)[number];

/**
 * リソース種の語彙(7種)。
 *
 * **`workflow` は ADR-0013 が足した6種目である**(限定1: 足すのは1つだけ。
 * `trigger` / `action` / `connection` / `schedule` を**リソース種として足してはならない**
 * —— それらは `workflow` の中のキーである)。
 *
 * **`function` は ADR-0024 が足した7種目である**(V1-M6。**ADR-0013 限定1
 * 「リソース種は1つだけ(workflow)」の系を破る**。ADR-0024 §4 限定1 が新しい閉じを
 * 与える —— `procedure` / `script` / `macro` / `job` を足してはならない。計算フィールド型も
 * 足さない。呼び出し口はワークフローアクション `run_function` 1つに限定する)。
 *
 * **この配列に入ることは `table` と同格になることを意味しない**(ADR-0013 §1a-2)。
 * 現に `app`(全体を束ねる入れ物)と `detail_view`(1画面)が同じ配列に並んでいる。
 * 実体は「AI に列挙して見せるリソース種の一覧」であり、値としての消費先は
 * `src/mcp/vocabulary.ts` の `VOCABULARY_SCOPE` の説明文組み立て1箇所だけである。
 */
export const RESOURCE_KINDS = [
  "app",
  "table",
  "form",
  "list_view",
  "detail_view",
  "workflow",
  "function",
  // **`report_view` は `V8-M8` が足した8種目である**(台帳 `Q-G1`。門A 本審査 = `V8-M7`。
  // 審査記録 `docs/plan/v8/records/v8-m7.md`)。**`ADR-0024` §4 限定1(`procedure` /
  // `script` / `macro` / `job` を足してはならない)を1バイトも引き直していない** ——
  // **本種別はそのどれでもなく、既に在る「画面」の4種目である。**
  // **末尾に足してあるのは追加された順序を保つためであって、`detail_view` の隣に置くと
  // 既存の位置が全部ずれるからでもある**(`DIFF_OPS` が採っているのと同じ作法)。
  // **【正直に書く】この配列の唯一の消費先は `src/mcp/vocabulary.ts` の説明文組み立て
  // 1箇所である**(上の doc コメント)—— **足したことで AI に見える一覧が1語増える。**
  "report_view",
] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/**
 * 差分パッチの op 語彙(12種)。**並び順は意味を持つ**(テストが `toEqual` で固定し、
 * 語彙外エラーの `allowed_values` もこの順で出る)。
 *
 * 1. **先頭4種は additive**(足すだけ。既存の定義もデータも失わない)。
 * 2. **続く4種は破壊的**(V1-M1 / ADR-0010。既存の定義とデータを実際に変更・削除する)。
 * 3. **末尾の `remove_view` は、そのどちらでもない**(ADR-0012)。画面定義を1つ
 *    取り除くだけで、**テーブル・フィールド・レコードを1バイトも失わない。**
 *    破壊的4種の後ろに置いてあるのは追加された順序を保つためであって、
 *    「破壊的5種になった」という意味ではない。**この区別は実装に効いている** ――
 *    変換不能値の規則(`convert.ts` / ADR-0010 §5b・§6b)は `remove_view` に
 *    適用されないし、`migrate.ts` は MigrationStep を1つも生まない。
 *
 * 4. **末尾3種は ADR-0013 が足したワークフロー3種**(`add_workflow` /
 *    `update_workflow` / `remove_workflow`)。これも破壊的ではない ―― マニフェストの
 *    `workflows` を1つ足す・変える・取り除くだけで、**テーブル・フィールド・レコードを
 *    1バイトも失わない。**ただし `remove_workflow` は `remove_view` と違い、
 *    **消しても何も戻らない**(ワークフローが既に書いた行は残り、消えていた間に
 *    起きるはずだった発火は起きない。ADR-0013 §2(e))。
 *
 * **12種で閉じている。**`remove_app` / `patch_manifest` / `copy_field` を「同じ理由で」
 * 足してはならない(ADR-0010 限定1 / ADR-0012 限定1)。**`run_workflow` /
 * `pause_workflow` / `enable_workflow` も同じく足してはならない**(ADR-0013 限定2。
 * 手動実行を通したくなったときの追加関門は ADR-0013 §4a)。足すなら ADR-0007 の門A を
 * 改めて通し、個別 ADR を書くこと ―― `remove_field` が通ったことが `remove_view` の
 * 理由にならなかった(前者はデータを失うので変換不能値の規則が要り、後者は1バイトも
 * 失わない)のと同じく、**`remove_view` が通ったことは次の op の理由にならない。**
 *
 * 5. **末尾3種は ADR-0024 が足した関数3種**(`add_function` / `update_function` /
 *    `remove_function`。12種 → 15種)。これも破壊的ではない ―― マニフェストの
 *    `functions` を1つ足す・変える・取り除くだけで、**テーブル・フィールド・レコードを
 *    1バイトも失わない。**`remove_workflow` と同型に、`remove_function` も消しても
 *    何も戻らない(その関数が既に output_table に書いた行は残る。ADR-0024 §8)。
 *    **`run_function` の diff op 版・`pause_function`・`enable_function` を足しては
 *    ならない**(ADR-0024 限定9。手動実行を通したくなったときの追加関門は §4a)。
 *
 * 6. **末尾の `set_theme` は ADR-0047 が足した16種目**(15種 → 16種。V3-M1-T03 /
 *    D-G2)。これも破壊的ではない ―― マニフェストの `app.theme` を**丸ごと差し替える**
 *    だけで、**テーブル・フィールド・レコード・ビュー・ワークフロー・関数を1バイトも
 *    失わない。****op は1つだけである**(ADR-0047 限定3)—— 部分更新・削除・複製の op を
 *    足してはならない(足すなら「全体差し替えで表せないこと」を1つ示したうえで
 *    ADR-0047 §3a 5 の門を通すこと)。**v3 が語彙の総量を初めて増やす決定であり**
 *    (v2 は6マイルストーンすべてを語彙ゼロ増で通した)、その事実は
 *    `docs/adr/0047-app-theme-manifest.md` §2 (a) に不利な材料として書いてある。
 */
export const DIFF_OPS = [
  "add_table",
  "add_field",
  "add_view",
  "update_view",
  "remove_field",
  "remove_table",
  "change_table",
  "change_field",
  "remove_view",
  "add_workflow",
  "update_workflow",
  "remove_workflow",
  "add_function",
  "update_function",
  "remove_function",
  "set_theme",
  // **7. 末尾の `set_user_kinds` は ADR-0248 が足した17種目**(16種 → 17種。`V5-M17b` /
  //    ユーザ決定 `D-V5-87`)。**`set_theme` と同じ形で破壊的ではない** —— マニフェストの
  //    `app.user_kinds` を**丸ごと差し替える**だけで、テーブル・フィールド・レコード・
  //    ビュー・ワークフロー・関数・テーマを1バイトも失わない。**op は1つだけである**
  //    (ADR-0248 限定1)—— 部分更新・削除の op を足してはならない。
  //    **宣言を「無い状態」へ戻す手段は今日も語彙に1つも無い**(限定3)。
  //    **`ADR-0158` 限定6(`DIFF_OPS` を1つも動かさない)を正面から破っている** ——
  //    破る手続き(門A の本審査 + 同格の個別 ADR)は `ADR-0158` §3a の 5 が要求しており、
  //    `ADR-0248` がその ADR である。**「限定6 を守った」とは書かない。**
  //
  //    **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11`。判定値 = 廃止】**
  //    **`set_user_kinds` をこの配列から取り除いた**(18 → 17)。**上の 7. の本文は
  //    `ADR-0248` 制定時の事実であり、1バイトも書き換えていない。**
  //    **代わりに立つのは下の `set_roles` である** —— **どちらも「app に1つしか無い
  //    宣言を丸ごと差し替える」同型の op であり、対象IDを取らない。**
  //    **書き込む先の `app.user_kinds` が同じ差分で消えるので、この op だけを残す
  //    ことはできない**(`ADR-0301` 限定2 の「取り除いたあとに何が担うか」への答え)。
  // **8. 末尾の `set_roles` は `V8-M16-T03` が足した18種目**(17種 → 18種。台帳 `J-G1b` /
  //    ユーザ決定 `D-V8-31`。`ADR-0007` 門A 本審査 = 限定採用)。**`set_theme` /
  //    `set_user_kinds` と同じ形で破壊的ではない** —— マニフェストの `app.roles` を
  //    **丸ごと差し替える**だけで、テーブル・フィールド・レコード・ビュー・
  //    ワークフロー・関数・テーマ・利用者の種類の宣言を1バイトも失わない。
  //    **op は1つだけである** —— 部分更新・削除・付与の op を足してはならない。
  //    **宣言を「無い状態」へ戻す手段は今日も語彙に1つも無い**(`set_theme` /
  //    `set_user_kinds` と同型。空配列はスキーマの `minItems: 1` が拒否する)。
  //    **`set_user_kinds` が通ったことは18種目の理由ではない** —— 理由は
  //    「役割は予約4語(`owner` / `editor` / `viewer` / `anonymous`)を主体として
  //    書けなければ成立せず、`user_kinds` はその4語を1語も書けない」ことである。
  //    **【正直に書く】判定の実装は `V8-M16` に1バイトも無い** —— 規則(`rules`)は
  //    `V8-M17`、条件(`when`)は `V8-M18` が足す。
  "set_roles",
] as const;
export type DiffOp = (typeof DIFF_OPS)[number];

/** ソート順の語彙。 */
export const SORT_ORDERS = ["asc", "desc"] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

/**
 * リソースID(`^[a-z][a-z0-9_-]*$`、1〜64文字。kebab-case / snake_case のどちらも可)。
 *
 * **例外: `ListView.table` / `FormView.table` / `DetailView.table` にはこの規約が
 * そのままは当てはまらない。** これらは読み取り専用のシステムテーブル
 * (`_apps` / `_changelog`、ADR-0006)も取りうるため、英小文字始まりとは限らない。
 * スキーマ側では `$defs/view_table_id` が対応する(`$defs/resource_id` ではない)。
 *
 * 型を分けないのは ADR-0006 §1 の限定2(新しい型を1つも作らない)による意図的な判断で
 * ある。`ResourceId` は実体が `string` の別名で型検査上の区別を生まないため、分けても
 * 得られる保証は無く、`Manifest` 型の形が変わったという事実だけが残る。乖離は
 * 「型がスキーマより緩い」方向のみであり、検証の最終権限が JSON Schema 側にあるという
 * 冒頭の関係は保たれている。
 */
export type ResourceId = string;

/**
 * select 以外の型では options を、reference 以外の型では reference_table を持てない。
 *
 * `image`(ADR-0035)は付帯キーを持たない点で基本型(text 等)と同じだが、**独立した
 * バリアントとして分けてある** —— 検証で `db` を要する2型(reference / image)を型レベルで
 * 基本6型(`DbFreeField`。`records.ts`)から差し引けるようにするためである。付帯キーの
 * 有無ではなく「実在確認に db が要るか」でバリアントを割った、という非対称を明示しておく。
 */
/**
 * **`unique?` は EC-G8 / ADR-0038 が全型に足した任意の制約フラグである**(単一列の一意
 * 制約。省略時 false)。`required` と同型のフラグで、`options` / `reference_table` のような
 * 型依存の付帯キーではない —— だから4バリアント全部に同じ形で持たせる(型ごとの非対称を
 * 作らない)。**DDL 制約にはしない**(`ddl.ts` は1バイトも見ない。ADR-0010 限定5/6 維持)——
 * 担保はアプリ層の書込時検査(`records.ts` の `createRecord` / `updateRecord` が同値の他行を
 * 照会して拒否する)と後付け時の既存重複拒否(`apply-diff.ts` の `change_field`)である。
 * **複合ユニーク(2列以上の組)は足さない**(ADR-0038 §3a。単一列のみ)。
 *
 * **【V4-M10-T07 / E-G66 / ADR-0078 で値域を1語広げた】** **`true` = テーブル全体で一意 /
 * `"owner"` = 同じ持ち主(予約規約フィールド `st_owner`)の中だけで一意。** **キーは1つも
 * 増えていない**(限定1)。**スコープは持ち主の1つだけで、列名を書ける形にしていない**
 * (限定2。値域は有限の列挙で schema が機械的に閉じる)—— **任意の列の組で一意にする
 * 「複合ユニーク」は今日も書けない**(`ADR-0038` §3a-1 が予約したまま)。
 * **共有行(`st_owner` が `null` / 空文字)も1つのスコープとして扱い、その中で一意になる**
 * (`V4-M10-T07` 完了条件6 の決定)。**TOCTOU の窓は1ミリも狭まらない**(限定9)。
 */
export type Field =
  | {
      id: ResourceId;
      name: string;
      type: Exclude<FieldType, "select" | "reference" | "image" | "file">;
      required?: boolean;
      unique?: boolean | "owner";
      /**
       * この値が何の単位か(`E-G14` / `F-9` の4回目。`V4-M10-T46` / `ADR-0086`)。
       *
       * **`number` 型にだけ書ける**(限定4)。**他の7型に書いた差分は全体が拒否される**
       * —— 形の担保はマニフェストスキーマの `allOf`(`options` / `reference_table` と
       * 同じ3本目の分岐)であり、**ここでは型の上で分けていない**(この分岐は `number`
       * だけでなく `text` / `long_text` / `boolean` / `date` も含むため)。
       *
       * **値は短い文字列1つだけである**(限定3)—— 配列でも通貨コードの enum でもない。
       * **描画は「値の後ろに置く」1通りだけで、位置をアプリが選べない**(限定5)。
       * **桁区切りは1バイトも動かない**(限定6)—— **`4256 点` と `24,724 円` は今日も
       * 違う書式で並ぶ。**
       *
       * **既定は「単位を出さない」**(限定9)。**`FIELD_TYPES` は8のままである**(限定2)(**【`V5-M16` / `ADR-0161` による追記】今日の `FIELD_TYPES` は9である。この限定が言うのは「その決定が増やさなかった」ことであり、その事実は今日も変わらない**)。
       */
      unit?: string;
      /**
       * **値が無いとき、この項目の行ごと画面から出すか**(`E-G17` / `D-V4-84` の一部。
       * `V4-M19-T07` / `ADR-0119` 限定1〜限定12)。
       *
       * **`$defs/field` の12キー目である。** **9型すべてに書ける** —— 値が無いことは
       * どの型でも起こるので、型で絞っていない(`unit` が `number` 限定・`emphasis` が
       * `select` 限定であるのと違う)。**したがって4つのバリアントすべてに在る。**
       *
       * **値は真偽値1つである**(限定2)—— **条件式・比較・しきい値・`when` を1つも
       * 作らない。** **「ある項目の値が0のときだけ隠す」は今日も明日も書けない。**
       *
       * **既定は「出す」であり、既定を反転させない**(限定3)—— **書かなかった項目は
       * 今日どおり「未設定」と出る。** **空文字 `""` の扱いを1バイトも変えない** ——
       * **空文字は今日も「値がある」側であり、宣言しても行は残る。**
       *
       * **効くのは詳細画面の項目の行だけである**(限定4)—— **一覧の列にも入力フォームにも
       * `related` の子一覧にも効かない。** **機械では止めていない**(描画側が当てないだけ)
       * ので、**黙って効かないままにしない**ことを `src/mcp/vocabulary.ts` が明記する。
       *
       * **消えるのは行ごとである**(限定5)—— **項目名も一緒に消える。**
       *
       * **`change_field` で後から書けて、値が実際に運ばれる** —— `buildChangedField` が運ぶ。
       * **前進で `false` に戻せる**(限定11。実測済み)—— **キーそのものは残るが、書く前の
       * 見え方には戻せる。** **`preset_` キーと違う性質である。**
       *
       * **アプリが「この項目は消してよい」と主張し、カーネルはその主張を1度も検証しない**
       * (`ADR-0047` 限定7 と同型)。**`FIELD_TYPES` は8のままである**(限定7)(**【`V5-M16` / `ADR-0161` による追記】今日の `FIELD_TYPES` は9である。この限定が言うのは「その決定が増やさなかった」ことであり、その事実は今日も変わらない**)。
       */
      hide_when_empty?: boolean;
    }
  | {
      id: ResourceId;
      name: string;
      type: "select";
      required?: boolean;
      unique?: boolean | "owner";
      options: string[];
      /**
       * この値のうち、どれが注意を要するか(`P-G28` + `P-G22` の (C) 側。
       * `V4-M16-T10` / `ADR-0090`)。
       *
       * **`select` 型にだけ書ける**(限定4)—— **だからこのバリアントにしか無い。**
       * **他の7型に書いた差分は全体が拒否される**(`unit` と違い、形の担保は
       * マニフェストスキーマの `allOf`(4本目の分岐)**と** `foldChangeField` の
       * 名指しの拒否の2箇所にある)。
       *
       * **キーはそのフィールドの `options` の値、値は有限 enum 4値だけである**(限定3)
       * —— **色の実値も CSS 文字列も1バイトも書けない。**
       * **`options` に無い値をキーに書くと、`validateReferentialIntegrity` が
       * 差分全体を拒否する**(限定4 後段)。
       *
       * **型エイリアスを新設していない**(`scripts/kernel-export-drift.test.ts` が
       * export の増加を検出する)—— ユニオンをインラインで書く。
       *
       * **既定は「強調しない」**(限定8)。**書かなかったフィールドと、対応表に載せ
       * なかった値は今日と1ピクセルも変わらない。**
       * **`FIELD_TYPES` は8のままである**(限定2)(**【`V5-M16` / `ADR-0161` による追記】今日の `FIELD_TYPES` は9である。この限定が言うのは「その決定が増やさなかった」ことであり、その事実は今日も変わらない**)。
       */
      emphasis?: Record<string, "neutral" | "info" | "caution" | "danger">;
      /**
       * 値が無いとき、この項目の行ごと画面から出すか(`V4-M19-T07` / `ADR-0119`)。
       * 詳細は最初のバリアントの `hide_when_empty`。**9型すべてに書けるので5つの
       * バリアントすべてに在る。**
       */
      hide_when_empty?: boolean;
    }
  | {
      id: ResourceId;
      name: string;
      type: "reference";
      required?: boolean;
      unique?: boolean | "owner";
      reference_table: ResourceId;
      /**
       * この参照項目を画面でどう選ばせるか(`K-G1`。`V6-M1-T01` / `ADR-0288` 限定1〜限定4)。
       *
       * **`reference` 型にだけ書ける**(限定4)—— **だからこのバリアントにしか無い。**
       * **他の8型に書いた差分は全体が拒否される**(`emphasis` と同じく、形の担保は
       * マニフェストスキーマの `allOf`(5本目の分岐)**と** `foldChangeField` の
       * 名指しの拒否の2箇所にある)。
       *
       * **値域は有限3値で閉じる**(限定2)—— `list`(今日どおり一覧から選ぶ)/
       * `type_filter`(打った文字で候補を絞る)/ `search`(別の面を開いて探す)。
       * **4値目を書いた差分は全体が拒否される。** **値の名前に器の名前を1つも書かない**
       * —— **どの器で描くかはマニフェストに1バイトも現れない**(`ADR-0094` 限定1)。
       *
       * **型エイリアスを新設していない**(`scripts/kernel-export-drift.test.ts` が
       * export の増加を検出する)—— ユニオンをインラインで書く(`emphasis` と同じ作法)。
       *
       * **既定は「今日どおりのプルダウン」**(限定3 = `K-G5`)。**書かなかった項目の画面は
       * 今日と1バイトも変わらない。** **既定値を持つのは表示層の1箇所**
       * (`web/src/fields/input.tsx` の `DEFAULT_REFERENCE_PICKER`)であり、
       * **カーネルは既定を1つも持たない。**
       *
       * **【正直に書く】`type_filter` と `search` の描画は今日1バイトも実装されていない**
       * (当たり先は `V6-M4` / `V6-M5`)。**今日この2値を書いても画面は今日どおりの
       * プルダウンのままである** —— **書けるが今日は効かない。**
       */
      reference_picker?: "list" | "type_filter" | "search";
      /**
       * この参照項目で候補を探すときに照合する列(`K-G7`。`V6-M3-T02` /
       * `ADR-0290` 限定1〜限定6)。
       *
       * **`reference` 型にだけ書ける** —— **だからこのバリアントにしか無い。**
       * **他の8型に書いた差分は全体が拒否される**(`reference_picker` と同じく、
       * 形の担保はマニフェストスキーマの `allOf`(6本目の分岐)**と**
       * `foldChangeField` の名指しの拒否の2箇所にある)。
       *
       * **値は参照先テーブル(`reference_table` が指す先)に実在する `text` /
       * `long_text` のフィールドIDの配列で、1本以上8本以下・重複不可である。**
       * **役割の規則(`app.roles[].rules`)が名指ししている項目は書けない。**
       * **【2026-08-10 追記(`V8-M20-T02`。台帳 `J-G28`)。旧文を1バイトも消していない】**
       * **1つ上の行の着手前の逐語は「`audience` を宣言した項目は書けない。」だった** ——
       * **そのキーは `V8-M20` が廃止したので、同じ問いを面について問い直してある。**
       * **照合先は「選ぶ相手のテーブル」であり、`Table` 側の同名キーとまったく
       * 同じ規則である**(書いた場所によって別のテーブルを指すことは無い)。
       *
       * **優先順位は「項目 > テーブル > 代表の1本」の1本だけである**(限定10)——
       * **画面は入らない**(`D-V6-20`。`$defs/view` に置き場を作っていない)。
       * **どちらも書かなければ `web/src/fields/reference-label.ts` の
       * `representativeField` が解決した1本が対象になる**(限定7)。
       * **既定を持つのは表示層の1箇所だけであり、カーネルは既定を1つも持たない。**
       *
       * **型エイリアスを新設していない**(`scripts/kernel-export-drift.test.ts` が
       * export の増加を検出する)。
       *
       * **【正直に書く】照合の実装は今日1バイトも無い**(当たり先は `V6-M4`)。
       */
      reference_search_fields?: ResourceId[];
      /**
       * 値が無いとき、この項目の行ごと画面から出すか(`V4-M19-T07` / `ADR-0119`)。
       * 詳細は最初のバリアントの `hide_when_empty`。**9型すべてに書けるので5つの
       * バリアントすべてに在る。**
       */
      hide_when_empty?: boolean;
    }
  | {
      id: ResourceId;
      name: string;
      type: "image";
      required?: boolean;
      unique?: boolean | "owner";
      /**
       * 値が無いとき、この項目の行ごと画面から出すか(`V4-M19-T07` / `ADR-0119`)。
       * 詳細は最初のバリアントの `hide_when_empty`。**9型すべてに書けるので5つの
       * バリアントすべてに在る。**
       */
      hide_when_empty?: boolean;
    }
  | {
      id: ResourceId;
      name: string;
      /**
       * **`file` は `image` とまったく同じ形のバリアントである**(`V5-M16` / `ADR-0161`
       * 限定3)—— 値は `_files` に実在する file_id を指す TEXT で、`options` も
       * `reference_table` も `unit` も `emphasis` も持たない。
       *
       * **`image` と同じバリアントに畳まず、5本目として分けてある。** 畳んで
       * `type: "image" | "file"` にすると、**判別子が単一のリテラルでなくなり、
       * `records.ts` / `read-records.ts` の絞り込み(`field.type === "image" ||
       * field.type === "file"` の**否定側**)がこのバリアントを落とせなくなる**
       * (`exactOptionalPropertyTypes: true` の下で `DbFreeField` への代入が
       * TS2379 で落ちることを実測した)。**バリアントは4本 → 5本になった。**
       * **`$defs/field.properties` のキー数は12のままである**(限定1)。
       */
      type: "file";
      required?: boolean;
      unique?: boolean | "owner";
      /**
       * 値が無いとき、この項目の行ごと画面から出すか(`V4-M19-T07` / `ADR-0119`)。
       * 詳細は最初のバリアントの `hide_when_empty`。**9型すべてに書けるので5つの
       * バリアントすべてに在る。**
       */
      hide_when_empty?: boolean;
    };

/** データ定義。 */
export type Table = {
  id: ResourceId;
  name: string;
  fields: Field[];
  /**
   * このテーブルが参照されたときの「探せる項目」の既定(`K-G6`。`V6-M3-T01` /
   * `ADR-0290` 限定1〜限定6)。
   *
   * **値は自テーブルに実在する `text` / `long_text` のフィールドIDの配列で、
   * 1本以上8本以下・重複不可である**(限定2 / 限定3)。**役割の規則
   * (`app.roles[].rules`)が名指ししている項目は書けない**(限定5。
   * **【`V8-M20-T02`。台帳 `J-G28`】着手前の逐語は「`audience` を宣言した項目は
   * 書けない」。そのキーは廃止されたので、同じ問いを面について問い直した**)。
   * **3つの検査は `src/kernel/referential-integrity.ts`
   * の1箇所が行い、`add_table` / `change_table` の両経路を覆う**(限定6)。
   * **拒否は「全か無か」である。**
   *
   * **`representative_field` はこの型に現れない** —— **あちらは `src/kernel/` に
   * 1バイトも差分を出さない限定(`ADR-0080` 限定6)の下で作られたので、表示層が
   * 型の外側から `unknown` として読む。** **本キーはカーネルが検査するので型に
   * 現れる。** **この非対称は隠さない。**
   *
   * **型エイリアスを新設していない**(`scripts/kernel-export-drift.test.ts` が
   * export の増加を検出する)。
   *
   * **【正直に書く】照合の実装は今日1バイトも無い**(当たり先は `V6-M4`)——
   * **今日この宣言を書いても、画面の候補は今日どおり全件がプルダウンに出る。**
   */
  reference_search_fields?: ResourceId[];
  /**
   * **この表でアクセス権管理を使うことの宣言**(`Z-G2` 〜 `Z-G20` / `Z-G37`。
   * `V7-M1-T01` が `schemas/manifest.schema.json` に、`V7-M1-T03` が
   * `schemas/diff.schema.json` の `table_changes` に置いた。**値域の正はあちらである** ——
   * **この型は値域を1つも狭めない**)。
   *
   * **書かない表は今日と1バイトも変わらない**(オプトイン)。**`enabled: false` は
   * 「宣言していない表」と同じ扱いである。**
   *
   * **`change_table` で後から書けて、値が実際に運ばれる** —— `foldChangeTable`
   * (`apply-diff.ts`)が運ぶ。**`add_table` でも残る**(`foldAddTable` が
   * `structuredClone` で表ごと積むため、本タスクは `add_table` 側に1バイトも
   * 足していない)。**`representative_field` は同じ `table_changes` に在りながら
   * 値が運ばれない**(受理されるが適用後マニフェストに残らない)——
   * **その穴を本キーでは踏まない。****全置換である。**
   *
   * **型エイリアスを新設していない**(`scripts/kernel-export-drift.test.ts` が
   * export の増加を検出する)。**`representative_field` はこの型に現れないままである。**
   *
   * **【正直に書く】判定の実装は今日1バイトも無い**(当たり先は `V7-M2` 以降)——
   * **今日この宣言を書いても、行の読取・書込・削除のふるまいは今日どおりである。**
   * **指した表・列の実在も型も、今日は1つも検査していない**(`V7-M1-T05`)。
   */
  access_control?: {
    enabled: boolean;
    permissions: {
      id: string;
      name: string;
      read: boolean;
      write: boolean;
      delete: boolean;
      restrictive?: boolean;
    }[];
    creator_permission: string;
    grant: {
      table: ResourceId;
      target: ResourceId;
      member?: ResourceId;
      group?: ResourceId;
      permission: ResourceId;
    };
    members?: { table: ResourceId; account: ResourceId; group?: ResourceId };
    groups?: { table: ResourceId };
    inherit_from?: ResourceId[];
    /**
     * **【`V15-M1-T03`。`CR-G2` / `ADR-0405`】8キー目。**
     * **この表に行を作れる権限名**(`permissions[].id` のいずれか)を並べる。
     *
     * **`creator_permission` とは別のものである** —— あちらは「行を作った人に
     * **何が渡るか**」、こちらは「**そもそも誰が作れるか**」であり、1つのキーに
     * 2つの意味を持たせない(`D-V15-4`「分ける(兼用をやめる)」)。
     *
     * **型は `ResourceId` ではなく素の文字列である** —— 指すのは表や項目のIDでは
     * なく、この表が宣言した権限名だからである。**新しい型エイリアスを1本も
     * 新設していない**(`export` を1本も増やさない。`Δ8` は空のまま)。
     *
     * **【正直に書く】判定の実装は今日1バイトも無い**(当たり先は `V15-M2`)——
     * **今日この宣言を書いても、行を作れるかどうかのふるまいは今日どおりである。**
     * **書けるのは `inherit_from` を宣言した表だけで、要素が `permissions[].id` に
     * 実在することも含めて、見るのは適用時検査(`referential-integrity.ts` の項目10)
     * である**(`ADR-0405` 限定5 / 限定6)。
     */
    creatable_by?: readonly string[];
    /**
     * **【`V17-M5-T03b`。`AC-G10` / `ADR-0412`】9キー目。**
     * **`inherit_from` を持たない根の表に行を作れる役割**(`app.roles[].id` のいずれか)
     * を並べる。
     *
     * **8キー目 `creatable_by` とは別のものである**(`ADR-0412` §Decision の 2 の 7)——
     * **あちらは「親に書ける人のうち、どの権限名か」、こちらは「親の無い表について、
     * どの役割か」である。** **1つのキーに2つの名前空間を持たせない**(同 限定3)。
     *
     * **綴りは `ADR-0412` が決めていない**(同 §Decision の 6 の逐語「**本 ADR は綴りを
     * 1文字も決めない。**」)—— **`creatable_by_roles` に決めたのは `V17-M5-T03`
     * (ユーザ決定 `D1`。2026-09-08)である。**
     *
     * **型は `ResourceId` ではなく素の文字列である** —— 指すのは表や項目のIDではなく、
     * このアプリが宣言した役割名だからである。**新しい型エイリアスを1本も新設していない**
     * (`export` を1本も増やさない)。
     *
     * **`required` に入れない**(`ADR-0412` 限定2)—— **書かなかった表は今日と1バイトも
     * 変わらない。**
     *
     * **【2026-09-17 訂正(`V18-M9-T11` / `ADR-0446` 授権の表 行6 / ユーザ決定 `D-V18-37`)。**
     * **直前の2行を1バイトも消していない】** **第2文「**書かなかった表は今日と1バイトも
     * 変わらない。**」は今日は偽である** —— **`V18-M5`(審査の単位 `PM-G2` / `ADR-0432`)が
     * 根の表の既定を反転させた。** **権限管理を宣言して `enabled: true` であり、
     * `inherit_from` を1本も書かず、本キーを1件も書いていない表では、**運営(`owner`)を
     * 含めて誰も行を作れない**(`403`)。**
     * **担保は `src/server/root-create-closed-by-default.test.ts` の `(A-1)` / `(A-2)` /
     * `(A-3)` であり、述語は `src/server/owner-scope.ts` の `judgeRootCreatableRoles` が
     * 返す3値のうち `"undeclared"` の枝である。**
     * **第1文(`required` に入れない)は今日も真である** —— **`required` は今日も4本の
     * ままである。**
     * **本キーを書かなくても今日と1バイトも変わらないのは、権限管理を宣言していない表 /
     * `enabled: false` の表 / `inherit_from` を宣言した表 の3つだけである**
     * (同 `(C-1)` / `(C-2)` / `(C-3)`)。
     *
     * **書けるのは `inherit_from` を宣言していない表だけで、要素が `app.roles[].id` に
     * 実在することも含めて、見るのは適用時検査(`referential-integrity.ts` の項目11)
     * である。** **後者(根の表専用であること)の拒否は `ADR-0412` の限定表に無く、
     * `V17-M5` の計画(§3-3 の (3))が足したものである。**
     *
     * **【正直に書く】この型を書いた時点(`V17-M5-T03b`)で判定の実装は1バイトも無い** ——
     * **宣言を書けるようになるだけで、行を作れるかどうかは1ミリも変わらない。**
     * **当たり先は同じ段の `V17-M5-T03d` である。**
     */
    creatable_by_roles?: readonly string[];
  };
};

/**
 * 一覧の並び順の**キー1つ**(V1-M0-T03 / F-2 / F-8)。
 *
 * `sort` を書く場所(`ListView.sort` / `ViewChanges.sort` / `ListRecordsOptions.sort`)は
 * **`Sort | Sort[]` の両方を受ける**。配列は複合ソートで、先頭が第1キー、同値のときに
 * 次のキーで決まる。単数オブジェクトは v0 からの表記で、**受理し続ける**
 * (理由は `docs/plan/v1/records/v1-m0-t03.md` §完了条件2 の決定)。
 *
 * **語彙(`RESOURCE_KINDS` / `FIELD_TYPES` / `DIFF_OPS`)は1つも増えていない。**
 * 増えたキーも無く、既存キー `sort` の**形(値域)だけ**が広がっている(ADR-0007 Δ6)。
 */
export type Sort = {
  field: ResourceId;
  order: SortOrder;
};

/**
 * `sort` の2表記(単数オブジェクト / 配列)を**キーの配列**に揃える —— 正規化の唯一の入口。
 *
 * 計画書(V1-M0-T03)が名指しで警告しているのは「**3箇所で別々に配列対応すると、
 * 複合ソートの解釈が割れる**」ことである。したがって「どちらの表記で書かれていたか」を
 * 気にしてよいのはこの関数だけで、以降(カーネルの SQL / メモリ、HTTP のクエリ組み立て、
 * 表示層)は**キーの配列**だけを見る。
 *
 * この関数が `types.ts` に居るのは、**3経路すべてが依存を増やさずに import できる
 * 唯一の場所**だからである。`records.ts` に置くと表示層が `bun:sqlite` を巻き込み、
 * `server/app.ts` に置くとカーネルがサーバに依存する。
 *
 * 空配列は**ここでは落とさない**(空配列のまま返す)。「並び順が空である」ことを
 * 誤りとして断るか既定順に落とすかは呼び出し側の契約であり、正規化の仕事ではない。
 * カーネルは統一形式のエラーで断る(黙って既定順に落とすのは、指定が消えたことを隠す)。
 */
export function normalizeSort(sort: Sort | Sort[] | undefined): Sort[] {
  if (sort === undefined) {
    return [];
  }
  return Array.isArray(sort) ? sort : [sort];
}

/**
 * エラーの JSON Pointer に付ける `sort` の接頭辞を返す。
 *
 * 単数オブジェクト表記のときは **`/sort/field`**(v0 からの path。
 * `fixtures/catalog.json` の `broken-sort-field` が期待している形)、
 * 配列表記のときは **`/sort/<index>/field`** になる。**書いた形をそのまま指す**
 * ことが要点で、配列で書いていないのに `/sort/0/field` と言われた LLM は
 * 存在しない要素を探す。
 */
export function sortErrorPath(sort: Sort | Sort[] | undefined, index: number): string {
  return Array.isArray(sort) ? `/sort/${index}` : "/sort";
}

/**
 * 単純な等値条件(葉述語の等値1形)。
 *
 * **後方互換の要**である。`list_view.filter` の等値AND配列 `[{field, equals}]`(v0)と、
 * EC-G5 条件分岐(ADR-0036 の `WorkflowAction*.when`)がこの型を再利用する。
 * EC-G12(ADR-0043)で filter がブール式(`FilterNode`)へ拡張されても、**この型は
 * 等値1形のまま**であり、`when` の表現力は等値のまま据え置く(ADR-0043 §2 の歯止め)。
 */
export type FilterCondition = {
  field: ResourceId;
  equals: string | number | boolean;
};

/**
 * ブール式フィルタの**葉述語**(EC-G12 / ADR-0043)。
 *
 * 1葉につき演算子は**ちょうど1つ**。演算子は有限の5種
 * (`equals` / `contains` / `gte` / `lte` / `in`)だけで、`like` / `regex` / `between` /
 * `is_null` / フィールド同士の比較を1つも足してはならない(ADR-0043 §3 限定1・§3a-1)。
 * `contains` は文字列フィールドの部分一致、`gte`/`lte` は比較、`in` は複数値のいずれか一致。
 */
export type FilterLeaf =
  | { field: ResourceId; equals: string | number | boolean }
  | { field: ResourceId; contains: string }
  | { field: ResourceId; gte: string | number | boolean }
  | { field: ResourceId; lte: string | number | boolean }
  | { field: ResourceId; in: (string | number | boolean)[] };

/**
 * ブール式フィルタのノード(EC-G12 / ADR-0043)。
 *
 * 葉述語(`FilterLeaf`)と、有限3種のブール結合(`and` / `or` / `not`)からなる。
 * **結合は3種だけ**で、`xor` / `nand` / `implies` を足してはならない(ADR-0043 §3 限定2)。
 * ネスト深度には上限(コード側の `MAX_FILTER_DEPTH`)があり、無限ネストを弾く(限定3)。
 *
 * **`ListRecordsOptions.filter` は「等値AND配列(後方互換)| FilterNode」を受ける。**
 * 配列形は暗黙 AND であり、v0 のマニフェストを1バイトも壊さない(限定4)。
 * これは filter(行の選択)の表現力だけを緩めたものであって、select(射影)・
 * group_by(集約)・join(結合)・計算式には及ばない(ADR-0043 §1b。ADR-0024 の他の柱は不変)。
 */
export type FilterNode =
  | FilterLeaf
  | { and: FilterNode[] }
  | { or: FilterNode[] }
  | { not: FilterNode };

/**
 * filter(等値AND配列 | ブール式ノード)に現れる**すべての葉の field 参照**を、
 * それぞれの JSON path つきで集める(EC-G12 / ADR-0043)。
 *
 * 参照整合検査(`referential-integrity.ts`)が、ブール式のネストの奥にある葉の
 * field も含めて「実在フィールドか」を apply 時に照合できるようにするための純粋関数。
 * 配列形の path は従来どおり `/<index>/field`(例 `/0/field`)、ブール式は
 * `/and/<i>/field` のようにネストを写す。
 */
export function filterFieldRefs(
  filter: FilterCondition[] | FilterNode,
): { field: string; path: string }[] {
  const refs: { field: string; path: string }[] = [];
  const visit = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => {
        visit(item, `${path}/${index}`);
      });
      return;
    }
    if (node === null || typeof node !== "object") {
      return;
    }
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.and)) {
      obj.and.forEach((item, index) => {
        visit(item, `${path}/and/${index}`);
      });
      return;
    }
    if (Array.isArray(obj.or)) {
      obj.or.forEach((item, index) => {
        visit(item, `${path}/or/${index}`);
      });
      return;
    }
    if ("not" in obj) {
      visit(obj.not, `${path}/not`);
      return;
    }
    if (typeof obj.field === "string") {
      refs.push({ field: obj.field, path: `${path}/field` });
    }
  };
  visit(filter, "");
  return refs;
}

/**
 * filter(等値AND配列 | ブール式ノード)の葉の `field` を rename で写した**新しい filter**を返す
 * (EC-G12 / ADR-0043)。フィールド改名(`change_field` の id 変更)に list_view.filter を
 * 追随させるための純粋関数。演算子キー(equals/contains/gte/lte/in)や結合の構造は保つ。
 */
export function renameFilterField<T extends FilterCondition[] | FilterNode>(
  filter: T,
  from: string,
  to: string,
): T {
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      return node.map(visit);
    }
    if (node === null || typeof node !== "object") {
      return node;
    }
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.and)) {
      return { and: obj.and.map(visit) };
    }
    if (Array.isArray(obj.or)) {
      return { or: obj.or.map(visit) };
    }
    if ("not" in obj) {
      return { not: visit(obj.not) };
    }
    if (obj.field === from) {
      return { ...obj, field: to };
    }
    return obj;
  };
  return visit(filter) as T;
}

/**
 * ビュー3種に共通する任意の**表示名**(V1-M0-T02 / F-1)。
 *
 * `table.name` / `field.name` と**同名・同型・同意味**であり、新しい概念ではない
 * (ADR-0007 §7c 限定1)。`view` だけが `name` を持てないという語彙の非対称を解消する。
 *
 * **任意である**(限定3)。省略した場合、表示層は `id` を出す
 * (`web/src/views/ViewHost.tsx` の `viewDisplayName`)。既存マニフェストは無改変で
 * valid のままであり、画面も従来どおり描ける。
 *
 * **`description` / `icon` / `order` をここに足してはならない**(限定2)。
 * 同種の要求が来たら改めて ADR-0007 の門A を通すこと。判断の記録は
 * `docs/adr/0008-view-display-name.md`。
 *
 * **語彙(`RESOURCE_KINDS` / `FIELD_TYPES` / `DIFF_OPS`)は1つも増えていない。**
 * 3種すべてに同じ形で持たせるのは、ビュー種別の間に新しい非対称を作らないためである。
 */
type ViewDisplayName = {
  name?: string;
};

/**
 * ビュー3種に共通する任意の**画面一覧への掲載の可否**(`E-G12` / `V4-M10-T45` /
 * `ADR-0084` 限定1・限定2・限定3)。
 *
 * **値は真偽値1つである**(限定2)。「条件つきで出す」「この相手にだけ出す」は書けない。
 *
 * **既定は「出す」**(限定3)—— **書かなかった画面は今日どおり一覧に並ぶ。**
 * 既定を反転させると既存の全アプリのメニューが黙って変わる。
 *
 * **これは可視性の宣言ではない**(限定5)。**`audience`(`ADR-0070` / `ADR-0074`)と
 * 役割が違う** —— `audience` は「名乗ってよいか」を決め、サーバのレコード経路が同じ述語を
 * 読む。**【2026-08-10 追記(`V8-M20`。台帳 `J-G27`)。旧文を1バイトも消していない】**
 * **`audience` は今日は存在しない** —— **比較対象は `app.roles[].rules` の
 * 「役割 × 対象(画面)× 読取」へ移った。本キーが可視性の宣言でないことは今日も同じである。**
 * **本キーはメニューに並べるかだけを決め、可否を1ミリも変えない** ——
 * **一覧から外した画面へ行クリック / URL 直叩きで到達でき、応答も1バイトも変わらない。**
 *
 * **掲載の判定は AND 1本である**(限定4)——
 * `canUseView(role, manifest, view)` **かつ** 本キーが偽でないこと。
 * **「どちらが勝つか」の規則を1つも作らない**(`ADR-0074` 限定2 の精神)。
 *
 * **この型は export しない**(`ViewDisplayName` / `EscapeHatchReference` と同じ)——
 * `src/kernel/` の公開面を増やさないためであり、消費側は `View` の構造からそのまま読める。
 *
 * **`RESOURCE_KINDS` / `FIELD_TYPES` / `DIFF_OPS` は1つも増えていない**(限定1)。
 * **2本目の掲載・可視性のキーを足す提案は改めて `ADR-0007` の門A を通すこと**
 * (`ADR-0084` §Decision 4)。
 */
type ViewMenuListing = {
  menu_listed?: boolean;
};

/**
 * ビュー3種に共通する任意の**逃げ道の参照**(D-G5 / V3-M5-T02。ADR-0055 限定1・2・3)。
 *
 * **ここに在るのは参照だけである** —— 資産名(`asset`)と内容ダイジェスト(`digest`)の
 * 2要素で、**CSS のバイト列はマニフェストに1バイトも入らない**(限定2。縛るのは文字列の
 * 長さではなく形である)。本体は owner 専用の content-addressed ストア
 * (`apps/<app_id>/escape-hatch/<sha256>`)にあり、書ける経路は `requireOwner` を通した
 * HTTP ルート1本だけである(限定5)。**AI が書けるのは「owner が既に発行した資産のどれを
 * 当てるか」だけ**で、これは `call_external` で接続名を書けるのと同じ範囲である。
 *
 * **`name`(F-1)と同じく3種すべてに同じ形で持たせる** —— プリセット7キーが1軸も
 * 当たらない `form` こそ逃げ道の当て先だからである(判断の記録は
 * `docs/plan/v3/records/v3-m5-t02.md` §3)。
 *
 * **語彙(`RESOURCE_KINDS` / `FIELD_TYPES` / `DIFF_OPS`)は1つも増えていない**(限定3)。
 * **2つ目のキーを足してはならず、`app` にも `theme` にも足してはならない**(限定1)——
 * アプリ単位・テーマ単位の逃げ道を作らない。
 *
 * **この型は export しない**(`ViewDisplayName` と同じ)—— `src/kernel/` の公開面を
 * 増やさないためであり、消費側は `View` の構造からそのまま読める。
 *
 * **作用域(この資産を当ててよい画面の集合)はここに書けない。** owner が発行時に宣言し、
 * **宣言外の画面では配信層が拒否する**(限定7)。**参照先が未発行なら配信層は fail-closed
 * かつ loud である**(限定6)—— 型の上では「参照が在る」ことしか分からない。
 */
type EscapeHatchReference = {
  /** owner が発行した資産の名前(`$defs/resource_id` と同じ規約)。 */
  asset: string;
  /** 資産の内容の sha256(16進64文字)。**名前が同じでも内容が違えば別の版である。** */
  digest: string;
};

/**
 * ビュー3種(`list_view` / `form` / `detail_view`)に共通する任意の**一続きの流れの中の
 * 段**(`NV-G9`。`V10-M4-T01` / `ADR-0359` §4b 限定1〜限定8 / `ADR-0360` 限定1・限定2)。
 *
 * **`$defs/view` の31キー目である** —— **`ADR-0359` §5 が `ADR-0289` / `ADR-0340` の
 * 「30キー目を足してはならない」を両方まとめて引き直し、`after_delete`(30キー目)と
 * 本キー(31キー目)の2本を同じ門で通した。**
 * **置き換えとなる新しい不変条件は「`$defs/view` に 32キー目を足してはならない」である。**
 *
 * **値の形は3つで閉じる**(限定2)—— **4つ目のサブキーを作らない**(段の名前・アイコン・
 * 進捗率・条件は1つも書けない。`ADR-0359` §6 の 2)。**条件・式・演算を1つも作っていない。**
 *
 * **並びは宣言の集合から導く**(限定3)—— **同じ `flow.id` を持つ画面を `step` で並べた
 * ものが流れである。****「流れ」を持つ別の `$defs` を1つも作っていない。**
 * **位置の重複と欠番は `referential-integrity.ts` が apply 時に倒す。**
 *
 * **`flow.id` は流れの名前であって画面のIDではない** —— **同じ `flow.id` を複数の画面が
 * 持つのが正常な姿である。****したがって「実在するビューID」の検査も「流れIDの一意」の
 * 検査も書いていない**(`V10-M4` の決11。**対象が構造的に無い**)。
 *
 * **書けるのは `list_view` / `form` / `detail_view` の3種別である** —— **`ReportView` は
 * この型を混ぜていない。****スキーマ側も `allOf` の `report_view` 分岐で `false` に
 * 閉じてある。****この判断は `ADR-0359` にも `ADR-0360` にも1条も書かれていない** ——
 * **憲法2「語彙は狭く始める」に倒したメインの決定である**(`V10-M4` の決1)。
 * **`after_delete` は行き先に `report_view` を許しているので、非対称が1つ増える。**
 *
 * **確認の段(`kind: "confirm"`)を置けるのは `detail_view` だけである**
 * (`ADR-0360` 限定2)—— **型では割らず、スキーマの `allOf` が `form` / `list_view` の
 * 2分岐で `kind` を `"input"` に固定する**(**判定を2箇所に住まわせない**)。
 *
 * **流れは1つのアプリの中に閉じる**(限定4)—— **外部 URL を1文字も書けない。**
 *
 * **この型は export しない**(`ViewDisplayName` / `ViewMenuListing` /
 * `EscapeHatchReference` と同じ)—— **`src/kernel/` の公開エクスポートを1本も
 * 増やさないためである**(限定1。`scripts/kernel-export-drift.test.ts` が守る)。
 * 消費側は `View` の構造からそのまま読める。
 *
 * **`RESOURCE_KINDS`(8)/ `FIELD_TYPES`(9)/ `DIFF_OPS`(17)/ `VIEW_TYPES`(4)を
 * 1要素も動かしていない**(限定1)。
 */
type ViewFlowStep = {
  flow?: {
    /** **流れの名前**(`$defs/resource_id` と同じ規約)。**画面のIDではない。** */
    id: ResourceId;
    /** **その流れの中の位置。1から始まる整数**(重複と欠番は apply 時に拒否される)。 */
    step: number;
    /** **段の種類。今日は2値である**(`"confirm"` を置けるのは `detail_view` だけ)。 */
    kind: "input" | "confirm";
  };
};

/** 一覧画面。 */
export type ListView = ViewDisplayName &
  ViewMenuListing &
  ViewFlowStep & {
    id: ResourceId;
    type: "list_view";
    table: ResourceId;
    columns: ResourceId[];
    /**
     * **一覧の行の操作起点**(`L-G1` / `L-G2`。`V5-M21-T01` / `ADR-0171` 限定1〜限定12)。
     *
     * **着手前、`ListView` に `actions` キーは1本も無かった**(`schemas/manifest.schema.json` の
     * `allOf` の `list_view` 分岐が `"actions": false,` で閉じていた)。**`ADR-0171`(門A /
     * 判定 = 限定採用)がその `false` を解いた。**
     *
     * **型は `DetailView` のものをそのまま指す** —— **新しい型を1つも作っていない**
     * (`src/kernel/` の公開 export を1本も増やさない = 限定11)。
     *
     * ## **【`DetailView` と1点だけ違う。隠さない】**
     *
     * **一覧に置けるのは遷移の形(`form` + `prefill`)だけである。** **値の書換(`set`)は
     * 一覧では今日も書けない** —— `ADR-0171` 限定10 の逐語「**`ADR-0175` の規則が実装される
     * まで、一覧の set 形を実装しない(順序の拘束)**」に従い、`schemas/manifest.schema.json`
     * の `list_view` 分岐が `items.properties.set: false` で閉じている。**この型はその閉じ方
     * と一致させてある**(`Extract` で遷移の形だけを取る)—— **型のほうを広くすると
     * 「型では書けるがスキーマが拒む」形になる。**
     *
     * **`V5-M25-T03` が完了したら、`Extract` を外して `DetailView["actions"]` そのものに
     * 戻すこと**(スキーマ側の `items` を外すのと対である)。
     *
     * **プリフィル値は「その操作起点が乗っている行の `_id`」である**(`ADR-0171`
     * §Decision 3)—— `detail_view` では今日と同じ意味である。
     * **`visible_when` は一覧では行ごとに1回ずつ評価される**(§Decision 4)。**条件式の形は
     * `FilterLeaf` 1本のままで1バイトも広げていない**(限定7)。
     * **複数行を同時に対象にする形を1つも作っていない**(限定2)。
     *
     * ## **【`V5-M22-T01` / `L-G5` / `L-G6` / `ADR-0173` 限定1〜限定12 で3形目を足した】**
     *
     * **`DetailView` との差はもう1点増えた。** **一覧の行にだけ**、行き先を宣言する形
     * (`view` 1キー)を書ける。**`DetailView` には書けない** —— **`L-G7` は却下である**
     * (`docs/plan/v5/records/v5-m20.md` §2-2)。**したがって非対称は1つ増えた**:
     * **一覧の行からは任意の一覧・詳細を指せるが、詳細画面からは今日どおり参照セルと
     * 左ナビしか無い。** **`schemas/manifest.schema.json` の `detail_view` 分岐が
     * `items.properties.view: false` で閉じており、この型はその閉じ方と一致させてある。**
     *
     * **`view` に書けるのは同じアプリの `list_view` / `detail_view` のIDだけである**
     * (限定3)—— **`form` も外部 URL も別アプリのIDも書けない**(実在と型は
     * `referential-integrity.ts` が apply 時に検査する)。
     * **行き先が `detail_view` なら押した行の `_id` を運び、`list_view` なら何も運ばない**
     * (`ADR-0173` §Decision 3)。
     * **宣言が無ければ今日どおり `resolveDetailViewTarget` の規約が効く**(限定4 / 限定5)。
     * **新しい型名を1つも新設していない** —— **`src/kernel/` の公開 export は1本も
     * 増えていない**(限定10)。
     */
    /*
     * **【`V5-M25-T07` / `L-G3` / `ADR-0171` 限定10 の順序拘束が解けた】**
     * **上の「一覧に置けるのは遷移の形(`form` + `prefill`)だけである」「値の書換(`set`)は
     * 一覧では今日も書けない」は今日から偽である** —— **`V5-M25-T03` が `ADR-0175` の規則
     * (実行中の重複を 409 で拒む)を実装したので、拘束が解けた。**
     * **旧文を1バイトも消していない。**
     * **`Extract<..., { form: ResourceId }>` を外し、`DetailView["actions"]` そのものへ戻した**
     * (上の doc が「`V5-M25-T03` が完了したら、`Extract` を外して `DetailView["actions"]`
     * そのものに戻すこと(スキーマ側の `items` を外すのと対である)」と名指ししていた)。
     * **【禁止】「二重押しが防げるようになった」と読まない** —— **set 形の冪等性は今日も
     * 1つも無く、押した回数だけ書込が起きる**(`ADR-0100` §限界1 は set 形については
     * 1バイトも無効化されていない)。
     */
    actions?: (
      | NonNullable<DetailView["actions"]>[number]
      | {
          view: ResourceId;
          name?: string;
          visible_when?: FilterLeaf;
          /** ボタンの識別子(`V8-M17` / `J-G9`。任意。同じ画面の中で一意)。 */
          id?: ResourceId;
        }
      /*
       * **【`V5-M25-T01` / `L-G8` / `ADR-0174`】4形目(自動処理の起動)は一覧にも書ける。**
       * **`detail_view` との差にはならない** —— **両方に書ける形である**
       * (`schemas/manifest.schema.json` はどちらの分岐でも `run` を閉じていない)。
       */
      | {
          run: ResourceId;
          name?: string;
          visible_when?: FilterLeaf;
          /** ボタンの識別子(`V8-M17` / `J-G9`。任意。同じ画面の中で一意)。 */
          id?: ResourceId;
        }
    )[];
    sort?: Sort | Sort[];
    /**
     * 絞り込み条件。**等値AND配列(後方互換)| ブール式(`FilterNode`。EC-G12 / ADR-0043)**。
     * 配列形 `[{field, equals}]` は暗黙 AND で v0 のマニフェストを壊さない。ブール式は
     * `and`/`or`/`not` と有限の葉演算子(equals/contains/gte/lte/in)で書ける。
     */
    filter?: FilterCondition[] | FilterNode;
    /**
     * 列ごとの文字寄せ(D-G4 / F-5レイアウト。ADR-0050 限定1)。キーは表示列のフィールドID、
     * 値は3値の enum。**未指定の列は現在の既定のまま**(7キーはすべて任意 = D-M2-3)。
     *
     * **プリセットはテーマではない** —— 色・書体・長さの実値を1つも持たず、値域はすべて
     * 列挙値である。**ピクセル座標・絶対配置・任意 CSS 文字列を書ける場所を1つも作らない**
     * (限定11)。**8つ目のキーを足す / enum に値を足す提案は ADR-0050 §3a 3 の門A を通すこと。**
     *
     * **語彙(`RESOURCE_KINDS` / `FIELD_TYPES` / `DIFF_OPS`)は1つも増えていない**
     * (限定3)。書き込みは既存の `add_view` / `update_view` だけである。
     */
    preset_column_align?: Record<ResourceId, "left" | "center" | "right">;
    /**
     * 列ごとの幅の段階値(ADR-0050 限定1)。**px も % も書けない。**
     * 表示層は**このキーを書いた画面にだけ** `table-layout: fixed` を掛ける(限定6)——
     * 書いた画面では幅を指定しなかった列も固定レイアウトの配分になる。
     */
    preset_column_width?: Record<ResourceId, "narrow" | "standard" | "wide">;
    /** 件数表示とページャの位置(ADR-0050 限定1)。**座標ではなく3値の列挙である。** */
    preset_pager_position?: "top" | "bottom" | "both";
    /** `image` 型の表示サイズの段階値(ADR-0050 限定1)。 */
    preset_image_size?: "thumbnail" | "medium" | "original";
    /**
     * `long_text` の切り詰め長の段階値(ADR-0050 限定1)。**文字数そのものは書けない。**
     *
     * **【`V4-M10-T36` / `E-G13` / `ADR-0085` 限定1】値域を 3 → 4 にした** —— 4値目は
     * `full`(切らない)。**キーは1本も増えていない** —— 軸は7軸のままで、選択肢の総数が
     * 19 → 20 になった(限定3)。**表示関数の引数も1本も増えていない**(限定4)。
     * **既定は1バイトも変わっていない**(書かなかった画面は今日と1文字も変わらない)。
     */
    preset_text_preview?: "short" | "standard" | "long" | "full";
    /**
     * 一覧の器の形(`P-G24` の (C) 側。`V4-M16-T13` / `ADR-0093` 限定1〜限定10)。
     * **8つ目の `preset_` キーであり、`$defs/view` の22キー目である。**
     *
     * **値域は2値だけである**(限定3)—— `table`(既定)と `card`。**3値目を足さない**
     * (グリッド / カンバン / カレンダー / タイムラインを1つも置かない)。
     * **`list_view` でだけ書ける**(限定2。`detail_view` / form 分岐は `false`)。
     *
     * **既定は `table` であり、書かなかった画面は今日と1ピクセルも変わらない**(限定4)。
     * **`table` と明示しても DOM は1バイトも変わらない。**
     *
     * **【正直に書く】`card` のとき `preset_column_align` / `preset_column_width` は効かない**
     * (限定8)—— カードには列が無いためである。**機械では止めていない** —— 止めるには型と
     * プリセットの対応検査が要り、それは今日この製品に1つも無い。**「書けるが効かない」を
     * 黙って作らないことだけを義務にしており、`src/mcp/vocabulary.ts` が明記している。**
     *
     * **前進では外せない**(限定10)—— 外すには undo で戻すか `remove_view` + `add_view`。
     * **`DIFF_OPS` は16のままである**(器の形専用の op は無い)。
     */
    preset_list_shape?: "table" | "card";
    /**
     * **この一覧で、利用者が打った語を照合する列**(`E-G7` の (C) 側。`V4-M22-T01` /
     * `ADR-0112` 限定1〜限定9・限定11・限定12)。
     *
     * **`$defs/view` の24キー目である。** **`ADR-0112` 限定1 は「22 → 23」と書いているが、
     * それは `V4-M18` の `modal` が入る前の実測である**(同 ADR §限界8 が「実装時に数え直す
     * こと」と課している)。**実際の増分は 23 → 24 である** —— **守ったのは「1本だけ足す」
     * という増分であって、限定表が書いた絶対値ではない。**
     *
     * **値は列の名前の配列だけである**(限定4)—— **演算子・比較・論理結合・条件式・
     * 関数呼び出し・文字列連結・ワイルドカードを1つも書けない。** **長さは1以上8以下。**
     *
     * **書けるのは対象テーブルに実在する `text` / `long_text` のフィールドだけである**
     * (限定5)。**役割の規則(`app.roles[].rules`)が名指ししている項目は書けない**
     * (限定6。**【`V8-M20-T02`。台帳 `J-G27` / `J-G28`】着手前の逐語は「`audience` を
     * 宣言した項目は書けない」。そのキーは廃止されたので、同じ問いを面について
     * 問い直した**)—— **「隠した項目で
     * 絞り込むと当たり `total=1` / 外れ `total=0` で値を当てられる」という既知の穴
     * (`docs/plan/v4/records/v4-fix1-boundary-bypass.md` §2 (d) の1)を、画面から使える形に
     * 広げないためである。** **【正直に書く】その穴を1件も塞いでいない**(5件は今日も5件)。
     * **3つの検査は `referential-integrity.ts` の1箇所で行い、`add_view` / `update_view` の
     * 両経路を覆う。** **拒否は「全か無か」である**(`ADR-0047` 限定9)。
     *
     * **検索語(利用者が打つ文字列)はマニフェストに1バイトも入らない**(限定8)——
     * 語は読取API のリクエスト引数として渡る。**したがって `ADR-0064` 限定4(`filter` の値に
     * 実行時解決を1つも許さない)を1バイトも引き直していない。** **【禁止】本キーを
     * 「`filter` に実行時解決を入れてよい」の根拠にしない**(`ADR-0112` §Decision 4 の 1)。
     *
     * **`list_view` でだけ書ける**(限定3。form / `detail_view` 分岐は `false`)。
     * **既定は「検索の口を出さない」であり、書かなかった画面は今日と1バイトも変わらない**
     * (限定12)。**`related`(子一覧)には1バイトも当たらない** —— `related` は
     * `detail_view` の中の定義であり、本キーを書く場所がそもそも無い。
     *
     * **前進では外せない** —— 外すには undo で戻すか `remove_view` + `add_view`。
     * **`DIFF_OPS` は16のままである。**
     */
    search_fields?: ResourceId[];
    /**
     * **この一覧の1ページに出す件数**(`E-G8` / `E-G11` の (C) 側。`V4-M22-T05` /
     * `ADR-0113` 限定1〜限定10)。
     *
     * **`$defs/view` の25キー目である。** **`ADR-0113` 限定1 は「+1」と書き、事実5 が
     * 「22」と記しているが、それは `modal` も `search_fields` も入る前の実測である**
     * (同 ADR §限界8 が「実装時に数え直すこと」と課している)。**実際の増分は 24 → 25。**
     *
     * **値は段階値の enum だけで、自由な整数を1つも受けない**(限定3)—— **`10` / `20` /
     * `50` / `100` の4値だけである。** **範囲内でも enum に無い整数は拒否される。**
     *
     * **既定は `50` であり、今日の `PAGE_SIZE` と同じ値である**(限定10)——
     * **書かなかった画面は今日と1ピクセルも変わらず、`50` と明示しても DOM は1バイトも
     * 変わらない。** **`schema` に `default` を書いていない**(既定は表示層の1箇所が持つ)。
     *
     * **ページ位置のキーを1本も足していない**(限定4。`ADR-0042` 限定2 / §3a-2 不可侵)——
     * **マニフェストは「今何ページ目か」を1バイトも持たない。** **`cursor` / `keyset` も
     * 1つも無く**(限定5)、**`total` は今日どおり集約カウントのままである**(限定6)。
     *
     * **【`ADR-0042` §3a-4 の射程を「件数」の分だけ引き直した】** —— **その理由文は
     * `offset`(位置 = 状態)にしか当たっていない**(`ADR-0113` §Decision 2 (c))。
     * **`ADR-0042` の本文を1バイトも書き換えていない。**
     *
     * **`list_view` でだけ書ける**(限定7)。**`related`(子一覧)には1バイトも当たらない**
     * (限定8。`ADR-0081` 限定6 不可侵)—— **子一覧の件数は今日と1件も変わらない。**
     * **黙って効かないままにしない** —— `src/mcp/vocabulary.ts` が明記している。
     *
     * **前進では外せない** —— 外すには undo で戻すか `remove_view` + `add_view`。
     * **`DIFF_OPS` は16のままである。**
     */
    page_size?: 10 | 20 | 50 | 100;
    /**
     * **この一覧が今表している集合について合計を出す列**(`D-V4-89` / `E-G31`。
     * `V4-M23-T01` / `ADR-0104` 限定1〜限定12)。
     *
     * **`$defs/view` の28キー目である。** **`ADR-0104` 限定1 は「27 → 28」と書いており、
     * 着手前の実測(2026-08-04)も 27 であった** —— **今回は限定表と実測が一致している**
     * (`ADR-0112` / `ADR-0113` / `ADR-0118` / `ADR-0102` のときと違う)。
     *
     * **開いたのは `sum` の1演算だけである**(限定2)—— **`avg` / `min` / `max` /
     * `count(distinct)` / `median` を1つも書けない。** **演算の名前を書く場所そのものが
     * 無い**(キー名が演算である)。**2つ目の演算を足すには新しいキーが要る。**
     *
     * **値は `number` 型のフィールドID 1本だけである**(限定3)—— **配列でもオブジェクト
     * でもないので、1画面で2列を合計することはできない。** **`text` / `long_text` /
     * `boolean` / `date` / `select` / `reference` / `image` を指した差分と、実在しない
     * フィールドを指した差分は apply 時に拒否する**(`ADR-0086` 限定4 と同型)。
     * **さらに役割の規則(`app.roles[].rules`)が名指ししている項目も指せない**
     * (**【`V8-M20-T02`。台帳 `J-G28`】着手前の逐語は「さらに `audience` を宣言した項目も
     * 指せない」。そのキーは廃止されたので、同じ問いを面について問い直した**)
     * —— **これは `ADR-0104` 限定表を越えて
     * 締めた1点で、`ADR-0112` 限定6 が `search_fields` に課したのと同型である**
     * (合計は行の射影を通らない1つの数なので、見えない列の合計だけが見える形を作らない)。
     * **開く側ではなく閉じる側の差である。**
     *
     * **`list_view` でだけ書ける**(限定4)—— **`detail_view` / `form` の分岐は `false`。**
     *
     * **合計の母集団は `total`(画面に出る「全 N 件」)と同一である**(限定5)——
     * **今見えているページの分ではない。** **`total` の3分岐を1つも増やさず1つも変えて
     * いない。** **非スコープ分岐では既存の件数の1文に集約列を同居させ、別クエリを1本も
     * 増やさない**(限定6)。**post-filter 分岐は SQL で合計せず、`total` を数えている
     * 同じ可視集合から合算する**(限定7)。
     *
     * **`group_by` を1バイトも開いていない**(限定8)。**集計値を `filter` / `sort` /
     * `search_fields` の入力にしていない**(限定9。`having` を作らない)。
     * **`function.input`(`ADR-0024` 限定3)と `filter`(`ADR-0043`)を1バイトも動かして
     * いない**(限定10)。**合計は読取専用の導出値であり、行を1件も作らない**(限定11)。
     *
     * **既定は「合計を出さない」であり、書かなかった画面は今日と1ピクセルも変わらない。**
     * **`schema` に `default` を書いていない。**
     *
     * **【正直に書く】MCP の `list_records` は本宣言を1つも見ない**(`ADR-0104` §限界8。
     * `ADR-0071` 限定9 と同型の穴)—— **画面と MCP で見えるものが違う。**
     *
     * **前進では外せない** —— 外すには undo で戻すか `remove_view` + `add_view`。
     * **`DIFF_OPS` は16のままである。**
     */
    sum_field?: ResourceId;
    /**
     * **この画面の詰まり具合**(余白・寸法。`P-G32` の (C) 側。`V4-M19-T03` /
     * `ADR-0118` 限定1〜限定13)。
     *
     * **`$defs/view` の26キー目であり、9つ目の `preset_` キーである。**
     * **`ADR-0118` 限定1 は「22 → 23」と書いているが、それは `modal` も `search_fields` も
     * `page_size` も入る前の実測である。** **実際の増分は 25 → 26 である。**
     * **守ったのは「1本だけ足す」という増分であって、限定表が写した絶対値ではない。**
     *
     * **値域は2値の `enum` だけである**(限定3)—— **`comfortable` / `compact` のほかに
     * 3値目を足さない。** **`px` も `rem` も割合も CSS 文字列も1バイトも書けない。**
     *
     * **3種すべてに書ける** —— **詰まり具合は画面そのものの性質であり、表・入力・詳細の
     * どれにも器が在る**(マニフェスト側の `allOf` はどの分岐でも `false` にしていない)。
     * **項目ごと・列ごとには変えられない**(`$defs/field` に1バイトも足していない = 限定1)。
     *
     * **既定は `resolveUiFamily()` が返す値(今日は `comfortable`)であり、書かなかった画面は
     * 今日と1ピクセルも変わらない**(限定8)。**`schema` に `default` を書いていない** ——
     * **既定は表示層の1箇所が持つ**(既定を2箇所に住まわせない)。
     *
     * **系統の判定は `web/src/ui/family.ts` の `resolveUiFamily()` の1箇所に保つ**(限定7)。
     * **`--space-1`〜`--space-6` を1バイトも動かさない**(限定5。`ADR-0047` 限定1 不可侵)——
     * **ビュー単位テーマではない。実値を1つも持たない2値の `enum` である。**
     *
     * **【正直に書く】2つの系統は全部の軸で違うのではない** —— **角丸の軸は差が0である**
     * (`docs/plan/v4/records/v4-m15-t19.md:967`)。
     *
     * **前進では外せない**(限定12)—— 外すには undo で戻すか `remove_view` + `add_view`。
     * **ただし `comfortable` と書いた画面は今日の既定と同じ描画に戻せる**(既定が
     * `comfortable` だから)。**既定が将来変われば、この一文は偽になる。**
     * **`DIFF_OPS` は16のままである。**
     */
    preset_density?: "comfortable" | "compact";
    /** 逃げ道(任意 CSS)の参照(D-G5 / ADR-0055)。詳細は {@link EscapeHatchReference}。 */
    custom_css?: EscapeHatchReference;
  };

/** 作成・編集画面。 */
export type FormView = ViewDisplayName &
  ViewMenuListing &
  ViewFlowStep & {
    id: ResourceId;
    type: "form";
    table: ResourceId;
    fields: ResourceId[];
    /**
     * 項目名と値の向き(D-G4。**`P-G29` / `ADR-0091` 限定3 で form にも通した2軸のうちの1つ**)。
     *
     * **`inline`(横並び)/ `stacked`(縦積み)の2値だけである** —— `enum` に値を1つも
     * 足していない(限定2)。**新しいキーではない** —— `$defs/view` に既にあるキーの
     * `false` を form 分岐から外しただけで、`$defs/view.properties` は 20 のまま・
     * `$defs` は 28 のまま・`view_changes` は 14 のままである(限定1)。
     *
     * **【正直に書く】form の既定は縦積みであって横並びではない**(`detail_view` と違う)。
     * **書かなかった form は今日と1ピクセルも変わらず**(当たる規則が1つも無い)、
     * **`stacked` と書いた form が今日の描画と同じになる**(限定6 の逐語「既定は `inline`」は
     * form については実物と一致しない)。
     */
    preset_label_placement?: "inline" | "stacked";
    /**
     * 項目の段組数(D-G4。**`ADR-0091` 限定3 で form にも通した2軸のうちの1つ**)。
     * **`@media` を1つも足していない**ので、**段組数は画面幅に追随しない固定値である。**
     * **段の器は項目だけを包む** —— 送信ボタンとエラー表示は段に入らない。
     *
     * **【V4-M53 が 2026-08-04 に追記。門A / 限定採用。`ADR-0157`】上の前提
     * (「`@media` を1つも足していない」)は今日から偽である** —— **2026-08-04 実測:
     * `web/src/styles.css` に幅の条件の `@media` が2本ある**(`:913` 逐語
     * `@media (min-width: 40rem)` / `:919` 逐語 `@media (min-width: 64rem)`。
     * どちらも `.shell` の `padding` だけを変える)。**足したのは `ADR-0089`**
     * (`V4-M15-T07` / `D-V4-44`。2026-08-03)**で、同 ADR §Context 2 は逐語で
     * 「`ADR-0046` 限定5 を緩めている。緩めていないふりをしない」と書いている。**
     *
     * **一方で帰結(段組数は画面幅に追随しない固定値である)は今日も真である** ——
     * **段組の規則(`[data-preset-columns=…]`)は `web/src/styles.css:575` /
     * `:581`(form 側)に在り、2本の `@media` の内側には1つも入っていない**
     * (`web/test/preset-boundary.test.ts` の `(vi-5)` が波括弧の対応で実測している)。
     * **狭い画面で段が潰れることも今日どおりである。「レスポンシブになった」に倒さない。**
     * **旧文を1バイトも消していない**(`D-V4-188`。直し方は `ADR-0156` と同じ形)。
     * **本追記は説明の是正であって能力の追加ではない** —— **`enum`(1 / 2)も
     * `$defs/view.properties` も1バイトも変えていない。**
     */
    preset_field_columns?: 1 | 2;
    /**
     * 逃げ道(任意 CSS)の参照(D-G5 / ADR-0055)。詳細は {@link EscapeHatchReference}。
     *
     * **form が持てる唯一の見た目のキーである** —— プリセット7軸は1つも書けない
     * (ADR-0050 §1c。form の4軸は却下1 / 保留3)。
     *
     * **【`V4-M16-T11` / `P-G29` / `ADR-0091` 限定3 で偽になった】** 上の2文は
     * **2026-07-26 の判定としては正しいが、今日は成り立たない** —— **`ADR-0091`
     * (門A / 判定 = 限定採用)が `preset_label_placement` と `preset_field_columns` の
     * 2軸を form にも通した。****旧文を1バイトも消していない。**
     * **【禁止】「form の見せ方が指定できるようになった」と書かない** —— **通したのは
     * 2軸だけで、残る5軸は今日も form に書けない**(`ADR-0091` §Decision 3 の1・2)。
     * **前回(2026-07-26)の保留3軸のうち解けたのは「項目名の配置」の1軸だけであり、
     * 必須印の見せ方と入力欄の幅・高さは今日も保留のままである**(限定5)。
     */
    custom_css?: EscapeHatchReference;
    /**
     * **この画面を今の画面の上に重ねて出すか**(`P-G14` の (C) 側。`V4-M18-T03` /
     * `ADR-0095` 限定1〜限定6・限定10)。
     *
     * **`$defs/view` の23キー目である。****真偽値1つで、`enum` にしていない**(限定2)——
     * **大きさ・位置・重ね順・閉じ方を1つも選べない。**
     *
     * **【これは部品を呼び名で選ぶ語彙ではない】** —— **`P-G26` は 2026-08-03 に4回目の
     * 却下である**(`ADR-0096`)。**器を1つも選べない。**
     *
     * **`form` でだけ書ける**(限定4。マニフェスト側の `allOf` の `list_view` /
     * `detail_view` 分岐が `false` で閉じている)。**`menu_listed` を偽にしていない画面には
     * 書けない**(限定5。`allOf` の4分岐目が組み合わせを見て差分全体を拒否する)——
     * **メニューに並ぶ画面を重ねると、下に何も無い画面の上に重なるためである。**
     *
     * **既定は「重ねない」であり、書かなかった画面は今日と1ピクセルも変わらない**(限定3)。
     *
     * **`update_view` で後から書けて、値が実際に運ばれる** —— `applyViewChanges`
     * (`apply-diff.ts`)の `form` 分岐が運ぶ。**`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは
     * 値が運ばれない**(両方要る)。**`writable_by` / `representative_field` の「キーは在るが
     * 効かない」穴を新しいキーで踏み直さない。**
     *
     * **前進では外せない**(限定10。`P-G50`)—— キーを消す手段は無く、外すには undo で戻すか
     * `remove_view` + `add_view` で作り直す(他の `preset_` / `custom_css` / `menu_listed` /
     * `field_groups` / `preset_list_shape` と同じ性質)。**`DIFF_OPS` は16のままである。**
     */
    modal?: boolean;
    /**
     * **この画面の詰まり具合**(`V4-M19-T03` / `ADR-0118`)。詳細は {@link ListView} の
     * `preset_density`。**form にも書ける** —— **プリセット7軸のうち form に通ったのは
     * `ADR-0091` の2軸だけだが、本キーは画面そのものの詰まり具合であり、入力欄・ボタンという
     * 器が form にも在るからである**(当たり先の実在 = `ADR-0118` 限定6)。
     */
    preset_density?: "comfortable" | "compact";
    /**
     * **保存が成立したあとに行く画面のID**(`E-G34`。`V4-M20-T04` / `ADR-0102` 限定1〜限定9)。
     *
     * **`$defs/view` の27キー目である。****値は遷移先のビューID 1つだけで、`ADR-0045` の
     * `actions[].form` と同じ形である**(新しい構文を1バイトも作っていない)。
     *
     * **`form` でだけ書ける**(限定3。マニフェスト側の `allOf` の `list_view` /
     * `detail_view` 分岐が `false` で閉じている)。
     *
     * **条件分岐を1つも作らない**(限定4)—— **成功 / 失敗で行き先を分けられない。**
     * **確認の段を1バイトも作らない**(限定5。`E-G33` は今日も解けない)。
     * **送信ボタンの文言を宣言できない**(限定6。`保存` は今日も全アプリ共通である)。
     *
     * **書かなかった form の挙動は1文字も変わらない**(限定7)—— 既定(編集なら同テーブルの
     * `detail_view` → 無ければ同テーブルの `list_view` → 無ければアプリ先頭)は無傷である。
     * **遷移先の画面が見えない相手には、表示層が既定の行き先へ倒す**(壊れない)。
     * **【`V8-M20`。台帳 `J-G27`】着手前の逐語は「遷移先が `audience` で見えない相手には」
     * だった。そのキーは廃止され、見える相手を決めるのは `app.roles[].rules` である。**
     *
     * **`update_view` で後から書けて、値が実際に運ばれる** —— `applyViewChanges`
     * (`apply-diff.ts`)の `form` 分岐が運ぶ。**`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは
     * 値が運ばれない**(両方要る)。
     *
     * **前進では外せない** —— 外すには別のビューIDに差し替えるか、undo で戻すか、
     * `remove_view` + `add_view` で作り直す。**`DIFF_OPS` は16のままである。**
     */
    after_save?: ResourceId;
    /**
     * **この入力画面での、参照項目の「選び方」の上書き**(`K-G2`。`V6-M2-T01` /
     * `ADR-0289` 限定1〜限定9)。
     *
     * **`$defs/view` の29キー目である。****値は「フィールドID → 選び方」の対応である**
     * (限定2)—— **1つの入力画面に参照項目が複数あっても、どの項目の選び方かを
     * 取り違えない。****値域は `$defs/field/properties/reference_picker` の有限3値を
     * そのまま指す**(`ADR-0288` 限定2。値域の定義を二重に持たない)。
     *
     * **`form` でだけ書ける**(限定4。マニフェスト側の `allOf` の `list_view` /
     * `detail_view` 分岐が `false` で閉じている)—— **一覧と詳細は値を表示するだけで、
     * 選ぶ操作が構造的に無い。**
     *
     * **優先順位は「画面 > 項目 > 既定」の1本だけである**(限定5)—— **ここに書いた項目は
     * 項目側の `reference_picker` より優先し、書かなかった項目は項目側の宣言に、
     * それも無ければ表示層の既定(`list` = 今日どおりのプルダウン)に倒れる。**
     * **解決を行うのは `web/src/fields/input.tsx` の `resolveReferencePicker` 1関数だけである**
     * (規則を2箇所に書かない)。
     *
     * **既定は「書かない」であり、書かなかった画面は今日と1ピクセルも変わらない**(限定3)。
     *
     * **`update_view` で後から書けて、値が実際に運ばれる** —— `applyViewChanges`
     * (`apply-diff.ts`)の `form` 分岐が運ぶ。**`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは
     * 値が運ばれない**(両方要る)。**全置換である** —— 項目ごとに1本ずつ足す / 消す
     * 手段を1つも作っていない。
     *
     * **前進では外せない**(限定8)—— 外すには undo で戻すか `remove_view` + `add_view` で
     * 作り直す。**`DIFF_OPS` は17のままである。**
     *
     * **【正直に書く。限定9 は今日まだ満たされていない】** **`type_filter` と `search` の
     * 描画は今日1バイトも実装されていない**(当たり先は `V6-M4` / `V6-M5`)。
     * **今日この2値を書いても画面は今日どおりのプルダウンのままである = 「書けるが
     * 今日は効かない」。**
     */
    reference_pickers?: Record<ResourceId, "list" | "type_filter" | "search">;
  };

/**
 * 1レコードの詳細表示。
 *
 * `fields` は **任意**である点が `FormView.fields`(必須)と違う。
 * 省略した場合は対象テーブルの全フィールドを、テーブル定義の順に表示する
 * (v0 からの既存の挙動)。指定した場合はそのIDだけを、その順に表示する。
 *
 * このキーを型に持たせているのは、`referential-integrity.ts` が不在フィールドIDを
 * **書き込み時**に弾けるようにするためである(V1-M0-T09 追補)。表示層でだけ照合すると
 * `list_view.columns` / `form.fields` と非対称になり、不正なIDが 201 で通ってしまう。
 * **語彙(`RESOURCE_KINDS` / `FIELD_TYPES` / `DIFF_OPS`)は1つも増えていない** ——
 * 既にある `field_id_list` の形を、既にあるビュー種別の任意キーとして持つだけである。
 */
export type DetailView = ViewDisplayName &
  ViewMenuListing &
  ViewFlowStep & {
    id: ResourceId;
    type: "detail_view";
    table: ResourceId;
    fields?: ResourceId[];
    /**
     * 関連レコードの動的表示(EC-G17 / ADR-0044)。**detail_view でだけ持てる新キー**で、
     * 「今開いているレコードを親(reference 先)に持つ子レコードの一覧」を詳細画面に
     * 埋め込む最小形である。各要素は:
     * - `table`: 子レコードのテーブル
     * - `via`: 子テーブル上の **reference 型フィールド**で、今開いているレコードを指す
     *   もの(親を辿る単一の参照。**1ホップのみ**)
     * - `columns` / `sort`: 子一覧の列・並び順(既存 `field_id_list` / `Sort` を再利用)
     * - `name`: 子一覧の見出し(任意)
     *
     * **動的 filter は親条件のみ = `child.<via> == 開いているレコードの _id` に固定**され、
     * 子一覧に EC-G12 の演算子(contains/gte/lte/in/and/or/not)を持たせない(限定2)。
     * **join・参照展開(`$record.<ref>.<field>`)・孫・多段には広げない**(ADR-0044 §3a)。
     *
     * **既存の detail_view「自レコードのみ」(`columns`/`sort`/`filter` は禁止)は1バイトも
     * 変えていない** —— `related` は意味論を分離した別キーである(限定表1)。
     * **語彙(`RESOURCE_KINDS` / `FIELD_TYPES` / `DIFF_OPS`)は1つも増えていない**(限定表5)。
     */
    related?: {
      /**
       * **【`V10-M24-T01` / `CM-G22` / `ADR-0371` 限定1〜限定6】この関連一覧の名札。**
       * **コメントの宛先として、この画面のこの関連一覧を名指しするために使う。**
       * **任意である** —— 書かなければ今日どおり通り、名指しできないだけである。
       * **一意なのは同じ画面の中だけ**で、別の画面には同じ名札を書ける。
       * **描画は1度も読まない**(画面に出る文字は `name` であって `id` ではない)。
       */
      id?: string;
      table: ResourceId;
      via: ResourceId;
      columns: ResourceId[];
      sort?: Sort | Sort[];
      name?: string;
    }[];
    /**
     * ビューからの操作起点(EC-G14 / ADR-0045)。**detail_view でだけ持てる新キー**で、
     * 「指定 form へ遷移し、参照フィールド1つを今開いているレコードの `_id` でプリフィルする」
     * 操作の起点を表す最小形である。各要素は:
     * - `form`: 遷移先の form ビューID(その作成画面へ遷移する)
     * - `prefill.field`: 遷移先 form の対象テーブル上の **reference 型フィールド**。値は暗黙に
     *   今開いているレコードの `_id`(参照フィールド1つ × `_id`。値を書く場所を持たない)
     * - `name`: 操作ボタンの表示名(任意)
     *
     * **プリフィルは参照フィールド1つ × `_id` の最小形に固定**され、条件付きプリフィル・
     * 複数プリフィル・既定値式・`_id` 以外の値を1つも足さない(ADR-0045 §1c / 限定2/3。
     * `action_value` 限定12 の精神の延長)。**「操作の起点」語彙であって表示層台帳
     * (F-5 配色 / F-7' グラフ / F-11' アプリ切替)とは別単位**であり、配色・グラフ・表示体裁を
     * 1つも扱わない(§1b / 限定4)。
     *
     * **既存の detail_view「自レコードのみ」(`columns`/`sort`/`filter` は禁止)と related(T03)は
     * 1バイトも変えていない** —— `actions` は意味論を分離した別キーである。
     * **語彙(`RESOURCE_KINDS` / `FIELD_TYPES` / `DIFF_OPS`)は1つも増えていない**(限定5)。
     */
    /*
     * **【V4-M20-T02 / ADR-0101 限定1〜限定4】どちらの形にも `visible_when` を書ける。**
     *
     * **値域は既存の `FilterLeaf`(`ADR-0043` の葉述語)そのものであり、専用の型名を
     * 1つも新設していない**(`src/kernel/` の公開 export を1本も増やさないため。
     * `workflow_action.when` が `FilterCondition` を再利用したのと同じ作法)。
     * **葉1つだけで `and` / `or` / `not` を書けない。**
     * **判定の対象は今開いているレコードの値だけである。**
     * **条件が決めるのは「出すか出さないか」だけで、プリフィル値は1バイトも変わらない。**
     * **ボタンを隠すことは書込を止めることではない**(限定6)。
     */
    /*
     * **【2026-08-10 追記(`V8-M20`。台帳 `J-G29`。手続きは `ADR-0301`)。旧文を1バイトも
     * 消していない】** **この段落が説明している `audience` は今日は存在しない** ——
     * **`$defs/view_action/properties/audience` は `V8-M20` が廃止し、この型からも
     * 5箇所(`ListView` の `view` / `run` 形、`DetailView` の `form` / `set` / `run` 形)を
     * 落とした。****以下は歴史の記述である。**
     * **代わりに担うのは `app.roles[].rules` の「役割 × 対象 × できること」であり、
     * 「対象(表)× 書込」と「対象(ボタン)× 読取」の2本に分かれる。**
     * **【正直に書く。代わりが立つ範囲は同じではない】** **面のボタンの規則は
     * `view_action.id` で名指しするので、識別子(`id`)を書いていない操作起点は面から
     * 名指しできない。** **旧層は `id` が無くても効いていた。**
     *
     * **【`V5-M23-T02` / `L-G14` / `ADR-0177` 限定1〜限定11】どの形にも `audience` を書ける。**
     *
     * **`$defs/view_action` の7キー目である**(着手前は6キー)。**値域は
     * `$defs/view/properties/audience` を `$ref` で指しており、値の列挙を
     * `view_action` 側に1つも持たない**(限定2)。
     *
     * **型を `string[]` にしてある。** **`Role` にも列挙型にもしていない** ——
     * **`View` 型は今日も `audience` を持たない**(`src/server/owner-scope.ts` の
     * `viewAudienceDeclaration` が `unknown` から読む形になっているのはそのためである)。
     * **さらに `ADR-0159`(`G-G8`。`V5-M17` が実装する)が値域を「アプリが宣言した
     * 利用者の種類」まで広げるので、コンパイル時に閉じた列挙にすると `V5-M17` で
     * 必ず壊れる。****新しい型名を1つも export していない**(`ADR-0171` 限定11 と同じ作法)。
     *
     * **判定は AND 1つである**(限定5): **行える人かどうかの自動判定が真** かつ
     * **(宣言が無い または 見ている人のロールが列挙に含まれる)**。
     * **書かなかった操作起点は今日どおりである**(限定4)。
     * **サーバの応答を1バイトも変えない**(限定6)—— **これは先回りガードであって
     * 防御ではない。** **【禁止】「宣言すれば押せなくなる」と書かない。**
     */
    actions?: (
      | {
          form: ResourceId;
          prefill: { field: ResourceId };
          name?: string;
          visible_when?: FilterLeaf;
          /** ボタンの識別子(`V8-M17` / `J-G9`。任意。同じ画面の中で一意)。 */
          id?: ResourceId;
        }
      /*
       * **【V4-M20-T01 / ADR-0100 限定1】形は列挙された有限の2形だけである。**
       *
       * - 形 (i) = 上(遷移。`ADR-0045` の最小形。**1バイトも変えていない**)
       * - 形 (ii) = 下(値の書換。`set` = 今開いているレコードの1フィールドを1つのリテラル値へ)
       *
       * **schema の `oneOf` が2形を排他に閉じており、3つ目の形は書けない。**
       * **`additionalProperties: false` を1バイトも外していない。**
       * **`trigger.type` を1バイトも触っていない**(限定5。ワークフローを名指しで起こす形は無い)。
       * **対象は今開いているレコード1行だけである**(限定4。複数行は `V4-M20` 単位C = 将来送り)。
       * **冪等ではない** —— 押した回数だけ書込が起きる(`ADR-0100` §限界1)。
       */
      | {
          set: { field: ResourceId; value: string | number | boolean };
          name?: string;
          visible_when?: FilterLeaf;
          /** ボタンの識別子(`V8-M17` / `J-G9`。任意。同じ画面の中で一意)。 */
          id?: ResourceId;
        }
      /*
       * **【`V5-M25-T01` / `L-G8` / `ADR-0174` 限定1〜限定12】4つ目の形(自動処理の起動)。**
       *
       * **上の「形は列挙された有限の2形だけである」「3つ目の形は書けない」は今日から
       * 偽である**(`ADR-0173` が3形目、本 ADR が4形目を足した)。**旧文を1バイトも
       * 書き換えていない。**
       *
       * **書けるのは `run`(起こすワークフローID)1つだけである**(限定4)——
       * **引数・条件・演算・複数指定を1つも書けない。**
       * **起こせるのは `trigger.type: "manual"` と宣言したワークフローだけ**(限定2)。
       * **対象は押した行1行だけ**(限定3)。
       * **島を名指しで起こす形は1つも無い**(限定7。`L-G9` = 将来送り)。
       * **冪等ではない** —— **押した回数だけ走る。** 防ぐのは実行中の重複だけである
       * (`ADR-0175`)。**【禁止】「二重押しが防げる」と書かない。**
       */
      | {
          run: ResourceId;
          name?: string;
          visible_when?: FilterLeaf;
          /** ボタンの識別子(`V8-M17` / `J-G9`。任意。同じ画面の中で一意)。 */
          id?: ResourceId;
        }
    )[];
    /**
     * 項目名と値の向き(D-G4 / F-5レイアウト。ADR-0050 限定1)。**任意**である。
     *
     * **`stacked` にすると `--detail-label-width`(テーマスロット)の意味が変わる** ——
     * `flex-basis` が高さとして解釈されるので、表示層は縦積み時にそれを無効化する規則を
     * 別に置く(限定8)。**テーマスロットの値そのものは1バイトも変えない。**
     */
    preset_label_placement?: "inline" | "stacked";
    /**
     * 項目の段組数(ADR-0050 限定1)。**`@media` を1つも足さない**(ADR-0046 限定5)ので、
     * **段組数は画面幅に追随しない固定値である。狭い画面では潰れる。**
     *
     * **【V4-M53 が 2026-08-04 に追記。門A / 限定採用。`ADR-0157`】上の前提
     * (「`@media` を1つも足さない」)は今日から偽である** —— **2026-08-04 実測:
     * `web/src/styles.css` に幅の条件の `@media` が2本ある**(`:913` 逐語
     * `@media (min-width: 40rem)` / `:919` 逐語 `@media (min-width: 64rem)`。
     * どちらも `.shell` の `padding` だけを変える)。**足したのは `ADR-0089`**
     * (`V4-M15-T07` / `D-V4-44`。2026-08-03)**で、同 ADR §Context 2 は逐語で
     * 「`ADR-0046` 限定5 を緩めている。緩めていないふりをしない」と書いている。**
     * **したがって上の文が根拠に引く `ADR-0046` 限定5 は、`web/src/styles.css` に
     * ついては今日はもう成り立たない**(限定表の行そのものは1バイトも動いていない)。
     *
     * **一方で帰結(段組数は画面幅に追随しない固定値である)は今日も真である** ——
     * **段組の規則(`[data-preset-columns=…]`)は `web/src/styles.css:693` /
     * `:699`(detail 側)に在り、2本の `@media` の内側には1つも入っていない**
     * (`web/test/preset-boundary.test.ts` の `(vi-5)` が波括弧の対応で実測している)。
     * **狭い画面で潰れることも今日どおりである。「レスポンシブになった」に倒さない。**
     * **旧文を1バイトも消していない**(`D-V4-188`。直し方は `ADR-0156` と同じ形)。
     */
    preset_field_columns?: 1 | 2;
    /**
     * `image` 型の表示サイズの段階値(ADR-0050 限定1)。**`related` の子一覧の画像にも当たる**
     * (同じ画面の中で見た目が割れないように1本の規則で当てる。ADR-0050 §4)——
     * 「詳細の項目はサムネイル、子一覧は中サイズ」の使い分けはできない。
     */
    preset_image_size?: "thumbnail" | "medium" | "original";
    /** `long_text` の切り詰め長の段階値(ADR-0050 限定1)。`related` の子一覧にも当たる。 */
    preset_text_preview?: "short" | "standard" | "long" | "full";
    /**
     * **この画面の詰まり具合**(`V4-M19-T03` / `ADR-0118`)。詳細は {@link ListView} の
     * `preset_density`。**`related` の子一覧も同じ器の内側にあるので一緒に詰まる** ——
     * **「詳細の項目はゆったり、子一覧は密」の使い分けはできない**(`preset_image_size` /
     * `preset_text_preview` が既に採っているのと同じ性質)。
     */
    preset_density?: "comfortable" | "compact";
    /** 逃げ道(任意 CSS)の参照(D-G5 / ADR-0055)。詳細は {@link EscapeHatchReference}。 */
    custom_css?: EscapeHatchReference;
    /**
     * 項目のまとまり(`P-G17` の (C) 側。`V4-M16-T12` / `ADR-0092` 限定1〜限定9)。
     * **`detail_view` でだけ持てる**(`list_view` / form 分岐は schema が `false` にする)。
     *
     * **値は「まとまりの名前 → そのまとまりに属するフィールドIDの配列」の1段だけである**
     * (限定3)—— **入れ子にしない。** **並び順を指定するキーを1つも持たない**ので、
     * **順序はマニフェストの記述順**である(`Object.keys` の順 = 書いた順)。
     * **まとまりの名前は表示名であって `ResourceId` ではない。**
     *
     * **`fields` を1バイトも変えていない**(限定4)—— **まとまりに属さない項目は今日どおり
     * 並ぶ。** 描画は「(1) どのまとまりにも属さない項目 →(2) 記述順のまとまり」の順である
     * (`web/src/views/DetailViewRenderer.tsx`)。
     *
     * **整合しない宣言は差分全体を拒否する**(限定5)—— **同じフィールドIDが2つのまとまりに
     * 現れたら拒否**し、**`fields` に無いIDを書いても拒否**する。**`fields` は任意**なので、
     * **`fields` を書いていない `detail_view`(= テーブル定義順の全項目)では対象テーブルの
     * フィールドで照合する。** 判定は `referential-integrity.ts` の1箇所にあり、
     * `add_view` / `update_view` の両経路を覆う。**拒否は「全か無か」**(`ADR-0047` 限定9)。
     *
     * **器の見せ方はアプリが選べない**(限定6)—— **タブか区切りかを指す語彙をここに置かない。**
     * **語彙(`RESOURCE_KINDS` / `FIELD_TYPES` / `DIFF_OPS`)は1つも増えていない**(限定1)。
     *
     * **【`CM-G24` / `V10-M24-T03` / `ADR-0371`】値は2つの形のどちらかである** ——
     * **(1) フィールドIDの配列**(着手前からの形。1バイトも変えていない)と、
     * **(2) `{ id?, fields }`**(名札 `id` を書き足せる形)。**名札は任意**であり、
     * **書いていないまとまりは今日どおり通る。****名札は描画に1度も読まれない**(限定6)——
     * **画面に出る文字はまとまりの名前(このマップのキー)である。**
     * **新しい `export type` を1本も足していない**(union をここにインラインで書く)——
     * **`$defs` 30 / `$defs/view.properties` 31 も1つも増えていない。**
     */
    field_groups?: Record<string, ResourceId[] | { id?: ResourceId; fields: ResourceId[] }>;
    /**
     * **この画面の書換ボタンが成立したあとの行き先**(`NV-G3a`。`V10-M1-T01` /
     * `ADR-0358` 限定1〜限定9)。**任意**である。
     *
     * **【意味のずれを隠さない(限定6)】詳細画面に「保存」という出来事は無い。**
     * **発火するのは `actions` の `set` 形(この画面の値の書換)の書込が
     * 成立したときだけである。** **`run` 形(自動処理の起動)の後は1ミリも遷移しない**
     * (限定2)—— **`handleRunAction` は 200 でも `result.failures` を出す形であり、
     * 「成功したら次へ」を付けると失敗しても次へ行くためである。**
     * **キーの名前が意味と合わないことは、審査が代償として引き受けた**
     * (`ADR-0358` §Consequences の1点目)。
     *
     * **値は同じアプリの実在するビューID 1つだけである**(限定3。{@link FormView} の
     * `after_save` と同じ `$ref` を受ける)—— **新しい構文を1バイトも作っていない。**
     * **成功 / 失敗で分けることも、確認の段を挟むことも、ボタン文言を変えることもできない。**
     * **実在しないIDを書いた差分は `referential-integrity.ts` が apply 時に倒す。**
     *
     * **画面に1本である**(限定5)—— **`set` のボタンが2つ以上あっても行き先は1つで、
     * ボタンごとには書けない。**
     *
     * **書かなかった詳細画面の挙動は1文字も変わらない** —— **今日どおり、`set` を
     * 押しても画面は移らない**(既定の行き先という概念を1つも作っていない)。
     * **宣言した画面がこのマニフェストに無ければ、その場に留まる**(壊れない)。
     *
     * **`update_view` で後から書けて、値が実際に運ばれる**(限定8)——
     * `applyViewChanges`(`apply-diff.ts`)の `detail_view` 分岐が運ぶ。
     * **`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは値が運ばれない**(両方要る)。
     * **前進では外せない** —— 別のビューIDに差し替えるか、undo で戻すか、
     * `remove_view` + `add_view` で作り直す。
     *
     * **`list_view` / `report_view` には今日も書けない**(限定1。`NV-G3b` = 却下)。
     */
    after_save?: ResourceId;
    /**
     * **削除が成立したあとの行き先**(`NV-G4`。`V10-M1-T02` /
     * `ADR-0359` §4a 限定1〜限定11)。**任意**である。
     *
     * **`$defs/view` の30キー目である** —— **`ADR-0359` §5 が `ADR-0289` /
     * `ADR-0340` の「30キー目を足してはならない」を両方まとめて引き直した。**
     * **置き換えとなる新しい不変条件は「32キー目を足してはならない」である。**
     *
     * **書けるのは `detail_view` だけである**(限定2)—— **削除という出来事は
     * `list_view` / `form` / `report_view` に無い。**
     *
     * **値は同じアプリの実在するビューID 1つだけである**(限定3)——
     * **新しい構文を1バイトも作っていない。** **外部 URL も別アプリの画面も
     * 相対指定も構造的に書けない。**
     *
     * **行き先にできるのは1件の行を必要としない画面(`list_view` / `report_view`)
     * だけである**(限定4)—— **`detail_view` / `form` を指した差分は
     * `referential-integrity.ts` が apply 時に倒す。****削除の直後にその行を
     * 開こうとして今日どおりのエラー画面になるためである。**
     *
     * **書かなかった詳細画面の挙動は1文字も変わらない**(限定5)——
     * **既定(同テーブルの `list_view` → 無ければアプリのビュー一覧)は無傷である。**
     * **宣言した画面がこのマニフェストに無ければ、その既定へ倒れる**(壊れない)。
     *
     * **確認の段もボタン文言も条件分岐も1つも作っていない**(限定6)——
     * **削除の確認ダイアログに1バイトも触っていない。**
     *
     * **テーブルに紐づかない案内ページは今日も作れない**(限定7。`E-G3` は却下のまま)
     * —— **「退会したらお別れの画面へ」は本キーを通しても今日は満たせない。**
     *
     * **`update_view` で後から書けて、値が実際に運ばれる**(限定10)——
     * `applyViewChanges`(`apply-diff.ts`)の `detail_view` 分岐が運ぶ。
     * **`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは値が運ばれない**(両方要る)。
     * **前進では外せない** —— 別のビューIDに差し替えるか、undo で戻すか、
     * `remove_view` + `add_view` で作り直す。
     *
     * **`RESOURCE_KINDS`(8)/ `FIELD_TYPES`(9)/ `DIFF_OPS`(17)を1つも動かして
     * いない**(限定11)。**`flow` は1バイトも実装していない**(`V10-M4` の担当)。
     */
    after_delete?: ResourceId;
  };

/**
 * **束ねるキー1本**(`V8-M8`。台帳 `Q-G1` / `Q-G2`。門A 本審査 = `V8-M7`)。
 *
 * **`granularity` は `date` 型の項目にだけ書き、`date` 以外には書けない** ——
 * **「書けるが効かない組み合わせ」を1つも作らない**(`ADR-0086` 限定4 と同型)。
 * **どちらの向きも `src/kernel/referential-integrity.ts` が apply 時に拒否する**
 * (型の上では表せないので、判定はカーネルの1箇所が持つ)。
 *
 * **束ねられるのは `select` / `reference` / `boolean` / `date` の4型だけである** ——
 * **`text` / `long_text` / `number` / `image` / `file` は束ねられない**(値が実質1行1値に
 * なるか、束ねる意味が定まらない)。
 */
export type ReportGroupBy = {
  /**
   * **【`V10-M24-T02` / `CM-G23a` / `ADR-0371` 限定1〜限定6】この束ねるキーの名札。**
   * **コメントの宛先として、この画面のこの列を名指しするために使う。**
   * **任意である** —— 書かなければ今日どおり通り、名指しできないだけである。
   * **一意なのは同じ画面の中だけ**で、別の画面には同じ名札を書ける。
   * **集計表では `group_by` と `aggregates` が1つの名前空間である**
   * (宛先の形が `(view_id, report_node_id)` の1形だから)。
   * **集計の結果を1つも変えない**(`computeReport` の出力を1バイトも変えていない)。
   * **`report.sort` が指す番号(`index`)とは無関係である。**
   */
  id?: string;
  /**
   * **その項目を持っている表**(`V8-M9`。台帳 `Q-G6`)。
   *
   * **省略すると起点の表(`view.table`)を指す** —— **`V8-M8` までの宣言は
   * 1バイトも書き換えずにそのまま通る。**
   * **`report.join` に入っていない表を指したら apply 時に拒否する。**
   */
  table?: ResourceId;
  /**
   * **束ねる項目のID。**
   *
   * **【2026-08-15 追記(`V8-M9`。ユーザ決定 `D-V8-126`)。上の doc の
   * 「束ねられるのは4型だけである」は今日は全量ではない】** **予約された行の番号
   * (`_id`)を書くと、その表の**行そのもの**で束ねる**(1行が1群)。
   * **`_id` はどの表の `fields` にも現れないので、型の側では `ResourceId` のままである**
   * —— **書ける予約名が `_id` ただ1つであることは
   * `src/kernel/referential-integrity.ts` の類型18c が apply 時に閉じる**
   * (`_created_at` / `_updated_at` / `st_owner` / `st_public` / `st_undeletable` /
   * `st_no_direct_create` の6本は1つずつ拒否される)。
   * **`granularity` と同時には書けない**(行の番号は日付ではない)。
   * **群の数は起点の表の行数と等しくなる。**
   */
  field: ResourceId;
  granularity?: "day" | "week" | "month";
};

/**
 * **結合1本**(`V8-M9`。台帳 `Q-G6` / `Q-G7` / `Q-G8`。門A 本審査 = `V8-M7`。裁定 `M7-1`)。
 *
 * **`{ table: T, via: f }` は「表 `T` の `reference` 型フィールド `f` による突き合わせ」を表す。**
 * **`f` が指す先の表を `U` とすると、`T` と `U` のうち**ちょうど一方だけ**が、すでに結合の
 * 集合に入っていなければならない** —— **入っているのが `T` なら順方向(子 → 親。多対一。
 * 行数は増えない)、`U` なら逆方向(親 → 子。一対多。行数が増える)である。**
 * **両方入っていれば閉路・同じ表の2度結合として拒否し、どちらも入っていなければ孤立として
 * 拒否する**(判定は `src/kernel/referential-integrity.ts` の1箇所)。
 *
 * **`on` 句を持たない** —— **突き合わせに使えるのは実在する `reference` 型フィールド1本
 * だけであり、任意の2列を等値で結ぶ場所がスキーマにも型にも1つも無い。**
 * **`select`(射影)も計算式も持たない。**
 *
 * **宣言の順序が評価の順序である**(**プランナを持たない**)。
 */
export type ReportJoin = {
  table: ResourceId;
  via: ResourceId;
};

/**
 * **集計1本**(`V8-M8`。台帳 `Q-G3` / `Q-G4`)。
 *
 * **種類は `sum` と `count` の2値ちょうどである** —— **`avg` / `min` / `max` / `median` /
 * `count(distinct)` を1つも書けない**(`ADR-0104` 限定2 が `sum_field` に課した閉じを、
 * 名前を書く場所を持つ形に移しても2値のまま保っている)。
 * **`sum` は `number` の列を1本だけ取り、`count` は列を取らない** —— **どちらの違反も
 * apply 時に拒否する。**
 */
export type ReportAggregate = {
  /**
   * **【`V10-M24-T02` / `CM-G23a` / `ADR-0371` 限定1〜限定6】この集計値の名札。**
   * **コメントの宛先として、この画面のこの列を名指しするために使う。**
   * **任意である** —— 書かなければ今日どおり通り、名指しできないだけである。
   * **一意なのは同じ画面の中だけ**で、別の画面には同じ名札を書ける。
   * **集計表では `group_by` と `aggregates` が1つの名前空間である**
   * (宛先の形が `(view_id, report_node_id)` の1形だから)。
   * **集計の結果を1つも変えない**(`computeReport` の出力を1バイトも変えていない)。
   * **`report.sort` が指す番号(`index`)とは無関係である。**
   */
  id?: string;
  type: "sum" | "count";
  /**
   * **その列を持っている表**(`V8-M9`。台帳 `Q-G6`)。
   *
   * **省略すると起点の表(`view.table`)を指す。**
   * **`count` にも書ける** —— **その表の行が結び付いた行だけを数えるので、
   * 逆方向の結合で子が1件も無い群は 0 になる**(`D-V8-120`。**「売れていない商品が 0 で
   * 並ぶ」の実体である**)。
   */
  table?: ResourceId;
  field?: ResourceId;
};

/**
 * **集計表の中身**(`V8-M8`。台帳 `Q-G1`。`schemas/manifest.schema.json` の `$defs/report`)。
 *
 * **絞り込みは既存の `filter` の型をそのまま指す** —— **2つ目の絞り込み語彙を作っていない。**
 * **深さの上限(`MAX_FILTER_DEPTH`)も既存の読取経路が持つものがそのまま効く** ——
 * **集計表専用のフィルタコンパイラを1本も作っていない。**
 * **`having`(集計値で絞る)を1つも持たない**(`ADR-0104` 限定9 不可侵)。
 */
export type ReportDeclaration = {
  /**
   * **結合**(`V8-M9`。台帳 `Q-G6`〜`Q-G9`)。**省略できる**(**結合は必須ではない** ——
   * `required` は `["group_by", "aggregates"]` のままである)。
   * **書ける本数は4本まで**(**起点を含めて5表**。裁定 `M7-1`)。詳細は {@link ReportJoin}。
   */
  join?: ReportJoin[];
  group_by: ReportGroupBy[];
  aggregates: ReportAggregate[];
  /**
   * **絞り込みは今日も起点の表にだけ掛かる**(`V8-M9` で1バイトも変えていない)——
   * **結合先の列で絞る形を1つも作っていない**(`ADR-0043` §3a-3。**子の条件で親の行を
   * 落とす形が生まれない**)。**代償は「区分Bの注文だけを商品ごとに集計する」が書けないこと。**
   */
  filter?: FilterCondition[] | FilterNode;
  /**
   * **群の並べ替え**(`V8-M11`。台帳 `Q-G21a` / `Q-G12`。ユーザ決定 `D-V8-130`)。
   *
   * **【2026-08-15 追記。上の doc の「`having`(集計値で絞る)を1つも持たない
   * (`ADR-0104` 限定9 不可侵)」を1バイトも書き換えていない】** ——
   * **`ADR-0104` 限定9 のうち **`sort` の側だけ**を、集計表の中に限って開いた。**
   * **`having` は今日も1つも持たず、集計値を検索の対象にするキーも1つも無い** ——
   * **開いたのは「並べる」だけで、「絞る」側は1ミリも動いていない。**
   *
   * **指し方は添字である**(`v8-m11.md` §1-0c の決定2)—— **`aggregates` の要素は `id` を
   * 持たないので、`{type, field}` の対では同じ対が2本ある宣言が曖昧になる。**
   * **`index` は宣言に書いた順の番号で、先頭が 0 である。**
   * **値域は 12通りちょうどに閉じてある**(`schemas/manifest.schema.json` の
   * `$defs/report.properties.sort`)—— **「宣言した本数の内側であること」だけは
   * JSON Schema で表せないので `src/kernel/referential-integrity.ts` が apply 時に拒否する。**
   *
   * **省略できる** —— **書かなかったときの順序は着手前と1バイトも同じである**
   * (**束ねるキーの宣言順の辞書式・昇順・`null` は最後**。決定3)。
   *
   * **【新しい型名を1つも作っていない】** —— **`scripts/kernel-export-snapshot.txt` は
   * `src/kernel/` の公開識別子を1つ増やすだけで赤くなる**(`ReportJoin` /
   * `ReportAggregate` / `ReportGroupBy` はすべてそこに載っている)。
   * **本キーは既存の型の中にインラインで書いてあるので、公開面が1つも増えていない。**
   */
  sort?: {
    /** **`group_by` なら束ねるキーの値で、`aggregate` なら集計値で並べる。** */
    target: "group_by" | "aggregate";
    /** **宣言に書いた順の番号**(先頭が 0)。**本数以上は apply 時に拒否される。** */
    index: number;
    /**
     * **昇順 / 降順。** **`desc` は比較の向きを反転させるだけである**(`null` は先頭に来る)。
     *
     * **【2026-08-15。メインの裁定(`v8-m11.md` §1-0e の**決定15**)。上の1行を1バイトも
     * 書き換えていない。ただし今日は偽である】** **`null` の群は、昇順でも降順でも
     * 常に最後である** —— **「値が無い群」は順位の対象外だからである。**
     * **`null` を寄せるのは反転の**外側**であり、`compareGroupValue` の本文は1バイトも
     * 書き換えていない**(書き換えると `sort` を書かなかったときの既定の順序が動く)。
     * **効くのは `target: "group_by"` の降順だけである** —— **集計値には `null` が
     * 1つも出ない。**
     */
    order: "asc" | "desc";
  };
  /**
   * **グラフ種別**(`V8-M12`。台帳 `Q-G23`。門A 本審査 = `V8-M7`。判定 = 限定採用。
   * ユーザ決定 `D-V8-131`。実施記録 `docs/plan/v8/records/v8-m12.md` §1-0c の決定1〜決定3)。
   *
   * **`$defs/report.properties` の6本目である**(5本 → 6本)。
   * **【2026-08-15。`ADR-0344` 限定1 の逐語「`$defs/report.properties` は 5本ちょうどに
   * なった」と、その担保「6本目を足さない。」は今日は偽である。旧文を1バイトも
   * 書き換えていない】** —— **引き直す個別 ADR は `V8-M12-T08` が起草する。**
   *
   * **値域は2値ちょうどである**(棒 / 折れ線)—— **3値目を足さない。**
   * **スカラー1本なので、1つの集計表に置けるグラフは構造的に1つである。**
   *
   * **省略できる** —— **`required` は今日も `["group_by", "aggregates"]` の2本ちょうどで、
   * ここに `chart` を足していない**(**足すと既存の集計表の宣言が全部拒否される**)。
   * **省略したときは棒である。** **既定はスキーマにも本型にも書いていない** ——
   * **`schemas/manifest.schema.json` の逐語「schema に default を書かない」(`ADR-0104` の
   * 作法)に従い、既定は表示層(`V8-M12-T04`)が持つ。**
   * **【正直に書く。承知した代償】宣言を読んだだけでは棒が出ることが分からない。**
   *
   * **【新しい型名を1つも作っていない】** —— **`scripts/kernel-export-snapshot.txt` は
   * `src/kernel/` の公開識別子を1つ増やすだけで赤くなる。**
   * **本キーは既存の型の中にインラインで書いてあるので、公開面が1つも増えていない**
   * (`sort` が採ったのと同じ形)。
   */
  chart?: "bar" | "line";
};

/**
 * **集計表**(`V8-M8`。**画面種別の4種目**。台帳 `Q-G1`。門A 本審査 = `V8-M7`)。
 *
 * **持てるキーは `$defs/view` の `allOf` の `report_view` 分岐と一致させてある** ——
 * **型のほうを広くすると「型では書けるがスキーマが拒む」形になる**(`ListView.actions` が
 * `Extract` で狭めてあるのと同じ作法)。**したがって `columns` / `fields` / `related` /
 * `actions` / `sort` / `filter` / `sum_field` / `preset_` 系はこの型に1つも無い。**
 *
 * **`custom_css` と `menu_listed` と `name` は3種と同じく持てる**(逃げ道と導線は既存どおり)。
 *
 * **【正直に書く】この画面を描く実装は今日1バイトも無い**(描くのは `V8-M11`)——
 * **今日この宣言が返すのは `GET /api/apps/<app_id>/views/<view_id>/report` の応答だけである。**
 *
 * **【2026-08-16 訂正(`V8-M13-T04`。台帳 `Q-G30`)。直前の2行を1バイトも書き換えていない】**
 * **直前の2行は今日は偽である** —— **集計表はブラウザに描かれる**
 * (`V8-M11-T06`。描くのは `web/src/views/ReportViewRenderer.tsx` で、`ViewHost` の
 * `report_view` 分岐が選ぶ)。**画面の上にグラフ、下に群の表が出る**(`V8-M12`)。
 * **この型は1バイトも変わっていない** —— **描画は `View` をそのまま受ける作法の内側に収まった。**
 */
export type ReportView = ViewDisplayName &
  ViewMenuListing & {
    id: ResourceId;
    type: "report_view";
    table: ResourceId;
    report: ReportDeclaration;
    /** 逃げ道(任意 CSS)の参照(D-G5 / ADR-0055)。詳細は {@link EscapeHatchReference}。 */
    custom_css?: EscapeHatchReference;
  };

export type View = ListView | FormView | DetailView | ReportView;

/**
 * レコードが作られたときに発火する(ADR-0013 §5)。
 *
 * `table` は**宣言テーブルのIDのみ**である。システムテーブル(`_apps` / `_changelog`)は
 * 指定できない(限定10)—— スキーマ側では `$defs/resource_id` を指しており、
 * `$defs/view_table_id`(システムテーブルを許す方)は使っていない。
 */
export type WorkflowTriggerOnCreate = {
  type: "on_create";
  table: ResourceId;
};

/** レコードが更新されたときに発火する(ADR-0013 §5)。 */
export type WorkflowTriggerOnUpdate = {
  type: "on_update";
  table: ResourceId;
};

/**
 * 発火する時刻(24時間制)。
 *
 * **cron 式を採らない**(ADR-0013 §6b)。`filter` / `sort` と同じく構造化オブジェクトで
 * 書く —— cron 式を採ると AI が覚える規則に「cron の文法」が丸ごと1つ増える。
 * **曜日指定・月指定・間隔指定を足してはならない**(限定6)。
 */
export type ScheduleAt = {
  hour: number;
  minute: number;
};

/**
 * 決まった時刻に発火する(ADR-0013 §6)。
 *
 * **静的指定のみである**(限定6)。アプリ内のスケジュールテーブルによる動的指定
 * (「このレコードの期日に発火」)を実装してはならない。
 */
export type WorkflowTriggerSchedule = {
  type: "schedule";
  at: ScheduleAt;
  /**
   * 行を列挙する対象のテーブルID(**任意**。`D-G16a` / ADR-0063)。
   *
   * 書くと、発火時にその表の行を**1件ずつトリガー元レコードとして**処理する
   * (`$record.<フィールド>` と `when` が解決できるようになる)。書かなければ
   * 従来どおり行を1件も対象にせず、1回だけ発火する。
   *
   * **`on_create` / `on_update` の `table` と同じキーだが意味が違う**
   * (あちらは「監視する対象」、こちらは「行を列挙する対象」)。ADR-0063 §2 (g) が
   * この二重の意味を代償として申告している。**行単位の発火済み台帳は作らない**
   * (限定4)。**1回の発火で処理する行数には上限がある**(限定5。
   * `workflow-scheduler.ts` の `SCHEDULE_ROW_LIMIT`)。
   */
  table?: ResourceId;
  /**
   * 対象を「一定時間経った行」だけに絞る述語(**任意**。`D-G16b` / ADR-0064)。
   *
   * **時刻専用の1形であり、一般の比較演算子ではない。**書けるのは
   * 「`field`(`table` に実在する `date` 型フィールド)の値が、**発火した日**から
   * `days` 日以上前であること」の1つだけである。**数値や文字列の大小を比べる
   * 手段はカーネルのどこにも無い**(ADR-0064 §2 の (a) が新しい非対称として申告)。
   *
   * - **境界は `>=`** —— 「ちょうど `days` 日前」を**含む**。
   * - **日付の境界は `ST_TIMEZONE`** で決まる(`clock.ts` の `zonedNow`)。
   * - **発火の可否には1ミリも影響しない**(限定3)。影響するのは「発火したとき、
   *   どの行を対象にするか」だけである。`isDue` を1バイトも変えていない。
   * - **`table` が無い `schedule` には書けない**(ADR-0063 に完全従属する。限定5)。
   *   `on_create` / `on_update` にも書けない(schema の `allOf` が塞ぐ)。
   *
   * **`older_than` の隣に `newer_than` を、`days` の隣に `hours` を足してはならない**
   * —— どちらも小さい差分であり、それが危険の本体である(ADR-0064 §3a)。
   * **専用の型名を新設しない**(`src/kernel/` の公開エクスポート集合〔Δ8〕を
   * 1つも増やさないため。`when` が `FilterCondition` を再利用したのと同じ作法)。
   */
  older_than?: {
    /** 経過を測る `date` 型フィールドのID(実在と型は apply 時に検査する)。 */
    field: ResourceId;
    /** 何日以上前か(1〜3650 の整数。境界は「以上」)。 */
    days: number;
  };
};

/**
 * ワークフローの発火条件(3種)。
 *
 * **`on_delete` / `on_view` / `on_undo` / `on_error` を足してはならない**(限定4)。
 * 特に `on_delete` は必ず出てくる要求であり、通すには門A を通したうえで
 * 「削除された行を参照するアクションが何を受け取るのか」に答えること(行はもう無い)。
 */
export type WorkflowTrigger =
  | WorkflowTriggerOnCreate
  | WorkflowTriggerOnUpdate
  | WorkflowTriggerSchedule
  | WorkflowTriggerManual;

/**
 * **画面のボタンから名指しで起こす**(`V5-M25-T01` / `L-G8` / `ADR-0174` 限定1)。
 *
 * **【上の doc の「発火条件(3種)」は今日から偽である。旧文は1バイトも消していない】**
 * **`ADR-0174`(門A / 判定 = 限定採用)が `ADR-0013` 限定4 の**数の分だけ**を無効化した。**
 * **名指しで禁じられた4つ(`on_delete` / `on_view` / `on_undo` / `on_error`)は
 * 今日も1つも足していない。**
 *
 * `table` は**押した行が乗っている表**である。**`on_create` / `on_update` の
 * 「監視する対象」でも、`schedule` の「行を列挙する対象」でもない** ——
 * **同じ `table` キーの3つ目の意味である。隠さない**(`ADR-0063` §2 (g) が
 * 2つ目の意味を代償として申告したのと同じ形の代償)。
 *
 * **起こせるのは `$defs/view_action` の4形目(`run`)からだけである**(限定2 / 限定6)。
 * **`DIFF_OPS` に `run_workflow` を1つも足していない** ので、MCP からは起こせない
 * (`ADR-0176` = 入口は HTTP に1本だけ)。
 * **外部への送信を含むワークフローは `manual` にできない**(限定5。
 * `referential-integrity.ts` が apply 時に倒す)。
 */
export type WorkflowTriggerManual = {
  type: "manual";
  table: ResourceId;
};

/**
 * レコードを1件作る(ADR-0013 §7)。
 *
 * `values` の値に書ける参照は **`$record.<フィールドID>` の形だけ**である(限定12)。
 * `$` で始まらない文字列はリテラルとして扱う。**演算子・条件式・関数呼び出し・
 * 文字列連結を1つも足してはならない** —— 足すとそれはミニ言語であり、AI が覚える規則が
 * 文法ごと増える。
 */
/*
 * アクションの実行条件(EC-G5 条件分岐。ADR-0036)—— 各アクション種の任意プロパティ `when`。
 *
 * **値は `FilterCondition`(`list_view.filter` の要素)をそのまま再利用する。**最小述語
 * `{field, equals}` の1形のみ —— トリガー元レコードの `field` の値が `equals` と等しいときだけ
 * そのアクションを実行し、不一致ならスキップする(スキップは履歴に loud に残る。憲法6)。
 * **演算子・比較(lt/gt/lte/gte)・論理結合(and/or)・else・ネスト・条件式・関数呼び出しを
 * 1つも足してはならない** —— 足すなら門A(ADR-0007)を通し個別 ADR を書くこと(ADR-0036 §3a)。
 * `schedule` トリガー(トリガー元レコードが無い)× `when` は解決できないため apply 時/実行時に拒否。
 *
 * **`FilterCondition` を直接使い、`when` 専用の型名を新設しない** —— `src/kernel/` の公開
 * エクスポート集合(Δ8)を1つも増やさないため(ADR-0036 は Δ3 = schema キー1つの増分であって
 * Δ8 = kernel 公開面の拡張ではない。ADR-0036 Consequences「filter の構造化等値が2箇所目の
 * 利用者を得た」)。
 */
export type WorkflowActionCreateRecord = {
  action: "create_record";
  table: ResourceId;
  values: Record<string, string>;
  when?: FilterCondition;
};

/**
 * レコードを1件更新する(ADR-0013 §7)。
 *
 * `target` は更新対象のレコードを指す(`values` の値と同じ語彙で書く)。
 * MCP ツールの `update_record`(`src/mcp/tools/write.ts`)と名前が同じだが、
 * **呼ぶ主体が違う**(あちらは AI、こちらはカーネル)。どちらも `_changelog` には
 * 載らない(限定11 / `RECORD_WRITE_NOT_IN_CHANGELOG`)。
 */
export type WorkflowActionUpdateRecord = {
  action: "update_record";
  table: ResourceId;
  target: string;
  values: Record<string, string>;
  when?: FilterCondition;
};

/**
 * 外部の宛先へ送信する(ADR-0020 §3。V1-M4-T03)。
 *
 * **これは capability(接続)必須のアクションである。**書けること(マニフェストに
 * 現れること)と、実行されること(送信されること)は別である —— `runAction` は
 * connection の有無と宛先スコープを**実行層で同期に照合**し、許可されたときだけ
 * outbox に積む(fetch は非同期の `dispatchOutbox` が行う。ADR-0020 §3 改訂2 の
 * アウトボックス方式)。connection が無い / スコープ外なら1件も積まれず、送信は
 * 物理的に始まらない(限定8c-5 の実行層遮断)。
 *
 * `connection` は connection の**人間可読名**(ID ではない。app スコープ内で一意)。
 * `payload` の値に書ける参照は **`$record.<フィールドID>` の形だけ**である
 * (ADR-0020 §8c-7。`values` と同じ語彙。演算子・条件式・関数・文字列連結を1つも足さない)。
 */
export type WorkflowActionCallExternal = {
  action: "call_external";
  connection: string;
  destination: string;
  payload: Record<string, string>;
  when?: FilterCondition;
};

/**
 * 機能内の AI 呼び出し(ADR-0021 §3。V1-M5-T02)。
 *
 * **これは capability(AI capability)必須のアクションである。**`call_external` の
 * 兄弟であり、構造は同型 —— 書けること(マニフェストに現れること)と実行されること
 * (AI が呼ばれること)は別である。`runAction` は capability の有無と当日の上限を
 * **実行層で同期に照合**し、許可されたときだけ ai_jobs に積む(実際の推論は非同期の
 * `dispatchAiJobs` が行う。ADR-0021 §3 のチェック/配送分離)。capability が無い /
 * 上限超過 / トリガー元レコードが無いなら1件も積まれず、AI 呼び出しは物理的に始まらない
 * (ADR-0021 §8c-5 の実行層遮断)。
 *
 * **`call_external` との唯一の違いは結果をレコードへ書き戻すこと**である(request-response)。
 * `output_field` はトリガー元レコードのフィールドで、AI の構造化出力を **`output_field` の
 * 制約(型 / select 選択肢)で検証**してから書き戻す(ADR-0021 §3b。AI の出力を信頼しない)。
 * 検証に通らない / 呼び出し失敗のときは `fallback`(リテラル)を書き戻す。
 *
 * `capability` は AI capability の**人間可読名**(ID ではない。app スコープ内で一意)。
 * `input` / `prompt` の値に書ける参照は **`$record.<フィールドID>` の形だけ**である
 * (ADR-0021 §8c-8。`values` と同じ語彙。演算子・条件式・関数・文字列連結を1つも足さない)。
 *
 * **`ai_transform` はトリガー元レコードを要する**(`on_create` / `on_update`)——
 * 書き戻し先(`output_field`)がそのレコードだからである。`schedule` トリガーで書くと
 * 実行時に fail-closed する(`$record` が解決できないのと同型)。
 */
export type WorkflowActionAiTransform = {
  action: "ai_transform";
  capability: string;
  prompt: string;
  input: Record<string, string>;
  output_field: ResourceId;
  fallback: string;
  when?: FilterCondition;
};

/**
 * 関数(コードの島)を起動する(ADR-0024 §Decision。V1-M6-T05 第2段)。
 *
 * **これは capability 必須ではなく、関数リソースを起動する内部アクションである**
 * (call_external / ai_transform が capability 必須なのと違う。ADR-0024 §増分表)。
 * `function` は `app.functions` にある `FunctionDef` の ID、`output_table` は島の出力を
 * 書き込む先のテーブル ID。
 *
 * ## 実行の意味論(ADR-0024 §Decision / 限定2 / 限定7)
 *
 * `runAction` が **同期の実行層**で島を走らせる(`call_external` / `ai_transform` と
 * 並ぶ早期分岐):(1) `FunctionDef` を引き、(2) `function.input`(table / view / record)を
 * 既存語彙で解決して行を集め、(3) 宣言された capability のブリッジだけを注入し、
 * (4) `runIslandSync` で島を走らせ、(5) 出力(行の配列)を `function.output.fields` の型で
 * **必ず検証**してから(限定4。検証不能なら fail-closed で output_table を1バイトも触らない)、
 * (6) **`output_table` の既存行を全削除 → 検証済み行を挿入**する(関数出力の全置換 = 再計算)。
 *
 * **`output_table` は関数出力専用テーブルであることを設計契約とする**(全置換なので、
 * 人手や他アクションで書いた行は次の実行で消える)。宛先は必ず**同一アプリの `tables`**
 * であり、システムテーブルは指せない(限定7。スキーマが `$defs/resource_id` で担保)。
 *
 * ## EC-G6 演算 = record 書き戻しモード(Route B。ADR-0037)
 *
 * `write_back: "$record"` を指定すると、`output_table` 全置換の**代わりに**、島の出力
 * (**1行**)を `function.output.fields` で検証してから**トリガー元レコード自身のフィールドへ
 * `updateRecord` で書き戻す**(`ai_transform` の `output_field` 書き戻しと同型)。用途は
 * 行内演算 —— 例: `line_total = 単価 × 数量` を子の行自身に書く。**演算は島の JS で
 * 行い、カーネルは式言語を1つも持たない**(`$defs/action_value` 不変 = ADR-0013 限定12 不可侵)。
 *
 * - **`output_table` と排他**: `write_back` があれば record 書き戻し・無ければ従来の
 *   `output_table` 全置換(スキーマの then 分岐が機械的に排他を担保。限定6)。よって
 *   `output_table` は**任意**になった(write_back モードでは持たない)。
 * - **書き戻し先はトリガー元テーブルの実在フィールドに限定**(存在しないフィールドは
 *   fail-closed。`function.output.fields` とトリガー元テーブルの不整合は apply 時に拒否)。
 * - **`schedule` トリガー(レコード源が無い)× `write_back` は fail-closed**(`ai_transform` と同型)。
 * - **値は固定形 `"$record"` のみ**(const)—— 別テーブル・別行を指せない。**クロス行更新
 *   (別の行の値の減算・親集計)は M4 の target 語彙であって Route B の射程外**(ADR-0037 §3a)。
 * - `write_back` の値の型は `FilterCondition` を再利用する `when` と違い**リテラル `"$record"`**
 *   であり、新しい公開型を1つも増やさない(Δ8 非発火。ADR-0037 S2)。
 */
export type WorkflowActionRunFunction = {
  action: "run_function";
  function: ResourceId;
  /** 全置換モードの出力先。`write_back` / `write_ops` を使うときは持たない(排他)。 */
  output_table?: ResourceId;
  /** record 書き戻しモード(Route B。ADR-0037)。固定形 `"$record"` のみ。 */
  write_back?: "$record";
  /**
   * **op 配列モード(第3のモード。D-G15 / ADR-0067)。固定値 `true` のみ。**
   *
   * 島が返した更新操作の配列(`BatchOp[]`)を、**既存のバッチ器 `writeRecords`
   * (`src/kernel/batch.ts` / ADR-0039)に流して1トランザクションで適用する** ——
   * 1 op でも失敗すれば全部巻き戻り1バイトも書かない。**op は create / update の2種だけ**
   * で、**update は `if_match`(版一致)必須**である(限定 A1 / A7。新しい CAS 機構を
   * 作らず、ワークフローの `update_record` は LWW のまま = `ADR-0040` 限定5 不変)。
   * **カーネルは演算を1つも持たない** —— 「今の値 − 変化分」を計算するのは島の JS であり、
   * `$defs/action_value` を1バイトも触らない(`ADR-0013` 限定12 不可侵)。
   * **`output_table` / `write_back` とは排他**(3値排他。限定 A3)。
   * **apply 時の参照整合性検査は op に1つも及ばない**(限定 A11)—— op は実行時に
   * 生成されるので、宛先の不在は実行時に fail-closed で落ち、発火元の書込ごと成立しなく
   * なる(`ADR-0066`)。**`schedule` に原子性の器は1バイトも無い**(限定 A12)。
   */
  write_ops?: true;
  when?: FilterCondition;
};

/**
 * ワークフローのアクション(5種)。
 *
 * **`call_external` は ADR-0020 で採用され、capability(接続)必須のアクションとして
 * 追加された**(2種 → 3種。ADR-0013 限定5 を1つ破り、ADR-0020 §8c-1 が新しい禁止形を
 * 定義した)。**`ai_transform` は ADR-0021 で採用され、capability(AI capability)必須の
 * アクションとして追加された**(3種 → 4種。ADR-0020 §8c-1「外部到達アクションは1つだけ」を
 * 1つ破り、ADR-0021 §8c-1 が新しい禁止形を定義した)。**`run_function` は ADR-0024 で
 * 採用された5種目**であり、外部到達アクションではなく**関数リソースを起動する内部アクション**
 * である(ADR-0024 §増分表)。**依然として `delete_record` / `notify` / `send_email` /
 * `run_script` / `ai_generate` 等を足してはならない**(ADR-0020 §8c-1 / ADR-0021 §8c-1 /
 * ADR-0024 限定2)。`create_record` / `update_record` の宛先は必ず**同一アプリの `tables`**
 * であり、外部への到達は `call_external`、AI 呼び出しは `ai_transform`、関数の起動は
 * `run_function` の1種ずつに畳む。
 */
export type WorkflowAction =
  | WorkflowActionCreateRecord
  | WorkflowActionUpdateRecord
  | WorkflowActionCallExternal
  | WorkflowActionAiTransform
  | WorkflowActionRunFunction;

/**
 * 自動化の定義(ADR-0013)。**リソース種の6種目である。**
 *
 * **「上位に立つ」は、配列の置き場所ではなく参照の向きで表現される**(ADR-0013 §1a)——
 * `workflow` は `tables` を参照し、`tables` は `workflow` を1バイトも参照しない。
 * `view` も同じ形で `tables` を参照するが、`view` が1つしか参照しないのに対し、
 * `workflow` は入力(`trigger.table`)と出力(`actions[].table` / `history_table`)の
 * 両方を参照する。**これが「情報から情報への遷移」のスキーマ上の姿である。**
 *
 * `history_table` は実行履歴の出力先で、**ユーザ(AI)が `add_table` で作る通常の
 * テーブルである。**カーネルは自動生成しないし(限定8)、システムテーブルも1本も
 * 足さない(限定9)。
 */
export type Workflow = {
  id: ResourceId;
  name: string;
  trigger: WorkflowTrigger;
  actions: WorkflowAction[];
  history_table: ResourceId;
  /**
   * **この自動処理が「誰の行として」書くか**(`E-G41` / `V4-M10-T09` / `ADR-0079` 限定1〜4)。
   *
   * **値の形は `$record.<参照フィールドID>` の1つだけである**(限定2。schema の `pattern` が
   * 機械的に閉じる)—— **任意のユーザ id も固定 actor も書けない。**
   * **辿るのは1ホップだけ**(限定3)。**辿れないときは今日どおり fail-closed**(限定4)。
   * **書かなければ今日どおり**(トリガー元レコード自身の `st_owner`)。
   */
  act_as?: string;
};

/**
 * 関数(コードの島)への入力の宣言(ADR-0024 §Decision / 限定3)。
 *
 * **既存語彙への参照だけを書ける** —— カーネルにクエリ言語(where / filter / select /
 * count / group_by)を1つも足さない(§7a / 限定3)。「どの行か」は既存の list_view が
 * 既に持つ filter / sort で表す。
 *
 * - `source: "table"` … そのテーブルの全行を配列で島に渡す。`table` 必須・`view` 禁止。
 * - `source: "view"` … 既存 list_view の filter / sort を適用した行を渡す。`view` 必須・`table` 禁止。
 * - `source: "record"` … トリガー元の1レコード(`$record`)を渡す。`table` / `view` 禁止。
 *
 * 要否は `schemas/manifest.schema.json` の `$defs/function_input` が
 * `workflow_trigger` と同じ allOf + if/then 作法で締める(oneOf / anyOf を使わない。F-21)。
 *
 * **【ADR-0062 / V3-M9-T01】この型そのものは1バイトも変わっていない。** 複数入力で
 * 増えたのは `FunctionDef.input` が**この型の配列も取りうる**ことだけであり、
 * **入力の種類(3枝)は1つも増えていない**(限定1 / 限定2)。**新しい型名を1つも作らない。**
 */
export type FunctionInput =
  | {
      source: "table";
      table: ResourceId;
      /**
       * **島に渡す行を「トリガー元のレコードを指しているものだけ」に絞る**
       * (`E-G72` / `V4-M10-T44` / `ADR-0083` 限定1・限定5・限定6)。
       *
       * **その子テーブル上の単一の reference フィールドIDであり、参照先はトリガー元の
       * テーブルでなければならない。** **突き合わせは等値1つだけ**
       * (`child.<via> == トリガー元の _id`)で、**条件を書く場所も値を書く場所も無い。**
       * **形と意味論は `related.via`(`ADR-0044`)の再利用である。**
       * **書かなければ今日どおりテーブルの全行が渡る**(限定12)。
       */
      via?: ResourceId;
    }
  | { source: "view"; view: ResourceId }
  | { source: "record" };

/**
 * 関数の定義(ADR-0024)。**リソース種の7種目である。**
 *
 * **「上位に立つ」は参照の向きで表現される**(ADR-0013 §1a と同型)—— `function` は
 * tables / views / capabilities を参照し、tables / views は function を1バイトも
 * 参照しない。
 *
 * - `code` … 島のソース(JS)。**カーネルは中身を解釈しない**(憲法1: 賢さはデータ=島に
 *   閉じ込め、カーネルは退屈な実行器のまま)。実行は ADR-0023 のサンドボックス(第2段 T03)。
 * - `input` … 島に渡すものを既存語彙への参照で宣言する(`FunctionInput`)。**ADR-0062
 *   (D-G14 / V3-M9-T01)により、1つだけ書く単体形に加えて最大5要素の配列形を取れる。**
 *   配列形のとき島は**宣言順に並んだ配列**を受け取り、どの行がどの行に対応するかの
 *   突き合わせは**島の JavaScript が行う** —— **カーネルは結合・射影・集約・参照解決・
 *   重複排除・ソートを1行も実装しない**(限定4)。**参照展開(`$record.<ref>.<field>`)・
 *   多段・join を1つも作らない**(限定7。ADR-0040 限定2 / ADR-0044 限定3 は不変)。
 *   **単体形のとき島が受け取る値は今日と同一である**(配列で包まない。限定12)。
 * - `output` … 島の返り値が満たすべきスキーマ。**入出力は必ずスキーマで表現される**
 *   (ADR-0024 限定3 / 限定4)。返り値の検証実行は第2段の runner だが、宣言としてここに
 *   持つ。**2形ある**(排他。ADR-0067 限定 A1 / A3): `{ fields: [...] }` = 行の配列を
 *   返す(`output_table` 全置換 / `write_back` 書き戻しの2モードが使う。各フィールドの型は
 *   `FIELD_TYPES` のいずれか)/ `{ ops: true }` = **更新操作の配列を返す**(`write_ops`
 *   モードだけが使う)。**op の中身の型をここに置かない** —— op は実行時に島が生成し、
 *   構造は既存のバッチ器(`BatchOp` / `writeRecords`)が、値は `createRecord` /
 *   `updateRecord` が検証する(ADR-0003 §7)。
 * - `capabilities` … 島が使ってよい capability(connection / ai_capability の人間可読名)。
 *   省略時は空(既定 `[]`)。**マニフェスト外(人間ストア)を指すので参照整合性検査の
 *   対象にしない**(実行時にブリッジが fail-closed で照合する。第2段 T04。ADR-0024 §8)。
 */
export type FunctionDef = {
  id: ResourceId;
  name: string;
  code: string;
  input: FunctionInput | FunctionInput[];
  /**
   * 出力スキーマ(**2形。排他**。ADR-0024 限定4 / ADR-0067 限定 A1)。
   *
   * - `{ fields: [...] }` … 島は**行の配列**を返す(既存2モード。1バイトも変えていない)。
   * - `{ ops: true }` … 島は**更新操作の配列**を返す(`run_function` の `write_ops` モード)。
   *   **op の形は `src/kernel/batch.ts` の既存の `BatchOp` であり、新しい op 語彙を1つも
   *   足していない**(create / update の2種のみ。delete / where 句 / 反復構文は無い)。
   *
   * **新しい公開型を1つも export しない**(`Δ8` 非発火。`ADR-0037` S2 と同型)—— この形は
   * `FunctionDef` の中にだけ置く。
   */
  output:
    | { fields: { id: ResourceId; type: FieldType }[]; ops?: undefined }
    | { ops: true; fields?: undefined };
  capabilities?: string[];
};

/**
 * アプリのルート。
 *
 * **`workflows` はスキーマの `required` に入っていない**(ADR-0013 §1)—— 入れると
 * 既存マニフェストが全部 invalid になり `readCurrentManifest` が例外を投げる。
 *
 * **型でも任意(`workflows?`)にしてある。**V1-M2-T07 は最初 `workflows: Workflow[]`
 * (必須)で実装したが、**実際に壊れた** —— `tsc --noEmit` が48件のエラーを出し、
 * その中には `src/kernel/create-app.ts:84`(空マニフェストを
 * `{ id, name, tables: [], views: [] }` として作る)という**実装コードが含まれていた。**
 * 予防的に緩めたのではなく、壊れた事実だけを根拠に落としている。
 * これによりスキーマ(`required` に入れない)と型(任意)の対応が一致し、
 * `ResourceId` の doc コメントが述べる「検証の最終権限は JSON Schema 側にある」
 * という関係も保たれる。**省略は「ワークフローが1つも無い」と同じ意味である。**
 */
export type App = {
  id: ResourceId;
  name: string;
  tables: Table[];
  views: View[];
  workflows?: Workflow[];
  /**
   * アプリが持つ関数(コードの島)の定義(ADR-0024)。
   *
   * **`workflows` と同じく optional である**(ADR-0024。スキーマの `required` に
   * 入れない —— 入れると既存マニフェストが全部 invalid になる)。省略は
   * 「関数が1つも無い」と同じ意味である。
   */
  functions?: FunctionDef[];
  /**
   * アプリのテーマ(見た目)。ADR-0047(D-G2 / V3-M1)。
   *
   * **`workflows` / `functions` と同じく optional である**(スキーマの `required` に
   * 入れない —— 入れると既存マニフェストが全部 invalid になる)。省略は
   * 「テーマを持たない」= `web/src/styles.css` の既定値で描画される、という意味である。
   */
  theme?: Theme;
  /**
   * **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`。判定値 = 廃止】`user_kinds` を取り除いた。**
   *
   * **ここに在ったのは `user_kinds?: UserKindDeclaration[];` と、その doc(`ADR-0158` /
   * `ADR-0248` の制定時の説明)である。** **`schemas/manifest.schema.json` の
   * `$defs/app/properties/user_kinds` を同じ差分で消したので、この型が写す先が無くなった。**
   *
   * **代わりに立つのは下の `roles` である**(`ADR-0301` 限定2)—— **人に付けられる値の
   * 一覧・登録で名乗れる値・非運営の種類の表示名の3つを、`app.roles[].id` と
   * `app.roles[].name` が担う。**
   * **担い手が無いものは `schemas/manifest.schema.json` の `$defs/app/properties/roles` の
   * `$comment` 末尾に4件、名指しで書いた。**
   */
  /**
   * アプリが宣言する役割の一覧(`V8-M16`。台帳 `J-G1b` / ユーザ決定 `D-V8-31`。
   * **書き込む差分操作は18種目の `set_roles` である**)。
   *
   * **`workflows` / `functions` / `theme` / `user_kinds` と同じく optional である**
   * (スキーマの `required` に入れない —— 入れると既存マニフェストが全部 invalid になる)。
   * 省略は「役割を1つも宣言していない」という意味である。
   *
   * ## 値域をこの型で表さない理由
   *
   * **正は `schemas/manifest.schema.json` の `$defs/app/properties/roles` である**
   * (上限12 / 識別子は `^[a-z0-9_]{1,32}$` / 予約4語 `owner` `editor` `viewer`
   * `anonymous` を**書ける**)。**ここに写すと機械的に照合されない複写ができ、黙ってずれる**
   * (`user_kinds` / `Theme` と同じ扱い)。
   *
   * **【正直に書く】判定の実装は `V8-M16` に1バイトも無い。** 規則(`rules`)は `V8-M17`、
   * 条件(`when`)は `V8-M18` が足す。**今日この宣言を書いても、行の読取・書込・削除の
   * ふるまいは1つも変わらない。**
   */
  roles?: RoleDeclaration[];
};

/**
 * 役割の宣言1件(`V8-M16`。台帳 `J-G1b`)。
 *
 * **持てるのは `id` と `name` の2本だけである** —— **規則(`rules`)は `V8-M17` が足す。**
 * `V8-M16` は器だけを立てており、3本目のキーを1バイトも書いていない。
 *
 * **`id` の値域は予約4語(`owner` / `editor` / `viewer` / `anonymous`)∪
 * `app.user_kinds[].id` と同じ形の文字列である。****これは「運営3ロールの予約が解けた」
 * ことを意味しない**(`D-V8-31` の逐語)—— 予約は今日どおり `user_kinds` の側で効いており、
 * その `not: { enum: [...] }` を1バイトも動かしていない。
 *
 * **【2026-08-09 追記(`V8-M17`。台帳 `J-G6`〜`J-G11`)。上の「持てるのは `id` と `name` の
 * 2本だけである」は今日から偽である。旧文を1バイトも消していない】** **3本目の `rules`
 * (役割に束ねた「できること」)を `V8-M17` が足した。** **省略できる** —— **省略は
 * 「この役割は面の規則を1本も持たない」= 面の管轄外(全許可)を意味する**(裁定 `R-4`)。
 *
 * =====================================================================================
 * **【2026-08-14 追記(`V8-M1-T02` / `V8-M1-T03`。台帳 `I-G1` / `I-G6` = どちらも
 * **限定採用**。[`ADR-0334`](../../docs/adr/0334-role-signup-mode-declaration.md))。
 * 上の doc の「3本目の `rules`」で閉じるという読みは今日から偽である。
 * 1バイトも消していない】**
 * =====================================================================================
 *
 * **4本目の `signup`(この役割で登録できるか)を足した。** **値域は `"open"` / `"invite"`
 * の2値ちょうどで、省略時は `"open"`**(= 着手前と1バイトも変わらない)。
 *
 * - **`schemas/manifest.schema.json:92` の `V8-M17` 追記「要素は id / name / rules の
 *   3キーで閉じる。4キー目を足してはならない」と `ADR-0322` 限定4 を正面から破っている。**
 *   **旧文は1バイトも消さず、`schemas/` 側に新しい `$comment` を隣に置いた。**
 * - **名前付きの型を新しく `export` していない**(`SignupMode` のような名前を1つも作らない)
 *   —— **インラインの union で書く。** **`ADR-0007` の `Δ8`(`src/kernel/` の公開
 *   エクスポートが増える)を発火させない**、**より小さい増分**を採った(`ADR-0334` 限定7)。
 * - **正は `schemas/manifest.schema.json` の
 *   `$defs/app/properties/roles/items/properties/signup` である** —— **`anonymous` には
 *   書けないという非対称(限定4)を、この型は表せない**(`rules` の部分集合と同じ扱い。
 *   ここに写すと機械的に照合されない複写ができ、黙ってずれる)。
 * - **【正直に書く】カーネルはこの値を1つも検査しない。** **`foldSetRoles` は
 *   `manifest.app.roles = structuredClone(roles);` の全置換1行であり、`signup` について
 *   何も見ない**(`ADR-0334` 限定7)。 **判定はサーバ層(`src/server/auth-routes.ts` の
 *   述語1本)が持つ**([`ADR-0335`](../../docs/adr/0335-signup-single-predicate-and-env-precedence.md))。
 * - **【正直に書く】この宣言は権限を1ミリも変えない**(同 限定8)—— **行の読取・書込・
 *   削除を決めるのは `rules` であって、`signup` は `rules` を1バイトも触らない。**
 */
export type RoleDeclaration = {
  id: ResourceId;
  name?: string;
  /**
   * **この役割で登録できるか**(`V8-M1`。`ADR-0334`)。**省略時は `"open"`。**
   * **`"invite"` は「招待が要る」を意味するが、判定はサーバ層が持つ**(`ADR-0335`)。
   */
  signup?: "open" | "invite";
  rules?: RoleRule[];
};

/**
 * 役割に束ねた規則1本(`V8-M17`。台帳 `J-G6` / `J-G7` / `J-G8` / `J-G9` / `J-G10` /
 * `J-G11`。メインの裁定 `R-13`)。
 *
 * **1本は「対象 × 動詞」である** —— **条件(`when`)は `V8-M18` が足す。`V8-M17` には
 * 1バイトも無い。**
 *
 * - **対象は4種ちょうど**: `table`(表)/ `field`(項目)/ `view`(画面)/ `action`(ボタン)。
 * - **動詞は3語ちょうど**: `read` / `write` / `delete`。**綴りは
 *   `$defs/table.access_control.permissions` の3語と同じである**(新しい綴りを作らない)。
 * - **対象ごとに書ける動詞の部分集合**は 表 = 3語 / 項目 = `read` `write` / 画面 = `read` /
 *   ボタン = `read` である。**この型は部分集合を表せない** —— **正は
 *   `schemas/manifest.schema.json` の `$defs/app/properties/roles/items/properties/rules`
 *   であり、`allOf` の `if`/`then` が確定形で閉じている**(`user_kinds` / `Theme` と
 *   同じ扱い。ここに写すと機械的に照合されない複写ができ、黙ってずれる)。
 * - **`anonymous` の要素だけ、対象から `field` が除かれ、動詞が `read` に絞られる**
 *   (`J-G11`)。**その分岐もスキーマ側にある。**
 *
 * **【正直に書く】拒否(deny)を表す値は1つも無い**(`J-G2` の限定)—— **`can` は
 * 「できること」の列挙であって、真偽値でも除外リストでもない。**
 *
 * **【この型を読むのは誰か】** **サーバ層の判定(`src/server/owner-scope.ts` の系列)が
 * この型を読む。** **`V8-M17` は判定を1バイトも書いていない** —— **型と宣言だけである。**
 *
 * =====================================================================================
 * **【2026-08-11 追記(`V8-M28`。台帳 `T-G14` / `T-G17` = どちらも **限定採用**。
 * ユーザ決定 `D-V8-49`)。上の doc の「対象は4種ちょうど」は今日から偽である。
 * 1バイトも消していない】**
 * =====================================================================================
 *
 * **対象は6種である** —— **5種目 `app`(アプリの設定 = 定義の変更)と
 * 6種目 `role`(人の役割 = 役割の配布)を足した。**
 * **`ADR-0304` 限定2「対象は4種ちょうど。5種目を足さない」を正面から破っている** ——
 * **破ってよい根拠は `ADR-0007` §8 の台帳2行(`T-G14` / `T-G17`)の判定である。**
 *
 * - **新しい2対象の動詞は `write` 1語ちょうどである** —— **`read` も `delete` も書けない。**
 * - **新しい2対象には `table` / `field` / `view` / `action` / `when` を1つも書けない** ——
 *   **名指しする対象を持たないからである**(アプリ全体 / 役割の配布そのものが対象)。
 * - **この型はその部分集合を表せない**(既存4対象と同じ扱い)—— **正は
 *   `schemas/manifest.schema.json` の `allOf` の6分岐である。**
 * - **`RoleRuleVerb` に4語目を足していない**(今日も `read` / `write` / `delete` の3語)。
 */
export type RoleRule = {
  target: "table" | "field" | "view" | "action" | "app" | "role";
  table?: ResourceId;
  field?: ResourceId;
  view?: ResourceId;
  action?: ResourceId;
  can: RoleRuleVerb[];
  /**
   * **【2026-08-09 追記(`V8-M18`。台帳 `J-G12`〜`J-G16`)。上の doc コメントの
   * 「条件(`when`)は `V8-M18` が足す。`V8-M17` には1バイトも無い」は今日から偽である。
   * 旧文を1バイトも消していない】**
   *
   * **この規則が当たる条件。省略できる** —— **省略したら今日どおり「常に通る」。**
   * **書けるのは対象が表(`table`)か項目(`field`)の規則だけである** ——
   * **画面とボタンには判定する行が1つも無い**(スキーマの `allOf` が `when: false` で
   * 閉じている)。**この型はその部分集合を表せない**(`can` の部分集合と同じ扱いであり、
   * 正は `schemas/manifest.schema.json` である)。
   */
  when?: RoleCondition;
};

/**
 * 役割の規則が当たる条件(`V8-M18`。台帳 `J-G12` / `J-G13` / `J-G14` / `J-G15`。
 * ユーザ決定 `D-V8-17` / `D-V8-22`。メインの裁定 `R-7` / `R-17`)。
 *
 * **正は `schemas/manifest.schema.json` の `$defs/role_condition`(`$defs` の29本目)である。**
 * **ここに在るのは TypeScript 側の写しであり、値域の正ではない。**
 *
 * **組み立ては「かつ」「または」「でない」の3つちょうど**(`D-V8-17`)。
 * **葉は2種ちょうど** —— (1) 項目の値が定数と等しい /(2) 項目の値が要求している人と
 * 等しい(`D-V8-22` の「担当が自分」)。
 *
 * **【センチネル文字列を1文字も作っていない】**(`J-G13` の限定)—— **「自分」は
 * `equals_current_user` という専用のキーで表す。** **`@current_user` のような文字列は
 * 値域に1つも無い**(`ADR-0016` §9 が却下している)。**`equals_current_user` に書けるのは
 * `true` だけであり、「自分でない」は `not` で書く。**
 *
 * **条件から見えるのは2つだけである**(`J-G15`)—— 判定している行の項目の値と、
 * 要求している人の識別子。**他の表 / 他の行 / 時刻 / 環境変数 / 集計値 / 参照先の中身は
 * 1つも見えない。**
 *
 * **【この型を読むのは誰か】** **評価器はカーネルに1バイトも無い。** **カーネルがするのは
 * 形の検査(値域・深さ・指し先の実在)だけであり、条件を評価するのはサーバ層である**
 * (`src/server/owner-scope.ts` の判定の家。裁定 `R-17-7`)。
 * **【禁止】これを「だからカーネルは退屈なままである」と `V8-M18` が断定しない** ——
 * **憲法1 の射程を確定させるのは `J-G40` の ADR である**(裁定 `R-17-8`)。
 *
 * **【`V8-M26`。ユーザ決定 `D-V8-70`(2026-08-11)。上の「**葉は2種ちょうど**」は今日から
 * 偽である。旧文を1バイトも消していない】**
 *
 * **葉は3種である** —— 3つ目は **`{field, is_empty}`(その項目が空か)**。
 * **`is_empty` に書けるのは `true` だけであり、「空でない」は `not` で書く**
 * (葉に否定形を1つも作らない、という上の作法を1バイトも破っていない)。
 *
 * **足した理由**: **`V8-M26` の自動付与が `st_owner` の表の規則を「自分の行だけ」に絞った
 * 結果、`st_owner` が空の行(= 共有行)が誰にも見えなくなった。**
 * **「自分の行、または持ち主が空の行」を書く手だてが語彙に1つも無かった。**
 *
 * **【「空」の定義。1箇所にしか無い】** **`null` / 値が入っていない / 長さ0の文字列 の3つ。**
 * **`0` と `false` は空ではない。** **述語の実体は `src/server/owner-scope.ts` の
 * `isSharedOwner` であり、評価器はそれをそのまま呼ぶ。**
 *
 * **【未ログイン】** **この葉は「要求している人」を1バイトも見ないので、未ログインでも
 * 真になりうる**(`equals_current_user` が未ログインで必ず偽なのとは向きが違う)。
 */
export type RoleCondition =
  | { field: ResourceId; equals: string | number | boolean }
  | { field: ResourceId; equals_current_user: true }
  | { field: ResourceId; is_empty: true }
  | { and: RoleCondition[] }
  | { or: RoleCondition[] }
  | { not: RoleCondition };

/**
 * 誰も通さない条件・全員を通す条件の知らせ(`V8-M18`。台帳 `J-G16` の限定の逐語
 * 「**書いた人に返る形で伝える**」)。
 *
 * **拒否ではない。** **適用は通り、知らせだけが `applyDiff` の結果に載って返る**
 * (`ApplyDiffResult.role_condition_notices`)。**MCP の `apply_diff` の応答にも同じ配列が
 * 出る。** **【禁止】「黙って何もしない」を作らない** —— **黙って全員を弾く条件は、
 * 権限の穴と区別がつかない**(`04` §7 の `V8-M18` の (vi))。
 *
 * **【正直に書く】検出できる形と、検出できない形の両方を名指しで列挙してある** ——
 * 正は `src/kernel/apply-diff.ts` の `collectRoleConditionNotices` の doc コメントと、
 * `src/kernel/role-conditions.test.ts` の (T-6) の「【この形は検出しない】」群である。
 * **【禁止】「矛盾を全部見つける」と書かない。**
 */
export type RoleConditionNotice = {
  /**
   * `never_matches` = 誰も通さない / `always_matches` = 全員を通す。
   *
   * **【2026-09-08 追記(`V17-M5-T04`。台帳 `AC-G17`(`:1843`)/ `AC-G18`(`:1844`)。
   * ユーザ決定 `D-V16-6`。`ADR-0422`)。上の1行は1バイトも消していない】**
   *
   * **3種目が在る** —— **`grants_bypassed` = 行ごとにアクセス権を配っている表を、
   * 条件を1つも書かずに扱う規則がある**(**その表に配った行ごとの権限が、その役割に
   * ついては丸ごと意味を失う**)。**これも拒否ではない。適用は通る。**
   * **役割 `owner` の規則には出さない**(ユーザ決定 `D3`。**穴として自認してある** ——
   * 正は `src/kernel/apply-diff.ts` の `collectGrantsBypassedNotice` の doc)。
   *
   * **【2026-09-08 追記(`V17-M5-T05`。台帳 `AC-G33`(`:1862`)。踏む条文 `ADR-0318`
   * 限定12。引き受けは `ADR-0331`。`ADR-0423`)。上の2つの記述は1バイトも消していない】**
   *
   * **4種目が在る** —— **`owner_scope_supplied` = カーネルが、持ち主の列(`st_owner`)を
   * 持つ表を条件なしで扱う規則へ、持ち主で絞る条件を**補った**。**
   * **これも拒否ではない。適用は通る。**
   * **既存3種が「適用後の姿を見て気づいたこと」を伝えるのに対し、これだけは
   * カーネル自身が**書き換えたこと**を伝える。**
   * **役割 `owner` にも出す** —— **`grants_bypassed` の `D3`(`owner` を外す)は
   * 3種目についての決定であり、4種目には及ばない。** **こちらは実際に `owner` の
   * 規則を狭めているので、黙ると「黙って狭まった」ことになる。**
   * **`ADR-0422` が足したのは3種目1つちょうど、`ADR-0423` が足すのは4種目1つちょうどで
   * あり、今日の合計は4種である。**
   */
  kind: "never_matches" | "always_matches" | "grants_bypassed" | "owner_scope_supplied";
  /** どの役割の規則か。 */
  role: ResourceId;
  /**
   * 条件の位置(`/app/roles/<i>/rules/<j>/when`)。
   *
   * **【2026-09-08 追記(`V17-M5-T04` / `AC-G18` / `ADR-0422`)。上の1行は1バイトも
   * 消していない】** **`kind` が `grants_bypassed` のときだけ形が違う** ——
   * **`/app/roles/<i>/rules/<j>`(`/when` が付かない)である。**
   * **`when` を1つも持たない規則を指すので、`/when` を付けると指し先が存在しない。**
   */
  path: string;
  /** 何を見つけたか(人間向けの日本語)。 */
  message: string;
  /** どう直すか。 */
  hint: string;
};

/**
 * 役割の規則が持てる動詞(`V8-M17`。台帳 `J-G10` の限定の逐語「動詞は読取/書込/削除の
 * 3語ちょうど」)。
 *
 * **4語目を足してはならない** —— 足すには `ADR-0007` の門A を新規に通すこと。
 */
export type RoleRuleVerb = "read" | "write" | "delete";

/**
 * 既定の役割定義3本の識別子(`V8-M17`。台帳 `J-G2` / ユーザ決定 `D-V8-26`)。
 *
 * **新しいアプリの `app.roles` に最初から入る3本であり、`set_roles` でも消せない。**
 *
 * - **入れるのは `src/kernel/create-app.ts`**(表示名 `name` も同ファイルが持つ)。
 * - **消えていないことを検査するのは `src/kernel/referential-integrity.ts`。**
 * - **この定数がここに在るのは、その2箇所が同じ3語を別々に持たないためである**
 *   (「判定を2箇所に住まわせない」)。
 *
 * **`anonymous` は入らない** —— **予約4語のうち3語だけであり、未ログインは
 * アプリの作者が要るときだけ書く。**
 *
 * **表示名(`name`)は変えてよい** —— **要求するのは `id` の3本が全部在ることだけである。**
 * **既定に規則(`rules`)を足すこともできる** —— **それが `J-G2` の限定「アプリの作者は
 * 既定に足すことしかできず、引き算(拒否)を1つも書けない」の中身である。**
 */
export const DEFAULT_ROLE_IDS = ["owner", "editor", "viewer"] as const;

/**
 * **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a` / `T-G12`。判定値 = 廃止】**
 * **ここに在った `UserKindDeclaration`(利用者の種類の宣言1件)を取り除いた。**
 * **`AppManifest.user_kinds` と `SetUserKindsOperation` の2箇所からしか使われておらず、
 * その2つを同じ差分で取り除いたためである。**
 * **代わりに立つのは `RoleDeclaration` である**(`id` / `name` / `rules` の3キー)。
 */

/**
 * アプリのテーマ(ADR-0047)。**実値がここに入る**(D-M1-1 / D-4)—— これにより
 * dry_run / changelog / undo / redo / スナップショットが既存機構のまま効く。
 *
 * ## スロット名と値域をこの型で列挙しない理由
 *
 * **正は `schemas/manifest.schema.json` の `$defs/theme` である**(25キーで閉じ、
 * 全キーが `required`、値域は型と形式で縛る。ADR-0047 限定5 / 限定6 / 2026-07-25 追記(2))。
 * ここに25個のキーを書き下すと、**スロット集合の4つ目の複写**ができる ——
 * ADR-0046 限定1 が照合するのは3箇所(`styles-token-slots.txt` / `$defs/theme` /
 * `src/kernel/theme-contrast.ts` の役割表)であり、**4つ目は機械的に照合されないので
 * 黙ってずれる。** `ResourceId` がパターンを型で表さずスキーマに委ねているのと同じ扱いである。
 *
 * **したがって「スロットが25個そろっていること」を保証するのは型ではなくスキーマである。**
 * `applyDiff` / `applyManifest` / `createApp` はいずれも `validateManifestFull` を
 * `"incoming"` で通すので、欠けたテーマがディスクに書かれることはない。
 *
 * ## 由来(`origin`)はカーネルが検証しない
 *
 * テンプレート app の実在も版の一致も**自己申告である**(ADR-0047 §1b / 限定7。憲法6)。
 * 参照整合性検査の対象にしない —— 対象にすると、テンプレート app を削除した日に
 * 既存アプリのマニフェストが読めなくなる。**版に新しい概念を作らない** ——
 * 使うのは `_changelog` の `diff_id` であり、`App` に `version` を新設しない。
 */
export type Theme = {
  /** スロット名 → 値。**25キーちょうど**であることは `$defs/theme` が担保する。 */
  slots: Record<string, string>;
  /** 由来。省略できる(手で作ったテーマは由来を持たない)。**真偽は検証されない。** */
  origin?: {
    template_app_id: ResourceId;
    template_diff_id?: ResourceId;
  };
};

/** マニフェスト(永続化される JSON のトップレベル)。 */
export type Manifest = {
  app: App;
};

/** update_view で変更できる範囲(1つ以上指定する)。 */
export type ViewChanges = {
  /**
   * 表示名(V1-M0-T02)。3種すべてのビューで変更できる。
   * `add_view` で付けた名前を後から直す手段がないと、誤った表示名が永久に残る
   * (v0 の差分は additive で、キーを消す語彙が無い)。
   */
  name?: string;
  columns?: ResourceId[];
  sort?: Sort | Sort[];
  filter?: FilterCondition[];
  fields?: ResourceId[];
  /**
   * 画面ごとの見せ方(D-G4 / F-5レイアウト。ADR-0050 / ADR-0051)。**7軸すべてが
   * 独立したキーである** —— 1キーにまとめると `applyViewChanges` がキー単位の全置換
   * なので「1軸だけ書くと他軸が黙って既定へ戻る」ことになり、憲法6(できないことは
   * 正直に言う)が禁じる形になる(ADR-0050 §2 (c))。
   *
   * **どのキーがどのビュー種別で書けるかは `CHANGE_KEYS_BY_VIEW_TYPE`(`apply-diff.ts`)と
   * マニフェストスキーマの `allOf` 3分岐が決める** —— `form` には1キーも書けない。
   * **`DIFF_OPS` は16のままであり、プリセット専用の op は無い**(限定3)。
   */
  preset_column_align?: Record<ResourceId, "left" | "center" | "right">;
  preset_column_width?: Record<ResourceId, "narrow" | "standard" | "wide">;
  preset_pager_position?: "top" | "bottom" | "both";
  preset_label_placement?: "inline" | "stacked";
  preset_field_columns?: 1 | 2;
  preset_image_size?: "thumbnail" | "medium" | "original";
  preset_text_preview?: "short" | "standard" | "long" | "full";
  /**
   * 逃げ道(任意 CSS)の参照(D-G5 / ADR-0055 **改訂1**)。詳細は {@link EscapeHatchReference}。
   *
   * **3種すべてのビューで書ける**(`name` と同じ)。**キーを消す手段は無い** ——
   * `applyViewChanges` はキー単位の差し替えなので、**書かなかったキーは「触らない」**
   * である。**外すには undo で戻すか `remove_view` + `add_view` で作り直すしかない**
   * (プリセット7キーと同じ性質)。
   *
   * **`DIFF_OPS` は16のままである**(逃げ道専用の op は無い。限定3)。
   */
  custom_css?: EscapeHatchReference;
  /**
   * 画面一覧への掲載の可否(`E-G12` / `V4-M10-T45` / `ADR-0084` 限定6)。
   * 詳細は {@link ViewMenuListing}。
   *
   * **3種すべてのビューで書ける**(`name` / `custom_css` と同じ)。
   *
   * **`update_view` で後から書けて、値が実際に運ばれる** —— `applyViewChanges`
   * (`apply-diff.ts`)が `name` と同じ場所で運ぶ。**`audience`(`update_view` の変更範囲に
   * 入っていない)/ `writable_by` / `representative_field`(`diff.schema.json` にキーは在るが
   * カーネルが値を運ばない)の穴を、新しいキーで踏み直さない**(限定6)。
   * **【2026-08-10 追記(`V8-M20`。台帳 `J-G27` / `J-G28`)。旧文を1バイトも消していない】**
   * **前例として名指しした3本のうち `audience` と `writable_by` は今日は存在しない**
   * (`V8-M20` が廃止した)。**前例そのものは歴史として今日も真であり、踏み直さないという
   * 結論も変わらない。** **今日も残っている前例は `representative_field` の1本である。**
   *
   * **`true` を書き直せば前進で戻せる** —— プリセット7キーと違い、既定と同じ挙動になる値
   * (`true`)が値域の中に在る。**ただしキーそのものを消す手段は今日も無い。**
   *
   * **`DIFF_OPS` は16のままである**(掲載専用の op は無い。限定1)。
   */
  menu_listed?: boolean;
  /**
   * 詳細画面の項目のまとまり(`P-G17` の (C) 側。`V4-M16-T12` / `ADR-0092` 限定2・限定5・限定9)。
   * 詳細は {@link DetailView} の `field_groups`。
   *
   * **`detail_view` でだけ書ける**(`CHANGE_KEYS_BY_VIEW_TYPE` が種別で絞り、マニフェスト側の
   * `allOf` の `list_view` / form 分岐も `false` で閉じている)。
   *
   * **`update_view` で後から書けて、値が実際に運ばれる** —— `applyViewChanges`
   * (`apply-diff.ts`)の `detail_view` 分岐が運ぶ。**`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは
   * 値が運ばれない**(両方要る)。**`writable_by` / `representative_field` の「キーは在るが
   * 効かない」穴を新しいキーで踏み直さない。**
   *
   * **前進では外せない**(限定9)—— キーを消す手段は無く、外すには undo で戻すか
   * `remove_view` + `add_view` で作り直す(プリセット7キー / `custom_css` / `menu_listed`
   * と同じ性質)。**`DIFF_OPS` は16のままである**(まとまり専用の op は無い)。
   *
   * **【`CM-G24` / `V10-M24-T03` / `ADR-0371`】値の形は {@link DetailView} の
   * `field_groups` と同じ2形である** —— **フィールドIDの配列**か、**`{ id?, fields }`**。
   * **`update_view` の経路でも名札を書ける**(`applyViewChanges` はキー単位で丸ごと
   * 差し替えるので、運び先は1バイトも変えていない)。**`DIFF_OPS` は17のままである**
   * (名札専用の op を1つも足していない)。
   */
  field_groups?: Record<string, ResourceId[] | { id?: ResourceId; fields: ResourceId[] }>;
  /**
   * 一覧の器の形(`P-G24` の (C) 側。`V4-M16-T13` / `ADR-0093` 限定2・限定8・限定10)。
   * 詳細は {@link ListView} の `preset_list_shape`。
   *
   * **`list_view` でだけ書ける**(`CHANGE_KEYS_BY_VIEW_TYPE` が種別で絞り、マニフェスト側の
   * `allOf` の form / `detail_view` 分岐も `false` で閉じている)。
   *
   * **`update_view` で後から書けて、値が実際に運ばれる** —— `applyViewChanges`
   * (`apply-diff.ts`)の `list_view` 分岐が運ぶ。**`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは
   * 値が運ばれない**(両方要る)。**`writable_by` / `representative_field` の「キーは在るが
   * 効かない」穴を新しいキーで踏み直さない。**
   *
   * **前進では外せない**(限定10)—— キーを消す手段は無く、外すには undo で戻すか
   * `remove_view` + `add_view` で作り直す(他の `preset_` / `custom_css` / `menu_listed` /
   * `field_groups` と同じ性質)。**`DIFF_OPS` は16のままである。**
   */
  preset_list_shape?: "table" | "card";
  /**
   * 重ねて出す宣言(`P-G14` の (C) 側。`V4-M18-T03` / `ADR-0095` 限定6・限定10)。
   * 詳細は {@link FormView} の `modal`。
   *
   * **`form` でだけ書ける**(`CHANGE_KEYS_BY_VIEW_TYPE` が種別で絞り、マニフェスト側の
   * `allOf` の `list_view` / `detail_view` 分岐も `false` で閉じている)。
   *
   * **`update_view` で後から書けて、値が実際に運ばれる** —— `applyViewChanges` の
   * `form` 分岐が運ぶ。**`menu_listed` を偽にしていない画面に `true` を書くと、畳み込み後の
   * マニフェスト検証が差分全体を拒否する**(`ADR-0095` 限定5)。
   *
   * **前進では外せない**(限定10)—— 外すには undo で戻すか `remove_view` + `add_view`。
   * **`DIFF_OPS` は16のままである。**
   */
  modal?: boolean;
  /**
   * 検索の対象にする列(`E-G7` の (C) 側。`V4-M22-T01` / `ADR-0112` 限定2・限定5・限定6)。
   * 詳細は {@link ListView} の `search_fields`。
   *
   * **`list_view` でだけ書ける**(`CHANGE_KEYS_BY_VIEW_TYPE` が種別で絞り、マニフェスト側の
   * `allOf` の form / `detail_view` 分岐も `false` で閉じている)。
   *
   * **`update_view` で後から書けて、値が実際に運ばれる** —— `applyViewChanges` の
   * `list_view` 分岐が運ぶ。**実在しないフィールドID・`text` / `long_text` 以外の型・
   * 役割の規則(`app.roles[].rules`)が名指ししている項目を名指しすると、畳み込み後の
   * マニフェスト検証が差分全体を拒否する**(`ADR-0112` 限定5・限定6。**`add_view` と
   * 同じ1箇所で判定する**。**【`V8-M20-T02`】3つ目の着手前の逐語は「`audience` を宣言した
   * 項目」だった。そのキーは廃止された**)。
   *
   * **前進では外せない** —— 外すには undo で戻すか `remove_view` + `add_view`。
   * **`DIFF_OPS` は16のままである。**
   */
  search_fields?: ResourceId[];
  /**
   * 1ページに出す件数(`E-G8` / `E-G11` の (C) 側。`V4-M22-T05` / `ADR-0113` 限定2・限定3)。
   * 詳細は {@link ListView} の `page_size`。
   *
   * **`list_view` でだけ書ける**(`CHANGE_KEYS_BY_VIEW_TYPE` が種別で絞り、マニフェスト側の
   * `allOf` の form / `detail_view` 分岐も `false` で閉じている)。
   *
   * **`update_view` で後から書けて、値が実際に運ばれる** —— `applyViewChanges` の
   * `list_view` 分岐が運ぶ。**範囲内でも enum に無い整数は拒否される。**
   *
   * **前進では外せない** —— 外すには undo で戻すか `remove_view` + `add_view`。
   * **`DIFF_OPS` は16のままである。**
   */
  page_size?: 10 | 20 | 50 | 100;
  /**
   * 合計を出す列(`D-V4-89` / `E-G31`。`V4-M23-T01` / `ADR-0104` 限定2〜限定4)。
   * 詳細は {@link ListView} の `sum_field`。
   *
   * **`list_view` でだけ書ける**(`CHANGE_KEYS_BY_VIEW_TYPE` が種別で絞り、マニフェスト側の
   * `allOf` の form / `detail_view` 分岐も `false` で閉じている)。
   *
   * **`update_view` で後から書けて、値が実際に運ばれる** —— `applyViewChanges` の
   * `list_view` 分岐が運ぶ。**実在しないフィールドID・`number` 以外の型・役割の規則
   * (`app.roles[].rules`)が名指ししている項目を名指しすると、畳み込み後のマニフェスト
   * 検証が差分全体を拒否する**(**`add_view` と同じ1箇所で判定する**。
   * **【`V8-M20-T02`】3つ目の着手前の逐語は「`audience` を宣言した項目」だった。
   * そのキーは廃止された**)。
   *
   * **前進では外せない** —— 外すには別のフィールドIDに差し替えるか undo で戻すか
   * `remove_view` + `add_view`。**`DIFF_OPS` は16のままである。**
   */
  sum_field?: ResourceId;
  /**
   * この画面の詰まり具合(`P-G32` の (C) 側。`V4-M19-T03` / `ADR-0118` 限定1・限定3・限定4)。
   * 詳細は {@link ListView} の `preset_density`。
   *
   * **3種すべてに書ける**(`CHANGE_KEYS_BY_VIEW_TYPE` の3つとも本キーを持ち、マニフェスト側の
   * `allOf` もどの分岐でも `false` にしていない)。
   *
   * **`update_view` で後から書けて、値が実際に運ばれる** —— `applyViewChanges` の
   * `list_view` / form / `detail_view` の3分岐が運ぶ。**`enum` に無い値は拒否される。**
   *
   * **前進では外せない** —— 外すには undo で戻すか `remove_view` + `add_view`。
   * **`DIFF_OPS` は16のままである。**
   */
  preset_density?: "comfortable" | "compact";
  /**
   * 保存が成立したあとに行く画面のID(`E-G34`。`V4-M20-T04` / `ADR-0102` 限定1〜限定3・限定8)。
   * 詳細は {@link FormView} の `after_save`。
   *
   * **`form` でだけ書ける**(`CHANGE_KEYS_BY_VIEW_TYPE` が種別で絞り、マニフェスト側の
   * `allOf` の `list_view` / `detail_view` 分岐も `false` で閉じている)。
   *
   * **`update_view` で後から書けて、値が実際に運ばれる** —— `applyViewChanges` の
   * `form` 分岐が運ぶ。**実在しないビューIDへ差し替えると、畳み込み後のマニフェスト検証が
   * 差分全体を拒否する**(**`add_view` と同じ1箇所で判定する**)。
   *
   * **前進では外せない** —— 外すには別のビューIDに差し替えるか undo で戻すか
   * `remove_view` + `add_view`。**`DIFF_OPS` は16のままである。**
   */
  after_save?: ResourceId;
  /**
   * **削除が成立したあとの行き先を、後から差し替える**(`NV-G4`。`V10-M1-T02` /
   * `ADR-0359` §4a 限定2・限定4・限定10)。
   *
   * **`view_changes` の26キー目である** —— **`ADR-0359` §Decision 2 が
   * 「`view_changes` にも足す」を先に決めたので、限定10 の「実装時に1つに決めて記録する」は
   * そこで消費されている。**
   *
   * **`detail_view` でだけ書ける**(`CHANGE_KEYS_BY_VIEW_TYPE` が種別で絞り、
   * マニフェスト側の `allOf` の `list_view` / `form` / `report_view` の3分岐も
   * `false` で閉じている)。
   *
   * **`update_view` で後から書けて、値が実際に運ばれる** —— `applyViewChanges` の
   * `detail_view` 分岐が運ぶ。**行き先の型(`list_view` / `report_view` だけ)と
   * 実在は、畳み込み後のマニフェスト検証が差分全体を拒否する**(**`add_view` と
   * 同じ1箇所で判定する**)。
   *
   * **前進では外せない** —— 外すには別のビューIDに差し替えるか undo で戻すか
   * `remove_view` + `add_view`。**`DIFF_OPS` は17のままである**
   * (**上の `after_save` の JSDoc が書いた「16」は `ADR-0102` 制定時の値であり、
   * 今日の値ではない。合わせずに両方書く** —— `ADR-0359` §4a 限定11 と同じ作法)。
   */
  after_delete?: ResourceId;
  /**
   * **一続きの流れの中の段を、後から差し替える**(`NV-G9`。`V10-M4-T01` /
   * `ADR-0359` §4b 限定1・限定3 / §Decision 2 / `ADR-0360` 限定2)。
   *
   * **`view_changes` の27キー目である** —— **`after_delete`(26キー目)の `$comment` が
   * 「27キー目は `flow` であり、その実装は `V10-M4` の担当である」と名指しで予告していた。**
   * **置き換えとなる新しい不変条件は「28キー目を足してはならない」であり、その線は
   * `after_delete` が置いたものをそのまま引き継ぐ。**
   *
   * **型は `ListView` / `FormView` / `DetailView` の `flow` と同じである** ——
   * **新しい型を1つも作っていない**(`ViewFlowStep` は export していない)。
   *
   * **書けるのは `list_view` / `form` / `detail_view` だけである**
   * (`CHANGE_KEYS_BY_VIEW_TYPE` が種別で絞り、マニフェスト側の `allOf` の
   * `report_view` 分岐も `false` で閉じている)。
   *
   * **`update_view` で後から書けて、値が実際に運ばれる** —— `applyViewChanges` の
   * 3種別の分岐が運ぶ。**確認の段を置ける種別と、位置の重複・欠番は、ここでは
   * 1つも判定しない** —— **前者はスキーマの `allOf` が、後者は畳み込み後の
   * マニフェスト検証が差分全体を拒否する**(**`add_view` と同じ1箇所で判定する**)。
   *
   * **前進では外せない** —— 外すには別の値に差し替えるか undo で戻すか
   * `remove_view` + `add_view`。**`DIFF_OPS` は17のままである。**
   */
  flow?: NonNullable<ViewFlowStep["flow"]>;
  /**
   * **操作起点を後から差し替える**(`L-G4`。`V5-M21-T03` / `ADR-0172` 限定1〜限定8)。
   *
   * **`view_changes` の23キー目である。** **型は `ListView` / `DetailView` の
   * `actions` の和である** —— **新しい型を1つも作っていない。**
   *
   * **全置換だけである**(限定2)—— **書いた配列がそのまま新しい `actions` になる。**
   * **1件だけ足す / 消す手段は語彙に1つも無い。**
   * **空配列 `[]` が「操作起点を全部消す」の意味である**(限定3)——
   * **これは他の22キーに無い性質である**(他のキーは前進で外せない)。
   * **書けるのは `list_view` / `detail_view` だけである**(限定4。`form` には今日も
   * `actions` を書けない = `ADR-0171` 限定3)。
   * **`actions` を書かない `update_view` は既存の `actions` を1バイトも触らない**(限定6)。
   * **`related` / `audience` は今日も `view_changes` に無い**(限定1)。
   * **【2026-08-10 追記(`V8-M20`。台帳 `J-G27`)】** **`audience` は `view_changes` どころか
   * どこにも無い** —— **`V8-M20` がキーごと廃止した。****`related` は今日も在る。**
   *
   * **【`V5-M22-T01` / `L-G5` / `ADR-0173` で和が1形増えた】** **着手前この型は
   * `NonNullable<DetailView["actions"]>` だけを指しており、**それが「`ListView` /
   * `DetailView` の和」と一致していた**(`ListView` 側が `DetailView` 側の部分集合
   * だったためである)。**今日は一致しない** —— **`ListView` にだけ3形目(行き先の
   * 宣言)が在る。** **したがって和を明示的に書く。**
   * **`update_view` の schema 側は `$defs/view/properties/actions` を `$ref` して
   * おり、`$defs/view.allOf` の分岐は通らない** —— **`detail_view` に3形目を書いた
   * `update_view` は、畳み込んだ後のマニフェスト検証(`validateManifestFull`)が
   * 拒否する。****判定を2箇所に住まわせない**(`ADR-0172` の `$comment` が既に
   * 「実在しない `form` / 参照先の合わない `prefill.field` / `list_view` への `set` 形は
   * 畳み込み後のマニフェスト検証が差分全体を拒否する」と書いたのと同じ経路である)。
   */
  actions?: (
    | NonNullable<DetailView["actions"]>[number]
    | NonNullable<ListView["actions"]>[number]
  )[];
  /**
   * **入力画面ごとの、参照項目の「選び方」の上書きを後から差し替える**
   * (`K-G3`。`V6-M2-T02` / `ADR-0289` 限定1・限定4・限定8)。
   * 詳細は {@link FormView} の `reference_pickers`。
   *
   * **`view_changes` の24キー目である。**
   *
   * **`form` でだけ書ける**(限定4。`CHANGE_KEYS_BY_VIEW_TYPE` が種別で絞り、
   * マニフェスト側の `allOf` の `list_view` / `detail_view` 分岐も `false` で
   * 閉じている)—— **`list_view` / `detail_view` を対象にした `update_view` は
   * キー単位で拒否される。**
   *
   * **`update_view` で後から書けて、値が実際に運ばれる** —— `applyViewChanges` の
   * `form` 分岐が運ぶ。**受付表に足すだけでは値が運ばれない**(両方要る)。
   * **`ADR-0076` の `writable_by` / `ADR-0080` の `representative_field` が作った
   * 「キーは在るが効かない」穴を、新しいキーで踏み直さない。**
   *
   * **全置換である** —— **書いたオブジェクトがそのまま新しい値になる。**
   * **項目ごとに1本だけ足す / 消す手段は語彙に1つも無い。**
   * **空オブジェクトは書けない**(値域が `additionalProperties` だけなので `{}` も
   * 形としては通るが、**「全部消す」という意味を与えていない** —— `actions` の
   * `[]` に当たる性質は本キーに無い)。
   *
   * **前進では外せない**(限定8)—— 外すには undo で戻すか `remove_view` + `add_view`。
   * **`DIFF_OPS` は17のままである。**
   */
  reference_pickers?: Record<ResourceId, "list" | "type_filter" | "search">;
  /**
   * **集計表の中身**(`V8-M8`。台帳 `Q-G1`)。詳細は {@link ReportView} の `report`。
   *
   * **`view_changes` の25キー目である。**
   *
   * **`report_view` でだけ書ける**(`CHANGE_KEYS_BY_VIEW_TYPE` が種別で絞り、
   * マニフェスト側の `allOf` の `list_view` / `form` / `detail_view` の3分岐も
   * `false` で閉じている)—— **他の3種を対象にした `update_view` はキー単位で拒否される。**
   *
   * **`update_view` で後から書けて、値が実際に運ばれる** —— `applyViewChanges` の
   * `report_view` 分岐が運ぶ。**受付表に足すだけでは値が運ばれない**(両方要る)。
   * **`ADR-0076` の `writable_by` / `ADR-0080` の `representative_field` が作った
   * 「キーは在るが効かない」穴を、新しいキーで踏み直さない。**
   *
   * **全置換である** —— **書いたオブジェクトがそのまま新しい宣言になる。**
   * **束ねるキーを1本だけ足す / 消す手段は語彙に1つも無い。**
   * **空オブジェクトは書けない**(`$defs/report` の `required` が形の側で拒否する)。
   *
   * **前進では外せない** —— 外すには undo で戻すか `remove_view` + `add_view`。
   * **`DIFF_OPS` は18のままである。**
   */
  report?: ReportDeclaration;
};

/**
 * `change_table` で変更できる範囲(1つ以上指定する)。ADR-0010 限定2 によりキーは固定。
 *
 * `id` の変更(rename)は、**マニフェスト内の参照を自動で追随させる**(§5d)――
 * ビューの `table` と、他テーブルの `reference` フィールドの `reference_table`。
 * 追随は「カーネルが推論している」のではなく **rename の意味論そのもの**である。
 */
export type TableChanges = {
  id?: ResourceId;
  name?: string;
  /**
   * このテーブルが参照されたときの「探せる項目」の既定(`K-G6`。`V6-M3-T01` /
   * `ADR-0290` 限定11)。詳細は {@link Table} の同名キー。
   *
   * **`change_table` で後から書けて、値が実際に運ばれる** —— `foldChangeTable`
   * (`apply-diff.ts`)が運ぶ。**`representative_field` は同じ `table_changes` に
   * 在りながら値が運ばれない**(受理はされるが適用後マニフェストに残らない)——
   * **その穴を新しいキーで踏み直していない。**
   *
   * **全置換である** —— 書いた配列がそのまま新しい値になり、1本ずつ足す / 消す
   * 手段は1つも無い。**前進では外せない。**
   *
   * **`representative_field` はこの型に現れない**(`ADR-0080` 限定6 の帰結で、
   * カーネルは値を運ばないため型にも無い)。**この非対称は隠さない。**
   */
  reference_search_fields?: ResourceId[];
  /**
   * **すでに使っている表に、あとからアクセス権管理を有効にする**(`Z-G37`。
   * `V7-M1-T03`)。詳細は {@link Table} の同名キー。
   *
   * **`change_table` で後から書けて、値が実際に運ばれる** —— `foldChangeTable`
   * (`apply-diff.ts`)が運ぶ。**`representative_field` は同じ `table_changes` に
   * 在りながら値が運ばれない** —— **その穴を新しいキーで踏み直していない。**
   *
   * **全置換である** —— **書いたオブジェクトがそのまま新しい宣言になり、中の1本だけを
   * 足す / 消す手段は1つも無い。****書かない `change_table` は既存の宣言を1バイトも
   * 触らない。****前進では外せない**(止めるだけなら `enabled: false`)。
   *
   * **値域は `Table` の同名キーをそのまま参照する**(型エイリアスを新設せず、
   * schema 側でも `$ref`1本で受けて値域の定義を二重に持たない)。
   */
  access_control?: Table["access_control"];
};

/**
 * `change_field` で変更できる範囲(1つ以上指定する)。ADR-0010 限定2 によりキーは固定。
 *
 * **危険度が op 名から読めない**ことは ADR-0010 §2(f) が不利な材料として申告している ――
 * `{ name }` は表示名の訂正、`{ type }` は全行の値の書き換えである。`_changelog` には
 * `change_field` としか残らず、何が起きたかは `changes` を読まないと分からない
 * (AI は `get_changelog` で読めるが、人間は画面から読めない。§6d)。
 */
export type FieldChanges = {
  id?: ResourceId;
  name?: string;
  type?: FieldType;
  required?: boolean;
  options?: string[];
  reference_table?: ResourceId;
  /**
   * 一意制約(EC-G8 / ADR-0038)。**`false → true` にする後付けは、既存行に重複値が
   * あれば差分全体を拒否する**(部分適用しない = ADR-0010 限定7 / 変換不能値と同型。
   * `apply-diff.ts` の pre-snapshot 検査が既存重複を読む)。既存重複を黙って1件に潰さない。
   *
   * **【V4-M10-T07 / ADR-0078】** **値域に `"owner"`(同じ持ち主の中だけで一意)が入った。**
   * **後付けの既存重複検査もスコープごとに行う** —— 持ち主が違う同値は「重複」ではない。
   */
  unique?: boolean | "owner";
  /**
   * この値が何の単位か(`E-G14` / `V4-M10-T46` / `ADR-0086` 限定8)。詳細は {@link Field}。
   *
   * **`change_field` で後から書けて、値が実際に運ばれる** —— `buildChangedField`
   * (`apply-diff.ts`)が `unique` と同じ形で運ぶ。**`writable_by`(`diff.schema.json` に
   * キーは在るがカーネルが運ばない)の穴を、新しいキーで踏み直していない。**
   *
   * **`number` 以外の型に書いた差分は、適用時の検査が拒否する**(限定4)——
   * **「書けるが効かない組み合わせ」を1つも作らない。**
   */
  unit?: string;
  /**
   * 値ごとの強調の宣言(`P-G28` + `P-G22` の (C) 側。`V4-M16-T10` / `ADR-0090` 限定4)。
   * 詳細は {@link Field} の `select` バリアント。
   *
   * **`change_field` で後から書けて、値が実際に運ばれる** —— `buildChangedField`
   * (`apply-diff.ts`)が `unit` と同じ形で運ぶ。**`writable_by`(`diff.schema.json` に
   * キーは在るがカーネルが運ばない)の穴を、新しいキーで踏み直していない。**
   *
   * **`select` 以外の型に書いた差分は、適用時の検査が拒否する**(限定4)——
   * **「書けるが効かない組み合わせ」を1つも作らない。**
   */
  emphasis?: Record<string, "neutral" | "info" | "caution" | "danger">;
  /**
   * 値が無いとき、この項目の行ごと画面から出すか(`E-G17` / `D-V4-84` の一部。
   * `V4-M19-T07` / `ADR-0119` 限定1・限定2・限定11)。詳細は {@link Field} の
   * `hide_when_empty`。
   *
   * **`field_changes` の11キー目である。** **9型すべてに書ける**ので、`unit` /
   * `emphasis` と違い**型を変える差分でも落ちない**(落とすと「書いたのに黙って消える」
   * になる)。
   *
   * **`change_field` で後から書けて、値が実際に運ばれる** —— `buildChangedField`
   * (`apply-diff.ts`)が運ぶ。**`ADR-0076` の `writable_by` が作った「キーは在るが
   * 効かない」穴を新しいキーで踏み直さない。**
   *
   * **前進で `false` に戻せる**(限定11。実測済み)。**`DIFF_OPS` は16のままである。**
   */
  hide_when_empty?: boolean;
  /**
   * 参照項目の選び方(`K-G4`。`V6-M1-T02` / `ADR-0288` 限定10)。詳細は {@link Field} の
   * `reference` バリアントの `reference_picker`。
   *
   * **`field_changes` の12個目のキーである。**
   *
   * **`change_field` で後から書けて、値が実際に運ばれる** —— `buildChangedField`
   * (`apply-diff.ts`)が `unit` と同じ形で運ぶ。**`writable_by`(`diff.schema.json` に
   * キーは在るがカーネルが運ばない)の穴を、新しいキーで踏み直していない。**
   *
   * **`reference` 以外の型に書いた差分は、適用時の検査が拒否する**(限定4)——
   * **「書けるが効かない組み合わせ」を型の側では1つも作らない。**
   */
  reference_picker?: "list" | "type_filter" | "search";
  /**
   * 参照候補の「探せる項目」の、項目ごとの上書き(`K-G7`。`V6-M3-T02` /
   * `ADR-0290` 限定11)。詳細は {@link Field} の `reference` バリアントの同名キー。
   *
   * **`field_changes` の13個目のキーである。**
   *
   * **`change_field` で後から書けて、値が実際に運ばれる** —— `buildChangedField`
   * (`apply-diff.ts`)が `reference_picker` と同じ形で運ぶ。
   *
   * **`reference` 以外の型に書いた差分は、適用時の検査が拒否する** ——
   * **「書けるが効かない組み合わせ」を型の側では1つも作らない。**
   */
  reference_search_fields?: ResourceId[];
};

export type AddTableOperation = { op: "add_table"; table: Table };
export type AddFieldOperation = { op: "add_field"; table: ResourceId; field: Field };
export type AddViewOperation = { op: "add_view"; view: View };
export type UpdateViewOperation = { op: "update_view"; view: ResourceId; changes: ViewChanges };

/**
 * 破壊的 op 4種(ADR-0010 §1)。
 *
 * **`field` キーの意味が `add_field` と違う** —— あちらはフィールド定義そのもの、
 * こちらはフィールドIDの文字列である。`table` キーが `add_table` と `add_field` で
 * 既に持っている非対称を1つ増やしたものであり、ADR-0010 §1 が代償として申告している。
 */
export type RemoveFieldOperation = { op: "remove_field"; table: ResourceId; field: ResourceId };
export type RemoveTableOperation = { op: "remove_table"; table: ResourceId };
export type ChangeTableOperation = {
  op: "change_table";
  table: ResourceId;
  changes: TableChanges;
};
export type ChangeFieldOperation = {
  op: "change_field";
  table: ResourceId;
  field: ResourceId;
  changes: FieldChanges;
};

/**
 * ビューを1つ取り除く(ADR-0012)。**データを1バイトも失わない op である。**
 *
 * 形は `{ op, view }` の2キーのみで、**`changes` を取らない**(ADR-0012 限定3)。
 * `view` の意味は `update_view` と同じくビューIDの文字列であり、`add_view`
 * (画面定義そのもの)とは違う —— 既存の非対称をそのまま使っており、
 * `$defs/operation.properties` にキーは1つも増えていない(限定2)。
 *
 * **カスケードしない**(限定4)。この op は他の何も消さないし、逆に `remove_table`
 * がビューを自動で消すこともない(ADR-0010 §7a を維持)。ビューが載ったテーブルを
 * 消したいときは、同じ差分の中で `remove_view` を先に並べる。
 */
export type RemoveViewOperation = { op: "remove_view"; view: ResourceId };

/**
 * ワークフロー3種(ADR-0013 §4c)。**ADR-0010 限定3 を破って足した6キー目
 * `workflow` を使う唯一の op 群である。**
 *
 * **`workflow` キーの意味は2義に閉じる** —— `add_workflow` / `update_workflow` では
 * ワークフロー定義そのもの、`remove_workflow` では対象のワークフローID(`{ id }`)。
 * **3義目を入れてはならない**(それは ADR-0013 却下案2 と同じことをすることになる)。
 * **7キー目を `$defs/operation.properties` に足してはならない**(ADR-0013 限定3)。
 */
export type AddWorkflowOperation = { op: "add_workflow"; workflow: Workflow };
export type UpdateWorkflowOperation = { op: "update_workflow"; workflow: Workflow };
export type RemoveWorkflowOperation = { op: "remove_workflow"; workflow: { id: ResourceId } };

/**
 * 関数3種(ADR-0024 §4c)。**ADR-0013 限定3(operation は6キーで閉じる)を破って足した
 * 7キー目 `function` を使う唯一の op 群である。**
 *
 * **`function` キーの意味は2義に閉じる**(`workflow` キーと同型)—— `add_function` /
 * `update_function` では関数定義そのもの、`remove_function` では対象の関数ID(`{ id }`)。
 * **3義目を入れてはならない。8キー目を `$defs/operation.properties` に足してはならない**
 * (ADR-0024 §4c)。
 */
export type AddFunctionOperation = { op: "add_function"; function: FunctionDef };
export type UpdateFunctionOperation = { op: "update_function"; function: FunctionDef };
export type RemoveFunctionOperation = { op: "remove_function"; function: { id: ResourceId } };

/**
 * テーマの全体差し替え(ADR-0047 §4c)。**ADR-0024 限定(operation は7キーで閉じる)を
 * 破って足した8キー目 `theme` を使う唯一の op である。**
 *
 * **`theme` キーの意味は1義である**(`workflow` / `function` が2義に閉じているのと違い、
 * テーマは対象IDを取らない —— app に1つしか無いので指す必要が無い)。**2義目を
 * 入れてはならない。9キー目を `$defs/operation.properties` に足してはならない**
 * (ADR-0047 §4c 問3 / 限定11)。
 *
 * **全体差し替えである**(`changes` を取らない)—— 部分更新の op が無いので、テーマの
 * 変更は常に全スロットの書き直しである(ADR-0047 限定3 / 2026-07-25 追記(2))。
 * テーマを持たないアプリに対しても使える(初回適用で `app.theme` が生える)。
 */
export type SetThemeOperation = { op: "set_theme"; theme: Theme };

/**
 * **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11`。判定値 = 廃止】**
 * **ここに在った `SetUserKindsOperation` を取り除いた。**
 * **代わりに立つのは下の `SetRolesOperation` である** —— **どちらも「app に1つしか無い
 * 宣言を丸ごと差し替える」同型であり、対象IDを取らない。**
 * **`Operation` の union からも `SetUserKindsOperation` を外した** ——
 * **これにより `src/kernel/requirements-doc.ts` の網羅性の番人(`switch` の返り値型)が
 * loud に働き、`case` を残したままだと `tsc --noEmit` が落ちる。**
 */

/**
 * 役割の宣言の全体差し替え(`V8-M16-T03`。台帳 `J-G1b` / ユーザ決定 `D-V8-31`)。
 * **`ADR-0248` 限定4(`operation` は9キーで閉じる)を破って足した10キー目 `roles` を
 * 使う唯一の op である。**
 *
 * **`roles` キーの意味は1義である**(`theme` / `user_kinds` と同型 —— 役割の一覧は
 * app に1つしか無いので対象IDを取らない)。**2義目を入れてはならない。11キー目を
 * `$defs/operation.properties` に足してはならない。**
 *
 * **全体差し替えである**(`changes` を取らない)—— 部分更新の op が無いので、役割を
 * 1つ足すときも全件を書き直す。**宣言を持たないアプリに対しても使える**(初回適用で
 * `app.roles` が生える)。**逆に「宣言が無い状態」へ戻す手段は無い**(空配列は
 * スキーマの `minItems: 1` が拒否する)。
 */
export type SetRolesOperation = { op: "set_roles"; roles: RoleDeclaration[] };

export type Operation =
  | AddTableOperation
  | AddFieldOperation
  | AddViewOperation
  | UpdateViewOperation
  | RemoveFieldOperation
  | RemoveTableOperation
  | ChangeTableOperation
  | ChangeFieldOperation
  | RemoveViewOperation
  | AddWorkflowOperation
  | UpdateWorkflowOperation
  | RemoveWorkflowOperation
  | AddFunctionOperation
  | UpdateFunctionOperation
  | RemoveFunctionOperation
  | SetThemeOperation
  | SetRolesOperation;

/** 差分パッチ。intent(なぜこの変更をするのか)は必須。 */
export type Diff = {
  diff_id: ResourceId;
  intent: string;
  operations: Operation[];
};
