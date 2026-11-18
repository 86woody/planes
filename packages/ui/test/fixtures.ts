import type { Session, State } from "@mc/contracts";

export type SessionPatch = {
  [K in keyof Session]?: Session[K] extends object ? DeepPartial<Session[K]> : Session[K];
};
type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

// Vite resolves these at load time: packages/contracts/fixtures/sessions/<state>.json.
const FIXTURES = import.meta.glob("../../contracts/fixtures/sessions/*.json", {
  eager: true,
  import: "default",
}) as Record<string, Session>;

const isPlain = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

function merge(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return base;
  if (!isPlain(base) || !isPlain(patch)) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = merge(base[k], v);
  return out;
}

// Loads the fixture for a state and deep-applies the patch (nested objects merge, other values replace).
export function sessionIn(state: State, patch: SessionPatch = {}): Session {
  const base = FIXTURES[`../../contracts/fixtures/sessions/${state}.json`];
  if (base === undefined) throw new Error(`no session fixture for state ${state}`);
  return merge(structuredClone(base), patch) as Session;
}
