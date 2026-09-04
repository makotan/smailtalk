/**
 * コードの島のサンドボックス実行機構(V1-M6-T03 / ADR-0023・ADR-0024)。
 *
 * **このタスクのスコープは「実行機構」だけである。** コード + 入力 + 制限を受け取り、
 * QuickJS-in-WASM(`quickjs-emscripten`)で安全に実行し、構造化結果を返す。
 * capability の接続は T04、マニフェスト / 差分への統合は T05 が行う。
 *
 * 設計の下敷きは `scripts/m6-poc/poc-quickjs.ts`(getQuickJS / newRuntime / newContext /
 * setInterruptHandler / setMemoryLimit / newFunction / callFunction / dump / dispose の
 * 実動する使い方・OOM 後の safeDispose・interrupt での中断が実測済み)。
 *
 * ## ADR に対応する安全性の担保
 *
 * - **アンビエント権限ゼロ**(ADR-0023 §Decision の決め手 = CP-V1-4 の構造的担保):
 *   島は既定で `fetch` / `require` / `process` / `Bun` に一切届かない。危険物を1つも注入しない。
 *   外部到達は `hostFunctions` で明示注入した関数**だけ**(T04 の前方互換の口。T03 は既定で空)。
 * - **CPU / 実行時間**(ADR-0023 B2): QuickJS は同期実行なので、interruptHandler の deadline
 *   1本で「CPU 時間」も「実行時間」も同時に担保する(PoC 実測: 500.6ms で中断・オーバーラン無し)。
 * - **メモリ**(ADR-0023 B3 / T03 引き継ぎ限界1): `setMemoryLimit` は QuickJS 追跡ヒープ
 *   (オブジェクト・文字列)には強制されるが、**TypedArray / ArrayBuffer のバッキングは計上されず**
 *   ~2GB の WASM 線形メモリ上限まで膨らむ(PoC 実測 host RSS 2044MB)。**そこで `maxInputBytes` で
 *   入力サイズを入口から制限し、巨大 TypedArray の材料になりうる大入力を弾く**(この二段構えで
 *   ADR-0023 の TypedArray 限界を塞ぐ)。
 * - **後始末**(ADR-0023 T03 引き継ぎ限界2): OOM 直後の `dispose` / `JS_FreeRuntime` が
 *   WASM abort(catchable な RuntimeError)を投げうる。**safeDispose(try/catch 吸収)**で
 *   どの失敗経路でもホストプロセスが死なず、ランタイムがリークしないようにする。
 *
 * 既存カーネルの作法に倣い、結果は `status: "success" | "failure"` のオブジェクトで返す
 * (`src/kernel/ai-dispatcher.ts`)。**throw でホストを殺さない。**
 */

import type { QuickJSContext, QuickJSHandle, QuickJSWASMModule } from "quickjs-emscripten";
import { getQuickJS, getQuickJSSync } from "quickjs-emscripten";

/** 島の実行制限。 */
export type IslandLimits = {
  /** CPU 時間 = 実行時間。QuickJS は同期なので interruptHandler の deadline で両方を担保する。 */
  timeoutMillis: number;
  /** QuickJS 追跡ヒープの上限(`setMemoryLimit`)。 */
  memoryBytes: number;
  /**
   * 入力サイズ(JSON 化後のバイト数)の上限。ADR-0023 の「TypedArray バッキングは
   * setMemoryLimit に計上されず ~2GB の WASM 線形メモリ上限まで膨張する」限界を、
   * 入口(=入力サイズ)から塞ぐための天井である。
   */
  maxInputBytes: number;
};

/** 島の実行結果。成功なら出力(JSON 化可能)、失敗なら理由を構造化して返す。 */
export type IslandResult =
  | { status: "success"; output: unknown; elapsedMs: number }
  | {
      status: "failure";
      reason: "timeout" | "memory" | "error" | "input_too_large" | "output_too_large";
      error: string;
      elapsedMs: number;
    };

/**
 * 島の出力サイズの上限(V3-M13-T10 / ADR-0067 限定 A6。**必須。外せない**)。
 *
 * **単位は JSON 直列化後の文字数(UTF-16 code unit)である。** 入力側の `maxInputBytes` が
 * **バイト数**であることとの非対称を隠さない —— **VM の中では UTF-8 のバイト数を安く数える
 * 手段が無い**ためである(ASCII だけの JSON なら両者は一致し、多バイト文字が混ざると
 * この上限はバイトで見て最大3倍まで緩む)。
 *
 * **値は入力側と同じ 1 MiB にした。** 入出力を非対称にする根拠を1つも持っていないからである
 * (「出力はもっと要る / もっと要らない」を1度も測っていない)。
 *
 * **`IslandLimits` に足していない** —— 限定 A9 が `RUN_FUNCTION_LIMITS` の3値を凍結しており、
 * 4つ目の値を足すとその凍結検査に当たる。**モジュール定数にしたことで、上限は呼び出し側の
 * 設定に依らず**すべての島の実行に一様に効く**(fail-closed 側に倒れる)。
 */
const MAX_OUTPUT_CHARS = 1024 * 1024;

/**
 * 島(`code`)を `input` と `limits` のもとで安全に実行し、構造化結果を返す。
 *
 * @param params.code 島のソース。`(input) => ...` の関数式に評価されることを期待する。
 * @param params.input JSON 化可能な入力。JSON 文字列にして VM へ渡す。
 * @param params.limits 実行制限(timeout / memory / 入力サイズ)。
 * @param params.hostFunctions T04(capability 注入)のための前方互換の口。**T03 は既定で
 *   何も注入しない**(アンビエント権限ゼロを保つ)。注入した関数だけが島から到達できる。
 */
export async function runIsland(params: {
  code: string;
  input: unknown;
  limits: IslandLimits;
  hostFunctions?: Record<string, (arg: unknown) => unknown>;
}): Promise<IslandResult> {
  // モジュール取得だけ非同期。実行本体は同期版と**同じ内部関数**を通す(重複実装を避ける)。
  const QuickJS = await getQuickJS();
  return executeIsland(QuickJS, params);
}

/**
 * `runIsland` の**同期版**。契約(引数・返り値)は async 版と同一で、中身も同じ
 * `executeIsland` を通す —— 唯一の違いは QuickJS モジュールを**同期に**取得することである。
 *
 * ## なぜ同期版が要るか(ADR-0024 §Decision / V1-M6-T05 第2段)
 *
 * `run_function`(ワークフローアクション)を実行する `workflow-runner.ts` の発火経路は
 * **すべて同期**である(`runWorkflows` / `runScheduledWorkflow` / `runActions` / `runAction`)。
 * ワークフローの深度上限・再発火抑止はモジュールスコープの `depth` に依存しており、
 * **非同期を持ち込むと2つの発火が同時に走って壊れる**(`workflow-runner.ts` の `depth` の
 * doc が名指しで警告している)。したがって島も**同期に**呼ぶ必要がある。
 *
 * ## 未ロードなら fail-closed(ホストを殺さない)
 *
 * `getQuickJSSync()` は `getQuickJS()` が一度も解決していないと throw する。その場合は
 * 例外を握り、`{ status:"failure", reason:"error" }` を返す(**island runtime not ready**)。
 * ワークフローが発火しうる async 境界(MCP / サーバの起動)で
 * `ensureIslandRuntimeReady()` を先に await しておけば、この経路には入らない。
 */
export function runIslandSync(params: {
  code: string;
  input: unknown;
  limits: IslandLimits;
  hostFunctions?: Record<string, (arg: unknown) => unknown>;
}): IslandResult {
  let QuickJS: QuickJSWASMModule;
  try {
    QuickJS = getQuickJSSync();
  } catch {
    // 未ロード。**同期経路では待てないので fail-closed**(ホストを殺さない)。
    return {
      status: "failure",
      reason: "error",
      error: "island runtime not ready",
      elapsedMs: 0,
    };
  }
  return executeIsland(QuickJS, params);
}

/**
 * 島ランタイム(QuickJS-WASM モジュール)を1回だけロードする(冪等)。
 *
 * `runIslandSync` は同期経路なので、未ロードだと fail-closed するしかない。ワークフローが
 * 発火しうる async 境界(レコード書込・apply_diff を扱う MCP / サーバの起動経路)で
 * これを await しておけば、以後の同期発火経路で `getQuickJSSync()` が確実に成功する。
 * `getQuickJS()` 自体が共有インスタンスをキャッシュするので、複数回呼んでも実体は1つ。
 */
export async function ensureIslandRuntimeReady(): Promise<void> {
  await getQuickJS();
}

/**
 * 島の実行本体(QuickJS モジュールを受け取り、あとは完全に同期)。
 *
 * async 版(`runIsland`)と同期版(`runIslandSync`)の**共通ロジック**をここに括り出す。
 * モジュールの取得方法だけが両者で違い、入力の JSON 化・VM の生成・interrupt/OOM の分類・
 * 出力の正規化・safeDispose はすべてここに1本化する(重複実装を避ける)。
 */
function executeIsland(
  QuickJS: QuickJSWASMModule,
  params: {
    code: string;
    input: unknown;
    limits: IslandLimits;
    hostFunctions?: Record<string, (arg: unknown) => unknown>;
  },
): IslandResult {
  const { code, input, limits, hostFunctions } = params;
  const startedAt = performance.now();
  const elapsed = (): number => Math.round(performance.now() - startedAt);

  // --- 入口: 入力を JSON 化し、サイズ上限で弾く(VM を立てる前に済ませる)-------------
  let inputJson: string;
  try {
    const serialized = JSON.stringify(input === undefined ? null : input);
    // JSON.stringify は undefined / 関数 / シンボルに対して undefined を返すことがある。
    inputJson = serialized === undefined ? "null" : serialized;
  } catch (e) {
    return {
      status: "failure",
      reason: "error",
      error: `入力を JSON 化できません: ${message(e)}`,
      elapsedMs: elapsed(),
    };
  }
  const inputBytes = Buffer.byteLength(inputJson, "utf8");
  if (inputBytes > limits.maxInputBytes) {
    return {
      status: "failure",
      reason: "input_too_large",
      error: `入力が上限(${limits.maxInputBytes} bytes)を超えています: ${inputBytes} bytes`,
      elapsedMs: elapsed(),
    };
  }

  // --- VM を1回の呼び出し専用に立てる(呼び出しごとに使い捨て = 隔離とグローバル汚染の遮断)---
  const rt = QuickJS.newRuntime();
  rt.setMemoryLimit(limits.memoryBytes);

  // deadline 方式の interruptHandler。予算超過で true を返し中断させる。
  // interrupt で止めたことを `interrupted` フラグで確実に判別する(OOM と取り違えない)。
  const deadline = Date.now() + limits.timeoutMillis;
  let interrupted = false;
  rt.setInterruptHandler(() => {
    if (Date.now() > deadline) {
      interrupted = true;
      return true;
    }
    return false;
  });

  const ctx = rt.newContext();
  try {
    // capability 注入(T04 の前方互換の口)。T03 は hostFunctions 未指定 = 何も注入しない。
    injectHostFunctions(ctx, hostFunctions);

    // 1. 島のコードを評価して関数値を得る。
    //    **AI は入口関数を多様な形で書く**(実地検証 V1-M6-T05 で観測): 式 `(input)=>...` /
    //    宣言 `function main(input){}` / 既定エクスポート `export default function(input){}`。
    //    どれも「入力を1つ受け取る関数」を意図している。式形しか受けないと実行時に失敗する
    //    (最初の実地で AI が宣言形、次で export default 形を書き、いずれも弾かれた)。
    //    export 系は **module モードを使わずグローバル代入へ前処理**して受理する(§prepareIslandCode)。
    const fnResult = ctx.evalCode(prepareIslandCode(code));
    if (fnResult.error) {
      return classifyVmError(ctx, fnResult.error, interrupted, elapsed());
    }
    let fn = fnResult.value;
    if (ctx.typeof(fn) !== "function") {
      // 完了値が関数でない(宣言形・エクスポート形)。慣習的な入口を順に探す:
      // __island_default__(export default の前処理先)→ main(宣言名の慣習)。
      fn.dispose();
      const entry = findIslandEntry(ctx);
      if (entry === null) {
        return {
          status: "failure",
          reason: "error",
          error:
            "島のコードは、入力を1つ受け取る関数である必要があります。次のいずれかの形で書いてください: " +
            "式 `(input) => ...`、宣言 `function main(input) { ... }`、または `export default function(input) { ... }`",
          elapsedMs: elapsed(),
        };
      }
      fn = entry;
    }

    // 2. 入力を VM 内に構築する。JSON 文字列を注入 → VM 内の JSON.parse で組み立てる
    //    (境界越えの値変換を JSON 直列化に集約し、危険物を混ぜない)。
    const inputJsonHandle = ctx.newString(inputJson);
    ctx.setProp(ctx.global, "__islandInputJson__", inputJsonHandle);
    inputJsonHandle.dispose();
    const inputResult = ctx.evalCode("JSON.parse(__islandInputJson__)");
    if (inputResult.error) {
      fn.dispose();
      return classifyVmError(ctx, inputResult.error, interrupted, elapsed());
    }
    const inputHandle = inputResult.value;

    // 3. 島の関数を呼ぶ。無限ループ / メモリ暴走はこの中で interrupt / OOM として現れる。
    const callResult = ctx.callFunction(fn, ctx.undefined, inputHandle);
    fn.dispose();
    inputHandle.dispose();
    if (callResult.error) {
      return classifyVmError(ctx, callResult.error, interrupted, elapsed());
    }

    // 4a. **出力の大きさを VM の中で測る**(V3-M13-T10 / 限定 A6)。
    //
    //     **なぜ host 側で測らないのか。** 壊れるのは次の `ctx.dump` の中だからである ——
    //     `{op,table,target,values:{qty:i}}` を 500,000 件返す島では、`dump` が配列ではなく
    //     **空文字**を返し、それでも `status:"success"` になる(V3-M13-T00 §4-10 / 本タスクで
    //     再現。1292ms / 1283ms)。host に出てきた時点では大きさが 2 バイトなので、host 側で
    //     測っても手遅れである。
    //
    //     **測定が失敗したときは今日の経路へそのまま倒す**(振る舞いを黙って変えない)——
    //     循環参照の出力は今日 `"[object Object]"` になって `success` を返すが、本タスクは
    //     **それを1バイトも変えない**(解いていない別の壊れ方として記録に書く)。
    const outputChars = measureOutputChars(ctx, callResult.value);
    if (outputChars !== null && outputChars > MAX_OUTPUT_CHARS) {
      callResult.value.dispose();
      return {
        status: "failure",
        reason: "output_too_large",
        error: `島の出力が上限(${MAX_OUTPUT_CHARS} 文字)を超えています: ${outputChars} 文字`,
        elapsedMs: elapsed(),
      };
    }

    // 4b. 出力を host 側へ取り出し、JSON 化可能な値に正規化する(関数など非直列化値を落とす)。
    const dumped = ctx.dump(callResult.value);
    callResult.value.dispose();
    let output: unknown;
    try {
      output = JSON.parse(JSON.stringify(dumped === undefined ? null : dumped));
    } catch (e) {
      return {
        status: "failure",
        reason: "error",
        error: `島の出力を JSON 化できません: ${message(e)}`,
        elapsedMs: elapsed(),
      };
    }
    return { status: "success", output, elapsedMs: elapsed() };
  } catch (e) {
    // host 側に伝播した例外(OOM 由来の WASM RuntimeError など)。**ホストを殺さない。**
    if (interrupted) {
      return { status: "failure", reason: "timeout", error: message(e), elapsedMs: elapsed() };
    }
    if (isOutOfMemory(message(e)) || (e instanceof Error && e.name === "RuntimeError")) {
      return { status: "failure", reason: "memory", error: message(e), elapsedMs: elapsed() };
    }
    return { status: "failure", reason: "error", error: message(e), elapsedMs: elapsed() };
  } finally {
    // OOM 直後の dispose が WASM abort を投げうる。ctx / rt を独立に吸収し、
    // ctx の失敗で rt.dispose を落とさない(= ランタイムをリークさせない)。
    safeDispose(ctx, rt);
  }
}

/**
 * 出力を VM の中で JSON 直列化し、その**文字数**を返す(V3-M13-T10 / ADR-0067 限定 A6)。
 *
 * 測れなければ `null` を返す —— **測れないことを失敗にしない。** 循環参照・直列化不能値・
 * interrupt など、測定そのものが失敗する経路は今日の振る舞い(`ctx.dump` へ進む)に倒す。
 * **上限は「大きすぎることが分かったときにだけ」効く。**
 *
 * host 側へ運ぶのは**長さの数値1つだけ**である(直列化した文字列そのものは VM に置いたまま
 * 捨てる)—— 24 MB の文字列を境界越えさせないためである。
 */
function measureOutputChars(ctx: QuickJSContext, value: QuickJSHandle): number | null {
  ctx.setProp(ctx.global, "__islandOutput__", value);
  const measured = ctx.evalCode(
    "(() => { try { const s = JSON.stringify(__islandOutput__); return typeof s === 'string' ? s.length : -1; } catch (e) { return -1; } })()",
  );
  if (measured.error) {
    measured.error.dispose();
    return null;
  }
  const length = ctx.dump(measured.value);
  measured.value.dispose();
  return typeof length === "number" && length >= 0 ? length : null;
}

/**
 * VM 内で発生したエラー(evalCode / callFunction の `error`)を分類する。
 *
 * 優先順は timeout(interrupt フラグ)→ memory(OOM メッセージ)→ error。
 * interrupt は handler が立てたフラグで確実に判別し、OOM のメッセージ("out of memory")と
 * 取り違えない。エラー本体の読み出しは OOM 直後に失敗しうるので try/catch で守る。
 */
function classifyVmError(
  ctx: QuickJSContext,
  errorHandle: QuickJSHandle,
  interrupted: boolean,
  elapsedMs: number,
): IslandResult {
  let text = "";
  try {
    const dumped = ctx.dump(errorHandle) as { name?: unknown; message?: unknown } | unknown;
    if (dumped && typeof dumped === "object" && "message" in dumped) {
      const d = dumped as { name?: unknown; message?: unknown };
      text = `${String(d.name ?? "Error")}: ${String(d.message ?? "")}`;
    } else {
      text = String(dumped);
    }
  } catch {
    text = "(エラーオブジェクトを読み出せませんでした)";
  } finally {
    try {
      errorHandle.dispose();
    } catch {
      // OOM 直後は handle 破棄も失敗しうる。吸収する。
    }
  }

  if (interrupted) {
    return {
      status: "failure",
      reason: "timeout",
      error: text || "実行が時間制限を超えました",
      elapsedMs,
    };
  }
  if (isOutOfMemory(text)) {
    return { status: "failure", reason: "memory", error: text, elapsedMs };
  }
  return { status: "failure", reason: "error", error: text, elapsedMs };
}

/** QuickJS の OOM は `InternalError: out of memory`(実測)。 */
function isOutOfMemory(text: string): boolean {
  return /out of memory/i.test(text);
}

/**
 * ctx / rt を防御的に破棄する。
 *
 * ADR-0023 T03 引き継ぎ限界2: OOM 直後の `JS_FreeRuntime` が internal assertion で
 * WASM abort(catchable な RuntimeError)を投げうる。**ctx と rt を独立の try/catch で
 * 破棄し、ctx.dispose が投げても必ず rt.dispose を試みる**(ランタイムをリークさせない)。
 */
function safeDispose(ctx: QuickJSContext, rt: { dispose(): void }): void {
  try {
    ctx.dispose();
  } catch {
    // 吸収(ホストを殺さない)。
  }
  try {
    rt.dispose();
  } catch {
    // 吸収(ホストを殺さない)。
  }
}

/**
 * capability のブリッジ関数を島へ注入する(T04 の前方互換の口)。
 *
 * **T03 は `hostFunctions` 未指定 = 何も注入しない**(アンビエント権限ゼロ)。注入した名前だけが
 * 島の global に生え、それ以外の外部到達手段は存在しない(足し算で権限を与える)。引数は host へ
 * dump し、戻り値は VM 値へ組み立て直す。
 */
function injectHostFunctions(
  ctx: QuickJSContext,
  hostFunctions: Record<string, (arg: unknown) => unknown> | undefined,
): void {
  if (hostFunctions === undefined) {
    return;
  }
  for (const [name, fn] of Object.entries(hostFunctions)) {
    const handle = ctx.newFunction(name, (argHandle) => {
      const arg = argHandle === undefined ? undefined : ctx.dump(argHandle);
      const ret = fn(arg);
      return toVmHandle(ctx, ret);
    });
    ctx.setProp(ctx.global, name, handle);
    handle.dispose();
  }
}

/** host 値を VM の値(handle)へ組み立てる。JSON 化可能な木を対象にする。 */
function toVmHandle(ctx: QuickJSContext, value: unknown): QuickJSHandle {
  if (value === null || value === undefined) {
    return ctx.undefined;
  }
  switch (typeof value) {
    case "number":
      return ctx.newNumber(value);
    case "string":
      return ctx.newString(value);
    case "boolean":
      return value ? ctx.true : ctx.false;
    case "object": {
      if (Array.isArray(value)) {
        const arr = ctx.newArray();
        value.forEach((element, index) => {
          const child = toVmHandle(ctx, element);
          ctx.setProp(arr, index, child);
          disposeIfFresh(ctx, child);
        });
        return arr;
      }
      const obj = ctx.newObject();
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        const child = toVmHandle(ctx, val);
        ctx.setProp(obj, key, child);
        disposeIfFresh(ctx, child);
      }
      return obj;
    }
    default:
      // function / symbol / bigint は JSON 化できないので undefined として扱う。
      return ctx.undefined;
  }
}

/** 新規に作った handle だけ破棄する(ctx.undefined / true / false は共有 handle なので触らない)。 */
function disposeIfFresh(ctx: QuickJSContext, handle: QuickJSHandle): void {
  if (handle !== ctx.undefined && handle !== ctx.true && handle !== ctx.false) {
    handle.dispose();
  }
}

/**
 * 島のコードの `export` 形を、module モードを使わずに評価できる形へ前処理する。
 *
 * QuickJS の既定(global)eval は `export` を素直に扱えない。module モードは名前空間の
 * 取り出しが版依存で fiddly なので採らず、**文字列の前処理**で吸収する:
 * - `export default <式>` → `globalThis.__island_default__ = <式>`(既定エクスポートを既知の
 *   グローバルへ代入する。`export default function(input){}` も `export default (input)=>...` も通る)。
 * - 残る `export`(`export function main(){}` / `export const f = ...` 等)は宣言に落とす(キーワード除去)。
 * これで式 / 宣言 / export default / export 宣言のいずれの形でも入口関数を取り出せる。
 */
function prepareIslandCode(code: string): string {
  const withDefault = code.replace(/export\s+default\s+/, "globalThis.__island_default__ = ");
  return withDefault.replace(/\bexport\s+(?=(?:async\s+)?(?:function|const|let|var|class)\b)/g, "");
}

/**
 * 完了値が関数でないとき、慣習的な入口を順に探す(見つからなければ null)。
 * `__island_default__`(export default の前処理先)→ `main`(宣言名の慣習)の順。
 * **見つけた handle は呼び出し側が dispose する。**探索中に外した handle はここで dispose する。
 */
function findIslandEntry(ctx: QuickJSContext): QuickJSHandle | null {
  for (const name of ["__island_default__", "main"]) {
    const handle = ctx.getProp(ctx.global, name);
    if (ctx.typeof(handle) === "function") {
      return handle;
    }
    handle.dispose();
  }
  return null;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
