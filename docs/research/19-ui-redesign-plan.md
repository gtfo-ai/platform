# Research 19 — the UI redesign: a GitHub-shaped control tower in the sign-in page's colours

Prepared 2026-11-04 (session 22) at the product owner's request: *"a user friendly and understandable UI with
good UX, respecting our brand identity as on the login page (the colours, the main font, the logo), inspired
by GitHub … leading the user as a wizard, not just CRUD."* **Status 2026-11-05:** decided as **TD-033** and scheduled as milestone **M23** in technical/13. D1–D4 were answered
per the recommendations: Inter, Octicons, Base UI, and dark by default with a night top bar. On 2026-11-05 the owner
widened the brief to live visualisations (the pixel office, the fleet map, the flow canvas) and to an always-visible
phase. Those are in TD-033 decisions 6–8 and in §11 below. product/10 already says the visual
design language "is a Round 2 topic". It was never decided, so this fills that gap rather than reopening a
decision.

Inputs: the sign-in page (`features/sign-in.tsx`, WP-291), seven GitHub screenshots the product owner
supplied (Issues list, Actions run list, Actions run summary, Actions job log, repository code page,
dashboard), the current SPA (inventory in §2), and the sources in §10.

**Status 2026-11-05 (later): delivered as M23** — see `docs/technical/LEDGER.md`, S-23.1 to S-23.17 (S-23.12, the worker's
local page, was delivered by M22's S-22.13 with this session's visual review), in **one theme, dark only** since S-23.17 (TD-033's amendment; D4's light
and system choices are gone). The design language as built is technical/09 § "Visual design language (TD-033)".
Still open, in `docs/technical/BACKLOG.md`: per-project *needs you* counts on Projects and the project header (810),
the project header on `/tasks/$taskId` (811), the initial graph's last 10 kB (812), the remaining raw enum words (903),
Home's and the wizard's shared done-ness (825), the board's first page only (840), the wizard's draft and
§ 6's collapsible operating-mode panels (830, 822), the Agents page's missing reads (870–873), Statistics' charts (882)
and Home's dither strip (817).

---

## 1. What "the brand" is, concretely

| Asset | Where it lives today | Value |
|---|---|---|
| Wordmark *agentic.* | `ui/logo.tsx` (inline SVG, `currentColor` + beacon dots) | pixel letters, 5-unit grid |
| Night (page) | `--signin-night` | `#15132b` |
| Ink (raised block) | `--signin-ink` | `#1f1c3d` |
| Lit (dither cell / quiet border) | `--signin-lit` | `#3a3570` |
| Edge (field border, 3:1) | `--signin-edge` | `#7671b0` |
| Text | `--signin-text` | `#ece9ff` |
| Muted text | `--signin-muted` | `#a7a2cc` |
| Beacon (the one action) | `--signin-beacon` | `#f4b860` |
| Main font | `body` font stack = **`system-ui`**, so SF Pro on macOS (what the screenshot shows), Segoe UI on Windows, and whatever the distribution ships on Linux | headline `font-black`, `tracking-[-0.03em]` |
| Pixel motifs | dither field (`dither-field.ts`), peek-bot sprite (`peek-bot-sprite.ts`) | 5 px cells, ordered dither |

**Finding: the font is not a brand asset today, it is the visitor's OS.** The headline the product owner
liked is SF Pro Black. On Windows the same page renders in Segoe UI Black, and on most Linux desktops in
Cantarell or DejaVu. For "the main font" to be part of the identity it has to be shipped. See decision D1.

**Mapping GitHub onto the brand.** GitHub's dark UI has four layers, plus one accent that marks *where you
are* (the orange underline under the selected tab) and one colour that marks *the main thing to do* (the
green button). The sign-in page already has the same structure:

| GitHub dark (role) | Ours (dark) | Note |
|---|---|---|
| header `#010409` | **deep night** `#0f0d22` (new, darker than night) | the top bar, as on GitHub |
| canvas `#0d1117` | **night** `#15132b` | page background |
| subtle `#151b23` (box headers, selected nav) | **ink** `#1f1c3d` | list-box header row, sidebar selection |
| muted / hover | `#29254d` (new) | row hover |
| border `#3d444d` | **lit** `#3a3570` | box and row borders (decorative, no 3:1 needed) |
| input border | **edge** `#7671b0` | 3:1 against the fill (WCAG 1.4.11), as measured at WP-291 |
| fg / fg-muted | **text** `#ece9ff` / **muted** `#a7a2cc` | 15.2:1 and 7.5:1 on night (measured) |
| link blue `#4493f8` | **lavender** ≈ `#b3a8ff` (to measure, ≥ 4.5:1 on night and on ink) | links, focus ring, selected-row bar |
| selected-tab underline (orange) | **beacon** `#f4b860` | GitHub's orange becomes our amber |
| primary button (green) | **beacon** button with night text (10.2:1, measured) | exactly the sign-in button |
| success / danger / attention | green / red / amber, re-tuned for a purple ground | measured in the contrast test (§4.1) |

In-progress is amber on GitHub (the spinning dot on a running workflow). It is amber here too, so a running
agent and the beacon share a hue. That is intentional: the beacon is "the thing happening / the thing to do".

> **Superseded 2026-11-05 (TD-033 amendment): dark only.** There is no light theme and no theme switch; the page is deep night and cards sit on night.

**Light theme.** product/10 requires dark and light. The light theme is GitHub-light with a purple cast:
canvas white, subtle `#f6f5fb`, border `#dcd9ec`, fg `#1b1838`, muted `#5c5785`, links indigo ≈ `#5646d6`.
**The top bar stays night in both themes.** That is the brand anchor, and the wordmark lives on it. The
amber underline fails 3:1 on white (≈ 1.7:1), so in light mode the selected tab uses a darker amber
(≈ `#b7791f`) or indigo. The contrast test decides which. The beacon button keeps night text, so it
passes on any ground.

---

## 2. What is there today (the inventory, condensed)

The full per-screen inventories were done by two read agents. These are the findings that shape the plan:

1. **No place to stand.**
   - There is no Projects item in the navigation. The only way into a project is a name link on a
     dashboard card (`dashboard.tsx:149`).
   - Inside a project the header does not change. Knowledge, Pipeline, Budgets and Shadow have no way back
     to the board and do not show the project's name.
   - The board's links to them are underlined text in a heading's action slot (`board.tsx:280-322`).
2. **Everything has the same weight.** Every section is the same `Card` + small grey uppercase
   `SectionHeading`.
   - The task page's centre column stacks about 13 sections (stage commands, take-over, breakdown,
     questions, approvals, ask thread, activity, artifacts, runs, feedback …) with no hierarchy. Open
     questions, the thing a person most likely came for, are seventh.
   - The run page puts *Retry with model/effort* in the same row as the view tabs.
3. **No "next step".**
   - Onboarding is one long page showing all six steps at once. It has no stepper, no done marks, and no
     ending such as "your project is ready → open the board". Steps 3–5 are empty states until step 1 is
     done.
   - The dashboard's empty state says "use the wizard" without a button.
   - Integrations shows up to six buttons per card, and its *Add* form always sits at the page's foot.
4. **Engineer's vocabulary on screen.**
   - Raw states and ids: `waiting_approval`, `ci_gate`, criterion ids as badges, run UUIDs, handler names.
   - Raw JSON: artifact bodies, audit diffs.
   - Config keys as labels: `site_url`.
   - Spec references in user-facing prose: "(product/06)", "BD-012", `APP_INTEGRATION_SECRET_ENV`.
   - Long explanatory paragraphs above most panels.
5. **No icons.** Status is a coloured pill with a word. GitHub's lists read at a glance because of the
   status icon (✓ ✗ ● ◌) in the first column.
6. **Long single pages where GitHub uses a sidebar.**
   - Org settings stacks eight unrelated sections: appearance, users, identities, policies, dead letters,
     failed jobs, instance, budgets.
   - Project settings stacks nine.
   - The run page has no job list. The stage list exists only on the task page.

What is **good, and must survive**:
- the always-dark sign-in page;
- the live-update architecture and the connection badge;
- the untrusted-text discipline (`ui/untrusted.tsx`, `no-html.test.ts`);
- the two error boundaries;
- reduced motion;
- `Metric`'s "every number has a definition";
- the checks-panel census;
- the fact that tests mostly anchor on accessible names and visible strings rather than layout. That last
  one makes a re-skin cheap, and moving things behind tabs or menus less cheap (§7).

---

## 3. UX principles this redesign is held to

Each one is sourced (§10) and turned into a checkable rule.

1. **One primary action per view, in beacon amber, top-right of the page header.** Everything else is a
   default button or lives in the overflow menu (`···`), as on GitHub ("New issue", "Cancel workflow" +
   `···`). *Check:* a census test counts `tone="primary"` buttons per rendered screen. More than one fails,
   except inside a dialog or a per-row inline form.
2. **"What needs you" comes first, everywhere.** The sign-in page's own promise is *"see what your agents
   are working on — and what needs you"*.
   - Home opens with the needs-you list.
   - The task page opens with a callout for any open question, pending approval, or `needs_human` state,
     with the action inline.
   - The board highlights cards that need a person.
   - The inbox count sits in the top bar (GitHub's notification dot).
3. **Status at a glance: icon + colour + word, never colour alone** (WCAG 1.4.1). There is one
   `StatusIcon` vocabulary for runs, stages, checks, tasks, integrations and jobs (§4.3).
4. **Wizards for things done once, direct manipulation for things done daily** (NN/g, *Wizards*).
   - **Wizards:** project onboarding and adding an integration. Each shows a step list with the current
     step highlighted and descriptive step names. Continue buttons say where they go ("Continue to
     discovery"). Progress is saved and resumable, and optional steps are skippable.
   - **Not wizards:** the board, the task, the inbox and settings stay direct.
5. **Empty states teach and offer the next action** (NN/g, *Empty states in complex applications*). Every
   empty state does three things: it says nothing is there, it says what will appear, and it offers a
   button that goes there. It never shows "No records" while loading; loading gets a skeleton.
   *Check:* `Blankslate` requires `title` and `hint`, and requires an `action` unless `informational`
   is set.
6. **Progressive disclosure instead of paragraphs.**
   - Explanations move into a one-line hint, a tooltip (`Metric` definitions), or a *Learn more*
     disclosure linking to the user guide.
   - Spec references (product/NN, BD-/TD-/WP-) never appear in UI text. *Check:* a census test greps
     rendered strings for `\b(BD|TD|WP)-\d+|product/\d+` and fails.
   - Raw ids and JSON move into a collapsed *Details* section.
7. **Human words for machine states.** One `humanize.ts` maps every state, stage id, role, gate, artifact
   type and trigger to a label: `waiting_approval` → "Waiting for approval", `ci_gate` → "CI".
   *Check:* exhaustive `Record<State, string>` types, so a new state fails `typecheck` until it has a
   label.
8. **Same place, same thing.** GitHub's layout grammar, applied without exception:
   - **top bar** = where am I + global actions;
   - **underline nav** = sections of the current object;
   - **left sidebar** = sub-sections, filters or a job list;
   - **page header** = title + state + the one primary action;
   - **list box** = header row with counts and filters, plus rows.
9. **Never block on agent activity** (product/10). Dialogs are only for a *human's* destructive or
   multi-field action (retire, cancel, take over), never for something an agent is doing.
10. **Keyboard first, as technical/09 already promises:** `/` search, `g h` home, `g i` inbox, `g a`
    agents, `g b` board, `?` sheet, `j/k` in lists.

---

## 4. The design system (foundation work)

### 4.1 Tokens (`styles.css`)

- **Semantic tokens, Primer-style tiers.**
  - Names: `--bg-header`, `--bg-canvas`, `--bg-subtle`, `--bg-muted`, `--bg-inset`, `--border-default`,
    `--border-muted`, `--border-input`, `--fg-default`, `--fg-muted`, `--fg-subtle`, `--fg-link`,
    `--fg-on-emphasis`, `--accent-selected`, `--action-primary-bg`, `--action-primary-fg`,
    `--success-fg/-bg`, `--danger-fg/-bg`, `--attention-fg/-bg`, `--done-fg` (purple "merged", as
    GitHub) and `--running-fg`.
  - Each is mapped through `@theme inline` the way the current eight are, so `bg-canvas` keeps working.
  - Base hex values are referenced only by the token block.
- **`--signin-*` stays.** The sign-in page keeps its own block, now aliased to the dark tokens so the two
  can never drift.
- **A contrast test that is enforced, not remembered** (the house style, as `bundle-budget.mjs` is for
  size).
  - `apps/web/src/ui/contrast.test.ts` parses `styles.css` and computes the WCAG ratio of every declared
    pair in both themes:
    - 4.5:1 for text pairs;
    - 3:1 for input borders, focus ring, selected underline and status icons against their ground.
  - This replaces the hand-measured numbers in technical/09 with a test that holds them.
- **Type scale (GitHub-sized):** 12 / 14 (body) / 16 / 20 (page title, semibold) / 24 / 32. The brand's
  `font-black` with tight tracking is reserved for three places: the Home greeting, wizard step titles,
  and blankslate titles. That way the identity shows without shouting on every page.
- **Radius 6 px, spacing on a 4 px grid, rows of 40–48 px.** These are GitHub densities, which suit a
  control tower.

### 4.2 Font and icons (assets)

- **Font: see decision D1.** The recommendation is to self-host **Inter Variable**
  (`@fontsource-variable/inter` 5.3.0, OFL-1.1). It is the closest freely licensed match to the SF Pro
  look on the sign-in page and has true Black (900).
  - Loaded through `@font-face` from `'self'`: `font-src 'self'` is already in `csp.ts`.
  - One latin `woff2`, `font-display: swap`, preloaded.
  - Fonts are not in the initial graph `bundle-budget.mjs` measures, which is scripts, modulepreloads and
    stylesheets. The plan still records the byte cost.
  - Monospace stays the system stack (`ui-monospace`), as on GitHub.
  - `pnpm notices` picks the licence up and `THIRD_PARTY_NOTICES.md` is regenerated.
- **Icons: see decision D2.** The recommendation is **`@primer/octicons-react`** (19.42.0, MIT): GitHub's
  own icon set, so the borrowed grammar reads exactly as intended.
  - Each icon is its own ESM export, so it is tree-shaken and the bundle check holds the cost.
  - Icons are inline SVG React elements, so they are not markup sinks and `no-html.test.ts` is unaffected.
- **Pixel accents (brand, used sparingly):**
  - the wordmark in the top bar;
  - a one-row dither strip under the Home greeting (reusing `dither-field.ts`, static, reduced-motion
    safe);
  - the peek-bot sprite in blankslates and the 404 page;
  - a pixel "beacon" dot as the running indicator in the top bar.

### 4.3 Primitives (`ui/kit.tsx`, split into `ui/*`)

**Behaviour library: decision D3.** Q46 deferred Base UI because only `1.0.0-rc.0` existed. **`@base-ui/react`
is at 1.9.0 today** (npm, modified 2026-10-09), so the stated blocker is gone, and TD-013 named it in the
first place. The recommendation is to adopt it for the five things that need real APG behaviour: Menu,
Dialog, Tooltip, Popover (project switcher, filters) and Tabs. Hand-written thin primitives stay for
everything else.
- **Check before adopting:** Base UI positions popups with CSSOM writes. `csp.ts`' own note says CSSOM
  writes are governed by `script-src 'self'`, not `style-src`. The existing `csp.spec.ts` must be run
  against a menu and a tooltip before this is relied on.

| Primitive | GitHub analogue | Replaces / used by |
|---|---|---|
| `Button` (`primary` beacon, `default`, `danger` outline-red like *Cancel workflow*, `invisible`), sizes sm/md, leading icon, trailing counter | Button | every button |
| `IconButton` (with required `aria-label`) | IconButton | top bar, row overflow |
| `ActionMenu` (`···` overflow, Base UI Menu) | ActionMenu | secondary actions on header and rows |
| `PageHeader` (back link, title, state label, meta line, actions) | PageHeader | every screen's top |
| `UnderlineNav` (with counters, overflow to "More" on narrow widths) | UnderlineNav | org nav, project nav, task tabs, run tabs |
| `NavList` (sidebar, groups, selected bar) | NavList | settings sidebars, inbox filters, run job list |
| `ListBox` + `ListBoxHeader` (open/closed counts, filter menus, sort) + `ListRow` (status icon, title link, meta line, right-aligned facts, overflow) | Issues / Actions list | agents, inbox, runs, audit, integrations, project list, task list view |
| `StatusIcon` (`queued` ◌, `running` ● animated amber, `success` ✓, `failure` ✗, `cancelled` ⊘, `skipped` –, `needs_you` ◆ beacon, `waiting` ◷) + `StateLabel` pill (icon + word) | CheckRun / StateLabel | everywhere status is shown |
| `Blankslate` (icon/sprite, title, hint, primary action, secondary link) | Blankslate | replaces `EmptyState` (API kept as an alias during migration) |
| `Flash` / `Banner` (info, warning, danger, success, with action) | Flash | `ErrorNotice`, platform-updated banner, needs-you callout |
| `Timeline` (vertical, icon badges, loop connector for returns) | Timeline | task stage timeline, activity |
| `Stepper` (vertical step list: done ✓ / current ● / upcoming ○ / optional tag) | — (NN/g wizard) | onboarding, add integration |
| `Tooltip` (Base UI) | Tooltip | `Metric` definitions (replaces `title=`) |
| `Dialog` (Base UI, focus-trapped, for human destructive or multi-field actions only) | Dialog | retire, take over, cancel, return to stage |
| `Skeleton` | — | loading states (instead of "Loading …" text) |
| `Avatar` (initials, deterministic hue from the lavender/amber family) | Avatar | user menu, actor in audit and activity |
| `Counter` | CounterLabel | nav counts, list header counts |
| `CopyField` | ClipboardCopy | webhook URL, branch, resume command |
| `DetailsDisclosure` | Details | raw ids, JSON, long explanations |

`humanize.ts` (§3.7) and an `ExternalLink` that still goes through `safeHref` (`ui/untrusted.tsx`) sit beside
them.

---

## 5. Information architecture and layout

### 5.1 The frame

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│ ☰  agentic. / ACME ▾                       [ / Search or jump to… ]   ● 2 running   + ▾  🔔3  (JM) │  ← top bar, deep night, both themes
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│  ⌂ Home   ▣ Projects 4   ✉ Inbox 3   ◎ Agents 2   📈 Statistics   ☰ Audit log   ⚙ Settings     │  ← org UnderlineNav (outside a project)
│  ── amber underline on the current item                                                       │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Inside a project, the second row becomes the project's own tabs**, the way a GitHub repository replaces
the dashboard nav:

```
│ ▣ ACME  Acme web shop  [Readiness L3]  [● Live]                         [Start a ticket]  ···  │  ← project PageHeader
│  ▦ Board 12   ☰ Tasks   📖 Knowledge ②   ⇄ Pipeline   $ Budgets   👁 Shadow   ⚙ Settings      │  ← project UnderlineNav
```

- **Top bar, left side.**
  - `☰` opens a slide-over with the global destinations and recent projects (GitHub's hamburger).
  - The wordmark links Home.
  - `/ ACME ▾` is a breadcrumb plus project switcher (Base UI Popover with a filterable list).
- **Top bar, centre.** "Search or jump to…" is a cmdk-style command palette over projects, tasks by ticket
  key, and screens. cmdk is already named in technical/09; it is phase P10, and until then the box is a
  jump-to-ticket field.
- **Top bar, right side.**
  - The **running indicator** ("● 2 running", amber pulse, links to Agents). It replaces the "Live" badge's
    job of showing life. The connection state becomes a small dot in it: green live, amber reconnecting,
    red disconnected. It keeps `role="status"`, `aria-live` and `data-testid="connection-status"`.
  - `+ ▾` is New project or Start a ticket.
  - **Inbox bell with count** (the `needs_you` total).
  - The **avatar menu** holds the signed-in name and role, Theme (moved here from the header `<select>`),
    Settings, the user guide and Sign out.
- **Onboarding leaves the nav.** It becomes *New project* (in `+ ▾`, on the Projects list, and in the Home
  checklist), because it is a thing done once (§3.4). `/onboarding` stays as the route.
  - `NAV` changes, which means `docs/user-guide.md` § "The top navigation" changes in the same commit.
    `user-guide-census.test.ts` holds the two together.
- **Projects becomes a page** (`/projects`, a new route): a list box of projects with readiness, open
  tasks, needs-you count, 30-day spend and a *New project* primary button.
  - `apps/server/src/web/` serves the SPA by an allow-list of first path segments. `projects` is already
    on it (`/projects/$key`), so a bare `/projects` needs to be checked against that allow-list. A bare
    path may need adding.
- **Project layout route.** `/projects/$key` becomes a layout route (component = project header + tabs +
  `<Outlet/>`). Board, knowledge, pipeline, budgets, shadow, settings and the project task route become its
  children. **No URL changes.** The board moves to an index child. `routes/tree.tsx` is the only router
  file touched. A task reached through `/tasks/$taskId` (from the inbox) shows the same project header once
  the task has loaded its `project_key`.
- **Content width.** Lists and detail pages are centred at `max-w-[1280px]`, as on GitHub. The board and
  the run log are full width.

### 5.2 Screens

Each screen below lists what it becomes, with its primary action in **bold**. ASCII is layout intent, not
pixel spec.

**Home (`/`, today's Dashboard)**: "what needs you, what is moving, where to go".

```
 Good afternoon, Jan.                                         ┌ Spend this month ─────────┐
 ▓▒░ (one-row dither strip) ░▒▓                               │ $412 of $1,000  ▓▓▓▓░░░░░ │
 ┌ Needs you (3) ───────────────────────────── View inbox → ┐  │ projected $890            │
 │ ◆ ACME-12  Refined spec needs approval    Approve  ···   │  └───────────────────────────┘
 │ ◆ ACME-9   Question from the reviewer     Answer   ···   │  ┌ Instance ─────────────────┐
 │ ◆ SHOP-4   Needs a human: budget cap hit  Open     ···   │  │ ● Live · v0.4 · 3 runners │
 └──────────────────────────────────────────────────────────┘  └───────────────────────────┘
 ┌ Running now (2) ─────────────────────────── Agents → ┐
 │ ● ACME-14 implementation · developer  12m · $0.84    │
 └───────────────────────────────────────────────────────┘
 ┌ Projects ──────────────────────── New project ┐
 │ ▣ ACME  L3 · 12 open · 1 needs you · $310      │
 └───────────────────────────────────────────────┘
```

- **First run** (no project, or no integration): the page *is* a setup checklist (a Stepper in a box):
  1. Connect your tracker and git host.
  2. Create a project.
  3. Run technical discovery.
  4. Choose how autonomous agents are.
  5. Start your first ticket.

  Each item shows ✓ when the data says it is done, and there is one **Continue setup** primary button.
  `/api/setup-state` today carries only `first_sign_in_pending`, so done-ness is derived on the client from
  `/api/integrations`, `/api/projects` and each project's readiness, onboarding state and tasks. This needs
  **no new endpoint**, though a small server projection would be cleaner (open item O1).

**Projects (`/projects`, new)**: list box. **New project**.

**Board (project tab)**: GitHub Projects' board look, plus a *List* view toggle.
- **Columns** stay the five the board has today. product/10 says "columns = stages from the template". That
  deviation is pre-existing and is not widened here. It is noted as open item O2.
- **Column header:** name + counter. The *Needs human* column's header carries the beacon accent.
- **Cards** have:
  - a status icon in place of the raw state pill, which duplicated the column;
  - the ticket key + title (title first, larger);
  - the template icon (feature/bug/chore/spike);
  - one meta line: stage label · time in stage · cost;
  - a **needs-you ◆** marker and question badge when relevant (product/10 asked for both, and neither
    exists today);
  - an amber running pulse;
  - iteration "review 2/3";
  - a `···` menu with Pause, Cancel, Return to stage, Open ticket and Open MR (product/10's card menu,
    missing today).
- **Narrow widths:** columns scroll horizontally below `xl` instead of wrapping into a 2×3 grid, so the
  pipeline still reads left to right.
- **List view** (`?view=list`): an Issues-style list box with filters for state, template and needs-you.
  This is the "Tasks" tab. It can share the board's query, so it needs no new endpoint.
- **Primary action: Start a ticket.** It opens a small dialog instead of the inline form. It is shown only
  when `can_start_task`.
- **Empty:** a blankslate with the robot: "Tickets you label for agents appear here", **Open pickup rules**
  (project settings → Connections), and a secondary *Start a ticket by hand*.

**Task (project child)**: a pull request page.

```
 ← Board
 Add VAT to invoices  ACME-12                                        [Approve spec]   ···
 ◆ Needs you · Feature · in Refinement · $1.20 so far · 2 h 14 m
 ┌ ◆ The refined spec is waiting for your approval ─────────────────────────────────┐
 │ Approve to start implementation, or send it back with a reason.  [Approve] [Return…] │
 └──────────────────────────────────────────────────────────────────────────────────┘
  Overview   Artifacts 3   Runs 5   Activity                    │ Checks
 ───────────                                                     │ ✓ All required checks pass
  ● Implementation · developer — running 12 m  [Watch live]       │ ✓ CI · green
    "Writing the migration for vat_rates" (latest progress)      │ ✓ Rebase · up to date
  ✓ Plan · planner — 4 m · $0.12                                  │ ◷ Review threads · 2 open
  ↺ Review returned it: "missing tests" (loop 1/3)               │ – Coverage delta · not measured
  ✓ Refinement · refiner — 3 m · $0.08                            │ … (all eleven, census kept)
  ── Ask the task ──────────────────────────────────              │ Cost  $1.20 of $5 ▓▓░░░
  [ Why did you choose…?                        ] [Ask]          │ Links: ticket · MR · thread
```

- **Header.**
  - The title is the ticket title, with the key in muted text after it (as GitHub shows `#573`).
  - A StateLabel is followed by one meta line.
  - The primary action **depends on the state**: Approve / Answer / Resume / Hand back / none. Pause,
    Cancel, Take over, Retry stage, Return to stage, Rework and Download JSON go to `···`. Each of those
    opens a Dialog carrying the fields today's inline forms have (`Stage`, `Reason`, `Rework instructions`,
    *Why you are taking it over*), with the same labels so the tests' accessible names survive.
- **Needs-you callout:** open questions are answered *inline* in the callout. Approvals and breakdown
  decisions are in it too.
- **Tabs:**
  - **Overview** holds the live-stage panel and a stage timeline, which now shows duration, cost and
    returns drawn as loops (product/10 asked for those, and they are missing today). Ask the task and
    feedback follow.
  - **Artifacts** gets a left list of artifact types/versions and a right body. Raw JSON goes behind
    *Details*.
  - **Runs** is a list box with status icons.
  - **Activity** is the event list.
  - `?artifact=` keeps working and selects the Artifacts tab.
- **Right rail, Checks.** It becomes a GitHub merge-box: a summary line ("All required checks pass" or
  "2 checks need attention") above rows of `StatusIcon` + label + value. The definition is in a Tooltip;
  the basis sentence is in the row's expandable detail. Then a cost bar (`<meter>`, no `style=`) and links.
  `checks-panel.test.tsx`'s eleven labels are unchanged.

**Run (`/runs/$runId`)**: the GitHub Actions job page (screenshots 2–3).

```
 ← ACME-12 Add VAT to invoices
 ● Implementation · developer  run 3                         [Re-run ▾]  [Cancel run]  ···
 ┌ Summary ┐ ┌───────────────────────────────────────────────────────────────────────────┐
 │ Runs    │ │ Status Running · Model sonnet · Effort high · Cost $0.84 est · 12m 04s      │
 │ ✓ refine│ ├ Transcript  Prompt  Context pack  Settings ─────────── [Search transcript] ⚙┤
 │ ✓ plan  │ │ › ✓ Read  src/invoice.ts                                            0.2s    │
 │ ● impl  │ │ ⌄ ● Bash  pnpm test invoice                                         running │
 │ ○ review│ │     1  > vitest run invoice …                                               │
 │─────────│ │ › ✓ Edit  src/vat.ts  (+12 −3)                                      0.1s    │
 │ Details │ │   Assistant: I'll add the rate table first…                                 │
 │ Download│ ├─────────────────────────────────────────────────────────────────────────────┤
 └─────────┘ │ [ Steer the agent…                                              ] [Steer]   │  ← sticky while running
             └─────────────────────────────────────────────────────────────────────────────┘
```

- **Left NavList:** the task's runs in stage order, each with a status icon (the job list GitHub has and
  this page lacks). Below it, *Details*: settings hash, saved work, the download.
- **Header actions:**
  - **Cancel run** is the outline-danger button, like *Cancel workflow*. It is the only coloured action
    while the run is live.
  - **Re-run ▾** opens a menu holding today's "Retry with model / effort / Retry run" fields. It is
    primary after a failure.
  - Take over moves into `···` and opens a Dialog.
- **Transcript.** Tool calls become **collapsed log steps** (chevron, status icon, tool name, argument
  summary, duration right-aligned), exactly like Actions steps. Expanding one shows the existing
  renderer: diff, terminal with line numbers, file, nested agent. Assistant text stays as prose lines, and
  thinking stays collapsed.
- **Scrolling.** The log pane gets its own scroll container sized to the viewport, so the follow-tail
  toggle and the "paused, N behind" indicator behave as technical/09 describes. Today the page grows
  instead.
- **Command log** sits under the steer box as a compact list.

**Inbox**: GitHub notifications.
- The left NavList filters by All / Questions / Approvals / per project, with counts.
- Rows show a status icon, "ACME-12 · Refinement", the question's first line, age and due date.
- A question row expands in place to the answer box: **Answer**.
- An approval row opens the task on its callout. The data-testid and `data-inbox-expiry-note` survive, and
  the note becomes a one-line hint plus *Learn more*.

**Agents**: an Actions run list. Rows show:
- a running icon;
- **project · ticket key · title** (missing today);
- stage · role;
- model;
- elapsed, tokens/min and cost;
- the last tool call;
- a `···` menu with Cancel.

The header shows idle capacity and queue depth (product/10, unbuilt).

**Integrations**: a list box of integrations.
- Each row has a health icon, name, provider logo-less icon, "checked 5 m ago", and a `···` menu with
  Test connection, Edit configuration, Replace credentials, Setup guide and Retire (in a Dialog).
- Clicking a row opens a detail page (`/integrations/$id`, a new child route) with tabs Overview, Setup
  guide and Refused deliveries.
- **New integration** (primary) opens a 4-step wizard: pick provider (cards) → configuration (human labels
  such as "Site URL" for `site_url`; the raw key goes in the hint, so the tests' labels can be updated
  deliberately) → credentials (env-var names, explained in one line) → test connection → done.

**Onboarding / New project**: a real wizard. See §6.

**Settings (org)**: `/settings/*` sub-routes with a left NavList, each section its own page with one
**Save**:
- **Personal:** Appearance, Session.
- **Organisation:** General policies (commands, autonomy, WIP), Notifications, Budgets.
- **People:** Users, Provider identities.
- **Operations:** Dead letters, Failed jobs, Instance.

The Operations group is shown only to the roles that can act on it.

**Project settings**: the same NavList pattern under the project's Settings tab. Sections:
- Connections
- Default branch
- Discovery & readiness
- Business context
- History
- Policies & WIP
- Repository configuration
- Prompt files
- Knowledge

**Knowledge, Pipeline, Budgets, Shadow, Audit log, Statistics**: re-skinned onto the primitives.
- **Knowledge:** a file tree NavList, the document, a proposals list box with *Approve* per row, and health
  as a Flash.
- **Pipeline:** a key/value table with source badges, and the merged config behind *Details*.
- **Budgets:** meters with spent-of-limit.
- **Audit log:** list rows of avatar · actor · "changed the autonomy dial on ACME" · time, with the diff
  behind *Details*. The entity-type filter becomes a Menu of known types.
- **Statistics:** a metric strip plus charts. Recharts is TD-013's choice; it goes in a lazy route chunk,
  phase P9, and can be dropped if it costs too much. "Not measured, and why" collapses into one *Details*.
- **Shadow:** a list box of batches, and a batch page with the metric strip.

---

## 6. The onboarding wizard, in detail

```
 New project                                                          Save and exit
 ┌ Steps ──────────────────┐  ┌─────────────────────────────────────────────────────────┐
 │ ✓ 1 Connect             │  │  Technical discovery                         (font-black) │
 │ ● 2 Technical discovery │  │  An agent reads your repository and tells you how ready   │
 │ ○ 3 Business context  · │  │  it is for agents. It takes 5–15 minutes and costs up to  │
 │ ○ 4 History (optional)  │  │  $2.40.                                                   │
 │ ○ 5 How autonomous      │  │  [ Run discovery ]   (or: ● running 4 m — Watch live)    │
 │ ○ 6 Review & finish     │  │  Readiness: L3 ▓▓▓░░  Cheapest improvements: …            │
 └─────────────────────────┘  │  ← Back to Connect               Continue to Business →   │
                              └─────────────────────────────────────────────────────────┘
```

- **Route:** `/onboarding?project=<key>&step=<n>`, search params validated by zod like `?artifact=`. The step
  is addressable, so *Save and exit* plus the Home checklist resume exactly where the person left off. NN/g
  asks for "save progress, resume later".
- **Done-ness is computed from server state**, never stored on the client:
  - Connect is done when the project exists and has a tracker and a git binding.
  - Discovery is done when a readiness evaluation exists.
  - Business is done when proposals exist, or when it is skipped.
  - History is optional.
  - Autonomy is done when operating mode is saved.
  - Finish is done when the knowledge proposals are reviewed.
- **Navigation.** Forward is gated by required steps (NN/g: no jumping past an uncompleted step). Completed
  steps are free to revisit in the step list. Continue buttons are labelled with their destination.
- **Step 1, Connect, is three sub-steps on one page:**
  1. Project details: Key, Name, Repository URL and Default branch, with the key suggested from the name.
  2. Pick integrations. The cards show the health of each. If none exists, **Add an integration** opens the
     integration wizard and comes back.
  3. Ticket lifecycle, with the wizard default preselected and explained in one line.
- **Step 2 runs discovery in place.** It shows the live stage panel compactly and the readiness ladder as a
  meter. Criteria are listed with human names, with the id behind *Details*. The cost ceiling is on the
  button.
- **Steps 3 and 4 are clearly optional.** Each has a "Skip for now" default button beside the primary.
- **Step 5, How autonomous:** the five operating-mode sections become five collapsible panels, with the
  autonomy dial open first and a sentence above each.
- **Step 6, finish:** a summary of what was set, links to *Review the drafted pages* and *Propose the
  settings to the repository*, then **Open the board**. The wizard ends with the next action, not a dead
  end.
- **Project settings reuse the same step components** (product/18:55 "the mirror of every wizard step"), so
  nothing is built twice.

---

## 7. Constraints the implementation must keep (each is enforced by an existing check)

| Constraint | Enforced by | Consequence for the redesign |
|---|---|---|
| No markup sinks; URL attributes only through `untrusted.tsx` | `no-html.test.ts` | Icons are React SVG elements (fine). Any new external link (provider docs, ticket, MR) uses the existing `safeHref` component. |
| CSP `style-src 'self'`, no `style=` attributes in sources | `csp.ts`, `csp.spec.ts` | Bars and meters use `<meter>`/`<progress>` or width utility classes in steps. Base UI's CSSOM positioning must be confirmed under the policy (§4.3). |
| Initial bundle ≤ 300 000 B gz | `bundle-budget.mjs` (`verify:bundle`) | Octicons are per-icon imports. Base UI is tree-shaken per component. Recharts, the transcript, and the integration and onboarding wizards can go in lazy chunks if the budget is tight. Measure after P1. |
| New dependency licences | `pnpm notices:check` | Regenerate `THIRD_PARTY_NOTICES.md` in the same commit (Inter is OFL-1.1, octicons MIT, Base UI MIT). |
| `NAV` equals the user guide's list | `user-guide-census.test.ts` | Change both in the P2 commit. |
| The client's API paths equal the server's routes | `client-census.test.ts` | Redesign adds no endpoints, except optional O1. |
| Checks panel = product/10's eleven items | `checks-panel.test.tsx` | Labels stay. Layout changes. |
| Every enabled clickable shows a pointer | `cursor.test.ts` | New `role="menuitem"`/`tab` elements are added to the base-layer rule. |
| Tests anchor on accessible names and visible strings | unit tests + `test/web-e2e/*.spec.ts` | Labels are kept wherever possible. Where a control moves behind a tab, menu or dialog, the test gains one interaction step ("open ···", "select Artifacts tab"). That is the bulk of the test churn and is budgeted per phase. |
| Raw state words are asserted in a few places (`"implementation"`, `"review 1"`) | `screens.spec.ts` | `humanize.ts` keeps stage names as words. Changes to state wording update the spec in the same commit. |
| Docs win over code | CLAUDE.md | P0 writes TD-033 + technical/09 + user-guide changes first. The user guide's screen sections are updated in each phase's commit. |

---

## 8. Phases (proposed work packages, numbered when entered in technical/13)

Each phase is one or more small MRs. Each ends green on `pnpm run -s verify`, `verify:ui` and
`verify:web-e2e`, and with the visual check below.

| Phase | Scope | Main risks |
|---|---|---|
| **P0 — Decide** | TD-033 *visual design language* (this document's §1, §3, §4 as decisions; D1–D4 answered); Q46 closed by adopting Base UI for the five behaviours; technical/09 § "Accessibility, theming" and § "Structure" amended; before-screenshots of every screen captured (see verification) | none (docs) |
| **P1 — Foundations** | tokens for both themes + `contrast.test.ts`; font; octicons; Base UI; primitives of §4.3 with unit tests; `humanize.ts` with exhaustive records; spec-reference census; bundle measured | bundle budget; Base UI under CSP |
| **P2 — Frame** | top bar (switcher, running indicator with connection dot, `+`, inbox count, avatar menu with theme); org UnderlineNav; `/projects` list; project layout route + header + tabs; `NAV` + user guide | census tests; e2e navigation steps; server SPA allow-list for `/projects` |
| **P3 — Home** | needs-you, running now, projects, spend rail; first-run setup checklist | deriving done-ness client-side (O1) |
| **P4 — Onboarding wizard** | Stepper, step routing, done-ness, Save and exit, the finish step; project settings reusing the steps | the largest test churn (`onboarding*.test.tsx`, ~1 300 lines) |
| **P5 — Board** | cards, needs-you marker, card `···` menu (product/10), horizontal scroll, list view, Start-a-ticket dialog | `screens.spec.ts` board assertions |
| **P6 — Task** | PageHeader with state-dependent primary, needs-you callout with inline answer, tabs, timeline with durations/cost/loops, merge-box Checks, dialogs for stage commands and take-over | the 1 967-line `task-detail.tsx` should be split by tab as part of this; heaviest e2e churn |
| **P7 — Run** | job-list sidebar, header actions (Cancel, Re-run ▾), log-step transcript, viewport-height log pane with sticky steer | transcript renderer tests; virtualisation and follow-tail behaviour |
| **P8 — Inbox, Agents, Integrations** | list boxes; inline answer; integration detail route + add-integration wizard; human field labels | `integrations.test.tsx` labels (`site_url` → "Site URL") |
| **P9 — Settings and the rest** | org + project settings sub-routes with NavList; Knowledge, Pipeline, Budgets, Shadow, Audit, Statistics (charts, lazy) | Recharts cost; allow-list for new sub-paths |
| **P10 — Polish** | command palette (cmdk), keyboard shortcuts + `?` sheet, responsive pass at 1024 and 390, an accessibility review (axe in Playwright, decision D4), copy pass with the UX-copy rules of §3 | — |

**Order rationale.** P1–P2 change every screen's look and frame at once, which is the biggest visible win
for the least behaviour risk. P3–P4 deliver the "leading the user" experience a new instance meets first.
P5–P7 are the daily screens. P8–P9 are re-skins plus sub-navigation.

### Verification (every phase)

1. **Tiers:** `pnpm run -s verify`, `pnpm run -s verify:ui`, `pnpm run -s verify:web-e2e`.
2. **Visual, against fixture data, with no database.** The Playwright fake backend serves the *built* bundle
   with fixture data on one origin, under the production CSP:

   ```
   pnpm --filter @platform/web run build
   WEB_E2E_PORT=4318 node --import ./scripts/ts-source-resolver.mjs test/web-e2e/support/serve.ts
   ```

   Sign in at `http://127.0.0.1:4318` with the fixture account in `test/web-e2e/support/fixtures.ts`. Then
   screenshot every route through Claude in Chrome at **1440×900, 1024×768 and 390×844**, in **dark and
   light**, and compare with the P0 baseline.
   - The fixtures deliberately contain hostile strings (`HOSTILE.*`). That is a feature here: the redesign
     has to look right with them, not only with friendly data.
3. **Visual, against real data.** `pnpm dev` against a local, migrated database with a seeded project, to
   see realistic lengths and live SSE updates.
4. **Reading test.** For each redesigned screen, write down "what is the one thing to click?" before
   looking. If the screenshot does not answer it in under five seconds, the screen is not done. This is
   product/10's *"understands within a minute"*, made smaller and checkable.

---

## 9. Decisions needed from the product owner

- **D1 — Font.**
  - (a) **Self-host Inter Variable** (recommended): the same look on every OS, OFL-licensed, and it keeps
    the Black weight of the headline.
  - (b) Keep `system-ui`: zero bytes, but the brand font then *is* the visitor's OS.
  - (c) A display face with more character, for example Mona Sans (GitHub's own, OFL). It would also
    change the sign-in page.
- **D2 — Icons.**
  - (a) **Octicons** (recommended): GitHub's set, MIT, the closest match to the brief.
  - (b) Lucide: ISC, more general.
  - (c) Pixel icons drawn on the wordmark's 5-unit grid: the most on-brand, but a design job of its own, and
    could follow later for a few hero icons only.
- **D3 — Behaviour library.**
  - (a) **Adopt Base UI 1.9 now** (recommended): it closes Q46 and is TD-013's original choice.
  - (b) Keep hand-written primitives with native `<dialog>` and the `popover` attribute: fewer
    dependencies, more APG work done by hand.
- **D4 — Default theme and light mode.**
  - (a) **Default dark (the brand), light available** (recommended).
  - (b) Default `system`, which is today's behaviour.
  - Separately: should the top bar stay night in light mode? Recommended: yes.

**Open items that need no decision now:**
- **O1:** a server projection for the setup checklist.
- **O2:** board columns from the pipeline template, as product/10 says. This is pre-existing and out of
  scope.
- **O3:** axe-core in Playwright as a devDependency for P10.

---

## 10. Sources

- NN/g, *Wizards: Definition and Design Recommendations*, https://www.nngroup.com/articles/wizards/
  Summarised via search on 2026-11-04 as: show the steps and highlight the current one; prevent jumping
  past uncompleted steps; give descriptive step names, not generic "Next"; let people save and resume;
  wizards suit infrequent tasks and novices. To be re-checked verbatim when TD-033 cites it.
- NN/g, *Designing Empty States in Complex Applications: 3 Guidelines*,
  https://www.nngroup.com/articles/empty-state-interface-design/ Summarised as: communicate system status
  (and never show "no records" while loading); provide learning cues; provide direct pathways for key
  tasks.
- NN/g, *8 Design Guidelines for Complex Applications*,
  https://www.nngroup.com/articles/complex-application-design/ (learning by doing; reduce clutter without
  reducing capability).
- Primer, *UI color system*, https://primer.style/foundations/color/overview Functional tokens over base
  tokens; `fg.default`, `bg.subtle`, `border.default` roles.
- Primer component index, https://primer.style/ui-patterns PageHeader, UnderlineNav, NavList, Blankslate;
  Side nav and Menu are deprecated in favour of NavList and ActionMenu.
- The product owner's GitHub screenshots of 2026-11-04 (Issues, Actions list, run summary, job log,
  repository, dashboard), and the sign-in page at https://agentic.autix.eu/sign-in, viewed signed out.
- npm registry, 2026-11-04: `@base-ui/react` 1.9.0; `@primer/octicons-react` 19.42.0 (MIT); `lucide-react`
  1.68.0 (ISC); `@fontsource-variable/inter` 5.3.0 (OFL-1.1).

---

## 11. Live visualisations: what exists, what we take, and why (2026-11-05)

The owner asked for an overview of what agents and workers are doing, partly as a fun pixel "office", and for a clickable
node-graph of the workflow and of one task's run, modelled on React-Flow-style screenshots with:
- a dotted canvas;
- stage cards carrying "● Working", "Now: Reading files" and the model;
- dashed connectors;
- a detail panel with a live terminal and a "Live activity" list.

The decisions are TD-033 decisions 6–8. This section is the evidence. A research subagent surveyed the sources on
2026-11-05 and its claims were checked against `apps/server/src/web/csp.ts`. The checks were made on the code; neither
library has been run in a browser under our CSP yet.

**Pixel offices for coding agents exist, and they all have to guess at state.**
- [Pixel Agents](https://github.com/pablodelucca/pixel-agents) (MIT) is a VS Code extension: one pixel character per
  Claude Code session, in a Canvas 2D office.
  - It derives state from Claude Code hooks, falling back to transcript files: a tool start means typing (read tools mean
    reading), a permission request shows a speech bubble, and a stop means done or waiting.
  - Without hooks it uses 5–7 s timers, which its README says often misfire.
- [Claude Office](https://github.com/paulrobello/claude-office) (MIT, PixiJS): a boss and employees, plus a waste bin
  that fills with context.
- [AI Town](https://github.com/a16z-infra/ai-town) (MIT, PixiJS) and
  [Generative Agents](https://github.com/joonspk-research/generative_agents) are the genre's origin.
- [Agent Flow](https://github.com/patoles/agent-flow) (Apache-2.0) is a node graph over SSE.
- [Claude-Code-Agent-Monitor](https://github.com/hoangsonww/Claude-Code-Agent-Monitor) (MIT) is a kanban with a buddy
  character.
- [disler's observability](https://github.com/disler/claude-code-hooks-multi-agent-observability) has no licence file,
  so it is inspiration only.

**We need no guessing.** The platform already records:
- run status and lease;
- the transcript's last entry kind (tool, thinking, text, a permission "ask" hook, progress);
- open questions and approvals;
- worker heartbeats and pauses.

`activityOf` (TD-033 decision 6) reads these. S-23.15 adds a run's seat and its newest entry kind and tool name to the
agents read, and never the text. S-23.14 makes the changes arrive live. That is the one real advantage over the
open-source offices, and the reason to build ours rather than embed one.

**Rendering: SVG pixel grids, not a game engine.**
- PixiJS (≈174 kB) needs its no-eval import and loads assets in `blob:` workers, which our CSP has no `worker-src` for.
  A canvas also gives a screen reader nothing.
- Our office is DOM: a CSS grid of desks, each an SVG of `<rect>` runs from text grids in the six brand inks (research/18's
  method), animated by CSS classes with `steps()`. A nameplate and a "Now: …" bubble are React text.
- Vite inlines assets under 4 KiB as `data:` URLs, which `img-src 'self'` refuses. Text grids avoid that trap entirely.
- Third-party office art was checked and rejected:
  - Pixel Agent Desk's art forbids modification and redistribution.
  - The Donarg tileset is paid and may not be redistributed.
  - Kenney and JIK-A-4 are CC0 and usable, but off-brand.

  Our props are drawn in our palette.

**Canvas: React Flow 12 ([@xyflow/react](https://reactflow.dev/whats-new), MIT), lazy.**
- It costs ≈ 62 kB gz plus ≈ 3 kB of CSS by the subagent's build, so it goes in a route chunk outside the 300 kB initial
  graph.
- Its source sets no `style` attribute and injects no `<style>`; it positions through CSSOM, which `style-src` does not
  govern. The one CSP issue filed against it ([#3520](https://github.com/xyflow/xyflow/issues/3520)) was not its defect.
- Its dashed-edge animation ignores reduced motion, so a CSS override is needed.
- No layout library: our graphs are 5–15 nodes, laid out by rank, with return edges drawn as curves below.
- S-23.5's CSP spec opens a canvas in the built bundle before any screen depends on it.

**Live-run patterns we adopt.** The closest documented product is the Claude Console's
[session observability](https://platform.claude.com/docs/en/managed-agents/session-observability) view.
- One small status vocabulary, each status with colour *and* shape.
- A "Now: …" line built from the last entry.
- A timestamped activity list beside the raw log.
- A watch-only notice where the viewer cannot act.
- A cost badge that says whether the cost was reported or estimated.
- Whatever needs a human pinned first.

We could not identify the product in the owner's screenshots. The look is a default React Flow setup.
