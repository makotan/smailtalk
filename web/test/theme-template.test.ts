/**
 * テンプレート(組織内再利用)と持ち出しの**実地の実測**(V3-M1-T05 / D-G3a・D-G3b)。
 *
 * 完了条件の正は `docs/plan/v3/records/v3-m1.md` §2 の「V3-M1-T05」節、審査の正は
 * `docs/plan/v3/records/v3-m1-gate-a-theme.md` §4 / §5(**どちらも門外 Δ7・判定は将来送り**)。
 *
 * ## なぜ `web/test/` に在るのか(置き場の理由。隠さず書く)
 *
 * 本タスクは**門外(Δ7)で通っている** —— `src/` と `schemas/` が1バイトでも変わったら
 * 歯止め1-1 により門A へ差し戻される(T05-12 / 審査記録 §4 歯止め3)。したがって
 * **`src/kernel/` や `src/mcp/` にテストファイルを1本も置けない。** 触ってよい場所のうち
 * テストを置けるのは `web/test/` と `web/e2e/` だけなので、ここに置く。
 * **内容はカーネル・MCP の実測であって表示層の検査ではない**(表示層は `theme-export.test.tsx`)。
 *
 * ## 何を使って測るか
 *
 * **既存の MCP ツールだけ**である(`create_app` / `get_manifest` / `apply_diff` / `undo` /
 * `list_apps` / `delete_app`)。審査の歯止め2 が挙げた参照先3関数(`createApp` /
 * `readCurrentManifest` / `applyDiff`)は、この3ツールを通してのみ呼ばれる ——
 * **新しい入口を1つも開けない。** 接続は `InMemoryTransport.createLinkedPair()`
 * (`src/mcp/server.test.ts` と `src/server/batch.test.ts` の作法)で、
 * **カーネルの値を1つも import しない**(ADR-0009 限定2 / `scripts/kernel-import-drift.test.ts`)。
 *
 * ## 何を実測するか(完了条件との対応)
 *
 * | 条件 | 何を確かめるか |
 * |---|---|
 * | T05-1 | テンプレート app → 別 app への当て直しが通り、**由来(origin)が当てた側に記録される** |
 * | T05-1 | **カーネルは由来の真偽を検証しない**(実在しないアプリを指しても通る)|
 * | T05-2 | **手数**(何往復・何スロット)。自動伝播しないこと・部分適用の op が無いこと |
 * | T05-3 | **`theme.json` は `get_manifest` 出力の `/app/theme` そのもの**(変換層が0件)|
 * | T05-8 | 既存機構4件(**アプリ削除 / バックアップ / スナップショット・undo / blob**)|
 * | T05-9 | テンプレートの中にテンプレート(由来の連鎖)を**カーネルが辿らない** |
 * | T05-10 | **孤児**(テンプレートを消しても見た目は壊れず、由来だけが指し先を失う)|
 * | T05-11 | **MCP ツールを1つも増やしていない**(Δ5 非発火の側面)|
 *
 * ## 何を実測しないか(誇張しない)
 *
 * - **画面のことは1つも見ていない。** 描画の実測は `web/e2e/theme.e2e.ts`(T04)と
 *   `web/e2e/theme-export.e2e.ts`(T05)である。
 * - **「組織」という単位は実装に無い。** ここで「組織のテンプレート」と呼んでいるのは
 *   **owner が作った1つのアプリ**であり、テナント・組織の概念は1バイトも作っていない(T05-7)。
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Manifest, Theme } from "../../src/kernel/types.ts";
import { createMcpServer } from "../../src/mcp/server.ts";
import { runBackup } from "../../src/server/backup.ts";
import { seedSession } from "../../src/server/test-helpers.ts";

const REPO_ROOT = dirname(dirname(import.meta.dir));
const MANIFEST_SCHEMA_PATH = join(REPO_ROOT, "schemas", "manifest.schema.json");

const TEMPLATE_APP = "org-theme";
const APP_A = "shop-a";
const APP_B = "shop-b";

/**
 * テンプレートのスロット25件。**コントラスト検査を通る値である** ——
 * **この製品の既定配色はテンプレートにできない**(`--color-border` の `#ddd` が
 * 非テキスト閾値 3:1 を下回って必ず拒否される。ADR-0046 の 2026-07-25 追記「限界7」/
 * T03 の実測 / T04 の申し送り4)。ここでは枠線を `#767676` に濃くしてある。
 */
const TEMPLATE_SLOTS: Record<string, string> = {
  "--color-text": "#101010",
  "--color-text-secondary": "#595959",
  "--color-text-label": "#595959",
  "--color-text-placeholder": "#595959",
  "--color-danger": "#a00000",
  "--color-page-background": "#ffffff",
  "--color-surface-highlight": "#f2f2f2",
  "--color-border": "#767676",
  "--focus-outline-color": "#005fcc",
  "--focus-outline-width": "2px",
  "--font-family-base": "Georgia, serif",
  "--font-size-secondary": "0.85em",
  "--font-size-note": "0.875rem",
  "--line-height-base": "1.6",
  "--space-1": "0.25rem",
  "--space-2": "0.5rem",
  "--space-3": "0.75rem",
  "--space-4": "1rem",
  "--space-5": "1.25rem",
  "--space-6": "2rem",
  "--border-width": "1px",
  "--control-border-radius": "4px",
  "--surface-shadow": "none",
  "--detail-label-width": "8rem",
  "--login-max-width": "22rem",
};

/** `$defs/theme` の properties キー(**ファイルとして読む**。ADR-0009 限定2)。 */
function themeSlotNames(): string[] {
  const schema = JSON.parse(readFileSync(MANIFEST_SCHEMA_PATH, "utf-8")) as {
    $defs: { theme: { properties: Record<string, unknown> } };
  };
  return Object.keys(schema.$defs.theme.properties);
}

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
/** MCP ツールの呼び出し回数(T05-2 の「手数」を数値で出すため)。 */
let calls: string[];

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-theme-template-"));
  const server = createMcpServer({
    dataRoot,
    previewBaseUrl: "http://127.0.0.1:3000",
    actor: ACTOR,
  });
  client = new Client({ name: "theme-template-test", version: "0.0.0" });
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

/** MCP ツールを1回呼ぶ(**呼び出し回数を数える**)。 */
async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  calls.push(name);
  const result = await client.callTool({ name, arguments: args });
  return {
    isError: result.isError === true,
    data: (result.structuredContent ?? {}) as Record<string, unknown>,
  };
}

/** 成功前提でツールを呼ぶ。 */
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

function setThemeDiff(diffId: string, theme: Theme): Record<string, unknown> {
  return {
    diff_id: diffId,
    intent: "組織で作った見た目をこのアプリにも当てたい、という要望に応えてテーマを写した",
    operations: [{ op: "set_theme", theme }],
  };
}

async function applyTheme(appId: string, diffId: string, theme: Theme): Promise<void> {
  await ok("apply_diff", { app_id: appId, diff: setThemeDiff(diffId, theme) });
}

async function manifestOf(appId: string): Promise<Manifest> {
  const data = await ok("get_manifest", { app_id: appId });
  return data.manifest as Manifest;
}

function manifestFileOf(appId: string): string {
  return join(dataRoot, "apps", appId, "manifest.json");
}

/** アプリのディレクトリ配下の相対パス全件(blob 経路の不使用を見るため)。 */
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

/** `kernel.sqlite` のテーブル名(アプリ横断テーブルが増えていないことを見るため)。 */
function kernelTableNames(): string[] {
  const db = new Database(join(dataRoot, "kernel.sqlite"), { readwrite: true, create: false });
  try {
    return db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

/** `kernel.sqlite` の全行を文字列化したもの(特定の app_id が残っていないかを見るため)。 */
function kernelDump(): string {
  const db = new Database(join(dataRoot, "kernel.sqlite"), { readwrite: true, create: false });
  try {
    let text = "";
    for (const name of kernelTableNames()) {
      if (name.startsWith("sqlite_")) continue;
      for (const row of db.query(`SELECT * FROM "${name}"`).all()) {
        text += `${name}:${JSON.stringify(row)}\n`;
      }
    }
    return text;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// T05-1: テンプレート app → 別 app(由来が記録されること)
// ---------------------------------------------------------------------------

describe("T05-1 テンプレートを既存 app として持つ運用(実際に通す)", () => {
  test("テンプレートの25スロットが別アプリへそのまま移り、由来が当てた側に記録される", async () => {
    await createApp(TEMPLATE_APP, "組織の見た目(テンプレート用アプリ)");
    await applyTheme(TEMPLATE_APP, "d-tpl-0001", { slots: TEMPLATE_SLOTS });

    // **読むのは普通の `get_manifest` である**(テンプレート専用の読み口は無い)。
    const template = await manifestOf(TEMPLATE_APP);
    expect(template.app.theme?.slots).toEqual(TEMPLATE_SLOTS);
    // テンプレート側は由来を持たない(手で作ったテーマ)。
    expect(template.app.theme?.origin).toBeUndefined();

    await createApp(APP_A, "お店A");
    await applyTheme(APP_A, "d-a-0001", {
      slots: template.app.theme?.slots ?? {},
      origin: { template_app_id: TEMPLATE_APP, template_diff_id: "d-tpl-0001" },
    });

    const applied = await manifestOf(APP_A);
    // 値が往復した(1バイトも変わっていない)。
    expect(applied.app.theme?.slots).toEqual(TEMPLATE_SLOTS);
    expect(JSON.stringify(applied.app.theme?.slots)).toBe(JSON.stringify(TEMPLATE_SLOTS));
    // **由来が記録された**(これが T05-1 の主張そのものである)。
    expect(applied.app.theme?.origin).toEqual({
      template_app_id: TEMPLATE_APP,
      template_diff_id: "d-tpl-0001",
    });
  });

  test("カーネルは由来の真偽を検証しない(実在しないアプリを指しても通る)", async () => {
    await createApp(APP_A, "お店A");
    // **TDD の赤**: 最初は `isError: true`(= カーネルが検証する)を期待して赤を実測した。
    // 実測の結果は「通る」であり、期待の側を実測に合わせた(実施記録 §TDD の赤④)。
    const result = await callTool("apply_diff", {
      app_id: APP_A,
      diff: setThemeDiff("d-a-0001", {
        slots: TEMPLATE_SLOTS,
        origin: { template_app_id: "no-such-app", template_diff_id: "d-9999" },
      }),
    });
    expect(result.isError).toBe(false);

    const applied = await manifestOf(APP_A);
    expect(applied.app.theme?.origin?.template_app_id).toBe("no-such-app");
    // **確かめられるのは「値が往復すること」だけである** —— 由来の実在も版の一致も、
    // 呼び出し側(AI)の自己申告である(ADR-0047 限定7 / 限界(f))。
    const apps = (await ok("list_apps", {})).apps as { app_id: string }[];
    expect(apps.map((app) => app.app_id)).not.toContain("no-such-app");
  });
});

// ---------------------------------------------------------------------------
// T05-2: 手数(正直に数える)
// ---------------------------------------------------------------------------

describe("T05-2 手数(自動伝播しない。当て直しは常に25スロット全部)", () => {
  test("テンプレートを更新しても、当てた側は再適用まで1バイトも変わらない", async () => {
    await createApp(TEMPLATE_APP, "組織の見た目");
    await applyTheme(TEMPLATE_APP, "d-tpl-0001", { slots: TEMPLATE_SLOTS });
    await createApp(APP_A, "お店A");
    await applyTheme(APP_A, "d-a-0001", {
      slots: TEMPLATE_SLOTS,
      origin: { template_app_id: TEMPLATE_APP, template_diff_id: "d-tpl-0001" },
    });

    // テンプレートを更新する(1往復)。
    const updated = { ...TEMPLATE_SLOTS, "--control-border-radius": "8px" };
    await applyTheme(TEMPLATE_APP, "d-tpl-0002", { slots: updated });

    // **当てた側は変わっていない**(自動伝播は無い。01 §2a M-1)。
    const before = await manifestOf(APP_A);
    expect(before.app.theme?.slots["--control-border-radius"]).toBe("4px");

    // 再適用の手数を数える: 1アプリにつき get_manifest + apply_diff の2往復。
    calls = [];
    const template = await manifestOf(TEMPLATE_APP);
    await applyTheme(APP_A, "d-a-0002", {
      slots: template.app.theme?.slots ?? {},
      origin: { template_app_id: TEMPLATE_APP, template_diff_id: "d-tpl-0002" },
    });
    expect(calls).toEqual(["get_manifest", "apply_diff"]);

    const after = await manifestOf(APP_A);
    expect(after.app.theme?.slots["--control-border-radius"]).toBe("8px");
    expect(after.app.theme?.origin?.template_diff_id).toBe("d-tpl-0002");
  });

  test("N アプリへの再適用は 1 + 2N 往復であり、1回につき25スロット全部を書く", async () => {
    await createApp(TEMPLATE_APP, "組織の見た目");
    await createApp(APP_A, "お店A");
    await createApp(APP_B, "お店B");

    calls = [];
    // テンプレートの更新1回 + (get_manifest + apply_diff) × 2アプリ = 5往復。
    await applyTheme(TEMPLATE_APP, "d-tpl-0001", { slots: TEMPLATE_SLOTS });
    for (const [index, appId] of [APP_A, APP_B].entries()) {
      const template = await manifestOf(TEMPLATE_APP);
      const slots = template.app.theme?.slots ?? {};
      // **常に25スロット全部である**(部分適用の op は無い。ADR-0047 限定3 / T03 の申し送り3)。
      expect(Object.keys(slots)).toHaveLength(25);
      expect(Object.keys(slots).sort()).toEqual(themeSlotNames().sort());
      await applyTheme(appId, `d-copy-000${index + 1}`, {
        slots,
        origin: { template_app_id: TEMPLATE_APP, template_diff_id: "d-tpl-0001" },
      });
    }
    expect(calls).toEqual([
      "apply_diff",
      "get_manifest",
      "apply_diff",
      "get_manifest",
      "apply_diff",
    ]);
    expect(calls).toHaveLength(5);
  });

  test("24スロットだけ写す(部分テーマ)は拒否される —— 手を抜く道が無い", async () => {
    await createApp(APP_A, "お店A");
    const partial = { ...TEMPLATE_SLOTS };
    delete partial["--space-6"];

    const result = await callTool("apply_diff", {
      app_id: APP_A,
      diff: setThemeDiff("d-a-0001", { slots: partial }),
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.data)).toContain("--space-6");
    // 拒否なので1バイトも変わっていない。
    expect((await manifestOf(APP_A)).app.theme).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// T05-3: theme.json は get_manifest の出力そのもの(案#1。追加実装0)
// ---------------------------------------------------------------------------

describe("T05-3 theme.json は get_manifest 出力の /app/theme である(変換層0件)", () => {
  test("マニフェストの部分木がそのまま theme.json であり、書き出して別アプリへ戻せる", async () => {
    await createApp(TEMPLATE_APP, "組織の見た目");
    await applyTheme(TEMPLATE_APP, "d-tpl-0001", { slots: TEMPLATE_SLOTS });

    const manifest = await manifestOf(TEMPLATE_APP);
    const theme = manifest.app.theme;
    expect(theme).toBeDefined();
    if (theme === undefined) return;

    // **部分木である**ことの機械的な確認 —— テーマの JSON 表現が、マニフェスト全体の
    // JSON 表現の中に**そのまま部分文字列として現れる**(変換も再整列もしていない)。
    expect(JSON.stringify(manifest)).toContain(JSON.stringify(theme));
    // 永続化されたファイルの側でも**同じ部分木でキーの並びも同じ**である
    // (`get_manifest` が別形に整えていない)。**ファイルは2空白で整形されているので
    //  バイト列としての部分文字列にはならない** —— 実測してそう分かった(実施記録 §TDD の赤③)。
    const onDisk = JSON.parse(readFileSync(manifestFileOf(TEMPLATE_APP), "utf-8")) as Manifest;
    expect(JSON.stringify(onDisk.app.theme)).toBe(JSON.stringify(theme));

    // 「持ち出した theme.json」をファイルとして書き、読み直して別アプリへ当てる。
    const themeJsonPath = join(dataRoot, "theme.json");
    writeFileSync(themeJsonPath, `${JSON.stringify(theme, null, 2)}\n`, "utf-8");
    const carried = JSON.parse(readFileSync(themeJsonPath, "utf-8")) as Theme;

    await createApp(APP_B, "お店B");
    await applyTheme(APP_B, "d-b-0001", {
      slots: carried.slots,
      origin: { template_app_id: TEMPLATE_APP, template_diff_id: "d-tpl-0001" },
    });
    expect((await manifestOf(APP_B)).app.theme?.slots).toEqual(theme.slots);
  });
});

// ---------------------------------------------------------------------------
// T05-8: 既存機構4件との関係(**1件ずつ実測する**)
// ---------------------------------------------------------------------------

describe("T05-8 (1) アプリ削除(ADR-0031)", () => {
  test("テーマを持ち込んでも kernel.sqlite のテーブル集合は1つも増えない", async () => {
    await createApp(TEMPLATE_APP, "組織の見た目");
    const before = kernelTableNames();

    await applyTheme(TEMPLATE_APP, "d-tpl-0001", { slots: TEMPLATE_SLOTS });
    await createApp(APP_A, "お店A");
    await applyTheme(APP_A, "d-a-0001", {
      slots: TEMPLATE_SLOTS,
      origin: { template_app_id: TEMPLATE_APP },
    });

    // **アプリ横断テーブルを1つも足していない** —— したがって ADR-0031 の再審査条件
    // (「`kernel.sqlite` にアプリ横断テーブルを足すタスクは `APP_SCOPED_KERNEL_TABLES` への
    //  追記を完了条件に含める」)は本タスクに掛からない。
    expect(kernelTableNames()).toEqual(before);
  });

  test("テンプレート app の削除は appDir の削除で閉じ、kernel.sqlite に痕跡が残らない", async () => {
    await createApp(TEMPLATE_APP, "組織の見た目");
    await applyTheme(TEMPLATE_APP, "d-tpl-0001", { slots: TEMPLATE_SLOTS });
    await createApp(APP_A, "お店A");
    await applyTheme(APP_A, "d-a-0001", {
      slots: TEMPLATE_SLOTS,
      origin: { template_app_id: TEMPLATE_APP, template_diff_id: "d-tpl-0001" },
    });

    expect(kernelDump()).toContain(TEMPLATE_APP);
    await ok("delete_app", { app_id: TEMPLATE_APP });

    // テンプレートは **`appDir` の外に1バイトも出ていない**ので、削除で全部消える。
    expect(existsSync(join(dataRoot, "apps", TEMPLATE_APP))).toBe(false);
    // `kernel.sqlite` にもテンプレート側の痕跡は残らない(台帳行・changelog ごと消える)。
    // **ただし当てた側のマニフェストに書かれた由来は消えない**(下の孤児の節)。
    const dump = kernelDump();
    expect(dump).not.toContain(`"${TEMPLATE_APP}"`);
    expect(dump).toContain(`"${APP_A}"`);
    // 当てた側は無傷である。
    expect((await manifestOf(APP_A)).app.theme?.slots).toEqual(TEMPLATE_SLOTS);
  });
});

describe("T05-8 (2) バックアップ(ADR-0019)", () => {
  test("テーマは manifest.json の中にあるので、バックアップ世代へそのまま入る", async () => {
    await createApp(APP_A, "お店A");
    await applyTheme(APP_A, "d-a-0001", { slots: TEMPLATE_SLOTS });

    const result = runBackup(dataRoot);
    expect(result.apps).toContain(APP_A);
    expect(result.skipped).toEqual([]);

    const copied = join(result.dir, "apps", APP_A, "manifest.json");
    expect(existsSync(copied)).toBe(true);
    // **バイト列として同一である**(バックアップは manifest.json を copyFileSync するだけで、
    // テーマ専用の扱いを1つも持たない = 関係が変わっていない)。
    expect(readFileSync(copied)).toEqual(readFileSync(manifestFileOf(APP_A)));
    const restored = JSON.parse(readFileSync(copied, "utf-8")) as Manifest;
    expect(restored.app.theme?.slots).toEqual(TEMPLATE_SLOTS);
  });
});

describe("T05-8 (3) スナップショット・undo(ADR-0004 / 0011)", () => {
  test("当て直しの前の状態がスナップショットに残り、undo で戻る", async () => {
    await createApp(APP_A, "お店A");
    await applyTheme(APP_A, "d-a-0001", { slots: TEMPLATE_SLOTS });

    const snapshots = readdirSync(join(dataRoot, "apps", APP_A, "snapshots"));
    expect(snapshots.length).toBeGreaterThan(0);
    // スナップショットは**適用前**の状態である(テーマを持っていなかった状態)。
    const snapshotManifests = snapshots.map((name) => {
      return JSON.parse(
        readFileSync(join(dataRoot, "apps", APP_A, "snapshots", name, "manifest.json"), "utf-8"),
      ) as Manifest;
    });
    expect(snapshotManifests.some((manifest) => manifest.app.theme === undefined)).toBe(true);

    // 2つ目のテーマを当ててから undo すると、1つ目のテーマに戻る。
    await applyTheme(APP_A, "d-a-0002", {
      slots: { ...TEMPLATE_SLOTS, "--space-1": "0.5rem" },
      origin: { template_app_id: TEMPLATE_APP },
    });
    await ok("undo", { app_id: APP_A });

    const back = await manifestOf(APP_A);
    expect(back.app.theme?.slots).toEqual(TEMPLATE_SLOTS);
    expect(back.app.theme?.origin).toBeUndefined();
  });
});

describe("T05-8 (4) blob(ADR-0035)", () => {
  test("テーマは blob の経路を1バイトも使わない(blobs/ が作られない)", async () => {
    await createApp(APP_A, "お店A");
    const before = fileTreeOf(APP_A);
    await applyTheme(APP_A, "d-a-0001", {
      slots: TEMPLATE_SLOTS,
      origin: { template_app_id: TEMPLATE_APP },
    });

    expect(existsSync(join(dataRoot, "apps", APP_A, "blobs"))).toBe(false);
    // 増えたのはスナップショット配下のファイルだけである(実値は manifest.json の中にある)。
    const added = fileTreeOf(APP_A).filter((path) => !before.includes(path));
    expect(added.every((path) => path.startsWith("snapshots/"))).toBe(true);
    expect(added.some((path) => path.includes("blob"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T05-9: 入れ子(由来の連鎖をカーネルが辿らない)
// ---------------------------------------------------------------------------

describe("T05-9 テンプレートの中にテンプレートを参照させない(自己適用の一段を作らない)", () => {
  test("由来つきのテンプレートから写しても、カーネルは連鎖を1段も辿らない", async () => {
    // テンプレート1(源) → テンプレート2(由来つき)→ 当てる先。
    await createApp(TEMPLATE_APP, "組織の見た目(源)");
    await applyTheme(TEMPLATE_APP, "d-tpl-0001", { slots: TEMPLATE_SLOTS });

    await createApp(APP_B, "部門の見た目(源から派生)");
    await applyTheme(APP_B, "d-b-0001", {
      slots: { ...TEMPLATE_SLOTS, "--color-text": "#202020" },
      origin: { template_app_id: TEMPLATE_APP, template_diff_id: "d-tpl-0001" },
    });

    await createApp(APP_A, "お店A");
    const derived = await manifestOf(APP_B);
    await applyTheme(APP_A, "d-a-0001", {
      slots: derived.app.theme?.slots ?? {},
      origin: { template_app_id: APP_B, template_diff_id: "d-b-0001" },
    });

    const applied = await manifestOf(APP_A);
    // **由来は1段だけである** —— カーネルは APP_B の由来(源)を辿らず、
    // 「源から来た」という情報をどこにも作らない(辿る形は憲法1 の射程。審査記録 §4 問1)。
    expect(applied.app.theme?.origin).toEqual({
      template_app_id: APP_B,
      template_diff_id: "d-b-0001",
    });
    expect(JSON.stringify(applied.app.theme)).not.toContain(TEMPLATE_APP);
  });
});

// ---------------------------------------------------------------------------
// T05-10: 孤児(検出のみ・自動刈り取りなし)
// ---------------------------------------------------------------------------

describe("T05-10 孤児の扱い(見た目は壊れず、由来だけが指し先を失う)", () => {
  test("テンプレートを消しても実値は残り、由来は消えない(自動刈り取りが無い)", async () => {
    await createApp(TEMPLATE_APP, "組織の見た目");
    await applyTheme(TEMPLATE_APP, "d-tpl-0001", { slots: TEMPLATE_SLOTS });
    await createApp(APP_A, "お店A");
    await applyTheme(APP_A, "d-a-0001", {
      slots: TEMPLATE_SLOTS,
      origin: { template_app_id: TEMPLATE_APP, template_diff_id: "d-tpl-0001" },
    });

    await ok("delete_app", { app_id: TEMPLATE_APP });

    // マニフェストは読める(参照整合性検査の対象ではない。ADR-0047 限定7)。
    const orphaned = await manifestOf(APP_A);
    // **実値はそのまま残る = 見た目は壊れない。**
    expect(orphaned.app.theme?.slots).toEqual(TEMPLATE_SLOTS);
    // **由来は消えない** —— 指し先を失ったまま残る(**自動刈り取りは無い**)。
    expect(orphaned.app.theme?.origin?.template_app_id).toBe(TEMPLATE_APP);
    expect(readFileSync(manifestFileOf(APP_A), "utf-8")).toContain(TEMPLATE_APP);

    // **検出はできる**(既存の2ツールの突合だけである。専用の検出口は今日1つも無い)。
    const apps = (await ok("list_apps", {})).apps as { app_id: string }[];
    const known = new Set(apps.map((app) => app.app_id));
    const origin = orphaned.app.theme?.origin?.template_app_id;
    expect(origin !== undefined && !known.has(origin)).toBe(true);

    // 当て直しても孤児の記録は消えず、由来が新しい指し先に置き換わるだけである
    // (**どちらでも孤児資産は蓄積する。「解決した」と書いてはならない**)。
    await createApp(APP_B, "組織の見た目(作り直し)");
    await applyTheme(APP_B, "d-b-0001", { slots: TEMPLATE_SLOTS });
    await applyTheme(APP_A, "d-a-0002", {
      slots: TEMPLATE_SLOTS,
      origin: { template_app_id: APP_B, template_diff_id: "d-b-0001" },
    });
    const rebound = await manifestOf(APP_A);
    expect(rebound.app.theme?.origin?.template_app_id).toBe(APP_B);
    // 消えた `org-theme` を指していた履歴は `_changelog` に残り続ける(削除されない)。
    expect(kernelDump()).toContain(TEMPLATE_APP);
  });
});

// ---------------------------------------------------------------------------
// T05-11: MCP ツールを1つも増やしていない(Δ5 非発火の側面)
// ---------------------------------------------------------------------------

describe("T05-11 持ち出しのために MCP ツールもリソース種も増やしていない", () => {
  test("ツール一覧にテーマ用・持ち出し用のツールが1つも無い", async () => {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    // 案#3(`export_theme` を MCP ツールとして足す)は採らない ——
    // 帰属先は表示層であり、MCP 層に出すと Δ10 で差し戻される(審査記録 §5 S4)。
    expect(names.filter((name) => /theme/i.test(name))).toEqual([]);
    expect(names.filter((name) => /export|template/i.test(name))).toEqual([]);
    // テーマは既存の `apply_diff` の中の op であって、ツールではない。
    expect(names).toContain("apply_diff");
    expect(names).toContain("get_manifest");
  });
});
