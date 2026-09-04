/**
 * 語彙の名前の一覧と実物を突き合わせる中央の検査(`V5-M29-T01`)。
 *
 * 上位: `docs/adr/0250-vocabulary-name-inventory.md`(`A-G2`。門A。限定採用。限定表14行)/
 *       `docs/plan/v5/records/v5-m29.md` §4(設計)/ §4-2(突き合わせ規則)/ §4-6(歯)/
 *       `docs/plan/v5/records/v5-m29-t01.md`(本検査を作ったタスクの記録)。
 *       ユーザ決定 `D-V5-90`(選ばれた見出し =「名前の一覧1本に寄せる」)。
 *
 * ## この検査が置き換えるもの
 *
 * 語彙の**総量**を数値リテラルで焼き込んだ検査が `72726aa` 時点で 194箇所ある。そのうち
 * 「そのあと誰も触っていないこと」を**他人に対して**主張している側が 128件・39ファイルある
 * (`v5-m29.md` §2-2 の D)。**その 128件 を消し、ここへ寄せる**(消す作業は
 * `V5-M29-T02`〜`V5-M29-T05` が行う。**`V5-M29-T01` は1件も消していない**)。
 *
 * ## 基準を「件数」にしない
 *
 * `scripts/kernel-export-drift.test.ts` が Δ8 について既に採っている形をそのまま採る。
 * 同ファイルの doc コメントの逐語:
 *
 * > **件数を基準にすると、基準そのものが検証不能な数値になる。加えて件数は
 * > 「1本消して1本足す」を素通りさせる。**
 *
 * そこで基準は **名前の一覧**(`scripts/vocabulary-snapshot.txt`)とし、
 * **増えた名前と減った名前を名指しで**、**順序の食い違いも位置つきで**赤にする。
 *
 * ## 突き合わせの規則(`ADR-0250` §Decision 3)
 *
 * 1. **両向きで比べる。** 実物にあって一覧に無い名前と、一覧にあって実物に無い名前を、
 *    どちらも名指しで出す。
 * 2. **順序ごと比べる**(`sort()` して比べない)。消す 128件 のうち少なくとも3件が
 *    「名前**も順序も**1バイトも変わっていない」を測っているためである
 *    (`src/kernel/workflow-schema.test.ts` の `DIFF_OPS` / `view-menu-listing.test.ts` の
 *    `view.properties` / `validate.test.ts`)。**ソートして比べると、その3件が測っていた
 *    ものを中央が測らなくなる。**
 * 3. **本数は一覧から導く。この検査には数値リテラルを1つも書かない。**
 *    書いた時点で、中央が195箇所目の焼き込みになる(`ADR-0250` §Decision 7 の線2)。
 *
 * ## 赤くなったら何をするか
 *
 * **一覧を更新する前に、増えた名前が `ADR-0007` の門A を通ったかを審査すること。**
 * この検査が機械化したのは**検出**であって**審査ではない**。
 *
 * ## この検査の限界(先に書く。憲法6)
 *
 * 1. **一覧の更新は人間が行う。** 「赤くなったので更新した」だけで通せる。
 *    `scripts/kernel-export-snapshot.txt` の doc コメントが同じ危険を先に名指ししており、
 *    **本検査が新しく作る穴ではないが、塞いでもいない。**
 * 2. **「誰が動かしたか」を1件も言わない。** 消す 128件 は「**この ADR が**語彙を
 *    動かさなかった」を主張していた。ここは「**今日の語彙が**一覧と一致する」しか言わない
 *    (`ADR-0250` §Decision 5 の (1)。**これが最大の損である**)。
 * 3. **部分実行では測られない。** このファイルを走らせない限り、8主題は1件も測られない。
 * 4. **単一障害点である。** この1本を `skip` にした日、8主題の見張りは全部消える。
 * 5. **8主題の外の焼き込み 89箇所 は1件も消えない**(`$defs/theme` 40 / `$defs/field` 20
 *    ほか。`v5-m29.md` §2-7)。**「語彙を1つ増やす作業がこのファイル1つで済む」は
 *    8主題についてしか言えない。**
 * 6. **`enum` の値・`$comment` の文面・型の定義を1つも見ていない。** 見ているのは
 *    下の `collectVocabulary()` が並べる名前だけである。
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
// 【`V5-M29-T06`】**静的 import である。`V5-M29-T01` は動的 `import()` で書いていた。**
//   `T01` の理由は「静的にすると `scripts/kernel-import-drift.test.ts`(`ADR-0009` 限定2 の
//   層またぎ台帳)が赤くなり、その解消には `scripts/kernel-import-snapshot.txt` に3行が要る。
//   `T01` は既存ファイルを1バイトも変更しない完了条件を持つ」であった。
//   `T01` はその形の損を自ら申告している —— **同台帳の doc コメントが「動的 `import()` と
//   `require()` は拾わない」と書いているため、本ファイルのカーネル依存が台帳に載らない。**
//   **`T06` は静的へ戻した。** 台帳には3行(`DIFF_OPS` / `FIELD_TYPES` / `RESOURCE_KINDS`)を
//   足してある。**中央の検査が `src/kernel/types.ts` の3配列を値として読んでいることが、
//   これで `ADR-0009` 限定2 の台帳から引ける。**
// **【`V8-M8`。台帳 `Q-G1`】4本目の主題 `VIEW_TYPES` を足した。**
// **足した理由(実測。2026-08-14)**: **着手前、この中央の検査は `VIEW_TYPES` を1つも
// 見ていなかった** —— **一覧(`scripts/vocabulary-snapshot.txt`)に `VIEW_TYPES:` で
// 始まる行が1本も無い**(在るのは `FIELD_TYPES:` / `RESOURCE_KINDS:` / `DIFF_OPS:` の
// 3配列だけである)。**つまり画面種別が3種から4種に増えても、中央は緑のままだった。**
// **`RESOURCE_KINDS` に `report_view` も入るので今回は結果的に検出されたが、それは
// 重なりの偶然であって、画面種別だけを増やす決定は素通りしていた。**
// **層またぎは `scripts/kernel-import-snapshot.txt` に1行足してある**(`ADR-0009` 限定2 の
// 受け皿)—— **同じファイルから既に3本を値として読んでおり、種類は増えていない。**
import { DIFF_OPS, FIELD_TYPES, RESOURCE_KINDS, VIEW_TYPES } from "../src/kernel/types.ts";

const REPO_ROOT = dirname(import.meta.dir);
const SNAPSHOT_PATH = join(import.meta.dir, "vocabulary-snapshot.txt");

type JsonSchemaNode = {
  properties?: Record<string, unknown>;
  required?: string[];
  oneOf?: JsonSchemaNode[];
  // 【`V8-M22` / `J-G37`】**`anyOf` と `items` を足した** —— どちらも着手前は型に無く、
  // したがって1つも辿れなかった(下の `pushKeys()` の doc に実測の内訳)。
  anyOf?: JsonSchemaNode[];
  items?: JsonSchemaNode;
  // 【`V10-M24-T04` / `CM-G29`】**`additionalProperties` を足した**(門外。`ADR-0374` `CM-G29`)。
  // **値がオブジェクトのときだけ辿る** —— `false`(未知のキーを閉じる)や `true` は
  // 形を1つも持たないので、辿っても名前が1つも出ない。
  additionalProperties?: JsonSchemaNode | boolean;
  $defs?: Record<string, JsonSchemaNode>;
};

function readSchema(fileName: string): JsonSchemaNode {
  return JSON.parse(readFileSync(join(REPO_ROOT, "schemas", fileName), "utf-8")) as JsonSchemaNode;
}

/**
 * 名前を**宣言順のまま**並べる。**ソートしない。**
 *
 * `Object.keys()` は JSON の出現順を保つので、スキーマのキーの並びがそのまま出る。
 * 並びが変わればここの出力が変わり、下の `misordered` が位置つきで赤になる。
 */
function collectVocabulary(input?: { label: string; schema: JsonSchemaNode }): string[] {
  const lines: string[] = [];
  // 【`V5-M29-T06` が足した】**「`properties` / `required` という入れ物が在ること自体」を
  // 名前として持つ節。** 一覧の**末尾**に固めて置く(末尾にしたのは、既存の 340行 の位置を
  // 1つも動かさないためである —— 位置が動くと `misordered` の意味が変わる)。
  //
  // **理由 = `V5-M29-T02` が実測した穴(同記録 §3-3 の m4)を塞ぐため。**
  // `T02` が消した `web/test/shell-navigation-boundary.test.ts` の2本は
  // 「`properties` を**持つ** `$defs` の名前の集合」そのものを突き合わせていたので、
  // **キーが1本も入っていない空の `properties: {}` が足されただけでも赤になった。**
  // 下の `pushKeys()` は `properties` の**キーの名前**を並べるので、キーが0本なら行が
  // 1つも生まれず、**中央は緑のままだった。** `T02` は「消した側は赤・中央は緑」と実測し、
  // 「中央を直す権限が本タスクに無い」として穴のまま `T06` へ送った。
  // **`V5-M29-T06` が同じ加工を今日の木の複製で再現して緑であることを確かめ、塞いだ。**
  //
  // **これは `ADR-0250` §Decision 5 が「弱くなった」と書いていない、唯一の実測の穴であった。**
  const presence: string[] = [];

  // 【`V8-M22` / `J-G37` が足した】**入れ子の定義も同じ規則で辿る。**
  //
  // **着手前の `pushKeys()` は「`$defs` の直下」と「`$defs` の `oneOf` の各要素」の2段しか
  // 見ておらず、`properties` の値の中・`items` の中・`anyOf` の各要素を1つも見ていなかった。**
  // **その結果、`schemas/manifest.schema.json` にインラインで書かれた定義の内側のキーが
  // 1つも数えられていなかった** —— **`V8-M20` の申し送り(`docs/plan/v8/records/v8-m20.md:1214`)が
  // 「語彙の一覧は、増えた側の内側のキーを今日も1つも数えていない」と名指しした穴である。**
  //
  // **実測で数えた漏れ**(`V8-M22` が着手前の木で数えた。**名前の総数 368 → 527。増えた 159行・
  // 減った 0行**):
  //   - `$defs/app.properties.roles.items`(`id` / `name` / `rules`)と
  //     その `rules.items`(`target` / `table` / `field` / `view` / `action` / `can` / `when`)
  //     …… **v8 の軸3 が足した語彙そのものが1つも数えられていなかった。**
  //   - `$defs/role_condition` の `anyOf` 5形(葉2種 + `and` / `or` / `not`)
  //     …… **`$defs` の29本目でありながら、名前を1つも出していなかった**
  //     (この節が `oneOf` しか辿らず、`role_condition` は `anyOf` で書かれているため)。
  //     **【`V8-M26`(2026-08-11)/ ユーザ決定 `D-V8-70`。上の「5形(葉2種 …)」は今日は
  //     偽である。旧文を1バイトも消していない】** **今日は 6形(葉3種 + `and` / `or` /
  //     `not`)であり、6形目は `{ field, is_empty }`(その項目が空か)である。**
  //     **一覧に足したのは6行ちょうどで、異なり名で増えたのは `is_empty` の1語だけである。**
  //   - `$defs/filter_node` の `anyOf`・`$defs/related_list` / `$defs/filter_and_array` の `items`・
  //     `$defs/table.properties.access_control` の内側(v7 の点の宣言)・`$defs/app.properties.user_kinds`
  //     の内側・`$defs/app.properties.theme.properties.origin` ほか。
  //
  // **【この節が今日も数えないもの。正直に書く】** **`allOf` / `if` / `then` / `else` を1つも辿らない。**
  // **`schemas/diff.schema.json` の `$defs/operation` は差分操作18種ぶんの `if`/`then` を `allOf` に
  // 持つが、そこに現れるキーは同 `$defs` の `properties`(10キー)に全部出ているので、
  // 辿らないことで**名前**が1つも落ちていないことは実測した** —— **ただし「その op のとき
  // どのキーが `false` に閉じられているか」は今日も1件も見ていない。**
  // **`enum` の値・`pattern`・`$comment` の文面を1つも見ていないのは着手前と同じである。**
  const pushKeys = (prefix: string, node: JsonSchemaNode | undefined): void => {
    if (node === undefined || node === null || typeof node !== "object") return;
    if (node.properties !== undefined) {
      presence.push(`${prefix}.properties=present`);
      // **キーの名前を出したら、その値の中も同じ規則で辿る**(深さ優先。宣言順のまま)。
      for (const [key, child] of Object.entries(node.properties)) {
        lines.push(`${prefix}.properties:${key}`);
        pushKeys(`${prefix}.properties.${key}`, child as JsonSchemaNode);
      }
    }
    if (node.required !== undefined) {
      presence.push(`${prefix}.required=present`);
      for (const key of node.required) lines.push(`${prefix}.required:${key}`);
    }
    // **配列の要素の定義**(`items`)。**インラインで書かれた要素の形はここにしか無い。**
    if (node.items !== undefined) pushKeys(`${prefix}.items`, node.items);
    // **選択肢の形**(`oneOf` / `anyOf`)。**着手前は `oneOf` だけを、しかも `$defs` の直下でだけ
    // 辿っていた** —— **`anyOf` で書かれた `$defs`(`filter` / `filter_node` / `role_condition`)は
    // 名前を1つも出していなかった。**
    for (const keyword of ["oneOf", "anyOf"] as const) {
      const variants = node[keyword];
      if (variants === undefined) continue;
      variants.forEach((variant, index) => {
        pushKeys(`${prefix}.${keyword}.${index}`, variant);
      });
    }
    // --- ここから1ブロック: 【`V10-M24-T04` / `CM-G29`。門外】**値の形で広がる語彙** ---
    //
    // **着手前は `additionalProperties` を1つも辿っていなかった。** **キーの名前が宣言に
    // 書かれず、値の形にしか現れない語彙**(= 名前を書く側がアプリで、形だけをスキーマが
    // 決めている宣言)は、**一覧に1行も出ていなかった。**
    //
    // **実測(2026-08-23。この木)**: `schemas/manifest.schema.json` の
    // `additionalProperties` は **57件**・`schemas/diff.schema.json` は **7件**。
    // **そのうち値がオブジェクトなのは manifest の8件だけ**であり、残りは全部 `false` である。
    // **8件のうち、内側に `properties` / `required` を持つのは
    // `$defs/view.properties.field_groups` の1件だけ**(他の7件は `enum` / `$ref` /
    // `type` しか持たないので、辿っても名前が1行も出ない)。
    //
    // **値がオブジェクトのときだけ辿る。** `false`(未知のキーを閉じる)や `true` は形を
    // 1つも持たない。**`typeof` で判定するので `null` も入りうるが、`pushKeys` の先頭が
    // `null` を弾く。**
    //
    // **【この1ブロックを足しても、今日も辿らないもの】** **`allOf` / `if` / `then` /
    // `else` を1つも足していない**(上の doc が「辿らない」と書いた4つ。1つも増やしていない)。
    // **辿るキーワードは6つちょうど**: `properties` / `required` / `items` / `oneOf` /
    // `anyOf` / `additionalProperties`。
    const extra = node.additionalProperties;
    if (typeof extra === "object") pushKeys(`${prefix}.additionalProperties`, extra);
    // --- ここまで1ブロック ---
  };

  // 【`V10-M24-T04` / 裁定12】**合成した小さなスキーマを渡す継ぎ目。**
  //
  // **着手前、この関数は引数を1つも取らず、`pushKeys` はこの関数の中のクロージャだった** ——
  // **辿り方そのものを検査に掛ける手立てが1つも無かった。** `schemas/` の実物を入力にすると、
  // 増分の出方が今日のスキーマの形に依存してしまい、**「辿っているから出た」のか
  // 「たまたまそこに在るから出た」のかを分けられない。**
  //
  // **入力を渡したときは、8主題の4配列(`FIELD_TYPES` ほか)も `schemas/` の実物も
  // 1バイトも読まない。** 出す順は本番と同じ(名前が先・在り方が後)。
  // **【ファイルを新設していない】**(裁定13)。継ぎ目はこの1本だけである。
  if (input !== undefined) {
    pushKeys(input.label, input.schema);
    return [...lines, ...presence];
  }

  for (const name of FIELD_TYPES) lines.push(`FIELD_TYPES:${name}`);
  for (const name of RESOURCE_KINDS) lines.push(`RESOURCE_KINDS:${name}`);
  for (const name of DIFF_OPS) lines.push(`DIFF_OPS:${name}`);
  // **【`V8-M8`】4本目の主題。****末尾に足してある** —— **既存3配列の行の位置を1つも
  // 動かさないためである**(位置が動くと `misordered` の意味が変わる。`V5-M29-T06` が
  // `presence` を末尾に置いたのと同じ理由)。
  for (const name of VIEW_TYPES) lines.push(`VIEW_TYPES:${name}`);

  for (const [schemaLabel, fileName] of [
    ["manifest", "manifest.schema.json"],
    ["diff", "diff.schema.json"],
  ] as const) {
    const schema = readSchema(fileName);
    pushKeys(schemaLabel, schema);
    const defs = schema.$defs ?? {};
    for (const defName of Object.keys(defs)) lines.push(`${schemaLabel}.$defs:${defName}`);
    // 【`V8-M22` / `J-G37`】**`oneOf` の明示的な繰り返しをここから消した** ——
    // **`pushKeys()` が `oneOf` / `anyOf` / `items` / 入れ子の `properties` を同じ規則で辿るので、
    // ここに2つ目の辿り方を書くと規則が2箇所に割れる。** **出る名前は1つも減っていない**
    // (`$defs` 直下の `oneOf` は今日も同じ位置・同じ綴りで出る)。
    for (const [defName, def] of Object.entries(defs)) {
      pushKeys(`${schemaLabel}.$defs.${defName}`, def);
    }
  }

  return [...lines, ...presence];
}

/** 空行と `#` 始まりを捨てる。形は `scripts/kernel-export-snapshot.txt` に倣う。 */
function readSnapshot(): string[] {
  return readFileSync(SNAPSHOT_PATH, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

type Drift = {
  /** 実物にあって一覧に無い名前(= 語彙が増えた側) */
  added: string[];
  /** 一覧にあって実物に無い名前(= 語彙が減った側) */
  removed: string[];
  /** 名前の集合は同じだが並びが違う位置 */
  misordered: string[];
};

/** 差が1つも無いときの値。**この検査の唯一の期待値であり、数値を1つも含まない。** */
const NO_DRIFT: Drift = { added: [], removed: [], misordered: [] };

/**
 * **両向き・順序ごと**に突き合わせる。
 *
 * `added` / `removed` は集合の差で、`misordered` は同じ位置の食い違いである。
 * **並べ替えただけのとき、`added` と `removed` は空のまま `misordered` だけが埋まる** ——
 * それが「順序ごと比べている」ことの意味である(下の歯の検査4が実際に確かめる)。
 *
 * **`misordered` は、名前の集合が一致しているときだけ埋める。** 1件足しただけで以降の
 * 位置が全部ずれ、増えた1件が数百行の位置ずれに埋もれるためである(**`V5-M29-T01` が
 * 実測して形を変えた** —— 記録 §歯の実測)。**集合が食い違うときは `added` / `removed`
 * が名指しで出るので、検出そのものは1件も落ちない。**
 */
function drift(actual: string[], snapshot: string[]): Drift {
  const snapshotSet = new Set(snapshot);
  const actualSet = new Set(actual);
  const added = actual.filter((name) => !snapshotSet.has(name));
  const removed = snapshot.filter((name) => !actualSet.has(name));
  // `added.length === 0` と書かないのは、**この検査に数値リテラルを1つも書かない**ためである
  // (`ADR-0250` §Decision 3 の 3 / §Decision 7 の線2)。
  const setsAgree = ![...added, ...removed].some(() => true);
  return {
    added,
    removed,
    misordered: setsAgree
      ? actual
          .map((name, index) =>
            name === snapshot[index]
              ? ""
              : `[${index}] 実物=${name} / 一覧=${snapshot[index] ?? "(無し)"}`,
          )
          .filter((entry) => entry !== "")
      : [],
  };
}

test("語彙の名前が scripts/vocabulary-snapshot.txt と一致する(両向き・順序ごと)", () => {
  // 赤くなったら、まず `added` が `ADR-0007` の門A を通ったかを審査すること。
  // **一覧の更新はその審査の後である。**
  expect(drift(collectVocabulary(), readSnapshot())).toEqual(NO_DRIFT);
});

test("一覧を読めていないのに緑になる壊れ方をしない", () => {
  // `kernel-export-drift.test.ts` / `kernel-types-no-import.test.ts` と同じ手口。
  // **件数では確かめない**(件数を書いた時点で焼き込みになる)。名前で確かめる。
  const actual = collectVocabulary();
  expect(actual).toContain("FIELD_TYPES:text");
  expect(actual).toContain("RESOURCE_KINDS:app");
  expect(actual).toContain("DIFF_OPS:add_table");
  // **【`V8-M8`】4本目の主題も、読めていることを名前で確かめる。**
  expect(actual).toContain("VIEW_TYPES:form");
  expect(actual).toContain("manifest.$defs:view_action");
  expect(actual).toContain("diff.$defs:view_changes");
  expect(readSnapshot()).toContain("FIELD_TYPES:text");
  // 空の一覧を相手にしたら赤になる(= 一覧が空でも緑、という壊れ方をしない)。
  expect(drift(actual, [])).not.toEqual(NO_DRIFT);
  expect(drift([], actual)).not.toEqual(NO_DRIFT);
});

test("一覧に同じ行が2度出ていない(重複は片方が消えても気づけなくなる)", () => {
  const snapshot = readSnapshot();
  expect([...new Set(snapshot)]).toEqual(snapshot);
});

// --- 歯があることの自己検査(`v5-m29.md` §4-6 (i) / `ADR-0250` 限定12。4本) ---
//
// **加工するのは読み込んだ配列のコピーであって、`scripts/vocabulary-snapshot.txt`
// そのものではない。** 位置指定を書かずに済ませるため、分割代入で先頭2件を取り出している
// (**この検査にも数値リテラルを1つも書かない**)。

test("歯1: 一覧から1件落とすと赤になる", () => {
  const snapshot = readSnapshot();
  const [, ...withoutFirst] = snapshot;
  expect(drift(snapshot, withoutFirst)).not.toEqual(NO_DRIFT);
});

test("歯2: 一覧の1件を改名すると赤になる", () => {
  const snapshot = readSnapshot();
  const [first, ...rest] = snapshot;
  expect(drift(snapshot, [`${first}-renamed-by-self-check`, ...rest])).not.toEqual(NO_DRIFT);
});

test("歯3: 一覧に1件足すと赤になる", () => {
  const snapshot = readSnapshot();
  expect(drift(snapshot, [...snapshot, "self-check:added-name"])).not.toEqual(NO_DRIFT);
});

test("歯4: 一覧の2件を入れ替えただけでも赤になる(順序ごと比べていることの実測)", () => {
  const snapshot = readSnapshot();
  // `first` / `second` は `string | undefined` になるので、**空の一覧を相手に
  // 「入れ替えた」と称して緑になる**壊れ方を先に潰す(`toBeDefined` は数値を書かない)。
  const [first, second, ...rest] = snapshot;
  expect(first).toBeDefined();
  expect(second).toBeDefined();
  const swapped = [second ?? "", first ?? "", ...rest];
  const result = drift(snapshot, swapped);
  // **名前の集合は同じである** —— それでも赤になるのが「順序ごと」の意味である。
  expect(result.added).toEqual([]);
  expect(result.removed).toEqual([]);
  expect(result).not.toEqual(NO_DRIFT);
  expect(result.misordered).not.toEqual([]);
});

// --- 【`V10-M24-T04` / `CM-G29`】辿り方そのものを検査に掛ける(1本) ---
//
// **入力は合成した小さなスキーマである。** **今日の `schemas/manifest.schema.json` を
// 入力にしない** —— 実物を入力にすると、名前が出た理由が「辿ったから」なのか
// 「たまたまそこに在るから」なのか分けられず、**辿る1ブロックを削っても
// 別の理由で緑になりうる。** 合成した入力なら、**1ブロックを削れば必ず赤になる。**
//
// **数値リテラルを1つも書いていない**(`ADR-0250` §Decision 3 の 3)。

test("値の形で広がる語彙(additionalProperties)を辿る", () => {
  // 「まとまりの名前 → その値」のような、**キーの名前をアプリが決める宣言**を写したもの。
  const traversed = collectVocabulary({
    label: "synthetic",
    schema: { additionalProperties: { properties: { zz: {} }, required: ["zz"] } },
  });
  // **辿る → 出る。** 1ブロックを削るとこの3本が落ちる。
  expect(traversed).toContain("synthetic.additionalProperties.properties:zz");
  expect(traversed).toContain("synthetic.additionalProperties.required:zz");
  expect(traversed).toContain("synthetic.additionalProperties.properties=present");

  // **値が boolean のときは辿らない** —— `false` は形を1つも持たない。
  // **辿らない → 出ない**の側を、同じ形の入力で確かめる。
  const closed = collectVocabulary({ label: "closed", schema: { additionalProperties: false } });
  expect(closed.some((name) => name.includes("additionalProperties"))).toBe(false);

  // **辿るキーワードが6つちょうどであること**(`allOf` / `if` / `then` / `else` を
  // 1つも足していない)。**足すと、下の2本のどちらかが赤になる。**
  const notTraversed = collectVocabulary({
    label: "other",
    schema: {
      allOf: [{ properties: { aa: {} } }],
      if: { properties: { bb: {} } },
    } as JsonSchemaNode,
  });
  expect(notTraversed).toEqual([]);
  const traversedSix = collectVocabulary({
    label: "six",
    schema: {
      properties: { p1: {} },
      required: ["p1"],
      items: { properties: { i1: {} } },
      oneOf: [{ properties: { o1: {} } }],
      anyOf: [{ properties: { a1: {} } }],
      additionalProperties: { properties: { x1: {} } },
    },
  });
  for (const name of [
    "six.properties:p1",
    "six.required:p1",
    "six.items.properties:i1",
    "six.oneOf.0.properties:o1",
    "six.anyOf.0.properties:a1",
    "six.additionalProperties.properties:x1",
  ]) {
    expect(traversedSix).toContain(name);
  }
});
