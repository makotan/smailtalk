/**
 * **マイページ**(`V22-M3-T05`。計画 `docs/plan/v22/00-v22-plan.md` の V22-M3「画面(作業画面と配る版)」)。
 *
 * 根拠: `ADR-0488` §Decision 1 の 6・7(6 は `ADR-0490` §Decision 1 の行3 が引き直した)/ ユーザ決定
 * `D-V22-3`(アカウント情報・自分の記録・作り手が選んだ画面)・`D-V22-6`(上端の「アカウント」を入れ替え、
 * パスワード変更・退会はマイページの中へ)・`D-V22-16`(ログインした全員)・`D-V22-18`(選んだ画面は開くボタン)・
 * `D-V22-19`(10件+もっと見る、新しい順)・`D-V22-24`(一覧画面をすべて隠した役割には出さない)・
 * `D-V22-25`(登録直後の自動オープンが先)。
 *
 * **育成用の版(`web/src/AppWorkspace.tsx`)と配る版(`web/src/runner-app.tsx`)が同じ1本を呼ぶ。**
 *
 * ## 3つの節
 *
 * 1. **アカウント** —— 名前(表示名。無ければログインID)・役割・ログインIDと、既存の `AccountPanel` を
 *    そのまま埋め込む(パスワード変更・退会。`data-testid` を1つも変えていない。閉じるボタンは出さない)。
 * 2. **自分の記録** —— 載せる表は `src/shared/my-page.ts` の `myPageTables` 1本が決める(**ここで判定を
 *    書き足さない**)。 そのうえで、**その表の一覧画面(`list_view`)を `canUseView` で1本も開けない役割には、
 *    その表の節を出さない**(`ADR-0490` §Decision 1 の行3 / `D-V22-24`。`web/src/auth/authz.tsx` は1バイトも
 *    変えていない)。 表ごとに既存の一覧の口を `my_page=1&limit=10&sort=_created_at&order=desc` で読み、
 *    「もっと見る」で次の10件を足す。 **絞っているのはサーバである**(持ち主の列 = 自分。読める範囲は広げない)。
 *    行を押すと、その表を指す詳細画面のうち `canUseView` で開けるものの定義順の先頭を開く
 *    (**探す規約は `navigation.tsx` の `resolveDetailViewTarget` 1本**。候補を開ける画面に狭めた定義を渡すだけで、
 *    2本目の探索を書いていない。 一続きの流れの段は一覧の行と同じく外す)。 開ける画面が無い行は押せない。
 * 3. **選んだ画面** —— `my_page.views` のうち `canUseView` が真のものを、宣言の並びのまま開くボタンとして並べる。
 *    開けない画面は名前も出さない。
 *
 * ## ログイン直後に開く(`open_after_login`)の調停
 *
 * **行き先を決める効果は `web/src/auth/signup-next.ts` の `useSignupAutoOpen` の1本だけである**(第4引数)。
 * ここに置くのは、その引数を組む2つの部品だけ:
 *
 * - {@link useLoginArrival} —— **この画面の中で「未ログイン → ログイン済み」に変わったこと**(= ログインの直後)を
 *   印にする。 既にセッションが在って開いた(`loading → authenticated`)ときは印を作らない。 未ログインのあいだに
 *   画面を指した URL(`/views/…`)に居たら「画面を指した」と覚える(公開の画面を指して開いてからログインした場合を
 *   含む)。 **ログインの後に現在地が1度でも変わったら印を捨てる**(引き戻さない)。
 * - {@link myPageLanding} —— 印が在り、画面を指しておらず、宣言が `open_after_login: true` で、いま
 *   `/apps/<id>`(または `/apps/<id>/login`)に居るときだけ、行き先(マイページ)を返す。
 *
 * **色は導出済みの名前(テーマの役割名)だけで書く。** 色のリテラルを1バイトも書かない。 **`web/src/styles.css` は
 * 0バイト。** クラスは静的な Tailwind の綴りだけ。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RecordRow } from "../../src/kernel/records.ts";
import type { Manifest, Table, View } from "../../src/kernel/types.ts";
import { type MyPageTable, myPageOwnerHidden, myPageTables } from "../../src/shared/my-page.ts";
import { type AuthUser, fetchRecordPage } from "./api.ts";
import { toValidationErrors } from "./async.ts";
import { AccountPanel } from "./auth/AccountPanel.tsx";
import { canUseView, declaredRoleKinds, roleLabel } from "./auth/authz.tsx";
import type { SignupAutoOpenAfterwards } from "./auth/signup-next.ts";
import { ErrorList } from "./ErrorList.tsx";
import { representativeField } from "./fields/reference-label.ts";
import { navigate, RouteLink, resolveDetailViewTarget, useRoute } from "./navigation.tsx";
import { type Route, routePath } from "./route.ts";
import { Button } from "./ui/button.tsx";
import { Card } from "./ui/surfaces.tsx";
import { cn } from "./ui/utils.ts";
import { viewDisplayName } from "./views/ViewHost.tsx";

/** 1つの表について最初に出す件数と、「もっと見る」で足す件数(`D-V22-19`)。 */
export const MY_PAGE_PAGE_SIZE = 10;

/** アプリの定義にマイページの宣言があるか(`my_page` が在る = 置く。`{}` も置く)。 */
export function hasMyPage(manifest: Manifest | undefined): boolean {
  const myPage = manifest?.app?.workspace?.my_page;
  return myPage !== undefined && myPage !== null;
}

// ---------------------------------------------------------------------------
// ログイン直後の印と行き先
// ---------------------------------------------------------------------------

/** ログインの直後であることの印({@link useLoginArrival})。 */
export type LoginArrival = {
  /** ログイン1回ごとに1つ進む。 */
  readonly key: number;
  /** 未ログインのあいだに画面を指した URL に居たか(公開の画面を開いていた場合を含む)。 */
  readonly pointed: boolean;
  /** ログインが成立した時点の現在地(これから変わったら印を捨てる)。 */
  readonly at: string;
};

/**
 * **この画面の中で未ログインからログイン済みに変わったこと**を印にする。
 *
 * `status` は `useAppAuth` の状態。 **既にセッションが在って開いたときは印を作らない**(ログインの直後ではない)。
 */
export function useLoginArrival(status: string): LoginArrival | null {
  const route = useRoute();
  const at = routePath(route);
  const pointedNow = route.kind === "view";
  const [arrival, setArrival] = useState<LoginArrival | null>(null);
  const anonymousRef = useRef(false);
  const pointedRef = useRef(false);
  const keyRef = useRef(0);
  useEffect(() => {
    if (status === "anonymous") {
      anonymousRef.current = true;
      if (pointedNow) {
        pointedRef.current = true;
      }
      return;
    }
    if (status !== "authenticated") {
      return;
    }
    if (anonymousRef.current) {
      anonymousRef.current = false;
      const pointed = pointedRef.current || pointedNow;
      pointedRef.current = false;
      keyRef.current += 1;
      setArrival({ key: keyRef.current, pointed, at });
      return;
    }
    // ログインの後に現在地が変わったら、印を捨てる(自分で移った後に引き戻さない)。
    setArrival((previous) => (previous !== null && previous.at !== at ? null : previous));
  }, [status, at, pointedNow]);
  return arrival;
}

/**
 * **ログイン直後にマイページへ移るなら、その行き先**(`useSignupAutoOpen` の第4引数)。 移らないなら `undefined`。
 *
 * 移るのは次のすべてが成り立つときだけ(`ADR-0488` §Decision 1 の 7 / `D-V22-25`):
 * ログインの直後である / 未ログインのあいだに画面を指していない / 宣言が `open_after_login: true` /
 * いま `/apps/<id>` か `/apps/<id>/login` に居る(マイページそのものでも画面でもない)。
 * `ready` は登録直後の自動オープンの判定が済んだか(`useSignupNextCandidates` の `decided`)。
 */
export function myPageLanding({
  appId,
  manifest,
  arrival,
  route,
  ready,
}: {
  appId: string;
  manifest: Manifest | undefined;
  arrival: LoginArrival | null;
  route: Route;
  ready: boolean;
}): SignupAutoOpenAfterwards | undefined {
  if (arrival === null || arrival.pointed) {
    return undefined;
  }
  if (manifest?.app?.workspace?.my_page?.open_after_login !== true) {
    return undefined;
  }
  if (route.kind !== "app" || route.myPage === true || route.appId !== appId) {
    return undefined;
  }
  return { key: arrival.key, ready, to: { kind: "app", appId, myPage: true } };
}

// ---------------------------------------------------------------------------
// 画面
// ---------------------------------------------------------------------------

export type MyPageProps = {
  readonly appId: string;
  readonly manifest: Manifest;
  readonly user: AuthUser;
  /** 退会に成功したら呼ぶ(ログアウトと同じ経路で未ログインへ戻す)。 */
  readonly onWithdrawn: () => void;
};

export function MyPage({ appId, manifest, user, onWithdrawn }: MyPageProps) {
  const role = user.role;
  /** **その役割が開ける画面だけに狭めた定義**(詳細画面の探索と、選んだ画面の絞り込みに使う)。 */
  const openable = useMemo<Manifest>(
    () => ({
      ...manifest,
      app: {
        ...manifest.app,
        views: manifest.app.views.filter((view) => canUseView(role, manifest, view)),
      },
    }),
    [manifest, role],
  );
  const tables = useMemo(
    () =>
      myPageTables(manifest).filter(
        (entry) =>
          // **`D-V22-24`**: その表の一覧画面を1本も開けない役割には、その表の節を出さない。
          openable.app.views.some(
            (view) => view.type === "list_view" && view.table === entry.table,
          ) &&
          // **【`V22-M3-T08a` 中-2 / `ADR-0493`】持ち主の列がその役割から丸ごと隠れる表も、節ごと出さない**
          // (`D-V22-24` と同じ扱い。サーバは同じ判定で 400 を返すので、読みに行かず、エラー枠も出さない)。
          // **判定は `src/shared/my-page.ts` の `myPageOwnerHidden` 1本**(サーバと同じ1本。ここに書き足さない)。
          !myPageOwnerHidden(manifest, role, entry),
      ),
    [manifest, openable, role],
  );
  const selectedViews = useMemo(() => {
    const ids = manifest.app.workspace?.my_page?.views ?? [];
    return ids
      .map((id) => openable.app.views.find((view) => view.id === id))
      .filter((view): view is View => view !== undefined);
  }, [manifest, openable]);

  return (
    <section data-testid="my-page" className={cn("flex flex-col gap-s4 font-sans text-foreground")}>
      <h3 className={cn("m-0")}>マイページ</h3>
      <Card data-testid="my-page-account" className={cn("flex flex-col gap-s2 p-s4")}>
        <h4 className={cn("m-0")}>アカウント</h4>
        <dl className={cn("m-0 grid grid-cols-[auto_1fr] gap-x-s4 gap-y-s1")}>
          <dt className={cn("text-muted-foreground")}>名前</dt>
          <dd className={cn("m-0")} data-testid="my-page-display-name">
            {user.displayName ?? user.username}
          </dd>
          <dt className={cn("text-muted-foreground")}>役割</dt>
          <dd className={cn("m-0")} data-testid="my-page-role">
            {roleLabel(role, declaredRoleKinds(manifest))}
          </dd>
          <dt className={cn("text-muted-foreground")}>ログインID</dt>
          <dd className={cn("m-0")} data-testid="my-page-login-id">
            {user.username}
          </dd>
        </dl>
      </Card>
      <AccountPanel appId={appId} username={user.username} onWithdrawn={onWithdrawn} />
      <section data-testid="my-page-records" className={cn("flex flex-col gap-s3")}>
        <h4 className={cn("m-0")}>自分の記録</h4>
        {tables.length === 0 ? (
          <p data-testid="my-page-no-tables" className={cn("m-0 text-muted-foreground")}>
            ここに載せる記録はありません。壊れているわけではありません。
          </p>
        ) : (
          tables.map((entry) => (
            <MyRecords
              key={entry.table}
              appId={appId}
              manifest={manifest}
              openable={openable}
              entry={entry}
            />
          ))
        )}
      </section>
      {selectedViews.length > 0 && (
        <section data-testid="my-page-views" className={cn("flex flex-col gap-s2")}>
          <h4 className={cn("m-0")}>よく使う画面</h4>
          <div className={cn("flex flex-wrap gap-s2")}>
            {selectedViews.map((view) => (
              <Button
                key={view.id}
                size="sm"
                variant="secondary"
                data-testid="my-page-open-view"
                onClick={() => navigate({ kind: "view", appId, viewId: view.id })}
              >
                {viewDisplayName(view)}
              </Button>
            ))}
          </div>
        </section>
      )}
    </section>
  );
}

/** 行の見出し(表の代表の文字列の列。空なら `_id`)。 */
function rowLabel(table: Table | undefined, row: RecordRow): string {
  const field = representativeField(table);
  const value = field === undefined ? undefined : row[field.id];
  return typeof value === "string" && value !== "" ? value : row._id;
}

type RecordsState =
  | { status: "loading" }
  | { status: "error"; errors: ReturnType<typeof toValidationErrors> }
  | {
      status: "ready";
      rows: RecordRow[];
      total: number;
      loadingMore: boolean;
      /**
       * 次に読む位置(**サーバから受け取った行の数**。`V22-M3-T08a` 軽-7)。 並べる行は `_id` で重複を除くので
       * `rows.length` と違いうる。 **旧**: 次の位置は `rows.length`(`offset: loaded.length`)だった。
       */
      nextOffset: number;
    };

/** 1つの表の「自分の記録」(10件+もっと見る)。 */
function MyRecords({
  appId,
  manifest,
  openable,
  entry,
}: {
  appId: string;
  manifest: Manifest;
  openable: Manifest;
  entry: MyPageTable;
}) {
  const table = manifest.app.tables.find((candidate) => candidate.id === entry.table);
  const [state, setState] = useState<RecordsState>({ status: "loading" });
  const generation = useRef(0);

  // **【`V22-M4-T03` / `ADR-0494` §Decision 3】先頭の10件を読む1本**(初回の読みと「最新に更新」が呼ぶ)。
  // `generation` を進めるので、読んでいる途中の古い応答(前の読み直し・「もっと見る」の続き)は捨てる。
  // **旧**: この本体は下の `useEffect` の中に直に書いてあり、`setState({ status: "loading" })` を先に呼んでいた
  // (初回だけが読み込み中の表示になる。「最新に更新」は並べた行を残したまま読み直す)。
  const readFirstPage = useCallback(() => {
    const current = ++generation.current;
    fetchRecordPage(appId, entry.table, {
      myPage: true,
      limit: MY_PAGE_PAGE_SIZE,
      sort: { field: "_created_at", order: "desc" },
    }).then(
      (page) => {
        if (current === generation.current) {
          setState({
            status: "ready",
            rows: page.records,
            total: page.total,
            loadingMore: false,
            nextOffset: page.records.length,
          });
        }
      },
      (reason: unknown) => {
        if (current === generation.current) {
          setState({ status: "error", errors: toValidationErrors(reason) });
        }
      },
    );
  }, [appId, entry.table]);

  useEffect(() => {
    setState({ status: "loading" });
    readFirstPage();
  }, [readFirstPage]);

  /**
   * **【`V22-M4-T03`】「最新に更新」**: 先頭から10件を読み直して並べ替える(件数と並び順は変えない。新着の知らせは出さない)。
   * **押せないのは初回読込(`status === "loading"`)の間だけ**(`D-V22-37`)。 続き読みの間も押せ、押すと続き読みの
   * 古い応答を捨てる。 エラーのときも押せる(読み直しで回復する)。 読み直しの間は並べた行を残し、「もっと見る」だけを
   * 押せなくする(読み直しの前の位置から続きを読まないため)。
   */
  function refresh(): void {
    if (state.status === "loading") {
      return;
    }
    if (state.status === "ready") {
      setState({ ...state, loadingMore: true });
    }
    readFirstPage();
  }

  function loadMore(): void {
    if (state.status !== "ready" || state.loadingMore) {
      return;
    }
    const current = generation.current;
    const loaded = state.rows;
    const offset = state.nextOffset;
    setState({ ...state, loadingMore: true });
    fetchRecordPage(appId, entry.table, {
      myPage: true,
      limit: MY_PAGE_PAGE_SIZE,
      offset,
      sort: { field: "_created_at", order: "desc" },
    }).then(
      (page) => {
        if (current === generation.current) {
          // **【`V22-M3-T08a` 軽-7】読んでいるあいだに新しい行が入ると、ページの境目の行がもう一度返る。**
          // 既に並べた `_id` の行は足さない(同じ行を2度並べない)。 **旧**: `rows: [...loaded, ...page.records],`
          const seen = new Set(loaded.map((row) => row._id));
          setState({
            status: "ready",
            rows: [...loaded, ...page.records.filter((row) => !seen.has(row._id))],
            total: page.total,
            loadingMore: false,
            nextOffset: offset + page.records.length,
          });
        }
      },
      (reason: unknown) => {
        if (current === generation.current) {
          setState({ status: "error", errors: toValidationErrors(reason) });
        }
      },
    );
  }

  // **押した行の行き先**: 開ける画面だけに狭めた定義で、既存の探索1本を呼ぶ(一覧の行と同じく流れの段は外す)。
  const detail = resolveDetailViewTarget(openable, entry.table, { skipFlowStepViews: true });

  return (
    <Card
      data-testid={`my-page-table-${entry.table}`}
      data-my-page-table={entry.table}
      className={cn("flex flex-col gap-s2 p-s4")}
    >
      <h5 className={cn("m-0")}>{table?.name ?? entry.table}</h5>
      {/* **【`V22-M4-T03`】表ごとの節に常に1つ**(初回読込の間だけ押せない。`D-V22-37`)。 */}
      <div>
        <Button
          size="sm"
          variant="secondary"
          data-testid="my-page-refresh"
          disabled={state.status === "loading"}
          onClick={refresh}
        >
          最新に更新
        </Button>
      </div>
      {state.status === "loading" && <p className={cn("m-0 text-muted-foreground")}>読み込み中…</p>}
      {state.status === "error" && (
        <div data-testid="my-page-records-error">
          <ErrorList errors={state.errors} />
        </div>
      )}
      {state.status === "ready" && state.rows.length === 0 && (
        <p data-testid="my-page-records-empty" className={cn("m-0 text-muted-foreground")}>
          自分の記録はまだありません。壊れているわけではありません。
        </p>
      )}
      {state.status === "ready" && state.rows.length > 0 && (
        <ul className={cn("m-0 flex flex-col gap-s1 p-0 list-none")}>
          {state.rows.map((row) => (
            <li
              key={row._id}
              data-testid="my-page-row"
              data-openable={String(detail !== undefined)}
            >
              {detail === undefined ? (
                rowLabel(table, row)
              ) : (
                <RouteLink to={{ kind: "view", appId, viewId: detail.id, recordId: row._id }}>
                  {rowLabel(table, row)}
                </RouteLink>
              )}
            </li>
          ))}
        </ul>
      )}
      {state.status === "ready" && state.nextOffset < state.total && (
        <div>
          <Button
            size="sm"
            variant="secondary"
            data-testid="my-page-more"
            disabled={state.loadingMore}
            onClick={loadMore}
          >
            もっと見る
          </Button>
        </div>
      )}
    </Card>
  );
}
