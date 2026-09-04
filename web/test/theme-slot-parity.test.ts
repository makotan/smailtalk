/**
 * スロット名の三重管理の照合(その1)—— **表示層のスナップショット == `$defs/theme`**。
 *
 * 起票は `docs/plan/v3/records/v3-m1.md` §2 の **V3-M1-T03 完了条件12 / 18 / 21**、
 * 限定の正は `docs/adr/0046-design-token-slots.md` §3 限定1(+ 2026-07-25 追記の分割)と
 * `docs/adr/0047-app-theme-manifest.md` §3 限定5。
 *
 * ## この検査が塞ぐ穴(なぜ最重要と書かれているか)
 *
 * スロット名は3箇所に分かれて住んでいる ——
 * (A) `web/test/__fixtures__/styles-token-slots.txt`(表示層の `:root` の集合の正)/
 * (B) `schemas/manifest.schema.json` の `$defs/theme` の properties(マニフェストが
 * 受け取れるキーの正)/ (C) `src/kernel/theme-contrast.ts` の `THEME_SLOT_ROLES`
 * (コントラスト検査の役割表)。
 *
 * **3者が食い違ったとき、この検査が無いとどのテストも赤くならない。**
 * マニフェストには値が入り `_changelog` に載り `undo` も効きコントラスト検査も通るのに、
 * **画面は1ピクセルも変わらない。** 緑のまま嘘になる形であり、憲法6 に正面から衝突する。
 *
 * ## 照合は2本に分かれている(片方だけでは閉じない)
 *
 * - **本ファイル: (A) == (B)。** どちらも**ファイル**として読む。
 * - **`src/kernel/theme-contrast.test.ts`: (C) == (B)。** 同じ `$defs/theme` を読む。
 *
 * **2本が両方緑であれば (A) == (B) == (C) が推移律で閉じる。**
 * どちらか1本を消すと限定1 が機械的固定を失うので、消すときは門A を改めて通すこと
 * (`docs/adr/0046-design-token-slots.md` の 2026-07-25 追記)。
 *
 * ## なぜ `web/` からカーネルの値を import しないのか
 *
 * **ADR-0009 限定2**(`web/` はカーネルの実装を import しない)と
 * `scripts/kernel-import-drift.test.ts`(走査対象に `web` が入る)により、
 * ここから `src/kernel/` の値を読むことはできない。**したがって `schemas/*.json` は
 * `readFileSync` + `JSON.parse` で読むだけにする。** V3-M1-T02 は当初 ADR が
 * 「1本のテストで3集合を照合する」と書いていたことが実行不能だと実測で示した。
 *
 * ## この検査が証明しないこと(誇張しない)
 *
 * - **画面に色が当たることは証明していない。** 表示層への適用は **V3-M1-T04** であり、
 *   本検査の時点では**マニフェストにテーマを入れても画面は1ピクセルも変わらない。**
 *   本検査が担保しているのは「**名前が食い違わないこと**」だけである。
 * - **値が正しいことも証明していない**(値域は `$defs/theme` の pattern、
 *   読める配色かは `src/kernel/theme-contrast.ts` が別に見る)。
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const WEB_DIR = dirname(import.meta.dir);
const REPO_ROOT = dirname(WEB_DIR);

const SLOTS_PATH = join(import.meta.dir, "__fixtures__", "styles-token-slots.txt");
const MANIFEST_SCHEMA_PATH = join(REPO_ROOT, "schemas", "manifest.schema.json");
const STYLES_PATH = join(WEB_DIR, "src", "styles.css");

// ---------------------------------------------------------------------------
// (A) 表示層のスナップショット
// ---------------------------------------------------------------------------

const slotsFixture = readFileSync(SLOTS_PATH, "utf-8");

/** `#` 行と空行を除いたスロット名の全量(`web/test/styles.test.ts` と同じ読み方)。 */
function allSlotNames(): string[] {
  return slotsFixture
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/**
 * 「テーマ対象外」の宣言(`# theme-excluded: --name`)。
 *
 * **`#` で始まる行なので `web/test/styles.test.ts` の検査 (c)〜(e) には無影響である**
 * (スロット名の28件は1件も減っていない)。**対象外を後から増やすと、この行が増えるので
 * 差分に必ず出る** —— 増やすことは「テーマで指定できない項目を増やす」ことであり、
 * `docs/adr/0046-design-token-slots.md` §3a の門を通す事項である(完了条件21)。
 */
function themeExcludedNames(): string[] {
  const names: string[] = [];
  for (const line of slotsFixture.split("\n")) {
    const match = /^#\s*theme-excluded:\s*(--[a-z0-9-]+)\s*$/.exec(line.trim());
    if (match?.[1] !== undefined) {
      names.push(match[1]);
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// (B) `$defs/theme`(**カーネルの値を import せず、ファイルとして読む**)
// ---------------------------------------------------------------------------

type ThemeDefs = {
  $defs: {
    theme: {
      type: string;
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, unknown>;
    };
  };
};

const manifestSchema = JSON.parse(readFileSync(MANIFEST_SCHEMA_PATH, "utf-8")) as ThemeDefs;
const themeSchema = manifestSchema.$defs.theme;

// ---------------------------------------------------------------------------
// 変換規則(**1本だけ定義する**。完了条件12 の後半)
// ---------------------------------------------------------------------------

/**
 * **スロット名 → CSS カスタムプロパティ名の変換規則(唯一の1本)。**
 *
 * **規則は「恒等写像」である** —— `$defs/theme` の properties のキーは、
 * `web/src/styles.css` の `:root` に書かれている CSS カスタムプロパティ名**そのもの**
 * (先頭の `--` を含む)であり、**変換を1つも挟まない。**
 *
 * ## なぜ恒等にしたのか(実測に基づく確認であって、後付けの説明ではない)
 *
 * V3-M1-T03 段階A が `$defs/theme` のキーを `--color-text` の形で書いたので、
 * **規則を作る余地がそもそも無い**(`color.text` → `--color-text` のような写しを
 * 挟むと、規則が第4の管理箇所になり、限定1 の3箇所一致が4箇所一致になる)。
 * **本テストはその恒等性を機械的に固定する** —— 誰かが片側の綴りを変えたら赤くなる。
 *
 * ## この規則を使う場所
 *
 * - **V3-M1-T04**(表示層への適用): スコープ要素へ注入するカスタムプロパティ名。
 * - **V3-M1-T05**(`theme.css` の持ち出し): 生成する宣言のプロパティ名。
 *   **規則が2本あると、持ち出した `theme.css` は「形式は安定しているが当たらない」
 *   状態になる**(v3-m1.md T05-4)。**T04 / T05 はこの関数と同じ規則を使うこと。**
 */
function themeSlotToCssCustomProperty(slot: string): string {
  return slot;
}

/** CSS カスタムプロパティ名として妥当な形(先頭 `--`・英小文字と数字とハイフンのみ)。 */
const CSS_CUSTOM_PROPERTY_RE = /^--[a-z][a-z0-9-]*$/;

// ---------------------------------------------------------------------------
// 照合
// ---------------------------------------------------------------------------

test("スナップショットは28件のスロットと、テーマ対象外3件の宣言を持つ", () => {
  const all = allSlotNames();
  const excluded = themeExcludedNames();

  expect(all).toHaveLength(28);
  // **対象外の集合を名指しで固定する**(完了条件21 の (ii))。ここを増やすには
  // ADR-0046 §3a の門が要る。
  expect([...excluded].sort()).toEqual([
    "--border-style",
    "--focus-outline-style",
    "--shell-max-width",
  ]);
  // 対象外はスロットとして実在していなければならない(綴り間違いを通さない)。
  expect(excluded.filter((name) => !all.includes(name))).toEqual([]);
});

test("テーマ対象スロット集合(28 − 対象外3 = 25)が `$defs/theme` の properties キー集合と一致する", () => {
  const excluded = themeExcludedNames();
  const themeTargets = allSlotNames()
    .filter((name) => !excluded.includes(name))
    .sort();
  const schemaKeys = Object.keys(themeSchema.properties).sort();

  const added = schemaKeys.filter((name) => !themeTargets.includes(name));
  const removed = themeTargets.filter((name) => !schemaKeys.includes(name));

  // **赤くなったらどちらかを直す前に、どちらが正しいのかを決めること。**
  // スロットを増やす側なら ADR-0007 の門A が要る(ADR-0046 §3a 1 / ADR-0047 §3a)。
  expect({ added, removed }).toEqual({ added: [], removed: [] });
  expect(schemaKeys).toHaveLength(25);
  expect(themeTargets).toHaveLength(25);
});

test("`$defs/theme` は全スロットを required にし、additionalProperties: false で閉じている", () => {
  // **部分テーマを作らない**(ADR-0047 の 2026-07-25 追記 (2))—— 片側しか指定されて
  // いない対は1組も検査されないので、全スロット必須でないと fail-closed に穴が開く。
  expect([...themeSchema.required].sort()).toEqual(Object.keys(themeSchema.properties).sort());
  expect(themeSchema.additionalProperties).toBe(false);
  expect(themeSchema.type).toBe("object");
});

test("変換規則は恒等写像である(スロット名がそのまま CSS カスタムプロパティ名になる)", () => {
  const schemaKeys = Object.keys(themeSchema.properties);
  expect(schemaKeys.length).toBeGreaterThan(0);
  for (const slot of schemaKeys) {
    expect(themeSlotToCssCustomProperty(slot)).toBe(slot);
    expect(slot).toMatch(CSS_CUSTOM_PROPERTY_RE);
  }
});

test("恒等規則の帰結: 25件がそのまま `web/src/styles.css` の宣言として現れる", () => {
  // **恒等であることを空虚にしない** —— 変換を挟む形に変えたら、この検査が赤くなる。
  // (`:root` の集合そのものの固定は `web/test/styles.test.ts` の検査 (c) が担う。
  //  ここで見ているのは「`$defs/theme` のキーが CSS の宣言名として実在すること」である。)
  const css = readFileSync(STYLES_PATH, "utf-8");
  const missing = Object.keys(themeSchema.properties).filter(
    (slot) => !css.includes(`${themeSlotToCssCustomProperty(slot)}:`),
  );
  expect(missing).toEqual([]);
});

test("本ファイルはカーネルの値を1つも import していない(ADR-0009 限定2)", () => {
  // `scripts/kernel-import-drift.test.ts` が同じことを横断で見ているが、
  // **この検査が成立している理由を、この検査の中に置いておく**(後から
  // 「役割表も一緒に読めばいいのに」と直されるのを防ぐため)。
  const self = readFileSync(join(import.meta.dir, "theme-slot-parity.test.ts"), "utf-8");
  const imports = [...self.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1] ?? "");
  expect(imports.filter((specifier) => specifier.includes("src/kernel"))).toEqual([]);
  expect(imports.filter((specifier) => specifier.includes("../../src"))).toEqual([]);
});
