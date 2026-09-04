import { describe, expect, test } from "bun:test";
import {
  applySkillArm,
  buildClaudeArgs,
  buildMcpConfig,
  REQUIRED_DISALLOWED_TOOLS,
} from "./cli-args.ts";

const base = {
  prompt: "アプリを作って。",
  mcpConfigPath: "/tmp/trial/mcp.json",
  allowedTools: ["mcp__smailtalk__create_app", "ToolSearch"],
  disallowedTools: [
    "Bash",
    "Read",
    "Write",
    "Edit",
    "Grep",
    "Glob",
    "Task",
    "WebFetch",
    "WebSearch",
  ],
  sessionId: "11111111-1111-4111-8111-111111111111",
};

describe("buildClaudeArgs", () => {
  test("起動条件をコードに固定する(cp-5.md §0 の実コマンドの踏襲)", () => {
    const args = buildClaudeArgs({ ...base, turn: 1 });
    expect(args).toEqual([
      "-p",
      "アプリを作って。",
      "--mcp-config",
      "/tmp/trial/mcp.json",
      "--strict-mcp-config",
      "--allowedTools",
      "mcp__smailtalk__create_app",
      "ToolSearch",
      "--disallowedTools",
      "Bash",
      "Read",
      "Write",
      "Edit",
      "Grep",
      "Glob",
      "Task",
      "WebFetch",
      "WebSearch",
      "--output-format",
      "stream-json",
      "--verbose",
      "--session-id",
      "11111111-1111-4111-8111-111111111111",
    ]);
  });

  test("2ターン目以降は --resume で1会話として繋ぐ", () => {
    const args = buildClaudeArgs({ ...base, turn: 3 });
    expect(args).toContain("--resume");
    expect(args).not.toContain("--session-id");
    expect(args[args.indexOf("--resume") + 1]).toBe(base.sessionId);
  });

  test("allowedTools と disallowedTools は必ず両方指定する", () => {
    expect(() => buildClaudeArgs({ ...base, turn: 1, allowedTools: [] })).toThrow(/allowedTools/);
    expect(() => buildClaudeArgs({ ...base, turn: 1, disallowedTools: [] })).toThrow(
      /disallowedTools/,
    );
  });

  test("ToolSearch を allowedTools に含めないと落ちる(禁止が効いた証拠が残らないため)", () => {
    expect(() =>
      buildClaudeArgs({ ...base, turn: 1, allowedTools: ["mcp__smailtalk__create_app"] }),
    ).toThrow(/ToolSearch/);
  });

  test("ファイル系ツールを禁止し忘れたら落ちる", () => {
    expect(() => buildClaudeArgs({ ...base, turn: 1, disallowedTools: ["Bash"] })).toThrow(/Read/);
  });
});

describe("buildMcpConfig", () => {
  test("リポジトリの .mcp.json の ST_DATA_ROOT だけを差し替える", () => {
    const source = JSON.stringify({
      mcpServers: {
        smailtalk: {
          command: "mise",
          args: ["exec", "--", "bun", "run", "src/mcp/index.ts"],
          env: { ST_DATA_ROOT: "data", ST_PREVIEW_BASE_URL: "http://127.0.0.1:3000" },
        },
      },
    });
    const config = buildMcpConfig(source, "data-cp6");
    expect(config.mcpServers.smailtalk?.env.ST_DATA_ROOT).toBe("data-cp6");
    expect(config.mcpServers.smailtalk?.env.ST_PREVIEW_BASE_URL).toBe("http://127.0.0.1:3000");
    expect(config.mcpServers.smailtalk?.command).toBe("mise");
  });

  test("リポジトリの data/ は差し替え先にできない", () => {
    const source = JSON.stringify({
      mcpServers: { smailtalk: { command: "mise", args: [], env: {} } },
    });
    expect(() => buildMcpConfig(source, "data")).toThrow(/data\//);
  });

  test("smailtalk が定義されていなければ落ちる", () => {
    expect(() => buildMcpConfig(JSON.stringify({ mcpServers: {} }), "data-cp6")).toThrow(
      /smailtalk/,
    );
  });
});

/**
 * 名乗り(`ST_MCP_ACTOR`)を評価用の設定に流し込む。
 *
 * `V8-M31` 以降、アプリを名指しする MCP ツールは「**名乗った利用者がそのアプリに
 * 登録されていること**」を要求する(`src/mcp/actor-guard.ts`)。リポジトリの `.mcp.json` は
 * `ST_MCP_ACTOR` を**空の欄**として持っている(`D-V8-84`)ので、
 * **差し替えないまま走らせると24本のツールが全部「名乗っていません」で落ちる。**
 */
describe("buildMcpConfig(actor)", () => {
  const source = JSON.stringify({
    mcpServers: {
      smailtalk: {
        command: "mise",
        args: ["exec", "--", "bun", "run", "src/mcp/index.ts"],
        env: {
          ST_DATA_ROOT: "data",
          ST_PREVIEW_BASE_URL: "http://localhost:3000",
          ST_MCP_ACTOR: "",
        },
      },
    },
  });

  test("第3引数を渡すと ST_MCP_ACTOR がその名乗りになる", () => {
    const config = buildMcpConfig(source, "data-shared-lending-app", "unei");
    expect(config.mcpServers.smailtalk?.env.ST_MCP_ACTOR).toBe("unei");
    // 名乗りを足しても、これまでの差し替え(ST_DATA_ROOT)と他の欄は変わらない。
    expect(config.mcpServers.smailtalk?.env.ST_DATA_ROOT).toBe("data-shared-lending-app");
    expect(config.mcpServers.smailtalk?.env.ST_PREVIEW_BASE_URL).toBe("http://localhost:3000");
  });

  test("名乗りを渡さないときの出力は今日と1バイトも変わらない", () => {
    // 既存34本のシナリオは第3引数を渡さない経路で走る。**そこを1バイトも動かさない**ことを
    // 直列化した文字列で押さえる(キーの順序まで含めて比較する)。
    expect(JSON.stringify(buildMcpConfig(source, "data-cp6"))).toBe(
      JSON.stringify({
        mcpServers: {
          smailtalk: {
            command: "mise",
            args: ["exec", "--", "bun", "run", "src/mcp/index.ts"],
            env: {
              ST_DATA_ROOT: "data-cp6",
              ST_PREVIEW_BASE_URL: "http://localhost:3000",
              ST_MCP_ACTOR: "",
            },
          },
        },
      }),
    );
  });

  test("空文字・空白だけの名乗りは黙って通さない", () => {
    expect(() => buildMcpConfig(source, "data-cp6", "")).toThrow(/ST_MCP_ACTOR/);
    expect(() => buildMcpConfig(source, "data-cp6", "   ")).toThrow(/ST_MCP_ACTOR/);
  });
});

/**
 * 説明書(skill)の腕を組み立てる。
 *
 * シナリオ `shared-lending-app` は `Skill` をどちらのリストにも書かない。
 * **同じ1本のファイルから2腕を組み立てる**ため、腕の別はここで付ける。
 */
describe("applySkillArm", () => {
  const allowed = ["mcp__smailtalk__apply_diff", "ToolSearch"];
  const disallowed = [...REQUIRED_DISALLOWED_TOOLS];

  test("allow の腕は allowedTools の末尾に Skill を足す", () => {
    const arm = applySkillArm(allowed, disallowed, "allow");
    expect(arm.allowedTools).toEqual(["mcp__smailtalk__apply_diff", "ToolSearch", "Skill"]);
    expect(arm.disallowedTools).toEqual(disallowed);
  });

  test("deny の腕は disallowedTools の末尾に Skill を足す", () => {
    const arm = applySkillArm(allowed, disallowed, "deny");
    expect(arm.disallowedTools).toEqual([...disallowed, "Skill"]);
    expect(arm.allowedTools).toEqual(allowed);
  });

  test("入力の配列を破壊しない", () => {
    const a = [...allowed];
    const d = [...disallowed];
    applySkillArm(a, d, "allow");
    applySkillArm(a, d, "deny");
    expect(a).toEqual(allowed);
    expect(d).toEqual(disallowed);
  });

  test("すでに Skill が入っている側には二重に足さない", () => {
    const arm = applySkillArm([...allowed, "Skill"], disallowed, "allow");
    expect(arm.allowedTools.filter((t) => t === "Skill")).toHaveLength(1);
    const denied = applySkillArm(allowed, [...disallowed, "Skill"], "deny");
    expect(denied.disallowedTools.filter((t) => t === "Skill")).toHaveLength(1);
  });

  test("腕と反対側に Skill が入っていたら落とす(矛盾した腕を黙って組み立てない)", () => {
    expect(() => applySkillArm(allowed, [...disallowed, "Skill"], "allow")).toThrow(/Skill/);
    expect(() => applySkillArm([...allowed, "Skill"], disallowed, "deny")).toThrow(/Skill/);
  });

  test("どちらの腕でも禁止9本を1本も落とさない", () => {
    for (const arm of ["allow", "deny"] as const) {
      const applied = applySkillArm(allowed, disallowed, arm);
      for (const tool of REQUIRED_DISALLOWED_TOOLS) {
        expect(applied.disallowedTools).toContain(tool);
      }
      // 組み立てた腕がそのまま `claude` の引数になることまで確かめる
      // (禁止9本の検査は buildClaudeArgs が持っている)。
      expect(() =>
        buildClaudeArgs({
          ...base,
          turn: 1,
          allowedTools: applied.allowedTools,
          disallowedTools: applied.disallowedTools,
        }),
      ).not.toThrow();
    }
  });
});
