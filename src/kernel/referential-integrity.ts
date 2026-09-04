import { isSystemTableId, SYSTEM_TABLES } from "../shared/system-tables.ts";
import { convertValue } from "./convert.ts";
// **`D-V8-126`(`V8-M9`)。** **すべての表が持つシステム列の綴りを、ここで宣言し直さない**
// —— **出所は `src/kernel/ddl.ts` の `SYSTEM_COLUMNS` / `SYSTEM_COLUMN_NAMES` の1本だけである。**
// **2箇所が別々に持つと、列が増えた日に片方だけが古くなる。** **カーネル内の import であり、
// 層またぎ(`scripts/kernel-import-snapshot.txt`)は1件も増えていない**(`MAX_FILTER_DEPTH`
// を `records.ts` から取っているのと同型)。
import { SYSTEM_COLUMN_NAMES, SYSTEM_COLUMNS } from "./ddl.ts";
import { invalid, type ValidationError, type ValidationResult, valid } from "./errors.ts";
// **`V8-M18` / 台帳 `J-G14` の限定の逐語「`src/kernel/records.ts:1055` の `MAX_FILTER_DEPTH`
// を共有」の履行である。** **同じ値をここで宣言し直さない** —— **2箇所が別々に持つと、
// 片方だけ直されて絞り込みと権限の条件で上限が食い違う。** **カーネル内の import であり、
// 層またぎ(`scripts/kernel-import-snapshot.txt`)は1件も増えていない。**
import { MAX_FILTER_DEPTH } from "./records.ts";
import type {
  Field,
  FieldType,
  FunctionInput,
  Manifest,
  ResourceId,
  RoleCondition,
  Table,
  Workflow,
} from "./types.ts";
import { DEFAULT_ROLE_IDS, filterFieldRefs, normalizeSort, sortErrorPath } from "./types.ts";

/**
 * **持ち主(`owner`)の `rules` から抜けてはならない対象**(`V8-M28`。台帳 `T-G16a`。
 * ユーザ決定 `D-V8-59`)。
 *
 * **どちらも動詞は `write` 1語ちょうどである**(語彙側の `allOf` がそう閉じている)。
 * **既定として最初から入れるのは `src/kernel/create-app.ts` の `OWNER_DEFAULT_RULES`
 * であり、そちらは自分の綴りを持つ** —— **【正直に書く】同じ2語が2箇所に在る。**
 * **片方だけを変えると黙ってずれる。ずれないことを固定しているのは検査だけである。**
 * **【禁止】この定数を「値域」と読まない** —— **値域の正は
 * `schemas/manifest.schema.json` の `target` の `enum`(6語)である。**
 */
const OWNER_REQUIRED_RULE_TARGETS = ["app", "role"] as const;

/**
 * 参照整合性バリデーション(V0-P1-T02)。
 *
 * JSON Schema では表現できない「IDが実在するか」「IDが重複していないか」を検証する。
 * 構造(型・必須・語彙)は `validateManifest` の担当で、ここでは構造が正しいことを前提にする。
 *
 * 設計方針(LLMが1往復で自己修正できること):
 * - 最初の1件で打ち切らず、壊れている箇所を**全件**返す
 * - path は該当箇所を正確に指す RFC 6901 JSON Pointer
 * - 存在しないIDを指すエラーには必ず `allowed_values` に実在するID一覧を入れる
 * - 参照先テーブルが存在しないビューでは、その配下(columns/fields/sort/filter)の検証を
 *   スキップして二重エラーをカスケードさせない
 *
 * ID比較は文字列一致。正規化しないので `my-field` と `my_field` は別IDである。
 *
 * ## 検査しないもの: テーマの由来(`app.theme.origin`。ADR-0047 限定7 / V3-M1-T03)
 *
 * **`origin.template_app_id` が実在するアプリを指しているかを、この検査は見ない。見てはならない。**
 * カーネルは由来の真偽を検証しない —— テンプレート app の実在も版の一致も、`apply_diff` の
 * 呼び出し側(AI)の**自己申告である**(憲法6。ADR-0047 §1b / §2 (f))。
 *
 * **理由は undo の正しさである。** この検査は `purpose` に関係なく呼ばれるので、
 * `stored` 読み取り(`readCurrentManifest` / `readSnapshotManifest`)にも掛かる。由来を
 * 検査対象にすると、**テンプレート app を削除した日に、それを写した既存アプリの
 * マニフェストが読めなくなり、過去の undo が壊れる**(`src/kernel/validate.ts:74`〜`:77` が
 * 警告した形と同型)。**孤児は検出のみ・自動刈り取りなし**(ADR-0035 §4 と同型)。
 *
 * **テーマは他に参照を1つも持たない** —— スロットの値は色・長さ・書体の文字列だけで、
 * テーブルID・フィールドID・ビューIDを1つも含まない(だから「テーマが指す先が消えた」
 * という状態が `origin` 以外には存在しない)。
 * **機械的固定は `referential-integrity.test.ts` の「実在しないアプリを指す origin でも
 * valid である」である**(限定7 の第4列)。
 */

/** 参照整合性のみを検証する。構造は検証しない(`validateManifestFull` を参照)。 */
/**
 * **【`V8-M20`】「見せる相手 / 書ける相手」の値域の固定部分は撤去した。**
 *
 * **ここに在ったもの**: `RESERVED_ROLE_IDS` / `ANONYMOUS_AUDIENCE_VALUE` /
 * `DEFAULT_USER_KIND_ID` / `declaredUserKindIdsOf()`。**4つとも、下の類型13
 * (`view.audience` / `view_action.audience` / `field.audience` / `field.writable_by` の
 * 値域検査)だけが使っていた。** **その4層が `V8-M20` で廃止され(台帳 `J-G27` / `J-G28` /
 * `J-G29`。手続きは `ADR-0301`)、参照が0本になったので落とした。**
 *
 * **【この写しが果たしていた役割を隠さない】** **旧 doc の逐語**: 「**`src/auth/types.ts` と
 * `src/server/owner-scope.ts` に同じ綴りが在る。カーネルは `src/auth/` も `src/server/` も
 * import できない(`ADR-0009` の層分離)ので、ここは写しである。写しであることを隠さない。**」
 * **その3箇所の写しが一致することを `scripts/audience-role-sync.test.ts` が機械で固定していた。**
 * **今日、写しの側(`src/server/owner-scope.ts` の `AUDIENCE_ROLES`)も無い。**
 */

/**
 * 役割の規則の条件(`when`)を、根から1ノードずつ辿る(`V8-M18`。台帳 `J-G14` / `J-G15`)。
 *
 * **深さの数え方は `src/kernel/records.ts` の `compileNode` と同一である** —— **根が 0 段で、
 * `and` / `or` の要素と `not` の中身が1段深くなる。** **上限の値そのものは
 * `MAX_FILTER_DEPTH` を import して共有する**(ここで宣言し直さない。`J-G14` の限定)。
 *
 * `visit` が `false` を返したら、そのノードより下へは降りない(深すぎる枝で同じエラーを
 * 何十件も積まないため)。**公開 export ではない** —— **`V8-M17` と同じく、この作業は
 * カーネルの公開 export に関数を1本も足さない。**
 */
function walkRoleCondition(
  node: RoleCondition,
  path: string,
  depth: number,
  visit: (node: RoleCondition, path: string, depth: number) => boolean,
): void {
  if (!visit(node, path, depth)) return;
  if ("and" in node) {
    node.and.forEach((child, index) => {
      walkRoleCondition(child, `${path}/and/${index}`, depth + 1, visit);
    });
    return;
  }
  if ("or" in node) {
    node.or.forEach((child, index) => {
      walkRoleCondition(child, `${path}/or/${index}`, depth + 1, visit);
    });
    return;
  }
  if ("not" in node) {
    walkRoleCondition(node.not, `${path}/not`, depth + 1, visit);
  }
}

export function validateReferentialIntegrity(manifest: Manifest): ValidationResult {
  const errors: ValidationError[] = [];
  // `workflows` は任意である(ADR-0013 §1: スキーマの `required` に入っていないので、
  // 既存マニフェストは軒並みこのキーを持たない)。省略は「1つも無い」と同じ意味。
  const { tables, views } = manifest.app;
  const workflows = manifest.app.workflows ?? [];
  // 関数(コードの島)も任意である(ADR-0024。workflows と同じく required に入れない)。
  const functions = manifest.app.functions ?? [];

  /*
   * --- 役割の規則が名指しした項目(`V8-M20-T02`。台帳 `J-G28`。手続きは `ADR-0301`)-----
   *
   * **【`V8-M20` の置き直し】着手前、下の3つの検査(探す対象 / 検索の対象 / 合計の列)は
   * 「項目が `audience` を宣言しているか」を見ていた。****そのキーは `V8-M20` が廃止した
   * ので、今日は1つも存在しない。** **問いは残る** —— **項目の見え方が要求者によって
   * 変わるなら、絞り込み・検索・合計はその差を1つの数へ潰してしまう。**
   * **同じ問いを、代わりに立った面(`app.roles[].rules`)について問い直したのが本述語である。**
   *
   * **見るのは「名指しされているか」だけである** —— **誰に許すか(`can`)も条件(`when`)も
   * 1バイトも見ない。** **規則が1本でもその項目を名指しすれば、その項目は allow-list の側へ
   * 入り、役割によって読めたり読めなかったりする**(規則を1本も書いていない対象は管轄外
   * = 全許可なので、名指しが無ければ差は生まれない)。
   *
   * **`src/server/owner-scope.ts` の `judgeRoleAccess` を import しない** —— **カーネルは
   * サーバ層に依存しない**(`ADR-0009` の層分離。`scripts/kernel-import-snapshot.txt` が
   * 0 件で固定している)。**`app.roles` はマニフェストの一部なので、ここから素直に歩ける**
   * ——**層またぎにならない。****判定の正はサーバ層にあり、ここに在るのは「名指しの有無」
   * だけの小さな述語である**(判定の複写ではない)。
   *
   * **【正直に書く】旧層の既知の穴を1件も塞いでいない** —— **`view.filter` には今日も
   * 名指しされた項目を書ける**(`docs/plan/v4/records/v4-fix1-boundary-bypass.md` §2 (d) の
   * 5件は、宣言の置き場が変わっただけで今日も塞がっていない)。
   * **止めているのは「新しい口が同じ穴を広げること」だけである。**
   */
  const namedByRoleRules = (tableId: string, fieldId: string): boolean =>
    (manifest.app.roles ?? []).some((role) =>
      (role.rules ?? []).some(
        (rule) => rule.target === "field" && rule.table === tableId && rule.field === fieldId,
      ),
    );

  // --- 類型5(前半): テーブルID・フィールドIDの重複 -------------------------
  collectDuplicates(
    tables.map((table) => table.id),
    (index, id) => {
      errors.push({
        path: `/app/tables/${index}/id`,
        message: `テーブルID "${id}" が重複しています。テーブルIDはアプリ内で一意である必要があります。`,
        hint: "どちらかのテーブルに別のIDを付けてください。",
      });
    },
  );

  /*
   * テーブルの集合を**2組**持つ(ADR-0006 §9)。
   *
   * 素直にシステムテーブルを1つのマップへ混ぜると、副作用としてユーザテーブルが
   * `reference_table: "_apps"` を持てるようになる。そうなると `records.ts` の
   * reference 値検証が**存在しない物理テーブルを SELECT して SQLite 例外**になる ――
   * 統一形式エラーですらない壊れ方である。
   *
   * マップだけを分けても足りない。`allowed_values` の元も分けなければ、
   *
   * - 参照用の候補にシステムテーブルが漏れる → **エラーメッセージが裏口を宣伝し、
   *   その裏口は閉まっている**(AI が自己修正のループから抜けられない)
   * - ビュー用の候補から隠れる → `view.table` にタイポした AI は `_apps` が選べることを
   *   候補一覧から知れない(発見可能性をエラーメッセージ側から潰す)
   *
   * のどちらかが必ず残る。**マップと候補は必ず同じ集合から作る。**
   *
   * allowed_values は「選べるIDの一覧」としてLLMに提示するものなので重複は畳む
   * (重複そのものは上で別途エラーとして報告されている)。
   */

  // 参照用(類型3: reference_table)。マニフェスト宣言テーブルのみ。
  const referenceableIds = unique(tables.map((table) => table.id));
  // 最初に出現したものを正とする。
  const referenceableById = new Map<ResourceId, Table>();
  for (const table of tables) {
    if (!referenceableById.has(table.id)) {
      referenceableById.set(table.id, table);
    }
  }

  /*
   * --- 類型2d: 参照候補の「探せる項目」(`K-G6` / `K-G7` / `K-G8`。
   *     `V6-M3-T03` / `ADR-0290` 限定4・限定5・限定6)-------------------------------
   *
   * **3つを1箇所で判定する** —— (1) 選ぶ相手のテーブルに実在するか / (2) 型が `text` か
   * `long_text` か / (3) 役割の規則(`app.roles[].rules`)が `target: "field"` でその項目を
   * 名指ししていないか。
   *
   * **【`V8-M20-T02` による置き直し。旧文を残す】** **(3) の着手前の逐語は
   * 「`audience` を宣言していないか」だった。****そのキーは `V8-M20` が廃止したので、
   * 今日は1つも存在しない**(台帳 `J-G28`。手続きは `ADR-0301`)。**問いは同じものを、
   * 代わりに立った面について問い直してある**(述語は `namedByRoleRules`)。
   *
   * **これは `search_fields`(類型2c)とまったく同じ3つであり、同じ順序で判定する** ——
   * **入口は2つになるが、AI が覚える規則は1組に保つ**(`v6-m0.md` §5-2 の断り)。
   * **【禁止の履行】これを「入口を増やしていない」と書かない。増えている。**
   *
   * **置き場が2つある宣言を、1つの関数で覆う**:
   *
   * - **参照される側のテーブルの既定**(`$defs/table.reference_search_fields`)——
   *   照合先は**自テーブル**である。
   * - **参照する項目側の上書き**(`$defs/field.reference_search_fields`)——
   *   照合先は**`reference_table` が指すテーブル**である。
   *
   * **どちらも「選ぶ相手のテーブルの列」を指す。** **書いた場所によって別のテーブルを
   * 指すことは無い** —— **`v6-m0.md` §5-2 の 2 が `search_fields` の流用を退けた理由
   * (「同じキーが、書かれた場所によって別のテーブルの列を指す」)を、新しいキーで
   * 作り直さない。**
   *
   * **`add_table` / `change_table` / `add_field` / `change_field` の4経路が、畳み込み後の
   * マニフェストでここを通る**ので、**両経路が同じ判定に覆われる。**
   * **判定を2箇所に住まわせない**(`apply-diff.ts` 側は値を運ぶだけで、型しか見ない)。
   *
   * **拒否は「全か無か」である**(`ADR-0047` 限定9)—— 1本でも違反していれば差分全体が
   * 通らない。**エラーは列ごとに出す**(1往復で全部直せるように。`ADR-0003` §3)。
   *
   * **`representative_field` はここを1バイトも通らない** —— **あちらは今日も適用時検査を
   * 持たず、実在しない列や `text` でない列を指しても差分が拒否されない**
   * (`schemas/manifest.schema.json` の逐語「適用時検査は置いていない」)。
   * **本キーはその穴を引き継がない。** **【正直に書く】その穴を塞いでもいない** ——
   * **`representative_field` は今日も検査を1つも持たない。**
   *
   * **役割の規則はマニフェスト(`app.roles`)の一部なので、ここから素直に歩ける** ——
   * **`src/server/owner-scope.ts` の `judgeRoleAccess` を呼ばない**(カーネルはサーバに
   * 依存しない)。**類型2c と同じ読み方である。**
   *
   * **【正直に書く】既知の穴を1件も塞いでいない**
   * (`docs/plan/v4/records/v4-fix1-boundary-bypass.md` §2 (d) の5件は今日も5件である。
   * 宣言の置き場が `audience` から役割の規則へ移っただけで、穴の数は動いていない)。
   * **止めているのは「新しい口が同じ穴を広げること」だけである。**
   */
  const REFERENCE_SEARCHABLE_TYPES: readonly string[] = ["text", "long_text"];
  function validateReferenceSearchFields(
    target: Table | undefined,
    declared: readonly ResourceId[] | undefined,
    basePath: string,
    label: string,
  ): void {
    if (declared === undefined) {
      return;
    }
    if (target === undefined) {
      // 参照先テーブルが実在しないのは類型3 が既に報告済み。二重に出さない。
      return;
    }
    const searchable = target.fields.filter(
      (candidate) =>
        REFERENCE_SEARCHABLE_TYPES.includes(candidate.type) &&
        !namedByRoleRules(target.id, candidate.id),
    );
    declared.forEach((fieldId, index) => {
      const path = `${basePath}/${index}`;
      const field = target.fields.find((candidate) => candidate.id === fieldId);
      if (field === undefined) {
        errors.push({
          path,
          message: `${label}に指定されたフィールド "${fieldId}" はテーブル "${target.id}" に存在しません。`,
          allowed_values: searchable.map((candidate) => candidate.id),
          hint: `テーブル "${target.id}" に実在する text / long_text のフィールドIDを指定するか、先に add_field でフィールドを追加してください。`,
        });
        return;
      }
      if (namedByRoleRules(target.id, fieldId)) {
        errors.push({
          path,
          message: `${label}に指定されたフィールド "${fieldId}" は、役割の規則が名指ししている項目です。名指しされた項目は探す対象にできません。`,
          allowed_values: searchable.map((candidate) => candidate.id),
          hint: "役割の規則(app の roles)が名指ししていない text / long_text のフィールドを指定してください(絞り込みの当たり外れから、隠した項目の値が推測できてしまうためです)。",
        });
        return;
      }
      if (!REFERENCE_SEARCHABLE_TYPES.includes(field.type)) {
        errors.push({
          path,
          message: `${label}に指定されたフィールド "${fieldId}" は ${field.type} 型です。探す対象にできるのは text / long_text だけです。`,
          allowed_values: searchable.map((candidate) => candidate.id),
          hint: "text / long_text のフィールドを指定してください(照合は部分一致だけなので、他の型では意味が定まりません)。",
        });
      }
    });
  }

  // ビュー用(類型1: view.table)。宣言テーブル + システムテーブル。
  const viewTargetIds = [...referenceableIds, ...SYSTEM_TABLES.map((table) => table.id)];
  const viewTargetById = new Map<ResourceId, Table>(referenceableById);
  for (const table of SYSTEM_TABLES) {
    viewTargetById.set(table.id, table);
  }

  tables.forEach((table, tableIndex) => {
    collectDuplicates(
      table.fields.map((field) => field.id),
      (fieldIndex, id) => {
        errors.push({
          path: `/app/tables/${tableIndex}/fields/${fieldIndex}/id`,
          message: `フィールドID "${id}" がテーブル "${table.id}" 内で重複しています。フィールドIDは同一テーブル内で一意である必要があります。`,
          hint: "どちらかのフィールドに別のIDを付けてください。",
        });
      },
    );

    /*
     * --- 類型3b: 強調(emphasis)のキーが options に実在するか --------------
     *
     * **`P-G28` + `P-G22` / `V4-M16-T10` / `ADR-0090` 限定4 後段。**
     *
     * **スキーマはキーの「形」(空でない文字列)しか見ない**ので、`options` に無い値を
     * キーに書いても構造検証は通ってしまう。**通してしまうと「書けるが効かない宣言」に
     * なる**(`ADR-0090` 限定4 逐語「`options` に無い値をキーに書いても拒否する」)。
     *
     * **置き場をここにしたのは、`add_field` / `add_table` / `change_field` の全経路を
     * 1箇所で覆えるからである** —— 本関数は**適用後マニフェスト**を見る
     * (`apply-diff.ts` の `applyDiff` が `foldOperations` の後で通す)。
     *
     * **どの値が本当に注意を要するかは1度も検証しない**(`ADR-0090` §Context 4 の 4)。
     * **見るのは「そのキーが `options` に在るか」だけである。**
     */
    table.fields.forEach((field, fieldIndex) => {
      if (field.type !== "select" || field.emphasis === undefined) {
        return;
      }
      const allowed = unique(field.options);
      for (const value of Object.keys(field.emphasis)) {
        if (allowed.includes(value)) {
          continue;
        }
        errors.push({
          path: `/app/tables/${tableIndex}/fields/${fieldIndex}/emphasis/${value}`,
          message:
            `強調(emphasis)のキー "${value}" は、フィールド "${field.id}" の選択肢(options)にありません。` +
            `emphasis に書けるのは、そのフィールドが実際に取りうる選択肢の値だけです。`,
          allowed_values: allowed,
          hint:
            `選択肢の綴りを確認してください。新しい選択肢を強調したいなら、` +
            `同じ差分の change_field で options にその値を足してから emphasis に書いてください。`,
        });
      }
    });

    // --- 類型3: reference 型の参照先テーブルが実在するか --------------------
    table.fields.forEach((field, fieldIndex) => {
      if (field.type !== "reference") {
        return;
      }
      // システムテーブルは意図的にここへ入れていない(ADR-0006 §9 の裏口封じ)。
      if (!referenceableById.has(field.reference_table)) {
        errors.push({
          path: `/app/tables/${tableIndex}/fields/${fieldIndex}/reference_table`,
          message: `参照先のテーブル "${field.reference_table}" は存在しません。`,
          allowed_values: referenceableIds,
          hint: "実在するテーブルIDを指定するか、先に add_table でテーブルを追加してください。",
        });
      }
      // --- 類型2d(項目側): 参照する項目ごとの「探せる項目」の上書き ---------
      // **照合先は `reference_table` が指すテーブルである**(自テーブルではない)。
      validateReferenceSearchFields(
        referenceableById.get(field.reference_table),
        field.reference_search_fields,
        `/app/tables/${tableIndex}/fields/${fieldIndex}/reference_search_fields`,
        "探す対象(reference_search_fields)",
      );
    });

    // --- 類型2d(テーブル側): 参照されたときの「探せる項目」の既定 -----------
    // **照合先は自テーブルである。** **同じ関数を通すので規則は1組である。**
    validateReferenceSearchFields(
      table,
      table.reference_search_fields,
      `/app/tables/${tableIndex}/reference_search_fields`,
      "探す対象(reference_search_fields)",
    );
  });

  // --- 類型5(後半): ビューIDの重複 -----------------------------------------
  collectDuplicates(
    views.map((view) => view.id),
    (index, id) => {
      errors.push({
        path: `/app/views/${index}/id`,
        message: `ビューID "${id}" が重複しています。ビューIDはアプリ内で一意である必要があります。`,
        hint: "どちらかのビューに別のIDを付けてください。",
      });
    },
  );

  /*
   * --- 類型5(補遺): 一続きの流れの中の位置(`flow.step`)の重複と欠番
   *     (`NV-G9`。`V10-M4-T01` / `ADR-0359` §4b 限定3)-------------------------
   *
   * **`views.forEach` の外に置いてある** —— **これは1つのビューを見ても判定できない
   * 横断の検査だからである**(同じ `flow.id` を持つ**全ビューを集めて**初めて重複と
   * 欠番が言える)。**中に置くと、同じ流れについて N 回同じエラーを出すか、
   * 走査中に他のビューを毎回舐める二重ループになる。**
   * **既存の作法に合わせて `類型5(補遺)` の系列に置いた**(先例: ビューIDの重複 /
   * ワークフローIDの重複 / 役割IDの重複 / 関数IDの重複)。
   *
   * **見るのは2つである**:
   *
   * 1. **同じ流れの中で位置が重複していないこと。** **既存ヘルパ `collectDuplicates` を
   *    そのまま使えた** —— 一意の単位が「流れID + 位置」の組なので、その組を1本の
   *    文字列にして渡している(**`collectDuplicates` の引数は `ResourceId[]` =
   *    `string[]` であり、ID そのものである必要は無い**)。**2件目以降の出現を報告する
   *    という向きも、既存6箇所と1バイトも同じである。**
   * 2. **位置が 1 から始まる連番であること(欠番が無いこと)。** **この形の検査は
   *    着手前このファイルに1つも無かった**(実測)—— **既存ヘルパでは書けないので、
   *    ここに直接書いた。****報告するのは抜けている位置の一覧であり、重複とは
   *    別のメッセージで出す**(直し方が違うためである)。
   *
   * **`flow.id` の一意は検査しない** —— **同じ `flow.id` を複数の画面が持つのが
   * 正常な姿であり(それが「流れ」の定義である)、同じ id を主張する別のものが
   * 構造的に存在しない。****「実在するビューID」の検査も無い** —— **`flow` の値の形に
   * ビューIDが1つも無いからである**(`V10-M4` の決11。**`ADR-0359` §Consequences が
   * 本タスクに課した3本のうち2本が、構造的に空である**)。
   *
   * **段の種類(`kind`)の置ける種別は、ここでは1つも見ない** —— **スキーマの `allOf` が
   * `form` / `list_view` の2分岐で `kind` を入力の段に固定しており、実測でそこが確かに
   * 拒否している**(`ADR-0360` 限定2)。**判定を2箇所に住まわせない。**
   *
   * **`add_view` の経路も `update_view` の経路も、畳み込み後のマニフェストを見る
   * この1箇所が覆う。****拒否は「全か無か」である。**
   */
  {
    /**
     * 流れを宣言しているビューを、元の位置(`viewIndex`)を保ったまま集める。
     *
     * **`"flow" in view` で絞っているのは、`ReportView` だけがこのキーを型として
     * 持たないからである**(`report_view` は流れの段になれない。`V10-M4` の決1)——
     * **`View` の共用体をそのまま `view.flow` と読むと型が合わない。**
     */
    const steps: { viewIndex: number; id: ResourceId; flowId: ResourceId; step: number }[] = [];
    views.forEach((view, viewIndex) => {
      const flow = "flow" in view ? view.flow : undefined;
      if (flow === undefined) {
        return;
      }
      steps.push({ viewIndex, id: view.id, flowId: flow.id, step: flow.step });
    });

    // 1. 同じ流れの中で位置が重複していないか(既存ヘルパをそのまま使う)。
    collectDuplicates(
      steps.map((entry) => `${entry.flowId} ${entry.step}`),
      (index) => {
        const entry = steps[index];
        if (entry === undefined) {
          return;
        }
        errors.push({
          path: `/app/views/${entry.viewIndex}/flow/step`,
          message: `ビュー "${entry.id}" の流れ "${entry.flowId}" の中で、位置(step)${entry.step} が重複しています。同じ流れの中で同じ位置を2度書くことはできません。`,
          hint: "どちらかの画面に別の位置(step)を付けるか、片方の flow を消してください(別の流れであれば同じ位置を書けます)。",
        });
      },
    );

    // 2. 位置が 1 から始まる連番か(欠番が無いか)。
    const byFlowId = new Map<ResourceId, typeof steps>();
    for (const entry of steps) {
      const bucket = byFlowId.get(entry.flowId);
      if (bucket === undefined) {
        byFlowId.set(entry.flowId, [entry]);
      } else {
        bucket.push(entry);
      }
    }
    for (const [flowId, bucket] of byFlowId) {
      const declared = new Set(bucket.map((entry) => entry.step));
      const missing = [...Array(Math.max(...declared)).keys()]
        .map((index) => index + 1)
        .filter((position) => !declared.has(position));
      if (missing.length === 0) {
        continue;
      }
      /** **報告先は、その流れを宣言している画面のうち最初の1つ**(直す場所が一意に定まる)。 */
      const first = bucket[0];
      errors.push({
        path: `/app/views/${first?.viewIndex ?? 0}/flow/step`,
        message: `流れ "${flowId}" の位置(step)が連番になっていません。${missing.join(" / ")} が抜けています。位置は1から始まる連番である必要があります。`,
        hint: "抜けている位置を持つ画面を add_view で足すか、後ろの画面の位置(step)を詰めて1から始まる連番にしてください。",
      });
    }
  }

  views.forEach((view, viewIndex) => {
    const base = `/app/views/${viewIndex}`;

    // --- 類型1: view の table が実在するテーブルIDか -------------------------
    const table = viewTargetById.get(view.table);
    if (table === undefined) {
      errors.push({
        path: `${base}/table`,
        message: `ビュー "${view.id}" が参照するテーブル "${view.table}" は存在しません。`,
        allowed_values: viewTargetIds,
        hint: "実在するテーブルIDを指定するか、先に add_table でテーブルを追加してください。",
      });
      // 参照先テーブルが不明な状態で columns/fields/sort/filter を検証しても
      // 意味のないエラーが増えるだけなので、このビューの残りはスキップする。
      return;
    }

    // --- L2: form はシステムテーブルを対象にできない(ADR-0006 §8) ----------
    // 「存在しない」ではなく「書き込み画面を定義できない」と言う。
    // 候補にシステムテーブルを載せないのは、form を作れるのが宣言テーブルだけだから。
    if (view.type === "form" && isSystemTableId(view.table)) {
      errors.push({
        path: `${base}/table`,
        message: `システムテーブル "${view.table}" は読み取り専用なので、ビュー "${view.id}" のような form(入力画面)を作れません。`,
        allowed_values: referenceableIds,
        hint: "システムテーブルの内容を見せたいなら list_view / detail_view を使ってください。入力画面が要るなら、自分で定義したテーブルを対象にしてください。",
      });
      // table 自体が成立していないので、fields の検証はカスケードさせない。
      return;
    }

    const fieldIds = unique(table.fields.map((field) => field.id));
    const knownField = (id: ResourceId): boolean => fieldIds.includes(id);
    const missingField = (path: string, id: ResourceId, label: string): void => {
      errors.push({
        path,
        message: `${label}に指定されたフィールド "${id}" はテーブル "${table.id}" に存在しません。`,
        allowed_values: fieldIds,
        hint: `テーブル "${table.id}" に実在するフィールドIDを指定するか、先に add_field でフィールドを追加してください。`,
      });
    };

    if (view.type === "list_view") {
      // --- 類型2: columns のフィールドIDが実在するか -------------------------
      view.columns.forEach((columnId, columnIndex) => {
        if (!knownField(columnId)) {
          missingField(`${base}/columns/${columnIndex}`, columnId, "表示列(columns)");
        }
      });

      // --- 類型4: sort.field / filter[].field が実在するか --------------------
      // sort はキー1つでもキーの配列でも書ける(V1-M0-T03)。正規化は
      // `normalizeSort` に、path の付け方は `sortErrorPath` に一本化してある ——
      // 単数で書いたなら `/sort/field`、配列で書いたなら `/sort/<i>/field` を指す。
      normalizeSort(view.sort).forEach((key, index) => {
        if (!knownField(key.field)) {
          missingField(
            `${base}${sortErrorPath(view.sort, index)}/field`,
            key.field,
            "並び順(sort.field)",
          );
        }
      });
      // filter は等値AND配列(後方互換)| ブール式(EC-G12 / ADR-0043)。
      // ブール式のネストの奥にある葉の field も含めて実在照合する(filterFieldRefs が
      // path つきで全葉を集める)。配列形の path は従来どおり `/filter/<index>/field`。
      if (view.filter !== undefined) {
        for (const ref of filterFieldRefs(view.filter)) {
          if (!knownField(ref.field)) {
            missingField(`${base}/filter${ref.path}`, ref.field, "絞り込み(filter)");
          }
        }
      }

      /*
       * --- 類型2b: 列ごとのプリセットのマップキー(D-G4。ADR-0050 / V3-M2-T01)--------
       *
       * `preset_column_align` / `preset_column_width` は **キーがフィールドIDのマップ**で
       * ある。**スキーマはキーの「形」(`$defs/resource_id`)しか見ない**ので、形の正しい
       * 実在しないIDはスキーマを通ってしまう。**同じフィールドIDを指す `columns` は
       * 類型2 が既に実在照合している** —— 検査しなければ同じ画面の中に「片方だけ検査が
       * 無い」非対称が残り、しかもそれは**黙って通って黙って効かない**形になる(憲法6)。
       *
       * **実在の基準は「対象テーブルに在ること」であり、`columns` への掲載は要求しない。**
       * 類型2 / 類型4 と一貫させた —— `sort.field` も `filter[].field` も
       * `related[].columns` も照合先は対象テーブルのフィールド一覧であり、
       * **`columns` 掲載を要求している検査は1本も無い。**
       * **代償**: `columns` に載っていない列に寄せ・幅を書いても通る(当たり先が無いので
       * 効かない)。**これは黙って通るものとして記録してある。**
       *
       * **プリセット7キーのうち、フィールドIDを持つのはこの2キーだけである。**
       * 残る5キーは画面ごとの単一の列挙値なので、指す先を持たない。
       *
       * **path はマップのキーそのものを指す**(添字ではない)。フィールドIDは
       * `^[a-z][a-z0-9_-]*$` なので `/` も `~` も含まず、RFC 6901 のエスケープは要らない。
       */
      /*
       * --- 類型2c: 検索の対象にする列(`E-G7` の (C) 側。V4-M22-T01 / ADR-0112 限定5 / 限定6)---
       *
       * **3つを1箇所で判定する** —— (1) 対象テーブルに実在するか / (2) 型が `text` か
       * `long_text` か / (3) 役割の規則(`app.roles[].rules`)が `target: "field"` でその
       * 項目を名指ししていないか。**`add_view` も `update_view` も
       * 畳み込み後のマニフェストがここを通るので、両経路が同じ判定に覆われる。**
       *
       * **【`V8-M20-T02` による置き直し。旧文を残す】** **(3) の着手前の逐語は
       * 「`audience` を宣言していないか」だった。****そのキーは `V8-M20` が廃止したので、
       * 今日は1つも存在しない**(台帳 `J-G27` / `J-G28`。手続きは `ADR-0301`)。
       * **問いは同じものを、代わりに立った面について問い直してある。**
       * **判定を2箇所に住まわせない**(`apply-diff.ts` 側は値を運ぶだけである)。
       *
       * **拒否は「全か無か」である**(ADR-0047 限定9)—— 1本でも違反していれば差分全体が
       * 通らない。**エラーは列ごとに出す**(1往復で全部直せるように。ADR-0003 §3)。
       *
       * **(2) を検査するのは、`preset_` キーが型を1つも検査していない既存の方針を本キーが
       * 採らないからである**(ADR-0112 限定5)—— **検索は見た目ではなく結果が変わる。**
       *
       * **(3) は既知の穴を広げないための歯止めである**(限定6)——
       * `docs/plan/v4/records/v4-fix1-boundary-bypass.md` §2 (d) の1「**宣言した項目で
       * `filter` を掛けると、当たり `total=1` / 外れ `total=0` で値を当てられる**」。
       * **【正直に書く】本タスクはその穴を1件も塞いでいない**(5件は今日も5件である)。
       * **止めているのは「新しい口が同じ穴を広げること」だけである。**
       *
       * **役割の規則はマニフェスト(`app.roles`)の一部なので、ここから素直に歩ける** ——
       * **`src/server/owner-scope.ts` の `judgeRoleAccess` を呼ばない**(カーネルはサーバに
       * 依存しない)。**述語は `namedByRoleRules`(このファイルの中の1本)である。**
       */
      const SEARCHABLE_TYPES: readonly string[] = ["text", "long_text"];
      view.search_fields?.forEach((fieldId, index) => {
        const path = `${base}/search_fields/${index}`;
        const field = table.fields.find((candidate) => candidate.id === fieldId);
        if (field === undefined) {
          missingField(path, fieldId, "検索の対象(search_fields)");
          return;
        }
        const searchable = table.fields.filter(
          (candidate) =>
            SEARCHABLE_TYPES.includes(candidate.type) && !namedByRoleRules(table.id, candidate.id),
        );
        if (namedByRoleRules(table.id, fieldId)) {
          errors.push({
            path,
            message: `検索の対象(search_fields)に指定されたフィールド "${fieldId}" は、役割の規則が名指ししている項目です。名指しされた項目は検索の対象にできません。`,
            allowed_values: searchable.map((candidate) => candidate.id),
            hint: "役割の規則(app の roles)が名指ししていない text / long_text のフィールドを指定してください(絞り込みの当たり外れから、隠した項目の値が推測できてしまうためです)。",
          });
          return;
        }
        if (!SEARCHABLE_TYPES.includes(field.type)) {
          errors.push({
            path,
            message: `検索の対象(search_fields)に指定されたフィールド "${fieldId}" は ${field.type} 型です。検索の対象にできるのは text / long_text だけです。`,
            allowed_values: searchable.map((candidate) => candidate.id),
            hint: "text / long_text のフィールドを指定してください(照合は部分一致だけなので、他の型では意味が定まりません)。",
          });
        }
      });

      /**
       * **合計を出す列**(`V4-M23-T01`。`D-V4-89` / `E-G31` / `ADR-0104` 限定3)。
       *
       * **3つを1箇所で判定する**: (1) 対象テーブルに実在するか / (2) `number` 型か /
       * (3) 役割の規則(`app.roles[].rules`)が `target: "field"` でその項目を名指しして
       * いないか。**`add_view` も `update_view` も畳み込み後の
       * マニフェストがここを通るので、両経路が同じ判定に覆われる。**
       *
       * **【`V8-M20-T02` による置き直し。旧文を残す】** **(3) の着手前の逐語は
       * 「`audience` を宣言していないか」だった。****そのキーは `V8-M20` が廃止したので、
       * 今日は1つも存在しない**(台帳 `J-G27` / `J-G28`。手続きは `ADR-0301`)。
       * **問いは同じものを、代わりに立った面について問い直してある。**
       * **判定を2箇所に住まわせない**(`apply-diff.ts` 側は値を運ぶだけである)。
       *
       * **拒否は「全か無か」である**(`ADR-0047` 限定9)——
       * **`ADR-0086` 限定4 と同型で「書けるが効かない組み合わせ」を1つも作らない。**
       *
       * **(3) は `ADR-0104` の限定表を越えて締めた1点である。正直に書く。**
       * **限定3 が要求しているのは (1) と (2) だけで、見せる相手の宣言に1文字も触れて
       * いない。**
       * **`ADR-0112` 限定6 が `search_fields` に課したのと同型の締めを、本キーにも課した**
       * —— **合計は行ごとの伏せ字を通らない1つの数なので、締めないと「見えない列の合計
       * だけが見える」形になる。**
       * **開く側ではなく閉じる側の差である。**
       *
       * **役割の規則はマニフェスト(`app.roles`)の一部なので、ここから素直に歩ける** ——
       * **`src/server/owner-scope.ts` を呼ばない**(カーネルはサーバに依存しない)。
       * **述語は `namedByRoleRules`(このファイルの中の1本)である。**
       */
      const sumField = (view as { sum_field?: string }).sum_field;
      if (sumField !== undefined) {
        const path = `${base}/sum_field`;
        const field = table.fields.find((candidate) => candidate.id === sumField);
        const summable = table.fields.filter(
          (candidate) => candidate.type === "number" && !namedByRoleRules(table.id, candidate.id),
        );
        if (field === undefined) {
          missingField(path, sumField, "合計を出す列(sum_field)");
        } else if (namedByRoleRules(table.id, sumField)) {
          errors.push({
            path,
            message: `合計を出す列(sum_field)に指定されたフィールド "${sumField}" は、役割の規則が名指ししている項目です。名指しされた項目の合計は出せません。`,
            allowed_values: summable.map((candidate) => candidate.id),
            hint: "役割の規則(app の roles)が名指ししていない number のフィールドを指定してください(合計は行ごとの伏せ字を通らない1つの数なので、隠した項目の値が推測できてしまうためです)。",
          });
        } else if (field.type !== "number") {
          errors.push({
            path,
            message: `合計を出す列(sum_field)に指定されたフィールド "${sumField}" は ${field.type} 型です。合計を出せるのは number だけです。`,
            allowed_values: summable.map((candidate) => candidate.id),
            hint: "number のフィールドを指定してください(足し算の意味が定まるのは number だけです)。",
          });
        }
      }

      for (const [presetKey, label] of [
        ["preset_column_align", "列の寄せ(preset_column_align)"],
        ["preset_column_width", "列の幅(preset_column_width)"],
      ] as const) {
        const map = view[presetKey];
        if (map === undefined) {
          continue;
        }
        for (const fieldId of Object.keys(map)) {
          if (!knownField(fieldId)) {
            missingField(`${base}/${presetKey}/${fieldId}`, fieldId, label);
          }
        }
      }
    } else if (view.type === "form") {
      // --- 類型2: fields のフィールドIDが実在するか --------------------------
      view.fields.forEach((fieldId, fieldIndex) => {
        if (!knownField(fieldId)) {
          missingField(`${base}/fields/${fieldIndex}`, fieldId, "入力項目(fields)");
        }
      });
      /*
       * --- 類型16: 保存後の行き先 `after_save`(`E-G34`。`V4-M20-T04` / ADR-0102 限定8)---
       *
       * **遷移先が同一アプリ内に実在するビューでなければならない。** 実在しないIDを書くと
       * **保存のたびに行き先が解決できず、表示層が既定へ倒す** —— **宣言したのに1度も
       * 効かない**という「書けるが効かない組み合わせ」になるので、適用時に倒す
       * (`ADR-0086` 限定4)。
       *
       * **種別は問わない**(`list_view` / `detail_view` / `form` のどれでもよい)——
       * `ADR-0102` 限定2 が縛っているのは「ビューID 1つ」であって種別ではない。
       * **自分自身を指してもよい**(保存のたびに同じ入力画面へ戻るだけで、壊れない)。
       *
       * **その画面が見える相手かどうかはここで見ない** —— **見える相手は人によって変わり、
       * 宣言の整合性ではない。** 見えない相手には表示層が既定の行き先へ倒す。
       * **【`V8-M20` による書き直し】着手前のこの段落は `audience` を主語にしていたが、
       * そのキーは今日は存在しない**(廃止は `V8-M20`。台帳 `J-G27`)。**見える相手を
       * 決めるのは `app.roles[].rules` の「役割 × 対象(画面)× 読取」であり、
       * ここで見ないという結論は今日も同じである。**
       */
      if (view.after_save !== undefined && !views.some((v) => v.id === view.after_save)) {
        errors.push({
          path: `${base}/after_save`,
          message: `ビュー "${view.id}" の保存後の行き先(after_save)に指定されたビュー "${view.after_save}" は存在しません。`,
          allowed_values: unique(views.map((candidate) => candidate.id)),
          hint: "同じアプリに実在するビューIDを指定するか、先に add_view でそのビューを追加してください。",
        });
      }
      /*
       * --- 類型2c: 入力画面ごとの選び方の上書き `reference_pickers`
       *     (`K-G2`。`V6-M2-T01` / `ADR-0289` 限定4)------------------------------
       *
       * **キーがフィールドIDのマップである** —— 類型2b(`preset_column_align` /
       * `preset_column_width`)とまったく同じ形の穴を持つ: **スキーマはキーの「形」
       * (`$defs/resource_id`)しか見ないので、形の正しい実在しないIDは通ってしまう。**
       * **`ADR-0080` の `representative_field` が今日そうなっている**(適用時検査が
       * 無いので黙って通って黙って効かない)。**同じ穴を3件目として作らない。**
       *
       * **検査は2つある**: (1) 対象テーブルに実在すること、(2) **その項目が
       * `reference` 型であること。** (2) は `ADR-0086` 限定4 の「書けるが効かない
       * 組み合わせを1つも作らない」の当たり先である —— **選び方は参照項目にしか
       * 意味を持たない。**
       *
       * **`ADR-0288` が項目側で採った作法(`reference` 型にだけ書ける)と揃えてある** ——
       * **項目側はスキーマの `allOf` が閉じ、画面側はここが閉じる。**
       * **拒否は「全か無か」である**(部分適用しない)。
       * **判定を2箇所に住まわせない** —— **`add_view` の経路も `update_view` の経路も、
       * この1箇所が覆う。**
       *
       * **`fields` への掲載は要求しない** —— 類型2b が `columns` 掲載を要求していないのと
       * 同じ扱いである(**代償: 入力欄として出していない参照項目に選び方を書いても通る。
       * 当たり先が無いので効かない**)。
       *
       * **見える相手はここで見ない** —— **見える相手は人によって変わり、宣言の整合性では
       * ない**(`after_save` と同じ扱い)。**`K-G18`(見える範囲だけを候補に出す)は
       * `V6-M4` の担当である。**
       * **【`V8-M20` による書き直し】着手前のこの段落は `audience` を主語にしていたが、
       * そのキーは今日は存在しない**(廃止は `V8-M20`。台帳 `J-G27` / `J-G28`)。
       * **代わりに立つのは `app.roles[].rules` である。ここで見ないという結論は変わらない。**
       */
      if (view.reference_pickers !== undefined) {
        const referenceFieldIds = table.fields
          .filter((candidate) => candidate.type === "reference")
          .map((candidate) => candidate.id);
        for (const fieldId of Object.keys(view.reference_pickers)) {
          const target = table.fields.find((candidate) => candidate.id === fieldId);
          if (target === undefined) {
            missingField(
              `${base}/reference_pickers/${fieldId}`,
              fieldId,
              "参照項目の選び方(reference_pickers)",
            );
          } else if (target.type !== "reference") {
            errors.push({
              path: `${base}/reference_pickers/${fieldId}`,
              message: `参照項目の選び方(reference_pickers)に指定されたフィールド "${fieldId}" は ${target.type} 型です。選び方を書けるのは reference 型のフィールドだけです。`,
              allowed_values: referenceFieldIds,
              hint: "他のテーブルから選ぶ項目(reference)のIDを指定してください(選び方は参照項目にしか意味を持ちません)。",
            });
          }
        }
      }
    } else if (view.type === "report_view") {
      /*
       * --- 類型18: 集計表の中身 `report`(`Q-G1` / `Q-G2` / `Q-G3` / `Q-G4` / `Q-G22`。
       *     `V8-M8`。門A 本審査 = `V8-M7`。審査記録 `docs/plan/v8/records/v8-m7.md`)------
       *
       * **`add_view` も `update_view` も畳み込み後のマニフェストがここを通るので、
       * 両経路が同じ判定に覆われる。** **判定を2箇所に住まわせない**(`apply-diff.ts` 側は
       * 値を運ぶだけである)。**拒否は「全か無か」である**(`ADR-0047` 限定9)——
       * **1本でも違反していれば差分全体が通らない。** **エラーは違反ごとに出す**
       * (1往復で全部直せるように。`ADR-0003` §3)。
       *
       * ## 束ねるキーについて見る4つ
       *
       * 1. **対象テーブルに実在するか。**
       * 2. **束ねられる4型(`select` / `reference` / `boolean` / `date`)か。**
       *    **`text` / `long_text` / `number` / `image` / `file` は束ねられない** ——
       *    **値が実質1行1値になるか(自由入力・ファイル)、束ねる意味が定まらない(数)。**
       *    **`ADR-0112` 限定5 が `search_fields` に型の検査を課したのと同じ理由である** ——
       *    **束ね方は見た目ではなく結果が変わる。**
       * 3. **`date` には束ね方(`granularity`)が要り、`date` 以外には書けない。**
       *    **どちらの向きも「書けるが効かない組み合わせ」だからである**(`ADR-0086` 限定4)
       *    —— **`date` に束ね方が無ければ 1行1群になり、`date` 以外の束ね方は当たり先が無い。**
       * 4. **役割の規則(`app.roles[].rules` の `target: "field"`)が名指ししていないか**
       *    (`Q-G22`)。**述語は `namedByRoleRules`(このファイルの中の1本)である** ——
       *    **`src/server/owner-scope.ts` を呼ばない**(カーネルはサーバに依存しない)。
       *    **`ADR-0104` が `sum_field` に、`ADR-0112` 限定6 が `search_fields` に課したのと
       *    同型の締めである** —— **束ねた数は行ごとの伏せ字を通らないので、締めないと
       *    「見えない項目の内訳だけが見える」形になる**(群のキーそのものが値である)。
       *
       * ## 集計について見る3つ
       *
       * 1. **`sum` は列を1本取り、`count` は列を取らない。** **逆はどちらも拒否する。**
       * 2. **`sum` の列は実在し、`number` でなければならない**(`ADR-0104` 限定3 と同型)。
       * 3. **役割の規則が名指ししている列は合計できない**(`Q-G22`。上の 4 と同じ述語)。
       *
       * ## 絞り込みについて
       *
       * **`report.filter` の中の項目の実在は、一覧の `filter`(類型4)とまったく同じ
       * `filterFieldRefs` で見る** —— **新しい検査を別に書かない。**
       * **ネストの深さ(`MAX_FILTER_DEPTH`)はここで見ない** —— **一覧の `filter` と同じく
       * 読取のときに `compileFilter` が止める(SQ-M4 より前は、システムテーブルだけ
       * `applyOptions` という別の実装が止めていた)。****非対称にしない。**
       */
      /*
       * --- 類型18b: 集計表の結合 `report.join`(`Q-G6` / `Q-G7` / `Q-G8` / `Q-G9`。
       *     `V8-M9`。門A 本審査 = `V8-M7`。裁定 `M7-1`)-------------------------------
       *
       * **【追記である。上の類型18 の doc を1バイトも書き換えていない】**
       * **上の doc の「母集団は `table` が指す1つの表だけである」は今日は偽である** ——
       * **`join` を書くと、起点の表の行に結合先の行が結び付く。**
       *
       * ## 1本の結合の読み方(**ここに無い形を1つも作らない**)
       *
       * **`{ table: T, via: f }` は「表 `T` の `reference` 型フィールド `f` による
       * 突き合わせ」である。** `f` が指す先の表を `U` とする。
       * **向きは宣言から推論する** —— **`T` と `U` のうち、ちょうど一方だけが
       * 「すでに結合の集合に入っている」ことを要求する。**
       *
       * - **`T` が既に在って `U` が新しい** = **順方向**(子 → 親。多対一)。**行数は増えない。**
       * - **`U` が既に在って `T` が新しい** = **逆方向**(親 → 子。一対多)。**行数が増える。**
       * - **両方すでに在る** → **拒否**(閉路。または同じ表の2度結合。どちらを足すのか
       *   決まらない)。
       * - **どちらも入っていない** → **拒否**(孤立)。
       *
       * **起点の表(`view.table`)は最初から集合に入っている**(深さ 0)。
       *
       * ## なぜこれで「プランナを持たない」と言えるか
       *
       * - **宣言の順序が評価の順序である。** **「どの順で辿ると速いか」を選ぶコードが
       *   1行も無い**(この `forEach` は書かれた順にしか進まない)。
       * - **突き合わせに使えるのは実在する `reference` 型フィールド1本だけである** ——
       *   **任意の2列を等値で結ぶ場所がスキーマにも型にも1つも無い。**
       * - **結合の条件を書く場所が無い**(`on` 句が無い)。**`select`(射影)も計算式も無い。**
       *
       * ## 上限は2つ(**裁定 `M7-1`。実数を併記する**)
       *
       * | 上限 | 値 | どこで止まるか |
       * |---|---:|---|
       * | **結合する表の本数**(起点を含む) | **5** | スキーマの `maxItems: 4` + ここ |
       * | **段数**(参照の鎖を辿る回数) | **3** | ここだけ |
       *
       * **段数の数え方**: **起点の深さを 0 とし、新しく入る表の深さ = すでに在る側の
       * 表の深さ + 1。** **どれか1つでも 3 を超えたら拒否。**
       * **【禁止】この2つを「測って決めた値」と書かない** —— **表の本数は `ADR-0062`
       * 限定3 の `maxItems: 5` からの借用、段数は 2026-08-14 にディスク上の `support` に
       * 在った鎖の長さ(`comment_grants.target → comments.task → tasks.project → projects`)
       * である。**
       * **【正直に書く】本数の検査は今日は1度も発火しない** —— **スキーマの `maxItems: 4`
       * が先に止めるからである。** **それでも置いてあるのは、`maxItems` を緩めた瞬間に
       * 本数の歯止めが消えることを避けるためである**(判定を2箇所に住まわせているのではない。
       * **同じ1つの上限を、形の側と適用の側の両方で閉じている**)。
       *
       * ### 【2026-08-15 追記(`V8-M10-T05b`)。上の表と本文を1バイトも書き換えていない】
       *
       * **見出しの「上限は2つ」は、**この場所で止まる**上限の数としては今日も正である。**
       * **しかし集計表そのものの上限は4つある** —— **残る2つは**読取時**に効く**:
       * **群にまとめる前に読む行(**表ごと** 10,000)と、作る群の数(10,000)。**
       * **正は `src/server/report-limits.ts` の `MAX_REPORT_SCANNED_ROWS` /
       * `MAX_REPORT_GROUPS` で、応答文への翻訳は `src/server/errors.ts` の
       * `reportLimitError` が持つ。** **4つとも inclusive である**(値ちょうどは通る)。
       * **書き足したのは、「上限は2つ」だけを読んで「集計表の上限は2つである」と
       * 受け取られないようにするためである**(`02-report-aggregation-baseline.md` §9 の22)。
       * **読取時の2つをこのファイルで検査してはいない** —— **apply の時点では行が何行
       * あるかを知らないので、原理的にここでは止められない。**
       *
       * ## 逆方向は1本まで(**この限定は `V8-M9` の実装が作った**)
       *
       * **逆方向(一対多)が2本以上あると、2つのファンアウトが掛け算になり、合計が
       * 重複して数えられる。** **それを止める形(重複排除)を1つも持たないので、
       * 逆方向を1本に閉じる。** **`D-V8-1` の3例はこれで足りる**(3例目「商品ごとの
       * 決済方法別売上集計」は 起点 = 商品 / 逆方向1本(明細)/ 順方向1本(注文))。
       * **【禁止】「重複しない」と書かない** —— **書けるのは「重複しうる形をスキーマから
       * 閉め出した」までである。** **逆方向が1本でも入れば、起点の行はその子の数だけ
       * 数えられる**(実測は `src/server/report-join-boundary.test.ts` の (17))。
       *
       * ## 束ねるキー・集計列の帰属先
       *
       * **`group_by[].table` / `aggregates[].table` を省略すると起点の表を指す** ——
       * **`V8-M8` までの宣言は1バイトも書き換えずにそのまま通る。**
       * **結合に入っていない表を指したら拒否する。**
       * **`Q-G22`(役割の規則が名指しした項目)の壁は、結合の向こう側の表にも当てる** ——
       * **述語は同じ `namedByRoleRules` で、表IDだけが変わる。**
       *
       * ## 絞り込みは起点にだけ掛かる
       *
       * **`report.filter` の検査は1バイトも変えていない**(下の `knownField` は今日も
       * 起点の表の列だけを知っている)—— **結合先の列で絞る形を1つも作らない**
       * (`ADR-0043` §3a-3)。**代償は「区分Bの注文だけを商品ごとに集計する」が書けないこと。**
       */
      const MAX_JOINED_TABLES = 5;
      const MAX_JOIN_DEPTH = 3;
      // **起点の表は最初から入っている**(深さ 0)。
      const joinedDepth = new Map<ResourceId, number>([[table.id, 0]]);
      let reverseJoins = 0;
      view.report.join?.forEach((step, stepIndex) => {
        const path = `${base}/report/join/${stepIndex}`;
        // **結合できるのは宣言テーブルだけである** —— **`referenceableById` を引くので、
        // システムテーブルはそもそも候補に入らない**(`$defs/resource_id` も弾く)。
        const from = referenceableById.get(step.table);
        if (from === undefined) {
          errors.push({
            path: `${path}/table`,
            message: `結合(report.join)に指定されたテーブル "${step.table}" は存在しません。`,
            allowed_values: referenceableIds,
            hint: "同じアプリに実在するテーブルIDを指定するか、先に add_table でテーブルを追加してください。",
          });
          return;
        }
        const via = from.fields.find((candidate) => candidate.id === step.via);
        if (via === undefined) {
          errors.push({
            path: `${path}/via`,
            message: `結合(report.join)の突き合わせに指定されたフィールド "${step.via}" はテーブル "${from.id}" に存在しません。`,
            allowed_values: from.fields
              .filter((candidate) => candidate.type === "reference")
              .map((candidate) => candidate.id),
            hint: `テーブル "${from.id}" に実在する reference 型のフィールドIDを指定してください(突き合わせに使えるのは参照項目だけです)。`,
          });
          return;
        }
        if (via.type !== "reference" || via.reference_table === undefined) {
          errors.push({
            path: `${path}/via`,
            message: `結合(report.join)の突き合わせに指定されたフィールド "${step.via}" は ${via.type} 型です。突き合わせに使えるのは reference 型のフィールドだけです。`,
            allowed_values: from.fields
              .filter((candidate) => candidate.type === "reference")
              .map((candidate) => candidate.id),
            hint: "他のテーブルを指す参照項目(reference)のIDを指定してください(任意の2つの列を突き合わせる書き方はありません)。",
          });
          return;
        }
        const toId = via.reference_table;
        const fromDepth = joinedDepth.get(from.id);
        const toDepth = joinedDepth.get(toId);
        if (fromDepth !== undefined && toDepth !== undefined) {
          errors.push({
            path,
            message: `結合(report.join)の "${from.id}" と参照先 "${toId}" は、どちらもすでに結合に入っています。同じ表を2度結合することも、環状に結合することもできません。`,
            hint: "この行を削除するか、まだ結合に入っていない表へ1本ずつ辿るように書き直してください。",
          });
          return;
        }
        if (fromDepth === undefined && toDepth === undefined) {
          errors.push({
            path,
            message: `結合(report.join)の "${from.id}" と参照先 "${toId}" は、どちらもまだ結合に入っていません。すでに結合に入っている表から1本ずつ辿ってください。`,
            allowed_values: [...joinedDepth.keys()],
            hint: "起点の表(画面の table)から順に辿るように、結合を書く順序を並べ替えてください(書いた順がそのまま辿る順です)。",
          });
          return;
        }
        // **ここから先は「ちょうど一方だけが入っている」** —— 向きが1つに決まる。
        const forward = fromDepth !== undefined;
        const added = forward ? toId : from.id;
        // biome-ignore lint/style/noNonNullAssertion: 直前の2分岐で、どちらか一方は必ず在る。
        const depth = (forward ? fromDepth! : toDepth!) + 1;
        if (!forward) {
          reverseJoins += 1;
          if (reverseJoins > 1) {
            errors.push({
              path,
              message: `一対多の向きの結合(report.join)は1本までです(2本目: "${from.id}")。`,
              hint: "一対多の結合を2本書くと、行が掛け算で増えて合計が重複して数えられます。数えたい側の表を起点にするか、集計表を2枚に分けてください。",
            });
            return;
          }
        }
        if (depth > MAX_JOIN_DEPTH) {
          errors.push({
            path,
            message: `結合(report.join)の段数が上限(${MAX_JOIN_DEPTH}段)を超えています("${added}" は ${depth} 段目です)。`,
            hint: "辿る鎖を短くするか、集計表を分けてください(参照の鎖を辿れるのは3段までです)。",
          });
          return;
        }
        if (joinedDepth.size + 1 > MAX_JOINED_TABLES) {
          errors.push({
            path,
            message: `結合(report.join)で束ねられる表は起点を含めて ${MAX_JOINED_TABLES} 本までです。`,
            hint: "結合を減らすか、集計表を分けてください。",
          });
          return;
        }
        joinedDepth.set(added, depth);
      });

      /**
       * **束ねるキー・集計列が指す表を1つ返す**(`V8-M9`)。
       *
       * **省略時は起点の表である。** **結合に入っていない表を指していたら `undefined` を
       * 返し、呼び手がその場でエラーを出す。**
       */
      const joinedTable = (declared: ResourceId | undefined): Table | undefined => {
        if (declared === undefined || declared === table.id) {
          return table;
        }
        return joinedDepth.has(declared) ? referenceableById.get(declared) : undefined;
      };
      /** 結合に入っていない表を指したときのエラー(束ねるキーと集計列で同じ文面を使う)。 */
      const notJoined = (path: string, declared: ResourceId, label: string): void => {
        errors.push({
          path,
          message: `${label}のテーブル "${declared}" は、この集計表の結合(report.join)に入っていません。`,
          allowed_values: [...joinedDepth.keys()],
          hint: "join にその表への結合を1本足すか、table を省略して起点の表の項目を指してください。",
        });
      };

      /*
       * --- 類型18c: 束ねるキーに書ける**予約名**(`D-V8-126`。`V8-M9`)------------------
       *
       * **【追記である。上の類型18 / 類型18b の doc を1バイトも書き換えていない】**
       * **類型18 の doc の「束ねられる4型」は今日も真であるが、**それが全量ではない** ——
       * **予約された行の番号(`_id`)だけは、宣言された項目でないのに書ける。**
       *
       * ## なぜ穴だったか(**`V8-M9` の実装が見つけた。審査も計画文書も予告していない**)
       *
       * **`Q-G2` の審査は束ねるキーの型を `select` / `reference` / `boolean`(+ `date`)に
       * 閉じた。** **どれも「あらかじめ決まった選択肢」か「他の表を指す参照」であって、
       * **起点の表の行そのもの**を指す形が1つも無い。** **そこへ `D-V8-120`(相手が
       * 1件も無い行も落とさない)が組み合わさると、「商品を1件ずつ並べる」と
       * 「売れていない商品も 0 で並べる」が同時に満たせなくなる**(起点を明細にすると
       * 売れていない商品が消え、起点を商品にすると1件ずつ束ねる手だてが無い)。
       *
       * ## 書ける予約名は **`_id` ただ1つ**である
       *
       * | 綴り | 書けるか | 止める場所 |
       * |---|---|---|
       * | **`_id`** | **書ける** | —— |
       * | `_created_at` / `_updated_at` | **書けない** | **スキーマの pattern が先に止める。**ここでも止める(pattern を緩めた日に穴が開かないように) |
       * | `st_owner` / `st_public` / `st_undeletable` / `st_no_direct_create` | **書けない** | **ここだけ**(pattern には当たる) |
       *
       * **`st_*` の4本は「予約規約フィールド」であり、カーネルから見ると型のついた
       * 宣言された項目にすぎない**(`src/server/owner-scope.ts` が意味を与えている)。
       * **したがって `st_public` / `st_undeletable` / `st_no_direct_create`(いずれも
       * `boolean`)は、着手前は束ねるキーに**書けていた**。** **本追記はそれを閉じる側の
       * 変更である** —— **群のキーそのものが値なので、行の持ち主や公開の別が群の見出しとして
       * 出る形を作らない**(`Q-G22` が役割の規則の名指しについて置いた線と同じ向き)。
       * **【正直に書く】これは今日できていたことが1つできなくなる変更である。**
       *
       * **綴りは `src/server/owner-scope.ts` の `OWNER_FIELD` / `PUBLIC_FIELD` /
       * `UNDELETABLE_FIELD` / `NO_DIRECT_CREATE_FIELD` の写しである** ——
       * **カーネルは `src/server/` を import できない**(`ADR-0009` の層分離)。
       * **`ACCESS_CONTROL_EXCLUSIVE_FIELDS` が同じ理由で写しになっているのと同型である。**
       *
       * ## `granularity` と同時には書けない
       *
       * **行の番号は日付ではない。** **「書けるが効かない組み合わせ」を1つも作らない**
       * (`ADR-0086` 限定4 と同型)。
       *
       * ## ここが**しない**こと
       *
       * - **`aggregates[].field` は1バイトも広げていない** —— **行の番号は合計の対象に
       *   ならない**(スキーマの `$ref: "#/$defs/resource_id"` が今日も先に止める)。
       * - **`report.filter` の中も1ミリも広げていない。**
       * - **代表の項目(商品名)を群の見出しに出すことは1バイトもしない**(`V8-M11`)。
       * - **群の数の上限を1つも掛けていない**(`V8-M10`)—— **行そのもので束ねると
       *   群の数は起点の表の行数と等しくなり、上限 10,000 に行数がそのまま当たる。**
       */
      const groupableTypes: readonly string[] = ["select", "reference", "boolean", "date"];
      view.report.group_by.forEach((key, keyIndex) => {
        const path = `${base}/report/group_by/${keyIndex}`;
        const source = joinedTable(key.table);
        if (source === undefined) {
          // biome-ignore lint/style/noNonNullAssertion: `undefined` が返るのは `key.table` が在るときだけである。
          notJoined(`${path}/table`, key.table!, "束ねるキー(report.group_by)");
          return;
        }
        // **予約名の判定は、実在照合より**先**である** —— **`_id` はどの表の `fields` にも
        // 現れず(`$defs/resource_id` の pattern が `_` 始まりを禁じている)、後ろに置くと
        // 「存在しません」で先に落ちるからである。**
        if (RESERVED_GROUP_BY_NAMES.includes(key.field)) {
          if (key.field !== SYSTEM_COLUMNS.id) {
            errors.push({
              path: `${path}/field`,
              message: `束ねるキー(report.group_by)に指定された "${key.field}" は予約された名前です。束ねるキーに書ける予約名は "${SYSTEM_COLUMNS.id}"(行そのもの)だけです。`,
              allowed_values: [SYSTEM_COLUMNS.id],
              hint: `行そのもので束ねたいなら "${SYSTEM_COLUMNS.id}" を書いてください。それ以外の予約名は、束ねると持ち主や内部の状態が群の見出しとして出てしまうため書けません。`,
            });
            return;
          }
          if (key.granularity !== undefined) {
            errors.push({
              path: `${path}/granularity`,
              message: `束ね方(granularity)を書けるのは date 型のフィールドだけです。"${SYSTEM_COLUMNS.id}" は行そのものであって日付ではありません。`,
              hint: "granularity を削除するか、date 型のフィールドを指定してください(行そのもので束ねると1行が1群になるので、丸める単位に当たり先がありません)。",
            });
            return;
          }
          // **ここで通る** —— **型の検査にも `granularity` の検査にも掛けない**
          // (行の番号に型は無い)。
          return;
        }
        const groupable = source.fields.filter(
          (candidate) =>
            groupableTypes.includes(candidate.type) &&
            !RESERVED_GROUP_BY_NAMES.includes(candidate.id) &&
            !namedByRoleRules(source.id, candidate.id),
        );
        const field = source.fields.find((candidate) => candidate.id === key.field);
        if (field === undefined) {
          errors.push({
            path: `${path}/field`,
            message: `束ねるキー(report.group_by)に指定されたフィールド "${key.field}" はテーブル "${source.id}" に存在しません。`,
            allowed_values: unique(source.fields.map((candidate) => candidate.id)),
            hint: `テーブル "${source.id}" に実在するフィールドIDを指定するか、先に add_field でフィールドを追加してください。`,
          });
          return;
        }
        if (namedByRoleRules(source.id, key.field)) {
          errors.push({
            path: `${path}/field`,
            message: `束ねるキー(report.group_by)に指定されたフィールド "${key.field}" は、役割の規則が名指ししている項目です。名指しされた項目では束ねられません。`,
            allowed_values: groupable.map((candidate) => candidate.id),
            hint: "役割の規則(app の roles)が名指ししていない select / reference / boolean / date のフィールドを指定してください(束ねた群のキーそのものが値なので、隠した項目の値が読めてしまうためです)。",
          });
          return;
        }
        if (!groupableTypes.includes(field.type)) {
          errors.push({
            path: `${path}/field`,
            message: `束ねるキー(report.group_by)に指定されたフィールド "${key.field}" は ${field.type} 型です。束ねられるのは select / reference / boolean / date だけです。`,
            allowed_values: groupable.map((candidate) => candidate.id),
            hint: "select / reference / boolean / date のフィールドを指定してください(自由入力・数・ファイルは、束ねても1行1群になるか意味が定まりません)。",
          });
          return;
        }
        if (field.type === "date" && key.granularity === undefined) {
          errors.push({
            path,
            message: `束ねるキー(report.group_by)に date 型のフィールド "${key.field}" を指定したときは、束ね方(granularity)を必ず書いてください。`,
            allowed_values: ["day", "week", "month"],
            hint: "day / week / month のいずれかを granularity に書いてください(書かないと日付が1つ違うだけで別の群になります)。",
          });
          return;
        }
        if (field.type !== "date" && key.granularity !== undefined) {
          errors.push({
            path: `${path}/granularity`,
            message: `束ね方(granularity)を書けるのは date 型のフィールドだけです。"${key.field}" は ${field.type} 型です。`,
            hint: "granularity を削除するか、date 型のフィールドを指定してください(date 以外に束ね方を書いても当たり先がありません)。",
          });
        }
      });

      view.report.aggregates.forEach((aggregate, aggregateIndex) => {
        const path = `${base}/report/aggregates/${aggregateIndex}`;
        // **`table` は `count` にも書ける** —— **その表の行が結び付いた行だけを数えるので、
        // 逆方向の結合で子が1件も無い群は 0 になる**(`D-V8-120`)。**したがって
        // 結合に入っているかどうかの検査は、`count` と `sum` の前に1度だけ通す。**
        const source = joinedTable(aggregate.table);
        if (source === undefined) {
          // biome-ignore lint/style/noNonNullAssertion: `undefined` が返るのは `aggregate.table` が在るときだけである。
          notJoined(`${path}/table`, aggregate.table!, "集計(report.aggregates)");
          return;
        }
        const summable = source.fields.filter(
          (candidate) => candidate.type === "number" && !namedByRoleRules(source.id, candidate.id),
        );
        if (aggregate.type === "count") {
          if (aggregate.field !== undefined) {
            errors.push({
              path,
              message: `件数(count)には列(field)を書けません。"${aggregate.field}" を削除してください。`,
              hint: "件数はその群に入った行の数そのものなので、数える列を選ぶ余地がありません。合計を出したいなら type を sum にしてください。",
            });
          }
          return;
        }
        if (aggregate.field === undefined) {
          errors.push({
            path,
            message: "合計(sum)には合計する列(field)を必ず書いてください。",
            allowed_values: summable.map((candidate) => candidate.id),
            hint: "number 型のフィールドIDを field に書いてください(何を足すのかを書く場所がここしかありません)。",
          });
          return;
        }
        const field = source.fields.find((candidate) => candidate.id === aggregate.field);
        if (field === undefined) {
          errors.push({
            path: `${path}/field`,
            message: `合計する列(report.aggregates)に指定されたフィールド "${aggregate.field}" はテーブル "${source.id}" に存在しません。`,
            allowed_values: unique(source.fields.map((candidate) => candidate.id)),
            hint: `テーブル "${source.id}" に実在するフィールドIDを指定するか、先に add_field でフィールドを追加してください。`,
          });
          return;
        }
        if (namedByRoleRules(source.id, aggregate.field)) {
          errors.push({
            path: `${path}/field`,
            message: `合計する列(report.aggregates)に指定されたフィールド "${aggregate.field}" は、役割の規則が名指ししている項目です。名指しされた項目の合計は出せません。`,
            allowed_values: summable.map((candidate) => candidate.id),
            hint: "役割の規則(app の roles)が名指ししていない number のフィールドを指定してください(合計は行ごとの伏せ字を通らない1つの数なので、隠した項目の値が推測できてしまうためです)。",
          });
          return;
        }
        if (field.type !== "number") {
          errors.push({
            path: `${path}/field`,
            message: `合計する列(report.aggregates)に指定されたフィールド "${aggregate.field}" は ${field.type} 型です。合計を出せるのは number だけです。`,
            allowed_values: summable.map((candidate) => candidate.id),

            hint: "number のフィールドを指定してください(足し算の意味が定まるのは number だけです)。",
          });
        }
      });

      /*
       * --- 並べ替えの添字が、宣言した本数の内側であること(`V8-M11-T02`。台帳 `Q-G21a` /
       *     `Q-G12`。門A 本審査 = `V8-M7`。ユーザ決定 `D-V8-130`)------------------------
       *
       * **`schemas/manifest.schema.json` の `$defs/report.properties.sort` は `index` を
       * `0..2` に閉じているが、「宣言した `group_by` / `aggregates` の本数の内側であること」
       * は JSON Schema では表せない** —— **束ねるキーが1本の宣言に
       * `{ target: "group_by", index: 2 }` と書いた差分は、スキーマだけなら通ってしまう。**
       *
       * **すぐ上の `granularity` の2件(`date` に束ね方が無い / `date` 以外に束ね方がある)と
       * 同じ形・同じ場所に置いてある** —— **「書けるが効かない組み合わせを1つも作らない」**
       * (`ADR-0086` 限定4 と同型)。**`201` で通った宣言が読取時に壊れる形を作らない。**
       *
       * **並べ替えは母集団にも群にも1ミリも触らない** —— **したがってここで見るのは本数
       * だけであり、実在・型・役割の規則の名指しは1件も見ない**(**見る対象が項目ではなく
       * 添字だからである**)。
       */
      const sort = view.report.sort;
      if (sort !== undefined) {
        const grouping = sort.target === "group_by";
        const declared = grouping ? view.report.group_by.length : view.report.aggregates.length;
        if (sort.index >= declared) {
          const what = grouping ? "束ねるキー(group_by)" : "集計(aggregates)";
          errors.push({
            path: `${base}/report/sort/index`,
            message: `並べ替え(report.sort)が指している ${sort.index} 番目の${what}は宣言されていません。宣言されているのは ${declared} 本です。`,
            allowed_values: Array.from({ length: declared }, (_unused, i) => String(i)),
            hint: `番号(index)は宣言に書いた順で、先頭が 0 です。0 から ${declared - 1} までのいずれかを書くか、並べ替えたい${what}を先に宣言してください。`,
          });
        }
      }

      if (view.report.filter !== undefined) {
        for (const ref of filterFieldRefs(view.report.filter)) {
          if (!knownField(ref.field)) {
            missingField(
              `${base}/report/filter${ref.path}`,
              ref.field,
              "集計表の絞り込み(report.filter)",
            );
          }
        }
      }

      /*
       * --- 類型5(補遺): 集計表の列の名札の重複(`CM-G31`。`V10-M24-T05` /
       *     `ADR-0371` 限定1〜限定6)------------------------------------------------
       *
       * **一意の範囲は「1つの画面の中」だけである** —— **別の画面には同じ名札を書ける。**
       * **重複は JSON Schema では表せない**(`uniqueItems` はオブジェクト全体の同値でしか
       * 効かず、`{"id":"col","field":"status"}` と `{"id":"col","field":"kind"}` を通して
       * しまう)ので、適用時のここで倒す。**役割IDの重複(類型5 補遺)と同じ形・同じ理由
       * である。**
       *
       * **`group_by` と `aggregates` は1つの名前空間である** —— **宛先の形が
       * `(view_id, report_node_id)` の1形だからで、束ねるキーと集計に同じ名札を書くと
       * 宛先が2つの列を指してしまう。****したがって2つの配列を1本に連ねて数える。**
       *
       * **名札を書いていない列は1件も拒否しない**(名札は任意 = `ADR-0371` 限定1)——
       * **数える対象から先に外してある。****添字は元の配列の添字のままである**
       * (外した分で詰めない)。
       *
       * **`report.sort` が指す番号(`index`)とは無関係である** —— **名札は並び順を
       * 1ミリも動かさない。**
       */
      const reportAnchors = [
        ...view.report.group_by.flatMap((key, keyIndex) =>
          key.id === undefined
            ? []
            : [{ id: key.id, path: `${base}/report/group_by/${keyIndex}/id` }],
        ),
        ...view.report.aggregates.flatMap((aggregate, aggregateIndex) =>
          aggregate.id === undefined
            ? []
            : [{ id: aggregate.id, path: `${base}/report/aggregates/${aggregateIndex}/id` }],
        ),
      ];
      collectDuplicates(
        reportAnchors.map((anchor) => anchor.id),
        (index, id) => {
          // `index` は `reportAnchors` の添字そのものだが、`noUncheckedIndexedAccess` の
          // 下では `| undefined` になる。`!` を使わずに素直に落とす。
          const anchor = reportAnchors[index];
          if (anchor === undefined) {
            return;
          }
          errors.push({
            path: anchor.path,
            message: `ビュー "${view.id}" の集計表の列の名札 "${id}" が、同じ画面の中で重複しています。`,
            hint: "束ねるキー(group_by)と集計(aggregates)は1つの名前空間です。どちらかに別の名札を付けるか、片方の名札を消してください(別の画面には同じ名札を書けます)。",
          });
        },
      );
    } else {
      // --- 類型2: detail_view.fields のフィールドIDが実在するか ---------------
      // `fields` は任意(未指定 = 全フィールド表示)なので、あるときだけ照合する。
      // **エラーは上2つと同じ `missingField` から出す** —— 表示時ではなく書き込み時に
      // 弾き、かつ3ビューで形が揃っていることが本追補の目的である(V1-M0-T09 §6-1)。
      view.fields?.forEach((fieldId, fieldIndex) => {
        if (!knownField(fieldId)) {
          missingField(`${base}/fields/${fieldIndex}`, fieldId, "表示項目(fields)");
        }
      });

      /*
       * --- 類型16b: 書換ボタンが成立したあとの行き先 `after_save`
       *     (`NV-G3a`。`V10-M1-T01` / `ADR-0358` 限定1・限定3)------------------------
       *
       * **判定の中身は上の類型16(`form` 分岐)と1バイトも同じである** ——
       * **遷移先が同一アプリ内に実在するビューでなければならない。**
       * **実在しないIDを書くと「宣言したのに1度も効かない」形になる**ので、適用時に倒す
       * (`ADR-0086` 限定4)。**`add_view` の経路も `update_view` の経路も、
       * 畳み込み後のマニフェストを見るこの1箇所が覆う。**
       *
       * **【意味のずれを隠さない(`ADR-0358` 限定6)】文面の「保存後の行き先」は
       * `form` の側の言葉である。** **詳細画面に「保存」という出来事は無く、発火するのは
       * `actions` の `set` 形(値の書換)の書込が成立したときだけである**(限定2)。
       * **文面を1本に保つために `form` と同じ1文を出している** ——
       * **新しいエラー文面を1本も作っていない。**
       *
       * **その画面が見える相手かどうかはここで見ない**(類型16 と同じ)——
       * **見える相手は人によって変わり、宣言の整合性ではない。**
       */
      if (view.after_save !== undefined && !views.some((v) => v.id === view.after_save)) {
        errors.push({
          path: `${base}/after_save`,
          message: `ビュー "${view.id}" の保存後の行き先(after_save)に指定されたビュー "${view.after_save}" は存在しません。`,
          allowed_values: unique(views.map((candidate) => candidate.id)),
          hint: "同じアプリに実在するビューIDを指定するか、先に add_view でそのビューを追加してください。",
        });
      }

      /*
       * --- 類型16c: 削除が成立したあとの行き先 `after_delete`
       *     (`NV-G4`。`V10-M1-T02` / `ADR-0359` §4a 限定3・限定4)------------------------
       *
       * **すぐ上の類型16b(`after_save`)の隣に置いてある** —— **同じ「書込の後の
       * 行き先」であり、判定の置き場を割らない。**
       *
       * **見るのは2つである**(限定3 の「実在する」と限定4 の「行を必要としない画面」):
       *
       * 1. **同一アプリ内に実在するビューであること。** 実在しないIDを書くと
       *    「宣言したのに1度も効かない」形になるので、適用時に倒す(`ADR-0086` 限定4)。
       * 2. **その画面が `list_view` か `report_view` であること。**
       *    **`detail_view` / `form` は1件の行を必要とする画面であり、削除の直後に
       *    その行を開こうとして `DetailViewRenderer.tsx` のエラー画面になる**
       *    (`ADR-0359` §5a の `S3` 3 が実測している)。
       *    **「書けるが効かない組み合わせを1つも作らない」** ——
       *    **これは類型16 / 16b(`after_save`)に無い判定である**(`form` の保存後は
       *    行のある画面へ行くのが普通なので、あちらは型で1つも絞っていない)。
       *
       * **`add_view` の経路も `update_view` の経路も、畳み込み後のマニフェストを見る
       * この1箇所が覆う。****拒否は「全か無か」である。**
       *
       * **その画面が見える相手かどうかはここで見ない**(類型16 / 16b と同じ)——
       * **見える相手は人によって変わり、宣言の整合性ではない。**
       */
      if (view.after_delete !== undefined) {
        const destination = views.find((candidate) => candidate.id === view.after_delete);
        /** **行き先にできる画面** —— **1件の行を必要としない2種別だけである**(限定4)。 */
        const routable = unique(
          views
            .filter(
              (candidate) => candidate.type === "list_view" || candidate.type === "report_view",
            )
            .map((candidate) => candidate.id),
        );
        if (destination === undefined) {
          errors.push({
            path: `${base}/after_delete`,
            message: `ビュー "${view.id}" の削除後の行き先(after_delete)に指定されたビュー "${view.after_delete}" は存在しません。`,
            allowed_values: routable,
            hint: "同じアプリに実在する一覧画面(list_view)か集計表(report_view)のビューIDを指定するか、先に add_view でそのビューを追加してください。",
          });
        } else if (destination.type !== "list_view" && destination.type !== "report_view") {
          errors.push({
            path: `${base}/after_delete`,
            message: `ビュー "${view.id}" の削除後の行き先(after_delete)に指定されたビュー "${view.after_delete}" は ${destination.type} なので、行き先にできません。削除したばかりの行を開こうとしてエラー画面になります。`,
            allowed_values: routable,
            hint: "行き先にできるのは1件の行を必要としない画面、つまり一覧画面(list_view)か集計表(report_view)だけです。",
          });
        }
      }

      /*
       * --- 類型15: 詳細画面の項目のまとまり `field_groups`(`P-G17` の (C) 側。ADR-0092)------
       *
       * **detail_view にだけ許した宣言**(schema が list_view / form では `field_groups:false`)。
       * ここで検査するのは **限定5**「整合しない宣言は差分全体を拒否する」であり、
       * **置き場をここにしたのは適用後マニフェストを見るからである** ——
       * **`add_view` の経路も `update_view` の経路も、この1箇所で覆える。**
       *
       * 1. **同じフィールドIDが2つのまとまりに現れたら拒否する。**(まとまりの中の重複は
       *    schema の `uniqueItems` が既に弾いているので、ここが見るのは**跨いだ**重複である。)
       * 2. **その画面に無いIDを書いても拒否する。**
       *
       * **照合先は2通りある。** **`detail_view.fields` は任意である**(未指定 =
       * 「テーブル定義順の全項目」= `web/src/views/DetailViewRenderer.tsx` の `fields`)ので:
       * - **`fields` を書いた画面** …… 照合先は**その `fields`** である。`fields` に無い項目は
       *   そもそも描かれないので、まとまりに入れても当たり先が無い(= 黙って効かない)。
       * - **`fields` を書いていない画面** …… 照合先は**対象テーブルのフィールド**である。
       *
       * **`fields` 自体の実在照合は上の類型2 が既に済ませている**ので、ここでは二重に言わない
       * (`fields` が壊れている差分は、どちらの経路でも既に拒否されている)。
       *
       * **`related` の子一覧には当たらない**(限定8)—— 子テーブルのフィールドは照合先に
       * 1つも入らない。
       *
       * **path はまとまりの名前と配列の添字を指す。** **まとまりの名前は表示名であって
       * `resource_id` ではない**ので、`/` も `~` も含みうる —— RFC 6901 のエスケープを掛ける
       * (フィールドIDを指す既存の path はエスケープ不要だが、ここは形が違う)。
       */
      if (view.field_groups !== undefined) {
        /** RFC 6901: `~` → `~0`、`/` → `~1`(順序を逆にすると `/` が二重に化ける)。 */
        const escapePointer = (token: string): string =>
          token.replaceAll("~", "~0").replaceAll("/", "~1");
        /** 照合先(限定5 の2場合分け)。 */
        const scope = view.fields ?? fieldIds;
        /** 既に現れたフィールドID → 最初に現れたまとまりの名前。 */
        const seen = new Map<ResourceId, string>();
        for (const [groupName, group] of Object.entries(view.field_groups)) {
          /*
           * **【`CM-G24` / `V10-M24-T03`】まとまりの値は2形ある**(`ADR-0371`)——
           * **配列そのもの**か、**名札を持つ `{ id?, fields }`**。**照合するのは中身だけ**で、
           * **名札は1度も読まない**(名札の一意は `V10-M24-T05` が別に見る)。
           * **path は着手前と1バイトも変わらない** —— 添字はどちらの形でも `fields` の添字である。
           */
          const memberIds = Array.isArray(group) ? group : group.fields;
          memberIds.forEach((fieldId, memberIndex) => {
            const path = `${base}/field_groups/${escapePointer(groupName)}/${memberIndex}`;
            if (!scope.includes(fieldId)) {
              errors.push({
                path,
                message: `ビュー "${view.id}" の項目のまとまり(field_groups)に指定されたフィールド "${fieldId}" は、この画面の表示項目にありません。`,
                allowed_values: scope,
                hint:
                  view.fields === undefined
                    ? `テーブル "${table.id}" に実在するフィールドIDを指定するか、先に add_field でフィールドを追加してください。`
                    : `この detail_view の表示項目(fields)に書いたフィールドIDを指定するか、先に fields へ追加してください。`,
              });
              return;
            }
            const first = seen.get(fieldId);
            if (first !== undefined) {
              errors.push({
                path,
                /*
                 * **`allowed_values` は付けない。**候補が有限の「不在ID」ではないからである
                 * (先例は下の類型のワークフロー側)。**行き先は hint が示す。**
                 */
                message: `ビュー "${view.id}" の項目のまとまり(field_groups)で、フィールド "${fieldId}" が2つのまとまり("${first}" と "${groupName}")の両方に現れています。`,
                hint: "1つの項目が属せるまとまりは1つだけです。どちらかのまとまりから外してください。",
              });
              return;
            }
            seen.set(fieldId, groupName);
          });
        }

        /*
         * --- 類型5(補遺): 項目のまとまりの名札の重複(`CM-G31`。`V10-M24-T05` /
         *     `ADR-0371` 限定1〜限定6)----------------------------------------------
         *
         * **一意の範囲は「1つの画面の中」だけである** —— **別の画面には同じ名札を書ける。**
         * **すぐ上の「同じフィールドIDが2つのまとまりに現れたら拒否する」(`ADR-0092`
         * 限定5)とは別の検査である** —— **上は中身(フィールドID)を、ここは名札を見る。**
         *
         * **旧形(配列そのもの)は名札を持てない**ので、数える対象に1件も入らない
         * (`ADR-0371` が足したのは新形 `{ id?, fields }` の `id` だけである)。
         * **新形でも名札を書いていないまとまりは1件も拒否しない**(名札は任意 = 限定1)。
         *
         * **path はまとまりの名前を指す** —— **上と同じ RFC 6901 のエスケープを掛ける。**
         */
        const groupAnchors = Object.entries(view.field_groups).flatMap(([groupName, group]) =>
          Array.isArray(group) || group.id === undefined
            ? []
            : [{ id: group.id, path: `${base}/field_groups/${escapePointer(groupName)}/id` }],
        );
        collectDuplicates(
          groupAnchors.map((anchor) => anchor.id),
          (index, id) => {
            const anchor = groupAnchors[index];
            if (anchor === undefined) {
              return;
            }
            errors.push({
              path: anchor.path,
              message: `ビュー "${view.id}" の項目のまとまり(field_groups)の名札 "${id}" が、同じ画面の中で重複しています。`,
              hint: "1つの画面の中では、まとまりの名札は一意である必要があります。どちらかに別の名札を付けるか、片方の名札を消してください(別の画面には同じ名札を書けます)。",
            });
          },
        );
      }

      /*
       * --- 類型14: 関連レコードの動的表示 `related`(EC-G17。ADR-0044)-----------------
       *
       * **detail_view にだけ許した子一覧の埋め込み**(schema が list_view / form では
       * related:false)。ここで検査するのは「valid なのに描画時に必ず壊れる related を
       * apply 時に倒す」ことで、類型1〜4(ビューの参照整合)の子一覧版である:
       *
       * 1. `related[].table` が実在する宣言テーブルか(`referenceableById`。子レコードは
       *    宣言テーブルの行であり、システムテーブルは reference の参照先になれない=ADR-0006 §9)。
       * 2. `related[].via` が**子テーブル上の reference 型フィールド**で、その参照先が
       *    **detail_view の対象テーブル(`view.table`)**か(単一の親参照の1ホップ。限定3)。
       *    参照先が対象テーブルと違う via は「今開いているレコードを親に持つ」を満たさず、
       *    描画時に親 id で絞れないので apply 時に倒す。
       * 3. `related[].columns` / `related[].sort.field` が子テーブルに実在するか
       *    (list_view.columns / sort.field と同型)。
       *
       * **table 不明ならその配下(via/columns/sort)はカスケードさせない**(:130-137 と同じ
       * 理由 —— 子テーブルが分からなければ「そのフィールドが在るか」は問えない)。
       */
      view.related?.forEach((rel, relIndex) => {
        const relBase = `${base}/related/${relIndex}`;
        const childTable = referenceableById.get(rel.table);
        if (childTable === undefined) {
          errors.push({
            path: `${relBase}/table`,
            message: `ビュー "${view.id}" の関連レコード一覧(related)が指す子テーブル "${rel.table}" は存在しません。`,
            allowed_values: referenceableIds,
            hint: "実在するテーブルIDを指定するか、先に add_table でテーブルを追加してください。",
          });
          return;
        }
        const childFieldIds = unique(childTable.fields.map((field) => field.id));
        // 候補は reference 型フィールドのみ(via に書けるのは参照フィールドだけ)。
        const childReferenceFieldIds = unique(
          childTable.fields.filter((field) => field.type === "reference").map((field) => field.id),
        );
        const viaField = childTable.fields.find((field) => field.id === rel.via);
        if (viaField === undefined) {
          errors.push({
            path: `${relBase}/via`,
            message:
              `ビュー "${view.id}" の関連レコード一覧(related)の via "${rel.via}" は、` +
              `子テーブル "${rel.table}" に存在しません。via には、今開いているレコードを指す ` +
              `reference 型フィールドを指定します。`,
            allowed_values: childReferenceFieldIds,
            hint: `子テーブル "${rel.table}" に実在する reference 型フィールドIDを指定するか、先に add_field で追加してください。`,
          });
        } else if (viaField.type !== "reference") {
          errors.push({
            path: `${relBase}/via`,
            message:
              `ビュー "${view.id}" の関連レコード一覧(related)の via "${rel.via}"` +
              `(子テーブル "${rel.table}")は ${viaField.type} 型で、reference 型ではありません。` +
              `via には、今開いているレコードを親として指す reference 型フィールドだけを書けます(単一の親参照の1ホップ)。`,
            allowed_values: childReferenceFieldIds,
            hint: `reference 型フィールドを指してください(その参照先が detail_view の対象テーブル "${view.table}" であること)。`,
          });
        } else if (viaField.reference_table !== view.table) {
          errors.push({
            path: `${relBase}/via`,
            message:
              `ビュー "${view.id}" の関連レコード一覧(related)の via "${rel.via}" は ` +
              `テーブル "${viaField.reference_table}" を参照していますが、この detail_view の対象テーブルは ` +
              `"${view.table}" です。via は「今開いているレコード(対象テーブルの行)を親として指す」` +
              `reference でなければならず、参照先が対象テーブルと一致する必要があります。`,
            allowed_values: childReferenceFieldIds,
            hint: `参照先が対象テーブル "${view.table}" である reference 型フィールドを via に指定してください。`,
          });
        }
        // columns: 子テーブルのフィールドが実在するか(list_view.columns と同型)。
        rel.columns.forEach((columnId, columnIndex) => {
          if (!childFieldIds.includes(columnId)) {
            errors.push({
              path: `${relBase}/columns/${columnIndex}`,
              message: `ビュー "${view.id}" の関連レコード一覧(related)の表示列 "${columnId}" は、子テーブル "${rel.table}" に存在しません。`,
              allowed_values: childFieldIds,
              hint: `子テーブル "${rel.table}" に実在するフィールドIDを指定するか、先に add_field で追加してください。`,
            });
          }
        });
        // sort: 子テーブルのフィールドが実在するか(list_view.sort と同型。単数/配列は normalizeSort)。
        normalizeSort(rel.sort).forEach((key, index) => {
          if (!childFieldIds.includes(key.field)) {
            errors.push({
              path: `${relBase}${sortErrorPath(rel.sort, index)}/field`,
              message: `ビュー "${view.id}" の関連レコード一覧(related)の並び順 "${key.field}" は、子テーブル "${rel.table}" に存在しません。`,
              allowed_values: childFieldIds,
              hint: `子テーブル "${rel.table}" に実在するフィールドIDを指定してください。`,
            });
          }
        });
      });

      /*
       * --- 類型5(補遺): 関連一覧の名札の重複(`CM-G31`。`V10-M24-T05` /
       *     `ADR-0371` 限定1〜限定6)------------------------------------------------
       *
       * **一意の範囲は「1つの画面の中」だけである** —— **別の画面には同じ名札を書ける。**
       * **重複は JSON Schema では表せない**(`uniqueItems` はオブジェクト全体の同値でしか
       * 効かないので、`columns` が1つ違えば同じ名札の子一覧を2本通してしまう)。
       *
       * **名札を書いていない子一覧は1件も拒否しない**(名札は任意 = `ADR-0371` 限定1)。
       * **添字は元の `related` の添字のままである**(名札の無い要素で詰めない)。
       *
       * **描画は名札を1度も読まない** —— **画面に出る文字は `name` であって
       * `id` ではない。**
       */
      const relatedAnchors = (view.related ?? []).flatMap((rel, relIndex) =>
        rel.id === undefined ? [] : [{ id: rel.id, path: `${base}/related/${relIndex}/id` }],
      );
      collectDuplicates(
        relatedAnchors.map((anchor) => anchor.id),
        (index, id) => {
          const anchor = relatedAnchors[index];
          if (anchor === undefined) {
            return;
          }
          errors.push({
            path: anchor.path,
            message: `ビュー "${view.id}" の関連レコード一覧(related)の名札 "${id}" が、同じ画面の中で重複しています。`,
            hint: "1つの画面の中では、関連一覧の名札は一意である必要があります。どちらかに別の名札を付けるか、片方の名札を消してください(別の画面には同じ名札を書けます)。",
          });
        },
      );
    }

    /*
     * **【V5-M21-T01 / `L-G1` / `ADR-0171` 限定1〜限定12 で移した】** 上のコメントの
     * 「**detail_view にだけ許した操作起点**」は**今日から偽である** —— **`ADR-0171`
     * (門A / 判定 = 限定採用)が `allOf` の `list_view` 分岐の `"actions": false,` を
     * 解いた。****旧文を1バイトも消していない。**
     *
     * **この検査は `detail_view` 分岐の中に在ったが、`list_view` にも当てるために
     * `if / else` の外へ出した。** **判定を2箇所に住まわせない** —— **同じ検査を
     * `list_view` 側にもう1本書くと、片方だけが更新される日が必ず来る。**
     * **検査の中身は1バイトも変えていない**(唯一の例外は下記のメッセージ1本である)。
     *
     * **メッセージの語だけ直した**: 「この detail_view の対象テーブル」→
     * 「この画面の対象テーブル」。**一覧にも当たるようになったので、`detail_view` と
     * 書いたままだと嘘になる**(`set` 形のメッセージが着手前から使っていた語に揃えた)。
     * **他のメッセージは1文字も変えていない。**
     *
     * **`form` には今日も `actions` を書けない**(限定3)ので、`"actions" in view` は
     * `list_view` / `detail_view` のどちらかを指す。**`form` 分岐の `false` は1バイトも
     * 解いていない。**
     */
    if ("actions" in view) {
      /*
       * --- 類型15: ビューからの操作起点 `actions`(EC-G14。ADR-0045)-----------------
       *
       * **detail_view にだけ許した操作起点**(schema が list_view / form では actions:false)。
       * 「指定 form へ遷移し、参照フィールド1つを今開いているレコードの `_id` でプリフィルする」
       * 最小形。ここで検査するのは「valid なのに遷移/作成時に必ず壊れる actions を apply 時に
       * 倒す」ことで、related(類型14)と同型のビュー参照整合である:
       *
       * 1. `actions[].form` が実在する **form 型ビュー**か(遷移先はフォームであり、list_view /
       *    detail_view を指せない —— そこへ「参照フィールドをプリフィルして開く」は成立しない)。
       * 2. `actions[].prefill.field` が **遷移先 form の対象テーブル上の reference 型フィールド**で、
       *    その参照先が **detail_view の対象テーブル(`view.table`)**か。プリフィル値は今開いている
       *    レコード(対象テーブルの行)の `_id` なので、参照先が対象テーブルでない参照フィールドに
       *    入れると作成時に必ず dangling reference になる(限定2/3。related の via と同型の検査)。
       *
       * **form 不明ならその配下(prefill.field)はカスケードさせない**(:130-137 と同じ理由 ——
       * 遷移先 form の対象テーブルが分からなければ「そのフィールドが在るか」は問えない)。
       */
      const formViewIds = unique(
        views.filter((candidate) => candidate.type === "form").map((candidate) => candidate.id),
      );
      /*
       * --- 類型15(補遺): ボタンの識別子の重複(`V8-M17`。台帳 `J-G9`)---------------
       *
       * **一意なのは同じ画面の中だけである** —— **別の画面には同じ識別子を書ける**
       * (だから役割の規則の側は `view` と `action` の2つで名指しする)。
       * **`uniqueItems` では表せない** —— **`{"id":"go","name":"進む"}` と
       * `{"id":"go","name":"次へ"}` はオブジェクトとしては別物だからである**
       * (`roles[].id` / `access_control.permissions[].id` と同じ穴。同じ形で塞ぐ)。
       * **識別子を書いていないボタンは1件も数えない** —— **任意のキーであり、
       * 書かなかったボタンは役割の規則から名指しできないだけである。**
       */
      const declaredActionIds = (view.actions ?? []).map((act) => (act as { id?: ResourceId }).id);
      declaredActionIds.forEach((actionId, actIndex) => {
        // **最初の出現を正とする**(`collectDuplicates` と同じ規約。ただし識別子を
        // 書いていないボタンが間に挟まっても位置がずれないよう、元の添字で報告する)。
        if (actionId === undefined || declaredActionIds.indexOf(actionId) === actIndex) {
          return;
        }
        errors.push({
          path: `${base}/actions/${actIndex}/id`,
          message: `ビュー "${view.id}" のボタンの識別子 "${actionId}" が重複しています。同じ画面の中で同じ識別子を2度書くことはできません。`,
          hint: "どちらかのボタンに別の識別子を付けるか、片方の id を消してください(別の画面であれば同じ識別子を書けます)。",
        });
      });
      view.actions?.forEach((act, actIndex) => {
        const actBase = `${base}/actions/${actIndex}`;
        /*
         * --- 表示条件 `visible_when`(`V4-M20-T02`。ADR-0101 限定3)------------------
         *
         * **判定の対象は「今開いているレコードの値」だけである** —— したがって葉の `field`
         * は**この画面の対象テーブル**に実在しなければならない。実在しない列を指す条件は
         * **毎回必ず偽になり、ボタンが永久に出ない**ので、適用時に倒してよい
         * (`view.filter` の葉と同型の検査。**新しい検査の種類を1つも作っていない**)。
         *
         * **値の型は見ない** —— `view.filter` の葉も今日フィールドの実在だけを見ており
         * (`filterFieldRefs`)、**そこと非対称にしない。**
         * **形 (i) / 形 (ii) のどちらにも同じ検査が当たる**(条件は形に依らない)。
         */
        if (act.visible_when !== undefined && !knownField(act.visible_when.field)) {
          missingField(
            `${actBase}/visible_when/field`,
            act.visible_when.field,
            `ビュー "${view.id}" の操作起点(actions)の表示条件(visible_when)`,
          );
        }
        /*
         * --- 形 (iii): 行き先の宣言(`V5-M22-T02`。`L-G5` / `ADR-0173` 限定3)---------
         *
         * **「書けるが効かない組み合わせ」を1つも作らない**(`ADR-0086` 限定4)。schema は
         * 「ビューID 1つ」までしか固定できないので、
         *
         *   1. `view` が**この差分が作るマニフェストのビュー**として実在するか
         *   2. その型が `list_view` / `detail_view` のいずれかか(`form` は指せない)
         *
         * を apply 時に倒す。**外部 URL・別アプリのID・相対指定は `$defs/resource_id` の形で
         * 構造的に書けない**ので、ここでは見ない(schema が既に倒している)。
         *
         * **`form` を指せない理由は、遷移形(形 (i))が担う領分だからである** ——
         * 「参照フィールドをプリフィルして form を開く」は形 (i) が既に持っており、
         * **同じ行き先へ2つの形が並ぶと、書き手はどちらを書けばよいか判断できない。**
         *
         * **3形目は `list_view` にしか書けない**(`L-G7` = 却下。`detail_view` 分岐が
         * `items.properties.view: false` で閉じている)。**ここはその判定を持たない** ——
         * **型ごとの可否は schema の1箇所が決め、参照整合はこの1箇所が決める。**
         * **判定を2箇所に住まわせない。**
         *
         * **行き先の画面が見えない相手に何が起きるかは、ここでは1バイトも見ない**
         * (`ADR-0173` §限界3)—— **それは表示層の問題であり、`web/src/navigation.tsx` の
         * `resolveActionDestination` が決める。**
         * **【`V8-M20` による書き直し】着手前の逐語は「行き先が `audience` で見えない相手」
         * だった。****そのキーは今日は存在しない**(廃止は `V8-M20`。台帳 `J-G27`)——
         * **見える相手を決めるのは `app.roles[].rules` の「役割 × 対象(画面)× 読取」である。**
         */
        if ("view" in act) {
          const destination = views.find((candidate) => candidate.id === act.view);
          const linkableIds = unique(
            views
              .filter(
                (candidate) => candidate.type === "list_view" || candidate.type === "detail_view",
              )
              .map((candidate) => candidate.id),
          );
          if (destination === undefined) {
            errors.push({
              path: `${actBase}/view`,
              message: `ビュー "${view.id}" の操作起点(actions)の行き先 "${act.view}" は存在しません。`,
              allowed_values: linkableIds,
              hint: "同じアプリに実在する一覧(list_view)か詳細(detail_view)のビューIDを指定するか、先に add_view で追加してください。",
            });
          } else if (destination.type !== "list_view" && destination.type !== "detail_view") {
            errors.push({
              path: `${actBase}/view`,
              message:
                `ビュー "${view.id}" の操作起点(actions)の行き先 "${act.view}" は ` +
                `${destination.type} です。行き先にできるのは一覧(list_view)と詳細(detail_view)だけです` +
                `(入力フォームへ進む操作起点は form + prefill の形で書きます)。`,
              allowed_values: linkableIds,
              hint: "一覧か詳細のビューIDを指定してください。入力フォームへ進みたい場合は form と prefill を書いてください。",
            });
          }
          // **形 (iii) は form へも set へも進まない。** 下の検査へは1ミリも進まない。
          return;
        }
        /*
         * --- 形 (iv): 自動処理の起動(`V5-M25-T01`。`L-G8` / `ADR-0174` 限定2 / 限定5)---
         *
         * **「書けるが必ず失敗する導線」を1つも作らない**(`ADR-0086` 限定4)。schema は
         * 「ワークフローID 1つ」までしか固定できないので、
         *
         *   1. `run` が**この差分が作るマニフェストのワークフロー**として実在するか
         *   2. その `trigger.type` が `manual` か(限定2。既存の3種は手動で起こせない)
         *   3. その `trigger.table` が**この画面の対象テーブル**と一致するか
         *      (押した行はこの画面の行なので、違う表を対象にしたワークフローは
         *       必ず `$record.` の解決に失敗する)
         *   4. **外部への送信を含まないか**(限定5。`call_external` / `ai_transform` /
         *      capability を宣言した関数の `run_function`)
         *
         * を apply 時に倒す。**4は `ADR-0021` のアウトボックス(1回だけ送る)に1バイトも
         * 触らないための限定であり、ここが唯一の機械的な担保である。**
         *
         * **島の起動口はここにも1本も無い**(限定7。`L-G9` = 将来送り)——
         * `run` が指せるのはワークフローであって関数ではない。
         */
        if ("run" in act) {
          const manualIds = unique(
            workflows
              .filter((candidate) => candidate.trigger.type === "manual")
              .map((candidate) => candidate.id),
          );
          const target = workflows.find((candidate) => candidate.id === act.run);
          if (target === undefined) {
            errors.push({
              path: `${actBase}/run`,
              message: `ビュー "${view.id}" の操作起点(actions)が起こそうとしている自動処理 "${act.run}" は存在しません。`,
              allowed_values: manualIds,
              hint: "同じアプリに実在し、発火条件が manual のワークフローIDを指定するか、先に add_workflow で追加してください。",
            });
          } else if (target.trigger.type !== "manual") {
            errors.push({
              path: `${actBase}/run`,
              message:
                `ビュー "${view.id}" の操作起点(actions)が起こそうとしている自動処理 "${act.run}" の` +
                `発火条件は "${target.trigger.type}" です。画面のボタンから起こせるのは、` +
                `発火条件に manual と書いた自動処理だけです。`,
              allowed_values: manualIds,
              hint: "その自動処理の trigger.type を manual にするか、manual の自動処理を指定してください(既存の on_create / on_update / schedule を手動で起こすことはできません)。",
            });
          } else if (target.trigger.table !== view.table) {
            errors.push({
              path: `${actBase}/run`,
              message:
                `ビュー "${view.id}"(対象テーブル "${view.table}")の操作起点(actions)が起こそうとしている` +
                `自動処理 "${act.run}" の対象テーブルは "${target.trigger.table}" です。` +
                `押した行を渡せないので、この組み合わせは動きません。`,
              hint: "画面の対象テーブルと、自動処理の trigger.table を揃えてください。",
            });
          }
          // **限定5(外部送信を含むワークフローは `manual` にできない)はここでは見ない** ——
          // **見るのは下のワークフローの走査である。** **画面から指されていなくても
          // `manual` と宣言した時点で倒す**(判定を2箇所に住まわせない)。
          // **形 (iv) は form へも set へも view へも進まない。**
          return;
        }
        /*
         * --- 形 (ii): 値の書換(`V4-M20-T01`。ADR-0100 限定7)-----------------------
         *
         * **「書けるが効かない組み合わせ」を1つも作らない**(`ADR-0086` 限定4)。schema は
         * 「フィールドID1つ × リテラル値1つ」までしか固定できないので、
         *
         *   1. `set.field` が**この detail_view の対象テーブル**に実在するか
         *   2. `set.value` の JS 型が、そのフィールドの型と一致するか
         *   3. `select` なら `options` に在る値か / `date` なら ISO8601 か
         *
         * を apply 時に倒す。**値はリテラル1つで静的に確定するので、合わない値は押すたびに
         * 必ず書込で弾かれる** —— per-record に変わる余地が無いぶん、ワークフローの値の検査
         * (類型13。`date` / `select` を実行時に委ねる)より一段強く倒せる。
         *
         * **書込の権限と CAS はここでは見ない**(限定6)——
         * それらは押下時にサーバの既存経路が判定するものであり、宣言の整合性ではない。
         * **【`V8-M20` による書き直し】着手前の逐語は「書込の権限(`writable_by` / ロール)」
         * だった。****`writable_by` は今日は存在しない**(廃止は `V8-M20`。台帳 `J-G28`)——
         * **書ける相手を決めるのは `app.roles[].rules` の「役割 × 対象(項目)× 書込」だけで
         * ある。ここで見ないという結論は今日も同じである。**
         */
        if ("set" in act) {
          const setBase = `${actBase}/set`;
          const target = table.fields.find((field) => field.id === act.set.field);
          if (target === undefined) {
            errors.push({
              path: `${setBase}/field`,
              message:
                `ビュー "${view.id}" の操作起点(actions)が書き換えようとしているフィールド ` +
                `"${act.set.field}" は、この画面の対象テーブル "${table.id}" に存在しません。`,
              allowed_values: fieldIds,
              hint: `対象テーブル "${table.id}" に実在するフィールドIDを指定するか、先に add_field で追加してください。`,
            });
            return;
          }
          const valueJsType = typeof act.set.value as "string" | "number" | "boolean";
          const destJsType = fieldTypeToJsType(target.type);
          if (valueJsType !== destJsType) {
            errors.push({
              path: `${setBase}/value`,
              message:
                `ビュー "${view.id}" の操作起点(actions)が "${target.id}" に書こうとしている値 ` +
                `${JSON.stringify(act.set.value)} は ${JS_TYPE_LABEL[valueJsType]}型ですが、` +
                `書き込み先のフィールド "${target.id}"(テーブル "${table.id}")は ${target.type} 型` +
                `(${JS_TYPE_LABEL[destJsType]})です。型が合わないので、このボタンは押しても毎回` +
                `書き込みで弾かれ、1件も書けません(適用時に拒否します)。`,
              hint:
                `型を揃えてください。値のほうを ${target.type} 型に合わせるか、` +
                `書き込み先のフィールドの型を変えてください。` +
                `値を引用符で囲んで文字列にしても直りません(型の合わない値は書込時に必ず弾かれます)。`,
            });
          } else if (
            target.type === "select" &&
            !target.options.includes(act.set.value as string)
          ) {
            errors.push({
              path: `${setBase}/value`,
              message:
                `ビュー "${view.id}" の操作起点(actions)が "${target.id}" に書こうとしている値 ` +
                `${JSON.stringify(act.set.value)} は、そのフィールドの選択肢にありません。`,
              allowed_values: [...target.options],
              hint: "選択肢にある値を指定するか、先に change_field で選択肢そのものを追加してください。",
            });
            /*
             * **ISO8601 の判定を書き写さない。** `convertValue` を「同じ型どうし」
             * (`date` → `date` = 対角セル。`conversionVerdict` は `possible`)で呼ぶと、
             * `date` 分岐の `isIso8601` がそのまま当たる —— **同じ判定を2箇所に書かない**
             * (`records.ts` の `isValidIso8601` は export されておらず、`src/kernel/` の
             * 公開 export を1本も増やさないため、そちらは呼べない)。
             */
          } else if (target.type === "date" && !convertValue(act.set.value, target, target).ok) {
            errors.push({
              path: `${setBase}/value`,
              message:
                `ビュー "${view.id}" の操作起点(actions)が "${target.id}" に書こうとしている値 ` +
                `${JSON.stringify(act.set.value)} は ISO8601 形式の日付ではありません。`,
              hint: "YYYY-MM-DD もしくは YYYY-MM-DDThh:mm:ssZ の形式で、実在する日付を指定してください。",
            });
          }
          // **形 (ii) は遷移しない。** 遷移先 form の検査(下)へは1ミリも進まない。
          return;
        }
        const formView = views.find((candidate) => candidate.id === act.form);
        if (formView === undefined) {
          errors.push({
            path: `${actBase}/form`,
            message: `ビュー "${view.id}" の操作起点(actions)の遷移先 form "${act.form}" は存在しません。`,
            allowed_values: formViewIds,
            hint: "実在する form ビューのIDを指定するか、先に add_view で form を追加してください。",
          });
          return;
        }
        if (formView.type !== "form") {
          errors.push({
            path: `${actBase}/form`,
            message:
              `ビュー "${view.id}" の操作起点(actions)の遷移先 "${act.form}" は ${formView.type} で、` +
              `form ではありません。操作起点が遷移できるのは form(作成画面)だけです` +
              `(参照フィールドをプリフィルして開くため)。`,
            allowed_values: formViewIds,
            hint: "遷移先には form 型のビューIDを指定してください。",
          });
          return;
        }
        // 遷移先 form の対象テーブル(form はシステムテーブルを対象にできない=L2 が別途担保)。
        const formTable = referenceableById.get(formView.table);
        if (formTable === undefined) {
          // form ビュー自身の table 不在は類型1 が既に報告済み。二重に出さない。
          return;
        }
        // 候補は reference 型フィールドのみ(prefill.field に書けるのは参照フィールドだけ)。
        const formReferenceFieldIds = unique(
          formTable.fields.filter((field) => field.type === "reference").map((field) => field.id),
        );
        const pfField = formTable.fields.find((field) => field.id === act.prefill.field);
        if (pfField === undefined) {
          errors.push({
            path: `${actBase}/prefill/field`,
            message:
              `ビュー "${view.id}" の操作起点(actions)の prefill.field "${act.prefill.field}" は、` +
              `遷移先 form "${act.form}" の対象テーブル "${formTable.id}" に存在しません。` +
              `プリフィルできるのは、今開いているレコードの _id を入れる reference 型フィールドです。`,
            allowed_values: formReferenceFieldIds,
            hint: `遷移先 form の対象テーブル "${formTable.id}" に実在する reference 型フィールドIDを指定するか、先に add_field で追加してください。`,
          });
        } else if (pfField.type !== "reference") {
          errors.push({
            path: `${actBase}/prefill/field`,
            message:
              `ビュー "${view.id}" の操作起点(actions)の prefill.field "${act.prefill.field}"` +
              `(遷移先 form "${act.form}" の対象テーブル "${formTable.id}")は ${pfField.type} 型で、` +
              `reference 型ではありません。プリフィルは今開いているレコードの _id を入れるので、` +
              `reference 型フィールドだけを指せます。`,
            allowed_values: formReferenceFieldIds,
            hint: `reference 型フィールドを指してください(その参照先が detail_view の対象テーブル "${view.table}" であること)。`,
          });
        } else if (pfField.reference_table !== view.table) {
          errors.push({
            path: `${actBase}/prefill/field`,
            message:
              `ビュー "${view.id}" の操作起点(actions)の prefill.field "${act.prefill.field}" は ` +
              `テーブル "${pfField.reference_table}" を参照していますが、この画面の対象テーブルは ` +
              `"${view.table}" です。プリフィルは今開いているレコード(対象テーブルの行)の _id を入れるので、` +
              `参照先が対象テーブルと一致する reference フィールドでなければなりません。`,
            allowed_values: formReferenceFieldIds,
            hint: `参照先が対象テーブル "${view.table}" である reference 型フィールドを prefill.field に指定してください。`,
          });
        }
      });
    }
  });

  /*
   * --- 類型6: ワークフローが指すテーブルが実在するか(ADR-0013 §1a / §8b) -----
   *
   * **ここが ADR-0013 の U6 却下の根拠そのものである。**§8b はこう書いている:
   *
   *   `app.workflows` を `referential-integrity.ts` の走査対象に加えると、存在しない
   *   テーブルを指すワークフローは `apply_diff` の時点で拒否される。したがって
   *   **「動くワークフローが存在する ⇒ そのワークフローが指すテーブルが存在する」**が
   *   カーネルで保証される。**プラットフォームが作る必要が無い。**
   *
   * この走査を落とすと、「組み込みのユーザランドテーブル」という区分を作らずに
   * 出力先テーブルの存在を保証する、という却下の理由が実装上で崩れる。
   *
   * ## 使う集合は `referenceableIds` / `referenceableById` である
   *
   * **`viewTargetIds` / `viewTargetById` を使ってはならない。**ADR-0013 限定10 が
   * 「ワークフローはシステムテーブルを対象にできない」と定めており、実際に
   * `schemas/manifest.schema.json` のワークフロー3参照は `$defs/resource_id`
   * (`_` 始まりを拒否する方)を指していて、`$defs/view_table_id`
   * (システムテーブルを許す方)を1つも使っていない。
   *
   * ビューは `viewTargetIds` でよい —— `_apps` を `list_view` で画面に出せるからで、
   * 候補から隠すと発見可能性を潰す。**ワークフローは違う。**ここで
   * `viewTargetIds` を使うと :39-58 のコメントが警告している方の失敗
   * ——「参照候補にシステムテーブルが漏れる = **エラーメッセージが閉まっている裏口を
   * 宣伝する**」—— をそのまま踏む。AI は候補一覧を信じて `_apps` を書き直し、
   * スキーマにまた弾かれ、自己修正のループから抜けられない。
   */

  // --- 類型5(補遺): ワークフローIDの重複 -----------------------------------
  // テーブル(:28-37)・ビュー(:107-116)が両方持っているものを、ワークフローだけ
  // 持たないのは不整合である。`collectDuplicates` をそのまま再利用する。
  collectDuplicates(
    workflows.map((workflow) => workflow.id),
    (index, id) => {
      errors.push({
        path: `/app/workflows/${index}/id`,
        message: `ワークフローID "${id}" が重複しています。ワークフローIDはアプリ内で一意である必要があります。`,
        hint: "どちらかのワークフローに別のIDを付けてください。",
      });
    },
  );

  // run_function アクションの参照先候補(ADR-0024。関数IDは app.functions の宣言に実在すること)。
  // **workflows の走査より前に用意する** —— run_function の `function` 参照をここで突き合わせる。
  const functionIds = unique(functions.map((fn) => fn.id));

  workflows.forEach((workflow, workflowIndex) => {
    const base = `/app/workflows/${workflowIndex}`;

    const missingTable = (path: string, tableId: ResourceId, label: string): void => {
      errors.push({
        path,
        message: `ワークフロー "${workflow.id}" の${label}に指定されたテーブル "${tableId}" は存在しません。`,
        allowed_values: referenceableIds,
        hint: "実在するテーブルIDを指定するか、先に add_table でテーブルを追加してください。システムテーブル(_apps / _changelog)はワークフローの対象にできません。",
      });
    };

    /*
     * **カスケードは抑止しない。**
     *
     * ビュー(:130-132)は `view.table` が不明ならその配下(columns/fields/sort/filter)を
     * スキップする —— **配下の検証が table に依存している**からで、テーブルが分からない
     * 以上「そのフィールドが在るか」は問えず、意味のないエラーが増えるだけである。
     *
     * ワークフローの3参照はそうではない。`trigger.table`・`actions[].table`・
     * `history_table` は**互いに独立にテーブル集合と突き合わせられる。**片方が不明でも
     * 残りの検査は意味を持つし、全件返せば AI は1往復で全部直せる(:12-17 の設計方針)。
     * よってここでは `return` せず、3種すべてを最後まで走査する。
     */

    /*
     * 1. trigger.table
     *
     * **`schedule` の `table` は任意である**(`D-G16a` / ADR-0063)。書いていなければ
     * 従来どおり対象外、書いてあれば `on_create` / `on_update` と**まったく同じ**
     * 実在検査に掛ける —— 行を列挙する対象なので、実在しなければ発火のたびに読めない。
     */
    if (workflow.trigger.table !== undefined && !referenceableById.has(workflow.trigger.table)) {
      missingTable(`${base}/trigger/table`, workflow.trigger.table, "発火条件(trigger.table)");
    }

    /*
     * 1b. **`manual` は外部へ送る動作を1つも含めない**(`V5-M25-T01` / `ADR-0174` 限定5)。
     *
     * **これが `ADR-0021` のアウトボックス(1回だけ送る)に1バイトも触らないための
     * 唯一の機械的な担保である**(`ADR-0100:115` の警告への対処)。
     *
     * **倒すのは3種**:
     *  - `call_external`(接続を使う外部呼び出し。`ADR-0020`)
     *  - `ai_transform`(AI capability。`ADR-0021`)
     *  - **capability を宣言した関数の `run_function`**(島の中から扉が生える。`ADR-0023`)
     *
     * **capability を1つも宣言していない関数の `run_function` は通る** ——
     * **島そのものは外部に到達しない**(`ADR-0023` B1 = アンビエント権限ゼロ)。
     * **`L-G9`(行のボタンから島を起こす)が「追加の増分0」で満たされるのは、この経路である**
     * (`v5-m20.md` §2 の逐語「行のボタン → `manual` のワークフロー → `run_function` → 島」)。
     * **島の起動口を1本も作っていないことと矛盾しない** —— **起きるのはワークフロー経由だけである。**
     *
     * **画面から指されているかは1バイトも見ない** —— **`manual` と宣言した時点で倒す。**
     */
    if (workflow.trigger.type === "manual") {
      workflow.actions.forEach((action, actionIndex) => {
        const reason =
          action.action === "call_external"
            ? `外部への呼び出し(call_external。接続 "${action.connection}")`
            : action.action === "ai_transform"
              ? `AI への送信(ai_transform。capability "${action.capability}")`
              : action.action === "run_function" &&
                  (functions.find((fn) => fn.id === action.function)?.capabilities ?? []).length > 0
                ? `外部へ届く扉を宣言した関数の実行(run_function。関数 "${action.function}")`
                : undefined;
        if (reason !== undefined) {
          errors.push({
            path: `${base}/actions/${actionIndex}`,
            message:
              `ワークフロー "${workflow.id}" の ${actionIndex + 1} 番目の動作は${reason}です。` +
              `外部へ送る動作を含むワークフローは、発火条件を manual にできません` +
              `(画面のボタンから起こせません)。`,
            hint: "外部へ送る動作は on_create / on_update / schedule のいずれかで起こしてください。手動で起こしたい部分だけを別のワークフローに分けることもできます。",
          });
        }
      });
    }

    // 2. actions[].table(**配列なので全要素**)
    //    **`call_external` は内部の書き込み先テーブルを持たない**(宛先は connection の
    //    スコープ内の URL で、実行時に runAction が照合する。ADR-0020 §3)。対象外にする。
    //    **`ai_transform` も同様に内部の書き込み先 `table` を持たない**(書き戻し先は
    //    トリガー元テーブルの `output_field` で、実行時に runAiTransform が照合する。ADR-0021 §3)。
    //    **`run_function` は `table` の代わりに `function`(関数リソース)と `output_table`
    //    (出力の書き込み先)を持つ**(ADR-0024)。両方を独立に検査する(下の run_function 分岐)。
    workflow.actions.forEach((action, actionIndex) => {
      if (action.action === "call_external" || action.action === "ai_transform") {
        return;
      }
      const actionBase = `${base}/actions/${actionIndex}`;
      if (action.action === "run_function") {
        // 類型9 と同型: function は app.functions に実在、output_table は実在する宣言テーブル
        // (システムテーブル不可。ADR-0024 限定7)。参照先が独立なので両方を最後まで検査する。
        if (!functionIds.includes(action.function)) {
          errors.push({
            path: `${actionBase}/function`,
            message: `ワークフロー "${workflow.id}" の run_function が起動する関数 "${action.function}" は存在しません。`,
            allowed_values: functionIds,
            hint: "実在する関数IDを指定するか、先に add_function で関数を追加してください。",
          });
        }
        // output_table は write_back モード(ADR-0037)では持たない(排他)。
        // 持つとき(全置換モード)だけ実在テーブルかを検査する。
        if (action.output_table !== undefined && !referenceableById.has(action.output_table)) {
          missingTable(
            `${actionBase}/output_table`,
            action.output_table,
            `run_function の出力先(actions[${actionIndex}].output_table)`,
          );
        }
        return;
      }
      if (!referenceableById.has(action.table)) {
        missingTable(
          `${actionBase}/table`,
          action.table,
          `アクションの書き込み先(actions[${actionIndex}].table)`,
        );
      }
    });

    // 3. history_table(実行履歴の出力先。ユーザが add_table で作る通常のテーブル。限定8)
    const historyTable = referenceableById.get(workflow.history_table);
    if (historyTable === undefined) {
      missingTable(
        `${base}/history_table`,
        workflow.history_table,
        "実行履歴の出力先(history_table)",
      );
    } else {
      /*
       * --- 類型8: history_table の**列構成**の検査(V1-M2-T05a D1)---------------
       *
       * **テーブルが実在することだけでは足りない、と実地で証明された。**
       * V1-M2-T05 のヘッドレス実地検証(証跡 `docs/evidence/cp-v1-2/transcripts/001..003`)
       * では、**3試行すべてが履歴を1行も残せなかった。**AI が作った履歴テーブルの列は
       * 001 が `memo` の1列、002 が `note` の1列、003 が6列中2列一致 —— そして
       * **3試行とも差分は受理された。**ここが「実在するか」しか見ていなかったからである。
       *
       * ## なぜ実行時ではなく適用時なのか
       *
       * ADR-0013 §8c 問2 は「ワークフローが書く列が存在しない場合、実行を失敗として
       * **履歴に残す**」と約束していた。**その約束は実装されていなかった** ——
       * `writeHistory` の失敗は `historyFailureHandler` に渡るが、その既定実装
       * (`workflow-runner.ts` の `defaultHistoryFailureHandler`)は `console.error` するだけで、
       * `setWorkflowHistoryFailureHandler` は `src/mcp/` から一度も呼ばれない。
       * **MCP の応答は成功に見える。**
       *
       * さらに根本的な問題として、**失敗を書く先が壊れている当の履歴テーブルである。**
       * 「実行の失敗を履歴に残す」は、履歴が書けないという失敗に対しては原理的に効かない。
       * よって**壊れたワークフローがそもそも作れないようにする**方へ倒した ——
       * `schedule` × `$record.`(類型7)を適用時に倒したのと同じ判断である。
       * AI はエラーを読んで1往復で直せる。
       *
       * ## 「ちょうど5列」ではなく「少なくとも5列が正しい型で在ること」
       *
       * ADR-0013 §8c 問2 は **`add_field` で列を足せる**と明示的に判定している
       * (reference 型で対象レコードを指す列など。ワークフローはその列を空のまま書く)。
       * 完全一致で検査すると **ADR の判定と矛盾する**ので、余分な列は許す。
       * **並び順も問わない** —— 規約は「id と type の5組」であって順序ではない。
       *
       * ## 型まで検査するのはなぜか
       *
       * `src/mcp/vocabulary.ts` の `WORKFLOW_HISTORY_TABLE_TEMPLATE` が名指しで
       * 警告しているとおり、**`status` / `trigger_type` に `select` を使うのが最悪の形**
       * である —— `failure` を書こうとして `options` 不一致で弾かれ、
       * **最も知りたい1行だけが消える。**「列が在る」だけを見る検査はこれを素通しする。
       *
       * `remove_field` で後から列を消す経路も、**適用後のマニフェスト全体を検査する
       * この層を必ず通る**ので同じ検査が掛かる(`workflow-referential-integrity.test.ts`
       * の `apply_diff` 実経路テストで確認済み)。
       */
      const historyFieldTypeById = new Map(
        historyTable.fields.map((field) => [field.id, field.type]),
      );
      const historyProblems = WORKFLOW_HISTORY_FIELD_SPEC.filter(
        ([id, type]) => historyFieldTypeById.get(id) !== type,
      ).map(([id, type]) => {
        const actual = historyFieldTypeById.get(id);
        return actual === undefined
          ? `"${id}"(${type} 型)がありません`
          : `"${id}" は ${type} 型でなければなりませんが ${actual} 型になっています`;
      });
      if (historyProblems.length > 0) {
        errors.push({
          path: `${base}/history_table`,
          message:
            `ワークフロー "${workflow.id}" の実行履歴の出力先 "${workflow.history_table}" は、` +
            `実行履歴テーブルの列の規約を満たしていません: ${historyProblems.join("、")}。` +
            `この形のままでは、ワークフローは発火しても実行履歴が1行も残りません` +
            `(履歴の書き込みは all-or-nothing です)。`,
          /*
           * **`allowed_values` は付けない。**候補が有限の「不在ID」ではないからである
           * (:15 の作法の適用範囲は不在ID系。類型7 の判断と同じ)。
           * 代わりに**正しい形そのもの**を hint に書く —— AI がこれを読んで直せなければ
           * 検査を足した意味が無い(T05 で「string を指定してください」が
           * 罠へ誘導したのと同じ失敗を繰り返さない)。
           */
          hint:
            `テーブル "${workflow.history_table}" が次の5つのフィールドを持つようにしてください` +
            `(id と type がこのとおりであること。name は自由、他の列を add_field で足すのは構いません): ` +
            `${WORKFLOW_HISTORY_FIELD_SPEC.map(([id, type]) => `${id} (${type})`).join(" / ")}。` +
            `status と trigger_type に select 型を使ってはいけません —— ` +
            `options に無い値で弾かれると、その失敗の記録自体が残らなくなります。`,
        });
      }

      /*
       * --- V1-M2-T05a 追補: `error` 列に `required: true` を付けさせない ---------
       *
       * **上の id/type 検査を素通りする、同じ類型の沈黙がもう1つある。**
       * T05a の記録 §5-3 が自分で申告したものを、ここで塞ぐ。
       *
       * - `workflow-runner.ts` の `writeHistory` は成功時に `error: null` を**明示的に書く**
       * - `records.ts` の `isMissingValue` は `null` を required 違反として**弾く**
       *
       * したがって `error` 列に `required: true` が付いていると、
       * **成功した実行の履歴だけが1行も残らない。**しかも履歴の書き込みは
       * all-or-nothing なので、欠けるのは1列ではなく**その実行の記録まるごと**である。
       * 「失敗は残るのに成功が残らない履歴」は、**履歴を見た人に嘘をつく。**
       *
       * ## なぜ `error` 列だけなのか(5列に広げない)
       *
       * 他の4列には**常に非空の値が書かれる** —— `ran_at` は時刻源、`workflow` は
       * ワークフローの id、`trigger_type` と `status` はリテラルである。
       * `required: true` を付けても1行も壊れない。
       * **壊れないものまで拒否すれば、正当なマニフェストを弾く新しい嘘になる。**
       * `workflow-referential-integrity.test.ts` の「効きすぎていないこと」の
       * テストが、この逆向きを固定している。
       *
       * ## エラーは**理由**を書く
       *
       * D1 と同じ理由である —— AI がこれを読んで直せなければ、検査を足した意味が無い。
       */
      const errorField = historyTable.fields.find((field) => field.id === "error");
      if (errorField?.required === true) {
        errors.push({
          path: `${base}/history_table`,
          message:
            `ワークフロー "${workflow.id}" の実行履歴の出力先 "${workflow.history_table}" は、` +
            `"error" 列に required: true が付いています。` +
            `成功した実行では "error" が空になるので、required にすると` +
            `**成功の記録だけが1行も残らなくなります**` +
            `(履歴の書き込みは all-or-nothing なので、消えるのは1列ではなくその実行の記録全体です)。` +
            `失敗だけが残る履歴は、履歴を読んだ人に嘘をつきます。`,
          hint:
            `テーブル "${workflow.history_table}" の "error" 列から required を外してください` +
            `(required: false にするか、指定そのものを消してください)。` +
            `ran_at / workflow / trigger_type / status は常に値が書かれるので、` +
            `required: true を付けても構いません —— 空になりうるのは "error" だけです。`,
        });
      }
    }

    /*
     * --- 類型7: `schedule` トリガーのアクションに `$record.` を書かせない ---------
     * (V1-M2-T02 判断3。`docs/plan/v1/02-workflow.md` §2-2 の追補)
     *
     * **`schedule` にはトリガー元レコードが存在しない**(ADR-0013 §6。
     * `on_create` / `on_update` と違って `trigger.table` すら持たない)。
     * したがって `$record.foo` は**原理的に解決しようが無い。**
     *
     * ## なぜ実行時ではなく適用時なのか
     *
     * V1-M2-T07 は「実行時に失敗として履歴に残す」側に倒した。**T02 で覆した。**
     * 実行時に倒すと**毎日9時に失敗行が積まれ、ユーザが履歴を見るまで気づかない。**
     * 適用時に拒否すれば AI は1往復で直せる。
     *
     * T07 が「形の検査は本層の射程外」(ADR-0013 §8d)を根拠にしたのは正しいが、
     * **本件は形の検査ではない** —— フィールドの実在を1つも調べておらず、見ているのは
     * **トリガー種別とアクションの整合**だけである。§8d の射程に入らない。
     *
     * ## 判定規則は `workflow-runner.ts` の解決器(`:448` `resolveValue`)と揃えてある
     *
     * **【行番号の訂正。V1-M2-T03 で追記】** ここは長らく `:291` を指していたが、
     * **T02 の時点で既に実位置は `:304` であり、引用は嘘になっていた。**T03 が
     * `WORKFLOW_MAX_DEPTH` と再発火抑止を足してさらにずれたので、実位置に直した。
     * **行番号の引用は編集のたびに腐る。**関数名(`resolveValue`)を併記してあるので、
     * 番号がずれていたら名前で引き直すこと。
     *
     * `"$record."` で**始まるか**だけを見る。限定12 により書ける形は
     * `$record.<フィールドID>` の1形しか無く(スキーマが他を既に拒否している)、
     * 前方一致で過不足ない。**実行時の解決器は消していない** —— MCP 経由以外の
     * 経路でマニフェストが入る余地がある以上、防御は二重に置く。
     *
     * **`on_create` / `on_update` は対象外である。**巻き添えで拒否してはならない。
     *
     * ## 【V3-M10-T01 / `D-G16a` / ADR-0063】`trigger.table` の有無で分岐する
     *
     * **`table` を書いた `schedule` にはトリガー元レコードが在る**(その表の行を1件ずつ
     * 処理する)ので、`$record.<フィールド>` は解決できる —— 上の前提が成り立たない。
     * したがって **`values` / `payload` / `target` の `$record.` 拒否(下の 1. と 2.)は
     * `table` が無いときだけ**に絞った。
     *
     * **絞らなかったもの(`table` の有無によらず schedule では拒否し続けるもの)**:
     *
     * - **`ai_transform`**(下の 0.)—— 実行層 `runAiTransform` が
     *   `workflow.trigger.type === "schedule"` で fail-closed する。許すと
     *   「valid なのに永久に動かないワークフロー」ができる(それこそ本類型の趣旨である)。
     * - **`run_function` の `write_back`** —— 同じく実行層
     *   (`writeBackToTriggerRecord`)が `schedule` で fail-closed する。
     *
     * **この2つを `table` 在りでも動くようにすることは、ADR-0063 の限定表に無い。**
     * やるなら門A を改めて通すこと(ADR-0063 §3a と同じ規律)。
     */
    if (workflow.trigger.type === "schedule") {
      // `table` が在れば行がトリガー元になるので、`$record.` は解決できる(ADR-0063)。
      const hasTriggerRows = workflow.trigger.table !== undefined;
      const noRecordSource = (path: string, value: string, label: string): void => {
        errors.push({
          path,
          message: `ワークフロー "${workflow.id}" は schedule(決まった時刻)で動くので、きっかけとなるレコードがありません。${label}の "${value}" は解決できません。`,
          /*
           * **`allowed_values` は付けない。**
           *
           * :15 の作法「存在しないIDを指すエラーには必ず入れる」は**不在ID系**の規則で、
           * 候補が有限で列挙できることが前提である(テーブルID一覧・フィールドID一覧)。
           * **本件は不在IDではない。**正解は「レコード参照をやめて任意のリテラルを書く」
           * であり、候補は文字列全体 —— 列挙できない。無理に載せれば
           * 「その中から選べ」という誤った含意を作る。行き先は hint が示す。
           */
          hint: `${label}をリテラル(\`$\` で始まらない固定の文字列)に書き換えてください。トリガー元のレコードの値を使いたいなら、trigger を on_create / on_update に変えてください。`,
        });
      };

      workflow.actions.forEach((action, actionIndex) => {
        const actionBase = `${base}/actions/${actionIndex}`;

        // 0. `ai_transform` は結果をトリガー元レコードへ書き戻すため、schedule では
        //    そもそも動けない(ADR-0021 §3。書き戻し先が無い)。$record 参照の有無に
        //    かかわらず、schedule × ai_transform を適用時に拒否する ——
        //    「valid なのに永久に動かないワークフロー」を作らないため(憲法6)。
        if (action.action === "ai_transform") {
          errors.push({
            path: `${actionBase}/action`,
            message: `ワークフロー "${workflow.id}" は schedule(決まった時刻)で動くので、きっかけとなるレコードがありません。ai_transform は結果をトリガー元レコードに書き戻すため、schedule では使えません。`,
            hint: `trigger を on_create / on_update に変えるか、この ai_transform アクションを外してください。`,
          });
          return;
        }

        // `run_function` は `$record` を参照する values / payload / target を持たない
        //(参照するのは function / output_table = 静的な resource_id)。schedule でも
        // 走れるので、通常は何も検査しない。ただし `input.source === "record"` の関数を
        // schedule で起動すると**実行時**に fail-closed する(トリガー元レコードが無いため。
        // resolveFunctionInput)—— これは valid だが空振りしうる形であり、適用時の静的検査で
        // 弾くには function 定義まで辿る必要があるので、実行時の fail-closed に委ねる。
        //
        // **例外: write_back(EC-G6 Route B。ADR-0037)は schedule では動けない。**
        // 書き戻し先がトリガー元レコードなので、`ai_transform` の schedule 拒否(上の 0.)と
        // 同型に適用時に倒す —— 「valid なのに永久に動かないワークフロー」を作らせない(憲法6)。
        if (action.action === "run_function") {
          if (action.write_back !== undefined) {
            errors.push({
              path: `${actionBase}/write_back`,
              message: `ワークフロー "${workflow.id}" は schedule(決まった時刻)で動くので、きっかけとなるレコードがありません。run_function の write_back は結果をトリガー元レコードに書き戻すため、schedule では使えません。`,
              hint: `trigger を on_create / on_update に変えるか、write_back を外して output_table(全置換)を使ってください。`,
            });
          }
          return;
        }

        // **ここから下は「トリガー元レコードが無い」ことだけを理由にした拒否である。**
        // `table` が在れば行がトリガー元になるので、`$record.` を許す(ADR-0063)。
        // `$record.<フィールド>` の型整合は類型10 が、`target` の語彙は類型13 が見る。
        if (hasTriggerRows) {
          return;
        }

        // 1. values の**値**(キーではない。キーは書き込み先フィールドIDである)。
        //    **`call_external` は values の代わりに payload を持つが、値の語彙は同一**
        //    (`$record.<フィールドID>`)なので、同じ「トリガー元が無ければ $record は
        //    書けない」検査に掛ける。
        const refs = action.action === "call_external" ? action.payload : action.values;
        const refsPath = action.action === "call_external" ? "payload" : "values";
        for (const [key, value] of Object.entries(refs)) {
          if (value.startsWith(RECORD_REFERENCE_PREFIX)) {
            noRecordSource(
              `${actionBase}/${refsPath}/${escapePointerToken(key)}`,
              value,
              `"${key}" に指定した値`,
            );
          }
        }

        // 2. update_record の target(更新対象の `_id`。ADR-0013 §7d / 限定12)
        //    **`create_record` は target を持たないので、ここは必ず種別で分ける。**
        if (
          action.action === "update_record" &&
          action.target.startsWith(RECORD_REFERENCE_PREFIX)
        ) {
          noRecordSource(`${actionBase}/target`, action.target, "更新対象(target)");
        }
      });
    }

    /*
     * --- 類型10: アクションの値と書き込み先フィールドの**型整合**(V1-M9-T13 (2)。ADR-0029)---
     *
     * **「valid なのに永久に動かないワークフロー」を作らせない**という類型7/類型8 と
     * 同じカテゴリの検査である(ADR-0013 §8d が禁じた「テーブルの形一般の検査」ではなく、
     * アクションが実際に書く**値の到達可能性**を見る)。
     *
     * ## 何を見るか
     *
     * `create_record` / `update_record` の `values` の各値について、**値の静的に確定する
     * JS 型**(リテラル=string / `$record._id`=string / `$record.<列>`=その列の JS 型)と、
     * **書き込み先フィールドの列型の JS 型**が一致するかを見る。実行時
     * (`workflow-runner.ts` `resolveValue` → `records.ts` `validateDbFreeFieldValue`)は
     * number 列に typeof number、boolean 列に typeof boolean、text/long_text/date/select/
     * reference 列に typeof string を要求する。静的に typeof が確定して食い違うものは
     * **発火のたびに必ず失敗する**ので、適用時に倒してよい(false positive ゼロ)。
     *
     * ## ❌ だけ拒否し、✅ は必ず通す(過剰拒否禁止。ADR-0029 §型互換表)
     *
     * string → number / boolean は ❌(実行時に必ず typeof で弾かれる)。
     * number → number 以外・boolean → boolean 以外も ❌。
     * **string → date / select / reference は通す** —— ISO 形式・options 一致・参照先の
     * 実在は**値ごと(per-record / per-firing)に変わり静的に確定しない**ので、実行時に
     * 委ねる。JS 型としてはどれも string であり `fieldTypeToJsType` が string に畳むので、
     * 「値の JS 型 === 書き込み先の JS 型」の一致判定だけで ❌ セルと ✅ セルが分かれる。
     * `$record.<boolean 列> → boolean 列` は boolean === boolean で通る(整合ケースを
     * 巻き添えにしない)。
     *
     * ## 追加 I/O ゼロ
     *
     * 書き込み先の列型も `$record.<列>` の元の列型も、既に構築済みの `referenceableById`
     * (メモリ内マップ)への参照だけで引ける。DB を1バイトも読まない。
     *
     * ## schedule / 存在しない列は対象外
     *
     * **`table` を書かない** schedule トリガーは `$record` を持たず、その参照は類型7 が
     * 既に拒否している(`staticActionValueType` が `triggerTable === undefined` で
     * undefined を返し、二重報告しない)。ただし schedule でもリテラルの型不整合は見る。
     * **`table` を書いた schedule はその表がトリガー元テーブルである**(`D-G16a` /
     * ADR-0063)ので、`on_create` / `on_update` と同じ型整合検査が当たる。
     * **書き込み先に存在しない列**への値は (2) の射程外(ADR-0029 の決定。型不整合に
     * 射程を限る)—— テーブルの存在は類型6 が、列の存在は本検査の対象外とする。
     */
    const triggerTable = workflow.trigger.table;
    workflow.actions.forEach((action, actionIndex) => {
      if (action.action !== "create_record" && action.action !== "update_record") {
        return;
      }
      const destTable = referenceableById.get(action.table);
      if (destTable === undefined) {
        // 書き込み先テーブルが実在しないのは類型6 が既に報告済み。二重に出さない。
        return;
      }
      const actionBase = `${base}/actions/${actionIndex}`;
      for (const [key, value] of Object.entries(action.values)) {
        const destField = destTable.fields.find((field) => field.id === key);
        if (destField === undefined) {
          // 存在しない列への値は (2) の射程外(ADR-0029)。型不整合だけを見る。
          continue;
        }
        const valueJsType = staticActionValueType(value, triggerTable, referenceableById);
        if (valueJsType === undefined) {
          // 静的に型を確定できない(schedule の $record.=類型7 が報告済み、
          // または `$record.<トリガー元に無い列>`=射程外)。
          continue;
        }
        const destJsType = fieldTypeToJsType(destField.type);
        if (valueJsType === destJsType) {
          // 型整合。date/select/reference の値レベル制約は per-record なので実行時に委ねる。
          continue;
        }
        const valueDesc = value.startsWith(RECORD_REFERENCE_PREFIX)
          ? `参照 "${value}"`
          : `固定の文字列 ${JSON.stringify(value)}`;
        errors.push({
          path: `${actionBase}/values/${escapePointerToken(key)}`,
          message:
            `ワークフロー "${workflow.id}" のアクションが "${key}" に書こうとしている値` +
            `(${valueDesc})は ${JS_TYPE_LABEL[valueJsType]}型ですが、書き込み先のフィールド ` +
            `"${key}"(テーブル "${action.table}")は ${destField.type} 型(${JS_TYPE_LABEL[destJsType]})です。` +
            `型が合わないので、このワークフローは発火しても毎回レコードの書き込みで弾かれ、` +
            `1件も書けません(適用時に拒否します)。`,
          /*
           * **正しい行き先を書く。**「文字列にしてください」で罠へ誘導しない(T05 の失敗の反省)。
           * 型を揃える向きは2つあり、どちらも実行可能なので両方を honest に示す。
           */
          hint:
            `型を揃えてください。方法は2つあります。` +
            `(1) 書き込み先のフィールド "${key}" を ${destTypeSuggestion(valueJsType)}。` +
            `(2) 値のほうを ${destField.type} 型に合わせる —— ${valueSuggestion(destJsType)}。` +
            `値を引用符で囲んで文字列にしても直りません(型の合わない文字列は実行時に必ず弾かれます)。`,
        });
      }
    });

    /*
     * --- 類型11: アクションの実行条件 `when`(EC-G5 条件分岐。ADR-0036)-----------
     *
     * **「valid なのに永久に動かない/黙ってスキップし続けるワークフロー」を作らせない**
     * という類型7/類型8/類型10 と同じカテゴリの検査である。`when` は
     * `{field, equals}` の最小述語で、**トリガー元レコードの `when.field` の値**を
     * `equals` と比べて実行/スキップを分ける(`workflow-runner.ts` の `evaluateWhen`)。
     *
     * ## 2つを見る
     *
     * 1. **`table` を書かない `schedule` × `when` は fail-closed。**その schedule トリガーには
     *    トリガー元レコードが無いので(ADR-0013 §6)、`when.field` は原理的に解決しようが無い ——
     *    `ai_transform` の schedule 拒否(類型7 の 0.)と同型に、適用時に倒す
     *    (実行時に毎回失敗を積んでユーザが履歴を見るまで気づかない形を作らない)。
     *    **【V3-M10-T01 / `D-G16a` / ADR-0063】`table` を書いた `schedule` はこの拒否の
     *    対象外である** —— その表の行がトリガー元レコードなので `when` は解決できる。
     *    **`when` の**形**は1バイトも変えていない**(等値1形のまま。ADR-0063 限定6)——
     *    変わったのは「schedule × when を適用時に拒否するか否か」だけである。
     * 2. **`when.field` はトリガー元テーブルに実在するフィールド**でなければならない
     *    (`$record.<field>` の実在検査と同型)。存在しない列を指す `when` は、実行時に
     *    毎回「フィールドがレコードに無い」で失敗するので、適用時に倒してよい。
     *
     * **`when` は全アクション種で任意**なので、持たないアクションはここを素通りする
     * (後方互換。従来の `when` 無しアクションは1バイトも変わらない)。
     */
    const triggerTableForWhen = workflow.trigger.table;
    workflow.actions.forEach((action, actionIndex) => {
      const when = action.when;
      if (when === undefined) {
        return;
      }
      const actionBase = `${base}/actions/${actionIndex}`;
      if (triggerTableForWhen === undefined) {
        // 1. `table` を書かない schedule × when(レコード源が無い)。allowed_values は付けない
        //    (正解は「when を外す/トリガーを変える」で、候補は列挙できない。類型7 と同じ作法)。
        errors.push({
          path: `${actionBase}/when`,
          message:
            `ワークフロー "${workflow.id}" は schedule(決まった時刻)で動くので、` +
            `きっかけとなるレコードがありません。アクションの実行条件 when ` +
            `(フィールド "${when.field}")は解決できません。`,
          hint: `この when を外すか、trigger を on_create / on_update に変えてください。`,
        });
        return;
      }
      const whenTable = referenceableById.get(triggerTableForWhen);
      if (whenTable === undefined) {
        // トリガー元テーブル不在は類型6 が既に報告済み。二重に出さない。
        return;
      }
      if (!whenTable.fields.some((field) => field.id === when.field)) {
        errors.push({
          path: `${actionBase}/when/field`,
          message:
            `ワークフロー "${workflow.id}" のアクションの実行条件 when が参照するフィールド ` +
            `"${when.field}" は、トリガー元テーブル "${triggerTableForWhen}" に存在しません。`,
          allowed_values: unique(whenTable.fields.map((field) => field.id)),
          hint:
            `トリガー元テーブル "${triggerTableForWhen}" に実在するフィールドIDを指定するか、` +
            `先に add_field でフィールドを追加してください。`,
        });
      }
    });

    /*
     * --- 類型12: run_function の write_back(EC-G6 演算 = Route B。ADR-0037)-------
     *
     * `write_back` は島の出力(1行)を**トリガー元レコード自身のフィールドへ書き戻す**。
     * 「valid なのに永久に動かない/毎回失敗するワークフロー」を apply 時に倒す:
     *
     * 1. **`schedule` × `write_back`** は上の類型7(schedule ブロックの run_function 分岐)が
     *    既に倒している(レコード源が無い)。ここでは重複して見ない。
     * 2. **`function.output.fields` はすべてトリガー元テーブルに実在するフィールド**でなければ
     *    ならない(書き戻し先は実在フィールドに限定。`ai_transform` の `output_field` と同型)。
     *    `validateFunctionOutput` は `output.fields` の各 id を持つ行に整えてから書き戻すので、
     *    出力フィールドがトリガー元テーブルに無ければ**実行時に毎回 fail-closed** する ——
     *    function 定義を辿れる apply 時に倒してよい(可能な範囲の静的検査。ADR-0037 限定4)。
     *
     * **`write_back` を持たない run_function(output_table 全置換)はここを素通りする。**
     */
    const triggerTableForWriteBack =
      workflow.trigger.type === "schedule" ? undefined : workflow.trigger.table;
    if (triggerTableForWriteBack !== undefined) {
      const wbTable = referenceableById.get(triggerTableForWriteBack);
      if (wbTable !== undefined) {
        workflow.actions.forEach((action, actionIndex) => {
          if (action.action !== "run_function" || action.write_back === undefined) {
            return;
          }
          const fn = functions.find((f) => f.id === action.function);
          if (fn === undefined) {
            // 不在 function は類型9(:303)が既に報告済み。二重に出さない。
            return;
          }
          const actionBase = `${base}/actions/${actionIndex}`;
          // `output: { ops: true }` を宣言した関数は行の配列を返さないので、突き合わせる
          // 出力フィールドが1つも無い(ADR-0067 限定 A11: op 側は apply 時に検査できない ——
          // モード不一致は実行時に fail-closed する)。
          for (const field of fn.output.fields ?? []) {
            if (!wbTable.fields.some((f) => f.id === field.id)) {
              errors.push({
                path: `${actionBase}/write_back`,
                message:
                  `ワークフロー "${workflow.id}" の run_function は write_back で ` +
                  `関数 "${fn.id}" の出力をトリガー元レコードへ書き戻しますが、出力フィールド ` +
                  `"${field.id}" はトリガー元テーブル "${triggerTableForWriteBack}" に存在しません。`,
                allowed_values: unique(wbTable.fields.map((f) => f.id)),
                hint:
                  `関数 "${fn.id}" の output.fields をトリガー元テーブル "${triggerTableForWriteBack}" の ` +
                  `実在フィールドに合わせるか、先に add_field でフィールドを追加してください。`,
              });
            }
          }
        });
      }
    }

    /*
     * --- 類型13: update_record の target 語彙(EC-G13 cross-row 更新。ADR-0040)----
     *
     * **`update_record` の `target` が受ける正規形は3形だけ**である(ADR-0040 §1):
     * (i) `$record._id`(自己更新。既存)/ (ii) `$record.<reference フィールドID>`
     * (トリガー元のその参照フィールドが保持する `_id` = 参照先の別テーブル行。**新規**)/
     * (iii) 定数 UUID リテラル(既存)。
     *
     * ## 何を適用時に確定するか(限定3)
     *
     * `$record.<field>` 形の target について「その `<field>` が**トリガー元テーブルに実在し、
     * かつ reference 型か**」を apply 時に検査する。実在しない/非 reference フィールドを
     * 指す target は、実行時に毎回「参照先の行を特定できない」で失敗するので、
     * apply 時に倒してよい(類型10/11/12 と同じ「valid なのに永久に動かない」カテゴリ)。
     *
     * ## 何を確定しないか(限定4。過剰約束しない。T-2 の原理的限界)
     *
     * `$record.<field>` が指す**行**は発火のたびに変わり、適用時にはまだ存在しない。
     * したがって**実行時にその参照先『行』が実在するかは検査しない。**定数 UUID リテラル
     * target についても、それが実在する行を指すかは適用時に確定できないので**検査しない**
     * —— UUID 形であることだけを見る(下記 D2-a 選択肢A)。
     *
     * ## D2-a 非対称の扱い(ADR-0040 選択肢A)
     *
     * リテラル target(`$` で始まらない)は **UUID 形のみ**を許す。`"bogus"` /
     * `"trigger_record"` のような参照形でない任意リテラルは apply 時に拒否する
     * (非対称を一段解消)。ただし**UUID 形の実在しない _id は依然通る**(実行時 failure。
     * T-2 限界)。`$` で始まるが `$record.` でない形は schema の action_value pattern が
     * 既に弾く(`then: ^\$record\....`)ので、ここには到達しない。
     *
     * ## `table` を書かない schedule × `$record.<field>` は類型7 が既に拒否している
     *
     * `triggerTable` が `undefined`(= `table` を書かない schedule)なら二重報告しない。
     * `$record._id` も類型7 が拒否済みなので、ここでは `_id`(および他の `_` 始まり)を
     * 素通りさせる。**【V3-M10-T01 / ADR-0063】`table` を書いた schedule はその表が
     * トリガー元テーブルなので、`on_create` / `on_update` と同じ target 語彙の検査が当たる。**
     */
    const triggerTableForTarget = workflow.trigger.table;
    workflow.actions.forEach((action, actionIndex) => {
      if (action.action !== "update_record") {
        return;
      }
      const target = action.target;
      const actionBase = `${base}/actions/${actionIndex}`;

      if (target.startsWith(RECORD_REFERENCE_PREFIX)) {
        const fieldId = target.slice(RECORD_REFERENCE_PREFIX.length);
        // `$record._id`(自己更新)/ 他の `_` 始まり(schema/類型7 の領分)は対象外。
        if (fieldId === "_id" || fieldId.startsWith("_")) {
          return;
        }
        if (triggerTableForTarget === undefined) {
          // `table` の無い schedule × `$record.<field>` は類型7 が既に拒否済み。二重に出さない。
          return;
        }
        const triggerTable = referenceableById.get(triggerTableForTarget);
        if (triggerTable === undefined) {
          // トリガー元テーブル不在は類型6(:284)が既に報告済み。
          return;
        }
        // 候補は**reference 型フィールドのみ**(target に書けるのは参照フィールドだけ)。
        const referenceFieldIds = unique(
          triggerTable.fields
            .filter((field) => field.type === "reference")
            .map((field) => field.id),
        );
        const field = triggerTable.fields.find((f) => f.id === fieldId);
        if (field === undefined) {
          errors.push({
            path: `${actionBase}/target`,
            message:
              `ワークフロー "${workflow.id}" の update_record の target "${target}" が参照する ` +
              `フィールド "${fieldId}" は、トリガー元テーブル "${triggerTableForTarget}" に存在しません。 ` +
              `target に \`$record.<フィールド>\` を書けるのは、そのフィールドが reference 型のとき ` +
              `(参照先の行を更新対象にする)だけです。`,
            allowed_values: referenceFieldIds,
            hint:
              `トリガー元テーブル "${triggerTableForTarget}" に実在する reference 型フィールドIDを指定するか、` +
              `自分自身を更新するなら "$record._id" を書いてください。`,
          });
        } else if (field.type !== "reference") {
          errors.push({
            path: `${actionBase}/target`,
            message:
              `ワークフロー "${workflow.id}" の update_record の target "${target}" が参照する ` +
              `フィールド "${fieldId}"(テーブル "${triggerTableForTarget}")は ${field.type} 型で、reference 型ではありません。 ` +
              `target で参照先の行を狙えるのは reference 型フィールドだけです ` +
              `(reference フィールドの値=参照先の行の _id を更新対象にします)。`,
            allowed_values: referenceFieldIds,
            hint:
              `reference 型フィールドを指すか、自分自身を更新するなら "$record._id" を、` +
              `特定の行を直接狙うなら定数の UUID を書いてください。`,
          });
        }
        // field が reference 型なら valid(参照先『行』の実在は検査しない=限定4)。
      } else if (!target.startsWith("$")) {
        // リテラル target(D2-a 選択肢A)。UUID 形のみ許す。
        if (!UUID_PATTERN.test(target)) {
          errors.push({
            path: `${actionBase}/target`,
            message:
              `ワークフロー "${workflow.id}" の update_record の target "${target}" は、更新対象の行を特定できません。 ` +
              `target に書けるのは3形だけです: "$record._id"(自己更新)/ ` +
              `"$record.<reference フィールド>"(参照先の行)/ 定数の UUID(特定の行)。`,
            hint:
              `更新対象がトリガー元自身なら "$record._id"、参照先の行なら "$record.<reference フィールド>"、` +
              `特定の行を直接狙うなら UUID 形("xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx")を書いてください。`,
          });
        }
        // UUID 形なら valid(その UUID が実在する行を指すかは検査しない=限定4)。
      }
      // `$` で始まるが `$record.` でない形は schema の action_value pattern が既に弾く。
    });

    /*
     * --- 類型16: `schedule` の経過時間の述語 `older_than`(D-G16b。ADR-0064)-------
     *
     * **類型11 の `when.field` 実在検査と同型である**(ADR-0064 §Decision 1 の層別表)。
     * 見るのは3つで、**どれも「valid なのに永久に動かない/黙って0件になる宣言」を
     * 作らせない**という類型7 / 10 / 11 と同じカテゴリに属する:
     *
     * 1. **`table` の無い `schedule` に `older_than` は書けない**(限定5)。
     *    対象行が1件も無いので、絞る対象が存在しない —— `ADR-0064` は `ADR-0063` に
     *    **完全に従属する**(同 §限界5)。schema の `allOf` も同じことを塞いでいるが、
     *    **MCP 経由以外でマニフェストが入る余地がある以上、防御は二重に置く**
     *    (類型7 と同じ方針)。こちらは「なぜ書けないか」を名指しで返せる。
     * 2. **`older_than.field` が `trigger.table` に実在すること。**
     * 3. **その `field` が `date` 型であること。**text / number を指すと、実行時に
     *    毎回0件になるか、日付として読めない値を黙って読み飛ばし続ける。
     *
     * **`older_than` を書かない定義はここを素通りする**(後方互換。今日の宣言は
     * 1バイトも変わらない)。**`when` を1バイトも触っていない** —— 2条件の AND は
     * 「ここで行を絞る」×「類型11 の `when` でアクションを絞る」の2層の合成で得る
     * のであって、述語を結合可能にしたのではない(ADR-0064 限定2)。
     */
    const scheduleTrigger = workflow.trigger;
    const olderThan = scheduleTrigger.type === "schedule" ? scheduleTrigger.older_than : undefined;
    if (olderThan !== undefined) {
      const olderBase = `${base}/trigger/older_than`;
      const targetTableId = scheduleTrigger.table;
      if (targetTableId === undefined) {
        // 1. 対象表が無い(= 対象行が1件も無い)。
        errors.push({
          path: olderBase,
          message:
            `ワークフロー "${workflow.id}" の older_than は、対象の行が1件も無いので使えません ` +
            `—— trigger に table が書かれていません。older_than は「発火時に列挙した行を、` +
            `一定時間経ったものだけに絞る」述語なので、絞る対象が要ります。`,
          hint: `trigger に table(行を列挙する対象のテーブルID)を書くか、older_than を外してください。`,
        });
      } else {
        const targetTable = referenceableById.get(targetTableId);
        // 対象表そのものが不在なのは類型6 が既に報告済み。二重に出さない。
        if (targetTable !== undefined) {
          const dateFieldIds = unique(
            targetTable.fields.filter((field) => field.type === "date").map((field) => field.id),
          );
          const field = targetTable.fields.find((candidate) => candidate.id === olderThan.field);
          if (field === undefined) {
            // 2. 実在しない列。
            errors.push({
              path: `${olderBase}/field`,
              message:
                `ワークフロー "${workflow.id}" の older_than が参照するフィールド ` +
                `"${olderThan.field}" は、対象テーブル "${targetTableId}" に存在しません。`,
              allowed_values: dateFieldIds,
              hint:
                `対象テーブル "${targetTableId}" に実在する date 型のフィールドIDを指定するか、` +
                `先に add_field で date 型のフィールドを追加してください。` +
                `**予約列(_created_at / _updated_at)は指定できません。**`,
            });
          } else if (field.type !== "date") {
            // 3. 型が違う。
            errors.push({
              path: `${olderBase}/field`,
              message:
                `ワークフロー "${workflow.id}" の older_than が参照するフィールド ` +
                `"${olderThan.field}"(テーブル "${targetTableId}")は ${field.type} 型で、` +
                `date 型ではありません。older_than が測れるのは date 型の値からの経過日数だけです ` +
                `(数値や文字列の大小を比べる述語ではありません)。`,
              allowed_values: dateFieldIds,
              hint:
                dateFieldIds.length === 0
                  ? `テーブル "${targetTableId}" に date 型のフィールドを add_field で追加してから指定してください。`
                  : `date 型のフィールドIDを指定してください。`,
            });
          }
        }
      }
    }
  });

  /*
   * --- 類型9: 関数が指すテーブル / ビューが実在するか(ADR-0024 §8)-------------
   *
   * **ワークフローの走査(:210-)と同型である。**§8 はこう書いている:
   *
   *   `function` は tables / views / capabilities を参照する。tables / views は
   *   function を1バイトも参照しない。`apply_diff` 時に参照整合性検査が走り、
   *   存在しない table / view を指す定義は拒否される。
   *
   * ## 使う集合(限定7: システムテーブル不可)
   *
   * - `input.source === "table"` の `input.table` は `referenceableById`(宣言テーブルのみ。
   *   **`viewTargetById` を使ってはならない** —— それはシステムテーブルを含み、限定7 が
   *   `$defs/resource_id` を使ってシステムテーブルを弾いているのと食い違う。ワークフローの
   *   `:220-235` の警告と同じ)。
   * - `input.source === "view"` の `input.view` は **list_view のIDのみ**を候補にする
   *   —— ADR-0024 §Decision は「既存 list_view の filter / sort を適用した行を渡す」と
   *   定めており(§7a: 新しいクエリ文法を足さず、「どの行か」を既存の list_view で表す)、
   *   form / detail_view は行の絞り込み・並びを持たない。
   *
   * ## capabilities は検査しない(ADR-0024 §8)
   *
   * `function.capabilities` は**マニフェスト外(人間ストアの connection / ai_capability)**を
   * 指す。apply 時には検査せず、実行時にブリッジが fail-closed で照合する(第2段 T04)。
   * ここで検査しようとすると、マニフェストに現れない capability ストアを参照することになり、
   * ADR-0020 §2e / ADR-0021 §3(capability は人間専用ストアにあり実行層で照合する)と
   * 食い違う。
   */

  /**
   * そのワークフローがこの関数を `run_function` で呼ぶか(`ADR-0083` 限定4 / 限定5)。
   *
   * **参照は1ホップも辿らない** —— 見るのはワークフローの宣言だけである。
   */
  const workflowCallsFunction = (workflow: Workflow, functionId: ResourceId): boolean =>
    workflow.actions.some(
      (action) => action.action === "run_function" && action.function === functionId,
    );

  // list_view のIDだけを集める(input.view の候補。form / detail_view は除く)。
  const listViewIds = unique(
    views.filter((view) => view.type === "list_view").map((view) => view.id),
  );

  // --- 類型5(補遺): 役割IDの重複(`V8-M16-T02`。台帳 `J-G1b`)--------------------
  //
  // **なぜ schema ではなくここなのか**: `uniqueItems` は**オブジェクト全体の同値**でしか
  // 効かないので、`{"id":"member","name":"会員"}` と `{"id":"member","name":"メンバー"}` を
  // 通してしまう。**`user_kinds` が今日も塞げていない穴**(`ADR-0158` の限界として
  // `src/kernel/declared-user-kinds.test.ts` の冒頭が名指ししている)であり、
  // **`roles` では同じ穴を踏まない。****`user_kinds` 側の宣言は1バイトも触っていない**
  // (塞ぐことは `ADR-0158` 限定6 の外であり、本タスクの射程でもない)。
  collectDuplicates(
    (manifest.app.roles ?? []).map((role) => role.id),
    (index, id) => {
      errors.push({
        path: `/app/roles/${index}/id`,
        message: `役割 "${id}" が重複しています。同じ役割を2度書くことはできません。`,
        hint: "どちらか一方に別の識別子を付けるか、片方を消してください。",
      });
    },
  );

  /*
   * --- 類型17: 既定の役割定義3本が消えていないこと(`V8-M17`。台帳 `J-G2` /
   *     ユーザ決定 `D-V8-26`。**メインの判断で塞いだ**)------------------------------
   *
   * **`set_roles` は全体差し替えの op なので、素直に書くと既定3本を消せてしまう**
   * (`V8-M17` の実測で実際に消せた)。**`04` §7 の `V8-M16` の完了条件 (ii) の逐語は
   * 「運営3ロールが既定の役割として残っていること(`D-V8-26`)—— 3つとも `API` から
   * 確認する」であり、消せるなら「残っている」と書けない。**
   * **台帳 `J-G2` の限定の逐語も「アプリの作者は既定に足すことしかできず、引き算(拒否)を
   * 1つも書けない」であり、既定そのものを消すのは「足すこと」ではない。**
   *
   * **要求するのは `id` の3本が全部在ることだけである**:
   *
   * - **表示名(`name`)は変えてよい** —— アプリの言い回しに合わせられるべきである。
   * - **既定に規則(`rules`)を足すのは当然できる** —— **それが「足すことしかできない」の
   *   中身である。**
   * - **4本目以降を足すのも当然できる。**
   * - **並び順は問わない。**
   *
   * **`app.roles` を1つも宣言していないアプリには当たらない** —— **`roles` は今日も
   * 省略可であり(`required` に入れていない)、省略は「役割を1つも宣言していない」を
   * 意味する。****`V8-M16` より前に作られた既存のアプリ定義を1バイトも壊さない。**
   *
   * **なぜ schema ではなくここなのか**: **`contains` を3本並べれば schema でも書けるが、
   * その形のエラーは「少なくとも1件が合致しなければならない」としか言えず、
   * **どの役割が消えたのかを書いた人に返せない**(`ADR-0003` §3 = 1往復で全部直せる形)。
   * **`roles[].id` の重複検査(すぐ上)と同じ場所に置く。**
   *
   * **`anonymous` は要求しない** —— **予約4語のうち3語だけである。**
   */
  if (manifest.app.roles !== undefined) {
    const declaredRoleIds = new Set(manifest.app.roles.map((role) => role.id));
    const missingDefaults = DEFAULT_ROLE_IDS.filter((id) => !declaredRoleIds.has(id));
    if (missingDefaults.length > 0) {
      errors.push({
        path: "/app/roles",
        message: `既定の役割 ${missingDefaults.map((id) => `"${id}"`).join(" / ")} が宣言から消えています。既定の役割(owner / editor / viewer)は消せません。`,
        allowed_values: [...DEFAULT_ROLE_IDS],
        hint: "set_roles は宣言を丸ごと差し替えるので、既定の3つ(owner / editor / viewer)を必ず含めて書いてください。表示名(name)は変えられますし、規則(rules)を足すこともできます。",
      });
    }
  }

  /*
   * --- 類型17(拡張): 持ち主から「定義を変える」「役割を配る」の2行が抜けないこと
   *     (`V8-M28`。台帳 `T-G16a` = **限定採用**。ユーザ決定 `D-V8-47` / `D-V8-48` /
   *      `D-V8-59`)-------------------------------------------------------------------
   *
   * ## **ここは明文を1つ破っている。隠さずに書く。**
   *
   * **破る明文の所在**: `docs/adr/0304-role-rules-declaration.md` の限定11 の行。
   * **逐語**: 「**既定に `rules` を足してよい** / **4本目以降を足してよい** /
   * **並び順は問わない**」。
   * **本検査は、そのうち「足した `rules` を抜いてよい」を `owner` の2行についてだけ
   * 成り立たなくする。** —— **`ADR-0007` §8 の `T-G16a` の行が「**代償 = `ADR-0304`
   * 限定11 の『既定に足した `rules` を抜いてよい』が成立しなくなり、一部を引き直す
   * ことになる**」と、判定の時点で自ら申告している。**
   * **【禁止】これを「限定11 を破っていない」と書かない。**
   *
   * ## なぜ要るのか
   *
   * **`V8-M28` は「アプリの定義を変えられる」「人に役割を配れる」を役割の規則で
   * 書けるようにした**(`target` の5種目 `app` / 6種目 `role`)。
   * **既定は閉じる**(`D-V8-59`)ので、**`owner` からこの2行が消えた瞬間、そのアプリでは
   * 誰も定義を変えられず、誰も役割を配れなくなる。**
   * **`set_roles` は全体差し替えの op なので、うっかり2行を落とした宣言を書けるし、
   * その差分を戻す(= 定義を変える)ことも、その権限を誰かに配ることもできない** ——
   * **回復経路が語彙の中に1本も無い。**
   *
   * ## 見るもの・見ないもの(**誇張しない**)
   *
   * - **見るのは `owner` の `rules` だけである。** **`editor` / `viewer` の `rules` は
   *   1件も見ない**(`D-V8-59` は持ち主だけを名指ししている)。
   * - **要求するのは2行の**存在**だけである** —— **並び順は問わない / ほかの規則を
   *   いくつ足してもよい / 表示名(`name`)は変えてよい / 4本目以降の役割は自由である。**
   * - **`app.roles` を1つも宣言していないアプリには当たらない**(すぐ上の類型17 と
   *   まったく同じ条件である)—— **`roles` は今日も省略可であり、省略は「役割を1つも
   *   宣言していない」を意味する。**
   * - **`owner` の宣言そのものが消えている場合は、すぐ上の類型17 が別のエラーを出す** ——
   *   **本検査はそこに2本目のエラーを重ねない**(`owner` が居ないときは何も push しない)。
   *
   * ## **これは「締め出しが防がれた」ことを意味しない**
   *
   * **`cp-v8-authz.md` §B-(vii)-2 の実測により `undo` はこの種の拒否を迂回できる**
   * (台帳 `T-G51` / `D-V8-51`。**本軸はそれを塞がない**)。
   * **人の側(`owner` ロールを持つ**人**が0人になる)を止めているのは
   * `src/auth/store.ts` の `countOwners()` / `ensureOwnerExists()` / `LastOwnerError`
   * であり、本検査ではない**(台帳 `T-G16b` = 却下)。
   */
  if (manifest.app.roles !== undefined) {
    const ownerDeclaration = manifest.app.roles.find((role) => role.id === "owner");
    if (ownerDeclaration !== undefined) {
      const ownerRules = ownerDeclaration.rules ?? [];
      const missingRuleTargets = OWNER_REQUIRED_RULE_TARGETS.filter(
        (target) =>
          !ownerRules.some((rule) => rule.target === target && rule.can.includes("write")),
      );
      if (missingRuleTargets.length > 0) {
        errors.push({
          path: "/app/roles",
          message: `既定の役割 "owner" から ${missingRuleTargets
            .map((target) => `"${target}" + "write"`)
            .join(
              " / ",
            )} の規則が消えています。持ち主はアプリの設定(app)を変えられ、人に役割(role)を配れる必要があります。`,
          allowed_values: [...OWNER_REQUIRED_RULE_TARGETS],
          hint: '持ち主(owner)の rules に {"target":"app","can":["write"]} と {"target":"role","can":["write"]} の2本を必ず含めて書いてください。持ち主から "app" + "write" を抜くと、二度と定義を変えられなくなります(抜いた状態を元に戻す操作そのものが定義の変更なので、回復経路が語彙の中に1本もありません)。ほかの規則をいくつ足しても構いませんし、表示名(name)は変えられます。',
        });
      }
    }
  }

  /*
   * --- 類型16: 役割の規則が指す先の実在(`V8-M17`。台帳 `J-G6` / `J-G7` / `J-G8` /
   *     `J-G9`)—— **`D-V8-66` で撤去した(2026-08-10)** ---------------------------
   *
   * ## **ここは明文を1つ破っている。隠さずに書く。**
   *
   * **破る明文の所在**: `docs/adr/0086-field-value-unit.md:120`(限定4 の行の「根拠」の欄)。
   * **逐語**: 「**「書けるが効かない組み合わせ」を1つも作らない**」。
   * **`V8-M17` はこの作法を役割の規則にも引き受け、本ブロックの旧 doc に
   * 「**「書けるが必ず効かない宣言」を1つも作らない**(`ADR-0086` 限定4 / `ADR-0292` が
   * `access_control` について採ったのと同じ作法)」と逐語で書いていた。**
   * **`D-V8-66` はその作法を、役割の規則についてだけ、正面から破る。**
   *
   * **破る根拠**: **ユーザ決定 `D-V8-66`(2026-08-10)。選ばれた説明文の逐語** ——
   * 「画面はそのまま消せますが、それを名指ししていた権限の行がアプリに残ります。
   * 残った行は何の効果も持ちませんが、権限の一覧を見た人は存在しない画面の名前を目にします。
   * この基盤は『書けるが必ず効かない宣言を1つも作らない』を明文で守っており、そこを破ります。」
   *
   * ## なぜ要ったか(**実測**)
   *
   * **`V8-M26-T04` が `add_table` / `add_view` / `update_view` のたびに既定3役割の規則を
   * 自動で足すようになった。** **一方 `remove_view` / `remove_table` はカスケードしない**
   * (`ADR-0012` 限定4 の逐語「**カスケードしない**」)。
   * **その結果、旧の類型16 は「自動で入った規則が指す先が消えた」ことを理由に
   * `remove_view` / `remove_table` の差分**全体**を拒否していた** —— **`T04` より後に
   * 作った画面・表は、同じ差分に `set_roles` を並べないかぎり消せなかった。**
   * **`D-V8-66` は「残った行を許す」側を選び、この拒否を消した。**
   *
   * ## 撤去したのは4本ちょうどである(**それ以外は1バイトも緩めていない**)
   *
   *  1. `rules[].table` が指す表の実在
   *  2. `rules[].field` が指す項目の実在
   *  3. `rules[].view` が指す画面の実在
   *  4. `rules[].action` が指すボタンの実在
   *
   * **表・項目・画面そのものの参照整合性(画面が指す表、列が指す項目、ワークフロー・
   * 関数・操作起点が指す先 …)は今日どおりである。**
   * **`when` の中の項目の実在(すぐ下の類型16 補遺 / `J-G15`)も今日どおり残す** ——
   * **`D-V8-66` が名指ししたのは `table` / `field` / `view` / `action` の4本だけであり、
   * 自動付与は `when` を1本も書かないので、残しても消す動作を1件も塞がない。**
   * **【正直に書く】その結果、`field` は指し先が消えても通り、`when` の中の同じ項目名は
   * 通らない、という非対称がここに1つ生まれている。** **塞いでいない。**
   *
   * ## 残った行がどう扱われるか(**誇張しない**)
   *
   * - **面(`src/server/owner-scope.ts` の `judgeRoleAccess`)は対象の識別子で突き合わせる
   *   ので、その識別子を持つ対象がアプリに1つも無ければ、残った行はどの要求にも当たらない。**
   * - **ただし「必ず効かない」のは、その識別子が空いているあいだだけである** ——
   *   **同じ識別子で作り直せば、残っていた行がそのまま効く。**
   *   **`D-V8-66` はこの復活を止めていない**(実測は
   *   `src/kernel/role-rule-stale-target.test.ts` の (E))。
   *
   * **役割の識別子(`roles[].id`)が `user_kinds` に実在するかは、ここでは今日も1件も
   * 見ない** —— **`V8-M16` が申告済みの穴であり、本タスクは1バイトも塞いでいないし、
   * 広げてもいない。**
   *
   * **【正直に書く】ここは宣言の整合だけを見る。** **判定の実装は1バイトも無い。**
   */
  (manifest.app.roles ?? []).forEach((role, roleIndex) => {
    (role.rules ?? []).forEach((rule, ruleIndex) => {
      const rulePath = `/app/roles/${roleIndex}/rules/${ruleIndex}`;
      /*
       * **指し先の表は `when` の検査にだけ使う**(`D-V8-66` で実在検査そのものは消えた)。
       * **見つからなければ `undefined` のまま進む** —— **拒否理由を1件も積まない。**
       */
      const targetTable = rule.table === undefined ? undefined : referenceableById.get(rule.table);
      /*
       * --- 類型16(補遺): 役割の規則の条件 `when`(`V8-M18`。台帳 `J-G14` / `J-G15`)---
       *
       * **schema が倒せるのはここまでである**: 組み立て3種・葉2種・キーの閉じ・
       * 「自分」の値域(`true` 1つ)・画面とボタンには書けないこと。
       * **JSON Schema で表せない2つを、ここが倒す**:
       *
       * 1. **入れ子の深さ**(`J-G14`)—— `$ref` の自己参照は無限段を許すので、
       *    **上限は `MAX_FILTER_DEPTH` を import して共有する**(値をここで宣言し直さない)。
       * 2. **項目の指し先の実在**(`J-G15`)—— **その規則が名指しした表の上に、その項目が
       *    在るか。** **「書けるが必ず効かない宣言」を1つも作らない**(`ADR-0086` 限定4)。
       *
       * **`when` を書ける規則は対象が表(`table`)か項目(`field`)のときだけである** ——
       * **どちらも `rule.table` を持つので、指し先の表は常に定まる**(schema の `allOf` が
       * `required: ["table"]` を課している)。**画面とボタンには `when: false` が掛かっている。**
       *
       * **【正直に書く】評価は1バイトも行わない。** **ここがするのは形の検査だけであり、
       * 条件を評価するのはサーバ層である**(裁定 `R-17-7`)。
       */
      if (rule.when !== undefined) {
        walkRoleCondition(rule.when, `${rulePath}/when`, 0, (node, path, depth) => {
          if (depth > MAX_FILTER_DEPTH) {
            errors.push({
              path,
              message: `役割 "${role.id}" の規則の条件のネストが深すぎます(深度上限 ${MAX_FILTER_DEPTH} 段)。`,
              hint: "and / or / not のネストを浅くしてください(無限ネストは受け付けません)。絞り込み条件(filter)と同じ上限です。",
            });
            return false;
          }
          if (!("field" in node)) return true;
          if (targetTable === undefined) return true;
          const field = targetTable.fields.find((candidate) => candidate.id === node.field);
          if (field === undefined) {
            errors.push({
              path: `${path}/field`,
              message: `役割 "${role.id}" の規則の条件が指すフィールド "${node.field}" はテーブル "${targetTable.id}" に存在しません。`,
              allowed_values: targetTable.fields.map((candidate) => candidate.id),
              hint: `条件から見えるのは、判定している行の項目の値と、要求している人の識別子だけです。テーブル "${targetTable.id}" に実在するフィールドIDを指定してください。`,
            });
          }
          return true;
        });
      }
    });
  });

  // --- 類型5(補遺): 関数IDの重複(テーブル・ビュー・ワークフローと揃える)--------
  collectDuplicates(
    functions.map((fn) => fn.id),
    (index, id) => {
      errors.push({
        path: `/app/functions/${index}/id`,
        message: `関数ID "${id}" が重複しています。関数IDはアプリ内で一意である必要があります。`,
        hint: "どちらかの関数に別のIDを付けてください。",
      });
    },
  );

  functions.forEach((fn, functionIndex) => {
    const base = `/app/functions/${functionIndex}`;
    /*
     * **ADR-0062 限定11: 既存の類型9 を配列の各要素にそのまま当てるだけである。**
     * **新しい類型番号を作らず、公開 export も1本も足さない。**
     *
     * - **単体形**のとき path は今日と同一(`.../input/table` / `.../input/view`)である
     *   —— 既存マニフェスト・既存検査の期待値を1バイトも動かさない(限定12)。
     * - **配列形**のとき path に要素の位置が入る(`.../input/2/table`)—— どの要素が
     *   不正かを読めるようにするためであり、**新しい語彙ではない**。
     * - **参照を1ホップも辿らない。** 検査するのは「宣言されたテーブル / list_view が
     *   実在するか」だけであり、参照展開・多段・join を1つも検査しない(限定7)。
     */
    const declared = fn.input;
    const inputs: { input: FunctionInput; path: string }[] = Array.isArray(declared)
      ? declared.map((one, elementIndex) => ({ input: one, path: `${base}/input/${elementIndex}` }))
      : [{ input: declared, path: `${base}/input` }];

    for (const { input, path } of inputs) {
      // `input` の参照は table か view のどちらか一方だけである(source=record は参照無し)。
      if (input.source === "table" && !referenceableById.has(input.table)) {
        errors.push({
          path: `${path}/table`,
          message: `関数 "${fn.id}" の入力に指定されたテーブル "${input.table}" は存在しません。`,
          allowed_values: referenceableIds,
          hint: "実在するテーブルIDを指定するか、先に add_table でテーブルを追加してください。システムテーブル(_apps / _changelog)は関数の入力にできません。",
        });
      }
      if (input.source === "view" && !listViewIds.includes(input.view)) {
        errors.push({
          path: `${path}/view`,
          message: `関数 "${fn.id}" の入力に指定された一覧(list_view) "${input.view}" は存在しません。`,
          allowed_values: listViewIds,
          hint: "実在する list_view のIDを指定するか、先に add_view で一覧を追加してください(関数の入力に使えるのは list_view だけです —— どの行を渡すかはその filter / sort で表します)。",
        });
      }
      /*
       * **`E-G72` / `V4-M10-T44` / `ADR-0083` 限定4・限定5・限定11。**
       *
       * **既存の類型9 にそのまま当てるだけである。新しい類型番号を作らず、公開 export も
       * 1本も足さない**(限定11。`ADR-0062` 限定11 の継承)。
       *
       * 見るのは2点だけである:
       *  (a) **`via` が指すフィールドが、その入力テーブルに実在する `reference` 型か**
       *      —— **1ホップだけであることの担保**(限定5)。`$record.<ref>.<field>` の辿りも
       *      多段も join も逆参照も1つも作らない。
       *  (b) **その `reference` の参照先が、この関数を呼ぶワークフローのトリガー元テーブルか**
       *      —— **突き合わせは `child.<via> == トリガー元の _id` の等値1つだけ**なので、
       *      参照先が違えば1行も一致せず「valid なのに永久に空振りする形」になる(憲法6)。
       *      **トリガー元レコードが無い発火(`trigger.table` を持たない `schedule`)も
       *      ここで弾く**(限定4)。
       *
       * **参照は1ホップも辿らない** —— 見るのはマニフェストの宣言だけである(限定7 不可侵)。
       */
      if (input.source === "table" && input.via !== undefined) {
        const inputTable = referenceableById.get(input.table);
        const viaField = inputTable?.fields.find((field) => field.id === input.via);
        if (inputTable !== undefined && (viaField === undefined || viaField.type !== "reference")) {
          errors.push({
            path: `${path}/via`,
            message: `関数 "${fn.id}" の入力の via "${input.via}" は、テーブル "${input.table}" の reference 型フィールドではありません。`,
            allowed_values: inputTable.fields
              .filter((field) => field.type === "reference")
              .map((field) => field.id),
            hint: "via には、その入力テーブルが持つ reference 型フィールドのIDだけを書けます(1ホップだけです)。参照先はこの関数を呼ぶワークフローのトリガー元テーブルでなければなりません。",
          });
        } else if (viaField !== undefined && viaField.type === "reference") {
          for (const workflow of workflows) {
            if (!workflowCallsFunction(workflow, fn.id)) {
              continue;
            }
            const triggerTable = workflow.trigger.table;
            if (triggerTable === undefined) {
              errors.push({
                path: `${path}/via`,
                message: `関数 "${fn.id}" の入力は via(トリガー元レコードに紐づく行だけを渡す指定)を持ちますが、これを呼ぶワークフロー "${workflow.id}" にはきっかけとなるレコードがありません(trigger に table を書かない schedule です)。`,
                hint: "trigger を on_create / on_update に変えるか、trigger に table を書く schedule にするか、via を外して全行を渡してください。",
              });
              continue;
            }
            if (viaField.reference_table !== triggerTable) {
              errors.push({
                path: `${path}/via`,
                message: `関数 "${fn.id}" の入力の via "${input.via}" は "${viaField.reference_table}" を参照していますが、これを呼ぶワークフロー "${workflow.id}" のトリガー元テーブルは "${triggerTable}" です。`,
                allowed_values: [triggerTable],
                hint: "via はトリガー元のレコードを指す reference フィールドでなければなりません(1ホップだけ・逆参照は作れません)。",
              });
            }
          }
        }
      }
    }
  });

  // --- 類型13(「見せる相手 / 書ける相手」の値域)は **`V8-M20` で撤去した** -------------
  //
  // **ここに在ったもの**: `allowedAudience`(予約4語 ∪ `ANONYMOUS` ∪ `app.user_kinds[].id`)と
  // `checkAudienceList()` と、その4箇所の呼び出し
  // (`view.audience` / `view_action.audience` / `field.audience` / `field.writable_by`)。
  //
  // **撤去した理由**: **その4層は `V8-M20` が全部廃止した**(台帳 `J-G27` / `J-G28` / `J-G29`。
  // 手続きは `ADR-0301`)。**このブロックは当たり先を1つも持たなくなった。**
  // **「値を1つも持たない集合に対して値域を検査する」コードを製品に残すと、次に読む人
  // (AI も人も)が「ここで値域が閉じている」と読み違える。**
  //
  // **【穴を隠さない。これは撤去で開いた穴ではない】**
  // **同じ値域(予約4語 ∪ `app.user_kinds[].id`)を `app.roles[].id` について検査する箇所は、
  // 今日1つも無い。** **実測**: スキーマ側は `$defs/app/properties/roles/items/properties/id` が
  // `"pattern": "^[a-z0-9_]{1,32}$"` の1本だけで値域を閉じておらず、適用時検査の側も、
  // 下の類型16 の doc が逐語で「**役割の識別子(`roles[].id`)が `user_kinds` に実在するかは、
  // ここでは1件も見ない**」と自ら申告している。
  // **この穴は `V8-M16` が開けて自ら申告したものであり、本撤去はそれを1バイトも広げていないし、
  // 塞いでもいない。** **`checkAudienceList` を残しても `app.roles[].id` は1文字も検査されない
  // ので、残すことに穴を塞ぐ効果は1ミリも無かった。**
  //
  // **【ここに値域検査を置き直さなかった理由。判断を明記する】**
  // **置き直すと、今日適用できているマニフェストが適用できなくなる**(`user_kinds` を宣言せずに
  // `roles[].id` へ任意の識別子を書いているものが実在する)。**それは撤去(語彙を減らす)では
  // なく、新しい拒否を足すことである。** **本マイルストーンの射程の外にある。**
  // **`V8-M16` が申告した穴の担い手は今日も `V8-M16` 側であり、そこは動かしていない。**

  // --- 類型17: アクセス権管理の宣言(`Z-G9` / `Z-G8`。`V7-M1-T05`)---------------------
  //
  // **`$defs/table` の6キー目 `access_control` が「規約どおりか」を適用時に見る。**
  // **外れたら差分全体を拒否する。警告に留めない**(`v7-m0.md` §6-2 の `Z-G9` の判定)。
  //
  // **なぜ schema ではなくここなのか**: **指した表・列の実在も、型が規約どおりかも、
  // 権限名の重複も、JSON Schema では表せない**(`schemas/manifest.schema.json` の
  // `access_control` の `$comment` が「**どれも JSON Schema では表せないので、適用時検査
  // (`V7-M1-T05`)の担当である**」と自ら申告している)。
  //
  // **`enabled: false` でも形は検査する。** **理由**: `Z-G37`(すでに使っている表に後から
  // 有効化できる)が本マイルストーンの主目的であり、**壊れた宣言を `enabled: false` で
  // 置いておけると、有効にした日に初めて落ちる。** **「同居の拒否」だけは `enabled: true`
  // のときに限る**(下の項目8。`enabled: false` は「宣言していない表」と同じ扱いなので、
  // そのときは何も効かず、したがって「書けるが効かない」も生じない)。
  //
  // **【この検査が止めないもの。誇張しない】**
  //  - **宣言している表そのものを `remove_table` で消す差分は、今日も通る**
  //    (宣言ごと消えるので、規約から外れた宣言は残らない)。
  //  - **付与表・メンバー表・グループ表を `remove_table` で消す差分は拒否される** ——
  //    **ただしそれは本検査が「指した表が実在するか」を見た結果であって、
  //    `remove_table` の側に何かを足したからではない。**
  //  - **判定(誰に何が見えるか)は1バイトも実装していない**(`V7-M3`)。
  //    **規約どおりの宣言を書いても、行の読取・書込・削除のふるまいは今日どおりである。**
  //  - **付与**行**の中身(存在しない権限名が入った行など)は1件も見ない** ——
  //    ここが見るのは宣言だけである。
  const nestReported = new Set<string>();
  tables.forEach((table, tableIndex) => {
    const raw = (table as unknown as { access_control?: unknown }).access_control;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return;
    }
    const declaration = raw as Record<string, unknown>;
    const base = `/app/tables/${tableIndex}/access_control`;
    const grant = asRecord(declaration.grant);
    const members = asRecord(declaration.members);
    const groups = asRecord(declaration.groups);

    /** 指した表を引く。実在しなければ**項目1**のエラーを立てて `undefined` を返す。 */
    const resolveDeclaredTable = (
      tableId: unknown,
      path: string,
      label: string,
    ): Table | undefined => {
      if (typeof tableId !== "string") {
        return undefined;
      }
      const found = referenceableById.get(tableId);
      if (found === undefined) {
        errors.push({
          path,
          message: `アクセス権管理の設定で${label}として指定された表 "${tableId}" が見つかりません。`,
          allowed_values: referenceableIds,
          hint: "実在する表のIDを書いてください。表のIDを変えたときは、この設定も書き換えてください(設定は表の名前変更に自動では追随しません)。",
        });
        return undefined;
      }
      return found;
    };

    /** 指した項目を引く。実在しなければ**項目2**のエラーを立てて `undefined` を返す。 */
    const resolveDeclaredField = (
      holder: Table | undefined,
      fieldId: unknown,
      path: string,
      label: string,
    ): Field | undefined => {
      if (holder === undefined || typeof fieldId !== "string") {
        return undefined;
      }
      const found = holder.fields.find((candidate) => candidate.id === fieldId);
      if (found === undefined) {
        errors.push({
          path,
          message: `アクセス権管理の設定で${label}として指定された項目 "${fieldId}" が、表 "${holder.id}" にありません。`,
          allowed_values: unique(holder.fields.map((candidate) => candidate.id)),
          hint: "実在する項目のIDを書いてください。項目を消したときは、この設定も書き換えてください(設定は項目の削除に自動では追随しません)。",
        });
        return undefined;
      }
      return found;
    };

    /** **項目3**(型)。参照でなければ / 参照先が違えばエラーを立てる。 */
    const requireReferenceTo = (
      field: Field | undefined,
      expectedTableId: string | undefined,
      path: string,
      label: string,
    ): void => {
      if (field === undefined) {
        return;
      }
      if (field.type !== "reference") {
        errors.push({
          path,
          message: `アクセス権管理の設定で${label}として指定された項目 "${field.id}" は、ほかの表を参照する項目でなければなりません(今は${FIELD_TYPE_LABEL[field.type]}の項目です)。`,
          hint: "参照(reference)の項目を作り直してから、この設定でその項目を指してください。",
        });
        return;
      }
      if (expectedTableId !== undefined && field.reference_table !== expectedTableId) {
        errors.push({
          path,
          message: `アクセス権管理の設定で${label}として指定された項目 "${field.id}" は、表 "${expectedTableId}" を参照していなければなりません(今は "${field.reference_table}" を参照しています)。`,
          allowed_values: [expectedTableId],
          hint: "参照先の表が食い違っていると、誰にどの行を渡したのかを決められません。",
        });
      }
    };

    /** **項目3**(型)。参照以外の型をそのまま突き合わせる。 */
    const requireFieldType = (
      field: Field | undefined,
      expected: FieldType,
      path: string,
      label: string,
    ): void => {
      if (field === undefined || field.type === expected) {
        return;
      }
      errors.push({
        path,
        message: `アクセス権管理の設定で${label}として指定された項目 "${field.id}" は、${FIELD_TYPE_LABEL[expected]}の項目でなければなりません(今は${FIELD_TYPE_LABEL[field.type]}の項目です)。`,
        hint: `この項目の型を ${expected} にするか、${expected} の項目を別に作ってそちらを指してください。`,
      });
    };

    // --- 項目1: 指した表が実在するか ------------------------------------------------
    const grantTable = resolveDeclaredTable(
      grant?.table,
      `${base}/grant/table`,
      "付与を記録する表",
    );
    const membersTable =
      members === undefined
        ? undefined
        : resolveDeclaredTable(members.table, `${base}/members/table`, "利用者の表");
    const groupsTable =
      groups === undefined
        ? undefined
        : resolveDeclaredTable(groups.table, `${base}/groups/table`, "グループの表");
    const membersTableId = typeof members?.table === "string" ? members.table : undefined;
    const groupsTableId = typeof groups?.table === "string" ? groups.table : undefined;

    // --- 項目9: 付与の相手を1つも指せない宣言を拒否する -----------------------------
    //
    // **相手を指す項目が無い付与表は、作れても1件も付与できない** ——
    // **「書けるが効かない」を作らないための拒否である**(項目8 と同じ理由)。
    if (grant !== undefined && grant.member === undefined && grant.group === undefined) {
      errors.push({
        path: `${base}/grant`,
        message:
          "アクセス権管理の設定に、権限を渡す相手を表す項目が1つもありません。利用者を指す項目かグループを指す項目の、どちらか一方は必要です。",
        hint: "付与を記録する表に、利用者の表を参照する項目(またはグループの表を参照する項目)を作り、この設定でその項目を指してください。",
      });
    }
    if (grant?.member !== undefined && members === undefined) {
      errors.push({
        path: `${base}/grant/member`,
        message:
          "アクセス権管理の設定で利用者を指す項目を書いていますが、利用者の表が宣言されていません。",
        hint: "利用者の表(と、ログインアカウントを持つ項目)を宣言するか、利用者を指す項目のほうを外してください。",
      });
    }
    if (grant?.group !== undefined && groups === undefined) {
      errors.push({
        path: `${base}/grant/group`,
        message:
          "アクセス権管理の設定でグループを指す項目を書いていますが、グループの表が宣言されていません。",
        hint: "グループの表を宣言するか、グループを指す項目のほうを外してください。",
      });
    }
    if (members?.group !== undefined && groups === undefined) {
      errors.push({
        path: `${base}/members/group`,
        message:
          "利用者の表でグループを指す項目を書いていますが、グループの表が宣言されていません。",
        hint: "グループの表を宣言するか、利用者の表のグループを指す項目のほうを外してください。",
      });
    }

    // --- 項目2 + 項目3: 指した列の実在と型 -------------------------------------------
    requireReferenceTo(
      resolveDeclaredField(grantTable, grant?.target, `${base}/grant/target`, "対象の行"),
      table.id,
      `${base}/grant/target`,
      "対象の行",
    );
    requireFieldType(
      resolveDeclaredField(grantTable, grant?.permission, `${base}/grant/permission`, "権限名"),
      "select",
      `${base}/grant/permission`,
      "権限名",
    );
    if (grant?.member !== undefined) {
      requireReferenceTo(
        resolveDeclaredField(grantTable, grant.member, `${base}/grant/member`, "権限を渡す相手"),
        membersTableId,
        `${base}/grant/member`,
        "権限を渡す相手",
      );
    }
    if (grant?.group !== undefined) {
      requireReferenceTo(
        resolveDeclaredField(
          grantTable,
          grant.group,
          `${base}/grant/group`,
          "権限を渡す相手のグループ",
        ),
        groupsTableId,
        `${base}/grant/group`,
        "権限を渡す相手のグループ",
      );
    }
    if (members !== undefined) {
      requireFieldType(
        resolveDeclaredField(
          membersTable,
          members.account,
          `${base}/members/account`,
          "ログインアカウント",
        ),
        "text",
        `${base}/members/account`,
        "ログインアカウント",
      );
      if (members.group !== undefined) {
        requireReferenceTo(
          resolveDeclaredField(
            membersTable,
            members.group,
            `${base}/members/group`,
            "利用者が属するグループ",
          ),
          groupsTableId,
          `${base}/members/group`,
          "利用者が属するグループ",
        );
      }
    }

    // --- 項目4 + 項目5: 権限名の宣言 --------------------------------------------------
    const permissions = Array.isArray(declaration.permissions) ? declaration.permissions : [];
    const permissionIds = permissions
      .map((permission) => (permission as { id?: unknown })?.id)
      .filter((id): id is string => typeof id === "string");
    const seenPermissionIds = new Set<string>();
    permissionIds.forEach((id, index) => {
      if (seenPermissionIds.has(id)) {
        errors.push({
          path: `${base}/permissions/${index}/id`,
          message: `権限名 "${id}" が重複しています。同じ権限名を2度書くことはできません。`,
          hint: "どちらか一方に別の名前を付けるか、片方を消してください。",
        });
        return;
      }
      seenPermissionIds.add(id);
    });
    const creatorPermission = declaration.creator_permission;
    if (typeof creatorPermission === "string" && !seenPermissionIds.has(creatorPermission)) {
      errors.push({
        path: `${base}/creator_permission`,
        message: `権限名 "${creatorPermission}" は宣言されていません(宣言されているのは ${permissionIds
          .map((id) => `"${id}"`)
          .join(" / ")} です)。`,
        allowed_values: unique(permissionIds),
        hint: "行を作った人に与える権限は、この表で宣言した権限名の中から選んでください。",
      });
    }

    // --- 項目6: 引き継ぎ元(inherit_from)---------------------------------------------
    const inheritFrom = Array.isArray(declaration.inherit_from) ? declaration.inherit_from : [];
    inheritFrom.forEach((fieldId, index) => {
      const path = `${base}/inherit_from/${index}`;
      requireReferenceTo(
        resolveDeclaredField(table, fieldId, path, "引き継ぎ元"),
        undefined,
        path,
        "引き継ぎ元",
      );
    });

    // --- 項目7: グループの中にグループを入れない(`Z-G8`)-----------------------------
    //
    // **禁じるのはグループ表 → グループ表だけである。** **利用者の表 → グループの表
    // (`members.group`)は今日も通る** —— そちらは「人がどのグループに属するか」であって
    // 入れ子ではない。
    if (groupsTable !== undefined && groupsTableId !== undefined) {
      const groupsTableIndex = tables.findIndex((candidate) => candidate.id === groupsTableId);
      groupsTable.fields.forEach((field, fieldIndex) => {
        if (field.type !== "reference" || field.reference_table !== groupsTableId) {
          return;
        }
        const path = `/app/tables/${groupsTableIndex}/fields/${fieldIndex}/reference_table`;
        if (nestReported.has(path)) {
          // 同じグループ表を2つの保護対象表が指していても、報告は1度だけにする。
          return;
        }
        nestReported.add(path);
        errors.push({
          path,
          message: `グループの表 "${groupsTableId}" が、グループの表自身を参照しています。グループの中にグループを入れることはできません。`,
          hint: "この参照の項目を消してください。グループの上下関係(親グループ)は、今日は表せません。",
        });
      });
    }

    // --- 項目8: 「書けるが効かない」設定の同居を拒否する -------------------------------
    //
    // **`v7-m0.md` §6-3b の3**(`st_public` を宣言した表でアクセス権管理を有効にすると、
    // その項目は**書けるが効かない**状態になる —— 横断論点14 が禁じた形なので適用時に拒否する)。
    //
    // **【`V8-M20` による書き直し。旧文の要点を残す】** **着手前、ここは2本を並べていた**
    // —— **1本目は `v7-m0.md` §5-4 の (iii)(逐語「同じ表に両方を宣言したら、
    // `st_admin_readable` は**書けるが効かない**状態になる」)、2本目が上の §6-3b の3 である。**
    // **`st_admin_readable` は `V8-M20` が廃止した**(台帳 `J-G30`。手続きは `ADR-0301`)ので、
    // **1本目の同居の拒否は検査ごと消えた。****今日この検査が拒否するのは `st_public` との
    // 同居 1 通りだけである。** **予約規約フィールドは 5本 → 4本
    // (`st_owner` / `st_public` / `st_undeletable` / `st_no_direct_create`)。**
    //
    // **【カーネルに予約規約フィールドの綴りが現れた。隠さない】** **この綴りは
    // `src/server/owner-scope.ts` の `PUBLIC_FIELD` の写しである。**
    // **カーネルは `src/server/` を import できない**(`ADR-0009` の層分離)ので写すしかない
    // —— **`RESERVED_ROLE_IDS` が同じ理由で写しになっているのと同型である。**
    if (declaration.enabled === true) {
      const collided = ACCESS_CONTROL_EXCLUSIVE_FIELDS.filter((fieldId) =>
        table.fields.some((field) => field.id === fieldId),
      );
      if (collided.length > 0) {
        errors.push({
          path: `${base}/enabled`,
          message: `表 "${table.id}" では、アクセス権管理と、${collided
            .map((fieldId) => `"${fieldId}"`)
            .join(" / ")} の項目による見せ方の設定を、同時に使うことはできません。`,
          hint: "どちらか一方にしてください。アクセス権管理を有効にすると、その項目は書けても1ミリも効かなくなります。",
        });
      }
    }
  });

  return errors.length > 0 ? invalid(errors) : valid();
}

/** `unknown` をそのままオブジェクトとして読む(配列と `null` は弾く)。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/**
 * **アクセス権管理と同居できない項目の綴り**(`v7-m0.md` §6-3b の3)。
 *
 * **`src/server/owner-scope.ts` の `PUBLIC_FIELD` の写しである。**
 * **カーネルは `src/server/` を import できない**(`ADR-0009` の層分離)。
 * **写しであることを隠さない** —— `RESERVED_ROLE_IDS` と同型の代償である。
 *
 * **【2026-08-10 追記(`V8-M20`。台帳 `J-G30`。手続きは `ADR-0301`)。旧文を1バイトも
 * 消していない】** **着手前のこの配列は2本だった** —— 逐語
 * `["st_admin_readable", "st_public"]`。**`st_admin_readable` は `V8-M20` が廃止したので、
 * 今日は1本である。** **拒否の通り数は 2 → 1 に減った** —— **`st_admin_readable` と
 * `access_control.enabled` の同居を拒否する検査は、対象そのものが無くなって消えた。**
 * **代わりに担うのは `app.roles[].rules` の「役割 × 対象(表)× 読取」である。**
 * **【正直に書く】代わりが立つ範囲は同じではない** —— **旧キーは表に1本足すだけで
 * 運営に読ませる宣言だったが、面では規則を書いた時点でその対象が allow-list になる。**
 *
 * **`st_owner` は入れない** —— **`v7-m0.md` §5-4 の (ii) が「`access_control.enabled` が真の
 * 表は `nonAdminTableAccess` が `"scoped"` を返す」と裁定しており、`st_owner` との同居は
 * その裁定の前提である。** **同居を拒否するのは「書けるが効かない」ものだけである。**
 */
const ACCESS_CONTROL_EXCLUSIVE_FIELDS: readonly string[] = ["st_public"];

/**
 * **束ねるキー(`report.group_by[].field`)に書ける予約名の判定に使う全量**
 * (`D-V8-126`。`V8-M9`。類型18c)。
 *
 * **中身は2系統である**:
 *
 * 1. **システム列3本**(`_id` / `_created_at` / `_updated_at`)—— **出所は
 *    `src/kernel/ddl.ts` の `SYSTEM_COLUMN_NAMES` であり、ここで綴り直していない。**
 * 2. **予約規約フィールド4本**(`st_owner` / `st_public` / `st_undeletable` /
 *    `st_no_direct_create`)—— **`src/server/owner-scope.ts` の4定数の**写し**である。**
 *    **カーネルは `src/server/` を import できない**(`ADR-0009` の層分離)ので写すしかない
 *    —— **`ACCESS_CONTROL_EXCLUSIVE_FIELDS` と `RESERVED_ROLE_IDS` が同じ理由で写しに
 *    なっているのと同型である。** **写しであることを隠さない。**
 *
 * **この配列に載っている名前のうち、束ねるキーに書けるのは `_id` ただ1つである**
 * (類型18c の表)。**残る6本は1つずつ拒否される。**
 *
 * **【正直に書く】この配列は「予約名の全量」ではない。** **`_files` などシステムが持つ
 * 表の名前は含んでいない**(表の名前であって列の名前ではない)。**含んでいるのは
 * 「表の**列**として現れうる予約された綴り」の全量である。**
 */
const RESERVED_GROUP_BY_NAMES: readonly string[] = [
  ...SYSTEM_COLUMN_NAMES,
  "st_owner",
  "st_public",
  "st_undeletable",
  "st_no_direct_create",
];

/** 型の名前を利用者の言葉にする(エラー文言に型の綴りだけを出さないため)。 */
const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  text: "文字(text)",
  long_text: "長い文章(long_text)",
  number: "数値(number)",
  boolean: "はい・いいえ(boolean)",
  date: "日付(date)",
  select: "選択肢(select)",
  reference: "参照(reference)",
  image: "画像(image)",
  file: "添付ファイル(file)",
};

/**
 * トリガー元レコードへの参照の接頭辞(限定12)。
 *
 * **`workflow-runner.ts:542` の `RECORD_PREFIX` と同じ文字列であること。**
 * 適用時に拒否する側(ここ)と実行時に解決する側で規則が食い違うのが最悪である。
 *
 * **【行番号の更新。V1-M2-T03 で追記】** T02 の時点では `:276` で正しかったが、
 * T03 が `WORKFLOW_MAX_DEPTH` と再発火抑止を足してずれた。**番号ではなく
 * 定数名(`RECORD_PREFIX`)で引き直すこと。**
 *
 * **【行番号の更新。V1-M2-T08 単位1 で追記】** `:420` → `:453`。T08 が時刻源
 * (`clock.ts` の import と `setWorkflowClock` / `resetWorkflowClock`)を runner の
 * 前半に足してずれた。**T03 の追記が予告したとおりの壊れ方が、予告どおりに再発した。**
 * **番号は3度目もずれる。定数名で引き直すこと。**
 */
const RECORD_REFERENCE_PREFIX = "$record.";

/**
 * リテラル target が受ける UUID 形(EC-G13 / ADR-0040 D2-a 選択肢A)。
 *
 * レコードの `_id` は `records.ts` の `crypto.randomUUID()`(標準 UUID)で発行される。
 * 定数リテラル target を UUID 形に限定することで `"bogus"` / `"trigger_record"` を apply 時に
 * 弾く。**ただし UUID 形の実在しない _id は依然通る**(実行時 failure。T-2 の原理的限界)。
 */
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * 実行履歴テーブルが**必ず持たなければならないフィールドの id と type**(V1-M2-T05a D1)。
 *
 * ## 出どころ
 *
 * 列の並びは `src/kernel/workflow-runner.ts` の `WORKFLOW_HISTORY_COLUMNS`、
 * 各列の型は `src/mcp/vocabulary.ts` の `WORKFLOW_HISTORY_TABLE_TEMPLATE` が示す
 * ひな形である。**`writeHistory` が実際に書く5キーと1対1で対応する。**
 *
 * ## なぜ `WORKFLOW_HISTORY_COLUMNS` を import しないのか
 *
 * `workflow-runner.ts` は `bun:sqlite` と `records.ts` を引き込む**実行時の層**である。
 * 本ファイルは DB を1つも触らない純粋な検証層であり、**適用時の検証が実行エンジンに
 * 依存する形にはしない。**(`src/mcp/vocabulary.ts` が同じ理由で import せず、
 * `vocabulary.test.ts` / `descriptions.test.ts` が値の一致をテストで固定しているのと
 * 同じ作法に揃えてある。)
 *
 * **したがって `WORKFLOW_HISTORY_COLUMNS` を変えたら、ここの追随が要る。**
 * 乖離は `workflow-referential-integrity.test.ts` の突き合わせテストが機械的に止める。
 *
 * ## 「ちょうどこの5列」ではない
 *
 * これは**下限**である。ADR-0013 §8c 問2 が `add_field` による列の追加を認めているので、
 * 余分な列があっても違反にしない。**減らすことと型を変えることだけができない。**
 */
const WORKFLOW_HISTORY_FIELD_SPEC = [
  ["ran_at", "date"],
  ["workflow", "text"],
  ["trigger_type", "text"],
  ["status", "text"],
  ["error", "long_text"],
] as const satisfies readonly (readonly [ResourceId, FieldType])[];

/**
 * `$record._id`(トリガー元レコードのID。静的には string の値)。
 *
 * **`workflow-runner.ts` の解決器と揃えてある** —— あちらは `$record._id` を
 * `record._id`(UUID 文字列)へ、`$record.<列>` をその列の値へ解決する。
 */
const RECORD_ID_REFERENCE = "$record._id";

/**
 * 値タイプの日本語ラベル(エラー文面用)。JS の typeof に対応する3種だけ。
 */
const JS_TYPE_LABEL: Record<"string" | "number" | "boolean", string> = {
  string: "文字列",
  number: "数値",
  boolean: "真偽値",
};

/**
 * フィールドの列型を、実行時が要求する JS の型へ写像する(V1-M9-T13 (2)。ADR-0029)。
 *
 * `records.ts` の `validateDbFreeFieldValue` の実装と1対1で対応する:
 * number → number、boolean → boolean、text/long_text/date/select/reference → string。
 * **date/select/reference の値レベル制約(ISO 形式・options 一致・実在)は JS 型では
 * なく実行時の追加検査**であり、ここでは string に畳む(静的に確定しないものを
 * 適用時に拒否すると過剰拒否になる)。
 */
function fieldTypeToJsType(type: FieldType): "string" | "number" | "boolean" {
  switch (type) {
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "text":
    case "long_text":
    case "date":
    case "select":
    case "reference":
    // image / file 値は `_files` の file_id を表す文字列(V2-M2 / ADR-0035 / V5-M16 /
    // ADR-0161)。実在確認は実行時の追加検査であり、静的な JS 型としては string に
    // 畳む(reference と同型)。
    case "image":
    case "file":
      return "string";
  }
}

/**
 * アクションの値の**静的に確定する JS 型**を導出する(V1-M9-T13 (2)。ADR-0029)。
 *
 * - リテラル(`$` で始まらない固定文字列)→ string。
 * - `$record._id` → string(レコードIDの文字列)。
 * - `$record.<列>` → トリガー元テーブルのその列の JS 型(`fieldTypeToJsType`)。
 *
 * **確定できないときは undefined を返し、呼び出し側は検査をスキップする**:
 * - `triggerTable === undefined`(**`table` を書かない** schedule)—— `$record` は
 *   類型7 が既に拒否済み。`table` を書いた schedule はその表を渡すので確定する(ADR-0063)。
 * - `$record.<トリガー元に無い列>` —— 元の型が引けない((2) の射程外。二重報告しない)。
 *
 * どちらも `referenceableById`(メモリ内マップ)参照だけで、DB を1バイトも読まない。
 */
function staticActionValueType(
  value: string,
  triggerTable: ResourceId | undefined,
  referenceableById: Map<ResourceId, Table>,
): "string" | "number" | "boolean" | undefined {
  if (!value.startsWith(RECORD_REFERENCE_PREFIX)) {
    return "string"; // リテラル(固定文字列)は必ず string。
  }
  if (triggerTable === undefined) {
    // schedule トリガーには `$record` が無く、類型7 がこの参照を既に拒否している。
    return undefined;
  }
  if (value === RECORD_ID_REFERENCE) {
    return "string";
  }
  const fieldId = value.slice(RECORD_REFERENCE_PREFIX.length);
  const sourceType = referenceableById
    .get(triggerTable)
    ?.fields.find((field) => field.id === fieldId)?.type;
  if (sourceType === undefined) {
    // トリガー元テーブル不在(類型6 が報告)/ トリガー元に無い列((2) の射程外)。
    return undefined;
  }
  return fieldTypeToJsType(sourceType);
}

/**
 * 型不整合の hint(1)—— 書き込み先の列型を値に合わせる向き。
 */
function destTypeSuggestion(valueJsType: "string" | "number" | "boolean"): string {
  switch (valueJsType) {
    case "string":
      return "text か long_text 型にする(文字列をそのまま保存できます)";
    case "number":
      return "number 型にする";
    case "boolean":
      return "boolean 型にする";
  }
}

/**
 * 型不整合の hint(2)—— 値の型を書き込み先の列に合わせる向き。
 */
function valueSuggestion(destJsType: "string" | "number" | "boolean"): string {
  switch (destJsType) {
    case "number":
      return '"$record.<number 型の列>" のように number 型フィールドを参照する(リテラルや文字列系フィールドの参照は number 列に書けません)';
    case "boolean":
      return '"$record.<boolean 型の列>" のように boolean 型フィールドを参照する(true/false のリテラルや文字列は boolean 列に書けません)';
    case "string":
      return "固定の文字列か、文字列系フィールド(text/long_text/date/select/reference)の参照にする";
  }
}

/**
 * JSON Pointer の1トークンをエスケープする(RFC 6901 §3)。
 *
 * path に**マップのキー**が入るのはここが最初である(他は固定文字列と配列添字だけ)。
 * `values` のキーはフィールドIDなのでスキーマ上 `~` も `/` も含まないが、
 * `validateReferentialIntegrity` は単独でも呼べる(構造検証を前提にしない入口がある)
 * ので、**pointer が壊れないことをこの層で保証する。**
 */
function escapePointerToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

/** 出現順を保ったまま重複を取り除く。 */
function unique(ids: readonly ResourceId[]): ResourceId[] {
  return [...new Set(ids)];
}

/**
 * 重複するIDの「2件目以降の出現箇所」を報告する。
 * 最初の出現を正とすることで、修正すべき箇所が一意に定まる。
 */
function collectDuplicates(
  ids: readonly ResourceId[],
  onDuplicate: (index: number, id: ResourceId) => void,
): void {
  const seen = new Set<ResourceId>();
  ids.forEach((id, index) => {
    if (seen.has(id)) {
      onDuplicate(index, id);
      return;
    }
    seen.add(id);
  });
}
