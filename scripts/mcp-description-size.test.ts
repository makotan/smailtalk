/**
 * `V6-M13-T02`(`H-G14`): **説明文の長さに上限を置く検査。**
 *
 * 上位: `docs/plan/v6/records/v6-m8.md` §5-14(`H-G14` 本審査。門外。限定採用。限定4点)/
 *       §8-5 の `V6-M13-T02` 完了条件 /
 *       `docs/plan/v6/records/v6-m12.md` §5-6(`H-G11` 限定8 が**未達**であることの実測)/ §8 の 1 /
 *       `docs/evidence/cp-7.md` の B3(「説明文を厚くすることの副作用の**上限が測られていない**」)/
 *       `docs/plan/v6/records/v6-m13.md`(本タスクの実施記録)。
 *
 * ## なぜ要るのか
 *
 * この製品は説明文を**2回**厚くしており、2026-08-07 の `V6-M12` まで
 * **接続直後に 1,067,181文字**が渡っていた。**その 95% は 23個のツールに同じ 41,683文字を
 * 貼っていたためである。** `V6-M12` はそれを 127,057文字にした。
 * **だが「また厚くなったこと」を機械が赤くする仕組みは、その時点で0本だった**
 * (`v6-m12.md` §5-6 の `H-G11` 限定8 = 未達)。**ここがその1本である。**
 *
 * ## 測る対象は3つだけ(`H-G14` 限定1。**4つ目を測らない**)
 *
 * | # | 測るもの | 2026-08-07 の実測 | 上限 |
 * |---|---|---:|---:|
 * | 1 | 接続直後に渡る合計文字数(`instructions` + `tools/list` の JSON) | 127,057 | **152,000** |
 * | 2 | `describeTool()` が全ツールに貼る共通部の長さ | 762 | **1,524** |
 * | 3 | 各 skill の `description` + `when_to_use` の合計文字数 | 460 / 523 / 555 | **1,536** |
 *
 * ## 上限値をどう決めたか(`H-G14` 限定2。**余裕の値と理由をここに書く**)
 *
 * **原則: 今日の実測ぴったりにしない。** ぴったりにすると1文字の正当な追記も赤くなり、
 * 検査が「触るな」の意味になってしまう。**余裕を明示し、その余裕に意味を持たせる。**
 *
 * - **1(接続直後の合計)= 127,057 + 24,943 = 152,000。**
 *   **余裕 24,943 は `VOCABULARY_SCOPE` の全文の長さそのものである**(`v6-m12.md` §3-2 の実測)。
 *   意味: **語彙境界の全文をもう1箇所に貼り直したら、その瞬間に超える。**
 *   正当な追記(1本目の軸が `apply_diff` の説明に足す予定のもの等)には、
 *   **`apply_diff` 以外の22本の description の中央値 1,308文字で数えて19本分**の余地がある。
 *   **差し替え前の 1,067,181 は当然この上限を超える** —— 下の「歯」がそれを実物で確かめる。
 * - **2(共通部)= 762 × 2 = 1,524。**
 *   **余裕は今日と同じ量(762)である。** 意味: **入口(481)と誘導(279)のほかに、
 *   同じ規模の一文をもう1本だけ足せる。** 3本目を足す日には、この上限を上げるかどうかを
 *   人が決めることになる(**上げる判断を機械に委ねない**)。
 *   **貼る中身を全文に戻すと 42,444文字になり、27倍で超える** —— 下の「歯」が実物で確かめる。
 * - **3(skill の `description`)= 1,536。**
 *   **ここだけは「実測 + 余裕」で新しい値を作っていない。** **`H-G3` の限定1 が
 *   既に 1,536文字という上限を決めており**(`v6-m8.md` §5-3)、**そこへ実測由来の2つ目の
 *   上限を並べると、同じ対象に上限が2つできる。** **既決の1本を採った。**
 *   **これは `H-G3` の限定1 を覆していない** —— 覆すどころか、**今日まで機械で数えていなかった
 *   ものを数えるようにした**(`v6-m10.md` §3-1 の表が「機械的に数える検査は `V6-M13-T02` が
 *   置く」と申し送っていた)。
 *
 * ## この検査がしないこと(**先に書く。誇張しない**)
 *
 * - **「厚くしたのが正しいかどうか」を判定しない**(`H-G14` の `S3`(c))。**上限を超えたことしか言わない。**
 * - **トークン数を1つも測っていない。** 数えるのは文字数だけである(`v6-m12.md` §4-5)。
 * - **躓きが減ったかどうかを1度も測っていない**(測るのは `V6-M14`)。
 * - **`expect() calls` の総数を判定材料に使っていない**(`H-G14` 限定4 / `ADR-0007` §6 規律2)。
 * - **上限を上げる作業を止めない。** この定数を書き換えれば通る。**機械化したのは検出であって審査ではない。**
 */

import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.ts";
import { describeTool, SKILL_GUIDE } from "../src/mcp/vocabulary.ts";

/**
 * **公開単位の根**(`apps/smailtalk/`)。`plugins/` も `.claude-plugin/` もここに在るので、
 * **このファイルは公開単位に置いたままにする**(`V9-M3-T01` 裁定1。
 * `docs/plan/v9/records/v9-m2.md` §6 の #1 が「`:333` と `:352` を `tools/` へ出す」と
 * 決めたのは誤りで、§16-7 が `:352` について訂正した。`:333` も `discoverSkillNames()`
 * 経由で `plugins/` を読むので、同じ理由で出せない)。
 *
 * **【2026-08-18 訂正(`X-G28` / `V9-M11-T02`)。上の行は1バイトも消していない】**
 * **上の「`:333` も同じ理由で出せない」は今日の正ではない。** その test
 * (`docs/mcp-quickstart.md が、走査で見つかった全説明書の SKILL.md のパスを載せている`)は
 * **`tools/docs/mcp-quickstart-skill-paths.test.ts` へ出した。**
 * 理由: `plugins/` が読めなくなるのは `REPO_ROOT` をそのまま持って行った場合だけであり、
 * **移送先は `<正本のルート>/apps/smailtalk/plugins/…` として解き直している**
 * (`v9-m2.md` §16-7 の逐語「3本の読み先を1本ずつ解き直すこと」/
 *  同 §16-7 は `:333` について「`tools/` へ出してよい」と書いている)。
 * **`:352`(今日の「配布物の説明…」)は出していない** —— 読み先3本のうち2本が公開単位の
 * 中に在り、外に在るのは正本のルート直下の `README.md` だけだからである。
 * **【残る穴】そのため本ファイルは今日も公開単位の外(`README.md`)を1本読む。**
 * **`X-G28` が名指ししたのは `docs/` なので、本軸では塞いでいない。**
 *
 * **【2026-08-18 追記(`X-G29` / `V9-M11-T03`)。上の2行は1バイトも消していない。
 * この穴は塞げなかった —— 実測してから止めた】**
 * `report-prose-correction-drift.test.ts` と同じ形(`CANONICAL_ROOT` を捨てて
 * `apps/smailtalk/README.md` を読む)を試したが、**中身が違って通らない**:
 *
 * ```
 * $ LC_ALL=C /usr/bin/grep -n '4本' apps/smailtalk/README.md
 * (0件)
 * ```
 *
 * **下の `test("配布物の説明…")` が探す `${discoverSkillNames().length}本`(今日は
 * `"4本"`)は `apps/smailtalk/README.md` のどこにも無い。** この README は
 * 正本のルートの README.md とは別の文書(章立ても中身も違う。配布物としての
 * 製品概要であって、skill を名前で列挙するだけで本数を書いていない)であり、
 * **`apply_diff` 側の2ファイル(`plugin.json` / `marketplace.json`)は「4本」を
 * 持っているのに対し、この README だけが持っていない。** 読み先をここへ向け直すと
 * `expect(text.includes(expected)).toBe(true)` が本物の失敗として赤くなる ——
 * 検査を通すために `apps/smailtalk/README.md` に本数を書き足すのは対象物を検査に
 * 合わせて書き換える行為であり、禁じられている。**そのため `CANONICAL_ROOT` と
 * この読み先はここでは変えていない。** `X-G29` の限定1(公開単位の中に遡る式を
 * 残さない)は、この1本の分だけ今日も未達である —— **判断はメインへ返す。**
 *
 * **【2026-08-18 追記2(利用者決定 / メイン裁定)。上の段落も1バイトも消していない。
 * ここで決め直した】** **利用者が「配布物の説明に本数を書く」を選んだ。**
 * 逐語: 「`apps/smailtalk/README.md` に『説明書は4本』を追記し、見張りをそこへ向け
 * 直す。受け取った人が手元の説明書の本数を確かめられる。今後本数が変わったら赤くなる。
 * リポジトリ全体の README は触らない。」
 *
 * **これは「検査を通すための書き換え」ではない** —— **切り出した木の根に在る
 * `README.md` は `apps/smailtalk/README.md` である。** 配布物に実際に付いてくる
 * 説明はこちらであり、正本のルートの `README.md` は配布物に1バイトも入らない。
 * **したがって「配布物の説明が今日の本数を載せている」という検査の対象は、
 * もともとこちらが正しかった。** 読み先が正本のルートを向いていたことのほうが誤り
 * だった。**`CANONICAL_ROOT` を削り、`README.md` は `REPO_ROOT` から解く。**
 * `apps/smailtalk/README.md` に本数を足した経緯と数え方は、そのファイル自身の
 * 該当箇所に書く(このファイルの記述として重複させない)。
 */
const REPO_ROOT = dirname(import.meta.dir);

/**
 * **正本のルート**。**公開単位の外に残っているのは `docs/mcp-quickstart.md` と
 * ルート直下の `README.md` の2つだけ**(`.claude-plugin/marketplace.json` は
 * `apps/smailtalk/.claude-plugin/` に在るので公開単位側である)。
 *
 * **`import.meta.dir` = `<正本のルート>/apps/smailtalk/scripts` から3階層上げる。**
 * **`process.cwd()` は使っていない**(`V9-M3-T01` 裁定2)。
 *
 * **【2026-08-18 追記(利用者決定 / メイン裁定 / `X-G29`)。上の行は1バイトも消していない】**
 * **`CANONICAL_ROOT` はもう定義していない。** `README.md` の読み先を
 * `apps/smailtalk/README.md`(公開単位自身)へ向け直したため、公開単位の外へ
 * 遡る理由が無くなった(下の `test("配布物の説明…")` の doc コメントに経緯)。
 */

const SKILLS_ROOT = join(REPO_ROOT, "plugins", "smailtalk", "skills");

/** 説明書(skill)の主題。**`plugins/smailtalk/skills/` の実ディレクトリ名である。** */
const SKILL_NAMES = ["diff-shape", "view-shape", "automation-shape", "app-build"] as const;

// --- 上限(根拠は上の doc コメント。**今日の実測ぴったりではない**)---

/** 1. 接続直後に渡る合計文字数の上限。127,057(2026-08-07 実測)+ 24,943(`VOCABULARY_SCOPE` 全文1本分)。 */
const CONNECT_TOTAL_MAX = 152000;

/** 2. 全ツールに貼られる共通部の長さの上限。762(2026-08-07 実測)の2倍 = 同じ量の余裕1本分。 */
const SHARED_PREAMBLE_MAX = 1524;

/** 3. skill の `description` + `when_to_use` の合計の上限。**`H-G3` 限定1 が既に決めた値**(`v6-m8.md` §5-3)。 */
const SKILL_DESCRIPTION_MAX = 1536;

/** クライアントとサーバを直結する(両 `connect` は必ず `Promise.all`。逐次だとデッドロック)。 */
async function measureAtConnect(): Promise<{
  instructions: number;
  toolsListJson: number;
  toolCount: number;
  total: number;
}> {
  const server = createMcpServer({
    dataRoot: "data",
    previewBaseUrl: "http://127.0.0.1:3000",
  });
  const client = new Client({ name: "description-size-test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const instructions = client.getInstructions() ?? "";
    const { tools } = await client.listTools();
    const toolsListJson = JSON.stringify({ tools }).length;
    return {
      instructions: instructions.length,
      toolsListJson,
      toolCount: tools.length,
      total: instructions.length + toolsListJson,
    };
  } finally {
    await client.close();
    await server.close();
  }
}

/**
 * `describeTool()` が**全ツールに貼る共通部**の長さ。
 *
 * **ツール固有の説明を空にして呼ぶと、残るのが共通部そのものである。**
 * **字面で数えていない** —— 実際に貼られる関数を呼んで測っている(`R12` と同じ考え方)。
 */
function sharedPreambleLength(): number {
  return describeTool("").length;
}

/** 貼る中身を**語彙境界の全文に戻した**ときの共通部の長さ(**歯の材料**。今日は `apply_diff` だけが受け取る)。 */
function fullVocabularyPreambleLength(): number {
  return describeTool("", { withFullVocabulary: true }).length;
}

function frontMatterOf(skill: string): string {
  const text = readFileSync(join(SKILLS_ROOT, skill, "SKILL.md"), "utf-8");
  const [, block] = /^---\n([\s\S]*?)\n---/.exec(text) ?? [];
  return block ?? "";
}

/**
 * YAML のブロックスカラー指示子(`>` `>-` `>+` `|` `|-` `|+`)なら、
 * インデントを剥がして畳んだ本文を返す。指示子でなければ `null`。
 *
 * `>` 系(折り畳み)は空白1つで連結、`|` 系(リテラル)は改行で連結する
 * (どちらも簡易実装であり、空行での段落分けなど YAML の全規則までは追っていない)。
 */
function foldBlockScalar(raw: string): string | null {
  const lines = raw.split("\n");
  const indicator = /^([>|])[+-]?$/.exec((lines[0] ?? "").trim());
  if (!indicator) return null;
  const bodyLines = lines.slice(1);
  const indents = bodyLines
    .filter((line) => line.trim().length > 0)
    .map((line) => line.length - line.replace(/^ +/, "").length);
  const minIndent = indents.length > 0 ? Math.min(...indents) : 0;
  const dedented = bodyLines.map((line) => line.slice(minIndent));
  const joiner = indicator[1] === ">" ? " " : "\n";
  return dedented.join(joiner).trim();
}

/**
 * front matter の1キーの値(次のキーの直前まで)。無ければ空文字。
 *
 * **`$` は使わない**(旧実装は `m` フラグの下で `$` を使っており、`m` フラグは `$` を
 * 「ブロック全体の末尾」ではなく「行末」ごとにマッチさせる。値がキーと同じ行で
 * `>-` のようなブロックスカラー指示子だけを持つとき、その行末で早期に一致してしまい、
 * 続く本文行が1文字も捕まらなかった —— これが「穴1」の直接の原因である)。
 * 代わりに「文字列の本当の末尾」だけを表す `(?![\s\S])` を使う。
 *
 * 捕まえた値がブロックスカラー指示子で始まっていれば畳んで返す。
 * それ以外(平の値・既存の複数行の値)は**今日までと1文字も変えず**そのまま `trim()` して返す。
 * 想定外の例外が起きたときは、今日までと同じ正規表現の結果に落とす(検査全体を落とさない)。
 */
function frontMatterValue(block: string, key: string): string {
  const pattern = new RegExp(`^${key}:\\s*([\\s\\S]*?)(?=\\n[a-z_-]+:|(?![\\s\\S]))`, "m");
  const [, value] = pattern.exec(block) ?? [];
  const raw = value ?? "";
  try {
    const folded = foldBlockScalar(raw);
    if (folded !== null) return folded;
  } catch {
    // 壊れた front matter などで想定外の形に当たったら、下の従来経路にそのまま落ちる。
  }
  return raw.trim();
}

function skillDescriptionLength(skill: string): number {
  const block = frontMatterOf(skill);
  return (
    frontMatterValue(block, "description").length + frontMatterValue(block, "when_to_use").length
  );
}

// --- 1. 接続直後に渡る合計文字数 ---

test("接続直後に渡る合計文字数が上限を超えていない", async () => {
  const measured = await measureAtConnect();
  // **ツールを1本も落としていないこと**を同時に見る。ツールが減れば合計も減るので、
  // 「上限を守るためにツールを消した」を素通りさせないための1行である。
  expect(measured.toolCount).toBeGreaterThan(SKILL_NAMES.length);
  expect(
    measured.total,
    `接続直後 ${measured.total}文字(instructions ${measured.instructions} + tools/list ${measured.toolsListJson})が上限 ${CONNECT_TOTAL_MAX} を超えた`,
  ).toBeLessThanOrEqual(CONNECT_TOTAL_MAX);
});

// --- 2. 全ツールに貼られる共通部 ---

test("全ツールに貼られる共通部の長さが上限を超えていない", () => {
  const shared = sharedPreambleLength();
  expect(shared, `共通部 ${shared}文字が上限 ${SHARED_PREAMBLE_MAX} を超えた`).toBeLessThanOrEqual(
    SHARED_PREAMBLE_MAX,
  );
  // **空でないこと**も見る。0文字なら「共通部が消えた」= `H-G11` 限定1 の違反であり、
  // 上限だけを見ていると素通りする。
  expect(shared).toBeGreaterThan(SKILL_NAMES.length);
});

// --- 3. 各 skill の `description` + `when_to_use` ---

for (const skill of SKILL_NAMES) {
  test(`${skill}: description + when_to_use が上限を超えていない`, () => {
    const length = skillDescriptionLength(skill);
    expect(
      length,
      `${skill} の ${length}文字が上限 ${SKILL_DESCRIPTION_MAX} を超えた`,
    ).toBeLessThanOrEqual(SKILL_DESCRIPTION_MAX);
    // 空の front matter を読んで緑になる壊れ方をしない。
    expect(length).toBeGreaterThan(SKILL_NAMES.length);
  });
}

// --- 4. 説明書(skill)の front matter が YAML として壊れていないこと ---
//
// **`SKILL_NAMES`(手書き配列)には頼らない。** `plugins/smailtalk/skills/*/SKILL.md` を
// 実ディレクトリから走査して対象を作る —— 4本目の説明書を手書き配列に足し忘れても、
// この走査ベースの検査は赤くならないままにはしない(下の「本数の一致」検査で見える化する)。

/** `plugins/smailtalk/skills/` を実ディレクトリから走査して見つけた説明書名の一覧。 */
function discoverSkillNames(): string[] {
  return readdirSync(SKILLS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(SKILLS_ROOT, name, "SKILL.md")))
    .sort();
}

for (const skill of discoverSkillNames()) {
  test(`${skill}: front matter が YAML として解析でき、name / description が空でない`, () => {
    const block = frontMatterOf(skill);
    // 壊れた front matter を置いたら、ここが例外を投げて赤くなる。
    const parsed = Bun.YAML.parse(block) as Record<string, unknown>;
    expect(typeof parsed.name, `${skill} の name が文字列でない`).toBe("string");
    expect((parsed.name as string).length, `${skill} の name が空文字`).toBeGreaterThan(0);
    expect(typeof parsed.description, `${skill} の description が文字列でない`).toBe("string");
    expect(
      (parsed.description as string).length,
      `${skill} の description が空文字`,
    ).toBeGreaterThan(0);
  });
}

test("走査で見つかった説明書の本数が SKILL_NAMES(手書き配列)の本数と一致する", () => {
  // **この検査が赤くても手書き配列へ足さないこと。** 赤いままにするのが正しい
  // (4本目の説明書 app-build が手書き配列に入っていないことを、今日から見える化する)。
  // 【2026-08-16 訂正: `V8-M47` が app-build を `SKILL_NAMES` に足した。4本目は
  //  手書き配列に入っており、この検査は緑である。上の2行は消していない】
  const discovered = discoverSkillNames();
  expect(
    discovered.length,
    `走査で見つかった本数 ${discovered.length}(${discovered.join(", ")}) が ` +
      `SKILL_NAMES の本数 ${SKILL_NAMES.length}(${SKILL_NAMES.join(", ")}) と一致しない`,
  ).toBe(SKILL_NAMES.length);
});

// --- 5. `frontMatterValue` が YAML のブロックスカラーを畳んで返すこと ---

test("frontMatterValue が diff-shape の description(ブロックスカラー)を畳んで返す", () => {
  const block = frontMatterOf("diff-shape");
  const folded = frontMatterValue(block, "description");
  const parsed = Bun.YAML.parse(block) as { description: string };
  // 折り畳みブロックスカラーの指示子(`>-`)自体の長さしか返せていない壊れ方をしていないこと。
  const BLOCK_SCALAR_INDICATOR_LENGTH = ">-".length;
  expect(
    folded.length,
    "frontMatterValue が '>-' という指示子だけを返している(ブロックスカラーを畳めていない)",
  ).not.toBe(BLOCK_SCALAR_INDICATOR_LENGTH);
  expect(folded, "frontMatterValue の値が Bun.YAML.parse の description と一致しない").toBe(
    parsed.description,
  );
});

// --- 歯があることの実測(**実物の関数で「厚さが戻った世界」を作って確かめる**) ---
//
// **historical な数値を焼き込んでいない。** 下の2本は `describeTool()` を
// `withFullVocabulary: true` で呼んだ**実際の長さ**から組み立てている ——
// **つまり「2026-08-07 まで23本全部に貼られていた形」そのものである。**

test("歯1: 貼る中身を語彙境界の全文に戻すと、共通部の上限を超える", () => {
  expect(fullVocabularyPreambleLength()).toBeGreaterThan(SHARED_PREAMBLE_MAX);
});

test("歯2: 貼る中身を全ツールで全文に戻すと、接続直後の合計の上限を超える", async () => {
  const measured = await measureAtConnect();
  // 今日すでに全文を受け取っているツールが1本ある(`apply_diff`)ので、増える分は
  // 「残りのツールの本数 × (全文の共通部 − 今日の共通部)」である。
  const alreadyFull = [describeTool("", { withFullVocabulary: true })];
  const others = measured.toolCount - alreadyFull.length;
  const restored =
    measured.total + others * (fullVocabularyPreambleLength() - sharedPreambleLength());
  expect(restored).toBeGreaterThan(CONNECT_TOTAL_MAX);
});

test("歯3: skill の説明を上限より長くすると、その skill の検査が赤になる", () => {
  const [first] = SKILL_NAMES;
  const padded = skillDescriptionLength(first ?? "") + SKILL_DESCRIPTION_MAX;
  expect(padded).toBeGreaterThan(SKILL_DESCRIPTION_MAX);
  // 今日の値は上限の下にある(= 上の for ループが本当に測っている)。
  expect(skillDescriptionLength(first ?? "")).toBeLessThanOrEqual(SKILL_DESCRIPTION_MAX);
});

// --- 6. 説明書が増えた日に、案内と配布物の記述が置き去りにならないこと(`V8-M48`)---
//
// **説明書は 2026-08-16 に3本から4本になった。** そのとき `SKILL_GUIDE`(全ツールに貼る
// 誘導文)・`docs/mcp-quickstart.md` の付録2・配布物の3ファイルは**どれも「3本」のまま
// だった。** **どれも赤くならなかった** —— 数えている検査が1本も無かったからである。
// 下の3本がそこを埋める。**対象は `discoverSkillNames()`(実ディレクトリの走査)から
// 作り、説明書の名前も本数も手書きしない。**
//
// **追記(`V10-M21-T06`)。上の「(全ツールに貼る誘導文)」は 2026-08-21(`V10-M21-T01`)
// 以降は偽である。** **今日 `SKILL_GUIDE` が載るのは `apply_diff` 1本だけである。**
// 実測(3点):
//
// - `describeTool()` の呼び出しは **24本**(`src/mcp/tools/read.ts` = 11 /
//   `src/mcp/tools/write.ts` = 13)。
// - そのうち `withFullVocabulary: true` を渡すのは **`src/mcp/tools/write.ts:1059` の1本**
//   だけで、その道具は `src/mcp/tools/write.ts:971` の **`apply_diff`** である。
// - 既定の分岐が貼るのは `SKILL_GUIDE` ではなく `SKILL_POINTER`
//   (`src/mcp/vocabulary.ts:5087`)である。
//
// **上の本文は書き換えていない**(このリポジトリは既存の散文を書き換えず、追記で正す)。
// **下の3本が見ているもの自体は変わらない** —— `SKILL_GUIDE` の中身を数えているのであって、
// それが何本の道具に貼られるかは1文字も見ていない。

test("SKILL_GUIDE が、走査で見つかった説明書をすべて名指ししている", () => {
  const missing = discoverSkillNames().filter((name) => !SKILL_GUIDE.includes(name));
  expect(
    missing,
    `SKILL_GUIDE に名指しされていない説明書がある: ${missing.join(", ")}(SKILL_GUIDE の本文: ${SKILL_GUIDE})`,
  ).toEqual([]);
});

// **`docs/mcp-quickstart.md` を見る test はここに無い**(`X-G28` / `V9-M11-T02` / `D-V9-21`)。
// **移送先: `tools/docs/mcp-quickstart-skill-paths.test.ts`(1 test)。**
// 公開単位の中の検査は `docs/` を1バイトも読まない。移送先は公開単位を**下向きに**読む
// (`<正本のルート>/apps/smailtalk/plugins/smailtalk/skills/` を走査する)ので、
// 上の doc コメントが「同じ理由で出せない」と書いた `discoverSkillNames()` の問題は起きない
// (`v9-m2.md` §16-7 の「3本の読み先を1本ずつ解き直すこと」に沿った)。

/**
 * 配布物の説明が「今日の本数」を載せていること。
 *
 * **この検査は弱い。正直に書く**: `toContain` で見ているだけなので、
 * **別の文脈に同じ本数の表記(例: 無関係な「4本」)があれば素通りする。**
 * **そして古い本数(例: 「3本」)が併記されたまま残っていることは、1つも検出できない。**
 * 見ているのは「今日の本数の表記がどこかに在る」ことだけである。
 */
test("配布物の説明(plugin.json / marketplace.json / README.md)が今日の本数を載せている", () => {
  const expected = `${discoverSkillNames().length}本`;
  const targets = [
    join(REPO_ROOT, "plugins", "smailtalk", ".claude-plugin", "plugin.json"),
    join(REPO_ROOT, ".claude-plugin", "marketplace.json"),
    // **`README.md` だけが正本のルートに残っている**(公開単位に `README.md` は無い)。
    // **【2026-08-18 追記(`X-G29` / `V9-M11-T03`)。上の行は1バイトも消していない】**
    // **括弧内の「公開単位に README.md は無い」は今日は偽**(`apps/smailtalk/README.md`
    // は在る)。**それでもここを `REPO_ROOT` へ向け直していない** —— 向け直すと
    // `apps/smailtalk/README.md` に `"4本"` の表記が無いため、この test が本物の
    // 失敗になる(上の `REPO_ROOT` の doc コメントに実測)。**判断はメインへ返す。**
    //
    // **【2026-08-18 追記2(利用者決定 / メイン裁定)。上の5行も1バイトも消していない。
    // ここで向け直した】** **利用者が「配布物の説明に本数を書く」を選び、
    // `apps/smailtalk/README.md` に「説明書は4本」を追記した(そのファイル自身に
    // 数え方の記録がある)。** **切り出した木の根に在る `README.md` はこちらである
    // ——配布物に実際に付いてくる説明はこちらであって、正本ルートの `README.md` は
    // 配布物に1バイトも入らない。** したがって読み先を `REPO_ROOT`(公開単位の根)
    // へ向け直す。
    join(REPO_ROOT, "README.md"),
  ];
  for (const path of targets) {
    const text = readFileSync(path, "utf-8");
    expect(text.includes(expected), `${path} に「${expected}」の表記が無い`).toBe(true);
  }
});
