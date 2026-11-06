# TD-033 — Visual design language: GitHub's grammar in the sign-in page's colours, one activity vocabulary, and three live visualisations

- **Status:** accepted
- **Date:** 2026-11-05
- **Deciders:** product owner (brief of 2026-11-04 and 2026-11-05, with the instruction to "follow your
  recommendations if you can reason about why they are good"), orchestrator (session 22)
- **Relates to:** product/10 (the visual design language was left to Round 2), technical/09, TD-013
  (amended: Base UI adopted, Q46 closed), TD-031 (the worker's local UI reuses this), research/18
  (the mascot), research/19 (the full plan, inventory and sources), Q46

## Context

product/10 left the visual design language undecided. research/19 inventories the SPA and finds five
problems:
- no sense of place;
- every section has the same weight;
- no next step;
- engineer's vocabulary on screen;
- no status icons.

The owner asked for:
- GitHub's clean developer UI in the sign-in page's brand (night/ink purple, beacon amber, the pixel
  wordmark, the mascot);
- "leading the user as a wizard";
- an overview of what agents and workers are doing that is fun to watch (a pixel office);
- a clickable node-graph of the pipeline and of a task's run;
- a user who can always tell which phase a job is in, on the platform and on the worker's local page.

## Decision

1. **Grammar = GitHub's (Primer).** Every screen uses five regions, without exception:
   - top bar: where am I, plus global actions;
   - underline nav: the sections of the current object;
   - left NavList: sub-sections, filters or a job list;
   - page header: title, state and **one** primary action;
   - list box: a header row with counts and filters, then rows with a status icon first.

   Inside a project the second row becomes the project's tabs. Org settings and project settings use
   sub-routes with a NavList. research/19 §5 is the screen-by-screen layout.
2. **Colour roles.** GitHub's dark layers are mapped onto the sign-in palette:

   | Role | Colour | Value |
   |---|---|---|
   | header | deep night | `#0f0d22` |
   | canvas | night | `#15132b` |
   | subtle | ink | `#1f1c3d` |
   | hover | — | `#29254d` |
   | border | lit | `#3a3570` |
   | input border | edge | `#7671b0` |
   | text | — | `#ece9ff` |
   | muted text | — | `#a7a2cc` |
   | links and focus | lavender | ≈ `#b3a8ff` |

   - **Beacon amber `#f4b860` means "the thing to do / the thing happening".** It is used for the
     primary button (night text), the selected-tab underline, the running state and "needs you".
   - Light theme: GitHub-light with a purple cast. **The top bar stays night in both themes.**
   - **Default theme is dark**, the brand. `system` and `light` remain choosable.
   - Semantic tokens follow Primer's tiers (`--bg-*`, `--fg-*`, `--border-*`, `--success-*` …). Base hex
     values appear only in the token block of `styles.css`.
   - `apps/web/src/ui/contrast.test.ts` computes WCAG ratios for every declared pair in both themes:
     4.5:1 for text, and 3:1 for borders, focus, underline and icons. It is enforced, not remembered.
3. **Font: Inter Variable, self-hosted** (`@fontsource-variable/inter`, OFL-1.1).
   - One latin woff2 from `'self'`, which `font-src 'self'` already allows.
   - The sign-in headline keeps its Black weight on every OS, instead of being whatever the visitor's
     `system-ui` is.
   - Monospace stays `ui-monospace`.
4. **Icons: `@primer/octicons-react`** (MIT), imported per icon. GitHub's own glyphs make the borrowed
   grammar read as intended. They are React SVG elements, not markup sinks.
5. **Behaviour: `@base-ui/react`** (MIT) for Menu, Dialog, Tooltip, Popover and Tabs. It was TD-013's
   original choice, and Q46's blocker (it was only an rc) is gone at 1.9.
   - Its positioning writes CSSOM, which `script-src` governs and `style-src` does not. React's `style`
     prop is the same mechanism, and `peek-bot.tsx` already uses it.
   - `csp.spec.ts` proves a menu, a dialog and a tooltip open under the production policy before any
     screen depends on them.
   - Everything else is a thin hand-written primitive in `apps/web/src/ui/`.
6. **One activity vocabulary, everywhere a run or a seat is shown.** A pure function
   `activityOf(...)` in `apps/web/src/ui/activity.ts` maps what the client already receives to one of:

   | Activity | When | Office pose |
   |---|---|---|
   | `working` | a tool call is in flight or was the last entry; sub-label from the tool: *Reading files*, *Editing code*, *Running a command*, *Searching*, *Delegating*, *Using {tool}* | typing |
   | `thinking` | thinking or assistant text was last, no tool pending; *Brainstorming* for the planning roles | hand on chin, thought bubble |
   | `needs_you` | an open question or approval, or `needs_human` | raised hand, beacon `!` |
   | `waiting` | queued, offered or starting: no seat yet | on the bench |
   | `stuck` | running but silent past a threshold, or the lease is late | scratching head, `?` |
   | `idle` | a free seat | sleeping, `Z` |
   | `paused` | worker paused or draining, or the task paused | coffee |
   | `done` | — | cheer |
   | `failed` | — | slumped, X eyes |

   - Each activity has one icon, one colour token, one human word and one mascot pose.
   - The record is exhaustive (`Record<Activity, …>`), so a new activity fails `typecheck` until all
     four exist.
   - All machine states get human labels through `apps/web/src/ui/humanize.ts`, also exhaustive.
   - Spec references (`BD-`, `TD-`, `WP-`, `product/NN`) never appear in UI text, which a census test
     enforces.
7. **"Which phase is this job in" is one component, `PhaseTrack`.** It is a compact strip of the task's
   pipeline stages (done ✓ / current ● / upcoming ○ / returned ↺), with the current stage's human
   name and the activity's sub-label ("Review · Now: Reading files"). It appears on:
   - board cards;
   - Agents and Inbox rows;
   - the task header;
   - every office seat;
   - the worker's local page.

   It is light (no dependency) so the worker entry's 120 kB budget holds.
8. **Three live visualisations, all clickable, all lazy-loaded route chunks** (`apps/web/src/viz/`):
   - **(a) Flow canvas.**
     - Built on `@xyflow/react` (MIT) on a dotted grid. Nodes are stage cards (name, status dot +
       word, "Now: …", model). Edges are dashed, animated while live; a return loop is drawn as a
       curved edge carrying its counter.
     - It is used read-only for the **pipeline template** (project → Pipeline) and **live for one
       task** (task → Flow, the default tab while a run is live).
     - Clicking a node opens a **Dialog** with the stage's run: a live log tail, a "Live activity"
       timeline (time · icon · activity), cost, model and links.
     - A node is a real `<button>`, so the graph is keyboard-reachable. A list fallback renders the
       same stages for screen readers and narrow screens.
   - **(b) Fleet map.**
     - Org → seats (each worker machine, and the server's own claimant) → the run card each seat
       holds; the queue of offered runs sits to one side.
     - Same canvas, same node cards, same dialog. It is the Agents page's default view.
   - **(c) Office.**
     - A pixel-art room in the brand palette. Each seat is a desk with the mascot posed by its
       activity, a speech bubble with the "Now: …" line, and a nameplate (worker · project · ticket).
     - Waiting runs sit on a bench by the door. Agents that need you stand at a beacon-lit "help
       desk".
     - Clicking a desk opens the same dialog.
     - Sprites are **text grids** in the six brand inks, drawn as SVG `<rect>` runs and animated by
       CSS classes. There are no image URLs, which matters because `no-html.test.ts` admits URLs only
       through `untrusted.tsx`. research/18's recipe makes the poses.
     - `prefers-reduced-motion` freezes every pose on its first frame.
     - It is the Agents page's second view, and the worker's local page shows its own single room.
   - All three update from the SSE stream the screens already use, with no new transport. Their text
     (ticket titles, progress lines, tool arguments, log lines) is untrusted (BD-022) and renders as
     React text through `ui/untrusted.tsx`.
9. **Wizards for things done once, direct manipulation for things done daily.**
   - Wizards: project onboarding and adding an integration. Each has a Stepper, addressable steps,
     resume, skippable optional steps and an ending that opens the next screen.
   - Not wizards: the board, the task, the inbox and settings.
10. **Bundle.** The initial graph stays ≤ 300 kB gz (`bundle:check`).
    - The flow canvas and the office are lazy chunks.
    - `ui/` holds no heavy dependency, so the worker entry (≤ 120 kB gz, TD-031) can import it.

## Consequences

- technical/09 gets a § "Visual design language" pointing here, and its structure section names
  `ui/` and `viz/`. The user guide's screen sections are rewritten slice by slice. The top-navigation
  census changes once, when the frame lands.
- Tests that anchor on accessible names mostly survive. Where a control moves behind a tab, a menu or a
  dialog, the test gains one interaction step. That churn is accepted and budgeted per slice
  (technical/13, milestone M23).
- Three new runtime dependencies (`@fontsource-variable/inter`, `@primer/octicons-react`,
  `@base-ui/react`) and one lazy one (`@xyflow/react`) enter `THIRD_PARTY_NOTICES.md` through
  `pnpm notices`.
- **Rejected:**
  - a canvas or WebGL game engine for the office (PixiJS/Phaser): a large dependency, no DOM text
    for screen readers, and a second rendering model to secure;
  - animated image files for sprites: URL attributes, a binary asset pipeline, no theming;
  - Mona Sans: a display face that would also change the sign-in page;
  - hand-rolled menus and dialogs: APG behaviour done by hand.

## Amendment 2026-11-05 — one dark theme; the page darker than its cards (product owner)

The product owner looked at the deployed screens and decided two things:
- **"Single theme dark only, no light/system switching."**
- **The page background should be darker than the content cards, using the top bar's colour.**

Decision 2 changes as follows:
- **One theme.** There is no light theme, no `system` option, no theme control in the avatar menu or
  Settings → Appearance, and no `data-theme` switching. The light token block and its contrast pairs are
  deleted. `color-scheme: dark` is set on the root. product/10's "Dark/light theme" is amended to match.
- **Layers.**
  - The page (`--bg-canvas`) is **deep night `#0f0d22`**, the top bar's colour.
  - Cards, boxes and list boxes (`--bg-default`) sit one step lighter on **night `#15132b`**.
  - Their header rows and the hover state are `--bg-subtle`, **ink `#1f1c3d`**, and `#29254d`.
  - The top bar is separated from the page by its bottom border, as on GitHub's dark dimmed theme.
  - `contrast.test.ts` holds every text pair against **both** the page and the card ground.
- Decision 2's light-theme bullet and "`system` and `light` remain choosable" are superseded. The office
  view was always dark, so nothing changes there.


## Amendment 2026-11-06 — a list row is clicked anywhere, not on its title (product owner)

The product owner, on Home's *Needs you* list: rows "need to just click on the title or CTA — it would be
good to have default action clicking on the whole row … I need to click precisely on a title".

Decision: every list row, card or board item that **has a destination** opens it from anywhere on the row,
by GitHub's **stretched link** (S-23.26, `apps/web/src/ui/row-link.ts`, `styles.css` "Whole-row click
targets"):
- **One real link per row.** The row's primary control carries the stretch (its `::after` covers the row).
  There is no `onClick` on a `<li>`, `<div>` or `<tr>`, so the tab order, ⌘/Ctrl- and middle-click into a new
  tab, *Copy link* and a screen reader's list of links stay the browser's.
- **A row click only navigates or opens.** It never performs a mutation. A row whose only control is a
  command (*Take this one*, *Re-queue*) gets no stretch and no hover.
- **Everything else in the row stays its own.**
  - Other controls (buttons, menus, copy, secondary links) sit above the stretch.
  - So does any element with a native `title=`, so a count's or a cost's definition still shows (product/10:
    "every number shown has a tooltip").
  - So does free text a person may want to select (`ROW_LINK_LIFT`).
- **The row says it is clickable.** It gets the hover ground `--bg-subtle`, and the focus ring goes round the
  whole row when its link has keyboard focus.
- **It is held by tests.** `row-link-census.test.ts` refuses a row that renders a title link without the
  primitive. `test/web-e2e/row-click.spec.ts` clicks a row's meta text with a real mouse. BACKLOG 949 lists
  the rows deliberately left as they are.


## Amendment 2026-11-06 — every content block on a card; fields inset; no card inside a card (product owner)

The product owner, on the deployed screens: "many cards across platform still use the same background color as
the body/content background itself", and the native `<select>` "without proper styling".

The 2026-11-05 amendment gave the page and the card two grounds. This amendment says which content goes on
which ground (S-25.10, S-25.10b):
- **The page (`--bg-canvas`) holds only the frame.** That means the page heading and its one-line intent,
  the navigation, the tabs, and the Settings side list. Every other block of content sits on a card:
  - a form;
  - a list;
  - a panel;
  - a wizard step;
  - a notice that belongs to a section;
  - a blankslate standing alone.
- **A card is `--bg-default` with the default border** (`ui/card.tsx`, `SettingsCard`). Its header row is
  `--bg-subtle`. Dialogs and menus use the same ground.
- **A field is `bg-inset`**, one step darker than the card it sits on. This covers inputs, textareas and the
  branded Select (`ui/select.tsx`, which replaces the native `<select>` everywhere). It also covers a code
  block and a log inside a card. A field is never on the card's own ground. Nothing on a card is drawn on the
  canvas colour.
- **No card inside a card.** Inside a card, a sub-section is separated by a divider or a heading, never by a
  second border:
  - an empty list is a borderless blankslate, or a plain line of text;
  - a notice is a coloured line, not a box.
  A screen that needs two separate boxes puts them side by side on the page, not one in the other.
- **Held by tests.**
  - The S-25.10 card-ground census refuses a bordered box on the wrong ground.
  - `test/web-e2e/settings-cards.spec.ts` and `page-cards.spec.ts` open every Settings, Admin and project
    screen, the task and run pages, and both wizards against the fixture backend. They fail on visible text
    that sits on the canvas colour outside the frame. A screen the fixture backend cannot load does not count
    as checked.
