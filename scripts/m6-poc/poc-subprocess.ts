// M6-T01 PoC (parent): subprocess-isolation candidate.
// Spawns a fresh Bun child per "user function" call and measures the 5 common
// metrics + subprocess-specific concerns (ulimit -v, kill certainty, spawn cost).
//
// Run: bun run scripts/m6-poc/poc-subprocess.ts
//
// Everything here is REAL measurement. No mocked numbers. Host-safety budgets
// are noted inline where they were tightened.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHILD = join(__dirname, "poc-subprocess-child.ts");
const BUN = process.execPath; // absolute path to the running bun binary

const now = () => Bun.nanoseconds() / 1e6; // ms

function log(section: string, obj: unknown) {
  console.log(`\n[${section}]`, typeof obj === "string" ? obj : JSON.stringify(obj, null, 2));
}

// ---------------------------------------------------------------------------
// helper: spawn a hostile child directly with Bun.spawn and enforce a budget.
// Returns timing + how it died.
// ---------------------------------------------------------------------------
async function runHostile(name: string, code: string, budgetMs: number) {
  const spawnStart = now();
  const proc = Bun.spawn([BUN, "run", CHILD, "run", code], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const spawnedAt = now();

  // let it run for the budget
  const budgetStart = now();
  await Bun.sleep(budgetMs);

  // enforce: try graceful SIGTERM first, escalate to SIGKILL.
  let mechanism = "SIGTERM";
  const killStart = now();
  proc.kill("SIGTERM");

  // Give SIGTERM a short grace window. A tight `while(true){}` blocks the JS
  // event loop, so a JS-level SIGTERM handler can't run — we expect to escalate.
  const graceMs = 100;
  const graceDeadline = now() + graceMs;
  while (proc.exitCode === null && proc.signalCode === null && now() < graceDeadline) {
    await Bun.sleep(5);
  }
  if (proc.exitCode === null && proc.signalCode === null) {
    mechanism = "SIGKILL (after SIGTERM ignored)";
    proc.kill("SIGKILL");
  }
  await proc.exited;
  const stoppedAt = now();

  const stderr = await new Response(proc.stderr).text();
  return {
    name,
    spawn_ms: +(spawnedAt - spawnStart).toFixed(1),
    stop_ms_from_budget_end: +(stoppedAt - killStart).toFixed(1),
    total_alive_ms: +(stoppedAt - budgetStart).toFixed(1),
    mechanism,
    exitCode: proc.exitCode,
    signalCode: proc.signalCode,
    stderr_tail: stderr.slice(-400),
  };
}

// ---------------------------------------------------------------------------
// helper: spawn hostile child under `bash -c 'ulimit -v <KB>; exec bun ...'`
// to test OS-level memory capping on macOS arm64.
// ---------------------------------------------------------------------------
async function runHostileUlimit(name: string, code: string, budgetMs: number, kb: number) {
  // Build a shell command. We must escape the code for single-quote embedding.
  const shell = `ulimit -v ${kb}; exec ${JSON.stringify(BUN)} run ${JSON.stringify(CHILD)} run ${JSON.stringify(code)}`;
  const spawnStart = now();
  const proc = Bun.spawn(["bash", "-c", shell], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const budgetStart = now();

  // poll: did it die on its own (ulimit worked) before the budget?
  let diedNaturally = false;
  const deadline = now() + budgetMs;
  while (now() < deadline) {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      diedNaturally = true;
      break;
    }
    await Bun.sleep(20);
  }

  const mechanism = diedNaturally ? "self-exit (ulimit or crash)" : "SIGKILL (budget)";
  if (!diedNaturally) {
    proc.kill("SIGKILL");
  }
  await proc.exited;
  const stoppedAt = now();

  const stderr = await new Response(proc.stderr).text();
  const stdout = await new Response(proc.stdout).text();
  return {
    name,
    ulimit_v_kb: kb,
    died_before_budget: diedNaturally,
    alive_ms: +(stoppedAt - budgetStart).toFixed(1),
    mechanism,
    exitCode: proc.exitCode,
    signalCode: proc.signalCode,
    spawn_note: `spawnStart=${spawnStart.toFixed(0)}`,
    stdout_tail: stdout.slice(-200),
    stderr_tail: stderr.slice(-600),
  };
}

// ---------------------------------------------------------------------------
// helper: call a normal user function in a child, collect result via stdout.
// ---------------------------------------------------------------------------
async function callFunction(code: string, input: unknown, budgetMs = 5000) {
  const proc = Bun.spawn([BUN, "run", CHILD, "call", code, JSON.stringify(input)], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const t = setTimeout(() => proc.kill("SIGKILL"), budgetMs);
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  clearTimeout(t);
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: proc.exitCode };
}

// ---------------------------------------------------------------------------
async function measureSpawnLatency(n = 5) {
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = now();
    const proc = Bun.spawn([BUN, "run", CHILD, "call", "(input)=>input", "0"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    await new Response(proc.stdout).text();
    await proc.exited;
    samples.push(now() - t0);
  }
  samples.sort((a, b) => a - b);
  const mid = samples[Math.floor(n / 2)] ?? 0;
  const lo = samples[0] ?? 0;
  return {
    samples: samples.map((s) => +s.toFixed(1)),
    median_ms: +mid.toFixed(1),
    min_ms: +lo.toFixed(1),
  };
}

// ---------------------------------------------------------------------------
async function main() {
  console.log("=== M6-T01 PoC: subprocess isolation (Bun.spawn) ===");
  console.log("bun:", BUN, "arch:", process.arch, "platform:", process.platform);

  // ---- M4 normal function (do this first: proves the plumbing works) ----
  const m4 = await callFunction("(input)=> input.x*2", { x: 21 });
  let m4Result: unknown = null;
  try {
    m4Result = JSON.parse(m4.stdout).result;
  } catch {
    m4Result = m4.stdout;
  }
  log("M4 normal function", { ...m4, parsed_result: m4Result });

  // ---- ambient authority probe ----
  const probeProc = Bun.spawn([BUN, "run", CHILD, "probe"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const probeOut = await new Response(probeProc.stdout).text();
  await probeProc.exited;
  log("AMBIENT authority (default child)", probeOut);

  // ---- spawn latency ----
  const spawn = await measureSpawnLatency(5);
  log("SPAWN latency", spawn);

  // ---- M1 infinite loop ----
  // Host-safety budget note: 500ms as specified. A tight loop can't be killed
  // by a JS-level SIGTERM handler (event loop blocked), so we expect SIGKILL.
  const m1 = await runHostile("M1 infinite-loop", "while(true){}", 500);
  log("M1 infinite loop", m1);

  // ---- M2 memory runaway under ulimit -v ----
  // Host-safety: we DO NOT run the memory bomb without an OS cap first — an
  // uncapped `while(true){ a.push(new Uint8Array(1e6)) }` would race the 500ms
  // budget against real host RAM. We cap virtual memory via ulimit -v and see
  // if macOS arm64 enforces it. Budget kept at 500ms as a backstop.
  const memCode = "const a=[]; while(true){ a.push(new Uint8Array(1000000)); }";
  // Try a few caps. bun reserves large virtual address space, so very low caps
  // may prevent bun from even starting — that itself is a finding.
  const m2a = await runHostileUlimit("M2 mem @512MB", memCode, 1500, 512 * 1024);
  log("M2 memory runaway (ulimit -v 512MB)", m2a);
  const m2b = await runHostileUlimit("M2 mem @256MB", memCode, 1500, 256 * 1024);
  log("M2 memory runaway (ulimit -v 256MB)", m2b);

  // Also: does ulimit -v even let bun boot at a low cap? Control with trivial code.
  const ctrl = await runHostileUlimit("ctrl trivial @256MB", "0", 1500, 256 * 1024);
  log("control: trivial child under ulimit -v 256MB", ctrl);

  // ---- M3 host health: parent still computes after all the hostility ----
  const m3 = 40 + 2;
  log("M3 host healthy", { computed_40_plus_2: m3, ok: m3 === 42 });

  // Re-confirm the parent can still spawn+get a real answer post-mayhem.
  const m3b = await callFunction("(input)=> input.a + input.b", { a: 40, b: 2 });
  let m3bResult: unknown = null;
  try {
    m3bResult = JSON.parse(m3b.stdout).result;
  } catch {
    m3bResult = m3b.stdout;
  }
  log("M3 host can still spawn children", { parsed_result: m3bResult, exitCode: m3b.exitCode });

  console.log("\n=== raw measurement complete ===");
}

main();
