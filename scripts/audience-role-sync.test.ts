/**
 * 「見せる相手 / 書ける相手」の役割(ロール)の値の一覧が、**複数箇所に写しとして
 * 存在する**件を機械で固定する検査(`V4-M40` / ユーザ決定 `D-V4-127`)。
 *
 * ## なぜ写しが在るのか(設計上の要請であって、事故ではない)
 *
 * `ADR-0025` §4-6 が「**監査スクリプトは生成器を1行も import しない**」と定めているため、
 * 生成器(`src/kernel/requirements-doc.ts`)と監査スクリプト(`scripts/cp-v1-8-audit.ts`)は
 * **同じ値域を独立に持つ**。さらに `ADR-0070` 限定5 / `ADR-0071` 限定6 / `ADR-0076` 限定7 が
 * `src/kernel/` を閉じたため、`audience` / `writable_by` の値域は**カーネルの型に1つも
 * 現れず**、正準は `schemas/manifest.schema.json` の enum にしかない。
 * **どの写しも export されていない**(`ADR-0126` B5 / C4 の「`src/kernel/` の新規 export を
 * 1件も足さない」/ `src/server/owner-scope.ts` の `AUDIENCE_ROLES` / `VIEW_AUDIENCE_VALUES`
 * も非 export)ので、**この検査は値を import できない。ソースをテキストとして読む。**
 *
 * ## 何が起きるのを防ぐのか
 *
 * **将来ロールを1つ増やしたとき、全部の写しを直さないと壊れる。壊れ方が箇所ごとに違う:**
 *
 * - **生成器を直し忘れる** → その値を書いたアプリの**要件定義書の生成が丸ごと止まる**
 *   (`termSlot` の fail-closed。`ADR-0126` Consequences 6)。**理由はすぐには分からない。**
 * - **監査スクリプトを直し忘れる** → 実在する語彙を「捏造」と報告する(厳しすぎる側)。
 * - **`src/server/owner-scope.ts` を直し忘れる** → `viewAudienceDeclaration` の
 *   `filter` が未知の値を**黙って捨てる**。**赤くもならず、拒否もされず、宣言だけが効かない。**
 *   **3つの中でこれだけが「静かに緩む」向きである。**
 *
 * ## この検査の設計(`scripts/kernel-export-drift.test.ts` / `kernel-import-drift.test.ts`
 * と同じ形)
 *
 * - **対象を1行も import せず、ファイルをテキストとして読む。** 4箇所は
 *   `schemas/` / `src/kernel/` / `src/server/` / `scripts/` に分かれており、**どの層も
 *   この検査の家ではない**。層をまたぐ突き合わせが `scripts/*.test.ts` に住むのは
 *   上記2本が先に採った作法である。
 * - **`src/kernel/` にも `schemas/` にも1バイトの差分を出さない**(`ADR-0007` §1b Δ7)。
 *   置き場を `src/kernel/` にしないのはそのためでもある(記録 `docs/plan/v4/records/v4-m40.md` §3)。
 * - **部分集合ではなく完全一致**を測る。**失敗メッセージは箇所ごとに「足りない値」と
 *   「余分な値」を名指しする** —— 将来ロールを増やした人が、直す場所を読み取れるように。
 *
 * ## 限界(憲法6)
 *
 * - **検出するのは「食い違ったこと」だけで、どちらが正しいかは判定しない。**
 * - **写しが5箇所目に増えたことは検出できない。** 走査しているのは名指しした4ファイルだけで
 *   あり、別のファイルに同じ一覧が書かれても本検査は緑のままである(実測の手順と結果は
 *   `docs/plan/v4/records/v4-m40.md` §1)。
 * - **宣言の綴りに依存する。** 定数名を変える・別ファイルへ移すと、抽出が「宣言が
 *   見つからない」で赤くなる(**空回りして緑になるよりは良い**、という選択である)。
 *
 * ---
 *
 * ## **【2026-08-10 追記(`V8-M20`。台帳 `J-G27` / `J-G28` / `J-G29`。手続きは `ADR-0301`)。
 * 上の doc の「4箇所」は今日から偽である。1バイトも消していない】**
 *
 * **写しは4箇所から2箇所になった。** **消えたのは実装側の2つである**:
 *
 * 1. **`src/server/owner-scope.ts`(`AUDIENCE_ROLES` + `VIEW_AUDIENCE_VALUES`)** ——
 *    **4層(`view.audience` / `field.audience` / `field.writable_by` /
 *    `view_action.audience`)の値域だった。4層が廃止され、参照が0本になって撤去された。**
 * 2. **`src/kernel/referential-integrity.ts`(`RESERVED_ROLE_IDS` +
 *    `ANONYMOUS_AUDIENCE_VALUE` + `DEFAULT_USER_KIND_ID`)** —— **同じ4層の値域検査
 *    (類型13)だけが使っていたので、同じ日に撤去された。**
 *
 * **上の「何が起きるのを防ぐのか」の3つ目(`owner-scope.ts` を直し忘れると宣言が黙って
 * 効かない)は、したがって今日は起こらない** —— **面(`judgeRoleAccess`)はロールの値域を
 * 1つも列挙せず、未知の値を捨てる `filter` を持たない。**
 *
 * **残る2箇所(生成器 / 監査スクリプト)の一致は今日も要る** —— **`ADR-0025` §4-6 が
 * 「監査スクリプトは生成器を1行も import しない」と定めているからであり、その要請は
 * `V8-M20` で1バイトも変わっていない。**
 *
 * **【誇張しない】** **`app.roles[].id` の値域を実装側で閉じている箇所は、今日1つも無い**
 * (`referential-integrity.ts` が自ら申告している穴である)。**本ファイルはその穴を1ミリも
 * 塞いでいない。**
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const REPO_ROOT = dirname(import.meta.dir);

function read(...parts: string[]): string {
  return readFileSync(join(REPO_ROOT, ...parts), "utf-8");
}

/**
 * `const NAME ... = [ "a", "b" ]` の形の**文字列配列リテラル**を1つだけ取り出す。
 *
 * **宣言が0個でも2個以上でも投げる** —— 0個は「静かに素通り」を、2個以上は
 * 「どちらを読んだのか分からない」を防ぐ。
 */
function stringArrayLiteral(source: string, where: string, declaration: RegExp): string[] {
  const matches = [...source.matchAll(declaration)];
  if (matches.length !== 1) {
    throw new Error(
      `${where}: 宣言 ${declaration} が ${matches.length} 件見つかった(1件であるべき)`,
    );
  }
  const head = matches[0] as RegExpMatchArray & { index: number };
  // 正規表現は開き括弧 `[` までを含めて一致させてあるので、その直後から本体が始まる。
  const start = head.index + head[0].length;
  const end = source.indexOf("]", start);
  if (end < 0) {
    throw new Error(`${where}: 配列リテラルが閉じていない`);
  }
  const values = [...source.slice(start, end).matchAll(/"([^"]*)"/g)].map((m) => m[1] as string);
  if (values.length === 0) {
    throw new Error(`${where}: 配列リテラルから値を1つも取り出せなかった`);
  }
  return values;
}

// --- 写しの在り処(実測。file:line は 2026-08-04 時点)----------------------------------

// --- (1) **旧の正準** —— **`V8-M20` で写しが1つ消えた**(台帳 `J-G27`〜`J-G29` / `ADR-0301`)---
//
// **ここに在ったもの(逐語で残す)**:
//
// ```
// /**
//  * (1) **正準**(`V5-M17-T07` で移った)。`src/kernel/referential-integrity.ts` の類型13 が
//  * 使う3定数の合成 —— `RESERVED_ROLE_IDS` + `ANONYMOUS_AUDIENCE_VALUE` + `DEFAULT_USER_KIND_ID`。
//  */
// function canonicalValues(): string[] { ... }
// ```
//
// **消した理由**: **その3定数を `src/kernel/referential-integrity.ts` が撤去した。**
// **同ファイルの跡地コメントの逐語**: 「**4つとも、下の類型13(`view.audience` /
// `view_action.audience` / `field.audience` / `field.writable_by` の値域検査)だけが
// 使っていた。** **その4層が `V8-M20` で廃止され … 参照が0本になったので落とした。**」
//
// **【穴を隠さない】** **同じ値域を `app.roles[].id` について検査する箇所は今日1つも無い**
// (同ファイルが自ら申告している)。**したがって「正準」と呼べる実装側の定数は今日存在しない。**
// **正準の座は生成器(下の (2))へ移した** —— **残る2つの写しのうち、値域を実際に使って
// 出力を作っているのはそちらだからである。**

/**
 * (2) **正準**(`V8-M20` で (1) から移った)。生成器 `src/kernel/requirements-doc.ts` の
 * `AUDIENCE_ROLES`(`VOCABULARIES.audience_role`)。
 *
 * **【この語彙グループは今日、どのテンプレートからも使われていない。隠さない】** ——
 * **`screens.audience` / `data.field_audience` / `data.field_writable_by` の3本が
 * `V8-M20` で撤去され、`audience_role` を使うテンプレートが0本になった。**
 * **同ファイルの doc がその状態を「誰も使わないまま残っているスロット」と自ら申告し、
 * `ADR-0301` の求める「根拠のある単位でしか撤去しない」に従って残している。**
 * **孤児であっても、下の (3) との一致は今日も要る**(`ADR-0025` §4-6 の独立2写し)。
 */
function canonicalValues(): string[] {
  return stringArrayLiteral(
    read("src", "kernel", "requirements-doc.ts"),
    "src/kernel/requirements-doc.ts",
    /^const AUDIENCE_ROLES\b[^=\n]*=\s*\[/gm,
  );
}

/** (3) 監査スクリプト。`scripts/cp-v1-8-audit.ts:530` の `AUDIENCE_ROLES`。 */
function auditRoles(): string[] {
  return stringArrayLiteral(
    read("scripts", "cp-v1-8-audit.ts"),
    "scripts/cp-v1-8-audit.ts",
    /^const AUDIENCE_ROLES\b[^=\n]*=\s*\[/gm,
  );
}

// --- (4) **実行層** —— **`V8-M20` で写しが1つ消えた**(台帳 `J-G27`〜`J-G29` / `ADR-0301`)---
//
// **ここに在ったもの(逐語で残す)**:
//
// ```
// /**
//  * (4) **実行層**。`src/server/owner-scope.ts` の `VIEW_AUDIENCE_VALUES`(:629)。
//  *
//  * **ここだけは値が2つのリテラルに割れている** —— 4ロールの `AUDIENCE_ROLES`(:606)と
//  * `ANONYMOUS_AUDIENCE`(:615)の**合成**である。`ADR-0074` §3a-4 が「項目単位の宣言へ
//  * 匿名を持ち込んではならない」と定めたため、**1つの定数を共有できない**のがその理由
//  * (`owner-scope.ts` のコメントの逐語)。**合成の形そのものは別の検査で固定する。**
//  */
// function enforcementValues(): string[] { ... }
// ```
//
// **消した理由**: **`src/server/owner-scope.ts` の `AUDIENCE_ROLES` と
// `VIEW_AUDIENCE_VALUES` は、4層(`view.audience` / `field.audience` / `field.writable_by` /
// `view_action.audience`)の値域として在ったものであり、その4層が廃止されて参照が0本に
// なったため撤去された**(同ファイルの跡地コメントの逐語:「**`AUDIENCE_ROLES`
// (`["owner","editor","viewer","customer"]`)も消えた** —— **4層すべての値域だったので、
// 4層が消えて参照が0本になった。**」)。**抽出しようとすると throw する。**
//
// **【この写しが在った理由も一緒に消えた。誇張しない】** **本ファイルの冒頭の doc が
// 「**`src/server/owner-scope.ts` を直し忘れる** → `viewAudienceDeclaration` の `filter` が
// 未知の値を**黙って捨てる**」を3つの壊れ方の1つとして挙げていたが、**その `filter` は
// 今日存在しない。** **面の判定(`judgeRoleAccess`)はロールの値域を1つも列挙せず、
// 主体の綴りと規則の綴りを直接突き合わせるので、「未知の値を黙って捨てる」形にならない。**
// **したがってここは「検査が測る対象を失った」のであって、見張りを緩めたのではない。**
//
// **【残る2箇所は今日も写しである。1本も消していない】** —— (2) 生成器 / (3) 監査スクリプト。
// **その2つが独立した写しであることは `ADR-0025` §4-6 の要請そのもの**(「**監査スクリプトは
// 生成器を1行も import しない**」)**であり、今日も生きている。**

type Site = { readonly where: string; readonly values: string[] };

/** **正準を先頭に置く。** 不一致の報告は先頭を基準に書く。 */
function sites(): Site[] {
  return [
    { where: "src/kernel/requirements-doc.ts (AUDIENCE_ROLES)", values: canonicalValues() },
    { where: "scripts/cp-v1-8-audit.ts (AUDIENCE_ROLES)", values: auditRoles() },
  ];
}

/**
 * 正準との差を、**箇所ごとに「足りない値」と「余分な値」で**書き下す。
 * 一致していれば空文字を返す(`expect(...).toBe("")` が読める形)。
 */
function driftReport(all: Site[]): string {
  const canonical = all[0] as Site;
  const base = new Set(canonical.values);
  const lines: string[] = [];
  for (const site of all.slice(1)) {
    const set = new Set(site.values);
    const missing = [...base].filter((value) => !set.has(value));
    const extra = [...set].filter((value) => !base.has(value));
    if (missing.length > 0 || extra.length > 0) {
      lines.push(
        `${site.where}: 足りない=[${missing.join(", ")}] 余分=[${extra.join(", ")}]` +
          ` / 正準(${canonical.where})=[${canonical.values.join(", ")}]`,
      );
    }
  }
  return lines.join("\n");
}

// --- 検査 -------------------------------------------------------------------------------

// **【`V8-M20` / `ADR-0301`】期待値を 4 → 2 に変えた。旧の逐語**:
//   test("V4-M40: 役割の値の写しは4箇所から実際に取り出せている(空回りで緑にならない)", ...)
//   expect(all).toHaveLength(4);(その後 3 を経ずに 2 になった —— 正準側も同じ日に消えた)
// **理由は上の「(4) 実行層」の節に書いた**(写しの1つが、それを必要としていた4層ごと消えた)。
test("V4-M40: 役割の値の写しは2箇所から実際に取り出せている(空回りで緑にならない)", () => {
  const all = sites();
  expect(all).toHaveLength(2);
  for (const site of all) {
    // 1箇所でも抽出に失敗すれば上の関数が投げるので、ここに来た時点で「読めた」ことは確定。
    // それでも**件数**を測る —— 空配列を「一致」と読ませないため。
    expect(site.values.length, site.where).toBeGreaterThan(0);
    // 同じ値が2度書かれていると集合比較が食い違いを隠す。
    expect(new Set(site.values).size, `${site.where} に重複がある`).toBe(site.values.length);
  }
});

// **【`V8-M20`】テスト名の「4箇所」を「2箇所」にした。旧の逐語**:
//   test("V4-M40: 4箇所の役割の値の集合が完全一致する(部分集合では通さない)", ...)
// **本体は1バイトも変えていない**(比較の対象が `sites()` の返り値だからである)。
test("V4-M40: 2箇所の役割の値の集合が完全一致する(部分集合では通さない)", () => {
  const all = sites();
  // **本体。** 失敗時は「どこに何が足りず、どこに何が余分か」がそのまま出る。
  expect(driftReport(all)).toBe("");
  // 完全一致は「差が無い」だけでは足りない —— 件数も測る(片方に重複が在る場合の保険)。
  const canonical = all[0] as Site;
  for (const site of all) {
    expect([...site.values].sort(), site.where).toEqual([...canonical.values].sort());
  }
});

// **【`V8-M20` / 台帳 `J-G27` / `ADR-0301`。検査を1本消した。逐語を残す】**
//
// **消したテスト名**: 「V4-M40: 実行層の5値は AUDIENCE_ROLES と ANONYMOUS_AUDIENCE の
// 合成のままである」。
// **消した本体**:
// ```
//   // **4箇所目だけは値が2つのリテラルに割れている。** 合成の形が変わると、上の抽出は
//   // 古い側だけを読んで**静かに緑**になりうる。形そのものをここで固定する。
//   const source = read("src", "server", "owner-scope.ts");
//   const composition = [
//     ...source.matchAll(
//       /^const VIEW_AUDIENCE_VALUES\s*:[^=\n]*=\s*\[\.\.\.AUDIENCE_ROLES,\s*ANONYMOUS_AUDIENCE\]\s*;/gm,
//     ),
//   ];
//   expect(composition.length, "…").toBe(1);
// ```
// **消した理由**: **`VIEW_AUDIENCE_VALUES` も `AUDIENCE_ROLES` も
// `src/server/owner-scope.ts` から撤去された**(4層の値域であり、4層が廃止された)。
// **「その合成の形が保たれているか」を問う相手が1つも無い。**
// **面の側に置き直せるものが無い** —— **面の判定はロールの値域を列挙しない。**

test("V4-M40: 今日の固定部分は5つである(6値目が入ったら、この検査も含めて見直す)", () => {
  // **この1本だけは、本検査自身が値を書き下している** —— つまり**写しが1つ増えている。**
  // 意図的である: 値域を広げる差分が**この検査を必ず踏む**ようにするための目印であり、
  // 既存の作法(`src/auth/role-vocabulary-sync.test.ts` / `src/server/view-audience.test.ts`
  // も同じく値を書き下している)に合わせている。**沈黙ではなく赤で気づかせる側の写しである。**
  // **6値目を足すには改めて門A が要る**(`ADR-0074` §3a-5)。
  //
  // **【`V5-M17-T07`】測る対象を「スキーマの `enum`」から「参照整合検査の固定部分」に
  // 移した。値は5つのままである** —— **アプリが宣言した種類はここに現れない。**
  //
  // **【`V8-M20`】測る対象を「参照整合検査の固定部分」から「生成器の `AUDIENCE_ROLES`」へ
  // 移した**(`canonicalValues()` の中身が変わっただけで、この行は1バイトも変えていない)。
  // **参照整合検査の側は撤去された。** **値は今日も5つのままである。**
  expect([...canonicalValues()].sort()).toEqual([
    "anonymous",
    "customer",
    "editor",
    "owner",
    "viewer",
  ]);
});

// **【`V8-M20` / 台帳 `J-G27` / `ADR-0301`。検査は消していない。当て先を面へ移した】**
// **旧本体の逐語**:
// ```
//   const schema = JSON.parse(read("schemas", "manifest.schema.json")) as {
//     $defs: { view: { properties: { audience: { items: Record<string, unknown> } } } };
//   };
//   const items = schema.$defs.view.properties.audience.items;
//   expect(items.enum).toBeUndefined();
//   expect(items.pattern).toBe("^[a-z0-9_]{1,32}$");
// ```
// **`$defs/view/properties/audience` は `V8-M20` が撤去したので、読む場所が無い。**
// **同じ問い(「スキーマは役割の値を1つも列挙しておらず、値域はアプリのデータに在る」)は、
// 今日 `$defs/app/properties/roles/items/properties/id` について立つ** —— **綴りの規則
// (`pattern`)まで同じ1本である。**
test("V5-M17-T07: スキーマはもう値を1つも列挙していない(値域はアプリのデータに移った)", () => {
  // **`ADR-0159` §1 (a) が不利な材料として自ら挙げた「検査層が1つ減る」ことの実測である。**
  // **`enum` が戻ってきたら赤くなる**(戻すと宣言された種類が書けなくなる)。
  const schema = JSON.parse(read("schemas", "manifest.schema.json")) as {
    $defs: {
      app: { properties: { roles: { items: { properties: { id: Record<string, unknown> } } } } };
    };
  };
  const id = schema.$defs.app.properties.roles.items.properties.id;
  expect(id.enum).toBeUndefined();
  expect(id.pattern).toBe("^[a-z0-9_]{1,32}$");
});
