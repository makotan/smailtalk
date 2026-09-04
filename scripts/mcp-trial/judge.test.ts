import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  formatReport,
  judgeTrial,
  parseAllowedNonMcpToolsEnv,
  SKILL_TRIAL_ALLOWED_NON_MCP_TOOLS,
} from "./judge.ts";
import type { FileState, Snapshot, TrialMeta } from "./types.ts";

const here = dirname(new URL(import.meta.url).pathname);
const fixture = (name: string): string => readFileSync(join(here, "__fixtures__", name), "utf-8");

const T0 = Date.parse("2026-07-19T10:00:00.000Z");

const file = (path: string, sha: string, mtimeMs = T0 + 1000): FileState => ({
  path,
  sha256: sha,
  mtimeMs,
  size: 1,
});

const snap = (phase: "before" | "after", turn: number, files: FileState[]): Snapshot => ({
  phase,
  turn,
  takenAt: new Date(T0).toISOString(),
  files,
});

/** clean.stream.jsonl(2ターン、create_app + apply_diff + get_manifest)に対応する証跡。 */
function cleanMeta(overrides: Partial<TrialMeta> = {}): TrialMeta {
  const empty: FileState[] = [];
  const written = [file("kernel.sqlite", "k2"), file("apps/platform-admin/manifest.json", "m1")];
  return {
    trialId: "001-bootstrap",
    scenarioId: "bootstrap",
    scenarioTitle: "ブートストラップ",
    sessionId: "11111111-1111-4111-8111-111111111111",
    dataRoot: "data-cp6",
    startedAt: new Date(T0).toISOString(),
    endedAt: new Date(T0 + 60_000).toISOString(),
    allowedTools: ["mcp__smailtalk__create_app", "ToolSearch"],
    disallowedTools: ["Bash", "Read"],
    expectedAbsentTools: ["Bash", "Read"],
    turns: ["管理画面を作って。", "履歴も見たい。"],
    argv: [[], []],
    snapshots: [
      snap("before", 1, empty),
      snap("after", 1, written),
      snap("before", 2, written),
      snap("after", 2, written),
    ],
    ...overrides,
  };
}

describe("judgeTrial: 本命(変化が transcript で説明できるか)", () => {
  test("説明できる変化しか無ければ valid", () => {
    const report = judgeTrial(cleanMeta(), fixture("clean.stream.jsonl"));
    expect(report.violations).toEqual([]);
    expect(report.verdict).toBe("valid");
  });

  test("呼ばれていないアプリのファイルが変わっていたら検証無効", () => {
    const meta = cleanMeta();
    const last = meta.snapshots[3];
    if (last === undefined) throw new Error("fixture broken");
    last.files = [...last.files, file("apps/手で作ったアプリ/manifest.json", "zz")];
    const report = judgeTrial(meta, fixture("clean.stream.jsonl"));
    expect(report.verdict).toBe("invalid");
    expect(report.violations.map((v) => v.code)).toContain("unexplained_change");
    expect(report.violations[0]?.detail).toContain("手で作ったアプリ");
  });

  test("レイアウトに無いパスが増えていたら検証無効", () => {
    const meta = cleanMeta();
    const last = meta.snapshots[3];
    if (last === undefined) throw new Error("fixture broken");
    last.files = [...last.files, file("stray.sql", "zz")];
    const report = judgeTrial(meta, fixture("clean.stream.jsonl"));
    expect(report.violations.map((v) => v.code)).toContain("unexplained_change");
  });

  test("ツールを1つも呼んでいないのにファイルが変わっていたら検証無効", () => {
    const meta = cleanMeta();
    const report = judgeTrial(meta, fixture("refusal.stream.jsonl"));
    expect(report.verdict).toBe("invalid");
    expect(report.violations.map((v) => v.code)).toContain("unexplained_change");
  });

  test("ターンとターンの間にファイルが変わっていたら検証無効(会話の外での改変)", () => {
    const meta = cleanMeta();
    const before2 = meta.snapshots[2];
    if (before2 === undefined) throw new Error("fixture broken");
    before2.files = [...before2.files, file("apps/platform-admin/app.sqlite", "手動")];
    const report = judgeTrial(meta, fixture("clean.stream.jsonl"));
    expect(report.violations.map((v) => v.code)).toContain("change_between_turns");
  });

  test("変化した mtime が実行時間帯の外なら検証無効", () => {
    const meta = cleanMeta();
    const last = meta.snapshots[3];
    const mid = meta.snapshots[1];
    if (last === undefined || mid === undefined) throw new Error("fixture broken");
    const stale = file("apps/platform-admin/manifest.json", "m1", T0 - 86_400_000);
    last.files = [file("kernel.sqlite", "k2"), stale];
    mid.files = last.files;
    meta.snapshots[2] = snap("before", 2, last.files);
    const report = judgeTrial(meta, fixture("clean.stream.jsonl"));
    expect(report.violations.map((v) => v.code)).toContain("mtime_outside_run");
  });

  test("変化が無く書き込みも無ければ valid", () => {
    const meta = cleanMeta({
      snapshots: [snap("before", 1, []), snap("after", 1, [])],
      turns: ["ボタンの色を変えて。"],
    });
    const report = judgeTrial(meta, fixture("refusal.stream.jsonl"));
    expect(report.verdict).toBe("valid");
  });
});

describe("judgeTrial: 実効ツール一覧(設定値ではなく効いた値)", () => {
  test("ファイル系ツールが実効一覧にあれば検証無効", () => {
    const meta = cleanMeta({
      turns: ["型の一覧を教えて。"],
      snapshots: [snap("before", 1, []), snap("after", 1, [])],
    });
    const report = judgeTrial(meta, fixture("leaky-tools.stream.jsonl"));
    expect(report.verdict).toBe("invalid");
    const codes = report.violations.map((v) => v.code);
    expect(codes).toContain("forbidden_tool_effective");
    expect(codes).toContain("expected_absent_tool_present");
    expect(report.violations.find((v) => v.code === "forbidden_tool_effective")?.detail).toContain(
      "Grep",
    );
  });

  test("実効ツール一覧を抽出してレポートに載せる", () => {
    const report = judgeTrial(cleanMeta(), fixture("clean.stream.jsonl"));
    expect(report.extraction.effectiveTools).toEqual([
      {
        turn: 1,
        tools: [
          "ToolSearch",
          "mcp__smailtalk__apply_diff",
          "mcp__smailtalk__create_app",
          "mcp__smailtalk__get_manifest",
          "mcp__smailtalk__list_apps",
        ],
      },
      {
        turn: 2,
        tools: [
          "ToolSearch",
          "mcp__smailtalk__apply_diff",
          "mcp__smailtalk__create_app",
          "mcp__smailtalk__get_manifest",
          "mcp__smailtalk__list_apps",
        ],
      },
    ]);
  });

  test("MCP サーバに繋がっていなければ検証無効", () => {
    const stream =
      '{"type":"system","subtype":"init","tools":["ToolSearch"],"mcp_servers":[{"name":"smailtalk","status":"failed"}]}';
    const meta = cleanMeta({
      turns: ["あ"],
      snapshots: [snap("before", 1, []), snap("after", 1, [])],
    });
    expect(judgeTrial(meta, stream).violations.map((v) => v.code)).toContain(
      "mcp_server_not_connected",
    );
  });
});

describe("judgeTrial: MCP 以外のツールを明示的に許す道(既定では1バイトも変わらない)", () => {
  /** `Skill` が `system/init` の実効ツール一覧に現れる最小の生ログ(1ターン)。 */
  const skillStream =
    '{"type":"system","subtype":"init","tools":["ToolSearch","Skill","mcp__smailtalk__list_apps"],"mcp_servers":[{"name":"smailtalk","status":"connected"}]}';
  /** `Skill` と `Grep` の両方が現れる生ログ。許可の範囲が広がらないことを見る。 */
  const skillAndGrepStream =
    '{"type":"system","subtype":"init","tools":["ToolSearch","Skill","Grep","mcp__smailtalk__list_apps"],"mcp_servers":[{"name":"smailtalk","status":"connected"}]}';

  const oneTurnMeta = (): TrialMeta =>
    cleanMeta({
      turns: ["会員の申し込みを受け付けるアプリを作って。"],
      snapshots: [snap("before", 1, []), snap("after", 1, [])],
      expectedAbsentTools: [],
    });

  test("既定(第3引数なし)では Skill は違反であり続ける", () => {
    const report = judgeTrial(oneTurnMeta(), skillStream);
    expect(report.verdict).toBe("invalid");
    const violation = report.violations.find((v) => v.code === "forbidden_tool_effective");
    expect(violation?.detail).toBe("Skill");
    expect(violation?.message).toContain("cp-5.md §0-(a) の隔離条件");
  });

  test("空のオプションを渡しても、既定と同じく Skill は違反である", () => {
    const report = judgeTrial(oneTurnMeta(), skillStream, {});
    expect(report.verdict).toBe("invalid");
    expect(report.violations.map((v) => v.code)).toContain("forbidden_tool_effective");
  });

  test("空配列を渡しても、既定と同じく Skill は違反である", () => {
    const report = judgeTrial(oneTurnMeta(), skillStream, { additionalAllowedNonMcpTools: [] });
    expect(report.verdict).toBe("invalid");
    expect(report.violations.map((v) => v.code)).toContain("forbidden_tool_effective");
  });

  test("明示的に Skill を許したときだけ、Skill は違反にならない", () => {
    const report = judgeTrial(oneTurnMeta(), skillStream, {
      additionalAllowedNonMcpTools: ["Skill"],
    });
    expect(report.violations).toEqual([]);
    expect(report.verdict).toBe("valid");
  });

  test("Skill を許しても、他の非 MCP ツール(Grep)は違反のままである", () => {
    const report = judgeTrial(oneTurnMeta(), skillAndGrepStream, {
      additionalAllowedNonMcpTools: ["Skill"],
    });
    expect(report.verdict).toBe("invalid");
    const violation = report.violations.find((v) => v.code === "forbidden_tool_effective");
    expect(violation?.detail).toBe("Grep");
  });

  test("許可しても、実効一覧はそのまま抽出に残る(記録を消さない)", () => {
    const report = judgeTrial(oneTurnMeta(), skillStream, {
      additionalAllowedNonMcpTools: ["Skill"],
    });
    expect(report.extraction.effectiveTools[0]?.tools).toContain("Skill");
  });

  test("expectedAbsentTools に Skill があれば、許可しても別の違反として残る", () => {
    const meta = cleanMeta({
      turns: ["a"],
      snapshots: [snap("before", 1, []), snap("after", 1, [])],
      expectedAbsentTools: ["Skill"],
    });
    const report = judgeTrial(meta, skillStream, { additionalAllowedNonMcpTools: ["Skill"] });
    expect(report.verdict).toBe("invalid");
    expect(report.violations.map((v) => v.code)).toEqual(["expected_absent_tool_present"]);
  });
});

describe("judgeTrial: ListAgents も同じ口で許せる(V6-M14c。既定では違反のまま)", () => {
  /** `ListAgents` が `system/init` の実効ツール一覧に現れる最小の生ログ(1ターン)。 */
  const listAgentsStream =
    '{"type":"system","subtype":"init","tools":["ListAgents","ToolSearch","mcp__smailtalk__list_apps"],"mcp_servers":[{"name":"smailtalk","status":"connected"}]}';
  /** `Skill` と `ListAgents` の両方が現れる生ログ(腕C の11試行がこの形である)。 */
  const skillAndListAgentsStream =
    '{"type":"system","subtype":"init","tools":["ListAgents","Skill","ToolSearch","mcp__smailtalk__list_apps"],"mcp_servers":[{"name":"smailtalk","status":"connected"}]}';
  /** `ListAgents` と `Grep` の両方が現れる生ログ。許可の範囲が広がらないことを見る。 */
  const listAgentsAndGrepStream =
    '{"type":"system","subtype":"init","tools":["ListAgents","Grep","ToolSearch","mcp__smailtalk__list_apps"],"mcp_servers":[{"name":"smailtalk","status":"connected"}]}';

  const oneTurnMeta = (): TrialMeta =>
    cleanMeta({
      turns: ["会員の申し込みを受け付けるアプリを作って。"],
      snapshots: [snap("before", 1, []), snap("after", 1, [])],
      expectedAbsentTools: [],
    });

  test("既定(第3引数なし)では ListAgents は違反であり続ける", () => {
    const report = judgeTrial(oneTurnMeta(), listAgentsStream);
    expect(report.verdict).toBe("invalid");
    const violation = report.violations.find((v) => v.code === "forbidden_tool_effective");
    expect(violation?.detail).toBe("ListAgents");
    expect(violation?.message).toContain("cp-5.md §0-(a) の隔離条件");
  });

  test("空のオプションを渡しても、既定と同じく ListAgents は違反である", () => {
    const report = judgeTrial(oneTurnMeta(), listAgentsStream, {});
    expect(report.verdict).toBe("invalid");
    expect(report.violations.map((v) => v.code)).toContain("forbidden_tool_effective");
  });

  test("空配列を渡しても、既定と同じく ListAgents は違反である", () => {
    const report = judgeTrial(oneTurnMeta(), listAgentsStream, {
      additionalAllowedNonMcpTools: [],
    });
    expect(report.verdict).toBe("invalid");
    expect(report.violations.map((v) => v.code)).toContain("forbidden_tool_effective");
  });

  test("Skill だけを許しても、ListAgents は違反のままである", () => {
    const report = judgeTrial(oneTurnMeta(), skillAndListAgentsStream, {
      additionalAllowedNonMcpTools: ["Skill"],
    });
    expect(report.verdict).toBe("invalid");
    expect(report.violations.find((v) => v.code === "forbidden_tool_effective")?.detail).toBe(
      "ListAgents",
    );
  });

  test("明示的に ListAgents を許したときだけ、ListAgents は違反にならない", () => {
    const report = judgeTrial(oneTurnMeta(), listAgentsStream, {
      additionalAllowedNonMcpTools: ["ListAgents"],
    });
    expect(report.violations).toEqual([]);
    expect(report.verdict).toBe("valid");
  });

  test("Skill と ListAgents を同時に許すと、どちらも違反にならない", () => {
    const report = judgeTrial(oneTurnMeta(), skillAndListAgentsStream, {
      additionalAllowedNonMcpTools: ["Skill", "ListAgents"],
    });
    expect(report.violations).toEqual([]);
    expect(report.verdict).toBe("valid");
  });

  test("ListAgents を許しても、他の非 MCP ツール(Grep)は違反のままである", () => {
    const report = judgeTrial(oneTurnMeta(), listAgentsAndGrepStream, {
      additionalAllowedNonMcpTools: ["ListAgents"],
    });
    expect(report.verdict).toBe("invalid");
    expect(report.violations.find((v) => v.code === "forbidden_tool_effective")?.detail).toBe(
      "Grep",
    );
  });

  test("許可しても、ListAgents はそのまま抽出に残る(記録を消さない)", () => {
    const report = judgeTrial(oneTurnMeta(), listAgentsStream, {
      additionalAllowedNonMcpTools: ["ListAgents"],
    });
    expect(report.extraction.effectiveTools[0]?.tools).toContain("ListAgents");
  });

  test("expectedAbsentTools に ListAgents があれば、許可しても別の違反として残る", () => {
    const meta = cleanMeta({
      turns: ["a"],
      snapshots: [snap("before", 1, []), snap("after", 1, [])],
      expectedAbsentTools: ["ListAgents"],
    });
    const report = judgeTrial(meta, listAgentsStream, {
      additionalAllowedNonMcpTools: ["ListAgents"],
    });
    expect(report.verdict).toBe("invalid");
    expect(report.violations.map((v) => v.code)).toEqual(["expected_absent_tool_present"]);
  });

  test("3本の腕に同じ規則を当てるための語は Skill と ListAgents の2語だけである", () => {
    expect(SKILL_TRIAL_ALLOWED_NON_MCP_TOOLS).toEqual(["Skill", "ListAgents"]);
  });

  test("その2語は、渡さない限り1バイトも効かない(既定は今日どおり)", () => {
    expect(judgeTrial(oneTurnMeta(), skillAndListAgentsStream).verdict).toBe("invalid");
    expect(
      judgeTrial(oneTurnMeta(), skillAndListAgentsStream, {
        additionalAllowedNonMcpTools: SKILL_TRIAL_ALLOWED_NON_MCP_TOOLS,
      }).verdict,
    ).toBe("valid");
  });

  test("環境変数からも同じ2語を渡せる(CLI の口)", () => {
    expect(parseAllowedNonMcpToolsEnv("Skill,ListAgents")).toEqual([
      ...SKILL_TRIAL_ALLOWED_NON_MCP_TOOLS,
    ]);
  });
});

describe("parseAllowedNonMcpToolsEnv(CLI の有効化口。既定は空)", () => {
  test("未設定なら空", () => {
    expect(parseAllowedNonMcpToolsEnv(undefined)).toEqual([]);
  });

  test("空文字列なら空", () => {
    expect(parseAllowedNonMcpToolsEnv("")).toEqual([]);
    expect(parseAllowedNonMcpToolsEnv("   ")).toEqual([]);
  });

  test("1本なら1本", () => {
    expect(parseAllowedNonMcpToolsEnv("Skill")).toEqual(["Skill"]);
  });

  test("カンマ区切りと前後の空白を許す", () => {
    expect(parseAllowedNonMcpToolsEnv(" Skill , ListAgents ")).toEqual(["Skill", "ListAgents"]);
  });

  test("空の要素は落とす", () => {
    expect(parseAllowedNonMcpToolsEnv("Skill,,")).toEqual(["Skill"]);
  });
});

describe("judgeTrial: 人間ターンの本文", () => {
  test("プロンプトに JSON が貼られていたら検証無効", () => {
    const meta = cleanMeta({ turns: ["管理画面を作って。", '{"op":"add_table"} を適用して。'] });
    const report = judgeTrial(meta, fixture("clean.stream.jsonl"));
    expect(report.verdict).toBe("invalid");
    expect(report.violations.map((v) => v.code)).toContain("prompt_contains_code");
  });
});

describe("judgeTrial: 証跡の欠落", () => {
  test("init の数と人間ターン数が合わなければ検証無効", () => {
    const meta = cleanMeta({ turns: ["1", "2", "3"] });
    expect(judgeTrial(meta, fixture("clean.stream.jsonl")).violations.map((v) => v.code)).toContain(
      "evidence_missing",
    );
  });

  test("スナップショットが足りなければ検証無効", () => {
    const meta = cleanMeta({ snapshots: [] });
    expect(judgeTrial(meta, fixture("clean.stream.jsonl")).violations.map((v) => v.code)).toContain(
      "evidence_missing",
    );
  });

  test("生ログに壊れた行があれば検証無効", () => {
    const meta = cleanMeta({
      turns: ["あ"],
      snapshots: [snap("before", 1, []), snap("after", 1, [])],
    });
    const broken = `{"type":"system","subtype":"init","tools":["ToolSearch"],"mcp_servers":[{"name":"smailtalk","status":"connected"}]}\n{壊れ\n`;
    expect(judgeTrial(meta, broken).violations.map((v) => v.code)).toContain("evidence_missing");
  });
});

describe("judgeTrial: V0-P6-T04 のための機械抽出", () => {
  test("ツール一覧と回数・エラー・やり直し・人間ターンを出す", () => {
    const meta = cleanMeta({
      turns: ["本の記録アプリを作って。"],
      snapshots: [snap("before", 1, []), snap("after", 1, [])],
    });
    const { extraction } = judgeTrial(meta, fixture("error-then-fix.stream.jsonl"));
    expect(extraction.toolUsage).toEqual([
      { name: "ToolSearch", count: 1, errorCount: 0 },
      { name: "mcp__smailtalk__apply_diff", count: 3, errorCount: 2 },
    ]);
    expect(extraction.errorEpisodes.length).toBe(2);
    expect(extraction.errorEpisodes[0]?.selfCorrected).toBe(true);
    expect(extraction.retries).toEqual([
      { tool: "mcp__smailtalk__apply_diff", turn: 1, attempts: 3, succeeded: true },
    ]);
    expect(extraction.humanTurns).toEqual([{ turn: 1, text: "本の記録アプリを作って。" }]);
  });

  test("拒否の候補を抽出する", () => {
    const meta = cleanMeta({
      turns: ["ボタンの色を変えて。"],
      snapshots: [snap("before", 1, []), snap("after", 1, [])],
    });
    const { extraction } = judgeTrial(meta, fixture("refusal.stream.jsonl"));
    expect(extraction.refusals.length).toBe(1);
    expect(extraction.refusals[0]?.kinds).toContain("capability_denial");
    expect(extraction.refusals[0]?.requested).toContain("ボタンの色");
  });

  test("judge は人間ターン本文を断り判定の入力に渡す(条件2「何に対する断りか」)", () => {
    const meta = cleanMeta({
      turns: ["本に本棚への参照の項目を足して。現状の確認はいらないので、そのまま適用して。"],
      snapshots: [snap("before", 1, []), snap("after", 1, [])],
    });
    const { extraction } = judgeTrial(meta, fixture("refusal-withheld.stream.jsonl"));
    expect(extraction.refusals.length).toBe(1);
    expect(extraction.refusals[0]?.kinds).toContain("action_withheld");
    expect(extraction.refusals[0]?.requested).toContain("そのまま適用して");
  });

  test("説明できた変化も対応付けとして残す", () => {
    const { extraction } = judgeTrial(cleanMeta(), fixture("clean.stream.jsonl"));
    expect(extraction.changeAttribution.map((c) => c.path)).toEqual([
      "apps/platform-admin/manifest.json",
      "kernel.sqlite",
    ]);
    expect(extraction.changeAttribution[0]?.explainedBy.length).toBeGreaterThan(0);
  });

  test("参照系ツールだけで説明が付いた SQLite の変化は警告に出す(無効にはしない)", () => {
    // 実測: list_apps を1回呼ぶだけで kernel.sqlite / -wal / -shm が作られる。
    const meta = cleanMeta({
      turns: ["ボタンの色を変えて。"],
      snapshots: [snap("before", 1, []), snap("after", 1, [file("kernel.sqlite", "k1")])],
    });
    const report = judgeTrial(meta, fixture("refusal.stream.jsonl"));
    expect(report.verdict).toBe("valid");
    expect(report.warnings.join("")).toContain("参照系ツールだけで説明が付いた変化");
    expect(report.extraction.changeAttribution[0]?.weak).toBe(true);
  });

  test("書き込みが成功したのに変化が無ければ警告(無効にはしない)", () => {
    const meta = cleanMeta({
      snapshots: [snap("before", 1, []), snap("after", 1, [])],
      turns: ["a"],
    });
    const report = judgeTrial(meta, fixture("error-then-fix.stream.jsonl"));
    expect(report.verdict).toBe("valid");
    expect(report.warnings.join("")).toContain("ファイル変化が観測されていません");
  });
});

describe("formatReport のエラー段階表示(V1-M0-T13)", () => {
  const meta = () =>
    cleanMeta({
      turns: ["サンプルを入れて。"],
      snapshots: [snap("before", 1, []), snap("after", 1, [])],
    });

  test("段階別の内訳を1行で出す", () => {
    const text = formatReport(judgeTrial(meta(), fixture("input-parse-error.stream.jsonl")));
    expect(text).toContain("内訳: server 1件 / input-parse 1件");
  });

  test("input-parse の episode は「MCP 未到達(入力パース層)」と明示する", () => {
    const text = formatReport(judgeTrial(meta(), fixture("input-parse-error.stream.jsonl")));
    expect(text).toContain("MCP 未到達(入力パース層)");
    expect(text).toContain("F-17 / F-24 に該当");
    expect(text).toContain("MCP サーバ・カーネルのどちらでも防げない層");
  });

  test("input-parse が無ければ注記は出さない", () => {
    const text = formatReport(
      judgeTrial(
        cleanMeta({ turns: ["a"], snapshots: [snap("before", 1, []), snap("after", 1, [])] }),
        fixture("error-then-fix.stream.jsonl"),
      ),
    );
    expect(text).toContain("内訳: server 2件 / input-parse 0件");
    expect(text).not.toContain("F-17 / F-24 に該当");
  });
});
