/**
 * `V8-M13-T04`(台帳 `Q-G30` / `Q-G33` / `Q-G29`): **集計まわりの散文が、今日の事実から
 * ずれたまま配られていないことの検査。**
 *
 * 上位: `docs/plan/v8/records/v8-m13.md` §5 の `T04` 行(完了条件 (i)〜(ix))/
 *       `docs/plan/v8/records/v8-m7.md` §5(`Q-G29` = 限定採用。**島の道を選ぶ条件を
 *       有限の3つに閉じた**)/ §10-6 /
 *       `docs/plan/v8/02-report-aggregation-baseline.md` §9 の禁止24項(とくに 1 / 2 / 3 /
 *       13 / 21 / 22 / 24)。
 *
 * ## なぜ要るのか
 *
 * **この軸は5回に分けて実装が入った** —— `V8-M8`(宣言)/ `V8-M9`(結合)/ `V8-M10`
 * (可視性と上限)/ `V8-M11`(画面)/ `V8-M12`(グラフ)/ `V8-M13-T02`(MCP から読む道具)。
 * **そのたびに散文は「今日はまだ無い」と書き、次のマイルストーンの名前を将来形で添えた。**
 * **`V8-M10` / `V8-M11` が終わっても、その将来形は直されずに残った** ——
 * **訂正文そのものが嘘になった**(`v8-m13.md` §0-4 の 11。実測 4行・8句)。
 *
 * **ここがその検出である。** **人が読み直すのをやめて、機械に数えさせる。**
 *
 * ## 何を見るか(**4つだけ**)
 *
 * 1. **今日の事実4つ**(画面に描かれる / グラフは棒と折れ線の2種 / 見る人によって数が
 *    変わる / MCP に `read_report` がある)が、**製品が配る散文7本すべてに書いてある。**
 * 2. **`Q-G29` の3点**((a) 2本の道が両方在る /(b) 正は宣言の道 /(c) 島の道を選ぶ
 *    条件が**3つちょうど**)が、**2本の道を論じている散文5本すべてに書いてある。**
 *    **(c) の本数は散文から数える** —— **散文に書いた条件の目印の数を数えて、
 *    門Aが閉じた条件の本数と突き合わせる。**
 * 3. **公開ツールの本数**を書いた散文が、**今日の本数**(実サーバの `tools/list` から
 *    数える)を併記している。**旧文は1バイトも消さない作法なので、「23本」が残ることは
 *    赤にしない** —— **赤にするのは「今日の本数がどこにも書いていない」ときだけである。**
 * 4. **偽になった将来形**(「描くのは `V8-M11`」「掛けるのは `V8-M10`」)を載せた
 *    ファイルに、**その将来がもう来たことを述べる今日の事実が同居している**
 *    (`scripts/skill-vocabulary-drift.test.ts` の `pair` 行と同じ考え方)。
 *
 * ## この検査が**しない**こと(**先に書く。誇張しない**)
 *
 * - **散文が正しいかを1文字も見ていない。** 見るのは「その字面がそのファイルに在るか」
 *   と「目印を数えた本数が一致するか」だけである。
 * - **配り先の一覧が全量であるかを判定しない** —— **一覧はこのファイルが持つ人間の宣言
 *   である**(`scripts/report-limit-prose-drift.test.ts` が先に申告したのと同じ穴。
 *   **本検査が新しく作る穴ではないが、塞いでもいない**)。
 * - **`schemas/*.json` を1本も見ていない** —— **`$comment` は1本の文字列であり、
 *   「本文を1バイトも書き換えず追記する」作法で訂正を足す場所が無いからである。**
 *   **`schemas/manifest.schema.json` には今日も偽の将来形が2句残っている**
 *   (`V8-M13-T04` の報告に「直さなかった」として書いた)。
 * - **`docs/adr/` と `docs/plan/` を1本も見ていない** —— **記録は当時の事実を書いた
 *   ものであり、今日の事実に直す対象ではない。**
 * - **将来形そのものを禁止していない** —— **見るのは「その将来が来たあとも訂正が
 *   無いこと」だけである。**
 * - **上限の実数の併記は1つも見ていない**(それは `scripts/report-limit-prose-drift.test.ts`)。
 *
 * ## `docs/` を読む19本を切り出した(`X-G28` / `V9-M11-T02` / `D-V9-21`)
 *
 * **公開単位(`apps/smailtalk/`)の中の検査は `docs/` を読んではいけない。**
 * **移送先: `tools/docs/report-prose-correction-drift.test.ts`(19 test)。**
 *
 * | 出した test | 本数 |
 * |---|---:|
 * | 今日の事実4つ × `docs/manual.md` / `docs/mcp-quickstart.md` | **8** |
 * | `Q-G29` の (a)(b)(c) × 同2本 | **6** |
 * | 公開ツールの本数 × 同2本 | **2** |
 * | 偽になった将来形2組(`sweepFiles()` の走査根に `docs/` が2本入っている) | **2** |
 * | `歯2: 走査が実際にファイルを読んでいる…`(同上) | **1** |
 * | **計** | **19** |
 *
 * **こちらに残るのは39本で、`docs/` を1バイトも読まない。**
 * **`§4 偽になった将来形` の走査は丸ごと移送先へ出した** —— 走査根6本のうち4本は
 * 公開単位の中だが、「`docs/` の2本だけ」に割ると test が3本増える(58 → 61)。
 * **移送先が6本すべてを今も走査している**(覆う範囲は減っていない)。
 * **歯1 は `src/mcp/vocabulary.ts` しか読まないのでこちらに据え置いた。**
 *
 * **【残る穴】`TOOL_COUNT_FILES` の `README.md`(正本のルート直下)は今日もこちらが読む。**
 * **`X-G28` が名指ししたのは `docs/` なので、本軸では塞いでいない。**
 *
 * **【2026-08-18 追記(`X-G29` / `V9-M11-T03`)。上の2行は1バイトも消していない】**
 * **この穴は本タスクが塞いだ。** `TOOL_COUNT_FILES` の `README.md` の読み先を、
 * 正本のルート直下から `apps/smailtalk/README.md`(公開単位自身)へ向け直した。
 * **`CANONICAL_ROOT` / `isOutsidePublishUnit()` / `rootFor()` は削除した**
 * (下の `read()` の doc コメントに実測と根拠を書いた)。
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
// **`publishedToolCount()` の実装はここに無い**(`V9-M12-T02`)。
// 着手前は `tools/docs/report-prose-correction-drift.test.ts:171` にまったく同じ実装が在り、
// **同じものが2箇所に在った。** 1本へ寄せた。
import { publishedToolCount } from "./mcp-published-tool-count.ts";

/** **公開単位の根**(`apps/smailtalk/`)。`src/` `web/` `plugins/` `schemas/` はここに在る。 */
const REPO_ROOT = dirname(import.meta.dir);

/**
 * **正本のルート**(`V9-M1` / `V9-M2` で公開単位が `apps/smailtalk/` へ動いたあとも、
 * `docs/` と `README.md` は正本のルートに残っている)。
 *
 * **`import.meta.dir` = `<正本のルート>/apps/smailtalk/scripts` から3階層上げる。**
 * (`scripts/mcp-trial/` の下は1つ深いので4階層である —— 同じ数ではない。)
 * **`process.cwd()` は使っていない**(`V9-M3-T01` 裁定2)。
 *
 * **【2026-08-18 追記(`X-G29` / `V9-M11-T03`)。上の行は1バイトも消していない】**
 * **`CANONICAL_ROOT` はもう定義していない。** `V9-M11-T02` が `docs/` を読む19本を
 * `tools/docs/report-prose-correction-drift.test.ts` へ切り出した結果、**このファイルの
 * `PROSE_FILES` / `TWO_ROUTE_FILES` / `TOOL_COUNT_FILES` に `docs/` 始まりの path は
 * 1本も残っていない**(3配列を数え直した。`docs/` 始まりは0)。**`docs/` 分岐は今日は
 * 1度も真にならない、生きていない分岐だった。** 残る唯一の実在する分岐(`README.md`)は
 * 下のコメントで別の解に置き換えた。`import.meta.dir` から `..` を3つ重ねる式は
 * `X-G29`(公開単位の中のコードが自分より上の階層を1度も解決しない)のため削った。
 */

/**
 * **公開単位の外に在る読み先か。** `docs/` 始まりと、正本のルート直下の `README.md`。
 * (`README.md` は `docs/` 始まりではないが、`apps/smailtalk/README.md` は存在しない ——
 * `TOOL_COUNT_FILES` の `README.md` も正本のルートから解く必要がある。)
 *
 * **【2026-08-18 注記(`V9-M11-T02`)。上の行は1バイトも消していない】**
 * **逐語「`apps/smailtalk/README.md` は存在しない」は今日は偽である**:
 *
 * ```
 * $ git ls-files apps/smailtalk/README.md
 * apps/smailtalk/README.md
 * ```
 *
 * **`X-G28` / `V9-M11-T02` はこれを塞がない**(本軸が名指ししたのは `docs/` である)。
 * **`TOOL_COUNT_FILES` の `README.md` が正本のルートの側を指し続けていることは、
 * 上の理由づけが偽になった今も変わらない** —— **ただしその理由は「公開単位に無いから」
 * ではなく、「この検査が見たいのが正本のルートの `README.md` だから」に変わっている。**
 * **どちらを見るべきかを決め直す作業は、本軸では行っていない。**
 *
 * **【2026-08-18 追記(`X-G29` / `V9-M11-T03`)。上の行も1バイトも消していない。
 * ここで決め直した】** **`TOOL_COUNT_FILES` の `README.md` を、正本のルート直下ではなく
 * `apps/smailtalk/README.md`(公開単位自身)へ向け直した。** 根拠(実測):
 *
 * 1. **2つの `README.md` は別の文書である**(正本ルート: 24,791バイト。
 *    `apps/smailtalk/README.md`: 15,658バイト。章立ても中身も違う ——
 *    正本ルートは開発者向けのモノレポ案内、`apps/smailtalk/README.md` は配布物としての
 *    製品概要である)。
 * 2. **`apps/smailtalk/README.md` に `2\s*3\s*(本|個)` は1本も無い**
 *    (`LC_ALL=C /usr/bin/grep -noE '2\s*3\s*(本|個)' apps/smailtalk/README.md` → 0件)。
 *    **この検査は「古い本数を載せたなら」という条件付きである**(下の for ループの
 *    `if (!STALE_TOOL_COUNT.test(text)) { ...; return; }`)—— **条件が真にならない
 *    ファイルでは、他の8本(`src/mcp/vocabulary.ts` 等、今日も `23本` を持つ)と
 *    同じ形で素通りする。検査の意味(「古い本数があれば新しい本数も要る」)は変えていない**
 *    —— 今日たまたま前提が成り立たないだけであり、将来 `apps/smailtalk/README.md` に
 *    古い本数が紛れ込めば、この検査はそのときに赤くなる。
 * 3. **公開単位の中に正本ルートへ遡る式を残さない**(`X-G29` 限定1)ため、
 *    `isOutsidePublishUnit()` / `rootFor()` / `CANONICAL_ROOT` を丸ごと削り、
 *    `read()` は常に `REPO_ROOT`(= 公開単位の根)から解く形にした。
 */
function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf-8");
}

/**
 * **製品が配る散文**(`scripts/report-limit-prose-drift.test.ts` の `PROSE_FILES` と
 * 同じ考え方。**記録・ADR・実施記録は1本も入れない**)。
 *
 * **`docs/manual.md` / `docs/mcp-quickstart.md` はここに無い** —— `X-G28` により
 * `tools/docs/report-prose-correction-drift.test.ts` が持っている(上の doc コメント)。
 */
const PROSE_FILES: readonly string[] = [
  "src/mcp/vocabulary.ts",
  "plugins/smailtalk/skills/view-shape/SKILL.md",
  "plugins/smailtalk/skills/view-shape/reference/view-keys.md",
  "plugins/smailtalk/skills/diff-shape/SKILL.md",
  "plugins/smailtalk/skills/automation-shape/reference/cannot-do.md",
];

/**
 * **今日の事実**(`Q-G30` / `Q-G33`)。**語尾の揺れ(です体 / である体)を跨ぐため、
 * 語幹だけを持つ。**
 */
const TODAY_FACTS: readonly { readonly name: string; readonly literal: string }[] = [
  { name: "集計表が画面に描かれること(V8-M11)", literal: "集計表はブラウザに描かれ" },
  { name: "グラフが棒と折れ線の2種であること(V8-M12)", literal: "棒と折れ線の2種" },
  { name: "集計の母集団に可視性が掛かること(V8-M10)", literal: "見る人によって数が変わ" },
  { name: "MCP から集計表を1枚読めること(V8-M13-T02)", literal: "read_report" },
];

/**
 * **2本の道(`Q-G29`)を論じている散文。** `PROSE_FILES` の部分集合である。
 * **`docs/` の2本は移送先が持っている**(`X-G28`)。
 */
const TWO_ROUTE_FILES: readonly string[] = [
  "src/mcp/vocabulary.ts",
  "plugins/smailtalk/skills/view-shape/reference/view-keys.md",
  "plugins/smailtalk/skills/automation-shape/reference/cannot-do.md",
];

/** `Q-G29` の (a)(b)。**門Aの判定の逐語は `v8-m7.md` §5 の「両方残す。正は宣言の道。」** */
const TWO_ROUTE_CLAIMS: readonly { readonly name: string; readonly literal: string }[] = [
  { name: "(a) 2本の道が両方在ること", literal: "集計を書く道は2本" },
  { name: "(b) 正が宣言の道であること", literal: "正は宣言の道" },
];

/**
 * `Q-G29` の (c)。**門Aが閉じた「島の道を選ぶ条件」の全量である**
 * (`v8-m7.md` §5: 「**島の道を選ぶ条件を有限の3つに閉じた**」)。
 * **4つ目を足すには改めて門Aが要る** —— **足したらこの配列を伸ばすことになり、
 * 散文の目印の数と合わなくなって赤くなる。**
 */
const ISLAND_ROUTE_CONDITIONS: readonly string[] = [
  "他の画面から参照",
  "ワークフローの発火元",
  "見る人によらず同じ数",
];

/** 散文側の書き出し。ここから次の句点までを「条件を並べた1文」として切り出す。 */
const ISLAND_ROUTE_LEAD = "島の道を選ぶ条件は3つ";

/** 条件の目印。**散文に実際に書く記号であり、数えるのはこの出現回数である。** */
const CONDITION_MARKERS = /（(あ|い|う|え|お|か)）/g;

/** 4つ目の目印(**歯**。増えたら気づくため) */
const FOURTH_MARKER = "（え）";

function islandRouteSentence(text: string): string {
  const start = text.indexOf(ISLAND_ROUTE_LEAD);
  if (start < 0) {
    throw new Error(`「${ISLAND_ROUTE_LEAD}」で始まる文が無い`);
  }
  const end = text.indexOf("。", start);
  return end < 0 ? text.slice(start) : text.slice(start, end + 1);
}

// --- 1. 今日の事実4つ ---

for (const path of PROSE_FILES) {
  for (const fact of TODAY_FACTS) {
    test(`${path}: ${fact.name} が書いてある`, () => {
      expect(read(path), `この字面が無い: ${fact.literal}`).toContain(fact.literal);
    });
  }
}

// --- 2. `Q-G29` の (a)(b)(c) ---

for (const path of TWO_ROUTE_FILES) {
  for (const claim of TWO_ROUTE_CLAIMS) {
    test(`${path}: ${claim.name} が書いてある`, () => {
      expect(read(path), `この字面が無い: ${claim.literal}`).toContain(claim.literal);
    });
  }

  test(`${path}: 島の道を選ぶ条件が門Aの閉じた本数ちょうどである`, () => {
    const sentence = islandRouteSentence(read(path));
    const markers = sentence.match(CONDITION_MARKERS) ?? [];
    // **散文から数えた本数**と、**門Aが閉じた本数**を突き合わせる。**数字を1つも書かない。**
    expect(markers).toHaveLength(ISLAND_ROUTE_CONDITIONS.length);
    for (const condition of ISLAND_ROUTE_CONDITIONS) {
      expect(sentence, `条件が本文に無い: ${condition}`).toContain(condition);
    }
    // **4つ目の目印が無いこと**(門Aを通さずに条件が増えていない)。
    expect(sentence).not.toContain(FOURTH_MARKER);
  });
}

test("歯1: 条件の目印を1つ増やすと、本数の突き合わせが赤になる", () => {
  const [first] = TWO_ROUTE_FILES;
  expect(first, "2本の道を論じる散文が1本も無いと、歯1 は何も測らない").toBeDefined();
  // **加工するのは読み込んだ複製であって、実ファイルではない。**
  const tampered = `${islandRouteSentence(read(first ?? ""))}${FOURTH_MARKER}`;
  expect(tampered.match(CONDITION_MARKERS) ?? []).not.toHaveLength(ISLAND_ROUTE_CONDITIONS.length);
});

// --- 3. 公開ツールの本数 ---

// **`publishedToolCount()` はここに無い。**
// **移送先: `./mcp-published-tool-count.ts`**(`V9-M12-T02`。上の import に理由を書いた)。

/** 「23本」「23 個」のように、**古い本数**を書いた字面。 */
const STALE_TOOL_COUNT = /2\s*3\s*(本|個)/;

/**
 * **公開ツールの本数を書いている散文**(**製品が配るもの・運用時に人が読むものだけ**)。
 *
 * **`PROSE_FILES` より広い** —— **本数の主張は集計の主張とは別の場所にも在るからである**
 * (名乗りの説明・起動時の警告・READMEなど)。
 * **テストの名前・doc コメントの中の歴史的な記述は1本も入れていない** ——
 * **それらは「2026-08-14 までの事実」として意図して残されている**
 * (`src/mcp/descriptions.test.ts:189` / `src/server/entry-point-inventory.test.ts:307` 等が
 * そう自ら宣言している)。
 */
const TOOL_COUNT_FILES: readonly string[] = [
  "src/mcp/vocabulary.ts",
  "src/mcp/actor-guard.ts",
  "src/mcp/index.ts",
  "src/mcp/http-entry.ts",
  "plugins/smailtalk/skills/view-shape/SKILL.md",
  "plugins/smailtalk/skills/view-shape/reference/cannot-do.md",
  "plugins/smailtalk/skills/automation-shape/reference/cannot-do.md",
  "plugins/smailtalk/skills/diff-shape/reference/op-required-keys.md",
  // **`docs/manual.md` / `docs/mcp-quickstart.md` はここに無い**(`X-G28`。移送先が持つ)。
  // **`README.md` は残っている** —— `docs/` ではないので本軸の射程外である
  // (**この1本だけが、今日もこの検査を公開単位の外へ触れさせている**)。
  // **【2026-08-18 追記(`X-G29` / `V9-M11-T03`)。上の2行は1バイトも消していない】**
  // **もう公開単位の外へ触れさせていない。** `read()` が `apps/smailtalk/README.md` を
  // 読むようになった(上の `read()` の doc コメントに根拠)。
  "README.md",
];

for (const path of TOOL_COUNT_FILES) {
  test(`${path}: 古い本数を載せたなら、今日の本数も載っている`, async () => {
    const text = read(path);
    if (!STALE_TOOL_COUNT.test(text)) {
      // **古い本数を1つも書いていないファイルは、この検査の対象ではない。**
      expect(STALE_TOOL_COUNT.test(text)).toBe(false);
      return;
    }
    const today = await publishedToolCount();
    expect(
      text.includes(`${today}本`) || text.includes(`${today}個`),
      `今日の本数(${today})がどこにも書いていない`,
    ).toBe(true);
  });
}

// --- 4. 偽になった将来形 ---
//
// **この節はここに無い**(`X-G28` / `V9-M11-T02` / `D-V9-21`)。
// **移送先: `tools/docs/report-prose-correction-drift.test.ts`(3 test)。**
//
// `sweepFiles()` の走査根6本のうち2本(`docs/manual.md` / `docs/mcp-quickstart.md`)が
// 公開単位の外に在る。**「`docs/` の2本だけ」に割ると test が3本増える**(58 → 61)ので、
// **走査を丸ごと出した。** 移送先は6本すべてを今も走査しており、
// **公開単位の `src` / `web/src` / `web/test` / `plugins` の照合は1本も失われていない**
// (移送先が `<正本のルート>/apps/smailtalk/…` として下向きに読む)。
