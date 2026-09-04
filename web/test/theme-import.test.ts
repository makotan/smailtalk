/**
 * **既にある見た目の資産の取り込み**の実地の実測(V3-M6-T01 / D-G9)。
 *
 * 完了条件の正は `docs/plan/v3/records/v3-m6.md` §2 の「V3-M6-T01」節(11点)、
 * 判定の正は `docs/adr/0007-vocabulary-governance.md` §8 の 2026-07-30 の `D-G9` の行
 * (**門A / 将来送り**)と `docs/plan/v3/records/v3-m6-gate-a.md` §4。
 * **越えてはならない線12点は同 §8-1** にある(**問4 の限定表ではない**)。
 *
 * ## なぜ `web/test/` に在るのか(置き場の理由)
 *
 * 本タスクは **`src/kernel/` と `schemas/` の製品コードを1バイトも触らない**ことを
 * 根拠に成立している(ユーザ決定 `D-M6-1` = カーネル増分0)。したがって
 * **`src/kernel/` にテストファイルを置くと差し戻し条件2 の字面と紛れる**ので置かない
 * (審査記録 §6-2 が `web/test/` を推した)。先例は `web/test/theme-template.test.ts`
 * (V3-M1-T05)と `web/test/theme-candidates.test.ts`(V3-M4-T01)である。
 *
 * ## 何を使って測るか(新しい入口を1つも開けない)
 *
 * **既存の MCP ツールだけ**である(`create_app` / `get_manifest` / `apply_diff` /
 * `undo` / `get_changelog` / `list_apps`)。接続は `InMemoryTransport.createLinkedPair()`
 * (`web/test/theme-template.test.ts` と同じ作法)。**カーネルからの値 import は
 * `checkThemeContrast` の1本だけである** —— 審査の裁定(`v3-m6.md` §2a 裁定1 /
 * 審査記録 §6-3 の4)が許した7識別子の集合の内側で、web 側にコントラストの規則を
 * 再実装しないためにカーネルの関数そのものを呼ぶ(`theme-candidates.test.ts` と同型)。
 *
 * ## 何が「資産から取り出した」ことの機械的な根拠なのか(**ここが最も大事である**)
 *
 * **下の {@link IMPORTED_SLOTS} の25値は、`fixtures/theme-import/brand-guide.md` を
 * このセッションの会話側 AI(Claude Code)が読んで書き写したものである。**
 * 機械が確かめられるのは次の2点だけである:
 *
 * 1. **25値のすべてが `brand-guide.md` の本文にインラインコードとして実在する**
 *    (この節の1本目のテスト)。
 * 2. **色として使う9値のすべてが `fixtures/theme-import/screenshot.png` の画素として
 *    実在する**(2本目のテスト。PNG を `zlib.inflateSync` で自分で解いて画素を読む)。
 *
 * **これは「AI が正しく抽出した」ことの証明ではない。** ブランドガイドは人間の言葉
 * (「本文の文字色」「見出しの下の区切り線」)で書かれており、**どの言葉がどのスロットに
 * 当たるかを決めたのは AI である。その対応の正しさを検証する機械は1つも無い**
 * (`v3-m6.md` §0-4 の1 / 5)。**本ファイルは「抽出済みの値が取り込める」ことしか測らない。**
 *
 * ## 何を測らないか(誇張しない)
 *
 * - **本物の LLM を1度も呼ばない。** 抽出は自動テストの中で再現されない(§0-4 の1)。
 * - **画面のことは1つも見ていない。** owner 確認 UI は V3-M6-T02、chromium での実測は
 *   V3-M6-T04 である。
 * - **既存サイト(URL)からの取り込みは1バイトも扱わない**(ユーザ決定 `D-M6-4`)。
 * - **カーネルもサーバも外部を取得しない**(線1)。**資産はローカルの `fixtures/` の
 *   ファイルであり、読むのはこのテスト(= 会話側 AI の代役)である。**
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { inflateSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildScreenshotPng } from "../../fixtures/theme-import/screenshot.gen.ts";
import { checkThemeContrast } from "../../src/kernel/theme-contrast.ts";
import type { Manifest, Theme } from "../../src/kernel/types.ts";
import { createMcpServer } from "../../src/mcp/server.ts";
import { seedSession } from "../../src/server/test-helpers.ts";

const REPO_ROOT = dirname(dirname(import.meta.dir));
const MANIFEST_SCHEMA_PATH = join(REPO_ROOT, "schemas", "manifest.schema.json");
const STYLES_CSS_PATH = join(REPO_ROOT, "web", "src", "styles.css");
const FIXTURE_DIR = join(REPO_ROOT, "fixtures", "theme-import");
const BRAND_GUIDE_PATH = join(FIXTURE_DIR, "brand-guide.md");
const SCREENSHOT_PATH = join(FIXTURE_DIR, "screenshot.png");

const TEMPLATE_APP = "hashibami-look";
const APP_A = "hashibami-order";

/**
 * **ブランドガイドから取り出した25スロットの実値**(会話側 AI が `brand-guide.md` を
 * 読んで書き写したもの)。
 *
 * **ここに書いた値が資産の中に実在することは機械で照合する**(1本目・2本目のテスト)。
 * **どの記述をどのスロットに当てたかは照合できない** —— 対応表はガイドの中に無い
 * (ガイドはスロット名を1つも書いていない。**それが「ブランドガイドである」ことの
 * 条件でもある**)。
 */
const IMPORTED_SLOTS: Record<string, string> = {
  "--color-text": "#14281d",
  "--color-text-secondary": "#405146",
  "--color-text-label": "#33443a",
  "--color-text-placeholder": "#4d5e53",
  "--color-danger": "#8c1d18",
  "--color-page-background": "#fffdf8",
  "--color-surface-highlight": "#eef2ea",
  "--color-border": "#6b7a70",
  "--focus-outline-color": "#1a5fb4",
  "--focus-outline-width": "2px",
  "--font-family-base": "Hiragino Sans, Yu Gothic, sans-serif",
  "--font-size-secondary": "0.875rem",
  "--font-size-note": "0.75rem",
  "--line-height-base": "1.7",
  "--space-1": "0.25rem",
  "--space-2": "0.5rem",
  "--space-3": "0.75rem",
  "--space-4": "1rem",
  "--space-5": "1.5rem",
  "--space-6": "2.5rem",
  "--border-width": "1px",
  "--control-border-radius": "6px",
  "--surface-shadow": "0 1px 2px #14281d1a",
  "--detail-label-width": "9rem",
  "--login-max-width": "24rem",
};

/**
 * **色として使うスロット**(値が `#` で始まるもの)。**9件である。**
 *
 * **カーネルの役割表(`THEME_SLOT_ROLES`)を import しない** —— 裁定1 が許した7識別子に
 * 含まれないからである(`v3-m6.md` §2a)。代わりに**値の形から導く**。
 */
const COLOR_SLOTS = Object.entries(IMPORTED_SLOTS).filter(([, value]) => value.startsWith("#"));

/**
 * **ブランドガイドが指定しているのに、25スロットに置き場が無い3件**(完了条件6)。
 * `web/src/styles.css` の `:root` には在るが `$defs/theme` には無い(`v3-m6.md` §0-1c (6))。
 */
const UNIMPORTABLE_VARIABLES: Record<string, string> = {
  "--border-style": "solid",
  "--focus-outline-style": "dashed",
  "--shell-max-width": "1120px",
};

type ThemeSchema = {
  required: string[];
  properties: Record<string, { pattern?: string }>;
};

function themeSchema(): ThemeSchema {
  const schema = JSON.parse(readFileSync(MANIFEST_SCHEMA_PATH, "utf-8")) as {
    $defs: { theme: ThemeSchema };
  };
  return schema.$defs.theme;
}

function brandGuide(): string {
  return readFileSync(BRAND_GUIDE_PATH, "utf-8");
}

// ---------------------------------------------------------------------------
// PNG を自前で解く(**新しい依存パッケージを1つも足さない**)
// ---------------------------------------------------------------------------

type PngPixels = {
  width: number;
  height: number;
  /** `#rrggbb`(小文字)の集合。 */
  colors: Set<string>;
};

/**
 * PNG を読んで画素の色集合を返す。
 *
 * **フィルタ無し(各走査線の先頭バイトが 0)・パレット無し(色種別 2 = truecolor)・
 * 8bit・非インタレース**だけを受ける。`fixtures/theme-import/screenshot.gen.ts` が
 * その形でしか書かないので、**読み直しに画像ライブラリが1つも要らない**
 * (`node:zlib` は Node 互換 API であり依存追加ではない)。
 */
function readPngColors(path: string): PngPixels {
  const bytes = readFileSync(path);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (const [index, expected] of signature.entries()) {
    if (bytes[index] !== expected) {
      throw new Error(`PNG の署名が違う(位置 ${index})`);
    }
  }

  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("latin1");
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colorType = data[9];
      const filterMethod = data[11];
      const interlace = data[12];
      if (bitDepth !== 8 || colorType !== 2 || filterMethod !== 0 || interlace !== 0) {
        throw new Error(
          `想定外の PNG(bitDepth=${String(bitDepth)} colorType=${String(colorType)} filter=${String(filterMethod)} interlace=${String(interlace)})`,
        );
      }
    } else if (type === "IDAT") {
      idat.push(Uint8Array.from(data));
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }

  const compressed = Buffer.concat(idat.map((part) => Buffer.from(part)));
  const raw = inflateSync(compressed);
  const stride = width * 3;
  if (raw.length !== height * (stride + 1)) {
    throw new Error(`走査線の長さが合わない: ${String(raw.length)}`);
  }

  const colors = new Set<string>();
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    if (raw[rowStart] !== 0) {
      throw new Error(`走査線 ${String(y)} のフィルタが 0 ではない`);
    }
    for (let x = 0; x < width; x += 1) {
      const base = rowStart + 1 + x * 3;
      const r = raw[base] ?? 0;
      const g = raw[base + 1] ?? 0;
      const b = raw[base + 2] ?? 0;
      colors.add(
        `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`,
      );
    }
  }
  return { width, height, colors };
}

// ---------------------------------------------------------------------------
// MCP の口(既存ツールだけを通る)
// ---------------------------------------------------------------------------

type ToolResult = { isError: boolean; data: Record<string, unknown> };

/**
 * **【`V8-M31`】MCP の名乗り。**
 * MCP サーバは「どの利用者として動くか」を名乗らないと23本のツールが全部失敗する。
 * **【2026-08-16 訂正(`V8-M13-T04`)。直前の1行を1バイトも書き換えていない】この「23本」は今日は24本である**
 * (`V8-M13-T02` が `read_report` を足した)。
 * さらに `create_app` 以外のツールは**そのアプリに登録済みの利用者か**を解決するので、
 * アプリを1つ作るたびに同じ名前の利用者を1人作る(`createApp` の中で行う)。
 */
const ACTOR = "mcp-actor";

let dataRoot: string;
let client: Client;
let closeConnection: () => Promise<void>;
/** 呼んだツール名(**新しいツールを1本も使っていない**ことを言えるようにする)。 */
let calls: string[];

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-theme-import-"));
  const server = createMcpServer({
    dataRoot,
    previewBaseUrl: "http://127.0.0.1:3000",
    actor: ACTOR,
  });
  client = new Client({ name: "theme-import-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  // 逐次 await はデッドロックする(`src/mcp/server.test.ts` の注記)。
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  closeConnection = async () => {
    await client.close();
    await server.close();
  };
  calls = [];
});

afterEach(async () => {
  await closeConnection();
  await rm(dataRoot, { recursive: true, force: true });
});

async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  calls.push(name);
  const result = await client.callTool({ name, arguments: args });
  return {
    isError: result.isError === true,
    data: (result.structuredContent ?? {}) as Record<string, unknown>,
  };
}

async function ok(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await callTool(name, args);
  expect(result.isError, `${name} が失敗した: ${JSON.stringify(result.data)}`).toBe(false);
  return result.data;
}

async function createApp(appId: string, name: string): Promise<void> {
  await ok("create_app", { name, app_id: appId });
  // **【`V8-M31`】作った直後に、そのアプリへ名乗りと同じ利用者を1人作る。**
  // これが無いと以降の `apply_diff` / `get_manifest` が
  // 「名乗った利用者は、このアプリに登録されていません。」で失敗する。
  seedSession(dataRoot, appId, { username: ACTOR });
}

/** 取り込みの差分。**意図に「資産から取り込んだ」ことと「誰が読んだか」を書く。** */
function importDiff(diffId: string, theme: Theme): Record<string, unknown> {
  return {
    diff_id: diffId,
    intent:
      "既にあるブランドガイドとスクリーンショットから見た目を起こしたい、" +
      "という要望に応えてテーマを当てた(資産を読んだのは会話している AI であり、" +
      "カーネルは外部を1バイトも取得していない)",
    operations: [{ op: "set_theme", theme }],
  };
}

async function applyTheme(appId: string, diffId: string, theme: Theme): Promise<void> {
  await ok("apply_diff", { app_id: appId, diff: importDiff(diffId, theme) });
}

async function manifestOf(appId: string): Promise<Manifest> {
  const data = await ok("get_manifest", { app_id: appId });
  return data.manifest as Manifest;
}

type ChangelogEntry = {
  diff_id: string;
  kind: string;
  operations: Record<string, unknown>[];
};

async function changelogOf(appId: string): Promise<ChangelogEntry[]> {
  const data = await ok("get_changelog", { app_id: appId });
  return data.changelog as ChangelogEntry[];
}

function manifestFileOf(appId: string): string {
  return join(dataRoot, "apps", appId, "manifest.json");
}

/** アプリ配下のファイル全件(相対パス)。blob 経路を1バイトも使っていないことを見る。 */
function fileTreeOf(appId: string): string[] {
  const root = join(dataRoot, "apps", appId);
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      out.push(relative(root, full).replaceAll("\\", "/"));
    }
  };
  walk(root);
  return out.sort();
}

/** 「全か無か」を**バイト列**で見るための採取(`src/kernel/theme-history.test.ts` と同型)。 */
function captureBytes(appId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ["manifest.json", "app.sqlite"]) {
    const path = join(dataRoot, "apps", appId, name);
    out[name] = existsSync(path) ? Bun.SHA256.hash(readFileSync(path), "hex") : "(ファイルが無い)";
  }
  out.snapshots = JSON.stringify(
    existsSync(join(dataRoot, "apps", appId, "snapshots"))
      ? readdirSync(join(dataRoot, "apps", appId, "snapshots")).sort()
      : [],
  );
  return out;
}

// ---------------------------------------------------------------------------
// 1. 資産が実在し、25値が資産から出ていること(完了条件1 / 2 の非循環な根拠)
// ---------------------------------------------------------------------------

describe("完了条件1 / 2: 取り込み元の資産2種が git 管理下に在り、25値が資産の中に実在する", () => {
  test("fixtures に2種の資産が在る(ブランドガイド = テキスト / スクリーンショット = 画像)", () => {
    expect(existsSync(BRAND_GUIDE_PATH)).toBe(true);
    expect(existsSync(SCREENSHOT_PATH)).toBe(true);
    // **`data-demo/` を使っていない**(§0-4 の4)。資産はリポジトリの中にある。
    expect(BRAND_GUIDE_PATH.includes("data-demo")).toBe(false);
    expect(SCREENSHOT_PATH.includes("data-demo")).toBe(false);
  });

  test("ガイドは色コード・書体・余白の指定を含む(架空の組織である)", () => {
    const guide = brandGuide();
    expect(guide).toContain("架空");
    expect(guide).toContain("ハシバミ製作所");
    // 色・書体・余白の3種の指定がある(完了条件1 (a))。
    expect(guide).toContain("#14281d");
    expect(guide).toContain("Hiragino Sans");
    expect(guide).toContain("余白");
  });

  test("【非循環】25値のすべてがガイドの本文にインラインコードとして実在する", () => {
    const guide = brandGuide();
    const missing = Object.entries(IMPORTED_SLOTS)
      .filter(([, value]) => !guide.includes(`\`${value}\``))
      .map(([slot, value]) => `${slot}=${value}`);
    // **これが「資産から取り出した」ことの唯一の機械的な根拠である。**
    // **「AI が正しく抽出した」ことの根拠ではない**(§0-4 の5)。
    expect(missing).toEqual([]);
  });

  test("ガイドはスロット名を1つも書いていない(対応付けを AI が行ったことの裏返し)", () => {
    const guide = brandGuide();
    const leaked = Object.keys(IMPORTED_SLOTS).filter((slot) => guide.includes(slot));
    // スロット名が書かれていたら、それは「ブランドガイド」ではなく「テーマ定義」である。
    // **書かれていないので、prose → スロットの対応は AI の判断であり、検証されていない。**
    expect(leaked).toEqual([]);
  });

  test("【非循環】色として使う9値のすべてがスクリーンショットの画素として実在する", () => {
    const png = readPngColors(SCREENSHOT_PATH);
    expect(png.width).toBeGreaterThan(0);
    expect(png.height).toBeGreaterThan(0);
    expect(COLOR_SLOTS).toHaveLength(9);

    const missing = COLOR_SLOTS.filter(([, value]) => !png.colors.has(value.toLowerCase())).map(
      ([slot, value]) => `${slot}=${value}`,
    );
    expect(missing).toEqual([]);
  });

  test("スクリーンショットは生成器から決定論的に再現できる(CI で形が再現する)", () => {
    // **画像ライブラリを1つも足していない**(`node:zlib` だけで書き、`node:zlib` だけで読む)。
    // バイト列で比べる(16進にしてから比べるのは、落ちたときに差分が読めるようにするため)。
    expect(readFileSync(SCREENSHOT_PATH).toString("hex")).toBe(
      Buffer.from(buildScreenshotPng()).toString("hex"),
    );
  });

  test("画素の集合は資産の配色だけからなる(素性の分からない色が混じっていない)", () => {
    const png = readPngColors(SCREENSHOT_PATH);
    const declared = new Set(COLOR_SLOTS.map(([, value]) => value.toLowerCase()));
    const unknown = [...png.colors].filter((color) => !declared.has(color));
    expect(unknown).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. 25スロットが set_theme でマニフェストに入る(完了条件2)
// ---------------------------------------------------------------------------

describe("完了条件2: 資産から取り出した25スロットが apply_diff の set_theme でマニフェストに入る", () => {
  test("スロット名の集合が $defs/theme の properties と完全一致する(25件)", () => {
    const expected = Object.keys(themeSchema().properties).sort();
    expect(expected).toHaveLength(25);
    expect(Object.keys(IMPORTED_SLOTS).sort()).toEqual(expected);
    // `required` も25件である(部分テーマを作れない。ADR-0047 限定5)。
    expect(themeSchema().required.sort()).toEqual(expected);
  });

  test("値はスキーマの pattern を満たす(式・計算・参照を1つも含まない)", () => {
    const properties = themeSchema().properties;
    for (const [slot, value] of Object.entries(IMPORTED_SLOTS)) {
      const pattern = properties[slot]?.pattern;
      if (pattern === undefined) {
        throw new Error(`スキーマに pattern が無いスロット: ${slot}`);
      }
      expect({ slot, ok: new RegExp(pattern).test(value) }).toEqual({ slot, ok: true });
    }
  });

  test("既存語彙だけで往復する —— 使ったツールは既存の3本で、差分操作は set_theme 1件だけ", async () => {
    await createApp(TEMPLATE_APP, "ハシバミ製作所の見た目(取り込み先アプリ)");
    await applyTheme(TEMPLATE_APP, "d-import-0001", { slots: IMPORTED_SLOTS });

    const manifest = await manifestOf(TEMPLATE_APP);
    expect(manifest.app.theme?.slots).toEqual(IMPORTED_SLOTS);
    // 由来は名乗らない(資産は SmAIltalk のアプリではないので `template_app_id` を書けない)。
    expect(manifest.app.theme?.origin).toBeUndefined();

    // **新しいツール・新しい差分操作を1つも使っていない。**
    expect(calls).toEqual(["create_app", "apply_diff", "get_manifest"]);
    const entries = await changelogOf(TEMPLATE_APP);
    const ops = entries.flatMap((entry) => entry.operations.map((operation) => operation.op));
    expect(new Set(ops)).toEqual(new Set(["set_theme"]));
  });

  test("取り込み用の MCP ツールを1本も足していない(線5)", async () => {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    expect(names.filter((name) => /import|theme|brand|screenshot/i.test(name))).toEqual([]);
    // 使うのは既存の口である。
    expect(names).toContain("apply_diff");
    expect(names).toContain("get_manifest");
  });
});

// ---------------------------------------------------------------------------
// 3. コントラスト検査が両方向で効く(完了条件3)
// ---------------------------------------------------------------------------

describe("完了条件3: コントラスト検査が両方向で効き、拒否は全か無かである", () => {
  test("通る配色は通る(カーネルの検査関数がエラーを1件も返さない)", () => {
    // **web 側に規則を再実装しない** —— カーネルの `checkThemeContrast` そのものを呼ぶ。
    expect(checkThemeContrast(IMPORTED_SLOTS).map((error) => error.message)).toEqual([]);
  });

  test("通らない配色は落ちる(検査が空回りしていない)", () => {
    // 資産の地色に本文色を寄せた偽の取り込み(「読めない配色」の最短の作り方)。
    const broken = {
      ...IMPORTED_SLOTS,
      "--color-text": IMPORTED_SLOTS["--color-page-background"] as string,
    };
    expect(checkThemeContrast(broken).length).toBeGreaterThan(0);
  });

  test("通らない配色は apply_diff が purpose === incoming で拒否する", async () => {
    await createApp(APP_A, "ハシバミ製作所の注文管理");
    const broken = { ...IMPORTED_SLOTS, "--color-text": "#f4f4f4" };

    const result = await callTool("apply_diff", {
      app_id: APP_A,
      diff: importDiff("d-import-0001", { slots: broken }),
    });
    expect(result.isError).toBe(true);
    // 理由が読める形で返る(黙って落ちない)。
    expect(JSON.stringify(result.data)).toContain("コントラスト比");
  });

  test("拒否は全か無か —— manifest.json / app.sqlite / snapshots が1バイトも変わらない", async () => {
    await createApp(APP_A, "ハシバミ製作所の注文管理");
    const beforeBytes = captureBytes(APP_A);
    const beforeLog = (await changelogOf(APP_A)).length;

    const broken = { ...IMPORTED_SLOTS, "--color-border": "#f0f0f0" };
    const result = await callTool("apply_diff", {
      app_id: APP_A,
      diff: importDiff("d-import-0001", { slots: broken }),
    });
    expect(result.isError).toBe(true);

    expect(captureBytes(APP_A)).toEqual(beforeBytes);
    expect((await changelogOf(APP_A)).length).toBe(beforeLog);
    expect((await manifestOf(APP_A)).app.theme).toBeUndefined();
  });

  test("既に取り込み済みのテーマは、落ちる差分では1バイトも書き換わらない(部分適用が無い)", async () => {
    await createApp(APP_A, "ハシバミ製作所の注文管理");
    await applyTheme(APP_A, "d-import-0001", { slots: IMPORTED_SLOTS });

    const broken = { ...IMPORTED_SLOTS, "--color-text-secondary": "#f8f8f8" };
    const result = await callTool("apply_diff", {
      app_id: APP_A,
      diff: importDiff("d-import-0002", { slots: broken }),
    });
    expect(result.isError).toBe(true);
    expect((await manifestOf(APP_A)).app.theme?.slots).toEqual(IMPORTED_SLOTS);
  });
});

// ---------------------------------------------------------------------------
// 4. undo で戻り、_changelog に載る(完了条件4)
// ---------------------------------------------------------------------------

describe("完了条件4: 取り込みは既存の履歴機構にそのまま載り、undo で戻る", () => {
  test("apply で _changelog に1行載り、undo で取り込み前へ戻る", async () => {
    await createApp(APP_A, "ハシバミ製作所の注文管理");
    const before = await changelogOf(APP_A);

    await applyTheme(APP_A, "d-import-0001", { slots: IMPORTED_SLOTS });

    // **1行だけ増える**(取り込み専用の記録形を発明していない)。
    const after = await changelogOf(APP_A);
    expect(after.length).toBe(before.length + 1);
    const entry = after[after.length - 1];
    expect(entry?.diff_id).toBe("d-import-0001");
    expect(entry?.kind).toBe("apply");
    expect(entry?.operations).toEqual([{ op: "set_theme", theme: { slots: IMPORTED_SLOTS } }]);

    // **undo で取り込み前の状態へ戻る**(キーが消える。空のテーマが残るのではない)。
    await ok("undo", { app_id: APP_A });
    const back = await manifestOf(APP_A);
    expect(back.app.theme).toBeUndefined();
    expect(Object.keys(back.app)).not.toContain("theme");

    // undo 自身も1行載る(履歴が消えるのではない)。
    const undone = await changelogOf(APP_A);
    expect(undone.length).toBe(after.length + 1);
    expect(undone[undone.length - 1]?.kind).toBe("undo");
  });

  test("取り込み → 取り直し → undo で1つ前の取り込みに戻る", async () => {
    await createApp(APP_A, "ハシバミ製作所の注文管理");
    await applyTheme(APP_A, "d-import-0001", { slots: IMPORTED_SLOTS });
    const retouched = { ...IMPORTED_SLOTS, "--control-border-radius": "0" };
    await applyTheme(APP_A, "d-import-0002", { slots: retouched });
    expect((await manifestOf(APP_A)).app.theme?.slots).toEqual(retouched);

    await ok("undo", { app_id: APP_A });
    expect((await manifestOf(APP_A)).app.theme?.slots).toEqual(IMPORTED_SLOTS);
  });
});

// ---------------------------------------------------------------------------
// 5. image 型を1バイトも使わない(完了条件5 / 線2)
// ---------------------------------------------------------------------------

describe("完了条件5: スクリーンショットを image 型に1バイトも通していない(ADR-0035 の限定)", () => {
  test("取り込みの往復にテーブルもフィールドも1つも要らない(image 型が現れる場所が無い)", async () => {
    await createApp(APP_A, "ハシバミ製作所の注文管理");
    await applyTheme(APP_A, "d-import-0001", { slots: IMPORTED_SLOTS });

    const manifest = await manifestOf(APP_A);
    // テーブルが0件なので、そもそもフィールド型が1つも登場しない。
    expect(manifest.app.tables).toEqual([]);
    const fieldTypes = manifest.app.tables.flatMap((table) =>
      table.fields.map((field) => field.type),
    );
    expect(fieldTypes).not.toContain("image");
    // 送った差分の JSON にも `image` の語が1度も現れない。
    expect(JSON.stringify(importDiff("d-import-0001", { slots: IMPORTED_SLOTS }))).not.toContain(
      "image",
    );
    // 永続化されたマニフェストにも現れない。
    expect(readFileSync(manifestFileOf(APP_A), "utf-8")).not.toContain("image");
  });

  test("blob の経路を1バイトも使わない(blobs/ が作られない)", async () => {
    await createApp(APP_A, "ハシバミ製作所の注文管理");
    const before = fileTreeOf(APP_A);
    await applyTheme(APP_A, "d-import-0001", { slots: IMPORTED_SLOTS });

    expect(existsSync(join(dataRoot, "apps", APP_A, "blobs"))).toBe(false);
    const added = fileTreeOf(APP_A).filter((path) => !before.includes(path));
    expect(added.every((path) => path.startsWith("snapshots/"))).toBe(true);
    expect(added.some((path) => path.includes("blob"))).toBe(false);
  });

  test("スクリーンショットは PNG のまま fixtures に在り、データルートには1バイトも入らない", async () => {
    await createApp(APP_A, "ハシバミ製作所の注文管理");
    await applyTheme(APP_A, "d-import-0001", { slots: IMPORTED_SLOTS });
    // PNG を読むのは**このテスト(= 会話側 AI の代役)**である。
    // カーネルは PNG のパスも中身も1バイトも知らない(線1 / 線2)。
    const png = readFileSync(SCREENSHOT_PATH);
    expect(png.length).toBeGreaterThan(0);
    const tree = fileTreeOf(APP_A);
    expect(tree.some((path) => path.endsWith(".png"))).toBe(false);
    expect(readFileSync(manifestFileOf(APP_A), "utf-8")).not.toContain("screenshot");
  });
});

// ---------------------------------------------------------------------------
// 6. 取り込めない3変数(完了条件6。記録の §限界 が正)
// ---------------------------------------------------------------------------

describe("完了条件6: ガイドが指定していても取り込めない3変数が在る", () => {
  test("3変数は styles.css の :root に在るが、$defs/theme には無い", () => {
    const css = readFileSync(STYLES_CSS_PATH, "utf-8");
    const slots = Object.keys(themeSchema().properties);
    for (const name of Object.keys(UNIMPORTABLE_VARIABLES)) {
      expect({ name, inCss: css.includes(`${name}:`) }).toEqual({ name, inCss: true });
      expect({ name, inTheme: slots.includes(name) }).toEqual({ name, inTheme: false });
    }
  });

  test("ガイドは3変数に相当する指定を持っている(取り込めないのは器が無いからである)", () => {
    const guide = brandGuide();
    for (const value of Object.values(UNIMPORTABLE_VARIABLES)) {
      expect({ value, inGuide: guide.includes(`\`${value}\``) }).toEqual({ value, inGuide: true });
    }
  });

  test("3変数を set_theme に混ぜると拒否される(additionalProperties: false)", async () => {
    await createApp(APP_A, "ハシバミ製作所の注文管理");
    const result = await callTool("apply_diff", {
      app_id: APP_A,
      diff: importDiff("d-import-0001", {
        slots: { ...IMPORTED_SLOTS, ...UNIMPORTABLE_VARIABLES },
      } as unknown as Theme),
    });
    expect(result.isError).toBe(true);
    // 拒否は全か無かなので、25スロットのほうも入らない。
    expect((await manifestOf(APP_A)).app.theme).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 7. テンプレート用アプリ → 別アプリ(完了条件7)
// ---------------------------------------------------------------------------

describe("完了条件7: 取り込んだテーマを別アプリへ当て、由来を書く(1往復)", () => {
  test("取り込み先アプリ → 別アプリへ25スロットが移り、origin.template_app_id に由来が載る", async () => {
    await createApp(TEMPLATE_APP, "ハシバミ製作所の見た目(取り込み先アプリ)");
    await applyTheme(TEMPLATE_APP, "d-import-0001", { slots: IMPORTED_SLOTS });

    await createApp(APP_A, "ハシバミ製作所の注文管理");
    calls = [];
    // **1往復 = get_manifest + apply_diff の2ツール呼び出しである**(専用の口は無い)。
    const template = await manifestOf(TEMPLATE_APP);
    await applyTheme(APP_A, "d-apply-0001", {
      slots: template.app.theme?.slots ?? {},
      origin: { template_app_id: TEMPLATE_APP, template_diff_id: "d-import-0001" },
    });
    expect(calls).toEqual(["get_manifest", "apply_diff"]);

    const applied = await manifestOf(APP_A);
    expect(applied.app.theme?.slots).toEqual(IMPORTED_SLOTS);
    expect(applied.app.theme?.origin).toEqual({
      template_app_id: TEMPLATE_APP,
      template_diff_id: "d-import-0001",
    });
  });

  test("カーネルは origin の真偽を1つも検証しない(ADR-0047 限定7。自己申告である)", async () => {
    await createApp(APP_A, "ハシバミ製作所の注文管理");
    const result = await callTool("apply_diff", {
      app_id: APP_A,
      diff: importDiff("d-apply-0001", {
        slots: IMPORTED_SLOTS,
        origin: { template_app_id: "brand-guide-pdf", template_diff_id: "d-9999" },
      }),
    });
    // **通る。** 「ブランドガイドの PDF から取り込んだ」と名乗っても検証されない。
    expect(result.isError).toBe(false);
    expect((await manifestOf(APP_A)).app.theme?.origin?.template_app_id).toBe("brand-guide-pdf");
    const apps = (await ok("list_apps", {})).apps as { app_id: string }[];
    expect(apps.map((app) => app.app_id)).not.toContain("brand-guide-pdf");
  });
});
