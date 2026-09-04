/**
 * **登録の直後の案内**(`V4-M21-T03` / `E-G65` / `D-V4-82`)を描く1本。
 * **`V10-M19-T01` / `FU-G6` / `ADR-0363` で `web/src/AppWorkspace.tsx:1010`-`:1038` から切り出した。**
 *
 * ## なぜ切り出したのか
 *
 * **配る版(`web/src/runner-app.tsx`)にも同じ案内を描くと決めたからである**
 * (ユーザ決定 `D-V10-17`)。**`ADR-0363` 限定1 が「案内を描く実装は1本のまま」を
 * 検査式つきに縛っている** —— **配る版のために2本目を書かない。**
 * **`web/src/navigation.tsx:86`-`:88` が別の主題について同じことを書いている**
 * (逐語: 「**同じ `.find()` が2箇所にあると、規約を変えたときに片方だけが変わる。**」)。
 *
 * ## 何を移したのか / 何を書き換えたのか(**誇張しない**)
 *
 * - **移したのは `<Alert>` の1ブロックだけである。** **文面の3行は1文字も変えていない**
 *   (`ADR-0363` 限定2)。
 * - **書き換えたのは名前2つだけである** —— `signupNextForms` → `views` /
 *   `onDismissSignupNotice` → `onDismiss`。**判定も条件も1バイトも足していない。**
 * - **候補が0本なら `null` を返す**(`ADR-0363` §Decision 3 / ユーザ決定 `D-V10-24`)。
 *   **門を部品の中に持つので、呼び出し側は外側の門を書かなくてよい。**
 *
 * ## 【門が2箇所に在る。これは意図である】
 *
 * **`web/src/AppWorkspace.tsx` の側には、候補の本数を見る外側の門が今日も残っている。**
 * **`ADR-0363` 限定3 がその1行の字面を「`web/src/` に1行」で固定しているためであり、
 * 消すと限定3 が破れる。** **配る版の側にはその字面を1文字も書いていない** ——
 * **書くと当たりが増えて、やはり限定3 が破れる。**
 * **どちらの版でも、描くか否かの判定はこの部品の早期 `return null` が単独で決めている。**
 *
 * **【判定式そのものをこの doc に書き写していない】** **書き写すと、限定3 の当たりが
 * この doc の行まで数えてしまい、書いたその場で式の値が動く**
 * (このリポジトリで繰り返し出ている型)。 **式の全文は `ADR-0363` §Decision 5 に在る。**
 *
 * ## 【この部品が解かないこと。先に書く】
 *
 * - **どれが「会員情報」なのかを知らない。** **候補を1本に決めず、全部並べる**
 *   (`AppWorkspace.tsx:785` の規約をそのまま持ってきている)。
 * - **行が既に在るかどうかを見ていない。** **二重に作られることを止めていない。**
 * - **閉じたあと、もう一度出す手段を1つも持たない**(`web/src/auth/useAppAuth.ts:66` の
 *   `setJustSignedUpAsCustomer(false);`。**再読み込みすると二度と出ない**)。
 * - **「いま案内を出してよい局面か」に1ミリも答えない。** **それは呼び出し側の関門である**
 *   (`justSignedUpAsCustomer`)。
 */
import type { ReactElement } from "react";
import type { View } from "../../../src/kernel/types.ts";
import { RouteLink } from "../navigation.tsx";
import { Button } from "../ui/button.tsx";
import { Alert } from "../ui/surfaces.tsx";
import { cn } from "../ui/utils.ts";
import { viewDisplayName } from "../views/ViewHost.tsx";

/**
 * **登録の直後の案内**。**候補(`views`)が0本なら1つも描かない。**
 *
 * **戻り値の型は `ReactElement | null` である** —— **`@types/react` 19 では
 * グローバルの `JSX` 名前空間が無く、`JSX.Element` は typecheck を通らない**
 * (`web/src/` に `JSX.Element` の当たりは着手前 0行)。
 */
export function SignupNextNotice({
  appId,
  views,
  onDismiss,
}: {
  appId: string;
  views: readonly View[];
  onDismiss?: (() => void) | undefined;
}): ReactElement | null {
  if (views.length === 0) {
    return null;
  }
  return (
    <Alert className={cn("customer-signup-next", "font-sans")} data-testid="customer-signup-next">
      <p className={cn("m-0", "text-note")}>
        登録が終わりました。<strong>使いはじめる前に、自分の情報を登録してください。</strong>
        下の画面から作れます(<strong>作らなくても登録は消えません</strong>が、
        作るまでは自分の情報はどこにもありません)。
      </p>
      <ul className={cn("flex flex-col gap-s1 m-0")}>
        {views.map((view) => (
          <li key={view.id}>
            <RouteLink to={{ kind: "view", appId, viewId: view.id }}>
              {viewDisplayName(view)}
            </RouteLink>
          </li>
        ))}
      </ul>
      <Button
        size="sm"
        variant="secondary"
        data-testid="customer-signup-next-dismiss"
        onClick={() => onDismiss?.()}
      >
        閉じる
      </Button>
    </Alert>
  );
}
