/**
 * `claude` CLI の起動条件をコードに固定する(純関数)。
 *
 * CP-5 の実地検証は、**この起動条件が守られて初めて成立した**。最初の試行では AI が
 * `Grep` でリポジトリの `src/kernel/types.ts` を読み、ツール説明文ではなくソースから
 * 語彙を学習していた(docs/evidence/cp-5.md §0-(a))。その隔離条件が口伝だったので、
 * ここで**破れない形**にする ―― 条件を満たさない引数はそもそも組み立てられない。
 *
 * `ToolSearch` を allow に残しているのは意図的である。禁止されたツールを AI が試して
 * `No matching deferred tools found` を受け取る様子が生ログに残ることで、
 * **「禁止が効いている」ことが証拠として観測できる**(cp-5.md:20 と :34)。
 */
import { basename, resolve } from "node:path";

/** ファイル系ツールのうち、最低限これだけは禁止されていないと検証が成立しない。 */
export const REQUIRED_DISALLOWED_TOOLS = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Grep",
  "Glob",
  "Task",
  "WebFetch",
  "WebSearch",
] as const;

export interface ClaudeArgsOptions {
  prompt: string;
  mcpConfigPath: string;
  allowedTools: string[];
  disallowedTools: string[];
  /** 会話を1本に繋ぐセッションID。 */
  sessionId: string;
  /** 1始まりのターン番号。1なら `--session-id`、2以降なら `--resume`。 */
  turn: number;
}

/** 評価専用 .mcp.json の形。 */
export interface McpConfig {
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
}

/** `claude` に渡す引数を組み立てる。条件を満たさなければ例外を投げる。 */
export function buildClaudeArgs(options: ClaudeArgsOptions): string[] {
  if (options.allowedTools.length === 0) {
    throw new Error("--allowedTools を必ず指定してください(空にはできません)。");
  }
  if (options.disallowedTools.length === 0) {
    throw new Error("--disallowedTools を必ず指定してください(空にはできません)。");
  }
  if (!options.allowedTools.includes("ToolSearch")) {
    throw new Error(
      "allowedTools に ToolSearch を含めてください。含めないと、AI が禁止ツールを試して弾かれた様子が生ログに残らず、禁止が効いている証拠が取れません(cp-5.md:34)。",
    );
  }
  const missing = REQUIRED_DISALLOWED_TOOLS.filter((t) => !options.disallowedTools.includes(t));
  if (missing.length > 0) {
    throw new Error(
      `disallowedTools に次のツールが足りません(ソースから語彙を学習されると検証が無効になります): ${missing.join(", ")}`,
    );
  }

  const args = [
    "-p",
    options.prompt,
    "--mcp-config",
    options.mcpConfigPath,
    "--strict-mcp-config",
    "--allowedTools",
    ...options.allowedTools,
    "--disallowedTools",
    ...options.disallowedTools,
    "--output-format",
    "stream-json",
    "--verbose",
  ];
  // ターン1でセッションIDを固定し、以降は同じIDを resume する。こうすると
  // 複数ターンの生ログを1会話として連結できる(CP-5 のシナリオは3ターンを繋いでいた)。
  args.push(options.turn === 1 ? "--session-id" : "--resume", options.sessionId);
  return args;
}

/** 説明書(skill)を開ける腕か、開けない腕か。 */
export type SkillArm = "allow" | "deny";

/**
 * 説明書(skill)の腕を組み立てる(純関数)。
 *
 * シナリオ `shared-lending-app` は `Skill` を `allowed_tools` にも `disallowed_tools` にも
 * 書かない。**同じ1本のシナリオファイルから2腕を組み立てる**ためであり、腕の別はここで付ける
 * (走行の間だけ front matter を書き換えてあとで戻す形は採らない)。
 *
 * **足すだけで、1本も外さない。** だから `REQUIRED_DISALLOWED_TOOLS` の9本は自然に残るが、
 * 「自然に残る」ことに寄りかからず、テストで実際に確かめてある。
 *
 * **矛盾した腕は組み立てない** —— `allow` の腕なのに禁止側に `Skill` が居ると、
 * `claude` がどちらを採るかはこちらの保証の外にある。**保証できないものを黙って渡さない。**
 */
export function applySkillArm(
  allowed: string[],
  disallowed: string[],
  arm: SkillArm,
): { allowedTools: string[]; disallowedTools: string[] } {
  const inAllowed = allowed.includes("Skill");
  const inDisallowed = disallowed.includes("Skill");
  if (arm === "allow" && inDisallowed) {
    throw new Error(
      "--skill allow を指定しましたが、シナリオの disallowed_tools に既に Skill があります。" +
        "どちらが効くかは保証できないので、組み立てません。",
    );
  }
  if (arm === "deny" && inAllowed) {
    throw new Error(
      "--skill deny を指定しましたが、シナリオの allowed_tools に既に Skill があります。" +
        "どちらが効くかは保証できないので、組み立てません。",
    );
  }
  // 入力配列は破壊しない(呼び出し側の `scenario` は使い回される)。
  return arm === "allow"
    ? {
        allowedTools: inAllowed ? [...allowed] : [...allowed, "Skill"],
        disallowedTools: [...disallowed],
      }
    : {
        allowedTools: [...allowed],
        disallowedTools: inDisallowed ? [...disallowed] : [...disallowed, "Skill"],
      };
}

/**
 * リポジトリの `.mcp.json` を読んで、`ST_DATA_ROOT` だけを評価用に差し替えた
 * 一時設定を作る。**コミットされている `.mcp.json` は変更しない**(cp-5.md 逸脱3)。
 *
 * `actor` を渡すと `ST_MCP_ACTOR` も差し替える。**渡さないときの出力は1バイトも変わらない**
 * (既存34本のシナリオはこの経路で走り続ける)。
 *
 * リポジトリの `.mcp.json` は `ST_MCP_ACTOR` を**空の欄**として持っているので、
 * 差し替えないまま走らせると `src/mcp/actor-guard.ts` が全ツールを
 * 「名乗っていません」で断る。**空文字を渡したときに例外にするのはそのためである** ——
 * 「名乗りを指定したつもりで空だった」が、走らせてから全ツール失敗として現れるのは遅すぎる。
 */
export function buildMcpConfig(source: string, dataRoot: string, actor?: string): McpConfig {
  const name = basename(resolve(dataRoot));
  if (name === "data") {
    throw new Error(`評価用の ST_DATA_ROOT にリポジトリの data/ は使えません: ${dataRoot}`);
  }
  if (actor !== undefined && actor.trim() === "") {
    throw new Error(
      "名乗り(ST_MCP_ACTOR)に空文字・空白だけは指定できません。" +
        "そのアプリに登録済みのログイン名または利用者IDを渡してください。",
    );
  }
  const parsed = JSON.parse(source) as McpConfig;
  const server = parsed.mcpServers.smailtalk;
  if (server === undefined) {
    throw new Error(".mcp.json に smailtalk サーバの定義がありません。");
  }
  return {
    mcpServers: {
      ...parsed.mcpServers,
      smailtalk: {
        ...server,
        env: {
          ...server.env,
          ST_DATA_ROOT: dataRoot,
          ...(actor === undefined ? {} : { ST_MCP_ACTOR: actor }),
        },
      },
    },
  };
}
