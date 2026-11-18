import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FocusResult, Host, Session, State } from "@mc/contracts";
import { Card } from "../src/components/Card.js";
import { ListView } from "../src/components/ListView.js";
import { age, fixText, hms, hostBadge, resultText, signalOf, stateLabel, wait } from "../src/format.js";
import type { BoardActions, BoardState, DeckActions } from "../src/model.js";
import { sessionIn } from "./fixtures.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 2026-11-12T09:01:12Z: 01:01:12 after the fixtures' startedAt, 12 s after their lastEvent.
const NOW = Date.parse("2026-11-12T09:01:12.000Z");
const SINCE = "2026-11-12T09:00:00.000Z"; // 01:12 before NOW

const mounted: { root: Root; host: HTMLElement }[] = [];

afterEach(() => {
  for (const { root, host } of mounted.splice(0)) {
    act(() => root.unmount());
    host.remove();
  }
});

type Spy = ReturnType<typeof vi.fn>;
function makeActions(): BoardActions & { restore: Spy; ack: Spy; dismiss: Spy; copyCwd: Spy } {
  return { restore: vi.fn(), ack: vi.fn(), dismiss: vi.fn(), copyCwd: vi.fn(), pair: vi.fn(async () => true) };
}
function makeDeck(): DeckActions & { select: Spy; details: Spy; dismissAlert: Spy; copy: Spy; toggleMenu: Spy } {
  return { select: vi.fn(), details: vi.fn(), dismissAlert: vi.fn(), copy: vi.fn(), toggleMenu: vi.fn() };
}

function mount(node: ReactNode): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  act(() => root.render(node));
  return host;
}

function renderCard(
  session: Session,
  extra: { result?: FocusResult | null; pending?: boolean; menuOpen?: boolean; now?: number } = {},
) {
  const actions = makeActions();
  const deck = makeDeck();
  const host = mount(
    <Card
      session={session}
      now={extra.now ?? NOW}
      result={extra.result ?? null}
      pending={extra.pending ?? false}
      highlighted={false}
      actions={actions}
      selected={false}
      menuOpen={extra.menuOpen ?? false}
      deck={deck}
    />,
  );
  return { host, actions, deck };
}

function board(results: BoardState["results"] = {}): BoardState {
  return { link: "open", needsPairing: false, state: null, results, pending: {}, highlight: null };
}

function renderList(sessions: Session[], extra: { showEnded?: boolean; results?: BoardState["results"] } = {}) {
  const actions = makeActions();
  const deck = makeDeck();
  const host = mount(
    <ListView
      sessions={sessions}
      board={board(extra.results ?? {})}
      dismissed={{}}
      now={NOW}
      selected={null}
      showEnded={extra.showEnded ?? true}
      onToggleEnded={() => undefined}
      actions={actions}
      deck={deck}
    />,
  );
  return { host, actions, deck };
}

const q = (el: ParentNode, id: string): HTMLElement | null => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);

function hostOf(kind: Host["kind"], app: string | null = null, multiplexer: Host["multiplexer"] = null): Host {
  return { kind, app, os: "windows", display: "win32", multiplexer };
}

describe("cards, rows and formatting", () => {
  it("UC-01 stateLabel and signalOf cover all 8 states in plain words, two signal colours only", () => {
    const cases: [State, string, string][] = [
      ["starting", "Starting", "none"],
      ["working", "Working", "go"],
      ["needs_permission", "Needs permission", "look"],
      ["needs_input", "Needs input", "look"],
      ["idle", "Idle", "go"],
      ["error", "Error", "look"],
      ["ended", "Ended", "none"],
      ["lost", "Lost", "none"],
    ];
    for (const [state, label, signal] of cases) {
      const s = sessionIn(state, state === "idle" ? { attention: { active: false, reason: null, since: null } } : {});
      expect(stateLabel(s), state).toBe(label);
      expect(signalOf(s), state).toBe(signal);
    }
    const done = sessionIn("idle", { attention: { active: true, reason: "done", since: SINCE, acknowledged: false } });
    expect(stateLabel(done)).toBe("Done");
    expect(signalOf(done)).toBe("look");
  });

  it("UC-02 hostBadge texts in plain case, including VS Code · Claude and + tmux", () => {
    expect(hostBadge(hostOf("vscode-extension"))).toBe("VS Code · Claude");
    expect(hostBadge(hostOf("vscode-terminal"))).toBe("VS Code");
    expect(hostBadge(hostOf("windows-terminal"))).toBe("Windows Terminal");
    expect(hostBadge(hostOf("conhost"))).toBe("Console");
    expect(hostBadge(hostOf("macos-terminal"))).toBe("Terminal");
    expect(hostBadge(hostOf("iterm2"))).toBe("iTerm2");
    expect(hostBadge(hostOf("wezterm"))).toBe("WezTerm");
    expect(hostBadge(hostOf("kitty"))).toBe("kitty");
    expect(hostBadge(hostOf("remote"))).toBe("Remote");
    expect(hostBadge(hostOf("unknown"))).toBe("Unknown");
    expect(hostBadge(hostOf("linux-terminal", "gnome-terminal-server"))).toBe("gnome-terminal-server");
    expect(hostBadge(hostOf("linux-terminal", null))).toBe("Terminal");
    expect(hostBadge(hostOf("windows-terminal", null, { kind: "tmux", pane: "%3" }))).toBe("Windows Terminal + tmux");
  });

  it("UC-03 hms, wait and age formatting edge cases", () => {
    expect(hms(0)).toBe("00:00:00");
    expect(hms(999)).toBe("00:00:00");
    expect(hms(-5000)).toBe("00:00:00");
    expect(hms(Number.NaN)).toBe("00:00:00");
    expect(hms(123 * 3_600_000 + 4 * 60_000 + 5_000)).toBe("123:04:05");
    expect(hms(59_999)).toBe("00:00:59");
    expect(wait(0)).toBe("00:00");
    expect(wait(72_000)).toBe("01:12");
    expect(wait(3_600_000 + 5 * 60_000 + 9_000)).toBe("1:05:09");
    expect(wait(-1)).toBe("00:00");
    expect(age(0)).toBe("0s");
    expect(age(59_999)).toBe("59s");
    expect(age(60_000)).toBe("1m");
    expect(age(3_599_000)).toBe("59m");
    expect(age(3_600_000)).toBe("1h");
    expect(age(-1)).toBe("0s");
  });

  it("UC-04 fixText returns the DESIGN.md text for every RestoreReason", () => {
    const texts: Record<string, string> = {
      remote_session: "Remote session (SSH). Restore it from the machine it runs on.",
      no_window_found: "No window found for this session.",
      wayland_unsupported_compositor:
        "This Wayland compositor does not let apps focus windows. Focus it manually; cwd copied.",
      gnome_extension_missing: 'Install the "Window Calls" GNOME extension to enable restore.',
      macos_accessibility_denied: "Grant Accessibility: System Settings > Privacy & Security > Accessibility.",
      macos_automation_denied: "Grant Automation for this terminal: System Settings > Privacy & Security > Automation.",
      vscode_bridge_missing: "Install the bridge: npm run mc -- install vscode",
      vscode_window_unbound: "Click into this VS Code window once so Mission Control can learn it.",
      tab_not_addressable: "Window comes forward; pick the tab yourself.",
      multiplexer_detached: "tmux session has no attached client.",
      process_ended: "Session ended.",
    };
    for (const [reason, text] of Object.entries(texts)) expect(fixText(reason)).toBe(text);
    expect(fixText("platform_error", "Win32 refused the focus")).toBe("Win32 refused the focus");
    expect(fixText(null)).toBe("");
  });

  it("UC-05 a Needs you card renders its anatomy for a permission session", () => {
    const s = sessionIn("needs_permission", { attention: { since: SINCE } });
    const { host, deck } = renderCard(s);
    const card = q(host, "needs-card");
    expect(card?.getAttribute("data-state")).toBe("needs_permission");
    expect(card?.getAttribute("data-attention")).toBe("active");
    expect(q(host, "callsign")?.textContent).toBe("MC-03");
    expect(host.querySelector(".ad")?.textContent).toBe("CC");
    expect(q(host, "state-label")?.textContent).toBe("Needs permission");
    expect(q(host, "waited")?.textContent).toBe("01:12");
    expect(host.querySelector(".nc-msg")?.textContent).toBe("Claude needs permission to use Bash");
    expect(host.querySelector(".where")?.textContent).toBe("project · main");
    expect(q(host, "restore")?.textContent).toContain("Restore");
    expect(q(host, "more")?.getAttribute("aria-label")).toBe("More actions for MC-03");
    expect(card?.getAttribute("aria-labelledby")).toBe(host.querySelector(".cs")?.id);
    act(() => card?.click());
    expect(deck.select).toHaveBeenCalledWith(s.id);
  });

  it("UC-06 a starting session's list row reads Starting with its up time", () => {
    const { host } = renderList([sessionIn("starting")]);
    const row = q(host, "card");
    expect(row?.getAttribute("data-state")).toBe("starting");
    expect(q(host, "state-label")?.textContent).toBe("Starting");
    expect(q(host, "elapsed")?.textContent).toBe("01:01:12");
    expect(q(host, "host")?.textContent).toBe("Windows Terminal");
    expect(q(host, "capability")?.textContent).toBe("Full");
  });

  it("UC-07 a needs_input card reads Needs input with the time waited", () => {
    const s = sessionIn("needs_input", { attention: { active: true, reason: "input", since: SINCE, acknowledged: false } });
    const { host } = renderCard(s, { now: Date.parse("2026-11-12T09:01:20.000Z") });
    expect(q(host, "state-label")?.textContent).toBe("Needs input");
    expect(q(host, "waited")?.textContent).toBe("01:20");
  });

  it("UC-08 unacknowledged permission pulses and offers Acknowledge; acknowledged has neither", () => {
    const unacked = sessionIn("needs_permission", { attention: { active: true, reason: "permission", acknowledged: false } });
    const a = renderCard(unacked, { menuOpen: true });
    expect(q(a.host, "state-label")?.getAttribute("data-attention")).toBe("active");
    expect(q(a.host, "state-label")?.querySelector("i")).not.toBeNull();
    const ack = q(a.host, "ack");
    expect(ack).not.toBeNull();
    act(() => ack?.click());
    expect(a.actions.ack).toHaveBeenCalledWith(unacked.id);

    const acked = sessionIn("needs_permission", { attention: { active: true, reason: "permission", acknowledged: true } });
    const b = renderCard(acked, { menuOpen: true });
    expect(q(b.host, "needs-card")?.getAttribute("data-attention")).toBe("acked");
    expect(q(b.host, "state-label")?.querySelector("i")).toBeNull();
    expect(q(b.host, "state-label")?.classList.contains("look")).toBe(false);
    expect(q(b.host, "ack")).toBeNull();
    act(() => q(b.host, "dismiss-alert")?.click());
    expect(b.deck.dismissAlert).toHaveBeenCalledWith(acked.id);
  });

  it("UC-09 idle with done attention reads Done · review on its card and Done in the list", () => {
    const done = sessionIn("idle", {
      attention: { active: true, reason: "done", since: SINCE, acknowledged: false, message: "Turn complete" },
    });
    const a = renderCard(done);
    expect(q(a.host, "state-label")?.textContent).toBe("Done · review");
    const b = renderList([done]);
    expect(q(b.host, "state-label")?.textContent).toBe("Done");
    expect(q(b.host, "state-label")?.classList.contains("look")).toBe(true);
    expect(q(b.host, "ack")).not.toBeNull();
  });

  it("UC-10 an ended row has Restore disabled reading Ended and a Dismiss that deletes", () => {
    const { host, actions } = renderList([sessionIn("ended")]);
    const restore = q(host, "restore") as HTMLButtonElement;
    expect(restore.disabled).toBe(true);
    expect(restore.textContent).toContain("Ended");
    expect(q(host, "ack")).toBeNull();
    const dismiss = q(host, "dismiss") as HTMLButtonElement;
    expect(dismiss.textContent).toBe("Dismiss");
    act(() => dismiss.click());
    expect(actions.dismiss).toHaveBeenCalledWith("claude-code:fixture-ended");
    expect(q(host, "splashdown")).not.toBeNull();
  });

  it("UC-11 capability none: the button reads Copy cwd and calls copyCwd, not restore", () => {
    const s = sessionIn("needs_permission", { restore: { capability: "none", reason: "remote_session" } });
    const { host, actions } = renderCard(s);
    const restore = q(host, "restore") as HTMLButtonElement;
    expect(restore.disabled).toBe(false);
    expect(restore.textContent).toContain("Copy cwd");
    expect(restore.title).toBe("Remote session (SSH). Restore it from the machine it runs on.");
    act(() => restore.click());
    expect(actions.copyCwd).toHaveBeenCalledWith(s.id);
    expect(actions.restore).not.toHaveBeenCalled();
  });

  it("UC-12 result text for focused, window only, flashed, failed and focus manually", () => {
    const at = "2026-11-12T09:01:10.000Z";
    const cases: [FocusResult, string, string][] = [
      [{ status: "ok", code: "focused", detail: "", at }, "Focused", "go"],
      [{ status: "partial", code: "focused_window_only", detail: "", at }, "Window only", "none"],
      [{ status: "partial", code: "flashed", detail: "", at }, "Flashed in the taskbar", "none"],
      [{ status: "failed", code: "permission_denied", detail: "", at }, "Failed · permission denied", "look"],
      [{ status: "failed", code: "unsupported", detail: "FOCUS MANUALLY", at }, "Focus manually · cwd copied", "none"],
    ];
    for (const [result, text, signal] of cases) {
      expect(resultText(result)).toEqual({ text, signal });
      const { host } = renderCard(sessionIn("needs_permission"), { result });
      expect(q(host, "result")?.textContent).toBe(text);
    }
  });
});
