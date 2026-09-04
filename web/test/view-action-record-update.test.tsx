/**
 * **詳細画面の操作起点の2つ目の形の器**(`V4-M20-T01`。`ADR-0100` 限定1・限定4・限定6・限定7)。
 *
 * **宣言(`schemas/manifest.schema.json` + `src/kernel/`)と器(本ファイルが固定する描画と
 * 押下)を同じ差分に入れている**(`ADR-0086` 限定4 / `T01` 完了条件4)—— **「書けるが
 * 効かない」状態を1コミットも作らない。**
 *
 * ## この検査が言えないこと(**先に書く。誇張しない**)
 *
 * 1. **【禁止】「ボタンで処理を走らせられるようになった」と書かない** —— 走るのは
 *    `on_update` のワークフローであって、名指しで選んだワークフローではない。
 *    **`trigger.type` は今日も3種である。**
 * 2. **【禁止】「二重押しが防げる」と書かない** —— **冪等ではない。**(e) が
 *    **2回押せば2回書き込まれる**ことを実測で固定する。
 * 3. **ここは happy-dom であり、CSS を1バイトも計算していない。** chromium でも
 *    1度も確かめていない(`web/e2e` に本形の検査を1本も足していない)。
 * 4. **サーバを1バイトも動かしていない。** `fetch` はスタブであり、**`writable_by` /
 *    ロール / `If-Match` の CAS が実際に効くことを、この検査は示していない** ——
 *    示しているのは「表示層が同じ経路(`PATCH` + `If-Match`)を通ること」だけである。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { DetailView, Manifest } from "../../src/kernel/types.ts";
import type { Role } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { DetailViewRenderer } from "../src/views/DetailViewRenderer.tsx";
import { grantRules, viewRead } from "./role-rules.ts";

const APP_ID = "sample-app";
const RECORD_ID = "entry-0001";
const ENTRIES_PATH = `/api/apps/${APP_ID}/tables/entries/records`;

const ENTRY_ROW = {
  _id: RECORD_ID,
  _created_at: "2026-01-01T00:00:00Z",
  _updated_at: "2026-01-02T00:00:00Z",
  f_a: "あ",
  status: "受付",
};

/** 押下で送られた `PATCH` の記録(本文・ヘッダ・URL)。 */
type PatchLog = { url: string; body: unknown; ifMatch: string | null };
let patches: PatchLog[] = [];
/** `PATCH` が返す応答。テストごとに差し替える。 */
let patchResponse: { status: number; body: unknown } = {
  status: 200,
  body: { record: { ...ENTRY_ROW, status: "完了", _updated_at: "2026-01-03T00:00:00Z" } },
};
/** `navigate` が呼ばれたら URL が変わる。**形 (ii) は遷移しない**((d) が固定)。 */
let originalFetch: typeof fetch;

function manifestWith(actions: NonNullable<DetailView["actions"]>): Manifest {
  const built = {
    app: {
      id: APP_ID,
      name: "サンプル",
      tables: [
        {
          id: "entries",
          name: "エントリ",
          fields: [
            { id: "f_a", name: "項目A", type: "text", required: true },
            { id: "status", name: "状態", type: "select", options: ["受付", "完了"] },
          ],
        },
        {
          id: "targets",
          name: "参照先",
          fields: [
            { id: "label", name: "名前", type: "text", required: true },
            { id: "st_owner", name: "所有者", type: "text" },
            { id: "parent", name: "親", type: "reference", reference_table: "entries" },
          ],
        },
      ],
      views: [
        { id: "entry-detail", type: "detail_view", table: "entries", actions },
        { id: "target-form", type: "form", table: "targets", fields: ["label", "parent"] },
      ],
    },
  } as unknown as Manifest;
  // **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65`】既定が「閉じる」側へ倒れたので、
  // 規則を1本も書かない題材では**形 (i) の行き先 `target-form` を開けない**と判定され、
  // 遷移の側のボタンが1つも描かれない(`DetailViewRenderer` が `canUseView` を見る)。
  // **足すのはこの検査の主題に要る最小限だけである** —— **行き先1画面 × 読取 ×
  // `owner`(既定のロール)。** **形 (ii)(`set`)は行き先が無いので1本も要らず、
  // (c) の `viewer` にも1本も足していない**(あちらを止めているのは `canWriteRole` である)。
  return grantRules(built, ["owner"], [viewRead("target-form")]);
}

/** 形 (ii): 値の書換。 */
const SET_ACTION = {
  set: { field: "status", value: "完了" },
  name: "完了にする",
} as NonNullable<DetailView["actions"]>[number];
/** 形 (i): 遷移(今日どおり。1バイトも変えていない)。 */
const NAVIGATE_ACTION = {
  form: "target-form",
  prefill: { field: "parent" },
  name: "カートに入れる",
} as NonNullable<DetailView["actions"]>[number];

beforeEach(() => {
  patches = [];
  patchResponse = {
    status: 200,
    body: { record: { ...ENTRY_ROW, status: "完了", _updated_at: "2026-01-03T00:00:00Z" } },
  };
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (method === "PATCH") {
      const headers = new Headers(init?.headers ?? {});
      patches.push({
        url,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        ifMatch: headers.get("if-match"),
      });
      return json(patchResponse.body, patchResponse.status);
    }
    if (method === "GET" && url === `${ENTRIES_PATH}/${RECORD_ID}`) {
      return json({ record: ENTRY_ROW });
    }
    if (method === "GET" && url.startsWith(ENTRIES_PATH)) {
      return json({ records: [ENTRY_ROW] });
    }
    if (method === "GET" && url.includes("/tables/targets/records")) {
      return json({ records: [] });
    }
    return json({ errors: [{ path: "", message: `no stub for ${method} ${url}` }] }, 404);
  }) as typeof fetch;
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/entry-detail/records/${RECORD_ID}`);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function detailView(manifest: Manifest): DetailView {
  const view = manifest.app.views[0];
  if (view === undefined || view.type !== "detail_view") {
    throw new Error("fixture broken");
  }
  return view;
}

async function renderDetail(manifest: Manifest, role: Role = "owner"): Promise<void> {
  render(
    <RoleProvider role={role}>
      <DetailViewRenderer
        appId={APP_ID}
        manifest={manifest}
        view={detailView(manifest)}
        recordId={RECORD_ID}
      />
    </RoleProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("detail-field-f_a")).toBeDefined());
}

// ---------------------------------------------------------------------------
// (a) 描かれる —— 宣言と器が同じ差分で揃っている
// ---------------------------------------------------------------------------

test("(a) 形 (ii) の操作起点がボタンとして描かれ、宣言した表示名が出る", async () => {
  await renderDetail(manifestWith([SET_ACTION]));
  const button = screen.getByTestId("action-set-status");
  expect(button.textContent).toBe("完了にする");
});

test("(a) 表示名を書かなければ既定の文言が出る(壊れない)", async () => {
  await renderDetail(manifestWith([{ set: { field: "status", value: "完了" } } as never]));
  expect(screen.getByTestId("action-set-status").textContent).not.toBe("");
});

test("(a) 形 (i) と形 (ii) は同じ器に並ぶ(遷移の側は1バイトも変えていない)", async () => {
  await renderDetail(manifestWith([NAVIGATE_ACTION, SET_ACTION]));
  expect(screen.getByTestId("action-origin-target-form")).toBeDefined();
  expect(screen.getByTestId("action-set-status")).toBeDefined();
});

// ---------------------------------------------------------------------------
// (b) 押すと既存のレコード更新経路(PATCH + If-Match)を通る(限定6)
// ---------------------------------------------------------------------------

test("(b) 押すと対象レコードへ PATCH が1本飛び、本文は宣言した1フィールド1値だけである", async () => {
  await renderDetail(manifestWith([SET_ACTION]));
  screen.getByTestId("action-set-status").click();
  await waitFor(() => expect(patches).toHaveLength(1));
  const patch = patches[0];
  expect(patch?.url).toBe(`${ENTRIES_PATH}/${RECORD_ID}`);
  expect(patch?.body).toEqual({ status: "完了" });
});

test("(b) If-Match には読み込んだレコードの _updated_at が載る(CAS を外していない)", async () => {
  await renderDetail(manifestWith([SET_ACTION]));
  screen.getByTestId("action-set-status").click();
  await waitFor(() => expect(patches).toHaveLength(1));
  expect(patches[0]?.ifMatch).toBe(ENTRY_ROW._updated_at);
});

test("(b) 書き込み後、画面の値が更新後のものに変わる", async () => {
  await renderDetail(manifestWith([SET_ACTION]));
  expect(screen.getByTestId("detail-field-status").textContent).toContain("受付");
  screen.getByTestId("action-set-status").click();
  await waitFor(() =>
    expect(screen.getByTestId("detail-field-status").textContent).toContain("完了"),
  );
});

// ---------------------------------------------------------------------------
// (c) 権限 —— 書けない相手にはボタンを出さない(先回りガード。最終防衛線はサーバ)
// ---------------------------------------------------------------------------

test("(c) viewer には形 (ii) のボタンを1つも出さない", async () => {
  await renderDetail(manifestWith([SET_ACTION]), "viewer");
  expect(screen.queryByTestId("action-set-status")).toBeNull();
});

test("(c) 403 が返ったら「書き込み権限がありません」を出し、画面を進めない", async () => {
  patchResponse = { status: 403, body: { errors: [{ path: "", message: "権限がありません" }] } };
  await renderDetail(manifestWith([SET_ACTION]));
  screen.getByTestId("action-set-status").click();
  await waitFor(() => expect(screen.getByTestId("write-forbidden")).toBeDefined());
  expect(screen.getByTestId("detail-field-status").textContent).toContain("受付");
});

test("(c) 409(版不一致)が返ったら衝突の表示を出す", async () => {
  patchResponse = {
    status: 409,
    // **`web/src/api.ts` の `VERSION_CONFLICT_MARKER`(逐語「変更されています」)で
    // 判定される。** サーバの文面をそのまま置く(`web/test/concurrency.test.tsx` と同型)。
    body: {
      errors: [
        {
          path: "",
          message:
            'テーブル "entries" のレコード "entry-0001" は、あなたが取得した後に別の操作で変更されています。',
        },
      ],
    },
  };
  await renderDetail(manifestWith([SET_ACTION]));
  screen.getByTestId("action-set-status").click();
  await waitFor(() => expect(screen.getByTestId("write-conflict")).toBeDefined());
});

// ---------------------------------------------------------------------------
// (d) 形 (ii) は遷移しない(限定1。2形の意味が混ざっていない)
// ---------------------------------------------------------------------------

test("(d) 押しても URL が1バイトも変わらない(遷移しない)", async () => {
  const before = window.location.pathname;
  await renderDetail(manifestWith([SET_ACTION]));
  screen.getByTestId("action-set-status").click();
  await waitFor(() => expect(patches).toHaveLength(1));
  expect(window.location.pathname).toBe(before);
});

// ---------------------------------------------------------------------------
// (e) 冪等ではない(ADR-0100 §限界1)。**「防げるようになった」と書かないための実測**
// ---------------------------------------------------------------------------

test("(e) 2回押せば2回書き込まれる(冪等ではない)", async () => {
  await renderDetail(manifestWith([SET_ACTION]));
  const button = screen.getByTestId("action-set-status");
  button.click();
  await waitFor(() => expect(patches).toHaveLength(1));
  button.click();
  await waitFor(() => expect(patches).toHaveLength(2));
  expect(patches[0]?.body).toEqual({ status: "完了" });
  expect(patches[1]?.body).toEqual({ status: "完了" });
});
