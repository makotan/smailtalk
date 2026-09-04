/**
 * MCP サーバの **HTTP エントリポイント**(`V5-M9` / `ADR-0271`〜`ADR-0275`)。
 *
 * **これは `src/mcp/index.ts`(stdio)を置き換えるものではない。** `ADR-0271` 限定2 の
 * とおり `src/mcp/index.ts` は1バイトも変わっていない。**入口が1本増えただけである。**
 * どちらを使うかは起動する側が選ぶ —— **`.mcp.json` の既定は今日も stdio である**
 * (ユーザ決定 `D-V5-92`)。
 *
 * 起動:
 *
 * ```
 * mise exec -- bun run mcp:http
 * ```
 *
 * 環境変数:
 *
 * | 変数 | 既定値 | 意味 |
 * |---|---|---|
 * | `ST_DATA_ROOT` | `data` | データルート。**Webサーバ(`bun run server`)と同じ値**でなければならない |
 * | `ST_PREVIEW_BASE_URL` | `http://127.0.0.1:3000` | `get_preview_url` が返す URL の基底 |
 * | `ST_MCP_HTTP_PORT` | `3100` | リッスンポート。**ホスト名は変えられない**(`127.0.0.1` 固定) |
 * | `ST_MCP_HTTP_EXPECTED_ORIGIN` | `http://127.0.0.1:<port>` | 許可する `Origin`(カンマ区切り) |
 * | `ST_MCP_ACTOR` | (無し) | **この入口がどの利用者として動くか**(ログイン名または利用者ID)。`V8-M31-T02` |
 *
 * **`ST_MCP_ACTOR` を書き忘れても起動する** —— ただし**23本のツールがすべて失敗する**
 * (`D-V8-46`)。**【2026-08-16 訂正(`V8-M13-T04`)。直前の本数を1バイトも消していない】この「23本」は今日は24本である**(`V8-M13-T02` が `read_report` を足した)。
 * **そして書いた場合、その主体の権限は、この口に到達できる誰にでも渡る**
 * (この入口に認証は無い。下の「この入口に**無い**もの」を参照)。
 *
 * ## この入口に**無い**もの(誇張しない)
 *
 * - **認証は無い。** ユーザ決定 `D-V5-9` により認証層を作らない。`ADR-0005:157`
 *   逐語「- **認証**: 無い。」は、この入口ができた後も真である。
 * - **`Origin` の照合は認証の代わりにならない。** ブラウザ以外のクライアントは
 *   好きな `Origin` を名乗れる。
 * - **残る境界はループバックのバインド1本と `Origin` の照合だけである。**
 *
 * ## stdout への書き込みを、HTTP でも禁じる(**決めたことを書く**)
 *
 * stdio の入口では stdout は JSON-RPC のフレームそのものであり、汚すとプロトコルが
 * 壊れた(`src/mcp/index.ts:7`)。**HTTP ではその理由は消える。** それでも
 * **この入口も stderr だけを使う。** 理由は (a) 同じリポジトリで入口ごとにログの
 * 出し先が違うと運用時に読み分けが要る、(b) 将来 stdio と HTTP を同じスーパバイザ
 * から起動したときに出し分けが要る、の2つである。**「不要になったから外す」を
 * 黙ってやらない**(`docs/plan/v5/02-mcp-transport-baseline.md` §6-1 の 5)。
 */

import { ensureIslandRuntimeReady, recover } from "../kernel/index.ts";
import { loadMcpHttpConfig, startMcpHttpServer } from "./http-transport.ts";

const config = loadMcpHttpConfig(process.env);

// --- 起動時の整合性チェック --------------------------------------------------
//
// **常駐プロセスになっても、判断する場所は変えない。** stdio の入口
// (`src/mcp/index.ts:42-60`)と同じく、**サーバを立てる前に1回だけ**行う。
// 「接続のたびに判断する」形は採らない —— 復旧は `ST_DATA_ROOT` 全体に対する
// 操作であり、接続ごとに走らせると、繋いだ順で結果が変わる。
//
// **失敗したら起動しない。** 「壊れたまま静かに起動する」は憲法6 に正面から反する。
try {
  for (const outcome of recover(config.dataRoot)) {
    if (outcome.status === "clean") {
      continue;
    }
    console.error(
      `[smailtalk mcp/http] 未完了の適用を処理しました: app=${outcome.app_id} ` +
        `diff_id=${outcome.diff_id} 結果=${outcome.status}` +
        (outcome.snapshot === undefined ? "" : ` 復元元=${outcome.snapshot}`),
    );
  }
} catch (error) {
  console.error(
    `[smailtalk mcp/http] 起動時の整合性チェックに失敗したため起動を中止します ` +
      `(ST_DATA_ROOT=${config.dataRoot})。未完了の適用が残っている可能性があります。`,
  );
  console.error(error);
  process.exit(1);
}

// --- 島ランタイムの事前ロード -------------------------------------------------
//
// stdio の入口(`src/mcp/index.ts:69-77`)と同じ扱いである。**失敗しても起動は止めない。**
try {
  await ensureIslandRuntimeReady();
} catch (error) {
  console.error(
    `[smailtalk mcp/http] 島ランタイム(QuickJS-WASM)の事前ロードに失敗しました。` +
      `**run_function を含むワークフローは実行時に fail-closed します**(MCP 自体は動き続けます)。`,
  );
  console.error(error);
}

// **期待オリジンを環境変数で指定していないときは、渡さない。**
// ポートに `0` を渡すと実ポートはバインドの後まで決まらないので、
// `startMcpHttpServer` に実ポートで組み立て直させる(`McpHttpConfig.expectedOriginsFromEnv`)。
const running = await startMcpHttpServer({
  dataRoot: config.dataRoot,
  previewBaseUrl: config.previewBaseUrl,
  port: config.port,
  expectedOrigins: config.expectedOriginsFromEnv ? config.expectedOrigins : undefined,
  actor: config.actor,
});

// ログは stderr のみ(モジュール冒頭の理由)。
// **名乗りの有無をこの行に足した**(`V8-M31-T02`)—— 名乗り無しでも起動するので、
// **この行を読む以外に、起動した人が書き忘れに気付く手段が無い。**
console.error(
  `[smailtalk mcp/http] HTTP で待機中 (url=${running.url}, ` +
    `ST_DATA_ROOT=${config.dataRoot}, ST_PREVIEW_BASE_URL=${config.previewBaseUrl}, ` +
    `期待オリジン=${running.expectedOrigins.join(" ")}, ` +
    `ST_MCP_ACTOR=${config.actor ?? "(未設定)"})`,
);
console.error(
  `[smailtalk mcp/http] **この入口に認証はありません**(D-V5-9)。` +
    `境界はループバックのバインドと Origin の照合だけです。`,
);
if (config.actor === undefined) {
  console.error(
    `[smailtalk mcp/http] **ST_MCP_ACTOR を指定していないため、23本のツールはすべて失敗します**(D-V8-46)。` +
      // **【`V8-M13-T04`。台帳 `Q-G30`】** **直前の本数は今日は偽である**
      // (`V8-M13-T02` が `read_report` を足した)。**旧文を1バイトも消していない。**
      `(直前の「23本」は今日は24本です)。` +
      // **【`V10-M12-T01`。台帳 `CM-G7` / `ADR-0368`】** **直前の本数も今日は偽である**
      // (`V10-M12-T01` が `list_comments` を足した)。**旧文を1バイトも消していない。**
      `(直前の「24本」は今日は25本です)。` +
      // **【`V10-M30-T02`。台帳 `CM-G37` / `ADR-0378`】** **直前の本数も今日は偽である**
      // (`V10-M30-T02` が `set_comment_visibility` を足した)。**旧文を1バイトも消していない。**
      `(直前の「25本」は今日は26本です)。`,
  );
} else {
  // **名乗った主体の権限は、この口に到達できる誰にでも渡る**(`T-G21b` と `ADR-0271` の合成)。
  // **黙って渡さない** —— 起動した人がその範囲を知ったうえで選べるように、名指しで書く。
  console.error(
    `[smailtalk mcp/http] **この口に繋いだ相手は、すべて "${config.actor}" として動きます**` +
      `(認証が無いので、名乗った主体の権限はこの口に到達できる誰にでも渡ります)。`,
  );
}
