/**
 * フィールド型ごとの入力UIのテスト(V1-M0-T12)。
 *
 * `field-display.test.tsx` が表示側の7型を固定しているのに対し、こちらは入力側の
 * 7型を固定する。検査するのは `FieldInput` 単体、すなわち「フィールド定義から
 * どの入力要素が出るか」「変更が `onChange` にどの値で届くか」だけである。
 * フォーム全体の組み立て・送信・エラー表示は `form.test.tsx` の担当なので
 * ここでは繰り返さない。
 *
 * 参照先レコードの取得(`useReferenceChoices`)は fetch を要する非同期処理で、
 * すでに `form.test.tsx` が実物の fetch スタブ越しに通しで検査している。
 * ここでは `referenceChoices` を作り物の `Map` として直接渡し、`FieldInput` が
 * 取得状態(ready / error / 未取得)をどう描き分けるかだけに集中する。
 *
 * ここに現れるフィールドID・テーブルID・値はすべてこのテストファイル内の作り物で
 * あり、実装側にアプリ固有の名前は入らない(CP-3 確認方法4)。
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Field } from "../../src/kernel/types.ts";
import { FieldInput, type FieldInputValue, type ReferenceChoices } from "../src/fields/input.tsx";

afterEach(() => {
  cleanup();
});

const FIELDS: Record<string, Field> = {
  text: { id: "f_text", name: "テキスト", type: "text" },
  long_text: { id: "f_long", name: "長文", type: "long_text" },
  number: { id: "f_num", name: "数値", type: "number" },
  boolean: { id: "f_bool", name: "真偽", type: "boolean" },
  date: { id: "f_date", name: "日付", type: "date" },
  select: { id: "f_select", name: "選択", type: "select", options: ["alpha", "beta"] },
  reference: { id: "f_ref", name: "参照", type: "reference", reference_table: "targets" },
  image: { id: "f_img", name: "画像", type: "image" },
};

const INPUT_ID = "input-under-test";

/** image 型のアップロード先/配信 URL を組むためのアプリID(このテスト内の作り物)。 */
const APP_ID = "app-under-test";

/** 参照先が取得できている状態。 */
function readyChoices(): ReferenceChoices {
  return new Map([
    [
      "targets",
      {
        status: "ready" as const,
        value: [
          { id: "rec-1", label: "代表値1" },
          { id: "rec-2", label: "代表値2" },
        ],
      },
    ],
  ]);
}

function renderInput(
  field: Field,
  value: FieldInputValue,
  referenceChoices: ReferenceChoices = new Map(),
  invalid?: boolean,
) {
  const onChange = mock((_value: FieldInputValue) => {});
  render(
    <FieldInput
      field={field}
      inputId={INPUT_ID}
      value={value}
      onChange={onChange}
      referenceChoices={referenceChoices}
      appId={APP_ID}
      // `exactOptionalPropertyTypes` が有効なので、未指定は**キーごと渡さない**。
      {...(invalid === undefined ? {} : { invalid })}
    />,
  );
  return onChange;
}

function inputFor(field: Field): HTMLElement {
  return screen.getByTestId(`field-input-${field.id}`);
}

describe("7型の入力要素", () => {
  test("text は input[type=text]", () => {
    renderInput(FIELDS.text as Field, "そのまま");
    const node = inputFor(FIELDS.text as Field) as HTMLInputElement;
    expect(node.tagName).toBe("INPUT");
    expect(node.type).toBe("text");
    expect(node.value).toBe("そのまま");
  });

  test("long_text は textarea", () => {
    renderInput(FIELDS.long_text as Field, "ながい文章");
    const node = inputFor(FIELDS.long_text as Field) as HTMLTextAreaElement;
    expect(node.tagName).toBe("TEXTAREA");
    expect(node.value).toBe("ながい文章");
  });

  test("number は input[type=number]", () => {
    renderInput(FIELDS.number as Field, "42");
    const node = inputFor(FIELDS.number as Field) as HTMLInputElement;
    expect(node.tagName).toBe("INPUT");
    expect(node.type).toBe("number");
    expect(node.value).toBe("42");
  });

  test("boolean は input[type=checkbox]", () => {
    renderInput(FIELDS.boolean as Field, true);
    const node = inputFor(FIELDS.boolean as Field) as HTMLInputElement;
    expect(node.tagName).toBe("INPUT");
    expect(node.type).toBe("checkbox");
    expect(node.checked).toBe(true);
  });

  test("boolean の false はチェックが外れた状態になる", () => {
    renderInput(FIELDS.boolean as Field, false);
    expect((inputFor(FIELDS.boolean as Field) as HTMLInputElement).checked).toBe(false);
  });

  test("date は input[type=date]", () => {
    renderInput(FIELDS.date as Field, "2026-07-18");
    const node = inputFor(FIELDS.date as Field) as HTMLInputElement;
    expect(node.tagName).toBe("INPUT");
    expect(node.type).toBe("date");
    expect(node.value).toBe("2026-07-18");
  });

  test("select は select", () => {
    renderInput(FIELDS.select as Field, "beta");
    const node = inputFor(FIELDS.select as Field) as HTMLSelectElement;
    expect(node.tagName).toBe("SELECT");
    expect(node.value).toBe("beta");
  });

  test("reference は select(生の _id を打たせない)", () => {
    renderInput(FIELDS.reference as Field, "rec-1", readyChoices());
    const node = inputFor(FIELDS.reference as Field) as HTMLSelectElement;
    expect(node.tagName).toBe("SELECT");
    expect(node.value).toBe("rec-1");
  });
});

describe("すべての型に共通で載る属性", () => {
  for (const [name, field] of Object.entries(FIELDS)) {
    test(`${name} は data-testid が field-input-<field.id> で、inputId が id になる`, () => {
      renderInput(field as Field, "", readyChoices());
      const node = inputFor(field as Field);
      expect(node.getAttribute("data-testid")).toBe(`field-input-${(field as Field).id}`);
      expect(node.getAttribute("id")).toBe(INPUT_ID);
    });
  }

  for (const [name, field] of Object.entries(FIELDS)) {
    test(`${name} は required を aria-required に反映する`, () => {
      renderInput({ ...(field as Field), required: true } as Field, "", readyChoices());
      expect(inputFor(field as Field).getAttribute("aria-required")).toBe("true");
    });
  }

  for (const [name, field] of Object.entries(FIELDS)) {
    test(`${name} は required でなければ aria-required が false`, () => {
      renderInput(field as Field, "", readyChoices());
      expect(inputFor(field as Field).getAttribute("aria-required")).toBe("false");
      // ブラウザ側の送信ブロックは使わない(検証の正はカーネル)。
      expect(inputFor(field as Field).hasAttribute("required")).toBe(false);
    });
  }
});

/**
 * image 型の入力(V2-M2-T04 / ADR-0035)。
 *
 * `<input type=file>` でファイルを選ぶと `POST /api/apps/<appId>/files` へ multipart で送り、
 * 返った file_id を `onChange` でフォーム値にする。ここでは `globalThis.fetch` をスタブして
 * 「送信先 URL」「method=POST」「file パートの有無」「file_id が onChange に届くか」を固定する。
 */
describe("image の入力(アップロード)", () => {
  const IMAGE = FIELDS.image as Field;
  // **実 fetch を必ず退避してから差し替える。** スタブしないテストでも afterEach で確実に
  // 元へ戻す(未設定の変数で上書きして globalThis.fetch を undefined にしないため —— それは
  // 後続テストファイルの実 fetch を壊す)。
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** アップロードを1回受けて file_id を返す fetch スタブ。呼び出しを記録する。 */
  function stubUpload(fileId: string) {
    const calls: { url: string; method: string; hasFilePart: boolean }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const body = init?.body;
      const hasFilePart = body instanceof FormData && body.get("file") instanceof File;
      calls.push({ url, method: init?.method ?? "GET", hasFilePart });
      return new Response(
        JSON.stringify({ file_id: fileId, sha256: "0".repeat(64), mime: "image/png", size: 3 }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    return calls;
  }

  function pngFile(): File {
    return new File([new Uint8Array([0x89, 0x50, 0x4e])], "photo.png", { type: "image/png" });
  }

  test("input[type=file] が出る(生の file_id テキスト入力ではない)", () => {
    renderInput(IMAGE, "");
    const node = inputFor(IMAGE) as HTMLInputElement;
    expect(node.tagName).toBe("INPUT");
    expect(node.type).toBe("file");
    // 画像だけを選ばせる accept を付ける(利便のためで、検証はサーバの責務)。
    expect(node.getAttribute("accept")).toContain("image/png");
  });

  test("ファイル選択で /files へ POST し、返った file_id を onChange に渡す", async () => {
    const calls = stubUpload("file-xyz");
    const onChange = renderInput(IMAGE, "");
    const node = inputFor(IMAGE) as HTMLInputElement;

    fireEvent.change(node, { target: { files: [pngFile()] } });
    // アップロードは非同期。onChange が呼ばれるまで待つ。
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("file-xyz"));

    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe(`/api/apps/${APP_ID}/files`);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.hasFilePart).toBe(true);
  });

  test("既に値(file_id)があればプレビュー img を配信 URL で出す", () => {
    renderInput(IMAGE, "file-existing");
    const preview = screen.getByTestId("image-preview-f_img");
    expect(preview.tagName).toBe("IMG");
    expect(preview.getAttribute("src")).toBe(`/api/apps/${APP_ID}/files/file-existing`);
  });

  test("アップロード失敗は統一形式で表示し、onChange を呼ばない", async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ errors: [{ path: "", message: "画像が大きすぎます" }] }), {
        status: 413,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const onChange = renderInput(IMAGE, "");
    const node = inputFor(IMAGE) as HTMLInputElement;

    fireEvent.change(node, { target: { files: [pngFile()] } });
    await waitFor(() => expect(screen.getByTestId("image-error-f_img")).toBeDefined());
    expect(screen.getByTestId("image-error-f_img").textContent).toContain("画像が大きすぎます");
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("変更が onChange に届く値", () => {
  test("text は文字列そのまま", () => {
    const onChange = renderInput(FIELDS.text as Field, "");
    fireEvent.change(inputFor(FIELDS.text as Field), { target: { value: "打った値" } });
    expect(onChange).toHaveBeenCalledWith("打った値");
  });

  test("long_text は文字列そのまま", () => {
    const onChange = renderInput(FIELDS.long_text as Field, "");
    fireEvent.change(inputFor(FIELDS.long_text as Field), { target: { value: "ながい" } });
    expect(onChange).toHaveBeenCalledWith("ながい");
  });

  test("number は数値に丸めず文字列そのまま(入力途中を壊さない)", () => {
    const onChange = renderInput(FIELDS.number as Field, "");
    fireEvent.change(inputFor(FIELDS.number as Field), { target: { value: "12" } });
    expect(onChange).toHaveBeenCalledWith("12");
  });

  test("boolean だけ真偽値で届く", () => {
    const onChange = renderInput(FIELDS.boolean as Field, false);
    fireEvent.click(inputFor(FIELDS.boolean as Field));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  test("boolean のチェックを外すと false で届く", () => {
    const onChange = renderInput(FIELDS.boolean as Field, true);
    fireEvent.click(inputFor(FIELDS.boolean as Field));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  test("date は文字列そのまま", () => {
    const onChange = renderInput(FIELDS.date as Field, "");
    fireEvent.change(inputFor(FIELDS.date as Field), { target: { value: "2026-07-18" } });
    expect(onChange).toHaveBeenCalledWith("2026-07-18");
  });

  test("select は選んだ値そのまま", () => {
    const onChange = renderInput(FIELDS.select as Field, "");
    fireEvent.change(inputFor(FIELDS.select as Field), { target: { value: "beta" } });
    expect(onChange).toHaveBeenCalledWith("beta");
  });

  test("select の未選択は空文字で届く(未設定を表現できる)", () => {
    const onChange = renderInput(FIELDS.select as Field, "beta");
    fireEvent.change(inputFor(FIELDS.select as Field), { target: { value: "" } });
    expect(onChange).toHaveBeenCalledWith("");
  });

  test("reference は参照先の _id が届く", () => {
    const onChange = renderInput(FIELDS.reference as Field, "", readyChoices());
    fireEvent.change(inputFor(FIELDS.reference as Field), { target: { value: "rec-2" } });
    expect(onChange).toHaveBeenCalledWith("rec-2");
  });
});

describe("select の選択肢", () => {
  test("先頭が未選択の空 option で、続いてマニフェストの options が出る", () => {
    renderInput(FIELDS.select as Field, "");
    const node = inputFor(FIELDS.select as Field) as HTMLSelectElement;
    expect([...node.options].map((option) => option.value)).toEqual(["", "alpha", "beta"]);
    expect([...node.options].map((option) => option.textContent)).toEqual(["", "alpha", "beta"]);
  });

  test("options が空でも未選択の option だけは出る", () => {
    const field: Field = { id: "f_empty", name: "空選択", type: "select", options: [] };
    renderInput(field, "");
    const node = inputFor(field) as HTMLSelectElement;
    expect([...node.options].map((option) => option.value)).toEqual([""]);
  });
});

describe("reference の取得状態", () => {
  const field = FIELDS.reference as Field;

  test("ready なら参照先が代表値のラベルで選択肢になる", () => {
    renderInput(field, "", readyChoices());
    const node = inputFor(field) as HTMLSelectElement;
    expect([...node.options].map((option) => option.value)).toEqual(["", "rec-1", "rec-2"]);
    expect([...node.options].map((option) => option.textContent)).toEqual([
      "",
      "代表値1",
      "代表値2",
    ]);
    expect(screen.queryByTestId(`reference-error-${field.id}`)).toBeNull();
  });

  test("ready でも参照先が0件なら未選択の option だけになる(壊れない)", () => {
    renderInput(field, "", new Map([["targets", { status: "ready", value: [] }]]));
    const node = inputFor(field) as HTMLSelectElement;
    expect(node.options.length).toBe(1);
  });

  test("error なら reference-error-<field.id> に理由をそのまま出す", () => {
    renderInput(
      field,
      "",
      new Map([
        [
          "targets",
          {
            status: "error",
            errors: [{ path: "", message: "サーバ内部エラー", hint: "後で再試行してください" }],
          },
        ],
      ]),
    );
    const error = screen.getByTestId(`reference-error-${field.id}`);
    expect(error.textContent).toContain("サーバ内部エラー");
    // 統一形式の情報を要約して捨てない。
    expect(error.textContent).toContain("後で再試行してください");
    // 失敗しても select 自体は描画され続ける。
    expect(inputFor(field)).toBeDefined();
  });

  test("loading 中は選択肢が空でもエラーは出さない", () => {
    renderInput(field, "", new Map([["targets", { status: "loading" }]]));
    expect((inputFor(field) as HTMLSelectElement).options.length).toBe(1);
    expect(screen.queryByTestId(`reference-error-${field.id}`)).toBeNull();
  });

  test("未取得(参照先テーブルが Map に無い)でも描画が壊れない", () => {
    renderInput(field, "", new Map());
    const node = inputFor(field) as HTMLSelectElement;
    expect(node.tagName).toBe("SELECT");
    expect(node.options.length).toBe(1);
    expect(screen.queryByTestId(`reference-error-${field.id}`)).toBeNull();
  });
});

/**
 * 入力の妥当性の見え方(`V4-M15-T04` / `V4-M15-T14` の一部)。
 *
 * **着手前は `aria-invalid` が web/src 全体で0件だった**(`03` §4-1 の実測)。
 * ここが固定するのは「**エラーのある入力欄にだけ `aria-invalid="true"` が付く**」こと
 * だけである。**エラーの本文は `ErrorList` の担当で、ここは1文字も持たない。**
 *
 * **枠線の色は部品側の `aria-invalid:border-destructive` が持つ**ので、実装が足すのは
 * 属性1つだけである(見た目のクラスをフィールドごとに書き分けない)。
 */
describe("入力の妥当性の見え方(aria-invalid)", () => {
  for (const [name, field] of Object.entries(FIELDS)) {
    test(`${name} は invalid のとき aria-invalid="true" が付く`, () => {
      renderInput(field as Field, "", readyChoices(), true);
      expect(inputFor(field as Field).getAttribute("aria-invalid")).toBe("true");
    });
  }

  for (const [name, field] of Object.entries(FIELDS)) {
    test(`${name} は invalid でなければ aria-invalid 属性そのものが無い`, () => {
      renderInput(field as Field, "", readyChoices());
      expect(inputFor(field as Field).hasAttribute("aria-invalid")).toBe(false);
    });
  }

  test("invalid でも type / id / data-testid は1つも変わらない", () => {
    renderInput(FIELDS.number as Field, "42", new Map(), true);
    const node = inputFor(FIELDS.number as Field) as HTMLInputElement;
    expect(node.type).toBe("number");
    expect(node.getAttribute("id")).toBe(INPUT_ID);
    expect(node.getAttribute("data-testid")).toBe("field-input-f_num");
    expect(node.value).toBe("42");
  });

  test("boolean は invalid でも input[type=checkbox] のままである(別の部品に置き換えない)", () => {
    renderInput(FIELDS.boolean as Field, true, new Map(), true);
    const node = inputFor(FIELDS.boolean as Field) as HTMLInputElement;
    expect(node.tagName).toBe("INPUT");
    expect(node.type).toBe("checkbox");
    expect(node.checked).toBe(true);
  });

  test("select / reference は素の select のままである(重ねて出すメニューにしない)", () => {
    renderInput(FIELDS.select as Field, "", new Map(), true);
    const node = inputFor(FIELDS.select as Field);
    expect(node.tagName).toBe("SELECT");
    expect(node.getAttribute("role")).toBeNull();
    cleanup();
    renderInput(FIELDS.reference as Field, "", readyChoices(), true);
    const reference = inputFor(FIELDS.reference as Field);
    expect(reference.tagName).toBe("SELECT");
    expect(reference.getAttribute("role")).toBeNull();
  });
});
