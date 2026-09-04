/**
 * `requireApp` のユニットテスト(V0-P5-T02 / 計画 R1)。
 *
 * app_id を取るツールは**必ず最初にこのガードを通す**。理由は
 * `readCurrentManifest`(`src/kernel/apply-manifest.ts:74-86`)が素の `Error` を
 * throw する設計になっているため、そのまま呼ぶと MCP には統一形式ではない
 * 例外メッセージが出てしまい、LLM が自己修正できないからである
 * (`src/server/app.ts:325-328` の `ensureApp` と同じ発想)。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, KernelMetaStore } from "../kernel/index.ts";
import { requireApp } from "./app-guard.ts";

let dataRoot = "";

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-mcp-guard-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "在庫管理", { app_id: "inventory" });
    createApp(store, "経費申請", { app_id: "expense" });
  } finally {
    store.close();
  }
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

test("実在する app_id なら null を返す", () => {
  expect(requireApp(dataRoot, "inventory")).toBeNull();
});

test("実在しない app_id なら /app_id を指す統一形式エラーを返す", () => {
  const errors = requireApp(dataRoot, "nope");
  expect(errors).not.toBeNull();
  expect(errors).toHaveLength(1);
  const error = errors?.[0];
  expect(error?.path).toBe("/app_id");
  expect(error?.message).toContain("nope");
  // LLM が1往復で自己修正できるよう、実在する app_id を allowed_values で必ず示す。
  expect(error?.allowed_values).toEqual(["inventory", "expense"]);
});

test("アプリが1つも無いデータルートでも allowed_values は空配列で返る(未定義にしない)", async () => {
  const empty = await mkdtemp(join(tmpdir(), "gp-mcp-guard-empty-"));
  try {
    const errors = requireApp(empty, "anything");
    expect(errors?.[0]?.allowed_values).toEqual([]);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test("繰り返し呼んでもストアが開きっぱなしにならない(毎回 open / finally で close)", () => {
  // R3: モジュールレベルで KernelMetaStore を持ち回さないこと。持ち回っていると
  // 別プロセス(Webサーバ)の書き込みが見えなくなったり、close 漏れで
  // WAL ファイルが残り続けたりする。ここでは「何度呼んでも例外にならない」
  // ことで、少なくとも二重 open/close が破綻していないことを確かめる。
  for (let i = 0; i < 5; i += 1) {
    expect(requireApp(dataRoot, "expense")).toBeNull();
  }
});
