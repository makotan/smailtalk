import { describe, expect, test } from "bun:test";
import { resolveThemeSlots, THEME_REFERENCE_MAX_DEPTH } from "./theme-reference.ts";

/**
 * **テーマの参照の解決器の純関数の振る舞い**(`V20-M9-T02`。条文 = `ADR-0474` §Decision 1-4 / 1-5)。
 *
 * 規則は5本(R1〜R5)。判定の順は「未解決 → 循環 → 深さ」。3種の拒否は別々のメッセージで、
 * 目印は 未解決 =「解決できない参照」/ 循環 =「循環参照」/ 深さ =「参照が深すぎ」。
 * **1件ずつ別々の test に分ける**(片方だけ壊れても赤くなる形)。
 *
 * `validateManifestFull` への結線(incoming だけ・stored には掛けない・全か無か)は
 * `theme-reference-wiring.test.ts` が撃つ。
 */

const PREFIX = "/app/theme/slots";
const ref = (name: string): string => `$palette_${name}`;
const resolve = (slots: Record<string, string>) => resolveThemeSlots(slots, PREFIX);

describe("V20-M9-T02: THEME_REFERENCE_MAX_DEPTH(ADR-0474 §1-1 / 限定9)", () => {
  test("深さの上限は 3 ちょうど", () => {
    expect(THEME_REFERENCE_MAX_DEPTH).toBe(3);
  });
});

describe("V20-M9-T02: R1 / R2 —— 参照を実値まで解く", () => {
  test("R1: 役割 → 生の色 の1回で実値に着く", () => {
    const out = resolve({ body_text: ref("ink"), palette_ink: "#111111" });
    expect(out.errors).toEqual([]);
    expect(out.slots.body_text).toBe("#111111");
    expect(out.slots.palette_ink).toBe("#111111");
  });

  test("R2: 生の色が生の色を指せる(別名)。役割 → 別名 → 生の色 で実値に着く", () => {
    const out = resolve({
      primary_fill: ref("brand"),
      palette_brand: ref("blue_600"),
      palette_blue_600: "#1d4ed8",
    });
    expect(out.errors).toEqual([]);
    expect(out.slots.primary_fill).toBe("#1d4ed8");
    expect(out.slots.palette_brand).toBe("#1d4ed8");
  });

  test("解いた値は実値のまま(oklch も書き換えない)。参照でない枠は写すだけ", () => {
    const out = resolve({
      label_text: "oklch(0.5 0.1 250)",
      space_1: "0.25rem",
      body_text: ref("x"),
      palette_x: "oklch(0.2 0.05 30)",
    });
    expect(out.errors).toEqual([]);
    expect(out.slots).toEqual({
      label_text: "oklch(0.5 0.1 250)",
      space_1: "0.25rem",
      body_text: "oklch(0.2 0.05 30)",
      palette_x: "oklch(0.2 0.05 30)",
    });
  });

  test("入力を書き換えない(純関数)", () => {
    const input = { body_text: ref("ink"), palette_ink: "#111111" };
    const copy = { ...input };
    resolve(input);
    expect(input).toEqual(copy);
  });
});

describe("V20-M9-T02: R3 —— 解決できない参照", () => {
  test("未解決1件: どの枠のどの参照かを名指しし、path はその枠", () => {
    const out = resolve({ body_text: ref("nope") });
    expect(out.errors).toHaveLength(1);
    const [error] = out.errors;
    expect(error?.path).toBe(`${PREFIX}/body_text`);
    expect(error?.message).toContain("解決できない参照");
    expect(error?.message).toContain("body_text");
    expect(error?.message).toContain("$palette_nope");
    // 他の2種の目印を混ぜない(罠E: 3種は別々のメッセージ)。
    expect(error?.message).not.toContain("循環参照");
    expect(error?.message).not.toContain("参照が深すぎ");
  });

  test("どの役割からも指されていない生の色の未解決も拒否する(生の色は全部解く)", () => {
    const out = resolve({ body_text: "#000000", palette_orphan: ref("missing") });
    expect(out.errors.map((e) => e.path)).toEqual([`${PREFIX}/palette_orphan`]);
    expect(out.errors[0]?.message).toContain("解決できない参照");
    expect(out.errors[0]?.message).toContain("$palette_missing");
  });

  test("4歩目で行き先が無い鎖は「未解決」と報じる(判定の順 未解決 → 深さ)", () => {
    const out = resolve({
      body_text: ref("1"),
      palette_1: ref("2"),
      palette_2: ref("3"),
      palette_3: ref("zz"),
    });
    const kinds = out.errors.map((e) => e.message.includes("解決できない参照"));
    expect(out.errors).toHaveLength(4);
    expect(kinds.every(Boolean)).toBe(true);
  });
});

describe("V20-M9-T02: R4 —— 循環参照", () => {
  test("長さ1(palette_a → palette_a): 道筋を名指しする", () => {
    const out = resolve({ palette_a: ref("a") });
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]?.path).toBe(`${PREFIX}/palette_a`);
    expect(out.errors[0]?.message).toContain("循環参照");
    expect(out.errors[0]?.message).toContain("palette_a → palette_a");
    expect(out.errors[0]?.message).not.toContain("解決できない参照");
  });

  test("長さ2(palette_a → palette_b → palette_a): 道筋を名指しし、両方の枠が拒否される", () => {
    const out = resolve({ palette_a: ref("b"), palette_b: ref("a") });
    expect(out.errors.map((e) => e.path).sort()).toEqual([
      `${PREFIX}/palette_a`,
      `${PREFIX}/palette_b`,
    ]);
    const a = out.errors.find((e) => e.path.endsWith("/palette_a"));
    expect(a?.message).toContain("循環参照");
    expect(a?.message).toContain("palette_a → palette_b → palette_a");
  });

  test("長さ3(palette_a → palette_b → palette_c → palette_a)", () => {
    const out = resolve({ palette_a: ref("b"), palette_b: ref("c"), palette_c: ref("a") });
    expect(out.errors).toHaveLength(3);
    expect(out.errors.every((e) => e.message.includes("循環参照"))).toBe(true);
    const a = out.errors.find((e) => e.path.endsWith("/palette_a"));
    expect(a?.message).toContain("palette_a → palette_b → palette_c → palette_a");
  });

  test("役割から輪に入る鎖も循環と報じる(道筋は役割から始まる)", () => {
    const out = resolve({ body_text: ref("a"), palette_a: ref("b"), palette_b: ref("a") });
    const b = out.errors.find((e) => e.path.endsWith("/body_text"));
    expect(b?.message).toContain("循環参照");
    expect(b?.message).toContain("body_text → palette_a → palette_b → palette_a");
  });

  test("4つの生の色の輪は「深すぎ」ではなく「循環」と報じる(判定の順 循環 → 深さ)", () => {
    const out = resolve({
      palette_1: ref("2"),
      palette_2: ref("3"),
      palette_3: ref("4"),
      palette_4: ref("1"),
    });
    expect(out.errors).toHaveLength(4);
    expect(out.errors.every((e) => e.message.includes("循環参照"))).toBe(true);
    expect(out.errors.some((e) => e.message.includes("参照が深すぎ"))).toBe(false);
  });

  test("どの役割からも指されていない生の色の循環も拒否する", () => {
    const out = resolve({ body_text: "#000000", palette_a: ref("b"), palette_b: ref("a") });
    expect(out.errors).toHaveLength(2);
    expect(out.errors.every((e) => e.message.includes("循環参照"))).toBe(true);
  });
});

describe("V20-M9-T02: R5 —— 参照が深すぎる", () => {
  test("深さちょうど3(役割 → 生 → 生 → 生の実値)は通る", () => {
    const out = resolve({
      body_text: ref("1"),
      palette_1: ref("2"),
      palette_2: ref("3"),
      palette_3: "#000000",
    });
    expect(out.errors).toEqual([]);
    expect(out.slots.body_text).toBe("#000000");
  });

  test("4回たどる鎖は拒否し、上限3を名指しする。path はその枠", () => {
    const out = resolve({
      body_text: ref("1"),
      palette_1: ref("2"),
      palette_2: ref("3"),
      palette_3: ref("4"),
      palette_4: "#000000",
    });
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]?.path).toBe(`${PREFIX}/body_text`);
    expect(out.errors[0]?.message).toContain("参照が深すぎ");
    expect(out.errors[0]?.message).toContain("3");
    expect(out.errors[0]?.message).not.toContain("循環参照");
    expect(out.errors[0]?.message).not.toContain("解決できない参照");
  });

  test("深さは生の色から始まる鎖でも同じに数える", () => {
    const out = resolve({
      palette_1: ref("2"),
      palette_2: ref("3"),
      palette_3: ref("4"),
      palette_4: ref("5"),
      palette_5: "#000000",
    });
    expect(out.errors.map((e) => e.path)).toEqual([`${PREFIX}/palette_1`]);
    expect(out.errors[0]?.message).toContain("参照が深すぎ");
  });
});

describe("V20-M9-T02: 拒否があった枠は解いた写しに入らない / 枠ごとに高々1件", () => {
  test("拒否された枠は slots に無く、拒否されていない枠は在る", () => {
    const out = resolve({ body_text: ref("nope"), label_text: "#595959" });
    expect(Object.keys(out.slots)).toEqual(["label_text"]);
  });

  test("枠ごとの誤りは高々1件", () => {
    const out = resolve({ palette_a: ref("b"), palette_b: ref("a"), body_text: ref("a") });
    const paths = out.errors.map((e) => e.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  test("pathPrefix はそのまま前置される", () => {
    const out = resolveThemeSlots({ body_text: ref("nope") }, "/operations/0/theme/slots");
    expect(out.errors[0]?.path).toBe("/operations/0/theme/slots/body_text");
  });
});
