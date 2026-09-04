/**
 * 逃げ道(任意 CSS)の資産ストアの検査(V3-M5-T01 / ADR-0055 限定4・5・7・9・11)。
 *
 * ここで固定するのは ADR-0055 の限定表のうち store 層に落ちる4点である:
 *
 * - **限定9(content-addressed)**: 実体名は内容の sha256 hex。同一内容は de-dup し、
 *   **既存実体を上書きしない**。書込は tmp→rename の原子的書込(`putBlob` の作法)。
 *   **sha256 hex 以外を受けない。**
 * - **限定7(作用域)**: 作用域(この資産を当ててよい画面の集合)を**発行時に必須で**受ける。
 *   **宣言を持たない発行を受理しない。ワイルドカード全許可を既定にしない。**
 * - **限定5(発行経路)**: AI 側から到達できるのは申請(`requestEscapeHatchAsset`)までで、
 *   発行(`issueEscapeHatchAsset`)には別経路(owner の HTTP)からしか到達しない。
 *   **経路の不在そのものは `src/server/escape-hatch-issuance.test.ts` が固定する**(ここは
 *   ストアの振る舞いだけを見る)。
 * - **失効の冪等性と、失効が過去の実体を壊さないこと**(T01 完了条件5)。
 *
 * `capability-store.test.ts` / `inbound-store.test.ts` の作法に倣い、`dataRoot` は
 * 一時ディレクトリを渡してリポジトリの `data/` を汚さない。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EscapeHatchStore,
  escapeHatchBodyExists,
  getEscapeHatchBody,
  putEscapeHatchBody,
} from "./escape-hatch-store.ts";
import { appEscapeHatchDir } from "./storage-paths.ts";

const APP_ID = "shop";

let dataRoot: string;

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "gp-escape-hatch-store-"));
});

afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

/** テキストをバイト列にする(CSS は UTF-8 のテキストとして渡す)。 */
function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** 期待値としての sha256 hex(実装と同じ計算を独立に行う)。 */
function sha256Hex(text: string): string {
  return createHash("sha256").update(bytes(text)).digest("hex");
}

/** ストアを開いて処理し、必ず閉じる。 */
function withStore<T>(run: (store: EscapeHatchStore) => T): T {
  const store = EscapeHatchStore.openForKernel(dataRoot);
  try {
    return run(store);
  } finally {
    store.close();
  }
}

// --- 限定9: content-addressed / de-dup / 上書きしない / 原子的書込 --------------------

test("限定9: putEscapeHatchBody は内容の sha256 hex を返し、その名前で読み戻せる", () => {
  const css = ".gp-view { letter-spacing: 0.02em; }";
  const digest = putEscapeHatchBody(dataRoot, APP_ID, bytes(css));

  expect(digest).toBe(sha256Hex(css));
  expect(digest).toMatch(/^[0-9a-f]{64}$/);
  expect(getEscapeHatchBody(dataRoot, APP_ID, digest)).toEqual(bytes(css));
  expect(escapeHatchBodyExists(dataRoot, APP_ID, digest)).toBe(true);
});

test("限定9: 同一内容は1実体に de-dup し、既存実体を上書きしない(inode が変わらない)", () => {
  const css = ".gp-view { line-height: 1.9; }";
  const first = putEscapeHatchBody(dataRoot, APP_ID, bytes(css));
  const path = join(appEscapeHatchDir(dataRoot, APP_ID), first);
  const before = statSync(path);

  const second = putEscapeHatchBody(dataRoot, APP_ID, bytes(css));
  const after = statSync(path);

  expect(second).toBe(first);
  // 同一内容の再投入で**書き直していない**(名前が内容を決めるので不変)。
  expect(after.ino).toBe(before.ino);
  expect(after.mtimeMs).toBe(before.mtimeMs);
  // 実体はディレクトリに1つだけ。
  expect(readdirSync(appEscapeHatchDir(dataRoot, APP_ID))).toEqual([first]);
});

test("限定9: 過去の版を上書き破壊しない(同名の資産を作り直しても旧 digest の実体が読める)", () => {
  const oldCss = ".gp-view { padding: 4px; }";
  const newCss = ".gp-view { padding: 12px; }";
  const oldDigest = putEscapeHatchBody(dataRoot, APP_ID, bytes(oldCss));
  const newDigest = putEscapeHatchBody(dataRoot, APP_ID, bytes(newCss));
  expect(newDigest).not.toBe(oldDigest);

  withStore((store) => {
    store.issueEscapeHatchAsset({
      appId: APP_ID,
      name: "compact",
      digest: oldDigest,
      scopeViews: ["books-list"],
    });
    store.issueEscapeHatchAsset({
      appId: APP_ID,
      name: "compact",
      digest: newDigest,
      scopeViews: ["books-list"],
    });
    // 同じ名前で2版が並ぶ(名前 + ダイジェストで一意)。
    expect(store.listEscapeHatchAssets(APP_ID)).toHaveLength(2);
    expect(store.findEscapeHatchAsset(APP_ID, "compact", oldDigest)?.digest).toBe(oldDigest);
  });

  // **どちらの実体も無傷である**(過去のスナップショットが参照しても壊れない)。
  expect(getEscapeHatchBody(dataRoot, APP_ID, oldDigest)).toEqual(bytes(oldCss));
  expect(getEscapeHatchBody(dataRoot, APP_ID, newDigest)).toEqual(bytes(newCss));
});

test("限定9: sha256 hex 以外の名前を受けない(パストラバーサルは実在しない扱い)", () => {
  putEscapeHatchBody(dataRoot, APP_ID, bytes("x{}"));
  for (const bogus of ["../../etc/passwd", "not-a-hash", "", "ABCDEF", "a".repeat(63)]) {
    expect(getEscapeHatchBody(dataRoot, APP_ID, bogus)).toBeNull();
    expect(escapeHatchBodyExists(dataRoot, APP_ID, bogus)).toBe(false);
  }
});

test("限定9: 発行は sha256 hex 以外の digest を受け付けない", () => {
  withStore((store) => {
    expect(() =>
      store.issueEscapeHatchAsset({
        appId: APP_ID,
        name: "compact",
        digest: "not-a-sha256",
        scopeViews: ["books-list"],
      }),
    ).toThrow(/sha256/);
  });
});

test("限定9: 原子的書込 —— 書込後に tmp ファイルが1つも残らない", () => {
  putEscapeHatchBody(dataRoot, APP_ID, bytes("a{}"));
  putEscapeHatchBody(dataRoot, APP_ID, bytes("b{}"));
  const names = readdirSync(appEscapeHatchDir(dataRoot, APP_ID));
  expect(names.filter((name) => name.startsWith(".tmp-"))).toEqual([]);
  expect(names).toHaveLength(2);
});

test("実体はアプリのディレクトリの下に閉じる(アプリ削除がディレクトリ削除で追従する)", () => {
  const digest = putEscapeHatchBody(dataRoot, APP_ID, bytes("c{}"));
  expect(appEscapeHatchDir(dataRoot, APP_ID)).toBe(join(dataRoot, "apps", APP_ID, "escape-hatch"));
  expect(existsSync(join(appEscapeHatchDir(dataRoot, APP_ID), digest))).toBe(true);
});

// --- 限定7: 作用域は発行時に必須。ワイルドカード全許可を既定にしない -------------------

test("限定7: 作用域を発行時に必須で受け、保った形で読み戻せる", () => {
  const digest = putEscapeHatchBody(dataRoot, APP_ID, bytes("d{}"));
  withStore((store) => {
    const asset = store.issueEscapeHatchAsset({
      appId: APP_ID,
      name: "compact",
      digest,
      scopeViews: ["books-list", "books-detail"],
    });
    expect(asset.scopeViews).toEqual(["books-list", "books-detail"]);
    expect(store.getEscapeHatchAsset(asset.id)?.scopeViews).toEqual(["books-list", "books-detail"]);
  });
});

test("限定7: 宣言を持たない発行を受理しない(空配列は例外。既定の全許可にフォールバックしない)", () => {
  const digest = putEscapeHatchBody(dataRoot, APP_ID, bytes("e{}"));
  withStore((store) => {
    expect(() =>
      store.issueEscapeHatchAsset({ appId: APP_ID, name: "compact", digest, scopeViews: [] }),
    ).toThrow(/作用域/);
    // 例外の後に1件も残っていない。
    expect(store.listEscapeHatchAssets(APP_ID)).toHaveLength(0);
  });
});

test("限定7: ワイルドカード全許可を受理しない('*' も空文字も例外)", () => {
  const digest = putEscapeHatchBody(dataRoot, APP_ID, bytes("f{}"));
  withStore((store) => {
    expect(() =>
      store.issueEscapeHatchAsset({ appId: APP_ID, name: "c", digest, scopeViews: ["*"] }),
    ).toThrow(/作用域/);
    expect(() =>
      store.issueEscapeHatchAsset({
        appId: APP_ID,
        name: "c",
        digest,
        scopeViews: ["books-list", "*"],
      }),
    ).toThrow(/作用域/);
    expect(() =>
      store.issueEscapeHatchAsset({ appId: APP_ID, name: "c", digest, scopeViews: [""] }),
    ).toThrow(/作用域/);
    expect(store.listEscapeHatchAssets(APP_ID)).toHaveLength(0);
  });
});

// --- 発行・一覧・失効 ------------------------------------------------------------------

test("同一 app 内で name + digest が重複する発行は拒否される(UNIQUE)", () => {
  const digest = putEscapeHatchBody(dataRoot, APP_ID, bytes("g{}"));
  withStore((store) => {
    store.issueEscapeHatchAsset({ appId: APP_ID, name: "c", digest, scopeViews: ["v1"] });
    expect(() =>
      store.issueEscapeHatchAsset({ appId: APP_ID, name: "c", digest, scopeViews: ["v2"] }),
    ).toThrow(/既に存在します/);
  });
});

test("一覧は app スコープに閉じる(別アプリの資産が混ざらない)", () => {
  const digest = putEscapeHatchBody(dataRoot, APP_ID, bytes("h{}"));
  const otherDigest = putEscapeHatchBody(dataRoot, "other", bytes("h{}"));
  withStore((store) => {
    store.issueEscapeHatchAsset({ appId: APP_ID, name: "c", digest, scopeViews: ["v1"] });
    store.issueEscapeHatchAsset({
      appId: "other",
      name: "c",
      digest: otherDigest,
      scopeViews: ["v1"],
    });
    expect(store.listEscapeHatchAssets(APP_ID).map((a) => a.appId)).toEqual([APP_ID]);
    expect(store.findEscapeHatchAsset("other", "c", otherDigest)?.appId).toBe("other");
  });
});

test("失効は冪等である(2回呼んでも例外にならず、行は消えたまま)", () => {
  const digest = putEscapeHatchBody(dataRoot, APP_ID, bytes("i{}"));
  withStore((store) => {
    const asset = store.issueEscapeHatchAsset({
      appId: APP_ID,
      name: "c",
      digest,
      scopeViews: ["v1"],
    });
    store.deleteEscapeHatchAsset(asset.id);
    expect(store.getEscapeHatchAsset(asset.id)).toBeUndefined();
    // 2回目も例外にならない(冪等。`deleteConnection` と同型)。
    store.deleteEscapeHatchAsset(asset.id);
    store.deleteEscapeHatchAsset("存在しない-id");
    expect(store.listEscapeHatchAssets(APP_ID)).toHaveLength(0);
  });
});

test("完了条件5: 失効しても過去のスナップショットが参照する実体を壊さない", () => {
  const css = ".gp-view { border-radius: 10px; }";
  const digest = putEscapeHatchBody(dataRoot, APP_ID, bytes(css));
  withStore((store) => {
    const asset = store.issueEscapeHatchAsset({
      appId: APP_ID,
      name: "c",
      digest,
      scopeViews: ["v1"],
    });
    store.deleteEscapeHatchAsset(asset.id);
  });

  // **失効が消すのは登録(参照の解決先)であって実体ではない。**
  // 実体を消すと、過去のスナップショットが参照する版が復元できなくなる(憲法4)。
  expect(escapeHatchBodyExists(dataRoot, APP_ID, digest)).toBe(true);
  expect(getEscapeHatchBody(dataRoot, APP_ID, digest)).toEqual(bytes(css));
});

// --- 申請(AI が到達できる上限)---------------------------------------------------------

test("申請は pending を1件作るだけで、発行済み資産を1件も作らない", () => {
  withStore((store) => {
    const request = store.requestEscapeHatchAsset({
      appId: APP_ID,
      requestedName: "compact",
      purpose: "一覧の行間を詰めたい",
      suggestedScopeViews: ["books-list"],
    });
    expect(request.status).toBe("pending");
    expect(store.listPendingEscapeHatchAssetRequests(APP_ID).map((r) => r.id)).toEqual([
      request.id,
    ]);
    // **発行には1バイトも到達していない。**
    expect(store.listEscapeHatchAssets(APP_ID)).toHaveLength(0);
  });
  // 実体(CSS のバイト列)も1つも置かれていない。
  expect(existsSync(appEscapeHatchDir(dataRoot, APP_ID))).toBe(false);
});

test("申請の承認/却下の記録は冪等で、それ自体は発行しない", () => {
  withStore((store) => {
    const request = store.requestEscapeHatchAsset({
      appId: APP_ID,
      requestedName: "compact",
      purpose: "行間",
      suggestedScopeViews: ["books-list"],
    });
    store.markEscapeHatchAssetRequest(request.id, "approved");
    store.markEscapeHatchAssetRequest(request.id, "approved");
    expect(store.getEscapeHatchAssetRequest(request.id)?.status).toBe("approved");
    expect(store.listPendingEscapeHatchAssetRequests(APP_ID)).toHaveLength(0);
    // 承認の記録は発行ではない。
    expect(store.listEscapeHatchAssets(APP_ID)).toHaveLength(0);
  });
});

test("申請の作用域の提案は空でもよい(提案であって宣言ではない)", () => {
  withStore((store) => {
    const request = store.requestEscapeHatchAsset({
      appId: APP_ID,
      requestedName: "compact",
      purpose: "行間",
      suggestedScopeViews: [],
    });
    // **申請側に必須を課さない。**必須なのは owner の**発行**である(限定7)。
    expect(request.suggestedScopeViews).toEqual([]);
    expect(store.listEscapeHatchAssets(APP_ID)).toHaveLength(0);
  });
});
