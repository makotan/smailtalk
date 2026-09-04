/**
 * 面と印(V4-M15-T01。`ADR-0087`)。
 *
 * **出どころ**: `shadcn@4.16.1` の `@shadcn/card` / `@shadcn/badge` / `@shadcn/alert` /
 * `@shadcn/skeleton` / `@shadcn/separator`。
 *
 * **変えた点**(隠さない):
 * 1. **`dark:` を1つも残していない**(`ADR-0087` 限定10 / `D-V4-43`)。
 * 2. **`Alert` の `relative` と `[&>svg]:translate-y-0.5` を落とした** ——
 *    `position` と `transform` は `ADR-0087` 限定8 が禁じる9プロパティに入る。
 *    **手で書く CSS では1バイトも緩めない**という扱い(`v4-m13.md` §3-11)に合わせ、
 *    クラス名のリテラルの側でも使わないことにした。**代わりに素の flex で組んだ。**
 * 3. **`bg-primary` / `bg-destructive` / `bg-card`(= 別スロット)を使っていない**
 *    (`ADR-0087` 限定7。導出できない変数を入口にしない)。
 * 4. **`Separator` だけは `@base-ui-components/react/separator` をそのまま使う**
 *    (`D-V4-29` の土台。`role="separator"` / `aria-orientation` を持つ)。
 * 5. **`Skeleton` の `animate-pulse` は `@keyframes` を生む** —— 生成側の置き場
 *    (`web/src/tailwind.css` の出力)にだけ現れる。手で書く置き場には1文字も無い。
 */
import { Separator as BaseSeparator } from "@base-ui-components/react/separator";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "./utils.ts";

export function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "flex flex-col gap-s3 rounded-ui border-[length:var(--border-width)] border-solid border-border",
        "bg-background text-foreground font-sans shadow-surface p-s4",
        "group-data-[ui-family=compact]/ui:gap-s2 group-data-[ui-family=compact]/ui:p-s2 group-data-[ui-family=compact]/ui:rounded-none",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="card-header" className={cn("flex flex-col gap-s1", className)} {...props} />
  );
}

export function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn("font-semibold leading-none text-foreground", className)}
      {...props}
    />
  );
}

export function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-note text-muted-foreground", className)}
      {...props}
    />
  );
}

export function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="card-content" className={cn("flex flex-col gap-s2", className)} {...props} />
  );
}

export const badgeVariants = cva(
  cn(
    "inline-flex w-fit shrink-0 items-center justify-center gap-s1 overflow-hidden",
    "rounded-ui border-[length:var(--border-width)] border-solid px-s2 py-0 text-xs font-medium font-sans whitespace-nowrap",
    "group-data-[ui-family=compact]/ui:px-s1 group-data-[ui-family=compact]/ui:rounded-none",
  ),
  {
    variants: {
      variant: {
        default: "border-border bg-secondary text-secondary-foreground",
        outline: "border-border bg-background text-foreground",
        destructive: "border-destructive bg-background text-destructive",
        muted: "border-transparent bg-secondary text-muted-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export function Badge({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return (
    <span
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export const alertVariants = cva(
  cn(
    "flex w-full flex-col gap-s1 rounded-ui border-[length:var(--border-width)] border-solid",
    "bg-background px-s3 py-s2 text-sm font-sans",
    "group-data-[ui-family=compact]/ui:px-s2 group-data-[ui-family=compact]/ui:py-s1 group-data-[ui-family=compact]/ui:rounded-none",
  ),
  {
    variants: {
      variant: {
        default: "border-border text-foreground",
        destructive: "border-destructive text-destructive",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export function Alert({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      data-variant={variant}
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

export function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn("font-medium tracking-tight", className)}
      {...props}
    />
  );
}

export function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn("text-note text-muted-foreground", className)}
      {...props}
    />
  );
}

export function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("animate-pulse rounded-ui bg-secondary", className)}
      {...props}
    />
  );
}

export function Separator({ className, ...props }: React.ComponentProps<typeof BaseSeparator>) {
  return (
    <BaseSeparator
      data-slot="separator"
      className={cn(
        "shrink-0 bg-border",
        "data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full",
        "data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px",
        className,
      )}
      {...props}
    />
  );
}
