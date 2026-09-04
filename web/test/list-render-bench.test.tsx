/**
 * V1-M9-T01 判断ゲート (b) 用の DOM 描画コスト計測(web 側の担当分)。
 *
 * ゲート (b) は「listRecords + JSON シリアライズ + **DOM 描画** の所要時間を
 * 1千 / 1万 / 10万件で実測」を要求している。listRecords / シリアライズ(バックエンド)は
 * 別担当が計測し、ここは **一覧の DOM 描画** の桁を測る。
 *
 * ## 何を測っているか(憲法6・正直に)
 *
 * これは **happy-dom 上の DOM 描画コスト** である。具体的には
 *   React の差分適用 + happy-dom への DOM ノード生成(`<tr>`/`<td>` 等の構築)
 * であって、**実ブラウザの layout / reflow / paint ではない**。実ブラウザはさらに
 * レイアウト計算と描画のコストが載るので、ここで得る値は「実用に耐えるか」の
 * **下限**(これより速くはならない側)の目安として読む。happy-dom は jsdom と同じく
 * ヘッドレスな JS 実装の DOM であり、この計測系はプロジェクト既定の `bun test` +
 * happy-dom(`bunfig.toml` の preload = `web/test/setup.ts`)をそのまま使う。
 *
 * ## 測定規律(M1-T05 / M9-T03 と同じ)
 *
 * 時間は **桁と比** のみを結論に使う。各 N で複数回測り、中央値・min・max・全 sample を
 * `console.log` に残す(1回だけの値は結論に載せない)。絶対値そのものは環境依存であり、
 * ゲートが読むのは N を10倍したときに描画時間がどの桁で伸びるか、である。
 *
 * ## 構造的事実(質的不変量)
 *
 * `ListViewRenderer` は仮想スクロールを持たず、受け取った全行を `<tr>` 化する
 * (`ListViewRenderer.tsx:184-207`)。「N 行 → 行要素が N 個」をテストで固定することが、
 * 「全件 DOM 化=描画コストが件数に線形」というゲートの構造的事実の裏取りになる。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ListView, Manifest } from "../../src/kernel/types.ts";
import type { RecordRow } from "../src/api.ts";
import { ListViewRenderer } from "../src/views/ListViewRenderer.tsx";

const APP_ID = "bench-app";

/** 参照列を持たないマニフェスト(参照先の追加 fetch を避け、描画コストだけを測る)。 */
function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "計測用",
      tables: [
        {
          id: "rows",
          name: "行",
          fields: [
            { id: "f_text", name: "テキスト", type: "text", required: true },
            { id: "f_num", name: "数値", type: "number" },
            { id: "f_bool", name: "真偽", type: "boolean" },
            { id: "f_date", name: "日付", type: "date" },
            { id: "f_select", name: "選択", type: "select", options: ["alpha", "beta"] },
          ],
        },
      ],
      views: [
        {
          id: "row-list",
          type: "list_view",
          table: "rows",
          columns: ["f_text", "f_num", "f_bool", "f_date", "f_select"],
        },
      ],
    },
  };
}

/** マニフェストの列数(= 1行あたりのセル数)。cells = N * COLUMNS。 */
const COLUMNS = 5;

function listView(source: Manifest): ListView {
  const view = source.app.views[0];
  if (view === undefined || view.type !== "list_view") {
    throw new Error("fixture broken");
  }
  return view;
}

/**
 * N 行を決定的に生成する(seed 不要・値は単純な連番)。同じ N なら常に同じデータ。
 * 値は型ごとに単純にし、セルの表示分岐(FieldValue)を一通り通す。
 *
 * **【V3-M2-T05 で関数名だけを直した。主張は1バイトも変えていない】** 旧記述は
 * `FieldCell` だった。`V3-M2-T02` が軸1(列の寄せ)を当てるために `<td>` の器を
 * `ListViewRenderer` 側へ移したので、**このベンチは `FieldCell` を1度も通らない** ——
 * `ListViewRenderer.tsx` が import しているのは `FieldValue` だけである(実読で確認)。
 * `FieldCell` の現在の唯一の呼び出し元は `DetailViewRenderer` の `related` の子一覧である。
 */
function makeRows(n: number): RecordRow[] {
  const rows: RecordRow[] = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      _id: `rec-${i}`,
      _created_at: "2026-01-01T00:00:00Z",
      _updated_at: "2026-01-01T00:00:00Z",
      f_text: `text-${i}`,
      f_num: i,
      f_bool: i % 2 === 0,
      f_date: "2026-07-21",
      f_select: i % 2 === 0 ? "alpha" : "beta",
    });
  }
  return rows;
}

let originalFetch: typeof fetch;
let entryRecords: RecordRow[];

beforeEach(() => {
  entryRecords = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/tables/rows/records")) {
      return new Response(JSON.stringify({ records: entryRecords }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ errors: [{ path: "", message: `no stub for ${url}` }] }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

/**
 * N 行をレンダし、全 N 行が `<tr>` として DOM に載るまでの時間を測る。
 * 返り値はミリ秒(`performance.now()` の差)。レンダ確定は「list-row が N 個」で待つ。
 */
async function renderAndTime(source: Manifest, n: number): Promise<number> {
  const start = performance.now();
  render(<ListViewRenderer appId={APP_ID} manifest={source} view={listView(source)} />);
  await waitFor(
    () => {
      expect(screen.getAllByTestId("list-row").length).toBe(n);
    },
    // interval を小さくして waitFor のポーリング量子化ノイズを抑える。timeout は
    // N=10000 が happy-dom で数秒かかりうるので広めに取る。
    { interval: 1, timeout: 120000 },
  );
  return performance.now() - start;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
    : (sorted[mid] as number);
}

describe("質的不変量: 全行が DOM 化される(仮想スクロール無しの証拠)", () => {
  for (const n of [100, 1000]) {
    test(`N=${n} 行を渡すと行要素(list-row)が N 個描画される`, async () => {
      entryRecords = makeRows(n);
      await renderAndTime(manifest(), n);
      expect(screen.getAllByTestId("list-row").length).toBe(n);
      // ヘッダ行を含めた <tr> は N+1(thead の1行)。
      expect(screen.getAllByRole("row").length).toBe(n + 1);
    });
  }
});

describe("DOM 描画コストの桁計測(happy-dom・実ブラウザ layout ではない)", () => {
  const SAMPLES = 5;

  // N=10000 は 5 sample × 数秒/回 で bun 既定の 5s テストタイムアウトを超えるため、
  // このブロックの各テストに広いタイムアウトを与える(第3引数)。
  for (const n of [100, 1000, 10000]) {
    test(`N=${n}: ${SAMPLES} 回測って桁を記録する`, async () => {
      entryRecords = makeRows(n);
      const samples: number[] = [];
      for (let s = 0; s < SAMPLES; s++) {
        const elapsed = await renderAndTime(manifest(), n);
        // 各 sample で不変量も確認する(N 行 = list-row N 個)。
        expect(screen.getAllByTestId("list-row").length).toBe(n);
        samples.push(elapsed);
        cleanup();
      }
      const rounded = samples.map((v) => Math.round(v));
      const summary = {
        n,
        columns: COLUMNS,
        cells: n * COLUMNS,
        samples_ms: rounded,
        median_ms: Math.round(median(samples)),
        min_ms: Math.round(Math.min(...samples)),
        max_ms: Math.round(Math.max(...samples)),
        note: "happy-dom(JS DOM)上の React 差分適用+DOM ノード生成のみ。layout/paint は含まない。",
      };
      // 人間可読に(JSON 断片で)出す。ゲート判定はこの中央値と桁を読む。
      console.log(`[list-render-bench] ${JSON.stringify(summary)}`);
    }, 300000);
  }
});
