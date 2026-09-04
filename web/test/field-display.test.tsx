/**
 * フィールド値の表示形式のテスト(V0-P3-T04)。
 *
 * v0 語彙のフィールド型7種すべてについて「値がある場合」と「未設定(null)」の
 * 表示を固定する。ここに現れるフィールドID・テーブルID・値はすべてこのテスト
 * ファイル内の作り物であり、実装側にアプリ固有の名前は入らない(CP-3 確認方法4)。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import type { Field, Manifest, Table } from "../../src/kernel/types.ts";
import { FieldValue, referenceLinkTarget } from "../src/fields/display.tsx";
import {
  buildReferenceLabelIndex,
  type ReferenceLabelIndex,
  representativeField,
} from "../src/fields/reference-label.ts";

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

/** image 型の配信 URL を組むためのアプリID(このテスト内の作り物)。 */
const APP_ID = "app-under-test";

const TARGET_TABLE: Table = {
  id: "targets",
  name: "参照先",
  fields: [
    { id: "code", name: "コード", type: "number" },
    { id: "label", name: "名前", type: "text" },
    { id: "memo", name: "メモ", type: "text" },
  ],
};

function renderValue(
  field: Field,
  value: unknown,
  referenceLabels: ReferenceLabelIndex = new Map(),
): void {
  render(
    <FieldValue
      field={field}
      value={value as never}
      referenceLabels={referenceLabels}
      appId={APP_ID}
    />,
  );
}

describe("7型の表示形式", () => {
  test("text はそのまま出る", () => {
    renderValue(FIELDS.text as Field, "そのまま");
    expect(screen.getByText("そのまま")).toBeDefined();
  });

  test("long_text は一覧では省略され、全文は title で参照できる", () => {
    const long = "あ".repeat(120);
    renderValue(FIELDS.long_text as Field, long);
    const node = screen.getByTestId("field-value-long_text");
    expect(node.textContent?.length).toBeLessThan(long.length);
    expect(node.textContent?.endsWith("…")).toBe(true);
    expect(node.getAttribute("title")).toBe(long);
  });

  test("long_text が短ければ省略しない", () => {
    renderValue(FIELDS.long_text as Field, "みじかい");
    expect(screen.getByTestId("field-value-long_text").textContent).toBe("みじかい");
  });

  test("number は数値として出る", () => {
    renderValue(FIELDS.number as Field, 42);
    expect(screen.getByTestId("field-value-number").textContent).toBe("42");
  });

  test("number の 0 は未設定にならない", () => {
    renderValue(FIELDS.number as Field, 0);
    expect(screen.getByTestId("field-value-number").textContent).toBe("0");
  });

  test("number の DOM の形(testid と class)は変わっていない", () => {
    renderValue(FIELDS.number as Field, 1234567);
    const node = screen.getByTestId("field-value-number");
    expect(node.className).toBe("field-number");
  });

  test("boolean の true はチェック表示になる", () => {
    renderValue(FIELDS.boolean as Field, true);
    expect(screen.getByLabelText("はい")).toBeDefined();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  test("boolean の false は true と区別できる表示になる", () => {
    renderValue(FIELDS.boolean as Field, false);
    expect(screen.getByLabelText("いいえ")).toBeDefined();
    expect(screen.queryByLabelText("はい")).toBeNull();
  });

  /**
   * **boolean は印(`Badge`)として出す**(`V4-M15-T05`。`ADR-0087`)。
   *
   * **色を新しく作っていない** —— 使う変種は `default`(`bg-secondary`)と `muted` の2つ
   * だけで、真偽で配色の意味を作らない(`--color-success` のようなスロットは25の中に無い)。
   * **既存のクラス名 `field-boolean` も `role` / `aria-label` も1つも落としていない。**
   */
  test("boolean は印(Badge)として出る。class と role と読み上げは変わらない", () => {
    for (const [value, label] of [
      [true, "はい"],
      [false, "いいえ"],
    ] as const) {
      renderValue(FIELDS.boolean as Field, value);
      const node = screen.getByTestId("field-value-boolean");
      expect(node.getAttribute("data-slot"), label).toBe("badge");
      expect(node.className, label).toContain("field-boolean");
      expect(node.getAttribute("role"), label).toBe("img");
      expect(node.getAttribute("aria-label"), label).toBe(label);
      // 新しい色を作らない(変種は2つだけ)。
      expect(["default", "muted"], label).toContain(node.getAttribute("data-variant") ?? "");
      cleanup();
    }
  });

  // E-G44(V4-M6): **保持している日時を表示で落とさない。** 着手前はここが
  // 「時刻付き ISO8601 でも日付部分」を固定しており、同日内の順序が画面から読めなかった
  // (`admin-payment-list` の受信日時10件中5件が `2026-08-02` としか出ない)。
  test("date は時刻を持っていれば時刻まで出す(E-G44)", () => {
    renderValue(FIELDS.date as Field, "2026-07-18T09:30:00Z");
    expect(screen.getByTestId("field-value-date").textContent).toBe("2026-07-18 09:30:00Z");
  });

  test("date はミリ秒まで持っていれば落とさない(同一秒内の順序が読める。E-G44)", () => {
    renderValue(FIELDS.date as Field, "2026-08-02T02:18:56.423Z");
    expect(screen.getByTestId("field-value-date").textContent).toBe("2026-08-02 02:18:56.423Z");
  });

  test("date はオフセット付きでもそのまま残す(表示ロケールを持ち込まない。E-G44)", () => {
    renderValue(FIELDS.date as Field, "2026-07-18T09:30:00+09:00");
    expect(screen.getByTestId("field-value-date").textContent).toBe("2026-07-18 09:30:00+09:00");
  });

  test("date が日付だけならそのまま", () => {
    renderValue(FIELDS.date as Field, "2026-07-18");
    expect(screen.getByTestId("field-value-date").textContent).toBe("2026-07-18");
  });

  test("select は値そのまま", () => {
    renderValue(FIELDS.select as Field, "beta");
    expect(screen.getByTestId("field-value-select").textContent).toBe("beta");
  });

  test("reference は参照先の代表値を出し、生の ID は出さない", () => {
    const index = buildReferenceLabelIndex([
      {
        table: TARGET_TABLE,
        records: [
          {
            _id: "rec-1",
            _created_at: "",
            _updated_at: "",
            code: 7,
            label: "代表値",
            memo: "べつ",
          },
        ],
      },
    ]);
    renderValue(FIELDS.reference as Field, "rec-1", index);
    expect(screen.getByTestId("field-value-reference").textContent).toBe("代表値");
    expect(screen.queryByText("rec-1")).toBeNull();
  });

  test("reference が解決できない場合は解決できなかったことが分かる表示になる", () => {
    renderValue(FIELDS.reference as Field, "rec-missing", new Map());
    const node = screen.getByTestId("field-value-reference");
    expect(node.textContent).toContain("見つかりません");
    // 嘘をつかないため、手掛かりとして ID 自体は残す。
    expect(node.textContent).toContain("rec-missing");
  });

  test("image は配信 URL を src にした img で出る(file_id を素で見せない。V2-M2-T04)", () => {
    renderValue(FIELDS.image as Field, "file-abc");
    const node = screen.getByTestId("field-value-image");
    expect(node.tagName).toBe("IMG");
    // 値(file_id)は配信 URL のパスに埋まり、生の file_id を読み手に文字列表示しない。
    expect(node.getAttribute("src")).toBe(`/api/apps/${APP_ID}/files/file-abc`);
    expect(node.getAttribute("alt")).toBe("画像");
    expect(screen.queryByText("file-abc")).toBeNull();
  });

  test("image の file_id は配信 URL の中で encodeURIComponent される", () => {
    renderValue(FIELDS.image as Field, "a/b?c");
    const node = screen.getByTestId("field-value-image");
    expect(node.getAttribute("src")).toBe(`/api/apps/${APP_ID}/files/a%2Fb%3Fc`);
  });
});

/**
 * `long_text` の切り詰め長のプリセット(ADR-0050 の軸7 / V3-M2-T04)。
 *
 * **これは表示関数が受け取る唯一の表示オプションである**(ADR-0050 限定10)。
 * 受け取るのは3値の enum だけで、**文字数・色・書体の実値は1つも受け取らない** ——
 * 段階値と文字数の対応は `web/src/fields/display.tsx` の中にしかなく、マニフェストからは
 * 「短め / 標準 / 長め」しか書けない。
 *
 * **CSS では実装できない**(切り詰め後の文字列しか DOM に出ないので、CSS からは全文を
 * 復元できない)。したがって軸1〜6 と違い、ここには `data-preset-*` 属性が1つも出ない。
 *
 * 段階値は **1 : 2 : 4**(20 / 40 / 80)。比率の根拠は軸2(列の幅 = 6rem / 12rem / 24rem)と
 * 同じ規則を採ったことで、**`standard` は今日の既定(40)と同じ値に固定する** ——
 * 未指定と `standard` で見え方が変わると、enum の名前(標準)と食い違う。
 */
describe("long_text の切り詰め長のプリセット(軸7)", () => {
  /** 200文字。どの段階値でも必ず切り詰めが起きる長さ。 */
  const LONG = "あいうえおかきくけこ".repeat(20);

  /** 段階値 → 切り詰める文字数(`undefined` = 未指定)。**この表が実装と1対1である。** */
  const EXPECTED: [preview: "short" | "standard" | "long" | undefined, length: number][] = [
    [undefined, 40],
    ["short", 20],
    ["standard", 40],
    ["long", 80],
  ];

  function renderLongText(
    textPreview: "short" | "standard" | "long" | undefined,
    value: string = LONG,
  ): HTMLElement {
    render(
      <FieldValue
        field={FIELDS.long_text as Field}
        value={value as never}
        referenceLabels={new Map()}
        appId={APP_ID}
        textPreview={textPreview}
      />,
    );
    return screen.getByTestId("field-value-long_text");
  }

  for (const [preview, length] of EXPECTED) {
    test(`${preview ?? "未指定"} は ${length} 文字で切り詰める`, () => {
      const node = renderLongText(preview);
      // 切り詰め後の文字列 + 省略記号。
      expect(node.textContent).toBe(`${LONG.slice(0, length)}…`);
      expect(node.textContent?.length).toBe(length + 1);
    });

    test(`${preview ?? "未指定"} でも全文は title に残る`, () => {
      expect(renderLongText(preview).getAttribute("title")).toBe(LONG);
    });

    test(`${preview ?? "未指定"} で ${length} 文字ちょうどなら切り詰めず title も出さない`, () => {
      const exact = LONG.slice(0, length);
      const node = renderLongText(preview, exact);
      expect(node.textContent).toBe(exact);
      expect(node.getAttribute("title")).toBeNull();
    });
  }

  test("standard は未指定と1文字も違わない(既定を明示的に書いただけになる)", () => {
    const unspecified = renderLongText(undefined).textContent;
    cleanup();
    expect(renderLongText("standard").textContent).toBe(unspecified as string);
  });

  test("段階値の比は 1 : 2 : 4(軸2 の列幅 6rem / 12rem / 24rem と同じ規則)", () => {
    const lengthOf = (preview: "short" | "standard" | "long"): number => {
      const text = renderLongText(preview).textContent ?? "";
      cleanup();
      // 末尾の省略記号ぶんを除く。
      return text.length - 1;
    };
    const short = lengthOf("short");
    const standard = lengthOf("standard");
    const long = lengthOf("long");
    expect(standard).toBe(short * 2);
    expect(long).toBe(short * 4);
  });
});

describe("未設定(null)の表示", () => {
  for (const [name, field] of Object.entries(FIELDS)) {
    test(`${name} の null は未設定と表示する`, () => {
      renderValue(field as Field, null);
      expect(screen.getByTestId(`field-value-${(field as Field).type}`).textContent).toBe("未設定");
    });
  }
});

describe("参照先の代表値の決め方", () => {
  test("参照先テーブルの最初の text フィールドが代表値になる", () => {
    expect(representativeField(TARGET_TABLE)?.id).toBe("label");
  });

  test("text フィールドが無ければ代表値は決まらない", () => {
    const table: Table = {
      id: "no_text",
      name: "テキストなし",
      fields: [{ id: "count", name: "件数", type: "number" }],
    };
    expect(representativeField(table)).toBeUndefined();
  });

  test("代表値フィールドが無くても、参照先が実在すれば _id を出す(参照切れと混同しない)", () => {
    const table: Table = {
      id: "targets",
      name: "参照先",
      fields: [{ id: "count", name: "件数", type: "number" }],
    };
    const index = buildReferenceLabelIndex([
      { table, records: [{ _id: "rec-1", _created_at: "", _updated_at: "", count: 3 }] },
    ]);
    renderValue(FIELDS.reference as Field, "rec-1", index);
    const node = screen.getByTestId("field-value-reference");
    // 見つかっているので「見つかりません」とは書かない。非 text の値で代用もしない。
    expect(node.textContent).toBe("rec-1");
    expect(node.textContent).not.toContain("見つかりません");
  });
});

/**
 * 参照セルがリンクになる条件(V3-M3-T02。完了条件の正は
 * `docs/plan/v3/records/v3-m3.md` §2 の「V3-M3-T02」節)。
 *
 * **ここで固定するのは判定だけである。** リンクの器(`<a>`)は呼び出し側が組むので
 * (`FieldValue` / `FieldCell` の引数を増やさない = ADR-0050 限定10)、**表示関数の DOM は
 * 1バイトも変わっていない** —— 上の「7型の表示形式」の reference の2本がそれを固定し続けている。
 * **器が実際に付くことの固定は `web/test/record-navigation.test.tsx` にある。**
 *
 * **リンクにする条件は3つの連言**である: 値がある / 参照先レコードが実在する
 * (`found === true`)/ 参照先テーブルに `detail_view` がある。
 * **「参照切れ」と「代表値が引けない」を混同しない。**
 */
describe("参照セルがリンクになる条件(referenceLinkTarget)", () => {
  const TARGET_ROW = { _id: "rec-1", _created_at: "", _updated_at: "", label: "代表値" };
  const REFERENCE_FIELD = FIELDS.reference as Field;

  function index(rows = [TARGET_ROW]): ReferenceLabelIndex {
    return buildReferenceLabelIndex([{ table: TARGET_TABLE, records: rows }]);
  }

  /** 参照先テーブル targets に detail_view を `count` 個持つマニフェスト。 */
  function manifestWithDetailViews(count: number): Manifest {
    return {
      app: {
        id: APP_ID,
        name: "サンプル",
        tables: [TARGET_TABLE],
        views: Array.from({ length: count }, (_unused, i) => ({
          id: `target-detail-${i + 1}`,
          type: "detail_view" as const,
          table: "targets",
        })),
      },
    };
  }

  test("参照先テーブルに detail_view があれば、その detail_view を返す", () => {
    const target = referenceLinkTarget(
      manifestWithDetailViews(1),
      REFERENCE_FIELD,
      "rec-1",
      index(),
    );
    expect(target?.id).toBe("target-detail-1");
  });

  test("候補が2つ以上でも定義順の先頭を返す(規約を再実装していない)", () => {
    const target = referenceLinkTarget(
      manifestWithDetailViews(2),
      REFERENCE_FIELD,
      "rec-1",
      index(),
    );
    expect(target?.id).toBe("target-detail-1");
  });

  test("detail_view が無ければリンクにしない(押せるのに開けない導線を作らない)", () => {
    expect(
      referenceLinkTarget(manifestWithDetailViews(0), REFERENCE_FIELD, "rec-1", index()),
    ).toBeUndefined();
  });

  test("参照切れ(found === false)はリンクにしない", () => {
    expect(
      referenceLinkTarget(manifestWithDetailViews(1), REFERENCE_FIELD, "rec-missing", index()),
    ).toBeUndefined();
  });

  test("代表値が引けないだけ(found === true)ならリンクにする", () => {
    const rows = [{ _id: "rec-1", _created_at: "", _updated_at: "", label: "" }];
    const target = referenceLinkTarget(
      manifestWithDetailViews(1),
      REFERENCE_FIELD,
      "rec-1",
      index(rows),
    );
    expect(target?.id).toBe("target-detail-1");
  });

  test("値が未設定ならリンクにしない", () => {
    expect(
      referenceLinkTarget(manifestWithDetailViews(1), REFERENCE_FIELD, null, index()),
    ).toBeUndefined();
  });

  test("reference 以外の型はリンクにしない(型で落とす)", () => {
    expect(
      referenceLinkTarget(manifestWithDetailViews(1), FIELDS.text as Field, "rec-1", index()),
    ).toBeUndefined();
  });

  test("manifest を持たない呼び出し元ではリンクにならない(判定の入口を1つに絞る)", () => {
    expect(referenceLinkTarget(undefined, REFERENCE_FIELD, "rec-1", index())).toBeUndefined();
  });
});

/**
 * **参照セルのリンクの行き先からも、一続きの流れの段が外れる**
 * (`FU-G1a`。`V10-M18-T01` / `ADR-0362` §Decision 1 の遷移点3)。
 *
 * **`referenceLinkTarget` の引数は1本も増えていない** —— **除外を当てるかどうかは
 * この関数の中で決まっており、呼び出し側(`DetailViewRenderer` / `ListViewRenderer`)は
 * 今日と同じ4引数で呼ぶ。** **`ADR-0050` 限定10(表示関数に表示オプションを足さない)に
 * 1バイトも触っていない。**
 *
 * **ここが言えないこと**: **`<a>` が実際に付く / 付かないことを1つも見ていない**
 * (器は呼び出し側が組む)。**それは `web/test/record-navigation.test.tsx` が持つ。**
 */
describe("参照セルのリンクと一続きの流れの段(FU-G1a / ADR-0362)", () => {
  const TARGET_ROW = { _id: "rec-1", _created_at: "", _updated_at: "", label: "代表値" };
  const REFERENCE_FIELD = FIELDS.reference as Field;
  const STEP = { id: "kaimono", step: 2, kind: "input" } as const;

  function index(rows = [TARGET_ROW]): ReferenceLabelIndex {
    return buildReferenceLabelIndex([{ table: TARGET_TABLE, records: rows }]);
  }

  /**
   * 参照先テーブル `targets` の `detail_view` を並べる。
   * `steps` に真を並べた位置が「段になっている画面」である。
   */
  function manifestWithSteps(steps: boolean[]): Manifest {
    return {
      app: {
        id: APP_ID,
        name: "サンプル",
        tables: [TARGET_TABLE],
        views: steps.map((isStep, i) => ({
          id: `target-detail-${i + 1}`,
          type: "detail_view" as const,
          table: "targets",
          ...(isStep ? { flow: { ...STEP, step: i + 1 } } : {}),
        })),
      },
    };
  }

  test("(d) 参照先の detail_view が全部段なら、リンクにしない(別の画面へ倒さない)", () => {
    expect(
      referenceLinkTarget(manifestWithSteps([true, true]), REFERENCE_FIELD, "rec-1", index()),
    ).toBeUndefined();
  });

  test("(c) 段でない detail_view が後ろに在れば、それを返す(定義順は保つ)", () => {
    const target = referenceLinkTarget(
      manifestWithSteps([true, false, false]),
      REFERENCE_FIELD,
      "rec-1",
      index(),
    );
    expect(target?.id).toBe("target-detail-2");
  });

  test("(f) 段を1つも宣言していなければ、今日どおり定義順の先頭を返す", () => {
    const target = referenceLinkTarget(
      manifestWithSteps([false, false]),
      REFERENCE_FIELD,
      "rec-1",
      index(),
    );
    expect(target?.id).toBe("target-detail-1");
  });
});

/**
 * number の桁区切り(V1-M0-T08 / v0 所見 F-9)。
 *
 * マニフェストには「この number は通貨である」と書く手段が無い(ADR-0007 §7a で
 * `currency` 型も `format` プロパティも却下された)。したがって桁区切りは全 number に
 * 一律で効き、**単位(円 / $ 等)は出さない**。フィールド名から通貨を推測するのは
 * ADR-0007 Δ4(自己完結性の喪失)に当たる。
 *
 * 代わりに閾値を置く: **整数部が4桁以下なら区切らない**。西暦・評価・連番・件数・
 * 順位といった通貨でない number の表示を変えないためである。
 */
describe("number の桁区切り", () => {
  function numberText(value: unknown): string {
    renderValue(FIELDS.number as Field, value);
    return screen.getByTestId("field-value-number").textContent ?? "";
  }

  describe("整数部4桁以下は無変更", () => {
    for (const value of [0, 5, 42, 999, 1500, 9999]) {
      test(`${value} はそのまま`, () => {
        expect(numberText(value)).toBe(String(value));
      });
    }

    test("西暦(2026)が 2,026 にならない", () => {
      expect(numberText(2026)).toBe("2026");
    });

    test("負の4桁(-9999)も無変更", () => {
      expect(numberText(-9999)).toBe("-9999");
    });

    test("4桁 + 小数も無変更", () => {
      expect(numberText(1500.5)).toBe("1500.5");
    });
  });

  describe("整数部5桁以上は3桁ごとに区切る", () => {
    test("10000 → 10,000(閾値のちょうど境目)", () => {
      expect(numberText(10000)).toBe("10,000");
    });

    test("1234567 → 1,234,567", () => {
      expect(numberText(1234567)).toBe("1,234,567");
    });

    test("負号は保たれる", () => {
      expect(numberText(-1234567)).toBe("-1,234,567");
    });

    test("小数は丸めずにそのまま残る", () => {
      expect(numberText(1234567.89)).toBe("1,234,567.89");
    });

    test("Intl の既定(小数3桁丸め)が起きていない", () => {
      expect(numberText(12345.678901)).toBe("12,345.678901");
    });
  });

  describe("数値として解釈できない値はそのまま出す", () => {
    for (const value of ["1e21", "abc", "", "12,345", "0x10", "Infinity"]) {
      test(`${JSON.stringify(value)} は素通し`, () => {
        expect(numberText(value)).toBe(value);
      });
    }
  });

  test("null は未設定のまま(既存挙動)", () => {
    renderValue(FIELDS.number as Field, null);
    expect(screen.getByTestId("field-value-number").textContent).toBe("未設定");
  });

  test("0 は未設定にならない(既存挙動の回帰)", () => {
    expect(numberText(0)).toBe("0");
  });
});
