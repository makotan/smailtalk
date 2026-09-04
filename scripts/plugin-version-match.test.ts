/**
 * 配布物(plugin / marketplace)の形と、版の一致を固定する検査。
 *
 * V6-M11-T04(`H-G10` の限定2「marketplace の版と一致を検査1本で固定する」)が要求する検査である。
 * 同じ1本の中で、V6-M11-T01(`H-G6`)と V6-M11-T02(`H-G7`)の限定も機械的に固定する。
 * **検査は1本だけである。2本目を作らない。**
 *
 * 版をここで比べる理由:
 *   Claude Code は plugin の版を「plugin.json の version → marketplace エントリの version →
 *   git の commit SHA」の順に解決し、両方に書いてあれば plugin.json が勝つ
 *   (`code.claude.com/docs/en/plugins-reference.md` の Version management。2026-08-07 取得)。
 *   つまり2箇所に版が書けてしまい、片方だけを上げると marketplace の一覧に出る版と
 *   実際に配られる版が食い違う。**この検査はその食い違いだけを止める。**
 *
 * この検査がしないこと(誇張しない):
 *   - 版が合わないときに実行を止めない(`H-G10` の限定4)。赤くなるのはこの検査だけである。
 *   - 製品の版(Runner のビルド単位の版。`PRAGMA user_version`)と結び付けない(限定3)。1バイトも読まない。
 *   - skill 本文の中身が語彙の正と合っているかは見ない(それは `V6-M13-T01` が置く別の検査である)。
 */
/**
 * **【`V9-M4` の追記。上の `:1`-`:19` は1バイトも書き換えていない】**
 *
 * **`:17` の逐語「製品の版(Runner のビルド単位の版。`PRAGMA user_version`)と結び付けない(限定3)。
 * 1バイトも読まない。」は、今日は**後半だけが**正でなくなった。**
 * **前半(製品の版と結び付けない)はもう正ではない。** **後半(`PRAGMA user_version` を1バイトも読まない)は今日も正である。**
 * ここで言う「後半だけが正でなくなった」の指す先を取り違えないよう、下の判定で名指しする。
 *
 * **`V9-M0-T03` が下した判定**(`X-G12`。門A・**限定採用**):
 *   - **破る2点** = **`H-G10` の限定1(版は `plugin.json` の `version` **1本だけ**)**と、
 *     **限定3 の**後半**(製品の版と結び付けない)**。
 *     この検査は今日、正本のルートの `release.json`(**リポジトリを跨いだ横串の版**)を読み、
 *     配布物の版をそれに結び付ける。**版の正は2箇所に書かれることになる。**
 *   - **1バイトも破らない3点** = **限定3 の**前半**(`PRAGMA user_version` を1バイトも読まない。SQLite を1度も開かない)**、
 *     **限定4(版が合わないときに実行を止めない。赤くなるのはこの検査だけである)**、
 *     **限定2(marketplace エントリとの一致を**検査1本**で固定する。比べる対象が2つから3つに増えるだけで、検査は1本のままである)**。
 *
 * **引き直しの ADR は `docs/adr/0352-cross-repo-version-match.md` である。**
 * `H-G10` は門外(`Δ7`)の単位で個別 ADR を持たないため、`ADR-0352` の front matter の `supersedes` は空である。
 * **`ADR-0007` の `H-G10` 台帳行と `docs/plan/v6/records/v6-m8.md:722` の審査記録は古いまま残る**(限定7)。
 *
 * **【公開単位だけを切り出した木では、下の5本が落ちる。正直に書く】**
 * `apps/smailtalk/` だけをクローン先に切り出すと、**正本のルートが存在せず `release.json` が無い。**
 * そのとき `resolveRepoRoot()` がその場で落ちるので、
 * **`describe("横串の版(V9-M4 / X-G12)")` の5本すべてが落ちる。**
 * これは `ADR-0352` の限界5 が数えた「公開物で実際に落ちる5件」に**足されて**、下限 10件になる、というその5本である。
 * **落ちるのはこの検査だけであり、製品の起動は1バイトも止まらない。**
 */
/**
 * **【`V9-M11-T03` の追記(`X-G27` / `ADR-0355`)。上の `:1`-`:47` は1バイトも書き換えていない】**
 *
 * **直前の `:41`-`:47` のブロックは、今日はもう正ではない。** 逐語「`apps/smailtalk/` だけをクローン先に
 * 切り出すと、**正本のルートが存在せず `release.json` が無い。**そのとき `resolveRepoRoot()` が
 * その場で落ちる」——**`resolveRepoRoot()` は今日この検査に存在しない。**
 * **読み先が「正本のルート」から「自分の app の直下(`apps/smailtalk/release.json`)」に変わったので、
 * 切り出した木でも5本すべてが成立する。** 上のブロックは、**移す前の実物の記録**として残してある。
 *
 * **`ADR-0355` が決めたこと**(`D-V9-22`「版の宣言を app ごとに持つ」):
 *   - **D1**: 版の宣言は各 app のディレクトリ直下(`apps/<name>/release.json`)に置く。
 *     キーは `version` / `meaning` / `distributes` の3つで、**`units` の配列は持たない。**
 *   - **D2**: **正本のルートの `release.json` は消す。** 版の正を2箇所にしない。
 *
 * **`ADR-0352` D1 の5点のうち、この追記で何が変わったか**(`ADR-0355` D3。**1点も黙って落とさない**):
 *   - **1**(`release.json` が実在し JSON として読める)= **引き直した。** 読み先が自 app の直下になり、
 *     **3段登り(旧 `:66`)と、登れなかったときの `throw`(旧 `:67`-`:71`)は消えた。**
 *   - **2**(`meaning` が空でない文字列)= **1バイトも引き直していない。**
 *   - **3**(`units` の `path` の集合が `apps/` の実ディレクトリの集合と完全一致する)= **消えた。**
 *     **`ADR-0352` 自身がこれを「本 ADR で唯一の見落とし封じである」と書いていた。**
 *     **見えなくなる食い違いを名指しする: `apps/` に3つ目のディレクトリが増えたとき、
 *     そこに版の宣言(`release.json`)が1本も無くても、機械は1つも赤くならない。**
 *     **代わりの見張りをこの検査は1本も置いていない**(置くと `apps/` を読むために自分より上へ登ることになり、
 *     `X-G29` を正面から破る)。**足すか落とすかは `X-G34`(`V9-M12-T05`)が決める。**
 *   - **4**(3つの `version` の一致)= **引き直した。** 比べる相手が「ルートの `release.json` の `version`」から
 *     「自 app の `release.json` の `version`」に変わった。**比べる版の本数は3のままである。**
 *   - **5**(`distributes === null` の単位に配布物が1本も無い)= **条文は引き直していないが、
 *     見る相手が自分1つに減った。** **今日 `distributes === null` の唯一の対象である
 *     もう1つの受け皿(`apps/` の下に在る、配布物を持たない側の器)を、この検査はもう1バイトも見ない。**
 *     **見るには2本目の読む側が要り、それは `ADR-0351` 限定4 を破る。**
 *     **したがって下の検査は「その受け皿に配布物が無い」を今日1つも保証しない。**
 *     (**受け皿を実体の名前で綴らないのは `X-G33` の完了条件(3) のためである** ——
 *     公開単位の中にその綴りが1件でも残ると、単独で成立していることを機械で数える式が
 *     消したはずの名前を拾う。**保証しないという申告そのものは1文字も落としていない。**)
 *
 * **検査は1本のままである(`ADR-0352` D2 / `ADR-0355` 限定6)。2本目を作っていない。**
 * **`PRAGMA user_version` を1バイトも読まない**(限定3)。**版が合わないときに実行を止めない**(限定5)。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/** 公開単位(`apps/smailtalk/`)のルート。**正本のルートではない。** */
const PRODUCT_ROOT = resolve(import.meta.dir, "..");

/**
 * この app の版の宣言。**`ADR-0355` D1 により、置き場は自分の app のディレクトリ直下である。**
 *
 * **自分より上を1段も解決しない**(`X-G29`)。`import.meta.dir`(`apps/smailtalk/scripts`)から
 * `..` を1つだけ登り、公開単位の根(`apps/smailtalk`)に着く。**そこで止まる。**
 * **正本のルートを同定する必要が無くなったので、`resolveRepoRoot()` と、
 * 見つからなかったときの `throw` は消した**(`ADR-0355` D3 の 1)。
 * **これにより、公開単位だけを切り出した木でも、この下の検査は1本も落ちない。**
 */
const releasePath = join(PRODUCT_ROOT, "release.json");

const marketplaceDir = join(PRODUCT_ROOT, ".claude-plugin");
const marketplacePath = join(marketplaceDir, "marketplace.json");
const pluginDir = join(PRODUCT_ROOT, "plugins", "smailtalk");
const pluginManifestPath = join(pluginDir, ".claude-plugin", "plugin.json");

type Json = Record<string, unknown>;

async function readJson(path: string): Promise<Json> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as Json;
}

/** marketplace の plugins 配列の1件目を取り出す。無ければその場で落とす(検査が黙って通らないようにする)。 */
function firstPluginEntry(marketplace: Json): Json {
  const entries = marketplace.plugins as Json[] | undefined;
  const entry = entries?.[0];
  if (!entry) throw new Error("marketplace.json の plugins 配列が空である");
  return entry;
}

/** plugin.json に書いてよいキー(`H-G6` の限定1)。この4つ以外を書かない。 */
const ALLOWED_PLUGIN_MANIFEST_KEYS = ["author", "description", "name", "version"];

/** plugin.json に1つも書いてはならないキー(`H-G6` の限定2・3、`H-G8` の却下)。 */
const FORBIDDEN_PLUGIN_MANIFEST_KEYS = [
  "mcpServers",
  "hooks",
  "agents",
  "commands",
  "workflows",
  "lspServers",
  "outputStyles",
  "experimental",
  "skills",
];

describe("配布物 plugin.json(V6-M11-T01 / H-G6)", () => {
  test("`plugins/smailtalk/.claude-plugin/plugin.json` が実在する", () => {
    expect(existsSync(pluginManifestPath)).toBe(true);
  });

  test("キーは name / description / author / version の4つだけである(限定1)", async () => {
    const manifest = await readJson(pluginManifestPath);
    expect(Object.keys(manifest).sort()).toEqual(ALLOWED_PLUGIN_MANIFEST_KEYS);
  });

  test("mcpServers を書いていない(H-G8 の却下。同梱しない)", async () => {
    const manifest = await readJson(pluginManifestPath);
    expect(Object.hasOwn(manifest, "mcpServers")).toBe(false);
  });

  test("hooks / agents / commands 等の同梱キーを1つも書いていない(限定3)", async () => {
    const manifest = await readJson(pluginManifestPath);
    const present = FORBIDDEN_PLUGIN_MANIFEST_KEYS.filter((key) => Object.hasOwn(manifest, key));
    expect(present).toEqual([]);
  });

  test("skills の置き場は既定の `skills/` だけである(限定4)", () => {
    // `skills` キーで別ディレクトリを指していないことは上の検査で固定した。
    // ここでは既定の置き場が実在することだけを確かめる。
    expect(statSync(join(pluginDir, "skills")).isDirectory()).toBe(true);
  });

  test("plugin ディレクトリに `.mcp.json` を同梱していない(H-G8 の却下)", () => {
    expect(existsSync(join(pluginDir, ".mcp.json"))).toBe(false);
  });
});

describe("配布物 marketplace.json(V6-M11-T02 / H-G7)", () => {
  test("`.claude-plugin/marketplace.json` が実在する", () => {
    expect(existsSync(marketplacePath)).toBe(true);
  });

  test("`.claude-plugin/` の下に置くファイルは marketplace.json 1本だけである(限定4)", () => {
    expect(readdirSync(marketplaceDir).sort()).toEqual(["marketplace.json"]);
  });

  test("plugins 配列の要素は1つだけである(限定1)", async () => {
    const marketplace = await readJson(marketplacePath);
    expect(Array.isArray(marketplace.plugins)).toBe(true);
    expect(marketplace.plugins as unknown[]).toHaveLength(1);
  });

  test("source は `./` で始まる同一リポジトリの相対パスである(限定2)", async () => {
    const marketplace = await readJson(marketplacePath);
    const entry = firstPluginEntry(marketplace);
    expect(typeof entry.source).toBe("string");
    const source = entry.source as string;
    expect(source.startsWith("./")).toBe(true);
    expect(source.includes("..")).toBe(false);
  });

  test("source が指す先が実在し、その中に plugin.json がある", async () => {
    const marketplace = await readJson(marketplacePath);
    const entry = firstPluginEntry(marketplace);
    // 相対パスは marketplace ルート(`.claude-plugin/` を含むディレクトリ)から解決される。
    const resolved = resolve(PRODUCT_ROOT, entry.source as string);
    expect(existsSync(join(resolved, ".claude-plugin", "plugin.json"))).toBe(true);
    expect(resolved).toBe(pluginDir);
  });

  test("renames を書いていない(限定3)", async () => {
    const marketplace = await readJson(marketplacePath);
    expect(Object.hasOwn(marketplace, "renames")).toBe(false);
  });

  test("marketplace エントリの name が plugin.json の name と同じである", async () => {
    const marketplace = await readJson(marketplacePath);
    const entry = firstPluginEntry(marketplace);
    const manifest = await readJson(pluginManifestPath);
    expect(entry.name).toBe(manifest.name);
  });
});

describe("版の一致(V6-M11-T04 / H-G10 の限定2)", () => {
  test("plugin.json の version は空でない文字列である(限定1: 版は1本だけ)", async () => {
    const manifest = await readJson(pluginManifestPath);
    expect(typeof manifest.version).toBe("string");
    expect((manifest.version as string).length).toBeGreaterThan(0);
  });

  test("marketplace エントリの version が plugin.json の version と一致する", async () => {
    const manifest = await readJson(pluginManifestPath);
    const marketplace = await readJson(marketplacePath);
    const entry = firstPluginEntry(marketplace);
    expect(entry.version).toBe(manifest.version);
  });
});

/** `release.json` を読む。**この検査ファイルが `release.json` を読む唯一の入口である**(`ADR-0351` 限定4)。 */
async function readRelease(): Promise<Json> {
  return await readJson(releasePath);
}

/** 版の宣言に書いてよいキー(`ADR-0355` D1 の3キー)。**`units` はここに無い。** */
const ALLOWED_RELEASE_KEYS = ["distributes", "meaning", "version"];

/**
 * その単位が持っている配布物の実ファイルを列挙する。
 * 見るのは `.claude-plugin/marketplace.json` と `plugins/<name>/.claude-plugin/plugin.json` の2種だけである。
 */
function distributionArtifacts(unitDir: string): string[] {
  const found: string[] = [];
  const marketplace = join(unitDir, ".claude-plugin", "marketplace.json");
  if (existsSync(marketplace)) found.push(marketplace);
  const pluginsDir = join(unitDir, "plugins");
  if (existsSync(pluginsDir)) {
    for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = join(pluginsDir, entry.name, ".claude-plugin", "plugin.json");
      if (existsSync(manifest)) found.push(manifest);
    }
  }
  return found.sort();
}

describe("この app の版(V9-M11-T03 / X-G27。ADR-0355 D1)", () => {
  test("`release.json` が実在し、JSON として読める", async () => {
    expect(existsSync(releasePath)).toBe(true);
    const release = await readRelease();
    expect(typeof release.version).toBe("string");
  });

  test("`meaning` が空でない文字列である(版の意味が消えたら赤くなる)", async () => {
    const release = await readRelease();
    expect(typeof release.meaning).toBe("string");
    expect((release.meaning as string).length).toBeGreaterThan(0);
  });

  test("キーは version / meaning / distributes の3つだけである(units を持たない)", async () => {
    // **これは `ADR-0352` D1 の 3(`units` の path 集合と `apps/` の完全一致)の代わりではない。**
    // 3 が塞いでいた「2つ目の器の宣言し忘れ」は、今日どの検査も1つも見張っていない
    // (上の追記ブロックで名指しした)。ここが見張るのは、`units` が戻ってこないことだけである。
    const release = await readRelease();
    expect(Object.keys(release).sort()).toEqual(ALLOWED_RELEASE_KEYS);
  });

  test("release.json / plugin.json / marketplace エントリの3つの version が一致する", async () => {
    const release = await readRelease();
    // この app は配布物を配る。配らない app では下の突合の相手が1つも存在しない。
    expect(release.distributes).toBe("claude-plugin");
    const releaseVersion = release.version as string;
    const manifest = await readJson(pluginManifestPath);
    const marketplace = await readJson(marketplacePath);
    const entries = (marketplace.plugins as Json[] | undefined) ?? [];
    const entry = entries.find((candidate) => candidate.name === manifest.name);
    if (!entry) throw new Error("marketplace エントリが見つからない");
    expect(manifest.version, "plugin.json").toBe(releaseVersion);
    expect(entry.version, "marketplace エントリ").toBe(releaseVersion);
  });

  test("`distributes` の値と、この app が実際に持つ配布物の有無が一致する", async () => {
    // **見る相手はこの app 1つだけである。** `ADR-0352` D1 の 5 が今日唯一の対象にしていた
    // もう1つの受け皿(`apps/` の下に在る、配布物を持たない側の器)を、この検査はもう1バイトも見ない
    // (見るには2本目の読む側が要り、それは `ADR-0351` 限定4 を破る)。
    // **「その受け皿に配布物が無い」は今日1つも保証されない。**
    // (**実体の名前で綴らない理由は冒頭の JSDoc の 5 に書いた。`X-G33` の完了条件(3)。**)
    const release = await readRelease();
    expect(release.distributes === null || release.distributes === "claude-plugin").toBe(true);
    const found = distributionArtifacts(PRODUCT_ROOT);
    if (release.distributes === null) {
      expect(found, "配らないと宣言しているのに配布物を持っている").toEqual([]);
    } else {
      expect(found.length, "配ると宣言しているのに配布物が1本も無い").toBeGreaterThan(0);
    }
  });
});
