"""research-18's pixelize.py, adapted for full-body poses on one shared grid.

Differences from pixelize.py: no ledge cut — every frame is cropped to one box of COLS x ROWS cells
whose bottom edge is the frame's lowest robot pixel (the seat/feet baseline) and whose centre is the
feet's centre column, so poses swap without jumping; the outline ink (N) gets a vote weight so the
1-cell outlines survive the reduction; output is a text grid per frame plus 8x previews.

usage: pixelize2.py <out_dir> <cell_px> <cols> <rows> <name=frame.png>...
"""
import sys
from collections import Counter

import numpy as np
from PIL import Image

INK = "NLDSWE"
PAL = np.array([(0x15, 0x13, 0x2B), (0x3A, 0x35, 0x70), (0x76, 0x71, 0xB0), (0xA7, 0xA2, 0xCC), (0xEC, 0xE9, 0xFF), (0xF4, 0xB8, 0x60)], dtype=np.float32)
WEIGHT = np.array([1.5, 1.0, 1.0, 1.0, 1.0, 1.3])


def to_lab(rgb):
    c = rgb / 255.0
    c = np.where(c > 0.04045, ((c + 0.055) / 1.055) ** 2.4, c / 12.92)
    m = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])
    xyz = c @ m.T / np.array([0.9505, 1.0, 1.089])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)


PAL_LAB = to_lab(PAL)


def is_green(px):
    r, g, b = px[..., 0].astype(int), px[..., 1].astype(int), px[..., 2].astype(int)
    return (g > r + 35) & (g > b + 25)


def anchors(img):
    mask = ~is_green(img)
    # drop tiny specks: rows/cols need a few pixels
    ys, xs = np.nonzero(mask)
    bottom = int(np.percentile(ys, 99.9))
    # horizontal anchor: the feet (bottom 10 % of the figure), which no pose moves
    top = ys.min()
    feet = mask[bottom - int((bottom - top) * 0.10): bottom + 1]
    cols = np.nonzero(feet.any(0))[0]
    return bottom, (cols.min() + cols.max()) / 2


def grid(img, cell, cols, rows):
    bottom, cx = anchors(img)
    x0 = int(round(cx - cols * cell / 2))
    y0 = bottom + 1 - rows * cell
    pad = cell * max(cols, rows)
    padded = np.full((img.shape[0] + 2 * pad, img.shape[1] + 2 * pad, 3), (113, 222, 148), np.uint8)
    padded[pad:pad + img.shape[0], pad:pad + img.shape[1]] = img
    out = []
    for j in range(rows):
        line = ""
        for i in range(cols):
            ys, xs = pad + y0 + j * cell, pad + x0 + i * cell
            block = padded[ys:ys + cell, xs:xs + cell].reshape(-1, 3)
            green = is_green(block)
            if green.mean() > 0.5:
                line += "."
                continue
            body = block[~green].astype(np.float32)
            idx = np.argmin(((to_lab(body)[:, None, :] - PAL_LAB[None]) ** 2).sum(-1), 1)
            votes = Counter(idx.tolist())
            k = max(votes, key=lambda v: votes[v] * WEIGHT[v])
            line += INK[k]
        out.append(line.rstrip("."))
    return out


def save_preview(rows, cols, path, scale=8):
    im = Image.new("RGBA", (cols * scale, len(rows) * scale), (0x15, 0x13, 0x2B, 255))
    px = im.load()
    for y, r in enumerate(rows):
        for x, c in enumerate(r):
            if c != ".":
                col = tuple(int(v) for v in PAL[INK.index(c)]) + (255,)
                for dy in range(scale):
                    for dx in range(scale):
                        px[x * scale + dx, y * scale + dy] = col
    im.save(path)


def main():
    out_dir, cell, cols, rows = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
    for spec in sys.argv[5:]:
        name, path = spec.split("=", 1)
        img = np.array(Image.open(path).convert("RGB"))
        g = grid(img, cell, cols, rows)
        open(f"{out_dir}/{name}.txt", "w").write("\n".join(g) + "\n")
        save_preview(g, cols, f"{out_dir}/{name}_px8.png")
        print(name, "ok")


main()
