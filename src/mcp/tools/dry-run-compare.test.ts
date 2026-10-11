/**
 * **`dry_run_diff` の `compare`(束ねた下見)**(`V20-M14-T01A`。計画 `docs/plan/v20/16-v20-m14-plan.md`
 * §9-1・§10-2 / `ADR-0478` §Decision 1-1〜1-3・2-8)。
 *
 * 固定するもの:
 * - `preview` 無しの `compare` と形の誤り(名前 1〜40字・トレードオフ 1〜80字・改行なし・コードポイントで
 *   数える・`group` は `pv-<16進32桁>`)は**引数の誤り**(`ADR-0003` §3 の形)で、置き場を1つも作らない。
 * - 最初の案で束が1つでき、応答に `compare: { url, group, count }` が足される(`preview` の欄は今日どおり)。
 *   2・3案目は束に並び、**4案目は「見比べは3案まで」**で下見を作らない。
 * - 拒否される差分は今日どおりの errors で、束に入らない(`D-V20-39`)。
 * - データが失われる op を含む差分は束に入らない(`D-V20-52`)。 `compare` 無しなら今日どおり下見を作る。
 * - 別のアプリ・別の人・別の mode・期限切れ・無い束は断られる(下見を作らない)。
 * - 案ごとに `candidate.json`(名前・トレードオフ・差分そのもの・注意・作成時の本物のマニフェストの sha・束)。
 * - `compare` を付けない呼び出しは着手前と同じ(束も案も作らない)。 道具は26本のまま。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ValidationError } from "../../kernel/index.ts";
import {
  findGroup,
  PREVIEW_CANDIDATE_FILE,
  PREVIEW_GROUP_FILE,
  parsePreviewAppId,
  readCandidate,
} from "../../server/preview-store.ts";
import { seedSession } from "../../server/test-helpers.ts";
import { createMcpServer } from "../server.ts";

const APP_ID = "workshop";
const OTHER_APP_ID = "atelier";
const TABLE_ID = "notes";
const PREVIEW_BASE_URL = "http://127.0.0.1:3000";
const BOOTSTRAP_ACTOR = "bootstrap";

let work = "";
let dataRoot = "";
let previewRoot = "";
let alice: ReturnType<typeof seedSession>;

async function callTool(
  name: string,
  args: Record<string, unknown>,
  actor?: string,
): Promise<CallToolResult> {
  const server = createMcpServer(
    actor === undefined
      ? { dataRoot, previewBaseUrl: PREVIEW_BASE_URL, previewRoot }
      : { dataRoot, previewBaseUrl: PREVIEW_BASE_URL, previewRoot, actor },
  );
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

function diff(diffId = "d-compare", fieldId = "memo"): Record<string, unknown> {
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

type CompareField = { url: string; group: string; count: number };

async function propose(
  args: { name?: string; tradeoff?: string; group?: string; mode?: "real" | "sample" },
  actor = alice.username,
  appId = APP_ID,
  body: Record<string, unknown> = diff(),
): Promise<CallToolResult> {
  const compare: Record<string, unknown> = {
    name: args.name ?? "案A",
    tradeoff: args.tradeoff ?? "入力は速いが一覧が長くなる",
  };
  if (args.group !== undefined) compare.group = args.group;
  return callTool(
    "dry_run_diff",
    { app_id: appId, diff: body, preview: args.mode ?? "real", compare },
    actor,
  );
}

function manifestSha(appId = APP_ID): string {
  return createHash("sha256")
    .update(readFileSync(join(dataRoot, "apps", appId, "manifest.json")))
    .digest("hex");
}

function idOfUrl(url: string): string {
  const appId = /\/apps\/(pv-[0-9a-f]{32})\/$/.exec(url)?.[1] ?? "";
  return parsePreviewAppId(appId) ?? "";
}

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "gp-mcp-dry-run-compare-"));
  dataRoot = join(work, "data");
  previewRoot = join(work, "previews");
  for (const [appId, name] of [
    [APP_ID, "作業場"],
    [OTHER_APP_ID, "工房"],
  ] as const) {
    okData(await callTool("create_app", { name, app_id: appId }, BOOTSTRAP_ACTOR));
  }
  alice = seedSession(dataRoot, APP_ID, { username: "alice" });
  seedSession(dataRoot, OTHER_APP_ID, { username: "alice" });
  seedSession(dataRoot, APP_ID, { username: "carol" });
  for (const appId of [APP_ID, OTHER_APP_ID]) {
    okData(
      await callTool(
        "apply_diff",
        {
          app_id: appId,
          diff: {
            diff_id: "setup-table",
            intent: "メモの表を用意する",
            operations: [
              {
                op: "add_table",
                table: {
                  id: TABLE_ID,
                  name: "メモ",
                  fields: [
                    { id: "title", name: "題", type: "text", required: true },
                    { id: "old", name: "古い欄", type: "text" },
                  ],
                },
              },
            ],
          },
        },
        alice.username,
      ),
    );
  }
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

describe("引数の誤り(ADR-0003 §3 の形。置き場を1つも作らない)", () => {
  test("preview 無しの compare は引数の誤り", async () => {
    const result = await callTool(
      "dry_run_diff",
      { app_id: APP_ID, diff: diff(), compare: { name: "案A", tradeoff: "速い" } },
      alice.username,
    );
    const errors = errorsOf(result);
    expect(errors[0]?.path).toBe("/compare");
    expect(errors[0]?.message).toContain("preview");
    expect(entries()).toEqual([]);
  });

  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["name が無い", { tradeoff: "速い" }, "/compare/name"],
    ["name が空", { name: "", tradeoff: "速い" }, "/compare/name"],
    ["name が41字", { name: "あ".repeat(41), tradeoff: "速い" }, "/compare/name"],
    ["name に改行", { name: "案\nA", tradeoff: "速い" }, "/compare/name"],
    ["tradeoff が無い", { name: "案A" }, "/compare/tradeoff"],
    ["tradeoff が空", { name: "案A", tradeoff: "" }, "/compare/tradeoff"],
    ["tradeoff が81字", { name: "案A", tradeoff: "い".repeat(81) }, "/compare/tradeoff"],
    ["tradeoff に CR", { name: "案A", tradeoff: "速い\r遅い" }, "/compare/tradeoff"],
    [
      "group の綴りが違う(pv- 無し)",
      { name: "案A", tradeoff: "速い", group: "0".repeat(32) },
      "/compare/group",
    ],
    [
      "group の綴りが違う(大文字)",
      { name: "案A", tradeoff: "速い", group: `pv-${"A".repeat(32)}` },
      "/compare/group",
    ],
    [
      "group の綴りが違う(31桁)",
      { name: "案A", tradeoff: "速い", group: `pv-${"a".repeat(31)}` },
      "/compare/group",
    ],
  ];
  for (const [label, compare, path] of cases) {
    test(`形の誤り: ${label} → ${path}`, async () => {
      const result = await callTool(
        "dry_run_diff",
        { app_id: APP_ID, diff: diff(), preview: "real", compare },
        alice.username,
      );
      expect(errorsOf(result).map((e) => e.path)).toContain(path);
      expect(entries()).toEqual([]);
    });
  }

  test("境界: name 40字・tradeoff 80字はコードポイントで数えて通る(サロゲートの対も1字)", async () => {
    const name = "𠮷".repeat(40);
    const tradeoff = "𩸽".repeat(80);
    expect(name.length).toBe(80); // UTF-16 の単位では 80(コードポイントでは 40)。
    const data = okData(await propose({ name, tradeoff }));
    const compare = data.compare as CompareField;
    expect(compare.count).toBe(1);
  });
});

describe("束に並ぶ(1〜3案)と4案目の断り", () => {
  test("最初の案で束ができ、応答に compare { url, group, count } が足される(preview とレポートは今日どおり)", async () => {
    const plain = okData(
      await callTool("dry_run_diff", { app_id: APP_ID, diff: diff() }, alice.username),
    );
    const data = okData(await propose({}));
    expect(Object.keys(data).sort()).toEqual(["compare", "preview", "report"]);
    expect(data.report).toEqual(plain.report);
    const preview = data.preview as { url: string; expires_at: string; mode: string };
    expect(Object.keys(preview).sort()).toEqual(["expires_at", "mode", "url"]);
    const compare = data.compare as CompareField;
    expect(Object.keys(compare).sort()).toEqual(["count", "group", "url"]);
    expect(compare.count).toBe(1);
    expect(compare.group).toMatch(/^pv-[0-9a-f]{32}$/);
    expect(compare.url).toBe(`${PREVIEW_BASE_URL}/apps/${compare.group}/`);
    expect(compare.url).not.toBe(preview.url);

    const groupId = parsePreviewAppId(compare.group) ?? "";
    const candidateId = idOfUrl(preview.url);
    const group = findGroup(previewRoot, groupId);
    expect(group?.candidates).toEqual([candidateId]);
    expect(group?.app_id).toBe(APP_ID);
    expect(group?.requester_user_id).toBe(alice.userId);
    expect(group?.mode).toBe("real");
    expect(group?.expires_at).toBe(preview.expires_at);
    expect(entries()).toEqual([candidateId, groupId].sort());

    const candidate = readCandidate(previewRoot, candidateId);
    expect(candidate).toEqual({
      name: "案A",
      tradeoff: "入力は速いが一覧が長くなる",
      diff: diff(),
      design_notices: (data.report as { design_notices: unknown[] }).design_notices,
      base_manifest_sha: manifestSha(),
      group: groupId,
      // 【`V20-M15-T01B` / `ADR-0479` §Decision 4-4】票に off_pattern(付けなければ false)。 旧は group までの6キー。
      off_pattern: false,
    });
  });

  test("2・3案目は同じ束に作った順に並び、4案目は「見比べは3案まで」で下見を作らない", async () => {
    const first = okData(await propose({ name: "案1" }));
    const group = (first.compare as CompareField).group;
    const ids = [idOfUrl((first.preview as { url: string }).url)];
    for (const [i, name] of ["案2", "案3"].entries()) {
      const data = okData(await propose({ name, group }, alice.username, APP_ID, diff(`d-${i}`)));
      const compare = data.compare as CompareField;
      expect(compare.group).toBe(group);
      expect(compare.count).toBe(i + 2);
      expect(compare.url).toBe((first.compare as CompareField).url);
      ids.push(idOfUrl((data.preview as { url: string }).url));
    }
    expect(findGroup(previewRoot, parsePreviewAppId(group) ?? "")?.candidates).toEqual(ids);
    const before = entries();

    const fourth = okData(await propose({ name: "案4", group }));
    expect(Object.keys(fourth).sort()).toEqual(["preview_refused", "report"]);
    expect((fourth.preview_refused as { reason: string }).reason).toContain("見比べは3案まで");
    expect(entries()).toEqual(before);
    expect(findGroup(previewRoot, parsePreviewAppId(group) ?? "")?.candidates).toEqual(ids);
  });
});

describe("束に入らない(保存できない差分・データが失われる差分)", () => {
  test("拒否される差分に compare を付けても、errors は今日どおりで束の案は増えない", async () => {
    const first = okData(await propose({}));
    const group = (first.compare as CompareField).group;
    const before = entries();
    const bad = {
      diff_id: "d-bad",
      intent: "無い表に列を足す",
      operations: [
        { op: "add_field", table: "ghosts", field: { id: "x", name: "X", type: "text" } },
      ],
    };
    const plain = errorsOf(
      await callTool("dry_run_diff", { app_id: APP_ID, diff: bad }, alice.username),
    );
    const withCompare = await propose({ group }, alice.username, APP_ID, bad);
    expect(errorsOf(withCompare)).toEqual(plain);
    expect(JSON.stringify(withCompare.structuredContent)).not.toContain("pv-");
    expect(entries()).toEqual(before);
    expect(findGroup(previewRoot, parsePreviewAppId(group) ?? "")?.candidates).toHaveLength(1);
    // 陽性対照: 通る差分なら増える。
    okData(await propose({ group }, alice.username, APP_ID, diff("d-good")));
    expect(findGroup(previewRoot, parsePreviewAppId(group) ?? "")?.candidates).toHaveLength(2);
  });

  for (const op of [
    { op: "remove_field", table: TABLE_ID, field: "old" },
    { op: "change_field", table: TABLE_ID, field: "old", changes: { name: "新しい欄" } },
    { op: "change_table", table: TABLE_ID, changes: { name: "覚え書き" } },
    { op: "remove_table", table: TABLE_ID },
  ]) {
    test(`データが失われる op(${op.op})を含む差分は「データが失われる変更は見比べに出せません」`, async () => {
      const destructive = {
        diff_id: `d-${op.op}`,
        intent: "作りを変えたい",
        operations: [
          {
            op: "add_field",
            table: TABLE_ID,
            field: { id: "memo", name: "覚え書き", type: "text" },
          },
          op,
        ],
      };
      // 差分そのものは検証を通る(断るのは見比べの側。陽性対照: compare 無しなら下見ができる)。
      const plain = okData(
        await callTool(
          "dry_run_diff",
          { app_id: APP_ID, diff: destructive, preview: "real" },
          alice.username,
        ),
      );
      expect(Object.keys(plain).sort()).toEqual(["preview", "report"]);
      const before = entries();
      const data = okData(await propose({}, alice.username, APP_ID, destructive));
      expect(Object.keys(data).sort()).toEqual(["preview_refused", "report"]);
      expect((data.preview_refused as { reason: string }).reason).toContain(
        "データが失われる変更は見比べに出せません",
      );
      expect(entries()).toEqual(before);
    });
  }

  test("陽性対照: remove_field の差分は compare 無しなら今日どおり下見ができる", async () => {
    const data = okData(
      await callTool(
        "dry_run_diff",
        {
          app_id: APP_ID,
          diff: {
            diff_id: "d-rm",
            intent: "古い欄を消したい",
            operations: [{ op: "remove_field", table: TABLE_ID, field: "old" }],
          },
          preview: "real",
        },
        alice.username,
      ),
    );
    expect(Object.keys(data).sort()).toEqual(["preview", "report"]);
  });
});

describe("束の照合で断る(下見を作らない)", () => {
  async function firstGroup(mode: "real" | "sample" = "real"): Promise<string> {
    const data = okData(await propose({ mode }));
    return (data.compare as CompareField).group;
  }

  async function expectRefused(result: CallToolResult, fragment: string): Promise<void> {
    const data = okData(result);
    expect(Object.keys(data).sort()).toEqual(["preview_refused", "report"]);
    expect((data.preview_refused as { reason: string }).reason).toContain(fragment);
  }

  test("別のアプリの束", async () => {
    const group = await firstGroup();
    const before = entries();
    await expectRefused(await propose({ group }, alice.username, OTHER_APP_ID), "別のアプリ");
    expect(entries()).toEqual(before);
  });

  test("別の人の束", async () => {
    const group = await firstGroup();
    const before = entries();
    await expectRefused(await propose({ group }, "carol"), "別の人");
    expect(entries()).toEqual(before);
  });

  test("別の mode の束", async () => {
    const group = await firstGroup("real");
    const before = entries();
    await expectRefused(await propose({ group, mode: "sample" }), "mode");
    expect(entries()).toEqual(before);
  });

  test("期限切れの束", async () => {
    const group = await firstGroup();
    const groupId = parsePreviewAppId(group) ?? "";
    const path = join(previewRoot, groupId, PREVIEW_GROUP_FILE);
    const saved = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    saved.expires_at = "2000-01-01T00:00:00.000Z";
    writeFileSync(path, JSON.stringify(saved), "utf-8");
    const before = entries().filter((id) => id !== groupId);
    await expectRefused(await propose({ group }), "見つからないか");
    // 期限切れの束は予約のときの掃除で消えてよい。下見は増えない。
    expect(entries().filter((id) => id !== groupId)).toEqual(before);
  });

  test("無い束(綴りは正しい)", async () => {
    await expectRefused(await propose({ group: `pv-${"a".repeat(32)}` }), "見つからないか");
    expect(entries()).toEqual([]);
  });

  test("案の識別子(下見)を group に渡しても束ではないので断る", async () => {
    const data = okData(
      await callTool(
        "dry_run_diff",
        { app_id: APP_ID, diff: diff(), preview: "real" },
        alice.username,
      ),
    );
    const candidate = /\/apps\/(pv-[0-9a-f]{32})\/$/.exec(
      (data.preview as { url: string }).url,
    )?.[1];
    const before = entries();
    await expectRefused(await propose({ group: candidate as string }), "見つからないか");
    expect(entries()).toEqual(before);
  });
});

describe("compare を付けない呼び出しは着手前と同じ", () => {
  test("preview だけ: 束も candidate.json も作らない", async () => {
    const data = okData(
      await callTool(
        "dry_run_diff",
        { app_id: APP_ID, diff: diff(), preview: "real" },
        alice.username,
      ),
    );
    expect(Object.keys(data).sort()).toEqual(["preview", "report"]);
    const [only] = entries();
    expect(entries()).toHaveLength(1);
    expect(existsSync(join(previewRoot, only as string, PREVIEW_CANDIDATE_FILE))).toBe(false);
    expect(existsSync(join(previewRoot, only as string, PREVIEW_GROUP_FILE))).toBe(false);
  });
});

describe("道具の形", () => {
  test("dry_run_diff の引数は4本(compare が省略可能で足された)・道具は26本・説明に compare の文", async () => {
    const server = createMcpServer({ dataRoot, previewBaseUrl: PREVIEW_BASE_URL, previewRoot });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const { tools } = await client.listTools();
      // **【2026-10-02。`V23-M8-T05` / 授権 `ADR-0545` 行106】期待値を 26 → 27 へ書き換えた**(`list_record_history`)。
      // **旧行の逐語**: `expect(tools).toHaveLength(26);` **テスト名は書き換えていない。**
      expect(tools).toHaveLength(27);
      const dry = tools.find((t) => t.name === "dry_run_diff");
      const props = dry?.inputSchema.properties as Record<
        string,
        { properties?: Record<string, unknown> }
      >;
      expect(Object.keys(props).sort()).toEqual(["app_id", "compare", "diff", "preview"]);
      // 【`V20-M15-T01B` / `ADR-0479` §Decision 4-1】compare の中の4本目の鍵 off_pattern。 旧は group / name / tradeoff の3本。
      expect(Object.keys(props.compare?.properties ?? {}).sort()).toEqual([
        "group",
        "name",
        "off_pattern",
        "tradeoff",
      ]);
      expect(dry?.inputSchema.required).toEqual(["app_id", "diff"]);
      const description = dry?.description ?? "";
      expect(description).toContain("compare");
      expect(description).toContain("1つの束は3案まで");
      expect(description).toContain("データが失われる変更");
      // 効能を約束しない(`ADR-0478` 2-8 / `ADR-0054` 限定3 の読み)。
      for (const lie of [
        "最適な案",
        "必ず良く",
        "よりよい案が選べ",
        "保存できます",
        "見返せます",
      ]) {
        expect(description, lie).not.toContain(lie);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
