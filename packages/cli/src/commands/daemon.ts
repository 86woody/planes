import { spawn } from "node:child_process";
import type { Io } from "../main.js";
import { DAEMON_BIN } from "../lib/paths.js";

/** Foreground daemon for systemd and launchd: runs the built entry with inherited stdio and forwards signals. */
export async function run(argv: string[], io: Io): Promise<number> {
  if (argv.length > 0) {
    io.err("usage: mc daemon");
    return 2;
  }
  return new Promise<number>((resolve) => {
    const child = spawn(process.execPath, [DAEMON_BIN], { stdio: "inherit", env: io.env });
    const forward = (sig: NodeJS.Signals) => () => child.kill(sig);
    const onInt = forward("SIGINT");
    const onTerm = forward("SIGTERM");
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    child.on("error", (err) => {
      io.err(err.message);
      resolve(1);
    });
    child.on("exit", (code) => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      resolve(code ?? 1);
    });
  });
}
