import type { Io } from "../main.js";
import { resolveCliPaths } from "../lib/paths.js";
import { rotateTokenFile, stopDaemon } from "../lib/control.js";

export async function run(argv: string[], io: Io): Promise<number> {
  if (argv.length !== 1 || argv[0] !== "rotate") {
    io.err("usage: mc token rotate");
    return 2;
  }
  const paths = resolveCliPaths(io.env);
  // Stop first: the daemon's stop() would flush the old browser sessions back to disk after the delete.
  const stopped = await stopDaemon(paths, io);
  if (stopped === "failed") {
    io.err("token not rotated: the daemon did not stop");
    return 1;
  }
  rotateTokenFile(paths);
  io.out("token rotated; daemon stopped. run mc start, then mc open to pair browsers again");
  return 0;
}
