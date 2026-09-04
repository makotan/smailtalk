/**
 * **参照候補は「その人に見える範囲」だけを出す** —— **既存の読取経路を迂回する経路を
 * 1本も作っていない**(`K-G18`。`V6-M4-T05`)。
 *
 * **審査結果の正は `docs/plan/v6/records/v6-m0.md` §7-9**(単位H)、**完了条件の正は
 * 同 §6 の `V6-M4-T05` の行**である。**単位H は門外(`Δ7`)であり、個別 ADR を持たない**
 * (同 §7-9 の `S6`)。
 *
 * ## この単位の性格(`v6-m0.md` §7-9 の `S3` (1) の逐語)
 *
 * > **本単位の実装は0バイトになりうる** —— 参照候補は今日すでに一覧と同じ1本の経路を
 * > 通っている。
 *
 * **実際に0バイトである。** **`V6-M4` が足した取得は `fetchRecordPage` /
 * `fetchRecord` の2本だけであり、どちらも既存の HTTP ルートを叩く既存の関数である。**
 * **本タスクが書いたのはこのファイル(検査)だけである** —— **`v6-m0.md` §7-9 が
 * 「新設する検査ファイルを主対象パスに含めることで測れるようにする」と決めた形をそのまま採った。**
 *
 * ## このファイルが固定すること(**ソースの走査**である)
 *
 * | # | 条件 | 検査 |
 * |---|---|---|
 * | (a) | 入力欄が `fetch` を**自分で呼ばない** | `web/src/fields/input.tsx` に `fetch(` の字面が1つも無い |
 * | (b) | 入力欄が API の**URL を自分で組まない** | 同ファイルに `/api/` の字面が1つも無い |
 * | (c) | 入力欄が読む口は**既存の3本だけ** | `../api.ts` からの import が許した名前だけである |
 * | (d) | その3本が**同じ1本のレコード読取ルート**を組む | `web/src/api.ts` の該当関数が `recordsPath` / `recordPath` を通る |
 * | (e) | 可視性の判定を**参照項目の入力欄に写していない** | `web/src/fields/` に4つの判定関数の字面が0件。**`web/src` 全体では0件ではない**(下の注記) |
 * | (f) | サーバ側の post-filter 分岐が **`limit` / `offset` を DB に渡さない**性質が今日も在る | `src/server/app.ts` の逐語2行を照合する |
 *
 * ## このファイルが証明しないこと(先に書く。誇張しない)
 *
 * 1. **本物のサーバを1度も起動していない。** **これはソースの走査であって、遮断の実測ではない。**
 *    **`st_owner` / `st_public` / `audience` の遮断そのものは
 *    `src/server/` の既存の検査群が既に本物で測っている** —— **本タスクはその上に
 *    1件も足していない。**
 * 2. **`audience` の既知の穴を1件も塞いでいない**(`v6-m0.md` §7-9 の `S3` (3))。
 *    **代表項目に `audience` が付いているときの非対称(`ADR-0290` §限界)は今日も残っている。**
 * 3. **将来「速くしたい」という理由で迂回が作られることを止められない** —— **このファイルが
 *    止められるのは「入力欄が自分で URL を組む」形だけである**(`v6-m0.md` §7-9 の `S3` (2))。
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const WEB_ROOT = dirname(import.meta.dir);
const WEB_SRC = join(WEB_ROOT, "src");
const REPO_ROOT = dirname(WEB_ROOT);
const INPUT_PATH = join(WEB_SRC, "fields", "input.tsx");
const API_PATH = join(WEB_SRC, "api.ts");
const SERVER_APP_PATH = join(REPO_ROOT, "src", "server", "app.ts");

function webSourceFiles(directory: string = WEB_SRC): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      return webSourceFiles(full);
    }
    return entry.endsWith(".ts") || entry.endsWith(".tsx") ? [full] : [];
  });
}

// ---------------------------------------------------------------------------
// (a)(b)(c) 入力欄は既存の口しか使わない
// ---------------------------------------------------------------------------

test("(a) 参照項目の入力欄は fetch を自分で1度も呼んでいない", () => {
  const source = readFileSync(INPUT_PATH, "utf8");
  expect(source.includes("fetch(")).toBe(false);
});

test("(b) 参照項目の入力欄は API の URL を自分で1つも組んでいない", () => {
  // **【実測。「0件」と書けない】** **`/api/` の字面は今日 3行ある** ——
  // **3行とも doc コメント**(image / file 型のアップロード先と配信 URL の説明)であり、
  // **`V0` / `V5` から在る。** **本タスクが測るのは「コードの行に1件も無いこと」である。**
  const lines = readFileSync(INPUT_PATH, "utf8").split("\n");
  const hits = lines.filter((line) => line.includes("/api/"));
  expect(hits.length).toBe(3);
  const code = hits.filter((line) => {
    const trimmed = line.trim();
    return !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*");
  });
  expect(code).toEqual([]);
});

test("(c) 入力欄が `../api.ts` から取る名前は、既存の口だけである", () => {
  const source = readFileSync(INPUT_PATH, "utf8");
  const match = source.match(/import \{([^}]*)\} from "\.\.\/api\.ts";/);
  expect(match).not.toBeNull();
  const imported = (match?.[1] ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  // **読取は3本だけである。** **4本目を足すときは、この検査が赤くなる。**
  // `fileDeliveryUrl` / `uploadFile` は image / file 型のもので、レコード読取ではない。
  expect([...imported].sort()).toEqual([
    "fetchRecord",
    "fetchRecordPage",
    "fetchRecords",
    "fileDeliveryUrl",
    "uploadFile",
  ]);
});

// ---------------------------------------------------------------------------
// (d) その3本は同じ1本のレコード読取ルートを組む
// ---------------------------------------------------------------------------

test("(d) fetchRecords / fetchRecordPage / fetchRecord は既存のレコード読取ルートを組んでいる", () => {
  const source = readFileSync(API_PATH, "utf8");
  for (const [name, path] of [
    ["fetchRecords", "recordsPath(appId, tableId)"],
    ["fetchRecordPage", "recordsPath(appId, tableId)"],
    ["fetchRecord", "recordPath(appId, tableId, recordId)"],
  ] as const) {
    const start = source.indexOf(`export async function ${name}(`);
    expect(start, name).toBeGreaterThan(-1);
    const end = source.indexOf("\n}\n", start);
    expect(end, name).toBeGreaterThan(start);
    expect(source.slice(start, end), name).toContain(path);
  }
  // **URL を組む場所は `recordsPath` / `recordPath` の2本だけである**(2箇所目を作らない)。
  expect(source.split("function recordsPath(").length - 1).toBe(1);
  expect(source.split("function recordPath(").length - 1).toBe(1);
});

// ---------------------------------------------------------------------------
// (e) 可視性の判定を表示層に写していない
// ---------------------------------------------------------------------------

/**
 * **判定の本体はサーバ層の `src/server/owner-scope.ts` の1本である**
 * (`ADR-0016` / `ADR-0034` / `ADR-0061` / `ADR-0071`)。
 *
 * **【実測。「0件」と書けない】** **`isOwnerVisible` は今日 `web/src` に2ファイル
 * (`auth/authz.tsx` / `views/ListViewRenderer.tsx`)在る。** **`V4-M19-T09` が
 * 「誰の行か」の規約を表示層へ持ち込んだ結果であり、本タスクの射程ではない
 * (`ListViewRenderer.tsx` は自分の行に印を付けるために呼んでいる)。**
 * **本タスクが測れるのは「参照項目の入力欄に写っていないこと」と
 * 「本タスクがこの件数を1件も増やしていないこと」の2つである。**
 * **`isPublicRow` / `adminReadsAllRows` / `projectForFieldAudience` は
 * 今日 `web/src` 全体で0件であり、そちらは0件として測る。**
 */
const VISIBILITY_SYMBOLS = [
  "isOwnerVisible",
  "isPublicRow",
  "adminReadsAllRows",
  "projectForFieldAudience",
] as const;

test("(e) 可視性の判定は参照項目の入力欄に1件も写っていない", () => {
  const inputFiles = webSourceFiles(join(WEB_SRC, "fields"));
  for (const symbol of VISIBILITY_SYMBOLS) {
    const hit = inputFiles.filter((file) => readFileSync(file, "utf8").includes(symbol));
    expect(
      hit.map((file) => relative(WEB_SRC, file)),
      symbol,
    ).toEqual([]);
  }
});

test("(e) web/src 全体の写しの本数は、着手前と1件も変わっていない", () => {
  // **「0件」ではない。** 本タスクが増やしていないことだけを測る。
  const counts = Object.fromEntries(
    VISIBILITY_SYMBOLS.map((symbol) => [
      symbol,
      webSourceFiles()
        .filter((file) => readFileSync(file, "utf8").includes(symbol))
        .map((file) => relative(WEB_SRC, file))
        .sort(),
    ]),
  );
  expect(counts).toEqual({
    // **`V4-M19-T09` が持ち込んだ2ファイル。本タスクは1バイトも触っていない。**
    isOwnerVisible: ["auth/authz.tsx", "views/ListViewRenderer.tsx"],
    isPublicRow: [],
    adminReadsAllRows: [],
    projectForFieldAudience: [],
  });
});

// ---------------------------------------------------------------------------
// (f) post-filter 分岐が limit / offset を DB に渡さない性質は今日も在る
// ---------------------------------------------------------------------------

test("(f) 可視性の post-filter 分岐は今日も limit / offset を DB へ渡していない", () => {
  // **`v6-m0.md` §7-9 の `S3` (2) が名指しした2行の逐語照合である。**
  // **上限とページ送りを入れると `limit` を DB に落としたくなる** ——
  // **その誘惑に負けた日にこの検査が赤くなる。**
  const source = readFileSync(SERVER_APP_PATH, "utf8");
  expect(source).toContain("      delete listQuery.limit;");
  expect(source).toContain("      delete listQuery.offset;");
});
