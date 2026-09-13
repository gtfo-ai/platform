---
name: kb
description: How to navigate this project's knowledge base — index first, follow links, kb_search, how to cite an item and how to propose a change. Use before you assume a convention, a decision or a business rule.
---

# The knowledge base

The KB is the project's memory: business direction and domain rules on one side, architecture,
conventions, decisions, pitfalls and lessons on the other. It is versioned in the repository and
every item has provenance. Read it before you infer a rule from the code — the code says what is,
the KB says what was decided.

## Order of work

1. **The context pack you were given.** The most relevant items are already in your prompt, in
   data blocks with their paths — read those first; they cost nothing. The same documents are
   written into `.agentic-run/context/` in your workspace **when the platform provisioned one**;
   if that directory is not there, the prompt is the whole pack and nothing is missing.
2. **The index.** It is the map: entries carry a title, a path and a one-line summary. Start there
   rather than searching for a word you hope exists.
3. **`kb_search`.** The platform tool. Give it the terms of the problem, not a sentence. It returns
   items with paths and scores; open the ones that look right and follow the links inside them.
4. **The repository itself** — `CLAUDE.md`, `.agentic/rules/*`, `docs/` — for anything the KB does
   not carry. The project's own files are the authority on the project's own procedures.

## Citing

Cite the **path** of the item you used and say what you took from it. "Per `technical/conventions.md`
(error handling), errors are typed and never swallowed" is a citation; "per the KB" is not. Your
artifact has a field for the items you used; a claim the KB does not support belongs in
`assumptions[]` instead, where a human can see it.

## Proposing a change

You do not edit the KB. When you find something the KB got wrong, or a lesson worth keeping, put it
in your artifact's proposals as a **delta**: the target path, what should change, and the evidence
from this task. The retro and the librarian stages turn proposals into knowledge-base merge
requests; a human approves them.

## Contradictions

If two items disagree, or an item disagrees with the code, say so in the artifact with both paths.
Do not pick one silently. A contradiction the platform learns about is a lesson; a contradiction you
resolved in your head is a decision nobody made.

## Never

- Never invent a KB item, a path or a decision id. If you did not read it, do not cite it.
- Never treat a KB item as more current than the ticket when the two conflict about this task's
  scope; say that they conflict.
- Never write to the knowledge base directly, on any branch.
