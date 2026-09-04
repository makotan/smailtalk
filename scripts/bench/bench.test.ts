/**
 * ベンチマーク基盤の検査(V1-M1-T05)。
 *
 * **時間は検査しない。** 時間は環境依存で再現しないので、テストの主張にできない。
 * ここで検査するのは**再現性の土台**である:
 *
 * 1. 乱数が決定的であること(同じシード → 同じ列)
 * 2. 同じシードで作った DB が**バイト単位で同じ**であること(= ディスク量の数値が再現する)
 * 3. SQL プローブがカーネル内部の発行を実際に捕まえられること
 *    (`src/` を触らずに数える、という測定方法そのものの前提)
 * 4. プローブが差し替えたプロトタイプを必ず戻すこと(戻し忘れは後続の測定を汚染する)
 * 5. CLI 引数の解釈
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { applyDiff, takeSnapshot } from "../../src/kernel/index.ts";
import { buildApp, layer2Diff } from "./fixture.ts";
import { summarizeTimings } from "./measure.ts";
import { withSqlProbe } from "./probe.ts";
import { Rng } from "./rng.ts";
import { biomeBinPath, formatWithBiome, parseArgs } from "./run.ts";
import {
  contentionScenario,
  crossProcessContentionScenario,
  runLoadCase,
  runReadCase,
  runReportCases,
  snapshotSizeScenario,
} from "./scenarios.ts";

/**
 * 公開単位の根(`apps/smailtalk/`)。**このファイルは `run.ts` と同じディレクトリ**
 * (`apps/smailtalk/scripts/bench/`)に在るので、`import.meta.dir` から2つ上げれば
 * `biomeBinPath()` 自身が使うのと同じ段数で同じ場所に着く。**リテラルの
 * "apps"/"smailtalk" を書かない** —— 切り出した木では公開単位そのものが木の根に
 * なり、ディレクトリ名が "apps/smailtalk" のままとは限らないため、名前ではなく
 * 段数(構造)で在り処を固定する。
 */
const PRODUCT_ROOT = join(import.meta.dir, "..", "..");

function withRoot<T>(body: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "gp-bench-test-"));
  try {
    return body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * **`V9-M3-T01`(群D)で立てた検査を、`X-G29` で逆向きに固定し直す。**
 *
 * 当時(`V9-M3-T01`)の「正しい在り処」は**正本のルート**の `node_modules/.bin/biome`
 * だった(`bunfig.toml` の `linker = "hoisted"` で依存が巻き上がるため)。だから
 * 当時の下の1本目の検査は「**公開単位の中**(`apps/smailtalk/node_modules`)を
 * 掴んでしまう取り違え」を禁じていた —— `not.toContain(join("apps","smailtalk","node_modules"))`。
 *
 * **今日は禁じる向きが逆になった(`X-G29`)。** 公開単位(`apps/smailtalk/`)は
 * 自分より上を1度も見に行ってはならず、「正しい在り処」は**公開単位自身**の
 * `apps/smailtalk/node_modules/.bin/biome` である。したがって止めるべき取り違えも
 * 逆になった —— **公開単位の外(正本のルート)を掴んでしまうこと**を禁じる。
 * 下の1本目は行を消さず、`not.toContain` → 公開単位の根(`PRODUCT_ROOT`)配下である
 * ことを求める形へ反転して書き換えた(`run.test.ts:130`-`:131` に当てたのと同じ作法)。
 * **`"apps"`/`"smailtalk"` のリテラルは使わない** —— 切り出した木では公開単位が
 * 木の根そのものになり、ディレクトリ名がその文字列のままとは限らないため。
 *
 * **実在の扱いも変えた。** `V9-M3-T01` 時点は「見つからなければ検査が赤くなる
 * (`bun install` を促す)」だったが、それは正本のルートの `node_modules` の実在を
 * 前提にしていた。**この開発ツリー(growable_platform 直下)では今日、
 * `apps/smailtalk/node_modules` 自体が作られない**(ルート `bunfig.toml` の
 * `linker = "hoisted"` により依存が正本のルートへ巻き上がるため)。**存在しない
 * ことが、今日ここでは正しい状態になり得る。** 一律に「実在すること」を要求する
 * とこの開発ツリーで恒常的に赤くなってしまうので、下の2本目は在り処の実在で
 * 分岐し、**実在すれば実際に整形が走ったことを、実在しなければ `run.ts` 側が
 * 黙ってではなく stderr へ警告してから飛ばしたことを、そのつど実測して固定する。**
 * **「整形はいつも動く」とは書かない** —— この開発ツリーでは動かないことがある。
 */
describe("bench: 整形器(biome)の在り処", () => {
  test("公開単位の根(apps/smailtalk/)配下の node_modules/.bin/biome を指し、外(正本のルート)を掴んでいない", () => {
    const biome = biomeBinPath();
    expect(biome.endsWith(join("node_modules", ".bin", "biome"))).toBe(true);
    // X-G29: 禁じる取り違えは「公開単位の外(正本のルート)を掴むこと」に反転した。
    // 逆に「公開単位の根(PRODUCT_ROOT)配下を掴む」のが今日の正解である
    // (biomeBinPath() 自身と同じ段数=2つ上げで作った PRODUCT_ROOT と突き合わせる)。
    expect(biome.startsWith(PRODUCT_ROOT + sep)).toBe(true);
  });

  test("在り処が実在すれば実際に整形が走り、実在しなければ黙ってではなく警告して整形を飛ばす", () => {
    const biome = biomeBinPath();
    const written: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    // biome の有無で分岐が変わるので、その場で書かれる stderr を実測で捕まえる。
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      written.push(chunk.toString());
      return true;
    }) as typeof process.stderr.write;
    const tmp = mkdtempSync(join(tmpdir(), "gp-bench-biome-test-"));
    const file = join(tmp, "sample.json");
    try {
      writeFileSync(file, '{\n  "a": [\n    1,\n    2\n  ]\n}\n', "utf-8");
      formatWithBiome(file);
    } finally {
      process.stderr.write = originalWrite;
    }
    try {
      if (existsSync(biome)) {
        // 実在するなら、整形が実際に走ったことを結果ファイルで確かめる
        // (biome は 100 桁に収まる配列を1行に畳む。素の JSON.stringify は畳まない)。
        const formatted = readFileSync(file, "utf-8");
        expect(formatted).toContain('"a": [1, 2]');
        expect(written.join("")).toBe("");
      } else {
        // 実在しないなら、黙って帰ったのではなく、警告が実際に出たことを確かめる。
        // (この開発ツリーでは今日、apps/smailtalk/node_modules が無いのでここを通る。)
        expect(written.some((line) => line.includes(biome))).toBe(true);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("Rng: 決定的であること", () => {
  test("同じシードなら同じ列が出る", () => {
    const s1 = new Rng(7);
    const s2 = new Rng(7);
    const seq1 = Array.from({ length: 50 }, () => s1.next());
    const seq2 = Array.from({ length: 50 }, () => s2.next());
    expect(seq1).toEqual(seq2);
  });

  test("違うシードなら違う列が出る", () => {
    const s1 = new Rng(7);
    const s2 = new Rng(8);
    const seq1 = Array.from({ length: 50 }, () => s1.next());
    const seq2 = Array.from({ length: 50 }, () => s2.next());
    expect(seq1).not.toEqual(seq2);
  });

  test("値域は [0,1)", () => {
    const rng = new Rng(1234);
    for (let i = 0; i < 1000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("fixture: 同じシードなら同じ DB ができる", () => {
  test("app.sqlite の中身がバイト単位で一致する(ディスク量の数値が再現する根拠)", () => {
    const digest = (seed: number): string =>
      withRoot((root) => {
        const app = buildApp({
          dataRoot: root,
          appId: "a",
          tables: 1,
          rowsPerTable: 200,
          seed,
        });
        // VACUUM INTO 経由のコピーを取ることで、ページの空きなどの差を落とす。
        const snap = takeSnapshot(root, app.app_id, "d-t");
        const bytes = readFileSync(join(snap.dir, "app.sqlite"));
        return Bun.SHA256.hash(bytes, "hex");
      });

    expect(digest(42)).toBe(digest(42));
    expect(digest(42)).not.toBe(digest(43));
  });
});

describe("probe: カーネル内部の SQL を数えられること", () => {
  test("takeSnapshot が撃つ VACUUM INTO を1回として捕まえる", () => {
    withRoot((root) => {
      buildApp({ dataRoot: root, appId: "p", tables: 1, rowsPerTable: 10, seed: 1 });
      const { probe } = withSqlProbe(() => takeSnapshot(root, "p", "d-p"));
      expect(probe.counts.vacuum_into).toBe(1);
      expect(probe.events[0]?.filename.endsWith("app.sqlite")).toBe(true);
    });
  });

  test("層2 の apply でテーブル再構築を捕まえる", () => {
    withRoot((root) => {
      buildApp({ dataRoot: root, appId: "p", tables: 1, rowsPerTable: 10, seed: 1 });
      const { probe } = withSqlProbe(() => {
        const r = applyDiff(root, "p", layer2Diff("d-l2", "t1"));
        expect(r.valid).toBe(true);
      });
      expect(probe.counts.rebuild_create).toBe(1);
      expect(probe.counts.rebuild_insert).toBe(1);
    });
  });

  test("差し替えたプロトタイプを必ず戻す(例外時も)", () => {
    const before = Database.prototype.query;
    expect(() =>
      withSqlProbe(() => {
        throw new Error("わざと落とす");
      }),
    ).toThrow("わざと落とす");
    expect(Database.prototype.query).toBe(before);
  });
});

describe("measure: 要約", () => {
  test("中央値・最小・最大", () => {
    const t = summarizeTimings([3, 1, 2]);
    expect(t.median_ms).toBe(2);
    expect(t.min_ms).toBe(1);
    expect(t.max_ms).toBe(3);
    expect(t.samples_ms).toEqual([3, 1, 2]);
  });

  test("サンプル0件は誤りなので例外にする", () => {
    expect(() => summarizeTimings([])).toThrow();
  });
});

describe("run: CLI 引数", () => {
  test("既定値", () => {
    const args = parseArgs([]);
    expect(args.only).toEqual([
      "snapshot",
      "mutation",
      "copies",
      "journal",
      "contention",
      "xproc",
      "snapshot_size",
      "load",
      "read",
      // --- V8-M10-T07(集計表の性能。台帳 `Q-G34`)で足した10本目 ---
      "report",
    ]);
    expect(args.reps).toBe(3);
  });

  test("--only / --reps / --seed", () => {
    const args = parseArgs(["--only=copies,journal", "--reps=5", "--seed=1"]);
    expect(args.only).toEqual(["copies", "journal"]);
    expect(args.reps).toBe(5);
    expect(args.seed).toBe(1);
  });

  test("未知のシナリオ名は黙って無視せず落とす", () => {
    expect(() => parseArgs(["--only=nope"])).toThrow("未知のシナリオ");
  });

  test("--reps に0以下や非整数を渡したら落とす", () => {
    expect(() => parseArgs(["--reps=0"])).toThrow();
    expect(() => parseArgs(["--reps=abc"])).toThrow();
  });

  test("V1-M9-T03 のシナリオ名を受け付ける", () => {
    const args = parseArgs(["--only=contention,xproc,snapshot_size"]);
    expect(args.only).toEqual(["contention", "xproc", "snapshot_size"]);
  });
});

// --- V1-M9-T03(WAL とスナップショットの相互作用の計測)の検査 --------------
//
// **時間は検査しない**(環境依存)。検査するのは「直列化点が現れるか否か」という
// 決定的な**質的挙動**である —— これは journal_mode とロック種で決まり、再現する。

describe("contention: 書込中の読取ブロックの質的挙動(直列化点)", () => {
  test("DELETE + 排他ロック中の読取は SQLITE_BUSY(直列化点が現れる)", () => {
    const cases = contentionScenario(2, 42);
    const c = cases.find(
      (x) => x.journal_mode === "delete" && x.writer_lock === "exclusive" && x.reader_op === "read",
    );
    expect(c).toBeDefined();
    expect(c?.busy).toBe(true);
    expect(c?.busy_stable).toBe(true);
    expect(c?.effective_journal_mode).toBe("delete");
  });

  test("WAL では排他ロック中でも読取は成功する(直列化点が現れない)", () => {
    const cases = contentionScenario(2, 42);
    const c = cases.find(
      (x) => x.journal_mode === "wal" && x.writer_lock === "exclusive" && x.reader_op === "read",
    );
    expect(c).toBeDefined();
    expect(c?.busy).toBe(false);
    expect(c?.ok).toBe(true);
    expect(c?.effective_journal_mode).toBe("wal");
  });

  test("DELETE + 書き込み中(RESERVED)の読取は成功する(ブロックはコミット窓に限られる)", () => {
    const cases = contentionScenario(2, 42);
    const c = cases.find(
      (x) => x.journal_mode === "delete" && x.writer_lock === "immediate" && x.reader_op === "read",
    );
    expect(c).toBeDefined();
    expect(c?.busy).toBe(false);
    expect(c?.ok).toBe(true);
  });

  test("書き手同士は DELETE でも WAL でも直列化する(SQLITE_BUSY)", () => {
    const cases = contentionScenario(2, 42);
    for (const mode of ["delete", "wal"] as const) {
      const c = cases.find((x) => x.journal_mode === mode && x.reader_op === "write");
      expect(c?.busy).toBe(true);
    }
  });
});

describe("xproc: 別プロセスの書き手との本物の待ち", () => {
  test("DELETE / WAL とも最終的に読取は成功する", () => {
    const cases = crossProcessContentionScenario(1, 42);
    for (const c of cases) {
      expect(c.read_succeeded).toBe(true);
    }
  }, 20_000);
});

describe("snapshot_size: DELETE / WAL のスナップショット", () => {
  test("小さいケースで effective モードが一致しスナップショットが生成される", () => {
    const rows = snapshotSizeScenario(1, 42, [{ target_mb: 0, rows: 300 }]);
    expect(rows.length).toBe(2);
    const del = rows.find((r) => r.journal_mode === "delete");
    const wal = rows.find((r) => r.journal_mode === "wal");
    expect(del?.effective_journal_mode).toBe("delete");
    expect(wal?.effective_journal_mode).toBe("wal");
    expect(del?.snapshot_bytes ?? 0).toBeGreaterThan(0);
    expect(wal?.snapshot_bytes ?? 0).toBeGreaterThan(0);
  }, 20_000);
});

// --- V1-M3-T06(負荷試験 load)の検査 ----------------------------------------
//
// **時間(throughput)は検査しない**(環境依存で再現しない)。検査するのは
// 決定的な**質的不変量**である —— SQLITE_BUSY(=HTTP500相当)が現れるか否か、
// 会計(commit+busy+cas_conflict+other === attempted)が合うか、である。
// これらは journal_mode / begin モード / row_space で決まり、再現する。
//
// 各テストは `runLoadCase`(単一ケース)を小さい N/ops で直接呼ぶ。フル sweep は
// run.ts 実行時のみ(重い sweep をテストに入れない)。全体で 60 秒以内が目安。

describe("V1-M3-T06 load: 負荷試験の質的不変量", () => {
  test("A: insert/deferred/own/same_app/bt=0 は SQLITE_BUSY が現れる(現行 config の脆さ)", async () => {
    const c = await runLoadCase({
      scope: "same_app",
      op: "insert",
      begin: "deferred",
      row_space: "own",
      journal_mode: "delete",
      busy_timeout_ms: 0,
      writers: 4,
      ops_per_writer: 100,
      seed: 42,
    });
    expect(c.busy_total).toBeGreaterThan(0);
    expect(c.accounting_ok).toBe(true);
    expect(c.attempted_total).toBe(4 * 100);
  }, 40_000);

  test("B: update/deferred/own/same_app/bt=5000 は timeout でも救えない(lock-upgrade デッドロック)", async () => {
    const c = await runLoadCase({
      scope: "same_app",
      op: "update",
      begin: "deferred",
      row_space: "own",
      journal_mode: "delete",
      busy_timeout_ms: 5000,
      writers: 6,
      ops_per_writer: 120,
      seed: 42,
    });
    // R1: deferred の read-then-upgrade は busy_timeout>0 でもデッドロックで SQLITE_BUSY を出す。
    expect(c.busy_total).toBeGreaterThan(0);
    // own = writer ごとに別行なので版衝突は起きない。
    expect(c.cas_conflict_total).toBe(0);
    expect(c.accounting_ok).toBe(true);
  }, 60_000);

  test("B': update/immediate/own/same_app/bt=5000 は IMMEDIATE が解消する(busy=0・全 commit)", async () => {
    const writers = 4;
    const ops = 60;
    const c = await runLoadCase({
      scope: "same_app",
      op: "update",
      begin: "immediate",
      row_space: "own",
      journal_mode: "delete",
      busy_timeout_ms: 5000,
      writers,
      ops_per_writer: ops,
      seed: 42,
    });
    expect(c.busy_total).toBe(0);
    expect(c.cas_conflict_total).toBe(0);
    expect(c.commit_total).toBe(writers * ops);
    expect(c.accounting_ok).toBe(true);
  }, 40_000);

  test("D: update/immediate/own/different_apps/bt=5000 は 1app1file で線形(busy=0・全 commit)", async () => {
    const writers = 4;
    const ops = 60;
    const c = await runLoadCase({
      scope: "different_apps",
      op: "update",
      begin: "immediate",
      row_space: "own",
      journal_mode: "delete",
      busy_timeout_ms: 5000,
      writers,
      ops_per_writer: ops,
      seed: 42,
    });
    expect(c.busy_total).toBe(0);
    expect(c.commit_total).toBe(writers * ops);
    expect(c.accounting_ok).toBe(true);
  }, 40_000);

  test("出力スキーマ: 必須キーが存在し型が正しい", async () => {
    const c = await runLoadCase({
      scope: "same_app",
      op: "update",
      begin: "immediate",
      row_space: "own",
      journal_mode: "delete",
      busy_timeout_ms: 5000,
      writers: 2,
      ops_per_writer: 20,
      seed: 42,
    });
    expect(typeof c.label).toBe("string");
    expect(c.scope).toBe("same_app");
    expect(c.op).toBe("update");
    expect(c.begin).toBe("immediate");
    expect(c.row_space).toBe("own");
    expect(c.journal_mode).toBe("delete");
    expect(typeof c.busy_timeout_ms).toBe("number");
    expect(typeof c.writers).toBe("number");
    expect(typeof c.ops_per_writer).toBe("number");
    expect(typeof c.commit_total).toBe("number");
    expect(typeof c.busy_total).toBe("number");
    expect(typeof c.cas_conflict_total).toBe("number");
    expect(typeof c.other_total).toBe("number");
    expect(typeof c.attempted_total).toBe("number");
    expect(typeof c.accounting_ok).toBe("boolean");
    expect(typeof c.elapsed_ms_max).toBe("number");
    expect(typeof c.throughput_commits_s).toBe("number");
  }, 40_000);
});

// V1-M9-T01 判断ゲートの read パス実測。質的不変量(全件返却・payload の決定性・
// スキーマ)だけをテストで固定する。時間(_ms)は環境依存なので検査しない。
// フル sweep(10万件・100アプリ)はテストに入れない —— run.ts 実行時のみ。
describe("V1-M9-T01 read: 全件返却の質的不変量", () => {
  test("user 経路は LIMIT が効かず全件を返す(record_count === 行数)", () => {
    const c = runReadCase({ path: "user", scale: 200, reps: 2, seed: 42 });
    expect(c.record_count).toBe(200);
    expect(c.path).toBe("user");
    expect(c.scale).toBe(200);
  }, 40_000);

  test("payload_bytes は行数に単調増加し、同一シードで決定的", () => {
    const small = runReadCase({ path: "user", scale: 100, reps: 2, seed: 42 });
    const large = runReadCase({ path: "user", scale: 400, reps: 2, seed: 42 });
    expect(large.payload_bytes).toBeGreaterThan(small.payload_bytes);
    // 決定的: 同じ scale/seed で2回呼ぶと payload_bytes と record_count が一致する。
    const again = runReadCase({ path: "user", scale: 100, reps: 2, seed: 42 });
    expect(again.payload_bytes).toBe(small.payload_bytes);
    expect(again.record_count).toBe(small.record_count);
  }, 40_000);

  test("システムテーブル経路(_apps / _changelog)も全件を返す", () => {
    const apps = runReadCase({ path: "_apps", scale: 5, reps: 2, seed: 42 });
    // 5 アプリ作ったので _apps は 5 行。
    expect(apps.record_count).toBe(5);
    const changelog = runReadCase({ path: "_changelog", scale: 5, reps: 2, seed: 42 });
    // 各アプリ createApp + applyDiff = 2 行 → 5 アプリで 10 行。
    expect(changelog.record_count).toBe(10);
    expect(changelog.payload_bytes).toBeGreaterThan(0);
  }, 40_000);

  test("出力スキーマ: 必須キーと型", () => {
    const c = runReadCase({ path: "user", scale: 50, reps: 2, seed: 42 });
    expect(typeof c.label).toBe("string");
    expect(typeof c.record_count).toBe("number");
    expect(typeof c.payload_bytes).toBe("number");
    expect(Array.isArray(c.list_ms.samples_ms)).toBe(true);
    expect(Array.isArray(c.serialize_ms.samples_ms)).toBe(true);
    expect(typeof c.list_ms.median_ms).toBe("number");
  }, 40_000);
});

// --- V8-M10-T07(集計表の性能。台帳 `Q-G34`)の検査 -------------------------
//
// **時間は1つも検査しない**(環境依存)。ここで固定するのは**測定の前提**である ——
// **「post-filter の掛かる分岐と掛からない分岐を比べてよい」と言えるための条件**は、
// **2つの分岐が同じ行数を読み、同じ大きさの母集団を作っていること**であり、
// それは決定的である。**小さい行数(20行)で回すので、フル sweep(1,000 / 10,000行)は
// テストに入れない** —— run.ts 実行時のみ。
describe("V8-M10-T07 report: 測定の前提(比べてよいことの条件)", () => {
  test("post-filter の掛かる3分岐が同じ母集団を作る(だから時間差を post-filter の差と読める)", async () => {
    const cases = await runReportCases({ rows: 20, reps: 1 });
    const pick = (label: string) => cases.find((c) => c.label === `${label}/rows=20`);
    const unfiltered = pick("single/unfiltered");
    const conditional = pick("single/role_conditional");
    const scoped = pick("single/owner_scoped");
    expect(unfiltered?.population).toBe("unfiltered");
    expect(conditional?.population).toBe("role_conditional");
    expect(scoped?.population).toBe("owner_scoped");
    // **3件とも 200 で、母集団の件数が 20 で一致する。**
    expect([unfiltered?.status, conditional?.status, scoped?.status]).toEqual([200, 200, 200]);
    expect([unfiltered?.total_count, conditional?.total_count, scoped?.total_count]).toEqual([
      20, 20, 20,
    ]);
  }, 60_000);

  test("読む表の数が宣言どおり(単表1 / 結合2 / 5表結合5)", async () => {
    const cases = await runReportCases({ rows: 20, reps: 1 });
    const of = (label: string) => cases.find((c) => c.label === `${label}/rows=20`);
    expect(of("single/unfiltered")?.tables_read).toBe(1);
    expect(of("join_forward/unfiltered")?.tables_read).toBe(2);
    expect(of("join_reverse/unfiltered")?.tables_read).toBe(2);
    expect(of("five_tables/unfiltered")?.tables_read).toBe(5);
    // **5表 × 20行 = 100行を読む**(`scanned_rows` は表の数 × 行数で機械的に決まる)。
    expect(of("five_tables/unfiltered")?.scanned_rows).toBe(100);
    // **順方向は行が増えず、逆方向は 1:1 なので同じ 20 件になる**(この台では)。
    expect(of("join_forward/unfiltered")?.total_count).toBe(20);
    expect(of("join_reverse/unfiltered")?.total_count).toBe(20);
  }, 60_000);

  test("応答のバイト数は同じ行数なら決定的(行IDを36文字で決定的に振っている)", async () => {
    const first = await runReportCases({ rows: 20, reps: 1 });
    const second = await runReportCases({ rows: 20, reps: 1 });
    const bytesOf = (cases: Awaited<ReturnType<typeof runReportCases>>) =>
      cases.map((c) => `${c.label}:${c.payload_bytes}:${c.total_groups}`);
    expect(bytesOf(second)).toEqual(bytesOf(first));
    // `group_by: _id` は群が行数と同じになる(上限ちょうどを測る形)。
    expect(first.find((c) => c.label === "group_by_id/unfiltered/rows=20")?.total_groups).toBe(20);
  }, 60_000);
});
