import type { IngestEnvelope } from "@mc/contracts";
import type { ReducerOptions } from "../src/attention.js";

export const BASE_MS = 1_700_000_000_000;
let tick = 0;

/** Valid envelope. sentAt comes from an incrementing counter, 1 s apart. */
export function envelope(
  event: string,
  payload: IngestEnvelope["payload"] = {},
  overrides: Partial<IngestEnvelope> = {},
): IngestEnvelope {
  const sentAt = BASE_MS + tick * 1000;
  tick += 1;
  return {
    v: 1,
    adapter: "claude-code",
    event,
    nativeSessionId: "s1",
    sentAt,
    seq: 0,
    payload,
    origin: {
      os: "windows",
      hookPid: 5151,
      agent: { pid: 4242, name: "claude.exe" },
      ancestry: [],
      tty: null,
      env: { WT_SESSION: "11111111-2222-3333-4444-555555555555" },
      console: { consoleHwnd: "0x00000000001A0B2C", ownerHwnd: "0x00000000001A0B30" },
    },
    ...overrides,
  };
}

export function opts(overrides: Partial<ReducerOptions> = {}): ReducerOptions {
  return { doneIsAttention: true, capturePromptText: true, shellNotifyAfterSeconds: 60, ...overrides };
}

/** Callsign allocator: MC-01, MC-02, ... */
export function alloc(): { nextCallsign(): string } {
  let n = 0;
  return { nextCallsign: () => `MC-${String(++n).padStart(2, "0")}` };
}

export const iso = (ms: number): string => new Date(ms).toISOString();
