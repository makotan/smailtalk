/**
 * `V4-M13` の計測器2本(`t13-probe.ts` / `t13-diff.ts`)の**純粋な部分だけ**の検査。
 *
 * ## 何を踏み、何を踏まないか(誇張しない)
 *
 * - **踏む**: 引数の解釈(`parseArgs`)/ ビュー1本を画面1本に写す規則(`screenForView`)/
 *   2つの計測を突き合わせて変化を全件出す処理(`diffMeasurements` / `summarize`)。
 * - **踏まない**: **サーバの起動も chromium の起動も1度もしない。** したがってこの検査は
 *   `bun test`(実 CI の `checks` ジョブ)でそのまま緑になる —— 計測そのものの再現は
 *   `docs/plan/v4/records/v4-m13-baseline.md` の手順が正である。
 *
 * **【この検査は見た目を1つも判定しない。】** `D-V4-14` は「合格ラインは置かない」であり、
 * ここで固定しているのは**計測器が壊れていないこと**だけである。
 */
import { describe, expect, test } from "bun:test";
import { diffMeasurements, summarize } from "./t13-diff.ts";
import { DEFAULT_BASE_URL, PROPS, parseArgs, screenForView } from "./t13-probe.ts";

describe("t13-probe の引数", () => {
  test("--label と --out-dir で既定値がそろう", () => {
    const options = parseArgs(["--label", "before", "--out-dir", "tmp/out"]);
    expect(options.label).toBe("before");
    expect(options.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(options.outDir).toBe("tmp/out");
    // **PNG の置き場は `.gitignore` の `data-` で始まる規則に載る名前でなければならない。**
    expect(options.shotsDir.startsWith("data-")).toBe(true);
    expect(options.shots).toBe(true);
    // `D-V4-44`(スマホ対応を v4 でやる)により**幅は必ず2つ以上**である。
    expect(options.widths.length).toBeGreaterThanOrEqual(2);
  });

  test("--label が無ければ落ちる(黙って測らない)", () => {
    expect(() => parseArgs([])).toThrow();
  });

  test("知らない引数は落ちる(綴り間違いを黙って無視しない)", () => {
    expect(() => parseArgs(["--label", "before", "--out-dir", "tmp/out", "--shot"])).toThrow();
  });

  /**
   * **`V9-M3-T01`(群D)。既定の出力先を撤去した。**
   *
   * 旧: `--out-dir` を省くと `docs/evidence/cp-v4-ui` へ書いた。
   * **`docs/` は公開単位(`apps/smailtalk/`)の外に残る**ので、この計測器を
   * 公開単位ごと配ると、既定値だけが器の外を指し続ける。**書き先を黙って決めない。**
   */
  test("--out-dir が無ければ落ちる(公開単位の外へ黙って書かない)", () => {
    expect(() => parseArgs(["--label", "before"])).toThrow();
  });

  test("--widths / --no-shots / --base-url を受ける", () => {
    const options = parseArgs([
      "--label",
      "after",
      "--out-dir",
      "tmp/out",
      "--widths",
      "1440, 320",
      "--no-shots",
      "--base-url",
      "http://localhost:9999",
    ]);
    expect(options.widths).toEqual([1440, 320]);
    expect(options.shots).toBe(false);
    expect(options.baseUrl).toBe("http://localhost:9999");
  });

  test("--widths に有効な数が1つも無ければ落ちる", () => {
    expect(() =>
      parseArgs(["--label", "before", "--out-dir", "tmp/out", "--widths", "abc"]),
    ).toThrow();
  });
});

describe("計測するプロパティの集合", () => {
  test("63件で重複が無い", () => {
    expect(PROPS.length).toBe(63);
    expect(new Set(PROPS).size).toBe(63);
  });

  test("`V4-M13` が名指しした軸が入っている", () => {
    const names: readonly string[] = PROPS;
    for (const prop of [
      "transition-duration",
      "animation-name",
      "border-radius",
      "box-shadow",
      "font-family",
      "line-height",
      "color",
      "background-color",
      "padding-top",
      "border-bottom-width",
    ]) {
      expect(names).toContain(prop);
    }
  });
});

describe("ビューから画面への写し", () => {
  test("一覧は一覧の計測点を持ち、URL に `_id` を付けない", () => {
    const screen = screenForView(
      { id: "catalog-list", type: "list_view", table: "product" },
      undefined,
    );
    expect(screen.path).toBe("/apps/ref-ec/views/catalog-list");
    expect(screen.probes.map((probe) => probe.key)).toContain("list-table");
    expect(screen.hover?.key).toBe("tr-0-hover");
  });

  test("単票は `_id` が解決できれば URL に付く", () => {
    const screen = screenForView(
      { id: "product-detail", type: "detail_view", table: "product" },
      "abc-123",
    );
    expect(screen.path).toBe("/apps/ref-ec/views/product-detail/records/abc-123");
    expect(screen.probes.map((probe) => probe.key)).toContain("detail-fields");
  });

  test("単票の `_id` が解決できなくても測る(0件の画面として)", () => {
    const screen = screenForView(
      { id: "cart-detail", type: "detail_view", table: "cart" },
      undefined,
    );
    expect(screen.path).toBe("/apps/ref-ec/views/cart-detail");
  });

  test("入力フォームはフォーカス中の計測を持つ", () => {
    const screen = screenForView({ id: "product-form", type: "form", table: "product" }, undefined);
    expect(screen.focus?.key).toBe("input-0-focus");
    expect(screen.probes.map((probe) => probe.key)).toContain("record-form");
  });

  test("どの種別でも計測点の名前は重複しない(突き合わせの鍵になるため)", () => {
    for (const type of ["list_view", "detail_view", "form"] as const) {
      const screen = screenForView({ id: "x", type, table: "t" }, undefined);
      const keys = screen.probes.map((probe) => probe.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

// --- 差分計算 -------------------------------------------------------------------

type Fixture = Parameters<typeof diffMeasurements>[0];

function measurement(overrides: {
  label: string;
  css: Record<string, string>;
  found?: boolean;
  width?: number;
  rectW?: number;
}): Fixture {
  return {
    label: overrides.label,
    capturedAt: "2026-08-03T00:00:00.000Z",
    widths: [1280, 390],
    roles: ["owner"],
    props: [...PROPS],
    results: [
      {
        screenId: "catalog-list",
        kind: "list_view",
        role: "owner",
        width: overrides.width ?? 1280,
        url: "http://localhost:3211/apps/ref-ec/views/catalog-list",
        title: "参照EC",
        page: { scrollWidth: 1280, clientWidth: 1280, horizontalOverflow: false },
        domOrder: ["h3.", "table.list-table"],
        probes: {
          "list-table": {
            found: overrides.found ?? true,
            matchedSelector: ".list-table",
            count: 1,
            tag: "table",
            className: "list-table",
            textLength: 100,
            rect: { x: 0, y: 0, w: overrides.rectW ?? 960, h: 200 },
            css: overrides.css,
          },
        },
      },
    ],
  };
}

describe("変化を全件出す", () => {
  test("同じものどうしなら0件(計測器の雑音が出ない形になっている)", () => {
    const before = measurement({ label: "before", css: { color: "rgb(0, 0, 0)" } });
    const after = measurement({ label: "after", css: { color: "rgb(0, 0, 0)" } });
    expect(diffMeasurements(before, after)).toHaveLength(0);
  });

  test("CSS が1つ変わったら1件だけ出る", () => {
    const before = measurement({ label: "before", css: { color: "rgb(0, 0, 0)" } });
    const after = measurement({ label: "after", css: { color: "rgb(17, 17, 17)" } });
    const changes = diffMeasurements(before, after);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({
      run: "catalog-list|owner|1280",
      kind: "css",
      probe: "list-table",
      item: "color",
      before: "rgb(0, 0, 0)",
      after: "rgb(17, 17, 17)",
    });
  });

  test("要素ごと消えた場合は `presence` として出る(黙って0件にしない)", () => {
    const before = measurement({ label: "before", css: { color: "rgb(0, 0, 0)" } });
    const after = measurement({ label: "after", css: {}, found: false });
    const changes = diffMeasurements(before, after);
    const kinds = new Set(changes.map((change) => change.kind));
    expect(kinds.has("presence")).toBe(true);
    expect(changes.some((change) => change.item === "found")).toBe(true);
    // 消えた側の CSS も「値が無くなった」として全件出る。
    expect(changes.some((change) => change.kind === "css" && change.after === "(無し)")).toBe(true);
  });

  test("実寸の変化は `rect` として別に数える", () => {
    const before = measurement({ label: "before", css: {}, rectW: 960 });
    const after = measurement({ label: "after", css: {}, rectW: 800 });
    const changes = diffMeasurements(before, after);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe("rect");
    expect(changes[0]?.item).toBe("w");
  });

  test("画面走行そのものが増減したら `screen` として出る", () => {
    const before = measurement({ label: "before", css: {} });
    const after = measurement({ label: "after", css: {}, width: 390 });
    const changes = diffMeasurements(before, after);
    expect(changes.filter((change) => change.item === "画面走行そのもの")).toHaveLength(2);
  });

  test("集計は種別ごと・走行ごとに数える(判定はしない)", () => {
    const before = measurement({ label: "before", css: { color: "a", "font-size": "16px" } });
    const after = measurement({ label: "after", css: { color: "b", "font-size": "18px" } });
    const summary = summarize(diffMeasurements(before, after));
    expect(summary.total).toBe(2);
    expect(summary.byKind.css).toBe(2);
    expect(summary.byRun["catalog-list|owner|1280"]).toBe(2);
  });
});
