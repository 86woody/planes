import type { Exec } from "../exec.js";

export interface TmuxClient {
  tty: string;
  activity: number;
  session: string;
}

/** Socket path: the first comma field of $TMUX (linux.md 4.1). */
export function tmuxSocket(tmuxEnv: string | undefined): string | null {
  if (tmuxEnv === undefined || tmuxEnv === "") return null;
  const first = tmuxEnv.split(",")[0] ?? "";
  return first === "" ? null : first;
}

/**
 * The inner selector carries only the pane ("%12"), so the socket is remembered per pane
 * in this process when the target is resolved and read back when it is focused.
 */
const socketByPane = new Map<string, string>();
export function rememberPaneSocket(pane: string, socket: string): void {
  socketByPane.set(pane, socket);
}
export function paneSocket(pane: string): string | null {
  return socketByPane.get(pane) ?? null;
}

export const LIST_CLIENTS_FORMAT = "#{client_tty} #{client_activity} #{client_session}";

export function tmuxArgs(socket: string, args: string[]): string[] {
  return ["-S", socket, ...args];
}

/** `list-clients -F` output: tty, activity (epoch seconds), session name (may contain spaces). */
export function parseListClients(stdout: string): TmuxClient[] {
  const out: TmuxClient[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^(\S+)\s+(\d+)\s+(.+)$/.exec(line.trim());
    if (!m) continue;
    out.push({ tty: m[1] ?? "", activity: Number(m[2]), session: m[3] ?? "" });
  }
  return out;
}

/** linux.md 4.1 step 2: the client with the highest client_activity. */
export function mostRecentClient(clients: TmuxClient[]): TmuxClient | null {
  let best: TmuxClient | null = null;
  for (const c of clients) if (best === null || c.activity > best.activity) best = c;
  return best;
}

/** `ps -t` takes the tty without /dev/ (e.g. pts/4). */
export function psTtyName(clientTty: string): string {
  return clientTty.replace(/^\/dev\//, "");
}

export async function listTmuxClients(exec: Exec, socket: string): Promise<TmuxClient[]> {
  const r = await exec("tmux", tmuxArgs(socket, ["list-clients", "-F", LIST_CLIENTS_FORMAT]));
  if (r.code !== 0) return [];
  return parseListClients(r.stdout);
}

/** linux.md 4.1 step 3: switch the client to the pane's window, then select the pane. */
export async function focusTmuxPane(exec: Exec, socket: string, pane: string, client: TmuxClient): Promise<boolean> {
  const steps = [
    tmuxArgs(socket, ["switch-client", "-c", client.tty, "-t", pane]),
    tmuxArgs(socket, ["select-window", "-t", pane]),
    tmuxArgs(socket, ["select-pane", "-t", pane]),
  ];
  for (const args of steps) {
    const r = await exec("tmux", args);
    if (r.code !== 0) return false;
  }
  return true;
}
