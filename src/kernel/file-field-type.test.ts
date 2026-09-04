/**
 * 汎用の `file` フィールド型(`V5-M16-T01`。`G-G12` / `G-G13`。`ADR-0161` 限定1 / 限定3 / 限定4)。
 *
 * ## このファイルが固定すること(カーネル側)
 *
 * 1. **限定1**: 足すのは `FIELD_TYPES` に `"file"` 1つだけ(8 → 9)。
 *    **`RESOURCE_KINDS` / `DIFF_OPS` / `$defs` / `$defs/view.properties` / `$defs/field.properties`
 *    は1つも動かない。** **`_files` を流用し、2本目のファイルテーブルを作らない。**
 * 2. **限定3**: `file` 値は TEXT で、`_files` に実在する file_id を指す(`image` と同型)。
 *    存在しない file_id は 422 相当で落ちる。
 * 3. **限定4**: 多値を持たない —— **配列を書ける場所が schema に1つも無い。**
 * 4. **限定2**: `image` 型は1バイトも変わらない(`ALLOWED_IMAGE_MIME` / `MAX_UPLOAD_BYTES` /
 *    変換表の `image` 行列 / DDL の `image: TEXT`)。
 *
 * ## このファイルが証明しないこと(先に書く。誇張しない)
 *
 * - **アップロードの受理と配信は server 層の担当である**(`src/server/file-upload-general.test.ts` /
 *   `src/server/file-delivery-attachment.test.ts`)。ここは1件も見ていない。
 * - **表示層(web)がどう描くかは見ていない。**
 * - **`FIELD_TYPES` が9になったことを「語彙が1つ増えただけ」とは書かない**(`ADR-0007` §1a /
 *   `ADR-0161` §1 (a))—— 増えたのは「新しい項目の種類」「値の形」「受け入れる種別」
 *   「大きさの上限」「配信の可否」の5つの規則である。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { conversionVerdict } from "./convert.ts";
import { applyManifestDdl, sqliteTypeForFieldType } from "./ddl.ts";
import { createRecord } from "./records.ts";
import type { Manifest } from "./types.ts";
import { FIELD_TYPES } from "./types.ts";
import { validateManifest } from "./validate.ts";

const ROOT = dirname(dirname(import.meta.dir));

// biome-ignore lint/suspicious/noExplicitAny: スキーマ JSON を素で読むための局所エイリアス。
type Any = any;

function readSchema(name: string): Any {
  return JSON.parse(readFileSync(join(ROOT, "schemas", name), "utf8")) as Any;
}

// --- (a) 限定1: 増分の総量 ---------------------------------------------------------------

test("限定1: FIELD_TYPES は9要素で、9種目は file である", () => {
  expect(FIELD_TYPES).toHaveLength(9);
  expect(FIELD_TYPES).toContain("file");
  // 既存8種が1つも消えていない。
  expect([...FIELD_TYPES]).toEqual([
    "text",
    "long_text",
    "number",
    "boolean",
    "date",
    "select",
    "reference",
    "image",
    "file",
  ]);
});

// 【`V5-M29-T03` / `ADR-0250` 限定10 + 限定11】ここにあった test を、ブロックごと消した。
//   消したテスト名(逐語): 「限定1: RESOURCE_KINDS(7)と DIFF_OPS(16)は1つも動かない」
//   そのブロックが測っていたもの:
//     - `expect(RESOURCE_KINDS).toHaveLength(7)`
//     - `expect(DIFF_OPS).toHaveLength(17)`(行末の逐語: 「【`V5-M17b` / `ADR-0248`】16 → 17(`set_user_kinds` が17種目)。
//       **この行が固定していたのは「その決定が語彙を増やさなかったこと」であり、増やしたのは別の決定である。**」)
//   移し先は `scripts/vocabulary-drift.test.ts`(一覧の `RESOURCE_KINDS:` / `DIFF_OPS:` で始まる行)。
//   **`expect()` が1つも残らないので空の test を残さなかった**(空の test は緑を返し、
//   検出力0のまま `Ran` を水増しする)。
//   **テスト名が持っていた日本語の宣言は、ここでリポジトリから消える**(`ADR-0250` §Decision 5 の (4))。

test("限定1: $defs/field.properties のキー数は動かない", () => {
  const schema = readSchema("manifest.schema.json");
  // **着手前の実測値を焼き込む**(`V5-M16` 着手時 HEAD `c31ac07`)。
  // 【`V5-M29-T03` / `ADR-0250` 限定11】ここにあった「$defs の本数は 28 のままである」の検査は
  //   `scripts/vocabulary-drift.test.ts` へ移した(一覧の `manifest.$defs:` で始まる行)。
  //   **総量ではなく名前と順序で見張る。**
  //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
  // 【`V5-M29-T03` / `ADR-0250` 限定11】ここにあった「$defs/view.properties の本数は 28 のままである」の
  //   検査も `scripts/vocabulary-drift.test.ts` へ移した(一覧の `manifest.$defs.view.properties:` で始まる行)。
  //   **総量ではなく名前と順序で見張る。**
  //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
  // 【`V5-M29-T03`】**テスト名を書き換えた。** 旧: 「限定1: $defs の本数と $defs/view.properties / $defs/field.properties のキー数は動かない」。
  //   本体から前2つを測る `expect` が消えたため(記録 §4-7)。
  // **【V6-M1-T01 / K-G1 / ADR-0288 限定1 で 12 → 13 に更新した】** 13キー目 `reference_picker`
  // (他のテーブルから選ぶ項目の選び方)が門A を通って増えた(V6-M0 単位A。判定 = 限定採用)。
  // **reference 型にだけ書けるキーである。****本 ADR の増分ではない。**
  // **【`V6-M3-T02` / `K-G7` / `ADR-0290` 限定1 で 13 → 14 に更新した】** 14キー目
  // `reference_search_fields`(参照候補の「探せる項目」の、項目ごとの上書き)が門A を通って
  // 増えた(`V6-M0` 単位B。判定 = 限定採用)。**`reference` 型にだけ書けるキーである。**
  // **本 ADR の増分ではない。**
  // **【`V8-M20-T01` / 台帳 `J-G27` / `J-G28` / 手続きは `ADR-0301` で 14 → 12 に更新した】**
  // 8キー目だった `audience`(この項目を見せる相手)と9キー目だった `writable_by`(この項目を
  // 書ける相手)が**2本とも廃止された**(判定 = 廃止)。**代わりに担うのは `app.roles[].rules` の
  // 「役割 × 対象(項目)× 読取 / 書込」である。****旧値の逐語は 14。**
  expect(Object.keys(schema.$defs.field.properties)).toHaveLength(12);
});

test("限定1: manifest.schema.json の field_type.enum は FIELD_TYPES と1要素も違わない", () => {
  const schema = readSchema("manifest.schema.json");
  expect(schema.$defs.field_type.enum).toEqual([...FIELD_TYPES]);
});

// --- (b) 限定3: 値の形(TEXT / `_files` の実在制約)---------------------------------------

test("限定3: file の SQLite 列型は TEXT である(image と同型)", () => {
  expect(sqliteTypeForFieldType("file")).toBe("TEXT");
  // 限定2: image は1バイトも変わらない。
  expect(sqliteTypeForFieldType("image")).toBe("TEXT");
});

function fileManifest(): Manifest {
  return {
    app: {
      id: "docs-app",
      name: "書類",
      tables: [
        {
          id: "invoices",
          name: "請求書",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "attachment", name: "添付", type: "file" },
          ],
        },
      ],
      views: [],
    },
  };
}

function createFilesTable(database: Database): void {
  database.exec(
    'CREATE TABLE "_files" ("file_id" TEXT PRIMARY KEY, "sha256" TEXT NOT NULL, ' +
      '"mime" TEXT NOT NULL, "size" INTEGER NOT NULL, "filename" TEXT, "created_at" TEXT NOT NULL)',
  );
}

function seedFile(database: Database, fileId: string, mime: string): void {
  database
    .query(
      'INSERT INTO "_files" ("file_id", "sha256", "mime", "size", "filename", "created_at") ' +
        "VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(fileId, "b".repeat(64), mime, 10, "invoice.pdf", "2026-08-05T00:00:00.000Z");
}

let dir: string;
let db: Database;
let manifest: Manifest;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gp-file-field-"));
  db = new Database(join(dir, "app.sqlite"));
  manifest = fileManifest();
  applyManifestDdl(db, manifest);
  createFilesTable(db);
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

test("限定3: file 型のテーブルはマニフェスト検証を通る", () => {
  const result = validateManifest(manifest);
  expect(result.valid).toBe(true);
});

test("限定3: 実在する file_id は書ける(mime が画像でなくても書ける)", () => {
  seedFile(db, "file-pdf-1", "application/pdf");
  const created = createRecord(db, manifest, "invoices", {
    title: "8月分",
    attachment: "file-pdf-1",
  });
  expect(created.ok).toBe(true);
  if (created.ok) {
    expect(created.value.attachment).toBe("file-pdf-1");
  }
});

test("限定3: 存在しない file_id は落ちる(reference / image の実在確認と同型)", () => {
  seedFile(db, "file-pdf-1", "application/pdf");
  const result = createRecord(db, manifest, "invoices", {
    title: "8月分",
    attachment: "file-missing",
  });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.path).toBe("/attachment");
    expect(result.errors[0]?.message).toContain("file-missing");
    expect(result.errors[0]?.message).toContain("_files");
  }
});

test("限定3: 未設定(null / 省略)は通る", () => {
  const a = createRecord(db, manifest, "invoices", { title: "空", attachment: null });
  expect(a.ok).toBe(true);
  const b = createRecord(db, manifest, "invoices", { title: "省略" });
  expect(b.ok).toBe(true);
});

test("限定3: 文字列以外の値は型エラーで落ちる", () => {
  const result = createRecord(db, manifest, "invoices", { title: "数値", attachment: 123 });
  expect(result.ok).toBe(false);
});

// --- (c) 限定4: 多値を持たない -----------------------------------------------------------

test("限定4: file 型のフィールドに配列を書くと落ちる(1フィールド1ファイル)", () => {
  seedFile(db, "file-a", "application/pdf");
  seedFile(db, "file-b", "text/csv");
  const result = createRecord(db, manifest, "invoices", {
    title: "2つ",
    attachment: ["file-a", "file-b"] as unknown as string,
  });
  expect(result.ok).toBe(false);
});

test("限定4: schema の field には file 用の付帯キー(配列を書く場所)が1つも無い", () => {
  const schema = readSchema("manifest.schema.json");
  const keys = Object.keys(schema.$defs.field.properties);
  // `options`(select)/ `reference_table`(reference)以外に「複数値」を書けるキーが無い。
  expect(keys).not.toContain("files");
  expect(keys).not.toContain("file_table");
  expect(keys).not.toContain("multiple");
  expect(keys).not.toContain("accept");
});

// --- (d) 限定3: 変換不可(image と同型)--------------------------------------------------

test("限定3: file ⇄ 他型の変換は全部 impossible、file → file だけ possible", () => {
  for (const other of FIELD_TYPES) {
    if (other === "file") {
      continue;
    }
    expect(conversionVerdict("file", other)).toBe("impossible");
    expect(conversionVerdict(other, "file")).toBe("impossible");
  }
  expect(conversionVerdict("file", "file")).toBe("possible");
});

test("限定2: image の変換表は1バイトも変わっていない(image ⇄ 他型は impossible / 対角は possible)", () => {
  for (const other of FIELD_TYPES) {
    if (other === "image") {
      continue;
    }
    expect(conversionVerdict("image", other)).toBe("impossible");
    expect(conversionVerdict(other, "image")).toBe("impossible");
  }
  expect(conversionVerdict("image", "image")).toBe("possible");
});
