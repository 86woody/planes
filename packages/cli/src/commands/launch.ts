import type { Io } from "../main.js";
import { run as startRun } from "./start.js";
import { run as openRun } from "./open.js";

const USAGE = "usage: mc launch [--print] [--no-pair]";

/** D-46.4: `mc start` (idempotent, heals launchers first) then `mc open`. */
export async function run(argv: string[], io: Io): Promise<number> {
  for (const a of argv) {
    if (a !== "--print" && a !== "--no-pair") {
      io.err(USAGE);
      return 2;
    }
  }
  // An already-running daemon is not news here; everything else start prints passes through.
  const quiet: Io = {
    ...io,
    out: (s) => {
      if (!s.startsWith("already running ")) io.out(s);
    },
  };
  const code = await startRun([], quiet);
  if (code !== 0) return code;
  return openRun(argv, io);
}
