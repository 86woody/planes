import type { Session } from "@mc/contracts";

/**
 * The Fleet terrain (DESIGN.md 3, 5): a line-scan relief seen at an angle, one pad per
 * project, a peak per session whose height is its activity. Imperative and outside React:
 * it owns the canvas, the camera and pointer input, and positions the HTML overlays
 * (callout pills, the selected card) that React renders inside the hero.
 */

export interface TerrainItem {
  id: string;
  callsign: string;
  region: string;
  state: Session["state"];
  /** Needs you (attention active and not dismissed). */
  needs: boolean;
  acked: boolean;
  /** Activity 0..1 (recency and rate of events, or the telemetry sample in preview). */
  activity: number;
  /** startedAt in ms, for a stable slot order inside a pad. */
  order: number;
}

export interface Marker {
  id: string;
  x: number;
  y: number;
  bx: number;
  by: number;
}

export interface Region {
  id: string;
  key: number;
  cx: number;
  cz: number;
  hw: number;
  hd: number;
  count: number;
}

interface Placed extends TerrainItem {
  x: number;
  z: number;
  h: number;
  phase: number;
}

interface Cam {
  tx: number;
  tz: number;
  d: number;
  yaw: number;
  pitch: number;
}

interface Colors {
  ink: string;
  ink2: string;
  ink3: string;
  grid: string;
  go: string;
  look: string;
  paper: string;
  gk: number;
  glow: number;
}

export interface TerrainCallbacks {
  onSelect(id: string | null): void;
  onTouched(touched: boolean): void;
  onRegion(region: string | null): void;
}

const PITCH: [number, number] = [0.42, 1.42];
const DIST: [number, number] = [300, 1400];
const G = 5; // grid step
const GR = 400; // grid half extent
const GN = (GR * 2) / G + 1;
const LS = 2; // a scan line every LS grid rows
const SANS = "Geist, ui-sans-serif, system-ui, sans-serif";
const MONO = '"Geist Mono", ui-monospace, monospace';

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
const sstep = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.trim().replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return [128, 128, 128];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgba(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

/** A stable phase per session id, so a frozen clock renders the same picture every time. */
function phaseOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 6283) / 1000;
}

/** D-51: ended sessions leave the map (the list keeps them under "Ended and lost"); lost stays. */
export function onMap(s: { state: string }): boolean {
  return s.state !== "ended";
}

/**
 * D-51: the overview distance grows with the regions' extent so every plate and its label fits
 * the card. 800 frames the 2x2 layout (half extents 252 x 184); fewer regions keep 800 (one keeps 640).
 */
export function overviewDistance(regions: readonly Region[]): number {
  if (regions.length <= 1) return 640;
  let ex = 0;
  let ez = 0;
  for (const r of regions) {
    ex = Math.max(ex, Math.abs(r.cx) + r.hw);
    ez = Math.max(ez, Math.abs(r.cz) + r.hd);
  }
  const k = Math.max(1, ex / 252, ez / 184);
  return Math.min(DIST[1], Math.round(800 * k));
}

/**
 * D-52: how far from a pad the base relief takes to reach full height. 70 for the concept's
 * 2x2 layout and fewer; with more pads, a fraction of the narrowest gap between two pads, so
 * the ground still rolls between closely packed pads (never under 14).
 */
export function reliefRise(regions: readonly Region[]): number {
  if (regions.length <= 4) return 70;
  let gap = Infinity;
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      const a = regions[i];
      const b = regions[j];
      if (!a || !b) continue;
      const gx = Math.abs(a.cx - b.cx) - a.hw - b.hw;
      const gz = Math.abs(a.cz - b.cz) - a.hd - b.hd;
      const g = Math.max(gx, gz);
      if (g > 0) gap = Math.min(gap, g);
    }
  }
  if (!Number.isFinite(gap)) return 70;
  return Math.max(14, Math.min(70, gap * 0.9));
}

/** Pads on a grid: 1 region centred and larger, 2..4 as 2 columns, 5..9 as 3, then wider. */
export function layoutRegions(ids: string[]): Region[] {
  const n = ids.length;
  if (n === 0) return [];
  const cols = n === 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  // D-52: past the 2x2 concept layout, pack the pads into a smaller central area so a rolling
  // margin stays around them (the concept's look); 2x2 and fewer are unchanged.
  const many = n > 4;
  const sx = Math.min(280, (many ? 560 : 720) / cols);
  const sz = Math.min(200, (many ? 400 : 520) / rows);
  const s = n === 1 ? 1.25 : Math.min(1, (sx - 24) / 224, (sz - 20) / 168);
  return ids.map((id, i) => {
    const r = Math.floor(i / cols);
    const inRow = r === rows - 1 ? n - r * cols : cols;
    const c = i - r * cols;
    return {
      id,
      key: i + 1,
      cx: (c - (inRow - 1) / 2) * sx,
      cz: (r - (rows - 1) / 2) * sz,
      hw: 112 * s,
      hd: 84 * s,
      count: 0,
    };
  });
}

export class Terrain {
  private readonly ctx: CanvasRenderingContext2D;
  private W = 0;
  private H = 0;
  private DPR = 1;
  private CX = 0;
  private CY = 0;
  private F = 600;
  private C: Colors = { ink: "#ece7dc", ink2: "#a9a398", ink3: "#706b62", grid: "#ece7dc", go: "#46cf8c", look: "#ff8a3b", paper: "#121110", gk: 0.22, glow: 1 };
  private readonly cam: Cam = { tx: 0, tz: 0, d: 800, yaw: -0.4, pitch: 0.92 };
  private rise = 70; // D-52: reliefRise(this.regions)
  private readonly camT: Cam = { ...this.cam };
  private regions: Region[] = [];
  private items: Placed[] = [];
  private sel: string | null = null;
  private hover: string | null = null;
  private focusKey = 0;
  private touched = false;
  private reduced = false;
  private active = true;
  private raf = 0;
  private last = 0;
  private drag: { x0: number; y0: number; moved: number; mode: "orbit" | "pan" | "pinch"; dist?: number; mx?: number; my?: number } | null = null;
  private vel = { yaw: 0, pitch: 0 };
  private lastMove = 0;
  private readonly ptrs = new Map<number, { x: number; y: number }>();
  private coSizes: Record<string, { w: number; h: number }> | null = null;
  private selSize: { w: number; h: number } | null = null;
  readonly markers: Marker[] = [];

  private readonly BASE = new Float32Array(GN * GN);
  private readonly HT = new Float32Array(GN * GN);
  private readonly HZ = new Float32Array(GN * GN);
  private readonly GW = new Float32Array(GN * GN);
  private readonly IN = new Uint8Array(GN * GN);
  private readonly PX = new Float32Array(GN * GN);
  private readonly PY = new Float32Array(GN * GN);
  private readonly PV = new Uint8Array(GN * GN);
  private readonly ro: ResizeObserver | null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly hero: HTMLElement,
    private readonly cb: TerrainCallbacks,
  ) {
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("2d canvas unavailable");
    this.ctx = ctx;
    for (let i = 0; i < GN; i++)
      for (let j = 0; j < GN; j++) {
        const x = -GR + j * G;
        const z = -GR + i * G;
        this.IN[i * GN + j] = (x / (GR * 0.98)) ** 2 + (z / (GR * 0.8)) ** 2 < 1 ? 1 : 0;
      }
    this.buildBase();
    this.readColors();
    canvas.addEventListener("pointerdown", this.onDown);
    canvas.addEventListener("pointermove", this.onMove);
    canvas.addEventListener("pointerup", this.onUp);
    canvas.addEventListener("pointercancel", this.onUp);
    canvas.addEventListener("pointerleave", this.onLeave);
    canvas.addEventListener("contextmenu", this.onContext);
    canvas.addEventListener("dblclick", this.onDbl);
    hero.addEventListener("wheel", this.onWheel, { passive: false });
    // Tests and tools read marker positions from the element (DESIGN.md 9).
    (canvas as HTMLCanvasElement & { mcMarkers?: Marker[] }).mcMarkers = this.markers;
    this.ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => this.resize()) : null;
    this.ro?.observe(canvas);
    this.resize();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.ro?.disconnect();
    const c = this.canvas;
    c.removeEventListener("pointerdown", this.onDown);
    c.removeEventListener("pointermove", this.onMove);
    c.removeEventListener("pointerup", this.onUp);
    c.removeEventListener("pointercancel", this.onUp);
    c.removeEventListener("pointerleave", this.onLeave);
    c.removeEventListener("contextmenu", this.onContext);
    c.removeEventListener("dblclick", this.onDbl);
    this.hero.removeEventListener("wheel", this.onWheel);
  }

  // ---------- inputs from the page ----------

  setData(items: TerrainItem[]): void {
    const ids = [...new Set(items.map((s) => s.region))].sort((a, b) => a.localeCompare(b));
    const changed = ids.length !== this.regions.length || ids.some((id, i) => this.regions[i]?.id !== id);
    if (changed) {
      this.regions = layoutRegions(ids);
      this.rise = reliefRise(this.regions);
      this.buildBase();
      if (this.focusKey > this.regions.length) this.focusKey = 0;
      if (!this.touched && this.focusKey === 0) this.setCam(this.overview(), true);
    }
    const prev = new Map(this.items.map((p) => [p.id, p]));
    const placed: Placed[] = [];
    for (const r of this.regions) {
      const inR = items.filter((s) => s.region === r.id).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
      r.count = inR.length;
      const m = inR.length;
      let c = Math.max(1, Math.ceil(Math.sqrt(m * (r.hw / r.hd))));
      const rows = Math.max(1, Math.ceil(m / c));
      c = Math.max(1, Math.ceil(m / rows));
      const dx = (2 * r.hw * 0.78) / c;
      const dz = (2 * r.hd * 0.72) / rows;
      inR.forEach((s, k) => {
        const row = Math.floor(k / c);
        const inRow = row === rows - 1 ? m - row * c : c;
        const col = k - row * c;
        const old = prev.get(s.id);
        const p: Placed = {
          ...s,
          x: r.cx + (col - (inRow - 1) / 2) * dx,
          z: r.cz + (row - (rows - 1) / 2) * dz,
          h: 0,
          phase: phaseOf(s.id),
        };
        p.h = old?.h ?? this.targetH(p);
        placed.push(p);
      });
    }
    this.items = placed;
    if (this.sel !== null && !placed.some((p) => p.id === this.sel)) this.sel = null;
    this.invalidateOverlays();
    this.request();
  }

  setSelected(id: string | null, fly: boolean): void {
    this.sel = id;
    const s = this.items.find((p) => p.id === id);
    const mk = s ? this.markers.find((o) => o.id === s.id) : undefined;
    const W = this.W;
    const H = this.H;
    const inView = mk !== undefined && mk.x > W * 0.18 && mk.x < W * 0.72 && mk.y > H * 0.2 && mk.y < H * 0.8;
    if (s && fly && !this.reduced && !inView) {
      this.setCam({ tx: s.x * 0.6, tz: s.z * 0.6, d: Math.min(this.cam.d, W < 500 ? 560 : 760) });
      this.markTouched(true);
    }
    this.invalidateOverlays();
    this.request();
  }

  setReduced(on: boolean): void {
    this.reduced = on;
    if (on) {
      this.vel = { yaw: 0, pitch: 0 };
      Object.assign(this.cam, this.camT);
    }
    this.request();
  }

  /** Pauses drawing (list view) and resumes it. */
  setActive(on: boolean): void {
    this.active = on;
    if (on) requestAnimationFrame(() => this.resize());
  }

  readColors(): void {
    const cs = getComputedStyle(document.documentElement);
    const g = (k: string): string => cs.getPropertyValue(k).trim();
    const num = (k: string, d: number): number => {
      const v = parseFloat(g(k));
      return Number.isFinite(v) ? v : d;
    };
    this.C = {
      ink: g("--c-ink") || this.C.ink,
      ink2: g("--c-ink2") || this.C.ink2,
      ink3: g("--c-ink3") || this.C.ink3,
      grid: g("--c-grid") || this.C.grid,
      go: g("--c-go") || this.C.go,
      look: g("--c-look") || this.C.look,
      paper: g("--c-paper") || this.C.paper,
      gk: num("--c-gridk", 0.22),
      glow: num("--c-glow", 1),
    };
    this.request();
  }

  invalidateOverlays(): void {
    this.coSizes = null;
    this.selSize = null;
    this.request();
  }

  reset(): void {
    this.markTouched(false);
    this.vel = { yaw: 0, pitch: 0 };
    if (this.focusKey !== 0) {
      this.focusKey = 0;
      this.cb.onRegion(null);
    }
    this.setCam(this.overview());
  }

  focusRegion(k: number): void {
    const r = this.regions[k - 1];
    if (!r) return;
    this.focusKey = k;
    this.cb.onRegion(r.id);
    this.setCam({ tx: r.cx, tz: r.cz + 6, d: this.W < 500 ? 620 : 470, yaw: this.camT.yaw, pitch: clamp(this.camT.pitch, 0.8, 1.1) });
    this.markTouched(true);
  }

  orbitKey(key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown"): void {
    this.markTouched(true);
    const st = 0.14;
    if (key === "ArrowLeft") this.camT.yaw += st;
    else if (key === "ArrowRight") this.camT.yaw -= st;
    else if (key === "ArrowUp") this.camT.pitch = clamp(this.camT.pitch + 0.08, PITCH[0], PITCH[1]);
    else this.camT.pitch = clamp(this.camT.pitch - 0.08, PITCH[0], PITCH[1]);
    if (this.reduced) Object.assign(this.cam, this.camT);
    this.request();
  }

  zoomKey(f: number): void {
    this.camT.d = clamp(this.camT.d * f, DIST[0], DIST[1]);
    if (this.reduced) this.cam.d = this.camT.d;
    this.markTouched(true);
    this.request();
  }

  get regionCount(): number {
    return this.regions.length;
  }

  // ---------- camera ----------

  private overview(): Cam {
    const narrow = this.W < 500;
    const d = overviewDistance(this.regions);
    return { tx: 0, tz: 8, d: narrow ? Math.max(600, Math.round(d * 0.75)) : d, yaw: -0.4, pitch: narrow ? 1.0 : 0.92 };
  }

  private setCam(t: Partial<Cam>, snap = false): void {
    Object.assign(this.camT, t);
    if (snap || this.reduced) Object.assign(this.cam, this.camT);
    this.request();
  }

  private markTouched(on: boolean): void {
    if (this.touched !== on) {
      this.touched = on;
      this.cb.onTouched(on);
    }
  }

  private P(x: number, y: number, z: number): { x: number; y: number; s: number; d: number } | null {
    const cam = this.cam;
    const dx = x - cam.tx;
    const dz = z - cam.tz;
    const cy = Math.cos(cam.yaw);
    const sy = Math.sin(cam.yaw);
    const rx = dx * cy - dz * sy;
    const rz = dx * sy + dz * cy;
    const cp = Math.cos(cam.pitch);
    const sp = Math.sin(cam.pitch);
    const vy = rz * sp + y * cp;
    const vz = rz * cp - y * sp;
    const d = cam.d + vz;
    if (d < 30) return null;
    const s = this.F / d;
    return { x: this.CX + rx * s, y: this.CY - vy * s, s, d };
  }

  private orbit(dYaw: number, dPitch: number): void {
    const cam = this.cam;
    cam.yaw += dYaw;
    cam.pitch = clamp(cam.pitch + dPitch, PITCH[0], PITCH[1]);
    this.camT.yaw = cam.yaw;
    this.camT.pitch = cam.pitch;
    this.markTouched(true);
  }

  private zoomBy(f: number): void {
    this.cam.d = clamp(this.cam.d * f, DIST[0], DIST[1]);
    this.camT.d = this.cam.d;
    this.markTouched(true);
  }

  private pan(dx: number, dy: number): void {
    const cam = this.cam;
    const s = this.F / cam.d;
    const sp = Math.max(0.3, Math.sin(cam.pitch));
    const rx = -dx / s;
    const rz = dy / (s * sp);
    const cy = Math.cos(cam.yaw);
    const sy = Math.sin(cam.yaw);
    cam.tx = clamp(cam.tx + rx * cy + rz * sy, -320, 320);
    cam.tz = clamp(cam.tz - rx * sy + rz * cy, -300, 300);
    this.camT.tx = cam.tx;
    this.camT.tz = cam.tz;
    this.markTouched(true);
  }

  // ---------- relief and heights ----------

  private relief(x: number, z: number): number {
    let md = 1e9;
    for (const m of this.regions) {
      const dx = Math.max(Math.abs(x - m.cx) - m.hw, 0);
      const dz = Math.max(Math.abs(z - m.cz) - m.hd, 0);
      md = Math.min(md, Math.hypot(dx, dz));
    }
    if (this.regions.length === 0) md = 70;
    const amp = sstep(Math.min(4, this.rise * 0.1), this.rise, md) * (0.55 + sstep(240, 420, Math.hypot(x, z)) * 1.3);
    return amp * (10 * Math.sin(x * 0.019 + 0.7) * Math.cos(z * 0.016 - 0.4) + 5.5 * Math.sin((x - z) * 0.034 + 1.9) + 2.5 * Math.cos(x * 0.07 + z * 0.05));
  }

  private buildBase(): void {
    for (let i = 0; i < GN; i++) for (let j = 0; j < GN; j++) this.BASE[i * GN + j] = this.relief(-GR + j * G, -GR + i * G);
  }

  private targetH(s: Placed | TerrainItem): number {
    if (s.state === "error") return 92;
    if (s.needs) return s.acked ? 64 : 88;
    if (s.state === "working") return 16 + s.activity * 38;
    switch (s.state) {
      case "starting":
        return 12;
      case "idle":
        return 7;
      case "ended":
        return 1.5;
      case "lost":
        return 3;
      default:
        return 6;
    }
  }

  private look(s: Placed): boolean {
    return s.needs || s.state === "error";
  }

  private buildHeights(t: number): void {
    const { HT, HZ, GW } = this;
    HT.set(this.BASE);
    HZ.fill(0);
    GW.fill(0);
    for (const s of this.items) {
      const look = this.look(s);
      const work = s.state === "working";
      const h = s.h + (work && !this.reduced ? Math.sin(t * 0.0016 + s.phase) * 2.5 : 0);
      const sg = look ? 10 : work ? 17 : 16;
      const R = Math.ceil((3.2 * sg) / G);
      const ci = Math.round((s.z + GR) / G);
      const cj = Math.round((s.x + GR) / G);
      for (let i = Math.max(0, ci - R); i <= Math.min(GN - 1, ci + R); i++) {
        for (let j = Math.max(0, cj - R); j <= Math.min(GN - 1, cj + R); j++) {
          const dx = -GR + j * G - s.x;
          const dz = -GR + i * G - s.z;
          const d2 = dx * dx + dz * dz;
          let w = Math.exp(-d2 / (2 * sg * sg));
          if (look) {
            // a ridged hazard peak, not a smooth hill
            const d = Math.sqrt(d2);
            const a = Math.atan2(dz, dx);
            w += 0.2 * Math.exp(-((d - 15) ** 2) / (2 * 6 * 6)) * (0.55 + 0.45 * Math.sin(a * 3 + s.phase));
          }
          const k = i * GN + j;
          HT[k] = (HT[k] ?? 0) + h * w;
          if (look) HZ[k] = Math.max(HZ[k] ?? 0, Math.min(1, (w * h) / 70));
          else if (work) GW[k] = Math.max(GW[k] ?? 0, w);
        }
      }
    }
  }

  private heightAt(x: number, z: number): number {
    const j = clamp(Math.round((x + GR) / G), 0, GN - 1);
    const i = clamp(Math.round((z + GR) / G), 0, GN - 1);
    return this.HT[i * GN + j] ?? 0;
  }

  // ---------- drawing ----------

  resize(): void {
    const r = this.canvas.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    this.DPR = Math.min(3, window.devicePixelRatio || 1);
    this.W = r.width;
    this.H = r.height;
    this.canvas.width = Math.max(1, Math.round(this.W * this.DPR));
    this.canvas.height = Math.max(1, Math.round(this.H * this.DPR));
    this.CX = this.W / 2;
    this.CY = this.H * (this.W < 500 ? 0.56 : 0.5);
    this.F = Math.max(260, Math.min(this.W * 1.02, this.H * 1.9));
    if (!this.touched && this.sel === null && this.focusKey === 0) this.setCam(this.overview(), true);
    this.invalidateOverlays();
    this.draw(performance.now());
  }

  /** Schedules a frame; full motion keeps the loop running while there is anything on the map. */
  request(): void {
    if (this.raf === 0) this.raf = requestAnimationFrame(this.loop);
  }

  private readonly loop = (t: number): void => {
    this.raf = 0;
    const dt = Math.min(0.1, Math.max(0, (t - (this.last || t)) / 1000));
    this.last = t;
    let moving = false;
    if (!this.drag && (this.vel.yaw !== 0 || this.vel.pitch !== 0)) {
      const ms = dt * 1000;
      this.orbit(this.vel.yaw * ms, this.vel.pitch * ms);
      const k = Math.pow(0.93, ms / 16.7);
      this.vel.yaw *= k;
      this.vel.pitch *= k;
      if (Math.abs(this.vel.yaw) < 1e-5 && Math.abs(this.vel.pitch) < 1e-5) this.vel = { yaw: 0, pitch: 0 };
      moving = true;
    }
    if (!this.drag) {
      const k = this.reduced ? 1 : 1 - Math.exp(-dt * 3.2);
      for (const key of ["tx", "tz", "d", "yaw", "pitch"] as const) {
        const diff = this.camT[key] - this.cam[key];
        if (Math.abs(diff) > 1e-4) moving = true;
        this.cam[key] += diff * k;
      }
    }
    const kh = this.reduced ? 1 : Math.min(1, dt * 2.4);
    for (const s of this.items) {
      const diff = this.targetH(s) - s.h;
      if (Math.abs(diff) > 0.05) moving = true;
      s.h += diff * kh;
    }
    this.draw(t);
    if (this.active && (moving || this.drag !== null || (!this.reduced && this.items.length > 0))) this.request();
  };

  private draw(t: number): void {
    if (!this.active || this.W === 0) return;
    const ctx = this.ctx;
    this.buildHeights(t);
    ctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
    ctx.clearRect(0, 0, this.W, this.H);
    this.drawPads();
    this.drawTerrain();
    this.vignette();
    this.padLabels();
    this.drawMarkers(t);
    this.placeOverlays();
  }

  private lineTo(a: { x: number; y: number } | null, b: { x: number; y: number } | null): void {
    if (!a || !b) return;
    this.ctx.moveTo(a.x, a.y);
    this.ctx.lineTo(b.x, b.y);
  }

  private drawPads(): void {
    const { ctx, C } = this;
    for (const m of this.regions) {
      const { hw, hd } = m;
      const foc = this.focusKey === m.key;
      const c = [this.P(m.cx - hw, 0, m.cz - hd), this.P(m.cx + hw, 0, m.cz - hd), this.P(m.cx + hw, 0, m.cz + hd), this.P(m.cx - hw, 0, m.cz + hd)];
      if (c.some((p) => !p)) continue;
      ctx.beginPath();
      c.forEach((p, i) => {
        if (!p) return;
        if (i) ctx.lineTo(p.x, p.y);
        else ctx.moveTo(p.x, p.y);
      });
      ctx.closePath();
      ctx.fillStyle = rgba(C.grid, foc ? 0.06 : 0.028);
      ctx.fill();
      ctx.strokeStyle = rgba(C.grid, foc ? 0.36 : 0.16);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.strokeStyle = rgba(C.grid, foc ? 0.9 : 0.5);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        const x = m.cx + sx * hw;
        const z = m.cz + sz * hd;
        this.lineTo(this.P(x, 0, z), this.P(x - sx * 20, 0, z));
        this.lineTo(this.P(x, 0, z), this.P(x, 0, z - sz * 16));
      }
      ctx.stroke();
      ctx.lineWidth = 1;
    }
  }

  private padLabels(): void {
    const { ctx, C } = this;
    for (const m of this.regions) {
      const foc = this.focusKey === m.key;
      const cs = ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([a, b]) => this.P(m.cx + a * m.hw, 0, m.cz + b * m.hd));
      const pts = cs.filter((p): p is NonNullable<typeof p> => p !== null);
      if (pts.length < 4) continue;
      // the nearest corner: the label sits in front of the pad, clear of its peaks
      const lp = pts.reduce((a, b) => (b.y > a.y ? b : a));
      const x = lp.x - 10;
      const y = lp.y + 4;
      ctx.textAlign = "left";
      ctx.font = `${this.W < 500 ? "400 11.5px" : "400 13px"} ${SANS}`;
      ctx.fillStyle = rgba(C.ink, foc ? 0.95 : 0.72);
      ctx.fillText(m.id, x + 2, y + 18);
      const w = ctx.measureText(m.id).width;
      if (this.W < 500) continue;
      ctx.font = `300 12px ${SANS}`;
      ctx.fillStyle = rgba(C.ink3, 1);
      ctx.fillText(`${m.count} session${m.count === 1 ? "" : "s"}`, x + 10 + w, y + 18);
    }
  }

  private drawTerrain(): void {
    const { ctx, C, HT, BASE, HZ, GW, PX, PY, PV, IN } = this;
    const cam = this.cam;
    const alongX = Math.abs(Math.cos(cam.yaw)) >= Math.abs(Math.sin(cam.yaw));
    for (let k = 0; k < GN * GN; k++) {
      if (!IN[k]) {
        PV[k] = 0;
        continue;
      }
      const i = (k / GN) | 0;
      const j = k - i * GN;
      const p = this.P(-GR + j * G, HT[k] ?? 0, -GR + i * G);
      if (p) {
        PX[k] = p.x;
        PY[k] = p.y;
        PV[k] = 1;
      } else PV[k] = 0;
    }
    const lines: { L: number; d: number }[] = [];
    for (let L = 0; L < GN; L += LS) {
      const mid = alongX ? this.P(0, 0, -GR + L * G) : this.P(-GR + L * G, 0, 0);
      if (mid) lines.push({ L, d: mid.d });
    }
    lines.sort((a, b) => b.d - a.d);
    const px = (k: number): number => PX[k] ?? 0;
    const py = (k: number): number => PY[k] ?? 0;
    for (const { L } of lines) {
      const idx = (m: number): number => (alongX ? L * GN + m : m * GN + L);
      let m0 = -1;
      let m1 = -1;
      for (let m = 0; m < GN; m++) {
        if (PV[idx(m)]) {
          if (m0 < 0) m0 = m;
          m1 = m;
        }
      }
      if (m0 < 0 || m1 - m0 < 2) continue;
      const lc = -GR + L * G;
      const fade = 1 - sstep(GR * 0.45, GR * 0.8, Math.abs(lc) * (alongX ? 1.15 : 0.95));
      // occlusion: fill under raised runs with the paper colour, back to front
      let run = -1;
      for (let m = m0; m <= m1 + 1; m++) {
        const k = m <= m1 ? idx(m) : -1;
        const raised = k >= 0 && (HT[k] ?? 0) - (BASE[k] ?? 0) > 0.8;
        if (raised && run < 0) run = Math.max(m0, m - 1);
        else if (!raised && run >= 0) {
          const e = Math.min(m1, m);
          ctx.beginPath();
          ctx.moveTo(px(idx(run)), py(idx(run)));
          for (let q = run + 1; q <= e; q++) ctx.lineTo(px(idx(q)), py(idx(q)));
          for (let q = e; q >= run; q--) {
            const kk = idx(q);
            const i = alongX ? L : q;
            const j = alongX ? q : L;
            const g = this.P(-GR + j * G, BASE[kk] ?? 0, -GR + i * G);
            if (g) ctx.lineTo(g.x, g.y);
          }
          ctx.closePath();
          ctx.fillStyle = C.paper;
          ctx.fill();
          run = -1;
        }
      }
      // the scan line itself
      ctx.beginPath();
      ctx.moveTo(px(idx(m0)), py(idx(m0)));
      for (let m = m0 + 1; m <= m1; m++) ctx.lineTo(px(idx(m)), py(idx(m)));
      ctx.lineWidth = 1;
      ctx.strokeStyle = rgba(C.grid, C.gk * (0.25 + 0.75 * fade));
      ctx.stroke();
      // hazard colouring near peaks that need you
      for (const [thr, a, lw] of [[0.2, 0.22, 1], [0.52, 0.9, 1.25]] as const) {
        ctx.beginPath();
        let on = false;
        for (let m = m0; m <= m1; m++) {
          const k = idx(m);
          if ((HZ[k] ?? 0) > thr) {
            if (!on) {
              const kp = idx(Math.max(m0, m - 1));
              ctx.moveTo(px(kp), py(kp));
              on = true;
            }
            ctx.lineTo(px(k), py(k));
          } else if (on) {
            ctx.lineTo(px(k), py(k));
            on = false;
          }
        }
        ctx.strokeStyle = rgba(C.look, a);
        ctx.lineWidth = lw;
        ctx.stroke();
      }
      // green-dotted crests for working sessions
      ctx.fillStyle = rgba(C.go, 0.85);
      for (let m = m0; m <= m1; m += 2) {
        const k = idx(m);
        if ((GW[k] ?? 0) > 0.42) ctx.fillRect(px(k) - 0.9, py(k) - 0.9, 1.8, 1.8);
      }
    }
    ctx.lineWidth = 1;
  }

  private vignette(): void {
    const { ctx, W, H, CX, CY, DPR } = this;
    ctx.save();
    ctx.globalCompositeOperation = "destination-in";
    const rx = W * 0.56;
    const ry = H * 0.66;
    ctx.setTransform(DPR * rx, 0, 0, DPR * ry, DPR * CX, DPR * CY);
    const g = ctx.createRadialGradient(0, 0, 0.6, 0, 0, 1);
    g.addColorStop(0, "rgba(0,0,0,1)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(-CX / rx - 1, -CY / ry - 1, W / rx + 2, H / ry + 2);
    ctx.restore();
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  private drawMarkers(t: number): void {
    const { ctx, C } = this;
    this.markers.length = 0;
    const T = this.reduced ? 0 : t;
    const focused = this.regions[this.focusKey - 1]?.id ?? null;
    for (const s of this.items) {
      const bp = this.P(s.x, 0, s.z);
      const top = this.P(s.x, this.heightAt(s.x, s.z) + 3, s.z);
      if (!bp || !top) continue;
      const nd = s.needs;
      const err = s.state === "error";
      const dead = s.state === "ended" || s.state === "lost";
      const isSel = s.id === this.sel;
      const isHov = s.id === this.hover;
      ctx.globalAlpha = focused !== null && focused !== s.region ? 0.4 : 1;
      if ((nd || err) && !(nd && s.acked && !err)) {
        const pulse = this.reduced ? 0.6 : 0.55 + 0.45 * Math.sin(T * 0.0025 + s.phase);
        const R = 46 * (C.glow ? 1 : 0.8);
        const rg = ctx.createRadialGradient(top.x, top.y, 0, top.x, top.y, R);
        rg.addColorStop(0, rgba(C.look, (C.glow > 0.8 ? 0.3 : 0.11) * pulse));
        rg.addColorStop(1, rgba(C.look, 0));
        ctx.fillStyle = rg;
        ctx.fillRect(top.x - R, top.y - R, R * 2, R * 2);
      }
      if (nd || err) {
        ctx.fillStyle = nd && s.acked && !err ? C.paper : C.look;
        ctx.strokeStyle = C.look;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(top.x, top.y, 3.6, 0, 7);
        ctx.fill();
        ctx.stroke();
      } else if (s.state === "working") {
        ctx.fillStyle = C.go;
        ctx.beginPath();
        ctx.arc(top.x, top.y, 2.8, 0, 7);
        ctx.fill();
      } else if (s.state === "idle" || s.state === "starting") {
        ctx.strokeStyle = rgba(s.state === "idle" ? C.go : C.ink2, 0.9);
        ctx.lineWidth = 1.2;
        if (s.state === "starting") ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.arc(top.x, top.y, 3, 0, 7);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.strokeStyle = rgba(C.ink3, 0.7);
        ctx.setLineDash([1.5, 2.5]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(top.x, top.y, 3.4, 0, 7);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (isSel) {
        const r = 11 + (this.reduced ? 0 : Math.sin(T * 0.004) * 1.5);
        ctx.strokeStyle = rgba(C.ink, 0.9);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(top.x, top.y, r, 0, 7);
        ctx.stroke();
      }
      // a quiet callsign for sessions without a pill
      if (!(nd || err) && !isSel && (this.W >= 500 || isHov)) {
        ctx.font = `400 11px ${MONO}`;
        ctx.textAlign = "left";
        ctx.fillStyle = rgba(isHov ? C.ink : C.ink3, dead ? 0.55 : isHov ? 1 : 0.95);
        ctx.fillText(s.callsign, top.x + 8, top.y + 4);
      }
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
      this.markers.push({ id: s.id, x: top.x, y: top.y, bx: bp.x, by: bp.y });
    }
  }

  /** Positions the HTML overlays that follow the terrain, and draws their leaders. */
  private placeOverlays(): void {
    const { ctx, C, W, H } = this;
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    const m0 = this.markers.find((o) => o.id === this.sel);
    const sc = this.hero.querySelector<HTMLElement>(".selc");
    if (m0 && sc && W >= 500) {
      if (!this.selSize) this.selSize = { w: sc.offsetWidth, h: sc.offsetHeight };
      const { w, h } = this.selSize;
      let x = m0.x + 34;
      let y = m0.y - h / 2;
      if (x + w > W - 14) x = m0.x - 34 - w;
      x = clamp(x, 14, Math.max(14, W - w - 14));
      y = clamp(y, 70, Math.max(56, H - h - 64));
      sc.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;
      sc.style.visibility = "visible";
      placed.push({ x, y, w, h });
      const right = x > m0.x;
      const ax = right ? x : x + w;
      const ay = clamp(m0.y, y + 20, y + h - 20);
      ctx.strokeStyle = rgba(C.ink, 0.45);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(m0.x + (right ? 12 : -12), m0.y);
      ctx.lineTo(ax, ay);
      ctx.stroke();
    } else if (sc) {
      // phone width: the card docks to the bottom of the hero by CSS; off the map: hidden
      sc.style.visibility = W < 500 && m0 ? "visible" : "hidden";
    }
    const els = Array.from(this.hero.querySelectorAll<HTMLElement>(".co"));
    if (!this.coSizes) {
      const sizes: Record<string, { w: number; h: number }> = {};
      for (const el of els) {
        // measure laid out but unseen, so a pill hidden last frame still gets a size
        const wasHidden = el.hidden;
        el.style.visibility = "hidden";
        el.hidden = false;
        sizes[el.dataset.id ?? ""] = { w: el.offsetWidth, h: el.offsetHeight };
        el.hidden = wasHidden;
      }
      // Never cache a zero size (measured while the list view hid the pills): try next frame.
      this.coSizes = Object.values(sizes).some((s) => s.w === 0) ? null : sizes;
      if (this.coSizes === null) this.request();
    }
    const sizes = this.coSizes ?? {};
    const items = els
      .map((el) => ({ el, m: this.markers.find((o) => o.id === el.dataset.id), sz: sizes[el.dataset.id ?? ""] }))
      .filter((o): o is { el: HTMLElement; m: Marker; sz: { w: number; h: number } } => o.m !== undefined && o.sz !== undefined && o.sz.w > 0);
    items.sort((a, b) => a.m.y - b.m.y);
    for (const el of els) if (!items.some((o) => o.el === el)) el.hidden = true;
    const top0 = W < 500 ? 62 : 70;
    const bot = H - (W < 500 ? 10 : 60);
    for (const it of items) {
      if (it.m.id === this.sel && m0 && W >= 500) {
        it.el.hidden = true;
        continue;
      }
      it.el.hidden = false;
      const { w, h } = it.sz;
      const hits = (px: number, py: number) =>
        placed.find((p) => px < p.x + p.w + 6 && px + w + 6 > p.x && py < p.y + p.h + 6 && py + h + 6 > p.y);
      const fit = (px: number, py: number): [number, number] => [
        clamp(px, 12, Math.max(12, W - w - 12)),
        clamp(py, top0, Math.max(top0, bot - h)),
      ];
      // Above-right of the peak by preference; otherwise the free spot nearest the peak,
      // beside it or just above or below whatever is already placed.
      const xs = [it.m.x + 16, it.m.x - 16 - w];
      const ys = [it.m.y - h - 22, it.m.y + 22, ...placed.flatMap((p) => [p.y - h - 6, p.y + p.h + 6])];
      const cands = xs.flatMap((px) => ys.map((py) => fit(px, py)));
      const first = cands[0] ?? fit(it.m.x + 16, it.m.y - h - 22);
      const dist = ([px, py]: [number, number]): number => Math.hypot(px + w / 2 - it.m.x, py + h / 2 - it.m.y);
      const free = hits(first[0], first[1])
        ? cands.filter(([px, py]) => !hits(px, py)).sort((a, b) => dist(a) - dist(b))[0]
        : first;
      const [x, y] = free ?? first;
      it.el.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;
      it.el.style.visibility = "visible";
      placed.push({ x, y, w, h });
      // leader from the peak to the pill
      const right = x > it.m.x - 4;
      const ex = right ? x + 10 : x + w - 10;
      const ey = y + h;
      ctx.strokeStyle = rgba(C.look, it.el.dataset.attention === "acked" ? 0.3 : 0.55);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(it.m.x, it.m.y - 6);
      ctx.lineTo(ex, ey > it.m.y ? y : ey);
      ctx.stroke();
    }
  }

  // ---------- pointer input (drag confined to the card) ----------

  private local(e: PointerEvent | MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private pick(x: number, y: number): Marker | null {
    let best: Marker | null = null;
    let bd = 28;
    for (const m of this.markers) {
      const d = Math.min(Math.hypot(m.x - x, m.y - y), Math.hypot(m.bx - x, m.by - y));
      if (d < bd) {
        bd = d;
        best = m;
      }
    }
    return best;
  }

  private readonly onDown = (e: PointerEvent): void => {
    if (!this.active) return;
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // capture can fail for synthetic pointers; dragging still works inside the canvas
    }
    this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.vel = { yaw: 0, pitch: 0 };
    Object.assign(this.camT, this.cam); // a drag cancels any flight in progress
    if (this.ptrs.size === 1) {
      this.drag = { x0: e.clientX, y0: e.clientY, moved: 0, mode: e.shiftKey || e.button === 2 ? "pan" : "orbit" };
    } else if (this.ptrs.size === 2) {
      const [a, b] = [...this.ptrs.values()];
      if (a && b) this.drag = { x0: 0, y0: 0, mode: "pinch", moved: 99, dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    }
    this.hero.classList.add("grabbing");
    this.canvas.focus({ preventScroll: true });
    e.preventDefault();
    this.request();
  };

  private readonly onMove = (e: PointerEvent): void => {
    const drag = this.drag;
    if (!drag) {
      const p = this.local(e);
      const m = this.pick(p.x, p.y);
      const id = m ? m.id : null;
      if (id !== this.hover) {
        this.hover = id;
        this.canvas.classList.toggle("hot", id !== null);
        this.request();
      }
      return;
    }
    const prev = this.ptrs.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (drag.mode === "pinch") {
      if (this.ptrs.size < 2) return;
      const [a, b] = [...this.ptrs.values()];
      if (!a || !b) return;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      if (dist > 0 && (drag.dist ?? 0) > 0) this.zoomBy((drag.dist ?? dist) / dist);
      this.pan(mx - (drag.mx ?? mx), my - (drag.my ?? my));
      drag.dist = dist;
      drag.mx = mx;
      drag.my = my;
      this.request();
      return;
    }
    drag.moved = Math.max(drag.moved, Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0));
    if (drag.moved < 4) return;
    if (drag.mode === "pan") this.pan(dx, dy);
    else {
      const dyaw = dx * 0.0055;
      const dp = dy * 0.004;
      this.orbit(dyaw, dp);
      const tnow = performance.now();
      const dt = Math.max(8, tnow - (this.lastMove || tnow - 16));
      this.vel.yaw = this.vel.yaw * 0.4 + (dyaw / dt) * 0.6;
      this.vel.pitch = this.vel.pitch * 0.4 + (dp / dt) * 0.6;
      this.lastMove = tnow;
    }
    this.request();
  };

  private readonly onUp = (e: PointerEvent): void => {
    if (!this.ptrs.has(e.pointerId)) return;
    this.ptrs.delete(e.pointerId);
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      // already released
    }
    const drag = this.drag;
    if (!drag) return;
    if (drag.mode === "pinch") {
      if (this.ptrs.size === 0) {
        this.drag = null;
        this.hero.classList.remove("grabbing");
      }
      return;
    }
    if (e.type === "pointerup" && drag.moved < 4) {
      // a still click selects
      const p = this.local(e);
      const m = this.pick(p.x, p.y);
      if (m) this.cb.onSelect(m.id === this.sel ? null : m.id);
      else if (this.sel !== null) this.cb.onSelect(null);
    }
    if (this.reduced || performance.now() - this.lastMove > 90) this.vel = { yaw: 0, pitch: 0 };
    this.drag = null;
    this.lastMove = 0;
    this.hero.classList.remove("grabbing");
    this.request();
  };

  private readonly onLeave = (): void => {
    if (!this.drag && this.hover !== null) {
      this.hover = null;
      this.canvas.classList.remove("hot");
      this.request();
    }
  };

  private readonly onContext = (e: Event): void => e.preventDefault();

  private readonly onDbl = (e: Event): void => {
    e.preventDefault();
    this.reset();
  };

  private readonly onWheel = (e: WheelEvent): void => {
    if (!this.active) return;
    const target = e.target as Element | null;
    if (target?.closest(".selc, .listv")) return;
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    this.zoomBy(Math.exp(clamp(dy, -200, 200) * (e.ctrlKey ? 0.006 : 0.0011)));
    this.request();
  };
}
