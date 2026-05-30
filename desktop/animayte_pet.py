#!/usr/bin/env python3
"""
animayte — cross-platform floating desktop pet (Python stdlib + tkinter only).

Borderless, always-on-top, draggable slime window. Renders the SAME spritesheet
(assets/slime.png) as the native macOS pet, so every renderer shows identical
expressions — no per-renderer drift. Reacts to the live session via the daemon
/health endpoint (mood, context fullness, sub-agent birds).

Controls:  drag = move  ·  right-click / Esc = close
Env:       ANIMAYTE_PORT, ANIMAYTE_ASSETS
"""
import os, math, time, json, threading
import tkinter as tk
from urllib.request import urlopen

PORT = int(os.environ.get('ANIMAYTE_PORT', '4321'))
ASSETS = os.environ.get('ANIMAYTE_ASSETS', os.path.join(os.path.dirname(__file__), '..', 'assets'))

CELL, FRAMES = 64, 4
# spritesheet rows = the expression dictionary order (lib/expressions.mjs)
ROWS = ['neutral', 'thinking', 'happy', 'excited', 'oops', 'embarrassed', 'sad', 'sleepy']
ROW_INDEX = {name: i for i, name in enumerate(ROWS)}
# daemon moods / legacy aliases → a real spritesheet row
MOOD_TO_ROW = {
    'neutral': 'neutral', 'idle': 'neutral',
    'thinking': 'thinking', 'working': 'thinking', 'listening': 'thinking',
    'happy': 'happy', 'excited': 'excited',
    'oops': 'oops', 'bashful': 'oops',
    'embarrassed': 'embarrassed',
    'sad': 'sad',
    'sleepy': 'sleepy', 'tired': 'sleepy',
}

ZOOM = 3                       # on-screen pixels per art pixel
PAD = 20                       # headroom for birds + swollen head
W = CELL * ZOOM
H = CELL * ZOOM + PAD

state = {'mood': 'idle', 'fullness': 0.12, 'phase': 'alive', 'birds': 0, 'reliefSeq': 0}

# ---- daemon poll (optional; never fatal) ----
def poll():
    while True:
        try:
            with urlopen(f'http://127.0.0.1:{PORT}/health', timeout=1.2) as r:
                s = json.load(r).get('state', {})
                state['mood'] = s.get('mood', state['mood'])
                state['fullness'] = float(s.get('fullness', state['fullness']))
                state['phase'] = s.get('phase', state['phase'])
                b = s.get('birds', [])
                state['birds'] = len(b) if isinstance(b, list) else int(b or 0)
                state['reliefSeq'] = int(s.get('reliefSeq', 0))
        except Exception:
            pass
        time.sleep(1.5)

# ---- window ----
root = tk.Tk()
root.title('animayte')
root.overrideredirect(True)
try: root.wm_attributes('-topmost', True)
except Exception: pass
try:
    root.wm_attributes('-transparent', True)   # macOS true transparency
    BG = 'systemTransparentColor'
except Exception:
    BG = '#eaf7f1'
root.config(bg=BG)

sw = root.winfo_screenwidth()
root.geometry(f'{W}x{H}+{sw - W - 40}+60')
cv = tk.Canvas(root, width=W, height=H, bg=BG, highlightthickness=0, bd=0)
cv.pack()

# ---- drag / close ----
_drag = {'x': 0, 'y': 0}
cv.bind('<Button-1>', lambda e: _drag.update(x=e.x, y=e.y))
cv.bind('<B1-Motion>', lambda e: root.geometry(f'+{e.x_root - _drag["x"]}+{e.y_root - _drag["y"]}'))
def close(_=None): root.destroy()
cv.bind('<Button-2>', close); cv.bind('<Button-3>', close); root.bind('<Escape>', close)

# ---- load spritesheet, pre-slice every (row, frame) cell into zoomed PhotoImages ----
sheet = tk.PhotoImage(file=os.path.join(ASSETS, 'slime.png'))
bird_sheet = None
try: bird_sheet = tk.PhotoImage(file=os.path.join(ASSETS, 'bird.png'))
except Exception: pass

def slice_cell(img, sx, sy, w, h, zoom):
    out = tk.PhotoImage(width=w * zoom, height=h * zoom)
    out.tk.call(out, 'copy', img, '-from', sx, sy, sx + w, sy + h, '-to', 0, 0, '-zoom', zoom)
    return out

cells = {}   # (row, frame) -> PhotoImage
for ri in range(len(ROWS)):
    for f in range(FRAMES):
        cells[(ri, f)] = slice_cell(sheet, f * CELL, ri * CELL, CELL, CELL, ZOOM)
birds = [slice_cell(bird_sheet, i * 24, 0, 24, 24, max(1, ZOOM // 2)) for i in range(2)] if bird_sheet else []

# ---- render loop ----
def draw():
    cv.delete('all')
    t = time.time()
    mood = 'sleepy' if state['phase'] == 'sleeping' else state['mood']
    row = ROW_INDEX[MOOD_TO_ROW.get(mood, 'neutral')]
    frame = int(t * 5) % FRAMES
    cell = cells[(row, frame)]

    # the slime, centred, anchored near the bottom (headroom on top for birds)
    cv.create_image(W // 2, H - PAD, image=cell, anchor='s')

    # orbiting sub-agent birds, above the head
    n = min(state['birds'], 5)
    for i in range(n):
        ang = t * 1.1 + (i / n) * math.tau
        bx = W / 2 + math.cos(ang) * (W * 0.34)
        by = PAD + 6 + math.sin(ang) * 10
        if birds:
            cv.create_image(int(bx), int(by), image=birds[int(t * 9 + i) % 2])

    root.after(80, draw)

threading.Thread(target=poll, daemon=True).start()
draw()
root.mainloop()
