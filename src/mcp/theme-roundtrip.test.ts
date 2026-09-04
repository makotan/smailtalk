/**
 * テーマ指定の**往復回数とリクエストの大きさの実測**(V3-M1-T07 / 計画 §4-8)。
 *
 * 完了条件の正は `docs/plan/v3/records/v3-m1.md` §4-8 ——
 * 「**テーマ指定の1往復で何を指定でき、拒否によって何往復増えたかを実測して記録する。
 * 『素早くなった』と総括しない**(CP-V3 = V3-M7 の §8-3 への入力になる)」。
 * 実測結果の記録は `docs/plan/v3/records/v3-m1-t07.md` §3 である。
 *
 * ## なぜこの検査が要るのか(起票の理由)
 *
 * **T00〜T06 のどの葉タスクも §4-8 を引き受けていなかった。** T04 は自ら
 * 「本タスクは往復回数を測っていない」と申告し、T05 は再適用の手数(`1 + 2N` 往復)
 * だけを測っている。**加えて `docs/adr/0047-app-theme-manifest.md` の 2026-07-25 追記(2)が
 * 「(全スロット必須にした)代償を §4-8 の実測に含めること」を明文で要求している。**
 *
 * ## なぜ `src/mcp/` に在るのか(置き場の理由)
 *
 * **測っているのは MCP ツールの往復とエラーの自己修正性である。** 直接の比較対象
 * (`src/mcp/error-self-correction.test.ts`)が同じディレクトリに在り、接続の作法も
 * そこから借りている。**T05 が `web/test/theme-template.test.ts` に置かざるを得なかったのは
 * 門外(Δ7)の条件「`src/` を1バイトも変えない」による妥協であり**(T05 の記録 §12 (g))、
 * **T07 にはその制約が無い** —— T07 の禁止は `src/kernel/` と `schemas/` である。
 *
 * ## 何を import しないか
 *
 * **`src/kernel/` から値を1つも import しない**(`import type` だけ)。
 * `scripts/kernel-import-snapshot.txt` は T07 が触ってよいファイルではないので、
 * 値 import を1つでも足すと `scripts/kernel-import-drift.test.ts` が赤くなる。
 * スロット名と既定値は**ファイルとして読む**(`schemas/manifest.schema.json` /
 * `web/src/styles.css`)—— T06 が歯止めで採った作法と同じである。
 *
 * ## 「エラーだけを読んで直す」の機械的な定義
 *
 * `error-self-correction.test.ts` の作法を借りる —— **修正版を組み立てるヘルパは
 * `ValidationError` の `path` / `message` / `allowed_values` / `hint` しか読まない。**
 * テスト外の知識(正しいスロット名・通る色の値)をリテラルで書いた時点で、
 * それは「エラーだけで直せた」の証明にならない。**足りなければ足りないと書く。**
 *
 * ## 測らないこと(誇張しないための境界)
 *
 * - **画面のことは1つも見ていない**(描画の実測は `web/e2e/theme.e2e.ts` = T04)。
 * - **実際の AI に投げていない。** ここで数えているのは往復の**回数**であって、
 *   AI が実際にその回数で直せるかは別の主張である(本物の LLM を1度も呼んでいない)。
 * - **「素早くなった」も「遅くなった」も、このファイルは主張しない。** 数を出すだけである。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ValidationError } from "../kernel/index.ts";
import { seedSession } from "../server/test-helpers.ts";
import { createMcpServer } from "./server.ts";

const REPO_ROOT = dirname(dirname(import.meta.dir));
const MANIFEST_SCHEMA_PATH = join(REPO_ROOT, "schemas", "manifest.schema.json");
const STYLES_CSS_PATH = join(REPO_ROOT, "web", "src", "styles.css");

const APP_ID = "roundtrip-shop";
const PREVIEW_BASE_URL = "http://127.0.0.1:3000";

/**
 * **【`V8-M31` 第3波。名乗りを足しただけで、期待値は1つも変えていない】**
 *
 * `V8-M31` が MCP に**名乗り**(どの利用者として動くか)を入れたので、
 * `createMcpServer` に `actor` を渡さないと23本のツールがすべて `isError` になる。
 * **このファイルが測っているのは往復の回数とエラーの中身であって、権限ではない** ——
 * よって `seedSession` の既定(`owner`)で1人だけ作り、拒否の理由が
 * 「権限が無い」に化けないようにしてある。
 */
const ACTOR = "mcp-actor";

/** `$defs/theme` の properties キー(**ファイルとして読む**)。 */
function themeSlotNames(): string[] {
  const schema = JSON.parse(readFileSync(MANIFEST_SCHEMA_PATH, "utf-8")) as {
    $defs: { theme: { properties: Record<string, unknown> } };
  };
  return Object.keys(schema.$defs.theme.properties);
}

/**
 * `web/src/styles.css` の `:root` に書かれている**この製品の既定値**を読む。
 *
 * 筋書き (i)(既定配色をそのまま投げる)を「本物の既定値」で測るため。
 * リテラルで書き写すと、`styles.css` が変わった日に静かに嘘になる。
 */
function defaultSlotValues(): Record<string, string> {
  const css = readFileSync(STYLES_CSS_PATH, "utf-8");
  const rootStart = css.indexOf(":root {");
  expect(rootStart, ":root ブロックが見つからない").toBeGreaterThanOrEqual(0);
  const rootEnd = css.indexOf("\n}", rootStart);
  const block = css.slice(rootStart, rootEnd);
  const values: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const match = /^\s*(--[a-z0-9-]+):\s*([^;]+);/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      values[match[1]] = match[2].trim();
    }
  }
  const slots = themeSlotNames();
  const picked: Record<string, string> = {};
  for (const name of slots) {
    const value = values[name];
    expect(value, `${name} の既定値が :root に無い`).toBeDefined();
    picked[name] = String(value);
  }
  return picked;
}

/**
 * コントラスト検査を通る25スロット(**既定配色ではない** —— 既定は必ず拒否される。
 * `docs/adr/0046-design-token-slots.md` の 2026-07-25 追記「限界7」)。
 * 枠線だけを `#767676` に濃くした形は T05 が実測で通している。
 */
function passingSlots(): Record<string, string> {
  return { ...defaultSlotValues(), "--color-border": "#767676" };
}

let dataRoot = "";
let client: Client;
let closeConnection: () => Promise<void>;
/** ツール呼び出しの記録(**往復回数を数値で出すため**)。 */
let calls: string[];

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-theme-roundtrip-"));
  const server = createMcpServer({ dataRoot, previewBaseUrl: PREVIEW_BASE_URL, actor: ACTOR });
  client = new Client({ name: "theme-roundtrip-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  // 逐次 await するとハンドシェイクが噛み合わずデッドロックする(既存テストの注記)。
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  closeConnection = async () => {
    await client.close();
    await server.close();
  };
  await client.callTool({ name: "create_app", arguments: { name: "店", app_id: APP_ID } });
  // **アプリが出来た直後に、名乗った利用者を実在させる**(`create_app` は名乗りだけで通るが、
  // 以降の `apply_diff` / `get_manifest` は「そのアプリに登録済みか」を解決する)。
  seedSession(dataRoot, APP_ID, { username: ACTOR });
  calls = [];
});

afterEach(async () => {
  await closeConnection();
  await rm(dataRoot, { recursive: true, force: true });
});

// --- 往復を数える呼び出しヘルパ ----------------------------------------------------

async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  calls.push(name);
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function errorsOf(result: CallToolResult): ValidationError[] {
  expect(result.isError).toBe(true);
  const structured = result.structuredContent as { errors?: ValidationError[] } | undefined;
  expect(structured?.errors, "structuredContent に errors が無い").toBeDefined();
  return structured?.errors ?? [];
}

let diffCounter = 0;

/** `set_theme` 1操作だけの差分を組む(**テーマの変更は常に1操作である**)。 */
function themeDiff(slots: Record<string, string>): Record<string, unknown> {
  diffCounter += 1;
  return {
    diff_id: `d-${String(diffCounter).padStart(4, "0")}-theme`,
    intent: "このアプリの配色をこだわりどおりにしたい、という要望に応えてテーマを指定した",
    operations: [{ op: "set_theme", theme: { slots } }],
  };
}

/** テーマを1往復投げる。 */
async function sendTheme(slots: Record<string, string>): Promise<CallToolResult> {
  return await call("apply_diff", { app_id: APP_ID, diff: themeDiff(slots) });
}

/** 適用後のマニフェストを読む(**往復には数えない検証用の読み取り**)。 */
async function storedSlots(): Promise<Record<string, string> | undefined> {
  const result = (await client.callTool({
    name: "get_manifest",
    arguments: { app_id: APP_ID },
  })) as CallToolResult;
  const manifest = (result.structuredContent as { manifest?: unknown })?.manifest as
    | { app?: { theme?: { slots?: Record<string, string> } } }
    | undefined;
  return manifest?.app?.theme?.slots;
}

// ===================================================================================
// (1) 1往復で何を指定できるか + リクエストの大きさ
// ===================================================================================

describe("§4-8 (1) 1往復で何を指定できるか", () => {
  test("25スロット全部を1往復(apply_diff 1回)で指定でき、部分テーマは指定できない", async () => {
    const slots = passingSlots();
    expect(Object.keys(slots)).toHaveLength(25);

    const result = await sendTheme(slots);
    expect(result.isError).toBeFalsy();
    // **1往復である。**テーマの適用に要ったツール呼び出しは1回だけ。
    expect(calls).toEqual(["apply_diff"]);
    expect(await storedSlots()).toEqual(slots);
  });

  test("1往復で送る JSON の大きさ —— 25スロット必須の代償(ADR-0047 追記(2))", async () => {
    const slots = passingSlots();
    const themeArgs = { app_id: APP_ID, diff: themeDiff(slots) };
    const themeBytes = Buffer.byteLength(JSON.stringify(themeArgs), "utf-8");
    const themeOnlyBytes = Buffer.byteLength(JSON.stringify({ slots }), "utf-8");

    // 比較対象: 既存語彙のうち最も小さい書き込み操作(フィールドを1本足す)。
    const fieldArgs = {
      app_id: APP_ID,
      diff: {
        diff_id: "d-9001-field",
        intent: "このアプリの配色をこだわりどおりにしたい、という要望に応えてテーマを指定した",
        operations: [
          {
            op: "add_table",
            table: { id: "t", name: "表", fields: [{ id: "f", name: "列", type: "text" }] },
          },
        ],
      },
    };
    const fieldBytes = Buffer.byteLength(JSON.stringify(fieldArgs), "utf-8");

    // **実測値を期待値として固定する**(変わったら差分に出る)。
    expect(themeOnlyBytes).toBe(710);
    expect(themeBytes).toBe(940);
    expect(fieldBytes).toBe(302);
    // 代償の大きさ: テーマ1往復は最小の構造変更の何倍か。
    expect(Math.round((themeBytes / fieldBytes) * 10) / 10).toBe(3.1);
  });

  test("2スロットだけ変えたいときも25スロット全部を送り直す(部分更新の op が無い)", async () => {
    await sendTheme(passingSlots());
    const tweaked = { ...passingSlots(), "--space-4": "1.25rem", "--line-height-base": "1.5" };
    const result = await sendTheme(tweaked);
    expect(result.isError).toBeFalsy();
    // 2スロットの変更でも、送った JSON の大きさは初回とほぼ同じである。
    const bytes = Buffer.byteLength(JSON.stringify({ slots: tweaked }), "utf-8");
    expect(bytes).toBe(713);
    expect(calls).toEqual(["apply_diff", "apply_diff"]);
  });
});

// ===================================================================================
// (2) 拒否で何往復増えるか
// ===================================================================================

describe("§4-8 (2)(i) 既定配色をそのまま投げる", () => {
  test("必ず拒否される —— --color-border の2組。1往復めは常に無駄になる", async () => {
    const errors = errorsOf(await sendTheme(defaultSlotValues()));
    expect(errors).toHaveLength(2);
    for (const error of errors) {
      expect(error.path).toBe("/app/theme/slots/--color-border");
      expect(error.message).toContain("下回ります");
      expect(error.hint).toBeDefined();
      // **コントラストの拒否に allowed_values は無い**(色に有限の許可値が無いため)。
      expect(error.allowed_values).toBeUndefined();
    }
    expect(await storedSlots()).toBeUndefined();
  });

  test("エラーの逐語 —— 現在の比・閾値・両側の色と名前は入っているが、通る候補値は入っていない", async () => {
    const errors = errorsOf(await sendTheme(defaultSlotValues()));
    const messages = errors.map((error) => error.message).sort();
    expect(messages[0]).toBe(
      "前景 --color-border(#ddd)と背景 --color-page-background(#fff)のコントラスト比は 1.36:1 で、非テキスト(枠線・フォーカスリングなど)の閾値 3:1 を下回ります。",
    );
    expect(messages[1]).toBe(
      "前景 --color-border(#ddd)と背景 --color-surface-highlight(#f2f2f2)のコントラスト比は 1.21:1 で、非テキスト(枠線・フォーカスリングなど)の閾値 3:1 を下回ります。",
    );
    /*
     * **hint には既存機構(`annotateAppliedManifestError`。v0 から在る)の注釈が
     * 自動で足される** —— 「この path は結果のマニフェスト上の位置で、送った diff の
     * 位置ではない」。**座標系の食い違い自体は明文で伝えられている**(ただし
     * 「どの operation が原因か」は名指しされない = 逆算は呼び出し側の仕事)。
     */
    expect(errors[0]?.hint).toBe(
      "どちらかの色を変えて比を 3:1 以上にしてください。閾値は本文テキスト 4.5:1 と非テキスト 3:1 の2つだけです。" +
        " 【パスの根に注意】この path は operations を適用した“結果のマニフェスト”上の位置であり、" +
        "あなたが送った diff 上の位置ではありません(diff の中を同じパスで探しても見つかりません)。" +
        "結果マニフェストのこの位置を作り出している operation はどれかを考え、その operation を直してください。",
    );
    // **通る色の候補が1つも書かれていない**(これが往復を増やす原因である)。
    for (const error of errors) {
      expect(`${error.message}${error.hint ?? ""}`).not.toContain("#7");
    }
  });

  test("エラーだけを読んで機械的に直すと、何往復かかるか(段階的に濃くする)", async () => {
    let slots = defaultSlotValues();
    let attempts = 1;
    let result = await sendTheme(slots);
    const trail: string[] = [String(slots["--color-border"])];

    while (result.isError === true && attempts < 20) {
      const errors = errorsOf(result);
      // **エラーの path しか読まない。**指された名前の値を1段だけ暗くする。
      // **同じスロットを指すエラーは1回にまとめる**(2件あるからといって2段
      // 暗くするのは「1往復で1段」という測り方を壊す。最初の稿はこれを取り違え、
      // 2段ずつ進んで4往復という数字を出していた —— 記録 §3-4 の赤②)。
      for (const path of [...new Set(errors.map((error) => error.path))]) {
        const name = path.slice("/app/theme/slots/".length);
        const current = slots[name];
        expect(current, `${name} が差分に無い`).toBeDefined();
        slots = { ...slots, [name]: darkenOneStep(String(current)) };
      }

      trail.push(String(slots["--color-border"]));
      attempts += 1;
      result = await sendTheme(slots);
    }

    expect(result.isError).toBeFalsy();
    // **実測値**: 何往復で通ったか。
    expect(attempts).toBe(6);
    expect(trail).toEqual(["#ddd", "#cccccc", "#bbbbbb", "#aaaaaa", "#999999", "#888888"]);
    expect(calls).toHaveLength(6);
  });

  test("コントラスト式を自前で持っている側は、拒否1回のあと1往復で直せる", async () => {
    const rejected = await sendTheme(defaultSlotValues());
    expect(rejected.isError).toBe(true);
    // T05 が実測した「通る値」を使う(**テスト外の知識である。エラーには入っていない**)。
    const fixed = await sendTheme(passingSlots());
    expect(fixed.isError).toBeFalsy();
    expect(calls).toHaveLength(2);
  });
});

/** 16進色を1段(0x11)暗くする。**エラーの path しか使わない機械的な直し方**。 */
function darkenOneStep(value: string): string {
  const hex = value.replace("#", "");
  const expanded =
    hex.length === 3
      ? hex
          .split("")
          .map((char) => char + char)
          .join("")
      : hex;
  const channels = [0, 2, 4].map((index) => Number.parseInt(expanded.slice(index, index + 2), 16));
  return `#${channels
    .map((channel) =>
      Math.max(0, channel - 0x11)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

describe("§4-8 (2)(ii) 24スロットだけ投げる(required 違反)", () => {
  test("1スロット欠けると拒否され、エラーは欠けた名前を名指しするが、値の候補は示さない", async () => {
    const slots = passingSlots();
    delete slots["--space-4"];
    expect(Object.keys(slots)).toHaveLength(24);

    const errors = errorsOf(await sendTheme(slots));
    expect(errors).toHaveLength(1);
    const error = errors[0];
    expect(error?.path).toBe("/operations/0/theme/slots");
    expect(error?.message).toBe('必須プロパティ "--space-4" がありません。');
    expect(error?.hint).toBe('/operations/0/theme/slots に "--space-4" を追加してください。');
    // **値の候補は無い** —— どんな値なら通るかはエラーからは分からない。
    expect(error?.allowed_values).toBeUndefined();
  });

  test("24スロット欠けても1往復で全件が返る(往復は1回しか増えない)", async () => {
    const slots = { "--color-text": "#101010" };
    const errors = errorsOf(await sendTheme(slots));
    expect(errors).toHaveLength(24);
    expect(new Set(errors.map((error) => error.path))).toEqual(
      new Set(["/operations/0/theme/slots"]),
    );
  });

  test("値の空間を知っている側なら +1往復で直る", async () => {
    const broken = passingSlots();
    delete broken["--space-4"];
    expect((await sendTheme(broken)).isError).toBe(true);
    expect((await sendTheme(passingSlots())).isError).toBeFalsy();
    expect(calls).toHaveLength(2);
  });
});

describe("§4-8 (2)(iii) スロット名を1つ間違える(additionalProperties 違反)", () => {
  test("拒否され、許可値25件が返る —— エラーだけで直せる唯一の筋書き", async () => {
    const slots: Record<string, string> = passingSlots();
    slots["--color-txet"] = String(slots["--color-text"]);
    delete slots["--color-text"];

    const first = await sendTheme(slots);
    const errors = errorsOf(first);
    // 綴り間違いは「未知の名前」と「必須の欠落」の**2件**になる。
    expect(errors).toHaveLength(2);
    const unknown = errors.find((error) => error.message.includes("未知のプロパティ"));
    const missing = errors.find((error) => error.message.includes("必須プロパティ"));
    expect(unknown?.path).toBe("/operations/0/theme/slots");
    expect(unknown?.allowed_values).toHaveLength(25);
    expect(unknown?.allowed_values).toEqual(themeSlotNames());
    expect(missing?.allowed_values).toBeUndefined();

    // ---- ここから先は ValidationError の中身だけで修正版を組み立てる ----
    const extra = /"([^"]+)"/.exec(String(unknown?.message))?.[1];
    const wanted = /"([^"]+)"/.exec(String(missing?.message))?.[1];
    expect(extra).toBeDefined();
    expect(wanted).toBeDefined();
    const repaired: Record<string, string> = { ...slots };
    repaired[String(wanted)] = String(repaired[String(extra)]);
    delete repaired[String(extra)];

    const second = await sendTheme(repaired);
    expect(second.isError).toBeFalsy();
    // **+1往復で直った。**
    expect(calls).toHaveLength(2);
  });
});

describe("§4-8 (2)(iv) 「青系にしたい」を1回で通せるか", () => {
  const BLUE = {
    "--color-text": "#0b1f3a",
    "--color-text-secondary": "#274b7a",
    "--color-text-label": "#274b7a",
    "--color-text-placeholder": "#274b7a",
    "--color-danger": "#8a0f1a",
    "--color-page-background": "#f4f8ff",
    "--color-surface-highlight": "#e4edfb",
    "--focus-outline-color": "#1a4f9c",
  };

  test("素朴な青系(色だけ差し替えて枠線は既定のまま)は拒否される", async () => {
    const errors = errorsOf(await sendTheme({ ...defaultSlotValues(), ...BLUE }));
    expect(errors.map((error) => error.path)).toEqual([
      "/app/theme/slots/--color-border",
      "/app/theme/slots/--color-border",
    ]);
  });

  test("枠線まで含めて設計した青系は拒否0回で通る(1往復)", async () => {
    const result = await sendTheme({
      ...defaultSlotValues(),
      ...BLUE,
      "--color-border": "#5d739b",
    });
    expect(result.isError).toBeFalsy();
    expect(calls).toEqual(["apply_diff"]);
  });
});

// ===================================================================================
// (3) エラーは1往復で直せる情報を持っているか —— error-self-correction との比較
// ===================================================================================

describe("§4-8 (3) 拒否の自己修正性", () => {
  test("拒否は段階的である —— 構造とコントラストは同じ往復で返らない(最低+2往復)", async () => {
    const slots: Record<string, string> = defaultSlotValues();
    slots["--color-txet"] = String(slots["--color-text"]);
    delete slots["--color-text"];

    // 1往復め: 構造のエラーだけが返る。**コントラストの2件は1つも見えない。**
    const structural = errorsOf(await sendTheme(slots));
    expect(structural.every((error) => error.path.startsWith("/operations/"))).toBe(true);
    expect(structural.some((error) => error.message.includes("下回ります"))).toBe(false);

    // 2往復め: 構造を直すと、初めてコントラストのエラーが見える。
    const contrast = errorsOf(await sendTheme(defaultSlotValues()));
    expect(contrast.every((error) => error.path.startsWith("/app/theme/slots/"))).toBe(true);

    // 3往復め: ようやく通る。**2種類の間違いは2回に分けて教えられる。**
    expect((await sendTheme(passingSlots())).isError).toBeFalsy();
    expect(calls).toHaveLength(3);
  });

  test("コントラストのエラーの path は、送った差分の座標系ではない", async () => {
    const errors = errorsOf(await sendTheme(defaultSlotValues()));
    const path = String(errors[0]?.path);
    // 送ったのは `/operations/0/theme/slots/...` だが、返る path は結果側の座標である。
    expect(path).toBe("/app/theme/slots/--color-border");
    const sent = themeDiff(defaultSlotValues());
    expect(resolvePointer(sent, path)).toBeUndefined();
    expect(resolvePointer(sent, path.replace("/app/theme", "/operations/0/theme"))).toBe("#ddd");
  });

  /*
   * 【V3-M1-T08 による書き換え。**旧稿の期待値は消さずに下に引く**】
   *
   * **T07 はここで「hint が誤っている」ことを実測した。** 旧稿が固定していた逐語は:
   *
   * ```
   * message: --color-text の値 "blue" は識別子の規約に合いません。
   * hint:    英小文字で始まり、英小文字・数字・ハイフン・アンダースコアのみを使う
   *          1〜64文字にしてください(例: book-tracker, finished_at)。
   * ```
   *
   * **旧稿の往復数の実測は「4往復かけても収束しない」だった**(hint に従って
   * `blue-x` → `blue-x-x` → `blue-x-x-x` と直し、3回続けて拒否された)。
   * **T08 が `src/kernel/ajv-error-adapter.ts` の `case "pattern":` に族ごとの
   * 専用文面を足したので、下は「hint に従うと通る」を測る形に書き換わっている。**
   * 数字の対照は `docs/plan/v3/records/v3-m1-t07.md` §3-5 (A) に書いた。
   */
  test("色の書式を間違えたときの hint は色の書式を教え、従うと +1往復で通る(T08 で直した)", async () => {
    const slots = { ...passingSlots(), "--color-text": "blue" };
    const errors = errorsOf(await sendTheme(slots));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("/operations/0/theme/slots/--color-text");
    // **message は path を含まず、スロット名だけを言う**(汎用文面の `where`)。
    expect(errors[0]?.message).toBe('--color-text の値 "blue" は色の書式に合いません。');
    expect(errors[0]?.hint).toBe(
      "色は16進表記だけです —— # に続けて3桁または6桁の16進数を書いてください(例: #333 / #1a4f9c)。" +
        "色名(blue / red)・rgb() / rgba() / hsl()・var() は書けません。" +
        "透明度付きの8桁(#rrggbbaa)もこのスロットでは書けません。",
    );
    // **リソースID の文面は1文字も残っていない**(T07 が見つけた誤誘導の本体)。
    expect(`${errors[0]?.message}${errors[0]?.hint ?? ""}`).not.toContain("英小文字で始まり");

    // ---- ここから先は hint の中身だけで修正版を組み立てる ----
    // **「(例: …)」から最初の候補を取り出して、そのまま値にする。**
    const example = /\(例: ([^)]+)\)/.exec(String(errors[0]?.hint))?.[1]?.split(" / ")[0];
    expect(example).toBe("#333");
    const retry = await sendTheme({ ...passingSlots(), "--color-text": String(example) });
    expect(retry.isError).toBeFalsy();
    // **2往復で通った**(旧稿の実測は「4往復かけても収束しない」)。
    expect(calls).toHaveLength(2);
    expect(await storedSlots()).toMatchObject({ "--color-text": "#333" });
  });

  test("書式の hint は5族すべてで『従えば通る』(色以外の4族も +1往復で通る)", async () => {
    // **族ごとに1つずつ壊し、hint の最初の例で直す。**値の空間の知識は使わない。
    const broken: Record<string, string> = {
      "--space-4": "8",
      "--line-height-base": "1.6rem",
      "--surface-shadow": "0 1px 3px rgba(0,0,0,.1)",
      "--font-family-base": "var(--x)",
    };
    const errors = errorsOf(await sendTheme({ ...passingSlots(), ...broken }));
    // **4件が1往復で全部返る**(族ごとに往復しない)。
    expect(errors).toHaveLength(4);
    const repaired: Record<string, string> = { ...passingSlots(), ...broken };
    for (const error of errors) {
      const slot = error.path.slice("/operations/0/theme/slots/".length);
      expect(error.message, slot).toContain("の書式に合いません");
      const example = /\(例: ([^)]+)\)/.exec(String(error.hint))?.[1]?.split(" / ")[0];
      expect(example, `${slot}: hint に例が無い`).toBeDefined();
      repaired[slot] = String(example);
    }
    // 取り出せた例(**hint が持っている字面そのもの**)。
    expect(repaired["--space-4"]).toBe("0");
    expect(repaired["--line-height-base"]).toBe("1.6");
    expect(repaired["--surface-shadow"]).toBe("none");
    expect(repaired["--font-family-base"]).toBe("system-ui, sans-serif");

    const retry = await sendTheme(repaired);
    expect(retry.isError).toBeFalsy();
    // **2往復。**4族まとめて +1往復で直った。
    expect(calls).toHaveLength(2);
  });

  test("【T08 の限界】色の hint に従うと書式は直るが、次段のコントラストで落ちることがある", async () => {
    // **地色のスロットを壊す。**書式の hint は前景か背景かを知らないので、
    // 例として濃い色(`#333`)を先に出す —— 地色に入れれば比が閾値を割る。
    const errors = errorsOf(
      await sendTheme({ ...passingSlots(), "--color-page-background": "white" }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe(
      '--color-page-background の値 "white" は色の書式に合いません。',
    );
    const example = /\(例: ([^)]+)\)/.exec(String(errors[0]?.hint))?.[1]?.split(" / ")[0];
    expect(example).toBe("#333");

    const second = errorsOf(
      await sendTheme({ ...passingSlots(), "--color-page-background": String(example) }),
    );
    // **書式のエラーは消えている**(hint に従った結果である。ここは「従えば通る」)。
    expect(second.some((error) => error.message.includes("書式に合いません"))).toBe(false);
    // **しかし別の拒否に移った** —— 地色を濃くしたので文字色との比が閾値を割る。
    expect(second.some((error) => error.message.includes("下回ります"))).toBe(true);
    // **つまり T08 が直したのは「書式の段」だけである。**コントラストの段は
    // 依然として通る候補値を1つも持たない(§3-5 の表)。
    expect(calls).toHaveLength(2);
  });

  test("path と message は全エラーが持つが、allowed_values を持つのは1種類だけである", async () => {
    const kinds: Record<string, ValidationError[]> = {};
    const missing = passingSlots();
    delete missing["--space-4"];
    kinds.required = errorsOf(await sendTheme(missing));
    const unknownName: Record<string, string> = { ...passingSlots(), "--color-nope": "#111111" };
    kinds.additionalProperties = errorsOf(await sendTheme(unknownName));
    kinds.pattern = errorsOf(await sendTheme({ ...passingSlots(), "--space-4": "1 rem" }));
    kinds.contrast = errorsOf(await sendTheme(defaultSlotValues()));

    for (const [kind, errors] of Object.entries(kinds)) {
      expect(errors.length, kind).toBeGreaterThan(0);
      for (const error of errors) {
        expect(error.path.startsWith("/"), `${kind}: path`).toBe(true);
        expect(error.message.trim().length, `${kind}: message`).toBeGreaterThan(0);
        expect(error.hint, `${kind}: hint`).toBeDefined();
      }
    }
    expect(kinds.additionalProperties?.some((error) => error.allowed_values !== undefined)).toBe(
      true,
    );
    for (const kind of ["required", "pattern", "contrast"]) {
      expect(
        kinds[kind]?.every((error) => error.allowed_values === undefined),
        `${kind} に allowed_values があってはならない`,
      ).toBe(true);
    }
  });
});

/** RFC 6901 の Pointer を辿る(解決できなければ `undefined`)。 */
function resolvePointer(root: unknown, pointer: string): unknown {
  let node: unknown = root;
  for (const raw of pointer.split("/").slice(1)) {
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(node)) {
      node = node[Number(segment)];
    } else if (typeof node === "object" && node !== null) {
      node = (node as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return node;
}
