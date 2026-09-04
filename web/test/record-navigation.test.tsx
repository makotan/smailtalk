/**
 * レコード間の遷移(V3-M3-T02)。
 *
 * 完了条件の正は `docs/plan/v3/records/v3-m3.md` §2 の「V3-M3-T02」節(6点)、
 * 審査の正は `docs/plan/v3/records/v3-m3-gate-a-navigation.md` §1(判定 = 将来送り。
 * 送り先が本タスク)。**判定値・限定をここへ転記しない。**
 *
 * ## 何を固定しているか
 *
 * 1. **`related` の子行から子テーブルの `detail_view` へ遷移する。** 遷移先の決め方は
 *    `resolveDetailViewTarget`(`web/src/navigation.tsx`)ただ1つであり、**候補が2つ以上でも
 *    定義順の先頭**になる(規約をここで再実装していないことを、一覧と同じ結果になることで見る)。
 * 2. **遷移先が無ければ子行はクリックできないまま**である(一覧と同じ規約)。
 * 3. **`reference` セルから参照先テーブルの `detail_view` へ遷移する。****3箇所すべて**で
 *    リンクになる —— **一覧のセル** / 詳細の項目 / `related` の子行のセル。
 * 4. **参照切れ(`found === false`)はリンクにしない。** 「見つかったが代表値が引けない」
 *    (`found === true` で表示が `_id`)は**リンクにする** —— この2つを混同しない。
 * 5. **行クリックとセル内リンクが二重発火しない。** クリックできる行(一覧の行・`related` の
 *    子行)の中の参照リンクを押したときに行の遷移が起きないこと(逆に、リンクでないセルを
 *    押したときは行の遷移が起きること)。**リンク上の Enter でも行は開かない。**
 * 6. **遷移先が2つ以上あるときの注記**が、増えた遷移点すべてに出る(ユーザ決定 D-M3-6)。
 *    判定は一覧の行の注記と同じ(**遷移先が実在し、かつ同テーブルの `detail_view` が2つ以上**)。
 *    **行の注記(`list-detail-target-note`)と参照の注記(`reference-detail-target-note`)は
 *    別の遷移点なので testid を分ける。**
 *
 * ## 何を証明しないか
 *
 * - **描画は解いていない。** happy-dom は CSS を適用しないので、リンクや行が「押せるように
 *   見える」ことは1つも証明していない。**画面で実際にクリックして遷移することの実証は
 *   `web/e2e/record-navigation.e2e.ts`(chromium)が担う。**
 * - **注記のうるささ(同じ画面に注記が複数出ること)を評価していない。** 出る条件だけを固定する。
 * - **`form` の参照ピッカー(`fields/input.tsx`)は対象外である。** そこは値を選ぶ入力欄で
 *   あって読み取りの表示ではない。**「参照が出る場所すべてが遷移点になった」わけではない。**
 *
 * ここに出てくるアプリ固有の名前はこのファイル内のフィクスチャであり、実装側には現れない。
 *
 * ## **【`V10-M18-T02`(`FU-G2`)の追記。上の行を1バイトも消していない】**
 *
 * **上の 6 は今日の実物ではない。** **ユーザ決定 `D-V10-21` が選んだ見出しは
 * 「出すのをやめる」**なので、**注記は増えた遷移点のどこにも出ない。**
 * **`testid` を分けていたこと自体も、今日は DOM に現れない。**
 * **「何を証明しないか」の3行目(注記のうるささ)も、注記が無いので測る対象が無い。**
 *
 * **遷移そのもの(上の 1〜5)は1ビットも変えていない** —— 本ファイルの他の節が
 * 1本も赤くならないことが、その担保である。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import type { DetailView, FormView, Manifest } from "../../src/kernel/types.ts";
import type { Role } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { DetailViewRenderer } from "../src/views/DetailViewRenderer.tsx";
import { FormRenderer } from "../src/views/FormRenderer.tsx";
import { ListViewRenderer } from "../src/views/ListViewRenderer.tsx";

const APP_ID = "sample-app";
const RECORD_ID = "entry-0001";
const TARGET_ID = "target-0001";
const NOTE_ID = "note-0001";

/**
 * 親 entries / 子 notes / 参照先 targets の3テーブル。
 *
 * - `entries.f_ref` → `targets`(詳細画面の**項目**に出る参照)
 * - `notes.entry` → `entries`(`related` の親条件)
 * - `notes.tag` → `targets`(`related` の**子行のセル**に出る参照)
 */
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
            { id: "f_ref", name: "参照", type: "reference", reference_table: "targets" },
          ],
        },
        {
          id: "notes",
          name: "メモ",
          fields: [
            { id: "content", name: "内容", type: "text", required: true },
            { id: "entry", name: "エントリ", type: "reference", reference_table: "entries" },
            { id: "tag", name: "タグ", type: "reference", reference_table: "targets" },
          ],
        },
      ],
      views: [
        {
          id: "entry-detail",
          type: "detail_view",
          table: "entries",
          related: [{ table: "notes", via: "entry", columns: ["content", "tag"] }],
        },
        { id: "note-detail", type: "detail_view", table: "notes" },
        { id: "target-detail", type: "detail_view", table: "targets" },
        // 一覧の参照セル(3箇所目の遷移点)を確かめるための一覧。
        { id: "entry-list", type: "list_view", table: "entries", columns: ["f_text", "f_ref"] },
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

/** マニフェストからビューを1つ落とす(遷移先が無い状態を作る)。 */
function withoutView(manifest: Manifest, viewId: string): Manifest {
  manifest.app.views = manifest.app.views.filter((candidate) => candidate.id !== viewId);
  return manifest;
}

/** 同じテーブルの2つ目の detail_view を足す(注記が出る状態を作る)。 */
function withSecondDetailView(manifest: Manifest, source: string, added: string): Manifest {
  const original = detailView(manifest, source);
  manifest.app.views.push({ id: added, type: "detail_view", table: original.table });
  return manifest;
}

const ENTRY_ROW = {
  _id: RECORD_ID,
  _created_at: "",
  _updated_at: "",
  f_text: "いちばん",
  f_ref: TARGET_ID,
};

const TARGET_ROWS = [{ _id: TARGET_ID, _created_at: "", _updated_at: "", label: "参照先の名前" }];

const NOTE_ROWS = [
  {
    _id: NOTE_ID,
    _created_at: "",
    _updated_at: "",
    content: "メモ",
    entry: RECORD_ID,
    tag: TARGET_ID,
  },
];

const ENTRIES_PATH = `/api/apps/${APP_ID}/tables/entries/records`;
const TARGETS_PATH = `/api/apps/${APP_ID}/tables/targets/records`;
const NOTES_PATH = `/api/apps/${APP_ID}/tables/notes/records`;

let originalFetch: typeof fetch;
let entryRow: Record<string, unknown>;
let targetRows: Record<string, unknown>[];
let noteRows: Record<string, unknown>[];
/** `navigate()` が流すイベントの回数(二重発火の検出に使う)。 */
let navigations: string[];

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function onNavigate(): void {
  navigations.push(window.location.pathname);
}

beforeEach(() => {
  entryRow = ENTRY_ROW;
  targetRows = TARGET_ROWS;
  noteRows = NOTE_ROWS;
  navigations = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (method === "GET" && url === `${ENTRIES_PATH}/${RECORD_ID}`) {
      return jsonResponse({ record: entryRow }, 200);
    }
    if (method === "GET" && url.startsWith(TARGETS_PATH)) {
      return jsonResponse({ records: targetRows }, 200);
    }
    if (method === "GET" && url.startsWith(NOTES_PATH)) {
      return jsonResponse({ records: noteRows }, 200);
    }
    if (method === "GET" && url.startsWith(ENTRIES_PATH)) {
      // 一覧はページ取得(total つき)を使う。
      return jsonResponse({ records: [entryRow], total: 1 }, 200);
    }
    return jsonResponse({ errors: [{ path: "", message: `no stub for ${method} ${url}` }] }, 404);
  }) as typeof fetch;
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/entry-detail/records/${RECORD_ID}`);
  window.addEventListener("gp:navigate", onNavigate);
});

afterEach(() => {
  cleanup();
  window.removeEventListener("gp:navigate", onNavigate);
  globalThis.fetch = originalFetch;
});

/**
 * **【`V10-M18-T02`(`FU-G2`)の追記】** 下の2本に**任意の第2引数 `role` を足した。**
 * **省略したときは今日どおり `RoleProvider` で包まない**(名乗り無し)ので、**既存の
 * 呼び出しの振る舞いは1ビットも変わらない。** 包む形を使うのは「注記が役割によらず
 * 0件であること」を測る節1つだけである。**出し分けのためではない**(`FU-G2` 限定1 は
 * 役割・利用者・見せる相手を見る式を実装に足すことを禁じている)。
 */
function withRole(role: Role | undefined, tree: ReactElement) {
  return role === undefined
    ? render(tree)
    : render(<RoleProvider role={role}>{tree}</RoleProvider>);
}

function renderDetail(manifest: Manifest = sampleManifest(), role?: Role) {
  return withRole(
    role,
    <DetailViewRenderer
      appId={APP_ID}
      manifest={manifest}
      view={detailView(manifest)}
      recordId={RECORD_ID}
    />,
  );
}

/** 一覧を描く(3箇所目の遷移点 = 一覧の参照セル)。URL は一覧のものにしておく。 */
function renderListView(manifest: Manifest = sampleManifest(), role?: Role) {
  const view = manifest.app.views.find((candidate) => candidate.id === "entry-list");
  if (view === undefined || view.type !== "list_view") {
    throw new Error("fixture broken: entry-list");
  }
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/entry-list`);
  return withRole(
    role,
    <ListViewRenderer appId={APP_ID} manifest={manifest} view={view} recordId={undefined} />,
  );
}

/** レコード詳細の URL(`route.ts` の形式)。 */
function detailPath(viewId: string, recordId: string): string {
  return `/apps/${APP_ID}/views/${viewId}/records/${recordId}`;
}

// ---------------------------------------------------------------------------
// 1. related の子行 → 子テーブルの detail_view
// ---------------------------------------------------------------------------

describe("related の子行からの遷移", () => {
  test("子行をクリックすると子テーブルの detail_view が対象レコードつきで開く", async () => {
    renderDetail();
    const row = await screen.findByTestId("related-row");
    fireEvent.click(row);
    expect(window.location.pathname).toBe(detailPath("note-detail", NOTE_ID));
    expect(navigations.length).toBe(1);
  });

  test("Enter でも開く(マウスが使えなくても遷移できる)", async () => {
    renderDetail();
    const row = await screen.findByTestId("related-row");
    fireEvent.keyDown(row, { key: "Enter" });
    expect(window.location.pathname).toBe(detailPath("note-detail", NOTE_ID));
  });

  test("子テーブルに detail_view が無ければ、子行はクリックできないままである", async () => {
    renderDetail(withoutView(sampleManifest(), "note-detail"));
    const row = await screen.findByTestId("related-row");
    expect(row.getAttribute("tabindex")).toBeNull();
    fireEvent.click(row);
    expect(navigations.length).toBe(0);
    expect(window.location.pathname).toBe(detailPath("entry-detail", RECORD_ID));
  });

  test("候補が2つ以上でもマニフェストの定義順で先頭を開く(規約を再実装していない)", async () => {
    // 2つ目を**後ろに**足しても先頭が選ばれる。`resolveDetailViewTarget` と同じ結果。
    renderDetail(withSecondDetailView(sampleManifest(), "note-detail", "note-detail-2"));
    const row = await screen.findByTestId("related-row");
    fireEvent.click(row);
    expect(window.location.pathname).toBe(detailPath("note-detail", NOTE_ID));
  });
});

// ---------------------------------------------------------------------------
// 2. reference セル → 参照先テーブルの detail_view
// ---------------------------------------------------------------------------

describe("reference セルからの遷移", () => {
  test("詳細の項目の参照がリンクになり、参照先の detail_view を開く", async () => {
    renderDetail();
    const cell = await screen.findByTestId("detail-field-f_ref");
    const link = within(cell).getByRole("link");
    expect(link.textContent).toBe("参照先の名前");
    fireEvent.click(link);
    expect(window.location.pathname).toBe(detailPath("target-detail", TARGET_ID));
  });

  test("参照先テーブルに detail_view が無ければリンクにしない(押せるのに開けない導線を作らない)", async () => {
    renderDetail(withoutView(sampleManifest(), "target-detail"));
    const cell = await screen.findByTestId("detail-field-f_ref");
    expect(within(cell).queryByRole("link")).toBeNull();
    expect(cell.textContent).toContain("参照先の名前");
  });

  test("参照切れ(found === false)はリンクにしない —— 開ける先が存在しない", async () => {
    targetRows = [];
    renderDetail();
    const cell = await screen.findByTestId("detail-field-f_ref");
    await waitFor(() => {
      expect(cell.textContent).toContain("見つかりません");
    });
    expect(within(cell).queryByRole("link")).toBeNull();
    // 手掛かりの ID は残す(従来どおり)。
    expect(cell.textContent).toContain(TARGET_ID);
  });

  test("見つかっているが代表値が引けない場合はリンクにする(参照切れと混同しない)", async () => {
    // 代表値(text)が空 → 表示は `_id` になるが、レコードは実在する。
    targetRows = [{ _id: TARGET_ID, _created_at: "", _updated_at: "", label: "" }];
    renderDetail();
    const cell = await screen.findByTestId("detail-field-f_ref");
    await waitFor(() => {
      expect(cell.textContent).toBe(TARGET_ID);
    });
    const link = within(cell).getByRole("link");
    fireEvent.click(link);
    expect(window.location.pathname).toBe(detailPath("target-detail", TARGET_ID));
  });

  test("値が未設定のときはリンクにしない(従来どおり「未設定」)", async () => {
    entryRow = { ...ENTRY_ROW, f_ref: null };
    renderDetail();
    const cell = await screen.findByTestId("detail-field-f_ref");
    expect(cell.textContent).toBe("未設定");
    expect(within(cell).queryByRole("link")).toBeNull();
  });

  test("related の子行のセルの参照もリンクになる", async () => {
    renderDetail();
    const row = await screen.findByTestId("related-row");
    const link = within(row).getByRole("link");
    expect(link.textContent).toBe("参照先の名前");
  });
});

// ---------------------------------------------------------------------------
// 3. 二重発火しないこと(行クリックとセル内リンクが同じ DOM で交差する)
// ---------------------------------------------------------------------------

describe("行クリックとセル内リンクが二重発火しない", () => {
  test("子行の中の参照リンクを押すと参照先だけが開く(行の遷移は起きない)", async () => {
    renderDetail();
    const row = await screen.findByTestId("related-row");
    const link = within(row).getByRole("link");
    fireEvent.click(link);
    expect(navigations.length).toBe(1);
    expect(window.location.pathname).toBe(detailPath("target-detail", TARGET_ID));
  });

  test("リンクの上での Enter は行の遷移を起こさない", async () => {
    renderDetail();
    const row = await screen.findByTestId("related-row");
    const link = within(row).getByRole("link");
    fireEvent.keyDown(link, { key: "Enter" });
    // happy-dom は `<a>` の既定動作(クリック生成)を解かないので、ここで数えるのは
    // 「行の onKeyDown が発火しなかったこと」だけである。
    expect(navigations.length).toBe(0);
  });

  test("リンクでないセルを押したときは行の遷移が起きる", async () => {
    renderDetail();
    const row = await screen.findByTestId("related-row");
    const cells = within(row).getAllByRole("cell");
    const contentCell = cells.find((cell) => cell.getAttribute("data-field") === "content");
    expect(contentCell).toBeDefined();
    fireEvent.click(contentCell as HTMLElement);
    expect(navigations.length).toBe(1);
    expect(window.location.pathname).toBe(detailPath("note-detail", NOTE_ID));
  });
});

// ---------------------------------------------------------------------------
// 4. 遷移先が2つ以上あるときの注記(D-M3-6。一覧と同じ規約・同じ判定)
// ---------------------------------------------------------------------------
//
// **【`V10-M18-T02`(`FU-G2`)の追記。上の見出しを1バイトも消していない】**
// **この節は今日「注記が出ること」を1つも測っていない。** ユーザ決定 `D-V10-21` が
// 「出すのをやめる」を選んだので、**注記は3種とも DOM に現れない。**
//
// **書き換えた検査の旧名(逐語。8本)**:
//
//   1. `子テーブルの detail_view が1つなら注記は出ない(迷いようがない)`
//   2. `子テーブルの detail_view が2つ以上なら、選んだビューID と個数を書いた注記が出る`
//   3. `参照先テーブルの detail_view が2つ以上なら、参照の遷移点にも注記が出る`
//   4. `参照先の detail_view が1つなら参照の注記は出ない`
//   5. `遷移先が無い(detail_view が0個)なら注記も出ない —— 判定は一覧と同じ`
//   6. `一覧の参照の注記は、行の遷移先の注記と区別できる(testid が別である)`
//   7. `一覧で行と参照の両方の候補が2つ以上なら、注記が2つとも出る`
//   8. `リンクになる参照が1つも無ければ参照の注記は出ない(当たり先の無い注記を出さない)`
//
// **旧 2 / 3 / 6 / 7 は「出ること」を測っていたので、実装の撤去で必ず赤くなる。**
// **旧 1 / 4 / 5 / 8 は「出ないこと」を測っていたので、そのままでも真である** ——
// **それでも「候補が1つ以下だから出ない」という理由づけが今日は嘘になるので、節ごと
// 書き換えた**(逐語の残置で緑を保たない)。

/** 運営者。 */
const ADMIN_ROLE: Role = "owner";
/**
 * **運営者でない役割。** 予約3ロール(`owner` / `editor` / `viewer`)に無い値を1つ置く
 * (非運営の判定は `isReservedRole` の否定である)。
 */
const NON_ADMIN_ROLE: Role = "customer";

describe("作り手向けの注記を画面から出さない(FU-G2 / D-V10-21)", () => {
  /**
   * **注記の `data-testid` の全量(3種)。** **受け入れ条文と実装指示は2種しか名指しして
   * いない**(`list-detail-target-note` / `detail-target-note`)。**`getByTestId` は完全
   * 一致なので、3種目(`related-detail-target-note`)を数え落とすと素通りする。**
   */
  const NOTE_TEST_IDS = [
    "list-detail-target-note",
    "reference-detail-target-note",
    "related-detail-target-note",
  ] as const;

  function expectNoNotes(): void {
    for (const testId of NOTE_TEST_IDS) {
      expect(screen.queryAllByTestId(testId).length, testId).toBe(0);
    }
  }

  test("(b) 候補が2枚以上でも、詳細画面(項目の参照)に注記が1つも出ない", async () => {
    renderDetail(withSecondDetailView(sampleManifest(), "target-detail", "target-detail-2"));
    await screen.findByTestId("related-row");
    expectNoNotes();
  });

  test("(b) 候補が2枚以上でも、詳細画面(子一覧の行)に注記が1つも出ない", async () => {
    renderDetail(withSecondDetailView(sampleManifest(), "note-detail", "note-detail-2"));
    await screen.findByTestId("related-row");
    expectNoNotes();
  });

  test("(b) 候補が2枚以上でも、詳細画面(子一覧の列の参照)に注記が1つも出ない", async () => {
    // `notes.tag` → `targets` が子一覧の列の参照である。候補を2枚にしても出ない。
    const source = withSecondDetailView(sampleManifest(), "target-detail", "target-detail-2");
    renderDetail(source);
    await screen.findByTestId("related-row");
    // 子一覧は自分で取得するので、遅れて現れる分も含めて数える。
    await waitFor(() => {
      expect(within(screen.getByTestId("related-row")).getAllByRole("link").length).toBe(1);
    });
    expectNoNotes();
  });

  test("(c) 運営者(owner)で描いても、詳細画面に注記が1つも出ない", async () => {
    renderDetail(
      withSecondDetailView(sampleManifest(), "target-detail", "target-detail-2"),
      ADMIN_ROLE,
    );
    await screen.findByTestId("related-row");
    expectNoNotes();
  });

  test("(c) 運営者でない役割で描いても、詳細画面に注記が1つも出ない", async () => {
    renderDetail(
      withSecondDetailView(sampleManifest(), "target-detail", "target-detail-2"),
      NON_ADMIN_ROLE,
    );
    await screen.findByTestId("related-row");
    expectNoNotes();
  });

  test("候補が1枚のときも0枚のときも、詳細画面に注記が1つも出ない", async () => {
    renderDetail();
    await screen.findByTestId("related-row");
    expectNoNotes();
    cleanup();
    renderDetail(withoutView(sampleManifest(), "note-detail"));
    await screen.findByTestId("related-row");
    expectNoNotes();
  });

  test("(a) 一覧でも、行と参照の両方の候補が2枚以上のときに注記が1つも出ない", async () => {
    const manifest = withSecondDetailView(sampleManifest(), "target-detail", "target-detail-2");
    renderListView(withSecondDetailView(manifest, "entry-detail", "entry-detail-2"));
    await screen.findByTestId("list-table");
    expectNoNotes();
  });

  test("(c) 一覧を運営者でない役割で描いても注記が1つも出ない", async () => {
    const manifest = withSecondDetailView(sampleManifest(), "target-detail", "target-detail-2");
    renderListView(
      withSecondDetailView(manifest, "entry-detail", "entry-detail-2"),
      NON_ADMIN_ROLE,
    );
    await screen.findByTestId("list-table");
    expectNoNotes();
  });

  test("リンクになる参照が1つも無いときも、注記は1つも出ない", async () => {
    targetRows = [];
    renderDetail(withSecondDetailView(sampleManifest(), "target-detail", "target-detail-2"));
    await screen.findByTestId("related-row");
    await waitFor(() => {
      expect(screen.getByTestId("detail-field-f_ref").textContent).toContain("見つかりません");
    });
    expectNoNotes();
  });

  test("注記の文面(「詳細ビュー」「定義順」)が詳細画面のどこにも残っていない", async () => {
    renderDetail(withSecondDetailView(sampleManifest(), "target-detail", "target-detail-2"));
    await screen.findByTestId("related-row");
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("定義順");
    expect(text).not.toContain("詳細ビュー");
  });

  /**
   * **(d) 注記が消えても、行そのものが押せるかどうかは1ビットも変わっていない。**
   *
   * **遷移の振る舞いに1バイトも触っていない**ことを、注記が出ていた条件で実際に押して固定する。
   */
  test("(d) 候補が2枚でも、子一覧の行は今日どおり押せて定義順の先頭へ移る", async () => {
    renderDetail(withSecondDetailView(sampleManifest(), "note-detail", "note-detail-2"));
    const row = await screen.findByTestId("related-row");
    expect(row.getAttribute("tabindex")).toBe("0");
    fireEvent.click(row);
    expect(navigations.length).toBe(1);
    expect(window.location.pathname).toBe(detailPath("note-detail", NOTE_ID));
  });

  test("(d) 候補が2枚でも、詳細の項目の参照は今日どおり押せて定義順の先頭へ移る", async () => {
    renderDetail(withSecondDetailView(sampleManifest(), "target-detail", "target-detail-2"));
    const cell = await screen.findByTestId("detail-field-f_ref");
    const link = within(cell).getByRole("link");
    fireEvent.click(link);
    expect(window.location.pathname).toBe(detailPath("target-detail", TARGET_ID));
  });
});

// ---------------------------------------------------------------------------
// 5. 一覧の reference セル(3箇所目の遷移点)
// ---------------------------------------------------------------------------
//
// **一覧の行は既にクリックできる。** 参照セルをリンクにすると、`related` の子行と同じ
// 交差(行クリック × セル内リンク)が一覧にも生まれる。**同じ考え方で防ぐ**
// (行の側でリンク由来のイベントから降りる。`RouteLink` は変えない)。

describe("一覧の reference セルからの遷移", () => {
  test("一覧の参照セルがリンクになり、参照先の detail_view を開く", async () => {
    renderListView();
    const row = await screen.findByTestId("list-row");
    const link = within(row).getByRole("link");
    expect(link.textContent).toBe("参照先の名前");
    fireEvent.click(link);
    expect(window.location.pathname).toBe(detailPath("target-detail", TARGET_ID));
    expect(navigations.length).toBe(1);
  });

  test("参照リンクを押しても行の遷移は起きない(二重発火しない)", async () => {
    renderListView();
    const row = await screen.findByTestId("list-row");
    fireEvent.click(within(row).getByRole("link"));
    // 行の onClick が二重に発火していたら、ここは entry-detail になる。
    expect(window.location.pathname).toBe(detailPath("target-detail", TARGET_ID));
    expect(navigations.length).toBe(1);
  });

  test("リンクの上での Enter は行の遷移を起こさない", async () => {
    renderListView();
    const row = await screen.findByTestId("list-row");
    fireEvent.keyDown(within(row).getByRole("link"), { key: "Enter" });
    expect(navigations.length).toBe(0);
  });

  test("リンクでないセルを押したときは従来どおり行が開く", async () => {
    renderListView();
    const row = await screen.findByTestId("list-row");
    const cells = within(row).getAllByRole("cell");
    const textCell = cells.find((cell) => cell.getAttribute("data-field") === "f_text");
    expect(textCell).toBeDefined();
    fireEvent.click(textCell as HTMLElement);
    expect(window.location.pathname).toBe(detailPath("entry-detail", RECORD_ID));
    expect(navigations.length).toBe(1);
  });

  test("行そのものの Enter も従来どおり行を開く", async () => {
    renderListView();
    const row = await screen.findByTestId("list-row");
    fireEvent.keyDown(row, { key: "Enter" });
    expect(window.location.pathname).toBe(detailPath("entry-detail", RECORD_ID));
  });

  test("参照先テーブルに detail_view が無ければリンクにしない", async () => {
    renderListView(withoutView(sampleManifest(), "target-detail"));
    const row = await screen.findByTestId("list-row");
    expect(within(row).queryByRole("link")).toBeNull();
    expect(row.textContent).toContain("参照先の名前");
  });

  test("参照切れ(found === false)はリンクにしない", async () => {
    targetRows = [];
    renderListView();
    const row = await screen.findByTestId("list-row");
    await waitFor(() => {
      expect(row.textContent).toContain("見つかりません");
    });
    expect(within(row).queryByRole("link")).toBeNull();
  });

  test("値が未設定の参照はリンクにしない", async () => {
    entryRow = { ...ENTRY_ROW, f_ref: null };
    renderListView();
    const row = await screen.findByTestId("list-row");
    expect(within(row).queryByRole("link")).toBeNull();
    expect(row.textContent).toContain("未設定");
  });
});

// ---------------------------------------------------------------------------
// 5. 一続きの流れの段を、行を押したときの行き先から外す(FU-G1a / ADR-0362)
// ---------------------------------------------------------------------------

/**
 * **3つの遷移点(一覧の行 / 関連行 / 参照セル)から、段になった `detail_view` が外れる**
 * (`V10-M18-T01`。`ADR-0362` §Decision 1〜3)。
 *
 * **4つ目の遷移点(保存が成立したあと)には除外を1ビットも当てていない**(`ADR-0362`
 * §Decision 2 / 限定2)—— **その1本も (e) としてここで固定する。**
 *
 * ## この節が言えないこと(**誇張しない**)
 *
 * - **happy-dom であり、chromium で1度も押していない。** 本物のブラウザでの実測は
 *   `web/e2e/checkout-flow.e2e.ts` が持つ。
 * - **「注文の中身が見られるようになった」とは1文字も言えない**(`ADR-0362` §Consequences)
 *   —— **段を外した結果、開ける先が1枚も無くなれば、行は押せなくなるだけである。**
 */
describe("行を押したときの行き先と一続きの流れの段(FU-G1a / ADR-0362)", () => {
  const WRITER_ROLE: Role = "owner";

  /** 指定したビューを段にする(**`flow.id` は1つだけ使う**)。 */
  function asFlowStep(source: Manifest, viewId: string, step: number): Manifest {
    const view = source.app.views.find((candidate) => candidate.id === viewId);
    if (view === undefined || view.type === "report_view") {
      throw new Error(`fixture broken: ${viewId}`);
    }
    view.flow = { id: "kaimono", step, kind: "input" };
    return source;
  }

  test("(d) 一覧の行: 同じテーブルの detail_view が全部段なら、行は押せない", async () => {
    renderListView(asFlowStep(sampleManifest(), "entry-detail", 3));
    const row = await screen.findByTestId("list-row");
    expect(row.getAttribute("tabindex")).toBeNull();
    expect(row.className).not.toContain("list-row-interactive");
    fireEvent.click(row);
    expect(navigations.length).toBe(0);
    expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/entry-list`);
  });

  test("(d) 関連行: 子テーブルの detail_view が全部段なら、子行は押せない", async () => {
    renderDetail(asFlowStep(sampleManifest(), "note-detail", 3));
    const row = await screen.findByTestId("related-row");
    expect(row.getAttribute("tabindex")).toBeNull();
    fireEvent.click(row);
    expect(navigations.length).toBe(0);
    expect(window.location.pathname).toBe(detailPath("entry-detail", RECORD_ID));
  });

  test("(d) 参照セル: 参照先の detail_view が全部段なら、セルはリンクにならない", async () => {
    renderDetail(asFlowStep(sampleManifest(), "target-detail", 3));
    const cell = await screen.findByTestId("detail-field-f_ref");
    expect(within(cell).queryByRole("link")).toBeNull();
    // **値そのものは今日どおり出る**(リンクにしないだけで、伏せない)。
    expect(cell.textContent).toContain("参照先の名前");
  });

  test("(c) 段の後ろに段でない detail_view が在れば、子行はそちらへ移る(定義順は保つ)", async () => {
    const source = withSecondDetailView(
      asFlowStep(sampleManifest(), "note-detail", 3),
      "note-detail",
      "note-detail-plain",
    );
    renderDetail(source);
    const row = await screen.findByTestId("related-row");
    fireEvent.click(row);
    expect(window.location.pathname).toBe(detailPath("note-detail-plain", NOTE_ID));
    expect(window.location.pathname).not.toContain("/note-detail/");
  });

  test("(f) 段を1つも宣言していない詳細画面は、子行も参照セルも今日どおり押せる", async () => {
    renderDetail();
    const row = await screen.findByTestId("related-row");
    expect(row.getAttribute("tabindex")).toBe("0");
    const cell = await screen.findByTestId("detail-field-f_ref");
    expect(within(cell).getByRole("link")).toBeDefined();
    fireEvent.click(row);
    expect(window.location.pathname).toBe(detailPath("note-detail", NOTE_ID));
  });

  /**
   * **(e) 保存が成立したあとの行き先には除外を1ビットも当てていない**
   * (`ADR-0362` §Decision 2 / 限定2。`FormRenderer.tsx:837` は今日どおり2引数で呼ぶ)。
   *
   * **段になった `detail_view` しか無い表でも、編集を保存したらそこへ着地する。**
   * **入力画面(`form`)自身は段を1つも宣言していない**ので、`flowNextRoute` は
   * `undefined` を返し、既定の段2〜段4(`ADR-0102` 限定7)がそのまま効く経路である。
   */
  test("(e) form の保存の後は、段になった detail_view へ今日どおり着地する", async () => {
    const source = asFlowStep(sampleManifest(), "entry-detail", 3);
    source.app.views.push({ id: "entry-form", type: "form", table: "entries", fields: ["f_text"] });
    const formView = source.app.views.find(
      (candidate): candidate is FormView => candidate.id === "entry-form",
    );
    if (formView === undefined) {
      throw new Error("fixture broken: entry-form");
    }
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if ((init?.method ?? "GET") === "PATCH" && url === `${ENTRIES_PATH}/${RECORD_ID}`) {
        return jsonResponse({ record: entryRow }, 200);
      }
      return await inner(input, init);
    }) as typeof fetch;

    window.history.replaceState({}, "", `/apps/${APP_ID}/views/entry-form`);
    render(
      <RoleProvider role={WRITER_ROLE}>
        <FormRenderer appId={APP_ID} manifest={source} view={formView} recordId={RECORD_ID} />
      </RoleProvider>,
    );
    const input = await screen.findByTestId("field-input-f_text");
    fireEvent.change(input, { target: { value: "書き換えた" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() => {
      expect(window.location.pathname).toBe(detailPath("entry-detail", RECORD_ID));
    });
  });
});
