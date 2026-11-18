# -*- coding: utf-8 -*-
"""Build docs/presentation/mission-control-overview.pptx in the house deck style.

Body copy follows ASD-STE100 (Simplified Technical English): short sentences, active
voice, present tense, one idea per sentence, approved verbs (use, show, send, start, stop,
find, keep, make sure). Titles, kickers and the launch-room footer captions are the
non-STE part (about 20%).
"""
import os
import sys

sys.path.insert(0, r"C:\Users\you\.claude\skills\pptx-deck-design\scripts")
from deck_lib import *  # noqa: F401,F403
from pptx.util import Inches

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_PATH = os.path.join(HERE, 'mission-control-overview.pptx')
I = Inches
EM = '\u2014'


def picture(slide, name, x, y, w=None, h=None):
    return slide.shapes.add_picture(os.path.join(HERE, name), x, y, width=w, height=h)


def circles(s):
    rect(s, I(8.6), I(-1.6), I(6.4), I(6.4), fill=C['card_dark2'], rounded=True, radius=0.5)
    rect(s, I(10.4), I(3.6), I(5.0), I(5.0), fill=C['bg_circle2'], rounded=True, radius=0.5)
    rect(s, 0, 0, I(0.14), SLIDE_H, fill=C['teal'])


def interstitial(statement, sub):
    s = add_slide(); set_bg(s, C['bg_dark'])
    simple_text(s, I(0.8), I(2.75), I(11.7), I(1.1), statement, 42, C['white'], bold=True,
                align=PP_ALIGN.CENTER)
    simple_text(s, I(0.8), I(3.95), I(11.7), I(0.6), sub, 18, C['teal'], bold=True,
                align=PP_ALIGN.CENTER)


# 1 ---------------------------------------------------------------- title --
def s01():
    s = add_slide(); set_bg(s, C['bg_dark']); circles(s)
    simple_text(s, I(0.8), I(1.2), I(8), I(0.4), 'L O C A L   C O N T R O L   P L A N E', 13,
                C['teal'], bold=True)
    simple_text(s, I(0.8), I(1.7), I(9), I(1.2), 'Mission Control', 72, C['white'], bold=True)
    simple_text(s, I(0.8), I(3.0), I(9), I(0.6), 'One board for every agent session.', 30,
                C['teal'], bold=True)
    simple_text(s, I(0.8), I(3.75), I(8.2), I(0.9),
                'It shows each session as a card. It tells you when a session needs you. '
                'It brings that window forward.', 16, C['md1'])
    code_block(s, I(0.8), I(5.0), I(6.2), I(1.35), [
        cmd_line('$ npm run mc -- start'),
        cmd_line('$ npm run mc -- open'),
        out_line('http://127.0.0.1:47800/'),
    ], dark=True)


# 2 ----------------------------------------------------------- what it is --
def s02():
    s = add_slide(); set_bg(s, C['bg_dark'])
    header(s, 'What It Is', '02', 'A daemon, a board and one hook for each agent', dark=True)
    card_stripe(s, I(0.6), I(2.35), I(6.0), I(4.2), C['teal'], True, 'Mission Control',
                'Mission Control is a local control plane. It shows each agent and terminal '
                'session on this machine as a card in the browser.\n\n'
                'When a session needs attention, the OS shows a notification. RESTORE brings '
                'the window forward and maximizes it.\n\n'
                'The daemon is one Node process for each OS user.', body_size=16.5)
    facts = [
        ('127.0.0.1:47800', 'The daemon binds the loopback address only. No data leaves the machine.'),
        ('Three operating systems', 'Windows 11, macOS 13 or later, and Linux (X11 and some Wayland compositors).'),
        ('Three agents and shells', 'Claude Code, Codex CLI and Copilot CLI. A shell prompt hook covers other terminals.'),
    ]
    for i, (t, b) in enumerate(facts):
        card_tick(s, I(6.85), I(2.35 + i * 1.45), I(5.88), I(1.3), C['teal'] if i % 2 == 0 else C['amber'],
                  True, t, b)


# 3 / 5 interstitials
def s03():
    interstitial('Ten agent sessions. Ten windows.', 'Which one needs you now?')


def s05():
    interstitial('One board. One alert. One button.', 'That is Mission Control.')


# 4 ------------------------------------------------------------- problem ---
def s04():
    s = add_slide(); set_bg(s, C['bg_light'])
    header(s, 'The Problem', '04', 'Agents wait, and you do not see it', dark=False)
    cards = [
        ('Sessions hide behind windows', 'Agents run in many terminals and VS Code windows. You cannot see all of them at the same time.'),
        ('Prompts wait without a sign', 'An agent stops and asks for permission. Nothing tells you. The agent waits until you find it.'),
        ('Finding the window takes time', 'You look through tabs, terminals and desktops. Then you find the correct session.'),
        ('Each agent sends events differently', 'Claude Code, Codex and Copilot use different hook systems. Each one needs its own adapter.'),
    ]
    for i, (t, b) in enumerate(cards):
        x = I(0.6 + (i % 2) * 6.17); y = I(2.3 + (i // 2) * 2.15)
        card_stripe(s, x, y, I(5.97), I(1.95), C['teal'] if i in (0, 3) else C['amber'], False, t, b,
                    body_size=13.5)
    footer_caption_split(s, 'A launch needs one flight director' + ' ' + EM, 'not ten separate radios.', False)


# 6 -------------------------------------------------------------- answer ---
def s06():
    s = add_slide(); set_bg(s, C['bg_dark'])
    header(s, 'The Answer', '06', 'A console card for each session', dark=True)
    cards = [
        ('Board', 'Each session is a card. The card shows the agent, project, branch, state and last prompt.'),
        ('Alerts', 'When a session needs permission or input, the card blinks. The OS shows a notification.'),
        ('RESTORE', 'One click brings the window forward and maximizes it. It selects the tab when it can.'),
        ('Local only', 'The daemon binds 127.0.0.1. A token, a cookie and a CSRF header protect each route.'),
    ]
    for i, (t, b) in enumerate(cards):
        x = I(0.6 + (i % 2) * 3.55); y = I(2.3 + (i // 2) * 2.1)
        card_tick(s, x, y, I(3.4), I(1.95), C['teal'] if i in (0, 3) else C['amber'], True, t, b,
                  body_size=12.5)
    code_block(s, I(7.85), I(2.3), I(4.88), I(4.05), [
        cmt_line('# connect the agents', space_before=0),
        cmd_line('$ npm run mc -- install claude-code'),
        cmd_line('$ npm run mc -- install codex'),
        cmd_line('$ npm run mc -- install copilot'),
        cmt_line('# start the daemon, open the board'),
        cmd_line('$ npm run mc -- start'),
        cmd_line('$ npm run mc -- open'),
        cmt_line('# check permissions for this OS'),
        cmd_line('$ npm run mc -- doctor'),
    ], dark=True)
    footer_caption_split(s, 'Every session reports to the board' + ' ' + EM, 'like every console reports to flight.', True)


# 7 ---------------------------------------------------------- C4 context ---
def s07():
    s = add_slide(); set_bg(s, C['bg_dark'])
    header(s, 'Architecture', '07', 'C4 level 1 ' + EM + ' the system and its neighbours', dark=True)
    h = I(4.75); w = int(h * 1600 / 960)
    picture(s, 'c4-context.png', int((SLIDE_W - w) / 2), I(1.95), h=h)
    footer_caption_split(s, 'Agents send events in. The OS shows alerts and moves windows.',
                         'Mission Control sits between them.', True)


# 8 -------------------------------------------------------- C4 container ---
def s08():
    s = add_slide(); set_bg(s, C['bg_dark'])
    header(s, 'Architecture', '08', 'C4 level 2 ' + EM + ' six containers on one machine', dark=True)
    h = I(4.85); w = int(h * 1600 / 1080)
    picture(s, 'c4-container.png', I(0.6), I(1.9), h=h)
    notes = [
        ('mc-hook', 'One short process for each event. It never blocks the agent.'),
        ('Daemon', 'It keeps all state. It is the only part that talks to the OS.'),
        ('State directory', 'The spool keeps events while the daemon is down.'),
    ]
    for i, (t, b) in enumerate(notes):
        card_tick(s, I(8.0), I(1.95 + i * 1.6), I(4.73), I(1.45), C['teal'] if i % 2 == 0 else C['amber'],
                  True, t, b, body_size=12.5)


# 9 ---------------------------------------------------------- the pieces ---
def s09():
    s = add_slide(); set_bg(s, C['bg_light'])
    header(s, 'The Pieces', '09', 'Eight packages in one npm workspace', dark=False)
    pkgs = [
        ('contracts', 'JSON Schemas, generated types and Ajv validators. It has no logic.'),
        ('core', 'Pure functions: the attention reducer, the session store and the notify policy. No I/O.'),
        ('platform', 'One adapter for each OS, and a fake adapter for tests. It finds and focuses windows.'),
        ('daemon', 'The Fastify server. It connects ingest, API, WebSocket, files and liveness to core.'),
        ('hook', 'mc-hook reads one event and sends it. It stops in 1.5 s or less and always exits 0.'),
        ('cli', 'mc starts and stops the daemon. It installs each hook and runs restore and doctor.'),
        ('ui', 'The React page: flight director bar, console grid, cards and pairing.'),
        ('vscode-bridge', 'An extension in each VS Code window. It reports terminals and focuses them.'),
    ]
    xs, cw = cols(4)
    for i, (t, b) in enumerate(pkgs):
        card_tick(s, xs[i % 4], I(2.3 + (i // 4) * 2.15), cw, I(1.95), C['teal'] if (i + i // 4) % 2 == 0 else C['amber'],
                  False, t, b, body_size=12)
    footer_caption_split(s, 'Imports go in one direction only:', 'contracts \u2190 core \u2190 platform \u2190 daemon.', False)


# 10 -------------------------------------------------------- how it works --
def s10():
    s = add_slide(); set_bg(s, C['bg_dark'])
    header(s, 'How It Works', '10', 'Six steps from agent event to restored window', dark=True)
    h = I(4.85); w = int(h * 1600 / 960)
    picture(s, 'how-it-works.png', int((SLIDE_W - w) / 2), I(1.9), h=h)


# 11 ------------------------------------------------------------- states ---
def s11():
    s = add_slide(); set_bg(s, C['bg_light'])
    header(s, 'Card States', '11', 'Eight states, named like a launch', dark=False)
    states = [
        ('T-MINUS', 'starting. The session starts. The lamp pulses.'),
        ('ASCENT', 'working. The agent works. A trace line moves across the header.'),
        ('GO/NO-GO', 'needs_permission. The agent asks for approval. The card is red and blinks.'),
        ('HOLD', 'needs_input. The agent waits for you. The label shows the time in this state.'),
        ('NOMINAL', 'idle. The turn is complete. A MECO tag shows until you acknowledge it.'),
        ('ANOMALY', 'error. The agent reports an error. The card is red and blinks.'),
        ('SPLASHDOWN', 'ended. The session stopped. RESTORE shows NO SIGNAL.'),
        ('LOS', 'lost. No process and no event for a set time. The border is dashed.'),
    ]
    xs, cw = cols(4)
    for i, (t, b) in enumerate(states):
        st, rest = b.split('. ', 1)
        x, y = xs[i % 4], I(2.3 + (i // 4) * 2.15)
        rect(s, x, y, cw, I(1.95), fill=C['card_light'], rounded=True, radius=0.07)
        rect(s, x + I(0.24), y + I(0.24), I(0.42), I(0.06), fill=C['teal'] if (i + i // 4) % 2 == 0 else C['amber'])
        simple_text(s, x + I(0.24), y + I(0.4), cw - I(0.48), I(0.4), t, 16, C['navy'], bold=True, font=FONT_CODE)
        simple_text(s, x + I(0.24), y + I(0.82), cw - I(0.48), I(0.3), st, 11.5, C['teal'], font=FONT_CODE)
        simple_text(s, x + I(0.24), y + I(1.12), cw - I(0.48), I(0.8), rest, 12, C['ml1'])
    footer_caption_split(s, 'Red means GO/NO-GO' + ' ' + EM, 'a human must make the call.', False)


# 12 ------------------------------------------------------------ adapters ---
def s12():
    s = add_slide(); set_bg(s, C['bg_dark'])
    header(s, 'Agent Adapters', '12', 'Five ways in, one envelope out', dark=True)
    rows = [
        ('Claude Code', 'npm run mc -- install claude-code', 'Command hooks start mc-hook. The installer keeps your hooks and makes a backup.'),
        ('Codex CLI', 'npm run mc -- install codex', 'Codex runs one notify program. mc chains your old program, so it continues to work.'),
        ('Copilot CLI', 'npm run mc -- install copilot', 'mc owns one file in ~/.copilot/hooks. The event comes in on stdin.'),
        ('Shells', 'npm run mc -- install shell', 'A prompt hook for bash, zsh and pwsh. Plain terminals get a card too.'),
        ('VS Code', 'npm run mc -- install vscode', 'The bridge maps each terminal to its session. It focuses the terminal on request.'),
    ]
    for i, (t, code, d) in enumerate(rows):
        y = I(2.2 + i * 0.86)
        rect(s, I(0.6), y, CONTENT_W, I(0.74), fill=C['card_dark'], rounded=True, radius=0.2)
        badge_circle(s, I(0.75), y + I(0.1), I(0.54), C['teal'] if i % 2 == 0 else C['amber'], str(i + 1),
                     label_color=C['bg_dark'], label_size=18)
        simple_text(s, I(1.5), y + I(0.17), I(2.2), I(0.4), t, 16, C['white'], bold=True)
        simple_text(s, I(3.7), y + I(0.2), I(3.7), I(0.4), code, 13, C['teal'], font=FONT_CODE)
        simple_text(s, I(7.45), y + I(0.05), I(5.15), I(0.64), d, 12, C['md1'], anchor=MSO_ANCHOR.MIDDLE)
    footer_caption_split(s, 'Each adapter sends the same ingest envelope' + ' ' + EM, 'one radio channel for every crew.', True)


# 13 ------------------------------------------------------------- restore ---
def s13():
    s = add_slide(); set_bg(s, C['bg_light'])
    header(s, 'RESTORE', '13', 'One button, three operating systems', dark=False)
    oses = [
        ('Windows 11', 'Win32 calls through koffi find, focus and maximize the window. UI Automation selects the '
                       'Windows Terminal tab. Toasts use Windows PowerShell 5.1.'),
        ('macOS 13+', 'AppleScript selects the Terminal.app or iTerm2 tab. Accessibility focuses other apps. '
                      'alerter or terminal-notifier shows the notification.'),
        ('Linux', 'wmctrl on X11. swaymsg, hyprctl, KWin or a GNOME extension on Wayland. D-Bus shows the '
                  'notification. Other compositors get FOCUS MANUALLY.'),
    ]
    xs, cw = cols(3)
    for i, (t, b) in enumerate(oses):
        card_stripe(s, xs[i], I(2.3), cw, I(2.35), C['teal'] if i % 2 == 0 else C['amber'], False, t, b,
                    body_size=12.5)
    chips = [('FOCUSED', 'Window and tab are correct.'), ('WINDOW ONLY', 'You select the tab.'),
             ('FLASHED', 'The OS flashed the icon.'), ('NO-GO <CODE>', 'RESTORE failed.'),
             ('FOCUS MANUALLY', 'mc copies the folder path.')]
    xs5, cw5 = cols(5)
    for i, (t, b) in enumerate(chips):
        rect(s, xs5[i], I(4.9), cw5, I(1.25), fill=C['navy'], rounded=True, radius=0.1)
        simple_text(s, xs5[i], I(5.03), cw5, I(0.4), t, 13.5, C['teal'] if i % 2 == 0 else C['amber'], bold=True,
                    font=FONT_CODE, align=PP_ALIGN.CENTER)
        simple_text(s, xs5[i] + I(0.1), I(5.48), cw5 - I(0.2), I(0.6), b, 12, C['md2'], align=PP_ALIGN.CENTER)
    footer_caption_split(s, 'The result chip stays for five seconds' + ' ' + EM, 'flight always reports back.', False)


# 14 ------------------------------------------------------------ security ---
def s14():
    s = add_slide(); set_bg(s, C['bg_dark'])
    header(s, 'Security', '14', 'Local, paired and handle-free', dark=True)
    cards = [
        ('Loopback only', 'The daemon binds 127.0.0.1. The Host header must match, so DNS rebinding gets a 421.'),
        ('Token on disk', 'Hooks, the bridge and the CLI send a bearer token. Only the current user can read the token file.'),
        ('Cookie and CSRF', 'The page uses a SameSite=Strict cookie. Each change also needs the X-MC-CSRF header.'),
        ('No window handles in the API', 'Each action takes a session ID only. The daemon keeps all window targets internal.'),
    ]
    for i, (t, b) in enumerate(cards):
        x = I(0.6 + (i % 2) * 6.17); y = I(2.3 + (i // 2) * 2.15)
        card_stripe(s, x, y, I(5.97), I(1.95), C['teal'] if i in (0, 3) else C['amber'], True, t, b,
                    body_size=13.5)
    footer_caption_split(s, 'The hook removes secrets with an allowlist.', 'The daemon applies the allowlist again.', True)


# 15 --------------------------------------------------------------- proof ---
def s15():
    s = add_slide(); set_bg(s, C['bg_light'])
    header(s, 'Proof', '15', 'One command says it works', dark=False)
    code_block(s, I(0.6), I(2.3), I(6.9), I(4.1), [
        cmd_line('$ npm run gate', size=13.5),
        out_line('STAGE typecheck PASS', size=13),
        out_line('STAGE e2e PASS', size=13),
        out_line('STAGE os PASS', size=13),
        out_line('STAGE system PASS', size=13),
        out_line('STAGE audit PASS  ids 384/384 (os=windows)', size=13),
        out_line('GATE m5 PASS 22/22', size=13.5),
        cmt_line('# real agent runs, with screenshots', size=13),
        cmd_line('$ ls docs/validation/agents', size=13.5),
        out_line('codex-board.png  copilot-board.png  ...', size=13),
    ], dark=False)
    card_stripe(s, I(7.75), I(2.3), I(4.98), I(4.1), C['teal'], False, 'What the gate shows',
                '\u2022 22 stages: types, lint, unit, integration, Playwright e2e, OS and system tests.\n'
                '\u2022 384 of 384 test IDs pass on Windows.\n'
                '\u2022 Real Codex and Copilot sessions made live cards. Their configs are back as before.\n'
                '\u2022 Open: the Linux gate, the macOS checks and the m5 tag.', body_size=13)


# 16 ----------------------------------------------------- getting started ---
def s16():
    s = add_slide(); set_bg(s, C['bg_dark'])
    header(s, 'Getting Started', '16', 'Six commands from clone to board', dark=True)
    steps = [
        ('npm install', 'Install the dependencies.'),
        ('npm run build', 'Build all eight packages.'),
        ('npm run mc -- install claude-code', 'Add the hooks. mc makes a backup first.'),
        ('npm run mc -- install vscode', 'Install the VS Code bridge.'),
        ('npm run mc -- start', 'Start the daemon. A second start exits without error.'),
        ('npm run mc -- open', 'Open the board and pair the browser.'),
    ]
    xs, cw = cols(3)
    for i, (c, d) in enumerate(steps):
        x, y = xs[i % 3], I(2.3 + (i // 3) * 2.0)
        rect(s, x, y, cw, I(1.8), fill=C['card_dark'], rounded=True, radius=0.07)
        badge_circle(s, x + I(0.25), y + I(0.25), I(0.6), C['teal'] if i % 2 == 0 else C['amber'], str(i + 1),
                     label_color=C['bg_dark'], label_size=20)
        simple_text(s, x + I(0.95), y + I(0.36), cw - I(1.0), I(0.45), c, 11, C['teal'], font=FONT_CODE, bold=True)
        simple_text(s, x + I(0.25), y + I(1.0), cw - I(0.5), I(0.7), d, 13, C['md1'])
    footer_caption_split(s, 'Something missing? Run npm run mc -- doctor.', 'It lists each fix for your OS.', True)


# 17 ------------------------------------------------------------- closing ---
def s17():
    s = add_slide(); set_bg(s, C['bg_dark']); circles(s)
    simple_text(s, I(0.8), I(1.2), I(11), I(1.0), 'Every session. One board. One button.', 40, C['white'], bold=True)
    simple_text(s, I(0.8), I(2.15), I(10), I(0.6),
                'Mission Control finds the session that needs you and brings it forward.', 18, C['md1'])
    ctas = [('Read', 'docs/USER-GUIDE.md tells you how to install, read the page and fix problems.'),
            ('Check', 'npm run mc -- doctor lists each permission and dependency for this OS.'),
            ('Prove', 'npm run gate runs every stage. The last line must say GATE m5 PASS.')]
    xs, cw = cols(3)
    for i, (t, b) in enumerate(ctas):
        card_tick(s, xs[i], I(3.3), cw, I(1.8), C['teal'] if i % 2 == 0 else C['amber'], True, t, b, body_size=13)
    simple_text(s, I(0.8), I(5.7), I(11), I(0.6), '$ npm run mc -- open', 24, C['teal'], bold=True, font=FONT_CODE)


for fn in [s01, s02, s03, s04, s05, s06, s07, s08, s09, s10, s11, s12, s13, s14, s15, s16, s17]:
    fn()
prs.save(OUT_PATH)
print('Saved:', OUT_PATH, 'slides:', len(prs.slides._sldIdLst))
