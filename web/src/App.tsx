/**
 * アプリシェル(V0-P3-T03。V3-M3-T01 でアプリ切替を足した)。
 *
 * URL からどの画面かを決めるだけの薄い層。**アプリ固有の知識をひとつも持たない**
 * ことがこのファイルの仕様であり、フィクスチャの別アプリに差し替えても
 * ここは一切変わらない(CP-3 確認方法3・4)。**切替 UI が出すアプリ名は
 * 実行時に `GET /api/apps` から来るものであって、ここに書かれた知識ではない。**
 *
 * **認証はアプリ単位(ADR-0014 改訂 = per-app)**。ここにはグローバルなログイン境界を
 * 置かない —— アプリ一覧(`/`)は認証不要で描画し、認証ゲートは各アプリの作業画面
 * (`AppWorkspace`)の中に閉じている。共通ヘッダにログイン/ログアウト導線も持たない
 * (ログアウトは per-app なので `AppWorkspace` 側に置く)。
 *
 * ## アプリ切替(V3-M3-T01 / F-11' / ユーザ決定 D-M3-5)
 *
 * **どの画面からでも別のアプリへ移れる口を、共通ヘッダに常設する。** アプリ一覧(`/`)へ
 * 戻る往復をしなくてよい、というのが要求(v1 台帳 `docs/plan/v1/00-v1-plan.md:342`
 * 「画面上でアプリを切り替えたい」)の中身である。
 *
 * **足したものは既存の部品の組み合わせだけである** —— `GET /api/apps` / `RouteLink` /
 * URL 空間 `/apps/<app_id>` はすべて v0 からある。**切替対象を宣言する語彙(`app.siblings`
 * のようなもの)を作らない**(作れば門A の再審査が要る。審査記録
 * `docs/plan/v3/records/v3-m3-gate-a-shell.md` §2 S2)。
 *
 * **代償を隠さない**: `GET /api/apps` は認証なしで全アプリの `app_id` / `name` /
 * `created_at` / `status` を返す(`src/server/app.ts` / `src/kernel/meta-store.ts`)。
 * 常設にしたことで、**それが常に全画面の DOM に載る**ようになった。API を叩けば
 * 以前から見えたが、画面に常出しするのは別のことである(v3-m3.md §0-4)。
 *
 * **切替先で未認証なら、そのアプリのログイン画面が出る**(per-app 認証)。押せるのに
 * 入れない導線にしないため、そのことを切替 UI の中で先に書いておく。
 *
 * **シェルの見た目は本ファイルの担当ではない**(D-G6。保留のまま = 決まっていない)。
 * 切替 UI はその判定に1つも依存していない —— `web/src/styles.css` に規則を1つも
 * 足しておらず、既存の `.shell header` / `ul` / `li` / `.meta` の上に素の要素として乗っている。
 */

import { useEffect, useState } from "react";
import { AppListPage } from "./AppListPage.tsx";
import { AppWorkspace } from "./AppWorkspace.tsx";
import { type AppRecord, fetchApps } from "./api.ts";
import { type AsyncState, toValidationErrors } from "./async.ts";
import { ErrorList } from "./ErrorList.tsx";
import { RouteLink, useRoute } from "./navigation.tsx";
import type { Route } from "./route.ts";
import { resolveUiFamily } from "./ui/family.ts";
import { Skeleton } from "./ui/surfaces.tsx";
import { cn } from "./ui/utils.ts";

export function App() {
  const route = useRoute();
  // **見た目の器の系統(`D-V4-59` / `V4-M15-T18`)。マニフェストに1バイトも現れない。**
  // 判定は `web/src/ui/family.ts` の1箇所だけで、ここは結果を DOM に置くだけである。
  // `group/ui` は部品体系の `group-data-[ui-family=…]/ui:` 変種の当たり先になる。
  // **【禁止】これを「AI が部品を選べるようになった」と読まない** —— 選ぶ口は語彙に無い。
  //
  // **【`V4-M19-T04` / `ADR-0118` で1行目の後半が偽になった。旧文は消していない】**
  // **画面ごとの詰まり具合はアプリの宣言に現れるようになった** —— ただし
  // **その宣言が当たるのは画面の作用域(`web/src/views/ViewHost.tsx` の `ViewDensityScope`)
  // であって、ここ(アプリの器)ではない。** **この行は今日と1バイトも変わっていない。**
  // **宣言を書かなかった画面は、今日どおりこのアプリ単位の系統で描かれる。**
  const uiFamily = resolveUiFamily();

  return (
    <main className="shell group/ui" data-ui-family={uiFamily}>
      {/*
       * **【V4-M15-T14】シェルのヘッダに部品体系の書体と間隔を足した。**
       * **`class="shell"` の行は1バイトも変えていない**(器の系統の当たり先である)。
       * **幅への対応(`D-V4-44`)は `sm` 1本だけ** —— 狭い画面では縦に積み、40rem から
       * 横に並べる。**使える断点は `sm` と `lg` の2本だけである**(`ADR-0089` 限定3)。
       */}
      <header className={cn("flex flex-col gap-s2 font-sans sm:flex-row sm:items-baseline")}>
        <RouteLink to={{ kind: "app-list" }}>アプリ一覧</RouteLink>
        <AppSwitcher currentAppId={currentAppId(route)} />
      </header>
      {renderRoute(route)}
    </main>
  );
}

/** いま開いているアプリ(URL から決まる)。アプリ一覧・未知のパスでは無い。 */
function currentAppId(route: Route): string | undefined {
  return route.kind === "app" || route.kind === "view" ? route.appId : undefined;
}

/**
 * 共通ヘッダのアプリ切替(V3-M3-T01)。
 *
 * **畳んである `<details>` にしてある。** 台帳のアプリは数に上限が無く(「組織」という
 * 単位が語彙に無いので束ねようがない)、全画面のヘッダに常時展開すると、アプリが
 * 増えるほどヘッダが伸び続ける。**常設(D-M3-5)は「常に置く」であって「常に開く」では
 * ないと読んだ** —— 開閉は利用者の操作で、置き場は変えていない。
 * **ただしアプリ名は畳んでいても DOM には載っている**(上のコメントの代償はそのまま残る)。
 *
 * 一覧は**そのまま並べる**。どれに入れるか(= どのアプリのセッションを持っているか)は
 * ここでは調べない —— 調べるにはアプリの数だけ `auth/me` を叩くことになり、
 * シェルが per-app 認証の状態を集める層になってしまう。代わりに**入れるかどうかは
 * 押した先で分かる**ことを、下の注記で先に書く。
 */
function AppSwitcher({ currentAppId }: { currentAppId?: string | undefined }) {
  const [state, setState] = useState<AsyncState<AppRecord[]>>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetchApps().then(
      (apps) => {
        if (!cancelled) {
          setState({ status: "ready", value: apps });
        }
      },
      (reason: unknown) => {
        if (!cancelled) {
          setState({ status: "error", errors: toValidationErrors(reason) });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    // **`<details>` のままである** —— **重ねて出すメニューを作っていない**
    // (`ADR-0087` 限定8)。開閉は文書の流れの中で起きる。
    <details data-testid="app-switcher" className={cn("font-sans text-sm")}>
      <summary className={cn("cursor-pointer text-foreground")}>アプリを切り替える</summary>
      {/*
       * **per-app 認証(ADR-0014 改訂)を先に書く。** 切り替えた先で未ログインなら
       * そのアプリのログイン画面が出る —— 押してから初めて分かる、にしない(憲法6)。
       */}
      <p className={cn("meta", "text-note text-muted-foreground")} data-testid="app-switcher-note">
        ログインはアプリごとです。まだログインしていないアプリに切り替えると、そのアプリのログイン画面が出ます。
      </p>
      {renderApps(state, currentAppId)}
    </details>
  );
}

function renderApps(state: AsyncState<AppRecord[]>, currentAppId?: string | undefined) {
  if (state.status === "loading") {
    return (
      // **【V4-M15-T14】読み込み中に骨組みを出す。文言は1文字も変えていない。**
      <div className={cn("flex flex-col gap-s1")}>
        <p className={cn("m-0", "text-note text-muted-foreground")}>読み込み中…</p>
        {["row-1", "row-2"].map((slot) => (
          <Skeleton key={slot} className="h-4 w-full" />
        ))}
      </div>
    );
  }
  if (state.status === "error") {
    // 黙って空の一覧にしない(「アプリが1つも無い」と「一覧を読めなかった」は別である)。
    // **器は `ErrorList` が既に `Alert variant="destructive"` を持つので二重に包まない。**
    return (
      <div data-testid="app-switcher-error">
        <ErrorList errors={state.errors} />
      </div>
    );
  }
  if (state.value.length === 0) {
    return <p className={cn("m-0", "text-muted-foreground")}>アプリがまだありません。</p>;
  }
  return (
    <ul data-testid="app-switcher-list" className={cn("flex flex-col gap-s1")}>
      {state.value.map((app) => (
        // 今開いているアプリにも印を付けて残す(一覧から消すと、どこに居るのかが読めなくなる)。
        //
        // **【V4-M15-T14】いま居る場所に `aria-current="page"` を足した**(着手前 0件)。
        // **当たり先は `data-current` と同じ1箇所だけである** —— 判定を2つに割らないため、
        // 同じ三項演算の中で両方を出す。**`data-current` は1バイトも変えていない。**
        // **属性を置くのが `<li>` なのは、`RouteLink`(`web/src/navigation.tsx`)が
        // `to` と `children` しか受け取らず、本タスクがそのファイルを触らないためである。**
        <li
          key={app.app_id}
          className={cn("flex flex-wrap items-baseline gap-s2")}
          {...(app.app_id === currentAppId
            ? { "data-current": "true", "aria-current": "page" as const }
            : {})}
        >
          <RouteLink to={{ kind: "app", appId: app.app_id }}>{app.name}</RouteLink>
          <span className={cn("meta", "text-note text-muted-foreground")}>{app.app_id}</span>
        </li>
      ))}
    </ul>
  );
}

function renderRoute(route: ReturnType<typeof useRoute>) {
  switch (route.kind) {
    case "app-list":
      return <AppListPage />;
    case "app":
      return <AppWorkspace appId={route.appId} />;
    case "view":
      return (
        <AppWorkspace
          appId={route.appId}
          viewId={route.viewId}
          recordId={route.recordId}
          prefill={route.prefill}
        />
      );
    case "not-found":
      return (
        <ErrorList
          errors={[
            {
              path: "",
              message: `${route.path} に対応する画面はありません。`,
              hint: "アプリ一覧から選び直してください。",
            },
          ]}
        />
      );
  }
}
