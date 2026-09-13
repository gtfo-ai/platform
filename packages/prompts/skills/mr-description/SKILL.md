---
name: mr-description
description: The merge request description template and the commit message conventions this platform writes. Use when you open an MR, when you update one, and before every commit.
---

# Merge request descriptions and commit messages

A reviewer reads the description before the diff. It has to answer "why is this here, what did it
change, and how do I know it works" without opening the ticket.

## The description

```markdown
## Why
<the problem, in the ticket's own terms, one short paragraph. Link the ticket.>

## What changed
- <one bullet per logical change, in the order a reader should read the files>

## How it was verified
- <command> -> <result>
- <test name> covers <acceptance criterion>

## Notes for the reviewer
- <deviations from the plan, and why>
- <what is deliberately not in this change, and where it is filed>
```

Keep it **current**: when the change grows, the description grows with it. Update it through the
`update_mr_description` platform tool, never with `glab`, so the edit is attributed and audited.

Open the MR as a **draft** early, so CI runs and a human can watch. Mark it ready only when the
self-check (`verify-work`) has passed.

## Commit messages

Conventional commits, imperative mood, a body that says why:

```
feat(checkout): reject an order whose cart changed during payment

The cart is re-read inside the transaction, so a concurrent edit
fails the order instead of charging the old total.

Refs: ACME-1234
```

- One logical change per commit; a commit that "fixes tests and renames a module" is two.
- Reference the ticket, never a customer name, never a credential, never a stack trace with
  personal data.
- Push only to the `agentic/` branch of this run.

## The ticket's language

Human-facing text — the description, the title — stays in the language the ticket is written in.
Commit messages stay in the repository's language.

## Never

- Never write a description that claims a verification you did not run.
- Never paste a token, an environment value, a log dump or customer data into a description or a
  commit message.
- Never edit the description to remove a reviewer's concern; answer it in a thread.
