/**
 * **画面で選んでまとめて操作する**(`V4-M20-T03`。**単位C の将来送りの送り先**)。
 *
 * **門A の判定は「将来送り」であり、本ファイルはその送り先の履行を固定する。**
 * **個別 ADR は無い**(`ADR-0007` §6 の閾値により台帳1行)—— **限定表の正になる文書が
 * 存在しないので、決めた形は `web/src/views/ListViewRenderer.tsx` の実装コメントと
 * 本ファイルの2箇所にしかない。**
 *
 * ## この検査が言えないこと(**先に書く。誇張しない**)
 *
 * 1. **【禁止】「一括操作ができるようになった」と総括しない**(`T03` 完了条件4)——
 *    **アプリは1つも選べず、業務の言葉のボタンにもならず、選べるのは表示中のページの
 *    行だけである。**
 * 2. **【禁止】「絞り込んだ結果の全件を選べる」と読まない** —— **1ミリも解けていない。**
 *    **全件書き出し(`E-G62`)は1バイトも実装していない**(門A は判定を1つも下していない)。
 * 3. **表示層が選べたことは書けることではない**(完了条件7)—— **書込を許すのはサーバの
 *    `batchAuthMiddleware` と `writeRecords` であり、本ファイルは `fetch` をスタブしている
 *    ので「サーバが実際に拒む」ことを1件も測っていない。** 測っているのは
 *    **(a) 表示層が editor / owner 以外に入口を出さないこと** と
 *    **(b) 送る op の形(1トランザクション・`if_match` つき)** の2つだけである。
 * 4. **ここは happy-dom であり、chromium で1度も確かめていない。**
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ListView, Manifest } from "../../src/kernel/types.ts";
import type { Role } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { ListViewRenderer } from "../src/views/ListViewRenderer.tsx";

const APP_ID = "bulk-app";
const RECORDS_PATH = `/api/apps/${APP_ID}/tables/items/records`;
const BATCH_PATH = `/api/apps/${APP_ID}/batch`;

const ROWS = [
  {
    _id: "rec-a",
    _created_at: "2026-01-01T00:00:00Z",
    _updated_at: "2026-01-02T00:00:00Z",
    name: "机",
    status: "受付",
  },
  {
    _id: "rec-b",
    _created_at: "2026-01-01T00:00:00Z",
    _updated_at: "2026-01-03T00:00:00Z",
    name: "椅子",
    status: "受付",
  },
];

type BatchLog = { body: unknown };
let batches: BatchLog[] = [];
let batchResponse: { status: number; body: unknown } = { status: 200, body: { records: ROWS } };
let total = ROWS.length;
let originalFetch: typeof fetch;

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "まとめて",
      tables: [
        {
          id: "items",
          name: "品物",
          fields: [
            { id: "name", name: "名前", type: "text" },
            { id: "status", name: "状態", type: "select", options: ["受付", "完了"] },
            { id: "qty", name: "数量", type: "number" },
            { id: "done", name: "済", type: "boolean" },
            { id: "photo", name: "写真", type: "image" },
            { id: "vendor", name: "仕入先", type: "reference", reference_table: "items" },
          ],
        },
      ],
      views: [{ id: "item-list", type: "list_view", table: "items", columns: ["name", "status"] }],
    },
  } as unknown as Manifest;
}

beforeEach(() => {
  batches = [];
  batchResponse = { status: 200, body: { records: ROWS } };
  total = ROWS.length;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (method === "POST" && url === BATCH_PATH) {
      batches.push({ body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      return json(batchResponse.body, batchResponse.status);
    }
    if (method === "GET" && url.startsWith(RECORDS_PATH)) {
      return json({ records: ROWS, total });
    }
    return json({ errors: [{ path: "", message: `no stub for ${method} ${url}` }] }, 404);
  }) as typeof fetch;
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/item-list`);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

async function renderList(role: Role = "owner", view?: Partial<ListView>): Promise<void> {
  const built = manifest();
  const target = { ...(built.app.views[0] as ListView), ...(view ?? {}) } as ListView;
  render(
    <RoleProvider role={role}>
      <ListViewRenderer appId={APP_ID} manifest={built} view={target} />
    </RoleProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("list-table")).toBeDefined());
}

/** 選択モードに入り、指定の行を選ぶ。 */
async function selectRows(ids: string[]): Promise<void> {
  fireEvent.click(screen.getByTestId("list-bulk-toggle"));
  await waitFor(() => expect(screen.getByTestId("list-bulk-panel")).toBeDefined());
  for (const id of ids) {
    const box = screen
      .getAllByTestId("list-select-row")
      .find((node) => node.getAttribute("data-record-id") === id);
    fireEvent.click(box as HTMLElement);
  }
}

// ---------------------------------------------------------------------------
// (a) 入口は editor / owner にしか出ない(先回りガード。最終防衛線はサーバ)
// ---------------------------------------------------------------------------

test("(a) owner / editor には入口が出る", async () => {
  for (const role of ["owner", "editor"] as Role[]) {
    await renderList(role);
    expect(screen.getByTestId("list-bulk-toggle"), role).toBeDefined();
    cleanup();
  }
});

test("(a) viewer / customer には入口が1つも出ない(DOM は着手前と同じ)", async () => {
  for (const role of ["viewer", "customer"] as Role[]) {
    await renderList(role);
    expect(screen.queryByTestId("list-bulk"), role).toBeNull();
    expect(screen.queryByTestId("list-select-row"), role).toBeNull();
    cleanup();
  }
});

test("(a) 入口を押していないあいだ、チェックボックスは1つも出ない", async () => {
  await renderList();
  expect(screen.queryByTestId("list-select-row")).toBeNull();
  expect(screen.queryByTestId("list-select-all")).toBeNull();
  expect(screen.queryByTestId("list-bulk-panel")).toBeNull();
});

// ---------------------------------------------------------------------------
// (b) 選んだ行をまとめて1フィールド更新する
// ---------------------------------------------------------------------------

test("(b) 選んだ行だけが1つのバッチで送られ、値は1フィールド1値である", async () => {
  await renderList();
  await selectRows(["rec-a"]);
  fireEvent.change(screen.getByTestId("list-bulk-field"), { target: { value: "status" } });
  fireEvent.change(screen.getByTestId("list-bulk-value"), { target: { value: "完了" } });
  fireEvent.click(screen.getByTestId("list-bulk-apply"));
  await waitFor(() => expect(batches).toHaveLength(1));
  expect(batches[0]?.body).toEqual({
    ops: [
      {
        op: "update",
        table: "items",
        target: "rec-a",
        values: { status: "完了" },
        if_match: ROWS[0]?._updated_at,
      },
    ],
  });
});

test("(b) 書込は1回の呼び出しにまとまる(1件ずつ送らない = ADR-0039 の1トランザクション)", async () => {
  await renderList();
  await selectRows(["rec-a", "rec-b"]);
  fireEvent.change(screen.getByTestId("list-bulk-field"), { target: { value: "status" } });
  fireEvent.change(screen.getByTestId("list-bulk-value"), { target: { value: "完了" } });
  fireEvent.click(screen.getByTestId("list-bulk-apply"));
  await waitFor(() => expect(batches).toHaveLength(1));
  const ops = (batches[0] as { body: { ops: unknown[] } }).body.ops;
  expect(ops).toHaveLength(2);
});

test("(b) すべての op に if_match が載る(CAS を1つも外していない)", async () => {
  await renderList();
  fireEvent.click(screen.getByTestId("list-bulk-toggle"));
  await waitFor(() => expect(screen.getByTestId("list-select-all")).toBeDefined());
  fireEvent.click(screen.getByTestId("list-select-all"));
  fireEvent.change(screen.getByTestId("list-bulk-field"), { target: { value: "status" } });
  fireEvent.change(screen.getByTestId("list-bulk-value"), { target: { value: "完了" } });
  fireEvent.click(screen.getByTestId("list-bulk-apply"));
  await waitFor(() => expect(batches).toHaveLength(1));
  const ops = (batches[0] as { body: { ops: { if_match?: string }[] } }).body.ops;
  expect(ops.map((op) => op.if_match)).toEqual([ROWS[0]?._updated_at, ROWS[1]?._updated_at]);
});

test("(b) 何も選んでいなければ実行できない", async () => {
  await renderList();
  fireEvent.click(screen.getByTestId("list-bulk-toggle"));
  await waitFor(() => expect(screen.getByTestId("list-bulk-panel")).toBeDefined());
  fireEvent.change(screen.getByTestId("list-bulk-field"), { target: { value: "status" } });
  expect((screen.getByTestId("list-bulk-apply") as HTMLButtonElement).disabled).toBe(true);
});

// ---------------------------------------------------------------------------
// (c) 選べるのは表示中のページの行だけである(1ミリも解けていないこと)
// ---------------------------------------------------------------------------

test("(c) 総件数がページに収まらないときは、選べるのがこのページだけであることをその場に書く", async () => {
  total = 200;
  await renderList();
  fireEvent.click(screen.getByTestId("list-bulk-toggle"));
  await waitFor(() => expect(screen.getByTestId("list-bulk-page-note")).toBeDefined());
  expect(screen.getByTestId("list-bulk-page-note").textContent).toContain("全 200 件");
});

test("(c) 「全部選ぶ」で選ばれるのは、いま画面に出ている行だけである", async () => {
  total = 200;
  await renderList();
  fireEvent.click(screen.getByTestId("list-bulk-toggle"));
  await waitFor(() => expect(screen.getByTestId("list-select-all")).toBeDefined());
  fireEvent.click(screen.getByTestId("list-select-all"));
  expect(screen.getByTestId("list-bulk-apply").textContent).toBe("選んだ 2 件を変える");
});

// ---------------------------------------------------------------------------
// (d) 選べる項目の範囲(reference / image は外す)
// ---------------------------------------------------------------------------

test("(d) reference と image は選べない(値が id であって人が打つ値ではない)", async () => {
  await renderList();
  fireEvent.click(screen.getByTestId("list-bulk-toggle"));
  await waitFor(() => expect(screen.getByTestId("list-bulk-field")).toBeDefined());
  const options = [...screen.getByTestId("list-bulk-field").querySelectorAll("option")].map(
    (node) => node.getAttribute("value"),
  );
  expect(options).toEqual(["", "name", "status", "qty", "done"]);
});

test("(d) 型に合わない値は送らない(number に文字列を打っても1件も飛ばない)", async () => {
  await renderList();
  await selectRows(["rec-a"]);
  fireEvent.change(screen.getByTestId("list-bulk-field"), { target: { value: "qty" } });
  fireEvent.change(screen.getByTestId("list-bulk-value"), { target: { value: "あいうえお" } });
  fireEvent.click(screen.getByTestId("list-bulk-apply"));
  await waitFor(() => expect(screen.getByTestId("list-bulk-errors")).toBeDefined());
  expect(batches).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// (e) 失敗したら1件も書けていないことを、そのまま出す(部分適用ゼロ)
// ---------------------------------------------------------------------------

test("(e) 403 なら「1件も書き込んでいません」と出し、選択を消さない", async () => {
  batchResponse = { status: 403, body: { errors: [{ path: "", message: "権限がありません" }] } };
  await renderList();
  await selectRows(["rec-a"]);
  fireEvent.change(screen.getByTestId("list-bulk-field"), { target: { value: "status" } });
  fireEvent.change(screen.getByTestId("list-bulk-value"), { target: { value: "完了" } });
  fireEvent.click(screen.getByTestId("list-bulk-apply"));
  await waitFor(() => expect(screen.getByTestId("list-bulk-errors")).toBeDefined());
  expect(screen.getByTestId("list-bulk-errors").textContent).toContain("1件も書き込んでいません");
  expect(screen.getByTestId("list-bulk-apply").textContent).toBe("選んだ 1 件を変える");
});

test("(e) 409(版不一致)なら、読み直しを促して1件も書いていないと出す", async () => {
  batchResponse = {
    status: 409,
    body: {
      errors: [
        {
          path: "",
          message:
            'テーブル "items" のレコード "rec-a" は、あなたが取得した後に別の操作で変更されています。',
        },
      ],
    },
  };
  await renderList();
  await selectRows(["rec-a"]);
  fireEvent.change(screen.getByTestId("list-bulk-field"), { target: { value: "status" } });
  fireEvent.change(screen.getByTestId("list-bulk-value"), { target: { value: "完了" } });
  fireEvent.click(screen.getByTestId("list-bulk-apply"));
  await waitFor(() => expect(screen.getByTestId("list-bulk-errors")).toBeDefined());
  expect(screen.getByTestId("list-bulk-errors").textContent).toContain("1件も書き込んでいません");
});

test("(f) 成功したら書けた件数をそのまま出し、選択を空にする", async () => {
  await renderList();
  await selectRows(["rec-a", "rec-b"]);
  fireEvent.change(screen.getByTestId("list-bulk-field"), { target: { value: "status" } });
  fireEvent.change(screen.getByTestId("list-bulk-value"), { target: { value: "完了" } });
  fireEvent.click(screen.getByTestId("list-bulk-apply"));
  await waitFor(() => expect(screen.getByTestId("list-bulk-result")).toBeDefined());
  expect(screen.getByTestId("list-bulk-result").textContent).toBe("2 件を書き換えました。");
});

// ---------------------------------------------------------------------------
// (g) 語彙を1つも増やしていない(完了条件1 / 2 / 8)
// ---------------------------------------------------------------------------

test("(g) マニフェストに一括操作を書く場所が1つも無い", async () => {
  const source = await Bun.file(
    new URL("../../schemas/manifest.schema.json", import.meta.url),
  ).text();
  for (const forbidden of ['"bulk"', '"bulk_actions"', '"selectable"', '"selection"']) {
    expect(source, forbidden).not.toContain(forbidden);
  }
  const diff = await Bun.file(new URL("../../schemas/diff.schema.json", import.meta.url)).text();
  for (const forbidden of ['"bulk"', '"bulk_actions"', '"selectable"', '"selection"']) {
    expect(diff, forbidden).not.toContain(forbidden);
  }
});

test("(g) 表示層は全件を取りに行く経路を1本も持たない(全件書き出しを1バイトも実装していない)", async () => {
  const source = await Bun.file(
    new URL("../src/views/ListViewRenderer.tsx", import.meta.url),
  ).text();
  // **取得は既存の `fetchRecordPage` / `fetchRecords` の2本だけである。**
  // **`limit` を外して読む・ページを跨いで集める、といった経路を1本も足していない。**
  expect(source).not.toContain("while (");
  expect(source).not.toContain("exportAll");
  expect(source).not.toContain("fetchAllRecords");
});
