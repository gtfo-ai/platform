"""Render the sign-in robot's 10 s loop from the sprite grids, mirroring styles.css exactly.

usage: render_loop.py <peek-bot-sprite.ts> <out_dir> <scale> <fps>
"""
import re
import subprocess
import sys

from PIL import Image

SPRITE, OUT, SCALE, FPS = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
COLS, ROWS, PX = 37, 35, 5  # sprite size, and CSS px per sprite pixel
LOOP_MS = 10_000
INKS = {
    "N": (0x15, 0x13, 0x2B), "L": (0x3A, 0x35, 0x70), "D": (0x76, 0x71, 0xB0),
    "S": (0xA7, 0xA2, 0xCC), "W": (0xEC, 0xE9, 0xFF), "E": (0xF4, 0xB8, 0x60),
}
NIGHT = INKS["N"]

src = open(SPRITE).read()


def grid(name):
    body = re.search(rf"export const {name}: readonly string\[\] = \[(.*?)\];", src, re.S).group(1)
    rows = re.findall(r"'([^']*)'", body)
    pad = re.search(r"Array<string>\((\d+)\)", body)
    return [""] * int(pad.group(1)) + rows if pad else rows


LAYERS = {n: grid(f"PEEK_BOT_{n}") for n in ("PEEK", "WAVE_A", "WAVE_B", "BLINK")}

# --- the keyframes of styles.css, as data -------------------------------------------------------
# rig: (percent, translateY px, steps for the segment that starts here or None)
RIG = [(0, 175, None), (6, 175, 35), (12, 0, None), (50, 0, 35), (56, 175, None),
       (66, 175, 21), (70, 70, None), (76, 70, 21), (80, 175, None), (100, 175, None)]
# step-end opacity: (percent, on)
SHOW = {
    "PEEK": [(0, 1), (15, 0), (39, 1)],
    "WAVE_A": [(0, 0), (15, 1), (18, 0), (21, 1), (24, 0), (27, 1), (30, 0), (33, 1), (36, 0)],
    "WAVE_B": [(0, 0), (18, 1), (21, 0), (24, 1), (27, 0), (30, 1), (33, 0), (36, 1), (39, 0)],
    "BLINK": [(0, 0), (44, 1), (45.5, 0), (72, 1), (73.5, 0)],
}


def rig_at(p):
    for (a, ya, steps), (b, yb, _) in zip(RIG, RIG[1:]):
        if a <= p < b:
            if ya == yb:
                return ya
            k = int((p - a) / (b - a) * steps) / steps  # steps(n, end)
            return round(ya + (yb - ya) * k)
    return RIG[-1][1]


def shown(name, p):
    on = 0
    for at, value in SHOW[name]:
        if p >= at:
            on = value
    return on


def frame(p):
    img = Image.new("RGBA", (COLS, ROWS), (0, 0, 0, 0))
    px = img.load()
    for name in ("PEEK", "WAVE_A", "WAVE_B", "BLINK"):
        if not shown(name, p):
            continue
        for y, row in enumerate(LAYERS[name]):
            for x, c in enumerate(row):
                if c != ".":
                    px[x, y] = (*INKS[c], 255)
    # slide down inside the clip box: whole sprite pixels, because every offset is a multiple of 5
    dy = rig_at(p) // PX
    out = Image.new("RGBA", (COLS, ROWS), (0, 0, 0, 0))
    out.paste(img, (0, dy))
    return out.resize((COLS * SCALE, ROWS * SCALE), Image.NEAREST)


# --- sample at the fps, then merge runs of identical frames into one frame with a longer delay --
step = 1000 / FPS
frames, durations = [], []
for i in range(round(LOOP_MS / step)):
    f = frame(i * step / LOOP_MS * 100)
    if frames and f.tobytes() == frames[-1].tobytes():
        durations[-1] += step
    else:
        frames.append(f)
        durations.append(step)
durations = [round(d) for d in durations]
assert frames[0].tobytes() == frame(99.999).tobytes(), "the loop's last frame is not its first"
print(f"{len(frames)} distinct frames, {sum(durations)} ms")

frames[0].save(f"{OUT}/peek-bot-loop.webp", save_all=True, append_images=frames[1:],
               duration=durations, loop=0, lossless=True)
# GIF: one transparent palette entry + the six inks; disposal 2 clears between frames.
pal_frames = []
for f in frames:
    q = Image.new("P", f.size, 0)
    flat = [0, 0, 0] + [c for ink in INKS.values() for c in ink]
    q.putpalette(flat + [0] * (768 - len(flat)))
    lookup = {(*ink, 255): i + 1 for i, ink in enumerate(INKS.values())}
    q.putdata([lookup.get(p, 0) for p in f.getdata()])
    pal_frames.append(q)
pal_frames[0].save(f"{OUT}/peek-bot-loop.gif", save_all=True, append_images=pal_frames[1:],
                   duration=durations, loop=0, transparency=0, disposal=2, optimize=False)
# MP4 on the page's night ground, at a constant frame rate for players.
mp4_frames = f"{OUT}/mp4-frames"
subprocess.run(["mkdir", "-p", mp4_frames], check=True)
n = 0
for f, d in zip(frames, durations):
    bg = Image.new("RGB", f.size, NIGHT)
    bg.paste(f, (0, 0), f)
    for _ in range(round(d / step)):
        bg.save(f"{mp4_frames}/{n:05d}.png")
        n += 1
subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-framerate", str(FPS), "-i",
                f"{mp4_frames}/%05d.png", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "12",
                "-tune", "animation", "-movflags", "+faststart", f"{OUT}/peek-bot-loop.mp4"], check=True)
print(f"mp4 frames {n}")
