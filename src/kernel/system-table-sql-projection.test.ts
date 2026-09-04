/**
 * システムテーブルの投影を SQL の副問合せとして組み立てる(SQ-M2 / SQ-M3 / SQ-M4)。
 *
 * ## この検査が固定すること
 *
 * 1. **投影が返すものが、一本化の前と1バイトも違わない** —— 列名の集合・行ごとの
 *    JS 上の型・実際の値・並び順。3表すべて。読取4本すべて。
 * 2. **既定順が一本化の前と同じである** —— `_changelog` は 1,2,3…10,11 のまま。
 *
 *    **【SQ-M5 で書き直した。旧文を残す】** ここにはかつて「**`_id` に `CAST` を
 *    入れていない** —— `_changelog` の既定順が 1,2,3…10,11 のままであることで示す
 *    (`CAST(... AS TEXT)` を入れると 1,10,11,2… になる)」と書いてあった。
 *    **括弧の中が実測で否定された** —— 既定順は `_id` ではなく `defaultOrderBy`
 *    (`_changelog` は `seq`)で組み立てているので、**`CAST` を入れても既定順は
 *    1件も動かない。** つまりこの検査は `CAST` の有無を1バイトも判定していなかった。
 *    今日の投影は `CAST(... AS TEXT)` を**入れている**(理由は `read-records.ts`)。
 *    `CAST` の有無を判定するのは `system-table-behavior-fixation.test.ts` の
 *    「`_id` を明示して並べると文字列順である」の側である。
 * 3. **投影が定義されていない表IDでは黙って空を返さず落ちる**(子プロセスで `_probe` を注入)。
 * 4. **`select` の値域外は落ちる**(CHECK 制約では代替できないため、行に写す箇所に検査を残した)。
 *
 * ## 期待値は逐語で書く(2経路の突き合わせではない)
 *
 * **SQ-M2 の時点では「今日のメモリ経路」と突き合わせていたが、SQ-M4 でその経路を消した。**
 * **消した相手と比べ続ける形にすると、両側が同じ実装を指す「偽の突き合わせ」になる**
 * (`read-records.test.ts` の「SQL 経路とメモリ経路が…」がまさにそれで、今回の発端である)。
 * したがって期待値は**逐語で**書く —— 一本化の前に採った実測値そのものである。
 *
 * ## 題材の作り方
 *
 * 投影元は**実運用のストアAPI**(`registerApp` / `appendChangelog` / `recordUsage`)だけで
 * 作る。並び順の割れ方を出すために、**`created_at` が同値のアプリ2件**(登録順は
 * zeta → alpha、`app_id` の辞書順は alpha → zeta)と、**`applied_at` が同値の changelog 2件**を
 * 必ず含める。ここが同値でない題材では、既定順が変わっても偶然緑になる。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SYSTEM_TABLES } from "../shared/system-tables.ts";
import { AiCapabilityStore } from "./ai-capability-store.ts";
import { SYSTEM_COLUMN_NAMES } from "./ddl.ts";
import type { ValidationError } from "./errors.ts";
import { KernelMetaStore } from "./meta-store.ts";
import {
  type ReadSource,
  readRecord,
  readRecordCount,
  readRecordCountAndSum,
  readRecordList,
} from "./read-records.ts";
import type { Manifest } from "./types.ts";

const manifest: Manifest = {
  app: { id: "probe-app", name: "投影の検査", tables: [], views: [] },
};

let dataRoot: string;
let source: ReadSource;

function unwrap<T>(result: { ok: true; value: T } | { ok: false; errors: ValidationError[] }): T {
  if (!result.ok) {
    throw new Error(`期待に反して失敗しました: ${JSON.stringify(result.errors)}`);
  }
  return result.value;
}

/** 行ごとの JS 上の型(`typeof`。null は "null")。値だけでなく型の一致も見る。 */
function typesOf(rows: readonly Record<string, unknown>[]): Record<string, string>[] {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, value === null ? "null" : typeof value]),
    ),
  );
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-system-table-sql-"));

  const store = KernelMetaStore.open(dataRoot);
  try {
    // created_at が同値の2件。登録順(ledger_seq)は zeta → alpha、app_id 辞書順は逆。
    store.registerApp({
      app_id: "zeta-shop",
      name: "Ａ 全角の店",
      created_at: "2026-08-01T00:00:00.000Z",
    });
    store.registerApp({
      app_id: "alpha-shop",
      name: "A 半角の店",
      created_at: "2026-08-01T00:00:00.000Z",
    });
    store.registerApp({
      app_id: "kichi-store",
      name: "𠮷野家 まかない帳",
      created_at: "2026-08-02T00:00:00.000Z",
    });
    // applied_at が同値の2件(seq だけが順序を決める)。
    store.appendChangelog({
      app_id: "zeta-shop",
      diff_id: "d-001",
      intent: "商品の表がほしい",
      operations: [],
      applied_at: "2026-08-01T00:00:00.000Z",
    });
    store.appendChangelog({
      app_id: "alpha-shop",
      diff_id: "d-101",
      intent: "顧客の表がほしい",
      operations: [],
      applied_at: "2026-08-01T00:00:00.000Z",
    });
    // 10件を越えさせる(既定順が文字列順に化けると 1,10,11,2… になる)。
    for (let i = 2; i <= 11; i += 1) {
      store.appendChangelog({
        app_id: "zeta-shop",
        diff_id: `d-${String(i).padStart(3, "0")}`,
        intent: `${i} 本目の差分(𠮷 を含む)`,
        operations: [],
        applied_at: `2026-08-0${i <= 9 ? "2" : "3"}T00:0${i % 10}:00.000Z`,
        kind: i === 11 ? "undo" : "apply",
        ...(i === 11 ? { undo_target_seq: 3 } : {}),
      });
    }
  } finally {
    store.close();
  }

  const ai = AiCapabilityStore.openForKernel(dataRoot);
  try {
    const cap = ai.createCapability({
      appId: "zeta-shop",
      name: "summarize",
      provider: "claude_cli",
      model: "claude-sonnet-4",
      limit: { maxCallsPerDay: 100, maxCostUsdPerDay: 1 },
    });
    ai.recordUsage({
      appId: "zeta-shop",
      capabilityId: cap.id,
      workflowId: "wf-summary",
      actor: "𠮷田",
      model: "claude-sonnet-4",
      inputTokens: 120,
      outputTokens: 45,
      costUsd: 0.0125,
      status: "success",
      usageDate: "2026-08-04",
      calledAt: "2026-08-04T01:00:00.000Z",
    });
    ai.recordUsage({
      appId: "zeta-shop",
      capabilityId: cap.id,
      workflowId: "wf-summary",
      actor: null,
      model: "claude-sonnet-4",
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      status: "blocked",
      usageDate: "2026-08-04",
      calledAt: "2026-08-04T02:00:00.000Z",
    });
  } finally {
    ai.close();
  }

  source = {
    dataRoot,
    appDb: () => {
      throw new Error("システムテーブルの読み取りで app.sqlite を開いてはならない");
    },
  };
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

describe("投影の返り値は一本化の前と1バイトも変わらない", () => {
  for (const table of SYSTEM_TABLES) {
    test(`${table.id}: 返る列は システム列3本 + 定義のフィールドだけである`, () => {
      const rows = unwrap(readRecordList(source, manifest, table.id));
      // 「0件だったので一致した」を通さない。
      expect(rows.length).toBeGreaterThan(0);
      const expectedColumns = [...SYSTEM_COLUMN_NAMES, ...table.fields.map((f) => f.id)];
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual([...expectedColumns].sort());
      }
    });
  }

  test("_apps: 値・型・並び順(created_at が同値の2件は登録順 zeta → alpha のまま)", () => {
    const rows = unwrap(readRecordList(source, manifest, "_apps"));
    expect(rows).toEqual([
      {
        _id: "zeta-shop",
        _created_at: "2026-08-01T00:00:00.000Z",
        _updated_at: "2026-08-01T00:00:00.000Z",
        app_id: "zeta-shop",
        name: "Ａ 全角の店",
        created_at: "2026-08-01T00:00:00.000Z",
        status: "active",
      },
      {
        _id: "alpha-shop",
        _created_at: "2026-08-01T00:00:00.000Z",
        _updated_at: "2026-08-01T00:00:00.000Z",
        app_id: "alpha-shop",
        name: "A 半角の店",
        created_at: "2026-08-01T00:00:00.000Z",
        status: "active",
      },
      {
        _id: "kichi-store",
        _created_at: "2026-08-02T00:00:00.000Z",
        _updated_at: "2026-08-02T00:00:00.000Z",
        app_id: "kichi-store",
        name: "𠮷野家 まかない帳",
        created_at: "2026-08-02T00:00:00.000Z",
        status: "active",
      },
    ]);
    // 追記専用の記録なので `_updated_at` は `_created_at` と同じ。仕様である。
    for (const row of rows) {
      expect(row._updated_at).toBe(row._created_at);
    }
  });

  test("_changelog: 既定順は 1,2,3…10,11(_id に CAST を入れていない)", () => {
    const rows = unwrap(readRecordList(source, manifest, "_changelog"));
    expect(rows.map((row) => row._id)).toEqual(
      Array.from({ length: 12 }, (_unused, i) => String(i + 1)),
    );
    // `_id` は文字列に写る(`toRecordRow` が String() で写す)が、並びは数値順である。
    expect(typeof rows[0]?._id).toBe("string");
    expect(typeof rows[0]?.seq).toBe("number");
  });

  test("_changelog: 値と型(applied_at が同値の2件は seq で決まる)", () => {
    const rows = unwrap(readRecordList(source, manifest, "_changelog"));
    expect(rows[0]).toEqual({
      _id: "1",
      _created_at: "2026-08-01T00:00:00.000Z",
      _updated_at: "2026-08-01T00:00:00.000Z",
      seq: 1,
      app_id: "zeta-shop",
      diff_id: "d-001",
      intent: "商品の表がほしい",
      applied_at: "2026-08-01T00:00:00.000Z",
      kind: "apply",
      undo_target_seq: null,
    });
    expect(rows[1]).toMatchObject({ _id: "2", diff_id: "d-101", app_id: "alpha-shop" });
    expect(rows[11]).toEqual({
      _id: "12",
      _created_at: "2026-08-03T00:01:00.000Z",
      _updated_at: "2026-08-03T00:01:00.000Z",
      seq: 12,
      app_id: "zeta-shop",
      diff_id: "d-011",
      intent: "11 本目の差分(𠮷 を含む)",
      applied_at: "2026-08-03T00:01:00.000Z",
      kind: "undo",
      undo_target_seq: 3,
    });
    // 未記入の `undo_target_seq` は null(0 にも undefined にも倒さない)。
    expect(typesOf(rows as unknown as Record<string, unknown>[])[0]).toEqual({
      _id: "string",
      _created_at: "string",
      _updated_at: "string",
      seq: "number",
      app_id: "string",
      diff_id: "string",
      intent: "string",
      applied_at: "string",
      kind: "string",
      undo_target_seq: "null",
    });
  });

  test("_ai_usage: 値・型・並び順(未記入の列は null のまま写る)", () => {
    const rows = unwrap(readRecordList(source, manifest, "_ai_usage"));
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.actor)).toEqual(["𠮷田", null]);
    // `_id` は `crypto.randomUUID()` 由来なので逐語では書けない。型と非空だけを見る。
    for (const row of rows) {
      expect(typeof row._id).toBe("string");
      expect(String(row._id).length).toBeGreaterThan(0);
    }
    const withMaskedId = rows.map((row) => ({ ...row, _id: "<uuid>" })) as unknown as Record<
      string,
      unknown
    >[];
    expect(withMaskedId).toEqual([
      {
        _id: "<uuid>",
        _created_at: "2026-08-04T01:00:00.000Z",
        _updated_at: "2026-08-04T01:00:00.000Z",
        app_id: "zeta-shop",
        capability_id: rows[0]?.capability_id as string,
        workflow_id: "wf-summary",
        actor: "𠮷田",
        model: "claude-sonnet-4",
        input_tokens: 120,
        output_tokens: 45,
        cost_usd: 0.0125,
        status: "success",
        usage_date: "2026-08-04",
        called_at: "2026-08-04T01:00:00.000Z",
      },
      {
        _id: "<uuid>",
        _created_at: "2026-08-04T02:00:00.000Z",
        _updated_at: "2026-08-04T02:00:00.000Z",
        app_id: "zeta-shop",
        capability_id: rows[0]?.capability_id as string,
        workflow_id: "wf-summary",
        actor: null,
        model: "claude-sonnet-4",
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
        status: "blocked",
        usage_date: "2026-08-04",
        called_at: "2026-08-04T02:00:00.000Z",
      },
    ]);
  });

  test("読取4本すべてが同じ投影を通る(件数・合計・単体取得)", () => {
    for (const table of SYSTEM_TABLES) {
      const rows = unwrap(readRecordList(source, manifest, table.id));
      expect(unwrap(readRecordCount(source, manifest, table.id))).toBe(rows.length);
      expect(unwrap(readRecordCountAndSum(source, manifest, table.id))).toEqual({
        count: rows.length,
        sum: null,
      });
      const first = rows[0];
      if (first === undefined) {
        throw new Error("題材が空です");
      }
      expect(unwrap(readRecord(source, manifest, table.id, first._id))).toEqual(first);
    }
  });
});

describe("select の値域外は黙って通らない(CHECK 制約では代替できない)", () => {
  test("カーネル外から書き換えられた changelog.kind で落ちる", () => {
    const writable = new Database(join(dataRoot, "kernel.sqlite"));
    try {
      writable.exec(`UPDATE "changelog" SET "kind" = 'とんでもない値' WHERE "seq" = 1`);
    } finally {
      writable.close();
    }
    expect(() => readRecordList(source, manifest, "_changelog")).toThrow(/とんでもない値/);
    expect(() => readRecordList(source, manifest, "_changelog")).toThrow(
      /許可される値: apply \/ undo \/ redo/,
    );
  });

  test("カーネル外から書き換えられた ai_usage.status でも落ちる", () => {
    // 投影元のストア(`toUsageStatus`)が持っていた値域検査を、一本化しても失わない。
    //
    // **`ai_usage.status` は `changelog.kind` と違い、DB 側にも CHECK 制約がある**
    // (`kind` は既存DBへ `ALTER` で足した列なので CHECK を付けられない)。
    // ここでは CHECK を無視して書き、**CHECK の無い古いDB / 外から壊されたDB**を再現する。
    const writable = new Database(join(dataRoot, "kernel.sqlite"));
    try {
      writable.exec("PRAGMA ignore_check_constraints = ON;");
      writable.exec(`UPDATE "ai_usage" SET "status" = 'まだ無い状態'`);
    } finally {
      writable.close();
    }
    expect(() => readRecordList(source, manifest, "_ai_usage")).toThrow(/まだ無い状態/);
  });

  test("apps.status は投影元も検査していないので、ここでも落とさない", () => {
    // **挙動を増やさない。** `_apps.status` の値域外は今日も throw しない(実測済み)。
    const writable = new Database(join(dataRoot, "kernel.sqlite"));
    try {
      writable.exec(`UPDATE "apps" SET "status" = 'まだ無い状態' WHERE "app_id" = 'zeta-shop'`);
    } finally {
      writable.close();
    }
    const rows = unwrap(readRecordList(source, manifest, "_apps"));
    expect(rows[0]?.status).toBe("まだ無い状態");
  });
});

// --- 投影が定義されていない表IDでは落ちる(子プロセスで `_probe` を注入)-----------------

const KERNEL_DIR = import.meta.dir;
const SHARED_DIR = resolve(import.meta.dir, "../shared");

/**
 * `_probe`(4本目のシステムテーブル)を注入した子プロセスを走らせ、結果を回収する。
 *
 * 既存の `read-records.test.ts` の同名の仕掛けと同じ手口(`mock.module` は同一プロセスの
 * 他のテストにも漏れるので子プロセスに閉じる)。
 */
function probeViaSql(): { threw?: string; returned?: unknown } {
  const path = join(dataRoot, "probe-sql.ts");
  writeFileSync(
    path,
    `
import { mock } from "bun:test";

const SHARED = ${JSON.stringify(SHARED_DIR)};
const KERNEL = ${JSON.stringify(KERNEL_DIR)};
const real = await import(SHARED + "/system-tables.ts");

const PROBE_TABLE = {
  id: "_probe",
  name: "4本目のシステムテーブル(テスト注入)",
  fields: [{ id: "probe_id", name: "ID", type: "text", required: true }],
};
const tables = [...real.SYSTEM_TABLES, PROBE_TABLE];
const ids = tables.map((table) => table.id);

mock.module(SHARED + "/system-tables.ts", () => ({
  SYSTEM_TABLES: tables,
  SYSTEM_TABLE_IDS: ids,
  isSystemTableId: (id) => ids.includes(id),
  findSystemTable: (id) => tables.find((table) => table.id === id),
}));

const readRecords = await import(KERNEL + "/read-records.ts");
const [root] = process.argv.slice(2);
const manifest = { app: { id: "probe-app", name: "probe", tables: [], views: [] } };
const source = {
  dataRoot: root,
  appDb: () => {
    throw new Error("app.sqlite を開いてはならない");
  },
};

let out;
try {
  out = { returned: readRecords.readRecordList(source, manifest, "_probe") };
} catch (error) {
  out = { threw: error instanceof Error ? error.message : String(error) };
}
console.log("PROBE_SQL " + JSON.stringify(out));
`,
    "utf-8",
  );
  const proc = Bun.spawnSync({
    cmd: ["bun", "run", path, dataRoot],
    stdout: "pipe",
    stderr: "pipe",
  });
  const line = proc.stdout
    .toString()
    .split("\n")
    .find((candidate) => candidate.startsWith("PROBE_SQL "));
  if (line === undefined) {
    throw new Error(
      `子プロセスが結果を返しませんでした(exit=${String(proc.exitCode)})。stderr: ${proc.stderr.toString()}`,
    );
  }
  return JSON.parse(line.slice("PROBE_SQL ".length)) as { threw?: string; returned?: unknown };
}

describe("投影が定義されていない表IDは沈黙せずに落ちる", () => {
  test("4本目を足して投影を書き忘れたら、空も別表の中身も返らない", () => {
    const probe = probeViaSql();
    expect(probe.returned).toBeUndefined();
    expect(probe.threw).toContain("_probe");
    expect(probe.threw).toContain("投影");
  });
});
