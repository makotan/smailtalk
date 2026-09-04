/**
 * ST_DATA_ROOT 配下の状態採取(V0-P6-T03a の本命証拠)。
 *
 * transcript は「**AI が何をしたか**」の記録であって、「**人間が何をしなかったか**」の
 * 記録ではない。ツール使用回数が0件でも、別ターミナルで `sqlite3` を叩けば
 * データは変えられる。そこで実行の前後(さらにターンの前後)で配下の全ファイルの
 * SHA-256 と mtime を採取し、**観測されたファイル変化が transcript で説明できるか**を
 * judge が突き合わせられるようにする。
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { FileState, Snapshot } from "./types.ts";

/** スナップショット同士の差分。 */
export interface FileChange {
  path: string;
  kind: "added" | "modified" | "removed";
  /** 変化後の mtime(削除なら null)。 */
  mtimeMs: number | null;
}

/**
 * 評価用データルートがリポジトリの `data/` と分離されていることを強制する。
 *
 * CP-5 は `data-cp5` を手で指定していた(cp-5.md §0-(b))。手で守る約束は破れるので、
 * ここでコードに固定する。`.gitignore` は既に data- 始まりのディレクトリを除外しているため、
 * `data-` 始まりを要求しておけば評価データが誤ってコミットされることもない。
 */
export function assertIsolatedDataRoot(dataRoot: string): string {
  const name = basename(resolve(dataRoot));
  if (name === "data") {
    throw new Error(
      `ST_DATA_ROOT にリポジトリの data/ は使えません(実データを汚すため): ${dataRoot}`,
    );
  }
  if (!name.startsWith("data-")) {
    throw new Error(
      `ST_DATA_ROOT は data- で始まる名前にしてください(.gitignore の data- 始まりの除外に載せるため): ${dataRoot}`,
    );
  }
  return dataRoot;
}

/** データルート配下の全ファイルを採取する。存在しなければ空。 */
export function takeSnapshot(dataRoot: string, phase: "before" | "after", turn: number): Snapshot {
  return {
    phase,
    turn,
    takenAt: new Date().toISOString(),
    files: existsSync(dataRoot)
      ? collect(dataRoot, "").sort((a, b) => (a.path < b.path ? -1 : 1))
      : [],
  };
}

/** 2つのスナップショットの差分。内容(SHA-256)が同じなら mtime が動いていても変化としない。 */
export function diffSnapshots(before: Snapshot, after: Snapshot): FileChange[] {
  const beforeMap = new Map(before.files.map((f) => [f.path, f]));
  const afterMap = new Map(after.files.map((f) => [f.path, f]));
  const changes: FileChange[] = [];

  for (const [path, file] of beforeMap) {
    const next = afterMap.get(path);
    if (next === undefined) {
      changes.push({ path, kind: "removed", mtimeMs: null });
    } else if (next.sha256 !== file.sha256) {
      changes.push({ path, kind: "modified", mtimeMs: next.mtimeMs });
    }
  }
  for (const [path, file] of afterMap) {
    if (!beforeMap.has(path)) changes.push({ path, kind: "added", mtimeMs: file.mtimeMs });
  }

  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function collect(dir: string, prefix: string): FileState[] {
  const files: FileState[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...collect(full, rel));
    } else if (entry.isFile()) {
      const stat = statSync(full);
      files.push({
        path: rel,
        sha256: createHash("sha256").update(readFileSync(full)).digest("hex"),
        mtimeMs: Math.round(stat.mtimeMs),
        size: stat.size,
      });
    }
  }
  return files;
}
