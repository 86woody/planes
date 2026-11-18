import { spawn } from "node:child_process";
import path from "node:path";

/** The part of a child process the host uses. A real ChildProcess satisfies it; tests pass a fake. */
export interface HostChild {
  readonly stdin: { write(chunk: string): boolean; on?(event: "error", listener: () => void): unknown };
  readonly stdout: {
    setEncoding(encoding: "utf8"): unknown;
    on(event: "data", listener: (chunk: string) => void): unknown;
  };
  on(event: "exit", listener: () => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}
export type SpawnFn = () => HostChild;

export type HostRequest =
  | { op: "show"; aumid: string; tag: string; group: string; xml: string }
  | { op: "remove"; aumid: string; tag: string; group: string }
  | { op: "history"; aumid: string };

export interface HostReply {
  id: number;
  ok: boolean;
  error?: string;
  tags?: string[];
}

export interface ToastHost {
  request(req: HostRequest): Promise<HostReply | null>;
  dispose(): void;
}

const FIRST_REQUEST_TIMEOUT_MS = 6000;
const REQUEST_TIMEOUT_MS = 2000;

export function powershellPath(systemRoot: string | undefined = process.env.SystemRoot): string {
  return path.win32.join(systemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** Spawns Windows PowerShell 5.1 running the toast host script. */
export function spawnToastHost(scriptPath: string): SpawnFn {
  return () =>
    spawn(
      powershellPath(),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] },
    );
}

interface Pending {
  resolve: (r: HostReply | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Manages one long-lived host process. Started lazily on the first request. A request that
 * times out kills the process; the next request starts a new one. Replies are matched by id.
 */
export function createToastHost(spawnFn: SpawnFn): ToastHost {
  let child: HostChild | null = null;
  let firstOfProcess = true;
  let nextId = 1;
  let buffer = "";
  const pending = new Map<number, Pending>();

  const settleAll = (): void => {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      pending.delete(id);
      p.resolve(null);
    }
  };

  const kill = (c: HostChild): void => {
    try {
      c.kill();
    } catch {
      // already gone
    }
  };

  const start = (): HostChild => {
    const c = spawnFn();
    child = c;
    firstOfProcess = true;
    buffer = "";
    // A host that died leaves EPIPE on stdin; the exit handler restarts it, so the error is swallowed here.
    c.stdin.on?.("error", () => {});
    c.stdout.setEncoding("utf8");
    c.stdout.on("data", (chunk: string) => {
      if (child !== c) return;
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
        if (line === "") continue;
        let reply: HostReply;
        try {
          reply = JSON.parse(line) as HostReply;
        } catch {
          continue;
        }
        const p = pending.get(reply.id);
        if (!p) continue;
        clearTimeout(p.timer);
        pending.delete(reply.id);
        p.resolve(reply);
      }
    });
    c.on("exit", () => {
      if (child !== c) return;
      child = null;
      settleAll();
    });
    return c;
  };

  const request = (req: HostRequest): Promise<HostReply | null> =>
    new Promise<HostReply | null>((resolve) => {
      const c = child ?? start();
      const id = nextId++;
      const timeoutMs = firstOfProcess ? FIRST_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
      firstOfProcess = false;
      const timer = setTimeout(() => {
        pending.delete(id);
        if (child === c) {
          child = null;
          settleAll();
        }
        kill(c);
        resolve(null);
      }, timeoutMs);
      pending.set(id, { resolve, timer });
      c.stdin.write(`${JSON.stringify({ id, ...req })}\n`);
    });

  return {
    request,
    dispose(): void {
      const c = child;
      child = null;
      settleAll();
      if (c) kill(c);
    },
  };
}
