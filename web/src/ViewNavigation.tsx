/**
 * **画面の一覧(メニュー)と本文の器**(`V22-M2-T04`。計画 `docs/plan/v22/00-v22-plan.md` の V22-M2「画面(web)」の 1)。
 *
 * **3か所の写しを1本に抜き出した**: 育成用の版のログイン中の画面(`web/src/AppWorkspace.tsx` の
 * `AuthenticatedWorkspace`)/ 同 未ログインの画面(`AnonymousWorkspace`)/ 配る版(`web/src/runner-app.tsx` の `Body`)。
 *
 * **「左」のときの DOM は抜き出す前と1バイトも変えていない**(`view-list` / `workspace-main` / `view-list-empty` /
 * `aria-current`。固定は `web/test/view-navigation-side-dom.test.tsx`)。 **3か所で違っていたもの**は呼び手が渡す:
 *
 * - **項目の中身**(`label`)—— 育成用の版は画面の種別を添える / 配る版は名前だけ。
 * - **空のときの表し方**(`empty`)—— 育成用の版のログイン中は `EmptyViewList`(`data-reason` の2通り)/
 *   配る版は1文 / 育成用の版の未ログインは出さない(開いた画面が必ず1枚あるため)。
 * - **本文**(`children`)。
 *
 * **CSS を1行も足していない** —— 器(`.workspace-body` / `.view-list` / `.workspace-main`)は `web/src/styles.css` の
 * 既存の規則をそのまま使う。 **並べ替えもしない**(受け取った `views` の並びのまま。`ADR-0008` 限定2)。
 *
 * **この部品は役割も可否も知らない** —— どの画面を並べるかは呼び手が決めて `views` に渡す。
 *
 * ## 【`V22-M2-T05`】上に置く(`ADR-0486` §Decision 1 の 6・11 / ユーザ決定 `D-V22-9`〜`D-V22-12`)
 *
 * - **位置はアプリの定義 `app.workspace.navigation` から1本の関数で決める**(下の `resolveNavigationPlacement`)。
 *   呼び手は役割(ログインした人は `user.role`、未ログインは `null`)を渡して呼び、結果を `placement` に渡す。
 *   **この関数は製品にちょうど1本である**(`ADR-0486` 限定14。数える検査は `web/test/workspace-navigation.test.tsx`)。
 * - **上のとき**: メニューを本文の上に置き、器に `data-navigation-placement="top"` を付ける。 **本文は外枠(`.shell`
 *   の 60rem)の幅いっぱいに広がる**(`D-V22-12`。外枠を超えない)。 **クラスは下の対応表 `TOP_CLASSES` から選ぶ
 *   静的な Tailwind の綴りだけで書く**(定義の値からクラス名を組み立てない)。 **`web/src/styles.css` は0バイト。**
 * - **折りたたみ**(`D-V22-11`): ① **40rem(`sm`)未満では常に「≡ メニュー」**(`sm:` の組で書く。断点は2本のまま。
 *   `@media` も `@container` も書かない)/ ② **40rem 以上では `ResizeObserver` で一覧の `scrollWidth` と
 *   `clientWidth` を比べ、はみ出したら「≡ メニュー」**(判定は純関数 `shouldCollapseTopNav`)。 畳んでいる間は一覧が
 *   見えず幅を測れないので、**最後に測った「要る幅」を覚えておき、メニューの器の幅と比べて戻す。** 画面の並びが
 *   変わったら覚えた幅を捨てて測り直す。 ③ 「≡ メニュー」は既存の器 `OverlayMenu`(`web/src/ui/overlay.tsx`。
 *   `ADR-0094`。器は3つのまま)で開き、**出し先をテーマの器(`.app-theme`)の内側にする**(テーマの色と暗い側の組
 *   `slots_dark` が当たる。`.shell` に漏れない)。 選ぶと `navigate` で移る。 Escape で閉じ、フォーカスは ≡ のボタンに
 *   戻る(器の既定)。 **開いたまま画面が変わったら閉じる**(画面ごとに器を作り直す)。
 * - **【代償。隠さない】** 浮かせた一覧は読み上げで「メニューの項目」として読まれる(左の列のときは「ナビゲーションの
 *   中のリンク」)。 ユーザはこの代償を聞いたうえで選んだ(`D-V22-11`)。
 * - **色は導出済みの名前だけで書く**(ボタンは部品体系の `buttonVariants`、浮かせた一覧は器の既定)。 色のリテラルを
 *   1バイトも書かない。
 *
 * ## 【`V22-M3-T05`】先頭の「マイページ」(`ADR-0488` §Decision 1 の 6 / ユーザ決定 `D-V22-20`)
 *
 * - **呼び手が `myPage` を渡したときだけ**、一覧の先頭(左・上の横一列・「≡ メニュー」のどれでも)に「マイページ」を
 *   1項目出す。 マイページを開いているときはその項目に `aria-current="page"` を付ける。
 * - **渡さなければ DOM は1バイトも変わらない**(マイページの無いアプリ。`ADR-0488` 限定14)。
 * - **「マイページ」は画面(`view`)ではない** —— 画面の掲載の判定(`canUseView` / `menu_listed`)にも並び
 *   (`ADR-0008` 限定2)にも触らない。 出すかどうかは呼び手が「宣言がある」AND「ログインしている」で決める。
 */
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Manifest, View } from "../../src/kernel/types.ts";
import { navigate, RouteLink } from "./navigation.tsx";
import { buttonVariants } from "./ui/button.tsx";
import { OverlayMenu } from "./ui/overlay.tsx";
import { cn } from "./ui/utils.ts";

/** メニューの位置(`ADR-0486` 限定8 の2値)。 */
export type NavigationPlacement = "side" | "top";

/** アプリの定義の `workspace`(カーネルは型を export しないので、アプリの型から引く。`ADR-0486` §Decision 1 の 12)。 */
type WorkspaceDeclaration = Manifest["app"]["workspace"];

/** 知らない値は左に倒す(`ADR-0486` §Decision 1 の 6)。 */
function toPlacement(value: unknown): NavigationPlacement {
  return value === "top" ? "top" : "side";
}

/**
 * **メニューの位置を決める唯一の関数**(`V22-M2-T05`。`ADR-0486` §Decision 1 の 6 / 限定14)。
 *
 * - 役割(`role`)に `by_role` の行があれば、その位置(**役割の上書き**。`D-V22-9`)。
 * - 無ければアプリの既定 `navigation.placement`。 **未ログイン(`role` が `null`)は常にアプリの既定**(`D-V22-10`)。
 * - 宣言が無い・位置を書いていない・知らない値 → 左(`"side"`)。
 *
 * **判定ではない** —— どの画面を開けるかには1ミリも効かない(見せ方だけ)。
 */
export function resolveNavigationPlacement(
  workspace: WorkspaceDeclaration | null | undefined,
  role: string | null,
): NavigationPlacement {
  const navigation = workspace?.navigation;
  if (role !== null) {
    const override = navigation?.by_role?.find((entry) => entry.role === role);
    if (override !== undefined) {
      return toPlacement(override.placement);
    }
  }
  return toPlacement(navigation?.placement);
}

/**
 * **上に置いた一覧を「≡ メニュー」に畳むか**(`V22-M2-T05`。`D-V22-11` の ②)。
 *
 * `available` = 一覧に使える幅 / `required` = 項目を横一列に並べるのに要る幅(どちらも px)。
 * **要る幅が使える幅を超えたら畳む。** どちらかが0(まだ測れていない・隠れている)なら畳まない。
 */
export function shouldCollapseTopNav({
  available,
  required,
}: {
  readonly available: number;
  readonly required: number;
}): boolean {
  if (available <= 0 || required <= 0) {
    return false;
  }
  return required > available;
}

/**
 * **上に置いたときのクラスの対応表**(静的な綴りだけ。定義の値から組み立てない)。
 * Tailwind はソースの字面からクラスを拾うので、ここに書いた綴りだけがビルドに入る。
 */
const TOP_CLASSES = {
  /** 器。 メニュー → 本文の縦積み。 本文は外枠の幅いっぱい。 */
  frame: "flex flex-col gap-s4",
  /** ≡ の器(畳んでいない): 40rem 未満だけ出す。 */
  menuNarrowOnly: "flex sm:hidden",
  /** ≡ の器(畳んだ): 幅を問わず出す。 */
  menuAlways: "flex",
  /** 一覧(畳んでいない): 40rem 以上で横一列。 はみ出しを測るため折り返さない。 */
  listWide: "hidden sm:flex flex-row flex-nowrap items-baseline gap-s4 overflow-hidden",
  /** 一覧(畳んだ): 幅を問わず隠す。 */
  listHidden: "hidden",
  /** 一覧の項目。 */
  item: "flex shrink-0 items-baseline gap-s1 whitespace-nowrap",
} as const;

/** ≡ のボタンの見た目(部品体系の小さいボタン。色は導出済みの名前だけ)。 */
const TOGGLE_CLASS = buttonVariants({ size: "sm" });

export type ViewNavigationProps = {
  readonly appId: string;
  /** 並べる画面(呼び手が絞った結果。並びのまま出す)。 */
  readonly views: readonly View[];
  /** いま開いている画面。一致する1件の `<li>` に `aria-current="page"` を付ける。 */
  readonly viewId?: string | undefined;
  /** 項目の中身(リンクの中に置く)。 */
  readonly label: (view: View) => ReactNode;
  /**
   * 並べる画面が0件のときに一覧の先頭に出すもの。省略すると何も出さない。
   * **【`V22-M4-T02`】`myPage` を渡されたときは出さない**(メニューに「マイページ」だけが並ぶ)。
   */
  readonly empty?: ReactNode;
  /** 本文(`workspace-main` の中身)。 */
  readonly children?: ReactNode;
  /**
   * **【`V22-M2-T05`】メニューの位置**(呼び手が `resolveNavigationPlacement` で決めて渡す)。
   * 省略すると左(抜き出す前と同じ DOM)。
   */
  readonly placement?: NavigationPlacement | undefined;
  /**
   * **【`V22-M3-T05`】先頭に「マイページ」を出す**(`current` = いまマイページを開いているか)。
   * 省略すると出さない(抜き出す前と同じ DOM)。
   */
  readonly myPage?: { readonly current: boolean } | undefined;
  /**
   * **【`V23-M5-T06`】「マイページ」の次に「招待」を出す**(`label` = `workspace.invitations.label`、`current` = いま受け取り画面を
   * 開いているか。`D-V23-129`)。 省略すると出さない(招待を宣言しないアプリの DOM は1バイトも変えない)。
   */
  readonly invitations?: { readonly label: string; readonly current: boolean } | undefined;
};

/** 先頭の「マイページ」の文言(左・上・「≡ メニュー」で同じ)。 */
const MY_PAGE_LABEL = "マイページ";

export function ViewNavigation({
  appId,
  views,
  viewId,
  label,
  empty,
  children,
  placement = "side",
  myPage,
  invitations,
}: ViewNavigationProps) {
  if (placement === "top") {
    return (
      <TopViewNavigation
        appId={appId}
        views={views}
        viewId={viewId}
        label={label}
        empty={empty}
        myPage={myPage}
        invitations={invitations}
      >
        {children}
      </TopViewNavigation>
    );
  }
  return (
    <div className="workspace-body">
      <nav className="view-list" data-testid="view-list">
        {/* **【`V22-M4-T02` / `ADR-0494` §Decision 2】旧の逐語**: `{views.length === 0 && empty}` ——
            マイページを渡されたときは空の文を出さず、マイページだけにする(役割0枚・アプリ0枚の両方。`D-V22-40`)。
            **渡されないときの DOM は1バイトも変えない。** */}
        {/* **【`V23-M5-T06` / `ADR-0532` §Decision 1-8(`ADR-0501` が `ADR-0494` §Decision 2 を引き直した)】旧の逐語**:
            `{views.length === 0 && myPage === undefined && empty}` —— 招待の画面だけがある人にも空の文を出さない。 */}
        {views.length === 0 && myPage === undefined && invitations === undefined && empty}
        <ul className={cn("flex flex-col gap-s1")}>
          {/* **【`V22-M3-T05`】先頭の「マイページ」。 渡されなければ何も描かない。** */}
          {myPage !== undefined && (
            <li
              className={cn("flex flex-wrap items-baseline gap-s1")}
              data-testid="view-list-my-page"
              {...(myPage.current ? { "aria-current": "page" as const } : {})}
            >
              <RouteLink to={{ kind: "app", appId, myPage: true }}>{MY_PAGE_LABEL}</RouteLink>
            </li>
          )}
          {/* **【`V23-M5-T06`】「招待」。 渡されなければ何も描かない。** */}
          {invitations !== undefined && (
            <li
              className={cn("flex flex-wrap items-baseline gap-s1")}
              data-testid="view-list-invitations"
              {...(invitations.current ? { "aria-current": "page" as const } : {})}
            >
              <RouteLink to={{ kind: "app", appId, invitations: true }}>
                {invitations.label}
              </RouteLink>
            </li>
          )}
          {views.map((view) => (
            // **【V4-M15-T14】いま開いている画面に `aria-current="page"` を付ける。**
            // **属性を `<li>` に置くのは、`RouteLink` が `to` と `children` しか受け取らないためである。**
            <li
              key={view.id}
              className={cn("flex flex-wrap items-baseline gap-s1")}
              {...(view.id === viewId ? { "aria-current": "page" as const } : {})}
            >
              <RouteLink to={{ kind: "view", appId, viewId: view.id }}>{label(view)}</RouteLink>
            </li>
          ))}
        </ul>
      </nav>
      <div className="workspace-main" data-testid="workspace-main">
        {children}
      </div>
    </div>
  );
}

/**
 * **上に置いたメニュー**(`V22-M2-T05`)。 **左のときは描かない**(測る仕組みも作らない)。
 */
function TopViewNavigation({
  appId,
  views,
  viewId,
  label,
  empty,
  children,
  myPage,
  invitations,
}: Omit<ViewNavigationProps, "placement">) {
  const navRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  /** 最後に測った「項目を横一列に並べるのに要る幅」(畳んでいる間に戻すかを決めるため)。 */
  const requiredRef = useRef(0);
  const [collapsed, setCollapsed] = useState(false);
  /** 浮かせた一覧の出し先(テーマの器 `.app-theme`)。 */
  const [themeRoot, setThemeRoot] = useState<HTMLElement | null>(null);
  /** 画面の並びの印(変わったら測り直す)。 */
  const viewsKey = views.map((view) => view.id).join("\u0000");

  const measure = useCallback(() => {
    const nav = navRef.current;
    const list = listRef.current;
    if (nav === null || list === null) {
      return;
    }
    if (list.clientWidth > 0) {
      // 一覧が見えている(40rem 以上で畳んでいない): 一覧そのものの幅で比べ、要る幅を覚える。
      requiredRef.current = list.scrollWidth;
      setCollapsed(
        shouldCollapseTopNav({ available: list.clientWidth, required: list.scrollWidth }),
      );
      return;
    }
    if (requiredRef.current > 0) {
      // 畳んでいる: 覚えた要る幅と、メニューの器の幅で比べる。
      setCollapsed(
        shouldCollapseTopNav({ available: nav.clientWidth, required: requiredRef.current }),
      );
    }
  }, []);

  // 画面の並びが変わったら、覚えた幅を捨て、一覧を出して測り直す。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 並びの印が変わったときだけ走らせる
  useLayoutEffect(() => {
    requiredRef.current = 0;
    setCollapsed(false);
  }, [viewsKey]);

  useLayoutEffect(() => {
    setThemeRoot(navRef.current?.closest<HTMLElement>(".app-theme") ?? null);
  }, []);

  // 描いた直後(畳んだ・戻した・並びが変わった)に測る。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 畳みの状態と並びが変わるたびに測り直す
  useLayoutEffect(() => {
    measure();
  }, [measure, collapsed, viewsKey]);

  // 幅が変わったら測る(40rem を跨ぐ・窓の幅を変える)。
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") {
      return undefined;
    }
    const nav = navRef.current;
    if (nav === null) {
      return undefined;
    }
    const observer = new ResizeObserver(() => measure());
    observer.observe(nav);
    return () => observer.disconnect();
  }, [measure]);

  return (
    <div className={TOP_CLASSES.frame} data-navigation-placement="top">
      <nav className="view-list" data-testid="view-list" ref={navRef}>
        {/* **【`V22-M4-T02` / `ADR-0494` §Decision 2】旧の逐語**: `{views.length === 0 && empty}` —— 左と同じ。 */}
        {/* **【`V23-M5-T06` / `ADR-0532` §Decision 1-8(`ADR-0501` が `ADR-0494` §Decision 2 を引き直した)】旧の逐語**:
            `{views.length === 0 && myPage === undefined && empty}` —— 招待の画面だけがある人にも空の文を出さない。 */}
        {views.length === 0 && myPage === undefined && invitations === undefined && empty}
        {/* **【`V22-M3-T05`】旧の逐語**: `{views.length > 0 && (` —— 先頭の「マイページ」だけでも ≡ を出す。 */}
        {/* **【`V23-M5-T06`】旧の逐語**: `{(views.length > 0 || myPage !== undefined) && (` —— 「招待」だけでも ≡ を出す。 */}
        {(views.length > 0 || myPage !== undefined || invitations !== undefined) && (
          <div
            className={collapsed ? TOP_CLASSES.menuAlways : TOP_CLASSES.menuNarrowOnly}
            data-testid="view-menu"
          >
            <OverlayMenu
              // **画面が変わったら器を作り直す**(開いたままなら閉じる)。
              key={viewId ?? ""}
              container={themeRoot}
              triggerClassName={TOGGLE_CLASS}
              triggerTestId="view-menu-toggle"
              trigger={
                <>
                  <span aria-hidden="true">≡</span>メニュー
                </>
              }
              // **【`V22-M3-T05`】旧の逐語**: `items={views.map((view) => ({` —— 先頭に「マイページ」を足す(渡されたときだけ)。
              items={[
                ...(myPage === undefined
                  ? []
                  : [
                      {
                        label: MY_PAGE_LABEL,
                        onSelect: () => navigate({ kind: "app", appId, myPage: true }),
                        "aria-current": myPage.current ? ("page" as const) : undefined,
                        "data-testid": "view-menu-my-page",
                      },
                    ]),
                // **【`V23-M5-T06`】「招待」(渡されたときだけ)。**
                ...(invitations === undefined
                  ? []
                  : [
                      {
                        label: invitations.label,
                        onSelect: () => navigate({ kind: "app", appId, invitations: true }),
                        "aria-current": invitations.current ? ("page" as const) : undefined,
                        "data-testid": "view-menu-invitations",
                      },
                    ]),
                ...views.map((view) => ({
                  label: label(view),
                  onSelect: () => navigate({ kind: "view", appId, viewId: view.id }),
                  "aria-current": view.id === viewId ? ("page" as const) : undefined,
                  "data-testid": "view-menu-item",
                })),
              ]}
            />
          </div>
        )}
        <ul
          ref={listRef}
          className={collapsed ? TOP_CLASSES.listHidden : TOP_CLASSES.listWide}
          data-testid="view-list-items"
        >
          {myPage !== undefined && (
            <li
              className={TOP_CLASSES.item}
              data-testid="view-list-my-page"
              {...(myPage.current ? { "aria-current": "page" as const } : {})}
            >
              <RouteLink to={{ kind: "app", appId, myPage: true }}>{MY_PAGE_LABEL}</RouteLink>
            </li>
          )}
          {invitations !== undefined && (
            <li
              className={TOP_CLASSES.item}
              data-testid="view-list-invitations"
              {...(invitations.current ? { "aria-current": "page" as const } : {})}
            >
              <RouteLink to={{ kind: "app", appId, invitations: true }}>
                {invitations.label}
              </RouteLink>
            </li>
          )}
          {views.map((view) => (
            <li
              key={view.id}
              className={TOP_CLASSES.item}
              {...(view.id === viewId ? { "aria-current": "page" as const } : {})}
            >
              <RouteLink to={{ kind: "view", appId, viewId: view.id }}>{label(view)}</RouteLink>
            </li>
          ))}
        </ul>
      </nav>
      <div className="workspace-main" data-testid="workspace-main">
        {children}
      </div>
    </div>
  );
}
