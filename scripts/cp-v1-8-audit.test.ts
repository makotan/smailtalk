/**
 * CP-V1-8 機械照合スクリプトの検査(V1-M8-T02)。
 *
 * ## 陰性対照が中心である
 *
 * 「合格した」ことだけを見るテストは、**監査が空回りしていても緑になる**。したがって
 * ここでの主眼は「壊した文書を食わせたときに、狙った検査が実際に落ちること」である。
 * 壊し方は CP-V1-8 が塞ごうとしている形に対応させてある:
 *
 *  (a) `sources` を空にする            → 確認方法2(出典欄が空の記述が0件)
 *  (b) 実在しない識別子をバッククォートで混ぜる → 確認方法3(識別子の集合照合)
 *  (c) 実在しない表示名を鉤括弧で混ぜる  → 確認方法3(表示名の集合照合)
 *  (d) verbatim を1バイト書き換える     → 追加検査(逐語のバイト一致)
 *
 * さらに (e) 出典を実在しない seq に付け替える / (f) 空の文書 を足してある。
 * **(f) は「0件検査で合格と出さない」ことの検査である。**
 *
 * 監査は別プロセスとして起動して終了コードと標準出力を見る(`src/cli/validate.test.ts` と同じ作法)。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFixture } from "./cp-v1-8-fixture.ts";

const ROOT = join(import.meta.dir, "..");
const AUDIT = join(ROOT, "scripts", "cp-v1-8-audit.ts");
const CLI = join(ROOT, "src", "cli", "requirements-doc.ts");

let dataRoot: string;
let appId: string;
let docPath: string;

type RunResult = { code: number; stdout: string };

async function run(script: string, args: string[]): Promise<RunResult> {
  const proc = Bun.spawn([process.execPath, "run", script, ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { code, stdout };
}

function runAudit(doc: string): Promise<RunResult> {
  return run(AUDIT, ["--data-root", dataRoot, "--app", appId, "--doc", doc]);
}

/** 生成物を読み、書き換えて別ファイルに落とす。**元の文書は壊さない。** */
function mutate(name: string, edit: (doc: Record<string, unknown>) => void): string {
  const doc = JSON.parse(readFileSync(docPath, "utf-8")) as Record<string, unknown>;
  edit(doc);
  const path = join(dataRoot, `${name}.json`);
  writeFileSync(path, JSON.stringify(doc, null, 2), "utf-8");
  return path;
}

type Statement = {
  id: string;
  template: string;
  slots: Record<string, { kind: string; value?: unknown }>;
  sources: unknown[];
};

function statements(doc: Record<string, unknown>): Statement[] {
  return doc.statements as Statement[];
}

beforeAll(async () => {
  const fixture = await buildFixture();
  dataRoot = fixture.dataRoot;
  appId = fixture.appId;
  docPath = join(dataRoot, "doc.json");
  const generated = await run(CLI, [
    "--data-root",
    dataRoot,
    "--app",
    appId,
    "--json",
    docPath,
    "--out",
    join(dataRoot, "doc.md"),
  ]);
  if (generated.code !== 0) {
    throw new Error(`試材の要件定義書を生成できませんでした:\n${generated.stdout}`);
  }
});

afterAll(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

test("正例: 合成試材の要件定義書は全検査に合格し、検査件数が0件ではない", async () => {
  const result = await runAudit(docPath);
  expect(result.stdout).toContain("\n合格: 上の件数のとおり");
  expect(result.code).toBe(0);

  // 「何件検査したか」が出ていること。0件で合格と出さない担保の対になる。
  const counts = /確認方法2\(全数\): 出典欄が空の記述が0件: 検査 (\d+) 件/.exec(result.stdout);
  expect(counts).not.toBeNull();
  expect(Number(counts?.[1] ?? 0)).toBeGreaterThan(20);
  expect(result.stdout).toContain("このスクリプトが検査していないこと");
  // 残差検査を「やった」と書かないこと(ADR-0025 §4-3 の分担)。
  expect(result.stdout).toContain("残差検査(ADR-0025 §4-3");
});

test("陰性対照(a): sources を空にした記述があれば落ちる(確認方法2)", async () => {
  const path = mutate("broken-sources", (doc) => {
    const target = statements(doc)[3];
    if (target === undefined) {
      throw new Error("試材の statements が足りません。");
    }
    target.sources = [];
  });
  const result = await runAudit(path);
  expect(result.code).not.toBe(0);
  expect(result.stdout).toContain("sources_nonempty");
});

test("陰性対照(b): 実在しない識別子をバッククォートで混ぜたら落ちる(確認方法3)", async () => {
  const path = mutate("fake-identifier", (doc) => {
    doc.markdown = `${String(doc.markdown)}\n実在しない台帳 \`no-such-table\` について述べる。\n`;
  });
  const result = await runAudit(path);
  expect(result.code).not.toBe(0);
  expect(result.stdout).toContain("backtick_span_exists");
  expect(result.stdout).toContain("no-such-table");
});

test("陰性対照(c): 実在しない表示名を鉤括弧で混ぜたら落ちる(確認方法3)", async () => {
  // **`本` は実在し `本棚` は実在しない。**部分文字列マッチで実装していれば
  // `本` が実在するので通ってしまう(ADR-0025 §4-1)。完全一致であることの検査でもある。
  const path = mutate("fake-display-name", (doc) => {
    doc.markdown = `${String(doc.markdown)}\nこのアプリはテーブル 「本棚」 を持つ。\n`;
  });
  const result = await runAudit(path);
  expect(result.code).not.toBe(0);
  expect(result.stdout).toContain("kagikakko_span_exists");
  expect(result.stdout).toContain("本棚");
});

test("陰性対照(d): verbatim を1バイト書き換えたら落ちる(逐語のバイト一致)", async () => {
  const path = mutate("broken-verbatim", (doc) => {
    const target = statements(doc).find((statement) =>
      Object.values(statement.slots).some((slot) => slot.kind === "verbatim"),
    );
    if (target === undefined) {
      throw new Error("試材に verbatim スロットがありません。");
    }
    for (const slot of Object.values(target.slots)) {
      if (slot.kind === "verbatim") {
        slot.value = `${String(slot.value)}.`;
      }
    }
  });
  const result = await runAudit(path);
  expect(result.code).not.toBe(0);
  expect(result.stdout).toContain("verbatim_bytes");
});

test("陰性対照(e): 実在しない seq を指す出典があれば落ちる(出典の実在)", async () => {
  const path = mutate("missing-source", (doc) => {
    const target = statements(doc).find((statement) =>
      statement.sources.some((source) => (source as { kind?: string }).kind === "changelog"),
    );
    if (target === undefined) {
      throw new Error("試材に changelog 出典がありません。");
    }
    target.sources = target.sources.map((source) => {
      const record = source as { kind?: string; seq?: number };
      return record.kind === "changelog" ? { ...record, seq: 9999 } : source;
    });
  });
  const result = await runAudit(path);
  expect(result.code).not.toBe(0);
  expect(result.stdout).toContain("source_exists");
});

test("陰性対照(f): 記述0件の文書を合格と報告しない(空回りの検出)", async () => {
  const path = mutate("empty-doc", (doc) => {
    doc.statements = [];
    doc.markdown = "# 要件定義書\n";
  });
  const result = await runAudit(path);
  expect(result.code).not.toBe(0);
  expect(result.stdout).toContain("not_vacuous");
});

test("履歴に現れる過去の識別子(rename 前 / undo で消えたもの)は現在のマニフェストに無くても合格する", async () => {
  // ADR-0025 改訂2 の `historical_*` 集合が実際に効いていることの検査。
  // `rating` は d-004 で `score` に改名され、`publisher` は undo で巻き戻された。
  // **どちらも現在のマニフェストには無い**が、changelog の operations には実在する。
  // ここが赤くなるなら、監査は「実在した履歴」を捏造と誤判定している。
  const manifest = readFileSync(join(dataRoot, "apps", appId, "manifest.json"), "utf-8");
  expect(manifest).not.toContain('"rating"');
  expect(manifest).not.toContain('"publisher"');

  const markdown = readFileSync(join(dataRoot, "doc.md"), "utf-8");
  expect(markdown).toContain("`rating`");
  expect(markdown).toContain("`publisher`");

  const result = await runAudit(docPath);
  expect(result.code).toBe(0);
});

test("入力エラー(--doc なし)は検査の不合格と別の終了コードになる", async () => {
  const result = await run(AUDIT, ["--data-root", dataRoot, "--app", appId]);
  expect(result.code).toBe(2);
});

test("ADR-0025 §4-6: 監査スクリプトは生成器(requirements-doc.ts)を1行も import しない", () => {
  // これが破られると、生成側と監査側が同じ集合構築を共有し、**集合の作り方が間違っていても
  // 両方が通る**(循環する)。文言ではなく実ファイルで固定する。
  const source = readFileSync(AUDIT, "utf-8");
  const importLines = source
    .split("\n")
    .filter((line) => /^\s*import\s/.test(line) || /^\s*}\s*from\s/.test(line));
  expect(importLines.some((line) => line.includes("requirements-doc"))).toBe(false);
  expect(source.includes('from "../src/kernel/requirements-doc.ts"')).toBe(false);
});

test("試材(cp-v1-8-fixture)は CP-V1-8 の照合に必要な要素をすべて含む", () => {
  const manifest = JSON.parse(
    readFileSync(join(dataRoot, "apps", appId, "manifest.json"), "utf-8"),
  ) as {
    app: { tables: unknown[]; views: unknown[]; workflows?: unknown[]; functions?: unknown[] };
  };
  expect(manifest.app.tables.length).toBeGreaterThanOrEqual(2);
  expect(manifest.app.views.length).toBeGreaterThanOrEqual(4);
  expect(manifest.app.workflows?.length ?? 0).toBeGreaterThanOrEqual(1);
  expect(manifest.app.functions?.length ?? 0).toBeGreaterThanOrEqual(1);

  const doc = JSON.parse(readFileSync(docPath, "utf-8")) as Record<string, unknown>;
  const templates = statements(doc).map((statement) => statement.template);
  // undo(取り消し)が履歴に現れていること。
  expect(templates).toContain("history.undo");
  expect(templates).toContain("history.undone");
  // 外部到達アクションと AI 呼び出しの詳細(ADR-0025 改訂1 の8テンプレート)を
  // **実地で踏んでいる**こと。踏まないまま「automation 節を検証した」とは言えない。
  for (const template of [
    "automation.action_connection",
    "automation.action_destination",
    "automation.action_payload",
    "automation.action_ai_capability",
    "automation.action_ai_prompt",
    "automation.action_ai_input",
    "automation.action_ai_output_field",
    "automation.action_ai_fallback",
  ]) {
    expect(templates).toContain(template);
  }
  // rename した後の id(score)で語られ、rename 前の id(rating)は現在の定義に出ない。
  const markdown = String(doc.markdown);
  expect(markdown).toContain("`score`");
});

/**
 * **V4-M39-T01(`ADR-0144` A10 / `ADR-0145` A9)。監査が生成器に追随していること。**
 *
 * **試材は画面の見せ方9キーと逃げ道への参照を実地で書いている**(`d-007b`)。
 * **追随できていなければ、監査は実在する語彙・資産名を「捏造」と報告して落ちる**
 * (外れる向きは厳しすぎる側であり、緩む側には外れない)。
 */
test("V4-M39: 画面の見せ方の語彙8グループと逃げ道の資産名を、監査が生成器と独立に再現している", () => {
  const doc = JSON.parse(readFileSync(docPath, "utf-8")) as Record<string, unknown>;
  const templates = new Set(statements(doc).map((statement) => statement.template));
  // **11本すべてを実地で踏んでいること**(踏まないまま「追随した」とは言えない)。
  for (const template of [
    "screens.preset_column_align",
    "screens.preset_column_width",
    "screens.preset_pager_position",
    "screens.preset_label_placement",
    "screens.preset_field_columns",
    "screens.preset_image_size",
    "screens.preset_text_preview",
    "screens.preset_list_shape",
    "screens.preset_density",
    "screens.custom_css",
    "screens.custom_css_digest",
  ]) {
    expect(`${template}:${String(templates.has(template))}`).toBe(`${template}:true`);
  }
  const markdown = String(doc.markdown);
  // **語彙タグはバッククォート、資産名は鉤括弧で描かれる**(ADR-0025 §4-2)。
  expect(markdown).toContain("`card`");
  expect(markdown).toContain("`compact`");
  expect(markdown).toContain("「print-layout」");
  // **ダイジェストは64桁そのまま**(`ADR-0145` A5 / C3。切り詰めない・短縮しない)。
  expect(markdown).toContain("b".repeat(64));
});

test("V4-M39: 試材の要件定義書(見せ方の宣言つき)は監査の全検査に合格する", async () => {
  const result = await runAudit(docPath);
  expect(result.stdout).toContain("\n合格: 上の件数のとおり");
  expect(result.code).toBe(0);
});

test("V4-M39: 監査は逃げ道の資産ストア(CSS の中身)を1度も開かない(憲法1 / ADR-0145 A3)", () => {
  const source = readFileSync(AUDIT, "utf-8");
  const importLines = source
    .split("\n")
    .filter((line) => /^\s*import\s/.test(line) || /^\s*}\s*from\s/.test(line));
  for (const line of importLines) {
    expect(line).not.toContain("blob");
    expect(line).not.toContain("escape-hatch");
  }
  expect(source).not.toContain("getBlob");
  expect(source).not.toContain("putBlob");
});

/** 一時ディレクトリの作成に失敗していないこと(前提の自己検査)。 */
test("試材の dataRoot は一時ディレクトリである(実 data/ を汚さない)", async () => {
  const probe = await mkdtemp(join(tmpdir(), "cp-v1-8-probe-"));
  expect(dataRoot.startsWith(probe.slice(0, probe.lastIndexOf("cp-v1-8-probe-")))).toBe(true);
  await rm(probe, { recursive: true, force: true });
});
