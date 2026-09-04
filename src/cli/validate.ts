#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  formatValidationErrors,
  type ValidationError,
  type ValidationResult,
} from "../kernel/errors.ts";
import { validateDiff, validateManifestFull } from "../kernel/validate.ts";

/**
 * バリデーションCLI(V0-P1-T06)。
 *
 *   bun run validate <file.json> [--kind manifest|diff] [--json]
 *
 * 以降のフェーズおよび人間のデバッグ用の入口。カーネルの公開APIを呼ぶだけの薄い層で、
 * 判定ロジックはここに書かない(カーネルとCLIで正誤の基準が二重化するのを避ける)。
 *
 * 終了コードの契約:
 * - 0: 検証に通過した
 * - 1: 検証に失敗した(統一形式のエラーを出力)
 * - 2: 入力が扱えなかった(使い方の誤り・ファイルが読めない・JSONが壊れている・種別不明)
 *
 * 1 と 2 を分けているのは、呼び出し側(スクリプトやLLM)が「マニフェストを直すべき」と
 * 「呼び出し方を直すべき」を機械的に区別できるようにするため。
 * どちらも非0なので、単に成否だけを見る使い方でも困らない。
 *
 * 出力はすべて標準出力に出す(エラーも含む)。パイプで1本にまとめて読めるようにするため。
 */

const EXIT_OK = 0;
const EXIT_INVALID = 1;
const EXIT_INPUT_ERROR = 2;

/** 検証対象の種別。 */
type Kind = "manifest" | "diff";

const KIND_LABEL: Record<Kind, string> = {
  manifest: "マニフェスト",
  diff: "差分パッチ",
};

const USAGE = [
  "使い方: bun run validate <file.json> [--kind manifest|diff] [--json]",
  "",
  "  <file.json>            検証するマニフェストまたは差分パッチのJSONファイル",
  "  --kind manifest|diff   種別を明示する(省略時は中身から自動判定)",
  "  --json                 結果を機械可読なJSONで出力する",
  "",
  "終了コード: 0=通過 / 1=検証エラー / 2=入力エラー",
].join("\n");

/** 入力そのものが扱えなかったことを表す。検証エラー(exit 1)とは区別する。 */
class InputError extends Error {
  readonly error: ValidationError;

  constructor(error: ValidationError) {
    super(error.message);
    this.name = "InputError";
    this.error = error;
  }
}

type Options = { file: string; kind: Kind | undefined; json: boolean };

/** コマンドライン引数を解釈する。 */
function parseArgs(argv: readonly string[]): Options {
  let file: string | undefined;
  let kind: Kind | undefined;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--kind") {
      const value = argv[index + 1];
      index += 1;
      if (value !== "manifest" && value !== "diff") {
        throw new InputError({
          path: "--kind",
          message: `--kind の値 ${value === undefined ? "(未指定)" : `"${value}"`} は指定できません。`,
          allowed_values: ["manifest", "diff"],
          hint: USAGE,
        });
      }
      kind = value;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new InputError({
        path: arg,
        message: `未知のオプション "${arg}" です。`,
        allowed_values: ["--kind", "--json"],
        hint: USAGE,
      });
    }
    if (file !== undefined) {
      throw new InputError({
        path: arg,
        message: "検証できるファイルは一度に1つだけです。",
        hint: USAGE,
      });
    }
    file = arg;
  }

  if (file === undefined) {
    throw new InputError({
      path: "",
      message: "検証するファイルが指定されていません。",
      hint: USAGE,
    });
  }
  return { file, kind, json };
}

/** ファイルを読んでJSONとしてパースする。読めない・壊れている場合は InputError。 */
function loadJson(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch (cause) {
    throw new InputError({
      path: file,
      message: `ファイル "${basename(file)}" を読み込めません(${cause instanceof Error ? cause.message : String(cause)})。`,
      hint: "パスが正しいか、ファイルが存在するかを確認してください。",
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new InputError({
      path: file,
      message: `ファイル "${basename(file)}" は JSON として読めません(${cause instanceof Error ? cause.message : String(cause)})。`,
      hint: "JSONの構文(カンマ・引用符・括弧の対応)を確認してください。",
    });
  }
}

/**
 * 中身から種別を自動判定する。
 * トップレベルに `app` があればマニフェスト、`operations` があれば差分パッチ。
 * 判定できない(どちらも無い/両方ある)場合は InputError。
 */
function detectKind(input: unknown, file: string): Kind {
  const object =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const hasApp = "app" in object;
  const hasOperations = "operations" in object;
  if (hasApp && !hasOperations) {
    return "manifest";
  }
  if (hasOperations && !hasApp) {
    return "diff";
  }
  throw new InputError({
    path: "",
    message: `"${basename(file)}" がマニフェストか差分パッチかを判定できません。`,
    hint: 'トップレベルに "app"(マニフェスト)または "operations"(差分パッチ)のどちらか一方が必要です。--kind manifest|diff で明示することもできます。',
  });
}

/** 出力用のJSON表現。 */
function toJsonReport(file: string, kind: Kind | null, result: ValidationResult): string {
  return JSON.stringify(
    result.valid
      ? { file, kind, valid: true }
      : { file, kind, valid: false, errors: result.errors },
    null,
    2,
  );
}

/**
 * 実処理。出力と終了コードを「返す」だけで、書き出しも終了もしない。
 *
 * export しないのは、このファイルが読み込まれた時点で下部の実行部が走り
 * `process.exit` してしまうため。CLIはあくまで別プロセスとして起動して使う
 * (統合テストも `Bun.spawn` でそうしている)。
 */
function run(argv: readonly string[]): { output: string; code: number } {
  let options: Options | undefined;
  try {
    options = parseArgs(argv);
    const input = loadJson(options.file);
    const kind = options.kind ?? detectKind(input, options.file);
    const result = kind === "manifest" ? validateManifestFull(input) : validateDiff(input);

    if (options.json) {
      return {
        output: toJsonReport(options.file, kind, result),
        code: result.valid ? EXIT_OK : EXIT_INVALID,
      };
    }
    if (result.valid) {
      return {
        output: `OK: ${options.file} は${KIND_LABEL[kind]}として有効です。`,
        code: EXIT_OK,
      };
    }
    return {
      output: [
        `NG: ${options.file} の検証に失敗しました(${KIND_LABEL[kind]}、エラー${result.errors.length}件)。`,
        formatValidationErrors(result.errors),
      ].join("\n"),
      code: EXIT_INVALID,
    };
  } catch (cause) {
    if (!(cause instanceof InputError)) {
      throw cause;
    }
    const file = options?.file ?? "";
    if (options?.json === true) {
      return {
        output: toJsonReport(file, null, { valid: false, errors: [cause.error] }),
        code: EXIT_INPUT_ERROR,
      };
    }
    return {
      output: `NG: 入力を検証できませんでした。\n${formatValidationErrors([cause.error])}`,
      code: EXIT_INPUT_ERROR,
    };
  }
}

const { output, code } = run(Bun.argv.slice(2));
console.log(output);
process.exit(code);
