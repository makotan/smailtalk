/**
 * 参照項目の「選び方」の既定を、表示層の1箇所に固定する
 * (`K-G5`。`V6-M1-T03` / `ADR-0288` 限定3)。
 *
 * **限定表の正は [`docs/adr/0288-reference-picker-field.md`](../../docs/adr/0288-reference-picker-field.md)
 * §Decision 3**、完了条件の正は `docs/plan/v6/records/v6-m0.md` §6 の `V6-M1-T03` の行。
 *
 * ## このファイルが固定すること
 *
 * 1. **既定は `list`(今日どおりのプルダウン)であり、既定を持つのは表示層の1箇所だけである。**
 * 2. **書かなかった項目の画面が今日と1バイトも変わらない** —— **描画経路が新しいキーを
 *    1バイトも読んでいない**ことを、(a) `ReferenceInput` の実装本体に `reference_picker` が
 *    1回も現れないことと、(b) 3値それぞれを書いた場合と書かない場合の DOM が
 *    1バイトも違わないこと、の2つで測る。
 *
 * ## 【`V6-M4-T01` の書き換え。旧文を消していないので下に残す】
 *
 * **`V6-M4` が `type_filter` の描画を実装したので、上の指示どおり
 * 同一性の検査は `list` の側だけに残した。** **`type_filter` については
 * 「今日と違う」ことを測る**(**同じであってはならない**)。
 * **`search` は今日も `list` と同じ描画に倒れる**(器は `V6-M5` の担当)ので
 * 同一性の側に残っている —— **`V6-M5` が実装したら、そこもまた赤くなる。それは正しい赤である。**
 *
 * ## このファイルが証明しないこと(先に書く。誇張しない)
 *
 * - **`type_filter` の中身(絞り込み・上限・可視性・選択済みの値)を1つも測っていない**
 *   —— **`web/test/reference-type-filter.test.tsx` /
 *   `web/test/reference-picker-selected-value.test.tsx` /
 *   `web/test/reference-picker-visibility.test.ts` /
 *   `web/test/reference-picker-manifest-purity.test.tsx` の担当である。**
 * - **【旧文。1バイトも書き換えていない】** **`type_filter` / `search` の描画を1つも
 *   測っていない。** **今日その実装は1バイトも無い**(当たり先は `V6-M4` / `V6-M5`)。
 *   **したがって下の「DOM が同一である」は、今日の時点では「3値のどれを書いても画面は
 *   変わらない」という意味でもある** —— **これは「書けるが今日は効かない」状態であり、
 *   隠さない。** **`V6-M4` / `V6-M5` が実装したら、この同一性の検査は `list` の側だけに残す**
 *   (そのとき赤くなるのは正しい)。
 * - **候補の件数・上限・絞り込み・可視性を1つも扱っていない。**
 * - **カーネル側(スキーマ・`change_field`)の実測は `src/kernel/reference-picker.test.ts` の
 *   担当である。**
 */
import { afterEach, expect, mock, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { cleanup, render } from "@testing-library/react";
import type { Field } from "../../src/kernel/types.ts";
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

function referenceField(picker?: (typeof PICKERS)[number]): Field {
  const field: Field = {
    id: "customer_id",
    name: "取引先",
    type: "reference",
    reference_table: "targets",
  };
  return picker === undefined ? field : { ...field, reference_picker: picker };
}

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

// --- (a) 既定は list。既定を持つのは1箇所 -------------------------------------------------

test("限定3: 書かなかった項目の選び方は list(今日どおりのプルダウン)である", () => {
  expect(DEFAULT_REFERENCE_PICKER).toBe("list");
  expect(resolveReferencePicker(referenceField() as Extract<Field, { type: "reference" }>)).toBe(
    "list",
  );
});

test("書いた項目は書いたとおりに解決される(3値とも)", () => {
  for (const picker of PICKERS) {
    expect(
      resolveReferencePicker(referenceField(picker) as Extract<Field, { type: "reference" }>),
    ).toBe(picker);
  }
});

test("既定を持つのは web/src の1ファイル・1定数だけである", () => {
  const files = webSourceFiles().filter((file) =>
    readFileSync(file, "utf8").includes("reference_picker"),
  );
  expect(files.map((file) => relative(WEB_SRC, file))).toEqual(["fields/input.tsx"]);
  const source = readFileSync(INPUT_PATH, "utf8");
  // **定数の宣言は1つだけである**(値を持つ場所を2つにしない)。
  expect(source.split("const DEFAULT_REFERENCE_PICKER").length - 1).toBe(1);
});

// --- (b) 書かなかった項目の画面が今日と1バイトも変わらない ---------------------------------

test("(ii) 描画経路は reference_picker を1バイトも読んでいない", () => {
  // **`ReferenceInput` の実装本体を切り出して、新しいキーが1回も現れないことを測る。**
  // **これが「既定の描画を通る経路で新しいキーを読まない」の実測である。**
  const source = readFileSync(INPUT_PATH, "utf8");
  const start = source.indexOf("function ReferenceInput({");
  expect(start).toBeGreaterThan(-1);
  // **【`V6-M4-T01`】終端の目印を `\nfunction ` から `\n}\n` に変えた。**
  // **`V6-M4` が `ReferenceInput` の直後に `ReferenceTypeFilterInput` を置いたので、
  // 旧来の目印では次の関数の doc コメントまで切り出してしまい、
  // 「`ReferenceInput` の本体」を測れなくなった。** **測る対象は1ミリも変えていない。**
  const end = source.indexOf("\n}\n", start + 1);
  expect(end).toBeGreaterThan(start);
  const body = source.slice(start, end);
  expect(body).not.toContain("reference_picker");
  expect(body).not.toContain("resolveReferencePicker");
  expect(body).not.toContain("DEFAULT_REFERENCE_PICKER");
});

/**
 * **同一性を保つ側**(`V6-M4-T01` が絞り込んだ)。
 * **`list` は既定であり、今日と1ピクセルも変わってはならない。**
 *
 * **【旧文。1バイトも書き換えていない】** **`search` は器が今日1バイトも無いので
 * `list` と同じ描画に倒れる** —— **`V6-M5` が実装したらここは赤くなる。それは正しい赤である。**
 *
 * **【`V6-M5-T01` の書き換え】** **実装した。予告どおり赤くなったので、指示のとおり
 * 同一性の検査は `list` の側だけに残した。** **`search` については「今日と違う」ことを
 * 測る**(下の専用の検査)。**同一性を保つ側は今日1値だけである。**
 */
const UNCHANGED_PICKERS = ["list"] as const;

test("(ii) キーを書かなかった項目の DOM と、list を書いた項目の DOM が1バイトも違わない", () => {
  const baseline = renderReference(referenceField());
  cleanup();
  // **今日の画面が素の `<select>` であることも同時に固定する**(`ADR-0087` 限定8)。
  expect(baseline).toContain("<select");
  for (const picker of UNCHANGED_PICKERS) {
    const rendered = renderReference(referenceField(picker));
    cleanup();
    expect(rendered, picker).toBe(baseline);
  }
});

test("(ii) 値が選ばれている状態でも list の DOM が1バイトも違わない", () => {
  const baseline = renderReference(referenceField(), "rec-2");
  cleanup();
  for (const picker of UNCHANGED_PICKERS) {
    const rendered = renderReference(referenceField(picker), "rec-2");
    cleanup();
    expect(rendered, picker).toBe(baseline);
  }
});

test("【`V6-M4-T01`】type_filter を書いた項目の DOM は、書かなかった項目と同じではない", () => {
  const baseline = renderReference(referenceField());
  cleanup();
  const rendered = renderReference(referenceField("type_filter"));
  cleanup();
  // **同じであってはならない** —— 同じなら「書けるが効かない」がまだ残っているということである。
  expect(rendered).not.toBe(baseline);
});

test("【`V6-M5-T01`】search を書いた項目の DOM は、書かなかった項目と同じではない", () => {
  const baseline = renderReference(referenceField());
  cleanup();
  const rendered = renderReference(referenceField("search"));
  cleanup();
  // **同じなら「書けるが効かない」がまだ残っているということである。**
  expect(rendered).not.toBe(baseline);
});

test("【`V6-M4-T01`】3値の全量は今日も3つであり、同一性を測る側と測らない側の合計と一致する", () => {
  // **`PICKERS`(3値の全量)を1つも取りこぼしていないことを機械で数える。**
  // **【`V6-M5-T01` の書き換え】** **測らない側が `type_filter` の1値から
  // `type_filter` / `search` の2値になった** —— **`search` に器が当たったためである。**
  expect(PICKERS.length).toBe(3);
  expect([...UNCHANGED_PICKERS, "type_filter", "search"].sort()).toEqual([...PICKERS].sort());
});
