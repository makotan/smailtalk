/**
 * **詳細画面の行の変更履歴**(`detail_view.history`)の画面の検査。
 *
 * - 画面が `history: true` のときだけ、子の一覧の後ろに別の部品を出す。 部品は単件の読取に
 *   `?history=1&history_offset=<n>` を付けて読み、新しい順(サーバの返した順)に50件ずつ並べる。
 *   「さらに読む」で次の50件。
 * - 1件に、時刻・変えた人(サーバが差し替えた名前)・入口の日本語・操作の日本語・項目ごとの変更前と変更後
 *   (今日の値の表示部品。`long_text` は全文。画像とファイルは配信の URL)。 項目名はマニフェストの項目名。
 * - **陰性対照**: 画面に `history` が無ければ、表が `history: true` でも要求に `?history=1` が付かず、
 *   DOM は表に宣言の無いときと1バイトも同じ。
 *
 * ここに出てくるアプリ固有の名前はこのテストファイル内だけのフィクスチャである。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DetailView, Manifest } from "../../src/kernel/types.ts";
import type { Role } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { DetailViewRenderer } from "../src/views/DetailViewRenderer.tsx";

const WRITER_ROLE: Role = "owner";
const APP_ID = "history-app";
const RECORD_ID = "row-0001";
const ENTRIES_PATH = `/api/apps/${APP_ID}/tables/entries/records`;
const RECORD_PATH = `${ENTRIES_PATH}/${RECORD_ID}`;
const HISTORY_FIRST = `${RECORD_PATH}?history=1&history_offset=0`;

/** 全文が切り詰めの長さ(40字)を超える長文。 */
const LONG_BEFORE = "変更前の長い文章です。".repeat(8);
const LONG_AFTER = "変更後の長い文章です。".repeat(8);

function manifestOf(options: { tableHistory: boolean; viewHistory: boolean }): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "履歴の題材",
      tables: [
        {
          id: "entries",
          name: "記録",
          ...(options.tableHistory ? { history: true } : {}),
          fields: [
            { id: "f_text", name: "件名", type: "text", required: true },
            { id: "f_long", name: "本文", type: "long_text" },
            { id: "f_num", name: "点数", type: "number" },
            { id: "f_img", name: "写真", type: "image" },
            { id: "f_file", name: "添付", type: "file" },
          ],
        },
      ],
      views: [
        {
          id: "entry-detail",
          type: "detail_view",
          table: "entries",
          ...(options.viewHistory ? { history: true } : {}),
        },
      ],
    },
  } as Manifest;
}

function detailView(manifest: Manifest): DetailView {
  const view = manifest.app.views[0];
  if (view === undefined || view.type !== "detail_view") {
    throw new Error("fixture broken");
  }
  return view;
}

const ROW = {
  _id: RECORD_ID,
  _created_at: "2026-01-01T00:00:00Z",
  _updated_at: "2026-01-02T00:00:00Z",
  f_text: "いま",
  f_long: LONG_AFTER,
  f_num: 7,
  f_img: "asset-img-after",
  f_file: "asset-file-after",
};

type Item = {
  seq: number;
  op: string;
  actor: string;
  entry: string;
  at: string;
  changes: unknown[];
};

function item(seq: number, overrides: Partial<Item> = {}): Item {
  return {
    seq,
    op: "update",
    actor: `人${seq}`,
    entry: "http",
    at: "2026-03-04T05:06:07.000Z",
    changes: [{ field: "f_num", before: seq - 1, after: seq }],
    ...overrides,
  };
}

let requests: string[];
let originalFetch: typeof fetch;
/** `?history=1` の要求への応答(`history_offset` ごと)。 `undefined` なら `history` の鍵を返さない。 */
let historyPages: Map<number, { items: Item[]; total: number }> | undefined;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  requests = [];
  historyPages = undefined;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url}`);
    if (method === "GET" && url === RECORD_PATH) {
      return jsonResponse({ record: ROW }, 200);
    }
    if (method === "GET" && url.startsWith(`${RECORD_PATH}?`)) {
      const query = new URLSearchParams(url.slice(RECORD_PATH.length + 1));
      if (query.get("history") === "1") {
        const offset = Number(query.get("history_offset") ?? "0");
        const page = historyPages?.get(offset);
        return jsonResponse(
          page === undefined
            ? { record: ROW }
            : { record: ROW, history: { ...page, offset, limit: 50 } },
          200,
        );
      }
      return jsonResponse({ record: ROW }, 200);
    }
    if (method === "GET" && url.startsWith(ENTRIES_PATH)) {
      return jsonResponse({ records: [ROW] }, 200);
    }
    return jsonResponse({ errors: [{ path: "", message: `no stub for ${method} ${url}` }] }, 404);
  }) as typeof fetch;
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/entry-detail/records/${RECORD_ID}`);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function renderDetail(manifest: Manifest) {
  return render(
    <RoleProvider role={WRITER_ROLE}>
      <DetailViewRenderer
        appId={APP_ID}
        manifest={manifest}
        view={detailView(manifest)}
        recordId={RECORD_ID}
      />
    </RoleProvider>,
  );
}

/** 画面の時刻の書き方(年-月-日 時:分。手元の時刻帯)。 */
function localMinute(iso: string): string {
  const at = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

describe("出る・出ない", () => {
  test("陰性対照: 画面に history が無ければ、表が history: true でも ?history=1 を要求せず、DOM は宣言の無い表と同じ", async () => {
    const plain = renderDetail(manifestOf({ tableHistory: false, viewHistory: false }));
    await screen.findByText("いま");
    const plainHtml = plain.container.innerHTML;
    const plainRequests = [...requests];
    cleanup();
    requests = [];

    const tableOnly = renderDetail(manifestOf({ tableHistory: true, viewHistory: false }));
    await screen.findByText("いま");
    // 部品が後から読むことは無いが、読むなら1拍おいて現れるので待つ。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(tableOnly.container.innerHTML).toBe(plainHtml);
    expect(requests).toEqual(plainRequests);
    expect(requests.some((request) => request.includes("history="))).toBe(false);
    expect(screen.queryByTestId("record-history")).toBeNull();
  });

  test("画面が history: true なら、単件の読取は今日のまま1本で、部品が ?history=1&history_offset=0 を1本読む", async () => {
    historyPages = new Map([[0, { items: [item(2), item(1, { op: "create" })], total: 2 }]]);
    renderDetail(manifestOf({ tableHistory: true, viewHistory: true }));
    const panel = await screen.findByTestId("record-history");
    expect(within(panel).getByRole("heading", { name: "変更履歴" })).toBeDefined();
    await waitFor(() =>
      expect(within(panel).getAllByTestId("record-history-item")).toHaveLength(2),
    );
    expect(requests.filter((request) => request === `GET ${RECORD_PATH}`)).toHaveLength(1);
    expect(requests.filter((request) => request === `GET ${HISTORY_FIRST}`)).toHaveLength(1);
  });

  test("サーバが history を返さない(未ログイン・表に宣言が無い)なら、部品は何も描かない", async () => {
    historyPages = undefined;
    renderDetail(manifestOf({ tableHistory: true, viewHistory: true }));
    await screen.findByText("いま");
    await waitFor(() => expect(requests).toContain(`GET ${HISTORY_FIRST}`));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId("record-history")).toBeNull();
  });

  test("履歴が0件なら「変更履歴はまだありません。」", async () => {
    historyPages = new Map([[0, { items: [], total: 0 }]]);
    renderDetail(manifestOf({ tableHistory: true, viewHistory: true }));
    const panel = await screen.findByTestId("record-history");
    expect(await within(panel).findByText("変更履歴はまだありません。")).toBeDefined();
    expect(within(panel).queryAllByTestId("record-history-item")).toHaveLength(0);
    expect(within(panel).queryByRole("button", { name: "さらに読む" })).toBeNull();
  });
});

describe("並びとさらに読む", () => {
  test("サーバの返した順(新しい順)のまま並び、total が残っていれば「さらに読む」で次の50件を足す", async () => {
    const first = Array.from({ length: 50 }, (_, index) => item(55 - index));
    const rest = Array.from({ length: 5 }, (_, index) => item(5 - index));
    historyPages = new Map([
      [0, { items: first, total: 55 }],
      [50, { items: rest, total: 55 }],
    ]);
    renderDetail(manifestOf({ tableHistory: true, viewHistory: true }));
    const panel = await screen.findByTestId("record-history");
    await waitFor(() =>
      expect(within(panel).getAllByTestId("record-history-item")).toHaveLength(50),
    );
    const seqs = () =>
      within(panel)
        .getAllByTestId("record-history-item")
        .map((node) => Number(node.getAttribute("data-seq")));
    expect(seqs()).toEqual(first.map((entry) => entry.seq));

    fireEvent.click(within(panel).getByRole("button", { name: "さらに読む" }));
    await waitFor(() =>
      expect(within(panel).getAllByTestId("record-history-item")).toHaveLength(55),
    );
    expect(requests).toContain(`GET ${RECORD_PATH}?history=1&history_offset=50`);
    expect(seqs()).toEqual([...first, ...rest].map((entry) => entry.seq));
    expect(within(panel).queryByRole("button", { name: "さらに読む" })).toBeNull();
  });

  test("全部が1ページに収まれば「さらに読む」は出ない", async () => {
    historyPages = new Map([[0, { items: [item(3), item(2), item(1)], total: 3 }]]);
    renderDetail(manifestOf({ tableHistory: true, viewHistory: true }));
    const panel = await screen.findByTestId("record-history");
    await waitFor(() =>
      expect(within(panel).getAllByTestId("record-history-item")).toHaveLength(3),
    );
    expect(within(panel).queryByRole("button", { name: "さらに読む" })).toBeNull();
  });
});

describe("入口と操作の言い方", () => {
  test("入口の6値は 画面・API / 手動起動 / 受信口 / 自動処理 / 時刻起動 / AI", async () => {
    const entries = ["http", "manual", "inbound", "on_create/on_update", "schedule", "mcp"];
    historyPages = new Map([
      [0, { items: entries.map((entry, index) => item(10 - index, { entry })), total: 6 }],
    ]);
    renderDetail(manifestOf({ tableHistory: true, viewHistory: true }));
    const panel = await screen.findByTestId("record-history");
    await waitFor(() =>
      expect(within(panel).getAllByTestId("record-history-item")).toHaveLength(6),
    );
    expect(
      within(panel)
        .getAllByTestId("record-history-entry")
        .map((node) => node.textContent),
    ).toEqual(["画面・API", "手動起動", "受信口", "自動処理", "時刻起動", "AI"]);
  });

  test("操作の7値は 作成・更新・削除・招待・承諾・辞退・取消", async () => {
    const ops = [
      "create",
      "update",
      "delete",
      "invite",
      "invite_accept",
      "invite_decline",
      "invite_revoke",
    ];
    historyPages = new Map([
      [
        0,
        {
          items: ops.map((op, index) =>
            item(20 - index, {
              op,
              changes: op.startsWith("invite")
                ? [{ invitee: "招かれた人", permission: "閲覧" }]
                : [{ field: "f_num", before: 1, after: 2 }],
            }),
          ),
          total: 7,
        },
      ],
    ]);
    renderDetail(manifestOf({ tableHistory: true, viewHistory: true }));
    const panel = await screen.findByTestId("record-history");
    await waitFor(() =>
      expect(within(panel).getAllByTestId("record-history-item")).toHaveLength(7),
    );
    expect(
      within(panel)
        .getAllByTestId("record-history-op")
        .map((node) => node.textContent),
    ).toEqual(["作成", "更新", "削除", "招待", "承諾", "辞退", "取消"]);
  });

  test("時刻と変えた人(サーバが差し替えた名前)を出し、変えた人が空なら「—」", async () => {
    historyPages = new Map([
      [
        0,
        {
          items: [
            item(2, { actor: "山田 花子", at: "2026-05-06T07:08:09.000Z" }),
            item(1, { actor: "", entry: "schedule" }),
          ],
          total: 2,
        },
      ],
    ]);
    renderDetail(manifestOf({ tableHistory: true, viewHistory: true }));
    const panel = await screen.findByTestId("record-history");
    await waitFor(() =>
      expect(within(panel).getAllByTestId("record-history-item")).toHaveLength(2),
    );
    const [first, second] = within(panel).getAllByTestId("record-history-item");
    expect(within(first as HTMLElement).getByTestId("record-history-at").textContent).toBe(
      localMinute("2026-05-06T07:08:09.000Z"),
    );
    expect(within(first as HTMLElement).getByTestId("record-history-actor").textContent).toBe(
      "山田 花子",
    );
    expect(within(second as HTMLElement).getByTestId("record-history-actor").textContent).toBe("—");
  });
});

describe("値の表示", () => {
  test("項目名はマニフェストの項目名で、変更前と変更後を今日の表示部品で出す(long_text は全文・画像とファイルは配信の URL)", async () => {
    historyPages = new Map([
      [
        0,
        {
          items: [
            item(1, {
              changes: [
                { field: "f_long", before: LONG_BEFORE, after: LONG_AFTER },
                { field: "f_num", before: 12, after: 7 },
                { field: "f_img", before: "asset-img-before", after: "asset-img-after" },
                { field: "f_file", before: null, after: "asset-file-after" },
              ],
            }),
          ],
          total: 1,
        },
      ],
    ]);
    renderDetail(manifestOf({ tableHistory: true, viewHistory: true }));
    const panel = await screen.findByTestId("record-history");
    await waitFor(() =>
      expect(within(panel).getAllByTestId("record-history-change")).toHaveLength(4),
    );
    const changes = within(panel).getAllByTestId("record-history-change");
    const [longChange, numChange, imgChange, fileChange] = changes as HTMLElement[];

    expect(within(longChange as HTMLElement).getByTestId("record-history-field").textContent).toBe(
      "本文",
    );
    const longs = within(longChange as HTMLElement).getAllByTestId("field-value-long_text");
    expect(longs.map((node) => node.textContent)).toEqual([LONG_BEFORE, LONG_AFTER]);

    expect(within(numChange as HTMLElement).getByTestId("record-history-field").textContent).toBe(
      "点数",
    );
    expect(within(numChange as HTMLElement).getByTestId("record-history-before").textContent).toBe(
      "12",
    );
    expect(within(numChange as HTMLElement).getByTestId("record-history-after").textContent).toBe(
      "7",
    );

    const images = within(imgChange as HTMLElement).getAllByTestId("field-value-image");
    expect(images.map((node) => node.getAttribute("src"))).toEqual([
      `/api/apps/${APP_ID}/files/asset-img-before`,
      `/api/apps/${APP_ID}/files/asset-img-after`,
    ]);

    // 変更前の空は、今日の詳細画面と同じ空の印(リンクを持たない)。 変更後は配信の URL。
    const files = within(fileChange as HTMLElement).getAllByTestId("field-value-file");
    expect(files.map((node) => node.getAttribute("href"))).toEqual([
      null,
      `/api/apps/${APP_ID}/files/asset-file-after`,
    ]);
  });

  test("招待の記録は、招かれた人と配る権限名を出す", async () => {
    historyPages = new Map([
      [
        0,
        {
          items: [item(1, { op: "invite", changes: [{ invitee: "佐藤", permission: "編集" }] })],
          total: 1,
        },
      ],
    ]);
    renderDetail(manifestOf({ tableHistory: true, viewHistory: true }));
    const panel = await screen.findByTestId("record-history");
    const invite = await within(panel).findByTestId("record-history-invite");
    expect(invite.textContent).toBe("招かれた人: 佐藤 / 権限: 編集");
  });
});

describe("配る版", () => {
  test("配る版の入口も同じ器(ViewHost → DetailViewRenderer → 履歴の部品)を通る", () => {
    const src = join(import.meta.dir, "..", "src");
    const read = (path: string) => readFileSync(join(src, path), "utf8");
    expect(read("runner-app.tsx")).toContain('from "./views/ViewHost.tsx"');
    expect(read("views/ViewHost.tsx")).toContain('from "./DetailViewRenderer.tsx"');
    expect(read("views/DetailViewRenderer.tsx")).toContain("function RecordHistoryPanel(");
  });
});

describe("読む間に増えた履歴と、行が変わったときの読み直し(独立点検の軽4・軽5)", () => {
  test("最初のページを読んだ後に1件増えても、「さらに読む」で同じ seq が2回並ばず、古い側を取りこぼさず、ボタンが消える", async () => {
    // 最初は60件(seq 60〜11 が1ページ目)。 読んだ後に seq 61 が書かれ、2ページ目(offset 50)は seq 11〜1 になる。
    const first = Array.from({ length: 50 }, (_, index) => item(60 - index));
    const shifted = Array.from({ length: 11 }, (_, index) => item(11 - index));
    historyPages = new Map([
      [0, { items: first, total: 60 }],
      [50, { items: shifted, total: 61 }],
    ]);
    renderDetail(manifestOf({ tableHistory: true, viewHistory: true }));
    const panel = await screen.findByTestId("record-history");
    await waitFor(() =>
      expect(within(panel).getAllByTestId("record-history-item")).toHaveLength(50),
    );
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      fireEvent.click(within(panel).getByRole("button", { name: "さらに読む" }));
      await waitFor(() =>
        expect(within(panel).getAllByTestId("record-history-item")).toHaveLength(60),
      );
    } finally {
      console.error = originalError;
    }
    const seqs = within(panel)
      .getAllByTestId("record-history-item")
      .map((node) => Number(node.getAttribute("data-seq")));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual(Array.from({ length: 60 }, (_, index) => 60 - index));
    // 新しく書かれた seq 61 は上に足さない(読み直すと出る)。 古い側は全部出たので「さらに読む」は消える。
    expect(within(panel).queryByRole("button", { name: "さらに読む" })).toBeNull();
    expect(JSON.stringify(errors)).not.toContain("same key");
  });

  test("詳細画面の上のボタンで行が変わると、履歴の部品は最初のページを読み直す(行の版が変わらない間は読み直さない)", async () => {
    const UPDATED = { ...ROW, f_num: 8, _updated_at: "2026-01-03T00:00:00Z" };
    const stub = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if ((init?.method ?? "GET") === "PATCH" && url === RECORD_PATH) {
        requests.push(`PATCH ${url}`);
        historyPages = new Map([[0, { items: [item(2), item(1, { op: "create" })], total: 2 }]]);
        return jsonResponse({ record: UPDATED }, 200);
      }
      return stub(input, init);
    }) as typeof fetch;
    historyPages = new Map([[0, { items: [item(1, { op: "create" })], total: 1 }]]);
    const manifest = manifestOf({ tableHistory: true, viewHistory: true });
    const view = detailView(manifest) as DetailView & { actions?: unknown[] };
    view.actions = [{ set: { field: "f_num", value: 8 }, name: "点数を8にする" }];
    renderDetail(manifest);
    const panel = await screen.findByTestId("record-history");
    await waitFor(() =>
      expect(within(panel).getAllByTestId("record-history-item")).toHaveLength(1),
    );
    expect(requests.filter((request) => request === `GET ${HISTORY_FIRST}`)).toHaveLength(1);

    fireEvent.click(await screen.findByRole("button", { name: "点数を8にする" }));
    await waitFor(() => expect(requests).toContain(`PATCH ${RECORD_PATH}`));
    const reread = await screen.findByTestId("record-history");
    await waitFor(() =>
      expect(within(reread).getAllByTestId("record-history-item")).toHaveLength(2),
    );
    expect(requests.filter((request) => request === `GET ${HISTORY_FIRST}`)).toHaveLength(2);
  });
});

describe("D-V23-242: 読む間に件数が減ったら、最初のページから読み直す", () => {
  test("D-V23-242: 60件で1ページ目を読んだ後に件数が減った応答を返すと、最初のページから読み直して seq が抜けない", async () => {
    // 最初は60件(1ページ目 seq 60〜11)。 読んだ後に undo で seq 60・59・58 が消え、
    // 2ページ目(offset 50)は seq 7〜1(total 57)を返す。 今日の形は seq 10・9・8 を取りこぼし、消えた 60〜58 が残る。
    historyPages = new Map([
      [0, { items: Array.from({ length: 50 }, (_, index) => item(60 - index)), total: 60 }],
    ]);
    renderDetail(manifestOf({ tableHistory: true, viewHistory: true }));
    const panel = await screen.findByTestId("record-history");
    await waitFor(() =>
      expect(within(panel).getAllByTestId("record-history-item")).toHaveLength(50),
    );
    // undo の後のサーバの答え(57件。新しい順に seq 57〜1)。
    historyPages = new Map([
      [0, { items: Array.from({ length: 50 }, (_, index) => item(57 - index)), total: 57 }],
      [50, { items: Array.from({ length: 7 }, (_, index) => item(7 - index)), total: 57 }],
    ]);
    const seqs = () =>
      within(panel)
        .getAllByTestId("record-history-item")
        .map((node) => Number(node.getAttribute("data-seq")));

    fireEvent.click(within(panel).getByRole("button", { name: "さらに読む" }));
    // 読んだ分を捨てて最初のページ(seq 57〜8)に置き換わる。 消えた seq 60・59・58 は残らない。
    await waitFor(() => expect(seqs()[0]).toBe(57));
    expect(seqs()).toEqual(Array.from({ length: 50 }, (_, index) => 57 - index));

    // 続きを読むと seq 7〜1 が足され、57件が抜けも重なりもなく並ぶ。
    fireEvent.click(within(panel).getByRole("button", { name: "さらに読む" }));
    await waitFor(() =>
      expect(within(panel).getAllByTestId("record-history-item")).toHaveLength(57),
    );
    expect(seqs()).toEqual(Array.from({ length: 57 }, (_, index) => 57 - index));
    expect(within(panel).queryByRole("button", { name: "さらに読む" })).toBeNull();
    const historyRequests = requests.filter((request) => request.includes("history=1"));
    expect(
      historyRequests.map((request) =>
        new URL(request.split(" ")[1] ?? "", "http://x").searchParams.get("history_offset"),
      ),
    ).toEqual(["0", "50", "0", "50"]);
  });
});

describe("D-V23-242: 増えてから減ったときも、直前に読んだ件数と比べて読み直す(独立点検B 軽1)", () => {
  test("D-V23-242: 110件で読み始め、2件増えた後に2件減ると、最初のページから読み直して seq 12・11 を取りこぼさない", async () => {
    const range = (from: number, count: number) =>
      Array.from({ length: count }, (_, index) => item(from - index));
    const seqs = (panel: HTMLElement) =>
      within(panel)
        .getAllByTestId("record-history-item")
        .map((node) => Number(node.getAttribute("data-seq")));
    // 最初は110件(1ページ目 seq 110〜61)。
    historyPages = new Map([[0, { items: range(110, 50), total: 110 }]]);
    renderDetail(manifestOf({ tableHistory: true, viewHistory: true }));
    const panel = await screen.findByTestId("record-history");
    await waitFor(() =>
      expect(within(panel).getAllByTestId("record-history-item")).toHaveLength(50),
    );
    // 読んだ後に seq 111・112 が書かれる(112件)。 2ページ目(offset 50)は seq 62〜13。
    historyPages = new Map([
      [0, { items: range(112, 50), total: 112 }],
      [50, { items: range(62, 50), total: 112 }],
    ]);
    fireEvent.click(within(panel).getByRole("button", { name: "さらに読む" }));
    await waitFor(() =>
      expect(within(panel).getAllByTestId("record-history-item")).toHaveLength(98),
    );
    expect(seqs(panel)).toEqual(range(110, 98).map((entry) => entry.seq));
    // undo で seq 111・112 が消える(110件に戻る。最初に読んだ件数と同じ)。 offset 100 は seq 10〜1。
    historyPages = new Map([
      [0, { items: range(110, 50), total: 110 }],
      [50, { items: range(60, 50), total: 110 }],
      [100, { items: range(10, 10), total: 110 }],
    ]);
    fireEvent.click(within(panel).getByRole("button", { name: "さらに読む" }));
    // 直前に読んだ件数(112)より減ったので、読んだ分を捨てて最初のページ(seq 110〜61)に置き換わる。
    await waitFor(() =>
      expect(within(panel).getAllByTestId("record-history-item")).toHaveLength(50),
    );
    expect(seqs(panel)).toEqual(range(110, 50).map((entry) => entry.seq));
    fireEvent.click(within(panel).getByRole("button", { name: "さらに読む" }));
    await waitFor(() =>
      expect(within(panel).getAllByTestId("record-history-item")).toHaveLength(100),
    );
    fireEvent.click(within(panel).getByRole("button", { name: "さらに読む" }));
    await waitFor(() =>
      expect(within(panel).getAllByTestId("record-history-item")).toHaveLength(110),
    );
    expect(seqs(panel)).toEqual(range(110, 110).map((entry) => entry.seq));
    expect(within(panel).queryByRole("button", { name: "さらに読む" })).toBeNull();
  });
});
