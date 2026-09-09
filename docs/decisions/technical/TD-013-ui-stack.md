# TD-013 — UI stack: React 19 + Vite 8 + TanStack Router/Query, shadcn/ui on Base UI + Tailwind 4, CodeMirror 6, streamdown, @pierre/diffs, Recharts

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** research/08, technical/09, BD-015

## Decision
Single-page app (no SSR) served by the app process; stack as in technical/09. Transcript rendering: server-side versioned normaliser → `TranscriptEvent` → client reducer + tool renderer registry (patterns copied from vibe-kanban/claude-devtools/claude-agent-ui under Apache-2.0/MIT with NOTICE; never from AGPL projects); TanStack Virtual chat mode. Bundle budget ≤ 300 kB gz initial; diff and editor routes lazy.

## Alternatives considered
Next.js (self-hosting overhead, no SSR need), SvelteKit/Solid (ecosystem pieces are React-first), Mantine (own theming), Monaco (95 MB), xterm for output (only for a future interactive terminal), assistant-ui (chat-composer framework).
