/**
 * 起動ログの後ろに出す「ブラウザで開くアドレス」の案内(2026-09-06)。
 *
 * ## なぜ足したのか(実測である)
 *
 * 起動ログは `smailtalk server: http://127.0.0.1:3000 (...)` と出る。
 * **この URL をそのまま開くと、画面は出るのに保存だけが 403 で断られる。**
 * 許す origin は既定で `http://localhost:3000` / `http://localhost:5173` であり、
 * `http://127.0.0.1:3000` はどちらとも完全一致しないからである
 * (`src/server/app.ts` の `origin !== undefined && !authConfig.expectedOrigins.includes(origin)`)。
 * **`ST_AUTH_EXPECTED_ORIGIN` に `http://127.0.0.1:3000` を書いて逃げることもできない** ——
 * rpID(既定 `localhost`)が `127.0.0.1` の登録可能サフィックスでないので、
 * `validateAuthConfig` がリッスン前に `process.exit(1)` する。
 * **したがって「localhost で開いてください」と書くしかない。**
 *
 * ## 純関数に切り出してある理由
 *
 * `src/server/index.ts` はトップレベルで `Bun.serve` まで走るので、
 * 文言だけを検査できない(子プロセスを起こすしかない)。
 * **文言を作るのはこの純関数で、`index.ts` は返った文字列を出すだけにしてある。**
 *
 * ## 足す行が守らなければならない2つの制約(**検査で固定してある**)
 *
 * 1. **`smailtalk server:` という綴りを1文字も含めない。**
 *    `src/server/index.test.ts` が「起動しなかったこと」を
 *    `expect(started.stdout).not.toContain("smailtalk server:")` で見ている。
 * 2. **`/smailtalk server: http:\/\/([^:\s]+):(\d+)/` に当たらない。**
 *    この正本には、起動ログのその1行から待ち受けた番号を読む別の単位の台が在る
 *    (**その単位の名前をここに写していない** —— 公開する単位の中に隣の単位の綴りが
 *    1件も無いことを見張る検査が `tools/` に在り、写すと赤くなる)。
 *    先に当たる行を足すと、**あの台が別のポートに繋ぎに行く。**
 *
 * 警告の接頭辞 `[smailtalk server] ` は既存の警告(`index.ts` の `ST_BIND_HOST` の
 * 取りこぼしなど)に倣った。**角括弧なので、上の2つのどちらにも当たらない。**
 */

/** {@link startupNoticeLines} の入力。 */
export type StartupNoticeInput = {
  /** 実際に待ち受けた番号(**焼き込まない**。`Bun.serve` が返した値を渡す)。 */
  port: number;
  /** 許可している出所(`AuthConfig.expectedOrigins`)。 */
  expectedOrigins: readonly string[];
};

/** {@link startupNoticeLines} の出力。`warning` は出す必要が無ければ `undefined`。 */
export type StartupNotice = {
  /** **常に出す1行**(stdout)。ブラウザで開くアドレス。 */
  info: string;
  /** 開くアドレスが許可されていないときだけ出す1行(stderr)。 */
  warning: string | undefined;
};

/**
 * 起動ログの後ろに出す文言を組み立てる。**副作用は1つも無い**(出力はしない)。
 */
export function startupNoticeLines(input: StartupNoticeInput): StartupNotice {
  const browserUrl = `http://localhost:${String(input.port)}`;
  const info =
    `ブラウザで開くアドレス: ${browserUrl} ` +
    `(127.0.0.1 でも画面は出ますが、そちらでは保存できません —— localhost で開いてください)`;

  if (input.expectedOrigins.includes(browserUrl)) {
    return { info, warning: undefined };
  }

  const allowed =
    input.expectedOrigins.length === 0 ? "(1つも無い)" : input.expectedOrigins.join(", ");
  const warning =
    `[smailtalk server] ${browserUrl} は、書き込みを許可している出所に入っていません` +
    `(許可しているのは ${allowed})。この画面から保存すると 403 で断られます。` +
    `環境変数 ST_AUTH_EXPECTED_ORIGIN に ${browserUrl} を渡してサーバを起動し直してください。`;

  return { info, warning };
}
