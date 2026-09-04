/**
 * 部品体系の共通ユーティリティ(V4-M15-T01。ADR-0087)。
 *
 * `cn` は shadcn/ui の生成物がそのまま持ってくる関数で、clsx で結合し
 * tailwind-merge で後勝ちに潰す。**この製品の知識を1つも持たない。**
 */
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
