import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

/**
 * **`V7-M1-T04` の完了条件 (iii)** —— **`ADR-0061` 限定4(判定は `src/server/owner-scope.ts` に
 * 集約する / `app.ts` に条件式を書かない)の機械的な固定。**
 *
 * ## **【測り方を変更した。黙って読み替えていない】**
 *
 * **起票(`docs/plan/v7/records/v7-m1.md` §1 の `V7-M1-T04`)の逐語**:
 *
 * > (iii) **`access_control` の綴りが `owner-scope.ts` 以外の非テスト製品コードに現れない**
 * > (`ADR-0061` 限定4 と同じ検査)。
 *
 * **この文字どおりの測り方は、`V7-M1-T01` / `T03` の完了後の今日、すでに成立しない。**
 * **実測すると `access_control` は `src/kernel/types.ts`(schema の型)/ `src/kernel/apply-diff.ts`
 * (適用の配管)/ `src/mcp/vocabulary.ts`(AI への説明文)に既に在る。** **どれも判定式ではない。**
 *
 * **`st_admin_readable` は1ファイルに閉じられるのに `access_control` は閉じられない理由は、
 * 綴りの性質が違うからである** —— **`st_admin_readable` は予約規約フィールド = 判定専用の
 * 綴りであり、`access_control` は manifest schema のキーなので、schema を読む配管が綴りを
 * 持たざるを得ない。**
 * **【`V8-M20` / 台帳 `J-G30` / `ADR-0301`】`st_admin_readable` は今日はもう無い**(廃止して
 * 面の規則 = 役割 × 対象(表)× 読取 へ置き直した)。**上の段落は当時の対比として残す** ——
 * **`access_control` が閉じられない理由の説明としては今日も成り立つ。**
 *
 * **したがって測り方を次に変更する**:
 *
 *  1. **`access_control` の綴りが `src/server/` の非テスト製品コードに現れるのは
 *     `owner-scope.ts` **だけ**である**(**特に `src/server/app.ts` に1件も現れない**)。
 *     —— **これが `ADR-0061` 限定4 の実質である。**
 *  2. **`src/server/` の外で `access_control` を持つ非テスト製品ファイルを、名前で全件列挙して
 *     固定する。** **列挙の外に1本でも生えたら赤くなる。**
 */

/**
 * 移した公開単位の根(`apps/smailtalk/`)。**`import.meta.dir` から数える** ——
 * cwd 相対で解くと `bun test` を打つ場所で結果が変わる(`src/` はもうルート直下に無い)。
 */
const PRODUCT_ROOT = join(import.meta.dir, "..", "..");

/** 走査の根(`ADR-0061` 限定4 の既存検査 = `owner-scope.test.ts` の (j) と同じ2本)。 */
const ROOTS = ["src", "web/src"] as const;

/**
 * **`src/server/` の外で `access_control` の綴りを持ってよい非テスト製品ファイルの全量。**
 *
 * **「今日そこに在るから許す」ではない。** **1本ずつ理由を書く** ——
 * **理由の類型は5つに限る**(schema の型 / 適用の配管 / **適用時の検査** / AI への説明文 /
 * **拒否の文面**)。
 * **【起票の裁定から1類型増えたことを隠さない】** メインの裁定は「schema の型・適用の配管・
 * AI への説明文に限る」と書いていた(3類型)。**`V7-M1-T05` が規約検査を
 * `src/kernel/referential-integrity.ts` に置いたので、「適用時の検査」が4つ目として増えた**。
 * **【`V7-M2-T01` で5つ目が増えたことも隠さない】** **`V7-M2-T01` が予約4語の拒否を
 * `schemas/` の側(`not` / `enum`)に置いた結果、その拒否の文面を利用者の言葉にするために
 * `src/kernel/ajv-error-adapter.ts` が `access_control` の綴りを持った**(schemaPath で
 * 位置を判定するため)。**これは判定式ではなく、拒否の文面である。**
 * **`Z-G12` `S2` の変更予定ファイルには `ajv-error-adapter.ts` が挙がっていなかった** ——
 * **予定より1本増えたことは `docs/plan/v7/records/v7-m2.md` §2-1 に書いた。**
 * **判定式(誰に何が見えるか)を書いてよいファイルは1本も無い** —— それは
 * `src/server/owner-scope.ts` の役目である(`ADR-0061` 限定4)。
 *
 * **【`V7-M6-T02`(`Z-G27`)で6つ目が増えたことを隠さない】** **`web/src/fields/input.tsx` が
 * 付与表の入力画面で「相手」の候補を絞るために、宣言(付与表・対象・相手・利用者表・
 * 引き継ぎ元)を読む。** **これは6つ目の類型 =「画面の候補の絞り込み」である。**
 * **`Z-G27` `S2` の変更予定ファイルには本ファイル(検査の基準値)が挙がっていなかった** ——
 * **予定より1本増えたことは `docs/plan/v7/records/v7-m6.md` に書く。**
 * **【この1本が判定式を持たないことを、あわせて固定する】** —— **`web/src` 側は
 * `read` / `write` / `delete` を1つも計算せず、`judgeRecordAccess` も呼ばない**
 * (固定は `web/test/reference-candidate-permission.test.tsx` の (3))。
 * **候補に出さないことは書込を止めることではなく、書込を止めているのは `Z-G33` である。**
 *
 * **【`V7-M6-T03`(`Z-G28`)で7つ目が増えたことを隠さない】** **`src/kernel/requirements-doc.ts` が
 * 宣言を文章にするために綴りを持つ。** **これは7つ目の類型 =「要件ドキュメントの文章化」である。**
 * **`Z-G28` `S2` の変更予定ファイルには本ファイル(検査の基準値)が挙がっていなかった** ——
 * **予定より1本増えたことは `docs/plan/v7/records/v7-m6.md` に書く。**
 * **【この1本が判定式を持たないことを、あわせて固定する】** —— **出るのは宣言だけで、付与の行の
 * 中身を1文字も出さない**(固定は `src/kernel/requirements-doc.test.ts` の `V7-M6-T03` A3)。
 * **要件ドキュメントを読んでも「誰がどの行を見られるか」は分からない。**
 *
 */
const ALLOWED_OUTSIDE_SERVER: readonly { path: string; reason: string }[] = [
  {
    path: join("src", "kernel", "types.ts"),
    reason: "schema の型(`Table.access_control` / `TableChanges.access_control`)",
  },
  {
    path: join("src", "kernel", "apply-diff.ts"),
    reason: "適用の配管(`foldChangeTable` が値を適用後マニフェストへ運ぶ)",
  },
  {
    path: join("src", "kernel", "referential-integrity.ts"),
    reason: "適用時の検査(`V7-M1-T05`。規約から外れた宣言を差分ごと拒否する)",
  },
  {
    path: join("src", "kernel", "ajv-error-adapter.ts"),
    reason:
      "拒否の文面(`V7-M2-T01`。予約4語を権限名に書いたときの文言を利用者の言葉にするため、schemaPath でその位置だけを引く)",
  },
  {
    path: join("src", "mcp", "vocabulary.ts"),
    reason: "AI への説明文(`change_table` で効くキーの一覧と散文)",
  },
  {
    path: join("web", "src", "fields", "input.tsx"),
    reason:
      "画面の候補の絞り込み(`V7-M6-T02` / `Z-G27`。付与表の「相手」の候補を親の行に権限を持つ人へ絞るために宣言を読む。判定式は1つも持たない)",
  },
  {
    path: join("src", "kernel", "requirements-doc.ts"),
    reason:
      "要件ドキュメントの文章化(`V7-M6-T03` / `Z-G28`。宣言だけを文にする。付与の行の中身を1文字も出さず、判定式は1つも持たない)",
  },
];

/** `src` / `web/src` 配下の非テスト `.ts` / `.tsx` を全部読む。 */
async function filesContaining(needle: string): Promise<string[]> {
  const hits: string[] = [];
  for (const root of ROOTS) {
    // **走査は絶対パスで行い、集める側は公開単位の根からの相対に戻す** ——
    // 期待値(`join("src", "server", "owner-scope.ts")` など)は相対のままである。
    const entries = await readdir(join(PRODUCT_ROOT, root), {
      recursive: true,
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(ts|tsx)$/.test(entry.name) || entry.name.endsWith(".test.ts")) {
        continue;
      }
      const path = join(entry.parentPath, entry.name);
      if ((await Bun.file(path).text()).includes(needle)) {
        hits.push(relative(PRODUCT_ROOT, path));
      }
    }
  }
  return hits.sort();
}

describe("V7-M1-T04 (iii): access_control の綴りの置き場所を固定する", () => {
  test("(1) src/server/ の非テスト製品コードで access_control を持つのは owner-scope.ts だけである", async () => {
    const hits = await filesContaining("access_control");
    const inServer = hits.filter((path) => path.startsWith(`${join("src", "server")}/`));
    expect(inServer).toEqual([join("src", "server", "owner-scope.ts")]);
  });

  test("(1b) src/server/app.ts には access_control が1件も現れない(ADR-0061 限定4 の実質)", async () => {
    const source = await Bun.file(join(PRODUCT_ROOT, "src", "server", "app.ts")).text();
    expect(source.includes("access_control")).toBe(false);
  });

  // **【`V7-M2-T01` による期待値の更新。検査は1本も消していない】** **着手前は4本だった。**
  // **5本目は `src/kernel/ajv-error-adapter.ts`**(理由は `ALLOWED_OUTSIDE_SERVER` の doc)。
  // **【`V7-M6-T02` による期待値の更新。検査は1本も消していない】** **直前は5本だった。**
  // **6本目は `web/src/fields/input.tsx`**(理由は `ALLOWED_OUTSIDE_SERVER` の doc)。
  // **【`V7-M6-T03` による期待値の更新。検査は1本も消していない】** **直前は6本だった。**
  // **7本目は `src/kernel/requirements-doc.ts`**(理由は `ALLOWED_OUTSIDE_SERVER` の doc)。
  // **旧のテスト名は「…列挙した6本だけである」/「列挙した6本にはすべて理由が…」だった。**
  test("(2) src/server/ の外で access_control を持つ非テスト製品ファイルは、列挙した7本だけである", async () => {
    const hits = await filesContaining("access_control");
    const outsideServer = hits.filter((path) => !path.startsWith(`${join("src", "server")}/`));
    expect(outsideServer).toEqual(ALLOWED_OUTSIDE_SERVER.map((entry) => entry.path).sort());
  });

  test("(2b) 列挙した7本にはすべて理由が書かれている(「今日そこに在るから許す」にしない)", () => {
    expect(ALLOWED_OUTSIDE_SERVER).toHaveLength(7);
    for (const entry of ALLOWED_OUTSIDE_SERVER) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  // **【`V8-M20` / 台帳 `J-G30` / `ADR-0301`】予約規約フィールドは 5本 → 4本。**
  // **`st_admin_readable`(運営可視)を廃止し、面の規則(役割 × 対象(表)× 読取)へ置き直した。**
  // **旧の期待値: `expect(lines).toHaveLength(5);`(`ADMIN_READABLE_FIELD` を含んでいた)。**
  // **旧のテスト名: 「(3) 予約規約フィールドの定数は5本のままである(v7 は1本も足していない)」。**
  // **v7 が1本も足していないことは今日も変わらない** —— **減らしたのは `V8-M20` である。**
  test("(3) 予約規約フィールドの定数は4本である(v7 は1本も足さず、V8-M20 が1本減らした)", async () => {
    // **`v7-m0.md` §5-3 の逐語「v7 が足す本数 = 0本」の機械的な固定。**
    // 素朴な `^export const [A-Z_]+_FIELD = ` の**行数**を数える(起票の完了条件 (ii) の式)。
    const source = await Bun.file(join(PRODUCT_ROOT, "src", "server", "owner-scope.ts")).text();
    const lines = [...source.matchAll(/^export const [A-Z_]+_FIELD = .*$/gm)];
    expect(lines).toHaveLength(4);
  });
});
