# TD-013 — UI stack: React 19 + Vite 8 + TanStack Router/Query, shadcn/ui on Base UI + Tailwind 4, CodeMirror 6, streamdown, @pierre/diffs, Recharts

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** research/08, technical/09, BD-015

## Decision
Single-page app (no SSR) served by the app process; stack as in technical/09. Transcript rendering: server-side versioned normaliser → `TranscriptEvent` → client reducer + tool renderer registry (patterns copied from vibe-kanban/claude-devtools/claude-agent-ui under Apache-2.0/MIT with NOTICE; never from AGPL projects); TanStack Virtual chat mode. Bundle budget ≤ 300 kB gz initial; diff and editor routes lazy.

> **Amended at WP-20 (2026-09-10). `streamdown` is not used, and no markdown-to-HTML renderer is.**
>
> The title of this record names `streamdown`, and technical/09 names it and `react-markdown` +
> `rehype-sanitize` as the alternative. WP-20 shipped **neither**, and the deviation belongs in the
> record rather than only in the code (standing rule 8).
>
> Everything the SPA renders — ticket text, MR comments, model output, tool results, log lines, KB
> documents — is untrusted (BD-022), and every markdown renderer in this class works by producing
> HTML and then sanitising it. That is an escape-then-transform pipeline, which has to be correct at
> **every** stage: WP-10 escaped a string for Slack and undid the escape one function later, in its
> own link converter, and its tests passed because they asserted on the intermediate string. So the
> app converts untrusted text to *data* instead — `segmentBlocks`/`segmentInline` in
> `apps/web/src/ui/untrusted-text.ts` — and React writes that data into text nodes. There is no
> `dangerouslySetInnerHTML`, no sanitiser to configure, and nothing for a later transform to undo;
> `apps/web/src/no-html.test.ts` fails the build if a markup sink or a URL attribute appears outside
> the one module allowed to write one.
>
> What is lost is bold, headings, tables and inline links inside prose: they render as their literal
> characters. Fenced code blocks are understood, because a diff or a stack trace collapsed into a
> paragraph is unreadable and the fence decides only which element the text goes into.
>
> **What would reopen this.** A markdown renderer that never produces HTML — one that emits React
> elements from an AST directly — would give the formatting back without the class of defect above,
> and is the shape to look for. Adopting one is a change to `ui/untrusted.tsx` and its tests, behind
> its own review, and it must keep the property this amendment is protecting: no string this
> application renders may become markup. The other named dependencies of this record (CodeMirror 6,
> `@pierre/diffs`, Recharts, Shiki) are untouched and still pending — WP-20 built none of them.
>
> Base UI is a separate deviation, recorded as **Q46** in `docs/OPEN-QUESTIONS.md`.

## Alternatives considered
Next.js (self-hosting overhead, no SSR need), SvelteKit/Solid (ecosystem pieces are React-first), Mantine (own theming), Monaco (95 MB), xterm for output (only for a future interactive terminal), assistant-ui (chat-composer framework).
