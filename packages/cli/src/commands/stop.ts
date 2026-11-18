import type { Io } from "../main.js";
import { resolveCliPaths } from "../lib/paths.js";
import { stopDaemon } from "../lib/control.js";

export async function run(argv: string[], io: Io): Promise<number> {
  if (argv.length > 0) {
    io.err("usage: mc stop");
    return 2;
  }
  const result = await stopDaemon(resolveCliPaths(io.env), io);
  if (result === "stopped") {
    io.out("stopped");
    return 0;
  }
  if (result === "not-running") {
    io.out("not running");
    return 0;
  }
  return 1;
}
