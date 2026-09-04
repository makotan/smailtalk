/**
 * secret の use-time 解決(V1-M4-T02 / ADR-0020 §2d・§8c-6)。
 *
 * **secret 本体は保管しない。**connection は「取得元への参照」だけを持ち(§2d)、
 * 値は使う瞬間にここで解決する。解決した値は返り値としてだけ存在し、
 * ログ・エラー・保存面のいずれにも残さない(§2d / T4 の漏えい面を作らない)。
 *
 * 取得元は2種:
 * - `env`     … サーバプロセスの環境変数を読む(値 = 変数名)。
 * - `command` … サーバ上でコマンドを実行し stdout を secret とする(値 = 固定コマンド行)。
 *
 * **不変条件(ADR-0020 §8c-6): `resolveSecret` は `source` 以外の引数を一切受け取らない。**
 * これはレコード等の実行時データをコマンドへ差し込む経路を「構造的に」作らないためである。
 * 取得元は connection 作成時に人間(owner)が固定した文字列であり、レコードの内容で
 * コマンドが変わってはならない(さもなくばレコード経由のコマンドインジェクションになる)。
 * この関数にパラメータを足してはならない。
 *
 * この関数内では `console.log` / `console.error` を呼ばない(解決値がログに出る事故を避ける)。
 */

/**
 * secret の取得元。値そのものではなく「どこから取るか」の参照。
 * - `env`     : `value` は環境変数名。
 * - `command` : `value` は実行するコマンド行(固定文字列)。
 */
export type SecretSource = { kind: "env"; value: string } | { kind: "command"; value: string };

/**
 * secret の解決に失敗したときに投げるエラー。
 * **メッセージには解決値(secret になりうる stdout / 環境変数の値)を絶対に含めない。**
 * 参照(変数名)・exit code・stderr は含めてよい。
 */
export class SecretResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretResolutionError";
  }
}

/**
 * 取得元を use-time に解決して secret 値を返す。
 * **引数は `source` のみ**(§8c-6 の不変条件。実行時データを差し込む経路を作らない)。
 */
export async function resolveSecret(source: SecretSource): Promise<string> {
  if (source.kind === "env") {
    return resolveEnv(source.value);
  }
  return resolveCommand(source.value);
}

/** 環境変数を読む。未設定または空文字なら失敗。**値はエラーに含めない**(そもそも値が無い)。 */
function resolveEnv(varName: string): string {
  const value = process.env[varName];
  if (value === undefined || value === "") {
    // 参照(変数名)は含めてよいが、値は出さない(規約。未設定なので値は無い)。
    throw new SecretResolutionError(
      `環境変数 "${varName}" が未設定、または空です。secret の取得元を確認してください。`,
    );
  }
  return value;
}

/**
 * コマンドを実行し stdout を secret として返す。
 * 末尾の改行を1つだけ剥がす(中間の改行は保持)。exit code が 0 以外なら失敗。
 * **失敗時のエラーに stdout(= secret になりうる値)を絶対に含めない**(exit code / stderr は可)。
 */
async function resolveCommand(command: string): Promise<string> {
  const proc = Bun.spawn(["sh", "-c", command], { stdout: "pipe", stderr: "pipe" });
  // stdout と stderr を並行に読み切ってからプロセスの終了を待つ(パイプ詰まり回避)。
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    // stdout は secret になりうるので絶対にメッセージへ入れない。
    // 手がかりとして exit code と stderr(secret ではない)だけを含める。
    throw new SecretResolutionError(
      `secret 取得コマンドが失敗しました(exit code: ${exitCode})。stderr: ${stderr}`,
    );
  }

  // 末尾の改行を1つだけ剥がす(中間の改行は保持)。
  return stdout.replace(/\n$/, "");
}
