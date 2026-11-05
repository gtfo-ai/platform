"""Parse sprite grids out of a TS module, validate them, and render previews.

usage: grids.py check <file.ts>
       grids.py preview <file.ts> <out.png> [scale] [NAME ...]
"""
import re
import sys

from PIL import Image

INKS = {
    "N": (0x15, 0x13, 0x2B),
    "L": (0x3A, 0x35, 0x70),
    "D": (0x76, 0x71, 0xB0),
    "S": (0xA7, 0xA2, 0xCC),
    "W": (0xEC, 0xE9, 0xFF),
    "E": (0xF4, 0xB8, 0x60),
}


def parse(path):
    src = open(path).read()
    consts = {k: int(v) for k, v in re.findall(r"export const (\w+) = (\d+);", src)}
    arrays = {}
    for name, body in re.findall(r"export const (\w+): readonly string\[\] = \[(.*?)\n\];", src, re.S):
        rows = []
        for line in body.splitlines():
            line = line.strip()
            if not line:
                continue
            m = re.fullmatch(r"\.\.\.Array<string>\((\d+)\)\.fill\(''\),", line)
            if m:
                rows += [""] * int(m.group(1))
                continue
            m = re.fullmatch(r"'([^']*)',", line)
            if not m:
                raise SystemExit(f"{name}: cannot parse line {line!r}")
            rows.append(m.group(1))
        arrays[name] = rows
    return consts, arrays


def dims_for(name, consts):
    if name.startswith("BOT_"):
        return consts["BOT_COLS"], consts["BOT_ROWS"]
    base = name
    while f"{base}_COLS" not in consts and "_" in base:
        base = base.rsplit("_", 1)[0]
    return consts[f"{base}_COLS"], consts[f"{base}_ROWS"]


def check(path):
    consts, arrays = parse(path)
    bad = 0
    for name, rows in arrays.items():
        before = bad
        cols, nrows = dims_for(name, consts)
        overlay = name.endswith("_OVERLAY") or name == "BOT_BLINK"
        if (len(rows) > nrows) if overlay else (len(rows) != nrows):
            print(f"FAIL {name}: {len(rows)} rows, expected {nrows}")
            bad += 1
        for y, r in enumerate(rows):
            if len(r) > cols:
                print(f"FAIL {name} row {y}: width {len(r)} > {cols}")
                bad += 1
            if set(r) - set("NLDSWE."):
                print(f"FAIL {name} row {y}: bad chars {set(r) - set('NLDSWE.')}")
                bad += 1
            if r.endswith("."):
                print(f"FAIL {name} row {y}: trailing transparent cell")
                bad += 1
        if bad == before:
            print(f"ok   {name} {cols}x{nrows} ({len(rows)} rows)")
    print("PASS" if not bad else f"{bad} problems")
    return bad


def render(rows, cols, nrows, scale, bg):
    im = Image.new("RGBA", (cols * scale, nrows * scale), bg)
    px = im.load()
    for y, r in enumerate(rows):
        for x, c in enumerate(r):
            if c in INKS:
                for dy in range(scale):
                    for dx in range(scale):
                        px[x * scale + dx, y * scale + dy] = INKS[c] + (255,)
    return im


def preview(path, out, scale=8, names=None):
    consts, arrays = parse(path)
    names = names or list(arrays)
    tiles = []
    for n in names:
        cols, nrows = dims_for(n, consts)
        tiles.append((n, cols, nrows))
    pad = 2 * scale
    W = sum(c * scale + pad for _, c, _ in tiles) + pad
    H = max(r * scale for _, _, r in tiles) * 2 + pad * 3
    sheet = Image.new("RGBA", (W, H), (255, 255, 255, 255))
    top = Image.new("RGBA", (W, H // 2), INKS["N"] + (255,))
    sheet.paste(top, (0, 0))
    x = pad
    for n, c, r in tiles:
        rows = arrays[n]
        a = render(rows, c, r, scale, (0, 0, 0, 0))
        sheet.alpha_composite(a, (x, pad))
        sheet.alpha_composite(a, (x, H // 2 + pad))
        x += c * scale + pad
    sheet.save(out)
    print(out, sheet.size)


if __name__ == "__main__":
    if sys.argv[1] == "check":
        sys.exit(1 if check(sys.argv[2]) else 0)
    preview(sys.argv[2], sys.argv[3], int(sys.argv[4]) if len(sys.argv) > 4 else 8, sys.argv[5:] or None)
