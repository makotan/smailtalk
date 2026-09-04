/**
 * detail_view 汎用コンポーネントのコンポーネントテスト(V0-P3-T06)。
 *
 * 確認するのは「マニフェストの detail_view 定義を解釈して1レコードを描く」ことだけ:
 *   1. 対象テーブルの**全フィールド**が、型に応じた形式で出る
 *      (`DetailView` は `columns` / `fields` を持たない = 選ぶ語彙が無いため)
 *   2. その表示が list_view のセルと**同一**である(表示形式の実装が1つしかないこと)
 *   3. 編集(form)への導線が、対象レコードID 付きで遷移する / form が無くても壊れない
 *   4. 削除が確認を経て `deleteRecord` を正しい引数で呼び、成功後は一覧へ戻る
 *   5. 読み込み中 / レコード不在(404)/ 削除失敗 / URL にレコードID が無い
 *
 * ここに出てくるアプリ固有の名前はこのテストファイル内だけのフィクスチャであり、
 * 実装側には現れない(CP-3 確認方法4)。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DetailView, ListView, Manifest } from "../../src/kernel/types.ts";
import type { Role } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";

/**
 * **書ける立場**(`V4-M2-T06`)。**文字列リテラルで `role="owner"` と書くと biome の
 * a11y 規則(`useValidAriaRole`)が HTML の `role` 属性と誤認するので、変数経由で渡す**
 * (`web/test/authz.test.tsx` が `role={role}` と書いているのと同じ形)。
 */
const WRITER_ROLE: Role = "owner";

import { DetailViewRenderer } from "../src/views/DetailViewRenderer.tsx";
import { ListViewRenderer } from "../src/views/ListViewRenderer.tsx";
import { grantRules, viewRead } from "./role-rules.ts";

const APP_ID = "sample-app";
const RECORD_ID = "entry-0001";
const TARGET_ID = "target-0001";

/** 7型すべてと reference 先テーブルを含むフィクスチャ。 */
function sampleManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "サンプル",
      tables: [
        {
          id: "targets",
          name: "参照先",
          fields: [{ id: "label", name: "名前", type: "text", required: true }],
        },
        {
          id: "entries",
          name: "エントリ",
          fields: [
            { id: "f_text", name: "テキスト", type: "text", required: true },
            { id: "f_long", name: "長文", type: "long_text" },
            { id: "f_num", name: "数値", type: "number" },
            { id: "f_bool", name: "真偽", type: "boolean" },
            { id: "f_date", name: "日付", type: "date" },
            { id: "f_select", name: "選択", type: "select", options: ["alpha", "beta"] },
            { id: "f_ref", name: "参照", type: "reference", reference_table: "targets" },
          ],
        },
      ],
      views: [
        {
          id: "entry-list",
          type: "list_view",
          table: "entries",
          // detail は全フィールドを出すので、あえて一部だけの列にしてある。
          columns: ["f_text", "f_bool", "f_ref"],
        },
        {
          id: "entry-form",
          type: "form",
          table: "entries",
          fields: ["f_text", "f_long", "f_num"],
        },
        { id: "entry-detail", type: "detail_view", table: "entries" },
      ],
    },
  };
}

function detailView(manifest: Manifest, viewId = "entry-detail"): DetailView {
  const view = manifest.app.views.find((candidate) => candidate.id === viewId);
  if (view === undefined || view.type !== "detail_view") {
    throw new Error(`fixture broken: ${viewId}`);
  }
  return view;
}

function listView(manifest: Manifest): ListView {
  const view = manifest.app.views.find((candidate) => candidate.type === "list_view");
  if (view === undefined || view.type !== "list_view") {
    throw new Error("fixture broken: list_view がない");
  }
  return view;
}

const ENTRY_ROW = {
  _id: RECORD_ID,
  _created_at: "2026-01-01T00:00:00Z",
  _updated_at: "2026-01-02T00:00:00Z",
  f_text: "いちばん",
  f_long: "そこそこ長い文章",
  f_num: 42,
  f_bool: true,
  f_date: "2026-07-18T00:00:00Z",
  f_select: "beta",
  f_ref: TARGET_ID,
};

const TARGET_ROWS = [{ _id: TARGET_ID, _created_at: "", _updated_at: "", label: "参照先の名前" }];

type StubRequest = { url: string; method: string };

const ENTRIES_PATH = `/api/apps/${APP_ID}/tables/entries/records`;
const TARGETS_PATH = `/api/apps/${APP_ID}/tables/targets/records`;
/** 関連レコード(related)の子テーブル(EC-G17 / ADR-0044)。 */
const NOTES_PATH = `/api/apps/${APP_ID}/tables/notes/records`;

let requests: StubRequest[];
let originalFetch: typeof fetch;
/** `${method} ${url}` → [status, body]。body が undefined ならボディ無し(204)。 */
let responses: Map<string, [number, unknown]>;
let entryRow: Record<string, unknown> | undefined;
/** related の子レコード(未設定なら related のテストではないので取りに来ない)。 */
let noteRows: Record<string, unknown>[] | undefined;

function jsonResponse(body: unknown, status: number): Response {
  if (body === undefined) {
    return new Response(null, { status });
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  requests = [];
  responses = new Map();
  entryRow = ENTRY_ROW;
  noteRows = undefined;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    requests.push({ url, method });

    const stubbed = responses.get(`${method} ${url}`);
    if (stubbed !== undefined) {
      return jsonResponse(stubbed[1], stubbed[0]);
    }
    if (method === "GET" && url === `${ENTRIES_PATH}/${RECORD_ID}`) {
      if (entryRow === undefined) {
        return jsonResponse(
          { errors: [{ path: "", message: `レコード "${RECORD_ID}" が見つかりません。` }] },
          404,
        );
      }
      return jsonResponse({ record: entryRow }, 200);
    }
    if (method === "GET" && url.startsWith(TARGETS_PATH)) {
      return jsonResponse({ records: TARGET_ROWS }, 200);
    }
    if (method === "GET" && url.startsWith(NOTES_PATH)) {
      return jsonResponse({ records: noteRows ?? [] }, 200);
    }
    if (method === "GET" && url.startsWith(ENTRIES_PATH)) {
      return jsonResponse({ records: entryRow === undefined ? [] : [entryRow] }, 200);
    }
    if (method === "DELETE" && url === `${ENTRIES_PATH}/${RECORD_ID}`) {
      return jsonResponse(undefined, 204);
    }
    return jsonResponse({ errors: [{ path: "", message: `no stub for ${method} ${url}` }] }, 404);
  }) as typeof fetch;
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/entry-detail/records/${RECORD_ID}`);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

/**
 * **【V4-M2-T06 / `ADR-0074` 限定6 で `RoleProvider` を足した】**
 *
 * **着手前はレンダラを裸で描いており、`useRole()` が `null` を返しても
 * `canWriteRole(null)` が `true` だったので編集・削除のボタンが出ていた。**
 * **`ADR-0074` 限定6 がその既定を `false` に反転させた**(理由は
 * `web/src/auth/authz.tsx` のヘッダと審査記録 §3 の S3-2a)。
 * **本ファイルが測るのは詳細画面の表示と操作導線なので、書ける立場を明示する側が
 * 本来の意図に近い。** **判定の中身は1つも変えていない。**
 */
function renderDetail(manifest: Manifest = sampleManifest()) {
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

/** URL が対象レコードを指していない場合(既定引数に飲まれないよう別の関数にしてある)。 */
function renderDetailWithoutRecord(manifest: Manifest = sampleManifest()) {
  return render(
    <RoleProvider role={WRITER_ROLE}>
      <DetailViewRenderer
        appId={APP_ID}
        manifest={manifest}
        view={detailView(manifest)}
        recordId={undefined}
      />
    </RoleProvider>,
  );
}

/** 1フィールドの表示要素(値のほう)。 */
async function findFieldValue(fieldId: string): Promise<HTMLElement> {
  return await screen.findByTestId(`detail-field-${fieldId}`);
}

/**
 * detail_view に `fields` を指定したマニフェストを作る(V1-M0-T09 / F-3)。
 *
 * `DetailView`(`src/kernel/types.ts`)は `fields` を持たない —— 本タスクは
 * **カーネルの型を1バイトも変えずに**スキーマ側の禁止(`false`)だけを解いた
 * (ADR-0007 Δ6)。したがって表示層はスキーマが許した形をそのまま読む。
 * ここのキャストはその事実の表明であって、型の抜け道ではない。
 */
function manifestWithDetailFields(fields: string[]): Manifest {
  const manifest = sampleManifest();
  const view = detailView(manifest);
  (view as DetailView & { fields?: string[] }).fields = fields;
  return manifest;
}

describe("表示項目の指定(V1-M0-T09 / F-3)", () => {
  test("fields を指定すると、指定した項目だけが指定した順に出る", async () => {
    renderDetail(manifestWithDetailFields(["f_ref", "f_text", "f_bool"]));
    await findFieldValue("f_text");
    const shown = screen
      .getAllByTestId(/^detail-field-/)
      .map((node) => node.getAttribute("data-field"));
    expect(shown).toEqual(["f_ref", "f_text", "f_bool"]);
    expect(screen.queryByTestId("detail-field-f_num")).toBeNull();
    expect(screen.queryByTestId("detail-field-f_select")).toBeNull();
  });

  test("指定した項目の表示形式は、指定しない場合とまったく同じ", async () => {
    renderDetail(manifestWithDetailFields(["f_num", "f_date", "f_ref"]));
    expect((await findFieldValue("f_num")).textContent).toBe("42");
    expect(screen.getByTestId("detail-field-f_date").textContent).toBe("2026-07-18 00:00:00Z");
    await waitFor(() => {
      expect(screen.getByTestId("detail-field-f_ref").textContent).toBe("参照先の名前");
    });
  });

  test("fields に reference が無ければ参照先テーブルを取りに行かない", async () => {
    renderDetail(manifestWithDetailFields(["f_text"]));
    await findFieldValue("f_text");
    expect(requests.some((request) => request.url.startsWith(TARGETS_PATH))).toBe(false);
  });

  test("存在しないフィールドIDを指定した場合は統一形式のエラーを出す", async () => {
    renderDetail(manifestWithDetailFields(["f_text", "f_nope"]));
    const errors = await screen.findByTestId("errors");
    expect(errors.textContent).toContain("f_nope");
    // 実在するフィールドの候補が出る(F-21 と同じ作法。推測させない)。
    expect(errors.textContent).toContain("f_select");
    // 誤魔化して残りだけ描かない(憲法6)。
    expect(screen.queryByTestId("detail-field-f_text")).toBeNull();
  });
});

describe("全フィールドの表示", () => {
  test("fields を指定しないビューは従来どおり全項目を出す(V1-M0-T09 完了条件2)", async () => {
    renderDetail();
    await findFieldValue("f_text");
    expect(screen.getAllByTestId(/^detail-field-/).length).toBe(7);
  });

  test("対象テーブルの全フィールドが、テーブル定義の順に出る", async () => {
    renderDetail();
    await findFieldValue("f_text");
    const shown = screen
      .getAllByTestId(/^detail-field-/)
      .map((node) => node.getAttribute("data-field"));
    expect(shown).toEqual(["f_text", "f_long", "f_num", "f_bool", "f_date", "f_select", "f_ref"]);
  });

  test("見出しは Field の表示名になる", async () => {
    renderDetail();
    await findFieldValue("f_text");
    for (const name of ["テキスト", "長文", "数値", "真偽", "日付", "選択", "参照"]) {
      expect(screen.getByText(name)).toBeDefined();
    }
  });

  test("型に応じた表示になり、reference は参照先の代表値になる", async () => {
    renderDetail();
    expect((await findFieldValue("f_text")).textContent).toBe("いちばん");
    expect(screen.getByTestId("detail-field-f_num").textContent).toBe("42");
    expect(screen.getByTestId("detail-field-f_date").textContent).toBe("2026-07-18 00:00:00Z");
    expect(screen.getByTestId("detail-field-f_select").textContent).toBe("beta");
    await waitFor(() => {
      expect(screen.getByTestId("detail-field-f_ref").textContent).toBe("参照先の名前");
    });
    expect(screen.getByTestId("detail-field-f_ref").textContent).not.toContain(TARGET_ID);
    expect(screen.getByTestId("detail-field-f_bool").querySelector('[role="img"]')).toBeDefined();
  });

  test("未設定(null)のフィールドは未設定と表示する", async () => {
    entryRow = { ...ENTRY_ROW, f_select: null, f_ref: null };
    renderDetail();
    expect((await findFieldValue("f_select")).textContent).toBe("未設定");
    expect(screen.getByTestId("detail-field-f_ref").textContent).toBe("未設定");
  });

  test("一覧のセルとまったく同じ表示になる(表示形式の実装は1つ)", async () => {
    const manifest = sampleManifest();
    const list = render(
      <ListViewRenderer appId={APP_ID} manifest={manifest} view={listView(manifest)} />,
    );
    await screen.findByTestId("list-table");
    await waitFor(() => {
      expect(list.container.querySelector('td[data-field="f_ref"]')?.textContent).toBe(
        "参照先の名前",
      );
    });
    const fromList = new Map<string, string>();
    for (const cell of list.container.querySelectorAll("td[data-field]")) {
      fromList.set(cell.getAttribute("data-field") ?? "", cell.textContent ?? "");
    }
    cleanup();

    renderDetail(manifest);
    await findFieldValue("f_text");
    await waitFor(() => {
      expect(screen.getByTestId("detail-field-f_ref").textContent).toBe("参照先の名前");
    });
    for (const [fieldId, text] of fromList) {
      expect(screen.getByTestId(`detail-field-${fieldId}`).textContent).toBe(text);
    }
  });
});

describe("編集への導線", () => {
  test("同じテーブルの form へ、対象レコードID 付きで遷移する", async () => {
    renderDetail();
    fireEvent.click(await screen.findByTestId("detail-edit"));
    await waitFor(() => {
      expect(window.location.pathname).toBe(
        `/apps/${APP_ID}/views/entry-form/records/${RECORD_ID}`,
      );
    });
  });

  test("同じテーブルの form が無ければ導線を出さず、壊れない", async () => {
    const manifest = sampleManifest();
    manifest.app.views = manifest.app.views.filter((view) => view.type !== "form");
    renderDetail(manifest);
    await findFieldValue("f_text");
    expect(screen.queryByTestId("detail-edit")).toBeNull();
  });
});

describe("削除", () => {
  test("確認せずにいきなり削除しない", async () => {
    renderDetail();
    fireEvent.click(await screen.findByTestId("detail-delete"));
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
    expect(screen.getByTestId("detail-delete-confirm")).toBeDefined();
  });

  test("確認を取り消すと削除しない", async () => {
    renderDetail();
    fireEvent.click(await screen.findByTestId("detail-delete"));
    fireEvent.click(screen.getByTestId("detail-delete-cancel"));
    expect(screen.queryByTestId("detail-delete-confirm")).toBeNull();
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
  });

  test("確認したら deleteRecord を正しい引数で呼ぶ", async () => {
    renderDetail();
    fireEvent.click(await screen.findByTestId("detail-delete"));
    fireEvent.click(screen.getByTestId("detail-delete-execute"));
    await waitFor(() => {
      expect(requests.some((request) => request.method === "DELETE")).toBe(true);
    });
    expect(requests.find((request) => request.method === "DELETE")?.url).toBe(
      `${ENTRIES_PATH}/${RECORD_ID}`,
    );
  });

  test("成功したら同じテーブルの一覧ビューへ戻る", async () => {
    renderDetail();
    fireEvent.click(await screen.findByTestId("detail-delete"));
    fireEvent.click(screen.getByTestId("detail-delete-execute"));
    await waitFor(() => {
      expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/entry-list`);
    });
  });

  test("一覧ビューが無ければアプリのビュー一覧へ戻る", async () => {
    const manifest = sampleManifest();
    manifest.app.views = manifest.app.views.filter((view) => view.type !== "list_view");
    renderDetail(manifest);
    fireEvent.click(await screen.findByTestId("detail-delete"));
    fireEvent.click(screen.getByTestId("detail-delete-execute"));
    await waitFor(() => {
      expect(window.location.pathname).toBe(`/apps/${APP_ID}`);
    });
  });

  test("削除に失敗したら統一形式のエラーを出し、画面は動かない", async () => {
    responses.set(`DELETE ${ENTRIES_PATH}/${RECORD_ID}`, [
      409,
      { errors: [{ path: "", message: "他から参照されています。", hint: "先に参照を外す" }] },
    ]);
    renderDetail();
    fireEvent.click(await screen.findByTestId("detail-delete"));
    fireEvent.click(screen.getByTestId("detail-delete-execute"));

    const errors = await screen.findByTestId("detail-errors");
    expect(errors.textContent).toContain("他から参照されています。");
    expect(errors.textContent).toContain("先に参照を外す");
    expect(window.location.pathname).toBe(
      `/apps/${APP_ID}/views/entry-detail/records/${RECORD_ID}`,
    );
  });
});

describe("状態", () => {
  test("読み込み中が出る", () => {
    renderDetail();
    expect(screen.getByText(/読み込み中/)).toBeDefined();
  });

  test("レコードが無い(404)ときはカーネルの文面をそのまま出す", async () => {
    entryRow = undefined;
    renderDetail();
    const errors = await screen.findByTestId("errors");
    expect(errors.textContent).toContain(RECORD_ID);
    expect(screen.queryByTestId("detail-field-f_text")).toBeNull();
  });

  test("URL にレコードID が無ければ、その旨を出して取得しに行かない", async () => {
    renderDetailWithoutRecord();
    const errors = await screen.findByTestId("errors");
    expect(errors.textContent.length).toBeGreaterThan(0);
    expect(requests.some((request) => request.url.includes(`${ENTRIES_PATH}/`))).toBe(false);
  });

  test("どの状態でも detail_view のディスパッチ先であることは変わらない", async () => {
    entryRow = undefined;
    renderDetail();
    await screen.findByTestId("errors");
    expect(screen.getByTestId("view-renderer-detail_view")).toBeDefined();
  });
});

describe("マニフェストの不整合", () => {
  test("実在しないテーブルを指す detail_view は黙って隠さずエラーにする", async () => {
    const manifest = sampleManifest();
    detailView(manifest).table = "nope";
    renderDetail(manifest);
    const errors = await screen.findByTestId("errors");
    expect(errors.textContent).toContain("nope");
  });
});

describe("関連レコードの動的表示 related(EC-G17 / ADR-0044)", () => {
  /**
   * 子テーブル notes(entry で entries を参照)を足し、entry-detail に related を差し込む。
   * related = 「今開いている entry を親に持つ notes の一覧」。
   */
  function manifestWithRelated(
    related: NonNullable<DetailView["related"]>,
    manifest: Manifest = sampleManifest(),
  ): Manifest {
    manifest.app.tables.push({
      id: "notes",
      name: "メモ",
      fields: [
        { id: "content", name: "内容", type: "text", required: true },
        { id: "priority", name: "優先度", type: "number" },
        { id: "entry", name: "エントリ", type: "reference", reference_table: "entries" },
      ],
    });
    detailView(manifest).related = related;
    return manifest;
  }

  const NOTE_ROWS = [
    {
      _id: "note-1",
      _created_at: "",
      _updated_at: "",
      content: "最優先メモ",
      priority: 1,
      entry: RECORD_ID,
    },
    {
      _id: "note-2",
      _created_at: "",
      _updated_at: "",
      content: "後回しメモ",
      priority: 5,
      entry: RECORD_ID,
    },
  ];

  test("related の子一覧が、今開いているレコードの _id で絞り込まれて取得・描画される", async () => {
    noteRows = NOTE_ROWS;
    renderDetail(
      manifestWithRelated([{ table: "notes", via: "entry", columns: ["content", "priority"] }]),
    );
    // 自レコード表示は従来どおり出る。
    await findFieldValue("f_text");
    // 子一覧が描画される。
    const related = await screen.findByTestId("related-list");
    expect(related.textContent).toContain("最優先メモ");
    expect(related.textContent).toContain("後回しメモ");
    // 取得は notes を親 id(entry == RECORD_ID)で絞っている。
    const notesRequest = requests.find((request) => request.url.startsWith(NOTES_PATH));
    expect(notesRequest).toBeDefined();
    expect(notesRequest?.url).toContain(`filter.entry=${RECORD_ID}`);
  });

  test("related の sort が子一覧の取得クエリに渡る", async () => {
    noteRows = NOTE_ROWS;
    renderDetail(
      manifestWithRelated([
        {
          table: "notes",
          via: "entry",
          columns: ["content"],
          sort: { field: "priority", order: "desc" },
        },
      ]),
    );
    await screen.findByTestId("related-list");
    const notesRequest = requests.find((request) => request.url.startsWith(NOTES_PATH));
    expect(notesRequest?.url).toContain("sort=priority");
    expect(notesRequest?.url).toContain("order=desc");
  });

  test("related の見出し(name)が出る", async () => {
    noteRows = NOTE_ROWS;
    renderDetail(
      manifestWithRelated([
        { table: "notes", via: "entry", columns: ["content"], name: "このエントリのメモ" },
      ]),
    );
    expect(await screen.findByText("このエントリのメモ")).toBeDefined();
  });

  test("子レコードが無いときは「該当なし」を出す(隠さない)", async () => {
    noteRows = [];
    renderDetail(manifestWithRelated([{ table: "notes", via: "entry", columns: ["content"] }]));
    await findFieldValue("f_text");
    expect((await screen.findByTestId("related-empty")).textContent?.length).toBeGreaterThan(0);
  });

  test("related が無い detail_view は子一覧を取りに行かず、従来どおり描く(後方互換)", async () => {
    renderDetail();
    await findFieldValue("f_text");
    expect(requests.some((request) => request.url.startsWith(NOTES_PATH))).toBe(false);
    expect(screen.queryByTestId("related-list")).toBeNull();
  });
});

describe("ビューからの操作起点 actions(EC-G14 / ADR-0045)", () => {
  /**
   * entry-detail(対象=entries)に操作起点を差し込む。actions は
   * 「entry-form へ遷移し、参照フィールド f_ref を今開いているレコードの _id でプリフィルする」。
   * ここは描画と遷移だけを見る(form の実在・prefill.field の型整合は
   * referential-integrity.test.ts の担当)。
   */
  function manifestWithActions(actions: NonNullable<DetailView["actions"]>): Manifest {
    const manifest = sampleManifest();
    detailView(manifest).actions = actions;
    // **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65`】既定が「閉じる」側へ倒れたので、
    // 規則を1本も書かない題材では**遷移先の `entry-form` を開けない**と判定され、
    // この describe が測る操作起点のボタンが1つも描かれない
    // (`DetailViewRenderer` が行き先に対して `canUseView` を見る)。
    // **足すのはこの describe の主題に要る最小限だけである** —— **遷移先1画面 × 読取 ×
    // `owner`(`renderDetail` が渡す `WRITER_ROLE`)。**
    // **`sampleManifest()` そのものには1本も足していない**ので、`actions` を持たない
    // 他の describe の題材は着手前と1バイトも同じである。
    return grantRules(manifest, [WRITER_ROLE], [viewRead("entry-form")]);
  }

  test("actions のボタンが表示名で描画される", async () => {
    renderDetail(
      manifestWithActions([
        { form: "entry-form", prefill: { field: "f_ref" }, name: "参照を作る" },
      ]),
    );
    const button = await screen.findByTestId("action-origin-entry-form");
    expect(button.textContent).toContain("参照を作る");
  });

  test("クリックで、遷移先 form へ prefill(開いているレコードの _id)付きで遷移する", async () => {
    renderDetail(
      manifestWithActions([
        { form: "entry-form", prefill: { field: "f_ref" }, name: "参照を作る" },
      ]),
    );
    fireEvent.click(await screen.findByTestId("action-origin-entry-form"));
    await waitFor(() => {
      expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/entry-form`);
    });
    /*
     * **【V5-M24-T01 / L-G17 で書き換えた3本目の検査である】**
     * 着手前(`64fd1a4`)はここで「プリフィルは URL ではなく history.state(一時状態)に載る」
     * と `window.history.state.prefill` を検査し、`window.location.search` が `""` であることを
     * 固定していた。**06 §4-5 (c) が名指ししていたのは2本(`src/shared/route.test.ts:102-113` /
     * `web/test/navigation.test.tsx:312-319`)だけで、この3本目は名指しされていなかった。**
     * 今日はプリフィルがクエリ文字列に載り、`history.state` は `{}` である。
     * **パスは6セグメント(ここでは4セグメント)のままであり、1つも増えていない。**
     */
    expect(window.location.search).toBe(`?prefill.f_ref=${RECORD_ID}`);
    expect(window.history.state).toEqual({});
  });

  test("name 未指定でもボタンは出る(既定文言)", async () => {
    renderDetail(manifestWithActions([{ form: "entry-form", prefill: { field: "f_ref" } }]));
    const button = await screen.findByTestId("action-origin-entry-form");
    expect(button.textContent?.length ?? 0).toBeGreaterThan(0);
  });

  test("複数の操作起点をそれぞれボタンとして描く", async () => {
    renderDetail(
      manifestWithActions([
        { form: "entry-form", prefill: { field: "f_ref" }, name: "参照を作る" },
        { form: "entry-form", prefill: { field: "f_ref" }, name: "もう一度" },
      ]),
    );
    const buttons = await screen.findAllByTestId(/^action-origin-/);
    expect(buttons.length).toBe(2);
  });

  test("actions 無しの detail_view は操作起点を描かない(後方互換)", async () => {
    renderDetail();
    await findFieldValue("f_text");
    expect(screen.queryByTestId("detail-action-origins")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 操作起点の書込権限の判定先(B-G3 / V4-M1)
// ---------------------------------------------------------------------------

/**
 * **操作起点(`actions`)の書込権限は、遷移先 form のテーブルで判定する**(`B-G3`)。
 *
 * ## 何の退行を固定するのか
 *
 * `V2-M6-T04`(`81f7a62`)が `actions` のガードに `&& canWrite` を置いたとき、`canWrite` は
 * `role !== "viewer"` しか見ておらず **customer には出ていた**。`V3-M3-T04`(`822140f`)が
 * `useCanWrite()` を `useCanWrite(table)` に変えたことで、`canWrite` は**いま見ているビューの
 * テーブル**への書込可否になった。その結果、**公開テーブル(`st_public`)の詳細から自分の
 * テーブル(`st_owner`)の form へ遷移する操作起点が、customer から消えた** ——
 * EC のカタログから「カートに入れる」が押せない、という退行である。
 *
 * **押した先で実際に書くのは遷移先 form のテーブルであって、いま見ているテーブルではない。**
 * したがって判定先はそちらでなければならない。
 *
 * ## この退行を固定していたテストは1件も無かった(2026-08-02 実測)
 *
 * `grep -rn 'detail-action-origins' web/test web/e2e` のヒットは
 * **`web/test/detail-view.test.tsx` の「actions 無しの detail_view は操作起点を描かない
 * (後方互換)」1件だけ**で、**内容は別物である**(`actions` が無いときの話であり、
 * 権限判定先を1文字も述べていない)。**「既存の固定は0件」と書かないこと** —— ヒットは
 * 1件ある。**`B-G3` の退行を固定していた**テストが0件だった、が正確な言い方である。
 *
 * ## ここが証明しないこと(先に書く)
 *
 * - **サーバの 403 が効いていること**は証明しない。UI が押させることは書込を許すことでは
 *   ない —— 最終防衛線は `src/server/app.ts` の customer 分岐(`nonAdminTableAccess`)である。
 * - **chromium で実際にそう描かれること**は証明しない(happy-dom は CSS を解決しない)。
 */
describe("操作起点の書込権限は遷移先フォームのテーブルで判定する(B-G3 / V4-M1)", () => {
  /** フィクスチャのテーブルを引く(見つからなければフィクスチャの壊れ)。 */
  function tableOf(manifest: Manifest, tableId: string) {
    const table = manifest.app.tables.find((candidate) => candidate.id === tableId);
    if (table === undefined) {
      throw new Error(`fixture broken: table ${tableId}`);
    }
    return table;
  }

  /**
   * customer から見た2カテゴリが**別々のテーブル**に分かれたフィクスチャ:
   *
   * - `entries`(= 詳細の対象。`entry-detail`)… `st_public` を持つ → **public**
   *   (customer は GET 可・書込 403 = `canWriteRole` は false)
   * - `targets`(= 遷移先 form の対象。`target-form`)… `st_owner` を持つ → **scoped**
   *   (customer は自分の行を読み書きできる = `canWriteRole` は true)
   *
   * 参照 EC の `product-detail`(`product` は `st_public`)→ `cart-line-form`
   * (`cart_line` は `st_owner`)と同じ形である。
   */
  function crossTableManifest(actions: NonNullable<DetailView["actions"]>): Manifest {
    const manifest = sampleManifest();
    tableOf(manifest, "entries").fields.push({ id: "st_public", name: "公開", type: "boolean" });
    tableOf(manifest, "targets").fields.push(
      { id: "st_owner", name: "所有者", type: "text" },
      { id: "parent", name: "親", type: "reference", reference_table: "entries" },
    );
    manifest.app.views.push({
      id: "target-form",
      type: "form",
      table: "targets",
      fields: ["label", "parent"],
    });
    detailView(manifest).actions = actions;
    // **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65`】既定が「閉じる」側へ倒れたので、
    // 規則を1本も書かない題材では**遷移先の2つの form をどちらも開けない**と判定され、
    // **この describe の主題(絞り込みの判定先が遷移先 form のテーブルであること = `B-G3`)を
    // 1件も測れなくなる。**
    //
    // **足すのは、この題材に出てくる遷移先2画面 × 読取 × この describe に出てくる3ロールだけである。**
    // **`entry-form` を `customer` にも足すのは主題を保つためである** —— **customer に対して
    // `entry-form` を落とすのは `canWriteRole`(`entries` は `st_public`)でなければならず、
    // 面で先に落とすと「書けない先へ誘わない」を測らなくなる。**
    // **`viewer` に2本とも足すのも同じ理由である**(あちらを止めるのは `canWriteRole` 1本で
    // あり、面ではない)。**足していない役割・画面は1つも無い、とは書けない** ——
    // **`no-such-form`(fail-closed の検査)は実在しないので規則を書きようがない。**
    return grantRules(
      manifest,
      ["owner", "customer", "viewer"],
      [viewRead("entry-form"), viewRead("target-form")],
    );
  }

  /** ロールを与えて詳細を描く(provider 外は `role === null` = 書込可なので別関数にしてある)。 */
  function renderDetailAsRole(role: Role, manifest: Manifest) {
    return render(
      <RoleProvider role={role}>
        <DetailViewRenderer
          appId={APP_ID}
          manifest={manifest}
          view={detailView(manifest)}
          recordId={RECORD_ID}
        />
      </RoleProvider>,
    );
  }

  /** 遷移先が `targets`(scoped)の操作起点1本。 */
  const TO_SCOPED_FORM: NonNullable<DetailView["actions"]> = [
    { form: "target-form", prefill: { field: "parent" }, name: "カートに入れる" },
  ];
  /** 遷移先が `entries`(public)の操作起点1本。 */
  const TO_PUBLIC_FORM: NonNullable<DetailView["actions"]> = [
    { form: "entry-form", prefill: { field: "f_ref" }, name: "商品を直す" },
  ];

  test("customer: 公開テーブルの詳細でも、遷移先 form が自分のテーブルなら操作起点が出る", async () => {
    renderDetailAsRole("customer", crossTableManifest(TO_SCOPED_FORM));
    expect(await screen.findByTestId("action-origin-target-form")).toBeDefined();
    expect(screen.getByTestId("detail-action-origins")).toBeDefined();
  });

  // =====================================================================================
  // **【`V8-M27-T04` / `T-G5`。2本とも期待値を反転させた。旧のテスト名と旧の期待値を
  //   逐語で残す。検査は1本も消していない】**
  //
  // **旧のテスト名と旧の期待値**:
  //   `customer: 遷移先 form が公開テーブルなら操作起点は出ない(書けない先へ誘わない)`
  //       expect(screen.queryByTestId("action-origin-entry-form")).toBeNull();
  //       expect(screen.queryByTestId("detail-action-origins")).toBeNull();
  //   `customer: 複数の操作起点は、書ける遷移先のぶんだけ出る`
  //       expect(screen.queryByTestId("action-origin-entry-form")).toBeNull();
  //       expect(screen.getAllByTestId(/^action-origin-/).length).toBe(1);
  //
  // **根拠**: **`V8-M27` / 台帳 `T-G5` / ユーザ決定 `D-V8-38`。**
  // **`B-G3`(遷移先フォームの表で判定する)の**切り方**は1バイトも変えていない** ——
  // **判定に使う `canWriteRole` から**表単位の枝**(`nonAdminTableAccess`)を撤去したので、
  // **`customer` が公開テーブルの form へ書けないという前提が消えた。**
  // **`viewer` が落ちること(下の検査)は1バイトも変わっていない** ——
  // **`role === "viewer"` の枝は `canWriteRole` に残っているためである。**
  // =====================================================================================
  test("(反転) customer: 遷移先 form が公開テーブルでも操作起点が出る(旧: 出なかった)", async () => {
    renderDetailAsRole("customer", crossTableManifest(TO_PUBLIC_FORM));
    expect(await screen.findByTestId("action-origin-entry-form")).toBeDefined();
    expect(screen.getByTestId("detail-action-origins")).toBeDefined();
  });

  test("(反転) customer: 複数の操作起点は2本とも出る(旧: 書ける遷移先の1本だけだった)", async () => {
    renderDetailAsRole("customer", crossTableManifest([...TO_SCOPED_FORM, ...TO_PUBLIC_FORM]));
    await screen.findByTestId("action-origin-target-form");
    expect(screen.getByTestId("action-origin-entry-form")).toBeDefined();
    expect(screen.getAllByTestId(/^action-origin-/).length).toBe(2);
  });

  test("customer: 遷移先 form がマニフェストに無ければ操作起点は出ない(fail-closed)", async () => {
    renderDetailAsRole(
      "customer",
      crossTableManifest([{ form: "no-such-form", prefill: { field: "parent" } }]),
    );
    await findFieldValue("f_text");
    expect(screen.queryByTestId("detail-action-origins")).toBeNull();
  });

  test("viewer: 遷移先が自分のテーブルでも操作起点は出ない(既存の挙動を変えていない)", async () => {
    renderDetailAsRole("viewer", crossTableManifest(TO_SCOPED_FORM));
    await findFieldValue("f_text");
    expect(screen.queryByTestId("detail-action-origins")).toBeNull();
  });

  test("owner: 操作起点は出る(既存の挙動を変えていない)", async () => {
    renderDetailAsRole("owner", crossTableManifest(TO_SCOPED_FORM));
    expect(await screen.findByTestId("action-origin-target-form")).toBeDefined();
  });

  /**
   * **`V4-M1` が「解消していない不整合」として固定した形を、`E-G20`(V4-M6)が解いた。**
   *
   * 着手前(`v4-m1.md` §2-1-4)は、customer が公開テーブルの詳細で
   * 「閲覧のみ(書き込み権限がありません)。」を**見ながら**「カートに入れる」を押せた。
   * **`E-G20` が直したのは注記の出し分けだけである** —— **編集する立場に無い相手
   * (customer × 公開テーブル)には、権限の説明を出さない。** **編集/削除の判定先
   * (`view.table`)は1バイトも変えていない**(`B-G3` の切り方 (ii) はそのまま)。
   */
  // **【`V8-M27-T04` / `T-G5`。期待値を反転させた。旧のテスト名と旧の期待値を逐語で残す】**
  // **旧のテスト名**: `customer: 公開テーブルの詳細では「閲覧のみ」注記を出さず、操作起点だけが出る(E-G20)`
  // **旧の期待値(逐語)**:
  //   expect(screen.queryByTestId("detail-edit")).toBeNull();
  //   expect(screen.queryByTestId("detail-delete")).toBeNull();
  // **旧の説明(逐語)**: `// 編集/削除は今までどおり出ない(判定先は view.table のまま)。`
  // **根拠**: **`V8-M27` / 台帳 `T-G5` / ユーザ決定 `D-V8-38`。**
  // **判定先が `view.table` であること(`B-G3` の切り方)は1バイトも変えていない** ——
  // **その表について `canWriteRole` が `false` を返さなくなっただけである。**
  // **`detail-read-only` が出ないことは今日も真である**(書けると判定されているため)。
  // **【正直に書く】`E-G20` が消した「押しても 403 になる導線」が、公開テーブルについては戻った。**
  test("(反転) customer: 公開テーブルの詳細でも編集/削除が出る(「閲覧のみ」注記は今日も出ない)", async () => {
    renderDetailAsRole("customer", crossTableManifest(TO_SCOPED_FORM));
    expect(await screen.findByTestId("action-origin-target-form")).toBeDefined();
    expect(screen.queryByTestId("detail-read-only")).toBeNull();
    expect(screen.getByTestId("detail-edit")).toBeDefined();
    expect(screen.getByTestId("detail-delete")).toBeDefined();
  });

  test("viewer: 「閲覧のみ」注記は今日も出る(E-G20 は viewer の表示を1ミリも変えない)", async () => {
    renderDetailAsRole("viewer", crossTableManifest(TO_SCOPED_FORM));
    await findFieldValue("f_text");
    expect(screen.getByTestId("detail-read-only")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 画面プリセット(ADR-0050 の軸4 / 軸5 / 軸6)
// ---------------------------------------------------------------------------

/**
 * ここが確かめるのは **DOM に何が出るか** だけである。**「実際にそう描かれるか」は
 * `web/e2e/preset.e2e.ts` が chromium の `getComputedStyle` / `getBoundingClientRect` で
 * 見る** —— happy-dom は CSS を解決しないので、ここで `flex-direction` を読んでも
 * 何も証明しない(`web/test/list-view.test.tsx` の軸1〜3 と同じ分担)。
 *
 * **未指定のときに DOM が1バイトも変わらないこと**(D-M2-3 / ADR-0051 限定4)も
 * ここで固定する。属性は1つも出てはならない。
 */

/** `entry-detail` にプリセットを書いたマニフェストを作る。 */
function withDetailPresets(
  presets: Partial<DetailView>,
  manifest: Manifest = sampleManifest(),
): Manifest {
  Object.assign(detailView(manifest), presets);
  return manifest;
}

/** 詳細画面の器(`.detail-view`)。 */
function detailSection(): HTMLElement {
  return screen.getByTestId("view-renderer-detail_view");
}

describe("プリセット 軸4 項目名と値の向き(preset_label_placement)", () => {
  test("未指定なら data-preset-label はどこにも出ない", async () => {
    renderDetail();
    await findFieldValue("f_text");
    expect(detailSection().querySelectorAll("[data-preset-label]")).toHaveLength(0);
  });

  test("stacked は項目の器(dl.detail-fields)の属性に出る", async () => {
    renderDetail(withDetailPresets({ preset_label_placement: "stacked" }));
    await findFieldValue("f_text");
    expect(screen.getByTestId("detail-fields").getAttribute("data-preset-label")).toBe("stacked");
    // **画面の器には出さない** —— 軸4 は `.detail-fields` を経由させることで
    // `related` の子一覧に届かないようにしてある(ADR-0050 §4)。
    expect(detailSection().getAttribute("data-preset-label")).toBeNull();
  });

  test("inline も明示的に属性として出る(既定と同じ見え方でも、書いた値が DOM に残る)", async () => {
    renderDetail(withDetailPresets({ preset_label_placement: "inline" }));
    await findFieldValue("f_text");
    expect(screen.getByTestId("detail-fields").getAttribute("data-preset-label")).toBe("inline");
  });
});

describe("プリセット 軸5 項目の段組数(preset_field_columns)", () => {
  test("未指定なら data-preset-columns はどこにも出ない", async () => {
    renderDetail();
    await findFieldValue("f_text");
    expect(detailSection().querySelectorAll("[data-preset-columns]")).toHaveLength(0);
  });

  test("段組数は項目の器(dl.detail-fields)の属性に文字列として出る", async () => {
    renderDetail(withDetailPresets({ preset_field_columns: 2 }));
    await findFieldValue("f_text");
    expect(screen.getByTestId("detail-fields").getAttribute("data-preset-columns")).toBe("2");
    // 項目そのものは1バイトも変えていない(段組は器が持つ)。
    expect(screen.getAllByTestId(/^detail-field-/).length).toBe(7);
  });

  test("1段組も明示的に属性として出る", async () => {
    renderDetail(withDetailPresets({ preset_field_columns: 1 }));
    await findFieldValue("f_text");
    expect(screen.getByTestId("detail-fields").getAttribute("data-preset-columns")).toBe("1");
  });

  test("軸4 と軸5 は同じ器に同居できる", async () => {
    renderDetail(withDetailPresets({ preset_label_placement: "stacked", preset_field_columns: 2 }));
    await findFieldValue("f_text");
    const list = screen.getByTestId("detail-fields");
    expect(list.getAttribute("data-preset-label")).toBe("stacked");
    expect(list.getAttribute("data-preset-columns")).toBe("2");
  });
});

describe("プリセット 軸6 image の表示サイズ(preset_image_size)", () => {
  test("未指定なら data-preset-image はどこにも出ない", async () => {
    renderDetail();
    await findFieldValue("f_text");
    expect(detailSection().querySelectorAll("[data-preset-image]")).toHaveLength(0);
    expect(detailSection().getAttribute("data-preset-image")).toBeNull();
  });

  test("画像サイズは画面の器(section.detail-view)の属性に出る", async () => {
    renderDetail(withDetailPresets({ preset_image_size: "thumbnail" }));
    await findFieldValue("f_text");
    // **`.detail-view` から始めることで、項目の画像と `related` の子一覧の画像に
    // 1本の規則で当てる**(ADR-0050 §4)。
    expect(detailSection().getAttribute("data-preset-image")).toBe("thumbnail");
    expect(screen.getByTestId("detail-fields").getAttribute("data-preset-image")).toBeNull();
  });

  test("3値のいずれもそのまま属性値になる(自由な文字列は1つも出ない)", async () => {
    for (const size of ["thumbnail", "medium", "original"] as const) {
      renderDetail(withDetailPresets({ preset_image_size: size }));
      await findFieldValue("f_text");
      expect(detailSection().getAttribute("data-preset-image")).toBe(size);
      cleanup();
    }
  });
});

describe("プリセットと related の当たり方(ADR-0050 §4 の表を DOM 構造で確かめる)", () => {
  /** 子テーブル notes を足し、entry-detail に related とプリセットを差し込む。 */
  function manifestWithRelatedAndPresets(presets: Partial<DetailView>): Manifest {
    const manifest = sampleManifest();
    manifest.app.tables.push({
      id: "notes",
      name: "メモ",
      fields: [
        { id: "content", name: "内容", type: "text", required: true },
        { id: "entry", name: "エントリ", type: "reference", reference_table: "entries" },
      ],
    });
    const view = detailView(manifest);
    view.related = [{ table: "notes", via: "entry", columns: ["content"] }];
    Object.assign(view, presets);
    return manifest;
  }

  test("軸6 の器は related の子一覧を含み、軸4・軸5 の器は含まない", async () => {
    noteRows = [
      { _id: "note-1", _created_at: "", _updated_at: "", content: "メモ", entry: RECORD_ID },
    ];
    renderDetail(
      manifestWithRelatedAndPresets({
        preset_image_size: "thumbnail",
        preset_label_placement: "stacked",
        preset_field_columns: 2,
      }),
    );
    await findFieldValue("f_text");
    const table = await screen.findByTestId("related-table");

    // 軸6(画面の器)は子一覧を **含む** = セレクタが `.detail-view` から始まれば当たる。
    const imageScope = detailSection();
    expect(imageScope.getAttribute("data-preset-image")).toBe("thumbnail");
    expect(imageScope.contains(table)).toBe(true);

    // 軸4・軸5(項目の器)は子一覧を **含まない** = `.detail-fields` を経由する規則は届かない。
    const fieldScope = screen.getByTestId("detail-fields");
    expect(fieldScope.getAttribute("data-preset-label")).toBe("stacked");
    expect(fieldScope.getAttribute("data-preset-columns")).toBe("2");
    expect(fieldScope.contains(table)).toBe(false);
    // 子一覧の中にプリセット属性は1つも無い(規則が届く手掛かりが構造上ない)。
    expect(table.querySelectorAll("[data-preset-label], [data-preset-columns]")).toHaveLength(0);
  });
});

describe("プリセット 軸7 long_text の切り詰め長(preset_text_preview)", () => {
  /** 200文字。どの段階値でも必ず切り詰めが起きる長さ。 */
  const LONG = "あいうえおかきくけこ".repeat(20);

  /**
   * **軸7 だけは CSS では実装できない**(切り詰め後の文字列しか DOM に出ないので
   * CSS からは全文を復元できない)。したがって属性ではなく **実際に描かれた文字数**を見る。
   * `related` の子一覧にも当たる(ADR-0050 §4)ので、そちらは下の2本で確かめる。
   */
  function renderWithLongValue(preview?: "short" | "standard" | "long") {
    entryRow = { ...ENTRY_ROW, f_long: LONG };
    const presets: Partial<DetailView> = {};
    if (preview !== undefined) {
      presets.preset_text_preview = preview;
    }
    renderDetail(withDetailPresets(presets));
  }

  async function longTextNode(): Promise<HTMLElement> {
    const cell = await findFieldValue("f_long");
    const node = cell.querySelector('[data-testid="field-value-long_text"]');
    if (node === null) {
      throw new Error("long_text の表示が無い");
    }
    return node as HTMLElement;
  }

  test("未指定なら今日の既定(40文字)のまま切り詰める", async () => {
    renderWithLongValue();
    expect((await longTextNode()).textContent).toBe(`${LONG.slice(0, 40)}…`);
  });

  test("段階値ごとに切り詰め長が変わる(short 20 / standard 40 / long 80)", async () => {
    for (const [preview, length] of [
      ["short", 20],
      ["standard", 40],
      ["long", 80],
    ] as const) {
      renderWithLongValue(preview);
      expect((await longTextNode()).textContent).toBe(`${LONG.slice(0, length)}…`);
      cleanup();
    }
  });

  test("どの段階値でも全文は title に残る", async () => {
    for (const preview of ["short", "standard", "long"] as const) {
      renderWithLongValue(preview);
      expect((await longTextNode()).getAttribute("title")).toBe(LONG);
      cleanup();
    }
  });

  /** 子テーブル notes に long_text を持たせ、related の列に出す。 */
  function manifestWithLongRelated(preview?: "short" | "standard" | "long"): Manifest {
    const manifest = sampleManifest();
    manifest.app.tables.push({
      id: "notes",
      name: "メモ",
      fields: [
        { id: "content", name: "内容", type: "text", required: true },
        { id: "body", name: "本文", type: "long_text" },
        { id: "entry", name: "エントリ", type: "reference", reference_table: "entries" },
      ],
    });
    const view = detailView(manifest);
    view.related = [{ table: "notes", via: "entry", columns: ["content", "body"] }];
    if (preview !== undefined) {
      view.preset_text_preview = preview;
    }
    return manifest;
  }

  test("related の子一覧のセルにも当たる(ADR-0050 §4)", async () => {
    noteRows = [
      {
        _id: "note-1",
        _created_at: "",
        _updated_at: "",
        content: "メモ",
        body: LONG,
        entry: RECORD_ID,
      },
    ];
    renderDetail(manifestWithLongRelated("short"));
    const table = await screen.findByTestId("related-table");
    const node = table.querySelector('[data-testid="field-value-long_text"]');
    expect(node?.textContent).toBe(`${LONG.slice(0, 20)}…`);
    // 切り詰めても全文は捨てない(子一覧でも同じ)。
    expect(node?.getAttribute("title")).toBe(LONG);
  });

  test("related の子一覧も未指定なら今日の既定(40文字)のまま", async () => {
    noteRows = [
      {
        _id: "note-1",
        _created_at: "",
        _updated_at: "",
        content: "メモ",
        body: LONG,
        entry: RECORD_ID,
      },
    ];
    renderDetail(manifestWithLongRelated());
    const table = await screen.findByTestId("related-table");
    expect(table.querySelector('[data-testid="field-value-long_text"]')?.textContent).toBe(
      `${LONG.slice(0, 40)}…`,
    );
  });
});

// ---------------------------------------------------------------------------
// 部品体系での描き直し(V4-M15-T05 / T06 の一部。ADR-0087 / D-V4-44)
// ---------------------------------------------------------------------------

/**
 * **ここが固定するのは「部品体系の器に載ったこと」と「載せ替えで何も落ちていないこと」の
 * 2つだけである。**
 *
 * - **実際にそう描かれるか(計算後のスタイル)は測っていない。** happy-dom は CSS を
 *   解決しないので、ここで読めるのは**クラス名と `data-slot` という手掛かりだけ**である
 *   (上の「画面プリセット」節と同じ分担。実描画は `web/e2e/` の担当)。
 * - **既存の `data-testid` / クラス名 / `data-preset-*` が1つも落ちていないこと**は、
 *   このファイルの他の節がそれぞれの観点で固定し続けている。ここでは載せ替えで
 *   壊れやすい3点(器・幅への対応・0件/読み込み中/エラーの見え方)だけを見る。
 */
describe("部品体系での描き直し(V4-M15-T05 / T06)", () => {
  /** 子テーブル notes を足して related を1つ差し込む(この節のフィクスチャ)。 */
  function manifestWithNotes(): Manifest {
    const manifest = sampleManifest();
    manifest.app.tables.push({
      id: "notes",
      name: "メモ",
      fields: [
        { id: "content", name: "内容", type: "text", required: true },
        { id: "entry", name: "エントリ", type: "reference", reference_table: "entries" },
      ],
    });
    detailView(manifest).related = [{ table: "notes", via: "entry", columns: ["content"] }];
    return manifest;
  }

  test("読み込み中は骨組み(Skeleton)が出る。文言と testid は1文字も変えない", () => {
    renderDetail();
    // 文言はそのまま(利用者から見える言葉を載せ替えで変えない)。
    expect(screen.getByText(/読み込み中/)).toBeDefined();
    const section = screen.getByTestId("view-renderer-detail_view");
    expect(section.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  test("エラーは destructive の Alert に載る(testid は errors のまま)", async () => {
    entryRow = undefined;
    renderDetail();
    const errors = await screen.findByTestId("errors");
    expect(errors.className).toContain("errors");
    const alert = errors.closest('[data-slot="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.getAttribute("data-variant")).toBe("destructive");
  });

  test("子一覧の0件は控えめな一文になる(文言と testid は変わらない)", async () => {
    noteRows = [];
    renderDetail(manifestWithNotes());
    const empty = await screen.findByTestId("related-empty");
    expect(empty.textContent).toBe("該当するレコードはありません。");
    expect(empty.className).toContain("text-muted-foreground");
  });

  test("子一覧の表は横に溢れても読める器に包まれる(D-V4-44)", async () => {
    noteRows = [
      { _id: "note-1", _created_at: "", _updated_at: "", content: "メモ", entry: RECORD_ID },
    ];
    renderDetail(manifestWithNotes());
    const table = await screen.findByTestId("related-table");
    // 既存クラスは残っている(プリセットとテーマの当たり先)。
    expect(table.className).toContain("related-table");
    const frame = table.parentElement;
    expect(frame?.getAttribute("data-slot")).toBe("table-container");
    expect(frame?.className).toContain("overflow-x-auto");
    // 器を1枚挟んでも、軸6 の当たり先は今までどおり画面の器のままである。
    expect(table.closest("[data-preset-image]")).toBeNull();
  });

  test("項目名と値は狭い画面では縦、sm 以上では今までどおり横に戻る(D-V4-44)", async () => {
    renderDetail();
    await findFieldValue("f_text");
    const fields = [...screen.getByTestId("detail-fields").querySelectorAll(".detail-field")];
    expect(fields.length).toBe(7);
    for (const field of fields) {
      expect(field.className).toContain("detail-field");
      expect(field.className).toContain("flex-col");
      expect(field.className).toContain("sm:flex-row");
    }
  });

  test("preset_label_placement を書いた画面には幅の分岐が1つも出ない(プリセットが勝つ)", async () => {
    for (const placement of ["inline", "stacked"] as const) {
      renderDetail(withDetailPresets({ preset_label_placement: placement }));
      await findFieldValue("f_text");
      const list = screen.getByTestId("detail-fields");
      expect(list.getAttribute("data-preset-label")).toBe(placement);
      for (const field of list.querySelectorAll(".detail-field")) {
        expect(field.className, placement).not.toContain("flex-col");
        expect(field.className, placement).not.toContain("sm:");
        for (const label of field.querySelectorAll("dt")) {
          expect(label.className, placement).not.toContain("basis");
        }
      }
      cleanup();
    }
  });

  test("編集・削除・操作起点はボタン部品になる(testid は変わらない)", async () => {
    const manifest = sampleManifest();
    detailView(manifest).actions = [{ form: "entry-form", prefill: { field: "f_ref" } }];
    // **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65`】既定が「閉じる」側へ倒れたので、
    // 規則を1本も書かないと**遷移先の `entry-form` を開けない**と判定され、
    // 操作起点のボタンが描かれない = 「ボタン部品になる」を測れない。
    // **足すのは遷移先1画面 × 読取 × `owner` の1本だけである**
    // (編集・削除の2つは面を1本も見ていないので、この1本は測る対象を増やしていない)。
    grantRules(manifest, [WRITER_ROLE], [viewRead("entry-form")]);
    renderDetail(manifest);
    await findFieldValue("f_text");
    for (const testId of ["detail-edit", "detail-delete", "action-origin-entry-form"]) {
      expect(screen.getByTestId(testId).getAttribute("data-slot"), testId).toBe("button");
    }
    expect(screen.getByTestId("detail-delete").getAttribute("data-variant")).toBe("destructive");
  });

  test("重ねて出す表現(モーダル)を1つも作っていない —— 削除の確認はその場に開く", async () => {
    renderDetail();
    await findFieldValue("f_text");
    fireEvent.click(screen.getByTestId("detail-delete"));
    const confirm = await screen.findByTestId("detail-delete-confirm");
    expect(confirm.closest('[role="dialog"]')).toBeNull();
    expect(screen.getByTestId("detail-delete-execute").getAttribute("data-slot")).toBe("button");
    expect(screen.getByTestId("detail-delete-cancel").getAttribute("data-slot")).toBe("button");
  });
});
