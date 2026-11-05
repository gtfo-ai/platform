# 18a — The office poses: the mascot sitting, in eight poses, and its props

An addendum to [this directory's README](README.md). The pixel office (TD-033 decision 8(c)) shows
each agent as the sign-in mascot sitting at a desk, posed by what it is doing. This page is how those
poses were made: the same character, the same six inks and the same recipe as the peek bot, with one
extra step (a sitting base). Measured on the same M3 Max (36 GB, MPS), ComfyUI 0.44.0 on port 8000,
2026-11-05.

## What is where

| Path | What |
|---|---|
| `apps/web/src/ui/bot/bot-sprites.ts` | `BOT_COLS = 34`, `BOT_ROWS = 36`, the nine frames (`BOT_TYPING`, `BOT_TYPING_B`, `BOT_THINKING`, `BOT_SLEEPING`, `BOT_RAISE_HAND`, `BOT_CHEER`, `BOT_CONFUSED`, `BOT_SLUMPED`, `BOT_SIPPING`) and the `BOT_BLINK` overlay |
| `apps/web/src/ui/bot/props-sprites.ts` | `PROP_LAPTOP_BACK` 16×10, `PROP_LAPTOP_FRONT` 16×12, `PROP_DESK_EDGE` 8×5 (tiles), `PROP_MUG` 9×8, `PROP_STEAM_A/B` 5×4, `PROP_Z_SMALL` 4×4, `PROP_Z_BIG` 6×6, `PROP_THOUGHT_1/2/3` 12×9, `PROP_BUBBLE_EXCLAIM` and `PROP_BUBBLE_QUESTION` 9×11, `PROP_PLANT` 9×12, each with its `_COLS`/`_ROWS` |
| `apps/web/src/ui/bot/{poses.ts,bot.tsx,seat.tsx,bot.css}` | which layers draw each pose and where, the `<Bot>` and `<Seat>` components, and the motion |
| `office/contact.png` | all nine frames at 6×, on the night colour (top) and on white (bottom) |
| `office/props-preview.png` | the props at 10×, on night and on white |
| `office/workflows/00-sit-base.json`, `office/workflows/01-poses-seed7.json` | the API-format graphs, exactly as enqueued |
| `office/work/` | `edit.py` (builds and enqueues an edit graph from `spec_base.json` / `spec_poses1.json`), `pixelize2.py`, `finish.py` (every hand edit, as code), `emit_ts.py`, `grids.py` (parse, validate and preview a TS grid module), and the raw grids `px/<pose>.txt` that `finish.py` starts from |

The two PNGs are the only binaries in the repository, each declared `binary` by its own line in
`.gitattributes` (so `nul:check` skips them). The raw edits (768², about 0.5 MB each), the sitting
bases (1024²) and the 8× previews are not committed; they regenerate from the workflows.

## Pipeline, and what changed against the peek bot

1. **Padded master** (new). `master_00004_.png` is upper-body, cut at the waist; an edit asked for
   "full body" would have had to zoom out *and* invent the legs. Instead the master was shrunk to
   58 % (593 px, Lanczos) and pasted top-centre (y = 30) on a 1024² canvas of its own green
   (`#71de94`, the median of the corner), and uploaded as `mascot_padded_58.png`. The edit model then
   only fills empty green.
2. **Sitting base** (new) — `office/workflows/00-sit-base.json`: the README's edit graph unchanged
   (Qwen-Image-Edit 2511 `qwen-image-edit-2511-Q6_K.gguf` + the
   `Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16` LoRA, `ModelSamplingAuraFlow` 3.1, `CFGNorm` 1,
   `CLIPLoaderGGUF` `Qwen2.5-VL-7B-Instruct-Q8_0.gguf` type `qwen_image`, `qwen_image_vae`,
   `FluxKontextImageScale` → encoder + `VAEEncode`, 4 steps euler/simple, cfg 1, denoise 1). Prompt:
   > Keep the exact same robot, same pixel art style, same colors, same round helmet, dark visor with
   > glowing amber eyes, amber antenna ball, blue ear pods and amber chest light, same size, and the
   > same flat pure green background. Complete the robot's whole body below the torso: short stubby
   > legs with round boot feet. The robot is sitting on an invisible chair facing the viewer, knees
   > bent toward the viewer, feet resting near the bottom of the image. Lower the waving arm: both
   > mitten hands rest on its knees. Do not draw any chair, desk or floor. Everything else stays
   > identical.

   Seed **4242 → `sit_base_a`, used**: the identity held to the pixel, hands on knees, only a faint
   green-grey shadow under the seat (keyed out). Seed 1618 → `sit_base_b` **drew a chair** despite
   "do not draw any chair", and was rejected. 646 s for the pair, model load included (3.3–6 min per
   image under memory pressure).
3. **Poses** — `office/workflows/01-poses-seed7.json`: the same graph over `sit_base_a` (uploaded
   as `mascot_sit_base.png`), all eight edits in one graph, **seed 7** each, except that node 8 is
   `ImageScale` to 768² (Lanczos) instead of `FluxKontextImageScale`, in the hope of halving the
   time. It did not: about 40–50 s per step either way, 1722 s for the eight (≈ 3.6 min each). 768²
   is still plenty for an 18 px cell. Every prompt is *prefix + pose + suffix*:
   - prefix: "Keep the exact same robot, same pixel art style, same colors, same round helmet, dark
     visor, amber antenna ball, blue ear pods and amber chest light, same size and position, same
     sitting pose on an invisible chair facing the viewer, and the same flat pure green background."
   - suffix: "Do not draw any chair, desk or floor. Everything else stays identical."
   - typing: "Both arms reach forward at chest height, both mitten hands held level in front of the
     body as if typing on a small laptop keyboard. Same glowing amber eyes looking down at the
     hands."
   - thinking: "One mitten hand is raised to its chin, the other arm folded across the body
     supporting that elbow, head tilted slightly up, glowing amber eyes looking upward, thinking
     hard."
   - sleeping: "The helmet is tilted to one side, the robot is dozing: the glowing eyes are closed,
     shown as two thin flat horizontal lines. Both hands rest limp in its lap."
   - raise_hand: "One arm is raised straight up high above the helmet, mitten hand open, like asking
     a question in class. The other hand rests on its knee. Same glowing amber eyes."
   - cheer: "Both arms are raised high above the helmet in a joyful victory cheer, mitten hands
     open. Same glowing amber eyes, happy."
   - confused: "One mitten hand scratches the side of the helmet, the head tilted, puzzled and
     confused. The other hand rests on its knee. Same glowing amber eyes."
   - slumped: "The robot slumps forward sadly, shoulders and helmet drooping down, arms hanging limp
     between its knees, defeated. The glowing eyes look down."
   - sipping: "Both mitten hands hold a white coffee mug in front of the visor at chest height,
     taking a relaxed sip. Same glowing amber eyes."

   **All eight held the identity on the first seed**, so no retry and no hand-derived pose was
   needed. What the model did on its own: typing added a keyboard on the lap and angry-looking
   slanted eyes; cheer added a smile on the visor and put the hands beside the helmet rather than
   high above it; raise_hand is closer to a wave (the hand at helmet-top height, a five-finger glove
   instead of a mitten); confused added a worried brow, a frown and scratch marks; slumped drew sad
   droopy eyes; thinking raised an index finger at the chin. The eyes, the typing lap and the mug
   were redrawn by hand (step 5); the rest is the model's.
4. **Pixelize** — `pixelize2.py <out_dir> 18 34 36 name=frame.png …` (the README's `pixelize.py`,
   changed): no ledge cut; every frame is cropped to **34 × 36 cells of 18 px** whose bottom edge is
   the lowest robot pixel (the boots) and whose centre is the boots' centre column. The boots are
   the one thing no pose moves, so the grid lands identically in every frame (the helmet's centre
   was tried first and rejected: a tilted head shifts it). The vote weights night ×1.5 and beacon
   ×1.3 so outlines and eyes survive. 18 px at 768² equals 24 px at 1024², the peek bot's cell; with
   the 58 % master that puts the seated bot at about 31 rows × 18 columns, leaving 5 rows above the
   antenna and room either side for the cheer's hands (32 columns wide, which is why the grid is 34
   rather than the targeted 32).
5. **By hand** — `finish.py`, every edit a line of code:
   - *despeckle*: a pixel whose four neighbours are one other ink takes that ink (the beacon and the
     visor gloss kept);
   - *antenna*: one 2 × 2 beacon with a night outline and a two-pixel edge-ink stalk to the helmet
     (the thin stalk vanishes in the reduction);
   - *eyes*: every visor `E` cleared and restamped from one set — open 3 × 4 (chosen over a rounded
     3 × 4, a 2 × 3 and a 3 × 3), looking up or down (3 × 3 at the top or bottom of the 3 × 4 box),
     closed (one 3-pixel line), X (3 × 3). The front-facing poses share rows 12–15, columns 12–14
     and 19–21, symmetric about the visor's centre (16.5), which is what lets one `BOT_BLINK` serve
     typing, typing B, raise_hand and sipping. Cheer: open eyes one row higher and a 4-pixel smile
     (kept from the model). Sleeping and confused: placed per the tilted head (sleeping: left line
     row 15, right line row 12; confused: left eye rows 12–15 columns 11–13, right rows 10–13
     columns 18–20). Thinking: eyes looking up, rows 9–11;
   - *legs*: rows 29–35 (the lower legs and boots) are one drawing pasted into every pose (slumped
     from row 31, because its hands hang to row 30) — the README's "copy the rows above any arm"
     trick, done for the legs;
   - *typing lap*: rows 21–28 redrawn (torso, chest light, two mittens on a keyboard strip); typing
     B lifts the left mitten one pixel (`TYPING_LAP_B`), 9 cells differ;
   - *mug*: the white mug had merged into the white body, so it is redrawn with a night outline,
     coffee and an amber band, rows 17–22, columns 14–19.
6. **Emit** — `emit_ts.py` writes `bot-sprites.ts` into `office/`, in the shape the repository's
   module has; `grids.py check <module.ts>` validates a module and `grids.py preview` renders one.

## The props

Drawn by hand straight into `props-sprites.ts` (no model). The palette has no green, so the plant
has lavender leaves and an amber pot. Two laptops: `PROP_LAPTOP_BACK` is the back of the lid, a
dark face with an amber logo; `PROP_LAPTOP_FRONT` is the screen side, lit with amber code lines. The
`Z`s, the steam and the thought dots are `W`/`S` without an outline, so they read on the night
background and only faintly on white.

## How the components use them

- **The stage.** `<Bot>` draws on the bot's 34 × 36 grid widened to 40 columns (`BOT_STAGE_COLS`),
  so the bubbles, `Z`s and thought trail sit to the upper right without covering the bot;
  `sprites.test.ts` holds that none of them covers a body pixel. Sipping's steam is the one
  exception: it rises from the mug in front of the visor and crosses the right eye's edge by one
  pixel, which the test allows over visor and eye cells only.
- **The blink.** `BOT_BLINK` moved to the eye box of each pose whose eyes are open on its columns:
  row 12 for typing, raise_hand and sipping, row 11 for cheer, row 8 for thinking (eyes looking up,
  rows 9–11). Confused's tilted eyes are not on the columns and get no blink.
- **The motion** is CSS classes only (`ui/bot/bot.css`): `step-end` opacity loops, whose base
  styles are each loop's first frame, so `prefers-reduced-motion: reduce` and `animated={false}`
  show that frame. `phase` (0–3) picks a delay class so seats do not move together.
- **The seat.** `<Seat>` puts the bot behind a tiled desk edge cut at the desk's bottom, so the lap
  and legs are hidden. The laptop shows its **lit screen** in front of the bot while it types or
  thinks, and its **dark lid**, pushed to the left of the desk, otherwise. That is a glanceability
  choice — a working seat reads from across the room — rather than the viewer's literal angle on a
  laptop the bot is using, which would be the lid; the laptop moves aside for the other poses so
  the mug, the cheering arms and the slump stay in view.
- **What is not drawn**: TD-033's `waiting` activity puts the bot "on the bench", and no bench pose
  or prop exists yet. Which pose each activity shows is the activity vocabulary's table, not the
  sprite modules'.

## Rerunning the scripts

Run them on a **copy** of `office/` outside the checkout, with any Python that has Pillow and numpy
(ComfyUI's own venv has both): `finish.py`, `emit_ts.py` and `edit.py` write PNGs and JSON beside
themselves, and `nul:check` refuses an untracked PNG. On such a copy, `finish.py` then `emit_ts.py`
reproduce `contact.png` byte for byte and the nine grids of `bot-sprites.ts` exactly (checked on
2026-11-05); the module's header and its `BOT_INKS` line are the repository's, so compare the grids
rather than the whole file.

## Failures and caveats

- Comfy Desktop 1.1.8 opened to its launcher and never spawned the Python server (nothing on :8000
  after about six minutes). The server was started directly, with the venv and arguments Desktop
  had used last time, and stopped afterwards.
- `ImageScale` to 768² did not speed sampling up on MPS (about 40–50 s per step, the same as at
  1 MP); the first steps of some images ran at 85–234 s per step under memory pressure.
- The night outline is invisible on a night background, as it is for the peek bot; on white the
  sprites have a full outline. The raised arms (raise_hand, cheer) and the thinking arm are the
  noisiest areas the reduction left, and the first candidates for further hand clean-up.
- The raw renders regenerate from the two workflows (fixed seeds), but MPS output can differ in the
  last bits between versions, so a regenerated edit may not pixelize to exactly the committed raw
  grid; `office/work/px/` is kept so `finish.py` reproduces the shipped grids regardless.
