/**
 * TD-012 at the artifact write: the prose half, the identifier half, and the two refusals.
 *
 * The redactor these cases use is the real one — `exactSecretRedactor` over a fake credential —
 * rather than a stub that counts calls, because what is under test is a *composition* of the
 * per-field table with a redactor, and a stub would pass whatever the walker did.
 */
import type { JsonValue } from '@platform/contracts';
import { ARTIFACT_FIELD_POLICIES } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { exactSecretRedactor, noSecretsRedactor } from '../integrations/redaction.js';
import {
  ArtifactIdentifierSecretError,
  ArtifactPolicyMissingError,
  findArtifactIdentifierSecret,
  redactArtifactData,
} from './redaction.js';

/** Obviously fake, and long enough to pass `MIN_SECRET_LENGTH` (BD-002). */
const SECRET = 'sk-ant-api03-FAKE-NOT-A-REAL-KEY-0000';
const PLACEHOLDER = '[REDACTED:integration:anthropic_api_key]';

const redactor = exactSecretRedactor([{ name: 'anthropic_api_key', value: SECRET }]);

/**
 * Builds the smallest document that has `value` at `path`, from the path grammar alone.
 *
 * `mr.head_sha` → `{mr: {head_sha: value}}`; `proposals[].target_path` →
 * `{proposals: [{target_path: value}]}`; `risk_classes[].paths[]` →
 * `{risk_classes: [{paths: [value]}]}`. It is written from the **grammar**, independently of the
 * walker, so the two agreeing is evidence rather than a tautology (standing rule 65: the oracle is
 * a second implementation, not a call to the first).
 */
const plantAt = (path: string, value: string): JsonValue => {
  const build = (segments: readonly string[]): JsonValue => {
    const [head, ...rest] = segments;
    if (head === undefined) return value;
    if (head === '') return [build(rest)];
    const [name, ...brackets] = head.split('[]');
    // `a[]` is "the array under `a`"; `a[][]` would be an array of arrays, which no schema has.
    const inner = brackets.length === 0 ? build(rest) : [build(rest)];
    return { [name as string]: inner };
  };
  // `a.b[].c` → ['a', 'b[]', 'c']; a trailing `[]` on the last segment is handled by `build`.
  return build(path.split('.'));
};

const notes = (overrides: Record<string, JsonValue> = {}): JsonValue => ({
  summary: 'did the thing',
  deviations_from_plan: [],
  tests_added: [],
  commands_run: [],
  known_gaps: [],
  followup_tickets: [],
  mr: {
    provider: 'gitlab',
    project_path: 'acme/api',
    iid: 12,
    url: 'https://gitlab.example.com/acme/api/-/merge_requests/12',
    branch: 'agentic/ACME-1',
    head_sha: 'a'.repeat(40),
  },
  ...overrides,
});

describe('redactArtifactData', () => {
  it('replaces a secret in prose and counts every replacement', () => {
    const result = redactArtifactData(
      'ImplementationNotes',
      notes({ summary: `ran with ${SECRET} and again ${SECRET}`, known_gaps: [`left ${SECRET}`] }),
      redactor,
    );
    const data = result.data as { summary: string; known_gaps: string[] };
    expect(data.summary).toBe(`ran with ${PLACEHOLDER} and again ${PLACEHOLDER}`);
    expect(data.known_gaps[0]).toBe(`left ${PLACEHOLDER}`);
    expect(result.count).toBe(3);
  });

  /** Criterion (2)'s first direction: nothing to redact is `0`, never an absence. */
  it('reports 0 for a document with nothing to redact', () => {
    expect(redactArtifactData('ImplementationNotes', notes(), redactor).count).toBe(0);
    expect(redactArtifactData('ImplementationNotes', notes(), noSecretsRedactor()).count).toBe(0);
  });

  it('leaves an identifier byte-identical when it carries no secret', () => {
    const result = redactArtifactData('ImplementationNotes', notes(), redactor);
    const data = result.data as { mr: { head_sha: string; branch: string } };
    expect(data.mr.head_sha).toBe('a'.repeat(40));
    expect(data.mr.branch).toBe('agentic/ACME-1');
  });

  /**
   * Criterion (3), and the reason this is a per-field policy rather than a blanket redaction: the
   * refusal is asserted, **not** the redaction. `recordMergeRequest` copies this field onto `tasks`
   * and the git provider is then addressed with it.
   */
  it('refuses an identifier that carries a secret, naming the field and not the value', () => {
    const hostile = notes({
      mr: {
        provider: 'gitlab',
        project_path: 'acme/api',
        iid: 12,
        url: 'https://gitlab.example.com/acme/api/-/merge_requests/12',
        branch: 'agentic/ACME-1',
        head_sha: SECRET,
      },
    });
    expect(() => redactArtifactData('ImplementationNotes', hostile, redactor)).toThrowError(
      ArtifactIdentifierSecretError,
    );
    try {
      redactArtifactData('ImplementationNotes', hostile, redactor);
      expect.unreachable('the write should have been refused');
    } catch (error) {
      expect(error).toBeInstanceOf(ArtifactIdentifierSecretError);
      const refusal = error as ArtifactIdentifierSecretError;
      expect(refusal.path).toBe('mr.head_sha');
      expect(refusal.message).toContain('mr.head_sha');
      // The message reaches a `run.failed` payload and a blocker brief a human reads.
      expect(refusal.message).not.toContain(SECRET);
    }
  });

  it('refuses before it rewrites, so a refused document leaves no half-redacted copy', () => {
    const hostile = notes({
      summary: `wrote ${SECRET}`,
      mr: {
        provider: 'gitlab',
        project_path: 'acme/api',
        iid: 12,
        url: 'https://gitlab.example.com/acme/api/-/merge_requests/12',
        branch: SECRET,
        head_sha: 'a'.repeat(40),
      },
    });
    expect(() => redactArtifactData('ImplementationNotes', hostile, redactor)).toThrowError(
      /mr\.branch/,
    );
    // The input object is untouched: the walker builds a new document and never mutates.
    expect(JSON.stringify(hostile)).toContain(SECRET);
  });

  it('walks into arrays of objects, which is where most artifact prose lives', () => {
    const result = redactArtifactData(
      'LibrarianProposals',
      {
        summary: '',
        health: [],
        proposals: [
          {
            action: 'add',
            kind: 'lesson',
            type: 'technical',
            target_path: 'lessons/L-1.md',
            delta: `page body with ${SECRET}`,
            evidence: [`saw ${SECRET}`],
            significance: 0.5,
            reason: 'because',
          },
        ],
      },
      redactor,
    );
    expect(JSON.stringify(result.data)).not.toContain(SECRET);
    expect(result.count).toBe(2);
    expect(
      (result.data as { proposals: { target_path: string }[] }).proposals[0]?.target_path,
    ).toBe('lessons/L-1.md');
  });

  /** Standing rule 7: an unclassified type fails rather than defaulting to prose. */
  it('refuses an artifact type with no declared policy', () => {
    expect(() =>
      redactArtifactData('NotAnArtifactType' as never, { a: 'b' }, redactor),
    ).toThrowError(ArtifactPolicyMissingError);
  });
});

describe('findArtifactIdentifierSecret', () => {
  it('answers null when every identifier is clean', () => {
    expect(findArtifactIdentifierSecret('ImplementationNotes', notes(), redactor)).toBeNull();
  });

  it('answers the path of the offending identifier', () => {
    const answer = {
      answer: 'because',
      citations: [{ kind: 'run', run_id: SECRET, detail: 'the run' }],
      unanswered: [],
      confidence: 'high',
    } satisfies JsonValue;
    expect(findArtifactIdentifierSecret('AskAnswer', answer, redactor)).toBe('citations[].run_id');
  });

  /**
   * The narrowness of the `AskAnswer` identifier list is a **decision** (WP-31's exception, kept by
   * WP-52), so it is asserted rather than left implied by the case above: a credential in
   * `reference` is redacted by the ask's own recorder and does not refuse the answer.
   */
  it('does not treat an ask citation reference as an identifier', () => {
    expect(ARTIFACT_FIELD_POLICIES.AskAnswer.identifiers).toEqual(['citations[].run_id']);
    const answer = {
      answer: 'because',
      citations: [{ kind: 'knowledge', reference: `vault/${SECRET}.md`, detail: 'the page' }],
      unanswered: [],
      confidence: 'high',
    } satisfies JsonValue;
    expect(findArtifactIdentifierSecret('AskAnswer', answer, redactor)).toBeNull();
    expect(JSON.stringify(redactArtifactData('AskAnswer', answer, redactor).data)).toContain(
      PLACEHOLDER,
    );
  });

  /**
   * The table and the walker agree on the grammar, checked over **every** declared identifier path
   * of every type rather than at one: a path that the walker cannot reach — a typo, a stale name, a
   * grammar the two spell differently — would make the policy silently inert for that field, which
   * is the failure mode a table of strings has.
   */
  it('reaches every identifier path the table declares, for every type', () => {
    for (const [artifactType, policy] of Object.entries(ARTIFACT_FIELD_POLICIES)) {
      for (const path of policy.identifiers) {
        const planted = plantAt(path, SECRET);
        expect(
          findArtifactIdentifierSecret(
            artifactType as keyof typeof ARTIFACT_FIELD_POLICIES,
            planted,
            redactor,
          ),
          `${artifactType} › ${path}`,
        ).toBe(path);
      }
    }
  });
});
