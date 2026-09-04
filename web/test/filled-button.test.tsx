/**
 * **塗りつぶしのボタンと、その配色の導出**(`V4-M18-T06`)。
 *
 * ## これは何で、何ではないか
 *
 * **`V4-M18` 門A本審査 単位4(`P-G49` の (C) 側 + `P-G35` の (C) 側)は**却下**である。**
 * 本タスクは**その却下の帰属先(表示層 = `ADR-0087` 限定7 の導出)を履行するもの**であって、
 * 採用系になった単位の実装ではない(`docs/plan/v4/records/v4-m18.md` §2-1 の
 * 【`T06` の位置づけを混ぜない】)。
 *
 * - **【禁止】これを「テーマのスロットが増えた」と読まない。** **`$defs/theme` は 25 / 25 のままである。**
 * - **【禁止】「主たる操作の色を選べるようになった」と読まない。** **選べない** ——
 *   塗りつぶしの地色は**本文の文字色そのもの**であり、本文と独立には選べない
 *   (`v4-m18-gate-a-theme-slot-gap.md` §3-3 の 1)。
 * - **【禁止】「テーマの二重化が解けた」と読まない。** **`--chart-*` 5件と `--sidebar` 系8件は
 *   今日も当たり先を持たない**(同 §5-5)。
 *
 * ## 導出の形(4行。**足したのは `web/src/tailwind.css` の `@theme inline` だけである**)
 *
 * ```
 * --color-primary            := var(--color-text)
 * --color-primary-foreground := var(--color-page-background)
 * --color-popover            := var(--color-page-background)
 * --color-popover-foreground := var(--color-text)
 * ```
 *
 * **色のリテラルを1バイトも書いていない**(`ADR-0094` 限定7 / `style-sources.test.ts` の (集合6))。
 *
 * ## この検査が言えないこと
 *
 * **ここは happy-dom であって CSS を1バイトも計算しない。** 見えるのは**クラス名の差**までである。
 * **計算値の実測は chromium(`web/e2e/overlay.e2e.ts`)で別に採る。**
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { render, screen } from "@testing-library/react";
import manifestSchema from "../../schemas/manifest.schema.json" with { type: "json" };
import { Button } from "../src/ui/button.tsx";

const WEB_SRC = join(dirname(import.meta.dir), "src");

function readSource(name: string): string {
  return readFileSync(join(WEB_SRC, name), "utf8");
}

/** 導出する4件(左辺 = 部品側 / 右辺 = 25スロットのどれか)。 */
const DERIVATIONS: readonly (readonly [string, string])[] = Object.freeze([
  ["--color-primary", "var(--color-text)"],
  ["--color-primary-foreground", "var(--color-page-background)"],
  ["--color-popover", "var(--color-page-background)"],
  ["--color-popover-foreground", "var(--color-text)"],
]);

test("(T06-1) 4件が生成側の入口で 25スロットから導出されている", () => {
  const css = readSource("tailwind.css");
  for (const [name, value] of DERIVATIONS) {
    expect(css.includes(`${name}: ${value};`), name).toBe(true);
  }
});

test("(T06-2) $defs/theme のスロットを1本も増やしていない(25 / 25 のまま)", () => {
  const theme = (manifestSchema as { $defs: { theme: Record<string, unknown> } }).$defs.theme;
  const properties = theme.properties as Record<string, unknown>;
  const required = theme.required as string[];
  expect(Object.keys(properties)).toHaveLength(25);
  expect(required).toHaveLength(25);
});

test("(T06-3) 塗りつぶしの variant が実在し、地色と文字色の両方を導出から取る", () => {
  render(
    <Button variant="primary" data-testid="filled">
      注文する
    </Button>,
  );
  const button = screen.getByTestId("filled");
  expect(button.getAttribute("data-variant")).toBe("primary");
  const className = button.getAttribute("class") ?? "";
  expect(className.includes("bg-primary")).toBe(true);
  expect(className.includes("text-primary-foreground")).toBe(true);
});

test("(T06-4) 既定の variant は今日と1バイトも変わっていない", () => {
  render(<Button data-testid="plain">保存</Button>);
  const button = screen.getByTestId("plain");
  expect(button.getAttribute("data-variant")).toBe("default");
  const className = button.getAttribute("class") ?? "";
  expect(className.includes("bg-primary")).toBe(false);
  expect(className.includes("bg-background")).toBe(true);
});

test("(T06-5) 生成側の入口に色のリテラルを1バイトも足していない", () => {
  const body = readSource("tailwind.css").replace(/\/\*[\s\S]*?\*\//g, "");
  expect(/#[0-9a-fA-F]{3,8}\b/.test(body)).toBe(false);
  expect(/\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\s*\(/i.test(body)).toBe(false);
});
