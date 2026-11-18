# Rebuild every file in docs/presentation from src/: SVG diagrams, PNGs, the GIF and the deck.
# Run from the repo root after `npm install`:  pwsh docs/presentation/build.ps1
# Needs: python (python-pptx), ffmpeg, the house deck skill (deck_lib.py), Playwright Chromium.
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
python -X utf8 "$here/src/diagrams.py"; if ($LASTEXITCODE) { throw 'diagrams failed' }
node "$here/src/render.mjs"; if ($LASTEXITCODE) { throw 'render failed' }
$list = foreach ($i in 0..7) {
  $d = if ($i -eq 0) { 1.4 } elseif ($i -eq 7) { 3 } else { 1.8 }
  "file 'step-$i.png'"; "duration $d"
}
($list + "file 'step-7.png'") | Set-Content -Encoding ascii "$here/frames/list.txt"
ffmpeg -y -loglevel error -f concat -safe 0 -i "$here/frames/list.txt" `
  -vf "fps=10,scale=1200:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=none" `
  -loop 0 "$here/how-it-works.gif"; if ($LASTEXITCODE) { throw 'gif failed' }
Remove-Item -Recurse -Force "$here/frames"
python -X utf8 "$here/src/build_deck.py"; if ($LASTEXITCODE) { throw 'deck failed' }
$want = 'c4-context.png', 'c4-container.png', 'how-it-works.png', 'how-it-works.gif', 'mission-control-overview.pptx'
$missing = $want | Where-Object { -not (Test-Path "$here/$_") }
if ($missing) { throw "missing: $missing" }
"PRESENTATION BUILD PASS $($want.Count)/$($want.Count)"
