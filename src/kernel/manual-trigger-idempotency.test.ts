/**
 * `V5-M25-T03`(`L-G10` / [`ADR-0175`](../../docs/adr/0175-manual-trigger-idempotency-and-actor.md))
 * —— **手動起動の「実行中の重複」を拒む規則**の検査。
 *
 * **本ファイルが測るのは規則そのものだけである。** **HTTP の 409 への写像は
 * `src/server/manual-trigger-route.test.ts` が測る**(`ADR-0175` §6-2 の逐語
 * 「重複と判定したら、起動要求を **409** で拒む(入口の応答は `ADR-0176` が定める)」)。
 *
 * **【禁止】本ファイルの緑をもって「二重押しが防げる」と書かない**(`ADR-0175` §限界2)。
 * **防ぐのは実行中の重複だけであり、1本目が終わってから押せば2回目は通る**(限定3。
 * 下の「完了後の再押下は通る」がそれを固定している)。
 */
import { describe, expect, test } from "bun:test";
import manifestSchema from "../../schemas/manifest.schema.json" with { type: "json" };
import { beginManualRun } from "./workflow-runner.ts";

const KEY = { app: "shop", workflow: "ship", record: "r1" } as const;

describe("V5-M25-T03: 実行中の重複を拒む規則(ADR-0175 限定1 / 限定3)", () => {
  test("限定1: 同じ アプリ × ワークフロー × 対象行 の2度目は、実行中のあいだ null を返す", () => {
    const first = beginManualRun(KEY);
    expect(first).not.toBeNull();
    try {
      expect(beginManualRun(KEY)).toBeNull();
      // 2度目が拒まれたあとも、1本目の在席は消えていない(3度目も拒まれる)。
      expect(beginManualRun(KEY)).toBeNull();
    } finally {
      first?.();
    }
  });

  test("限定3: 完了後の再押下は通る(「1回しか押せない」を作らない)", () => {
    const first = beginManualRun(KEY);
    expect(first).not.toBeNull();
    first?.();
    const second = beginManualRun(KEY);
    // **完了していれば普通に通る。** ここが `ADR-0175` §限界2 の「二重押しが防げるわけではない」。
    expect(second).not.toBeNull();
    second?.();
  });

  test("限定1: 3つ組のどれか1つでも違えば、同時でも通る(判定の要素は4つで閉じる)", () => {
    const held = beginManualRun(KEY);
    expect(held).not.toBeNull();
    const others = [
      { ...KEY, app: "other-app" },
      { ...KEY, workflow: "other-workflow" },
      { ...KEY, record: "r2" },
    ].map((key) => beginManualRun(key));
    try {
      for (const release of others) {
        expect(release).not.toBeNull();
      }
    } finally {
      for (const release of others) {
        release?.();
      }
      held?.();
    }
  });

  test("解放を2度呼んでも、あとから始めた別の在席を消さない(冪等な解放)", () => {
    const first = beginManualRun(KEY);
    first?.();
    first?.(); // 2度目の解放。**ここで台帳を壊さない。**
    const second = beginManualRun(KEY);
    expect(second).not.toBeNull();
    // 1本目の解放関数をもう一度呼んでも、2本目の在席は残る。
    first?.();
    expect(beginManualRun(KEY)).toBeNull();
    second?.();
  });

  // **【`V8-M18` / 台帳 `J-G12` による期待値の更新。2026-08-09】** **旧テスト名の逐語**:
  // 「**限定2: アプリ側に宣言を1つも作っていない($defs 28 / $defs/workflow.properties 6)**」。
  // **旧本体の逐語**: `expect(Object.keys(defs)).toHaveLength(28)`。
  // **`ADR-0175` の増分は今日も `$defs` を1本も作っていない** —— **28 → 29 にしたのは
  // `V8-M18` が新設した `role_condition` 1本だけである。****旧文を1バイトも消していない。**
  test("限定2: アプリ側に宣言を1つも作っていない($defs 29 = V8-M18 の1本だけ増えた / $defs/workflow.properties 6)", () => {
    const defs = (manifestSchema as { $defs: Record<string, unknown> }).$defs;
    // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】期待値を 29 → 30 へ書き換えた。**
    // **旧行の逐語**: `expect(Object.keys(defs)).toHaveLength(29);`
    // **書き換えた理由**: この行が固定していたのは「**その決定**が新しい `$defs` を作らなかったこと」
    // であり、**30本目を作ったのは別の決定である**(`V8-M8` が集計表の中身 `$defs/report` を新設した)。
    // **検査は消していない。**
    expect(Object.keys(defs)).toHaveLength(30);
    expect(Object.keys(defs)).toContain("role_condition");
    const workflow = defs.workflow as { properties: Record<string, unknown> };
    // 冪等性を宣言するキーを `$defs/workflow` にも足していない(`ADR-0175` 限定2)。
    expect(Object.keys(workflow.properties)).toEqual([
      "id",
      "name",
      "trigger",
      "actions",
      "history_table",
      "act_as",
    ]);
  });
});
