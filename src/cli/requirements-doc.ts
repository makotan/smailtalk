#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
import { generateRequirementsDoc } from "../kernel/requirements-doc.ts";

/**
 * 要件ドキュメント生成CLI(V1-M8-T02。ADR-0025 §10 の出口のうち CLI)。
 *
 *   bun run requirements-doc --data-root <path> --app <app_id> [--out <file>] [--json <file>]
 *
 * `src/cli/validate.ts` と同じ慣行に揃えてある。**入口層はロジックを持たない**
 * (ADR-0003 §7 / ADR-0025 限定9)—— `generateRequirementsDoc` を呼んで整形するだけで、
 * 文面の組み立ても出典の判定も1行も行わない。ここに判定を書くと、カーネルとCLIで
 * 「何が正しい要件定義書か」が二重化する。
 *
 * 終了コードの契約(`validate.ts` と同じ意味で分けている):
 * - 0: 生成できた
 * - 1: 生成に失敗した(アプリが無い、マニフェストが読めない、fail-closed の中止)
 * - 2: 入力が扱えなかった(使い方の誤り・書き出し先に書けない)
 *
 * 出力はすべて標準出力に出す(エラーも含む)。パイプで1本にまとめて読めるようにするため。
 */

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_INPUT_ERROR = 2;

const USAGE = [
  "使い方: bun run requirements-doc --data-root <path> --app <app_id> [--out <file>] [--json <file>]",
  "",
  "  --data-root <path>   データルート(kernel.sqlite と apps/ がある場所)",
  "  --app <app_id>       対象アプリのID",
  "  --out <file>         markdown の書き出し先(省略時は標準出力に出す)",
  "  --json <file>        RequirementsDoc 全体を JSON で書き出す先",
  "",
  "終了コード: 0=生成できた / 1=生成に失敗した / 2=入力エラー",
].join("\n");

/** 入力そのものが扱えなかったことを表す。生成の失敗(exit 1)とは区別する。 */
class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

type Options = { dataRoot: string; app: string; out: string | undefined; json: string | undefined };

/** 値を1つ取るオプションの読み出し。値が無い/次のオプションに食い込む場合は InputError。 */
function takeValue(argv: readonly string[], index: number, name: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new InputError(`${name} の値が指定されていません。`);
  }
  return value;
}

function parseArgs(argv: readonly string[]): Options {
  let dataRoot: string | undefined;
  let app: string | undefined;
  let out: string | undefined;
  let json: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--data-root") {
      dataRoot = takeValue(argv, index + 1, arg);
      index += 1;
      continue;
    }
    if (arg === "--app") {
      app = takeValue(argv, index + 1, arg);
      index += 1;
      continue;
    }
    if (arg === "--out") {
      out = takeValue(argv, index + 1, arg);
      index += 1;
      continue;
    }
    if (arg === "--json") {
      json = takeValue(argv, index + 1, arg);
      index += 1;
      continue;
    }
    throw new InputError(`未知の引数 "${arg}" です。`);
  }

  if (dataRoot === undefined) {
    throw new InputError("--data-root が指定されていません。");
  }
  if (app === undefined) {
    throw new InputError("--app が指定されていません。");
  }
  return { dataRoot, app, out, json };
}

/** ファイルに書く。書けなければ InputError(生成そのものは成功しているため)。 */
function write(file: string, content: string): void {
  try {
    writeFileSync(file, content, "utf-8");
  } catch (cause) {
    throw new InputError(
      `"${file}" に書き出せません(${cause instanceof Error ? cause.message : String(cause)})。`,
    );
  }
}

/**
 * 実処理。出力と終了コードを「返す」だけで、書き出しも終了もしない
 * (`validate.ts` と同じ理由で export しない —— 読み込んだ時点で下部の実行部が走るため)。
 */
function run(argv: readonly string[]): { output: string; code: number } {
  let options: Options | undefined;
  try {
    options = parseArgs(argv);
    const doc = generateRequirementsDoc(options.dataRoot, options.app);

    const written: string[] = [];
    if (options.json !== undefined) {
      write(options.json, `${JSON.stringify(doc, null, 2)}\n`);
      written.push(`JSON: ${options.json}`);
    }
    if (options.out !== undefined) {
      write(options.out, doc.markdown);
      written.push(`markdown: ${options.out}`);
    }
    if (written.length === 0) {
      return { output: doc.markdown, code: EXIT_OK };
    }
    return {
      output: [
        `OK: ${doc.app_id} の要件定義書を生成しました(記述 ${doc.statements.length} 件)。`,
        ...written,
      ].join("\n"),
      code: EXIT_OK,
    };
  } catch (cause) {
    if (cause instanceof InputError) {
      return { output: `NG: ${cause.message}\n${USAGE}`, code: EXIT_INPUT_ERROR };
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      output: `NG: 要件定義書を生成できませんでした(app: ${options?.app ?? "(未指定)"})。\n${message}`,
      code: EXIT_FAILED,
    };
  }
}

const { output, code } = run(Bun.argv.slice(2));
console.log(output);
process.exit(code);
