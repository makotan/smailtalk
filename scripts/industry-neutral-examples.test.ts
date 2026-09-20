/**
 * `V5-M14`(汎用化の軸・面5): **AI に渡す説明文・コメント・スキーマ注釈の例示が
 * 業種に偏らないこと**の検査。
 *
 * 上位: `docs/plan/v5/04-generalization-baseline.md` §4-5(`G-G15`〜`G-G19`)/
 *       `docs/plan/v5/records/v5-m12.md` §3-5(門A本審査)/
 *       `docs/adr/0162-schema-annotation-examples.md`(`G-G18`。限定7点)/
 *       `docs/adr/0163-kernel-comment-examples.md`(`G-G19`。限定7点)/
 *       `docs/plan/v5/records/v5-m14.md`(本タスクの実施記録)。
 *
 * ## この検査が測っているもの・測っていないもの(**先に書く。誇張しない**)
 *
 * - **測っているのは「審査が名指しした逐語が消え、差し替え後の逐語が実在し、その差し替え後の
 *   文に `FACE5_INDUSTRY_WORDS` が現れないこと」だけである。**
 * - **「説明文が業種に偏らなくなった」ことの証明ではない。** 字面を避けて書かれた業種前提は
 *   1件も拾えない(`ADR-0162` §5 の 1 / `ADR-0163` §5 の 2 が同じ限界を先に書いている)。
 * - **対象ファイル全体を走査していない。** 対象は下の `REPLACEMENTS` が名指しした逐語だけで
 *   ある。**残った出現の件数は `docs/plan/v5/records/v5-m14.md` §6-2 が実数で書く。**
 * - **意図して残した語は `keep` に書く。** **黙って除外しない** —— 残した語と理由が
 *   ここに現れる。
 *
 * ## 2026-08-05 `v5-merge-repair-1` で測り方を入れ替えた5本(**測らなくなったものを先に書く**)
 *
 * `V5-M21`(`L-G1` / `ADR-0171`。門A・判定 = 限定採用)のマージで、**下の5本が赤くなった。**
 * 5本とも**着手前(`f79b1b7`)のダイジェスト・件数を定数として焼き込み、今日の実物と直接
 * 比べる形**だったため、**「`V5-M14` が構造を変えなかったこと」ではなく「`V5-M14` 以後、誰も
 * 同じファイルを触っていないこと」を測っていた。** 対照表(`REPLACEMENTS`)を**逆に当てた姿**と
 * 今日の実物を比べる形に作り直した。**入れ替えた結果、次の5点はもう測っていない:**
 *
 * 1. `ADR-0162` 限定1 —— `schemas/manifest.schema.json` の構造が `f79b1b7` と同値であること。
 * 2. `ADR-0162` 限定2 —— 同ファイルの `$comment` / `description` の総数が `f79b1b7`(70 / 155)と同値であること。
 * 3. `ADR-0162` 限定3 —— 同ファイルの ADR 参照 65件 / 記号 42件という**件数**の同値。
 * 4. `ADR-0163` 限定1 —— `src/kernel/` 3ファイルの**実行される文**が `f79b1b7` と同値であること。
 * 5. `ADR-0163` 限定4 —— 同3ファイルの ADR 参照 63件という**件数**の同値。
 *
 * **記録**: [`docs/plan/v5/records/v5-merge-repair-1.md`](../docs/plan/v5/records/v5-merge-repair-1.md)。
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { REPLACEMENTS, type Replacement } from "./industry-neutral-examples.ts";
import { FACE5_INDUSTRY_WORDS, findIndustryWords } from "./industry-words.ts";

const ROOT = new URL("../", import.meta.url);
async function source(path: string): Promise<string> {
  return await Bun.file(new URL(path, ROOT).pathname).text();
}

// ---------------------------------------------------------------------------
// 差し替えの対照表(`ADR-0162` 限定4/5 / `ADR-0163` 限定5/6)
// ---------------------------------------------------------------------------

describe("面5: 審査が名指しした例示が差し替わっている", () => {
  for (const entry of REPLACEMENTS) {
    const label = `${entry.unit} ${entry.file}:${entry.line}`;

    test(`${label}: 着手前の逐語が1件も残っていない`, async () => {
      expect((await source(entry.file)).includes(entry.before), entry.before).toBe(false);
    });

    test(`${label}: 差し替え後の逐語が実在する`, async () => {
      expect((await source(entry.file)).includes(entry.after), entry.after).toBe(true);
    });

    test(`${label}: 差し替え後の文に業種依存語が無い(残すものは keep に書く)`, () => {
      expect(findIndustryWords(entry.after, FACE5_INDUSTRY_WORDS)).toEqual([...(entry.keep ?? [])]);
    });
  }

  test("`keep` を書いた行には必ず理由が付いている(黙って除外しない)", () => {
    for (const entry of REPLACEMENTS) {
      if (!entry.keep) continue;
      expect(entry.keepReason, `${entry.file}:${entry.line}`).toBeTruthy();
    }
  });

  test("5単位すべてに1件以上の差し替えがある", () => {
    const units = new Set(REPLACEMENTS.map((r) => r.unit));
    expect([...units].sort()).toEqual(["G-G15", "G-G16", "G-G17", "G-G18", "G-G19"]);
  });
});

// ---------------------------------------------------------------------------
// `ADR-0162`(`G-G18`)の限定7点 —— **限定ごとに1本ずつ**
// ---------------------------------------------------------------------------

const sha = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

function stripAnnotations(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripAnnotations);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(node as Record<string, unknown>).sort()) {
      if (key === "$comment" || key === "description") continue;
      out[key] = stripAnnotations((node as Record<string, unknown>)[key]);
    }
    return out;
  }
  return node;
}

function countKey(node: unknown, key: string): number {
  let found = 0;
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) {
      for (const item of x) walk(item);
      return;
    }
    if (x && typeof x === "object") {
      for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
        if (k === key) found += 1;
        walk(v);
      }
    }
  };
  walk(node);
  return found;
}

const setOf = (text: string, pattern: RegExp): string[] =>
  [...new Set(text.match(pattern) ?? [])].sort();

const ADR_REF = /ADR-[0-9]{4}/g;
const SYMBOL_REF = /\b[A-Z]+-G[0-9]+[a-z]?\b/g;

/**
 * **対照表を逆に当てる**(`after` → `before`)—— **今日のファイルから「`V5-M14` が差し替える前の姿」を作る。**
 *
 * ## なぜこれが要るのか(**`v5-merge-repair-1` で入れ替えた。黙って差し替えていない**)
 *
 * 着手当初、限定1〜3(および `ADR-0163` 限定1 / 限定4)は **着手前(`f79b1b7`)に実測した
 * ダイジェスト・件数を定数として焼き込み、今日のファイルと直接突き合わせていた。**
 * **その形は「`V5-M14` が構造を変えなかったこと」ではなく「`V5-M14` 以後、誰もこのファイルを
 * 触っていないこと」を測る検査であった。** `V5-M21`(`L-G1` / `ADR-0171`。門A・判定 = 限定採用)が
 * `list_view` 分岐の `"actions": false,` を解いた時点で5本とも赤くなった —— **実装の誤りではなく、
 * 検査の測り方の誤りである。**
 *
 * **逆に当てた結果と今日の実物を比べると、差が出るのは対照表が名指しした逐語だけになる** ——
 * したがって「**`V5-M14` の差し替えが構造 / 実行される文 / 参照を動かしていないこと**」だけを測れる。
 * **後続のマイルストーンが同じファイルに正当な差分を出しても、この検査は赤くならない。**
 *
 * **【この作り直しで測らなくなったもの。1件ずつ §「測っていないもの」に再掲する】**
 * **対照表に載っていない編集を `V5-M14` が同じファイルに混ぜていたら、この形では1件も拾えない。**
 * 焼き込み型はそれを拾えた(ファイル全体のダイジェストだったため)。**弱くなっている。**
 */
function reverseApply(text: string, file: string): string {
  let out = text;
  for (const entry of REPLACEMENTS) {
    if (entry.file !== file) continue;
    out = out.split(entry.after).join(entry.before);
  }
  return out;
}

/**
 * 着手前(`f79b1b7`)に `schemas/manifest.schema.json` が持っていた ADR 参照(65件)。
 * **「1つも消していない」を、件数ではなく**名前**で測るために置く**(件数の同値は後続の追加で壊れる)。
 *
 * ---
 *
 * **【2026-08-10(`V8-M20`。台帳 `J-G27` / `J-G28` / `J-G29`。手続きは `ADR-0301`)。
 * 基準値から4件を落とした。旧値は消さずにここへ写す】**
 *
 * **落とした4件**: **`ADR-0033` / `ADR-0034` / `ADR-0070` / `ADR-0073`。**
 *
 * **落とした理由**: **`V8-M20` が `$defs/view/properties/audience` /
 * `$defs/field/properties/audience` / `$defs/field/properties/writable_by` /
 * `$defs/view_action/properties/audience` の4キーを廃止し、その `$comment` ごと
 * スキーマから消えた。** **上の4本は、その `$comment` の中だけに現れていた参照である**
 * (実測: 今日のスキーマ全文に1件も出現しない)。
 *
 * **【この基準値の性格が変わったことを隠さない】** **`ADR-0162` 限定3 の主張は
 * 「参照を1つも消していない」だった。** **`V8-M20` は語彙を廃止するマイルストーンであり、
 * 廃止したキーの `$comment` が消えれば、そこにしか無い参照は必ず消える。**
 * **したがってこの基準値は今日から「`V8-M20` が消した4件を除いて、1つも消していない」で
 * ある。** **【禁止の履行】これを「1つも消していない」と書き続けない。**
 *
 * **【記号は履歴への入口なので、消えたぶんも下に名指しで残す】** —— 下の
 * `SCHEMA_BASELINE_SYMBOL_REFS` の doc を見よ。
 */
const SCHEMA_BASELINE_ADR_REFS = [
  "ADR-0003",
  "ADR-0006",
  "ADR-0007",
  "ADR-0010",
  "ADR-0013",
  "ADR-0017",
  "ADR-0020",
  "ADR-0021",
  "ADR-0023",
  "ADR-0024",
  // **【`V8-M20`】落とした**: "ADR-0033"(廃止した4キーの `$comment` にだけ在った)
  // **【`V8-M20`】落とした**: "ADR-0034"(廃止した4キーの `$comment` にだけ在った)
  "ADR-0035",
  "ADR-0036",
  "ADR-0037",
  "ADR-0038",
  "ADR-0039",
  "ADR-0040",
  "ADR-0042",
  "ADR-0043",
  "ADR-0044",
  "ADR-0045",
  "ADR-0046",
  "ADR-0047",
  "ADR-0049",
  "ADR-0050",
  "ADR-0051",
  "ADR-0053",
  "ADR-0055",
  "ADR-0062",
  "ADR-0063",
  "ADR-0064",
  "ADR-0066",
  "ADR-0067",
  // **【`V8-M20`】落とした**: "ADR-0070"(廃止した4キーの `$comment` にだけ在った)
  "ADR-0071",
  // **【`V8-M20`】落とした**: "ADR-0073"(廃止した4キーの `$comment` にだけ在った)
  "ADR-0074",
  "ADR-0076",
  "ADR-0078",
  "ADR-0079",
  "ADR-0080",
  "ADR-0081",
  "ADR-0083",
  "ADR-0084",
  "ADR-0085",
  "ADR-0086",
  "ADR-0087",
  "ADR-0089",
  "ADR-0090",
  "ADR-0091",
  "ADR-0092",
  "ADR-0093",
  "ADR-0094",
  "ADR-0095",
  "ADR-0096",
  "ADR-0100",
  "ADR-0101",
  "ADR-0102",
  "ADR-0104",
  "ADR-0112",
  "ADR-0113",
  "ADR-0118",
  "ADR-0119",
  "ADR-0156",
] as const;

/**
 * 着手前(`f79b1b7`)に同ファイルが持っていた審査記号(42件)。
 *
 * **【2026-08-10(`V8-M20`。`ADR-0301`)。基準値から5件を落とした。旧値は消さずに写す】**
 *
 * **落とした5件**: **`B-G1` / `B-G2` / `B-G5` / `E-G46` / `E-G48`。**
 * **どれも `V8-M20` が廃止した4キー(`view.audience` / `field.audience` /
 * `field.writable_by` / `view_action.audience`)の `$comment` にだけ在った記号である**
 * (実測: 今日のスキーマ全文に1件も出現しない)。
 * **`ADR-0162` 限定3 の逐語「記号は履歴への入口である」に従い、消えた記号もここに名指しで
 * 残す** —— **一覧から落としただけで、名前は1つも失っていない。**
 */
const SCHEMA_BASELINE_SYMBOL_REFS = [
  // **【`V8-M20`】落とした**: "B-G1"(廃止した4キーの `$comment` にだけ在った)
  // **【`V8-M20`】落とした**: "B-G2"(廃止した4キーの `$comment` にだけ在った)
  // **【`V8-M20`】落とした**: "B-G5"(廃止した4キーの `$comment` にだけ在った)
  "D-G14",
  "D-G15",
  "D-G16a",
  "D-G16b",
  "D-G2",
  "D-G4",
  "D-G5",
  "E-G11",
  "E-G12",
  "E-G13",
  "E-G14",
  "E-G17",
  "E-G31",
  "E-G33",
  "E-G34",
  "E-G35",
  "E-G41",
  // **【`V8-M20`】落とした**: "E-G46"(廃止した4キーの `$comment` にだけ在った)
  // **【`V8-M20`】落とした**: "E-G48"(廃止した4キーの `$comment` にだけ在った)
  "E-G66",
  "E-G7",
  "E-G72",
  "E-G8",
  "EC-G12",
  "EC-G13",
  "EC-G14",
  "EC-G17",
  "EC-G5",
  "EC-G6",
  "EC-G8",
  "P-G14",
  "P-G17",
  "P-G22",
  "P-G24",
  "P-G26",
  "P-G28",
  "P-G29",
  "P-G32",
  "P-G50",
] as const;

describe("`ADR-0162`(`G-G18`)の限定7点", () => {
  test("限定1: `properties` のキー・`enum` の値・`type` / `const` / `pattern` / `required` / `additionalProperties` を1つも動かしていない", async () => {
    // **【`v5-merge-repair-1` で測り方を入れ替えた。黙って定数だけ差し替えていない】**
    // 旧: 着手前(`f79b1b7`)の構造ダイジェスト `b5ba4706f8b39959` を今日の実物と直接比べる。
    //     `V5-M21`(`ADR-0171`)が `list_view` 分岐の `"actions": false,` を解いたので今日は
    //     `1081e85832e43bdb` であり、**旧の形は「その後誰も触っていないこと」を測っていた。**
    // 新: **対照表を逆に当てた姿**と今日の実物で、注釈を落とした構造のダイジェストを比べる。
    // **測らなくなったもの: このファイルの構造が `f79b1b7` と同値であること。**
    //   `V5-M21` が門A の審査(`ADR-0171` 判定 = 限定採用)を通して正当に動かした部分を、
    //   **この検査はもう見張っていない**(見張るのは `ADR-0171` 限定表に対応する `V5-M21` の検査である)。
    const raw = await source("schemas/manifest.schema.json");
    const digest = (text: string): string =>
      sha(JSON.stringify(stripAnnotations(JSON.parse(text))));
    expect(digest(reverseApply(raw, "schemas/manifest.schema.json"))).toBe(digest(raw));

    // **差し替えた逐語が構造の側に1件も無い**(= 差し替えは注釈の中だけで起きている)。
    // **逆当てが一意であることも同時に固定する**(出現がちょうど1件でなければ逆当ては信用できない)。
    const structure = JSON.stringify(stripAnnotations(JSON.parse(raw)));
    for (const entry of REPLACEMENTS.filter((r) => r.unit === "G-G18")) {
      expect(raw.split(entry.after).length - 1, entry.after).toBe(1);
      expect(structure.includes(entry.after), entry.after).toBe(false);
    }
  });

  test("限定2: `$comment` / `description` を1本も足していない・消していない", async () => {
    // **【測り方を入れ替えた】** 旧: `$comment` 70 / `description` 155 を今日の実物で直接数える。
    // `V5-M21` が `list_view` 分岐の `actions` に `$comment` を1本足したので今日は **71 / 155** であり、
    // **旧の形は「その後誰も注釈を足していないこと」を測っていた。**
    // **測らなくなったもの: このファイルの注釈の総数が `f79b1b7`(70 / 155)と同値であること。**
    const raw = await source("schemas/manifest.schema.json");
    const today = JSON.parse(raw);
    const before = JSON.parse(reverseApply(raw, "schemas/manifest.schema.json"));
    expect(countKey(before, "$comment")).toBe(countKey(today, "$comment"));
    expect(countKey(before, "description")).toBe(countKey(today, "description"));
  });

  test("限定3: ADR 番号・記号への参照を1つも消していない", async () => {
    // **【測り方を入れ替えた】** 旧: 参照集合の**件数**(65 / 42)を今日の実物で直接数える。
    // `V5-M21` が `ADR-0171` / `ADR-0175` と `L-G1` / `L-G2` を足したので今日は **67 / 44** である。
    // **件数の同値は、後続が参照を「足した」だけで壊れる** —— 消していないことの検査になっていない。
    const raw = await source("schemas/manifest.schema.json");
    const before = reverseApply(raw, "schemas/manifest.schema.json");
    // (a) `V5-M14` の差し替えが参照を1つも落としていない。
    expect(setOf(before, ADR_REF)).toEqual(setOf(raw, ADR_REF));
    expect(setOf(before, SYMBOL_REF)).toEqual(setOf(raw, SYMBOL_REF));
    // (b) 着手前にあった参照が今日も1つも欠けていない(**件数ではなく名前で測る**)。
    //     **この (b) は後続が参照を「消した」ときには赤くなる**(足したときは赤くならない)。
    const adrToday = new Set(setOf(raw, ADR_REF));
    const symbolToday = new Set(setOf(raw, SYMBOL_REF));
    expect(SCHEMA_BASELINE_ADR_REFS.filter((ref) => !adrToday.has(ref))).toEqual([]);
    expect(SCHEMA_BASELINE_SYMBOL_REFS.filter((ref) => !symbolToday.has(ref))).toEqual([]);
    // **EC 由来の記号は残す**(`ADR-0162` 限定3。**記号は履歴への入口である**)。
    for (const symbol of ["EC-G6", "EC-G8", "D-G15"]) {
      expect(raw.includes(symbol), symbol).toBe(true);
    }
  });

  test("限定4: 説明の意味を変えていない(「書けない」を「書ける」に倒していない)", async () => {
    const raw = await source("schemas/manifest.schema.json");
    for (const phrase of [
      "任意の条件 (ある項目の値が0のときだけ隠す等) は書けない。",
      "**カーネルは演算を1つも持たない**",
      "**単一列のみ。**",
      "**書込先モードは3値排他である。**",
    ]) {
      expect(raw.includes(phrase), phrase).toBe(true);
    }
  });

  test("限定5: 差し替え後の語が別の業種名になっていない(対照表の `after` に業種語が無い)", () => {
    for (const entry of REPLACEMENTS.filter((r) => r.unit === "G-G18")) {
      expect(findIndustryWords(entry.after, FACE5_INDUSTRY_WORDS), entry.after).toEqual([]);
    }
  });

  test("限定6: `schemas/` 以外へ波及させていない(`src/kernel/` の同型コメントは `ADR-0163` が別に扱う)", () => {
    // **対照表の上で分かれていることを固定する** —— `schemas/` の行は `G-G18`、
    // `src/kernel/` の行は `G-G19`、`src/mcp/` の行は `G-G15` / `G-G16` に属す。
    for (const entry of REPLACEMENTS) {
      const expected = entry.file.startsWith("schemas/")
        ? "G-G18"
        : entry.file.startsWith("src/kernel/")
          ? "G-G19"
          : entry.file === "src/server/owner-scope.ts"
            ? "G-G17"
            : entry.file === "src/mcp/tools/write.ts"
              ? "G-G16"
              : "G-G15";
      expect(entry.unit, entry.file).toBe(expected as Replacement["unit"]);
    }
  });

  test("限定7: `Δ5` 点検 —— `VOCABULARY_SCOPE` / `CANNOT_DO` が新たに嘘になっていない", async () => {
    const { VOCABULARY_SCOPE, CANNOT_DO } = await import("../src/mcp/vocabulary.ts");
    const { FIELD_TYPES, DIFF_OPS, RESOURCE_KINDS } = await import("../src/kernel/types.ts");
    // **説明文が数を名指ししている箇所を、実装の配列で照合する**(嘘になっていないこと)。
    expect(FIELD_TYPES.length).toBe(9); // 【`V5-M16` / `ADR-0161`】8 → 9(`file` が9種目)。**この行が固定していたのは「その決定が語彙を増やさなかったこと」であり、増やしたのは別の決定である。**
    // **【`V8-M16` / `J-G1b` / `D-V8-31`】期待値を 17 → 18 に書き換えた。****旧行の逐語は
    // `expect(DIFF_OPS.length).toBe(17);` である。****書き換えた理由**: この行が固定して
    // いたのは「`G-G18` の決定が語彙を増やさなかったこと」であり、**増やしたのは別の決定
    // (`V8-M16` の器の新設。`set_roles` が18種目)である。****検査は消していない。**
    // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11`。判定値 = 廃止】期待値を 18 → 17 に**
    // **書き換えた。****旧行の逐語は `expect(DIFF_OPS.length).toBe(18);` である。**
    // **書き換えた理由**: この行が固定していたのは「`G-G18` の決定が語彙を増やさなかった
    // こと」であり、**減らしたのは別の決定(`V8-M29` の廃止。`set_user_kinds` を
    // 取り除いた)である。****検査は消していない。**
    // **【禁止の履行】これを「語彙が減った」と成果に書かない**(`ADR-0301` 限定10)。
    expect(DIFF_OPS.length).toBe(17); // 【`V5-M17b` / `ADR-0248`】16 → 17(`set_user_kinds` が17種目)。【`V8-M16`】17 → 18(`set_roles` が18種目)。【`V8-M29`】18 → 17(`set_user_kinds` を廃止)。**この行が固定していたのは「その決定が語彙を増やさなかったこと」であり、増やしたのは別の決定である。**
    // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】期待値を 7 → 8 へ**
    // **書き換えた。****旧行の逐語は `expect(RESOURCE_KINDS.length).toBe(7);` である。**
    // **書き換えた理由**: この行が固定していたのは「**その決定**(`G-G18` の産業中立の
    // 例文)が語彙を増やさなかったこと」であり、**増やしたのは別の決定である**
    // (`V8-M8` が画面種別の4種目 `report_view` を足し、それが `RESOURCE_KINDS` の
    // 8種目にもなった)。**検査は消していない。**
    // **すぐ下の `VOCABULARY_SCOPE.includes(kind)` の走査は1バイトも変えていない** ——
    // **8種目が説明文に載っていなければ、この検査は今日も赤くなる。**
    expect(RESOURCE_KINDS.length).toBe(8);
    for (const kind of RESOURCE_KINDS) expect(VOCABULARY_SCOPE.includes(kind), kind).toBe(true);
    for (const type of FIELD_TYPES) expect(VOCABULARY_SCOPE.includes(type), type).toBe(true);
    expect(CANNOT_DO.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// `ADR-0163`(`G-G19`)の限定7点 —— **限定ごとに1本ずつ**
// ---------------------------------------------------------------------------

const KERNEL_FILES = [
  "src/kernel/batch.ts",
  "src/kernel/types.ts",
  "src/kernel/workflow-runner.ts",
] as const;

/**
 * 着手前(`f79b1b7`)に `src/kernel/` の3ファイルが持っていた ADR 参照(63件)。
 * **「1つも消していない」を、件数ではなく**名前**で測るために置く。**
 */
const KERNEL_BASELINE_ADR_REFS = [
  "ADR-0003",
  "ADR-0006",
  "ADR-0007",
  "ADR-0010",
  "ADR-0012",
  "ADR-0013",
  "ADR-0017",
  "ADR-0018",
  "ADR-0020",
  "ADR-0021",
  "ADR-0023",
  "ADR-0024",
  "ADR-0033",
  "ADR-0035",
  "ADR-0036",
  "ADR-0037",
  "ADR-0038",
  "ADR-0039",
  "ADR-0040",
  "ADR-0042",
  "ADR-0043",
  "ADR-0044",
  "ADR-0045",
  "ADR-0046",
  "ADR-0047",
  "ADR-0050",
  "ADR-0051",
  "ADR-0055",
  "ADR-0062",
  "ADR-0063",
  "ADR-0064",
  "ADR-0066",
  "ADR-0067",
  "ADR-0070",
  "ADR-0071",
  "ADR-0072",
  "ADR-0074",
  "ADR-0076",
  "ADR-0078",
  "ADR-0079",
  "ADR-0081",
  "ADR-0083",
  "ADR-0084",
  "ADR-0085",
  "ADR-0086",
  "ADR-0089",
  "ADR-0090",
  "ADR-0091",
  "ADR-0092",
  "ADR-0093",
  "ADR-0095",
  "ADR-0096",
  "ADR-0100",
  "ADR-0101",
  "ADR-0102",
  "ADR-0104",
  "ADR-0112",
  "ADR-0113",
  "ADR-0118",
  "ADR-0119",
  "ADR-0131",
  "ADR-0156",
  "ADR-0157",
] as const;

/** コメント行(`//` / `*` / `/**`)を落とした残り。**実行される文の側**である。 */
const codeLinesOf = (text: string): string =>
  text
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
    .join("\n");

describe("`ADR-0163`(`G-G19`)の限定7点", () => {
  test("限定1: 実行される文を1バイトも変えていない(コメント行を落とした残りのダイジェストが着手前と同値)", async () => {
    // **【`v5-merge-repair-1` で測り方を入れ替えた。黙って定数だけ差し替えていない】**
    // 旧: 着手前(`f79b1b7`)の実測値 `batch.ts` `4971778927a24d14` / `types.ts` `2f67ece1f4a42358` /
    //     `workflow-runner.ts` `0315c263a3d514e8` を今日の実物と直接比べる。
    //     `V5-M21-T03`(`ADR-0171` §Decision 2。`ListView` に `actions?: ViewAction[]` を足し、
    //     `update_view` の差し替え経路を通した)が `types.ts` の**実行される文**を正当に変えたので
    //     今日は `60c4c54152d49c46` であり、**旧の形は「その後誰も触っていないこと」を測っていた。**
    // 新: **対照表を逆に当てた姿**と今日の実物で、コメント行を落とした残りのダイジェストを比べる。
    // **測らなくなったもの: `src/kernel/` の実行される文が `f79b1b7` と同値であること。**
    //   `V5-M21` が門A の審査を通して足した `ListView.actions` を、**この検査はもう見張っていない。**
    for (const file of KERNEL_FILES) {
      const text = await source(file);
      expect(sha(codeLinesOf(reverseApply(text, file))), file).toBe(sha(codeLinesOf(text)));

      // **差し替えた逐語がコメント行の側にしか無い**(実行される文の側に1件も無い)。
      // **逆当てが一意であることも同時に固定する。**
      const code = codeLinesOf(text);
      for (const entry of REPLACEMENTS.filter((r) => r.file === file)) {
        expect(text.split(entry.after).length - 1, entry.after).toBe(1);
        expect(code.includes(entry.after), entry.after).toBe(false);
      }
    }
  });

  // **【`V5-M15` が 2026-08-05 に基準値を更新した。何が起きたかを書く】**
  //
  // **下の2本はスナップショットファイルの**バイト**のダイジェストを焼き込んでいる。**面5
  // (`V5-M14`)が `src/kernel/` の公開 export と層またぎ import を1本も動かしていない**という
  // `ADR-0163` 限定2 / 限定3 の主張は、**面5 の時点では実測どおりであった**(基準値
  // `e8c6f527032f3f3e` / `664c2df0d9967c21` は面5 の着手前 `f79b1b7` の実測値である)。
  //
  // **面3(`V5-M15` / `G-G9` / `G-G10` / `ADR-0160`)が、審査を通したうえでこの2ファイルを変えた。**
  // **`Δ8` は発火している** —— `src/kernel/inbound-verify.ts` の公開 export が **5本増え0本減り**、
  // 消費側の層またぎが **10件増え1件減った**(減った1件は `src/server/inbound-route.ts` が
  // グローバル定数 `INBOUND_SIGNATURE_HEADER` を値として import するのをやめたぶんである)。
  // **増減した識別子は `docs/plan/v5/records/v5-m15.md` §7 が1つずつ名指ししており、**
  // **スナップショットの更新はその名指しの後に行われた**(`ADR-0160` 限定11 の逐語の手順)。
  //
  // **したがってここで更新したのは「基準値」だけで、検査の形も強度も1バイトも変えていない。**
  // **当時 `e8c6f527032f3f3e` → 今日 `b6278ffad9c55b92`(export)/**
  // **当時 `664c2df0d9967c21` → 今日 `abc80aa625388a36`(import)。**
  // **旧値を消さずに残す** —— **消すと「面5 の時点で何が真だったか」を後から確かめられなくなる。**
  //
  // **【この検査の限界。誇張しない】** **バイトのダイジェストなので、識別子が1つも動かなくても
  // コメントを1文字足しただけで赤くなる。** **この検査はその2つを区別できない。**
  // **区別するのは `scripts/kernel-export-drift.test.ts` / `kernel-import-drift.test.ts` の側で
  // あり、そちらは増減した識別子を名指しで出す。**
  // **【`V5-M25`(`L-G8` / `L-G10` / `L-G11a` / `L-G12`。`ADR-0174` / `ADR-0175` / `ADR-0176`)が
  // export 側の基準値を更新した】**
  //
  // **`Δ8` は発火している** —— **`src/kernel/` の公開 export が3本増え0本減った**:
  //   `types.ts:WorkflowTriggerManual` / `workflow-runner.ts:beginManualRun` /
  //   `workflow-runner.ts:runManualWorkflow`。
  // **`ADR-0176` 限定8 が「増えたら `scripts/kernel-export-snapshot.txt` を更新し、
  // `V5-M25` の記録に1件ずつ書く」と定めており、その手順どおりに行った**
  // (名指しは `docs/plan/v5/records/v5-m25.md` §4)。
  // **当時 `b6278ffad9c55b92` → 今日 `9b12fcd5aff53e17`。****旧値を消さずに残す。**
  // **【禁止】これを「語彙を増やしていない」と読まない** —— **増えた。**
  // **【`V5-M17b` / `ADR-0248` 限定8。2026-08-05】** **旧テスト名の逐語は
  // 「限定2: `src/kernel/` の公開 export の基準値(`V5-M25` で3本増えた)」である。**
  // **`ADR-0248` が `types.ts:SetUserKindsOperation` と `types.ts:UserKindDeclaration` の
  // 2本を足した**(17種目の差分操作 `set_user_kinds` の型)。**門A の本審査を通しており、
  // `ADR-0248` 限定8 が「新しい公開 export は2つまで」と定めている。実測もちょうど2件である。**
  // **当時 `9b12fcd5aff53e17` → 今日 `7d3f51fa2366ddee`。****旧値を消さずに残す。**
  // **【禁止】これを「語彙を増やしていない」と読まない** —— **増えた**(`DIFF_OPS` 16 → 17)。
  // **【`V8-M16` / `J-G1b` / `D-V8-31`。2026-08-09】** **旧テスト名の逐語は
  // 「限定2: `src/kernel/` の公開 export の基準値(`V5-M25` で3本 / `V5-M17b` で2本増えた)」である。**
  // **`V8-M16` が `types.ts:RoleDeclaration` と `types.ts:SetRolesOperation` の2本を足した**
  // (18種目の差分操作 `set_roles` の型)。**門A の本審査を通した増分である。**
  // **当時 `7d3f51fa2366ddee` → 今日 `ffebddbf35a39ab7`。****旧値を消さずに残す。**
  // **【禁止】これを「語彙を増やしていない」と読まない** —— **増えた**(`DIFF_OPS` 17 → 18)。
  // **【`V8-M17` / `J-G6`〜`J-G11`。2026-08-09】** **旧テスト名の逐語は
  // 「限定2: `src/kernel/` の公開 export の基準値(`V5-M25` で3本 / `V5-M17b` で2本 /
  // `V8-M16` で2本増えた)」である。**
  // **`V8-M17` が `types.ts:RoleRule` と `types.ts:RoleRuleVerb` の2本を足した**
  // (役割に束ねた規則の型)。**門A の本審査を通った増分である**(台帳の6行はどれも
  // 限定採用)。**関数は1本も export していない。**
  // **当時 `ffebddbf35a39ab7` → 今日 `a079b039d5cf4e2e`。****旧値を消さずに残す。**
  // **【禁止】これを「語彙を増やしていない」と読まない** —— **増えた**(`roles[].rules`)。
  // **【`V8-M17` の2度目の更新。2026-08-09。メインの判断で既定3本を消せないようにした】**
  // **`types.ts:DEFAULT_ROLE_IDS` を1本足した**(既定の役割定義3本の識別子。
  // **入れる側 `create-app.ts` と検査する側 `referential-integrity.ts` が同じ3語を
  // 別々に持たないため**)。**当時 `a079b039d5cf4e2e` → 今日 `363a5adfd5ce9b1c`。**
  // **旧値を消さずに残す。**
  // **【`V8-M18` / `J-G12`〜`J-G16`。2026-08-09】** **旧テスト名の逐語は
  // 「限定2: `src/kernel/` の公開 export の基準値(`V5-M25` で3本 / `V5-M17b` で2本 /
  // `V8-M16` で2本 / `V8-M17` で3本増えた)」である。**
  // **`V8-M18` が `types.ts:RoleCondition` と `types.ts:RoleConditionNotice` の2本を足した**
  // (役割の規則が当たる条件の型と、誰も通さない条件・全員を通す条件の知らせの型)。
  // **門A の本審査を通った増分である**(台帳の5行はどれも限定採用)。
  // **関数は1本も export していない。**
  // **当時 `363a5adfd5ce9b1c` → 今日 `53fc9c25177a73e1`。****旧値を消さずに残す。**
  // **【禁止】これを「語彙を増やしていない」と読まない** —— **増えた**(`$defs` 28 → 29 と
  // `roles[].rules[].when`)。
  test("限定2: `src/kernel/` の公開 export の基準値(`V5-M25` で3本 / `V5-M17b` で2本 / `V8-M16` で2本 / `V8-M17` で3本 / `V8-M18` で2本増えた)", async () => {
    // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a` / `T-G11`。判定値 = 廃止】**
    // **旧行の逐語**: `expect(sha(await source("scripts/kernel-export-snapshot.txt"))).toBe("53fc9c25177a73e1");`
    // **本波は基準ファイルから2本**減らした**(`SetUserKindsOperation` / `UserKindDeclaration`)。**
    // **このファイルで基準値が「減ったこと」で動くのは初めてである。**
    // **旧値は1バイトも消していない。**
    // **【2026-08-14。`V8-M8-T09`。台帳 `Q-G1`〜`Q-G5` / `Q-G10` / `Q-G32` / `Q-G35` / `Q-G36`。
    //   判定値 = 限定採用】**
    // **旧行の逐語**: `expect(sha(await source("scripts/kernel-export-snapshot.txt"))).toBe("0b07bd8770b348d5");`
    // **v8 の2本目の軸(集計表)が5本足した**(`report.ts:computeReport` と
    // `types.ts:ReportView` / `ReportDeclaration` / `ReportGroupBy` / `ReportAggregate`)。
    // **門A の本審査(`V8-M7`)を通った増分である。** **ADR は `ADR-0339` / `ADR-0340`。**
    // **当時 `0b07bd8770b348d5` → 今日 `7952403547d23134`。****旧値を消さずに残す。**
    // **【禁止】これを「語彙を増やしていない」と読まない** —— **6箇所で増えた**
    // (`VIEW_TYPES` 3 → 4 / `RESOURCE_KINDS` 7 → 8 / `$defs/view_type.enum` 3 → 4 /
    //  `$defs/view.properties` 28 → 29 / `$defs` 29 → 30 / `view_changes` 24 → 25)。
    // **【2026-08-15。`V8-M9-T06`。台帳 `Q-G6`〜`Q-G9`。判定値 = 限定採用】**
    // **旧行の逐語**: `expect(sha(await source("scripts/kernel-export-snapshot.txt"))).toBe("7952403547d23134");`
    // **v8 の2本目の軸(集計表)の結合が **1本** 足した**(`types.ts:ReportJoin`)。
    // **門A の本審査(`V8-M7`)を通った増分である。** **ADR は `ADR-0341`(限定2)。**
    // **同じマイルストーンのもう1本(`ADR-0342` = 束ねるキーに行そのものを書く)は
    // 公開 export を **1本も** 足していない** —— **値域を広げただけだからである。**
    // **当時 `7952403547d23134` → 今日 `960ddd6b25cbfe5a`。****旧値を消さずに残す。**
    // **【禁止】これを「語彙を増やしていない」と読まない** —— **増えた**
    // (`$defs/report.properties` 3 → 4 / 公開 export 1本)。
    // **【この検査の限界。誇張しない】** **バイトのダイジェストなので、`#` のコメントを
    // 1文字足しただけでも赤くなる。** **今日の変更は識別子1本の追加と `#` の追記の
    // 両方を含んでおり、この検査はその2つを区別できない**(区別するのは
    // `scripts/kernel-export-drift.test.ts` の側である。そちらは `added: ["types.ts:ReportJoin"]`
    // を名指しで出した)。
    // **【2026-08-23。`V10-M10-T01`。台帳 `CM-G1` / `CM-G3`。判定値 = 限定採用】**
    // **旧行の逐語**: `expect(sha(await source("scripts/kernel-export-snapshot.txt"))).toBe("960ddd6b25cbfe5a");`
    // **v10 の1本目の軸(コメント)の器が **5本** 足した** —— **足した識別子を1つずつ名指しする**:
    // **`comment-store.ts:COMMENT_ANCHOR_FORMS`**(宛先の形の登録簿。**今日は7形ちょうど**)/
    // **`comment-store.ts:CommentAnchorForm`**(その形の名前の型)/
    // **`comment-store.ts:Comment`**(積まれた1行)/
    // **`comment-store.ts:AddCommentInput`**(追加の入力)/
    // **`comment-store.ts:CommentStore`**(器そのもの)。
    // **門A の本審査(`V10-M0`)を通った増分である。** **ADR は `ADR-0366`(`CM-G1` / `CM-G3`)。**
    // **当時 `960ddd6b25cbfe5a` → 今日 `cac83d6aaba83648`。****旧値を消さずに残す。**
    // **【禁止】これを「語彙ゼロ増」と読まない** —— **`schemas/` は1バイトも動かない
    // (`$defs` 30 / `$defs/view.properties` 31 のまま)が、`src/kernel/` の公開エクスポートは
    // **5本増えた**(`Δ8` が発火した)。
    // **【この検査の限界。誇張しない】** **バイトのダイジェストなので、`#` のコメントを
    // 1文字足しただけでも赤くなる。** 今日の変更も識別子5本の追加と `#` の追記の両方を
    // 含んでおり、この検査はその2つを区別できない(区別するのは
    // `scripts/kernel-export-drift.test.ts` の側で、`added` が上の5本を名指しで出した)。
    // **【訂正。`V10-M26-T02`(`CM-G33` / `ADR-0374`)。2026-08-24】**
    // **上の `COMMENT_ANCHOR_FORMS` の「今日は7形ちょうど」は、今日は偽である。**
    // **`V10-M25`(`CM-G25a` / `CM-G25b` / `CM-G26` / `CM-G32`)が 7形 → 9形 → 11形 と広げた。**
    // **今日は 11形ちょうどである。****上の行は書き換えない**(本リポジトリの作法)。
    // **この訂正そのものは `scripts/kernel-export-snapshot.txt` の指紋に1バイトも影響しない**
    // (別ファイルである)。**指紋が動いたのは、同じ訂正を snapshot の側にも足したからである。**
    // **当時 `cac83d6aaba83648` → 今日 `8d641e1cd6658161`。****旧値を消さずに残す。**
    // **【禁止】これを「公開 export が増えた」と読まない** —— **`Δ8` は発火していない。**
    // **増えたのは `#` のコメントだけで、`src/kernel/` の公開エクスポートは1本も増減していない**
    // (区別するのは `scripts/kernel-export-drift.test.ts` の側である)。
    // **【`V10-M13-T02`(`CM-G19` / 門A / 限定採用 / `ADR-0369`。裁定6)。2026-08-24】**
    // **今度は `Δ8` が発火している。** **公開エクスポートが2件増えた**
    // (`comment-store.ts:COMMENT_STATES` / `comment-store.ts:CommentState`)。
    // **旧の基準値(逐語。1バイトも消していない)**:
    // `expect(sha(await source("scripts/kernel-export-snapshot.txt"))).toBe("8d641e1cd6658161");`
    // **当時 `8d641e1cd6658161` → 今日 `983b2d13bf572c5e`。****旧値を消さずに残す。**
    // **【`V10-M30-T01`(`CM-G36` / 門A / 限定採用 / `ADR-0377`)。2026-08-25】**
    // **今度も `Δ8` が発火している。** **公開エクスポートが1件増えた**
    // (`meta-store.ts:CommentVisibility` = アプリごとのコメント表示設定の型。
    //  書く側と読む側の2つを持ち、`D-V10-36` により1つに畳んでいない)。
    // **増えたのは型1本だけである** —— `getCommentVisibility` / `setCommentVisibility` は
    // `KernelMetaStore` の**メソッド**であって top-level export ではないので、
    // `Δ8` の識別子集合を増やさない。
    // **門A の本審査(`V10-M29`)を通った増分である。** **基準の更新はその審査の後である。**
    // **旧の基準値(逐語。1バイトも消していない)**:
    // `expect(sha(await source("scripts/kernel-export-snapshot.txt"))).toBe("983b2d13bf572c5e");`
    // **当時 `983b2d13bf572c5e` → 今日 `2a0fae816ce5f6c5`。****旧値を消さずに残す。**
    // **【禁止】これを「アプリの語彙が増えた」と読まない** —— **`schemas/` は1バイトも
    // 動いておらず、`RESOURCE_KINDS`=8 / `FIELD_TYPES`=9 / `DIFF_OPS`=17 は1つも動いていない。**
    // **器は `apps` 表の列2本ちょうどであり、`kernel.sqlite` の表は1本も増えていない。**
    // **【`V17-M3-T03b`(`AC-G13` / 門A / `Δ8` を確定させた)。2026-09-07】**
    // **今度も `Δ8` が発火している。** **公開エクスポートが2件増えた**
    // (`workflow-runner.ts:accessJudgmentApplies` = この発火に判定を掛けるかを問う述語 /
    //  `workflow-runner.ts:judgeAutomationWrite` = 自動処理の書込1件に面と点を当てる述語)。
    // **どちらも既に在った関数であり、`export` を1語ずつ足しただけである** ——
    // **新しい述語も新しい判定の式も1つも作っていない。**
    // **`src/kernel/ai-dispatcher.ts` の `writeBack`(AI の書き戻し)が、この2本を
    // import して1度だけ呼ぶ** —— **本命の口とフォールバックの口の**両方**が同じ1本の
    // 判定を通る**(`withAiChainDepth` の中の先頭に置いた)。
    // **台帳 `docs/adr/0007-vocabulary-governance.md:1839`(`AC-G13` の行)は逐語で
    // 「**A**(catch-all。**`Δ8` 未確定**)」と書いており、確定させたのは本段である。**
    // **【正直に書く】この時点で `AC-G13` の個別 ADR はまだ書かれていない** ——
    // **`V17-M3-T08a` がこれから書く。****「門A を通した」と過去形で読まない。**
    // **旧の基準値(逐語。1バイトも消していない)**:
    // `expect(sha(await source("scripts/kernel-export-snapshot.txt"))).toBe("2a0fae816ce5f6c5");`
    // **当時 `2a0fae816ce5f6c5` → 今日 `68c62429d88b17c4`。****旧値を消さずに残す。**
    // **【禁止】これを「アプリの語彙が増えた」と読まない** —— **`schemas/` は1バイトも
    // 動いておらず、差分操作の種類も1つも増えていない。**
    expect(sha(await source("scripts/kernel-export-snapshot.txt"))).toBe("68c62429d88b17c4");
  });

  // **【`V5-M16`(`G-G12` / `G-G13` / `ADR-0161` + `D-V5-84`)による基準値の更新】**
  // **`import` スナップショットが3件増えた** —— **3件とも新規テスト
  // `src/server/file-attachment.test.ts` のセットアップ**(`KernelMetaStore` / `applyManifest` /
  // `createApp`。既存の `files-upload.test.ts` / `files-delivery.test.ts` と同じ3本)である。
  // **製品コードの層またぎは0件増えた。** **`export` スナップショットは1バイトも動いていない**
  // (`ADR-0161` 限定8 の「`src/kernel/` に増える公開面は0本を目標とする」を達成した)。
  // **当時 `abc80aa625388a36` → 今日 `ee5e013c486d82cc`(import)。**
  // **`export` の基準値 `b6278ffad9c55b92` は動いていない。**
  // **旧値を消さずに残す。**
  // **【`V5-M23`(`L-G13` / `L-G14` / `L-G16`。`ADR-0177`)が import 側の基準値だけを更新した】**
  //
  // **`Δ8` は発火していない** —— **`src/kernel/` の公開 export は1本も増えていない**
  // (限定2 の基準値 `b6278ffad9c55b92` は1バイトも動かしていない)。
  // **動いたのは消費側だけで、3件増え0件減った** —— **3件とも新規テスト
  // `src/server/view-action-audience.test.ts` のセットアップ(`createApp` / `KernelMetaStore` /
  // `applyManifest`)であり、同ディレクトリの `view-audience-enforcement.test.ts` が
  // 既に値 import している同じ3本である。****新しい層またぎの種類は0本である。**
  // **増減した識別子は `docs/plan/v5/records/v5-m23.md` §7-2 が名指ししており、
  // スナップショットの更新はその名指しの後に行った。**
  // **当時 `664c2df0d9967c21`(面5)→ 面3 で `abc80aa625388a36` → 面4(`V5-M16`)で
  // `ee5e013c486d82cc` → 今日 `1beb88c00517058c`。**
  // **【マージで2つのブロックが同時に入った。両方を残すのが正しい解決である】**
  // **`V5-M16`(汎用化の面4)と `V5-M23`(導線の面4)が別の worktree で同時にこのファイルへ
  // 追記したため、`main` へのマージで衝突した。****片方を捨てると `ADR-0009` 限定2 の
  // 検査(`kernel-import-drift.test.ts`)が落ちる**ので、**両方のブロックを残した。**
  // **したがって今日のダイジェストは、どちらか一方の更新後の値とも一致しない。**
  // **旧値を消さずに残す。**
  // **【`V5-M25` が import 側の基準値も更新した】** **5件増え0件減った** ——
  // **うち2件は製品コードの層またぎである**(`src/server/app.ts` が `beginManualRun` と
  // `runManualWorkflow` を値 import する)。**「製品コードは0件」とは書けない。**
  // **残る3件は新規テスト `src/server/manual-trigger-route.test.ts` のセットアップ
  // (`KernelMetaStore` / `applyManifest` / `createApp`)である。**
  // **当時 `1beb88c00517058c` → 今日 `73975ab72ecc059d`。****旧値を消さずに残す。**
  //
  // **【`V5-M17`(`G-G5`〜`G-G8`。`ADR-0158` / `ADR-0159` / `ADR-0232` / `ADR-0233`)も
  // import 側の基準値だけを更新した】**
  //
  // **`Δ8` は発火していない** —— **`V5-M17` は `src/kernel/` の公開 export を1本も
  // 増やしていない**(限定2 の基準値 `b6278ffad9c55b92` を `V5-M17` は1バイトも動かして
  // いない。**`V5-M25` が3件増やしたのは別の決定である**)。
  // **`V5-M17` が動かしたのは消費側だけで、4件増え0件減った** —— **4件とも新規テスト
  // `src/server/declared-user-kind-scope.test.ts` のセットアップである。**
  // **`createApp` / `KernelMetaStore` / `applyManifest` の3本は既存の同ディレクトリの検査が
  // 既に値 import している。****4本目の `validateManifestFull` だけが新しい種類の
  // 層またぎである** —— **`audience` の値域がスキーマでは閉じられなくなり、宣言していない
  // 種類名を弾くのが適用時の参照整合検査に移ったためである**(`ADR-0159` §1 (a))。
  // **増減した識別子は `docs/plan/v5/records/v5-m17.md` が名指ししており、
  // スナップショットの更新はその名指しの後に行った。**
  //
  // **【マージで2つのブロックが同時に入った。両方を残すのが正しい解決である】**
  // **`V5-M25`(導線の面3)と `V5-M17`(汎用化の面2)が別の worktree で同時にこのファイルへ
  // 追記したため、`main` の取り込みで衝突した。****片方を捨てると `ADR-0009` 限定2 の
  // 検査(`kernel-import-drift.test.ts`)が落ちる**ので、**両方のブロックを残した。**
  // **したがって今日のダイジェストは、どちらか一方の更新後の値とも一致しない** ——
  // **`V5-M25` 単独なら `73975ab72ecc059d` / `V5-M17` 単独なら `2c0c849c1789c3cb` /
  // 両方入った今日は `33e58ce49a68f26e` である。****旧値を消さずに残す。**
  //
  // **【`V5-M18`(`G-G21` / `D-V5-86`。参照アプリの作り直し)が3つ目のブロックを足した】**
  //
  // **`Δ8` は発火していない** —— **`V5-M18` は `src/kernel/` の公開 export を1本も
  // 増やしていない**(触ったのは `scripts/ref-ec/` の中だけである)。
  // **7件増え0件減った** —— **7件とも新規テスト
  // `scripts/ref-ec/checkout-journey.test.ts` のセットアップである。**
  // **7本とも `scripts/ref-ec/manifest.test.ts` / `journey-e2e.test.ts` が既に同じ形で
  // 値 import しているものであり、新しい種類の層またぎは1件も無い。**
  // **当時 `33e58ce49a68f26e` → 今日 `4e3165a86a6f030a`。****旧値を消さずに残す。**
  //
  // **【`V5-M26`(`L-G20` / `L-G21`。カートから注文への実地確認)が4つ目のブロックを足した】**
  //
  // **`Δ8` は発火していない** —— **`V5-M26` は `src/kernel/` の公開 export を1本も
  // 増やしていない**(`src/` に1バイトの差分も出していない)。
  // **9件増え0件減った** —— **内訳は新規テスト2本(`scripts/ref-ec/user-kinds-trial.test.ts` 5件 /
  // `scripts/ref-ec/admin-readable-manual-run.test.ts` 3件)と、既存の
  // `web/e2e/fixture-server.ts` への1件(`ensureIslandRuntimeReady`)である。**
  // **最後の1件だけが既存ファイルへの追加であり、理由(足す前は `run_function` を含む
  // ワークフローを発火させる書込が 400 になっていた)はスナップショットのコメントに書いた。**
  // **9本とも既存のどれかのファイルが同じ形で値 import しているものであり、
  // 新しい種類の層またぎは1件も無い。**
  // **当時 `4e3165a86a6f030a` → 今日 `befe9b41092a237a`。****旧値を消さずに残す。**
  //
  // **【`V5-M28`(`A-G1` / `ADR-0249`。操作起点の「見せる相手」から立てた書込の壁)が
  // 5つ目のブロックを足した】**
  //
  // **`Δ8` は発火していない** —— **`V5-M28` は `src/kernel/` の公開 export を1本も
  // 増やしていない**(`git diff --numstat -- src/kernel/` が0行 /
  // `bun test scripts/kernel-export-drift.test.ts` が緑)。
  // **3件増え0件減った** —— **3件とも新規テスト
  // `src/server/view-action-write-wall.test.ts` のセットアップである**
  // (`KernelMetaStore` / `applyManifest` / `createApp`)。
  // **同ディレクトリの `src/server/view-action-audience.test.ts` が**着手前から**
  // まったく同じ3本を値 import しており**
  // (`git show 69c9641^:src/server/view-action-audience.test.ts` の `:43` で実測した)、
  // **新しい種類の層またぎは1件も無い。**
  // **当時 `befe9b41092a237a` → 今日 `49aedff9f3d707e3`。****旧値を消さずに残す。**
  //
  // **【`V5-M28-T06`(同じ `A-G1` / `ADR-0249` §4-5 の穴1〜6 の実測)が6つ目のブロックを足した】**
  //
  // **`Δ8` は発火していない** —— **`src/kernel/` の公開 export を1本も増やしていない**
  // (`git diff --numstat -- src/kernel/` が0行 /
  // `bun test scripts/kernel-export-drift.test.ts` が緑)。
  // **7件増え0件減った** —— **7件とも新規テスト
  // `src/server/view-action-write-wall-gaps.test.ts` のセットアップである**
  // (`InboundStore` / `KernelMetaStore` / `appDbPath` / `applyDiff` / `applyManifest` /
  //  `createApp` / `ensureIslandRuntimeReady`)。
  // **7本とも既存のどれかのファイルが着手前から同じ形で値 import しているものであり、
  // 新しい種類の層またぎは1件も無い**(内訳はスナップショットのコメントに書いた)。
  // **`src/mcp/tools/write.test.ts` は同じタスクで検査を4本足したが、値 import は1件も
  // 増えていない。**
  // **当時 `49aedff9f3d707e3` → 今日 `51827bec4ea118f3`。****旧値を消さずに残す。**
  //
  // **【`V5-M29-T06`(`A-G2` / `ADR-0250`。語彙の本数の焼き込みを名前の一覧1本へ寄せる)が
  //   7つ目のブロックを足した。**これまでの6ブロックはすべて「増えた」であり、
  //   **減ったのは今回が初めてである**】**
  //
  // **`Δ8` は発火していない** —— **`V5-M29` は `src/kernel/` の非テストファイルに1バイトも
  // 差分を出していない**(`ADR-0250` 限定3)。
  // **3件増え9件減った。**
  // **減った9件は `V5-M29-T05` が `expect` を消した結果、値として import する理由が
  // 無くなったものである:**
  // (`scripts/mock-psp/payment-flow-e2e.test.ts` の `FIELD_TYPES` / `RESOURCE_KINDS` /
  //  `scripts/ref-ec/journey-e2e.test.ts` の同2本 /
  //  `scripts/ref-ec/manifest.test.ts` の同2本 /
  //  `src/server/inbound-signature-shape.test.ts` の `DIFF_OPS` / `FIELD_TYPES` /
  //  `RESOURCE_KINDS`)。
  // **`V5-M29-T05` はこの9件の import を消さずに残し、`TS6133` 9件 と
  // `noUnusedImports` 4件 を残した。`V5-M29-T06` がメインの裁定で消す側を採った**
  // (経緯は `docs/plan/v5/records/v5-m29-t05.md` §0 と同 `v5-m29.md` §9)。
  // **増えた3件は新設の中央の検査 `scripts/vocabulary-drift.test.ts` の
  // `DIFF_OPS` / `FIELD_TYPES` / `RESOURCE_KINDS` である。**
  // **`V5-M29-T01` はこれを動的 `import()` で読んでおり、その形では中央の検査のカーネル
  // 依存が `ADR-0009` 限定2 の台帳に1行も載らなかった**(`T01` が損として自ら申告している)。
  // **`V5-M29-T06` が静的 import へ戻し、3行を台帳に足した。**
  // **新しい種類の層またぎは1件も増えていない** —— 3本とも既に別ファイルが値 import している。
  // **`ADR-0009` 限定2 が固定している「層またぎの内容」は1バイトも変わらない。**
  // **当時 `51827bec4ea118f3` → 今日 `18fab4d4915e65df`。****旧値を消さずに残す。**
  // **9件だけを消して3件を足さなかった段階の実測値は `6b369db670336c79` であった**
  // (`V5-M29-T05` §0 の 3 が予告した値。**これも消さずに残す**)。
  //
  // **【`V5-M2`(`R-G5` / `R-G11` / `R-G14`。配布物用の `data/` を1アプリ分だけ組み立てる)が
  //   8つ目のブロックを足した】**
  //
  // **`Δ8` は発火していない** —— **`V5-M2` は `src/kernel/` の公開 export を1本も増やして
  // いない**(`src/kernel/delete-app.ts` の既に export 済みの配列に要素を2つ足しただけ /
  // `bun test scripts/kernel-export-drift.test.ts` が `2 pass / 0 fail`)。
  // **16件増え0件減った** —— **本体4件が `scripts/build-runner-data.ts`、
  // 検査のセットアップ12件が `scripts/build-runner-data.test.ts` である。**
  // **製品コードの層またぎは0件増えて0件減った。**
  // **【正直に書く。ここは先行7ブロックと言い方が違う】** **「新しい種類の層またぎは1件も無い」
  // とは書けない** —— **シンボル単位で数えると `APP_SCOPED_KERNEL_TABLES` の既存行は着手前 0件で
  // あった**(実測)。**16行のうち2行がこのシンボルの最初の層またぎである。**
  // **残る13シンボルはすべて既存行がある。****モジュール単位(同じ `src/kernel/delete-app.ts` の
  // `deleteApp` が着手前から `src/mcp/tools/write.ts:deleteApp` として載っている)で数えるか、
  // 「定数を値 import する」という形(`scripts/cp-v1-8-audit.ts` の6定数)で数えると新規ではない。**
  // **どちらが正しいかを本ブロックは判定しない**(1行ずつの内訳と数え方の3通りはスナップショットの
  // コメントに書いた)。
  // **裁定を下したのはメイン(計画側)であって門A の本審査ではない** ——
  // **`V5-M2` はこの赤に当たった時点でスナップショットを1バイトも更新せずに手を止め、
  // メインへ報告した。****`ADR-0009` 限定2 を1バイトも引き直していない。**
  // **【はみ出しを正直に書く】本ファイル(`scripts/industry-neutral-examples.test.ts`)は
  // `V5-M0` の歯止め1 の宣言(§2-5 / §2-11 / §2-14)に無い。****`V5-M2` のはみ出し1件である**
  // (`ADR-0007` §1d-1 (B) の機械的検査の対象ファイル = `src/kernel/` / `src/shared/system-tables.ts` /
  //  `schemas/` に含まれないので門A へは差し戻していない。全件列挙は
  //  `docs/plan/v5/records/v5-m2.md` §2 に置いた)。
  // **当時 `18fab4d4915e65df` → 今日 `7b0dac67120b395b`。****旧値を消さずに残す。**
  // **16行のデータ行だけを足した段階の実測値は `14a3e2fd89a8dd73` であった** ——
  // **そのあと「新しい種類の層またぎは1件も無い」と書けないことが実測で分かり、
  // スナップショットのコメントを数え方3通りの記述に直したので sha が動いた。**
  // **この中間値も消さずに残す**(`V5-M29-T05` の `6b369db670336c79` と同じ扱い)。
  //
  // **【`V5-M9`(`R-G15-a` / `R-G15-c`。MCP の2本目の入口 = Streamable HTTP)が9つ目のブロックを足した】**
  // **`V5-M9`(`R-G15-a` / `R-G15-c`。MCP の2本目の入口 = Streamable HTTP)で 8件増えた。**
  // **新しいシンボルは1つも増えていない** —— 増えたのは「どのファイルから」の組み合わせだけである:
  // 製品コード2件(`src/mcp/http-entry.ts` の `ensureIslandRuntimeReady` / `recover`。
  // **どちらも `src/mcp/index.ts` が既に値 import している同じ2本**)と、
  // テスト6件(`src/mcp/http-entry.test.ts` のセットアップ。
  // **`src/mcp/index.test.ts` と1シンボルも違わない組**)。
  // **`ADR-0009` 限定2 が名指しした3本には1本も触れていない。**
  // **当時 `18fab4d4915e65df` → 今日 `db82a98d88c57c40`。****旧値を消さずに残す。**
  // 記録: `docs/plan/v5/records/v5-m9.md` §6-3。
  //
  // **【マージ時の断り。丸めない】** **`V5-M2` と `V5-M9` は別々の worktree で並行して走り、
  // どちらも本ファイルと `scripts/kernel-import-snapshot.txt` を触ったのでマージで衝突した。**
  // **両方のブロックを残すのが正しい解決である**(片方を捨てると検査が落ちる)。
  // **したがって両者が単独で測った sha(`V5-M2` の `7b0dac67120b395b` / `V5-M9` の
  // `db82a98d88c57c40`)は、どちらも今日の実物とは一致しない。****両方とも消さずに残す。**
  // **今日の値は、両ブロックが入ったあとにメインが `main` 上で測り直したものである。**
  //
  // **【`V5-M6`(`R-G4`。`ADR-0252`。配布先のボリュームを移行する器)が10個目のブロックを足した】**
  // **24件増え0件減った** —— **本体14件が `scripts/migrate-volume.ts`、
  // 検査のセットアップ10件が `scripts/migrate-volume.test.ts` である。**
  // **製品コードの層またぎは0件増えて0件減った。**
  // **【正直に書く。先行9ブロックより1段大きい】** **「新しい種類の層またぎは1件も無い」とは
  // 書けないどころか、`V5-M2` が書けた「モジュール単位で数えると新規ではない」も書けない** ——
  // **`src/kernel/migrate.ts` と `src/kernel/convert.ts` の2モジュールが、着手前 0件から
  // 初めて層をまたいだ**(実測)。**シンボル単位では6本が初出**(`planMigration` /
  // `applyMigrationPlan` / `checkFieldConversions` / `UNCONVERTIBLE_SAMPLE_LIMIT` /
  // `foldOperations` / `restoreSnapshot`)。**残る10シンボルには既存行がある。**
  // **この赤は `ADR-0252` §1 と S3 の (b) が着手前に予告していたものであり、
  // 限定5 がその更新の作法(1行ずつの列挙と理由)を完了条件として先に定めている。**
  // **`ADR-0009` 限定2 を1バイトも引き直していない**(`ADR-0252` §3)。
  // **`ADR-0009` 限定2 の条文の主語3本には1本も触れていない。**
  // **当時 `0711e3e776a4903b` → 今日 `ad6a9258de30587a`。****旧値を消さずに残す。**
  // 記録: `docs/plan/v5/records/v5-m6.md` §5(増えた24行の1行ずつの列挙と理由)。
  //
  // **【`V5-M7`(`R-G1` のイメージ側。コンテナ化)が11個目のブロックを足した】**
  // **6件増え0件減った** —— **すべて `scripts/runner-image/seed-demo-app.ts` の1ファイルである。**
  // **新しいシンボルは1つも増えていない**(`createApp` / `KernelMetaStore` / `applyDiff` /
  // `readCurrentManifest` / `createRecord` / `appDbPath` の6本は、`scripts/bench/fixture.ts` /
  // `scripts/cp4-evidence.ts` / `scripts/mock-psp/payment-flow-e2e.test.ts` が既に採っている組である)。
  // **`V5-M6` が初めて層をまたがせた `src/kernel/migrate.ts` / `convert.ts` には1件も触れていない。**
  // **製品コードの層またぎは0件増えて0件減った** —— **`seed-demo-app.ts` はビルド時の器であり、
  // 配布物のイメージに1ファイルも入らない**(`scripts/` はイメージに COPY されない。
  // 検査は `scripts/runner-image/verify-image.ts` の (N6))。
  // **`ADR-0009` 限定2 を1バイトも引き直していない。****条文の主語3本には1本も触れていない。**
  // **当時 `ad6a9258de30587a` → 今日 `e0d73182c9806e22`。****旧値を消さずに残す。**
  // 記録: `docs/plan/v5/records/v5-m7.md` §0(増えた6行の1行ずつの列挙と理由)。
  //
  // **【`V5-M7f`(`CP-V5` の条件3。版の印と過去の控え)が12個目のブロックを足した】**
  // **4件増え0件減った** —— **本体2件が `scripts/build-runner-data.ts`
  // (`appDbPath` / `appSnapshotsDir`)、検査のセットアップ2件が
  // `scripts/build-runner-data.test.ts`(`appDir` / `appSnapshotsDir`)である。**
  // **新しいシンボルは1つも増えていない** —— **3本とも `src/kernel/storage-paths.ts` の
  // 保存レイアウト関数であり、`scripts/bench/fixture.ts` が `appDbPath` / `appSnapshotsDir` の
  // 組を、`scripts/build-runner-data.ts` 自身が `appDir` を既に採っている。**
  // **製品コードの層またぎは0件増えて0件減った** —— **`build-runner-data.ts` はビルド時の器であり、
  // 配布物のイメージに1ファイルも入らない**(検査は `verify-image.ts` の (N6))。
  // **`ADR-0009` 限定2 を1バイトも引き直していない。****条文の主語3本には1本も触れていない。**
  // **【はみ出しを正直に書く】本ファイルは `V5-M7f` の発注書が名指しした変更対象ではない。**
  // **`V5-M2` が同じはみ出しを申告したのと同型である**(上の `V5-M2` のブロック)。
  // **当時 `e0d73182c9806e22` → 今日 `c1b14d86f7425d08`。****旧値を消さずに残す。**
  // 記録: `docs/plan/v5/records/v5-m7f.md` §5(増えた4行の1行ずつの列挙と理由)。
  //
  // **【`V6-M13-T01`(`H-G5` / `H-G19`。配布物の skill と語彙の正の突き合わせ検査)が
  //   13個目のブロックを足した】**
  // **3件増え0件減った** —— **3件とも新設の検査 `scripts/skill-vocabulary-drift.test.ts` の
  // `DIFF_OPS` / `FIELD_TYPES` / `RESOURCE_KINDS` である。**
  // **新しいシンボルは1つも増えていない** —— **`V5-M29-T06` が足した
  // `scripts/vocabulary-drift.test.ts` の3行とまったく同じ組であり、同じ理由
  // (語彙の名前の正をカーネルから導き、字面で書かない)で採っている。**
  // **製品コードの層またぎは0件増えて0件減った**(新設は `scripts/` の検査1本だけである)。
  // **`V5-M6` が初めて層をまたがせた `src/kernel/migrate.ts` / `convert.ts` には1件も触れていない。**
  // **`ADR-0009` 限定2 を1バイトも引き直していない。****条文の主語3本(`normalizeSort` /
  // `sortErrorPath` / `validateSortKeys`)には1本も触れていない。**
  // **`Δ8` は発火していない** —— **`src/kernel/` の公開 export を1本も増やしていない**
  // (`git diff --numstat -- src/kernel/ schemas/` が0行 /
  //  `bun test scripts/kernel-export-drift.test.ts` が緑)。
  // **【はみ出しを正直に書く】本ファイルは `V6-M13` の発注書が名指しした変更対象ではない。**
  // **`V5-M2` / `V5-M7f` が同じはみ出しを申告したのと同型である**(上の2ブロック)。
  // **当時 `c1b14d86f7425d08` → 今日 `0ab6f3533652ef9c`。****旧値を消さずに残す。**
  // 記録: `docs/plan/v6/records/v6-m13.md` §3(増えた3行の理由)。
  //
  // **【`V7-M2-T02`(`Z-G11`。権限名ごとの読む/書く/消すがサーバの判定に効く)が
  //   14個目のブロックを足した】**
  // **5件増え0件減った** —— **5件とも新設の検査 `src/server/access-control-verbs.test.ts` の
  // `KernelMetaStore` / `createApp` / `applyManifest` / `createRecord` / `appDbPath` である。**
  // **新しいシンボルは1つも増えていない** —— **`src/server/direct-create-suppression.test.ts`
  // が前4本を、`scripts/bench/fixture.ts` が `appDbPath` を既に採っている。**
  // **製品コードの層またぎは0件増えて0件減った**(新設は `src/server/` の検査1本だけである)。
  // **`ADR-0009` 限定2 を1バイトも引き直していない。****条文の主語3本(`normalizeSort` /
  // `sortErrorPath` / `validateSortKeys`)には1本も触れていない。**
  // **`Δ8` は発火していない** —— **`src/kernel/` の公開 export を1本も増やしていない**
  // (`git diff --numstat -- src/kernel/ schemas/` が0行)。
  // **【はみ出しを正直に書く】本ファイルは `V7-M2-T02` の発注書が名指しした変更対象ではない。**
  // **`V5-M2` / `V5-M7f` / `V6-M13` が同じはみ出しを申告したのと同型である**(上の3ブロック)。
  // **当時 `0ab6f3533652ef9c` → 今日 `c4f4a62bc0dfd012`。****旧値を消さずに残す。**
  // 記録: `docs/plan/v7/records/v7-m2.md` §2-2(増えた5行の理由)。
  //
  // **【`V7-M2-T03`(`Z-G13`。運営3ロール・宣言された利用者の種類との優先順位)が
  //   15個目のブロックを足した】**
  // **6件増え0件減った** —— **6件とも新設の検査
  // `src/server/access-control-role-precedence.test.ts` の `KernelMetaStore` / `createApp` /
  // `applyManifest` / `createRecord` / `appDbPath` / `validateManifestFull` である。**
  // **新しいシンボルは1つも増えていない** —— **前5本は直上の `V7-M2-T02` のブロックが
  // 同じ理由で採っており、`validateManifestFull` は `V7-M1-T05` が既に採っている。**
  // **製品コードの層またぎは0件増えて0件減った**(新設は `src/server/` の検査1本だけである)。
  // **`ADR-0009` 限定2 を1バイトも引き直していない。****条文の主語3本(`normalizeSort` /
  // `sortErrorPath` / `validateSortKeys`)には1本も触れていない。**
  // **`Δ8` は発火していない** —— **`src/kernel/` の公開 export を1本も増やしていない**
  // (`git diff --numstat -- src/kernel/ schemas/` が0行)。
  // **【はみ出しを正直に書く】本ファイルは `V7-M2-T03` の発注書が名指しした変更対象ではない。**
  // **`V5-M2` / `V5-M7f` / `V6-M13` / `V7-M2-T02` が同じはみ出しを申告したのと同型である。**
  // **当時 `c4f4a62bc0dfd012` → 今日 `b600b3e92daa1d14`。****旧値を消さずに残す。**
  // 記録: `docs/plan/v7/records/v7-m2.md` §2-3(増えた6行の理由)。
  //
  // **【`V7-M3-T02` による更新。上の文を1バイトも消していない】** —— **さらに5行増えた**
  // (`src/server/access-control-paths.test.ts` の `KernelMetaStore` / `createApp` /
  // `applyManifest` / `createRecord` / `appDbPath`)。**新しいシンボルは1つも増えていない** ——
  // **5本とも直上の `V7-M2-T02` / `V7-M2-T03` のブロックが同じ理由で採っている。**
  // **製品コードの層またぎは0件増えて0件減った**(新設は `src/server/` の検査1本だけである)。
  // **`ADR-0009` 限定2 を1バイトも引き直していない。****条文の主語3本には1本も触れていない。**
  // **`Δ8` は発火していない**(`git diff --numstat -- src/kernel/ schemas/` が0行)。
  // **【はみ出しを正直に書く】本ファイルは `V7-M3-T02` の発注書が名指しした変更対象ではない。**
  // **`V7-M2-T02` / `V7-M2-T03` が同じはみ出しを申告したのと同型である。**
  // **当時 `b600b3e92daa1d14` → 今日 `0f81adc72b19d133`。****旧値を消さずに残す。**
  // 記録: `docs/plan/v7/records/v7-m3.md` §2-2(増えた5行の理由)。
  //
  // **【`V7-M3-T03` による更新。上の文を1バイトも消していない】** —— **さらに5行増えた**
  // (`src/server/access-control-grant-write.test.ts` の `KernelMetaStore` / `createApp` /
  // `applyManifest` / `createRecord` / `appDbPath`)。**新しいシンボルは1つも増えていない** ——
  // **5本とも直上の `V7-M3-T02` のブロックが同じ理由で採っている。**
  // **製品コードの層またぎは0件増えて0件減った**(新設は `src/server/` の検査1本だけである)。
  // **`ADR-0009` 限定2 を1バイトも引き直していない。****条文の主語3本には1本も触れていない。**
  // **`Δ8` は発火していない**(`git diff --numstat -- src/kernel/ schemas/` が0行)。
  // **【はみ出しを正直に書く】本ファイルは `V7-M3-T03` の発注書が名指しした変更対象ではない。**
  // **`V7-M2-T02` / `V7-M2-T03` / `V7-M3-T02` が同じはみ出しを申告したのと同型である。**
  // **当時 `0f81adc72b19d133` → 今日 `297980d659e2cfd4`。****旧値を消さずに残す。**
  // 記録: `docs/plan/v7/records/v7-m3.md` §2-3(増えた5行の理由)。
  //
  // **【`V7-M3-T05` による更新。上の文を1バイトも消していない】** —— **さらに5行増えた**
  // (`src/server/access-control-stale-grant.test.ts` の `KernelMetaStore` / `createApp` /
  // `applyManifest` / `createRecord` / `appDbPath`)。**新しいシンボルは1つも増えていない** ——
  // **5本とも直上の `V7-M3-T02` / `V7-M3-T03` のブロックが同じ理由で採っている。**
  // **製品コードの層またぎは0件増えて0件減った**(新設は `src/server/` の検査1本だけである)。
  // **`ADR-0009` 限定2 を1バイトも引き直していない。****条文の主語3本には1本も触れていない。**
  // **`Δ8` は発火していない**(`git diff --numstat -- src/kernel/ schemas/` が0行)。
  // **【はみ出しを正直に書く】本ファイルは `V7-M3-T05` の発注書が名指しした変更対象ではない。**
  // **`V7-M2-T02` / `V7-M2-T03` / `V7-M3-T02` / `V7-M3-T03` が同じはみ出しを申告したのと同型である。**
  // **当時 `297980d659e2cfd4` → 今日 `368e4503815f0f69`。****旧値を消さずに残す。**
  // 記録: `docs/plan/v7/records/v7-m3.md` §2-5(増えた5行の理由)。
  //
  // **【`V7-M3-T06` による更新。上の文を1バイトも消していない】** —— **さらに5行増えた**
  // (`src/server/access-control-delete.test.ts` の `KernelMetaStore` / `createApp` /
  // `applyManifest` / `createRecord` / `appDbPath`)。**新しいシンボルは1つも増えていない** ——
  // **5本とも直上の `V7-M3-T03` / `V7-M3-T05` のブロックが同じ理由で採っている。**
  // **製品コードの層またぎは0件増えて0件減った**(新設は `src/server/` の検査1本だけである)。
  // **`ADR-0009` 限定2 を1バイトも引き直していない。****条文の主語3本には1本も触れていない。**
  // **`Δ8` は発火していない**(`git diff --numstat -- src/kernel/ schemas/` が0行)。
  // **【はみ出しを正直に書く】本ファイルは `V7-M3-T06` の発注書が名指しした変更対象ではない。**
  // **`V7-M2-T02` 以降の5タスクが同じはみ出しを申告したのと同型である。**
  // **当時 `368e4503815f0f69` → 今日 `c6b9459ef6c566c3`。****旧値を消さずに残す。**
  // 記録: `docs/plan/v7/records/v7-m3.md` §2-6(増えた5行の理由)。
  //
  // **【`V7-M3-T07` による更新。上の文を1バイトも消していない】** —— **さらに5行増えた**
  // (`src/server/access-control-file-delivery.test.ts` の `KernelMetaStore` / `createApp` /
  // `applyManifest` / `createRecord` / `appDbPath`)。**新しいシンボルは1つも増えていない** ——
  // **5本とも直上の `V7-M3-T06` のブロックが同じ理由で採っている。**
  // **製品コードの層またぎは0件増えて0件減った**(新設は `src/server/` の検査1本だけである)。
  // **`ADR-0009` 限定2 を1バイトも引き直していない。****条文の主語3本には1本も触れていない。**
  // **`Δ8` は発火していない**(`git diff --numstat -- src/kernel/ schemas/` が0行)。
  // **【はみ出しを正直に書く】本ファイルは `V7-M3-T07` の発注書が名指しした変更対象ではない。**
  // **`V7-M2-T02` 以降の6タスクが同じはみ出しを申告したのと同型である。**
  // **当時 `c6b9459ef6c566c3` → 今日 `cd0d211202829733`。****旧値を消さずに残す。**
  // 記録: `docs/plan/v7/records/v7-m3.md` §2-7(増えた5行の理由)。
  //
  // **【`V7-M3-T09`(`ADR-0296`)による更新。上の文を1バイトも消していない】** —— **さらに1行
  // 増えた**(`src/server/access-control-file-delivery.test.ts` の `appManifestPath`)。
  // **新しいシンボルの種類は0本である** —— **同じ検査ファイルが同じ `src/kernel/index.ts` から
  // 値を1つ増やして引いているだけである**(用途: **マニフェスト1ファイルを壊して fail-open を
  // 測る**)。
  // **製品コードの層またぎは0件増えて0件減った**(新設ファイルは0本である)。
  // **`ADR-0009` 限定2 を1バイトも引き直していない。****条文の主語3本には1本も触れていない。**
  // **`Δ8` は発火していない**(`git diff --numstat -- src/kernel/ schemas/` が0行)。
  // **【はみ出しを正直に書く】本ファイルは `V7-M3-T09` の発注書が名指しした変更対象ではない。**
  // **`V7-M2-T02` 以降の7タスクが同じはみ出しを申告したのと同型である。**
  // **当時 `cd0d211202829733` → 今日 `f2e802063d6bd155`。****旧値を消さずに残す。**
  // 記録: `docs/plan/v7/records/v7-m3.md` §2-9(増えた1行の理由)。
  //
  // **【`V7-M4-T02`(`Z-G14`。親 → 子 → 孫の3段)による更新。上の文を1バイトも消していない】**
  // —— **さらに5行増えた**(新設した `src/server/access-control-inheritance.test.ts` の
  // `KernelMetaStore` / `createApp` / `applyManifest` / `createRecord` / `appDbPath`)。
  // **新しいシンボルの種類は0本である** —— **`V7-M3-T06` / `V7-M3-T07` の検査ファイルと
  // 1シンボルも違わない組であり、同じ `src/kernel/index.ts` から引いている。**
  // **製品コードの層またぎは0件増えて0件減った** —— **引き継ぎの読み出しは
  // `src/server/owner-scope.ts` が**呼び出し側から渡されたコールバック**で受けるので、
  // 製品コードは値 import を1件も増やしていない**(`Z-G14` 限定7 = `src/kernel/` に
  // 1バイトも差分を出さない)。
  // **`ADR-0009` 限定2 を1バイトも引き直していない。****条文の主語3本には1本も触れていない。**
  // **`Δ8` は発火していない**(`git diff --numstat -- src/kernel/ schemas/` が0行)。
  // **【はみ出しを正直に書く】本ファイルは `V7-M4-T02` の発注書が名指しした変更対象ではない。**
  // **`V7-M2-T02` 以降の8タスクが同じはみ出しを申告したのと同型である。**
  // **当時 `f2e802063d6bd155` → 今日 `48935637b5ca2d31`。****旧値を消さずに残す。**
  // 記録: `docs/plan/v7/records/v7-m4.md` の `V7-M4-T02`(増えた5行の理由)。
  //
  // **【`V7-M4-T04`(`Z-G17`。段数と件数の上限)による更新。上の文を1バイトも消していない】**
  // —— **さらに10行増えた。****内訳は2本の検査ファイルであり、片方は取りこぼしの回収である**:
  //   1. **`src/server/access-control-cycle.test.ts` の5シンボル** ——
  //      **`V7-M4-T03` が新設した検査ファイルだが、そのときスナップショットの更新が漏れていた。**
  //      **`V7-M4-T04` の着手時点で `scripts/kernel-import-drift.test.ts` は既に赤であった**
  //      (本タスクが赤くしたのではない)。**回収したことを隠さない。**
  //   2. **`src/server/access-control-limit-honesty.test.ts` の5シンボル** ——
  //      **本タスクが新設した検査ファイル**(6段目の拒否・1001 行目の拒否・3状態の区別を
  //      **本物の HTTP と本物の SQLite** から測る)。
  // **新しいシンボルの種類は0本である** —— **10件とも `KernelMetaStore` / `createApp` /
  // `applyManifest` / `createRecord` / `appDbPath` の同じ5本であり、`V7-M4-T02` の組と
  // 1シンボルも違わない。**
  // **製品コードの層またぎは0件増えて0件減った** —— **上限の定数2本は
  // `src/server/owner-scope.ts` に在り、`src/kernel/` から値を1つも import していない。**
  // **`ADR-0009` 限定2 を1バイトも引き直していない。****条文の主語3本には1本も触れていない。**
  // **`Δ8` は発火していない**(`git diff --numstat d6a1f3d -- src/kernel/ schemas/` が0行)。
  // **【はみ出しを正直に書く】本ファイルは `V7-M4-T04` の発注書が名指しした変更対象ではない。**
  // **`V7-M2-T02` 以降の9タスクが同じはみ出しを申告したのと同型である。**
  // **当時 `48935637b5ca2d31` → 今日 `58f2e9ff95601b82`。****旧値を消さずに残す。**
  // 記録: `docs/plan/v7/records/v7-m4.md` の `V7-M4-T04`(増えた10行の理由)。
  //
  // **【`V7-M5-T01`(`Z-G18`。付与が1件も無い行は誰からも見えない)による更新。**
  // **上の文を1バイトも消していない】** —— **さらに6行増えた。**
  //   - **`src/server/record-access-visibility.test.ts` の6シンボル** ——
  //     **本タスクが新設した検査ファイル**(5通りの相手の生の応答・ページングの `total` と
  //     `_id` の集合の照合を、**本物の HTTP と本物の SQLite** から測る)。
  // **新しいシンボルの種類は0本である** —— **6件とも `KernelMetaStore` / `createApp` /
  // `applyManifest` / `createRecord` / `appDbPath` / `validateManifestFull` であり、
  // `V7-M2-T03` の組と1シンボルも違わない。**
  // **製品コードの層またぎは0件増えて0件減った** —— **本タスクは `src/server/` の製品コードに
  // 1行も足していない。****増えたのは検査ファイル1本だけである。**
  // **`ADR-0009` 限定2 を1バイトも引き直していない。****条文の主語3本には1本も触れていない。**
  // **`Δ8` は発火していない**(`git diff --numstat 7058683 -- src/kernel/ schemas/` が0行)。
  // **【はみ出しを正直に書く】本ファイルは `V7-M5-T01` の発注書が名指しした変更対象ではない。**
  // **`V7-M2-T02` 以降の10タスクが同じはみ出しを申告したのと同型である。**
  // **当時 `58f2e9ff95601b82` → 今日 `de3f2fe86313dfa3`。****旧値を消さずに残す。**
  // 記録: `docs/plan/v7/records/v7-m5.md` の `V7-M5-T01`(増えた6行の理由)。
  //
  // **【`V7-M5-T02`(`Z-G19`。「誰にも見えない行」を見つける運営専用の口)による更新。**
  // **上の文を1バイトも消していない】** —— **さらに6行増えた。**
  //   - **`src/server/record-access-orphans.test.ts` の6シンボル** ——
  //     **本タスクが新設した検査ファイル**(運営専用の口の生の応答・運営以外の 403 と
  //     未認証の 401・`limit` / `offset` の照合・この口から取れた行が通常の単件 `GET` では
  //     今日も 404 であることを、**本物の HTTP と本物の SQLite** から測る)。
  // **新しいシンボルの種類は0本である** —— **6件のうち5件は `V7-M5-T01` の組と同じで、
  // 残る1件の `deleteRecord` も `src/server/app.ts` / `src/mcp/tools/write.ts` が今日も
  // 値 import しているものである**(**新しいシンボルを1つも増やしていない**)。
  // **製品コードの層またぎは0件増えて0件減った** —— **本タスクが `src/server/` の製品コードに
  // 足したのは `src/kernel/` を1つも import しない述語と経路である。**
  // **`ADR-0009` 限定2 を1バイトも引き直していない。****条文の主語3本には1本も触れていない。**
  // **`Δ8` は発火していない**(`git diff --numstat 7058683 -- src/kernel/ schemas/` が0行)。
  // **【はみ出しを正直に書く】本ファイルは `V7-M5-T02` の発注書が名指しした変更対象ではない。**
  // **`V7-M2-T02` 以降の11タスクが同じはみ出しを申告したのと同型である。**
  // **当時 `de3f2fe86313dfa3` → 今日 `8e9726773d722455`。****旧値を消さずに残す。**
  // 記録: `docs/plan/v7/records/v7-m5.md` の `V7-M5-T02`(増えた6行の理由)。
  //
  // **【`V7-M5-T04`(`Z-G31`。付与の巻き戻し)による更新。上の文を1バイトも消していない】**
  // —— **さらに7行増えた。**
  //   - **`src/server/access-control-undo.test.ts` の7シンボル** ——
  //     **本タスクが新設した検査ファイル**(付与を作った後の `undo` / 付与を消した後の `undo` /
  //     `T02` の道からの発見 / `D-V7-25` の後からの有効化と一括の付与 / 消したユーザの id /
  //     添付ファイルの実体 / `redo` を、**本物の HTTP と本物の SQLite** から測る)。
  // **新しいシンボルの種類は0本である** —— **7件のうち5件は `V7-M5-T01` の組と同じで、
  // 残る2件のうち `snapshotDir` は `src/mcp/cp-5-scenario.test.ts` が、`redo` は
  // `src/mcp/tools/write.ts` / `web/test/theme-candidates.test.ts` が今日も値 import して
  // いるものである**(**新しいシンボルを1つも増やしていない**)。
  // **`redo` を値 import しているのは、`redo` に HTTP の口が1本も無いためである** ——
  // **状態を動かすところだけカーネルを直接呼び、結果の確認は HTTP で行う。**
  // **製品コードの層またぎは0件増えて0件減った** —— **本タスクは `src/` の製品コードに
  // 1行も足していない。****増えたのは検査ファイル1本だけである。**
  // **`ADR-0009` 限定2 を1バイトも引き直していない。****条文の主語3本には1本も触れていない。**
  // **`Δ8` は発火していない**(`git diff --numstat 7058683 -- src/kernel/ schemas/` が0行)。
  // **`src/kernel/undo.ts` / `src/kernel/snapshot.ts` は読むだけで1バイトも書き換えていない。**
  // **【はみ出しを正直に書く】本ファイルは `V7-M5-T04` の発注書が名指しした変更対象ではない。**
  // **`V7-M2-T02` 以降の12タスクが同じはみ出しを申告したのと同型である。**
  // **当時 `8e9726773d722455` → 今日 `5dafcee347424616`。****旧値を消さずに残す。**
  // 記録: `docs/plan/v7/records/v7-m5.md` の `V7-M5-T04`(増えた7行の理由)。
  //
  // **【`V7-M5-T06`(`Z-G20`。オプトインの証明を検査として置く。**計画外タスク**)による
  // 更新。上の文を1バイトも消していない】** —— **さらに3行増えた。**
  //   - **`src/server/access-control-optin.test.ts` の3シンボル** ——
  //     **本タスクが新設した検査ファイル**(`access_control` を1文字も書かない表と、同じ内容で
  //     `enabled: false` を書いた表の応答が、行の操作7本で**本文単位で一致する**こと、
  //     未認証でも `owner` でも一致すること、取り残し一覧の口が `enabled: false` では無く
  //     `enabled: true` では開くこと、付与表に行を作っても効かないこと、`change_table` を
  //     **HTTP から**投げて `enabled: true` に切り替えるとふるまいが変わることを、
  //     **本物の HTTP と本物の SQLite** から測る)。
  // **新しいシンボルの種類は0本である** —— **3件とも `V7-M5-T01` / `T02` / `T04` の組の内数
  // (`KernelMetaStore` / `createApp` / `applyManifest`)であり、新しいシンボルを1つも
  // 増やしていない。**
  // **`createRecord` / `appDbPath` は1つも import していない** —— **直上の3ブロックとここが
  // 違う。****行の作成・更新・削除を1件もカーネル直呼びで行わず、すべて HTTP を打っている**
  // (`Z-G20` 限定(3)「**測るのは HTTP の応答である**」を仕込みの側でも崩さないため)。
  // **製品コードの層またぎは0件増えて0件減った** —— **本タスクは製品コードに1行も足して
  // いない。****増えたのは検査ファイル1本だけである。**
  // **`ADR-0009` 限定2 を1バイトも引き直していない。****条文の主語3本には1本も触れていない。**
  // **`Δ8` は発火していない**(`git diff --numstat 9c4daf6 -- src/kernel/ schemas/` が0行)。
  // **【はみ出しを正直に書く】本ファイルは `V7-M5-T06` の発注書が名指しした変更対象ではない。**
  // **ただし発注書は「赤くなったら旧値を消さず注を足して更新する」と先に指示しており、
  // 本ブロックはその指示に従ったものである。****`V7-M2-T02` 以降の13タスクが同じはみ出しを
  // 申告したのと同型である。**
  // **当時 `5dafcee347424616` → 今日 `04ca3564284d47d7`。****旧値を消さずに残す。**
  // 記録: `docs/plan/v7/records/v7-m5.md` の `V7-M5-T06`(**計画外タスク**。増えた3行の理由)。
  //
  // **【`V8-M16-T05` / `T06`(`J-G3`)による基準値の更新。2026-08-09】**
  // **3件増え、0件減った。** 増えたのは**新しい検査ファイル1本から**である:
  //   `src/server/multi-role-http.test.ts:KernelMetaStore` / `createApp` / `applyManifest`
  //     —— **実効ロール集合(`{_auth_users.role の1値}` ∪ `{_auth_user_roles に在る付与}`)が
  //        判定に効くことを、**本物の HTTP と本物の SQLite** から測る検査である**
  //        (`J-G3` の限定の逐語「**複数の役割は和集合1本で合成する**」)。
  // **新しいシンボルの種類は0本である** —— **3件とも `V7-M5-T06` と同一の3点であり、
  // 新しいシンボルを1つも増やしていない。**
  // **製品コードの層またぎは0件増えて0件減った** —— **増えたのは検査ファイル1本だけである。**
  // **`ADR-0009` 限定2 を1バイトも引き直していない。****条文の主語3本には1本も触れていない。**
  // **`src/kernel/` と `schemas/` に本タスク経由の差分は1バイトも出していない。**
  // **当時 `04ca3564284d47d7` → 今日 `f5279aa01df3d935`。****旧値を消さずに残す。**
  //
  // **【`V8-M17`(`J-G6`〜`J-G11`)による基準値の更新。2026-08-09】**
  // **3件増え、0件減った。** 増えたのは**新しい検査ファイル1本から**である:
  //   `src/server/role-rules-enforcement.test.ts:KernelMetaStore` / `createApp` / `applyManifest`
  //     —— **面(役割に束ねた権限)が4対象それぞれで実際に止めることを、**本物の HTTP と
  //        本物の SQLite** から測る検査である**(`J-G6`〜`J-G11`)。
  // **新しいシンボルの種類は0本である** —— **3件とも `V8-M16` / `V7-M5-T06` と同一の3点。**
  // **製品コードの層またぎは0件増えて0件減った** —— **増えたのは検査ファイル1本だけである。**
  // **`src/server/owner-scope.ts` が足したのは `import type` 1行だけであり、
  //   本スナップショットは値の import しか採らないので1行も現れない。**
  // **`ADR-0009` 限定2 を1バイトも引き直していない。****条文の主語3本には1本も触れていない。**
  // **`src/kernel/` と `schemas/` に本タスク経由の差分は1バイトも出していない。**
  // **当時 `f5279aa01df3d935` → 今日 `6a477b2cf64b459c`。****旧値を消さずに残す。**
  // **【期待値を書き換えた理由: `V8-M18` / 台帳 `J-G12`〜`J-G16`】**
  // **`V8-M18` が新しい検査ファイル1本(`src/server/role-conditions-enforcement.test.ts`)から
  // 値 import を **4件** 足した**(`KernelMetaStore` / `applyManifest` / `createApp` /
  // `dryRunDiff`)。**4件とも `*.test.ts` であり、製品コードの層またぎは0件である。**
  // **`src/server/owner-scope.ts` の条件の評価器はカーネルから値を1つも import していない** ——
  // **深さの上限は適用時にカーネルが検査済みなので、評価器は定数を1つも持たない**(裁定 `R-17-4`)。
  // **`ADR-0009` 限定2 を1バイトも引き直していない。****条文の主語3本には1本も触れていない。**
  // **当時 `6a477b2cf64b459c` → 今日 `1fe9c78b58f3ce0b`。****旧値を消さずに残す。**
  // **【`V8-M19` による更新。旧値を1バイトも消していない】** **`V8-M19` の検査ファイル1本から
  // 3件増えた**(`KernelMetaStore` / `applyManifest` / `createApp`。**新しいシンボルの種類は
  // 0本で、製品コードの層またぎは0件**)。**`ADR-0009` 限定2 を1バイトも引き直していない。**
  // **当時 `1fe9c78b58f3ce0b` → `V8-M19` の時点で `9aa1c0d5c03531a5`。**
  //
  // **【`V8-M20` による更新。旧値を1バイトも消していない】** **`V8-M20`(既存の宣言を撤去する。
  // 台帳 `J-G27`〜`J-G30`。手続きは `ADR-0301`)の検査ファイル1本から**3件増えた**
  // (`KernelMetaStore` / `applyManifest` / `createApp`。**新しいシンボルの種類は0本で、
  // 製品コードの層またぎは0件**)。**`ADR-0009` 限定2 を1バイトも引き直していない。**
  // **【この一覧からは1行も減っていない】** —— **撤去で消えた3ファイルは、どれもカーネル
  // シンボルを値として import していなかった。****「層またぎが減った」とは書かない。**
  // **`V8-M19` の `9aa1c0d5c03531a5` → 今日 `8fdc72ddcfc8ed26`。**
  //
  // **【`V8-M21`(前半)による更新。旧値を1バイトも消していない】**
  // **`V8-M21`(受信口 / 登録をきっかけに動く処理 / コードの島に判定を配線する。
  // 台帳 `J-G21` / `J-G22a` / `J-G23`)で **16件増え、0件減った**。**
  // **内訳は 製品コード **1件** + 新しい検査ファイル2本から **15件** である** ——
  // **`V8-M16` 以降で初めて、製品コードの層またぎが1件増えた。丸めない。**
  //   `src/server/inbound-route.ts:listRecords`
  //     —— **受信口が、判定に要るメンバー表の行を読むために使う**(`J-G21` の限定の逐語
  //        「**その主体がメンバー表に行を持つときだけ通す**」)。
  //        **同ファイルは既に7件を値 import しており(`createRecord` /
  //        `readCurrentManifest` / `appDbPath` ほか)、新しい層またぎの**種類**は0本である。**
  //   `src/server/inbound-access-control.test.ts`(7件)/
  //   `src/server/automation-access-control.test.ts`(8件)
  //     —— **どちらも実 HTTP + 本物の SQLite。** **`runScheduledWorkflow` だけが
  //        新しいシンボルであり、**時刻起動が今日も素通りすることを実測する**ために要る
  //        (`D-V8-33` / `J-G22b` = 保留 / `docs/plan/undecided.md` の `U-3`)——
  //        **時刻起動には HTTP の入口が1本も無い。**
  // **`ADR-0009` 限定2 を1バイトも引き直していない**(16件のいずれも `normalizeSort` /
  //   `sortErrorPath` / `validateSortKeys` ではない)。**条文の主語3本に触れていない。**
  // **`schemas/` には本タスク経由の差分を1バイトも出していない**
  //   (`src/kernel/workflow-runner.ts` には判定の配線が入っている)。
  // **`V8-M20` の `8fdc72ddcfc8ed26` → 今日 `d369338409e161e0`。**
  //
  // **【`V8-M26` による更新。旧値を1バイトも消していない】**
  // **`V8-M26`(面の既定を閉じる / 作るたびに既定3役割の規則を自動で足す)で
  // **7件増え、0件減った**。** **全件が新しい検査ファイル2本から出ている** ——
  // **製品コードの層またぎは0件である**(`V8-M21` で1件増えたのとは違う)。
  //   `src/server/role-default-closed.test.ts`(3件)
  //     —— **`KernelMetaStore` / `applyManifest` / `createApp`。**
  //        **`src/server/role-rules-enforcement.test.ts` とまったく同じ3件であり、
  //        新しい層またぎの**種類**は0本である。**
  //   `src/server/role-default-grant-http.test.ts`(4件)
  //     —— **上の3件 + `applyDiff`。** **自動付与が走るのは差分の畳み込みだけなので、
  //        `applyDiff` を通らずには「作った直後から見える」を測れない**
  //        (`D-V8-56` の逐語「表を**作ると**…1行が自動で入ります」)。
  //        **`applyDiff` は既に `src/mcp/` / `src/cli/` / `web/test/` が値 import しており、
  //        新しい層またぎの**種類**は0本である。**
  // **`ADR-0009` 限定2 を1バイトも引き直していない**(7件のいずれも `normalizeSort` /
  //   `sortErrorPath` / `validateSortKeys` ではない)。**条文の主語3本に触れていない。**
  // **`V8-M21` の `d369338409e161e0` → 今日 `ddd0c538edf68850`。**
  //
  // **【`V8-M26-T05` による更新。旧値を1バイトも消していない】**
  // **`V8-M26-T05`(「ログインなしでも見せる」と書いた画面を、未ログインで実際に開ける。
  // 台帳 `T-G27b` の再審査 / `D-V8-57` / `D-V8-64`)で **3件増え、0件減った**。**
  // **全件が新しい検査ファイル1本から出ている** —— **製品コードの層またぎは0件である。**
  //   `src/server/anonymous-public-view.test.ts`(3件)
  //     —— **`KernelMetaStore` / `applyManifest` / `createApp`。**
  //        **`src/server/anonymous-view-audience.test.ts` /
  //        `src/server/role-default-closed.test.ts` とまったく同じ3件であり、
  //        新しい層またぎの**種類**は0本である。**
  //        **本物の SQLite に本物のマニフェストを適用しないと、`D-V8-64`(表にも規則を
  //        書いて初めて行が並ぶ)も、`anonymous` に項目の規則を書けないこと
  //        (適用時の拒否メッセージ2件)も測れない。**
  // **`ADR-0009` 限定2 を1バイトも引き直していない**(3件のいずれも `normalizeSort` /
  //   `sortErrorPath` / `validateSortKeys` ではない)。**条文の主語3本に触れていない。**
  // **`V8-M26` の `ddd0c538edf68850` → 今日 `3e8ed59ff72b02a3`。**
  //
  // **【`V8-M27-T03` による更新。旧値を1バイトも消していない】**
  // **`V8-M27-T03`(まとめ書き込みとファイルのアップロードに役割の規則を配線する。
  // ユーザ決定 `D-V8-71`)で **3件増え、0件減った**。**
  // **全件が新しい検査ファイル1本から出ている** —— **製品コードの層またぎは0件である**
  // (**`src/server/app.ts` に足したのは同じ `src/server/` 層の `owner-scope.ts` の
  //  述語の呼び出しだけであり、カーネルからの値 import は1件も増えていない**)。
  //   `src/server/batch-files-role-access.test.ts`(3件)
  //     —— **`KernelMetaStore` / `applyManifest` / `createApp`。**
  //        **`src/server/role-rules-enforcement.test.ts` /
  //        `src/server/role-default-closed.test.ts` とまったく同じ3件であり、
  //        新しい層またぎの**種類**は0本である。**
  //        **まとめ書き込みとファイルのアップロードを実 HTTP で叩き、本物の SQLite に
  //        役割の規則つきのマニフェストを適用しないと、「触る表を1つでも書けなければ
  //        要求全体が 403」も「着地しうる表への書込を1つも許されていない相手の
  //        アップロードが 403」も測れない。**
  // **`ADR-0009` 限定2 を1バイトも引き直していない**(3件のいずれも `normalizeSort` /
  //   `sortErrorPath` / `validateSortKeys` ではない)。**条文の主語3本に触れていない。**
  // **`V8-M26-T05` の `3e8ed59ff72b02a3` → 今日 `dc9acb8cbf4165ca`。**
  //
  // **【`V8-M27-T04` による更新。旧値を1バイトも消していない】**
  // **`V8-M27-T04`(「運営(予約3ロール)か否か」で表単位の可否を決める古い層の撤去。
  // 台帳 `T-G5` / ユーザ決定 `D-V8-38` / `D-V8-72` / `D-V8-73`)で **3件増え、0件減った**。**
  // **全件が新しい検査ファイル1本から出ている** —— **製品コードの層またぎは0件である。**
  // **`src/server/app.ts` からは値 import が2件**減って**いる**
  // (`isReservedRole` = `src/auth/types.ts` / `nonAdminTableAccess` = `src/server/owner-scope.ts`)
  // **が、どちらも `src/kernel/` ではないのでスナップショットの行は1つも減っていない。**
  //   `src/server/nonadmin-layer-removal.test.ts`(3件)
  //     —— **`KernelMetaStore` / `applyManifest` / `createApp`。**
  //        **`src/server/role-default-closed.test.ts` /
  //        `src/server/batch-files-role-access.test.ts` とまったく同じ3件であり、
  //        新しい層またぎの**種類**は0本である。**
  //        **本物の SQLite に役割の規則つきのマニフェストを適用しないと、
  //        「旧『運営テーブル』に読取の規則を1本書けば非運営にも読める」も
  //        「規則を書かなければ 200 + 0件 / 単件 404」も
  //        「定義が読めないときはファイルを誰にも配らない(`D-V8-73`)」も測れない。**
  // **`ADR-0009` 限定2 を1バイトも引き直していない**(3件のいずれも `normalizeSort` /
  //   `sortErrorPath` / `validateSortKeys` ではない)。**条文の主語3本に触れていない。**
  // **`V8-M27-T03` の `dc9acb8cbf4165ca` → 今日 `69fe232aaabecb0e`。**
  //
  // **【`D-V8-74` による更新。旧値を1バイトも消していない】**
  // **ユーザ決定 `D-V8-74`(2026-08-11。見出しの逐語「持ち主にだけ見せる」)で
  // **4件増え、0件減った**。** **全件が新しい検査ファイル1本から出ている** ——
  // **製品コードの層またぎは0件である**(`src/server/app.ts` が足したのは
  // `forbiddenSystemTableReadError` 1本と、既に値 import 済みだった `isSystemTableId`
  // (`src/shared/system-tables.ts`)の呼び出し1箇所だけであり、`src/kernel/` からの
  // 新しい値 import は1件も無い)。
  //   `src/server/system-table-owner-read.test.ts`(4件)
  //     —— **`KernelMetaStore` / `applyManifest` / `createApp` / `applyDiff`。**
  //        **前3件は `src/server/nonadmin-layer-removal.test.ts` /
  //        `src/server/role-default-closed.test.ts` /
  //        `src/server/batch-files-role-access.test.ts` とまったく同じ組であり、
  //        新しい層またぎの**種類**は0本である。**
  //        **4件目の `applyDiff` も新種ではない**(既に 22 箇所が値として import している)。
  //        **`_changelog` に `apply` の行を1件も作らずに測ると「持ち主には見える」が
  //        空配列でも通ってしまう** —— **`applyManifest` 経由の投入は `_changelog` に
  //        記録されない(`ADR-0006` §6b / CP-4 既知の限界①)ので、本物の差分を1本
  //        適用する以外に「中身が本当に返る」を測る手立てが無い。**
  // **`ADR-0009` 限定2 を1バイトも引き直していない**(4件のいずれも `normalizeSort` /
  //   `sortErrorPath` / `validateSortKeys` ではない)。**条文の主語3本に触れていない。**
  // **`V8-M27-T04` の `69fe232aaabecb0e` → 今日 `32546e7e2d8ffbed`。**
  test("限定3: `import` の基準値(`V5-M25` で5件・`V5-M17` で4件・`V5-M18` で7件・`V5-M26` で9件・`V5-M28` で3件 + 7件増え、`V5-M29` で3件増え9件減り、`V5-M2` で16件・`V5-M9` で8件・`V5-M6` で24件・`V5-M7` で6件・`V5-M7f` で4件・`V6-M13` で3件・`V7-M2` で5件 + 6件・`V7-M3` で5件 + 5件 + 5件 + 5件 + 5件 + 1件・`V7-M4` で5件 + 10件・`V7-M5` で6件 + 6件 + 7件 + 3件・`V8-M16` で3件・`V8-M17` で3件・`V8-M18` で4件・`V8-M19` で3件・`V8-M20` で3件・`V8-M21` で16件・`V8-M26` で7件 + 3件・`V8-M27-T03` で3件・`V8-M27-T04` で3件・`V8-M27`(`D-V8-74`)で4件・`V8-M28` 第2波で3件増えた)", async () => {
    // **旧の基準値(逐語。1バイトも消していない)**:
    // **`V8-M27-T03`**: `expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("dc9acb8cbf4165ca");`
    // **`V8-M27-T04`**: `expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("69fe232aaabecb0e");`
    // **`V8-M27`(`D-V8-74`)**: `expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("32546e7e2d8ffbed");`
    // **`V8-M28` 第2波(台帳 `T-G15` / `T-G18` / `T-G20`)**: **新しい検査ファイル1本
    // (`src/server/role-definition-distribution-http.test.ts`)が `KernelMetaStore` /
    // `applyManifest` / `createApp` の3件を値 import した。**
    // **製品コードの層またぎは0件である**(実装はすべて `src/server/` の中で閉じている)。
    // **`V8-M28` 第2波**: `expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("3b8927fb3f682eaf");`
    // **`V8-M29` 第1波(台帳 `T-G10` / ユーザ決定 `D-V8-78` / `D-V8-79` / `D-V8-80`)**:
    // **新しい検査ファイル1本(`src/server/role-value-domain.test.ts`)が
    // `KernelMetaStore` / `applyManifest` / `createApp` の3件を値 import した。**
    // **製品コードの層またぎは0件である**(実装は `src/server/` の中で閉じており、
    // `src/kernel/` からの値 import は1件も増えていない)。
    // **`ADR-0009` 限定2 を1バイトも引き直していない**(3件のいずれも `normalizeSort` /
    // `sortErrorPath` / `validateSortKeys` ではない)。
    // **`V8-M29` 第1波**: `expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("bad4d3309d2b4af7");`
    // **`V8-M30`(台帳 `T-G29` / ユーザ決定 `D-V8-47`)**: **新しい検査ファイル1本
    // (`src/server/grant-lockout-http.test.ts`)が `KernelMetaStore` / `applyManifest` /
    // `createApp` の3件を値 import した。**
    // **製品コードの層またぎは0件である**(`src/auth/store.ts` は判定を**注入**で受け取り、
    // `src/server/` を1本も import していない。`src/server/change-routes.ts` が受けたのも
    // 同じ層のクロージャ1本であり、`src/kernel/` からの値 import は1件も増えていない)。
    // **`ADR-0009` 限定2 を1バイトも引き直していない**(3件のいずれも `normalizeSort` /
    // `sortErrorPath` / `validateSortKeys` ではない)。
    // **`V8-M30`(第1波)**: `expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("36122aec268a05f3");`
    // **`V8-M30` 第2波(ユーザ決定 `D-V8-82`)**: **新しい検査ファイル1本
    // (`src/server/first-user-owner.test.ts`)が `KernelMetaStore` / `applyManifest` /
    // `createApp` の3件を値 import した。**
    // **製品コードの層またぎは0件である**(足したのは `src/server/auth-routes.ts` の
    // 中の関数1本だけである)。
    // **`ADR-0009` 限定2 を1バイトも引き直していない**(3件のいずれも `normalizeSort` /
    // `sortErrorPath` / `validateSortKeys` ではない)。
    // **`V8-M31`(台帳 `T-G21`〜`T-G25` / ユーザ決定 `D-V8-43` / `D-V8-46`)**: **3件増えた。**
    // **【前の6回と違い、製品コードの層またぎが 2件ある。隠さずに書く】** ——
    // **`src/mcp/tools/write.ts` が `getRecord` / `listRecords` を値 import した。**
    // **行ごとの判定は「その行」と「付与元の表の全行」を読まないと下せず、HTTP 側の
    // 読み手(`memoizedRowReaders`)は `src/server/` 内部の非 export 関数なので
    // MCP からは呼べない。** **同じ形の先例がカーネルの中にある**
    // (`src/kernel/workflow-runner.ts` の `judgeAutomationWrite` も生の `Database` から
    // 読み手を組んでいる)。
    // **残る1件は検査の下ごしらえ**(`src/mcp/tools/write.test.ts` の `createRecord`)。
    // **`ADR-0009` 限定2 を1バイトも引き直していない**(3件のいずれも `normalizeSort` /
    // `sortErrorPath` / `validateSortKeys` ではない)。
    // **`V8-M31` の旧の基準値(逐語。1バイトも消していない)**:
    // `expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("d36ca775e64d5c31");`
    // **`V8-M39`(台帳 `F-G7` / `F-G8`)**: **新しい検査ファイル1本
    // (`src/server/role-403-layer-message.test.ts`)が `KernelMetaStore` / `applyManifest` /
    // `createApp` の3件を値 import した。**
    // **製品コードの層またぎは0件である** —— **`src/server/app.ts` が足したのは
    // `src/server/owner-scope.ts` からの `import type { AccessLayerName }` 1本だけであり、
    // `import type` はこの表の対象外である**(`scripts/kernel-import-snapshot.txt` の
    // 先頭の注記の逐語:「**import type は含まない**」)。
    // **`ADR-0009` 限定2 を1バイトも引き直していない**(3件のいずれも `normalizeSort` /
    // `sortErrorPath` / `validateSortKeys` ではない)。
    // **`V8-M39` の旧の基準値(逐語。1バイトも消していない)**:
    // `expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("83488fe8d04492cc");`
    // **`V8-M41`(台帳 `F-G12` / `F-G13`)**: **新しい検査ファイル2本
    // (`src/server/not-a-member-guidance.test.ts` = 4件 /
    //  `src/server/role-unreachable-records.test.ts` = 5件)が、合わせて **9件** を値 import した。**
    // **製品コードの層またぎは0件である** —— **`src/server/app.ts` が足したのは
    // `src/server/owner-scope.ts` からの `resolveRecordUnreachableByRoles`(同じ層の中)
    // 1本だけであり、`src/server/owner-scope.ts` はカーネルからの値 import を1件も
    // 増やしていない。**
    // **9件はすべて既に他の検査が採っている組である**(`KernelMetaStore` / `appDbPath` /
    // `applyManifest` / `createApp` / `createRecord`)—— **新しい層またぎの種類は0本。**
    // **`ADR-0009` 限定2 を1バイトも引き直していない**(9件のいずれも `normalizeSort` /
    // `sortErrorPath` / `validateSortKeys` ではない)。
    // **`V8-M41` の旧の基準値(逐語。1バイトも消していない)**:
    // `expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("7693e2b3523e89c2");`
    // **`V8-M41` 後半(台帳 `F-G14` / `ADR-0332`)**: **6件増えた。**
    // **製品コードの層またぎが1件ある** —— **`src/server/auth-routes.ts:InboundStore`。**
    // **受信口の発行(`POST /api/apps/:app_id/inbound-endpoints`)を1本だけ結線したもので
    // あり、`src/kernel/inbound-store.ts` は1バイトも変えていない**(`issueInboundEndpoint`
    // は `ADR-0041` が既に置いたもので、ここは呼ぶだけである)。
    // **新しい層またぎの種類は0本である** —— **`auth-routes.ts` は既に
    // `AiCapabilityStore` / `CapabilityStore` / `EscapeHatchStore` の3ストアを、
    // 同じ理由(capability の発行 seam を owner の HTTP に結線する)で値 import しており、
    // `InboundStore` は4つ目である。**
    // **残る5件は新規検査 `src/server/inbound-endpoint-issuance.test.ts` の組であり、
    // `src/server/inbound-route.test.ts` が採っている組そのものである。**
    // **`ADR-0009` 限定2 を1バイトも引き直していない**(6件のいずれも `normalizeSort` /
    // `sortErrorPath` / `validateSortKeys` ではない)。
    // **`V8-M41` 後半の旧の基準値(逐語。1バイトも消していない)**:
    // `expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("d76d1436ab78e106");`
    // **`V8-M1-T04`(台帳 `I-G5` / `I-G7` / `I-G24` / `I-G26` = 4件とも 限定採用。
    // `ADR-0335`)**: **3件増えた。**
    // **製品コードの層またぎは0件である** —— **`src/server/auth-routes.ts` も
    // `src/server/app.ts` も `src/kernel/` からの値 import を1本も足していない**
    // (登録の可否の判定はサーバ層に閉じており、注入1本 `inviteOnlyRoleIds` が
    // マニフェストを読む役を `app.ts` 側に留めている。`ADR-0334` 限定7)。
    // **3件はすべて新規検査 `src/server/signup-mode-enforcement.test.ts` の組であり、
    // `src/server/role-default-closed.test.ts` /
    // `src/server/role-definition-distribution-http.test.ts` とまったく同じ
    // `KernelMetaStore` / `applyManifest` / `createApp` である** ——
    // **新しい層またぎの種類は0本。**
    // **`ADR-0009` 限定2 を1バイトも引き直していない**(3件のいずれも `normalizeSort` /
    // `sortErrorPath` / `validateSortKeys` ではない)。
    // **`V8-M1-T04` の旧の基準値(逐語。1バイトも消していない)**:
    // `expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("6c8a6e19e19c36d4");`
    // **`V8-M2-T04` / `V8-M2-T05`(台帳 `I-G9` / `I-G12` / `I-G13` / `I-G17` / `I-G18`。
    // `ADR-0336`)**: **4件増えた。**
    // **製品コードの層またぎは0件である** —— **`src/server/auth-routes.ts` は
    // `src/kernel/` からの値 import を1本も足していない**(招待の保管は `src/auth/store.ts`
    // に閉じており、カーネルの API を1本も呼ばない)。**`src/kernel/` と `schemas/` は
    // 1バイトも変えていない**(`ADR-0336` 限定6)。
    // **4件はすべて新規検査 `src/server/invitation-issuance.test.ts` の組であり、
    // `src/server/inbound-endpoint-issuance.test.ts`(1つ前の「発行の口」の検査)と
    // まったく同じ `KernelMetaStore` / `appDbPath` / `applyManifest` / `createApp` である** ——
    // **新しい層またぎの種類は0本。**
    // **巻き戻しの実測(`src/auth/undo-invitations.test.ts`)は1行も足していない** ——
    // **`SEARCH_ROOTS` が `src/auth` を含まないからである**(`ADR-0336` 限定10)。
    // **`ADR-0009` 限定2 を1バイトも引き直していない**(4件のいずれも `normalizeSort` /
    // `sortErrorPath` / `validateSortKeys` ではない)。
    // **`V8-M2` の旧の基準値(逐語。1バイトも消していない)**:
    // `expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("9d6ad43dc59586e7");`
    // **`V8-M3-T02`〜`T06`(台帳 `I-G19` / `I-G20` / `I-G22` / `I-G23`。`ADR-0337`)**:
    // **4件増えた。**
    // **製品コードの層またぎは0件である** —— **`src/server/auth-routes.ts` が足した値 import は
    // `findUsableInvitation`(`src/auth/invitations.ts`)と `InvitationUnavailableError`
    // (`src/auth/store.ts`)の2本であり、**どちらも `src/auth/` である**(`SEARCH_ROOTS` は
    // カーネルへの import だけを見る)。**`src/kernel/` と `schemas/` は1バイトも変えていない**
    // (`ADR-0337` 限定3)。
    // **4件はすべて新規検査 `src/server/invitation-redemption.test.ts` の組であり、
    // `src/server/invitation-issuance.test.ts`(1つ前の招待の検査)とまったく同じ
    // `KernelMetaStore` / `appDbPath` / `applyManifest` / `createApp` である** ——
    // **新しい層またぎの種類は0本。**
    // **`ADR-0009` 限定2 を1バイトも引き直していない**(4件のいずれも `normalizeSort` /
    // `sortErrorPath` / `validateSortKeys` ではない)。
    // **`V8-M3` の旧の基準値(逐語。1バイトも消していない)**:
    // `expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("93ab5966bf5f576c");`
    // **`V8-M4-T04`(台帳 `I-G3` / `I-G7` / `I-G24` / `I-G25`。`ADR-0334` / `ADR-0335`)**:
    // **4件増えた。**
    // **製品コードの層またぎは0件である** —— **`V8-M4` が触った非テストファイルは
    // `src/server/auth-routes.ts` / `src/auth/store.ts` / `src/auth/invitations.ts` の3本で、
    // 値 import を1本も足していない**(直したのは 403 の `hint` と、トランザクションを
    // `IMMEDIATE` にしたことと、今日は偽になったコード注釈である)。
    // **`src/kernel/` と `schemas/` と `web/` は1バイトも変えていない。**
    // **4件はすべて新規検査 `src/server/registration-default-and-lockout.test.ts` の組であり、
    // `src/server/invitation-redemption.test.ts`(1つ前の招待の検査)とまったく同じ
    // `KernelMetaStore` / `appDbPath` / `applyManifest` / `createApp` である** ——
    // **新しい層またぎの種類は0本。**
    // **`ADR-0009` 限定2 を1バイトも引き直していない**(4件のいずれも `normalizeSort` /
    // `sortErrorPath` / `validateSortKeys` ではない)。
    // **`V8-M4` の旧の基準値(逐語。1バイトも消していない)**:
    // `expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("4c959e1897c995d2");`
    // **`V8-M5-T06`(台帳 `I-G32` / `I-G33`。`ADR-0338` §3-4)**:
    // **4件増えた。**
    // **製品コードの層またぎは0件である** —— **`V8-M5` が触った非テストファイルは
    // `src/server/app.ts` / `src/server/auth-routes.ts` / `src/mcp/vocabulary.ts` /
    // `src/kernel/workflow-runner.ts` / `web/src/api.ts` / `web/src/auth/LoginPage.tsx` /
    // `web/src/AppWorkspace.tsx` / `web/src/runner-main.tsx` であり、**値 import を1本も
    // 足していない**(`web/` からの値 import は今日も `normalizeSort` の2箇所だけ)。
    // **`schemas/` は1バイトも変えていない。****`src/kernel/` への差分は注釈だけである。**
    // **4件はすべて新規検査 `src/server/user-creation-paths.test.ts` の組である。**
    // **うち3件は先行する検査群と同じ `KernelMetaStore` / `applyManifest` / `createApp`
    // であり、4件目の `resolveTable` は**本リポジトリで初の値 import**である** ——
    // **「`_auth_*` が解決しないこと」を測るのに解決の規則を写さないためであり、
    // 審査は `scripts/kernel-import-snapshot.txt` の該当ブロックに書いた。**
    // **`ADR-0009` 限定2 を1バイトも引き直していない**(4件のいずれも `normalizeSort` /
    // `sortErrorPath` / `validateSortKeys` ではない)。
    // **`V8-M5` の旧の基準値(逐語。1バイトも消していない)**:
    // `expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("0a91047de5d5c692");`
    // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】5件増えた。**
    // **`V8-M28` 第2波の旧の基準値(逐語。1バイトも消していない)**:
    // `expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("90197cf90fc1410a");`
    // **増えた5件の内訳**: `scripts/vocabulary-drift.test.ts:VIEW_TYPES`(中央の検査が
    // 4本目の主題として画面種別を見張るようになった)/ `src/server/app.ts:computeReport`
    // (**製品コードの層またぎ1件。集計表の計算をカーネルから呼ぶ**)/
    // 新規検査 `src/server/report-declaration-boundary.test.ts` の3件
    // (`KernelMetaStore` / `applyManifest` / `createApp`。**先行する検査群と同じ組**)。
    // **`ADR-0009` 限定2 を1バイトも引き直していない**(5件のいずれも `normalizeSort` /
    // `sortErrorPath` / `validateSortKeys` ではない)。
    // **【2026-08-14。`V8-M9`。台帳 `Q-G6`〜`Q-G9`。門A 本審査 = `V8-M7`】3件増えた。**
    // **`V8-M8` の旧の基準値(逐語。1バイトも消していない)**:
    // `expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("837f88e35fde7e9a");`
    // **増えた3件の内訳**: **新規検査 `src/server/report-join-boundary.test.ts` の
    // `KernelMetaStore` / `applyManifest` / `createApp`。****直前の `V8-M8` が載せた
    // `src/server/report-declaration-boundary.test.ts` とまったく同じ組であり、
    // 新しいシンボルは1つも無い。**
    // **製品コードの層またぎは0件である** —— **`src/server/app.ts` に値 import を1本も
    // 足していない**(結合は `computeReport` の中で完結しており、入口は今日も1回呼ぶだけ)。
    // **`web/src/` にも `src/mcp/` にも1本も足していない。**
    // **`ADR-0009` 限定2 を1バイトも引き直していない**(3件のいずれも `normalizeSort` /
    // `sortErrorPath` / `validateSortKeys` ではない)。
    // **【2026-08-15。`V8-M10-T03`。台帳 `Q-G13` / `Q-G15`。門A 本審査 = `V8-M7`】7件増えた。**
    // **`V8-M9` の旧の基準値(逐語。1バイトも消していない)**:
    // `expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("6e3975c7bbcf40e5");`
    // **増えた7件の内訳**: **新規検査 `src/server/report-visibility.test.ts` の5件**
    // (`KernelMetaStore` / `applyManifest` / `createApp` / `createRecord` / `appDbPath`。
    // **`V1-M1-T04` の注記が名指しした「`web/test/composite-sort.test.tsx` が既に採っている
    // のと同一の組」であり、新しいシンボルは1つも無い**)**+
    // `src/server/list-view-sum-boundary.test.ts` の2件**(`appDbPath` / `createRecord`)。
    // **後者は `V8-M10-T03` が足したものではない** —— **`V8-M10-T06`(コミット `01c0ad6`)が
    // 足した import であり、その時点で台帳が更新されていなかった。**
    // **`T03` の着手時点で `scripts/kernel-import-drift.test.ts` は既に赤かった**(実測)。
    // **製品コードの層またぎは0件である** —— **`src/server/app.ts` に値 import を1本も
    // 足していない**(可視性は既存の `owner-scope.ts` の綴りで呼んでおり、`computeReport` の
    // 呼び出しは今日も1回である)。**`web/src/` にも `src/mcp/` にも1本も足していない。**
    // **`ADR-0009` 限定2 を1バイトも引き直していない**(7件のいずれも `normalizeSort` /
    // `sortErrorPath` / `validateSortKeys` ではない)。
    // **【2026-08-15。`V8-M10-T05`。台帳 `Q-G17` / `Q-G18` / `Q-G19`。裁定 `M7-1`】5件増えた。**
    // **`V8-M10-T03` の旧の基準値(逐語。1バイトも消していない)**:
    // `expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("f809f3fab148b8fa");`
    // **増えた5件はすべて新規検査 `src/server/report-limit-boundary.test.ts` の組であり、
    // 直前の `src/server/report-visibility.test.ts` とまったく同じ5つである**
    // (`KernelMetaStore` / `applyManifest` / `createApp` / `createRecord` / `appDbPath`)——
    // **新しいシンボルも新しい種類も1つも無い。**
    // **製品コードの層またぎは0件である** —— **`src/server/app.ts` が足した値 import は
    // `./report-limits.ts`(新設。同じ `src/server/` の中)と `./errors.ts` の
    // `reportLimitError` の2本だけであり、どちらもカーネルではない。**
    // **`src/kernel/report.ts` は1バイトも触っていない**(上限も判定もカーネルに置かない)。
    // **`ADR-0009` 限定2 を1バイトも引き直していない**(5件のいずれも `normalizeSort` /
    // `sortErrorPath` / `validateSortKeys` ではない)。
    // **【2026-08-15。`V8-M13-T01`。台帳 `Q-G38`】5件増えた。**
    // **`V8-M10-T05` の旧の基準値(逐語。1バイトも消していない)**:
    // `expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("9ee907e16465de02");`
    // **増えた5件はすべて新規検査 `src/server/report-undo-boundary.test.ts` の組である**
    // (`KernelMetaStore` / `createApp` / `appDbPath` / `redo` / `previewRedo`)——
    // **新しいシンボルは1つも無い**(5つとも足す前から台帳に在る。実測で `redo` 3件 /
    // `previewRedo` 2件 / `createApp` 120件 / `KernelMetaStore` 126件 / `appDbPath` 65件)。
    // **`redo` には HTTP の口が1本も無い**(`POST /api/apps/:id/redo` も
    // `GET /redo/preview` も 404。`T01` が実測した)——
    // **したがって「巻き戻して、戻す」を HTTP だけで検査することはできず、
    // `V8-M12-T02` が採った「層またぎを避けて HTTP へ倒す」作法はこの2本には使えない。**
    // **製品コードの層またぎは0件である** —— **`src/kernel/undo.ts` にも
    // `src/server/app.ts` にも1バイトも触っていない**(`T01` が触ったのは検査1本だけ)。
    // **`ADR-0009` 限定2 を1バイトも引き直していない**(5件のいずれも `normalizeSort` /
    // `sortErrorPath` / `validateSortKeys` ではない)。
    // **【2026-08-16。`V8-M50`。台帳 `O-G30`】3件増えた。**
    // **`V8-M13-T01` の旧の基準値(逐語。1バイトも消していない)**:
    // `expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("0b547c0940c588f0");`
    // **増えた3件はすべて新規の種まき `scripts/mcp-trial/seed-shared-app.ts` とその検査の組である**
    // (`KernelMetaStore` / `createApp`)—— **新しいシンボルは1つも無い。**
    // **どちらも隣の `scripts/mcp-trial/seed.ts` が足す前から値として import しており**
    // (台帳の `scripts/mcp-trial/seed.ts:KernelMetaStore` / `:createApp` の2行)、
    // **同じ層・同じ用途である。**
    // **理由**: **`V8-M31` 以降、アプリを名指しする MCP ツールは「名乗った利用者がその
    // アプリに登録されていること」を要求し**(`src/mcp/actor-guard.ts`)、**`create_app` は
    // 利用者を1人も作らない。** **したがって前後比較の試行を走らせるには、空のアプリ1つと
    // 登録済みの利用者1人を、走行の前にカーネル経由で作るしかない。**
    // **製品コードの層またぎは0件である** —— **`src/kernel/` にも `schemas/` にも1バイトも
    // 触っていない**(`git diff --numstat 7be6158..HEAD -- src/kernel/ schemas/` が空)。
    // **`ADR-0009` 限定2 を1バイトも引き直していない**(3件のいずれも `normalizeSort` /
    // `sortErrorPath` / `validateSortKeys` ではない)。
    // **【2026-08-23。`V10-M10-T01`。台帳 `CM-G3`。判定値 = 限定採用】1件増えた。**
    // **`V8-M50` の旧の基準値(逐語。1バイトも消していない)**:
    // `expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("2931e54be9968ff4");`
    // **増えた1件は既存の検査 `scripts/build-runner-data.test.ts` が `CommentStore` を
    // 値として import した行である** —— **足した識別子を名指しすると
    // `scripts/build-runner-data.test.ts:CommentStore` の1本ちょうど。**
    // **新しいシンボルではあるが、新しい層またぎではない** —— 隣に `EscapeHatchStore` /
    // `InboundStore` / `CapabilityStore` / `AiCapabilityStore` が既に値として並んでおり、
    // いずれも「横断テーブルに種を播く」ための import で、同じ層・同じ用途である。
    // **`comment-store.ts` 自体はこの台帳を1ミリも動かさない**(`kernel-import-drift.test.ts` の
    // `SEARCH_ROOTS` に `src/kernel` が無い)。**動かしたのは
    // `APP_SCOPED_KERNEL_TABLES` に `gp_comments` を足したことである** ——
    // 種まきを1行積まないと `SQLiteError: no such table: gp_comments` で落ちる。
    // **製品コードの層またぎは0件である** —— **`schemas/` に1バイトも触っていない。**
    // **`ADR-0009` 限定2 を1バイトも引き直していない**(`CommentStore` は `normalizeSort` /
    // `sortErrorPath` / `validateSortKeys` ではない)。
    // **当時 `2931e54be9968ff4` → 今日 `9d1d8fcda452c490`。****旧値を消さずに残す。**
    // **【2026-08-24。`V10-M10-T03`。台帳 `CM-G3`。判定値 = 限定採用】4件増えた。**
    // **`V10-M10-T01` の旧の基準値(逐語。1バイトも消していない)**:
    // `expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("9d1d8fcda452c490");`
    // **増えた4件は、本工程が新設した検査 `src/server/comment-backup-inclusion.test.ts` が
    // カーネルから値として import した行である** —— **名指しすると
    // `:CommentStore` / `:KernelMetaStore` / `:applyManifest` / `:createApp` の4本ちょうど。**
    // **「1行足す」ではなかった** —— **日次バックアップの世代に `apps/<app_id>/app.sqlite` が
    // 生まれるにはアプリが1本以上要り**(アプリが0本だと世代の中身は `kernel.sqlite` の1件だけで、
    // 陰性対照が「存在しないファイルに無いと言う」空回りになる)、**そのために
    // `KernelMetaStore.open` → `createApp` → `applyManifest` を前段で通したためである。**
    // **新しいシンボルでも新しい層またぎでもない** —— **`KernelMetaStore` / `applyManifest` /
    // `createApp` の3本は `src/server/backup.test.ts` が既に同じ形で値 import しており**、
    // **`CommentStore` は `scripts/build-runner-data.test.ts` が既に値 import している**
    // (`V10-M10-T01` が足した1件)。**同じ層・同じ用途である。**
    // **製品コードの層またぎは0件である** —— **足したのは検査2本と基準1本だけで、
    // `src/kernel/` にも `src/server/` の製品コードにも `schemas/` にも1バイトも触っていない。**
    // **`ADR-0009` 限定2 を1バイトも引き直していない**(4件のいずれも `normalizeSort` /
    // `sortErrorPath` / `validateSortKeys` ではない)。
    // **当時 `9d1d8fcda452c490` → 今日 `30a5943fb94261b7`。****旧値を消さずに残す。**
    // **【2026-08-24。`V10-M11-T01`。台帳 `CM-G4` = **門外**(`Δ7`)/ 判定値 = 限定採用】6件増えた。**
    // **`V10-M10-T03` の旧の基準値(逐語。1バイトも消していない)**:
    // `expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("30a5943fb94261b7");`
    // **増えた6件の内訳**: **製品コードは `src/server/auth-routes.ts:CommentStore` の1件ちょうど**
    // (HTTP の書込の口が器を**呼ぶだけ**のための値 import)、**残る5件は新設の検査
    // `src/server/comment-api.test.ts` の分**(`COMMENT_ANCHOR_FORMS` / `CommentStore` /
    // `KernelMetaStore` / `applyManifest` / `createApp`)。
    // **新しい層またぎの向きは1つも作っていない** —— **`auth-routes.ts` には
    // `CapabilityStore` / `EscapeHatchStore` / `AiCapabilityStore` / `InboundStore` が既に
    // 値として並んでおり、いずれも「カーネルの器を HTTP の口から呼ぶ」ための import である。**
    // **`src/kernel/` にも `schemas/` にも1バイトも触っていない**(`CM-G4` 限定4)。
    // **`ADR-0009` 限定2 を1バイトも引き直していない**(6件のいずれも `normalizeSort` /
    // `sortErrorPath` / `validateSortKeys` ではない)。
    // **当時 `30a5943fb94261b7` → 今日 `4b65813f4b3a8ee4`。****旧値を消さずに残す。**
    // **【2026-08-24。`V10-M11-T01` の2手目。台帳 `CM-G4`】1件増えた。**
    // **1手目の旧の基準値(逐語。1バイトも消していない)**:
    // `expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("4b65813f4b3a8ee4");`
    // **増えた1件は新設の検査 `web/test/comment-panel.test.tsx:COMMENT_ANCHOR_FORMS` である** ——
    // **画面から指せる宛先の形と部品の数を、手で焼かずに登録簿から導くために要る。**
    // **製品コードの層またぎは0件である** —— **`web/src/CommentPanel.tsx` は
    // `CommentAnchorForm` を**型としてだけ** import しており、`import type` は本台帳の対象外である。**
    // **`src/kernel/` にも `schemas/` にも1バイトも触っていない**(`CM-G4` 限定4)。
    // **当時 `4b65813f4b3a8ee4` → 今日 `ce7255bebe5caa98`。****旧値を消さずに残す。**
    // **【2026-08-24。`V10-M11-T02`。台帳 `CM-G5` = **門外**(`Δ7`)/ 判定値 = 限定採用】3件増えた。**
    // **`V10-M11-T01` の2手目の旧の基準値(逐語。1バイトも消していない)**:
    // `expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("ce7255bebe5caa98");`
    // **増えた3件はすべて新設の検査 `src/server/comment-visibility.test.ts` の分である**
    // (`COMMENT_ANCHOR_FORMS` / `CommentStore` / `foldOperations`)。
    // **`CommentStore` は器の直読みで題材の行を作るため**(**`V10-M11-T02` の時点で
    // コメントを読み出せる HTTP の口も MCP の道具も1本も無い**)、
    // **`COMMENT_ANCHOR_FORMS` は画面宛ての形を手で焼かずに登録簿から導くため**、
    // **`foldOperations` は「実物の `remove_view` を当てたあと」を測るためである**
    // (**規則を手で外した題材で緑にしない**)。
    // **製品コードの層またぎは0件である** —— **合成の本体
    // `src/server/comment-visibility.ts` は `src/kernel/comment-store.ts` から
    // `Comment` を**型としてだけ** import しており、`import type` は本台帳の対象外である。**
    // **`src/kernel/` にも `schemas/` にも1バイトも触っていない**(`CM-G5` 限定2)。
    // **`ADR-0009` 限定2 を1バイトも引き直していない**(3件のいずれも `normalizeSort` /
    // `sortErrorPath` / `validateSortKeys` ではない)。
    // **当時 `ce7255bebe5caa98` → 今日 `b17b787a8a326376`。****旧値を消さずに残す。**
    // **【2026-08-24。`V10-M12-T01`(`CM-G7` / 門A / 限定採用 / `ADR-0368`)】**
    // **`V10-M11-T02` の旧の基準値(逐語。1バイトも消していない)**:
    // `expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("b17b787a8a326376");`
    // **増えた2件は `src/mcp/tools/read.ts:CommentStore`(製品コード)と
    // `src/mcp/tools/list-comments.test.ts:CommentStore`(テスト)である。**
    // **今度は製品コードの層またぎが1件増えている** —— **`V10-M11-T02` の3件が
    // 全部テストだったのとは違う。** **丸めない。**
    // **なぜ要るのか**: **可視性の合成 `src/server/comment-visibility.ts` は器を1度も
    // 開かない**(`{ manifest, roles, comments }` を受け取る形である)。 **したがって
    // `list_comments` の側が器を開くしかない。**
    // **`src/kernel/` にも `schemas/` にも1バイトも触っていない。**
    // **`ADR-0009` 限定2 を1バイトも引き直していない**(2件とも `normalizeSort` /
    // `sortErrorPath` / `validateSortKeys` ではない)。
    // **当時 `b17b787a8a326376` → 今日 `8e212187a0d5acb0`。****旧値を消さずに残す。**
    // **【2026-08-24。`V10-M13-T01`(`CM-G10` / 門A / 限定採用 / `ADR-0369`。裁定6)】1件増えた。**
    // **`V10-M12-T01` の旧の基準値(逐語。1バイトも消していない)**:
    // `expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("8e212187a0d5acb0");`
    // **増えた1件は `src/server/comment-api.test.ts:appDbPath` である**(テスト)。
    // **「セッションは有効だが指す利用者がもう居ない」行を作るため、`app.sqlite` を直に
    // 開いて `_auth_users` の行だけを消す検査を1本足した(`CM-G10` 限定2 の実地の担保)。**
    // **製品コードの層またぎは0件である** —— **`src/server/auth-routes.ts` の新設
    // `resolveOptionalUser` は `appDbPath` を1度も値 import していない
    // (`AuthStore` / `resolveSession` / `getCookie` だけを使う)。**
    // **`appDbPath` は本台帳では新しい綴りではない**(多数の既存テストが既に値 import
    // している)——**新しいのは `comment-api.test.ts` という**ファイル**との組である。**
    // **`src/kernel/` にも `schemas/` にも1バイトも触っていない**(`CM-G10` 限定4 / 限定5)。
    // **`ADR-0009` 限定2 を1バイトも引き直していない**(`appDbPath` は `normalizeSort` /
    // `sortErrorPath` / `validateSortKeys` ではない)。
    // **当時 `8e212187a0d5acb0` → 今日 `16d23c133e3f3033`。****旧値を消さずに残す。**
    // **【2026-08-24。`V10-M13-T02`(`CM-G19` / 門A / 限定採用 / `ADR-0369`。裁定6)】1件増えた。**
    // **`V10-M13-T01` の旧の基準値(逐語。1バイトも消していない)**:
    // `expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("16d23c133e3f3033");`
    // **増えた1件は `src/server/comment-api.test.ts:COMMENT_STATES` である**(テスト)。
    // **裁定6(`RULINGS-M13.md`)により、手書きの配列を置かず「値として import する側」を
    // 採ったため、この検査が新しく赤くなった。**
    // **製品コードの層またぎは0件である** —— **`src/server/auth-routes.ts` の update 枝は
    // `state` を文字列のまま `updateCommentState` へ渡すだけで、`COMMENT_STATES` を
    // 1度も値 import していない。**
    // **`src/kernel/` にも `schemas/` にも1バイトも触っていない**(`CM-G19` 限定6)。
    // **当時 `16d23c133e3f3033` → 今日 `eb287b03d8286e6e`。****旧値を消さずに残す。**
    // **【2026-08-24。`V10-M13-T03`(`CM-G20` / 門A / 限定採用 / `ADR-0369`。裁定6)】もう1件増えた。**
    // **`V10-M13-T02` の旧の基準値(逐語。1バイトも消していない)**:
    // `expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("eb287b03d8286e6e");`
    // **増えた1件は `src/server/comment-api.test.ts:validateDiff` である**(テスト。
    // §6-3 (6) / (7) の完了条件を実出力で示すために値 import した)。
    // **製品コードの層またぎは0件である** —— **`src/kernel/comment-store.ts` は
    // `validateDiff` を1度も値 import していない**(限定3の式で実測済み)。
    // **`src/kernel/` にも `schemas/` にも1バイトも触っていない**(`CM-G20` 限定4 / 限定5)。
    // **当時 `eb287b03d8286e6e` → 今日 `f022d5745e470fa1`。****旧値を消さずに残す。**
    // **【2026-08-25。`V10-M28-T03`(ドライランの報告から認証まわりを落とす)】もう1件増えた。**
    // **`V10-M13-T03` の旧の基準値(逐語。1バイトも消していない)**:
    // `expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("f022d5745e470fa1");`
    // **増えた1件は `src/mcp/tools/read.test.ts:dryRunDiff` である**(テスト。
    // **落とす層が MCP であってカーネルではないこと**を実出力で示すために値 import した)。
    // **製品コードの層またぎは0件である** —— **`src/mcp/tools/read.ts` は着手前から
    // `dryRunDiff` を値 import しており、新しい綴りを1つも足していない**
    // (`V10-M28` が `read.ts` に足した import 2本は `src/auth/` と `src/mcp/` であり、
    //  どちらも `src/kernel/` ではない)。
    // **`src/kernel/` にも `schemas/` にも1バイトも触っていない。**
    // **当時 `f022d5745e470fa1` → 今日 `e6e9478e7bf58c50`。****旧値を消さずに残す。**
    // **【`V10-M30-T01`(`CM-G36` / `ADR-0377`)。2026-08-25】**
    // **旧の基準値(逐語。1バイトも消していない)**:
    // `expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("e6e9478e7bf58c50");`
    // **3件増え、0件減った** —— **3件とも新規テスト
    // `src/server/comment-visibility-backup-inclusion.test.ts` のセットアップ
    // (`KernelMetaStore` / `applyManifest` / `createApp`)であり、同ディレクトリの
    // `comment-backup-inclusion.test.ts` が既に値 import している同じ3本である。**
    // **新しい層またぎの種類は0本であり、製品コードの層またぎは0件である。**
    // **当時 `e6e9478e7bf58c50` → 今日 `42793625f13b3596`。****旧値を消さずに残す。**
    // **【`V10-M31-T01`(`CM-G38` / `ADR-0377`)。2026-08-25】**
    // **旧の基準値(逐語。1バイトも消していない)**:
    // `expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("42793625f13b3596");`
    // **3件増え、0件減った** —— **3件とも新規テスト
    // `src/server/comment-visibility-http.test.ts` のセットアップ
    // (`KernelMetaStore` / `applyManifest` / `createApp`)であり、直前の `V10-M30-T01` が
    // `comment-visibility-backup-inclusion.test.ts` で採ったのと同じ綴りの3本である。**
    // **新しい層またぎの種類は0本であり、製品コードの層またぎは0件である**
    // (`src/server/app.ts` が足したのは既存の `withStore` 経由の
    //  `store.getCommentVisibility(appId)` 1本で、`import` を1件も増やしていない)。
    // **`ADR-0009` 限定2 を1バイトも引き直していない**(3件のいずれも `normalizeSort` /
    // `sortErrorPath` / `validateSortKeys` ではない)。
    // **`src/kernel/` にも `schemas/` にも1バイトも触っていない**(`Δ8` は発火していない)。
    // **当時 `42793625f13b3596` → `2833bf4554e418f9`。****旧値を消さずに残す。**
    // **【同日の打ち直し】** 台帳の記号を `CM-G37`(道具の単位)から **`CM-G38`**(本単位)へ
    // 直したので、注記1行ぶんだけ基準の中身が動いた。**`2833bf4554e418f9` → 今日 `947544fa935e1113`。**
    // **層またぎの3行そのものは1バイトも動いていない**(動いたのは注記だけである)。
    // **【`V14-M1-T01` / `V14-M1-T02` / `V14-M1-T03`(台帳 `RB-G1` / `RB-G2` / `RB-G3`)。
    //   2026-09-05】**
    // **旧の基準値(逐語。1バイトも消していない)**:
    // `expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("947544fa935e1113");`
    // **5件増え、0件減った** —— **5件とも新規テスト
    // `src/server/record-row-access-response.test.ts` のセットアップ
    // (`KernelMetaStore` / `appDbPath` / `applyManifest` / `createApp` / `createRecord`)
    // であり、`record-access-visibility.test.ts` が着手前から値 import している
    // 同じ綴りである。**
    // **新しい層またぎの種類は0本であり、製品コードの層またぎは0件である**
    // (`src/server/app.ts` / `src/server/owner-scope.ts` は `src/kernel/` からの
    //  `import` を1件も増やしていない)。
    // **`ADR-0009` 限定2 を1バイトも引き直していない**(5件のいずれも `normalizeSort` /
    // `sortErrorPath` / `validateSortKeys` ではない)。
    // **`src/kernel/` にも `schemas/` にも1バイトも触っていない**(`Δ8` は発火していない)。
    // **当時 `947544fa935e1113` → 今日 `0ce746140395db96`。****旧値を消さずに残す。**
    // **【`V15-M2-T01`(台帳 `CR-G1`。`ADR-0404`)。2026-09-06】**
    // **旧の基準値(逐語。1バイトも消していない)**:
    // `expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("0ce746140395db96");`
    // **5件増え、0件減った** —— **5件とも新規テスト
    // `src/server/create-parent-write.test.ts` のセットアップ
    // (`KernelMetaStore` / `appDbPath` / `applyManifest` / `createApp` / `createRecord`)
    // であり、`access-control-inheritance.test.ts` が着手前から値 import している
    // 同じ綴りである。**
    // **新しい層またぎの種類は0本であり、製品コードの層またぎは0件である**
    // (`src/server/app.ts` / `src/server/owner-scope.ts` は `src/kernel/` からの
    //  `import` を1件も増やしていない。`ADR-0404` 限定8)。
    // **`ADR-0009` 限定2 を1バイトも引き直していない**(5件のいずれも `normalizeSort` /
    // `sortErrorPath` / `validateSortKeys` ではない)。
    // **`src/kernel/` にも `schemas/` にも1バイトも触っていない**(`Δ8` は発火していない)。
    // **当時 `0ce746140395db96` → 今日 `10e788de32d696f1`。****旧値を消さずに残す。**
    // **【`V15-M3-T01`(台帳 `CR-G5`)による更新。旧の基準値を1バイトも消していない】**
    // **旧: `expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("10e788de32d696f1");`**
    // **5件増え、0件減った** —— **5件とも新規テスト
    // `src/server/batch-create-parent-write.test.ts` のセットアップ
    // (`KernelMetaStore` / `appDbPath` / `applyManifest` / `createApp` / `createRecord`)
    // であり、すぐ上の `create-parent-write.test.ts` とまったく同じ5シンボルである
    // (題材が同一で、撃つ口だけが単件 `POST` からまとめ書き `POST /batch` に変わった)。**
    // **新しい層またぎの種類は0本であり、製品コードの層またぎは0件である**
    // (`src/server/app.ts` は `src/kernel/` からの `import` を1件も増やしていない。
    //  `ADR-0404` 限定8)。
    // **`ADR-0009` 限定2 を1バイトも引き直していない**(5件のいずれも `normalizeSort` /
    // `sortErrorPath` / `validateSortKeys` ではない)。
    // **`src/kernel/` にも `schemas/` にも1バイトも触っていない**(`Δ8` は発火していない)。
    // **当時 `10e788de32d696f1` → 今日 `ff800c5520c0c79e`。****旧値を消さずに残す。**
    // **【`V17-M4-T03`(台帳 `AC-G21`)による更新。旧の基準値を1バイトも消していない】**
    // **旧: `expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("ff800c5520c0c79e");`**
    // **3件増え、0件減った** —— **3件とも新規テスト
    // `src/server/file-delivery-uploader.test.ts` のセットアップ
    // (`KernelMetaStore` / `applyManifest` / `createApp`)であり、
    // `src/server/files-delivery.test.ts` / `src/server/file-attachment.test.ts` /
    // `src/server/nonadmin-layer-removal.test.ts` とまったく同じ3シンボルである。**
    // **新しい層またぎの種類は0本であり、製品コードの層またぎは0件である**
    // (`src/server/app.ts` が足したのは同じ `src/server/` 層の `roleRowBlocked` の
    //  呼び出しと `src/shared/files-table.ts` の定数だけで、`src/kernel/` からの
    //  `import` を1件も増やしていない)。
    // **`ADR-0009` 限定2 を1バイトも引き直していない**(3件のいずれも `normalizeSort` /
    // `sortErrorPath` / `validateSortKeys` ではない)。
    // **`src/kernel/` にも `schemas/` にも1バイトも触っていない**(`Δ8` は発火していない。
    //  `CP-V17` 条件7)。
    // **【はみ出しを正直に書く】本ファイルは `V17-M4-T03` の発注書が名指しした
    // 変更対象ではない。** **`V7-M2-T02` 以降の同型のはみ出しと同じ扱いで、
    // 旧値を消さずに注を足して更新した。** 記録: `docs/plan/v17/records/v17-m4.md` §3。
    // **当時 `ff800c5520c0c79e` → 今日 `533a5e180634f184`。****旧値を消さずに残す。**
    // **【`V17-M5-T03d`(台帳 `AC-G10` / `ADR-0412`)による更新。旧の基準値を1バイトも消していない】**
    // **旧: `expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("533a5e180634f184");`**
    // **5件増え、0件減った** —— **5件とも新規テスト
    // `src/server/root-creatable-roles.test.ts` のセットアップ
    // (`KernelMetaStore` / `createApp` / `applyManifest` / `createRecord` / `appDbPath`)で
    // あり、`src/server/create-parent-write.test.ts` /
    // `src/server/batch-create-parent-write.test.ts` とまったく同じ5シンボルである。**
    // **新しい層またぎの種類は0本であり、製品コードの層またぎは0件である**
    // (`src/server/app.ts` / `src/server/owner-scope.ts` が足したのは同じ `src/server/` 層の
    //  `judgeRootCreatableRoles` の定義と呼び出しだけで、`src/kernel/` からの `import` を
    //  1件も増やしていない)。
    // **`ADR-0009` 限定2 を1バイトも引き直していない**(5件のいずれも `normalizeSort` /
    // `sortErrorPath` / `validateSortKeys` ではない)。
    // **`schemas/` には1バイトも触っていない。** **`src/kernel/` は空ではない** ——
    // **`creatable-by.test.ts` と `table-access-control.test.ts` の2本が動いている
    //  (どちらも `*.test.ts` の凍結面の打ち直しであり、非テストの製品コードは1バイトも
    //  動いていない)。** **【禁止】これを「`src/kernel/` に触っていない」と丸めない。**
    // **【はみ出しを正直に書く】本ファイルは `V17-M5-T03` の起票が名指しした変更対象では
    // ない。** **`V17-M4-T03` と同型のはみ出しであり、旧値を消さずに注を足して更新した。**
    // **当時 `533a5e180634f184` → 今日 `908eef820bffa7a8`。****旧値を消さずに残す。**
    // **【`V17-M5-T04`(台帳 `AC-G17` / `AC-G18`)による更新。旧の基準値を1バイトも消していない】**
    // **旧: `expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("908eef820bffa7a8");`**
    // **3件増え、0件減った** —— **3件とも新規テスト
    // `src/server/role-condition-grants-bypassed.test.ts` のセットアップ
    // (`KernelMetaStore` / `createApp` / `applyManifest`)であり、
    // `src/server/role-conditions-enforcement.test.ts` /
    // `src/server/role-grant-union.test.ts` とまったく同じ3シンボルである。**
    // **新しい層またぎの種類は0本であり、製品コードの層またぎは0件である**
    // (`T04` が触った非テストは `src/kernel/apply-diff.ts` と `src/kernel/types.ts` の
    //  2本だけで、`src/server/` の非テストは1バイトも動いていない)。
    // **`ADR-0009` 限定2 を1バイトも引き直していない**(3件のいずれも `normalizeSort` /
    // `sortErrorPath` / `validateSortKeys` ではない)。
    // **`schemas/` には1バイトも触っていない。** **`src/kernel/` は空ではない** ——
    // **`apply-diff.ts` と `types.ts` の2本が動いている(どちらも非テストの製品コードである)。**
    // **【禁止】これを「`src/kernel/` に触っていない」と丸めない**(`CP-V17` 条件7)。
    // **【はみ出しを正直に書く】本ファイルは `V17-M5-T04` の起票が名指しした変更対象では
    // ない。** **`V17-M5-T03d` と同型のはみ出しであり、旧値を消さずに注を足して更新した。**
    // **当時 `908eef820bffa7a8` → 今日 `144a5edd42884587`。****旧値を消さずに残す。**
    // **【`V17-M5-T05`(台帳 `AC-G33`)による更新。旧の基準値を1バイトも消していない】**
    // **旧: `expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("144a5edd42884587");`**
    // **3件増え、0件減った** —— **3件とも新規テスト
    // `src/server/owner-scope-supplied-notice.test.ts` のセットアップ
    // (`KernelMetaStore` / `createApp` / `applyManifest`)であり、
    // `src/server/role-condition-grants-bypassed.test.ts` /
    // `src/server/role-conditions-enforcement.test.ts` とまったく同じ3シンボルである。**
    // **新しい層またぎの種類は0本であり、製品コードの層またぎは0件である**
    // (`T05` が触った非テストは `src/kernel/apply-diff.ts` / `src/kernel/types.ts` /
    //  `src/mcp/tools/read.ts` の3本で、`read.ts` の差分は doc の訂正だけである。
    //  `src/server/` の非テストは1バイトも動いていない)。
    // **`ADR-0009` 限定2 を1バイトも引き直していない**(3件のいずれも `normalizeSort` /
    // `sortErrorPath` / `validateSortKeys` ではない)。
    // **`schemas/` には1バイトも触っていない。** **`src/kernel/` は空ではない** ——
    // **`apply-diff.ts` と `types.ts` の2本が動いている(どちらも非テストの製品コードである)。**
    // **【禁止】これを「`src/kernel/` に触っていない」と丸めない**(`CP-V17` 条件7)。
    // **【はみ出しを正直に書く】本ファイルは `V17-M5-T05` の起票が名指しした変更対象では
    // ない。** **`V17-M5-T03d` / `V17-M5-T04` と同型のはみ出しであり(本段で3度目)、
    // 旧値を消さずに注を足して更新した。**
    // **当時 `144a5edd42884587` → 今日 `ca81651747db1b44`。****旧値を消さずに残す。**
    // **【`V17-M6-T06b`(台帳 `AC-G22` / `AC-G24` / `AC-G30b`)による更新。
    //   旧の基準値を1バイトも消していない】**
    // **旧: `expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("ca81651747db1b44");`**
    // **12件増え、0件減った** —— **出どころは新規テスト**3本**である**:
    // `scripts/skill-grant-table-view.test.ts`(2件)/
    // `src/server/access-control-orphan-recovery.test.ts`(5件)/
    // `src/server/record-access-sources.test.ts`(5件)。
    // **本段が足した新規 `.test.ts` は4本だが、`src/server/app-change-vs-undo.test.ts` は
    // カーネルからの値 import を1件も持たないので表に載らない。**
    // **12件はすべて既に他の検査が採っている組**(`KernelMetaStore` / `appDbPath` /
    // `applyManifest` / `createApp` / `createRecord`)であり、
    // **新しい層またぎの種類は0本・製品コードの層またぎは0件である**
    // (本段が触った非テストは `src/server/app.ts` と `src/server/owner-scope.ts` の
    //  2本だけで、どちらもカーネルからの値 import を1件も増やしていない)。
    // **`ADR-0009` 限定2 を1バイトも引き直していない**(12件のいずれも `normalizeSort` /
    // `sortErrorPath` / `validateSortKeys` ではない)。
    // **`schemas/` にも `src/kernel/` にも1バイトの差分を出していない**
    // (`git diff --numstat 3f37c002 HEAD -- apps/smailtalk/src/kernel apps/smailtalk/schemas`
    //  は **0行**。`CP-V17` 条件7)。
    // **【前段との違いを書く】** **`V17-M5` の3回はどれも `src/kernel/` が空ではなかったが、
    // 本段は空である。** **【禁止】前段の書き方をそのまま写さない。**
    // **【はみ出しを正直に書く】本ファイルは `V17-M6-T06b` の起票が名指しした変更対象では
    // ない。** **`V17-M5-T03d` / `V17-M5-T04` / `V17-M5-T05` と同型のはみ出しであり、
    // 段の計画 §5 の理由4 / §7 の罠5 が**予定に入れていた**2段目の赤である** ——
    // **本段は打ち直しを `T06b` に**1回だけ**束ねた(前段は3度に分けて踏んだ)。**
    // **当時 `ca81651747db1b44` → 今日 `763f8e7f456d933a`。****旧値を消さずに残す。**
    //
    // **【`V18-M3-T01`(`PM-G6` / `ADR-0435` / `ADR-0439`)による更新。2026-09-12。
    //   上の文を1バイトも消していない】**
    // **旧: `expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("763f8e7f456d933a");`**
    // **5件増え、0件減った** —— **出どころは新しい検査ファイル1本
    // (`src/server/access-control-registry-read.test.ts`)だけである。**
    // **5件はすべて既に他の検査が採っている組**(`KernelMetaStore` / `appDbPath` /
    // `applyManifest` / `createApp` / `createRecord`)であり、
    // **新しい層またぎの種類は0本・製品コードの層またぎは0件である**
    // (`V18-M3-T01` は `src/` の製品コードを1バイトも触っていない。**TDD の赤を書く葉**)。
    // **`ADR-0009` 限定2 を1バイトも引き直していない**(5件のいずれも `normalizeSort` /
    // `sortErrorPath` / `validateSortKeys` ではない)。
    // **`schemas/` にも `src/kernel/` にも1バイトの差分を出していない。**
    // **【はみ出しを正直に書く】** **本ファイルは `V18-M3-T01` の起票
    // (`records/v18-m0.md:1684`)が名指しした変更対象ではない。**
    // **`ADR-0435` の授権の表にも `ADR-0439` の授権2点にも、この検査の行は1行も無い。**
    // **`V17-M6-T06b` / `V17-M5` の3回と同型のはみ出しであり、
    // **新しい検査ファイルを1本でも足せば必ず出る形である。**
    // **先に赤の出力を見てから打ち直した**(`ADR-0402` 限定9 / `ADR-0053` 限定4)。
    // **当時 `763f8e7f456d933a` → 今日 `3d94b9d89b56ef69`。****旧値を消さずに残す。**
    //
    // **【`V18-M4-T01`(`PM-G10` / `ADR-0435` / `ADR-0441`)による更新。2026-09-12。
    //   上の文を1バイトも消していない】**
    // **旧: `expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("3d94b9d89b56ef69");`**
    // **3件増え、0件減った** —— **出どころは新しい検査ファイル1本
    // (`src/server/unnamed-view-read-wall.test.ts`)だけである。**
    // **3件はすべて既に他の検査が採っている組**(`KernelMetaStore` / `applyManifest` /
    // `createApp`)であり、**新しい層またぎの種類は0本・製品コードの層またぎは0件である**
    // (`V18-M4-T01` は `src/` の製品コードを1バイトも触っていない。**TDD の赤を書く葉**)。
    // **前段(`V18-M3-T01`)より1件少ないのは `createRecord` を使っていないからである** ——
    // **行は運営の HTTP の口(`POST .../records`)から作っている。**
    // **`ADR-0009` 限定2 を1バイトも引き直していない**(3件のいずれも `normalizeSort` /
    // `sortErrorPath` / `validateSortKeys` ではない)。
    // **`schemas/` にも `src/kernel/` にも1バイトの差分を出していない。**
    // **【前段と違い、はみ出しではない】** **`ADR-0441` §Decision 3 授権の表 **行29** が、
    // このファイルの `sha` の打ち直しを**第4列 `V18-M4-T01`** で名指しで授権している**
    // (`ADR-0440` 行15 は第4列が `V18-M3-T01` だったので本段を覆っていない。
    // `ADR-0441` §Decision 2 の物差し)。
    // **先に赤の出力を見てから打ち直した**(`ADR-0402` 限定9 / `ADR-0053` 限定4。
    // 逐語 `Expected: "3d94b9d89b56ef69" / Received: "a498575f04078eae"`。**1 fail**)。
    // **当時 `3d94b9d89b56ef69` → 今日 `a498575f04078eae`。****旧値を消さずに残す。**
    //
    // **【2026-09-12 追記(`V18-M5-T02b`。`PM-G2` / `PM-G3` / `ADR-0442`)。
    //   上の文を1バイトも消していない】**
    // **旧: `expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("a498575f04078eae");`**
    // **10件増え、0件減った** —— **出どころは新しい検査ファイル2本
    // (`src/server/root-create-closed-by-default.test.ts`(`V18-M5-T01`)と
    // `src/mcp/root-create-closed-by-default-mcp.test.ts`(`V18-M5-T02`))だけである。**
    // **10件はすべて既に他の検査が採っている組**(`KernelMetaStore` / `appDbPath` /
    // `applyManifest` / `createApp` / `createRecord`)であり、
    // **新しい層またぎの種類は0本・製品コードの層またぎは0件である。**
    // **`ADR-0009` 限定2 を1バイトも引き直していない**(10件のいずれも `normalizeSort` /
    // `sortErrorPath` / `validateSortKeys` ではない)。
    // **`schemas/` にも `src/kernel/` にも1バイトの差分を出していない。**
    // **【`ADR-0441` 行29 を根拠にできない】** **`ADR-0007:1882` が射程を `V18-M4` に
    // 限っているので、本段は `ADR-0442` §Decision 3 の授権の表(層越えの基準値の行)を
    // 根拠にする。**
    // **先に赤の出力を見てから打ち直した**(`ADR-0402` 限定9 / `ADR-0053` 限定4。
    // 逐語 `Expected: "a498575f04078eae" / Received: "8d7b41b9ca2c9127"`。**1 fail**)。
    // **値は失敗出力から写していない** —— **`shasum -a 256 scripts/kernel-import-snapshot.txt`
    // の先頭16文字を自分で打って確かめた。**
    // **当時 `a498575f04078eae` → 今日 `8d7b41b9ca2c9127`。****旧値を消さずに残す。**
    // **【`V18-M7-T02`(台帳 `PM-G5` / `ADR-0444` 授権の表 行8)による更新。旧値も旧文も
    //   1バイトも消していない】** **`V18-M7-T02` が新しい検査ファイル1本を足したので、
    //   `kernel-import-snapshot.txt` に5件の行と、その審査コメントが増えた。**
    // **先に赤の出力を見てから打ち直した**(`ADR-0402` 限定9)——
    //   逐語 `Expected: "8d7b41b9ca2c9127" / Received: "7c24aaab51faf46f"`。**1 fail**。
    // **値は失敗出力から写していない** —— **`shasum -a 256 scripts/kernel-import-snapshot.txt`
    //   の先頭16文字を自分で打って確かめた(`7c24aaab51faf46f`)。**
    // **`8d7b41b9ca2c9127` → 今日 `7c24aaab51faf46f`。**
    //
    // **【`V18-M7-T03`(2026-09-14)。上の3行を1バイトも消していない】** —— **AI の口の検査
    // ファイル1本ぶん(5件)を同じ台帳に足したので、この指紋がもう一度動いた。**
    // **値は失敗出力から写していない** —— **`shasum -a 256 scripts/kernel-import-snapshot.txt`
    //   の先頭16文字を自分で打って確かめた(`26dca2035da477b1`)。**
    // **`7c24aaab51faf46f` → 今日 `26dca2035da477b1`。**
    expect(sha(await source("scripts/kernel-import-snapshot.txt"))).toBe("26dca2035da477b1");
  });

  test("限定4: ADR 番号・限定番号への参照を1つも消していない", async () => {
    // **【測り方を入れ替えた】** 旧: 参照集合の**件数**(63)を今日の実物で直接数える。
    // `V5-M21-T03` が `types.ts` に `ADR-0171` / `ADR-0175` / `ADR-0045` を足したので今日は **66** である。
    // **件数の同値は、後続が参照を「足した」だけで壊れる** —— 消していないことの検査になっていない。
    // **測らなくなったもの: `src/kernel/` 3ファイルの ADR 参照の総数が `f79b1b7`(63)と同値であること。**
    const texts = await Promise.all(KERNEL_FILES.map(source));
    const joined = texts.join("\n");
    const before = texts.map((text, i) => reverseApply(text, KERNEL_FILES[i] ?? "")).join("\n");
    // (a) `V5-M14` の差し替えが参照を1つも落としていない。
    expect(setOf(before, ADR_REF)).toEqual(setOf(joined, ADR_REF));
    // (b) 着手前にあった参照が今日も1つも欠けていない(**件数ではなく名前で測る**)。
    const adrToday = new Set(setOf(joined, ADR_REF));
    expect(KERNEL_BASELINE_ADR_REFS.filter((ref) => !adrToday.has(ref))).toEqual([]);
    for (const ref of ["ADR-0018", "限定 A2"]) {
      expect(joined.includes(ref), ref).toBe(true);
    }
  });

  test("限定5: コメントが述べている事実を弱めても強めてもいない", async () => {
    const joined = (await Promise.all(KERNEL_FILES.map(source))).join("\n");
    for (const fact of [
      "**カーネルは演算を1つも持たない**",
      "部分適用ゼロで書ける",
      "**演算を1つも持たない**(限定 A2)",
    ]) {
      expect(joined.includes(fact), fact).toBe(true);
    }
  });

  test("限定6: 差し替え後の語が別の業種名になっていない", () => {
    for (const entry of REPLACEMENTS.filter((r) => r.unit === "G-G19")) {
      expect(findIndustryWords(entry.after, FACE5_INDUSTRY_WORDS), entry.after).toEqual([]);
    }
  });

  test("限定7: 対象が `src/kernel/` に閉じている(対照表の `G-G19` の行はすべて `src/kernel/`)", () => {
    for (const entry of REPLACEMENTS.filter((r) => r.unit === "G-G19")) {
      expect(entry.file.startsWith("src/kernel/"), entry.file).toBe(true);
    }
  });
});
