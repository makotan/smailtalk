import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ErrorObject } from "ajv";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { toValidationErrors } from "./ajv-error-adapter.ts";
import { invalid, type ValidationResult, valid } from "./errors.ts";
import { validateReferentialIntegrity } from "./referential-integrity.ts";
import { checkThemeContrast } from "./theme-contrast.ts";
import type { Manifest } from "./types.ts";

/**
 * マニフェスト / 差分パッチの JSON Schema 適合バリデーション(V0-P1-T01 / T03)。
 *
 * 正準は `schemas/*.schema.json`(JSON Schema draft 2020-12)。
 * TypeScript 側でスキーマを組み立てることはしない。JSONのまま持つことで
 * MCPのツール定義やLLMの構造化出力にそのまま流用できるようにしている。
 */

const SCHEMA_DIR = join(import.meta.dir, "..", "..", "schemas");

/** マニフェストスキーマのファイルパス(正準)。 */
export const MANIFEST_SCHEMA_PATH = join(SCHEMA_DIR, "manifest.schema.json");
/** 差分パッチスキーマのファイルパス(正準)。 */
export const DIFF_SCHEMA_PATH = join(SCHEMA_DIR, "diff.schema.json");

/** JSON Schema を表す不透明なオブジェクト(中身は JSON そのもの)。 */
export type JsonSchema = Record<string, unknown>;

function loadSchema(path: string): JsonSchema {
  return JSON.parse(readFileSync(path, "utf-8")) as JsonSchema;
}

/** マニフェストの JSON Schema(パース済み)。MCPのツール定義等に流用してよい。 */
export const manifestSchema: JsonSchema = loadSchema(MANIFEST_SCHEMA_PATH);
/** 差分パッチの JSON Schema(パース済み)。MCPのツール定義等に流用してよい。 */
export const diffSchema: JsonSchema = loadSchema(DIFF_SCHEMA_PATH);

const ajv = new Ajv2020({
  // LLMが1往復で直せるよう、最初の1件で止めずに全エラーを集める。
  allErrors: true,
  // エラーメッセージに実際の値を載せるために必要。
  verbose: true,
  strict: true,
  // if/then で条件付き必須を表現しているため、`required` に挙げたプロパティが
  // 同じサブスキーマの `properties` に書かれていない、という指摘は無効化する
  // (プロパティ定義は分岐の外側にまとめて置いている)。
  strictRequired: false,
  // filter の `equals` は string / number / boolean を取りうるため、共用体型を許可する。
  allowUnionTypes: true,
});
addFormats(ajv);

ajv.addSchema(manifestSchema);
ajv.addSchema(diffSchema);

const compiledManifest = ajv.compile(manifestSchema);
const compiledDiff = ajv.compile(diffSchema);

/**
 * 検証の目的。**「新しい入力を受理してよいか」と「既に在るものを読めるか」は別の問いである。**
 *
 * - `"incoming"`(既定) … これから書き込まれる入力。**すべての制約を掛ける。**
 * - `"stored"` … **既にディスクに書かれているもの**(現行 manifest.json /
 *   スナップショットの manifest.json)。{@link INPUT_ONLY_SCHEMA_PATHS} に登録された
 *   制約だけを外して読む。
 */
type ValidationPurpose = "incoming" | "stored";

/**
 * **「新しい入力の受理」にだけ掛ける制約**の schemaPath 一覧(V1-M2-T05e / T05d 完了条件6)。
 *
 * ## なぜこの一覧が要るのか
 *
 * 語彙を**狭める**制約を後から足すと、**書かれた当時は正当だったマニフェストが、
 * 遡って不正になる。** undo は「その apply の直前の状態そのもの」を書き戻す操作
 * (ADR-0004 §4)なので、復元の入口で最新の制約を掛けると、
 * **制約を1つ強化するたびに過去の undo が壊れる。**
 *
 * T05d §8-5 はこれを D2-a の**最も重い代償**として挙げ、実データで
 * 「口ひげ記法を含むスナップショットが4本実在する」ことを数えた。
 * **その4本は、書かれた時点では検証を通っている。**壊れているのではない。
 *
 * ## 引いた線
 *
 * **制約は「書き込みの関門」で強制し、「既に在るもの」には遡らせない。**
 * これは v0 が `required` を NOT NULL 制約にしなかったのと**同じ線引き**である
 * (`ddl.ts` 冒頭の「制約を DDL に落とさない理由」)—— あちらも
 * 「既存データがある状態で制約を足せない」ことを理由に、強制を書き込み時へ寄せた。
 *
 * **緩むのは読み取りだけである。**`applyManifest` / `applyDiff` / `createApp` は
 * どれも既定の `"incoming"` で検証するので、**この一覧に何を足しても、
 * 不正なマニフェストが新たに書き込まれることはない。**
 * 復元された状態から次の差分を適用しようとすれば、適用後マニフェスト全体が
 * `"incoming"` で検証され、そこで拒否される(`undo.test.ts` が固定している)。
 *
 * ## 今後、制約を足す人へ
 *
 * **語彙を狭める制約を足したら、その schemaPath をここに1行足すかどうかを必ず判断すること。**
 * 判断の基準は1つ —— **「その制約より前に書かれたマニフェストが実在しうるか」。**
 * 実在しうるなら足す。足さないなら、その制約は過去の履歴を読めなくする。
 * **足すことは危険側ではない**(読み取りしか緩まない)。**足し忘れが危険側である。**
 */
const INPUT_ONLY_SCHEMA_PATHS: readonly RegExp[] = [
  // V1-M2-T05e: `$` で始まらない値に `{` `}` を書けない(ADR-0013 限定13)。
  // 制約導入前のスナップショットに `{{record.name}}` 等が実在する(T05d §8-5)。
  /(^|\/)\$defs\/action_value\/else\/pattern$/,
];

/** その Ajv エラーが「新しい入力にだけ掛ける制約」由来か。 */
function isInputOnlyError(error: ErrorObject): boolean {
  const schemaPath = error.schemaPath ?? "";
  return INPUT_ONLY_SCHEMA_PATHS.some((pattern) => pattern.test(schemaPath));
}

function run(
  validateFn: typeof compiledManifest,
  input: unknown,
  purpose: ValidationPurpose = "incoming",
): ValidationResult {
  if (validateFn(input)) {
    return valid();
  }
  const raw = validateFn.errors ?? [];
  // `stored` のときだけ、入力専用の制約に由来するエラーを落とす。
  // 分岐制御の `if` エラーは `toValidationErrors` が落とすので、
  // 残りが `if` だけになった場合もここで 0 件になる。
  const kept = purpose === "stored" ? raw.filter((error) => !isInputOnlyError(error)) : raw;
  const errors = toValidationErrors(kept);
  if (errors.length === 0) {
    // `incoming` で 0 件になるのは変換対象外のキーワードしか無かった場合であり、
    // 「適合しない」という事実だけは落とさない(v0 からの挙動)。
    return purpose === "stored"
      ? valid()
      : invalid([{ path: "", message: "スキーマに適合しません(詳細不明)。" }]);
  }
  return invalid(errors);
}

/**
 * マニフェスト(`{ app: ... }`)がスキーマに適合するか検証する。
 * ID参照の整合性(参照先の存在・ID重複)は検証しない(V0-P1-T02 の担当)。
 */
export function validateManifest(
  input: unknown,
  purpose: ValidationPurpose = "incoming",
): ValidationResult {
  return run(compiledManifest, input, purpose);
}

/**
 * 差分パッチ(`{ diff_id, intent, operations }`)がスキーマに適合するか検証する。
 * op は additive 4種のみ。破壊的な op はここで語彙外として拒否される。
 */
export function validateDiff(input: unknown): ValidationResult {
  return run(compiledDiff, input);
}

/**
 * マニフェストを「構造(JSON Schema)→ 参照整合性」の順に検証する統合入口。
 *
 * 構造検証が落ちた場合は参照整合性検証を実行せず、構造エラーのみを返す。
 * 構造が不正なら `Manifest` として型が保証されず、参照整合性の検査が前提を
 * 満たさないため(かつLLMにはまず構造から直させるほうが収束が速いため)。
 */
export function validateManifestFull(
  input: unknown,
  /**
   * **既定は `"incoming"`(すべての制約を掛ける)。**
   *
   * ディスクに既に在るマニフェストを読む2箇所
   * (`apply-manifest.ts` の `readCurrentManifest` / `undo.ts` の `readSnapshotManifest`)
   * だけが `"stored"` を渡す。理由は {@link INPUT_ONLY_SCHEMA_PATHS} に書いた。
   */
  purpose: ValidationPurpose = "incoming",
): ValidationResult {
  const structural = validateManifest(input, purpose);
  if (!structural.valid) {
    return structural;
  }
  const referential = validateReferentialIntegrity(input as Manifest);
  if (!referential.valid) {
    return referential;
  }
  return checkTheme(input as Manifest, purpose);
}

/**
 * テーマのコントラスト検査(V3-M1-T03 / ADR-0047 限定8 / ADR-0046 §1b)。
 *
 * ## `purpose === "incoming"` にだけ掛ける(この非対称が限定8 の実体である)
 *
 * **`stored` 読み取り(`readCurrentManifest` / `readSnapshotManifest`)には掛けない。**
 * 掛けると、**閾値を後から厳しくした日に、それより前に書かれたマニフェストが読めなくなり、
 * 過去の undo が壊れる** —— 上の {@link INPUT_ONLY_SCHEMA_PATHS} の説明がそのまま
 * 当てはまる形である。**コントラスト検査は語彙を狭める制約そのものである**(閾値は
 * 後から厳しくなりうる)。
 *
 * `INPUT_ONLY_SCHEMA_PATHS` の仕組みに載せないのは、この検査が **Ajv のエラーではなく
 * 純関数の返り値**だからである(schemaPath を持たない)。**線の引き方は同じで、
 * 実現方法だけが違う。**
 *
 * ## 順序 —— 構造 → 参照整合性 → コントラスト
 *
 * 構造検証を通っていないマニフェストにはこの検査を掛けない(掛ければ「スロットが
 * 25個そろっている」「値が文字列である」という前提が無いまま比を測ることになる)。
 * **LLM にはまず構造から直させるほうが収束が速い**という既存の判断
 * (`validateManifestFull` の doc コメント)と同じ向きである。
 *
 * ## 閾値の意味を取り違えないこと
 *
 * 担保するのは「**閾値未満の配色を適用できないこと**」だけであって、「読みやすいこと」
 * でも「良い配色であること」でもない(ADR-0046 §1c。**数値は WCAG から借りたが
 * 「WCAG 準拠」と名乗らない**)。
 */
function checkTheme(manifest: Manifest, purpose: ValidationPurpose): ValidationResult {
  if (purpose !== "incoming") {
    return valid();
  }
  const theme = manifest.app?.theme;
  if (theme === undefined) {
    return valid();
  }
  // **`slots` は構造検証を通っているので25キーそろっている**(`$defs/theme` の
  // `required` が全スロット。ADR-0047 2026-07-25 追記(2))。したがって
  // 「片側しか与えられていない対は測れない」という T02 の穴は、この経路では起きない。
  const errors = checkThemeContrast(theme.slots, "/app/theme/slots");
  return errors.length > 0 ? invalid(errors) : valid();
}
