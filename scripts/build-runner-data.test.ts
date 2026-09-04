/**
 * 配布物用の `data/` を1アプリ分だけ組み立てる手段(`V5-M2-T02` = `R-G5` / `V5-M2-T03` = `R-G11`)。
 *
 * 門A本審査(`docs/plan/v5/records/v5-m0.md` §2-5 / §2-11)はどちらも **門外(記録)** と判定した。
 *
 * ## この検査が固定するもの
 *
 * 1. **`T02`**: 複数アプリを持つ `kernel.sqlite`(**本物の SQLite**)から1件分を取り出したあと、
 *    **単一ソース `APP_SCOPED_KERNEL_TABLES` の全テーブルと `apps` 自身**で、他アプリの行が
 *    0件であること。**`apps` は1行だけになること。**
 * 2. **`T02`**: 他アプリの `_changelog` の **intent の逐語が、出力の `kernel.sqlite` の
 *    バイト列に1回も現れない**こと(`V5-M0` §2-5 S3 の 3 が「行が混ざるより重い」と書いた点)。
 * 3. **`T03`**: 出力の `kernel.sqlite` を投影元にしたとき、**`_changelog` の投影に他アプリの行が
 *    1件も出ない**こと。**`T03` は実装ではなく確認である** —— `src/kernel/read-records.ts` の
 *    `PROJECTIONS` にも `src/shared/system-tables.ts` にも1バイトも触らない。
 *
 * ## この検査が**固定しないもの**(意図的)
 *
 * **「`kernel.sqlite` に新しいアプリ横断テーブルが増えたのに `APP_SCOPED_KERNEL_TABLES` へ
 * 足し忘れたら赤くなる」検査を1本も置いていない。** `V5-M0` §2-14 S3 の 4 が
 * 「**次に足し忘れたら赤くなる検査を1本も作らない**」と申し送っているためである。
 * したがって走査は `sqlite_master` ではなく**単一ソースの配列**に対して行う。
 * `buildRunnerData` は行をコピーしなかったテーブルを `skippedTables` として返すが、
 * **その中身をここで assert していない**(assert すると上の禁止に当たる)。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiCapabilityStore } from "../src/kernel/ai-capability-store.ts";
import { CapabilityStore } from "../src/kernel/capability-store.ts";
import { CommentStore } from "../src/kernel/comment-store.ts";
import { createApp } from "../src/kernel/create-app.ts";
import { APP_SCOPED_KERNEL_TABLES } from "../src/kernel/delete-app.ts";
import { EscapeHatchStore, putEscapeHatchBody } from "../src/kernel/escape-hatch-store.ts";
import { InboundStore } from "../src/kernel/inbound-store.ts";
import { KernelMetaStore } from "../src/kernel/meta-store.ts";
import { readRecordList } from "../src/kernel/read-records.ts";
import {
  appDbPath,
  appDir,
  appManifestPath,
  appSnapshotsDir,
  kernelDbPath,
} from "../src/kernel/storage-paths.ts";
import type { Manifest } from "../src/kernel/types.ts";
import { checkRunnerVersionGate } from "../src/server/runner-version-gate.ts";
import { RUNNER_BUILD_VERSION } from "../src/shared/runner-build-version.ts";
import { buildRunnerData } from "./build-runner-data.ts";

let sourceRoot: string;
let targetRoot: string;

/** 他アプリの依頼文。**出力のバイト列に1回も現れてはならない**逐語である。 */
const OTHER_INTENT = "OTHER-APP-SECRET-INTENT-9f3a7c";

/**
 * `readRecordList` に渡す最小のマニフェスト。
 *
 * `_changelog` は `manifest.app.tables` に現れない(`ADR-0006` §5)。`resolveTable` が
 * `findSystemTable` で先に拾うので、**ユーザテーブルが空でも投影は読める。**
 */
const emptyManifest: Manifest = {
  app: { id: "runner", name: "配布物", tables: [], views: [] },
};

beforeEach(() => {
  sourceRoot = mkdtempSync(join(tmpdir(), "gp-runner-src-"));
  targetRoot = join(mkdtempSync(join(tmpdir(), "gp-runner-dst-")), "data");
});

afterEach(() => {
  rmSync(sourceRoot, { recursive: true, force: true });
  rmSync(join(targetRoot, ".."), { recursive: true, force: true });
});

/** アプリを1つ作る(台帳行・ディレクトリ・第0行の changelog が入る)。 */
function seedApp(appId: string): void {
  const store = KernelMetaStore.open(sourceRoot);
  try {
    createApp(store, `${appId} のアプリ`, { app_id: appId });
  } finally {
    store.close();
  }
}

/** changelog を1行足す(intent の逐語を検査に使う)。 */
function seedChangelog(appId: string, intent: string): void {
  const store = KernelMetaStore.open(sourceRoot);
  try {
    store.appendChangelog({ app_id: appId, diff_id: `d-${intent.length}`, intent, operations: [] });
  } finally {
    store.close();
  }
}

/**
 * `APP_SCOPED_KERNEL_TABLES` に載る横断テーブルへ、この app_id の行を入れる。
 *
 * `src/kernel/delete-app.test.ts` の `seedCrossCuttingRows` と同じ組に、
 * **`V5-M2-T01` が足した受信口の2テーブル**を加えたものである。
 */
function seedCrossCuttingRows(appId: string): void {
  const cap = CapabilityStore.openForKernel(sourceRoot);
  try {
    const conn = cap.createConnection({
      appId,
      name: "webhook",
      allowedHosts: ["example.com"],
      secretSource: { kind: "env", value: "TOKEN" },
    });
    cap.enqueueOutbox({
      appId,
      connectionId: conn.id,
      destination: "https://example.com/hook",
      payload: { hello: "world" },
    });
    cap.createRequest({
      appId,
      requestedName: "another",
      purpose: "test",
      suggestedHosts: ["example.org"],
    });
  } finally {
    cap.close();
  }
  const ai = AiCapabilityStore.openForKernel(sourceRoot);
  try {
    const aiCap = ai.createCapability({
      appId,
      name: "summarize",
      provider: "claude_cli",
      model: "claude-3",
      limit: { maxCallsPerDay: 10, maxCostUsdPerDay: 1 },
    });
    ai.enqueueJob({
      appId,
      capabilityId: aiCap.id,
      workflowId: "wf",
      actor: null,
      prompt: "p",
      input: {},
      outputField: "out",
      fallback: "",
      targetTable: "t",
      targetRecordId: "r",
      chainDepth: 0,
    });
    ai.recordUsage({
      appId,
      capabilityId: aiCap.id,
      workflowId: "wf",
      actor: null,
      model: "claude-3",
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0.001,
      status: "success",
      usageDate: "2026-08-06",
      calledAt: "2026-08-06T00:00:00.000Z",
    });
    ai.createRequest({ appId, requestedName: "x", purpose: "p" });
  } finally {
    ai.close();
  }
  const digest = putEscapeHatchBody(sourceRoot, appId, new TextEncoder().encode(".gp-view{}"));
  const hatch = EscapeHatchStore.openForKernel(sourceRoot);
  try {
    hatch.issueEscapeHatchAsset({ appId, name: "compact", digest, scopeViews: ["v1"] });
    hatch.requestEscapeHatchAsset({
      appId,
      requestedName: "wide",
      purpose: "p",
      suggestedScopeViews: [],
    });
  } finally {
    hatch.close();
  }
  const inbound = InboundStore.openForKernel(sourceRoot);
  try {
    inbound.issueInboundEndpoint({
      appId,
      name: "psp-webhook",
      secretSource: { kind: "env", value: "PSP_WEBHOOK_SECRET" },
      targetTable: "payment_event",
    });
    inbound.requestInboundEndpoint({
      appId,
      requestedName: "shipping-webhook",
      purpose: "配送業者からの状態通知を受けたい",
      suggestedTargetTable: "shipping_event",
    });
  } finally {
    inbound.close();
  }
  // **`V10-M10-T01` が足したコメントの器(`gp_comments`)。** 種まきを積まないと、
  // 下の「移行前は他アプリの行が実在する」が**空振りではなく例外**で落ちる
  // (`countForeignRows` / `countRows` にテーブル実在のガードが無く、
  //  `SQLiteError: no such table: gp_comments` になる)。
  const comments = CommentStore.openForKernel(sourceRoot);
  try {
    comments.addComment({
      appId,
      anchorForm: "view",
      anchorParts: ["v1"],
      body: "この画面の並び順を変えたい",
    });
  } finally {
    comments.close();
  }
}

/** 2アプリ(`shop` / `other`)を持つ `kernel.sqlite` を本物の SQLite で作る。 */
function seedTwoApps(): void {
  seedApp("shop");
  seedApp("other");
  seedChangelog("shop", "商品テーブルを足す");
  seedChangelog("other", OTHER_INTENT);
  seedCrossCuttingRows("shop");
  seedCrossCuttingRows("other");
}

/** `kernel.sqlite` の当該テーブルで、`app_id` が `appId` **以外**の行数。 */
function countForeignRows(dataRoot: string, table: string, appId: string): number {
  const db = new Database(kernelDbPath(dataRoot), { readonly: true });
  try {
    return (
      db
        .query<{ c: number }, [string]>(`SELECT COUNT(*) AS c FROM "${table}" WHERE "app_id" <> ?`)
        .get(appId)?.c ?? 0
    );
  } finally {
    db.close();
  }
}

/** `kernel.sqlite` の当該テーブルの総行数。 */
function countRows(dataRoot: string, table: string): number {
  const db = new Database(kernelDbPath(dataRoot), { readonly: true });
  try {
    return db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM "${table}"`).get()?.c ?? 0;
  } finally {
    db.close();
  }
}

// --- T02: 1アプリ分だけの kernel.sqlite ------------------------------------------

test("V5-M2-T02: 取り出したあと、単一ソースの全テーブルで他アプリの行が0件になる", () => {
  seedTwoApps();
  // 前提を先に固定する —— 元の kernel.sqlite には、**単一ソースの全テーブルと `apps` の
  // すべてで**他アプリの行が実在する(検査の空回りを塞ぐ)。
  const foreignBefore: Record<string, number> = {};
  for (const table of [...APP_SCOPED_KERNEL_TABLES, "apps"]) {
    foreignBefore[table] = countForeignRows(sourceRoot, table, "shop");
  }
  expect(Object.entries(foreignBefore).filter(([, n]) => n === 0)).toEqual([]);

  buildRunnerData({ sourceDataRoot: sourceRoot, targetDataRoot: targetRoot, appId: "shop" });

  // **単一ソース + `apps` 自身**を走査する(`sqlite_master` を走査していない。冒頭の但し書き)。
  const foreign: Record<string, number> = {};
  for (const table of [...APP_SCOPED_KERNEL_TABLES, "apps"]) {
    foreign[table] = countForeignRows(targetRoot, table, "shop");
  }
  const expectedZero = Object.fromEntries(
    [...APP_SCOPED_KERNEL_TABLES, "apps"].map((table) => [table, 0]),
  );
  expect(foreign).toEqual(expectedZero);
});

test("V5-M2-T02: apps テーブル自身が1行だけになり、その1行が配るアプリである", () => {
  seedTwoApps();
  expect(countRows(sourceRoot, "apps")).toBe(2);

  buildRunnerData({ sourceDataRoot: sourceRoot, targetDataRoot: targetRoot, appId: "shop" });

  expect(countRows(targetRoot, "apps")).toBe(1);
  const db = new Database(kernelDbPath(targetRoot), { readonly: true });
  try {
    expect(db.query<{ app_id: string }, []>(`SELECT "app_id" FROM "apps"`).all()).toEqual([
      { app_id: "shop" },
    ]);
  } finally {
    db.close();
  }
});

test("V5-M2-T02: 配るアプリ自身の行は1件も落ちない(単一ソースの全テーブルで元と同数)", () => {
  seedTwoApps();
  const before: Record<string, number> = {};
  for (const table of [...APP_SCOPED_KERNEL_TABLES, "apps"]) {
    before[table] = countRows(sourceRoot, table) - countForeignRows(sourceRoot, table, "shop");
  }

  buildRunnerData({ sourceDataRoot: sourceRoot, targetDataRoot: targetRoot, appId: "shop" });

  const after: Record<string, number> = {};
  for (const table of [...APP_SCOPED_KERNEL_TABLES, "apps"]) {
    after[table] = countRows(targetRoot, table);
  }
  // expect(after).toEqual(before);
  // **【`V10-M33-T02` の訂正(2026-08-26)】上の1行は今日の正ではない。**
  // `gp_comments` だけは `RUNNER_EXCLUDED_TABLES` に載っており、**配布データに過去の行を
  // 1件も入れない**ため 0 になる(`D-V10-39` / `CM-G43`)。**他のテーブルは今日も同数である。**
  // **走査集合 `[...APP_SCOPED_KERNEL_TABLES, "apps"]` は1要素も狭めていない** ——
  // 狭めると「表を足し忘れても赤くならない」形に退化する(`V5-M0` §2-14 S3 の 4 の禁止)。
  expect(after).toEqual({ ...before, gp_comments: 0 });
  // 空のコピーで緑になっていないこと(検査の空回りを塞ぐ)。
  expect(after.changelog).toBeGreaterThan(0);
  expect(after.inbound_endpoints).toBeGreaterThan(0);
});

test("V5-M2-T02: 他アプリの依頼文の逐語が、出力の kernel.sqlite のバイト列に1回も現れない", () => {
  seedTwoApps();
  // 元のファイルには在る(検査が実際に読めていることの確認)。
  expect(readFileSync(kernelDbPath(sourceRoot)).includes(Buffer.from(OTHER_INTENT))).toBe(true);

  buildRunnerData({ sourceDataRoot: sourceRoot, targetDataRoot: targetRoot, appId: "shop" });

  // **削除済みページの残骸としても残らない** —— 空の DB へ1件分だけ流し込むためである。
  expect(readFileSync(kernelDbPath(targetRoot)).includes(Buffer.from(OTHER_INTENT))).toBe(false);
});

test("V5-M2-T02: 配るアプリのディレクトリだけが data/apps/ に置かれる", () => {
  seedTwoApps();

  buildRunnerData({ sourceDataRoot: sourceRoot, targetDataRoot: targetRoot, appId: "shop" });

  expect(existsSync(appManifestPath(targetRoot, "shop"))).toBe(true);
  expect(existsSync(appDbPath(targetRoot, "shop"))).toBe(true);
  expect(existsSync(join(targetRoot, "apps", "other"))).toBe(false);
});

test("V5-M2-T02: 実在しない app_id は throw で拒否し、出力を1バイトも作らない", () => {
  seedTwoApps();
  expect(() =>
    buildRunnerData({ sourceDataRoot: sourceRoot, targetDataRoot: targetRoot, appId: "missing" }),
  ).toThrow(/missing/);
  expect(existsSync(kernelDbPath(targetRoot))).toBe(false);
});

test("V5-M2-T02: 出力先に既に kernel.sqlite があるときは throw で拒否する(上書きしない)", () => {
  seedTwoApps();
  buildRunnerData({ sourceDataRoot: sourceRoot, targetDataRoot: targetRoot, appId: "shop" });
  expect(() =>
    buildRunnerData({ sourceDataRoot: sourceRoot, targetDataRoot: targetRoot, appId: "shop" }),
  ).toThrow(/kernel\.sqlite/);
});

// --- T03: 予約テーブルの投影(**確認だけ。実装は0バイト**)-----------------------------

test("V5-M2-T03: 出力の kernel.sqlite を投影元にすると _changelog に他アプリの行が1件も出ない", () => {
  seedTwoApps();

  // 元の投影は**全アプリ横断のまま**である(`ADR-0006` §6b の決定を書き換えていない)。
  const sourceRows = readRecordList(
    {
      dataRoot: sourceRoot,
      appDb: () => {
        throw new Error("appDb は呼ばれないはず");
      },
    },
    emptyManifest,
    "_changelog",
  );
  if (!sourceRows.ok) {
    throw new Error(`元の投影が読めなかった: ${JSON.stringify(sourceRows.errors)}`);
  }
  expect(new Set(sourceRows.value.map((row) => row.app_id))).toEqual(new Set(["shop", "other"]));

  buildRunnerData({ sourceDataRoot: sourceRoot, targetDataRoot: targetRoot, appId: "shop" });

  const targetRows = readRecordList(
    {
      dataRoot: targetRoot,
      appDb: () => {
        throw new Error("appDb は呼ばれないはず");
      },
    },
    emptyManifest,
    "_changelog",
  );
  if (!targetRows.ok) {
    throw new Error(`配布物の投影が読めなかった: ${JSON.stringify(targetRows.errors)}`);
  }
  expect(new Set(targetRows.value.map((row) => row.app_id))).toEqual(new Set(["shop"]));
  // 依頼文の逐語も出ない。
  expect(targetRows.value.map((row) => row.intent)).not.toContain(OTHER_INTENT);
  // 空で緑になっていないこと。
  expect(targetRows.value.length).toBeGreaterThan(0);
});

/**
 * **`V5-M5-T04` の追加**(`ADR-0251` 限定7)。
 *
 * `buildRunnerData` は出力先の `kernel.sqlite` を **DDL を張り直して新しく作る**
 * (「消してから配る」ではなく「空へ流し込む」を採ったため)。**新しく作った DB なので
 * `PRAGMA user_version` は 0 から始まる。** 刻まなければ、**組み立てた配布物そのものが
 * 起動時の版の照合を通らない**(2026-08-06 実測。`docs/plan/v5/records/v5-m5.md` §2)。
 *
 * **これは「印の無い DB の救済」ではない**(限定6)—— **この Runner が今この場で
 * 作った DB に、作った時点で刻んでいる。** `KernelMetaStore.open` が新規作成時にだけ
 * 刻むのと同じ規則である。
 *
 * **`app.sqlite` は刻み直さない。** あれは `cpSync` で元から複製されるものであり、
 * **元の版がそのまま運ばれる**(ヘッダのバイト列ごと複製されるため)。
 * したがって**印の無い既存アプリを配ろうとすると、出力の `app.sqlite` は 0 のままで
 * ゲートに止められる** —— それが `D-V5-13`(既存アプリは配布しない)の帰結である。
 */
test("V5-M5-T04: 組み立てた配布物の kernel.sqlite に Runner のビルド単位の版が刻まれる", () => {
  seedApp("shop");
  seedApp("other");
  buildRunnerData({ sourceDataRoot: sourceRoot, targetDataRoot: targetRoot, appId: "shop" });

  const db = new Database(kernelDbPath(targetRoot), { readonly: true });
  const userVersion = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  db.close();
  expect(userVersion?.user_version).toBe(RUNNER_BUILD_VERSION);
});

test("V5-M5-T04: 組み立てた配布物のボリューム全体が版の照合を通る", () => {
  seedApp("shop");
  seedApp("other");
  buildRunnerData({ sourceDataRoot: sourceRoot, targetDataRoot: targetRoot, appId: "shop" });

  const result = checkRunnerVersionGate(targetRoot);
  expect(result.mismatched.map((db) => `${db.label}=${db.user_version}`)).toEqual([]);
  expect(result.ok).toBe(true);
  // 空で緑になっていないこと(kernel.sqlite と app.sqlite の2本を見ている)。
  expect(result.checked.map((db) => db.label).sort()).toEqual([
    "apps/shop/app.sqlite",
    "kernel.sqlite",
  ]);
});

// ===========================================================================
// V5-M7f-T01 —— 版を上げて `--from` で組んだ器が、空のボリュームで起動しない件
// ===========================================================================

/**
 * **`CP-V5` の条件3 が名指しした欠落**(`docs/evidence/cp-v5.md` §5-8 の 1)。
 *
 * `buildRunnerData` は `kernel.sqlite` を新しく作って今日の版を刻む一方、
 * `app.sqlite` は `cpSync` で**元の印ごと**運んでいた。**版を上げてから `--from` で
 * 組み直すと、出力の `kernel.sqlite` は新しい版・`app.sqlite` は古い版になり、
 * 起動口がそれを空のボリュームへ撒いた瞬間に、自分のゲートに止められる。**
 *
 * ## この検査が「印の無い DB の救済」ではない理由
 *
 * **見ているのは「印が有るのに器の版と食い違っている」場合だけである。**
 * **印が無い(`user_version = 0`)ものは1バイトも書き換えない** ——
 * それは次の検査(`ADR-0251` 限定6)が固定する。
 *
 * ## 今日の版より「古い」印を作れない
 *
 * **`RUNNER_BUILD_VERSION` は今日 1 であり、1 より古い非0の印は存在しない。**
 * ゲートの判定は等値1本だけ(`ADR-0251` 限定4)で**向きを持たない**ので、
 * ここでは「今日の版と食い違う印」を別の値で作って同じ形を再現する。
 */
const STALE_STAMP = RUNNER_BUILD_VERSION + 1;

/** `PRAGMA user_version` を書き換える(元の `data/` を「別の版で作られた」状態にする)。 */
function stampSourceAppDb(appId: string, value: number): void {
  const db = new Database(appDbPath(sourceRoot, appId));
  db.exec(`PRAGMA user_version = ${value};`);
  db.close();
}

/** `PRAGMA user_version` を読む。 */
function readUserVersion(path: string): number {
  const db = new Database(path, { readonly: true });
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  db.close();
  return row?.user_version ?? 0;
}

test("V5-M7f-T01: 器の版と食い違う印を持つ app.sqlite は、焼くときに器の版へ刻み直される", () => {
  seedApp("shop");
  stampSourceAppDb("shop", STALE_STAMP);
  expect(readUserVersion(appDbPath(sourceRoot, "shop"))).toBe(STALE_STAMP);

  const result = buildRunnerData({
    sourceDataRoot: sourceRoot,
    targetDataRoot: targetRoot,
    appId: "shop",
  });

  expect(readUserVersion(appDbPath(targetRoot, "shop"))).toBe(RUNNER_BUILD_VERSION);
  expect(result.appDbUserVersion).toBe(RUNNER_BUILD_VERSION);
  expect(result.restampedAppDbFrom).toBe(STALE_STAMP);
  // **元の `data/` には1バイトも書かない**(`prepare-context` の doc の約束)。
  expect(readUserVersion(appDbPath(sourceRoot, "shop"))).toBe(STALE_STAMP);
});

test("V5-M7f-T01: 刻み直したあと、焼いたデータ全体が版の照合を通る(空のボリュームで起動する形)", () => {
  seedApp("shop");
  stampSourceAppDb("shop", STALE_STAMP);
  buildRunnerData({ sourceDataRoot: sourceRoot, targetDataRoot: targetRoot, appId: "shop" });

  const gate = checkRunnerVersionGate(targetRoot);
  expect(gate.mismatched.map((db) => `${db.label}=${db.user_version}`)).toEqual([]);
  expect(gate.ok).toBe(true);
  expect(gate.checked.map((db) => db.label).sort()).toEqual([
    "apps/shop/app.sqlite",
    "kernel.sqlite",
  ]);
});

/**
 * **`ADR-0251` 限定6(印の無い DB を救済しない)の履行。**
 *
 * **`V5-M7f-T01` は「器に焼くデータの印を正しく付ける」ことであって、
 * 「印が無いものを通す」ことではない。** その区別をここが機械で固定する。
 *
 * **`user_version = 0` の `app.sqlite` は刻み直されず、ゲートは今日どおり止める。**
 * **`docs/plan/v5/records/v5-m7.md` §1-2 が実測した「今日ディスクにある実アプリは
 * 1つもイメージに載せられなかった」は、本タスクのあとも成り立つ。**
 */
test("V5-M7f-T01: 印の無い app.sqlite は刻み直されず、ゲートが今日どおり止める(ADR-0251 限定6)", () => {
  seedApp("shop");
  stampSourceAppDb("shop", 0);

  const result = buildRunnerData({
    sourceDataRoot: sourceRoot,
    targetDataRoot: targetRoot,
    appId: "shop",
  });

  expect(readUserVersion(appDbPath(targetRoot, "shop"))).toBe(0);
  expect(result.appDbUserVersion).toBe(0);
  expect(result.restampedAppDbFrom).toBe(null);

  const gate = checkRunnerVersionGate(targetRoot);
  expect(gate.ok).toBe(false);
  expect(gate.mismatched.map((db) => `${db.label}=${db.user_version}`)).toEqual([
    "apps/shop/app.sqlite=0",
  ]);
});

test("V5-M7f-T01: 印が既に器の版と等しいときは刻み直したと報告しない", () => {
  seedApp("shop");

  const result = buildRunnerData({
    sourceDataRoot: sourceRoot,
    targetDataRoot: targetRoot,
    appId: "shop",
  });

  expect(result.appDbUserVersion).toBe(RUNNER_BUILD_VERSION);
  expect(result.restampedAppDbFrom).toBe(null);
});

// ===========================================================================
// V5-M7f-T02 —— 過去の控えを器から外す(D-V5-97。2026-08-06)
// ===========================================================================

/** 元の `data/` に過去の控えを2件置く(`ADR-0002` のレイアウトに従う)。 */
function seedSnapshots(appId: string): string[] {
  const names = ["0001-d-shop-001", "0002-d-shop-002"];
  for (const name of names) {
    const dir = join(appSnapshotsDir(sourceRoot, appId), name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), '{"app":{"id":"shop"}}');
    writeFileSync(join(dir, "app.sqlite"), "PAST-STATE-SECRET-4d1f");
  }
  return names;
}

/**
 * **`D-V5-97`(ユーザ決定。2026-08-06)の履行。**
 *
 * **配る器に `apps/<id>/snapshots/` を入れない。** 入れると、開発中に消したレコードを
 * 含む**そのアプリの過去の全状態**が配布先に渡る(`docs/plan/v5/records/v5-m2.md` §4-1 の 1)。
 *
 * **代償**: **配った先で「配る前の状態に戻す」ことはできなくなる。**
 */
test("V5-M7f-T02: 焼いたデータに過去の控えが1件も入らない(D-V5-97)", () => {
  seedApp("shop");
  const names = seedSnapshots("shop");
  // 元には在ることを先に確かめる(空で緑になっていないこと)。
  expect(readdirSync(appSnapshotsDir(sourceRoot, "shop")).sort()).toEqual(names);

  const result = buildRunnerData({
    sourceDataRoot: sourceRoot,
    targetDataRoot: targetRoot,
    appId: "shop",
  });

  expect(existsSync(appSnapshotsDir(targetRoot, "shop"))).toBe(false);
  expect(result.excludedSnapshots).toBe(names.length);
  // 過去の状態のバイト列が、焼いたアプリディレクトリのどこにも残っていない。
  const leaked = readdirSync(appDir(targetRoot, "shop"), { recursive: true }) as string[];
  expect(leaked).not.toContain("snapshots");
  // 定義とデータそのものは今日どおり運ばれる(控えだけを外した)。
  expect(existsSync(appDbPath(targetRoot, "shop"))).toBe(true);
  expect(existsSync(appManifestPath(targetRoot, "shop"))).toBe(true);
  // 元の `data/` の控えは1件も消していない。
  expect(readdirSync(appSnapshotsDir(sourceRoot, "shop")).sort()).toEqual(names);
});

test("V5-M7f-T02: 控えが元に1件も無いときは 0 と報告する", () => {
  seedApp("shop");
  const result = buildRunnerData({
    sourceDataRoot: sourceRoot,
    targetDataRoot: targetRoot,
    appId: "shop",
  });
  expect(result.excludedSnapshots).toBe(0);
});

// --- V10-M30-T01: 配布データがコメント表示設定の列2本を引き継ぐ ---------------------

/**
 * `ADR-0377` §Consequences が「配布データ生成は列の追加を1バイトの変更もなく引き継ぐ
 * **見込み**である —— 見込みであって、測っていない」と書いた点の実測
 * (`V10-M30-T01` = `CM-G36`)。**測るのは `V10-M30-T01` である**(同 §この決定の限界 5)。
 *
 * **冒頭の但し書きとの関係を先に書く。** 本ファイルの冒頭は「`skippedTables` の中身を
 * assert していない」と述べている。理由は `V5-M0` §2-14 S3 の 4 =「**次に足し忘れたら
 * 赤くなる検査を1本も作らない**」である。下の2本は**その禁止に当たらない** ——
 * 見ているのは `apps`(単一ソースの外にある固定の表)と、この検査が自分で作った表だけで
 * あり、**`kernel.sqlite` に新しい横断テーブルが増えて `APP_SCOPED_KERNEL_TABLES` へ
 * 足し忘れても、この2本は赤くならない。** 走査対象を `sqlite_master` に広げてもいない。
 */
test("V10-M30-T01: skippedTables に apps が入らない(陽性対照つき)", () => {
  seedTwoApps();
  // **陽性対照** —— 単一ソースにも `apps` にも入らない表を1本だけ手で足す。
  // これが `skippedTables` に出ることで、「常に空だから apps も入らない」空回りを塞ぐ。
  const db = new Database(kernelDbPath(sourceRoot), { readwrite: true });
  try {
    db.exec(`CREATE TABLE "not_app_scoped_probe" ("k" TEXT PRIMARY KEY)`);
  } finally {
    db.close();
  }

  const result = buildRunnerData({
    sourceDataRoot: sourceRoot,
    targetDataRoot: targetRoot,
    appId: "shop",
  });

  expect(result.skippedTables).toContain("not_app_scoped_probe");
  expect(result.skippedTables).not.toContain("apps");
  // `apps` が実際にコピー対象だったことも併せて固定する(「入らない」の裏側)。
  expect(result.copiedRows.apps).toBe(1);
});

test("V10-M30-T01: 配布データの apps 表に設定の列2本が在り、倒した値が保たれる", () => {
  seedTwoApps();
  const store = KernelMetaStore.open(sourceRoot);
  try {
    // **書く=true / 読む=false** —— 片側だけを倒す(1本の列に畳んだ実装ならここで割れる)。
    store.setCommentVisibility("shop", { write: true, read: false });
    // 配らない側は両方 true にしておく。**出力に混ざれば別の検査(他アプリ0件)が拾う。**
    store.setCommentVisibility("other", { write: true, read: true });
  } finally {
    store.close();
  }

  buildRunnerData({ sourceDataRoot: sourceRoot, targetDataRoot: targetRoot, appId: "shop" });

  const out = new Database(kernelDbPath(targetRoot), { readonly: true });
  try {
    const columns = out
      .query<{ name: string }, []>(`PRAGMA table_info("apps")`)
      .all()
      .map((row) => row.name);
    expect(columns).toContain("comment_write_enabled");
    expect(columns).toContain("comment_read_enabled");
    expect(
      out
        .query<{ app_id: string; comment_write_enabled: number; comment_read_enabled: number }, []>(
          `SELECT "app_id", "comment_write_enabled", "comment_read_enabled" FROM "apps"`,
        )
        .all(),
    ).toEqual([{ app_id: "shop", comment_write_enabled: 1, comment_read_enabled: 0 }]);
  } finally {
    out.close();
  }
});

// --- V10-M33-T02: 配布データに過去のコメントの行を1件も入れない ----------------------

/**
 * 配った先のコンテナに焼かれる `kernel.sqlite` に、**元の環境で書かれたコメントの行を
 * 1件も入れない**(`D-V10-39` / `CM-G43` / `V10-M33-T02`)。
 *
 * **冒頭の但し書きとの関係を先に書く。** 本ファイルの冒頭は「`skippedTables` の中身を
 * assert していない」と述べている。理由は `V5-M0` §2-14 S3 の 4 =「**次に足し忘れたら
 * 赤くなる検査を1本も作らない**」である。下の1本は**その禁止に当たらない** ——
 * 見ているのは `RUNNER_EXCLUDED_TABLES` に名指しで載っている固定の1本(`gp_comments`)
 * だけであり、**`kernel.sqlite` に新しい横断テーブルが増えて `APP_SCOPED_KERNEL_TABLES`
 * へ足し忘れても、この1本は赤くならない。** 走査対象を `sqlite_master` に広げてもいない
 * (`sqlite_master` は「`gp_comments` という名の表が在るか」を1点だけ引くのに使う)。
 *
 * **口は閉じない。** 表そのものは DDL を張るので配布データにも存在する ——
 * 配った先で新しくコメントを書けることが `D-V10-38` の土台であり、表ごと落とすと
 * `no such table` で書き込みが落ちる。**外すのは行のコピーだけである。**
 */
test("V10-M33-T02: 配布データの gp_comments が0行になる(表は在る。陽性対照つき)", () => {
  seedTwoApps();
  // **陽性対照** —— 元の `kernel.sqlite` には、配るアプリ(`shop`)宛てのコメントが実在する。
  // ここが 0 だと「元から無いから 0 になった」空回りで緑になる。
  const ownBefore =
    countRows(sourceRoot, "gp_comments") - countForeignRows(sourceRoot, "gp_comments", "shop");
  expect(ownBefore).toBeGreaterThan(0);

  const result = buildRunnerData({
    sourceDataRoot: sourceRoot,
    targetDataRoot: targetRoot,
    appId: "shop",
  });

  // 1. 行は1件も入らない。
  expect(countRows(targetRoot, "gp_comments")).toBe(0);
  // 2. **表そのものは在る**(口を閉じていない。`D-V10-38` の土台)。
  const out = new Database(kernelDbPath(targetRoot), { readonly: true });
  try {
    expect(
      out
        .query<{ name: string }, [string]>(
          `SELECT "name" FROM "sqlite_master" WHERE "type" = 'table' AND "name" = ?`,
        )
        .all("gp_comments")
        .map((row) => row.name),
    ).toEqual(["gp_comments"]);
  } finally {
    out.close();
  }
  // 3. 報告に載る。**陽性対照** —— コピーした `apps` は載らない(「常に全部載る」を塞ぐ)。
  expect(result.skippedTables).toContain("gp_comments");
  expect(result.skippedTables).not.toContain("apps");
  // 4. コピー対象の集計にも現れない(`copiedRows` に 0 行として載せていない)。
  expect(Object.keys(result.copiedRows)).not.toContain("gp_comments");
});
