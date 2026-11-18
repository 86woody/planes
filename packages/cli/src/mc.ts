import { main } from "./main.js";

main(process.argv.slice(2), {
  out: (s) => process.stdout.write(`${s}\n`),
  err: (s) => process.stderr.write(`${s}\n`),
  env: process.env,
  cwd: process.cwd(),
}).then(
  (code) => {
    // exitCode, not exit(): a foreground `mc daemon` keeps the event loop alive until it stops.
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
