/**
 * **`GET /api/apps/:app_id/public` のメニューの位置**(`V22-M2-T06`。`ADR-0486` §Decision 1 の 7 / 限定11)。
 *
 * - **アプリが `navigation.placement` を宣言しているときだけ**、トップレベルの5つ目のキー
 *   `workspace: {navigation: {placement}}` を載せる。
 * - **役割の上書き(`by_role`)は1件も載せない**(未ログインには効かない。載せると役割の ID の一覧が漏れる)。
 * - **上書きだけの宣言(`placement` を書いていない)では `workspace` のキーごと出さない。**
 * - **宣言が無いアプリの応答は今と同じ**(トップレベルは `app` / `signup` / `views`。既存の
 *   `auth-boundary.test.ts` の `#26` と `anonymous-public-view.test.ts` はそのまま緑)。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "pub-nav";

type WorkspaceDeclaration = NonNullable<Manifest["app"]["workspace"]>;

let dataRoot: string;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "pub-nav-"));
  const store = KernelMetaStore.open(dataRoot);
  createApp(store, APP_ID, { app_id: APP_ID });
  store.close();
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

function manifestWith(workspace: WorkspaceDeclaration | undefined): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "位置の店",
      tables: [{ id: "t", name: "表", fields: [{ id: "n", name: "名前", type: "text" }] }],
      views: [{ id: "v", name: "一覧", type: "list_view", table: "t", columns: ["n"] }],
      roles: [{ id: "staff", name: "店員" }],
      ...(workspace === undefined ? {} : { workspace }),
    },
  };
}

async function publicBody(workspace: WorkspaceDeclaration | undefined): Promise<{
  status: number;
  body: Record<string, unknown>;
  text: string;
}> {
  const applied = applyManifest(dataRoot, APP_ID, withDefaultRoleRules(manifestWith(workspace)));
  expect(applied.valid).toBe(true);
  const response = await createServerApp({ dataRoot }).request(
    new Request(`http://localhost/api/apps/${APP_ID}/public`),
  );
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as Record<string, unknown>, text };
}

test("(1) 位置(上)と役割の上書きを宣言したアプリ: workspace は navigation.placement の1値だけ。by_role は載らない", async () => {
  const { status, body, text } = await publicBody({
    navigation: { placement: "top", by_role: [{ role: "staff", placement: "side" }] },
  });
  expect(status).toBe(200);
  expect(Object.keys(body).sort()).toEqual(["app", "signup", "views", "workspace"]);
  expect(body.workspace).toEqual({ navigation: { placement: "top" } });
  expect(text.includes("by_role")).toBe(false);
});

test("(2) 位置(左)だけを宣言したアプリ: workspace に左が載る", async () => {
  const { status, body } = await publicBody({ navigation: { placement: "side" } });
  expect(status).toBe(200);
  expect(Object.keys(body).sort()).toEqual(["app", "signup", "views", "workspace"]);
  expect(body.workspace).toEqual({ navigation: { placement: "side" } });
});

test("(3) 宣言が無いアプリ: workspace のキーごと出さない(今と同じ)", async () => {
  const { status, body, text } = await publicBody(undefined);
  expect(status).toBe(200);
  expect(Object.keys(body).sort()).toEqual(["app", "signup", "views"]);
  expect(text.includes("workspace")).toBe(false);
});

test("(4) 役割の上書きだけの宣言(placement を書いていない): workspace のキーごと出さない", async () => {
  const { status, body, text } = await publicBody({
    navigation: { by_role: [{ role: "staff", placement: "top" }] },
  });
  expect(status).toBe(200);
  expect(Object.keys(body).sort()).toEqual(["app", "signup", "views"]);
  expect(text.includes("workspace")).toBe(false);
  expect(text.includes("by_role")).toBe(false);
});
