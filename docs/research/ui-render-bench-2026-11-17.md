# Fleet Terrain and session table: render cost benchmark

Date: 2026-11-17. Lab: `labs/mc-ui-bench`. Raw data: `harness/out/raw-2026-11-17T06-16-56-568Z.json`.
Generated summary: `harness/out/summary-2026-11-17T06-16-56-568Z.md`. Screenshots: `harness/out/shots/`.
Repeat it with: `cd labs/mc-ui-bench/harness; node run.mjs --runs 3` (about 85 minutes).

## Question

What does the Fleet Terrain cost the system as it is (hand-written Canvas 2D) and as a
three.js scene? And what does a 1,000-session telemetry table cost in React 19 and in Svelte 5?
Measure idle CPU, memory, update latency and GPU activity on the same hardware.

## Answer

1. **The loop costs the most, not the renderer.** The terrain as shipped draws every frame, even when
   nothing changes. With 1,000 sessions it uses one full CPU core at idle, plus 16-20% of a core in the
   GPU process and 5-6% of the GPU. If it draws only when the data or the camera changes, idle drops to
   0.2% of a core and 0 frames. This is true for both engines. It is the one change worth making now.
2. **three.js does not make the terrain cheaper.** Each frame costs the same main-thread time
   (12.1 ms three.js, 12.3 ms Canvas 2D). three.js uses more memory: +46 MB renderer, +62 MB GPU
   process and +51 MB of video memory. The GPU process also uses 4 points more CPU. The bundle is
   17 times larger (147 kB against 8.4 kB gzipped). Keep the Canvas 2D engine.
3. **Svelte 5 updates the table about twice as fast as React 19.** For the table alone, p50 update
   latency is 21.5 ms against 40.0 ms, and CPU during updates is 2.5% against 4.8% of a core. The
   framework bundle is 15 kB against 61 kB gzipped. At idle the two are the same.
4. **An animating terrain slows the table.** While the terrain draws, the main thread is full. Table
   update latency goes up by about 10 ms in Svelte and 7-9 ms in React, with either engine.
5. **At 1,000 sessions the terrain cannot be read.** Peaks leave the frame and labels overlap
   (see `shots/`). This is a design problem. Neither engine changes it.

## Method

| Item | Value |
|---|---|
| Machine | dev-pc, Ryzen 7 7700X, Radeon RX 9070 XT (16 GB), display 2560x1440 at 75 Hz |
| Browser | Chromium 158.0.8127.18 (Playwright 1.65.0), headed, 1440x900, DSF 1, high-performance GPU |
| GPU path | `ANGLE (AMD Radeon RX 9070 XT, Direct3D11)`; WebGL and 2D canvas hardware accelerated |
| Data | 1,000 synthetic sessions, seed 42; each update changes 100 sessions |
| Runs | 3 per variant, a new browser per run, variant order shuffled per run |
| Phases | warm-up 10 s, idle 60 s, live 60 s (one update every 2 s, 30 updates), orbit 20 s |
| Sampling | once per second |

Variants (10): {React 19.1, Svelte 5.57} x {Canvas 2D shipped loop, Canvas 2D on-demand,
three.js shipped loop, three.js on-demand, no terrain}.

- **Shipped loop**: a `requestAnimationFrame` loop that runs while any session exists, as in
  mission-control today.
- **On-demand**: draw only after a data change, a camera move or a resize, and while the easing runs.
- **Canvas 2D engine**: a copy of mission-control's `terrain.ts`.
- **three.js engine**: three 0.187.0, pure WebGL (a glyph atlas made once at start, 4x MSAA). It
  matches the Canvas 2D image to 0.15-0.22% of pixels, and has no per-frame Canvas 2D calls or
  texture uploads.

How each value is measured:

- **CPU %**: percent of one core, from CDP `SystemInfo.getProcessInfo` cpuTime deltas, for the page
  renderer, the GPU process and the browser process. The page renderer is found with a test: it must
  be the only renderer whose CPU time rises during an 0.8 s busy loop in the page. Every process id is
  checked against `Win32_Process`. All 30 runs passed both checks.
- **Memory**: JS heap and DOM nodes from CDP `Performance.getMetrics`. Private bytes from
  `Get-Process`. Video memory from `\GPU Process Memory\Dedicated Usage`.
- **GPU 3D %**: `\GPU Engine(pid_<gpu>_*engtype_3D)\Utilization Percentage` for the GPU process. Only
  the in-use adapter counts. Its luid is mapped to its name through the DirectX registry keys. Only
  counter samples that lie fully inside the phase are used.
- **Update latency**: from the state change to the frame after the framework commits the DOM.
  The latency includes the wait for the next vsync (13.3 ms at 75 Hz).

Each table cell is the median over 3 runs. The spread across runs is small: CPU stays within
1 point and latency p50 within 2 ms.

## Results

### Idle (60 s, no updates)

| Variant | Renderer CPU % | GPU-proc CPU % | GPU 3D % | Frames | Renderer MB | GPU-proc MB | VRAM MB | JS heap MB |
|---|---|---|---|---|---|---|---|---|
| React, no terrain | 0.2 | 0.0 | 0.0 | 0 | 78 | 89 | 46 | 4.5 |
| Svelte, no terrain | 0.2 | 0.0 | 0.0 | 0 | 81 | 89 | 46 | 4.5 |
| React, 2D on-demand | 0.2 | 0.0 | 0.0 | 0 | 81 | 100 | 54 | 4.9 |
| Svelte, 2D on-demand | 0.2 | 0.0 | 0.0 | 0 | 82 | 100 | 54 | 5.0 |
| React, three on-demand | 0.3 | 0.0 | 0.0 | 0 | 127 | 165 | 105 | 11.5 |
| Svelte, three on-demand | 0.3 | 0.0 | 0.0 | 0 | 130 | 162 | 105 | 11.5 |
| React, 2D shipped | **98.8** | 16.4 | 4.7 | 4,556 | 229 | 150 | 104 | 30.2 |
| Svelte, 2D shipped | **98.7** | 16.6 | 4.8 | 4,554 | 231 | 152 | 104 | 14.3 |
| React, three shipped | **98.9** | 20.3 | 5.6 | 4,551 | 241 | 170 | 111 | 34.3 |
| Svelte, three shipped | **99.1** | 20.4 | 6.0 | 4,551 | 242 | 169 | 111 | 32.2 |

The shipped loop draws 75.9 frames per second at idle, which is the display rate.

### Live (an update every 2 s)

| Variant | Renderer CPU % | GPU-proc CPU % | GPU 3D % | Latency p50 ms | p95 ms | max ms |
|---|---|---|---|---|---|---|
| React, no terrain | 4.8 | 0.2 | 0.0 | 40.0 | 45.5 | 46.1 |
| Svelte, no terrain | 2.5 | 0.2 | 0.0 | **21.5** | 25.0 | 25.8 |
| React, 2D on-demand | 99.8 | 16.4 | 5.0 | 49.0 | 63.8 | 68.5 |
| Svelte, 2D on-demand | 99.9 | 16.4 | 5.0 | 33.9 | 37.2 | 37.4 |
| React, three on-demand | 99.0 | 20.5 | 5.6 | 46.6 | 59.5 | 62.7 |
| Svelte, three on-demand | 99.7 | 20.5 | 5.7 | 32.1 | 37.3 | 37.6 |
| React, 2D shipped | 98.0 | 16.3 | 5.0 | 47.2 | 60.5 | 61.5 |
| Svelte, 2D shipped | 97.4 | 16.3 | 5.0 | 32.4 | 36.6 | 39.1 |
| React, three shipped | 98.6 | 20.5 | 5.8 | 46.7 | 57.0 | 64.3 |
| Svelte, three shipped | 98.8 | 20.8 | 5.6 | 32.0 | 36.3 | 37.8 |

In this phase the on-demand variants draw almost all the time. The terrain eases each change over
about 2 s, and an update arrives every 2 s. If updates are less frequent, the on-demand variants
fall back to idle between them, and the shipped loop does not.

### Orbit (camera turns every frame, 20 s)

| Engine | fps | Renderer CPU % | GPU-proc CPU % | GPU 3D % | Script ms per frame |
|---|---|---|---|---|---|
| Canvas 2D | 74.9-75.0 | 98.5-99.0 | 16.8-17.0 | 5.4 | 12.3 |
| three.js | 74.6-74.7 | 100.8-102.2 | 21.6-22.9 | 6.3-6.4 | 12.1 |

Script ms per frame = CDP script seconds per second / fps. Both engines reach the 75 Hz cap. Both
use about 92% of the 13.3 ms frame budget on the main thread. On a 120 Hz or 144 Hz display (8.3 or
6.9 ms per frame), both would drop frames at 1,000 sessions. This run does not show which part of
the frame uses the time. A CPU profile would show it.

Renderer CPU above 100% is correct: the renderer has more than one thread (the main thread and
the compositor).

### Engineering cost

| Part | Source lines | Minified | Gzipped |
|---|---|---|---|
| Canvas 2D engine | 1,188 (2 files) | 21.1 kB | **8.4 kB** |
| three.js engine (with three) | 1,879 (3 files) | 577.6 kB | **147.2 kB** |
| React 19 host + framework | 114 (2 files) | 192.1 kB | **61.0 kB** |
| Svelte 5 host + framework | 99 (3 files) | 39.0 kB | **15.4 kB** |

Chunks are assigned to modules from the sourcemap `sources` of a second build. No size estimates.
A page loads its host chunk and its own engine chunk only.

The three.js engine also adds a dependency with its own release cycle. It took two rebuilds to reach
pixel parity with the Canvas 2D image. The parity suite (`labs/mc-ui-bench/parity/`) must run again
after every change to the terrain.

## Limits of this result

- One machine, one display (75 Hz), 3 runs. The ranges are small, but other GPUs, other refresh rates
  and laptops on battery are not measured.
- The data is synthetic. A real fleet is closer to 5-30 sessions than 1,000. At small counts the
  per-frame cost is lower, but the shipped loop still draws 75 frames per second at idle.
- Machine CPU before each run was 12.7-17.2% of all cores (other processes on the tower, such as the
  mission-control daemon and the voice bridge). The per-process values above do not include it.
- Each page load logs one 404 for `/favicon.ico`, because the lab server does not serve one. It has
  no effect on the results.
- The table has 1,000 DOM rows (about 20,000 nodes) and no virtualisation, in both frameworks.
  A virtual list would lower the React and Svelte numbers alike.

## Decision input

| Option | Idle CPU | Idle memory (renderer + GPU proc + VRAM) | Bundle | Work |
|---|---|---|---|---|
| Keep Canvas 2D, keep the loop (today) | ~1 core + 16% | 229 + 150 + 104 MB | 8 kB | none |
| **Keep Canvas 2D, draw on demand** | **0.2%** | **81 + 100 + 54 MB** | 8 kB | small: the lab engine already does it |
| three.js, draw on demand | 0.3% | 127 + 165 + 105 MB | 147 kB | port + parity suite |
| three.js, keep the loop | ~1 core + 20% | 241 + 170 + 111 MB | 147 kB | port + parity suite |

Framework: Svelte 5 is faster and smaller for the table. Only a rewrite of the UI would get that
gain. React with on-demand drawing is already at 0.2% idle.
