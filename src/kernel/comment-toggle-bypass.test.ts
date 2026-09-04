/**
 * **コメントの出し入れが素通りしていないことの見張り**
 * (`V10-M34-T02` / 台帳 `CM-G46` /
 * [`ADR-0380`](../../../../docs/adr/0380-comment-toggle-bypass-guard.md))。
 *
 * ## 置き場について(**門の根拠がここに掛かっている**)
 *
 * **本ファイルは `apps/smailtalk/src/kernel/` の下に在る。** **これは意図した置き場である。**
 * `ADR-0007` の `Δ7` の逐語は「`src/kernel/` **と** `schemas/` が **1バイトも変わらない**」で
 * あり、`*.test.ts` を除くとは1文字も書いていない。**したがって本単位は `Δ7` を主張せず、
 * 門A(catch-all)で審査を受けた。** **【禁止】緑にするため / 門外に見せるために、本ファイルを
 * `apps/smailtalk/scripts/` や `apps/smailtalk/web/test/` へ移さない**(`ADR-0380` 限定2 /
 * §4 の1)。**移すと門の根拠が崩れる。** 先例は `CM-G34`(`ADR-0374` の見張り)。
 *
 * ## 見張るものは **4つちょうど**(`ADR-0380` §Decision 1 / 限定1)
 *
 * | # | 見張るもの | 赤くなる条件 |
 * |---|---|---|
 * | **(a)** | **出し分けの判定の住所** | **判定の本体が `web/src/views/ViewHost.tsx` の外に生えたら赤 / 同ファイルの中で2つから動いたら赤** |
 * | **(b)** | **配布物の見張りにコメントの目印が載っていること** | **`web/test/runner-entry-boundary.test.ts` の `FORBIDDEN` からコメントの目印が1本でも落ちたら赤** |
 * | **(c)** | **設定を読む経路が1本** | **取得口 / 読む側 / 載せ口 のどれかが2本目になったら赤** |
 * | **(d)** | **既定が OFF** | **DDL の既定 / 応答の既定 / 画面側の fail-closed のどれか1箇所でも ON へ倒れたら赤** |
 *
 * **【禁止】5つ目の見張りを本ファイルに足さない**(`ADR-0380` 限定1 / §4 の3)。
 * **足すなら改めて審査を通し、`ADR-0380` と同格の個別 ADR を新規に書く。**
 *
 * ## (a) を **数の式**で書く理由(`ADR-0380` 限定8 / §4 の6)
 *
 * **逐語で固定すると、逐語の残置が検査を騙す。** —— 本ファイルの着手前(2026-08-26)に
 * `web/src/views/ViewHost.tsx` へ素の `grep -c 'useContext(CommentVisibilityContext)'` を
 * 打つと **3** が返る。**うち1つ(`:190`)は `V10-M33-T01` が「旧の3行の逐語(1バイトも
 * 消していない)」として残したコメント行であり、判定ではない。**
 * **したがって (a) は「コメント行を落としてから数える」2つの式で書く。**
 *
 * ## **(a) は `ADR-0380` の逐語と食い違う**(**丸めない**)
 *
 * **`ADR-0380` §Decision 1 の (a) は「出し分けの判定が器の側 **1箇所**にしか無いこと」と
 * 書いている。** **今日の実測は **2** である**(書く欄 = `useCommentPanel` / 読む場所 =
 * `useCommentReadEnabled`)。**書く欄と読む場所はアプリごとに別の設定(`write` / `read`)で
 * あり、1つに畳むと利用者決定 `D-V10-38` / `D-V10-36` が壊れる。**
 * **`web/src/views/ViewHost.tsx` の doc は既に自分でそう書いている**(「限定2 の逐語は
 * 『出し分けの判定が `web/src/` の中で1箇所ちょうど』であり…1箇所から2箇所になった」)。
 * **【禁止】緑にするために判定を1つに畳まない。** **本ファイルは今日の実測(**2**)を採る。**
 *
 * ## **(a) が見るのは「判定の住所」であって「呼ぶ側」ではない**
 *
 * **`useCommentReadEnabled` は `export` されており、`web/src/AppWorkspace.tsx` が既に
 * 呼んでいる。** **したがって「呼ぶ側は1本だけ」は今日すでに偽である。**
 * **本ファイルは呼ぶ側を1件も数えていない** —— 数えているのは
 * `useContext(CommentVisibilityContext)` を書いた場所(= 判定の本体)だけである。
 *
 * ## **【2026-08-26。`V10-M34-T03`】(a) に (a-3) / (a-4) を足した(**旧行を1バイトも消していない**)**
 *
 * **(a-1) / (a-2) が数えているのは `useContext(CommentVisibilityContext)` という**逐語1本**だけ
 * である。** **独立点検は、コンテキストを `export` して別ファイル・別綴り(いったん変数に
 * 入れてから `useContext(変数)` と書く)で判定の本体を書き直し、(a-1) / (a-2) が
 * 5 pass / 0 fail のまま通ることを実出力で示した。**
 *
 * **本段が足した2式**(どちらも**本数を数える式**であり、逐語で1行を固定しない):
 *
 * | # | 数えるもの | 今日の値 | 赤くなる条件 |
 * |---|---|---|---|
 * | **(a-3)** | **コメントの出し入れの設定を持つ `createContext` の定義**(`web/src` 全体) | **1**(`web/src/views/ViewHost.tsx`) | **2つ目の器が生えたら赤** |
 * | **(a-4)** | **`CommentVisibilityContext` が `export` を伴って現れる行**(同) | **0** | **器の外へ持ち出したら赤** |
 *
 * **【禁止】これを「素通りを塞いだ」と書かない** —— **塞いでいない。**
 * **判定の綴りを丸ごと変える逃げ(コンテキストの名前ごと替える / 設定を別の器で運ぶ)は
 * **今日も素通りする**。** **`ADR-0380` §限界5 は「逐語の残置が検査を騙す型を、本 ADR は
 * 解かない」と自ら書いており、本段はそれを1ミリも解いていない** —— **足したのは
 * 「持ち出し口を1つに絞る」2式であって、綴りの取り替えを見る式ではない。**
 *
 * ## **【2026-08-26。`V10-M34-T03`】(c) に「器を張る箇所の本数」を足した(**これも塞いでいない**)**
 *
 * **(c) が数えていたのは、サーバ側の綴り3種と `web/src` の綴り1種だけである。**
 * **本段は「`CommentVisibilityProvider` を**実体化**している箇所が `web/src/` に1つだけ」を
 * 足した** —— **定義(`web/src/views/ViewHost.tsx` の1本)と実体化
 * (`web/src/AppWorkspace.tsx` の1本)を**数え分けている**。**
 *
 * **【必ず読む】サーバを1バイトも触らない2本目の設定経路は、この式でも今日も素通りする。**
 * **独立点検は、器へ渡す `value` の式をブラウザ側の保存領域から読む形に差し替え、
 * リポジトリ全体(`bun test web/test` = **1727 pass / 0 fail**)が緑のままであることを
 * 実出力で示した。** **本段の (c) はその形を1件も捕まえない** —— **`value` に**何が
 * 流れ込むか**を1ミリも見ていないからである**(数えているのは器を張った箇所の本数だけ)。
 * **これは `ADR-0380` §限界4「見張るのは4つであって、4つで足りることを本 ADR は1つも
 * 示していない」の実例である。**
 *
 * ## (d) が **3箇所とも**当てる理由
 *
 * **1箇所だけを読む見張りは、他の2箇所が倒れても緑のままである。**
 * 既定 OFF は次の3つが揃って初めて成り立つ:
 * **DDL の既定(`src/kernel/meta-store.ts`)/ 応答の既定(`src/server/app.ts`)/
 * 画面側の fail-closed(`web/src/views/ViewHost.tsx`)。**
 * **これは「5つ目の見張りを足す」ことではない** —— **(d) 1つの中身である。**
 *
 * ### **【2026-08-26。`V10-M34-T03`。旧行を1バイトも消していない】訂正 —— 既定 OFF を成立させているのは「3つ」ではなく **4つ**である**
 *
 * **直上の「既定 OFF は次の3つが揃って初めて成り立つ」は、書いたその日にすでに偽であった。**
 * **4箇所目は `src/kernel/meta-store.ts` の `toCommentVisibility` である** —— **台帳の
 * `0` / `1` を真偽へ写す場所であり、`row.comment_write_enabled !== 0` の `0` を別の値へ
 * 倒すだけで、DDL の既定も応答の `?? false` も画面の `=== true` も1バイトも動かないまま、
 * **全アプリの既定が ON になる**。** **独立点検が実際に倒し、(d) が 5 pass / 0 fail のまま
 * 通ることを実出力で示した。**
 * **したがって (d) は今日 **4箇所**を当てる。** **これは「5つ目の見張りを足す」ことではない**
 * —— **(d) 1つの中身が3箇所から4箇所になっただけであり、`ADR-0380` 限定1 を破らない。**
 *
 * ## **本ファイルが1件も捕まえないもの**(誇張しない。`ADR-0380` §限界)
 *
 * 1. **画面の壊れを1件も捕まえない。** `bun test` は `web/e2e/*.e2e.ts` を1本も拾わないので、
 *    **実際に書く欄が消えることは `bun run test:e2e` を別に打つまで1ミリも見ていない。**
 * 2. **(d) は既定値を書いた行を読むだけである。** 実際に既定 OFF のアプリで欄が出ないことを
 *    走らせて確かめていない。
 * 3. **配布データの `gp_comments` の行は本ファイルの外である。** `skippedTables` は計算式で
 *    あり、`gp_comments` は配布データへコピーされる。**落とすのは別単位の持ち物である。**
 * 4. **口の開閉を1件も見ていない。** `POST /api/apps/:app_id/comments` も MCP の
 *    `list_comments` も閉じていない(利用者決定 `D-V10-38`)。**設定が OFF でも口を直に
 *    叩けば今日どおり応答が返る。** **【禁止】本ファイルの緑を「素通りを止めた」と読まない。**
 * 5. **「素通り」の全量を数え切っていない。** 見張るのは4つであって、4つで足りることを
 *    本ファイルは1つも示していない。
 * 6. **見張りは AI に1文字も渡らない**(`ADR-0380` 限定6)。 **AI が素通りの経路を作っても、
 *    説明の側からは1文字も分からない。**
 * 7. **(b) の `FORBIDDEN` は目印の文字列そのものを見るので、逐語の残置が検査を騙す型の
 *    外に出られない。** **本ファイルはその型を解かない。**
 * 8. **(b) の目印を `FORBIDDEN` に入れたのは前段(`V10-M33-T01` が 18 → 27)である。**
 *    **本ファイルはそれを実測で確かめているだけであり、本単位が (b) を置いたのではない。**
 * 9. **【2026-08-26。`V10-M34-T03`】本ファイルを丸ごと空にしても、リポジトリのどこも
 *    赤くならない。** **本ファイルを参照している検査は **0本**であり、`Ran N tests across
 *    M files` の `files` が 441 → 440 に落ちても誰も気づかない**(独立点検が実測した)。
 *    **この穴は今日も開いている。** **【禁止】直したと書かない** —— **塞ぐには5つ目の
 *    見張りを足す(`ADR-0380` 限定1 を破る)か、宣言5本の外のファイルを触る
 *    (`ADR-0007:221` の歯止め1 を破る)かのどちらかが要り、どちらも改めて審査を通す
 *    必要があるので、本段は1バイトも直していない。**
 *
 * ## **【2026-08-26。`V10-M36-T01a`。旧行を1バイトも消していない】5つ目の見張り (e) を足した**
 *
 * **上の「**【禁止】5つ目の見張りを本ファイルに足さない**」(`ADR-0380` 限定1 / §4 の3)と、
 * 直上の §9「**この穴は今日も開いている**」は、`ADR-0381` が `ADR-0380` 限定1 の
 * 「**4つちょうど / 5つ目を足さない**」の**その1点だけ**を引き直したことで、今日は当たらない。**
 * **旧行は1バイトも消していない。** **`ADR-0380` 限定2〜限定8 と `ADR-0379` の限定は
 * **1点も**動いていない**(`ADR-0381` 限定7)。
 *
 * | # | 見張るもの | 赤くなる条件 |
 * |---|---|---|
 * | **(e)** | **見張りそのものが空でないこと** | **本ファイルの `test()` が0本になったら赤 / (a)〜(e) の5つのどれかが名前ごと消えたら赤 / 6つ目の見張りが生えたら赤** |
 *
 * **【禁止】6つ目の見張りを本ファイルに足さない**(`ADR-0381` 限定1 / §4 の1)。
 * **足すなら改めて審査を通し、`ADR-0381` と同格の個別 ADR を新規に書く。**
 *
 * ### **(e) が1件も捕まえないもの(誇張しない。`ADR-0381` §限界1 / §4 の6)**
 *
 * 1. **【禁止】(e) を根拠に「見張りは骨抜きにされない」と書かない。** **(e) が見るのは
 *    「空でないこと」だけである** —— **`test()` の殻を残したまま中身を
 *    `expect(true).toBe(true)` に置き換える形は **今日も素通りする**。**
 *    **`V10-M36-T01a` が実際にその形を作り、(a)〜(d) を骨抜きにしても (e) を含めて
 *    緑のまま通ることを実出力で示した。**
 * 2. **本ファイルを丸ごと空にする / 消す形は、(e) でも塞げていない。** —— **(e) は本ファイルの
 *    中に居るので、本ファイルが消えれば (e) も走らない。** **空にすると `bun test` は
 *    `0 pass / 0 fail / Ran 0 tests across 1 file` を返し、リポジトリのどこも赤くならない**
 *    (`V10-M36-T01a` が実測。全体は 9454 → 9447 pass / **0 fail** で、`files` は 441 のまま)。
 *    **(訂正 `V10-M36-T08` = 独立点検の反映。2026-08-26。**上の行を1バイトも消していない**:
 *    **左辺の `9454` は (e) を足す**前**の分母である。** **(e) を足した後の着手前は `9455` で、
 *    本ファイルの `test()` **8本**が落ちて `9447` になる。** **`9455 − 8 = 9447` / `9454 − 7 = 9447`
 *    と、数としては両立してしまうので、右辺だけを見ても食い違いに気づけない。**
 *    **今日打った実出力**: `cd apps/smailtalk && bun test` →
 *    `9455 pass / 1 skip / 0 fail / Ran 9456 tests across 441 files`。
 *    `LC_ALL=C /usr/bin/grep -cE '^[ \t]*test\(' src/kernel/comment-toggle-bypass.test.ts` → `8`。
 *    **陰性対照**(実在しない綴りで同じ式): `^[ \t]*testZZZ\(` → `0`。)**
 *    **したがって `ADR-0381` 限定5 の (ii)「ファイルを空にした状態で (e) が fail すること」は
 *    **満たせていない**。** **満たすには本ファイルの外に数える側を置く必要があり、それは
 *    `ADR-0381` 限定2(新設ファイルを1本も作らない)と当たる。** **【禁止】これを
 *    「塞いだ」と書かない。**
 */

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

const ROOT = dirname(dirname(import.meta.dir));

/** 判定の本体の綴り。**この1本だけを数える**(呼ぶ側は数えない)。 */
const DECISION_CALL = "useContext(CommentVisibilityContext)";

/**
 * **【2026-08-26。`V10-M34-T03`】判定のコンテキストの綴り**(= 判定の住所そのものを
 * 名指しする1本)。 **(a-3) / (a-4) が使う。**
 */
const DECISION_CONTEXT = "CommentVisibilityContext";

/** 判定の本体が住んでよい唯一のファイル(`ROOT` からの相対、POSIX 表記)。 */
const DECISION_HOME = "web/src/views/ViewHost.tsx";

/**
 * **コメント行を落とす。**
 *
 * **これが (a) の中心である** —— 素の `grep -c` は「1バイトも消していない」逐語の残置を
 * 拾い、着手前の値が **3** になる。**落とすのは行頭(前置の空白を除く)が 行コメントの `//`・
 * doc の継続の `*`・ブロックコメントの開きと閉じ、のいずれかで始まる行だけであり、
 * 行の途中に現れる `//` は落とさない**(URL などを壊さないため)。
 */
function codeLines(source: string): string[] {
  return source.split("\n").filter((line) => {
    const head = line.trimStart();
    return !(
      head.startsWith("//") ||
      head.startsWith("*") ||
      head.startsWith("/*") ||
      head.startsWith("*/")
    );
  });
}

/** `.ts` / `.tsx` を再帰で集める(`ROOT` からの相対・POSIX 表記で返す)。 */
function collectSources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectSources(full));
      continue;
    }
    if (/\.tsx?$/.test(entry.name)) found.push(relative(ROOT, full).split(sep).join("/"));
  }
  return found;
}

function readFromRoot(relPath: string): string {
  return readFileSync(join(ROOT, ...relPath.split("/")), "utf-8");
}

// ---------------------------------------------------------------------------
// (a) 出し分けの判定の住所
// ---------------------------------------------------------------------------

test("(a-1) V10-M34-T02 / CM-G46: 出し分けの判定の本体を持つファイルは web/src の中で1本だけである", () => {
  const files = collectSources(join(ROOT, "web", "src")).filter((relPath) =>
    codeLines(readFromRoot(relPath)).some((line) => line.includes(DECISION_CALL)),
  );
  // **数の式で書く**(逐語で1行を固定しない。`ADR-0380` 限定8)。
  expect(files).toEqual([DECISION_HOME]);
  expect(files.length).toBe(1);
  // **2本目のファイルに判定の本体が生えたら、ここが赤くなる。**
});

test("(a-2) V10-M34-T02 / CM-G46: 判定の本体は器の中に2つちょうど(書く欄1つ・読む場所1つ)である", () => {
  const source = readFromRoot(DECISION_HOME);
  // **素の数(コメント行を含む)も並べて持つ** —— 逐語の残置がここに効くことを隠さない。
  const rawCount = source.split("\n").filter((line) => line.includes(DECISION_CALL)).length;
  const codeCount = codeLines(source).filter((line) => line.includes(DECISION_CALL)).length;
  expect(codeCount).toBe(2);
  // **素の数はコメント行の分だけ多い**(着手前は 3 = 2 + 逐語の残置1)。
  // **【禁止】この不等式を「= 2」に締め直さない** —— 残置のコメントを消させる圧力になる。
  expect(rawCount).toBeGreaterThanOrEqual(codeCount);
  // **`ADR-0380` の (a) は「1箇所」と書いているが、今日の正は 2 である**(上の doc)。
  // **3つ目が生えたら、ここが赤くなる。**
});

test("(a-3) V10-M34-T03 / CM-G46: コメントの出し入れの設定を持つ createContext の定義は web/src の中で1つだけである", () => {
  // **逐語の1行を固定しない** —— **「設定を持つ器の定義」の**本数**を数える(`ADR-0380` 限定8)。**
  const defs: string[] = [];
  for (const relPath of collectSources(join(ROOT, "web", "src"))) {
    for (const line of codeLines(readFromRoot(relPath))) {
      if (/=\s*createContext</.test(line) && line.includes("Comment")) defs.push(relPath);
    }
  }
  expect(defs).toEqual([DECISION_HOME]);
  expect(defs.length).toBe(1);
  // **陽性対照(空振りで緑にならないこと)** —— `createContext` そのものは web/src に複数在る
  // (`web/src/auth/authz.tsx` の役割 / 名乗り)。**0件しか見えていないなら数えられていない。**
  const allContexts: string[] = [];
  for (const relPath of collectSources(join(ROOT, "web", "src"))) {
    for (const line of codeLines(readFromRoot(relPath))) {
      if (/=\s*createContext</.test(line)) allContexts.push(relPath);
    }
  }
  expect(allContexts.length).toBeGreaterThan(defs.length);
  // **2つ目の器が生えたら、ここが赤くなる。**
  // **【禁止】これを「素通りを塞いだ」と読まない** —— **器の名前ごと替える逃げは今日も通る。**
});

test("(a-4) V10-M34-T03 / CM-G46: 判定のコンテキストは器の外へ export されていない(export を伴う出現が0本)", () => {
  const exported: string[] = [];
  const seen: string[] = [];
  for (const relPath of collectSources(join(ROOT, "web", "src"))) {
    for (const line of codeLines(readFromRoot(relPath))) {
      if (!line.includes(DECISION_CONTEXT)) continue;
      seen.push(relPath);
      if (/\bexport\b/.test(line)) exported.push(relPath);
    }
  }
  // **式は「`export` を伴う出現が **0** である」の形である。**
  expect(exported).toEqual([]);
  expect(exported.length).toBe(0);
  // **陽性対照(空振りで緑にならないこと)** —— 綴りそのものは器の中に在る。
  // **綴りごと改名して 0件になったら、ここが赤くなる。**
  expect([...new Set(seen)]).toEqual([DECISION_HOME]);
  // **`ViewHost.tsx` の doc が「`export` していない」と書いているのは今日の実測である**
  // (`V10-M33-T01` の逐語)。 **持ち出した瞬間に、別ファイルで判定を書き直せる。**
});

// ---------------------------------------------------------------------------
// (b) 配布物にマーカーが1件も無いこと(の見張りが載っていること)
// ---------------------------------------------------------------------------

/** 配布物の見張り(`FORBIDDEN`)に載っていなければならないコメントの目印。 */
const COMMENT_MARKERS: readonly string[] = [
  // --- 書く欄5本(`web/src/CommentPanel.tsx`)---
  "comment-panel",
  "comment-body",
  "comment-submit",
  "comment-sent",
  "直したいところを書いて送れます",
  // --- 読む場所4本(`web/src/CommentList.tsx` / `web/src/AppWorkspace.tsx`)---
  "comment-list",
  "open-comment-list",
  "comment-item-body",
  // 括弧は半角(`0x28` / `0x29`)である。全角にすると配布物の見張りの側が赤くなる。
  "(名乗りなし)",
];

/** `web/test/runner-entry-boundary.test.ts` の `FORBIDDEN` から `marker` を切り出す。 */
function forbiddenMarkers(): string[] {
  const source = readFromRoot("web/test/runner-entry-boundary.test.ts");
  const start = source.indexOf("const FORBIDDEN");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n];", start);
  expect(end).toBeGreaterThan(start);
  // 宣言行(`readonly marker: string`)を落としてから切り出す。
  const body = source.slice(source.indexOf("\n", start), end);
  return [...body.matchAll(/marker:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1] ?? "");
}

test("(b) V10-M34-T02 / CM-G46: 配布物の見張りにコメントの目印が9本とも載っている", () => {
  const markers = forbiddenMarkers();
  const missing = COMMENT_MARKERS.filter((marker) => !markers.includes(marker));
  expect(missing).toEqual([]);
  // **数でも当てる**(1本落ちたらここも赤くなる)。
  expect(markers.filter((marker) => COMMENT_MARKERS.includes(marker)).length).toBe(9);
  // **陽性対照(空振りで緑にならないこと)** —— 切り出しが1件も取れていないなら赤にする。
  expect(markers.length).toBeGreaterThan(COMMENT_MARKERS.length);
  // **【誇張しない】この9本を `FORBIDDEN` に入れたのは前段である。**
  // **本ファイルは「入っていること」を実測で確かめているだけである。**
});

// ---------------------------------------------------------------------------
// (c) 設定を読む経路が1本
// ---------------------------------------------------------------------------

test("(c) V10-M34-T02 / CM-G46: 設定を読む経路は取得口・読む側・載せ口とも1本ずつである", () => {
  // --- 取得口 = 定義を取りに行く口(`GET /api/apps/:app_id/manifest`)---
  //     **`web/src/api.ts` の `ManifestResponse` は型宣言であって取得口ではない**(数えない)。
  const webSources = collectSources(join(ROOT, "web", "src"));
  const fetchSites: string[] = [];
  for (const relPath of webSources) {
    for (const line of codeLines(readFromRoot(relPath))) {
      if (/\}\/manifest`/.test(line)) fetchSites.push(relPath);
    }
  }
  expect(fetchSites).toEqual(["web/src/api.ts"]);

  // --- 読む側 = 応答の兄弟キーの値を読む場所 ---
  const readSites: string[] = [];
  for (const relPath of webSources) {
    for (const line of codeLines(readFromRoot(relPath))) {
      if (/\.comment_visibility\b/.test(line)) readSites.push(relPath);
    }
  }
  expect(readSites).toEqual(["web/src/AppWorkspace.tsx"]);

  // --- 載せ口 = 台帳から設定を読み出して応答に載せる場所 ---
  //     **`src/kernel/meta-store.ts`(定義そのもの)と `*.test.ts` は数えない。**
  //     **MCP の書込ツール(`src/mcp/tools/write.ts`)が同じキーを返すのは「設定を書いた
  //     結果の反響」であって読む経路ではない** —— **数えていないことを隠さない。**
  const serverSources = collectSources(join(ROOT, "src", "server")).filter(
    (relPath) => !relPath.endsWith(".test.ts"),
  );
  const loadSites: string[] = [];
  for (const relPath of serverSources) {
    for (const line of codeLines(readFromRoot(relPath))) {
      if (line.includes(".getCommentVisibility(")) loadSites.push(relPath);
    }
  }
  expect(loadSites).toEqual(["src/server/app.ts"]);

  const emitSites: string[] = [];
  for (const relPath of serverSources) {
    for (const line of codeLines(readFromRoot(relPath))) {
      if (/comment_visibility\s*:/.test(line)) emitSites.push(relPath);
    }
  }
  expect(emitSites).toEqual(["src/server/app.ts"]);

  // --- 器を張る箇所 = provider の**実体化**(**定義とは数え分ける**)---
  //     **【2026-08-26。`V10-M34-T03`】** **設定を器へ流し込む口が2本目になったら赤くなる。**
  //     **【禁止】これを「2本目の設定経路を塞いだ」と読まない** —— **`value` に何が
  //     流れ込むかは1ミリも見ていないので、サーバを1バイトも触らない経路は今日も通る。**
  const providerDefs: string[] = [];
  const providerUses: string[] = [];
  for (const relPath of webSources) {
    for (const line of codeLines(readFromRoot(relPath))) {
      if (/function\s+CommentVisibilityProvider\s*\(/.test(line)) providerDefs.push(relPath);
      if (/<CommentVisibilityProvider\b/.test(line)) providerUses.push(relPath);
    }
  }
  expect(providerDefs).toEqual([DECISION_HOME]);
  expect(providerUses).toEqual(["web/src/AppWorkspace.tsx"]);
  expect(providerUses.length).toBe(1);

  // **2本目の取得口 / 読む側 / 載せ口 が生えたら、それぞれ赤くなる。**
});

// ---------------------------------------------------------------------------
// (d) 既定が OFF(**3箇所とも当てる。これは (d) 1つの中身である**)
// ---------------------------------------------------------------------------

test("(d) V10-M34-T02 / CM-G46: 既定 OFF を成立させている3箇所が3つとも倒れていない(訂正 V10-M34-T03: 今日は4箇所である。旧名を1バイトも消していない)", () => {
  // --- 1. DDL の既定(`src/kernel/meta-store.ts`)---
  const metaStore = readFromRoot("src/kernel/meta-store.ts");
  const ddlDefaults = [
    ...metaStore.matchAll(
      /\{\s*name:\s*"(comment_(?:write|read)_enabled)",\s*type:\s*"INTEGER NOT NULL",\s*default:\s*"0"\s*\}/g,
    ),
  ].map((m) => m[1] ?? "");
  expect(ddlDefaults.sort()).toEqual(["comment_read_enabled", "comment_write_enabled"]);

  // --- 2. 応答の既定(`src/server/app.ts`)---
  const appServer = readFromRoot("src/server/app.ts");
  const responseDefaults = codeLines(appServer).filter((line) =>
    /visibility\?\.(?:write|read)\s*\?\?\s*false/.test(line),
  );
  expect(responseDefaults.length).toBe(2);

  // --- 3. 画面側の fail-closed(`web/src/views/ViewHost.tsx`)---
  //     **provider の外・`undefined`・真でない、のすべてで「出さない」へ倒れる形である。**
  const viewHost = readFromRoot(DECISION_HOME);
  const failClosed = codeLines(viewHost).filter((line) =>
    /\?\.\s*(?:write|read)\s*===\s*true/.test(line),
  );
  expect(failClosed.length).toBe(2);

  // --- 4. 台帳の 0/1 を真偽へ写す場所(`src/kernel/meta-store.ts` の `toCommentVisibility`)---
  //     **【2026-08-26。`V10-M34-T03`】ここが**4箇所目**である。** 上の 1〜3 を1バイトも
  //     動かさずに `!== 0` の `0` を倒すだけで、**全アプリの既定が ON になる。**
  //     **これは「5つ目の見張り」ではない** —— **(d) 1つの中身が3箇所から4箇所に
  //     なっただけである**(`ADR-0380` 限定1 を破らない)。
  const boolCasts = [...metaStore.matchAll(/row\.comment_(write|read)_enabled\s*!==\s*0/g)].map(
    (m) => m[1] ?? "",
  );
  expect([...boolCasts].sort()).toEqual(["read", "write"]);
  expect(boolCasts.length).toBe(2);

  // **3箇所のどれか1つでも ON へ倒れたら赤くなる** —— 1箇所だけを読む見張りは、
  // **他の2箇所が倒れても緑のままである。**
});

// ---------------------------------------------------------------------------
// (e) 見張りそのものが空でないこと(**本ファイル自身を読む**)
//     **【2026-08-26。`V10-M36-T01a` / 台帳 `CO-G1` / `ADR-0381` §Decision 1 (e)】**
//     **`ADR-0380` 限定1 の「4つちょうど / 5つ目を足さない」は、`ADR-0381` が
//     **その1点だけ**を引き直した。** **限定2〜限定8 は1点も動いていない。**
// ---------------------------------------------------------------------------

/** 本ファイル自身(`ROOT` からの相対、POSIX 表記)。**(e) はこれを読む。** */
const SELF = "src/kernel/comment-toggle-bypass.test.ts";

/**
 * **見張り5つの目印。** **テスト名の先頭の丸括弧の中の1文字**で振り分ける
 * ((a-1) 〜 (a-4) はどれも `a` に落ちる)。
 *
 * **逐語で1行を固定しない**(`ADR-0380` 限定8 と同じ向き) —— 数えるのは
 * **本数**と**集合**である。**これで `ADR-0381` 限定1 の「5つちょうど」が式になる。**
 */
const GUARD_LABELS: readonly string[] = ["a", "b", "c", "d", "e"];

/** 本ファイルの `test()` の名前を切り出す(**行頭が `test(` の行だけ**)。 */
function selfTestNames(): string[] {
  const source = readFromRoot(SELF);
  return [...source.matchAll(/^[ \t]*test\(\s*"((?:[^"\\]|\\.)*)"/gm)].map((m) => m[1] ?? "");
}

test("(e) V10-M36-T01a / CO-G1: 見張りそのものが空でない(test() が0本でなく、(a)〜(e) の5つが5つとも在る)", () => {
  // --- 1. ファイルが空でないこと ---
  const source = readFromRoot(SELF);
  expect(source.length).toBeGreaterThan(0);

  // --- 2. `test()` が0本でないこと(`ADR-0381` §Decision 1 (e))---
  const names = selfTestNames();
  expect(names.length).toBeGreaterThanOrEqual(1);

  // **陽性対照(切り出しが空振りしたまま緑にならないこと)** —— 素の行数と一致させる。
  // **切り出しが1本も取れなければ `0 !== rawTestLines` でここが赤くなる。**
  const rawTestLines = source.split("\n").filter((line) => /^[ \t]*test\(/.test(line)).length;
  expect(names.length).toBe(rawTestLines);
  expect(rawTestLines).toBeGreaterThanOrEqual(GUARD_LABELS.length);

  // --- 3. 見張り5つが5つとも在ること ---
  //     **1つでも名前ごと消えたら赤 / 6つ目の見張り (f) が生えても赤**
  //     (`ADR-0381` 限定1 の「5つちょうど」)。
  const labels = [...new Set(names.map((name) => /^\(([a-z])/.exec(name)?.[1] ?? ""))].sort();
  expect(labels).toEqual([...GUARD_LABELS].sort());

  // **【禁止】これを「見張りは骨抜きにされない」と読まない**(`ADR-0381` §4 の6 / §限界1)。
  // **中身を `expect(true).toBe(true)` に置き換える形は今日も素通りする。**
  // **本ファイルごと空にする / 消す形も塞げていない** —— **(e) 自身が走らないからである。**
});
