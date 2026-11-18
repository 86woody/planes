import type { FocusResult, Host } from "@mc/contracts";
import type { FocusOptions } from "../../types.js";

export type LinuxBackendName = "x11" | "sway" | "hyprland" | "kwin" | "gnome-extension" | "none";

/** A window as a Linux compositor or X server reports it. `id` is the backend's own handle. */
export interface LinuxWindow {
  id: string;
  pid: number;
  title: string;
  app: string;
  /** Position in stacking order (higher = nearer the top); list order where the backend has none. */
  stackIndex: number;
  minimized?: boolean;
  fullscreen?: number;
}

export interface LinuxBackend {
  list(): Promise<LinuxWindow[]>;
  active(): Promise<LinuxWindow | null>;
  focus(w: LinuxWindow, opts: FocusOptions): Promise<FocusResult>;
}

/** linux.md 1, first match wins. `host` null means the display comes from the environment alone. */
export function selectBackend(
  config: { linux?: { waylandBackend?: LinuxBackendName | "auto" } },
  displayEnv: NodeJS.ProcessEnv,
  host: Pick<Host, "display"> | null,
): LinuxBackendName {
  const override = config.linux?.waylandBackend;
  if (override !== undefined && override !== "auto") return override;
  const display =
    host?.display ?? (nonEmpty(displayEnv.WAYLAND_DISPLAY) ? "wayland" : nonEmpty(displayEnv.DISPLAY) ? "x11" : null);
  if (display === "x11") return "x11";
  if (nonEmpty(displayEnv.SWAYSOCK)) return "sway";
  if (nonEmpty(displayEnv.HYPRLAND_INSTANCE_SIGNATURE)) return "hyprland";
  const desktop = displayEnv.XDG_CURRENT_DESKTOP ?? "";
  if (desktop.includes("KDE")) return "kwin";
  if (desktop.includes("GNOME")) return "gnome-extension";
  return "none";
}

function nonEmpty(v: string | undefined): boolean {
  return v !== undefined && v !== "";
}

export function focusResult(code: FocusResult["code"], detail = ""): FocusResult {
  const status: FocusResult["status"] =
    code === "focused" ? "ok" : code === "focused_window_only" || code === "flashed" ? "partial" : "failed";
  return { status, code, detail: detail.slice(0, 200), at: new Date().toISOString() };
}

/** Polls `check` every 25 ms for up to 500 ms (linux.md 3.1). */
export async function pollUntil(check: () => Promise<boolean>, timeoutMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise<void>((r) => setTimeout(r, 25));
  }
}
