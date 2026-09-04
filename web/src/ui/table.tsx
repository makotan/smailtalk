/**
 * 表(V4-M15-T01 / T03。`ADR-0087`)。
 *
 * **出どころ**: `shadcn@4.16.1` の `@shadcn/table`。
 *
 * **変えた点**(隠さない):
 * 1. **包みの `relative` を落とした**(`ADR-0087` 限定8 の9プロパティ)。
 *    **`overflow-x-auto` は残した** —— 横に溢れる表を狭い画面で読めるようにするのは
 *    `D-V4-44`(画面幅への対応)の中身であり、座標系プロパティではない。
 * 2. **`[&>[role=checkbox]]:translate-y-[2px]` を落とした**(`transform`。同上)。
 * 3. **`data-[state=selected]` の分岐を落とした** —— この製品に選択状態は無い
 *    (`03` §4-1 の実測で `aria-selected` 0件)。**当たり先の無い分岐を置かない。**
 * 4. `dark:` を1つも残していない。
 *
 * ## `class` を既存のものから変えていない列(重要)
 *
 * **`.list-table` / `.related-table` / `.list-row` / `.related-row` などの既存クラス名は
 * 1つも消していない。** 画面プリセット(`ADR-0050` / `ADR-0051`)の CSS 規則が
 * `.list-table col[data-preset-width="narrow"]` の形でこれらに当たっており、
 * **消すとプリセット7軸20値がまるごと効かなくなる。**
 * 部品体系のクラスは**既存クラスに足す**形で入れてある。
 */
import type * as React from "react";
import { cn } from "./utils.ts";

export function TableFrame({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="table-container"
      className={cn("w-full overflow-x-auto", className)}
      {...props}
    />
  );
}

export function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <table
      data-slot="table"
      className={cn("w-full caption-bottom text-sm font-sans", className)}
      {...props}
    />
  );
}

export function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn("bg-secondary", className)} {...props} />;
}

export function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return <tbody data-slot="table-body" className={className} {...props} />;
}

export function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return <tr data-slot="table-row" className={cn("transition-colors", className)} {...props} />;
}

export function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "text-left align-middle font-medium text-foreground",
        "group-data-[ui-family=compact]/ui:text-xs",
        className,
      )}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn("align-top", "group-data-[ui-family=compact]/ui:text-xs", className)}
      {...props}
    />
  );
}
