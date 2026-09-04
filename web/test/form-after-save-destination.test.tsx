/**
 * **保存が成立したあとの行き先の器**(`V4-M20-T04`。`ADR-0102` 限定7・限定8)。
 *
 * **宣言と器を同じ差分に入れている**(`ADR-0086` 限定4 / `T04` 完了条件5)。
 *
 * ## この検査が言えないこと(**先に書く。誇張しない**)
 *
 * 1. **【禁止】「確認の段ができた」と書かない** —— **`E-G33` は1ミリも解けていない。**
 * 2. **【`V10-M2-T01` / `NV-G1` / `ADR-0357` 限定3a-2 で引き直した。旧文を1バイトも消していない】**
 *    **着手前の逐語は「**【禁止】「保存した行の詳細へ行く先を選べる」と書かない** —— **宣言した
 *    行き先へは `recordId` を渡さない。** レコードを伴う遷移は今日も既定の1段目だけである。」だった。**
 *    **今日は偽である** —— **同じテーブルの `detail_view` を指した宣言にだけ、保存が成立した
 *    行1件の `_id` が渡る。** **【禁止】これを「一続きの流れができた」と書かない**
 *    (限定3a-8)—— **運ぶのは `_id` 1本だけであり、別テーブルの詳細を指した宣言は
 *    今日どおりエラー画面のままである。**
 * 2a. **【`V10-M2-T02` / `NV-G2` / `ADR-0357` 限定3b-7 で引き直した。旧文を1バイトも消していない】**
 *    **着手前の逐語は「**【禁止】「新規作成でも作った行の詳細へ行く」と書かない** —— **`V10-M2-T01` が
 *    成立させたのは編集経路だけである**(新規作成は `V10-M2-T02` の担当)。」だった。**
 *    **理由の側だけが今日は偽である** —— **新規作成も `V10-M2-T02` で運ぶようになった。**
 *    **【禁止】それでも「新規作成でも作った行の詳細へ行くようになった」とは書かない**
 *    (限定3b-7)—— **運ぶのは `after_save` に同じテーブルの `detail_view` を書いたときだけで、
 *    宣言が無い新規作成の行き先は今日どおり同じテーブルの `list_view` である**(限定3b-2)。
 *    **【禁止】「バグを直した」とも書かない** —— **`ADR-0102` の限定表と §3a が既定を明文で
 *    固定しており、今日の姿は設計どおりである。**
 * 3. **ここは happy-dom であり、chromium で1度も確かめていない。**
 * 4. **`audience` でマニフェストから落ちた画面を「実際にサーバがそう配ること」を
 *    1件も測っていない** —— 本ファイルは「マニフェストにその画面が無ければ既定へ倒れる」
 *    ことだけを測る。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FormView, Manifest } from "../../src/kernel/types.ts";
import type { Role } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { FormRenderer } from "../src/views/FormRenderer.tsx";

const WRITER_ROLE: Role = "owner";
const APP_ID = "sample-app";
const ITEMS_PATH = `/api/apps/${APP_ID}/tables/items/records`;

const CREATED = {
  _id: "item-0001",
  _created_at: "2026-01-01T00:00:00Z",
  _updated_at: "2026-01-01T00:00:00Z",
  name: "机",
};

let originalFetch: typeof fetch;

/**
 * `after_save` と、既定の行き先になりうる画面(同テーブルの `detail_view` / `list_view`)を
 * 出し入れできるフィクスチャ。
 */
function manifestWith(options: {
  afterSave?: string;
  withDetail?: boolean;
  withList?: boolean;
  extraViews?: unknown[];
}): Manifest {
  const views: unknown[] = [
    {
      id: "item-form",
      type: "form",
      table: "items",
      fields: ["name"],
      ...(options.afterSave === undefined ? {} : { after_save: options.afterSave }),
    },
  ];
  if (options.withDetail !== false) {
    views.push({ id: "item-detail", type: "detail_view", table: "items" });
  }
  if (options.withList !== false) {
    views.push({ id: "item-list", type: "list_view", table: "items", columns: ["name"] });
  }
  views.push(...(options.extraViews ?? []));
  return {
    app: {
      id: APP_ID,
      name: "サンプル",
      tables: [
        {
          id: "items",
          name: "備品",
          fields: [{ id: "name", name: "備品名", type: "text", required: true }],
        },
        {
          id: "logs",
          name: "記録",
          fields: [{ id: "note", name: "内容", type: "text" }],
        },
      ],
      views,
    },
  } as unknown as Manifest;
}

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
    if (method === "POST" && url === ITEMS_PATH) {
      return json({ record: CREATED }, 201);
    }
    /*
     * **編集経路(`V10-M2-T01` / `NV-G1`)を描くのに要る2本。**
     * **足さないと `FormRenderer.tsx` の初期取得が `row._updated_at` に届かず、画面が
     * `loading` のまま止まる**(直下の GET は無条件に `{ records: [] }` を返すため)。
     * **フィクスチャに役割の規則が1本も無いので `?view=` は付かない** —— 完全一致で置ける。
     * **更新は `PATCH` である**(`web/src/api.ts` の `updateRecord`。`if-match` を載せる)。
     */
    if (method === "GET" && url === `${ITEMS_PATH}/${CREATED._id}`) {
      return json({ record: CREATED });
    }
    if (method === "PATCH" && url === `${ITEMS_PATH}/${CREATED._id}`) {
      return json({ record: CREATED });
    }
    if (method === "GET") {
      return json({ records: [] });
    }
    return json({ errors: [{ path: "", message: `no stub for ${method} ${url}` }] }, 404);
  }) as typeof fetch;
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/item-form`);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function formView(manifest: Manifest): FormView {
  const view = manifest.app.views[0];
  if (view === undefined || view.type !== "form") {
    throw new Error("fixture broken");
  }
  return view;
}

/** 新規作成して保存し、遷移後の URL を返す。 */
async function submit(manifest: Manifest): Promise<string> {
  render(
    <RoleProvider role={WRITER_ROLE}>
      <FormRenderer appId={APP_ID} manifest={manifest} view={formView(manifest)} />
    </RoleProvider>,
  );
  const input = await screen.findByLabelText(/備品名/);
  fireEvent.change(input, { target: { value: "机" } });
  fireEvent.submit(input.closest("form") as HTMLFormElement);
  await waitFor(() => expect(window.location.pathname).not.toContain("item-form"));
  return window.location.pathname;
}

/**
 * **既存の行を編集して保存し、遷移後の URL を返す**(`V10-M2-T01` / `NV-G1`)。
 *
 * **描き方は既存の先例を写した** —— `web/test/concurrency.test.tsx` の `renderEditForm`
 * と `web/test/form.test.tsx` の `renderForm(manifest, recordId)`。
 * **`recordId` を渡すと `FormRenderer` は行を1件読み、保存は `PATCH` になる。**
 */
async function submitEdit(manifest: Manifest): Promise<string> {
  render(
    <RoleProvider role={WRITER_ROLE}>
      <FormRenderer
        appId={APP_ID}
        manifest={manifest}
        view={formView(manifest)}
        recordId={CREATED._id}
      />
    </RoleProvider>,
  );
  const input = await screen.findByLabelText(/備品名/);
  fireEvent.change(input, { target: { value: "机" } });
  fireEvent.submit(input.closest("form") as HTMLFormElement);
  await waitFor(() => expect(window.location.pathname).not.toContain("item-form"));
  return window.location.pathname;
}

// ---------------------------------------------------------------------------
// (a) 宣言があれば、そこへ行く
// ---------------------------------------------------------------------------

test("(a) after_save を書けば、その画面へ行く(同じテーブルの detail_view より優先する)", async () => {
  const path = await submit(manifestWith({ afterSave: "item-list" }));
  expect(path).toContain("item-list");
  expect(path).not.toContain("item-detail");
});

test("(a) 別テーブルの画面も指せる(書いた表と見せたい表が違う場合)", async () => {
  const path = await submit(
    manifestWith({
      afterSave: "log-list",
      extraViews: [{ id: "log-list", type: "list_view", table: "logs", columns: ["note"] }],
    }),
  );
  expect(path).toContain("log-list");
});

/*
 * **【`V10-M2-T01` / `NV-G1` / `ADR-0357` 限定3a-2 で書き換えた。旧文を1バイトも消していない】**
 * **着手前のテスト名の逐語は「**(a) 宣言した行き先には recordId を渡さない(1ミリも解いていないこと)**」**
 * **であり、本体は `expect(path).not.toContain(CREATED._id);` の1本だった。**
 * **今日は偽である** —— **宣言した行き先がその `form` と同じテーブルの `detail_view` の
 * ときだけ、保存が成立した行1件の `_id` を運ぶ。**
 * **それ以外の行き先(別テーブルの `detail_view` / `list_view` / `report_view` / `form`)へは
 * 今日どおり1バイトも運ばない** —— 直下の4本がそれを固定する。
 */
test("(a) 宣言した行き先が同じテーブルの detail_view なら、保存した行の _id を運ぶ(編集経路)", async () => {
  const path = await submitEdit(manifestWith({ afterSave: "item-detail" }));
  expect(path).toContain("item-detail");
  expect(path).toContain(CREATED._id);
});

test("(a) 別テーブルの detail_view を指したときは _id を運ばない(限定3a-2)", async () => {
  /*
   * **本単位は別テーブルの詳細を直さない**(`ADR-0357` 限定3a-2 / §限界2)——
   * **行き先は開くが、どの行を開くかを読む場所がマニフェストに1つも無い。**
   * **利用者は今日どおり `DetailViewRenderer` のエラー画面を見る。**
   */
  const path = await submitEdit(
    manifestWith({
      afterSave: "log-detail",
      extraViews: [{ id: "log-detail", type: "detail_view", table: "logs" }],
    }),
  );
  expect(path).toContain("log-detail");
  expect(path).not.toContain(CREATED._id);
});

test("(a) list_view を指したときは _id を運ばない(限定3a-2)", async () => {
  const path = await submitEdit(manifestWith({ afterSave: "item-list" }));
  expect(path).toContain("item-list");
  expect(path).not.toContain(CREATED._id);
});

test("(a) report_view を指したときは _id を運ばない(限定3a-2)", async () => {
  const path = await submitEdit(
    manifestWith({
      afterSave: "item-report",
      extraViews: [
        {
          id: "item-report",
          type: "report_view",
          table: "items",
          report: { group_by: [{ field: "name" }], aggregates: [{ type: "count" }] },
        },
      ],
    }),
  );
  expect(path).toContain("item-report");
  expect(path).not.toContain(CREATED._id);
});

test("(a) form を指したときは _id を運ばない(限定3a-2)", async () => {
  /* **行き先のビューIDに `item-form` を部分文字列として含めない**(遷移の待機式が見る名前)。 */
  const path = await submitEdit(
    manifestWith({
      afterSave: "spare-entry",
      extraViews: [{ id: "spare-entry", type: "form", table: "items", fields: ["name"] }],
    }),
  );
  expect(path).toContain("spare-entry");
  expect(path).not.toContain(CREATED._id);
});

/*
 * **【`V10-M2-T02` / `NV-G2` / `ADR-0357` §Decision 2・限定3b-1/3b-2 で書き換えた。
 * 旧文を1バイトも消していない】**
 * **着手前のテスト名の逐語は「**(a) 新規作成では、同じテーブルの detail_view を指していても
 * 今日どおり _id を運ばない**」であり、本体は `submit(...)` の後の
 * `expect(path).toContain("item-detail"); expect(path).not.toContain(CREATED._id);` だった。**
 * **本体に付いていたコメントの逐語も残す** ——
 * 「**`V10-M2-T01`(`NV-G1`)が成立させるのは編集経路だけである**(`ADR-0357` §Context 2
 * の逐語「**編集の保存では `recordId` が `FormRenderer.tsx:307` の時点で既に在る**」)。
 * **新規作成の経路(`recordId === undefined`)は `V10-M2-T02`(`NV-G2`)の担当であり、
 * 本検査は `V10-M2-T02` で「作られた行の `_id` を運ぶ」へ書き換える予定である。**
 * **【禁止】これを「新規作成では運ばないと決めた」と読まない** —— **まだ実装していない
 * だけである**(`ADR-0357` §Decision 2 が受け取ると決めている)。」
 * **今日は偽である** —— **`V10-M2-T02` が `createRecord` の戻り値から `_id` だけを受け、
 * 宣言した行き先が同じテーブルの `detail_view` のときだけ運ぶようになった。**
 * **【禁止】これを「新規作成でも作った行の詳細へ行くようになった」と読まない**(限定3b-7)
 * —— **宣言が無い新規作成の行き先は今日どおり同じテーブルの `list_view` であり、
 * 直下の (b) 群がそれを固定している。**
 */
test("(a) 新規作成でも、宣言した行き先が同じテーブルの detail_view なら、作られた行の _id を運ぶ", async () => {
  /*
   * **運ぶのは `createRecord` が返した行の `_id` 1本だけである**(限定3b-1。
   * 行の他の列を1バイトも使わない)。**受け取る口は `web/src/api.ts` に既に在り、
   * 本タスクは `api.ts` を1バイトも触っていない**(`:625` `return body.record;`)。
   */
  const path = await submit(manifestWith({ afterSave: "item-detail" }));
  expect(path).toContain("item-detail");
  expect(path).toContain(CREATED._id);
});

// ---------------------------------------------------------------------------
// (b) 宣言が無い form の挙動を1文字も変えていない(限定7)
// ---------------------------------------------------------------------------

test("(b) 宣言が無ければ、新規作成は今日どおり同じテーブルの list_view へ行く", async () => {
  const path = await submit(manifestWith({}));
  expect(path).toContain("item-list");
});

test("(b) 宣言が無く list_view も無ければ、今日どおりアプリのビュー一覧へ行く", async () => {
  const path = await submit(manifestWith({ withDetail: false, withList: false }));
  expect(path).toBe(`/apps/${APP_ID}`);
});

// ---------------------------------------------------------------------------
// (c) 指した画面がマニフェストに無ければ、既定へ倒れる(限定8。壊れない)
// ---------------------------------------------------------------------------

test("(c) 指した画面がこのマニフェストに無ければ、既定の行き先へ倒れる(エラーを出さない)", async () => {
  /*
   * **実在しないIDは `referential-integrity.ts` が apply 時に倒しているので、ここに来るのは
   * 「`audience` によってこの人には配られなかった画面」である**(`ADR-0070` 限定3)。
   * **その人だけが既定へ倒れ、保存そのものは成立したままである。**
   */
  const manifest = manifestWith({ afterSave: "hidden-view" });
  const path = await submit(manifest);
  expect(path).toContain("item-list");
  expect(screen.queryByTestId("errors")).toBeNull();
});

test("(c) 指した画面が無く、既定の行き先も無ければアプリのビュー一覧へ倒れる", async () => {
  const path = await submit(
    manifestWith({ afterSave: "hidden-view", withDetail: false, withList: false }),
  );
  expect(path).toBe(`/apps/${APP_ID}`);
});
