# Research: UI stack and transcript rendering (2026-09-09)

> Versions/licences verified against npm and GitHub on 2026-09-09. Informs TD-013 (UI stack), TD-014 (real-time transport), technical/09.

## Stream facts that shape the transcript UI (verified)
With `includePartialMessages`, the SDK yields `stream_event` wrappers around raw API events (`message_start`, `content_block_start/delta/stop`, `message_delta`, `message_stop`; `text_delta`, `input_json_delta`, thinking deltas). **`parent_tool_use_id` is always null on stream events and partials are emitted only for the main session**; sub-agent attribution comes from complete `AssistantMessage`/`UserMessage` objects. The spawning block is `tool_use` with `name: "Agent"` (was `"Task"` before Claude Code 2.1.63 — match both). Compaction = `SDKCompactBoundaryMessage`. https://code.claude.com/docs/en/agent-sdk/streaming-output , https://code.claude.com/docs/en/agent-sdk/subagents

## Framework — React 19 + Vite 8 + TanStack Router (SPA) + TanStack Query
- react 19.2.8 (MIT), vite 8.2.2 (MIT; Rolldown, ESM-only, Node ≥ 20.19/22.12) https://vite.dev/blog/announcing-vite8 , @tanstack/react-router 1.170 (weekly releases), @tanstack/react-query 5.102.
- No SSR benefit (auth-gated, live, data-driven); one static bundle served by the backend with SPA fallback and same-origin SSE (cookies work with native `EventSource`). Next.js self-hosting needs `standalone` + manual static copy; static export drops middleware. https://tanstack.com/start/latest/docs/framework/react/guide/spa-mode , https://nextjs.org/docs/app/getting-started/deploying
- Typed search params (zod) = filters as URL state. Peers: vibe-kanban (TanStack Router/Query/Virtual/Form) and paperclip (React 19 + react-router 7 + Query) are React SPAs served by their backends.

## Components — shadcn/ui on `@base-ui/react` 1.8 + Tailwind 4.3
- shadcn made Base UI the default in July 2026; Radix still supported. https://ui.shadcn.com/docs/changelog/2026-07-base-ui-default . Package trap: use `@base-ui/react`, not the frozen `@base-ui-components/react`. Base UI v1 stable since Dec 2025 (MUI + Radix/Floating UI authors). https://www.infoq.com/news/2026/02/baseui-v1-accessible/
- Alternatives: Mantine 9.6 (batteries included, own theming), Ark UI 5.39, Radix Themes 3.3 (momentum moved), react-aria-components 1.21 (a11y rigour; reference Kanban grid https://react-aria.adobe.com/examples/kanban).

| Need | Pick (MIT unless noted) |
|---|---|
| Tables | @tanstack/react-table 9.2 |
| Virtualised transcript | @tanstack/react-virtual 3.14 **chat mode** (`anchorTo: 'end'`, `followOnAppend`, `isAtEnd()`) https://tanstack.com/virtual/latest/docs/chat ; avoid `@virtuoso.dev/message-list` (commercial) |
| Command palette | cmdk 1.1 (slow but stable; shadcn Command) |
| Toasts / forms / hotkeys / panes | sonner 2.0; react-hook-form 7.87 + zod 4.5; react-hotkeys-hook 5.3; react-resizable-panels 4.12 |
| YAML/markdown editors | CodeMirror 6 (+ lang-yaml, lang-markdown, lint, merge for KB proposal diffs, @uiw/react-codemirror); schema-aware YAML via codemirror-json-schema 0.8 (last publish 2025-04 → vendor if it stalls). Monaco (95 MB unpacked) not worth it. https://sourcegraph.com/blog/migrating-monaco-codemirror |
| Live assistant markdown | **streamdown 2.6 (Apache-2.0, Vercel)** — tolerates unterminated blocks, GFM + Shiki https://streamdown.ai/docs/migrate |
| KB/artifact markdown | react-markdown 10 + remark-gfm + rehype-sanitize + wiki-link plugin; shiki 4.4 fine-grained bundles in a worker https://shiki.style/guide/bundles |
| Diffs | **@pierre/diffs 1.4 (Apache-2.0)** — Shiki-based, split/stacked, worker pool, annotations; 7 MB unpacked → lazy-load the run route. https://diffs.com/docs . Alternative @git-diff-view/react 0.1.7 (MIT, 0.x) |
| ANSI shell output | anser 2.3 / ansi_up 6.0; **xterm.js only for a future interactive take-over terminal** |
| Charts | Recharts 3.10 (SVG; volumes are small); echarts 6 (Apache-2.0) as escape hatch |

## Reusable OSS transcript renderers (licence-checked)
| Project | Licence / status | Reuse |
|---|---|---|
| vibe-kanban `crates/executors/src/logs` + `web-core/…/deriveConversationEntries.ts` | Apache-2.0; company shut down 2026-04, no commits since | **Copy the normalised transcript schema** (`NormalizedEntryType`: UserMessage, AssistantMessage, ToolUse{FileRead, FileEdit, CommandRun, Search, WebFetch, Tool, TaskCreate, PlanPresentation, TodoManagement, AskUserQuestion, Other}, SystemMessage, ErrorMessage, Thinking, TokenUsageInfo; `ToolStatus`; `FileChange`) and grouping logic; keep NOTICE; do not depend. https://github.com/BloopAI/vibe-kanban |
| paperclip | MIT, active | adapter → `TranscriptEntry[]` boundary; Base UI + shadcn precedent. https://github.com/paperclipai/paperclip |
| claude-devtools (matt1398) | MIT, 3.9k★ | best reference for **tool cards, recursive sub-agent trees with cost, compaction markers**; copy components. https://github.com/matt1398/claude-devtools , format notes https://claude-dev.tools/docs/jsonl-format |
| claude-agent-ui (tinkerindustries) | MIT, v0.1, no community | copy the **pure reducer `applyEvent(blocks, event)` + tool renderer registry** pattern. https://github.com/tinkerindustries/claude-agent-ui |
| claude-replay | MIT | JSONL edge-case parser reference. https://github.com/es617/claude-replay |
| assistant-ui | MIT | chat composer framework; skip for a read-only transcript (viable if steer becomes a chat composer) |
| siteboon/claudecodeui | **AGPL-3.0** | **do not copy** |
| CUI | archived 2026-03 | skip |

Plan: server normalises SDK messages into a versioned `TranscriptEvent` with monotonic `seq` (vibe-kanban schema + `parent_tool_use_id`, `compact_boundary`, steer turns, cost snapshots); client reducer builds blocks (`text`, `thinking`, `tool` with children for Agent, `compaction`, `system`, `user/steer`); renderer registry per tool (`Edit/Write` → diffs, `Bash` → ANSI, `Read/Grep` → code, `Agent` → nested, `mcp__*` → JSON); TanStack Virtual chat mode.

## Real-time client state
- **SSE server→client**, POST for commands. Browsers cap SSE at **6 connections per domain on HTTP/1.1** (MDN, "won't fix") → serve HTTP/2 and/or **one multiplexed stream per tab** (`/events?topics=…`, subscribe/unsubscribe via POST). https://developer.mozilla.org/en-US/docs/Web/API/EventSource
- Client: `eventsource` 5.1 (fetch-based, headers, Last-Event-ID) or `@microsoft/fetch-event-source`; every event has `id: <seq>`; server ring buffer per topic backed by the event table; gap beyond buffer → `snapshot`/`reset` and client re-fetches via Query. Cautionary tale: https://github.com/anomalyco/opencode/issues/25657
- State: TanStack Query for resources (targeted `setQueryData`, `invalidateQueries` on coarse events); event-sourced zustand store per run for transcripts (never route deltas through Query); rAF batching of deltas, coalesce consecutive text deltas, memoised sibling blocks; server coalesces partials into ≥ 50 ms batches and stops forwarding partials when nobody is subscribed. TanStack DB 0.8 (pre-1.0) not yet.

## Board without drag
CSS Grid columns with `overflow-y: auto`; no dnd-kit; per-card selector subscriptions so a tokens/min tick re-renders one badge; throttle live badges to ~2 Hz; single `now` tick context; virtualise a column only past ~200 cards; `content-visibility: auto`; APG grid keyboard pattern (roving tabindex). https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/

## A11y, theming, i18n
Base UI implements APG behaviours; `aria-live="polite"` for status (not tokens); `prefers-reduced-motion`; shadcn Vite dark-mode recipe with CSS variables + `color-scheme`; Shiki dual themes so code/diffs/editor follow the toggle. UI English only: plain JSX strings, `Intl.*` formatting; Lingui later if ever (leaner than i18next).

## Testing
Vitest 5.0 (released 2026-09-05; Node ≥ 22.12; browser mode stable) + Testing Library 16.3; **golden transcript fixtures** (real SDK streams incl. sub-agents, compaction, denied tools, budget stop) for normaliser + reducer + snapshot of block lists — highest-value asset because the SDK format drifts; Playwright 1.63 e2e against the image with a fake agent replaying fixtures over SSE; Storybook 10.6 later as a block-state gallery (Vitest addon).

## Risks
Bundle (Shiki, @pierre/diffs → route split; target ≤ 300 kB gz initial); maintenance (cmdk, codemirror-json-schema, 0.x diff libs; TanStack Router weekly — pin, bump monthly; Vitest 5 days old); SDK format drift → versioned normaliser + fixtures; licences (AGPL claudecodeui, commercial virtuoso message-list) avoided; SSE cap → multiplex + HTTP/2.
