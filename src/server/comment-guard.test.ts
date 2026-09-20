/**
 * `V10-M15-T04`(台帳 `CM-G18`。**門外** / 限定採用 / 個別 ADR 無し)—— **本軸の最後の実装タスク**。
 *
 * ## この検査が主張すること
 *
 * > **素通りを止めていることの見張りを5本置く。**
 *
 * **【禁止】「荒らし対策を入れた」とは1文字も主張しない。** **入れていない。**
 * **入れていないことを見張るだけである。**(`(cg5)` = レート制限を1つも掛けていないことの見張り)。
 *
 * `PLAN-M15.md` §7-2 が定める5本 —— `(i-a)` コメントの器の中身が人の操作を経ずに定義の本体へ
 * 流れる経路が無いこと(`cg1`)/ `(i-b)` 差分を当てる道具がコメントの器を読み書きしないこと(`cg2`)/
 * `(ii)` 可視性の合成を通らずにコメントを読める製品コードが無いこと(`cg3`)/ `(iv)` 対応できない
 * という値から対応済みへ機械が倒す経路が無いこと(`cg4`)/ `(v)` 匿名の書込の口にレート制限が
 * 1つも掛かっていないこと(`cg5`)。
 *
 * ## 型(限定2・限定5)
 *
 * `SRC_ROOT` / `productionSources` / `callersOf` は
 * `src/server/escape-hatch-issuance.test.ts` の `:424`(`SRC_ROOT`)/ `:427`-`:445`
 * (`productionSources`)/ `:447`-`:452`(`callersOf`)からの**逐語の写し**である。
 * **2つ目の型を作らない**(限定2)。 **この検査ファイルは `src/server/` に置く**
 * (限定5。`src/kernel/` に検査ファイルを1件も置かない —— `Δ8` を立てないための担保)。
 * **`src/kernel/` から値を1つも import しない**(`readFileSync` でソースを読むだけ) ——
 * **層またぎの台帳に1行も足さないため。**
 *
 * ## 裁定1(`RULINGS-M15.md`)—— 見張りは注釈を除いてから数える
 *
 * `(cg4)` と `(cg5)` は、書いたその場で偽になる見張りだった:
 *
 * - `(cg5)`: 切り出し範囲(`auth-routes.ts` の `【V10-M11-T01 ハンドラ ここから】`〜
 *   `ここまで`)の**内側**(今日 `:3541` 付近)に `authLimiter` / `publicGetLimiter` の
 *   綴りが**注釈として実在する**(「この口はどのリミッタにも入らない」と説明する行)。
 * - `(cg4)`: `not_applicable` が `auth-routes.ts`(`commentUpdateShapeError` の `hint`
 *   フィールドの例示文字列)に、`"open"` が `types.ts`(`RoleDeclaration.signup` の型
 *   リテラル)に**実在する**。
 *
 * **裁定**: 走査対象から注釈(`//` 行と `/* … *\/` ブロック)を機械で落としてから数える
 * (`stripComments`。5本の見張りのうち、注釈残置の影響を受ける `(cg4)` `(cg5)` がこれを使う)。
 * **数え方の宣言はこの docstring と各 `test(...)` の直上のコメントに書く。**
 *
 * ### `(cg4)` について、計画の記述からもう1段深掘りした点(実測が崩した先行の記述)
 *
 * 上の `not_applicable`(`auth-routes.ts` の `hint` 例示文字列)と `"open"`
 * (`types.ts` の `signup?: "open" | "invite"` という型リテラル)は、**どちらも `//` や
 * `/* *\/` の注釈ではなく、実在する製品コードの文字列リテラル・型リテラルである。**
 * **`stripComments` を通しても消えない。** そのため計画 §7-2 が書いた「`3値の綴りが
 * 1文字も無い`」を字面どおり(3つの綴りをそれぞれ独立に、全製品コードへ素の部分文字列検索で
 * 当てる)実装すると、`comment-store.ts` 以外の製品コードでも**今日すでに非0になり**、
 * 見張りとして成立しない(`裁定1`の「期待値を実物に合わせて非0にしない」に反する)。
 *
 * **この検査が採る形**: 3値(`"open"` / `"not_applicable"` / `"applied"`、**引用符つきで
 * 数える** —— 引用符無しだと `openStore` や `applied_at` のような無関係な識別子まで拾う)が
 * **同じ1本の製品コードに全部そろって実在する**ことを見張る(`comment-store.ts` を除く)。
 * `types.ts` は `"open"` だけ、`auth-routes.ts` は `"not_applicable"` だけであり、
 * どちらも3値そろってはいないので、今日はこの形で**0**になる。 **この形は「3値のうち1つか
 * 2つだけを別の製品コードが綴る」ケースを捕まえない**(`§5` の限界に立てる)。
 *
 * ## 注釈を落とす処理が巻き込みうるもの(黙って落とさない)
 *
 * `stripComments` は `//` から行末までを機械的に落とすので、**文字列リテラルの中の `//`**
 * (例: URL)も巻き込みうる。 実際に `src/server/auth-routes.ts:4112` の
 * `hint: "例: https://openrouter.ai/api/v1。"` は、この関数を通すと `https:` から
 * 行末までが丸ごと落ちる —— **この行は本ファイルが検索する識別子(`gp_comments` /
 * `CommentStore` / `visibleComments` / 3値の綴り / `authLimiter` 等)を1つも含まないため、
 * 今日の5本の判定結果には影響しない。** が、巻き込みが**起きること自体**をここに書く。
 *
 * ## `(cg4)` の3値の綴りについて(計画 §7-2 脚注の逐語)
 *
 * この検査ファイルには3値の綴りを書かざるを得ない(値域を字面で見るため)。
 * `comment-store.ts` / `comment-visibility.ts` が「注釈にも綴らない」作法を採ったのは、
 * **自分自身が走査対象になる**からである。 `comment-guard.test.ts` は走査**する側**で
 * あって、自分を走査対象に含めない —— `productionSources()` が `.test.ts` を除いている
 * (写し元 `:441` の `!entry.name.endsWith(".test.ts")`)。
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

// 写し元: src/server/escape-hatch-issuance.test.ts の SRC_ROOT(:424)/
// productionSources(:427-445)/ callersOf(:447-452)。逐語の写し。型を1つに揃える(限定2)。
const SRC_ROOT = join(dirname(import.meta.dir));

/** `src/` 配下の非テスト .ts を列挙する。 */
function productionSources(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) {
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        files.push(full);
      }
    }
  };
  walk(SRC_ROOT);
  return files.sort();
}

/** 与えた識別子を含む製品コード(非テスト)のリポジトリ相対パス一覧。 */
function callersOf(identifier: string): string[] {
  return productionSources()
    .filter((file) => readFileSync(file, "utf-8").includes(identifier))
    .map((file) => relative(dirname(SRC_ROOT), file).replaceAll("\\", "/"))
    .sort();
}

/**
 * 注釈(`//` 行コメントと `/* … *\/` ブロックコメント)を機械で落とす。
 * **`(cg4)` `(cg5)` はこの関数を通した後の文字列で数える**(裁定1)。
 * **注意**: 文字列リテラル中の `//` を巻き込みうる(上の docstring を見よ)。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

test("(cg1) (i-a) コメントの器の中身が、人の操作を1度も経ずに定義の本体へ流れる経路が無い", () => {
  // gp_comments を綴る製品コードは3本ちょうど。定義の本体を書く製品コード
  // (src/kernel/apply-diff.ts / src/kernel/apply-manifest.ts)が1件も含まれない。
  expect(callersOf("gp_comments")).toEqual([
    "src/kernel/comment-store.ts",
    "src/kernel/delete-app.ts",
    "src/server/auth-routes.ts",
  ]);
  expect(callersOf("linkCommentToDiff")).toEqual([
    "src/kernel/comment-store.ts",
    "src/server/auth-routes.ts",
  ]);
  // 陽性対照: callersOf が空振りしていない。
  expect(callersOf("readCurrentManifest").length).toBeGreaterThan(0);
});

test("(cg2) (i-b) 差分を当てる道具と経路が、コメントの器を1バイトも読み書きしない", () => {
  const targets = ["kernel/apply-diff.ts", "mcp/tools/write.ts", "server/change-routes.ts"].map(
    (p) => join(SRC_ROOT, p),
  );
  const concatenated = targets.map((f) => readFileSync(f, "utf-8")).join("\n");
  for (const id of [
    "CommentStore",
    "comment-store",
    "gp_comments",
    "linkCommentToDiff",
    "updateCommentState",
  ]) {
    expect(concatenated.includes(id)).toBe(false);
  }
  // 陽性対照: 同じ綴りを src/server/auth-routes.ts に当てると0件でない。
  const authRoutes = readFileSync(join(SRC_ROOT, "server/auth-routes.ts"), "utf-8");
  expect(authRoutes.includes("CommentStore")).toBe(true);
});

test("(cg3) (ii) 可視性の合成を通らずにコメントを読める製品コードが1本も無い", () => {
  // **【引き直しの理由 —— `V10-M30-T01`(台帳 `CM-G36` / `ADR-0377`)】**
  // `V10-M30-T01` が `apps` 表に**アプリごとの表示設定**の列を2本
  // (`comment_write_enabled` / `comment_read_enabled`)足し、
  // その読み出しに `getCommentVisibility` という名前を付けた。
  // **旧の式は素の識別子(`"getComment"`)を `includes` で当てていたので、
  // `getCommentVisibility` の中に部分一致し、`src/kernel/meta-store.ts` が
  // 偽陽性で readers に入っていた。** `meta-store.ts` はコメントの行を1件も読まない
  // (`gp_comments` を1度も開かず、`CommentStore` を1度も呼ばない)。
  // **引き直したのは「読む製品コードを数える」代理の式であって、担保ではない。**
  // 素の識別子 → **呼び出しの形**(末尾の `(` まで)に変えただけであり、
  // 当たる集合は真に狭まる(部分一致・import 文・JSDoc が落ちる)方向にしか動かない。
  // **精度を上げる向きの直しであって、1ミリも弱めていない。**
  // これは、すぐ下の注記が `visibleComments(` について書いているのと同じ教訓を、
  // 読み手側の3つの綴りにも当てたものである。
  // **【禁止】これを「コメントを読める製品コードの範囲を緩めた」と読まない。**
  //
  // **【`V10-M30` の独立点検 B-3(2026-08-25)。上の6行は1バイトも消していない】**
  // **上の「1ミリも弱めていない」は偽だった。** 点検が実測で2つの穴を見つけた ——
  // **`V10-M30-T01` が入れた呼び出しの形(`"getComment("` の素の `includes`)は、
  // 旧の式(素の識別子 `"getComment"` の `includes`)が捕まえていた次の2形を見逃す**:
  //
  // | 綴り | 素の識別子(旧) | 呼び出しの形(`V10-M30-T01`) | 正規表現(今日) |
  // |---|---|---|---|
  // | `store["getComment"](id)` | 当たる | **見逃す** | 当たる |
  // | `store.getComment (id)`(空白入り) | 当たる | **見逃す** | 当たる |
  // | `store.getComment(id)` | 当たる | 当たる | 当たる |
  // | `store.getCommentVisibility(appId)` | **偽陽性** | 当たらない | 当たらない |
  //
  // **したがって `V10-M30-T01` の引き直しは、偽陽性(`getCommentVisibility`)を1件落とす
  // 代わりに、真陽性を2形ぶん落としていた** —— **「当たる集合が真に狭まる方向にしか動かない」
  // ことは正しかったが、「狭まった中身が全部余計だった」わけではない。**
  // **本工程はその2形を式に取り込んだ**(下の `readerCallPattern`)。
  // **今日の言い方**: **偽陽性を1件落としたまま、旧の式が捕まえていた2形を取り戻した** ——
  // **旧の3つの式のどれとも当たる集合が違う**(素の識別子より狭く、呼び出しの形より広い)。
  // **陽性対照と陰性対照を、この test の中に実物として置く**(下)。
  const READER_METHODS = ["listComments", "listCommentsByState", "getComment"] as const;
  /**
   * **呼び出している形**に当たる正規表現。3形のどれかに当たれば真とする ——
   * `メソッド名 (` (空白可) / `["メソッド名"]` / `['メソッド名']`。
   * **`getCommentVisibility` には当たらない**(`getComment` の直後は `V` であって
   * `\s*(` でも `"]` でもない)。
   */
  const readerCallPattern = (method: string): RegExp =>
    new RegExp(`${method}\\s*\\(|\\["${method}"\\]|\\['${method}'\\]`);
  const readerPatterns = READER_METHODS.map(readerCallPattern);
  const readers = productionSources()
    .filter((f) => !f.endsWith("kernel/comment-store.ts"))
    .filter((f) => {
      const content = readFileSync(f, "utf-8");
      return readerPatterns.some((re) => re.test(content));
    })
    .map((f) => relative(dirname(SRC_ROOT), f).replaceAll("\\", "/"))
    .sort();
  // **陽性対照(細工した綴り)** —— 点検が名指しした2形を含め、5つとも新しい式に当たる。
  for (const crafted of [
    'store["getComment"](id)',
    "store.getComment (id)",
    "store.getComment(id)",
    "store['getComment'](id)",
    "store.listComments (appId)",
  ]) {
    expect(readerPatterns.some((re) => re.test(crafted))).toBe(true);
  }
  // **陰性対照** —— `V10-M30-T01` が足した `apps` 表の表示設定の読み書き(コメントの行を
  // 1件も読まない)には1つも当たらない。**偽陽性は戻っていない。**
  for (const crafted of [
    "store.getCommentVisibility(appId)",
    'store["getCommentVisibility"](appId)',
    "store.setCommentVisibility(appId, patch)",
    "  getCommentVisibility(appId: string): CommentVisibility | undefined {",
  ]) {
    expect(readerPatterns.some((re) => re.test(crafted))).toBe(false);
  }
  // 今日の実物は src/mcp/tools/read.ts と src/server/auth-routes.ts の2本。
  expect(readers).toEqual(["src/mcp/tools/read.ts", "src/server/auth-routes.ts"]);
  // **呼び出しの形(`visibleComments(`)で見る** —— 素の識別子(`visibleComments`)だと
  // import 文や JSDoc の説明文(呼び出しを1度も伴わない)にも当たり、実際に呼び出しを
  // 1本外しても赤くならないことを段4で確かめた(実測が崩した先行の記述。§4)。
  for (const relPath of readers) {
    const content = readFileSync(join(dirname(SRC_ROOT), relPath), "utf-8");
    expect(content.includes("visibleComments(")).toBe(true);
  }
  // 陽性対照: visibleComments を含む製品コードは0本でない。
  expect(callersOf("visibleComments").length).toBeGreaterThan(0);
});

test("(cg4) (iv) 対応できないという値から対応済みへ、機械が倒す経路が1本も無い —— 注釈を落としてから数える", () => {
  expect(callersOf("updateCommentState")).toEqual([
    "src/kernel/comment-store.ts",
    "src/server/auth-routes.ts",
  ]);

  // 3値(引用符つき)。素の綴りは comment-store.ts 以外にも今日すでに実在する
  // (types.ts の型リテラル "open" / auth-routes.ts の例示文字列 "not_applicable") ——
  // どちらも注釈ではないので stripComments でも消えない。それぞれ独立の陽性対照として貼る。
  const literals = ['"open"', '"not_applicable"', '"applied"'];
  const others = productionSources().filter((f) => !f.endsWith("kernel/comment-store.ts"));

  const rawOpenFiles = others
    .filter((f) => readFileSync(f, "utf-8").includes('"open"'))
    .map((f) => relative(dirname(SRC_ROOT), f).replaceAll("\\", "/"));
  const rawNotApplicableFiles = others
    .filter((f) => readFileSync(f, "utf-8").includes('"not_applicable"'))
    .map((f) => relative(dirname(SRC_ROOT), f).replaceAll("\\", "/"));
  // 陽性対照(i)注釈を落とす前: どちらも0件でない(裁定1がわざと壊さなくても今日すでに非0)。
  expect(rawOpenFiles).toEqual(["src/kernel/types.ts"]);
  expect(rawNotApplicableFiles).toEqual(["src/server/auth-routes.ts"]);

  // 本体: 3値が同じ1本の製品コードに全部そろって実在するファイルは comment-store.ts 以外に無い。
  const coLocated = others
    .filter((f) => {
      const stripped = stripComments(readFileSync(f, "utf-8"));
      return literals.every((lit) => stripped.includes(lit));
    })
    .map((f) => relative(dirname(SRC_ROOT), f).replaceAll("\\", "/"));
  expect(coLocated).toEqual([]);

  // 陽性対照(ii): comment-store.ts 自身は(注釈を落としても)3値がそろっている。
  const selfStripped = stripComments(
    readFileSync(join(SRC_ROOT, "kernel/comment-store.ts"), "utf-8"),
  );
  expect(literals.every((lit) => selfStripped.includes(lit))).toBe(true);
});

test("(cg5) (v) 本軸が足した匿名の書込の口に、レート制限が1つも掛かっていない —— 注釈を落としてから数える", () => {
  const source = readFileSync(join(SRC_ROOT, "server/auth-routes.ts"), "utf-8");
  const lines = source.split("\n");
  const startIdx = lines.findIndex((l) => l.includes("【V10-M11-T01 ハンドラ ここから】"));
  const endIdx = lines.findIndex((l) => l.includes("【V10-M11-T01 ハンドラ ここまで】"));
  expect(startIdx).toBeGreaterThan(-1);
  expect(endIdx).toBeGreaterThan(startIdx);
  const rangeRaw = lines.slice(startIdx, endIdx + 1).join("\n");
  const pattern = /authLimiter|publicGetLimiter|RateLimiter|\.hit\(/;

  // 陽性対照(i)注釈を落とす前: 行ベース(grep -c と同じ数え方)で2ではなく1
  // (「authLimiter」「publicGetLimiter」の両方の綴りが同じ1行の注釈に同居しているため)。
  const rawMatchingLines = rangeRaw.split("\n").filter((l) => pattern.test(l));
  expect(rawMatchingLines.length).toBe(1);

  const strippedRange = stripComments(rangeRaw);
  const strippedMatchingLines = strippedRange.split("\n").filter((l) => pattern.test(l));
  expect(strippedMatchingLines.length).toBe(0);

  // 陽性対照(ii): src/server/app.ts 全体では publicGetLimiter.hit( が0件でない。
  const appTs = readFileSync(join(SRC_ROOT, "server/app.ts"), "utf-8");
  expect(appTs.includes("publicGetLimiter.hit(")).toBe(true);
});
