# 18 — The sign-in mascot: how the robot was made

The robot that hides behind the sign-in form (`apps/web/src/features/peek-bot.tsx`, pixels in
`peek-bot-sprite.ts`, loop in `styles.css`, page described in technical/09 § "The sign-in page") was
drawn with **local** image models in ComfyUI and then reduced to palette-exact pixel art by the two
scripts in this directory. This page is the recipe, so a new pose or a redesign starts from what
worked rather than from scratch.

## The decisions, and why

- **An original character, not a game's mascot.** The brief was "inspired by Astro Bot". The
  result keeps the genre — a toy-like round helmet, a dark visor with glowing eyes, an antenna, ear
  pods — and draws it in the page's own `--signin-*` colours (amber eyes and antenna = the Sign in
  button). A look-alike of a trademarked character on a product's front door is a legal risk; the
  prompts below never name one.
- **Key frames from an edit model, not a video model.** A video model (Wan 2.2, LTX) gives smoother
  motion, but on Apple-silicon MPS a clip costs many minutes, it smears a pixel grid, and an MP4 has
  no alpha — the bot would bring a rectangle of baked-in background over the *animated* dither
  field. An instruction-editing model keeps the character identical across frames, which is what a
  sprite needs, and the motion itself (rise, duck, half-peek) is a CSS slide that needs no frames.
- **Text grids in the source, not an image asset.** After snapping to six colours the whole sprite
  sheet is ~1 kB; as text it is hand-editable (the eyes were fixed by hand), diffable, themed through
  CSS variables, and it needs no URL attribute (`apps/web/src/no-html.test.ts` admits URLs only
  through `ui/untrusted.tsx`).
- **One sprite pixel = one dither cell (5 CSS px).** The bot sits on the same grid as the field
  behind it; the loop moves it in whole sprite pixels (`steps(n)` over n × 5 px).

## The pipeline

Measured on an M3 Max (36 GB, MPS), ComfyUI 0.44.0 on port 8000 (the comfyui MCP's), 2026-11-04.

1. **Master** — `workflows/01-master-z-image-turbo.json` (API format; open it with ComfyUI's
   *Load* or enqueue it). Z-Image Turbo bf16, `CLIPLoader` `qwen_3_4b` type **`lumina2`**,
   `z_image_ae` VAE, `ModelSamplingAuraFlow` shift 3, 9 steps `res_multistep`/`simple`, cfg 1,
   1024², batch 4, seed 271828, the prompt asking for a flat **pure green** background (easy to key).
   Batch item 4 (`master_00004_.png`) is the bot: it was already waving. About 3 min for the batch.
2. **Poses** — `workflows/02-poses-qwen-image-edit-2511.json`. Qwen-Image-Edit 2511 Q6_K GGUF +
   the Lightning 4-step LoRA, `ModelSamplingAuraFlow` 3.1 + `CFGNorm`, `CLIPLoaderGGUF`
   Qwen2.5-VL-7B Q8, `qwen_image_vae`; the master through `FluxKontextImageScale` into both the
   encoder and a `VAEEncode` latent (an empty latent re-synthesises instead of editing). Two edits:
   the other half of the wave (`wave_b`) and both hands on a ledge (`peek`). Both prompts start
   "Keep the exact same robot … Everything else stays identical", which held the character to the
   pixel. About 4 min for the pair.
3. **Pixelize** — `pixelize.py <out_dir> <cell_px> <cut_y> <frame.png>...` (any Python with Pillow
   and numpy; ComfyUI's own venv has both). Keys out the green, crops every frame to one shared box
   cut at `cut_y` (the ledge line in the peek frame, 862 px — it becomes the card's top edge),
   reduces each `cell_px` block to its **most common** palette colour (an average would invent
   in-between colours) in CIELAB, and writes a sprite sheet plus an 8× preview. 24 px cells gave a
   37 × 35 sprite (≈ 185 × 175 CSS px), the right size next to the 448 px card; 16 was too big, 20
   split the eyes worse.
4. **By hand, into `peek-bot-sprite.ts`** — the sheet converted to one character per pixel
   (`N L D S W E` = night, lit, edge, muted, text, beacon); both eyes redrawn as one symmetric 5 × 5
   shape at columns 12 and 24 (the grid had split them unevenly); rows 0–20, above any arm, copied
   from the peek frame into both wave frames so the antenna does not flicker on a swap; a blink layer
   drawn over any frame. `peek-bot.test.tsx` holds each of these.
5. **Loop** — the 10 s timeline is CSS (`peek-bot-*` keyframes in `styles.css`), its 0 % and 100 %
   identical (hidden behind the card, peek frame), so it loops with no seam.
6. **Exports, when wanted** — `render_loop.py <peek-bot-sprite.ts> <out_dir> <scale> <fps>` renders
   the same loop from the grids into a transparent GIF, a lossless animated WebP and an MP4 on the
   night colour, and asserts that the last frame is the first. **Its keyframe table is a copy of
   `styles.css`'s — change both together.** At scale 10 and 50 fps: 370 × 350, GIF 294 kB, WebP
   50 kB, MP4 52 kB.

## What is not in the repository

The four master renders and the two edits (PNG, ~0.8 MB each) are not committed — the repository
holds no binaries, and `nul:check` refuses one not declared in `.gitattributes`. They regenerate from
the workflows (fixed seeds; MPS output can differ in the last bits between versions), and the
frames that matter are already the grids in `peek-bot-sprite.ts`. To add a pose, regenerate the
master from step 1, edit it in step 2 with the same "keep the exact same robot" prompt, and run step
3 with the **same** `cut_y` and cell size so the new frame lands on the same grid.
