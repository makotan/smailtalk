#!/usr/bin/env bun
/**
 * CP-V1-8 の機械照合(V1-M8-T02。確認方法2・3 + 追加検査)。
 *
 *   bun run scripts/cp-v1-8-audit.ts --data-root <path> --app <app_id> --doc <doc.json>
 *                                    [--report <text>] [--report-json <json>]
 *
 * ## このスクリプトは生成器を1行も import しない(ADR-0025 §4-6)
 *
 * `src/kernel/requirements-doc.ts` を import せず、実在集合は
 * **`<dataRoot>/apps/<app_id>/manifest.json` と `<dataRoot>/kernel.sqlite` の changelog を
 * 独立に読んで**構築する。生成側と集合構築を共有すると、**集合の作り方が間違っていても
 * 両方が通る**(循環する)。`RequirementsDoc.identifiers` も入力に使わない —— あれは
 * 生成器が自分で作った集合であり、監査の入力にすると同じ循環が復活する。
 *
 * カーネルから値として読むのは**語彙定数だけ**である(`FIELD_TYPES` 等)。ADR-0025 §4-2 が
 * 「語彙スパンの中身がカーネルの語彙定数の要素と完全一致すること」を検査対象に定めており、
 * 照合先そのものを写経すると語彙が増えたときに静かに食い違う。**語彙は照合先であって、
 * 実在集合の構築経路ではない。**
 *
 * ## 何を検査し、何を検査しないか(誇張しない。§限界)
 *
 * **検査する**:
 *  1. 確認方法2(全数): `sources` が空の記述が0件であること
 *  2. 確認方法3: markdown のバッククォートスパンの中身が
 *     「独立に構築した識別子集合 ∪ カーネルの語彙定数 ∪ 数値(`^-?[0-9]+$`)」と**完全一致**
 *     (部分文字列マッチを使わない。日本語には語境界が無く `本` ⊂ `本一覧` だから。§4-1)
 *  3. 確認方法3: 鉤括弧スパンの中身が **manifest 由来の表示名集合と完全一致**
 *  4. `id` スロットが**グループごとの**実在集合の要素であること(markdown 側の平坦な集合より強い)
 *  5. `term` スロットが語彙グループの要素であること
 *  6. `verbatim` スロットが出典の該当フィールドと**バイト一致**すること
 *  7. すべての `sources` の出典が**実在**すること(changelog なら seq と diff_id、
 *     manifest なら JSON Pointer が解決できること)
 *  8. 件数スロットの**独立な数え直し**(`overview.scale` の4件数と `data.table` の
 *     フィールド数のみ。ADR-0025 §4-4 (ii))
 *
 * **検査しない(担当が別か、手段が無い)**:
 *  - **残差検査(ADR-0025 §4-3)は、このスクリプトの担当ではない。**
 *    残差検査は「地の文がテンプレート定数の断片の連結であること」を見るもので、
 *    **テンプレート定数表を必要とする**。監査は生成器を import しない(§4-6)ので、
 *    表に到達する手段が無い。**表をこちら側に写せば二重管理になり、二重管理は必ず食い違う**
 *    —— 食い違ったとき、監査は「テンプレートが変わった」ことを「文書が壊れた」と報告するか、
 *    逆に古い表で通してしまう。したがって**残差検査はカーネルのユニットテスト
 *    (`src/kernel/requirements-doc.test.ts`)が担当し、本スクリプトはそれ以外を担当する**
 *    という分担にしてある。**「残差検査もやった」とは書かない。**
 *  - **数値の捏造一般**(§4-4)。数値スパンは形しか見ておらず、数え直すのは上の 8 の範囲だけ。
 *    位置(何番目)・seq・時分は数え直していない。
 *  - **スパンのグループ整合**。markdown からはスパンがどのグループのものか分からないので、
 *    「テーブルIDの位置にビューIDが書かれている」類は平坦な集合照合では捕まらない
 *    (4 の slot 側検査が、slot に届く範囲でこれを補う)。
 *  - **文レベルの捏造**(実在するリソースについて実在しない振る舞いを述べる)。
 *    上位計画 `08-requirements-doc.md:78` が既にこの不足を認めており、確認方法1 に残る。
 *  - **capability が実在するか**(§限界6)。capability はマニフェストに現れないので、
 *    照合できるのは「マニフェスト上の値以外が混ざっていないこと」までである。
 *
 * ## 生成器がグループや語彙を増やしたときの振る舞い
 *
 * グループ名の一覧(`IDENTIFIER_GROUPS`)と、`as const` 配列を持たない語彙タグ
 * (`TRIGGER_TYPES` 等)は、このスクリプトが独立に持っている。カーネル側が増やしたのに
 * ここが古いままなら、監査は**厳しすぎる側に外れる**(実在するものを「捏造」と報告する)。
 * **緩む側には外れない** —— 未知のグループ・未知の語彙は不合格として扱う(fail-closed)。
 *
 * 終了コード: 0=全検査合格 / 1=1件以上の不合格 / 2=入力エラー。
 * **0件検査で合格と報告しない** —— 検査対象が1つも無い場合は不合格にする(空回りの検出)。
 */
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHANGELOG_KINDS } from "../src/kernel/meta-store.ts";
import {
  DIFF_OPS,
  FIELD_TYPES,
  RESOURCE_KINDS,
  SORT_ORDERS,
  VIEW_TYPES,
} from "../src/kernel/types.ts";
import { SYSTEM_TABLES } from "../src/shared/system-tables.ts";

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_INPUT_ERROR = 2;

const USAGE = [
  "使い方: bun run scripts/cp-v1-8-audit.ts --data-root <path> --app <app_id> --doc <doc.json>",
  "                                        [--report <text>] [--report-json <json>]",
  "",
  "  --data-root <path>    データルート(kernel.sqlite と apps/ がある場所)",
  "  --app <app_id>        対象アプリのID",
  "  --doc <doc.json>      検査する RequirementsDoc の JSON(CLI の --json 出力)",
  "  --report <file>       人間可読テキストの書き出し先",
  "  --report-json <file>  機械可読 JSON の書き出し先",
  "",
  "終了コード: 0=合格 / 1=不合格 / 2=入力エラー",
].join("\n");

class InputError extends Error {}

// --- 素朴な型の取り出し(`any` を使わない)--------------------------------------------

type Json = unknown;
type JsonObject = Record<string, unknown>;

function isObject(value: Json): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectAt(value: Json, where: string): JsonObject {
  if (!isObject(value)) {
    throw new InputError(`${where} がオブジェクトではありません。`);
  }
  return value;
}

function arrayAt(value: Json, where: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new InputError(`${where} が配列ではありません。`);
  }
  return value;
}

function stringAt(value: Json, where: string): string {
  if (typeof value !== "string") {
    throw new InputError(`${where} が文字列ではありません。`);
  }
  return value;
}

/** 文字列ならそれ、無ければ undefined(任意項目の読み出し)。 */
function optionalString(value: Json): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** 配列ならその要素、無ければ空配列(任意の配列項目の読み出し)。 */
function optionalArray(value: Json): unknown[] {
  return Array.isArray(value) ? value : [];
}

// --- JSON Pointer(RFC6901)-----------------------------------------------------------

/** ポインタを解決する。辿れなければ `undefined`(= 出典が実在しない)。 */
function resolvePointer(root: Json, pointer: string): Json | undefined {
  if (pointer === "") {
    return root;
  }
  if (!pointer.startsWith("/")) {
    return undefined;
  }
  let current: Json = root;
  for (const rawToken of pointer.slice(1).split("/")) {
    const token = rawToken.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      if (!/^[0-9]+$/.test(token)) {
        return undefined;
      }
      current = current[Number(token)];
    } else if (isObject(current)) {
      if (!(token in current)) {
        return undefined;
      }
      current = current[token];
    } else {
      return undefined;
    }
    if (current === undefined) {
      return undefined;
    }
  }
  return current;
}

// --- 実在集合の独立な構築(生成器を使わない)-------------------------------------------

/** 識別子・表示名のグループ。生成器の `IdentifierGroup` と同じ名前を使う(照合のため)。 */
const IDENTIFIER_GROUPS = [
  "app_id",
  "table_id",
  "field_id",
  "view_id",
  "workflow_id",
  "function_id",
  "diff_id",
  "applied_at",
  "app_name",
  "table_name",
  "field_name",
  "view_name",
  "workflow_name",
  "function_name",
  "capability_name",
  /**
   * アクションの `values` / `payload` / `input` のキー(ADR-0025 改訂1)。
   * **`capability_name` と同じく自己言及的**である —— スキーマがこれらのキーに
   * `propertyNames` 制約を持たないので、実在集合はマニフェスト上のキーそのものから作るしかない。
   * 照合できるのは「他のパスから来た値が混ざっていないこと」までである。
   */
  "action_key_name",
  /**
   * **詳細画面の項目のまとまりの名前**(`view.field_groups` のキー。ADR-0126 A5 / A8)。
   * **`action_key_name` / `capability_name` と同じく自己言及的**である —— スキーマは
   * まとまりの名前に長さの制約しか置いていないので、実在集合はマニフェスト上のキー
   * そのものから作るしかない。照合できるのは「他のパスから来た値が混ざっていないこと」まで。
   * **`_name` で終わるので鉤括弧の側で照合される。**
   */
  "field_group_name",
  /**
   * **持ち主が発行した逃げ道(任意 CSS)の資産名**(`view.custom_css.asset`。ADR-0145 A4 / A9)。
   * **`capability_name` / `field_group_name` と同じく自己言及的**である —— **照合先(owner
   * 専用の資産ストア)がマニフェストの外に在る**ので、実在集合はマニフェスト上の値そのもの
   * から作るしかない。照合できるのは「他のパスから来た値が混ざっていないこと」まで。
   * **監査も資産ストアを1度も開かない。CSS のバイト列を1バイトも読まない**(憲法1)。
   * **`_name` で終わるので鉤括弧の側で照合される。**
   */
  "escape_hatch_asset_name",
  /**
   * **役割の識別子**(`app.roles[].id`)と**役割の表示名**(`app.roles[].name`)、
   * および**ボタンの識別子**(`view.actions[].id`)の3グループ(`V8-M22`。`ADR-0315`)。
   * **`role_id` は `action_key_name` / `field_group_name` / `escape_hatch_asset_name` と
   * 同じく自己言及的**である —— スキーマは `^[a-z0-9_]{1,32}$` のパターン1本しか置いておらず、
   * 実在集合はマニフェスト上の `app.roles[].id` そのものから作るしかない。照合できるのは
   * 「他のパスから来た値が混ざっていないこと」までである。
   * `view_action_id` の実在集合は `view.actions[].id`(`id` を書いたボタンだけ)である。
   * **`role_name` は `_name` で終わるので鉤括弧の側で照合される。**
   * **`role_id` / `view_action_id` はバッククォートの側で照合される。**
   */
  "role_id",
  "role_name",
  "view_action_id",
  /*
   * **changelog の `operations` に現れた識別子**(ADR-0025 改訂2)。
   * マニフェストの実在集合とは別で、消された・改名された・undo で巻き戻された識別子を含む
   * —— 履歴節が語るのは「当時そう書かれていた」ことだからである。
   * **この5グループも changelog を独立に読んで組み立てる**(`buildHistoricalSets`)。
   * 規則は「履歴節が描く識別子ちょうど」であり、生成器の実装を読まずとも
   * changelog の operations から再現できる(§4-6 の独立性は保たれる)。
   */
  "historical_table_id",
  "historical_field_id",
  "historical_view_id",
  "historical_workflow_id",
  "historical_function_id",
] as const;
type IdentifierGroup = (typeof IDENTIFIER_GROUPS)[number];

type IdentifierSets = Record<IdentifierGroup, Set<string>>;

/** 表示名として鉤括弧で描かれるグループ(ADR-0025 §4-2: `*_name`)。 */
function isDisplayNameGroup(group: IdentifierGroup): boolean {
  return group.endsWith("_name");
}

/** changelog の1行(独立に読んだもの)。 */
type Entry = {
  seq: number;
  diff_id: string;
  applied_at: string;
  /** JSON Pointer の解決先。カーネルの `ChangelogEntry` と同じ形に組み直したもの。 */
  object: JsonObject;
};

function readManifest(dataRoot: string, appId: string): JsonObject {
  const path = join(dataRoot, "apps", appId, "manifest.json");
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (cause) {
    throw new InputError(
      `マニフェスト "${path}" を読み込めません(${cause instanceof Error ? cause.message : String(cause)})。`,
    );
  }
  return objectAt(JSON.parse(text) as Json, `"${path}"`);
}

function readEntries(dataRoot: string, appId: string): Entry[] {
  const path = join(dataRoot, "kernel.sqlite");
  const db = new Database(path, { readonly: true });
  try {
    const rows = db
      .query<
        {
          seq: number;
          app_id: string;
          diff_id: string;
          intent: string;
          operations: string;
          applied_at: string;
          snapshot: string | null;
          kind: string;
          undo_target_seq: number | null;
        },
        [string]
      >(
        `SELECT "seq", "app_id", "diff_id", "intent", "operations", "applied_at", "snapshot",
                "kind", "undo_target_seq"
         FROM "changelog" WHERE "app_id" = ? ORDER BY "seq" ASC`,
      )
      .all(appId);
    return rows.map((row) => ({
      seq: row.seq,
      diff_id: row.diff_id,
      applied_at: row.applied_at,
      object: {
        seq: row.seq,
        app_id: row.app_id,
        diff_id: row.diff_id,
        intent: row.intent,
        operations: JSON.parse(row.operations) as Json,
        applied_at: row.applied_at,
        snapshot: row.snapshot,
        kind: row.kind,
        undo_target_seq: row.undo_target_seq,
      },
    }));
  } finally {
    db.close();
  }
}

type HistoricalSets = {
  historical_table_id: Set<string>;
  historical_field_id: Set<string>;
  historical_view_id: Set<string>;
  historical_workflow_id: Set<string>;
  historical_function_id: Set<string>;
};

/**
 * **changelog の `operations` に現れた識別子**の集合(ADR-0025 改訂2)。
 *
 * 履歴節は「当時そう書かれていた」ことを語るので、**消された・改名された・undo で
 * 巻き戻された識別子**は現在のマニフェストに無い。それらを現在の実在集合だけで照合すると、
 * 実在した履歴を「捏造」と誤判定する。
 *
 * **全エントリを見る**(生きている apply に絞らない)—— 取り消された apply も
 * 「取り消された」と明示して履歴に残るためである(§8-4)。
 *
 * 規則は差分操作15種の形そのものから決まる(id を持つキーを拾うだけ)。生成器の
 * 実装を読まなくても changelog から再現できるので、§4-6 の独立性は保たれる。
 */
function buildHistoricalSets(entries: readonly Entry[]): HistoricalSets {
  const tables = new Set<string>();
  const fields = new Set<string>();
  const views = new Set<string>();
  const workflows = new Set<string>();
  const functions = new Set<string>();

  /** `{ id: "..." }` を持つオブジェクト、または ID の文字列そのものから ID を取り出す。 */
  const idOf = (value: Json): string | undefined =>
    typeof value === "string" ? value : isObject(value) ? optionalString(value.id) : undefined;

  const add = (set: Set<string>, value: string | undefined): void => {
    if (value !== undefined) {
      set.add(value);
    }
  };

  for (const entry of entries) {
    for (const raw of optionalArray(entry.object.operations)) {
      if (!isObject(raw)) {
        continue;
      }
      const op = optionalString(raw.op);
      const changes = isObject(raw.changes) ? raw.changes : undefined;
      switch (op) {
        case "add_table":
          add(tables, idOf(raw.table));
          if (isObject(raw.table)) {
            for (const field of optionalArray(raw.table.fields)) {
              add(fields, idOf(field));
            }
          }
          break;
        case "remove_table":
          add(tables, idOf(raw.table));
          break;
        case "change_table":
          add(tables, idOf(raw.table));
          add(tables, optionalString(changes?.id));
          break;
        case "add_field":
        case "remove_field":
          add(tables, idOf(raw.table));
          add(fields, idOf(raw.field));
          break;
        case "change_field":
          add(tables, idOf(raw.table));
          add(fields, idOf(raw.field));
          add(fields, optionalString(changes?.id));
          break;
        case "add_view":
        case "update_view":
        case "remove_view":
          add(views, idOf(raw.view));
          break;
        case "add_workflow":
        case "update_workflow":
        case "remove_workflow":
          add(workflows, idOf(raw.workflow));
          break;
        case "add_function":
        case "update_function":
        case "remove_function":
          add(functions, idOf(raw.function));
          break;
        default:
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
 * マニフェストと changelog から、グループごとの実在集合を作る。
 *
 * **システムテーブル(`_apps` / `_changelog` / `_ai_usage`)を含める** —— ビューは
 * ADR-0006 の投影を対象に取れるので、含めないと実在する画面の記述を「捏造」と誤判定する。
 * **関数の出力フィールドID も含める** —— マニフェストの `functions[].output.fields[].id` は
 * テーブルのフィールドではないが、実在する定義である。
 */
function buildIdentifierSets(manifest: JsonObject, entries: readonly Entry[]): IdentifierSets {
  const app = objectAt(manifest.app, "manifest の /app");
  const tables = optionalArray(app.tables).map((t, i) => objectAt(t, `/app/tables/${i}`));
  const views = optionalArray(app.views).map((v, i) => objectAt(v, `/app/views/${i}`));
  const workflows = optionalArray(app.workflows).map((w, i) => objectAt(w, `/app/workflows/${i}`));
  const functions = optionalArray(app.functions).map((f, i) => objectAt(f, `/app/functions/${i}`));

  const fieldsOf = (table: JsonObject, where: string): JsonObject[] =>
    optionalArray(table.fields).map((f, i) => objectAt(f, `${where}/fields/${i}`));

  const outputFieldsOf = (fn: JsonObject, where: string): JsonObject[] =>
    optionalArray(objectAt(fn.output, `${where}/output`).fields).map((f, i) =>
      objectAt(f, `${where}/output/fields/${i}`),
    );

  const capabilityNames: string[] = [];
  const actionKeyNames: string[] = [];
  // **項目のまとまりの名前**(ADR-0126 A5 / A8)。**生成器を1行も読まずに、マニフェストの
  // `views[].field_groups` のキーをそのまま集める** —— 規則は「詳細画面が持つ
  // `field_groups` のキー全部」であり、§4-6 の独立性は保たれる。
  const fieldGroupNames: string[] = [];
  // **逃げ道(任意 CSS)の資産名**(ADR-0145 A4 / A9)。**生成器を1行も読まずに、
  // マニフェストの `views[].custom_css.asset` をそのまま集める。**
  // **資産ストアを1度も開かない** —— 実在を照合しないのは生成器と同じである(A7)。
  const escapeHatchAssetNames: string[] = [];
  // **ボタンの識別子**(`view.actions[].id`。`V8-M22`。`ADR-0315`)。**生成器を1行も読まずに、
  // マニフェストの `views[].actions` のうち `id` を書いたものだけを集める**
  // (`id` は任意キーなので、書いていないボタンは集合に入らない)。
  const viewActionIds: string[] = [];
  for (const view of views) {
    const groups = view.field_groups;
    if (isObject(groups)) {
      fieldGroupNames.push(...Object.keys(groups));
    }
    const customCss = view.custom_css;
    if (isObject(customCss)) {
      const asset = optionalString(customCss.asset);
      if (asset !== undefined) {
        escapeHatchAssetNames.push(asset);
      }
    }
    for (const rawAction of optionalArray(view.actions)) {
      if (isObject(rawAction)) {
        const id = optionalString(rawAction.id);
        if (id !== undefined) {
          viewActionIds.push(id);
        }
      }
    }
  }
  // **役割の識別子・表示名**(`app.roles[].id` / `app.roles[].name`。`V8-M22`。`ADR-0315`)。
  // **生成器を1行も読まずに、マニフェストの `app.roles` をそのまま集める。**
  // `roles` は省略可なので、省略しているマニフェストでは空集合になる。
  const roleIds: string[] = [];
  const roleNames: string[] = [];
  for (const rawRole of optionalArray(app.roles)) {
    if (isObject(rawRole)) {
      const id = optionalString(rawRole.id);
      if (id !== undefined) {
        roleIds.push(id);
      }
      const name = optionalString(rawRole.name);
      if (name !== undefined) {
        roleNames.push(name);
      }
    }
  }
  for (const fn of functions) {
    for (const capability of optionalArray(fn.capabilities)) {
      const name = optionalString(capability);
      if (name !== undefined) {
        capabilityNames.push(name);
      }
    }
  }
  workflows.forEach((workflow, index) => {
    optionalArray(workflow.actions).forEach((raw, position) => {
      const action = objectAt(raw, `/app/workflows/${index}/actions/${position}`);
      const name = optionalString(action.connection) ?? optionalString(action.capability);
      if (name !== undefined) {
        capabilityNames.push(name);
      }
      // `create_record` / `update_record` は values、`call_external` は payload、
      // `ai_transform` は input のキーが文書に現れる(ADR-0025 改訂1)。
      for (const key of ["values", "payload", "input"]) {
        const table = action[key];
        if (isObject(table)) {
          actionKeyNames.push(...Object.keys(table));
        }
      }
    });
  });

  const collect = (values: (string | undefined)[]): Set<string> =>
    new Set(values.filter((value): value is string => value !== undefined));

  return {
    app_id: collect([optionalString(app.id)]),
    table_id: collect([
      ...tables.map((t) => optionalString(t.id)),
      ...SYSTEM_TABLES.map((t) => t.id),
    ]),
    field_id: collect([
      ...tables.flatMap((t, i) => fieldsOf(t, `/app/tables/${i}`).map((f) => optionalString(f.id))),
      ...SYSTEM_TABLES.flatMap((t) => t.fields.map((f) => f.id)),
      ...functions.flatMap((fn, i) =>
        outputFieldsOf(fn, `/app/functions/${i}`).map((f) => optionalString(f.id)),
      ),
    ]),
    view_id: collect(views.map((v) => optionalString(v.id))),
    workflow_id: collect(workflows.map((w) => optionalString(w.id))),
    function_id: collect(functions.map((f) => optionalString(f.id))),
    diff_id: collect(entries.map((e) => e.diff_id)),
    applied_at: collect(entries.map((e) => e.applied_at)),
    app_name: collect([optionalString(app.name)]),
    table_name: collect([
      ...tables.map((t) => optionalString(t.name)),
      ...SYSTEM_TABLES.map((t) => t.name),
    ]),
    field_name: collect([
      ...tables.flatMap((t, i) =>
        fieldsOf(t, `/app/tables/${i}`).map((f) => optionalString(f.name)),
      ),
      ...SYSTEM_TABLES.flatMap((t) => t.fields.map((f) => f.name)),
    ]),
    view_name: collect(views.map((v) => optionalString(v.name))),
    workflow_name: collect(workflows.map((w) => optionalString(w.name))),
    function_name: collect(functions.map((f) => optionalString(f.name))),
    capability_name: collect(capabilityNames),
    action_key_name: collect(actionKeyNames),
    field_group_name: collect(fieldGroupNames),
    escape_hatch_asset_name: collect(escapeHatchAssetNames),
    role_id: collect(roleIds),
    role_name: collect(roleNames),
    view_action_id: collect(viewActionIds),
    ...buildHistoricalSets(entries),
  };
}

// --- 語彙(照合先。カーネルの定数をそのまま読む)---------------------------------------

/**
 * `trigger` / `action` / `function.input.source` のタグだけは、対応する `as const` 配列が
 * カーネルに無く `types.ts` の判別共用体のタグとしてのみ存在する(生成器の同名定数と同じ理由)。
 * **ここに書き下すのは型のタグの写しであって、語彙を1つも増やしていない。**
 * カーネルが新しいタグを足したのにここが古いままなら、この監査は**厳しすぎる側に外れる**
 * (実在する語彙を「捏造」と報告する)。緩む側に外れないことだけは構造で決まっている。
 */
// **【`V5-M25-T01` / `L-G8` / `ADR-0174` 限定1】4値目 `manual` を1値足した(3 → 4)。**
// **これは型のタグの写しであって、語彙を1つも増やしていない。**
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
 * **見せる相手 / 書ける相手のロール5値** と **選択肢の強調の度合い4値**(ADR-0126 A6 / A8)。
 *
 * **カーネルの語彙定数ではなく、`schemas/manifest.schema.json` の enum の写しである** ——
 * `audience` / `writable_by` / `emphasis` はカーネルの型に1つも現れない
 * (`ADR-0070` 限定5 / `ADR-0071` 限定6 / `ADR-0076` 限定7 が `src/kernel/` を閉じたため)。
 *
 * **生成器と同じ値を2箇所が独立に持つのは `ADR-0025` §4-6 の設計そのものである**
 * (循環回避)。**その代償として、片方だけ直されて食い違う穴が2本増えた**
 * (`ADR-0126` Consequences 6)。**外れる向きは上の3つと同じで、厳しすぎる側である**
 * —— 実在する語彙を「捏造」と報告する。**緩む側には外れない。**
 *
 * ---
 *
 * **【2026-08-10 追記(`V8-M20`。台帳 `J-G27` / `J-G28` / `J-G29`。手続きは `ADR-0301`)。
 * 上の doc の「スキーマの enum の写しである」は、5値のほうについては今日は偽である。
 * 1バイトも消していない】**
 *
 * **`view.audience` / `field.audience` / `field.writable_by` / `view_action.audience` の
 * 4キーは廃止され、スキーマにその値域が1つも残っていない。**
 * **したがって `AUDIENCE_ROLES` は今日、写す相手を持たない孤児である** ——
 * **同じ値を持つ生成器側(`src/kernel/requirements-doc.ts` の `AUDIENCE_ROLES`)も、
 * どのテンプレートからも使われていない**(同ファイルの doc が自ら申告している)。
 *
 * **【それでも消していない理由】** **`ADR-0301` は撤去の各単位が台帳の単位を名指しで
 * 根拠にすることを求めており、`V8-M20` の台帳(`J-G27`〜`J-G30`)に、この監査スクリプトの
 * 内部語彙グループを撤去する単位は1件も無い。** **生成器側が同じ理由で残されているのと
 * 揃えてある。** **2つが一致することは `scripts/audience-role-sync.test.ts` が今日も機械で
 * 固定している**(そちらは写しが4箇所から2箇所に減ったことを記録している)。
 * **`EMPHASIS_LEVELS`(4値)は1バイトも影響を受けていない。**
 */
const AUDIENCE_ROLES = ["owner", "editor", "viewer", "customer", "anonymous"] as const;
const EMPHASIS_LEVELS = ["neutral", "info", "caution", "danger"] as const;

/**
 * **画面の見せ方のプリセット8軸の値**(ADR-0144 A5 / A6 / A10)。
 *
 * **`AUDIENCE_ROLES` / `EMPHASIS_LEVELS` と同じく `schemas/manifest.schema.json` の
 * `$defs/view` の enum の写しであり、生成器を1行も import せずに独立に持つ**
 * (`ADR-0025` §4-6 の循環回避)。**その代償として、片方だけ直されて食い違う穴が8本増えた**
 * (`ADR-0144` Consequences 5)。**外れる向きは他の写しと同じで、厳しすぎる側である** ——
 * 実在する語彙を「捏造」と報告する。**緩む側には外れない。**
 *
 * **`preset_field_columns`(`1` / `2`)はここに無い** —— **`number` スロットで写すので
 * 語彙タグにならない**(`ADR-0144` A7)。
 */
const COLUMN_ALIGNS = ["left", "center", "right"] as const;
const COLUMN_WIDTHS = ["narrow", "standard", "wide"] as const;
const PAGER_POSITIONS = ["top", "bottom", "both"] as const;
const LABEL_PLACEMENTS = ["inline", "stacked"] as const;
const IMAGE_SIZES = ["thumbnail", "medium", "original"] as const;
const TEXT_PREVIEWS = ["short", "standard", "long", "full"] as const;
const LIST_SHAPES = ["table", "card"] as const;
const DENSITIES = ["comfortable", "compact"] as const;

const VOCABULARIES: Record<string, readonly string[]> = {
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

const ALL_VOCABULARY_VALUES = new Set(Object.values(VOCABULARIES).flat());

// --- markdown のスパン抽出(ADR-0025 §4-2)---------------------------------------------

const NUMBER_RE = /^-?[0-9]+$/;

/**
 * 引用ブロック行(行頭 `> `)を**先に**落とす。
 *
 * 逐語引用は出典の値そのものなので ASCII トークンを含みうる(実データの intent に
 * `` `select` `` が入っている)。落とさずにスパンを抽出すると**偽陽性**になる。
 * 逐語引用は代わりに「出典とバイト一致」という**より強い検査**で受ける(§4-2)。
 */
function stripQuoteBlocks(markdown: string): string {
  return markdown
    .split("\n")
    .filter((line) => !line.startsWith("> "))
    .join("\n");
}

function extractSpans(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => match[1] ?? "");
}

// --- 検査 -------------------------------------------------------------------------------

type Failure = { check: string; where: string; message: string };

type CheckReport = { id: string; name: string; checked: number; failed: number };

/** 検査対象の件数。**0件で合格と報告しないため、必ず数えて出す。** */
type Counts = {
  statements: number;
  sources: number;
  id_slots: number;
  term_slots: number;
  verbatim_slots: number;
  backtick_spans: number;
  kagikakko_spans: number;
  recounted_numbers: number;
};

/** 空回りの検出で「0件なら不合格」とみなす件数の名前。 */
const MUST_BE_POSITIVE: readonly (keyof Counts)[] = [
  "statements",
  "sources",
  "id_slots",
  "term_slots",
  "verbatim_slots",
  "backtick_spans",
  "kagikakko_spans",
];

type AuditReport = {
  app_id: string;
  data_root: string;
  doc: string;
  passed: boolean;
  counts: Counts;
  checks: CheckReport[];
  failures: Failure[];
  /** 検査していないこと(誇張しないための申告。上の doc コメントと同じ内容)。 */
  not_checked: string[];
};

const NOT_CHECKED: readonly string[] = [
  "残差検査(ADR-0025 §4-3。地の文がテンプレート定数の断片の連結であること)は本スクリプトの担当ではない。" +
    "残差検査にはテンプレート定数表が要るが、監査は生成器を import しない(§4-6)ので表に到達できない。" +
    "表をこちらに写せば二重管理になり、二重管理は必ず食い違う。したがって残差検査は" +
    "カーネルのユニットテスト src/kernel/requirements-doc.test.ts が担当する。",
  "数値の捏造一般(§4-4)。数値スパンは形(^-?[0-9]+$)しか見ていない。数え直したのは " +
    "overview.scale の4件数と data.table のフィールド数だけで、位置・seq・時分は数え直していない。",
  "スパンのグループ整合。markdown からはスパンのグループが分からないため、" +
    "「テーブルIDの位置にビューIDが書かれている」類は平坦な集合照合では捕まらない" +
    "(slot 側のグループ別照合が、slot に届く範囲でこれを補う)。",
  "文レベルの捏造(実在するリソースについて実在しない振る舞いを述べること)。" +
    "上位計画 08-requirements-doc.md:78 が認めている不足であり、確認方法1 のサンプリングに残る。",
  "capability が実在するか(ADR-0025 §限界6)。capability はマニフェストに現れないので、" +
    "照合できるのは「マニフェスト上の値以外が混ざっていないこと」までである。",
  "生成物と markdown の一致(markdown = renderRequirementsMarkdown(statements))。" +
    "生成器を import しないので再描画による照合ができない。カーネルのユニットテストが全数で固定している。",
];

/** 検査本体。**入力エラーは throw、検査の不合格は返り値**(両者を混ぜない)。 */
function audit(dataRoot: string, appId: string, docPath: string): AuditReport {
  const docText = (() => {
    try {
      return readFileSync(docPath, "utf-8");
    } catch (cause) {
      throw new InputError(
        `文書 "${docPath}" を読み込めません(${cause instanceof Error ? cause.message : String(cause)})。`,
      );
    }
  })();
  const doc = objectAt(JSON.parse(docText) as Json, `"${docPath}"`);
  const markdown = stringAt(doc.markdown, `"${docPath}" の markdown`);
  const statements = arrayAt(doc.statements, `"${docPath}" の statements`);

  const manifest = readManifest(dataRoot, appId);
  const entries = readEntries(dataRoot, appId);
  const entryBySeq = new Map(entries.map((entry) => [entry.seq, entry]));
  const sets = buildIdentifierSets(manifest, entries);

  const identifierValues = new Set<string>();
  const displayNameValues = new Set<string>();
  for (const group of IDENTIFIER_GROUPS) {
    for (const value of sets[group]) {
      (isDisplayNameGroup(group) ? displayNameValues : identifierValues).add(value);
    }
  }

  const failures: Failure[] = [];
  const counts: Counts = {
    statements: statements.length,
    sources: 0,
    id_slots: 0,
    term_slots: 0,
    verbatim_slots: 0,
    backtick_spans: 0,
    kagikakko_spans: 0,
    recounted_numbers: 0,
  };
  const failed: Record<string, number> = {};
  const fail = (check: string, where: string, message: string): void => {
    failures.push({ check, where, message });
    failed[check] = (failed[check] ?? 0) + 1;
  };

  // --- 確認方法2(全数): 出典欄が空の記述が0件であること -------------------------------
  statements.forEach((raw, index) => {
    const statement = objectAt(raw, `statements[${index}]`);
    const id = optionalString(statement.id) ?? `statements[${index}]`;
    const sources = Array.isArray(statement.sources) ? statement.sources : undefined;
    if (sources === undefined || sources.length === 0) {
      fail(
        "sources_nonempty",
        id,
        "出典欄(sources)が空、または配列ではありません(CP-V1-8 確認方法2)。",
      );
      return;
    }
    counts.sources += sources.length;
  });

  // --- 出典の実在 + slot の検査 -------------------------------------------------------
  statements.forEach((raw, index) => {
    const statement = objectAt(raw, `statements[${index}]`);
    const id = optionalString(statement.id) ?? `statements[${index}]`;

    for (const [position, rawSource] of optionalArray(statement.sources).entries()) {
      const source = objectAt(rawSource, `${id}.sources[${position}]`);
      const where = `${id}.sources[${position}]`;
      const resolved = resolveSource(source, manifest, entryBySeq);
      if (resolved.ok === false) {
        fail("source_exists", where, resolved.message);
      }
    }

    const slots = isObject(statement.slots) ? statement.slots : {};
    for (const [name, rawSlot] of Object.entries(slots)) {
      const slot = objectAt(rawSlot, `${id}.slots.${name}`);
      const kind = optionalString(slot.kind);
      const where = `${id}.slots.${name}`;

      if (kind === "id") {
        counts.id_slots += 1;
        const group = optionalString(slot.group);
        const value = optionalString(slot.value);
        if (group === undefined || value === undefined || !isIdentifierGroup(group)) {
          fail("id_slot_in_set", where, `id スロットの group / value が読めません。`);
        } else if (!sets[group].has(value)) {
          fail(
            "id_slot_in_set",
            where,
            `${group} の "${value}" は、マニフェストと changelog から独立に構築した実在集合に含まれていません。`,
          );
        }
        continue;
      }

      if (kind === "term") {
        counts.term_slots += 1;
        const vocabulary = optionalString(slot.vocabulary) ?? "";
        const value = optionalString(slot.value) ?? "";
        const allowed = VOCABULARIES[vocabulary];
        if (allowed === undefined) {
          fail("term_slot_in_vocabulary", where, `未知の語彙グループ "${vocabulary}" です。`);
        } else if (!allowed.includes(value)) {
          fail(
            "term_slot_in_vocabulary",
            where,
            `語彙 ${vocabulary} に "${value}" は含まれていません。`,
          );
        }
        continue;
      }

      if (kind === "verbatim") {
        counts.verbatim_slots += 1;
        const value = optionalString(slot.value);
        const from = isObject(slot.from) ? slot.from : undefined;
        const field = from === undefined ? undefined : optionalString(from.field);
        const source = from === undefined || !isObject(from.source) ? undefined : from.source;
        if (value === undefined || field === undefined || source === undefined) {
          fail("verbatim_bytes", where, "verbatim スロットの value / from が読めません。");
          continue;
        }
        const resolved = resolveSource(source, manifest, entryBySeq);
        if (resolved.ok === false) {
          fail("verbatim_bytes", where, `出典が実在しません: ${resolved.message}`);
          continue;
        }
        const container = resolved.value;
        const actual = readField(container, field);
        if (actual === undefined) {
          fail(
            "verbatim_bytes",
            where,
            `出典に フィールド "${field}" がありません(pointer: ${optionalString(source.pointer) ?? ""})。`,
          );
          continue;
        }
        const expected = typeof actual === "string" ? actual : String(actual);
        if (expected !== value) {
          fail(
            "verbatim_bytes",
            where,
            `逐語引用が出典とバイト一致しません。出典: ${JSON.stringify(expected)} / 文書: ${JSON.stringify(value)}`,
          );
        }
        continue;
      }

      if (kind !== "number") {
        fail("id_slot_in_set", where, `未知のスロット種別 "${String(kind)}" です。`);
      }
    }

    // --- 件数の独立な数え直し(ADR-0025 §4-4 (ii)。範囲は限定的)-----------------------
    const template = optionalString(statement.template) ?? "";
    if (template === "overview.scale") {
      const app = objectAt(manifest.app, "manifest の /app");
      const expectations: [string, number][] = [
        ["table_count", optionalArray(app.tables).length],
        ["view_count", optionalArray(app.views).length],
        ["workflow_count", optionalArray(app.workflows).length],
        ["function_count", optionalArray(app.functions).length],
      ];
      for (const [slotName, expected] of expectations) {
        counts.recounted_numbers += 1;
        const actual = numberSlotValue(slots, slotName);
        if (actual !== expected) {
          fail(
            "number_recount",
            `${id}.slots.${slotName}`,
            `件数が独立な数え直しと一致しません。マニフェスト: ${expected} / 文書: ${String(actual)}`,
          );
        }
      }
    }
    if (template === "data.table") {
      const tableId = identifierSlotValue(slots, "table_id");
      const app = objectAt(manifest.app, "manifest の /app");
      const table = optionalArray(app.tables)
        .map((t, i) => objectAt(t, `/app/tables/${i}`))
        .find((t) => optionalString(t.id) === tableId);
      counts.recounted_numbers += 1;
      const expected = table === undefined ? undefined : optionalArray(table.fields).length;
      const actual = numberSlotValue(slots, "field_count");
      if (expected === undefined || expected !== actual) {
        fail(
          "number_recount",
          `${id}.slots.field_count`,
          `フィールド数が独立な数え直しと一致しません。マニフェスト: ${String(expected)} / 文書: ${String(actual)}`,
        );
      }
    }
  });

  // --- 確認方法3: markdown のスパン照合 -------------------------------------------------
  const body = stripQuoteBlocks(markdown);
  const backticks = extractSpans(body, /`([^`]*)`/g);
  const kagikakko = extractSpans(body, /「([^」]*)」/g);
  counts.backtick_spans = backticks.length;
  counts.kagikakko_spans = kagikakko.length;

  backticks.forEach((span, index) => {
    const known =
      identifierValues.has(span) || ALL_VOCABULARY_VALUES.has(span) || NUMBER_RE.test(span);
    if (!known) {
      fail(
        "backtick_span_exists",
        `markdown のバッククォートスパン[${index}]`,
        `"${span}" は、独立に構築した識別子集合・カーネルの語彙定数・数値のいずれとも完全一致しません(CP-V1-8 確認方法3)。`,
      );
    }
  });

  kagikakko.forEach((span, index) => {
    if (!displayNameValues.has(span)) {
      fail(
        "kagikakko_span_exists",
        `markdown の鉤括弧スパン[${index}]`,
        `"${span}" は、マニフェスト由来の表示名集合と完全一致しません(CP-V1-8 確認方法3)。`,
      );
    }
  });

  // --- 空回りの検出(0件検査で合格と報告しない)------------------------------------------
  for (const key of MUST_BE_POSITIVE) {
    if (counts[key] === 0) {
      fail(
        "not_vacuous",
        key,
        `検査対象が0件です。合格ではなく不合格として報告します(検査が空回りしている可能性がある)。`,
      );
    }
  }

  const checks: CheckReport[] = [
    {
      id: "sources_nonempty",
      name: "確認方法2(全数): 出典欄が空の記述が0件",
      checked: counts.statements,
      failed: failed.sources_nonempty ?? 0,
    },
    {
      id: "backtick_span_exists",
      name: "確認方法3: バッククォートスパンが実在集合・語彙・数値と完全一致",
      checked: counts.backtick_spans,
      failed: failed.backtick_span_exists ?? 0,
    },
    {
      id: "kagikakko_span_exists",
      name: "確認方法3: 鉤括弧スパンが表示名集合と完全一致",
      checked: counts.kagikakko_spans,
      failed: failed.kagikakko_span_exists ?? 0,
    },
    {
      id: "id_slot_in_set",
      name: "追加検査: id スロットがグループごとの実在集合の要素",
      checked: counts.id_slots,
      failed: failed.id_slot_in_set ?? 0,
    },
    {
      id: "term_slot_in_vocabulary",
      name: "追加検査: term スロットが語彙定数の要素",
      checked: counts.term_slots,
      failed: failed.term_slot_in_vocabulary ?? 0,
    },
    {
      id: "verbatim_bytes",
      name: "追加検査: verbatim スロットが出典とバイト一致",
      checked: counts.verbatim_slots,
      failed: failed.verbatim_bytes ?? 0,
    },
    {
      id: "source_exists",
      name: "追加検査: すべての出典が実在(changelog の seq/diff_id / manifest の pointer)",
      checked: counts.sources,
      failed: failed.source_exists ?? 0,
    },
    {
      id: "number_recount",
      name: "追加検査: 件数の独立な数え直し(overview.scale / data.table のみ)",
      checked: counts.recounted_numbers,
      failed: failed.number_recount ?? 0,
    },
    {
      id: "not_vacuous",
      name: "空回りの検出(検査対象が0件のものがない)",
      checked: MUST_BE_POSITIVE.length,
      failed: failed.not_vacuous ?? 0,
    },
  ];

  return {
    app_id: appId,
    data_root: dataRoot,
    doc: docPath,
    passed: failures.length === 0,
    counts,
    checks,
    failures,
    not_checked: [...NOT_CHECKED],
  };
}

function isIdentifierGroup(value: string): value is IdentifierGroup {
  return (IDENTIFIER_GROUPS as readonly string[]).includes(value);
}

/** スロット表から number スロットの値を取り出す(無ければ undefined)。 */
function numberSlotValue(slots: JsonObject, name: string): number | undefined {
  const slot = slots[name];
  if (!isObject(slot) || slot.kind !== "number" || typeof slot.value !== "number") {
    return undefined;
  }
  return slot.value;
}

/** スロット表から id スロットの値を取り出す(無ければ undefined)。 */
function identifierSlotValue(slots: JsonObject, name: string): string | undefined {
  const slot = slots[name];
  if (!isObject(slot) || slot.kind !== "id") {
    return undefined;
  }
  return optionalString(slot.value);
}

/** オブジェクトなら key、配列なら添字としてフィールドを読む。 */
function readField(container: Json, field: string): Json | undefined {
  if (Array.isArray(container)) {
    return /^[0-9]+$/.test(field) ? container[Number(field)] : undefined;
  }
  if (isObject(container)) {
    return field in container ? container[field] : undefined;
  }
  return undefined;
}

type Resolved = { ok: true; value: Json } | { ok: false; message: string };

/**
 * 出典を実際に解決する。**changelog なら seq と diff_id の両方**を突き合わせる ——
 * seq だけ合っていて diff_id が違えば、出典は別の行を指している。
 */
function resolveSource(
  source: JsonObject,
  manifest: JsonObject,
  entryBySeq: ReadonlyMap<number, Entry>,
): Resolved {
  const kind = optionalString(source.kind);
  const pointer = optionalString(source.pointer);
  if (pointer === undefined) {
    return { ok: false, message: "出典に pointer がありません。" };
  }
  if (kind === "manifest") {
    const value = resolvePointer(manifest, pointer);
    return value === undefined
      ? { ok: false, message: `manifest の pointer "${pointer}" が解決できません。` }
      : { ok: true, value };
  }
  if (kind === "changelog") {
    const seq = typeof source.seq === "number" ? source.seq : undefined;
    const diffId = optionalString(source.diff_id);
    if (seq === undefined || diffId === undefined) {
      return { ok: false, message: "changelog 出典に seq / diff_id がありません。" };
    }
    const entry = entryBySeq.get(seq);
    if (entry === undefined) {
      return { ok: false, message: `changelog に seq ${seq} の行がありません。` };
    }
    if (entry.diff_id !== diffId) {
      return {
        ok: false,
        message: `seq ${seq} の diff_id は "${entry.diff_id}" であり、出典の "${diffId}" と違います。`,
      };
    }
    const value = resolvePointer(entry.object, pointer);
    return value === undefined
      ? { ok: false, message: `seq ${seq} の pointer "${pointer}" が解決できません。` }
      : { ok: true, value };
  }
  return { ok: false, message: `未知の出典種別 "${String(kind)}" です。` };
}

// --- 報告 -------------------------------------------------------------------------------

function formatReport(report: AuditReport): string {
  const lines: string[] = [
    "=== CP-V1-8 機械照合(確認方法2・3 + 追加検査)===",
    `アプリ: ${report.app_id}`,
    `データルート: ${report.data_root}`,
    `文書: ${report.doc}`,
    "",
    "検査結果:",
  ];
  for (const check of report.checks) {
    const verdict = check.failed === 0 ? "OK" : "NG";
    lines.push(
      `  [${verdict}] ${check.name}: 検査 ${check.checked} 件 / 不合格 ${check.failed} 件`,
    );
  }
  lines.push("", "件数:");
  for (const [key, value] of Object.entries(report.counts)) {
    lines.push(`  ${key}: ${value}`);
  }
  if (report.failures.length > 0) {
    lines.push("", `不合格の明細(${report.failures.length} 件):`);
    for (const failure of report.failures) {
      lines.push(`  - [${failure.check}] ${failure.where}: ${failure.message}`);
    }
  }
  lines.push("", "このスクリプトが検査していないこと(誇張しないための申告):");
  for (const item of report.not_checked) {
    lines.push(`  - ${item}`);
  }
  lines.push(
    "",
    report.passed
      ? `合格: 上の件数のとおり実際に検査したうえで、不合格0件である。`
      : `不合格: ${report.failures.length} 件の不合格がある。`,
  );
  return lines.join("\n");
}

// --- 入口 -------------------------------------------------------------------------------

type Options = {
  dataRoot: string;
  app: string;
  doc: string;
  report: string | undefined;
  reportJson: string | undefined;
};

function parseArgs(argv: readonly string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new InputError(`未知の引数 "${arg}" です。`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new InputError(`${arg} の値が指定されていません。`);
    }
    values.set(arg, value);
    index += 1;
  }
  const known = ["--data-root", "--app", "--doc", "--report", "--report-json"];
  for (const key of values.keys()) {
    if (!known.includes(key)) {
      throw new InputError(`未知のオプション "${key}" です。`);
    }
  }
  const dataRoot = values.get("--data-root");
  const app = values.get("--app");
  const doc = values.get("--doc");
  if (dataRoot === undefined || app === undefined || doc === undefined) {
    throw new InputError("--data-root / --app / --doc は必須です。");
  }
  return {
    dataRoot,
    app,
    doc,
    report: values.get("--report"),
    reportJson: values.get("--report-json"),
  };
}

function main(argv: readonly string[]): { output: string; code: number } {
  let options: Options;
  try {
    options = parseArgs(argv);
  } catch (cause) {
    return {
      output: `NG: ${cause instanceof Error ? cause.message : String(cause)}\n${USAGE}`,
      code: EXIT_INPUT_ERROR,
    };
  }
  let report: AuditReport;
  try {
    report = audit(options.dataRoot, options.app, options.doc);
  } catch (cause) {
    if (cause instanceof InputError) {
      return { output: `NG: ${cause.message}\n${USAGE}`, code: EXIT_INPUT_ERROR };
    }
    return {
      output: `NG: 監査を実行できませんでした。\n${cause instanceof Error ? cause.message : String(cause)}`,
      code: EXIT_INPUT_ERROR,
    };
  }

  const text = formatReport(report);
  if (options.report !== undefined) {
    writeFileSync(options.report, `${text}\n`, "utf-8");
  }
  if (options.reportJson !== undefined) {
    writeFileSync(options.reportJson, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  }
  return { output: text, code: report.passed ? EXIT_OK : EXIT_FAILED };
}

if (import.meta.main) {
  const { output, code } = main(Bun.argv.slice(2));
  console.log(output);
  process.exit(code);
}
