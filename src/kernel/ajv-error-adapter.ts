import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ErrorObject } from "ajv";
import { SYSTEM_TABLE_IDS } from "../shared/system-tables.ts";
import type { ValidationError } from "./errors.ts";

/**
 * Ajv の生エラーを、LLM向けの統一形式 {@link ValidationError} に変換する層。
 *
 * ここが「Ajv という実装詳細」と「カーネルのエラー契約」の唯一の境界。
 * 参照整合性バリデータ(V0-P1-T02)など Ajv を使わないバリデータも
 * 同じ {@link ValidationError} を返すため、呼び出し側は出所を意識しなくてよい。
 */

/** JSON Pointer の最後のセグメントを、プロパティ名として取り出す。 */
function lastSegment(instancePath: string): string {
  const segments = instancePath.split("/");
  const last = segments[segments.length - 1];
  if (last === undefined || last === "") {
    return "";
  }
  // RFC 6901 のエスケープを戻す(~1 → "/", ~0 → "~")。
  return last.replaceAll("~1", "/").replaceAll("~0", "~");
}

/** 値をメッセージに埋め込める短い文字列にする。 */
function describeValue(value: unknown): string {
  if (typeof value === "string") {
    return `"${value}"`;
  }
  if (value === undefined) {
    return "(未指定)";
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** enum / const の許可値を必ず文字列配列にする。 */
function toAllowedValues(values: readonly unknown[]): string[] {
  return values.map((value) => (typeof value === "string" ? value : JSON.stringify(value)));
}

/**
 * 「この文脈で本当に指定できるプロパティ」の一覧を、スキーマと実インスタンスから導く(V1-M0-T04)。
 *
 * `docs/v0-t04-record.md` §2 の付記が残した判断は「**嘘の一覧を出すくらいなら省く**」(憲法6)で
 * あって「条件分岐があったら諦める」ではない。ここでは `allOf` + `if/then/else` を
 * **実際のインスタンスに対して解決**し、解決できた文脈でだけ一覧を返す。
 * 解決できない形(未対応のキーワード・未対応の `if` の形)に出会ったら undefined を返し、
 * 呼び出し側は `allowed_values` を付けない —— この「出さない」経路は残す。
 *
 * 一覧が実際の受理集合と一致することは `src/kernel/ajv-error-adapter.test.ts` の
 * 網羅的突き合わせ(3文脈 × スキーマから導いた全属性)で機械的に固定している。
 */

/** 正準スキーマの置き場(`validate.ts` と同じ)。 */
const SCHEMA_DIR = join(import.meta.dir, "..", "..", "schemas");

/**
 * `allOf` の1要素(`{ if, then, else }`)から、それを持つオブジェクトスキーマを引く索引。
 *
 * `false schema` のエラーは `parentSchema` が `false` そのものなので、そこから
 * 「その位置の全プロパティ」を知る術がない。一方、同時に必ず報告される `if` エラーは
 * **その分岐要素**と**親インスタンス**を持っている。分岐要素から親スキーマへ戻れれば
 * 文脈を解決できるため、正準スキーマ側をあらかじめ索引しておく。
 *
 * `validate.ts` を import すると循環参照になるため、ここでは正準の JSON を直接読む
 * (どちらも `schemas/` が唯一の出所であり、定義が二重化するわけではない)。
 * 同じ分岐要素を複数のスキーマが持っていた場合は曖昧なので `null` を入れて諦める。
 */
let branchOwnerIndex: Map<string, Record<string, unknown> | null> | undefined;

function branchOwners(): Map<string, Record<string, unknown> | null> {
  if (branchOwnerIndex !== undefined) {
    return branchOwnerIndex;
  }
  const index = new Map<string, Record<string, unknown> | null>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item);
      }
      return;
    }
    if (typeof node !== "object" || node === null) {
      return;
    }
    const schema = node as Record<string, unknown>;
    if (Array.isArray(schema.allOf) && typeof schema.properties === "object") {
      for (const branch of schema.allOf) {
        const key = JSON.stringify(branch);
        const known = index.get(key);
        if (known === undefined) {
          index.set(key, schema);
        } else if (known !== schema) {
          index.set(key, null);
        }
      }
    }
    for (const value of Object.values(schema)) {
      visit(value);
    }
  };
  for (const file of readdirSync(SCHEMA_DIR)) {
    if (file.endsWith(".json")) {
      visit(JSON.parse(readFileSync(join(SCHEMA_DIR, file), "utf-8")));
    }
  }
  branchOwnerIndex = index;
  return index;
}

/**
 * `if` を**限定した形だけ**解釈する: `{ type: "object", properties: { k: { const: V } }, required: [k] }`。
 *
 * 一般の JSON Schema 評価器を書くと「解決できたつもりで外す」余地が生まれる。
 * 本リポジトリの条件分岐はすべて「1つのキーの const による場合分け」なので、
 * その形だけを認め、それ以外は undefined(= 解決不能)として扱う。
 */
function branchDiscriminator(condition: unknown): { key: string; value: unknown } | undefined {
  if (typeof condition !== "object" || condition === null) {
    return undefined;
  }
  const schema = condition as Record<string, unknown>;
  for (const keyword of Object.keys(schema)) {
    if (keyword !== "type" && keyword !== "properties" && keyword !== "required") {
      return undefined;
    }
  }
  if (schema.type !== undefined && schema.type !== "object") {
    return undefined;
  }
  const properties = schema.properties;
  if (typeof properties !== "object" || properties === null) {
    return undefined;
  }
  const entries = Object.entries(properties as Record<string, unknown>);
  const first = entries[0];
  if (entries.length !== 1 || first === undefined) {
    return undefined;
  }
  const [key, subSchema] = first;
  const required = schema.required;
  if (!Array.isArray(required) || required.length !== 1 || required[0] !== key) {
    return undefined;
  }
  if (typeof subSchema !== "object" || subSchema === null) {
    return undefined;
  }
  const subKeys = Object.keys(subSchema as Record<string, unknown>);
  if (subKeys.length !== 1 || subKeys[0] !== "const") {
    return undefined;
  }
  return { key, value: (subSchema as Record<string, unknown>).const };
}

/** `then` / `else` が `properties: { x: false }` で禁じているプロパティ名。解釈できなければ undefined。 */
function forbiddenPropertiesIn(branchBody: unknown): string[] | undefined {
  if (branchBody === undefined) {
    return [];
  }
  if (typeof branchBody !== "object" || branchBody === null) {
    return undefined;
  }
  const body = branchBody as Record<string, unknown>;
  for (const keyword of Object.keys(body)) {
    // `required` は必須条件を足すだけで、書ける属性の集合を狭めない。
    // **【2026-08-20。`V10-M1-T01` / `ADR-0358` 限定6 で `$comment` を足した】**
    // **`$comment` は JSON Schema の注釈であり、検証に1バイトも効かない**(語彙の定義
    // そのものがそう定めている)—— **したがって「書ける属性の集合」を狭めも広げもしない。**
    // **これを弾いていると、分岐に注釈を1行書いただけで `allowed_values` が丸ごと
    // 出なくなる**(実測: `detail_view` 分岐に `$comment` を置いた時点で、3文脈すべての
    // 列挙が `undefined` に倒れた)。**fail-closed の向きは1ミリも緩めていない** ——
    // **値を制約しうるキーワードは今日どおり1つ残らず `undefined` に倒す。**
    if (keyword !== "required" && keyword !== "properties" && keyword !== "$comment") {
      return undefined;
    }
  }
  const properties = body.properties;
  if (properties === undefined) {
    return [];
  }
  if (typeof properties !== "object" || properties === null) {
    return undefined;
  }
  return Object.entries(properties as Record<string, unknown>)
    .filter(([, subSchema]) => subSchema === false)
    .map(([name]) => name);
}

/** そのオブジェクトスキーマの `patternProperties` のパターン(宣言順)。無ければ空。 */
function patternPropertyNames(baseSchema: unknown): string[] {
  if (typeof baseSchema !== "object" || baseSchema === null) {
    return [];
  }
  const patterns = (baseSchema as Record<string, unknown>).patternProperties;
  if (typeof patterns !== "object" || patterns === null) {
    return [];
  }
  return Object.keys(patterns as Record<string, unknown>);
}

/** オブジェクトスキーマと実インスタンスから、その文脈で受理される属性名を宣言順で返す。 */
function resolveAllowedProperties(baseSchema: unknown, instance: unknown): string[] | undefined {
  if (typeof baseSchema !== "object" || baseSchema === null) {
    return undefined;
  }
  const schema = baseSchema as Record<string, unknown>;
  // `additionalProperties: false` でなければ「これだけが書ける」と言い切れない。
  if (schema.additionalProperties !== false) {
    return undefined;
  }
  const unsupported = [
    "anyOf",
    "oneOf",
    "not",
    "if",
    "then",
    "else",
    "dependentSchemas",
    "dependentRequired",
    // 【V20-M9 / ADR-0474】`patternProperties` をここから外した(旧(逐語): `"patternProperties",`)。
    // `$defs/theme` が生の色の置き場として1本持つ。列挙は properties の名前だけを返し、
    // 名前の形で受けるものは呼び出し側(`additionalProperties` の文面)がパターンとして添える。
    "$ref",
    "unevaluatedProperties",
  ];
  for (const keyword of unsupported) {
    if (schema[keyword] !== undefined) {
      return undefined;
    }
  }
  const properties = schema.properties;
  if (typeof properties !== "object" || properties === null) {
    return undefined;
  }
  const allowed = new Set(
    Object.entries(properties as Record<string, unknown>)
      .filter(([, subSchema]) => subSchema !== false)
      .map(([name]) => name),
  );
  const branches = schema.allOf;
  if (branches !== undefined) {
    if (!Array.isArray(branches)) {
      return undefined;
    }
    if (typeof instance !== "object" || instance === null || Array.isArray(instance)) {
      return undefined;
    }
    const data = instance as Record<string, unknown>;
    for (const branch of branches) {
      if (typeof branch !== "object" || branch === null) {
        return undefined;
      }
      const element = branch as Record<string, unknown>;
      for (const keyword of Object.keys(element)) {
        if (keyword !== "if" && keyword !== "then" && keyword !== "else") {
          return undefined;
        }
      }
      const discriminator = branchDiscriminator(element.if);
      if (discriminator === undefined) {
        return undefined;
      }
      const matched =
        Object.hasOwn(data, discriminator.key) && data[discriminator.key] === discriminator.value;
      const forbidden = forbiddenPropertiesIn(matched ? element.then : element.else);
      if (forbidden === undefined) {
        return undefined;
      }
      for (const name of forbidden) {
        allowed.delete(name);
      }
    }
  }
  const names = Object.keys(properties as Record<string, unknown>).filter((name) =>
    allowed.has(name),
  );
  return names.length > 0 ? names : undefined;
}

/**
 * `false schema` の位置で、同時に報告された `if` エラーを手がかりに許可属性を解決する。
 * 手がかりが無い / 索引が曖昧なら undefined(= 列挙を出さない)。
 */
function allowedPropertiesFromBranch(ifError: ErrorObject | undefined): string[] | undefined {
  if (ifError === undefined) {
    return undefined;
  }
  const branch = (ifError as { parentSchema?: unknown }).parentSchema;
  if (typeof branch !== "object" || branch === null) {
    return undefined;
  }
  const owner = branchOwners().get(JSON.stringify(branch));
  if (owner === undefined || owner === null) {
    return undefined;
  }
  return resolveAllowedProperties(owner, (ifError as { data?: unknown }).data);
}

/** 位置を日本語で言い表す(メッセージ冒頭用)。 */
function describeLocation(instancePath: string): string {
  const name = lastSegment(instancePath);
  return name === "" ? "ルート" : name;
}

// biome-ignore lint/suspicious/noExplicitAny: Ajv の params はキーワードごとに形が異なる
type AjvParams = Record<string, any>;

/**
 * 差分パッチの `op` の位置(`/operations/<index>/op`)を指す JSON Pointer か。
 *
 * 判定は**位置の形**だけで行う。ここで op の値(語彙)を見に行くと、
 * 語彙外の op 名がプロダクションコードに定数として現れることになり、
 * 「v0 の語彙は狭く、それ以外は存在しない」(憲法2)という建て付けが崩れる。
 */
const DIFF_OP_PATH = /^\/operations\/(\d+)\/op$/;

/** `/operations/<index>/...` の `<index>` を返す。operations 配下でなければ undefined。 */
function operationIndexOf(path: string): string | undefined {
  return /^\/operations\/(\d+)(\/|$)/.exec(path)?.[1];
}

/**
 * `op` の enum 違反に付ける hint(計画書 V0-P4-T03。ADR-0012 の作業で改訂)。
 *
 * 汎用の enum hint は「許可値に置き換えろ」としか言わない。しかし語彙外 op を
 * 投げてくる相手が本当に知りたいのは「なぜその op が無いのか」と「やりたいことの
 * 次の一手」である。それを言わないと、別名の op を発明し直す往復が続く(憲法6)。
 *
 * ## 書き換えた理由 —— 旧文面が2世代分まとめて嘘になっていた
 *
 * **【2026-07-20 訂正】本コメントは当初「V1-M1-T03(ADR-0010)で書き換えた」と
 * 述べていたが、それは事実ではない。V1-M1-T03 はこのファイルを一度も触っていない**
 * (`git log --follow` の最終変更は `b191534` = V1-M0-T04)。**「なぜ直したか」は
 * そのまま正しいので残し、「誰がいつ直したか」だけを事実に合わせる。**
 *
 * 直前の文面は **v0 初版のまま**で、こう述べていた ――
 * 「v0の差分は additive(追加)のみです。**削除・型変更・リネームを表す op は
 * 語彙として存在せず**、別名で言い換えても通りません。」
 *
 * この一文は**2度、別々の理由で偽になった**。
 *
 * 1. **ADR-0010(V1-M1-T03)が破壊的 op を4種足した時点で偽になった。**
 *    ところが T03 はこのファイルを見落とし、旧文面はそのまま残った。
 * 2. **ADR-0012 が `remove_view` を語彙に入れて、さらに偽の度合いが増えた。**
 *
 * **放置すると、カーネルは「できること」を「できない」と教えることになる** ――
 * しかもそれを、AI が語彙外 op を書こうとしたちょうどその瞬間に返す。
 * だから ADR-0012 の作業が**2世代分の嘘を一度に直した**。「T03 が直したものを
 * 再び直した」のではない。
 *
 * **T03 の見落としを記録として残す理由**: これは ADR-0007 限界11 が名指しした
 * 類型の実例である ―― **「その語彙は存在しない」と述べる文面は、定義上その識別子
 * (`remove_view` 等)を含まない。**だから新しい識別子で grep しても1件も拾われない。
 * 消すと、後世が同じ見落としを繰り返す。
 *
 * ## 新しい文面が言うべきこと
 *
 * 1. **削除・リネーム・型変更は「できる」。ただし専用 op ではなく `change_*` の
 *    `changes` で表す。** `rename_field` / `change_type` / `set_required` のような
 *    名前を発明しても通らないのは、**能力が無いからではなく綴りが違うから**である。
 * 2. **消せるものと消せないものがある。** これを言わないと、通った op の経験から
 *    別の op を類推してしまう。
 * 3. **「本当に無いもの」の例示は残す。** 空にすると「消したいものは何でも消せる」と
 *    読まれ、`remove_app` / `patch_manifest` を発明する往復が始まる。
 *
 * ## 【V1-M2-T07 / ADR-0013 による改訂】ワークフロー3種を足して12種にした
 *
 * **`add_workflow` / `update_workflow` / `remove_workflow` を追加し、群を1つ増やした。**
 * ADR-0013 §10-4 が `VOCABULARY_SCOPE` の危険度の説明について「**3群のどれにも入らない**
 * —— 定義もデータも消さないが、**適用が終わったあとも動き続ける**」として4分法を採ったので、
 * ここでも4群目「自動化」を立てた。**同じ語彙を2箇所で別々に分類すると、AI が
 * 同じ op について2通りの説明を受け取ることになる**ので、分類は揃えてある。
 *
 * **ただし目的は同じではない。**`VOCABULARY_SCOPE` は「何ができるか」を先に教える説明文で
 * あり、こちらは**語彙外 op を書いた直後に返る hint** である。だから危険度の記述
 * (「適用後も動き続ける」)は持ち込まず、**群の名前と op 名の対応だけ**を足した ——
 * hint が長くなるほど「次の一手」が埋もれるからである(V0-P4-T03 の元の狙い)。
 *
 * ## 【V1-M6-T05 / ADR-0024 による改訂】関数3種を足して15種にした
 *
 * **`add_function` / `update_function` / `remove_function` を追加し、群を1つ増やした
 * (5群目「関数」)。**上のワークフロー追加と同型で、冒頭の種類数(12→15)・群の op 名・
 * 「語彙にありません」の名指し(`run_function` / `pause_function` / `enable_function`)を
 * 追随させた。**run_function(ワークフローアクション)と島の実行は第2段(T03〜)であり、
 * ここでは足していない** —— 差分 op としての関数3種だけを hint に載せる。
 *
 * ## 【重要】この文面は `DIFF_OPS` の手書きの複製である
 *
 * **ここは `src/kernel/types.ts` の `DIFF_OPS` を import せず、op 名と種類数を散文として
 * 手書きで持っている。**`validate.ts` を import すると循環参照になるためであり
 * (`:70-71` の同じ理由)、**この構造は意図的に維持する。安易に import を足さないこと。**
 *
 * **その代償として、`DIFF_OPS` を変えたら必ずここも人手で追随させる必要がある。**
 * 追随が要る箇所は具体的に3つ —— **(1) 冒頭の種類数(「12種です」)/ (2) 各群に並ぶ
 * op 名 / (3) 「語彙にありません」と名指ししている op(語彙内になったら消すこと)。**
 *
 * **この注意書きが無かったために、V1-M2-T07 の計画書はこの箇所を数え落とした。**
 * それ以前にも、V1-M1-T03(ADR-0010)が同じ理由でここを見落とし、旧文面が
 * 2世代分の嘘になっている(上の「書き換えた理由」)。**同じ見落としが3度起きている
 * 箇所なので、機械的な検査ではなくこの注記が唯一の防波堤であることを明記しておく。**
 * 種類数と `allowed_values`(`DIFF_OPS` から自動生成される)の食い違いは
 * `src/kernel/ajv-error-adapter.test.ts` の hint 検査が拾う。
 */
const DIFF_OP_ENUM_HINT =
  // **【`V5-M17b` / `ADR-0248`。17種目 `set_user_kinds` を足した】** **旧文の逐語は
  // 「差分の op は16種です。」および「見た目(set_theme。アプリのテーマを丸ごと
  // 差し替える)が使えます。」であり、種類数と5群目の末尾だけを追随させた。**
  // **上の注記が言う「追随が要る3箇所」のうち (1) と (2) に当たる。(3)(語彙に
  // ありませんの名指し)には `set_user_kinds` が1度も出ていないので触っていない。**
  // **【`V8-M16-T03`。18種目 `set_roles` を足した】** **旧文の逐語は「差分の op は
  // 17種です。」および「利用者の種類の宣言(set_user_kinds。このアプリが扱う非運営の
  // 利用者の種類を丸ごと差し替える)が使えます。」であり、種類数と6群目の末尾だけを
  // 追随させた(7群目として `set_roles` を足した)。****上の注記が言う「追随が要る
  // 3箇所」のうち (1) と (2) に当たる。(3)(語彙にありませんの名指し)には
  // `set_roles` が1度も出ていないので触っていない。**
  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11` / `T-G12`。判定値 = 廃止】** **旧文の
  // 逐語は「差分の op は18種です。」および「利用者の種類の宣言(set_user_kinds。この
  // アプリが扱う非運営の利用者の種類を丸ごと差し替える)、」である。** **17種に減った
  // ので、種類数と6群目を取り除いた。** **上の注記が言う「追随が要る3箇所」のうち
  // (1) と (2) に当たる。(3)(語彙にありませんの名指し)には `set_user_kinds` が1度も
  // 出ていないので触っていない。**
  // **【`V20-M15-T01A` / `ADR-0479`。18種目 `remember_design` を足した】** **旧文の逐語は
  // 「差分の op は17種です。」および「役割の宣言(set_roles。このアプリが宣言する役割の一覧を
  // 丸ごと差し替える)が使えます。」であり、種類数と7群目の末尾だけを追随させた(8群目として
  // `remember_design` を足した)。** **上の注記が言う「追随が要る3箇所」のうち (1) と (2) に当たる。
  // (3)(語彙にありませんの名指し)には `remember_design` が1度も出ていないので触っていない。**
  // **【`V22-M2-T02` / `ADR-0486`。19種目 `set_workspace` を足した】** **旧文の逐語は
  // 「差分の op は18種です。」および「選んだ形の記録と型(remember_design。選んだ案の記録を1件足す / アプリの型を
  // 丸ごと差し替える)が使えます。」であり、種類数と8群目の末尾だけを追随させた(9群目として `set_workspace` を足した)。**
  // **上の注記が言う「追随が要る3箇所」のうち (1) と (2) に当たる。(3)(語彙にありませんの名指し)には
  // `set_workspace` が1度も出ていないので触っていない。**
  "差分の op は19種です。追加(add_table / add_field / add_view / update_view)に加えて、" +
  "削除(remove_field / remove_table / remove_view)と変更(change_table / change_field)、" +
  "自動化(add_workflow / update_workflow / remove_workflow)、" +
  "関数(add_function / update_function / remove_function)、" +
  "見た目(set_theme。アプリのテーマを丸ごと差し替える)、" +
  "役割の宣言(set_roles。このアプリが宣言する役割の一覧を丸ごと差し替える)、" +
  "選んだ形の記録と型(remember_design。選んだ案の記録を1件足す / アプリの型を丸ごと差し替える)、" +
  // **【`V22-M3-T02` / `ADR-0488` §Decision 2。9群目の末尾だけを直した】** **旧文の逐語は
  // 「メニューの置き方(set_workspace。メニューを左に置くか上に置くかを丸ごと差し替える)が使えます。」であり、
  // `set_workspace` の意味が直下のキーごとの置き換えに改まり、`my_page` を書けるようになったので末尾だけを追随させた。**
  // 種類数(19)と他の群は1文字も変えていない。
  "作業画面の枠(set_workspace。メニューの置き方 navigation とマイページ my_page を、書いたキーだけ置き換える。null でそのキーを消す)が使えます。" +
  "リネーム・型変更・選択肢の変更・必須の変更に専用の op はありません —— " +
  "change_table / change_field の changes に id / name / type / options / required / reference_table を書きます" +
  "(例: フィールドのリネームは change_field の changes.id)。" +
  // **【`V5-M25-T01` / `L-G8` / `ADR-0174` 無効化条文9 で書き換えた】** **着手前ここには
  // 逐語「ワークフローの手動実行・一時停止(run_workflow / pause_workflow /
  // enable_workflow)、」が在った。** **`run_workflow` の分だけが今日は不正確である** ——
  // **手動実行そのものは `ADR-0174` が通した**(`trigger.type: "manual"` と
  // `$defs/view_action` の4形目 `run`)。**差分の op としては今日も1つも無い**(限定6)。
  // **`run_function` / `remove_app` の行は1バイトも触っていない**(無効化の射程は
  // `run_workflow` の行だけである = `ADR-0174` §7 の9)。
  "ワークフローの一時停止(pause_workflow / enable_workflow)、" +
  "関数の手動実行(run_function / pause_function / enable_function)、" +
  "アプリ全体の削除(remove_app)とマニフェスト全体の差し替え(patch_manifest)は語彙にありません。" +
  "ワークフローを手動で起こす op(run_workflow)もありません —— " +
  "発火条件(trigger.type)に manual と書いたワークフローを、" +
  "画面の操作起点(view の actions の run)から起こします。" +
  "既に適用した変更を取り消したい場合は undo を使ってください。";

/**
 * **選んだ形の記録と型(`design_memory`)の下の位置か**(`V20-M15-T01A`。`ADR-0479` §Decision 2 の 10)。
 *
 * **マニフェスト側 `/app/design_memory/...` と差分側 `/operations/<n>/design_memory/...` の2つだけ。**
 * 先頭で位置を固定する —— ワークフローの `values` のように**キーが利用者の識別子**である場所に
 * `design_memory` という名前の項目が在っても当たらない。
 */
const DESIGN_MEMORY_PATH = /^(\/app|\/operations\/\d+)\/design_memory(\/|$)/;

/**
 * **`design_memory` の下の位置の名前**(メッセージ冒頭用)。 配列の要素(`patterns/0`)は
 * 「patterns の1番目」と言う(添字の `0` をそのまま出さない)。
 */
function describeDesignMemoryLocation(instancePath: string): string {
  const segments = instancePath.split("/");
  const last = segments[segments.length - 1] ?? "";
  const parent = segments[segments.length - 2] ?? "";
  if (/^\d+$/.test(last)) {
    return `${parent} の${Number(last) + 1}番目`;
  }
  return describeLocation(instancePath);
}

/**
 * **`design_memory` の下のときだけ、`pattern` / `maxItems` / `uniqueItems` の文言を差し替える**
 * (`V20-M15-T01A`。`ADR-0479` §Decision 2 の 10 / 計画 §10-5 の中9)。
 *
 * - `pattern` —— この位置の `pattern` は**改行の禁止**だけである(`^[^\r\n\u2028\u2029]+$`)。
 *   既定の「識別子の規約に合いません」は嘘の理由になる(罠 R5)。 **空文字は `minLength` と
 *   `pattern` の2件が同時に出るので、空文字のときは `pattern` 側を落として1件にする。**
 * - `maxItems` / `uniqueItems` —— 既定は英語混じりの `default` に落ちる。 日本語の文言にする。
 *
 * **当たらなければ `undefined` を返し、今日どおりの `switch` に落ちる。** **既存の `maxItems`
 * (設計図に14か所)と `uniqueItems`(12か所)の出力は1バイトも変えない**(`design_memory` の外の
 * 位置では呼ばれても `undefined` を返す)。 陰性対照は `src/kernel/design-memory.test.ts` に在る。
 */
function designMemoryError(error: ErrorObject, data: unknown): ValidationError | null | undefined {
  const path = error.instancePath;
  if (!DESIGN_MEMORY_PATH.test(path)) {
    return undefined;
  }
  const params = (error.params ?? {}) as Record<string, unknown>;
  const where = describeDesignMemoryLocation(path);
  switch (error.keyword) {
    case "pattern":
      if (data === "") {
        return null;
      }
      // 要素の位置(「patterns の1番目」)は日本語で終わるので、助詞の前に空白を置かない。
      return {
        path,
        message: `${where}${/番目$/.test(where) ? "" : " "}に改行は書けません。1行で書いてください。`,
      };
    case "maxItems":
      return { path, message: `${where} は${String(params.limit)}件までです。` };
    case "uniqueItems": {
      const first = Math.min(Number(params.i), Number(params.j)) + 1;
      const second = Math.max(Number(params.i), Number(params.j)) + 1;
      return { path, message: `${where} に同じ型が2つあります(${first}番目と${second}番目)。` };
    }
    default:
      return undefined;
  }
}

/**
 * **行の招待の宣言の名前の配列(`by` / `grantable` / `target_roles`)の要素の位置**(`V23-M5-T02`)。
 * マニフェスト側(`/app/tables/N/access_control/…`)と差分の側(`add_table` の `table`・`change_table` の
 * `changes`)のどちらでも当たるよう、`access_control/invitations/` から後ろだけを見る。
 */
const INVITATIONS_NAME_PATH = /\/access_control\/invitations\/(by|grantable|target_roles)(\/\d+)?$/;

/**
 * **行を相手にした付与の権限名の配列(`grant.principal_row.via`)の位置**(`V23-M6-T02`)。
 * 招待の名前の配列と同じ罠(識別子の汎用 hint・英語の既定文)を同じ文言で手当てする。
 */
const PRINCIPAL_ROW_VIA_PATH = /\/access_control\/grant\/principal_row\/(via)(\/\d+)?$/;

/**
 * **子の表に行を作れる権限の子の表 ID の配列(`permissions[].create_child`)の位置**(`V23-M7-T02`)。
 * 要素は表 ID なので `pattern` は今日の汎用の文言のまま(表 ID の規約そのもの)。 `uniqueItems` だけ、
 * 英語の既定文に落ちないよう日本語にする。
 */
const CREATE_CHILD_PATH = /\/access_control\/permissions\/\d+\/create_child$/;

/** **行の招待の期限の日数(`expires_days`)の位置**(`V23-M5-T02`)。 */
const INVITATIONS_EXPIRES_PATH = /\/access_control\/invitations\/expires_days$/;

/**
 * **行の招待の宣言の下のときだけ、`pattern` / `uniqueItems` / `minimum` / `maximum` / `type` の文言を差し替える**
 * (`V23-M5-T02`。`ADR-0532` §Decision 1-1)。
 *
 * - 名前の配列(`by` / `grantable` / `target_roles`)の要素の `pattern` —— 既定の「識別子の規約に合いません」と
 *   その hint(ハイフンを使える・64文字)は、この位置では**罠**である(権限名・役割名はハイフンを使えず32文字まで。
 *   hint に従って直すと、もう一度断られる)。 権限名・役割名の書き方を言う。
 * - 名前の配列の `uniqueItems` —— 既定は英語混じりの `default` に落ちる。 日本語にする。
 * - `expires_days` の `minimum` / `maximum` / `type` —— 「1〜30の整数」と日本語で言う(既定の `default` は英語、
 *   `type` の既定は「integer を指定してください」で範囲を言わない)。
 *
 * **当たらなければ `undefined` を返し、今日どおりの `switch` に落ちる。** **この位置の外の出力は1バイトも変えない。**
 */
function invitationsError(error: ErrorObject, data: unknown): ValidationError | undefined {
  const path = error.instancePath;
  const params = (error.params ?? {}) as Record<string, unknown>;
  const name = INVITATIONS_NAME_PATH.exec(path) ?? PRINCIPAL_ROW_VIA_PATH.exec(path);
  if (name !== null) {
    const isRole = name[1] === "target_roles";
    const kind = isRole ? "役割名(roles の id)" : "権限名(permissions の id)";
    if (error.keyword === "pattern" && name[2] !== undefined) {
      return {
        path,
        message: `${name[1]} の値 ${describeValue(data)} は${kind}の形に合いません。`,
        hint: `${kind}は、英小文字・数字・アンダースコアだけの1〜32文字です(ハイフン・大文字・空白は使えません)。宣言した${
          isRole ? "役割" : "権限"
        }の id をそのまま書いてください。`,
      };
    }
    if (error.keyword === "uniqueItems" && name[2] === undefined) {
      const first = Math.min(Number(params.i), Number(params.j)) + 1;
      const second = Math.max(Number(params.i), Number(params.j)) + 1;
      return {
        path,
        message: `${name[1]} に同じ名前が2回あります(${first}番目と${second}番目)。`,
        hint: "同じ名前は1回だけ書いてください。",
      };
    }
    return undefined;
  }
  if (CREATE_CHILD_PATH.test(path) && error.keyword === "uniqueItems") {
    const first = Math.min(Number(params.i), Number(params.j)) + 1;
    const second = Math.max(Number(params.i), Number(params.j)) + 1;
    return {
      path,
      message: `create_child に同じ表が2回あります(${first}番目と${second}番目)。`,
      hint: "同じ子の表は1回だけ書いてください。",
    };
  }
  if (
    INVITATIONS_EXPIRES_PATH.test(path) &&
    (error.keyword === "minimum" || error.keyword === "maximum" || error.keyword === "type")
  ) {
    return {
      path,
      message: `expires_days の値 ${describeValue(data)} は書けません。招待の期限の日数は1〜30の整数で書いてください。`,
      hint: "省略すると7日になります。引用符で囲んだ文字列や小数は書けません。",
    };
  }
  return undefined;
}

/**
 * `view.table` を指す JSON Pointer か(マニフェスト側と差分の `add_view` 側)。
 *
 * 判定は**位置の形**だけで行う(`DIFF_OP_PATH` と同じ方針)。
 */
const VIEW_TABLE_PATH = /^(\/app\/views\/\d+|\/operations\/\d+\/view)\/table$/;

/**
 * `$defs/action_value`(ワークフローのアクションが書く値)の位置か(V1-M2-T05a D3)。
 *
 * ## なぜ手当てが要るのか
 *
 * 汎用の `type` 文面は「**string を指定してください**」と言う。**この位置では有害である。**
 * V1-M2-T05 の実地検証(証跡 `docs/evidence/cp-v1-2/transcripts/001..003`)で、
 * boolean 列に書き込むワークフローを作ろうとした AI は
 * `values: { confirmed: true }` と書き、この文面を受け取り、**言われたとおり
 * `"true"` に直した。差分は通った。そして永久に動かないワークフローができた** ——
 * 実行のたびにレコード書き込みが `真偽値(boolean) を指定してください` で弾かれる。
 * **作った時点では成功して見えるので、誰も気づかない。**
 *
 * T05 単位A は `apply_diff` の説明文に「文字列で書くと差分は通りますが実行のたびに
 * 弾かれます」と警告を書いた。**効かなかった(3試行すべてで踏んだ)。**
 * **説明文とエラー文面が食い違ったら、AI はエラー文面に従う。**
 * `VIEW_TABLE_PATTERN_HINT` が「汎用 hint に従うと正解に決して辿り着けない」形を
 * 手当てしたのと**同じ類型**であり、その前例に倣って分岐を1つ足した。
 *
 * ## なぜ `instancePath` ではなく `schemaPath` で判定するのか
 *
 * `DIFF_OP_PATH` / `VIEW_TABLE_PATH` は `instancePath`(位置の形)で判定している。
 * **ここではそれを採らなかった。**`action_value` が現れる位置は
 * `values` の**任意のキー**と `target` の2種あり、さらに根がマニフェスト側
 * (`/app/workflows/…`)と差分側(`/operations/<i>/workflow/…`)で違う。
 * 正規表現で数え上げると、**位置が1つ増えるたびに黙って漏れる。**
 *
 * `schemaPath` は Ajv が `$ref` を解決した先を指すので、
 * **`$defs/action_value` に由来するエラーだけ**が過不足なく引っかかる
 * (マニフェスト経路・差分経路のどちらでも `#/$defs/action_value/type` になることを
 * 実測で確認した)。**「スキーマのこの定義に由来するか」がまさに問いたいことなので、
 * schemaPath で判定するのが位置の列挙より正確である。**
 * `schemaPath` を使うのは本ファイルでここが最初である。
 */
const ACTION_VALUE_SCHEMA_PATH = /(^|\/)\$defs\/action_value\//;

/**
 * **`values` の器(`$defs/workflow_action.properties.values.additionalProperties`)に由来するエラーか**
 * (`V23-M4-T02` / `SC-G13` / `ADR-0524` §Decision 1-7)。
 *
 * `values` の器は `type: string` と、`$actor` / `$previous` / `$now` で始まる値の `if/then` を持ち、
 * `else` で今日の `$defs/action_value` を指す。 器の `type` と `then` の `pattern` で落ちたエラーは
 * `schemaPath` が `$defs/action_value` を含まないので、{@link ACTION_VALUE_SCHEMA_PATH} だけを見ると
 * **罠の汎用文**(「string を指定してください」「英小文字で始まり…」)に落ちる。 判定は
 * {@link ACTION_VALUE_SCHEMA_PATH} と同じく `schemaPath` で行う(位置を数え上げない)。
 */
const VALUES_CONTAINER_SCHEMA_PATH = /\/values\/additionalProperties\//;

/**
 * **`values` の値の位置か**(`V23-M4-T02`)。 `values` の値だけが、`$record` の2形に加えて
 * 操作した人・更新前の値・今の時刻の5形を書ける(`ADR-0500` 限定3・4)。 **その位置で
 * 「`$record.<フィールドID>` だけ」と言うと嘘になる**ので、文面をここで書き分ける。
 *
 * - 器に由来するエラー({@link VALUES_CONTAINER_SCHEMA_PATH})は、必ず `values` の位置である。
 * - `$defs/action_value` に由来するエラーは `values` と `target` / `payload` / `input` / `fallback` で
 *   共有されるので、`instancePath` の末尾が `values/<キー>` のときだけ `values` の位置とみなす
 *   (`$defs/action_value` を `values` のキーで指す定義は `workflow_action` の1つだけである)。
 */
function isWorkflowValuesPosition(error: ErrorObject): boolean {
  const schemaPath = error.schemaPath ?? "";
  if (VALUES_CONTAINER_SCHEMA_PATH.test(schemaPath)) {
    return true;
  }
  return ACTION_VALUE_SCHEMA_PATH.test(schemaPath) && /\/values\/[^/]+$/.test(error.instancePath);
}

/** `values` の位置で書ける参照の全量(`V23-M4-T02`。文面に字面で並べる)。 */
const WORKFLOW_VALUES_REFERENCE_FORMS =
  '"$record.<フィールドID>"(発火したレコードの値)・"$record._id"(レコード自身のID)・' +
  '"$previous.<フィールドID>"(更新前の値。trigger が on_update のときだけ)・' +
  '"$actor.id" / "$actor.login" / "$actor.role"(操作した人)・"$now"(今の時刻)';

/**
 * `$defs/action_value` の **pattern 違反**に付ける hint(V1-M2-T05e / T05d §5-3)。
 *
 * ## なぜ専用の hint が要るのか(**無ければ制約が有害になる**)
 *
 * `case "pattern":` は既定で {@link RESOURCE_ID_PATTERN_HINT} を返す。
 * **この位置ではそれが罠である。**T05d §5-4 が実カーネルで実測した ——
 * `$foo` と書いた AI は「英小文字で始まり…」と言われ、**従うと `foo` になる。
 * `foo` はリテラルとして通り、黙って書き込まれる。`$record.` が1文字も現れない。**
 *
 * T05e が `else` の pattern(波括弧の禁止)を足したことで、
 * **口ひげ記法にも同じ hint が付くようになった** —— `{{record.name}}` と書いた AI が
 * 「英小文字で始まり…」と言われる。T05a が `case "type":` で潰し、
 * T05c が説明文で潰した類型の**3世代目**である。
 *
 * ## 文面の要件(T05d §5-3。**4点すべてを含むこと**)
 *
 * 1. **置換されないことを「起きる結果」で書く**(message 側)
 * 2. **`$record.<フィールドID>` を字面で書く** —— 実地で機能した唯一の情報(2/2)
 * 3. **`$record._id` も書く** —— 002 / 005 が欲しかったのは `_id` であり、
 *    `<フィールドID>` だけでは該当すると読めない(`_id` は `[a-z]` 始まりではない)
 * 4. **連結できないことを、その場で言う** —— D2-b は保留であり、正しい形が存在しない。
 *    隠すと AI は連結を試み続け、「誰の申し込みか載せる手段は無い」の誤った断定へ戻る
 *
 * ## 書いてはならないこと
 *
 * **「波括弧を外してください」と書いてはならない。** 従うと `{{record.name}}` →
 * `record.name` になり、**それはリテラルとして通り、また黙って書き込まれる。**
 * だから「外しても直りません」を明示的に書いている。
 */
const ACTION_VALUE_PATTERN_HINT =
  '発火したレコードの値を書きたいときは、値の全体を "$record.<フィールドID>" にしてください' +
  '(レコード自身のIDは "$record._id")。' +
  '波括弧を外して "record.name" と書いても直りません —— ' +
  "それは固定の文字列として、そのまま書き込まれます。" +
  "なお、固定の文字列とレコードの値をつなげて1つの値にすることはできません。" +
  '値の全体が "$record.<フィールドID>" であるか、全体が固定の文字列であるかの、どちらかです。';

/**
 * **`values` の位置の pattern 違反**に付ける hint(`V23-M4-T02`)。 {@link ACTION_VALUE_PATTERN_HINT} の
 * 4点(置換されない結果・字面・`_id`・連結できないこと)をそのまま満たし、書ける参照を5形まで並べる。
 */
const WORKFLOW_VALUES_PATTERN_HINT =
  `値の全体を参照1つにしてください。書ける参照は ${WORKFLOW_VALUES_REFERENCE_FORMS} だけです。` +
  'これ以外の "$" で始まる形(例: "$actor.email"・"$previous._id"・"$today")は書けません。' +
  '波括弧を外して "record.name" と書いても直りません —— ' +
  "それは固定の文字列として、そのまま書き込まれます。" +
  "なお、固定の文字列と参照をつなげて1つの値にすることはできません。" +
  "値の全体が参照1つであるか、全体が固定の文字列であるかの、どちらかです。";

/** 通常のリソースID(`$defs/resource_id`)の pattern 違反に付ける hint。 */
const RESOURCE_ID_PATTERN_HINT =
  "英小文字で始まり、英小文字・数字・ハイフン・アンダースコアのみを使う1〜64文字にしてください(例: book-tracker, finished_at)。";

/**
 * **並べ方の木の節(`$defs/layout_node`)のスキーマか**(`V20-M5-T07` 軽5)。
 * `discriminator`(`propertyName: "type"`)を持つ定義は `layout_node` の1本だけである
 * (`validate.ts` の ajv の設定の注釈)。`verbose: true` なので `parentSchema` が来る。
 */
function isLayoutNodeSchema(parentSchema: unknown): boolean {
  if (typeof parentSchema !== "object" || parentSchema === null) {
    return false;
  }
  const discriminator = (parentSchema as { discriminator?: { propertyName?: unknown } })
    .discriminator;
  return discriminator?.propertyName === "type";
}

/**
 * `view.table`(`$defs/view_table_id`)の pattern 違反に付ける hint(ADR-0006 §11)。
 *
 * 汎用の hint は「英小文字で始まり」と言うが、**`view.table` に限ればそれはもう真ではない**。
 * `_apps` は英小文字で始まらないのに valid である。汎用 hint に従って修正した AI は、
 * 正しい答え(`_apps`)に**決して辿り着けない**。誤誘導を避けるための分岐であり、
 * `anyOf` + `enum` を却下した理由(憲法6)がそのまま自分に跳ね返った結果である。
 */
const VIEW_TABLE_PATTERN_HINT =
  `${RESOURCE_ID_PATTERN_HINT}加えて、画面の対象テーブルには読み取り専用のシステムテーブル ` +
  `${SYSTEM_TABLE_IDS.join(" / ")} も指定できます(これらは英小文字始まりの規約の例外です)。`;

/**
 * テーマのスロット値(`$defs/theme` の各スロット)の **pattern 違反**か(V3-M1-T08)。
 *
 * ## なぜ手当てが要るのか(**専用文面の3件目である**)
 *
 * `case "pattern":` は既定で {@link RESOURCE_ID_PATTERN_HINT} を返す。
 * **テーマのスロットではそれが嘘である。**V3-M1-T07 が実カーネルで実測した ——
 * `--color-text` に `"blue"` と書いた側は「英小文字で始まり、英小文字・数字・
 * ハイフン・アンダースコアのみを使う1〜64文字にしてください(例: book-tracker,
 * finished_at)」と言われる。**従うと `blue-x` のような識別子になり、色として
 * 読めないので何度でも拒否される**(3回続けて拒否されることを T07 が実測した。
 * 記録 `docs/plan/v3/records/v3-m1-t07.md` §3-5 (A))。
 *
 * **同じ罠を踏んだのはこれが3件目である。** 1件目は `view.table`
 * ({@link VIEW_TABLE_PATTERN_HINT} —— 汎用 hint に従うと `_apps` に決して辿り着けない)、
 * 2件目は `$defs/action_value`({@link ACTION_VALUE_PATTERN_HINT} —— 従うと `foo` に
 * なって黙って書き込まれる)。**3件目が起きた理由は前2件と違う** ——
 * **V3-M1-T03 が「リソースID ではない `pattern`」を初めて大量(25スロット / 5族)に
 * 持ち込んだ**からである。それまで `pattern` はほぼリソースID 系だったので、
 * 既定の hint で足りていた。**次に非リソースID の `pattern` を足す人は、
 * ここに族を1つ増やすかどうかを必ず判断すること。**
 *
 * ## なぜ `instancePath` ではなく `schemaPath` で判定するのか
 *
 * `ACTION_VALUE_SCHEMA_PATH` と同じ理由である。テーマの値が現れる位置は
 * マニフェスト側(`/app/theme/slots/…`)と差分側(`/operations/<i>/theme/slots/…`)の
 * 2種あり、正規表現で数え上げると位置が1つ増えるたびに黙って漏れる。
 * `schemaPath` は Ajv が `$ref` を解決した先を指すので、**`$defs/theme` の
 * スロット由来のエラーだけ**が過不足なく引っかかる(差分側は
 * `$defs/app/properties/theme` 経由で `$ref` されるが、解決後はどちらも
 * `#/$defs/theme/properties/<スロット名>/pattern` になることを実測で確認した)。
 *
 * **【V20-M9 / ADR-0474 §Decision 1-1】色の値域は入れ子の `anyOf`(外側2枝 = [実値(内側に16進 / oklch), 参照])になり、
 * 生の色の値は `patternProperties` の下に在る。** 旧(逐語):
 * `/(^|\/)\$defs\/theme\/properties\/[^/]+(\/anyOf\/[0-9]+)?\/pattern$/`。 `anyOf` の段を何段でも、
 * `properties` と `patternProperties` の両方を受ける形にした(スロット名も生の色の名前も列挙しない)。
 */
const THEME_SLOT_SCHEMA_PATH =
  /(^|\/)\$defs\/theme\/(properties|patternProperties)\/[^/]+(\/anyOf\/[0-9]+)*\/pattern$/;

/**
 * **テーマのスロットの位置の `anyOf` そのもの**(`V20-M7`。色スロット9件の値域は `anyOf` の2枝 =
 * 16進 / oklch)。
 *
 * 値がどちらの枝にも当たらないと、Ajv は枝ごとの `pattern` エラー2件と、`anyOf` のエラー1件を返す。
 * **枝の2件は同じ族(色)に当たって同じ path・同じ message になるので、{@link dedupeKey} で1件に
 * まとまる。** `anyOf` の1件は汎用文面(「不正です(anyOf: …)」)で、書式を1文字も教えないので、
 * **この位置でだけ落とす**(M5 の先例「素の oneOf だと拒否文面が混ざる」を踏まない)。
 * **テーマのスロット以外の位置の `anyOf` は1バイトも変えない**(今日どおり汎用文面で返す)。
 *
 * **【V20-M9 / ADR-0474】入れ子の `anyOf`(外側と内側)と `patternProperties`(生の色の値)の位置も落とす。**
 * 旧(逐語): `/(^|\/)\$defs\/theme\/properties\/[^/]+\/anyOf$/`。
 */
const THEME_SLOT_ANYOF_SCHEMA_PATH =
  /(^|\/)\$defs\/theme\/(properties|patternProperties)\/[^/]+(\/anyOf\/[0-9]+)*\/anyOf$/;

/**
 * テーマのスロット値の**族**(値域の正は `schemas/manifest.schema.json` の
 * `$defs/theme` / ADR-0046 限定1 / ADR-0047 限定6)。
 *
 * ## 族は `pattern` の文字列から引く(**スロット名を列挙しない**)
 *
 * スロット名で族を決めると、**25個のスロット名の4番めの写しがここに生まれる。** 【V20-M9 で偽になった】今日の役割の枠は27個(ADR-0474)。「写しを作らない」という趣旨は変わらない。
 * 正は3箇所(`web/test/__fixtures__/styles-token-slots.txt` / `$defs/theme` /
 * `src/kernel/theme-contrast.ts` の役割表)で一致を機械的に固定してある
 * (ADR-0046 限定1)。**4つめを増やすと、その照合の外側に写しが1つできる。**
 * `pattern` は Ajv が `params.pattern` として渡してくるので、**スキーマそのものを
 * 出所にできる** —— スロットが1つ増えても、族が同じなら何も足さずに正しい hint が付く。
 *
 * ## 各 `match` は互いに素である(先頭を見るだけで族が決まる)
 *
 * 5つの `pattern` は先頭2〜7文字で区別できる(`^#(` / `^(0|` / `^(none|` /
 * `^[0-9]{1,2}` / `^[^(`)。**順序に依存させない**ため、どれも先頭に錨を打っている。
 * **【V20-M7 追記】色の値域は `anyOf` の2枝になり、色の族の `match` は `^#(` と `^oklch\(` の
 * 2つの pattern に当たる選言である**(pattern は6つ、族は5つのまま)。`^oklch\(` は他の4族の
 * 先頭と重ならない。
 * **どの族にも当たらなければ hint を差し替えず、汎用文面のまま返す**(憲法6 ——
 * 族が分からないのに族名を騙るほうが有害である)。
 * `$defs/theme` の25スロットが全部どれかの族に当たることは 【V20-M9 で偽になった】今日は役割の枠27個と、生の色(patternProperties)の値が族に当たる(ADR-0474)。
 * `src/kernel/ajv-error-adapter.test.ts` が**スキーマを読んで**機械的に固定している。
 *
 * ## 文面の要件(**3点すべてを含むこと**)
 *
 * 1. **通る値の例を1つ以上、字面で書く**(`(例: …)` の形)。T07 の実測が
 *    「コントラストの拒否は通る候補値を1文字も持たないので往復が刻み幅次第で増える」
 *    ことを示したので、**書式のほうは候補値を必ず持たせる。**
 *    「従えば通る」ことは上のテストが hint から例を取り出して再検証している。
 * 2. **書けない形を名指しする**(`var()` / `calc()` / `rgba()` / 単位なしの数値など)。
 *    ADR-0013 限定12 を破る形を1つも許していないので、書かないと何度も試される。
 * 3. **「単位を外せ」「引用符を外せ」のような、従うと別の違反になる指示を書かない**
 *    ({@link ACTION_VALUE_PATTERN_HINT} の「書いてはならないこと」と同じ歯止め)。
 *
 * **コントラストのことは書かない。** 色の書式が通っても
 * コントラスト検査(`checkThemeContrast`)で落ちることはあるが、**それは別の拒否であり、
 * その拒否は自分の文面を持っている。**ここに混ぜると「従えば通る」が偽になる
 * (書式の hint に従っても、コントラストで落ちる)。
 */
const THEME_VALUE_FAMILIES: readonly {
  readonly match: RegExp;
  readonly label: string;
  readonly hint: string;
}[] = [
  {
    // 【V20-M7】色の値域は anyOf の2枝(16進 / oklch)なので、どちらの pattern にも当たる選言にした。
    // 【V20-M9 / ADR-0474】参照の枝(`^\$palette_…`)も色の族に入れる(3つの枝の誤りが同じ文面に揃い、1件にまとまる)。
    // 旧(逐語): `match: /^\^#\(\[0-9a-fA-F\]|^\^oklch\\\(/,`
    match: /^\^#\(\[0-9a-fA-F\]|^\^oklch\\\(|^\^\\\$palette_/,
    label: "色",
    hint:
      "色は16進表記か、明るさ基準の oklch 表記です —— # に続けて3桁または6桁の16進数を書くか、" +
      "oklch(L C H) の形で L(0〜1 の小数か 0%〜100%)・C(0 以上の小数)・H(0〜360 の度。単位は書かない)を" +
      "半角空白1つで区切って書いてください(例: #333 / #1a4f9c / oklch(0.55 0.15 250))。" +
      "小数は6桁まで、oklch は小文字だけです。" +
      // 【V20-M7B / ADR-0472 §Decision 2-4】旧(逐語): "sRGB で表せない色(彩度の高い色の一部)は書けません —— 断られたら C を小さくしてください。"
      // 色域の外の色も受けるようになったので外した。代わりに none を書ける位置と書けない位置を書き分ける。
      "H の位置にだけ none を書けます(0 と書いたのと同じ色になります)。L と C の位置には none を書けません。" +
      "色名(blue / red)・rgb() / rgba() / hsl() / lch() / oklab()・var() は書けません。" +
      // 【V20-M7B】旧(逐語)は「…oklch の / で区切る透明度・none・カンマ区切り…」。none を「L と C の位置の none」に直した(上の文と矛盾させない)。
      "透明度付きの8桁(#rrggbbaa)も、oklch の / で区切る透明度・L と C の位置の none・カンマ区切り・単位(deg)も、このスロットでは書けません。" +
      // 【V20-M9 / ADR-0474 §Decision 1-1】参照の綴りを1文足した(例の丸括弧の外に置く —— 例は単独で通る値だけ)。
      "生の色(palette_ で始まる名前。英小文字・数字・_ で1〜40字)を同じテーマに定義していれば、" +
      "$palette_<名前> の形でその色を指すこともできます。",
  },
  {
    match: /^\^\(0\|\[0-9\]\{1,4\}/,
    label: "長さ",
    hint:
      "長さは 0 か、数値に px / rem / em を付けた形だけです(例: 0 / 8px / 1.5rem)。" +
      "単位なしの数値(8 だけ)は書けず、% / vw / vh / pt も書けません。" +
      "小数点以下は3桁までで、calc() や var() は書けません。",
  },
  {
    match: /^\^\[0-9\]\{1,2\}/,
    label: "行間",
    hint:
      "行間は単位なしの数値だけです(例: 1.6 / 2)。px / rem / em などの単位は付けられません" +
      " —— 1.6rem は書けません。整数部は2桁まで、小数点以下は3桁までで、" +
      "値は数値ではなく文字列として書きます。",
  },
  {
    match: /^\^\(none\|/,
    label: "影",
    hint:
      "影は none か、長さを2〜4個スペースで区切って並べ、最後に16進色を1つ足した形だけです" +
      "(例: none / 0 1px 3px #0000001a)。長さは 0 か 数値+px / rem / em です。" +
      "rgba() は書けないので、透明度は16進8桁(#rrggbbaa)で表します。" +
      "inset や、カンマで複数の影を並べる形は書けません。",
  },
  {
    match: /^\^\[\^\(/,
    label: "書体",
    hint:
      '書体はフォント名をカンマで区切って並べた形です(例: system-ui, sans-serif / "Helvetica Neue", sans-serif)。' +
      "空白を含む名前は引用符で囲めます。" +
      "記号 ( ) { } [ ] ; : / \\ < > & ? | ^ ~ # $ @ ! = % * + は1文字も使えないので、" +
      "var() や calc() は書けません。1〜200文字です。",
  },
];

/**
 * そのエラーが「テーマのスロット値の書式違反」なら、族の名前と hint を返す。
 *
 * **`case "type":` とは重複しない** —— Ajv は同じ位置で `type` が落ちたら `pattern` を
 * 評価しないので、「型の文面」と「書式の文面」が同じ往復に並ぶことはない
 * (テストで実測して固定している)。**`minLength` とだけは同じ往復に並ぶ**
 * (空の書体は `minLength` と `pattern` の2件になる)。そちらは「空である」しか
 * 言わないので、書式を教えるのは pattern 側の役目である。
 */
function themeValueFamily(error: ErrorObject): { label: string; hint: string } | undefined {
  if (!THEME_SLOT_SCHEMA_PATH.test(error.schemaPath ?? "")) {
    return undefined;
  }
  const pattern = String(((error.params ?? {}) as AjvParams).pattern ?? "");
  return THEME_VALUE_FAMILIES.find((family) => family.match.test(pattern));
}

/**
 * **アクセス権管理の権限名(`access_control.permissions[].id`)の位置**(`V7-M2-T01`。
 * `Z-G12` 限定 (7)。**裁定は `docs/plan/v7/records/v7-m0.md` §6-4b の1**)。
 *
 * ## なぜ汎用文面を使わないのか
 *
 * **`not` の汎用文面は `"id が不正です(not: must NOT be valid)。"` である** ——
 * **`must NOT be valid` は Ajv の内部の言葉であって、利用者の言葉ではない。**
 * **どの値が・なぜ使えないのかを1文字も言っていない。**
 *
 * ## なぜ `instancePath` ではなく `schemaPath` で判定するのか
 *
 * `ACTION_VALUE_SCHEMA_PATH` / `THEME_SLOT_SCHEMA_PATH` と同じ理由である。
 * 権限名が現れる位置はマニフェスト側(`/app/tables/<i>/access_control/…`)と
 * 差分側(`change_table` / `add_table` 経由)の複数あり、`instancePath` を数え上げると
 * 位置が1つ増えるたびに黙って漏れる。
 *
 * ## **`user_kinds` 側の文面を1バイトも変えていない**(**正直に書く**)
 *
 * **`$defs/app/properties/user_kinds` の予約4語も、今日も同じ `not` で止まっており、
 * 文面は `"id が不正です(not: must NOT be valid)。"` のままである。**
 * **本タスクはそちらを直していない**(`Z-G10` 限定 (5)「`user_kinds` の中に1バイトも
 * 書かない」を守るため、そして本タスクの射程が権限名だからである)。
 * **したがって「予約4語の拒否の文面はどこでも利用者の言葉である」とは書けない。**
 */
const PERMISSION_ID_NOT_SCHEMA_PATH =
  /(^|\/)access_control\/properties\/permissions\/items\/properties\/id\/not$/;

/**
 * **予約4語が「なぜ権限の名前に使えないのか」**(`v7-m0.md` §6-4b の1 の理由 (a) と (b))。
 *
 * **理由を語ごとに分けて持つ** —— **`owner` / `editor` / `viewer` は運営ロールの名前
 * (`src/auth/types.ts:62` の `RESERVED_ROLES`)であり、`anonymous` はロールではなく
 * 「ログインしていない人」を表す名前である。**
 * **1つの文面にまとめると、`anonymous` について「運営ロールである」という嘘になる。**
 *
 * **【2026-08-10 追記(`V8-M20`。台帳 `J-G27`。手続きは `ADR-0301`)。旧文の指し先を直した】**
 * **着手前、`anonymous` の出どころは `$defs/view.audience` の値として名指ししていた。**
 * **そのキーは `V8-M20` が廃止したので、今日の出どころは
 * `$defs/app/properties/roles/items/properties/id`(予約4語の1つ)である。**
 * **予約4語が権限の名前に使えないという結論は1バイトも変わっていない。**
 */
const RESERVED_PERMISSION_ID_REASONS: Readonly<Record<string, string>> = {
  owner: "運営ロールの名前",
  editor: "運営ロールの名前",
  viewer: "運営ロールの名前",
  anonymous: "ログインしていない人を表す名前",
};

/**
 * **予約された名前を権限名に書いた**エラーだけを、利用者の言葉に差し替える(`V7-M2-T01`)。
 *
 * **当たらなければ `null` を返し、呼び出し側は今日どおりの経路に落ちる** ——
 * **ここに当たらない `not` の文面を1バイトも変えていない**(`$defs/app/properties/user_kinds`
 * は今日のままである)。
 * **【2026-08-10 追記(`V8-M20`。台帳 `J-G28`)。旧文の指し先を直した】** **着手前は
 * `$defs/field/properties/audience` も並べていたが、そのキーは `V8-M20` が廃止したので、
 * 今日は指し先が無い。** **`user_kinds` 側の `not` は1バイトも動いていない。**
 */
function reservedPermissionIdError(error: ErrorObject, data: unknown): ValidationError | null {
  if (error.keyword !== "not" || !PERMISSION_ID_NOT_SCHEMA_PATH.test(error.schemaPath ?? "")) {
    return null;
  }
  const reason = typeof data === "string" ? RESERVED_PERMISSION_ID_REASONS[data] : undefined;
  if (reason === undefined) {
    return null;
  }
  // **予約4語の一覧をスキーマそのものから読む** —— **ここに5つ目の写しを作らない。**
  const forbidden = (error as { schema?: unknown }).schema as { enum?: unknown } | undefined;
  const listed = Array.isArray(forbidden?.enum)
    ? toAllowedValues(forbidden.enum as readonly unknown[])
    : undefined;
  return {
    path: error.instancePath,
    message: `"${data}" は${reason}として使われているため、権限の名前には使えません。`,
    // **`allowed_values` は付けない** —— **通る値は「予約4語以外の全部」であって列挙できない。**
    // **嘘の一覧を出すくらいなら省く**(この層が `resolveAllowedProperties` で採っている作法)。
    hint:
      listed === undefined
        ? "別の名前を付けてください(「参照のみ」のような表示名は name のほうに書けます)。"
        : `${listed.map((value) => `"${value}"`).join(" / ")} の4つは、権限の名前にできません。` +
          "別の名前を付けてください(「参照のみ」のような表示名は name のほうに書けます)。",
  };
}

/**
 * Ajv エラー1件を統一形式に変換する。
 * 変換対象外(内部的な制御キーワード)の場合は null を返す。
 *
 * `ifErrors` は同じバッチ内の `if` エラーを instancePath で引ける形にしたもの。
 * `false schema` の位置を解決する手がかりとしてのみ使う(上記 {@link allowedPropertiesFromBranch})。
 */
function convert(
  error: ErrorObject,
  ifErrors: ReadonlyMap<string, ErrorObject>,
): ValidationError | null {
  const path = error.instancePath;
  const params = (error.params ?? {}) as AjvParams;
  const where = describeLocation(path);
  // verbose: true のときのみ入る、違反した実データ。
  const data = (error as { data?: unknown }).data;

  /*
   * **アクセス権管理の権限名だけ、`not` の汎用文面を使わない**(`V7-M2-T01`)。
   * 経緯と、**`user_kinds` 側を1バイトも変えていないこと**は
   * {@link PERMISSION_ID_NOT_SCHEMA_PATH} の doc に書いた。
   * **当たらなければ今日どおりの `switch` に落ちる。**
   */
  const reservedPermissionId = reservedPermissionIdError(error, data);
  if (reservedPermissionId !== null) {
    return reservedPermissionId;
  }

  /*
   * **テーマのスロットの位置の `anyOf` だけ落とす**(`V20-M7`)。理由は
   * {@link THEME_SLOT_ANYOF_SCHEMA_PATH} の doc に書いた。**当たらなければ今日どおりの `switch` に落ちる。**
   */
  if (error.keyword === "anyOf" && THEME_SLOT_ANYOF_SCHEMA_PATH.test(error.schemaPath ?? "")) {
    return null;
  }

  /*
   * **`set_workspace` の器の位置だけ**(`V22-M3-T02`。`ADR-0488` §Decision 2 の 3)。 理由は
   * {@link SET_WORKSPACE_VALUE_ANYOF_SCHEMA_PATH} と {@link SET_WORKSPACE_EMPTY_SCHEMA_PATH} の doc に書いた。
   * **当たらなければ今日どおりの `switch` に落ちる。**
   */
  const setWorkspace = setWorkspaceError(error, path);
  if (setWorkspace !== undefined) {
    return setWorkspace;
  }

  /*
   * **選んだ形の記録と型の下の位置だけ**、`pattern` / `maxItems` / `uniqueItems` の文言を差し替える
   * (`V20-M15-T01A`)。理由は {@link designMemoryError} の doc に書いた。**当たらなければ今日どおりの
   * `switch` に落ちる。**
   */
  const designMemory = designMemoryError(error, data);
  if (designMemory !== undefined) {
    return designMemory;
  }

  /*
   * **行の招待の宣言(`access_control.invitations`)の下の位置だけ**(`V23-M5-T02`)。 理由は
   * {@link invitationsError} の doc に書いた。 **当たらなければ今日どおりの `switch` に落ちる。**
   */
  const invitationsResult = invitationsError(error, data);
  if (invitationsResult !== undefined) {
    return invitationsResult;
  }

  switch (error.keyword) {
    // `if` は allOf による分岐制御の副産物で、原因は同時に報告される then/else 側のエラー。
    // そのまま出すとLLMを混乱させるため落とす。
    case "if":
      return null;

    case "enum": {
      const allowed = toAllowedValues((params.allowedValues ?? []) as unknown[]);
      return {
        path,
        message: `${where} の値 ${describeValue(data)} は語彙にありません。`,
        allowed_values: allowed,
        hint: DIFF_OP_PATH.test(path)
          ? DIFF_OP_ENUM_HINT
          : "許可される値のいずれかに置き換えてください。v0の語彙は拡張できません。",
      };
    }

    /*
     * **【`V20-M5-T01` / `ADR-0471`】並べ方の木の節の型の判別**(`$defs/layout_node` の `discriminator`)。
     * - `mapping` … `type` の値がどの枝にも無い。**書ける値の一覧は枝の `const` を宣言順に並べたもの**
     *   (`enum` の拒否と同じ文面の作法)。
     * - `tag` … `type` が無い / 文字列でない。**同じ位置の `required` の拒否が同時に出るので、ここでは出さない**
     *   (文字列でない場合は `type` の値として `mapping` と同じ文面を出す)。
     */
    case "discriminator": {
      const parentSchema = (error as { parentSchema?: unknown }).parentSchema as
        | { oneOf?: { properties?: { type?: { const?: unknown } } }[] }
        | undefined;
      const allowed = toAllowedValues(
        (parentSchema?.oneOf ?? []).map((branch) => branch.properties?.type?.const),
      );
      const tagValue = (params as { tagValue?: unknown }).tagValue;
      const record = data as Record<string, unknown> | null | undefined;
      const hasTag = record !== null && typeof record === "object" && Object.hasOwn(record, "type");
      if (!hasTag) {
        return null;
      }
      return {
        path: `${path}/type`,
        message: `type の値 ${describeValue(tagValue ?? record?.type)} は語彙にありません。`,
        allowed_values: allowed,
        hint: "許可される値のいずれかに置き換えてください。v0の語彙は拡張できません。",
      };
    }

    case "const": {
      const allowed = toAllowedValues([params.allowedValue]);
      return {
        path,
        message: `${where} の値 ${describeValue(data)} は許可されていません。`,
        allowed_values: allowed,
      };
    }

    case "required": {
      const missing = String(params.missingProperty);
      return {
        path,
        message: `必須プロパティ "${missing}" がありません。`,
        hint: `${path === "" ? "ルート" : path} に "${missing}" を追加してください。`,
      };
    }

    case "additionalProperties": {
      const extra = String(params.additionalProperty);
      // verbose: true のときのみ入る、その位置に適用されたスキーマ。
      const parentSchema = (error as { parentSchema?: unknown }).parentSchema;
      const allowed = resolveAllowedProperties(parentSchema, data);
      if (allowed === undefined) {
        return {
          path,
          message: `未知のプロパティ "${extra}" は指定できません。`,
          hint: "v0の語彙にないプロパティです。削除するか、語彙内の表現に置き換えてください。",
        };
      }
      // 【V20-M9 / ADR-0474】名前の形で受けるもの(`patternProperties`)が在れば、そのパターンも添える。
      const patterns = patternPropertyNames(parentSchema);
      if (patterns.length > 0) {
        return {
          path,
          message: `未知のプロパティ "${extra}" は指定できません。`,
          allowed_values: allowed,
          hint:
            `この位置で指定できるのは allowed_values のプロパティと、名前が ${patterns.join(" / ")} に合うプロパティだけです。` +
            `"${extra}" を削除するか、そのいずれかに置き換えてください。`,
        };
      }
      return {
        path,
        message: `未知のプロパティ "${extra}" は指定できません。`,
        allowed_values: allowed,
        hint: `この位置で指定できるのは allowed_values のプロパティだけです。"${extra}" を削除するか、そのいずれかに置き換えてください。`,
      };
    }

    // `properties: { x: false }` によって、その文脈では持てないプロパティを禁止した場合。
    case "false schema": {
      // 同じ位置(親インスタンス)の `if` エラーから文脈を解決する。解決できたときだけ列挙する。
      const parentPath = path.slice(0, path.lastIndexOf("/"));
      const allowed = allowedPropertiesFromBranch(ifErrors.get(parentPath));
      if (allowed === undefined) {
        return {
          path,
          message: `プロパティ "${where}" は、この種別では指定できません。`,
          hint: "この位置の type / op で許可されている属性のみを指定してください。",
        };
      }
      return {
        path,
        message: `プロパティ "${where}" は、この種別では指定できません。`,
        allowed_values: allowed,
        hint: `この文脈で指定できるのは allowed_values のプロパティだけです。"${where}" を削除するか、そのいずれかに置き換えてください。`,
      };
    }

    case "type": {
      /*
       * **`$defs/action_value` の位置だけ、汎用文面を使わない**(V1-M2-T05a D3)。
       * 経緯と判定方法の根拠は `ACTION_VALUE_SCHEMA_PATH` の doc に書いた。
       */
      /*
       * **【`V23-M4-T02`】`values` の器の位置も同じ文面に入れる**(`ADR-0524` §Decision 1-7)。
       * 器に `type: string` を置いたので、型違反は器の側でも起きる。 `values` の位置では書ける参照が
       * 5形増えるので、括弧の中だけを書き分ける(hint は同じ)。
       */
      const valuesPosition = isWorkflowValuesPosition(error);
      if (valuesPosition || ACTION_VALUE_SCHEMA_PATH.test(error.schemaPath ?? "")) {
        return {
          path,
          message:
            `${where} に ${describeValue(data)} を指定していますが、` +
            `ワークフローのアクションが書ける値は文字列だけです` +
            (valuesPosition
              ? `(固定の文字列か、${WORKFLOW_VALUES_REFERENCE_FORMS} の形の参照)。`
              : `(固定の文字列か、"$record.<フィールドID>" の形の参照)。`),
          /*
           * **「文字列にすれば通る」と言ってはならない。それが罠である。**
           * `"true"` にすると差分は通り、実行のたびにレコード書き込みが型違反で
           * 弾かれる —— **作った時点では成功して見えるのに永久に動かない。**
           * 正しい行き先は書き込み先の列の型なので、そちらだけを示す。
           */
          hint:
            `${describeValue(data)} を引用符で囲んで文字列にしても直りません。` +
            `文字列にすると型が boolean / number の列と合わないので、` +
            `**その差分は適用時に拒否されます**(V1-M9-T13 (2))。` +
            `直し方は2つあります。(1) 書き込み先のフィールドの型を text か long_text にする` +
            `(add_table / add_field で作るときの type、または change_field の changes.type)。` +
            `(2) boolean / number の列のままにしたいなら、値には同じ型のフィールドの参照を書く —— ` +
            `boolean 列には "$record.<boolean 列>"、number 列には "$record.<number 列>"` +
            `(true/false や数値のリテラルを書く手段はこの語彙にありません)。` +
            `date / select の列には文字列を書けます(型は string 同士なので適用時は通ります)が、` +
            `値の形が合っているものだけです —— date は ISO8601 形式の文字列(例: "2026-07-20")、` +
            `select は options に一致する文字列。形がずれると適用時は通り、実行時に弾かれます` +
            `(履歴テーブルの status / trigger_type に select を使ってはいけないのと同じ理由です)。`,
        };
      }
      /*
       * **【`V20-M5-T07` 軽5 / `ADR-0471`】並べ方の木の節(`$defs/layout_node`)の位置。**
       * 子の口は `if`(文字列)/ `then`(葉)/ `else`(節)なので、文字列でない値は `else` の節へ回り、
       * 汎用文面は「object を指定してください」だけになる —— **文字列の葉も書けることを言わない**(NF4 に届かない)。
       * 見分けは親スキーマの `discriminator`({@link isLayoutNodeSchema})。
       * **根(`…/layout`)には葉を置けない**ので、根は節だけを言う。
       */
      if (params.type === "object" && isLayoutNodeSchema(error.parentSchema)) {
        return /\/layout$/.test(path)
          ? {
              path,
              message: `${where} の値 ${describeValue(data)} は並べ方の木の根になりません。根には並べ方の節(object)を書いてください。`,
              hint: '根は { "type": "stack", "children": [...] } のような節です(type は stack / cluster / sidebar / switcher / grid / split)。項目名の文字列は、節の子として書いてください。',
            }
          : {
              path,
              message: `${where} の値 ${describeValue(data)} は並べ方の木の子になりません。子には、項目名(フィールドID)か "action:<名前>" の文字列、または並べ方の節(object)を書いてください。`,
              hint: '文字列なら、この画面の表示項目のフィールドIDか "action:<ボタンの識別子>"。節なら { "type": "stack", "children": [...] } のような object です。数値・真偽値・null・配列は書けません。',
            };
      }
      return {
        path,
        message: `${where} の型が不正です。${String(params.type)} を指定してください(実際の値: ${describeValue(data)})。`,
      };
    }

    case "pattern": {
      /*
       * **`$defs/action_value` の位置だけ、汎用文面を使わない**(V1-M2-T05e)。
       * 経緯と文面の要件は `ACTION_VALUE_PATTERN_HINT` の doc に書いた。
       * `case "type":` と同じく `schemaPath` で判定する(位置を数え上げない)。
       */
      const valuesPattern = isWorkflowValuesPosition(error);
      if (valuesPattern || ACTION_VALUE_SCHEMA_PATH.test(error.schemaPath ?? "")) {
        /*
         * `if/then/else` の**どちらの枝で落ちたか**で message を分ける。
         * - `else`(`$` で始まらない = リテラル扱い)… **そのまま書き込まれる**ことが起きる結果である
         * - `then`(`$` で始まるが参照の形でない)… **拒否される**のであって書き込まれない
         * ここを1つの文面にまとめると、`$foo` に対して
         * 「そのまま書き込まれます」という**新しい嘘**を作ることになる。
         */
        const isReferenceAttempt = typeof data === "string" && data.startsWith("$");
        return {
          path,
          message: isReferenceAttempt
            ? `${where} に ${describeValue(data)} を指定していますが、これは参照の形になっていません。`
            : `${where} に ${describeValue(data)} を指定しています。これは置換されません —— ` +
              `この文字列がそのまま、1文字も変わらずにレコードに書き込まれます。`,
          // **【`V23-M4-T02`】`values` の位置では5形まで並べる**(「`$record` だけ」と言わない)。
          hint: valuesPattern ? WORKFLOW_VALUES_PATTERN_HINT : ACTION_VALUE_PATTERN_HINT,
        };
      }
      /*
       * **テーマのスロットの位置も、汎用文面を使わない**(V3-M1-T08)。
       * 経緯と文面の要件は {@link THEME_SLOT_SCHEMA_PATH} /
       * {@link THEME_VALUE_FAMILIES} の doc に書いた。**message も差し替える** ——
       * 「識別子の規約に合いません」はテーマの値については1文字も当たっていない。
       */
      /*
       * **【`V20-M5-T01` / `ADR-0471`】並べ方の木の葉**(`$defs/layout_node` の子の口の `then`)。
       * 葉は識別子そのものではなく「項目のフィールドID か `action:<ボタンの識別子>`」なので、
       * 識別子の汎用文面(例: book-tracker)では書き直し方が伝わらない。**長さ・数値は書けない**ことも言う。
       */
      // 見分けは葉の規約の綴り(`^(action:)?` で始まる pattern)で行う —— 参照先の定義の中の schemaPath は
      // `#/oneOf/...` に縮み、定義の名前を含まないため。
      if (String(params.pattern ?? "").startsWith("^(action:)?")) {
        return {
          path,
          message: `${where} の値 ${describeValue(data)} は並べ方の木の葉の形に合いません。`,
          hint: '葉には、この画面の表示項目のフィールドID(英小文字で始まり、英小文字・数字・ハイフン・アンダースコアのみ)か、"action:<ボタンの識別子>" を書いてください。長さや数値(12px など)は書けません。',
        };
      }
      const themeFamily = themeValueFamily(error);
      if (themeFamily !== undefined) {
        return {
          path,
          message: `${where} の値 ${describeValue(data)} は${themeFamily.label}の書式に合いません。`,
          hint: themeFamily.hint,
        };
      }
      return {
        path,
        message: `${where} の値 ${describeValue(data)} は識別子の規約に合いません。`,
        hint: VIEW_TABLE_PATH.test(path) ? VIEW_TABLE_PATTERN_HINT : RESOURCE_ID_PATTERN_HINT,
      };
    }

    case "minLength": {
      const limit = Number(params.limit);
      return {
        path,
        message:
          limit === 1
            ? `${where} が空です。1文字以上の値を指定してください。`
            : `${where} が短すぎます。${limit}文字以上にしてください。`,
      };
    }

    case "maxLength": {
      return {
        path,
        message: `${where} が長すぎます。${String(params.limit)}文字以内にしてください。`,
      };
    }

    case "minItems": {
      return {
        path,
        message: `${where} の要素が足りません。${String(params.limit)}件以上必要です。`,
      };
    }

    case "minProperties": {
      return {
        path,
        message: `${where} に指定すべき項目がありません。${String(params.limit)}件以上指定してください。`,
      };
    }

    default: {
      return {
        path,
        message: `${where} が不正です(${error.keyword}: ${error.message ?? "詳細不明"})。`,
      };
    }
  }
}

/**
 * **`set_workspace` の器のキーの値の `anyOf`(`$ref` か `null` の2択)の位置**(`V22-M3-T02`)。
 *
 * 値が `$ref` の側で落ちると、Ajv はその本当の誤り(例: 位置の値が `side` / `top` でない)に加えて、
 * `null` の側の `type` の誤り1件と、`anyOf` の誤り1件を返す。 **後の2件は「`null` でない」「どちらにも
 * 合わない」という言い訳であって原因ではない**ので落とす(テーマのスロットの `anyOf` と同じ作法)。
 * **この器の外の `anyOf` は1バイトも変えない。**
 *
 * **【`V23-M5-T02`】3つ目のキー `invitations` を足した。** 旧(逐語):
 * `/\/then\/properties\/workspace\/properties\/(navigation|my_page)\/anyOf(\/1\/type)?$/`
 */
const SET_WORKSPACE_VALUE_ANYOF_SCHEMA_PATH =
  /\/then\/properties\/workspace\/properties\/(navigation|my_page|invitations)\/anyOf(\/1\/type)?$/;

/**
 * **`set_workspace` の器の `minProperties`(空の `{}` を断る)の位置**(`V22-M3-T02`。`ADR-0488` §Decision 2 の 3)。
 * 汎用の「指定すべき項目がありません」ではなく、**`{}` は何も変えない指示であることと、消すには
 * `null` を書くこと**を言う(M2 までは `{}` が「宣言を消す」だったので、書き手がそう思い込んでいる)。
 */
const SET_WORKSPACE_EMPTY_SCHEMA_PATH = /\/then\/properties\/workspace\/minProperties$/;

/** `set_workspace` の器の位置の誤りの文言(当たらなければ `undefined`、落とすなら `null`)。 */
function setWorkspaceError(error: ErrorObject, path: string): ValidationError | null | undefined {
  const schemaPath = error.schemaPath ?? "";
  if (
    (error.keyword === "anyOf" || error.keyword === "type") &&
    SET_WORKSPACE_VALUE_ANYOF_SCHEMA_PATH.test(schemaPath)
  ) {
    return null;
  }
  if (error.keyword === "minProperties" && SET_WORKSPACE_EMPTY_SCHEMA_PATH.test(schemaPath)) {
    return {
      path,
      message:
        "set_workspace の workspace が空({})です。空の workspace は何も変えない指示なので受け付けません。",
      hint: 'set_workspace は書いたキーだけを置き換えます(書かなかったキーは残ります)。メニューの置き方は navigation、マイページは my_page に書いてください。宣言を消すときは、そのキーに null を書きます(例: {"navigation": null} / {"my_page": null}。両方消すと workspace ごと消えます)。',
    };
  }
  return undefined;
}

/**
 * 同一パス・同一メッセージのエラーを1件にまとめるためのキー。
 *
 * **区切りは U+0000 を使う** —— パスにもメッセージにも現れないので、
 * `"a" + "/b"` と `"a/" + "b"` のような結合の衝突が起きない。
 *
 * **必ずエスケープ(`\u0000`)で書くこと。生の NUL バイトをソースに直接埋め込んではならない。**
 * かつてここは生のバイトで書かれており、その結果 `file(1)` がこのファイルを `data` と
 * 判定し、**`grep` がこのファイルのマッチを1件も返さなくなっていた**。
 * ADR-0007 限界11 の是正策(宣言時に識別子を `grep` で洗い出す)がこのファイルについて
 * 壊れ、実際に歯止め1 のはみ出しを1件生んでいる
 * (`docs/plan/v1/records/v1-m1-nul-and-callback.md` / `v1-m1-remove-view.md` §5-3)。
 * **実行時の意味はエスケープと生バイトで完全に同一であり、書き換えで失うものは無い**
 * (等価性の実測は前掲の記録)。機械的な再発防止は `scripts/no-nul-bytes.test.ts`。
 */
function dedupeKey(error: ValidationError): string {
  return `${error.path}\u0000${error.message}`;
}

/**
 * `op` が語彙外だった operation のインデックス集合を、生エラーから求める。
 *
 * diff スキーマは op ごとの必須・禁止属性を `allOf` + `if/then` で表す。op が語彙外だと
 * どの `then` にも入れないため、Ajv は「then が要求していた形」に照らしたエラーを
 * まとめて吐く(例: `field` に文字列を渡したことへの型エラー)。これは分岐の副産物であって
 * 原因ではない。原因は「その op が v0 に存在しない」の一点なので、
 * その operation については op のエラーだけを残す(handover 3.8 / 憲法6)。
 */
function operationsWithUnknownOp(errors: readonly ErrorObject[]): Set<string> {
  const indices = new Set<string>();
  for (const error of errors) {
    if (error.keyword !== "enum") {
      continue;
    }
    const index = DIFF_OP_PATH.exec(error.instancePath)?.[1];
    if (index !== undefined) {
      indices.add(index);
    }
  }
  return indices;
}

/**
 * Ajv の生エラー配列を統一形式に変換する。
 * `allErrors: true` 前提で、複数エラーをまとめて(重複を除いて)返す。
 *
 * 抑制は「op が語彙外だった、その operation」に限る。別の operation や
 * operations 配下でないエラーまで消すと、`allErrors: true` にしている意味
 * (LLM に1往復で全部直させる)が失われる。
 */
export function toValidationErrors(
  errors: readonly ErrorObject[] | null | undefined,
): ValidationError[] {
  if (!errors || errors.length === 0) {
    return [];
  }
  const unknownOpIndices = operationsWithUnknownOp(errors);
  // `false schema` の位置を解決するための手がかり(同時に必ず報告される `if` エラー)。
  const ifErrors = new Map<string, ErrorObject>();
  for (const raw of errors) {
    if (raw.keyword === "if" && !ifErrors.has(raw.instancePath)) {
      ifErrors.set(raw.instancePath, raw);
    }
  }
  const seen = new Set<string>();
  const result: ValidationError[] = [];
  for (const raw of errors) {
    const index = operationIndexOf(raw.instancePath);
    if (
      index !== undefined &&
      unknownOpIndices.has(index) &&
      !DIFF_OP_PATH.test(raw.instancePath)
    ) {
      continue;
    }
    const converted = convert(raw, ifErrors);
    if (converted === null) {
      continue;
    }
    const key = dedupeKey(converted);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(converted);
  }
  return result;
}
