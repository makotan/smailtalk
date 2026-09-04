/**
 * **支援技術で使えるかの計測**(`V4-M15-T13`。`P-G51`)。
 *
 * ## 何をするスクリプトか
 *
 * **`scripts/cp-v4/t13-probe.ts` が採った計測 JSON を2本読み、支援技術に関わる属性を
 * 数えて差を出す。** **合否を1つも判定しない。**
 *
 * **【禁止】結果を `CP-V4-UI` の合否の下限に使わない**(`D-V4-14` / `D-V4-25`)。
 * **【禁止】「支援技術で使えるようになった」と書かない**(`03:1412`)。
 * **書けるのは「何を測り、何が変わったか」までである。**
 *
 * ## この計測が言えないこと(**先に書く。憲法6**)
 *
 * 1. **これは支援技術での操作の実測ではない。** スクリーンリーダも読み上げ順も1度も試していない。
 *    数えているのは**属性の有無**だけである。
 * 2. **見ているのは `t13-probe.ts` の計測点に当たった要素だけ**であり、画面全体の DOM ではない。
 *    計測点は52走行で 1,864 レコード(うち当たったのが 1,290)である。
 * 3. **属性が在ることと、その値が正しいことは別である。** `aria-label` が空文字でも1件と数える。
 * 4. **`axe` などの検査器を1つも使っていない。** 規格への適合を1つも判定していない。
 *
 * ## 使い方
 *
 * ```
 * mise exec -- bun run scripts/cp-v4/t19-a11y.ts \
 *     docs/evidence/cp-v4-ui/t13-measurements-before.json \
 *     docs/evidence/cp-v4-ui/t13-measurements-after.json \
 *     docs/evidence/cp-v4-ui/t19-a11y.json
 * ```
 *
 * > **【2026-08-04 追記(`V4-M52` / ユーザ決定 `D-V4-178`)】** **上のコマンドが入力に名指ししている
 * > `docs/evidence/cp-v4-ui/t13-measurements-before.json` と `t13-measurements-after.json` は、
 * > `V4-M30`(ユーザ決定 `D-V4-112`)が 2026-08-04 に作業ツリーから削除した**(削除コミット
 * > **`7e3738b`**)。**したがって上のコマンドは、今日そのまま貼っても入力ファイルが無くて走らない。**
 * > **今日の正**: **本スクリプトの出力 `docs/evidence/cp-v4-ui/t19-a11y.json`(2,011 B)は今日も実在し、
 * > その集計は `docs/plan/v4/records/v4-m17-measure.md` §6 に在る。**
 * > **走らせ直す手順**: 先に生値を取り出す ——
 * > `git show f9c9eef:docs/evidence/cp-v4-ui/t13-measurements-before.json > <任意の場所>/t13-measurements-before.json`
 * > (3,942,532 B)/ `git show cd073bf:docs/evidence/cp-v4-ui/t13-measurements-after.json > <任意の場所>/t13-measurements-after.json`
 * > (4,306,734 B)。**本スクリプトは入出力パスを `process.argv` から受け取り既定値を1つも持たないので、
 * > 取り出し先を渡せばそのまま走る**(`docs/plan/v4/records/v4-m30.md` §4-5)。
 * > **あるいは `scripts/cp-v4/t13-probe.ts` を `--label before` / `--label after` で走らせ直せば、生値は作り直せる。**
 * > **本追記はコメントだけであり、本スクリプトの動作を1バイトも変えていない。**
 */

import { readFileSync, writeFileSync } from "node:fs";

/** 数える対象。**この列挙を増減させると分母が動く。着手前と着手後で同じでなければならない。** */
export const A11Y_KEYS = [
  "role",
  "aria-label",
  "aria-labelledby",
  "aria-describedby",
  "aria-current",
  "aria-selected",
  "aria-expanded",
  "aria-invalid",
  "aria-live",
  "aria-hidden",
  "aria-modal",
  "aria-sort",
  "alt",
  "title",
  "for",
  "scope",
  "tabindex",
  "disabled",
  "required",
  "lang",
] as const;

export type A11yKey = (typeof A11Y_KEYS)[number];

export type A11yCounts = Record<string, number>;

type Probe = { found?: boolean; attrs?: Record<string, string> };
type ScreenResult = { probes?: Record<string, Probe> };
type Measurement = { label?: string; results?: ScreenResult[] };

/**
 * 1本の計測 JSON から、支援技術に関わる属性の出現数を数える。
 *
 * **数えるのは「当たった計測点のうち、その属性を持つものの数」である。**
 * **同じ属性が1要素に複数あることは無いので、要素数と一致する。**
 */
export function countA11yAttributes(measurement: Measurement): A11yCounts {
  const counts: A11yCounts = {};
  for (const key of A11Y_KEYS) {
    counts[key] = 0;
  }
  counts["__probes_found"] = 0;
  for (const result of measurement.results ?? []) {
    for (const probe of Object.values(result.probes ?? {})) {
      if (probe.found !== true) continue;
      counts["__probes_found"] = (counts["__probes_found"] ?? 0) + 1;
      const attrs = probe.attrs ?? {};
      for (const key of A11Y_KEYS) {
        if (Object.hasOwn(attrs, key)) {
          counts[key] = (counts[key] ?? 0) + 1;
        }
      }
    }
  }
  return counts;
}

/** 2つの計数の差。**増減の判断を1つも含まない**(良い・悪いを付けない)。 */
export function diffCounts(before: A11yCounts, after: A11yCounts): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    out[key] = (after[key] ?? 0) - (before[key] ?? 0);
  }
  return out;
}

function main(): void {
  const [beforePath, afterPath, outPath] = process.argv.slice(2);
  if (beforePath === undefined || afterPath === undefined || outPath === undefined) {
    console.error(
      "使い方: bun run scripts/cp-v4/t19-a11y.ts <before.json> <after.json> <out.json>",
    );
    process.exit(2);
    return;
  }
  const before = JSON.parse(readFileSync(beforePath, "utf-8")) as Measurement;
  const after = JSON.parse(readFileSync(afterPath, "utf-8")) as Measurement;
  const beforeCounts = countA11yAttributes(before);
  const afterCounts = countA11yAttributes(after);
  const payload = {
    note: "合否を1つも判定しない。属性の有無を数えただけである。支援技術での操作は1度も試していない。",
    keys: [...A11Y_KEYS],
    before: { label: before.label ?? beforePath, counts: beforeCounts },
    after: { label: after.label ?? afterPath, counts: afterCounts },
    delta: diffCounts(beforeCounts, afterCounts),
  };
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  for (const key of ["__probes_found", ...A11Y_KEYS]) {
    const b = beforeCounts[key] ?? 0;
    const a = afterCounts[key] ?? 0;
    console.log(`${key}\tbefore=${b}\tafter=${a}\tdelta=${a - b}`);
  }
}

if (import.meta.main) {
  main();
}
