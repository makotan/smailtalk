/**
 * 越えてはならない線の機械検査(V3-M6-T03。取り込み = D-G9 / 持ち出しの再審査 = D-G3b)。
 *
 * 完了条件の正は `docs/plan/v3/records/v3-m6.md` §2 の「V3-M6-T03」節の5・6、
 * **線の正は `docs/plan/v3/records/v3-m6-gate-a.md` §8-1 の12点**、
 * 判定の正は `docs/adr/0007-vocabulary-governance.md` §8 の 2026-07-30 の2行と注23、
 * 改訂の出所は `docs/adr/0059-theme-import-declaration-revision.md`。
 * 書式の先例は `web/test/preset-boundary.test.ts`(V3-M2-T05)/
 * `web/test/shell-navigation-boundary.test.ts`(V3-M3-T06)/
 * `web/test/intake-boundary.test.ts`(V3-M4-T03)。
 *
 * ## このファイルが「線12点の家」である理由(**ADR ではない**)
 *
 * **`v3-m6.md` §2a 裁定6 が家をここに置いた。** **審査は12点を索引 §8-1 に置いたが、
 * 2単位とも問4 に到達していないため、それは限定表ではなく個別 ADR の家が無い**
 * (問4 未到達の単位に限定表を書くと、限定採用でないものを限定採用として記録することになる)。
 *
 * - **ADR より弱い**: **改訂の手続き(ADR-0007 §6)に縛られない。** このファイルは
 *   誰でも編集でき、期待値を書き換えれば緑に戻る。**門A を通す義務を発生させない。**
 * - **ADR より強い**: **線を越えれば必ず赤になる。** ADR は読まれなければ効かないが、
 *   検査は CI が読む。**とくに「緑のまま静かに偽になっていた」型の失敗**
 *   (V3-M5 §10-4)**を、12点のうち機械化できたものについては塞ぐ。**
 *
 * ## 12点の全量(**索引 §8-1 の写し。禁止形。1点も省略しない**)
 *
 * | # | 線(禁止形) | **機械化** | どこが見るか |
 * |---|---|---|---|
 * | **1** | **カーネルもサーバも外部を1バイトも取得しない。** `src/mcp/vocabulary.ts` の取り込み行(`CANNOT_DO`)と `VOCABULARY_SCOPE` を嘘にしない。**書き換える必要が生じたら、それはカーネルが取得している証拠なので設計を戻す** | **半分できた** | **逐語の存続 = 既存の `src/mcp/vocabulary.test.ts`**(下記「二重化しない」の1)。**`src/server/` 側 = 本ファイル (E)。** **「外部を取得しない」そのものは機械化できていない**(下記 限界1) |
 * | **2** | **`image` 型を抽出の入力にしない。** スクリーンショットは `fixtures/` のファイルとして会話側 AI が読むのであって、`image` フィールドに置いてから読むのではない | **できた(別の場所)** | `web/test/theme-import.test.ts`(T01。`blobs/` が作られず `manifest.json` に `image` が0回)/ `web/test/theme-import-panel.test.tsx`(T02。入口のソースに `type="file"` / `FileReader` / `accept=` が0件) |
 * | **3** | **中間表現(抽出途中の値・出典・信頼度)の置き場を1つも作らない。** `storage-paths.ts` に関数を1本も足さない(10本のまま)/ `kernel.sqlite` に新テーブルを作らない / `_` 始まりの予約名を1つも増やさない(3のまま) | **できた** | **本ファイル (B)**(`storage-paths.ts` の公開関数の集合)+ **(A4)**(予約名の集合)。ブラウザ側の保持は `web/test/theme-import-panel.test.tsx`(`localStorage` / `sessionStorage` / IndexedDB が0件) |
 * | **4** | **`RESOURCE_KINDS` / `FIELD_TYPES` / `DIFF_OPS` を1要素も増やさない**(7 / 8 / 16)。**`$defs/app` / `$defs/theme` / `$defs/view` / `$defs/view_changes` / `$defs/operation` にキーを1つも足さない**(7 / 25 / 18 / 13 / 8) | **できた** | **本ファイル (A1)〜(A5)。集合として見る**(既存検査は前3つを `length` だけで見ており、**「1つ足して1つ消す」と「改名」が素通りする**。下記「二重化した4項目」) |
 * | **5** | **取り込み用の MCP ツールを1本も足さない**(公開23本のまま)。**`import_theme` のようなツールとして出せば Δ10 で差し戻す。** `web/test/theme-template.test.ts:591` を偽にしない | **できた** | **本ファイル (A7)**(`registerTool` の名前集合)+ 既存の `src/mcp/descriptions.test.ts:169`(実サーバ越しの23名の集合) |
 * | **6** | **`D-G3a`(組織テンプレートのリソース種化・組織単位の台帳)を含まない。** `theme_template` を repo に1件も足さない(今日0件) | **できた** | **本ファイル (D)** |
 * | **7** | **`src/server/` を1バイトも触らない。** **したがって owner 確認は編集上の関門であって構造の担保ではない。** **「AI が黙って見た目を変えることはできない」と書いてはならない** —— 書けるのは3文である | **半分できた** | **本ファイル (E)**(`src/server/` の製品コードに `theme` の語が0件)+ **(F3)**(禁止文言が**否定される形でしか**文書に現れない)。**「3文を1文に丸めていない」ことは機械化できていない**(下記 限界2) |
 * | **8** | **取り込みの入口を候補プレビューの候補集合に結線しない。** `CANNOT_DO` の逐語「候補はブラウザ側のコードが持つ組み込みの固定集合で、AI が候補を増やすことはできません」を偽にしない | **できた(別の場所)** | `web/test/intake-boundary.test.ts` (a)(候補集合の定義は1本だけ・候補IDが越境しない)/ `web/test/theme-import-panel.test.tsx`(入口が `THEME_CANDIDATES` を1度も参照しない) |
 * | **9** | **`theme.json` を出す口を画面に置かない。** 非対称を残す。置くなら D-G3b の再審査条件 (e) を発火させて問1 から当て直す | **できた(別の場所)** | `web/test/theme-import-panel.test.tsx:523`(入口側・出口側とも `theme-json` / `copy-theme-json` の口が0件) |
 * | **10** | **コントラスト検査を迂回する経路を1本も作らない。** 拒否は**全か無か**であり、部分適用も警告だけの通過も作らない(`purpose === "incoming"` の fail-closed を保つ) | **できていない** | `web/test/theme-import.test.ts`(T01。全か無かを sha256 で固定)/ `web/e2e/theme-import.e2e.ts` (ii)(chromium で拒否を実測)が**個別の経路について**測っているだけである。**「迂回路が1本も無い」ことの全量検査は無い**(下記 限界3) |
 * | **11** | **`$defs/theme` のスロット集合を25から動かさない。** **したがって `--border-style` / `--focus-outline-style` / `--shell-max-width` は取り込めないままである。** 「資産の見た目をそのまま取り込める」と書いてはならない | **できた** | **本ファイル (C)。** `:root` の28変数と `$defs/theme` の25スロットの**差集合が正確にこの3つであること**を見る(**片方だけを数えても捕まらない**) |
 * | **12** | **`docs/manual.md:234` を消して終わりにしない。** 「入口は無い」を消すだけだと逆向きの嘘(「何でも取り込める」)になるので、双方向で書く | **できた** | **本ファイル (F1)(F2)。** 旧文言の復活を赤にし、**今日も無いもの4点**が名指しで残っていることを固定する(ADR-0049 / 0052 / 0053 / 0054 / 0057 が5回連続で採った双方向規律) |
 *
 * **数え方(T05 のため。**丸めない**)**: **本ファイルが直接持つ = 6点(3 / 4 / 5 / 6 / 11 / 12)/
 * 別の場所の既存検査が持つ = 3点(2 / 8 / 9)/ 半分だけ機械化できた = 2点(1 / 7)/
 * 機械化できていない = 1点(10)。** **合計すると「検査が何らかの形で見ている = 9点、
 * 半分だけ = 2点、見ていない = 1点」である。**
 * **「越えてはならない線を12点固定した」と書いてはならない。**
 *
 * ## 既に別の場所で担保されているもの(**ここに二重化しない**)
 *
 * 1. **`CANNOT_DO` / `VOCABULARY_SCOPE` の取り込みの逐語**(線1 の前半)=
 *    **`src/mcp/vocabulary.test.ts:1088` / `:1093`**。逐語
 *    「`応答本文をアプリ内テーブルへ取り込む経路はありません`」「`任意の外部データ取り込みはできません`」
 *    を `toContain` で固定している。**V3-M6 はこの2行を1バイトも触っていない**(触る必要が
 *    生じなかったことが線1 の充足の証拠である。実施記録 §3)。**同じ `toContain` をここに
 *    書くと、同じ事実の基準が2箇所になる。**
 * 2. **`$defs/app` / `$defs/theme` / `$defs/view` のキー集合**(線4 の後半のうち3つ)=
 *    **`web/test/shell-navigation-boundary.test.ts` (a)**。`properties` を持つ全 `$defs` を
 *    **両向き**で凍結している。
 * 3. **`$defs/view_changes` / `$defs/operation` のキー集合** = **`src/kernel/validate.test.ts`**
 *    (`:1264` が `view_changes` を `toEqual` で、`:1020` 付近が `operation` の8キーを固定)。
 * 4. **`:root` の28変数の集合** = **`web/test/styles.test.ts`** と
 *    **`web/test/__fixtures__/styles-token-slots.txt`**(28件の基準ファイル)。
 * 5. **公開ツール23本の名前集合** = **`src/mcp/descriptions.test.ts:169`**(実 MCP サーバ越し)。
 *
 * ## それでも4項目を重ねた理由(**重複は維持費である。承知で払う**)
 *
 * **`v3-m6.md` §2 の T03 完了条件5 が「語彙総量10項目が着手前の値から動いていないこと」を
 * 名指しで課している。** **10項目が1箇所で読めることに価値がある**(マイルストーン単位の
 * 不変量であり、5つのファイルに散っていると「全部動いていない」を誰も1度に確かめられない)。
 * **加えて、`RESOURCE_KINDS` / `FIELD_TYPES` / `DIFF_OPS` は既存検査が `length` だけを固定して
 * おり(`src/mcp/vocabulary.test.ts:35` / `:43` / `:57`)、続く `for` ループは配列そのものから
 * 回すので自動追随する** —— **したがって「1つ足して1つ消す」も「1つ改名する」も今日は
 * 素通りする。** **本ファイル (A1)〜(A3) はその穴を塞ぐ**(これは重複ではなく、既存が
 * 見ていなかったものである)。
 *
 * ## 数を手書きで固定するだけの検査を作っていない(裁定6 / V3-M5 §10-4)
 *
 * **どの検査も「集合の一致」または「差集合の一致」で書いてある。** 件数だけを数えないのは
 * **「1つ足して1つ消す」が素通りするから**である(`intake-boundary.test.ts` の docblock と
 * 同じ理由)。**加えて (A1)〜(A4) と (A7) と (B) には「入りそうな名前が入っていないこと」の
 * 否定側を並べてある** —— **集合の一致だけだと、基準表を書き換えて緑に戻す誘惑が残る**
 * (書き換えれば否定側も赤になる)。
 *
 * ## 拒否リストを作っていない(ADR-0013 限定13)
 *
 * **否定側に並べてあるのは「この単位が実際に足しそうになった名前」だけである**
 * (`theme_template` / `import_theme` / `brand` / `screenshot` / `asset`)。**一般的な
 * 「書いてはいけない名前の一覧」ではない。** 集合の一致のほうが主で、否定側は補助である。
 *
 * ## 限界(先に書く。憲法6)
 *
 * 1. **線1 の本体(「カーネルもサーバも外部を1バイトも取得しない」)を機械化できていない。**
 *    `src/kernel/` と `src/server/` には `call_external`(送信)と受信 Webhook のための
 *    正当な通信経路が既に在るので、「`fetch(` が0件」では書けない。**書けたのは
 *    「`src/server/` の製品コードがテーマの語を1つも知らない」までである**((E))。
 *    **テーマの取り込みのために外部を取りに行く経路が将来足されたとき、(E) は
 *    それを捕まえる**(`theme` の語を使わずに書くことは実際上できない)が、
 *    **「捕まえられないやり方が無い」ことは示せない。**
 * 2. **線7 の「3文を1文に丸めない」は機械化できていない。** (F3) が固定しているのは
 *    **禁止形の文字列が否定と一緒にしか現れないこと**だけであり、**同じ意味を別の言い方で
 *    丸めた文**は捕まらない(`ADR-0049` 限界3 / `intake-boundary.test.ts` 限界4 と同型)。
 *    **さらに (F3) は否定の印を5つの言い方に限っているので、6つ目の言い方で否定すると
 *    誤って赤になる。** **その誤検出は「言い方を有限に縛る」ことの代償として受け入れている。**
 * 3. **線10(コントラスト検査の迂回路)を機械化できていない。** 迂回路は「新しい経路を
 *    作らない」という**不在**の主張であり、経路の全量を列挙する手段が無い。
 *    **`src/server/escape-hatch-issuance.test.ts` が逃げ道について同型の検査
 *    (「CSS のバイト列を書ける製品コードは owner ルートと store 自身だけである」)を
 *    持っているが、テーマにはそれに相当する「書ける製品コードの全量」の検査が無い** ——
 *    **`apply_diff` は誰でも通れる普通の経路だからである**(それが線7 の中身でもある)。
 * 4. **本ファイルはソーステキストの正規表現と JSON の読み取りだけで書いてある。**
 *    型検査ではないので、**同じものを別の形に畳み直す**変更(配列を分割して結合する・
 *    キーを `$ref` の先へ移す)は捕まえられない。
 * 5. **抽出の正しさについて1バイトも述べていない。** それは有限化できない
 *    (索引 §8-1 の末尾)。**本ファイルが見ているのは「どこに書き、誰が読み、何を触らないか」
 *    だけである。**
 * 6. **描画を1ピクセルも見ていない。** 実証は `web/e2e/theme-import.e2e.ts`(chromium)にある。
 */

import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { SYSTEM_TABLE_IDS } from "../../src/shared/system-tables.ts";

const WEB_ROOT = dirname(import.meta.dir);
/**
 * 移した公開単位の根(`apps/smailtalk/`)。`src` / `web` / `schemas` / `scripts` はこの下に在る。
 * **`import.meta.dir` から数える** —— `process.cwd()` で解くと `bun test` を打つ場所で結果が変わる。
 */
const PRODUCT_ROOT = dirname(WEB_ROOT);

function read(...parts: string[]): string {
  return readFileSync(join(PRODUCT_ROOT, ...parts), "utf-8");
}

function readJson(...parts: string[]): {
  // biome-ignore lint/suspicious/noExplicitAny: JSON Schema の任意構造を読むだけである。
  [key: string]: any;
} {
  return JSON.parse(read(...parts));
}

/**
 * `export const NAME = [ "a", "b" ] as const;` の形から文字列要素を取り出す。
 *
 * **値として import しない理由**: `RESOURCE_KINDS` / `FIELD_TYPES` / `DIFF_OPS` は
 * `src/kernel/types.ts` に在る。**`web/test/` からこれを値 import すると
 * `scripts/kernel-import-drift.test.ts` が赤になり、`v3-m6.md` §2a 裁定1 が許容した
 * 7識別子の集合の外なので差し戻しになる。** したがってソーステキストから読む。
 */
function stringArrayLiteral(source: string, name: string): string[] {
  const head = source.indexOf(`export const ${name} = [`);
  if (head < 0) throw new Error(`${name} の宣言が src に見つからない`);
  const open = source.indexOf("[", head);
  const close = source.indexOf("]", open);
  if (close < 0) throw new Error(`${name} の配列リテラルが閉じていない`);
  return [...source.slice(open + 1, close).matchAll(/"([^"]*)"/g)].map((m) => m[1] as string);
}

/** 拡張子を問わず再帰的に集める(**走査対象を名前で選り好みしない**)。 */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
      continue;
    }
    out.push(full);
  }
  return out;
}

function filesUnder(...parts: string[]): { path: string; text: string }[] {
  return walk(join(PRODUCT_ROOT, ...parts)).map((path) => ({
    path: path.slice(PRODUCT_ROOT.length + 1),
    text: readFileSync(path, "utf-8"),
  }));
}

const KERNEL_TYPES = read("src", "kernel", "types.ts");

// ---------------------------------------------------------------------------
// (A) 語彙総量10項目 —— **集合として**見る(`v3-m6.md` §0-1c (5) / 線4 / 線5)
// ---------------------------------------------------------------------------

test("(A1) RESOURCE_KINDS の集合が着手前と一致する(テーマ・テンプレート・資産が種になっていない)", () => {
  const kinds = stringArrayLiteral(KERNEL_TYPES, "RESOURCE_KINDS");
  expect([...kinds].sort()).toEqual(
    // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】基準表に `report_view`
    // (画面種別の4種目 = 集計表)を足した。****旧行の逐語**:
    // `["app", "detail_view", "form", "function", "list_view", "table", "workflow"].sort(),`
    // **この test が固定していたのは「**テーマ・テンプレート・資産**が種になっていないこと」
    // であり、その主張は下の否定側が今日も1バイトも変わらずに測っている。**
    [
      "app",
      "detail_view",
      "form",
      "function",
      "list_view",
      "report_view",
      "table",
      "workflow",
    ].sort(),
  );
  // **否定側**: この単位が足しそうになった名前。基準表を書き換えても、こちらが赤になる。
  for (const forbidden of ["theme", "theme_template", "brand", "asset", "screenshot"]) {
    expect(kinds, `RESOURCE_KINDS に ${forbidden} が入っている`).not.toContain(forbidden);
  }
});

test("(A2) FIELD_TYPES に色型・CSS 型・テーマ型が1つも無い", () => {
  const types = stringArrayLiteral(KERNEL_TYPES, "FIELD_TYPES");
  // **【`V5-M16` / `ADR-0161` による書き換え】** **着手前(`V3-M6`)の集合は8種で、
  // `file` は「取り込みが足しそうになった名前」として否定側に置かれていた。**
  // **`V5-M16` が `G-G12` / `G-G13` の門A本審査(`ADR-0161`)を通して `file` を9種目として
  // 足したので、この行の基準表を 8 → 9 に直し、否定側から `file` を外した。**
  // **この単位(テーマの取り込み)が `file` を足したのではない** —— **足したのは別の決定である。**
  // **色型・CSS 型・テーマ型が入っていないことは今日も検査している**(下の否定側)。
  expect([...types].sort()).toEqual(
    [
      "boolean",
      "date",
      "file",
      "image",
      "long_text",
      "number",
      "reference",
      "select",
      "text",
    ].sort(),
  );
  for (const forbidden of ["color", "css", "theme"]) {
    expect(types, `FIELD_TYPES に ${forbidden} が入っている`).not.toContain(forbidden);
  }
});

test("(A3) DIFF_OPS の集合が着手前と一致する(取り込み用の op が1つも無い)", () => {
  const ops = stringArrayLiteral(KERNEL_TYPES, "DIFF_OPS");
  expect([...ops].sort()).toEqual(
    [
      "add_field",
      "add_function",
      "add_table",
      "add_view",
      "add_workflow",
      "change_field",
      "change_table",
      "remove_field",
      "remove_function",
      "remove_table",
      "remove_view",
      "remove_workflow",
      "set_theme",
      // **【`V5-M17b` / `ADR-0248`】17種目 `set_user_kinds`。****この検査の主張は
      // 「テーマの取り込み用の op が1つも無いこと」であり、`set_user_kinds` は
      // テーマとは無関係の別の門A 判定で足された op である。****下の禁止リスト5語は
      // 1語も緩めていない。**
      // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11`。判定値 = 廃止】**
      // **旧(逐語)**: この位置に `"set_user_kinds",` が在った。
      // **`set_user_kinds` は廃止された(`DIFF_OPS` 18 → 17)。**
      // **この検査の主張(テーマの取り込み用の op が1つも無いこと)は1ミリも動いていない**
      // —— **消えた op はテーマとは無関係であり、下の禁止リスト5語も1語も緩めていない。**
      // **【`V8-M16` / `J-G1b` / メインの裁定 `R-1`】18種目 `set_roles`(役割の宣言の全置換)。**
      // **この検査の主張は「テーマの取り込み用の op が1つも無いこと」であり、`set_roles` は
      // テーマとは無関係の別の門A 判定(軸3 = 権限)で足された op である。****下の禁止
      // リスト5語は1語も緩めていない。****期待値を書き換えた理由はこの1点だけである。**
      "set_roles",
      "update_function",
      "update_view",
      "update_workflow",
    ].sort(),
  );
  // **`set_theme` は在る**(V3-M1 が門A を通した16種目)。**足してはならないのは17種目である。**
  // **【`V5-M17b`】17種目は実際に足された(`set_user_kinds`)が、それはテーマの取り込み用
  // ではない** —— **この行が止めていたのは「テーマの取り込み用の op」であり、そちらは
  // 今日も1つも無い**(直下の禁止5語がそれを固定している)。
  for (const forbidden of [
    "import_theme",
    "set_theme_partial",
    "update_theme",
    "remove_theme",
    "apply_template",
  ]) {
    expect(ops, `DIFF_OPS に ${forbidden} が入っている`).not.toContain(forbidden);
  }
});

test("(A4) 予約名(システムテーブル)の集合が着手前と一致する(中間表現の置き場が生えていない)", () => {
  expect([...SYSTEM_TABLE_IDS].sort()).toEqual(["_ai_usage", "_apps", "_changelog"].sort());
  for (const forbidden of ["_themes", "_theme_templates", "_imports", "_assets"]) {
    expect(SYSTEM_TABLE_IDS, `予約名に ${forbidden} が入っている`).not.toContain(forbidden);
  }
});

test("(A5) スキーマの5つの $defs の properties キー集合が着手前と一致する", () => {
  const manifest = readJson("schemas", "manifest.schema.json").$defs;
  const diff = readJson("schemas", "diff.schema.json").$defs;
  const expected: Record<string, string[]> = {
    // **【`V5-M17-T02` / `G-G5` / `ADR-0158` 限定8 が足した8キー目 `user_kinds`】**
    // **門A の本審査(`V5-M12` 単位 `G-G5`/`G-G6`/`G-G7`。判定 = 限定採用)を通った増分である。**
    // **利用者の種類の宣言であって、テーマの持ち込みとも導線とも1ミリも関係しない**
    // (配色・書体・余白のスロットを1つも持たず、行き先のIDも1つも持たない)。
    // **列挙を消して件数に丸めない**(既存の作法)。
    // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`。判定値 = 廃止】旧(逐語)**:
    // 下の配列に `"user_kinds",` が在った(`$defs/app.properties` は 9 キーだった)。
    // **今日は 8 キーである。** **上の段落は制定時の事実であり、1バイトも消していない。**
    "manifest:app": [
      "functions",
      "id",
      "name",
      "tables",
      "theme",
      "views",
      "workflows",
      // **【`V8-M16` / `J-G1b` / メインの裁定 `R-1`】9キー目 `roles`(役割の宣言)。**
      // **テーマの持ち込みと1ミリも関係しない** —— 運ぶのは役割の宣言であって、
      // 配色・書体・余白のスロットを1つも持たない。**列挙を件数に丸めない。**
      "roles",
    ],
    "manifest:theme": [
      "--border-width",
      "--color-border",
      "--color-danger",
      "--color-page-background",
      "--color-surface-highlight",
      "--color-text",
      "--color-text-label",
      "--color-text-placeholder",
      "--color-text-secondary",
      "--control-border-radius",
      "--detail-label-width",
      "--focus-outline-color",
      "--focus-outline-width",
      "--font-family-base",
      "--font-size-note",
      "--font-size-secondary",
      "--line-height-base",
      "--login-max-width",
      "--space-1",
      "--space-2",
      "--space-3",
      "--space-4",
      "--space-5",
      "--space-6",
      "--surface-shadow",
    ],
    "manifest:view": [
      "actions",
      /*
       * **【2026-08-20。`V10-M1-T02` / 台帳 `NV-G4` / 門A 本審査 = `V10-M0` 群A /
       * `ADR-0359` §4a 限定1 が足した30キー目】** **`after_delete`(削除が成立した
       * あとの行き先)はテーマの持ち込みと1ミリも関係しない**(行き先のビューIDを書く
       * キーであって、配色・書体・余白のスロットではない)—— **本ファイルが守る
       * 「持ち込みの当たり先が黙って増えない」という主張は1ミリも緩んでいない。**
       * **列挙を消して件数に丸めない。**
       */
      "after_delete",
      /*
       * **V4-M3-T02 / `B-G1` / ADR-0070 限定1 が足した19キー目。** **門A の本審査を通って
       * 限定採用された増分である。** **`audience` はテーマの持ち込みと1ミリも関係しない**
       * (見せる相手を書くキーであって、配色・書体・余白のスロットではない)——
       * **本ファイルが守る「持ち込みの当たり先が黙って増えない」という主張は1ミリも
       * 緩んでいない。** 列挙を消して件数に丸めない。
       *
       * **【`V8-M20` / 台帳 `J-G27`(判定 = 廃止)/ 手続きは `ADR-0301` で消した。旧文を
       * 1バイトも書き換えていない】** **上の段落の主語だったキー `audience` は撤去された。**
       * **旧の期待値**: この位置に `"audience",` の1行が在った(`manifest:view` の列挙)。
       * **代わりに担うのは `app.roles[].rules` の
       * `{ target: "view", view: <画面ID>, can: ["read"] }` であり、その宣言は
       * `$defs/view` ではなく `manifest:app` の `roles`(上に列挙済み)の内側に在る。**
       * **したがって持ち込みの当たり先は1つ減った** —— **この検査が守る主張
       * (当たり先が黙って**増えない**)は1ミリも緩んでいない。**
       * **【禁止の履行】これを「語彙が減った」という成果として書かない**(`ADR-0301` 限定10)。
       */
      "columns",
      "custom_css",
      "fields",
      "filter",
      /*
       * **【2026-08-20。`V10-M4-T01` / 台帳 `NV-G9` / 門A 本審査 = `V10-M0` 群B /
       * `ADR-0359` §4b 限定1 が足した31キー目】** **`flow`(一続きの流れの中の段)は
       * テーマの持ち込みと1ミリも関係しない**(流れの名前・位置・段の種類を書くキーで
       * あって、配色・書体・余白のスロットではない)—— **本ファイルが守る
       * 「持ち込みの当たり先が黙って増えない」という主張は1ミリも緩んでいない。**
       * **列挙を消して件数に丸めない。**
       */
      "flow",
      "id",
      "name",
      "preset_column_align",
      "preset_column_width",
      "preset_field_columns",
      "preset_image_size",
      "preset_label_placement",
      "preset_pager_position",
      "preset_text_preview",
      "related",
      "sort",
      "table",
      "type",
      /*
       * **V4-M10-T45 / `E-G12` / ADR-0084 限定1 が足した20キー目。** **門A の本審査
       * (再審査 B8)を通って限定採用された増分である。** **`menu_listed` はテーマの
       * 持ち込みと1ミリも関係しない**(メニューに出すかを書く真偽値であって、配色・書体・
       * 余白のスロットではない)—— **本ファイルが守る「持ち込みの当たり先が黙って増えない」
       * という主張は1ミリも緩んでいない。** 列挙を消して件数に丸めない。
       */
      "menu_listed",
      /*
       * **V4-M16-T12 / `P-G17` の (C) 側 / ADR-0092 限定1 が足した21キー目。** **門A の
       * 本審査(`V4-M14` 本審査② の単位9)を通って限定採用された増分である。**
       * **`field_groups` はテーマの持ち込みと1ミリも関係しない**(どの項目がどのまとまりに
       * 属するかを書くだけで、配色・書体・余白のスロットを1つも持たない)——
       * **本ファイルが守る「持ち込みの当たり先が黙って増えない」という主張は1ミリも
       * 緩んでいない。** 列挙を消して件数に丸めない。
       */
      "field_groups",
      // **V4-M16-T13 / `P-G24` の (C) 側 / ADR-0093 限定1 が足した22キー目 `preset_list_shape`**
      // (一覧の器の形。8つ目の `preset_` キー)。**門A の本審査(`V4-M14` 本審査② の単位11)を
      // 通って限定採用された増分である。列挙を消して件数に丸めない**(`custom_css` /
      // `menu_listed` / `field_groups` と同じ作法)。**`list_view` でだけ書ける**(限定2)。
      "preset_list_shape",
      // **V4-M18-T03 / `P-G14` の (C) 側 / ADR-0095 限定1 が足した23キー目 `modal`**
      // (重ねて出す宣言)。**門A の本審査(V4-M18 単位3)を通って限定採用された増分である。**
      // **`modal` はテーマの持ち込みと1ミリも関係しない**(真偽値1つで、配色・書体・
      // 余白のスロットを1つも持たない)。**列挙を消して件数に丸めない。****`form` でだけ
      // 書ける**(限定4)。
      "modal",
      // **V4-M22-T01 / `E-G7` の (C) 側 / ADR-0112 限定1 が足した24キー目 `search_fields`**
      // (検索の対象にする列)。**門A の本審査(V4-M22 単位A)を通って限定採用された増分である。**
      // **`search_fields` はテーマの持ち込みと1ミリも関係しない**(実在フィールドIDの配列
      // 1つで、配色・書体・余白のスロットを1つも持たない)。**列挙を消して件数に丸めない。**
      // **`list_view` でだけ書ける**(限定3)。
      "search_fields",
      // **V4-M22-T05 / `E-G8`/`E-G11` の (C) 側 / ADR-0113 限定1 が足した25キー目 `page_size`**
      // (1ページに出す件数)。**門A の本審査(V4-M22 単位C。4回目の審査)を通って
      // 限定採用された増分である。** **`page_size` はテーマの持ち込みと1ミリも関係しない**
      // (10/20/50/100 の段階値1つで、配色・書体・余白のスロットを1つも持たない)。
      // **列挙を消して件数に丸めない。** **`list_view` でだけ書ける**(限定7)。
      "page_size",
      // **V4-M19-T03 / `P-G32` の (C) 側 / ADR-0118 限定1 が足した26キー目 `preset_density`**
      // (画面の詰まり具合)。**門A の本審査(V4-M19 単位C。2回目の審査。前回 = V4-M14 単位7 は
      // 却下)を通って限定採用された増分である。** **`preset_density` はテーマの持ち込みと
      // 1ミリも関係しない**(`comfortable` / `compact` の2段階値1つで、配色・書体・余白の
      // スロットを1つも持たない。`$defs/theme` の25キー・25 required には1バイトも触って
      // いない)。**列挙を消して件数に丸めない。** **3種すべて(list_view / form /
      // detail_view)で書ける**(限定なし。8つの既存 `preset_` キーと違い、どの分岐でも
      // `false` にしていない)。
      "preset_density",
      // **V4-M20-T04 / ADR-0102 限定1 が足した27キー目 `after_save`**(保存が成立したあとに
      // 行く画面のID)。**門A の本審査(V4-M20 単位D。2回目の審査)を通って限定採用された
      // 増分である。** **`after_save` はテーマの持ち込みと1ミリも関係しない**(ビューID
      // 1つで、配色・書体・余白のスロットを1つも持たない)。**列挙を消して件数に丸めない。**
      // **form 型のビューでだけ書ける。**
      "after_save",
      // **V4-M23-T01 / ADR-0104 限定1 が足した28キー目 `sum_field`**(合計を出す列)。
      // **門A の本審査(V4-M23。判定 = 限定採用)を通って限定採用された増分である。**
      // **`sum_field` はテーマの持ち込みと1ミリも関係しない**(number 型のフィールドID 1つで、
      // 配色・書体・余白のスロットを1つも持たない)。**列挙を消して件数に丸めない。**
      // **`list_view` でだけ書ける。**
      "sum_field",
      // **`V6-M2-T01` / `K-G2` / `ADR-0289` 限定1 が足した29キー目 `reference_pickers`**
      // (参照項目の選び方の、入力画面ごとの上書き)。**門A の本審査(`V6-M0` 単位A。
      // 判定 = 限定採用)を通った増分である。** **`reference_pickers` はテーマの持ち込みと
      // 1ミリも関係しない**(「フィールドID → 有限3値」の対応で、配色・書体・余白のスロットを
      // 1つも持たない)。**列挙を消して件数に丸めない。****`form` でだけ書ける。**
      "reference_pickers",
      // **【2026-08-14。`V8-M8` / 台帳 `Q-G1` / 門A 本審査 = `V8-M7` が足した29キー目 `report`】**
      // **集計表の中身(束ねるキー / 集計 / 絞り込み)。****テーマの持ち込みと1ミリも関係
      // しない** —— **配色・書体・余白のスロットを1つも持たない。**
      // **列挙を消して件数に丸めない。**
      "report",
    ],
    "diff:view_changes": [
      /*
       * **【2026-08-20。`V10-M1-T02` / 台帳 `NV-G4` / `ADR-0359` §Decision 2 が足した
       * 26キー目】** **`after_delete` はテーマの持ち込みと1ミリも関係しない** ——
       * **本ファイルが守る「持ち込みの当たり先が黙って増えない」という主張は
       * 1ミリも緩んでいない。****列挙を消して件数に丸めない。**
       */
      "after_delete",
      "columns",
      "custom_css",
      "fields",
      "filter",
      /*
       * **【2026-08-20。`V10-M4-T01` / 台帳 `NV-G9` / 門A 本審査 = `V10-M0` 群B /
       * `ADR-0359` §4b 限定1 が足した31キー目】** **`flow`(一続きの流れの中の段)は
       * テーマの持ち込みと1ミリも関係しない**(流れの名前・位置・段の種類を書くキーで
       * あって、配色・書体・余白のスロットではない)—— **本ファイルが守る
       * 「持ち込みの当たり先が黙って増えない」という主張は1ミリも緩んでいない。**
       * **列挙を消して件数に丸めない。**
       */
      "flow",
      "name",
      "preset_column_align",
      "preset_column_width",
      "preset_field_columns",
      "preset_image_size",
      "preset_label_placement",
      "preset_pager_position",
      "preset_text_preview",
      "sort",
      // **V4-M10-T45 / `E-G12` / ADR-0084 限定6 が足した14キー目。**
      // **テーマの持ち込みと1ミリも関係しない**(上と同じ理由)。
      "menu_listed",
      // **V4-M16-T12 / ADR-0092 限定2 が足した15キー目。**
      // **テーマの持ち込みと1ミリも関係しない**(上と同じ理由)。
      "field_groups",
      // **V4-M16-T13 / `P-G24` の (C) 側 / ADR-0093 限定2 が足した16キー目 `preset_list_shape`。**
      // **`update_view` で後から書けて、カーネルが値を実際に運ぶ**(`applyViewChanges` の
      // `list_view` 分岐。**`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは運ばれない**)。
      "preset_list_shape",
      // **V4-M18-T03 / `P-G14` の (C) 側 / ADR-0095 限定6 が足した17キー目 `modal`。**
      // **`update_view` で後から書けて、カーネルが値を実際に運ぶ**(`applyViewChanges` の
      // `form` 分岐。**`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは運ばれない**)。
      "modal",
      // **V4-M22-T01 / `E-G7` の (C) 側 / ADR-0112 限定2 が足した18キー目 `search_fields`。**
      // **`update_view` で後から書けて、カーネルが値を実際に運ぶ**(`applyViewChanges` の
      // `list_view` 分岐。**`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは運ばれない**)。
      "search_fields",
      // **V4-M22-T05 / ADR-0113 限定2 が足した19キー目 `page_size`。**
      // **`update_view` で後から書けて、カーネルが値を実際に運ぶ**(`applyViewChanges` の
      // `list_view` 分岐。**`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは運ばれない**)。
      "page_size",
      // **V4-M19-T03 / `P-G32` の (C) 側 / ADR-0118 限定1 が足した20キー目 `preset_density`。**
      // **`update_view` で後から書けて、カーネルが値を実際に運ぶ**(`applyViewChanges` の
      // list_view / form / detail_view の3分岐すべて。**`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけ
      // では運ばれない**)。**テーマの持ち込みと1ミリも関係しない**(上と同じ理由)。
      "preset_density",
      // **V4-M20-T04 / ADR-0102 限定2 が足した21キー目 `after_save`。**
      // **`update_view` で後から書けて、カーネルが値を実際に運ぶ**(`applyViewChanges` の
      // `form` 分岐。**`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは運ばれない**)。
      // **テーマの持ち込みと1ミリも関係しない**(上と同じ理由)。
      "after_save",
      // **V4-M23-T01 / ADR-0104 限定2 が足した22キー目 `sum_field`。**
      // **`update_view` で後から書けて、カーネルが値を実際に運ぶ**(`applyViewChanges` の
      // `list_view` 分岐。**`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは運ばれない**)。
      // **テーマの持ち込みと1ミリも関係しない**(上と同じ理由)。
      "sum_field",
      // **【V5-M21-T03 / `L-G4` / ADR-0172 限定1 が足した23キー目 `actions`】**
      // **`update_view` で後から書けて、カーネルが値を実際に運ぶ**(`applyViewChanges` の
      // `list_view` / `detail_view` の2分岐。**`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは
      // 運ばれない**)。**テーマの持ち込みと1ミリも関係しない**(上と同じ理由)——
      // **配色・書体・余白のスロットを1つも持たない。****列挙を消して件数に丸めない。**
      "actions",
      // **【`V6-M2-T02` / `K-G3` / `ADR-0289` 限定1 が足した24キー目 `reference_pickers`】**
      // **`update_view` で後から書けて、カーネルが値を実際に運ぶ**(`applyViewChanges` の
      // `form` 分岐。**`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは運ばれない**)。
      // **テーマの持ち込みと1ミリも関係しない**(上と同じ理由)—— **配色・書体・余白の
      // スロットを1つも持たない。****列挙を消して件数に丸めない。**
      "reference_pickers",
      // **【2026-08-14。`V8-M8` / 台帳 `Q-G1` / 門A 本審査 = `V8-M7` が足した25キー目 `report`】**
      // **`update_view` で後から書けて、カーネルが値を実際に運ぶ**(`applyViewChanges` の
      // `report_view` 分岐)。**テーマの持ち込みと1ミリも関係しない。**
      // **列挙を消して件数に丸めない。**
      "report",
    ],
    // **【`V5-M17b` / `ADR-0248` §4c】9キー目 `user_kinds` が加わった。**
    // **テーマの持ち込みと1ミリも関係しない** —— 運ぶのは利用者の種類の宣言であって、
    // 配色・書体・余白のスロットを1つも持たない。**列挙を件数に丸めない。**
    // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a` / `T-G11`。判定値 = 廃止】旧(逐語)**:
    // 下の配列に `"user_kinds",` が在った(`$defs/operation.properties` は 10 キーだった)。
    // **今日は 9 キーである。** **上の段落は制定時の事実であり、1バイトも消していない。**
    "diff:operation": [
      "changes",
      "field",
      "function",
      "op",
      "table",
      "theme",
      "view",
      "workflow",
      // **【`V8-M16` / `J-G1b` / メインの裁定 `R-1`】10キー目 `roles`(`set_roles` の引数)。**
      // **テーマの持ち込みと1ミリも関係しない** —— 運ぶのは役割の宣言であって、
      // 配色・書体・余白のスロットを1つも持たない。**列挙を件数に丸めない。**
      "roles",
    ],
  };
  for (const [label, keys] of Object.entries(expected)) {
    const [file, def] = label.split(":") as [string, string];
    const defs = file === "manifest" ? manifest : diff;
    expect(Object.keys(defs[def].properties).sort(), label).toEqual([...keys].sort());
  }
  // **`origin`(由来)は `$defs/app` ではなく `theme` の隣に在る。**
  // 取り込みのために `$defs/app` へ2つ目のキーが生えていないことを、両向きで見る。
  expect(Object.keys(readJson("schemas", "manifest.schema.json").properties).sort()).toEqual([
    "app",
  ]);
});

test("(A6) :root のスロット集合(28件)が着手前と一致する", () => {
  expect([...rootSlots()].sort()).toEqual(
    [
      "--border-style",
      "--border-width",
      "--color-border",
      "--color-danger",
      "--color-page-background",
      "--color-surface-highlight",
      "--color-text",
      "--color-text-label",
      "--color-text-placeholder",
      "--color-text-secondary",
      "--control-border-radius",
      "--detail-label-width",
      "--focus-outline-color",
      "--focus-outline-style",
      "--focus-outline-width",
      "--font-family-base",
      "--font-size-note",
      "--font-size-secondary",
      "--line-height-base",
      "--login-max-width",
      "--shell-max-width",
      "--space-1",
      "--space-2",
      "--space-3",
      "--space-4",
      "--space-5",
      "--space-6",
      "--surface-shadow",
    ].sort(),
  );
});

test("(A7) 公開 MCP ツールの名前集合が着手前と一致する(取り込み用のツールが1本も無い)", () => {
  const names = [
    ...registerToolNames(read("src", "mcp", "tools", "read.ts")),
    ...registerToolNames(read("src", "mcp", "tools", "write.ts")),
  ];
  expect([...names].sort()).toEqual(
    [
      "apply_diff",
      "create_app",
      "delete_app",
      "delete_record",
      "dry_run_diff",
      "generate_requirements_doc",
      "get_changelog",
      "get_manifest",
      "get_preview_url",
      "insert_sample_data",
      "list_apps",
      // **【2026-08-24。`V10-M12-T01`。台帳 `CM-G7` = 限定採用(門A)。`ADR-0368`。
      //   旧の24行を1バイトも書き換えていない】** **25本目 = 積まれたコメントを読む参照系の道具。**
      // **線5(取り込み用の MCP ツールを1本も足さない)は今日も守られている** ——
      //   **足した1本はテーマの取り込みに1文字も触れておらず、下の否定側
      //   (`import` / `theme` / `brand` / `screenshot` / `asset` / `template` を名前に含まない)
      //   を1つも踏まない。** **テスト名は1バイトも書き換えていない。**
      "list_comments",
      "list_records",
      "preview_redo",
      "preview_undo",
      // **【2026-08-15。`V8-M13-T02`。台帳 `Q-G28` = 限定採用(門A)。旧の23行を
      //   1バイトも書き換えていない】** **24本目 = 集計表を1枚読む参照系の道具。**
      // **線5(取り込み用の MCP ツールを1本も足さない)は今日も守られている** ——
      //   **足した1本はテーマの取り込みに1文字も触れておらず、下の否定側
      //   (`import` / `theme` / `brand` / `screenshot` / `asset` / `template` を名前に含まない)
      //   を1つも踏まない。** **テスト名は1バイトも書き換えていない。**
      "read_report",
      "redo",
      "report_drift",
      "request_ai_capability",
      "request_connection",
      "request_custom_css",
      "request_inbound_endpoint",
      // **【2026-08-25。`V10-M30-T02`。台帳 `CM-G37` = 限定採用(門A)。`ADR-0378`。
      //   旧の25行を1バイトも書き換えていない】** **26本目 = アプリごとのコメントの
      //   出し入れを切り替える更新系の道具。**
      // **線5(取り込み用の MCP ツールを1本も足さない)は今日も守られている** ——
      //   **足した1本はテーマの取り込みに1文字も触れておらず、下の否定側
      //   (`import` / `theme` / `brand` / `screenshot` / `asset` / `template` を名前に含まない)
      //   を1つも踏まない。** **テスト名は1バイトも書き換えていない。**
      "set_comment_visibility",
      "undo",
      "update_record",
      "write_records",
    ].sort(),
  );
  // **否定側**: 取り込みが「ツールとして出た」ら Δ10 で差し戻しである(線5)。
  for (const stem of ["import", "theme", "brand", "screenshot", "asset", "template"]) {
    expect(
      names.filter((name) => name.includes(stem)),
      `ツール名に ${stem} を含むものが増えている`,
    ).toEqual([]);
  }
});

/** `web/src/styles.css` の `:root` に宣言されたカスタムプロパティ名の集合。 */
function rootSlots(): string[] {
  const css = read("web", "src", "styles.css");
  const head = css.indexOf(":root {");
  const tail = css.indexOf("}", head);
  return [...css.slice(head, tail).matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1] as string);
}

/** `server.registerTool("name",` の名前を並び順のまま取り出す。 */
function registerToolNames(source: string): string[] {
  return [...source.matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1] as string);
}

// ---------------------------------------------------------------------------
// (B) 線3 / Δ8 —— 置き場を作っていない(`storage-paths.ts` の公開関数の集合)
// ---------------------------------------------------------------------------

test("(B) storage-paths.ts の公開関数の集合が着手前の10本と一致する(取り込みの置き場が1本も無い)", () => {
  const source = read("src", "kernel", "storage-paths.ts");
  const exported = [...source.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)].map(
    (m) => m[1] as string,
  );
  expect([...exported].sort()).toEqual(
    [
      "appBlobsDir",
      "appDbPath",
      "appDir",
      "appEscapeHatchDir",
      "appManifestPath",
      "appSnapshotsDir",
      "appsDir",
      "kernelDbPath",
      "parseAppDbPath",
      "snapshotDir",
    ].sort(),
  );
  // `export const` / `export type` の形でも置き場が生えていないこと(**関数だけ数えると抜ける**)。
  expect([...source.matchAll(/^export\s+const\s+(\w+)/gm)].map((m) => m[1] as string)).toEqual([]);
  for (const stem of ["theme", "Theme", "import", "Import", "asset", "Asset", "template"]) {
    expect(
      exported.filter((name) => name.includes(stem)),
      `storage-paths.ts に ${stem} を含む公開関数が増えている`,
    ).toEqual([]);
  }
});

// ---------------------------------------------------------------------------
// (C) 線11 —— 取り込めない3スロットが今日も取り込めないこと(**差集合で見る**)
// ---------------------------------------------------------------------------

test("(C) :root の28変数と $defs/theme の25スロットの差集合が、正確にこの3つである", () => {
  const theme = new Set<string>(
    Object.keys(readJson("schemas", "manifest.schema.json").$defs.theme.properties),
  );
  const notImportable = rootSlots().filter((slot) => !theme.has(slot));
  // **片方だけを数えても捕まらない** —— スロットを1つ足せば差は2件になり、
  // CSS 変数を1つ足せば差は4件になる。**どちらでも赤になる。**
  expect([...notImportable].sort()).toEqual(
    ["--border-style", "--focus-outline-style", "--shell-max-width"].sort(),
  );
  // 逆向き: `$defs/theme` に `:root` に無いスロットが在ってはならない(**対称性**)。
  expect([...theme].filter((slot) => !rootSlots().includes(slot))).toEqual([]);
});

// ---------------------------------------------------------------------------
// (D) 線6 —— `D-G3a`(組織テンプレートのリソース種化)を1バイトも含んでいない
//
// **【`X-G28` / `V9-M11-T02` / `D-V9-21` で移した】** この test は `docs/manual.md` /
// `docs/mcp-quickstart.md` を fs で読むため、公開単位(`apps/smailtalk/`)の外を読む検査に
// なっていた。**`tools/docs/theme-import-boundary-docs.test.ts` へ切り出した**
// (`filesUnder` / `walk` はそちら側にも複写してある)。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// (E) 線1 の後半 / 線7 —— `src/server/` はテーマを1語も知らない
// ---------------------------------------------------------------------------

// **【`V8-M21` の後半による更新。旧文と旧の期待値を1バイトも消していない】**
//
// **旧テスト名**: 「(E) src/server/ の製品コードに theme の語が1件も無い(サーバに
// 取り込みの口が無い)」。**旧の期待値**: `expect(hits.map(({ path }) => path)).toEqual([]);`。
//
// **この検査の doc は、赤くなる条件と、そのときにすべきことを自分で予告していた**(逐語):
// > **これが赤になるのは、サーバにテーマ専用のルートか取得経路が足された時である。**
// > **そのときは `v3-m6-gate-a.md` §8-1 の線7 を越えており、担保の強さが変わるので
// > 問1 から当て直す**(台帳の再審査条件 (d))。
//
// **その条件が 2026-08-10 に発火した。** **`V8-M21` の後半が
// `GET /api/apps/:app_id/public`(未ログインへ渡る最小限)の応答に配色を1キー足した**
// (台帳 `J-G24b` / ユーザ決定 `D-V8-34` / **メインの判断**。根拠は `app.ts` の同ルートの
// コメントに書いた)。
//
// **【正直に書く。丸めない】**
//  - **足したのは「テーマ専用のルート」ではない** —— **既に在る1本の口の応答に、
//    マニフェストの `app.theme` を**そのまま**載せただけである。**
//    **サーバはテーマを1バイトも解釈せず、検査もせず、書き込む口も持たない**
//    (**取り込みの口は今日も無い**。それは (A)〜(D) と (F) が別に固定している)。
//  - **それでも「線7 を越えていない」とは書かない** —— **越えたかどうかを決めるのは
//    門A であって本ファイルではない。** **再審査(`v3-m6-gate-a.md` の問1 から当て直す)は
//    `docs/` の担当であり、`V8-M21` の後半は ADR を1本も起草していない。**
//
// **【緩めていない。要求を2本増やした】** —— **(1) 許すのは `src/server/app.ts` の
// 1本ちょうどであり、2本目が現れたら赤くなる。** **(2) その1本が持っている `theme` の
// 使い方が「マニフェストの値をそのまま載せる」だけであることを、下で別に固定する。**
test("(E) src/server/ で theme の語を持つ製品コードは app.ts の1本ちょうどである(取り込みの口は今日も無い)", () => {
  // **審査(V3-M6-T00)が手で測った実測を、検査に落としたものである** ——
  // 「`src/server/*.ts` の非テストに `theme` の出現 0件」(審査本体 §3 問1 (c))。
  const hits = filesUnder("src", "server").filter(
    ({ path, text }) => !path.includes(".test.") && text.includes("theme"),
  );
  expect(hits.map(({ path }) => path)).toEqual([join("src", "server", "app.ts")]);

  // **その1本は、テーマを**読んで載せる**だけである** —— **書く口も、検査する口も持たない。**
  const appTs = hits[0]?.text ?? "";
  expect(appTs.includes("manifest.app.theme")).toBe(true);
  for (const forbidden of ["set_theme", "themeContrast", "checkTheme", "applyTheme"]) {
    expect(appTs.includes(forbidden), forbidden).toBe(false);
  }
});

// ---------------------------------------------------------------------------
// (F) 線12 —— `docs/manual.md` の双方向(**旧文言の復活を赤にし、今日も無いものを固定する**)
//
// **【`X-G28` / `V9-M11-T02` / `D-V9-21` で移した】** (F1)〜(F4) はいずれも `MANUAL`
// (`docs/manual.md` を fs で読んだもの)を検査していたため、公開単位(`apps/smailtalk/`)の外を
// 読む検査になっていた。**4本とも `tools/docs/theme-import-boundary-docs.test.ts` へ
// 切り出した**(`MANUAL` 定数・`readRepo` 関数を含む)。テスト名・期待値は1バイトも変えていない。
// ---------------------------------------------------------------------------
