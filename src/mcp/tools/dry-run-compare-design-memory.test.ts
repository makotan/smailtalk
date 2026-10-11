/**
 * **見比べの案と選んだ形の記録・型**(`V20-M15-T01B`。計画 `docs/plan/v20/17-v20-m15-plan.md` §9-3-5・§9-3-6・
 * §10-1 の U3・§10-2 / `ADR-0479` §Decision 4-1・4-2・4-4・4-5 と §影響の調査の `ADR-0476` 1-6 の行 /
 * `D-V20-59`・`D-V20-62`・`D-V20-64`)。
 *
 * 固定するもの:
 * - `compare.off_pattern` は省略可能な真偽(`compare` の中の4本目の鍵)。 **真偽以外は `/compare/off_pattern` の
 *   引数の誤り**(`ADR-0003` §3 の形)で、置き場を1つも作らない。
 * - **本物のアプリの今の定義に型(`app.design_memory.patterns`)が無いのに `off_pattern: true`** なら
 *   `/compare/off_pattern` の引数の誤り(案が型を足す場合でも断る)。 型が在れば通る / `false` なら型が無くても通る。
 * - **`remember_design` の `design_memory.choice` を1本でも含む案は `preview_refused`**(下見も束も作らない)。
 *   **`patterns` だけの `remember_design` は束に入る**(`D-V20-64`)。
 * - `candidate.json` と `/compare` の案に `off_pattern`(付けなければ `false`)。
 * - **下見の写しの `manifest.json` に `choices` が無く `patterns` が在る**(`D-V20-62`)。 `choices` しか無ければ
 *   `design_memory` のキーごと無い。 写しの変更履歴(`kernel.sqlite` の `changelog`)は対象のアプリで0行。
 *   本物の `manifest.json` は1バイトも変わらない。 `design_memory` を持たない / `choices` を持たない写しの
 *   `manifest.json` は書き直さない(バイト列が当てた直後と同じ)。
 * - 道具の引数の鍵は4本のまま・道具は26本のまま・説明に「型を既定に / 外れる案は off_pattern」。
 *
 * **保存の配置(`apps/<id>/manifest.json` / `kernel.sqlite`)はこの検査の中で組み立てる** —— カーネルの値を
 * import すると `scripts/kernel-import-snapshot.txt` が動くため(同じ書き方は `dry-run-compare.test.ts` の `manifestSha`)。
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ValidationError } from "../../kernel/index.ts";
import {
  findGroup,
  findPreview,
  PREVIEW_CANDIDATE_FILE,
  parsePreviewAppId,
  readCandidate,
} from "../../server/preview-store.ts";
import { seedSession } from "../../server/test-helpers.ts";
import { stripDesignChoices } from "../preview.ts";
import { COMPARE_CHOICE_REASON, COMPARE_NO_PATTERN_MESSAGE } from "../preview-compare.ts";
import { createMcpServer } from "../server.ts";

const APP_ID = "workshop";
const TABLE_ID = "notes";
const PREVIEW_BASE_URL = "http://127.0.0.1:3000";
const BOOTSTRAP_ACTOR = "bootstrap";
/** 本物の選んだ記録の理由の目印(写しのどこにも残ってはならない)。 */
const REASON_MARKER = "REASON-MARKER-T01B-0001";
const CHOICE_NAME_MARKER = "CHOICE-NAME-MARKER-T01B-0002";
const PATTERN = "入力フォームは区切りのある1カラムにする";

let work = "";
let dataRoot = "";
let previewRoot = "";

async function callTool(
  name: string,
  args: Record<string, unknown>,
  actor = "alice",
): Promise<CallToolResult> {
  const server = createMcpServer({
    dataRoot,
    previewBaseUrl: PREVIEW_BASE_URL,
    previewRoot,
    actor,
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } finally {
    await client.close();
    await server.close();
  }
}

function okData(result: CallToolResult): Record<string, unknown> {
  if (result.isError === true) {
    throw new Error(`ツールが失敗した: ${JSON.stringify(result.structuredContent)}`);
  }
  return result.structuredContent as Record<string, unknown>;
}

function errorsOf(result: CallToolResult): ValidationError[] {
  expect(result.isError).toBe(true);
  return (result.structuredContent as { errors: ValidationError[] }).errors;
}

function addFieldDiff(diffId = "d-compare", fieldId = "memo"): Record<string, unknown> {
  return {
    diff_id: diffId,
    intent: "メモに覚え書きの欄を足したい",
    operations: [
      { op: "add_field", table: TABLE_ID, field: { id: fieldId, name: "覚え書き", type: "text" } },
    ],
  };
}

function entries(): string[] {
  return existsSync(previewRoot) ? readdirSync(previewRoot).sort() : [];
}

function realManifestPath(root = dataRoot): string {
  return join(root, "apps", APP_ID, "manifest.json");
}

function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function propose(
  compare: Record<string, unknown>,
  body: Record<string, unknown> = addFieldDiff(),
): Promise<CallToolResult> {
  return callTool("dry_run_diff", {
    app_id: APP_ID,
    diff: body,
    preview: "real",
    compare: { name: "案A", tradeoff: "入力は速いが一覧が長くなる", ...compare },
  });
}

/** 本物のアプリに選んだ記録と型を書く(`apply_diff` の `remember_design`。T01A の畳み込み)。 */
async function remember(designMemory: Record<string, unknown>, diffId: string): Promise<void> {
  okData(
    await callTool("apply_diff", {
      app_id: APP_ID,
      diff: {
        diff_id: diffId,
        intent: "選んだ形を記録する",
        operations: [{ op: "remember_design", design_memory: designMemory }],
      },
    }),
  );
}

function shadowRootOf(result: CallToolResult): string {
  const url = (okData(result).preview as { url: string }).url;
  const id = parsePreviewAppId(/\/apps\/(pv-[0-9a-f]{32})\/$/.exec(url)?.[1] ?? "") ?? "";
  const meta = findPreview(previewRoot, id);
  if (meta === null) throw new Error("下見が見つからない");
  return meta.shadow_data_root;
}

function idOfPreview(result: CallToolResult): string {
  const url = (okData(result).preview as { url: string }).url;
  return parsePreviewAppId(/\/apps\/(pv-[0-9a-f]{32})\/$/.exec(url)?.[1] ?? "") ?? "";
}

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "gp-mcp-compare-design-memory-"));
  dataRoot = join(work, "data");
  previewRoot = join(work, "previews");
  okData(await callTool("create_app", { name: "作業場", app_id: APP_ID }, BOOTSTRAP_ACTOR));
  seedSession(dataRoot, APP_ID, { username: "alice" });
  okData(
    await callTool("apply_diff", {
      app_id: APP_ID,
      diff: {
        diff_id: "setup-table",
        intent: "メモの表を用意する",
        operations: [
          {
            op: "add_table",
            table: {
              id: TABLE_ID,
              name: "メモ",
              fields: [{ id: "title", name: "題", type: "text", required: true }],
            },
          },
        ],
      },
    }),
  );
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

describe("off_pattern の形(引数の誤り。置き場を1つも作らない)", () => {
  for (const [label, value] of [
    ["文字列の true", "true"],
    ["数の 1", 1],
    ["null", null],
    ["オブジェクト", {}],
  ] as const) {
    test(`真偽以外(${label})は /compare/off_pattern`, async () => {
      await remember({ patterns: [PATTERN] }, "d-pattern");
      const errors = errorsOf(await propose({ off_pattern: value }));
      const hit = errors.find((e) => e.path === "/compare/off_pattern");
      expect(hit?.message).toContain("off_pattern");
      expect(entries()).toEqual([]);
    });
  }

  test("陽性対照: true / false は形として通る(型の在るアプリ)", async () => {
    await remember({ patterns: [PATTERN] }, "d-pattern");
    for (const value of [true, false]) {
      const data = okData(await propose({ off_pattern: value }));
      expect(Object.keys(data).sort()).toEqual(["compare", "preview", "report"]);
    }
  });
});

describe("型の無いアプリの off_pattern: true は断る(U3。判定は本物の今の型)", () => {
  test("型が1つも無いアプリで off_pattern: true は /compare/off_pattern の引数の誤り(置き場を作らない)", async () => {
    const errors = errorsOf(await propose({ off_pattern: true }));
    expect(errors).toEqual([
      {
        path: "/compare/off_pattern",
        message: COMPARE_NO_PATTERN_MESSAGE,
        hint: expect.any(String),
      },
    ]);
    expect(COMPARE_NO_PATTERN_MESSAGE).toBe(
      "このアプリには型(design_memory.patterns)がありません。off_pattern を外してください。",
    );
    expect(entries()).toEqual([]);
  });

  test("選んだ記録だけが在り型の無いアプリでも断る(型は patterns だけで見る)", async () => {
    await remember({ choice: { name: "案X", tradeoff: "速いが狭い" } }, "d-choice");
    const errors = errorsOf(await propose({ off_pattern: true }));
    expect(errors.map((e) => e.path)).toEqual(["/compare/off_pattern"]);
    expect(entries()).toEqual([]);
  });

  test("案が型を足す差分でも、今の型が無ければ断る", async () => {
    const body = {
      diff_id: "d-add-pattern",
      intent: "型を決めたい",
      operations: [{ op: "remember_design", design_memory: { patterns: [PATTERN] } }],
    };
    const errors = errorsOf(await propose({ off_pattern: true }, body));
    expect(errors.map((e) => e.path)).toEqual(["/compare/off_pattern"]);
    expect(entries()).toEqual([]);
  });

  test("陰性対照: 型の無いアプリでも off_pattern: false / 省略は今日どおり束に入る", async () => {
    okData(await propose({ off_pattern: false }));
    okData(await propose({}, addFieldDiff("d-2", "memo2")));
    expect(entries()).toHaveLength(4); // 案2つと束2つ
  });

  test("陽性対照: 型の在るアプリでは off_pattern: true が束に入る", async () => {
    await remember({ patterns: [PATTERN] }, "d-pattern");
    const data = okData(await propose({ off_pattern: true }));
    expect((data.compare as { count: number }).count).toBe(1);
  });
});

describe("選んだ記録(choice)を含む案は断り、型(patterns)だけの案は束に入る(D-V20-64)", () => {
  const choiceOnly = { choice: { name: CHOICE_NAME_MARKER, tradeoff: "速いが狭い" } };
  const both = {
    choice: { name: CHOICE_NAME_MARKER, tradeoff: "速いが狭い", reason: REASON_MARKER },
    patterns: [PATTERN],
  };
  for (const [label, designMemory] of [
    ["choice だけ", choiceOnly],
    ["choice と patterns", both],
  ] as const) {
    test(`remember_design(${label})を含む案は preview_refused で、下見も束も作らない`, async () => {
      const body = {
        diff_id: "d-choice",
        intent: "欄を足して選んだ形を記録したい",
        operations: [
          {
            op: "add_field",
            table: TABLE_ID,
            field: { id: "memo", name: "覚え書き", type: "text" },
          },
          { op: "remember_design", design_memory: designMemory },
        ],
      };
      // 差分そのものは検証を通る(陽性対照: compare 無しなら今日どおり下見ができる)。
      const plain = okData(
        await callTool("dry_run_diff", { app_id: APP_ID, diff: body, preview: "real" }),
      );
      expect(Object.keys(plain).sort()).toEqual(["preview", "report"]);
      const before = entries();
      const data = okData(await propose({}, body));
      expect(Object.keys(data).sort()).toEqual(["preview_refused", "report"]);
      expect((data.preview_refused as { reason: string }).reason).toBe(COMPARE_CHOICE_REASON);
      expect(entries()).toEqual(before);
    });
  }

  test("2案目(group 付き)に choice を含めても束は1案のまま", async () => {
    const first = okData(await propose({}));
    const group = (first.compare as { group: string }).group;
    const before = entries();
    const body = {
      diff_id: "d-choice-2",
      intent: "選んだ形を記録したい",
      operations: [{ op: "remember_design", design_memory: choiceOnly }],
    };
    const data = okData(await propose({ group }, body));
    expect((data.preview_refused as { reason: string }).reason).toBe(COMPARE_CHOICE_REASON);
    expect(entries()).toEqual(before);
    expect(findGroup(previewRoot, parsePreviewAppId(group) ?? "")?.candidates).toHaveLength(1);
  });

  test("文言は計画 §10-2 の逐語", () => {
    expect(COMPARE_CHOICE_REASON).toBe(
      "選んだ記録(remember_design の design_memory.choice)は見比べの案に書けません。" +
        "選んだ記録は、見比べの画面で案を選んで適用したときに自動で残ります。" +
        "型を変えたいときは design_memory.patterns だけを書いてください。",
    );
  });

  test("patterns だけの remember_design を含む案は束に入る(空配列 = 型を全部外す案も)", async () => {
    await remember({ patterns: ["古い型"] }, "d-old-pattern");
    const replace = {
      diff_id: "d-pat",
      intent: "型を差し替えたい",
      operations: [{ op: "remember_design", design_memory: { patterns: [PATTERN] } }],
    };
    const clear = {
      diff_id: "d-clear",
      intent: "型を外したい",
      operations: [{ op: "remember_design", design_memory: { patterns: [] } }],
    };
    const first = okData(await propose({}, replace));
    const group = (first.compare as { group: string }).group;
    const second = okData(await propose({ group, name: "案B" }, clear));
    expect((second.compare as { count: number }).count).toBe(2);
    // 写しの型は案のとおり(本物は変わらない)。
    const shadow = JSON.parse(
      readFileSync(realManifestPath(shadowRootOf(await propose({}, replace))), "utf-8"),
    ) as { app: { design_memory?: { patterns?: string[] } } };
    expect(shadow.app.design_memory?.patterns).toEqual([PATTERN]);
    const real = JSON.parse(readFileSync(realManifestPath(), "utf-8")) as {
      app: { design_memory?: { patterns?: string[] } };
    };
    expect(real.app.design_memory?.patterns).toEqual(["古い型"]);
  });
});

describe("candidate.json と off_pattern", () => {
  test("付けた値がそのまま入り、付けなければ false", async () => {
    await remember({ patterns: [PATTERN] }, "d-pattern");
    const on = await propose({ off_pattern: true });
    const off = await propose({}, addFieldDiff("d-2", "memo2"));
    expect(readCandidate(previewRoot, idOfPreview(on))?.off_pattern).toBe(true);
    expect(readCandidate(previewRoot, idOfPreview(off))?.off_pattern).toBe(false);
    const raw = JSON.parse(
      readFileSync(join(previewRoot, idOfPreview(off), PREVIEW_CANDIDATE_FILE), "utf-8"),
    ) as Record<string, unknown>;
    expect(raw.off_pattern).toBe(false);
  });

  test("off_pattern の無い古い票は読むときに false(期限1時間の古い票を壊さない)", async () => {
    const result = await propose({});
    const id = idOfPreview(result);
    const path = join(previewRoot, id, PREVIEW_CANDIDATE_FILE);
    const saved = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    delete saved.off_pattern;
    writeFileSync(path, JSON.stringify(saved), "utf-8");
    const candidate = readCandidate(previewRoot, id);
    expect(candidate).not.toBeNull();
    expect(candidate?.off_pattern).toBe(false);
  });
});

describe("下見の写しから選んだ記録を外す(D-V20-62)", () => {
  test("写しの manifest.json に choices が無く patterns が在る / 本物は1バイトも変わらない", async () => {
    await remember(
      { choice: { name: CHOICE_NAME_MARKER, tradeoff: "速いが狭い", reason: REASON_MARKER } },
      "d-choice",
    );
    await remember({ patterns: [PATTERN] }, "d-pattern");
    const realBefore = readFileSync(realManifestPath());
    const shadowRoot = shadowRootOf(
      await callTool("dry_run_diff", { app_id: APP_ID, diff: addFieldDiff(), preview: "real" }),
    );
    const shadowText = readFileSync(realManifestPath(shadowRoot), "utf-8");
    const shadow = JSON.parse(shadowText) as {
      app: { design_memory?: Record<string, unknown>; tables: unknown[] };
    };
    expect(shadow.app.design_memory).toEqual({ patterns: [PATTERN] });
    expect(shadowText).not.toContain(REASON_MARKER);
    expect(shadowText).not.toContain(CHOICE_NAME_MARKER);
    // 差分は当たっている(写しの他の部分は当てた後の姿のまま)。
    expect(JSON.stringify(shadow.app.tables)).toContain('"memo"');
    // 本物は不変(stale の材料も動かない)。
    expect(sha(readFileSync(realManifestPath()))).toBe(sha(realBefore));
    const real = JSON.parse(realBefore.toString("utf-8")) as {
      app: { design_memory: { choices: unknown[] } };
    };
    expect(real.app.design_memory.choices).toHaveLength(1);
  });

  test("選んだ記録しか無ければ、写しに design_memory のキーごと無い", async () => {
    await remember(
      { choice: { name: CHOICE_NAME_MARKER, tradeoff: "速いが狭い", reason: REASON_MARKER } },
      "d-choice",
    );
    const shadowRoot = shadowRootOf(
      await callTool("dry_run_diff", { app_id: APP_ID, diff: addFieldDiff(), preview: "sample" }),
    );
    const shadow = JSON.parse(readFileSync(realManifestPath(shadowRoot), "utf-8")) as {
      app: Record<string, unknown>;
    };
    expect("design_memory" in shadow.app).toBe(false);
  });

  test("写しの kernel.sqlite の変更履歴は対象のアプリで0行・置き場のどのファイルにも理由の目印が無い(snapshots/ も無い)", async () => {
    await remember(
      { choice: { name: CHOICE_NAME_MARKER, tradeoff: "速いが狭い", reason: REASON_MARKER } },
      "d-choice",
    );
    // 陽性対照: 本物の変更履歴には理由が在る(探し方が空振りしていない)。
    const realKernel = new Database(join(dataRoot, "kernel.sqlite"), { readonly: true });
    try {
      const rows = realKernel
        .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM "changelog" WHERE "app_id" = ?`)
        .get(APP_ID);
      expect(rows?.n ?? 0).toBeGreaterThan(0);
    } finally {
      realKernel.close();
    }
    for (const mode of ["real", "sample"] as const) {
      const result = await callTool("dry_run_diff", {
        app_id: APP_ID,
        diff: addFieldDiff(`d-${mode}`),
        preview: mode,
      });
      const shadowRoot = shadowRootOf(result);
      const kernel = new Database(join(shadowRoot, "kernel.sqlite"), { readonly: true });
      try {
        const rows = kernel
          .query<{ n: number }, [string]>(
            `SELECT COUNT(*) AS n FROM "changelog" WHERE "app_id" = ?`,
          )
          .get(APP_ID);
        expect(rows?.n).toBe(0);
      } finally {
        kernel.close();
      }
      expect(existsSync(join(shadowRoot, "apps", APP_ID, "snapshots"))).toBe(false);
      const dir = join(previewRoot, idOfPreview(result));
      const walk = (d: string): string[] =>
        readdirSync(d, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory()
            ? walk(join(d, e.name))
            : [readFileSync(join(d, e.name)).toString("latin1")],
        );
      const bytes = walk(dir).join("\n");
      expect(bytes).not.toContain(REASON_MARKER);
      expect(bytes).not.toContain(CHOICE_NAME_MARKER);
    }
  });

  test("陰性対照: design_memory を持たない / 型だけのアプリの写しの manifest.json は書き直さない(当てた直後のバイト列のまま)", async () => {
    // 当てた直後のマニフェストのバイト列は、同じ差分を本物の別の作業台に適用した結果と同じ書き方である。
    const plainShadow = shadowRootOf(
      await callTool("dry_run_diff", { app_id: APP_ID, diff: addFieldDiff(), preview: "real" }),
    );
    const plainText = readFileSync(realManifestPath(plainShadow), "utf-8");
    expect(plainText).not.toContain("design_memory");
    await remember({ patterns: [PATTERN] }, "d-pattern");
    const patternShadow = shadowRootOf(
      await callTool("dry_run_diff", {
        app_id: APP_ID,
        diff: addFieldDiff("d-3"),
        preview: "real",
      }),
    );
    const patternText = readFileSync(realManifestPath(patternShadow), "utf-8");
    // 本物に同じ差分を当てた結果のバイト列と一致する(写しを整える段で書き直していない)。
    okData(await callTool("apply_diff", { app_id: APP_ID, diff: addFieldDiff("d-3") }));
    expect(patternText).toBe(readFileSync(realManifestPath(), "utf-8"));
  });
});

describe("書き直した写しの定義が検証を通らなければ断る(黙って壊れた写しを見せない)", () => {
  test("choices を外すと検証を通らない写し(型が空配列)は理由を返す・理由に置き場のパスが無い / 陽性対照: 正しい写しは通る", async () => {
    await remember(
      { choice: { name: CHOICE_NAME_MARKER, tradeoff: "速いが狭い" }, patterns: [PATTERN] },
      "d-both",
    );
    // 本物の置き場を丸ごと使い捨ての写しへ複写し、写しの定義だけを壊す(本物には触れない)。
    const good = join(work, "shadow-good");
    const bad = join(work, "shadow-bad");
    cpSync(dataRoot, good, { recursive: true });
    cpSync(dataRoot, bad, { recursive: true });
    expect(stripDesignChoices(good, APP_ID)).toEqual({ ok: true });
    const goodManifest = JSON.parse(readFileSync(realManifestPath(good), "utf-8")) as {
      app: { design_memory?: unknown };
    };
    expect(goodManifest.app.design_memory).toEqual({ patterns: [PATTERN] });

    const broken = JSON.parse(readFileSync(realManifestPath(bad), "utf-8")) as {
      app: { design_memory: { patterns: string[] } };
    };
    broken.app.design_memory.patterns = [];
    writeFileSync(realManifestPath(bad), JSON.stringify(broken), "utf-8");
    const refused = stripDesignChoices(bad, APP_ID);
    expect(refused.ok).toBe(false);
    const reason = (refused as { reason: string }).reason;
    expect(reason).toContain("下見を作りませんでした");
    expect(reason).not.toContain(work);
  });
});

describe("型が AI に届く(get_manifest。計画 §9-5-1 の T02 (a) の製品側で撃てる部分)", () => {
  test("型の在るアプリの get_manifest に app.design_memory.patterns が在り、型の無いアプリには design_memory が無い", async () => {
    const before = okData(await callTool("get_manifest", { app_id: APP_ID })) as {
      manifest: { app: Record<string, unknown> };
    };
    expect("design_memory" in before.manifest.app).toBe(false);
    await remember({ patterns: [PATTERN] }, "d-pattern");
    const after = okData(await callTool("get_manifest", { app_id: APP_ID })) as {
      manifest: { app: { design_memory?: { patterns?: string[] } } };
    };
    expect(after.manifest.app.design_memory?.patterns).toEqual([PATTERN]);
  });
});

describe("道具の形", () => {
  test("compare の鍵は4本(off_pattern が足された)・道具の引数は4本・道具は26本・説明に型の文", async () => {
    const server = createMcpServer({ dataRoot, previewBaseUrl: PREVIEW_BASE_URL, previewRoot });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const { tools } = await client.listTools();
      // **【2026-10-02。`V23-M8-T05` / 授権 `ADR-0545` 行107】期待値を 26 → 27 へ書き換えた**(`list_record_history`)。
      // **旧行の逐語**: `expect(tools).toHaveLength(26);` **テスト名は書き換えていない。**
      expect(tools).toHaveLength(27);
      const dry = tools.find((t) => t.name === "dry_run_diff");
      const props = dry?.inputSchema.properties as Record<
        string,
        { properties?: Record<string, unknown> }
      >;
      expect(Object.keys(props).sort()).toEqual(["app_id", "compare", "diff", "preview"]);
      expect(Object.keys(props.compare?.properties ?? {}).sort()).toEqual([
        "group",
        "name",
        "off_pattern",
        "tradeoff",
      ]);
      const description = dry?.description ?? "";
      expect(description).toContain(
        "アプリに型(get_manifest の app.design_memory.patterns)があれば、それを既定として案を作ってください。",
      );
      expect(description).toContain(
        "型から外れる案には compare.off_pattern: true を付けると、見比べの画面に『このアプリの型と違う』と出ます。",
      );
      // 効能を約束しない・型の中身を置かない。
      for (const lie of ["必ず型に", "型に従います", "自動で型", PATTERN]) {
        expect(description, lie).not.toContain(lie);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
