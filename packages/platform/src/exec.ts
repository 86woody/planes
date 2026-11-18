import { spawn } from "node:child_process";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}
export type Exec = (
  file: string,
  args: string[],
  opts?: {
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    input?: string;
    /** Windows: pass args to the child unquoted (needed for `cmd.exe /s /c "<line>"`). */
    windowsVerbatimArguments?: boolean;
  },
) => Promise<ExecResult>;

const DEFAULT_TIMEOUT_MS = 3000;

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
    } catch {
      // best effort
    }
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

/** Spawn without a shell. Never rejects: spawn errors come back as {code: null, stderr}. */
export const exec: Exec = (file, args, opts = {}) =>
  new Promise<ExecResult>((resolve) => {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let stdout = "";
    let stderr = "";
    let settled = false;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, {
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: opts.windowsVerbatimArguments ?? false,
        env: opts.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ code: null, stdout, stderr: err instanceof Error ? err.message : String(err), timedOut: false });
      return;
    }

    const timer = setTimeout(() => {
      killTree(child.pid);
      finish({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);

    function finish(r: ExecResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => {
      stdout += d;
    });
    child.stderr?.on("data", (d: string) => {
      stderr += d;
    });
    child.on("error", (err) => {
      finish({ code: null, stdout, stderr: err.message, timedOut: false });
    });
    child.on("close", (code) => {
      finish({ code, stdout, stderr, timedOut: false });
    });

    try {
      child.stdin?.on("error", () => {});
      child.stdin?.end(opts.input ?? "");
    } catch {
      // process already gone; the close/error handler settles the promise
    }
  });

/** `where` on Windows, `command -v` through /bin/sh elsewhere. Resolves the first path or null. */
export async function which(cmd: string): Promise<string | null> {
  const r =
    process.platform === "win32"
      ? await exec("where", [cmd])
      : await exec("/bin/sh", ["-c", 'command -v "$1"', "sh", cmd]);
  if (r.code !== 0) return null;
  const first = r.stdout.split(/\r?\n/).find((l) => l.trim() !== "");
  return first === undefined ? null : first.trim();
}

const MAX_CONCURRENT = 4;
let running = 0;
const waiting: Array<() => void> = [];

function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => waiting.push(resolve));
}

function release(): void {
  const next = waiting.shift();
  if (next !== undefined) next();
  else running--;
}

/** Limits concurrent helper runs to 4. */
export const semaphore: { run<T>(f: () => Promise<T>): Promise<T> } = {
  async run<T>(f: () => Promise<T>): Promise<T> {
    await acquire();
    try {
      return await f();
    } finally {
      release();
    }
  },
};
