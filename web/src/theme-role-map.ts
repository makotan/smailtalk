/**
 * テーマの役割名 → CSS カスタムプロパティ名の写像(V20-M8 / ADR-0473)。
 *
 * **マニフェストの `app.theme.slots` のキーは役割名(`body_text` など)であり、
 * 画面が値を流し込む先は `web/src/styles.css` の `:root` の CSS カスタムプロパティ名である。**
 * 2つを結ぶ規則はこのファイルの表1本だけである(`src/kernel/` と `src/mcp/` と `schemas/` に
 * 写像を置かない。2本目の規則を作らない)。
 *
 * - キーの集合は `schemas/manifest.schema.json` の `$defs/theme` の properties と同じ25件である。
 *   並びも同じ(スキーマの並び)。**【V20-M9 / ADR-0474】今日は 27件**(2件を外し、4件を足した)。
 * - `--detail-label-width` / `--login-max-width` の2件は名前を変えていない(D-V20-12 により
 *   V20-M9 が語彙から外す)。この2件だけは恒等である。
 * - **【V20-M9 / ADR-0474 §Decision 1-3】上の2件は語彙から外し、帯からも2行を外した。** 旧(逐語):
 *   `  "--detail-label-width": "--detail-label-width",` /
 *   `  "--login-max-width": "--login-max-width",`。 `:root` の2行は残る(テーマ対象外)。
 *
 * **字面を固定している。** `src/` 側のテストはこのファイルを import せず、文字列として読んで
 * 下の `Object.freeze({` から `});` までの帯を取り出す。**1行1件**
 * (`  役割名: "CSS 名",`)の形を崩すと、その取り出しが0件になって赤くなる。
 *
 * **このファイルはカーネルの値を import しない**(`import type` だけが許される)。
 */
export const THEME_ROLE_TO_CSS_PROPERTY: Readonly<Record<string, string>> = Object.freeze({
  danger: "--color-danger",
  body_text: "--color-text",
  label_text: "--color-text-label",
  placeholder_text: "--color-text-placeholder",
  secondary_text: "--color-text-secondary",
  border_color: "--color-border",
  page_background: "--color-page-background",
  highlight_surface: "--color-surface-highlight",
  primary_fill: "--color-primary-fill",
  on_primary: "--color-on-primary",
  overlay_background: "--color-overlay-background",
  overlay_text: "--color-overlay-text",
  body_font: "--font-family-base",
  note_font_size: "--font-size-note",
  secondary_font_size: "--font-size-secondary",
  body_line_height: "--line-height-base",
  space_1: "--space-1",
  space_2: "--space-2",
  space_3: "--space-3",
  space_4: "--space-4",
  space_5: "--space-5",
  space_6: "--space-6",
  border_width: "--border-width",
  control_radius: "--control-border-radius",
  surface_shadow: "--surface-shadow",
  focus_ring: "--focus-outline-color",
  focus_ring_width: "--focus-outline-width",
});

/**
 * テーマのスロット(キーは役割名)を、CSS カスタムプロパティ名をキーにしたオブジェクトへ写す。
 *
 * **5経路(適用 `AppWorkspace` の `themeScopeStyle` / 候補の見本 `ThemePreviewPanel` /
 * 持ち出し `ThemeExportPanel` / 取り込みのプレビュー(`AppThemeScope` 経由)/ 候補
 * `theme-candidates.ts` の見本)はすべてこの1本を通る。** 規則はこの関数と上の表の1本だけである。
 *
 * - 値は加工しない(値域は `schemas/manifest.schema.json` の `$defs/theme` が適用時に縛る。
 *   ここで再検証すると規則が2箇所に住む)。
 * - **表に無いキーは落とす**(旧名・未知の名前。継承したプロパティ名も拾わない)。
 *   保存済みのマニフェストはスキーマを通っているので、製品の経路で落ちるキーは無い。
 *
 * **【V20-M9 / ADR-0474 §Decision 1-6。`ADR-0473` §Decision 2-2 の1文を引き直した】** 生の色について
 * 規則を2本だけ足した(写像の帯の外。帯は役割名27件の1行1件のまま):
 *
 * 1. キー `palette_<名前>` → `--palette-<名前の _ を - にしたもの>`(上の「表に無いキーは落とす」は
 *    `palette_` で始まるキーについてだけ偽になる)。
 * 2. 値 `$palette_<名前>` → `var(--palette-<同じ変換>)`(役割の枠の値でも、生の色の値でも)。
 *
 * **参照を実値に置き換えない**(解決はカーネルの `resolveThemeSlots` だけ。表示層は呼ばない)。
 * ブラウザが CSS の変数参照として解く。
 */
export function themeSlotsToCssProperties(
  slots: Readonly<Record<string, string>>,
): Record<string, string> {
  const css: Record<string, string> = {};
  for (const [role, value] of Object.entries(slots)) {
    if (role.startsWith(RAW_COLOR_KEY_PREFIX)) {
      css[rawColorCustomProperty(role.slice(RAW_COLOR_KEY_PREFIX.length))] = toCssValue(value);
      continue;
    }
    if (!Object.hasOwn(THEME_ROLE_TO_CSS_PROPERTY, role)) {
      continue;
    }
    const name = THEME_ROLE_TO_CSS_PROPERTY[role];
    if (name !== undefined) {
      css[name] = toCssValue(value);
    }
  }
  return css;
}

/** 生の色のキーの接頭辞(規則 (1))。 */
const RAW_COLOR_KEY_PREFIX = "palette_";
/** 参照の綴りの接頭辞(規則 (2))。 */
const RAW_COLOR_REFERENCE_PREFIX = "$palette_";

/** 規則 (1) と (2) が共有する名前の写し(`_` → `-`)。`[a-z0-9_]` の上で単射である。 */
function rawColorCustomProperty(name: string): string {
  return `--palette-${name.replaceAll("_", "-")}`;
}

/** 規則 (2): 参照の綴りを `var(--palette-…)` へ写すだけ。**解かない。** 参照でない値はそのまま。 */
function toCssValue(value: string): string {
  return value.startsWith(RAW_COLOR_REFERENCE_PREFIX)
    ? `var(${rawColorCustomProperty(value.slice(RAW_COLOR_REFERENCE_PREFIX.length))})`
    : value;
}
