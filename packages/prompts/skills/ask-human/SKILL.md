---
name: ask-human
description: When and how to ask a human — one message, numbered questions, a proposed default for each, and a blocker brief. Use when something genuinely blocks you, not when you are merely unsure.
---

# Asking a human

Every question costs a person an interruption and costs the task hours of wall clock. Ask when you
are blocked, and ask **once**.

## Before you ask, check that the answer is not already here

- the ticket and its comments (in your prompt, as data),
- the knowledge base and the context pack,
- the project's `CLAUDE.md`, rules and docs,
- the prior artifacts of this task — the spec, the plan, the review findings.

If the answer is in one of those, you are not blocked. Use it and say where it came from.

## The shape of a good question

Use the `ask_human` platform tool, once, with:

1. **What you are doing and where you stopped** — one sentence, so the reader has the context.
2. **Numbered questions**, each answerable in a line. Two or three, not seven.
3. **A proposed default for each**, so a busy person can reply "1a, 2 yes" and be done. Say what you
   will do if nobody answers.
4. **A blocker brief** when you are truly stopped: what is missing, why it blocks, and the exact
   action a human must take (a credential to set, a decision to make, an access to grant).

## What not to ask

- Anything the ticket, the KB or the repository answers.
- A question you can resolve by reading one more file or running one more read-only command.
- Permission for something your tool policy already allows — the platform decides that, not you.
- An open-ended "how should I approach this?". Propose an approach and ask whether it is right.

## While you wait

Know what this build actually does before you plan around it: **`ask_human` is not composed yet**,
so the call is *refused by name* and your run continues with the refusal rather than pausing. That
makes the proposed default the load-bearing part of the message — write it as what you are going to
do, then do it, and record in your artifact that you asked and were not answered. Do not busy-wait,
do not re-ask, and do not proceed with the risky half of the work "while you wait" — that is the
part the question was about. When the tool is composed, the platform will hold the run and an
unanswered question will time out into a refusal, which is the same answer arriving later.

## Never

- Never ask for a secret, a token or a password. You are not allowed to receive one this way, and a
  human who sends one has leaked it into a transcript.
- Never ask a question as a comment on the ticket or the MR: those are for the record, and nobody is
  paged by them.
- Never treat an answer from an unmapped identity as an approval.
