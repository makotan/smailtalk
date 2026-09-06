/**
 * HTTP API クライアント(レコード系)のテスト。
 *
 * 2種類のテストを持つ:
 *
 * 1. **fetch スタブ** — api.ts が組み立てた URL・メソッド・ボディをそのまま観測し、
 *    エラー応答が `ApiError` に変換されることを確かめる(速い・網羅的)。
 * 2. **実物合わせ** — `createServerApp` を一時 dataRoot で立ち上げ、`app.request()` を
 *    `fetch` の代わりに差し込む。ADR-0003 §5 のクエリ形式が実装と食い違えばここで落ちる。
 *    こちらが本命で、1 の期待値が化石化するのを防ぐ。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyManifest,
  createApp,
  KernelMetaStore,
  type Manifest,
} from "../../src/kernel/index.ts";
import { createServerApp } from "../../src/server/app.ts";
import { seedSession, TEST_ORIGIN } from "../../src/server/test-helpers.ts";
import {
  ApiError,
  createRecord,
  customerPasswordRegister,
  deleteRecord,
  fetchRecord,
  fetchRecordPage,
  fetchRecords,
  fetchRequirementsDoc,
  isApplyInProgress,
  isWriteConflict,
  updateRecord,
} from "../src/api.ts";
import { ADMIN_ROLES, grantRules, tableCan } from "./role-rules.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// --- 1. fetch スタブによる URL / ボディ / エラー変換の検証 ---------------------------

type Call = { url: string; method: string; body: string | undefined; headers: Headers };

/** 呼び出しを記録し、指定の応答を返す fetch スタブを仕掛ける。 */
function stubFetch(response: () => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
      headers: new Headers(init?.headers),
    });
    return Promise.resolve(response());
  }) as typeof fetch;
  return calls;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchRecords のクエリ組み立て(ADR-0003 §5)", () => {
  test("options なしならクエリを付けない", async () => {
    const calls = stubFetch(() => jsonResponse({ records: [] }));
    await fetchRecords("demo", "things");
    expect(calls[0]?.url).toBe("/api/apps/demo/tables/things/records");
    expect(calls[0]?.method).toBe("GET");
  });

  test("sort は sort= と order= の2つのパラメータに分解する", async () => {
    const calls = stubFetch(() => jsonResponse({ records: [] }));
    await fetchRecords("demo", "things", { sort: { field: "created_on", order: "desc" } });
    expect(calls[0]?.url).toBe("/api/apps/demo/tables/things/records?sort=created_on&order=desc");
  });

  test("filter は filter.<field>= 接頭辞で1条件1パラメータにする", async () => {
    const calls = stubFetch(() => jsonResponse({ records: [] }));
    await fetchRecords("demo", "things", {
      filter: [
        { field: "state", equals: "作業中" },
        { field: "count", equals: 12 },
        { field: "done", equals: false },
      ],
    });
    const query = calls[0]?.url.split("?")[1] ?? "";
    const params = new URLSearchParams(query);
    // number / boolean はサーバのデコード規則(Number() / "true"|"false")と対称な文字列にする。
    expect(params.get("filter.state")).toBe("作業中");
    expect(params.get("filter.count")).toBe("12");
    expect(params.get("filter.done")).toBe("false");
  });

  test("sort と filter は同時に載せられる", async () => {
    const calls = stubFetch(() => jsonResponse({ records: [] }));
    await fetchRecords("demo", "things", {
      sort: { field: "name", order: "asc" },
      filter: [{ field: "state", equals: "x" }],
    });
    const params = new URLSearchParams(calls[0]?.url.split("?")[1] ?? "");
    expect(params.get("sort")).toBe("name");
    expect(params.get("order")).toBe("asc");
    expect(params.get("filter.state")).toBe("x");
  });

  test("ID とフィルタ値は URL エンコードする", async () => {
    const calls = stubFetch(() => jsonResponse({ records: [] }));
    await fetchRecords("a b", "t/1", { filter: [{ field: "s", equals: "a&b=c" }] });
    const url = calls[0]?.url ?? "";
    expect(url.startsWith("/api/apps/a%20b/tables/t%2F1/records?")).toBe(true);
    expect(url).toContain("filter.s=a%26b%3Dc");
  });

  test("records キーの中身を配列として返す", async () => {
    stubFetch(() => jsonResponse({ records: [{ _id: "r1" }] }));
    const records = await fetchRecords("demo", "things");
    expect(records).toEqual([{ _id: "r1" }] as never);
  });
});

describe("fetchRecordPage のページネーション(EC-G11 / ADR-0042)", () => {
  test("limit / offset を limit= / offset= クエリに載せる", async () => {
    const calls = stubFetch(() => jsonResponse({ records: [], total: 0 }));
    await fetchRecordPage("demo", "things", { limit: 50, offset: 100 });
    const params = new URLSearchParams(calls[0]?.url.split("?")[1] ?? "");
    expect(params.get("limit")).toBe("50");
    expect(params.get("offset")).toBe("100");
  });

  test("sort / filter と limit / offset を同時に載せられる", async () => {
    const calls = stubFetch(() => jsonResponse({ records: [], total: 0 }));
    await fetchRecordPage("demo", "things", {
      sort: { field: "name", order: "asc" },
      limit: 10,
      offset: 20,
    });
    const params = new URLSearchParams(calls[0]?.url.split("?")[1] ?? "");
    expect(params.get("sort")).toBe("name");
    expect(params.get("limit")).toBe("10");
    expect(params.get("offset")).toBe("20");
  });

  test("records と total をそのまま返す", async () => {
    stubFetch(() => jsonResponse({ records: [{ _id: "r1" }, { _id: "r2" }], total: 7 }));
    const page = await fetchRecordPage("demo", "things", { limit: 2 });
    expect(page.records.map((r) => r._id)).toEqual(["r1", "r2"]);
    expect(page.total).toBe(7);
  });

  test("offset を指定しなければ limit / offset クエリは付かない(後方互換)", async () => {
    const calls = stubFetch(() => jsonResponse({ records: [], total: 0 }));
    await fetchRecordPage("demo", "things");
    expect(calls[0]?.url).toBe("/api/apps/demo/tables/things/records");
  });

  // **`V14-M2-T01`(`RB-G1`)。行ごとの判定を、画面が受け取る。**
  // **正はサーバの `recordRowAccessMap`(`src/server/owner-scope.ts`)である。**
  test("(RB-G1/api-1) 一覧: サーバが access を返したらそのまま持つ", async () => {
    stubFetch(() =>
      jsonResponse({
        records: [{ _id: "r1" }, { _id: "r2" }],
        total: 2,
        access: {
          r1: { read: true, write: true, delete: false, grant_write: true },
          r2: { read: true, write: false, delete: false, grant_write: false },
        },
      }),
    );
    const page = await fetchRecordPage("demo", "things");
    expect(page.access).toEqual({
      r1: { read: true, write: true, delete: false, grant_write: true },
      r2: { read: true, write: false, delete: false, grant_write: false },
    });
  });

  // **`{}` に倒さない** —— **`{}` は「誰も何もできない」という嘘になる。**
  test("(RB-G1/api-2) 一覧: サーバが返さなければ access キーが存在しない", async () => {
    stubFetch(() => jsonResponse({ records: [{ _id: "r1" }], total: 1 }));
    const page = await fetchRecordPage("demo", "things");
    expect(page).not.toHaveProperty("access");
  });
});

describe("単体取得・書き込み系の URL とメソッド", () => {
  // **【`V14-M2-T01` の訂正。旧名を1バイトも残さない代わりに、何が変わったかをここに書く】**
  // **着手前の名前は「fetchRecord は record キーを剥がして返す」だった。**
  // **T01 で `{ record, access }` を返す形に変えたので、その名前は今日から偽である。**
  test("fetchRecord は record キーを剥がさず { record, access } の形で返す", async () => {
    const calls = stubFetch(() => jsonResponse({ record: { _id: "r1" } }));
    const { record } = await fetchRecord("demo", "things", "r 1");
    expect(calls[0]?.url).toBe("/api/apps/demo/tables/things/records/r%201");
    expect(calls[0]?.method).toBe("GET");
    expect(record._id).toBe("r1");
  });

  // **【`V14-M4-T01` の訂正。この検査が何を前提にしていたかを消さずに書く】**
  // **着手前のこの検査は、サーバの `access` を**裸の判定オブジェクト**
  // (`{ read, write, delete, grant_write }`)として `fetch` に返させていた。**
  // **本物のサーバはそう返さない** —— **行の `_id` を鍵にした写像で返す**
  // (`src/server/app.ts` の `recordRowAccessMap`)。**この前提が偽だったので、
  // `fetchRecord` の取り違えがこの検査では1度も赤くならなかった。**
  // **土台を本物の形に直した。撃っている中身(`record` が1バイトも変わらないこと・
  // 判定がそのまま返ること)は1つも減らしていない。**
  test("(RB-G1/api-3) 単票: { record, access } を返し、record の形が1バイトも変わらない", async () => {
    stubFetch(() =>
      jsonResponse({
        record: { _id: "r1", name: "椅子", count: 3 },
        access: { r1: { read: true, write: false, delete: false, grant_write: true } },
      }),
    );
    const fetched = await fetchRecord("demo", "things", "r1");
    // **`record` の形が1バイトも変わっていない**(剥がした値がそのまま入っている)。
    expect({ ...fetched.record } as Record<string, unknown>).toEqual({
      _id: "r1",
      name: "椅子",
      count: 3,
    });
    expect(fetched.access).toEqual({ read: true, write: false, delete: false, grant_write: true });
  });

  test("(RB-G1/api-4) 単票: サーバが返さなければ access キーが存在しない", async () => {
    stubFetch(() => jsonResponse({ record: { _id: "r1" } }));
    const fetched = await fetchRecord("demo", "things", "r1");
    expect(fetched.record._id).toBe("r1");
    expect(fetched).not.toHaveProperty("access");
  });

  /**
   * **【`V14-M4-T01` の実地で見つかった欠陥】**
   *
   * **サーバが単票の口で返す `access` は、行の `_id` を鍵にした**写像**である** ——
   * **一覧の口と1バイトも同じ形である**(`src/server/app.ts` の `recordRowAccessMap` /
   * `accessForPage` が両方に同じ形を作る)。**本物のサーバの実測:**
   *
   * ```
   * {"record":{...},"access":{"c6721f33-...":{"read":true,"write":true,"delete":true,"grant_write":true}}}
   * ```
   *
   * **着手前の `fetchRecord` は、これを裸の判定オブジェクトだと綴っていた** ——
   * **`access["write"]` も `access["grant_write"]` も `undefined` になり、
   * `rowAccessAllows` がすべて偽に倒れ、詳細画面の行ごとの判定が当たるボタンが
   * 権限を持つ人からも全部消えていた**(本物のサーバとブラウザで3人ぶん実測)。
   * **一覧側は着手前から正しく写像として読んでいたので、一覧だけが正しく動いていた。**
   */
  test("(RB-G1/api-3c) 単票: access は行の _id を鍵にした写像で来る。その行ぶんを取り出す", async () => {
    stubFetch(() =>
      jsonResponse({
        record: { _id: "c6721f33-4282-4ddc-8cda-be9ccd9fc91c", name: "椅子" },
        access: {
          "c6721f33-4282-4ddc-8cda-be9ccd9fc91c": {
            read: true,
            write: true,
            delete: true,
            grant_write: true,
          },
        },
      }),
    );
    const fetched = await fetchRecord("demo", "things", "c6721f33-4282-4ddc-8cda-be9ccd9fc91c");
    expect(fetched.access).toEqual({
      read: true,
      write: true,
      delete: true,
      grant_write: true,
    });
  });

  test("(RB-G1/api-3d) 単票: 写像に自分の行が無ければ、access キーごと持たない", async () => {
    stubFetch(() =>
      jsonResponse({
        record: { _id: "r1" },
        // **別の行の鍵しか載っていない。** **その値を取り違えて当てないことを撃つ。**
        access: { other: { read: true, write: true, delete: true, grant_write: true } },
      }),
    );
    const fetched = await fetchRecord("demo", "things", "r1");
    // **既定は「出す」に倒れる**(`rowAccessAllows` の doc / `ADR-0402` 限定4)——
    // **【禁止】`{}` にも「全部偽」にも倒さない。**
    expect(fetched).not.toHaveProperty("access");
  });

  test("createRecord は POST で JSON ボディを送る", async () => {
    const calls = stubFetch(() => jsonResponse({ record: { _id: "r1" } }, 201));
    await createRecord("demo", "things", { name: "椅子" });
    expect(calls[0]?.url).toBe("/api/apps/demo/tables/things/records");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toBe(JSON.stringify({ name: "椅子" }));
  });

  test("updateRecord は PATCH で送り、版を If-Match に載せる(楽観ロック / M9-T02)", async () => {
    const calls = stubFetch(() => jsonResponse({ record: { _id: "r1" } }));
    await updateRecord("demo", "things", "r1", { name: null }, "2026-07-21T00:00:00.000Z");
    expect(calls[0]?.url).toBe("/api/apps/demo/tables/things/records/r1");
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.body).toBe(JSON.stringify({ name: null }));
    expect(calls[0]?.headers.get("if-match")).toBe("2026-07-21T00:00:00.000Z");
  });

  test("deleteRecord は DELETE で版を If-Match に載せ、204 のボディを読まない(M9-T02)", async () => {
    const calls = stubFetch(() => new Response(null, { status: 204 }));
    await deleteRecord("demo", "things", "r1", "2026-07-21T00:00:00.000Z");
    expect(calls[0]?.url).toBe("/api/apps/demo/tables/things/records/r1");
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.headers.get("if-match")).toBe("2026-07-21T00:00:00.000Z");
  });
});

describe("409 の判別(楽観ロック / M9-T02)", () => {
  // 文面はサーバ/カーネルの定義に合わせる(`versionConflictError` /`applyInProgressError`)。
  // ここが実装とずれると、下の「実サーバ突き合わせ」の版不一致テストが落ちて気づける。
  const conflictBody = {
    errors: [
      {
        path: "",
        message:
          'テーブル "things" のレコード "r1" は、あなたが取得した後に別の操作で変更されています。',
        hint: "最新の内容を取得し直してから、変更をやり直してください。",
      },
    ],
  };
  const applyingBody = {
    errors: [
      {
        path: "",
        message: "このアプリは現在変更を適用中です。少し待って再試行してください。",
        hint: "変更の適用(apply_diff)が完了するまで、レコードの作成・更新・削除はできません。",
      },
    ],
  };

  test("版不一致の 409 は isWriteConflict、isApplyInProgress ではない", async () => {
    stubFetch(() => jsonResponse(conflictBody, 409));
    try {
      await updateRecord("demo", "things", "r1", { name: "x" }, "old-version");
      throw new Error("ApiError が投げられていない");
    } catch (error) {
      expect(isWriteConflict(error)).toBe(true);
      expect(isApplyInProgress(error)).toBe(false);
    }
  });

  test("適用中の 409 は isApplyInProgress、isWriteConflict ではない", async () => {
    stubFetch(() => jsonResponse(applyingBody, 409));
    try {
      await deleteRecord("demo", "things", "r1", "some-version");
      throw new Error("ApiError が投げられていない");
    } catch (error) {
      expect(isApplyInProgress(error)).toBe(true);
      expect(isWriteConflict(error)).toBe(false);
    }
  });

  test("409 以外や ApiError でないものは、どちらの判別にもかからない", async () => {
    stubFetch(() => jsonResponse(conflictBody, 400));
    try {
      await updateRecord("demo", "things", "r1", { name: "x" }, "v");
      throw new Error("ApiError が投げられていない");
    } catch (error) {
      expect(isWriteConflict(error)).toBe(false);
      expect(isApplyInProgress(error)).toBe(false);
    }
    expect(isWriteConflict(new Error("just an error"))).toBe(false);
    expect(isApplyInProgress(undefined)).toBe(false);
  });

  test("特徴語を含まない 409 は、版不一致でも適用中でもない(汎用エラー表示に落ちる)", async () => {
    stubFetch(() => jsonResponse({ errors: [{ path: "", message: "別の理由の 409。" }] }, 409));
    try {
      await deleteRecord("demo", "things", "r1", "v");
      throw new Error("ApiError が投げられていない");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(isWriteConflict(error)).toBe(false);
      expect(isApplyInProgress(error)).toBe(false);
    }
  });
});

describe("エラー変換", () => {
  const errorBody = {
    errors: [{ path: "/quantity", message: "数量は必須です。", hint: "数値を入れてください。" }],
  };

  test("400 の errors をそのまま ApiError に載せる", async () => {
    stubFetch(() => jsonResponse(errorBody, 400));
    expect(createRecord("demo", "things", {})).rejects.toThrow(ApiError);
    try {
      await createRecord("demo", "things", {});
      throw new Error("ApiError が投げられていない");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const api = error as ApiError;
      expect(api.status).toBe(400);
      expect(api.errors).toEqual(errorBody.errors);
      expect(api.message).toBe("数量は必須です。");
    }
  });

  test("JSON でない応答でも統一形式のエラーに揃える", async () => {
    stubFetch(() => new Response("<html>", { status: 500 }));
    try {
      await deleteRecord("demo", "things", "r1", "v");
      throw new Error("ApiError が投げられていない");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const api = error as ApiError;
      expect(api.status).toBe(500);
      expect(api.errors).toHaveLength(1);
      expect(api.errors[0]?.path).toBe("");
    }
  });

  test("一覧・単体取得の 404 も ApiError になる", async () => {
    stubFetch(() => jsonResponse({ errors: [{ path: "", message: "ありません。" }] }, 404));
    expect(fetchRecords("nope", "things")).rejects.toBeInstanceOf(ApiError);
    expect(fetchRecord("nope", "things", "r1")).rejects.toBeInstanceOf(ApiError);
    expect(updateRecord("nope", "things", "r1", {}, "v")).rejects.toBeInstanceOf(ApiError);
  });
});

// --- 2. 実物合わせ(createServerApp に app.request でつなぐ) ------------------------

function demoManifest(): Manifest {
  const manifest: Manifest = {
    app: {
      id: "demo",
      name: "デモ",
      tables: [
        {
          id: "things",
          name: "もの",
          fields: [
            { id: "name", name: "名前", type: "text", required: true },
            { id: "count", name: "個数", type: "number" },
            { id: "done", name: "完了", type: "boolean" },
            { id: "state", name: "状態", type: "select", options: ["未着手", "作業中"] },
          ],
        },
      ],
      views: [{ id: "thing-list", type: "list_view", table: "things", columns: ["name"] }],
    },
  };
  // **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65`】表の既定が「閉じる」側へ倒れた。**
  //
  // **着手前の逐語(1バイトも消していない): この題材は `app.roles` を1つも持たず、
  // それでも作成・取得・更新・削除が実サーバで通っていた。**
  // **今日は通らない** —— **実測(このファイルの検査を落としていた実物の応答)**:
  //   - `POST .../records` → **403** 『表 "things" に対する書き込みは、あなたの役割に
  //     許されていません。』
  //   - `DELETE .../records/<id>` → **403**(同文の「削除は」版)
  //   - `GET .../records` → **200 だが `{"records":[],"total":0}`**(**拒否ではなく後段の絞り込みで
  //     0件になる**。ここが分かりにくい)
  //   - `GET .../records/<id>` → **404**(**存在しないのではなく、読めないので見えない**)
  // **さらに `app.roles` を書くなら、既定の3役割(owner / editor / viewer)を全部宣言し、
  // どの役割も規則を1本以上持たねばならない**(適用時検査。**片方でも欠けると
  // `applyManifest` が `valid: false` になり、表そのものが作られず `GET` が 404 になる**)。
  //
  // **直すのは題材の側であり、判定は1バイトも緩めていない。** **この検査の主題は
  // 「api.ts が組み立てた要求が実サーバを通ること」なので、通すのに要る最小限
  // (表 `things` の読取・書込・削除)だけを足す。画面・ボタン・項目の規則は1本も足さない**
  // (**画面の規則を足すとレコード取得 URL に `?view=` が載り、URL 完全一致の検査を壊すため**)。
  return grantRules(manifest, ADMIN_ROLES, [tableCan("things", "read", "write", "delete")]);
}

describe("実サーバ(createServerApp)との突き合わせ", () => {
  let dataRoot: string;

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "gp-web-api-"));
    const store = KernelMetaStore.open(dataRoot);
    try {
      createApp(store, "デモ", { app_id: "demo" });
    } finally {
      store.close();
    }
    expect(applyManifest(dataRoot, "demo", demoManifest()).valid).toBe(true);

    const server = createServerApp({ dataRoot });
    // 認証境界(ADR-0014)を通すため、同じ dataRoot にセッションを1件仕込む。
    // api.ts に credentials:"include" が入るのは P4 なので、ここでは cookie を注入する。
    const { cookie } = seedSession(dataRoot, "demo");
    // api.ts が組み立てた相対 URL を、そのまま実サーバのルータへ通す。
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("cookie", cookie);
      if (!headers.has("origin")) {
        headers.set("origin", TEST_ORIGIN);
      }
      return server.request(new URL(String(input), "http://localhost").toString(), {
        ...init,
        headers,
      });
    }) as typeof fetch;
  });

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  test("作成 → 一覧(sort/filter)→ 取得 → 更新 → 削除が実サーバで通る", async () => {
    const a = await createRecord("demo", "things", {
      name: "椅子",
      count: 3,
      done: false,
      state: "作業中",
    });
    const b = await createRecord("demo", "things", {
      name: "机",
      count: 1,
      done: true,
      state: "未着手",
    });
    expect(typeof a._id).toBe("string");

    // sort: 実サーバが order=desc を解釈できていなければ順序が逆になって落ちる。
    const sorted = await fetchRecords("demo", "things", {
      sort: { field: "count", order: "desc" },
    });
    expect(sorted.map((row) => row.name)).toEqual(["椅子", "机"]);

    // filter(string / number / boolean): デコード規則と非対称なら 400 か 0件で落ちる。
    expect(
      (
        await fetchRecords("demo", "things", { filter: [{ field: "state", equals: "作業中" }] })
      ).map((row) => row._id),
    ).toEqual([a._id]);
    expect(
      (await fetchRecords("demo", "things", { filter: [{ field: "count", equals: 1 }] })).map(
        (row) => row._id,
      ),
    ).toEqual([b._id]);
    expect(
      (await fetchRecords("demo", "things", { filter: [{ field: "done", equals: true }] })).map(
        (row) => row._id,
      ),
    ).toEqual([b._id]);

    // sort と filter の同時指定。
    const both = await fetchRecords("demo", "things", {
      sort: { field: "name", order: "asc" },
      filter: [{ field: "done", equals: false }],
    });
    expect(both.map((row) => row._id)).toEqual([a._id]);

    const fetched = await fetchRecord("demo", "things", a._id);
    expect(fetched.record.name).toBe("椅子");

    // 楽観ロック(M9-T02): 読んだ版を If-Match に載せて更新する。
    const updated = await updateRecord(
      "demo",
      "things",
      a._id,
      { count: 9 },
      fetched.record._updated_at,
    );
    expect(updated.count).toBe(9);
    expect(updated.name).toBe("椅子");

    await deleteRecord("demo", "things", a._id, updated._updated_at);
    expect(fetchRecord("demo", "things", a._id)).rejects.toBeInstanceOf(ApiError);
    expect((await fetchRecords("demo", "things")).map((row) => row._id)).toEqual([b._id]);
  });

  test("版不一致の更新は実サーバで 409 になり isWriteConflict が拾う(楽観ロック / M9-T02)", async () => {
    const a = await createRecord("demo", "things", { name: "椅子", count: 3 });
    // 版 v0 で1回更新 → 版が進む。
    const updated = await updateRecord("demo", "things", a._id, { count: 4 }, a._updated_at);
    expect(updated._updated_at).not.toBe(a._updated_at);
    // 古い版(a._updated_at)で再度更新 → CAS が外れて 409。
    const error = (await updateRecord("demo", "things", a._id, { count: 5 }, a._updated_at).catch(
      (e: unknown) => e,
    )) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(409);
    expect(isWriteConflict(error)).toBe(true);
    expect(isApplyInProgress(error)).toBe(false);
  });

  test("版不一致の削除も実サーバで 409 になり isWriteConflict が拾う(M9-T02)", async () => {
    const a = await createRecord("demo", "things", { name: "机", count: 1 });
    await updateRecord("demo", "things", a._id, { count: 2 }, a._updated_at); // 版を進める。
    const error = (await deleteRecord("demo", "things", a._id, a._updated_at).catch(
      (e: unknown) => e,
    )) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(409);
    expect(isWriteConflict(error)).toBe(true);
  });

  test("If-Match を空で送ると実サーバは 400(必須)", async () => {
    const a = await createRecord("demo", "things", { name: "棚", count: 1 });
    const error = (await updateRecord("demo", "things", a._id, { count: 2 }, "").catch(
      (e: unknown) => e,
    )) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(400);
    expect(isWriteConflict(error)).toBe(false);
  });

  test("カーネルのバリデーションエラーが ApiError として届く", async () => {
    try {
      await createRecord("demo", "things", { count: 1 });
      throw new Error("ApiError が投げられていない");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const api = error as ApiError;
      expect(api.status).toBe(400);
      expect(api.errors.length).toBeGreaterThan(0);
      expect(api.errors[0]?.path).toContain("name");
    }
  });

  test("存在しないテーブルは 404 の ApiError になる", async () => {
    const error = (await fetchRecords("demo", "nope").catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(404);
  });
});

// --- 要件定義書(V1-M8-T02 / ADR-0025 §10)---------------------------------------------

describe("fetchRequirementsDoc の URL 組み立て", () => {
  test("format=json を必ず付け、section 未指定ならクエリに載せない", async () => {
    const calls = stubFetch(() =>
      jsonResponse({
        requirements: {
          app_id: "demo",
          format: "json",
          section: null,
          statements: [],
          markdown: "",
          identifiers: {},
        },
      }),
    );
    await fetchRequirementsDoc("demo");
    expect(calls[0]?.url).toBe("/api/apps/demo/requirements?format=json");
    expect(calls[0]?.method).toBe("GET");
  });

  test("section は section= として載せる", async () => {
    const calls = stubFetch(() =>
      jsonResponse({
        requirements: {
          app_id: "demo",
          format: "json",
          section: "history",
          statements: [],
          markdown: "",
          identifiers: {},
        },
      }),
    );
    await fetchRequirementsDoc("demo", "history");
    expect(calls[0]?.url).toBe("/api/apps/demo/requirements?format=json&section=history");
  });
});

describe("fetchRequirementsDoc の実サーバ突き合わせ", () => {
  let dataRoot: string;

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "gp-web-req-"));
    const store = KernelMetaStore.open(dataRoot);
    try {
      createApp(store, "デモ", { app_id: "demo" });
    } finally {
      store.close();
    }
    expect(applyManifest(dataRoot, "demo", demoManifest()).valid).toBe(true);

    const server = createServerApp({ dataRoot });
    // **cookie を1つも載せない。** 要件定義書は changelog / manifest と同列の
    // 無認証(ローカル専用)なので、認証なしで通ることがここで実物と突き合う(§10-1)。
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      server.request(new URL(String(input), "http://localhost").toString(), init)) as typeof fetch;
  });

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  test("認証なしで取得でき、全記述に出典が付く", async () => {
    const doc = await fetchRequirementsDoc("demo");
    expect(doc.app_id).toBe("demo");
    expect(doc.statements.length).toBeGreaterThan(0);
    expect(doc.markdown).toContain("# 要件定義書");
    for (const statement of doc.statements) {
      expect(statement.sources.length).toBeGreaterThan(0);
    }
  });

  test("section を指定するとその節だけが返る", async () => {
    const all = await fetchRequirementsDoc("demo");
    const history = await fetchRequirementsDoc("demo", "history");
    expect(history.section).toBe("history");
    expect(history.statements.every((statement) => statement.section === "history")).toBe(true);
    // 期待値は全体の応答から導く(件数を焼き込まない)。
    expect(history.statements.length).toBe(
      all.statements.filter((statement) => statement.section === "history").length,
    );
  });

  test("存在しないアプリは 404 の ApiError になる", async () => {
    const error = (await fetchRequirementsDoc("nope").catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(404);
  });
});

// --- 顧客セルフサインアップ(V3-M3-T03 / D-G12a)--------------------------------------
//
// `customerPasswordRegister` は**顧客経路**(`auth/signup/password/register`)を叩く。
// 管理経路(`auth/password/register`)との違いはロールを決めるポリシーだけで、サーバ側は
// V2-M1 が実装済みである(`src/server/auth-routes.ts` の `CUSTOMER_SIGNUP`)。**T03 は
// サーバを1バイトも変えない**ので、ここでは (1) web が組み立てる URL と (2) 実サーバに通した
// ときに実際に `customer` が返ること、の2点を固定する。
// passkey の顧客経路は儀式のモックが要るため `web/test/customer-signup.test.tsx` で見る。

describe("顧客セルフサインアップの URL 組み立て", () => {
  test("customerPasswordRegister は管理経路ではなく顧客経路を POST する", async () => {
    const calls = stubFetch(() =>
      jsonResponse({
        user: { id: "u9", username: "shopper", displayName: null, role: "customer" },
      }),
    );
    const user = await customerPasswordRegister("demo", "shopper", "pw12345");
    expect(user.role).toBe("customer");
    expect(calls[0]?.url).toBe("/api/apps/demo/auth/signup/password/register");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toBe(JSON.stringify({ username: "shopper", password: "pw12345" }));
  });
});

describe("顧客セルフサインアップの実サーバ突き合わせ", () => {
  let dataRoot: string;

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "gp-web-customer-"));
    const store = KernelMetaStore.open(dataRoot);
    try {
      createApp(store, "デモ", { app_id: "demo" });
    } finally {
      store.close();
    }
    expect(applyManifest(dataRoot, "demo", demoManifest()).valid).toBe(true);

    const server = createServerApp({ dataRoot });
    // 認証の入口そのものを見るので cookie は入れない(未認証で叩く)。Origin だけ通す。
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (!headers.has("origin")) {
        headers.set("origin", TEST_ORIGIN);
      }
      return server.request(new URL(String(input), "http://localhost").toString(), {
        ...init,
        headers,
      });
    }) as typeof fetch;
  });

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  // **【`V8-M30` 第2波(2026-08-11)。ユーザ決定 `D-V8-82`。期待値を反転させた。**
  //   **旧のテスト名と旧の本文を逐語で残す】**
  // **旧のテスト名**: `顧客経路で登録すると、1人目でも owner にならず customer になる`
  // **旧の本文(逐語)**:
  //     // 管理経路なら「初回は owner」だが、顧客経路は初回でも customer(ADR-0033 §1b)。
  //     const user = await customerPasswordRegister("demo", "shopper", "pw12345");
  //     expect(user.role).toBe("customer");
  //     expect(user.username).toBe("shopper");
  // **根拠**: **ユーザ決定 `D-V8-82`(2026-08-11)。選ばれた見出し「最初の1人は必ず持ち主」。**
  // **説明文の逐語**: 「自分で登録した場合でも、そのアプリの最初の1人は持ち主になります。
  //   名乗った役割はそれに足されます。**公開の購入サイトでは、最初に買った客が運営者に
  //   なってしまいます。**」
  // **`ADR-0033` §1b の「顧客経路は初回でも customer」は、今日**成り立たない**。**
  // **【禁止】これを「安全になった」と書かない。**
  test("(反転) 顧客経路の1人目は持ち主になる(`D-V8-82`)。web が組み立てる URL は不変", async () => {
    const user = await customerPasswordRegister("demo", "shopper", "pw12345");
    expect(user.role).toBe("owner");
    expect(user.username).toBe("shopper");
  });

  test("同じ経路の2人目も customer(ロールは本文ではなく経路が決める)", async () => {
    // **【`V8-M30` 第2波 / `D-V8-82`】1人目(`shopper-1`)は今日から持ち主になる。**
    // **本検査の主題(2人目は経路が決めた種類になる)は1ミリも変えていない。**
    await customerPasswordRegister("demo", "shopper-1", "pw12345");
    const second = await customerPasswordRegister("demo", "shopper-2", "pw12345");
    expect(second.role).toBe("customer");
  });
});
