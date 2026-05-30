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
import os, math, time, json, threading, zlib, struct
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
# Try true transparency (macOS); the '-transparent' attr can succeed while the
# special color name still fails on some Tk builds, so set the color in its own
# guarded step and fall back to a soft solid bg.
BG = '#eaf7f1'
try: root.wm_attributes('-transparent', True)
except Exception: pass
try:
    root.config(bg='systemTransparentColor')
    BG = 'systemTransparentColor'
except Exception:
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

# ---- spritesheet → zoomed per-cell PhotoImages ----
# Two paths: the fast native one (Tk 8.6+ reads PNG directly), and a stdlib
# decoder fallback (Tk 8.5 can't load PNG) that composites alpha over the bg.
# Either way the art comes from the SAME slime.png — no per-renderer drift.

def _bg_rgb():
    if isinstance(BG, str) and BG.startswith('#') and len(BG) == 7:
        return tuple(int(BG[i:i+2], 16) for i in (1, 3, 5))
    return (234, 247, 241)

def decode_png(path):
    d = open(path, 'rb').read()
    assert d[:8] == b'\x89PNG\r\n\x1a\n'
    pos, w, h, idat = 8, 0, 0, b''
    while pos < len(d):
        ln = struct.unpack('>I', d[pos:pos+4])[0]; typ = d[pos+4:pos+8]
        body = d[pos+8:pos+8+ln]; pos += 12 + ln
        if typ == b'IHDR': w, h, bd, ct = struct.unpack('>IIBB', body[:10])  # noqa
        elif typ == b'IDAT': idat += body
        elif typ == b'IEND': break
    raw = zlib.decompress(idat); stride = w * 4; prev = bytearray(stride)
    rows, i = [], 0
    def paeth(a, b, c):
        p = a + b - c; pa, pb, pc = abs(p-a), abs(p-b), abs(p-c)
        return a if pa <= pb and pa <= pc else (b if pb <= pc else c)
    for _y in range(h):
        flt = raw[i]; i += 1; line = bytearray(raw[i:i+stride]); i += stride
        for x in range(stride):
            a = line[x-4] if x >= 4 else 0; b = prev[x]; c = prev[x-4] if x >= 4 else 0
            if flt == 1: line[x] = (line[x]+a) & 255
            elif flt == 2: line[x] = (line[x]+b) & 255
            elif flt == 3: line[x] = (line[x]+((a+b) >> 1)) & 255
            elif flt == 4: line[x] = (line[x]+paeth(a, b, c)) & 255
        prev = line; rows.append(bytes(line))
    return w, h, rows

def cells_via_decoder(path, cw, ch, ncols, nrows, zoom, bg):
    w, h, rows = decode_png(path)
    out = {}
    for ri in range(nrows):
        for f in range(ncols):
            ox, oy = f * cw, ri * ch
            lines = []
            for y in range(ch):
                row = rows[oy + y]; px = []
                for x in range(cw):
                    o = (ox + x) * 4; r, g, b, al = row[o], row[o+1], row[o+2], row[o+3]
                    af = al / 255.0
                    rr = int(r*af + bg[0]*(1-af)); gg = int(g*af + bg[1]*(1-af)); bb = int(b*af + bg[2]*(1-af))
                    px.extend(['#%02x%02x%02x' % (rr, gg, bb)] * zoom)
                lines.extend(['{' + ' '.join(px) + '}'] * zoom)
            img = tk.PhotoImage(width=cw*zoom, height=ch*zoom)
            img.put(' '.join(lines))
            out[(ri, f)] = img
    return out

def cells_via_native(path, cw, ch, ncols, nrows, zoom):
    sheet = tk.PhotoImage(file=path)   # raises on Tk < 8.6
    out = {}
    for ri in range(nrows):
        for f in range(ncols):
            cell = tk.PhotoImage(width=cw*zoom, height=ch*zoom)
            cell.tk.call(cell, 'copy', sheet, '-from', f*cw, ri*ch, f*cw+cw, ri*ch+ch, '-to', 0, 0, '-zoom', zoom)
            out[(ri, f)] = cell
    return out

slime_path = os.path.join(ASSETS, 'slime.png')
try:
    cells = cells_via_native(slime_path, CELL, CELL, FRAMES, len(ROWS), ZOOM)
except Exception:
    cells = cells_via_decoder(slime_path, CELL, CELL, FRAMES, len(ROWS), ZOOM, _bg_rgb())

birds = []
bird_path = os.path.join(ASSETS, 'bird.png')
try:
    bsheet = tk.PhotoImage(file=bird_path)
    for i in range(2):
        bi = tk.PhotoImage(width=24*max(1, ZOOM//2), height=24*max(1, ZOOM//2))
        bi.tk.call(bi, 'copy', bsheet, '-from', i*24, 0, i*24+24, 24, '-to', 0, 0, '-zoom', max(1, ZOOM//2))
        birds.append(bi)
except Exception:
    bcells = cells_via_decoder(bird_path, 24, 24, 2, 1, max(1, ZOOM//2), _bg_rgb())
    birds = [bcells[(0, 0)], bcells[(0, 1)]]

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
