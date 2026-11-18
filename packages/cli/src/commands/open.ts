import type { Io } from "../main.js";
import { resolveCliPaths } from "../lib/paths.js";
import type { CliPaths } from "../lib/paths.js";
import { api, readToken } from "../lib/daemon.js";
import { ensureRunning } from "../lib/control.js";
import { copyToClipboard, isFake, openUrl } from "../lib/system.js";

export const PAGE_URL = (port: number): string => `http://127.0.0.1:${port}/`;

/** Open the page only (no pairing code). Used by `open --no-pair` and by restore's fallback. */
export function openPageOnly(io: Io, port: number, print: boolean): number {
  const url = PAGE_URL(port);
  io.out(`URL  ${url}`);
  if (!print && !isFake(io.env) && !openUrl(url)) {
    io.err(`could not start a browser; open ${url} by hand`);
    return 1;
  }
  return 0;
}

export async function run(argv: string[], io: Io): Promise<number> {
  const flags = new Set(argv);
  const known = new Set(["--print", "--no-pair"]);
  for (const f of flags) {
    if (!known.has(f)) {
      io.err(`usage: mc open [--print] [--no-pair]`);
      return 2;
    }
  }
  const print = flags.has("--print");
  const paths: CliPaths = resolveCliPaths(io.env);
  const started = await ensureRunning(paths, io);
  if (!started) return 1;
  const { port } = started.running;

  if (flags.has("--no-pair")) return openPageOnly(io, port, print);

  const res = await api(port, "POST", "/api/pair-code", { token: readToken(paths) });
  if (res.status !== 200) {
    io.err(`could not get a pairing code: HTTP ${res.status}`);
    return 1;
  }
  const { code } = res.json as { code: string };
  // --print and the fake platform touch neither the clipboard nor a browser.
  const live = !print && !isFake(io.env);
  const copied = live && copyToClipboard(code);
  io.out(`PAIR CODE  ${code}  (${copied ? "copied; " : ""}valid 60 s)`);
  return openPageOnly(io, port, !live);
}
