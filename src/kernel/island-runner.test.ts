import { describe, expect, test } from "bun:test";
import { type IslandLimits, runIsland } from "./island-runner.ts";

/**
 * コードの島のサンドボックス実行機構(V1-M6-T03 / ADR-0023・ADR-0024)。
 *
 * **本物の QuickJS-WASM で走らせる。モックでサンドボックスを偽装しない。**
 * PoC(`scripts/m6-poc/poc-quickjs.ts`)が実測した挙動 —— interrupt での中断・
 * setMemoryLimit での OOM・アンビエント権限ゼロ・OOM 後の safeDispose・ホスト無傷 ——
 * を、実行機構 `runIsland` の契約として固定する。
 *
 * 完了条件(検証方法)はこのファイルの各テストである。とりわけ最後の
 * 「一連の悪性実行のあと、最後にもう一度正常関数が動く」がホストプロセスの健全性
 * (CP-V1-6「島は暴走できず、ホストを止められない」)の担保である。
 */

/** ふつうの実行に十分な制限。個別テストで timeout / memory / input を絞る。 */
const LIMITS: IslandLimits = {
  timeoutMillis: 1000,
  memoryBytes: 64 * 1024 * 1024,
  maxInputBytes: 1_000_000,
};

describe("runIsland: 正常系", () => {
  test("正常関数が正しい出力を返す((input)=>input.x*2, {x:21} -> 42)", async () => {
    const r = await runIsland({
      code: "(input) => input.x * 2",
      input: { x: 21 },
      limits: LIMITS,
    });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.output).toBe(42);
      expect(typeof r.elapsedMs).toBe("number");
      expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
    }
  });

  test("オブジェクト・配列の出力も JSON 化可能な値として返る", async () => {
    const r = await runIsland({
      code: "(input) => ({ sum: input.a + input.b, items: [input.a, input.b] })",
      input: { a: 2, b: 3 },
      limits: LIMITS,
    });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.output).toEqual({ sum: 5, items: [2, 3] });
    }
  });
});

describe("runIsland: リソース制限とホスト健全性", () => {
  test("無限ループが timeout で停止し、その後に正常関数がまた動く(ホスト健全)", async () => {
    const loop = await runIsland({
      code: "(input) => { while (true) {} }",
      input: {},
      limits: { ...LIMITS, timeoutMillis: 300 },
    });
    expect(loop.status).toBe("failure");
    if (loop.status === "failure") {
      expect(loop.reason).toBe("timeout");
    }

    // ホストは無傷:直後に正常関数がまた動く。
    const ok = await runIsland({
      code: "(input) => input.x + 1",
      input: { x: 41 },
      limits: LIMITS,
    });
    expect(ok.status).toBe("success");
    if (ok.status === "success") {
      expect(ok.output).toBe(42);
    }
  });

  test("メモリ暴走が memory で停止し、ホスト健全", async () => {
    const blow = await runIsland({
      // 追跡ヒープ(plain object)の暴走。setMemoryLimit で OOM する。
      code: "(input) => { const a = []; while (true) { a.push({ p: 1, q: 2, r: 3, s: 'zzzzzzzzzz' }); } }",
      input: {},
      // OOM が先に起きるよう timeout は余裕を持たせる。
      limits: { timeoutMillis: 5000, memoryBytes: 16 * 1024 * 1024, maxInputBytes: 1_000_000 },
    });
    expect(blow.status).toBe("failure");
    if (blow.status === "failure") {
      expect(blow.reason).toBe("memory");
    }

    // OOM 後も safeDispose でホストは無傷:正常関数が動く。
    const ok = await runIsland({ code: "(input) => 42", input: {}, limits: LIMITS });
    expect(ok.status).toBe("success");
    if (ok.status === "success") {
      expect(ok.output).toBe(42);
    }
  });

  test("巨大入力が input_too_large で入口から弾かれる(ADR-0023 の ~2GB TypedArray 限界を塞ぐ)", async () => {
    const big = "a".repeat(2000);
    const r = await runIsland({
      code: "(input) => input.length",
      input: big,
      limits: { ...LIMITS, maxInputBytes: 1000 },
    });
    expect(r.status).toBe("failure");
    if (r.status === "failure") {
      expect(r.reason).toBe("input_too_large");
    }
  });

  test("sleep/長時間のビジー実行も timeout の deadline で停止する", async () => {
    const r = await runIsland({
      // setTimeout は無い(アンビエントゼロ)。ビジーに時間を食う。
      code: "(input) => { let s = 0; for (let i = 0; i < 1e12; i++) { s += i; } return s; }",
      input: {},
      limits: { ...LIMITS, timeoutMillis: 200 },
    });
    expect(r.status).toBe("failure");
    if (r.status === "failure") {
      expect(r.reason).toBe("timeout");
    }
  });
});

describe("runIsland: 隔離とアンビエント権限ゼロ", () => {
  test("グローバル汚染が次の呼び出しに漏れない(呼び出しごとに newRuntime/newContext)", async () => {
    const pollute = await runIsland({
      code: "(input) => { globalThis.__pollution__ = 12345; return 'set'; }",
      input: {},
      limits: LIMITS,
    });
    expect(pollute.status).toBe("success");

    const check = await runIsland({
      code: "(input) => typeof globalThis.__pollution__",
      input: {},
      limits: LIMITS,
    });
    expect(check.status).toBe("success");
    if (check.status === "success") {
      expect(check.output).toBe("undefined");
    }
  });

  test("アンビエント権限ゼロ(fetch/require/process/Bun が undefined。CP-V1-4 の構造的担保)", async () => {
    const r = await runIsland({
      code: `(input) => ({
        fetch: typeof fetch,
        require: typeof require,
        process: typeof process,
        Bun: typeof Bun,
        globalThisBun: typeof globalThis.Bun,
      })`,
      input: {},
      limits: LIMITS,
    });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.output).toEqual({
        fetch: "undefined",
        require: "undefined",
        process: "undefined",
        Bun: "undefined",
        globalThisBun: "undefined",
      });
    }
  });
});

describe("runIsland: 例外・不正コード(ホストを殺さない)", () => {
  test("島が throw すると error で捕捉されホスト無傷", async () => {
    const r = await runIsland({
      code: "(input) => { throw new Error('boom'); }",
      input: {},
      limits: LIMITS,
    });
    expect(r.status).toBe("failure");
    if (r.status === "failure") {
      expect(r.reason).toBe("error");
      expect(r.error).toContain("boom");
    }
  });

  test("構文エラーのコードは error で捕捉される", async () => {
    const r = await runIsland({
      code: "(input) => { this is @@@ not valid",
      input: {},
      limits: LIMITS,
    });
    expect(r.status).toBe("failure");
    if (r.status === "failure") {
      expect(r.reason).toBe("error");
    }
  });

  test("関数に評価されないコードも error になる", async () => {
    const r = await runIsland({ code: "42", input: {}, limits: LIMITS });
    expect(r.status).toBe("failure");
    if (r.status === "failure") {
      expect(r.reason).toBe("error");
    }
  });
});

describe("runIsland: 関数式と関数宣言の両方を受理する(V1-M6-T05 実地検証で露呈)", () => {
  // 実地検証で AI の最初のコードが `function main(input){}` の**宣言形**で、式形しか
  // 受け付けないと実行時に失敗した(スナップショット名: d-003-fix-function-expression)。
  test("関数宣言 function main(input){...} を受理して呼ぶ", async () => {
    const r = await runIsland({
      code: "function main(input) { return input.x * 2; }",
      input: { x: 21 },
      limits: LIMITS,
    });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.output).toBe(42);
    }
  });

  test("関数式 (input)=>... は従来どおり受理する", async () => {
    const r = await runIsland({ code: "(input) => input.x * 2", input: { x: 21 }, limits: LIMITS });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.output).toBe(42);
    }
  });

  test("export default function(input){...}(既定エクスポート形)を受理する", async () => {
    const r = await runIsland({
      code: "export default function (input) { return input.x * 2; }",
      input: { x: 21 },
      limits: LIMITS,
    });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.output).toBe(42);
    }
  });

  test("export default (input)=>...(既定エクスポートのアロー)を受理する", async () => {
    const r = await runIsland({
      code: "export default (input) => input.x * 2",
      input: { x: 21 },
      limits: LIMITS,
    });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.output).toBe(42);
    }
  });

  test("main でない宣言だけのコードは error(入口が無い)", async () => {
    const r = await runIsland({
      code: "function other(input) { return 1; }",
      input: {},
      limits: LIMITS,
    });
    expect(r.status).toBe("failure");
    if (r.status === "failure") {
      expect(r.reason).toBe("error");
    }
  });
});

describe("runIsland: 完了条件(悪性実行の連打のあともホストが健全)", () => {
  test("一連の悪性実行のあと、最後にもう一度正常関数が動く", async () => {
    // 無限ループ → メモリ暴走 → throw → 構文エラー → 巨大入力 を連打する。
    await runIsland({
      code: "(input) => { while (true) {} }",
      input: {},
      limits: { ...LIMITS, timeoutMillis: 150 },
    });
    await runIsland({
      code: "(input) => { const a = []; while (true) { a.push({ p: 1, s: 'zzzzzzzzzz' }); } }",
      input: {},
      limits: { timeoutMillis: 5000, memoryBytes: 16 * 1024 * 1024, maxInputBytes: 1_000_000 },
    });
    await runIsland({ code: "(input) => { throw new Error('x'); }", input: {}, limits: LIMITS });
    await runIsland({ code: "(((", input: {}, limits: LIMITS });
    await runIsland({
      code: "(input) => input",
      input: "z".repeat(5000),
      limits: { ...LIMITS, maxInputBytes: 100 },
    });

    // ホストプロセスは健全なまま:最後にもう一度正常関数が動く。
    const ok = await runIsland({
      code: "(input) => input.x * 2",
      input: { x: 21 },
      limits: LIMITS,
    });
    expect(ok.status).toBe("success");
    if (ok.status === "success") {
      expect(ok.output).toBe(42);
    }
  });
});

// ============================================================================
// V3-M13-T10 完了条件6: 島の出力サイズの上限(ADR-0067 限定 A6。**必須。外せない**)
//
// **`V3-M13-T00` §4-10 の実測**: `{op,table,target,values:{qty:i}}` を **500,000 件**返す島は
// **`RUN_FUNCTION_LIMITS.timeoutMillis`(1000ms)を超えて完走し、出力が配列ですらなくなり
// (空文字)、しかも `status: "success"` を返した**。**「1件も書かない成功」が履歴に載る形である。**
//
// **上限は `island-runner.ts` の中に置き、`IslandLimits` の3値には1つも足さない**
// (限定 A9 = `RUN_FUNCTION_LIMITS` の3値を1バイトも変えない)。**したがって呼び出し側は
// 1バイトも変えずに、すべての島の呼び出しに一様に効く。**
//
// **測るのは host 側ではなく VM 側である** —— 壊れるのは `ctx.dump` の中であり、host に
// 出てきた時点では既に空文字になっていて大きさを測れない(上の実測)。
// ============================================================================

describe("runIsland: 出力サイズの上限(V3-M13-T10 / ADR-0067 限定 A6)", () => {
  test("上限を超える出力は failure(output_too_large)になり、黙って空にならない", async () => {
    // 1 op あたり約79文字 × 100,000 件 ≒ 7.9M 文字 > 1 MiB。実行時間は上限内(実測 約280ms)。
    const code =
      '(input) => { const a = []; for (let i = 0; i < 100000; i++) { a.push({ op: "update", table: "product", target: "row-" + i, values: { qty: i } }); } return a; }';
    const r = await runIsland({ code, input: null, limits: LIMITS });
    expect(r.status).toBe("failure");
    if (r.status !== "failure") {
      throw new Error("成功してはならない実行が成功しました。");
    }
    expect(r.reason).toBe("output_too_large");
    expect(r.error).toContain("出力");
  });

  test("500,000 件(T00 §4-10 の再現形)も success にならない", async () => {
    const code =
      '(input) => { const a = []; for (let i = 0; i < 500000; i++) { a.push({ op: "update", table: "product", target: "row-" + i, values: { qty: i } }); } return a; }';
    const r = await runIsland({ code, input: null, limits: LIMITS });
    // **上限の新設前は `success` + 出力が空文字だった**(T00 §4-10)。
    expect(r.status).toBe("failure");
  });

  test("上限の内側の出力は今までどおり success で、値も欠けない", async () => {
    const code =
      "(input) => { const a = []; for (let i = 0; i < 1000; i++) { a.push({ i }); } return a; }";
    const r = await runIsland({ code, input: null, limits: LIMITS });
    expect(r.status).toBe("success");
    if (r.status !== "success") {
      throw new Error("失敗してはならない実行が失敗しました。");
    }
    expect(Array.isArray(r.output)).toBe(true);
    expect((r.output as unknown[]).length).toBe(1000);
  });

  test("【解いていない】循環参照の出力は上限の新設後も success のままで、黙って壊れる", async () => {
    // **本タスクは出力サイズ以外の壊れ方を1つも直していない。** `ctx.dump` は循環参照を
    // 文字列 `"[object Object]"` に潰し、`status: "success"` を返す(2026-08-01 実測)。
    // **上限の新設はこの経路を1バイトも変えない** —— VM 側の大きさ測定が失敗したときは、
    // 今日の経路へそのまま倒す(**振る舞いを黙って変えない**)。
    const code = "(input) => { const a = {}; a.self = a; return a; }";
    const r = await runIsland({ code, input: null, limits: LIMITS });
    expect(r.status).toBe("success");
    if (r.status !== "success") {
      throw new Error("失敗してはならない実行が失敗しました。");
    }
    expect(r.output).toBe("[object Object]");
  });
});
