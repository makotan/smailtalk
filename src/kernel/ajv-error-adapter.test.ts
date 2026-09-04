/**
 * Ajv エラー → 統一形式(`ValidationError[]`)への変換層のテスト。
 *
 * ここで守るのは「LLM が1往復で自己修正できるか」(handover.md 3.8 / 憲法6)であって、
 * Ajv がいくつエラーを出したかではない。特に次の2点を固定する。
 *
 * 1. **語彙外 op のときはノイズを出さない。** diff スキーマの `if/then` 分岐は、
 *    op が語彙外だと「どの then にも入れなかった」副産物として
 *    `/operations/<i>/field の型が不正です。object を指定してください` のような
 *    ミスリードなエラーを併発する。これを読んだ LLM は「field を object にすれば直る」と
 *    誤読し、存在しない op を直そうとする無駄な往復に入る。伝えるべきは
 *    「その op は v0 に存在しない」の1点だけである。
 * 2. **抑制は効きすぎてはいけない。** 抑制範囲は「op が語彙外だった、その operation」に
 *    限る。別の operation のエラーや operations 配下でないエラーまで消すと、
 *    `allErrors: true` の価値(1往復で全部直させる)が死ぬ。
 */

import { describe, expect, test } from "bun:test";
import { toValidationErrors } from "./ajv-error-adapter.ts";
import type { ValidationError } from "./errors.ts";
import { DIFF_OPS, FIELD_TYPES } from "./types.ts";
import { diffSchema, manifestSchema, validateDiff, validateManifest } from "./validate.ts";

/** 検証が失敗することを前提にエラー配列を取り出す。 */
function errorsOf(result: ReturnType<typeof validateDiff>): ValidationError[] {
  if (result.valid) {
    throw new Error("検証が通ってしまいました(失敗を前提にしたテストです)。");
  }
  return result.errors;
}

/** 指定 operation 配下(自身を含む)のエラーだけを取り出す。 */
function under(errors: ValidationError[], index: number): ValidationError[] {
  const prefix = `/operations/${index}`;
  return errors.filter((e) => e.path === prefix || e.path.startsWith(`${prefix}/`));
}

function diffWith(operations: unknown[]): unknown {
  return { diff_id: "d-0001", intent: "テスト用の意図", operations };
}

describe("語彙外 op のエラーはノイズを伴わない", () => {
  // **題材を remove_view から copy_field に差し替えた(ADR-0012)。** remove_view は
  // 門A を通って語彙内になったので、語彙外 op の題材にはできない。copy_field は
  // ADR-0012 限定1 が名指しで止めている op である。
  test("copy_field の operation から返るエラーは /operations/0/op の1件だけ", () => {
    const errors = errorsOf(
      validateDiff(diffWith([{ op: "copy_field", table: "books", field: "memo" }])),
    );

    // ここが本丸。以前は if/then の副産物で /operations/0/field の型エラーが併発していた。
    expect(under(errors, 0)).toHaveLength(1);
    expect(errors[0]?.path).toBe("/operations/0/op");
    expect(errors[0]?.allowed_values).toEqual([...DIFF_OPS]);
  });

  test("語彙外 op に余計な属性が付いていても、報告は op の1件に絞られる", () => {
    // 未知プロパティ・型違反・必須欠落を同時に含ませても、原因は「op が無い」の一点。
    const errors = errorsOf(
      validateDiff(diffWith([{ op: "change_type", table: 123, to: "number", changes: 1 }])),
    );

    expect(under(errors, 0)).toHaveLength(1);
    expect(errors[0]?.path).toBe("/operations/0/op");
  });
});

describe("抑制は効きすぎない(allErrors: true の価値を殺さない)", () => {
  test("op が正しい operation では、従来どおり複数エラーが同時に返る", () => {
    const errors = errorsOf(
      validateDiff(
        diffWith([
          {
            op: "add_field",
            table: 123,
            field: { id: "ISBN!", name: "ISBN", type: "datetime" },
          },
        ]),
      ),
    );

    const paths = under(errors, 0).map((e) => e.path);
    expect(paths).toContain("/operations/0/table");
    expect(paths).toContain("/operations/0/field/id");
    expect(paths).toContain("/operations/0/field/type");
    expect(paths.length).toBeGreaterThanOrEqual(3);
  });

  test("語彙外 op と、別 operation の正当なエラーが混在しても後者は消えない", () => {
    const errors = errorsOf(
      validateDiff(
        diffWith([
          { op: "add_field", table: 123, field: { id: "ISBN!", name: "ISBN", type: "datetime" } },
          { op: "copy_field", table: "books", field: "memo" },
        ]),
      ),
    );

    // operation 1(語彙外)は1件に絞られる。
    expect(under(errors, 1)).toHaveLength(1);
    expect(errors.find((e) => e.path === "/operations/1/op")).toBeDefined();

    // operation 0 のエラーは1件も減らない。
    const paths = under(errors, 0).map((e) => e.path);
    expect(paths).toContain("/operations/0/table");
    expect(paths).toContain("/operations/0/field/id");
    expect(paths).toContain("/operations/0/field/type");
  });

  test("語彙外 op があっても、operations 配下でないエラーは消えない", () => {
    const errors = errorsOf(
      validateDiff({
        diff_id: "Bad Id!",
        intent: "",
        operations: [{ op: "copy_field", table: "books", field: "memo" }],
      }),
    );

    expect(errors.some((e) => e.path === "/diff_id")).toBe(true);
    expect(errors.some((e) => e.path === "/intent")).toBe(true);
    expect(under(errors, 0)).toHaveLength(1);
  });

  test("語彙外 op が2つあれば、それぞれ1件ずつ報告される(片方が消えない)", () => {
    const errors = errorsOf(
      validateDiff(
        diffWith([
          { op: "copy_field", table: "books", field: "memo" },
          { op: "rename_table", table: "books", to: "volumes" },
        ]),
      ),
    );

    expect(under(errors, 0)).toHaveLength(1);
    expect(under(errors, 1)).toHaveLength(1);
    expect(errors.map((e) => e.path)).toEqual(["/operations/0/op", "/operations/1/op"]);
  });
});

describe("op の enum エラーは『次の一手』を示す(計画書 V0-P4-T03)", () => {
  test("hint に12種の op と change_field での言い換え、undo への言及が入る", () => {
    const errors = errorsOf(
      validateDiff(diffWith([{ op: "copy_field", table: "books", field: "memo" }])),
    );
    const hint = errors[0]?.hint ?? "";

    // V1-M1-T03: 旧文面「v0の差分は additive(追加)のみです」は ADR-0010 で嘘になった。
    // 新しい文面が言うべきなのは「できる。ただし綴りが違う」である。
    // **種類数は `DIFF_OPS` から導く。**hint 側は循環参照を避けるため `DIFF_OPS` を
    // import せず散文で手書きしているので(`ajv-error-adapter.ts` の
    // `DIFF_OP_ENUM_HINT` の doc コメント)、**追随漏れを拾えるのはこの検査だけ**である。
    // 数を直書きすると「DIFF_OPS も hint もテスト名も全部9のまま」で緑になり、
    // V1-M1-T03 の見落としがそのまま再現する。
    expect(hint).toContain(`${DIFF_OPS.length}種`);
    expect(hint).toContain("change_field");
    // ADR-0012 で remove_view は語彙内になった。**hint が「無い」と言い続けると、
    // カーネルは「できること」を「できない」と教えることになる**(V1-M1-T06 §10-3)。
    expect(hint).toContain("remove_view");
    // ADR-0013 で足した4群目「自動化」。remove_view と同じ理由でここに要る ——
    // T07 完了の瞬間から apply_diff は add_workflow を受理する。
    expect(hint).toContain("add_workflow");
    // 「本当に無いもの」も言う。言わないと、remove_view が通った経験から類推される。
    expect(hint).toContain("remove_app");
    // ADR-0013 限定2 が名指しで止めている op。ワークフローが語彙に入ったことで
    // 「では動かす op もあるはずだ」と類推される筋ができたので、先回りして断る。
    expect(hint).toContain("run_workflow");
    // 既に適用した変更を戻す唯一の答えは undo。ここを言わないと LLM は op を発明し続ける。
    expect(hint).toContain("undo");
    expect(errors[0]?.allowed_values).toEqual([...DIFF_OPS]);
  });
});

describe("汎用の enum ハンドラは変わらない", () => {
  test("マニフェストのフィールド型 enum エラーの文言は従来どおり", () => {
    const result = validateManifest({
      app: {
        id: "book-tracker",
        name: "蔵書管理",
        tables: [
          {
            id: "books",
            name: "本",
            fields: [{ id: "at", name: "日時", type: "datetime" }],
          },
        ],
        views: [],
      },
    });
    const errors = errorsOf(result);
    const error = errors.find((e) => e.path === "/app/tables/0/fields/0/type");

    expect(error).toEqual({
      path: "/app/tables/0/fields/0/type",
      message: 'type の値 "datetime" は語彙にありません。',
      allowed_values: [...FIELD_TYPES],
      hint: "許可される値のいずれかに置き換えてください。v0の語彙は拡張できません。",
    });
  });

  test("diff の中でも op 以外の enum エラーは汎用の hint のまま", () => {
    const errors = errorsOf(
      validateDiff(
        diffWith([
          { op: "add_field", table: "books", field: { id: "at", name: "日時", type: "datetime" } },
        ]),
      ),
    );
    const error = errors.find((e) => e.path === "/operations/0/field/type");

    expect(error?.hint).toBe(
      "許可される値のいずれかに置き換えてください。v0の語彙は拡張できません。",
    );
    expect(error?.hint).not.toContain("undo");
  });
});

/**
 * `view.table` の pattern hint(ADR-0006 §11)。
 *
 * 汎用の pattern hint は「英小文字で始まり…」と言うが、`view.table` に限れば
 * それはもう真ではない(`_apps` は英小文字で始まらないのに valid)。この hint に
 * 従った LLM は正しい答えに決して辿り着けないため、位置ごとに hint を分ける。
 */
describe("view.table の pattern hint はシステムテーブルを案内する", () => {
  test("マニフェストの view.table が pattern 違反ならシステムテーブルを hint に含む", () => {
    const errors = errorsOf(
      validateManifest({
        app: {
          id: "platform-admin",
          name: "管理ツール",
          tables: [],
          views: [{ id: "v", type: "detail_view", table: "_snapshots" }],
        },
      }),
    );
    const error = errors.find((e) => e.path === "/app/views/0/table");
    expect(error?.hint).toContain("_apps");
    expect(error?.hint).toContain("_changelog");
  });

  test("大文字始まりのシステムテーブル風IDでも同じ hint を返す", () => {
    const errors = errorsOf(
      validateManifest({
        app: {
          id: "platform-admin",
          name: "管理ツール",
          tables: [],
          views: [{ id: "v", type: "detail_view", table: "_Apps" }],
        },
      }),
    );
    expect(errors.find((e) => e.path === "/app/views/0/table")?.hint).toContain("_apps");
  });

  test("add_view の view.table でも同じ hint を返す", () => {
    const errors = errorsOf(
      validateDiff(
        diffWith([{ op: "add_view", view: { id: "v", type: "detail_view", table: "_Apps" } }]),
      ),
    );
    expect(errors.find((e) => e.path === "/operations/0/view/table")?.hint).toContain("_apps");
  });

  test("table.id など他の位置の hint は従来どおり(システムテーブルを案内しない)", () => {
    const errors = errorsOf(
      validateManifest({
        app: {
          id: "platform-admin",
          name: "管理ツール",
          tables: [
            { id: "_apps", name: "偽の台帳", fields: [{ id: "x", name: "X", type: "text" }] },
          ],
          views: [],
        },
      }),
    );
    const error = errors.find((e) => e.path === "/app/tables/0/id");
    expect(error?.hint).toContain("英小文字で始まり");
    expect(error?.hint).not.toContain("_apps");
  });
});

/**
 * 許可属性の全列挙(V1-M0-T04 / F-21 / F-15)。
 *
 * `view` / `field` / `operation` は `allOf` + `if/then/else` で、type や op ごとに
 * 書ける属性が変わる。ここで守るのは「**列挙が実際の受理集合と一致すること**」であって、
 * 列挙が出ること自体ではない。一致を保証できない位置では列挙を出さない(憲法6)という
 * 判断が `docs/v0-t04-record.md` §2 の付記に残っている。**その判断ごと壊さないため**、
 * 下の「網羅的突き合わせ」は列挙(b)と実測(a)を機械的に照合する。
 *
 * **属性一覧も文脈一覧もスキーマから導く。**将来スキーマに属性や type が増えたら、
 * このテストは書き換えなくても対象を増やし、一致が崩れれば落ちる。
 */

// biome-ignore lint/suspicious/noExplicitAny: スキーマは任意の JSON
type SchemaNode = Record<string, any>;

/** ローカルな `$ref`(`#/$defs/...`)を1段たどる。 */
function deref(doc: SchemaNode, node: SchemaNode): SchemaNode {
  const ref = node.$ref as string | undefined;
  if (ref === undefined) {
    return node;
  }
  let target: SchemaNode = doc;
  for (const segment of ref.slice(ref.indexOf("#") + 1).split("/")) {
    if (segment !== "" && segment !== "#") {
      target = target[segment] as SchemaNode;
    }
  }
  return target;
}

/**
 * `allOf` の `if` が場合分けに使っている唯一のキー(view なら `type`、operation なら `op`)。
 *
 * **【V4-M18-T03 / `P-G14` の (C) 側 / `ADR-0095` 限定5 で更新した】** `$defs/view` の
 * `allOf` に**4分岐目**(`modal` と `menu_listed` の組み合わせ検査)が増え、`if` の discriminator
 * キーが `type` と `modal` の2種類になった。**これは type ごとの場合分け(網羅的な分割)
 * ではなく、直交する組み合わせ制約であり**、他の全 type で共通に効く(=「その type だから
 * 許される/禁じられる」を1つも表さない)。**判定基準は「候補キーの宣言側が `enum`
 * (有限の場合分け語彙)を持つか」** —— `type` は `$defs/view_type` の `enum` を持つが、
 * `modal` は `{ type: "boolean" }` で `enum` を持たない。**この基準で `modal` を除外すれば、
 * 場合分けキーは今日も `type` 1つに特定できる**(`forbiddenAttributesOf` / `baseInstance` は
 * 元々 `key`(= `type`)で候補を絞るので、`modal` 分岐は素通りする = 1ミリも壊れない)。
 */
function discriminatorKeyOf(doc: SchemaNode, node: SchemaNode): string {
  const keys = new Set<string>();
  for (const branch of (node.allOf ?? []) as SchemaNode[]) {
    for (const key of Object.keys((branch.if?.properties ?? {}) as SchemaNode)) {
      keys.add(key);
    }
  }
  const enumerable = [...keys].filter((key) => {
    const declared = node.properties?.[key] as SchemaNode | undefined;
    return declared !== undefined && Array.isArray(deref(doc, declared).enum);
  });
  if (enumerable.length !== 1 || enumerable[0] === undefined) {
    throw new Error(`場合分けのキーを1つに特定できません: ${JSON.stringify(enumerable)}`);
  }
  return enumerable[0];
}

/** そのキーが取りうる値(= 文脈)の一覧。語彙そのものをスキーマから引く。 */
function contextsOf(doc: SchemaNode, node: SchemaNode, key: string): string[] {
  return deref(doc, node.properties[key] as SchemaNode).enum as string[];
}

/** その文脈で `false` によって禁止されている属性(`then` / `else` の両方を見る)。 */
function forbiddenAttributesOf(node: SchemaNode, key: string, context: string): string[] {
  const forbidden: string[] = [];
  for (const branch of (node.allOf ?? []) as SchemaNode[]) {
    const matched = branch.if?.properties?.[key]?.const === context;
    const body = (matched ? branch.then : branch.else) as SchemaNode | undefined;
    for (const [name, sub] of Object.entries((body?.properties ?? {}) as SchemaNode)) {
      if (sub === false) {
        forbidden.push(name);
      }
    }
  }
  return forbidden;
}

interface CrossCheckCase {
  /** テスト名に出す対象の名前。 */
  label: string;
  /** `node` が属するスキーマ文書($ref をたどるために要る)。 */
  doc: SchemaNode;
  /** 突き合わせるオブジェクトスキーマ。 */
  node: SchemaNode;
  /** そのオブジェクトが現れる instancePath。 */
  basePath: string;
  /** そのオブジェクトを含む、検証にかけられる文書を作る。 */
  wrap: (instance: unknown) => unknown;
  validate: (input: unknown) => ReturnType<typeof validateManifest>;
  /** 属性ごとの「その属性としては妥当な値」。文脈で形が変わる属性があるので文脈も渡す。 */
  sample: (context: string, attribute: string) => unknown;
  /** スキーマに無いのに AI が書こうとした属性(F-1 の `name` など)。 */
  absentAttributes: string[];
}

function runCrossCheck(testCase: CrossCheckCase): void {
  const { label, doc, node, basePath, wrap, validate, sample, absentAttributes } = testCase;
  const key = discriminatorKeyOf(doc, node);
  const contexts = contextsOf(doc, node, key);
  const attributes = Object.keys(node.properties as SchemaNode);
  const valueFor = (context: string, attribute: string): unknown =>
    attribute === key ? context : sample(context, attribute);

  /** その文脈で、それ自体は valid な最小インスタンス。必須属性はスキーマから導く。 */
  const baseInstance = (context: string): SchemaNode => {
    const instance: SchemaNode = {};
    const required = new Set<string>((node.required ?? []) as string[]);
    for (const branch of (node.allOf ?? []) as SchemaNode[]) {
      if (branch.if?.properties?.[key]?.const !== context) {
        continue;
      }
      for (const name of (branch.then?.required ?? []) as string[]) {
        required.add(name);
      }
    }
    for (const name of required) {
      instance[name] = valueFor(context, name);
    }
    return instance;
  };

  describe(`検証方法2: ${label} —— 列挙と実際の受理集合を網羅的に突き合わせる`, () => {
    test("属性一覧・文脈一覧をスキーマから導けている", () => {
      expect(attributes).toContain(key);
      expect(attributes.length).toBeGreaterThan(1);
      expect(contexts.length).toBeGreaterThan(0);
      for (const attribute of absentAttributes) {
        expect(attributes).not.toContain(attribute);
      }
    });

    for (const context of contexts) {
      test(`${context}: 列挙 = 1属性ずつ実測した受理集合`, () => {
        // (a) 実測: 属性を1つだけ足したインスタンスが、実際にスキーマ検証を通るか。
        const accepts = (attribute: string): boolean => {
          const instance = baseInstance(context);
          // **【V4-M18-T03 / `P-G14` の (C) 側 / `ADR-0095` 限定5 で足した】** `modal` は
          // `allOf` の4分岐目により `menu_listed: false` との組み合わせでしか受理されない
          // (単独では「その画面は重ねて出せるか」を宣言できても、掲載中の画面を重ねると
          // 下に何も無い画面の上に重なるので差分全体が拒否される)。**本関数は「属性を
          // 1つだけ足す」実測なので、`modal` を測るときだけ随伴条件を一緒に足して、
          // 書ける条件を満たしてから測る**(「書ける」ことの実測を諦めない)。
          if (attribute === "modal") {
            instance.menu_listed = false;
          }
          instance[attribute] = valueFor(context, attribute);
          return validate(wrap(instance)).valid;
        };
        const measured = attributes.filter(accepts);

        // (b) 列挙: 未知プロパティ(additionalProperties)のエラーに載る allowed_values。
        const probe = baseInstance(context);
        probe.__probe__ = 1;
        const enumerated = errorsOf(validate(wrap(probe))).find(
          (e) => e.path === basePath,
        )?.allowed_values;

        // 完了条件2: 過剰でも過少でもない。
        expect(enumerated).toEqual(measured);

        // 裏側からの確認: 列挙されなかった属性は実際に拒否される。
        for (const attribute of attributes) {
          expect(accepts(attribute)).toBe((enumerated ?? []).includes(attribute));
        }

        // スキーマに無い属性は列挙に現れず、実際にも拒否される。
        for (const attribute of absentAttributes) {
          expect(enumerated ?? []).not.toContain(attribute);
          const instance = baseInstance(context);
          instance[attribute] = sample(context, attribute);
          expect(validate(wrap(instance)).valid).toBe(false);
        }

        // (b') false schema 経由の列挙も、同じ集合でなければならない。
        const forbidden = forbiddenAttributesOf(node, key, context);
        for (const attribute of forbidden) {
          const instance = baseInstance(context);
          instance[attribute] = valueFor(context, attribute);
          const error = errorsOf(validate(wrap(instance))).find(
            (e) => e.path === `${basePath}/${attribute}`,
          );
          expect(error?.allowed_values).toEqual(measured);
          // 完了条件5: 3点構造は保たれる。
          expect(error?.path).toBe(`${basePath}/${attribute}`);
          expect(error?.message).toContain(attribute);
          expect(error?.hint).toContain("allowed_values");
        }
      });
    }
  });
}

const manifestDoc = manifestSchema as SchemaNode;
const diffDoc = diffSchema as SchemaNode;

const probeTable = {
  id: "books",
  name: "書籍",
  fields: [{ id: "title", name: "タイトル", type: "text" }],
};
const probeView = { id: "probe-view", type: "form", table: "books", fields: ["title"] };

function manifestWith(parts: { views?: unknown[]; fields?: unknown[] }): unknown {
  return {
    app: {
      id: "book-tracker",
      name: "蔵書管理",
      tables: [{ ...probeTable, ...(parts.fields ? { fields: parts.fields } : {}) }],
      views: parts.views ?? [],
    },
  };
}

runCrossCheck({
  label: "view (list_view / detail_view / form)",
  doc: manifestDoc,
  node: manifestDoc.$defs.view as SchemaNode,
  basePath: "/app/views/0",
  wrap: (view) => manifestWith({ views: [view] }),
  validate: validateManifest,
  // V1-M0-T02 で `name` は受理側へ移った(F-1 の限定採用)。**限定2「1つだけ」**を
  // ここで固定する —— `name` の次に来がちな `description` は依然としてスキーマに無い。
  absentAttributes: ["description"],
  sample: (_context, attribute) => {
    const values: Record<string, unknown> = {
      id: "probe-view",
      table: "books",
      // 3種すべてで書ける任意の表示名(V1-M0-T02 / F-1)。
      name: "書籍一覧",
      columns: ["title"],
      sort: { field: "title", order: "asc" },
      filter: [{ field: "title", equals: "x" }],
      fields: ["title"],
      // EC-G17 / ADR-0044: detail_view でだけ受理される関連レコード一覧(list_view / form
      // では false)。schema 検証だけを見るので via/columns の実在は問わない(構造として妥当な形)。
      related: [{ table: "books", via: "title", columns: ["title"] }],
      // EC-G14 / ADR-0045: detail_view でだけ受理される操作起点(list_view / form では false)。
      // schema 検証だけを見るので form / prefill.field の実在は問わない(構造として妥当な形)。
      actions: [{ form: "probe-view", prefill: { field: "title" } }],
      // D-G4 / ADR-0050(V3-M2-T01): 画面ごとのプリセット7軸。**値域はすべて有限 enum**で
      // あり、ピクセル座標も自由な CSS 文字列も1つも受けない(限定11)。list_view でだけ
      // 受理される3軸 / detail_view でだけ受理される2軸 / 両方で受理される2軸に分かれ、
      // form ではどれも false —— その割り当てそのものを本検査が受理集合として実測する。
      preset_column_align: { title: "center" },
      preset_column_width: { title: "wide" },
      preset_pager_position: "bottom",
      preset_label_placement: "stacked",
      preset_field_columns: 2,
      preset_image_size: "thumbnail",
      preset_text_preview: "long",
      // D-G5 / ADR-0055(V3-M5-T02): 逃げ道の参照。**3種すべてで受理される**(プリセットが
      // 1軸も当たらない form こそ当て先だからである)。**値は資産名と sha256 の2要素だけで、
      // CSS のバイト列は1バイトも書けない**(限定2)—— ここでも「形として書けない」ことを
      // 受理集合の実測が示す。
      custom_css: { asset: "print-layout", digest: "a".repeat(64) },
      // B-G1 / ADR-0070(V4-M3-T02): 画面ごとの「見せる相手」。**3種すべてで受理される**
      // (list_view / form / detail_view の allOf のどれでも false にしていない)。
      // **値域は既存4ロールの列挙で `anonymous` を含まない**(限定2)—— 匿名に開くのは
      // 別単位(`B-G5` / ADR-0074)であり、その実装は V4-M2 である。
      // **【`V8-M20-T01` / 台帳 `J-G27` / 手続きは `ADR-0301`。2026-08-10】** **上の4行が
      // 説明していたキー `audience` は廃止された**(判定 = 廃止)。**サンプル値の行
      // (逐語 `audience: ["owner"],`)を落とした** —— **この `values` はスキーマに在る
      // 属性の名前でしか引かれないので、置いたままにすると1度も引かれない死んだ値になる。**
      // **上の説明は歴史の記述として1バイトも消していない。**
      // E-G12 / ADR-0084(V4-M10-T45): 画面一覧(メニュー)への掲載の可否。
      // **3種すべてで受理される**(掲載は種別に依存しない属性であり、`name` /
      // `custom_css` と同じ扱い)。**値は真偽値1つで enum ではない**(限定2)。
      menu_listed: false,
      // `P-G17` の (C) 側 / ADR-0092(V4-M16-T12): 詳細画面の項目のまとまり。
      // **detail_view でだけ受理される**(list_view / form の allOf 分岐では false)——
      // その割り当てそのものを本検査が受理集合として実測する。**値は「まとまりの名前 →
      // フィールドIDの配列」の1段だけで、入れ子も並び順のキーも書けない**(限定3)。
      // schema 検証だけを見るので、まとまりに書いたIDの実在は問わない(実在の照合は
      // `referential-integrity.ts` の類型15 = 限定5)。
      field_groups: { 基本: ["title"] },
      // `P-G24` の (C) 側 / ADR-0093(V4-M16-T13): 一覧の器の形(8つ目の `preset_` キー)。
      // **list_view でだけ受理される**(form / detail_view の allOf 分岐では false)——
      // その割り当てそのものを本検査が受理集合として実測する。**値域は `table` / `card` の
      // 2値だけで、3値目も自由文字列も1つも受けない**(限定3)。
      preset_list_shape: "card",
      // `P-G14` の (C) 側 / ADR-0095(V4-M18-T03): 重ねて出す宣言。**form でだけ受理される**
      // (list_view / detail_view の allOf 分岐では false)。**単独では受理されず、
      // `menu_listed: false` との組み合わせでしか受理されない**(限定5。上の `accepts` が
      // `modal` を測るときだけ随伴条件を足す理由)。**値は真偽値1つで enum ではない**(限定2)。
      modal: true,
      // `E-G7` の (C) 側 / ADR-0112(V4-M22-T01): 検索の対象にする列。
      // **list_view でだけ受理される**(form / detail_view の allOf 分岐では false)——
      // その割り当てそのものを本検査が受理集合として実測する。**値は実在フィールドIDの
      // 配列(1〜8本・重複不可)だけで、演算子も条件式も書けない**(限定4)。
      search_fields: ["title"],
      // **【V4-M22-T05 / ADR-0113 限定1・限定7 で足した】** `E-G8`/`E-G11` の (C) 側。
      // 1ページに出す件数。**list_view でだけ受理される**(form / detail_view の allOf
      // 分岐では false)——その割り当てそのものを本検査が受理集合として実測する。
      // **値域は 10/20/50/100 の4段階値だけで、自由な整数も文字列も1つも受けない**(限定3)。
      page_size: 20,
      // **【V4-M19-T03 / `P-G32` の (C) 側 / ADR-0118 限定1・限定3 で足した】** 画面の
      // 詰まり具合。**3種すべてで受理される**(`name` / `custom_css` / `menu_listed` と
      // 同じ扱い)——その割り当てそのものを本検査が受理集合として実測する。**値域は
      // `comfortable` / `compact` の2値だけで、3値目も自由文字列も1つも受けない**(限定3)。
      // **本 ADR の増分ではない。**
      preset_density: "compact",
      // **【V4-M20-T04 / ADR-0102 限定1・限定3 で足した】** 保存が成立したあとに行く
      // 画面のID。**form でだけ受理される**(list_view / detail_view の allOf 分岐では
      // false)——その割り当てそのものを本検査が受理集合として実測する。**値は既存の
      // `resource_id` を `$ref` で受ける文字列1つだけで(`actions[].form` と同じ形)、
      // 条件分岐も確認の段も書けない**(限定2・限定4・限定5)。
      after_save: "probe-view",
      // **【V4-M23-T01 / ADR-0104 限定1〜限定4 で足した】** `$defs/view` の28キー目
      // `sum_field`(合計を出す列)。**`list_view` でだけ受理される**(form / detail_view の
      // allOf 分岐では false)——その割り当てそのものを本検査が受理集合として実測する。
      // **値は既存の `resource_id` を `$ref` で受ける文字列1つだけで(`after_save` と同じ形)、
      // 配列もオブジェクトも書けず、2つ目の演算も書けない**(限定2・限定3)。schema 検証
      // だけを見るので、指したフィールドが number 型であること・実在することは問わない
      // (その照合は `referential-integrity.ts` 側 = 限定3)。
      sum_field: "title",
      // **【`V6-M2-T01` / `K-G2` / `ADR-0289` 限定1〜限定4 で足した】** `$defs/view` の29キー目
      // `reference_pickers`(参照項目の選び方の、入力画面ごとの上書き)。**`form` でだけ
      // 受理される**(list_view / detail_view の allOf 分岐では false)——その割り当てそのものを
      // 本検査が受理集合として実測する。**値は「フィールドID → 有限3値」の対応だけで、
      // 値域は `$defs/field/properties/reference_picker` を `$ref` して二重に持たない**
      // (限定2)。schema 検証だけを見るので、指したフィールドが reference 型であること・
      // 実在することは問わない(その照合は `referential-integrity.ts` 側 = 限定4)。
      reference_pickers: { title: "list" },
      // **【2026-08-14。`V8-M8` / 台帳 `Q-G1` / 門A 本審査 = `V8-M7` で足した】**
      // **`$defs/view` の29キー目 `report`(集計表の中身)。****`report_view` でだけ
      // 受理される**(list_view / form / detail_view の allOf 分岐では false)——
      // **その割り当てそのものを本検査が受理集合として実測する。**
      // **値は束ねるキー(1〜3本)と集計(1〜3本)と絞り込みの3キーだけで、`having` も
      // 集計値による並べ替えも書けない。****schema 検証だけを見るので、指したフィールドが
      // 実在することも、束ねられる型であることも問わない**(その照合は
      // `referential-integrity.ts` 側)。
      report: { group_by: [{ field: "title" }], aggregates: [{ type: "count" }] },
      // **【2026-08-20。`V10-M1-T02` / 台帳 `NV-G4` / 門A 本審査 = `V10-M0` 群A /
      // `ADR-0359` §4a 限定1〜限定4 で足した】** **`$defs/view` の30キー目 `after_delete`
      // (削除が成立したあとの行き先)。****`detail_view` でだけ受理される**
      // (list_view / form / report_view の allOf 分岐では false)——
      // **その割り当てそのものを本検査が受理集合として実測する。**
      // **値は既存の `resource_id` を `$ref` で受ける文字列1つだけで(`after_save` と
      // 同じ形)、条件分岐も確認の段もボタン文言も書けない**(限定3・限定6)。
      // **schema 検証だけを見るので、指した画面が実在することも、それが
      // `list_view` / `report_view` であることも問わない**(その照合は
      // `referential-integrity.ts` 側 = 限定4)。
      after_delete: "probe-view",
      // **【2026-08-20。`V10-M4-T01` / 台帳 `NV-G9` / 門A 本審査 = `V10-M0` 群B /
      // `ADR-0359` §4b 限定1〜限定4 / `ADR-0360` 限定2 で足した】** **`$defs/view` の
      // 31キー目 `flow`(一続きの流れの中の段)。****`list_view` / `form` / `detail_view`
      // の3種別で受理される**(`report_view` の allOf 分岐では false)——
      // **その割り当てそのものを本検査が受理集合として実測する。**
      // **`after_delete` と違い3種別に入るので、受理集合の差分はこちらのほうが広い。**
      // **値は `id` / `step` / `kind` の3つで閉じており、4つ目のサブキーも条件も式も
      // 書けない**(限定2)。**段の種類は入力の段にしてある** —— **確認の段
      // (`kind` の2値目)は `detail_view` でしか受理されないので、3種別を同じ1つの
      // サンプルで撃つにはこちらでなければならない**(`ADR-0360` 限定2)。
      // **schema 検証だけを見るので、位置の重複や欠番は問わない**(その照合は
      // `referential-integrity.ts` 側 = 限定3)。
      flow: { id: "checkout", step: 1, kind: "input" },
      // スキーマには無い属性(限定2 の見張り。受理されないことを実測で確かめる)。
      description: "この画面の説明",
    };
    const value = values[attribute];
    if (value === undefined) {
      throw new Error(
        `view の属性 "${attribute}" のサンプル値がありません。スキーマに属性が増えたら足すこと。`,
      );
    }
    return value;
  },
});

runCrossCheck({
  label: "field (7種のフィールド型)",
  doc: manifestDoc,
  node: manifestDoc.$defs.field as SchemaNode,
  basePath: "/app/tables/0/fields/0",
  wrap: (field) => manifestWith({ fields: [field] }),
  validate: validateManifest,
  absentAttributes: ["default"],
  sample: (_context, attribute) => {
    const values: Record<string, unknown> = {
      id: "probe_field",
      name: "項目",
      required: true,
      // EC-G8 / ADR-0038: 全型で書ける任意の一意制約フラグ(select/reference の
      // options/reference_table と違い型に依らず受理される)。
      unique: true,
      options: ["未読", "読了"],
      reference_table: "books",
      // B-G2 / ADR-0071(V4-M3-T05): 項目ごとの「見せる相手」。**全型で書ける任意プロパティ**
      // であり(`unique` と同型)、値域は `$defs/view/properties/audience` を指す4ロールの列挙。
      // E-G48 / ADR-0076(V4-M10-T01): 項目ごとの「書ける相手」。**`audience` と同型の
      // 全型で書ける任意プロパティ**で、値域も同じ4ロールの列挙を `$ref` で共有する。
      // **`audience` を裏返したものではなく別のキーである**(`ADR-0076` §1b)。
      // **【`V8-M20-T01` / 台帳 `J-G27` / `J-G28` / 手続きは `ADR-0301`。2026-08-10】**
      // **上の6行が説明していた2キー(`audience` / `writable_by`)は廃止された**
      // (判定 = 廃止)。**サンプル値の2行(逐語 `audience: ["owner"],` と
      // `writable_by: ["owner"],`)を落とした** —— **この `values` はスキーマに在る属性の
      // 名前でしか引かれないので、置いたままにすると1度も引かれない死んだ値になる。**
      // **上の説明は歴史の記述として1バイトも消していない。**
      // E-G14 / F-9 / ADR-0086(V4-M10-T46): この number の値の単位。
      // **`unique` / `audience` / `writable_by` と違い、全型では書けない** ——
      // **`number` 型にだけ書ける**(限定4。`options`(select)/ `reference_table`
      // (reference)と同じ形の allOf 分岐で閉じている)。**本検査はその割り当てそのものを
      // 受理集合として実測する** —— 7つの型で拒否されることが緑の中身である。
      unit: "円",
      // P-G28 + P-G22 / ADR-0090(V4-M16-T10): この select の値ごとの強調。
      // **`unit` と同じく全型では書けない** —— **`select` 型にだけ書ける**(限定4。
      // 4本目の allOf 分岐で閉じている)。**本検査はその割り当てそのものを受理集合として
      // 実測する** —— 7つの型で拒否されることが緑の中身である。
      // **キーは上の `options` の値である**(`options` に無い値は
      // `validateReferentialIntegrity` が拒否するが、本検査が呼ぶのは構造検証だけなので、
      // ここでは形の受理集合だけを実測している)。
      emphasis: { 未読: "caution" },
      // E-G17 / ADR-0119(V4-M19-T07): 値が無い(未設定の)とき、詳細画面でその行ごと
      // 出さない宣言。**`unique` / `audience` / `writable_by` と同じく全型で書ける**
      // (`unit` / `emphasis` と違い、型で絞る allOf 分岐が1つも無い)。**本検査はその
      // 割り当てそのものを受理集合として実測する** —— 8型すべてで受理されることが緑の中身。
      hide_when_empty: true,
      // K-G1 / ADR-0288(V6-M1-T01): 他のテーブルから選ぶ項目の選び方。
      // **`unit` / `emphasis` と同じく全型では書けない** —— **`reference` 型にだけ書ける**
      // (限定4。5本目の allOf 分岐で閉じている)。**本検査はその割り当てそのものを受理集合
      // として実測する** —— 8つの型で拒否されることが緑の中身である。
      reference_picker: "list",
      // K-G7 / ADR-0290(V6-M3-T02): 参照候補の「探せる項目」の、項目ごとの上書き。
      // **`reference_picker` と同じく `reference` 型にだけ書ける**(6本目の allOf 分岐で
      // 閉じている)。**本検査はその割り当てそのものを受理集合として実測する** ——
      // 8つの型で拒否されることが緑の中身である。
      reference_search_fields: ["title"],
      default: "既定値",
    };
    const value = values[attribute];
    if (value === undefined) {
      throw new Error(
        `field の属性 "${attribute}" のサンプル値がありません。スキーマに属性が増えたら足すこと。`,
      );
    }
    return value;
  },
});

runCrossCheck({
  // **【`V5-M17b` / `ADR-0248`】** **旧 label の逐語は "operation (差分 op 16種)" である。**
  // **17種目 `set_user_kinds` が入ったので実体に合わせた** —— **この label は
  // `Object.keys(op_name.enum)` を回す describe の見出しであり、数が実体とずれると
  // `v5-merge-repair-2.md` §5-2 が数えた「テスト名だけ古い」箇所が1件増えるためである。**
  // **【`V8-M16-T03` / `J-G1b` / `D-V8-31`】** **旧 label の逐語は "operation (差分 op 17種)" である。**
  // **18種目 `set_roles` が入ったので実体に合わせた。**
  label: "operation (差分 op 18種)",
  doc: diffDoc,
  node: diffDoc.$defs.operation as SchemaNode,
  basePath: "/operations/0",
  wrap: (operation) => diffWith([operation]),
  validate: validateDiff,
  absentAttributes: ["to"],
  sample: (context, attribute) => {
    const values: Record<string, unknown> = {
      // add_table だけはテーブル定義そのもの、他はテーブルID。
      table: context === "add_table" ? { ...probeTable, id: "authors", name: "著者" } : "books",
      // add_field だけはフィールド定義そのもの、remove_field / change_field はフィールドID。
      // **この非対称は ADR-0010 §1 が代償として申告したものである**(table キーが
      // add_table と add_field で既に持っている非対称を1つ増やした)。
      field: context === "add_field" ? { id: "memo", name: "メモ", type: "text" } : "memo",
      // add_view だけは画面定義そのもの、update_view は画面ID。
      view: context === "add_view" ? probeView : "book-list",
      // changes の形も op ごとに違う(view_changes / table_changes / field_changes)。
      changes:
        context === "change_table"
          ? { name: "本(改)" }
          : context === "change_field"
            ? { name: "メモ(改)" }
            : { columns: ["title"] },
      // **ADR-0013 §4c が足した6キー目。**add_workflow / update_workflow ではワークフロー
      // 定義そのもの、remove_workflow は対象のワークフローID を持つ `{ id }` である。
      // **この非対称は table / field / view が既に持っているものと同型**であり、
      // ADR-0013 は「意味は2義に閉じる。3義目を入れてはならない」と限定している ——
      // **ここに3つ目の分岐が現れたら、それは限定3 が破られた合図である。**
      workflow:
        context === "remove_workflow"
          ? { id: "notify-on-loan" }
          : {
              id: "notify-on-loan",
              name: "貸出時に履歴を書く",
              trigger: { type: "on_create", table: "loans" },
              actions: [
                {
                  action: "create_record",
                  table: "loan-logs",
                  values: { borrower: "$record.borrower", note: "貸出を記録しました" },
                },
              ],
              history_table: "workflow-runs",
            },
      // **ADR-0024 §4c が足した7キー目。**add_function / update_function では関数定義そのもの、
      // remove_function は対象の関数ID を持つ `{ id }` である(workflow キーと同型の非対称)。
      // **ここに3つ目の分岐が現れたら、それは ADR-0024 の限定を破った合図である。**
      function:
        context === "remove_function"
          ? { id: "count-by-month" }
          : {
              id: "count-by-month",
              name: "月ごとに数える",
              code: "export default (rows) => rows;",
              input: { source: "table", table: "loans" },
              output: { fields: [{ id: "month", type: "text" }] },
            },
      // **ADR-0047 §4c が足した8キー目(V3-M1-T03。16種目の op = set_theme)。**
      // **意味は1義である** —— テーマは app に1つしか無いので対象IDを取らず、
      // `set_theme` では常に「差し替えるテーマそのもの」である(workflow / function が
      // 2義の非対称を持つのに対し、ここは分岐が無い)。**2義目が現れたら、それは
      // ADR-0047 の限定を破った合図である。**
      // **25スロット全部を書いているのは、`$defs/theme` の `required` が全スロットだから
      // である**(ADR-0047 2026-07-25 追記(2)。部分テーマを作らない)。
      theme: {
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
      },
      to: "volumes",
      // **【`V5-M17b` / `ADR-0248`】9キー目 `user_kinds` のサンプル値。**
      // **`$defs/operation.properties` が9キーになったので、この表も1本増える** ——
      // **この表は「増えたら足すこと」を例外で強制する形になっており、実際に
      // 例外(`operation の属性 "user_kinds" のサンプル値がありません`)で落ちた。**
      user_kinds: [{ id: "member", name: "会員" }],
      // **【`V8-M16-T03` / `J-G1b`】10キー目 `roles` のサンプル値。**
      // **`$defs/operation.properties` が10キーになったので、この表も1本増える** ——
      // **この表は「増えたら足すこと」を例外で強制する形になっており、実際に
      // 例外(`operation の属性 "roles" のサンプル値がありません`)で落ちた。**
      roles: [{ id: "owner", name: "運営" }],
    };
    const value = values[attribute];
    if (value === undefined) {
      throw new Error(
        `operation の属性 "${attribute}" のサンプル値がありません。スキーマに属性が増えたら足すこと。`,
      );
    }
    return value;
  },
});

describe("検証方法1: 3文脈それぞれで allowed_values の内容を固定する", () => {
  test("list_view で fields を書いたエラーに、list_view で書ける属性が列挙される", () => {
    const errors = errorsOf(
      validateManifest(
        manifestWith({
          views: [
            {
              id: "book-list",
              type: "list_view",
              table: "books",
              columns: ["title"],
              fields: ["title"],
            },
          ],
        }),
      ),
    );
    const error = errors.find((e) => e.path === "/app/views/0/fields");
    // V3-M2-T01(D-G4 / ADR-0050)が list_view の受理側にプリセット5軸を加えた
    // (detail 専用の2軸 preset_label_placement / preset_field_columns は false のまま)。
    // V3-M5-T02(D-G5 / ADR-0055)が逃げ道の参照 custom_css を加えた —— **3種すべてで書ける。**
    // **【V5-M21-T01 / `L-G1` / ADR-0171】`actions` が list_view の受理側に加わった** ——
    // **門A の本審査を通って限定採用された増分である。** **キーを1本も足していない**
    // (`$defs/view.properties` は 28 のまま)—— **加わったのは「この type で書ける」側である。**
    // **列挙を消して件数に丸めない**(`custom_css` と同じ作法)。
    expect(error?.allowed_values).toEqual([
      "id",
      "type",
      "table",
      "name",
      "columns",
      "sort",
      "filter",
      "actions",
      "preset_column_align",
      "preset_column_width",
      "preset_pager_position",
      "preset_image_size",
      "preset_text_preview",
      "custom_css",
      // **V4-M3-T02 / `B-G1` / ADR-0070 限定1 が足した19キー目 `audience`**(画面ごとに
      // 見せる相手)。**門A の本審査を通って限定採用された増分である。列挙を消して件数に
      // 丸めない**(`custom_css` と同じ作法)。
      // **【`V8-M20-T01` / 台帳 `J-G27` / 手続きは `ADR-0301`。2026-08-10】** **この19キー目
      // `audience` は廃止された**(判定 = 廃止)。**上の3行は歴史の記述として残してあり、
      // 1バイトも消していない。****列挙から1本消したのであって、件数へ丸めたのではない。**
      // **代わりに担うのは `app.roles[].rules` の「役割 × 対象(画面)× 読取」である。**
      // **E-G12 / ADR-0084(V4-M10-T45)が20キー目 `menu_listed` を足した** —— 掲載は
      // 種別に依存しない属性なので、**3種すべての受理側に加わる**(`name` と同じ)。
      "menu_listed",
      // **V4-M16-T13 / `P-G24` の (C) 側 / ADR-0093 限定1 が足した22キー目 `preset_list_shape`**
      // (一覧の器の形。8つ目の `preset_` キー)。**門A の本審査(`V4-M14` 本審査② の単位11)を
      // 通って限定採用された増分である。列挙を消して件数に丸めない**(`custom_css` /
      // `menu_listed` / `field_groups` と同じ作法)。**`list_view` でだけ書ける**(限定2)。
      "preset_list_shape",
      // **`E-G7` の (C) 側 / ADR-0112(V4-M22-T01)が24キー目 `search_fields` を足した** ——
      // **list_view の受理側にだけ加わる**(form / detail_view 分岐では `false`。限定3)。
      // **門A の本審査(V4-M22 単位A。判定 = 限定採用)を通った増分である。列挙を消して
      // 件数に丸めない**(`custom_css` / `menu_listed` / `preset_list_shape` と同じ作法)。
      "search_fields",
      // **【V4-M22-T05 / ADR-0113 限定1・限定7 で足した25キー目 `page_size`】** ——
      // **list_view の受理側にだけ加わる**(form / detail_view 分岐では `false`。限定7)。
      // **門A の本審査(V4-M22 単位C。4回目の審査。判定 = 限定採用)を通った増分である。**
      // **列挙を消して件数に丸めない**(`custom_css` / `menu_listed` / `preset_list_shape` /
      // `search_fields` と同じ作法)。
      "page_size",
      // **【V4-M19-T03 / `P-G32` の (C) 側 / ADR-0118 限定1 で足した26キー目 `preset_density`】**
      // ——**3種すべての受理側に加わる**(`name` / `custom_css` / `menu_listed` と同じ)。
      // **門A の本審査(V4-M19 単位C。2回目の審査。判定 = 限定採用)を通った増分である。**
      // **列挙を消して件数に丸めない。****本 ADR の増分ではない。**
      "preset_density",
      // **【V4-M23-T01 / ADR-0104 限定1・限定4 で足した28キー目 `sum_field`】**(合計を
      // 出す列)——**list_view の受理側にだけ加わる**(form / detail_view 分岐では `false`。
      // 限定4)。**門A の本審査(V4-M23 単位A-2。4回目の審査。判定 = 限定採用)を通った
      // 増分である。****列挙を消して件数に丸めない**(`custom_css` / `menu_listed` /
      // `preset_list_shape` / `search_fields` / `page_size` と同じ作法)。
      "sum_field",
      // **【2026-08-20。`V10-M4-T01` / 台帳 `NV-G9` / 門A 本審査 = `V10-M0` 群B /
      // `ADR-0359` §4b 限定1 が足した31キー目 `flow`】** **一続きの流れの中の段は
      // `list_view` / `form` / `detail_view` の3種別で書ける** —— **`report_view` の
      // allOf 分岐でだけ `false` である**(`V10-M4` の決1)。
      // **列挙を消して件数に丸めない。**
      "flow",
    ]);
  });

  test("detail_view で columns を書いたエラーに、detail_view で書ける属性が列挙される", () => {
    // V1-M0-T09 で `fields` が解禁されたので、detail_view の最小ケースは
    // 「fields を書いて拒否された」ではなく「columns を書いて拒否された」になる。
    const errors = errorsOf(
      validateManifest(
        manifestWith({
          views: [{ id: "book-detail", type: "detail_view", table: "books", columns: ["title"] }],
        }),
      ),
    );
    const error = errors.find((e) => e.path === "/app/views/0/columns");
    // V2-M6-T03 で `related`(EC-G17 / ADR-0044)が、V2-M6-T04 で `actions`(EC-G14 / ADR-0045)が
    // detail_view に足された —— columns/sort/filter は依然 false のまま、related / actions が受理側に加わる。
    // V3-M2-T01(D-G4 / ADR-0050)がプリセット4軸を加えた(list 専用の3軸は false のまま)。
    // V3-M5-T02(D-G5 / ADR-0055)が逃げ道の参照 custom_css を加えた —— **3種すべてで書ける。**
    expect(error?.allowed_values).toEqual([
      "id",
      "type",
      "table",
      "name",
      "fields",
      "related",
      "actions",
      "preset_label_placement",
      "preset_field_columns",
      "preset_image_size",
      "preset_text_preview",
      "custom_css",
      // **V4-M3-T02 / `B-G1` / ADR-0070 限定1 が足した19キー目 `audience`**(画面ごとに
      // 見せる相手)。**門A の本審査を通って限定採用された増分である。列挙を消して件数に
      // 丸めない**(`custom_css` と同じ作法)。
      // **【`V8-M20-T01` / 台帳 `J-G27` / 手続きは `ADR-0301`。2026-08-10】** **この19キー目
      // `audience` は廃止された**(判定 = 廃止)。**上の3行は歴史の記述として残してあり、
      // 1バイトも消していない。****列挙から1本消したのであって、件数へ丸めたのではない。**
      // **代わりに担うのは `app.roles[].rules` の「役割 × 対象(画面)× 読取」である。**
      // **E-G12 / ADR-0084(V4-M10-T45)が20キー目 `menu_listed` を足した** —— 掲載は
      // 種別に依存しない属性なので、**3種すべての受理側に加わる**(`name` と同じ)。
      "menu_listed",
      // **`P-G17` の (C) 側 / ADR-0092(V4-M16-T12)が21キー目 `field_groups` を足した** ——
      // **detail_view の受理側にだけ加わる**(list_view / form 分岐では `false`。限定2)。
      // **門A の本審査(`V4-M14` 本審査② の単位9。判定 = 限定採用)を通った増分である。
      // 列挙を消して件数に丸めない**(`custom_css` / `menu_listed` と同じ作法)。
      "field_groups",
      // **【V4-M19-T03 / `P-G32` の (C) 側 / ADR-0118 限定1 で足した26キー目 `preset_density`】**
      // ——**3種すべての受理側に加わる**(`name` / `custom_css` / `menu_listed` と同じ)。
      // **門A の本審査(V4-M19 単位C。2回目の審査。判定 = 限定採用)を通った増分である。**
      // **列挙を消して件数に丸めない。****本 ADR の増分ではない。**
      "preset_density",
      // **【2026-08-20。`V10-M1-T01` / `NV-G3a` / `ADR-0358` 限定1 で足した】** 門A の
      // 本審査(`V10-M0` 群A。判定 = 限定採用)が `detail_view` 分岐の
      // `"after_save": false,` を外したので、**この文脈(detail_view)の列挙に現れる**
      // (`list_view` / `report_view` 分岐では今日も `false`)。**列挙を消して件数に
      // 丸めない。****【意味のずれを隠さない(限定6)】詳細画面に「保存」は無い** ——
      // **発火するのは `actions` の `set` 形の書込が成立したときだけである。**
      "after_save",
      // **【2026-08-20。`V10-M1-T02` / `NV-G4` / `ADR-0359` §4a 限定1・限定2 で足した
      // 30キー目 `after_delete`】** —— **`detail_view` の受理側にだけ加わる**
      // (`list_view` / `form` / `report_view` 分岐では `false`。限定2)。
      // **門A の本審査(`V10-M0` 群A。判定 = 限定採用)を通った増分である。**
      // **列挙を消して件数に丸めない。**
      // **行き先にできるのは `list_view` / `report_view` だけだが、それは形の側では
      // 止めていない** —— **`referential-integrity.ts` が apply 時に倒すので、
      // ここ(未知プロパティの列挙)には現れない。**
      "after_delete",
      // **【2026-08-20。`V10-M4-T01` / 台帳 `NV-G9` / 門A 本審査 = `V10-M0` 群B /
      // `ADR-0359` §4b 限定1 が足した31キー目 `flow`】** **一続きの流れの中の段は
      // `list_view` / `form` / `detail_view` の3種別で書ける** —— **`report_view` の
      // allOf 分岐でだけ `false` である**(`V10-M4` の決1)。
      // **列挙を消して件数に丸めない。**
      "flow",
    ]);
  });

  test("form で sort を書いたエラーに、form で書ける属性が列挙される", () => {
    const errors = errorsOf(
      validateManifest(
        manifestWith({
          views: [
            {
              id: "book-form",
              type: "form",
              table: "books",
              fields: ["title"],
              sort: { field: "title", order: "asc" },
            },
          ],
        }),
      ),
    );
    const error = errors.find((e) => e.path === "/app/views/0/sort");
    // **form でも逃げ道の参照だけは書ける**(V3-M5-T02 / ADR-0055)—— プリセット7軸が
    // 1つも当たらない form に、逃げ道まで無いと当て先が1つも無くなるためである。
    // **V4-M3-T02 / `B-G1` / ADR-0070**: `audience` は3種すべてで書ける ——
    // **運営用の入力フォームこそ客に開かせたくない画面だからである**(allOf の3分岐の
    // どれでも false にしていない)。
    // **P-G29 / ADR-0091(V4-M16-T11)が form 分岐の `false` を2つ外した** ——
    // **直前の「プリセット7軸が1つも当たらない form」は今日から偽である。旧文は消していない。**
    // **通したのは2軸だけで、残る5軸は form で今日も `false` である**(限定3)。
    expect(error?.allowed_values).toEqual([
      "id",
      "type",
      "table",
      "name",
      "fields",
      // **並びは `$defs/view.properties` の宣言順そのままである。**
      "preset_label_placement",
      "preset_field_columns",
      "custom_css",
      // **【`V8-M20-T01` / 台帳 `J-G27` / 手続きは `ADR-0301`。2026-08-10】** **ここに在った
      // 19キー目 `audience`(逐語 `"audience",`)は廃止された**(判定 = 廃止)。
      // **上のコメント群(`V4-M3-T02` / `B-G1` / `ADR-0070` が「3種すべてで書ける」と
      // 書いた段落)は歴史の記述として1バイトも消していない。****列挙から1本消したので
      // あって、件数へ丸めたのではない。**
      // **E-G12 / ADR-0084(V4-M10-T45)が20キー目 `menu_listed` を足した** —— 掲載は
      // 種別に依存しない属性なので、**3種すべての受理側に加わる**(`name` と同じ)。
      "menu_listed",
      // **`P-G14` の (C) 側 / ADR-0095(V4-M18-T03)が23キー目 `modal` を足した** ——
      // **`form` でだけ受理される**(限定4)ので、この文脈(form)の列挙に現れる。
      // **単独では受理されないが(限定5)、`additionalProperties` の列挙は「書ける属性の
      // 集合」であって「単独で受理される値の集合」ではないので、ここには載る。**
      "modal",
      // **【V4-M19-T03 / `P-G32` の (C) 側 / ADR-0118 限定1 で足した26キー目 `preset_density`】**
      // ——**3種すべての受理側に加わる**(`name` / `custom_css` / `menu_listed` と同じ)ので、
      // この文脈(form)の列挙にも現れる。**門A の本審査(V4-M19 単位C。2回目の審査。
      // 判定 = 限定採用)を通った増分である。****本 ADR の増分ではない。**
      "preset_density",
      // **【V4-M20-T04 / ADR-0102 限定1・限定3 で足した27キー目 `after_save`】** ——
      // **`form` でだけ受理される**(限定3)ので、この文脈(form)の列挙に現れる
      // (list_view / detail_view 分岐では `false`)。**門A の本審査(V4-M20 単位D。
      // 2回目の審査。判定 = 限定採用)を通った増分である。**
      "after_save",
      // **【`V6-M2-T01` / `K-G2` / `ADR-0289` 限定1・限定4 で足した29キー目
      // `reference_pickers`】** —— **`form` でだけ受理される**(限定4)ので、この文脈(form)の
      // 列挙に現れる(list_view / detail_view 分岐では `false`)。**門A の本審査
      // (`V6-M0` 単位A。判定 = 限定採用)を通った増分である。**
      "reference_pickers",
      // **【2026-08-20。`V10-M4-T01` / 台帳 `NV-G9` / 門A 本審査 = `V10-M0` 群B /
      // `ADR-0359` §4b 限定1 が足した31キー目 `flow`】** **一続きの流れの中の段は
      // `list_view` / `form` / `detail_view` の3種別で書ける** —— **`report_view` の
      // allOf 分岐でだけ `false` である**(`V10-M4` の決1)。
      // **列挙を消して件数に丸めない。**
      "flow",
    ]);
  });

  test("差分パッチの add_view でも同じ列挙が返る(F-3 が実地で出た位置)", () => {
    const errors = errorsOf(
      validateDiff(
        diffWith([
          {
            op: "add_view",
            view: { id: "book-detail", type: "detail_view", table: "books", columns: ["title"] },
          },
        ]),
      ),
    );
    const error = errors.find((e) => e.path === "/operations/0/view/columns");
    // detail_view の受理側は V2-M6-T03 で related を、V2-M6-T04 で actions を加えた
    // (EC-G17 / ADR-0044・EC-G14 / ADR-0045)。V3-M2-T01 がプリセット4軸を加えた(ADR-0050)。
    // V3-M5-T02(D-G5 / ADR-0055)が逃げ道の参照 custom_css を加えた —— **3種すべてで書ける。**
    expect(error?.allowed_values).toEqual([
      "id",
      "type",
      "table",
      "name",
      "fields",
      "related",
      "actions",
      "preset_label_placement",
      "preset_field_columns",
      "preset_image_size",
      "preset_text_preview",
      "custom_css",
      // **V4-M3-T02 / `B-G1` / ADR-0070 限定1 が足した19キー目 `audience`**(画面ごとに
      // 見せる相手)。**門A の本審査を通って限定採用された増分である。列挙を消して件数に
      // 丸めない**(`custom_css` と同じ作法)。
      // **【`V8-M20-T01` / 台帳 `J-G27` / 手続きは `ADR-0301`。2026-08-10】** **この19キー目
      // `audience` は廃止された**(判定 = 廃止)。**上の3行は歴史の記述として残してあり、
      // 1バイトも消していない。****列挙から1本消したのであって、件数へ丸めたのではない。**
      // **代わりに担うのは `app.roles[].rules` の「役割 × 対象(画面)× 読取」である。**
      // **E-G12 / ADR-0084(V4-M10-T45)が20キー目 `menu_listed` を足した** —— 掲載は
      // 種別に依存しない属性なので、**3種すべての受理側に加わる**(`name` と同じ)。
      "menu_listed",
      // **`P-G17` の (C) 側 / ADR-0092(V4-M16-T12)が21キー目 `field_groups` を足した** ——
      // **detail_view の受理側にだけ加わる**(list_view / form 分岐では `false`。限定2)。
      // **門A の本審査(`V4-M14` 本審査② の単位9。判定 = 限定採用)を通った増分である。
      // 列挙を消して件数に丸めない**(`custom_css` / `menu_listed` と同じ作法)。
      "field_groups",
      // **【V4-M19-T03 / `P-G32` の (C) 側 / ADR-0118 限定1 で足した26キー目 `preset_density`】**
      // ——**3種すべての受理側に加わる**(`name` / `custom_css` / `menu_listed` と同じ)。
      // **門A の本審査(V4-M19 単位C。2回目の審査。判定 = 限定採用)を通った増分である。**
      // **列挙を消して件数に丸めない。****本 ADR の増分ではない。**
      "preset_density",
      // **【2026-08-20。`V10-M1-T01` / `NV-G3a` / `ADR-0358` 限定1 で足した】** 門A の
      // 本審査(`V10-M0` 群A。判定 = 限定採用)が `detail_view` 分岐の
      // `"after_save": false,` を外したので、**この文脈(detail_view)の列挙に現れる**
      // (`list_view` / `report_view` 分岐では今日も `false`)。**列挙を消して件数に
      // 丸めない。****【意味のずれを隠さない(限定6)】詳細画面に「保存」は無い** ——
      // **発火するのは `actions` の `set` 形の書込が成立したときだけである。**
      "after_save",
      // **【2026-08-20。`V10-M1-T02` / `NV-G4` / `ADR-0359` §4a 限定1・限定2 で足した
      // 30キー目 `after_delete`】** —— **`detail_view` の受理側にだけ加わる**
      // (`list_view` / `form` / `report_view` 分岐では `false`。限定2)。
      // **門A の本審査(`V10-M0` 群A。判定 = 限定採用)を通った増分である。**
      // **列挙を消して件数に丸めない。**
      // **行き先にできるのは `list_view` / `report_view` だけだが、それは形の側では
      // 止めていない** —— **`referential-integrity.ts` が apply 時に倒すので、
      // ここ(未知プロパティの列挙)には現れない。**
      "after_delete",
      // **【2026-08-20。`V10-M4-T01` / 台帳 `NV-G9` / 門A 本審査 = `V10-M0` 群B /
      // `ADR-0359` §4b 限定1 が足した31キー目 `flow`】** **一続きの流れの中の段は
      // `list_view` / `form` / `detail_view` の3種別で書ける** —— **`report_view` の
      // allOf 分岐でだけ `false` である**(`V10-M4` の決1)。
      // **列挙を消して件数に丸めない。**
      "flow",
    ]);
  });

  test("T09 後の受理集合の確認: add_view で detail_view に fields を書いても拒否されない", () => {
    // 完了条件1 の読み替えの根拠。計画書が挙げた最小ケースはもう成立しない。
    const result = validateDiff(
      diffWith([
        {
          op: "add_view",
          view: { id: "book-detail", type: "detail_view", table: "books", fields: ["title"] },
        },
      ]),
    );
    expect(result.valid).toBe(true);
  });
});

describe("完了条件3: 一致を保証できない位置では列挙を出さない(憲法6)", () => {
  test("false schema に対応する if エラーが無ければ allowed_values を付けない", () => {
    const errors = toValidationErrors([
      {
        keyword: "false schema",
        instancePath: "/app/views/0/columns",
        schemaPath: "#/allOf/2/then/properties/columns/false schema",
        params: {},
        parentSchema: false,
        data: ["title"],
        // biome-ignore lint/suspicious/noExplicitAny: 合成した Ajv エラー
      } as any,
    ]);
    expect(errors[0]?.allowed_values).toBeUndefined();
    expect(errors[0]?.hint).toBeDefined();
  });

  test("解釈できない条件分岐(anyOf)を持つ位置では allowed_values を付けない", () => {
    const errors = toValidationErrors([
      {
        keyword: "additionalProperties",
        instancePath: "/app/views/0",
        schemaPath: "#/additionalProperties",
        params: { additionalProperty: "width" },
        parentSchema: {
          type: "object",
          additionalProperties: false,
          properties: { id: {}, type: {} },
          anyOf: [{ required: ["id"] }],
        },
        data: { id: "v", type: "form", width: 100 },
        // biome-ignore lint/suspicious/noExplicitAny: 合成した Ajv エラー
      } as any,
    ]);
    expect(errors[0]?.allowed_values).toBeUndefined();
    expect(errors[0]?.hint).toBeDefined();
  });

  test("if の形が未対応(const による場合分けでない)なら allowed_values を付けない", () => {
    const errors = toValidationErrors([
      {
        keyword: "additionalProperties",
        instancePath: "/app/views/0",
        schemaPath: "#/additionalProperties",
        params: { additionalProperty: "width" },
        parentSchema: {
          type: "object",
          additionalProperties: false,
          properties: { id: {}, type: {}, columns: {} },
          // biome-ignore lint/suspicious/noThenProperty: JSON Schema の `then` キーワードそのもの
          allOf: [{ if: { minProperties: 2 }, then: { properties: { columns: false } } }],
        },
        data: { id: "v", type: "form", width: 100 },
        // biome-ignore lint/suspicious/noExplicitAny: 合成した Ajv エラー
      } as any,
    ]);
    expect(errors[0]?.allowed_values).toBeUndefined();
    expect(errors[0]?.hint).toBeDefined();
  });

  test("additionalProperties: false でない位置では allowed_values を付けない", () => {
    // 「これだけが書ける」と言い切れないので列挙は嘘になる。
    const errors = toValidationErrors([
      {
        keyword: "additionalProperties",
        instancePath: "/app",
        schemaPath: "#/additionalProperties",
        params: { additionalProperty: "theme" },
        parentSchema: { type: "object", properties: { id: {}, name: {} } },
        data: { id: "a", name: "A", theme: "dark" },
        // biome-ignore lint/suspicious/noExplicitAny: 合成した Ajv エラー
      } as any,
    ]);
    expect(errors[0]?.allowed_values).toBeUndefined();
  });
});

// ============================================================================
// V1-M2-T05a D3: ワークフローのアクションの値に boolean / number を書いたとき
// ============================================================================

/**
 * **汎用の「string を指定してください」が、この位置でだけ罠になる。**
 *
 * V1-M2-T05 の実地検証(証跡 `docs/evidence/cp-v1-2/transcripts/001..003`)で
 * 3試行すべてが踏んだ。boolean 列に書き込むワークフローを作ろうとして
 * `values: { confirmed: true }` と書き、次のエラーを受け取る:
 *
 * > `confirmed の型が不正です。string を指定してください(実際の値: true)。`
 *
 * **助言に従うと永久に壊れる。**`"true"` と文字列にすると**差分は通る**が、
 * 実行のたびにレコード書き込みが
 * `フィールド "confirmed" には 真偽値(boolean) を指定してください` で弾かれる。
 * **作った時点では成功して見えるのに、二度と動かない。**
 *
 * T05 単位A は `apply_diff` の説明文にこの警告を書いたが、**効かなかった** ——
 * このエラー文面が正面から矛盾するからである(3試行すべてで踏んだ)。
 * 説明文とエラー文面が食い違ったら、**AI はエラー文面に従う。**
 *
 * 正しい直し方は「文字列にする」ではなく**「書き込み先の列を text / long_text にする」**。
 */
describe("ワークフローのアクションの値の型エラーは、罠へ誘導しない(V1-M2-T05a D3)", () => {
  /** `values` に boolean を書いたワークフローを含む diff。 */
  function diffWithActionValue(value: unknown) {
    return {
      diff_id: "d-1",
      intent: "確認済みフラグを立てたい",
      operations: [
        {
          op: "add_workflow",
          workflow: {
            id: "confirm",
            name: "確認済みにする",
            trigger: { type: "on_create", table: "bookings" },
            actions: [
              {
                action: "update_record",
                table: "bookings",
                target: "$record._id",
                values: { confirmed: value },
              },
            ],
            history_table: "wf-runs",
          },
        },
      ],
    };
  }

  /** 指定パスのエラーを1件取り出す。 */
  function at(errors: ValidationError[], path: string): ValidationError {
    const found = errors.find((error) => error.path === path);
    if (found === undefined) {
      throw new Error(`パス ${path} のエラーがありません: ${JSON.stringify(errors)}`);
    }
    return found;
  }

  test("boolean を書いたとき『string を指定してください』とは言わない", () => {
    const errors = errorsOf(validateDiff(diffWithActionValue(true)));
    const error = at(errors, "/operations/0/workflow/actions/0/values/confirmed");

    // **これが罠の本体。**この文字列が出てはならない。
    expect(error.message).not.toContain("string を指定してください");
    expect(`${error.message}${error.hint ?? ""}`).not.toContain("string を指定してください");
  });

  test("文字列にすれば通る、という助言をしない", () => {
    const errors = errorsOf(validateDiff(diffWithActionValue(true)));
    const error = at(errors, "/operations/0/workflow/actions/0/values/confirmed");
    const whole = `${error.message}${error.hint ?? ""}`;

    // 「"true" と書けばよい」に読める助言が無いこと。
    expect(whole).not.toContain('"true"');
    // **本当のこと**を言っていること。
    expect(whole).toContain("文字列");
    expect(whole).toContain("実行");
  });

  test("正しい直し方(列を text / long_text にする)を示す", () => {
    const errors = errorsOf(validateDiff(diffWithActionValue(true)));
    const error = at(errors, "/operations/0/workflow/actions/0/values/confirmed");
    const whole = `${error.message}${error.hint ?? ""}`;

    expect(whole).toContain("text");
    expect(whole).toContain("long_text");
  });

  test("実際に書いた値がメッセージに出る(何を直すのかが分かる)", () => {
    const errors = errorsOf(validateDiff(diffWithActionValue(true)));
    expect(at(errors, "/operations/0/workflow/actions/0/values/confirmed").message).toContain(
      "true",
    );
  });

  test("number でも同じ扱いになる(boolean 決め打ちにしない)", () => {
    const errors = errorsOf(validateDiff(diffWithActionValue(42)));
    const error = at(errors, "/operations/0/workflow/actions/0/values/confirmed");
    expect(error.message).not.toContain("string を指定してください");
    expect(`${error.message}${error.hint ?? ""}`).toContain("long_text");
  });

  test("update_record の target でも同じ扱いになる($defs/action_value の位置だから)", () => {
    const diff = {
      diff_id: "d-2",
      intent: "対象を指定したい",
      operations: [
        {
          op: "add_workflow",
          workflow: {
            id: "confirm",
            name: "確認済みにする",
            trigger: { type: "on_create", table: "bookings" },
            actions: [
              {
                action: "update_record",
                table: "bookings",
                target: 1,
                values: { note: "ok" },
              },
            ],
            history_table: "wf-runs",
          },
        },
      ],
    };
    const errors = errorsOf(validateDiff(diff));
    const error = errors.find(
      (candidate) => candidate.path === "/operations/0/workflow/actions/0/target",
    );
    expect(error).toBeDefined();
    expect(error?.message).not.toContain("string を指定してください");
  });

  test("マニフェスト検証でも同じ文面になる(diff 経路だけの手当てにしない)", () => {
    const manifest = {
      app: {
        id: "a",
        name: "A",
        tables: [
          {
            id: "bookings",
            name: "予約",
            fields: [{ id: "confirmed", name: "確認", type: "boolean" }],
          },
        ],
        views: [],
        workflows: [
          {
            id: "confirm",
            name: "確認済みにする",
            trigger: { type: "on_create", table: "bookings" },
            actions: [
              {
                action: "update_record",
                table: "bookings",
                target: "$record._id",
                values: { confirmed: true },
              },
            ],
            history_table: "wf-runs",
          },
        ],
      },
    };
    const result = validateManifest(manifest);
    if (result.valid) {
      throw new Error("検証が通ってしまいました");
    }
    const error = result.errors.find(
      (candidate) => candidate.path === "/app/workflows/0/actions/0/values/confirmed",
    );
    expect(error).toBeDefined();
    expect(error?.message).not.toContain("string を指定してください");
  });

  test("ワークフロー以外の位置の型エラーは、これまでどおりの汎用文面のまま", () => {
    const errors = errorsOf(
      validateDiff({
        diff_id: "d-3",
        intent: "テーブル名を変えたい",
        operations: [{ op: "change_table", table: "bookings", changes: { name: 7 } }],
      }),
    );
    const error = at(errors, "/operations/0/changes/name");
    // **巻き添えで書き換えない。**ここは文字列にすれば本当に直る位置である。
    expect(error.message).toContain("string を指定してください");
  });

  // --------------------------------------------------------------------------
  // V1-M2-T05c 件1: select についての嘘を戻さないための歯止め
  //
  // 旧文面は `boolean / number / date / select の列に、ワークフローから値を
  // 書くことはできません。` と書いていた。**select について事実に反する。**
  // 実測(V1-M2-T05 実地検証):
  //   - select 列(options: 未点検 / 点検済)に "未点検" を書くワークフローは
  //     3回とも**成功した**
  //   - options に無い "unknown" を書くと実行時に拒否される
  //     (「選択肢にない値 "unknown" が指定されました」)
  // つまり **options に一致する文字列なら書ける。**
  // この嘘の実害として、AI が食い違いを検出し、**不要な破壊的変更
  // (select → text)をユーザに提案するところまで行った。**
  //
  // 拒否の理由は `src/mcp/vocabulary.ts:339-343` が履歴テーブルの
  // status / trigger_type に select を使うなと言うのと**同じ理由**である ——
  // options 不一致による実行時拒否。文面はそこと整合していなければならない。
  //
  // 以下の3本は双方向の歯止め:(a) 嘘が戻らない / (b) 事実が消えない /
  // (c) 本当に書けない型(boolean / number。**T05c 追補で date を外した**)を
  //     巻き添えで消していない。
  // --------------------------------------------------------------------------

  /** D3 の hint(action_value の位置の型エラー)を1件取り出す。 */
  function actionValueHint(): string {
    const errors = errorsOf(validateDiff(diffWithActionValue(true)));
    const error = at(errors, "/operations/0/workflow/actions/0/values/confirmed");
    return `${error.message}${error.hint ?? ""}`;
  }

  test("(a) select にも書けない、と読める文言を含まない(嘘を戻さない)", () => {
    const whole = actionValueHint();

    // **旧文面そのもの。**これが復活したら赤にする。
    expect(whole).not.toContain(
      "boolean / number / date / select の列に、ワークフローから値を書くことはできません。",
    );
    // 言い回しを変えて同じ嘘を書くことも防ぐ:select を「書けない」側に並べない。
    expect(whole).not.toMatch(/select[^。]*(書くことはできません|書けません)/);
  });

  test("(b) select には書けること、ただし options 一致に限ることの両方を言う", () => {
    const whole = actionValueHint();

    // select に触れていること。
    expect(whole).toContain("select");
    // 「書ける」ことを言っていること。
    expect(whole).toMatch(/select[^。]*書け(る|ます)/);
    // 「options に一致する値に限る」ことを言っていること。
    expect(whole).toContain("options");
    expect(whole).toMatch(/options[^。]*一致/);
    // vocabulary.ts:339-343 と同じ理由(実行時に弾かれる)であると読めること。
    expect(whole).toContain("実行時");
    expect(whole).toContain("弾かれ");
  });

  // **V1-M9-T13 (2) で「boolean / number 列には一切書けない」という過剰宣言を精密化した。**
  // 型が合わない値(文字列リテラル・型違いの $record.<列>)は**適用時に拒否される**が、
  // 型が合う値($record.<boolean 列> / $record.<number 列>)は書ける。旧文言
  // 「boolean / number の列には、ワークフローから値を書けません」は、型が合う参照でも
  // 書ける以上は逆に嘘になるので、hint は「正しい行き先」を示す形へ変えた。
  test("(c) boolean / number の型不整合は適用時に拒否され、正しい行き先(同型の参照)を示す", () => {
    const whole = actionValueHint();

    expect(whole).toContain("boolean");
    expect(whole).toContain("number");
    // 型が合わない文字列は適用時に拒否される(実行時まで通ってしまう旧挙動ではない)。
    expect(whole).toContain("適用時に拒否されます");
    // 「一切書けない」という過剰宣言を復活させない。
    expect(whole).not.toMatch(
      /boolean \/ number[^。]*(列には、ワークフローから値を書けません|列に値を書けません)/,
    );
    // 正しい行き先(同じ型のフィールド参照なら書ける)を示している。
    expect(whole).toContain("$record.<boolean 列>");
    expect(whole).toContain("$record.<number 列>");
  });

  // --------------------------------------------------------------------------
  // V1-M2-T05c 追補: **`date` についての嘘**を戻さないための歯止め
  //
  // ## 経緯(実測されていない主張が2世代引き継がれた)
  //
  // - **V1-M2-T04 が実測したのは `boolean` と `number` の2つだけ**である。
  //   `"true"` / `"3"` が差分を通って実行時に弾かれることを確かめた。
  // - **`date` は誰も試していなかった。**それを T05 単位A が
  //   「boolean / number / date」と**3つに広げて書いた**。
  // - **T05c 件1 は `select` の嘘だけを直し、`date` の記述は従来のまま維持した**
  //   (T05c 記録 §4-2 が「`date` はいまも未検証」と自分で申告している)。
  // - 結果、**実測に裏づけの無い主張が2世代にわたって引き継がれた。**
  //
  // ## 実測(T05c 追補。実カーネル + 実 SQLite。推測ではない)
  //
  //   date 列に "2026-07-20"                  → **受理**(そのまま書かれる)
  //   date 列に "2026-07-20T10:00:00.000Z"    → **受理**
  //   date 列に "$record.<date フィールド>"    → **受理**(他の日付列から写せる)
  //   date 列に "きのう"                       → **実行時に拒否**
  //     履歴 error: アクション1(create_record → notes): /d フィールド "d" の値
  //     "きのう" は ISO8601 形式の日付ではありません。
  //
  // つまり **`date` は `select` と同じ型の話**である ——
  // 「**書けるが、値の形が合っていないと実行時に弾かれる**」。
  // 2つを同じ形で説明すると文面が短くなり、AI にとっても1つの規則で済む。
  //
  // 以下2本は (a)(b) と同じ双方向:嘘が戻らない / 事実が消えない。
  // --------------------------------------------------------------------------

  test("(d) date にも書けない、と読める文言を含まない(嘘を戻さない)", () => {
    const whole = actionValueHint();

    // **T05c 件1 が置いた文面そのもの。**これが復活したら赤にする。
    expect(whole).not.toContain(
      "boolean / number / date の列には、ワークフローから値を書けません。",
    );
    // 旧々版(T05a)の文面も塞いだままにする。
    expect(whole).not.toContain(
      "boolean / number / date / select の列に、ワークフローから値を書くことはできません。",
    );
    // 言い回しを変えて同じ嘘を書くことも防ぐ:date を「書けない」側に並べない。
    expect(whole).not.toMatch(/date[^。]*(書くことはできません|書けません)/);
  });

  test("(e) date には書けること、ただし ISO8601 形式に限ることの両方を言う", () => {
    const whole = actionValueHint();

    expect(whole).toContain("date");
    // 「書ける」ことを言っていること。
    expect(whole).toMatch(/date[^。]*書け(る|ます)/);
    // 形式の条件(ISO8601)を名指ししていること。**これが select の options に当たる。**
    expect(whole).toContain("ISO8601");
    // select と同じ壊れ方(差分は通り、実行時に弾かれる)であると読めること。
    expect(whole).toContain("実行時");
    expect(whole).toContain("弾かれ");
  });
});

// ---------------------------------------------------------------------------
// V1-M2-T05e / T05d 完了条件3・4(C-3): `case "pattern":` の3世代目の誤誘導を潰す
//
// **これは「あれば良い」分岐ではない。無ければ制約が有害になる分岐である。**
//
// T05d §5-4 が実測した既存の欠陥: `case "pattern":` は `VIEW_TABLE_PATH` に
// 一致しない限り `RESOURCE_ID_PATTERN_HINT` を返すので、`$foo` と書いた AI に
// 「英小文字で始まり…」と答える。**従うと `foo` になり、リテラルとして通り、
// 黙って書き込まれる。`$record.` が1文字も出ない。**
//
// T05e で `else` の pattern を足したことにより、**口ひげ記法にも同じ hint が付く
// ようになった**(実測。分岐を書かない限り
// 「`{{record.name}}` は識別子の規約に合いません / 英小文字で始まり…」と返る)。
// T05a が `case "type":` で、T05c が説明文で潰した類型の**3世代目**である。
//
// 文面の要件は T05d §5-3 が4点で定めている(必ず含める)/ 3点で禁じている。
// ---------------------------------------------------------------------------
describe("V1-M2-T05e: action_value の pattern エラーは罠へ誘導しない(C-3)", () => {
  /** `values.title` に任意の値を書いたワークフローを含む diff。 */
  function diffWithValue(value: string) {
    return {
      diff_id: "d-1",
      intent: "通知したい",
      operations: [
        {
          op: "add_workflow",
          workflow: {
            id: "notify",
            name: "通知",
            trigger: { type: "on_create", table: "bookings" },
            actions: [
              { action: "create_record", table: "notifications", values: { title: value } },
            ],
            history_table: "wf-runs",
          },
        },
      ],
    };
  }

  /** `values.title` の位置のエラー1件(message + hint を連結して返す)。 */
  function wholeFor(value: string): { message: string; hint: string; whole: string } {
    const errors = errorsOf(validateDiff(diffWithValue(value)));
    const error = errors.find(
      (candidate) => candidate.path === "/operations/0/workflow/actions/0/values/title",
    );
    if (error === undefined) {
      throw new Error(`エラーがありません: ${JSON.stringify(errors)}`);
    }
    return {
      message: error.message,
      hint: error.hint ?? "",
      whole: `${error.message}${error.hint ?? ""}`,
    };
  }

  // --- 口ひげ記法(T05e が新たに拒否するようになったもの) ---

  test("『識別子の規約に合いません』とは言わない(汎用文面に落ちていない)", () => {
    expect(wholeFor("{{record.name}}").whole).not.toContain("識別子の規約に合いません");
  });

  test("RESOURCE_ID_PATTERN_HINT が返らない(3世代目の誤誘導を潰す)", () => {
    // **これが誤誘導の本体。**従うと `record.name`(リテラル)になる。
    expect(wholeFor("{{record.name}}").whole).not.toContain("英小文字で始まり");
  });

  test("§5-3 (1) 置換されないことを『結果』で書く(そのまま書き込まれる)", () => {
    const { message } = wholeFor("{{record.name}}");
    // 「参照として解釈されません」ではなく、**起きる結果**で書くこと。
    expect(message).toContain("置換されません");
    expect(message).toContain("そのまま");
    expect(message).toContain("書き込まれます");
    // 実際に書いた値が出ること(何を直すのかが分かる)。
    expect(message).toContain("{{record.name}}");
  });

  test("§5-3 (2) $record.<フィールドID> を字面で書く(実地で機能した唯一の情報)", () => {
    expect(wholeFor("{{record.name}}").whole).toContain("$record.<フィールドID>");
  });

  test("§5-3 (3) $record._id も書く(002 / 005 が欲しかったのは _id である)", () => {
    // `<フィールドID>` だけだと `_id` が該当すると読めない(`_id` は `[a-z]` 始まりではない)。
    expect(wholeFor("{{record.name}}").whole).toContain("$record._id");
  });

  test("§5-3 (4) 連結できないことを、その場で言う(D2-b への正直な回答)", () => {
    const { whole } = wholeFor("新しい申し込みが来ました: {{record.name}}");
    // 「できません」と正直に書く。書かないと AI は連結を試み続け、
    // 理由が分からないまま「誰の申し込みか載せる手段は無い」の誤った断定へ戻る。
    expect(whole).toMatch(/つなげ|連結/);
    expect(whole).toContain("できません");
  });

  test("§5-3 禁止1『波括弧を外せ』とは書かない(従うと黙って書き込まれる)", () => {
    const { whole } = wholeFor("{{record.name}}");
    // **波括弧を外すと `record.name` になり、リテラルとして通り、また黙って書き込まれる。**
    // T05a が塞いだ罠(「言われたとおり直すと通るが永久に動かない」)の新種を作らない。
    expect(whole).not.toMatch(/波括弧を(外し|取り除い|削除し)て(ください|下さい)/);
    // 外しても直らないことを、逆に明示していること。
    expect(whole).toContain("直りません");
  });

  // --- `$foo`(制約前から拒否されていたが、hint が誤誘導だったもの) ---

  test("完了条件4: $foo にも同じ分岐が掛かり、『英小文字で始まり』が返らない", () => {
    // **T05d §5-4 が実出力で示した既存の欠陥。**同じ `case "pattern":` の
    // 同じ分岐が両方を捕まえるので、ここで同時に解消される。
    const { whole } = wholeFor("$foo");
    expect(whole).not.toContain("英小文字で始まり");
    expect(whole).not.toContain("識別子の規約に合いません");
  });

  test("完了条件4: $foo にも $record. の正しい形が示される", () => {
    const { whole } = wholeFor("$foo");
    expect(whole).toContain("$record.<フィールドID>");
    expect(whole).toContain("$record._id");
  });

  test("$foo には『そのまま書き込まれます』とは言わない(それは事実ではない)", () => {
    // `$foo` は**拒否される**のであって、書き込まれない。
    // 口ひげ側の文面をそのまま流用すると、ここで新しい嘘を作る。
    expect(wholeFor("$foo").message).not.toContain("そのまま");
  });

  // --- 巻き添えの歯止め ---

  test("action_value 以外の位置の pattern エラーは、これまでどおりの汎用文面のまま", () => {
    const errors = errorsOf(
      validateDiff({
        diff_id: "d-2",
        intent: "テーブルを足したい",
        operations: [{ op: "add_table", table: { id: "BAD ID", name: "だめ", fields: [] } }],
      }),
    );
    const error = errors.find((candidate) => candidate.path === "/operations/0/table/id");
    if (error === undefined) {
      throw new Error(`エラーがありません: ${JSON.stringify(errors)}`);
    }
    // **巻き添えで書き換えない。**ここは本当に識別子の規約の話である。
    expect(error.message).toContain("識別子の規約に合いません");
    expect(error.hint).toContain("英小文字で始まり");
  });

  test("target の口ひげ記法にも同じ文面が付く($ref 経由)", () => {
    const errors = errorsOf(
      validateDiff({
        diff_id: "d-3",
        intent: "対象を指定したい",
        operations: [
          {
            op: "add_workflow",
            workflow: {
              id: "notify",
              name: "通知",
              trigger: { type: "on_create", table: "bookings" },
              actions: [
                {
                  action: "update_record",
                  table: "bookings",
                  target: "{{record._id}}",
                  values: { title: "ok" },
                },
              ],
              history_table: "wf-runs",
            },
          },
        ],
      }),
    );
    const error = errors.find(
      (candidate) => candidate.path === "/operations/0/workflow/actions/0/target",
    );
    if (error === undefined) {
      throw new Error(`エラーがありません: ${JSON.stringify(errors)}`);
    }
    expect(`${error.message}${error.hint ?? ""}`).not.toContain("英小文字で始まり");
    expect(`${error.message}${error.hint ?? ""}`).toContain("$record._id");
  });
});

/**
 * テーマのスロット値の pattern hint(V3-M1-T08。値域の正は ADR-0046 / ADR-0047)。
 *
 * **汎用の pattern hint が誤誘導になる位置の3件目である。** 1件目は `view.table`
 * (ADR-0006 §11 —— `_apps` に辿り着けない)、2件目は `$defs/action_value`
 * (V1-M2-T05e —— 従うと `foo` になって黙って書き込まれる)、そして3件目がテーマの
 * スロットである。**V3-M1-T03 が「リソースID ではない `pattern`」を初めて大量
 * (25スロット / 5族)に持ち込んだ**ので、既定の `RESOURCE_ID_PATTERN_HINT` が
 * 25箇所で嘘になった。T07 が実測でそれを見つけている
 * (`docs/plan/v3/records/v3-m1-t07.md` §3-5 (A) —— **従うと収束しない**)。
 *
 * ## 数もスロット名も直書きしない
 *
 * **スロット集合と `pattern` は `manifestSchema` から導く。** 25個の名前をここに
 * 書き写すと、`$defs/theme` にスロットが1つ増えた日に「hint が付いていない
 * スロットが1つある」状態が緑のまま通る —— それは
 * `DIFF_OP_ENUM_HINT` の追随漏れが3度起きたのと同じ形である(`:149`〜`:154`)。
 * **族の判定も `pattern` の文字列から行う**(スロット名の一覧を第4の写しにしない)。
 */
describe("V3-M1-T08: テーマのスロット値の pattern エラーは書式を教える(専用文面の3件目)", () => {
  const themeSlotSchemas = (
    manifestSchema as unknown as {
      $defs: { theme: { properties: Record<string, { pattern: string }> } };
    }
  ).$defs.theme.properties;

  /**
   * その `pattern` を満たす値を1つ返す(族が分からなければ undefined)。
   *
   * **プロダクション側の族判定とは独立に書いている**(同じ関数を import すると
   * 「実装が族を取り違えていても緑」になる)。族が1つ増えたら undefined が返り、
   * 下の網羅検査が赤くなる。
   */
  function baseValueFor(pattern: string): string | undefined {
    if (pattern.startsWith("^#(")) {
      return "#333333";
    }
    if (pattern.startsWith("^(none|")) {
      return "none";
    }
    if (pattern.startsWith("^(0|")) {
      return "8px";
    }
    if (pattern.startsWith("^[0-9]{1,2}")) {
      return "1.6";
    }
    if (pattern.startsWith("^[^(")) {
      return "system-ui, sans-serif";
    }
    return undefined;
  }

  /** 書式を満たす25スロットを作り、指定分だけ差し替える。 */
  function themeSlots(overrides: Record<string, unknown>): Record<string, unknown> {
    const slots: Record<string, unknown> = {};
    for (const [name, schema] of Object.entries(themeSlotSchemas)) {
      const base = baseValueFor(schema.pattern);
      if (base === undefined) {
        throw new Error(`族が判定できないスロットがある: ${name}(pattern: ${schema.pattern})`);
      }
      slots[name] = base;
    }
    return { ...slots, ...overrides };
  }

  function themeDiffWith(overrides: Record<string, unknown>): unknown {
    return diffWith([{ op: "set_theme", theme: { slots: themeSlots(overrides) } }]);
  }

  /** 差分側(`/operations/0/theme/slots/<slot>`)のエラー1件。 */
  function themeErrorFor(slot: string, value: unknown): ValidationError {
    const errors = errorsOf(validateDiff(themeDiffWith({ [slot]: value })));
    const error = errors.find((e) => e.path === `/operations/0/theme/slots/${slot}`);
    if (error === undefined) {
      throw new Error(`${slot} のエラーがありません: ${JSON.stringify(errors)}`);
    }
    return error;
  }

  /** hint の `(例: A / B)` から候補値を取り出す(**hint しか読まない**)。 */
  function examplesIn(hint: string): string[] {
    const matched = /\(例: ([^)]+)\)/.exec(hint);
    if (matched?.[1] === undefined) {
      throw new Error(`hint に「(例: …)」がありません: ${hint}`);
    }
    return matched[1].split(" / ");
  }

  test("前提: 書式を満たす25スロットは差分検証を通る(測定の土台が空回りしていない)", () => {
    expect(Object.keys(themeSlotSchemas)).toHaveLength(25);
    expect(validateDiff(themeDiffWith({})).valid).toBe(true);
  });

  test("T07 が見つけた本体 —— --color-text に blue と書いたときリソースIDの文面を返さない", () => {
    const error = themeErrorFor("--color-text", "blue");
    const whole = `${error.message}${error.hint ?? ""}`;
    // **これが誤誘導の本体。**従うと `blue-x` のような識別子になり、収束しない。
    expect(whole).not.toContain("英小文字で始まり");
    expect(whole).not.toContain("book-tracker");
    expect(error.message).not.toContain("識別子の規約に合いません");
    // 色の書式を教えていること。
    expect(error.message).toBe('--color-text の値 "blue" は色の書式に合いません。');
    expect(error.hint).toContain("16進");
  });

  test("25スロットのどれも RESOURCE_ID_PATTERN_HINT を返さない(1件も残っていない)", () => {
    for (const [slot, schema] of Object.entries(themeSlotSchemas)) {
      // **その族に合わない値**を作る: 書式を満たす値の末尾に空白と `!` を足す。
      const bad = `${String(baseValueFor(schema.pattern))} !`;
      const error = themeErrorFor(slot, bad);
      const whole = `${error.message}${error.hint ?? ""}`;
      expect(whole, `${slot}: 汎用の識別子 hint が残っている`).not.toContain("英小文字で始まり");
      expect(error.message, `${slot}: message`).not.toContain("識別子の規約に合いません");
      expect(error.hint, `${slot}: hint`).toBeDefined();
      expect(examplesIn(String(error.hint)).length, `${slot}: 例`).toBeGreaterThan(0);
    }
  });

  test("**従えば通る** —— hint の例をそのまま値にすると、25スロットすべてで検証を通る", () => {
    let checked = 0;
    for (const [slot, schema] of Object.entries(themeSlotSchemas)) {
      const error = themeErrorFor(slot, `${String(baseValueFor(schema.pattern))} !`);
      for (const example of examplesIn(String(error.hint))) {
        // **hint から取り出した文字列しか使っていない**(テスト外の知識を混ぜない)。
        const result = validateDiff(themeDiffWith({ [slot]: example }));
        expect(result.valid, `${slot} に hint の例 ${example} を入れたら通らない`).toBe(true);
        checked += 1;
      }
    }
    // 25スロット × 各族の例(色2 / 長さ3 / 行間2 / 影2 / 書体2)。
    expect(checked).toBe(9 * 2 + 13 * 3 + 2 + 2 + 2);
  });

  test("族ごとの文面(5族。逐語で固定する)", () => {
    expect(themeErrorFor("--focus-outline-color", "blue").hint).toBe(
      "色は16進表記だけです —— # に続けて3桁または6桁の16進数を書いてください(例: #333 / #1a4f9c)。" +
        "色名(blue / red)・rgb() / rgba() / hsl()・var() は書けません。" +
        "透明度付きの8桁(#rrggbbaa)もこのスロットでは書けません。",
    );
    expect(themeErrorFor("--space-4", "8").hint).toBe(
      "長さは 0 か、数値に px / rem / em を付けた形だけです(例: 0 / 8px / 1.5rem)。" +
        "単位なしの数値(8 だけ)は書けず、% / vw / vh / pt も書けません。" +
        "小数点以下は3桁までで、calc() や var() は書けません。",
    );
    expect(themeErrorFor("--line-height-base", "1.6rem").hint).toBe(
      "行間は単位なしの数値だけです(例: 1.6 / 2)。px / rem / em などの単位は付けられません" +
        " —— 1.6rem は書けません。整数部は2桁まで、小数点以下は3桁までで、" +
        "値は数値ではなく文字列として書きます。",
    );
    expect(themeErrorFor("--surface-shadow", "0 1px 3px rgba(0,0,0,.1)").hint).toBe(
      "影は none か、長さを2〜4個スペースで区切って並べ、最後に16進色を1つ足した形だけです" +
        "(例: none / 0 1px 3px #0000001a)。長さは 0 か 数値+px / rem / em です。" +
        "rgba() は書けないので、透明度は16進8桁(#rrggbbaa)で表します。" +
        "inset や、カンマで複数の影を並べる形は書けません。",
    );
    expect(themeErrorFor("--font-family-base", "var(--x)").hint).toBe(
      '書体はフォント名をカンマで区切って並べた形です(例: system-ui, sans-serif / "Helvetica Neue", sans-serif)。' +
        "空白を含む名前は引用符で囲めます。" +
        "記号 ( ) { } [ ] ; : / \\ < > & ? | ^ ~ # $ @ ! = % * + は1文字も使えないので、" +
        "var() や calc() は書けません。1〜200文字です。",
    );
  });

  test("message は族の名前を言う(どの書式の話かがスロット名を知らなくても分かる)", () => {
    expect(themeErrorFor("--color-danger", "red").message).toBe(
      '--color-danger の値 "red" は色の書式に合いません。',
    );
    expect(themeErrorFor("--login-max-width", "50%").message).toBe(
      '--login-max-width の値 "50%" は長さの書式に合いません。',
    );
    expect(themeErrorFor("--line-height-base", "1.6em").message).toBe(
      '--line-height-base の値 "1.6em" は行間の書式に合いません。',
    );
    expect(themeErrorFor("--surface-shadow", "inset 0 1px").message).toBe(
      '--surface-shadow の値 "inset 0 1px" は影の書式に合いません。',
    );
    expect(themeErrorFor("--font-family-base", "ヒラギノ角ゴ; color: red").message).toBe(
      '--font-family-base の値 "ヒラギノ角ゴ; color: red" は書体の書式に合いません。',
    );
  });

  test("マニフェスト側(/app/theme/slots/…)でも同じ分岐が掛かる(根が違っても漏れない)", () => {
    const errors = errorsOf(
      validateManifest({
        app: {
          id: "book-tracker",
          name: "蔵書管理",
          tables: [],
          views: [],
          theme: { slots: themeSlots({ "--color-text": "blue" }) },
        },
      }),
    );
    const error = errors.find((e) => e.path === "/app/theme/slots/--color-text");
    expect(error?.message).toBe('--color-text の値 "blue" は色の書式に合いません。');
    expect(error?.hint).toContain("16進");
  });

  test('case "type": とは重複しない —— 型違反のときは pattern エラーが1件も出ない', () => {
    // **Ajv は同じ位置で type が落ちたら pattern を評価しない。**したがって
    // 「型の文面」と「書式の文面」が同じ往復で並ぶことはない(重複の心配が無い)。
    const errors = errorsOf(validateDiff(themeDiffWith({ "--color-text": 16 })));
    const atSlot = errors.filter((e) => e.path === "/operations/0/theme/slots/--color-text");
    expect(atSlot).toHaveLength(1);
    expect(atSlot[0]?.message).toContain("型が不正です");
    expect(atSlot[0]?.message).toContain("string");
    // 書式の文面は**出ない**(出ていたら二重に教えていることになる)。
    expect(atSlot[0]?.message).not.toContain("書式に合いません");
  });

  test("minLength / maxLength とだけは同じ往復で並ぶ(書式を教えるのは pattern 側)", () => {
    // **重複が起きるのはこの1スロットだけである** —— `minLength` / `maxLength` を
    // 持つテーマのスロットは `--font-family-base` の1件しかない($defs/theme)。
    // どちらも「空である」「長すぎる」しか言わないので、**書式を教える役目は
    // pattern 側にあり、二重に同じことを言っているのではない。**
    for (const [value, expected] of [
      ["", "--font-family-base が空です。1文字以上の値を指定してください。"],
      ["a".repeat(201), "--font-family-base が長すぎます。200文字以内にしてください。"],
    ] as const) {
      const errors = errorsOf(validateDiff(themeDiffWith({ "--font-family-base": value })));
      const atSlot = errors.filter(
        (e) => e.path === "/operations/0/theme/slots/--font-family-base",
      );
      expect(atSlot).toHaveLength(2);
      // **長さの検査が先、書式の文面が後**(Ajv が返す順序をそのまま実測で固定する)。
      expect(atSlot[0]?.message).toBe(expected);
      expect(atSlot[0]?.hint).toBeUndefined();
      expect(atSlot[1]?.message).toContain("は書体の書式に合いません。");
      expect(atSlot[1]?.hint).toContain("フォント名");
    }
  });

  test("巻き添えで書き換えない —— テーマ以外の pattern は汎用文面のまま", () => {
    const errors = errorsOf(
      validateDiff(
        diffWith([{ op: "add_table", table: { id: "BAD ID", name: "だめ", fields: [] } }]),
      ),
    );
    const error = errors.find((e) => e.path === "/operations/0/table/id");
    expect(error?.message).toContain("識別子の規約に合いません");
    expect(error?.hint).toContain("英小文字で始まり");
  });
});
