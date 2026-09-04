/**
 * `apps/smailtalk/schemas/` の姿が動いたら**名指しで**赤くなる見張り
 * (`V10-M10-T03` / `CM-G3` / `ADR-0366` / `ADR-0373`)。
 *
 * 上位: `docs/adr/0366-comment-store-and-anchor.md`(`CM-G1` 限定2 = `:116`)/
 *       `docs/adr/0373-comment-anchor-eleven-forms.md`(§Decision 2 の #6)。
 *
 * ## これは「`schemas/` は永遠に変わらない」を固定する検査ではない
 *
 * 起票の本文は本検査を「**`CM-G3` 限定2 の機械化**」と呼ぶが、**`ADR-0366` の `CM-G3` 限定2 は
 * 「`SYSTEM_TABLES` に投影しない」であって `schemas/` の話ではない**(`ADR-0366:141`)。
 * **`schemas/` を1バイトも変えない、と書いているのは `CM-G1` 限定2 である**(`ADR-0366:116`)。
 * **そしてその `CM-G1` 限定2 は、`ADR-0373` §Decision 2 の #6 が正面から破った** ——
 * `ADR-0371` が `manifest.schema.json` に名札を3箇所入れている。
 *
 * **したがって本検査が固定するのは「今日の姿」であって「変えてはならない」ではない。**
 * 形は `scripts/kernel-export-drift.test.ts` / `scripts/vocabulary-drift.test.ts` /
 * `scripts/kernel-import-drift.test.ts` の3本に倣い、**基準はファイル**(`schemas-snapshot.txt`)、
 * **判定は増えた名前・減った名前・並びの食い違いを名指しで**出す。
 *
 * ## 赤くなったら何をするか
 *
 * **`scripts/schemas-snapshot.txt` を更新する前に、増えた/減ったキーが `ADR-0007` の門A を
 * 通ったかを審査すること。** **審査より先に更新してはならない。** 更新するだけで緑になるので、
 * それをやると本検査は「動いたことに気づく」機能を失う。
 * **機械化したのは検出であって審査ではない。**
 *
 * ## 数値を1つも焼き込まない(`ADR-0250` §Decision 7 の線2)
 *
 * **本ファイルには件数のリテラルが1つも無い。** 本数は一覧から導く。
 * 基準の持ち方は **sha256 + バイト長 + 名前と順序**であり、
 * 「`$defs` が30本」「`view.properties` が31本」といった数は**どこにも書かない。**
 * (このリポジトリには、手で書いた配列の見張りが 9,182件 を全部緑にしたまま素通りを
 *  許した実績がある。数と配列を手で持たないのはその先例による。)
 *
 * ## この検査の限界(先に書く。憲法6)
 *
 * 1. **一覧の更新は人間が行う。** 「赤くなったので更新した」だけで通せる
 *    (`kernel-export-drift.test.ts` / `vocabulary-drift.test.ts` と同じ既存の穴。
 *     本検査が新しく作る穴ではないが、塞いでもいない)。
 * 2. **`$defs` の中身の意味**(型・`enum` の値・`additionalProperties` の真偽・`$comment` の文面)
 *    **を名前としては1つも見ない。** そこを拾うのは (sd2) の sha256 であり、
 *    **sha256 は「何が変わったか」を1文字も名指ししない。**
 * 3. **`schemas/` の外を1バイトも読まない。** スキーマを読む側(`validate.ts` ほか)が
 *    追随しているかは1ミリも見ない。
 * 4. **`$defs` の第2階層より下を辿らない。** 見るのは `$defs` の直下の名前と、
 *    `manifest` 側の `$defs/view.properties` / `diff` 側の `$defs/view_changes.properties` の
 *    2箇所だけである。**それより内側の名前は `scripts/vocabulary-drift.test.ts` の持ち物である。**
 */

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * 走査の根。**cwd に依存させない**(`kernel-import-drift.test.ts:71` と同じ形)。
 * `dirname(import.meta.dir)` は `apps/smailtalk` であり、公開単位の外へは1段も出ない。
 */
const UNIT_ROOT = dirname(import.meta.dir);
const SCHEMAS_DIR = join(UNIT_ROOT, "schemas");
const SNAPSHOT_PATH = join(import.meta.dir, "schemas-snapshot.txt");

type JsonNode = {
  $defs?: Record<string, JsonNode>;
  properties?: Record<string, unknown>;
};

/** `schemas/` に在る `.json` の名前。**辞書順**(ファイルシステムの列挙順に依存させない)。 */
function schemaFileNames(): string[] {
  return readdirSync(SCHEMAS_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

function readSchemaBytes(fileName: string): Buffer {
  return readFileSync(join(SCHEMAS_DIR, fileName));
}

function parseSchema(fileName: string): JsonNode {
  return JSON.parse(readSchemaBytes(fileName).toString("utf-8")) as JsonNode;
}

/** (sd1) ファイル一覧の節。 */
function fileLines(): string[] {
  return schemaFileNames().map((name) => `files:${name}`);
}

/** (sd2) バイト列の節。**長さと sha256 の両方を持つ**(片方だけでは衝突と切り詰めを分けられない)。 */
function byteLines(): string[] {
  const lines: string[] = [];
  for (const name of schemaFileNames()) {
    const bytes = readSchemaBytes(name);
    lines.push(`${name}:bytes:${bytes.byteLength}`);
    lines.push(`${name}:sha256:${createHash("sha256").update(bytes).digest("hex")}`);
  }
  return lines;
}

/**
 * 名前を**宣言順のまま**並べる。**ソートしない。**
 * `Object.keys()` は JSON の出現順を保つので、スキーマのキーの並びがそのまま出る。
 */
function defLines(fileName: string, viewDefName: string): string[] {
  const schema = parseSchema(fileName);
  const defs = schema.$defs ?? {};
  const lines: string[] = [];
  for (const defName of Object.keys(defs)) {
    lines.push(`${fileName}:$defs:${defName}`);
  }
  const target = defs[viewDefName];
  for (const key of Object.keys(target?.properties ?? {})) {
    lines.push(`${fileName}:$defs/${viewDefName}.properties:${key}`);
  }
  return lines;
}

function manifestLines(): string[] {
  return defLines("manifest.schema.json", "view");
}

function diffLines(): string[] {
  return defLines("diff.schema.json", "view_changes");
}

/** 空行と `#` 始まりを捨てる。形は `scripts/vocabulary-snapshot.txt` に倣う。 */
function readSnapshot(): string[] {
  return readFileSync(SNAPSHOT_PATH, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/** 一覧のうち、この節に属する行だけを、一覧に書かれた順のまま返す。 */
function snapshotSection(predicate: (line: string) => boolean): string[] {
  return readSnapshot().filter(predicate);
}

type Drift = {
  /** 実物にあって一覧に無い名前(= 増えた側) */
  added: string[];
  /** 一覧にあって実物に無い名前(= 減った側) */
  removed: string[];
  /** 名前の集合は同じだが並びが違う位置 */
  misordered: string[];
};

/** 差が1つも無いときの値。**この検査の唯一の期待値であり、数値を1つも含まない。** */
const NO_DRIFT: Drift = { added: [], removed: [], misordered: [] };

/**
 * **両向き・順序ごと**に突き合わせる(`vocabulary-drift.test.ts` の `drift()` と同型)。
 *
 * **`misordered` は名前の集合が一致しているときだけ埋める** —— 1件足しただけで以降の位置が
 * 全部ずれ、増えた1件が位置ずれに埋もれるためである。集合が食い違うときは `added` /
 * `removed` が名指しで出るので、検出そのものは1件も落ちない。
 */
function drift(actual: string[], snapshot: string[]): Drift {
  const snapshotSet = new Set(snapshot);
  const actualSet = new Set(actual);
  const added = actual.filter((name) => !snapshotSet.has(name));
  const removed = snapshot.filter((name) => !actualSet.has(name));
  const setsAgree = ![...added, ...removed].some(() => true);
  return {
    added,
    removed,
    misordered: setsAgree
      ? actual
          .map((name, index) =>
            name === snapshot[index]
              ? ""
              : `[${index}] 実物=${name} / 一覧=${snapshot[index] ?? "(無し)"}`,
          )
          .filter((entry) => entry !== "")
      : [],
  };
}

test("(sd1) apps/smailtalk/schemas/ のファイル一覧がスナップショットと一致する(3本目を足したら赤)", () => {
  expect(
    drift(
      fileLines(),
      snapshotSection((line) => line.startsWith("files:")),
    ),
  ).toEqual(NO_DRIFT);
});

test("(sd2) 2ファイルのバイト列(sha256 と長さ)がスナップショットと一致する(1バイトでも動けば赤)", () => {
  // **「差分が出たら赤くなる」の本体。** 名前として現れない変更(型・enum の値・
  // `$comment` の文面・空白1つ)はここでしか捕まらない。
  // **代償**: sha256 は「何が変わったか」を1文字も名指ししない(限界2)。
  expect(
    drift(
      byteLines(),
      snapshotSection((line) => line.includes(":bytes:") || line.includes(":sha256:")),
    ),
  ).toEqual(NO_DRIFT);
});

test("(sd3) manifest.schema.json の $defs と $defs/view.properties が、名前も順序もスナップショットと一致する", () => {
  expect(
    drift(
      manifestLines(),
      snapshotSection((line) => line.startsWith("manifest.schema.json:$defs")),
    ),
  ).toEqual(NO_DRIFT);
});

test("(sd4) diff.schema.json の $defs と $defs/view_changes.properties が、名前も順序もスナップショットと一致する", () => {
  expect(
    drift(
      diffLines(),
      snapshotSection((line) => line.startsWith("diff.schema.json:$defs")),
    ),
  ).toEqual(NO_DRIFT);
});

test("(sd5) 空の集合に対して緑にならない(検査が実際に読めていることの確認)", () => {
  // `kernel-import-drift.test.ts` の3本目と同じ手口。**件数では確かめない**
  // (件数を書いた時点で焼き込みになる)。**名前で確かめる。**
  const actual = [...fileLines(), ...byteLines(), ...manifestLines(), ...diffLines()];
  expect(actual).toContain("files:manifest.schema.json");
  expect(actual).toContain("files:diff.schema.json");
  expect(actual).toContain("manifest.schema.json:$defs:view");
  expect(actual).toContain("manifest.schema.json:$defs/view.properties:columns");
  expect(actual).toContain("diff.schema.json:$defs:view_changes");
  expect(actual).toContain("diff.schema.json:$defs/view_changes.properties:columns");
  expect(readSnapshot()).toContain("files:manifest.schema.json");
  // 空の一覧を相手にしたら赤になる(= 一覧が空でも緑、という壊れ方をしない)。
  expect(drift(actual, [])).not.toEqual(NO_DRIFT);
  expect(drift([], actual)).not.toEqual(NO_DRIFT);
});

test("(sd6) 一覧に同じ行が2度出ていない(重複は片方が消えても気づけなくなる)", () => {
  const snapshot = readSnapshot();
  expect([...new Set(snapshot)]).toEqual(snapshot);
});
