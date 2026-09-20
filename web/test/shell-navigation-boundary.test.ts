/**
 * 越えてはならない線の機械検査(V3-M3-T06)。
 *
 * 完了条件の正は `docs/plan/v3/records/v3-m3.md` §2 の「V3-M3-T06」節の5、
 * 判定の正は `docs/adr/0007-vocabulary-governance.md` §8 の 2026-07-26 の5行と
 * 審査記録 `docs/plan/v3/records/v3-m3-gate-a-shell.md` / `-navigation.md`、
 * 改訂の出所は `docs/adr/0053-navigation-visibility-declaration-revision.md`。
 * 書式の先例は `web/test/preset-boundary.test.ts`(V3-M2-T05)。
 *
 * ## この3群が何を守るのか(**V3-M3 が「越えない」と宣言したもの**)
 *
 * | # | 検査 | 守るもの |
 * |---|---|---|
 * | (a) | `schemas/manifest.schema.json` の **`$defs` の名前とプロパティキーの集合** | **案(iii)(`view.roles` をマニフェストに書く)防止。** 採れば Δ3 + Δ5 で門A であり、歯止め1-1 で差し戻しになる(v3-m3.md T04-2) |
 * | (b) | `web/src/views/types.ts` の **`ViewRendererProps` のメンバと export の集合** | **導線・ロールを props で降ろす経路を開かない**(v3-m3.md T02-4。ADR-0049 限定3 / ADR-0052 限定3 の支えでもある) |
 * | (c) | `src/server/owner-scope.ts` が **V3-M3 で1バイトも変わっていないこと** | **V3-M8(D-G13)との共有ファイルの約束**(v3-m3.md §0-3 の2)。読むだけにしたので、共有は「変更の衝突」ではなく「参照」である |
 *
 * ## 拒否リストを作っていない(ADR-0013 限定13)
 *
 * **どの検査も「禁じたい名前の一覧」を持たない。** (a) は「`roles` というキーが無いこと」ではなく
 * **キー集合が既知のものと一致すること**を見る —— **どんな名前で導線用のキーを足しても赤くなる**
 * (`view.roles` でも `view.visible_to` でも `app.siblings` でも同じ)。同じ理由で (b) は
 * **メンバ名の集合の一致**を、(c) は **ファイル内容の同一性**を見る。**「書いてはいけない語」を
 * カーネルにも表示層にも1つも持たせていない。**
 *
 * **なぜ「増えていないこと」を集合の一致で見るのか(理由)**: 件数だけを数えると
 * **「1つ足して1つ消す」が素通りする。** 名前の集合で比べれば、足しても消しても改名しても
 * 赤くなる(**両向き**)。逆に禁止名の一覧で見ると、**一覧に無い名前で同じことをされたら気づかない**
 * —— それが拒否リストの構造的な弱さである。
 *
 * ## 限界(先に書く。憲法6)
 *
 * 1. **(a) は `properties` を持つ `$defs` しか見ない。** `enum` の値域・`pattern`・`allOf` の
 *    条件分岐は見ていない。**既存キーの値域を広げる形(Δ6)はここでは捕まらない。**
 * 2. **(b) はソーステキストの正規表現であって型検査ではない。** `preset-boundary.test.ts` の
 *    限界4 と同じ3経路(型の別名 / スプレッド・交差型 / 新しい props 型を作る)は捕まえられない。
 *    **`ViewRendererProps` という同じ型に1つ足す**という、いちばん起こりやすい経路だけを見る。
 * 3. **(c) は「V3-M3 の時点の内容と同じであること」しか言えない。** **V3-M8(D-G13)は同ファイルを
 *    触る見込みであり、そのとき本検査は赤くなる。それが目的である** —— 黙って変わることを
 *    止め、V3-M3 が入れた前提(判定規則は `nonAdminTableAccess` 1本)を読み直させる。
 *    **赤くなったら、基準を更新する前に v3-m3.md §0-3 と ADR-0053 限定4 を読むこと。**
 * 4. **本ファイルは描画を1つも見ていない。** 「画面が実際に隠れる」ことの実測は
 *    `web/e2e/authz.e2e.ts` / `web/test/role-visibility.test.tsx` にある。
 * 5. **(c) は「M3 が変えていない」ことの証明としては事後的である。** 一次の証明は
 *    `git diff --name-only 3405045..HEAD` に同ファイルが現れないことであり、本検査はそれを
 *    **これから先も**保つための歯止めである。
 */

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const REPO_ROOT = dirname(dirname(import.meta.dir));
const VIEW_TYPES_PATH = join(dirname(import.meta.dir), "src", "views", "types.ts");
const OWNER_SCOPE_PATH = join(REPO_ROOT, "src", "server", "owner-scope.ts");

// ---------------------------------------------------------------------------
// (a) `schemas/manifest.schema.json` に導線用のキーが増えていないこと(案(iii) 防止)
// ---------------------------------------------------------------------------
//
// **V3-M3 の門外4単位は「`schemas/` の差分0」を条件に門外で通っている**(歯止め1-1)。
// 導線・可視性のキーがどこに足されるかは事前に決まっていない —— `$defs/view` の `roles` かも
// しれないし、`$defs/app` の `siblings`(F-11' の格納案)かもしれない。**だから当て先を
// 絞らず、`properties` を持つ `$defs` の全量を凍結する。**

// 【`V5-M29-T02` / `ADR-0250` 限定10 + 限定11】ここにあった test を、ブロックごと消した。
//   消したテスト名(逐語): 「(a) manifest schema の $defs の名前が V3-M3 着手時と一致する(新しい定義を足せない)」
//   そのブロックが測っていたもの:
//     - `expect(Object.keys(schema.$defs).sort()).toEqual([...DEF_NAMES].sort())`
//     - 「最上位は `app` 1つだけである(ここに導線用のキーを足す案も塞ぐ)。」
//       (`expect(Object.keys(schema.properties).sort()).toEqual(["app"])`)
//   移し先は `scripts/vocabulary-drift.test.ts`(名前の一覧は `scripts/vocabulary-snapshot.txt` の
//   `manifest.$defs:` で始まる行 と `manifest.properties:` で始まる行)。
//   **`expect()` が1つも残らないので空の test を残さなかった**(空の test は緑を返し、
//   検出力0のまま `Ran` を水増しする)。
//   **テスト名が持っていた日本語の宣言は、ここでリポジトリから消える**(`ADR-0250` §Decision 5 の (4))。

// 【`V5-M29-T02` / `ADR-0250` 限定10 + 限定11】ここにあった test を、ブロックごと消した。
//   消したテスト名(逐語): 「(a) manifest schema の各 $defs のプロパティキーが V3-M3 着手時と一致する(導線用のキーが増えていない)」
//   そのブロックが測っていたもの:
//     - 「表と実物の**両向き**で突き合わせる —— 表に無い `$defs` が `properties` を持ったら赤、
//       表にある `$defs` が消えても赤になる。」
//       (`expect(withProperties).toEqual(Object.keys(DEF_PROPERTY_KEYS).sort())`)
//     - `properties` を持つ各 `$defs` のキー集合が `DEF_PROPERTY_KEYS` と一致すること
//       (`expect(Object.keys(defs[name].properties).sort(), `$defs/${name}`).toEqual([...keys].sort())`)
//   移し先は `scripts/vocabulary-drift.test.ts`(名前の一覧は `scripts/vocabulary-snapshot.txt` の
//   `manifest.$defs.<定義名>.properties:` で始まる行)。
//   **`expect()` が1つも残らないので空の test を残さなかった。**
//   **テスト名が持っていた日本語の宣言は、ここでリポジトリから消える**(`ADR-0250` §Decision 5 の (4))。

// 【`V5-M29-T02`】上の2本の期待値だった `DEF_NAMES`(28件)と `DEF_PROPERTY_KEYS`(16定義)の
//   リテラルも、ここにあったものを消した。**他から参照されていないことを `grep` で確かめてから消した**
//   (参照は消した2本の中の3箇所と、リテラル自身の doc コメントの中だけであった)。
//   **リテラルに付いていた doc コメント(どのキーが、どの門A の本審査を通って、どの ADR の限定で
//   入ったかの経緯。`write_ops` / `act_as` / `via` を含む全件)は、`scripts/vocabulary-snapshot.txt`
//   の末尾へ `#` コメントとして逐語のまま写した。要約していない。**
//   `MANIFEST_SCHEMA_PATH` / `readJson()` / `type Any` も、この2本だけが使っていたので消した
//   (`biome` の `noUnusedVariables` と `tsc` の `noUnusedLocals` が赤になるため)。
//
//   **【中央が測らない差を1件、実測で見つけた。隠さない】**
//   消した2本は「`properties` を持つ `$defs` の名前の集合」そのものを見ていたので、
//   **`properties` を持たなかった `$defs` に空の `properties: {}` が足されると赤になった。**
//   中央(`scripts/vocabulary-drift.test.ts`)はキーの名前を1行ずつ並べる形なので、
//   **中身が空の `properties: {}` は1行も生まず、この加工では赤にならない**
//   (`V5-M29-T02` が10種の加工で実測。詳細は `docs/plan/v5/records/v5-m29-t02.md` §3)。
//   **足された空の器にキーが1本入った時点では中央が赤になる**(同 §3 の m3)。
//   **逆向きに、消した2本が測っていなかったもの**(`$defs` の並び順・`required` の中身)は
//   中央が測る(同 §3 の m5 / m9)。

// ---------------------------------------------------------------------------
// (b) `web/src/views/types.ts` の props が増えていないこと
// ---------------------------------------------------------------------------
//
// **V3-M3-T02 の完了条件4 が名指しで要求している**(「`web/src/views/types.ts` を触らないことも
// 完了条件に入れる(props を増やさない)」)。**T04 も同じ線を守った** —— ロールは props ではなく
// コンテキスト(`web/src/auth/authz.tsx`)で運ぶ。**ここに1つ足すことは、表示に無関係な関心事を
// ディスパッチ層(`ViewHost` / `ViewBody`)へ漏らす経路を開くことである。**
//
// `preset-boundary.test.ts` の (v) も同じ型を見ているが、**あちらが守るのは「プリセットの
// props を足さない」(ADR-0050 限定10)であり、こちらが守るのは「導線とロールの props を
// 足さない」(V3-M3)である。****守る対象が違うので、片方を消してももう片方は残る。**

/** 行コメントもブロックコメントも落とす(型リテラルの中の記号を数えないため)。 */
function stripAllComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** `{ a: T; b?: U }` の形からプロパティ名を並び順のまま取り出す。 */
function typeLiteralNames(body: string): string[] {
  return [...body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\??\s*:/g)].map((match) => match[1] as string);
}

test("(b) ViewRendererProps のメンバが5つちょうどで、導線・ロールの props が1つも足されていない", () => {
  const source = stripAllComments(readFileSync(VIEW_TYPES_PATH, "utf-8"));
  const match = /export type ViewRendererProps<[^>]*>\s*=\s*\{([^{}]*)\}/.exec(source);
  // 形が変わったら**黙って素通りさせない**(検査を作り直す)。
  expect(match, "ViewRendererProps を読めない").not.toBeNull();
  expect(typeLiteralNames((match as RegExpExecArray)[1] ?? "")).toEqual([
    "appId",
    "manifest",
    "view",
    "recordId",
    "prefill",
  ]);
});

test("(b) web/src/views/types.ts の export の集合が増えていない(別名の props 型を作れない)", () => {
  // **メンバの集合だけを見ると、新しい props 型を隣に作る経路が空く**
  // (`preset-boundary.test.ts` の限界4 (c) と同型)。export の集合も併せて凍結する。
  const source = stripAllComments(readFileSync(VIEW_TYPES_PATH, "utf-8"));
  const exported = [...source.matchAll(/^export type ([A-Za-z_][A-Za-z0-9_]*)/gm)].map(
    (match) => match[1] as string,
  );
  expect(exported.sort()).toEqual(
    [
      "DetailViewRendererProps",
      "FormRendererProps",
      "ListViewRendererProps",
      "ViewRendererProps",
    ].sort(),
  );
});

// ---------------------------------------------------------------------------
// (c) `src/server/owner-scope.ts` が V3-M3 で変更されていないこと
// ---------------------------------------------------------------------------
//
// **`docs/plan/v3/records/v3-m3.md` §0-3 の2 が定めた約束**: 「`src/server/owner-scope.ts` を
// V3-M3 は1バイトも変更しない。D-G12b は同ファイルの `nonAdminTableAccess` を**読むだけ**である。
// **これにより共有は「変更の衝突」ではなく「参照」になり、V3-M8 の完了条件の意味は動かない。**」
//
// **内容の同一性で見る理由**: 「export の集合が同じ」だけでは、**関数の中身を書き換える**経路が
// 空く —— 判定規則そのものが動けば、web 側(`canUseView`)の意味も黙って動く。**約束は
// 「1バイトも変更しない」なので、検査もそのまま「1バイトも変わっていない」を見る。**
// 先例は `scripts/kernel-export-snapshot.txt`(内容を凍結して drift を赤にする)。
//
// **【2026-07-30 / V3-M8-T01 追記】上の V3-M3 の約束は今日も真である** —— 同ファイルを変えたのは
// **V3-M8**(`D-G13` / ADR-0061)であって V3-M3 ではない。**基準は V3-M8-T01 の内容へ更新した**
// (更新前後の値は下の `OWNER_SCOPE_BASELINE` の doc コメント)。**検査は1本も削除しておらず、
// `skip` にもしておらず、条件も緩めていない。**
//
// **【2026-07-30 / V3-M8-T03 追記】基準を再度更新した** —— 同じ V3-M8 の中で2度目である
// (T01 = 運営可視の宣言 / T03 = ADR-0016 §6 の表示名解決。ADR-0061 限定7)。**V3-M3 の約束は
// 今日も破られていない。** **T03 も検査を1本も削除しておらず、`skip` にもしておらず、条件も
// 緩めていない**(見るものは今も「内容の同一性」と「export 集合の一致」の2つ)。
//
// **【2026-07-30 / V3-M8-T03 の差し戻し後 追記】さらにもう一度更新した(通算4版目)** ——
// **メインが実測で退行を見つけて差し戻したためである**(actor 自身の id まで表示名に置き換えて
// いた)。**このときの変更で export 集合は1つも動かず、内容だけが変わった** —— **集合の一致
// だけを見る検査では気づけない変更が実際に起きたということであり、内容の同一性を別に見ている
// 理由がここに出た。**

/**
 * `src/server/owner-scope.ts` の内容の基準。
 *
 * **基準は3度目である。**
 * - 初版 = **V3-M3 着手時(main の `3405045`)**: `sha256 = e1351552…c9a83c` / `bytes = 7637` /
 *   `exports` **12個**。
 * - 2版 = **V3-M8-T01**(ADR-0061 限定3・限定4・限定10 の実装。`st_admin_readable` の規約):
 *   `sha256 = e635f2ac47eb82d97ea3dabfaecac80872f508dbf77c7a443d588009e56e2e94` / `bytes = 10817` /
 *   `exports` **15個**(増えたのは `ADMIN_READABLE_FIELD` / `adminReadableField` /
 *   `adminReadsAllRows` の3つ)。
 * - 3版 = **V3-M8-T03(初版)**(ADR-0016 §6 の表示名解決。ADR-0061 限定7):
 *   `sha256 = 3fed670fb91339c08e00b43afd3c97a6b726dcf80fabb22ae6254ec86f84ea50` / `bytes = 13741` /
 *   `exports` **18個**(15 → 18。増えたのは `UNRESOLVED_OWNER_DISPLAY` / `ownerDisplayName` /
 *   `projectOwnerDisplay` の3つ)。
 * - 4版 = **V3-M8-T03(メインの差し戻し後)** = 下の値。**`exports` は 18 のまま1つも動いて
 *   いない**(増減も改名も0)—— 変わったのは `projectOwnerDisplay` の**引数と中身**で、
 *   **actor 自身の id を置き換えないようにした**(差し戻しの理由は同関数の doc)。
 *   **「export 集合だけを見ていたら気づけない変更」が実際に起きた例である** —— 内容の同一性
 *   (sha256 / bytes)を別に見ている理由がここに出た。
 * - 5版 = **V3-M13-T10**(`ADR-0067` 限定 A5 の安全装置。島が返した op への所有者スコープ)=
 *   下の値。`exports` **18 → 20**(増えたのは `OwnerScopedOpVerdict` / `judgeOwnerScopedOp`
 *   の2つ)。**触ったのは V3-M8 ではなく V3-M13 である** —— V3-M3 の約束(§0-3 の2)は
 *   「V3-M3 が変えない」であって、以後どのマイルストーンも変えないという約束ではない。
 *   **変更の中身**: `app.ts` のバッチハンドラに書かれていた「述語を当てる順序」(create は
 *   必ず上書き / 可視性を先に見る / 付け替えと私物化を止める)を、**判定として
 *   `judgeOwnerScopedOp` 1本へ引き上げた**。`src/kernel/workflow-runner.ts` が島の op に
 *   同じ1本を当てる(限定 A5 の「判定を2箇所に書かない」)。**既存の述語5本
 *   (`personalOwnerField` / `isOwnerVisible` / `isAllowedOwnerUpdate` / `isSharedOwner` /
 *   `nonAdminTableAccess`)の中身は1バイトも変えていない。**
 *
 * - 6版 = **V4-M6(`E-G54`)** = 下の値。`exports` **20 → 22**(増えたのは
 *   `READ_HIDDEN_RESERVED_FIELDS` / `projectForRead` の2つ)。**触ったのは V3-M3 でも V3-M8 でも
 *   なく v4 である。** **変更の中身**: **「書けるが効かない値」(`st_admin_readable` の行の値)を
 *   読取応答から伏せる射影を1本足した。** **`ADR-0061` の限定表は1つも解除していない** ——
 *   とくに**限定3(行の値は判定に使わない)には1バイトも触っていない**(伏せることは値を判定に
 *   使うことではない)。**既存の述語・射影(`personalOwnerField` / `isOwnerVisible` /
 *   `isAllowedOwnerUpdate` / `isSharedOwner` / `nonAdminTableAccess` / `projectForAnonymous` /
 *   `projectOwnerDisplay` / `judgeOwnerScopedOp`)の中身は1バイトも変えていない。**
 *   **`ANON_RESERVED_FIELDS`(限定10)も1バイトも変えていない。**
 *
 * - 7版 = **V4-M3-T02(`B-G1` / ADR-0070 限定3)** = 下の値。`exports` **22 → 24**(増えたのは
 *   `viewAudience` / `isViewAudienceAllowed` の2つ)。**変更の中身**: **画面ごとの「見せる相手」
 *   (`$defs/view.audience`)を読む述語を2本足した。** **`ADR-0070` 限定3 の逐語「`src/server/
 *   app.ts:1059` の `recordsAuthMiddleware`(または `owner-scope.ts` の述語)が同じ宣言を読む」
 *   が、この置き場を名指ししている** —— `app.ts` に条件式を書かない(`ADR-0061` 限定4 と同じ作法)。
 *   **既存の述語・射影は1バイトも変えていない**(`personalOwnerField` / `isOwnerVisible` /
 *   `isAllowedOwnerUpdate` / `isSharedOwner` / `nonAdminTableAccess` / `projectForAnonymous` /
 *   `projectOwnerDisplay` / `judgeOwnerScopedOp` / `projectForRead`)。
 *   **`ANON_RESERVED_FIELDS` / `READ_HIDDEN_RESERVED_FIELDS` も1バイトも変えていない。**
 *   **予約規約フィールドは 3本のまま**(`ADR-0070` 限定6)。
 *
 * - 8版 = **V4-M3-T05 / T06(`B-G2` / ADR-0071 限定5)** = 下の値。`exports` **24 → 26**
 *   (増えたのは `fieldAudience` / `projectForFieldAudience` の2つ)。**変更の中身**:
 *   **項目ごとの「見せる相手」(`$defs/field.audience`)を読取応答から落とす射影を1本足した。**
 *   **`ADR-0071` 限定5 の逐語「落とすのは `src/server/owner-scope.ts` の射影
 *   (`ANON_RESERVED_FIELDS` 周辺)と `src/server/app.ts` の読取経路である」がこの置き場を
 *   名指ししている。** **`ANON_RESERVED_FIELDS` / `READ_HIDDEN_RESERVED_FIELDS` は1バイトも
 *   変えていない**(`ADR-0071` 限定2: 予約規約フィールドは3本のまま)。
 *   **既存の述語・射影の中身も1バイトも変えていない** —— 変わったのは
 *   `ANON_RESERVED_FIELDS` の doc コメントで、**`ADR-0034` §3a の再審査が実際に行われた
 *   ことを追記した**(`ADR-0071` §Consequences が名指しで求めた是正)。
 *
 * - 9版 = **V4-M4(`B-G8` / `ADR-0073`)** = 下の値。`exports` **26 → 28**(増えたのは
 *   `UNDELETABLE_FIELD` / `undeletableField` / `isDeleteProtectedRow` の3つ)。**変更の中身**:
 *   **予約規約フィールドの4本目(`st_undeletable`)と、その行の状態で `DELETE` だけを止める
 *   純粋判定を1本足した。** 根拠は `docs/adr/0073-row-state-delete-protection.md`(門A本審査 =
 *   限定採用。`ADR-0061` 限定9 が要求した「門A の新規審査 + 同格の個別 ADR」を満たしている)。
 *   **`ANON_RESERVED_FIELDS` は 3 → 4 本になった**(`ADR-0073` 限定7。**これは5版・6版と違い
 *   「1バイトも変えていない」と書けない**)。**既存の述語・射影の中身は1バイトも変えていない。**
 *   **`schemas/` と `src/kernel/` には1バイトも差分を出していない**(限定1)。
 *
 * - 10版 = **V4-M2-T05 / T06(`B-G5` / ADR-0074 限定1・限定5・限定7)** = 下の値。
 *   **下の期待配列の実測は 29 → 33。増えたのはちょうど4名である** ——
 *   **`ANONYMOUS_AUDIENCE` / `ViewAudienceValue` / `isViewAnonymousVisible` /
 *   `viewAudienceDeclaration`。** **4本目が要る理由は `owner-scope.ts` の
 *   `viewAudience` の doc にある** —— **`src/server/app.ts` を1バイトも変えない**という
 *   `ADR-0074` 限定9 / 限定10 を守るため、**ロールだけを返す読み手**(`viewAudience`)と
 *   **宣言をそのまま返す読み手**(`viewAudienceDeclaration`)を分けた。
 *   **減った名前・改名した名前は0件である。**
 *   **【数を丸めない】9版の説明文は「`exports` 26 → 28」と書いているが、**
 *   **9版の期待配列の実測の長さは 29 だった**(2026-08-03 実測)。**説明文の数字と
 *   配列の長さは着手前から一致していない。****ここでは配列の実測を正とする。**
 *   **9版以前の説明文の数字は1つも書き換えていない**(判定時点の記述である。
 *   `ADR-0007` §6 規律1)。
 *   **`viewAudience` の返り型が `readonly Role[]` から `readonly ViewAudienceValue[]` に
 *   変わった**分は、名前の集合には現れない(内容の同一性の側が捕まえている)。
 *   **変更の中身**: **`view.audience` の値域に `anonymous` を1値足し**(限定1)、
 *   **「未ログインの画面一覧に並べてよいか」を答える述語を1本足した**(限定5・限定7)。
 *   **`isViewAudienceAllowed` には未認証の枝を1本足した**(宣言に `anonymous` があれば
 *   通す)——**宣言の無いビューの答えと、ログイン済み4ロールの答えは1つも変えていない。**
 *   **`fieldAudience` の値域は4ロールのままである**(`ADR-0074` §3a-4 = 項目単位へ匿名を
 *   1ミリも広げない。`AUDIENCE_ROLES` と `VIEW_AUDIENCE_VALUES` を別に持つ理由がこれである)。
 *   **既存の述語・射影の中身は1バイトも変えていない**(`personalOwnerField` /
 *   `isOwnerVisible` / `isAllowedOwnerUpdate` / `isSharedOwner` / `nonAdminTableAccess` /
 *   `projectForAnonymous` / `projectOwnerDisplay` / `judgeOwnerScopedOp` / `projectForRead` /
 *   `projectForFieldAudience` / `isDeleteProtectedRow`)。
 *   **`ANON_RESERVED_FIELDS` / `READ_HIDDEN_RESERVED_FIELDS` も1バイトも変えていない。**
 *   **予約規約フィールドは4本のまま**(`ADR-0074` 限定3。**`B-G5` は1本も足していない**)。
 *   **`src/kernel/` には1バイトも差分を出していない**(限定11)。
 *
 * **更新は検査の緩和ではない** —— 検査は1本も消えておらず、条件も緩んでいない(見るものは今も
 * 「内容の同一性」と「export 集合の一致」の2つである)。**手続きは ADR-0053 限定4 が定めたもの
 * に従った**(「V3-M8 が触るときは、基準を更新する前に `docs/plan/v3/records/v3-m3.md` §0-3 と
 * 本限定を読むこと」)—— **T01 / T03 / V3-M13-T10 / V4-M6 に続き V4-M3-T02 も、更新の前に両方を
 * 読んでいる**(`v3-m3.md` §0-3 の2 と `ADR-0053` 限定4 の逐語を 2026-08-03 に実読した)。
 * **次に触る者も同じ手続きを踏むこと。**
 */
/*
 * **【6度目の更新。V4-M10-T02 / `E-G48` / ADR-0076】**
 *
 * **変更の中身**: **項目単位の書込制御(`writable_by`)の述語と判定を1本ずつ足した**
 * (`fieldWriters` / `judgeFieldWrite` / 型 `FieldWriteVerdict`)。**判定は本ファイルに
 * 集約する**(`ADR-0076` 限定6。`app.ts` に条件式を書かない)。
 * **既存の述語・射影の中身は1バイトも変えていない**(`personalOwnerField` /
 * `isOwnerVisible` / `isAllowedOwnerUpdate` / `isSharedOwner` / `nonAdminTableAccess` /
 * `projectForAnonymous` / `projectOwnerDisplay` / `judgeOwnerScopedOp` / `projectForRead` /
 * `projectForFieldAudience` / `isDeleteProtectedRow` / `fieldAudience` /
 * `isViewAudienceAllowed` / `isViewAnonymousVisible`)—— **`ADR-0076` 限定3 が
 * 「`ADR-0071` 限定4 を1バイトも破らない」と定めているためである。**
 * **`ANON_RESERVED_FIELDS` / `READ_HIDDEN_RESERVED_FIELDS` も1バイトも変えていない。**
 * **予約規約フィールドは4本のまま**(`ADR-0076` 限定8。**単位1 は1本も足していない**)。
 * **`src/kernel/` には1バイトも差分を出していない**(限定7)。
 *
 * **手続き**: `docs/plan/v3/records/v3-m3.md` §0-3 と `ADR-0053` 限定4 の逐語を
 * 2026-08-03 に実読してから更新した(`ADR-0053` 限定4 が定めた手続き)。
 *
 * **【7度目の更新。V4-M10-T04 / `E-G49` / ADR-0077】**
 *
 * **変更の中身**: **予約規約フィールドの5本目(`st_no_direct_create`)と、その述語・判定を
 * 1本ずつ足した**(`noDirectCreateField` / `isDirectCreateSuppressed`)。
 * **`ANON_RESERVED_FIELDS` に1本足した**(限定7)。**それ以外の述語・射影の中身は
 * 1バイトも変えていない。** **`schemas/` と `src/kernel/` に1バイトも差分を出していない**
 * (限定1)。**手続きは6度目と同じものを踏んだ。**
 *
 * **【8度目の更新。V4-M27 / ユーザ決定 `D-V4-92` + `D-V4-114`】**
 *
 * **変更の中身**: **外部から届いた入力(受信 payload)から `st_public` を無条件に取り除く
 * 関数を1本足した**(`stripInboundPublicFlag`)。**置き場が本ファイルなのは `ADR-0061`
 * 限定4(判定は `owner-scope.ts` に集約 / 呼び出し側に条件式を書かない)による** ——
 * `src/server/inbound-route.ts` はこの関数を呼ぶだけで、`st_public` の綴りを1文字も持たない。
 * **`exports` は 39 → 40(増えたのは `stripInboundPublicFlag` の1名。減った名前・
 * 改名した名前は0件)。** **【数を丸めない】この 39 / 40 は
 * `grep -cE '^export (const|function|type) ' src/server/owner-scope.ts` の実測であり、
 * 更新前後の期待配列の長さ(39 / 40)とも一致している**(10版の注が記録した
 * 「説明文の数字と配列の長さが一致していない」状態は、本更新では起きていない)。
 * **既存の述語・射影の中身は1バイトも変えていない**(`personalOwnerField` /
 * `isOwnerVisible` / `isAllowedOwnerUpdate` / `isSharedOwner` / `nonAdminTableAccess` /
 * `projectForAnonymous` / `projectOwnerDisplay` / `judgeOwnerScopedOp` / `projectForRead` /
 * `projectForFieldAudience` / `isDeleteProtectedRow` / `isDirectCreateSuppressed` /
 * `publicField` / `isPublicRow`)。
 * **`ANON_RESERVED_FIELDS` / `READ_HIDDEN_RESERVED_FIELDS` も1バイトも変えていない。**
 * **予約規約フィールドは5本のまま**(1本も足していない。`st_public` は `ADR-0034` から在る)。
 * **`schemas/` と `src/kernel/` に1バイトも差分を出していない。**
 * **手続きは6度目・7度目と同じものを踏んだ**(`docs/plan/v3/records/v3-m3.md` §0-3 と
 * `ADR-0053` 限定4 の逐語を 2026-08-04 に実読してから更新した)。
 *
 * **【9度目の更新。V4-M36 / ユーザ決定 `D-V4-125`】**
 *
 * **変更の中身**: **8度目が `st_public` 1本について作った経路を、残る3本の予約規約
 * フィールドへ広げた** —— 落とす対象の全量を持つ定数(`INBOUND_STRIPPED_RESERVED_FIELDS`)と、
 * それを受信 payload から破壊的に取り除く関数(`stripInboundReservedFields`)の**2名を
 * 足した。** **置き場が本ファイルなのは `ADR-0061` 限定4 / `ADR-0073` 限定5 /
 * `ADR-0077` 限定6(判定は `owner-scope.ts` に集約 / 呼び出し側に条件式を書かない)による**
 * —— `src/server/inbound-route.ts` はこの関数を呼ぶだけで、**4本の綴りを1文字も持たない。**
 * **`exports` は 40 → 42(増えたのは上の2名。減った名前・改名した名前は0件)。**
 * **`stripInboundPublicFlag` は残してある** —— 消すと既存の検査4本が消えるためであり、
 * **今日この名前を呼ぶ製品コードは無い**(呼び出しは新しい関数へ移った)。
 * **【数を丸めない】この 40 / 42 は
 * `grep -cE '^export (const|function|type) ' src/server/owner-scope.ts` の実測であり、
 * 更新前後の期待配列の長さ(40 / 42)とも一致している。**
 * **既存の述語・射影の中身は1バイトも変えていない**(8度目の注が列挙した14本に加え、
 * `isDeleteProtectedRow` / `adminReadableField` / `noDirectCreateField` も1バイトも
 * 変えていない —— **落とすのは受信 payload であって、判定側ではない**)。
 * **`ANON_RESERVED_FIELDS` / `READ_HIDDEN_RESERVED_FIELDS` も1バイトも変えていない。**
 * **予約規約フィールドは5本のまま**(1本も足していない。`export const *_FIELD = "st_..."`
 * の本数を見る `src/server/owner-scope.test.ts` の検査が緑のままである)。
 * **`schemas/` と `src/kernel/` に1バイトも差分を出していない。**
 * **手続きは6度目〜8度目と同じものを踏んだ**(`docs/plan/v3/records/v3-m3.md` §0-3 と
 * `ADR-0053` 限定4 の逐語を 2026-08-04 に実読し、**更新前に実際に赤を見てから**更新した)。
 *
 * **【10度目の更新。V4-M35 / ユーザ決定 `D-V4-124`】**
 *
 * **変更の中身**: **`ValidationError` の `allowed_values` から、`audience` を宣言した項目の
 * IDを落とす純粋関数を1本足した**(`scrubHiddenFieldIds`)。**置き場が本ファイルなのは
 * `ADR-0061` 限定4 / `ADR-0071` 限定5 / `ADR-0077` 限定6(判定は `owner-scope.ts` に集約 /
 * 呼び出し側に条件式を書かない)による** —— `src/server/app.ts` はこの関数を呼ぶだけで、
 * **`audience` の読み方を1文字も持たない。**
 * **`exports` は 42 → 43(増えたのは `scrubHiddenFieldIds` の1名。減った名前・改名した
 * 名前は0件)。** **【数を丸めない】この 42 / 43 は
 * `grep -cE '^export (const|function|type) ' src/server/owner-scope.ts` の実測であり、
 * 更新前後の期待配列の長さ(42 / 43)とも一致している。**
 * **既存の述語・射影の中身は1バイトも変えていない**(8度目・9度目の注が列挙した全部に加え、
 * **`projectForFieldAudience` も1バイトも変えていない** —— **`V4-M35` の (b)(書込の応答に
 * 射影を掛ける)は、既存のこの1本を `src/server/app.ts` の書込経路から**呼ぶ**ことで
 * 実装しており、射影そのものを書き換えていない**)。
 * **`ANON_RESERVED_FIELDS` / `READ_HIDDEN_RESERVED_FIELDS` も1バイトも変えていない。**
 * **予約規約フィールドは5本のまま**(1本も足していない)。
 * **`schemas/` と `src/kernel/` に1バイトも差分を出していない。**
 * **型 import を1つ増やした**(`ValidationError`)—— **値 import ではないので
 * `scripts/kernel-import-drift.test.ts` の対象外であり、製品コードの層またぎは
 * 着手前と1件も違わない。**
 * **手続きは6度目〜9度目と同じものを踏んだ**(`docs/plan/v3/records/v3-m3.md` §0-3 と
 * `ADR-0053` 限定4 の逐語を 2026-08-04 に実読し、**更新前に実際に赤を見てから**更新した)。
 *
 * **【11度目の更新。V4-M41a / ユーザ決定 `D-V4-129` の (b)】**
 *
 * **変更の中身**: **コメントだけである。実行されるコードを1バイトも変えていない。**
 * **`ADR-0071` 限定4 を写した3行**(「書込 … 検索(`filter`)・並べ替え(`sort`)の振る舞いを
 * 1バイトも変えない」/「「客に見せない項目で絞り込む」ことは今日どおりできる」)**と、
 * 「書込の応答には掛けていない」の1行が、今日の実物と食い違っていた** ——
 * **旧文を1バイトも消さずに追記節を足した**(`ADR-0007` §6 規律1 の作法。`ADR-0087` に
 * `V4-M29` が、`ADR-0055` に `V4-M39` が採ったのと同じ形)。
 * **食い違いの出所は2本の門A である** —— **`ADR-0120`**(`audience` を宣言した項目を
 * `filter` / `sort` に書いた読取要求を 400 にする。実装 `V4-M28-T01`)と
 * **`ADR-0134`**(作成・更新・まとめ書きの成功応答にも同じ射影を掛ける。実装 `V4-M35`)。
 * **どちらも限定4 を審査で改訂したものであり、無断で破ったのではない。**
 * **`records/v4-m28.md` §9 の 3 が「今日も偽のままである」と申告して触れなかった箇所であり、
 * `D-V4-129` がその授権を与えた。**
 * **`exports` は 43 → 43(増減も改名も0件)。** **【数を丸めない】この 43 は
 * `grep -cE '^export (const|function|type) ' src/server/owner-scope.ts` の実測であり、
 * 下の期待配列の長さ(43)とも一致している。****期待配列は1行も書き換えていない。**
 * **述語・射影・定数の中身は1バイトも変えていない**(8度目〜10度目の注が列挙した全部)。
 * **`ANON_RESERVED_FIELDS` / `READ_HIDDEN_RESERVED_FIELDS` /
 * `INBOUND_STRIPPED_RESERVED_FIELDS` も1バイトも変えていない。**
 * **予約規約フィールドは5本のまま**(1本も足していない)。
 * **`schemas/` と `src/kernel/` に1バイトも差分を出していない。**
 * **import を1つも増やしていない**(値も型も)。
 * **手続きは6度目〜10度目と同じものを踏んだ**(`docs/plan/v3/records/v3-m3.md` §0-3 の2 逐語
 * 「**`src/server/owner-scope.ts` を V3-M3 は1バイトも変更しない。**」と `ADR-0053` 限定4 逐語
 * 「**V3-M8 が触るときは、基準を更新する前に §0-3 と本限定を読むこと**」を 2026-08-04 に
 * 実読し、**更新前に実際に赤を見てから**更新した。**赤は「1バイトも変わっていない」の側
 * 1本だけで、export 集合の側は緑のままだった** —— **コメントだけを変えたことの実測である。**
 * **10版の注が書いた「集合だけを見ていたら気づけない変更」の逆の形であり、内容の同一性を
 * 別に見ている理由がここにも出た**)。
 *
 * ## 次の更新(`V5-M14` / `G-G17`。2026-08-05)—— **旧文を1バイトも消していない**
 *
 * **変えたのはコメント2行の例示だけである**(`docs/plan/v5/records/v5-m14.md` §4-3)。
 * `:566` の逐語「顧客スコープテーブル(cart/order 等)」→「顧客スコープテーブル(本人ごとに
 * 行が分かれる表)」、`:569` の逐語「運営テーブル(product 管理・全注文一覧)」→
 * 「運営テーブル(運営だけが管理する表・全員分の一覧)」。
 * **判定関数 `nonAdminTableAccess` を1バイトも変えていない**(`V5-M12` の歯止め2 が
 * 名指しした関数である)。
 * **`sha256` / `bytes` は `e39162ec…`(66938 バイト)→ `b744608a…`(66979 バイト)。**
 * **`exports` は 43 → 43(増減も改名も0件)。****期待配列は1行も書き換えていない。**
 * **`schemas/` と `src/kernel/` に本ファイル経由の差分は1バイトも出していない。**
 * **手続きは前回までと同じものを踏んだ** —— `docs/plan/v3/records/v3-m3.md` §0-3 の2 と
 * `ADR-0053` 限定4(`docs/adr/0053-navigation-visibility-declaration-revision.md:159`)を
 * 2026-08-05 に実読し、**更新前に実際に赤を見てから**更新した。
 * **赤は「1バイトも変わっていない」の側1本だけで、export 集合の側は緑のままだった** ——
 * **コメントだけを変えたことの実測である**(前版と同じ形)。
 * **`:612` の別の EC 前提の記述(「この注文は運営可視 false だから隠せる」)には1バイトも
 * 触っていない** —— 04 §5-2 の 7 が「`G-G17` の根拠としては使っていない」と決めているためである。
 *
 * ## 次の更新(`V5-M17` / `G-G5`〜`G-G8`。2026-08-05)—— **旧文を1バイトも消していない**
 *
 * **今回は「コメントだけ」ではない。** **判定関数の名前が変わり、公開名が3つ増えた。**
 *
 * **変えたもの**(記録は `docs/plan/v5/records/v5-m17.md`):
 * 1. **`CustomerTableAccess` / `customerTableAccess` → `NonAdminTableAccess` /
 *    `nonAdminTableAccess`**(`G-G7`。**名前だけで、判定の中身は1バイトも変えていない**)。
 * 2. **公開名が3つ増えた**: `UserKind` / `declaredUserKinds` / `effectiveUserKindIds`
 *    (`ADR-0158`。**アプリが宣言した利用者の種類を読む述語を1箇所に閉じるため**)。
 * 3. **`viewAudienceDeclaration` / `fieldAudience` が値域で絞り込むのをやめた**
 *    (`ADR-0159` 限定2。**宣言された種類を述語が黙って落とさないため**)。
 * 4. **非運営の判定を `isReservedRole` の否定に置き換えた**(`ADR-0158` 限定2)。
 *
 * **`sha256` / `bytes` は `b744608a…`(66979 バイト)→ `c85fb601…`(73563 バイト)。**
 * **`exports` は 43 → 46**(**増えたのは上の3名。改名は `CustomerTableAccess` →
 * `NonAdminTableAccess` の1件で、これは差し引き0である**)。
 * **`schemas/` に本ファイル経由の差分は出していない**(スキーマは別タスクが直接触った)。
 * **`src/kernel/` には1バイトも差分を出していない。**
 * **手続きは前回までと同じものを踏んだ** —— `docs/plan/v3/records/v3-m3.md` §0-3 の2 と
 * `ADR-0053` 限定4 を 2026-08-05 に実読し、**更新前に実際に赤を見てから**更新した。
 * **今回は「1バイトも変わっていない」の側と export 集合の側の**両方**が赤くなった** ——
 * **コメントだけではなく公開名が動いたことの実測である**(前2版との違い)。
 *
 * ## 次の更新(`V7-M1-T04` / `Z-G2`〜`Z-G7`。2026-08-08)—— **旧文を1バイトも消していない**
 *
 * **変更の中身**: **アクセス権管理の宣言(`$defs/table.access_control`)を読んで
 * 「この表は付与表である / メンバー表である / グループ表である」を返す純粋述語を足した。**
 * **置き場所がここである根拠は `ADR-0061` 限定4**(逐語「**判定は
 * `src/server/owner-scope.ts` に集約する** | 新しい述語を同ファイルに置き、`app.ts` に
 * 条件式を書かない」)**と `docs/plan/v7/records/v7-m0.md` §5-2 (b)** である。
 *
 * **`sha256` / `bytes` は `ee2b1286…`(80587 バイト)→ `eea445db…`(87967 バイト)。**
 * **`exports` は 48 → 56**(**増えたのは下の8名。減った名前・改名した名前は0件**)。
 * **【数を丸めない】この 48 / 56 は
 * `grep -cE '^export (const|function|type) ' src/server/owner-scope.ts` の実測である。**
 *
 * **【この更新がしていないこと。先に書く(憲法6)】**
 *  - **判定(誰に何が見えるか・書けるか)を1バイトも実装していない** —— **`V7-M3` の担当。**
 *    **足したのは「規約として認識する」述語だけである。**
 *  - **既存の述語・射影・定数の中身は1バイトも変えていない**(10版以降の注が列挙した全部。
 *    とくに `nonAdminTableAccess` / `judgeOwnerScopedOp` / `adminReadsAllRows`)。
 *  - **`ANON_RESERVED_FIELDS` / `READ_HIDDEN_RESERVED_FIELDS` /
 *    `INBOUND_STRIPPED_RESERVED_FIELDS` も1バイトも変えていない。**
 *  - **予約規約フィールドは5本のまま**(`v7-m0.md` §5-3 逐語「**v7 が足す本数 = 0本**」)。
 *    **付与表・メンバー表・グループ表の列は `st_*` の綴りではなく宣言で指すためである。**
 *  - **`src/kernel/` に本ファイル経由の差分は1バイトも出していない**(型 `Manifest` を
 *    **型としてだけ** import する1行が増えた。値の import は今日も0件である)。
 *
 * **手続きは前回までと同じものを踏んだ** —— `docs/plan/v3/records/v3-m3.md` §0-3 の2 と
 * `ADR-0053` 限定4 を 2026-08-08 に実読し、**更新前に実際に赤を見てから**更新した。
 * **今回も両方が赤くなった**(公開名が8つ動いたため)。
 *
 * ## 次の更新(`V7-M2-T02` / `Z-G11`。2026-08-08)—— **旧文を1バイトも消していない**
 *
 * **変更の中身**: **行1件について「読める / 書ける / 消せる」を返す判定
 * (`judgeRecordAccess`)と、その判定に要る行をどの表から読むかを返す述語
 * (`recordAccessSourceTables`)を足した。** **前版(`V7-M1-T04`)が「置いただけ」だった
 * 述語群の上に、**今回はじめて判定そのものが入った**。**
 *
 * **`judgeOwnerScopedOp` の中には1バイトも入れていない** —— **入れると
 * `src/kernel/workflow-runner.ts` と `src/server/inbound-route.ts` が判定を受けてしまい、
 * `Z-G22` / `Z-G23`(今日どおり素通りする)と正面から食い違う**(`v7-m0.md` §5-2 (b))。
 * **`judgeOwnerScopedOp` / `nonAdminTableAccess` / `adminReadsAllRows` / `judgeFieldWrite` /
 * 既存の射影は1バイトも変えていない。**
 *
 * **`sha256` / `bytes` は `eea445db…`(87967 バイト)→ `38a48720…`(98327 バイト)。**
 * **`exports` は 56 → 60**(**増えたのは下の4名。減った名前・改名した名前は0件**)。
 * **【数を丸めない】この 56 / 60 は
 * `grep -cE '^export (const|function|type) ' src/server/owner-scope.ts` の実測である。**
 *
 * **【この更新がしていないこと。先に書く(憲法6)】**
 *  - **配線したのは 一覧 `GET` / 単件 `GET` / `PATCH` の3経路だけである。**
 *    **`POST` / `DELETE` / 画面の操作起点 / バッチ / ファイル配信の5経路には、判定が
 *    1バイトも掛かっていない**(`V7-M3-T02` / `V7-M3-T06` / `V7-M3-T07` の担当)。
 *  - **グループ経由の相手解決(`V7-M3-T01`)と引き継ぎ(`V7-M4`)を1バイトも実装していない。**
 *  - **予約規約フィールドは5本のまま**(v7 が足した本数 = 0本)。
 *  - **`src/kernel/` に本ファイル経由の差分は1バイトも出していない。**
 *
 * **手続きは前回までと同じものを踏んだ** —— `docs/plan/v3/records/v3-m3.md` §0-3 の2 と
 * `ADR-0053` 限定4 を 2026-08-08 に実読し、**更新前に実際に赤を見てから**更新した。
 * **今回も両方が赤くなった**(公開名が4つ増えたため)。
 *
 * ## 次の更新(`V7-M2-T03` / `Z-G13`。2026-08-08)—— **旧文を1バイトも消していない**
 *
 * **変更の中身**: **既存の述語2本の中身を変えた。公開名は1つも増えていない。**
 *
 *  1. **`nonAdminTableAccess`** —— **アクセス権管理を有効にした表(`access_control.enabled`)を
 *     `"scoped"` に倒す分岐を1つ足した。** **`NonAdminTableAccess` は `"scoped" | "public" |
 *     "denied"` の3値のままであり、4つ目の値を足していない**(`v7-m0.md` §5-4 の (ii) /
 *     `Z-G13` 限定3)。**`"denied"` に黙って落としていない。**
 *  2. **`adminReadsAllRows`** —— **アクセス権管理を有効にした表では `false` に倒す**
 *     (`D-V7-22` / `Z-G13` 限定1)。**宣言した表では運営3ロールも付与を迂回しない。**
 *
 * **`st_admin_readable` の宣言粒度は1ミリも動かしていない**(`ADR-0061` 限定3)——
 * **`adminReadableField` / `adminReadsAllRows` の引数は今日も (表) / (表, ロール) であり、
 * 行の値を1つも読まない。** **`ADMIN_READABLE_FIELD` の綴りは今日も本ファイルの外の
 * 製品コードに1件も現れない。**
 *
 * **`sha256` / `bytes` は `38a48720…`(98327 バイト)→ `ac5190b8…`(101469 バイト)。**
 * **`exports` は 60 のまま動いていない**(**増えた名前・減った名前・改名した名前は0件**)。
 * **【数を丸めない】この 60 は
 * `grep -cE '^export (const|function|type) ' src/server/owner-scope.ts` の実測である。**
 * **したがって今回赤くなったのは `sha256` と `bytes` の2本だけで、`exports` の集合は
 * 最初から緑だった。**
 *
 * **【この更新がしていないこと。先に書く(憲法6)】**
 *  - **`judgeRecordAccess` / `judgeOwnerScopedOp` / `judgeFieldWrite` /
 *    `projectForFieldAudience` / 既存の射影を1バイトも変えていない。**
 *  - **`POST` / `DELETE` / 画面の操作起点 / バッチ / ファイル配信の5経路には、今日も判定が
 *    1バイトも掛かっていない**(`V7-M3` の担当)。**`nonAdminTableAccess` が `"scoped"` を
 *    返すようになった結果、宣言された利用者の種類の `POST` / `DELETE` が中継層の 403 で
 *    止まらなくなった** —— **これは開いた側の変化であり、記録に限界として書いてある。**
 *  - **予約規約フィールドは5本のまま**(v7 が足した本数 = 0本)。
 *  - **`src/kernel/` に本ファイル経由の差分は1バイトも出していない。**
 *
 * **手続きは前回までと同じものを踏んだ** —— `docs/plan/v3/records/v3-m3.md` §0-3 の2 と
 * `ADR-0053` 限定4 を 2026-08-08 に実読し、**更新前に実際に赤を見てから**更新した。
 *
 * ## 次の更新(`V7-M3-T01` / `Z-G1`。2026-08-08)—— **旧文を1バイトも消していない**
 *
 * **変更の中身**: **`judgeRecordAccess` の中に**グループ経由の相手解決**を足した。**
 * **公開名は1つも増えていない**(`export` は 60 のまま)。**署名も変えていない** ——
 * **引数キーは今日も `manifest` / `tableId` / `row` / `actorId` / `grantRows` /
 * `memberRows` の6本ちょうどである。**
 *
 * **辿る道は固定3段である**: **付与行 → `grant.group` → グループ → `members.group` が
 * 同じグループを指すメンバー行 → `members.account` → actor。** **再帰は1行も無い。**
 * **グループの中にグループは入らない**(`Z-G8`。適用時検査がグループ表の自己参照を拒否する)。
 * **複数の付与は `read` / `write` / `delete` のそれぞれについて OR で合成する**
 * (**この裁定は `V7-M3-T01` が下した。理由は「グループに入れたら権限が減った」を作らない
 * ためである**)。
 *
 * **`sha256` / `bytes` は `ac5190b8…`(101469 バイト)→ `1a324844…`(104245 バイト)。**
 * **`exports` は 60 のまま動いていない**(**増えた名前・減った名前・改名した名前は0件**)。
 * **【数を丸めない】この 60 は
 * `grep -cE '^export (const|function|type) ' src/server/owner-scope.ts` の実測である。**
 * **したがって今回赤くなったのは `sha256` と `bytes` の2本だけで、`exports` の集合は
 * 最初から緑だった。**
 *
 * **【この更新がしていないこと。先に書く(憲法6)】**
 *  - **`judgeOwnerScopedOp` / `nonAdminTableAccess` / `adminReadsAllRows` / `judgeFieldWrite` /
 *    `projectForFieldAudience` / 既存の射影を1バイトも変えていない。**
 *  - **`src/server/app.ts` を1バイトも変えていない**(グループ経由の解決は、既に読んでいる
 *    付与行とメンバー行だけで解ける。**新しく読む表は0本である**)。
 *  - **引き継ぎ(`inherit_from` の多段)を1バイトも実装していない** —— **`V7-M4`。**
 *  - **`POST` / `DELETE` / 画面の操作起点 / バッチ / ファイル配信の5経路には、今日も判定が
 *    1バイトも掛かっていない**(`V7-M3-T02` / `V7-M3-T06` / `V7-M3-T07`)。
 *  - **グループ表の行を1行も読まない** —— **消えたグループ行を指す付与は、メンバー行が同じ
 *    id を指したままなら今日も効く**(`V7-M3-T05` の担当)。
 *  - **予約規約フィールドは5本のまま**(v7 が足した本数 = 0本)。
 *  - **`src/kernel/` に本ファイル経由の差分は1バイトも出していない。**
 *
 * **手続きは前回までと同じものを踏んだ** —— `docs/plan/v3/records/v3-m3.md` §0-3 の2 と
 * `ADR-0053` 限定4 を 2026-08-08 に実読し、**更新前に実際に赤を見てから**更新した。
 *
 * ## 次の更新(`V7-M3-T02`。2026-08-08)—— **旧文を1バイトも消していない**
 *
 * **変更の中身**: **作成者への自動付与(`creator_permission` / `D-V7-23`)の計画を返す
 * 述語を1本足した。** **判定そのものは1バイトも足していない** —— **「作った人に何が
 * 渡るか」は既存の `judgeRecordAccess` が下見の1件で答える**(判定の家は今日も1本である)。
 *
 * **`exports` は 60 → 62 に増えた。** 増えた2名は **`CreatorGrantPlan`(計画の型)** と
 * **`creatorGrantPlan`(計画を返す述語)** である。**減った名前・改名した名前は0件。**
 * **`sha256` / `bytes` は `1a324844…`(104245 バイト)→ `4b9a649f…`(109810 バイト)。**
 *
 * **【この更新がしていないこと。先に書く(憲法6)】**
 *  - **`judgeRecordAccess` の中身と署名を1バイトも変えていない**(引数キーは今日も6本)。
 *  - **`judgeOwnerScopedOp` / `nonAdminTableAccess` / `adminReadsAllRows` / `judgeFieldWrite` /
 *    `projectForFieldAudience` を1バイトも変えていない。**
 *  - **`RecordAccessVerdict` は `read` / `write` / `delete` の3キーのままである**(4つ目の
 *    動詞を足していない)。
 *  - **予約規約フィールドは5本のまま**(v7 が足した本数 = 0本)。
 *  - **`src/kernel/` と `schemas/` に本ファイル経由の差分は1バイトも出していない。**
 *  - **`DELETE` とファイル配信の2経路には、今日も判定が1バイトも掛かっていない**
 *    (`V7-M3-T06` / `V7-M3-T07`)。
 *
 * **手続きは前回までと同じものを踏んだ** —— `docs/plan/v3/records/v3-m3.md` §0-3 の2 と
 * `ADR-0053` 限定4 を 2026-08-08 に実読し、**更新前に実際に赤を見てから**更新した。
 *
 * ## 次の更新(`V7-M3-T03`。2026-08-08)—— **旧文を1バイトも消していない**
 *
 * **変更の中身**: **付与表への `create` / `update` / `delete` を、付与が指す行への権限で
 * 絞る述語を1本足した**(`Z-G5` / `D-V7-14`)。**`read` / `write` / `delete` を計算する
 * 場所は今日も `judgeRecordAccess` 1本である** —— **新しい述語は動詞を1つも計算せず、
 * その答えと権限名の解決を使って「付与を作ってよいか」を組み立てるだけである。**
 * **あわせて、権限名の解決だけを private な補助関数に切り出した**(`judgeRecordAccess` の
 * 挙動は1ミリも変えていない。同ファイルの検査 53本が更新前後で緑のまま)。
 *
 * **`exports` は 62 → 65 に増えた。** 増えた3名は **`GrantWriteOp`** / **`GrantWriteVerdict`**
 * / **`judgeGrantWrite`** である。**減った名前・改名した名前は0件。**
 * **`sha256` / `bytes` は `4b9a649f…`(109810 バイト)→ `ba618c7e…`(122377 バイト)。**
 *
 * **【この更新がしていないこと。先に書く(憲法6)】**
 *  - **`judgeRecordAccess` の署名と結果を1バイトも変えていない**(引数キーは今日も6本、
 *    戻り値は今日も3キー)。
 *  - **`judgeOwnerScopedOp` / `nonAdminTableAccess` / `adminReadsAllRows` / `judgeFieldWrite` /
 *    `projectForFieldAudience` を1バイトも変えていない。**
 *  - **予約規約フィールドは5本のまま**(v7 が足した本数 = 0本)。
 *  - **`src/kernel/` と `schemas/` に本ファイル経由の差分は1バイトも出していない。**
 *  - **`DELETE` に行ごとのアクセス権(`judgeRecordAccess` の `delete`)を掛けていない** ——
 *    **`DELETE` 経路で見ているのは「この行が誰かの付与かどうか」だけである**(`V7-M3-T06`)。
 *  - **メンバー表・グループ表そのものへの書込を1ミリも絞っていない** —— **したがって
 *    「自分に権限を付けられない」はグループ経由で回り込める。**
 *
 * **手続きは前回までと同じものを踏んだ** —— **更新前に実際に赤を見てから**更新した。
 *
 * ## 次の更新(`V7-M3-T04`。2026-08-08)—— **旧文を1バイトも消していない**
 *
 * **変更の中身**: **付与の相手が、引き継ぎ元(`inherit_from`)の親の行を読めるかを、
 * 書込の時点で検査する private な補助関数を1本足した**(`Z-G33` / 依頼文 `L6`)。
 * **判定は `judgeRecordAccess` に委ねている** —— **新しい述語は「誰について」「どの行を」
 * 判定するかを組み立てるだけで、`read` / `write` / `delete` を1つも計算しない。**
 *
 * **`exports` は 65 のまま1つも動いていない**(増減も改名も0)——
 * **足したのは private な関数と、`GrantWriteVerdict` の7つ目の値(`parent_denied`)である。**
 * **`sha256` / `bytes` は `ba618c7e…`(122377 バイト)→ `4030c74c…`(128374 バイト)。**
 * **「export 集合だけを見ていたら気づけない変更」がまた起きた**(V3-M8-T03 の差し戻しと同型)。
 *
 * **【この更新がしていないこと。先に書く(憲法6)】**
 *  - **多段(親の親)を1度も辿っていない**(`V7-M4`)。**辿るのは1段目だけである。**
 *  - **書込の時点しか見ていない。** **書いたあとに相手が親の権限を失っても、その付与は残る。**
 *  - **空のグループへの付与を止めていない**(全員が読めることが空集合では真になる)。
 *  - **`judgeRecordAccess` の署名と結果を1バイトも変えていない。**
 *  - **`src/kernel/` と `schemas/` に本ファイル経由の差分は1バイトも出していない。**
 *
 * **手続きは前回までと同じものを踏んだ** —— **更新前に実際に赤を見てから**更新した。
 *
 * ## 次の更新(`V7-M3-T05`。2026-08-08)—— **旧文を1バイトも消していない**
 *
 * **変更の中身**: **消えたグループ行を指す付与を、判定の手前で無効にする述語を1本足した**
 * (`Z-G32`)。**`V7-M3-T01` は「グループ表の行を1行も読まない」を採り、その帰結として
 * 「消えたグループ行を指す付与は今日も効く」を限界として `V7-M3-T05` へ送っていた** ——
 * **今日はそれを解いた。** **`RecordAccessSourceTables` に `groupTable` が増え(2キー →
 * 3キー)、読取経路はグループ表も毎回全件読む。**
 *
 * **`exports` は 65 → 66**(`grantsWithExistingGroups` の1名。**減った名前・改名は0**)。
 * **`sha256` / `bytes` は `4030c74c…`(128374 バイト)→ `8e1b3937…`(134273 バイト)。**
 *
 * **【この更新がしていないこと。先に書く(憲法6)】**
 *  - **`judgeRecordAccess` の引数キーを1本も増やしていない**(今日も6本ちょうど。
 *    `ADR-0294` 限定5 の機械的な固定 = `access-control-role-precedence.test.ts` の `(E1)`)。
 *    **その代償として、グループ行の実在の検査は判定の**外**に在る**(`v7-m3.md` §2-5)。
 *  - **消えた相手を指す付与行・メンバー行を1行も消していない**(掃除の自動処理は0本)。
 *  - **`src/auth/` に1バイトの差分も出していない**(`Z-G32` 限定4)。
 *  - **メンバー行の `account` の書き換えで古い付与がそのまま効くことを、1ミリも止めていない。**
 *
 * **手続きは前回までと同じものを踏んだ** —— **更新前に実際に赤を見てから**更新した。
 *
 * ## 次の更新(`V7-M3-T06`。2026-08-08)—— **旧文を1バイトも消していない**
 *
 * **変更の中身**: **コメントだけである。** **実行される行を1行も足していないし、消しても
 * いない。** **`V7-M3-T05` が申し送った逐語の食い違い**(`judgeRecordAccess` の doc の
 * 「**本関数が実装していないもの**」の1が「今日は『グループだけを指した付与』は1ミリも
 * 効かない」と書いたままで、`V7-M3-T01` が実装した後の実物と合っていなかった)**を、
 * `ADR-0007` §6 規律1 の作法で是正した** —— **旧の4項目を1バイトも書き換えず、
 * その下に「今日の正」を注として足した。**
 *
 * **`exports` は 66 のまま1つも動いていない**(増減も改名も0)。
 * **`sha256` / `bytes` は `8e1b3937…`(134273 バイト)→ `7dcc1fb6…`(135312 バイト)。**
 *
 * **【この更新がしていないこと。先に書く(憲法6)】**
 *  - **`DELETE` に「消す」を配線したのは `src/server/app.ts` であって、本ファイルではない**
 *    —— **本ファイルの述語は1バイトも変わっていない**(`judgeRecordAccess` の署名も
 *    戻り値も今日どおり)。
 *  - **予約規約フィールドは5本のまま**(v7 が足した本数 = 0本)。
 *  - **`src/kernel/` と `schemas/` と `src/auth/` に本ファイル経由の差分は1バイトも無い。**
 *
 * **手続きは前回までと同じものを踏んだ** —— **更新前に実際に赤を見てから**更新した。
 *
 * ## 次の更新(`V7-M4-T02`。`Z-G14`。2026-08-08)—— **旧文を1バイトも消していない**
 *
 * **変更の中身**: **付与の引き継ぎ(`inherit_from` の多段)を辿る判定を1本足した**
 * (`resolveRecordAccess`)。**対象の行を段0 とし、`access_control.inherit_from` が指す
 * `reference` 項目の値を辿って、各段で `judgeRecordAccess` を呼び、`read` / `write` /
 * `delete` を **OR** で重ねる。** **辿るのは判定のためであり、辿った先の行を1件も返さない**
 * (`related` が返す行集合は1件も変わらない = `src/server/access-control-inheritance.test.ts`
 * の (G))。
 *
 * **`exports` は 66 → 68**(増えたのは `RecordAccessResolution` / `resolveRecordAccess` の
 * 2名。**減った名前・改名は0**)。
 * **`sha256` / `bytes` は `7dcc1fb6…`(135312 バイト)→ `c4d6d243…`(144933 バイト)。**
 *
 * **【この更新がしていないこと。先に書く(憲法6)】**
 *  - **`judgeRecordAccess` の署名も中身も1バイトも変えていない**(引数キーは今日も6本
 *    ちょうど。`ADR-0294` 限定5 の機械的な固定 = `access-control-role-precedence.test.ts`
 *    の `(E1)`)。**引き継ぎは判定の**外側**に在る。**
 *  - **`judgeGrantParentAccess`(付与の書込検査。`Z-G33`)を1バイトも変えていない** ——
 *    **あちらは今日も1段目だけを辿る。** **書込検査と読取判定で辿る段数が違う。**
 *  - **本ファイル経由で I/O を1つも足していない** —— **行の読み出しは呼び出し側から渡された
 *    コールバック(`readRows` / `readRow`)で受ける**(`judgeGrantWrite` の先例と同じ形)。
 *    **`src/kernel/` と `schemas/` と `src/auth/` に本ファイル経由の差分は1バイトも無い**
 *    (`Z-G14` 限定7)。
 *  - **段数と読む行数の上限を1つも置いていない**(`Z-G17` / `V7-M4-T04` の担当)。
 *    **止まるのは訪問済み集合(同じ (表, 行) を2度訪れない)だけである。**
 *  - **循環したときのふるまいに専用の検査を置いていない**(`Z-G16` / `V7-M4-T03` の担当)。
 *  - **1ホップに閉じた4条文(`ADR-0079` 限定3 / `ADR-0044` 限定3 / `ADR-0081` 限定5 /
 *    `ADR-0083` 限定5)を1バイトも引き直していない。** **非対称は残る**(`Z-G14` 限定8)。
 *  - **性能を1件も測っていない** —— **全件をメモリに読む post-filter の上に多段が乗り、
 *    行1件ごとに親を辿るので計算量は (行数 × 段数) である。**
 *  - **予約規約フィールドは5本のまま**(v7 が足した本数 = 0本)。
 *
 * **手続きは前回までと同じものを踏んだ** —— **更新前に実際に赤を見てから**更新した。
 *
 * ## 次の更新(`V7-M4-T04`。`Z-G17`。2026-08-08)—— **旧文を1バイトも消していない**
 *
 * **変更の中身**: **引き継ぎを辿るときの上限を2本置き、上限に当たったことを
 * **別の枝**として返すようにした** —— `MAX_RECORD_ACCESS_INHERIT_DEPTH`(段数5)/
 * `MAX_RECORD_ACCESS_INHERIT_ROWS`(辿って読む行の合計 1000)。
 * **`RecordAccessResolution` に2本目の枝(`limit_exceeded`)が増えた**(型の名前は増えて
 * いない)。**上限に当たったら `verdict` を返さず、`limit_exceeded` と上限の種別を返す** ——
 * **黙って空(`read: false`)に丸めない。**
 *
 * **【この上限を置く理由。禁止事項を先に書く】** —— **【禁止】この上限を「性能上の都合」と
 * 書かない**(`v7-m0.md` §5-5 (b))。**置く理由は、黙った打ち切りが「隠れた行がある」と
 * 区別できないからである。**
 *
 * **`exports` は 68 → 70**(増えたのは `MAX_RECORD_ACCESS_INHERIT_DEPTH` /
 * `MAX_RECORD_ACCESS_INHERIT_ROWS` の2名。**減った名前・改名は0**)。
 * **`sha256` / `bytes` は `c4d6d243…`(144933 バイト)→ `cc0f6064…`(154055 バイト)。**
 *
 * **【この更新がしていないこと。先に書く(憲法6)】**
 *  - **`judgeRecordAccess` の署名も中身も1バイトも変えていない**(引数キーは今日も6本
 *    ちょうど)。**上限は判定の**外側**(辿り方)に在る。**
 *  - **`schemas/` に1バイトの差分も出していない** —— **上限は宣言できない。**
 *    **アプリを作る人はマニフェストから上限を読めない**(`Z-G17` `S5` の「門外の対価」)。
 *  - **`src/kernel/` と `src/auth/` に本ファイル経由の差分は1バイトも無い。**
 *  - **最も近い先例(`src/kernel/records.ts:1055` の `MAX_FILTER_DEPTH`)とは
 *    **置き場所が違う** —— **「同じ作法である」とは書けない。**
 *  - **循環の止まり方を1バイトも変えていない** —— **訪問済み集合が先に効く。**
 *    **ただし環の長さが5段を超えるときは段数の上限が先に当たるので、
 *    「循環は必ず正常完了する」とは書けない。**
 *  - **上限の値 5 / 1000 に実測の根拠は1件も無い。** **性能を1件も測っていない。**
 *  - **予約規約フィールドは5本のまま**(v7 が足した本数 = 0本)。
 *
 * **手続きは前回までと同じものを踏んだ** —— **更新前に実際に赤を見てから**更新した。
 */
const OWNER_SCOPE_BASELINE = {
  // **【`V7-M4-T04` による更新。旧値を1バイトも消していない】**
  // **旧: `sha256: "c4d6d243ba724dc65c0a8152767ad4288905ff1edec598c102af629e237e9c44"` /
  //        `bytes: 144933`。**
  // **【`V7-M5-T02`(`Z-G19`)による更新。旧値を1バイトも消していない】**
  // **旧: `sha256: "cc0f60643c96c9d5e0352c99671b79874a8f143243a2d7fe2a893dc77274112d"` /
  //        `bytes: 154055`。**
  // **`exports` は 70 → 71**(増えたのは `isRecordWithoutGrants` の1名。
  // **減った名前・改名は0**)。**予約規約フィールドは5本のままである**(`Z-G19` 限定4)。
  //
  // **【`V7-M5-T02` の差し戻し後による更新(通算3版目)。旧値を1バイトも消していない】**
  // **旧: `sha256: "5f2c31d0c083d2c74350f24588ba3746cd26e810284f1f452eec97b34d4cc767"` /
  //        `bytes: 158589`。**
  // **`exports` は 71 のままで、名前が1つ入れ替わった** ——
  // **`isRecordWithoutGrants` を**非公開**に戻し、代わりに
  // `resolveRecordWithoutGrants`(**引き継ぎのどの段にも付与が無いか**)を公開した。**
  // **理由**: **初版は「その行を直接指す付与が0件」だけで口の母集団を決めており、
  // **親にだけ付与が在る子の行**が並んでいた(実測で確認した穴。他人からは 200 で読める
  // 行が、運営専用の口に並んでいた)。** **`01-record-access-grant-baseline.md` §7 の
  // `V7-M5` の完了の考え方 (ii)(**(i) の壁を迂回する新しい抜け道になっていないこと**)に
  // 当たるので、メインが差し戻し、母集団を引き継ぎの全段まで広げて狭めた。**
  // **辿りは `V7-M4` が入れた仕組みをそのまま使っている** —— **`walkAccessInheritance`
  // (非公開)を `resolveRecordAccess` と共有し、訪問済み集合・段数5・読む行1000 の上限を
  // 1本も増やしていない。** **`judgeRecordAccess` の引数キーは今日も6本ちょうどである。**
  // **`judgeRecordAccess` の引数キーは今日も6本ちょうどで、署名も中身も1バイトも
  // 変えていない**(`ADR-0294` (E1) の機械的な固定)。
  // **中身の変更は2つだけである**: **(1) 付与の突き合わせを `grantsTargetingRecord` へ
  // 切り出し、判定側(`resolveGrantedPermissionNames`)と運営専用の口(`Z-G19`)が
  // **同じ1本**を通るようにした(**第2の述語を書かないため**)。 **(2) その口の母集団を
  // 返す `isRecordWithoutGrants` を1本足した。**
  // **手続きは前回までと同じものを踏んだ** —— **更新前に実際に赤を見てから**更新した。
  //
  // ## 次の更新(`V8-M16`。2026-08-09)—— **旧文を1バイトも消していない**
  //
  // **【期待値を書き換えた理由: `V8-M16` / `J-G3`】** **門A の限定 `J-G3` の逐語
  // 「**複数の役割は和集合1本で合成する**」を実装した** —— **1人が複数の役割を持てるように
  // なったので、`declared.includes(role)`(1値)の形をしていた判定を、**実効ロール集合と
  // 宣言集合の積**へ広げた。**
  //
  // > **実効ロール集合 = `{_auth_users.role の1値}` ∪ `{_auth_user_roles に在る付与}`。**
  // > **判定は「実効ロール集合と宣言集合の積が空でなければ通る」の1本に閉じる。**
  //
  // **【この規則は着手時点でどこにも定義されていなかった。`V8-M16` が初めて定義した】** ——
  // **「今日どおり」ではない。**
  //
  // **旧: `sha256: "f3ba1532b50d7067af781e104dbdc481a58fe949255732be7e39b78dbb3d1e73"` /
  //        `bytes: 167272`。** **`exports` は 71 → 72。**
  // **増えた1名は `ActorRoles`(判定に渡る実効ロール集合の型)である。**
  // **減った名前・改名した名前は0件。**
  //
  // **【この更新がしていないこと。先に書く(憲法6)】**
  //  - **`judgeRecordAccess` の中身と署名を1バイトも変えていない**(引数キーは今日も6本)。
  //  - **`nonAdminTableAccess` / `judgeOwnerScopedOp` / `projectForRead` /
  //    `projectForAnonymous` / `projectOwnerDisplay` を1バイトも変えていない。**
  //  - **予約規約フィールドは5本のままである**(`V8-M16` が足した本数 = 0本)。
  //  - **`AUDIENCE_ROLES` / `VIEW_AUDIENCE_VALUES` の値を1つも動かしていない**
  //    (`scripts/audience-role-sync.test.ts` が緑のままである)。
  //  - **`src/kernel/` と `schemas/` に本ファイル経由の差分は1バイトも出していない。**
  //  - **HTTP の口を1本も足していない**(`HTTP_ENTRY_POINTS` は今日も46本)。
  //
  // **手続きは前回までと同じものを踏んだ** —— **更新前に実際に赤を見てから**更新した。
  //
  // ## 次の更新(`V8-M17`。2026-08-09)—— **旧文を1バイトも消していない**
  //
  // **【期待値を書き換えた理由: `V8-M17` / 台帳 `J-G6` / `J-G7` / `J-G8` / `J-G9` / `J-G10` /
  // `J-G11`】** **役割に束ねた権限(面)の判定を、この1本の家に足した。**
  // **`J-G6`〜`J-G8` の限定の逐語が「**判定はサーバ層の既存の家1本
  // (`src/server/owner-scope.ts`)**」と書いており、置き場所まで限定が名指ししている。**
  //
  // **旧: `sha256: "c87ce4f847b351f2858413f2bdb9af503c71cb1f8f23c37fb8b8654e3eed4d76"` /
  //        `bytes: 172278`。** **`exports` は 72 → 81。**
  // **増えた9名**(**減った名前・改名した名前は0件**):
  //   - `judgeRoleAccess` … **面の判定はこの1本だけである**(4対象を1本で受ける)。
  //   - `RoleAccessTarget` / `RoleAccessDecision` / `AccessLayerName` … その入出力の型。
  //   - `combineRoleAndGrantAccess` / `CombinedAccessDecision` … **面と点を重ねる1本**と
  //     その返り値(**止めた層を名指しする**。メインの裁定 `N-13`)。
  //   - `projectForRoleFields` / `judgeRoleFieldWrite` / `isRoleActionWriteAllowed` …
  //     **旧層(`projectForFieldAudience` / `judgeFieldWrite` / `isViewActionWriteAllowed`)と
  //     同じ問いの形をした、面の側の3本。** **どれも `judgeRoleAccess` に委ねており、
  //     規則を読むコードは今日も1本だけである。**
  //
  // **【この更新がしていないこと。先に書く(憲法6)】**
  //  - **`judgeRecordAccess` の中身と署名を1バイトも変えていない**(引数キーは今日も6本
  //    ちょうど。メインの裁定 `R-6` = 面は同関数の**外側**に立てる)。
  //  - **既存4層(`view.audience` / `field.audience` / `field.writable_by` /
  //    `view_action.audience`)の実装を1バイトも消していない**(撤去は `V8-M20`)。
  //  - **面と他の層の重ね順は `AND` である**(`04` §7-1 (乙) の決定)。
  //    **`V8-M19` が `D-V8-23` に従って、面 と 点 の間だけを `OR` に変える**(裁定 `R-13-4`)。
  //    **この中間状態を「一時的だから問題ない」とは書かない。**
  //  - **条件(`when`)を1バイトも作っていない**(`V8-M18` の担当)。
  //  - **`src/kernel/` と `schemas/` に本ファイル経由の差分は1バイトも出していない**
  //    (足したのは `import type` 1行だけで、層またぎの**値**の import は今日も増えていない)。
  //  - **HTTP の口を1本も足していない**(`HTTP_ENTRY_POINTS` は今日も46本)。
  //  - **予約規約フィールドは5本のままである**(`V8-M17` が足した本数 = 0本)。
  //
  // **手続きは前回までと同じものを踏んだ** —— **更新前に実際に赤を見てから**更新した。
  // ## 次の更新(`V8-M18`。2026-08-09)—— **旧文を1バイトも消していない**
  //
  // **【期待値を書き換えた理由: `V8-M18` / 台帳 `J-G12` / `J-G13` / `J-G14` / `J-G15` /
  // `J-G16`】** **権限に書いた条件(かつ / または / でない と「自分」)を**実際に評価する
  // 評価器**を、この1本の家に足した。** **メインの裁定 `R-17-7` が置き場所まで名指ししている**
  // (「**サーバ層に1本だけ書く(`src/server/owner-scope.ts` の判定の家)**」)。
  // **既存の絞り込みの評価器(`compileFilter` / `compileFilterPredicate`)は使っていない** ——
  // **どちらも非 export であり、同ファイルが「DB 側には1バイトも落とさない」と裁定済みである。**
  //
  // **【2026-08-16 訂正(`SQ-M4` / `SQ-M5`)。直前の2行を1バイトも書き換えていない】**
  // **`compileFilterPredicate` は今日は存在しない** —— **システムテーブルの読取を SQL 経路へ
  // 一本化したときに `src/kernel/read-records.ts` から削除された。**
  // **今日ある絞り込みの評価器は `compileFilter` の1本だけである**(今日も非 export)。
  // **`owner-scope.ts` の同じ箇所にも同じ訂正を対で入れてある** —— **片方だけ直すと、
  // 同じ裁定を引いた2箇所の字面が食い違う。**
  //
  // **旧: `sha256: "3ed139f5845d9568dc2ccda03a7c51f2e2c0040356dbabc3aebb129c3bd072af"` /
  //        `bytes: 188531`。** **`exports` は 81 のまま1つも動いていない**
  // (**増えた名前・減った名前・改名した名前は0件**)。
  // **【数を丸めない】この 81 は
  // `grep -cE '^export (const|function|type) ' src/server/owner-scope.ts` の実測である。**
  // **したがって今回赤くなったのは `sha256` と `bytes` の2本だけで、`exports` の集合は
  // 最初から緑だった。**
  //
  // **増えたのは非 export の4本である**(**公開名を1つも増やさないことが、
  // 「条件の評価が1箇所に集約されている」ことの構造的な担保である** —— **ファイルの外から
  // 呼べないので、判定が2箇所に割れようがない**):
  //   - `evaluateRoleCondition` … **規則1本の条件を評価する入口。`rule.when` を読む唯一の場所。**
  //   - `roleConditionHolds` … **`and` / `or` / `not` と葉2種を評価する再帰の本体。**
  //   - `sameConditionScalar` … 等値の葉のスカラ比較(boolean と 0/1 だけを揃える)。
  //   - `RoleConditionOutcome` … その返り値の型。
  // **あわせて `RoleAccessDecision` に `conditional` キーが1本増えた** —— **「答えが行ごとに
  // 変わる」ことを呼び出し側に知らせる旗である**(行を渡さない関門は「通しうる」までしか
  // 言っていない)。**`allowed` / `governed` / `blockedBy` の意味は1ミリも変えていない。**
  //
  // **【この更新がしていないこと。先に書く(憲法6)】**
  //  - **`judgeRecordAccess` の引数を1本も増やしていない**(今日も6本ちょうど。裁定 `R-6`)。
  //  - **既存4層(`view.audience` / `field.audience` / `field.writable_by` /
  //    `view_action.audience`)の実装を1バイトも消していない**(撤去は `V8-M20`)。
  //  - **面と点の重ね順は今日も `AND` である**(`OR` にするのは `V8-M19`)。
  //  - **カーネルから値を1つも import していない** —— **深さの上限(`MAX_FILTER_DEPTH`)は
  //    適用時にカーネルが検査済みなので、この評価器は定数を1つも持たない**(裁定 `R-17-4`)。
  //    **`scripts/kernel-import-snapshot.txt` に製品コードの行を1行も足していない。**
  //  - **書込・削除の経路には行を1件も渡していない** —— **条件つきの書込規則は行の中身を
  //    1度も見ずに通る。穴である**(記録に書いた)。
  //  - **HTTP の口を1本も足していない**(`HTTP_ENTRY_POINTS` は今日も46本)。
  //  - **予約規約フィールドは5本のままである**(`V8-M18` が足した本数 = 0本)。
  //
  // **手続きは前回までと同じものを踏んだ** —— **更新前に実際に赤を見てから**更新した。
  //
  // ## 次の更新(`V8-M19`。2026-08-09)—— **旧文を1バイトも消していない**
  //
  // **【期待値を書き換えた理由: `V8-M19` / 台帳 `J-G17` / `J-G18` / `J-G19` / `J-G20` /
  // `J-G33`】** **面(役割に束ねた権限)と点(行ごとの付与)の重ね順を、`AND` から `OR` へ
  // 変えた**(`D-V8-23` のユーザ決定。メインの裁定 `R-5` / `R-15-2`)。
  // **`J-G18` の限定の逐語が置き場所まで名指ししている**(「**サーバ層
  // (`resolveRecordAccess` の系列)。合成は(行, 要求している人, 動詞)ちょうどの単位で、
  // 引き算も順序も勝ち負けの規則も作らない**」)。
  // **あわせて `J-G33`(所属の穴 / `U-2`)を、同じファイルの既存1箇所
  // (`judgeGrantWrite`)に足した** —— **参加者の表・グループの表そのものへの書込を、
  // 運営ロール以外に通さない。**
  //
  // **旧: `sha256: "52dd11f34e56b02eac4bef8f30c746bba72b7747f0290708a79d2b4f76f78f60"` /
  //        `bytes: 198370`。** **`exports` は 81 → 85。**
  // **増えた4名**(**減った名前・改名した名前は0件**):
  //   - `resolveCombinedRecordAccess` … **行1件について面と点を `OR` で重ねる1本。**
  //     **面を `walkAccessInheritance` の**外側**で1回だけ評価する**(`J-G20` の限定の逐語)。
  //   - `CombinedRecordAccessResolution` / `RecordAccessBlockedLayers` … その返り値の型。
  //     **動詞ごとに「止めた層」を名指しする**(裁定 `N-13` を `OR` のもとでも保つ)。
  //   - `roleGateBlocksWithoutGrants` … **行を手元に持たない関門が、点を見るまでもなく
  //     止めてよいかを決める述語**(`OR` を `AND` に戻さないための1本)。
  //
  // **【この更新がしていないこと。先に書く(憲法6)】**
  //  - **`judgeRecordAccess` の中身と署名を1バイトも変えていない**(引数キーは今日も6本
  //    ちょうど。メインの裁定 `R-6`)。
  //  - **既存4層(`view.audience` / `field.audience` / `field.writable_by` /
  //    `view_action.audience`)の実装を1バイトも消していない**(撤去は `V8-M20`)。
  //    **旧4層・固定ロール・個人スコープ(`st_owner`)との重ね順は今日も `AND` である** ——
  //    **`OR` にしたのは面と点のあいだ**だけ**である。**
  //  - **面に引き算(deny)・優先度・順序・勝ち負けの規則を1つも作っていない。**
  //  - **`schemas/` / `src/kernel/` / `src/mcp/` に本ファイル経由の差分は1バイトも出していない。**
  //  - **HTTP の口を1本も足していない**(`HTTP_ENTRY_POINTS` は今日も46本)。
  //  - **予約規約フィールドは5本のままである**(`V8-M19` が足した本数 = 0本)。
  //  - **付与表・メンバー表の**読取**を1ミリも絞っていない**(v7 の残り2穴のうち1件。
  //    **塞がなかったと記録に書いた**)。
  //
  // **手続きは前回までと同じものを踏んだ** —— **更新前に実際に赤を見てから**更新した。
  //
  // ## 次の更新(`V8-M20`。2026-08-10)—— **旧文を1バイトも消していない**
  //
  // **【期待値を書き換えた理由: `V8-M20` / 台帳 `J-G27` / `J-G28` / `J-G29` / `J-G30` /
  // 手続きは `ADR-0301`】** **既存4層の宣言と、予約規約フィールド1本を、この家から取り除いた。**
  // **`ADR-0301`(語彙の判定値に「廃止」を足す)が定めた手続きで通した撤去である** ——
  // **`V8-M17` 以降の各版が「**既存4層の実装を1バイトも消していない**(撤去は `V8-M20`)」と
  // 予告し続けてきた、その `V8-M20` が本更新である。**
  //
  // **取り除いた宣言(4層 + 予約規約フィールド1本)**:
  //   - **画面の「見せる相手」`view.audience`**(`J-G27`)→ **役割 × 対象(画面)× 読取。**
  //   - **項目の「見せる相手」`field.audience`**(`J-G28`)→ **役割 × 対象(項目)× 読取。**
  //   - **項目の「書ける相手」`field.writable_by`**(`J-G28`)→ **役割 × 対象(項目)× 書込。**
  //   - **ボタンの「見せる相手」`view_action.audience`**(`J-G29`)→ **役割 × 対象(表)× 書込
  //     と 役割 × 対象(ボタン)× 読取。**
  //   - **予約規約フィールド `st_admin_readable` の1本だけ**(`J-G30`)→ **役割 × 対象(表)× 読取。**
  //
  // **旧: `sha256: "89654707aaecbca93abcc3b52f7bf9fad986fa7dee7d110cb522f36425d17356"` /
  //        `bytes: 210607`。** **`exports` は 85 → 72。**
  //
  // **【このリポジトリで `exports` が減る初めての更新である】** ——
  // **本注記より前の版はすべて「**減った名前・改名した名前は0件**」と書いてきた。
  // **本版はそう書けない。** **減る側を1名ずつ列挙する**(`ADR-0301` の作法)。
  //
  // **減った17名**(**「増えた名前」と「減った名前」を1名ずつ書く**):
  //   - `ADMIN_READABLE_FIELD` / `adminReadableField` / `adminReadsAllRows` … `J-G30`。
  //   - `viewAudience` / `viewAudienceDeclaration` / `ViewAudienceValue` /
  //     `isViewAudienceAllowed` / `isViewAnonymousVisible` … `J-G27`。
  //   - `fieldAudience` / `projectForFieldAudience` … `J-G28`(見せる相手)。
  //   - `fieldWriters` / `judgeFieldWrite` / `FieldWriteVerdict` … `J-G28`(書ける相手)。
  //   - `ViewActionWriteKind` / `isViewActionWriteAllowed` … `J-G29`。
  //   - `projectForRead` / `READ_HIDDEN_RESERVED_FIELDS` … `J-G30`(「書けるが効かない値」を
  //     読取応答から伏せる射影。**伏せる対象そのものが無くなった**)。
  //
  // **増えた4名**:
  //   - `roleReadCrossesOwnerScope` … **面の規則が `read` を許した表では `st_owner` の
  //     絞り込みが読取についてだけ効かなくなる**ことを判定する述語(ユーザ決定 `D-V8-35`)。
  //   - `isRoleGovernedField` … **面の規則が名指ししている項目か**
  //     (`scrubHiddenFieldIds` が旧 `fieldAudience` の代わりに見る述語)。
  //   - `RoleActionWriteKind` / `RoleFieldWriteVerdict` … **旧層の型
  //     (`ViewActionWriteKind` / `FieldWriteVerdict`)の置き直し。**
  //
  // **【この更新がしていないこと。先に書く(憲法6)】**
  //  - **予約規約フィールドは 5本 → 4本になった。** **`st_owner` / `st_public` /
  //    `st_undeletable` / `st_no_direct_create` は1本も消えていない**(消えたのは
  //    `st_admin_readable` の1本だけである)。**【禁止】これを成果として書かない**
  //    (`ADR-0301` 限定10)。
  //  - **`judgeRecordAccess` の中身と署名を1バイトも変えていない**(引数キーは今日も6本)。
  //  - **`isOwnerVisible` は第3引数が消えて2引数になった** —— **`st_admin_readable` の行を
  //    受けていた引数だからである。**
  //  - **`scrubHiddenFieldIds` は3引数 `(manifest, table, errors)` になった。**
  //
  // **【挙動が変わった1点。ユーザ決定 `D-V8-35`(2026-08-10)】**
  // **面の規則が `read` を許している表では、`st_owner` の絞り込みが**読取についてだけ**
  // 効かなくなる。** **書込・削除は今日どおりである。**
  // **【禁止】これを「同じ挙動を保った」と書かない。**
  //
  // **手続きは前回までと同じものを踏んだ** —— `docs/plan/v3/records/v3-m3.md` §0-3 の2 と
  // `ADR-0053` 限定4 を 2026-08-10 に実読し、**更新前に実際に赤を見てから**更新した。
  // **今回も「1バイトも変わっていない」の側と export 集合の側の両方が赤くなった。**
  // **【`V8-M20` の作業中に同ファイルがもう一度動いた。1度目の実測値も消さずに残す】**
  // **1度目の実測(2026-08-10 05:54)**:
  //   `sha256: "836e0f69b19272abac33d03e062fe0689109497aa5bae246c5a57d01d8893055"` /
  //   `bytes: 184381`。**`exports` は 72 で、下の配列と一致していた。**
  // **2度目の実測(2026-08-10 05:58。下の値)** —— **`exports` の集合は1名も動いていない**
  // (`diff` で確認済み)。**変わったのは内容だけである。**
  //
  // ## 次の更新(`V8-M21` の後半。2026-08-10)—— **旧文を1バイトも消していない**
  //
  // **【期待値を書き換えた理由: `V8-M21` / 台帳 `J-G21` / `J-G22a` / `J-G23`】**
  // **3つの限定がそろって「**判定の家は `src/server/owner-scope.ts` の既存1本**」と
  // 書いており、置き場所まで限定が名指ししている。** **受信口・登録起動の自動処理・
  // コードの島に**面**(役割に束ねた権限)を効かせるために、
  // **面と点を `OR` で重ねる述語を1本足した。**
  //
  // **旧: `sha256: "2c2ad450f239ebdd2f993a63dc20faf1cbfdd44dc30103cfdc4d063f273ca482"` /
  //        `bytes: 187432`。** **`exports` は 72 → 73。**
  // **増えた1名は `combineRoleAndCreatorGrant`**(**「これから作る行」について面と点を
  // `OR` で重ねる**)。**減った名前・改名した名前は0件。**
  //
  // **【この更新がしていないこと。先に書く(憲法6)】**
  //  - **合成の規則を2本目に増やしていない** —— **新しい述語は `CreatorGrantPlan` を
  //    `RecordAccessVerdict` の形に**写すだけ**で、`OR` そのものは既存の
  //    `combineRoleAndGrantAccess` に委ねている。**
  //  - **`judgeRecordAccess` の署名も中身も1バイトも変えていない**(引数キーは今日も6本)。
  //  - **`judgeRoleAccess` / `resolveCombinedRecordAccess` を1バイトも変えていない。**
  //  - **予約規約フィールドは4本のままである**(`V8-M21` が足した本数 = 0本)。
  //  - **`schemas/` に1バイトの差分も出していない。**
  //
  // **手続きは前回までと同じものを踏んだ** —— **更新前に実際に赤を見てから**更新した
  // (「1バイトも変わっていない」の側と export 集合の側の両方が赤くなった)。
  //
  // ## 次の更新(`V8-M26`。2026-08-10)—— **旧文を1バイトも消していない**
  //
  // **【期待値を書き換えた理由: `V8-M26-T03` / `T03b`。ユーザ決定 `D-V8-45` / `D-V8-65`。
  // 台帳 `T-G1a` / `T-G4b`】**
  //
  // **面の既定が「閉じる」側へ倒れた** —— **規則を1本も書いていない表・画面・ボタンは、
  // 今日は誰にも見えない**(`field` だけは今日どおり通す。`T-G1b` = **却下**)。
  // **`judgeRoleAccess` の2つの分岐が新しい非 export の述語 `unruledRoleAccess` を返す形に
  // なり、閉じる側の1値 `CLOSED_ROLE_ACCESS` が足された。**
  //
  // **旧: `sha256: "4da0844a61c99e5b10d95e7aa69e7e8dd767024e68edcfa60263094c116ed1af"` /
  //        `bytes: 189315`。** **`exports` は 73 → 74。**
  // **増えた1名は `roleRulesNameTarget`**(**「その対象を名指しした規則が、どれかの役割に
  // 1本でも書かれているか」だけを見る述語** = **既定を閉じる前の `governed` の意味そのもの**)。
  // **減った名前・改名した名前は0件。**
  //
  // **なぜ1名増えたのか(`T03b`)**: **既定が閉じたことで `governed` が
  // 「宣言が実在するか」の答えではなくなり、1つの旗が2つの問いに割れた。**
  // **`web/src/auth/authz.tsx` の `viewIdForRecordRequest`(レコード取得 URL に `?view=` を
  // 付けるかどうか)は後者を見なければならない** —— **前者のままでは全リクエストが名乗り、
  // 宣言を1つも書いていないアプリの URL まで変わる**(その関数の doc 自身が禁じている形。
  // 実測で `web/test/` の赤が 384 本に増えた)。
  //
  // **【この更新がしていないこと。先に書く(憲法6)】**
  //  - **`roleRulesNameTarget` は許可を1ミリも決めない** —— **可否は `judgeRoleAccess`
  //    1本のままである。** **判定のロジックを2本目に増やしていない**(非 export の
  //    `ruleNamesTarget` を再利用している)。
  //  - **面と点の `OR` を `AND` へ戻していない**(明文の禁止)——
  //    **閉じるときも `governed: true` を返すので、v7 の行ごとの付与は今日どおり効く。**
  //  - **`judgeRecordAccess` / `resolveCombinedRecordAccess` / `combineRoleAndGrantAccess` を
  //    1バイトも変えていない。**
  //  - **予約規約フィールドは4本のままである**(`V8-M26` が足した本数 = 0本)。
  //
  // **【挙動が変わった点。隠さない】** **既定が反転した** —— **`V8-M26` より前に作られた
  // アプリの表・画面・ボタンは、規則を書き足すまで閉じたままである**
  // (`T04` の自動付与は**これから作るもの**にしか効かない)。
  // **【禁止】これを「同じ挙動を保った」と書かない。**
  //
  // **手続きは前回までと同じものを踏んだ** —— **更新前に実際に赤を見てから**更新した
  // (今回も「1バイトも変わっていない」の側と export 集合の側の両方が赤くなった)。
  //
  // ===================================================================================
  // **【次の更新。`V8-M26` / ユーザ決定 `D-V8-69`(2026-08-10)。旧値を1バイトも消していない】**
  // ===================================================================================
  //
  // **旧: `sha256: "5141188aec5f41d46e51adcbe2f8b132c4fbcb87ffc9b13b5a349b2d07e150e0"` /
  //        `bytes: 195826`。** **`exports` は 74 → 74**(**増減も改名も0件**)。
  //
  // **根拠**: **ユーザ決定 `D-V8-69`。見出しの逐語「システムの表は権限の外に置く」。**
  // **選ばれた説明文の逐語**:
  // > **変更履歴やアプリ一覧は今までどおり見えます。ただし「書いていなければ見えない」が
  // > 及ばない先が1種類残り、総括に「ここには権限が効かない」と名指しで書くことになります。**
  //
  // **変更の中身は3つだけである**:
  //  1. **`judgeRoleAccess` の先頭に、システムが持つ表を面の判定から外す1本を足した**
  //     (`UNGOVERNED_ROLE_ACCESS` を返す)。**非 export の述語 `targetsSystemTable` 1本と
  //     根拠の節を添えた** —— **だから `exports` は1つも動いていない。**
  //  2. **値 import を1本増やした**: `isSystemTableId`(`src/shared/system-tables.ts`)。
  //     **効かない先の全量をこのファイルへ書き写さないためである**(書き写すと、
  //     表が増えた日に片方だけ古くなる)。**`src/kernel/` からの値 import は今日も0件であり、
  //     `scripts/kernel-import-drift.test.ts` の対象は1件も増えていない**
  //     (`src/shared/` は `src/kernel/` ではない)。
  //  3. **`ADR-0053` 限定4 の手続き**(`docs/plan/v3/records/v3-m3.md` §0-3 と同限定の逐語)
  //     **を 2026-08-10 に実読してから更新した。** **更新前に実際に赤を見ている。**
  //
  // **【この更新がしていないこと。先に書く(憲法6)】**
  //  - **システムテーブルが書けるようになったわけではない** —— **書込は今日も
  //    カーネルの読み取り専用エラー(400)が止める。** **面の 403 が元の 400 に戻っただけ。**
  //  - **認証境界は1バイトも開いていない**(未認証は今日どおり 401)。
  //  - **`judgeRoleAccess` の3段(宣言の有無 / 名指しの有無 / allow-list)を1バイトも
  //    変えていない** —— **足したのは、その手前に立つ免除1本だけである。**
  //  - **予約規約フィールドは4本のまま。** **`schemas/` と `src/kernel/` に1バイトも
  //    差分を出していない。**
  //
  // **【総括に書く義務。これは決定の一部である】** **`_apps` / `_changelog` / `_ai_usage`
  // の3本を名指しして「ここには権限が効かない」と総括に書くこと。**
  // **【禁止】「既定を全部閉じた」と書かない。**
  // **【同じ `D-V8-69` の中で1度書き直した。旧値を1バイトも消していない】** ——
  // **旧: `sha256: "9f700376d279f6ea0d15d0377d10c7677a0cbf649ebbd993c2b41d6a6588930a"` /
  //        `bytes: 200555`。**
  // **差は整形器(`bun run lint` = biome)が `targetsSystemTable` の `return` を1行に
  // 畳んだ 10 バイトだけである** —— **意味は1ミリも変わっていない。**
  // **記録の理由**: **この検査は「1バイトも変わっていない」を見るものなので、
  // 整形器が触った事実も残さないと、後から読む者が差の出どころを追えない。**
  // =====================================================================================
  // **【`V8-M26`(ユーザ決定 `D-V8-70`)による更新。旧値を1バイトも消していない】**
  // **旧: `sha256: "81a050e80bec0de702d127c3a3b15a3760bcbc046e866599fd440e4358026346"` /
  //        `bytes: 200545`。**
  //
  // **根拠**: **ユーザ決定 `D-V8-70`(2026-08-11)。選ばれた見出しの逐語
  // 「共有行も見えるようにする」。** **選ばれた説明文の逐語**:
  // > **条件の書き方に「その項目が空かどうか」を表す形を一つ足し、自動の1行を
  // > 「自分の行、または持ち主が空の行」にします。共有化が今までどおり使えますが、
  // > 覚える言葉が一つ増えます(この軸は言葉を増やすことに慎重です)。**
  //
  // **変更の中身は2つだけである**:
  //  1. **`roleConditionHolds`(非 export)に、葉の3種目 `{field, is_empty}` の分岐を
  //     足した。** **述語は同ファイルの既存の `isSharedOwner` をそのまま呼ぶ** ——
  //     **「空」の定義を2箇所に置かないためである。** **新しい定数も新しい述語も
  //     1本も作っていない。**
  //  2. **その理由・「空」の定義(`null` / 値が入っていない / 長さ0の文字列)・
  //     未ログインでの答えを doc コメントに書いた**(残りは全部コメントである)。
  //
  // **`exports` は1つも動いていない**(**増えた名前・減った名前・改名は0件**)——
  // **したがって今回赤くなったのは `sha256` と `bytes` の2本だけで、下の期待配列は
  // 1行も書き換えていない。**
  //
  // **【この更新がしていないこと。先に書く(憲法6)】**
  //  - **`judgeRoleAccess` の3段+免除(`D-V8-69`)を1バイトも変えていない** ——
  //    **触ったのは条件の葉の評価1箇所だけである。**
  //  - **`isSharedOwner` / `isOwnerVisible` / `isAllowedOwnerUpdate` の本体を1バイトも
  //    変えていない** —— **`st_owner` の後追い絞り込みの側は今日どおりである。**
  //  - **予約規約フィールドは4本のまま。** **`src/auth/` に1バイトの差分も無い。**
  //  - **書込・削除の経路に行を渡すようにしていない** —— **`V8-M18` が申告した
  //    「条件つきの書込規則は行の中身を1度も見ずに通る」穴は今日も開いたままである。**
  //
  // **手続きは前回までと同じものを踏んだ** —— **更新前に実際に赤を見てから**更新した
  // (実測の逐語: `Expected: 200545` / `Received: 203264`)。
  // =====================================================================================
  // =====================================================================================
  // **【`V8-M27-T04`(台帳 `T-G5` / ユーザ決定 `D-V8-38`)による更新。
  //   旧値を1バイトも消していない】**
  // **旧: `sha256: "4e03be0ad285912244ff5d3436eb92546281ea5f9d2f8da33a5edb0331921d47"` /
  //        `bytes: 203264`。**
  //
  // **根拠**: **`V8-M27`(「運営(予約3ロール = `owner` / `editor` / `viewer`)か否か」で
  // 表単位の可否を決める古い層の撤去)。台帳 `T-G5`。ユーザ決定 `D-V8-38`。**
  //
  // **変更の中身は2つだけである**:
  //  1. **`NonAdminTableAccess`(型)と `nonAdminTableAccess()`(関数)を撤去した。**
  //     **`export` が2名**減る**** —— **この検査でこれまで一度も起きていない向きの差である
  //     (`V8-M20` は減ったが、それは別の3名である)。**下の期待配列から2行を
  //     コメントに落とし、旧の並びを逐語で残した。**
  //  2. **撤去の記録(何が在ったか・どこで効いていたか・なぜ消せたか・
  //     何を消していないか)をコメントで書いた。**
  //
  // **【この更新がしていないこと。先に書く(憲法6)】**
  //  - **`judgeRoleAccess` の3段+免除を1バイトも変えていない。**
  //  - **予約規約フィールドは4本のまま**(`st_owner` / `st_public` / `st_undeletable` /
  //    `st_no_direct_create`)。**その述語(`personalOwnerField` / `publicField` /
  //    `accessControlOf`)の本体も1バイトも変えていない。**
  //  - **`schemas/` と `src/kernel/` に1バイトの差分も出していない。**
  //  - **`RESERVED_ROLES` / `isReservedRole` は撤去していない**(値域として残る)——
  //    **このファイルの `declaredUserKinds` が今日も `isReservedRole` を呼ぶ。**
  //
  // **手続きは前回までと同じものを踏んだ** —— **更新前に実際に赤を見てから**更新した
  // (実測の逐語: `Expected: 203264` / `Received: 205123`、および `exports` の
  // `- Expected - 2 / + Received + 0`)。
  // =====================================================================================
  // =====================================================================================
  // **【`V8-M27-T11`(2026-08-11)による更新。旧値を1バイトも消していない】**
  // **旧: `sha256: "4b628d0e45822faaaff0747846f7bb945a0e70f753ee308e36a5d189018a2bf0"` /
  //        `bytes: 205123`。**
  //
  // **根拠**: **`V8-M27` 完了の考え方 (iii)(逐語「**撤去の前後で、同じ要求が「どの層で
  // 止まったか」を両方貼ること** —— **`ADR-0305` 限定6 の `blockedBy` /
  // `AccessLayerName` を使う。**」)に対して、**`V8-M27` は「HTTP へ出さない」を選んだ。**
  //
  // **変更の中身は1つだけである** —— **`AccessLayerName` の doc コメントに、
  // 「出さないと決めた理由3点」と「(iii) を『実装のどの行が止めたか』で代替したこと」を
  // 書いた。** **【この更新は実行されるコードを1行も足していない。全部コメントである。】**
  //
  // **書いた理由の3点(要旨。全文は `src/server/owner-scope.ts` の `AccessLayerName`)**:
  //  1. **`ADR-0308` の限界6 が「止めた層の名前は HTTP の応答から読めない」と既に
  //     宣言しており、出すと本文と食い違う**(引き直すには ADR の手続きが要る)。
  //  2. **応答本文に載せると `ADR-0305` 限定11 が伏せているもの(その表が在ること)が
  //     漏れる** —— **伏せ方と出し方が正面から衝突する。**
  //  3. **監査記録に載せるなら `_auth_activity` に列が1本要り、それは記録の形(語彙)の
  //     変更であって `ADR-0007` の審査対象である。**
  //
  // **【この更新がしていないこと。先に書く(憲法6)】**
  //  - **`AccessLayerName` の値域を1バイトも変えていない**(`"role"` / `"grant"` の2値)。
  //  - **`exports` は1つも動いていない**(**増減も改名も0件**)—— **したがって今回
  //    赤くなったのは `sha256` と `bytes` の2本だけで、下の期待配列は1行も書き換えていない。**
  //  - **`judgeRoleAccess` の3段+免除(`D-V8-69`)を1バイトも変えていない。**
  //  - **`blockedBy` を出す実装を1バイトも足していない** —— **`ADR-0308` の限界6 は
  //    今日も真である。**
  //
  // **手続きは前回までと同じものを踏んだ** —— **更新前に実際に赤を見てから**更新した
  // (実測の逐語: `Expected: 205123` / `Received: 208536`)。
  // =====================================================================================
  // =====================================================================================
  // **【`V8-M28`(2026-08-11)による更新。旧値を1バイトも消していない】**
  // **旧: `sha256: "a5a4209ee9dfca99a4d491f7652afdbf18d026101e12e4816a211eafc26f78f1"` /
  //        `bytes: 208536`。** **`exports` は 72 → 74**(**下の期待配列に2名を足した。
  //        減った名も改名も0件である**)。
  //
  // **根拠**: **`V8-M28`**(**「アプリの定義を変えられる」と「人に役割を配れる」を、
  // 役割の規則として**別々に**書けるようにする単位**)。台帳の単位は **`T-G14`**(役割の
  // 規則の対象に**アプリの設定**を足す)/ **`T-G17`**(同じく**人の役割**を足す)/
  // **`T-G20`**(役割を配るときの不変条件)。ユーザ決定は **`D-V8-75`**(**`owner` を
  // 配れるのは `owner` を持つ人だけ**)/ **`D-V8-76`**(**自分自身の役割は誰も変えられない
  // —— 持ち主も同じ**)。
  //
  // **変更の中身は3つである**:
  //  1. **`RoleAccessTarget` の union に枝が2本増えた**(`{ target: "app" }` /
  //     `{ target: "role" }`)—— **どちらもプロパティが `target` 1本だけで、既存4枝の
  //     どれとも形が違う**(表も画面もボタンも名指ししない)。
  //     **`ruleNamesTarget` の `switch` にも枝が2本増えた**(`default` は今日も無い)。
  //  2. **`judgeRoleAccess` の分岐を1本も足していない** —— 新2対象は既存の4段
  //     (`targetsSystemTable` → 宣言0件 → `!governed` → allow-list)をそのまま通る。
  //     **可否を決める関数は今日も `judgeRoleAccess` 1本ちょうどである**(`ADR-0305`
  //     限定3)。
  //  3. **`judgeRoleAssignment` を1本 export した**(下記)。**これは可否を決める関数では
  //     なく、「役割を配ってよいか」の不変条件2本(自分自身 / `owner` の配布)である。**
  //
  // **【`exports` が増えた2名。1名ずつ書く(`ADR-0305` 限定3 の作法)】**
  //  - **`RoleAssignmentVerdict`** …… `judgeRoleAssignment` の答えの型。今日の枝は
  //    `self`(`D-V8-76`)と `owner_grant`(`D-V8-75`)の2つちょうどである。
  //  - **`judgeRoleAssignment`** …… `PATCH /api/apps/:app_id/auth/users/:user_id` が
  //    役割を書き込む直前に1度だけ呼ぶ判定。**`judgeGrantWrite` の直後に置いた**
  //    (判定は本ファイルに集約する = `ADR-0061` 限定4 / `ADR-0305` 限定3)。
  //
  // **【減った側ではなく増えた側である。1行書く】** **`V8-M27` は `exports` が**減った**
  // 初めての例だった**(85 → 72 の世代とは別に、`nonAdminTableAccess` /
  // `NonAdminTableAccess` の2名を撤去した回。`:1172`-`:1199` に逐語が残っている)。
  // **`V8-M28` は増える側である** —— **撤去は1名も無く、改名も0件である。**
  //
  // **【この更新がしていないこと。先に書く(憲法6)】**
  //  - **`AccessLayerName` の値域を1バイトも変えていない**(`"role"` / `"grant"` の2値)。
  //    **`blockedBy` は今日も HTTP の応答本文に1バイトも載らない**(`V8-M27-T11` の決定)。
  //  - **`RoleRuleVerb` に4語目を足していない**(新2対象の動詞は `write` 1語ちょうど)。
  //  - **`UNGOVERNED_ROLE_ACCESS` / `CLOSED_ROLE_ACCESS` / `unruledRoleAccess` の中身を
  //    1バイトも変えていない** —— **新2対象は `field` ではないので既定で閉じる。**
  //  - **予約規約フィールドは4本のまま**(`st_owner` / `st_public` / `st_undeletable` /
  //    `st_no_direct_create`)。
  //  - **`judgeRecordAccess` / `judgeGrantWrite` の引数キーを1本も増やしていない。**
  //
  // **手続きは前回までと同じものを踏んだ** —— **更新前に実際に赤を見てから**更新した
  // (実測の逐語: `Expected: 208536` / `Received: 219450`、および `exports` の
  // `- Expected - 0` / `+ Received + 2` = `+ "RoleAssignmentVerdict"` /
  // `+ "judgeRoleAssignment"`)。**`sha256` と `bytes` は検査の失敗出力から写さず、
  // `shasum -a 256 src/server/owner-scope.ts` と `wc -c src/server/owner-scope.ts` を
  // 自分で打って確かめた値である。**
  // =====================================================================================
  // =====================================================================================
  // **【`V8-M29` 第1波(2026-08-11)による更新。旧値を1バイトも消していない】**
  // =====================================================================================
  //
  // **旧: `sha256: "55fe32e6aa79a419d9dad39ac4536882b70330ff3c6c62d88f8505679223a7ca"` /
  //        `bytes: 219450`。** **`exports` は2名増えた。**
  //
  // **【期待値を書き換えた理由: 台帳 `T-G10`(門外。**限定採用**)。ユーザ決定
  // `D-V8-78` / `D-V8-79` / `D-V8-80`】** **「人に付けられる値」と「登録で名乗れる値」の
  // 出所に `app.roles[].id` を立てた。** **`user_kinds` を読む2本
  // (`declaredUserKinds` / `effectiveUserKindIds`)は1バイトも書き換えていない** ——
  // **撤去は次の波であり、この波は「代わりを先に立てる」だけである。**
  //
  // **【`exports` が増えた2名。1名ずつ書く】**
  //  - **`declaredRoleIds`** …… **`app.roles[].id` を宣言の順そのままで返す。**
  //    **予約4語を1語も落とさない** —— **落とすのは値域を組む
  //    `src/server/auth-routes.ts` 側であり、落とす場所を1箇所に閉じている**
  //    (`owner` が「登録で名乗れる値」の1本目になる穴を、そこで塞ぐため)。
  //  - **`declaredRoleKinds`** …… **表示名(`name`)を持つ役割だけを `{id,name}` で返す**
  //    (`D-V8-79` = **表示名は今日どおり任意**。書かなかった役割は載らず、画面には
  //    識別子が生で出る)。
  //
  // **【この更新がしていないこと。先に書く(憲法6)】**
  //  - **`judgeRoleAccess` / `judgeRoleAssignment` / `judgeGrantWrite` /
  //    `judgeRecordAccess` を1バイトも変えていない** —— **この波が触ったのは**値域**だけで、
  //    **判定**は1バイトも触っていない。**
  //  - **`declaredUserKinds` / `effectiveUserKindIds` / `isReservedRole` を1バイトも
  //    変えていない** —— **`anonymous` を除くのは値域の側だけである**(`T-G10` 限定3)。
  //  - **予約規約フィールドは4本のまま。** **`schemas/` と `src/kernel/` に1バイトの
  //    差分も出していない**(`T-G10` は門外の単位であり、それが判定の前提である)。
  //
  // **手続きは前回までと同じものを踏んだ** —— **更新前に実際に赤を見てから**更新した
  // (「1バイトも変わっていない」の側と export 集合の側の両方が赤くなった)。
  // **`sha256` と `bytes` は検査の失敗出力から写さず、自分で打って確かめた値である。**
  // =====================================================================================
  // =====================================================================================
  // **【`V8-M29` 第2波(2026-08-11)による更新。旧値を1バイトも消していない】**
  // =====================================================================================
  //
  // **旧: `sha256: "ec5f8a5c830aafbffef184e973d09dbcd57ea6d72e1df1fea1974e3314c000ed"` /
  //        `bytes: 222066`。** **`exports` は2名**減った**。**
  //
  // **【期待値を書き換えた理由: 台帳 `T-G9a` / `T-G12`(門A。判定値 = **廃止**)】**
  // **立場の一覧(`app.user_kinds`)を廃止し、それを読む2本を撤去した。**
  //
  // **【`exports` が減った2名。1名ずつ書く】**
  //  - **`declaredUserKinds`** …… **マニフェストの `app.user_kinds` を読む唯一の実装**
  //    だった。**読む先(`$defs/app/properties/user_kinds`)が同じ差分で消えた。**
  //    **代わりに立つのは `declaredRoleIds` / `declaredRoleKinds` である。**
  //  - **`effectiveUserKindIds`** …… **宣言が無ければ `["customer"]` に倒す1本**だった。
  //    **代わりに立つのは `src/server/auth-routes.ts` の `baseRoleValues()` である**
  //    (戻りは常に `["owner","editor","viewer","customer"]`)。
  //
  // **【この更新がしていないこと。先に書く(憲法6)】**
  //  - **`judgeRoleAccess` / `judgeRoleAssignment` / `judgeGrantWrite` /
  //    `judgeRecordAccess` を1バイトも変えていない。**
  //  - **`isReservedRole` / `RESERVED_ROLES` / `DEFAULT_ROLE_IDS` を1バイトも変えていない**
  //    —— **消えたのはこのファイルからの参照だけである**(`src/auth/types.ts` の定義は健在)。
  //  - **予約規約フィールドは4本のまま。**
  //
  // **【`ADR-0301` 限定6 の ④ = 担い手が無いもの】** **「宣言によって `customer` を
  // 値域から外す」機能。** **`effectiveUserKindIds` が担っていた唯一の機能であり、
  // 今日それを担うものは1つも無い。**
  //
  // **手続きは前回までと同じものを踏んだ** —— **更新前に実際に赤を見てから**更新した。
  // **`sha256` と `bytes` は検査の失敗出力から写さず、自分で打って確かめた値である。**
  // =====================================================================================
  // =====================================================================================
  // **【`V8-M37`(2026-08-13)による更新。旧値を1バイトも消していない】**
  // =====================================================================================
  //
  // **旧: `sha256: "6630b8230a25b8e30f696a3832d7450752e717aadb2ff04d69a16fe4e82f0672"` /
  //        `bytes: 222038`。** **`exports` は2名**増えた**。**
  //
  // **【期待値を書き換えた理由: 台帳 `F-G3`(門外)/ `F-G5`(門外)】**
  //
  // **【`exports` が増えた2名。1名ずつ書く】**
  //  - **`isOwnerSpoofedOnCreate`**(`F-G3` / ユーザ決定 `D-V8-96`)…… **作成の入力が
  //    「他人を持ち主にしようとしている」かを判定する。** **着手前は `src/server/app.ts` が
  //    送られてきた値を読む分岐を1本も持たず、他人の利用者IDを送っても 201 で黙って本人に
  //    化けていた。** **今日は 403 で断る。** **書かない / 空文字 / `null` / 自分の id は
  //    今日どおり 201 である**(判定は `isAllowedOwnerUpdate` をそのまま呼んでいる)。
  //  - **`judgeOwnerUpdateWithDisplay`**(`F-G5`)…… **「現在の持ち主の表示名のままの
  //    書き戻し」1形だけを付け替えと見なさない。** **`projectOwnerDisplay` から
  //    `rowOwner === actorId` の枝を落とした結果、運営が自分の行を丸ごと書き戻すと 403 に
  //    なる退行が実際に起きた**(2026-07-30 の差し戻しが名指ししていたもの。本単位で再現した)。
  //
  // **【この更新がしていないこと。先に書く(憲法6)】**
  //  - **`isAllowedOwnerUpdate` の本体を1バイトも変えていない**(`ADR-0079` 限定5)——
  //    **増えた2名はどちらもあれを**呼ぶ**だけである。** **`isAllowedOwnerUpdate.length`
  //    は今日も 2 である**(同ファイルの (V3-M8-T02 i) が測っている)。
  //  - **`isSharedOwner` / `isOwnerVisible` / `judgeOwnerScopedOp` の本体を1バイトも
  //    変えていない** —— **まとめ書込・島・受信口・MCP の経路は1ミリも動いていない。**
  //  - **予約規約フィールドは4本のまま。** **`schemas/` に1バイトの差分も無い。**
  //  - **整形を掛ける経路を1つも増やしていない**(`ADR-0061` 限定7)——
  //    **`resolveOwnerDisplays` の呼び出しは今日も読取2経路の2箇所だけである。**
  //
  // **手続きは前回までと同じものを踏んだ** —— **更新前に実際に赤を見てから**更新した
  // (実測の逐語: `Expected: 222038` / `Received: 230978`、および `exports` の差分2名)。
  // **`sha256` と `bytes` は検査の失敗出力から写さず、自分で打って確かめた値である**
  // (`shasum -a 256 src/server/owner-scope.ts` / `wc -c < src/server/owner-scope.ts`)。
  // =====================================================================================
  // **【`V8-M39`(2026-08-13)による更新。旧値を1バイトも消していない】**
  // =====================================================================================
  //
  // **旧: `sha256: "7c0c03d473b55b59e7c0fdd0d03a6d92cd2fef1e55343aed7380f092375caec9"` /
  //        `bytes: 230978`。** **`exports` は 74 のまま1名も動いていない**
  // (**増えた名前・減った名前・改名した名前は0件**)。
  //
  // **【期待値を書き換えた理由: 台帳 `F-G8`(門外 `Δ7`。限定採用)】**
  //
  // **変えたのは doc コメント1ブロックだけである** —— **`AccessLayerName` の直前に在る
  // 「**`V8-M27-T11`。この名前を HTTP へ出さないと決めた**」のブロックに、
  // **`V8-M39` が 403 の文面にだけ出すことにした**旨を**追記**した。**
  // **既存の逐語(出さないと決めた3つの理由・`ADR-0308` 限界6 の引用・`V8-M27` 当時の
  // 実測)を1バイトも書き換えていない。**
  //
  // **【この更新がしていないこと。先に書く(憲法6)】**
  //  - **実行される行を1行も足していない・消していない・並べ替えていない** ——
  //    **本更新の差分は 100% がコメントである**(`AccessLayerName` の値域
  //    `"role" | "grant"` も1バイト動いていない)。
  //  - **`judgeRoleAccess` / `combineRoleAndGrantAccess` / `resolveCombinedRecordAccess` /
  //    `isRoleActionWriteAllowed` の中身と署名を1バイトも変えていない** ——
  //    **`F-G7` の限定「**判定の家を増やさない**」の履行であり、`F-G8` は文面だけを動かす。**
  //  - **`src/kernel/` と `schemas/` に1バイトの差分も出していない**(`Δ7`)。
  //    **`ValidationError` は今日も4キーちょうどである。**
  //  - **予約規約フィールドは4本のまま。** **HTTP の口は今日も 47本である。**
  //
  // **手続きは前回までと同じものを踏んだ** —— **更新前に実際に赤を見てから**更新した
  // (実測の逐語: `Expected: 230978` / `Received: 234611`。**`exports` の側は最初から
  // 緑であり、赤くなったのは「1バイトも変わっていない」の側だけである**)。
  // **`sha256` と `bytes` は検査の失敗出力から写さず、自分で打って確かめた値である**
  // (`shasum -a 256 src/server/owner-scope.ts` / `wc -c < src/server/owner-scope.ts`)。
  // =====================================================================================
  //
  // ## 次の更新(`V8-M41`。2026-08-13)—— **旧文を1バイトも消していない**
  //
  // **【期待値を書き換えた理由: `V8-M41` / 台帳 `F-G13` = 限定採用・門外(`Δ7`)】**
  // **`v8-m35.md` §5-1 の `F-G13` の限定の逐語**: 「**運営専用の口だけを広げる。**
  // **一般の一覧・単件の伏せ方(`ADR-0317` 限定5)を1バイトも動かさない**」。
  // **`v8-m33.md` §12 の `D-13`(**規則ゼロで誰にも届かなくなった行を、運営専用の口が
  // 1件も拾わない**)を塞ぐために、**面の側の母集団を返す述語**をこの1本の家に足した。**
  // **置き場所が本ファイルなのは `ADR-0061` 限定4(判定は `owner-scope.ts` に集約)である。**
  //
  // **旧: `sha256: "c5c31e8d0db132e5abfc7e0eb2abfde25108007ba49977cebcf1a2a118366f3c"` /
  //        `bytes: 234611`。** **`exports` は 76 → 78。**
  // **増えた2名**(**減った名前・改名した名前は0件**):
  //   - `resolveRecordUnreachableByRoles` … **その行が「面から誰にも届かない行」か。**
  //     **`resolveRecordWithoutGrants`(点の側の母集団)の**面の側の対**である。**
  //     **可否を1ミリも計算しない** —— **`judgeRoleAccess` を宣言された役割ぶん呼んで
  //     畳むだけであり、規則(`rules`)も条件(`when`)も1バイト読んでいない**
  //     (**判定の家は今日も1本**)。
  //   - `RoleUnreachableResolution` … その返り値の型(`orphan` と `undecided` の2値)。
  //
  // **【この更新がしていないこと。先に書く(憲法6)】**
  //  - **`judgeRoleAccess` / `judgeRecordAccess` / `resolveRecordWithoutGrants` /
  //    `combineRoleAndGrantAccess` の中身と署名を1バイトも変えていない。**
  //  - **`creatorGrantPlan` を1バイトも変えていない**(`F-G12` の限定「**持ち主の特別扱いを
  //    戻さない。自動メンバー登録もしない**」の履行)。 **持ち主の分岐は今日も1本も無い。**
  //  - **一般の一覧・単件の伏せ方を1バイトも動かしていない**(一覧は 200 の空一覧・
  //    単件は 404・運営以外は 403。実測は `src/server/role-unreachable-records.test.ts` の
  //    (B-1)〜(B-4))。
  //  - **`src/kernel/` と `schemas/` に1バイトの差分も出していない**(`Δ7`)。
  //  - **HTTP の口を1本も足していない**(`HTTP_ENTRY_POINTS` は今日も 47本)。
  //    **広げたのは既に在る口の入口条件だけである。**
  //  - **予約規約フィールドは4本のまま。** **`ValidationError` は今日も4キーちょうど。**
  //
  // **手続きは前回までと同じものを踏んだ** —— **更新前に実際に赤を見てから**更新した
  // (実測の逐語: `Expected: 234611` / `Received: 240163`。**今回は `exports` の側も
  // 同時に赤くなり、出力に `RoleUnreachableResolution` と
  // `resolveRecordUnreachableByRoles` の2名が並んだ**)。
  // **`sha256` と `bytes` は検査の失敗出力から写さず、自分で打って確かめた値である**
  // (`shasum -a 256 src/server/owner-scope.ts` / `wc -c < src/server/owner-scope.ts`)。
  // =====================================================================================
  //
  // ## 次の更新(`V8-M10-T02`。2026-08-15)—— **旧文を1バイトも消していない**
  //
  // **【期待値を書き換えた理由: `V8-M10-T02` / 台帳 `Q-G16a` / `Q-G21d`】**
  // **「だれの目に、どの行が入るか」(母集団)を決める判定を、この1本の家に集めた。**
  // **着手前、その判定は `src/server/app.ts` のレコード一覧のルートの中に**5分岐**として
  // 直に書かれていた** —— **集計表(`V8-M10-T03`)にも同じ判定を通すために、
  // `ADR-0061` 限定4(**判定は `owner-scope.ts` に集約。呼び出し側に条件式を書かない**)の
  // 側へ寄せた。** **これはリファクタであり、レコード一覧の応答は1バイトも変わっていない**
  // (**実 HTTP の応答 64本 + 集計表 20本を着手前に採り、同じ台を復元して採り直して
  // `diff -r` が空であることで示した**。`docs/plan/v8/records/v8-m10.md` §3)。
  //
  // **旧: `sha256: "67c0b252cf67acc3f81d8fce473daa9e02a1f983a479e9bf50ab89bfc0fbc3a5"` /
  //        `bytes: 240163`。** **`exports` は 78 → 83。**
  // **増えた5名**(**減った名前・改名した名前は0件**):
  //   - `judgeRecordPopulation` … **(表, 要求している人) から母集団を決める1本。**
  //     **返すのは3つだけである**(**可視行の集合 / 絞りは要らない / 上限に当たった**)。
  //   - `recordPopulationScope` … **どの絞り方をする表かだけを決める**(**行を1件も見ない**)。
  //     **`app.ts` が「DB に `LIMIT` / `OFFSET` を渡してよいか」を読取の**前**に決めるために要る。**
  //   - `RecordPopulation` / `RecordPopulationScope` / `RecordPopulationClass` … その入出力の型。
  //
  // **【この更新がしていないこと。先に書く(憲法6)】**
  //  - **`judgeRecordAccess` / `judgeRoleAccess` / `resolveCombinedRecordAccess` /
  //    `roleReadCrossesOwnerScope` / `isOwnerVisible` / `isPublicRow` の中身と署名を
  //    1バイトも変えていない** —— **新しい1本は、既にある述語を同じ順序で呼び直すだけである。**
  //  - **射影(`projectForRoleFields` / `projectForAnonymous`)・表示名の解決
  //    (`resolveOwnerDisplays`)・ページ切り(`slicePage`)・件数と合計の採り方は
  //    **集約していない**(今日の場所 = `app.ts` に残した)。** **`v8-m10.md` §1 `T02` の
  //    `2'` が名指しでそう定めている。**
  //  - **分岐5(非スコープ)は「絞りは要らない」を返すだけで、レコード一覧は今日どおり
  //    `readRecordCountAndSum` の SQL 1文で件数と合計を採り続ける**(`ADR-0104` 限定6 と
  //    `src/server/list-view-sum-boundary.test.ts` の (D) 3本を1本も壊していない)。
  //  - **群を1つも知らない**(`Q-G21d`)—— **入力は行、出力は行である。**
  //    **「群を作ってから絞る」形は、この関数の形の上で書けない。**
  //  - **`src/kernel/` から値を1つも import していないという本ファイルの性質を保った** ——
  //    **DB を読む配管(`recordAccessJudge`)は `app.ts` から関数として渡す。**
  //  - **`src/kernel/` と `schemas/` に1バイトの差分も出していない。**
  //  - **HTTP の口を1本も足していない**(`HTTP_ENTRY_POINTS` は今日も 47本)。
  //  - **予約規約フィールドは4本のまま。**
  //
  // **手続きは前回までと同じものを踏んだ** —— **更新前に実際に赤を見てから**更新した
  // (実測の逐語: `Expected: 240163` / `Received: 248562`。**`exports` の側も同時に赤くなり、
  // 出力に `RecordPopulation` / `RecordPopulationClass` / `RecordPopulationScope` /
  // `judgeRecordPopulation` / `recordPopulationScope` の5名が並んだ**)。
  // **更新後にもう一度わざと壊して赤を見た**(`owner-scope.ts` に空行を1つ足して
  // `Expected: 248562` / `Received: 248563` を確認し、元へ戻した)。
  // **`sha256` と `bytes` は検査の失敗出力から写さず、自分で打って確かめた値である**
  // (`shasum -a 256 src/server/owner-scope.ts` / `wc -c < src/server/owner-scope.ts`)。
  // =====================================================================================
  //
  // ## 次の更新(`SQ-M5`。2026-08-16)—— **旧文を1バイトも消していない**
  //
  // **【期待値を書き換えた理由: `SQ-M5` の申し送り(字面の是正)】**
  // **`owner-scope.ts` の `V8-M18` の注記が、削除済みの `compileFilterPredicate` を
  // 名指ししたままだった。** **`SQ-M4` がシステムテーブルの読取を SQL 経路へ一本化した
  // ときに `src/kernel/read-records.ts` から消えている。**
  // **直したのは注釈だけである** —— **`exports` は 83 のまま1名も動いておらず
  // (増えた名前・減った名前・改名した名前は0件)、判定のコードは1バイトも触っていない。**
  // **したがって今回赤くなったのは `sha256` と `bytes` の2本だけで、`exports` の側は
  // 最初から緑だった。**
  // **同じ裁定を逐語で引いている本ファイルの注記(上の `V8-M18` の段)にも、
  // 対で同じ訂正を入れた** —— **片方だけ直すと2箇所の字面が食い違う。**
  //
  // **旧: `sha256: "750c40a412d30051da6fcd4cd0d725f04ad8de8e5022807e4c33c8af9e7ad3b2"` /
  //        `bytes: 248562`。**
  //
  // **手続きは前回までと同じものを踏んだ** —— **更新前に実際に赤を見てから**更新した
  // (実測の逐語: `Expected: 248562` / `Received: 249433`)。
  // **`sha256` と `bytes` は検査の失敗出力から写さず、自分で打って確かめた値である**
  // (`shasum -a 256 src/server/owner-scope.ts` / `wc -c < src/server/owner-scope.ts`)。
  // =====================================================================================
  // =====================================================================================
  // **【期待値を書き換えた理由: `V10-M27-T01a`(2026-08-25。`ADR-0375`)】**
  // **既に在った2つの述語(`manifestRoleDeclarations` / `roleRulesOf`)を `export` した。**
  // **実装は1バイトも変えていない** —— **足したのは `export ` の2語だけである**
  // (`roleRulesOf` の側は、行が 100 桁を超えたので biome の整形が署名を3行に折り返した。
  // **中身は1バイトも動いていない**)。
  // **なぜ公開したか**: **コメントの可視性の合成が「役割の規則を1本も書いていないアプリか」を
  // 数えるためである。** **既に公開されている `declaredRoleIds` / `declaredRoleKinds` は
  // `rules` を1度も読まないので、この問いに答えられない。**
  // **`comment-visibility.ts` の中に役割の宣言を読み直す実装を書くと、同ファイルが禁じている
  // 「判定の家の2軒目」になる** —— **それを避けるために公開した。**
  // **`exports` は 83 → 85**(増えたのは上の2名。**減った名前・改名は0**)。
  //
  // **旧: `sha256: "1ef5b470eab2a93c4acfeed37ace68178368cee63a225012c8be2a64786ca6df"` /
  //        `bytes: 249433`。**
  //
  // **手続きは前回までと同じものを踏んだ** —— **更新前に実際に赤を見てから**更新した
  // (実測の逐語: `Expected: 249433` / `Received: 249452`。`exports` の側の赤の出力には
  // `manifestRoleDeclarations` と `roleRulesOf` の2名が並んだ)。
  // **`sha256` と `bytes` は検査の失敗出力から写さず、自分で打って確かめた値である**
  // (`shasum -a 256 src/server/owner-scope.ts` / `wc -c < src/server/owner-scope.ts`)。
  // =====================================================================================
  // =====================================================================================
  // **【期待値を書き換えた理由: `V14-M1-T01` / `V14-M1-T03`(2026-09-05。台帳 `RB-G1` /
  //   `RB-G2` / `RB-G3`)】**
  // **サーバが「その行に何ができるか」を応答に載せるために、3名を公開した。**
  //  - **`RecordRowAccess`** … **行1件ぶんの判定の形**(`read` / `write` / `delete` /
  //    `grant_write` の4キーちょうど。**`blockedBy` は載せない**)。
  //  - **`recordRowAccessMap`** … **その形を組む1本**(4キーの綴りが製品コードで
  //    ここちょうど1箇所になる)。
  //  - **`rowGrantWriteJudge`** … **「その行に付与を配れるか」を答える入口**
  //    (**`judgeGrantWrite` の関門 (1)(2) だけを見る**。**同関数の本体は1バイトも
  //    変えていない**)。
  // **判定の家を1軒も増やしていない** —— **`read` / `write` / `delete` の出どころは
  // 今日も `resolveCombinedRecordAccess` 1本であり、上の3名はその答えを**運ぶ**側である。**
  // **`exports` は 85 → 88**(**減った名前・改名は0**)。
  //
  // **旧: `sha256: "82a3446336ce92a99053d2b7d0903693248aa76017535447b59a57019d0d5b0a"` /
  //        `bytes: 249452`。**
  //
  // **手続きは前回までと同じものを踏んだ** —— **更新前に実際に赤を見てから**更新した
  // (実測の逐語: `Expected: 249452` / `Received: 258271`。`exports` の側の赤の出力には
  // `RecordRowAccess` / `recordRowAccessMap` / `rowGrantWriteJudge` の3名が並んだ)。
  // **`sha256` と `bytes` は検査の失敗出力から写さず、自分で打って確かめた値である**
  // (`shasum -a 256 src/server/owner-scope.ts` / `wc -c < src/server/owner-scope.ts`)。
  //
  // **【`V14-M1-T05`(2026-09-05)で2度目の更新】** **`owner_scoped` 枝にも行ごとの
  // 判定を並べるようにしたため、同ファイルがもう一度動いた。**
  // **`V14-M1-T01` はこの枝を空けており、`st_owner` と行ごとのアクセス権の宣言を
  // 併せ持つ表で、issue が報告したのと同じ「出るのに押せない」が残っていた。**
  // **旧(`V14-M1-T01` 時点): `sha256: "0332b572ee66c525e1868c03f4143a03fa1ac0f55e4f72bf26e07d137ddcc948"` /
  //        `bytes: 258271`。**
  // **`exports` は 88 のまま1名も増減していない**(足したのは既存 export の中身だけである)。
  // **今回も更新前に実際に赤を見た**(実測の逐語: `Expected: 258271` / `Received: 259447`)。
  // **値は失敗出力から写さず、`shasum -a 256` / `wc -c` を自分で打って確かめた。**
  //
  // **【`V14-M1-T04`(2026-09-05)で3度目の更新】** **`ADR-0402` を起草した点検が、
  // 同ファイル `:4106` の doc「載るのは母集団が `record_access` の枝だけである」が
  // `V14-M1-T05` の後は偽であることを見つけた。** **旧文を1バイトも消さずに訂正を
  // 6行足したので、同ファイルがもう一度動いた**(振る舞いは1バイトも変えていない。散文だけである)。
  // **旧(`V14-M1-T05` 時点): `sha256: "2314be88e9b9bd49e767b7d46a6b3debe1c788886c7961a1f1c4eca5075842f2"` /
  //        `bytes: 259447`。** **`exports` は 88 のまま。**
  // **今回も更新前に実際に赤を見た**(実測の逐語: `Expected: 259447` / `Received: 259983`)。
  // **値は失敗出力から写さず、`shasum -a 256` / `wc -c` を自分で打って確かめた。**
  // =====================================================================================
  //
  // **【`V15-M2-T02`(台帳 `CR-G1` / `CR-G4`。`ADR-0404` / `ADR-0405`)で4度目の更新】**
  // **`inherit_from` を宣言した表に行を作るとき、指した親の行に書けるかを問う述語1本と、
  // その4状態の型、および「作った本人に権限が1つでも渡るか」の述語1本を足した。**
  // **旧(`V14-M1-T04` 時点): `sha256: "5266775bdea7883734c737671837ffca8fd37e21703931704a4c0504404aab16"` /
  //        `bytes: 259983`。**
  // **`exports` は 88 → 91**(増えたのは `CreateParentAccessVerdict` /
  // `judgeCreateParentAccess` / `isCreatorGrantReachable` の3名。**減った名前・改名は0**)。
  // **`combineRoleAndGrantAccess` の本体は1バイトも変えていない**(`ADR-0404` 限定2)——
  // **足したのは合成の**外側**に置く前提の関門であって、合成の規則ではない。**
  // **予約規約フィールドは4本のままである**(`ADR-0405` §8 の 7 を踏んでいない)。
  // **今回も更新前に実際に赤を見た**(実測の逐語: `Expected: 259983` / `Received: 274350`。
  // `exports` の側の赤の出力には上の3名が並んだ)。
  // **値は失敗出力から写さず、`shasum -a 256 src/server/owner-scope.ts` /
  // `wc -c < src/server/owner-scope.ts` を自分で打って確かめた。**
  // =====================================================================================
  //
  // **【`V15-M3-T04`(台帳 `CR-G5`。`ADR-0404`)で5度目の更新。散文だけである】**
  // **`V15-M3` は `src/server/owner-scope.ts` に述語を1本も足していない** ——
  // **足したのは、同ファイルが持っていた「この節が実装していないもの」の 1
  // (「まとめ書き(`POST /batch`)に掛けていない」)への**訂正の散文**だけである。**
  // **その1行は今日は偽になった**(`V15-M3` がまとめ書きにも同じ述語を配線したため)——
  // **旧文を1バイトも消さずに訂正を7行足したので、ファイルがもう一度動いた。**
  // **【葉タスクの見立てとの食い違い。丸めない】** —— **`04-v15-m3-tasks.md` の `T04` の 3 は
  // 「`owner-scope.ts` を触らない予定なので赤くならないはずである。赤くなったら述語を
  // 増やしている」と書いていたが、同じ葉タスクの `T04` の 4 が
  // 「`V15-M3` と書いた散文を1つも残さずに訂正する」ことを命じており、その1つが
  // `owner-scope.ts` の中に在った。** **この2項は同時には満たせない** ——
  // **述語を1本も増やさない側(`exports` が動かない)を採り、散文の訂正のために
  // 本基準を更新した。** **`V15-M2` の記録 §6 の 5 と同じ型の食い違いである。**
  // **旧(`V15-M2-T02` 時点): `sha256: "5802399ba6ccd8b237c81a97cb0814d61c965b6cb7b739da18ab6ff33e881052"` /
  //        `bytes: 274350`。**
  // **`exports` は 91 のまま**(**増えた名前・減った名前・改名は0**)。
  // **`combineRoleAndGrantAccess` の本体は今日も896バイトで1バイトも変わっていない**
  // (`ADR-0404` 限定2)。
  // **今回も更新前に実際に赤を見た**(実測の逐語: `Expected: 274350` / `Received: 274985`)。
  // **値は失敗出力から写さず、`shasum -a 256 src/server/owner-scope.ts` /
  // `wc -c src/server/owner-scope.ts` を自分で打って確かめた。**
  // =====================================================================================
  //
  // **【`V15-M6B-T03`(実地の実測。`docs/plan/v15/records/v15-m6.md` §2 の 7b)で6度目の更新】**
  // **`judgeCreateParentAccess` の答えを 4状態 → **5状態** にした** ——
  // **`"missing_named_permission"`(親の行には書けるが、名指しされた権限名を持たない)を
  // 足し、その場合の `return` を `"denied"` から差し替えた。**
  // **【なぜ】** —— **実地で、その人に「あなたには、指定された元の行を書き換える権限が
  // ありません。」が返っていた。** **同じ実地で、その人は親の行を `PATCH` して 200 を得た**
  // —— **応答が事実として嘘であった。**
  // **旧(`V15-M3-T04` 時点): `sha256: "d4f236e7eed2b48c7642953b415b0a74d85dfb75162876c773503fa307f8f143"` /
  //        `bytes: 274985`。**
  // **`exports` は 91 のまま**(**増えた名前・減った名前・改名は0**。
  // 足したのは既存の公開型 `CreateParentAccessVerdict` の**5つ目の枝**であって、
  // 新しい名前ではない)。
  // **`combineRoleAndGrantAccess` の本体は今日も896バイトで1バイトも変わっていない**
  // (`ADR-0404` 限定2。`awk '/^export function combineRoleAndGrantAccess/,/^}$/'` の
  //  `md5` が着手 sha `91ab3281` と一致することまで打って確かめた)。
  // **止まる人も応答コード(403)も1つも変えていない** —— **変えたのは文面だけである。**
  // **今回も更新前に実際に赤を見た**(実測の逐語: `Expected: 274985` / `Received: 276979`)。
  // **値は失敗出力から写さず、`shasum -a 256 src/server/owner-scope.ts` /
  // `wc -c < src/server/owner-scope.ts` を自分で打って確かめた。**
  // **【同じ段の中で、同じ日にもう一度動かした。丸めない】** —— **`V15-M2` / `V15-M3` と
  // 同じ「消した1行を逐語でコメントに残す」作法を、差し替えた `return` にも当てたためである
  // (`276979` → `277091`。足したのはコメント2行だけで、実行される経路は1バイトも変わっていない)。
  // **その1行の逐語は `judgeCreateParentAccess` の中に置いてある。**
  // **`exports` は 91 のまま。`combineRoleAndGrantAccess` の本体も896バイトのままである。**
  // =====================================================================================
  // =====================================================================================
  //
  // **【`V15-M8-T03`(台帳 `CR-G9` / `ADR-0408`)で7度目の更新。旧文を1バイトも消していない】**
  // **`judgeCreateParentAccess` に「更新前の行」を渡す**任意の引数1本**(`previous`)を足し、
  // それが渡ったときだけ「要求が親の参照の値を**変える**要素」に絞る枝を1つ入れた。**
  // **【なぜ】** —— **`CP-V15` の独立点検が、作成の壁を**2手**で回り込めることを実物で
  // 再現した**(`src/server/create-parent-write.test.ts` の `(i-1)` `(i-2)`)——
  // **参照を空にして作り、あとから `PATCH`(またはまとめ書きの `update` op)で親を
  // 書き入れると、その行は壁の内側に入っていた。** **ユーザ決定 `D-V15-11` の逐語は
  // 「今回塞ぐ」である。**
  // **旧(`V15-M6B-T03` 時点): `sha256: "cc0592c302700b98787fdc572ee1eb89d906837f4cf7b814ce11f25ef383fdf0"` /
  //        `bytes: 277091`。**
  // **`exports` は 91 のまま**(**増えた名前・減った名前・改名は0**。
  // 足したのは既存の公開関数の**任意の引数1本**であって、新しい名前ではない ——
  // **2本目の判定の家を作っていない**。`ADR-0294` 限定7 / `ADR-0408` 限定1)。
  // **`combineRoleAndGrantAccess` の本体は今日も896バイトで1バイトも変わっていない**
  // (`ADR-0404` 限定2 = `ADR-0408` 限定2。`awk '/^export function combineRoleAndGrantAccess/,/^}$/'`
  //  の `md5` が着手 sha `1363b873` と一致することまで打って確かめた:
  //  `e40e3df60cbf06e0156d6f54de38a8fb`)。
  // **今回も更新前に実際に赤を見た。**
  // **値は失敗出力から写さず、`shasum -a 256 src/server/owner-scope.ts` /
  // `wc -c < src/server/owner-scope.ts` を自分で打って確かめた。**
  // **【同じ段の中で、同じ日にもう一度動かした。丸めない】** —— **`V15-M2` / `V15-M3` /
  // `V15-M6B` と同じ「書き換えた1行を逐語でコメントに残す」作法を、`params` の
  // 分解の1行にも当てたためである**(`280400` → `280565`。**足したのはコメント2行だけで、
  // 実行される経路は1バイトも変わっていない**)。 **その1行の逐語は
  // `judgeCreateParentAccess` の中に置いてある。**
  // **`exports` は 91 のまま。`combineRoleAndGrantAccess` の本体も896バイトのままである。**
  // =====================================================================================
  //
  // **【`V17-M1-T01f`(台帳 `AC-G1` / `AC-G3`。`ADR-0410`)による更新。2026-09-07。
  // 旧値も旧文も1バイトも消していない】**
  //
  // **【通し番号を新しく振らない。正直に書く】** —— **本ファイルの通し番号は2系統あり、
  // 既に食い違っている**(ファイル冒頭側の注記は `V4-M10-T04` を「7度目」と呼び、
  // 直上のこの注記は `V15-M8-T03` を「7度目」と呼ぶ)。**どちらかを書き換えないと
  // 揃えられないので、揃えずに番号を振らない**(旧文を消さないため)。
  //
  // **変更の中身(1文)**: **1件の付与行にメンバー欄とグループ欄が両方書いてあるときは
  // 「その人であり、かつそのグループに居る」ときだけ効かせる AND に本ファイルの2箇所
  // (`resolveGrantedPermissionNames` / `judgeGrantParentAccess`)を直し、あわせて
  // `judgeGrantWrite` の group 枝が「要求者自身が属しているグループ」宛の付与を
  // 既存の判定値 `{kind:"self"}` で断るようにした**(`ADR-0410` `AC-G1` / `AC-G3`)。
  //
  // **旧(`V15-M8-T03` 時点。逐語。1文字も消していない)**:
  //   `sha256: "1f4e636773621af21d8e76d78f51c69fe0df76db0b9079ffd170ca7ca22053ed"` /
  //   `bytes: 280565`。
  //
  // **`exports` は 91 のまま**(**増えた名前・減った名前・改名は0**)—— **新しい判定値を
  // 1つも作らず `{kind:"self"}` を使い回したためである**(`ADR-0410` §Decision 3 の 3 が
  // 「新しい判定値を作れば `:1997` の export 集合も赤くなる」と名指ししていた線)。
  // **実際、更新前の赤は「1バイトも変わっていない」の側1本だけで、export 集合の側は
  // 緑のままだった。**
  // **今回も更新前に実際に赤を見た** —— `Expected: 280565` / `Received: 287307`。
  // **値は失敗出力から写さず、`shasum -a 256 src/server/owner-scope.ts`
  // (→ `e3a9b34fd1670c5ce6a31ab4be4e30b340321b4f20a179a6501e6bd6007576f7`)と
  // `wc -c < src/server/owner-scope.ts`(→ `287307`)を自分で打って確かめた。**
  //
  // **手続き**: **`ADR-0410` 限定8 が「`owner-scope.ts` の凍結基準の更新は
  // `ADR-0053` 限定4 の手続きに従う」と定めている。** その定めのとおり、
  // **`docs/plan/v3/records/v3-m3.md` §0-3** と
  // **`docs/adr/0053-navigation-visibility-declaration-revision.md:159`(限定4)**
  // の本文を **2026-09-07 に実読してから**更新した。
  //
  // **【`V17-M1-T01g`(台帳 `AC-G26`。`ADR-0410` 限定22)による更新。2026-09-07。
  // 直上の注記も旧値も1バイトも消していない】**
  //
  // **【通し番号を新しく振らない】** —— **理由は直上に書いたとおりである**(2系統が
  // 既に食い違っており、揃えるには旧文を書き換えるしかない)。
  //
  // **変更の中身(1文)**: **直上の `V17-M1-T01f` が入れた AND の数え方が
  // `resolveGrantedPermissionNames` の側だけ `members.group` を見ておらず、
  // **グループを1度も辿れない宣言**(`grant.member` + `grant.group` + `groups` は在るが
  // `members.group` が無い。適用時検査はこれを拒まない)で**両欄が埋まった付与行が
  // 誰にも一生効かなくなっていた**のを、他の2箇所
  // (`judgeGrantParentAccess` の `bothHeld` / 生成器 `grantExistsSql`)と
  // **同じ数え方**に揃えた。**
  //
  // **【なぜ直したか】** —— **本体は `read: false`、生成物の SQL は相手の列だけの述語を
  // 出して `TRUE` を返しており、**同じ宣言・同じ行・同じ人に本体と生成物が逆の答えを
  // 返していた。** **`ADR-0410` 限定22(「本体と生成物の答えを割らない」)と台帳
  // `AC-G26` がまさにこれを禁じている。**
  //
  // **旧(`V17-M1-T01f` 時点。逐語。1文字も消していない)**:
  //   `sha256: "e3a9b34fd1670c5ce6a31ab4be4e30b340321b4f20a179a6501e6bd6007576f7"` /
  //   `bytes: 287307`。
  //
  // **`exports` は 91 のまま**(**増えた名前・減った名前・改名は0**)—— **足したのは
  // 関数の中の局所変数1本と注釈だけであり、新しい判定値も新しい引数キーも0本である。**
  // **今回も更新前に実際に赤を見た** —— `Expected: 287307` / `Received: 289695`
  // (**赤くなったのは「1バイトも変わっていない」の側1本だけで、export 集合の側は
  // 緑のままだった**)。
  // **値は失敗出力から写さず、`shasum -a 256 src/server/owner-scope.ts`
  // (→ `4829b44ddbb6b5b44090bfaa7de0712ecb896647234ebd263dc38b26d18c8f1b`)と
  // `wc -c < src/server/owner-scope.ts`(→ `289695`)を自分で打って確かめた。**
  //
  // **手続き**: **直上と同じく `ADR-0410` 限定8 →`ADR-0053` 限定4 の手続きである。**
  //
  // **【正直に。テスト名を改名していない】** —— **下の2本のテスト名は今日も
  // `… 最後に更新した基準(V17-M1-T01f)…` のままであり、実物(最後に更新したのは
  // `V17-M1-T01g`)と1タスクぶんずれている。** **改名しなかったのは、直下の注記が
  // 「`ADR-0402` 限定9(`0402:153`)の測る式は今日 `V17-M1-T01f` である」と書いた
  // ばかりであり、同じ日に2度動かすとそのずれの記録まで偽になるからである。**
  // **見ているもの(`bytes` / `sha256` / `exports`)は1バイトも変えておらず、検査は
  // 1本も消えていない・`.skip` にしていない・緩めていない**(限定9 が守らせたいこと)。
  // =====================================================================================
  // **【同日3度目の更新。`V17-M1`】** **上の直しの直後に、`tools/standalone-scope.test.ts` の
  // `(standalone4)`(**この単位に隣の単位の綴りを1文字も書かない**)が赤くなった ——
  // **直前に足した注釈が、隣の単位のファイルの綴りを1件書いていたためである。**
  // **注釈を言い換えただけで、コードは1バイトも動かしていない。**
  // **直前の値(逐語。1バイトも消していない)**:
  //   `sha256: "4829b44ddbb6b5b44090bfaa7de0712ecb896647234ebd263dc38b26d18c8f1b"` /
  //   `bytes: 289695`。
  // **赤は今日も byte/sha の側1本だけで、export 集合の側は緑のままだった。**
  // **値は自分で `shasum -a 256` と `wc -c` を打ち直して採った(赤の出力から写していない)。**
  // =====================================================================================
  // **【`V17-M2-T06c`(台帳 `AC-G8`。`ADR-0411`)による更新。2026-09-07。
  //    直上の注記も旧値も1バイトも消していない】**
  //
  // **【通し番号を新しく振らない】** —— **理由は上に書いたとおりである**(本ファイルの
  // 通し番号は2系統あり既に食い違っている。揃えるには旧文を書き換えるしかない)。
  //
  // **変更の中身(1文)**: **`judgeCreateParentAccess` が、親の参照を**別の親へ付け替える**
  // 更新について、新しい親だけでなく**移す前の親**にも `write` を要求するようになった**
  // (`V17-M2-T06b` / 台帳 `AC-G8` / `ADR-0411` §Decision の 3)。
  //
  // **【なぜ直したか】** —— **着手前の実測(実地データの複製・本物のサーバ)で、
  // 「自分が書けないプロジェクトの課題を、自分が書けるプロジェクトへ移す」`PATCH` が
  // **200 で通り**、移した瞬間に元のプロジェクトの人からその行が**見えなくなる**ことを
  // 再現した。** **作るときは古い親が無いので新しい親だけを見れば足りるが、
  // 付け替えるときに古い親を1度も見ていないことが穴だった。**
  //
  // **旧(直前。逐語。1文字も消していない)**:
  //   `sha256: "85b71a923dd5fd9b960048387be1f6fd19b6b7c780cdea278e41c3965c3e5cc3"` /
  //   `bytes: 289907`。
  //
  // **`exports` は 91 のまま**(**増えた名前・減った名前・改名は0**)—— **足した断りの
  // `denied_previous_parent` は**既に公開されている型 `CreateParentAccessVerdict` の
  // 枝**であり、新しい export 名にならない。** **古い親と新しい親で同じ式を共有するために
  // 切り出したヘルパ(`resolveParentRowWriteAccess`)は**非公開**である**
  // (`ADR-0411` 限定2「判定の式を2本に増やさない」の履行)。
  // **今回も更新前に実際に赤を見た** —— `Expected: 289907` / `Received: 301661`
  // (**赤くなったのは「1バイトも変わっていない」の側1本だけで、export 集合の側は
  // 緑のままだった。** **限定表が予告していた `R2` は発火しなかった**)。
  // **値は失敗出力から写さず、`shasum -a 256 src/server/owner-scope.ts`
  // (→ `543a520e3f51635b9a30c0a90e84977e2aec31f9027c80b661f3584c707902e7`)と
  // `wc -c < src/server/owner-scope.ts`(→ `301661`)を自分で打って確かめた。**
  //
  // **手続き**: **`ADR-0053` 限定4(`0053:159`)が定める手続きである。**
  // **`docs/plan/v3/records/v3-m3.md` §0-3 と同限定4 の本文を **2026-09-07 に実読**してから
  // 更新した**(`V17-M1-T01f` / `V17-M1-T01g` と同じ踏み方)。
  // =====================================================================================
  // **【`V17-M2-T04c`(台帳 `AC-G7a`。`ADR-0411`)による更新。2026-09-07。
  //    直上の注記も、その上の全部の注記も、旧値も1バイトも消していない】**
  //
  // **【通し番号を新しく振らない】** —— **理由は上に書いたとおりである。**
  //
  // **変更の中身(1文)**: **コードは1バイトも動かしていない。** **散文だけを足した** ——
  // **`judgeCreateParentAccess` の節が今日も名指ししている「**MCP / 受信口 / ワークフロー /
  // 島は素通りする**」(節の冒頭の 2 と、`V15-M8` の訂正の c)が、行を**作る**側については
  // 今日は偽になったので、旧文を1バイトも消さずに訂正を足した**(`ADR-0316` 限定1)。
  //
  // **【なぜ直したか】** —— **`V17-M2-T01b` / `T02b` / `T03b` が、作成の関門を
  // MCP・受信口・ワークフロー・島の4本の入口に配線した。** **この節の散文はその前に
  // 書かれたもので、今日は「4本とも素通りする」と主張し続けていた** ——
  // **この古びを撃つ検査は今日1本も無い**(既知の躓き
  // `verbatim-residue-fools-source-scanning-tests` と同じ型である)。
  //
  // **旧(直前。逐語。1文字も消していない)**:
  //   `sha256: "543a520e3f51635b9a30c0a90e84977e2aec31f9027c80b661f3584c707902e7"` /
  //   `bytes: 301661`。
  //
  // **`exports` は 91 のまま**(**増えた名前・減った名前・改名は0**)——
  // **足したのは行コメントだけであり、`export` の綴りを1つも書いていない。**
  // **今回も更新前に実際に赤を見た** —— `Expected: 301661` / `Received: 303295`
  // (**その後に同じブロックへ5行足したので、確定値は下の 303634 である。**
  //  **赤くなったのは「1バイトも変わっていない」の側1本だけで、export 集合の側は
  //  緑のままだった**)。
  // **値は失敗出力から写さず、`shasum -a 256 src/server/owner-scope.ts`
  // (→ `9accc0b4269be5c50342086eb060a1a82f5b0ef3b3c2c04dc3165927be220538`)と
  // `wc -c < src/server/owner-scope.ts`(→ `303634`)を自分で打って確かめた。**
  //
  // **手続き**: **`ADR-0053` 限定4(`0053:159`)が定める手続きである。**
  // =====================================================================================
  // **【`V17-M5-T07`(この段の凍結面のまとめ打ち直し)による更新。2026-09-08。
  //    直上の注記も、その上の全部の注記も、旧値も1バイトも消していない】**
  //
  // **【通し番号を新しく振らない】** —— **理由は上に書いたとおりである。**
  //
  // **【1度にまとめて打ち直した理由。先に書く】** —— **この段(`V17-M5`)で
  // `src/server/owner-scope.ts` を触った単位は `V17-M5-T02b`(台帳 `AC-G6`)と
  // `V17-M5-T03d`(台帳 `AC-G10` / `ADR-0412`)の**2つ**である。**
  // **この基準は「1バイトでも変われば赤」であり、先に打ち直すと後の単位でもう一度ずれる** ——
  // **そこで段の計画(`docs/plan/v17/06-v17-m5-plan.md` の `T07` / 罠4)が、打ち直しを
  // **段の最後の1回**に寄せた。** **したがって下の3値は2単位ぶんの差分を合わせたもので
  // あり、どちらか一方だけの姿ではない。** **【誇張しない】「1単位が 7,883 バイト
  // 動かした」とは読めない。**
  //
  // **変更の中身(2件。単位ごとに1文)**:
  //  1. **`V17-M5-T02b` / `AC-G6`** —— **`grantedPermissionNamesForCreate` が、付与行に
  //     書かれた権限名のうち**その段の表(親の表)の `access_control.permissions[]` が
  //     今日も宣言しているもの**だけを数えるようになった。** **宣言から消えた権限名の
  //     残骸が `creatable_by` の門を開けていたのを止めた**(着手前の実測は 201 であり、
  //     着手後は 403 である)。 **`resolveGrantedPermissionNames` は1バイトも
  //     触っていない** —— **絞りは `…ForCreate` の側だけに入っている。**
  //  2. **`V17-M5-T03d` / `AC-G10`** —— **親を持たない表に「行を作れる立場」を書く
  //     9キー目(`creatable_by_roles`)の関門 `judgeRootCreatableRoles` を**1本**足した。**
  //     **効くのは HTTP の作成2経路(単件 `POST` / まとめ書きの `create` op)だけであり、
  //     **MCP・受信口・自動処理・島・時刻起動は今日も素通りする**(`ADR-0412` 限定7)。
  //     **【禁止】「全部の経路で作成の壁が立つ」と書かない。**
  //
  // **旧(直前。逐語。1文字も消していない)**:
  //   `sha256: "9accc0b4269be5c50342086eb060a1a82f5b0ef3b3c2c04dc3165927be220538"` /
  //   `bytes: 303634`。
  //
  // **`exports` は 91 → 92**(**増えたのは `judgeRootCreatableRoles` の1名。
  // 減った名前・改名は0**)。 **下の期待配列にも同じ1名だけを足してある。**
  // **`V17-M5-T02b` は export 名を1つも動かしていない** —— **あちらが足した断りの
  // `missing_named_permission` は**既に公開されている型 `CreateParentAccessVerdict` の
  // 枝**であり、新しい export 名にならない**(`V17-M2-T06c` の `denied_previous_parent`
  // と同じ形である)。
  //
  // **今回も更新前に実際に赤を見た**(`ADR-0053` 限定4 の手続き)——
  // **`cd apps/smailtalk && bun test` の実出力で、赤は次の**2本ちょうど**であった
  // (9821 pass / 1 skip / 2 fail / 79490 expect() calls / Ran 9824 tests across 463 files)**:
  //   `(fail) (c) src/server/owner-scope.ts が最後に更新した基準(V17-M2-T06c)から1バイトも
  //    変わっていない` … `Expected: 303634` / `Received: 311517`
  //   `(fail) (c) src/server/owner-scope.ts の export の集合が最後に更新した基準
  //    (V17-M2-T06c)と一致する` … `+ "judgeRootCreatableRoles"`
  // **【直前の2回との違いを書く】** **`V17-M2-T06c` と `V17-M2-T04c` は
  // 「1バイトも変わっていない」の側1本だけが赤だったが、今回は
  // **export 集合の側も赤くなった**(公開名が1つ増えたためである)。**
  // **値は失敗出力から1文字も写していない** —— **`shasum -a 256 src/server/owner-scope.ts`
  // (→ `07fd10f4eca645ff76d3691b129fb28217a5120b2d092606ee084b21aefdd024`)/
  // `wc -c < src/server/owner-scope.ts`(→ `311517`)/
  // `grep -cE '^export (const|function|type) ' src/server/owner-scope.ts`(→ `92`)を
  // 自分で打って確かめた。**
  //
  // **【この更新がしていないこと。先に書く(憲法6)】**
  //  - **見ているもの(`bytes` / `sha256` / `exports`)を1つも減らしていない。**
  //    **検査は1本も消えておらず、`.skip` にもしていない・条件も緩めていない**
  //    (`ADR-0402` 限定9 が守らせたいこと)。
  //  - **テスト名を1文字も書き換えていない** —— **したがって下の2本の名前は今日も
  //    `V17-M2-T06c` を指しており、実物を固定した単位(`V17-M5-T07`)とずれる。**
  //    **改名の手続き(`ADR-0053` 限定4 の (b))は `V8-M10-T02` / `V17-M1-T01f` /
  //    `V17-M2-T06c` の3度踏まれているが、今回は踏まない** —— **本担当の射程は
  //    凍結面の打ち直しだけであり、名前を動かすと `ADR-0402` 限定9 が引く逐語が
  //    また当たらなくなるからである。** **ずれをここに書き残す**:
  //    **`0402:153` の逐語は今日も「`… 最後に更新した基準(V8-M10-T02)…`」のままで
  //    実際のテスト名(`… (V17-M2-T06c)…`)と当たらず、その実物は
  //    `V17-M5-T07` が固定した姿である**(**ずれは2段ある**)。
  //  - **`judgeRecordAccess` の引数を1本も増やしていない**(引数キーは今日も6本ちょうど。
  //    `ADR-0412` 限定6 / `ADR-0294` 限定5 / `ADR-0308` 限定1)。
  //  - **`combineRoleAndGrantAccess` / `roleGateBlocksWithoutGrants` の本体を1バイトも
  //    触っていない**(`ADR-0412` 限定5 / `ADR-0308` 限定3)。 **`OR` を `AND` に
  //    戻していない。**
  //  - **`judgeCreateParentAccess` の呼び出しを1箇所も増やしていない**
  //    (`access-control-limit-honesty.test.ts` の `(E-5)` は今日も**7箇所ちょうど**である)。
  //  - **予約規約フィールドは5本のままである**(この段が足した本数 = 0本)。
  //  - **本ファイル経由で `src/kernel/` と `schemas/` に差分を1バイトも出していない**
  //    —— **この段が `src/kernel/` と `schemas/` に入れた差分は別の単位のものであり、
  //    それを許した ADR は `ADR-0412` / `ADR-0422` / `ADR-0423` である。**
  //
  // **手続き**: **`ADR-0053` 限定4(`0053:159`)が定める手続きである。**
  // **同限定4 の本文と `docs/plan/v3/records/v3-m3.md` §0-3 を **2026-09-08 に実読**して
  // から更新した**(`V17-M1-T01f` / `V17-M1-T01g` / `V17-M2-T06c` と同じ踏み方)。
  // =====================================================================================
  // **【`V17-M6-T06a'`(この段の凍結面のまとめ打ち直し)による更新。2026-09-08。
  //    直上の注記も、その上の全部の注記も、旧値も1バイトも消していない】**
  //
  // **【通し番号を新しく振らない】** —— **理由は上に書いたとおりである。**
  //
  // **【1度にまとめて打ち直した理由。先に書く】** —— **この段(`V17-M6`)で
  // `src/server/owner-scope.ts` を触った単位は**4つ**である**(`git show --numstat` を
  // 単位ごとに打った実測):
  //   `V17-M6-T01b`(台帳 `AC-G22`。`ADR-0424`)           …… `+56 / −0`
  //   `V17-M6-T04b`(台帳 `AC-G24`。口を1本置いた側)       …… `+237 / −0`
  //   `V17-M6-T05b`(台帳 `AC-G30b`)                       …… `+81 / −1`
  //   `V17-M6-T05d`(台帳 `AC-G30b`。doc の訂正だけ)       …… `+33 / −0`
  //   合計 …… `+407 / −1`(`git diff --numstat 3f37c002 HEAD --` の実測)
  // **この基準は「1バイトでも変われば赤」であり、先に打ち直すと後の単位でもう一度ずれる** ——
  // **そこで段の計画(`docs/plan/v17/07-v17-m6-plan.md` の §5 の理由1 / §7 の罠1)が、
  // 打ち直しを**段の最後の1回**に寄せた。** **したがって下の3値は4単位ぶんの差分を
  // 合わせたものであり、どれか一つだけの姿ではない。**
  // **【誇張しない】「1単位が 22,848 バイト動かした」とは読めない。**
  //
  // **変更の中身(4件。単位ごとに1文)**:
  //  1. **`V17-M6-T01b` / `AC-G22`** —— **親の行が消えている枝(関門 (5)
  //     `judgeGrantParentAccess` の中の `parentRow === undefined`)について、
  //     **運営だけ**が越えられるようにした。** **着手前は相手が誰でも 403 だったので、
  //     親を消したあとに取り残された子の行に付与を1件も作れなかった。**
  //     **`judgeGrantWrite` の本体は1バイトも書き換えていない**(`ADR-0402` 限定19)——
  //     **関門 (2) が計算した値を引数で渡している**(`GRANT_WRITE_ADMIN_ROLES` の
  //     `grep -c` は今日も **6** のままである = `ADR-0422` 限定7)。
  //  2. **`V17-M6-T04b` / `AC-G24`** —— **「どの付与行が効いて `read` / `write` /
  //     `delete` が真になったか」を返す読取専用の判定を1本足した。**
  //     **一覧・単票の応答の `access` は今日も4キーちょうどであり、`blockedBy` を
  //     1バイトも載せていない**(`ADR-0402` 限定2)。 **MCP の道具は 26本のままである。**
  //  3. **`V17-M6-T05b` / `AC-G30b`** —— **`rowGrantWriteJudge` の関門 (2) だけを
  //     引き継ぎ(`inherit_from`)に沿って辿らせた。** **親から引き継いで作成者相当の
  //     権限を持つ人の `grant_write` が `false` になっていたのを直した。**
  //     **関門を1本も足していない**(`ADR-0402:252` の再審査条件3 は発火していない)。
  //     **【誇張しない】「表示と実際が一致した」とは書けない** —— **引き継ぎだけで
  //     届いている人は、`grant_write: true` の行でも `POST` が 404 になる**(実測)。
  //  4. **`V17-M6-T05d` / `AC-G30b`** —— **コードは1バイトも動かしていない。**
  //     **「引き継ぎを1段も辿らない」と書いていた散文に、旧文を1バイトも消さずに
  //     訂正を足しただけである**(`ADR-0316` 限定1)。
  //
  // **旧(直前。逐語。1文字も消していない)**:
  //   `sha256: "07fd10f4eca645ff76d3691b129fb28217a5120b2d092606ee084b21aefdd024"` /
  //   `bytes: 311517`。
  //
  // **`exports` は 92 → 95**(**増えた3名を名指しする。減った名前・改名は0**):
  //   `"RecordAccessSourceEntry"` / `"RecordAccessSourcesResolution"` /
  //   `"resolveRecordAccessSources"`
  // **3名とも `V17-M6-T04b` が足したものである** —— **`T01b` / `T05b` / `T05d` は
  // `export` の綴りを1つも動かしていない**(`T01b` が `judgeGrantParentAccess` に足した
  // 引数 `adminRecovery` は公開名にならず、`T05b` が辿らせた関門 (2) も
  // 既存の非公開のヘルパの中である)。 **下の期待配列にも同じ3名だけを足してある。**
  //
  // **【2026-09-08 の訂正(独立点検の指摘 中-4)。直上の3行を1バイトも消していない】**
  // **直上が書く引数名 `adminRecovery` は、製品コードに1件も存在しない。**
  // **`T01b` が `judgeGrantParentAccess` に足したのは `role: ActorRoles` である**
  // (`src/server/owner-scope.ts` の `function judgeGrantParentAccess(params: {` の
  //  最後のキー。着手前 `3f37c002` の同じ関数には `readRow` までしか無い)。
  // **`adminRecovery` は計画が書いていた名前であり、実装は採らなかった** ——
  // **記録 `docs/plan/v17/records/v17-m6.md` §1-2 の【計画の指示に従えなかった1点】が
  //   「計画の `adminRecovery` を渡す形は限定5 と両立しないので `role` を渡した」と
  //   書いているのに、このコメントだけが計画の名前のまま残った。**
  // **【この型を名指しする】引数名は公開名ではないので、下の `exports` の集合も
  //   `sha256` の凍結も1ミリも赤くならない** —— **赤くならずにコメントだけが嘘になる。**
  //   **このリポジトリでは3度目である**(躓き `verbatim-residue-fools-source-scanning-tests`)。
  // **上の結論(この段で増えた公開名は3名ちょうど)は動かない** ——
  //   **`role` も公開名ではないからである。**
  //
  // **今回も更新前に実際に赤を見た**(`ADR-0053` 限定4 の手続き)——
  // **`cd apps/smailtalk && bun test web/test/shell-navigation-boundary.test.ts
  //   -t "owner-scope.ts"` の実出力で、赤は次の**2本ちょうど**であった
  // (0 pass / 2 filtered out / 2 fail / 2 expect() calls / Ran 2 tests across 1 file)**:
  //   `(fail) (c) src/server/owner-scope.ts が最後に更新した基準(V17-M2-T06c)から1バイトも
  //    変わっていない` … `Expected: 311517` / `Received: 334365`
  //   `(fail) (c) src/server/owner-scope.ts の export の集合が最後に更新した基準
  //    (V17-M2-T06c)と一致する` … `+ "RecordAccessSourceEntry"` /
  //    `+ "RecordAccessSourcesResolution"` / `+ "resolveRecordAccessSources"`
  //    (`- Expected - 0` / `+ Received + 3`)
  // **`V17-M5-T07` と同じく、今回も export 集合の側も赤くなった**(公開名が3つ増えたためである)。
  //
  // **【`114` という数を1度も使っていない。先に書く】** —— **この配列には作法どおり
  // コメントアウトされた旧名が残っており、引用符つきの文字列を全部数えると 114 になるが、
  // **検査が当てるのは `/^export (?:const|function|type) ([A-Za-z_][A-Za-z0-9_]*)/gm` の
  // 一致であって、コメント行は1件も見ていない。** **今日の正は 92 → 95 である**
  // (段の計画 §0-2 の指摘 `H-1`)。
  //
  // **値は失敗出力から1文字も写していない** —— **`shasum -a 256 src/server/owner-scope.ts`
  // (→ `14d9cf782f3660972c2bbdd3eb8072b684e1ea5dbb39dd4c1e367b7c2eee716c`)/
  // `wc -c < src/server/owner-scope.ts`(→ `334365`)/
  // `grep -cE '^export (const|function|type) ' src/server/owner-scope.ts`(→ `95`)を
  // 自分で打って確かめた。**
  //
  // **【この更新がしていないこと】** —— **見ているもの(`bytes` / `sha256` / `exports`)を
  // 1つも減らしていない。** **検査は1本も消しておらず、`.skip` にもしていない・
  // 条件も緩めていない**(`ADR-0402` 限定9)。 **テスト名も1文字も書き換えていない** ——
  // **したがって下の2本の名前は今日も `V17-M2-T06c` を指しており、実物を固定した単位
  // (`V17-M6-T06a'`)とずれる。** **ずれは3段になった**(`0402:153` の逐語は今日も
  // 「`… 最後に更新した基準(V8-M10-T02)…`」である)。
  //
  // **手続き**: **`ADR-0053` 限定4(`0053:159`)が定める手続きである。**
  // **同限定4 の本文と `docs/plan/v3/records/v3-m3.md` §0-3 を **2026-09-08 に実読**して
  // から更新した**(`V17-M1-T01f` / `V17-M1-T01g` / `V17-M2-T06c` / `V17-M5-T07` と同じ踏み方)。
  // =====================================================================================
  // **【`V17-M10B-T06`(2026-09-10)による更新。旧値を1バイトも消していない】**
  // **旧: `sha256: "14d9cf782f3660972c2bbdd3eb8072b684e1ea5dbb39dd4c1e367b7c2eee716c"` /
  //        `bytes: 334365`。** **`exports` は **95 のまま**である**(**増減も改名も0件。
  //        したがって下の期待配列は1行も書き換えていない**)。
  //
  // **根拠**: **`ADR-0429` §Decision 2 の (2)(3) と `ADR-0430` §Decision の 2 / 4 / 5 /
  // 7(授権の表。逐語「**和集合の1段目の置き換え + 関門1本 + 段どうしの合成への上限の適用。
  // 合成の関数の本体は **896バイト** のまま**」)。** **ユーザ決定は `D-V17-I` /
  // `D-V17-K` / `D-V17-L` / `D-V17-M` の4件である。**
  //
  // **変更の中身は3つである**:
  //  1. **点の答えを「和集合 → 上限との交わり」の2段にした** ——
  //     **`点の答え = ( ∪ **すべての**付与 ) ∩ ( ∩ 符号を持つ付与 )`。**
  //     **1段目に符号つきの付与も入る**(`D-V17-L`)。 **判定の本体を
  //     `recordAccessStages`(**非公開**)へ切り出し、公開の判定はそれを関門に通す
  //     薄い包みにした。** **引数キーは6本のまま / 戻り値は3キーのままである。**
  //  2. **前提の関門を1本足した**(**非公開**)—— **面と点の合成の**外側**に置いた。**
  //     **`combineRoleAndGrantAccess` の本体は **896バイト** のまま1バイトも変えていない**
  //     (`ADR-0430` 限定17)。 **`OR` を `AND` に戻していない。**
  //  3. **段どうしの合成にも上限を掛けた**(`ADR-0430` (δ))—— **1段目は `OR`、2段目は
  //     `AND` で重ね、**辿り終えてから**関門を1度だけ掛ける。** **段0 に書いた上限が
  //     親の段の強い付与で足し戻されない。**
  //
  // **【この更新がしていないこと。先に書く(憲法6)】**
  //  - **`AccessLayerName` は2値のまま**(`"role"` / `"grant"`)。 **上限で止まったときも
  //    `"grant"` を名乗る**(`ADR-0308` 限定8 / `ADR-0429` 限定10)。
  //  - **公開している名前を1本も増やしていない**(**`exports` は 95 のまま**)。
  //  - **`schemas/` と `src/kernel/` に本ファイル経由の差分は1バイトも無い**
  //    (`T06b` / `T06c` が済ませている)。
  //  - **段数5・件数1000 の上限を1つも動かしていない**(`ADR-0298` 限定22)。
  //  - **403 の文面を1バイトも足していない・消していない**(`ADR-0305` 限定5)——
  //    **上限で止まった行は、今日どおり見えない行と同じ応答になる。**
  //  - **付与を「作ってよいか」の判定に上限を1バイトも掛けていない。**
  //
  // **手続きは前回までと同じものを踏んだ** —— **更新前に実際に赤を見てから**更新した
  // (実測の逐語: `Expected: 334365` / `Received: 345647`)。
  // =====================================================================================
  //
  // =====================================================================================
  // **【2026-09-11 追記(`V18-M2-T04`。`PM-G8` / `PM-G11` / `ADR-0437` §Decision 2 の行9)。
  // 直下の2つの期待値を打ち直した。旧文を1バイトも消していない】**
  //
  //     旧: sha256: "a9e646a9daac07cd7cd014c03a9d5d26ae8be1e5cf11f7ed83ca7075dbe04934",
  //     新: sha256: "7e87028d88c51c601d832dea6f6a4e48b47fc14c6832f8d8624828e6d80b0f06",
  //     旧: bytes: 345647,
  //     新: bytes: 350062,
  //
  // **なぜ期待値の側が今日の正でなくなったか** —— **`owner-scope.ts` の
  // `combineRoleAndGrantAccess` に、読取の面の絞り(`faceCarries`)と
  // 運営者の例外(`UNCONDITIONAL_READ_BYPASS_ROLES`。ユーザ決定 `D-V18-18`)を書いたため、
  // ファイル全体のバイト数とダイジェストが動いた。** **この打ち直しは
  // `ADR-0437` §Decision 2 の行9 が名指しで授権している** ——
  // **許されているのは `sha256` と `bytes` の2つの期待値を打ち直すことだけである。**
  //
  // **【1バイトも動かしていない側】** **下の `exports` の配列は1名も増減・改名していない
  // (今日も **95**。`ADR-0437` 限定2)。** **撃つ検査(`:2452` と `:2458` の2本)も
  // 1本も消していない。** **同ファイルの他の凍結には1バイトも触っていない。**
  // **手続きは前回までと同じものを踏んだ** —— **更新前に実際に赤を見てから**更新した
  // (実測の逐語: `Expected: 345647` / `Received: 350062`)。
  // =====================================================================================
  //
  // =====================================================================================
  // **【2026-09-11 追記(同日2度目。`V18-M2-T10`。ユーザ決定 `D-V18-19` /
  // `ADR-0438` 行13)。直下の2つの期待値を**2度目に**打ち直した。
  // 旧文を1バイトも消していない】**
  //
  //     旧(1度目の打ち直しの値): sha256: "7e87028d88c51c601d832dea6f6a4e48b47fc14c6832f8d8624828e6d80b0f06",
  //     新: sha256: "a2cc93f0b49dbd479abcf95d102e1dd254086932e4e943c4c5c09bae6dfcbe5b",
  //     旧(1度目の打ち直しの値): bytes: 350062,
  //     新: bytes: 353386,
  //
  // **なぜ期待値の側が今日の正でなくなったか** —— **`judgeRoleAccess` の戻り値
  // (`RoleAccessDecision`)に旗 `unconditionalAllow` を1つ足し、`faceCarries` の
  // 条件をその旗へ差し替えたためである**(`D-V18-19`。**当たらない条件つきの規則を
  // 1本足すだけで狭めが外れる形を塞いだ**)。 **旧の逐語と理由をコメントとして
  // 本体の直上に残したぶんも、バイト数に入っている。**
  // **この2度目の打ち直しは `ADR-0438` 行13 が名指しで授権している**
  // (**「`ADR-0437` 行9 の授権は1回限りではない」**)。
  //
  // **【1バイトも動かしていない側】** **下の `exports` の配列は1名も増減・改名していない
  // (今日も **95**。`ADR-0438` 限定1)。** **`export type RoleAccessDecision` に
  // 項目を1つ足したが、`export` の**名前**は1つも増えていない。**
  // **撃つ検査(`(b)` と `(c)` の2本)も1本も消していない。**
  // **手続きは前回までと同じものを踏んだ** —— **更新前に実際に赤を見てから**更新した
  // (実測の逐語: `Expected: 350062` / `Received: 353386`)。
  // =====================================================================================
  //
  // =====================================================================================
  // **【2026-09-12 追記(`V18-M3-T02`。`PM-G6` / `ADR-0435` / `ADR-0439` §Status 5)。
  // 直下の2つの期待値を**3度目に**打ち直した。旧文を1バイトも消していない】**
  //
  //     旧(2度目の打ち直しの値): sha256: "a2cc93f0b49dbd479abcf95d102e1dd254086932e4e943c4c5c09bae6dfcbe5b",
  //     新: sha256: "0a8544b6d357863f8b5aa83151dc33d5bc194028a61fe4c8ce730d7e1c1fc2d4",
  //     旧(2度目の打ち直しの値): bytes: 353386,
  //     新: bytes: 366751,
  //
  // **なぜ期待値の側が今日の正でなくなったか** —— **名簿表・グループ表・付与表の読取に
  // 判定を掛けたためである**(`PM-G6`。ユーザ決定 `D-V18-21`)。 **母集団の分類
  // (`RecordPopulationScope`)に枝 `"access_registry"` を1本足し、
  // `judgeRecordPopulation` にその枝を足し、行の可視集合を組む**非公開**の関数を
  // 1本足した。** **旧の逐語と理由をコメントとして本体の直上に残したぶんも、
  // バイト数に入っている。**
  //
  // **この3度目の打ち直しは `ADR-0439` §Status 5 が名指しで授権している**
  // (**`ADR-0435` の授権の表にはこの検査ファイルの行が1行も無いので、同格の個別 ADR で
  // 授権した**)。
  //
  // **【1バイトも動かしていない側】** **下の `exports` の配列は1名も増減・改名していない
  // (今日も **95**)。** **`ADR-0439` §Status 6 が `exports` の書き換えを1ミリも
  // 授権していない** —— **足した関数はすべて**非 export** である
  // (`ADR-0437:118` が示した唯一の逃げ道)。 **`export type RecordPopulationScope` の
  // ユニオンに枝を1本足したが、`export` の**名前**は1つも増えていない。**
  // **撃つ検査(`(b)` と `(c)` の2本)も1本も消していない・`.skip` にしていない。**
  // **手続きは前回までと同じものを踏んだ** —— **更新前に実際に赤を見てから**更新した
  // (実測の逐語: `Expected: 353386` / `Received: 366751`)。
  // =====================================================================================
  // =====================================================================================
  // **【2026-09-12 追記(`V18-M3-T02d`。`PM-G6` / `ADR-0439` 授権の表 行7 / 行8)。
  // 直下の2つの期待値を**4度目に**打ち直した。旧文を1バイトも消していない】**
  //
  //     旧(3度目の打ち直しの値): sha256: "0a8544b6d357863f8b5aa83151dc33d5bc194028a61fe4c8ce730d7e1c1fc2d4",
  //     新: sha256: "fd71c327f51762b8235e50938aa1c973a455aaf00d4d50ec4149db9783d242a8",
  //     旧(3度目の打ち直しの値): bytes: 366751,
  //     新: bytes: 368133,
  //
  // **なぜ期待値の側が今日の正でなくなったか** —— **`V18-M3-T02` が足した
  // `accessRegistryVisibleIds` の中の鍵の組み立てが、区切りに**生の NUL バイト**
  // (U+0000)を使っていたためである。** **`tools/no-nul-bytes.test.ts`
  // (「git が把握しているテキストファイルは生の NUL バイトを含まない」)が赤くなり、
  // 実 CI も赤くなっていた。** **副作用として `git diff` を `grep` に流すと
  // 「Binary file matches」になり、数え方を誤らせていた。**
  // **区切りを `:` に替えた**(`src/kernel/workflow-runner.ts:408` が同じ組
  // (表 ID + 行の `_id`)に先に使っている綴りに揃えた)。 **表 ID の値域
  // `^(_apps|_changelog|[a-z][a-z0-9_-]*)$` が `:` を1文字も通さないので、
  // 鍵の衝突は起こり得ない —— 答えは1ビットも変わらない。**
  // **旧の1行の逐語(NUL は `<NUL>` と説明で示した)と理由をコメントとして
  // 本体の直上に残したぶんも、バイト数に入っている。**
  //
  // **【1バイトも動かしていない側】** **下の `exports` の配列は1名も増減・改名していない
  // (今日も **95**)。** **`ADR-0439` 授権の表 行9 が `exports` の打ち直しを
  // 「授権しない」と明記しており、本葉はそれを1ミリも緩めていない。**
  // **撃つ検査(`(b)` と `(c)` の2本)も1本も消していない・`.skip` にしていない。**
  // **手続きは前回までと同じものを踏んだ** —— **更新前に実際に赤を見てから**更新した
  // (実測の逐語: `Expected: 366751` / `Received: 368133`)。
  //
  // **【正直に書く】`ADR-0439` 授権の表 行7 / 行8 の第2列は「**3度目に**打ち直すこと
  // だけ」と書いており、第4列の実装する葉は **`V18-M3-T02`** である。**
  // **本葉 `V18-M3-T02d` はその `V18-M3-T02` が自ら持ち込んだ NUL を取り除く
  // 是正の子葉であり、同じ授権の射程の中に居ると読んで打ち直した。**
  // **`ADR-0439` の本文は1バイトも書き換えていない。**
  //
  // =====================================================================================
  // **【`V18-M4-T02`(`PM-G10` / `ADR-0435` / `ADR-0441` 授権の表 行26)。
  //   **5度目**の打ち直し。上の注記を1バイトも書き換えていない】**
  // =====================================================================================
  //
  // **旧(4度目の打ち直しの値)の逐語**:
  //     sha256: "fd71c327f51762b8235e50938aa1c973a455aaf00d4d50ec4149db9783d242a8",
  //     bytes: 368133,
  //
  // **なぜ期待値の側が今日の正でなくなったか** —— **`V18-M4-T02` が
  // `src/server/owner-scope.ts` に「画面名を名乗らない読取の壁」の述語
  // (`unnamedViewReadWallCloses`。**非 `export`**)と、母集団の分類の枝
  // (`"unnamed_view_wall"`)を足したためである。**
  // **塞いだのは元番号27 = 「この画面は見せない」と決めた相手が `?view=` を名乗らずに
  // 表の口を直接叩くと同じ行が全件返る件**(`ADR-0435` §Decision 2 の 2)。
  // **【禁止】これを「画面を隠した」と読まない** —— **隠れるのは行であって、画面の定義
  // ではない**(`ADR-0435` §Status 4)。 **【禁止】「安全になった」と書かない。**
  //
  // **【1バイトも動かしていない側】** **下の `exports` の配列は1名も増減・改名していない
  // (今日も **95**)。** **`ADR-0441` 授権の表 行27 が `exports` の打ち直しを
  // 「授権しない」と明記しており、本葉はそれを1ミリも緩めていない** ——
  // **足した述語と型は `ADR-0437:118` の逃げ道(非 `export` なら赤くならない)に載せた。**
  // **撃つ検査(`(b)` と `(c)` の2本)も1本も消していない・`.skip` にしていない。**
  //
  // **手続きは前回までと同じものを踏んだ** —— **更新前に実際に赤を見てから**更新した
  // (実測の逐語: `Expected: 368133` / `Received: 375954`)。
  //
  // **【`ADR-0440` 授権の表 行20 が「5度目は授権しない。その時点で止めてメインに戻す」と
  // 書いていたこと】** —— **メインはそこで止まり、`V18-M4-T00` が `ADR-0441` 行26 で
  // 5度目**だけ**を授権した。** **`ADR-0441` 越えてはならない線5 の逐語「本 ADR が授権した
  // のは **5度目の1回きり** である」** —— **6度目が要るときは、その時点で止めてメインに
  // 戻す。**
  // =====================================================================================
  //
  // =====================================================================================
  // **【`V18-M4-T04b`(整形を実CIの基準に合わせる)。`ADR-0441` 追記-3 の授権。
  //   **6度目**の打ち直し。上の注記を1バイトも書き換えていない】**
  // =====================================================================================
  //
  // **旧(5度目の打ち直しの値)の逐語**:
  //     sha256: "c5e44b6c2c814bb61a8b3f6d161440cac72e75ef7d548e7cceccc9d6c2a56c3b",
  //     bytes: 375954,
  //
  // **なぜ期待値の側が今日の正でなくなったか** —— **本葉が `apps/smailtalk` に
  // `biome` の整形(`bun run format` = `biome format --write .`)を当てたためである。**
  // **`owner-scope.ts` の中身を作り変えたからではない。** **動いたのは改行位置だけで、
  // 識別子は1つも増減していない**(差分の全量は **2行追加 / 5行削除**。
  // `ADR-0441` 追記-3 §1 に逐語で貼ってある)。
  //
  // **なぜ整形を当てざるを得なかったか** —— **実CI(`.github/workflows/ci.yml:310`)の
  // `Lint (apps/smailtalk)` ステップ(`bun run lint` = `biome check .`)が、
  // **本段の起点 `74f609c2`(= `main`)の時点ですでに赤であった**(`Found 10 errors.`)。**
  // **10件の内訳は 整形8 + import の並べ替え2 であり、規則違反(lint)は 0件 である**
  // (`bunx biome lint .` は errors 0 / warnings 3 / infos 7)。
  // **整形を当てないと `CP-V18` の「実CI が緑」を満たせず、当てれば本凍結が必ず動く。**
  //
  // **【1バイトも動かしていない側】** **下の `exports` の配列は1名も増減・改名していない
  // (今日も **95**)。** **`ADR-0441` §Status 8 / 追記-3 ② が `exports` の打ち直しを
  // 「授権しない」と明記しており、本葉はそれを1ミリも緩めていない。**
  // **撃つ検査(`(b)` と `(c)` の2本)も1本も消していない・`.skip` にしていない。**
  //
  // **手続きは前回までと同じものを踏んだ** —— **更新前に実際に赤を見てから**更新した
  // (実測の逐語: `Expected: 375954` / `Received: 375938`)。
  //
  // **【最重】これ以上(7度目)は授権されていない** —— **`ADR-0441` 追記-3 §4 の逐語
  // 「**本追記が授権したのは **6度目の1回きり** である**」。**
  // **7度目が要るときは、その時点で止めてメインに戻す。**
  // **【禁止】「安全になった」と書かない。**
  // =====================================================================================
  //
  // =====================================================================================
  // **【`V18-M5-T02b`(赤くなった既存の検査の回復)。`ADR-0442` 授権の表 行6 の授権。
  //   **7度目**の打ち直し。上の注記を1バイトも書き換えていない】**
  // =====================================================================================
  //
  // **旧(6度目の打ち直しの値)の逐語**:
  //     sha256: "b7df1b27afb20f5f74dde25691c866dda3296fbb654437f0887fbaa6cd7c6937",
  //     bytes: 375938,
  //
  // **新(7度目)の値**:
  //     sha256: "28c73907f6f4c10550ee678fb3c4f2d461feb27390e285319e0ec551fd27daa4",
  //     bytes: 383602,
  //
  // **なぜ期待値の側が今日の正でなくなったか** —— **`V18-M5-T01` が
  // `judgeRootCreatableRoles` の既定を反転し、判定順を入れ替え、返り値を真偽2値から
  // 3語(`"allow"` / `"not_listed"` / `"undeclared"`)へ変えたためである**
  // (`PM-G2` / `ADR-0432` §Decision / `ADR-0442` 授権の表 行1)。
  // **`owner-scope.ts` の差分は **+108 / −9**(基準 `73f676c3`)。**
  //
  // **【手続き。前回までと同じものを踏んだ】** **更新前に実際に赤を見てから**更新した
  // (実測の逐語: `Expected: 375938` / `Received: 383602`)。
  // **値は失敗出力から写していない** —— **`wc -c < src/server/owner-scope.ts` と
  // `shasum -a 256 src/server/owner-scope.ts` を自分で打って確かめた。**
  //
  // **【1バイトも動かしていない側】** **下の `exports` の配列は1名も増減・改名していない
  // (今日も **95**)。** **`ADR-0442` §Status 5 / 授権の表 行7 が `exports` の打ち直しを
  // 「授権しない」と明記しており、本葉はそれを1ミリも緩めていない** ——
  // **`V18-M5-T01` が足した型 `RootCreatableVerdict` は `ADR-0437:118` の逃げ道
  // (非 `export` なら赤くならない)に載せてある。**
  // **撃つ検査(`(b)` と `(c)` の2本)も1本も消していない・`.skip` にしていない・
  // 1ミリも緩めていない。**
  //
  // **【最重】これ以上(**8度目**)は授権されていない** —— **`ADR-0442` 授権の表 行6 が
  // 授権したのは **7度目の1回きり** である。**
  // **8度目が要るときは、その時点で止めてメインに戻す。**
  // **【この「1回きり」が続けて破られてきた事実を、隠さずここにも書く】** ——
  // **`ADR-0440` 行20 → `ADR-0441` 行26 → 同 追記-3 → `ADR-0442` 行6 と、
  // **4度**続けて「1回きり」を書いて4度とも次が来ている**(`ADR-0442` §Context 3 が
  // 同じことを自認している)。 **繰り返すこと自体を「問題ない」とは書かない。**
  // **【禁止】「安全になった」と書かない。**
  // =====================================================================================
  //
  // =====================================================================================
  // **【`V18-M6-T02b`(2026-09-13。赤くなった既存の検査の回復)の訂正。
  //   直上の注記を1バイトも書き換えていない】** **通算 **8度目** の打ち直しである。**
  // =====================================================================================
  //
  // **【直上の「8度目は授権されていない。止めてメインに戻す」への訂正】** ——
  // **その1文が書かれた時点では正しかったが、今日は `ADR-0443` 授権の表 行6 が
  // **8度目**を授権している**
  // (`docs/adr/0443-v18-m6-reparent-delete-and-two-ai-tools-authorization.md`)。
  // **すなわち「止めてメインに戻す」は踏んだ上で、メインが授権を先に用意した形である。**
  //
  // **旧(7度目の打ち直しの値)の逐語**:
  //     sha256: "28c73907f6f4c10550ee678fb3c4f2d461feb27390e285319e0ec551fd27daa4",
  //     bytes: 383602,
  //
  // **新(8度目)の値**:
  //     sha256: "2f6fd289a28f438f223669636c3f07be979a4e35b0d5d18ed5c58f4a56daa033",
  //     bytes: 388673,
  //
  // **なぜ期待値の側が今日の正でなくなったか** —— **`V18-M6-T01` が
  // `resolveParentRowWriteAccess` に `verb` を足し、**移す前の親**に要求する動詞を
  // `write` から `delete` へ上げたためである**(`PM-G1` / `ADR-0443` 授権の表 行1 / 行9)。
  //
  // **【手続き。前回までと同じものを踏んだ】** **更新前に実際に赤を見てから**更新した
  // (実測の逐語: `Expected: 383602` / `Received: 388673`)。
  // **値は失敗出力から写していない** —— **`wc -c < apps/smailtalk/src/server/owner-scope.ts` と
  // `shasum -a 256 apps/smailtalk/src/server/owner-scope.ts` を自分で打って確かめ、
  // その出力と一致することを見た上で書いた。**
  //
  // **【1バイトも動かしていない側】** **下の `exports` の配列は1名も増減・改名・打ち直しを
  // していない(今日も **95**)。** **`ADR-0443` 授権の表 行7 が `exports` の打ち直しを
  // 「授権しない」と明記しており、本葉はそれを1ミリも緩めていない。**
  // **撃つ検査(`(b)` と `(c)` の2本)も1本も消していない・`.skip` にしていない・
  // 1ミリも緩めていない。**
  //
  // **【最重】これ以上(**9度目**)は授権されていない** —— **`ADR-0443` 授権の表 行6 が
  // 授権したのは **8度目の1回きり** である。**
  // **9度目が要るときは、その時点で止めてメインに戻す。**
  // **【この「1回きり」が続けて破られてきた事実を、隠さずここにも書く】** ——
  // **`ADR-0440` 行20 → `ADR-0441` 行26 → 同 追記-3 → `ADR-0442` 行6 と **4度**続けて
  // 「1回きり」を書いて4度とも次が来ており、**本段の `ADR-0443` 行6 はその **5度目** の
  // 「1回きり」である。** **【禁止】「これで最後だ」とは書かない** ——
  // **5度目が破られない根拠を、本段は1つも持っていない。**
  // **繰り返すこと自体を「問題ない」とは書かない。**
  // **【禁止】「安全になった」と書かない。**
  // =====================================================================================
  // **【`V18-M6-T03b`(2026-09-13)の打ち直し。直上の注記を1バイトも書き換えていない】**
  // **これは**同じ段の中での2度目の計算**であり、**段としては今日も **8度目** の1回きり
  // である**(`ADR-0443` 行6 の授権の中に入っている)。 **【禁止】**9度目**と書かない。**
  // **【禁止】「これで最後だ」と断定しない。【禁止】「安全になった」と書かない。**
  // **旧の逐語は直上の注記の「新(8度目)の値」がそのまま持っている**(1バイトも消していない)。
  // **`V18-M6-T03b` が `owner-scope.ts` にコメント **22行** を足した(削除 **0行**。判定の式は
  // 1行も動いていない)ため赤くなった** —— **更新前に赤を見た**(`Expected: 388673` /
  // `Received: 390360`)。 **値は失敗出力から写さず、`wc -c` と `shasum -a 256` を自分で
  // 打って確かめた。** **`exports` は1名も触っていない(今日も **95**)。**
  // =====================================================================================
  // **【`V18-M7-T01`(2026-09-14。子を数え、消せるかを判定する述語を1本足した)の訂正。
  //   直上の注記を1バイトも書き換えていない】** **通算 **9度目** の打ち直しである。**
  // =====================================================================================
  //
  // **【直上の「これ以上(**9度目**)は授権されていない。9度目が要るときは止めてメインに
  //   戻す」への訂正】** —— **その1文が書かれた時点では正しかったが、今日は
  // **`ADR-0444` 授権の表 行11 / 行12** が **9度目**を授権している**
  // (`docs/adr/0444-v18-m7-parent-delete-cascade-authorization.md`)。
  // **行11 が `sha256` / `bytes` の2行を、行12 が `exports` を **95 → 96 ちょうど** にする
  // ことを授権している。** **97 にしない。改名・削除を1つもしていない。**
  //
  // **旧(8度目の打ち直しの値)の逐語**:
  //     sha256: "1c7c9d849b15c864d26b5a64b8dab9c72e391c62c33a31a0315773f122f6ad5c",
  //     bytes: 390360,
  //
  // **新(9度目)の値**:
  //     sha256: "d360abc733b3efdd6ccd298e9b1c644e2fe7bb5f096e1e58c69c776310fa52d6",
  //     bytes: 405901,
  //
  // **なぜ期待値の側が今日の正でなくなったか** —— **`V18-M7-T01` が
  // `resolveRecordDeleteCascade`(親にぶら下がる子をいちばん下の段まで集め、子1件ずつの
  // 削除可否を呼び出し側の判定に問う純関数)を1本足したためである**
  // (`PM-G5` / `D-V18-31` / `D-V18-32` / `ADR-0444` 授権の表 行1)。
  // **`owner-scope.ts` の差分は **+272 / −0**(基準 `a594d2ac`)。**
  //
  // **【`exports` が動いたのは、この凍結面で初めてである。理由を隠さずに書く】** ——
  // **`ADR-0441` / `ADR-0442` / `ADR-0443` は3度続けて `exports` の打ち直しを「授権しない」と
  // 落としてきた。** **覆したのは**逃げ道が実測で無かった**からである** —— **子を見つけるには
  // `access_control.inherit_from` を読むしかなく、その綴りを `src/server/` で持ってよいのは
  // `owner-scope.ts` だけである**(`access-control-localization.test.ts:149` /
  // `access-control-paths.test.ts:488` / `access-control-verbs.test.ts:806` の3本)。
  // **`ADR-0437:118` の逃げ道(新しい型を**非 `export`** にする)は関数には使えない。**
  // **【禁止】これを「行数の見積りが足りなかっただけ」と読まない**(`ADR-0444` §Status 6)。
  //
  // **【手続き。前回までと同じものを踏んだ】** **更新前に実際に赤を見てから**更新した
  // (実測の逐語: `Expected: 390360` / `Received: 405901`、および `exports` の赤に
  // `resolveRecordDeleteCascade` の1名が並んだ)。 **値は失敗出力から写していない** ——
  // **`wc -c` と `shasum -a 256` を自分で打って確かめた。**
  //
  // **【1バイトも動かしていない側】** **`combineRoleAndGrantAccess` の本体は今日も
  // **2499バイト** である**(`ADR-0444` 限定6)。 **上限の定数2本
  // (`MAX_RECORD_ACCESS_INHERIT_DEPTH` = 5 / `MAX_RECORD_ACCESS_INHERIT_ROWS` = 1000)を
  // 1も動かしていない。** **撃つ検査(`(b)` と `(c)` の2本)も1本も消していない・
  // `.skip` にしていない・1ミリも緩めていない。**
  //
  // **【最重】これ以上(**10度目**)は授権されていない** —— **`ADR-0444` 授権の表 行11 が
  // 授権したのは **9度目の1回きり** である**(同 再審査条件5)。 **10度目が要るとき、または
  // `exports` を **97** にしたくなったときは、その時点で止めてメインに戻す。**
  // **【この「1回きり」が続けて破られてきた事実を、隠さずここにも書く】** ——
  // **`ADR-0440` 行20 → `ADR-0441` 行26 → 同 追記-3 → `ADR-0442` 行6 → `ADR-0443` 行6 と
  // **5度**続けて「1回きり」を書いて5度とも次が来ており、**本段の `ADR-0444` 行11 は
  // その **6度目** の「1回きり」である。** **【禁止】「これで最後だ」とは書かない** ——
  // **6度目が破られない根拠を、本段は1つも持っていない。**
  // **【禁止】本段を「塞いだ」と書かない** —— **本段の述語は数と並びを返すだけであり、
  // 今日の削除は今日も親だけを消して子を残したままである。**
  //
  // **【`V18-M8-T03`(2026-09-16)。**10度目**の打ち直し。上の注記を1バイトも書き換えていない】**
  // **10度目は `ADR-0445` 授権の表 行7(+19)が**名指しで**授権した**(ユーザ決定 `D-V18-33`。
  // 実装する葉 `V18-M8-T03`)。 **直上の「これ以上(**10度目**)は授権されていない」は
  // `ADR-0444` 行11 の時点の正であり、本注記がその後を書く**(旧文は1バイトも消していない)。
  //
  // **旧(9度目の打ち直しの値)の逐語**:
  //     sha256: "d360abc733b3efdd6ccd298e9b1c644e2fe7bb5f096e1e58c69c776310fa52d6",
  //     bytes: 405901,
  //
  // **【焼き直しの理由。2つの葉が `owner-scope.ts` を動かした】**
  // **(1) `V18-M8-T02`(`42abadb4`)** —— **表示の述語 `rowGrantWriteJudge` を、壁の述語
  // `judgeGrantWrite` と**表示の時点で決まる面の断り**に揃えた**(`ADR-0445` §Decision 4 / 5)。
  // **差分は +258 / −65。** **壁の本体は1バイトも変えていない。**
  // **(2) `V18-M8-T02b`(`e944cb1a`)** —— **意味が変わった口の doc が偽になったので、その直後に
  // 訂正を足した**(旧文は1バイトも消していない)。 **差分は +19 / −0** —— **19行とも注釈である。**
  //
  // **【バイト数が増えた内訳。実装の行と注釈の行に分けて数えた】** —— **合計 +14,247 バイト**
  // (**405,901 → 420,148**)。 **自分で打った**(`git show <sha> -- <path>` の `+` / `-` の行から
  // 行頭の1文字を落として `wc -c`。注釈かどうかは**行頭が `//` `/*` `*` のいずれかで始まる**かで見た):
  //   - **`T02`**: 足した 258行 = **注釈 114行 = 10,326 バイト** + **実装 144行 = 4,580 バイト**。
  //     消した 65行 = **2,314 バイト**(**注釈の行は 0行** —— 消したのは式の行だけである)。
  //   - **`T02b`**: 足した 19行 = **注釈 19行 = 1,655 バイト**。 **実装は 0行 = 0 バイト。**
  //   - **足し引き**: **14,906 − 2,314 + 1,655 = 14,247**。 **注釈の側が +11,981、実装の側が
  //     4,580 − 2,314 = +2,266** である(**11,981 + 2,266 = 14,247 で閉じる**)。
  //   - **【この内訳の限界】注釈かどうかを**行頭の記号**で近似している** —— **行末に付いた注釈と、
  //     `*` で始まる式の続き行を見分けない。** **空行は「実装の行」の側に数えている。**
  //
  // **【`exports` は 1名も動いていない】** **96 のままである**(`ADR-0445` 授権の表 行8 は
  // `exports` を**授権していない**)。 **2本の式が同じ値を返すことも自分で打った** ——
  // `grep -cE '^export (const|function|type) ' src/server/owner-scope.ts` が **96**、
  // 本ファイルの `exports` の名前の数が **96**。 **赤くなったのも `bytes` の1本だけである。**
  //
  // **【手続き。前回までと同じものを踏んだ】** **更新前に実際に赤を見てから**更新した
  // (実測の逐語: `Expected: 405901` / `Received: 420148`。 **同じ `test` の中の `sha256` の
  // `expect` はその手前で落ちたので走っていない。`exports` の検査は緑のままであった** ——
  // **`3 pass / 1 fail`**)。 **値は失敗出力から1文字も写していない** —— **`wc -c` と
  // `shasum -a 256` を自分で打って確かめた**(`wc -c` の **420148** と赤の `Received` が
  // 一致したのは、別々に得た2つの値である)。
  //
  // **【最重】これ以上(**11度目**)は授権されていない** —— **`ADR-0445` が授権したのは
  // **10度目の1回きり** である**(同 再審査条件5)。 **11度目が要るとき、または `exports` を
  // **97** にしたくなったときは、その時点で止めてメインに戻す。**
  // **【この「1回きり」が続けて破られてきた事実を、数え直してここにも書く】** ——
  // **`ADR-0440` 行20 → `ADR-0441` 行26 → 同 追記-3 → `ADR-0442` 行6 → `ADR-0443` 行6 →
  // `ADR-0444` 行11** と **6度**続けて「1回きり」を書いて **6度とも次が来ており**、
  // **本段の `ADR-0445` 行7 はその **7度目** の「1回きり」である。**
  // **数え直した** —— **直上の注記が数えた **5度** に、その注記自身が書いた `ADR-0444` 行11 を
  // 足して **6度**、本段を足して **7度** である。** **【禁止】「これで最後だ」とは書かない** ——
  // **7度目が破られない根拠を、本葉は1つも持っていない。**
  // **【禁止】本葉を「塞いだ」「安全になった」と書かない** —— **本葉が触ったのは凍結面の
  // 値2行と注記、それに配る版の台帳だけであり、製品コードを1バイトも変えていない。**
  // **「配れる」と出て押すと断られる形が今日も残るかどうかを、本葉は1度も撃っていない**
  // (それは `V18-M8-T04` の担当である)。
  //
  // -------------------------------------------------------------------------------------
  // **【2026-09-17。`V18-M9-T11` / `ADR-0446` 授権の表 行7。これが **11度目** の焼き直しである】**
  // **直上の注記(「これ以上(11度目)は授権されていない」)に実際に当たり、そこで止めて
  // メインに戻した。** **メインは `V18-M9-T09` に同格の条文 `ADR-0446` を書かせ、
  // そこで 11度目 が授権された。** **上の注記は1バイトも消していない。**
  //
  // **【旧の値。逐語で残す】** **`sha256: "6cf22bf6f40dd9894eb9515170ec3fb495fa9b42513cce47108b8b95ec73b9c4"`
  // / `bytes: 420148`。**
  //
  // **【なぜ動いたか】** **`V18-M9-T10`(`ADR-0446` 授権の表 行3)が `owner-scope.ts` の
  // `subjectGrantWrite` の doc に訂正を足した** —— **触ったのは doc コメントだけであり、
  // 非コメント行の差分は 0行 である。** **本葉(`T11`)は `owner-scope.ts` を1バイトも
  // 触っていない。**
  //
  // **【手続き。前回までと同じものを踏んだ】** **更新前に実際に赤を見てから**更新した
  // (実測の逐語: `Expected: 420148` / `Received: 421618`。 **同じ `test` の中の `sha256` の
  // `expect` はその手前で落ちたので走っていない。`exports` の検査は緑のままであった** ——
  // **`3 pass / 1 fail`**)。 **値は失敗出力から1文字も写していない** —— **`wc -c` と
  // `shasum -a 256` を自分で打って確かめた**(`wc -c` の **421618** と赤の `Received` が
  // 一致したのは、別々に得た2つの値である。 **`sha256` の側は赤が1度も撃っていないので、
  // 写しようが無かった**)。
  //
  // **【`exports` は 1名も動いていない】** **96 のままである**(`ADR-0446` 限定 ⑥)。
  // **2本の式が同じ値を返すことも自分で打った** ——
  // `grep -cE '^export (const|function|type) ' src/server/owner-scope.ts` が **96**、
  // 本ファイルの `exports` の名前の数が **96**。 **赤くなったのも `bytes` の1本だけである。**
  //
  // **【回数ではなく発火源で書く。`ADR-0446` §Decision 3 の (ii)】** —— **本葉は
  // 「11度目の1回きり」と書かない。** **`ADR-0440` 行20 から `ADR-0445` 行7 まで **7度**
  // 続けて「1回きり」と書いて、**7度とも次が来た**(本葉がその8度目に当たる)。**
  // **`ADR-0446` が授権したのは、同条文の授権の表が名指しした触る先を触ったことによって
  // 生じる焼き直し、ちょうどその分である。** **表が名指ししていない触る先のための
  // 焼き直しは授権の外であり、その時点で止めてメインに戻す。** **`exports` を **97** に
  // したくなったときも同じである。**
  // **【禁止】「次はもう無い」「これで最後だ」と書かない** —— **7度とも偽になった文である。**
  // **【禁止】本葉を「塞いだ」「安全になった」と書かない** —— **本葉が直したのは文言だけで
  // あり、利用者にできることは1ビットも変わっていない。**
  // =====================================================================================
  sha256: "b72b129346822ad1856d807d9184274f8170ddba7b11bb3c5e2b2980f1a7c297",
  bytes: 421618,
  /** 同ファイルが公開している名前の全量(**増えても減っても改名しても赤くなる**)。 */
  exports: [
    // 【`V8-M20` / `J-G30` で**減った**1名。旧の並びをコメントで残す】
    //   "ADMIN_READABLE_FIELD",
    // **【`V8-M20` / `J-G28` / `J-G29` / `J-G30` で足した4名】** **旧4層の置き直し側。**
    // **`roleReadCrossesOwnerScope` だけは置き直しではなく新しい判定である** ——
    // **面が `read` を許した表で `st_owner` の絞り込みを読取についてだけ外す**
    // (ユーザ決定 `D-V8-35`。**挙動が変わった1点であり、「同じ挙動を保った」とは書けない**)。
    "roleReadCrossesOwnerScope",
    // **`isRoleGovernedField` は旧 `fieldAudience` の置き直しである** ——
    // **`scrubHiddenFieldIds` が 400 の `allowed_values` から落とす項目を決める述語。**
    "isRoleGovernedField",
    // **旧 `ViewActionWriteKind` / `FieldWriteVerdict` の置き直しの型2名。**
    "RoleActionWriteKind",
    "RoleFieldWriteVerdict",
    // **【`V8-M17` / `J-G6`〜`J-G11` で足した9名】** **役割に束ねた権限(面)の判定。**
    // **`judgeRoleAccess` が唯一の判定であり、他の3本の述語はそこに委ねている。**
    // **`AccessLayerName` / `CombinedAccessDecision` / `combineRoleAndGrantAccess` は
    // 「止めたのはどちらの層か」を名指しするためのものである**(メインの裁定 `N-13`)。
    "AccessLayerName",
    "CombinedAccessDecision",
    // **【`V8-M19` / `J-G18` / `J-G20` / `J-G33` で足した4名】** **面と点を `OR` で重ねる側。**
    // **`resolveCombinedRecordAccess` が合成の1本であり、`roleGateBlocksWithoutGrants` は
    // 行を持たない関門が短絡してよいかを決める述語である**(`OR` を `AND` に戻さない)。
    "CombinedRecordAccessResolution",
    "RecordAccessBlockedLayers",
    "resolveCombinedRecordAccess",
    "roleGateBlocksWithoutGrants",
    "RoleAccessDecision",
    "RoleAccessTarget",
    "combineRoleAndGrantAccess",
    "isRoleActionWriteAllowed",
    "judgeRoleAccess",
    "judgeRoleFieldWrite",
    "projectForRoleFields",
    // **【`V8-M16` / `J-G3` で足した1名】** **判定に渡る実効ロール集合の型**
    // (`Role` 1値 / `Role[]` / `null`)。**和集合の規則の読み方をこの型1本に閉じた。**
    "ActorRoles",
    "ANON_RESERVED_FIELDS",
    // 【`V8-M27-T04` / `T-G5` で**減った**1名。旧の並びをコメントで残す】
    //   "NonAdminTableAccess",
    "OWNER_FIELD",
    "OwnerScopedOpVerdict",
    "PUBLIC_FIELD",
    "UNRESOLVED_OWNER_DISPLAY",
    // 【`V8-M20` / `J-G30` で**減った**2名。旧の並びをコメントで残す】
    //   "adminReadableField",
    //   "adminReadsAllRows",
    // 【`V8-M27-T04` / `T-G5` で**減った**1名。旧の並びをコメントで残す】
    //   "nonAdminTableAccess",
    "UNDELETABLE_FIELD",
    // 【`V8-M20` / `J-G28` で**減った**1名。旧の並びをコメントで残す】
    //   "fieldAudience",
    "isAllowedOwnerUpdate",
    "isDeleteProtectedRow",
    // **【`V8-M37` / `F-G3` で**増えた**1名】**
    "isOwnerSpoofedOnCreate",
    "isOwnerVisible",
    "isPublicRow",
    "isSharedOwner",
    // 【`V8-M20` / `J-G27` で**減った**1名。旧の並びをコメントで残す】
    //   "isViewAudienceAllowed",
    "judgeOwnerScopedOp",
    // **【`V8-M37` / `F-G5` で**増えた**1名】**
    "judgeOwnerUpdateWithDisplay",
    "ownerDisplayName",
    "personalOwnerField",
    "projectForAnonymous",
    // 【`V8-M20` で**減った**2名。旧の並びをコメントで残す】
    //   "projectForFieldAudience",  (`J-G28`)
    //   "projectForRead",           (`J-G30`。伏せる対象そのものが無くなった)
    "projectOwnerDisplay",
    "publicField",
    "undeletableField",
    // 【`V8-M20` / `J-G30` で**減った**1名。旧の並びをコメントで残す】
    //   "READ_HIDDEN_RESERVED_FIELDS",
    // 【`V8-M20` / `J-G27` で**減った**1名。旧の並びをコメントで残す】
    //   "viewAudience",
    // **V4-M2-T05 / `B-G5` / `ADR-0074` が足した4名。**
    // **【`V8-M20` / `J-G27`】4名のうち3名が減り、`ANONYMOUS_AUDIENCE` だけが残った** ——
    // **あれは「ロールを持たない者」を指す値であって、画面の宣言ではないためである。**
    "ANONYMOUS_AUDIENCE",
    //   "ViewAudienceValue",
    //   "isViewAnonymousVisible",
    //   "viewAudienceDeclaration",
    // **V4-M10-T02 / `E-G48` / `ADR-0076` が足した3名**(限定6: 判定は本ファイルに集約)。
    // **【`V8-M20` / `J-G28`】3名とも減った。** 置き直しは `RoleFieldWriteVerdict` /
    // `judgeRoleFieldWrite`(後者は `V8-M17` が先に置いていた)である。
    //   "FieldWriteVerdict",
    //   "fieldWriters",
    //   "judgeFieldWrite",
    // **V4-M10-T04 / `E-G49` / `ADR-0077` が足した3名**(予約規約フィールドの5本目 +
    // その述語 + 判定。限定6: 判定は本ファイルに集約)。
    "NO_DIRECT_CREATE_FIELD",
    "isDirectCreateSuppressed",
    "noDirectCreateField",
    // **V4-M27 / `D-V4-92` + `D-V4-114` が足した1名**(受信 payload から `st_public` を
    // 無条件に取り除く。`ADR-0061` 限定4: 判定は本ファイルに集約)。
    "stripInboundPublicFlag",
    // **V4-M36 / `D-V4-125` が足した2名**(受信 payload から残る3本も無条件に取り除く。
    // `ADR-0061` 限定4 / `ADR-0073` 限定5 / `ADR-0077` 限定6: 判定は本ファイルに集約)。
    "INBOUND_STRIPPED_RESERVED_FIELDS",
    "stripInboundReservedFields",
    // **V4-M35 / `D-V4-124` が足した1名**(400 の `allowed_values` から「見せない項目」の
    // IDを落とす。`ADR-0061` 限定4: 判定は本ファイルに集約)。
    "scrubHiddenFieldIds",
    // **【`V5-M17-T03` / `G-G5` / `ADR-0158`】が足した3名**(アプリが宣言した利用者の
    // 種類を読む述語。**サーバも表示層も宣言を自分で解釈しない** = 判定を1箇所に集約する
    // 既存の作法)。**`CustomerTableAccess` / `customerTableAccess` は同じタスクで
    // `NonAdminTableAccess` / `nonAdminTableAccess` に改名した**(`G-G7`。名前だけ)。
    "UserKind",
    // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`】旧(逐語)**: この位置に
    // `"declaredUserKinds",` と `"effectiveUserKindIds",` の2名が並んでいた。
    // **【`V8-M29` 第1波 / `T-G10` / `D-V8-78`〜`D-V8-80`】が足した2名**(アプリが宣言した
    // **役割**を読む述語。**上の3名を1バイトも消していない** —— **撤去は次の波である**)。
    // **`declaredRoleIds` は予約4語を1語も落とさない**(落とすのは値域を組む側)。
    // **`declaredRoleKinds` は `name` を持つ宣言だけを返す**(`D-V8-79` = 表示名は任意)。
    "declaredRoleIds",
    "declaredRoleKinds",
    // **【`V5-M28-T01` / `A-G1` / `ADR-0249`】が足した2名**(操作起点の宣言から書込の壁を
    // 導く述語。**`ADR-0249` §Decision 7 の 5 が `ADR-0241` 限定2「`owner-scope.ts` を
    // 1バイトも書き換えない」を全部無効化した結果である**)。**限定6: 判定は本ファイルに集約。**
    // 【`V8-M20` / `J-G29` で**減った**2名。旧の並びをコメントで残す】
    // **置き直しは `RoleActionWriteKind` / `isRoleActionWriteAllowed`(後者は `V8-M17` が
    // 先に置いていた)である。**
    //   "ViewActionWriteKind",
    //   "isViewActionWriteAllowed",
    // **【`V7-M1-T04` / `Z-G2`〜`Z-G7`】が足した8名**(アクセス権管理の宣言を読んで
    // 「この表は何であるか」を返す純粋述語。**判定は1バイトも含まない** = `V7-M3` の担当)。
    // **`ADR-0061` 限定4: 判定も述語も本ファイルに集約する。**
    "AccessControlDeclaration",
    "AccessControlTableRole",
    "accessControlOf",
    "accessControlTableRoles",
    "isAccessControlledTable",
    "isGrantTable",
    "isGroupTable",
    "isMemberTable",
    // **【`V7-M2-T02` / `Z-G11`】が足した4名**(**行1件への判定そのもの**。
    // **`judgeOwnerScopedOp` の中には入れていない** —— 入れるとワークフローと受信口が
    // 判定を受けてしまい、`Z-G22` / `Z-G23`(今日どおり素通りする)と食い違う)。
    // **`ADR-0061` 限定4: 判定は本ファイルに集約する**(`app.ts` に条件式を1行も書かない)。
    "RecordAccessSourceTables",
    "RecordAccessVerdict",
    "judgeRecordAccess",
    "recordAccessSourceTables",
    // **【`V7-M3-T02`】が足した2名**(**作成者への自動付与の計画**。`D-V7-23` /
    // `creator_permission`)。**判定は1バイトも含まない** —— **「作った人に何が渡るか」は
    // `judgeRecordAccess` が下見の1件で答える**(判定の家は今日も1本である)。
    // **`ADR-0061` 限定4: 述語も本ファイルに集約する**(`app.ts` に条件式を1行も書かない)。
    "CreatorGrantPlan",
    "creatorGrantPlan",
    // **【`V7-M3-T03` / `Z-G5` / `D-V7-14`】が足した3名**(**付与表への書込を、付与が指す
    // 行への権限で絞る判定**)。**`read` / `write` / `delete` を1つも計算しない** ——
    // **動詞を計算する場所は今日も `judgeRecordAccess` 1本である**(本述語はその答えと
    // 権限名の解決を使って「付与を作ってよいか」を組み立てるだけ)。
    // **`ADR-0061` 限定4: 判定は本ファイルに集約する**(`app.ts` に条件式を1行も書かない)。
    "GrantWriteOp",
    "GrantWriteVerdict",
    "judgeGrantWrite",
    // **【`V8-M28` / `T-G20` / ユーザ決定 `D-V8-75` / `D-V8-76`】が足した2名**
    // (**役割を配ってよいかの不変条件2本**)。**`read` / `write` / `delete` を1つも
    // 計算しない** —— **可否そのものを決めるのは今日も `judgeRoleAccess` 1本ちょうどで
    // ある**(`ADR-0305` 限定3)。**本判定はその答えが「配ってよい」と出た**あと**に、
    // (a) 対象者が要求者自身なら拒否(`self`。`D-V8-76`。**持ち主も例外ではない**)/
    // (b) 配ろうとしている集合に `owner` が在り、要求者が `owner` を持たないなら拒否
    // (`owner_grant`。`D-V8-75`)の2本だけを見る。
    // **置き場は `judgeGrantWrite` の直後である**(判定は本ファイルに集約する =
    // `ADR-0061` 限定4)。**`src/server/auth-routes.ts` に条件式を1行も書いていない。**
    "RoleAssignmentVerdict",
    "judgeRoleAssignment",
    // **【`V7-M3-T05` / `Z-G32`】が足した1名**(**消えたグループ行を指す付与を、判定の
    // 手前で無効にする**)。**`read` / `write` / `delete` を1つも計算しない** ——
    // **`judgeRecordAccess` の引数キーは今日も6本ちょうどである**(`ADR-0294` 限定5 の
    // 機械的な固定 = `access-control-role-precedence.test.ts` の `(E1)`)。
    // **`RecordAccessSourceTables` に `groupTable` が増えた**(2キー → 3キー)——
    // **`V7-M3-T01` の「グループ表の行を1行も読まない」は今日は成り立たない**(`v7-m3.md` §2-5)。
    "grantsWithExistingGroups",
    // **【`V7-M4-T02` / `Z-G14`】が足した2名**(**付与の引き継ぎ(`inherit_from` の多段)を
    // 辿る判定**)。**`judgeRecordAccess` の署名も中身も1バイトも変えていない** ——
    // **引き継ぎは判定の**外側**に在り、各段でその1本を呼んで OR で重ねるだけである**
    // (判定の家は今日も1本)。**行の読み出しは呼び出し側から渡されたコールバックで受ける**
    // (`judgeGrantWrite` の先例と同じ形。`Z-G14` 限定7 = `src/kernel/` に1バイトも
    // 差分を出さない)。**`RecordAccessResolution` は判別可能なユニオンで、今日の枝は
    // `verdict` の1本だけである** —— **上限の枝は `V7-M4-T04`(`Z-G17`)が足す。**
    "RecordAccessResolution",
    "resolveRecordAccess",
    // **【`V7-M4-T04` / `Z-G17`】が足した2名**(**引き継ぎを辿るときの上限2本**)。
    // **`schemas/` に1バイトも書いていない** —— **上限は宣言できない**(= アプリを作る人は
    // マニフェストから上限を読めない。`Z-G17` `S5` の「門外の対価」)。
    // **最も近い先例は `src/kernel/records.ts:1055` の `export const MAX_FILTER_DEPTH = 8;`
    // だが、あちらは `src/kernel/` に在り、こちらは `src/server/` に在る** ——
    // **置き場所が違うので「同じ作法である」とは書けない。**
    // **【禁止】この上限を「性能上の都合」と書かない** —— **置く理由は、黙った打ち切りが
    // 「隠れた行がある」と区別できないからである**(`v7-m0.md` §5-5 (b))。
    "MAX_RECORD_ACCESS_INHERIT_DEPTH",
    "MAX_RECORD_ACCESS_INHERIT_ROWS",
    // **【`V7-M5-T02` / `Z-G19`】が足した1名**(**「その行を指す付与が1件も無いか」**。
    // **運営専用の口の母集団を決める述語である**)。**`read` / `write` / `delete` を
    // 1つも計算しない** —— **動詞を計算する場所は今日も `judgeRecordAccess` 1本である。**
    // **付与の突き合わせは判定側と共有した1本(`grantsTargetingRecord`。**非公開**)を
    // 通る** —— **第2の述語を書いていない**(`Z-G19` 限定6)。
    // **【誇張しない】** **本述語は行を**見つける**だけであり、付与を作れる相手を1ミリも
    // 増やさない。** **「運営が回復できる」ことを意味しない**(`Z-G19` の「誇張しない」)。
    // **【差し戻し後の入れ替え】** **`isRecordWithoutGrants` は非公開に戻した** ——
    // **単独で口の母集団に使うと、親にだけ付与が在る子の行が並ぶ**(実測した穴)。
    // **公開するのは「引き継ぎのどの段にも付与が無いか」を返すこちら1本だけである。**
    "resolveRecordWithoutGrants",
    // **【`V8-M21` の後半 / 台帳 `J-G21` / `J-G22a` / `J-G23`】が足した1名。**
    // **「これから作る行」について面と点を `OR` で重ねる** —— **作成には行がまだ無いので、
    // 点の答えは `judgeRecordAccess` ではなく `creatorGrantPlan` が出す。**
    // **`read` / `write` / `delete` を1つも計算しない** —— **`OR` そのものは
    // `combineRoleAndGrantAccess`(既存)に委ねており、合成の規則は今日も1本である。**
    "combineRoleAndCreatorGrant",
    // **【`V8-M26-T03b` / ユーザ決定 `D-V8-45` / `D-V8-65` / 台帳 `T-G1a` / `T-G4b`】が
    // 足した1名。** **「その対象を名指しした規則が、どれかの役割に1本でも書かれているか」
    // だけを見る** —— **= 既定を閉じる前の `governed` の意味そのものである。**
    // **判定のロジックを2本目に増やしていない**(非 export の `ruleNamesTarget` を再利用)。
    // **可否を1ミリも決めない** —— **今日の唯一の用途はレコード取得 URL に `?view=` を
    // 付けるかどうか(名乗り)であって、壁ではない。**
    "roleRulesNameTarget",
    // **【`V8-M41` / 台帳 `F-G13`】が足した2名**(**面の側の「誰にも届かない行」の母集団**)。
    // **`resolveRecordWithoutGrants`(点の側)の対であり、同じ `{ kind: "orphan" }` の形を
    // 返す** —— **運営専用の口はこの2本を同じ `switch` で扱う。**
    // **可否を1ミリも計算しない** —— **`judgeRoleAccess` を宣言された役割ぶん(と未ログイン
    // 1回)呼んで畳むだけである。** **規則も条件も1バイト読んでいない**(判定の家は1本)。
    // **条件(`when`)が関与した判定は `undecided: true` にして並べない** ——
    // **主体を伏せて判定しているので「誰にも届かない」と断定できない。**
    // **【誇張しない】** **本述語は行を**見つける**だけであり、規則を書ける相手も、
    // 規則を書く手段も1つも増やさない**(`Z-G19` の「誇張しない」を引き継ぐ)。
    "RoleUnreachableResolution",
    "resolveRecordUnreachableByRoles",
    // **【`V8-M10-T02` / 台帳 `Q-G16a` / `Q-G21d`】が足した5名**(**母集団の判定**)。
    // **着手前は `src/server/app.ts` のレコード一覧のルートの中に5分岐として在ったものを、
    // 判定の家1本へ集めた**(`ADR-0061` 限定4)。
    // **返すのは3つだけである** —— **可視行の集合 / 絞りは要らない / 上限に当たった。**
    // **射影・表示名の解決・ページ切り・件数と合計の採り方は集約していない**(`app.ts` に残る)。
    // **群を1つも知らない**(`Q-G21d`)—— **入力は行、出力は行である。**
    "RecordPopulation",
    "RecordPopulationClass",
    "RecordPopulationScope",
    "judgeRecordPopulation",
    "recordPopulationScope",
    // **【`V10-M27-T01a` / `ADR-0375`】が足した2名**(**規則の総数を数えるための述語**)。
    // **どちらも既にこのファイルに在ったものを `export` しただけであり、実装は1バイトも
    // 変えていない。** **`read` / `write` / `delete` を1つも計算しない** ——
    // **返すのは「役割の宣言の配列」と「その1件が持つ規則の配列」だけである。**
    // **可否を1ミリも決めない** —— **可否を決めるのは今日も `judgeRoleAccess` 1本である。**
    "manifestRoleDeclarations",
    "roleRulesOf",
    // **【`V14-M1-T01` / `V14-M1-T03`(台帳 `RB-G1` / `RB-G2` / `RB-G3`)が足した3名】**
    // **行ごとの判定を、行と**並べて**応答に載せるための3本である。**
    // **判定を1本も増やしていない** —— **`read` / `write` / `delete` は
    // `resolveCombinedRecordAccess` が出した答えをそのまま運ぶだけであり、
    // `grant_write` は `judgeGrantWrite` の関門 (1)(2) だけを問う。**
    // **`judgeGrantWrite` の本体は1バイトも変えていない**(壁は今日もあちら1本)。
    // **【誇張しない】`grant_write: true` は「押せば必ず作れる」の保証ではない** ——
    // **関門 (3) 自分自身 / (4) 相手が解決できるか / (5) 相手が親を読めるか は
    // 1つも見ていない**(相手が決まっていないので答えようが無い)。
    "RecordRowAccess",
    "recordRowAccessMap",
    "rowGrantWriteJudge",
    // **【`V15-M2-T02`(台帳 `CR-G1` / `CR-G4`。`ADR-0404` / `ADR-0405`)が足した3名】**
    // **行を作るときの前提の関門と、その4状態の型、および fail-closed の述語1本である。**
    // **`read` / `write` / `delete` を新しく計算する場所を1つも作っていない** ——
    // **親の行の判定は既存の `resolveRecordAccess` に、権限名の解決は既存の
    // `resolveGrantedPermissionNames` に委ねている**(判定の家は今日も1本)。
    // **合成(`combineRoleAndGrantAccess`)の式を1バイトも変えていない**(`ADR-0404` 限定2)
    // —— **`isDirectCreateSuppressed` / `isRoleActionWriteAllowed` と同じ「前提の関門」で
    // あり、`OR` の中には入らない。**
    // **新しい上限の定数を1本も作っていない**(`ADR-0404` 限定5)——
    // **`MAX_RECORD_ACCESS_INHERIT_DEPTH` / `MAX_RECORD_ACCESS_INHERIT_ROWS` の値は
    // 1も動いていない。**
    // **【誇張しない】効くのは HTTP の単件の作成だけである** —— **まとめ書きは `V15-M3`、
    // MCP / 受信口 / ワークフロー / 島は `D-V15-3` により今日も素通りする。**
    // **【`V17-M2-T04c` による訂正(2026-09-07)。上の2行を1バイトも消していない】** ——
    // **逐語「**効くのは HTTP の単件の作成だけである**」と「**MCP / 受信口 / ワークフロー /
    // 島は `D-V15-3` により今日も素通りする**」は、行を**作る**側については今日は偽である。**
    // **`V17-M2`(台帳 `AC-G7a` / `ADR-0411`)が、作成の関門を MCP・受信口・ワークフロー・
    // 島の4本の入口にも配線した**(呼び出し元は `src/mcp/tools/write.ts` /
    // `src/server/inbound-route.ts` / `src/kernel/workflow-runner.ts` の各1箇所)。
    // **双方向に書く** —— **素通りするのは、決まった時刻に動く処理(`schedule`)1本だけである**
    // (`ADR-0411` 限定1)。 **親の付け替え(更新)が効くのは今日も HTTP の2経路だけで、
    // この4本の入口の**更新**は今日も素通りする**(同 限定4)。
    // **受信口には逃げ道が今日1つも無い**(同 §限界1。`AC-G7b` は**保留**)。
    // **この訂正は `exports` の集合を1名も動かしていない**(散文だけである)。
    "CreateParentAccessVerdict",
    "isCreatorGrantReachable",
    "judgeCreateParentAccess",
    // **【`V17-M5-T03d`(台帳 `AC-G10` / `ADR-0412`)が足した1名】**
    // **親を持たない表に書く9キー目(`creatable_by_roles`)の関門である** ——
    // **`true` を返したら、その人はその表に行を作れない。**
    // **判定を新しく作ってはいない** —— **宣言集合と実効ロール集合の積は、
    // 和集合の規則の唯一の実装である `declaredMatchesRoles`(**非公開**)に委ねている。**
    // **合成(`combineRoleAndGrantAccess`)の中に1文字も入れていない**
    // (`ADR-0412` 限定5。**入れると面と点の `OR` の項になり、その表を名指しした
    // 役割の規則が1本あるだけで素通りする**)。
    // **`judgeCreateParentAccess` の中にも足していない** ——
    // **あちらの呼び出しは `access-control-limit-honesty.test.ts` の `(E-5)` が
    // **7箇所ちょうど**に固定しているためである**(罠5)。
    // **【正直に】`ADR-0412` 限定6 の第2文(「判定は既存の `judgeRoleAccess`
    // (`row` 省略)1本で出す。2本目の判定の家を作らない」)は履行していない** ——
    // **`judgeRoleAccess` が読むのは役割の**規則**であって9キー目の**一覧**ではなく、
    // あの1本では9キー目を1バイトも見られないからである**(実装側の doc にも
    // 同じ断りが逐語で書いてある)。 **【禁止】これを「限定6 を守った」と書かない。**
    "judgeRootCreatableRoles",
    // **【`V17-M6-T04b`(台帳 `AC-G24`)が足した3名】**
    // **「どの付与行が効いて `read` / `write` / `delete` が真になったか」を返す
    // 読取専用の判定と、その応答の形の型2本である。**
    // **一覧・単票の応答の `access` には1バイトも載せていない**(`ADR-0402` 限定2。
    // `record-row-access-response.test.ts` の `(A-2)` は今日も4キーちょうどで緑である)——
    // **別の口(`GET .../record-access-sources`)としてだけ返す。**
    // **`judgeRecordAccess` の引数は今日も6本ちょうどである**(`ADR-0294` 限定5 /
    // `ADR-0308` 限定1 / `ADR-0412` 限定6)—— **渡す付与行の側を絞って答えを出している。**
    "RecordAccessSourceEntry",
    "RecordAccessSourcesResolution",
    "resolveRecordAccessSources",
    // **【`V18-M7-T01`(`ADR-0444` 授権の表 行12)が足した **1名**。95 → 96】**
    // **子を数え、消せるかを問う純関数。理由と限界は直上の注記が逐語で持っている。**
    "resolveRecordDeleteCascade",
  ],
};

// **【`V8-M10-T02`。`ADR-0053` 限定4 の手続き (b)「テスト名とコメントを実物に合わせる」】**
//
// **旧のテスト名(逐語。1文字も消していない)**:
//   `test("(c) src/server/owner-scope.ts が V4-M6(E-G54)の更新後から1バイトも変わっていない", …)`
//   `test("(c) src/server/owner-scope.ts の export の集合が V4-M6(E-G54)の更新後と一致する", …)`
//
// **名前が実物と合っていなかった** —— **基準はこのファイルの上の注記のとおり
// `V4-M6`(`E-G54`)のあと十数回更新されており、今日固定しているのは `V4-M6` の姿ではない。**
// **`V8-M10-T02` が固定した姿である。** **名前だけを実物に合わせ、見ているものは
// 1バイトも変えていない**(`bytes` / `sha256` / `exports` の3つのまま)。
// **【`V17-M1-T01f`。`ADR-0053` 限定4 の手続き (b)「テスト名とコメントを実物に合わせる」
//    を、`V8-M10-T02` に続いて2度目に踏んだ】**
//
// **旧のテスト名(逐語。1文字も消していない)**:
//   `test("(c) src/server/owner-scope.ts が最後に更新した基準(V8-M10-T02)から1バイトも変わっていない", …)`
//   `test("(c) src/server/owner-scope.ts の export の集合が最後に更新した基準(V8-M10-T02)と一致する", …)`
//
// **名前がまた実物と合っていなかった** —— **基準は `V8-M10-T02` のあと
// `V14-M1-T04` / `V15-M2-T02` / `V15-M3` / `V15-M6B-T03` / `V15-M8-T03` と更新されており、
// 今日固定しているのは `V8-M10-T02` の姿ではない。****`V17-M1-T01f` が固定した姿である。**
// **`ADR-0402` 限界5(`0402:239`)が「名前と実物が合っていない」と自ら記録し、
// `v14-m1.md:128` が「`V14-M2` 以降で直す」と申し送っていたもので、ここで直す。**
// **名前だけを実物に合わせ、見ているものは1バイトも変えていない**
// (`bytes` / `sha256` / `exports` の3つのまま。**検査は1本も消えておらず、条件も緩んでいない**)。
//
// **【正直に】この改名で `ADR-0402` 限定9(`0402:153`)が測る式として引いている
// テスト名の逐語は、当たらなくなる。** **ADR の本文は書き換えない**(このリポジトリの作法)——
// **ずれをここに書き残す**: **`0402:153` の「`… 最後に更新した基準(V8-M10-T02)…`」は
// 今日「`… 最後に更新した基準(V17-M1-T01f)…`」である。** **限定9 が守らせたいこと
// (基準を消さない・`.skip` にしない・緩めない・更新前に赤を見る)は1ミリも動いていない。**
// **【`V17-M2-T06c`。`ADR-0053` 限定4 の手続き (b)「テスト名とコメントを実物に合わせる」
//    を、`V8-M10-T02` / `V17-M1-T01f` に続いて3度目に踏んだ】**
//
// **旧のテスト名(逐語。1文字も消していない)**:
//   `test("(c) src/server/owner-scope.ts が最後に更新した基準(V17-M1-T01f)から1バイトも変わっていない", …)`
//   `test("(c) src/server/owner-scope.ts の export の集合が最後に更新した基準(V17-M1-T01f)と一致する", …)`
//
// **【この改名は、直上の注記が「改名していない」と書いたずれを2タスクぶん残したまま
//    畳むものである。正直に書く】** —— **直上の `V17-M1-T01g` の注記は「実物は
// `V17-M1-T01g` なのに名前は `V17-M1-T01f` のままで1タスクぶんずれている」と自認し、
// 同じ日に2度動かさないために改名を見送った。** **今日 `V17-M2-T06c` が基準を更新したので、
// 実物は `V17-M2-T06c` である。** **したがって新しい名前は `V17-M1-T01g` を飛ばしており、
// 「`V17-M1-T01g` が更新した」という事実は名前からは読めない** ——
// **読めるのは直上の注記の本文だけである**(注記は1バイトも消していない)。
//
// **名前だけを実物に合わせ、見ているものは1バイトも変えていない**
// (`bytes` / `sha256` / `exports` の3つのまま。**検査は1本も消えておらず、`.skip` にも
// していない・条件も緩んでいない**。`ADR-0402` 限定9 が守らせたいこと)。
//
// **【正直に】`ADR-0402` 限定9(`0402:153`)が測る式として引くテスト名の逐語は、
// この改名でまた当たらなくなる。** **ADR の本文は書き換えない**(このリポジトリの作法)——
// **ずれをここに書き残す**: **`0402:153` の「`… 最後に更新した基準(V8-M10-T02)…`」は
// 今日「`… 最後に更新した基準(V17-M2-T06c)…`」である**(直上の注記が
// 「今日は `V17-M1-T01f` である」と書いた時点からもう1度動いた)。
test("(c) src/server/owner-scope.ts が最後に更新した基準(V17-M2-T06c)から1バイトも変わっていない", () => {
  const bytes = readFileSync(OWNER_SCOPE_PATH);
  expect(bytes.length).toBe(OWNER_SCOPE_BASELINE.bytes);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(OWNER_SCOPE_BASELINE.sha256);
});

test("(c) src/server/owner-scope.ts の export の集合が最後に更新した基準(V17-M2-T06c)と一致する", () => {
  // ダイジェストだけだと**赤になった理由が読めない**(1バイトの差でも同じ赤になる)。
  // 名前の集合を別に見ておくと、触ったときに「何が増えたか」がテストの出力に出る —— V3-M8-T01
  // で実際にそうなった(赤の出力に `ADMIN_READABLE_FIELD` / `adminReadableField` /
  // `adminReadsAllRows` の3名が並んだ)。**V3-M8-T03 でも同じことが起きた**(赤の出力に
  // `UNRESOLVED_OWNER_DISPLAY` / `ownerDisplayName` / `projectOwnerDisplay` の3名が並んだ)。
  // **この性質は基準の更新が4度目になっても保たれている**(V3-M13-T10 の赤の出力には
  // `OwnerScopedOpVerdict` / `judgeOwnerScopedOp` の2名が並んだ)。
  const source = readFileSync(OWNER_SCOPE_PATH, "utf-8");
  const exported = [
    ...source.matchAll(/^export (?:const|function|type) ([A-Za-z_][A-Za-z0-9_]*)/gm),
  ].map((match) => match[1] as string);
  expect(exported.sort()).toEqual([...OWNER_SCOPE_BASELINE.exports].sort());
});
