#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { formatValidationErrors, type ValidationError } from "../kernel/errors.ts";
import type { Manifest } from "../kernel/types.ts";
import { validateManifestFull } from "../kernel/validate.ts";
import { collectDesignNotices, type DesignNoticeReport } from "../shared/design-notices.ts";

/**
 * 画面の作りの点検コマンド。
 *
 *   bun run lint:design <file.json> [--json]
 *
 * マニフェストを1つ読み、まず検証(`validate` と同じ `validateManifestFull`)に掛け、
 * 通ったものだけを画面の作りの点検(`collectDesignNotices`)に掛ける。
 * **判定ロジックはここに書かない**(検証はカーネル、点検は `src/shared/design-notices.ts`)。
 *
 * **`bun run lint`(コード整形の検査。biome)とは別物である。** `lint` を打っても
 * この点検は走らない。
 *
 * 終了コードの契約(`validate` と同じ3値):
 * - 0: 検証に通過した(**注意があってもなくても 0**。注意は保存を止めないため)
 * - 1: 検証に失敗した(統一形式のエラーを出力)
 * - 2: 入力が扱えなかった(使い方の誤り・ファイルが読めない・JSONが壊れている・
 *      マニフェストでない。差分ファイルは点検できないのでここに入る)
 *
 * 1 と 2 を分けているのは、呼び出し側(スクリプトやLLM)が「マニフェストを直すべき」と
 * 「呼び出し方を直すべき」を機械的に区別できるようにするため。
 * どちらも非0なので、単に成否だけを見る使い方でも困らない。
 *
 * **注意の有無は終了コードに出ない。** 知りたいときは `--json` の `notices`
 * (件数は `notices.length`)か、人向け出力の「注意 N件」を読む。
 *
 * 閾値は引数に置かない(コード定数に固定。`src/shared/design-notices.ts`)。
 *
 * 出力はすべて標準出力に出す(エラーも含む)。パイプで1本にまとめて読めるようにするため。
 *
 * **`src/cli/validate.ts` は import しない** —— 読み込んだ時点で下部の実行部が走り
 * `process.exit` してしまう(export も持たない)。引数の解釈・ファイルの読み込み・
 * 入力エラーの形は `validate.ts` から写した(重複している)。
 */

const EXIT_OK = 0;
const EXIT_INVALID = 1;
const EXIT_INPUT_ERROR = 2;

const USAGE = [
  "使い方: bun run lint:design <file.json> [--json]",
  "",
  "  <file.json>   点検するマニフェストのJSONファイル(差分ファイルは点検できない)",
  "  --json        結果を機械可読なJSONで出力する",
  "",
  "終了コード: 0=検証に通過(注意の有無に関わらず) / 1=検証エラー / 2=入力エラー",
  "コード整形の検査(bun run lint)とは別物です。",
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

type Options = { file: string; json: boolean };

/** コマンドライン引数を解釈する(`validate.ts` の `parseArgs` から `--kind` を除いて写した)。 */
function parseArgs(argv: readonly string[]): Options {
  let file: string | undefined;
  let json = false;

  for (const arg of argv) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new InputError({
        path: arg,
        message: `未知のオプション "${arg}" です。`,
        allowed_values: ["--json"],
        hint: USAGE,
      });
    }
    if (file !== undefined) {
      throw new InputError({
        path: arg,
        message: "点検できるファイルは一度に1つだけです。",
        hint: USAGE,
      });
    }
    file = arg;
  }

  if (file === undefined) {
    throw new InputError({
      path: "",
      message: "点検するファイルが指定されていません。",
      hint: USAGE,
    });
  }
  return { file, json };
}

/** ファイルを読んでJSONとしてパースする(`validate.ts` の `loadJson` から写した)。 */
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

/** マニフェストであることを確かめる。差分ファイルと、どちらとも判定できないものは入力エラー。 */
function requireManifest(input: unknown, file: string): void {
  const object =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const hasApp = "app" in object;
  const hasOperations = "operations" in object;
  if (hasApp && !hasOperations) {
    return;
  }
  if (hasOperations && !hasApp) {
    throw new InputError({
      path: "",
      message: `"${basename(file)}" は差分ファイルです。画面の作りの点検はマニフェストにだけ掛けられます。`,
      hint: '差分の形の検証は bun run validate で行えます。点検するには、トップレベルに "app" を持つマニフェストを渡してください。',
    });
  }
  throw new InputError({
    path: "",
    message: `"${basename(file)}" がマニフェストかどうかを判定できません。`,
    hint: 'トップレベルに "app" を持つマニフェストを渡してください。',
  });
}

/** 人向けの出力(検証に通ったとき)。 */
function toHumanReport(file: string, report: DesignNoticeReport): string {
  const lines = [
    `OK: ${file} はマニフェストとして有効です。画面の作りの注意 ${report.notices.length}件。`,
  ];
  report.notices.forEach((notice, index) => {
    lines.push(`${index + 1}. [${notice.rule}] ${notice.path}: ${notice.message}`);
  });
  lines.push("", "数えなかったもの:");
  for (const one of report.not_counted) {
    lines.push(`- ${one.what}: ${one.reason}`);
  }
  lines.push("", "この点検の限界:");
  for (const one of report.limits) {
    lines.push(`- ${one}`);
  }
  return lines.join("\n");
}

/**
 * 実処理。出力と終了コードを「返す」だけで、書き出しも終了もしない
 * (`validate.ts` と同じく export しない。別プロセスとして起動して使う)。
 */
function run(argv: readonly string[]): { output: string; code: number } {
  let options: Options | undefined;
  try {
    options = parseArgs(argv);
    const input = loadJson(options.file);
    requireManifest(input, options.file);
    const result = validateManifestFull(input);

    if (!result.valid) {
      if (options.json) {
        return {
          output: JSON.stringify(
            { file: options.file, kind: "manifest", valid: false, errors: result.errors },
            null,
            2,
          ),
          code: EXIT_INVALID,
        };
      }
      return {
        output: [
          `NG: ${options.file} の検証に失敗しました(マニフェスト、エラー${result.errors.length}件)。画面の作りの点検は行っていません。`,
          formatValidationErrors(result.errors),
        ].join("\n"),
        code: EXIT_INVALID,
      };
    }

    const report = collectDesignNotices(input as Manifest);
    if (options.json) {
      return {
        output: JSON.stringify(
          {
            file: options.file,
            kind: "manifest",
            valid: true,
            notices: report.notices,
            not_counted: report.not_counted,
            limits: report.limits,
          },
          null,
          2,
        ),
        code: EXIT_OK,
      };
    }
    return { output: toHumanReport(options.file, report), code: EXIT_OK };
  } catch (cause) {
    if (!(cause instanceof InputError)) {
      throw cause;
    }
    const file = options?.file ?? "";
    if (options?.json === true) {
      return {
        output: JSON.stringify({ file, kind: null, valid: false, errors: [cause.error] }, null, 2),
        code: EXIT_INPUT_ERROR,
      };
    }
    return {
      output: `NG: 入力を点検できませんでした。\n${formatValidationErrors([cause.error])}`,
      code: EXIT_INPUT_ERROR,
    };
  }
}

const { output, code } = run(Bun.argv.slice(2));
console.log(output);
process.exit(code);
