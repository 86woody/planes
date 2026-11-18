import type { Io } from "../main.js";
import { checksFor } from "../lib/doctor-checks.js";
import type { DoctorCheck, Outcome, Status } from "../lib/doctor-checks.js";
import { realCopilotDoctorDeps, runCopilotDoctor } from "../lib/doctor-copilot.js";

const TAG: Record<Status, string> = { ok: "OK", missing: "MISSING", warn: "WARN" };

/** Print `OK|MISSING|WARN <check>  <fix>` per check. Exit 1 if a required check is missing. */
export async function runChecks(checks: DoctorCheck[], io: Io): Promise<number> {
  let failed = false;
  for (const c of checks) {
    let outcome: Outcome;
    try {
      outcome = await c.run();
    } catch (err) {
      outcome = { status: c.required ? "missing" : "warn", detail: err instanceof Error ? err.message : String(err) };
    }
    const status = typeof outcome === "string" ? outcome : outcome.status;
    const detail = typeof outcome === "string" ? "" : ` [${outcome.detail}]`;
    io.out(`${TAG[status]} ${c.label}${detail}  ${c.fix}`);
    if (status === "missing" && c.required) failed = true;
  }
  return failed ? 1 : 0;
}

const USAGE = "usage: mc doctor [copilot [--live]]";

export async function run(argv: string[], io: Io): Promise<number> {
  if (argv.length === 0) return runChecks(checksFor(process.platform, io.env), io);
  const [sub, ...rest] = argv;
  if (sub === "copilot" && (rest.length === 0 || (rest.length === 1 && rest[0] === "--live"))) {
    return runCopilotDoctor(io, realCopilotDoctorDeps(io.env, rest.length === 1));
  }
  io.err(USAGE);
  return 2;
}
