/**
 * **登録の直後に導く先の候補を選ぶ述語**({@link signupNextFormViews})と、
 * **候補がちょうど1本のときだけ、その画面を1度だけ自動で開く見張り**
 * ({@link useSignupAutoOpen})。`V10-M6-T01a` / `NV-G14`。
 *
 * ## 【なぜ `useAppAuth.ts` の中ではないのか。審査の字面から外れている】
 *
 * **審査が書いた完了条件の字面は「`useAppAuth.ts` の `setAuthenticated` の直後」である。**
 * **本実装はそこから外れている。理由を丸めずに書く** ——
 * **`useAppAuth` には、マニフェストもロールも1バイトも届いていないからである。**
 * `useAppAuth(appId)` が持つのは認証状態(`loading` / `anonymous` / `authenticated`)と
 * その資格情報だけであり、**着手前の実測で `web/src/auth/useAppAuth.ts` には
 * `manifest` の綴りも `role` の綴りも1件も出て来ない**
 * (`LC_ALL=C /usr/bin/grep -n "manifest\|role" web/src/auth/useAppAuth.ts` が0行)。
 * **候補を数えるには `manifest.app.views` / `manifest.app.tables` と実効ロールの両方が要る。**
 * **したがって「認証状態しか持たない層」に置くと、そこへマニフェストを引き込むことになり、
 * 認証の層が表示層の宣言を読む形に変わる。** **本実装はその改造をしていない** ——
 * **既にその両方を持っている `AppWorkspace` の側から呼ぶ。**
 *
 * ## 【`useEffect` から `navigate()` を呼ぶのは、このリポジトリで初めてである】
 *
 * **着手前の実測**(`LC_ALL=C /usr/bin/grep -rn "navigate(" apps/smailtalk/web/src/`):
 * **当たりは16行で、そのうち定義が1本(`navigation.tsx:66`)、doc コメントの中の言及が3本
 * (`views/ViewHost.tsx:157` / `views/flow.ts:40` / `views/FormRenderer.tsx:485`)、
 * 実際の呼び出しは12箇所である。**
 * **その12箇所は今日、1つ残らずイベントハンドラ(`onClick` / 保存・削除の完了時)の中にあり、
 * `useEffect` の中からの呼び出しは0件である**(呼び出し元5ファイルの `useEffect` の
 * 波括弧の深さを機械で数えて確かめた)。
 * **本ファイルが13箇所目で、`useEffect` から呼ぶ最初の1本になる。**
 *
 * **代償を書く**: **イベントハンドラからの遷移は「利用者が押した」ことが起点だが、
 * これは描画の副作用が起点である。** **だから一度きりに縛る**(下の見張り)——
 * **縛らないと、利用者が自分で別の画面へ移ったあとに引き戻す。**
 *
 * ## 【候補が2本以上のときに先頭を選ぶ規約を採っていない】
 *
 * **`AppWorkspace.tsx:785` の逐語**:
 * 「**どれが「会員情報」なのかをレンダラは知らない。** だから1つに決めず、全部出す。」
 * **その判断を1ミリも動かしていない** —— **2本以上あるときは自動で開かず、
 * 今日どおり案内の中に全部並べて、選ぶのは利用者に任せる。**
 * **`resolveDetailViewTarget` の「定義順の先頭で決め切る」規約をここへ持ち込んでいない。**
 *
 * ## 【可視性を迂回していない】
 *
 * **候補の述語は `canUseView` を必ず通す**(下の {@link signupNextFormViews})——
 * **`AppWorkspace.tsx` にあった述語をそのまま移しただけで、1バイトも書き換えていない。**
 * **したがって「その立場が開けない画面」へ自動で飛ぶことはない。**
 * **同時に、これは遮断ではない** —— **遮断はサーバの 403 / 404 であり、
 * 本ファイルは `src/server/` を1バイトも変えていない。**
 *
 * ## 【`src/kernel/` からは型しか引かない】
 *
 * **`scripts/kernel-import-drift.test.ts` が `src/kernel/` からの**値**の import を
 * 両向きに凍結している。** 本ファイルは `import type` だけを使う。
 * **`personalOwnerField`(`src/server/owner-scope.ts`)と `canUseView`(`web/src/auth/authz.tsx`)は
 * その射程外なので、`AppWorkspace.tsx` と同じく値で import している。**
 */
import { useEffect, useRef, useState } from "react";
import type { Manifest, View } from "../../../src/kernel/types.ts";
import { personalOwnerField } from "../../../src/server/owner-scope.ts";
import { fetchRecordPage, isForbidden } from "../api.ts";
import { navigate, useRoute } from "../navigation.tsx";
import { routePath } from "../route.ts";
import {
  canUseView,
  canWriteRole,
  canWriteTableActionRole,
  viewIdForRecordRequest,
} from "./authz.tsx";

/**
 * **登録の直後に導く先の候補**(`V4-M21-T03` / `E-G65` / `D-V4-82` の述語をそのまま移したもの)。
 *
 * **`st_owner` を宣言したテーブル(= 個人ごとに行を持つ表)の `form` ビューのうち、
 * このロールが使えるものを、マニフェストの順序のまま全部返す。**
 *
 * **`justSignedUpAsCustomer`(登録の直後か)はここに入っていない。**
 * **それは呼び出し側の関門である** —— **この関数は「候補は何本か」だけに答え、
 * 「今それを出してよい局面か」には1ミリも答えない。**
 */
export function signupNextFormViews(manifest: Manifest, role: string): View[] {
  return manifest.app.views.filter((view) => {
    if (view.type !== "form") {
      return false;
    }
    const table = manifest.app.tables.find((candidate) => candidate.id === view.table);
    return (
      table !== undefined &&
      personalOwnerField(table) !== undefined &&
      canUseView(role, manifest, view)
    );
  });
}

/**
 * **候補がちょうど1本のときだけ、その画面を1度だけ自動で開く。**
 *
 * - **`justSignedUp` が真、かつ `candidates.length === 1` のときだけ** `navigate()` を呼ぶ。
 * - **一度きり。** `useRef` の見張りを持ち、**2度目は呼ばない** ——
 *   **利用者が自分で別の画面へ移ったあとに引き戻さないためである。**
 * - **依存配列に配列そのものを入れない**(毎レンダー新しい配列になるため)。
 *   **見るのは `candidates.length` と `candidates[0]?.id` の2つだけである。**
 *
 * **【この関数が解かないこと。誇張しない】**
 * - **候補が2本以上のときは何もしない**(先頭を選ぶ規約を採っていない。上の doc)。
 * - **行が既に在るかどうかを見ていない。** **二重に作られることを止めていない**
 *   (`AppWorkspace.tsx` の案内が制定時から持っている限界そのままである)。
 *
 * **【2026-08-22 訂正(`V10-M19-T02` / `FU-G7b` / `ADR-0364`)。すぐ上の2行は1バイトも消していない】**
 * **すぐ上の1点目「行が既に在るかどうかを見ていない」は、**この関数については今日も真である**
 * —— **この関数は行を1件も読まない。** **変わったのは渡ってくる `candidates` のほうで、
 * {@link useSignupNextCandidates} が「見える範囲に行がある候補」を先に落としている。**
 * **2点目「二重に作られることを止めていない」は今日も真である**(保存の口に1バイトも触っていない)。
 * - **開いた先が実際に読めるかを測っていない。** 可否の最終防衛線はサーバ側である。
 */
export function useSignupAutoOpen(appId: string, candidates: View[], justSignedUp: boolean): void {
  const opened = useRef(false);
  const count = candidates.length;
  const firstId = candidates[0]?.id;
  useEffect(() => {
    if (opened.current) {
      return;
    }
    if (!justSignedUp || count !== 1 || firstId === undefined) {
      return;
    }
    opened.current = true;
    navigate({ kind: "view", appId, viewId: firstId });
  }, [appId, count, firstId, justSignedUp]);
}

/**
 * **登録の直後の候補から、見える範囲に行がある候補を落とす**
 * (`V10-M19-T02` / `FU-G7b` / `ADR-0364`)。
 *
 * **`base`(呼び出し側が今日どおり作った候補)の1本ずつについて、その表を
 * `limit: 1` で1回だけ読み、行が1件でも返ってきた候補を落とす。**
 * **落ちた候補は案内にも出ず、自動でも開かない。**
 *
 * ## 【この関数が解かないこと。誇張しない。先に書く】
 *
 * - **二重登録を止めていない。** **止めているのは「登録直後の窓の中で、見える範囲に
 *   行がある候補を出すこと」だけである。** **保存の口には1バイトも触っていない。**
 * - **偽陰性を塞いでいない。** **付与表を併用する表では、行が在ってもサーバの絞り込みで
 *   0件が返りうる**(`ADR-0364` §S3 の 3)。 **そのときこの関門は素通りする。**
 * - **偽陽性を塞いでいない。** **共有行(`st_owner` が `null` / 空文字)は全員に見えるので、
 *   自分の行が1件も無くても候補が落ちる**(同 4)。 **`ADR-0364` §Decision 7 の 2 が
 *   「表示層で『自分の行だけ』に絞る条件を書く」ことを禁じているので、塞がずに記録する。**
 * - **落ちた理由を1文字も出さない**(`ADR-0364` §Decision 4 / `D-V10-24`)——
 *   **「既に登録済みです」のような文面を1つも作っていない。**
 *
 * ## 【`justSignedUp` が偽なら、読取を1回も走らせない】
 *
 * **配る版(`web/src/runner-app.tsx`)の候補は「登録の直後か」を1ミリも見ておらず、
 * ログインしているあいだずっと中身が入る。** **見ずに読むと、登録と関係のない
 * 普段のログインでも毎回読取が走る。** **`ADR-0364` が増やすと言ったのは
 * 「登録のたびに、候補1本につき1往復」だけである。**
 * **したがって偽のときは `base` をそのまま返す**(呼び出し側の既存の関門を1つも消さない)。
 *
 * **【2026-08-22 訂正(`V10-M19-T05` の点検で見つかった)。すぐ上の1行を1バイトも消していない】**
 * **今日の実物は `base` をそのまま返していない。** **偽のときの戻り値は
 * `{ views: [...writable], autoOpenAllowed: false }` である** ——
 * **`V10-M19-T03` が書込の関門(下の `writable`)を足したとき、返す配列を `base` から
 * `writable` に差し替えた。** **したがって「読取を1回も走らせない」は今日も真だが、
 * 「`base` をそのまま返す」は今日は偽である。**
 *
 * **【画面の見え方は1ミリも変わっていない。呼び出し元2つを実際に開いて確かめた】**
 * - **`web/src/AppWorkspace.tsx`**: **偽のときは `base` に `[]` を渡している**
 *   (`justSignedUpAsCustomer ? signupNextFormViews(…) : []`)。**空を絞っても空なので、
 *   `base` を返しても `writable` を返しても、返る本数は0本のままである。**
 * - **`web/src/runner-app.tsx`**: **`base` は局面によらず作るが、偽のときは
 *   この戻り値を捨てている** —— **案内は `auth.justSignedUpAsCustomer ? signupNextForms : []`
 *   で渡し、自動で開くほうは第3引数に `auth.justSignedUpAsCustomer` を AND している。**
 *
 * **どちらの版でも、登録の直後でないときに案内が出ることも、自動で開くことも無い。**
 * **【禁止】これを「関門を1つ消した」と読まない** —— **消していない。返す集合が
 * 狭いほうへ変わっただけであり、狭くなった先は今日どこにも表示されていない。**
 *
 * ## 【読取が失敗したときは落とさない。これは審査も ADR も決めていない】
 *
 * **通信不良・404・500 などで読めなかった候補は落とさない** —— **開いた側に倒す。**
 * **理由**: **一時的な失敗で案内が黙って消えると、登録した人は次に何をすればよいかを
 * 1文字も知らされない。** **`ADR-0364` はこの分岐を1文字も決めていない。**
 * **実装(`V10-M19-T02`)の判断である。**
 * **403 もこの分岐に入る**(`isForbidden` を呼び分けていない)——
 * **403 の扱いそのものは `V10-M19-T03` の担当であり、ここで先取りしていない。**
 *
 * ## 【2026-08-22 追記(`V10-M19-T03` / `FU-G8` / `ADR-0365`)。すぐ上の節を1バイトも消していない】
 *
 * **すぐ上の「403 の扱いそのものは `V10-M19-T03` の担当であり、ここで先取りしていない」は
 * 今日は履行済みである** —— **読取が 403 を返した候補は落ちる。** **それ以外の失敗は
 * 今日どおり落とさない**(上の節の判断を1バイトも動かしていない)。
 *
 * **併せて、書けない候補を読取より前に落とす**(下の同期の関門)。
 *
 * **【射程を広く書かない。今日 403 が返るのは1経路だけである】**
 * **表の一覧は、その立場に読取の規則が1本も無くても 403 を返さない** ——
 * **200 で0件を返す**(`src/server/app.ts` が「一覧は応答から落とし、単件は 404 で伏せる」と
 * 逐語で書いている。**403 にすると「その表が在る」ことが役割の外へ漏れるからである**)。
 * **403 が返るのは `?view=` を名乗ったときだけであり、名乗るかどうかは
 * {@link viewIdForRecordRequest} 1本が決める**(本タスクはその述語を1バイトも変えていない)。
 * **【禁止】これを「読めない候補を落とす」と広く読まない。**
 *
 * **【確かめた時点と開いた時点はずれる】** **1回聞いた直後に役割の規則が変われば、
 * 開いた先は今日どおり 403 になる。** **確かめたのは聞いた時点であって、
 * 遮断は今日どおりサーバの 403 である。**
 * **【禁止】これを「その画面が読めることを保証した」と書かない。**
 * **【禁止】これを「表示層とサーバの判定が揃った」と書かない** ——
 * **表示層が渡すのは役割の文字列1つで、サーバが使うのは実効ロール集合である。**
 *
 * ## 【現在地の見張り。`navigate()` を読み終える前に呼ばない】
 *
 * **`autoOpenAllowed` は「読み終えた時点の現在地が、読み始めた時点と同じか」である**
 * (`ADR-0364` 限定5)。 **読んでいるあいだは偽であり、利用者が自分で別の画面へ
 * 移っていたときも偽になる。** **案内そのものは出す**(消さない)。
 * **この関数は `navigate()` を1度も呼ばない** —— **呼ぶのは {@link useSignupAutoOpen} である。**
 *
 * ## 【`manifest` を `undefined` でも受ける。理由を書く】
 *
 * **設計が固定した引数は `manifest: Manifest` だが、実装では `Manifest | undefined` に広げた。**
 * **配る版は定義を非同期で取っており、取れていない局面では渡せる `Manifest` が1つも無い。**
 * **フックなので早期 return より前で呼ぶ必要があり、呼び出しを飛ばすこともできない。**
 * **偽の `Manifest` を作って渡すより、無いことをそのまま渡すほうが正直である。**
 * **広げただけなので、`Manifest` を渡す側(育成用の版)の字面は1バイトも変わらない。**
 *
 * ## 【`role` は読取の引数に1つも渡らない】
 *
 * **候補集合(`base`)は呼び出し側が `role` から作るので、この関数は `role` を
 * 効果の依存に入れているだけである** —— **立場が変われば読み直す、という意味しか無い。**
 * **可否の判定をここに1つも書いていない**(`ADR-0364` §Decision 3 / 限定6)。
 */
export function useSignupNextCandidates(
  appId: string,
  manifest: Manifest | undefined,
  role: string,
  base: readonly View[],
  justSignedUp: boolean,
): { views: View[]; autoOpenAllowed: boolean } {
  /**
   * **書けない候補を、読取より前に落とす**(`V10-M19-T03` / `FU-G8` / `ADR-0365` §Decision 2)。
   *
   * **述語を1本も新しく作っていない** —— **`web/src/views/FormRenderer.tsx:214` 付近が
   * 今日すでに保存ボタンを先回りして消している2本の `AND` を、同じ引数の形でそのまま呼ぶ。**
   * **書込側の確認に非同期は1ミリも要らない**(2本ともサーバと同じ判定を同期で答える)。
   *
   * **【述語の綴りをここに書かない】** **`src/server/view-action-audience.test.ts` の
   * `(C-4b)` が、壁の述語の綴りが現れるファイルの集合を4ファイルちょうどで固定している** ——
   * **綴りを写すと5ファイル目になって赤くなる。** **`FormRenderer.tsx:200` 付近の doc が
   * まったく同じ理由で同じことを書いている。**
   *
   * **【この関門が答えないこと。誇張しない】**
   * - **壁を通っても書けるとは限らない**(個人スコープ・項目の規則が今日どおり別に効く)。
   *   **遮断は今日もサーバの 403 である。**
   * - **落ちた理由を1文字も出さない**(`ADR-0365` §Decision 3)——
   *   **落ちて0本になれば案内も自動オープンも起きないだけである。**
   * - **定義が取れていない局面(`manifest` が無い)では候補を1本も残さない。**
   *   **今日そこへ来る `base` は必ず空である**(配る版は定義が取れるまで `base` を作らない)。
   */
  const writable = base.filter((view) => {
    if (manifest === undefined) {
      return false;
    }
    const table = manifest.app.tables.find((candidate) => candidate.id === view.table);
    if (table === undefined) {
      return false;
    }
    return canWriteRole(role, table) && canWriteTableActionRole(role, manifest, table.id, "create");
  });

  /**
   * **候補の同一性**。**配列そのものは毎レンダー新しくなるので、依存配列には入れられない**
   * ({@link useSignupAutoOpen} が同じ理由で `length` と先頭の id しか見ていない)。
   *
   * **`role` をこの鍵に混ぜてある** —— **立場が変われば候補集合も変わるので、読み直す。**
   * **`role` を効果の依存配列に直接置くことはできない**(`biome` の
   * `lint/correctness/useExhaustiveDependencies` が「余分な依存」として赤くする。実測)。
   */
  /**
   * **【`V10-M19-T03`】鍵は「書ける候補」から作る** —— **落ちた候補は読取にも入らない。**
   */
  const baseKey =
    writable.length === 0 ? "" : [role, ...writable.map((view) => view.id)].join("\n");
  const baseRef = useRef<readonly View[]>(writable);
  baseRef.current = writable;
  const manifestRef = useRef(manifest);
  manifestRef.current = manifest;
  const route = useRoute();
  const routeRef = useRef(route);
  routeRef.current = route;

  const [settled, setSettled] = useState<{
    key: string;
    keep: readonly string[];
    autoOpenAllowed: boolean;
  } | null>(null);

  useEffect(() => {
    // **読まない条件を先に置く** —— **登録の直後でない / 候補が0本 / 定義が無い。**
    const currentManifest = manifestRef.current;
    if (!justSignedUp || baseKey === "" || currentManifest === undefined) {
      return;
    }
    const candidates = [...baseRef.current];
    const startedAt = routePath(routeRef.current);
    let cancelled = false;
    Promise.all(
      candidates.map(async (view) => {
        const viewParam = viewIdForRecordRequest(currentManifest, view);
        try {
          // **1つの候補につき1回だけ。`limit: 1`。全件を読まない**(`ADR-0364` 限定1)。
          // **`?view=` を名乗るかは既存の述語1本が決める**(限定4)。
          const page = await fetchRecordPage(appId, view.table, {
            limit: 1,
            ...(viewParam === undefined ? {} : { view: viewParam }),
          });
          return page.records.length === 0;
        } catch (error) {
          // **【`V10-M19-T03` / `FU-G8` / `ADR-0365` §Decision 2】403 だけを落とす。**
          // **それ以外の失敗(通信不良・404・500 など)は今日どおり落とさない**
          // —— **`V10-M19-T02` が決めたこの分岐を1バイトも動かしていない。**
          // **判定の式を1文字も書いていない** —— **見るのはサーバが返した応答コードだけである。**
          return !isForbidden(error);
        }
      }),
    ).then((keeps) => {
      if (cancelled) {
        return;
      }
      setSettled({
        key: baseKey,
        keep: candidates.filter((_, index) => keeps[index] === true).map((view) => view.id),
        // **読み終えた時点の現在地が、読み始めた時点と違っていたら自動で開かない**(限定5)。
        autoOpenAllowed: routePath(routeRef.current) === startedAt,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [appId, baseKey, justSignedUp]);

  if (!justSignedUp) {
    return { views: [...writable], autoOpenAllowed: false };
  }
  if (settled === null || settled.key !== baseKey) {
    // **読み終えるまでは候補を1本も出さない** —— **出してから消すと、案内が一瞬だけ
    // 現れて消える。** **`navigate()` もこのあいだは起きない**(`autoOpenAllowed` が偽)。
    return { views: [], autoOpenAllowed: false };
  }
  const keep = new Set(settled.keep);
  return {
    views: writable.filter((view) => keep.has(view.id)),
    autoOpenAllowed: settled.autoOpenAllowed,
  };
}
