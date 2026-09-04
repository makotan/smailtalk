// M6-T01 PoC — Worker body (runs inside node:worker_threads / Bun Worker)
// Receives a task descriptor via workerData and executes it, posting results
// back to the parent. This is the "sandbox" side: it runs user-supplied code.
import { parentPort, workerData } from "node:worker_threads";

type Task =
  | { kind: "loop" }
  | { kind: "membomb"; chunkBytes: number }
  | { kind: "normal"; fnSource: string; input: unknown }
  | { kind: "ambient" };

const task = workerData as Task;

function post(msg: unknown) {
  parentPort?.postMessage(msg);
}

if (task.kind === "loop") {
  // Signal we started so the parent's budget timer measures real spin time.
  post({ started: true });
  // Tight, uninterruptible-looking infinite loop. If terminate() works this
  // thread dies mid-execution.
  while (true) {
    /* spin forever */
  }
}

if (task.kind === "membomb") {
  post({ started: true });
  const a: Uint8Array[] = [];
  // Keep growing retained memory. With resourceLimits this should throw/kill.
  while (true) {
    a.push(new Uint8Array(task.chunkBytes));
    // Touch it so it can't be optimized away.
    a[a.length - 1]![0] = 1;
  }
}

if (task.kind === "normal") {
  // Evaluate the user function source and invoke it with input.
  // eslint-disable-next-line no-eval
  const fn = (0, eval)(task.fnSource) as (i: unknown) => unknown;
  const out = fn(task.input);
  post({ result: out });
}

if (task.kind === "ambient") {
  const probe: Record<string, string> = {};

  // require("fs")
  try {
    const req = typeof require !== "undefined" ? require : undefined;
    if (req) {
      const fs = req("fs");
      probe["require('fs')"] =
        fs && typeof fs.readFileSync === "function"
          ? "REACHABLE (readFileSync present)"
          : "require present but fs odd";
    } else {
      probe["require('fs')"] = "no ambient require";
    }
  } catch (e) {
    probe["require('fs')"] = `BLOCKED: ${String((e as Error).message)}`;
  }

  // dynamic import of node:fs
  // (kept synchronous-ish via reporting only capability existence)
  probe["import('node:fs')"] =
    typeof (globalThis as any).process !== "undefined"
      ? "likely REACHABLE (node compat present)"
      : "unknown";

  // fetch
  try {
    probe.fetch =
      typeof (globalThis as any).fetch === "function"
        ? "REACHABLE (global fetch is a function)"
        : "absent";
  } catch (e) {
    probe.fetch = `err ${String(e)}`;
  }

  // process
  try {
    const p = (globalThis as any).process;
    probe.process = p
      ? `REACHABLE (process.env keys=${Object.keys(p.env ?? {}).length}, pid=${p.pid})`
      : "absent";
  } catch (e) {
    probe.process = `err ${String(e)}`;
  }

  // Bun
  try {
    const b = (globalThis as any).Bun;
    probe.Bun = b
      ? `REACHABLE (Bun.version=${b.version ?? "?"}, Bun.file=${typeof b.file})`
      : "absent";
  } catch (e) {
    probe.Bun = `err ${String(e)}`;
  }

  // globalThis
  probe.globalThis =
    typeof globalThis !== "undefined"
      ? "REACHABLE (own keys sample: " +
        Object.getOwnPropertyNames(globalThis).slice(0, 12).join(",") +
        ")"
      : "absent";

  post({ probe });
}
