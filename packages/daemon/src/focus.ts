import type { FocusResult, Host, IngestOrigin, Session, SessionId } from "@mc/contracts";
import { classifyHost, VSCODE_NAMES } from "@mc/core";
import type { FocusOptions, NativeWindow, ResolvedTarget } from "@mc/platform";
import type { BridgeWindow, DaemonDeps, FocusService } from "./internal.js";

type Deps = Pick<DaemonDeps, "clock" | "log" | "config" | "sessions" | "platform" | "bridges">;

/** The bridge window and terminal a VS Code session was matched to (vscode-bridge.md 5). */
interface Link {
  windowId: string;
  terminalId: string | null;
}

const full = (window: NativeWindow): ResolvedTarget => ({
  window,
  inner: null,
  capability: "full",
  reason: null,
});

export function createFocusService(deps: Deps): FocusService {
  const { clock, log, config, sessions, platform, bridges } = deps;
  const links = new Map<SessionId, Link>();
  const running = new Map<SessionId, Promise<FocusResult>>();

  const now = (): string => new Date(clock.now()).toISOString();
  const result = (status: FocusResult["status"], code: FocusResult["code"], detail: string): FocusResult => ({
    status,
    code,
    detail: detail.slice(0, 200),
    at: now(),
  });

  /** Unique VS Code window whose title matches the workspace or project name (vscode-bridge.md 5). */
  async function titleMatch(name: string | null): Promise<NativeWindow | null> {
    if (name === null || name === "") return null;
    const windows = await platform.listWindows([...VSCODE_NAMES]);
    const hits = windows.filter((w) => {
      const t = w.title;
      return t.includes(` - ${name} - `) || t.endsWith(` - ${name}`) || t === name;
    });
    return hits.length === 1 ? (hits[0] ?? null) : null;
  }

  async function resolveVSCode(
    id: SessionId,
    session: Session,
    origin: IngestOrigin,
    host: Host,
  ): Promise<ResolvedTarget> {
    const found = bridges.findForSession(origin, host.kind);
    if (found) {
      const bridgeWindow: BridgeWindow = found.window;
      links.set(id, { windowId: bridgeWindow.windowId, terminalId: found.terminalId });
      if (bridgeWindow.nativeWindow) return full(bridgeWindow.nativeWindow);
      const matched = await titleMatch(bridgeWindow.workspaceName);
      if (matched) {
        bridges.rebind(bridgeWindow.windowId, matched);
        return full(matched);
      }
      return { window: null, inner: null, capability: "none", reason: "vscode_window_unbound" };
    }
    const matched = await titleMatch(session.project);
    if (matched) return { window: matched, inner: null, capability: "window", reason: "vscode_bridge_missing" };
    return { window: null, inner: null, capability: "none", reason: "vscode_bridge_missing" };
  }

  async function resolve(id: SessionId): Promise<void> {
    const rec = sessions.get(id);
    if (!rec || !rec.origin) return;
    const origin = rec.origin;
    const prevResult = rec.session.restore.lastResult;
    const host = classifyHost(origin);
    links.delete(id);

    if (rec.session.state === "ended" || rec.session.state === "lost") {
      sessions.setRestore(
        id,
        host,
        { capability: "none", reason: "process_ended", lastResult: prevResult },
        null,
      );
      return;
    }

    // D-17: a remote session is shown, never restored; the platform is not asked (platform-adapter.md 4).
    const target: ResolvedTarget =
      host.kind === "remote"
        ? { window: null, inner: null, capability: "none", reason: "remote_session" }
        : host.kind === "vscode-terminal" || host.kind === "vscode-extension"
          ? await resolveVSCode(id, rec.session, origin, host)
          : await platform.resolveTarget(origin, host);

    sessions.setRestore(
      id,
      host,
      { capability: target.capability, reason: target.reason, lastResult: prevResult },
      target,
    );
  }

  /** One OS focus call, plus the bridge request when the session is bound to a VS Code window. */
  async function focusTarget(
    id: SessionId,
    session: Session,
    target: ResolvedTarget,
    opts: FocusOptions,
  ): Promise<FocusResult> {
    const res = await platform.focus(target, opts);
    const link = links.get(id);
    if (!link || res.code === "not_found" || res.status === "failed") return res;

    const msg =
      link.terminalId !== null
        ? { type: "focusTerminal" as const, terminalId: link.terminalId, maximizePanel: false }
        : { type: "focusAgentPanel" as const, adapter: session.adapter };
    const bridge = await bridges.request(link.windowId, msg);

    if (res.code === "flashed") return res;
    if (res.code !== "focused") return res;
    if (bridge.ok) return result("ok", "focused", bridge.detail);
    return result("partial", "focused_window_only", bridge.detail);
  }

  /** Focus with at most one re-resolve and one retry on not_found. */
  async function focusWithRetry(id: SessionId, source: "page" | "notification" | "cli"): Promise<FocusResult> {
    for (let attempt = 0; ; attempt++) {
      const rec = sessions.get(id);
      if (!rec) return result("failed", "not_found", "unknown session");
      const target = rec.target;
      if (!target || target.capability === "none") {
        return result("failed", "unsupported", target?.reason ?? "no_window_found");
      }
      const opts: FocusOptions = {
        maximize: config.get().restore?.maximize ?? "always",
        foregroundStrategy: config.get().restore?.windowsForegroundStrategy ?? "alt-key",
        fromActivation: source === "notification",
      };
      const res = await focusTarget(id, rec.session, target, opts);
      if (res.code !== "not_found" || attempt > 0) return res;
      const link = links.get(id);
      if (link) bridges.rebind(link.windowId, null);
      await resolve(id);
    }
  }

  function apply(id: SessionId, res: FocusResult): void {
    const ackOnRestore = config.get().restore?.ackOnRestore ?? true;
    sessions.apply({ kind: "restore_result", sessionId: id, result: res, ackOnRestore });
  }

  async function run(id: SessionId, source: "page" | "notification" | "cli"): Promise<FocusResult> {
    try {
      let rec = sessions.get(id);
      if (!rec) return result("failed", "not_found", "unknown session");
      if (!rec.target) {
        await resolve(id);
        rec = sessions.get(id);
        if (!rec) return result("failed", "not_found", "unknown session");
      }
      const res = await focusWithRetry(id, source);
      apply(id, res);
      return res;
    } catch (err) {
      log.error({ err: String(err), sessionId: id }, "restore failed");
      const res = result("failed", "error", String(err));
      try {
        apply(id, res);
      } catch (applyErr) {
        log.error({ err: String(applyErr), sessionId: id }, "restore_result apply failed");
      }
      return res;
    }
  }

  return {
    resolve(id) {
      return resolve(id).catch((err: unknown) => {
        log.error({ err: String(err), sessionId: id }, "resolve failed");
      });
    },
    restore(id, source) {
      const pending = running.get(id);
      if (pending) return pending;
      const p = run(id, source).finally(() => {
        running.delete(id);
      });
      running.set(id, p);
      return p;
    },
  };
}
