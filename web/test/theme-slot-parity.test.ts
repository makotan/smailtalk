/**
 * スロット名の三重管理の照合(その1)—— **表示層のスナップショット == 写像(`$defs/theme`)**。
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
 * - **本ファイル: (A) == 写像(B)。** (A) と (B) は**ファイル**として読み、(B) の役割名は
 *   写像 `web/src/theme-role-map.ts`(V20-M8 / ADR-0473)で CSS 名に写してから比べる。
 * - **`src/kernel/theme-contrast.test.ts`: (C) == (B)。** 同じ `$defs/theme` を読む。
 *
 * **【V20-M8】マニフェストのキーは役割名(`body_text` など)になり、(A) の CSS 名とは
 * 写像1本で結ばれる。** 以前の「恒等写像」は、名前のついた写像1本に建て替わった(規則は1本のまま)。
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
import { THEME_ROLE_TO_CSS_PROPERTY, themeSlotsToCssProperties } from "../src/theme-role-map.ts";

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
      // 【V20-M9-T04】生の色の層(ADR-0474 §Decision 1-1)。照合の対象にはしない。
      patternProperties?: Record<string, unknown>;
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
 * **【V20-M8 / ADR-0473】規則は「恒等写像」から、写像 `web/src/theme-role-map.ts` の1本に
 * 建て替わった。** `$defs/theme` の properties のキーは役割名(`body_text` など。名前を
 * 残す2件だけは CSS 名のまま)であり、`web/src/styles.css` の `:root` の CSS カスタムプロパティ名へは
 * **製品と同じ関数 `themeSlotsToCssProperties` を1件ずつ通して**写す。**ここに2本目の規則を書かない。**
 *
 * ## この規則を使う場所(5経路。すべて同じ写像を通る)
 *
 * - 適用(`AppWorkspace` の `themeScopeStyle`)/ 候補の見本(`ThemePreviewPanel`)/
 *   持ち出し(`ThemeExportPanel` の `theme.css`)/ 取り込みのプレビュー(`AppThemeScope` 経由)/
 *   候補(`theme-candidates.ts` のキーは役割名)。
 *   **規則が2本あると、持ち出した `theme.css` は「形式は安定しているが当たらない」
 *   状態になる**(v3-m1.md T05-4)。
 *
 * 写像に無い名前は `undefined` を返す(製品の関数は落とすので、ここでは落ちたことを見える形にする)。
 */
function themeSlotToCssCustomProperty(slot: string): string | undefined {
  return Object.keys(themeSlotsToCssProperties({ [slot]: "x" }))[0];
}

/** CSS カスタムプロパティ名として妥当な形(先頭 `--`・英小文字と数字とハイフンのみ)。 */
const CSS_CUSTOM_PROPERTY_RE = /^--[a-z][a-z0-9-]*$/;

// ---------------------------------------------------------------------------
// 照合
// ---------------------------------------------------------------------------

test("スナップショットは28件のスロットと、テーマ対象外3件の宣言を持つ", () => {
  const all = allSlotNames();
  const excluded = themeExcludedNames();

  // 【V20-M9 / ADR-0474 §1-2】28 → 32(4件を足した)。旧(逐語): expect(all).toHaveLength(28);
  expect(all).toHaveLength(32);
  // **対象外の集合を名指しで固定する**(完了条件21 の (ii))。ここを増やすには
  // ADR-0046 §3a の門が要る。
  // 【V20-M9 / ADR-0474 §1-3(限定15・限定16)】対象外 3 → 5。語彙から外した2件(`--detail-label-width` /
  // `--login-max-width`)を足した。テスト名の「3件」は撤去の前の逐語である。旧(逐語):
  // `expect([...excluded].sort()).toEqual(["--border-style", "--focus-outline-style", "--shell-max-width"]);`
  expect([...excluded].sort()).toEqual([
    "--border-style",
    "--detail-label-width",
    "--focus-outline-style",
    "--login-max-width",
    "--shell-max-width",
  ]);
  // 対象外はスロットとして実在していなければならない(綴り間違いを通さない)。
  expect(excluded.filter((name) => !all.includes(name))).toEqual([]);
});

test("テーマ対象スロット集合(28 − 対象外3 = 25)が `$defs/theme` の properties キーを写像に通した集合と一致する", () => {
  // 【V20-M9-T04】test 名の「28 − 対象外3 = 25」は V20-M8 の時点の逐語である(今日は 32 − 対象外5 = 27。
  // 打ち直しは下の注釈のとおり T01 が済ませた)。照合するのは役割の層(properties)だけで、生の色の層は照合しない。
  const excluded = themeExcludedNames();
  const themeTargets = allSlotNames()
    .filter((name) => !excluded.includes(name))
    .sort();
  const propertyKeys = Object.keys(themeSchema.properties);
  // 写像のキーの集合 == `$defs/theme` の properties(写像に無いスロットも、余った写像の行も無い)。
  expect(Object.keys(THEME_ROLE_TO_CSS_PROPERTY).sort()).toEqual([...propertyKeys].sort());
  // 写像の値は重ならない(2つの役割が1つの CSS 名を取り合わない)。
  const mappedNames = propertyKeys.map((slot) => themeSlotToCssCustomProperty(slot));
  expect(new Set(mappedNames).size).toBe(propertyKeys.length);
  const schemaKeys = mappedNames.map((name) => name ?? "(写像に無い)").sort();

  const added = schemaKeys.filter((name) => !themeTargets.includes(name));
  const removed = themeTargets.filter((name) => !schemaKeys.includes(name));

  // **赤くなったらどちらかを直す前に、どちらが正しいのかを決めること。**
  // スロットを増やす側なら ADR-0007 の門A が要る(ADR-0046 §3a 1 / ADR-0047 §3a)。
  expect({ added, removed }).toEqual({ added: [], removed: [] });
  // 【V20-M9 / ADR-0474】25 → 23(2枠 --detail-label-width / --login-max-width を語彙から外した)。旧(逐語): expect(schemaKeys).toHaveLength(25);
  // 【V20-M9 / ADR-0474】23 → 27(4枠 primary_fill / on_primary / overlay_background / overlay_text を足した)。旧(逐語): expect(schemaKeys).toHaveLength(23);
  expect(schemaKeys).toHaveLength(27);
  // 【V20-M9 / ADR-0474】25 → 23(2枠 --detail-label-width / --login-max-width を語彙から外した)。旧(逐語): expect(themeTargets).toHaveLength(25);
  // 【V20-M9 / ADR-0474】23 → 27(4枠 primary_fill / on_primary / overlay_background / overlay_text を足した)。旧(逐語): expect(themeTargets).toHaveLength(23);
  expect(themeTargets).toHaveLength(27);
});

// 【V20-M9-T04 / ADR-0455 §4-1】次の1本に同居していた expect 3本を、3本の test に割った。
// 旧(逐語。test 名と本体):
//   test("`$defs/theme` は全スロットを required にし、additionalProperties: false で閉じている", () => {
//     expect([...themeSchema.required].sort()).toEqual(Object.keys(themeSchema.properties).sort());
//     expect(themeSchema.additionalProperties).toBe(false);
//     expect(themeSchema.type).toBe("object");
//   });
// 割った理由: 1本に同居していると、先の1つが赤くなったとき残る2つの真偽が見えない。
// 生の色の層(patternProperties)を開けた V20-M9 では、3つが別々の理由で動きうる
// (必須の集合 = 役割の層だけ / 閉じ方 = 役割の枠と生の色の名前の外を断る / 型 = 平たいオブジェクト)。
//
// **生の色の層(`patternProperties` の `^palette_…`)は、3箇所一致の照合の対象にしない。**
// 生の色は AI がアプリごとに名前を作る層であり、名前の数も綴りもアプリごとに変わるので、
// 固定値の一覧(A)・`$defs/theme` の properties(B)・役割表(C)のどれにも載らない。
// 照合が見るのは役割の層(`properties`)だけである。**照合を消したのではない** ——
// 役割の層の3箇所一致は上の test と `src/kernel/theme-contrast.test.ts` のまま残り、
// 生の色の層が照合の外に在ることは、下の「生の色の層は…」の test が固定する。

test("`$defs/theme` の required は、書ける役割の枠(properties)の集合とちょうど一致する(部分テーマを作らない)", () => {
  // **部分テーマを作らない**(ADR-0047 の 2026-07-25 追記 (2))—— 片側しか指定されて
  // いない対は1組も検査されないので、全スロット必須でないと fail-closed に穴が開く。
  // 数は焼かない(集合の一致だけを見る)。
  expect([...themeSchema.required].sort()).toEqual(Object.keys(themeSchema.properties).sort());
});

test("`$defs/theme` は additionalProperties: false で閉じている(役割の枠と生の色の名前の外は断る)", () => {
  expect(themeSchema.additionalProperties).toBe(false);
});

test("`$defs/theme` の型は object(役割の枠と生の色が同じ平たいオブジェクトに並ぶ)", () => {
  expect(themeSchema.type).toBe("object");
});

test("生の色の層は `patternProperties` 1本ちょうどで、required に入らず、照合(3箇所一致)の対象の外に在る", () => {
  // ADR-0474 §Decision 1-1(生の色の必須性: 0件でもテーマは valid)。
  const patterns = Object.keys(themeSchema.patternProperties ?? {});
  expect(patterns).toEqual(["^palette_[a-z0-9_]{1,40}$"]);
  const rawColorName = new RegExp(patterns[0] ?? "(?!)");
  // required にも properties にも、生の色の名前の形をしたキーが1つも無い。
  expect(themeSchema.required.filter((name) => rawColorName.test(name))).toEqual([]);
  expect(Object.keys(themeSchema.properties).filter((name) => rawColorName.test(name))).toEqual([]);
  // 固定値の一覧(A)にも生の色は載らない(載せると照合の相手が数の動く層になる)。
  expect(allSlotNames().filter((name) => name.startsWith("--palette-"))).toEqual([]);
});

test("変換規則は写像1本であり、恒等ではない(役割名は CSS 名へ写り、名前を残す2件だけが恒等)", () => {
  const schemaKeys = Object.keys(themeSchema.properties);
  expect(schemaKeys.length).toBeGreaterThan(0);
  const identity: string[] = [];
  const renamed: string[] = [];
  for (const slot of schemaKeys) {
    const cssName = themeSlotToCssCustomProperty(slot);
    // 写った先は必ず CSS カスタムプロパティ名の形である(役割名のまま出ていない)。
    expect(cssName, slot).toMatch(CSS_CUSTOM_PROPERTY_RE);
    // 表の値と関数の結果が同じ(表と関数が別の規則になっていない)。
    expect(cssName, slot).toBe(THEME_ROLE_TO_CSS_PROPERTY[slot]);
    (cssName === slot ? identity : renamed).push(slot);
  }
  // **恒等なのは `--` で始まる(名前を変えていない)キーだけである**(D-V20-12。V20-M9 が外す)。
  expect(identity.sort()).toEqual(schemaKeys.filter((slot) => slot.startsWith("--")).sort());
  // 【V20-M9-T04 / ADR-0474 §Decision 1-3】2件を外したので、恒等の組は0件になった。
  // test 名の「名前を残す2件だけが恒等」と上の注釈の「V20-M9 が外す」は撤去の前の逐語である。
  // 上の expect は両辺が空で真になる(中身の無い真)ので、0件であることを陽に固定する。
  expect(identity).toEqual([]);
  // **写像は恒等でない** —— 役割名のキーはすべて、自分と違う CSS 名へ写る。
  expect(renamed.length).toBeGreaterThan(0);
  expect(renamed.sort()).toEqual(schemaKeys.filter((slot) => !slot.startsWith("--")).sort());
  for (const slot of renamed) {
    expect(slot).toMatch(/^[a-z][a-z0-9_]*$/);
  }
});

test("写像の帰結: 25件が写像を通した名前で `web/src/styles.css` の宣言として現れる", () => {
  // 【V20-M9-T04】test 名の「25件」は V20-M8 の時点の逐語である(今日の役割の枠は27件。数はこの test では焼かず、
  // `$defs/theme` の properties の全件を見る)。生の色(`--palette-…`)はアプリごとの層なので、ここでは見ない。
  // **写像を空虚にしない** —— 写像の値を1件でも綴り違いにしたら、この検査が赤くなる。
  // (`:root` の集合そのものの固定は `web/test/styles.test.ts` の検査 (c) が担う。
  //  ここで見ているのは「`$defs/theme` のキーを写像に通した名前が CSS の宣言名として実在すること」である。)
  const css = readFileSync(STYLES_PATH, "utf-8");
  const missing = Object.keys(themeSchema.properties).filter((slot) => {
    const cssName = themeSlotToCssCustomProperty(slot);
    return cssName === undefined || !css.includes(`${cssName}:`);
  });
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
