/**
 * 観測されたファイル変化を、transcript 上のツール呼び出しに突き合わせる(judge の中核)。
 *
 * 「ツール使用回数が0件だった」だけでは、別ターミナルで `sqlite3` を叩かれた場合を見抜けない。
 * ここでは逆向きに見る ―― **実際に起きた変化のほうを起点にして、それを説明できる
 * MCP ツール呼び出しが transcript にあるか**を問う。説明できない変化が1件でもあれば検証無効。
 *
 * 対応付けの根拠は ADR-0002 のストレージレイアウト(src/kernel/storage-paths.ts):
 *
 * ```
 * <dataRoot>/kernel.sqlite            … アプリ台帳 + changelog
 * <dataRoot>/apps/<app_id>/manifest.json … 現行マニフェスト
 * <dataRoot>/apps/<app_id>/app.sqlite    … ユーザデータ
 * <dataRoot>/apps/<app_id>/snapshots/... … apply 前のコピー
 * ```
 *
 * **説明の強さは一様ではない**。ここは正直に分けている。
 *
 * - `manifest.json` と `snapshots/` は、書き込み系ツール(`create_app` / `apply_diff` / `undo`)
 *   でしか動かない。したがって「そのアプリへの成功した書き込み呼び出し」を要求できる(強い説明)。
 * - `*.sqlite` とその `-wal` / `-shm` は、**参照系ツールでも動く**。SQLite は読むだけで
 *   ファイルを作り、WAL を書くからである。実際 `list_apps` を1回呼んだだけで
 *   `kernel.sqlite` / `-wal` / `-shm` の3つが生成される。ここで書き込み呼び出しを要求すると
 *   常に偽陽性になるので、「そのアプリ(またはカーネル)に触れた成功した呼び出し」まで緩める
 *   (弱い説明)。弱い説明しか付かない変化は judge が警告として列挙する。
 *
 * この緩和は限界でもある。**SQLite ファイルの中身を人間が別経路で書き換えた場合、
 * 参照系の呼び出しが1つでもあれば「説明できた」ことになってしまう。** 強い保証があるのは
 * マニフェストとスナップショットの層だけである(README の「限界」参照)。
 */
import type { FileChange } from "./snapshot.ts";
import { mcpToolSuffix, WRITE_TOOLS } from "./transcript.ts";
import type { ChangeAttribution, ToolCall } from "./types.ts";

/**
 * `manifest.json`(現行 / スナップショット)を実際に書くツール(V1-M1-T08。申し送り5)。
 *
 * `WRITE_TOOLS` と同じく**事実の列挙**である —— 辞書ヒューリスティックではない。
 * マニフェストを作る・書き換える経路は `create_app`(初期マニフェストの作成)、
 * `apply_diff`(差分適用とスナップショット退避)、`undo`(スナップショットからの巻き戻し)
 * の3つだけである。
 *
 * **なぜ分けるか**: `v1-m0-t01-retrial.md` §10-2 が代償として申告したとおり、
 * `WRITE_TOOLS` に `update_record` / `delete_record` が加わったことで、
 * **マニフェストを1バイトも変えない呼び出しが `manifest.json` の説明候補に並ぶ**ようになった。
 * これは `unexplained_change` を**弱くする**向きの誤りである。
 */
export const MANIFEST_WRITE_TOOLS = [
  "mcp__smailtalk__create_app",
  "mcp__smailtalk__apply_diff",
  "mcp__smailtalk__undo",
  // V1-M9-T05(ADR-0032)。redo はスナップショットから manifest.json を書き戻す =
  // マニフェスト層の変化を説明できるツールなので MANIFEST_WRITE_TOOLS 側(undo と同型)。
  "mcp__smailtalk__redo",
  // V1-M9-T09(ADR-0031)。アプリ削除は `apps/<app_id>/` を丸ごと消す = manifest.json /
  // snapshots を**削除する**。したがってマニフェスト層の変化(削除)を説明できるツールであり、
  // MANIFEST_WRITE_TOOLS 側に分類する(削除された manifest.json を delete_app が説明する)。
  "mcp__smailtalk__delete_app",
] as const;

/**
 * レコード層(`*.sqlite`)しか書かないツール。
 *
 * `MANIFEST_WRITE_TOOLS` との2つで `WRITE_TOOLS` を尽くす。
 * **尽くしていることを `attribution.test.ts` が検査する** —— ツールが1つ増えたら、
 * それがマニフェストを書くのかどうかを決めるまでテストが落ちる。
 * 決めないまま既定で「書ける」側に落ちる、という沈黙による緩みを塞ぐためである。
 */
export const RECORD_WRITE_TOOLS = [
  "mcp__smailtalk__insert_sample_data",
  "mcp__smailtalk__update_record",
  "mcp__smailtalk__delete_record",
  // V2-M4-T01(ADR-0039)。複数レコードの原子書込(バッチ)。app.sqlite にレコードを書くが
  // manifest.json は1バイトも変えない(op は create/update のデータ書込のみ)= RECORD_WRITE_TOOLS 側。
  "mcp__smailtalk__write_records",
  // V1-M4-T04(ADR-0020 §2b)。接続の**申請**は kernel.sqlite(connection_requests)にだけ
  // 書き、manifest.json は1バイトも変えない。したがってマニフェスト層を説明できるツールでは
  // ない = RECORD_WRITE_TOOLS 側に分類する(名は「RECORD」だが、この集合の運用上の定義は
  // 「WRITE_TOOLS のうち manifest.json を書かないもの」であり、申請はそれに当たる)。
  "mcp__smailtalk__request_connection",
  // V1-M5-T04(ADR-0021 §2b)。AI capability の**申請**も kernel.sqlite(ai_requests)にだけ
  // 書き、manifest.json は1バイトも変えない。request_connection と同型で RECORD_WRITE_TOOLS 側。
  "mcp__smailtalk__request_ai_capability",
  // V2-M5-T01(ADR-0041 限定1)。受信口の**申請**も kernel.sqlite(inbound_endpoint_requests)にだけ
  // 書き、manifest.json は1バイトも変えない。request_connection の鏡写しで RECORD_WRITE_TOOLS 側。
  "mcp__smailtalk__request_inbound_endpoint",
  // V3-M5-T01(ADR-0055 限定5)。逃げ道(任意 CSS)の**申請**も kernel.sqlite
  // (escape_hatch_asset_requests)にだけ書き、manifest.json は1バイトも変えない
  // (**CSS の本文も1バイトも書かない** —— 本文を置くのは owner の HTTP だけ)。
  // request_connection と同型で RECORD_WRITE_TOOLS 側。
  "mcp__smailtalk__request_custom_css",
  // V10-M30-T02(ADR-0378 限定6)。コメントの出し入れの切り替えは kernel.sqlite の `apps` 表の
  // 列2本を UPDATE するだけで、manifest.json もスナップショットも1バイトも変えない
  // (`apply_diff` の18種目にしていないので、マニフェスト層には1つも現れない)。
  // **この集合の運用上の定義は「WRITE_TOOLS のうち manifest.json を書かないもの」**であり、
  // 切り替えはそれに当たる = RECORD_WRITE_TOOLS 側(名は「RECORD」だが、申請3本と同じ扱い)。
  "mcp__smailtalk__set_comment_visibility",
] as const;

/** 変化したパスがどのスコープに属するか。 */
export function attributeScope(path: string): { scope: string; appId?: string } {
  if (path === "kernel.sqlite" || path.startsWith("kernel.sqlite-")) {
    return { scope: "kernel" };
  }
  const app = /^apps\/([^/]+)\/.+/.exec(path);
  const appId = app?.[1];
  if (appId !== undefined) return { scope: `app:${appId}`, appId };
  return { scope: "unknown" };
}

/**
 * そのパスを説明するのに書き込み系ツールを要求できるか。
 * SQLite の実体ファイルは参照系でも動くので要求できない。
 */
export function requiresWriteCall(path: string): boolean {
  return !/\.sqlite(-wal|-shm)?$/.test(path);
}

/**
 * 各変化を説明できる呼び出しを列挙する。
 *
 * @param changes 実行前後のスナップショット差分
 * @param calls **成功した** smailtalk MCP ツールの呼び出し(参照系を含む)
 */
export function explainChanges(changes: FileChange[], calls: ToolCall[]): ChangeAttribution[] {
  const writeSuffixes = new Set(WRITE_TOOLS.map((t) => mcpToolSuffix(t)));
  // 書き込み呼び出しを要求できるパス(= マニフェスト層)については、
  // **実際にマニフェストを書けるツール**まで絞る(V1-M1-T08。申し送り5)。
  const manifestWriteSuffixes = new Set(MANIFEST_WRITE_TOOLS.map((t) => mcpToolSuffix(t)));
  return changes.map((change) => {
    const { scope, appId } = attributeScope(change.path);
    const needsWrite = requiresWriteCall(change.path);
    const matched = calls.filter((call) => {
      const suffix = mcpToolSuffix(call.name);
      if (suffix === undefined) return false;
      if (needsWrite && !manifestWriteSuffixes.has(suffix)) return false;
      if (scope === "kernel") return true;
      if (appId !== undefined) return appIdOf(call) === appId;
      // レイアウトに無いパスは、どんな呼び出しでも説明できない。
      return false;
    });
    return {
      path: change.path,
      kind: change.kind,
      scope,
      explainedBy: matched.map(
        (call) => `${call.name}(app_id=${appIdOf(call) ?? "-"})#${call.toolUseId}`,
      ),
      // 書き込み呼び出しを要求できなかった説明は弱い。judge が警告として出す。
      weak:
        !needsWrite &&
        matched.length > 0 &&
        !matched.some((call) => writeSuffixes.has(mcpToolSuffix(call.name))),
    };
  });
}

function appIdOf(call: ToolCall): string | undefined {
  const value = call.input.app_id;
  return typeof value === "string" ? value : undefined;
}
