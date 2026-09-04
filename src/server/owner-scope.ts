/**
 * 個人スコープ(owner)の判定 —— 純粋関数だけ(V1-M3-T04 / ADR-0016)。
 *
 * 「個人所有テーブル」= `st_owner` という id を持ち、その型が **text かつ required でない**
 * フィールドを持つテーブル、という規約(ADR-0016)を1箇所で表す。サーバ(`app.ts`)は
 * このテーブルにだけ owner スタンプ(作成時に actor.id を書く)と可視性フィルタを掛ける。
 * ここには SQL も HTTP も無い ―― 判定は入力(Table / 値 / actor id)だけで決まる。
 *
 * **可視性は post-filter である**(全件を取得したあとサーバ側で除外する)。カーネルの
 * `FilterCondition` は「等値の AND」しか表せず、「own(st_owner=自分) **OR** shared
 * (st_owner が null)」を1本の条件として DB に投げられないためである。したがって現状は
 * 全件をメモリに載せてから絞る。**M9-T01 でページングを入れるときは、この post-filter を
 * DB 側(WHERE st_owner = ? OR st_owner IS NULL)で解き直す必要がある** ―― さもないと
 * 「1ページぶん取ってから除外」で1ページの件数が狂う。
 */
// **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a` / `T-G12`】旧(逐語)**:
//     import { DEFAULT_USER_KIND, isReservedRole, type Role } from "../auth/types.ts";
// **`DEFAULT_USER_KIND` は `effectiveUserKindIds` が、`isReservedRole` は
// `declaredUserKinds` が使っていた唯一の呼び出し側であり、2本とも本波で消えた。**
// **どちらの定数・述語そのものも `src/auth/types.ts` に今日も在る**(1バイトも触っていない)
// —— **消えたのはこのファイルからの参照だけである。**
import type { Role } from "../auth/types.ts";
import type { Field, Manifest, Table, ValidationError } from "../kernel/index.ts";
// **【`V8-M17` / `J-G10`】面の動詞の綴りは語彙の側(`src/kernel/types.ts`)の型をそのまま読む**
// —— **サーバ層に3語を書き写すと、値域が2箇所に住んで黙ってずれる。**
// **`import type` なので層またぎの**値**の import は1件も増えていない**
// (`scripts/kernel-import-snapshot.txt` の逐語「**import type は含まない**」)。
import type { RoleRuleVerb } from "../kernel/types.ts";
// **【`D-V8-69`】システムが持つ表の全量は `src/shared/system-tables.ts` が単一の出どころである。**
// **綴りをこのファイルへ書き写さない** —— 書き写すと、表が増えた日に片方だけ古くなる。
// **`src/shared/system-tables.ts` の依存は `src/kernel/types.ts` の**型のみ**なので、
// この値の import で `bun:sqlite` は1バイトも引き込まれない**(同ファイル冒頭の逐語)。
// **`src/kernel/` から値を1つも import していない**という本ファイルの性質も1ミリも変わらない。
import { isSystemTableId } from "../shared/system-tables.ts";

// --- アプリが宣言した「利用者の種類」を読む(`G-G5` / `V5-M17-T03` / `ADR-0158`)-------
//
// **宣言は `schemas/manifest.schema.json` の `$defs/app.user_kinds` に在る。**
// **`Manifest` 型はカーネルにあり、`ADR-0158` 限定6 が `src/kernel/` に1バイトの差分も
// 許さない**ので、**型に `user_kinds` を足せない。****ここは型の外側から `unknown` として
// 読む** —— **`viewAudience` が `View` を `unknown` として読むのと同じ形であり、限定6 の
// 帰結であって手抜きではない。**
//
// **読む場所を1箇所に閉じる**(`nonAdminTableAccess` / `isViewAudienceAllowed` と同じ作法)。
// **サーバも表示層も、宣言を自分で解釈しない。**

/**
 * アプリが宣言した利用者の種類1件。
 *
 * **【2026-08-11。`V8-M29` 第2波】** **この型だけは残した。** **今日の唯一の作り手は
 * {@link declaredRoleKinds}(`app.roles[]` のうち `name` を持つもの)であり、
 * `app.user_kinds` を読む実装は1つも残っていない。** **型名は `V5-M17` 当時の綴りの
 * ままである** —— **改名すると `web/src/auth/authz.tsx` の re-export を含む呼び出し側が
 * 一斉に動くので、本波は名前を1文字も変えていない。**
 */
export type UserKind = { id: string; name: string };

/**
 * **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a` / `T-G12`。判定値 = 廃止】**
 *
 * **ここに在った `declaredUserKinds`(マニフェストの `app.user_kinds` を読む唯一の実装)と
 * `effectiveUserKindIds`(宣言が無ければ `["customer"]` に倒す)を取り除いた。**
 * **`schemas/manifest.schema.json` の `$defs/app/properties/user_kinds` を同じ差分で
 * 消したので、読む先が無くなったためである。**
 *
 * **代わりに立つのは下の `declaredRoleIds` / `declaredRoleKinds` である**
 * (`ADR-0301` 限定2)—— **読む場所を1箇所に閉じる作法・形が壊れている要素を落とす作法
 * (述語が例外を投げると読取経路が 500 になる)まで同型である。**
 *
 * **【担い手が無いもの (同 限定6 の ④)】** **「宣言によって `customer` を値域から外す」
 * 機能。** **着手前は `user_kinds` を宣言すると `effectiveUserKindIds` の戻りから
 * `customer` が外れ、人に付けられる値からも登録で名乗れる値からも消えた。**
 * **今日は外す手段が1つも無い** —— **`app.roles` は既定に足すことしかできない**
 * (`J-G2` の限定「アプリの作者は既定に足すことしかできず、引き算を1つも書けない」)。
 */

// --- アプリが宣言した「役割」の識別子と表示名を読む(`V8-M29` 第1波 / 台帳 `T-G10`)-----
//
// **上の2本(`declaredUserKinds` / `effectiveUserKindIds`)を1バイトも書き換えていない。**
// **撤去は次の波である** —— **この波は「代わりを先に立てる」だけであり、
// `user_kinds` の出所は今日どおり残る。**
//
// **【2026-08-11 追記。`V8-M29` 第2波。上の3行は第1波の逐語であり、1バイトも消していない】**
// **上の2本は今日このファイルに1本も無い**(第2波が取り除いた)。**下の2本だけが残る。**
//
// **読む場所を1箇所に閉じる作法は上と同じである** —— **`src/server/auth-routes.ts` は
// マニフェストを1度も読まない**(値だけを注入で受け取る)。
// **形が壊れている要素は落とす**(述語が例外を投げると認証経路が 500 になる)。

/**
 * **マニフェストに書かれた役割の識別子の一覧。書かれていなければ空配列。**
 *
 * **並びは宣言の順そのままである** —— **`src/kernel/create-app.ts` が生む新規アプリでは
 * `owner` / `editor` / `viewer` の順であり、アプリが足した役割はその後ろに並ぶ。**
 * **【この並びは「登録で名乗れる値」の既定(1本目)に効く】** —— **予約4語を落とすのは
 * 呼び出し側(`signupKindValues`)の仕事であり、本関数は1語も落とさない**
 * (`anonymous` も `owner` もそのまま返る)。
 */
export function declaredRoleIds(manifest: unknown): readonly string[] {
  return manifestRoleDeclarations(manifest)
    .map((declaration) => declaration.id)
    .filter((id): id is string => typeof id === "string");
}

/**
 * **表示名を持つ役割だけを `{ id, name }` で返す**(`V8-M29` / ユーザ決定 `D-V8-79`)。
 *
 * **`roles[].name` は今日も任意である**(`schemas/manifest.schema.json` の
 * `items.required` は `["id"]` だけ。**この波は `schemas/` を1バイトも触らない**)。
 * **書かなかった役割はここに載らない** —— **載らない役割は、画面に識別子がそのまま出る**
 * (`web/src/auth/authz.tsx` の `roleLabel` の `?? role`)。
 * **`D-V8-79` の説明文の逐語**:「**表示名を書かなければ、利用者管理の画面に英字の識別子
 * (reception など)がそのまま出ます。**」
 */
export function declaredRoleKinds(manifest: unknown): readonly UserKind[] {
  return manifestRoleDeclarations(manifest)
    .filter(
      (declaration): declaration is { id: string; name: string } & Record<string, unknown> =>
        typeof declaration.id === "string" && typeof declaration.name === "string",
    )
    .map((declaration) => ({ id: declaration.id, name: declaration.name }));
}

/** 個人所有を表すフィールドの id(規約)。 */
export const OWNER_FIELD = "st_owner";

/**
 * テーブルが「個人所有テーブル」なら、その所有者フィールド(`st_owner`)を返す。
 * 条件は id===`st_owner` かつ type==="text" かつ required!==true。満たさなければ undefined。
 * system table や非該当テーブルは `st_owner` を持たない(または型/required が違う)ので
 * 自然に undefined になる。
 */
export function personalOwnerField(table: Table): Field | undefined {
  return table.fields.find(
    (field) => field.id === OWNER_FIELD && field.type === "text" && field.required !== true,
  );
}

/**
 * 共有センチネル(誰のものでもない=全員に見える)か。`null` / `undefined` / 空文字を共有とみなす。
 * `0` や `false` は共有ではない(念のため `st_owner` は text 前提だが、値検査は緩く保つ)。
 */
export function isSharedOwner(value: unknown): boolean {
  return value == null || value === "";
}

/**
 * その行(rowOwner)が actor に見えるか。自分の所有 or 共有だけ見える。
 *
 * 第3引数 `adminReadable` は **運営可視の宣言つきテーブルを `owner` ロールが読むとき**にだけ
 * true になる(V3-M8-T01 / ADR-0061 限定1〜3)。値は `adminReadsAllRows` が決める ——
 * **呼び出し側(`app.ts`)に条件式を書かない**(限定4 / ADR-0033 §Consequences)。**既定は
 * false** なので、引数を渡さない既存の呼び出し(書込側・file 配信)の挙動は1ミリも動かない。
 */
export function isOwnerVisible(rowOwner: unknown, actorId: string): boolean {
  return rowOwner === actorId || isSharedOwner(rowOwner);
}

/**
 * `st_owner` の更新(next)が現在値(currentOwner)から見て許されるか。
 * 「現在値のまま据え置く」か「共有化する(null/空文字にする)」だけを許す。
 * 他ユーザ id への付け替えも、共有行を自分の id にする私物化(claim)も不可。
 */
export function isAllowedOwnerUpdate(next: unknown, currentOwner: unknown): boolean {
  return next === currentOwner || isSharedOwner(next);
}

/**
 * **更新の入力に `st_owner` が入っているとき、それを許すか**(`V8-M37` / 台帳 `F-G5`)。
 * **{@link isAllowedOwnerUpdate} に「表示名のままの書き戻し」1形だけを足したものである。**
 *
 * ## **なぜ要るのか(実測。2026-08-13)**
 *
 * **`F-G5` が {@link projectOwnerDisplay} の `rowOwner === actorId` の枝を落とした結果、
 * 運営は自分の行の持ち主も**表示名**で読むようになった。** **読んだ内容をそのまま
 * 書き戻すと `isAllowedOwnerUpdate("運営者", "u-admin")` が偽になり、
 * **他人への付け替え**と見なされて 403 になる** —— **2026-07-30 の差し戻しが名指しした
 * 退行そのものであり、本単位で実測して再現した**(`owner-scope.test.ts` の (l) が赤くなった)。
 *
 * ## **何を通し、何を通さないか(**この1点が本述語の全部である**)**
 *
 * **通すのは「送られた値が、その行の**現在の**持ち主の表示名と一致する」1形だけである** ——
 * **すなわち「何も変えない書き戻し」だけである。** **他人への付け替えは1つも通らない**:
 * **送られた値が他人の表示名でも他人の id でも、比べる相手は常に**現在の持ち主**の表示名
 * なので一致しない。** **共有行(現在値が `null` / 空文字)には表示名が無いので、
 * どんな名前を送っても私物化できない。**
 *
 * ## **【値を書き換える。隠さない】**
 *
 * **表示名で通したときは、`values` の `st_owner` を**現在の持ち主の id に戻す**。**
 * **戻さないと「運営者」という表示名がそのまま行に保存され、次の読取で
 * {@link UNRESOLVED_OWNER_DISPLAY} に化ける**(持ち主が消えたのと同じ扱いになる)。
 * **破壊的に書き換えるのは {@link judgeOwnerScopedOp} の create 枝と同じ作法である** ——
 * **判定と、その判定が決めた正しい値の書き込みを、2箇所に割らない。**
 * **通した理由が「据え置き」「共有化」のときは1バイトも触らない。**
 *
 * **【`isAllowedOwnerUpdate` を1バイトも書き換えていない】** —— **`ADR-0079` 限定5
 * (「同関数の `git diff` が空」)を守る。** **本述語はあれを**呼ぶ**だけであり、
 * 更新側の真理値表は1つも動いていない**(`owner-scope.test.ts` の (F-G5 P2) が突き合わせる)。
 *
 * @param values 更新の入力。**`st_owner` を持たなければ判定の対象外(真)。**
 * @param currentOwner 既存行の現在の持ち主。
 * @param currentOwnerDisplay **現在の持ち主の表示名を引く関数**(解決できなければ
 *   `undefined`)。**関数で受けるのは、`_auth_users` を読むのが本当に要るときだけに
 *   するためである** —— **据え置き / 共有化は1度も呼ばない**(呼び出し側に条件式を
 *   書かずに読取を節約する。`ADR-0061` 限定4)。
 */
export function judgeOwnerUpdateWithDisplay(
  values: Record<string, unknown>,
  currentOwner: unknown,
  currentOwnerDisplay: () => string | undefined,
): boolean {
  if (!Object.hasOwn(values, OWNER_FIELD)) {
    return true;
  }
  const next = values[OWNER_FIELD];
  if (isAllowedOwnerUpdate(next, currentOwner)) {
    return true;
  }
  // **現在の持ち主が id を持たない(共有行)なら、表示名は存在しない** ——
  // **ここで抜けないと `undefined === undefined` の一致が生まれ、私物化が通る。**
  if (typeof next !== "string" || next === "" || isSharedOwner(currentOwner)) {
    return false;
  }
  if (currentOwnerDisplay() !== next) {
    return false;
  }
  values[OWNER_FIELD] = currentOwner;
  return true;
}

/**
 * **作成の入力が「他人を持ち主にしようとしている」か**(`V8-M37` / 台帳 `F-G3` /
 * ユーザ決定 `D-V8-96`)。**真なら呼び出し側は 403 を返す。**
 *
 * ## **着手前の実物と、変えた1形**
 *
 * **着手前の `src/server/app.ts` は `body.value[OWNER_FIELD] = actor.id` の1行だけを持ち、
 * 送られてきた値を読む分岐が1本も無かった** —— **他人の利用者IDを送っても 201 で黙って
 * 本人に化けた**(実測: `docs/plan/v8/records/v8-m35-prestate-m33.md` §C-7 の (7a))。
 * **本述語が変えるのはその1形だけである。**
 *
 * ## **なぜ更新側の {@link isAllowedOwnerUpdate} をそのまま呼ぶのか**
 *
 * **作成の場面には「既存行の現在値」が無い** —— **しかし「この作成が成立したときの持ち主」は
 * 決まっており、それは actor 自身である**(サーバが直後にスタンプする値)。
 * **その値を第2引数(現在値)として渡すと、更新側の真理値表がそのまま作成側の答えになる**:
 *
 * | 送られた値 | {@link isAllowedOwnerUpdate} | この述語 | 応答 |
 * |---|---|---|---|
 * | **キーごと書かない** | (呼ばない) | `false` | **201**(今日どおり) |
 * | **空文字 / `null` / `undefined`** | `true`({@link isSharedOwner}) | `false` | **201**(今日どおり) |
 * | **自分の id** | `true`(据え置き) | `false` | **201**(閉じすぎない) |
 * | **他人の id** | `false`(付け替え) | **`true`** | **403** |
 *
 * **空文字と `null` を通すのは、更新側が「共有にする」を詐称と見なしていないからである** ——
 * **同じ値の同じ読みを、作成と更新で割らない。** **【正直に書く】通したあと、呼び出し側は
 * 今日どおり actor でスタンプする** —— **したがって「共有の行を作る」ことは今日もできない。**
 * **本述語は「断るかどうか」だけを決め、スタンプの挙動を1バイトも変えない。**
 *
 * **相手が実在するかを1度も見ない** —— **`_auth_users` を引かない**(この関数は SQL を
 * 知らない純粋関数である)。**「実在しない id なら通す」にすると、実在判定が可否になり、
 * 誰が居るかを応答コードで数え上げられるようになる。**
 *
 * @param values 作成の入力(**1バイトも書き換えない**。判定だけを行う)。
 * @param actorId 要求者の id(**HTTP の作成の口では必ず認証済みなので空文字は来ない**)。
 */
export function isOwnerSpoofedOnCreate(values: Record<string, unknown>, actorId: string): boolean {
  if (!Object.hasOwn(values, OWNER_FIELD)) {
    return false;
  }
  return !isAllowedOwnerUpdate(values[OWNER_FIELD], actorId);
}

// --- op 1件への所有者スコープ判定(V3-M13-T10 / ADR-0067 限定 A5)------------------------
//
// **なぜ「判定の適用」までここに置くのか。** 限定 A5 は「島の返した op は HTTP バッチ経路と
// **同じ判定**(create op のスタンプ / 不可視なら404 相当 / 私物化なら403 相当)を受ける。
// **判定を2箇所に書かない**」と定める。V3-M8-T01b までは、述語(`personalOwnerField` /
// `isOwnerVisible` / `isAllowedOwnerUpdate`)だけがここにあり、**それを当てる順序**(可視性を
// 先に見る / create は必ず上書きする)は `app.ts` のループに書かれていた。島の op 経路は
// `src/kernel/workflow-runner.ts` の中で完結し `app.ts` を1行も通らないので、**そのループを
// カーネル側にもう1つ書くと、順序という判定が2箇所に散る**(ADR-0033 §Consequences の逐語
// 「2箇所に散ると片方だけ直されて食い違う」/ ADR-0061 限定4)。**そこで順序ごとこの関数に
// 引き上げ、`app.ts` と `workflow-runner.ts` の両方がこれを呼ぶ。**
//
// **ADR-0003 §7 の逐語「サーバ層にロジックを1行足すことは、カーネルの単一責任を1つ削ることに
// 等しい」との関係**: この関数は SQL も HTTP も知らない**純粋関数**であり、行の読み出しは
// 呼び出し側が渡す `readRow` に委ねる。**このファイルは今日も実行時 import を1つも持たない**
// ので、カーネルから値として呼んでも層の依存が実体を持たない。**判定の家は1つのままである。**
//
// **`st_admin_readable`(運営可視)はここに1文字も関わらない** —— ADR-0061 限定1 が開いたのは
// 読取2経路だけであり、**書込は1ミリも開かない**(見えても書けない)。
//
// **【`V8-M20`。旧文を1バイトも消していない】** **`st_admin_readable` は `V8-M20` / `J-G30` で撤去された。**
// **上の1文は今日も真である** —— **置き換えの `roleReadCrossesOwnerScope` も読取だけを開き、
// ここ(書込の判定)には1文字も関わらない**(メインの裁定「越えるのは読取だけ」)。

/**
 * op 1件に対する所有者スコープの判定結果。
 *
 * - `skip` … 判定対象外(個人所有テーブルでない / op の形が判定に足りない / 対象行が無い)。
 *   **ここで別の検証を始めない** —— 形の検証はカーネルの1関門(`writeRecords`)が持つ。
 * - `stamped` … create op。`values.st_owner` を actor で**上書きした**(spoof 遮断)。
 * - `allowed` … update op。自分の行 or 共有行で、付け替えも無い。
 * - `invisible` … update op。**不可視**(404 相当。存在そのものを伏せる)。
 * - `forbidden` … update op。付け替え / 共有行の私物化(403 相当)。
 * - `no_actor` … **actor を特定できない実行**が個人所有テーブルへ create しようとした。
 *   HTTP 経路では起こらない(認証済みの actor が必ず居る)。**島の op 経路でだけ起きる。**
 */
export type OwnerScopedOpVerdict =
  | { kind: "skip" }
  | { kind: "stamped" }
  | { kind: "allowed" }
  | { kind: "invisible"; tableId: string; target: string }
  | { kind: "forbidden" }
  | { kind: "no_actor" };

/**
 * op 1件に所有者スコープを当てる(**判定の唯一の家**)。
 *
 * @param params.table 解決済みのテーブル(未解決なら undefined = `skip`)。**解決は呼び出し側**
 *   が `resolveTable` で行う —— ここにカーネルの値 import を持ち込まないためである。
 * @param params.op 生の op(`{op, table, target, values}`)。**形の検証はしない。**
 * @param params.actorId 操作者の id。**特定できない実行では `null`** を渡すこと(空文字を
 *   渡すと共有センチネルと衝突して意味が変わる)。
 * @param params.readRow 対象行を読む関数(無ければ undefined)。**トランザクションの外で
 *   読むので TOCTOU の窓が残る**(単件 PATCH / バッチと同じ窓)。
 *
 * **create op のときは `op.values` の `st_owner` を破壊的に上書きする** —— 「クライアント
 * 送信を信用する経路は最初から作らない」(ADR-0016 §却下(iv))を、値を捨てることで実現する。
 */
export function judgeOwnerScopedOp(params: {
  table: Table | undefined;
  op: unknown;
  actorId: string | null;
  readRow: (tableId: string, recordId: string) => Record<string, unknown> | undefined;
}): OwnerScopedOpVerdict {
  const { table, op: rawOp, actorId, readRow } = params;
  if (typeof rawOp !== "object" || rawOp === null || Array.isArray(rawOp)) {
    return { kind: "skip" };
  }
  const op = rawOp as Record<string, unknown>;
  const tableId = op.table;
  if (typeof tableId !== "string") {
    return { kind: "skip" };
  }
  if (table === undefined || personalOwnerField(table) === undefined) {
    return { kind: "skip" };
  }
  const values = op.values;
  if (typeof values !== "object" || values === null || Array.isArray(values)) {
    return { kind: "skip" };
  }
  const mutableValues = values as Record<string, unknown>;

  if (op.op === "create") {
    if (actorId === null) {
      // **fail-closed。** 誰のものとも言えない行を個人所有テーブルに作らない(共有センチネルを
      // 勝手に立てることもしない —— それは「全員に見える行」を島に作らせることである)。
      return { kind: "no_actor" };
    }
    mutableValues[OWNER_FIELD] = actorId;
    return { kind: "stamped" };
  }
  if (op.op !== "update" || typeof op.target !== "string" || op.target === "") {
    return { kind: "skip" };
  }
  const target = op.target;
  const existing = readRow(tableId, target);
  if (existing === undefined) {
    return { kind: "skip" };
  }
  // **(1) 可視性が先。** 逆にすると、不可視の行が実在することが 403 で漏れる。
  if (!isOwnerVisible(existing[OWNER_FIELD], actorId ?? "")) {
    return { kind: "invisible", tableId, target };
  }
  // (2) 付け替え / 共有行の私物化(claim)の禁止。
  if (
    Object.hasOwn(mutableValues, OWNER_FIELD) &&
    !isAllowedOwnerUpdate(mutableValues[OWNER_FIELD], existing[OWNER_FIELD])
  ) {
    return { kind: "forbidden" };
  }
  return { kind: "allowed" };
}

// --- 公開規約(st_public)—— 未認証 read-only 閲覧(V2-M1-T04 / ADR-0034 案(b))----------
//
// `st_owner`(所有スコープ)と同型の予約規約フィールドで「公開指定」を表す。案(a)の
// manifest schema キー(`view.public`)は採らない —— `schemas/` を1バイトも増やさず、認識は
// この `src/server/` に閉じる(ADR-0034 §3 限定1/5)。認識するのはサーバ層だけで、AI は
// これを通常の boolean フィールドとしてしか扱わない(kernel / schema には現れない)。

/** 公開指定を表すフィールドの id(規約)。 */
export const PUBLIC_FIELD = "st_public";

/**
 * テーブルが「公開テーブル」なら、その公開フィールド(`st_public`)を返す。
 * 条件は id===`st_public` かつ type==="boolean" かつ required!==true(`personalOwnerField` と同型)。
 * 満たさなければ undefined —— そのテーブルには未認証 GET 窓を開けない。
 */
export function publicField(table: Table): Field | undefined {
  return table.fields.find(
    (field) => field.id === PUBLIC_FIELD && field.type === "boolean" && field.required !== true,
  );
}

/**
 * その行が「公開」か。**厳密に `st_public===true` の行だけ**が公開。false / 欠落 / truthy な
 * 文字列や数値は非公開に倒す(既定で公開しない=最小性。ADR-0034 §3 限定3)。
 */
export function isPublicRow(row: Record<string, unknown>): boolean {
  return row[PUBLIC_FIELD] === true;
}

/**
 * **外部から届いた入力(受信 payload)から `st_public` を無条件に取り除く**
 * (`V4-M27` / ユーザ決定 `D-V4-92`(§5a)+ `D-V4-114`(§5b))。**破壊的に削る。**
 *
 * **判定の家はこのファイルである**(`ADR-0061` 限定4「判定は `src/server/owner-scope.ts` に
 * 集約する / 呼び出し側に条件式を書かない」/ `ADR-0033` §Consequences 逐語「2箇所に散ると
 * 片方だけ直されて食い違う」)。**呼び出し側(`src/server/inbound-route.ts`)は
 * `st_public` という綴りを1文字も持たない。**
 *
 * **`judgeOwnerScopedOp` の `st_owner` の扱いと、形が2つ違う**(手本をそのまま写していない):
 *  1. **上書きではなく削除である。** `st_owner` は「誰のものか」に正しい値(actor)があるので
 *     `mutableValues[OWNER_FIELD] = actorId` で**書き換える**。`st_public` に対応する正しい値は
 *     無い —— 外部の送り手が「誰でも見える」と名乗る根拠が無いだけなので、**捨てる。**
 *  2. **テーブルを引数に取らない = 表の宣言を見ない。** `st_owner` の側は
 *     `personalOwnerField(table) === undefined` なら1バイトも触らないが、こちらは
 *     **`publicField(table)` を1度も呼ばない。** **`D-V4-114` が「無条件に取り除く」
 *     「拒否しない(400 を返さない)」と決めたためである。**
 *
 * **【この関数が変えてしまうもの。先に書く(憲法6)】** **`st_public` を持たない表への受信は、
 * 今まで「フィールド "st_public" はテーブル "…" に存在しません。」で 400 だったものが、
 * 黙って 201 で通るようになる**(`D-V4-114` が承知した副作用。実測は
 * `src/server/inbound-owner-scope.test.ts` の (Y))。**黙って通るようになるのはこの1本だけで、
 * 他の未知フィールドは今日どおり 400 で弾かれる**(同 (Y) の2本目)。
 *
 * **【この関数が塞がないもの。誇張しない】**
 * **【`V8-M20`。旧文を1バイトも消していない】** **旧文は「残り3本の予約規約フィールド
 * (`st_admin_readable` / `st_undeletable` / `st_no_direct_create`)」と書いていた。**
 * **`st_admin_readable` は `V8-M20` / `J-G30` で撤去されたので、今日は **2本**
 * (`st_undeletable` / `st_no_direct_create`)である。** それらは今日も受信 payload から
 * 書ける**(同 (Z) が固定している)。**`D-V4-114` の逐語「実施後も『予約規約フィールドは
 * 塞がれた』と書かない」。** **個人所有の表へ外部から行が入ること自体も、この関数では
 * 解けない**(`D-V4-92` の逐語「解けないと書く」)。
 *
 * @returns 実際に取り除いたなら true(キーが最初から無ければ false)。**呼び出し側はこの値で
 *   分岐しない** —— 記録・観測のためだけの返り値である(拒否には使わない。`D-V4-114`)。
 */
export function stripInboundPublicFlag(values: Record<string, unknown>): boolean {
  if (!Object.hasOwn(values, PUBLIC_FIELD)) {
    return false;
  }
  delete values[PUBLIC_FIELD];
  return true;
}

// --- 運営可視規約(st_admin_readable)は **`V8-M20` で撤去した** ------------------------
//
// **台帳 `J-G30`(`docs/adr/0007-vocabulary-governance.md` §8)の判定 = 廃止。**
// **手続きは `ADR-0301`(語彙を廃止する判定値と `Δ11`)に拠る。**
//
// **ここに在ったもの**: `ADMIN_READABLE_FIELD`(= `"st_admin_readable"`)/ `adminReadableField()`
// / `adminReadsAllRows()`(下の実効ロール集合の節の末尾)/ `READ_HIDDEN_RESERVED_FIELDS` /
// `projectForRead()`(「書けるが効かない値」を読取応答から落とす射影)。
//
// **代わりに立つもの**(`ADR-0301` 限定6 の ①): **役割 × 対象(表)× 読取**。
// **`roleReadCrossesOwnerScope()`(下)が、面の規則が読取を許している表について
// `st_owner` の絞り込みを越えさせる。** **ユーザ決定 `D-V8-35`(2026-08-10)が
// 「役割側から壁を越えられるようにする」を選んだ。**
//
// **【`V8-M20-T01` の実測。丸めない】** **`D-V8-35` を得る前の実装では、この撤去に
// 「代わり」は立たなかった** —— **役割 `owner` に 表 × 読取 を書いても、他人の `st_owner` 行は
// 一覧0件・単件404 であり、規則を1本も書かない対照群と応答が1バイトも変わらなかった。**
// **越えさせているのは `D-V8-35` によって足した下の1本であって、面の規則それ自体ではない。**

// --- 実効ロール集合 —— **1人が複数の役割を持つ**(`V8-M16` / `J-G3`)-------------------
//
// **【この規則は着手時点でどこにも定義されていなかった。`V8-M16` が初めて定義する】**
// **「今日どおり」ではない** —— 着手前の実装は1ユーザ1値しか持てず、`declared.includes(role)`
// の形しか無かったので、**複数持ったときにどう合成するかは未定義だった**(実測B §3-2 (e))。
//
// > **実効ロール集合 = `{_auth_users.role の1値}` ∪ `{_auth_user_roles に在る付与}`。**
// > **判定は「実効ロール集合と宣言集合の積が空でなければ通る」の1本に閉じる。**
//
// **根拠は門A の限定 `J-G3` の逐語「複数の役割は和集合1本で合成する」である**
// (`docs/adr/0007-vocabulary-governance.md` §8 の台帳。メインの裁定 `R-3` が実装の形を割った)。
//
// **【この形にした理由】** **`Role` 1値を受ける今日の署名を「1値 または 集合」へ**広げた**
// だけで、判定の本体を1本も増やしていない。** **`Role`(= 文字列)を渡す既存の呼び出しは
// 1バイトも書き換えずに今日どおり動く** —— 集合の要素数1として扱われるからである。
//
// **【積が空のときは今日どおり止まる】** **和集合は「見える側」に倒れる**(`04` §7-2 の 7)。
// **「OR なので安全側に倒れる」とは書かない。**

/**
 * **判定に渡る実効ロール集合**(`V8-M16` / `J-G3`)。
 *
 * - `Role` … 1値(着手前の形。**集合の要素数1として扱う**)
 * - `readonly Role[]` … 実効ロール集合
 * - `null` … **未認証**(= ロールを1つも持たない。`anonymous` の判定はこの値で行う)
 */
export type ActorRoles = Role | readonly Role[] | null;

/**
 * {@link ActorRoles} を配列に正規化する(非 export。**判定の読み方を1箇所に閉じる**)。
 * **未認証(`null` / `undefined`)と空集合は同じ「1つも持たない」に落とす。**
 */
function roleSetOf(actor: ActorRoles | undefined): readonly Role[] {
  if (actor === null || actor === undefined) {
    return [];
  }
  return typeof actor === "string" ? [actor] : actor;
}

/**
 * **宣言集合と実効ロール集合の積が空でないか**(非 export。**和集合の規則の唯一の実装**)。
 * **1つでも一致すれば通る。** **1つも持たない相手(未認証)には常に `false`。**
 */
function declaredMatchesRoles(declared: readonly string[], actor: ActorRoles | undefined): boolean {
  return roleSetOf(actor).some((role) => declared.includes(role));
}

/**
 * **面の規則が、このテーブルの**読取**を許しているか**(`V8-M20` / ユーザ決定 `D-V8-35`)。
 *
 * **真のとき、呼び出し側は `st_owner`(個人スコープ)の絞り込みを **読取についてだけ** 越える。**
 * **これが `st_admin_readable`(`ADR-0061`)の置き換えである** —— **台帳 `J-G30` の
 * 「代わりに立つのは 対象(表)× 読取」を、実際に成り立たせている1本。**
 *
 * ## `D-V8-35` の説明文の逐語(**代償を隠さないために、ここに写す**)
 *
 * > 予定どおり古い宣言を廃止し、代わりに「この役割はこの表を読める」と書いたら、その役割の人には
 * > 全員分の行が見えるようにします。運営者は今までどおりデータを横断して見られます。**ただし
 * > 代償があります —— 「この表を読める」と書いた役割は誰であっても全員分が見えるので、書き方を
 * > 間違えると、本来自分の分だけ見えるはずだった人に全員分が見えます。今日はその危険が
 * > 「運営者だけ」に閉じていました。**
 *
 * **したがって本関数は `owner` を1文字も特別扱いしない**(`adminReadsAllRows` は
 * `declaredMatchesRoles(["owner"], role)` を持っていた。**その等値は消えた**)。
 *
 * ## 越える範囲(**メインの裁定。これを超えない**)
 *
 * - **越えるのは読取だけである。** **`write` と `delete` は越えない** —— **書込・削除では
 *   `st_owner` は今日どおり `AND` で効く。** **理由: `st_admin_readable` が今日していたのは
 *   読取だけであり、`ADR-0007` 問2③(小さい方を採る)に照らして書込まで広げない。**
 * - **面の規則を1本も書いていない表では偽である**(`governed === false`)——
 *   **既定は今日どおり「自分の行と共有行だけ」である。**
 * - **`st_public` / `st_undeletable` / `st_no_direct_create` は1バイトも動かさない。**
 *
 * ## **`D-V8-32` の「今日どおり」が、`st_owner` の読取についてだけ成り立たなくなった**
 *
 * **`D-V8-32`(「誰が」ではない約束4本は今日どおり残して併存させる)は、4本の**フィールドも
 * 実装も**残すという決定として今日も生きている** —— **`st_owner` は1バイトも消えていない。**
 * **しかし `st_owner` の**重ね順**は変わった** —— **読取に限り `AND` から
 * `( st_owner を満たす OR 面が読取を許している )` になった。**
 * **【禁止の履行】「4本は1ミリも変わっていない」とは書かない。**
 *
 * ## 行を渡すこと(**条件つきの規則があるとき**)
 *
 * **`V8-M18` の条件(`when`)つきの規則が立っている表では、答えは行ごとに変わる。**
 * **`row` / `subject` を渡すと行ごとに評価する。** **渡さないと「通しうる」までしか言わない。**
 */
export function roleReadCrossesOwnerScope(params: {
  manifest: unknown;
  roles: ActorRoles;
  table: string;
  row?: Record<string, unknown>;
  subject?: string | null;
}): boolean {
  const decision = judgeRoleAccess({
    manifest: params.manifest,
    roles: params.roles,
    target: { target: "table", table: params.table },
    verb: "read",
    row: params.row,
    subject: params.subject,
  });
  // **管轄外(規則が1本も無い)なら越えない** —— **`allowed` は管轄外でも真なので、
  // `governed` を必ず見る。** **ここが偽のとき、挙動は着手前と1バイトも変わらない。**
  return decision.governed && decision.allowed;
}

// --- 削除不可規約(st_undeletable)—— 行の状態で `DELETE` だけを止める(V4-M4-T04 / ADR-0073)--
//
// **予約規約フィールドの4本目である**(`ADR-0061` 限定9 が「4本目には門A の新規審査 +
// 同格の個別 ADR が要る」と定め、`ADR-0073` がその個別 ADR である)。既存3本と同じく
// **`schemas/` に1バイトも現れず、`src/kernel/` にも1バイトも現れない** —— 認識するのは
// この `src/server/` だけで、AI はこれを通常の boolean フィールドとしてしか扱わない。
//
// **【既存3本と決定的に違う点を隠さない】** `st_owner` / `st_public` は行の値を見るが、
// `st_admin_readable` は**テーブル単位**の宣言だった(`ADR-0061` 限定3 逐語「**行の値は
// 判定に使わない**」)。**本規約は行の値を判定に使う** —— `ADR-0061` §3a-3 が警告した形で
// あり、`ADR-0073` §限界6 が「この読みを採らなければ判定が変わる」と明記している。
//
// **止めるのは `DELETE` だけである**(`ADR-0073` 限定3)。`POST` / `PATCH` / `/batch` は
// 1バイトも変わらない —— **運営(または運営が定義したワークフロー)が `PATCH` で状態を
// 動かせることが `D-V4-2` の形そのもの**だからである(「行は残り、運営が状態を動かす」)。
//
// **既定は「今日どおり消せる」**(限定4)。フィールドが無い表・値が立っていない行は1ミリも
// 変わらない。**厳密に `true` の行だけ**が守られる(`isPublicRow` と同じ厳密さ)。
//
// **【この規約が守らないもの。先に書く(憲法6)】**
//  1. **MCP の `delete_record` は1ミリも守られない**(限定6)—— サーバの HTTP ハンドラを
//     通らない。`ADR-0073` §限界2 がこれを「本 ADR の最大の限界」と書いている。
//  2. **ワークフローの履歴テーブルは射程外である**(限定11)。
//  3. **持ち主は自分の行の値を `PATCH` で下ろせる** —— 限定3 が `PATCH` を触らないと定めて
//     いるためである。**`ADR-0073` 限定9 が「固定する」と書いた形にはならなかった。**
//     実測は `src/server/row-delete-protection.test.ts` の `(穴)` で始まる検査。

/** 削除不可宣言を表すフィールドの id(規約)。**綴りは `V4-M4-T00` §5-2 が決めた。** */
export const UNDELETABLE_FIELD = "st_undeletable";

/**
 * テーブルが「削除不可宣言つき」なら、その宣言フィールド(`st_undeletable`)を返す。
 * 条件は id===`st_undeletable` かつ type==="boolean" かつ required!==true
 * (`publicField` / `adminReadableField` と同型)。満たさなければ undefined ——
 * **そのテーブルの行は今日どおり消せる。**
 */
export function undeletableField(table: Table): Field | undefined {
  return table.fields.find(
    (field) =>
      field.id === UNDELETABLE_FIELD && field.type === "boolean" && field.required !== true,
  );
}

/**
 * その行の `DELETE` を止めるか(**判定の唯一の家**。`ADR-0073` 限定5: `app.ts` に条件式を
 * 書かない —— `ADR-0033` §Consequences 逐語「2箇所に散ると片方だけ直されて食い違う」)。
 *
 * **宣言済みテーブル × 行の値が厳密に `true`** のときだけ true。`"true"` / `1` のような
 * truthy な値は守らない(既定を「消せる」に倒す = 最小性。`isPublicRow` と同じ厳密さ)。
 *
 * **actor もロールも引数に取らない** —— **止めるのは行の状態であって、誰が叩いたかでは
 * ない**(`ADR-0073` の審査単位「ある状態から先の行を、持ち主が消せないようにしたい」)。
 * **運営(owner)が叩いても止まる。** 型でそれを示すために引数を増やしていない。
 */
export function isDeleteProtectedRow(table: Table, row: Record<string, unknown>): boolean {
  return undeletableField(table) !== undefined && row[UNDELETABLE_FIELD] === true;
}

// --- 直接作成の遮断(st_no_direct_create)—— 予約規約フィールドの5本目 -------------------
//    (`E-G49` / V4-M10-T04 / ADR-0077)
//
// **予約規約フィールドの5本目である。** **`ADR-0073` 限定2 / §3a-1 と `ADR-0061` 限定9 が
// 「5本目には改めて門A の新規審査 + 同格の個別 ADR が要る」と定め、`ADR-0077` がその個別
// ADR である**(同 §4)。**`ADR-0061` は「3本目で止める」、`ADR-0073` は「4本目で止める」と
// 書いた** —— **1版のうちに2本増えることは、どちらの限定表も想定していない増え方である**
// (`ADR-0077` §S3 (a)。隠さない)。
//
// 既存4本と同じく **`schemas/` に1バイトも現れず、`src/kernel/` にも1バイトも現れない**
// (限定1)—— 認識するのはこの `src/server/` だけで、AI はこれを通常の boolean フィールド
// としてしか扱わない。
//
// **宣言はテーブル単位であり、フィールドがそのテーブルに在ることだけが宣言である**
// (限定9。`ADR-0061` 限定3 の作法)。**行の値は判定に使わない** —— `st_undeletable`
// (`ADR-0073`)が行の値を見るのとは逆の側に倒した。
//
// **止めるのは `POST` と `/batch` の create op だけである**(限定3)。**`PATCH` /
// `DELETE` は1バイトも変わらない** —— 「作れない」と「直せない」「消せない」は別の要求で
// ある(`ADR-0073` §3a-2 と同型)。
//
// **ワークフローの `create_record` と島の create op は1ミリも止まらない**(限定4)——
// **それが目的である。** それらは `src/kernel/` の `createRecord` / `writeRecords` を
// 呼ぶだけで、サーバの HTTP ハンドラを1行も通らない。
//
// **既定は「今日どおり作れる」**(限定5)。フィールドが無い表は1ミリも変わらない。
//
// **【この規約が守らないもの。先に書く(憲法6)】**
//  1. **MCP の `write_records` / `insert_sample_data` は1ミリも守られない**(限定6 の帰結)。
//  2. **受信 capability の経路(`src/server/inbound-route.ts`)も守られない** ——
//     同経路は `judgeOwnerScopedOp` を1度も通らない(`ADR-0079` Context の実測)。
//  3. **「決められた自動処理」の「決められた」を表現できない**(限定10)——
//     **どのワークフローでも作れる。** 今日の語彙にワークフローを名指しする手段が無い。
//  4. **既存の壊れた行は1件も直らない**(`ADR-0077` §S3 (e))。
//  5. **`NonAdminTableAccess` の3値の意味が変わる** —— `scoped` の中に「作れる」と
//     「作れない」の2状態が生まれた(同 (d))。**`ADR-0016` §1 の2軸直交の例外が2つ目である。**

/** 直接作成の遮断を表すフィールドの id(規約)。**予約規約フィールドの5本目。** */
export const NO_DIRECT_CREATE_FIELD = "st_no_direct_create";

/**
 * テーブルが「直接作成の遮断つき」なら、その宣言フィールド(`st_no_direct_create`)を返す。
 * 条件は id===`st_no_direct_create` かつ type==="boolean" かつ required!==true
 * (`publicField` / `adminReadableField` / `undeletableField` と同型)。満たさなければ
 * undefined —— **そのテーブルには今日どおり `POST` で行を作れる。**
 */
export function noDirectCreateField(table: Table): Field | undefined {
  return table.fields.find(
    (field) =>
      field.id === NO_DIRECT_CREATE_FIELD && field.type === "boolean" && field.required !== true,
  );
}

/**
 * その表への **HTTP からの直接 create** を止めるか(**判定の唯一の家**。`ADR-0077` 限定6:
 * `app.ts` に条件式を書かない —— `ADR-0033` §Consequences 逐語「2箇所に散ると片方だけ
 * 直されて食い違う」)。
 *
 * **行もロールも actor も引数に取らない** —— **止めるのはテーブルの宣言であって、誰が
 * 叩いたかでも行の値でもない**(限定9)。**運営(owner)が叩いても止まる。** 型でそれを
 * 示すために引数を増やしていない。
 */
export function isDirectCreateSuppressed(table: Table): boolean {
  return noDirectCreateField(table) !== undefined;
}

// --- アクセス権管理の宣言を「規約として認識する」(`Z-G2`〜`Z-G7` / V7-M1-T04)-----------
//
// **`st_*` の予約規約フィールドを1本も増やさない**(`v7-m0.md` §5-3 の逐語「**v7 が足す
// 本数 = 0本**」)。**代わりに `$defs/table` の6キー目 `access_control` が、付与表・
// メンバー表・グループ表と、それぞれのどの列が何を表すかを**宣言で**名指しする**
// (同 §5-2 (a) の4)。**したがって本節に `st_` で始まる綴りは1つも現れない。**
//
// **置き場所がここである理由**: **`ADR-0061` 限定4 の逐語「**判定は
// `src/server/owner-scope.ts` に集約する** | 新しい述語を同ファイルに置き、`app.ts` に
// 条件式を書かない」。** **`v7-m0.md` §5-2 (b) が判定関数 `judgeRecordAccess` の
// 置き場所として同じファイルを指名している。**
//
// **【本節がしないこと。先に書く(憲法6)】**
//  1. **判定(誰に何が見えるか・書けるか)を1バイトも実装していない** —— **`V7-M3` の担当。**
//     **本節が作るのは「規約として認識する」ところまでである。**
//  2. **`judgeOwnerScopedOp` にも `nonAdminTableAccess` にも1バイトも触っていない** ——
//     **今日この宣言を書いても、行の読取・書込・削除のふるまいは1つも変わらない。**
//  3. **宣言が規約どおりかを1つも検査していない**(指した表・列の実在も型も)——
//     **それは適用時の検査(`src/kernel/referential-integrity.ts`。`V7-M1-T05`)の担当で
//     ある。** **本節は「壊れた宣言でも例外を投げない」ことだけを引き受ける**
//     (`declaredUserKinds` と同じ理由: 述語が例外を投げると読取経路が 500 になる)。

/** 表が宣言したアクセス権管理の設定(`$defs/table.access_control` の値)。 */
export type AccessControlDeclaration = NonNullable<Table["access_control"]>;

/**
 * **その表がアクセス権管理の宣言で持つ役割。**
 *
 * - `protected` … その表自身が `access_control` を宣言している(**守られる側**)。
 * - `grant` … どこかの宣言の `grant.table` に名指しされている(**付与表**)。
 * - `members` … どこかの宣言の `members.table` に名指しされている(**メンバー表**)。
 * - `groups` … どこかの宣言の `groups.table` に名指しされている(**グループ表**)。
 *
 * **1つの表が複数の役割を兼ねうる**(規約はそれを禁じていない)。**返す順序はこの宣言順に
 * 固定する** —— 呼び出し側が順序に依存しても壊れないようにするためである。
 */
export type AccessControlTableRole = "protected" | "grant" | "members" | "groups";

/** {@link accessControlTableRoles} が返す順序の正。**この配列の順に並べて返す。** */
const ACCESS_CONTROL_TABLE_ROLES: readonly AccessControlTableRole[] = [
  "protected",
  "grant",
  "members",
  "groups",
];

/**
 * **その表が有効なアクセス権管理を宣言しているなら、その宣言を返す。**
 *
 * **`enabled: true` のときだけ返す** —— **`enabled: false` は「宣言していない表」と
 * まったく同じ扱いである**(`v7-m0.md` §5-2 (a) の5。**キーの存在だけで有効にしない**)。
 * **`enabled` が真偽値でない壊れた宣言も `undefined` に倒す**(schema が弾く形だが、
 * 述語の側で例外を投げると読取経路が 500 になる)。
 *
 * **返すのは宣言そのものへの参照であって複製ではない。** **呼び出し側は書き換えないこと**
 * —— 本ファイルの述語はどれも入力を1バイトも書き換えない(`judgeOwnerScopedOp` の
 * `values` への破壊的な上書きだけが例外で、あちらは doc に明記してある)。
 */
export function accessControlOf(table: Table): AccessControlDeclaration | undefined {
  const declared = (table as { access_control?: unknown } | null | undefined)?.access_control;
  if (typeof declared !== "object" || declared === null || Array.isArray(declared)) {
    return undefined;
  }
  if ((declared as { enabled?: unknown }).enabled !== true) {
    return undefined;
  }
  return declared as AccessControlDeclaration;
}

/** その表自身がアクセス権管理を宣言しており、かつ有効か(**守られる側**か)。 */
export function isAccessControlledTable(table: Table): boolean {
  return accessControlOf(table) !== undefined;
}

/** マニフェストの表を、形が壊れていても例外を投げずに読む。 */
function tablesOf(manifest: Manifest): readonly Table[] {
  const tables = (manifest as { app?: { tables?: unknown } } | null | undefined)?.app?.tables;
  return Array.isArray(tables) ? (tables as Table[]) : [];
}

/** **有効な宣言の全量**(`enabled: false` と未宣言はここに現れない)。 */
function enabledDeclarationsOf(manifest: Manifest): readonly AccessControlDeclaration[] {
  const declarations: AccessControlDeclaration[] = [];
  for (const table of tablesOf(manifest)) {
    const declared = accessControlOf(table);
    if (declared !== undefined) {
      declarations.push(declared);
    }
  }
  return declarations;
}

/**
 * **その表IDが、このアプリのアクセス権管理の中で持つ役割の全量**(`V7-M1-T04`)。
 *
 * **入力はマニフェストと表IDだけである**(I/O を持たない純粋関数)。**実在しない表IDでも
 * マニフェストの形が壊れていても、例外を投げず空配列を返す。**
 *
 * **`enabled: false` の宣言は1つも数えない** —— **その宣言が名指しした付与表は、
 * 付与表として認識されない。**
 */
export function accessControlTableRoles(
  manifest: Manifest,
  tableId: string,
): readonly AccessControlTableRole[] {
  const declarations = enabledDeclarationsOf(manifest);
  const roles = new Set<AccessControlTableRole>();
  for (const table of tablesOf(manifest)) {
    if (table?.id === tableId && accessControlOf(table) !== undefined) {
      roles.add("protected");
    }
  }
  for (const declared of declarations) {
    if (declared.grant?.table === tableId) {
      roles.add("grant");
    }
    if (declared.members?.table === tableId) {
      roles.add("members");
    }
    if (declared.groups?.table === tableId) {
      roles.add("groups");
    }
  }
  return ACCESS_CONTROL_TABLE_ROLES.filter((role) => roles.has(role));
}

/** その表が**付与表**(誰にどの行をどの権限で渡したかを記録する表)か。 */
export function isGrantTable(manifest: Manifest, tableId: string): boolean {
  return accessControlTableRoles(manifest, tableId).includes("grant");
}

/** その表が**メンバー表**(誰が利用者かを記録する表)か。 */
export function isMemberTable(manifest: Manifest, tableId: string): boolean {
  return accessControlTableRoles(manifest, tableId).includes("members");
}

/** その表が**グループ表**か。**グループの入れ子は規約が禁じている**(`Z-G8`)。 */
export function isGroupTable(manifest: Manifest, tableId: string): boolean {
  return accessControlTableRoles(manifest, tableId).includes("groups");
}

// --- 行1件への判定(`Z-G11` / V7-M2-T02)------------------------------------------------
//
// **`judgeRecordAccess` が判定の唯一の家である**(`Z-G11` 限定3。`v7-m0.md` §5-2 (b) が
// 関数名と置き場所を確定させている)。
//
// **【`judgeOwnerScopedOp` の中に入れていない。理由を書く】** —— **`judgeOwnerScopedOp` は
// `src/kernel/workflow-runner.ts` と `src/server/inbound-route.ts` から呼ばれている。**
// **そこに付与の判定を入れると、ワークフローと受信口が判定を受けてしまい、`Z-G22` /
// `Z-G23`(今日どおり素通りする)と正面から食い違う**(`v7-m0.md` §5-2 (b) の逐語)。
// **`D-V7-4` / `D-V7-10` が決めた範囲を、実装の都合で勝手に広げないためである。**
//
// **【入力を閉じている】** —— 入力は **(マニフェスト, 表ID, 行, actor, 付与行, 利用者行)**
// だけである(`v7-m0.md` §5-6 の5「**付与はその表のその行にしか効かない**」)。
// **I/O を1つも持たない。行の読み出しは呼び出し側が済ませて渡す** ——
// **DB 側(`compileFilter`)には1バイトも落とさない**(§5-4 (i) の post-filter 裁定。
// 落とすと `ADR-0043` の「葉演算子はちょうど5種・深度上限8」を破る)。
// **代償は `ADR-0042` §限界2 と同じで、可視分岐は全件をメモリに読む。**
//
// **【本関数が実装していないもの。先に書く(憲法6)】**
//  1. **グループ経由の解決**(`grant.group` → グループ表 → `members.group`)—— **`V7-M3-T01`。**
//     **今日は「グループだけを指した付与」は1ミリも効かない。**
//  2. **引き継ぎ(`inherit_from` の多段)** —— **`V7-M4`。** **親を1度も辿らない。**
//  3. **作成者への自動付与**(`creator_permission`。`D-V7-23`)—— **`V7-M3-T02`。**
//     **本関数は付与**行**しか見ないので、作成者であることは判定に1ミリも効かない。**
//  4. **付与表・メンバー表・グループ表そのものへの判定** —— **効かない**(効かせると判定が
//     循環する。`ADR-0292` §9 の4)。**「誰に共有したか」は隠せない。**
//
// **【逐語の是正(`V7-M3-T06`。2026-08-08)。上の4項目を1バイトも書き換えていない】**
//
// **上の1(グループ経由の解決)は、`V7-M3-T01` が実装した** —— **今日は「グループだけを
// 指した付与」も効く**(実装は `grant.group` → `members.group` の突き合わせ。`V7-M3-T05` が
// 「消えたグループ行を指す付与」を判定の手前で落とす述語を足した)。**したがって上の1の
// 逐語「今日は『グループだけを指した付与』は1ミリも効かない。」は、今日の正ではない。**
// **`ADR-0007` §6 規律1 の作法で、旧文を消さずに新しい注をここに足す。**
//
// **上の2・3・4は今日も成り立っている** —— **引き継ぎの多段は `V7-M4` で未実装、
// 作成者への自動付与は `V7-M3-T02` が `app.ts` の下見として実装したものであって
// 本関数は今日も付与行しか見ない、判定の循環回避も今日どおりである。**

/**
 * 行1件に対する判定の結果。**動詞は `read` / `write` / `delete` の3つちょうどである**
 * (`Z-G11` 限定1。**4つ目を足さない。配列にしない**)。
 *
 * **【項目単位の宣言を1バイトも上書きしない】** —— **重ね順は AND であり、行が先・項目が後。**
 * **両方を満たしたものだけが通る**(`v7-m0.md` §5-4 (iv))。
 * **【`V8-M20`。旧文を1バイトも消していない】** **旧文は「本判定は `field.audience` / `field.writable_by` の射影
 * (`projectForFieldAudience` / `judgeFieldWrite`)に1ミリも触らない」と書いていた。**
 * **その2層は `V8-M20` / `J-G28` で撤去された。** **今日その位置に在るのは面の項目の規則
 * (`projectForRoleFields` / `judgeRoleFieldWrite`)であり、本判定はそれにも1ミリも
 * 触らない** —— **重ねるだけである。**
 */
export type RecordAccessVerdict = {
  readonly read: boolean;
  readonly write: boolean;
  readonly delete: boolean;
};

/** 宣言していない表 / `enabled: false` の表の答え(**今日どおり = この判定は何も絞らない**)。 */
const UNGOVERNED_RECORD_ACCESS: RecordAccessVerdict = { read: true, write: true, delete: true };

/** 付与が1件も解決できなかったときの答え(**fail-closed**)。 */
const NO_RECORD_ACCESS: RecordAccessVerdict = { read: false, write: false, delete: false };

/**
 * **判定に要る行を、どの表から読めばよいか**(`V7-M2-T02`)。
 *
 * **呼び出し側(`src/server/app.ts`)に `access_control` の綴りを1文字も持たせないための
 * 述語である**(`ADR-0061` 限定4 / `ADR-0292` 限定17)。**app.ts はここが返した表IDの行を
 * 読んで {@link judgeRecordAccess} に渡すだけであり、判定式を1行も持たない。**
 */
export type RecordAccessSourceTables = {
  /** 付与表の表ID(宣言が壊れていて読めなければ `undefined`)。 */
  readonly grantTable: string | undefined;
  /** メンバー表の表ID(宣言しなければ `undefined`)。 */
  readonly memberTable: string | undefined;
  /**
   * **グループ表の表ID**(宣言しなければ `undefined`)。**`V7-M3-T05`(`Z-G32`)が足した。**
   *
   * **【`V7-M3-T01` の設計判断は、ここで成り立たなくなった。隠さない】** ——
   * **`V7-M3-T01` は「グループ表の行を1行も読まない」を採り**(`grant.group` と
   * `members.group` が同じグループ表の行 id を指すことが適用時検査で保証されるため、
   * **id の一致だけでグループの一致が決まる**)、**その帰結として「消えたグループ行を指す
   * 付与は今日も効く」を限界として記録し、`V7-M3-T05` へ送った**(`v7-m3.md` §2-1-3 (c))。
   * **消えた行を止めるには「その行が在るか」を見るしかなく、id の一致だけでは決められない。**
   * **したがって読む表が1本増えた** —— **代償は {@link grantsWithExistingGroups} の doc。**
   */
  readonly groupTable: string | undefined;
};

/**
 * その表の判定に要る「読むべき表」を返す。**宣言していない表 / `enabled: false` の表では
 * `undefined` を返す** —— **`undefined` は「この経路に1バイトも掛からない」の意味であり、
 * 呼び出し側は今日どおりの処理を続ける**(オプトインの実体)。
 *
 * **壊れた宣言では `undefined` ではなく `{ grantTable: undefined, … }` を返す** ——
 * **宣言が在る以上、判定そのものは掛ける(そして {@link judgeRecordAccess} が fail-closed に
 * 倒す)。** **「壊れていたから素通りする」を作らない。**
 */
export function recordAccessSourceTables(
  manifest: Manifest,
  tableId: string,
): RecordAccessSourceTables | undefined {
  const table = tablesOf(manifest).find((candidate) => candidate?.id === tableId);
  if (table === undefined) {
    return undefined;
  }
  const declared = accessControlOf(table);
  if (declared === undefined) {
    return undefined;
  }
  const grantTable = declared.grant?.table;
  const memberTable = declared.members?.table;
  const groupTable = declared.groups?.table;
  return {
    grantTable: typeof grantTable === "string" && grantTable !== "" ? grantTable : undefined,
    memberTable: typeof memberTable === "string" && memberTable !== "" ? memberTable : undefined,
    groupTable: typeof groupTable === "string" && groupTable !== "" ? groupTable : undefined,
  };
}

/**
 * **消えたグループ行を指す付与を、判定の手前で無効にする**(`Z-G32` / `V7-M3-T05`)。
 *
 * **返すのは、付与行のうち `grant.group` が**グループ表に実在しない**行 id を指しているものの、
 * そのグループの値だけを `null` にした写しである。** **行そのものは1件も落とさない**
 * (**1件の付与行に相手とグループの両方が書いてあれば、相手側の解決は今日どおり効く**)。
 *
 * **【なぜ {@link judgeRecordAccess} の中に入れないか。判断と理由を書く】** ——
 * **`judgeRecordAccess` の引数キーが `manifest` / `tableId` / `row` / `actorId` /
 * `grantRows` / `memberRows` の**6本ちょうど**であることは、`ADR-0294` 限定5(**付与は
 * その表のその行にしか効かない = 判定の入力が (表, 行, actor) に閉じる**)の機械的な固定で
 * ある**(`src/server/access-control-role-precedence.test.ts` の `(E1)`)。
 * **グループ行を7本目の引数として足すとその固定が赤くなる。** **本タスクは
 * `ADR-0294` を引き直さず、判定の**手前**で付与行を整える形を採った。**
 *
 * **【その代償。隠さない】** —— **グループ行の実在の検査は判定の外に在る。**
 * **付与表の行を自分で読んで {@link judgeRecordAccess} に直接渡す呼び出しを新しく書けば、
 * この検査を素通りできる。** **`src/server/access-control-stale-grant.test.ts` の `(E-3)` が、
 * `app.ts` で `grantRows` に渡している式の出どころを固定して、増えたら赤くする。**
 *
 * **【読む表が1本増えた。性能の代償】** —— **グループ表を宣言している表では、1回の要求
 * ごとに付与表・利用者表に加えてグループ表も**全件**読む**(読取は要求あたり1度で、行ごとに
 * 読み直さない)。**グループを宣言していない表では1行も読まない。** **どこで遅くなるかは
 * 1件も測っていない。**
 *
 * **【グループ表が読めない/宣言が壊れている場合は fail-closed である】** ——
 * **グループ行が0件として渡れば、グループ経由の付与は1件も解決しない。**
 */
export function grantsWithExistingGroups(params: {
  manifest: Manifest;
  /** **保護対象の表のID**(宣言の在り処。付与表のIDではない)。 */
  tableId: string;
  grantRows: readonly Record<string, unknown>[];
  groupRows: readonly Record<string, unknown>[];
}): readonly Record<string, unknown>[] {
  const { manifest, tableId, grantRows, groupRows } = params;
  const table = tablesOf(manifest).find((candidate) => candidate?.id === tableId);
  const declared = table === undefined ? undefined : accessControlOf(table);
  if (declared === undefined) {
    // **宣言していない表 / `enabled: false` の表** —— **1件も落とさない**(オプトイン)。
    return grantRows;
  }
  const groupField = nonEmptyString(declared.grant?.group);
  if (groupField === undefined) {
    // **グループへの付与を書けない宣言** —— **落とすものが1件も無い。**
    return grantRows;
  }
  const existing = new Set<string>();
  for (const group of groupRows) {
    const id = nonEmptyString(group?._id);
    if (id !== undefined) {
      existing.add(id);
    }
  }
  return grantRows.map((grant) => {
    const held = nonEmptyString(grant?.[groupField]);
    if (held === undefined || existing.has(held)) {
      return grant;
    }
    return { ...grant, [groupField]: null };
  });
}

/** 文字列で、かつ空でない値だけを返す(壊れた宣言・壊れた行で例外を投げないため)。 */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * **その行を指している付与行だけを返す**(**付与の突き合わせの唯一の1本**。`V7-M5-T02`)。
 *
 * **`undefined` は「宣言が壊れていて突き合わせられない」の意味である**
 * (`grant.target` が空 / 文字列でない)。**空配列は「突き合わせたが1件も指していない」。**
 *
 * **【なぜ切り出したか。第2の述語を作らないためである】** ——
 * **`Z-G19`(運営専用の口)は「付与が0件の行」を母集団にする。**
 * **その「0件」を別のところで数え直すと、判定({@link judgeRecordAccess})が見ている付与と
 * 口が見ている付与が食い違いうる** —— **食い違えば、口は「誰にも見えない行」ではないものを
 * 並べるか、並べるべき行を落とす。** **本関数は
 * {@link resolveGrantedPermissionNames}(判定側)と {@link isRecordWithoutGrants}(口の側)の
 * **両方から呼ばれる**唯一の突き合わせであり、`Z-G19` 限定6 の実体である。**
 *
 * **【本関数が見ていないもの。先に書く】** —— **相手(`grant.member` / `grant.group`)も
 * 権限名(`grant.permission`)も1バイトも見ない。** **「その行を指しているか」だけである。**
 * **したがって「相手が解決できない付与」も1件として数える**(= その行は口に並ばない)。
 * **この帰結は `docs/plan/v7/records/v7-m5.md` の `V7-M5-T02` の限界に書いてある。**
 */
function grantsTargetingRecord(params: {
  declared: AccessControlDeclaration;
  recordId: string;
  grantRows: readonly Record<string, unknown>[];
}): readonly Record<string, unknown>[] | undefined {
  const targetField = nonEmptyString(params.declared.grant?.target);
  if (targetField === undefined) {
    return undefined;
  }
  return params.grantRows.filter((grant) => grant?.[targetField] === params.recordId);
}

/**
 * **その行を指す付与が1件も無いか**(`Z-G19` / `V7-M5-T02`。**1段ぶんの判断**)。
 *
 * **【これは「誰にも見えない行」ではない。1段ぶんの必要条件である】** ——
 * **引き継ぎ(`inherit_from`)の親に付与が在れば、この関数が真を返した行でも他人には
 * 見える。** **口の母集団を決めるのは {@link resolveRecordWithoutGrants} であり、
 * 本関数を各段に当てて**すべての段で真**のときだけ「誰にも見えない行」と呼ぶ。**
 * **本関数を単独で口の母集団に使わないこと**(`V7-M5-T02` の初版がそれをやって、
 * 親にだけ付与が在る子の行が並ぶ穴を作った)。
 *
 * **突き合わせは {@link grantsTargetingRecord} 1本であり、判定
 * ({@link judgeRecordAccess} → {@link resolveGrantedPermissionNames})とまったく同じ関数を
 * 通る**(`Z-G19` 限定6:**第2の述語を書かない**)。
 *
 * **宣言していない表 / `enabled: false` の表では `false` を返す** —— **オプトインであり、
 * この口の母集団に1行も入らない**(限定5)。**`_id` を持たない行も `false`。**
 *
 * **【壊れた宣言(`grant.target` が無い)では `true` を返す。理由を書く】** ——
 * **その宣言では付与が1件も成立せず、{@link judgeRecordAccess} は全員に対して
 * fail-closed(3つとも `false`)を返す。** **つまりその表の行は本当に誰からも見えない。**
 * **口に並べないと、壊れた宣言の下の行だけが「どこからも見つからない」状態になる。**
 *
 * **【これは「運営が回復できる」ことを意味しない】** —— **本述語は行を**見つける**だけで
 * あり、付与を作れる相手を1ミリも増やさない**(`Z-G19` の「誇張しない」の逐語)。
 */
function isRecordWithoutGrants(params: {
  manifest: Manifest;
  tableId: string;
  row: Record<string, unknown>;
  grantRows: readonly Record<string, unknown>[];
}): boolean {
  const { manifest, tableId, row, grantRows } = params;
  const table = tablesOf(manifest).find((candidate) => candidate?.id === tableId);
  const declared = table === undefined ? undefined : accessControlOf(table);
  if (declared === undefined) {
    return false;
  }
  const recordId = nonEmptyString(row?._id);
  if (recordId === undefined) {
    return false;
  }
  const targeting = grantsTargetingRecord({ declared, recordId, grantRows });
  return targeting === undefined || targeting.length === 0;
}

/**
 * **行1件について、この actor に届いている権限名の集合を返す**(付与の解決の本体)。
 *
 * **`undefined` は「宣言が壊れていて解決できない」の意味である**(呼び出し側は
 * fail-closed に倒すこと)。**空集合は「解決できたが1件も届いていない」である。**
 *
 * **相手の解決は2本**(直接の付与 / グループ経由。**固定3段。再帰は1行も無い**)——
 * **どちらか一致で効く(OR)。** **合成の裁定と理由は {@link judgeRecordAccess} の doc に在る。**
 *
 * **【なぜ切り出したか】** —— **`V7-M3-T03` が「この actor は `creator_permission` を
 * 持っているか」を問う必要が出たためである**(付与を作れるのは行の作成者と運営ロールだけ =
 * `D-V7-14`)。**`read` / `write` / `delete` を計算する場所は今日も
 * {@link judgeRecordAccess} 1本のままであり、本関数はその手前の「名前の解決」だけを持つ。**
 * **2本目の判定を作らないための切り出しである**(同じ解決を2度書かない)。
 */
function resolveGrantedPermissionNames(params: {
  declared: AccessControlDeclaration;
  recordId: string;
  actor: string;
  grantRows: readonly Record<string, unknown>[];
  memberRows: readonly Record<string, unknown>[];
}): Set<string> | undefined {
  const { declared, recordId, actor, grantRows, memberRows } = params;
  // **(1) 相手の解決**: `members.account` が actor と一致するメンバー行から、
  // **その行の `_id`**(直接の付与の突き合わせ先)と、**その行が属するグループの id**
  // (グループ経由の突き合わせ先)の2つを集める。
  const accountField = nonEmptyString(declared.members?.account);
  const memberGroupField = nonEmptyString(declared.members?.group);
  const memberIds = new Set<string>();
  const groupIds = new Set<string>();
  if (accountField !== undefined) {
    for (const member of memberRows) {
      if (member?.[accountField] !== actor) {
        continue;
      }
      const memberId = nonEmptyString(member?._id);
      if (memberId !== undefined) {
        memberIds.add(memberId);
      }
      if (memberGroupField === undefined) {
        continue;
      }
      const groupId = nonEmptyString(member?.[memberGroupField]);
      if (groupId !== undefined) {
        groupIds.add(groupId);
      }
    }
  }

  // **(2) 付与の突き合わせ**: **この表のこの行**を指し、**解決できた相手**(直接 or グループ)
  // を指した付与行だけ。**`grant.member` と `grant.group` はどちらも任意である** ——
  // **どちらか一方だけを宣言した表が実在しうる**(適用時検査が要求しているのは
  // 「少なくとも一方」である)。**両方とも宣言が無い表は fail-closed に倒す。**
  //
  // **【`V7-M5-T02`(`Z-G19`)による更新。旧の綴りを1バイトも消していない】** ——
  // **旧はここで `grantRows` を直接走査し、`grant?.[targetField] !== recordId` の行を
  // `continue` で飛ばしていた。** **今日はその突き合わせを {@link grantsTargetingRecord} へ
  // 切り出し、運営専用の口({@link isRecordWithoutGrants})と**同じ1本**を通す** ——
  // **「付与が0件」を口の側で数え直さないためである**(`Z-G19` 限定6)。
  // **ふるまいは1ミリも変わっていない**(`target` が無い宣言で `undefined` に倒すことも同じ)。
  const memberField = nonEmptyString(declared.grant?.member);
  const groupField = nonEmptyString(declared.grant?.group);
  const permissionField = nonEmptyString(declared.grant?.permission);
  const targeting = grantsTargetingRecord({ declared, recordId, grantRows });
  if (targeting === undefined || permissionField === undefined) {
    return undefined;
  }
  if (memberField === undefined && groupField === undefined) {
    return undefined;
  }
  const names = new Set<string>();
  for (const grant of targeting) {
    // **1件の付与行に相手とグループの両方が書いてあれば、どちらか一致で効く(OR)。**
    const holder = memberField === undefined ? undefined : nonEmptyString(grant?.[memberField]);
    const viaMember = holder !== undefined && memberIds.has(holder);
    const held = groupField === undefined ? undefined : nonEmptyString(grant?.[groupField]);
    const viaGroup = held !== undefined && groupIds.has(held);
    if (!viaMember && !viaGroup) {
      continue;
    }
    const name = nonEmptyString(grant?.[permissionField]);
    if (name !== undefined) {
      names.add(name);
    }
  }
  return names;
}

/**
 * **行1件について、この actor が「読める / 書ける / 消せる」かを判定する**(`Z-G11`)。
 *
 * @param params.manifest 表の宣言を読む元。**書き換えない。**
 * @param params.tableId 判定する表のID。
 * @param params.row 判定する行(**`_id` が付与の突き合わせに要る**)。
 * @param params.actorId 操作者の id。**特定できない実行では `null`** を渡すこと
 *   (**匿名は3つとも false = fail-closed**)。
 * @param params.grantRows 付与表の行(**{@link recordAccessSourceTables} が返した表から
 *   呼び出し側が読む**)。
 * @param params.memberRows メンバー表の行(**相手の解決に要る**: 付与行 → メンバー行 →
 *   `members.account` → actor)。
 *
 * **相手の解決は2本ある**(`V7-M3-T01` / `Z-G1` がグループ経由を足した):
 *  1. **直接の付与**: 付与行 → `grant.member` → `members.account` → actor(`V7-M2-T02`)。
 *  2. **グループ経由の付与**(**固定3段**): 付与行 → `grant.group` → グループ →
 *     `members.group` が同じグループを指すメンバー行 → `members.account` → actor。
 *     **グループの中にグループは入らない**(`Z-G8`。適用時検査がグループ表の自己参照を拒否
 *     するので、入れ子は宣言できない)。**辿る段数は固定であり、再帰は1行も無い。**
 *
 * **【2本を重ねる規則は OR である。この裁定は `V7-M3-T01` が下した】** ——
 * **同じ行に複数の付与が付いていたら、`read` / `write` / `delete` のそれぞれについて、
 * 1件でも真を与える付与があれば真にする。** **理由: 弱い方に倒すと「グループに入れたら
 * 権限が**減った**」という、利用者に説明できない挙動になるためである。**
 *
 * **宣言していない表は3つとも `true` を返す** —— **「この判定は何も絞らない」の意味である。**
 * **呼び出し側が全経路で無条件に重ねても、宣言していない表のふるまいが1ミリも動かない
 * ようにするためである**(オプトイン)。
 */
export function judgeRecordAccess(params: {
  manifest: Manifest;
  tableId: string;
  row: Record<string, unknown>;
  actorId: string | null;
  grantRows: readonly Record<string, unknown>[];
  memberRows: readonly Record<string, unknown>[];
}): RecordAccessVerdict {
  const { manifest, tableId, row, actorId, grantRows, memberRows } = params;
  const table = tablesOf(manifest).find((candidate) => candidate?.id === tableId);
  const declared = table === undefined ? undefined : accessControlOf(table);
  if (declared === undefined) {
    return UNGOVERNED_RECORD_ACCESS;
  }
  const actor = nonEmptyString(actorId);
  if (actor === undefined) {
    return NO_RECORD_ACCESS;
  }
  const recordId = nonEmptyString(row?._id);
  if (recordId === undefined) {
    return NO_RECORD_ACCESS;
  }

  // **(1) 相手の解決**: `members.account` が actor と一致するメンバー行から、
  // **その行の `_id`**(直接の付与の突き合わせ先)と、**その行が属するグループの id**
  // (グループ経由の突き合わせ先)の2つを集める。
  // **同じ人のメンバー行が複数あることは規約が止めていない**(`v7-m0.md` §5-2 (d))——
  // **集合にするので結果は変わらない。** **1人が2グループに属するならメンバー行が2つになり、
  // 集合には2つのグループが入る。**
  //
  // **【グループの一致は id の一致で決まる】** —— **適用時検査
  // (`src/kernel/referential-integrity.ts`)が、`grant.group` と `members.group` の両方に
  // ついて「宣言されたグループ表を参照する reference 項目であること」を要求している。**
  // **したがって両者の値は同じグループ表の行 id であり、id の一致でグループが一致する。**
  //
  // **【`V7-M3-T05` が変えた点。本関数の外に在る】** —— **`V7-M3-T01` は「グループ表の行を
  // 1行も読まない」を採り、その帰結として「消えたグループ行を指す付与は、メンバー行が同じ
  // id を指したままなら今日も効く」を限界として `V7-M3-T05` へ送っていた。**
  // **今日は {@link grantsWithExistingGroups} が判定の**手前**でその付与のグループの値を
  // `null` にするので、消えたグループ経由では1件も解決しない。**
  // **本関数の入力は今日も6本のままである**(`ADR-0294` 限定5 の機械的な固定)——
  // **付与行を整えるのは呼び出し側であり、その出どころは検査が固定している。**
  const names = resolveGrantedPermissionNames({
    declared,
    recordId,
    actor,
    grantRows,
    memberRows,
  });
  if (names === undefined || names.size === 0) {
    return NO_RECORD_ACCESS;
  }

  // **(3) 権限名を宣言で解く。** **宣言に無い名前は1ミリも効かない**(付与**行**の値のずれを
  // 適用時に止めていないことの帰結。`ADR-0292` §9 の5 / §限界3)。**複数の付与は or で重なる。**
  const permissions = Array.isArray(declared.permissions) ? declared.permissions : [];
  let read = false;
  let write = false;
  let remove = false;
  for (const permission of permissions) {
    const id = nonEmptyString(permission?.id);
    if (id === undefined || !names.has(id)) {
      continue;
    }
    read = read || permission?.read === true;
    write = write || permission?.write === true;
    remove = remove || permission?.delete === true;
  }
  return { read, write, delete: remove };
}

// --- 付与の引き継ぎ(多段。`Z-G14` / `Z-G15` / `Z-G16`。V7-M4-T02)-------------------------
//
// **親の行に付いた権限を、子・孫の行にも**判定の側**で届かせる。**
//
// **【却下の先例への回答は `v7-m0.md` §5-10 に在る。ここには実装の形だけを書く】**
//  1. **辿るのは判定のためであり、辿った先の行を1件も**返さない**。**
//     **`related` が返す行の集合は1件も変わらない**(`src/server/access-control-inheritance.test.ts` の (G))。
//  2. **ミニ言語を1文字も作らない。** **`inherit_from` に書けるのは**自表の `reference`
//     フィールドID**の配列(0..2件)だけで、`$record.<ref>.<field>` の形も演算子も条件式も
//     1つも書けない**(値域は `schemas/manifest.schema.json` が固定している)。
//  3. **1ホップに閉じた4条文(`ADR-0079` 限定3 / `ADR-0044` 限定3 / `ADR-0081` 限定5 /
//     `ADR-0083` 限定5)を1バイトも引き直していない。** **4本の1ホップは今日のまま残る。**
//  4. **【非対称は残る。隠さない】** **同じ製品の中に「1ホップの辿り方」が4本と
//     「多段まで辿る判定」が1本、並ぶ状態になった**(`Z-G14` 限定8)。

// --- 引き継ぎを辿るときの上限(`Z-G17`。V7-M4-T04)------------------------------------
//
// **【この上限を置く理由。性能ではない】** —— **黙って打ち切ると、その結果が
// 「隠れた行がある」と区別できないからである。** **辿りきれないまま「見えない」を返すと、
// アプリを作る人にも使う人にも、それが「権限が無い」なのか「辿るのをやめた」なのかが
// 分からない。** **上限に当たったら**明示して拒否**し、応答の形で区別できるようにする**
// (`v7-m0.md` §5-5 (b) / §6-4b の3)。**【禁止】この上限を「性能上の都合」と書かない。**
//
// **【置き場所。先例と同じ作法だとは書かない】** —— **最も近い先例は
// `src/kernel/records.ts:1055` の `export const MAX_FILTER_DEPTH = 8;` である。**
// **あちらは `src/kernel/` に在り、こちらは `src/server/` に在る。** **置き場所が違うので
// 「同じ作法である」とは書けない。** **`src/server/` に置いたのは `Z-G17` の門外(Δ7)が
// 「`schemas/` にも `src/kernel/` にも1バイトも差分を出さない」ことに依存しているから
// であり、その対価は**アプリを作る人が上限をマニフェストから読めない**ことである
// (`v7-m0.md` §6-4 `Z-G17` `S5` の「門外の対価」)。

/**
 * **辿ってよい段数の上限**(`D-V7-16`)。
 *
 * **対象の行を段0 とし、`access_control.inherit_from` が指す親を段1、その親を段2 …と
 * 数える。** **段5 までは辿ってよい。** **段6 に進もうとした時点で
 * {@link resolveRecordAccess} は `limit_exceeded` / `limit: "depth"` を返す。**
 */
export const MAX_RECORD_ACCESS_INHERIT_DEPTH = 5;

/**
 * **1回の判定で辿って読む行の合計の上限**(`v7-m0.md` §5-5 (b))。
 *
 * ## **数え方(逐語。実装と ADR の限界に同じ文を置く)**
 *
 * **1回の判定ごとに数える。** **数えるのは
 * **(a) `readRow` で読んだ親の行**と
 * **(b) 親の段で `readRows` から取り出した付与行・メンバー行・グループ行の件数**である。**
 * **キャッシュに当たったかどうかに関係なく、その判定が参照した行数として数える**
 * (数え方が呼び出し側のまとめ読みに左右されないようにするため)。
 * **段0(対象の表)の付与行・メンバー行は数えない** —— **それは1リクエストにつき1度読む
 * ものであって、1判定あたりの辿りの費用ではないためである。**
 *
 * **合計が 1000 を超えたら**(= 1001 行目で){@link resolveRecordAccess} は
 * `limit_exceeded` / `limit: "rows"` を返す。**
 */
export const MAX_RECORD_ACCESS_INHERIT_ROWS = 1000;

/**
 * **{@link resolveRecordAccess} の答え。**
 *
 * **今日の枝は `verdict` の1本だけである。** **判別可能なユニオンの形で置いてあるのは、
 * `V7-M4-T04`(`Z-G17`)が「段数・件数の上限に当たったので判定できません」を
 * **別の枝**として足すためである** —— **上限に当たった状態と「本当に見えない」状態を
 * 応答の上で区別する**(`v7-m4.md` の `V7-M4-T04` の完了条件 (iii))。
 * **その枝は本タスクでは1バイトも実装していない。**
 *
 * ## **【`V7-M4-T04`(`Z-G17`)による更新。旧文を1バイトも消していない】**
 *
 * **上の「今日の枝は `verdict` の1本だけである」「その枝は本タスクでは1バイトも
 * 実装していない」は、`V7-M4-T02` を書いた時点の記述である。** **今日は枝が2本ある** ——
 * **`limit_exceeded` を `V7-M4-T04` が足した。**
 *
 * **3状態の対応**(裁定は `v7-m0.md` §6-4b の3):
 *  - **(a) 上限に当たった** … `kind: "limit_exceeded"`。**呼び出し側は 4xx にし、
 *    上限の種別(段数 / 件数)をエラー本文から読み取れるようにする。**
 *  - **(b) 循環した** … `kind: "verdict"`(**正常完了**)。**訪問済み集合が同じ (表, 行) を
 *    2度辿らないだけで、拒否には落ちない**(`Z-G16` 限定3)。
 *  - **(c) 本当に見えない** … `kind: "verdict"` で `read: false`。**呼び出し側は 404 か
 *    一覧から落とすだけで、エラー本文を持たない。**
 */
export type RecordAccessResolution =
  | {
      readonly kind: "verdict";
      readonly verdict: RecordAccessVerdict;
    }
  /**
   * **辿る段数(`MAX_RECORD_ACCESS_INHERIT_DEPTH`)か、辿って読む行の合計
   * (`MAX_RECORD_ACCESS_INHERIT_ROWS`)の上限に当たったので、判定を出せなかった。**
   *
   * **「見えない」ではない。** **呼び出し側はこれを `read: false` に丸めてはならない** ——
   * **丸めた瞬間に、上限に当たった状態と「本当に見えない」状態が区別できなくなる。**
   */
  | {
      readonly kind: "limit_exceeded";
      readonly limit: "depth" | "rows";
    };

/**
 * **行1件について、引き継ぎ(`inherit_from`)を辿ったうえで「読める / 書ける / 消せる」を
 * 決める**(`Z-G14`)。
 *
 * @param params.manifest 表の宣言を読む元。**書き換えない。**
 * @param params.tableId 判定する表のID(**段0**)。
 * @param params.row 判定する行(**`_id` が付与の突き合わせに要る**)。
 * @param params.actorId 操作者の id。**特定できない実行では `null`**(匿名は fail-closed)。
 * @param params.readRows 表IDを渡すとその表の**全行**を返すコールバック。
 *   **本関数は I/O を1つも持たない** —— **読み出しは呼び出し側の責務である**
 *   ({@link judgeGrantWrite} が先に採った形と同じ。`Z-G14` 限定7 =
 *   **`src/kernel/` に1バイトも差分を出さない**)。
 *   **呼び出し側は同じ表を2度読まないようメモ化すること。**
 * @param params.readRow 表IDと行IDを渡すとその1行を返すコールバック(**親の行を引く**)。
 *
 * ## **辿り方(`Z-G14` 限定3: 各段で適用する規則は同一)**
 *
 * **対象の行を段0 とし、`access_control.inherit_from` が指す `reference` 項目の値
 * (親の行ID)を辿る。** **各段でその段の表の宣言に対して {@link judgeRecordAccess} を
 * 呼び、得られた `read` / `write` / `delete` を **OR** で重ねる。**
 * **段ごとに違う規則を書ける場所は1つも無い。**
 *
 * ## **【最重要。fail-closed】宣言していない親は、判定に1ミリも寄与しない**
 *
 * **{@link judgeRecordAccess} は宣言していない表(または `enabled: false` の表)に対して
 * 3つとも `true` を返す** —— **それは「この判定は何も絞らない」の意味であって
 * 「全員に全権がある」ではない。** **引き継ぎの経路でその答えを OR に混ぜると、
 * **宣言していない親を1つ挟むだけで全員に全権が届く**穴になる。**
 * **したがって本関数は、宣言していない親をそこで打ち切る**(検査は
 * `src/server/access-control-inheritance.test.ts` の (D))。
 *
 * ## **黙って飛ばす枝(判定は正常に続く)**
 *
 *  1. **`inherit_from` が空 / 未宣言** —— **辿る先が1つも無い。**
 *  2. **`inherit_from` が指す項目が実在しない / `reference` でない**(適用時検査が拒否する
 *     形だが、述語の側で例外を投げると読取経路が 500 になる)。
 *  3. **親を指していない行**(参照の値が空)。
 *  4. **親の行が読めない**(消えている等)。
 *
 * ## **止まり方**
 *
 * **訪問済み集合(`表ID + 行ID` の対)を持ち、1回の判定の中で同じ (表, 行) を2度訪れない。**
 * **これは停止性のための最低限である**(`Z-G16`。**専用の検査は `V7-M4-T03` が置く**)。
 * **段数と読む行の上限は今日1つも無い**(`Z-G17` / `V7-M4-T04` の担当)。
 *
 * ## **【`V7-M4-T04`(`Z-G17`)による更新。旧文を1バイトも消していない】**
 *
 * **上の「段数と読む行の上限は今日1つも無い」は `V7-M4-T02` を書いた時点の記述である。**
 * **今日は上限が2本ある** —— {@link MAX_RECORD_ACCESS_INHERIT_DEPTH}(段数5)と
 * {@link MAX_RECORD_ACCESS_INHERIT_ROWS}(読む行の合計1000)。
 * **上限に当たったら `verdict` を返さず `limit_exceeded` を返す** ——
 * **黙って空(`read: false`)に丸めない。**
 *
 * ### **段数の数え方**
 *
 * **対象の行を段0 とし、`inherit_from` が指す親を段1、その親を段2 …と数える。**
 * **段5 までは辿ってよい。段6 に進もうとしたら `limit_exceeded` / `limit: "depth"`。**
 *
 * ### **件数の数え方(1回の判定ごと。逐語)**
 *
 * **その判定の中で辿って読んだ行の合計。** **数えるのは
 * **(a) `readRow` で読んだ親の行**と
 * **(b) 親の段で `readRows` から取り出した付与行・メンバー行・グループ行の件数**である。**
 * **キャッシュに当たったかどうかに関係なく、その判定が参照した行数として数える**
 * (数え方が呼び出し側のまとめ読みに左右されないようにするため)。
 * **段0(対象の表)の付与行・メンバー行は数えない** —— **それは1リクエストにつき1度読む
 * ものであって、1判定あたりの辿りの費用ではないためである。**
 * **合計が 1000 を超えたら**(= 1001 行目で)`limit_exceeded` / `limit: "rows"`。
 *
 * ### **循環との優先順位(`Z-G16` を壊していない)**
 *
 * **訪問済み集合が先に効く。** **同じ (表, 行) は2度訪れないので、環は上限に当たる前に
 * **正常完了**する**(`src/server/access-control-cycle.test.ts` の (d) がこれを固定して
 * いる)。**ただし環の長さが5段を超えるときは段数の上限が先に当たる** ——
 * **したがって「循環は必ず正常完了する」とは書けない。**
 *
 * ## **【代償を正直に書く】**
 *
 *  - **全件をメモリに読む post-filter の上に多段が乗る**(`Z-G14` 限定9)。
 *    **一覧の行1件ごとに親を辿るので、計算量は (行数 × 段数) である。**
 *  - **上限がまだ無い** —— **深い木を作れば、1回の要求で読む行数に歯止めが無い。**
 *  - **どこで遅くなるかは1件も測っていない。**
 *  - **【`V7-M4-T04` の注】上の「上限がまだ無い」は今日は当たらない**(上限は2本ある)。
 *    **「どこで遅くなるかは1件も測っていない」は今日も当たる** —— **上限の値 5 / 1000 に
 *    実測の根拠は1件も無い。** **`schemas/` にも語彙にも書いていないので、
 *    アプリを作る人はマニフェストから上限を読めない。**
 */
/**
 * **引き継ぎを辿る途中で、1段ぶん取り出したもの**(`V7-M5-T02` が切り出した)。
 *
 * **`grantRows` / `groupRows` / `memberRows` は `readRows` が返したそのままである** ——
 * **`grantsWithExistingGroups` は通していない。** **通すのは受け取った側の責務である**
 * (**判定に渡すなら必ず通すこと**。`Z-G32`)。
 */
type AccessInheritanceStep = {
  readonly tableId: string;
  readonly row: Record<string, unknown>;
  readonly depth: number;
  readonly grantRows: readonly Record<string, unknown>[];
  readonly groupRows: readonly Record<string, unknown>[];
  readonly memberRows: readonly Record<string, unknown>[];
};

/** {@link walkAccessInheritance} の結果。**上限に当たったら段の訪問はそこで終わる。** */
type AccessInheritanceWalk =
  | { readonly kind: "completed" }
  | { readonly kind: "limit_exceeded"; readonly limit: "depth" | "rows" };

/**
 * **引き継ぎ(`inherit_from`)を辿り、各段を1度ずつ渡す**(`Z-G14` / `Z-G16` / `Z-G17`)。
 *
 * ## **【`V7-M5-T02` が切り出した。旧の形と、何を変えていないかを書く】**
 *
 * **この走査は `V7-M4-T02` が {@link resolveRecordAccess} の中に書いたものそのものである。**
 * **`V7-M5-T02`(`Z-G19`)が「引き継ぎのどの段にも付与が無い行」を要るようになったので、
 * **走査だけ**をここへ出し、段ごとに何をするかは呼び出し側のコールバックに残した。**
 * **辿り方・止まり方・数え方を1バイトも変えていない** —— **訪問済み集合(`Z-G16`)、
 * 段数の上限 {@link MAX_RECORD_ACCESS_INHERIT_DEPTH}、辿って読む行の上限
 * {@link MAX_RECORD_ACCESS_INHERIT_ROWS}、段0 を数えない数え方まで同じである。**
 * **【禁止】新しい上限をここに足さない**(2本のままである)。
 *
 * **【2つの呼び出し側が同じ走査を通ることの意味】** —— **「誰にも見えない行」の一覧
 * (`Z-G19`)と、行1件の判定(`Z-G14`)が、**同じ段の集合**を見る。**
 * **別々に辿ると、判定は親を見ているのに一覧は見ていない、という食い違いが起きうる**
 * —— **その食い違いは「他人には見えている行が取り残しとして並ぶ」という形で表に出る。**
 */
function walkAccessInheritance(params: {
  manifest: Manifest;
  tableId: string;
  row: Record<string, unknown>;
  readRows: (tableId: string) => readonly Record<string, unknown>[];
  readRow: (tableId: string, recordId: string) => Record<string, unknown> | undefined;
  visit: (step: AccessInheritanceStep) => void;
}): AccessInheritanceWalk {
  const { manifest, tableId, row, readRows, readRow, visit } = params;

  /** 訪問済みの (表, 行)。**同じ対を2度訪れない**(`Z-G16`)。 */
  const visited = new Set<string>();
  const pending: { tableId: string; row: Record<string, unknown>; depth: number }[] = [
    { tableId, row, depth: 0 },
  ];
  /**
   * **辿って読んだ行の合計**(`Z-G17`)。**数え方は {@link resolveRecordAccess} の doc の
   * 逐語のとおりで、段0 の付与行・メンバー行は数えない。**
   */
  let traversedRows = 0;

  while (pending.length > 0) {
    const current = pending.shift() as {
      tableId: string;
      row: Record<string, unknown>;
      depth: number;
    };
    const currentId = nonEmptyString(current.row?._id);
    if (currentId === undefined) {
      continue;
    }
    // **鍵は (表ID, 行ID) の対を JSON 1個にしたものである** —— **区切り文字を自分で選ぶと、
    // その文字が値に現れたときに別々の対が同じ鍵になりうる。** **JSON なら衝突しない。**
    const key = JSON.stringify([current.tableId, currentId]);
    if (visited.has(key)) {
      continue;
    }
    visited.add(key);

    // **宣言していない段は、判定に1ミリも寄与しない**(fail-closed)——
    // **その段には `inherit_from` も無いので、ここで枝が終わる。**
    const sources = recordAccessSourceTables(manifest, current.tableId);
    if (sources === undefined) {
      continue;
    }

    // **どの段でも同じ行を読む**(限定3: 各段で適用する規則は同一)。
    const rowsOf = (id: string | undefined): readonly Record<string, unknown>[] =>
      id === undefined ? [] : readRows(id);
    const stepGrantRows = rowsOf(sources.grantTable);
    const stepGroupRows = rowsOf(sources.groupTable);
    const stepMemberRows = rowsOf(sources.memberTable);
    // **件数を数える**(`Z-G17`)。**段0 は数えない** —— **1リクエストにつき1度読むもので
    // あって、1判定あたりの辿りの費用ではないためである。** **キャッシュに当たったかどうかに
    // 関係なく、その判定が参照した行数として数える。**
    if (current.depth > 0) {
      traversedRows += stepGrantRows.length + stepGroupRows.length + stepMemberRows.length;
      if (traversedRows > MAX_RECORD_ACCESS_INHERIT_ROWS) {
        return { kind: "limit_exceeded", limit: "rows" };
      }
    }
    visit({
      tableId: current.tableId,
      row: current.row,
      depth: current.depth,
      grantRows: stepGrantRows,
      groupRows: stepGroupRows,
      memberRows: stepMemberRows,
    });

    // **親を積む。** **辿るのは `inherit_from` が名指しした `reference` 項目だけである。**
    const table = tablesOf(manifest).find((candidate) => candidate?.id === current.tableId);
    const declared = table === undefined ? undefined : accessControlOf(table);
    const inheritFrom = Array.isArray(declared?.inherit_from) ? declared.inherit_from : [];
    for (const fieldId of inheritFrom) {
      const field = table?.fields?.find((candidate) => candidate?.id === fieldId);
      if (field === undefined || field.type !== "reference") {
        continue;
      }
      const parentTableId = nonEmptyString(field.reference_table);
      const parentRecordId = nonEmptyString(current.row[fieldId]);
      if (parentTableId === undefined || parentRecordId === undefined) {
        continue; // **親を指していない行では、この枝を黙って飛ばす。**
      }
      // **訪問済み集合が先に効く**(`Z-G16` の優先順位)—— **同じ (表, 行) は2度訪れないので、
      // 環は上限に当たる前に正常完了する。** **ただし環の長さが5段を超えるときは、下の
      // 段数の上限が先に当たる**(「循環は必ず正常完了する」とは書けない)。
      if (visited.has(JSON.stringify([parentTableId, parentRecordId]))) {
        continue;
      }
      // **段6 に進もうとした**(`Z-G17`)—— **読む前に止める。** **黙って打ち切らず、
      // 上限に当たったことを呼び出し側へ返す。**
      // **【正直に書く】親の行がすでに消えていても、ここで止まる** —— **実在を確かめるには
      // 1行読む必要があり、それは「段6 に進む」ことそのものだからである。**
      if (current.depth + 1 > MAX_RECORD_ACCESS_INHERIT_DEPTH) {
        return { kind: "limit_exceeded", limit: "depth" };
      }
      const parentRow = readRow(parentTableId, parentRecordId);
      if (parentRow === undefined) {
        continue; // **親の行が読めない** —— **その親は判定に寄与しない。**
      }
      // **`readRow` で読んだ親の行を1件として数える**(`Z-G17` の数え方の (a))。
      traversedRows += 1;
      if (traversedRows > MAX_RECORD_ACCESS_INHERIT_ROWS) {
        return { kind: "limit_exceeded", limit: "rows" };
      }
      pending.push({ tableId: parentTableId, row: parentRow, depth: current.depth + 1 });
    }
  }

  return { kind: "completed" };
}

export function resolveRecordAccess(params: {
  manifest: Manifest;
  tableId: string;
  row: Record<string, unknown>;
  actorId: string | null;
  readRows: (tableId: string) => readonly Record<string, unknown>[];
  readRow: (tableId: string, recordId: string) => Record<string, unknown> | undefined;
}): RecordAccessResolution {
  const { manifest, tableId, row, actorId, readRows, readRow } = params;

  // **段0 の表が宣言していなければ、今日どおり「この判定は何も絞らない」を返す** ——
  // **{@link judgeRecordAccess} と1ミリも違わないふるまいである**(オプトイン)。
  if (recordAccessSourceTables(manifest, tableId) === undefined) {
    return { kind: "verdict", verdict: UNGOVERNED_RECORD_ACCESS };
  }

  let read = false;
  let write = false;
  let remove = false;
  // **辿り(訪問済み集合・段数・件数の上限)は {@link walkAccessInheritance} が持つ** ——
  // **`V7-M5-T02` が切り出しただけで、辿り方も止まり方も数え方も1バイトも変えていない。**
  // **各段でやることは今日もここに在る**(**判定を呼んで OR で重ねる**)。
  const walked = walkAccessInheritance({
    manifest,
    tableId,
    row,
    readRows,
    readRow,
    visit: (step) => {
      // **消えたグループ行を指す付与は、どの段でも1件も解決しない**(`Z-G32` / `V7-M3-T05`)
      // —— **段0 と親で違う整え方をしない**(限定3: 各段で適用する規則は同一)。
      const grantRows = step.grantRows;
      const verdict = judgeRecordAccess({
        manifest,
        tableId: step.tableId,
        row: step.row,
        actorId,
        grantRows: grantsWithExistingGroups({
          manifest,
          tableId: step.tableId,
          grantRows,
          groupRows: step.groupRows,
        }),
        memberRows: step.memberRows,
      });
      read = read || verdict.read;
      write = write || verdict.write;
      remove = remove || verdict.delete;
    },
  });
  if (walked.kind === "limit_exceeded") {
    return walked;
  }

  return { kind: "verdict", verdict: { read, write, delete: remove } };
}

/**
 * **{@link resolveRecordWithoutGrants} の答え**(`Z-G19` / `V7-M5-T02`)。
 *
 * **枝は {@link RecordAccessResolution} と同じ2本である** —— **上限に当たったことを
 * 「取り残しではない」に丸めない**(丸めると、辿りきれなかった行が黙って一覧から
 * 落ちて、運営者には「取り残しは無い」と読めてしまう)。
 */
type RecordOrphanResolution =
  | { readonly kind: "orphan"; readonly orphan: boolean }
  | { readonly kind: "limit_exceeded"; readonly limit: "depth" | "rows" };

/**
 * **その行が「誰にも見えない行」か**(`Z-G19` / `V7-M5-T02`。**運営専用の口の母集団**)。
 *
 * **真になるのは次の2つを**両方**満たすときだけである**:
 *  - **(a)** その行を直接指す付与が0件({@link isRecordWithoutGrants})。
 *  - **(b)** **引き継ぎ(`inherit_from`)を辿った先のどの段にも、付与が1件も無い。**
 *
 * ## **【`Z-G19` 限定(1) の読み方。逐語で書く】**
 *
 * **限定(1) は「並ぶのは付与が0件の行だけ」である。** **これは**必要条件**であって
 * 十分条件ではない。** **(b) を足して母集団を**狭める**のは、限定(1) に1ミリも反しない**
 * —— **並ぶ行はすべて「付与が0件の行」のままだからである。**
 * **狭めた理由は `01-record-access-grant-baseline.md` §7 の `V7-M5` の完了の考え方 (ii) の
 * 逐語「**『誰にも見えない行』を見つける道が実在し、それが (i) の壁を迂回する新しい
 * 抜け道になっていないこと。**」である** —— **(b) が無いと、親にだけ付与が在る子の行が
 * この口に並び、他人には見えているその行の中身を運営が読めてしまう**(実測で確認した穴。
 * `src/server/record-access-orphans.test.ts` の (Y-1))。
 *
 * ## **【第2の述語を書いていない】**(`Z-G19` 限定6)
 *
 * **各段の突き合わせは {@link isRecordWithoutGrants} → {@link grantsTargetingRecord} で
 * あり、判定({@link judgeRecordAccess} → {@link resolveGrantedPermissionNames})が
 * 通るのとまったく同じ1本である。** **辿りも {@link walkAccessInheritance} 1本を
 * {@link resolveRecordAccess} と共有している** —— **上限も新しく作っていない。**
 *
 * ## **【これが意味しないこと。誇張しない】**
 *
 * **「運営が回復できる」ことを1ミリも意味しない** —— **本関数は行を**見つける**だけで
 * あり、付与を作れる相手を1人も増やさない**(`Z-G19` の「誇張しない」の逐語)。
 */
export function resolveRecordWithoutGrants(params: {
  manifest: Manifest;
  tableId: string;
  row: Record<string, unknown>;
  readRows: (tableId: string) => readonly Record<string, unknown>[];
  readRow: (tableId: string, recordId: string) => Record<string, unknown> | undefined;
}): RecordOrphanResolution {
  const { manifest, tableId, row, readRows, readRow } = params;

  // **宣言していない表 / `enabled: false` の表は、この口の母集団に1行も入らない**
  // (オプトイン。`Z-G19` 限定5)。
  if (recordAccessSourceTables(manifest, tableId) === undefined) {
    return { kind: "orphan", orphan: false };
  }

  let orphan = true;
  const walked = walkAccessInheritance({
    manifest,
    tableId,
    row,
    readRows,
    readRow,
    visit: (step) => {
      // **どの段でも同じ突き合わせを当てる**(限定3: 各段で適用する規則は同一)——
      // **1段でも付与が在れば、その行は「誰にも見えない行」ではない。**
      // **相手が誰かは1ミリも見ていない** —— **他人への付与でも、運営自身への付与でも、
      // 相手が解決できない付与でも、1件あれば真は落ちる。**
      if (
        !isRecordWithoutGrants({
          manifest,
          tableId: step.tableId,
          row: step.row,
          grantRows: step.grantRows,
        })
      ) {
        orphan = false;
      }
    },
  });
  if (walked.kind === "limit_exceeded") {
    return walked;
  }
  return { kind: "orphan", orphan };
}

/**
 * **{@link resolveRecordUnreachableByRoles} の答え**(`V8-M41` / 台帳 `F-G13`)。
 *
 * **`kind` は `"orphan"` 1本だけである** —— **{@link resolveRecordWithoutGrants} と同じ形に
 * そろえてあるので、呼び出し側(運営専用の口)は2つの答えを同じ `switch` で扱える。**
 * **上限(`limit_exceeded`)の枝を持たないのは、本述語が他の表を1行も読まないからである**
 * (辿りが無いので上限に当たりようがない)。
 *
 * - `orphan` … **その行が「面(役割の規則)から誰にも届かない行」か。**
 * - `undecided` … **断定できなかったか**(**条件つきの規則が関与した**)。
 *   **真のとき `orphan` は必ず `false` である** —— **伏せる側に倒している。**
 */
export type RoleUnreachableResolution = {
  readonly kind: "orphan";
  readonly orphan: boolean;
  readonly undecided: boolean;
};

/**
 * **その行が「面(役割の規則)から誰にも届かない行」か**(`V8-M41` / 台帳 `F-G13`)。
 *
 * **`v8-m35.md` §5-1 の `F-G13` の限定の逐語**: 「**運営専用の口だけを広げる。**
 * **一般の一覧・単件の伏せ方(`ADR-0317` 限定5)を1バイトも動かさない**」。
 *
 * ## なぜこの述語が要るのか(**着手前の実測**)
 *
 * **`v8-m33.md` §12 の `D-13` の逐語**: 「**`diaries` には行が1行実在するのに 404 を返す。**
 * **この口が拾うのは `access_control` を宣言した表だけである**」。
 * **点(行ごとの付与)を宣言していない表では、行が誰にも届かなくなる道が**面**の側に在る** ——
 * **`V8-M26`(`D-V8-45` / `D-V8-58` / `D-V8-65`)が既定を閉じたので、その表を名指しした規則が
 * 1本も無ければ、どの役割からもその行は読めない。** **{@link resolveRecordWithoutGrants} は
 * 付与の有無しか見ないので、この行を1件も拾えない。**
 *
 * ## **判定の家を増やしていない**(`ADR-0061` 限定4)
 *
 * **可否を決めているのは {@link judgeRoleAccess} 1本だけである。** **本述語が持っているのは
 * 「誰について呼ぶか」(= 宣言された役割を1つずつと、未ログイン1回)と、その結果の畳み方
 * だけであり、規則(`rules`)も条件(`when`)も1バイトも読んでいない。**
 *
 * ## **条件(`when`)つきの規則は「断定できない」に倒す**(**限界。隠さない**)
 *
 * **本述語は主体(要求している人)を渡さずに判定する**(`subject: null`)——
 * **「誰にも届かない」は特定の1人についての問いではないからである。**
 * **その結果 `{field, equals_current_user}` の葉は必ず偽になるので、条件つきの規則で外れた行を
 * 「誰にも届かない」と読むと嘘になりうる**(**その行の持ち主本人には見えているかもしれない**)。
 * **したがって条件が関与した判定は `undecided: true` にし、`orphan` を `false` に倒す** ——
 * **並べない側に倒す。**
 *
 * **【この向きを選んだ理由】** —— **`record-access-orphans.test.ts` の (Y-1) が点の側で
 * 固定しているのと同じ向きである**(**他人には見えている行を、この口から運営に見せない**)。
 * **【正直に書く】** **その代償として、条件つきの規則だけで閉じた行は今日この口に1件も
 * 並ばない。** **固定しているのは `src/server/role-unreachable-records.test.ts` の (D-2)。**
 *
 * ## **これが意味しないこと**(`Z-G19` の「誇張しない」を引き継ぐ)
 *
 * **「運営が回復できる」ことを1ミリも意味しない** —— **本述語は行を**見つける**だけであり、
 * 規則を書ける相手も、規則を書く手段も、1つも増やしていない。**
 *
 * @param manifest マニフェスト(役割の宣言の在り処)。
 * @param tableId **判定する表のID。**
 * @param row **判定する行**(条件つきの規則を評価するために要る)。
 */
export function resolveRecordUnreachableByRoles(params: {
  manifest: unknown;
  tableId: string;
  row: Record<string, unknown>;
}): RoleUnreachableResolution {
  const target: RoleAccessTarget = { target: "table", table: params.tableId };
  // **宣言された役割を1つずつ + 未ログイン(`null` = `anonymous`)を1回。**
  // **`null` を落とさない** —— **匿名公開の窓が開いている表では、未ログインが実際に読める。**
  const candidates: ActorRoles[] = [
    ...declaredRoleIds(params.manifest).map((id) => [id] as readonly string[]),
    null,
  ];
  let undecided = false;
  for (const roles of candidates) {
    const decision = judgeRoleAccess({
      manifest: params.manifest,
      roles,
      target,
      verb: "read",
      row: params.row,
      // **主体を渡さない** —— **上の doc の「断定できないに倒す」の実体である。**
      subject: null,
    });
    if (decision.allowed) {
      // **1人でも読めるなら取り残しではない**(`governed: false` の素通りもここに落ちる ——
      // **システムが持つ表は面の判定を1度も受けないので、必ずこの枝になる**)。
      return { kind: "orphan", orphan: false, undecided: false };
    }
    if (decision.conditional) {
      undecided = true;
    }
  }
  return { kind: "orphan", orphan: !undecided, undecided };
}

// --- 作成者への自動付与(`D-V7-23` / `creator_permission`。V7-M3-T02)---------------------
//
// **`v7-m0.md` §5-5 (a) の裁定**: **メンバー表に行が無い人の作成は 400 で拒否する。**
// **理由の逐語**: 「**`D-V7-23` の自動付与は相手をメンバー表の行で解決するので、行が無いと
// 解決できない。作成を通すと『作った本人にも見えない行』が黙って生まれる**」。
//
// **【本述語は I/O を1つも持たない】** —— **メンバー表の行は呼び出し側が読んで渡す**
// (`judgeRecordAccess` と同じ作法)。**返すのは「何を書けばよいか」の計画だけであり、
// 書き込みは呼び出し側(`src/server/app.ts`)が行う。**
//
// **【判定そのものは足していない】** —— **「作った人に何が渡るか」は
// {@link judgeRecordAccess} が下見の1件で答える。** **本述語は下見に使う行を組み立てるだけで
// あり、`read` / `write` / `delete` を1つも計算しない**(判定の家は今日も1本である)。

/** 下見(まだ実在しない行)に使う `_id`。**この値がディスクに書かれることは1度も無い。** */
const CREATOR_PREVIEW_RECORD_ID = "(これから作る行)";

/**
 * **作成者への自動付与の計画**(`D-V7-23`)。
 *
 * - `"no_member"` … **メンバー表に行が無い**(または利用者の表を宣言していない)。
 *   **呼び出し側は 400 で拒否する**(`v7-m0.md` §5-5 (a))。
 * - `"unusable"` … **付与を書き込む表が宣言から決まらない。** **通すと「作った本人にも
 *   見えない行」が生まれるので、呼び出し側は 400 で拒否する**(fail-closed)。
 * - `"grant"` … **下見用の行・付与行と、実際に書き込む付与行の値を持つ。**
 */
export type CreatorGrantPlan =
  | { readonly kind: "no_member" }
  | { readonly kind: "unusable" }
  | {
      readonly kind: "grant";
      /** 付与行を1件作る先の表ID。 */
      readonly grantTable: string;
      /** 下見に使う「これから作る行」。**`judgeRecordAccess` の `row` に渡す。** */
      readonly previewRow: Record<string, unknown>;
      /** 下見に使う「これから入れる付与行」。**同じく `grantRows` に渡す。** */
      readonly previewGrant: Record<string, unknown>;
      /** 実際に書き込む付与行の値(作成できた行の `_id` を渡して組む)。 */
      readonly grantValues: (recordId: string) => Record<string, unknown>;
    };

/**
 * **その表に行を作ろうとしている actor について、作成者への自動付与の計画を返す。**
 *
 * **宣言していない表 / `enabled: false` の表では `undefined`** —— **呼び出し側は今日どおりの
 * 処理を続ける**(オプトインの実体。{@link recordAccessSourceTables} と同じ約束)。
 *
 * @param params.memberRows メンバー表の行(**呼び出し側が読む**)。
 *
 * **【グループを1つも見ない】** —— **自動付与の相手は「作った本人のメンバー行」1件だけで
 * ある。** **本人が属するグループに配るのは別の要求であり、今日その形は1バイトも無い。**
 *
 * **【同じ人のメンバー行が複数あるとき】** —— **最初に見つけた1行を使う**(規約は重複を
 * 止めていない。`v7-m0.md` §5-2 (d))。**どれを選んでも `judgeRecordAccess` の結果は
 * 変わらない**(相手の解決は集合で行うため)が、**付与行に書かれる id は1つに決まる。**
 */
export function creatorGrantPlan(params: {
  manifest: Manifest;
  tableId: string;
  actorId: string | null;
  memberRows: readonly Record<string, unknown>[];
}): CreatorGrantPlan | undefined {
  const { manifest, tableId, actorId, memberRows } = params;
  const table = tablesOf(manifest).find((candidate) => candidate?.id === tableId);
  const declared = table === undefined ? undefined : accessControlOf(table);
  if (declared === undefined) {
    return undefined;
  }
  const actor = nonEmptyString(actorId);
  const accountField = nonEmptyString(declared.members?.account);
  if (actor === undefined || accountField === undefined) {
    return { kind: "no_member" };
  }
  let memberRowId: string | undefined;
  for (const member of memberRows) {
    if (member?.[accountField] !== actor) {
      continue;
    }
    memberRowId = nonEmptyString(member?._id);
    if (memberRowId !== undefined) {
      break;
    }
  }
  if (memberRowId === undefined) {
    return { kind: "no_member" };
  }
  const grantTable = nonEmptyString(declared.grant?.table);
  const targetField = nonEmptyString(declared.grant?.target);
  const memberField = nonEmptyString(declared.grant?.member);
  const permissionField = nonEmptyString(declared.grant?.permission);
  const permissionName = nonEmptyString(declared.creator_permission);
  if (
    grantTable === undefined ||
    targetField === undefined ||
    memberField === undefined ||
    permissionField === undefined ||
    permissionName === undefined
  ) {
    return { kind: "unusable" };
  }
  const grantValues = (recordId: string): Record<string, unknown> => ({
    [targetField]: recordId,
    [memberField]: memberRowId,
    [permissionField]: permissionName,
  });
  return {
    kind: "grant",
    grantTable,
    previewRow: { _id: CREATOR_PREVIEW_RECORD_ID },
    previewGrant: grantValues(CREATOR_PREVIEW_RECORD_ID),
    grantValues,
  };
}

// --- 付与表への書込を誰が行えるか(`Z-G5` / `D-V7-14`。V7-M3-T03)------------------------
//
// **`D-V7-14` の逐語**: **「付与を作れるのは、その行の作成者(`st_owner` 相当)とアプリの
// 運営ロールだけである」。** **`v7-m0.md` §6-2b の1 が「運営ロール」を **`editor` / `owner`
// の2つ**と裁定している**(`viewer` は `ADR-0015` §1 により、そもそも records に書けない)。
//
// **【判定の家を増やしていない】** —— **`read` / `write` / `delete` を計算するのは今日も
// {@link judgeRecordAccess} 1本である。** **本関数はその答えと、権限名の解決
// ({@link resolveGrantedPermissionNames})を使って「この人が付与を作ってよいか」を組み立てる
// だけであり、動詞を1つも計算しない。**
//
// **【本関数が実装していないもの。先に書く(憲法6)】**
//  1. **メンバー表・グループ表そのものへの書込を1ミリも絞っていない。** **誰でも自分の
//     メンバー行を作れ、自分の所属グループを付け替えられる** —— **したがって「自分に権限を
//     付けられない」は、グループ経由で回り込める。**
//  2. **効くのは HTTP 認証経路だけである**(`ADR-0016` 実装追記 (E))。**MCP / 受信口 /
//     ワークフロー / 島から付与表に書く経路は今日も素通りする**(`Z-G21`〜`Z-G24`)。

/** 付与表への書込の種類。**読取は1つも含まない。** */
export type GrantWriteOp = "create" | "update" | "delete";

/**
 * 付与表への書込1件に対する判定の結果。
 *
 * - `allowed` … 通す。
 * - `invisible_target` … **付与が指す行が、この actor には見えない。** **存在を伏せる(404)。**
 * - `not_creator` … **行は見えるが、作成者でも運営ロールでもない(403)。**
 * - `self` … **相手が actor 自身である(403)。** **運営ロールも例外にしない。**
 * - `unknown_holder` … **相手がメンバー表(またはグループ表)の行として解決できない(400)。**
 * - `no_target` … **どの行への付与かが決まらない(400)。**
 * - `parent_denied` … **相手が、引き継ぎ元(`inherit_from`)の親の行を読めない(403)。**
 *   **`Z-G33` / 依頼文 `L6`(逐語「issue はプロジェクトへのアクセス権限がある人しか
 *   アサインできない」)。**
 */
export type GrantWriteVerdict =
  | { readonly kind: "allowed" }
  | { readonly kind: "invisible_target"; readonly tableId: string; readonly recordId: string }
  | { readonly kind: "not_creator" }
  | { readonly kind: "self" }
  | { readonly kind: "unknown_holder" }
  | { readonly kind: "no_target" }
  | { readonly kind: "parent_denied"; readonly tableId: string; readonly recordId: string }
  /**
   * **メンバー表・グループ表そのものへの書込を、運営ロール以外に通さない**
   * (`V8-M19` / `J-G33` / `D-V8-28` / `U-2`)。**`V8-M19` が足した7つ目である。**
   */
  | {
      readonly kind: "membership_locked";
      readonly tableId: string;
      readonly role: "member" | "group";
    };

/**
 * **付与を無条件に作れる運営ロール。** **`owner` の1つだけである。**
 *
 * **【`v7-m0.md` §6-2b の1 の裁定より狭い側に倒した。判断と理由を書く】** ——
 * **同裁定は「運営ロール = `editor` / `owner` の2つ」と書いている。** **本タスクは `owner`
 * だけを無条件に通し、`editor` は「その行の作成者かどうか」で判定する。**
 *
 * **理由(実測にもとづく)**: **付与表は普通の表であり、`st_owner` も `access_control` も
 * 持たない** —— **したがって `nonAdminTableAccess` は `"denied"` を返し、宣言された利用者の
 * 種類(`customer` など)は付与表へ1バイトも書けない**(中継層が 403 で止める。
 * `src/server/app.ts` の `recordsAuthMiddleware`)。**`viewer` も同じく書けない。**
 * **つまり HTTP でこの判定に届くのは `editor` と `owner` の2つだけである。**
 * **`editor` も無条件に通すと、本判定は誰1人拒否せず、`D-V7-14`(作れるのは作成者と運営
 * だけ)は1ミリも実装されないことになる。**
 *
 * **【したがって、これは v7 が `editor` に新しい制限を足したということである。隠さない】**
 * —— **着手前は `editor` なら誰でも、どの行にでも付与を作れた**(`v7-m2.md` §2-3-5 の (15)
 * の実測)。**今日は「その行を作った人である `editor`」だけが作れる。**
 * **広げ直す(= `editor` も無条件に通す)判断はメインに委ねる** —— **そのときは本定数に
 * `"editor"` を足すだけで戻る。**
 */
const GRANT_WRITE_ADMIN_ROLES: readonly string[] = ["owner"];

/**
 * **その表が、どれかの宣言のメンバー表 / グループ表として名指しされているか**
 * (`V8-M19` / `J-G33`)。**名指しされていなければ `undefined`。**
 *
 * **メンバー表として名指しされている側を先に返す** —— **同じ表が両方として名指しされる
 * ことは適用時検査が止めていないので、どちらか1つに決める必要がある。**
 *
 * **【先行 ADR の前提の訂正】** —— **先行 ADR は「メンバー表・グループ表そのものに
 * アクセス権を宣言できない」ことを前提として書いていたが、`V8-M15` の実測でその適用時検査は
 * **今日の実装に存在しない**ことが判明している**(どの表に宣言しても受理された)。
 * **したがって本述語は「メンバー表は `access_control` を持たない」ことに寄りかかっていない**
 * —— **宣言から名前を引くだけである。**
 */
function membershipTableRole(manifest: Manifest, tableId: string): "member" | "group" | undefined {
  let asGroup = false;
  for (const table of tablesOf(manifest)) {
    const declared = accessControlOf(table);
    if (declared === undefined) {
      continue;
    }
    if (nonEmptyString(declared.members?.table) === tableId) {
      return "member";
    }
    if (nonEmptyString(declared.groups?.table) === tableId) {
      asGroup = true;
    }
  }
  return asGroup ? "group" : undefined;
}

/**
 * **付与表への `create` / `update` / `delete` を、付与が指す行への権限で絞る**(`Z-G5`)。
 *
 * **`undefined` を返したら、その表は付与表として名指しされていない** —— **呼び出し側は
 * 今日どおりの処理を続ける**(オプトインの実体。{@link recordAccessSourceTables} と同じ約束)。
 *
 * @param params.values **create は送られた値、update は「既存行に送られた値を重ねたもの」、
 *   delete は既存行**を渡すこと(**相手と対象は、書き込んだあとの姿で判定する**)。
 * @param params.readRows 表IDを渡すと、その表の**全行**を返す関数(**呼び出し側が読む**。
 *   本ファイルは I/O を1つも持たない)。
 * @param params.readRow 表IDと行IDを渡すと、その行を返す関数。
 *
 * **関門の順序**(**存在を伏せる層を先に立てる**。`v7-m0.md` §5-4 の (vi) と同じ並び):
 *  **(1) どの行への付与か決まらない → `no_target`**
 *  **(2) 作成者でも運営ロールでもない → 見えないなら `invisible_target`(404)/
 *      見えるなら `not_creator`(403)**
 *  **(3) 相手が actor 自身 → `self`**
 *  **(4) 相手が解決できない → `unknown_holder`**
 *
 * **【`delete` は (3) を見ない】** —— **自分の権限を手放すことは止めない**(付与を**足す**
 * ことだけを止める。`D-V7-14` の逐語は「付与を作れるのは」である)。
 */
export function judgeGrantWrite(params: {
  manifest: Manifest;
  tableId: string;
  op: GrantWriteOp;
  values: Record<string, unknown>;
  actorId: string | null;
  // **【`V8-M16` / `J-G3`】実効ロール集合を受ける**(限定の逐語「複数の役割は和集合1本で
  // 合成する」)。**キーは今日も8本のままで、型を広げただけである。**
  role: ActorRoles;
  readRows: (tableId: string) => readonly Record<string, unknown>[];
  readRow: (tableId: string, recordId: string) => Record<string, unknown> | undefined;
}): GrantWriteVerdict | undefined {
  const { manifest, tableId, op, values, actorId, role, readRows, readRow } = params;

  // --- 所属の穴(`V8-M19` / `J-G33` / `D-V8-28` / `U-2`)------------------------------------
  //
  // **メンバー表・グループ表そのものへの書込を、運営ロール以外に通さない。**
  //
  // **【何を塞いだのか。既存の穴である。新しく作った機能ではない】** —— **着手前は、誰でも
  // 自分のメンバー行の所属グループを付け替えられた**(`owner-scope.ts` の v7 の逐語
  // 「**メンバー表・グループ表そのものへの書込を1ミリも絞っていない。誰でも自分のメンバー行を
  // 作れ、自分の所属グループを付け替えられる**」)。**したがって「自分に権限を付けられない」
  // (`D-V7-14`)は、グループ経由で回り込めた。** **`V8-M19` はその回り込みを止めた。**
  //
  // **【なぜここに置いたか】** —— **`J-G33` の限定の逐語が「判定は `src/server/owner-scope.ts`
  // の既存1箇所」と書いている。** **付与表への書込を絞る判定({@link judgeGrantWrite})は
  // 既に HTTP の書込4経路(`POST` / `PATCH` / `DELETE` / バッチ)から呼ばれており、
  // **新しい判定の入口も新しい HTTP の口も1本も要らない。**
  //
  // **【広さ。`GRANT_WRITE_ADMIN_ROLES` と同じ形に揃えた】** —— **付与表と同じく、
  // 通すのは `owner` だけである。** **`editor` も通らない** —— **メンバー表は「誰がこの
  // アプリの参加者か」を決める表であり、付与表と同じ重さを持つからである。**
  // **広げ直すときは同じ定数を1つ足すだけで戻る。**
  //
  // **【塞いでいないもの。先に書く(憲法6)】**
  //  1. **読取を1ミリも絞っていない** —— **メンバー表・グループ表は今日も誰でも一覧できる**
  //     (面の規則を書けば絞れる。既定では絞らない)。
  //  2. **MCP / 受信口 / ワークフロー / コードの島には1バイトも掛かっていない**
  //     (`V8-M21` の担当。この判定は HTTP の書込4経路にしか居ない)。
  //  3. **`account` 列と `group` 列だけを見るのではなく、表そのものを止めている** ——
  //     **メンバー表に別の列(表示名など)を持たせているアプリでは、その列も運営しか
  //     書けなくなる。** **非対称を作らない側に倒した。**
  {
    const membership = membershipTableRole(manifest, tableId);
    if (membership !== undefined && !declaredMatchesRoles(GRANT_WRITE_ADMIN_ROLES, role)) {
      return { kind: "membership_locked", tableId, role: membership };
    }
  }

  // **この表を付与表として名指ししている宣言の全量**(1つの付与表を複数の表が名指しできる)。
  const governed: { table: Table; declared: AccessControlDeclaration }[] = [];
  for (const table of tablesOf(manifest)) {
    const declared = accessControlOf(table);
    if (declared !== undefined && declared.grant?.table === tableId) {
      governed.push({ table, declared });
    }
  }
  if (governed.length === 0) {
    return undefined;
  }

  // **(1) どの行への付与かを決める。** **決まらない付与は通さない**(fail-closed)——
  // **対象を書かない付与は誰にも効かないが、「効かない行が黙って増える」形を作らない。**
  let target:
    | { tableId: string; recordId: string; row: Record<string, unknown>; table: Table }
    | undefined;
  let declared: AccessControlDeclaration | undefined;
  for (const candidate of governed) {
    const targetField = nonEmptyString(candidate.declared.grant?.target);
    const recordId = targetField === undefined ? undefined : nonEmptyString(values[targetField]);
    if (recordId === undefined) {
      continue;
    }
    const row = readRow(candidate.table.id, recordId);
    if (row === undefined) {
      continue;
    }
    target = { tableId: candidate.table.id, recordId, row, table: candidate.table };
    declared = candidate.declared;
    break;
  }
  if (target === undefined || declared === undefined) {
    return { kind: "no_target" };
  }

  // **消えたグループ行を指す付与は、ここでも1件も解決しない**(`Z-G32` / `V7-M3-T05`)——
  // **読取経路と同じ手前の整えを通す。** **「作成者かどうか」の判定が読取経路と食い違わない
  // ようにするためである**(判定の家は今日も1本のままである)。
  const groupTableId = nonEmptyString(declared.groups?.table);
  const grantRows = grantsWithExistingGroups({
    manifest,
    tableId: target.tableId,
    grantRows: readRows(tableId),
    groupRows: groupTableId === undefined ? [] : readRows(groupTableId),
  });
  const memberTable = nonEmptyString(declared.members?.table);
  const memberRows = memberTable === undefined ? [] : readRows(memberTable);
  const actor = nonEmptyString(actorId);

  // **(2) 作成者か運営ロールか。** **それ以外は、行が見えるかどうかで 404 と 403 を分ける。**
  // **【`V8-M16` / `J-G3`】1値の照合を実効ロール集合との積に広げた**
  // (限定の逐語「複数の役割は和集合1本で合成する」)。**運営ロールを1つでも持てば通る。**
  if (!declaredMatchesRoles(GRANT_WRITE_ADMIN_ROLES, role)) {
    const names =
      actor === undefined
        ? undefined
        : resolveGrantedPermissionNames({
            declared,
            recordId: target.recordId,
            actor,
            grantRows,
            memberRows,
          });
    const creatorName = nonEmptyString(declared.creator_permission);
    const isCreator = names !== undefined && creatorName !== undefined && names.has(creatorName);
    if (!isCreator) {
      // **見える人には「作れない」を、見えない人には「無い」を返す。**
      const verdict = judgeRecordAccess({
        manifest,
        tableId: target.tableId,
        row: target.row,
        actorId: actor ?? null,
        grantRows,
        memberRows,
      });
      return verdict.read
        ? { kind: "not_creator" }
        : { kind: "invisible_target", tableId: target.tableId, recordId: target.recordId };
    }
  }

  if (op === "delete") {
    return { kind: "allowed" };
  }

  // **(3)(4) 相手の検査。** **クライアントが送った id を信用しない**(`ADR-0016` 却下 (iv))
  // —— **メンバー表(またはグループ表)に実在する行を指していることを、サーバが確かめる。**
  const memberField = nonEmptyString(declared.grant?.member);
  const groupField = nonEmptyString(declared.grant?.group);
  const holderMemberId =
    memberField === undefined ? undefined : nonEmptyString(values[memberField]);
  const holderGroupId = groupField === undefined ? undefined : nonEmptyString(values[groupField]);
  if (holderMemberId === undefined && holderGroupId === undefined) {
    return { kind: "unknown_holder" };
  }
  if (holderMemberId !== undefined) {
    const holder = memberRows.find((row) => nonEmptyString(row?._id) === holderMemberId);
    if (holder === undefined) {
      return { kind: "unknown_holder" };
    }
    const accountField = nonEmptyString(declared.members?.account);
    // **自分に権限を付けられない**(`D-V7-14`)。**運営ロールも例外にしない。**
    if (actor !== undefined && accountField !== undefined && holder[accountField] === actor) {
      return { kind: "self" };
    }
  }
  if (holderGroupId !== undefined) {
    const groupTable = nonEmptyString(declared.groups?.table);
    if (groupTable === undefined) {
      return { kind: "unknown_holder" };
    }
    const group = readRows(groupTable).find((row) => nonEmptyString(row?._id) === holderGroupId);
    if (group === undefined) {
      return { kind: "unknown_holder" };
    }
  }

  // **(5) 相手が、引き継ぎ元の親の行を読めるか**(`Z-G33` / `V7-M3-T04` / 依頼文 `L6`)。
  // **`inherit_from` が空(0件)の表では、この検査は何も止めない。**
  return judgeGrantParentAccess({
    manifest,
    protectedTable: target.table,
    declared,
    targetRow: target.row,
    holderMemberId,
    holderGroupId,
    memberRows,
    readRows,
    readRow,
  });
}

/**
 * **役割の配布そのものに掛かる不変条件の判定結果**(`V8-M28` 第2波。台帳 `T-G20`。
 * ユーザ決定 `D-V8-75` / `D-V8-76`)。**`undefined` を返したら止めない。**
 *
 * - `"self"` … **要求者と対象者が同じ**(`D-V8-76`)。
 * - `"owner_grant"` … **`owner` を配ろうとしたが、要求者が `owner` を持たない**(`D-V8-75`)。
 */
export type RoleAssignmentVerdict = { readonly kind: "self" } | { readonly kind: "owner_grant" };

/**
 * **`owner` を配れる人が持っていなければならない役割**(`D-V8-75`)。**`owner` 1語ちょうど。**
 *
 * **`GRANT_WRITE_ADMIN_ROLES`(付与表への書込)と同じ値だが、別の定数にしてある** ——
 * **こちらは「役割の配布」の話であり、片方を広げたときにもう片方が黙って動かないためである。**
 */
const ROLE_ASSIGNMENT_ELEVATED_ROLES: readonly string[] = ["owner"];

/**
 * **役割を配るときの不変条件2本**(`V8-M28` 第2波。台帳 `T-G20`。
 * ユーザ決定 `D-V8-75` / `D-V8-76`)。
 *
 * **呼ぶのは `PATCH /api/apps/:app_id/auth/users/:user_id` の1箇所だけである。**
 * **「配ってよいか」そのもの(役割の規則の判定)は {@link judgeRoleAccess}
 * (`target: "role"` / `verb: "write"`)が先に決めており、本関数はその**あと**に立つ**
 * —— **本関数は規則を1バイトも読まない。**
 *
 * **不変条件は次の2本ちょうどである**:
 *
 *  **(a) 自分自身への書き換えを拒否する**(`D-V8-76`)。**要求者の利用者 ID と対象の
 *      利用者 ID が同じなら拒否する。** **「弱くするだけ許す」は採らなかった** ——
 *      **ユーザがその選択肢を選ばなかったからである**(選ばれた見出しは
 *      「**自分自身は変えられない**」)。**持ち主も例外にしない。**
 *  **(b) `owner` を配れるのは、自分が `owner` を持つ人だけ**(`D-V8-75`)。
 *      **それ以外の役割は1つも制限しない** —— **受付係は閲覧者・編集者・独自の役割を
 *      自由に配れる。**
 *
 * =====================================================================================
 * **【台帳の逐語と、実装が食い違う点を書く。丸めない】**
 * =====================================================================================
 *
 * **`ADR-0007` §8 の `T-G20` の行の帰属先の逐語は「**自分の実効ロール集合に無い役割の
 * 配布を拒否**」である。** **本実装はそれに従っていない。** **`D-V8-75` がそれを
 * 「**`owner` を配れるのは `owner` を持つ人だけ**」へ**狭めた**(拒否する範囲が小さくなった)
 * ためである。** **狭めた理由は、字義どおりでは受付係が「受付係」しか配れず、
 * `D-V8-41` の説明文の逐語「**設定は変えられないが、人を追加できる受付係**」が
 * 成立しないからである。**
 *
 * **【禁止】これを「限定どおり実装した」と書かない。**
 * **【禁止】逆に「限定を破った」とだけ書いて済ませない。**
 *
 * =====================================================================================
 * **【止めないもの。先に書く(憲法6)】**
 * =====================================================================================
 *
 *  1. **`owner` 以外への昇格を1件も止めない** —— **受付係は編集者を無限に増やせる**
 *     (`D-V8-75` の注が先に申告している穴である)。
 *  2. **最後の持ち主を降ろすことは本関数の担当ではない** —— **今日どおり
 *     `src/auth/store.ts` の `LastOwnerError`(409)が止める。** **本関数はそこへ1行も
 *     足していない。**
 *  3. **`_auth_user_roles` を1行も読まない** —— **要求者の実効ロール集合は呼び出し側が
 *     渡す**(本ファイルは I/O を1つも持たない。{@link judgeGrantWrite} と同じ約束)。
 *  4. **`store.setUserRoles` / `setUserRole` の側には1行も足していない**
 *     (**判定の家は1本**。`ADR-0305` 限定3)。
 *
 * @param params.assignedRoles **書き込んだあとに対象者が持つことになる役割の全量**
 *   (`roles` と `role` の両方を畳んだもの)。**「配った差分」ではなく「配ったあとの姿」を渡すこと。**
 */
export function judgeRoleAssignment(params: {
  actorId: string;
  targetUserId: string;
  actorRoles: ActorRoles;
  assignedRoles: readonly string[];
}): RoleAssignmentVerdict | undefined {
  // **(a) 自分自身**(`D-V8-76`)。**役割の中身を1つも見ないので、先に立てる。**
  if (params.actorId === params.targetUserId) {
    return { kind: "self" };
  }
  // **(b) `owner` の配布**(`D-V8-75`)。**それ以外の役割はここを素通りする。**
  const elevates = params.assignedRoles.some((role) =>
    ROLE_ASSIGNMENT_ELEVATED_ROLES.includes(role),
  );
  if (elevates && !declaredMatchesRoles(ROLE_ASSIGNMENT_ELEVATED_ROLES, params.actorRoles)) {
    return { kind: "owner_grant" };
  }
  return undefined;
}

/**
 * **付与の相手が、引き継ぎ元(`inherit_from`)の親の行を読めるかを検査する**(`Z-G33`)。
 *
 * **依頼文 `L6` の逐語**: **「issue はプロジェクトへのアクセス権限がある人しかアサイン
 * できない」。** **これを画面の候補絞り込み(`Z-G27`)ではなく、サーバの書込判定で担保する。**
 *
 * **【段数。自分で決めた】** —— **辿るのは1段目(`inherit_from` が直接指す親)だけである。**
 * **多段(親の親)は `V7-M4` の担当であり、本関数は祖父母以上を1度も辿らない。**
 *
 * **【判定は `judgeRecordAccess` に委ねる】** —— **本関数は「誰について」「どの行を」
 * 判定するかを組み立てるだけで、`read` / `write` / `delete` を1つも計算しない**
 * (判定の家は今日も1本である)。
 *
 * **【止めないもの。先に書く(憲法6)】**
 *  1. **`inherit_from` が空の表では1件も止めない。**
 *  2. **参照が空の行(親を指していない行)では1件も止めない。**
 *  3. **親の表が `access_control` を宣言していなければ1件も止めない**
 *     (`judgeRecordAccess` が「この判定は何も絞らない」を返すため)。
 *  4. **空のグループへの付与は素通りする**(全員が読めることが空集合では真になる)。
 *     **あとからそのグループに人を足す経路を1ミリも見ていない。**
 *  5. **書込の時点しか見ない。** **書いたあとに親の権限が消えることを止めない**
 *     (`v7-m0.md` §6-2 の `Z-G33` `S3` の1 の逐語)。
 */
function judgeGrantParentAccess(params: {
  manifest: Manifest;
  protectedTable: Table;
  declared: AccessControlDeclaration;
  targetRow: Record<string, unknown>;
  holderMemberId: string | undefined;
  holderGroupId: string | undefined;
  memberRows: readonly Record<string, unknown>[];
  readRows: (tableId: string) => readonly Record<string, unknown>[];
  readRow: (tableId: string, recordId: string) => Record<string, unknown> | undefined;
}): GrantWriteVerdict {
  const {
    manifest,
    protectedTable,
    declared,
    targetRow,
    holderMemberId,
    holderGroupId,
    memberRows,
    readRows,
    readRow,
  } = params;
  const inheritFrom = Array.isArray(declared.inherit_from) ? declared.inherit_from : [];
  if (inheritFrom.length === 0) {
    return { kind: "allowed" };
  }

  // **相手(利用者 or グループ)を、ログインアカウントの集合に落とす。**
  // **グループは「そのグループに属するメンバー行の全員」である** —— **`L6` の主語は
  // 「人」だからである。** **1人でも親を読めなければ止める。**
  const accountField = nonEmptyString(declared.members?.account);
  const memberGroupField = nonEmptyString(declared.members?.group);
  const accounts = new Set<string>();
  if (accountField !== undefined) {
    for (const member of memberRows) {
      const memberId = nonEmptyString(member?._id);
      const viaMember = holderMemberId !== undefined && memberId === holderMemberId;
      const viaGroup =
        holderGroupId !== undefined &&
        memberGroupField !== undefined &&
        nonEmptyString(member?.[memberGroupField]) === holderGroupId;
      if (!viaMember && !viaGroup) {
        continue;
      }
      const account = nonEmptyString(member?.[accountField]);
      if (account !== undefined) {
        accounts.add(account);
      }
    }
  }

  for (const fieldId of inheritFrom) {
    const field = protectedTable.fields?.find((candidate) => candidate?.id === fieldId);
    if (field === undefined || field.type !== "reference") {
      continue;
    }
    const parentTableId = nonEmptyString(field.reference_table);
    const parentRecordId = nonEmptyString(targetRow[fieldId]);
    if (parentTableId === undefined || parentRecordId === undefined) {
      continue; // **親を指していない行では何も止めない。**
    }
    const parentSources = recordAccessSourceTables(manifest, parentTableId);
    if (parentSources === undefined) {
      continue; // **親の表が宣言していなければ、この判定は何も絞らない。**
    }
    const parentRow = readRow(parentTableId, parentRecordId);
    if (parentRow === undefined) {
      // **親の行が読めない**(消されている等)—— **fail-closed に倒す。**
      return { kind: "parent_denied", tableId: parentTableId, recordId: parentRecordId };
    }
    const parentGrantRows =
      parentSources.grantTable === undefined ? [] : readRows(parentSources.grantTable);
    const parentMemberRows =
      parentSources.memberTable === undefined ? [] : readRows(parentSources.memberTable);
    for (const account of accounts) {
      const verdict = judgeRecordAccess({
        manifest,
        tableId: parentTableId,
        row: parentRow,
        actorId: account,
        grantRows: parentGrantRows,
        memberRows: parentMemberRows,
      });
      if (!verdict.read) {
        return { kind: "parent_denied", tableId: parentTableId, recordId: parentRecordId };
      }
    }
  }
  return { kind: "allowed" };
}

// --- owner id の表示名解決(V3-M8-T03 / ADR-0016 §6 / ADR-0061 限定7)-------------------
//
// `st_owner` の値は `_auth_users.id`(不透明なランダム。ADR-0014 §4)である。**ADR-0016 §6 は
// 「生 id を detail_view / list_view の表示値に出さない。サーバ層が `_auth_users` を join して
// `display_name`(または username)に解決してから返す」と定め、その責務をサーバ層に置いた**
// (`_auth_users` は reference で辿れないのでカーネルの仕事にできない)。
//
// **ここに置くのは純粋部分だけである** —— 実際に `_auth_users` を読むのは `app.ts` 側で、
// **掛ける先は ADR-0061 限定1 が開いた読取2経路 × 運営可視のときだけ**(限定7: 「既存経路には
// 掛けない」)。**共有センチネル(null / 空文字)は id ではないので触らない。** **解決できない
// id(該当ユーザが消えている等)は生 id へフォールバックせず `UNRESOLVED_OWNER_DISPLAY` に
// 倒す** —— 黙って生 id を出すのは §6 が禁じたことそのものだからである。

/**
 * `st_owner` の id を表示名に解決できなかったときの置換値(V3-M8-T03)。
 * **生 id へフォールバックしない**ための固定値であり、`_auth_users` から消えたユーザの行に出る。
 */
export const UNRESOLVED_OWNER_DISPLAY = "(不明なユーザ)";

/**
 * `_auth_users` の1行から表示に使う名前を選ぶ(ADR-0016 §6 の「`display_name`(または username)」)。
 * `display_name` は NULL 可・一意でもないので、無い/空なら UNIQUE な `username` に倒す。
 */
export function ownerDisplayName(displayName: string | null | undefined, username: string): string {
  return displayName === null || displayName === undefined || displayName === ""
    ? username
    : displayName;
}

/**
 * 行の `st_owner` を表示名へ解決した**新しい行**を返す(元の行は破壊しない)。
 * - 共有センチネル(null / undefined / 空文字)→ そのまま(id ではない)
 * - **`actorId` 自身の id → そのまま**(下の「actor 自身は置き換えない」を参照)
 * - `displayNames` に在る id → その表示名
 * - 無い id → {@link UNRESOLVED_OWNER_DISPLAY}(**生 id は返さない**)
 *
 * **actor 自身は置き換えない**(2026-07-30。メインの差し戻し): **ADR-0016 §6 が防ぐのは
 * 「他人の id の露出」であり、actor 自身の id は他人ではない** —— §6 自身が「個人行は本人にしか
 * 見えない(owner 軸)ので自分の id しか出ない」を許容した形として書いている。**置き換えると、
 * 運営が自分の行を読んで丸ごと書き戻したときに `isAllowedOwnerUpdate` が他人 id への付け替えと
 * 見なして 403 になる**(宣言済みテーブルでだけ起きる退行。実測で見つかった)。**この分岐が
 * 消えると `owner-scope.test.ts` の (P9) / (k) / (l) / (m) が赤になる。**
 *
 * ## **【2026-08-13。`V8-M37` / 台帳 `F-G5`。上の段落を1バイトも消していない】**
 *
 * **その分岐を落とした。** **上の箇条書きの2本目(「`actorId` 自身の id → そのまま」)と、
 * 「actor 自身は置き換えない」の段落は、今日の実装を説明していない。**
 *
 * **落とした理由(実測。`docs/plan/v8/records/v8-m35-prestate-m33.md` §C-5 の逐語)**:
 * **「見る人がその行の持ち主なら利用者ID、持ち主でないならログイン名で返る。」**
 * **同じ1つの行が、見る人によって別の形で返っていた** —— **画面に並べると、自分の行だけ
 * 意味の読めない文字列になる。** **`ADR-0016` §6 が「生 id を表示値に出さない」と定めた
 * 目的から見て、自分の id だけを例外にする理由が無い。**
 *
 * **上の段落が予言した退行は、実際に起きた**(本単位で実測。(P9) / (k) / (l) / (m) が赤くなった)。
 * **塞いだのは書込側である** —— **{@link isAllowedOwnerUpdateWithDisplay} が
 * 「現在の持ち主の表示名のままの書き戻し」1形だけを通す。**
 * **`isAllowedOwnerUpdate` は1バイトも触っていない**(`ADR-0079` 限定5)。
 *
 * **【道 (ii) を採らなかった】** —— **`roleCrossesOwner`(この整形を掛ける引き金)を
 * 広げる道は、`ADR-0061` 限定7「既存経路には掛けない」と正面から当たる。**
 * **掛ける先は今日も読取2経路 × 面が owner 軸を越える表だけであり、1ミリも広げていない。**
 *
 * **`st_owner` 以外のキーは1つも触らない** —— とくに `_updated_at` は ETag / 楽観ロック(CAS)の
 * 版そのものなので、応答の整形が版の計算に混ざらないことを型と実装の両方で明示する。
 *
 * @param actorId **今日この引数は1度も読まれない。** **`F-G5` が唯一の読み手だった
 *   `rowOwner === actorId` を落としたためである。** **引数を残したのは、呼び出し側
 *   (`app.ts` の2経路)と `judgeOwnerScopedOp` 系の形を揃えておくためであり、
 *   `web/test/shell-navigation-boundary.test.ts` が固定している export の形を
 *   動かさないためでもある。**
 */
export function projectOwnerDisplay(
  row: Record<string, unknown>,
  displayNames: ReadonlyMap<string, string>,
  actorId: string,
): Record<string, unknown> {
  void actorId;
  if (!(OWNER_FIELD in row)) {
    return { ...row };
  }
  const rowOwner = row[OWNER_FIELD];
  // **【`V8-M37` / `F-G5`】旧(逐語)**:
  //     if (isSharedOwner(rowOwner) || typeof rowOwner !== "string" || rowOwner === actorId) {
  if (isSharedOwner(rowOwner) || typeof rowOwner !== "string") {
    return { ...row };
  }
  return { ...row, [OWNER_FIELD]: displayNames.get(rowOwner) ?? UNRESOLVED_OWNER_DISPLAY };
}

/**
 * 匿名公開レスポンスから伏せるサーバ層の**予約規約フィールド**(ADR-0034 §3 限定3)。
 * `st_owner`(所有者)/ `st_public`(公開フラグ)/ `st_admin_readable`(運営可視宣言)/
 * `st_undeletable`(削除不可宣言)は業務データではなくサーバ層の規約なので、匿名には
 * 出さない(3本目は ADR-0061 限定10、**4本目は ADR-0073 限定7**)。
 *
 * **【`V8-M20`。旧文を1バイトも消していない】** **`st_admin_readable` は `V8-M20` / `J-G30` で撤去された。**
 * **したがって上の列挙のうち3本目は今日この配列に居ない。** **今日の要素は
 * `st_owner` / `st_public` / `st_undeletable` / `st_no_direct_create` の **4本** である。**
 *
 * **正直な限界(ADR-0034 §92-2 / 憲法6)**: 案(b)は「フィールド単位の運営専用印」を持たない
 * (schema キーを増やさないことと引き換え)。したがって伏せられるのはこの予約規約フィールド
 * だけであり、**公開テーブルに載せた業務フィールドは匿名にもそのまま出る**。アプリ作者が
 * 公開テーブルに秘密の業務フィールドを置けば、それは匿名に漏れる。防御は行単位(`st_public`)
 * + 予約規約フィールドの除去に限られる。フィールド単位の公開制御が要るなら ADR-0034 §3a の
 * 再審査(案(a)相当)を通す。
 *
 * **【V4-M3-T06 / `B-G2` / ADR-0071 による訂正】** **上の最後の1文が指した再審査は、
 * `V4-M0-T03` の門A 本審査として実際に行われた**(判定 = 限定採用。`ADR-0071`)。
 * **今日はフィールド単位の宣言(`$defs/field.audience`)が在り、`projectForFieldAudience`
 * が読取応答から落とす。**
 *
 * **【`V8-M20`。旧文を1バイトも消していない】** **その `$defs/field.audience` は `V8-M20` / `J-G28` で
 * 撤去された。** **今日フィールド単位の読取を絞るのは面の項目の規則(`projectForRoleFields`)
 * である** —— **フィールド単位の公開制御が在るという上の訂正は、担い手が変わっただけで
 * 今日も真である。**
 *
 * **それでも上の逐語「公開テーブルに載せた業務フィールドは匿名にもそのまま出る」は、
 * 宣言していない項目については今日も真である**(`ADR-0071` 限定7: 既定は「出す」)——
 * **だから1文字も消していない。** **消せるのは「フィールド単位の公開制御が無い」という
 * 部分だけであり、それはこの追記が引き受けた。**
 */
export const ANON_RESERVED_FIELDS: readonly string[] = [
  OWNER_FIELD,
  PUBLIC_FIELD,
  // **【`V8-M20` / `J-G30`】`ADMIN_READABLE_FIELD` を落とした(5本 → 4本)。**
  // **予約規約フィールドは今日 **4本** である**(`ADR-0301` の手続きで廃止した1本ぶん減った)。
  UNDELETABLE_FIELD,
  // **`V4-M10-T04` / `E-G49` / `ADR-0077` 限定7**(`ADR-0061` 限定10 / `ADR-0073` 限定7 の作法)。
  NO_DIRECT_CREATE_FIELD,
];

// --- 受信 payload から予約規約フィールドを落とす(V4-M36 / D-V4-125)---------------------
//
// **`V4-M27` が `st_public` 1本について作った経路を、残る3本へ広げる。**
// **`D-V4-125`(`docs/plan/v4/records/v4-open-questions.md` §5d)の逐語**:
//
// > **外部からの受信口を通して「運営者でも消せない行」を作られる件を塞ぐ。** 残る予約規約
// > フィールド3本を、`st_public` と同じやり方(黙って捨てる)で処理する。
// > **`D-V4-92`(「他の予約規約フィールドは今日のまま」)の射程を今日の決定が広げる。**
//
// **塞ぐ穴の実測(2026-08-04。本物の HTTP で採った)**: 署名鍵を持つ送り手が
// `st_undeletable` を立てて受信させると **201 で行が入り、その行に対する運営者の `DELETE`
// が `409`(「削除できません(削除不可の状態です)」)で止まった** —— `ADR-0073` の
// `isDeleteProtectedRow` が**行の値**を判定に使うためである(`ADR-0061` 限定3 の
// 「行の値は判定に使わない」を `ADR-0073` §限界6 が意図して越えている)。
//
// **落とす向きは `stripInboundPublicFlag` と同じ**(無条件・破壊的・拒否しない)。
// **`st_owner` だけは落とさない** —— あちらは `judgeOwnerScopedOp` が system actor で
// **上書き**する(対応する正しい値が在る)。捨てると持ち主が空になり、共有センチネル扱いに
// なってしまう。**したがって落とす対象は予約規約5本から `st_owner` を除いた4本である。**
//
// **【この関数が塞がないもの。誇張しない】**
//  1. **個人所有の表へ外部から行が入ること自体は解けない**(`D-V4-92` 逐語「解けないと書く」)。
//     受信で入った行の持ち主は `system:inbound` なので、**運営者からは今日も見えない**
//     (`DELETE` は 404)。**受信口にゴミを積まれる経路そのものは1ミリも塞いでいない。**
//  2. **既に入っている行は1件も直らない。** これは前を向いた関門であり、遡って値を消さない。
//  3. **MCP / ワークフロー / 島の経路は1ミリも変わらない**(`ADR-0073` 限定6 / `ADR-0077`
//     限定6 が既に「守らない」と書いた射程)。
//  4. **運営者が自分で `PATCH` して値を立てる経路は今日どおりである**(実測: 運営者は
//     `PATCH` で印を下ろしてから消せる = `ADR-0073` の (穴) と同じ形)。

/**
 * **受信 payload から無条件に取り除く予約規約フィールドの全量**(`D-V4-125`)。
 * **`ANON_RESERVED_FIELDS` との差は `st_owner` 1本だけである**(上のコメントの理由)。
 */
export const INBOUND_STRIPPED_RESERVED_FIELDS: readonly string[] = [
  PUBLIC_FIELD,
  // **【`V8-M20` / `J-G30`】`ADMIN_READABLE_FIELD` を落とした(4本 → 3本)。**
  UNDELETABLE_FIELD,
  NO_DIRECT_CREATE_FIELD,
];

/**
 * 受信 payload から {@link INBOUND_STRIPPED_RESERVED_FIELDS} を**破壊的に取り除く**
 * (`D-V4-125`)。**表の宣言を1つも見ない・値を1つも見ない・拒否しない**
 * (`D-V4-114` が `st_public` について決めた「印だけ黙って捨てて、残りは受け取る」を、
 * `D-V4-125` が残る3本へ広げた)。
 *
 * **その代償として、これらの列を持たない表への受信が今日の 400 から 201 に変わる** ——
 * カーネルの「フィールド "…" はテーブル "…" に存在しません。」が立たなくなるためである
 * (`D-V4-114` が `st_public` について承知した副作用の、対象4本ぶんへの拡大)。
 * **黙って通るようになるのはこの4本だけで、他の未知フィールドは今日どおり 400 で弾かれる。**
 *
 * @returns 実際に取り除いた名前(宣言順)。**呼び出し側はこの値で分岐しない** ——
 *   記録・観測のためだけの返り値である(拒否には使わない)。
 */
export function stripInboundReservedFields(values: Record<string, unknown>): string[] {
  const removed: string[] = [];
  for (const field of INBOUND_STRIPPED_RESERVED_FIELDS) {
    if (Object.hasOwn(values, field)) {
      delete values[field];
      removed.push(field);
    }
  }
  return removed;
}

// --- 非運営ロールのテーブル可視/書込カテゴリ(V2-M1-T03 / ADR-0033 限定4/5)----------
//
// **【`V5-M17-T06` / `G-G7` / `ADR-0158`】名前から EC 固有語(`customer`)を外した。**
// **旧名は `CustomerTableAccess` / `customerTableAccess` である。** **判定の中身は
// 1バイトも変えていない** —— 変えたのは名前だけで、下の3行の説明も同じ判定を述べている。
// **「customer」という語がここに残っていた理由は、非運営のロールが1本しか無かったからである。**
// **今日は、アプリが宣言した種類も同じこの判定を受ける**(`ADR-0158` 限定2 =
// 宣言された種類の認可規則は `customer` と同一に固定する)。
//
// customer は既存3ロール(owner/editor/viewer)と違い、テーブル単位で可否が分かれる:
//   - `st_owner`(personalOwnerField)を持つ = 顧客スコープテーブル(本人ごとに行が分かれる表)。
//     GET は既存 post-filter で自分の行/共有のみ、書込は自分の行のみ許可。→ "scoped"
//   - `st_public`(publicField)だけを持つ = 公開テーブル(EC-G1)。GET 可・書込は不可。→ "public"
//   - どちらの規約も無い = 運営テーブル(運営だけが管理する表・全員分の一覧)。GET も書込も遮断。→ "denied"
//
// **判定は純粋関数1本に集約する**(ADR-0033 Consequences: st_owner の有無で分岐する判定を
// 別経路に散らさない)。`st_owner` と `st_public` を両方持つ場合は "scoped" を優先する ――
// 顧客スコープの post-filter を掛ける側が安全側(自分の行に絞る)だからである。
//
// --- 【`V7-M2-T03` / `Z-G13` 限定3】4つ目の値を足さない ---------------------------------
//
// **アクセス権管理を有効にした表(`access_control.enabled: true`)は `"scoped"` を返す**
// (`v7-m0.md` §5-4 の (ii))。**`"granted"` のような4値目を足さない。**
//
// **理由**: **4値目を足すと呼び出し2箇所の分岐が増え、`app.ts` が逐語で述べる
// 「1件でも運営テーブルへ customer の GET/書込を通さないことを、この1箇所の集約で構造保証する」
// という fail-closed の形を崩す。** **`"denied"` に黙って落とさない** —— **落とすと、
// アクセス権管理を宣言した表に対して、宣言された利用者の種類が中継層の段階で 403 になり、
// 「付与を持っているのに読めない」が起きる**(= `Z-G11` が配線した判定に1度も届かない)。
//
// **`"scoped"` の意味は、この裁定で2つになる**(`Z-G13` `S3` の5。**隠さない**)——
// 今日までは「`st_owner` で自分の行に絞る」の1つだったが、宣言した表では
// 「**付与で絞る**」になる。**どちらも「下流の post-filter が絞る」という同じ形なので、
// 中継層の分岐は1つも増えない。** **絞る述語が違うだけである。**
// --- 【`V8-M27-T04` / `T-G5`】この層は**撤去した**。**上の説明文を1バイトも消していない** ----
//
// **ここに在ったもの**: `NonAdminTableAccess`(型。`"scoped" | "public" | "denied"` の3値)と
// `nonAdminTableAccess(table)`(純粋関数)。**逐語の本体は次のとおりであった**:
//
//     export type NonAdminTableAccess = "scoped" | "public" | "denied";
//     export function nonAdminTableAccess(table: Table): NonAdminTableAccess {
//       if (personalOwnerField(table) !== undefined) { return "scoped"; }
//       if (accessControlOf(table) !== undefined)     { return "scoped"; }
//       if (publicField(table) !== undefined)         { return "public"; }
//       return "denied";
//     }
//
// **どこで効いていたか**(呼び出しは3箇所。**すべて同じタスクで消した**):
//  1. `src/server/app.ts` の `recordsAuthMiddleware` —— 非運営の役割の `GET` を
//     `"denied"` で 403(`forbiddenNonAdminReadError`)、書込を `"scoped"` 以外で 403。
//  2. `src/server/app.ts` の `manualRunAuthMiddleware` —— 非運営の役割は
//     `"scoped"` の表からしか自動処理を起こせなかった。
//  3. `web/src/auth/authz.tsx` の `canWriteRole` / `isWriteAudienceRole` / `canReadTableRole`。
//
// **なぜ消せたか**: **表単位の可否を決めるのは面(`app.roles[].rules`)1本になった。**
// **`V8-M26` が面の既定を「閉じる」側へ倒した**(`D-V8-45` / `D-V8-65`)ので、
// **規則を1本も書いていない表は今日も読めない** —— **層を外しても穴は開かない。**
// **違いは「運営かどうか」ではなく「その表に規則が書いてあるかどうか」で決まることである。**
//
// **【この撤去がしていないこと。誇張しない】**
//  - **予約規約フィールド4本(`st_owner` / `st_public` / `st_undeletable` /
//    `st_no_direct_create`)とその述語(`personalOwnerField` / `publicField` /
//    `accessControlOf`)は1バイトも触っていない。** **役割を1文字も見ない別物である** ——
//    **`st_owner` の post-filter も匿名射影も今日どおり効き続ける。**
//  - **`owner` 名指しの管理ゲート(`POST /diffs` / `POST /undo` / `requireOwner` /
//    初回 owner ブートストラップ)は1バイトも触っていない。** **あれは層ではない。**
//  - **`RESERVED_ROLES` / `isReservedRole` は残る** —— **値域として
//    `schemas/manifest.schema.json` の `not.enum` 2箇所と
//    `src/auth/role-vocabulary-sync.test.ts` が測っており、
//    このファイルの `declaredUserKinds` も宣言から予約3ロールを落とすのに使い続ける。**

/**
 * 匿名公開読み取り用の射影。予約規約フィールド(st_owner / st_public / st_admin_readable)を
 * 伏せた新オブジェクトを返す。
 *
 * **【`V8-M20`。旧文を1バイトも消していない】** **`st_admin_readable` は `V8-M20` / `J-G30` で撤去された。**
 * **今日伏せるのは `ANON_RESERVED_FIELDS` の 4本 である**(その定数が正)。
 */
export function projectForAnonymous(row: Record<string, unknown>): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (ANON_RESERVED_FIELDS.includes(key)) {
      continue;
    }
    projected[key] = value;
  }
  return projected;
}

// --- 「書けるが効かない値」の射影は **`V8-M20` で撤去した**(E-G54 / V4-M6 の後始末)-------
//
// **ここに在ったもの**: `READ_HIDDEN_RESERVED_FIELDS`(要素は `st_admin_readable` の**1本だけ**
// だった)/ `projectForRead()`(その1本を読取応答から伏せる射影)。
//
// **なぜ残さずに消したか(判断を明記する)**: **`J-G30` の撤去で配列の要素が0本になり、
// `projectForRead()` は**恒等関数**になる。** **「伏せる」と名乗りながら1つも伏せない関数を
// 製品に残すと、次に読む人(AI も人も)が「ここで何かが伏せられている」と読み違える** ——
// **それは `E-G54` がこの節を作ったときの動機(「書けるが効かない値が応答に出ていて読み違える
// 余地が残る」)とまったく同じ形の負債である。** **空の配列と恒等関数を残す選択肢もあったが、
// 採らなかった。** **`st_owner` / `st_public` を伏せてはならない理由(更新の往復に要る /
// 行ごとに意味を持つ)は今日も真であり、将来もう一度「伏せる」が要るなら、そのときに
// 改めて書く。**
//
// **`ANON_RESERVED_FIELDS`(匿名向けの射影)は1バイトも消していない** —— **そちらは
// 要素が4本残っており、恒等関数になっていない。**

// --- 撤去した3層の跡地(`V8-M20`。台帳 `J-G27` / `J-G28` / `J-G29`)-----------------------
//
// **手続きは `ADR-0301`(語彙を廃止する判定値と `Delta11`)に拠る。**
//
// **ここに在ったもの**:
//
// | 撤去した層 | 消した記号 | 代わりに立つもの |
// |---|---|---|
// | 画面の「見せる相手」(`view.audience`。`J-G27`) | `ViewAudienceValue` / `viewAudienceDeclaration()` / `viewAudience()` / `isViewAudienceAllowed()` / `isViewAnonymousVisible()` / `VIEW_AUDIENCE_VALUES` | **役割 x 対象(画面)x 読取**(`judgeRoleAccess` の `target: "view"`) |
// | 項目の「見せる相手」(`field.audience`。`J-G28`) | `fieldAudience()` / `projectForFieldAudience()` | **役割 x 対象(項目)x 読取**(`projectForRoleFields()`) |
// | 項目の「書ける相手」(`field.writable_by` + `field_changes.writable_by`。`J-G28`) | `fieldWriters()` / `FieldWriteVerdict` / `judgeFieldWrite()` | **役割 x 対象(項目)x 書込**(`judgeRoleFieldWrite()`) |
// | ボタンの「見せる相手」(`view_action.audience`。`J-G29`) | `ViewActionWriteKind` / `actionWriteTarget()` / `isViewActionWriteAllowed()` | **役割 x 対象(表)x 書込** と **役割 x 対象(ボタン)x 読取**(`isRoleActionWriteAllowed()`) |
//
// **`AUDIENCE_ROLES`(`["owner","editor","viewer","customer"]`)も消えた** ——
// **4層すべての値域だったので、4層が消えて参照が0本になった。**
//
// **【消していないもの。理由つき】**
//
//  1. **`ANONYMOUS_AUDIENCE`(= `"anonymous"`)は残す。** **これは `view.audience` の値域で
//     あると同時に、面(`judgeRoleAccess`)が未ログインの主体を表す1語でもある**
//     (`roleSubjectsOf` が使う。`J-G11`)。**`web/src/auth/authz.tsx` が `ANONYMOUS` として
//     再輸出しており、匿名の概念は `view.audience` の撤去では消えない。**
//  2. **`manifestViews()` は残す。** **面のボタンの判定(`isRoleActionWriteAllowed`)が使う。**

/**
 * **未ログインを表す1語**(`J-G11`)。**面の主体としても使う** —— **`view.audience` の撤去
 * (`V8-M20` / `J-G27`)でこの語は消えない。**
 */
export const ANONYMOUS_AUDIENCE = "anonymous" as const;

/** マニフェストの画面の宣言の一覧。**形が壊れていれば空**(述語は例外を投げない)。 */
function manifestViews(manifest: unknown): readonly Record<string, unknown>[] {
  const views = (manifest as { app?: { views?: unknown } } | null | undefined)?.app?.views;
  if (!Array.isArray(views)) {
    return [];
  }
  return views.filter(
    (view): view is Record<string, unknown> => typeof view === "object" && view !== null,
  );
}

/**
 * **ボタンが起こす書込の種類**(`create` / `update` の2つ)。
 *
 * **`V8-M20` より前は `ViewActionWriteKind` という名前で、撤去した `view_action.audience` の
 * 層が持っていた。** **面のボタンの判定(`isRoleActionWriteAllowed`)が同じ区別を要るので、
 * 名前を面の側へ移して残した** —— **`GET` と `DELETE` はここに入らない。**
 */
export type RoleActionWriteKind = "create" | "update";

/**
 * **項目の書込判定の返り値**(`V8-M20` より前は `FieldWriteVerdict` という名前だった)。
 * **撤去した `field.writable_by` の層が持っていた型を、面の側へ移して残した。**
 */
export type RoleFieldWriteVerdict =
  | { kind: "allowed" }
  | { kind: "denied"; fields: readonly string[] };

/**
 * その操作起点の**書き先の表と書込の種類**を1本の規則で決める(`ADR-0249` 限定5 の形を、
 * `V8-M20` の撤去のあとも面のボタンの判定のために残したもの)。
 * **書き先を持たない形(遷移先の宣言 / 自動処理の起動)には `undefined` を返す。**
 *
 * - **遷移の形(`form` + `prefill`)** … **書き先は `action.form` が指す form 型ビューの
 *   `table`**(操作起点が乗っているビューの `table` **ではない**)。**種類は作成。**
 * - **値の書換の形(`set`)** … **書き先は乗っているビューの `table`。** **種類は更新。**
 * - **行き先の宣言の形 / 自動処理の起動の形** … **書き先を持たない**(壁を1本も立てない)。
 *
 * **`audience` を1バイトも読まない**(読んでいたのは呼び出し側の旧層であり、それは消えた)。
 */
function actionWriteTarget(
  action: Record<string, unknown>,
  view: Record<string, unknown>,
  views: readonly Record<string, unknown>[],
): { table: string; kind: RoleActionWriteKind } | undefined {
  if (typeof action.form === "string") {
    const target = views.find((v) => v.id === action.form && v.type === "form");
    return typeof target?.table === "string" ? { table: target.table, kind: "create" } : undefined;
  }
  if (action.set !== undefined && action.set !== null) {
    return typeof view.table === "string" ? { table: view.table, kind: "update" } : undefined;
  }
  return undefined;
}

// --- エラーの `allowed_values` から「見せない項目」のIDを落とす(V4-M35 / D-V4-124 の (c))----
//
// **`D-V4-124`(`docs/plan/v4/records/v4-open-questions.md` §5d)の逐語**:
//
// > **隠した項目に残る4つの漏れ口のうち、3つを塞ぐ** ——(a)並べ替えに使うと行の順序から
// > 大小関係が分かる /(b)作成・更新の応答に値がそのまま出る /**(c)入力エラーの文に項目名が
// > 並ぶ**。**(d)お客様が更新で書き込める、は今日のまま。**
//
// **置き場が本ファイルなのは `ADR-0061` 限定4 / `ADR-0071` 限定5 / `ADR-0077` 限定6
// (判定は `owner-scope.ts` に集約 / 呼び出し側に条件式を書かない)による** ——
// `src/server/app.ts` は下の1本を呼ぶだけで、宣言の読み方を1文字も持たない。
//
// **【`V8-M20`。旧文を1バイトも消していない】** **旧文はここで `audience` を名指ししていた。**
// **`V8-M20` / `T02` で、隠す側の宣言は面(`app.roles[].rules` の `target: "field"`)へ
// 置き直された。** **`app.ts` が1本を呼ぶだけである、という分担は1ミリも変わっていない。**

/**
 * **`ValidationError` の `allowed_values` から、面が名指しした項目のIDを落とす**
 * (`V4-M35`。`D-V4-124` の (c))。
 *
 * **【`V8-M20`。旧文を1バイトも消していない】** **旧文は「`audience` を宣言した項目のIDを落とす」だった。**
 * **`V8-M20` / `J-G28` で `field.audience` が撤去され、見る宣言が面へ移った。**
 * **問いの形(「サーバが隠すと決めた項目のIDを 400 から落とす」)は1ミリも変えていない。**
 *
 * ## なぜ要るのか(**実測**)
 *
 * **実在しない項目を指した 400 は、そのテーブルの**全フィールドID**を `allowed_values` に
 * 並べて返していた** —— **未ログインでも、客でも、同じ一覧が返っていた**
 * (2026-08-04 実測。`docs/plan/v4/records/v4-m35.md` §1)。**「隠した項目が何という名前で
 * 何本あるか」を、入力を1回間違えるだけで数え上げられる。**
 *
 * ## ロールを1つも見ない(**`ADR-0120` 限定2 と同じ形が取れた**)
 *
 * **`allowed_values` は今日も相手によらず同じ内容を返している。** **したがって落とす側も
 * 一律にできる** —— **owner の 400 からも落ちる。** **同じ URL が相手によって違う本文を
 * 返すことにならないので、`ADR-0086` 限定4 / `ADR-0112` 限定10 が禁じた「書けるが効かない」
 * の形にならない。**
 *
 * ## **フィールドIDの列挙にだけ当てる**(**黙って結果を変えない**。憲法6)
 *
 * `allowed_values` は**フィールドIDの列挙だけに使われているわけではない** ——
 * `select` の選択肢(`["新品", "良好"]`)・ロール(`["editor", "owner"]`)・
 * `["true", "false"]` / `["asc", "desc"]` にも使われている。**そこへ誤爆させると、
 * 隠すことと関係のないエラーの中身が静かに変わる。**
 *
 * **そこで、要素の全部が「そのテーブルのフィールドID」か「`_` で始まるシステム列」で
 * あるときだけ当てる。** **`_` の判定を綴りで書いているのは、`src/kernel/` の
 * `SYSTEM_COLUMN_NAMES` を**値として** import すると層またぎが1件増えるからである**
 * (`ADR-0009` 限定2 / `scripts/kernel-import-snapshot.txt`。**本ファイルの製品コードは
 * 層またぎが今日も0件である**)。
 *
 * ## **この関数が塞がないもの。誇張しない**
 *
 * - **`message` / `hint` は1バイトも書き換えない。** **そこに現れるのは「要求された側の
 *   綴り」であって、宣言つき項目のIDではない**(要求に宣言つき項目を書いた場合は
 *   `ADR-0120` の 400 が先に返る)。
 * - **`GET /manifest` は今日も全項目の定義を未ログインに返す**(`D-V4-91`)。
 *   **「隠した項目の存在を知られないようにする」は今日も達成されていない**
 *   (`ADR-0071` §限界4 が射程外と明記した目的である)。
 * - **MCP 経路には1ミリも掛からない**(`ADR-0071` 限定9)。
 */

/**
 * **面がその項目を名指ししているか**(`V8-M20` / `T02` の置き直し)。
 *
 * **`field.audience` を読んでいた3箇所を、この1本に寄せた** ——
 * (1) 400 の `allowed_values` から落とす(`scrubHiddenFieldIds`)/
 * (2) 読取要求の `filter` / `sort` に書かせない(`app.ts` の `hiddenFieldQueryErrors`)/
 * (3) 合計を出す列に指させない(`app.ts` の `sum_field`)。
 * **旧: `fieldAudience(field) !== undefined`。新: 面の項目の規則が1本でもその項目を名指し。**
 *
 * **ロールを1つも見ない**(`governed` だけを見る)—— **3箇所とも着手前から
 * 「相手によらず一律」であり、`ADR-0120` 限定2 がその形を明文で選んでいる。**
 * **相手ごとに変えると同じ URL が相手によって 200 と 400 に割れる。**
 */
export function isRoleGovernedField(manifest: unknown, tableId: string, fieldId: string): boolean {
  return judgeRoleAccess({
    manifest,
    roles: null,
    target: { target: "field", table: tableId, field: fieldId },
    verb: "read",
  }).governed;
}

export function scrubHiddenFieldIds(
  manifest: unknown,
  table: Table | undefined,
  errors: readonly ValidationError[],
): ValidationError[] {
  if (table === undefined) {
    return [...errors];
  }
  // **【`V8-M20` / `T02` の置き直し】隠す側の宣言が `field.audience` から**面**へ移った。**
  // **旧: `fieldAudience(field) !== undefined`(項目に「見せる相手」が宣言されているか)。**
  // **新: 面がその項目を名指ししているか(`governed`)。**
  //
  // **ロールを1つも渡していないのは意図である** —— **この関数は着手前も「相手によらず一律に
  // 落とす」形だった**(上の doc の「ロールを1つも見ない」)。**`allowed_values` は今日も
  // 相手によらず同じ内容を返しており、相手ごとに落とす量を変えると同じ URL が相手によって
  // 違う本文を返すことになる**(`ADR-0086` 限定4 / `ADR-0112` 限定10 が禁じた形)。
  // **したがって `governed`(= 誰かの規則がその項目を名指ししている)だけを見る。**
  const hidden = new Set(
    table.fields
      .filter((field) => isRoleGovernedField(manifest, table.id, field.id))
      .map((field) => field.id),
  );
  if (hidden.size === 0) {
    // **宣言が1本も無いテーブルは1ミリも変わらない**(既定は今日どおり)。
    return [...errors];
  }
  const fieldIds = new Set(table.fields.map((field) => field.id));
  return errors.map((error) => {
    const allowed = error.allowed_values;
    if (allowed === undefined) {
      return error;
    }
    // **フィールドIDの列挙でなければ1バイトも触らない**(select の選択肢・ロール・真偽値)。
    if (!allowed.every((value) => fieldIds.has(value) || value.startsWith("_"))) {
      return error;
    }
    const kept = allowed.filter((value) => !hidden.has(value));
    if (kept.length === allowed.length) {
      return error;
    }
    return { ...error, allowed_values: kept };
  });
}

// --- 役割に束ねた権限(面)の判定(`V8-M17`。台帳 `J-G6`〜`J-G11` / `J-G19`)-------------
//
// **`J-G6`〜`J-G8` の限定の逐語**: 「**判定はサーバ層の既存の家1本(`src/server/owner-scope.ts`)**」。
// **したがって面の判定はここに置く。** **`src/server/app.ts` に規則を読む条件式を1つも書かない**
// (`ADR-0061` 限定4 / `ADR-0071` 限定5 / `ADR-0077` 限定6 と同じ作法)。
//
// **【`judgeRecordAccess` の中に入れない】**(メインの裁定 `R-6`)—— **同関数の引数キーが
// 6本ちょうどであることを `access-control-role-precedence.test.ts` と
// `access-control-stale-grant.test.ts` が正規表現で数えている。** **面は別関数として立てる。**
//
// ## 面が働く範囲(裁定 `R-4`。**既定は今日どおり**)
//
//  - **`app.roles` が無い / 規則を1本も持たないアプリでは、面は全許可(no-op)である。**
//  - **面が働くのは「規則が1本でも書かれている対象」だけである** —— **ある表について
//    `rules` が1本も無ければ全許可、1本でもあれば allow-list(書かれていない役割は不許可)。**
//    **項目・画面・ボタンも同じ形。**
//  - **`can` に書かれていない動詞は「書かれていない」であって「拒否」ではない** ——
//    **引き算(deny)の値は語彙に1つも無い**(`J-G2` の限定)。**書かれていない動詞は
//    「まだ許されていない」であって、誰かが明示的に禁じたのではない。**
//  - **主体の実効ロール集合は `V8-M16` が作った和集合を使う**(`J-G3`)。
//    **未ログインは `anonymous` として扱う**(`J-G11`)。
//
// **【誇張しない】** **面の側に「持ち主だから見える」という分岐は1本も無い**(裁定 `R-13-3`)。
// **ただし固定ロールの層(`owner` / `editor` / `viewer` の表単位判定)は今日も製品に在る** ——
// **「持ち主の特別扱いが無くなった」とは書かない。**

/**
 * 面の規則が名指しできる**対象**(`D-V8-24` / `J-G10` の限定「対象は4種ちょうど」)。
 *
 * **ボタンは `(view, action)` の2つで名指しされる** —— **`action` だけでは一意にならない**
 * (識別子の一意性は画面ごとである)。
 *
 * =====================================================================================
 * **【2026-08-11 追記(`V8-M28`)。上の「対象は4種ちょうど」は今日から偽である。
 * 1バイトも消していない】**
 * =====================================================================================
 *
 * **`ADR-0304` 限定2(対象は4種ちょうど。`target` の `enum` は `table` / `field` /
 * `view` / `action`。5種目を足さない)を破った。**
 * **判定は `ADR-0007` §8 の台帳2行である** —— **`T-G14`(アプリの定義を変えられる人を、
 * 役割の規則で書ける。門A。**限定採用**)/ `T-G17`(人に役割を配れる人を、役割の規則で
 * 書ける。門A。**限定採用**)。** **ユーザ決定は `D-V8-49`。**
 *
 * **新しい2枝は、既存の4枝のどれとも形が違う** —— **プロパティが `target` 1本だけである。**
 * **名指しする対象を持たない**(アプリ全体 / 役割の配布そのものが対象なので、表IDも
 * 画面IDもボタンIDも無い)。**動詞は `write` 1語ちょうどである**(語彙側が絞っている)。
 */
export type RoleAccessTarget =
  | { readonly target: "table"; readonly table: string }
  | { readonly target: "field"; readonly table: string; readonly field: string }
  | { readonly target: "view"; readonly view: string }
  | { readonly target: "action"; readonly view: string; readonly action: string }
  | { readonly target: "app" }
  | { readonly target: "role" };

/**
 * **判定を下した層の名前**(メインの裁定 `N-13` / `R-5`)。
 *
 * - `"role"` … **面**(役割に束ねた権限。`app.roles[].rules`)。
 * - `"grant"` … **点**(v7 の行ごとの付与。`$defs/table.access_control`)。
 *
 * **旧4層(`view.audience` / `field.audience` / `field.writable_by` / `view_action.audience`)は
 * ここに入らない** —— **それらは今日も自分の述語で自分の場所を止めており、`V8-M20` が撤去する。**
 *
 * =====================================================================================
 * **【`V8-M27-T11`(2026-08-11)。この名前を HTTP へ出さないと決めた。理由を書く】**
 * =====================================================================================
 *
 * **計画 `docs/plan/v8/05-authz-unification-baseline.md` の `V8-M27` 完了の考え方 (iii) の
 * 逐語**: 「**撤去の前後で、同じ要求が「どの層で止まったか」を両方貼ること** ——
 * **`ADR-0305` 限定6 の `blockedBy` / `AccessLayerName` を使う。**」
 *
 * **着手時の実測**: **`blockedBy` は `src/server/app.ts` に 0件**
 * (`LC_ALL=C grep -c "blockedBy" src/server/app.ts` = `0`)。**HTTP のレコード経路・
 * バッチ・ファイル・手動起動のどれも、止めた層の名前を利用者にも記録にも出していない。**
 *
 * **`V8-M27` は「出さない」を選んだ。** **理由は3つである**:
 *
 *  1. **これは既に宣言済みの限界であり、黙って覆すべきものではない。**
 *     **`ADR-0308` の限界6 の逐語**: 「**止めた層の名前は HTTP の応答から読めない。
 *     応答の文面は層ごとに違うが、機械可読な層の名前は今日も載せていない。**」
 *     **出すようにすると、この限界が本文の記述と食い違う。** **引き直すには ADR の
 *     手続き(`amended_by` の双方向・`bun run adr:index`)が要り、それは `V8-M27` の
 *     射程外である。**
 *  2. **応答本文に出すと、`ADR-0305` 限定11 が伏せているものが漏れる。**
 *     **限定11 は「その表が在ること」を役割の外へ出さないために、一覧を空にし単件を
 *     404 にしている。** **そこへ `blockedBy: "role"` を載せると、「面が管轄している表が
 *     そこに在る」ことを、まさに読めない相手に告げてしまう** —— **伏せ方と出し方が
 *     正面から衝突する。**
 *  3. **監査記録に出すなら `_auth_activity` に列が1本要る。** **それは記録の形(語彙)の
 *     変更であり、`ADR-0007` の審査(門A/B/外)を通す対象である。** **`V8-M27` は
 *     撤去の MS であって、記録の形を増やす MS ではない。**
 *
 * **【代替。黙って飛ばしていない】** **完了の考え方 (iii) は「**実装のどの行が止めたか**」で
 * 果たした。** **撤去の**前**は `scratchpad/m27-before.md` が、本物の SQLite と実 HTTP で
 * 332件(本測定 171件 + 対照 161件)を採り、`errorBody()` を**行数を1行も増減させずに**
 * 計装してスタックの2段目から「止めた行」を実測している**(旧層が返した 403 は 37件 =
 * 当時の 403 の 100%)。**撤去の**後**は同じ題材・同じ手順で採り直した。**
 * **どちらもリポジトリの外(scratchpad)に置いてある** —— **`V8-M27` は `docs/` を
 * 1バイトも編集しない縛りで実施されたためである。**
 *
 * **【正直に書く】この代替は同値ではない。** **「実装のどの行が止めたか」は**開発者が
 * 計装して初めて分かる**ものであり、**利用者にも運用の記録にも今日1文字も出ていない。**
 * **`ADR-0308` の限界6 は今日も真である。**
 *
 * =====================================================================================
 * **【2026-08-13 追記(`V8-M39`。台帳 `F-G8` = 限定採用・門外 `Δ7`)。**
 * **上のブロックの本文を1バイトも消していない。「出さない」と決めた3つの理由も、**
 * **`V8-M27` 当時の実測(`blockedBy` は `app.ts` に 0件)も、逐語のまま残してある】**
 * =====================================================================================
 *
 * **`V8-M39` は「403 の文面にだけ出す」ことにした。**
 * **`docs/plan/v8/records/v8-m35.md` §5-1 の `F-G8` の限定の逐語**:
 * 「**文面にだけ出す。`ValidationError` の4キーを動かさない。403 のときだけ**
 * (**404 と空一覧には出さない**)」。
 *
 * **上の3つの理由それぞれとの関係を、丸めずに書く**:
 *
 *  1. **`ADR-0308` 限界6 の逐語は「**止めた層の名前は HTTP の応答から読めない。応答の
 *     文面は層ごとに違うが、機械可読な層の名前は今日も載せていない。**」である。**
 *     **`V8-M39` が出したのは `message` の中の文字列であって、機械可読な欄ではない** ——
 *     **`src/kernel/errors.ts` の `ValidationError` は今日も4キーちょうどであり、
 *     `blocked_by` のような5キー目を1本も足していない。**
 *     **したがって限界6 の第2文(「機械可読な層の名前は今日も載せていない」)は今日も真である。**
 *     **【正直に書く】第1文(「止めた層の名前は HTTP の応答から読めない」)は、
 *     **面(`role`)が止めた 403 については今日から偽である。** **`ADR-0308` を引き直す
 *     手続きは踏んでいない**(本 MS の射程外である)—— **この食い違いは `V8-M43` /
 *     `V8-M44` に持ち越す申し送りである。**
 *  2. **理由2(伏せているものが漏れる)は、出す先を 403 に限ることで避けている。**
 *     **`ADR-0305` 限定11 / `ADR-0317` 限定5 が伏せているのは「その表が在ること」であり、
 *     その伏せ方が使うのは**一覧の 200 の空一覧**と**単件の 404** である。**
 *     **その2つの本文には層の名前を1文字も出していない**(400 にも出していない)——
 *     **`src/server/role-403-layer-message.test.ts` の (D-1) / (D-2) / (D-3) が、
 *     本物の SQLite と実 HTTP でそれを固定している。**
 *     **403 が返る相手は「その対象が在ること」を既に知っている** ——
 *     **表IDも画面IDもボタンIDも、着手前から同じ 403 の文面に出ていたからである。**
 *  3. **理由3(監査記録に出すなら `_auth_activity` に列が1本要る)には1ミリも触っていない。**
 *     **`V8-M39` は記録の形を1つも変えていない** —— **層の名前が出るのは、その要求を
 *     出した相手が受け取る応答の文面だけであり、運用の記録には今日も1文字も出ていない。**
 *
 * **【出す先の全量。丸めない】** **層の名前が入るのは `src/server/app.ts` の
 * `forbiddenRoleAccessError`(= 面が止めた 403)と、その写しである
 * `src/mcp/tools/write.ts` の同名関数だけである。**
 * **点(`grant`)が止めた 403(`forbiddenRecordWriteError` / `forbiddenRecordDeleteError`)は
 * 1バイトも触っていない** —— **`AccessLayerName` の2値のうち、応答の文面に今日出るのは
 * `role` の1語だけである。**
 */
export type AccessLayerName = "role" | "grant";

/**
 * 面1回ぶんの判定結果。
 *
 * - `allowed` … 通ったか。
 * - `governed` … **その対象に規則が1本でも書かれているか**(= 面の管轄内か)。
 *   **`false` のときの `allowed` は常に `true` である**(裁定 `R-4` の no-op)。
 * - `blockedBy` … **止めた層の名前。通ったときは `null`。** **面が止めたときは `"role"`。**
 * - `conditional` … **【`V8-M18` / `J-G12`】その判定に条件(`when`)つきの規則が関与したか。**
 *   **真のとき、答えは行ごとに変わる** —— **行を渡さずに呼んだ判定は「通しうる」までしか
 *   言っていない**(下の `judgeRoleAccess` の doc)。**呼び出し側はこの旗を見て、行ごとに
 *   もう一度判定を掛けるかどうかを決める。** **偽のときは今日どおり行に依存しない。**
 */
export type RoleAccessDecision = {
  readonly allowed: boolean;
  readonly governed: boolean;
  readonly blockedBy: AccessLayerName | null;
  readonly conditional: boolean;
};

/** **面の管轄外**(規則が1本も書かれていない対象)。**全許可の1値を使い回す。** */
const UNGOVERNED_ROLE_ACCESS: RoleAccessDecision = {
  allowed: true,
  governed: false,
  blockedBy: null,
  conditional: false,
};

/**
 * **規則を1本も書いていない対象を「閉じる」ときの答え**(`V8-M26-T03`。
 * ユーザ決定 `D-V8-45` / `D-V8-58` / `D-V8-65`)。
 *
 * **`governed: true` にしてあるのが要点である** —— **{@link combineRoleAndGrantAccess} は
 * 「両方が管轄内なら `OR`」なので、`false` にすると v7 の行ごとの付与(点)が1ミリも
 * 効かなくなる。** **面と点の `OR` を `AND` へ戻していない**(明文の禁止)。
 */
const CLOSED_ROLE_ACCESS: RoleAccessDecision = {
  allowed: false,
  governed: true,
  blockedBy: "role",
  conditional: false,
};

/**
 * **【`V8-M26-T03`】規則が1本も無い対象に返す答えを、対象の種類で分ける。**
 *
 * **【着手前(`287c17f`)の逐語。1バイトも消していない】** ——
 * **`judgeRoleAccess` は「アプリが役割を1つも宣言していない」ときも「その対象を名指しした
 * 規則が1本も無い」ときも、4対象すべてについて {@link UNGOVERNED_ROLE_ACCESS}
 * (`allowed: true` / `governed: false`)を返していた** = **規則を書いていない対象は全許可。**
 *
 * **今日は `table` / `view` / `action` の3対象だけを閉じる**(ユーザ決定 `D-V8-45` /
 * `D-V8-58`)。
 *
 * **`field`(項目)は閉じない** —— **台帳 `T-G1b` は却下であり(`D-V8-58`)、
 * 項目は今日どおり「管轄外なら通す」のままである。** **これは「閉じ忘れ」ではなく決定である。**
 * **【禁止】「既定を全部閉じた」と書かない** —— **4対象のうち3対象である。**
 *
 * **未ログイン(`roles: null` → 主体 `anonymous`)にも同じ向きが及ぶ**(台帳 `T-G26a`)——
 * **本関数は主体を1つも見ないので、非対称を作りようがない。**
 *
 * =====================================================================================
 * **【2026-08-11 追記(`V8-M28`。ユーザ決定 `D-V8-59`)。上の逐語
 * 「**今日は `table` / `view` / `action` の3対象だけを閉じる**」は今日から偽である。
 * 1バイトも消していない】**
 * =====================================================================================
 *
 * **閉じるのは5対象である** —— **`table` / `view` / `action` に加えて、
 * `V8-M28` が足した `app`(アプリの設定)と `role`(人の役割)も閉じる。**
 * **根拠は `D-V8-59` の選ばれた見出しの逐語「**閉じる。持ち主には最初から2行入れておく**」。**
 *
 * **【本体を1バイトも書き換えていない】** —— **この式は「`field` 以外は閉じる」であり、
 * 対象が4種から6種に増えたことで、新しい2対象は**自動的に**閉じる側へ落ちる。**
 * **そのため `judgeRoleAccess` にも本関数にも分岐を1本も足していない。**
 *
 * **【禁止】「6対象すべてで既定を閉じた」と書かない** —— **閉じるのは5対象である**
 * (`D-V8-59` の注記が明文で禁じている)。**`field`(項目)は今日も閉じない**
 * (台帳 `T-G1b` = 却下 / `D-V8-58`)。
 */
function unruledRoleAccess(target: RoleAccessTarget): RoleAccessDecision {
  return target.target === "field" ? UNGOVERNED_ROLE_ACCESS : CLOSED_ROLE_ACCESS;
}

// --- **システムが持つ表は、面(役割の規則)の管轄外である**(`D-V8-69`)------------------
//
// **ユーザ決定 `D-V8-69`(2026-08-10)。選ばれた見出しの逐語**:
// **「システムの表は権限の外に置く」。**
// **選ばれた説明文の逐語**:
// > **変更履歴やアプリ一覧は今までどおり見えます。ただし「書いていなければ見えない」が及ばない
// > 先が1種類残り、総括に「ここには権限が効かない」と名指しで書くことになります。**
//
// ## なぜ要るのか(**実測。2026-08-10**)
//
// **`V8-M26-T03` が既定を閉じる側へ倒した結果、システムテーブル(`_apps` / `_changelog` /
// `_ai_usage`)が誰にも見えなくなった** —— **一覧は 200 のまま空、単件は 404、書込は 403。**
// **開ける書き方がマニフェストの語彙の中に1つも無い**:
//
// > `/app/roles/0/rules/0/table`: `table の値 "_apps" は識別子の規約に合いません。`
// > `英小文字で始まり、英小文字・数字・ハイフン・アンダースコアのみを使う1〜64文字に…`
//
// **`{ target: "table", table: "_apps" }` は `resource_id` の `^[a-z][a-z0-9_-]*$` に合わず、
// 適用時に拒否される。** **したがって「規則を書けば開く」という逃げ道が存在しない。**
//
// ## 【総括に書く義務。これは実装の都合ではなく決定の一部である】
//
// **`D-V8-69` の説明文が自ら述べているとおり、この免除は「『書いていなければ見えない』が
// 及ばない先」を1種類残す。** **総括(`docs/evidence/` の CP 文書)には
// 「**ここには権限が効かない**」を、下の {@link SYSTEM_TABLE_IDS} の全量とともに
// **名指しで**書くこと。** **「既定を閉じた」とだけ書いてはならない。**
//
// **効かない先の全量は `src/shared/system-tables.ts` が単一の出どころである** ——
// **ここに綴りを1つも書き写していない**(書き写すと、表が増えた日に片方だけ古くなる)。
//
// ## 【この免除がしないこと。誇張しない】
//
//  1. **システムテーブルが書けるようになったわけではない** —— **書込は今日どおり
//     カーネルの読み取り専用エラー(`readOnlyTableError`。`src/kernel/records.ts` の L1)と
//     `src/server/app.ts` の3箇所(`resolved.system`)が 400 で止める。**
//     **面が止めていた 403 が、元の 400 に戻るだけである。**
//  2. **認証境界は1バイトも開いていない** —— **未認証では今日どおり 401 である**
//     (`V4-M1` / `B-G6`。`src/server/auth-boundary.test.ts` が固定している)。
//  3. **行ごとの付与(点)にも1バイトも触っていない** —— **システムテーブルは
//     `manifest.app.tables` に居ないので、点は元から1度も掛からない。**

/**
 * **その対象が、システムが持つ表を指しているか**(`D-V8-69`。非 export)。
 *
 * **`table` / `field` の2種だけが表を名指しする**(`view` / `action` は画面の id であり、
 * 画面が投影を対象にできても、その画面自身の可否は今日どおり面が決める)。
 *
 * **【2026-08-11 追記(`V8-M28`)。確かめた結果を書く】** **新しい2対象
 * (`app` / `role`)では本述語は **`false`** を返す** —— **下の式の1つ目の条件
 * (`target.target === "table" || target.target === "field"`)が偽になるので、
 * `isSystemTableId` は1度も呼ばれない。** **したがって新2対象は `D-V8-69` の
 * 免除(システムの表は面の管轄外)に1ミリも掛からず、必ず面の判定を通る。**
 * **本述語の実装を1バイトも書き換えていない。**
 */
function targetsSystemTable(target: RoleAccessTarget): boolean {
  return (target.target === "table" || target.target === "field") && isSystemTableId(target.table);
}

/** マニフェストの役割の宣言の一覧。**形が壊れていれば空**(述語は例外を投げない)。 */
export function manifestRoleDeclarations(manifest: unknown): readonly Record<string, unknown>[] {
  const roles = (manifest as { app?: { roles?: unknown } } | null | undefined)?.app?.roles;
  if (!Array.isArray(roles)) {
    return [];
  }
  return roles.filter(
    (role): role is Record<string, unknown> => typeof role === "object" && role !== null,
  );
}

/**
 * 役割1件が持つ規則の一覧。**形が壊れている要素は落とす**(`target` が文字列で `can` が配列の
 * ものだけを残す)。**スキーマが値域を閉じているので、これは二重の歯止めである。**
 */
export function roleRulesOf(
  declaration: Record<string, unknown>,
): readonly Record<string, unknown>[] {
  const rules = declaration.rules;
  if (!Array.isArray(rules)) {
    return [];
  }
  return rules.filter(
    (rule): rule is Record<string, unknown> =>
      typeof rule === "object" &&
      rule !== null &&
      typeof (rule as { target?: unknown }).target === "string" &&
      Array.isArray((rule as { can?: unknown }).can),
  );
}

/** その規則が、その対象を名指ししているか(**対象の同一性だけを見る。動詞は見ない**)。 */
function ruleNamesTarget(rule: Record<string, unknown>, target: RoleAccessTarget): boolean {
  if (rule.target !== target.target) {
    return false;
  }
  switch (target.target) {
    case "table":
      return rule.table === target.table;
    case "field":
      return rule.table === target.table && rule.field === target.field;
    case "view":
      return rule.view === target.view;
    case "action":
      return rule.view === target.view && rule.action === target.action;
    // **【`V8-M28`。台帳 `T-G14` / `T-G17`】新しい2対象は「名指しする識別子」を持たない** ——
    // **`rule.target` が一致した時点で(上の1行目の等値比較を通った時点で)名指しである。**
    // **比較する識別子が1つも無いので `true` を返す。**
    // **【禁止】ここに「持ち主だから」の分岐を書かない** —— **可否を決めるのは
    // {@link judgeRoleAccess} 1本である**(`ADR-0305` 限定3「判定の家は1本」)。
    case "app":
    case "role":
      return true;
  }
}

/**
 * **実効ロール集合を、面の主体の綴りへ写す**(非 export)。
 * **1つも持たない相手(未認証)は `anonymous` 1語として扱う**(`J-G11` の限定)。
 */
function roleSubjectsOf(actor: ActorRoles | undefined): readonly string[] {
  const roles = roleSetOf(actor);
  return roles.length === 0 ? [ANONYMOUS_AUDIENCE] : roles;
}

// =====================================================================================
// **条件(`when`)の評価**(`V8-M18`。台帳 `J-G12` / `J-G13` / `J-G14` / `J-G15` / `J-G16`。
// メインの裁定 `R-7` / `R-17-7`)
//
// **【なぜ既存の絞り込みの評価器を使わないか】** —— **裁定 `R-17-7` の逐語。**
// **`compileFilter`(`src/kernel/records.ts`)も `compileFilterPredicate`
// (`src/kernel/read-records.ts`)も `export` されていない**(実測)。**さらに前者は SQL 断片を
// 返すものであり、`owner-scope.ts:634` が「**DB 側(`compileFilter`)には1バイトも落とさない**」
// と裁定済みである。** **したがって面の条件の評価器はサーバ層に新しく1本書く。**
//
// **【2026-08-16 訂正(`SQ-M4` / `SQ-M5`)。直前の5行を1バイトも書き換えていない】**
// **`compileFilterPredicate`(`src/kernel/read-records.ts`)は今日は存在しない** ——
// **システムテーブルの読取を SQL 経路へ一本化したときに削除された**(それまでは同じ宣言が
// 指す表によって違う意味に解釈されていた)。**今日ある絞り込みの評価器は `compileFilter` の
// 1本だけである**(**今日も非 export であり、今日も SQL 断片を返す**)。
// **裁定 `R-17-7` の結論は1ミリも変わらない** —— **使える評価器が2本から1本に減っただけで、
// 「サーバ層に新しく1本書く」という判断は同じである。**
// **この訂正は字面だけであり、判定のコードは1バイトも触っていない。**
//
// **【限界に書く】** **この結果、深さの制限は今日2つある** —— **絞り込みの側
// (`MAX_FILTER_DEPTH`)と、権限の条件の側(適用時にカーネルが同じ値で検査する)。**
//
// **【カーネルから値を1つも import しない】** —— **深さは適用時に検査済みなので、この評価器は
// 定数を1つも持たない**(裁定 `R-17-4`)。**`scripts/kernel-import-snapshot.txt` に製品コードの
// 行を1行も足していない。**
//
// **【この評価器から見えるもの・見えないもの】**(裁定 `R-17-3` / `J-G15`)
//  - **見えるのは**: **判定している行の項目の値**と、**要求している人の識別子**の2つだけ。
//  - **見えないのは**: 他の表 / 他の行 / 時刻 / 環境変数 / 集計値 / 参照先の中身。
//    **引数がその2つしか無いことが、この閉じ方の全部である**(値域はカーネルが適用時に閉じる)。
// =====================================================================================

/**
 * **条件1本の評価**(**再帰する側**。非 export)。
 *
 * **組み立ては3種ちょうど**(`and` / `or` / `not`)、**葉は2種ちょうど**
 * (`{field, equals}` / `{field, equals_current_user}`)。**値域はカーネルが適用時に閉じており、
 * ここは「知らない形は偽」に倒す**(二重の歯止め。例外を投げない)。
 *
 * **深さの再帰はここだけである** —— **入口(`evaluateRoleCondition`)は1回しか呼ばれず、
 * 「評価が1箇所に集約されている」ことを機械で数えられるようにしてある**(完了条件 (iv))。
 *
 * @param userId **要求している人の識別子。未ログインは `null`。**
 *   **`null` のとき「自分」の葉は**偽**である**(`J-G13` の限定 / 裁定 `R-17-5`)。
 *   **【禁止の履行】「未ログインでは起こらない」とは書かない** —— **未ログインの要求は
 *   今日も実在する**(匿名公開読取の窓が開いている表では、この評価器に実際に到達する)。
 *
 * **【`V8-M26`。ユーザ決定 `D-V8-70`(2026-08-11)。上の「**葉は2種ちょうど**」は今日から
 * 偽である。旧文を1バイトも消していない】**
 *
 * **葉は3種である** —— 3つ目は **`{field, is_empty}`**(**その項目が空か**)。
 *
 * **【「空」の意味。ここが唯一の定義ではない —— {@link isSharedOwner} をそのまま呼ぶ】**
 * **`null` / 値が入っていない / 長さ0の文字列 の3つを空とみなし、`0` と `false` は空では
 * ない。** **同じ判定を2箇所が別々に持たない** —— **`st_owner` の共有センチネルの判定と
 * 1バイトも同じ述語である。**
 *
 * **【実測が根拠である(2026-08-11。本物の SQLite + 実 HTTP)】** **共有化は
 * `PATCH {st_owner: null}` でも `PATCH {st_owner: 長さ0の文字列}` でも 200 で通り、
 * SQLite にはそれぞれ `NULL` と長さ0の `TEXT` が入る**(`typeof()` で確かめた)。
 * **どちらか一方だけを空とみなすと、共有化した行の半分が見えないままになる。**
 * **`undefined` も空に含めた理由**: **`row[field]` はその列が読取の射影から落ちていれば
 * `undefined` になる。** **「読めなかった」と「空だった」をここは区別できない** ——
 * **区別できないことを隠さずに書いておく。**
 *
 * **【未ログインでの答え。`equals_current_user` とは向きが違う】**
 * **この葉は `userId` を1バイトも見ない** —— **したがって未ログイン(`userId === null`)の
 * 要求でも真になりうる。** **「自分」の葉が未ログインで必ず偽である(裁定 `R-17-5`)のと
 * 同じ扱いにはしていない。** **理由は、この葉が問うているのが「行の項目が空か」だけで
 * あり、要求している人が誰かを1度も参照しないからである。**
 * **【その帰結。丸めない】** **`anonymous` の規則に `is_empty` を書けば、持ち主が空の行は
 * 未ログインの相手に見える。** **書いた人が選べることであって既定ではない** ——
 * **自動付与は `anonymous` に1本も入らない(`D-V8-45`)。**
 */
function roleConditionHolds(
  condition: unknown,
  row: Record<string, unknown>,
  userId: string | null,
): boolean {
  if (typeof condition !== "object" || condition === null || Array.isArray(condition)) {
    return false;
  }
  const node = condition as Record<string, unknown>;

  // --- 組み立て3種 -------------------------------------------------------------------
  if (Array.isArray(node.and)) {
    return node.and.every((child) => roleConditionHolds(child, row, userId));
  }
  if (Array.isArray(node.or)) {
    return node.or.some((child) => roleConditionHolds(child, row, userId));
  }
  if (Object.hasOwn(node, "not")) {
    return !roleConditionHolds(node.not, row, userId);
  }

  // --- 葉2種 -------------------------------------------------------------------------
  const field = node.field;
  if (typeof field !== "string") {
    return false;
  }
  const value = row[field];
  if (node.equals_current_user === true) {
    // **未ログイン(`userId === null`)では偽**(`J-G13` の限定)。
    // **比較の相手は認証アカウントの識別子である** —— **メンバー表の行を指す参照は
    // 一致しない**(§限界。`st_owner` が入れているのと同じ綴りだけが一致する)。
    return userId !== null && typeof value === "string" && value === userId;
  }
  if (Object.hasOwn(node, "equals")) {
    return sameConditionScalar(value, node.equals);
  }
  // --- 葉の3種目(`V8-M26` / `D-V8-70`)------------------------------------------------
  // **`is_empty: true` だけを見る** —— **`false` は値域に無い**(スキーマの `const: true`)
  // **ので、`true` 以外が来たら知らない形として偽に倒す。**
  // **述語は {@link isSharedOwner} をそのまま呼ぶ**(「空」の定義を2箇所に置かない)。
  if (node.is_empty === true) {
    return isSharedOwner(value);
  }
  return false;
}

/**
 * **等値の葉のスカラ比較**(非 export)。
 *
 * **原則は厳密比較である。** **例外は boolean と 0/1 の対応1組だけ** —— **SQLite は boolean を
 * 整数で持つので、`{field: "done", equals: true}` が読取経路の違いで真になったり偽になったり
 * しないように揃える。** **文字列と数値は1ミリも混ぜない**(`"1"` と `1` は別物)。
 *
 * **【正直に書く】** **項目の型と定数の型はカーネルが1度も突き合わせていない**
 * (`m18-vocab-report.md` §6 の「検出できない形」4)。**型が食い違う条件はここで静かに偽になる。**
 */
function sameConditionScalar(value: unknown, expected: unknown): boolean {
  if (typeof expected === "boolean" && typeof value === "number") {
    return value === (expected ? 1 : 0);
  }
  if (typeof value === "boolean" && typeof expected === "number") {
    return expected === (value ? 1 : 0);
  }
  return value === expected;
}

/** 規則1本の条件を評価した結果(非 export)。 */
type RoleConditionOutcome = {
  /** **その規則が条件を持っていたか**(= 答えが行に依存するか)。 */
  readonly conditional: boolean;
  /** **その規則がこの行を通すか。** **条件が無ければ常に真。** */
  readonly holds: boolean;
};

/**
 * **規則1本の条件を評価する入口**(非 export。**条件の評価はこの1本に集約されている**)。
 *
 * **`rule.when` を読む製品コードは、リポジトリ全体でこの1行だけである** ——
 * **完了条件 (iv)「条件の評価が1箇所に集約されていること」を機械で数えられるようにするため
 * であり、`src/server/role-conditions-enforcement.test.ts` の (E) がそれを固定している。**
 *
 * **【行を伴わない判定の扱い。穴を隠さない】**
 * **`row` が `undefined` のとき、条件つきの規則は「通しうる」(`holds: true`)として扱う。**
 * **これは「条件を満たした」という意味ではない** —— **判定できていないという意味である。**
 * **呼び出し側は `conditional` を見て、行ごとにもう一度判定を掛ける責任を負う。**
 * **今日そうしているのは読取の経路だけであり、書込・削除の経路は行を渡していない**
 * (= **条件つきの書込規則は行の中身を1度も見ずに通る**。**穴である。記録に書く**)。
 */
function evaluateRoleCondition(
  rule: Record<string, unknown>,
  row: Record<string, unknown> | undefined,
  userId: string | null,
): RoleConditionOutcome {
  const when = rule.when;
  if (when === undefined || when === null) {
    return { conditional: false, holds: true };
  }
  if (row === undefined) {
    return { conditional: true, holds: true };
  }
  return { conditional: true, holds: roleConditionHolds(when, row, userId) };
}

/**
 * **面の判定(この1本だけが規則を読む)**(`V8-M17`。`J-G6`〜`J-G11`)。
 *
 * **判定の流れは3段である。**
 *
 *  1. **アプリが役割を1つも宣言していなければ管轄外**(全許可)。
 *  2. **その対象を名指しした規則が1本も無ければ管轄外**(全許可)——
 *     **誰の規則であるかは問わない。「書かれている対象か」だけを見る**(裁定 `R-4`)。
 *  3. **1本でもあれば allow-list** —— **要求している人の実効ロール集合に属する役割の規則の
 *     どれかが、その動詞を `can` に書いていれば通す。** **書いていなければ止める。**
 *
 * **【引き算を1つも持たない】** **`can` は「できること」の列挙であり、拒否の値域は無い。**
 * **したがって本関数は「許しの積み上げ」しか行わない** —— **どの役割も他の役割の許しを
 * 取り消せない**(`J-G2` の限定「アプリの作者は既定に足すことしかできない」)。
 *
 * **【`V8-M18` / `J-G12`〜`J-G16`。上の「条件(`when`)は1バイトも見ない」は今日から偽である。
 * 旧文を1バイトも消していない】**
 *
 * **4段目が付いた**: **通す規則が条件(`when`)を持っていたら、その条件を評価する。**
 *
 *  - **評価は要求1本ごとの判定時である**(`J-G13` の限定)。**DB 側には1バイトも落とさない。**
 *  - **`row` を渡さない呼び方(表単位の関門など)では、条件つきの規則は「通しうる」として
 *    扱い、`conditional: true` を返す** —— **判定できていないことを呼び出し側に知らせる。**
 *  - **未ログインでは「自分」の葉は偽である**(裁定 `R-17-5`)。
 *
 * **【`V8-M26-T03`。ユーザ決定 `D-V8-45` / `D-V8-58` / `D-V8-65`。台帳 `T-G1b` / `T-G26a`。
 * 上の「1. …管轄外(全許可)」「2. …管轄外(全許可)」は今日から**項目についてだけ**真である。
 * 旧文を1バイトも消していない】**
 *
 * **既定が「閉じる」側へ倒れた** —— **1段目・2段目のどちらでも、`table` / `view` / `action`
 * の3対象は {@link CLOSED_ROLE_ACCESS}(`allowed: false` / `governed: true` /
 * `blockedBy: "role"`)を返す。** **`field`(項目)だけが今日どおり全許可である**
 * (`T-G1b` = 却下)。
 *
 * - **役割を1つも宣言していないアプリも閉じる**(`D-V8-65`)。**ただしそこでも項目は閉じない。**
 * - **未ログイン(`roles: null` → 主体 `anonymous`)にも同じ向きが及ぶ**(`T-G26a`)。
 * - **`governed: true` を返すのが要点である** —— **{@link combineRoleAndGrantAccess} が
 *   「両方が管轄内なら `OR`」なので、v7 の行ごとの付与(点)は今日どおり効き続ける。**
 *   **面と点の `OR` を `AND` へ戻していない**(明文の禁止)。
 * - **呼び出し側の作法は `ADR-0305` 限定11 のままである** —— **一覧は応答から落とす(空一覧)/
 *   単件は 404。** **403 で全部返す形にしていない。**
 *
 * **【禁止】これを「既定を全部閉じた」と書かない** —— **4対象のうち3対象である。**
 *
 * =====================================================================================
 * **【2026-08-11 追記(`V8-M28`。台帳 `T-G14` / `T-G17`)。直前の1行は今日から偽である。
 * 1バイトも消していない】** **今日は **6対象のうち5対象**である**(`app` / `role` が
 * 増え、どちらも閉じる側)。**閉じないのは `field` だけである。**
 *
 * **【本関数に分岐を1本も足していないことを、確かめて書く】** ——
 * **`V8-M28` は `judgeRoleAccess` の本体を1バイトも書き換えていない。** 確かめた経路は4つ:
 *
 *  1. **`targetsSystemTable`** … 新2対象では **`false`**(`target.target` が `table` でも
 *     `field` でもないので、1つ目の条件で落ちる)。**免除に掛からない。**
 *  2. **役割の宣言が0件** … `unruledRoleAccess(target)` へ落ち、`field` 以外なので
 *     **{@link CLOSED_ROLE_ACCESS}**(= **既定で閉じる**。`D-V8-59` の履行)。
 *  3. **対象を名指しした規則が1本も無い(`!governed`)** … 同じく **閉じる**。
 *  4. **1本でもある** … 既存の allow-list の輪がそのまま働く。
 *     **`ruleNamesTarget` が新2対象で `rule.target` の一致だけを見る**ので、
 *     **`can` に `write` が在り、その役割が実効ロール集合に居れば通る。**
 *     **`when` は語彙側が `false` で閉じているので、条件つきにはならない
 *     (`evaluateRoleCondition` は `when` が無ければ常に成立を返す)。**
 *
 * **【禁止】「新しい2対象のために判定を1本足した」と書かない** —— **足していない。**
 * **【禁止】これを「定義の変更が守られるようになった」と書かない** —— **`POST /diffs` の
 * 関門も役割を配る口も、今日はこの判定を1バイトも読んでいない**(配線は後続の MS)。
 *
 * @param row **判定する行。省略できる**(省略 = 行を伴わない判定)。
 * @param subject **要求している人の識別子。未ログインは `null`。**
 */
export function judgeRoleAccess(params: {
  manifest: unknown;
  roles: ActorRoles;
  target: RoleAccessTarget;
  verb: RoleRuleVerb;
  row?: Record<string, unknown> | undefined;
  subject?: string | null | undefined;
}): RoleAccessDecision {
  // **【`D-V8-69`】システムが持つ表は、面の判定を1度も受けない**(上の節)。
  // **`governed: false` で返すので、呼び出し側は着手前(`287c17f`)と1バイトも変わらない
  // 経路を通る** —— **一覧は落とされず、単件は 404 にならず、書込は読み取り専用の 400 に戻る。**
  // **【総括に書く義務】この1行が「ここには権限が効かない」先を作っている。**
  if (targetsSystemTable(params.target)) {
    return UNGOVERNED_ROLE_ACCESS;
  }
  const declarations = manifestRoleDeclarations(params.manifest);
  if (declarations.length === 0) {
    // **【`V8-M26-T03` / ユーザ決定 `D-V8-65`。旧の1行を逐語で残す】**
    // **旧: `return UNGOVERNED_ROLE_ACCESS;`**(= **役割を1つも宣言していないアプリは全許可**)。
    // **今日: 表・画面・ボタンは閉じる。** **項目だけは今日どおり通す**(`T-G1b` = 却下)。
    return unruledRoleAccess(params.target);
  }
  const subjects = roleSubjectsOf(params.roles);
  let governed = false;
  let allowed = false;
  let conditional = false;
  for (const declaration of declarations) {
    const id = typeof declaration.id === "string" ? declaration.id : undefined;
    for (const rule of roleRulesOf(declaration)) {
      if (!ruleNamesTarget(rule, params.target)) {
        continue;
      }
      // **誰の規則であっても、対象が名指しされた時点で allow-list になる**(裁定 `R-4`)。
      governed = true;
      if (id === undefined || !subjects.includes(id)) {
        continue;
      }
      if (!(rule.can as readonly unknown[]).includes(params.verb)) {
        continue;
      }
      // **【`V8-M18`】条件の評価。** **この1行だけが `rule.when` を読む**(完了条件 (iv))。
      const outcome = evaluateRoleCondition(rule, params.row, params.subject ?? null);
      if (outcome.conditional) {
        conditional = true;
      }
      if (outcome.holds) {
        allowed = true;
      }
    }
  }
  if (!governed) {
    // **【`V8-M26-T03` / ユーザ決定 `D-V8-45` / `D-V8-58`。旧の1行を逐語で残す】**
    // **旧: `return UNGOVERNED_ROLE_ACCESS;`**(= **その対象を名指しした規則が1本も無ければ
    // 全許可**)。**今日: 表・画面・ボタンは閉じる。** **項目だけは今日どおり通す。**
    return unruledRoleAccess(params.target);
  }
  return allowed
    ? { allowed: true, governed: true, blockedBy: null, conditional }
    : { allowed: false, governed: true, blockedBy: "role", conditional };
}

/**
 * **その対象を名指しした規則が、どれかの役割に1本でも書かれているか**
 * (`V8-M26-T03b`。ユーザ決定 `D-V8-45` / `D-V8-65`。台帳 `T-G1a` / `T-G4b`)。
 *
 * ## なぜこの述語が要るのか(**着手前の実測**)
 *
 * **`V8-M26-T03` が既定を閉じる側へ倒すまで、{@link RoleAccessDecision} の `governed` は
 * 2つの問いに同時に答えていた**:
 *
 *  1. **「その対象を名指しした規則が1本でも書かれているか」**(= **宣言の実在**)。
 *  2. **「面がその対象について何か言うか」**(= **管轄内か**)。
 *
 * **既定が閉じた今日、2つは別の問いになった** —— **表・画面・ボタンは、規則を1本も
 * 書いていなくても `governed: true`(閉じる側の管轄内)で返る。** **したがって
 * `governed` はもう問い1 の答えではない。**
 *
 * **本述語は問い1 だけに答える** —— **意味は「既定を閉じる前の `governed`」そのものである。**
 *
 * **判定のロジックを2本目に増やしていない** —— **{@link ruleNamesTarget} を再利用しており、
 * 対象の同一性の読み方は `judgeRoleAccess` とまったく同じ1本である。**
 * **動詞(`can`)も条件(`when`)も主体(役割)も1バイトも見ない** —— **「名指しされているか」
 * だけを見る**(`judgeRoleAccess` の中で `governed = true` を立てている行と同じ条件)。
 *
 * ## 【これが遮断ではないことを明記する】
 *
 * **本述語は許可を1ミリも決めない。** **可否を決めるのは {@link judgeRoleAccess} 1本のままで
 * あり、本述語を見て何かを通す・止める実装を書いてはならない。** **今日の唯一の用途は
 * 「レコード取得の URL に `?view=` を付けるかどうか」**(`web/src/auth/authz.tsx` の
 * `viewIdForRecordRequest`)**であり、それは名乗りであって壁ではない。**
 */
export function roleRulesNameTarget(params: {
  manifest: unknown;
  target: RoleAccessTarget;
}): boolean {
  for (const declaration of manifestRoleDeclarations(params.manifest)) {
    for (const rule of roleRulesOf(declaration)) {
      if (ruleNamesTarget(rule, params.target)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 面と点を重ねた結果。**止めた層の全量を名指しする**(裁定 `N-13`)。
 *
 * **【`V8-M19` で `blockedBy` の意味が広がった。旧の意味を残す】** ——
 * **旧(`V8-M17`)**: 「止めた層の全量。**通ったときは空。**」(**`AND` だったので、
 * 1本でも止めれば `allowed` が偽になり、`allowed` が真なら `blockedBy` は必ず空だった**)。
 * **今日(`V8-M19`。`OR`)**: **`blockedBy` は「その層だけを見れば通さなかった層」の全量である。**
 * **`allowed` が真でも空でないことがある** —— **片方が止めても、もう片方が通せば通るからである。**
 * **これが「止めた層を名指しできる」ことを `OR` のもとでも保つ形である**(裁定 `R-5`)。
 */
export type CombinedAccessDecision = {
  readonly allowed: boolean;
  /**
   * **その層だけを見れば通さなかった層の全量。** **管轄外の層は入らない**
   * (面が規則を1本も持たない対象 / 点が宣言していない表)。
   */
  readonly blockedBy: readonly AccessLayerName[];
};

/**
 * **面(役割に束ねた権限)と点(行ごとの付与)を `OR` で重ねる**(`V8-M19` / `D-V8-23`)。
 *
 * ## **【`V8-M19` が `AND` を `OR` に変えた】**
 *
 * **`V8-M17` は中間状態として `AND` を置いていた**(旧 doc の逐語:
 * 「**`V8-M17` の時点では、面は他のすべての層と `AND` で重なる**(点とも `AND`)——
 * **どちらかが止めれば止まる**」)。**`V8-M19` が `D-V8-23`(どちらかで許されれば通る)に
 * 従って、面 と 点 の間だけを `OR` に変えた。** **予告ではなく、変えたあとの姿がこれである。**
 *
 * **合成の単位は(行, 要求している人, 動詞)ちょうどである**(`J-G18` の限定)——
 * **引き算も、順序も、勝ち負けの規則も、1つも作っていない。**
 *
 * ## **管轄(オプトイン)の扱い —— ここが素朴な `OR` と違う唯一の点である**
 *
 * **どちらの層も「宣言していなければ何も言わない」層である**(面は規則を1本も持たない対象、
 * 点は `access_control` を宣言していない表)。**素朴に `allowed || allowed` と書くと、
 * 面が管轄外(= 全許可)の表で点が1ミリも効かなくなり、`D-V8-19`(v7 の行ごとの付与を
 * 今日どおり効かせる)が壊れる。** **したがって重ねるのは「両方が管轄内のとき」だけであり、
 * 片方だけが管轄内ならその層の答えがそのまま答えになる。**
 *
 * - **面が管轄外** → **点の答えがそのまま答え**(v7 のアプリは今日と1バイトも変わらない)。
 * - **点が管轄外** → **面の答えがそのまま答え**(`V8-M17` と1バイトも変わらない)。
 * - **両方が管轄内** → **`OR`。どちらかが通せば通る。**
 *
 * **【禁止】「`OR` なので安全側に倒れる」と書かない** —— **`OR` は見える側に倒れる**
 * (`04` §7-2 の 7)。**面で締めても点が開いていれば見える。**
 *
 * **【旧4層との重ね順は今日も `AND` である】** —— **`view.audience` / `field.audience` /
 * `field.writable_by` / `view_action.audience` / `st_admin_readable` は、それぞれの場所で
 * 今日も自分で止める。** **撤去は `V8-M20` である。**
 *
 * @param grant **点の判定結果。`undefined` は「点が管轄外」**
 *   (`judgeRecordAccess` が宣言の無い表へ返す `UNGOVERNED_RECORD_ACCESS` と同じ意味)。
 */
export function combineRoleAndGrantAccess(params: {
  role: RoleAccessDecision;
  grant: RecordAccessVerdict | undefined;
  verb: RoleRuleVerb;
}): CombinedAccessDecision {
  const roleGoverned = params.role.governed;
  const grantGoverned = params.grant !== undefined;
  const roleAllows = params.role.allowed;
  const grantAllows = params.grant?.[params.verb] === true;
  const blocked: AccessLayerName[] = [];
  if (roleGoverned && !roleAllows) {
    blocked.push("role");
  }
  if (grantGoverned && !grantAllows) {
    blocked.push("grant");
  }
  // **両方が管轄内なら `OR`。片方だけならその層。どちらも管轄外なら通す。**
  const allowed =
    roleGoverned && grantGoverned
      ? roleAllows || grantAllows
      : roleGoverned
        ? roleAllows
        : grantGoverned
          ? grantAllows
          : true;
  return { allowed, blockedBy: blocked };
}

/**
 * **面の表単位の関門が、点を見るまでもなく止めてよいか**(`V8-M19`)。
 *
 * **`OR` にしたので、面が止めても点が通す行がありうる** —— **したがって「行を手元に持って
 * いない関門」(表単位の中継層・一覧の入口)は、点が管轄内の表では止めてはならない。**
 * **止めると `OR` が `AND` に戻る。**
 *
 * **`true` を返したら、その場で止めてよい**(点が管轄外なので、面の答えが最終の答えである)。
 *
 * **【ここに規則を読む条件式は1つも無い】** —— **面の答えと「点が管轄内か」の2つだけを見る。**
 */
export function roleGateBlocksWithoutGrants(params: {
  role: RoleAccessDecision;
  grantGoverned: boolean;
}): boolean {
  return !params.role.allowed && !params.grantGoverned;
}

/**
 * **「これから作る行」について、面と点を `OR` で重ねる**(`V8-M21` / 台帳 `J-G21` /
 * `J-G22a` / `J-G23` / ユーザ決定 `D-V8-23`)。
 *
 * ## なぜ {@link combineRoleAndGrantAccess} をそのまま呼べないか
 *
 * **作成には行がまだ無いので、点の答えは {@link judgeRecordAccess} ではなく
 * {@link creatorGrantPlan} が出す**(付与が1件も無い行を判定に掛けると、誰に対しても
 * 偽になる)。**本関数は `CreatorGrantPlan` を `RecordAccessVerdict` の形に**写すだけ**で、
 * 合成そのものは {@link combineRoleAndGrantAccess} の1本に委ねる** ——
 * **合成の規則を2本目に増やしていない。**
 *
 * **写し方(この1行が全部である)**: **`no_member`(メンバー表に行が無い)だけが「点は
 * 通さない」であり、それ以外(`grant` / `unusable`)は「点は通す」である。**
 * **これは `V8-M21` の前半が置いた判定と1バイトも同じ向きである**(あちらは
 * `plan?.kind !== "no_member"` で通していた)。**厳しくも緩くもしていない。**
 *
 * @param plan **点の答え。`undefined` は「点が管轄外」**(宣言していない表 /
 *   `enabled: false` の表)。
 *
 * **【`OR` は見える側・書ける側に倒れる】** —— **面が締めても点が開いていれば書ける。**
 * **【禁止】「`OR` なので安全側に倒れる」と書かない**(`04` §7-2 の 7)。
 */
export function combineRoleAndCreatorGrant(params: {
  role: RoleAccessDecision;
  plan: CreatorGrantPlan | undefined;
}): CombinedAccessDecision {
  return combineRoleAndGrantAccess({
    role: params.role,
    grant:
      params.plan === undefined
        ? undefined
        : { read: false, write: params.plan.kind !== "no_member", delete: false },
    verb: "write",
  });
}

/** 動詞ごとに「その層だけを見れば通さなかった層」を持つ束(裁定 `N-13` を `OR` の下で保つ)。 */
export type RecordAccessBlockedLayers = {
  readonly read: readonly AccessLayerName[];
  readonly write: readonly AccessLayerName[];
  readonly delete: readonly AccessLayerName[];
};

/**
 * **面と点を重ねた、行1件ぶんの答え**(`V8-M19`)。
 *
 * **`RecordAccessResolution` と同じ形をしている**(`kind` / `verdict` / `limit`)——
 * **既存の呼び出し側はキーを1つも足さずにそのまま読める。** **`blockedBy` はその上に
 * 足した1本であり、読まない呼び出し側の振る舞いは1ミリも変わらない。**
 */
export type CombinedRecordAccessResolution =
  | { readonly kind: "limit_exceeded"; readonly limit: "depth" | "rows" }
  | {
      readonly kind: "verdict";
      readonly verdict: RecordAccessVerdict;
      readonly blockedBy: RecordAccessBlockedLayers;
    };

/**
 * **行1件について、面と点を `OR` で重ねた答えを出す**(`V8-M19` / `J-G18` / `J-G20`)。
 *
 * ## **`J-G20` の限定の逐語を、この関数の形が満たしている**
 *
 * 限定は「**`walkAccessInheritance` の外側で役割の側を1回だけ評価する形**」である。
 * **本関数は、面を先に評価してから {@link resolveRecordAccess} を呼ぶ** ——
 * **辿り(`walkAccessInheritance`)の中では面を1度も評価しない。**
 * **したがって、引き継ぎの段数を1段から5段へ増やしても、面の評価回数は増えない**
 * (`src/server/role-grant-union.test.ts` の (G) が `app.roles` の読み出し回数を数えて
 * 機械的に固定している)。
 *
 * **面は動詞3つぶん(読取 / 書込 / 削除)を1度ずつ評価する** —— **合成の単位に動詞が
 * 入っているからであり**(`J-G18`)、**段ごとの評価ではない。**
 *
 * @param sources **点の「読むべき表」。`undefined` は点が管轄外**
 *   ({@link recordAccessSourceTables} が返すもの)。
 */
export function resolveCombinedRecordAccess(params: {
  manifest: Manifest;
  tableId: string;
  row: Record<string, unknown>;
  actorId: string | null;
  roles: ActorRoles;
  sources: RecordAccessSourceTables | undefined;
  readRows: (tableId: string) => readonly Record<string, unknown>[];
  readRow: (tableId: string, recordId: string) => Record<string, unknown> | undefined;
}): CombinedRecordAccessResolution {
  const { manifest, tableId, row, actorId, roles, sources, readRows, readRow } = params;
  // **(1) 面を1回だけ評価する**(`J-G20`)—— **辿りの外側である。**
  const target: RoleAccessTarget = { target: "table", table: tableId };
  const role = {
    read: judgeRoleAccess({ manifest, roles, target, verb: "read", row, subject: actorId }),
    write: judgeRoleAccess({ manifest, roles, target, verb: "write", row, subject: actorId }),
    delete: judgeRoleAccess({ manifest, roles, target, verb: "delete", row, subject: actorId }),
  };
  // **(2) 点を解く。** **引き継ぎを辿るのはこの中だけである。**
  const grant =
    sources === undefined
      ? undefined
      : resolveRecordAccess({ manifest, tableId, row, actorId, readRows, readRow });
  if (grant?.kind === "limit_exceeded") {
    return grant;
  }
  const verdict = grant?.kind === "verdict" ? grant.verdict : undefined;
  // **(3) 動詞ごとに重ねる**(合成の単位は(行, 要求している人, 動詞)ちょうど)。
  const read = combineRoleAndGrantAccess({ role: role.read, grant: verdict, verb: "read" });
  const write = combineRoleAndGrantAccess({ role: role.write, grant: verdict, verb: "write" });
  const remove = combineRoleAndGrantAccess({ role: role.delete, grant: verdict, verb: "delete" });
  return {
    kind: "verdict",
    verdict: { read: read.allowed, write: write.allowed, delete: remove.allowed },
    blockedBy: { read: read.blockedBy, write: write.blockedBy, delete: remove.blockedBy },
  };
}

// --- 母集団(だれの目に、どの行が入るか)を決める1本 ------------------------------
//
// **`V8-M10-T02`(台帳 `Q-G16a` / `Q-G21d`)。仕様は `docs/plan/v8/records/v8-m10.md` §1 の
// `T02` と、独立点検による差し替え `2'` / `2''` である。**
//
// **着手前、可視な行の集合を決めるコードは `src/server/app.ts` のレコード一覧のルートの
// 中に5分岐として在った。** **同じ判定を集計表の経路にも通すために、ここへ集めた** ——
// **`ADR-0061` 限定4(判定は `owner-scope.ts` に集約。呼び出し側に条件式を書かない)を
// 守る側である。**
//
// **【この1本に集約しないもの。逐語で書く(`2''` の義務)】**
// **射影(`dropHidden` / `projectForAnonymous`)・表示名の解決(`resolveOwnerDisplays`)・
// ページ切り・件数の採り方は集約しない**(今日の場所 = `app.ts` に残す)。
// **後から「1本に集めきれていない」と読まれないために、ここに書いておく。**
//
// **【群を1つも知らない(`Q-G21d`)】** **入力は行、出力は行である。**
// **群を作ってから絞る形は、この関数の形の上で書けない。**

/**
 * **母集団の分類**(どの絞り方をする表か)。**行を1件も見ない** ——
 * **`app.ts` が「DB に `LIMIT` / `OFFSET` を渡してよいか」を読取の**前**に決めるために要る。**
 */
export type RecordPopulationScope =
  | "anonymous_public"
  | "owner_scoped"
  | "record_access"
  | "role_conditional";

/** {@link RecordPopulationScope} + **絞りが要らない**(分岐5 = 非スコープ)。 */
export type RecordPopulationClass = RecordPopulationScope | "unfiltered";

/**
 * **母集団の答え。返すのは3つだけである**(`v8-m10.md` §1 `T02` の `2'`)。
 *
 * 1. **可視行の集合**(`visible`)
 * 2. **絞りは要らない**(`unfiltered`)—— **レコード一覧は今日どおり SQL 1文で件数と合計を
 *    採り続ける**(`ADR-0104` 限定6)。**集計表の経路は全行を母集団にする。**
 * 3. **上限に当たった**(`limit_exceeded`)—— **黙って行を落とさない**(`Z-G17`)。
 */
export type RecordPopulation =
  | { readonly kind: "unfiltered" }
  | {
      readonly kind: "visible";
      readonly scope: RecordPopulationScope;
      readonly rows: Record<string, unknown>[];
    }
  | { readonly kind: "limit_exceeded"; readonly limit: "depth" | "rows" };

/**
 * **どの絞り方をする表かを決める**(行を1件も見ない)。
 *
 * **順序は着手前の `app.ts` の5分岐の順そのものである** —— **入れ替えると答えが変わる。**
 * **`app.ts` の `postFiltered`(= DB のページングを外すか)は、この答えが `"unfiltered"`
 * でないことと1バイトも同じである。**
 */
export function recordPopulationScope(params: {
  manifest: Manifest;
  table: Table;
  anonymousPublic: boolean;
  accessSources: RecordAccessSourceTables | undefined;
  tableRead: RoleAccessDecision;
}): RecordPopulationClass {
  // **匿名公開は最初に見る** —— **匿名には actor が無いので、以降の分岐が成り立たない。**
  if (params.anonymousPublic) {
    return "anonymous_public";
  }
  if (personalOwnerField(params.table) !== undefined) {
    return "owner_scoped";
  }
  if (params.accessSources !== undefined) {
    return "record_access";
  }
  if (params.tableRead.conditional) {
    return "role_conditional";
  }
  return "unfiltered";
}

/**
 * **(表, 要求している人) から母集団を決める1本**(`Q-G16a`)。
 *
 * @param params.rows **絞る前の行**(`filter` / `sort` は済んでいてよいが、**ページは
 *   切っていない**)。
 * @param params.judge **行ごとの点(付与)と面の合成判定**(`app.ts` の `recordAccessJudge`
 *   が組んだもの。**`undefined` は点が管轄外**)。**ここで DB を読まない** ——
 *   **本ファイルは `src/kernel/` から値を1つも import しないという性質を保つ。**
 */
export function judgeRecordPopulation(params: {
  manifest: Manifest;
  table: Table;
  tableId: string;
  rows: Record<string, unknown>[];
  anonymousPublic: boolean;
  actorId: string | null;
  roles: ActorRoles;
  accessSources: RecordAccessSourceTables | undefined;
  tableRead: RoleAccessDecision;
  judge: ((row: Record<string, unknown>) => CombinedRecordAccessResolution) | undefined;
}): RecordPopulation {
  const { manifest, tableId, rows, actorId, roles, tableRead, judge } = params;
  const scope = recordPopulationScope(params);
  // **面の**条件つき**規則の行ごとの評価**(`V8-M18` / `J-G12`)。
  // **条件つきの規則が1本も無ければ呼ばない** —— **答えが行に依存しないので、
  // 着手前と1バイトも変わらない。**
  const roleRowReadable = (row: Record<string, unknown>): boolean =>
    !tableRead.conditional ||
    judgeRoleAccess({
      manifest,
      roles,
      target: { target: "table", table: tableId },
      verb: "read",
      row,
      subject: actorId,
    }).allowed;

  switch (scope) {
    case "anonymous_public": {
      // **`st_public` が厳密に true の行だけ。** **未ログインでも面の条件は当たる**
      // (`J-G13`。**「自分」は偽に評価される**)。
      const visible = rows.filter((row) => isPublicRow(row)).filter((row) => roleRowReadable(row));
      return { kind: "visible", scope, rows: visible };
    }
    case "owner_scoped": {
      // **重ね順は AND**(`v7-m0.md` §5-4 (iv))—— **所有者スコープを1ミリも上書きしない。**
      // **【`V8-M20` / `D-V8-35`】読取についてだけ
      // `( st_owner を満たす OR 面が読取を許している )` である。**
      // **【`V8-M19`】面と点は `judge` の中で `OR` に重なっているので、
      // `judge` が居ないときだけ面をここで当てる**(当てると `AND` に戻るため)。
      const scoped = rows.filter(
        (row) =>
          (isOwnerVisible(row[OWNER_FIELD], actorId ?? "") ||
            roleReadCrossesOwnerScope({
              manifest,
              roles,
              table: tableId,
              row,
              subject: actorId,
            })) &&
          (judge !== undefined || roleRowReadable(row)),
      );
      const judged = scoped.map((row) => ({
        row,
        access: judge === undefined ? undefined : judge(row),
      }));
      const limited = judged.find((entry) => entry.access?.kind === "limit_exceeded")?.access;
      if (limited?.kind === "limit_exceeded") {
        return { kind: "limit_exceeded", limit: limited.limit };
      }
      return {
        kind: "visible",
        scope,
        rows: judged
          .filter(
            (entry) =>
              entry.access === undefined ||
              (entry.access.kind === "verdict" && entry.access.verdict.read),
          )
          .map((entry) => entry.row),
      };
    }
    case "record_access": {
      const judged =
        judge === undefined
          ? []
          : rows.map((row) => ({
              row,
              access: judge(row),
            }));
      const limited = judged.find((entry) => entry.access.kind === "limit_exceeded")?.access;
      if (limited?.kind === "limit_exceeded") {
        return { kind: "limit_exceeded", limit: limited.limit };
      }
      return {
        kind: "visible",
        scope,
        rows: judged
          .filter((entry) => entry.access.kind === "verdict" && entry.access.verdict.read === true)
          .map((entry) => entry.row),
      };
    }
    case "role_conditional":
      return { kind: "visible", scope, rows: rows.filter((row) => roleRowReadable(row)) };
    case "unfiltered":
      // **絞りは要らない** —— **レコード一覧は SQL 1文へ、集計表は全行を母集団にする。**
      return { kind: "unfiltered" };
    default: {
      // **網羅を型で固定する**(`v8-m10.md` §2-7 の「構造的な死角」への手当て ——
      // **`if` で消費していると、戻り値にバリアントを足しても検査に引っかからない**)。
      const exhaustive: never = scope;
      throw new Error(`未知の母集団の分類: ${String(exhaustive)}`);
    }
  }
}

/**
 * **読取応答から、面の規則で見せないと決まった項目を落とす**(`J-G7`)。
 *
 * **`projectForFieldAudience`(旧層)と同じ形・同じ層に置く** —— **どちらも「値をキーごと
 * 落とす」射影であり、重ねると見える項目は両方の積になる**(= `AND`)。
 * **【`V8-M19` による訂正。旧文の逐語は「(= `AND`。上の合成と同じ向き)」である】** ——
 * **上の合成(`combineRoleAndGrantAccess`)は今日 `OR` であり、もう同じ向きではない。**
 * **項目には点(行ごとの付与)が1つも無いので、`OR` の相手が存在しない** ——
 * **旧層との重ね順が `AND` であることだけが今日も真である**(撤去は `V8-M20`)。
 * **旧層の実装は1バイトも消していない**(撤去は `V8-M20`)。
 *
 * - **規則の書かれていない項目は1つも落とさない**(裁定 `R-4`)。
 * - **`_id` / `_created_at` / `_updated_at` などフィールド定義に無いキーは1つも触らない**
 *   (`projectForRead` / `projectForFieldAudience` と同じ規律)。
 *
 * **【`V8-M18` / `J-G12`】条件(`when`)つきの項目の規則も、ここで行ごとに効く。**
 * **条件を当てる行は、この関数が受け取った `row` そのものである** —— **したがって旧層
 * (`projectForFieldAudience`)が先に落とした項目を条件が指していると、その条件は静かに
 * 偽になり、項目は隠れる側に倒れる。** **穴ではなく安全側だが、正直に書いておく。**
 *
 * @param subject **要求している人の識別子。未ログインは `null`**(「自分」は偽になる)。
 */
export function projectForRoleFields(params: {
  manifest: unknown;
  table: Table | undefined;
  row: Record<string, unknown>;
  roles: ActorRoles;
  subject?: string | null | undefined;
}): Record<string, unknown> {
  const { manifest, table, row, roles } = params;
  if (table === undefined) {
    return { ...row };
  }
  const hidden = new Set(
    table.fields
      .filter(
        (field) =>
          !judgeRoleAccess({
            manifest,
            roles,
            target: { target: "field", table: table.id, field: field.id },
            verb: "read",
            row,
            subject: params.subject ?? null,
          }).allowed,
      )
      .map((field) => field.id),
  );
  if (hidden.size === 0) {
    return { ...row };
  }
  const projected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (hidden.has(key)) {
      continue;
    }
    projected[key] = value;
  }
  return projected;
}

/**
 * **書込1件に、面の項目単位の規則を当てる**(`J-G7`)。
 *
 * **`judgeFieldWrite`(旧層)とまったく同じ問いの形・同じ返り値の型である** ——
 * **呼び出し側が2つを同じ並びで当てられるようにするためであり、旧層を1バイトも消していない。**
 * **見るのは「入力にそのキーが在るか」だけである**(値も現在値も見ない)。
 */
export function judgeRoleFieldWrite(params: {
  manifest: unknown;
  table: Table | undefined;
  values: unknown;
  roles: ActorRoles;
}): RoleFieldWriteVerdict {
  const { manifest, table, values, roles } = params;
  if (table === undefined) {
    return { kind: "allowed" };
  }
  if (typeof values !== "object" || values === null || Array.isArray(values)) {
    return { kind: "allowed" };
  }
  const input = values as Record<string, unknown>;
  const denied: string[] = [];
  for (const field of table.fields) {
    if (!Object.hasOwn(input, field.id)) {
      continue;
    }
    const decision = judgeRoleAccess({
      manifest,
      roles,
      target: { target: "field", table: table.id, field: field.id },
      verb: "write",
    });
    if (!decision.allowed) {
      denied.push(field.id);
    }
  }
  return denied.length > 0 ? { kind: "denied", fields: denied } : { kind: "allowed" };
}

/**
 * **その相手が、その表にその種類の書込をしてよいか**(面のボタンの規則。`J-G9`)。
 *
 * **`isViewActionWriteAllowed`(旧層)と同じ形の壁である** —— **表 `T` を書き先とする
 * 操作起点のうち、面の規則で名指しされているものが1本以上あるとき、`T` への当該種類の書込は
 * 「その相手がどれか1本を `read` できる」ときだけ許す。** **名指しされた起点が1本も無ければ
 * 壁は立たない**(裁定 `R-4`)。
 *
 * **識別子(`view_action.id`)を持たない操作起点は壁の材料にならない** —— **面の規則は
 * `(view, action)` の2つで名指しするので、名前が無ければ名指しできない**(`J-G9`)。
 *
 * **【旧層と同じ限界を引き継ぐ】** **`GET` と `DELETE` には1バイトも掛からない**
 * (書込の種類は `create` / `update` の2つだけである)。
 */
export function isRoleActionWriteAllowed(
  manifest: unknown,
  tableId: string,
  kind: RoleActionWriteKind,
  roles: ActorRoles,
): boolean {
  const views = manifestViews(manifest);
  let walled = false;
  let allowed = false;
  for (const view of views) {
    const viewId = typeof view.id === "string" ? view.id : undefined;
    const actions = Array.isArray(view.actions) ? view.actions : [];
    for (const action of actions) {
      if (typeof action !== "object" || action === null) {
        continue;
      }
      const entry = action as Record<string, unknown>;
      const actionId = typeof entry.id === "string" ? entry.id : undefined;
      if (viewId === undefined || actionId === undefined) {
        continue;
      }
      const target = actionWriteTarget(entry, view, views);
      if (target?.table !== tableId || target.kind !== kind) {
        continue;
      }
      const decision = judgeRoleAccess({
        manifest,
        roles,
        target: { target: "action", view: viewId, action: actionId },
        verb: "read",
      });
      if (!decision.governed) {
        continue;
      }
      walled = true;
      if (decision.allowed) {
        allowed = true;
      }
    }
  }
  return walled ? allowed : true;
}
