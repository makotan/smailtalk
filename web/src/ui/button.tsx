/**
 * ボタン(V4-M15-T01。`ADR-0087`)。
 *
 * **出どころ**: `shadcn@4.16.1` の `@shadcn/button`(`registry/new-york-v4/ui/button.tsx`)。
 * **そのままでは使えないので、次の3点を変えてある。隠さない。**
 *
 * 1. **`dark:` で始まるクラスを1つも残していない**(`ADR-0087` 限定10 / `D-V4-43`)——
 *    Tailwind の `dark:` は `@media (prefers-color-scheme: dark)` を出力に生む。
 *    **これを機械で止める検査は作っていない**(`D-V4-47`)。守っているのは人の側の約束だけである。
 * 2. **`radix-ui` の `Slot` を入れていない**(`D-V4-29` が土台を Base UI に固定した)。
 *    `asChild` は `@base-ui-components/react/use-render` の `useRender` で作る。
 * 3. **`bg-primary` / `text-primary-foreground` / `bg-destructive` を1つも使っていない**
 *    (`ADR-0087` 限定7)—— **`--primary` と `--destructive-foreground` は25スロットから
 *    導出できない。** 濃い地色のスロットが1つも無く、`--color-danger` の上に載せる文字色も
 *    無い。**したがって「塗りつぶしのボタン」は今日この製品では作れない。**
 *    導出できない変数の一覧は `docs/plan/v4/records/v4-m15-t19.md` §T08 が持つ。
 *
 * **【V4-M18-T06 で 3 の後半が偽になった。旧文を1バイトも消していない】**
 * 「したがって『塗りつぶしのボタン』は今日この製品では作れない」は **2026-08-03 の
 * 着手前までは真だったが、今日は成り立たない** —— **`V4-M18` 門A本審査 単位4 が
 * `--primary` / `--primary-foreground` を「既存25スロットから**導出**できる」と実測し
 * (判定 = **却下**)、その却下の帰属先として `V4-M18-T06` が4行の導出を足した。**
 * **偽になったのは「作れない」の部分だけである** —— **「濃い地色のスロットが25件に
 * 1つも無い」は今日も真であり、`$defs/theme` は 25 / 25 のままである。**
 * **`--destructive-foreground` は今日も導出できず、`bg-destructive` は1件も無い。**
 * **【禁止】「主たる操作の色を選べるようになった」と書かない**(地色は本文の文字色そのもの)。
 *
 * ## 地色を必ず書く(`ADR-0046` §3a の門に当たらないための条件)
 *
 * **どの variant も `bg-…` を必ず1つ持つ。** 地色を書かないと UA 既定の `buttonface` が
 * 出て、「**テーマの文字色 × UA のボタン地色**」という**コントラスト検査が1組も見ていない対**が
 * できる —— それが `web/src/styles.css` の冒頭近く(`:164`-`:167`)が
 * 「足すなら検査対象の対を増やすのが先であり、それは `ADR-0046` §3a の門を通す事項である」と
 * 書いている穴そのものである。**前景も地色も25スロットの側から書けば、その対は
 * `THEME_CONTRAST_PAIRS` に既に入っている**(前景 × 背景の直積で生成されるため)。
 * **検査対象の対を1組も増やしていない。**
 */
import { useRender } from "@base-ui-components/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "./utils.ts";

export const buttonVariants = cva(
  cn(
    "inline-flex shrink-0 items-center justify-center gap-s1 rounded-ui font-sans font-medium whitespace-nowrap",
    // **`transition-colors` を使わない**(理由は `form-controls.tsx` の同じ箇所に書いた ——
    // `outline-color` が遷移対象に入り、フォーカスリングの色が即座に出なくなる)。
    "border-[length:var(--border-width)] border-solid transition-[color,background-color,border-color]",
    "outline-none focus-visible:outline-[length:var(--focus-outline-width)] focus-visible:outline-solid focus-visible:outline-ring",
    "disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ),
  {
    variants: {
      variant: {
        default: "border-border bg-background text-foreground hover:bg-accent active:bg-accent",
        // **塗りつぶし(V4-M18-T06)。** 地色も文字色も25スロットからの**導出**であり
        // (`--color-primary := var(--color-text)` / `--color-primary-foreground :=
        // var(--color-page-background)`。`web/src/tailwind.css`)、**`$defs/theme` は
        // 今日も 25 / 25 である。****【禁止】「主たる操作の色を選べるようになった」と
        // 書かない** —— 地色は本文の文字色そのもので、本文と独立には選べない。
        // **hover / active も導出の側で作る** —— 色のリテラルを1バイトも書かないため、
        // 明度をずらす代わりに枠線の色だけを変える(`bg-primary` は据え置く)。
        primary:
          "border-primary bg-primary text-primary-foreground hover:border-foreground active:border-foreground",
        secondary:
          "border-border bg-secondary text-secondary-foreground hover:bg-accent active:bg-accent",
        destructive:
          "border-destructive bg-background text-destructive hover:bg-accent active:bg-accent",
        ghost: "border-transparent bg-background text-foreground hover:bg-accent active:bg-accent",
        link: "border-transparent bg-background text-foreground underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-9 px-s3 py-s1 text-sm group-data-[ui-family=compact]/ui:h-7 group-data-[ui-family=compact]/ui:px-s2 group-data-[ui-family=compact]/ui:text-xs",
        sm: "h-8 px-s2 text-sm group-data-[ui-family=compact]/ui:h-6 group-data-[ui-family=compact]/ui:px-s1 group-data-[ui-family=compact]/ui:text-xs",
        icon: "size-9 group-data-[ui-family=compact]/ui:size-7",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    /** 別の要素として描く(`radix-ui` の `asChild` に相当。Base UI の `render` で作る)。 */
    render?: useRender.RenderProp;
  };

export function Button({
  className,
  variant = "default",
  size = "default",
  render,
  type = "button",
  ...props
}: ButtonProps) {
  // **`type` は呼び出し側の値を解決してから `render` の要素属性に載せる。**
  // **【V4-M15-T04 が実測して見つけた罠】** `render` に書いた属性は `props` より強く、
  // 既定の要素を `<button type="button" />` と書き固定してしまうと、
  // `<Button type="submit">` と書いても送信が起きない(実測)。
  // **既定値は引数の既定として持ち、要素にはその解決結果を渡す。**
  return useRender({
    render: render ?? <button type={type} />,
    props: {
      "data-slot": "button",
      "data-variant": variant,
      "data-size": size,
      className: cn(buttonVariants({ variant, size }), className),
      ...props,
    },
  });
}
