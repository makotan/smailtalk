/**
 * 入力部品(V4-M15-T01 / T04。`ADR-0087`)。
 *
 * **出どころ**: `shadcn@4.16.1` の `@shadcn/input` / `@shadcn/textarea` / `@shadcn/label`。
 * **`<select>` は shadcn の `select`(重ねて出すメニュー)を使っていない** ——
 * **`ADR-0087` 限定8 が「重ねて出す表現を1つも入れない」と定めているので、素の
 * `<select>` に同じ体裁だけを当てた。** `role="listbox"` も `position` も1つも増えない。
 *
 * **変えた点**(`button.tsx` と同じ3点):
 * 1. `dark:` を1つも残していない(`ADR-0087` 限定10)。
 * 2. `radix-ui` の `Label` を使わず素の `<label>` にした(`D-V4-29`)。
 * 3. `selection:bg-primary` / `selection:text-primary-foreground` を落とした
 *    (`--primary` は25スロットから導出できない。`ADR-0087` 限定7)。
 *
 * **地色と文字色を必ず対で書く** —— 理由は `button.tsx` の冒頭に書いた
 * (`ADR-0046` §3a の門に当たらないための条件)。
 */
import type * as React from "react";
import { cn } from "./utils.ts";

/** 入力部品に共通の体裁。**地色と文字色を必ず対で持つ。** */
const controlBase = cn(
  "w-full min-w-0 rounded-ui border-[length:var(--border-width)] border-solid border-input",
  "bg-background text-foreground font-sans",
  "placeholder:text-placeholder",
  // **`transition-colors` を使わない。** Tailwind v4 の `transition-colors` は
  // `outline-color` を遷移対象に含むので、フォーカスリングの色が 150ms かけて
  // `currentColor` から変わる —— **フォーカスした直後の計算値が黒になる**(chromium 実測)。
  // **フォーカスの手がかりは即座に出るべきなので、遷移させるものを明示して列挙する。**
  "transition-[color,background-color,border-color] outline-none",
  "focus-visible:outline-[length:var(--focus-outline-width)] focus-visible:outline-solid focus-visible:outline-ring",
  "disabled:cursor-not-allowed disabled:opacity-50",
  "aria-invalid:border-destructive",
);

const controlDensity = cn(
  "px-s2 py-s1 text-sm",
  "group-data-[ui-family=compact]/ui:px-s1 group-data-[ui-family=compact]/ui:py-0 group-data-[ui-family=compact]/ui:text-xs",
);

export function Input({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      data-slot="input"
      className={cn(
        controlBase,
        controlDensity,
        "h-9 group-data-[ui-family=compact]/ui:h-7",
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(controlBase, controlDensity, "min-h-16 field-sizing-content", className)}
      {...props}
    />
  );
}

export function Select({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="select"
      className={cn(
        controlBase,
        controlDensity,
        "h-9 group-data-[ui-family=compact]/ui:h-7",
        className,
      )}
      {...props}
    />
  );
}

export function Checkbox({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type="checkbox"
      data-slot="checkbox"
      className={cn(
        "size-4 shrink-0 rounded-ui border-[length:var(--border-width)] border-solid border-input",
        "accent-foreground transition-[color,background-color,border-color] outline-none",
        "focus-visible:outline-[length:var(--focus-outline-width)] focus-visible:outline-solid focus-visible:outline-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

/**
 * 項目名。**`htmlFor` を必須にしてある** —— 入力欄と結ばれないラベルを作れないようにする
 * ためで、`biome` の `a11y/noLabelWithoutControl` を抑制ではなく型で満たしている
 * (`P-G46` の扱い「規律を1つも緩めない」に合わせた)。
 */
export function Label({
  className,
  htmlFor,
  children,
  ...props
}: React.ComponentProps<"label"> & { htmlFor: string; children: React.ReactNode }) {
  return (
    <label
      data-slot="label"
      htmlFor={htmlFor}
      className={cn(
        "flex items-center gap-s1 font-sans text-sm font-medium text-label select-none",
        "group-data-[ui-family=compact]/ui:text-xs",
        className,
      )}
      {...props}
    >
      {children}
    </label>
  );
}
