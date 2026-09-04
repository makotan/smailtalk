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
  "--color-text": "#000",
  "--color-text-secondary": "#666",
  "--color-text-label": "#666",
  "--color-text-placeholder": "#666",
  "--color-danger": "#a00",
  "--color-page-background": "#fff",
  "--color-surface-highlight": "#f2f2f2",
  "--color-border": "#ddd",
  "--focus-outline-color": "#005fcc",
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
    expect(Object.keys(THEME_SLOT_ROLES)).toHaveLength(25);
  });

  test("テーマ対象外の3件は役割表に載っていない(完了条件21)", () => {
    // **3件はいずれも `not-a-color` だったので、検査対象の対は1組も減らない** ——
    // 下の「14組」のテストが同時に緑であることがその機械的な証拠である。
    for (const excluded of ["--shell-max-width", "--border-style", "--focus-outline-style"]) {
      expect(Object.keys(THEME_SLOT_ROLES)).not.toContain(excluded);
    }
  });

  test("役割表は役割の属性だけを持つ(値・CSS プロパティ名・既定値を1つも持たない)", () => {
    for (const [name, role] of Object.entries(THEME_SLOT_ROLES)) {
      expect(name.startsWith("--")).toBe(true);
      const keys = Object.keys(role).sort();
      if (role.kind === "foreground") {
        expect(keys).toEqual(["kind", "target"]);
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

    expect(byRole("foreground", "text")).toEqual([
      "--color-danger",
      "--color-text",
      "--color-text-label",
      "--color-text-placeholder",
      "--color-text-secondary",
    ]);
    expect(byRole("foreground", "non-text")).toEqual(["--color-border", "--focus-outline-color"]);
    expect(byRole("background")).toEqual(["--color-page-background", "--color-surface-highlight"]);
  });

  test("色でないスロット16件は not-a-color(ペアを1つも生まない)", () => {
    // **19 → 16 は完了条件21 の3件を外した結果である**(3件はどれも `not-a-color`)。
    const notColor = Object.entries(THEME_SLOT_ROLES)
      .filter(([, role]) => role.kind === "not-a-color")
      .map(([name]) => name);
    expect(notColor).toHaveLength(16);
    for (const name of notColor) {
      expect(THEME_CONTRAST_PAIRS.some((p) => p.foreground === name || p.background === name)).toBe(
        false,
      );
    }
  });
});

describe("ペア生成(ADR-0046 §3 限定3 / T02 完了条件2)", () => {
  test("役割の直積として14組が機械的に生成される(一覧を期待値に固定する)", () => {
    expect(THEME_CONTRAST_PAIRS).toEqual([
      { foreground: "--color-danger", background: "--color-page-background", target: "text" },
      { foreground: "--color-danger", background: "--color-surface-highlight", target: "text" },
      { foreground: "--color-text", background: "--color-page-background", target: "text" },
      { foreground: "--color-text", background: "--color-surface-highlight", target: "text" },
      { foreground: "--color-text-label", background: "--color-page-background", target: "text" },
      { foreground: "--color-text-label", background: "--color-surface-highlight", target: "text" },
      {
        foreground: "--color-text-placeholder",
        background: "--color-page-background",
        target: "text",
      },
      {
        foreground: "--color-text-placeholder",
        background: "--color-surface-highlight",
        target: "text",
      },
      {
        foreground: "--color-text-secondary",
        background: "--color-page-background",
        target: "text",
      },
      {
        foreground: "--color-text-secondary",
        background: "--color-surface-highlight",
        target: "text",
      },
      { foreground: "--color-border", background: "--color-page-background", target: "non-text" },
      { foreground: "--color-border", background: "--color-surface-highlight", target: "non-text" },
      {
        foreground: "--focus-outline-color",
        background: "--color-page-background",
        target: "non-text",
      },
      {
        foreground: "--focus-outline-color",
        background: "--color-surface-highlight",
        target: "non-text",
      },
    ]);
  });

  test(":hover / :focus-visible でしか現れないペア(03 §7 の #5 / #12 / #16)を検査に含める", () => {
    // `--color-surface-highlight`(`#f2f2f2`)は
    // `.list-row-interactive:hover, .list-row-interactive:focus-visible` にしか現れない
    // (`web/src/styles.css`)。**背景として役割表に載っているので、直積が自動的に含める。**
    const hoverOnly = THEME_CONTRAST_PAIRS.filter(
      (pair) => pair.background === "--color-surface-highlight",
    );
    expect(hoverOnly).toHaveLength(7);

    // 03 §7 が名指しした3組が実際に入っていること。
    expect(hoverOnly).toContainEqual({
      foreground: "--color-text-placeholder", // #5: .field-empty の #666 が #f2f2f2 に載る
      background: "--color-surface-highlight",
      target: "text",
    });
    expect(hoverOnly).toContainEqual({
      foreground: "--color-danger", // #12: .field-unresolved の #a00 が #f2f2f2 に載る
      background: "--color-surface-highlight",
      target: "text",
    });
    expect(hoverOnly).toContainEqual({
      foreground: "--color-border", // #16: 枠線の #ddd が #f2f2f2 の上に描かれる
      background: "--color-surface-highlight",
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
        "--color-border": "#767676", // 既定の #ddd は 3:1 を満たさない(下のテストが固定する)
      }),
    ).toEqual([]);
  });

  test("白地に白文字は本文テキストの閾値で落ち、path が RFC 6901 でスロットを指す", () => {
    const errors = checkThemeContrast({
      "--color-text": "#ffffff",
      "--color-page-background": "#ffffff",
    });
    expect(errors).toHaveLength(1);
    const [error] = errors;
    expect(error?.path).toBe("/app/theme/--color-text");
    // どのスロット対がどの比で落ちたかを名指しする(比の値と閾値の両方を出す)。
    expect(error?.message).toContain("--color-text");
    expect(error?.message).toContain("--color-page-background");
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
        "--color-border": "#949494",
        "--color-page-background": "#ffffff",
      }),
    ).toEqual([]);
    // 同じ色を本文テキストのスロットに入れると落ちる(閾値が違うことの証明)。
    const errors = checkThemeContrast({
      "--color-text": "#949494",
      "--color-page-background": "#ffffff",
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("/app/theme/--color-text");
  });

  test("落ちたペアが複数あれば全件返す(1件目で打ち切らない)", () => {
    const errors = checkThemeContrast({
      "--color-text": "#fff",
      "--color-danger": "#fff",
      "--color-page-background": "#fff",
      "--color-surface-highlight": "#fff",
    });
    // (text, danger) × (page-background, surface-highlight) の4組が落ちる。
    expect(errors).toHaveLength(4);
    expect(errors.map((e) => e.path).sort()).toEqual([
      "/app/theme/--color-danger",
      "/app/theme/--color-danger",
      "/app/theme/--color-text",
      "/app/theme/--color-text",
    ]);
  });

  test("比は丸めずに比較する(4.49… を 4.5 に丸めて通さない)", () => {
    // #767776 は白地に対して 4.496:1 —— 小数第2位で丸めると 4.50 になる値。
    const ratio = contrastRatio("#767776", "#ffffff");
    expect(ratio).not.toBeNull();
    expect(ratio ?? 0).toBeLessThan(4.5);
    expect(Number((ratio ?? 0).toFixed(2))).toBe(4.5);
    expect(
      checkThemeContrast({ "--color-text": "#767776", "--color-page-background": "#ffffff" }),
    ).toHaveLength(1);
  });

  test("色として読めない値は fail-closed で拒否する(比を計算できないため)", () => {
    const errors = checkThemeContrast({
      "--color-text": "rebeccapurple",
      "--color-page-background": "#fff",
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("/app/theme/--color-text");
    expect(errors[0]?.message).toContain("色として読めません");
  });

  test("文字列でない値も fail-closed で拒否する", () => {
    expect(checkThemeContrast({ "--color-text": 123 })).toHaveLength(1);
    expect(checkThemeContrast({ "--color-text": null })).toHaveLength(1);
  });

  test("色でないスロットの値は検査しない(読めない値でもエラーにしない)", () => {
    expect(checkThemeContrast({ "--space-1": "0.25rem", "--surface-shadow": "none" })).toEqual([]);
  });

  test("片側しか無いペアは検査しない(既定値をカーネルが持たないため)", () => {
    // 前景だけを指定した場合、背景側は `styles.css` の既定値だが、
    // **カーネルはその値を持たない**(ADR-0046 限定3。値を持てばトークン表になる)。
    // したがって比を計算できず、検査を飛ばす。**これは fail-closed の穴である**(記録 §11-2)。
    expect(checkThemeContrast({ "--color-text": "#fff" })).toEqual([]);
    expect(checkThemeContrast({ "--color-page-background": "#fff" })).toEqual([]);
  });

  test("役割表に無いキーは無視する(値域はスキーマが縛る。T03)", () => {
    expect(checkThemeContrast({ "--not-a-slot": "#fff", origin: "template-app" })).toEqual([]);
  });

  test("空のテーマはエラー0件", () => {
    expect(checkThemeContrast({})).toEqual([]);
  });

  test("path の接頭辞は差し替えられる(T03 の格納形が決まっていないため)", () => {
    const errors = checkThemeContrast(
      { "--color-text": "#fff", "--color-page-background": "#fff" },
      "/app/theme/slots",
    );
    expect(errors[0]?.path).toBe("/app/theme/slots/--color-text");
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
      "/app/theme/--color-border",
      "/app/theme/--color-border",
    ]);
    expect(errors[0]?.message).toContain("1.36");
    expect(errors[1]?.message).toContain("1.21");
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
    expect(roleKeys).toHaveLength(25);
  });

  test("`$defs/theme` の required も同じ25キーである(部分テーマを作らない)", () => {
    // ADR-0047 の 2026-07-25 追記 (2)。**全スロット必須でないと、片側しか指定されて
    // いない対が1組も検査されない**(この検査の穴。`checkThemeContrast` の doc)。
    expect([...MANIFEST_SCHEMA_FOR_PARITY.$defs.theme.required].sort()).toEqual(
      Object.keys(MANIFEST_SCHEMA_FOR_PARITY.$defs.theme.properties).sort(),
    );
  });

  test("役割表のキーも CSS カスタムプロパティ名そのものである(変換規則は恒等の1本だけ)", () => {
    // 変換規則の定義の正は `web/test/theme-slot-parity.test.ts` の
    // `themeSlotToCssCustomProperty`(恒等写像)である。**規則が2本になると、
    // 持ち出した `theme.css` が「形式は安定しているが当たらない」状態になる**
    // (v3-m1.md T05-4)。ここでは役割表の側も同じ形であることを固定する。
    for (const name of Object.keys(THEME_SLOT_ROLES)) {
      expect(name).toMatch(/^--[a-z][a-z0-9-]*$/);
    }
  });
});
