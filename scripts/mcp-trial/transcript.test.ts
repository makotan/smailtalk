import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  detectErrorEpisodes,
  detectRefusals,
  detectRetries,
  parseTranscript,
  successfulWriteCalls,
  summarizeToolUsage,
  unparsedToolInput,
} from "./transcript.ts";
import type { ToolCall } from "./types.ts";

const here = dirname(new URL(import.meta.url).pathname);
const fixture = (name: string): string => readFileSync(join(here, "__fixtures__", name), "utf-8");

describe("parseTranscript", () => {
  test("system/init の実効ツール一覧を読む(設定値ではなく効いた値)", () => {
    const parsed = parseTranscript(fixture("clean.stream.jsonl"));
    expect(parsed.inits.length).toBe(2);
    expect(parsed.inits[0]?.tools).toContain("mcp__smailtalk__create_app");
    expect(parsed.inits[0]?.mcpServers).toEqual([{ name: "smailtalk", status: "connected" }]);
    expect(parsed.inits[0]?.model).toBe("claude-opus-4-8[1m]");
  });

  test("init の回数でターンを数える", () => {
    const parsed = parseTranscript(fixture("clean.stream.jsonl"));
    expect(parsed.inits.map((i) => i.turn)).toEqual([1, 2]);
    expect(parsed.calls.filter((c) => c.turn === 2).map((c) => c.name)).toEqual([
      "mcp__smailtalk__get_manifest",
    ]);
  });

  test("ツール呼び出しを順番に抽出する", () => {
    const parsed = parseTranscript(fixture("clean.stream.jsonl"));
    expect(parsed.calls.map((c) => c.name)).toEqual([
      "mcp__smailtalk__create_app",
      "mcp__smailtalk__apply_diff",
      "mcp__smailtalk__get_manifest",
    ]);
    expect(parsed.calls[0]?.input.app_id).toBe("platform-admin");
    expect(parsed.calls[0]?.index).toBe(0);
  });

  test("ツール結果と is_error を拾う", () => {
    const parsed = parseTranscript(fixture("error-then-fix.stream.jsonl"));
    const errors = parsed.results.filter((r) => r.isError);
    expect(errors.map((e) => e.toolUseId)).toEqual(["toolu_C2", "toolu_C3"]);
    expect(errors[0]?.text).toContain("未知のプロパティ");
  });

  test("V1-M0-T06 (b): ツール呼び出しと結果の時刻を拾う", () => {
    const parsed = parseTranscript(fixture("timed-retry.stream.jsonl"));
    expect(parsed.calls[0]?.timestamp).toBe("2026-07-18T23:39:19.375Z");
    expect(parsed.results[0]?.timestamp).toBe("2026-07-18T23:39:19.412Z");
  });

  test("時刻の無い証跡では timestamp を持たない(0 で埋めない)", () => {
    const parsed = parseTranscript(fixture("clean.stream.jsonl"));
    expect(parsed.calls[0]?.timestamp).toBeUndefined();
  });

  test("assistant の text だけを拾い thinking は捨てる", () => {
    const parsed = parseTranscript(fixture("clean.stream.jsonl"));
    expect(parsed.assistantTexts.map((t) => t.text)).toEqual([
      "プラットフォーム管理アプリを作りました。",
      "一覧画面はできています。",
    ]);
  });

  test("ターンの最終応答を拾う", () => {
    const parsed = parseTranscript(fixture("clean.stream.jsonl"));
    expect(parsed.turnResults.length).toBe(2);
    expect(parsed.turnResults[0]?.isError).toBe(false);
  });

  test("壊れた行は行番号として記録し、例外にはしない", () => {
    const parsed = parseTranscript('{"type":"system","subtype":"init","tools":[]}\nnot json\n');
    expect(parsed.malformedLines).toEqual([2]);
    expect(parsed.inits.length).toBe(1);
  });

  test("空行は無視する", () => {
    expect(parseTranscript("\n\n").malformedLines).toEqual([]);
  });
});

describe("summarizeToolUsage", () => {
  test("ツール名ごとの回数とエラー回数を出す", () => {
    const parsed = parseTranscript(fixture("error-then-fix.stream.jsonl"));
    const usage = summarizeToolUsage(parsed);
    expect(usage).toEqual([
      { name: "ToolSearch", count: 1, errorCount: 0 },
      { name: "mcp__smailtalk__apply_diff", count: 3, errorCount: 2 },
    ]);
  });
});

describe("detectErrorEpisodes", () => {
  test("エラーの全件と、直後に同じツールで自己修正が成立したかを出す", () => {
    const parsed = parseTranscript(fixture("error-then-fix.stream.jsonl"));
    const episodes = detectErrorEpisodes(parsed);
    expect(episodes.length).toBe(2);
    expect(episodes[0]?.selfCorrected).toBe(true);
    expect(episodes[0]?.correctedBy).toBe("toolu_C4");
    expect(episodes[1]?.correctedBy).toBe("toolu_C4");
  });

  test("同一ターン内なら humanInputBetween は false", () => {
    const episodes = detectErrorEpisodes(parseTranscript(fixture("error-then-fix.stream.jsonl")));
    expect(episodes.every((e) => e.humanInputBetween === false)).toBe(true);
  });

  test("エラーのあと同じツールが呼ばれなければ自己修正なし", () => {
    const stream = [
      '{"type":"system","subtype":"init","tools":[]}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"X","input":{}}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"boom","is_error":true}]}}',
    ].join("\n");
    const episodes = detectErrorEpisodes(parseTranscript(stream));
    expect(episodes[0]?.selfCorrected).toBe(false);
    expect(episodes[0]?.correctedBy).toBeUndefined();
  });

  test("ターンをまたいで直った場合は humanInputBetween が true", () => {
    const stream = [
      '{"type":"system","subtype":"init","tools":[]}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"X","input":{}}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"boom","is_error":true}]}}',
      '{"type":"system","subtype":"init","tools":[]}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t2","name":"X","input":{}}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t2","content":"ok"}]}}',
    ].join("\n");
    const episodes = detectErrorEpisodes(parseTranscript(stream));
    expect(episodes[0]?.selfCorrected).toBe(true);
    expect(episodes[0]?.humanInputBetween).toBe(true);
  });
});

describe("detectRetries", () => {
  test("失敗を挟んだ同一ツールの連鎖をやり直しとして数える", () => {
    const parsed = parseTranscript(fixture("error-then-fix.stream.jsonl"));
    expect(detectRetries(parsed)).toEqual([
      {
        tool: "mcp__smailtalk__apply_diff",
        turn: 1,
        attempts: 3,
        succeeded: true,
      },
    ]);
  });

  test("成功しかしていないツールはやり直しに数えない", () => {
    expect(detectRetries(parseTranscript(fixture("clean.stream.jsonl")))).toEqual([]);
  });

  test("V1-M0-T06 (b): やり直し1回あたりの所要時間を算出する", () => {
    const [retry] = detectRetries(parseTranscript(fixture("timed-retry.stream.jsonl")));
    expect(retry?.attempts).toBe(3);
    // 1回目の失敗結果 23:39:28.995 → 最後の結果 23:39:48.387
    expect(retry?.startedAt).toBe("2026-07-18T23:39:28.957Z");
    expect(retry?.endedAt).toBe("2026-07-18T23:39:48.387Z");
    expect(retry?.durationMs).toBe(19_430);
    // やり直し = 2回(失敗のあとの再送)。1回あたりの所要時間が出せることが完了条件4。
    expect(retry?.redoCount).toBe(2);
    expect(retry?.redoMs).toEqual([11_036, 8_356]);
    expect(retry?.meanRedoMs).toBe(9_696);
    // 内訳: ツール実行そのものはごく短く、大半はモデルの再生成に使われている。
    expect(retry?.toolExecMs).toBe(101);
  });

  test("時刻が無い証跡では所要時間を出さない(黙って0にしない)", () => {
    const [retry] = detectRetries(parseTranscript(fixture("error-then-fix.stream.jsonl")));
    expect(retry?.attempts).toBe(3);
    expect(retry?.durationMs).toBeUndefined();
    expect(retry?.redoMs).toBeUndefined();
  });
});

describe("detectRefusals(V1-M0-T06: ターン単位の証跡照合)", () => {
  test("限界の言明を、その言明が及ぶ範囲(scope)と組にして抽出する", () => {
    const refusals = detectRefusals(parseTranscript(fixture("refusal.stream.jsonl")), {
      humanTurns: ["ボタンの色を変えて。青系にしたい。"],
    });
    expect(refusals.length).toBe(1);
    const found = refusals[0];
    expect(found?.turn).toBe(1);
    expect(found?.kinds).toContain("capability_denial");
    // 条件2: 「何に対する断りか」が出力に含まれる。語1つだけでは足りない。
    expect(found?.requested).toContain("ボタンの色");
    expect(found?.statements[0]?.sentence).toContain("ボタンの色は変えられません");
    // この1文自体は帰属先を名指ししていないので、第2の信号(代替案の提示)で通っている。
    expect(found?.statements[0]?.rationale).toContain("代替案");
    // 同じターンの別の文が帰属先(語彙 / v0)を名指ししている。
    expect(found?.statements.some((s) => s.scope.length > 0)).toBe(true);
  });

  test("限界の言明が無ければ0件", () => {
    expect(detectRefusals(parseTranscript(fixture("clean.stream.jsonl")), {})).toEqual([]);
  });

  test("条件1: 判定入力にツール呼び出しの有無・結果が含まれる", () => {
    const refusals = detectRefusals(parseTranscript(fixture("refusal.stream.jsonl")), {
      humanTurns: ["ボタンの色を変えて。"],
    });
    expect(refusals[0]?.evidence).toEqual({
      toolCallCount: 1,
      writeCallCount: 0,
      successfulWriteCallCount: 0,
      errorCount: 0,
      askedBack: false,
    });
  });

  test("F-27 #1(006/T2 型): 判定語が本文に無くても、書き込みを呼ばずに問い返した事実で拾う", () => {
    const refusals = detectRefusals(parseTranscript(fixture("refusal-withheld.stream.jsonl")), {
      humanTurns: ["本に本棚への参照の項目を足して。現状の確認はいらないので、そのまま適用して。"],
    });
    expect(refusals.length).toBe(1);
    expect(refusals[0]?.kinds).toContain("action_withheld");
    expect(refusals[0]?.evidence.successfulWriteCallCount).toBe(0);
    expect(refusals[0]?.evidence.askedBack).toBe(true);
    expect(refusals[0]?.requested).toContain("そのまま適用して");
  });

  test("F-27 #2(007/T3 型): 辞書に無い可能動詞の否定(直せません)を形態で拾う", () => {
    const stream = [
      '{"type":"system","subtype":"init","tools":[],"mcp_servers":[]}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"**私からは直せません。** 私が使えるツールにはレコードの更新・削除がありません。"}]}}',
    ].join("\n");
    const refusals = detectRefusals(parseTranscript(stream), {
      humanTurns: ["本をあと3冊、サンプルで足しておいて。"],
    });
    expect(refusals.length).toBe(1);
    expect(refusals[0]?.statements[0]?.marker).toBe("せません");
    expect(refusals[0]?.statements[0]?.scope).toContain("私");
  });

  test("帰属先の標識は証跡から導く: 実効ツール一覧に出てくる操作名も scope になる", () => {
    const stream = [
      '{"type":"system","subtype":"init","tools":["mcp__smailtalk__update_view"],"mcp_servers":[]}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"`update_view` だけでは実現できません。"}]}}',
    ].join("\n");
    const refusals = detectRefusals(parseTranscript(stream), {
      humanTurns: ["貸出先を列に出して。"],
    });
    expect(refusals[0]?.statements[0]?.scope).toContain("update_view");
  });

  test("条件2: 語が一致しても、限界の帰属先(scope)も代替案も無ければ断りにしない", () => {
    const stream = [
      '{"type":"system","subtype":"init","tools":[],"mcp_servers":[]}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"この本はまだ読み終わっていません。"}]}}',
    ].join("\n");
    expect(detectRefusals(parseTranscript(stream), { humanTurns: ["読了にして。"] })).toEqual([]);
  });

  test("人間ターンが分からない場合、action_withheld は判定しない(失敗モード)", () => {
    const refusals = detectRefusals(parseTranscript(fixture("refusal-withheld.stream.jsonl")), {});
    expect(refusals).toEqual([]);
  });
});

/**
 * V1-M0-T01 再実地(010-record-correction)の副産物として見つかった欠陥の回帰テスト。
 *
 * `WRITE_TOOLS` は V0-P6-T03a 当時の4つのままで、V1-M0-T01 が足した
 * `update_record` / `delete_record` が**書き込みとして数えられていなかった**。
 * `action_withheld` は「変更要求あり × 成功書き込み0件 × 問い返し」で成立するため、
 * **実際にレコードを書き換えた AI を「行動を差し控えた」と誤検出しうる**。
 * これは V1-M0-T06 が方式変更で得たはずの「本文を読まずに証跡だけで判定する」
 * という性質そのものを損なう。
 *
 * ここで問うのは配列の中身ではなく**振る舞い**である。定数を assert するだけの
 * テストは同語反復で、次に足されるツールを1つも守らない。
 */
describe("V1-M0-T01 再実地: レコード更新系も書き込みとして数える", () => {
  /** ツール1回を「呼び出し + 成功結果」の2行にした最小の生ログを作る。 */
  const successfulCall = (id: string, tool: string): string[] => [
    JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id, name: `mcp__smailtalk__${tool}`, input: {} }],
      },
    }),
    JSON.stringify({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: id, is_error: false, content: "ok" }],
      },
    }),
  ];

  const streamWith = (tool: string, closing: string): string =>
    [
      JSON.stringify({
        type: "system",
        subtype: "init",
        tools: [`mcp__smailtalk__${tool}`],
        mcp_servers: [{ name: "smailtalk", status: "connected" }],
      }),
      ...successfulCall("toolu_W1", tool),
      ...successfulCall("toolu_W2", tool),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: closing }] },
      }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: closing }),
    ].join("\n");

  test("update_record を成功させたターンは successfulWriteCallCount に数える", () => {
    const parsed = parseTranscript(
      streamWith("update_record", "感想メモを空にしました。他に直すところはありますか?"),
    );
    expect(successfulWriteCalls(parsed).map((c) => c.name)).toEqual([
      "mcp__smailtalk__update_record",
      "mcp__smailtalk__update_record",
    ]);
  });

  test("update_record で実際に書いたターンを action_withheld と誤検出しない", () => {
    const refusals = detectRefusals(
      parseTranscript(
        streamWith("update_record", "感想メモを空にしました。他に直すところはありますか?"),
      ),
      { humanTurns: ["感想メモは全部空にしておいて。"] },
    );
    // 書いたうえで問い返しただけなので「行動を差し控えた」ではない。
    expect(refusals.flatMap((r) => r.kinds)).not.toContain("action_withheld");
    // 証跡側も 0 件のままにしない(誤検出が起きなかったのは偶然ではない、の担保)。
    const evidence = refusals[0]?.evidence;
    if (evidence !== undefined) expect(evidence.successfulWriteCallCount).toBe(2);
  });

  test("delete_record も同じく書き込みとして数える", () => {
    const stream = streamWith("delete_record", "宮沢賢治以外を消しました。これでいいですか?");
    expect(successfulWriteCalls(parseTranscript(stream)).length).toBe(2);
    expect(
      detectRefusals(parseTranscript(stream), {
        humanTurns: ["宮沢賢治の本以外は消しておいて。"],
      }).flatMap((r) => r.kinds),
    ).not.toContain("action_withheld");
  });

  test("参照系ツールしか呼んでいなければ従来どおり action_withheld を拾う", () => {
    const stream = streamWith("list_records", "現状はこうです。この方針で進めていいですか?");
    expect(successfulWriteCalls(parseTranscript(stream))).toEqual([]);
    expect(
      detectRefusals(parseTranscript(stream), {
        humanTurns: ["感想メモは全部空にしておいて。"],
      }).flatMap((r) => r.kinds),
    ).toContain("action_withheld");
  });
});

/**
 * V1-M0-T13: F-17 / F-24(`\uXXXX` 不正エスケープが**ツール入力パース層**で落ちる)を
 * 機械的に問えるようにする。CP-7 は「証跡に残らない」と判定したが、これは誤りで、
 * 実際には `__unparsedToolInput` という構造として残っている。
 */
describe("unparsedToolInput(入力パース層で落ちた呼び出しの判別)", () => {
  const call = (input: Record<string, unknown>): ToolCall => ({
    toolUseId: "t1",
    name: "mcp__smailtalk__insert_sample_data",
    input,
    turn: 1,
    index: 0,
  });

  test("構造から生入力を取り出す(切り詰めない)", () => {
    const raw = '{"title": "\\u5packa"}';
    expect(unparsedToolInput(call({ __unparsedToolInput: { raw, len: 21 } }))).toEqual({
      raw,
      len: 21,
    });
  });

  test("通常の呼び出しでは undefined", () => {
    expect(unparsedToolInput(call({ app_id: "book-log", rows: [] }))).toBeUndefined();
  });

  test("形が違えば undefined(raw が文字列でない / そもそも record でない)", () => {
    expect(unparsedToolInput(call({ __unparsedToolInput: { raw: 42, len: 3 } }))).toBeUndefined();
    expect(unparsedToolInput(call({ __unparsedToolInput: "boom" }))).toBeUndefined();
  });

  test("len が number でなければ raw のバイト長で補う", () => {
    // 「読了」は UTF-8 で6バイト。文字数(2)ではなくバイト長を採る。
    expect(unparsedToolInput(call({ __unparsedToolInput: { raw: "読了" } }))).toEqual({
      raw: "読了",
      len: 6,
    });
  });
});

describe("detectErrorEpisodes の stage(V1-M0-T13)", () => {
  test("フィクスチャ: input-parse と server の2件を、段階付きで返す", () => {
    const episodes = detectErrorEpisodes(
      parseTranscript(fixture("input-parse-error.stream.jsonl")),
    );
    expect(episodes.length).toBe(2);
    expect(episodes.map((e) => e.stage)).toEqual(["input-parse", "server"]);
    expect(episodes[0]?.tool).toBe("mcp__smailtalk__insert_sample_data");
    expect(episodes[1]?.tool).toBe("mcp__smailtalk__apply_diff");
  });

  test("input-parse の episode は生入力を保持し、自己修正が成立している", () => {
    const [first] = detectErrorEpisodes(parseTranscript(fixture("input-parse-error.stream.jsonl")));
    expect(first?.unparsedInput?.raw).toContain("\\u5packa");
    expect(first?.unparsedInput?.len).toBe(117);
    expect(first?.selfCorrected).toBe(true);
    expect(first?.correctedBy).toBe("toolu_P2");
  });

  test("server の episode には unparsedInput が付かない", () => {
    const episodes = detectErrorEpisodes(
      parseTranscript(fixture("input-parse-error.stream.jsonl")),
    );
    expect(episodes[1]?.unparsedInput).toBeUndefined();
  });

  // F-27 が名指しした「辞書追加で済ませる」の再演を防ぐ回帰テスト。
  // stage はエラー本文の語ではなく、`__unparsedToolInput` の**構造**だけで決まる。
  test("エラー本文に InputValidationError があっても、構造が無ければ server", () => {
    const stream = [
      '{"type":"system","subtype":"init","tools":[]}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"X","input":{"app_id":"a"}}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"<tool_use_error>InputValidationError: could not be parsed as JSON</tool_use_error>","is_error":true}]}}',
    ].join("\n");
    const [episode] = detectErrorEpisodes(parseTranscript(stream));
    expect(episode?.stage).toBe("server");
    expect(episode?.unparsedInput).toBeUndefined();
  });

  test("エラー本文が別文言でも、構造があれば input-parse", () => {
    const stream = [
      '{"type":"system","subtype":"init","tools":[]}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"X","input":{"__unparsedToolInput":{"raw":"{bad","len":4}}}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"まったく別の文言のエラー","is_error":true}]}}',
    ].join("\n");
    const [episode] = detectErrorEpisodes(parseTranscript(stream));
    expect(episode?.stage).toBe("input-parse");
    expect(episode?.unparsedInput).toEqual({ raw: "{bad", len: 4 });
  });
});

/**
 * 完了条件3(実物の証跡での検証。V1-M0-T13): `X-G28` / `V9-M11-T02` により
 * `tools/docs/transcript-evidence.test.ts` へ切り出した(`docs/evidence/` を fs で
 * 読むため、公開単位 `apps/smailtalk/` の中に置けない)。ここには残していない。
 */

/**
 * V1-M1-T08: 問い返しの検出方式(語尾の列挙 → 文法規則)。
 *
 * **測って分かったこと**: `v1-m0-t01-retrial.md` §10-5 は 010 ターン5 が候補から落ちた原因を
 * 「`CHANGE_REQUEST_MARKERS` に『消し』が無いため」と書いたが、**これは誤りである**。
 * 「消しておいて」は `して`(消**し**+**て**)を部分文字列として含むので変更要求の判定は
 * **成立していた**。落ちたのは問い返しの側で、旧実装は `ますか` しか知らず、
 * 実際の文「この3件を削除して進めて**よいですか**。」(です+か)に一致しなかった。
 *
 * **辞書に `ですか` を足すのは対症療法である**(F-27 が禁じた形)。次は `でしょうか` で落ちる。
 * 疑問文であることは語彙ではなく**文法**で決まる —— 日本語の疑問は文末の終助詞「か」
 * (または疑問符)で標示される。方式をそちらへ移す。
 */
describe("問い返しの検出は文法規則で行う(V1-M1-T08)", () => {
  const consentFixture = (): string => fixture("refusal-withheld-consent.stream.jsonl");
  const humanTurns = ["サンプルは多すぎた。宮沢賢治の本以外は消しておいて。"];

  test("同意を求める問い返しが「〜てよいですか。」の形でも action_withheld を拾う", () => {
    const refusals = detectRefusals(parseTranscript(consentFixture()), { humanTurns });
    expect(refusals.length).toBe(1);
    expect(refusals[0]?.kinds).toContain("action_withheld");
    expect(refusals[0]?.evidence.askedBack).toBe(true);
    expect(refusals[0]?.evidence.successfulWriteCallCount).toBe(0);
  });

  test("「でしょうか」も同じ規則で拾う(辞書に足していないことの確認)", () => {
    const stream = [
      '{"type":"system","subtype":"init","tools":[],"mcp_servers":[]}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"消える行はこの3件です。この内容で進めてよろしいでしょうか。念のため補足します。"}]}}',
    ].join("\n");
    const refusals = detectRefusals(parseTranscript(stream), { humanTurns });
    expect(refusals[0]?.kinds).toContain("action_withheld");
  });

  test("逆向きの退行よけ: 問いを含まない報告は action_withheld にしない", () => {
    const stream = [
      '{"type":"system","subtype":"init","tools":[],"mcp_servers":[]}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"3件を削除しました。残りは2件です。"}]}}',
    ].join("\n");
    expect(detectRefusals(parseTranscript(stream), { humanTurns })).toEqual([]);
  });
});

/**
 * V1-M1-T08 完了条件(実物の証跡で、F-38 の観測が judge の候補に挙がること): `X-G28` /
 * `V9-M11-T02` により `tools/docs/transcript-evidence.test.ts` へ切り出した(`docs/evidence/`
 * を fs で読むため、公開単位 `apps/smailtalk/` の中に置けない)。ここには残していない。
 */
