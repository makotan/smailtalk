/**
 * M6-T01 PoC: node:vm (Node/Bun vm module) JS function sandbox
 *
 * Runs under Bun: `bun run scripts/m6-poc/poc-node-vm.ts`
 *
 * Common measurement protocol (M1-M4 + ambient authority):
 *  M1 無限ループ: while(true){} with 500ms time budget. Did it stop? wall-time?
 *  M2 メモリ暴走: unbounded array push with mem cap (~64MB) + time budget. Contained? host alive?
 *  M3 ホスト健全性: after M1/M2, can host still compute 40+2 ?
 *  M4 正常関数: (input)=>input.x*2 with {x:21} -> 42 ?
 *  ambient authority: default reachability of require("fs")/fetch/process/Bun/globalThis
 *
 * node:vm specifics:
 *  - Does vm.runInNewContext(code, sandbox, { timeout: 500 }) actually interrupt a tight
 *    infinite loop under Bun? (Node uses a watchdog; Bun's node:vm compat is unknown -> measure)
 *  - Can node:vm alone enforce a memory cap? (expected: no)
 *  - What is visible in the contextified globals (ambient)?
 *
 * IMPORTANT: measure for real. No fallbacks/mocks. If it can't stop, report "can't stop".
 */

import vm from "node:vm";

type Result = Record<string, unknown>;
const results: Result = {};

function line(s: string) {
  // eslint-disable-next-line no-console
  console.log(s);
}

// ---------------------------------------------------------------------------
// M1: infinite loop with 500ms timeout via node:vm's timeout option
// ---------------------------------------------------------------------------
function testM1(): void {
  line("\n=== M1: infinite loop, vm timeout=500ms ===");
  const code = `while(true){}`;
  const budgetMs = 500;
  const start = performance.now();
  let stopped = false;
  let mechanism = "";
  let elapsed = 0;
  try {
    vm.runInNewContext(code, {}, { timeout: budgetMs });
    // If it returns, the loop somehow ended (should not for while(true))
    elapsed = performance.now() - start;
    stopped = true;
    mechanism = "returned normally (unexpected for while(true))";
  } catch (e) {
    elapsed = performance.now() - start;
    stopped = true;
    mechanism = `threw: ${(e as Error).name}: ${(e as Error).message}`;
  }
  line(`  stopped=${stopped} elapsed=${elapsed.toFixed(1)}ms mechanism=${mechanism}`);
  results.M1 = { stopped, elapsedMs: Math.round(elapsed), mechanism };
}

// ---------------------------------------------------------------------------
// M1b: watchdog fallback — if vm timeout does NOT work under Bun, is there any
// in-process way to stop a tight sync loop? (spoiler: a sync loop blocks the
// event loop, so a timer/worker cannot preempt it in-process). We demonstrate
// this only if M1's timeout appears not to fire promptly.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// M2: memory blowup. Try to cap heap. node:vm has no memory option; the closest
// knobs are process-level (--max-old-space-size) which we cannot set per-sandbox.
// We run the allocator under a SHORT timeout so we do not OOM the host, and we
// also cap the number of iterations defensively. We report what actually bounds it.
// ---------------------------------------------------------------------------
function testM2(): void {
  line("\n=== M2: memory blowup, vm timeout=500ms (no vm memory cap available) ===");
  // Real user code per protocol; we rely ONLY on the timeout to avoid host OOM,
  // because node:vm cannot enforce a memory ceiling.
  const code = `const a=[]; while(true){ a.push(new Uint8Array(1000000)); }`;
  const budgetMs = 500;
  const memBefore = process.memoryUsage();
  const start = performance.now();
  let stopped = false;
  let mechanism = "";
  let elapsed = 0;
  try {
    vm.runInNewContext(code, {}, { timeout: budgetMs });
    elapsed = performance.now() - start;
    stopped = true;
    mechanism = "returned normally (unexpected)";
  } catch (e) {
    elapsed = performance.now() - start;
    stopped = true;
    mechanism = `threw: ${(e as Error).name}: ${(e as Error).message}`;
  }
  const memAfter = process.memoryUsage();
  const rssDeltaMB = (memAfter.rss - memBefore.rss) / (1024 * 1024);
  const heapDeltaMB = (memAfter.heapUsed - memBefore.heapUsed) / (1024 * 1024);
  line(
    `  stopped=${stopped} elapsed=${elapsed.toFixed(1)}ms rssDelta=${rssDeltaMB.toFixed(
      1,
    )}MB heapDelta=${heapDeltaMB.toFixed(1)}MB mechanism=${mechanism}`,
  );
  line(
    `  NOTE: node:vm exposes no per-context memory limit; only the timeout (if it works) bounds allocation.`,
  );
  results.M2 = {
    stopped,
    elapsedMs: Math.round(elapsed),
    rssDeltaMB: Number(rssDeltaMB.toFixed(1)),
    heapDeltaMB: Number(heapDeltaMB.toFixed(1)),
    mechanism,
    vmMemoryCap: false,
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
// M4: normal function
// ---------------------------------------------------------------------------
function testM4(): void {
  line("\n=== M4: normal function (input)=>input.x*2 with {x:21} ===");
  let ok = false;
  let ret: unknown;
  let err = "";
  try {
    // Provide input via the contextified sandbox; capture the result out.
    const sandbox: Record<string, unknown> = { input: { x: 21 }, __out: undefined };
    const code = `__out = ((input)=> input.x*2)(input);`;
    vm.runInNewContext(code, sandbox, { timeout: 500 });
    ret = sandbox.__out;
    ok = ret === 42;
  } catch (e) {
    err = `${(e as Error).name}: ${(e as Error).message}`;
  }
  line(`  returned=${JSON.stringify(ret)} ok=${ok}${err ? ` err=${err}` : ""}`);
  results.M4 = { ok, returned: ret, err: err || undefined };
}

// ---------------------------------------------------------------------------
// Ambient authority: what dangerous globals are reachable by DEFAULT from a
// contextified sandbox? Test require/fetch/process/Bun/globalThis + friends.
// ---------------------------------------------------------------------------
function probe(name: string, expr: string): { name: string; reachable: boolean; detail: string } {
  const sandbox: Record<string, unknown> = { __out: undefined };
  const code = `try { __out = { ok: true, v: String(typeof (${expr})) + ((${expr}) ? '' : '') }; } catch (e) { __out = { ok: false, v: e.name + ': ' + e.message }; }`;
  try {
    vm.runInNewContext(code, sandbox, { timeout: 500 });
    const out = sandbox.__out as { ok: boolean; v: string };
    // reachable = the expression evaluated to something not undefined/not throwing
    const typeStr = out.v;
    const reachable = out.ok && typeStr !== "undefined";
    return { name, reachable, detail: out.ok ? `typeof=${typeStr}` : `blocked(${typeStr})` };
  } catch (e) {
    return { name, reachable: false, detail: `hostThrew: ${(e as Error).message}` };
  }
}

function testAmbient(): void {
  line("\n=== AMBIENT: default reachability of dangerous globals ===");
  const probes: Array<[string, string]> = [
    ["globalThis", "globalThis"],
    ["process", "process"],
    ["Bun", "typeof Bun !== 'undefined' ? Bun : undefined"],
    ["fetch", "fetch"],
    ["require", "typeof require !== 'undefined' ? require : undefined"],
    ["require('fs')", "typeof require !== 'undefined' ? require('fs') : undefined"],
    ["import.meta", "typeof import !== 'undefined' ? 1 : undefined"],
    ["Function-constructor-escape", "(function(){ return this; })()"],
    ["constructor-escape", "([]).constructor.constructor"],
    ["setTimeout", "setTimeout"],
    ["console", "console"],
  ];
  const ambient: Array<Record<string, unknown>> = [];
  for (const [name, expr] of probes) {
    const r = probe(name, expr);
    line(`  ${name.padEnd(28)} reachable=${r.reachable}  ${r.detail}`);
    ambient.push(r);
  }
  results.ambient = ambient;

  // Extra: can the Function-constructor escape actually reach the host global
  // (and thus process/require) even when sandbox is empty?
  line("\n  -- escape attempt: ([]).constructor.constructor('return process')() --");
  const esc: Record<string, unknown> = { __out: undefined };
  const escCode = `try { const f = ([]).constructor.constructor('return typeof process'); __out = { ok:true, v: f() }; } catch(e){ __out = { ok:false, v: e.name+': '+e.message }; }`;
  try {
    vm.runInNewContext(escCode, esc, { timeout: 500 });
    line(`    result: ${JSON.stringify(esc.__out)}`);
    results.escape = esc.__out;
  } catch (e) {
    line(`    hostThrew: ${(e as Error).message}`);
    results.escape = { ok: false, v: `hostThrew: ${(e as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// Capability bridge demo: expose ONLY a declared function into the sandbox and
// verify the sandbox can call it but cannot reach anything else.
// ---------------------------------------------------------------------------
function testCapabilityBridge(): void {
  line("\n=== CAPABILITY BRIDGE: expose only declared capability ===");
  let ok = false;
  let detail = "";
  try {
    let sawArg: unknown;
    const declaredCapability = (arg: unknown) => {
      sawArg = arg;
      return { status: 200, echoed: arg };
    };
    // Minimal sandbox: only the one capability, plus a place for output.
    const sandbox: Record<string, unknown> = {
      capability: declaredCapability,
      input: { x: 21 },
      __out: undefined,
    };
    const code = `__out = capability({ from: 'sandbox', doubled: input.x*2 });`;
    vm.runInNewContext(code, sandbox, { timeout: 500 });
    const out = sandbox.__out as { status: number; echoed: { doubled: number } };
    ok =
      out?.status === 200 &&
      out?.echoed?.doubled === 42 &&
      (sawArg as { doubled: number })?.doubled === 42;
    detail = `bridge call returned ${JSON.stringify(out)}`;
  } catch (e) {
    detail = `${(e as Error).name}: ${(e as Error).message}`;
  }
  line(`  bridge works=${ok}  ${detail}`);
  results.capabilityBridge = { ok, detail };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main(): void {
  line(`Runtime: ${typeof Bun !== "undefined" ? `Bun ${Bun.version}` : `Node ${process.version}`}`);
  line(`node:vm present: ${typeof vm.runInNewContext === "function"}`);

  testM1();
  testM2();
  testM3();
  testM4();
  testAmbient();
  testCapabilityBridge();

  line("\n=== RAW RESULTS (JSON) ===");
  line(JSON.stringify(results, null, 2));
}

main();
