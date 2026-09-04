/**
 * **実行専用エントリ**(`V5-M4-T01` / 単位 `R-G8`。門A本審査の判定 = **門外(記録)**。
 * 審査記録は `docs/plan/v5/records/v5-m0.md` §2-8)。
 *
 * ## 何を出さないのか
 *
 * **このエントリは1つのアプリだけを描く。** 出さないものは3種である:
 *
 * 1. **台帳に登録された全アプリの並び**(`web/src/AppListPage.tsx`)
 * 2. **別のアプリへ移る口**(`web/src/App.tsx` の `AppSwitcher`)
 * 3. **運営/育成用のパネル7本**(`web/src/AppWorkspace.tsx` が同居させているもの:
 *    利用者の管理 / 接続まわりの管理 / 逃げ道の管理 / テーマ候補の下見 /
 *    テーマの取り込み / テーマの持ち出し / 要件の定義書)
 *
 * **入っていないことは `web/test/runner-entry-boundary.test.ts` が成果物のバイト列で
 * 検査する**(肯定形だけでは足りない。`01` §4-2 の 2)。
 *
 * ## 【誇張しない】これは「編集できない」ではない
 *
 * **言えるのは「このビルド成果物に入っていない」までである**(`01` §8-1 の禁止1)。
 * **ビルド設定を書き換えれば入る。** **サーバ側の編集系ルートを1バイトも塞いでいない**
 * —— そちらは `R-G1` の担当であり、本エントリは `web/` に閉じている。
 *
 * ## 既存のエントリ(`web/src/main.tsx`)を1バイトも書き換えていない
 *
 * **別のエントリを持つ形である**(`01` §4-1 の `R-G8` 行)。**育成用の画面は今日どおり
 * `web/src/main.tsx` 側にそのまま在る。**
 *
 * ## 部品を複製していない / 複製しているもの(正直に書く)
 *
 * - **複製していない**: `web/src/views/` 以下(`ViewHost` / 3つのレンダラ)は
 *   **1ファイルもコピーしていない。** ログイン画面・権限判定・テーマのスコープ要素・
 *   部品体系(`web/src/ui/`)・アカウントの画面も、**既存の実体をそのまま import している。**
 * - **複製している**: **組み立て方(認証の関門 → 画面の並び → 選んだ画面)は、この
 *   ファイルにもう一度書いてある。** `web/src/AppWorkspace.tsx` と**共有していない。**
 *   **したがって片方を変えても、もう片方は変わらない。** **「追随が容易になった」とは
 *   書かない —— 追随の容易さを測る手段を持っていない**(`01` §8-1 の禁止7)。
 *
 * ## どのアプリを描くかの与え方
 *
 * **ビルド時に、環境変数 `GP_RUNNER_APP_ID` から入る定数で受け取る。** **この画面の中に
 * アプリのIDを1文字も書いていない。** **与えられなかったときは黙って何も出さず終わるので
 * はなく、何が足りないかを画面に書く**(憲法6)。**選ばなかった案(DOM の属性で渡す形
 * を含む)は `docs/plan/v5/records/v5-m4.md` §1 に列挙してある。**
 *
 * ## 【2026-08-21 追記(`V10-M6-T01b`)。上の本文を1バイトも書き換えていない】
 *
 * **上の「このファイルにもう一度書いてある」は、今日は場所が違う。**
 * **組み立ての実体(器・認証の関門・画面の並び・選んだ画面)は
 * `web/src/runner-app.tsx` へ移した。** **本ファイルに残っているのは、
 * 描く先の要素を取ること・どのアプリを描くかを読むこと・1度描くことの3つだけである。**
 * **移した先でも `web/src/AppWorkspace.tsx` と共有していない** —— **複製は1本も減っていない。**
 *
 * **移した理由は検査からの読み込みである。** **本ファイルは読み込まれた瞬間に投げ・読み・
 * 描くので、部品を描き分ける検査が書けなかった**(`web/src/runner-app.tsx` の doc に実測を書いた)。
 *
 * **成果物のバイト列を測る `web/test/runner-entry-boundary.test.ts` の対象は今日も変わらない**
 * —— **あれが読むのはビルド成果物であって、ソースのファイル割りではない。**
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ErrorList } from "./ErrorList.tsx";
import { RunnerShell } from "./runner-app.tsx";

/**
 * **ビルド時に外から入る定数**(`web/vite.config.ts` の `runner` モードの `define`)。
 *
 * **`runner` モード以外ではこの識別子は置き換わらない。** このファイルは
 * `web/runner.html` からしか読み込まれず、その入口は `runner` モードにしか無い。
 */
declare const __GP_RUNNER_APP_ID__: string;

/**
 * **描く対象のアプリを外から受け取る唯一の口**(`V5-M4-T01`)。
 *
 * **ビルド時に環境変数 `GP_RUNNER_APP_ID` から入る**(`V5-M7` がイメージに焼き込む)。
 * **この画面の中にアプリのIDを1文字も書いていない** —— 与えずにビルドすると空になり、
 * 画面は黙って白くならずに「与えられていない」と書く。
 *
 * **アプリを名指しする DOM 属性の形にしていない。** **それは既存の線を越えるからである**
 * —— `docs/adr/0050-view-display-presets.md` 限定5(経路B)は「**アプリ固有のセレクタを
 * 書く手段そのものを作らない**」と定めており、`web/test/preset-boundary.test.ts` の (iv) が
 * `src` / `web/src` / `schemas` にその属性名が**0件**であることを機械で見ている。
 * **2026-08-06 に属性の形で実装したところ、この検査が実際に赤くなった**
 * (経緯は `docs/plan/v5/records/v5-m4.md` §1)。
 */
function readAppId(): string {
  return __GP_RUNNER_APP_ID__.trim();
}

const container = document.getElementById("root");
if (container === null) {
  throw new Error("#root が runner.html にありません。");
}

const appId = readAppId();

createRoot(container).render(
  <StrictMode>
    {appId === "" ? (
      <main className="shell">
        <ErrorList
          errors={[
            {
              path: "GP_RUNNER_APP_ID",
              message: "どのアプリを表示するかが与えられていません。",
              hint: "ビルドするときに環境変数 GP_RUNNER_APP_ID にアプリのIDを入れてください。",
            },
          ]}
        />
      </main>
    ) : (
      <RunnerShell appId={appId} />
    )}
  </StrictMode>,
);
