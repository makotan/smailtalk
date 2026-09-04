/**
 * **宣言を器に当てる**(`V4-M19-T08`。`E-G17` / `D-V4-84` の一部 / `ADR-0119`
 * 限定3 / 限定4 / 限定5 / 限定6 / 限定9)。
 *
 * ## これは何で、何ではないか
 *
 * - **`ADR-0086` 限定4(「書けるが効かない」を1つも作らない)の履行がここである。**
 *   **`T07` が通した宣言(`hide_when_empty`)に、行を描かない当たり先を当てる。**
 *   **着手前、条件による行の非表示は `web/src/` に0件だった。**
 * - **【禁止】「行の中身に応じて表示を出し分けられるようになった」と読まない**
 *   (`ADR-0119` §Decision 5 の 1)—— **通したのは「値が無いとき行ごと出さない」だけである。**
 * - **【禁止】「空の項目が消えるようになった」と読まない**(同 3)—— **消えるのは
 *   `null` / `undefined` のときだけで、空文字 `""` は今日も「値がある」側である。**
 * - **【禁止】「一覧が見やすくなった」と読まない**(同 4)—— **一覧には効かない**(限定4)。
 *
 * ## この検査が言えないこと(**先に書く。憲法6**)
 *
 * 1. **ここは happy-dom であって CSS を1バイトも計算していない。** 見ているのは DOM に
 *    要素が出るか出ないかだけである。
 * 2. **「アプリの主張が正しいか」を1度も検証していない** —— **カーネルも表示層も、その項目を
 *    本当に消してよいかを1度も判定しない**(`ADR-0119` §Decision 5 の 6)。
 * 3. **宣言した項目については、`web/src/fields/display.tsx` が憲法6 を根拠に置いた区別
 *    (値が無いのか取得漏れなのか)が失われる。** **失われないのは宣言しなかった項目に
 *    ついてだけである。**
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { DetailView, ListView, Manifest } from "../../src/kernel/types.ts";
import type { Role } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { DetailViewRenderer } from "../src/views/DetailViewRenderer.tsx";
import { ListViewRenderer } from "../src/views/ListViewRenderer.tsx";

const WRITER_ROLE: Role = "owner";
const APP_ID = "sample-app";
const RECORD_ID = "entry-0001";
const ENTRIES_PATH = `/api/apps/${APP_ID}/tables/entries/records`;

/** `memo` が宣言つき、`note` は宣言なし。**同じ画面に両方を置いて差だけを見る。** */
function baseManifest(view: Record<string, unknown>): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "サンプル",
      tables: [
        {
          id: "entries",
          name: "エントリ",
          fields: [
            { id: "name", name: "品名", type: "text" },
            { id: "memo", name: "メモ", type: "text", hide_when_empty: true },
            { id: "note", name: "備考", type: "text" },
          ],
        },
      ],
      views: [{ id: "entry-detail", type: "detail_view", table: "entries", ...view }],
    },
  } as unknown as Manifest;
}

let originalFetch: typeof fetch;
let row: Record<string, unknown> = {};

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (method === "GET" && url === `${ENTRIES_PATH}/${RECORD_ID}`) {
      return json({ record: row });
    }
    if (method === "GET" && url.startsWith(ENTRIES_PATH)) {
      return json({ records: [row], total: 1 });
    }
    return json({ errors: [{ path: "", message: `no stub for ${method} ${url}` }] }, 404);
  }) as typeof fetch;
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/entry-detail/records/${RECORD_ID}`);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

async function renderDetail(manifest: Manifest): Promise<HTMLElement> {
  const view = manifest.app.views[0] as DetailView;
  render(
    <RoleProvider role={WRITER_ROLE}>
      <DetailViewRenderer appId={APP_ID} manifest={manifest} view={view} recordId={RECORD_ID} />
    </RoleProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("detail-field-name")).toBeDefined());
  return screen.getByTestId("view-renderer-detail_view");
}

// --- (a) 宣言した項目は、値が無いとき行ごと消える(限定5)-----------------------------------

test("(T08-1) 宣言した項目は、値が null のとき dt も dd も出ない", async () => {
  row = { _id: RECORD_ID, name: "机", memo: null, note: null };
  await renderDetail(baseManifest({}));
  // **宣言した項目は行ごと消える** —— 値だけでなく項目名(`dt`)も消える(限定5)。
  expect(screen.queryByTestId("detail-field-memo")).toBeNull();
  expect(screen.queryByText("メモ")).toBeNull();
  // **宣言しなかった項目は今日どおり「未設定」と出る**(限定3。既定を反転させていない)。
  expect(screen.getByTestId("detail-field-note")).not.toBeNull();
  expect(screen.getByText("備考")).not.toBeNull();
  expect(screen.getAllByText("未設定")).toHaveLength(1);
});

test("(T08-2) 宣言した項目でも、値があれば今日どおり出る", async () => {
  row = { _id: RECORD_ID, name: "机", memo: "急ぎ", note: null };
  await renderDetail(baseManifest({}));
  expect(screen.getByTestId("detail-field-memo").textContent).toBe("急ぎ");
  expect(screen.getByText("メモ")).not.toBeNull();
});

test("(T08-3) 空文字は「値がある」側なので、宣言しても行が残る(限定3)", async () => {
  // **`web/src/fields/display.tsx` の「boolean の false と number の 0 は『値がある』。
  // null / undefined だけが未設定」を1バイトも変えていない。**
  row = { _id: RECORD_ID, name: "机", memo: "", note: null };
  await renderDetail(baseManifest({}));
  expect(screen.getByTestId("detail-field-memo")).not.toBeNull();
  expect(screen.getByText("メモ")).not.toBeNull();
});

test("(T08-4) 値が undefined(キーそのものが無い)ときも消える", async () => {
  row = { _id: RECORD_ID, name: "机" };
  await renderDetail(baseManifest({}));
  expect(screen.queryByTestId("detail-field-memo")).toBeNull();
  expect(screen.getByTestId("detail-field-note")).not.toBeNull();
});

// --- (b) 効くのは詳細画面の項目の行だけである(限定4)---------------------------------------

test("(T08-5) 一覧の列には効かない(同じ宣言を持つ項目が列として残る)", async () => {
  row = { _id: RECORD_ID, name: "机", memo: null, note: null };
  const manifest = baseManifest({});
  const listView = {
    id: "entry-list",
    type: "list_view",
    table: "entries",
    columns: ["name", "memo"],
  } as unknown as ListView;
  render(
    <RoleProvider role={WRITER_ROLE}>
      <ListViewRenderer appId={APP_ID} manifest={manifest} view={listView} />
    </RoleProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("list-table")).toBeDefined());
  // **列は残り、セルには今日どおり「未設定」が出る** —— 列を値ごとに出し分けると、
  // 同じ列が行によって在ったり無かったりして表が崩れるためである(限定4)。
  expect(screen.getByText("メモ")).not.toBeNull();
  expect(screen.getByText("未設定")).not.toBeNull();
});

// --- (c) まとまり(field_groups)の中でも効く -----------------------------------------------

test("(T08-6) まとまりの中の項目も行ごと消え、全部消えたまとまりには空の器を置かない", async () => {
  row = { _id: RECORD_ID, name: "机", memo: null, note: "覚書" };
  await renderDetail(
    baseManifest({ fields: ["name", "memo", "note"], field_groups: { 補足: ["memo"] } }),
  );
  expect(screen.queryByTestId("detail-field-memo")).toBeNull();
  // **まとまりの見出しは残る** —— 見出しを消す宣言は今日1つも無い(本 ADR の射程外である)。
  expect(screen.getByText("補足")).not.toBeNull();
  // **当たり先の無い器を DOM に置かない** —— 中身が全部消えたまとまりに `<dl>` を出さない。
  const group = screen.getByTestId("detail-field-group");
  expect(group.querySelector('[data-testid="detail-fields"]')).toBeNull();
});

// --- (d) 表示関数の引数を1本も増やしていない(限定9)------------------------------------------

test("(T08-7) ViewRendererProps に props を1つも足していない", async () => {
  const { readFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const source = readFileSync(join(dirname(import.meta.dir), "src", "views", "types.ts"), "utf8");
  // **値は `field`(既に引数である)の中に入って届く** —— 引数は1本も増えていない。
  expect(source).not.toContain("hide_when_empty");
  expect(source).not.toContain("hideWhenEmpty");
});
