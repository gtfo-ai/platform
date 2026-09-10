# 09 — UI architecture

> Round 2 design. Decisions: TD-013 (UI stack), TD-014 (real-time transport). Sources: product/10, /18, research/08.

## Stack
React 19 + Vite 8 + TypeScript; TanStack Router (SPA, file-based routes, zod search params) + TanStack Query; shadcn/ui on `@base-ui/react` + Tailwind 4; TanStack Table + Virtual (chat mode for transcripts); cmdk, sonner, react-hook-form + zod, react-hotkeys-hook, react-resizable-panels; CodeMirror 6 (+ yaml, markdown, lint, merge, json-schema); streamdown for live assistant markdown; react-markdown + rehype-sanitize + shiki (worker) for KB/artifacts; `@pierre/diffs` behind one `<Diff>` component (lazy-loaded); anser for ANSI; Recharts 3. Served as a static bundle by the app process with SPA fallback; same origin as the API and SSE.

## Structure
```
apps/web/src/
  routes/            # file-based: /, /projects/$key, /projects/$key/tasks/$id, /runs/$id, /agents, /inbox, /stats, /audit, /settings, /onboarding/$step
  features/          # board, task-detail, run-transcript, questions, knowledge, pipeline-editor, integrations, budgets, stats, audit, wizard, shadow
  transcript/        # normaliser types (shared with server), reducer applyEvent(blocks, event), renderer registry per tool, virtual list
  realtime/          # one SSE connection per tab (topics), reconnect/replay, Query bridge
  api/               # typed client generated from the OpenAPI schema (08)
  ui/                # shadcn components, theme, Metric (number + definition tooltip)
```

## Real-time state
- One multiplexed SSE stream per tab (`GET /events?topics=…`; topics `org`, `project:<id>`, `task:<id>`, `run:<id>`); subscribe/unsubscribe via POST; every event has `id: <seq>`; reconnect with `Last-Event-ID`; server replays from its ring buffer or sends `reset` → the client refetches via Query.
- Resources (tasks, runs, questions, KB, settings) live in TanStack Query; events apply `setQueryData` for known shapes (card cost, time-in-stage, run status) and `invalidateQueries` for coarse changes.
- Transcripts: event-sourced zustand store per run fed by `TranscriptEvent`s; rAF-batched delta application; coalesced text deltas; only the streaming block is "hot"; TanStack Virtual chat mode with follow-tail and "paused updates, N behind" indicator when scrolled up.
- Board: CSS grid columns; per-card selector subscriptions; live badges throttled to 2 Hz from one `now` tick; virtualised only past ~200 cards.

## Transcript model (shared package `@app/transcript`)
`TranscriptEvent { seq, runId, ts, kind: text|thinking|tool_use|tool_result|agent_start|agent_end|compaction|system|user|steer|result, parentToolUseId?, toolName?, payload }` produced by the server normaliser (versioned, golden-fixture tested); client reducer builds blocks; renderer registry: `Edit/Write/MultiEdit` → diff, `Bash` → ANSI terminal block, `Read/Grep/Glob` → code with line numbers, `Agent` → nested transcript, `WebFetch/WebSearch` → link cards, `mcp__*` → JSON viewer, `AskUserQuestion`/platform `ask_human` → question card, default → generic card.

## Key screens → data
| Screen | Queries | Live topics | Commands |
|---|---|---|---|
| Board | tasks by project (+ counts) | `project:*` | pause/cancel/return/open |
| Task detail | task, stages, artifacts, questions, runs, checks | `task:*` | answer, approve, retry, take over, feedback |
| Run detail | run, transcript page (seq range), context pack, prompt | `run:*` | steer, cancel, retry with model, feedback |
| Agents | running runs | `org` | cancel |
| Inbox | pending questions/approvals | `org` | answer/approve |
| Knowledge | documents tree, document, proposals, health | `project:*` | approve/reject/edit proposal, edit doc (creates commit/MR) |
| Pipeline settings | effective config with sources; templates | — | save (validated), export to repo |
| Statistics | rollups by day/week/month | — | CSV export |
| Wizard | project draft, discovery status, readiness | `project:*` | step save |

## Failure containment
A render that throws must cost one region, never the tab. Two boundaries, because they catch different failures:
- **Route level** — `defaultErrorComponent` on the router. TanStack Router installs a catch boundary per match *only when that match has an error component*, so without this option the nearest boundary is the root's and a screen that throws replaces the header and the navigation too (measured at WP-20: the document held the router's built-in error component and nothing else). With it, the failure is contained inside `<main>` and the navigation stays usable.
- **Application level** — one `ErrorBoundary` outside every provider, for what the router cannot see: a throw in a provider, in a provider's effect, or in the router's own render.

The fallback names the area, shows the error's message **sanitised and bounded** (an error message can quote a provider's string, so BD-022 applies to it), and offers *Try again* plus *Reload the page*; a boundary also clears itself when the route changes, so navigating away is a recovery. The fallback is deliberately poor in dependencies: a fallback that throws is caught only by the next boundary out, and the application-level one has none.

## Accessibility, theming, i18n
Base UI APG behaviours; `aria-live="polite"` for status changes; reduced-motion; light/dark/system via CSS variables and `color-scheme`; Shiki dual themes; keyboard shortcuts sheet (`g b`, `g q`, `/`, `?`, `j/k`, `f`); English-only strings with `Intl.*` formatting; Lingui later if needed.

## Testing
Vitest 5 + Testing Library for reducers/components; browser mode for virtualised/CodeMirror components; golden transcript fixtures shared with the server normaliser tests; Playwright e2e against the Docker image with the fake Claude runner replaying fixtures over SSE; Storybook later as a block-state gallery. Bundle budget ≤ 300 kB gz initial, run route lazy.
