/**
 * `file` 型(一般のファイルの添付)の表示層(`V5-M16-T05`。`G-G12` / `ADR-0161`)。
 *
 * ## このファイルが固定すること
 *
 * 1. **表示**: `file` の値(file_id)は **`<img>` にしない。** **ダウンロードのリンクにする** ——
 *    **配信は必ずダウンロードで返る**(`V5-M16-T03`)ので、画面もそう見せる。
 *    **file_id を素の文字列で読み手に見せない**(`image` と同じ規律)。
 * 2. **入力**: `<input type="file">` で選ばせ、**`kind=file` を付けて**アップロードする。
 *    **`accept` 属性を付けない** —— **受け入れる種類の制限は0件である**(`D-V5-84`)。
 *    「選べる形が絞られている」と見せると嘘になる。
 * 3. **まとめて書き換えの対象から外れる**(値が file_id であり人が打つ値ではない。
 *    `reference` / `image` と同じ扱い)。
 *
 * ## このファイルが証明しないこと(先に書く)
 *
 * - **実際のブラウザでダウンロードが始まることは1度も確かめていない**(chromium を
 *   起動していない)。見ているのは DOM の属性だけである。
 * - **`file` の値が実在するかどうかは表示層では1度も確かめない**(サーバの担当)。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Field, Table } from "../../src/kernel/types.ts";
import { FieldValue } from "../src/fields/display.tsx";
import { FieldInput } from "../src/fields/input.tsx";
import { bulkEditableFields } from "../src/views/ListViewRenderer.tsx";

afterEach(() => {
  cleanup();
});

const APP_ID = "app-under-test";
const FILE_FIELD: Field = { id: "f_doc", name: "添付", type: "file" };

describe("file の表示(ダウンロードのリンク)", () => {
  test("file は img ではなくダウンロードのリンクで出る", () => {
    render(
      <FieldValue field={FILE_FIELD} value="file-abc" appId={APP_ID} referenceLabels={new Map()} />,
    );
    const node = screen.getByTestId("field-value-file");
    expect(node.tagName).toBe("A");
    expect(node.getAttribute("href")).toBe(`/api/apps/${APP_ID}/files/file-abc`);
    // **ダウンロードであることを DOM でも表明する。**
    expect(node.hasAttribute("download")).toBe(true);
    // 画面に `<img>` が1つも出ていない。
    expect(document.querySelectorAll("img")).toHaveLength(0);
  });

  test("file_id を素の文字列で読み手に見せない(image と同じ規律)", () => {
    render(
      <FieldValue field={FILE_FIELD} value="file-abc" appId={APP_ID} referenceLabels={new Map()} />,
    );
    expect(screen.queryByText("file-abc")).toBeNull();
    // リンクの文字はフィールド名(マニフェスト由来)である。
    expect(screen.getByTestId("field-value-file").textContent).toContain("添付");
  });

  test("file_id は配信 URL の中で encodeURIComponent される", () => {
    render(
      <FieldValue field={FILE_FIELD} value="a/b?c" appId={APP_ID} referenceLabels={new Map()} />,
    );
    expect(screen.getByTestId("field-value-file").getAttribute("href")).toBe(
      `/api/apps/${APP_ID}/files/a%2Fb%3Fc`,
    );
  });

  test("未設定は他の型と同じ「未設定」表示になる(リンクを出さない)", () => {
    render(
      <FieldValue field={FILE_FIELD} value={null} appId={APP_ID} referenceLabels={new Map()} />,
    );
    // **未設定の器は全型で共通の `EmptyValue` である**(`data-testid` は同じ
    // `field-value-file` だが `<span>未設定</span>` になる)。**リンクは出ない。**
    const node = screen.getByTestId("field-value-file");
    expect(node.tagName).toBe("SPAN");
    expect(node.textContent).toBe("未設定");
    expect(document.querySelectorAll("a")).toHaveLength(0);
  });
});

describe("file の入力(アップロード)", () => {
  let originalFetch: typeof fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** アップロードを1回受けて file_id を返す fetch スタブ。送った FormData を記録する。 */
  function stubUpload(fileId: string): { forms: FormData[] } {
    originalFetch = globalThis.fetch;
    const forms: FormData[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      forms.push(init?.body as FormData);
      return new Response(
        JSON.stringify({
          file_id: fileId,
          sha256: "0".repeat(64),
          mime: "application/pdf",
          size: 3,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    return { forms };
  }

  function pdfFile(): File {
    return new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "invoice.pdf", {
      type: "application/pdf",
    });
  }

  test("選んだファイルは kind=file を付けて送られる(種類を絞る accept を出さない)", async () => {
    const captured = stubUpload("file-new");
    const changes: unknown[] = [];
    render(
      <FieldInput
        field={FILE_FIELD}
        inputId="input-f_doc"
        value=""
        onChange={(next) => changes.push(next)}
        appId={APP_ID}
        referenceChoices={new Map()}
      />,
    );
    const input = screen.getByTestId("field-input-f_doc") as HTMLInputElement;
    // **`accept` を付けない** —— 受け入れる種類の制限は0件である。
    expect(input.hasAttribute("accept")).toBe(false);

    fireEvent.change(input, { target: { files: [pdfFile()] } });
    await waitFor(() => expect(changes).toHaveLength(1));
    expect(changes[0]).toBe("file-new");
    expect(captured.forms).toHaveLength(1);
    expect(captured.forms[0]?.get("kind")).toBe("file");
  });

  test("既に値があるときは、プレビュー画像ではなくダウンロードのリンクを出す", () => {
    stubUpload("unused");
    render(
      <FieldInput
        field={FILE_FIELD}
        inputId="input-f_doc"
        value="file-existing"
        onChange={() => {}}
        appId={APP_ID}
        referenceChoices={new Map()}
      />,
    );
    const link = screen.getByTestId("file-current-f_doc");
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe(`/api/apps/${APP_ID}/files/file-existing`);
    expect(document.querySelectorAll("img")).toHaveLength(0);
  });
});

describe("まとめて書き換えの対象", () => {
  const table: Table = {
    id: "docs",
    name: "書類",
    fields: [
      { id: "title", name: "件名", type: "text" },
      { id: "photo", name: "写真", type: "image" },
      FILE_FIELD,
      { id: "owner", name: "担当", type: "reference", reference_table: "people" },
    ],
  };

  test("file は reference / image と同じく対象から外れる(値が file_id で人が打つ値ではない)", () => {
    const ids = bulkEditableFields(table).map((field: Field) => field.id);
    expect(ids).toEqual(["title"]);
  });
});
