# Presentation

| File | What it is |
|---|---|
| `mission-control-overview.pptx` | 17-slide overview of every part of Mission Control, in the house deck style |
| `c4-context.svg` / `.png` | C4 level 1: Mission Control, the developer and the external systems |
| `c4-container.svg` / `.png` | C4 level 2: the six containers (Board UI, mc, mc-hook, daemon, VS Code bridge, state directory) |
| `how-it-works.svg` / `.png` | The six-step loop from an agent event to a restored window |
| `how-it-works.gif` | The same diagram, one step lit at a time (about 18 s, loops) |
| `src/` | The generators: `diagrams.py`, `render.mjs`, `build_deck.py` |

Rebuild everything with one command from the repo root:

```
pwsh docs/presentation/build.ps1
```

The last line must be `PRESENTATION BUILD PASS 5/5`.

The slide body text follows ASD-STE100 (Simplified Technical English): short sentences,
active voice, present tense, one idea in each sentence. Titles, kickers and the
launch-room footer lines do not follow it. They are about 20% of the text.

Facts in the slides and diagrams come from `docs/ARCHITECTURE.md`, `docs/USER-GUIDE.md`,
`docs/DESIGN.md`, `docs/platforms/`, D-36 and D-37 in `docs/DECISIONS.md`, and
`docs/validation/gate-windows-2026-11-12.log`. Change those first, then rebuild.
