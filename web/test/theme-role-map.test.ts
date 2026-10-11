/**
 * テーマの役割名 → CSS カスタムプロパティ名の写像(V20-M8 / ADR-0473)の関数の検査。
 *
 * 表 `THEME_ROLE_TO_CSS_PROPERTY` と `$defs/theme` / `styles-token-slots.txt` の一致は
 * `web/test/theme-slot-parity.test.ts` が見る。**本ファイルが見るのは関数
 * `themeSlotsToCssProperties` の振る舞いだけである**(表に無いキーは落とす・値は加工しない)。
 *
 * **対応表をこのファイルに書き下さない**(2本目の規則を作らない)。期待値は表そのものから引く。
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { THEME_ROLE_TO_CSS_PROPERTY, themeSlotsToCssProperties } from "../src/theme-role-map.ts";

const REPO_ROOT = dirname(dirname(import.meta.dir));
const themeSchema = (
  JSON.parse(readFileSync(join(REPO_ROOT, "schemas", "manifest.schema.json"), "utf-8")) as {
    $defs: { theme: { properties: Record<string, unknown> } };
  }
).$defs.theme;

test("スキーマの全キーを渡すと、全件が表の CSS 名へ写り、値はそのまま運ばれる", () => {
  const slots = Object.fromEntries(Object.keys(themeSchema.properties).map((k, i) => [k, `v${i}`]));
  const css = themeSlotsToCssProperties(slots);

  expect(Object.keys(css).sort()).toEqual(Object.values(THEME_ROLE_TO_CSS_PROPERTY).sort());
  for (const [role, value] of Object.entries(slots)) {
    const name = THEME_ROLE_TO_CSS_PROPERTY[role];
    expect(name).toBeDefined();
    expect(css[name as string]).toBe(value);
  }
});

test("役割名のキーは CSS 名に置き換わり、役割名そのものは出力に残らない", () => {
  const css = themeSlotsToCssProperties({ body_text: "#111111" });
  const name = THEME_ROLE_TO_CSS_PROPERTY.body_text as string;
  expect(name.startsWith("--")).toBe(true);
  expect(name).not.toBe("body_text");
  expect(css).toEqual({ [name]: "#111111" });
});

// 【V20-M9 / ADR-0474 §1-3】2件を語彙から外し、写像の帯からも外した。テスト名は撤去の前の逐語で、
// 期待値を「運ばれない(表に無いキーとして落ちる)」へ向きを変えた。旧期待値(逐語):
// `expect(css).toEqual({ "--detail-label-width": "8rem", "--login-max-width": "24rem" });`
test("名前を変えていない2件は同じ名前で運ばれる(恒等の2件)", () => {
  const css = themeSlotsToCssProperties({
    "--detail-label-width": "8rem",
    "--login-max-width": "24rem",
  });
  expect(css).toEqual({});
});

test("表に無いキー(旧名・未知の名前・継承したプロパティ名)は落とす", () => {
  const css = themeSlotsToCssProperties({
    "--color-text": "#000000",
    unknown_role: "1px",
    toString: "x",
    constructor: "y",
    space_1: "0.25rem",
  });
  expect(css).toEqual({ [THEME_ROLE_TO_CSS_PROPERTY.space_1 as string]: "0.25rem" });
});

test("空のスロットは空のオブジェクトになる", () => {
  expect(themeSlotsToCssProperties({})).toEqual({});
});

// ---------------------------------------------------------------------------
// V20-M9-T01(ADR-0474 §Decision 1-6): 生の色の写しの2規則。**解かない。CSS の変数参照に写すだけ。**
// ---------------------------------------------------------------------------

test("規則(1): キー palette_<名前> は --palette-<名前の _ を - にしたもの> へ写る", () => {
  const css = themeSlotsToCssProperties({ palette_brand: "#1d4ed8", palette_blue_600: "#2563eb" });
  expect(css).toEqual({ "--palette-brand": "#1d4ed8", "--palette-blue-600": "#2563eb" });
});

test("規則(2): 値 $palette_<名前> は var(--palette-<同じ変換>) へ写る(役割の枠でも生の色の値でも)", () => {
  const css = themeSlotsToCssProperties({
    primary_fill: "$palette_brand",
    palette_brand: "$palette_blue_600",
    palette_blue_600: "#2563eb",
  });
  expect(css).toEqual({
    [THEME_ROLE_TO_CSS_PROPERTY.primary_fill as string]: "var(--palette-brand)",
    "--palette-brand": "var(--palette-blue-600)",
    "--palette-blue-600": "#2563eb",
  });
});

test("写すだけで解かない —— 行き先の無い参照もそのまま var() へ写る(解決はカーネルだけ)", () => {
  const css = themeSlotsToCssProperties({ body_text: "$palette_missing" });
  expect(css).toEqual({
    [THEME_ROLE_TO_CSS_PROPERTY.body_text as string]: "var(--palette-missing)",
  });
});

test("palette_ で始まらない表に無いキーは今日どおり落とす(brand_color / palette だけ)", () => {
  expect(themeSlotsToCssProperties({ brand_color: "#123456", palette: "#123456" })).toEqual({});
});

test("写像の帯(Object.freeze({ から });)に palette の綴りは1つも無い(式P7。規則は帯の外)", () => {
  const source = readFileSync(join(REPO_ROOT, "web", "src", "theme-role-map.ts"), "utf-8");
  const head =
    "export const THEME_ROLE_TO_CSS_PROPERTY: Readonly<Record<string, string>> = Object.freeze({";
  const start = source.indexOf(head);
  expect(start).toBeGreaterThanOrEqual(0);
  const band = source.slice(start + head.length, source.indexOf("});", start));
  expect(band).not.toContain("palette");
  const outside = source.slice(0, start) + source.slice(source.indexOf("});", start));
  expect(outside).toContain("--palette-");
  expect(outside).toContain("var(--palette-");
  expect(Object.keys(THEME_ROLE_TO_CSS_PROPERTY)).toHaveLength(27);
});

// 【V20-M9 点検の重1 の処置】式P8(ADR-0474 限定8)を検査にした。点検の時点では式P8 だけが
// 偽を拾い、検査は1本も赤くならなかった(ThemeExportPanel.tsx の頭書きの文字列に --palette- が在った)。
// 式P8 と同じ中身: src/ と web/src/ の本体(.ts / .tsx、検査ファイルを除く)のうち写像のファイル以外に、
// 注釈でない行で `--palette-` の綴りが1つも無い。web/src に解決器の名前が1つも無い。
test("生の色の CSS 名の規則は写像のファイル1本だけに在る(式P8。注釈の行は数えない)", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  const mapFile = join(REPO_ROOT, "web", "src", "theme-role-map.ts");
  const files = [join(REPO_ROOT, "src"), join(REPO_ROOT, "web", "src")]
    .flatMap(walk)
    .filter((p) => /\.(ts|tsx)$/.test(p) && !p.includes(".test.") && p !== mapFile);
  const code = (p: string) =>
    readFileSync(p, "utf-8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
  expect(files.length).toBeGreaterThan(100);
  const cssRule = files
    .filter((p) => code(p).includes("--palette-"))
    .map((p) => p.slice(REPO_ROOT.length + 1));
  expect(cssRule).toEqual([]);
  const webSrc = join(REPO_ROOT, "web", "src");
  const resolverInWeb = files
    .filter((p) => p.startsWith(webSrc))
    .filter((p) => /resolveThemeSlots|THEME_REFERENCE_MAX_DEPTH/.test(code(p)))
    .map((p) => p.slice(REPO_ROOT.length + 1));
  expect(resolverInWeb).toEqual([]);
});
