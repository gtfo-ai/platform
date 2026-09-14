/**
 * The task page's cursor, from both ends.
 *
 * It is opaque by contract, which means the client sends back whatever it was given and this
 * endpoint has to treat that string as untrusted input: an unparseable cursor that reached the
 * driver would be half a keyset in a query, and `parseAuditCursor`'s own test records what that
 * cost the audit endpoint (`new Date(NaN)` at the driver).
 *
 * The **pair** is the part worth testing rather than asserting in prose: `tasks.id` is a uuidv7 and
 * `created_at` is `now()`, so two tasks created in one transaction share the timestamp exactly, and
 * a cursor of the timestamp alone would silently skip whichever fell after a page boundary.
 */
import { agenticConfigSchema } from '@platform/contracts';
import { redaction as redactionAdapters } from '@platform/infrastructure';
import { describe, expect, it } from 'vitest';
import { HttpError } from '../errors.js';
import {
  decodeTaskCursor,
  describeConfigIssues,
  encodeTaskCursor,
  MAX_STORED_VALUE_CHARS,
} from './projects.js';

const ID = '0199aa11-2b3c-7d4e-8f90-000000000001';

/**
 * The composition `apps/server/src/app.ts` gives this module — the real rules, not a stub.
 *
 * A stub that redacted everything, or nothing, would pass half of these cases (standing rule 42),
 * and the claim being tested is that the *shipped* redactor sees a credential in this string.
 */
const redactText = (value: string): string =>
  redactionAdapters.patternRedactor().redactText(value).value;

const issuesOf = (document: unknown): { path: PropertyKey[]; message: string }[] => {
  const parsed = agenticConfigSchema.safeParse(document);
  expect(parsed.success).toBe(false);
  return parsed.success ? [] : parsed.error.issues.map((issue) => ({ ...issue }));
};

describe('the task page cursor', () => {
  it('round-trips the keyset it was built from, to the microsecond', () => {
    // Six fractional digits, because that is `timestamptz`'s resolution and the whole reason the
    // cursor is a string: a `Date` here truncates to milliseconds and the keyset then **skips** the
    // row it came from (measured on the integration tier — `TaskCursor`'s docblock has the figure).
    const cursor = { createdAt: '2026-09-13T10:15:30.123456Z', id: ID };
    const encoded = encodeTaskCursor(cursor);
    expect(encoded).toBe(`2026-09-13T10:15:30.123456Z|${ID}`);

    const decoded = decodeTaskCursor(encoded);
    expect(decoded.createdAt).toBe('2026-09-13T10:15:30.123456Z');
    expect(decoded.id).toBe(ID);
    // And nothing in the round trip went through `Date`: the microseconds survived, which is the
    // assertion a millisecond-only fixture could not make.
    expect(new Date(decoded.createdAt).toISOString()).not.toBe(decoded.createdAt);
  });

  it('splits on the last separator, so a timestamp offset cannot be mistaken for one', () => {
    const decoded = decodeTaskCursor(`2026-09-13T12:15:30.000+02:00|${ID}`);
    expect(decoded.createdAt).toBe('2026-09-13T12:15:30.000+02:00');
  });

  it('refuses anything it did not issue rather than passing it to the driver', () => {
    for (const raw of [
      '',
      'not-a-cursor',
      ID,
      `2026-09-13T10:15:30.123Z|${ID}x`,
      `yesterday|${ID}`,
      `2026-09-13T10:15:30.123Z|'; drop table tasks; --`,
      // A second field the shape does not have: the schema is strict, so a cursor from a future
      // version of this endpoint is refused rather than half-read.
      `2026-09-13T10:15:30.123Z|${ID}|extra`,
    ]) {
      expect(() => decodeTaskCursor(raw), raw).toThrow(HttpError);
    }
  });

  it('refuses with a 400 and a code a client can branch on', () => {
    try {
      decodeTaskCursor('nope');
      expect.unreachable('an unparseable cursor must be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).statusCode).toBe(400);
      expect((error as HttpError).code).toBe('invalid_cursor');
    }
  });
});

/**
 * **A stored configuration this release does not accept is named, not a 500** — PROGRESS backlog 58.
 *
 * WP-24 narrowed `features.review_only.trigger` from `label | all | manual` to
 * `label | all | paths`, and the platform's **own** `PUT …/config` had accepted `manual`. Boundary
 * schemas are strict, so the value is refused rather than dropped — right on the write side, where
 * the platform is about to act, and wrong on the read side, where it is being told what it stored
 * itself. The whole document failed, the message named no key, and it offered an import endpoint
 * that does not exist; two screens call that read, so one stale key made wizard step 4 and the
 * project panel unopenable.
 *
 * The refusal stays a refusal — a silently pruned document would be re-saved without the key nobody
 * saw — and it now names every key it could not parse **and the value it found there**, which is a
 * `PUT` an operator can make.
 */
describe('an unreadable stored configuration', () => {
  it('names the key and the value, not just the document', () => {
    const stored = {
      version: 1,
      features: { review_only: { enabled: true, trigger: 'manual' } },
    };
    const described = describeConfigIssues(stored, issuesOf(stored), redactText);
    expect(described).toContain('features.review_only.trigger');
    expect(described).toContain('"manual"');
  });

  it('bounds the value it renders, because stored state came from outside', () => {
    const stored = { version: 1, project: { communication_language: 'x'.repeat(500) } };
    const described = describeConfigIssues(stored, issuesOf(stored), redactText);
    expect(described.length).toBeLessThan(MAX_STORED_VALUE_CHARS + 80);
  });

  it('falls back to the issue’s own message when the path names nothing', () => {
    // A missing key has no value to render, and printing `undefined` would read as a stored value.
    const stored = { features: { review_only: {} } };
    const described = describeConfigIssues(stored, issuesOf(stored), redactText);
    expect(described).toContain('version');
    expect(described).not.toContain('undefined');
  });

  /**
   * **The refusal quotes stored state, so it is redacted** (TD-012, BD-022) — review round 2.
   *
   * `projects.config` is not the platform's own document: `mergeProjectConfig` layers the
   * repository's `.agentic/config.yml` over it, so a credential pasted into a config file by
   * somebody who thought the platform would treat it as a secret reaches this message. The route
   * had no redactor at all while the settings writes beside it redacted their free text, which is
   * the asymmetry standing rule 42 asks to be tested from both ends.
   */
  it('redacts a credential stored in a value, and keeps the clause readable', () => {
    // An obviously fake GitLab token, in the shape `gitlab-token` matches.
    const planted = 'glpat-FAKEfake0123456789abc';
    const stored = { version: 1, features: { review_only: { trigger: planted } } };
    const described = describeConfigIssues(stored, issuesOf(stored), redactText);
    expect(described).not.toContain(planted);
    expect(described).toContain('[REDACTED sha256:');
    // …and the operator can still act on it: the key path is what tells them where to look.
    expect(described).toContain('features.review_only.trigger');
  });

  it('redacts a credential a strict schema echoes back as an unknown key', () => {
    // The other route in: a key nobody declared appears in the path *and* in zod's own message.
    const planted = 'glpat-FAKEfake9876543210zyx';
    const stored = { version: 1, project: { [planted]: true } };
    const described = describeConfigIssues(stored, issuesOf(stored), redactText);
    expect(described).not.toContain(planted);
    expect(described).toContain('[REDACTED sha256:');
  });

  it('redacts before it truncates, so a credential across the bound is not half-published', () => {
    /**
     * The order, measured rather than asserted in a comment.
     *
     * The value is padded so that the token **straddles** the 120-character bound. Truncating
     * first would cut it in the middle: no rule can match `glpat-FAKE`, so the prefix of a real
     * credential would be published — which is why redaction runs first and the bound second.
     */
    const planted = 'glpat-FAKEfake0123456789abc';
    const prefix = 'project.communication_language: "';
    const pad = 'x'.repeat(MAX_STORED_VALUE_CHARS - prefix.length - 10);
    const stored = { version: 1, project: { communication_language: `${pad}${planted}` } };
    const described = describeConfigIssues(stored, issuesOf(stored), redactText);
    // The case is only a measurement if the clause really did reach the bound.
    expect(described).toHaveLength(MAX_STORED_VALUE_CHARS);
    expect(described.startsWith(prefix)).toBe(true);
    expect(described).not.toContain('glpat-');
    expect(described).toContain('[REDACTED');
  });
});
