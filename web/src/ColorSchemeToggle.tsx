/**
 * **明暗のスイッチ**(`V20-M10-T03`。ユーザ決定 `D-V20-31` / `D-V20-32` / `D-V20-33`)。
 *
 * - **置き場は各アプリの上端の帯(`app-header`)だけ**(持ち主の画面 `AppWorkspace.tsx` と利用者向けの
 *   `runner-app.tsx`)。**アプリ一覧とログイン画面には置かない。**
 * - **【V20-M10-T05。上の1行を消していない】ログインせずに開ける画面(公開の画面)の上端の帯にも置く**
 *   (メインの裁定。公開の画面の帯もアプリの上端の帯である)。そこには `.current-user` が無いので、
 *   右寄せは呼ぶ側が `className="ml-auto"` を渡して持たせる。
 * - **押せるボタン1つ。** `aria-pressed` と見える文字(「暗い表示: オン / オフ」)で今の状態が分かる。
 * - **暗い側の組(`slots_dark`)を持たないテーマのアプリでは出さない**(`D-V20-31`。そのアプリは
 *   明るいまま)。テーマを持たないアプリでは出す(既定の暗い値が効く)。
 * - 決め方の本体は `web/src/color-scheme.ts` に在る。**ここは読んで押すだけである。**
 */
import type { Theme } from "../../src/kernel/types.ts";
import { toggleColorScheme, useColorScheme } from "./color-scheme.ts";
import { Button } from "./ui/button.tsx";

/** 暗い側に切り替えられるテーマか(テーマ無し、または暗い側の組を持つ)。 */
export function themeAllowsDark(theme: Theme | undefined): boolean {
  return theme === undefined || theme.slots_dark !== undefined;
}

export function ColorSchemeToggle({
  theme,
  className,
}: {
  theme?: Theme | undefined;
  /** 置き場の側が要る配置のクラス(公開の画面の帯の右寄せ `ml-auto`)。 */
  className?: string | undefined;
}) {
  const scheme = useColorScheme();
  if (!themeAllowsDark(theme)) {
    return null;
  }
  const dark = scheme === "dark";
  return (
    <Button
      size="sm"
      {...(className === undefined ? {} : { className })}
      data-testid="color-scheme-toggle"
      aria-pressed={dark}
      onClick={() => toggleColorScheme()}
    >
      {dark ? "暗い表示: オン" : "暗い表示: オフ"}
    </Button>
  );
}
