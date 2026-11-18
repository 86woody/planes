import { execFile, execFileSync } from "node:child_process";
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Auth, Clock, Paths } from "./internal.js";

const execFileAsync = promisify(execFile);

const PAIR_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PAIR_TTL_MS = 60_000;
const PAIR_MAX_WRONG = 5;
const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
const PERSIST_INTERVAL_MS = 60_000;
const SESSIONS_FILE = "browser-sessions.json";

interface SessionEntry {
  digest: Buffer; // sha256 of the raw cookie value; the cookie itself is never kept
  lastSeen: number;
}

interface LivePairCode {
  code: string; // normalised: upper case, no dash
  expiresAt: number;
  wrong: number;
}

function windowsUser(): string {
  return process.env.USERNAME ?? os.userInfo().username;
}

function icaclsArgs(file: string): string[] {
  return [file, "/inheritance:r", "/grant:r", `${windowsUser()}:F`];
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

function digestOf(cookie: string): Buffer {
  return createHash("sha256").update(cookie).digest();
}

/** api.md 2: csrf = base64url(HMAC-SHA256(key = token file contents, msg = cookie value)). */
function csrfOf(token: string, cookie: string): string {
  return createHmac("sha256", token).update(cookie).digest("base64url");
}

async function loadOrCreateToken(file: string): Promise<string> {
  try {
    return readFileSync(file, "utf8").trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const token = randomBytes(32).toString("base64url");
  writeFileSync(file, token, { mode: 0o600, flag: "wx" });
  if (process.platform === "win32") {
    try {
      await execFileAsync("icacls", icaclsArgs(file), { windowsHide: true });
    } catch {
      // Best effort: ACL restriction failed. The checkpoint records this case.
    }
  }
  return token;
}

/** Atomic write (temp + rename) with user-only permissions, like the token file. */
function writeSecretFile(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  if (process.platform === "win32") {
    try {
      execFileSync("icacls", icaclsArgs(tmp), { stdio: "ignore", windowsHide: true });
    } catch {
      // Best effort, as for the token file.
    }
  }
  renameSync(tmp, file);
}

function loadSessions(file: string): SessionEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: SessionEntry[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const { cookieSha256, lastSeen } = entry as Record<string, unknown>;
    if (typeof cookieSha256 !== "string" || !/^[0-9a-f]{64}$/.test(cookieSha256)) continue;
    if (typeof lastSeen !== "number" || !Number.isFinite(lastSeen)) continue;
    out.push({ digest: Buffer.from(cookieSha256, "hex"), lastSeen });
  }
  return out;
}

export async function createAuth(paths: Paths, clock: Clock): Promise<Auth> {
  mkdirSync(path.dirname(paths.tokenFile), { recursive: true });
  mkdirSync(paths.stateDir, { recursive: true });

  const token = await loadOrCreateToken(paths.tokenFile);
  const sessionsFile = path.join(paths.stateDir, SESSIONS_FILE);
  const sessions: SessionEntry[] = loadSessions(sessionsFile);
  let dirty = false;
  let lastWrite = clock.now();
  let live: LivePairCode | undefined;

  const persist = (): void => {
    const body = sessions.map((s) => ({ cookieSha256: s.digest.toString("hex"), lastSeen: s.lastSeen }));
    writeSecretFile(sessionsFile, JSON.stringify(body));
    dirty = false;
    lastWrite = clock.now();
  };

  // Write failures leave the state dirty so flush() or the next touch retries.
  const persistSafe = (): void => {
    try {
      persist();
    } catch {
      dirty = true;
    }
  };

  const sweep = (now: number): void => {
    let removed = false;
    for (let i = sessions.length - 1; i >= 0; i--) {
      const s = sessions[i];
      if (s && now - s.lastSeen > SESSION_IDLE_MS) {
        sessions.splice(i, 1);
        removed = true;
      }
    }
    if (removed) persistSafe();
  };

  const find = (cookie: string): SessionEntry | undefined => {
    const digest = digestOf(cookie);
    return sessions.find((s) => timingSafeEqual(s.digest, digest));
  };

  const touch = (s: SessionEntry, now: number): void => {
    s.lastSeen = now;
    dirty = true;
    if (now - lastWrite >= PERSIST_INTERVAL_MS) persistSafe();
  };

  return {
    token: () => token,

    issuePairCode() {
      const raw = Array.from({ length: 8 }, () => PAIR_ALPHABET.charAt(randomInt(PAIR_ALPHABET.length))).join("");
      const expiresAt = clock.now() + PAIR_TTL_MS;
      live = { code: raw, expiresAt, wrong: 0 };
      return {
        code: `${raw.slice(0, 4)}-${raw.slice(4)}`,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    },

    pair(input: string) {
      const now = clock.now();
      sweep(now);
      if (!live) return null;
      if (now >= live.expiresAt) {
        live = undefined;
        return null;
      }
      const normalised = input.trim().toUpperCase().replace(/-/g, "");
      if (!safeEqual(normalised, live.code)) {
        live.wrong += 1;
        if (live.wrong >= PAIR_MAX_WRONG) live = undefined;
        return null;
      }
      live = undefined; // single use
      const cookie = randomBytes(32).toString("base64url");
      sessions.push({ digest: digestOf(cookie), lastSeen: now });
      persistSafe();
      return { sessionCookie: cookie, csrf: csrfOf(token, cookie) };
    },

    checkBearer(header: string | undefined): boolean {
      if (header === undefined) return false;
      const presented = /^bearer (.+)$/i.exec(header)?.[1];
      return presented !== undefined && safeEqual(presented, token);
    },

    checkBrowser(cookie: string | undefined, csrf: string | undefined, method: string): boolean {
      if (!cookie) return false;
      const now = clock.now();
      sweep(now);
      const s = find(cookie);
      if (!s) return false;
      // GET and HEAD are safe methods; every other method needs the CSRF header.
      if (method !== "GET" && method !== "HEAD") {
        if (csrf === undefined || !safeEqual(csrf, csrfOf(token, cookie))) return false;
      }
      touch(s, now);
      return true;
    },

    csrfFor(cookie: string | undefined): string | null {
      if (!cookie) return null;
      const now = clock.now();
      sweep(now);
      const s = find(cookie);
      if (!s) return null;
      touch(s, now);
      return csrfOf(token, cookie);
    },

    async flush(): Promise<void> {
      sweep(clock.now());
      if (dirty) persist();
    },
  };
}
