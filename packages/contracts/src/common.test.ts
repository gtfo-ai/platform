import { describe, expect, it } from 'vitest';
import {
  actorSchema,
  agentRoleSchema,
  BUILTIN_STAGE_IDS,
  BUILTIN_TEMPLATE_IDS,
  durationSchema,
  externalIdentitySchema,
  idSchema,
  isoDateSchema,
  isoDateTimeSchema,
  languageTagSchema,
  mergeRequestRefSchema,
  runCostSchema,
  shaSchema,
  slugSchema,
  stageIdSchema,
  templateIdSchema,
  ticketRefSchema,
  timeOfDaySchema,
  tokenUsageSchema,
  unitIntervalSchema,
  usdSchema,
  workpadRefSchema,
} from './common.js';

describe('scalars', () => {
  it.each([
    ['0199aa11-2b3c-7d4e-8f90-000000000001', true],
    ['3f2504e0-4f89-41d3-9a0c-0305e82c3301', true],
    ['not-a-uuid', false],
    ['0199aa11-2b3c-7d4e-8f90', false],
  ])('validates id %s', (value, expected) => {
    expect(idSchema.safeParse(value).success).toBe(expected);
  });

  it.each([
    ['2026-09-09T10:15:30Z', true],
    ['2026-09-09T10:15:30.123Z', true],
    ['2026-09-09T12:15:30+02:00', true],
    ['2026-09-09 10:15:30', false],
    ['2026-09-09', false],
  ])('validates timestamp %s', (value, expected) => {
    expect(isoDateTimeSchema.safeParse(value).success).toBe(expected);
  });

  it.each([
    ['refinement', true],
    ['business_review', true],
    ['stage2', true],
    ['Business_Review', false],
    ['business-review', false],
    ['2fast', false],
    ['', false],
  ])('validates slug %s', (value, expected) => {
    expect(slugSchema.safeParse(value).success).toBe(expected);
  });

  it.each([
    ['en', true],
    ['cs', true],
    ['pt-BR', true],
    ['english', false],
    ['EN', false],
  ])('validates language tag %s', (value, expected) => {
    expect(languageTagSchema.safeParse(value).success).toBe(expected);
  });

  it.each([
    ['abc1234', true],
    ['0123456789abcdef0123456789abcdef01234567', true],
    ['abc123', false],
    ['ABC1234', false],
    ['zzzzzzz', false],
  ])('validates git sha %s', (value, expected) => {
    expect(shaSchema.safeParse(value).success).toBe(expected);
  });

  it.each([
    ['09:00', true],
    ['23:59', true],
    ['24:00', false],
    ['9:00', false],
  ])('validates time of day %s', (value, expected) => {
    expect(timeOfDaySchema.safeParse(value).success).toBe(expected);
  });

  it.each([
    ['2026-09-09', true],
    ['2026-9-9', false],
    ['2026-09-09T10:15:30Z', false],
  ])('validates calendar date %s', (value, expected) => {
    expect(isoDateSchema.safeParse(value).success).toBe(expected);
  });

  it('rejects negative money and non-finite numbers', () => {
    expect(usdSchema.safeParse(0).success).toBe(true);
    expect(usdSchema.safeParse(12.345678).success).toBe(true);
    expect(usdSchema.safeParse(-1).success).toBe(false);
    expect(usdSchema.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
    expect(usdSchema.safeParse(Number.NaN).success).toBe(false);
  });

  it('bounds unit intervals', () => {
    expect(unitIntervalSchema.safeParse(0).success).toBe(true);
    expect(unitIntervalSchema.safeParse(1).success).toBe(true);
    expect(unitIntervalSchema.safeParse(1.0001).success).toBe(false);
    expect(unitIntervalSchema.safeParse(-0.1).success).toBe(false);
  });

  it('accepts the duration forms technical/12 writes', () => {
    expect(durationSchema.safeParse('1 working day').success).toBe(true);
    expect(durationSchema.safeParse('45 minutes').success).toBe(true);
    expect(durationSchema.safeParse('1d').success).toBe(false);
  });
});

describe('identity and actor (BD-022, BD-006)', () => {
  it('records whether an external identity is verified', () => {
    const identity = {
      provider: 'gitlab',
      external_id: '17',
      email: 'dev@example.com',
      display_name: 'Dev',
      verified: false,
    };
    expect(externalIdentitySchema.parse(identity)).toEqual(identity);
  });

  it('requires the verified flag — an identity is never implicitly trusted', () => {
    expect(
      externalIdentitySchema.safeParse({ provider: 'gitlab', external_id: '17' }).success,
    ).toBe(false);
  });

  it.each([
    [{ kind: 'system', component: 'pipeline' }, true],
    [{ kind: 'user', user_id: '0199aa11-2b3c-7d4e-8f90-000000000001' }, true],
    [
      {
        kind: 'integration',
        integration_id: '0199aa11-2b3c-7d4e-8f90-000000000002',
        provider: 'jira',
      },
      true,
    ],
    [{ kind: 'agent', run_id: '0199aa11-2b3c-7d4e-8f90-000000000003' }, false],
    [{ kind: 'user' }, false],
    [{ kind: 'system', component: 'pipeline', extra: 1 }, false],
  ])('validates actor %#', (value, expected) => {
    expect(actorSchema.safeParse(value).success).toBe(expected);
  });
});

describe('refs', () => {
  it('requires an absolute url on a ticket ref', () => {
    expect(
      ticketRefSchema.safeParse({ provider: 'jira', key: 'PROJ-1', url: '/browse/PROJ-1' }).success,
    ).toBe(false);
  });

  it('accepts the minimal merge-request ref an artifact carries', () => {
    const ref = { iid: 42, url: 'https://gitlab.example.com/g/r/-/merge_requests/42' };
    expect(mergeRequestRefSchema.parse(ref)).toEqual(ref);
    expect(mergeRequestRefSchema.safeParse({ ...ref, iid: 0 }).success).toBe(false);
  });

  it('ties a workpad to a single provider comment (BD-023)', () => {
    const ref = { provider: 'jira', ticket_key: 'PROJ-1', comment_id: '10023', url: null };
    expect(workpadRefSchema.parse(ref)).toEqual(ref);
  });
});

describe('usage and cost', () => {
  it('requires every cache bucket, so a total can never silently omit one', () => {
    expect(
      tokenUsageSchema.safeParse({ input_tokens: 1, output_tokens: 1, cache_read_tokens: 1 })
        .success,
    ).toBe(false);
  });

  it('marks estimated cost explicitly (BD-011, local provider mode)', () => {
    expect(runCostSchema.parse({ usd: 0, is_estimate: true, price_list_id: null })).toEqual({
      usd: 0,
      is_estimate: true,
      price_list_id: null,
    });
    expect(runCostSchema.safeParse({ usd: 1 }).success).toBe(false);
  });
});

describe('built-in identifiers', () => {
  it('lists the four shipped templates (BD-005) and they are valid template ids', () => {
    expect(BUILTIN_TEMPLATE_IDS).toEqual(['feature', 'bug', 'chore', 'spike']);
    for (const id of BUILTIN_TEMPLATE_IDS) {
      expect(templateIdSchema.safeParse(id).success).toBe(true);
    }
  });

  it('lists the stages of the shipped templates and they are valid stage ids', () => {
    for (const id of BUILTIN_STAGE_IDS) {
      expect(stageIdSchema.safeParse(id).success).toBe(true);
    }
    expect(new Set(BUILTIN_STAGE_IDS).size).toBe(BUILTIN_STAGE_IDS.length);
  });

  it('covers every role that ships a prompt', () => {
    expect(agentRoleSchema.options).toContain('librarian');
    expect(agentRoleSchema.safeParse('project_manager').success).toBe(false);
  });
});
