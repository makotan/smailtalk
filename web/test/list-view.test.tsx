/**
 * list_view 汎用コンポーネントのテスト(V0-P3-T04)。
 *
 * 確認するのは「マニフェストの定義どおりに描く」ことだけ:
 *   1. `columns` に並んだ順で列が出る(列見出しは Field の表示名)
 *   2. `sort` / `filter` は API のクエリに載る(= フロントで並べ替え・絞り込みをしない)
 *   3. 各セルが型に応じた表示になる(reference は参照先の代表値)
 *   4. 読み込み中 / エラー / 0件 / 行クリックでの遷移
 *
 * フィクスチャの ID はこのファイル内にしか存在しない(CP-3 確認方法4)。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ListView, Manifest } from "../../src/kernel/types.ts";
import type { Role } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { ListViewRenderer } from "../src/views/ListViewRenderer.tsx";

const APP_ID = "sample-app";

/**
 * 一覧を描くときに名乗るロール(`V4-M19-T10` の追記)。**定数にしてあるのは、
 * `<RoleProvider role="owner">` と文字列で書くと biome の `useValidAriaRole` が
 * `role` を ARIA 属性と読んで赤にするためである**(`concurrency.test.tsx` の
 * `WRITE_ROLE` と同じ形)。
 */
const OWNER_ROLE: Role = "owner";

/**
 * **運営者でない役割**(`V10-M18-T02` / `FU-G2`。受け入れ条件が「両方でログインして」を求める)。
 *
 * **非運営の判定は `isReservedRole` の否定である**(`src/auth/types.ts`)ので、予約3ロール
 * (`owner` / `editor` / `viewer`)に無い値を1つ置く。**`customer` は「宣言が無いときの
 * 既定の1本目」であって特別なロールではない**(`ADR-0158` 限定3)。
 *
 * **【この定数は出し分けのためのものではない】** **注記は誰にも出ない。** 2つの役割で
 * 描くのは、**「役割によらず0件である」ことを実測で示すため**であって、役割を見る式を
 * 実装に足したからではない(`FU-G2` 限定1 は役割・利用者・見せる相手を見る式を禁じている)。
 */
const NON_ADMIN_ROLE: Role = "customer";

function manifest(): Manifest {
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
          // 宣言順(f_text, f_long, ...)とは違う順序にしてある。
          columns: ["f_select", "f_text", "f_bool", "f_ref"],
          sort: { field: "f_num", order: "desc" },
          filter: [{ field: "f_bool", equals: true }],
        },
        { id: "entry-detail", type: "detail_view", table: "entries" },
      ],
    },
  };
}

/** 同じテーブルの detail_view を2つ持つマニフェスト(定義順の先頭は entry-detail)。 */
function withTwoDetailViews(): Manifest {
  const source = manifest();
  source.app.views.push({ id: "entry-detail-secondary", type: "detail_view", table: "entries" });
  return source;
}

/** detail_view を1つも持たないマニフェスト。 */
function withoutDetailViews(): Manifest {
  const source = manifest();
  source.app.views = source.app.views.filter((view) => view.type !== "detail_view");
  return source;
}

function listView(source: Manifest, viewId = "entry-list"): ListView {
  const view = source.app.views.find((candidate) => candidate.id === viewId);
  if (view === undefined || view.type !== "list_view") {
    throw new Error(`fixture broken: ${viewId}`);
  }
  return view;
}

const ENTRY_ROWS = [
  {
    _id: "entry-1",
    _created_at: "2026-01-01T00:00:00Z",
    _updated_at: "2026-01-01T00:00:00Z",
    f_text: "いちばん",
    f_long: "長い文章",
    f_num: 20,
    f_bool: true,
    f_date: "2026-07-18",
    f_select: "alpha",
    f_ref: "target-1",
  },
  {
    _id: "entry-2",
    _created_at: "2026-01-02T00:00:00Z",
    _updated_at: "2026-01-02T00:00:00Z",
    f_text: "にばんめ",
    f_long: null,
    f_num: 10,
    f_bool: false,
    f_date: null,
    f_select: null,
    f_ref: null,
  },
];

const TARGET_ROWS = [{ _id: "target-1", _created_at: "", _updated_at: "", label: "参照先の名前" }];

let requestedUrls: string[];
let originalFetch: typeof fetch;
let entryRecords: unknown[];
/** entries の総件数(未指定なら entryRecords.length)。ページネーションのテスト用。 */
let entryTotal: number | undefined;
/**
 * offset ごとに違う行を返させたいときだけ使う(未設定なら `entryRecords` を返す従来どおり)。
 * キーはクエリの `offset` の値そのもの(未指定は "0")。CSV がどのページを書き出すかを見る。
 */
let entryRecordsByOffset: Record<string, unknown[]> | undefined;
let failWith: { status: number; body: unknown } | undefined;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  requestedUrls = [];
  entryRecords = ENTRY_ROWS;
  entryTotal = undefined;
  entryRecordsByOffset = undefined;
  failWith = undefined;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    requestedUrls.push(url);
    if (failWith !== undefined) {
      return jsonResponse(failWith.body, failWith.status);
    }
    if (url.includes("/tables/entries/records")) {
      const requestedOffset = /[?&]offset=(\d+)/.exec(url)?.[1] ?? "0";
      return jsonResponse({
        records: entryRecordsByOffset?.[requestedOffset] ?? entryRecords,
        total: entryTotal ?? entryRecords.length,
      });
    }
    if (url.includes("/tables/targets/records")) {
      return jsonResponse({ records: TARGET_ROWS });
    }
    return jsonResponse({ errors: [{ path: "", message: `no stub for ${url}` }] }, 404);
  }) as typeof fetch;
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/entry-list`);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function renderList(source = manifest(), viewId = "entry-list", role: Role = OWNER_ROLE) {
  // **【`V4-M19-T10` の追記。既存の行を1バイトも消していない】**
  // **`RoleProvider role="owner"` で包むようになった** —— `V4-M19-T10` が CSV の書き出し口を
  // 「買い物客と未ログインには出さない」に絞ったので、**包まずに描くと `useRole()` が `null` を
  // 返し、CSV の口を見ている検査(「CSV の書き出し(V3-M12-T09)」の節)が丸ごと赤になる。**
  // **この節が測りたいのは「書き出しの中身」であって「誰に出すか」ではない**ので、
  // **出る立場を明示する側に倒す**(誰に出すかは `web/test/platform-port-visibility.test.tsx`)。
  // 先例は `V4-M2-T06` が `form.test.tsx` / `detail-view.test.tsx` を包んだ形である。
  // **包んでも DOM に要素は1つも増えない**(`RoleProvider` はコンテキストだけである)。
  //
  // **【`V10-M18-T02`(`FU-G2`)の追記。上の行を1バイトも消していない】** 第3引数で
  // **名乗る役割を差し替えられるようにした。** **既定は今日どおり `OWNER_ROLE` である**ので、
  // **既存の呼び出し40件超の振る舞いは1ビットも変わらない。** 差し替えを使うのは
  // 「注記が役割によらず0件であること」を測る節1つだけである。
  return render(
    <RoleProvider role={role}>
      <ListViewRenderer appId={APP_ID} manifest={source} view={listView(source, viewId)} />
    </RoleProvider>,
  );
}

async function findTable(): Promise<HTMLElement> {
  return await screen.findByTestId("list-table");
}

describe("列の定義", () => {
  test("columns に並んだ順で列見出し(Field の表示名)が出る", async () => {
    renderList();
    await findTable();
    const headers = screen.getAllByRole("columnheader").map((cell) => cell.textContent);
    expect(headers).toEqual(["選択", "テキスト", "真偽", "参照"]);
  });

  test("columns に無いフィールドは列に出ない", async () => {
    renderList();
    await findTable();
    expect(screen.queryByRole("columnheader", { name: "長文" })).toBeNull();
    expect(screen.queryByText("長い文章")).toBeNull();
  });

  test("セルも columns の順に並ぶ", async () => {
    renderList();
    await findTable();
    const cells = screen.getAllByTestId("list-row")[0]?.querySelectorAll("td") ?? [];
    expect([...cells].map((cell) => cell.getAttribute("data-field"))).toEqual([
      "f_select",
      "f_text",
      "f_bool",
      "f_ref",
    ]);
  });
});

describe("sort / filter はサーバに渡す", () => {
  test("sort と filter が API のクエリになる", async () => {
    renderList();
    await findTable();
    const url = requestedUrls.find((candidate) => candidate.includes("/tables/entries/records"));
    expect(url).toBeDefined();
    expect(url).toContain("sort=f_num");
    expect(url).toContain("order=desc");
    expect(url).toContain("filter.f_bool=true");
  });

  test("サーバが返した順序をそのまま描画する(フロントで並べ替えない)", async () => {
    entryRecords = [...ENTRY_ROWS].reverse();
    renderList();
    await findTable();
    const rows = screen.getAllByTestId("list-row");
    expect(rows[0]?.textContent).toContain("にばんめ");
    expect(rows[1]?.textContent).toContain("いちばん");
  });

  test("sort / filter の無いビューでも sort/filter クエリは付かない(ページネーションの limit は付く)", async () => {
    // EC-G11 / ADR-0042: 一覧は常に1ページ分(limit)を要求するので limit= は載るが、
    // マニフェストに sort / filter が無ければそれらのクエリは1つも付かない(従来の非付与契約は
    // sort/filter について維持)。
    const source = manifest();
    const view = listView(source);
    delete view.sort;
    delete view.filter;
    renderList(source);
    await findTable();
    const url = requestedUrls.find((candidate) => candidate.includes("/tables/entries/records"));
    expect(url).toContain("limit=50");
    expect(url).not.toContain("sort=");
    expect(url).not.toContain("filter");
    expect(url).not.toContain("offset=");
  });
});

describe("セルの表示", () => {
  test("型ごとの表示になり、reference は参照先の代表値になる", async () => {
    renderList();
    await findTable();
    const first = screen.getAllByTestId("list-row")[0];
    expect(first?.textContent).toContain("alpha");
    expect(first?.textContent).toContain("いちばん");
    expect(first?.textContent).toContain("参照先の名前");
    expect(first?.textContent).not.toContain("target-1");
  });

  test("null のセルは未設定と表示する", async () => {
    renderList();
    await findTable();
    const second = screen.getAllByTestId("list-row")[1];
    expect(second?.querySelector('[data-field="f_ref"]')?.textContent).toBe("未設定");
    expect(second?.querySelector('[data-field="f_select"]')?.textContent).toBe("未設定");
  });

  test("参照先テーブルのレコードも取得する", async () => {
    renderList();
    await findTable();
    expect(requestedUrls.some((candidate) => candidate.includes("/tables/targets/records"))).toBe(
      true,
    );
  });
});

describe("状態", () => {
  test("読み込み中が出る", () => {
    renderList();
    expect(screen.getByText(/読み込み中/)).toBeDefined();
  });

  test("0件のときは空であることを伝える", async () => {
    entryRecords = [];
    renderList();
    expect(await screen.findByTestId("list-empty")).toBeDefined();
    expect(screen.queryByTestId("list-table")).toBeNull();
  });

  test("エラーは統一形式のまま表示する", async () => {
    failWith = {
      status: 400,
      body: { errors: [{ path: "/sort/field", message: "テスト用のエラー", hint: "ヒント" }] },
    };
    renderList();
    const errors = await screen.findByTestId("errors");
    expect(errors.textContent).toContain("テスト用のエラー");
    expect(errors.textContent).toContain("ヒント");
  });
});

describe("行クリック", () => {
  test("行をクリックすると、その行のレコードID 付きで detail_view に遷移する", async () => {
    renderList();
    await findTable();
    const row = screen.getAllByTestId("list-row")[0];
    if (row === undefined) {
      throw new Error("row not rendered");
    }
    fireEvent.click(row);
    await waitFor(() => {
      expect(window.location.pathname).toBe(
        `/apps/${APP_ID}/views/entry-detail/records/${ENTRY_ROWS[0]?._id}`,
      );
    });
  });

  test("行ごとに違うレコードID を載せる", async () => {
    renderList();
    await findTable();
    const second = screen.getAllByTestId("list-row")[1];
    fireEvent.click(second as HTMLElement);
    await waitFor(() => {
      expect(window.location.pathname).toBe(
        `/apps/${APP_ID}/views/entry-detail/records/${ENTRY_ROWS[1]?._id}`,
      );
    });
  });

  test("対象テーブルの detail_view が無ければ行はクリックできず、壊れない", async () => {
    const source = withoutDetailViews();
    renderList(source);
    await findTable();
    const row = screen.getAllByTestId("list-row")[0];
    expect(row?.getAttribute("tabindex")).toBeNull();
    expect(row?.className).not.toContain("list-row-interactive");
    fireEvent.click(row as HTMLElement);
    expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/entry-list`);
  });

  test("同じテーブルの detail_view が2つあれば、定義順で最初のものに遷移する", async () => {
    renderList(withTwoDetailViews());
    await findTable();
    fireEvent.click(screen.getAllByTestId("list-row")[0] as HTMLElement);
    await waitFor(() => {
      expect(window.location.pathname).toBe(
        `/apps/${APP_ID}/views/entry-detail/records/${ENTRY_ROWS[0]?._id}`,
      );
    });
    // 後ろに置いた方には行かない。
    expect(window.location.pathname).not.toContain("entry-detail-secondary");
  });
});

/**
 * **一続きの流れの段になった `detail_view` は、一覧の行クリックの行き先から外れる**
 * (`FU-G1a`。`V10-M18-T01` / `ADR-0362` §Decision 1 の遷移点1)。
 *
 * ## この節が固定するもの
 *
 * - **(d)** 同じテーブルの `detail_view` が全部段なら、**行は今日どおり押せなくなる** ——
 *   **`tabindex` も `list-row-interactive` も付かず、押しても URL が1文字も動かない。**
 *   **別の画面へ倒さない**(`ADR-0362` §Decision 3)。
 * - **(c)** 段でない `detail_view` が後ろに在れば、**そちらへ移る**(定義順は保つ)。
 * - **(f)** **段を1つも宣言していない一覧の姿は今日と同じである。**
 *
 * ## この節が言えないこと(**誇張しない**)
 *
 * - **(f) の「1バイトも同じ」を、この1本が証明しているのではない。** **本体の担保は
 *   このファイルの `describe("行クリック")` 4本と `record-navigation.test.tsx` の既存の
 *   検査が1本も赤くならないことである。** ここに置いたのは、その宣言を明示するための
 *   1本にすぎない。
 * - **注記(`list-detail-target-note`)の文面を直していない。** **`countDetailViewTargets` は
 *   1バイトも触っていない**(`ADR-0362` 限定1)ので、**段になった `detail_view` も今日どおり
 *   個数に入る** —— **段を1枚外したうえで注記が出る形では、注記の「定義順で最初のもの」が
 *   実際に開く画面と食い違う。** **本タスクはこれを直していない**(直すと限定1 に触れる)。
 *
 * ## **【`V10-M18-T02`(`FU-G2`)の追記。上の行を1バイトも消していない】**
 *
 * **上に書いた「食い違い」は、今日はもう画面で起きない** —— **`FU-G2` が注記そのものを
 * 画面から出さなくした**ので、**一覧にも詳細にも `list-detail-target-note` /
 * `reference-detail-target-note` / `related-detail-target-note` は1つも現れない。**
 * **`countDetailViewTargets` は今日も1バイトも触っていない**(`ADR-0362` 限定1)が、
 * **その数を読んで文にする部品が無いので、食い違いを見せる先が無い。**
 * **下の `(限界)` の検査は、この理由で名前ごと書き換えた。** **旧の検査名は逐語で
 * `(限界) 段を外して2枚目を開くときも、注記は今日どおり3個と数えて文面が食い違う` である。**
 */
describe("行クリックと一続きの流れの段(FU-G1a / ADR-0362)", () => {
  const STEP3 = { id: "kaimono", step: 3, kind: "input" } as const;
  const STEP4 = { id: "kaimono", step: 4, kind: "confirm" } as const;

  /** 既存の `entry-detail` を段3 にする(候補が段だけになる)。 */
  function allDetailViewsAreSteps(): Manifest {
    const source = manifest();
    for (const view of source.app.views) {
      if (view.type === "detail_view" && view.table === "entries") {
        view.flow = STEP3;
      }
    }
    source.app.views.push({
      id: "entry-detail-confirm",
      type: "detail_view",
      table: "entries",
      flow: STEP4,
    });
    return source;
  }

  /** 段3 のうしろに、段でない `detail_view` を1枚足す。 */
  function stepThenPlainDetailView(): Manifest {
    const source = allDetailViewsAreSteps();
    source.app.views.push({ id: "entry-detail-plain", type: "detail_view", table: "entries" });
    return source;
  }

  test("(d) 同じテーブルの detail_view が全部段なら、行は押せない(別の画面へ倒さない)", async () => {
    renderList(allDetailViewsAreSteps());
    await findTable();
    const row = screen.getAllByTestId("list-row")[0];
    expect(row?.getAttribute("tabindex")).toBeNull();
    expect(row?.className).not.toContain("list-row-interactive");
    fireEvent.click(row as HTMLElement);
    expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/entry-list`);
  });

  test("(d) 全部段のときは、行の遷移先の注記も出ない(当たり先が無い)", async () => {
    renderList(allDetailViewsAreSteps());
    await findTable();
    expect(screen.queryByTestId("list-detail-target-note")).toBeNull();
  });

  test("(c) 段でない detail_view が後ろに在れば、行はそちらへ移る(定義順は保つ)", async () => {
    renderList(stepThenPlainDetailView());
    await findTable();
    fireEvent.click(screen.getAllByTestId("list-row")[0] as HTMLElement);
    await waitFor(() => {
      expect(window.location.pathname).toBe(
        `/apps/${APP_ID}/views/entry-detail-plain/records/${ENTRY_ROWS[0]?._id}`,
      );
    });
    // **段になった2枚のどちらにも着地しない。**
    expect(window.location.pathname).not.toContain("entry-detail/");
    expect(window.location.pathname).not.toContain("entry-detail-confirm");
  });

  /**
   * **【既知の限界。直していない】注記の個数は今日どおり段も数える。**
   *
   * **`countDetailViewTargets` を1バイトも触っていない**(`ADR-0362` 限定1)ので、
   * **段を外して選んだ画面と、注記が述べる「定義順で最初のもの」が食い違う。**
   * **推測ではなく、この検査が実際の文面を読んで固定している。**
   *
   * **【`V10-M18-T02`(`FU-G2`)の追記。上の行を1バイトも消していない】**
   * **旧の検査名は逐語で
   * `(限界) 段を外して2枚目を開くときも、注記は今日どおり3個と数えて文面が食い違う`。**
   * **`FU-G2` が注記を画面から出さなくしたので、この限界の担保が成り立たなくなった**
   * —— **`getByTestId("list-detail-target-note")` は今日、要素が無くて投げる。**
   * **限界を「直した」のではなく、限界を見せていた画面上の文が無くなった**
   * (`countDetailViewTargets` の数え方は1バイトも変えていない)。**この検査は、その
   * 「見せる先が無い」ことのほうを固定する。**
   */
  test("(限界の消滅) 段を外して2枚目を開くとき、注記が1つも無いので食い違う文が画面に出ない", async () => {
    renderList(stepThenPlainDetailView());
    await findTable();
    // **開くのは `entry-detail-plain`(3枚目)である** —— 上の (c) が実際に押して固定している。
    expect(screen.queryByTestId("list-detail-target-note")).toBeNull();
    // **「定義順で最初のもの」と述べる文が画面のどこにも無い**(文面ごと消えている)。
    expect(document.body.textContent ?? "").not.toContain("定義順で最初のもの");
  });

  test("(f) 段を1つも宣言していない一覧の行は、今日どおり押せて今日どおりの行き先へ移る", async () => {
    renderList();
    await findTable();
    const row = screen.getAllByTestId("list-row")[0];
    expect(row?.getAttribute("tabindex")).toBe("0");
    expect(row?.className).toContain("list-row list-row-interactive");
    fireEvent.click(row as HTMLElement);
    await waitFor(() => {
      expect(window.location.pathname).toBe(
        `/apps/${APP_ID}/views/entry-detail/records/${ENTRY_ROWS[0]?._id}`,
      );
    });
  });
});

/**
 * 「同テーブル先頭 detail_view 規約」の画面上の明示。
 * 遷移先が一意に決まらない(候補が2つ以上ある)ときだけ、どれを使ったかを書く。
 *
 * ## **【`V10-M18-T02`(`FU-G2`)の追記。上の2行を1バイトも消していない】**
 *
 * **上の説明は今日の実物ではない。** **ユーザ決定 `D-V10-21` が選んだ見出しは
 * 「出すのをやめる」である** —— **「お客に分かる言葉へ書き換える」でも「作り手にだけ
 * 見せる」でもない。** したがって**注記は誰にも・どの画面にも出ない。**
 *
 * **書き換えた検査の旧名(逐語。4本)**:
 *
 * 1. `detail_view が2つ以上のときだけ注記が出て、遷移先の id と個数が書いてある`
 * 2. `detail_view が1つのときは注記を出さない(既存マニフェストの表示を変えない)`
 * 3. `detail_view が0個のときは注記を出さない`
 * 4. `レコード0件のときは、候補が2つ以上でも注記を出さない(表そのものが無いため)`
 *
 * **2〜4 は「出さない」を測っていたので、条件が消えても真のままである** —— **それでも
 * 名前の「注記を出さない」という理由づけ(候補が1つ以下だから)が今日は嘘になるので、
 * 節ごと書き換えた。**
 *
 * **数える `data-testid` は3種である**(`list-detail-target-note` /
 * `reference-detail-target-note` / `related-detail-target-note`)。**`getByTestId` は
 * 完全一致なので、2種だけを名指しすると3種目が素通りする。**
 */
describe("作り手向けの注記を画面から出さない(FU-G2 / D-V10-21)", () => {
  /**
   * **注記の `data-testid` の全量(3種)。** 器の class の既定は `detail-target-note`、
   * 一覧の行だけ `list-detail-target-note` を持っていた。
   */
  const NOTE_TEST_IDS = [
    "list-detail-target-note",
    "reference-detail-target-note",
    "related-detail-target-note",
  ] as const;

  /** 3種すべてが0件であることを数える(`queryAllByTestId` は無ければ空配列)。 */
  function expectNoNotes(): void {
    for (const testId of NOTE_TEST_IDS) {
      expect(screen.queryAllByTestId(testId).length, testId).toBe(0);
    }
  }

  test("(a) detail_view が2枚以上あっても、一覧に注記が1つも出ない", async () => {
    renderList(withTwoDetailViews());
    await findTable();
    expectNoNotes();
  });

  test("(c) 運営者でない役割で描いても、一覧に注記が1つも出ない", async () => {
    renderList(withTwoDetailViews(), "entry-list", NON_ADMIN_ROLE);
    await findTable();
    expectNoNotes();
  });

  test("detail_view が1つのときも0個のときも、注記は1つも出ない", async () => {
    renderList();
    await findTable();
    expectNoNotes();
    cleanup();
    renderList(withoutDetailViews());
    await findTable();
    expectNoNotes();
  });

  test("レコード0件のときも、候補が2つ以上でも注記は1つも出ない", async () => {
    entryRecords = [];
    renderList(withTwoDetailViews());
    expect(await screen.findByTestId("list-empty")).toBeDefined();
    expectNoNotes();
  });

  test("注記の文面(「詳細ビュー」「定義順」)が画面のどこにも残っていない", async () => {
    renderList(withTwoDetailViews());
    await findTable();
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("定義順");
    expect(text).not.toContain("詳細ビュー");
  });

  /**
   * **(d) 注記が消えたことで、行が押せるかどうかは1ビットも変わっていない。**
   *
   * **遷移の振る舞いに1バイトも触っていない**ことを、注記が出ていた条件
   * (同じテーブルの `detail_view` が2枚)で実際に押して固定する。
   */
  test("(d) 候補が2枚でも、行は今日どおり押せて定義順の先頭へ移る", async () => {
    renderList(withTwoDetailViews());
    await findTable();
    const row = screen.getAllByTestId("list-row")[0];
    expect(row?.getAttribute("tabindex")).toBe("0");
    expect(row?.className).toContain("list-row-interactive");
    fireEvent.click(row as HTMLElement);
    await waitFor(() => {
      expect(window.location.pathname).toBe(
        `/apps/${APP_ID}/views/entry-detail/records/${ENTRY_ROWS[0]?._id}`,
      );
    });
    // **2枚目(`entry-detail-secondary`)には着地しない** —— 規約は今日も定義順の先頭である。
    expect(window.location.pathname).not.toContain("entry-detail-secondary");
  });
});

describe("マニフェストの不整合", () => {
  test("columns に実在しないフィールドがあれば黙って隠さずエラーにする", async () => {
    const source = manifest();
    listView(source).columns = ["f_text", "missing_field"];
    renderList(source);
    const errors = await screen.findByTestId("errors");
    expect(errors.textContent).toContain("missing_field");
  });
});

describe("ページネーション(EC-G11 / ADR-0042)", () => {
  test("総件数(total)を表示する", async () => {
    entryTotal = 123;
    renderList();
    await findTable();
    const total = await screen.findByTestId("list-total");
    expect(total.textContent).toContain("123");
  });

  test("total がページサイズ以下ならページャ(次/前)を出さない", async () => {
    // 既定は2件・total=2(entryTotal 未指定)。
    renderList();
    await findTable();
    expect(screen.queryByTestId("list-pager")).toBeNull();
  });

  test("total がページサイズを超えたらページャを出す", async () => {
    entryTotal = 200;
    renderList();
    await findTable();
    expect(await screen.findByTestId("list-pager")).toBeDefined();
  });

  test("最初のページは limit を載せ offset は 0(前へは無効)", async () => {
    entryTotal = 200;
    renderList();
    await findTable();
    const url = requestedUrls.find((candidate) => candidate.includes("/tables/entries/records"));
    expect(url).toContain("limit=50");
    const prev = (await screen.findByTestId("list-prev")) as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
  });

  test("次へでオフセットを載せて再取得する", async () => {
    entryTotal = 200;
    renderList();
    await findTable();
    const next = (await screen.findByTestId("list-next")) as HTMLButtonElement;
    expect(next.disabled).toBe(false);
    fireEvent.click(next);
    await waitFor(() => {
      const paged = requestedUrls.find(
        (candidate) =>
          candidate.includes("/tables/entries/records") && candidate.includes("offset=50"),
      );
      expect(paged).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// 画面プリセット(ADR-0050 の軸1 / 軸2 / 軸3)
// ---------------------------------------------------------------------------

/**
 * ここが確かめるのは **DOM に何が出るか** だけである。**「実際にそう描かれるか」は
 * `web/e2e/preset.e2e.ts` が chromium の `getComputedStyle` で見る** —— happy-dom は
 * CSS を解決しないので、ここで `text-align` を読んでも何も証明しない。
 *
 * **未指定のときに DOM が1バイトも変わらないこと**(D-M2-3 / ADR-0051 限定4)も
 * ここで固定する。属性も `<colgroup>` も1つも出てはならない。
 */

/** `entry-list` にプリセットを書いたマニフェストを作る。 */
function withPresets(presets: Partial<ListView>): Manifest {
  const source = manifest();
  Object.assign(listView(source), presets);
  return source;
}

/** `.list-view` の直下の並び(`data-testid` の列)。件数表示とページャの位置を見る。 */
/*
 * **【V4-M20-T03 で `list-bulk` が1つ増えた】**
 *
 * **単位C(画面で選んでまとめて操作する)の判定は「将来送り」であり、その送り先が
 * `V4-M20-T03`(**表示層だけで作り、カーネル語彙を1つも増やさない**)である。**
 * **入口のボタン(「まとめて操作」)は `.list-view` の直下に立つので、この並びに1つ増える。**
 * **出るのは editor / owner のときだけである** —— 本ファイルは owner で描いている。
 * **viewer / customer / 未ログインの並びは着手前と完全に同じである。**
 * **並びの前後関係(件数表示とページャの位置)は1つも変わっていない** —— 増えたのは
 * 先頭の1つだけである。**固定の向き(位置が変わったら赤くなる)を1ミリも弱めていない。**
 */
function sectionOrder(): string[] {
  const section = screen.getByTestId("view-renderer-list_view");
  return [...section.children].map(
    (child) => child.getAttribute("data-testid") ?? child.tagName.toLowerCase(),
  );
}

describe("プリセット 軸1 列の寄せ(preset_column_align)", () => {
  test("未指定なら data-preset-align はどこにも出ない", async () => {
    renderList();
    const table = await findTable();
    expect(table.querySelectorAll("[data-preset-align]")).toHaveLength(0);
  });

  test("指定した列の <th> と <td> の両方に enum 値が出る(指定していない列には出ない)", async () => {
    renderList(withPresets({ preset_column_align: { f_text: "right", f_bool: "center" } }));
    const table = await findTable();

    const headers = [...table.querySelectorAll("thead th")].map((cell) =>
      cell.getAttribute("data-preset-align"),
    );
    // columns の順は f_select / f_text / f_bool / f_ref。
    expect(headers).toEqual([null, "right", "center", null]);

    const cells = [...(screen.getAllByTestId("list-row")[0]?.querySelectorAll("td") ?? [])];
    expect(cells.map((cell) => cell.getAttribute("data-preset-align"))).toEqual([
      null,
      "right",
      "center",
      null,
    ]);
    // 既存の `data-field` / `data-field-type` は1つも失われていない。
    expect(cells.map((cell) => cell.getAttribute("data-field"))).toEqual([
      "f_select",
      "f_text",
      "f_bool",
      "f_ref",
    ]);
    expect(cells.map((cell) => cell.getAttribute("data-field-type"))).toEqual([
      "select",
      "text",
      "boolean",
      "reference",
    ]);
  });

  test("columns に無いフィールドID を書いても DOM には何も現れない", async () => {
    renderList(withPresets({ preset_column_align: { f_long: "right" } }));
    const table = await findTable();
    expect(table.querySelectorAll("[data-preset-align]")).toHaveLength(0);
  });
});

describe("プリセット 軸2 列の幅(preset_column_width)", () => {
  test("未指定なら <colgroup> を出さない(table-layout の当たり先も無い)", async () => {
    renderList();
    const table = await findTable();
    expect(table.querySelectorAll("colgroup")).toHaveLength(0);
    expect(table.querySelectorAll("col")).toHaveLength(0);
  });

  test("指定すると列と同じ数・同じ順の <col> が出て、値のある列だけ段階値を持つ", async () => {
    renderList(withPresets({ preset_column_width: { f_select: "narrow", f_ref: "wide" } }));
    const table = await findTable();
    const cols = [...table.querySelectorAll("colgroup col")];
    expect(cols.map((col) => col.getAttribute("data-field"))).toEqual([
      "f_select",
      "f_text",
      "f_bool",
      "f_ref",
    ]);
    expect(cols.map((col) => col.getAttribute("data-preset-width"))).toEqual([
      "narrow",
      null,
      null,
      "wide",
    ]);
  });
});

describe("プリセット 軸3 件数表示とページャの位置(preset_pager_position)", () => {
  test("未指定なら今日どおり(件数表示が表の前・ページャが表の後)で、属性も出ない", async () => {
    entryTotal = 200;
    renderList();
    await findTable();
    expect(sectionOrder()).toEqual(["list-bulk", "list-total", "list-table", "list-pager"]);
    expect(
      screen.getByTestId("view-renderer-list_view").getAttribute("data-preset-pager"),
    ).toBeNull();
  });

  test("top なら件数表示もページャも表の前に出る", async () => {
    entryTotal = 200;
    renderList(withPresets({ preset_pager_position: "top" }));
    await findTable();
    expect(sectionOrder()).toEqual(["list-bulk", "list-total", "list-pager", "list-table"]);
    expect(screen.getByTestId("view-renderer-list_view").getAttribute("data-preset-pager")).toBe(
      "top",
    );
  });

  test("bottom なら件数表示もページャも表の後に出る", async () => {
    entryTotal = 200;
    renderList(withPresets({ preset_pager_position: "bottom" }));
    await findTable();
    expect(sectionOrder()).toEqual(["list-bulk", "list-table", "list-total", "list-pager"]);
  });

  // E-G44 とは別。**E-G19(V4-M6)**: `both` は「ページャを上下に置く」であって
  // 「件数を2回出す」ではない。着手前はここが「件数表示も2回」を固定しており、実地では
  // `product-all` に同じ「1–32 件 / 全 32 件」が表の上と下に出ていた(02 §5-3 `E-G19`)。
  test("both ならページャが表の前と後の2箇所に出る(件数表示は1回だけ。E-G19)", async () => {
    entryTotal = 200;
    renderList(withPresets({ preset_pager_position: "both" }));
    await findTable();
    expect(sectionOrder()).toEqual([
      "list-bulk",
      "list-total",
      "list-pager",
      "list-table",
      "list-pager",
    ]);
    expect(screen.getAllByTestId("list-total")).toHaveLength(1);
    expect(screen.getAllByTestId("list-pager")).toHaveLength(2);
  });

  test("どの宣言値でも件数表示は必ず1回だけである(E-G19)", async () => {
    for (const position of [undefined, "top", "bottom", "both"] as const) {
      entryTotal = 200;
      cleanup();
      renderList(
        position === undefined ? undefined : withPresets({ preset_pager_position: position }),
      );
      await findTable();
      expect(screen.getAllByTestId("list-total"), `位置=${String(position)}`).toHaveLength(1);
    }
  });

  test("ページャが要らない件数なら、位置を指定しても件数表示だけが動く", async () => {
    // 既定は2件・total=2 なのでページャは出ない(既存の挙動を1つも変えない)。
    renderList(withPresets({ preset_pager_position: "bottom" }));
    await findTable();
    expect(sectionOrder()).toEqual(["list-bulk", "list-table", "list-total"]);
    expect(screen.queryByTestId("list-pager")).toBeNull();
  });

  test("0件のときも位置指定が効く(表そのものが無くても件数表示は動く)", async () => {
    entryRecords = [];
    renderList(withPresets({ preset_pager_position: "bottom" }));
    await screen.findByTestId("list-empty");
    expect(sectionOrder()).toEqual(["list-bulk", "list-empty", "list-total"]);
  });
});

describe("プリセット 軸6 image の表示サイズ(preset_image_size)", () => {
  test("未指定なら data-preset-image はどこにも出ない", async () => {
    renderList();
    await findTable();
    const section = screen.getByTestId("view-renderer-list_view");
    expect(section.getAttribute("data-preset-image")).toBeNull();
    expect(section.querySelectorAll("[data-preset-image]")).toHaveLength(0);
  });

  test("画像サイズは画面の器(section.list-view)の属性に出る", async () => {
    renderList(withPresets({ preset_image_size: "medium" }));
    await findTable();
    // **一覧と詳細は別の器なので別サイズを持てる**(ADR-0050 §4 / 限定1)。
    expect(screen.getByTestId("view-renderer-list_view").getAttribute("data-preset-image")).toBe(
      "medium",
    );
    // 表そのものには出さない(規則は `.list-view` から始める)。
    expect((await findTable()).getAttribute("data-preset-image")).toBeNull();
  });

  test("3値のいずれもそのまま属性値になる(自由な文字列は1つも出ない)", async () => {
    for (const size of ["thumbnail", "medium", "original"] as const) {
      renderList(withPresets({ preset_image_size: size }));
      await findTable();
      expect(screen.getByTestId("view-renderer-list_view").getAttribute("data-preset-image")).toBe(
        size,
      );
      cleanup();
    }
  });
});

describe("プリセット 軸7 long_text の切り詰め長(preset_text_preview)", () => {
  /** 200文字。どの段階値でも必ず切り詰めが起きる長さ。 */
  const LONG = "あいうえおかきくけこ".repeat(20);

  /**
   * `f_long` を列に含めた一覧を描く。**軸7 は他の6軸と違って CSS では実装できない**
   * (切り詰め後の文字列しか DOM に出ないので CSS からは全文を復元できない)ので、
   * ここで見ているのは属性ではなく **実際に描かれた文字数**である。
   */
  function renderWithLongColumn(preview?: "short" | "standard" | "long") {
    entryRecords = [{ ...ENTRY_ROWS[0], f_long: LONG }];
    const presets: Partial<ListView> = { columns: ["f_text", "f_long"] };
    if (preview !== undefined) {
      presets.preset_text_preview = preview;
    }
    renderList(withPresets(presets));
  }

  async function longTextNode(): Promise<HTMLElement> {
    await findTable();
    return screen.getByTestId("field-value-long_text");
  }

  test("未指定なら今日の既定(40文字)のまま切り詰める", async () => {
    renderWithLongColumn();
    expect((await longTextNode()).textContent).toBe(`${LONG.slice(0, 40)}…`);
  });

  test("段階値ごとに切り詰め長が変わる(short 20 / standard 40 / long 80)", async () => {
    for (const [preview, length] of [
      ["short", 20],
      ["standard", 40],
      ["long", 80],
    ] as const) {
      renderWithLongColumn(preview);
      expect((await longTextNode()).textContent).toBe(`${LONG.slice(0, length)}…`);
      cleanup();
    }
  });

  test("どの段階値でも全文は title に残る(切り詰めても値は捨てない)", async () => {
    for (const preview of ["short", "standard", "long"] as const) {
      renderWithLongColumn(preview);
      expect((await longTextNode()).getAttribute("title")).toBe(LONG);
      cleanup();
    }
  });

  test("軸7 は DOM 属性を1つも増やさない(経路B ではない)", async () => {
    renderWithLongColumn("short");
    const table = await findTable();
    // 軸1〜6 は `data-preset-*` 属性で当てるが、**軸7 だけは表示関数の引数で当てる**
    // (ADR-0050 限定10 が許した唯一の例外)。属性が増えていないことをここで固定する。
    expect(table.querySelectorAll("[data-preset-text], [data-preset-preview]")).toHaveLength(0);
    expect(
      screen.getByTestId("view-renderer-list_view").getAttribute("data-preset-text"),
    ).toBeNull();
  });

  test("long_text 以外の型は切り詰めプリセットの影響を受けない", async () => {
    renderWithLongColumn("short");
    await findTable();
    // 同じ行の text 列は素通しのまま(切り詰めは long_text の作法である)。
    expect(screen.getByTestId("field-value-text").textContent).toBe("いちばん");
  });
});

// ---------------------------------------------------------------------------
// 一覧の CSV 書き出し(V3-M12-T09。ADR-0007 §8 の 2026-07-19「一覧を CSV で書き出したい」)
// ---------------------------------------------------------------------------

/**
 * **書き出しの形は「コピー」であってダウンロードではない。**
 * `web/src/` に `createObjectURL` / `download=` / `new Blob(` は各0件(実測)であり、
 * 先例は `web/src/RequirementsDocPanel.tsx` と `web/src/ThemeExportPanel.tsx` の
 * 2本のコピーボタンである。**新しい持ち出し機構を作らない。**
 *
 * **書き出す範囲は現在ページの行だけ**(`T00` の裁定 (i))。したがって
 * **CSV を作るためにサーバへ問い合わせ直さない** —— これが `st_owner` の post-filter を
 * 越えられないことの実体である(サーバが渡した行より多くを、画面は持っていない)。
 *
 * **口の置き場は `<table class="list-table">` の `<caption>` である。**
 * `.list-view` の**直下の子**の並びは `web/test/preset-coverage.test.ts` と
 * `web/e2e/preset.e2e.ts` が `toEqual` で固定しており(どちらも本タスクの主対象外)、
 * 直下に要素を1つ足すとその固定が壊れる。表の口は表の中に置く。
 */
describe("CSV の書き出し(V3-M12-T09)", () => {
  /** `navigator.clipboard.writeText` に渡された文字列。 */
  let copied: string[];
  let originalClipboard: PropertyDescriptor | undefined;

  beforeEach(() => {
    copied = [];
    originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (text: string) => {
          copied.push(text);
          return Promise.resolve();
        },
      },
    });
  });

  afterEach(() => {
    if (originalClipboard === undefined) {
      Reflect.deleteProperty(navigator, "clipboard");
    } else {
      Object.defineProperty(navigator, "clipboard", originalClipboard);
    }
  });

  /** 書き出しボタンを押して、クリップボードに渡った CSV を返す。 */
  async function copyCsv(): Promise<string> {
    fireEvent.click(await screen.findByTestId("list-csv-copy"));
    await waitFor(() => {
      expect(copied).toHaveLength(1);
    });
    return copied[0] ?? "";
  }

  test("見出しは列の表示名で、行は画面に出ている行と同じ順に並ぶ", async () => {
    renderList();
    await findTable();
    const csv = await copyCsv();
    expect(csv).toBe(
      ["選択,テキスト,真偽,参照", "alpha,いちばん,true,参照先の名前", ",にばんめ,false,", ""].join(
        "\r\n",
      ),
    );
  });

  test("CSV を作るためにサーバへ問い合わせ直さない(現在ページの行だけを書き出す)", async () => {
    renderList();
    await findTable();
    const before = requestedUrls.length;
    await copyCsv();
    expect(requestedUrls.length).toBe(before);
  });

  test("サーバが返さなかった行は1行も出ない(st_owner の post-filter を越えられない)", async () => {
    // サーバは post-filter 後の行だけを返す(`src/server/app.ts` の `slicePage(visible, …)`)。
    // 画面はそれしか持っていないので、他人の行を書き出す経路が存在しない。
    entryRecords = [ENTRY_ROWS[0]];
    entryTotal = 1;
    renderList();
    await findTable();
    const csv = await copyCsv();
    expect(csv).toContain("いちばん");
    expect(csv).not.toContain("にばんめ");
    expect(csv.trimEnd().split("\r\n")).toHaveLength(2); // 見出し + 1行
  });

  test("ページを送ると、そのページの行だけが CSV になる(50件を超えて集めない)", async () => {
    entryTotal = 200;
    entryRecordsByOffset = {
      "0": [ENTRY_ROWS[0]],
      "50": [{ ...ENTRY_ROWS[1], f_text: "ごじゅういちばんめ" }],
    };
    renderList();
    await findTable();
    fireEvent.click(await screen.findByTestId("list-next"));
    await waitFor(() => {
      expect(screen.getAllByTestId("list-row")).toHaveLength(1);
    });
    await waitFor(() => {
      expect(screen.getByTestId("list-table").textContent).toContain("ごじゅういちばんめ");
    });
    const csv = await copyCsv();
    expect(csv).toContain("ごじゅういちばんめ");
    expect(csv).not.toContain("いちばん,");
  });

  test("区切り・引用符・改行を含む値は RFC4180 の形で囲む", async () => {
    entryRecords = [
      {
        ...ENTRY_ROWS[0],
        f_select: "alpha",
        f_text: 'カンマ, と "引用符" と\n改行',
        f_ref: null,
      },
    ];
    const csv = (() => {
      renderList();
      return findTable().then(copyCsv);
    })();
    expect(await csv).toBe(
      ["選択,テキスト,真偽,参照", 'alpha,"カンマ, と ""引用符"" と\n改行",true,', ""].join("\r\n"),
    );
  });

  test("参照の列は画面と同じ代表値になる(_id を書き出さない)", async () => {
    renderList();
    await findTable();
    const csv = await copyCsv();
    expect(csv).toContain("参照先の名前");
    expect(csv).not.toContain("target-1");
  });

  test("0件のときは書き出しの口を出さない(表そのものが無い)", async () => {
    entryRecords = [];
    renderList();
    await screen.findByTestId("list-empty");
    expect(screen.queryByTestId("list-csv-copy")).toBeNull();
  });

  test("クリップボードが使えない環境では失敗として出す(黙って成功と言わない)", async () => {
    // happy-dom は `Navigator` のプロトタイプに `clipboard` の getter を持つので、
    // 「無い」状態は `value: undefined` の自前プロパティで作る(theme-export.test.tsx と同じ)。
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    renderList();
    await findTable();
    fireEvent.click(screen.getByTestId("list-csv-copy"));
    await waitFor(() => {
      expect(screen.getByTestId("list-csv-result").textContent).toContain("コピーできませんでした");
    });
    expect(copied).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 部品体系での描き直し(V4-M15-T03。ADR-0087 / ADR-0089)
// ---------------------------------------------------------------------------

/**
 * **ここが確かめるのは「どの器で描いたか」と「既存の当たり先を1つも壊していないか」だけ**
 * である。**「見やすくなったか」は1件も測っていない。**
 *
 * 見た目の実値(色・余白・断点の効き)は happy-dom では解決されないので、**このファイルは
 * 計算値を1つも読まない**(先例: 本ファイル上部の「画面プリセット」節と同じ扱い)。
 * 計算値は `web/e2e` が chromium で見る。
 *
 * ## `data-testid="list-table"` の置き場が変わったこと(**隠さない**)
 *
 * **表は横に溢れうるので、狭い画面で読めるように `TableFrame`(`overflow-x-auto`)で
 * 包んだ**(`D-V4-44`)。**`.list-view` の直下の子の並びは `web/test/preset-coverage.test.ts`
 * と `web/e2e/preset.e2e.ts` が `data-testid` の列で `toEqual` 固定している**(ADR-0050 の
 * 軸3)ので、包みが `data-testid` を持たないと、その固定が「div」に化けて壊れる。
 * **そこで `data-testid="list-table"` は包みの側に置き、`class="list-table"`(プリセットと
 * テーマの当たり先)は `<table>` の側に残した。** testid は1つも消えていない。
 */
describe("部品体系での描き直し(V4-M15-T03)", () => {
  test("表は overflow-x-auto の器に包まれ、class=list-table は <table> に残る", async () => {
    renderList();
    const frame = await findTable();
    expect(frame.getAttribute("data-slot")).toBe("table-container");
    expect(frame.className).toContain("overflow-x-auto");
    const table = frame.querySelector("table");
    expect(table).not.toBeNull();
    expect(table?.className).toContain("list-table");
    expect(table?.getAttribute("data-slot")).toBe("table");
  });

  test("行・見出し・セルは部品体系の器になり、既存の class と属性は1つも消えない", async () => {
    renderList();
    await findTable();
    const row = screen.getAllByTestId("list-row")[0];
    expect(row?.getAttribute("data-slot")).toBe("table-row");
    expect(row?.className).toContain("list-row");
    expect(row?.className).toContain("list-row-interactive");
    expect(screen.getAllByRole("columnheader")[0]?.getAttribute("data-slot")).toBe("table-head");
    const cell = row?.querySelector("td");
    expect(cell?.getAttribute("data-slot")).toBe("table-cell");
    expect(cell?.getAttribute("data-field")).toBe("f_select");
    expect(cell?.getAttribute("data-field-type")).toBe("select");
  });

  test("読み込み中は Skeleton を出す(文言も testid も変えない)", () => {
    renderList();
    expect(screen.getByText(/読み込み中/)).toBeDefined();
    expect(screen.getByTestId("view-renderer-list_view")).toBeDefined();
    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  test("エラーは Alert(destructive)の中に、統一形式のまま出る", async () => {
    failWith = {
      status: 400,
      body: { errors: [{ path: "/sort/field", message: "テスト用のエラー", hint: "ヒント" }] },
    };
    renderList();
    const errors = await screen.findByTestId("errors");
    const alert = errors.closest('[data-slot="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.getAttribute("data-variant")).toBe("destructive");
    expect(errors.textContent).toContain("テスト用のエラー");
  });

  test("0件の一文は控えめな字色で出る(文言も testid も変えない)", async () => {
    entryRecords = [];
    renderList();
    const empty = await screen.findByTestId("list-empty");
    expect(empty.textContent).toBe("表示できるレコードがありません。");
    expect(empty.className).toContain("text-muted-foreground");
  });

  test("ページ送りは部品のボタンで、狭い画面では縦・sm(40rem)から横に並ぶ", async () => {
    entryTotal = 200;
    renderList();
    await findTable();
    const pager = screen.getByTestId("list-pager");
    expect(pager.className).toContain("list-pager");
    expect(pager.className).toContain("flex-col");
    expect(pager.className).toContain("sm:flex-row");
    for (const testId of ["list-prev", "list-next"]) {
      const button = screen.getByTestId(testId);
      expect(button.getAttribute("data-slot"), testId).toBe("button");
      expect((button as HTMLButtonElement).type, testId).toBe("button");
    }
  });

  test("CSV の口も部品のボタンになり、caption と既存 class は残る", async () => {
    renderList();
    await findTable();
    const copy = screen.getByTestId("list-csv-copy");
    expect(copy.getAttribute("data-slot")).toBe("button");
    const caption = copy.closest("caption");
    expect(caption).not.toBeNull();
    expect(caption?.className).toContain("list-csv");
  });

  /**
   * **【`V10-M18-T02`(`FU-G2`)の追記】** **この検査は着手時、9本目に
   * `list-detail-target-note` を数えていた**(旧の配列を逐語で残す ——
   * `list-view` / `list-table` / `list-row` / `list-row-interactive` / `list-total` /
   * `list-pager` / `list-csv` / `list-csv-result` / **`list-detail-target-note`**)。
   *
   * **`FU-G2` は、その class を DOM に出す唯一の場所(`<DetailTargetNote className=…>` の
   * 呼び出し)を撤去した。** **それでもこの検査は緑のままだった** —— **ファイル冒頭の
   * doc コメント(`V4-M15-T03` の節)に `.list-detail-target-note` という文字列が
   * 逐語で残っているからである。** **つまり「消していない」と名乗りながら、実際には
   * DOM に1度も出ない class を数え続ける形になっていた**(逐語の残置が検査を騙す)。
   *
   * **そこで9本目だけを外した。** **他の8本は1バイトも動かしていない。**
   * **`list-detail-target-note` が今日 DOM に出ないことは、上の
   * `作り手向けの注記を画面から出さない(FU-G2 / D-V10-21)` の節が DOM を見て固定している。**
   * **CSS 側の規則(`.list-detail-target-note, .detail-target-note`)は撤去していない**
   * —— 当たり先を1つも持たない規則1本が残る(理由は `V10-M18-T02` の記録に書く)。
   */
  test("既存の class 名を1つも消していない(ソースを読む。注記の class だけ FU-G2 で除いた)", () => {
    const source = readFileSync(join(import.meta.dir, "../src/views/ListViewRenderer.tsx"), "utf8");
    for (const name of [
      "list-view",
      "list-table",
      "list-row",
      "list-row-interactive",
      "list-total",
      "list-pager",
      "list-csv",
      "list-csv-result",
    ]) {
      expect(source, name).toContain(name);
    }
  });

  test("禁じられたクラスを1つも書いていない(ソースの文字列リテラルを読む)", () => {
    const source = readFileSync(join(import.meta.dir, "../src/views/ListViewRenderer.tsx"), "utf8");
    // 二重引用符の文字列リテラルだけを見る(日本語の注記を誤検出しないため)。
    const tokens = [...source.matchAll(/"([^"\n]*)"/g)]
      .flatMap((match) => (match[1] ?? "").split(/\s+/))
      .filter((token) => token.length > 0);
    // 25スロットから導出できない変数の入口(ADR-0087 限定7)。
    const forbiddenExact = new Set([
      "bg-primary",
      "text-primary-foreground",
      "bg-destructive",
      "text-destructive-foreground",
      "bg-card",
      "bg-popover",
      "text-popover-foreground",
      // 座標系(ADR-0087 限定8 の9プロパティ)。
      "relative",
      "absolute",
      "fixed",
      "sticky",
      "transform",
    ]);
    const forbiddenPrefix = [
      "dark:", // 配色設定のメディア特性(ADR-0087 限定10)
      "ring-", // `outline-ring` は可・`ring-*` は不可
      "md:", // 断点は sm(40rem)と lg(64rem)の2本だけ(ADR-0089 限定3)
      "xl:",
      "2xl:",
      "z-",
      "top-",
      "left-",
      "right-",
      "bottom-",
      "inset-",
      "float-",
      "translate-",
      "rotate-",
      "scale-",
    ];
    for (const token of tokens) {
      expect(forbiddenExact.has(token), token).toBe(false);
      for (const prefix of forbiddenPrefix) {
        expect(token.startsWith(prefix), `${token} (${prefix})`).toBe(false);
      }
    }
    // 配色設定のメディア特性・テーマ切り替えは1バイトも書かない(ADR-0089 限定6)。
    for (const forbidden of [
      "prefers-color-scheme",
      "[data-theme]",
      "light-dark(",
      "color-scheme:",
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });
});
