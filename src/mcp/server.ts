/**
 * MCP サーバ本体(V0-P5-T01 / ADR-0005)。
 *
 * この層の責務は **「MCP ツール呼び出し ⇄ カーネル内部API の変換」だけ**である。
 * `src/server/app.ts` が HTTP に対して負っているのと同じ責務を、MCP という別の
 * 入口に対して負う。ADR-0003 §7 の境界(バリデーション・参照整合性・DDL・
 * エラー文面はすべて `src/kernel/` にあり、入口層には1行も置かない)は
 * MCP にもそのまま適用される。むしろ ADR-0003 §7 が「その処理は MCP サーバにも
 * 必要か? 必要ならカーネルに置く」を判定基準として掲げていたので、ここは
 * その基準が実際に守られていたかの答え合わせの場になる。
 *
 * T01 の時点ではツールを1つも登録していなかった(骨格が MCP プロトコルとして
 * 成立していることを先に確定させるため)。T02 で参照系6ツールを登録し、
 * 更新系4ツールは T03 で加わる。
 *
 * データルートとプレビュー基底URLは必ず引数で受け取る。`createServerApp({ dataRoot })`
 * と同じく、グローバル状態も固定パスも持たない(テストが実 `data/` を汚さないため)。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerReadTools } from "./tools/read.ts";
import { registerWriteTools } from "./tools/write.ts";
import { CANNOT_DO_INDEX, DESTRUCTIVE_CHANGE_FLOW, VOCABULARY_ENTRY_POINT } from "./vocabulary.ts";

/**
 * MCP クライアント(Claude Code / MCP Inspector)に名乗るサーバ名。
 * `.mcp.json` の `mcpServers` のキーと揃えてある。
 */
export const MCP_SERVER_NAME = "smailtalk";

/**
 * サーバのバージョン。`package.json` の `version` は `0.0.0` のまま private 運用
 * なので、そこから読むと「常に 0.0.0」という無意味な値を JSON 読み込みのコスト付きで
 * 名乗ることになる。ここに定数として持ち、MCP として意味のある単位(= 公開ツールの
 * 集合が変わったとき)で上げる。
 */
export const MCP_SERVER_VERSION = "0.1.0";

export type CreateMcpServerOptions = {
  /** データルート(`data/` 相当)。`kernel.sqlite` と `apps/<app_id>/` がこの下にある。 */
  dataRoot: string;
  /**
   * `get_preview_url`(T02)が返す URL の基底。Webサーバ(`bun run server`)の
   * リッスンアドレスと一致している必要がある。MCP サーバは別プロセスなので、
   * **Webサーバが実際に起動しているかを知る手段を持たない**(ADR-0005 §3)。
   * ここが食い違うと「開けない URL」を返すことになるため、環境変数で明示的に
   * 揃える設計にしてある。
   */
  previewBaseUrl: string;
  /**
   * **このサーバが、どの利用者として動くのか**(`V8-M31-T02`。台帳 `T-G21a` / `T-G21b`)。
   *
   * 起動する側が環境変数 `ST_MCP_ACTOR` で決める(**読むのは `src/mcp/index.ts` と
   * `loadMcpHttpConfig` の2箇所だけ**。裁定 `M31-1`)。**ツールは `process.env` を読まず、
   * この `options` から受け取る** —— 環境変数で運ぶと、同一プロセスの中で複数の主体を
   * 使う検査が1本も書けない。
   *
   * **省略・空文字・空白だけは「名乗り無し」である。** そのとき**起動は成功し、23本の
   * ツールがすべて `isError` を返す**(ユーザ決定 `D-V8-46` の逐語「指定を忘れると
   * **何もできない状態で立ち上がります**」)。
   * **【2026-08-16 訂正(`V8-M13-T04`)。直前の本数を1バイトも消していない】この「23本」は今日は24本である**(`V8-M13-T02` が `read_report` を足した)。
   * **【2026-08-24 訂正(`V10-M12-T01`。`ADR-0368`)。直前の1行を1バイトも消していない】直前の「24本」は今日は25本である**(`V10-M12-T01` が `list_comments` を足した)。
   * **【2026-08-26 訂正(`V10-M34-T01`。台帳 `CM-G45` / `ADR-0379`)。直前の1行を1バイトも消していない】直前の「25本」は今日は26本である**(`V10-M30-T02` が `set_comment_visibility` を足した)。
   *
   * **値は「ログイン名」でも「利用者ID」でもよい**(`D-V8-83`。両方に一致するときは
   * **ID優先**)。**名乗りに証明は要らない**(`D-V8-54`)—— **起動できる人は誰の名前でも
   * 書ける。認可であって認証ではない。**
   */
  actor?: string | undefined;
};

/**
 * MCP サーバを1つ作って返す(トランスポートへの接続は呼び出し側の責務)。
 *
 * トランスポートを引数に取らないのは、in-process テスト(`InMemoryTransport`)と
 * 本番の stdio(`StdioServerTransport`)で**同じサーバ生成コードを共有する**ため。
 * `src/mcp/index.ts` は stdio を繋ぐだけの薄いエントリポイントになる。
 */
export function createMcpServer(options: CreateMcpServerOptions): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    {
      capabilities: { tools: {} },
      // v0 の語彙の外に出ないこと、範囲外の要求は正直に断ることを、
      // ツール説明文とは別にサーバ全体の指示としても置く。
      //
      // T01 ではここに語彙(リソース5種・型7種…)を**手書きで**書いていた。
      // T04 で `vocabulary.ts` の3定数に差し替えている。手書きのままだと、
      // カーネルの語彙が増減したときに instructions だけが古い語彙を主張し、
      // 「サーバの指示とツール説明文が食い違う」という最悪の状態になるため。
      // 語彙の真実は `src/kernel/types.ts` の配列ただ1つで、instructions も
      // 各ツールの description もそこから派生する。
      //
      // V1-M1-T06 で `DESTRUCTIVE_CHANGE_FLOW` を4つ目として足した。破壊的 op が
      // 語彙に入った以上、**手順はツール単位ではなくセッション単位の知識である** ——
      // apply_diff の description を読む時点では、AI は既に「何をするか」を決めている。
      // instructions はセッション開始時に必ず渡るので、決める前に読まれる。
      //
      // ## `V6-M12-T03`(`H-G12` / `ADR-0287`)で、残すものを4つに絞った
      //
      // **2026-08-07 まで、ここには `VOCABULARY_SCOPE` / `CANNOT_DO` /
      // `OUT_OF_SCOPE_BEHAVIOR` の全文(41,679文字)が載っていた。**
      // **`H-G12` の限定1 が残すものを4つに固定したので、その4つだけを置く**:
      //
      // 1. **サーバの名乗り1文**(この行は1バイトも変えていない)
      // 2. **語彙の入口**(`VOCABULARY_ENTRY_POINT`。リソース種・フィールド型・差分操作の
      //    **名前の一覧**。件数の数値リテラルを1つも書かず、カーネルの3配列から組み立てる)
      // 3. **できないことの見出しだけ**(`CANNOT_DO_INDEX`。本文は `apply_diff` の
      //    ツール説明と説明書(skill)に在り、**そう明記してある**)
      // 4. **`DESTRUCTIVE_CHANGE_FLOW` 全文**(**1文字も外していない**。上のコメントが
      //    述べた理由 —— 「決める前に読まれる」 —— が今日も成り立つためで、
      //    `H-G11` の審査 `S3` の 4 がこれを不利な材料として名指ししている)
      //
      // **【外したものは戻ってこない】** `instructions` はセッション開始時に1回渡るだけで、
      // ここから外した文を AI が読むには **`apply_diff` の説明を開くか、説明書(skill)を
      // 開くかのどちらかが要る。** **説明書を開けないクライアントで何が失われるかは
      // `V6-M12-T04`(`H-G13`)が1件ずつ数えた**(`docs/plan/v6/records/v6-m12.md` §6)。
      instructions: [
        "SmAIltalk(スマイルトーク)のカーネルを操作する MCP サーバです。",
        VOCABULARY_ENTRY_POINT,
        CANNOT_DO_INDEX,
        DESTRUCTIVE_CHANGE_FLOW,
      ].join("\n"),
    },
  );

  // 参照系6ツール(V0-P5-T02)。更新系4ツールは T03 でここに加わる。
  //
  // T01 にあった `ensureToolsListable()`(`__bootstrap__` ダミーツールを登録して
  // 即 `remove()` する回避策)は**削除した**。あれが必要だったのは、`McpServer` が
  // `tools/list` のリクエストハンドラを**最初の `registerTool` のときに初めて登録する**
  // ため、ツール0個のサーバに `tools/list` を投げると `-32601 Method not found` に
  // なったからである。実ツールを登録する今はその条件が消えており、回避策を残すと
  // 「なぜこれがあるのか」が分からないコードだけが残る。`tools/list` が引き続き
  // 応答することは `server.test.ts` / `tools/read.test.ts` の両方で確認している。
  registerReadTools(server, options);
  // 更新系4ツール(V0-P5-T03)。参照系のあとに登録するのは `tools/list` の並び順を
  // 「まず現状を読む道具、次に変える道具」にするためで、機能上の依存は無い。
  registerWriteTools(server, options);

  return server;
}
