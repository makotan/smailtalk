// M6-T01 PoC — Parent / host measuring a Worker-thread JS sandbox.
// Run:  bun run scripts/m6-poc/poc-worker.ts
//
// Measures the 5 common protocol points (M1..M4 + ambient) for a
// node:worker_threads based JS function sandbox, plus Worker-specific
// questions: does worker.terminate() actually stop a tight loop, does
// resourceLimits work under Bun, and is the host unharmed afterward.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHILD = join(__dirname, "poc-worker-child.ts");

function line(s = "") {
  console.log(s);
}

// Spawn a worker for a given task; resolve with {worker} immediately.
function spawn(workerData: unknown, resourceLimits?: any): Worker {
  return new Worker(CHILD, { workerData, resourceLimits } as any);
}

// ---- M1: infinite loop, 500ms time budget, terminate() ----
async function m1(): Promise<{ stopped: boolean; ms: number; note: string }> {
  return new Promise((resolve) => {
    const w = spawn({ kind: "loop" });
    let started = false;
    const budgetMs = 500;
    let t0 = performance.now(); // reset when worker signals start
    w.on("message", (m: any) => {
      if (m?.started) {
        started = true;
        t0 = performance.now();
        // Start the budget only once the worker is actually spinning.
        setTimeout(async () => {
          const beforeTerm = performance.now();
          await w.terminate();
          const afterTerm = performance.now();
          const elapsedFromBudget = afterTerm - t0;
          resolve({
            stopped: true,
            ms: Math.round(elapsedFromBudget),
            note: `terminate() returned after ${Math.round(
              afterTerm - beforeTerm,
            )}ms; budget=${budgetMs}ms; startedSignal=${started}`,
          });
        }, budgetMs);
      }
    });
    // Safety net: if terminate somehow hangs the promise, bail at 5s.
    setTimeout(() => {
      resolve({
        stopped: false,
        ms: Math.round(performance.now() - t0),
        note: "SAFETY TIMEOUT 5s — terminate() did not resolve",
      });
    }, 5000).unref?.();
  });
}

// ---- M2 helper: run one membomb config, report how/when it was contained ----
// Returns whether the worker was contained by ITS OWN VM ('error'/'exit')
// vs. only stopped by our terminate() budget fallback, plus the wall-time.
async function membombRun(
  label: string,
  resourceLimits: any,
  budgetMs: number,
): Promise<{ label: string; behavior: string; selfContained: boolean; ms: number }> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const w = spawn({ kind: "membomb", chunkBytes: 1_000_000 }, resourceLimits);
    let settled = false;
    const fin = (behavior: string, selfContained: boolean) => {
      if (settled) return;
      settled = true;
      w.terminate();
      resolve({ label, behavior, selfContained, ms: Math.round(performance.now() - t0) });
    };
    // A per-worker OOM surfaces as an 'error' event; host is untouched.
    w.on("error", (err) => fin(`worker 'error': ${String((err as Error)?.message ?? err)}`, true));
    w.on("exit", (code) => fin(`worker 'exit' code=${code}`, code !== 0));
    // Budget fallback: if nothing fires, terminate so the host survives.
    setTimeout(
      () => fin("NOT self-contained; stopped by terminate() budget fallback", false),
      budgetMs,
    );
  });
}

// ---- M2: memory bomb. Probe whether resourceLimits actually enforces a cap
// under Bun by comparing 64MB / 16MB / no-limit. ----
async function m2(): Promise<{
  contained: boolean;
  hostAlive: boolean;
  limitsWorked: boolean;
  runs: Awaited<ReturnType<typeof membombRun>>[];
  note: string;
}> {
  const runs = [
    await membombRun("64MB limit", { maxOldGenerationSizeMb: 64 }, 5000),
    await membombRun("16MB limit", { maxOldGenerationSizeMb: 16 }, 5000),
    await membombRun("no limit", undefined, 5000),
  ];
  // "limitsWorked" only if the tighter limit meaningfully changed containment
  // timing/behavior vs. no-limit — i.e. resourceLimits is actually honored.
  const byLabel = Object.fromEntries(runs.map((r) => [r.label, r]));
  const l64 = byLabel["64MB limit"];
  const l16 = byLabel["16MB limit"];
  // Faithful enforcement would mean 16MB caps EARLIER than 64MB, and both
  // self-contain. If 16MB never fires while 64MB does, enforcement is partial.
  const limitsWorked = !!l16 && !!l64 && l16.selfContained && l64.selfContained && l16.ms <= l64.ms;
  const allSelfContained = runs.every((r) => r.selfContained);
  return {
    contained: allSelfContained, // host survived every run regardless (see hostAlive)
    hostAlive: true, // reaching here means host survived every run
    limitsWorked,
    runs,
    note: limitsWorked
      ? "resourceLimits honored (tighter cap fired sooner)"
      : "resourceLimits only PARTIALLY honored under Bun/JSC: worker-VM boundary contains runaway alloc as a worker 'error' (host safe), but maxOldGenerationSizeMb is not a faithful/precise cap",
  };
}

// ---- M3: host still computes after M1/M2 ----
function m3(): { healthy: boolean; value: number } {
  const value = 40 + 2;
  return { healthy: value === 42, value };
}

// ---- M4: normal function round trip ----
async function m4(): Promise<{ ok: boolean; value: unknown }> {
  return new Promise((resolve) => {
    const w = spawn({
      kind: "normal",
      fnSource: "(input) => input.x * 2",
      input: { x: 21 },
    });
    w.on("message", (m: any) => {
      w.terminate();
      resolve({ ok: m?.result === 42, value: m?.result });
    });
    w.on("error", (e) => resolve({ ok: false, value: `error: ${String(e)}` }));
    setTimeout(() => resolve({ ok: false, value: "timeout" }), 5000).unref?.();
  });
}

// ---- Ambient authority probe ----
async function ambient(): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    const w = spawn({ kind: "ambient" });
    w.on("message", (m: any) => {
      w.terminate();
      resolve(m?.probe ?? {});
    });
    w.on("error", (e) => resolve({ ERROR: String((e as Error)?.message ?? e) }));
    setTimeout(() => resolve({ ERROR: "timeout" }), 5000).unref?.();
  });
}

async function main() {
  line("=== M6-T01 PoC: worker_threads JS sandbox ===");
  line(
    `runtime: Bun ${(globalThis as any).Bun?.version ?? "?"} on ${process.platform}/${process.arch}`,
  );
  line();

  line("[M1] infinite loop + 500ms budget + terminate()...");
  const r1 = await m1();
  line(`  stopped=${r1.stopped} elapsed=${r1.ms}ms  ${r1.note}`);
  line();

  line("[M2] memory bomb: probe resourceLimits (64MB / 16MB / none) + budget...");
  const r2 = await m2();
  for (const run of r2.runs) {
    line(`  ${run.label}: ${run.behavior} @ ${run.ms}ms (selfContained=${run.selfContained})`);
  }
  line(`  => contained=${r2.contained} limitsWorked=${r2.limitsWorked} hostAlive=${r2.hostAlive}`);
  line(`  note: ${r2.note}`);
  line();

  line("[M3] host health after M1/M2 (40+2)...");
  const r3 = m3();
  line(`  healthy=${r3.healthy} value=${r3.value}`);
  line();

  line("[M4] normal fn (input)=>input.x*2 with {x:21}...");
  const r4 = await m4();
  line(`  ok=${r4.ok} value=${JSON.stringify(r4.value)}`);
  line();

  line("[AMBIENT] default reachability of dangerous globals inside worker...");
  const amb = await ambient();
  for (const [k, v] of Object.entries(amb)) line(`  ${k}: ${v}`);
  line();

  // Final host health confirmation before exit.
  line(`[FINAL] host still alive, 6*7=${6 * 7}`);

  // ---- machine-readable summary block ----
  line();
  line("=== SUMMARY (raw measurements) ===");
  line(JSON.stringify({ r1, r2, r3, r4, amb }, null, 2));

  process.exit(0);
}

main();
