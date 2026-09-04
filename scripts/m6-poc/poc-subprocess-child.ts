// M6-T01 PoC child: executes untrusted "user code" inside a separate Bun process.
// Invoked by poc-subprocess.ts (parent). Nothing here is sandboxed on purpose —
// the point of the PoC is to measure what a *default* full-authority Bun child
// can reach, and what OS-level containment (kill / ulimit) actually does to it.
//
// argv[2] = kind: "run" | "call" | "probe"
// argv[3] = user code (source string)
// argv[4] = JSON input (for "call")

const kind = process.argv[2];
const code = process.argv[3] ?? "";
const inputJson = process.argv[4] ?? "null";

// Indirect eval → runs in global scope, closest to "we handed the string to a fresh runtime".
const indirectEval = eval;

if (kind === "call") {
  const input = JSON.parse(inputJson);
  const fn = indirectEval(`(${code})`);
  const result = await fn(input);
  process.stdout.write(JSON.stringify({ result }));
  process.exit(0);
} else if (kind === "probe") {
  // What can default user code reach with zero hardening?
  const report: Record<string, unknown> = {};
  try {
    const fs = require("node:fs");
    report.require_fs = typeof fs.readFileSync === "function";
    // Prove it actually works: read a real file from disk.
    report.can_read_disk = fs.readFileSync(process.argv[1], "utf8").length > 0;
    report.can_list_cwd = fs.readdirSync(".").length;
  } catch (e) {
    report.require_fs = false;
    report.can_read_disk = String(e);
  }
  report.fetch = typeof fetch;
  report.process_env_keys =
    typeof process !== "undefined" ? Object.keys(process.env).length : "no-process";
  report.Bun = typeof Bun;
  try {
    // Bun.spawn from inside → child could spawn its own subprocesses (fork bombs etc.)
    report.Bun_spawn = typeof Bun.spawn === "function";
  } catch {
    report.Bun_spawn = false;
  }
  process.stdout.write(JSON.stringify(report));
  process.exit(0);
} else {
  // "run": evaluate the statement as-is. Used for the hostile loops (M1/M2)
  // which never return — the parent is expected to kill us.
  process.stdout.write("STARTED");
  indirectEval(code);
}
