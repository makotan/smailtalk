import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityStore } from "./capability-store.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { resolveSecret } from "./secret-resolver.ts";
import { kernelDbPath } from "./storage-paths.ts";

/**
 * secret 漏えい検査テスト(V1-M4-T02 完了条件 / ADR-0020 §2d・§8c-6)。
 *
 * 「secret の解決値がどの保存面にも現れない」ことを直接証明する。
 * 主たる保証は assert 2: kernel.sqlite をバイナリで読み、センチネル値が
 * 1バイトも含まれないこと(= at-rest に secret 値が無い)。
 *
 * connection は取得元(env 変数名 / コマンド文字列)への参照だけを保存する。
 * env 経路: 解決値(センチネル)は DB に一切現れず、返り値だけが値を持つ。
 * command 経路: コマンド文字列は保存されるが、それは「参照」であって解決値ではない
 *   (この点はコマンドケースのコメントで明記。主保証は env 経路の assert 2)。
 */
describe("capability secret leak", () => {
  const varName = "ST_LEAK_TEST_SECRET";
  let dataRoot: string;
  let store: CapabilityStore;
  let sentinel: string;

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "gp-capability-leak-"));
    store = CapabilityStore.openForKernel(dataRoot);
    // テスト内で動的生成したセンチネル値。DB のどこにも現れてはならない。
    sentinel = `SENTINEL-${crypto.randomUUID()}`;
    process.env[varName] = sentinel;
  });

  afterEach(async () => {
    store.close();
    delete process.env[varName];
    await rm(dataRoot, { recursive: true, force: true });
  });

  test("env 経路: 解決値は保存面(DB)に一切現れず、参照だけが保存される", async () => {
    const created = store.createConnection({
      appId: "leak-app",
      name: "leak-conn",
      allowedHosts: [],
      secretSource: { kind: "env", value: varName },
    });

    // assert 1: getConnection が返す secretSource.value は「変数名」であってセンチネル値ではない。
    const fetched = store.getConnection(created.id);
    expect(fetched?.secretSource).toEqual({ kind: "env", value: varName });
    expect(fetched?.secretSource.value).toBe(varName);
    expect(fetched?.secretSource.value).not.toBe(sentinel);

    // assert 2(主保証): kernel.sqlite をバイナリとして読み、センチネル値が1バイトも無い。
    // WAL 併用のため、-wal / -shm も含めて走査する。
    store.close();
    const dbPath = kernelDbPath(dataRoot);
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      let bytes: Buffer;
      try {
        bytes = readFileSync(file);
      } catch {
        continue; // -wal / -shm は存在しないことがある。
      }
      expect(bytes.includes(Buffer.from(sentinel, "utf8"))).toBe(false);
    }
    // 以後のテストで再利用しないよう開き直す(afterEach の close() を二重にしない)。
    store = CapabilityStore.openForKernel(dataRoot);

    // assert 3: resolveSecret はセンチネル値を返す(利用は機能する)。返り値だけが値を持つ。
    const resolved = await resolveSecret({ kind: "env", value: varName });
    expect(resolved).toBe(sentinel);
  });

  test("assert 4: connection 作成は changelog に記録されない", () => {
    store.createConnection({
      appId: "leak-app",
      name: "leak-conn",
      allowedHosts: [],
      secretSource: { kind: "env", value: varName },
    });

    // KernelMetaStore の全 changelog にセンチネルも connection 情報も現れないこと。
    const meta = KernelMetaStore.open(dataRoot);
    try {
      const all = meta.listAllChangelog();
      // connection 操作は appendChangelog を呼ばないので、changelog は空のまま。
      expect(all).toHaveLength(0);
      const serialized = JSON.stringify(all);
      expect(serialized).not.toContain(sentinel);
      expect(serialized).not.toContain("leak-conn");
    } finally {
      meta.close();
    }
  });

  test("command 経路: コマンド文字列(=参照)は保存されるが、それは解決値ではない", () => {
    // command 経路では secret_source_value にコマンド文字列(リテラル)が入る。
    // これは仕様どおりの「参照」であって、解決結果(stdout)ではない。
    // env の展開を絡めない固定コマンドにして、保存されるのが参照であることを明示する。
    const created = store.createConnection({
      appId: "leak-app",
      name: "cmd-conn",
      allowedHosts: [],
      secretSource: { kind: "command", value: "printf SENTINEL-CMD-LITERAL" },
    });

    const fetched = store.getConnection(created.id);
    // 保存されているのはコマンド文字列(参照)そのもの。
    expect(fetched?.secretSource).toEqual({
      kind: "command",
      value: "printf SENTINEL-CMD-LITERAL",
    });

    // DB にはコマンド文字列(参照)は当然含まれる(仕様)。
    // 主たる漏えい保証は env 経路の assert 2 が担う(解決値が DB に無い)。
    store.close();
    const bytes = readFileSync(kernelDbPath(dataRoot));
    expect(bytes.includes(Buffer.from("printf SENTINEL-CMD-LITERAL", "utf8"))).toBe(true);
    store = CapabilityStore.openForKernel(dataRoot);
  });
});
