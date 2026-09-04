/**
 * **新しい利用者が生まれる道は HTTP の4本しか無い**(`V8-M5-T06`。台帳 `I-G32` / `I-G33`。
 * どちらも門外・限定採用。[`ADR-0338`](../../docs/adr/0338-signup-facts-and-user-creation-paths.md) §3-4)。
 *
 * ## **これは「素通りを塞ぐ」検査ではない**(裁定 `M0-7`)
 *
 * **`V8-M0` が単位そのものを書き直している** —— **「今日どおり素通りする」ではなく
 * 「これらの経路には、新しい利用者を生む道が**そもそも無い**」。**
 * **したがってこのファイルは判定を1つも足していない。** **固定するのは今日の構造だけである。**
 *
 * ## 固定する事実(`ADR-0338` §3-4 の4点)
 *
 * 1. **`_auth_users` に行を作る SQL は製品コードに1文だけである。**
 * 2. **その1文を呼ぶ製品コードの入口は2本であり、HTTP のパスとしては4本である。**
 * 3. **MCP 層と `src/kernel/` には、利用者を作る綴りが1つも無い。**
 * 4. **表の識別子は `_` で始められず、表の解決は `resolveTable` 1本に閉じている** ——
 *    **2重の構造で `_auth_*` へ到達できない。**
 *
 * ## この検査が測らないもの(**誇張しない**)
 *
 * - **これは今日の**字面**を固定する検査である。** **綴りを変えた同義の実装(たとえば
 *   別名の `INSERT`)を1つも捕まえられない**(`ADR-0338` `S3` の 4 / §限界9)。
 *   **「道が4本しか無い」ことを**証明**したのではなく、**今日そう見えること**を固定した。**
 * - **【禁止】「MCP は `_auth_*` に一切触れない」と書かない** —— **`src/mcp/actor-guard.ts` が
 *   `AuthStore.openForApp` を開いて利用者を**読む**(名乗りの解決。`V8-M31` / `J-G26`)。**
 *   **読むが作らない。** 下の (`I-G32`-2) がその事実ごと固定する。
 * - **`undo` / `redo` は例外である** —— **`app.sqlite` を丸ごと上書きするので、
 *   `_auth_users` の行が消えたり戻ったりする**(`D-V8-111` の代償)。**ここでは測っていない。**
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  applyManifest,
  createApp,
  KernelMetaStore,
  type Manifest,
  resolveTable,
} from "../kernel/index.ts";

/** `src/`(`entry-point-inventory.test.ts` と同じ採り方)。 */
const SRC = join(import.meta.dir, "..");
const REPO_ROOT = dirname(SRC);

const read = (relative: string): string => readFileSync(join(REPO_ROOT, relative), "utf8");

/** そのディレクトリ以下の `.ts` を全部読む(テストを除くかどうかは呼び出し側が決める)。 */
function sourcesUnder(relativeDir: string, options: { includeTests: boolean }): string[] {
  const glob = new Bun.Glob("**/*.ts");
  const files: string[] = [];
  for (const entry of glob.scanSync({ cwd: join(REPO_ROOT, relativeDir), absolute: true })) {
    if (!options.includeTests && entry.endsWith(".test.ts")) {
      continue;
    }
    files.push(entry);
  }
  return files;
}

// =============================================================================================
// (`I-G32`) **AI(MCP)経由では新しい利用者が生まれない**
// =============================================================================================

test("(I-G32) 利用者を作る SQL は製品コードに1文だけで、MCP 層にはその綴りが1つも無い", () => {
  // --- 1. 行を作る SQL は1文だけである -----------------------------------------------
  const marker = 'INSERT INTO "_auth_users"';
  const hits = sourcesUnder("src", { includeTests: false }).filter((file) =>
    readFileSync(file, "utf8").includes(marker),
  );
  expect(hits.map((file) => file.slice(REPO_ROOT.length + 1))).toEqual(["src/auth/store.ts"]);
  expect(readFileSync(hits[0] as string, "utf8").split(marker).length - 1).toBe(1);

  // --- 2. MCP 層と `src/kernel/` に、利用者を作る綴りが1つも無い ----------------------
  // **【禁止】これを「MCP は `_auth_*` に一切触れない」と読まない** ——
  // **下の3行目が、開いて**読んでいる**ことを同じ検査の中で固定している。**
  for (const dir of ["src/mcp", "src/kernel"]) {
    const creators = sourcesUnder(dir, { includeTests: false }).filter((file) =>
      readFileSync(file, "utf8").includes("createUser"),
    );
    expect(creators, dir).toEqual([]);
  }
  // **開いて読む側は今日1本ちょうど在る**(`V8-M31` / `J-G26` の名乗りの解決)。
  expect(read("src/mcp/actor-guard.ts")).toContain("AuthStore.openForApp");

  // --- 3. 利用者を作る関数を呼ぶ製品コードの入口は2本ちょうどである -------------------
  // **`createUserSafely` は `src/server/auth-routes.ts` の中だけに在り、宣言1本 + 呼び出し2本。**
  const authRoutes = read("src/server/auth-routes.ts");
  expect(authRoutes.split("createUserSafely(").length - 1).toBe(3);
  const elsewhere = sourcesUnder("src", { includeTests: false }).filter(
    (file) =>
      !file.endsWith("auth-routes.ts") && readFileSync(file, "utf8").includes("createUserSafely"),
  );
  // **【実測。丸めない】** **綴りは `src/auth/store.ts` にもう1件在る** ——
  // **`:1643` の**コメント**であり、呼び出しでも宣言でもない。**
  // **【禁止】「綴りは1ファイルにしか無い」と書かない。**
  expect(elsewhere.map((file) => file.slice(REPO_ROOT.length + 1))).toEqual(["src/auth/store.ts"]);
  const storeSource = read("src/auth/store.ts");
  for (const line of storeSource.split("\n").filter((row) => row.includes("createUserSafely"))) {
    expect(line.trimStart().startsWith("*"), line).toBe(true);
  }
});

// =============================================================================================
// (`I-G33`) **受信口・ワークフロー・島からも新しい利用者が生まれない**(**3本**)
// =============================================================================================

test("(I-G33-1) 受信口の宛先に `_auth_*` を書けない —— 識別子の正規表現が先に塞ぐ", async () => {
  // **1重目**: **表の識別子は `_` で始められない**(スキーマの正規表現)。
  const schema = read("schemas/manifest.schema.json");
  expect(schema).toContain('"pattern": "^[a-z][a-z0-9_-]*$"');

  // **本物の `applyManifest` に当てる**(読解で終わらせない)。
  const dataRoot = await mkdtemp(join(tmpdir(), "gp-user-paths-"));
  try {
    const store = KernelMetaStore.open(dataRoot);
    try {
      createApp(store, "受信口の題材", { app_id: "inbound-probe" });
    } finally {
      store.close();
    }
    const applied = applyManifest(dataRoot, "inbound-probe", {
      app: {
        id: "inbound-probe",
        name: "受信口の題材",
        tables: [
          {
            id: "_auth_users",
            name: "利用者",
            fields: [{ id: "username", name: "名前", type: "text" }],
          },
        ],
        views: [],
      },
    } as unknown as Manifest);
    expect(applied.valid).toBe(false);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("(I-G33-2) ワークフローの `create_record` / `update_record` は `_auth_*` に到達できない", () => {
  // **2重目**: **表の解決は `resolveTable` 1本に閉じており、到達範囲は
  // `SYSTEM_TABLES` ∪ `manifest.app.tables` である。** **`_auth_users` はどちらにも無い。**
  const manifest = {
    app: {
      id: "wf-probe",
      name: "ワークフローの題材",
      tables: [{ id: "memo", name: "メモ", fields: [{ id: "title", name: "題名", type: "text" }] }],
      views: [],
    },
  } as unknown as Manifest;
  expect(resolveTable(manifest, "memo")?.id).toBe("memo");
  for (const systemAuthTable of ["_auth_users", "_auth_sessions", "_auth_invitations"]) {
    expect(resolveTable(manifest, systemAuthTable), systemAuthTable).toBeUndefined();
  }
  // **`_apps` は解決する** —— **「`_` 始まりが全部解決しない」わけではない。**
  // **`_auth_*` が解決しないのは `SYSTEM_TABLES` に入っていないからである。誇張しない。**
  expect(resolveTable(manifest, "_apps")).toBeDefined();
});

test("(I-G33-3) 島には危険物が1つも注入されず、`src/kernel/` の素通りの記述に訂正が在る", () => {
  // **島は QuickJS-WASM の中で走り、HTTP のリクエスト文脈も `AuthStore` も持たない。**
  const island = read("src/kernel/island-runner.ts");
  expect(island).toContain("危険物を1つも注入しない");
  // **`src/kernel/` に `AuthStore` の綴りが在るのは1件だけで、それはコメントである。**
  const authStoreFiles = sourcesUnder("src/kernel", { includeTests: false }).filter((file) =>
    readFileSync(file, "utf8").includes("AuthStore"),
  );
  expect(authStoreFiles.map((file) => file.slice(REPO_ROOT.length + 1))).toEqual([
    "src/kernel/migrate.ts",
  ]);

  // =========================================================================================
  // **【`V8-M5-T05` の 2。裁定 `M0-6`。`ADR-0338` §3-3 の 2】**
  // **`src/kernel/workflow-runner.ts` の「完了後に残る唯一の素通りである」は今日は偽である** ——
  // **素通りは `schedule` と `write_back` の2種である。**
  // **本文を1バイトも書き換えず、訂正を隣に置いた。**
  // **【禁止】これを「軸1 が塞いだ」とも「塞がなかった」とも書かない。**
  // =========================================================================================
  const runner = read("src/kernel/workflow-runner.ts");
  // **旧文は1バイトも消していない**(出現は今日も1回ちょうど)。
  expect(runner.split("完了後に残る唯一の素通りである").length - 1).toBe(1);
  // **訂正が在る。**
  expect(runner).toContain("素通りは今日2種である");
  // **判定を1つも足していない**(`ADR-0338` 限定5)。
  expect(runner.split("accessJudgmentApplies").length - 1).toBe(7);
});
