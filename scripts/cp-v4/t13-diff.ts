/**
 * `V4-M17` の**差分計算器**(`D-V4-14`)。**テストではない。判定を1つも下さない。**
 *
 * ## なぜ在るのか
 *
 * 04 §3-14b の阻害(3) の逐語: **「差分計算スクリプトが1本も存在しない。`scripts/cp-v3/` に
 * `t02-verdicts.ts` は無く、git 履歴にも一度も入っていない」** —— v3 が報告した「変化した
 * 計測点303件」を再計算する手段はリポジトリに無かった。**`D-V4-14`(変化を全件記録する)を
 * 履行するには、変化を数える処理が要る。** 本ファイルがそれである。
 *
 * ## 「1件の変化」の定義(**ここで確定させる**。04 §3-14b の阻害(3) が「定義もここで決まる」と書いた分)
 *
 * **1件 = (画面走行, 計測点, 観測項目) の3つ組が1つ**である。画面走行は
 * `screenId|role|width` の3要素で1本と数える(**同じ画面でも役割が違えば別の走行、幅が
 * 違えば別の走行**)。観測項目は次の4種類で、**それぞれ別に数える**:
 *
 * | 種別 | 何を比べるか | 数え方 |
 * |---|---|---|
 * | `css` | `getComputedStyle` の63プロパティ | プロパティ1つで1件 |
 * | `presence` | `found` / `count` / `matchedSelector` / `tag` / `className` | 項目1つで1件 |
 * | `rect` | `getBoundingClientRect` の `x` / `y` / `w` / `h` | 数値1つで1件 |
 * | `text` | `textLength`(**本文そのものは比べない** —— 種データが同じでも並びで揺れるため) | 1件 |
 *
 * **画面単位の観測**(`title` / `page.horizontalOverflow` / `page.scrollWidth` / `domOrder`)は
 * `screen` 種別として別に数える。
 *
 * **【この定義の限界。隠さない】**
 *
 * - **`rect` は本文の長さで揺れる。** 種データを入れ直すと、見た目を1ミリも変えていなくても
 *   `rect` が動きうる。**`rect` の変化を「見た目が変わった」と読んではならない。**
 * - **消えた計測点と現れた計測点は「変化1件」ではなく、`presence` の複数件として出る。**
 *   置き換えで当たり先が全部消えると件数が大きく出る —— **それは「全部消えた」であって
 *   「良くなった」でも「悪くなった」でもない**(04 §3-14b の阻害(4))。
 * - **本スクリプトは合否を判定しない。** `D-V4-14` は「合格ラインは置かない」である。
 *
 * ## 使い方
 *
 * ```
 * mise exec -- bun run scripts/cp-v4/t13-diff.ts <before.json> <after.json> <out.json>
 * ```
 *
 * 標準エラーに要約(種別ごとの件数)を出し、`out.json` に**変化を全件**書く。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type Measured = {
  found: boolean;
  matchedSelector?: string;
  count: number;
  tag?: string;
  className?: string;
  text?: string;
  textLength?: number;
  rect?: { x: number; y: number; w: number; h: number };
  css?: Record<string, string>;
};

type ScreenResult = {
  screenId: string;
  kind: string;
  role: string;
  width: number;
  url: string;
  title: string;
  recordResolved?: boolean;
  page: { scrollWidth: number; clientWidth: number; horizontalOverflow: boolean };
  domOrder: string[];
  probes: Record<string, Measured>;
};

type Measurements = {
  label: string;
  capturedAt: string;
  widths: number[];
  roles: string[];
  props: string[];
  results: ScreenResult[];
};

export type Change = {
  /** `screenId|role|width`。 */
  run: string;
  kind: "css" | "presence" | "rect" | "text" | "screen";
  /** 計測点の名前(`screen` 種別のときは `-`)。 */
  probe: string;
  /** 観測項目の名前(CSS プロパティ名 / `found` / `x` など)。 */
  item: string;
  before: string;
  after: string;
};

const runKey = (entry: ScreenResult): string => `${entry.screenId}|${entry.role}|${entry.width}`;

/** 値を文字列にそろえる(欠落は `(無し)`)。 */
function show(value: unknown): string {
  if (value === undefined) {
    return "(無し)";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

/** 2つの計測を突き合わせ、変化を全件返す。**間引かない。** */
export function diffMeasurements(before: Measurements, after: Measurements): Change[] {
  const changes: Change[] = [];
  const beforeRuns = new Map(before.results.map((entry) => [runKey(entry), entry]));
  const afterRuns = new Map(after.results.map((entry) => [runKey(entry), entry]));
  const allRuns = [...new Set([...beforeRuns.keys(), ...afterRuns.keys()])].sort();

  for (const run of allRuns) {
    const b = beforeRuns.get(run);
    const a = afterRuns.get(run);
    if (b === undefined || a === undefined) {
      changes.push({
        run,
        kind: "screen",
        probe: "-",
        item: "画面走行そのもの",
        before: b === undefined ? "(無し)" : "在り",
        after: a === undefined ? "(無し)" : "在り",
      });
      continue;
    }

    // 画面単位の観測。
    const screenItems: [string, unknown, unknown][] = [
      ["title", b.title, a.title],
      ["page.scrollWidth", b.page.scrollWidth, a.page.scrollWidth],
      ["page.clientWidth", b.page.clientWidth, a.page.clientWidth],
      ["page.horizontalOverflow", b.page.horizontalOverflow, a.page.horizontalOverflow],
      ["domOrder", b.domOrder.join(" > "), a.domOrder.join(" > ")],
      ["recordResolved", b.recordResolved, a.recordResolved],
    ];
    for (const [item, bv, av] of screenItems) {
      if (show(bv) !== show(av)) {
        changes.push({ run, kind: "screen", probe: "-", item, before: show(bv), after: show(av) });
      }
    }

    const probeKeys = [...new Set([...Object.keys(b.probes), ...Object.keys(a.probes)])].sort();
    for (const probe of probeKeys) {
      const bp = b.probes[probe];
      const ap = a.probes[probe];
      if (bp === undefined || ap === undefined) {
        changes.push({
          run,
          kind: "presence",
          probe,
          item: "計測点そのもの",
          before: bp === undefined ? "(無し)" : "在り",
          after: ap === undefined ? "(無し)" : "在り",
        });
        continue;
      }

      const presenceItems: [string, unknown, unknown][] = [
        ["found", bp.found, ap.found],
        ["count", bp.count, ap.count],
        ["matchedSelector", bp.matchedSelector, ap.matchedSelector],
        ["tag", bp.tag, ap.tag],
        ["className", bp.className, ap.className],
      ];
      for (const [item, bv, av] of presenceItems) {
        if (show(bv) !== show(av)) {
          changes.push({
            run,
            kind: "presence",
            probe,
            item,
            before: show(bv),
            after: show(av),
          });
        }
      }

      if (show(bp.textLength) !== show(ap.textLength)) {
        changes.push({
          run,
          kind: "text",
          probe,
          item: "textLength",
          before: show(bp.textLength),
          after: show(ap.textLength),
        });
      }

      for (const axis of ["x", "y", "w", "h"] as const) {
        const bv = bp.rect?.[axis];
        const av = ap.rect?.[axis];
        if (show(bv) !== show(av)) {
          changes.push({ run, kind: "rect", probe, item: axis, before: show(bv), after: show(av) });
        }
      }

      const props = [
        ...new Set([...Object.keys(bp.css ?? {}), ...Object.keys(ap.css ?? {})]),
      ].sort();
      for (const prop of props) {
        const bv = bp.css?.[prop];
        const av = ap.css?.[prop];
        if (show(bv) !== show(av)) {
          changes.push({ run, kind: "css", probe, item: prop, before: show(bv), after: show(av) });
        }
      }
    }
  }
  return changes;
}

/** 種別ごと・画面ごとの件数。**判定ではなく集計である。** */
export function summarize(changes: readonly Change[]): {
  total: number;
  byKind: Record<string, number>;
  byRun: Record<string, number>;
} {
  const byKind: Record<string, number> = {};
  const byRun: Record<string, number> = {};
  for (const change of changes) {
    byKind[change.kind] = (byKind[change.kind] ?? 0) + 1;
    byRun[change.run] = (byRun[change.run] ?? 0) + 1;
  }
  return { total: changes.length, byKind, byRun };
}

function main(): void {
  const [, , beforePath, afterPath, outPath] = process.argv;
  if (beforePath === undefined || afterPath === undefined || outPath === undefined) {
    throw new Error("usage: t13-diff.ts <before.json> <after.json> <out.json>");
  }
  const before = JSON.parse(readFileSync(beforePath, "utf-8")) as Measurements;
  const after = JSON.parse(readFileSync(afterPath, "utf-8")) as Measurements;
  const changes = diffMeasurements(before, after);
  const summary = summarize(changes);

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    `${JSON.stringify(
      {
        beforeLabel: before.label,
        afterLabel: after.label,
        beforeCapturedAt: before.capturedAt,
        afterCapturedAt: after.capturedAt,
        definition:
          "1件 = (画面走行 screenId|role|width, 計測点, 観測項目) の3つ組。種別は css / presence / rect / text / screen。合否は判定しない(D-V4-14)。",
        summary,
        changes,
      },
      null,
      2,
    )}\n`,
  );
  console.error(
    `[t13-diff] ${summary.total} 件の変化(${Object.entries(summary.byKind)
      .map(([kind, count]) => `${kind}=${count}`)
      .join(" / ")})→ ${outPath}`,
  );
}

if (import.meta.main) {
  main();
}
