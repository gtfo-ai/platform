"""Turn the ComfyUI key frames into a palette-exact pixel sprite sheet.

usage: pixelize.py <out_dir> <cell_px> <cut_y> <frame.png>...
"""
import sys
from collections import Counter

import numpy as np
from PIL import Image

PALETTE = {
    "night": (0x15, 0x13, 0x2B),
    "lit": (0x3A, 0x35, 0x70),
    "edge": (0x76, 0x71, 0xB0),
    "muted": (0xA7, 0xA2, 0xCC),
    "text": (0xEC, 0xE9, 0xFF),
    "beacon": (0xF4, 0xB8, 0x60),
}
PAL = np.array(list(PALETTE.values()), dtype=np.float32)


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


def pixelize(path, cell, cut_y, crop_box):
    img = np.array(Image.open(path).convert("RGB"))
    x0, y0, x1 = crop_box
    img = img[y0:cut_y, x0:x1]
    h, w = img.shape[0] // cell, img.shape[1] // cell
    out = np.zeros((h, w, 4), dtype=np.uint8)
    for j in range(h):
        for i in range(w):
            block = img[j * cell:(j + 1) * cell, i * cell:(i + 1) * cell].reshape(-1, 3)
            green = is_green(block)
            if green.mean() > 0.5:
                continue
            body = block[~green].astype(np.float32)
            idx = np.argmin(((to_lab(body)[:, None, :] - PAL_LAB[None]) ** 2).sum(-1), 1)
            k = Counter(idx.tolist()).most_common(1)[0][0]
            out[j, i, :3] = PAL[k]
            out[j, i, 3] = 255
    return out


def main():
    out_dir, cell, cut_y = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
    frames = sys.argv[4:]
    # A common crop: the union of every frame's non-green bounding box above the cut, snapped to
    # the cell so all frames share one grid.
    xs, ys = [], []
    for f in frames:
        a = np.array(Image.open(f).convert("RGB"))[:cut_y]
        mask = ~is_green(a)
        yy, xx = np.nonzero(mask)
        xs += [xx.min(), xx.max()]
        ys += [yy.min()]
    x0 = max(0, min(xs) - cell)
    x1 = max(xs) + cell
    y0 = max(0, min(ys) - cell)
    # keep the cut on a cell boundary measured from y0
    y0 = cut_y - ((cut_y - y0 + cell - 1) // cell) * cell
    width = ((x1 - x0 + cell - 1) // cell) * cell
    box = (x0, max(0, y0), x0 + width)
    sprites = [pixelize(f, cell, cut_y, box) for f in frames]
    h, w = sprites[0].shape[:2]
    sheet = np.concatenate(sprites, axis=1)
    Image.fromarray(sheet, "RGBA").save(f"{out_dir}/sheet_c{cell}.png", optimize=True)
    big = Image.fromarray(sheet, "RGBA").resize((sheet.shape[1] * 8, sheet.shape[0] * 8), Image.NEAREST)
    bg = Image.new("RGBA", big.size, (0x15, 0x13, 0x2B, 255))
    bg.alpha_composite(big)
    bg.save(f"{out_dir}/preview_c{cell}.png")
    print(f"cell={cell} frame={w}x{h} sheet={sheet.shape[1]}x{sheet.shape[0]}")


main()
