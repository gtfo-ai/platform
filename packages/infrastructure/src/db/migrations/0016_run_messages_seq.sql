-- 0016 — `run_messages.seq` is zero-based, and the constraint said otherwise (WP-15g).
--
-- `0006_transcripts.sql:42` shipped `constraint run_messages_seq_positive check (seq >= 1)`. The
-- producer starts at **zero**: `claude-runner.ts`'s `append` stamps the envelope with `seq` and
-- increments afterwards, so the first entry of every run is `seq: 0` — the golden transcripts pin
-- `[0, 1, 2, 3, 4, 5, 6]` (`claude-runner.test.ts` › "completes, validates the artifact and reports
-- the cost") — and `@platform/contracts`' own `sequenceSchema` is documented
-- "`events.stream_seq`, `run_messages.seq`, SSE per-topic ids. Zero-based." (`common.ts:48`).
--
-- So the table and the two things that write to and describe it disagreed, and **nothing found out
-- for ten work packages**, because nothing ever inserted a row: `run_messages` has existed since
-- WP-06 and the only `RunTranscriptSink` in the tree until now was in-memory (the e2e passed
-- `{ append: async () => {} }`). It is standing rule 82's family — a table, a renderer and a whole
-- transcript feature, with no production writer — and the first insert this repository ever makes
-- would have failed its own check constraint on the first row of the first run.
--
-- **Which side wins is a docs question and the docs answer it.** technical/03 § "Transcripts" gives
-- `run_messages(run_id, seq int, …)` with no base, technical/08's SSE contract makes the id
-- `<topic>:<seq>` with the publisher owning `seq`, and `@platform/contracts` is the shared
-- definition both the UI and the runner are written against — it says zero-based. Translating at the
-- sink instead (`seq + 1`) would make the stored `seq` and the SSE cursor for the same entry differ
-- by one, which is the sort of off-by-one that is discovered in a reconnect two milestones later.
--
-- Forward-only (TD-011): `0006` is applied and frozen, so the constraint is replaced here rather
-- than edited there. The check is kept rather than dropped — a negative `seq` is still a bug, and a
-- column with no lower bound is a column that accepts one.
alter table run_messages drop constraint run_messages_seq_positive;

alter table run_messages
  add constraint run_messages_seq_nonnegative check (seq >= 0);
