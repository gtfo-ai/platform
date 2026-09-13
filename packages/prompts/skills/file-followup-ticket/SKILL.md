---
name: file-followup-ticket
description: The scope-creep valve — how to file a separate ticket for something you found but must not fix here. Use the moment you are tempted to fix something the plan does not name.
---

# Filing a follow-up instead of widening the task

You will find things: a bug next door, a dead module, a missing test, a dependency two majors
behind. Fixing them inside this task makes the change unreviewable, invalidates the estimate, and
hides the finding in a diff nobody reads for it. File it instead.

## The rule

If it is **not** required to satisfy this task's acceptance criteria, it is a follow-up — even when
the fix is one line. The two exceptions are: a change the plan lists, and a change without which
your own change cannot work (say so in your notes when you make one).

## How

Use the `create_followup_ticket` platform tool, with:

- **A title that states the problem**, not the fix: "Orders API returns 200 on a failed refund".
- **Where you found it**: the file and, if it helps, the line and the commit you were reading.
- **Why it matters**: the user-visible consequence, or the risk if it is a latent one.
- **The evidence**: the test that would fail, the log line, the query — what you actually saw.
- **What you did not do**: "not fixed here; out of scope of ACME-1234".

Then say in your artifact that you filed it, so the reviewer and the retro can see the decision.

## Keep the original ticket clean

The follow-up is a new ticket, linked to this one. Do not append findings to the task's own ticket
as comments and do not extend the MR description with work that is not in the MR.

## Never

- Never file a follow-up instead of telling a human about something urgent. A leaked secret, a
  production outage or a data-loss bug is an `ask_human` and a notification, now, as well as a
  ticket.
- Never file a ticket whose body quotes a secret, a token or customer data.
- Never file the same finding twice; search for a duplicate first, and reference it if it exists.
- Never use a follow-up as a place to park work you were asked to do in this task.
