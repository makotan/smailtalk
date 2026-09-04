/**
 * コメントの見える相手の合成(`V10-M11-T02` / `CM-G5` / `ADR-0007` §8 台帳 `:1638`)。
 *
 * **公開するのは {@link visibleComments} 1本ちょうどである。**
 *
 * **【`V10-M27-T02`(2026-08-25。`ADR-0375`)。すぐ上の1行を訂正する。
 * 上の行は制定時の記述であり、1バイトも書き換えていない】**
 * **今日の公開は2本である** —— {@link visibleComments} と {@link declaresNoRules}。
 * **2本目は可視集合を1件も作らない述語であり、`HTTP` の口が「未ログインを 401 にするか」を
 * 決めるために読む。** **口の側に同じ条件式を書き写すと、開く条件が2箇所に割れる** ——
 * **割らないために公開した。**
 *
 * ## 採る形(1文で書く)
 *
 * > **コメントが見えるのは、次の `OR` である** —— **(a) そのコメントの宛先が載っている
 * > 画面を読める人**(画面宛ての10形は `{target:"view", view:<宛先の1つ目の部品>}` × `read`)、
 * > **または (b) そのアプリの作りを書き換えられる人**(`{target:"app"}` × `write`)。
 * > **アプリ全体宛てのコメントは (b) だけで決まる。**
 *
 * **判定の家を1軒も増やしていない**(`CM-G5` 限定1)—— 呼ぶのは
 * `judgeRoleAccess`(`owner-scope.ts`)**1本だけ**であり、可否を決める条件式を
 * `src/mcp/` にも `src/kernel/` にも1行も書いていない。
 * **役割の規則の値域も1つも増やしていない**(限定2。`target` 6値 / `can` 3値のまま)。
 * **写し先は2つちょうどである**(限定3)—— **項目・表・ボタン・役割の4つには1件も写さない。**
 * **その4つの綴りをこのファイルは注釈にも書かない** —— 履行を測る式は
 * `LC_ALL=C /usr/bin/grep` でこのファイルを走査するので、逐語を注釈に残すと
 * **1件も写していないのに 0 にならない**(`comment-store.ts` が同じ事故を実測で踏んでいる)。
 * 同じ理由で、**持ち主の絞り込みと行ごとの付与に関わる識別子も1つも書かない。**
 *
 * ## 呼び出し側への縛り(`CM-G5` 限定5)
 *
 * **本関数は可視集合そのものしか返さない。** **件数は `visibleComments(...).length` から
 * 採ること** —— **母集団を割らない**(`src/mcp/tools/read.ts` の `total: visible.length,`
 * と同じ作法)。**返り値に母集団の件数を1つも載せていないのは、呼び出し側が
 * 「見えない相手に n件ある」を漏らせないようにするためである。**
 *
 * ## この合成が見ないもの(**明示する**)
 *
 * - **行ごとの付与(点)を1件も見ない。** **器はアプリの表ではないので、行ごとの
 *   宣言を置ける場所がそもそも無い**(`CM-G5` `S3` の 5)。**「このコメントだけを
 *   この人に」は今日書けない。**
 * - **持ち主による絞り込みを1度も見ない。** 同じ理由である。
 *   **【禁止】「未ログインの行にも持ち主の絞り込みが効く」と書かない。**
 * - **宛先が実在するかを1度も見ない。** 器が見ないのと揃えている(`CM-G1` 限定5)。
 *   **消した画面宛てのコメントも、その画面を読めた役割には今日どおり見える**(後述)。
 *
 * ## 今日の限界(**丸めない。3件**)
 *
 * 1. **名乗りの無い相手には、アプリが何を宣言していても1件も見えない**(下の短絡)。
 *    **未ログインで書いた本人は、自分のコメントを1件も読み返せない。**
 * 2. **その画面を「条件つきでしか読めない」相手には、その画面宛てのコメントが
 *    1件も見えない**(下の {@link holdsUnconditionally})。
 * 3. **アプリの作りを書き換えられる人には、画面の絞りに関係なく全部見える**(`OR` の第2項)。
 *
 * ## 今日の限界の訂正(**`V10-M27-T01c`。2026-08-25。`ADR-0375`**)
 *
 * **上の3行は制定時(`V10-M11-T02`)の記述であり、1バイトも書き換えていない**
 * (`ADR-0007` §6 規律1 と同じ作法)。**今日の正はここに書く。**
 *
 * **上の限界1 は、今日の正ではない。** —— **役割の規則を1本も書いていないアプリでは、
 * 名乗りの無い相手にも全件見える**({@link declaresNoRules} の枝)。
 * **したがって「未ログインで書いた本人は、自分のコメントを1件も読み返せない」も、
 * そのアプリに限っては今日は成り立たない。**
 *
 * **限界1 が今日も成り立つのは、規則を1本でも書いているアプリだけである** ——
 * **`create_app` は持ち主に2行入れるので、今日ふつうに作ったアプリはこちら側に居る。**
 * **当たるのは、役割の宣言を落とした古いアプリと、書き戻していないアプリである。**
 *
 * **限界2 / 限界3 は1ミリも動いていない。**
 *
 * **【禁止】これを「既定を開いた」と書かない** —— **開くのは2つの `AND` を満たすアプリ
 * だけであり、定義が読めないアプリは今日どおり閉じる。**
 */
import type { Comment } from "../kernel/comment-store.ts";
import {
  type ActorRoles,
  judgeRoleAccess,
  manifestRoleDeclarations,
  roleRulesOf,
} from "./owner-scope.ts";

/**
 * **名乗りを1つでも持っているか**(メインの裁定3。**`ADR-0367` 限定2 の機械的な担保**)。
 *
 * **`judgeRoleAccess` は名乗りを1つも持たない相手を `ANONYMOUS_AUDIENCE` という
 * 1語の主体として扱う。** したがって**アプリの作者がその1語に読取を1本書けば、
 * 名乗りの無い相手にコメントが見えてしまう。**
 * **`ADR-0367` 限定2 は「読取を1ミリも開けない」と決めており、これは条件の話ではなく
 * 決定の話である** —— **アプリの作者の書き方1つで決定が破れる形にはしない。**
 *
 * **ここに置いた条件式は `src/server/` の中であり、`CM-G5` 限定1 が閉じている
 * `src/mcp/` / `src/kernel/` のどちらでもない。** **判定の家を2軒目にもしていない** ——
 * **これは「誰に見せるか」の判定ではなく、判定に掛ける前に相手を数える1行である。**
 *
 * **読み方は `owner-scope.ts` の実効ロール集合の正規化と同じである** ——
 * **`null` / `undefined` / 空配列を「1つも持たない」に落とす。**
 */
function hasNamedSubject(roles: ActorRoles | undefined): boolean {
  if (roles === null || roles === undefined) {
    return false;
  }
  return typeof roles === "string" ? true : roles.length > 0;
}

/**
 * **無条件に通るか**(メインの裁定4)。
 *
 * **行を渡さない呼び方では、条件つきの規則は「通しうる」として
 * `allowed: true` / `conditional: true` を返す。** **コメントには対応する行が無いので、
 * この合成は行を永久に渡せない** —— **条件を評価する材料が構造上揃わない。**
 * **したがって条件つきは「見えない」に倒す**(このリポジトリは既定を閉じる向きに
 * 揃えてきた。`V8-M26`)。
 *
 * **【正直に書く】今日の語彙は、画面とアプリ全体の規則に条件を書くことを
 * `schemas/manifest.schema.json` の側で閉じている。** **したがってこの1行は、
 * 語彙の検査を通ったマニフェストでは今日1度も発火しない** —— **守りであって、
 * 実際に起きている絞りではない。** **【禁止】これを「条件つきの相手を実際に閉じている」と
 * 読まない。**
 */
function holdsUnconditionally(decision: { allowed: boolean; conditional: boolean }): boolean {
  return decision.allowed && !decision.conditional;
}

/**
 * **規則を1本も書いていないアプリか**(`V10-M27-T01b` / `ADR-0375`)。
 *
 * **開く条件は2つの `AND` である。片方でも欠けたら今日どおり閉じる。**
 *
 * 1. **定義が読めていること** —— `undefined` / 非オブジェクト / `app` を持たない値は
 *    **偽**(閉じる側)。 **`src/server/app.ts` の口は、読めないアプリで `undefined` を
 *    渡してくる。** **この条件を落とすと、定義が壊れて読めないアプリのコメントが
 *    全件見えてしまう** —— **向こう側の注が名指しで警告している事故そのものである。**
 * 2. **役割の宣言が持つ規則の要素の総数が 0 であること**(`app.roles` そのものが
 *    無い場合を含む)。
 *
 * **数え方は `owner-scope.ts` の2つの述語をそのまま借りる** —— **ここで役割の宣言を
 * 読み直す実装を書かない**(冒頭が禁じている「判定の家の2軒目」になる)。
 * **公開されている `declaredRoleIds` / `declaredRoleKinds` では数えられない** ——
 * **どちらも規則の並びを1度も読まないからである。**
 *
 * **【禁止】「その画面を名指しした規則が無い」を条件にしない**(範囲が広すぎる。
 * 規則を書いているアプリの、名指しから漏れた画面まで開いてしまう)。
 */
export function declaresNoRules(manifest: unknown): boolean {
  if (typeof manifest !== "object" || manifest === null) {
    return false;
  }
  const declared = (manifest as { app?: unknown }).app;
  if (typeof declared !== "object" || declared === null) {
    return false;
  }
  return manifestRoleDeclarations(manifest).every(
    (declaration) => roleRulesOf(declaration).length === 0,
  );
}

/**
 * **その相手に見えるコメントだけを、渡された並びのまま返す。**
 *
 * `judgeRoleAccess` の呼び出しは、**1つの相手についてアプリ全体で1回 + 画面ごとに1回**
 * にまとめる(全行で呼び直さない)。
 *
 * @param manifest 判定に渡すアプリの定義。**この合成は読取のためだけに渡す。**
 * @param roles 相手の実効ロール集合。**未ログインは `null`。**
 * @param comments 器から読み出した行。**この関数は器に1度も触らない。**
 * @returns 見えるコメントだけの新しい配列(入力の並びを保つ)。**件数はこの長さから採る。**
 */
export function visibleComments(params: {
  manifest: unknown;
  roles: ActorRoles;
  comments: readonly Comment[];
}): Comment[] {
  // **【`V10-M27-T01b`(2026-08-25。`ADR-0375`)。ここから3行が追加である】**
  // **規則を1本も書いていないアプリでは、名乗りの有無を問わず全件返す。**
  // **裁定3 の短絡より**前**に置く** —— **未ログインにも開くためである**(後ろに置くと
  // 名乗りの無い相手に届かない)。 **開く条件は {@link declaresNoRules} の2つの `AND` だけで
  // あり、ここに3つ目の条件を書いていない。**
  if (declaresNoRules(params.manifest)) {
    return [...params.comments];
  }

  // **裁定3 の短絡** —— 名乗りが1つも無ければ、アプリが何を宣言していても1件も返さない。
  if (!hasNamedSubject(params.roles)) {
    return [];
  }

  // (b) アプリの作りを書き換えられる人か。**1つの相手について1回だけ問う。**
  const writesApp = holdsUnconditionally(
    judgeRoleAccess({
      manifest: params.manifest,
      roles: params.roles,
      target: { target: "app" },
      verb: "write",
    }),
  );
  if (writesApp) {
    // `OR` の第2項が真なら、宛先を1件も問わずに全部見える。
    return [...params.comments];
  }

  // (a) 宛先の画面を読めるか。**画面ごとに1回だけ問い、同じ画面は問い直さない。**
  const readsView = new Map<string, boolean>();
  const canReadView = (viewId: string): boolean => {
    const cached = readsView.get(viewId);
    if (cached !== undefined) {
      return cached;
    }
    const judged = holdsUnconditionally(
      judgeRoleAccess({
        manifest: params.manifest,
        roles: params.roles,
        target: { target: "view", view: viewId },
        verb: "read",
      }),
    );
    readsView.set(viewId, judged);
    return judged;
  };

  return params.comments.filter((comment) => {
    if (comment.anchorForm === "app") {
      // アプリ全体宛ては (b) だけで決まる。ここに来た時点で (b) は偽である。
      return false;
    }
    // **画面宛ての10形は、宛先の1つ目の部品がすべて画面IDである**(器の登録簿より)。
    const viewId = comment.anchorParts[0];
    // 部品が欠けた行は、閉じる側に落とす(器は空白だけの部品を拒むので今日は起きない)。
    return viewId === undefined ? false : canReadView(viewId);
  });
}
