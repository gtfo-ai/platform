"""Hand edits over the pixelized grids, then bot-sprites.ts, previews and the contact sheet.

usage: finish.py   (reads work/px/<pose>.txt, writes ../bot-sprites.ts, ../poses/*_px8.png, ../contact.png)
Every hand edit is a line in EDITS below, so NOTES.md can cite exactly what was changed.
"""
import os

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
COLS, ROWS = 34, 36
INKS = {"N": (0x15, 0x13, 0x2B), "L": (0x3A, 0x35, 0x70), "D": (0x76, 0x71, 0xB0), "S": (0xA7, 0xA2, 0xCC), "W": (0xEC, 0xE9, 0xFF), "E": (0xF4, 0xB8, 0x60)}

POSES = ["typing", "thinking", "sleeping", "raise_hand", "cheer", "confused", "slumped", "sipping"]

# Eye stamps; '.' leaves the cell as it is, 'v' paints the visor ink (L) behind the eye.
EYES = {
    "open": ["EEE", "EEE", "EEE", "EEE"],
    "up": ["EEE", "EEE", "EEE", "vvv"],
    "down": ["vvv", "EEE", "EEE", "EEE"],
    "closed": ["vvv", "vvv", "EEE", "vvv"],
    "happy": ["vEv", "EvE", "vvv", "vvv"],
    "x": ["EvE", "vEv", "EvE", "vvv"],
}


def load(name):
    rows = open(f"{HERE}/px/{name}.txt").read().split("\n")[:ROWS]
    return [list(r.ljust(COLS, ".")) for r in rows]


def stamp(g, y, x, pattern, visor="L"):
    for dy, line in enumerate(pattern):
        for dx, c in enumerate(line):
            if c == ".":
                continue
            g[y + dy][x + dx] = visor if c == "v" else c


def clear_eyes(g, y0, y1, x0, x1, visor="L"):
    """Repaint every E inside the visor box as visor, so the stamps start from a clean visor."""
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            if g[y][x] == "E":
                g[y][x] = visor


def paint(g, y, x, text):
    for dx, c in enumerate(text):
        if c != "?":
            g[y][x + dx] = c


def despeckle(g):
    """A lone pixel whose four neighbours are one other ink takes that ink (beacon E is kept)."""
    src = [r[:] for r in g]
    n = 0
    for y in range(1, ROWS - 1):
        for x in range(1, COLS - 1):
            c = src[y][x]
            nb = {src[y - 1][x], src[y + 1][x], src[y][x - 1], src[y][x + 1]}
            if c != "E" and len(nb) == 1:
                (k,) = nb
                if k != c and not (c == "S" and k == "L"):
                    g[y][x] = k
                    n += 1
    return n


def eye_clusters(g, y0=9, y1=21):
    """Centres of the two E clusters on the visor (the antenna and chest light lie outside y0..y1)."""
    pts = [(y, x) for y in range(y0, y1) for x in range(COLS) if g[y][x] == "E"]
    if not pts:
        return None
    xs = sorted(x for _, x in pts)
    mid = (xs[0] + xs[-1]) / 2
    out = []
    for side in (lambda x: x < mid, lambda x: x >= mid):
        sel = [(y, x) for y, x in pts if side(x)]
        out.append((sum(y for y, _ in sel) / len(sel), sum(x for _, x in sel) / len(sel)))
    return out


def set_eyes(g, kind, y, xl, xr, visor="L", box=(9, 21)):
    """Clear the visor's E pixels and stamp one symmetric eye shape at (y, xl) and (y, xr)."""
    clear_eyes(g, box[0], box[1], 5, COLS - 6, visor)
    pat = EYES[kind]
    for x in (xl, xr):
        stamp(g, y, x, pat, visor)


def antenna(g, ball_y, ball_x):
    """The beacon: a 2x2 amber ball with a night outline, and an edge-ink stalk down-right to the
    helmet (painted only over empty or outline cells, so it stops where the helmet begins)."""
    for y in range(max(0, ball_y - 2), ball_y + 3):
        for x in range(max(0, ball_x - 2), ball_x + 4):
            if g[y][x] in "EN":
                g[y][x] = "."
    stamp(g, ball_y - 1, ball_x - 1, [".NN.", "NEEN", "NEEN", ".NN."])
    for k in (2, 3):
        y, x = ball_y + k, ball_x + k
        if g[y][x] in ".N":
            g[y][x] = "D"


# One clean pair of lower legs and boots, pasted into every pose so nothing below the knees
# flickers when frames swap (the research-18 trick, done for the legs instead of the head).
LEGS = {
    29: "..........NWWSN....NSWWN",
    30: "..........NWWSN....NSWWN",
    31: "..........NWWSN....NSWWN",
    32: ".........NWWWSN....NSWWWN",
    33: "........NWWWWSN....NSWWWWN",
    34: "........NWWWSSN....NSSWWWN",
    35: ".........NNNNN......NNNNN",
}


def legs(g, first=29):
    for y in range(first, 36):
        g[y] = list(LEGS[y].ljust(COLS, "."))


# Front-facing eyes: rows 12-15, columns 12-14 and 19-21 (symmetric about the visor's centre, 16.5).
EY, XL, XR = 12, 12, 19


# The typing lap redrawn by hand: the edit put a keyboard on the lap, and at 18 px per cell the
# mittens over it reduced to noise. Torso with chest light, two mittens on a keyboard strip.
TYPING_LAP = {
    21: "..........NWWWWWWWWWWWWN",
    22: ".........NWWWWWWEEWWWWWWN",
    23: ".........NSWWWWWWWWWWWWSN",
    24: ".........NSWWWWWWWWWWWWSN",
    25: ".........NNWWWWWWWWWWWWNN",
    26: "........NWWWNSSSSSSSSNWWWN",
    27: "........NSWSDDDDDDDDDDSWSN",
    28: "........NLLLLLLLLLLLLLLLLN",
}
# Frame B: the left mitten lifted one pixel off the keys.
TYPING_LAP_B = {
    25: "........NWWWNWWWWWWWWWWNN",
    26: "........NSWSNSSSSSSSSNWWWN",
    27: "........NDDDDDDDDDDDDDSWSN",
}


def typing(g):
    antenna(g, 3, 9)
    set_eyes(g, "down", EY, XL, XR)
    for y, line in TYPING_LAP.items():
        g[y] = list(line.ljust(COLS, "."))
    legs(g)


def typing_b(g):
    for y, line in TYPING_LAP_B.items():
        g[y] = list(line.ljust(COLS, "."))


def thinking(g):
    helmet_top = g[4][:]
    antenna(g, 2, 10)
    g[4][12:16] = helmet_top[12:16]  # the ball sits right on the helmet: keep its top outline
    set_eyes(g, "up", 9, XL, XR)
    legs(g)


def sleeping(g):
    antenna(g, 6, 6)
    clear_eyes(g, 9, 21, 5, COLS - 6)
    paint(g, 15, 12, "EEE")
    paint(g, 12, 19, "EEE")
    legs(g)


def raise_hand(g):
    antenna(g, 4, 9)
    set_eyes(g, "open", EY, XL, XR)
    legs(g)


def cheer(g):
    antenna(g, 4, 9)
    set_eyes(g, "open", EY - 1, XL, XR)
    paint(g, 16, 15, "ELLE")
    paint(g, 17, 15, "LEEL")
    legs(g)


def confused(g):
    antenna(g, 4, 5)
    clear_eyes(g, 9, 21, 5, COLS - 6)
    stamp(g, 12, 11, EYES["open"])
    stamp(g, 10, 18, EYES["open"])
    legs(g)


def slumped(g):
    antenna(g, 4, 8)
    set_eyes(g, "x", 15, XL, XR)
    legs(g, 31)


def sipping(g):
    antenna(g, 4, 9)
    set_eyes(g, "open", EY, XL, XR)
    for dy, line in enumerate(["NNNNNN", "NLLLLN", "NWWWWN", "NEEEEN", "NWWWWN", ".NNNN"]):
        paint(g, 17 + dy, 14, line.replace(".", "?"))
    legs(g)


EDITS = {
    "typing": typing,
    "typing_b": typing_b,
    "thinking": thinking,
    "sleeping": sleeping,
    "raise_hand": raise_hand,
    "cheer": cheer,
    "confused": confused,
    "slumped": slumped,
    "sipping": sipping,
}

# Drawn over raise_hand, sipping or typing (eyes in the shared EY/XL/XR box): the eyes closed to one line.
BLINK = [""] * EY + [
    "." * XL + "LLL" + "." * (XR - XL - 3) + "LLL",
    "." * XL + "LLL" + "." * (XR - XL - 3) + "LLL",
    "." * XL + "EEE" + "." * (XR - XL - 3) + "EEE",
    "." * XL + "LLL" + "." * (XR - XL - 3) + "LLL",
]


def finish(name):
    g = load(name)
    despeckle(g)
    if name in EDITS:
        EDITS[name](g)
    return ["".join(r).rstrip(".") for r in g]


def render(rows, scale, bg):
    im = Image.new("RGBA", (COLS * scale, ROWS * scale), bg)
    px = im.load()
    for y, r in enumerate(rows):
        for x, c in enumerate(r):
            if c in INKS:
                for dy in range(scale):
                    for dx in range(scale):
                        px[x * scale + dx, y * scale + dy] = INKS[c] + (255,)
    return im


def main():
    os.makedirs(f"{ROOT}/poses", exist_ok=True)
    grids = {p: finish(p) for p in POSES}
    extra = {}
    if "typing_b" in EDITS:
        g = load("typing")
        despeckle(g)
        EDITS["typing"](g)
        EDITS["typing_b"](g)
        extra["typing_b"] = ["".join(r).rstrip(".") for r in g]
    for p, rows in {**grids, **extra}.items():
        render(rows, 8, (0, 0, 0, 0)).save(f"{ROOT}/poses/{p}_px8.png")
    order = POSES + list(extra)
    scale, pad = 6, 12
    W = len(order) * (COLS * scale + pad) + pad
    H = 2 * (ROWS * scale + pad) + pad
    sheet = Image.new("RGBA", (W, H), (255, 255, 255, 255))
    sheet.paste(Image.new("RGBA", (W, H // 2), INKS["N"] + (255,)), (0, 0))
    for i, p in enumerate(order):
        im = render({**grids, **extra}[p], scale, (0, 0, 0, 0))
        x = pad + i * (COLS * scale + pad)
        sheet.alpha_composite(im, (x, pad))
        sheet.alpha_composite(im, (x, H // 2 + pad // 2))
    sheet.save(f"{ROOT}/contact.png")
    return grids, extra


if __name__ == "__main__":
    grids, extra = main()
    import json
    json.dump({"grids": grids, "extra": extra}, open(f"{HERE}/finished.json", "w"))
    for p, rows in {**grids, **extra}.items():
        print(f"== {p}")
        for i, r in enumerate(rows):
            print(f"{i:2d} {r}")
