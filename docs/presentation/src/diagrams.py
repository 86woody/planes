# -*- coding: utf-8 -*-
"""Generate the mission-control diagrams as SVG (house deck palette).

Writes into docs/presentation/:
  c4-context.svg     C4 level 1: system context
  c4-container.svg   C4 level 2: containers
  how-it-works.svg   the six-step loop, all steps lit
  frames/step-N.svg  one frame per highlighted step (input for the GIF)

Facts come from docs/ARCHITECTURE.md, docs/DECISIONS.md (D-36, D-37) and README.md.
"""
import os
from html import escape

OUT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

BG = '#0F1B2D'; CARD = '#162740'; CARD2 = '#101824'; TEAL = '#00C2A8'; AMBER = '#FFB454'
MINT = '#7EE7B8'; WHITE = '#FFFFFF'; MD1 = '#AFBECF'; MD2 = '#C5D2E0'; MD3 = '#6E8299'
UI = "'Segoe UI', Arial, sans-serif"; CODE = "Consolas, 'Courier New', monospace"


def wrap(text, width_px, size):
    per = max(8, int(width_px / (size * 0.53)))
    out, line = [], ''
    for word in text.split():
        if len(line) + len(word) + 1 > per and line:
            out.append(line); line = word
        else:
            line = (line + ' ' + word).strip()
    if line:
        out.append(line)
    return out


def svg_open(w, h, title):
    return [f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">',
            f'<title>{escape(title)}</title>',
            '<defs>'
            f'<marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{MD2}"/></marker>'
            f'<marker id="ahT" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{TEAL}"/></marker>'
            '</defs>',
            f'<rect width="{w}" height="{h}" fill="{BG}"/>']


def text(x, y, s, size, color, weight=400, font=UI, anchor='start', opacity=1):
    return (f'<text x="{x}" y="{y}" font-family="{font}" font-size="{size}" fill="{color}" '
            f'font-weight="{weight}" text-anchor="{anchor}" opacity="{opacity}">{escape(s)}</text>')


def box(x, y, w, h, title, kind, desc, style='container', code_title=False):
    """C4 element. style: person | system | container | external | store."""
    fill, stroke, dash, accent = CARD, TEAL, '', TEAL
    if style == 'external':
        fill, stroke, dash, accent = CARD2, MD3, ' stroke-dasharray="6 4"', MD3
    elif style == 'person':
        stroke, accent = AMBER, AMBER
    elif style == 'system':
        fill = '#11314A'
    elif style == 'store':
        stroke, accent = AMBER, AMBER
    p = [f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="14" fill="{fill}" stroke="{stroke}" stroke-width="2"{dash}/>',
         f'<rect x="{x + 18}" y="{y + 16}" width="34" height="5" rx="2" fill="{accent}"/>']
    cx = x + w / 2
    p.append(text(cx, y + 50, title, 21, WHITE, 700, CODE if code_title else UI, 'middle'))
    p.append(text(cx, y + 72, kind, 13, accent if style != 'external' else MD2, 600, UI, 'middle'))
    for i, ln in enumerate(wrap(desc, w - 36, 14)):
        p.append(text(cx, y + 98 + i * 19, ln, 14, MD1, 400, UI, 'middle'))
    return p


def person(cx, y, title, desc):
    p = [f'<circle cx="{cx}" cy="{y + 26}" r="24" fill="{CARD}" stroke="{AMBER}" stroke-width="2"/>']
    p += box(cx - 160, y + 50, 320, 132, title, '[Person]', desc, 'person')
    return p


def arrow(x1, y1, x2, y2, label=None, lx=None, ly=None, dashed=False, both=False, color=MD2,
          lw=None, code=False):
    mk = 'ahT' if color == TEAL else 'ah'
    d = ' stroke-dasharray="7 5"' if dashed else ''
    start = f' marker-start="url(#{mk})"' if both else ''
    p = [f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{color}" stroke-width="2"{d}'
         f' marker-end="url(#{mk})"{start}/>']
    if label:
        lines = label.split('\n')
        lx = (x1 + x2) / 2 if lx is None else lx
        ly = (y1 + y2) / 2 if ly is None else ly
        width = lw or max(len(s) for s in lines) * 7.4 + 16
        hgt = len(lines) * 17 + 8
        p.append(f'<rect x="{lx - width / 2}" y="{ly - hgt / 2}" width="{width}" height="{hgt}" rx="6" fill="{BG}" opacity="0.92"/>')
        for i, s in enumerate(lines):
            p.append(text(lx, ly - hgt / 2 + 17 + i * 17, s, 13, MD2, 400, CODE if code else UI, 'middle'))
    return p


def legend(x, y):
    items = [(CARD, AMBER, '', 'Person'), (CARD, TEAL, '', 'Container (this repo)'),
             (CARD, AMBER, '', 'Data store'), (CARD2, MD3, ' stroke-dasharray="6 4"', 'External system')]
    p = []
    for i, (f, s, d, lab) in enumerate(items):
        xx = x + i * 230
        p.append(f'<rect x="{xx}" y="{y}" width="26" height="18" rx="4" fill="{f}" stroke="{s}" stroke-width="2"{d}/>')
        p.append(text(xx + 36, y + 14, lab, 14, MD1))
    return p


def save(name, parts):
    path = os.path.join(OUT, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(parts + ['</svg>']))
    print('wrote', path)


# ------------------------------------------------------------- C4 level 1 --
def c4_context():
    W, H = 1600, 960
    p = svg_open(W, H, 'Mission Control - C4 system context')
    p.append(text(60, 64, 'MISSION CONTROL', 15, TEAL, 700))
    p.append(text(60, 100, 'C4 level 1 — system context', 30, WHITE, 700))
    p += person(800, 40, 'Developer', 'Runs many agent sessions. Watches the board and restores windows.')
    p += box(560, 400, 480, 190, 'Mission Control', '[Software system, local only: 127.0.0.1:47800]',
             'Shows each agent and terminal session as a card. Raises an OS notification when a '
             'session needs attention. RESTORE brings the window forward and maximizes it.', 'system')
    p += box(60, 380, 340, 230, 'AI agents and shells', '[External: Claude Code, Codex CLI, Copilot CLI]',
             'Each agent runs in a terminal or in VS Code. Hooks (Claude Code, Copilot) and the notify '
             'program (Codex) send each event. A shell prompt hook covers plain terminals.', 'external')
    p += box(1200, 380, 340, 230, 'Operating system', '[External: Windows 11, macOS 13+, Linux]',
             'Window manager and notification centre. Toasts, D-Bus or terminal-notifier. '
             'Focus and maximize through Win32, AX, wmctrl or the compositor.', 'external')
    p += box(560, 700, 480, 170, 'VS Code', '[External: editor, one bridge extension per window]',
             'Hosts integrated terminals and the Claude Code panel. The bridge tells the daemon '
             'which terminal belongs to which session.', 'external')
    p += box(60, 720, 340, 150, 'Web browser', '[External]',
             'Shows the board page from the daemon. Cookie + CSRF pairing.', 'external')
    # arrows
    p += arrow(800, 224, 800, 398, 'Watches cards, clicks RESTORE\n(browser page)', ly=310)
    p += arrow(640, 200, 360, 378, 'Installs hooks\n(mc install)', lx=470, ly=270)
    p += arrow(402, 495, 558, 495, 'Hook events\n(stdin JSON, argv)', ly=455)
    p += arrow(1042, 470, 1198, 470, 'Notify, focus,\nmaximize', ly=432)
    p += arrow(1198, 540, 1042, 540, 'Toast click:\nmission-control://', ly=585, code=False)
    p += arrow(800, 592, 800, 698, 'WS /bridge/v1\n(bearer)', both=True, ly=645)
    p += arrow(402, 780, 640, 594, 'REST + WebSocket\n(cookie + CSRF)', both=True, lx=510, ly=690)
    p += arrow(1200, 380, 962, 200, 'Toast', lx=1100, ly=285)
    p += legend(60, 925)
    save('c4-context.svg', p)


# ------------------------------------------------------------- C4 level 2 --
def c4_container():
    W, H = 1600, 1080
    p = svg_open(W, H, 'Mission Control - C4 containers')
    p.append(text(60, 64, 'MISSION CONTROL', 15, TEAL, 700))
    p.append(text(60, 100, 'C4 level 2 — containers', 30, WHITE, 700))
    p += person(800, 30, 'Developer', 'Watches the board, clicks RESTORE, runs mc.')
    # system boundary
    p.append(f'<rect x="330" y="230" width="940" height="760" rx="18" fill="none" stroke="{TEAL}" stroke-width="2" stroke-dasharray="10 6" opacity="0.7"/>')
    p.append(text(350, 975, 'Mission Control [software system] — one machine, binds 127.0.0.1 only', 15, TEAL, 700))
    # containers
    p += box(680, 260, 240, 165, 'Board UI', '[Container: React 19, Vite]',
             'Console grid of cards. Pairing, WS patches, RESTORE button.')
    p += box(990, 260, 240, 165, 'mc', '[Container: Node CLI]',
             'start, stop, status, restore, doctor, install, uninstall.', code_title=True)
    p += box(345, 500, 225, 190, 'mc-hook', '[Container: Node CLI, koffi]',
             'One short process per event. Fingerprints PID, terminal and window. POSTs or spools. Exit 0 always.',
             code_title=True)
    p += box(660, 500, 280, 210, 'Daemon', '[Container: Node 22, Fastify 5]',
             'Ingest, reducer and store, REST + WebSocket API, notify policy, focus orchestrator, '
             'liveness poller, PlatformAdapter per OS.')
    p += box(990, 760, 240, 175, 'VS Code bridge', '[Container: VS Code extension]',
             'One per window. Reports terminals and PIDs. Focuses a terminal or the Claude panel.')
    p += box(560, 780, 300, 155, 'State directory', '[Data store: files]',
             'sessions.json, events.jsonl, spool/, token (user-only ACL).', 'store')
    # externals
    p += box(40, 470, 250, 250, 'AI agents and shells', '[External]',
             'Claude Code hooks, Codex notify (chained, D-37), Copilot CLI hooks (D-36), '
             'shell prompt hook.', 'external')
    p += box(1310, 470, 250, 220, 'Operating system', '[External]',
             'Toasts, D-Bus, terminal-notifier. Focus and maximize. mission-control:// URI handler.',
             'external')
    p += box(1310, 780, 250, 155, 'VS Code', '[External]', 'Integrated terminals, Claude Code panel.',
             'external')
    # arrows
    p += arrow(800, 214, 800, 258, 'Uses (browser)', lx=880, ly=236)
    p += arrow(962, 180, 1060, 258, 'Runs', lx=1040, ly=200)
    p += arrow(292, 640, 343, 640, 'Event', ly=618, lw=52)
    p += arrow(572, 640, 658, 640, 'POST\n/ingest/v1', ly=600, lw=90, code=True)
    p += arrow(470, 692, 600, 778, 'Spool when\ndaemon is down', dashed=True, lx=505, ly=745)
    p += arrow(800, 427, 800, 498, 'REST + WS\ncookie + CSRF', both=True, lx=870, ly=462)
    p += arrow(1060, 427, 920, 498, 'Bearer\nHTTP', lx=1030, ly=470)
    p += arrow(942, 560, 1308, 560, 'notify(), focus(), maximize', ly=540)
    p += arrow(1400, 468, 1200, 427, 'Toast click →\nmc restore <id>', lx=1330, ly=420, lw=150)
    p += arrow(760, 712, 730, 778, 'Read, write', lx=690, ly=745)
    p += arrow(930, 712, 1040, 758, 'WS /bridge/v1', both=True, lx=1010, ly=722, code=True)
    p += arrow(1232, 850, 1308, 850, 'Focus', ly=830)
    p += legend(60, 1035)
    save('c4-container.svg', p)


# ------------------------------------------------------------- how it works -
STEPS = [
    ('1', 'Agent event', 'An agent asks for permission, waits for input or ends a turn. Its hook starts mc-hook.',
     'PermissionRequest'),
    ('2', 'mc-hook', 'mc-hook reads the event and finds the terminal window. It sends the event to the daemon.',
     'POST /ingest/v1/events'),
    ('3', 'Daemon', 'The reducer sets the new state. The store keeps the session and its window target.',
     'working → needs_permission'),
    ('4', 'Board', 'The WebSocket sends the card to the page. The card turns red and the lamp blinks.',
     'GO/NO-GO'),
    ('5', 'Notification', 'The window is not in front, so the daemon shows an OS notification.',
     'toast · D-Bus · notifier'),
    ('6', 'Restore', 'Click the toast or RESTORE. The window comes forward, maximized. The alert is acknowledged.',
     'focus(target, maximize)'),
]
# positions: snake, 1-2-3 on top, 4-5-6 bottom right-to-left
POS = [(80, 250), (580, 250), (1080, 250), (1080, 620), (580, 620), (80, 620)]
SW, SH = 440, 270


def step_card(i, state):
    """state: off | on | done"""
    n, title, desc, code = STEPS[i]
    x, y = POS[i]
    accent = TEAL if i % 2 == 0 else AMBER
    op = {'off': 0.28, 'done': 0.6, 'on': 1}[state]
    stroke = accent if state == 'on' else MD3
    sw = 4 if state == 'on' else 1.5
    p = [f'<g opacity="{op}">']
    if state == 'on':
        p.append(f'<rect x="{x - 10}" y="{y - 10}" width="{SW + 20}" height="{SH + 20}" rx="22" fill="{accent}" opacity="0.14"/>')
    p.append(f'<rect x="{x}" y="{y}" width="{SW}" height="{SH}" rx="16" fill="{CARD}" stroke="{stroke}" stroke-width="{sw}"/>')
    p.append(f'<circle cx="{x + 52}" cy="{y + 54}" r="30" fill="{accent}"/>')
    p.append(text(x + 52, y + 64, n, 28, BG, 800, UI, 'middle'))
    p.append(text(x + 100, y + 64, title, 30, WHITE, 700))
    for k, ln in enumerate(wrap(desc, SW - 50, 19)):
        p.append(text(x + 26, y + 124 + k * 27, ln, 19, MD1))
    p.append(f'<rect x="{x + 22}" y="{y + SH - 64}" width="{SW - 44}" height="42" rx="8" fill="{CARD2}"/>')
    p.append(text(x + 38, y + SH - 36, code, 17, MINT if i in (3, 5) else TEAL, 400, CODE))
    p.append('</g>')
    return p


def link(a, b, state):
    """Arrow from step a to step b."""
    (ax, ay), (bx, by) = POS[a], POS[b]
    color = TEAL if state == 'on' else MD3
    op = {'off': 0.3, 'done': 0.65, 'on': 1}[state]
    if ay == by and bx > ax:
        x1, y1, x2, y2 = ax + SW + 6, ay + SH / 2, bx - 8, by + SH / 2
    elif ay == by:
        x1, y1, x2, y2 = ax - 6, ay + SH / 2, bx + SW + 8, by + SH / 2
    else:
        x1, y1, x2, y2 = ax + SW / 2, ay + SH + 6, bx + SW / 2, by - 8
    return [f'<g opacity="{op}">'] + arrow(x1, y1, x2, y2, color=color) + ['</g>']


def how_it_works(active=None, name='how-it-works.svg'):
    """active: None = everything lit; 0 = intro (all dim); 1..6 = that step on."""
    W, H = 1600, 960
    p = svg_open(W, H, 'How Mission Control works')
    p.append(text(80, 80, 'MISSION CONTROL', 16, TEAL, 700))
    p.append(text(80, 128, 'How it works — from agent event to restored window', 36, WHITE, 700))
    p.append(text(80, 172, 'One loop for every session on this machine. Nothing leaves 127.0.0.1.', 19, MD1))
    for i in range(6):
        if active is None:
            st = 'on'
        elif active == 0:
            st = 'off'
        else:
            st = 'on' if i + 1 == active else ('done' if i + 1 < active else 'off')
        p += step_card(i, st)
    for i in range(5):
        if active is None:
            st = 'on'
        elif active == 0:
            st = 'off'
        else:
            st = 'on' if i + 2 == active else ('done' if i + 2 < active else 'off')
        p += link(i, i + 1, st)
    # loop back: from 6 back to 1 (dashed) - the session continues
    lit = active is None or active == 7
    col = TEAL if lit else MD3
    p.append(f'<g opacity="{1 if lit else 0.35}">')
    p += arrow(56, 750, 56, 400, None, dashed=True, color=col)
    p.append(f'<text x="34" y="580" font-family="{UI}" font-size="15" fill="{MD2}" transform="rotate(-90 34 580)" text-anchor="middle">next event, same card</text>')
    p.append('</g>')
    if active and 1 <= active <= 6:
        p.append(text(800, 930, f'Step {active} of 6', 18, MD2, 600, UI, 'middle'))
    elif active == 0:
        p.append(text(800, 930, 'Six steps, one session', 18, MD2, 600, UI, 'middle'))
    else:
        p.append(text(800, 930, 'The card stays live until the session ends (SPLASHDOWN) or is lost (LOS).', 18, MD2, 600, UI, 'middle'))
    save(name, p)


if __name__ == '__main__':
    c4_context()
    c4_container()
    how_it_works()
    for s in range(0, 8):
        how_it_works(None if s == 7 else s, f'frames/step-{s}.svg')
