/**
 * MCP サーバの stdio エントリポイント(V0-P5-T01 / ADR-0005)。
 *
 * Claude Code(や MCP Inspector)がこのプロセスを子プロセスとして起動し、
 * **stdin / stdout で JSON-RPC を流す**。したがって:
 *
 * **stdout へ書き込んではならない。** `console.log` を1回でも呼ぶと JSON-RPC の
 * フレームに異物が混ざり、クライアント側は「壊れたメッセージ」としてしか
 * 観測できない(接続が切れるか、無言で応答が来なくなる)。診断しにくい壊れ方の
 * 代表格なので、**ログは必ず `console.error`(stderr)** を使う。stderr は
 * MCP クライアントがログとして拾ってくれる。
 *
 * 環境変数(`.mcp.json` の `env` で渡す):
 *
 * | 変数 | 既定値 | 意味 |
 * |---|---|---|
 * | `ST_DATA_ROOT` | `data` | データルート。**Webサーバ(`bun run server`)と同じ値**でなければならない |
 * | `ST_PREVIEW_BASE_URL` | `http://localhost:3000` | `get_preview_url` が返す URL の基底。Webサーバのリッスン先と揃える |
 * | `ST_MCP_ACTOR` | (無し) | **このサーバがどの利用者として動くか**(ログイン名または利用者ID)。`V8-M31-T02` |
 *
 * **`ST_MCP_ACTOR` を書き忘れても起動する** —— ただし**23本のツールがすべて失敗する**
 * (ユーザ決定 `D-V8-46` の逐語「指定を忘れると**何もできない状態で立ち上がります**」)。
 * **【2026-08-16 訂正(`V8-M13-T04`)。直前の本数を1バイトも消していない】この「23本」は今日は24本である**(`V8-M13-T02` が `read_report` を足した)。
 * **起動ログに名乗りの有無を出す**のは、書き忘れにこの時点で気付けるようにするためである。
 *
 * 別プロセス構成と `ST_DATA_ROOT` 共有の根拠、および同じ SQLite を2プロセスが
 * 触ることの制約は ADR-0005 §3 / リスク節に記す。
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ensureIslandRuntimeReady, recover } from "../kernel/index.ts";
import { normalizeActor } from "./actor-guard.ts";
import { createMcpServer } from "./server.ts";

const dataRoot = process.env.ST_DATA_ROOT ?? "data";
// **既定は `localhost` である**(2026-09-06。着手前は `http://127.0.0.1:3000` だった)。
// `get_preview_url` が返した URL を人がそのまま開くと、**画面は出るのに保存だけが 403** に
// なっていた —— 書き込みを許す origin の既定に `127.0.0.1` は1本も無く、
// `ST_AUTH_EXPECTED_ORIGIN` に書いて逃げることもできない(rpID の検査が起動を止める)。
const previewBaseUrl = process.env.ST_PREVIEW_BASE_URL ?? "http://localhost:3000";
// **名乗りを読むのは、stdio ではこの1行だけである**(裁定 `M31-1`)。
// **既定値を持たない** —— 「誰も指定しなかったときの既定の主体」を置くと、それが事実上の
// 全権になる。**空白だけの指定も「名乗り無し」に倒す**(`normalizeActor`)。
const actor = normalizeActor(process.env.ST_MCP_ACTOR);

// --- 起動時の整合性チェック(V1-M1-T04)-------------------------------------
//
// **サーバを組み立てる前に行う。** 未完了の適用が残っているデータルートの上で
// ツールを受け付けると、AI は「マニフェストは適用済み、履歴には無い」状態を
// 正しい現状として読むことになる(憲法5 が壊れた状態を正常として扱う)。
//
// **正常時は1バイトも書かない**(`recovery.ts`)。マーカーが無ければファイルを
// 1つも開かず、`kernel.sqlite` にも接続しない。したがってこの呼び出しは
// 起動を新しい故障点にしない。
//
// **失敗したら起動しない。** 「壊れたまま静かに起動する」は憲法6 に正面から反する。
// ここで握り潰すと、復旧できなかったことを誰も知らないまま AI が変更を積み始める。
try {
  for (const outcome of recover(dataRoot)) {
    if (outcome.status === "clean") {
      continue;
    }
    console.error(
      `[smailtalk mcp] 未完了の適用を処理しました: app=${outcome.app_id} ` +
        `diff_id=${outcome.diff_id} 結果=${outcome.status}` +
        (outcome.snapshot === undefined ? "" : ` 復元元=${outcome.snapshot}`),
    );
  }
} catch (error) {
  console.error(
    `[smailtalk mcp] 起動時の整合性チェックに失敗したため起動を中止します ` +
      `(ST_DATA_ROOT=${dataRoot})。未完了の適用が残っている可能性があります。`,
  );
  console.error(error);
  process.exit(1);
}

// --- 島ランタイムの事前ロード(V1-M6-T05 第2段)-------------------------------
//
// `run_function` を含むワークフローは `apply_diff` 後のレコード書込(`createRecord` /
// `updateRecord`)の**同期**発火の中で島を走らせる。同期経路の `getQuickJSSync()` は
// `getQuickJS()` を事前に解決していないと throw するので、**ツールを受け付ける前にここで
// 1度ロードしておく**(未ロードなら run_function は fail-closed する)。`getQuickJS()` は
// 共有インスタンスをキャッシュするので冪等。**失敗しても起動は止めない**。
try {
  await ensureIslandRuntimeReady();
} catch (error) {
  console.error(
    `[smailtalk mcp] 島ランタイム(QuickJS-WASM)の事前ロードに失敗しました。` +
      `**run_function を含むワークフローは実行時に fail-closed します**(MCP 自体は動き続けます)。`,
  );
  console.error(error);
}

const server = createMcpServer({ dataRoot, previewBaseUrl, actor });
const transport = new StdioServerTransport();

await server.connect(transport);

// 起動ログは stderr のみ。ここを console.log にすると即座にプロトコルが壊れる。
// **名乗りの有無をここに出す**(`V8-M31-T02`)—— 名乗り無しでも起動するので、
// **この行を読む以外に、起動した人が書き忘れに気付く手段が無い。**
console.error(
  `[smailtalk mcp] stdio で待機中 (ST_DATA_ROOT=${dataRoot}, ST_PREVIEW_BASE_URL=${previewBaseUrl}, ` +
    `ST_MCP_ACTOR=${actor ?? "(未設定)"})`,
);
if (actor === undefined) {
  console.error(
    `[smailtalk mcp] **ST_MCP_ACTOR を指定していないため、23本のツールはすべて失敗します**(D-V8-46)。` +
      `そのアプリに登録済みの利用者のログイン名または利用者IDを指定して起動し直してください。` +
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
}
