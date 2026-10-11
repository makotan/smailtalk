import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONTRAST_THRESHOLDS,
  checkThemeContrast,
  contrastRatio,
  THEME_CONTRAST_PAIRS,
  THEME_SLOT_ROLES,
} from "./theme-contrast.ts";

/**
 * テーマのコントラスト検査の単体テスト(V3-M1-T02 / ADR-0046 §1b / §1c / §3 限定3・限定4)。
 *
 * **本タスクは結線しない**(適用経路への結線・拒否の「全か無か」・`dry_run` の一致は
 * V3-M1-T03 の完了条件)。ここで固定するのは純関数の振る舞いだけである。
 *
 * **閾値の数値は WCAG から借りているが「WCAG 準拠」ではない**(ADR-0046 §1c。
 * 借りた数値の正当性をこの製品は独立に持たない)。検査が担保するのは
 * 「閾値未満の配色を適用できないこと」だけであって、「良い配色になること」ではない。
 */

/**
 * V3-M1-T01 が確定させた既定値(`docs/plan/v3/03-token-slot-inventory.md` §9-1 の色9件)。
 *
 * **これは集合の正ではない。** 正は `web/test/__fixtures__/styles-token-slots.txt` と
 * `web/src/styles.css` である。ここに置いてあるのは**テストの入力**であり、
 * `styles.css` の値が変わったときに自動追随しない(その限界は記録 §11 に書いた)。
 */
const T01_DEFAULT_COLORS: Readonly<Record<string, string>> = {
  body_text: "#000",
  secondary_text: "#666",
  label_text: "#666",
  placeholder_text: "#666",
  danger: "#a00",
  page_background: "#fff",
  highlight_surface: "#f2f2f2",
  border_color: "#ddd",
  focus_ring: "#005fcc",
};

describe("contrastRatio(sRGB の相対輝度からの比)", () => {
  test("黒と白は 21:1(比の上限)", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
  });

  test("同じ色は 1:1(比の下限)", () => {
    expect(contrastRatio("#7f7f7f", "#7f7f7f")).toBeCloseTo(1, 10);
  });

  test("引数の順序に依らない(明るい側を分子にする)", () => {
    const a = contrastRatio("#666666", "#ffffff");
    const b = contrastRatio("#ffffff", "#666666");
    expect(a).not.toBeNull();
    expect(b).toBe(a);
  });

  test("3桁の短縮形は6桁形と同じ値になる", () => {
    expect(contrastRatio("#000", "#fff")).toBe(contrastRatio("#000000", "#ffffff"));
    expect(contrastRatio("#a00", "#fff")).toBe(contrastRatio("#aa0000", "#ffffff"));
  });

  test("大文字小文字を区別しない", () => {
    expect(contrastRatio("#A00", "#FFF")).toBe(contrastRatio("#a00", "#fff"));
  });

  test("色として読めない値は null(例外を投げない)", () => {
    expect(contrastRatio("red", "#fff")).toBeNull();
    expect(contrastRatio("#fff", "rgb(0,0,0)")).toBeNull();
    expect(contrastRatio("#ff", "#fff")).toBeNull();
    expect(contrastRatio("#fffff", "#fff")).toBeNull();
    expect(contrastRatio("#gggggg", "#fff")).toBeNull();
    expect(contrastRatio("", "#fff")).toBeNull();
  });

  test("T01 の既定値の実測比(記録に載せた数値と一致する)", () => {
    // 本文テキスト側(閾値 4.5:1)
    expect(contrastRatio("#666", "#fff")).toBeCloseTo(5.74, 2);
    expect(contrastRatio("#666", "#f2f2f2")).toBeCloseTo(5.13, 2);
    expect(contrastRatio("#a00", "#fff")).toBeCloseTo(7.75, 2);
    expect(contrastRatio("#a00", "#f2f2f2")).toBeCloseTo(6.92, 2);
    expect(contrastRatio("#000", "#f2f2f2")).toBeCloseTo(18.76, 2);
    // 非テキスト側(閾値 3:1)
    expect(contrastRatio("#005fcc", "#fff")).toBeCloseTo(5.985, 3);
    expect(contrastRatio("#005fcc", "#f2f2f2")).toBeCloseTo(5.35, 2);
    expect(contrastRatio("#ddd", "#fff")).toBeCloseTo(1.36, 2);
    expect(contrastRatio("#ddd", "#f2f2f2")).toBeCloseTo(1.21, 2);
  });
});

describe("閾値(ADR-0046 §3 限定4: 2つだけ)", () => {
  test("閾値は本文テキスト 4.5:1 と非テキスト 3:1 の2つだけである", () => {
    expect(CONTRAST_THRESHOLDS).toEqual({ text: 4.5, "non-text": 3 });
    expect(Object.keys(CONTRAST_THRESHOLDS)).toHaveLength(2);
  });

  test("段階を増やせない(定数が凍結されている)", () => {
    expect(Object.isFrozen(CONTRAST_THRESHOLDS)).toBe(true);
  });
});

describe("役割表(ADR-0046 §3 限定3: 役割の属性だけを持つ最小形)", () => {
  test("スロット集合は styles-token-slots.txt のテーマ対象25件と同じ大きさである", () => {
    // 集合そのものの照合(== `$defs/theme` の properties キー集合)は V3-M1-T03 の
    // 段階B が本ファイルに追記する(ADR-0046 2026-07-25 追記の分割 (ii))。
    //
    // **28 → 25 に落としたのは V3-M1-T03(段階A)である**(v3-m1.md §2 T03 完了条件21)——
    // `--shell-max-width` / `--border-style` / `--focus-outline-style` はテーマ対象外で
    // ある(理由は `web/test/__fixtures__/styles-token-slots.txt` の「テーマ対象外」節)。
    // 【V20-M9 / ADR-0474】25 → 23(2枠 --detail-label-width / --login-max-width を語彙から外した)。旧(逐語): expect(Object.keys(THEME_SLOT_ROLES)).toHaveLength(25);
    // 【V20-M9 / ADR-0474】23 → 27(4枠 primary_fill / on_primary / overlay_background / overlay_text を足した)。旧(逐語): expect(Object.keys(THEME_SLOT_ROLES)).toHaveLength(23);
    expect(Object.keys(THEME_SLOT_ROLES)).toHaveLength(27);
  });

  test("テーマ対象外の3件は役割表に載っていない(完了条件21)", () => {
    // **3件はいずれも `not-a-color` だったので、検査対象の対は1組も減らない** ——
    // 下の「14組」のテストが同時に緑であることがその機械的な証拠である。
    for (const excluded of ["--shell-max-width", "--border-style", "--focus-outline-style"]) {
      expect(Object.keys(THEME_SLOT_ROLES)).not.toContain(excluded);
    }
  });

  test("役割表は役割の属性だけを持つ(値・CSS プロパティ名・既定値を1つも持たない)", () => {
    // **【V20-M8 / ADR-0473】キーは役割名である。** 旧期待値(逐語)は
    // `expect(name.startsWith("--")).toBe(true);` —— キーが CSS カスタムプロパティ名だった頃の形。
    // 今日は「`--` で始まるのは名前を残した2件(`D-V20-12`。`V20-M9` が語彙から外す)だけで、
    // 残る23件は平たい `snake_case`」を固定する。**CSS 名はこの表に1つも無い**(写像は
    // `web/src/theme-role-map.ts` の1本だけが持つ)。
    const kept = Object.keys(THEME_SLOT_ROLES).filter((name) => name.startsWith("--"));
    // 【V20-M9 / ADR-0474 §1-3】2件を外したので0件。旧(逐語):
    // `expect(kept).toEqual(["--detail-label-width", "--login-max-width"]);`
    expect(kept).toEqual([]);
    for (const [name, role] of Object.entries(THEME_SLOT_ROLES)) {
      if (!kept.includes(name)) {
        expect(name, name).toMatch(/^[a-z][a-z0-9_]*$/);
      }
      const keys = Object.keys(role).sort();
      // 【V20-M9 / ADR-0474 §1-8(ADR-0046 限定3 の第2列を引き直した)】前景に `surfaces`、背景に `surface` を足した。
      // 旧(逐語): 前景 `["kind", "target"]` / それ以外 `["kind"]`。
      if (role.kind === "foreground") {
        expect(keys).toEqual(["kind", "surfaces", "target"]);
      } else if (role.kind === "background") {
        expect(keys).toEqual(["kind", "surface"]);
      } else {
        expect(keys).toEqual(["kind"]);
      }
    }
  });

  test("色スロット9件の役割が確定している(前景テキスト5 / 前景非テキスト2 / 背景2)", () => {
    const byRole = (kind: string, target?: string) =>
      Object.entries(THEME_SLOT_ROLES)
        .filter(
          ([, role]) =>
            role.kind === kind && ("target" in role ? role.target : undefined) === target,
        )
        .map(([name]) => name)
        .sort();

    // 【V20-M8】役割名の名前順(`.sort()`)で並ぶ。旧名のときとは並びが違う。
    // 【V20-M9 / ADR-0474 §1-2】色の枠 9 → 13(前景テキスト 5 → 7 / 背景 2 → 4)。テスト名は引き直しの前の逐語。
    // 旧(逐語): 前景テキストは上の5件、背景は `["highlight_surface", "page_background"]`。
    expect(byRole("foreground", "text")).toEqual([
      "body_text",
      "danger",
      "label_text",
      "on_primary",
      "overlay_text",
      "placeholder_text",
      "secondary_text",
    ]);
    expect(byRole("foreground", "non-text")).toEqual(["border_color", "focus_ring"]);
    expect(byRole("background")).toEqual([
      "highlight_surface",
      "overlay_background",
      "page_background",
      "primary_fill",
    ]);
  });

  // 【V20-M9 / ADR-0474 §1-3】テスト名の「16件」は撤去の前の逐語である(今日は14件)。
  test("色でないスロット16件は not-a-color(ペアを1つも生まない)", () => {
    // **19 → 16 は完了条件21 の3件を外した結果である**(3件はどれも `not-a-color`)。
    const notColor = Object.entries(THEME_SLOT_ROLES)
      .filter(([, role]) => role.kind === "not-a-color")
      .map(([name]) => name);
    // 【V20-M9 / ADR-0474】16 → 14(`not-a-color` の2枠 --detail-label-width / --login-max-width を外した)。
    // 旧(逐語): expect(notColor).toHaveLength(16);
    expect(notColor).toHaveLength(14);
    for (const name of notColor) {
      expect(THEME_CONTRAST_PAIRS.some((p) => p.foreground === name || p.background === name)).toBe(
        false,
      );
    }
  });
});

describe("ペア生成(ADR-0046 §3 限定3 / T02 完了条件2)", () => {
  // 【V20-M9 / ADR-0474 §1-8】組は 14 → 23(面ごとの直積)。テスト名は引き直しの前の逐語である。
  // 下の期待値は今日の14組に小窓8組と主ボタン1組を名前順の位置に足したもの(今日の14行は1行も書き換えていない)。
  test("役割の直積として14組が機械的に生成される(一覧を期待値に固定する)", () => {
    // **【V20-M8 / ADR-0473】並びは役割名の名前順である**(`generatePairs` は名前順に並べてから
    // 直積を作る)。旧名のときの並び(`--color-danger` が先頭、背景は `--color-page-background` が先)
    // とは違う —— **組の集合は14組のまま1組も変わっていない**(組の中身は旧名の組と1対1)。
    // 名前順が変わったので、誤りが返る順序も変わる(振る舞いの変化。`ADR-0473` が書く)。
    expect(THEME_CONTRAST_PAIRS).toEqual([
      { foreground: "body_text", background: "highlight_surface", target: "text" },
      { foreground: "body_text", background: "overlay_background", target: "text" },
      { foreground: "body_text", background: "page_background", target: "text" },
      { foreground: "danger", background: "highlight_surface", target: "text" },
      { foreground: "danger", background: "overlay_background", target: "text" },
      { foreground: "danger", background: "page_background", target: "text" },
      { foreground: "label_text", background: "highlight_surface", target: "text" },
      { foreground: "label_text", background: "overlay_background", target: "text" },
      { foreground: "label_text", background: "page_background", target: "text" },
      { foreground: "on_primary", background: "primary_fill", target: "text" },
      { foreground: "overlay_text", background: "overlay_background", target: "text" },
      { foreground: "placeholder_text", background: "highlight_surface", target: "text" },
      { foreground: "placeholder_text", background: "overlay_background", target: "text" },
      { foreground: "placeholder_text", background: "page_background", target: "text" },
      { foreground: "secondary_text", background: "highlight_surface", target: "text" },
      { foreground: "secondary_text", background: "overlay_background", target: "text" },
      { foreground: "secondary_text", background: "page_background", target: "text" },
      { foreground: "border_color", background: "highlight_surface", target: "non-text" },
      { foreground: "border_color", background: "overlay_background", target: "non-text" },
      { foreground: "border_color", background: "page_background", target: "non-text" },
      { foreground: "focus_ring", background: "highlight_surface", target: "non-text" },
      { foreground: "focus_ring", background: "overlay_background", target: "non-text" },
      { foreground: "focus_ring", background: "page_background", target: "non-text" },
    ]);
  });

  test(":hover / :focus-visible でしか現れないペア(03 §7 の #5 / #12 / #16)を検査に含める", () => {
    // `highlight_surface`(`#f2f2f2`)は
    // `.list-row-interactive:hover, .list-row-interactive:focus-visible` にしか現れない
    // (`web/src/styles.css`)。**背景として役割表に載っているので、直積が自動的に含める。**
    const hoverOnly = THEME_CONTRAST_PAIRS.filter(
      (pair) => pair.background === "highlight_surface",
    );
    expect(hoverOnly).toHaveLength(7);

    // 03 §7 が名指しした3組が実際に入っていること。
    expect(hoverOnly).toContainEqual({
      foreground: "placeholder_text", // #5: .field-empty の #666 が #f2f2f2 に載る
      background: "highlight_surface",
      target: "text",
    });
    expect(hoverOnly).toContainEqual({
      foreground: "danger", // #12: .field-unresolved の #a00 が #f2f2f2 に載る
      background: "highlight_surface",
      target: "text",
    });
    expect(hoverOnly).toContainEqual({
      foreground: "border_color", // #16: 枠線の #ddd が #f2f2f2 の上に描かれる
      background: "highlight_surface",
      target: "non-text",
    });
  });

  test("ペアは凍結されている(実行時に増やせない)", () => {
    expect(Object.isFrozen(THEME_CONTRAST_PAIRS)).toBe(true);
  });
});

describe("checkThemeContrast(ValidationError[] を返す)", () => {
  test("閾値を満たすテーマはエラー0件", () => {
    expect(
      checkThemeContrast({
        ...T01_DEFAULT_COLORS,
        border_color: "#767676", // 既定の #ddd は 3:1 を満たさない(下のテストが固定する)
      }),
    ).toEqual([]);
  });

  test("白地に白文字は本文テキストの閾値で落ち、path が RFC 6901 でスロットを指す", () => {
    const errors = checkThemeContrast({
      body_text: "#ffffff",
      page_background: "#ffffff",
    });
    expect(errors).toHaveLength(1);
    const [error] = errors;
    expect(error?.path).toBe("/app/theme/body_text");
    // どのスロット対がどの比で落ちたかを名指しする(比の値と閾値の両方を出す)。
    expect(error?.message).toContain("body_text");
    expect(error?.message).toContain("page_background");
    expect(error?.message).toContain("1.00");
    expect(error?.message).toContain("4.5");
    expect(error?.hint).toBeDefined();
  });

  test("非テキスト(枠線)は 3:1 で判定する —— 4.5:1 は満たさなくても通る", () => {
    // #767676 は白地に対して 4.54:1(テキスト閾値を満たす)。
    // #949494 は白地に対して 3.03:1(テキスト閾値は満たさないが非テキスト閾値は満たす)。
    expect(contrastRatio("#949494", "#ffffff")).toBeCloseTo(3.03, 2);
    expect(
      checkThemeContrast({
        border_color: "#949494",
        page_background: "#ffffff",
      }),
    ).toEqual([]);
    // 同じ色を本文テキストのスロットに入れると落ちる(閾値が違うことの証明)。
    const errors = checkThemeContrast({
      body_text: "#949494",
      page_background: "#ffffff",
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("/app/theme/body_text");
  });

  test("落ちたペアが複数あれば全件返す(1件目で打ち切らない)", () => {
    const errors = checkThemeContrast({
      body_text: "#fff",
      danger: "#fff",
      page_background: "#fff",
      highlight_surface: "#fff",
    });
    // (text, danger) × (page-background, surface-highlight) の4組が落ちる。
    expect(errors).toHaveLength(4);
    // 【V20-M8】役割名の名前順(`.sort()`)で並べた期待値。旧名のときは danger 側が先だった。
    expect(errors.map((e) => e.path).sort()).toEqual([
      "/app/theme/body_text",
      "/app/theme/body_text",
      "/app/theme/danger",
      "/app/theme/danger",
    ]);
  });

  test("比は丸めずに比較する(4.49… を 4.5 に丸めて通さない)", () => {
    // #767776 は白地に対して 4.496:1 —— 小数第2位で丸めると 4.50 になる値。
    const ratio = contrastRatio("#767776", "#ffffff");
    expect(ratio).not.toBeNull();
    expect(ratio ?? 0).toBeLessThan(4.5);
    expect(Number((ratio ?? 0).toFixed(2))).toBe(4.5);
    expect(checkThemeContrast({ body_text: "#767776", page_background: "#ffffff" })).toHaveLength(
      1,
    );
  });

  test("色として読めない値は fail-closed で拒否する(比を計算できないため)", () => {
    const errors = checkThemeContrast({
      body_text: "rebeccapurple",
      page_background: "#fff",
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("/app/theme/body_text");
    expect(errors[0]?.message).toContain("色として読めません");
  });

  test("文字列でない値も fail-closed で拒否する", () => {
    expect(checkThemeContrast({ body_text: 123 })).toHaveLength(1);
    expect(checkThemeContrast({ body_text: null })).toHaveLength(1);
  });

  test("色でないスロットの値は検査しない(読めない値でもエラーにしない)", () => {
    expect(checkThemeContrast({ space_1: "0.25rem", surface_shadow: "none" })).toEqual([]);
  });

  test("片側しか無いペアは検査しない(既定値をカーネルが持たないため)", () => {
    // 前景だけを指定した場合、背景側は `styles.css` の既定値だが、
    // **カーネルはその値を持たない**(ADR-0046 限定3。値を持てばトークン表になる)。
    // したがって比を計算できず、検査を飛ばす。**これは fail-closed の穴である**(記録 §11-2)。
    expect(checkThemeContrast({ body_text: "#fff" })).toEqual([]);
    expect(checkThemeContrast({ page_background: "#fff" })).toEqual([]);
  });

  test("役割表に無いキーは無視する(値域はスキーマが縛る。T03)", () => {
    expect(checkThemeContrast({ "--not-a-slot": "#fff", origin: "template-app" })).toEqual([]);
  });

  test("空のテーマはエラー0件", () => {
    expect(checkThemeContrast({})).toEqual([]);
  });

  test("path の接頭辞は差し替えられる(T03 の格納形が決まっていないため)", () => {
    const errors = checkThemeContrast(
      { body_text: "#fff", page_background: "#fff" },
      "/app/theme/slots",
    );
    expect(errors[0]?.path).toBe("/app/theme/slots/body_text");
  });

  test("【正直に書く】T01 の既定値は非テキスト閾値を2組で満たさない", () => {
    // **これは実測である。** 既定の枠線色 `#ddd` は白地に対して 1.36:1、
    // ホバー地色 `#f2f2f2` に対して 1.21:1 であり、どちらも非テキスト閾値 3:1 を下回る。
    // すなわち **`styles.css` の現在の既定配色をそのままテーマとして与えると拒否される。**
    // 既定配色は `styles.css` にあってマニフェストには無いので現時点で何も壊れないが、
    // T04 / T05 が既定配色をテーマとして流し込むなら、この2組が壁になる(記録 §11-4)。
    const errors = checkThemeContrast(T01_DEFAULT_COLORS);
    expect(errors).toHaveLength(2);
    expect(errors.map((e) => e.path)).toEqual([
      "/app/theme/border_color",
      "/app/theme/border_color",
    ]);
    // 【V20-M8 / ADR-0473】旧(逐語): `errors[0]` が "1.36"、`errors[1]` が "1.21"。組は名前順に作るので、
    // 背景の名前順(highlight_surface < page_background)で ホバー地色の組が先に来る。比は1ビットも変わらない。
    expect(errors[0]?.message).toContain("1.21");
    expect(errors[1]?.message).toContain("1.36");
    for (const error of errors) {
      expect(error.message).toContain("3:1");
    }
  });
});

// ---------------------------------------------------------------------------
// 三重管理の照合(その2)—— 役割表 == `$defs/theme` の properties キー集合
// V3-M1-T03 段階B の完了条件12 / 18 (ii)
// ---------------------------------------------------------------------------

/**
 * 照合の相手を**ファイルとして**読む(`src/kernel/validate.ts` が
 * `schemas/manifest.schema.json` を `readFileSync` + `JSON.parse` で読んでいるのと同型)。
 *
 * **`src/kernel/theme-contrast.ts` はこのスキーマを import していない** ——
 * 役割表は「役割の属性だけを持つ最小形」であってスロット表ではないので
 * (ADR-0046 §3 限定3 / §1b の Δ10 の論証)、実装側に依存関係を作らず、
 * **照合はテストの側でだけ行う。**
 */
const MANIFEST_SCHEMA_FOR_PARITY = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "..", "schemas", "manifest.schema.json"), "utf-8"),
) as {
  $defs: { theme: { properties: Record<string, unknown>; required: string[] } };
};

describe("三重管理の照合 (ii): 役割表 == `$defs/theme`(ADR-0046 2026-07-25 追記の分割)", () => {
  /**
   * ## この検査が塞ぐ穴
   *
   * 役割表とスキーマが食い違うと、**スキーマは受け取るのに検査が1組も測らないスロット**
   * (または逆に**存在しないスロットを測ろうとして黙って何も測らない**役割)が生まれる。
   * どちらも**全テストが緑のまま**起こる —— `checkThemeContrast` は役割表に無いキーを
   * 無視し、値が `undefined` の対は測らないからである(同関数の doc)。
   *
   * ## 残りの1本
   *
   * `styles-token-slots.txt` == `$defs/theme` は **`web/test/theme-slot-parity.test.ts`**
   * が見る(`web/` からカーネルの値を import できないため。ADR-0009 限定2)。
   * **2本が両方緑であれば3集合の一致が推移律で閉じる。**
   */
  test("`THEME_SLOT_ROLES` のキー集合が `$defs/theme` の properties キー集合と一致する", () => {
    const roleKeys = Object.keys(THEME_SLOT_ROLES).sort();
    const schemaKeys = Object.keys(MANIFEST_SCHEMA_FOR_PARITY.$defs.theme.properties).sort();

    const added = schemaKeys.filter((name) => !roleKeys.includes(name));
    const removed = roleKeys.filter((name) => !schemaKeys.includes(name));

    // **赤くなったらどちらかを直す前に、どちらが正しいのかを決めること。**
    // スロットを増やす側なら門A が要る(ADR-0046 §3a 1 / ADR-0047 §3a)。
    expect({ added, removed }).toEqual({ added: [], removed: [] });
    // 【V20-M9 / ADR-0474】25 → 23(2枠 --detail-label-width / --login-max-width を語彙から外した)。旧(逐語): expect(roleKeys).toHaveLength(25);
    // 【V20-M9 / ADR-0474】23 → 27(4枠 primary_fill / on_primary / overlay_background / overlay_text を足した)。旧(逐語): expect(roleKeys).toHaveLength(23);
    expect(roleKeys).toHaveLength(27);
  });

  test("`$defs/theme` の required も同じ25キーである(部分テーマを作らない)", () => {
    // ADR-0047 の 2026-07-25 追記 (2)。**全スロット必須でないと、片側しか指定されて
    // いない対が1組も検査されない**(この検査の穴。`checkThemeContrast` の doc)。
    expect([...MANIFEST_SCHEMA_FOR_PARITY.$defs.theme.required].sort()).toEqual(
      Object.keys(MANIFEST_SCHEMA_FOR_PARITY.$defs.theme.properties).sort(),
    );
  });

  test("役割表のキーは役割名で、CSS カスタムプロパティ名への写像は web/src/theme-role-map.ts の1本だけが持つ", () => {
    // **【V20-M8 / ADR-0473】この test の名前と中身を引き直した。** 旧名(逐語):
    // 「役割表のキーも CSS カスタムプロパティ名そのものである(変換規則は恒等の1本だけ)」。
    // 旧期待値(逐語): `expect(name).toMatch(/^--[a-z][a-z0-9-]*$/);`。
    // **規則が2本になると、持ち出した `theme.css` が「形式は安定しているが当たらない」状態になる**
    // (v3-m1.md T05-4)—— この懸念は変わらないので、規則(写像)の置き場が1本であることを固定する。
    const kept = ["--detail-label-width", "--login-max-width"];
    for (const name of Object.keys(THEME_SLOT_ROLES)) {
      if (kept.includes(name)) {
        continue;
      }
      expect(name, name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
    // 写像ファイルは import せず文字列として読む。役割表の25キーのそれぞれが、帯の中にちょうど1行ある。
    const mapSource = readFileSync(
      join(import.meta.dir, "..", "..", "web", "src", "theme-role-map.ts"),
      "utf-8",
    );
    const head =
      "export const THEME_ROLE_TO_CSS_PROPERTY: Readonly<Record<string, string>> = Object.freeze({";
    const start = mapSource.indexOf(head);
    expect(start).toBeGreaterThanOrEqual(0);
    const band = mapSource.slice(start + head.length, mapSource.indexOf("\n});", start));
    const bandKeys = band
      .split("\n")
      .map((line) => /^ {2}(?:([a-z][a-z0-9_]*)|"(--[a-z0-9-]+)"): "--[a-z0-9-]+",$/.exec(line))
      .filter((match) => match !== null)
      .map((match) => String(match[1] ?? match[2]));
    expect(bandKeys).toEqual(Object.keys(THEME_SLOT_ROLES));
    // **このファイル(カーネル)は CSS の名前を1つも持たない** —— 写像を2本にしない。
    const kernelSource = readFileSync(join(import.meta.dir, "theme-contrast.ts"), "utf-8");
    expect(kernelSource).not.toContain("THEME_ROLE_TO_CSS_PROPERTY =");
  });
});

// ---------------------------------------------------------------------------
// V20-M6-T00 色の表記を読む口を、読み手の一覧に建て替える(振る舞いは変えない)
// ---------------------------------------------------------------------------

/**
 * 読み手の一覧は非 export である(公開の識別子を増やさない。ADR-0463 限定5)。
 * **したがって要素数はソースから数えるしかない。** ここでは注釈を剥いだ本文から
 * 一覧の宣言を名前で引き当て、凍結配列の要素を数える。
 *
 * **この検査はソースの走査である。** 逐語を残したまま中身を差し替えると騙せる
 * (記録 `v20-m6-t00.md` に限界として書いた)。振る舞いの側の担保は、同じファイルの
 * 「読み手を1つも持たない一覧」の検査(V20-M6-T01)が持つ。
 */
const THEME_CONTRAST_SOURCE_WITHOUT_COMMENTS = readFileSync(
  join(import.meta.dir, "theme-contrast.ts"),
  "utf-8",
)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

/** 一覧の宣言 `const COLOR_NOTATION_READERS ... = Object.freeze([ ... ]);` の中身を返す。 */
function colorNotationReadersBody(): string | null {
  const match = /const COLOR_NOTATION_READERS\b[^=]*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/.exec(
    THEME_CONTRAST_SOURCE_WITHOUT_COMMENTS,
  );
  return match?.[1] ?? null;
}

describe("V20-M6-T00 読み手の一覧(表記ごとの記述子の凍結配列)", () => {
  test("読み手の一覧が非 export の凍結配列として実在する", () => {
    const body = colorNotationReadersBody();
    expect(body).not.toBeNull();
    expect(THEME_CONTRAST_SOURCE_WITHOUT_COMMENTS).not.toMatch(
      /export\s+const\s+COLOR_NOTATION_READERS\b/,
    );
  });

  // **【V20-M7-T00 で期待値を 1 → 2 に打ち直した】** 明るさ基準の表記(oklch)の記述子を
  // 1つ足したため(ADR-0463 限定2「足す表記は1種ちょうど」)。3桁と6桁は今日も同じ記述子の中。
  // テスト名は今日の中身に合わせて直した(旧名「今日の一覧の要素数は16進の記述子だけである(3桁と6桁は同じ記述子の中)」)。
  test("一覧の要素数は16進と oklch の記述子の2つである(3桁と6桁は同じ記述子の中)", () => {
    const body = colorNotationReadersBody() ?? "";
    const entries = body
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    expect(entries).toEqual(["HEX_NOTATION_READER", "OKLCH_NOTATION_READER"]);
    expect(entries).toHaveLength(2);
  });

  test("照合(正規表現の実行)を行う関数は channels だけである", () => {
    const parts = THEME_CONTRAST_SOURCE_WITHOUT_COMMENTS.split(
      /(?:export )?function ([A-Za-z0-9_]+)\s*\(/,
    );
    const mouths: string[] = [];
    for (let i = 1; i < parts.length; i += 2) {
      const name = parts[i] ?? "";
      const body = parts[i + 1] ?? "";
      if (body.includes(".exec(")) {
        mouths.push(name);
      }
    }
    expect(mouths).toEqual(["channels"]);
  });

  test("読み手の一覧と記述子はスロット名を1つも持たない(役割表と別の表にならない)", () => {
    const body = colorNotationReadersBody() ?? "";
    const descriptor =
      /const HEX_NOTATION_READER\b[^=]*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/.exec(
        THEME_CONTRAST_SOURCE_WITHOUT_COMMENTS,
      )?.[1] ?? null;
    expect(descriptor).not.toBeNull();
    // 【V20-M7-T02】oklch の記述子も同じくスロット名を1つも持たない。
    const oklchDescriptor =
      /const OKLCH_NOTATION_READER\b[^=]*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/.exec(
        THEME_CONTRAST_SOURCE_WITHOUT_COMMENTS,
      )?.[1] ?? null;
    expect(oklchDescriptor).not.toBeNull();
    for (const name of Object.keys(THEME_SLOT_ROLES)) {
      expect(body.includes(name)).toBe(false);
      expect((descriptor ?? "").includes(name)).toBe(false);
      expect((oklchDescriptor ?? "").includes(name)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// V20-M6-T01 contrastRatio は読み手の一覧越しにだけ色を読む
// ---------------------------------------------------------------------------

/** 第3引数(読み手の一覧)の型。**型の名前を export せずに**公開の署名から取り出す。 */
type ColorReaderList = NonNullable<Parameters<typeof contrastRatio>[2]>;

/** 検査の側で組んだ、16進と同じ働きの読み手(製品の記述子を import しない)。 */
const TEST_HEX_READERS: ColorReaderList = [
  {
    notation: "test-hex",
    patterns: [/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i, /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i],
    toChannels: (groups) => {
      const [r, g, b] = groups;
      if (r === undefined || g === undefined || b === undefined) {
        return null;
      }
      const widen = (d: string) => Number.parseInt(d.length === 1 ? `${d}${d}` : d, 16);
      return [widen(r), widen(g), widen(b)];
    },
  },
];

/** 検査のためだけの架空の表記 `probe-gray:NNN`(0..255 の灰色)の読み手。 */
const TEST_PROBE_GRAY_READERS: ColorReaderList = [
  {
    notation: "test-probe-gray",
    patterns: [/^probe-gray:([0-9]{1,3})$/],
    toChannels: ([level]) => {
      if (level === undefined) {
        return null;
      }
      const n = Number.parseInt(level, 10);
      return n > 255 ? null : [n, n, n];
    },
  },
];

/** 省略時の値と比べる入力。読める対と読めない対の両方を含む。 */
const T01_SAMPLE_PAIRS: readonly (readonly [string, string])[] = [
  ["#000000", "#ffffff"],
  ["#000", "#fff"],
  ["#A00", "#FFF"],
  ["#666", "#f2f2f2"],
  ["#005fcc", "#fff"],
  ["#767776", "#ffffff"],
  [" #333333 ", "#fff"],
  ["red", "#fff"],
  ["#fff", "rgb(0,0,0)"],
  ["#ff", "#fff"],
  ["#fffff", "#fff"],
  ["#gggggg", "#fff"],
  ["", "#fff"],
  ["#ffffffff", "#fff"],
];

describe("V20-M6-T01 contrastRatio の第3引数(読み手の一覧)", () => {
  test("読み手を1つも持たない一覧を渡すと、16進の対も全件 null になる", () => {
    const readable = T01_SAMPLE_PAIRS.filter(([a, b]) => contrastRatio(a, b) !== null);
    // 陽性対照: 省略時に読める対が実際に在ること(在れば以下の null は一覧の効果である)。
    expect(readable.length).toBeGreaterThan(0);
    for (const [a, b] of T01_SAMPLE_PAIRS) {
      expect(contrastRatio(a, b, [])).toBeNull();
    }
  });

  test("第3引数に undefined を渡すと省略時と同じ値になる", () => {
    for (const [a, b] of T01_SAMPLE_PAIRS) {
      expect(contrastRatio(a, b, undefined)).toBe(contrastRatio(a, b));
    }
  });

  test("16進と同じ働きの読み手を一覧で渡すと、省略時と同じ値になる(読めない値も同じく null)", () => {
    for (const [a, b] of T01_SAMPLE_PAIRS) {
      expect(contrastRatio(a, b, TEST_HEX_READERS)).toBe(contrastRatio(a, b));
    }
  });

  test("一覧に無い表記は読めず、一覧に在る表記だけが読める(一覧が実際に回っている)", () => {
    // 省略時の一覧は架空の表記を読まない。
    expect(contrastRatio("probe-gray:0", "probe-gray:255")).toBeNull();
    // 架空の表記の読み手だけを持つ一覧なら読め、黒と白の比になる。
    expect(contrastRatio("probe-gray:0", "probe-gray:255", TEST_PROBE_GRAY_READERS)).toBeCloseTo(
      21,
      5,
    );
    // 同じ一覧では16進が読めない(16進の読み手を持たないため)。
    expect(contrastRatio("#000", "#fff", TEST_PROBE_GRAY_READERS)).toBeNull();
    // 2つの読み手を並べると、両方の表記が読める。
    const both: ColorReaderList = [...TEST_HEX_READERS, ...TEST_PROBE_GRAY_READERS];
    expect(contrastRatio("#000", "probe-gray:255", both)).toBeCloseTo(21, 5);
  });

  test("省略時の一覧は今日どおり関数形式の表記と色名を読まない", () => {
    expect(contrastRatio("hsl(0, 0%, 0%)", "#fff")).toBeNull();
    expect(contrastRatio("rgb(0, 0, 0)", "#fff")).toBeNull();
    expect(contrastRatio("black", "#fff")).toBeNull();
    expect(contrastRatio("#000000ff", "#fff")).toBeNull();
  });

  test("関数の length(既定値の無い引数の数)は建て替えの前と同じである", () => {
    expect(checkThemeContrast.length).toBe(1);
    expect(contrastRatio.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// V20-M6-T02 対の生成は色の値を1つも読まない
// ---------------------------------------------------------------------------

/** 色スロット(前景・背景)の名前。役割表から取る(検査の側でスロット名を列挙しない)。 */
const T02_COLOR_SLOTS: readonly string[] = Object.entries(THEME_SLOT_ROLES)
  .filter(([, role]) => role.kind !== "not-a-color")
  .map(([name]) => name);

/**
 * 色スロットをすべて**既定の一覧では読めない**値にしたテーマ。
 * 値は T01 の架空の表記 `probe-gray:NNN` なので、その読み手を渡したときだけ読める。
 */
const T02_UNREADABLE_THEME: Readonly<Record<string, string>> = Object.fromEntries(
  T02_COLOR_SLOTS.map((name, index) => [name, `probe-gray:${index * 20}`]),
);

/** 色スロットをすべて同じ白にしたテーマ(どの対も 1:1 で落ちる)。 */
const T02_ALL_WHITE_THEME: Readonly<Record<string, string>> = Object.fromEntries(
  T02_COLOR_SLOTS.map((name) => [name, "#fff"]),
);

/** 対の型(公開の型を import し直さずに、公開の定数から取る)。 */
type ThemeContrastPairLike = (typeof THEME_CONTRAST_PAIRS)[number];

/** 両側の値がテーマに在る対(= 検査が測ろうとする対)。 */
function pairsWithBothValues(theme: Readonly<Record<string, string>>): ThemeContrastPairLike[] {
  return THEME_CONTRAST_PAIRS.filter(
    (pair) =>
      typeof theme[pair.foreground] === "string" && typeof theme[pair.background] === "string",
  );
}

describe("V20-M6-T02 対の生成は色の値を読まない", () => {
  test("色の値をすべて読めない文字列にしたテーマでも、測る対の数は変わらない", () => {
    const before = THEME_CONTRAST_PAIRS.map((pair) => ({ ...pair }));

    // 入力の陽性対照: 色スロットは全部「色として読めない」で拒否される(= 値は本当に読めない)。
    const errors = checkThemeContrast(T02_UNREADABLE_THEME);
    expect(errors).toHaveLength(T02_COLOR_SLOTS.length);
    for (const error of errors) {
      expect(error.message).toContain("色として読めません");
    }

    // 対の数は値の読める・読めないに依らない。
    const pairs = pairsWithBothValues(T02_UNREADABLE_THEME);
    // 【V20-M9 / ADR-0474】14 → 23(コントラストの組を面ごとに分け、小窓8組と主ボタン1組を足した。ADR-0474 §1-8)。旧(逐語): expect(pairs).toHaveLength(14);
    expect(pairs).toHaveLength(23);
    expect(THEME_CONTRAST_PAIRS).toEqual(before);

    // 同じ対は、読み手を差し替えればすべて測れる(読めるかどうかは測る時に一覧が決める)。
    const withDefault = pairs.map((pair) =>
      contrastRatio(
        T02_UNREADABLE_THEME[pair.foreground] ?? "",
        T02_UNREADABLE_THEME[pair.background] ?? "",
      ),
    );
    const withProbe = pairs.map((pair) =>
      contrastRatio(
        T02_UNREADABLE_THEME[pair.foreground] ?? "",
        T02_UNREADABLE_THEME[pair.background] ?? "",
        TEST_PROBE_GRAY_READERS,
      ),
    );
    // 【V20-M9 / ADR-0474】14 → 23(コントラストの組を面ごとに分け、小窓8組と主ボタン1組を足した。ADR-0474 §1-8)。旧(逐語): expect(withDefault.filter((ratio) => ratio === null)).toHaveLength(14);
    expect(withDefault.filter((ratio) => ratio === null)).toHaveLength(23);
    // 【V20-M9 / ADR-0474】14 → 23(コントラストの組を面ごとに分け、小窓8組と主ボタン1組を足した。ADR-0474 §1-8)。旧(逐語): expect(withProbe.filter((ratio) => typeof ratio === "number")).toHaveLength(14);
    expect(withProbe.filter((ratio) => typeof ratio === "number")).toHaveLength(23);
  });

  test("対照: 値を読んで対を絞る生成なら、同じテーマで対が0組になる", () => {
    // 検査の側だけに置いた「値を読む生成」。上の検査がこの種の生成を見分けられることを示す。
    const valueReadingPairs = (theme: Readonly<Record<string, string>>) =>
      pairsWithBothValues(theme).filter(
        (pair) =>
          contrastRatio(theme[pair.foreground] ?? "", theme[pair.background] ?? "") !== null,
      );
    expect(valueReadingPairs(T02_UNREADABLE_THEME)).toHaveLength(0);
    // 【V20-M9 / ADR-0474】14 → 23(コントラストの組を面ごとに分け、小窓8組と主ボタン1組を足した。ADR-0474 §1-8)。旧(逐語): expect(valueReadingPairs(T02_ALL_WHITE_THEME)).toHaveLength(14);
    expect(valueReadingPairs(T02_ALL_WHITE_THEME)).toHaveLength(23);
  });

  test("読める値のテーマでは、製品の検査が14組すべてを測る(全組が 1:1 で落ちる)", () => {
    const errors = checkThemeContrast(T02_ALL_WHITE_THEME);
    // 【V20-M9 / ADR-0474】14 → 23(コントラストの組を面ごとに分け、小窓8組と主ボタン1組を足した。ADR-0474 §1-8)。旧(逐語): expect(errors).toHaveLength(14);
    expect(errors).toHaveLength(23);
    for (const error of errors) {
      expect(error.message).toContain("1.00:1");
    }
  });
});

// ---------------------------------------------------------------------------
// V20-M6-T03 影の中の色は検査を素通りする(穴 H-V20-8 が在ることを固定する)
// ---------------------------------------------------------------------------

describe("V20-M6-T03 影の中の色(穴 H-V20-8 の固定)", () => {
  /**
   * **これは穴を塞ぐ検査ではなく、穴が在ることを固定する検査である。**
   * 影の中の色を検査に入れる段が来たら、この検査を書き換えること(赤くなるのが正しい)。
   */
  test("背景と同じ白を影の中に書いたテーマはエラー0件で通る(同じ色を枠線に書くと落ちる)", () => {
    const base = {
      body_text: "#000000",
      page_background: "#ffffff",
      highlight_surface: "#ffffff",
    };
    // 対照: 影の中に書く色は、背景に対して非テキストの閾値を大きく下回る。
    const ratio = contrastRatio("#fefefe", "#ffffff");
    expect(ratio).not.toBeNull();
    expect(ratio ?? Number.POSITIVE_INFINITY).toBeLessThan(CONTRAST_THRESHOLDS["non-text"] / 2);

    for (const shadow of ["0 1px 3px #fff", "0 1px 3px #fefefe", "0 1px 3px #fefefeff"]) {
      expect(checkThemeContrast({ ...base, surface_shadow: shadow })).toEqual([]);
    }

    // 対照: 同じ色を色のスロット(枠線)に書くと、背景2つに対して2件落ちる。
    const errors = checkThemeContrast({ ...base, border_color: "#fefefe" });
    expect(errors).toHaveLength(2);
    expect(errors.map((e) => e.path)).toEqual([
      "/app/theme/border_color",
      "/app/theme/border_color",
    ]);
  });
});

// ---------------------------------------------------------------------------
// V20-M6-T04 独立点検の指摘への処置(中1 / 軽1)
// ---------------------------------------------------------------------------

/** 注釈を剥いだ本文から、`function channels(` の本文(波括弧を対応させた範囲)を返す。 */
function channelsBodyRange(source: string): { readonly open: number; readonly close: number } {
  const start = source.indexOf("function channels(");
  if (start < 0) {
    return { open: -1, close: -1 };
  }
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i >= 0 && i < source.length; i += 1) {
    if (source[i] === "{") {
      depth += 1;
    } else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        return { open, close: i };
      }
    }
  }
  return { open, close: -1 };
}

describe("V20-M6-T04 点検の指摘への処置", () => {
  test("文字列の照合の呼び出しはファイル全体でちょうど1つで、channels の本文の中に在る", () => {
    // 数える呼び出し: 正規表現の実行と、文字列側から正規表現を当てる呼び出し6種。
    // 関数の宣言の形(function / const のアロー / 先頭の断片)に依らず、ファイル全体で数える。
    const calls = [
      ...THEME_CONTRAST_SOURCE_WITHOUT_COMMENTS.matchAll(
        /\.exec\(|\.match\(|matchAll\(|\.test\(|\.search\(|\.replace\(/g,
      ),
    ];
    expect(calls.map((call) => call[0])).toEqual([".exec("]);
    const { open, close } = channelsBodyRange(THEME_CONTRAST_SOURCE_WITHOUT_COMMENTS);
    expect(open).toBeGreaterThan(0);
    expect(close).toBeGreaterThan(open);
    const at = calls[0]?.index ?? -1;
    expect(at > open && at < close).toBe(true);
  });

  test("読み手の違う2つの表記を混ぜた対は、渡した一覧で読めない側があれば null になる", () => {
    // 片側だけが既定の一覧へ落ちる迂回を撃つ(16進は架空の表記の読み手だけの一覧では読めない)。
    expect(contrastRatio("#000", "probe-gray:255", TEST_PROBE_GRAY_READERS)).toBeNull();
    expect(contrastRatio("probe-gray:0", "#fff", TEST_PROBE_GRAY_READERS)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// V20-M7 明るさ基準の表記(oklch)の読み手(ADR-0463 §Decision 5 / v20-m0-t02 §3-4・§3-5)
// ---------------------------------------------------------------------------

describe("V20-M7-T00 足したら読めるようになる形", () => {
  test("oklch の黒と白は 21:1(16進の黒と白と同じ)", () => {
    expect(contrastRatio("oklch(0 0 0)", "oklch(1 0 0)")).toBeCloseTo(21, 6);
    expect(contrastRatio("oklch(0% 0 0)", "oklch(100% 0 0)")).toBeCloseTo(21, 6);
  });

  test("16進と oklch を混ぜた対も測れる", () => {
    expect(contrastRatio("#000", "oklch(1 0 0)")).toBeCloseTo(21, 6);
    expect(contrastRatio("oklch(0 0 0)", "#fff")).toBeCloseTo(21, 6);
  });

  test("oklch で書いた黒文字・白地のテーマはエラー0件", () => {
    expect(
      checkThemeContrast({
        body_text: "oklch(0 0 0)",
        page_background: "oklch(1 0 0)",
      }),
    ).toEqual([]);
  });
});

describe("V20-M7-T00 足しても読めないままであるべき形", () => {
  test.each([
    "rgb(0,0,0)",
    "rgba(0,0,0,0.5)",
    "hsl(0, 0%, 0%)",
    "color(srgb 0 0 0)",
    "lch(50% 30 100)",
    "oklab(0.5 0.1 0.1)",
    "OKLCH(0.5 0.1 250)",
    "oklch(0.5 0.1 250 / 0.5)",
    "oklch(none 0.1 250)",
    "oklch(0.5, 0.1, 250)",
    "oklch(0.5 0.1 250deg)",
    "oklch(1.5 0 0)",
    "oklch(101% 0 0)",
    "oklch(0.5 0.1 361)",
    "oklch(0.5 -0.1 250)",
    "oklch(calc(0.5) 0.1 250)",
    "oklch(var(--l) 0.1 250)",
    "red",
    "currentColor",
  ])("%s は色として読めない(null)", (value) => {
    expect(contrastRatio(value, "#fff")).toBeNull();
  });

  /*
   * 【V20-M7B-T02 で向きを変えた(ADR-0472。消していない)】旧の名前と期待(逐語):
   * test("sRGB の色域の外の oklch は色として読めず、差分全体を拒否する経路に載る", …)
   *   expect(contrastRatio("oklch(0.7 0.4 150)", "#fff")).toBeNull();
   *   errors は1件、path は /app/theme/body_text、message に「色として読めません」。
   * 今日は色域の外も読み、2つの画面の見え方の小さいほうの比で判定する。同じ色・同じ地で、
   * 読めることと、落ちる理由が「読めない」ではなく比であることを固定する。
   */
  test("sRGB の色域の外の oklch も色として読み、比で判定する(V20-M7B で向きを変えた)", () => {
    // 鮮やかな緑(C=0.4)は sRGB で表せない。通常の画面では切り詰めた色、広色域の画面では元の色の明るさで測る。
    const ratio = contrastRatio("oklch(0.7 0.4 150)", "#fff");
    expect(ratio).not.toBeNull();
    expect(Number.isFinite(ratio)).toBe(true);
    const errors = checkThemeContrast({
      body_text: "oklch(0.7 0.4 150)",
      page_background: "#ffffff",
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("/app/theme/body_text");
    expect(errors[0]?.message).not.toContain("色として読めません");
    expect(errors[0]?.message).toContain("通常の画面では");
    expect(errors[0]?.message).toContain("広色域の画面では");
  });
});

/**
 * 同じ色の16進と oklch の対応(**テストの入力。製品の変換で作った値ではない**)。
 *
 * 出典: Björn Ottosson「A perceptual color space for image processing」(2020)の OKLab の定義を
 * CSS Color Module Level 4 の sRGB ⇄ OKLCH の変換で計算した値として、公開の実装(culori / colorjs.io /
 * oklch.com)が返す値を小数6桁(H は4桁)に丸めて写した。**本段の担い手はこの値を外部の実装と
 * この場で突き合わせていない**(点検で Chromium と突き合わせる予定。穴 H-V20-79)。
 * #808080 は対応の9組目(灰色。C = 0 の経路を通す)。
 */
const V20_M7_KNOWN_PAIRS: readonly (readonly [string, string])[] = [
  ["#ffffff", "oklch(1 0 0)"],
  ["#000000", "oklch(0 0 0)"],
  ["#ff0000", "oklch(0.627955 0.257683 29.2339)"],
  ["#00ff00", "oklch(0.86644 0.294827 142.4953)"],
  ["#0000ff", "oklch(0.452014 0.313214 264.052)"],
  ["#ffff00", "oklch(0.967983 0.211006 109.7692)"],
  ["#00ffff", "oklch(0.905399 0.15455 194.769)"],
  ["#ff00ff", "oklch(0.701674 0.322491 328.3634)"],
  ["#808080", "oklch(0.599871 0 0)"],
];

/**
 * 比の許容差の桁数(`toBeCloseTo` の第2引数)。**勘で決めていない** —— 記録 v20-m7-t02.md §3 に根拠:
 * 上の対応を書いた桁の半単位(L・C は 5e-7、H は 5e-5)だけ動かしたときの比の動きは最悪で 3.98e-5
 * (白地・黒地の両方で測った)。4桁(差 < 5e-5)はそれを覆い、3桁より厳しい。
 */
const V20_M7_RATIO_DIGITS = 4;

// 【V20-M7B-T02】describe の名前の「色域の外は null」は V20-M7 の時点の逐語のまま残す(中の2本は向きを変えた)。
describe("V20-M7-T02 oklch の読み手(自前の変換・色域の外は null)", () => {
  test.each(V20_M7_KNOWN_PAIRS)("%s と %s は白地・黒地・互いに同じ比を返す", (hex, oklch) => {
    for (const ground of ["#ffffff", "#000000", "#767676"]) {
      const byHex = contrastRatio(hex, ground);
      const byOklch = contrastRatio(oklch, ground);
      expect(byHex).not.toBeNull();
      expect(byOklch).not.toBeNull();
      expect(byOklch ?? Number.NaN).toBeCloseTo(byHex ?? Number.NaN, V20_M7_RATIO_DIGITS);
    }
    // 自分自身との比は 1(同じ色として読めている)。
    expect(contrastRatio(hex, oklch) ?? Number.NaN).toBeCloseTo(1, V20_M7_RATIO_DIGITS);
  });

  test("L の百分率と小数は同じ色を指す", () => {
    const decimal = contrastRatio("oklch(0.5 0.1 250)", "#fff");
    const percent = contrastRatio("oklch(50% 0.1 250)", "#fff");
    expect(decimal).not.toBeNull();
    expect(percent ?? Number.NaN).toBeCloseTo(decimal ?? Number.NaN, 10);
  });

  test("H の 0 と 360 は同じ色を指す", () => {
    const zero = contrastRatio("oklch(0.6 0.1 0)", "#fff");
    const full = contrastRatio("oklch(0.6 0.1 360)", "#fff");
    expect(zero).not.toBeNull();
    expect(full ?? Number.NaN).toBeCloseTo(zero ?? Number.NaN, 10);
  });

  /*
   * 【V20-M7B-T02 で向きを変えた(ADR-0472 限定4。消していない)】旧の名前と期待(逐語):
   * test("色域の境目: 許容差 0.5/255 の内側は読め、外側は null(丸め先を置かない)", …)
   *   expect(contrastRatio("oklch(0.452014 0.3134 264.052)", "#fff")).not.toBeNull();
   *   expect(contrastRatio("oklch(0.452014 0.3135 264.052)", "#fff")).toBeNull();
   * 許容差の役目は「外なら読まない」から「外なら広色域の画面の見え方も測る」に変わった。
   * 内側は通常の画面の経路(比は1つ)、外側は2つの画面の経路(比は2つ)であることを message で観測する。
   */
  test("色域の境目: 許容差 0.5/255 の内側は通常の画面の経路、外側は広色域の画面の経路にも入る(V20-M7B で向きを変えた)", () => {
    // 青の近く(L 0.452014 / H 264.052)で C を 0.0001 だけ変えた2色。
    // 緑のチャンネルが 0..1 の尺度で内側は -0.00169、外側は -0.00261(許容差は -0.00196)。
    expect(contrastRatio("oklch(0.452014 0.3134 264.052)", "#fff")).not.toBeNull();
    expect(contrastRatio("oklch(0.452014 0.3135 264.052)", "#fff")).not.toBeNull();
    const messageOn = (value: string) =>
      checkThemeContrast({ body_text: value, page_background: "#000" })[0]?.message;
    expect(messageOn("oklch(0.452014 0.3134 264.052)")).not.toContain("広色域の画面");
    expect(messageOn("oklch(0.452014 0.3135 264.052)")).toContain("広色域の画面");
  });

  test.each([
    "oklch(0.7 0.4 150)",
    "oklch(0.4 0.4 150)",
    "oklch(0.55 0.2 250)",
    "oklch(0.9 0.3 30)",
    "oklch(0.5 5 250)",
  ])(
    // 【V20-M7B-T02 で向きを変えた(ADR-0472。消していない)】旧の名前と期待(逐語):
    // "sRGB の色域の外 %s は null で、テーマは色として読めないとして拒否される"
    //   expect(contrastRatio(value, "#fff")).toBeNull();
    //   path は ["/app/theme/body_text"]、message に「色として読めません」、hint に「sRGB」。
    "sRGB の色域の外 %s も読め、テーマは『読めない』では拒否されない(V20-M7B で向きを変えた)",
    (value) => {
      const ratio = contrastRatio(value, "#fff");
      expect(ratio).not.toBeNull();
      expect(Number.isFinite(ratio)).toBe(true);
      const errors = checkThemeContrast({
        body_text: value,
        page_background: "#fff",
      });
      for (const error of errors) {
        expect(error.path).toBe("/app/theme/body_text");
        expect(error.message).not.toContain("色として読めません");
        expect(error.hint).not.toContain("sRGB");
      }
    },
  );

  test("カーネルの側でも範囲を確かめる(スキーマを通らない値を直接渡しても読まない)", () => {
    for (const value of [
      "oklch(1.5 0 0)",
      "oklch(101% 0 0)",
      "oklch(0.5 0.1 361)",
      "oklch(0.5 0.1 1000)",
      "oklch(1000% 0 0)",
    ]) {
      expect(contrastRatio(value, "#fff"), value).toBeNull();
    }
    // 対照: 範囲の端は読める。
    for (const value of ["oklch(1 0 0)", "oklch(100% 0 0)", "oklch(0 0 360)", "oklch(0% 0 0)"]) {
      expect(contrastRatio(value, "#000"), value).not.toBeNull();
    }
  });

  test("16進と oklch で同じ配色を書いたテーマは、同じ対で同じ件数落ちる", () => {
    const byHex = checkThemeContrast({
      body_text: "#808080",
      label_text: "#000000",
      page_background: "#ffffff",
      highlight_surface: "#808080",
    });
    const byOklch = checkThemeContrast({
      body_text: "oklch(0.599871 0 0)",
      label_text: "oklch(0 0 0)",
      page_background: "oklch(1 0 0)",
      highlight_surface: "oklch(0.599871 0 0)",
    });
    expect(byHex.length).toBeGreaterThan(0);
    expect(byOklch.map((e) => e.path)).toEqual(byHex.map((e) => e.path));
    // 比の表示(小数第2位)も一致する。
    const ratios = (errors: typeof byHex) =>
      errors.map((e) => /比は ([0-9.]+):1/.exec(e.message)?.[1]);
    expect(ratios(byOklch)).toEqual(ratios(byHex));
  });

  test("スキーマの description が例に挙げる oklch は色域の中である(従えば読める)", () => {
    const schema = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "..", "schemas", "manifest.schema.json"), "utf-8"),
    ) as { $defs: { theme: { properties: Record<string, { description?: string }> } } };
    const examples = new Set<string>();
    for (const property of Object.values(schema.$defs.theme.properties)) {
      for (const found of String(property.description ?? "").matchAll(/oklch\([0-9. %]+\)/g)) {
        examples.add(found[0]);
      }
    }
    expect(examples.size).toBeGreaterThan(0);
    for (const example of examples) {
      expect(contrastRatio(example, "#fff"), example).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// V20-M7 独立点検の指摘への処置(中1 / 中2 / 軽5)
// ---------------------------------------------------------------------------

/**
 * 暗い色の16進と oklch の対応(**中1**。符号化の直線部と分岐点のまわりを通る色)。
 *
 * 出典: 本段の担い手が python3 で**逆向き**(16進 → OKLab。Ottosson の順方向の行列と立方根)に計算し、
 * 小数6桁(H は4桁)に丸めた値。製品の変換(OKLCH → sRGB)とは向きも行列も別の式である。
 * **外部の実装とは突き合わせていない**(H-V20-79。メインの Chromium の突き合わせが別に在る)。
 * 無彩色は H を 0 と書いた(C = 0 なので H は色に効かない)。
 * `#050505` / `#0a0a0a` の各チャンネルは線形の値で 0.0031308 以下(符号化の直線部)を通り、
 * `#1a1a1a` / `#333333` / 有彩色4つは分岐点の上の暗い側(8ビットで 13〜60)を通る。
 * 8ビットで 10.0〜10.3(linearize の分岐点の非対称 H-V20-81)に入るチャンネルは1つも無い。
 */
const V20_M7_DARK_PAIRS: readonly (readonly [string, string])[] = [
  ["#050505", "oklch(0.114918 0 0)"],
  ["#0a0a0a", "oklch(0.144788 0 0)"],
  ["#1a1a1a", "oklch(0.217787 0 0)"],
  ["#333333", "oklch(0.321093 0 0)"],
  ["#1a2b3c", "oklch(0.28261 0.038826 249.3445)"],
  ["#300000", "oklch(0.194155 0.079672 29.2339)"],
  ["#002010", "oklch(0.214488 0.050231 157.9337)"],
  ["#0d0d26", "oklch(0.176113 0.05026 279.9184)"],
];

describe("V20-M7 点検の処置: 符号化の暗い側・切り詰め・L の範囲に見張りを置く", () => {
  test.each(V20_M7_DARK_PAIRS)("暗い色 %s と %s は白地・黒地で同じ比を返す", (hex, oklch) => {
    for (const ground of ["#ffffff", "#000000"]) {
      const byHex = contrastRatio(hex, ground);
      const byOklch = contrastRatio(oklch, ground);
      expect(byHex).not.toBeNull();
      expect(byOklch ?? Number.NaN).toBeCloseTo(byHex ?? Number.NaN, V20_M7_RATIO_DIGITS);
    }
  });

  test("黒地に oklch(0.34 0 0) の文字は読めない配色として拒否される(比 1.79:1)", () => {
    expect(contrastRatio("oklch(0.34 0 0)", "#000") ?? Number.NaN).toBeCloseTo(1.786, 3);
    const errors = checkThemeContrast({
      body_text: "oklch(0.34 0 0)",
      page_background: "oklch(0 0 0)",
      highlight_surface: "#000000",
    });
    expect(errors.map((e) => e.path)).toEqual(["/app/theme/body_text", "/app/theme/body_text"]);
    for (const error of errors) {
      expect(error.message).toContain("1.79:1");
    }
  });

  test("許容差の内側で 0..1 をわずかに越える色も、比は 1..21 の中に収まる([0,1] への切り詰め)", () => {
    // oklch(1 0.0001 0) は赤のチャンネルが 1.000256(許容差 0.00196 の内側)。切り詰めずに読むと
    // 白より明るい色になり、黒との比が 21 を超える。
    const bright = contrastRatio("oklch(1 0.0001 0)", "#000");
    expect(bright).not.toBeNull();
    expect(bright ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(21);
    expect(bright ?? 0).toBeCloseTo(21, 2);
    const alsoBright = contrastRatio("oklch(1 0.0003 200)", "#000");
    expect(alsoBright ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(21);
  });

  test("L が 1 をわずかに越える値は、色域の許容差の内側でも読まない(L の範囲の確かめ)", () => {
    // oklch(1.0001 0 0) の各チャンネルは 1.000132 で許容差の内側。L の範囲の確かめだけが null にする。
    expect(contrastRatio("oklch(1.0001 0 0)", "#000")).toBeNull();
    expect(contrastRatio("oklch(100.01% 0 0)", "#000")).toBeNull();
    // 対照: L = 1 ちょうどは読める。
    expect(contrastRatio("oklch(1 0 0)", "#000")).not.toBeNull();
  });
});

/** 文面の `(例: A / B)` から例を取り出す(例の中の丸括弧を1段だけ許す)。 */
function examplesOf(text: string): string[] {
  const matched = /\(例: ((?:[^()]|\([^()]*\))+)\)/.exec(text);
  return matched?.[1] === undefined ? [] : matched[1].split(" / ");
}

describe("V20-M7 点検の処置: checkThemeContrast の hint の例は既定の読み手で読める(中2)", () => {
  test("読めない色の hint が挙げる例は、2表記とも色として読める(従えば読める)", () => {
    const [error] = checkThemeContrast({
      body_text: "red",
      page_background: "#fff",
    });
    const examples = examplesOf(String(error?.hint));
    expect(examples.some((example) => example.startsWith("#"))).toBe(true);
    expect(examples.some((example) => example.startsWith("oklch("))).toBe(true);
    for (const example of examples) {
      expect(contrastRatio(example, "#ffffff"), example).not.toBeNull();
    }
  });
});

// ===========================================================================
// V20-M7B よく使われる配色を断らない(ADR-0472。計画 09b-v20-m7b-plan.md §3 / §5)
//
// **色域の外の oklch を受け、コントラストを通常の画面(sRGB に切り詰めた色)と広色域の画面
// (display-p3)の両方で測り、小さいほうで判定する。** 色相(H)の位置にだけ `none` を書ける。
// 16進と、V20-M7 で受けていた oklch の比・判定・message は1ビットも変えない。
// ===========================================================================

/**
 * 検査の入力(値の一覧だけ)。出典のコミットと MIT の旨は fixture の `$comment` に在る。
 * `out_of_gamut` の比は**製品の実装と独立に**メインが計算した値(小数3桁)。
 * `v20_m7_baseline` の比は**土台(0b7b2c45)の実装が返した値**で、1ビットも変わらないことを固定する。
 */
const V20_M7B_PALETTES = JSON.parse(
  readFileSync(join(import.meta.dir, "__fixtures__", "oklch-palettes.json"), "utf-8"),
) as {
  tailwind: { name: string; value: string }[];
  shadcn: { block: string; name: string; value: string }[];
  out_of_gamut: {
    source: string;
    name: string;
    value: string;
    srgb_on_white: number;
    p3_on_white: number;
    srgb_on_black: number;
    p3_on_black: number;
  }[];
  v20_m7_baseline: { value: string; on_white: number; on_black: number }[];
};

/** shadcn/ui の透明度付き3件(今日どおり断る。ADR-0472 越えてはならない線「透明度を受ける」)。 */
const V20_M7B_ALPHA_VALUES = ["oklch(1 0 0 / 10%)", "oklch(1 0 0 / 15%)", "oklch(1 0 0 / 10%)"];

describe("V20-M7B-T01 前提: fixture は計画 §5 の 9 の一覧そのものである", () => {
  test("Tailwind 286件 / shadcn 65件 / 色域の外84件(Tailwind 82 + shadcn 2)", () => {
    expect(V20_M7B_PALETTES.tailwind).toHaveLength(286);
    expect(V20_M7B_PALETTES.shadcn).toHaveLength(65);
    expect(V20_M7B_PALETTES.out_of_gamut).toHaveLength(84);
    expect(V20_M7B_PALETTES.out_of_gamut.filter((row) => row.source === "tailwind")).toHaveLength(
      82,
    );
    expect(
      V20_M7B_PALETTES.shadcn
        .map((row) => row.value)
        .filter((value) => value.includes("/"))
        .sort(),
    ).toEqual([...V20_M7B_ALPHA_VALUES].sort());
  });
});

describe("V20-M7B-T01 完了条件1: Tailwind v4 と shadcn/ui の oklch は、透明度付きの3件を除いて全部読める", () => {
  test("Tailwind の286件はすべて有限の比を返す(null も NaN も無い)", () => {
    const unreadable = V20_M7B_PALETTES.tailwind.filter(({ value }) => {
      const ratio = contrastRatio(value, "#ffffff");
      return ratio === null || !Number.isFinite(ratio);
    });
    expect(unreadable.map((row) => `${row.name} ${row.value}`)).toEqual([]);
  });

  test("shadcn の65件のうち読めないのは透明度付きの3件だけ", () => {
    const unreadable = V20_M7B_PALETTES.shadcn
      .filter(({ value }) => {
        const ratio = contrastRatio(value, "#ffffff");
        return ratio === null || !Number.isFinite(ratio);
      })
      .map((row) => row.value);
    expect(unreadable.sort()).toEqual([...V20_M7B_ALPHA_VALUES].sort());
  });
});

/**
 * 16進どうしの比(**土台 0b7b2c45 の実装が返した値を `toBe` で焼いた**。計画 §5 の 9)。
 * 16進は広色域の見え方を計算せず、通常の画面の見え方の値をそのまま使う(ADR-0472 限定7)。
 */
const V20_M7B_HEX_BASELINE: readonly (readonly [string, string, number])[] = [
  ["#767676", "#ffffff", 4.542224959605253],
  ["#333", "#fff", 12.63465434445799],
  ["#0000ff", "#ffff00", 8.00163666121113],
  ["#000", "#fff", 21],
  ["#666", "#f2f2f2", 5.128953500051328],
  ["#a00", "#fff", 7.751338479421059],
  ["#005fcc", "#f2f2f2", 5.346103363660201],
  ["#ddd", "#fff", 1.3582472461753565],
  ["#777777", "#ffffff", 4.478089453577214],
  ["#f5f5f5", "#102030", 15.15120056023875],
  ["#8fa3b8", "#243447", 4.8871347828141145],
  ["#ff9a8a", "#102030", 8.055614118838477],
  ["#7fd4ff", "#243447", 7.702042209123051],
  ["#1a4f9c", "#ffffff", 7.947394883814189],
  ["#0a0a0a", "#0b0b0b", 1.0058690363860938],
  ["#808080", "#000000", 5.317210002277984],
  ["#fe0000", "#00ff01", 2.9351650771688607],
  ["#A0b1C2", "#123", 7.353295444109782],
];

describe("V20-M7B-T01 完了条件2: 16進の比と message は土台から1ビットも変わらない(緑のまま固定する)", () => {
  test.each(V20_M7B_HEX_BASELINE)("%s と %s の比は土台の値そのもの", (a, b, ratio) => {
    expect(contrastRatio(a, b)).toBe(ratio);
    expect(contrastRatio(b, a)).toBe(ratio);
  });

  test("16進のテーマの拒否の message は土台の逐語のまま(hint は色として読めない旨の1件だけ見ない)", () => {
    const errors = checkThemeContrast({
      body_text: "#777777",
      label_text: "#8a8a8a",
      border_color: "#ddd",
      page_background: "#ffffff",
      highlight_surface: "#f2f2f2",
      focus_ring: "#77777",
    });
    // 【V20-M8 / ADR-0473】比と message の文面は1ビットも変えていない。名前が役割名になり、組を名前順に作るので、
    // 同じ前景の2組の並び(旧: page_background の組が先)が highlight_surface の組が先に変わった。
    expect(errors.map((e) => [e.path, e.message])).toEqual([
      [
        "/app/theme/focus_ring",
        "テーマのスロット focus_ring の値が色として読めません。コントラスト比を計算できないため、この差分は適用できません。",
      ],
      [
        "/app/theme/body_text",
        "前景 body_text(#777777)と背景 highlight_surface(#f2f2f2)のコントラスト比は 4.00:1 で、本文テキストの閾値 4.5:1 を下回ります。",
      ],
      [
        "/app/theme/body_text",
        "前景 body_text(#777777)と背景 page_background(#ffffff)のコントラスト比は 4.48:1 で、本文テキストの閾値 4.5:1 を下回ります。",
      ],
      [
        "/app/theme/label_text",
        "前景 label_text(#8a8a8a)と背景 highlight_surface(#f2f2f2)のコントラスト比は 3.08:1 で、本文テキストの閾値 4.5:1 を下回ります。",
      ],
      [
        "/app/theme/label_text",
        "前景 label_text(#8a8a8a)と背景 page_background(#ffffff)のコントラスト比は 3.45:1 で、本文テキストの閾値 4.5:1 を下回ります。",
      ],
      [
        "/app/theme/border_color",
        "前景 border_color(#ddd)と背景 highlight_surface(#f2f2f2)のコントラスト比は 1.21:1 で、非テキスト(枠線・フォーカスリングなど)の閾値 3:1 を下回ります。",
      ],
      [
        "/app/theme/border_color",
        "前景 border_color(#ddd)と背景 page_background(#ffffff)のコントラスト比は 1.36:1 で、非テキスト(枠線・フォーカスリングなど)の閾値 3:1 を下回ります。",
      ],
    ]);
    // 比の拒否の hint は1バイトも変えない(16進にも oklch にも同じ文面)。
    expect(errors[1]?.hint).toBe(
      "どちらかの色を変えて比を 4.5:1 以上にしてください。閾値は本文テキスト 4.5:1 と非テキスト 3:1 の2つだけです。",
    );
  });
});

/**
 * oklch から導いた比を土台の値と比べる許容差(相対 1e-12)。
 * **実 CI の赤(run 36054889044)の処置。** oklch の経路は Math.cbrt / Math.cos / Math.sin / Math.pow を通り、
 * 超越関数の最後の1ulp は台(OS・libm)で違ってよい。実測: `oklch(0.452014 0.3134 264.052)` と白の比は
 * macOS で 8.592307790599184、実 CI の Linux x86_64 で 8.592307790599182(差 2e-15 = 相対 2.3e-16)。
 * そのため土台の値との比較は相対 1e-12 の内側を「変わらない」と読む(1ulp の数千倍、実装の写し違いが動かす
 * 1e-9 以上の量より何桁も小さい)。同じ台の上での一致(16進と oklch、none と 0 など、同じ台で2回計算した値の
 * 比較)はこれまでどおり `toBe` で見る。message(小数2桁に丸めた比)の比較は逐語のまま。
 * 16進の経路(整数 / 255 と Math.pow だけ)の土台値 `V20_M7B_HEX_BASELINE` は実 CI でも `toBe` で緑だったので
 * 変えていない(穴 H-V20-93)。
 */
const V20_M7B_OKLCH_RELATIVE_TOLERANCE = 1e-12;

function sameAsBaseline(actual: number | null, baseline: number): boolean {
  return (
    actual !== null &&
    Math.abs(actual - baseline) <= V20_M7B_OKLCH_RELATIVE_TOLERANCE * Math.abs(baseline)
  );
}

describe("V20-M7B-T01 完了条件9: V20-M7 で受けていた oklch の比・判定・message は1ビットも変わらない(緑のまま固定する)", () => {
  test("土台で読めた Tailwind / shadcn の oklch(重複を除いて212件)の白地・黒地の比は土台の値そのもの", () => {
    expect(V20_M7B_PALETTES.v20_m7_baseline).toHaveLength(212);
    const moved = V20_M7B_PALETTES.v20_m7_baseline.filter(
      ({ value, on_white, on_black }) =>
        // 土台の値(macOS で焼いた)との比較は相対 1e-12(台ごとの最後の1ulp を許す。上の注記)。
        !sameAsBaseline(contrastRatio(value, "#ffffff"), on_white) ||
        !sameAsBaseline(contrastRatio(value, "#000000"), on_black),
    );
    expect(moved.map((row) => row.value)).toEqual([]);
  });

  test("許容差の内側の境目の色と、許容差の内側の赤の比は土台の値そのもの(ADR-0472 式16 と同じ3色)", () => {
    // 土台の値は macOS で焼いた。実 CI の Linux x86_64 では2つ目が 8.592307790599182(最後の1ulp)で、
    // `toBe` のままだと赤くなった(run 36054889044)。相対 1e-12 の内側を「変わらない」と読む(上の注記)。
    const pinned: readonly (readonly [string, number])[] = [
      ["oklch(0.55 0.15 250)", 4.854602383159733],
      ["oklch(0.452014 0.3134 264.052)", 8.592307790599184],
      ["oklch(0.637 0.237 25.331)", 3.8198965927199984],
    ];
    for (const [value, baseline] of pinned) {
      const ratio = contrastRatio(value, "#ffffff");
      expect(sameAsBaseline(ratio, baseline), `${value} ${ratio} vs ${baseline}`).toBe(true);
    }
  });

  test("許容差の内側の oklch のテーマの拒否の message は土台の逐語のまま(比は1つだけ書く)", () => {
    const errors = checkThemeContrast({
      body_text: "oklch(0.637 0.237 25.331)",
      border_color: "oklch(0.452014 0.3134 264.052)",
      page_background: "#ffffff",
      highlight_surface: "oklch(0.3 0.05 250)",
    });
    // 【V20-M8 / ADR-0473】文面と比は土台の逐語のまま。組を役割名の名前順に作るので、1件目と2件目の並びだけが入れ替わった。
    expect(errors.map((e) => e.message)).toEqual([
      "前景 body_text(oklch(0.637 0.237 25.331))と背景 highlight_surface(oklch(0.3 0.05 250))のコントラスト比は 3.56:1 で、本文テキストの閾値 4.5:1 を下回ります。",
      "前景 body_text(oklch(0.637 0.237 25.331))と背景 page_background(#ffffff)のコントラスト比は 3.82:1 で、本文テキストの閾値 4.5:1 を下回ります。",
      "前景 border_color(oklch(0.452014 0.3134 264.052))と背景 highlight_surface(oklch(0.3 0.05 250))のコントラスト比は 1.58:1 で、非テキスト(枠線・フォーカスリングなど)の閾値 3:1 を下回ります。",
    ]);
  });

  test("許容差の内側の境目の色(C 0.3134)は通常の画面の経路に留まる: 落ちたときの message に比は1つだけ", () => {
    const [error] = checkThemeContrast({
      body_text: "oklch(0.452014 0.3134 264.052)",
      page_background: "#000000",
    });
    expect(error?.message).toContain("のコントラスト比は 2.44:1 で、");
    expect(error?.message).not.toContain("広色域の画面");
  });
});

/** 2つの画面の比が書かれた message の形(ADR-0472 R-2 軽4 の裁定)。 */
function twoScreenRatios(message: string | undefined): [string, string] | null {
  const matched = /通常の画面では ([0-9.]+):1、広色域の画面では ([0-9.]+):1 で、/.exec(
    String(message),
  );
  return matched === null ? null : [String(matched[1]), String(matched[2])];
}

describe("V20-M7B-T01 完了条件3: 2つの画面の見え方の小さいほうで判定し、両方の比を案内する", () => {
  test.each([
    ["fuchsia-600", "oklch(59.1% 0.293 322.896)", "4.51", "4.34"],
    ["pink-600", "oklch(59.2% 0.249 0.584)", "4.62", "4.50"],
    ["rose-600", "oklch(58.6% 0.253 17.585)", "4.66", "4.40"],
  ])(
    "黒地の本文に %s(%s)を置くと、通常の画面では通るが広色域の画面で落ち、エラーはちょうど1件",
    (_name, value, srgb, p3) => {
      const errors = checkThemeContrast({
        body_text: value,
        page_background: "#000000",
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]?.path).toBe("/app/theme/body_text");
      expect(errors[0]?.message).toContain("通常の画面");
      expect(errors[0]?.message).toContain("広色域の画面");
      expect(twoScreenRatios(errors[0]?.message)).toEqual([srgb, p3]);
      expect(errors[0]?.message).toContain("本文テキストの閾値 4.5:1 を下回ります。");
      // 通常の画面の比(公開の contrastRatio)は閾値を越えている —— 落としたのは広色域の画面の比である。
      expect(contrastRatio(value, "#000000") ?? 0).toBeGreaterThan(4.5);
    },
  );

  test("色域の外の84件: 通常の画面の比は独立の計算と小数2桁で一致する", () => {
    const off = V20_M7B_PALETTES.out_of_gamut.filter((row) => {
      const white = contrastRatio(row.value, "#ffffff");
      const black = contrastRatio(row.value, "#000000");
      return (
        white === null ||
        black === null ||
        Math.abs(white - row.srgb_on_white) > 0.0006 ||
        Math.abs(black - row.srgb_on_black) > 0.0006
      );
    });
    expect(off.map((row) => row.name)).toEqual([]);
  });

  /** 84件 × 白地 / 黒地 × 本文 4.5 / 非テキスト 3 の合否(期待は独立の計算の小さいほうから焼く)。 */
  const cases = V20_M7B_PALETTES.out_of_gamut.flatMap((row) =>
    (
      [
        ["#ffffff", Math.min(row.srgb_on_white, row.p3_on_white)],
        ["#000000", Math.min(row.srgb_on_black, row.p3_on_black)],
      ] as const
    ).flatMap(([ground, ratio]) =>
      (
        [
          ["body_text", 4.5],
          ["border_color", 3],
        ] as const
      ).map(([slot, threshold]) => ({ row, ground, slot, pass: ratio >= threshold })),
    ),
  );

  test("色域の外の84件の合否(336通り)は、2つの画面の小さいほうの比で決まる", () => {
    expect(cases).toHaveLength(336);
    const wrong = cases.filter(({ row, ground, slot, pass }) => {
      const errors = checkThemeContrast({ [slot]: row.value, page_background: ground });
      return errors.length !== (pass ? 0 : 1);
    });
    expect(wrong.map((c) => `${c.row.name} ${c.slot} on ${c.ground}`)).toEqual([]);
  });

  test("合否の内訳は独立の計算の数と同じ(白地 4.5 は 32 / 白地 3 は 45 / 黒地 4.5 は 53 / 黒地 3 は 72)", () => {
    const passed = (ground: string, slot: string) =>
      cases.filter((c) => c.ground === ground && c.slot === slot && c.pass).length;
    expect([
      passed("#ffffff", "body_text"),
      passed("#ffffff", "border_color"),
      passed("#000000", "body_text"),
      passed("#000000", "border_color"),
    ]).toEqual([32, 45, 53, 72]);
    const accepted = (ground: string, slot: string) =>
      cases.filter(
        (c) =>
          c.ground === ground &&
          c.slot === slot &&
          checkThemeContrast({ [slot]: c.row.value, page_background: ground }).length === 0,
      ).length;
    expect([
      accepted("#ffffff", "body_text"),
      accepted("#ffffff", "border_color"),
      accepted("#000000", "body_text"),
      accepted("#000000", "border_color"),
    ]).toEqual([32, 45, 53, 72]);
  });

  test("2つの比が違って落ちた組は、message に2つの比を書く(色域の外の84件で黒地の本文)", () => {
    for (const row of V20_M7B_PALETTES.out_of_gamut) {
      const errors = checkThemeContrast({
        body_text: row.value,
        page_background: "#000000",
      });
      for (const error of errors) {
        expect(twoScreenRatios(error.message), row.name).not.toBeNull();
      }
    }
  });

  test("許容差の外の境目の色(C 0.3135)は広色域の画面の経路に入る: 落ちたときの message に2つの比", () => {
    const [error] = checkThemeContrast({
      body_text: "oklch(0.452014 0.3135 264.052)",
      page_background: "#000000",
    });
    expect(error?.message).toContain("広色域の画面");
    expect(twoScreenRatios(error?.message)).not.toBeNull();
  });
});

describe("V20-M7B-T01 完了条件4: 色相(H)の位置にだけ none を書ける(0 として読む)", () => {
  test("oklch(98.5% 0 none) は読め、oklch(98.5% 0 0) と同じ比", () => {
    const none = contrastRatio("oklch(98.5% 0 none)", "#000000");
    expect(none).not.toBeNull();
    expect(none).toBe(contrastRatio("oklch(98.5% 0 0)", "#000000"));
  });

  test("彩度のある色でも none は 0 と読む(oklch(0.5 0.1 none) は 0 と同じ比で、90 とは違う)", () => {
    const none = contrastRatio("oklch(0.5 0.1 none)", "#000000");
    const zero = contrastRatio("oklch(0.5 0.1 0)", "#000000");
    const ninety = contrastRatio("oklch(0.5 0.1 90)", "#000000");
    expect(none).not.toBeNull();
    expect(none).toBe(zero);
    expect(none).not.toBe(ninety);
  });

  test("Tailwind の無彩色13件(H が none)はすべて読め、H を 0 と書いた色と同じ比", () => {
    const withNone = V20_M7B_PALETTES.tailwind.filter((row) => row.value.endsWith(" none)"));
    expect(withNone).toHaveLength(13);
    for (const { name, value } of withNone) {
      const ratio = contrastRatio(value, "#ffffff");
      expect(ratio, name).not.toBeNull();
      expect(ratio, name).toBe(contrastRatio(value.replace(" none)", " 0)"), "#ffffff"));
    }
  });

  test.each([
    "oklch(none 0.1 0)",
    "oklch(0.5 none 0)",
    "oklch(none none none)",
    "oklch(0.5 0.1 NONE)",
    "oklch(0.5 0.1 None)",
    "oklch(0.5 0.1 none / 0.5)",
    "oklch(0.5 0.1 nonedeg)",
    "oklch(0.5 0.1 250deg)",
    "OKLCH(0.5 0.1 none)",
  ])("%s は今日どおり読めない(L と C の none・大文字・透明度・単位)", (value) => {
    expect(contrastRatio(value, "#ffffff")).toBeNull();
  });
});

describe("V20-M7B-T01 切り詰めてから線形に戻す(負のチャンネルで NaN を出さない)", () => {
  test.each([
    "oklch(0.7 0.4 150)",
    "oklch(0.4 0.4 150)",
    "oklch(0.55 0.2 250)",
    "oklch(0.9 0.3 30)",
    "oklch(0.5 5 250)",
    "oklch(0 5 30)",
    "oklch(1 5 150)",
    "oklch(0.5 999.999999 250)",
    "oklch(57.7% 0.245 27.325)",
  ])("色域の外 %s の比は 1..21 の有限の数で、テーマの message に NaN が出ない", (value) => {
    for (const ground of ["#ffffff", "#000000", "oklch(0.5 0.3 150)"]) {
      const ratio = contrastRatio(value, ground);
      expect(ratio, ground).not.toBeNull();
      expect(Number.isFinite(ratio), ground).toBe(true);
      expect(ratio ?? 0, ground).toBeGreaterThanOrEqual(1);
      expect(ratio ?? 99, ground).toBeLessThanOrEqual(21);
    }
    for (const ground of ["#ffffff", "#000000"]) {
      const errors = checkThemeContrast({
        body_text: value,
        border_color: value,
        page_background: ground,
      });
      for (const error of errors) {
        expect(error.message).not.toContain("NaN");
        expect(error.message).not.toContain("Infinity");
        expect(error.message).not.toContain("色として読めません");
      }
    }
  });

  test("赤のチャンネルが負になる red-600 の通常の画面の比は、負を 0 に切り詰めた色の比と同じ", () => {
    // red-600 の緑のチャンネルは符号化した値で -0.0959。0 に切り詰めた 16進に近い色 #e7000b と比べる。
    const ratio = contrastRatio("oklch(57.7% 0.245 27.325)", "#ffffff");
    expect(ratio ?? Number.NaN).toBeCloseTo(4.765, 2);
  });
});

describe("V20-M7B-T01 読めない色の hint から『sRGB で表せない色は読めません』を外す", () => {
  test("読めない色の hint は sRGB の色域のことを言わない", () => {
    const [error] = checkThemeContrast({
      body_text: "red",
      page_background: "#fff",
    });
    expect(error?.message).toContain("色として読めません");
    expect(error?.hint).not.toContain("sRGB");
    expect(error?.hint).toContain("oklch(L C H)");
  });
});

// ===========================================================================
// V20-M7B 点検の処置(scratchpad の m7b-audit/AUDIT.md 中1 / 軽1)
// ===========================================================================

/**
 * message に書かれた `X:1` の X をすべて数にする(閾値の `4.5:1` / `3:1` も含む)。
 * 符号・NaN・Infinity も拾う(`twoScreenRatios` は `[0-9.]+` しか見ないので、負の比を素通りさせる)。
 */
function allRatiosInMessage(message: string): number[] {
  return [...message.matchAll(/(-?(?:[0-9.]+|NaN|Infinity)):1/g)].map((m) => Number(m[1]));
}

/** 色域の外の色の極端な例(C が大きい・L が 0 / 1)と、点検で見た色。 */
const V20_M7B_AUDIT_EXTREMES = [
  "oklch(0.5 5 250)",
  "oklch(0 5 30)",
  "oklch(1 5 150)",
  "oklch(0.5 999.999999 250)",
  "oklch(0.3 0.4 30)",
  "oklch(0.7 0.4 150)",
  "oklch(0.9 0.3 30)",
  "oklch(0.05 0.5 11)",
  "oklch(0.95 0.5 239)",
];

describe("V20-M7B 点検の処置 中1: 広色域の画面の比は、display-p3 の外の色でも 1..21 に入る", () => {
  test("極端な色と色域の外の84件: 白地 / 黒地 × 本文 / 非テキストの、どの message の比も 1 以上 21 以下", () => {
    const values = [
      ...V20_M7B_AUDIT_EXTREMES,
      ...V20_M7B_PALETTES.out_of_gamut.map((row) => row.value),
    ];
    const outOfRange: string[] = [];
    let twoRatioMessages = 0;
    for (const value of values) {
      for (const ground of ["#ffffff", "#000000"]) {
        const errors = checkThemeContrast({
          body_text: value,
          border_color: value,
          page_background: ground,
        });
        for (const error of errors) {
          const ratios = allRatiosInMessage(error.message);
          expect(ratios.length, error.message).toBeGreaterThanOrEqual(2);
          if (twoScreenRatios(error.message) !== null) {
            twoRatioMessages += 1;
          }
          for (const ratio of ratios) {
            if (!(ratio >= 1 && ratio <= 21)) {
              outOfRange.push(`${value} on ${ground}: ${error.message}`);
            }
          }
        }
      }
    }
    expect(outOfRange).toEqual([]);
    // 2つの比を書いた message を実際に見ている(0件で緑になる恒真式にしない)。
    expect(twoRatioMessages).toBeGreaterThan(50);
  });

  test.each([
    // 期待値は製品のコードを通らない独立の計算(CSS Color 4 の OKLab_to_XYZ から出発する python3。
    // scratchpad の m7b-fix/indep.py)。点検(AUDIT.md 中1)の値と同じ。
    ["oklch(0.5 5 250)", "#ffffff", "3.14", "2.93"],
    ["oklch(0.3 0.4 30)", "#000000", "2.70", "2.43"],
  ])(
    "%s を %s に置いた本文の message は、独立に計算した2つの比(%s / %s)を書く",
    (value, ground, srgb, p3) => {
      const errors = checkThemeContrast({
        body_text: value,
        page_background: ground,
      });
      expect(errors).toHaveLength(1);
      expect(twoScreenRatios(errors[0]?.message)).toEqual([srgb, p3]);
    },
  );
});

/**
 * 広色域の画面の見え方の相対輝度を、公開の判定(`checkThemeContrast` のエラーの有無)だけから取り出す。
 *
 * 背景に無彩色 `oklch(L 0 0)` を置く(許容差の内側なので2つの見え方の輝度は等しく、その輝度 g は
 * 公開の `contrastRatio(灰, 黒)` から `(比 × 0.05) − 0.05` で正確に読める)。前景に色を置き、非テキスト(3:1)の
 * 組で L を二分して、広色域の画面の比がちょうど 3 になる g を探す。
 * - `darker`(灰が色より暗い): 比 = (Yp + 0.05) / (g + 0.05) → Yp = 3 (g + 0.05) − 0.05
 * - `lighter`(灰が色より明るい): 比 = (g + 0.05) / (Yp + 0.05) → Yp = (g + 0.05) / 3 − 0.05
 * どちらも、通常の画面の比のほうが大きい(= 判定を決めるのが広色域の画面の比である)側を選んである。
 */
function wideGamutLuminanceByBisection(
  value: string,
  side: "darker" | "lighter",
  bracket: readonly [number, number],
): number {
  const grayLuminance = (lightness: string): number =>
    (contrastRatio(`oklch(${lightness} 0 0)`, "#000000") ?? Number.NaN) * 0.05 - 0.05;
  const fails = (lightness: string): boolean =>
    checkThemeContrast({
      border_color: value,
      page_background: `oklch(${lightness} 0 0)`,
    }).length > 0;
  let [lo, hi] = bracket;
  const text = (lightness: number): string => lightness.toFixed(20);
  // 前提: 区間の両端で判定が逆になる(darker は暗い端が通り明るい端で落ちる。lighter はその逆)。
  expect(fails(text(lo)), `${value} lo`).toBe(side === "lighter");
  expect(fails(text(hi)), `${value} hi`).toBe(side === "darker");
  for (let step = 0; step < 64; step += 1) {
    const mid = (lo + hi) / 2;
    if (fails(text(mid)) === (side === "darker")) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  const g = grayLuminance(text(side === "darker" ? lo : hi));
  return side === "darker" ? 3 * (g + 0.05) - 0.05 : (g + 0.05) / 3 - 0.05;
}

describe("V20-M7B 点検の処置 軽1: 広色域の画面の輝度を、独立の計算と 1e-7 の精度で固定する", () => {
  /**
   * [色, 灰の側, 独立に計算した広色域の画面の輝度, 二分の区間(灰の L)]。
   * 輝度は製品のコードを通らない python3(scratchpad の m7b-fix/indep.py: CSS Color 4 の OKLab_to_XYZ →
   * XYZ_to_lin_P3 → [0, 1] に切り詰め → lin_P3_to_XYZ の2行目)。製品との差は点検の実測で最大 6.8e-9。
   * - 上の3色は、符号化した sRGB のチャンネルの1つが 0.03928〜0.04045 に入る(P3 の経路の逆ガンマの分岐点の
   *   写し違いで輝度が 4.3e-7〜5.3e-7 動く色)。
   * - 下の2色は、XYZ → P3 の [2][2] の写し違い(316169 → 316449)で輝度が 1.3e-5〜4.9e-5 動く色(上の oklch(0.53 0.3 292) も 6.7e-5 動く)。
   */
  const pinned: readonly (readonly [
    string,
    "darker" | "lighter",
    number,
    readonly [number, number],
  ])[] = [
    ["oklch(0.55 0.35 74)", "darker", 0.1491558803008402, [0.244, 0.264]],
    ["oklch(0.53 0.3 292)", "lighter", 0.1169254782021675, [0.7567, 0.7767]],
    ["oklch(0.66 0.4 279)", "lighter", 0.12577479815886985, [0.7715, 0.7915]],
    ["oklch(0.55 0.2 250)", "darker", 0.16403509469521219, [0.2674, 0.2874]],
    ["oklch(59.2% 0.249 0.584)", "darker", 0.17477150198239683, [0.2821, 0.3021]],
  ];

  test.each(pinned)(
    "%s の広色域の画面の輝度(灰は %s 側)は独立の計算 %d と 1e-7 以内",
    (value, side, expected, bracket) => {
      const recovered = wideGamutLuminanceByBisection(value, side, bracket);
      expect(Math.abs(recovered - expected)).toBeLessThan(1e-7);
    },
  );
});

// ===========================================================================
// V20-M9-T01: 役割表の面(`surface` / `surfaces`)と組の分け方(ADR-0474 §Decision 1-8)
// ===========================================================================

describe("V20-M9-T01 面ごとの組(ADR-0474 §1-8 / 式P12・式P13・式P14)", () => {
  /** 23組の並び(式P13 の文字列そのもの)。 */
  const PAIRS_23 =
    "body_text>highlight_surface>text,body_text>overlay_background>text,body_text>page_background>text," +
    "danger>highlight_surface>text,danger>overlay_background>text,danger>page_background>text," +
    "label_text>highlight_surface>text,label_text>overlay_background>text,label_text>page_background>text," +
    "on_primary>primary_fill>text,overlay_text>overlay_background>text," +
    "placeholder_text>highlight_surface>text,placeholder_text>overlay_background>text,placeholder_text>page_background>text," +
    "secondary_text>highlight_surface>text,secondary_text>overlay_background>text,secondary_text>page_background>text," +
    "border_color>highlight_surface>non-text,border_color>overlay_background>non-text,border_color>page_background>non-text," +
    "focus_ring>highlight_surface>non-text,focus_ring>overlay_background>non-text,focus_ring>page_background>non-text";

  test("組は23で、並びは式P13 の文字列と一致する", () => {
    const joined = THEME_CONTRAST_PAIRS.map(
      (p) => `${p.foreground}>${p.background}>${p.target}`,
    ).join(",");
    expect(THEME_CONTRAST_PAIRS).toHaveLength(23);
    expect(joined).toBe(PAIRS_23);
  });

  test("今日の14組(前景7 × page_background / highlight_surface)は1組も減っていない", () => {
    const foregrounds = [
      "body_text",
      "danger",
      "label_text",
      "placeholder_text",
      "secondary_text",
      "border_color",
      "focus_ring",
    ];
    for (const foreground of foregrounds) {
      for (const background of ["page_background", "highlight_surface"]) {
        expect(
          THEME_CONTRAST_PAIRS.some(
            (p) => p.foreground === foreground && p.background === background,
          ),
          `${foreground} × ${background}`,
        ).toBe(true);
      }
    }
  });

  test("測らない組(主ボタンの枠線と輪 / primary_fill × page_background / overlay_text × highlight_surface)", () => {
    const has = (foreground: string, background: string) =>
      THEME_CONTRAST_PAIRS.some((p) => p.foreground === foreground && p.background === background);
    expect(has("border_color", "primary_fill")).toBe(false);
    expect(has("focus_ring", "primary_fill")).toBe(false);
    expect(has("primary_fill", "page_background")).toBe(false);
    expect(has("overlay_text", "highlight_surface")).toBe(false);
  });

  test("役割表の属性は閉じた集合で、背景は surface、前景は surfaces を持つ(式P12)", () => {
    const allowedKeys = new Set(["kind", "target", "surface", "surfaces"]);
    const surfaces = new Set(["page", "overlay", "primary"]);
    for (const [name, role] of Object.entries(THEME_SLOT_ROLES)) {
      for (const key of Object.keys(role)) {
        expect(allowedKeys.has(key), `${name}.${key}`).toBe(true);
      }
      if (role.kind === "background") {
        expect(surfaces.has(role.surface), name).toBe(true);
      }
      if (role.kind === "foreground") {
        expect(role.surfaces.length, name).toBeGreaterThan(0);
        for (const surface of role.surfaces) {
          expect(surfaces.has(surface), `${name}: ${surface}`).toBe(true);
        }
      }
    }
    expect(THEME_SLOT_ROLES.primary_fill).toEqual({ kind: "background", surface: "primary" });
    expect(THEME_SLOT_ROLES.on_primary).toEqual({
      kind: "foreground",
      target: "text",
      surfaces: ["primary"],
    });
    expect(THEME_SLOT_ROLES.overlay_background).toEqual({ kind: "background", surface: "overlay" });
    expect(THEME_SLOT_ROLES.overlay_text).toEqual({
      kind: "foreground",
      target: "text",
      surfaces: ["overlay"],
    });
  });

  test("既定値(styles.css の :root を写像で役割名へ引き戻したもの)で落ちる組は border_color の組だけ(式P14)", () => {
    const root = join(import.meta.dir, "..", "..");
    const map = readFileSync(join(root, "web", "src", "theme-role-map.ts"), "utf-8");
    const head =
      "export const THEME_ROLE_TO_CSS_PROPERTY: Readonly<Record<string, string>> = Object.freeze({";
    const start = map.indexOf(head);
    expect(start).toBeGreaterThanOrEqual(0);
    const band = map.slice(start + head.length, map.indexOf("});", start));
    const css = readFileSync(join(root, "web", "src", "styles.css"), "utf-8");
    const rootStart = css.indexOf("\n:root {");
    const block = css.slice(rootStart, css.indexOf("\n}", rootStart));
    const values = new Map<string, string>();
    for (const match of block.matchAll(/^ {2}(--[a-z0-9-]+): ([^;]+);/gm)) {
      values.set(match[1] as string, match[2] as string);
    }
    const slots: Record<string, string> = {};
    for (const match of band.matchAll(/^ {2}"?([a-z0-9_-]+)"?: "(--[a-z0-9-]+)",/gm)) {
      const value = values.get(match[2] as string);
      if (value !== undefined) {
        slots[match[1] as string] = value;
      }
    }
    expect(Object.keys(slots)).toHaveLength(27);
    const errors = checkThemeContrast(slots);
    const borderPairs = THEME_CONTRAST_PAIRS.filter((p) => p.foreground === "border_color");
    expect(borderPairs).toHaveLength(3);
    expect(errors).toHaveLength(borderPairs.length);
    for (const error of errors) {
      expect(error.path.split("/").pop()).toBe("border_color");
    }
  });

  test("主ボタンの地色と枠線が同じ色でも拒否されない(D-V20-30)。副ボタンの地(highlight_surface)では拒否される", () => {
    const base: Record<string, string> = {
      body_text: "#000000",
      secondary_text: "#595959",
      label_text: "#595959",
      placeholder_text: "#595959",
      danger: "#a00000",
      page_background: "#ffffff",
      highlight_surface: "#f2f2f2",
      border_color: "#767676",
      focus_ring: "#005fcc",
      primary_fill: "#767676",
      on_primary: "#ffffff",
      overlay_background: "#ffffff",
      overlay_text: "#000000",
    };
    expect(checkThemeContrast(base)).toEqual([]);
    const onHighlight = checkThemeContrast({ ...base, highlight_surface: "#767676" });
    expect(onHighlight.some((e) => e.path.endsWith("border_color"))).toBe(true);
  });

  test("主ボタンの文字色 × 地色は本文テキストの閾値で測る(白地に白は拒否)", () => {
    const errors = checkThemeContrast({ primary_fill: "#ffffff", on_primary: "#ffffff" });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path.endsWith("on_primary")).toBe(true);
    expect(errors[0]?.message).toContain("4.5:1");
  });
});

describe("読めない色の hint が生の色への参照も名指しする(2026-09-27)", () => {
  test("hint は $palette_<名前> で生の色を指せることを述べ、例の括弧は今日のまま2表記である", () => {
    const [error] = checkThemeContrast({ body_text: "red", page_background: "#fff" });
    const hint = String(error?.hint);
    expect(hint).toContain("$palette_<名前> の形でその色を指すこともできます");
    // 例の括弧は従えば単独で通る値だけ(参照は例に入れない)。
    expect(examplesOf(hint)).toEqual(["#333333", "oklch(0.55 0.15 250)"]);
  });
});
