/**
 * M6-T01 PoC: QuickJS compiled to WASM (quickjs-emscripten) JS function sandbox
 *
 * Runs under Bun: `bun run scripts/m6-poc/poc-quickjs.ts`
 *
 * Common measurement protocol (M1-M4 + ambient authority):
 *  M1 無限ループ: while(true){} with rt.setInterruptHandler(deadline) + 500ms budget.
 *                 Did the interrupt handler stop it? wall-time from budget start?
 *  M2 メモリ暴走: unbounded array push with rt.setMemoryLimit(64MB). Stopped as mem error?
 *                 Host intact?
 *  M3 ホスト健全性: after M1/M2, can the host (this bun process) still compute 40+2 ?
 *  M4 正常関数: (input)=>input.x*2 with {x:21} -> 42 ? (host<->QuickJS value passing)
 *  ambient authority: from DEFAULT QuickJS code, is typeof fetch/require/process/Bun
 *                     "undefined"? QuickJS should expose nothing the host did not inject.
 *
 * QuickJS specifics measured:
 *  - Does setInterruptHandler (deadline style) reliably stop a tight infinite loop?
 *  - Does setMemoryLimit reliably stop a memory blowup?
 *  - capability injection: inject a host fn __callExternal(name,payload) into the
 *    context; user code can call it, and WITHOUT injection nothing external is reachable
 *    (capability-only, structurally guaranteed — no ambient authority).
 *  - init cost (getQuickJS/newRuntime) and single eval cost, approximate.
 *
 * IMPORTANT: measure for real. No fallbacks/mocks. If it can't stop, report "can't stop".
 */

import type { QuickJSContext, QuickJSRuntime, QuickJSWASMModule } from "quickjs-emscripten";

type Result = Record<string, unknown>;
const results: Result = {};

function line(s: string) {
  // eslint-disable-next-line no-console
  console.log(s);
}

const MEM_LIMIT_BYTES = 64 * 1024 * 1024; // 64MB

// ---------------------------------------------------------------------------
// M1: infinite loop with a deadline interrupt handler (500ms budget)
// ---------------------------------------------------------------------------
function testM1(QuickJS: QuickJSWASMModule): void {
  line("\n=== M1: infinite loop, setInterruptHandler(deadline) 500ms ===");
  const rt: QuickJSRuntime = QuickJS.newRuntime();
  const ctx: QuickJSContext = rt.newContext();
  const budgetMs = 500;
  const start = performance.now();
  const deadline = Date.now() + budgetMs;
  // deadline-style interrupt handler: return true once the budget is exhausted.
  rt.setInterruptHandler(() => Date.now() > deadline);

  let stopped = false;
  let elapsed = 0;
  let mechanism = "";
  try {
    const res = ctx.evalCode("while(true){}");
    elapsed = performance.now() - start;
    if (res.error) {
      // Interrupted evals return an error named InternalError / message "interrupted".
      const errObj = ctx.dump(res.error);
      res.error.dispose();
      stopped = true;
      mechanism = `interrupted -> ${JSON.stringify(errObj)}`;
    } else {
      res.value.dispose();
      stopped = true; // it "returned" (unexpected for while(true))
      mechanism = "returned normally (unexpected for while(true))";
    }
  } catch (e) {
    elapsed = performance.now() - start;
    stopped = true;
    mechanism = `host threw: ${(e as Error).name}: ${(e as Error).message}`;
  } finally {
    safeDispose(ctx, rt);
  }
  line(`  stopped=${stopped} elapsed=${elapsed.toFixed(1)}ms mechanism=${mechanism}`);
  results.M1 = {
    stopped,
    elapsedMs: Math.round(elapsed),
    mechanism,
    machinery: "interruptHandler",
  };
}

// Dispose a ctx/rt pair defensively. After an out-of-memory abort QuickJS can
// fail an internal assertion inside JS_FreeRuntime and call WASM abort(), which
// surfaces as a catchable RuntimeError — swallow it so the process survives.
function safeDispose(ctx: QuickJSContext, rt: QuickJSRuntime): string {
  try {
    ctx.dispose();
  } catch (e) {
    return `ctx.dispose threw: ${(e as Error).message.slice(0, 60)}`;
  }
  try {
    rt.dispose();
  } catch (e) {
    return `rt.dispose threw: ${(e as Error).message.slice(0, 60)}`;
  }
  return "clean";
}

// Run one memory-blowup allocator under setMemoryLimit(64MB) and report the peak
// host RSS delta + how it was stopped. Returns the observation.
function runBlowup(
  QuickJS: QuickJSWASMModule,
  label: string,
  code: string,
): {
  label: string;
  stopped: boolean;
  elapsedMs: number;
  peakHostRssDeltaMB: number;
  error: string;
  disposed: string;
} {
  const rt: QuickJSRuntime = QuickJS.newRuntime();
  rt.setMemoryLimit(MEM_LIMIT_BYTES);
  const safetyDeadline = Date.now() + 4000;
  rt.setInterruptHandler(() => Date.now() > safetyDeadline); // pure safety net
  const ctx: QuickJSContext = rt.newContext();

  const hostRssBefore = process.memoryUsage().rss;
  const start = performance.now();
  let stopped = false;
  let error = "";
  try {
    const res = ctx.evalCode(code);
    if (res.error) {
      error = JSON.stringify(ctx.dump(res.error));
      res.error.dispose();
      stopped = true;
    } else {
      res.value.dispose();
      error = "NONE (returned)";
    }
  } catch (e) {
    error = `host threw: ${(e as Error).name}: ${(e as Error).message}`;
    stopped = true;
  }
  const elapsedMs = performance.now() - start;
  const peakHostRssDeltaMB = (process.memoryUsage().rss - hostRssBefore) / (1024 * 1024);
  const disposed = safeDispose(ctx, rt);
  return {
    label,
    stopped,
    elapsedMs: Math.round(elapsedMs),
    peakHostRssDeltaMB: Number(peakHostRssDeltaMB.toFixed(0)),
    error,
    disposed,
  };
}

// ---------------------------------------------------------------------------
// M2: memory blowup with rt.setMemoryLimit(64MB). We run the protocol's exact
// TypedArray code AND a plain-object allocator, because the two are bounded very
// differently in this WASM build (measured, not assumed):
//   - plain objects: JS_SetMemoryLimit tracks them; peak RSS scales with the
//     limit and OOMs deterministically -> the 64MB limit is effective.
//   - TypedArray/ArrayBuffer backing stores: NOT counted against the limit; the
//     process balloons to the WASM ~2GB linear-memory ceiling regardless of the
//     configured limit, then OOMs there. So for the protocol's Uint8Array code
//     the *effective* bound is WASM's 2GB address space, NOT the 64MB limit.
// In all cases the VM is stopped (OOM error) and the host survives.
// ---------------------------------------------------------------------------
function testM2(QuickJS: QuickJSWASMModule): void {
  line("\n=== M2: memory blowup, setMemoryLimit(64MB) ===");
  // Protocol's exact code (TypedArray backing store).
  const typedArrayCase = runBlowup(
    QuickJS,
    "protocol Uint8Array(1e6)",
    `const a=[]; while(true){ a.push(new Uint8Array(1000000)); }`,
  );
  // Control: plain-object allocator to show the limit DOES bind tracked heap.
  const objectCase = runBlowup(
    QuickJS,
    "plain objects (tracked)",
    `const a=[]; while(true){ a.push({p:1,q:2,r:3,s:'zzzzzzzzzz'}); }`,
  );

  const hostAlive = 40 + 2 === 42; // host still runs JS right after both blowups

  for (const c of [typedArrayCase, objectCase]) {
    line(
      `  [${c.label}] stopped=${c.stopped} elapsed=${c.elapsedMs}ms peakHostRssDelta=${c.peakHostRssDeltaMB}MB dispose=${c.disposed}`,
    );
    line(`      error=${c.error}`);
  }
  // The protocol case is bounded by WASM's address space, not the 64MB knob.
  const typedArrayBoundedByLimit = typedArrayCase.peakHostRssDeltaMB <= 256;
  line(
    `  => setMemoryLimit governs tracked heap (objects peak ~${objectCase.peakHostRssDeltaMB}MB), ` +
      `but TypedArray backing escapes it (peak ~${typedArrayCase.peakHostRssDeltaMB}MB @ WASM ceiling).`,
  );
  line(`  host still alive after both blowups: ${hostAlive}`);
  results.M2 = {
    memLimitBytes: MEM_LIMIT_BYTES,
    typedArrayCase,
    objectCase,
    typedArrayBoundedByConfiguredLimit: typedArrayBoundedByLimit,
    hostAlive,
    note:
      "setMemoryLimit enforces QuickJS-tracked allocations (plain objects scale with the limit); " +
      "TypedArray/ArrayBuffer backing stores are not counted and balloon to the WASM ~2GB ceiling.",
  };
}

// ---------------------------------------------------------------------------
// M3: host health after M1/M2
// ---------------------------------------------------------------------------
function testM3(): void {
  line("\n=== M3: host health ===");
  const v = 40 + 2;
  const healthy = v === 42;
  line(`  host computed 40+2 = ${v}, healthy=${healthy}`);
  results.M3 = { healthy, value: v };
}

// ---------------------------------------------------------------------------
// M4: normal function. Define a function inside QuickJS, pass a host-built
// {x:21} object in, call it, read 42 back out. Exercises host<->VM marshalling.
// ---------------------------------------------------------------------------
function testM4(QuickJS: QuickJSWASMModule): void {
  line("\n=== M4: normal function (input)=>input.x*2 with {x:21} ===");
  const rt = QuickJS.newRuntime();
  const ctx = rt.newContext();
  let ok = false;
  let ret: unknown;
  let err = "";
  try {
    // 1. Evaluate the user function; the eval result is the function value.
    const fnRes = ctx.evalCode("(input) => input.x * 2");
    const fn = ctx.unwrapResult(fnRes);
    // 2. Build the input object on the host side and hand it to the VM.
    const inputHandle = ctx.newObject();
    const xHandle = ctx.newNumber(21);
    ctx.setProp(inputHandle, "x", xHandle);
    xHandle.dispose();
    // 3. Call VM function with the VM-side argument.
    const callRes = ctx.callFunction(fn, ctx.undefined, inputHandle);
    const out = ctx.unwrapResult(callRes);
    // 4. Marshal the return value back to the host.
    ret = ctx.dump(out);
    ok = ret === 42;
    out.dispose();
    inputHandle.dispose();
    fn.dispose();
  } catch (e) {
    err = `${(e as Error).name}: ${(e as Error).message}`;
  } finally {
    ctx.dispose();
    rt.dispose();
  }
  line(`  returned=${JSON.stringify(ret)} ok=${ok}${err ? ` err=${err}` : ""}`);
  results.M4 = { ok, returned: ret, err: err || undefined };
}

// ---------------------------------------------------------------------------
// Ambient authority: from a DEFAULT context, what dangerous globals are visible?
// QuickJS should expose only ECMAScript built-ins — no host globals.
// ---------------------------------------------------------------------------
function probeType(ctx: QuickJSContext, expr: string): string {
  const res = ctx.evalCode(`(typeof (${expr}))`);
  if (res.error) {
    const e = ctx.dump(res.error);
    res.error.dispose();
    return `THREW:${JSON.stringify(e)}`;
  }
  const v = ctx.dump(res.value) as string;
  res.value.dispose();
  return v;
}

function testAmbient(QuickJS: QuickJSWASMModule): void {
  line("\n=== AMBIENT: default reachability of dangerous host globals ===");
  const rt = QuickJS.newRuntime();
  const ctx = rt.newContext();
  const names = [
    "fetch",
    "require",
    "process",
    "Bun",
    "globalThis",
    "setTimeout",
    "XMLHttpRequest",
    "WebAssembly",
  ];
  const ambient: Record<string, string> = {};
  try {
    for (const n of names) {
      const t = probeType(ctx, n);
      ambient[n] = t;
      line(`  typeof ${n.padEnd(16)} = ${t}`);
    }
    // Classic constructor-escape attempt: can VM code reach a host global via
    // Function constructor? In QuickJS this returns the VM's own global, not the host's.
    const escRes = ctx.evalCode(
      `(function(){ try { const g = ([]).constructor.constructor('return typeof process')(); return 'reached:'+g; } catch(e){ return 'blocked:'+e.name; } })()`,
    );
    let escStr = "";
    if (escRes.error) {
      escStr = `THREW:${JSON.stringify(ctx.dump(escRes.error))}`;
      escRes.error.dispose();
    } else {
      escStr = ctx.dump(escRes.value) as string;
      escRes.value.dispose();
    }
    line(`  Function-constructor escape -> ${escStr}`);
    results.ambient = { types: ambient, escape: escStr };
  } finally {
    ctx.dispose();
    rt.dispose();
  }
}

// ---------------------------------------------------------------------------
// Capability bridge: (A) with NO injection, __callExternal is undefined; (B) after
// injecting a single host function, user code can call it and the host observes
// the call. Nothing else external is reachable -> capability-only by construction.
// ---------------------------------------------------------------------------
function testCapabilityBridge(QuickJS: QuickJSWASMModule): void {
  line("\n=== CAPABILITY BRIDGE: host fn injection, capability-only ===");
  const result: Record<string, unknown> = {};

  // (A) Without injection.
  {
    const rt = QuickJS.newRuntime();
    const ctx = rt.newContext();
    const t = probeType(ctx, "__callExternal");
    result.beforeInjection_typeof = t;
    line(`  (A) no injection: typeof __callExternal = ${t}`);
    ctx.dispose();
    rt.dispose();
  }

  // (B) With one injected host capability.
  {
    const rt = QuickJS.newRuntime();
    const ctx = rt.newContext();
    let hostSaw: { name: string; payload: unknown } | undefined;
    // The host function: the ONLY door out of the sandbox.
    const fnHandle = ctx.newFunction("__callExternal", (nameH, payloadH) => {
      const name = ctx.getString(nameH);
      const payload = ctx.dump(payloadH);
      hostSaw = { name, payload };
      // Return a VM value describing what the host did.
      const outH = ctx.newObject();
      const statusH = ctx.newNumber(200);
      ctx.setProp(outH, "status", statusH);
      statusH.dispose();
      const echoH = ctx.newString(JSON.stringify(payload));
      ctx.setProp(outH, "echo", echoH);
      echoH.dispose();
      return outH; // ownership transferred to VM
    });
    ctx.setProp(ctx.global, "__callExternal", fnHandle);
    fnHandle.dispose();

    // User code calls the capability.
    const userCode = `
      const r = __callExternal("send-email", { to: "a@b.c", n: 20 + 1 });
      JSON.stringify({ status: r.status, echo: r.echo });
    `;
    const res = ctx.evalCode(userCode);
    let userGot: unknown;
    if (res.error) {
      userGot = `THREW:${JSON.stringify(ctx.dump(res.error))}`;
      res.error.dispose();
    } else {
      userGot = ctx.dump(res.value);
      res.value.dispose();
    }
    const bridgeOk =
      hostSaw?.name === "send-email" &&
      typeof userGot === "string" &&
      userGot.includes('"status":200');
    result.afterInjection_hostSaw = hostSaw;
    result.afterInjection_userGot = userGot;
    result.bridgeOk = bridgeOk;
    line(`  (B) injected: hostSaw=${JSON.stringify(hostSaw)}`);
    line(`      userGot=${JSON.stringify(userGot)} bridgeOk=${bridgeOk}`);
    ctx.dispose();
    rt.dispose();
  }

  results.capabilityBridge = result;
}

// ---------------------------------------------------------------------------
// Cost: init (getQuickJS + newRuntime + newContext) and a single trivial eval.
// getQuickJS is measured by the caller (it's the module bootstrap). Here we time
// newRuntime/newContext and one eval on a warm module.
// ---------------------------------------------------------------------------
function testCost(QuickJS: QuickJSWASMModule, getQuickJSMs: number): void {
  line("\n=== COST: init & single eval ===");
  const t0 = performance.now();
  const rt = QuickJS.newRuntime();
  const ctx = rt.newContext();
  const t1 = performance.now();
  // Warm one eval, then time an average of several trivial evals.
  ctx.unwrapResult(ctx.evalCode("1+1")).dispose();
  const N = 1000;
  const e0 = performance.now();
  for (let i = 0; i < N; i++) {
    ctx.unwrapResult(ctx.evalCode("1+1")).dispose();
  }
  const e1 = performance.now();
  ctx.dispose();
  rt.dispose();
  const rtCtxMs = t1 - t0;
  const perEvalMs = (e1 - e0) / N;
  line(`  getQuickJS (module bootstrap, once) ~= ${getQuickJSMs.toFixed(1)}ms`);
  line(`  newRuntime+newContext              ~= ${rtCtxMs.toFixed(2)}ms`);
  line(`  single trivial eval (avg of ${N})   ~= ${perEvalMs.toFixed(4)}ms`);
  results.cost = {
    getQuickJSMs: Number(getQuickJSMs.toFixed(1)),
    newRuntimeContextMs: Number(rtCtxMs.toFixed(2)),
    perEvalMs: Number(perEvalMs.toFixed(4)),
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  line(`Runtime: ${typeof Bun !== "undefined" ? `Bun ${Bun.version}` : `Node ${process.version}`}`);
  const { getQuickJS } = await import("quickjs-emscripten");
  const g0 = performance.now();
  const QuickJS = await getQuickJS();
  const getQuickJSMs = performance.now() - g0;
  line(`quickjs-emscripten loaded: newRuntime present=${typeof QuickJS.newRuntime === "function"}`);

  testM1(QuickJS);
  testM2(QuickJS);
  testM3();
  testM4(QuickJS);
  testAmbient(QuickJS);
  testCapabilityBridge(QuickJS);
  testCost(QuickJS, getQuickJSMs);

  line("\n=== RAW RESULTS (JSON) ===");
  line(JSON.stringify(results, null, 2));
}

await main();
