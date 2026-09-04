/**
 * CP-V1-1 確認方法4 が名指しした「**このフィールドを日付型に変えて**」の経路を、
 * 自動テストの側から実測して固定する(V1-M1 穴埋め)。
 *
 * ## なぜこのファイルが要るのか
 *
 * `cp-v1-1-measurements.md` §4-4 の実測:
 *
 * > **確認方法4 の例示は「このフィールドを日付型に変えて」である。
 * > 日付型への `change_field{type}` を試した試行は 14本中 0本である。**
 *
 * **実地で日付型への型変換が1度も走っていない。**実地試行を足すのは壁時計が長く別途の判断が要るので、
 * **自動テストの側で日付型が関わる変換を全セル実測してここに固定する。**
 *
 * ## このファイルが主張しないこと(混同しないために明記する)
 *
 * > **本ファイルが緑であることは、「AI が実地で日付型変換の経路を通った」ことを1ミリも意味しない。**
 * > **実地での日付型への `change_field{type}` は依然 0 件である。**カーネルがその変換を正しく扱えることと、
 * > 会話の中で AI がその経路へ到達することは、**別の主張**である。前者だけが本ファイルの射程である。
 * > 後者を測るのは実地試行(`docs/evidence/cp-v1-1/transcripts/`)だけであり、**本ファイルは代替にならない。**
 *
 * ## 実測して分かった中心的な事実(このファイルが固定するもの)
 *
 * **日付型が関わる変換で「実行できる」セルは、すべて層1 である。層2 になるセルは、すべて「不」である。**
 *
 * | | → date | date → |
 * |---|---|---|
 * | `text` | **条 / 層1** | **可 / 層1** |
 * | `long_text` | **条 / 層1** | **可 / 層1** |
 * | `select` | **条 / 層1** | **条 / 層1** |
 * | `date` | 可 / 層1 | 可 / 層1 |
 * | `number` | **不 / 層2** | **不 / 層2** |
 * | `boolean` | **不 / 層2** | **不 / 層2** |
 * | `reference` | **不 / 層1** | **不 / 層1** |
 *
 * 理由は `ddl.ts` の `FIELD_TYPE_TO_SQLITE` にある —— **`date` の SQLite 宣言型は `TEXT` であり、
 * `text` / `long_text` / `select` / `reference` と同じである。**層は「SQLite 列型が変わるか」そのもの
 * (`convert.ts` の `conversionLayer`)なので、TEXT 同士の変換は必ず層1 になる。層2 になる相手
 * (`number` = NUMERIC / `boolean` = INTEGER)は、変換マトリクスが「不」にしている。
 *
 * **この事実の帰結を書いておく(丸めない)**:
 *
 * - **確認方法4 の例示「日付型に変えて」は、成功する限りテーブル再構築を1度も踏まない。**
 *   したがって **確認方法1(層2 の連鎖)の検証を、日付型の実地例で代替することはできない。**
 *   `cp-v1-1-measurements.md` §4-4 が「実地で踏まれたセルは `select → number` / `text → number` だけ」と
 *   書いているが、**その2つは層2 であり、日付型より重い経路である。**
 * - **逆に言えば、日付型変換は「1万行でも DDL が1文も出ない」経路である。**これは
 *   `large-scale-chain.test.ts` が見ている経路とは費用構造が違う。
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDiff } from "./apply-diff.ts";
import { applyManifest } from "./apply-manifest.ts";
import { conversionLayer, conversionVerdict, convertValue } from "./convert.ts";
import { createApp } from "./create-app.ts";
import { sqliteTypeForFieldType } from "./ddl.ts";
import { dryRunDiff } from "./dry-run.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { createRecord } from "./records.ts";
import { listSnapshots } from "./snapshot.ts";
import { appDbPath, appManifestPath } from "./storage-paths.ts";
import type { Field, FieldType, Manifest } from "./types.ts";
import { undo } from "./undo.ts";

const APP_ID = "date-conv";
const ROW_COUNT = 10_000;

let dataRoot: string;
let store: KernelMetaStore;

function baseManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "日付変換検証",
      tables: [
        {
          id: "tasks",
          name: "タスク",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "due", name: "期限", type: "text" },
          ],
        },
      ],
      views: [{ id: "task-list", type: "list_view", table: "tasks", columns: ["title"] }],
    },
  };
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-date-conv-"));
  store = KernelMetaStore.open(dataRoot);
  createApp(store, "日付変換検証", { app_id: APP_ID });
  const applied = applyManifest(dataRoot, APP_ID, baseManifest());
  if (!applied.valid) {
    throw new Error(`初期マニフェストの投入に失敗: ${JSON.stringify(applied.errors)}`);
  }
});

afterEach(async () => {
  store.close();
  await rm(dataRoot, { recursive: true, force: true });
});

function withDb<T>(fn: (db: Database) => T): T {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function readManifestText(): string {
  return readFileSync(appManifestPath(dataRoot, APP_ID), "utf-8");
}

function readDbBytes(): Buffer {
  return readFileSync(appDbPath(dataRoot, APP_ID));
}

function readDeclaredType(table: string, column: string): string | undefined {
  return withDb(
    (db) =>
      db
        .query<{ name: string; type: string }, []>(`PRAGMA table_info("${table}")`)
        .all()
        .find((row) => row.name === column)?.type,
  );
}

/** テーブル再構築が起きたかの直接の観測点(層1 なら動かない)。 */
function readRootPage(table: string): number | undefined {
  return withDb(
    (db) =>
      db
        .query<{ rootpage: number }, [string]>(
          `SELECT "rootpage" FROM "sqlite_master" WHERE "type" = 'table' AND "name" = ?`,
        )
        .get(table)?.rootpage,
  );
}

function readAllRows(): Record<string, unknown>[] {
  return withDb((db) =>
    db.query<Record<string, unknown>, []>(`SELECT * FROM "tasks" ORDER BY "_id"`).all(),
  );
}

/** `due` に ISO8601 の日付を入れた行を N 行。`badAt` の行だけ日付として読めない値にする。 */
function seedDates(count: number, badAt: ReadonlySet<number> = new Set()): void {
  withDb((db) => {
    const manifest = JSON.parse(readManifestText()) as Manifest;
    db.exec("BEGIN");
    for (let index = 0; index < count; index += 1) {
      const month = String((index % 12) + 1).padStart(2, "0");
      const day = String((index % 28) + 1).padStart(2, "0");
      const due = badAt.has(index) ? `だいたい来月` : `2026-${month}-${day}`;
      const result = createRecord(db, manifest, "tasks", {
        title: `タスク-${String(index).padStart(6, "0")}`,
        due,
      });
      if (!result.ok) {
        throw new Error(`投入に失敗(${index}行目): ${JSON.stringify(result.errors)}`);
      }
    }
    db.exec("COMMIT");
  });
}

function toDateDiff(diffId: string): unknown {
  return {
    diff_id: diffId,
    intent: "期限を日付型に変えたい",
    operations: [{ op: "change_field", table: "tasks", field: "due", changes: { type: "date" } }],
  };
}

function field(type: FieldType, extra: Partial<Field> = {}): Field {
  const base = { id: "due", name: "期限", type, ...extra } as Field;
  return base;
}

const ALL_TYPES: FieldType[] = [
  "text",
  "long_text",
  "number",
  "boolean",
  "date",
  "select",
  "reference",
];

describe("日付型が関わる変換セルの層と可否(ADR-0010 §5a / §5b を実測で固定する)", () => {
  test("`date` の SQLite 宣言型は TEXT である —— 層がこう決まる根拠", () => {
    expect(sqliteTypeForFieldType("date")).toBe("TEXT");
    expect(sqliteTypeForFieldType("text")).toBe("TEXT");
    expect(sqliteTypeForFieldType("long_text")).toBe("TEXT");
    expect(sqliteTypeForFieldType("select")).toBe("TEXT");
    expect(sqliteTypeForFieldType("reference")).toBe("TEXT");
    expect(sqliteTypeForFieldType("number")).toBe("NUMERIC");
    expect(sqliteTypeForFieldType("boolean")).toBe("INTEGER");
  });

  /** 実測値。左から: 相手の型 / 相手→date / date→相手 の [可否, 層]。 */
  const CELLS: [
    FieldType,
    ["possible" | "conditional" | "impossible", 1 | 2],
    ["possible" | "conditional" | "impossible", 1 | 2],
  ][] = [
    ["text", ["conditional", 1], ["possible", 1]],
    ["long_text", ["conditional", 1], ["possible", 1]],
    ["number", ["impossible", 2], ["impossible", 2]],
    ["boolean", ["impossible", 2], ["impossible", 2]],
    ["date", ["possible", 1], ["possible", 1]],
    ["select", ["conditional", 1], ["conditional", 1]],
    ["reference", ["impossible", 1], ["impossible", 1]],
  ];

  for (const [other, into, outOf] of CELLS) {
    test(`${other} → date は ${into[0]} / 層${into[1]}、date → ${other} は ${outOf[0]} / 層${outOf[1]}`, () => {
      expect(conversionVerdict(other, "date")).toBe(into[0]);
      expect(conversionLayer(other, "date")).toBe(into[1]);
      expect(conversionVerdict("date", other)).toBe(outOf[0]);
      expect(conversionLayer("date", other)).toBe(outOf[1]);
    });
  }

  test("実行できる日付型変換はすべて層1 である(層2 になるセルはすべて「不」)", () => {
    // **これがこのファイルの中心的な主張である。**
    // 個別セルを1つ書き換えただけでは崩れないよう、全セルを走査して言い直す。
    for (const other of ALL_TYPES) {
      for (const [from, to] of [
        [other, "date"],
        ["date", other],
      ] as [FieldType, FieldType][]) {
        const verdict = conversionVerdict(from, to);
        const layer = conversionLayer(from, to);
        if (layer === 2) {
          expect(verdict).toBe("impossible");
        }
        if (verdict !== "impossible") {
          expect(layer).toBe(1);
        }
      }
    }
  });
});

describe("変換不能値の扱い(日付型。値ごとの実測)", () => {
  const ACCEPTED = ["2026-07-20", "2026-07-20T10:30:00Z", "2026-07-20 10:30", "2026-07-20T10:30"];
  const REJECTED = [
    "2026-13-01", // 月が 13。形は ISO でも日付として不正
    "2026/07/20", // スラッシュ区切り
    "20/07/2026", // 日本語圏以外の一般的な表記
    "きのう", // 自然言語
    "", // 空文字。**null に落とさない**(限定7)
    "   ", // 空白のみ。同上
    "0", // 数値らしき文字列
    "2026-07", // 年月まで
  ];

  for (const value of ACCEPTED) {
    test(`text → date: ${JSON.stringify(value)} は受け入れられ、値がそのまま運ばれる`, () => {
      const result = convertValue(value, field("text"), field("date"));
      expect(result).toEqual({ ok: true, value });
    });
  }

  for (const value of REJECTED) {
    test(`text → date: ${JSON.stringify(value)} は変換不能値として拒否される`, () => {
      const result = convertValue(value, field("text"), field("date"));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("ISO8601 の日付として解釈できません");
      }
    });
  }

  test("空文字・空白のみを黙って null に落とさない(限定7: カーネルはユーザデータを書き換えない)", () => {
    for (const value of ["", "   "]) {
      const result = convertValue(value, field("text"), field("date"));
      // **`{ ok: true, value: null }` を返してはならない。**それはデータの黙った書き換えである。
      expect(result.ok).toBe(false);
    }
  });

  test("null は日付型でも null のまま運ばれる(required でない限り変換不能値にならない)", () => {
    expect(convertValue(null, field("text"), field("date"))).toEqual({ ok: true, value: null });
    expect(convertValue(null, field("text"), field("date", { required: true })).ok).toBe(false);
  });

  test("「不」セルは値を1つも見ずに拒否する(対象が空でも通さない。ADR-0010 §5b 注意2)", () => {
    // number → date は「エポック秒とみなす」という**書かれていない約束**を要するので語彙として認めない。
    for (const [from, to, value] of [
      ["number", "date", 1_784_000_000],
      ["date", "number", "2026-07-20"],
      ["boolean", "date", 1],
      ["date", "boolean", "2026-07-20"],
      ["reference", "date", "tasks-1"],
      ["date", "reference", "2026-07-20"],
    ] as [FieldType, FieldType, unknown][]) {
      const result = convertValue(value, field(from), field(to));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe(`"${from}" から "${to}" への変換は語彙として認められていません`);
      }
    }
  });

  test("select → date は選択肢の値が日付として読めるかで決まり、date → select は選択肢に含まれるかで決まる", () => {
    const select = field("select", { options: ["2026-07-20", "2026-01-01", "未定"] });
    expect(convertValue("2026-07-20", select, field("date"))).toEqual({
      ok: true,
      value: "2026-07-20",
    });
    expect(convertValue("未定", select, field("date")).ok).toBe(false);

    expect(convertValue("2026-07-20", field("date"), select)).toEqual({
      ok: true,
      value: "2026-07-20",
    });
    // 選択肢に無い日付は拒否される。**理由が「日付として読めない」ではないことまで見る。**
    const notInOptions = convertValue("2026-03-03", field("date"), select);
    expect(notInOptions.ok).toBe(false);
    if (!notInOptions.ok) {
      expect(notInOptions.reason).toContain("選択肢");
    }
  });
});

describe(`CP-V1-1 確認方法4 の例示: ${ROW_COUNT} 行で「期限を日付型に変えて」の連鎖`, () => {
  test("ドライラン → 適用 → undo が通り、層1 = テーブル再構築が起きないことを DB 側から確かめる", () => {
    seedDates(ROW_COUNT);

    expect(conversionLayer("text", "date")).toBe(1);

    const beforeManifest = readManifestText();
    const beforeRootPage = readRootPage("tasks");
    const beforeRows = readAllRows();
    const beforeDbBytes = readDbBytes();
    expect(beforeRows).toHaveLength(ROW_COUNT);

    // --- ドライラン: DB は1バイトも動かない -----------------------------------
    const dry = dryRunDiff(dataRoot, APP_ID, toDateDiff("d-date-1"));
    expect(dry.valid).toBe(true);
    expect(readDbBytes().equals(beforeDbBytes)).toBe(true);
    expect(listSnapshots(dataRoot, APP_ID)).toHaveLength(0);

    // --- 適用 ---------------------------------------------------------------
    expect(applyDiff(dataRoot, APP_ID, toDateDiff("d-date-1")).valid).toBe(true);

    // **マニフェストは変わる。**型が変わったのだから当然である。
    expect(readManifestText()).not.toBe(beforeManifest);
    expect(JSON.parse(readManifestText()).app.tables[0].fields[1].type).toBe("date");

    // **DB のスキーマは変わらない。**`date` も `text` も SQLite では TEXT だからである。
    expect(readDeclaredType("tasks", "due")).toBe("TEXT");
    // **テーブル再構築が起きていない。**根ページが動いていないことが、その直接の証拠である。
    expect(readRootPage("tasks")).toBe(beforeRootPage);
    // 値も1つも書き換わっていない(層1 は値をコピーしない)。
    expect(readAllRows()).toEqual(beforeRows);

    // --- undo ---------------------------------------------------------------
    expect(undo(dataRoot, APP_ID).valid).toBe(true);
    expect(readManifestText()).toBe(beforeManifest);
    expect(readAllRows()).toEqual(beforeRows);
  });

  test(`${ROW_COUNT} 行中1行でも日付として読めない値があれば、日付型への変更は中止され状態は不変`, () => {
    const bad = new Set([ROW_COUNT - 1]); // **末尾の1行。**先頭で落ちるだけの経路を緑にしない。
    seedDates(ROW_COUNT, bad);

    const beforeManifest = readManifestText();
    const beforeDbBytes = readDbBytes();

    const dry = dryRunDiff(dataRoot, APP_ID, toDateDiff("d-date-bad"));
    expect(dry.valid).toBe(false);

    const applied = applyDiff(dataRoot, APP_ID, toDateDiff("d-date-bad"));
    expect(applied.valid).toBe(false);
    if (applied.valid || dry.valid) {
      return;
    }
    expect(applied.errors).toEqual(dry.errors);

    const message = applied.errors[0]?.message ?? "";
    expect(message).toContain("既存の 1 件のレコードが変換できなくなります");
    expect(message).toContain("だいたい来月");
    // **どの行かが `_id` で分かること** —— hint が案内する自己修正はこれに依存している。
    expect(message).toMatch(/_id "[0-9a-f-]{36}"/);

    // 状態不変。拒否経路はスナップショットを作らないのでバイト列まで一致する。
    expect(readManifestText()).toBe(beforeManifest);
    expect(readDbBytes().equals(beforeDbBytes)).toBe(true);
    expect(listSnapshots(dataRoot, APP_ID)).toHaveLength(0);
  });

  test("変換不能値を直してから同じ差分を再送すると成立する(hint が案内する経路。実地では 0/2 だった)", () => {
    // `v1-m1-t07b.md` §3: **hint が案内する「値を直して同じ差分を再送」は実地で 0/2。**
    // **その経路がカーネル側で成立することは、ここで初めて自動テストになる。**
    // **これは実地で通ったことを意味しない。**実地の 0/2 は 0/2 のままである。
    seedDates(1_000, new Set([500]));

    expect(applyDiff(dataRoot, APP_ID, toDateDiff("d-date-fix")).valid).toBe(false);

    // 値を直す(hint が案内する `update_record` 相当)。
    withDb((db) => {
      db.query(`UPDATE "tasks" SET "due" = '2026-05-05' WHERE "due" = 'だいたい来月'`).run();
    });

    // **同じ差分を、同じ diff_id で再送する。**
    const retried = applyDiff(dataRoot, APP_ID, toDateDiff("d-date-fix"));
    expect(retried.valid).toBe(true);
    expect(JSON.parse(readManifestText()).app.tables[0].fields[1].type).toBe("date");
    expect(readDeclaredType("tasks", "due")).toBe("TEXT"); // 層1 のまま
  });
});
