import type { FocusResult, StateResponse, TracesResponse } from "@mc/contracts";

// CSRF token (api.md 2): kept in memory and mirrored to sessionStorage so it survives a
// reload within the tab. Sent as X-MC-CSRF on POST and DELETE.
const CSRF_KEY = "mc.csrf";
let memoryCsrf: string | null = null;

function readStoredCsrf(): string | null {
  try {
    return sessionStorage.getItem(CSRF_KEY) ?? memoryCsrf;
  } catch {
    return memoryCsrf;
  }
}

function storeCsrf(value: string | null): void {
  memoryCsrf = value;
  try {
    if (value === null) sessionStorage.removeItem(CSRF_KEY);
    else sessionStorage.setItem(CSRF_KEY, value);
  } catch {
    // sessionStorage can be blocked; the in-memory copy still works for this page.
  }
}

/** Forgets the stored CSRF token (used when the daemon rejects it or on sign-out). */
export function forgetCsrf(): void {
  storeCsrf(null);
}

async function fetchCsrf(): Promise<string | null> {
  const r = await fetch("/api/csrf", { credentials: "same-origin" });
  if (!r.ok) return null;
  const body = (await r.json()) as { csrf: string };
  storeCsrf(body.csrf);
  return body.csrf;
}

async function ensureCsrf(): Promise<string | null> {
  return readStoredCsrf() ?? (await fetchCsrf());
}

/**
 * Mutating request. Sends X-MC-CSRF; on 403 refetches the token once and retries once.
 */
async function mutate(method: "POST" | "DELETE", path: string, body?: unknown): Promise<Response> {
  const send = (csrf: string | null): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (csrf !== null) headers["X-MC-CSRF"] = csrf;
    return fetch(path, {
      method,
      credentials: "same-origin",
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  };
  const first = await send(await ensureCsrf());
  if (first.status !== 403) return first;
  const fresh = await fetchCsrf();
  if (fresh === null) return first;
  return send(fresh);
}

export const api: {
  state(): Promise<StateResponse | "unpaired">;
  pair(code: string): Promise<boolean>;
  restore(id: string): Promise<FocusResult | null>;
  ack(id: string): Promise<void>;
  dismiss(id: string): Promise<void>;
  traces(id: string): Promise<TracesResponse | number>;
} = {
  async state() {
    const r = await fetch("/api/state", { credentials: "same-origin" });
    if (r.status === 401) return "unpaired";
    if (!r.ok) throw new Error(`GET /api/state failed: ${r.status}`);
    const state = (await r.json()) as StateResponse;
    if (readStoredCsrf() === null) await fetchCsrf();
    return state;
  },

  async pair(code) {
    const r = await fetch("/api/pair", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!r.ok) return false;
    const body = (await r.json()) as { csrf: string };
    storeCsrf(body.csrf);
    return true;
  },

  async restore(id) {
    const r = await mutate("POST", `/api/sessions/${encodeURIComponent(id)}/restore`, {});
    if (r.status === 429 || r.status === 404) return null;
    if (!r.ok) throw new Error(`restore failed: ${r.status}`);
    const body = (await r.json()) as { result: FocusResult };
    return body.result;
  },

  async ack(id) {
    const r = await mutate("POST", `/api/sessions/${encodeURIComponent(id)}/ack`, {});
    if (!r.ok) throw new Error(`ack failed: ${r.status}`);
  },

  async dismiss(id) {
    const r = await mutate("DELETE", `/api/sessions/${encodeURIComponent(id)}`);
    if (!r.ok) throw new Error(`dismiss failed: ${r.status}`);
  },

  async traces(id) {
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(id)}/traces`, {
        credentials: "same-origin",
      });
      if (r.status !== 200) return r.status;
      return (await r.json()) as TracesResponse;
    } catch {
      return 0;
    }
  },
};
