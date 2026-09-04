/**
 * form 汎用コンポーネントのコンポーネントテスト(V0-P3-T05)。
 *
 * 検証するのは「マニフェストを解釈して入力UIを作り、送って、返ってきた統一形式の
 * エラーをフィールド単位で出す」ことだけ。**フロント側の検証ロジックは検証しない**
 * (存在してはいけないため)。
 *
 * ここに出てくるアプリ固有の名前(items / 備品 など)は**このテストファイル内だけ**の
 * フィクスチャであり、実装側には現れない(CP-3 確認方法4)。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { FormView, Manifest } from "../../src/kernel/types.ts";
import type { Role } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";

/**
 * **書ける立場**(`V4-M2-T06`)。**文字列リテラルで `role="owner"` と書くと biome の
 * a11y 規則(`useValidAriaRole`)が HTML の `role` 属性と誤認するので、変数経由で渡す**
 * (`web/test/authz.test.tsx` が `role={role}` と書いているのと同じ形)。
 */
const WRITER_ROLE: Role = "owner";

/** **書けない立場**(`form-read-only` の表示を測るためだけに使う)。 */
const READER_ROLE: Role = "viewer";

import { FormRenderer } from "../src/views/FormRenderer.tsx";

const APP_ID = "sample-app";
const CATEGORY_ID = "category-0001";

/** 7型すべてと reference 先テーブルを含むフィクスチャ。 */
function sampleManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "サンプル",
      tables: [
        {
          id: "categories",
          name: "カテゴリ",
          fields: [
            { id: "label", name: "カテゴリ名", type: "text", required: true },
            { id: "memo", name: "メモ", type: "long_text" },
          ],
        },
        {
          id: "items",
          name: "備品",
          fields: [
            { id: "name", name: "備品名", type: "text", required: true },
            { id: "note", name: "備考", type: "long_text" },
            { id: "quantity", name: "数量", type: "number", required: true },
            { id: "in_use", name: "使用中", type: "boolean" },
            { id: "purchased_at", name: "購入日", type: "date" },
            { id: "condition", name: "状態", type: "select", options: ["新品", "良好"] },
            { id: "category", name: "カテゴリ", type: "reference", reference_table: "categories" },
          ],
        },
      ],
      views: [
        { id: "item-list", type: "list_view", table: "items", columns: ["name"] },
        {
          id: "item-form",
          type: "form",
          table: "items",
          fields: ["name", "note", "quantity", "in_use", "purchased_at", "condition", "category"],
        },
      ],
    },
  };
}

function formView(manifest: Manifest): FormView {
  const view = manifest.app.views.find((candidate) => candidate.type === "form");
  if (view === undefined || view.type !== "form") {
    throw new Error("fixture broken: form view がない");
  }
  return view;
}

type StubRequest = { url: string; method: string; body: unknown };

let requests: StubRequest[];
let originalFetch: typeof fetch;
/** テストごとに差し替える応答テーブル(URL+メソッド → [status, body])。 */
let responses: Map<string, [number, unknown]>;
/** 参照先テーブルの一覧レスポンス。 */
let categoryRecords: unknown[];

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ITEMS_PATH = `/api/apps/${APP_ID}/tables/items/records`;
const CATEGORIES_PATH = `/api/apps/${APP_ID}/tables/categories/records`;

beforeEach(() => {
  requests = [];
  responses = new Map();
  categoryRecords = [
    {
      _id: CATEGORY_ID,
      _created_at: "2026-01-01T00:00:00Z",
      _updated_at: "2026-01-01T00:00:00Z",
      label: "文房具",
      memo: null,
    },
  ];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    requests.push({ url, method, body });

    const stubbed = responses.get(`${method} ${url}`);
    if (stubbed !== undefined) {
      return jsonResponse(stubbed[1], stubbed[0]);
    }
    if (method === "GET" && url.startsWith(CATEGORIES_PATH)) {
      return jsonResponse({ records: categoryRecords }, 200);
    }
    if (method === "POST" && url === ITEMS_PATH) {
      return jsonResponse({ record: { _id: "created" } }, 201);
    }
    return jsonResponse({ errors: [{ path: "", message: `no stub for ${method} ${url}` }] }, 404);
  }) as typeof fetch;
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/item-form`);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

/**
 * 編集対象レコードは URL(`route.ts` の `Route.recordId`)から props で降ってくる。
 * `?record=` を直接読む回避策は V0-P3-T06 で撤去した。
 */
/**
 * **【V4-M2-T06 / `ADR-0074` 限定6 で `RoleProvider` を足した】**
 *
 * **着手前はレンダラを裸で描いており、`useRole()` が `null` を返しても
 * `canWriteRole(null)` が `true` だったので保存ボタンが出ていた。**
 * **`ADR-0074` 限定6 がその既定を `false` に反転させた**(理由は
 * `web/src/auth/authz.tsx` のヘッダと審査記録 §3 の S3-2a)。
 * **本ファイルが測るのは「書ける立場の人がフォームを使う流れ」なので、
 * 書ける立場を明示する側が本来の意図に近い。** **判定の中身は1つも変えていない。**
 */
function renderForm(manifest: Manifest = sampleManifest(), recordId?: string) {
  return render(
    <RoleProvider role={WRITER_ROLE}>
      <FormRenderer
        appId={APP_ID}
        manifest={manifest}
        view={formView(manifest)}
        recordId={recordId}
      />
    </RoleProvider>,
  );
}

/** 参照先の取得が終わるまで待つ(reference の select が選択肢を持つまで)。 */
async function waitForReady() {
  await waitFor(() => {
    expect(screen.getByLabelText(/カテゴリ/)).toBeDefined();
  });
  await waitFor(() => {
    expect(requests.some((request) => request.url.startsWith(CATEGORIES_PATH))).toBe(true);
  });
}

describe("7型の入力UI", () => {
  test("フィールド型に応じた入力要素になる", async () => {
    renderForm();
    await waitForReady();

    const name = screen.getByLabelText(/備品名/) as HTMLInputElement;
    expect(name.tagName).toBe("INPUT");
    expect(name.type).toBe("text");

    expect((screen.getByLabelText(/備考/) as HTMLElement).tagName).toBe("TEXTAREA");
    expect((screen.getByLabelText(/数量/) as HTMLInputElement).type).toBe("number");
    expect((screen.getByLabelText(/使用中/) as HTMLInputElement).type).toBe("checkbox");
    expect((screen.getByLabelText(/購入日/) as HTMLInputElement).type).toBe("date");
    expect((screen.getByLabelText(/状態/) as HTMLElement).tagName).toBe("SELECT");
    expect((screen.getByLabelText(/カテゴリ/) as HTMLElement).tagName).toBe("SELECT");
  });

  test("入力欄はマニフェストの fields の順に並ぶ", async () => {
    renderForm();
    await waitForReady();
    const labels = screen.getAllByTestId(/^field-label-/).map((node) => node.textContent ?? "");
    expect(labels.map((text) => text.replace("必須", ""))).toEqual([
      "備品名",
      "備考",
      "数量",
      "使用中",
      "購入日",
      "状態",
      "カテゴリ",
    ]);
  });

  test("select の選択肢はマニフェスト由来で、未選択も表現できる", async () => {
    renderForm();
    await waitForReady();
    const select = screen.getByLabelText(/状態/) as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(["", "新品", "良好"]);
    expect(select.value).toBe("");
  });

  test("reference は参照先レコードを代表値で選ばせる(値は _id)", async () => {
    renderForm();
    await waitForReady();
    const select = screen.getByLabelText(/カテゴリ/) as HTMLSelectElement;
    await waitFor(() => {
      expect(select.options.length).toBe(2);
    });
    expect([...select.options].map((option) => option.value)).toEqual(["", CATEGORY_ID]);
    expect([...select.options].map((option) => option.textContent)).toEqual(["", "文房具"]);
  });

  test("参照先が空でもフォームは壊れない", async () => {
    categoryRecords = [];
    renderForm();
    await waitForReady();
    const select = screen.getByLabelText(/カテゴリ/) as HTMLSelectElement;
    expect(select.options.length).toBe(1);
    expect(screen.getByLabelText(/備品名/)).toBeDefined();
  });

  test("参照先の取得に失敗してもフォームは壊れず、理由を出す", async () => {
    responses.set(`GET ${CATEGORIES_PATH}`, [
      500,
      { errors: [{ path: "", message: "サーバ内部エラー" }] },
    ]);
    renderForm();
    await waitForReady();
    await waitFor(() => {
      expect(screen.getByTestId("reference-error-category")).toBeDefined();
    });
    expect(screen.getByTestId("reference-error-category").textContent).toContain(
      "サーバ内部エラー",
    );
    expect(screen.getByLabelText(/備品名/)).toBeDefined();
  });
});

describe("required 表示", () => {
  test("required なフィールドにだけ必須の印がつく", async () => {
    renderForm();
    await waitForReady();
    expect(screen.getByTestId("required-name")).toBeDefined();
    expect(screen.getByTestId("required-quantity")).toBeDefined();
    expect(screen.queryByTestId("required-note")).toBeNull();
    expect(screen.queryByTestId("required-category")).toBeNull();
  });

  test("未入力でもフロントは送信をブロックしない(検証の正はカーネル)", async () => {
    renderForm();
    await waitForReady();
    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => {
      expect(requests.some((request) => request.method === "POST")).toBe(true);
    });
  });

  /**
   * **V3-M12-T09 完了条件11 の実測。** 台帳(`ADR-0007` §8 の 2026-07-19「フィールドに
   * 必須/任意を付けたい(**UI で防ぎたい**)」行)が求めているのは括弧の中の「防ぐ」まで
   * である。**印は出るが、防止は今日も無い** —— そのことを1本のテストで固定する。
   *
   * 上の「ブロックしない」テストは POST が飛ぶことだけを見ている。ここが足すのは
   * **何が飛ぶか(`required` の2フィールドが `null` のまま送られること)**と、
   * **止めたのは誰か(カーネルが返した統一形式エラーを画面がそのまま出すこと)**である。
   * **この2点が「UI では防いでいない」の内容そのものである。**
   */
  test("required を空のまま送信しても阻止されない —— null のまま POST され、止めるのはカーネルだけである(V3-M12-T09)", async () => {
    responses.set(`POST ${ITEMS_PATH}`, [
      400,
      {
        errors: [
          {
            path: "/name",
            message: 'フィールド "name" は必須です。値を指定してください。',
          },
          {
            path: "/quantity",
            message: 'フィールド "quantity" は必須です。値を指定してください。',
          },
        ],
      },
    ]);
    renderForm();
    await waitForReady();

    // (1) 印は出ている(必須であることは画面に書いてある)。
    expect(screen.getByTestId("required-name")).toBeDefined();
    expect(screen.getByTestId("required-quantity")).toBeDefined();

    // (2) required を1つも埋めずに送る。ブラウザ組み込みの検証も効かない(form は noValidate)。
    const form = screen.getByTestId("view-renderer-form").querySelector("form");
    expect(form?.hasAttribute("novalidate")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /保存/ }));

    // (3) 阻止されない —— 送信は実際に行われ、required の2フィールドは null のまま飛ぶ。
    await waitFor(() => {
      expect(requests.some((request) => request.method === "POST")).toBe(true);
    });
    const posted = requests.find((request) => request.method === "POST");
    const body = posted?.body as Record<string, unknown>;
    expect(body.name).toBeNull();
    expect(body.quantity).toBeNull();

    // (4) 止めたのはカーネルである。画面はその返答を該当フィールドの直下に出すだけ。
    expect((await screen.findByTestId("field-error-name")).textContent).toContain("必須です");
    expect(screen.getByTestId("field-error-quantity").textContent).toContain("必須です");
  });
});

describe("送信", () => {
  test("型に沿ったペイロードで createRecord を呼ぶ", async () => {
    renderForm();
    await waitForReady();

    fireEvent.change(screen.getByLabelText(/備品名/), { target: { value: "椅子" } });
    fireEvent.change(screen.getByLabelText(/備考/), { target: { value: "会議室" } });
    fireEvent.change(screen.getByLabelText(/数量/), { target: { value: "3" } });
    fireEvent.click(screen.getByLabelText(/使用中/));
    fireEvent.change(screen.getByLabelText(/購入日/), { target: { value: "2026-07-18" } });
    fireEvent.change(screen.getByLabelText(/状態/), { target: { value: "良好" } });
    fireEvent.change(screen.getByLabelText(/カテゴリ/), { target: { value: CATEGORY_ID } });
    fireEvent.click(screen.getByRole("button", { name: /保存/ }));

    await waitFor(() => {
      expect(requests.some((request) => request.method === "POST")).toBe(true);
    });
    const posted = requests.find((request) => request.method === "POST");
    expect(posted?.url).toBe(ITEMS_PATH);
    expect(posted?.body).toEqual({
      name: "椅子",
      note: "会議室",
      quantity: 3,
      in_use: true,
      purchased_at: "2026-07-18",
      condition: "良好",
      category: CATEGORY_ID,
    });
  });

  test("未入力の任意フィールドは null で送る", async () => {
    renderForm();
    await waitForReady();
    fireEvent.change(screen.getByLabelText(/備品名/), { target: { value: "机" } });
    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => {
      expect(requests.some((request) => request.method === "POST")).toBe(true);
    });
    expect(requests.find((request) => request.method === "POST")?.body).toEqual({
      name: "机",
      note: null,
      quantity: null,
      in_use: false,
      purchased_at: null,
      condition: null,
      category: null,
    });
  });

  test("成功したら同じテーブルの一覧ビューへ遷移する", async () => {
    renderForm();
    await waitForReady();
    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => {
      expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/item-list`);
    });
  });
});

describe("バリデーションエラーの表示", () => {
  const errorBody = {
    errors: [
      {
        path: "/name",
        message: 'フィールド "name" は必須です。値を指定してください。',
        hint: 'テーブル "items" の必須フィールドです。',
      },
      {
        path: "/condition",
        message: 'フィールド "condition" に選択肢にない値が指定されました。',
        allowed_values: ["新品", "良好"],
      },
      { path: "", message: "テーブル全体のエラー" },
    ],
  };

  test("path が /<field> のエラーは該当フィールドの直下に出る", async () => {
    responses.set(`POST ${ITEMS_PATH}`, [400, errorBody]);
    renderForm();
    await waitForReady();
    fireEvent.click(screen.getByRole("button", { name: /保存/ }));

    const nameError = await screen.findByTestId("field-error-name");
    expect(nameError.textContent).toContain("必須です");
    const conditionError = screen.getByTestId("field-error-condition");
    expect(conditionError.textContent).toContain("選択肢にない値");
    // allowed_values / hint を落とさずに出す(handover 3.8)。
    expect(within(conditionError).getByText(/新品/)).toBeDefined();
    // 他のフィールドには出ない。
    expect(screen.queryByTestId("field-error-quantity")).toBeNull();
  });

  test("フィールドに紐づかないエラーはフォーム全体に出る", async () => {
    responses.set(`POST ${ITEMS_PATH}`, [400, errorBody]);
    renderForm();
    await waitForReady();
    fireEvent.click(screen.getByRole("button", { name: /保存/ }));

    const formError = await screen.findByTestId("form-errors");
    expect(formError.textContent).toContain("テーブル全体のエラー");
    expect(formError.textContent).not.toContain("必須です");
  });

  test("エラーのときは画面遷移しない", async () => {
    responses.set(`POST ${ITEMS_PATH}`, [400, errorBody]);
    renderForm();
    await waitForReady();
    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    await screen.findByTestId("field-error-name");
    expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/item-form`);
  });
});

describe("既存レコードの編集", () => {
  const RECORD_ID = "item-0001";

  beforeEach(() => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/item-form/records/${RECORD_ID}`);
    responses.set(`GET ${ITEMS_PATH}/${RECORD_ID}`, [
      200,
      {
        record: {
          _id: RECORD_ID,
          _created_at: "2026-01-01T00:00:00Z",
          _updated_at: "2026-01-01T00:00:00Z",
          name: "椅子",
          note: "会議室",
          quantity: 3,
          in_use: true,
          purchased_at: "2026-07-18",
          condition: "良好",
          category: CATEGORY_ID,
        },
      },
    ]);
  });

  test("既存値が初期表示される", async () => {
    renderForm(sampleManifest(), RECORD_ID);
    await waitFor(() => {
      expect((screen.getByLabelText(/備品名/) as HTMLInputElement).value).toBe("椅子");
    });
    expect((screen.getByLabelText(/数量/) as HTMLInputElement).value).toBe("3");
    expect((screen.getByLabelText(/使用中/) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(/購入日/) as HTMLInputElement).value).toBe("2026-07-18");
    expect((screen.getByLabelText(/状態/) as HTMLSelectElement).value).toBe("良好");
    await waitFor(() => {
      expect((screen.getByLabelText(/カテゴリ/) as HTMLSelectElement).value).toBe(CATEGORY_ID);
    });
  });

  test("保存すると updateRecord(PATCH)を呼ぶ", async () => {
    responses.set(`PATCH ${ITEMS_PATH}/${RECORD_ID}`, [200, { record: { _id: RECORD_ID } }]);
    renderForm(sampleManifest(), RECORD_ID);
    await waitFor(() => {
      expect((screen.getByLabelText(/備品名/) as HTMLInputElement).value).toBe("椅子");
    });
    fireEvent.change(screen.getByLabelText(/備品名/), { target: { value: "丸椅子" } });
    fireEvent.click(screen.getByRole("button", { name: /保存/ }));

    await waitFor(() => {
      expect(requests.some((request) => request.method === "PATCH")).toBe(true);
    });
    const patched = requests.find((request) => request.method === "PATCH");
    expect(patched?.url).toBe(`${ITEMS_PATH}/${RECORD_ID}`);
    expect(patched?.body).toMatchObject({ name: "丸椅子", quantity: 3, in_use: true });
  });

  test("同じテーブルの detail_view があれば、保存後はそのレコードの詳細へ戻る", async () => {
    responses.set(`PATCH ${ITEMS_PATH}/${RECORD_ID}`, [200, { record: { _id: RECORD_ID } }]);
    const manifest = sampleManifest();
    manifest.app.views.push({ id: "item-detail", type: "detail_view", table: "items" });
    renderForm(manifest, RECORD_ID);
    await waitFor(() => {
      expect((screen.getByLabelText(/備品名/) as HTMLInputElement).value).toBe("椅子");
    });
    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => {
      expect(window.location.pathname).toBe(
        `/apps/${APP_ID}/views/item-detail/records/${RECORD_ID}`,
      );
    });
  });

  test("detail_view が無ければ保存後は一覧へ戻る", async () => {
    responses.set(`PATCH ${ITEMS_PATH}/${RECORD_ID}`, [200, { record: { _id: RECORD_ID } }]);
    renderForm(sampleManifest(), RECORD_ID);
    await waitFor(() => {
      expect((screen.getByLabelText(/備品名/) as HTMLInputElement).value).toBe("椅子");
    });
    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => {
      expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/item-list`);
    });
  });
});

describe("マニフェストと食い違う定義", () => {
  test("実在しないフィールドを指す form は黙って隠さずエラーにする", async () => {
    const manifest = sampleManifest();
    const view = formView(manifest);
    view.fields = ["name", "nope"];
    renderForm(manifest);
    expect(await screen.findByTestId("form-errors")).toBeDefined();
    expect(screen.getByTestId("form-errors").textContent).toContain("nope");
  });
});

describe("プリフィル(EC-G14 / ADR-0045)", () => {
  function renderFormWithPrefill(prefill: { field: string; value: string }) {
    const manifest = sampleManifest();
    return render(
      <RoleProvider role={WRITER_ROLE}>
        <FormRenderer
          appId={APP_ID}
          manifest={manifest}
          view={formView(manifest)}
          recordId={undefined}
          prefill={prefill}
        />
      </RoleProvider>,
    );
  }

  test("prefill 付きの新規作成フォームは、参照フィールドがプリフィル値で選択済みになる", async () => {
    renderFormWithPrefill({ field: "category", value: CATEGORY_ID });
    await waitForReady();
    const select = screen.getByLabelText(/カテゴリ/) as HTMLSelectElement;
    expect(select.value).toBe(CATEGORY_ID);
  });

  test("prefill 無しなら参照は未選択のまま(後方互換)", async () => {
    renderForm();
    await waitForReady();
    const select = screen.getByLabelText(/カテゴリ/) as HTMLSelectElement;
    expect(select.value).toBe("");
  });

  test("プリフィルは埋めるだけで、ユーザは変更できる(固定しない)", async () => {
    renderFormWithPrefill({ field: "category", value: CATEGORY_ID });
    await waitForReady();
    const select = screen.getByLabelText(/カテゴリ/) as HTMLSelectElement;
    expect(select.value).toBe(CATEGORY_ID);
    fireEvent.change(select, { target: { value: "" } });
    expect(select.value).toBe("");
  });

  test("プリフィル対象が参照でないフィールドを指しても、他型には黙って入れない", async () => {
    // name は text 型。prefill.field がそこを指しても reference ではないので反映しない。
    renderFormWithPrefill({ field: "name", value: CATEGORY_ID });
    await waitForReady();
    const nameInput = screen.getByLabelText(/備品名/) as HTMLInputElement;
    expect(nameInput.value).toBe("");
  });
});

/**
 * 部品体系での描き直し(`V4-M15-T04`。`ADR-0087`)。
 *
 * **ここが測るのは「置き換えても契約が1つも落ちていないこと」だけである。**
 * 見た目そのもの(色・余白の実値)は測らない —— それは `web/e2e` の実ブラウザ側の担当で、
 * happy-dom はスタイルシートを解決しない。**したがってクラス名の存在だけを見る。**
 */
describe("部品体系での描き直し(V4-M15-T04)", () => {
  function formElement(): HTMLFormElement {
    const form = screen.getByTestId("view-renderer-form").querySelector("form");
    if (form === null) {
      throw new Error("form が無い");
    }
    return form as HTMLFormElement;
  }

  test("既存のクラス名(record-form / field / required)を1つも落とさない", async () => {
    renderForm();
    await waitForReady();
    const form = formElement();
    expect(form.classList.contains("record-form")).toBe(true);
    const fields = form.querySelectorAll(".field");
    // 7フィールドぶんの器がそのまま残っている。
    expect(fields.length).toBe(7);
    expect(screen.getByTestId("required-name").classList.contains("required")).toBe(true);
  });

  test("部品体系のクラスは既存クラスに足す形で入る(置き換えない)", async () => {
    renderForm();
    await waitForReady();
    const form = formElement();
    // 既存クラスは先頭に残り、部品体系のクラスが後ろに足されている。
    expect(form.classList.contains("record-form")).toBe(true);
    expect(form.className.split(" ").length).toBeGreaterThan(1);
  });

  test("項目名と入力欄の並びは狭い画面で縦になり、sm: の断点を持つ(D-V4-44)", async () => {
    renderForm();
    await waitForReady();
    const field = formElement().querySelector(".field");
    expect(field).not.toBeNull();
    const className = (field as HTMLElement).className;
    expect(className).toContain("flex-col");
    expect(className).toMatch(/(^|\s)sm:/);
    // 断点は sm: と lg: の2つだけ。md: / xl: / 2xl: は存在しない。
    expect(className).not.toMatch(/(^|\s)(md|xl|2xl):/);
  });

  test("保存ボタンは type=submit のままである(部品にしても送信が壊れない)", async () => {
    renderForm();
    await waitForReady();
    const button = screen.getByRole("button", { name: /保存/ }) as HTMLButtonElement;
    expect(button.getAttribute("type")).toBe("submit");
    expect(button.disabled).toBe(false);
  });

  test("送信中はボタンが disabled になる", async () => {
    // POST を解決しないままにして「送信中」を作る。
    const pendingFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if ((init?.method ?? "GET") === "POST" && url === ITEMS_PATH) {
        return new Promise<Response>(() => {});
      }
      return pendingFetch(input, init);
    }) as typeof fetch;

    renderForm();
    await waitForReady();
    const button = screen.getByRole("button", { name: /保存/ }) as HTMLButtonElement;
    fireEvent.click(button);
    await waitFor(() => {
      expect((screen.getByRole("button", { name: /保存/ }) as HTMLButtonElement).disabled).toBe(
        true,
      );
    });
  });

  test("エラーのある入力欄にだけ aria-invalid=true が付く", async () => {
    responses.set(`POST ${ITEMS_PATH}`, [
      400,
      {
        errors: [
          { path: "/name", message: 'フィールド "name" は必須です。値を指定してください。' },
          {
            path: "/quantity",
            message: 'フィールド "quantity" は必須です。値を指定してください。',
          },
        ],
      },
    ]);
    renderForm();
    await waitForReady();

    // 送信前は1件も付いていない。
    expect(document.querySelectorAll("[aria-invalid]").length).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    await screen.findByTestId("field-error-name");

    expect(screen.getByTestId("field-input-name").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByTestId("field-input-quantity").getAttribute("aria-invalid")).toBe("true");
    // エラーの無い欄には属性ごと付かない。
    expect(screen.getByTestId("field-input-note").hasAttribute("aria-invalid")).toBe(false);
    expect(screen.getByTestId("field-input-condition").hasAttribute("aria-invalid")).toBe(false);
    // 付いたのはちょうど2件である(数を丸めない)。
    expect(document.querySelectorAll('[aria-invalid="true"]').length).toBe(2);
  });

  test("エラーの本文は ErrorList のままである(文面を作り直さない)", async () => {
    responses.set(`POST ${ITEMS_PATH}`, [
      400,
      { errors: [{ path: "/name", message: "必須です", hint: "ヒント" }] },
    ]);
    renderForm();
    await waitForReady();
    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    const error = await screen.findByTestId("field-error-name");
    expect(error.querySelector('[data-testid="errors"]')).not.toBeNull();
    expect(error.textContent).toContain("ヒント");
  });

  test("書けない立場では read-only-note クラスが残る", async () => {
    render(
      <RoleProvider role={READER_ROLE}>
        <FormRenderer
          appId={APP_ID}
          manifest={sampleManifest()}
          view={formView(sampleManifest())}
          recordId={undefined}
        />
      </RoleProvider>,
    );
    const note = await screen.findByTestId("form-read-only");
    expect(note.classList.contains("read-only-note")).toBe(true);
    expect(screen.queryByRole("button", { name: /保存/ })).toBeNull();
  });
});
