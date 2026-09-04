/**
 * 一覧の中で自分の行が分かる(`V4-M19-T09`)。
 *
 * **門A の判定は「将来送り」であり、本タスクはその送り先の履行である。ADR は無い(台帳1行)。**
 *
 * ## このファイルが固定すること
 *
 * | # | 何を | どう見るか |
 * |---|---|---|
 * | (a) | **本人の行にだけ印が付く** | `st_owner` が自分の行 / 他人の行 / 共有の行を1件ずつ見る |
 * | (b) | **`st_owner` を持たないテーブルでは DOM が1バイトも変わらない** | 完全一致で見る |
 * | (c) | **`actorId` が渡っていないときは何も起きない** | 同上 |
 * | (d) | **表とカードの両方で効く** | 器を入れ替えて同じ判定を見る |
 * | (e) | **色をアプリが選べない**(プラットフォームが1通りに決める) | 手で書く CSS を1バイトも足していない |
 *
 * ## このファイルが証明しないこと(先に書く。誇張しない)
 *
 * 1. **chromium で1度も見ていない。** happy-dom は CSS を解決しないので、**印が実際に
 *    見えるかを1件も測っていない。**
 * 2. **読める配色であることを1件も担保しない**(地色は hover と同じスロットである)。
 * 3. **支援技術で「自分の行」と分かるかを1本も測っていない** —— 出しているのは
 *    地色と字の太さ(と `data-own-row`)だけで、**読み上げには1バイトも出ない。**
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ListView, Manifest } from "../../src/kernel/types.ts";
import type { Role } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { ListViewRenderer } from "../src/views/ListViewRenderer.tsx";

const APP_ID = "own-row-app";
const ME = "user-me";
/**
 * 名乗るロール(印は「誰の行か」の話であってロールの話ではないが、`RoleProvider` は
 * ロールを必ず要る)。**定数にしてあるのは、文字列で書くと biome の `useValidAriaRole` が
 * `role` を ARIA 属性と読んで赤にするためである。**
 */
const CUSTOMER_ROLE: Role = "customer";
const OTHER = "user-other";

/** `st_owner`(text・required でない)を持つテーブル = 個人所有テーブル(`ADR-0016` の規約)。 */
function ownedManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "注文のサンプル",
      tables: [
        {
          id: "orders",
          name: "注文",
          fields: [
            { id: "title", name: "品目", type: "text" },
            { id: "st_owner", name: "所有者", type: "text" },
          ],
        },
      ],
      views: [{ id: "order-list", type: "list_view", table: "orders", columns: ["title"] }],
    },
  } as unknown as Manifest;
}

/** `st_owner` を1つも持たないテーブル(対照)。 */
function plainManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "備品のサンプル",
      tables: [
        {
          id: "items",
          name: "備品",
          fields: [{ id: "title", name: "品目", type: "text" }],
        },
      ],
      views: [{ id: "item-list", type: "list_view", table: "items", columns: ["title"] }],
    },
  } as unknown as Manifest;
}

const OWNED_ROWS = [
  { _id: "r-mine", _created_at: "", _updated_at: "", title: "自分の注文", st_owner: ME },
  { _id: "r-other", _created_at: "", _updated_at: "", title: "他人の注文", st_owner: OTHER },
  { _id: "r-shared", _created_at: "", _updated_at: "", title: "共有の行", st_owner: null },
];

const PLAIN_ROWS = [
  { _id: "p-1", _created_at: "", _updated_at: "", title: "会議テーブル" },
  { _id: "p-2", _created_at: "", _updated_at: "", title: "椅子" },
];

let originalFetch: typeof fetch;
let rows: Record<string, unknown>[] = OWNED_ROWS;

beforeEach(() => {
  rows = OWNED_ROWS;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ records: rows, total: rows.length }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/order-list`);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

/** `actorId` を渡す/渡さないの両方を1つの入口で描く。 */
async function renderList(
  manifest: Manifest,
  actorId?: string | undefined,
  testId: "list-table" | "list-cards" = "list-table",
): Promise<HTMLElement> {
  const view = manifest.app.views[0] as ListView;
  render(
    <RoleProvider role={CUSTOMER_ROLE} actorId={actorId}>
      <ListViewRenderer appId={APP_ID} manifest={manifest} view={view} />
    </RoleProvider>,
  );
  await waitFor(() => expect(screen.getByTestId(testId)).toBeDefined());
  return screen.getByTestId("view-renderer-list_view");
}

function ownFlags(testId: "list-row" | "list-card"): (string | null)[] {
  return screen.getAllByTestId(testId).map((node) => node.getAttribute("data-own-row"));
}

// ---------------------------------------------------------------------------
// (a) 本人の行にだけ印が付く
// ---------------------------------------------------------------------------

test("(a) 自分の行にだけ印が付く(他人の行にも、共有の行にも付かない)", async () => {
  await renderList(ownedManifest(), ME);
  expect(ownFlags("list-row")).toEqual(["true", null, null]);
});

test("(a) 別の人として見ると、印の付く行が入れ替わる", async () => {
  await renderList(ownedManifest(), OTHER);
  expect(ownFlags("list-row")).toEqual([null, "true", null]);
});

test("(a) 印は行そのものに付く(セルの中の値には1つも付かない)", async () => {
  const section = await renderList(ownedManifest(), ME);
  const marked = section.querySelectorAll("[data-own-row]");
  expect(marked).toHaveLength(1);
  expect((marked[0] as HTMLElement).tagName.toLowerCase()).toBe("tr");
  // **`ADR-0090` の `emphasis` はセルの中の `<span>`(`.field-emphasis`)に当たる** ——
  // 当たり先が違うので衝突しない。ここでは印が `<td>` にも `<span>` にも無いことを見る。
  expect(section.querySelectorAll("td[data-own-row]")).toHaveLength(0);
  expect(section.querySelectorAll("span[data-own-row]")).toHaveLength(0);
});

test("(a) 印の見た目はソースにリテラルで書いたクラスだけである(アプリは1つも選べない)", async () => {
  const section = await renderList(ownedManifest(), ME);
  const marked = section.querySelector("[data-own-row]") as HTMLElement;
  // **プラットフォームが1通りに決める** —— マニフェストの値からクラス名を生やさない
  // (`ADR-0087` 限定6)。
  expect(marked.className).toContain("bg-accent");
  expect(marked.className).toContain("font-medium");
});

// ---------------------------------------------------------------------------
// (b) `st_owner` を持たないテーブルでは DOM が1バイトも変わらない
// ---------------------------------------------------------------------------

test("(b) st_owner を持たないテーブルでは、印も属性も1つも出ない", async () => {
  rows = PLAIN_ROWS;
  const section = await renderList(plainManifest(), ME);
  expect(section.querySelectorAll("[data-own-row]")).toHaveLength(0);
});

test("(b) st_owner を持たないテーブルの DOM は、actorId の有無で1バイトも変わらない", async () => {
  rows = PLAIN_ROWS;
  const withActor = (await renderList(plainManifest(), ME)).outerHTML;
  cleanup();
  const withoutActor = (await renderList(plainManifest(), undefined)).outerHTML;
  expect(withActor).toBe(withoutActor);
});

// ---------------------------------------------------------------------------
// (c) `actorId` が渡っていないときは何も起きない
// ---------------------------------------------------------------------------

test("(c) actorId が渡っていない(未ログイン等)ときは、印が1つも出ない", async () => {
  const section = await renderList(ownedManifest(), undefined);
  expect(section.querySelectorAll("[data-own-row]")).toHaveLength(0);
});

test("(c) RoleProvider の外で描いても、印が1つも出ない", async () => {
  const manifest = ownedManifest();
  render(
    <ListViewRenderer
      appId={APP_ID}
      manifest={manifest}
      view={manifest.app.views[0] as ListView}
    />,
  );
  await waitFor(() => expect(screen.getByTestId("list-table")).toBeDefined());
  expect(
    screen.getByTestId("view-renderer-list_view").querySelectorAll("[data-own-row]"),
  ).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// (d) 表とカードの両方で効く
// ---------------------------------------------------------------------------

test("(d) カードの器でも同じ判定で印が付く(器の形で挙動が割れない)", async () => {
  const manifest = ownedManifest();
  (manifest.app.views[0] as ListView).preset_list_shape = "card";
  await renderList(manifest, ME, "list-cards");
  expect(ownFlags("list-card")).toEqual(["true", null, null]);
});

// ---------------------------------------------------------------------------
// (e) 手で書く CSS を1バイトも足していない
// ---------------------------------------------------------------------------

test("(e) 自分の行のためのセレクタが styles.css / tailwind.css に1つも無い", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  for (const relative of ["styles.css", "tailwind.css"]) {
    const css = readFileSync(join(import.meta.dir, "..", "src", relative), "utf-8");
    expect(css.includes("data-own-row"), relative).toBe(false);
    expect(css.includes("list-row-own"), relative).toBe(false);
  }
});
