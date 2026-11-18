import { run as start } from "./commands/start.js";
import { run as stop } from "./commands/stop.js";
import { run as status } from "./commands/status.js";
import { run as daemon } from "./commands/daemon.js";
import { run as open } from "./commands/open.js";
import { run as restore } from "./commands/restore.js";
import { run as token } from "./commands/token.js";
import { run as doctor } from "./commands/doctor.js";
import { run as install } from "./commands/install.js";
import { run as init } from "./commands/init.js";
import { run as launch } from "./commands/launch.js";
import { run as uninstall } from "./commands/uninstall.js";
import { layout } from "@mc/platform/layout";

export type Io = {
  out(s: string): void;
  err(s: string): void;
  env: NodeJS.ProcessEnv;
  cwd: string;
};

const COMMANDS: Record<string, (argv: string[], io: Io) => Promise<number>> = {
  start,
  stop,
  status,
  daemon,
  open,
  restore,
  token,
  doctor,
  install,
  uninstall,
  init,
  launch,
};

const USAGE = `usage: mc <command> [args]

commands:
  init [--agents <list>]  connect agents; prompts when omitted (copilot, claude-code, codex)
  launch                start the daemon if needed, then open the page
  start                 start the daemon in the background
  stop                  stop the daemon
  status                daemon line and one line per session
  daemon                run the daemon in the foreground (systemd, launchd)
  open [--print] [--no-pair]
                        pair a browser (pairing code) and open the page
  restore <id|mission-control://restore/<id>|mission-control://open> [--from-notification]
                        restore a session's window
  token rotate          rotate the auth token (stops the daemon)
  doctor                check permissions and dependencies
  install <what>        install a component (see mc install --help)
  uninstall <what>|--all  remove what install added
  --version, -v         print the version
`;

export async function main(argv: string[], io: Io): Promise<number> {
  const [name, ...rest] = argv;
  if (name === "--version" || name === "-v") {
    io.out(layout().version);
    return 0;
  }
  if (name === undefined || name === "--help" || name === "-h" || name === "help") {
    (name === undefined ? io.err : io.out)(USAGE.trimEnd());
    return name === undefined ? 2 : 0;
  }
  const handler = Object.prototype.hasOwnProperty.call(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (!handler) {
    io.err(`unknown command: ${name}`);
    io.err(USAGE.trimEnd());
    return 2;
  }
  return handler(rest, io);
}
