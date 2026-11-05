"""Write bot-sprites.ts from work/finished.json (finish.py's output) in peek-bot-sprite.ts's style."""
import importlib.util
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("f", f"{HERE}/finish.py")
f = importlib.util.module_from_spec(spec)
spec.loader.exec_module(f)
data = json.load(open(f"{HERE}/finished.json"))
grids, extra = data["grids"], data["extra"]

DOCS = {
    "typing": "Working: both hands forward at keyboard height (the laptop prop is drawn in front). Eyes look down.",
    "typing_b": "The other typing frame: the left hand lifted one pixel. Alternate with {@link BOT_TYPING}.",
    "thinking": "Brainstorming: a hand at the chin, eyes looking up. Pairs with `PROP_THOUGHT_*`.",
    "sleeping": "Idle: the helmet tilted, eyes closed to one line each. Pairs with `PROP_Z_*`.",
    "raise_hand": "Needs a human: one arm raised high. Pairs with `PROP_BUBBLE_EXCLAIM`.",
    "cheer": "Done: both arms up, a smile on the visor.",
    "confused": "Stuck: scratching the helmet, head tilted. Pairs with `PROP_BUBBLE_QUESTION`.",
    "slumped": "Failed: sunk forward, arms hanging, X eyes.",
    "sipping": "Paused, on a break: both hands round a coffee mug.",
}


def arr(name, rows, doc):
    body = "".join(f"  '{r}',\n" for r in rows)
    return f"/** {doc} */\nexport const {name}: readonly string[] = [\n{body}];\n"


def blink_rows():
    rows = list(f.BLINK)
    lead = 0
    while lead < len(rows) and rows[lead] == "":
        lead += 1
    return f"  ...Array<string>({lead}).fill(''),\n" + "".join(f"  '{r}',\n" for r in rows[lead:])


out = f'''/**
 * The agent office's bot: the sign-in mascot (`peek-bot-sprite.ts`) drawn whole — sitting on an
 * unseen chair, facing the viewer — in eight poses, one per agent state. Pure data, in the same
 * format and the same six inks as the peek bot, so one renderer draws both.
 *
 * ## Where the pixels came from
 *
 * research-18's recipe, extended (addendum in that page's NOTES): the Z-Image Turbo master shrunk onto
 * a larger green canvas, one Qwen-Image-Edit 2511 edit that completed the body sitting, then one edit
 * per pose of that sitting frame ("Keep the exact same robot … Everything else stays identical"), so
 * all eight are one character at one scale. Each was reduced on one shared grid — bottom row = the
 * lowest boot pixel, centre = the boots' centre column, 18 source px per sprite pixel at 768² — by
 * majority vote snapped to the six inks in CIELAB (night weighted ×1.5 so outlines survive). By hand
 * afterwards: lone specks removed; the antenna redrawn as one 2 × 2 beacon with a stalk; every eye
 * restamped from one set of shapes (open 3 × 4, looking up/down, closed line, X, smile); and rows
 * 29–35 — the lower legs and boots — are one shared drawing in every pose, so nothing below the
 * knees moves when frames swap.
 *
 * Every layer is a grid, one character per sprite pixel, written without trailing transparent
 * cells. All poses are {{@link BOT_COLS}} × {{@link BOT_ROWS}} with the same baseline (the bottom row is
 * the floor under the boots) and the same centre column, so a pose swap never jumps. Drawn at 2–3
 * CSS px per sprite pixel for the office desk scene.
 */

export const BOT_COLS = {f.COLS};
export const BOT_ROWS = {f.ROWS};

/** Each character's Tailwind fill class: the peek bot's inks (`PEEK_BOT_INKS`). */
export const BOT_INKS = {{
  N: 'fill-signin-night',
  L: 'fill-signin-lit',
  D: 'fill-signin-edge',
  S: 'fill-signin-muted',
  W: 'fill-signin-text',
  E: 'fill-signin-beacon',
}} as const;

export type BotInk = keyof typeof BOT_INKS;

'''
for p in ["typing"]:
    out += arr("BOT_TYPING", grids["typing"], DOCS["typing"]) + "\n"
out += arr("BOT_TYPING_B", extra["typing_b"], DOCS["typing_b"]) + "\n"
for p in ["thinking", "sleeping", "raise_hand", "cheer", "confused", "slumped", "sipping"]:
    out += arr("BOT_" + p.upper(), grids[p], DOCS[p]) + "\n"
out += (
    "/**\n * Drawn over {@link BOT_TYPING}, {@link BOT_TYPING_B}, {@link BOT_RAISE_HAND} or {@link BOT_SIPPING}\n"
    f" * (their eyes share rows {f.EY}–{f.EY + 3}, columns {f.XL}–{f.XL + 2} and {f.XR}–{f.XR + 2}): the eyes closed to one line.\n */\n"
    "export const BOT_BLINK: readonly string[] = [\n" + blink_rows() + "];\n"
)
open(os.path.join(os.path.dirname(HERE), "bot-sprites.ts"), "w").write(out)
print("written")
