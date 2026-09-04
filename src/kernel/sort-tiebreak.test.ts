/**
 * V4-M21-T05: 宣言された `sort` が同値になったときの並び順を固定する(カーネルの読取既定)。
 *
 * 上位: `docs/plan/v4/records/v4-m21.md` §1 の `V4-M21-T05` /
 *       `docs/plan/v4/records/v4-m21-gate-a-same-day-order.md`(単位C = **将来送り**)。
 *
 * **語彙を1バイトも増やしていない** —— `schemas/` に差分は0行であり、マニフェストに
 * 書けるキーは1つも増えていない。変わるのは**カーネルの読取既定**だけである。
 *
 * ## このファイルが固定する4点
 *
 * 1. **`sort` を1つも宣言していない一覧の並び順は1バイトも変わらない**
 *    (今日すでに `_created_at ASC, _id ASC` に固定されている。`records.ts` の既定式)。
 * 2. **`sort` を宣言したとき、宣言したキーが同値になる行は `_created_at` → `_id` で決まる。**
 * 3. **第2キーの向きは「宣言した最後のキーの向き」に従う**(下の §向き)。
 * 4. **ユーザテーブル(`listRecords`)とシステムテーブルの投影(`read-records.ts`)で
 *    同じ順序になる。** **【SQ-M4 追記】** 着手時、後者は `applyOptions` という2つ目の
 *    実装だった。**今日は両方とも `listRecords` を通る**ので、この4点目は
 *    「2つの実装が一致すること」ではなく「投影の副問合せが既定の継ぎ足しを妨げないこと」を
 *    測っている。**測っている値は1つも変えていない。**
 *
 * ## §向き —— なぜ「宣言の最後のキーの向きに従う」なのか(**決めたことを書く**)
 *
 * **門A 本審査の実測**(`v4-m21-gate-a-same-day-order.md` §4-2-1): `placed_on desc` の下で
 * 第2キーを **`asc`** にした並びは、第2キーを足さない今日の並びと**1行も違わなかった**
 * (症状はゼロ改善)。**`desc` にしたときだけ**同じ日の中が新しい順になった。
 *
 * したがって「常に `asc`」は目的を1ミリも達成しない。残る選択肢は2つである:
 *
 * - **(a) 常に `desc`** …… `名前 asc` で並べた一覧でも、同名の行は「新しい順」になる。
 * - **(b) 宣言した最後のキーの向きに従う**(本実装が採ったもの)…… `desc` 宣言なら `desc`、
 *   `asc` 宣言なら `asc`。
 *
 * **(b) を採った理由**: 送り元の完了条件の逐語が「**`desc` で並べたとき**に第2キーを
 * どちらの向きにするかを決め、記録すること」(`V4-M10-T42` 完了条件4)であり、
 * 向きの問いが `desc` のときにだけ立つ形 —— すなわち `asc` 宣言の既定は `asc` —— を
 * 前提にしている。加えて `sort` 無しの既定(`_created_at ASC, _id ASC`)と連続する。
 *
 * **アプリは第2キーも向きも選べない**(`v4-m21-gate-a-same-day-order.md` §4-2 の
 * 「失うもの」1・2)。向きは宣言から決定論的に決まるだけであり、独立には指定できない。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifestDdl } from "./ddl.ts";
import type { ValidationError } from "./errors.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { type ReadSource, readRecordList } from "./read-records.ts";
import { createRecord, listRecords } from "./records.ts";
import type { Manifest, Sort } from "./types.ts";

/**
 * 門A 本審査 §4-2-1 の計測と**同じ形**のテーブル(注文一覧の再現)。
 *
 * `placed_on` は date 型(日単位)なので、同じ日の行は第1キーだけでは決まらない。
 */
const manifest: Manifest = {
  app: {
    id: "same-day-order",
    name: "同じ日の並び順",
    tables: [
      {
        id: "orders",
        name: "注文",
        fields: [
          { id: "label", name: "見出し", type: "text", required: true },
          { id: "placed_on", name: "注文日", type: "date" },
        ],
      },
    ],
    views: [{ id: "order-list", type: "list_view", table: "orders", columns: ["label"] }],
  },
};

/**
 * 作った順に A / B / C / D / E。C だけ前日(2026-08-01)で、残り4件は同じ日である。
 *
 * 審査の実測(§4-2-1)と1文字も違わない並びにしてある ——
 * 今日(第2キー無し)の `placed_on desc` は `A B D E C`、
 * 第2キーを `desc` にすると `E D B A C` になる、というものである。
 */
const rows = [
  { label: "A", placed_on: "2026-08-02" },
  { label: "B", placed_on: "2026-08-02" },
  { label: "C", placed_on: "2026-08-01" },
  { label: "D", placed_on: "2026-08-02" },
  { label: "E", placed_on: "2026-08-02" },
];

let dataRoot: string;
let store: KernelMetaStore;
let db: Database;
let source: ReadSource;

function unwrap<T>(result: { ok: true; value: T } | { ok: false; errors: ValidationError[] }): T {
  if (!result.ok) {
    throw new Error(`期待に反して失敗しました: ${JSON.stringify(result.errors)}`);
  }
  return result.value;
}

/** SQL 経路(`listRecords`)で並べ、見出しだけを取り出す。 */
function labels(sort?: Sort | Sort[]): string[] {
  const options = sort === undefined ? {} : { sort };
  return unwrap(listRecords(db, manifest, "orders", options)).map((row) => String(row.label));
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-sort-tiebreak-"));
  store = KernelMetaStore.open(dataRoot);
  db = new Database(":memory:");
  applyManifestDdl(db, manifest);
  source = { dataRoot, appDb: () => db };
  for (const row of rows) {
    unwrap(createRecord(db, manifest, "orders", row));
  }
  // `_created_at` は同一ミリ秒になりうるので、**日単位で確実に差がつく値**へ書き換える。
  // (同一ミリ秒だと第2キーが `_id`(ランダム UUID)で決まってしまい、検査が揺れる。
  //  `flaky-workflow-runner-ran-at` と同じ落とし穴である。)
  const ids = db.query("SELECT _id FROM orders ORDER BY rowid").all() as { _id: string }[];
  ids.forEach((row, index) => {
    db.query("UPDATE orders SET _created_at = ?, _updated_at = ? WHERE _id = ?").run(
      `2026-08-02T00:0${index}:00.000Z`,
      `2026-08-02T00:0${index}:00.000Z`,
      row._id,
    );
  });
});

afterEach(async () => {
  store.close();
  db.close();
  await rm(dataRoot, { recursive: true, force: true });
});

// --- 完了条件5: `sort` 無しの一覧を1バイトも変えない ------------------------------

describe("`sort` を1つも宣言していない一覧(**変えてはならない**)", () => {
  test("今日すでに固定されている `_created_at ASC, _id ASC` のままである", () => {
    expect(labels()).toEqual(["A", "B", "C", "D", "E"]);
  });
});

// --- 完了条件3: 向きを決める(審査の実測を使う)-----------------------------------

describe("宣言した `sort` が同値になった行の並び(SQL 経路)", () => {
  test("`placed_on desc`: 同じ日の中が**新しい順**になる(審査の desc 実測と一致する)", () => {
    expect(labels([{ field: "placed_on", order: "desc" }])).toEqual(["E", "D", "B", "A", "C"]);
  });

  test("`placed_on asc`: 同じ日の中は**作った順**のままである(向きは宣言に従う)", () => {
    expect(labels([{ field: "placed_on", order: "asc" }])).toEqual(["C", "A", "B", "D", "E"]);
  });

  test("単数オブジェクト表記でも同じ結果になる", () => {
    expect(labels({ field: "placed_on", order: "desc" })).toEqual(["E", "D", "B", "A", "C"]);
  });

  test("向きは**最後の**キーに従う(第1キーが asc でも最後が desc なら desc)", () => {
    // placed_on asc → C(08-01) が先。08-02 の {A,B,D,E} は label が全部違うので
    // 第2キー(label desc)で E D B A に決まり、第3キー(= 継ぎ足し)は効かない。
    expect(
      labels([
        { field: "placed_on", order: "asc" },
        { field: "label", order: "desc" },
      ]),
    ).toEqual(["C", "E", "D", "B", "A"]);
  });
});

// --- 継ぎ足しの重複回避 -----------------------------------------------------------

describe("宣言が既にシステム列を含むときは二重に継ぎ足さない", () => {
  test("`_created_at asc` を明示したら、その向きが勝つ(desc で上書きしない)", () => {
    expect(
      labels([
        { field: "placed_on", order: "desc" },
        { field: "_created_at", order: "asc" },
      ]),
    ).toEqual(["A", "B", "D", "E", "C"]);
  });

  test("`_id` を明示した宣言でも結果が壊れない", () => {
    const byId = labels([
      { field: "placed_on", order: "desc" },
      { field: "_created_at", order: "desc" },
      { field: "_id", order: "desc" },
    ]);
    expect(byId).toEqual(["E", "D", "B", "A", "C"]);
  });
});

// --- 完了条件: システムテーブルの投影でも一致 ------------------------------------------

describe("システムテーブルの投影(副問合せ)でも同じ既定が効く", () => {
  beforeEach(() => {
    store.registerApp({
      app_id: "book-tracker",
      name: "蔵書管理",
      created_at: "2026-07-01T00:00:00.000Z",
    });
    store.registerApp({ app_id: "expenses", name: "経費", created_at: "2026-07-02T00:00:00.000Z" });
    store.appendChangelog({
      app_id: "book-tracker",
      diff_id: "d-001",
      intent: "1本目",
      operations: [],
      applied_at: "2026-07-03T00:00:00.000Z",
    });
    store.appendChangelog({
      app_id: "expenses",
      diff_id: "d-002",
      intent: "2本目",
      operations: [],
      applied_at: "2026-07-04T00:00:00.000Z",
    });
    store.appendChangelog({
      app_id: "book-tracker",
      diff_id: "d-003",
      intent: "3本目",
      operations: [],
      applied_at: "2026-07-05T00:00:00.000Z",
      kind: "undo",
      undo_target_seq: 1,
    });
  });

  test("`kind desc` で同値になる2行が `_created_at desc` で決まる", () => {
    // kind: undo(seq3) → apply(seq1, seq2)。apply の2行は第1キーだけでは決まらない。
    // 継ぎ足しが効けば `_created_at desc` = seq2(07-04) → seq1(07-03) になる。
    const rowsRead = unwrap(
      readRecordList(source, manifest, "_changelog", { sort: { field: "kind", order: "desc" } }),
    );
    expect(rowsRead.map((row) => row.seq)).toEqual([3, 2, 1]);
  });

  test("`kind asc` なら同値の2行は `_created_at asc` で決まる", () => {
    const rowsRead = unwrap(
      readRecordList(source, manifest, "_changelog", { sort: { field: "kind", order: "asc" } }),
    );
    expect(rowsRead.map((row) => row.seq)).toEqual([1, 2, 3]);
  });
});
