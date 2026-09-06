/**
 * `V14-M2-T03`(+ `V14-M2-T05` の**詳細画面ぶん**): **詳細画面が「行ごとの判定」で
 * ボタンを出し分ける。**
 *
 * **正は `ADR-0402` §Decision 5(4形ごとに見る対象)と §Decision 6(面は1回、行は後段)**
 * であり、**計画の正は `docs/plan/v14/01-v14-m2-tasks.md` §3** である。
 *
 * ## このファイルが固定すること
 *
 * | # | 条件 |
 * |---|---|
 * | (1) | `set` 形は**その行の `write`** を見る(真なら出る / 偽なら1つも出ない) |
 * | (2) | `run` 形も**その行の `write`** を見る(`D-V14-3`)。**`set` の検査を流用しない**(`ADR-0402` 限定27) |
 * | (3) | `form` 形(**作る先が今開いている表の付与表**)は**その行の `grant_write`** を見る |
 * | (4) | **サーバが `access` を返さない表では、着手前と1バイトも同じ見え方をする**(`ADR-0402` 限定4) |
 * | (5) | **面の判定は今日どおり1回だけ**である —— `writableActions` の依存配列に `record` が入っていない(`ADR-0402` §Decision 6) |
 *
 * ## **`run` と `form` を `set` とは別々のデータで撃っている**(`ADR-0402` 限定27)
 *
 * **3形はそれぞれ別の題材(別のマニフェスト・別の行 `_id`・別の `access`)で撃つ。**
 * **`run` の題材では `grant_write` を真に倒し、`form` の題材では `write` を真に倒してある** ——
 * **「たまたま別の動詞が偽だったので消えた」では緑にならない形にするためである。**
 *
 * ## このファイルが証明しないこと(**先に書く。誇張しない**)
 *
 * 1. **`fetch` を差し替えている。本物のサーバを1度も叩いていない。**
 *    **判定の正はサーバであり、その実測は `src/server/record-row-access-response.test.ts` が持つ。**
 * 2. **ボタンを隠すことは書込を止めることではない**(`ADR-0402` 限定7)。
 *    **URL を直接叩く経路は今日どおり 403 / 404 に到達する**(限定8)。
 *    **【禁止】本ファイルの緑を「押せなくなった」の根拠にしない** —— **出さないだけである。**
 * 3. **happy-dom であり、chromium で1度も確かめていない。**
 * 4. **`grant_write: true` を「押せば必ず作れる」と読まない**(`ADR-0402` §Decision 5 の禁止)
 *    —— **真が意味するのは関門 (1)(2) で止まらないことだけである。**
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { DetailView, Manifest } from "../../src/kernel/types.ts";
import type { Role, RowAccess } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { DetailViewRenderer } from "../src/views/DetailViewRenderer.tsx";
import { grantRules, viewRead } from "./role-rules.ts";

/**
 * **書ける立場**(`web/test/detail-view.test.tsx` と同じ作法)。**文字列リテラルで
 * `role="owner"` と書くと biome の `useValidAriaRole` が HTML の `role` 属性と誤認する。**
 */
const WRITER_ROLE: Role = "owner";

const APP_ID = "grant-buttons";

/** **行ごとに違う `_id` を使う** —— 3形の題材が互いのデータを流用していないことを見えるようにする。 */
const SET_ROW_ID = "row-for-set";
const RUN_ROW_ID = "row-for-run";
const FORM_ROW_ID = "row-for-form";
const PLAIN_ROW_ID = "row-without-access";

const PERMISSIONS = [
  { id: "reader", name: "読める", read: true, write: false, delete: false },
  { id: "keeper", name: "任せる", read: true, write: true, delete: true },
];

function row(id: string): Record<string, unknown> {
  return {
    _id: id,
    _created_at: "2026-01-01T00:00:00Z",
    _updated_at: "2026-01-02T00:00:00Z",
    title: "件名",
    state: "new",
  };
}

/** 付与表を持つ表1本と、その付与表。**`grant.table` だけが `form` 形の判定に効く**(計画 §0a)。 */
function baseTables(): Manifest["app"]["tables"] {
  return [
    {
      id: "entries",
      name: "案件",
      fields: [
        { id: "title", name: "件名", type: "text" },
        { id: "state", name: "状態", type: "text" },
      ],
      access_control: {
        enabled: true,
        permissions: [...PERMISSIONS],
        creator_permission: "keeper",
        grant: {
          table: "entry_grant",
          target: "entry",
          member: "member",
          permission: "permission",
        },
      },
    },
    {
      id: "people",
      name: "利用者",
      fields: [{ id: "label", name: "名前", type: "text" }],
    },
    {
      id: "entry_grant",
      name: "案件の付与",
      fields: [
        { id: "entry", name: "対象", type: "reference", reference_table: "entries" },
        { id: "member", name: "相手", type: "reference", reference_table: "people" },
        { id: "permission", name: "権限", type: "select", options: ["reader", "keeper"] },
      ],
    },
    {
      id: "notice",
      name: "通知",
      fields: [{ id: "title", name: "件名", type: "text" }],
    },
  ] as unknown as Manifest["app"]["tables"];
}

/** `set` 形の起点1つだけを持つ詳細画面。 */
function setManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "付与のボタン",
      tables: baseTables(),
      views: [
        {
          id: "entry-detail",
          type: "detail_view",
          table: "entries",
          actions: [{ set: { field: "state", value: "done" }, name: "完了にする" }],
        },
      ],
    },
  } as unknown as Manifest;
}

/** `run` 形の起点1つだけを持つ詳細画面(**`set` の題材を1バイトも流用しない**)。 */
function runManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "付与のボタン",
      tables: baseTables(),
      views: [
        {
          id: "entry-detail",
          type: "detail_view",
          table: "entries",
          actions: [{ run: "ship", name: "発送する" }],
        },
      ],
      workflows: [
        {
          id: "ship",
          name: "発送する",
          trigger: { type: "manual", table: "entries" },
          actions: [{ action: "create_record", table: "notice", values: { title: "発送" } }],
          history_table: "notice",
        },
      ],
    },
  } as unknown as Manifest;
}

/** `form` 形(**作る先が今開いている表の付与表**)の起点1つだけを持つ詳細画面。 */
function formManifest(): Manifest {
  const manifest = {
    app: {
      id: APP_ID,
      name: "付与のボタン",
      tables: baseTables(),
      views: [
        {
          id: "entry-detail",
          type: "detail_view",
          table: "entries",
          actions: [{ form: "grant-form", prefill: { field: "entry" }, name: "権限を配る" }],
        },
        {
          id: "grant-form",
          type: "form",
          table: "entry_grant",
          fields: ["entry", "member", "permission"],
        },
      ],
    },
  } as unknown as Manifest;
  // **遷移先 form を使えることは今日も面が答える**(`canUseView` 1本)。**判定を1バイトも緩めていない。**
  return grantRules(manifest, ["owner"], [viewRead("grant-form")]);
}

function detailView(manifest: Manifest): DetailView {
  const view = manifest.app.views.find((candidate) => candidate.type === "detail_view");
  if (view === undefined || view.type !== "detail_view") {
    throw new Error("fixture broken: detail_view がない");
  }
  return view;
}

let originalFetch: typeof fetch;
/** その行の `_id` → サーバが返す判定。**`undefined` を入れた行では `access` キーごと返さない。** */
let accessByRecord: Map<string, RowAccess | undefined>;

beforeEach(() => {
  accessByRecord = new Map();
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    const single = /\/api\/apps\/[^/]+\/tables\/entries\/records\/([^?]+)/.exec(url);
    if (method === "GET" && single !== null) {
      const recordId = decodeURIComponent(single[1] ?? "");
      const access = accessByRecord.get(recordId);
      return json({
        record: row(recordId),
        // **`sum` と同じ形** —— **返さないときはキーごと持たせない**(`{}` に倒さない)。
        //
        // **【`V14-M4-T01` の実地で見つかった欠陥。旧文を1バイトも消さずに残す】**
        // **旧**: `...(access === undefined ? {} : { access }),`
        // **この土台は判定を**裸**で載せていた。** **本物のサーバはそう返さない** ——
        // **単票の口も一覧と1バイトも同じく、行の `_id` を鍵にした写像で返す**
        // (`src/server/app.ts` の `recordRowAccessMap` / `accessForPage`)。
        // **土台が裸だったので、`fetchRecord` が写像を裸だと読んでいた取り違えが
        // この一式では1度も赤くならなかった。** **本物のサーバとブラウザで実測して
        // 初めて出た**(`grant_write` を持つ `taro` からもボタンが3つとも消えていた)。
        ...(access === undefined ? {} : { access: { [recordId]: access } }),
      });
    }
    if (method === "GET" && url.includes("/records")) {
      return json({ records: [], total: 0 });
    }
    return json({ errors: [{ path: "", message: `no stub for ${method} ${url}` }] }, 404);
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function renderDetail(manifest: Manifest, recordId: string) {
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/entry-detail/records/${recordId}`);
  return render(
    <RoleProvider role={WRITER_ROLE}>
      <DetailViewRenderer
        appId={APP_ID}
        manifest={manifest}
        view={detailView(manifest)}
        recordId={recordId}
      />
    </RoleProvider>,
  );
}

/** 行が描けたことを待つ(判定を当てる前に画面が出ていることを確かめる)。 */
async function waitForDetail(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByTestId("view-renderer-detail_view").textContent).toContain("件名");
  });
}

test("(RB-G1/detail-1) 付与を持つ行(write: true)では set 形のボタンが出る", async () => {
  accessByRecord.set(SET_ROW_ID, {
    read: true,
    write: true,
    delete: false,
    // **`grant_write` は偽である** —— **`set` が見ているのが `write` であることを見えるようにする。**
    grant_write: false,
  });
  renderDetail(setManifest(), SET_ROW_ID);
  await waitForDetail();
  expect(screen.getByTestId("action-set-state")).toBeDefined();
});

test("(RB-G1/detail-2) 付与を持たない行(write: false)では set 形のボタンが1つも出ない", async () => {
  accessByRecord.set(SET_ROW_ID, {
    read: true,
    write: false,
    delete: true,
    // **他の3つを真に倒してある** —— **`write` 以外で消えたのではないことを見えるようにする。**
    grant_write: true,
  });
  renderDetail(setManifest(), SET_ROW_ID);
  await waitForDetail();
  expect(screen.queryByTestId("action-set-state")).toBeNull();
  // **器ごと出ない**(残った起点が0本なので)。
  expect(screen.queryByTestId("detail-action-origins")).toBeNull();
});

test("(RB-G4/detail-3) run 形は write: false の行で出ない", async () => {
  accessByRecord.set(RUN_ROW_ID, {
    read: true,
    write: false,
    delete: true,
    grant_write: true,
  });
  renderDetail(runManifest(), RUN_ROW_ID);
  await waitForDetail();
  expect(screen.queryByTestId("action-run-ship")).toBeNull();
});

test("(RB-G4/detail-3b) run 形は write: true の行で出る(set の検査を流用しない)", async () => {
  accessByRecord.set(RUN_ROW_ID, {
    read: true,
    write: true,
    delete: false,
    grant_write: false,
  });
  renderDetail(runManifest(), RUN_ROW_ID);
  await waitForDetail();
  expect(screen.getByTestId("action-run-ship")).toBeDefined();
});

test("(RB-G3/detail-4) form 形(付与表行き)は grant_write: false の行で出ない", async () => {
  accessByRecord.set(FORM_ROW_ID, {
    read: true,
    // **`write` は真である** —— **`grant_write` が別の問いであることを見えるようにする。**
    write: true,
    delete: true,
    grant_write: false,
  });
  renderDetail(formManifest(), FORM_ROW_ID);
  await waitForDetail();
  expect(screen.queryByTestId("action-origin-grant-form")).toBeNull();
});

test("(RB-G3/detail-4b) form 形(付与表行き)は grant_write: true の行で出る", async () => {
  accessByRecord.set(FORM_ROW_ID, {
    read: true,
    // **`write` は偽である** —— **`form` が見ているのが `grant_write` であることを見えるようにする。**
    write: false,
    delete: false,
    grant_write: true,
  });
  renderDetail(formManifest(), FORM_ROW_ID);
  await waitForDetail();
  expect(screen.getByTestId("action-origin-grant-form")).toBeDefined();
});

test("(RB-G1/detail-5) access が載っていない表では、着手前と同じくすべて出る", async () => {
  // **`accessByRecord` に1件も入れない** = **サーバが `access` キーごと返さない**(限定4)。
  renderDetail(setManifest(), PLAIN_ROW_ID);
  await waitForDetail();
  expect(screen.getByTestId("action-set-state")).toBeDefined();

  cleanup();
  renderDetail(runManifest(), PLAIN_ROW_ID);
  await waitForDetail();
  expect(screen.getByTestId("action-run-ship")).toBeDefined();

  cleanup();
  renderDetail(formManifest(), PLAIN_ROW_ID);
  await waitForDetail();
  expect(screen.getByTestId("action-origin-grant-form")).toBeDefined();
});

/**
 * **面は1回、行は後段**(`ADR-0402` §Decision 6)。
 *
 * **`writableActions` の `useMemo` の依存配列に `record` を入れない** —— **入れると
 * 面の評価回数が行に比例して増え、サーバ側(`ADR-0308` `J-G20`)と逆向きの作法になる。**
 * **【誇張しない】これは本文を走査しているだけであり、評価回数を1度も数えていない。**
 */
test("(RB-G1/detail-6) writableActions の依存配列に record が入っていない", async () => {
  const source = await Bun.file(
    new URL("../src/views/DetailViewRenderer.tsx", import.meta.url),
  ).text();
  const start = source.indexOf("const writableActions = useMemo(");
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("\n  );", start);
  expect(end).toBeGreaterThan(start);
  const block = source.slice(start, end);
  const depsLine = block
    .split("\n")
    .filter((line) => line.trimStart().startsWith("["))
    .at(-1);
  expect(depsLine).toBeDefined();
  expect(depsLine).not.toContain("record");
});

/**
 * **【`V14-M4-T01` の実地で見つかった欠陥】単票の口の `access` は**写像**である。**
 *
 * **鍵は今開いている行の `_id` である。** **写像の中身をそのまま(あるいは値を1つ
 * 取り出して)当てると、別の行の判定でボタンを出し分けてしまう。**
 * **ここは「別の行の鍵しか載っていない」写像を返させ、`ADR-0402` 限定4 の既定
 * (= 出す)に倒れることを撃つ** —— **`{}` にも「全部偽」にも倒さない。**
 */
test("(RB-G1/detail-7) access の写像に自分の行が載っていなければ、着手前と同じくボタンが出る", async () => {
  const originalStub = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (method === "GET" && /\/tables\/entries\/records\/[^?]+/.test(url)) {
      return new Response(
        JSON.stringify({
          record: row(SET_ROW_ID),
          // **別の行の鍵しか無い。** **値は「全部真」なので、取り違えると緑になってしまう
          // ことは無い代わりに、`Object.values()[0]` のような近道も見えるようにしてある。**
          access: {
            "some-other-row": { read: true, write: true, delete: true, grant_write: true },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return await originalStub(input, init);
  }) as typeof fetch;
  renderDetail(setManifest(), SET_ROW_ID);
  await waitForDetail();
  expect(screen.getByTestId("action-set-state")).toBeDefined();
});

/**
 * **【`V14-M6-T02` / 単位 `RB-G7`(門外・限定採用。`ADR-0007` §8 台帳)の追記。
 * 上の散文を1バイトも消していない】**
 *
 * **組み込みの「削除」ボタンも、その行を消せるかで出し分ける。**
 *
 * **見る動詞は `delete` である** —— **押した先でサーバが見る動詞に合わせる**
 * (`src/server/app.ts:6243`-`:6244` 逐語 `if (!access.verdict.delete) {` /
 * `return c.json(errorBody([forbiddenRecordDeleteError()]), 403);`)。
 * **`write` で代用しない。** **`(RB-G7/detail-4)` がそれを撃つ。**
 *
 * **【禁止】ここの緑を「押せなくなった」の根拠にしない**(`ADR-0402` 限定7)——
 * **遮断は今日どおりサーバの 403 である。出さないだけである。**
 */
test("(RB-G7/detail-1) delete: false の行では組み込みの削除ボタンが出ない", async () => {
  accessByRecord.set(SET_ROW_ID, {
    read: true,
    // **`write` は真である** —— **`delete` が別の問いであることを見えるようにする。**
    write: true,
    delete: false,
    grant_write: true,
  });
  renderDetail(setManifest(), SET_ROW_ID);
  await waitForDetail();
  expect(screen.queryByTestId("detail-delete")).toBeNull();
  // **確認の枝も出ない**(押す前なので当然だが、枝ごと消えていることを見えるようにする)。
  expect(screen.queryByTestId("detail-delete-confirm")).toBeNull();
});

test("(RB-G7/detail-2) delete: true の行では今日どおり削除ボタンが出る", async () => {
  accessByRecord.set(SET_ROW_ID, {
    read: true,
    write: true,
    delete: true,
    grant_write: false,
  });
  renderDetail(setManifest(), SET_ROW_ID);
  await waitForDetail();
  expect(screen.getByTestId("detail-delete")).toBeDefined();
});

test("(RB-G7/detail-3) access が載っていない表では今日どおり削除ボタンが出る", async () => {
  // **`accessByRecord` に1件も入れない** = **サーバが `access` キーごと返さない**
  // (`ADR-0402` 限定4。**宣言していない表では着手前と1バイトも変わらない**)。
  renderDetail(setManifest(), PLAIN_ROW_ID);
  await waitForDetail();
  expect(screen.getByTestId("detail-delete")).toBeDefined();
});

/**
 * **`write` で代用していないことを撃つ。**
 *
 * **`write: false` / `delete: true` の行** —— **`write` を見ていたら削除ボタンは消えるが、
 * サーバは `access.verdict.delete` で判定するので、この行の `DELETE` は 403 にならない。**
 * **押せる操作の導線を消してはならない。**
 */
test("(RB-G7/detail-4) write: false でも delete: true なら削除ボタンは出る", async () => {
  accessByRecord.set(SET_ROW_ID, {
    read: true,
    write: false,
    delete: true,
    grant_write: false,
  });
  renderDetail(setManifest(), SET_ROW_ID);
  await waitForDetail();
  expect(screen.getByTestId("detail-delete")).toBeDefined();
  // **同じ行で `set` 形の起点は消えている**(`write: false` なので)——
  // **2つの動詞が別々に効いていることを、1つの行の上で見えるようにする。**
  expect(screen.queryByTestId("action-set-state")).toBeNull();
});

/**
 * **【`V14-M6-T03` / 単位 `RB-G8`(門外・限定採用。`ADR-0007` §8 台帳)の追記。
 * 上の散文を1バイトも消していない】**
 *
 * ## **【最初に測る】この一式の3つの土台には `entries` の `form` が1本も無い**
 *
 * **`setManifest` / `runManifest` / `formManifest` のどれもが、`entries` 表を対象にした
 * `type: "form"` の画面を持たない**(`formManifest` の form は `entry_grant` 表である)。
 * **`DetailViewRenderer.tsx:496`-`:500` の `formView` は
 * `candidate.type === "form" && candidate.table === view.table`(= `"entries"`)を要求するので、
 * **この3つの土台では `formView === undefined` になり、組み込みの「編集」ボタンは
 * 今日1度も描かれない。**
 *
 * **だから `RB-G8` の検査は、この3つの土台のままでは1本も書けない**(計画 §6 `R-5`)。
 * **`entries` 表の `form` を持つ土台を新設する**({@link editManifest})—— **既存の3つの
 * 土台は1バイトも書き換えていない**(他の検査が寄りかかっているためである)。
 *
 * **この検査を残すのは、「足したことで出るようになった」ことが後から読めるようにするためである。**
 * **【誇張しない】これは `RB-G8` の直しを1文字も撃っていない。** **土台の性質を測っただけである。**
 */
test("(RB-G8/detail-0) 素の3土台には entries の form が無いので、編集ボタンはそもそも描かれない", async () => {
  // **`access` は1件も入れない** —— **行の判定ではなく、土台に form が無いことだけが理由である。**
  renderDetail(setManifest(), PLAIN_ROW_ID);
  await waitForDetail();
  expect(screen.queryByTestId("detail-edit")).toBeNull();

  cleanup();
  renderDetail(runManifest(), PLAIN_ROW_ID);
  await waitForDetail();
  expect(screen.queryByTestId("detail-edit")).toBeNull();

  cleanup();
  renderDetail(formManifest(), PLAIN_ROW_ID);
  await waitForDetail();
  expect(screen.queryByTestId("detail-edit")).toBeNull();

  // **土台の側も名指しで測る** —— **「たまたま描かれなかった」ではなく
  // **`entries` を対象にした `form` が0本である**ことを見えるようにする。**
  for (const manifest of [setManifest(), runManifest(), formManifest()]) {
    const entriesForms = manifest.app.views.filter(
      (candidate) => candidate.type === "form" && candidate.table === "entries",
    );
    expect(entriesForms).toEqual([]);
  }
});

/** **編集ボタンの題材で使う行の `_id`**(他の4つの題材のデータを1バイトも流用しない)。 */
const EDIT_ROW_ID = "row-for-edit";

/**
 * **`entries` 表の `form` を1本持つ土台**(`V14-M6-T03` で**新設**した4つ目の土台)。
 *
 * **既存の3つ(`setManifest` / `runManifest` / `formManifest`)を1バイトも書き換えていない**
 * (計画 §6 `R-5`)—— **他の検査がそれらに寄りかかっているためである。**
 *
 * **`DetailViewRenderer.tsx:496`-`:500` の `formView` は
 * `candidate.type === "form" && candidate.table === view.table` を要求するので、
 * **`table: "entries"` の form でなければ組み込みの「編集」ボタンは1度も描かれない。**
 *
 * **役割の規則は既存の {@link formManifest} と同じ形で足す**(逐語
 * `return grantRules(manifest, ["owner"], [viewRead("grant-form")]);`)——
 * **遷移先 form を開けることは今日も面が答える**(`canUseView` 1本)。**判定を1バイトも
 * 緩めていない** —— **足したのは題材の側の宣言だけである。**
 */
function editManifest(): Manifest {
  const manifest = {
    app: {
      id: APP_ID,
      name: "付与のボタン",
      tables: baseTables(),
      views: [
        {
          id: "entry-detail",
          type: "detail_view",
          table: "entries",
          actions: [{ set: { field: "state", value: "done" }, name: "完了にする" }],
        },
        {
          id: "entry-form",
          type: "form",
          table: "entries",
          fields: ["title", "state"],
        },
      ],
    },
  } as unknown as Manifest;
  return grantRules(manifest, ["owner"], [viewRead("entry-form")]);
}

/**
 * **組み込みの「編集」ボタンも、その行を書き換えられるかで出し分ける**(単位 `RB-G8`)。
 *
 * **見る動詞は `write` である** —— **押した先(入力画面の保存)でサーバが見る動詞に合わせる。**
 * **`src/server/app.ts:6079`-`:6080` 逐語(自分で開いて確かめた):**
 * `if (!access.verdict.write) {` / `return c.json(errorBody([forbiddenRecordWriteError()]), 403);`
 * **その文面は同 `:496` 逐語「この行を書き換える権限がありません(読むことはできます)。」である。**
 * **`delete` で代用しない。** **`(RB-G8/detail-4)` がそれを撃つ。**
 *
 * **【禁止】ここの緑を「押せなくなった」の根拠にしない**(`ADR-0402` 限定7)——
 * **遮断は今日どおりサーバの 403 である。出さないだけである。**
 */
test("(RB-G8/detail-1) write: false の行では組み込みの編集ボタンが出ない", async () => {
  accessByRecord.set(EDIT_ROW_ID, {
    read: true,
    write: false,
    delete: false,
    grant_write: false,
  });
  renderDetail(editManifest(), EDIT_ROW_ID);
  await waitForDetail();
  expect(screen.queryByTestId("detail-edit")).toBeNull();
});

test("(RB-G8/detail-2) write: true の行では今日どおり編集ボタンが出る", async () => {
  accessByRecord.set(EDIT_ROW_ID, {
    read: true,
    write: true,
    // **`delete` と `grant_write` は偽である** —— **`write` が見られていることを
    // 見えるようにする**(他の動詞で出ているのではない)。
    delete: false,
    grant_write: false,
  });
  renderDetail(editManifest(), EDIT_ROW_ID);
  await waitForDetail();
  expect(screen.getByTestId("detail-edit")).toBeDefined();
});

test("(RB-G8/detail-3) access が載っていない表では今日どおり編集ボタンが出る", async () => {
  // **`accessByRecord` に1件も入れない** = **サーバが `access` キーごと返さない**
  // (`ADR-0402` 限定4。**宣言していない表では着手前と1バイトも変わらない**)。
  renderDetail(editManifest(), PLAIN_ROW_ID);
  await waitForDetail();
  expect(screen.getByTestId("detail-edit")).toBeDefined();
});

/**
 * **`delete` で代用していないことを撃つ。**
 *
 * **`write: false` / `delete: true` の行**(= **消せるが書き換えられない人**)——
 * **`delete` を見ていたら編集ボタンは出てしまうが、この行の `PATCH` はサーバが 403 にする。**
 * **逆に `delete` で代用すると、`write: true` / `delete: false` の人
 * (**編集はできるが消せない**)から編集ボタンを奪ってしまう。**
 *
 * **同じ1行の上で、削除ボタンが今日どおり出ることも併せて撃つ** ——
 * **2つの動詞が別々に効いていることを見えるようにする。**
 */
test("(RB-G8/detail-4) delete: true でも write: false なら編集ボタンは出ない", async () => {
  accessByRecord.set(EDIT_ROW_ID, {
    read: true,
    write: false,
    delete: true,
    grant_write: false,
  });
  renderDetail(editManifest(), EDIT_ROW_ID);
  await waitForDetail();
  expect(screen.queryByTestId("detail-edit")).toBeNull();
  // **同じ行で組み込みの削除ボタンは出ている**(`delete: true` なので。`RB-G7`)。
  expect(screen.getByTestId("detail-delete")).toBeDefined();
});

/**
 * **「閲覧のみ」の注記の条件を1バイトも変えていない**(計画 §3 の 5)。
 *
 * ## **【この段が引き受ける代償。隠さない】**
 *
 * **`canWriteRecord`(`DetailViewRenderer.tsx:820`)は真のままであり、注記を出す条件
 * (同 `:1307` の `!canWriteRecord && isWriteAudienceRole(role, table)`)は立たない。**
 * **したがって、行ごとの付与で編集ボタンが消えた人には「閲覧のみ(書き込み権限がありません)。」
 * という説明が1文字も出ない。**
 *
 * **これは `D-V14-1`(逐語「出さない(隠す)」)が既に引き受けた代償と同じものである** ——
 * **「そもそも無い」と「自分に権限が無い」を利用者は見分けられない。**
 * **本段はこれを直さない。** **直すなら別の単位であり、門の判定からやり直す。**
 *
 * **この検査は「直っていること」ではなく「代償がそこに在ること」を固定する。**
 */
test("(RB-G8/detail-5) 付与で編集ボタンだけが消えた行では、閲覧のみの注記は出ない", async () => {
  accessByRecord.set(EDIT_ROW_ID, {
    read: true,
    write: false,
    delete: false,
    grant_write: false,
  });
  renderDetail(editManifest(), EDIT_ROW_ID);
  await waitForDetail();
  // 前提: **編集ボタンだけが消えている。**
  expect(screen.queryByTestId("detail-edit")).toBeNull();
  // **注記は出ない** —— **`canWriteRecord` が真のままだからである**(条件を1バイトも変えていない)。
  expect(screen.queryByTestId("detail-read-only")).toBeNull();
});
