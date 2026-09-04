/**
 * 測定環境の記録(V1-M1-T05)。
 *
 * 規律「測定環境を記録すること(マシン・OS・Bun のバージョン・ディスク種別)」への実装。
 * **別環境で再現しない可能性がある**ので、数値と環境は必ず1つのファイルに同梱する。
 *
 * 取得できなかった項目は `null` にする。**推定で埋めない。**
 */
import { spawnSync } from "node:child_process";
import { cpus, totalmem } from "node:os";

/** 記録する測定環境。取得できなかった項目は null。 */
export type BenchEnvironment = {
  platform: string;
  arch: string;
  os_release: string | null;
  os_product: string | null;
  cpu_model: string | null;
  cpu_count: number;
  total_memory_bytes: number;
  bun_version: string;
  /** ベンチマークが書き込むディレクトリのファイルシステム種別。取得できなければ null。 */
  filesystem: string | null;
  /** SSD かどうか。取得できなければ null(**「たぶん SSD」とは書かない**)。 */
  solid_state: boolean | null;
};

/** `cmd` を実行して標準出力を返す。失敗したら null(推定で埋めない)。 */
function run(cmd: string, args: string[]): string | null {
  try {
    const result = spawnSync(cmd, args, { encoding: "utf-8" });
    if (result.status !== 0 || typeof result.stdout !== "string") {
      return null;
    }
    const out = result.stdout.trim();
    return out.length === 0 ? null : out;
  } catch {
    return null;
  }
}

/**
 * macOS の `diskutil info` からファイルシステムと SSD 判定を読む。
 *
 * `diskutil info` は任意のパスを受けないことがあるので、先に `df -P` で
 * デバイス名に解決してから引く。解決できなければ null(**推定で埋めない**)。
 */
function darwinDiskInfo(path: string): { filesystem: string | null; solidState: boolean | null } {
  const df = run("df", ["-P", path]);
  const device = df?.split("\n")[1]?.split(/\s+/)[0] ?? null;
  const out = device === null ? null : run("diskutil", ["info", device]);
  if (out === null) {
    return { filesystem: null, solidState: null };
  }
  const fs = /File System Personality:\s*(.+)/.exec(out)?.[1]?.trim() ?? null;
  const ssd = /Solid State:\s*(Yes|No)/.exec(out)?.[1];
  return { filesystem: fs, solidState: ssd === undefined ? null : ssd === "Yes" };
}

/** 現在の測定環境を集める。 */
export function captureEnvironment(workPath: string): BenchEnvironment {
  const disk =
    process.platform === "darwin"
      ? darwinDiskInfo(workPath)
      : { filesystem: null, solidState: null };
  return {
    platform: process.platform,
    arch: process.arch,
    os_release: run("uname", ["-r"]),
    os_product:
      process.platform === "darwin"
        ? [run("sw_vers", ["-productName"]), run("sw_vers", ["-productVersion"])]
            .filter((v) => v !== null)
            .join(" ") || null
        : null,
    cpu_model:
      process.platform === "darwin"
        ? run("sysctl", ["-n", "machdep.cpu.brand_string"])
        : (cpus()[0]?.model ?? null),
    cpu_count: cpus().length,
    total_memory_bytes: totalmem(),
    bun_version: Bun.version,
    filesystem: disk.filesystem,
    solid_state: disk.solidState,
  };
}
