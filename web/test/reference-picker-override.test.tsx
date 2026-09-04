/**
 * 参照項目の「選び方」の**優先順位(画面 > 項目 > 既定)**を、表示層の1箇所に置く
 * (`K-G2` / `K-G5`。`V6-M2-T03` / `ADR-0289` 限定5)。
 *
 * **限定表の正は [`docs/adr/0289-reference-picker-view-override.md`](../../docs/adr/0289-reference-picker-view-override.md)
 * §Decision 3**、完了条件の正は `docs/plan/v6/01-reference-picker-baseline.md` §7 の
 * `V6-M2` の行の (i) と (ii)。
 *
 * ## このファイルが固定すること
 *
 * 1. **(i) 入力画面側の指定が、項目側の既定より優先される。**
 * 2. **(ii) 両方書かなければ `list`(今日どおりのプルダウン)になる。**
 * 3. **解決の規則は `resolveReferencePicker` の1関数だけである** ——
 *    **`web/src` 配下で `reference_picker` の字面を含むファイルは今日も1つだけであり、
 *    既定を持つ定数の宣言も1つだけである**(`V6-M1-T03` が置いた
 *    `DEFAULT_REFERENCE_PICKER` を唯一の既定として使う。**2箇所目を作らない**)。
 * 4. **書かなかった画面・書かなかった項目の DOM が今日と1バイトも変わらない。**
 *
 * ## このファイルが証明しないこと(先に書く。誇張しない)
 *
 * - **【`V6-M4-T01` の書き換え。旧文は下に残す】** **`V6-M4` が `type_filter` の描画を
 *   実装したので、画面側に `type_filter` を書くと見た目が今日と変わる。**
 *   **同一性を測るのは `list` / `search` の側だけに絞った**(旧文が指示したとおり)。
 *   **画面側の指定が実際に器を切り替えることは
 *   `web/test/reference-type-filter.test.tsx` の (a) 群が測っている。**
 * - **【旧文。1バイトも書き換えていない】** **`type_filter` / `search` の描画を1つも
 *   測っていない。** **今日その実装は1バイトも無い**(当たり先は `V6-M4` / `V6-M5`)。
 *   **したがって「画面側が勝つ」は今日、解決した値の上でだけ観測できるものであり、
 *   画面の見た目は3値のどれでも同じである = 「書けるが今日は効かない」。****隠さない。**
 * - **`ReferenceInput` はこの関数を今日も呼んでいない**(`V6-M1` と同じ)——
 *   **呼ばないことが「書かなかった画面が今日と1バイトも変わらない」の担保である。**
 *   **【`V6-M4-T01` の実測】この1文は今日も真である** —— **選び方の解決は
 *   `FieldInput` の `case "reference"` の1箇所だけが呼び、`ReferenceInput` の本体は
 *   今日も新しいキーを1バイトも読んでいない。**
 * - **候補の件数・上限・絞り込み・可視性を1つも扱っていない。**
 */
import { afterEach, expect, mock, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { cleanup, render } from "@testing-library/react";
import type { Field, FormView } from "../../src/kernel/types.ts";
import {
  DEFAULT_REFERENCE_PICKER,
  FieldInput,
  type FieldInputValue,
  type ReferenceChoices,
  resolveReferencePicker,
} from "../src/fields/input.tsx";

afterEach(() => {
  cleanup();
});

const WEB_SRC = join(dirname(import.meta.dir), "src");
const INPUT_PATH = join(WEB_SRC, "fields", "input.tsx");

/** 有限3値の全量。**正はスキーマと `src/kernel/types.ts` であり、ここはその写しである。** */
const PICKERS = ["list", "type_filter", "search"] as const;

type ReferenceField = Extract<Field, { type: "reference" }>;

function referenceField(picker?: (typeof PICKERS)[number]): ReferenceField {
  const field = {
    id: "customer_id",
    name: "取引先",
    type: "reference",
    reference_table: "targets",
  } as ReferenceField;
  return picker === undefined ? field : { ...field, reference_picker: picker };
}

function form(pickers?: FormView["reference_pickers"]): FormView {
  const view: FormView = {
    id: "order-form",
    type: "form",
    table: "order",
    fields: ["customer_id"],
  };
  return pickers === undefined ? view : { ...view, reference_pickers: pickers };
}

// --- (a) 優先順位: 画面 > 項目 > 既定 ------------------------------------------------------

test("(i) 入力画面側の指定が、項目側の指定より優先される(3値 × 3値 の9通り全部)", () => {
  for (const fieldPicker of PICKERS) {
    for (const viewPicker of PICKERS) {
      expect(
        resolveReferencePicker(referenceField(fieldPicker), form({ customer_id: viewPicker })),
        `${fieldPicker} → ${viewPicker}`,
      ).toBe(viewPicker);
    }
  }
});

test("画面側が書いていない項目は、項目側の指定に倒れる", () => {
  for (const picker of PICKERS) {
    // **別の項目についてだけ書いた画面** —— この項目については「書いていない」である。
    expect(resolveReferencePicker(referenceField(picker), form({ other_id: "search" }))).toBe(
      picker,
    );
  }
});

test("(ii) 画面も項目も書かなければ list(今日どおりのプルダウン)になる", () => {
  expect(DEFAULT_REFERENCE_PICKER).toBe("list");
  // 画面そのものが無い(第2引数を渡さない)。
  expect(resolveReferencePicker(referenceField())).toBe("list");
  // 画面は在るが `reference_pickers` を書いていない。
  expect(resolveReferencePicker(referenceField(), form())).toBe("list");
  // 画面は在るが、この項目については書いていない。
  expect(resolveReferencePicker(referenceField(), form({ other_id: "search" }))).toBe("list");
});

test("画面側だけを書いた項目(項目側は書いていない)も画面側の値になる", () => {
  for (const picker of PICKERS) {
    expect(resolveReferencePicker(referenceField(), form({ customer_id: picker }))).toBe(picker);
  }
});

// --- (b) 解決の規則を2箇所に書いていない ---------------------------------------------------

/** `web/src` 配下の `.ts` / `.tsx` を全部集める。 */
function webSourceFiles(directory: string = WEB_SRC): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      return webSourceFiles(full);
    }
    return entry.endsWith(".ts") || entry.endsWith(".tsx") ? [full] : [];
  });
}

test("既定も優先順位も web/src の1ファイル・1関数だけが持つ", () => {
  const files = webSourceFiles().filter((file) =>
    readFileSync(file, "utf8").includes("reference_picker"),
  );
  expect(files.map((file) => relative(WEB_SRC, file))).toEqual(["fields/input.tsx"]);
  const source = readFileSync(INPUT_PATH, "utf8");
  // **既定の定数は1つだけである**(`V6-M1-T03` が置いたものを唯一の既定として使う)。
  expect(source.split("const DEFAULT_REFERENCE_PICKER").length - 1).toBe(1);
  // **解決関数の宣言も1つだけである**(2本目を作っていない)。
  expect(source.split("export function resolveReferencePicker").length - 1).toBe(1);
  // **画面側のキーを読んでいるのはその1関数の中だけである。**
  expect(source.split("reference_pickers?.[").length - 1).toBe(1);
});

// --- (c) 書かなかった画面の DOM が今日と1バイトも変わらない ---------------------------------

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

function renderReference(field: Field, value: FieldInputValue = "rec-1"): string {
  const onChange = mock((_value: FieldInputValue) => {});
  const { container } = render(
    <FieldInput
      field={field}
      inputId="input-under-test"
      value={value}
      onChange={onChange}
      appId="app-under-test"
      referenceChoices={readyChoices()}
    />,
  );
  return container.innerHTML;
}

test("(ii) list の描画経路は画面側のキーを1バイトも読んでいない", () => {
  const source = readFileSync(INPUT_PATH, "utf8");
  const start = source.indexOf("function ReferenceInput({");
  expect(start).toBeGreaterThan(-1);
  // **【`V6-M4-T01`】終端の目印を `\nfunction ` から `\n}\n` に変えた**
  // (理由は `reference-picker.test.tsx` の同じ検査に書いた。測る対象は変えていない)。
  const end = source.indexOf("\n}\n", start + 1);
  expect(end).toBeGreaterThan(start);
  const body = source.slice(start, end);
  expect(body).not.toContain("reference_pickers");
  expect(body).not.toContain("resolveReferencePicker");
});

/**
 * **同一性を保つ側**(`V6-M4-T01` が絞り込んだ)。**理由は
 * `reference-picker.test.tsx` の `UNCHANGED_PICKERS` と同じである。**
 *
 * **【`V6-M5-T01` の書き換え。旧文を1バイトも消していない】** **`V6-M5` が `search` に
 * 器を当てたので、予告どおりここは赤くなった。** **指示のとおり同一性の検査は `list` の
 * 側だけに残し、`search` については「今日と違う」ことを測る検査を1本足した。**
 */
const UNCHANGED_PICKERS = ["list"] as const;

test("(ii) 画面側に list を書いても、今日の DOM は1バイトも変わらない", () => {
  // **`FieldInput` は今日 `view` を受け取れるが、渡さない呼び出しは
  // 「画面側の宣言が無い」に倒れる** —— **この検査は項目側だけを書いて測っている。**
  const baseline = renderReference(referenceField());
  cleanup();
  expect(baseline).toContain("<select");
  for (const picker of UNCHANGED_PICKERS) {
    const rendered = renderReference(referenceField(picker));
    cleanup();
    expect(rendered, picker).toBe(baseline);
  }
});

test("【`V6-M5-T01`】項目側に search を書いた項目の DOM は、書かなかった項目と同じではない", () => {
  const baseline = renderReference(referenceField());
  cleanup();
  const rendered = renderReference(referenceField("search"));
  cleanup();
  // **同じなら「書けるが効かない」がまだ残っているということである。**
  expect(rendered).not.toBe(baseline);
});
