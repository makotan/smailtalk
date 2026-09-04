/**
 * 「持ち主ごとに1行」を宣言する —— 既存キー `unique` の値域に1語(`"owner"`)を足す
 * (`V4-M10-T07`。**`ADR-0078` = `V4-M7` 単位4 の限定採用。限定表10点**)。
 *
 * 目的(`ADR-0078` §S1 逐語): **「同じ持ち主の中で1行だけ、という制約を宣言したい。」**
 *
 * **この検査が固定するのは限定表の内側だけである**(`docs/adr/0078-owner-scoped-unique.md` §3):
 *
 * | 限定 | ここで固定するもの |
 * |---|---|
 * | 1 | **`$defs/field` にキーを1つも足さない**(本 ADR 由来の増分が0であること) |
 * | 2 | **スコープは `st_owner` の1つだけ**。**列名を書ける形にしない**(値域は有限の列挙) |
 * | 3 | `diff.schema.json` の `field_changes.unique` の値域も同じだけ広がる(既存フィールドに後付けできる) |
 * | 4 | **DDL に UNIQUE インデックスを1つも足さない** |
 * | 5 | **後付け時に既存重複があれば差分全体を拒否する**(部分適用しない) |
 * | 6 / 7 | **形式・範囲・整数を射程に含めない**(`pattern` / `format` / `min` / `max` / `integer` を足さない) |
 * | 8 | `src/kernel/` の公開 export を1つも増やさない(`kernel-export-drift` が別に見る) |
 * | 10 | **共有行(`st_owner` が空)の扱いを実装が1つ決め、検査で固定する** |
 *
 * ## `V4-M10-T07` 完了条件6 の決定(**審査は決めていない。実装が決めた**)
 *
 * > **共有行(`st_owner` が `null` / 空文字)も1つのスコープとして扱い、その中で一意にする。**
 *
 * **理由**: 「誰のものでもない」もスコープの1つである、と読むほうが規則が1本で済む。
 * **`null` と空文字は同じスコープに畳む**(`isSharedOwner` と同じ共有センチネルの読み)。
 * **採らなかった案**: 共有行だけ検査対象外にする(= 何行でも許す)。**採らなかった理由は、
 * 「宣言したのに効かない行がある」という形になり、`ADR-0061` §限界3 が承知で作った穴を
 * 一意制約の側で作り直すことになるためである。**
 *
 * ## この検査が言わないこと(誇張しない)
 *
 * - **TOCTOU の窓は1ミリも閉じない**(限定9)。**`ADR-0038` §限界1 の窓はそのまま残る。**
 * - **`E-G36`(形式・範囲・整数)は1ミリも解けない**(限定6 / 限定7)。
 * - **`st_owner` を持たない表で `unique: "owner"` を書くと、スコープが1つ(共有)しか無いので
 *   テーブル全体の一意と同じ挙動になる。** **`ADR-0078` の限定表はこの場合を1行も定めていない
 *   ので、拒否する検査を新設していない**(限定8 の逐語「検査は `hasDuplicateValue` の中に
 *   閉じる」)。**下の (h) が実測で固定する。**
 */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDiff, applyManifest, createApp, KernelMetaStore } from "./index.ts";
import { createRecord, updateRecord } from "./records.ts";
import type { Manifest } from "./types.ts";

const SCHEMA_DIR = join(import.meta.dir, "..", "..", "schemas");

function readSchema(name: string): {
  $defs: Record<string, { properties?: Record<string, unknown> }>;
} {
  return JSON.parse(readFileSync(join(SCHEMA_DIR, name), "utf-8")) as {
    $defs: Record<string, { properties?: Record<string, unknown> }>;
  };
}

// --- (a) 増分の総量(限定1 / 限定2 / 限定3)-------------------------------------------

test("限定1: $defs/field.properties は 11 で、本 ADR の増分は0キーである", () => {
  // **9キー目は `ADR-0076`(`writable_by`)が、10キー目は `ADR-0086`(`unit`。
  // `V4-M10-T46`)が足した分である。** **`ADR-0078` の増分は今日も0キーである。**
  // **【V4-M16-T10 / `P-G28` + `P-G22` / `ADR-0090` 限定1 による更新】** **11キー目
  // (`emphasis`)が門A を通って加わったので件数を 10 → 11 にした。**
  // **`ADR-0078` の増分は今日も0キーである** —— 本 ADR は `unique` の**値域**を
  // 1語広げただけで、キーは1つも足していない。
  // **【V4-M19-T07 / ADR-0119 限定1 で 11 → 12 に更新した】** 12キー目 `hide_when_empty`
  // (値が無いとき行ごと出さない)が門A を通って増えた(V4-M19 単位E-a。2回目の審査。
  // 判定 = 限定採用)。**`ADR-0078` の増分は今日も0キーである。****本 ADR の増分ではない。**
  // **【V6-M1-T01 / K-G1 / ADR-0288 限定1 で 12 → 13 に更新した】** 13キー目 `reference_picker`
  // (他のテーブルから選ぶ項目の選び方)が門A を通って増えた(V6-M0 単位A。判定 = 限定採用)。
  // **`ADR-0078` の増分は今日も0キーである。****本 ADR の増分ではない。**
  // **【`V6-M3-T02` / `K-G7` / `ADR-0290` 限定1 で 13 → 14 に更新した】** 14キー目
  // `reference_search_fields`(参照候補の「探せる項目」の、項目ごとの上書き)が門A を通って
  // 増えた(`V6-M0` 単位B。判定 = 限定採用)。**`reference` 型にだけ書けるキーである。**
  // **本 ADR の増分ではない。**
  expect(
    Object.keys(readSchema("manifest.schema.json").$defs.field?.properties ?? {}),
    // **【`V8-M20-T01` / 台帳 `J-G27` / `J-G28` / 手続きは `ADR-0301` で 14 → 12 に更新した】**
    // 8キー目だった `audience`(この項目を見せる相手)と9キー目だった `writable_by`(この項目を
    // 書ける相手)が**2本とも廃止された**(判定 = 廃止)。**代わりに担うのは `app.roles[].rules` の
    // 「役割 × 対象(項目)× 読取 / 書込」である。****旧値の逐語は 14。**
  ).toHaveLength(12);
});

test("限定2: unique の値域は有限の列挙で、列名を書ける形になっていない", () => {
  const unique = readSchema("manifest.schema.json").$defs.field?.properties?.unique as {
    enum?: unknown[];
  };
  expect(unique.enum).toEqual([true, false, "owner"]);
});

test("限定3: diff.schema.json の field_changes.unique も同じ定義を指している", () => {
  const unique = readSchema("diff.schema.json").$defs.field_changes?.properties?.unique as {
    $ref?: string;
  };
  expect(unique.$ref).toBe(
    "https://smailtalk.dev/schemas/manifest.schema.json#/$defs/field/properties/unique",
  );
});

test("限定6 / 限定7: $defs/field に pattern / format / min / max / integer が1つも無い", () => {
  const keys = Object.keys(readSchema("manifest.schema.json").$defs.field?.properties ?? {});
  for (const forbidden of ["pattern", "format", "min", "max", "minimum", "maximum", "integer"]) {
    expect(keys).not.toContain(forbidden);
  }
});

// --- 本物の SQLite でのふるまい ---------------------------------------------------------

const APP_ID = "osu-app";

function manifest(uniqueOnEmail: boolean | "owner", withOwner = true): Manifest {
  const fields: Record<string, unknown>[] = [
    { id: "email", name: "メール", type: "text", unique: uniqueOnEmail },
    { id: "memo", name: "メモ", type: "text" },
  ];
  if (withOwner) {
    fields.push({ id: "st_owner", name: "所有者", type: "text" });
  }
  return {
    app: {
      id: APP_ID,
      name: "所有者スコープ一意",
      tables: [{ id: "member", name: "会員", fields: fields as never }],
      views: [{ id: "member-list", type: "list_view", table: "member", columns: ["email"] }],
    },
  } as unknown as Manifest;
}

function withApp<T>(m: Manifest, fn: (ctx: { dataRoot: string; db: Database }) => T): T {
  const dataRoot = mkdtempSync(join(tmpdir(), "gp-osu-"));
  try {
    const store = KernelMetaStore.open(dataRoot);
    try {
      createApp(store, "所有者スコープ一意", { app_id: APP_ID });
    } finally {
      store.close();
    }
    expect(applyManifest(dataRoot, APP_ID, m).valid).toBe(true);
    const db = new Database(join(dataRoot, "apps", APP_ID, "app.sqlite"));
    try {
      return fn({ dataRoot, db });
    } finally {
      db.close();
    }
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

// --- (b) 所有者ごとの一意が効く ---------------------------------------------------------

test('unique: "owner" —— 同じ持ち主の中では2件目が拒否される', () => {
  const m = manifest("owner");
  withApp(m, ({ db }) => {
    expect(createRecord(db, m, "member", { email: "a@example.com", st_owner: "u1" }).ok).toBe(true);
    const second = createRecord(db, m, "member", { email: "a@example.com", st_owner: "u1" });
    expect(second.ok).toBe(false);
  });
});

test('unique: "owner" —— 持ち主が違えば同じ値を持てる(これが目的である)', () => {
  const m = manifest("owner");
  withApp(m, ({ db }) => {
    expect(createRecord(db, m, "member", { email: "a@example.com", st_owner: "u1" }).ok).toBe(true);
    expect(createRecord(db, m, "member", { email: "a@example.com", st_owner: "u2" }).ok).toBe(true);
  });
});

test("unique: true —— テーブル全体の一意は今日と1バイトも変わらない(後方互換)", () => {
  const m = manifest(true);
  withApp(m, ({ db }) => {
    expect(createRecord(db, m, "member", { email: "a@example.com", st_owner: "u1" }).ok).toBe(true);
    // **持ち主が違っても拒否される** —— `unique: true` の意味は1ミリも動いていない。
    expect(createRecord(db, m, "member", { email: "a@example.com", st_owner: "u2" }).ok).toBe(
      false,
    );
  });
});

test('unique: "owner" —— null(未設定)の値は今日どおり複数許す(ADR-0038 限定5)', () => {
  const m = manifest("owner");
  withApp(m, ({ db }) => {
    expect(createRecord(db, m, "member", { st_owner: "u1", memo: "1" }).ok).toBe(true);
    expect(createRecord(db, m, "member", { st_owner: "u1", memo: "2" }).ok).toBe(true);
  });
});

test('unique: "owner" —— 更新は自分の行を除外する(同じ値のまま更新できる)', () => {
  const m = manifest("owner");
  withApp(m, ({ db }) => {
    const created = createRecord(db, m, "member", { email: "a@example.com", st_owner: "u1" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.value._id as string;
    expect(updateRecord(db, m, "member", id, { email: "a@example.com", memo: "x" }).ok).toBe(true);
  });
});

test('unique: "owner" —— 更新でも他人の行とは衝突せず、自分の別の行とは衝突する', () => {
  const m = manifest("owner");
  withApp(m, ({ db }) => {
    const mine = createRecord(db, m, "member", { email: "a@example.com", st_owner: "u1" });
    const other = createRecord(db, m, "member", { email: "b@example.com", st_owner: "u2" });
    const second = createRecord(db, m, "member", { email: "c@example.com", st_owner: "u1" });
    expect(mine.ok && other.ok && second.ok).toBe(true);
    if (!(mine.ok && other.ok && second.ok)) return;
    // 他人の値と同じにするのは通る。
    expect(
      updateRecord(db, m, "member", second.value._id as string, { email: "b@example.com" }).ok,
    ).toBe(true);
    // 自分の別の行の値と同じにするのは拒否される。
    expect(
      updateRecord(db, m, "member", second.value._id as string, { email: "a@example.com" }).ok,
    ).toBe(false);
  });
});

// --- (c) 完了条件6 の決定: 共有行(`st_owner` が空)の扱い ------------------------------

test("完了条件6: 共有行(st_owner が空)も1つのスコープであり、その中で一意になる", () => {
  const m = manifest("owner");
  withApp(m, ({ db }) => {
    expect(createRecord(db, m, "member", { email: "a@example.com" }).ok).toBe(true);
    // 2件目は同じ「共有」スコープなので拒否される。
    expect(createRecord(db, m, "member", { email: "a@example.com" }).ok).toBe(false);
  });
});

test("完了条件6: null と空文字は同じ共有スコープに畳まれる", () => {
  const m = manifest("owner");
  withApp(m, ({ db }) => {
    expect(createRecord(db, m, "member", { email: "a@example.com", st_owner: null }).ok).toBe(true);
    expect(createRecord(db, m, "member", { email: "a@example.com", st_owner: "" }).ok).toBe(false);
  });
});

test("完了条件6: 共有行と、持ち主のある行は別のスコープである", () => {
  const m = manifest("owner");
  withApp(m, ({ db }) => {
    expect(createRecord(db, m, "member", { email: "a@example.com" }).ok).toBe(true);
    expect(createRecord(db, m, "member", { email: "a@example.com", st_owner: "u1" }).ok).toBe(true);
  });
});

// --- (h) `st_owner` を持たない表(限定表が定めていない場合。実測で固定する)---------------

test('(限定表の外)st_owner を持たない表の unique: "owner" は、テーブル全体の一意と同じになる', () => {
  // **`ADR-0078` の限定表はこの場合を1行も定めていない。** **拒否する検査を新設していない
  // のは、限定8 の逐語「検査は `hasDuplicateValue`(既存の非 export 関数)の中に閉じる」に
  // 従ったためである。** **塞いでいないので実測で固定する**(`row-delete-protection.test.ts`
  // の `(穴)` と同じ作法)。
  const m = manifest("owner", false);
  withApp(m, ({ db }) => {
    expect(createRecord(db, m, "member", { email: "a@example.com" }).ok).toBe(true);
    expect(createRecord(db, m, "member", { email: "a@example.com" }).ok).toBe(false);
  });
});

// --- (d) 限定5: 後付け時に既存重複があれば差分全体を拒否する ------------------------------

test('限定5: change_field で unique を "owner" にする後付けは、同じ持ち主の重複があれば差分全体を拒否する', () => {
  const m = manifest(false);
  withApp(m, ({ dataRoot, db }) => {
    expect(createRecord(db, m, "member", { email: "a@example.com", st_owner: "u1" }).ok).toBe(true);
    expect(createRecord(db, m, "member", { email: "a@example.com", st_owner: "u1" }).ok).toBe(true);
    db.close();
    const applied = applyDiff(dataRoot, APP_ID, {
      diff_id: "osu-1",
      intent: "会員のメールを持ち主ごとに一意にする",
      operations: [
        { op: "change_field", table: "member", field: "email", changes: { unique: "owner" } },
      ],
    });
    expect(applied.valid).toBe(false);
  });
});

test("限定5: 持ち主が違う同値は「重複」ではないので、後付けが通る(これが unique: true との違いである)", () => {
  const m = manifest(false);
  withApp(m, ({ dataRoot, db }) => {
    expect(createRecord(db, m, "member", { email: "a@example.com", st_owner: "u1" }).ok).toBe(true);
    expect(createRecord(db, m, "member", { email: "a@example.com", st_owner: "u2" }).ok).toBe(true);
    db.close();
    const scoped = applyDiff(dataRoot, APP_ID, {
      diff_id: "osu-2",
      intent: "会員のメールを持ち主ごとに一意にする",
      operations: [
        { op: "change_field", table: "member", field: "email", changes: { unique: "owner" } },
      ],
    });
    expect(scoped.valid).toBe(true);
  });
});

test("限定5: 同じデータに unique: true を後付けすると拒否される(スコープの違いが効いている)", () => {
  const m = manifest(false);
  withApp(m, ({ dataRoot, db }) => {
    expect(createRecord(db, m, "member", { email: "a@example.com", st_owner: "u1" }).ok).toBe(true);
    expect(createRecord(db, m, "member", { email: "a@example.com", st_owner: "u2" }).ok).toBe(true);
    db.close();
    const whole = applyDiff(dataRoot, APP_ID, {
      diff_id: "osu-3",
      intent: "会員のメールをテーブル全体で一意にする",
      operations: [
        { op: "change_field", table: "member", field: "email", changes: { unique: true } },
      ],
    });
    expect(whole.valid).toBe(false);
  });
});

test('限定3: 後付けした unique: "owner" は適用後マニフェストに残る(黙って落ちない)', () => {
  const m = manifest(false);
  withApp(m, ({ dataRoot, db }) => {
    db.close();
    const applied = applyDiff(dataRoot, APP_ID, {
      diff_id: "osu-4",
      intent: "会員のメールを持ち主ごとに一意にする",
      operations: [
        { op: "change_field", table: "member", field: "email", changes: { unique: "owner" } },
      ],
    });
    expect(applied.valid).toBe(true);
    const stored = JSON.parse(
      readFileSync(join(dataRoot, "apps", APP_ID, "manifest.json"), "utf-8"),
    ) as { app: { tables: { fields: Record<string, unknown>[] }[] } };
    expect(stored.app.tables[0]?.fields[0]?.unique).toBe("owner");
  });
});

// --- (e) 限定4: DDL に UNIQUE インデックスを1つも足さない --------------------------------

test("限定4: DDL に UNIQUE インデックスが1つも作られない", () => {
  const m = manifest("owner");
  withApp(m, ({ db }) => {
    const indexes = db
      .query<{ sql: string | null }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'member'",
      )
      .all();
    expect(indexes.filter((row) => (row.sql ?? "").toUpperCase().includes("UNIQUE"))).toEqual([]);
    const tableSql =
      db
        .query<{ sql: string }, []>(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'member'",
        )
        .get()?.sql ?? "";
    expect(tableSql.toUpperCase()).not.toContain("UNIQUE");
  });
});

// --- (f) 値域の外は書けない -------------------------------------------------------------

test("限定2: unique に列名や任意の文字列は書けない", () => {
  for (const bad of ["st_owner", "email", "owner_id", ["email", "st_owner"]]) {
    const m = manifest(bad as never);
    const dataRoot = mkdtempSync(join(tmpdir(), "gp-osu-bad-"));
    try {
      const store = KernelMetaStore.open(dataRoot);
      try {
        createApp(store, "所有者スコープ一意", { app_id: APP_ID });
      } finally {
        store.close();
      }
      expect(applyManifest(dataRoot, APP_ID, m).valid, JSON.stringify(bad)).toBe(false);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  }
});
