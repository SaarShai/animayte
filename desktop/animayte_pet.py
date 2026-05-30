#!/usr/bin/env python3
"""
animayte — native floating desktop pet (zero dependencies, stdlib only).

A borderless, always-on-top, draggable pixel slime window. Launched by the
Claude Code plugin command `/animayte`. If the animayte daemon is running on
:4321 it will also react to your live session (mood + context fullness);
otherwise it just idles happily.

Controls:  drag = move   ·   right-click or Esc = close
Requires:  python3 with tkinter (macOS system python has it).
"""
import tkinter as tk
import math, time, json, threading
from urllib.request import urlopen

PORT = 4321
SCALE = 5                      # pixels per art-cell
GW, GH = 38, 34                # art grid (cells)
W, H = GW * SCALE, GH * SCALE + 16

# ---- palette ----
P = {
    'lite': '#baf6d4', 'base': '#6fe0ad', 'mid': '#4cc592', 'dark': '#2f9e72', 'out': '#1b684c',
    'white': '#ffffff', 'pup': '#2c3642', 'cheek': '#ff96b2', 'mouth': '#46303a',
    'sweat': '#7dc6ff', 'star': '#fff096', 'shadow': '#cfe6da',
}

state = {'mood': 'happy', 'fullness': 0.15, 'phase': 'alive'}

# ---- daemon poll (optional; never fatal) ----
def poll():
    while True:
        try:
            with urlopen(f'http://127.0.0.1:{PORT}/health', timeout=1.2) as r:
                s = json.load(r).get('state', {})
                m = s.get('mood', 'idle')
                state['mood'] = {'tired': 'sleepy', 'listening': 'idle', 'bashful': 'happy',
                                 'excited': 'excited'}.get(m, m if m in ('happy','working','oops','idle') else 'idle')
                state['fullness'] = float(s.get('fullness', state['fullness']))
                state['phase'] = s.get('phase', 'alive')
        except Exception:
            pass
        time.sleep(1.5)

# ---- window ----
root = tk.Tk()
root.title('animayte')
root.overrideredirect(True)            # borderless
try: root.wm_attributes('-topmost', True)   # always on top
except Exception: pass

TRANSPARENT = False
try:
    root.wm_attributes('-transparent', True)   # macOS true transparency
    BG = 'systemTransparentColor'
    root.config(bg=BG)
    TRANSPARENT = True
except Exception:
    BG = '#eaf7f1'
    root.config(bg=BG)

# position: top-right corner
sw = root.winfo_screenwidth()
root.geometry(f'{W}x{H}+{sw - W - 40}+60')

cv = tk.Canvas(root, width=W, height=H, bg=BG, highlightthickness=0, bd=0)
cv.pack()

# ---- drag ----
_drag = {'x': 0, 'y': 0}
def press(e): _drag['x'], _drag['y'] = e.x, e.y
def drag(e): root.geometry(f'+{e.x_root - _drag["x"]}+{e.y_root - _drag["y"]}')
cv.bind('<Button-1>', press); cv.bind('<B1-Motion>', drag)
def close(_=None):
    root.destroy()
cv.bind('<Button-2>', close); cv.bind('<Button-3>', close)
root.bind('<Escape>', close)

# ---- pixel helpers ----
def rect(gx, gy, c, w=1, h=1):
    x0 = gx * SCALE; y0 = gy * SCALE
    cv.create_rectangle(x0, y0, x0 + w * SCALE, y0 + h * SCALE, fill=c, outline='')

def dome_halfwidth(t, RX):
    s = math.sin(0.30 + t * (math.pi / 2 - 0.30))
    return RX * (s ** 0.62)

# ---- draw one frame ----
def draw():
    cv.delete('all')
    t = time.time()
    mood = 'sleepy' if state['phase'] == 'sleeping' else state['mood']
    wob = math.sin(t * 2.2) * (0.04 if mood != 'working' else 0.02)
    full = state['fullness']

    cxg = GW / 2
    RX = (11.5 + full * 2.2) * (1 + wob)
    BH = (16.0 - full * 1.0) * (1 - wob)
    baseY = 27.0
    topY = baseY - BH

    # shadow
    for gx in range(int(cxg - RX), int(cxg + RX) + 1):
        rect(gx, int(baseY) + 1, P['shadow'])

    # body
    def hw(yy): return dome_halfwidth(max(0.0, min(1.0, (yy - topY) / BH)), RX)
    yy = int(topY)
    while yy <= int(baseY):
        half = hw(yy)
        if half >= 0.5:
            xl = int(round(cxg - half)); xr = int(round(cxg + half))
            for gx in range(xl, xr + 1):
                edge = gx == xl or gx == xr or yy == int(topY) or yy == int(baseY) or hw(yy - 1) < abs(gx - cxg) - 0.3
                if edge:
                    rect(gx, yy, P['out'])
                else:
                    ny = (yy - topY) / BH
                    col = P['lite'] if ny < 0.18 else P['base'] if ny < 0.45 else P['mid'] if ny < 0.76 else P['dark']
                    rect(gx, yy, col)
        yy += 1

    # gloss
    rect(int(cxg - 5), int(topY) + 2, '#ffffff')
    rect(int(cxg - 4), int(topY) + 2, P['lite'])

    # ---- face ----
    eyeY = int(topY + BH * 0.5)
    exL, exR = int(cxg - 4), int(cxg + 4)
    blink = (int(t * 2) % 5 == 0) and mood in ('idle', 'working', 'happy')

    def eye_open(ex):
        for dy in range(-2, 3):
            for dx in range(-1, 2):
                rect(ex + dx, eyeY + dy, P['white'])
        rect(ex, eyeY, P['pup'])
        rect(ex, eyeY + 1, P['pup'])
    def eye_arc(ex):                # closed/happy ‿
        rect(ex - 1, eyeY + 1, P['pup']); rect(ex, eyeY, P['pup']); rect(ex + 1, eyeY + 1, P['pup'])
    def eye_star(ex):
        rect(ex, eyeY, P['star']); rect(ex - 1, eyeY, P['star']); rect(ex + 1, eyeY, P['star'])
        rect(ex, eyeY - 1, P['star']); rect(ex, eyeY + 1, P['star'])

    def cheeks():
        rect(int(cxg - 7), eyeY + 2, P['cheek']); rect(int(cxg + 6), eyeY + 2, P['cheek'])
    def smile(w):
        for dx in range(-w, w + 1):
            yy2 = int(round((1 - (dx / w) ** 2) * 1.6))
            rect(int(cxg) + dx, eyeY + 4 + yy2, P['mouth'])

    if blink:
        eye_arc(exL); eye_arc(exR); smile(3)
    elif mood == 'happy':
        eye_open(exL); eye_open(exR); cheeks(); smile(4)
    elif mood == 'excited':
        eye_star(exL); eye_star(exR); cheeks()
        for dx in range(-2, 3): rect(int(cxg) + dx, eyeY + 5, P['mouth'])
    elif mood == 'working':
        eye_arc(exL); eye_arc(exR); smile(2)
    elif mood == 'oops':
        eye_open(exL); eye_open(exR)
        for dx in range(-3, 4): rect(int(cxg) + dx, eyeY + 4 + (dx % 2), P['mouth'])
        rect(int(cxg + 8), eyeY - 2, P['sweat']); rect(int(cxg + 8), eyeY - 1, P['sweat'])
    elif mood == 'sleepy':
        eye_arc(exL); eye_arc(exR); cheeks()
        for dx in range(-1, 2): rect(int(cxg) + dx, eyeY + 4, P['mouth'])
        rect(int(cxg + 8), eyeY - 3, P['pup']); rect(int(cxg + 9), eyeY - 4, P['pup'])  # z
    else:  # idle
        eye_open(exL); eye_open(exR); smile(4)

    # tiny close hint
    cv.create_text(W - 8, 8, text='✕', fill='#9fb3c2', font=('Helvetica', 10))

    root.after(80, draw)

threading.Thread(target=poll, daemon=True).start()
draw()
root.mainloop()
