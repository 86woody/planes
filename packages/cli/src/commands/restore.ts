import type { Io } from "../main.js";
import { resolveCliPaths } from "../lib/paths.js";
import { api, findRunning, readToken } from "../lib/daemon.js";
import { allowSetForeground, isFake } from "../lib/system.js";
import { openPageOnly } from "./open.js";

const USAGE = "usage: mc restore <id|mission-control://restore/<id>|mission-control://open> [--from-notification]";

interface RestoreBody {
  result: { status: string; code: string; detail: string };
}

export async function run(argv: string[], io: Io): Promise<number> {
  const fromNotification = argv.includes("--from-notification");
  const positional = argv.filter((a) => a !== "--from-notification");
  if (positional.length !== 1 || positional[0] === undefined) {
    io.err(USAGE);
    return 2;
  }
  const target = positional[0];
  const paths = resolveCliPaths(io.env);
  const running = await findRunning(paths);
  if (!running) {
    io.err("daemon not running; run mc start");
    return 1;
  }

  if (target === "mission-control://open" || target === "open") {
    return openPageOnly(io, running.port, isFake(io.env));
  }
  const m = /^mission-control:\/\/restore\/(.+)$/.exec(target);
  let id: string;
  if (m && m[1] !== undefined) {
    try {
      id = decodeURIComponent(m[1]);
    } catch {
      io.err(`bad restore URI: ${target}`);
      return 2;
    }
  } else if (target.startsWith("mission-control://")) {
    io.err(USAGE);
    return 2;
  } else {
    id = target;
  }

  if (fromNotification && process.platform === "win32" && !isFake(io.env)) allowSetForeground();

  const token = readToken(paths);
  let res;
  try {
    res = await api(running.port, "POST", `/api/sessions/${encodeURIComponent(id)}/restore`, {
      token,
      body: fromNotification ? { source: "notification" } : {},
    });
  } catch (err) {
    io.err(`daemon request failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  if (res.status === 404) {
    io.err(`no session ${id}; opening the page instead`);
    return openPageOnly(io, running.port, isFake(io.env));
  }
  if (res.status !== 200) {
    io.err(`restore failed: HTTP ${res.status}`);
    return 1;
  }
  const result = (res.json as RestoreBody).result;
  if (result.status === "failed") {
    io.out(`restore failed: ${result.code} ${result.detail}; opening the page`);
    return openPageOnly(io, running.port, isFake(io.env));
  }
  io.out(`restore ${result.status}: ${result.code}`);
  return 0;
}
