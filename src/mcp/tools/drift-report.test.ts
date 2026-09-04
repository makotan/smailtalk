/**
 * 逸脱の蓄積の検出と昇格の提案(V3-M5-T04 / `D-G10a`。ADR-0056)。
 *
 * 完了条件の正は `docs/plan/v3/records/v3-m5.md` §2 の「V3-M5-T04」節(10点)、
 * 判定の正は `docs/adr/0007-vocabulary-governance.md` §8 の 2026-07-27 の行、
 * 審査記録は `docs/plan/v3/records/v3-m5-gate-a-drift.md`、実施記録は
 * `docs/plan/v3/records/v3-m5-t04.md`。
 *
 * ## このファイルが何を固定するのか
 *
 * | 完了条件 | ここで固定するもの |
 * |---|---|
 * | 1 | 「同趣旨」= **同じキーに同じ値**。数える対象の集合が**スキーマの `allOf` と一致する** |
 * | 2 | 提案だけ。ブロックしない。呼んでも1バイトも変わらない |
 * | 3 | 提案文が昇格の書き込み経路として `apply_diff` を名指しする |
 * | 4 | 閾値が**コード定数**である(マニフェストにも予約名テーブルにも無い) |
 * | 5 | 出口は MCP 応答である(`src/kernel/requirements-doc.ts` に1文字も触れていない) |
 * | 6 | **数が列挙から導ける** —— 群の件数 = その群に属する観測の件数 |
 * | 7 | 応答そのものが「逃げ道は数えていない」と述べる(手当て (a)) |
 * | 8 | テーマの数え方(テーマ全体で1件)と、その帰結(閾値に達し得ない) |
 *
 * ## 2層に分けて書く理由
 *
 * - **MCP 越し**(`tools/list` / `callTool`): LLM が実際に受け取る形を見る。
 *   `descriptions.test.ts` と同じ理由で、ソースを読むテストでは登録し忘れを検出できない。
 * - **純関数を直に呼ぶ**(`buildDriftReport`): **`readCurrentManifest` が `stored` 検証を
 *   通すため、「書けないはずのキーが書かれたマニフェスト」を MCP 越しには作れない。**
 *   数えない側の分岐(画面種別で落ちているキー / 知らないキー)を実際に通すには、
 *   マニフェストを手で組んで純関数に渡すしかない。**通らない分岐を「たぶん通る」で
 *   済ませない**ためにこの層を置く。
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { appManifestPath, createApp, KernelMetaStore, type Manifest } from "../../kernel/index.ts";
import { seedSession } from "../../server/test-helpers.ts";
import { SYSTEM_TABLE_IDS } from "../../shared/system-tables.ts";
import { createMcpServer } from "../server.ts";
import {
  DRIFT_COUNTED_PRESET_KEYS,
  DRIFT_ESCAPE_HATCH_NOT_COUNTED,
  DRIFT_NO_AUTO_PROMOTION,
  DRIFT_NOT_A_GATE,
  DRIFT_NOT_COUNTED_ESCAPE_HATCH,
  DRIFT_NOT_COUNTED_NO_TARGET,
  DRIFT_NOT_COUNTED_UNKNOWN_KEY,
  DRIFT_NOT_COUNTED_VIEW_TYPE,
  DRIFT_PROMOTION_PROPOSAL,
  DRIFT_PROMOTION_THRESHOLD,
  DRIFT_REFERENCE_DECLARATIONS_NOT_COUNTED,
  DRIFT_SAMENESS_RULE,
  DRIFT_THEME_COUNTING_RULE,
  DRIFT_THEME_LIMITATION,
  DRIFT_THEME_UNIT,
} from "../vocabulary.ts";
import { buildDriftReport, type DriftReport } from "./read.ts";

const APP_ID = "office";
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/**
 * **【`V8-M31` 第3波】MCP の名乗り。** `V8-M31` で MCP は「誰として動くか」を要求するように
 * なったので、`createMcpServer` に `actor` を渡し、**触る2つのアプリそれぞれに**同名の利用者を
 * 作る(1つでも欠けると「名乗った利用者は、このアプリに登録されていません。」になる)。
 * 本ファイルの検査はどれも権限の有無を測るものではないので、`seedSession` の既定(`owner`)でよい。
 */
const ACTOR = "mcp-actor";

/** テーマ対象スロット25件(`src/kernel/validate.test.ts` の合格テーマと同じ値)。 */
const THEME_SLOTS: Readonly<Record<string, string>> = {
  "--color-text": "#000000",
  "--color-text-secondary": "#595959",
  "--color-text-label": "#595959",
  "--color-text-placeholder": "#595959",
  "--color-danger": "#a00000",
  "--color-page-background": "#ffffff",
  "--color-surface-highlight": "#f2f2f2",
  "--color-border": "#767676",
  "--focus-outline-color": "#005fcc",
  "--font-family-base": "system-ui, sans-serif",
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
  "--focus-outline-width": "2px",
  "--detail-label-width": "8rem",
  "--login-max-width": "22rem",
};

/**
 * 蓄積のあるマニフェスト。
 *
 * - `preset_pager_position: "top"` が **3画面**(= 閾値ちょうど)
 * - `preset_column_align` の `"right"` が **2画面**(= 閾値未満。`list-a` は2列だが1件)
 * - `preset_label_placement: "stacked"` が **1画面**
 * - `form` が1画面(数える対象のキーを1つも持てない画面種別)
 */
function driftingManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "備品",
      tables: [
        {
          id: "items",
          name: "備品",
          fields: [
            { id: "title", name: "品名", type: "text", required: true },
            { id: "qty", name: "数量", type: "number" },
          ],
        },
      ],
      views: [
        {
          id: "list-a",
          type: "list_view",
          table: "items",
          columns: ["title", "qty"],
          preset_pager_position: "top",
          preset_column_align: { title: "right", qty: "right" },
        },
        {
          id: "list-b",
          type: "list_view",
          table: "items",
          columns: ["title"],
          preset_pager_position: "top",
          preset_column_align: { title: "right" },
        },
        {
          id: "list-c",
          type: "list_view",
          table: "items",
          columns: ["title"],
          preset_pager_position: "top",
        },
        {
          id: "list-d",
          type: "list_view",
          table: "items",
          columns: ["title"],
          preset_pager_position: "bottom",
        },
        {
          id: "detail-a",
          type: "detail_view",
          table: "items",
          preset_label_placement: "stacked",
        },
        { id: "form-a", type: "form", table: "items", fields: ["title"] },
      ],
      workflows: [],
      functions: [],
    },
  } as unknown as Manifest;
}

/** 調整が1つも無いマニフェスト(空の報告の形を見るため)。 */
function cleanManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "備品",
      tables: [
        {
          id: "items",
          name: "備品",
          fields: [{ id: "title", name: "品名", type: "text", required: true }],
        },
      ],
      views: [{ id: "list-a", type: "list_view", table: "items", columns: ["title"] }],
      workflows: [],
      functions: [],
    },
  } as unknown as Manifest;
}

let dataRoot = "";

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-mcp-drift-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "備品管理", { app_id: APP_ID });
    createApp(store, "経費申請", { app_id: "expense" });
  } finally {
    store.close();
  }
  // **アプリごとに1人ずつ**(`app.sqlite` が出来た後でなければ作れない)。
  seedSession(dataRoot, APP_ID, { username: ACTOR });
  seedSession(dataRoot, "expense", { username: ACTOR });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

/** マニフェストをそのまま置く(**検証済みの経路を通さずに**土台を作るための試験用)。 */
function putManifest(manifest: Manifest): void {
  writeFileSync(appManifestPath(dataRoot, APP_ID), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function connectInMemory(): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createMcpServer({
    dataRoot,
    previewBaseUrl: "http://127.0.0.1:3000",
    actor: ACTOR,
  });
  const client = new Client({ name: "drift-report-test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  const { client, close } = await connectInMemory();
  try {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } finally {
    await close();
  }
}

/** 成功結果から報告を取り出す。 */
function reportOf(result: CallToolResult): DriftReport {
  expect(result.isError).toBeFalsy();
  const structured = result.structuredContent as { drift_report?: DriftReport } | undefined;
  expect(structured?.drift_report).toBeDefined();
  return structured?.drift_report as DriftReport;
}

function readRepoFile(...parts: string[]): string {
  return readFileSync(join(REPO_ROOT, ...parts), "utf-8");
}

// ---------------------------------------------------------------------------
// 登録(参照系であること / 引数が app_id だけであること)
// ---------------------------------------------------------------------------

test("V3-M5-T04: report_drift が tools/list に出て、引数は app_id だけである", async () => {
  const { client, close } = await connectInMemory();
  try {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "report_drift");
    expect(tool).toBeDefined();
    // **閾値を引数にしない**(完了条件4)—— 引数にすると呼ぶ側が値を選べてしまい、
    // 「コード定数に固定する」が実質破れる。
    expect(Object.keys(tool?.inputSchema?.properties ?? {})).toEqual(["app_id"]);
  } finally {
    await close();
  }
});

test("V3-M5-T04: 実在しない app_id は統一形式で弾かれる", async () => {
  const result = await callTool("report_drift", { app_id: "nope" });
  expect(result.isError).toBe(true);
  const structured = result.structuredContent as { errors: { path: string }[] };
  expect(structured.errors[0]?.path).toBe("/app_id");
});

// ---------------------------------------------------------------------------
// 完了条件1: 「同趣旨」の判定規則と、数える対象の集合
// ---------------------------------------------------------------------------

test("V3-M5-T04 (条件1): 数える対象の表が schemas/manifest.schema.json の allOf と一致する", () => {
  // biome-ignore lint/suspicious/noExplicitAny: 正準スキーマの構造を動的に辿るため
  const schema = JSON.parse(readRepoFile("schemas", "manifest.schema.json")) as any;
  const viewSchema = schema.$defs.view;
  const presetKeys: string[] = Object.keys(viewSchema.properties).filter((key: string) =>
    key.startsWith("preset_"),
  );
  // 実測: `preset_` で始まるキーは7つ(ADR-0050 限定1)。
  // **【V4-M16-T13 / `P-G24` の (C) 側 / ADR-0093 限定1 で 7 → 8 に更新した】**
  // **8つ目の軸(一覧の器の形)は門A の本審査(`V4-M14` 本審査② の単位11。判定 = 限定採用 /
  // 審査記録 = `docs/plan/v4/records/v4-m14-gate-a-list-shape.md`)を通った増分である。**
  // **`list_view` でだけ書けるので、数える対象は `list_view` 5 → 6 になった。**
  // **【V4-M19-T05 / `P-G32` の (C) 側 / ADR-0118 限定1 で 8 → 9 に更新した】**
  // **9つ目の軸(画面の詰まり具合)は門A の本審査(V4-M19 単位C。2回目の審査。
  // 判定 = 限定採用)を通った増分である。****3種すべてに書けるので、数える対象は
  // `list_view` 6 → 7 / `detail_view` 4 → 5 / `form` 2 → 3 になった。**本 ADR の増分ではない。**
  expect(presetKeys).toHaveLength(9);

  // **画面種別の正はスキーマの `$defs/view_type` である。** 表がこの3種を尽くしていない
  // (= 画面種別が増えたのに表が追随していない)なら、ここで赤くなる。
  const viewTypes: string[] = schema.$defs.view_type.enum;
  expect(Object.keys(DRIFT_COUNTED_PRESET_KEYS).sort()).toEqual([...viewTypes].sort());

  for (const viewType of viewTypes as ("list_view" | "form" | "detail_view")[]) {
    // その画面種別の分岐が `false` に落としているキー = 書けないキー。
    const branch = viewSchema.allOf.find(
      // biome-ignore lint/suspicious/noExplicitAny: 同上
      (entry: any) => entry.if?.properties?.type?.const === viewType,
    );
    const falsified = Object.entries(branch?.then?.properties ?? {})
      .filter(([key, value]) => key.startsWith("preset_") && value === false)
      .map(([key]) => key);
    const writable = presetKeys.filter((key) => !falsified.includes(key)).sort();
    // **落ちている画面種別で数えない**(完了条件1)。
    expect([...DRIFT_COUNTED_PRESET_KEYS[viewType]].sort(), viewType).toEqual(writable);
  }

  // 実測の内訳を数でも固定する(表がどちらかに寄ったら赤くなる)。
  // **【V4-M16-T11 / P-G29 / ADR-0091 限定3】`form` は着手前 0 だった。**
  // **`ADR-0091`(門A / 判定 = 限定採用)が form 分岐の `false` を2つ外したので 2 になる。**
  // **正はスキーマの `allOf` であり、上のループが両方向で突き合わせている** ——
  // **この数字だけを書き換えても、スキーマが動いていなければ上のループが赤くなる。**
  // **【V4-M16-T13 / ADR-0093 限定2】`list_view` は着手前 5 だった。**
  // **`ADR-0093` が8つ目の軸を `list_view` にだけ通したので 6 になる。**
  // **`form` / `detail_view` の数は1つも動いていない**(どちらも本キーは `false`)。
  // **【V4-M19-T05 / ADR-0118 限定1】9つ目の軸(画面の詰まり具合)は3種すべてに書けるので、
  // `list_view` は 6 → 7、`detail_view` は 4 → 5、`form` は 2 → 3 になった。**
  // **本 ADR の増分ではない。**
  expect(DRIFT_COUNTED_PRESET_KEYS.list_view).toHaveLength(7);
  expect(DRIFT_COUNTED_PRESET_KEYS.detail_view).toHaveLength(5);
  expect(DRIFT_COUNTED_PRESET_KEYS.form).toHaveLength(3);
  expect([...DRIFT_COUNTED_PRESET_KEYS.form].sort()).toEqual([
    "preset_density",
    "preset_field_columns",
    "preset_label_placement",
  ]);
});

test("V3-M5-T04 (条件1): 同趣旨は「同じキーに同じ値」であり、1画面の同じキーは何列書かれても1件", () => {
  const report = buildDriftReport(APP_ID, driftingManifest());

  const align = report.observations.filter((o) => o.unit === "preset_column_align");
  // list-a は2列とも "right" だが**1件**。list-b は1列で1件。合計2件。
  expect(align.map((o) => o.view_id)).toEqual(["list-a", "list-b"]);
  expect(align[0]?.value).toBe("right");
  // 列ごとの指定は列挙して見せる(数は1でも、根拠は消さない)。
  expect(align[0]?.fields).toEqual(["qty", "title"]);
  expect(align[1]?.fields).toEqual(["title"]);

  const group = report.groups.find((g) => g.unit === "preset_column_align" && g.value === "right");
  expect(group?.count).toBe(2);
  expect(group?.view_ids).toEqual(["list-a", "list-b"]);
  expect(group?.reached_threshold).toBe(false);
});

test("V3-M5-T04 (条件1): 判定規則そのものが応答に載る(規則が読み手に見えないと判定が割れる)", async () => {
  putManifest(driftingManifest());
  const report = reportOf(await callTool("report_drift", { app_id: APP_ID }));
  expect(report.counting_rule).toBe(DRIFT_SAMENESS_RULE);
  expect(report.theme_counting_rule).toBe(DRIFT_THEME_COUNTING_RULE);
  // 数える対象の集合も応答に載せる(何を数えなかったかが読み手に分かる)。
  expect(report.counted_scope.list_view).toEqual([...DRIFT_COUNTED_PRESET_KEYS.list_view]);
  // **【V4-M16-T11 / ADR-0091 限定3】着手前は `toEqual([])` だった。**
  expect(report.counted_scope.form).toEqual([...DRIFT_COUNTED_PRESET_KEYS.form]);
  expect(report.counted_scope.theme).toBe(DRIFT_THEME_UNIT);
});

test("V3-M5-T04 (条件1): 画面種別で落ちているキーは、書かれていても数えず、理由を書く", () => {
  const manifest = driftingManifest();
  // **detail_view には書けないキー**(スキーマの allOf が false に落としている)。
  // `readCurrentManifest` の `stored` 検証は通らないので、純関数に直接渡して分岐を通す。
  // biome-ignore lint/suspicious/noExplicitAny: 検証を通らない形を意図的に作るため
  (manifest.app.views[4] as any).preset_pager_position = "top";
  const report = buildDriftReport(APP_ID, manifest);

  // 数えていない: "top" は list-a/b/c の3件のままである(4件になっていない)。
  const top = report.groups.find((g) => g.unit === "preset_pager_position" && g.value === "top");
  expect(top?.count).toBe(3);
  expect(top?.view_ids).toEqual(["list-a", "list-b", "list-c"]);

  const skipped = report.not_counted.find(
    (n) => n.view_id === "detail-a" && n.unit === "preset_pager_position",
  );
  expect(skipped?.reason).toBe(DRIFT_NOT_COUNTED_VIEW_TYPE);
});

test("V3-M5-T04 (条件1): 表に無い preset_ キーは数えず、「列挙できない」と書く", () => {
  const manifest = driftingManifest();
  // biome-ignore lint/suspicious/noExplicitAny: 8つ目のキーが生えた将来を模す
  (manifest.app.views[0] as any).preset_row_border = "thin";
  const report = buildDriftReport(APP_ID, manifest);

  const unknown = report.not_counted.find((n) => n.unit === "preset_row_border");
  expect(unknown?.reason).toBe(DRIFT_NOT_COUNTED_UNKNOWN_KEY);
  expect(unknown?.reason).toContain("列挙できない");
  // 数えていない = 観測にも群にも現れない。
  expect(report.observations.some((o) => o.unit === "preset_row_border")).toBe(false);
  expect(report.groups.some((g) => g.unit === "preset_row_border")).toBe(false);
});

/**
 * **【`V4-M16-T11` / `P-G29` / `ADR-0091` 限定3 で書き換えた】**
 *
 * **着手前の本テストは題「form は数える対象のキーを1つも持たないことを、画面ごとに書く」で、
 * `form-a` の `not_counted` の理由が `DRIFT_NOT_COUNTED_NO_TARGET` であることを見ていた。**
 * **`ADR-0091` が form に2軸を通したので、form は数える対象を2つ持つ。**
 *
 * **見る先を「form でも数える / form でも落ちているキーは数えない」の両方に置き換えた** ——
 * **「書けない」ことと「書かれていない」ことを同じ0に混ぜない、という完了条件1 の趣旨は
 * 1バイトも変えていない。**
 *
 * **`DRIFT_NOT_COUNTED_NO_TARGET` は今日どの画面種別にも当たらない**(3種とも数える対象を
 * 1つ以上持つ)。**定数も分岐も消していない** —— 将来また0になる画面種別が生えたときに
 * 黙って混ざるのを防ぐためである。
 */
test("V4-M16-T11 (条件1): form でも2軸は数え、form で落ちているキーは今日どおり数えない", () => {
  const manifest = driftingManifest();
  // form に通った軸(`ADR-0091`)。**数える。**
  // biome-ignore lint/suspicious/noExplicitAny: フィクスチャを直に触るため
  (manifest.app.views[5] as any).preset_label_placement = "stacked";
  // form で今日も `false` に落ちている軸。**書かれていても数えない。**
  // biome-ignore lint/suspicious/noExplicitAny: 検証を通らない形を意図的に作るため
  (manifest.app.views[5] as any).preset_pager_position = "top";
  const report = buildDriftReport(APP_ID, manifest);

  // 数えた: `detail-a` の "stacked" と合わせて2件になっている。
  const stacked = report.groups.find(
    (g) => g.unit === "preset_label_placement" && g.value === "stacked",
  );
  expect(stacked?.count).toBe(2);
  expect(stacked?.view_ids).toEqual(["detail-a", "form-a"]);

  // 数えなかった: 落ちているキーは理由つきで挙がる。
  const skipped = report.not_counted.find(
    (n) => n.view_id === "form-a" && n.unit === "preset_pager_position",
  );
  expect(skipped?.reason).toBe(DRIFT_NOT_COUNTED_VIEW_TYPE);
  expect(skipped?.view_type).toBe("form");

  // **「数える対象を1つも持たない」理由は、今日どの画面にも付かない。**
  expect(report.not_counted.some((n) => n.reason === DRIFT_NOT_COUNTED_NO_TARGET)).toBe(false);
});

// ---------------------------------------------------------------------------
// 完了条件6: 数だけ出さない(数が列挙から導ける)
// ---------------------------------------------------------------------------

test("V3-M5-T04 (条件6): すべての群の件数が、観測の列挙から機械的に導ける", async () => {
  putManifest(driftingManifest());
  const report = reportOf(await callTool("report_drift", { app_id: APP_ID }));

  expect(report.groups.length).toBeGreaterThan(0);
  for (const group of report.groups) {
    const matching = report.observations.filter(
      (o) => o.unit === group.unit && o.value === group.value,
    );
    // **これが「3件に達した」とだけ返す形を採っていないことの担保である。**
    expect(matching.length, `${group.unit}=${group.value}`).toBe(group.count);
    expect(
      matching.map((o) => o.view_id).filter((id): id is string => id !== null),
      `${group.unit}=${group.value}`,
    ).toEqual(group.view_ids);
  }
  // 逆向き: 観測はすべてどれかの群に属する(数えたのに列挙から漏れる群が無い)。
  for (const observation of report.observations) {
    expect(
      report.groups.some((g) => g.unit === observation.unit && g.value === observation.value),
      `${observation.unit}=${observation.value}`,
    ).toBe(true);
  }
});

test("V3-M5-T04 (条件6): 提案も件数だけでなく、どの画面かを全件挙げる", async () => {
  putManifest(driftingManifest());
  const report = reportOf(await callTool("report_drift", { app_id: APP_ID }));

  expect(report.proposals).toHaveLength(1);
  const proposal = report.proposals[0];
  expect(proposal?.unit).toBe("preset_pager_position");
  expect(proposal?.value).toBe("top");
  expect(proposal?.count).toBe(DRIFT_PROMOTION_THRESHOLD);
  expect(proposal?.view_ids).toEqual(["list-a", "list-b", "list-c"]);
  expect(proposal?.view_ids).toHaveLength(proposal?.count ?? -1);
});

test("V3-M5-T04 (条件6): 閾値に1件足りない群は提案に出ない(境界)", () => {
  const manifest = driftingManifest();
  // list-c を "bottom" に倒すと "top" は2件になる。
  // biome-ignore lint/suspicious/noExplicitAny: 試験用の書き換え
  (manifest.app.views[2] as any).preset_pager_position = "bottom";
  const report = buildDriftReport(APP_ID, manifest);

  expect(report.proposals).toEqual([]);
  const top = report.groups.find((g) => g.unit === "preset_pager_position" && g.value === "top");
  expect(top?.count).toBe(DRIFT_PROMOTION_THRESHOLD - 1);
  expect(top?.reached_threshold).toBe(false);
  // **群そのものは消えない** —— 閾値未満でも列挙は残る(数の根拠を隠さない)。
  expect(report.observations.length).toBeGreaterThan(0);
});

test("V3-M5-T04 (条件6): 調整が1件も無いアプリでも、規則と限界は必ず返る", async () => {
  putManifest(cleanManifest());
  const report = reportOf(await callTool("report_drift", { app_id: APP_ID }));

  expect(report.observations).toEqual([]);
  expect(report.groups).toEqual([]);
  expect(report.proposals).toEqual([]);
  expect(report.counting_rule).toBe(DRIFT_SAMENESS_RULE);
  expect(report.limitations).toContain(DRIFT_ESCAPE_HATCH_NOT_COUNTED);
});

// ---------------------------------------------------------------------------
// 完了条件2 / 3: 提案するだけ。ブロックしない。書き込みは apply_diff
// ---------------------------------------------------------------------------

test("V3-M5-T04 (条件2): 呼んでもマニフェストを1バイトも変えない", async () => {
  putManifest(driftingManifest());
  const before = readFileSync(appManifestPath(dataRoot, APP_ID), "utf-8");
  await callTool("report_drift", { app_id: APP_ID });
  await callTool("report_drift", { app_id: APP_ID });
  expect(readFileSync(appManifestPath(dataRoot, APP_ID), "utf-8")).toBe(before);
});

test("V3-M5-T04 (条件2): 応答が「提案だけでブロックしない・自動で書き換えない」と述べる", async () => {
  putManifest(driftingManifest());
  const report = reportOf(await callTool("report_drift", { app_id: APP_ID }));
  expect(report.limitations).toContain(DRIFT_NO_AUTO_PROMOTION);
  expect(DRIFT_NO_AUTO_PROMOTION).toContain("ブロック");
  expect(DRIFT_NO_AUTO_PROMOTION).toContain("自動");
  // ADR-0051 §3a 4 / D-M5-4: 件数を合否の閾値に流用しない。
  expect(report.limitations).toContain(DRIFT_NOT_A_GATE);
});

test("V3-M5-T04 (条件3): 提案文が昇格の書き込み経路として apply_diff を名指しする", async () => {
  putManifest(driftingManifest());
  const report = reportOf(await callTool("report_drift", { app_id: APP_ID }));
  expect(report.proposals[0]?.proposal).toBe(DRIFT_PROMOTION_PROPOSAL);
  expect(DRIFT_PROMOTION_PROPOSAL).toContain("apply_diff");
  // **人間の承認後**である(D-7)。
  expect(DRIFT_PROMOTION_PROPOSAL).toContain("人間");
});

// ---------------------------------------------------------------------------
// 完了条件4: 閾値はコード定数
// ---------------------------------------------------------------------------

test("V3-M5-T04 (条件4): 閾値は 3 のコード定数であり、応答はその定数を返す", async () => {
  expect(DRIFT_PROMOTION_THRESHOLD).toBe(3);
  putManifest(driftingManifest());
  const report = reportOf(await callTool("report_drift", { app_id: APP_ID }));
  expect(report.threshold).toBe(DRIFT_PROMOTION_THRESHOLD);
});

test("V3-M5-T04 (条件4): 閾値がマニフェストにも予約名テーブルにも置かれていない(Δ3 / Δ2 の不発火)", () => {
  const schema = readRepoFile("schemas", "manifest.schema.json");
  // マニフェストに閾値を置く口が1つも無い(置けば Δ3 が発火し、門外の根拠が消える)。
  for (const word of ["threshold", "drift", "promotion"]) {
    expect(schema.toLowerCase(), word).not.toContain(word);
  }
  // 予約名テーブル(システムテーブル)は3つのままである(置けば Δ2 が発火する)。
  expect(SYSTEM_TABLE_IDS).toHaveLength(3);
  expect(SYSTEM_TABLE_IDS.some((id) => id.includes("drift"))).toBe(false);
});

// ---------------------------------------------------------------------------
// 完了条件5: 出口は MCP 応答であり、要件ドキュメントではない
// ---------------------------------------------------------------------------

test("V3-M5-T04 (条件5): 要件ドキュメント生成器は逸脱の検出に1文字も関与しない", () => {
  const source = readRepoFile("src", "kernel", "requirements-doc.ts");
  for (const identifier of [
    "buildDriftReport",
    "DRIFT_PROMOTION_THRESHOLD",
    "report_drift",
    "drift_report",
  ]) {
    expect(source, identifier).not.toContain(identifier);
  }
});

test("V3-M5-T04 (条件5): generate_requirements_doc の出力に提案が1文も現れない", async () => {
  putManifest(driftingManifest());
  const result = await callTool("generate_requirements_doc", { app_id: APP_ID });
  const structured = result.structuredContent as {
    requirements_doc?: { markdown?: string };
  };
  const markdown = structured.requirements_doc?.markdown ?? "";
  expect(markdown.length).toBeGreaterThan(0);
  expect(markdown).not.toContain(DRIFT_PROMOTION_PROPOSAL);
  expect(markdown).not.toContain(DRIFT_ESCAPE_HATCH_NOT_COUNTED);
});

// ---------------------------------------------------------------------------
// 完了条件7: `D-G10b` が未達であることの併記(手当て (a))
// ---------------------------------------------------------------------------

test("V3-M5-T04 (条件7a): 応答そのものが「逃げ道は数えていない」と明記する", async () => {
  putManifest(driftingManifest());
  const report = reportOf(await callTool("report_drift", { app_id: APP_ID }));
  expect(report.limitations).toContain(DRIFT_ESCAPE_HATCH_NOT_COUNTED);
  // 逐語(04 §8-4 の手当て (a) / ADR-0056 §5)。
  expect(DRIFT_ESCAPE_HATCH_NOT_COUNTED).toBe(
    "これはマニフェストに載る調整だけを数えている。逃げ道は数えていない。",
  );
});

test("V3-M5-T04 (条件7a): ツールの説明文も「逃げ道は数えていない」と述べる", async () => {
  const { client, close } = await connectInMemory();
  try {
    const { tools } = await client.listTools();
    const description = tools.find((t) => t.name === "report_drift")?.description ?? "";
    expect(description).toContain(DRIFT_ESCAPE_HATCH_NOT_COUNTED);
  } finally {
    await close();
  }
});

test("V3-M5-T04 (条件7a): 逃げ道が当たっている画面は「数えていない」側に全件挙がる", () => {
  const manifest = driftingManifest();
  const reference = { asset: "brand", digest: "a".repeat(64) };
  // biome-ignore lint/suspicious/noExplicitAny: 逃げ道の参照(V3-M5-T02 の18キー目)
  (manifest.app.views[0] as any).custom_css = reference;
  // biome-ignore lint/suspicious/noExplicitAny: 同上
  (manifest.app.views[5] as any).custom_css = reference;
  const report = buildDriftReport(APP_ID, manifest);

  const hatches = report.not_counted.filter((n) => n.reason === DRIFT_NOT_COUNTED_ESCAPE_HATCH);
  expect(hatches.map((n) => n.view_id)).toEqual(["list-a", "form-a"]);
  // **数には1件も入っていない。**
  expect(report.observations.some((o) => o.unit === "custom_css")).toBe(false);
  expect(report.groups.some((g) => g.unit === "custom_css")).toBe(false);
  expect(DRIFT_NOT_COUNTED_ESCAPE_HATCH).toContain("D-G10b");
});

// ---------------------------------------------------------------------------
// 完了条件8: テーマの数え方
// ---------------------------------------------------------------------------

test("V3-M5-T04 (条件8): テーマはテーマ全体で1件と数える(スロット単位で25件にしない)", () => {
  const manifest = driftingManifest();
  // biome-ignore lint/suspicious/noExplicitAny: テーマ付きの土台を作る
  (manifest.app as any).theme = { slots: { ...THEME_SLOTS } };
  const report = buildDriftReport(APP_ID, manifest);

  const themeObservations = report.observations.filter((o) => o.unit === DRIFT_THEME_UNIT);
  expect(themeObservations).toHaveLength(1);
  // **25件立てない**(ADR-0047 限定3 により set_theme は25スロット全部を書き直すので、
  // スロット単位で数えると「余白だけ1段」の1回が25件になる)。
  expect(Object.keys(themeObservations[0]?.slots ?? {})).toHaveLength(25);
  // スロット名を単位にした観測は1件も無い。
  expect(report.observations.some((o) => o.unit.startsWith("--"))).toBe(false);

  const group = report.groups.find((g) => g.unit === DRIFT_THEME_UNIT);
  expect(group?.count).toBe(1);
  expect(group?.reached_threshold).toBe(false);
});

test("V3-M5-T04 (条件8): テーマ側が閾値に達し得ないことを、応答が自分で述べる", async () => {
  const manifest = driftingManifest();
  // biome-ignore lint/suspicious/noExplicitAny: テーマ付きの土台を作る
  (manifest.app as any).theme = { slots: { ...THEME_SLOTS } };
  putManifest(manifest);
  const report = reportOf(await callTool("report_drift", { app_id: APP_ID }));

  expect(report.limitations).toContain(DRIFT_THEME_LIMITATION);
  expect(DRIFT_THEME_LIMITATION).toContain("閾値");
  // 提案はプリセット側の1件だけ(テーマは1件も提案に出ない)。
  expect(report.proposals.every((p) => p.unit !== DRIFT_THEME_UNIT)).toBe(true);
});

test("V3-M5-T04 (条件8): テーマが無いアプリではテーマの観測が0件になる", () => {
  const report = buildDriftReport(APP_ID, driftingManifest());
  expect(report.observations.some((o) => o.unit === DRIFT_THEME_UNIT)).toBe(false);
  expect(report.groups.some((g) => g.unit === DRIFT_THEME_UNIT)).toBe(false);
});

// ---------------------------------------------------------------------------
// `V6-M6-T01`(`K-G21a`): 参照項目の選び方・探せる項目を1件も数えていないことの明記
// ---------------------------------------------------------------------------
//
// **`v6-m0.md` §7-11 の `K-G21a` の歯止め1 は、変更予定として「`buildDriftReport` が
// 数える対象の表に足す」と書いている。** **本タスクは表に1語も足していない。**
// **足せないことをここで実測として固定する** —— 上の
// 「数える対象の表が `schemas/manifest.schema.json` の allOf と一致する」が
// **`preset_` で始まるキーだけ**を集めて両方向に突き合わせているためである。
// **「出す」は「数える」ではなく「数えていないと名指しで書く」で履行した。**
// 判断の全文は `src/mcp/vocabulary.ts` の
// `DRIFT_REFERENCE_DECLARATIONS_NOT_COUNTED` の doc コメントと
// `docs/plan/v6/records/v6-m6.md` §1-2 にある。

test("V6-M6-T01: 参照の3宣言は数える対象の表に1語も入っていない", () => {
  const counted = new Set(Object.values(DRIFT_COUNTED_PRESET_KEYS).flatMap((keys) => [...keys]));
  for (const key of ["reference_picker", "reference_pickers", "reference_search_fields"]) {
    expect(`${key}:${String(counted.has(key))}`).toBe(`${key}:false`);
  }
  // **数える対象は今日も全部 `preset_` で始まる**(表の性質そのもの)。
  for (const key of counted) {
    expect(`${key}:${String(key.startsWith("preset_"))}`).toBe(`${key}:true`);
  }
});

test("V6-M6-T01: 応答の limitations が「参照の3宣言を数えていない」ことを名指しで述べる", () => {
  const report = buildDriftReport(APP_ID, driftingManifest());
  expect(report.limitations).toContain(DRIFT_REFERENCE_DECLARATIONS_NOT_COUNTED);
  // **3つの名前を1つ残らず名指ししていること**(件数に丸めない)。
  for (const key of ["reference_picker", "reference_pickers", "reference_search_fields"]) {
    expect(DRIFT_REFERENCE_DECLARATIONS_NOT_COUNTED).toContain(key);
  }
  // **黙って落としていない**ことを、`not_counted` の側でも確かめる ——
  // **今日ここには1件も現れない**(`preset_` で始まらないキーは走査の対象にすら入らない)。
  // **その事実を隠さない**: 名指しの経路は `limitations` の1本だけである。
  expect(report.not_counted.filter((entry) => entry.unit?.startsWith("reference"))).toHaveLength(0);
});

test("V6-M6-T01: 選び方を何画面に書いても groups に1件も現れない(実測)", () => {
  const manifest = driftingManifest() as unknown as {
    app: { views: Record<string, unknown>[] };
  };
  // **同じ選び方を3画面に書く**(閾値 3 に達する形)。それでも1件も数えない。
  for (const view of manifest.app.views.slice(0, 3)) {
    view.reference_pickers = { partner: "search" };
  }
  const report = buildDriftReport(APP_ID, manifest as never);
  expect(report.groups.filter((group) => group.unit.startsWith("reference"))).toHaveLength(0);
  expect(report.observations.filter((o) => o.unit.startsWith("reference"))).toHaveLength(0);
  expect(report.proposals.filter((p) => p.unit.startsWith("reference"))).toHaveLength(0);
});
