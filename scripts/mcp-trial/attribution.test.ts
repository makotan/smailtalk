import { describe, expect, test } from "bun:test";
import {
  attributeScope,
  explainChanges,
  MANIFEST_WRITE_TOOLS,
  RECORD_WRITE_TOOLS,
  requiresWriteCall,
} from "./attribution.ts";
import type { FileChange } from "./snapshot.ts";
import { WRITE_TOOLS } from "./transcript.ts";
import type { ToolCall } from "./types.ts";

const call = (name: string, appId: string | null, id: string): ToolCall => ({
  toolUseId: id,
  name: `mcp__smailtalk__${name}`,
  input: appId === null ? {} : { app_id: appId },
  turn: 1,
  index: 0,
});

describe("attributeScope", () => {
  test("kernel.sqlite はカーネルスコープ", () => {
    expect(attributeScope("kernel.sqlite")).toEqual({ scope: "kernel" });
  });

  test("SQLite の付随ファイルもカーネルスコープ", () => {
    expect(attributeScope("kernel.sqlite-wal")).toEqual({ scope: "kernel" });
    expect(attributeScope("kernel.sqlite-shm")).toEqual({ scope: "kernel" });
  });

  test("apps/<app_id>/ 配下はアプリスコープ", () => {
    expect(attributeScope("apps/reading-log/manifest.json")).toEqual({
      scope: "app:reading-log",
      appId: "reading-log",
    });
    expect(attributeScope("apps/reading-log/snapshots/0001-d-001/app.sqlite")).toEqual({
      scope: "app:reading-log",
      appId: "reading-log",
    });
  });

  test("レイアウトに無いパスは unknown", () => {
    expect(attributeScope("stray.txt")).toEqual({ scope: "unknown" });
    expect(attributeScope("apps")).toEqual({ scope: "unknown" });
  });
});

describe("requiresWriteCall", () => {
  test("マニフェストとスナップショットのマニフェストは書き込み呼び出しを要求できる", () => {
    expect(requiresWriteCall("apps/x/manifest.json")).toBe(true);
    expect(requiresWriteCall("apps/x/snapshots/0001-d/manifest.json")).toBe(true);
  });

  test("SQLite の実体は参照系でも動くので要求できない", () => {
    expect(requiresWriteCall("kernel.sqlite")).toBe(false);
    expect(requiresWriteCall("kernel.sqlite-wal")).toBe(false);
    expect(requiresWriteCall("apps/x/app.sqlite-shm")).toBe(false);
  });
});

describe("explainChanges: マニフェスト(強い説明)", () => {
  const changes: FileChange[] = [
    { path: "apps/reading-log/manifest.json", kind: "added", mtimeMs: 100 },
  ];

  test("該当アプリへの成功した書き込み呼び出しが変化を説明する", () => {
    const result = explainChanges(changes, [
      call("create_app", "reading-log", "t1"),
      call("apply_diff", "reading-log", "t2"),
    ]);
    expect(result[0]?.explainedBy).toEqual([
      "mcp__smailtalk__create_app(app_id=reading-log)#t1",
      "mcp__smailtalk__apply_diff(app_id=reading-log)#t2",
    ]);
    expect(result[0]?.weak).toBe(false);
  });

  test("参照系の呼び出しではマニフェストの変化を説明できない", () => {
    expect(
      explainChanges(changes, [call("get_manifest", "reading-log", "t1")])[0]?.explainedBy,
    ).toEqual([]);
  });

  test("別のアプリへの書き込みでは説明できない", () => {
    expect(
      explainChanges(changes, [call("apply_diff", "other-app", "t9")])[0]?.explainedBy,
    ).toEqual([]);
  });

  test("呼び出しが1件も無ければ説明できない", () => {
    expect(explainChanges(changes, [])[0]?.explainedBy).toEqual([]);
  });
});

describe("explainChanges: SQLite(弱い説明)", () => {
  test("参照系ツールだけでも SQLite の生成は説明できるが weak になる", () => {
    // list_apps を1回呼ぶだけで kernel.sqlite / -wal / -shm が作られる(実測)。
    const result = explainChanges(
      [{ path: "kernel.sqlite", kind: "added", mtimeMs: 1 }],
      [call("list_apps", null, "t1")],
    );
    expect(result[0]?.explainedBy.length).toBe(1);
    expect(result[0]?.weak).toBe(true);
  });

  test("書き込み呼び出しがあれば weak にならない", () => {
    const result = explainChanges(
      [{ path: "kernel.sqlite", kind: "modified", mtimeMs: 1 }],
      [call("list_apps", null, "t1"), call("create_app", "x", "t2")],
    );
    expect(result[0]?.weak).toBe(false);
  });

  test("そのアプリに触れていない呼び出しでは app.sqlite を説明できない", () => {
    const result = explainChanges(
      [{ path: "apps/reading-log/app.sqlite", kind: "modified", mtimeMs: 1 }],
      [call("list_records", "other-app", "t1")],
    );
    expect(result[0]?.explainedBy).toEqual([]);
  });
});

describe("explainChanges: レイアウト外", () => {
  test("どんな呼び出しでも説明できない", () => {
    const result = explainChanges(
      [{ path: "stray.txt", kind: "added", mtimeMs: 1 }],
      [call("apply_diff", "reading-log", "t1")],
    );
    expect(result[0]?.scope).toBe("unknown");
    expect(result[0]?.explainedBy).toEqual([]);
  });

  test("MCP 以外のツールは説明にならない", () => {
    const toolSearch: ToolCall = {
      toolUseId: "t1",
      name: "ToolSearch",
      input: {},
      turn: 1,
      index: 0,
    };
    const result = explainChanges(
      [{ path: "kernel.sqlite", kind: "added", mtimeMs: 1 }],
      [toolSearch],
    );
    expect(result[0]?.explainedBy).toEqual([]);
  });
});

/**
 * V1-M1-T08(申し送り5): `changeAttribution` の説明が粗くなった件への対処。
 *
 * `v1-m0-t01-retrial.md` §10-2 が代償として申告したもの —— `WRITE_TOOLS` に
 * `update_record` / `delete_record` が加わった結果、**`manifest.json` を1バイトも変えない
 * これらの呼び出しが、`manifest.json` の変化の説明候補として列挙されるようになった**。
 *
 * `unexplained_change` の判定を弱くする向きの誤りである —— 会話の外で `manifest.json` が
 * 書き換えられていても、同じアプリに `update_record` が1件でもあれば「説明が付いた」ことになる。
 *
 * 対処は「書き込み系かどうか」の2値をやめ、**パスの種類ごとに、それを実際に書けるツール**を
 * 要求することである。`WRITE_TOOLS` と同じく**事実の列挙**であって辞書ヒューリスティックではない。
 */
describe("explainChanges: マニフェストを書けるツールだけが説明になる(V1-M1-T08)", () => {
  const manifestChange: FileChange[] = [
    { path: "apps/reading-log/manifest.json", kind: "modified", mtimeMs: 100 },
  ];

  test("update_record は manifest.json の変化を説明できない", () => {
    const [attribution] = explainChanges(manifestChange, [
      call("update_record", "reading-log", "u1"),
    ]);
    expect(attribution?.explainedBy).toEqual([]);
  });

  test("delete_record / insert_sample_data も説明できない(レコード層しか書かない)", () => {
    const [attribution] = explainChanges(manifestChange, [
      call("delete_record", "reading-log", "d1"),
      call("insert_sample_data", "reading-log", "i1"),
    ]);
    expect(attribution?.explainedBy).toEqual([]);
  });

  test("apply_diff / create_app / undo は従来どおり説明になる(逆向きの退行よけ)", () => {
    const [attribution] = explainChanges(manifestChange, [
      call("apply_diff", "reading-log", "a1"),
      call("update_record", "reading-log", "u1"),
    ]);
    expect(attribution?.explainedBy.length).toBe(1);
    expect(attribution?.explainedBy[0]).toContain("apply_diff");
  });

  test("スナップショット配下の manifest.json も同じ規則に従う", () => {
    const [attribution] = explainChanges(
      [{ path: "apps/reading-log/snapshots/0001-d-001/manifest.json", kind: "added", mtimeMs: 1 }],
      [call("update_record", "reading-log", "u1")],
    );
    expect(attribution?.explainedBy).toEqual([]);
  });

  test("SQLite の実体は従来どおり(参照系でも動くので緩いまま)", () => {
    const [attribution] = explainChanges(
      [{ path: "apps/reading-log/app.sqlite", kind: "modified", mtimeMs: 1 }],
      [call("update_record", "reading-log", "u1")],
    );
    expect(attribution?.explainedBy.length).toBe(1);
  });
});

/**
 * 分類の網羅性(乖離検出)。`write-tools-drift.test.ts` と同じ発想である ——
 * **ツールが1つ増えたら、それがマニフェストを書くのかどうかを決めるまでテストが落ちる。**
 * 決めなければ既定で「書ける」側に落ちる、という**沈黙による緩みを塞ぐ**。
 */
describe("書き込み系ツールの分類は網羅されている(V1-M1-T08)", () => {
  test("MANIFEST_WRITE_TOOLS と RECORD_WRITE_TOOLS で WRITE_TOOLS を尽くす", () => {
    const classified = [...MANIFEST_WRITE_TOOLS, ...RECORD_WRITE_TOOLS].sort();
    expect(classified).toEqual([...WRITE_TOOLS].sort());
  });

  test("どちらにも属する(=分類が曖昧な)ツールが無い", () => {
    const manifest = new Set<string>(MANIFEST_WRITE_TOOLS);
    expect(RECORD_WRITE_TOOLS.filter((name) => manifest.has(name))).toEqual([]);
  });
});
