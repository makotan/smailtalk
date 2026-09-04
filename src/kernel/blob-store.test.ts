/**
 * blob ストア(V2-M2-T02 / ADR-0035 §1・限定3)のテスト。
 *
 * content-addressed(ファイル名 = 内容の sha256 hex)・de-dup・原子的書込(tmp→rename)・
 * 実在確認(exists)を固定する。実体は `apps/<appId>/blobs/` に閉じる(`appBlobsDir`)。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blobExists, getBlob, putBlob } from "./blob-store.ts";
import { appBlobsDir } from "./storage-paths.ts";

let dataRoot: string;
const APP = "photo-app";

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-blob-"));
});
afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function sha256Of(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

test("appBlobsDir は apps/<appId>/blobs を指す", () => {
  expect(appBlobsDir(dataRoot, APP)).toBe(join(dataRoot, "apps", APP, "blobs"));
});

test("putBlob は content の sha256 hex を返し、その名前で実体を置く", () => {
  const data = bytes("hello image");
  const hash = putBlob(dataRoot, APP, data);
  expect(hash).toBe(sha256Of(data));
  expect(existsSync(join(appBlobsDir(dataRoot, APP), hash))).toBe(true);
});

test("get で書いた内容がそのまま戻る(ラウンドトリップ)", () => {
  const data = bytes("round trip payload");
  const hash = putBlob(dataRoot, APP, data);
  const read = getBlob(dataRoot, APP, hash);
  expect(read).not.toBeNull();
  expect(Array.from(read as Uint8Array)).toEqual(Array.from(data));
});

test("同一内容は1実体に de-dup される(content-addressed の帰結)", () => {
  const data = bytes("same bytes");
  const h1 = putBlob(dataRoot, APP, data);
  const h2 = putBlob(dataRoot, APP, data);
  expect(h1).toBe(h2);
  // blobs/ には .tmp を残さず1ファイルだけ(原子的書込 + de-dup)。
  const entries = readdirSync(appBlobsDir(dataRoot, APP));
  expect(entries).toEqual([h1]);
});

test("異なる内容は別実体になる", () => {
  const h1 = putBlob(dataRoot, APP, bytes("a"));
  const h2 = putBlob(dataRoot, APP, bytes("b"));
  expect(h1).not.toBe(h2);
  expect(readdirSync(appBlobsDir(dataRoot, APP)).sort()).toEqual([h1, h2].sort());
});

test("blobExists は保存済みだけ true、未保存は false", () => {
  const hash = putBlob(dataRoot, APP, bytes("exists?"));
  expect(blobExists(dataRoot, APP, hash)).toBe(true);
  expect(blobExists(dataRoot, APP, sha256Of(bytes("missing")))).toBe(false);
});

test("getBlob は未保存なら null", () => {
  expect(getBlob(dataRoot, APP, sha256Of(bytes("nope")))).toBeNull();
});

test("不正な sha256(パストラバーサル等)は get/exists で拒否(null/false)", () => {
  expect(getBlob(dataRoot, APP, "../../etc/passwd")).toBeNull();
  expect(blobExists(dataRoot, APP, "../../etc/passwd")).toBe(false);
  expect(getBlob(dataRoot, APP, "not-hex")).toBeNull();
  expect(blobExists(dataRoot, APP, "NOTHEX".repeat(11))).toBe(false);
});

test("書込後、blobs/ に一時ファイル(.tmp)が残らない", () => {
  putBlob(dataRoot, APP, bytes("payload-1"));
  putBlob(dataRoot, APP, bytes("payload-2"));
  const entries = readdirSync(appBlobsDir(dataRoot, APP));
  expect(entries.every((name) => !name.startsWith(".tmp"))).toBe(true);
});
