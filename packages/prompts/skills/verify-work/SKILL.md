---
name: verify-work
description: The self-check before you say you are done — run the project's tests and linters, read your own diff, look for leftovers and secrets, and update the MR. Use at the end of every implementation stage.
---

# Verifying your own work

Finishing is not "the code is written". It is "I ran the project's own checks, I read the diff, and
I can say what I changed and what I did not".

## 1. Run what the project runs

The commands are the project's, not yours: `technical/how-to-run.md` in the knowledge base, the
`README`, the `package.json` scripts, the CI configuration — in that order. Run the same commands CI
runs, not a subset you invented, and run them from the repository root.

If a command fails for a reason that is not your change (a missing service, a credential the run
does not have), say so explicitly in your notes with the command and the error. A check you could
not run is not a check that passed.

## 2. Read your own diff

```bash
git status --porcelain        # nothing you did not mean to add
git diff                      # unstaged
git diff --stat HEAD          # the shape of the change
```

Look for: debug prints and commented-out code, a `TODO` you left, a test you skipped or weakened, a
file outside the plan, a formatting-only change that hides a real one, a dependency you added
without saying so.

## 3. Look for secrets, every time

A token, a password, a private key, a `.env` file, a customer identifier in a fixture. If you find
one in your own diff, remove it and say so. If you find one that was already committed, **do not
"fix" it quietly**: report it — a committed secret has to be rotated by a human, and a commit that
removes it does not un-leak it.

## 4. Tests that prove the acceptance criteria

Each acceptance criterion should be named by a test, and the test should fail if the behaviour is
removed. A test that asserts a constant your own code just wrote proves nothing. Say in your notes
which test covers which criterion.

## 5. Update the record

Keep the MR description current with what the change actually does (see `mr-description`), and list
in your notes: what you ran, what it said, what you deviated from in the plan and why, and what you
knowingly left undone.

## Never

- Never disable, skip or weaken a test to make a run green.
- Never say "tests pass" without the command and its result.
- Never commit generated output, `node_modules`, a lockfile you did not mean to change, or a file
  the plan did not name without saying why.
