/**
 * stream-json の生ログを解析する純関数群。
 *
 * ここは **judge の目**にあたる。実際に `claude` を起動しなくても、
 * 保存済みの生ログ(または fixture)だけで全部テストできるようにしてある。
 *
 * 読み取る対象は Claude Code の `--output-format stream-json --verbose` が出す JSONL:
 * - `{"type":"system","subtype":"init","tools":[...],"mcp_servers":[...]}` … 1回の起動につき1つ
 * - `{"type":"assistant","message":{"content":[{"type":"tool_use",...}|{"type":"text",...}]}}`
 * - `{"type":"user","message":{"content":[{"type":"tool_result","is_error":true,...}]}}`
 * - `{"type":"result","subtype":"success","result":"..."}` … ターンの最終応答
 *
 * ターン番号は `system/init` の出現回数で決める。`claude -p` は1ターン=1プロセスなので、
 * **init が増えた = 人間が何か打った**という対応が機械的に取れる。
 */
import type {
  ErrorEpisode,
  InitEvent,
  ParsedTranscript,
  RefusalFinding,
  RefusalKind,
  RefusalStatement,
  RetryEpisode,
  ToolCall,
  ToolResult,
} from "./types.ts";

/**
 * ============================================================================
 * 断りの抽出方式(V1-M0-T06 (a)。F-27 への対処)
 * ============================================================================
 *
 * **旧方式**: `REFUSAL_PHRASES`(「できません」「変えられません」「作れません」…)の
 * 部分文字列一致。これは v0 で最も深刻な事象(F-37「私からは直せません」)を落とし、
 * さらに 006/T2(本文に判定語が1つも現れない差し戻し)も落とした。
 *
 * **F-27 は「辞書に語を足す」を明示的に禁じている。**「直せません」を辞書に足しても、
 * 006/T2 は本文に語が無いので拾えないままであり、同じ失敗を繰り返す。
 *
 * **新方式: ターン単位の証跡照合(turn-level evidence reconciliation)。**
 * 判定単位を「assistant テキスト1本」から「ターン」に上げ、次の3つの独立した入力を組にする。
 *
 * 1. **人間が何を頼んだか**(`meta.turns`。judge が渡す)
 * 2. **AI がそのターンで何を呼び、何が返ったか**(ツール呼び出しの有無・書き込みの成否・エラー数)
 * 3. **AI が何と言ったか**(応答本文。ただし**語の一致だけでは断りと断定しない**)
 *
 * 判定は2経路ある。**どちらも単独の語一致では成立しない。**
 *
 * - `capability_denial`: 「可能・能力の否定」の**語尾の形態**(語彙ではなく活用形。`直せません` は
 *   `せません`、`変えられません` は `られません` で拾える)に一致し、**かつ**その文が
 *   「誰の・何の限界か」(`私` / `語彙` / `ツール` / `v0` …)を名指ししているか、
 *   ターン内で代替案が出されている。**帰属先の無い否定は断りにしない**(条件2)。
 * - `action_withheld`: 人間が変更を頼んだのに、**書き込み系ツールが1件も成功しておらず**、
 *   ターンの最後が**問いで終わっている**。本文の語を一切見ない(条件1)。006/T2 はここで拾う。
 *
 * 出力は「何に対する断りか」を必ず含む(条件2): 人間の要求本文 + 断りの1文 + 帰属先 + 証跡。
 *
 * **失敗モードは `scripts/mcp-trial/README.md` に書いてある**(条件3)。
 */

/**
 * 可能・能力の否定(**語尾の形態**)。辞書ではなく活用形なので、
 * `直せません` / `戻せません` / `外せません` のように**未知の動詞でも拾える**。
 */
const DENIAL_MARKERS = [
  "できません",
  "できない",
  "られません",
  "えません",
  "けません",
  "げません",
  "せません",
  "てません",
  "ねません",
  "べません",
  "めません",
  "れません",
  "不可能です",
  "対応していません",
  "用意されていません",
  "サポートしていません",
] as const;

/** 存在の否定。単独では弱いので、帰属先(SCOPE)が同じ文に無ければ断りにしない。 */
const ABSENCE_MARKERS = [
  "ありません",
  "ございません",
  "存在しません",
  "持っていません",
  "入っていません",
] as const;

/**
 * 「誰の・何の限界か」を示す語。**これが無い否定は断りではない**
 * (「この本はまだ読み終わっていません」は否定だが断りではない)。
 */
const SCOPE_MARKERS = [
  "私",
  "こちら",
  "語彙",
  "ツール",
  "MCP",
  "この仕組み",
  "プラットフォーム",
  "手段",
  "機能",
  "型",
  "操作",
  "コマンド",
  "API",
  "v0",
  "読み取り専用",
  "仕様",
  "スキーマ",
] as const;

/** 代替案の提示。断りには代替が伴うことが多く、帰属先の代わりの第2信号になる。 */
const ALTERNATIVE_MARKERS = [
  "代わりに",
  "かわりに",
  "代替",
  "回避策",
  "できるのは",
  "なら可能",
  "でよければ",
  "方法は",
  "進め方",
] as const;

/** 人間の発話が「変更してくれ」であることの標識(`action_withheld` の前提)。 */
const CHANGE_REQUEST_MARKERS = [
  "して",
  "してください",
  "してほしい",
  "お願い",
  "足して",
  "追加",
  "変えて",
  "直して",
  "出して",
  "作って",
  "適用",
  "更新",
  "削除",
  "取り消",
] as const;

/**
 * 書き込み系の MCP ツール(= ファイルを変える可能性があるもの)。
 *
 * これは辞書ヒューリスティックではなく、**`src/mcp/tools/write.ts` が登録するツールの
 * 事実の列挙**である。事実を手で写している以上ずれる ―― 実際 V1-M0-T01 が
 * `update_record` / `delete_record` を足したとき、ここは V0-P6-T03a 当時の4つのまま
 * 取り残され、レコードを5回書き換えたターンが `successfulWriteCallCount: 0` と
 * 記録されていた(010-record-correction/T4)。`action_withheld` は
 * 「変更要求あり × 成功書き込み0件 × 問い返し」で成立するので、
 * **実際に書いた AI を「行動を差し控えた」と誤検出しうる**状態だった。
 *
 * 再発は `write-tools-drift.test.ts` が塞ぐ(サーバの `tools/list` と突き合わせる)。
 *
 * ## `dry_run_diff` を入れない(V1-M1-T02。判断の記録は `records/v1-m1-t02.md` §1-1)
 *
 * **入れない。** ADR-0010 Consequences が確定させたとおり、この定数は
 * 「**変更を起こしたツール**」を判定するための集合であり、`dry_run_diff` は
 * 1バイトも変えない。入れると `changeAttribution` が変更候補として列挙し、
 * **V1-M1-T08 §5 が指摘した `update_record` の誤り(`manifest.json` を変えないのに
 * 変更候補として `explainedBy` に列挙される)と同じものを1件増やす。**
 *
 * **「変えない」は意図ではなく実装上の事実である。** `src/kernel/dry-run.ts` は
 * 複製を **OS の一時ディレクトリ**に作る。`ST_DATA_ROOT` の中に作らないのは、
 * まさにこの `snapshot.ts` が `ST_DATA_ROOT` 配下の全ファイルを採取して
 * judge に突き合わせさせるからである ―― 中に作ると、ドライラン1回ごとに
 * **transcript で説明できないファイル変化**が証跡に載る。
 *
 * `dry_run_diff` の登録先は `src/mcp/tools/read.ts`(参照系)であり、
 * `write-tools-drift.test.ts` の「WRITE_TOOLS に参照系ツールが混ざっていない」が
 * この定数の側から、`descriptions.test.ts` の
 * 「dry_run_diff は参照系として登録されている」がサーバの側から、
 * **両側で**この判断を見張っている。
 */
export const WRITE_TOOLS = [
  "mcp__smailtalk__create_app",
  "mcp__smailtalk__apply_diff",
  "mcp__smailtalk__insert_sample_data",
  "mcp__smailtalk__undo",
  // V1-M9-T05(ADR-0032)。redo は undo 実行直前のスナップショットから manifest.json /
  // app.sqlite を書き戻し、直前スナップショットも退避する = ファイルを変える。registerWriteTools が
  // 登録するので `write-tools-drift.test.ts` がここへの追記を要求する。分類は MANIFEST_WRITE_TOOLS 側。
  "mcp__smailtalk__redo",
  "mcp__smailtalk__update_record",
  "mcp__smailtalk__delete_record",
  // V2-M4-T01(ADR-0039)。複数レコードの原子書込(バッチ)。app.sqlite にレコードを書くが
  // manifest.json は1バイトも変えない(op は create/update のデータ書込のみ)。registerWriteTools が
  // 登録するので `write-tools-drift.test.ts` がここへの追記を要求する。分類は RECORD_WRITE_TOOLS 側。
  "mcp__smailtalk__write_records",
  // V1-M9-T09(ADR-0031)。アプリ単位の完全削除。registerWriteTools が登録するので
  // `write-tools-drift.test.ts` がここへの追記を要求する。manifest.json / snapshots を**消す**ので
  // 分類は MANIFEST_WRITE_TOOLS 側(attribution.ts)。
  "mcp__smailtalk__delete_app",
  // V1-M4-T04(ADR-0020 §2b)。接続の**申請**は kernel.sqlite の connection_requests に
  // pending 行を1件足す = 書き込みである(発行ではない)。registerWriteTools が登録するので
  // `write-tools-drift.test.ts` がここへの追記を要求する。マニフェスト(manifest.json)は
  // 1バイトも変えないので分類は RECORD_WRITE_TOOLS 側(attribution.ts)。
  "mcp__smailtalk__request_connection",
  // V1-M5-T04(ADR-0021 §2b)。AI capability の**申請**も kernel.sqlite の ai_requests に
  // pending 行を1件足す = 書き込み(発行ではない)。request_connection と同型で、マニフェストは
  // 1バイトも変えないので分類は RECORD_WRITE_TOOLS 側(attribution.ts)。
  "mcp__smailtalk__request_ai_capability",
  // V2-M5-T01(ADR-0041 限定1)。受信口の**申請**も kernel.sqlite の inbound_endpoint_requests に
  // pending 行を1件足す = 書き込み(発行ではない)。request_connection の鏡写しで、マニフェスト
  // (manifest.json)は1バイトも変えないので分類は RECORD_WRITE_TOOLS 側(attribution.ts)。
  "mcp__smailtalk__request_inbound_endpoint",
  // V3-M5-T01(ADR-0055 限定5)。逃げ道(任意 CSS)の**申請**も kernel.sqlite の
  // escape_hatch_asset_requests に pending 行を1件足す = 書き込み(発行ではない)。
  // request_connection と同型で、マニフェスト(manifest.json)は1バイトも変えないので
  // 分類は RECORD_WRITE_TOOLS 側(attribution.ts)。
  "mcp__smailtalk__request_custom_css",
  // V10-M30-T02(ADR-0378 = 台帳 `CM-G37`)。アプリごとのコメントの出し入れの切り替えは
  // kernel.sqlite の `apps` 表の列2本(`comment_write_enabled` / `comment_read_enabled`)を
  // UPDATE する = 書き込みである。registerWriteTools が登録するので
  // `write-tools-drift.test.ts` がここへの追記を要求する。**マニフェスト(manifest.json)は
  // 1バイトも変えない**(切り替えは `apply_diff` の18種目にしていない。ADR-0378 限定7)ので
  // 分類は RECORD_WRITE_TOOLS 側(attribution.ts)。
  "mcp__smailtalk__set_comment_visibility",
] as const;

/**
 * MCP ツール名からサーバ名を除いた接尾辞(ツール名そのもの)を取り出す。
 *
 * 改称(growable-platform → smailtalk)後も `docs/evidence/**` の生ログはバイト単位で
 * 凍結され、そこには永久に旧サーバ名の接頭辞(`mcp__growable-platform__`)が残る。
 * 書き込み判定をサーバ名込みの完全一致に頼ると、改称のたびに過去証跡の再判定
 * (`evidence-drift.test.ts`)が壊れる。ここではサーバ名部分(ハイフン区切りで
 * アンダースコアを含まない限り何であっても)を問わずに剥がし、ツール名の接尾辞だけで
 * 比較できるようにする。
 */
const MCP_TOOL_NAME_RE = /^mcp__[^_]*(?:-[^_]*)*__(.+)$/;
export function mcpToolSuffix(name: string): string | undefined {
  return MCP_TOOL_NAME_RE.exec(name)?.[1];
}

/** 生ログ(JSONL 文字列)を解析する。 */
export function parseTranscript(source: string): ParsedTranscript {
  const inits: InitEvent[] = [];
  const calls: ToolCall[] = [];
  const results: ToolResult[] = [];
  const assistantTexts: { turn: number; text: string }[] = [];
  const turnResults: { turn: number; subtype: string; isError: boolean; text: string }[] = [];
  const malformedLines: number[] = [];

  let turn = 0;
  let index = 0;

  for (const [i, line] of source.split("\n").entries()) {
    if (line.trim() === "") continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      malformedLines.push(i + 1);
      continue;
    }
    if (!isRecord(event)) {
      malformedLines.push(i + 1);
      continue;
    }

    const type = str(event.type);
    if (type === "system" && str(event.subtype) === "init") {
      turn += 1;
      inits.push({
        turn,
        tools: strArray(event.tools),
        mcpServers: parseMcpServers(event.mcp_servers),
        sessionId: str(event.session_id) ?? "",
        model: str(event.model) ?? "",
      });
      continue;
    }

    if (type === "assistant") {
      // 時刻はイベント側に付く(`--output-format stream-json` の実測)。
      // ツール呼び出し単位の所要時間はここからしか取れない(F-30 / V1-M0-T06 (b))。
      const timestamp = str(event.timestamp);
      for (const block of contentBlocks(event.message)) {
        if (str(block.type) === "tool_use") {
          calls.push({
            toolUseId: str(block.id) ?? "",
            name: str(block.name) ?? "",
            input: isRecord(block.input) ? block.input : {},
            turn: Math.max(turn, 1),
            index,
            ...(timestamp === undefined ? {} : { timestamp }),
          });
          index += 1;
        } else if (str(block.type) === "text") {
          const text = str(block.text);
          if (text !== undefined && text.trim() !== "") {
            assistantTexts.push({ turn: Math.max(turn, 1), text });
          }
        }
      }
      continue;
    }

    if (type === "user") {
      const timestamp = str(event.timestamp);
      for (const block of contentBlocks(event.message)) {
        if (str(block.type) !== "tool_result") continue;
        results.push({
          toolUseId: str(block.tool_use_id) ?? "",
          isError: block.is_error === true || block.isError === true,
          text: resultText(block.content),
          ...(timestamp === undefined ? {} : { timestamp }),
        });
      }
      continue;
    }

    if (type === "result") {
      turnResults.push({
        turn: Math.max(turn, 1),
        subtype: str(event.subtype) ?? "",
        isError: event.is_error === true,
        text: str(event.result) ?? "",
      });
    }
  }

  return { inits, calls, results, assistantTexts, turnResults, malformedLines };
}

/** ツール名ごとの呼び出し回数とエラー回数(名前順)。 */
export function summarizeToolUsage(
  parsed: ParsedTranscript,
): { name: string; count: number; errorCount: number }[] {
  const byId = resultIndex(parsed);
  const map = new Map<string, { name: string; count: number; errorCount: number }>();
  for (const call of parsed.calls) {
    const entry = map.get(call.name) ?? { name: call.name, count: 0, errorCount: 0 };
    entry.count += 1;
    if (byId.get(call.toolUseId)?.isError === true) entry.errorCount += 1;
    map.set(call.name, entry);
  }
  // ロケール依存の並びだと環境で結果が変わるので、コードポイント順に固定する。
  return [...map.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * 入力がパースできずに落ちた呼び出しか(V1-M0-T13 / F-17・F-24)。
 *
 * ツール入力が JSON として読めなかったとき、クライアントは引数の代わりに
 * `{"__unparsedToolInput":{"raw":"<元の文字列>","len":<バイト数>}}` を
 * `tool_use` ブロックの `input` に残す。この呼び出しは **MCP サーバに届いていない**。
 *
 * **判定は構造だけで行う。** エラー本文(`InputValidationError` 等)の文字列一致は使わない ――
 * それは F-27 が名指しした「辞書に語を足して済ませる」の再演であり、
 * 文言が変わった瞬間に黙って落ちるようになる。構造は文言より変わりにくく、
 * かつ「MCP に到達したか」という**事実そのもの**を表している。
 */
export function unparsedToolInput(call: ToolCall): { raw: string; len: number } | undefined {
  const marker = call.input.__unparsedToolInput;
  if (!isRecord(marker)) return undefined;
  const raw = str(marker.raw);
  if (raw === undefined) return undefined;
  // `len` はクライアントが数えたバイト数。欠けている・型が違う場合だけ、
  // **文字数ではなく UTF-8 バイト長**で補う(クライアントの数え方に合わせる)。
  const len = typeof marker.len === "number" ? marker.len : Buffer.byteLength(raw);
  return { raw, len };
}

/**
 * `is_error: true` の全件と、そのあと**同じツール**が成功したか。
 *
 * 「自力で直したか」は、修正までの間に新しい init(= 人間の入力)が挟まったかで判断する。
 * 挟まっていれば `humanInputBetween: true` ―― それは自己修正ではなく人間の助けである。
 *
 * 各 episode には `stage` が付く。`input-parse` は MCP に到達せず落ちたもの(F-17 / F-24)で、
 * **MCP サーバ・カーネルのどちらでも防げない層**である。区別しないと再発を問えない。
 */
export function detectErrorEpisodes(parsed: ParsedTranscript): ErrorEpisode[] {
  const byId = resultIndex(parsed);
  const episodes: ErrorEpisode[] = [];

  for (const call of parsed.calls) {
    const result = byId.get(call.toolUseId);
    if (result === undefined || !result.isError) continue;

    const fix = parsed.calls.find(
      (c) =>
        c.index > call.index && c.name === call.name && byId.get(c.toolUseId)?.isError === false,
    );
    const unparsed = unparsedToolInput(call);
    const episode: ErrorEpisode = {
      turn: call.turn,
      tool: call.name,
      toolUseId: call.toolUseId,
      errorText: truncate(result.text, 600),
      selfCorrected: fix !== undefined,
      humanInputBetween: fix !== undefined && fix.turn !== call.turn,
      stage: unparsed === undefined ? "server" : "input-parse",
    };
    if (unparsed !== undefined) episode.unparsedInput = unparsed;
    if (fix !== undefined) episode.correctedBy = fix.toolUseId;
    episodes.push(episode);
  }
  return episodes;
}

/**
 * やり直し: 同じツールを連続で呼び、その中に失敗が混じっている連鎖。
 *
 * **V1-M0-T06 (b)**: 証跡に時刻があれば、やり直し1回あたりの所要時間まで出す。
 * 「やり直し1回」は **失敗の結果が返った瞬間 → 次の試行の結果が返る瞬間**と定義する。
 * この区間にモデルの再生成が丸ごと入るので、**やり直しが実際に消費した時間**がこれである。
 * 時刻が無い証跡では時間の項目を**付けない**(0 で埋めると測っていないことが隠れる。憲法6)。
 */
export function detectRetries(parsed: ParsedTranscript): RetryEpisode[] {
  const byId = resultIndex(parsed);
  const retries: RetryEpisode[] = [];

  let chain: ToolCall[] = [];
  const flush = (): void => {
    const first = chain[0];
    const last = chain[chain.length - 1];
    if (first === undefined || last === undefined || chain.length < 2) return;
    if (!chain.some((c) => byId.get(c.toolUseId)?.isError === true)) return;
    retries.push({
      tool: first.name,
      turn: first.turn,
      attempts: chain.length,
      succeeded: byId.get(last.toolUseId)?.isError === false,
      ...retryTiming(chain, byId),
    });
  };

  for (const call of parsed.calls) {
    const head = chain[0];
    if (head !== undefined && (head.name !== call.name || head.turn !== call.turn)) {
      flush();
      chain = [];
    }
    chain.push(call);
  }
  flush();
  return retries;
}

/**
 * やり直しの所要時間。時刻が1つでも欠けていれば**何も返さない**。
 * 一部だけ埋めると「測れた区間」と「測れなかった区間」が混ざって読めなくなる。
 */
function retryTiming(chain: ToolCall[], byId: Map<string, ToolResult>): Partial<RetryEpisode> {
  const pairs = chain.map((call) => ({
    callAt: parseTime(call.timestamp),
    resultAt: parseTime(byId.get(call.toolUseId)?.timestamp),
  }));
  if (pairs.some((p) => p.callAt === null || p.resultAt === null)) return {};

  const startedAt = chain[0]?.timestamp;
  const endedAt = byId.get(chain[chain.length - 1]?.toolUseId ?? "")?.timestamp;
  if (startedAt === undefined || endedAt === undefined) return {};

  const first = pairs[0];
  const last = pairs[pairs.length - 1];
  if (first === undefined || last === undefined) return {};

  // やり直し1回 = 直前の試行の**結果**から、今回の試行の**結果**まで。
  const redoMs: number[] = [];
  for (let i = 1; i < pairs.length; i += 1) {
    const prev = pairs[i - 1];
    const cur = pairs[i];
    if (prev === undefined || cur === undefined) return {};
    redoMs.push((cur.resultAt ?? 0) - (prev.resultAt ?? 0));
  }
  const toolExecMs = pairs.reduce((sum, p) => sum + ((p.resultAt ?? 0) - (p.callAt ?? 0)), 0);

  return {
    startedAt,
    endedAt,
    durationMs: (last.resultAt ?? 0) - (first.callAt ?? 0),
    redoCount: redoMs.length,
    redoMs,
    meanRedoMs: Math.round(redoMs.reduce((a, b) => a + b, 0) / redoMs.length),
    toolExecMs,
  };
}

function parseTime(value: string | undefined): number | null {
  if (value === undefined) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** `detectRefusals` の追加入力。judge は `meta.turns` を渡す。 */
export interface RefusalContext {
  /** 人間が打ったプロンプト(1始まりのターン順)。無い証跡では `action_withheld` を判定しない。 */
  humanTurns?: string[];
}

/**
 * 断りの抽出(**ターン単位の証跡照合**)。方式の説明はファイル冒頭にある。
 *
 * 返すのは**候補**である。最終判断は人間が transcript を読んで行う ―― これは旧方式と変わらない。
 * 変わったのは、候補に「何に対する断りか」と「そう判定した証跡」が必ず付く点である。
 */
export function detectRefusals(
  parsed: ParsedTranscript,
  context: RefusalContext = {},
): RefusalFinding[] {
  const byId = resultIndex(parsed);
  const writeSuffixes = new Set(WRITE_TOOLS.map((t) => mcpToolSuffix(t)));
  const humanTurns = context.humanTurns ?? [];
  const findings: RefusalFinding[] = [];

  // 帰属先の標識には、**その試行で実際に使えたツールの名前**も加える。
  // これは手書きの辞書ではなく証跡(`system/init` の実効ツール一覧)から導いた値である。
  // 「`update_view` だけでは実現できません」「『undo の undo』はできません」のように、
  // AI は限界を**操作の名前**で言うことがあり、それは能力の帰属先として機械的に確かである。
  const toolScope = [
    ...new Set(
      parsed.inits
        .flatMap((init) => init.tools)
        .filter((name) => name.startsWith("mcp__"))
        .map((name) => name.replace(/^mcp__[^_]*(?:-[^_]*)*__/, "")),
    ),
  ].filter((name) => name !== "");

  const turns = [...new Set(parsed.assistantTexts.map((t) => t.turn))].sort((a, b) => a - b);
  for (const turn of turns) {
    const calls = parsed.calls.filter((c) => c.turn === turn);
    const writeCalls = calls.filter((c) => writeSuffixes.has(mcpToolSuffix(c.name)));
    const okWrites = writeCalls.filter((c) => byId.get(c.toolUseId)?.isError === false);
    const errorCount = calls.filter((c) => byId.get(c.toolUseId)?.isError === true).length;
    const texts = parsed.assistantTexts.filter((t) => t.turn === turn);
    const lastText = texts[texts.length - 1]?.text ?? "";
    // 「問い返した」= ターンの最終応答に**問いの文が含まれる**こと。
    // 末尾だけを見ると 006/T2 のように「…していいですか?」のあとに補足を続けた場合を落とす。
    const askedBack = splitSentences(lastText).some(isInterrogative);
    const hasAlternative = ALTERNATIVE_MARKERS.some((m) => texts.some((t) => t.text.includes(m)));
    const requested = humanTurns[turn - 1] ?? "";

    const statements: RefusalStatement[] = [];
    for (const { text } of texts) {
      for (const sentence of splitSentences(text)) {
        const scope = [
          ...SCOPE_MARKERS.filter((m) => sentence.includes(m)),
          ...toolScope.filter((m) => sentence.includes(m)),
        ];
        const denial = DENIAL_MARKERS.find((m) => sentence.includes(m));
        if (denial !== undefined) {
          // 条件2: 語の一致だけでは断りにしない。帰属先か代替案という第2の信号を要求する。
          if (scope.length === 0 && !hasAlternative) continue;
          statements.push({
            sentence,
            marker: denial,
            scope,
            rationale:
              scope.length > 0
                ? `可能・能力の否定「${denial}」が、限界の帰属先(${scope.join(" / ")})とともに現れた`
                : `可能・能力の否定「${denial}」があり、同じターンで代替案が提示されている`,
          });
          continue;
        }
        const absence = ABSENCE_MARKERS.find((m) => sentence.includes(m));
        if (absence !== undefined && scope.length > 0) {
          statements.push({
            sentence,
            marker: absence,
            scope,
            rationale: `存在の否定「${absence}」が、限界の帰属先(${scope.join(" / ")})とともに現れた`,
          });
        }
      }
    }

    // 条件1: 本文の語を一切見ない経路。006/T2(本文に判定語が無い差し戻し)はここで拾う。
    const askedForChange =
      requested !== "" && CHANGE_REQUEST_MARKERS.some((m) => requested.includes(m));
    const withheld = askedForChange && okWrites.length === 0 && askedBack;

    const kinds: RefusalKind[] = [];
    if (statements.length > 0) kinds.push("capability_denial");
    if (withheld) kinds.push("action_withheld");
    if (kinds.length === 0) continue;

    findings.push({
      turn,
      kinds,
      requested,
      statements,
      evidence: {
        toolCallCount: calls.length,
        writeCallCount: writeCalls.length,
        successfulWriteCallCount: okWrites.length,
        errorCount,
        askedBack,
      },
    });
  }
  return findings;
}

/**
 * その1文が疑問文か(**文法規則で判定する。語尾の列挙ではない**)。V1-M1-T08。
 *
 * **旧実装は `ますか` / `どうしますか` を列挙していた。** これは辞書ヒューリスティックであり、
 * 実際に取りこぼした —— `cp-v1-0/010-record-correction` ターン5 の
 * 「この3件を削除して進めて**よいですか**。」(です+か)は `ますか` に一致せず、
 * **F-38 の観測を judge が候補に1件も挙げられなかった**。
 *
 * **`ですか` を辞書に足すのは対症療法である**(F-27 が名指しで禁じた形)。
 * 次は `でしょうか` `ますでしょうか` で同じことが起きる。日本語の疑問は語彙ではなく
 * **文末の終助詞「か」**(または疑問符)で標示されるので、方式をそちらへ移す。
 * `DENIAL_MARKERS` を辞書から活用形へ移したのと同じ形式である。
 *
 * **代償を先に書く**(README の失敗モードにも記載): 文末の「か」は疑問以外にも立つ。
 * 「〜とか。」「〜ほか。」「〜しか。」は疑問文でないのに一致する。
 * この向きの誤りは `action_withheld` を**増やす**(誤検出)側であり、
 * 取りこぼす側ではない —— F-27 が起こした失敗が取りこぼしなので、この向きを選ぶ。
 */
function isInterrogative(sentence: string): boolean {
  return /[?？]$/.test(sentence) || /か[。．.]?$/.test(sentence);
}

/** 応答本文を1文ずつに割る。箇条書きの行も1文として扱う。 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。?？!!\n])/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** 成功した書き込み系ツールの呼び出しだけを返す。 */
export function successfulWriteCalls(parsed: ParsedTranscript): ToolCall[] {
  const byId = resultIndex(parsed);
  const writeSuffixes = new Set(WRITE_TOOLS.map((t) => mcpToolSuffix(t)));
  return parsed.calls.filter(
    (call) =>
      writeSuffixes.has(mcpToolSuffix(call.name)) && byId.get(call.toolUseId)?.isError === false,
  );
}

/** 成功したツール呼び出し(参照系を含む全ツール)。 */
export function successfulCalls(parsed: ParsedTranscript): ToolCall[] {
  const byId = resultIndex(parsed);
  return parsed.calls.filter((call) => byId.get(call.toolUseId)?.isError === false);
}

function resultIndex(parsed: ParsedTranscript): Map<string, ToolResult> {
  return new Map(parsed.results.map((r) => [r.toolUseId, r]));
}

function contentBlocks(message: unknown): Record<string, unknown>[] {
  if (!isRecord(message)) return [];
  const content = message.content;
  if (!Array.isArray(content)) return [];
  return content.filter(isRecord);
}

function parseMcpServers(value: unknown): { name: string; status: string }[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((server) => ({
    name: str(server.name) ?? "",
    status: str(server.status) ?? "",
  }));
}

/** ツール結果本文は文字列のこともブロック配列のこともある。 */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(isRecord)
      .map((block) => str(block.text) ?? str(block.tool_name) ?? "")
      .filter((t) => t !== "")
      .join("\n");
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…(以下略)`;
}
