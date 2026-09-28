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
import {
  agenticConfigSchema,
  effectiveConfigResponseSchema,
  MAX_CONTEXT_BUDGET_TOKENS,
} from '@platform/contracts';
import { redaction as redactionAdapters } from '@platform/infrastructure';
import { describe, expect, it } from 'vitest';
import { HttpError } from '../errors.js';
import {
  decodeTaskCursor,
  describeConfigIssues,
  effectiveConfigResponseOf,
  encodeTaskCursor,
  MAX_STORED_VALUE_CHARS,
  riskClassProposalOf,
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

  it('names a class whose checklist the document does not define, by key path and value (WP-45)', () => {
    // Criterion 2 at the read: a stored document that lost its list is refused with the pair an
    // operator can act on, never read as a class that silently requires less.
    const stored = {
      version: 1,
      policies: {
        risk_classes: {
          payments: { paths: ['**/billing/**'], require: ['plan_approval', 'checklist:payments'] },
        },
      },
    };
    const described = describeConfigIssues(stored, issuesOf(stored), redactText);
    expect(described).toBe('policies.risk_classes.payments.require.1: "checklist:payments"');
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

describe('the risk-class proposal the configuration read publishes (WP-37, WP-45)', () => {
  it('offers the platform’s own table — all six classes — when no discovery run has proposed one', () => {
    const offer = riskClassProposalOf(null);
    expect(offer.source).toBe('platform');
    expect(Object.keys(offer.classes).sort()).toEqual([
      'agent_config',
      'auth',
      'data',
      'infra',
      'payments',
      'public_api',
    ]);
  });

  it('tells the truth about `payments` on the published document: both requirements, and the list it needs (backlog 91)', () => {
    const offer = effectiveConfigResponseSchema.shape.risk_class_proposal.parse(
      riskClassProposalOf(null),
    );
    expect(offer.classes.payments?.require).toEqual(['plan_approval', 'checklist:payments']);
    expect(offer.classes.public_api?.require).toEqual(['checklist:public_api']);
    // What accepting asks the operator to write, by name, with the classes that select it — never
    // a docblock sentence.
    expect(offer.checklists).toEqual([
      expect.objectContaining({ name: 'payments', required_by: ['payments'], defined: false }),
      expect.objectContaining({ name: 'public_api', required_by: ['public_api'], defined: false }),
    ]);
    expect(offer.checklists[0]?.purpose).toContain('stricter checklist');
    expect(offer.checklists[1]?.purpose).toContain('compatibility');
  });

  it('says which lists the project’s own document already defines', () => {
    const offer = riskClassProposalOf(null, {
      version: 1,
      policies: { review_checklists: { payments: ['Minor units'] } },
    });
    expect(offer.checklists.map((entry) => [entry.name, entry.defined])).toEqual([
      ['payments', true],
      ['public_api', false],
    ]);
  });

  it('offers what a discovery run proposed, and says it was the agent', () => {
    const stored = { data: { paths: ['db/**'], require: ['plan_approval'] } };
    const offer = riskClassProposalOf(stored);
    expect(offer.source).toBe('discovery');
    expect(offer.classes).toEqual(stored);
    expect(offer.checklists).toEqual([]);
  });

  it('publishes the platform’s current requirements over a stored proposal written before them', () => {
    // A Discovery run before WP-45 stored `payments` with the plan approval only; the paths are the
    // proposal's and what the class forces is the platform's, read now.
    const offer = riskClassProposalOf({
      payments: { paths: ['src/billing/**'], require: ['plan_approval'] },
    });
    expect(offer.classes.payments).toEqual({
      paths: ['src/billing/**'],
      require: ['plan_approval', 'checklist:payments'],
    });
    expect(offer.checklists.map((entry) => entry.name)).toEqual(['payments']);
  });

  it('falls back to the platform’s table for a stored proposal it cannot parse', () => {
    /**
     * The column holds model output about somebody's repository (BD-022), so it is re-validated on
     * the way out — and a failure **drops back to the offer** rather than refusing the whole
     * configuration read. Failing closed here would turn a suggestion into an unopenable settings
     * screen, which is the distinction PROGRESS backlog 58 drew between the write side and the read
     * side.
     */
    for (const stored of [
      {},
      { payments: { paths: [], require: ['plan_approval'] } },
      { payments: { paths: ['src/**'], require: ['budget_approval'] } },
      { 'Not A Slug': { paths: ['src/**'], require: ['plan_approval'] } },
    ]) {
      expect(riskClassProposalOf(stored).source, JSON.stringify(stored)).toBe('platform');
    }
  });
});

/**
 * WP-63 criterion 3: a project whose repository and whose settings **disagree**, asserted in both
 * directions (standing rule 42). The repository wins where it states a key (Q94 (a)); the settings
 * win where the repository is silent; and a repository that is removed or never read gives the
 * settings their keys back.
 */
describe('the effective configuration’s layers (WP-63)', () => {
  const SHA = '0123456789abcdef0123456789abcdef01234567';
  const READ_AT = new Date('2026-09-26T10:00:00.000Z');
  const row = (config: Record<string, unknown>) => ({
    config,
    configSource: {},
    configHash: 'h1',
    updatedAt: READ_AT,
    proposedRiskClasses: null,
  });
  const repo = (
    status: 'valid' | 'invalid' | 'absent',
    values: unknown,
    detail: string | null = null,
  ) => ({
    orgSettings: {},
    repo_status: status,
    repo_commit_sha: SHA,
    repo_config: status === 'valid' ? values : null,
    repo_not_applied: [],
    repo_detail: detail,
    repo_read_at: READ_AT,
  });
  const SETTINGS = {
    version: 1,
    stages: { refinement: { model: 'claude-opus-5', budget_usd: 2 } },
    features: { digest: { at: '08:00' } },
  };
  const answer = (layers: Parameters<typeof effectiveConfigResponseOf>[0]['layers']) =>
    effectiveConfigResponseSchema.parse(
      effectiveConfigResponseOf({ projectId: ID, row: row(SETTINGS), layers, redactText }),
    );

  it('lets the repository win where it states a key, and the settings where it does not', () => {
    const response = answer(
      repo('valid', {
        stages: { refinement: { model: 'claude-sonnet-5' } },
        features: { digest: { at: '09:30' } },
        pipeline: { limits: { ci_fix_iterations: 5 } },
      }),
    );
    // The repository's two keys…
    expect(response.effective.stages?.refinement?.model).toBe('claude-sonnet-5');
    expect(response.sources['stages.refinement.model']).toBe('repo');
    expect(response.effective.pipeline?.limits?.ci_fix_iterations).toBe(5);
    expect(response.sources['pipeline.limits.ci_fix_iterations']).toBe('repo');
    // A feature switch is not the file's to set (review round 1): the settings' value stands.
    expect(response.effective.features?.digest?.at).toBe('08:00');
    expect(response.sources['features.digest.at']).toBe('project');
    expect(response.repository.not_applied.map((item) => item.key)).toEqual(['features']);
    // …the settings' key the repository is silent on…
    expect(response.effective.stages?.refinement?.budget_usd).toBe(2);
    expect(response.sources['stages.refinement.budget_usd']).toBe('project');
    // …a default neither states…
    expect(response.sources['pipeline.limits.human_rounds']).toBe('default');
    // …and the settings layer itself is untouched, so a screen's round trip cannot copy either in.
    expect(response.config).toEqual(SETTINGS);
    expect(response.repository).toMatchObject({ status: 'valid', commit_sha: SHA });
  });

  it('gives the settings their keys back when the repository has no file or was never read', () => {
    for (const layers of [repo('absent', null), null]) {
      const response = answer(layers);
      expect(response.effective.stages?.refinement?.model).toBe('claude-opus-5');
      expect(response.sources['stages.refinement.model']).toBe('project');
      expect(Object.values(response.sources)).not.toContain('repo');
    }
    expect(answer(null).repository).toMatchObject({ status: 'unread', commit_sha: null });
  });

  it('refuses, naming the key path, when the repository file does not parse — never answers without it', () => {
    let thrown: unknown;
    try {
      effectiveConfigResponseOf({
        projectId: ID,
        row: row(SETTINGS),
        layers: repo('invalid', null, 'stages.refinement.max_turns (expected number)'),
        redactText,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).statusCode).toBe(409);
    expect((thrown as HttpError).code).toBe('invalid_repository_config');
    expect((thrown as Error).message).toContain('stages.refinement.max_turns');
    expect((thrown as Error).message).toContain(SHA);
  });

  /**
   * WP-83 criterion 1 (backlog 173): the ceiling fell from 200 000 to 57 500, so a document a
   * previous release stored can now be above it. The read refuses it **by name** — key and value —
   * as backlog 58 made it refuse every other key a release stopped accepting; nothing is clamped.
   */
  it('refuses a stored context budget above the ceiling, naming the key and the value', () => {
    let thrown: unknown;
    try {
      effectiveConfigResponseOf({
        projectId: ID,
        row: row({ version: 1, project: { context_budget_tokens: 200_000 } }),
        layers: null,
        redactText,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).statusCode).toBe(409);
    expect((thrown as HttpError).code).toBe('invalid_stored_config');
    expect((thrown as Error).message).toContain('project.context_budget_tokens');
    expect((thrown as Error).message).toContain('200000');
    // …and the other side of the boundary answers (rule 42).
    const at = effectiveConfigResponseSchema.parse(
      effectiveConfigResponseOf({
        projectId: ID,
        row: row({ version: 1, project: { context_budget_tokens: MAX_CONTEXT_BUDGET_TOKENS } }),
        layers: null,
        redactText,
      }),
    );
    expect(at.effective.project?.context_budget_tokens).toBe(MAX_CONTEXT_BUDGET_TOKENS);
  });

  it('refuses a stored repository reading whose context budget is above the ceiling, by name', () => {
    // A reading an older release stored as `valid` is re-validated on the read, so it answers the
    // repository refusal with the key path rather than merging a value this release refuses.
    expect(() =>
      effectiveConfigResponseOf({
        projectId: ID,
        row: row(SETTINGS),
        layers: repo('valid', { project: { context_budget_tokens: 200_000 } }),
        redactText,
      }),
    ).toThrow(/project\.context_budget_tokens/);
  });

  it('refuses an organisation command maximum it cannot parse rather than reading none', () => {
    expect(() =>
      effectiveConfigResponseOf({
        projectId: ID,
        row: row(SETTINGS),
        layers: { ...repo('absent', null), orgSettings: { commands: { allow: 'git *' } } },
        redactText,
      }),
    ).toThrow(/organizations\.settings\.commands/);
  });

  it('never lets the repository widen the commands past the organisation, and publishes what it drops', () => {
    const response = answer({
      ...repo('valid', { commands: { allow: ['make test', 'curl https://example.test'] } }),
      orgSettings: { commands: { allow: ['make test'] } },
    });
    expect(response.effective.commands?.allow).toEqual(['make test']);
    expect(response.sources['commands.allow']).toBe('repo');
    expect(response.ignored_allow_commands).toEqual(['curl https://example.test']);
  });

  /**
   * Review round 1's ruling at the read: the file may tighten, never loosen. An emptied
   * `protected_paths`, a dial override and a re-granted command have no effect and are reported;
   * an added protected path takes effect.
   */
  it('applies what the file tightens and reports, without applying, what it loosens', () => {
    const response = effectiveConfigResponseSchema.parse(
      effectiveConfigResponseOf({
        projectId: ID,
        row: row({ version: 1, commands: { allow: ['npm test'] } }),
        layers: {
          ...repo('valid', {
            policies: { protected_paths: ['secrets/**'] },
            commands: { allow: ['npm test', 'make test'] },
          }),
          // As stored before the grading existed: re-validated on read, not trusted.
          repo_config: {
            policies: { protected_paths: ['secrets/**'], probation_tasks: 0 },
            commands: { allow: ['npm test', 'make test'] },
          },
        },
        redactText,
      }),
    );
    const paths = response.effective.policies?.protected_paths ?? [];
    expect(paths).toContain('secrets/**');
    expect(paths).toContain('.agentic/**');
    expect(response.effective.policies?.probation_tasks).toBe(5);
    expect(response.effective.commands?.allow).toContain('npm test');
    expect(response.effective.commands?.allow).not.toContain('make test');
    expect(response.ignored_allow_commands).toEqual(['make test']);
    expect(response.repository.not_applied.map((item) => item.key).sort()).toEqual([
      'policies.probation_tasks',
      'policies.protected_paths',
    ]);
  });

  it('publishes the dial the project runs, not a cap nobody set', () => {
    const response = effectiveConfigResponseSchema.parse(
      effectiveConfigResponseOf({
        projectId: ID,
        row: row({ version: 1, policies: { autonomy: 'autonomous' } }),
        layers: null,
        redactText,
      }),
    );
    expect(response.effective.policies?.autonomy).toBe('autonomous');
    expect(response.sources['policies.autonomy']).toBe('project');
  });
});
