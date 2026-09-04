/**
 * 消費側の検査(V1-M1-T02。判断は `docs/plan/v1/records/v1-m1-t01.md` §3-2)。
 *
 * `kernel-export-drift.test.ts` が **提供側**(`src/kernel/` が何を export しているか)を
 * 見るのに対し、こちらは **消費側**(`src/kernel/` の外から誰が何を import しているか)を見る。
 * **読むファイルの集合が交わらないので、同一の検査にはならない**(T01 §3-2)。
 *
 * ## 何を塞ぐのか
 *
 * ADR-0009 の**限定2** —— 「層をまたいで**値として** import してよいのは `normalizeSort` の
 * 1本だけ」 —— には機械検査が無い。`scripts/kernel-types-no-import.test.ts` が固定して
 * いるのは限定3(`types.ts` の中身がモジュール依存を持たないこと)だけであり、
 * **`src/kernel/types.ts` 以外のファイルを1つも読んでいない**。ADR-0009 §5 限界3 が
 * 自ら「Δ8 の混入が CI で捕まらないのと同じ構造」と申告している。
 *
 * ## 限定2 専用にせず、一般形にした理由(T01 §3-2)
 *
 * 限定2 だけを検査すると、`normalizeFilter` のような**次の層またぎ**が現れたときに
 * 検査を書き足す必要がある。一覧のスナップショットにすれば、**新しい層またぎが1件でも
 * 入った瞬間に赤になる。** ADR-0007 §1b が Δ8 と歯止め2 を対で置いたのと同じ形で、
 * 提供側と消費側を対で塞ぐ。
 *
 * ## `import type` を数えない
 *
 * ADR-0009 限定2 の条文が「**値として** import してよいのは `normalizeSort` のみ」であり、
 * 型 import は限定の対象外だからである。判定は**推測ではなく `Bun.Transpiler` に型を
 * 消させてから**行う ―― 型 import は transpile 後の JS に残らないので、
 * 残ったものが定義上「値として import されたもの」である。
 *
 * ## 限界(憲法6)
 *
 * - **スナップショットの更新は人間が行う**(`kernel-export-drift.test.ts` と同じ穴)。
 * - **検出するのは「増えたこと」だけで、それが ADR-0009 の限定に照らして許されるかは
 *   判定しない。** 機械化したのは検出であって審査ではない。
 * - 動的 `import()` と `require()` は拾わない。現在この経路は1件も無いが、
 *   増えたときに静かに素通りする。
 *
 * =====================================================================================
 * **【`V8-M26` / `D-V8-67`(2026-08-10)。スナップショットは1バイトも打ち直していない。
 *   なぜ打ち直さずに緑へ戻ったのかを、経緯として残す】**
 * =====================================================================================
 *
 * **本タスクの着手時、この検査は赤だった。** **増えていた層またぎは **3件** で、出どころは
 * すべて `V8-M26-T05`(題材の修復)が受信の検査3本に足した「点(行ごとのアクセス権)の
 * 足場」であった** —— **参加者の表へ `system:inbound` の行を1件入れるために、
 * `createRecord` を値として import していた:**
 *
 *   - `src/server/inbound-route.test.ts:createRecord`
 *   - `src/server/inbound-owner-scope.test.ts:createRecord`
 *   - `src/server/inbound-signature-shape.test.ts:createRecord`
 *
 * **`HEAD`(`6b8cf31`)がスナップショットへ足したのは 7件** ——
 * **`src/server/role-default-closed.test.ts` の3件と
 * `src/server/role-default-grant-http.test.ts` の4件だけであり、上の3件は載っていなかった。**
 * **つまり赤の原因は「スナップショットの更新漏れ」ではなく、「載せる前提で足した import が
 * 3件残っていた」ことである**(1件ずつ `git show HEAD -- <file>` で出どころを確かめた)。
 *
 * **ユーザ決定 `D-V8-67`(受信口は「持ち主が書いている」として扱う)により、点の足場は
 * まるごと不要になった** —— **3本とも `app.roles` の1本に置き換え、`createRecord` の
 * 値 import が3件とも消えた。** **その結果、増分は0件・減分も0件になり、
 * スナップショットは `HEAD` のまま一致する。**
 *
 * **【打ち直していないことの確認】** **`scripts/industry-neutral-examples.test.ts:1163` が
 * `scripts/kernel-import-snapshot.txt` の sha を固定しており、そこも緑のままである。**
 */

import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const REPO_ROOT = dirname(import.meta.dir);
const SNAPSHOT_PATH = join(import.meta.dir, "kernel-import-snapshot.txt");

/** 走査対象のルート。`src/kernel/` 自身は含めない(層の**外**を見る検査である)。 */
const SEARCH_ROOTS = ["src/mcp", "src/server", "src/cli", "src/shared", "web", "scripts"];

/** `src/kernel/...` を指す import 元かどうか。相対パスの綴りに依存させない。 */
function pointsToKernel(fromFile: string, specifier: string): boolean {
  if (!specifier.startsWith(".")) {
    return false;
  }
  const resolved = join(dirname(fromFile), specifier);
  return relative(REPO_ROOT, resolved).replaceAll("\\", "/").startsWith("src/kernel/");
}

function walk(dir: string): string[] {
  const files: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }).map((entry) => entry.name);
  } catch {
    return files;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) {
      continue;
    }
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      files.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(name)) {
      files.push(full);
    }
  }
  return files;
}

/**
 * transpile 後の JS に残った import 文から、束縛される名前を取り出す。
 *
 * 型 import は transpile の時点で消えているので、ここに現れるものは
 * **定義上「値として import されたもの」**である。生成された JS を読むので、
 * 元ソースの書き方(改行位置・`import type` の位置)に左右されない。
 */
const JS_IMPORT_RE =
  /import\s+(?:([\w$]+)\s*,\s*)?(?:\{([^}]*)\}|([\w$*]+(?:\s+as\s+[\w$]+)?))?\s*from\s*["']([^"']+)["']/g;

function valueImportsFromKernel(file: string): string[] {
  const source = readFileSync(file, "utf-8");
  const loader = file.endsWith(".tsx") ? "tsx" : "ts";
  let js: string;
  try {
    js = new Bun.Transpiler({ loader }).transformSync(source);
  } catch {
    return [];
  }

  const found: string[] = [];
  for (const match of js.matchAll(JS_IMPORT_RE)) {
    const specifier = match[4] ?? "";
    if (!pointsToKernel(file, specifier)) {
      continue;
    }
    const names: string[] = [];
    if (match[1] !== undefined) names.push(match[1]);
    if (match[2] !== undefined) {
      for (const part of match[2].split(",")) {
        // `{ a as b }` は、カーネル側の名前(a)で記録する。呼ぶ側の別名は問題ではない。
        const original = part
          .trim()
          .split(/\s+as\s+/)[0]
          ?.trim();
        if (original !== undefined && original !== "") names.push(original);
      }
    }
    if (match[3] !== undefined) names.push(match[3]);

    const rel = relative(REPO_ROOT, file).replaceAll("\\", "/");
    for (const name of names) {
      found.push(`${rel}:${name}`);
    }
  }
  return found;
}

function collectValueImports(): string[] {
  const entries: string[] = [];
  for (const root of SEARCH_ROOTS) {
    for (const file of walk(join(REPO_ROOT, root))) {
      entries.push(...valueImportsFromKernel(file));
    }
  }
  return [...new Set(entries)].sort();
}

function readSnapshot(): string[] {
  return readFileSync(SNAPSHOT_PATH, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

test("ADR-0009 限定2: src/kernel/ の外から値として import されるシンボルがスナップショットと一致する", () => {
  const actual = collectValueImports();
  const expected = readSnapshot();

  const added = actual.filter((name) => !expected.includes(name));
  const removed = expected.filter((name) => !actual.includes(name));

  expect({ added, removed }).toEqual({ added: [], removed: [] });
});

test("ADR-0009 限定2: sortErrorPath / validateSortKeys は src/kernel/ の外から値として import されない", () => {
  // 一般形のスナップショットとは別に、**条文そのもの**を直接照合する。
  // スナップショットは「増えたこと」しか言わないので、条文が名指しした限定を
  // 条文の言葉で固定しておかないと、限定2 の内容が記録から消える。
  //
  // **条文の射程に注意**(この検査を書いたとき、最初に射程を取り違えた)。ADR-0009 §3 限定2 は
  //
  //   > `src/kernel/` の外(`web/` / `src/mcp/` / `src/server/`)から**値として**
  //   > import してよいのは `normalizeSort` のみ。`sortErrorPath` / `validateSortKeys` は
  //   > `src/kernel/` 内部からのみ参照する
  //
  // であり、**主語は ADR-0009 が足した3本**である。「`web/` はカーネルから
  // `normalizeSort` 以外を値 import してはならない」という一般則ではない
  // (`web/test/api.test.ts` が `createApp` を値 import しているのは限定2 の違反ではなく、
  //  限定2 が制約したことのない事柄である)。**射程を広く取り違えると、この検査は
  // 「ADR が言っていないこと」で赤くなり、緩めさせる圧力を生む。**
  const outside = collectValueImports();
  const forbidden = outside.filter((entry) => {
    const symbol = entry.split(":")[1];
    return symbol === "sortErrorPath" || symbol === "validateSortKeys";
  });
  expect(forbidden).toEqual([]);

  // 反対側 —— `normalizeSort` は層をまたいで**よい**唯一の1本であり、実際にまたいでいる。
  // ここが空になったら、限定2 が守っている対象そのものが消えている(検査の空回り)。
  expect(outside.filter((entry) => entry.endsWith(":normalizeSort")).length).toBeGreaterThan(0);
});

test("空の集合に対して緑にならない(検査が実際に読めていることの確認)", () => {
  const actual = collectValueImports();
  expect(actual.length).toBeGreaterThan(0);
  // MCP 層はカーネルの公開APIを値として大量に使う。ここが0件なら走査が壊れている。
  expect(actual.some((entry) => entry.startsWith("src/mcp/"))).toBe(true);
});
