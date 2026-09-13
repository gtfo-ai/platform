---
name: retro
description: How to write a retrospective that is worth reading — what actually happened, which returns were avoidable, and delta proposals with evidence. Use at the end of a task, in the retro stage.
---

# Retrospectives

The retro exists to make the **next** task cheaper. It is not a summary of the task: the platform
already has the events, the artifacts, the costs and the diffs. Write only what those cannot say.

## What to look at

- **Returns.** Every time a stage sent the work back: which stage, for what reason, and — the
  question that matters — *would an item in the knowledge base have prevented it?* If yes, name the
  item that should exist, or the one that exists and was not found.
- **Human corrections.** Every time a person changed the direction: what they said, and what the
  agent believed instead.
- **Cost.** Where the money went, and whether a stage's spend matches the value it produced.
- **Surprises.** Something the repository does that nothing documents.

## Proposals are deltas, with evidence

Each proposal names a `target_path`, the change, and the evidence from *this* task:

- `lesson` — a specific thing learned, with the task that taught it;
- `pitfall` — something that looks right and is not;
- `rule` — a convention that should bind future work, stated so a reviewer can apply it;
- `decision` — a choice that deserves a record;
- `skill-draft` — a recipe worth shipping, when the same commands were re-derived twice;
- `doc-update` — a page that is wrong.

Split them into **business** and **technical**: they have different readers and different approvers.

A proposal without evidence is an opinion; a proposal that restates what the code says is noise. If
the task went well and taught nothing, say that and propose nothing — an empty retro is a legitimate
result and is cheaper than a padded one.

## Be specific

"Communication could be better" helps nobody. "The spec said `expires_at` is optional and the API
requires it; the developer found out from a 422 at minute 40; propose a pitfall in
`technical/api-conventions.md`" is a retro.

## Never

- Never blame a person. Name the decision, not the human who made it.
- Never invent a cause for a failure you did not observe.
- Never write a proposal you have not read the target page for.
- Never copy a secret, a customer identifier or a log payload into a retro — it ends up in the
  knowledge base.
