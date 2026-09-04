/**
 * `scripts/cp-v4/t19-a11y.ts` の**純粋な部分だけ**の検査(`V4-M15-T13`)。
 *
 * **サーバも chromium も起動しない**ので `bun test` でそのまま緑になる
 * (`scripts/cp-v4/t13-tools.test.ts` と同型)。
 *
 * **【重要】この検査は合否の下限を1つも置かない。** 数え方が壊れていないことだけを見る。
 */

import { expect, test } from "bun:test";
import { A11Y_KEYS, countA11yAttributes, diffCounts } from "./t19-a11y.ts";

test("数える属性の列挙が固定されている(分母が黙って動かない)", () => {
  // **増減させると着手前後の比較が成り立たなくなる。**
  // **赤くなったら、数を書き換える前に「同じ手順で測った」と言えるかを確かめること。**
  expect(A11Y_KEYS.length).toBe(20);
  expect([...A11Y_KEYS]).toContain("aria-invalid");
  expect([...A11Y_KEYS]).toContain("aria-current");
  expect([...A11Y_KEYS]).toContain("role");
});

test("当たらなかった計測点を数えない", () => {
  const counts = countA11yAttributes({
    results: [
      {
        probes: {
          a: { found: true, attrs: { role: "alert" } },
          b: { found: false, attrs: { role: "alert" } },
        },
      },
    ],
  });
  expect(counts["__probes_found"]).toBe(1);
  expect(counts.role).toBe(1);
});

test("属性が無い計測点は0のままである", () => {
  const counts = countA11yAttributes({
    results: [{ probes: { a: { found: true, attrs: {} } } }],
  });
  expect(counts["aria-invalid"]).toBe(0);
  expect(counts["__probes_found"]).toBe(1);
});

test("値が空文字でも1件として数える(値の正しさは判定しない)", () => {
  const counts = countA11yAttributes({
    results: [{ probes: { a: { found: true, attrs: { "aria-label": "" } } } }],
  });
  expect(counts["aria-label"]).toBe(1);
});

test("計測が空でも落ちない(0件を返す)", () => {
  const counts = countA11yAttributes({});
  expect(counts["__probes_found"]).toBe(0);
  expect(counts.role).toBe(0);
});

test("差は引き算だけで、良し悪しを1つも付けない", () => {
  const delta = diffCounts({ role: 3, alt: 5 }, { role: 7, alt: 2 });
  expect(delta.role).toBe(4);
  expect(delta.alt).toBe(-3);
  // **符号を丸めない。減った分は減ったまま出す。**
  expect(Object.values(delta).some((value) => value < 0)).toBe(true);
});
