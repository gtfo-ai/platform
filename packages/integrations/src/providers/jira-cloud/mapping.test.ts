/**
 * The wire → port mapping, and the two conversions in it that are not cosmetic: Jira's timestamp
 * offset, and the direction an issue link is read from.
 */
import { describe, expect, it } from 'vitest';
import {
  identityOfUser,
  issueUrl,
  jiraCommentSchema,
  jiraDateTimeSchema,
  jiraIssueWithUpdatedSchema,
  slugOf,
  toTicketComment,
  toTicketLinks,
} from './mapping.js';

describe('jiraDateTimeSchema', () => {
  it('normalises the offset Jira actually sends', () => {
    // Atlassian's examples are all `2021-01-17T12:34:00.000+0000`, and the platform's
    // `isoDateTimeSchema` (zod `z.iso.datetime({offset:true})`) rejects an offset with no colon.
    expect(jiraDateTimeSchema.parse('2021-01-17T12:34:00.000+0000')).toBe(
      '2021-01-17T12:34:00.000Z',
    );
    expect(jiraDateTimeSchema.parse('2026-09-01T10:15:00.000+0200')).toBe(
      '2026-09-01T08:15:00.000Z',
    );
    expect(jiraDateTimeSchema.parse('2026-09-01T10:15:00.000Z')).toBe('2026-09-01T10:15:00.000Z');
  });

  it('reports an unusable timestamp as a validation failure, not as an exception', () => {
    const result = jiraDateTimeSchema.safeParse('yesterday');
    expect(result.success).toBe(false);
  });
});

describe('identityOfUser', () => {
  it('is unverified, because only the platform can say who a Jira account is', () => {
    expect(
      identityOfUser({
        accountId: '557058:fake',
        displayName: 'Dev One',
        emailAddress: 'dev@example.test',
      }),
    ).toEqual({
      provider: 'jira-cloud',
      external_id: '557058:fake',
      email: 'dev@example.test',
      display_name: 'Dev One',
      verified: false,
    });
  });

  it('is null when there is no account id to identify', () => {
    expect(identityOfUser({ displayName: 'Anonymous' })).toBeNull();
    expect(identityOfUser(undefined)).toBeNull();
  });

  it('drops an `emailAddress` that is not an email address', () => {
    // Provider text is untrusted (BD-022) and `externalIdentitySchema` requires `z.email()`.
    expect(identityOfUser({ accountId: 'x', emailAddress: 'not an address' })?.email).toBeNull();
  });
});

describe('toTicketLinks', () => {
  const issueOf = (issuelinks: unknown[]) =>
    jiraIssueWithUpdatedSchema.parse({
      key: 'ACME-1',
      fields: { updated: '2026-09-01T10:15:00.000+0000', issuelinks },
    });

  it('reads the link from the side the ticket is on', () => {
    const inward = toTicketLinks(
      issueOf([
        {
          type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
          inwardIssue: { key: 'ACME-3', fields: { status: { name: 'In Progress' } } },
        },
      ]),
      'https://acme-example.atlassian.net',
    );
    expect(inward).toEqual([
      {
        kind: 'is_blocked_by',
        key: 'ACME-3',
        url: 'https://acme-example.atlassian.net/browse/ACME-3',
        state: 'In Progress',
      },
    ]);

    const outward = toTicketLinks(
      issueOf([
        {
          type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
          outwardIssue: { key: 'ACME-4', fields: { status: { name: 'Done' } } },
        },
      ]),
      'https://acme-example.atlassian.net',
    );
    expect(outward[0]?.kind, 'the other side of the same link type').toBe('blocks');
  });

  it('skips a link with no issue on either side rather than inventing one', () => {
    expect(toTicketLinks(issueOf([{ type: { name: 'Blocks' } }]), 'https://x.test')).toEqual([]);
  });
});

describe('slugOf', () => {
  it('turns a Jira relationship into a stable kind', () => {
    expect(slugOf('is blocked by')).toBe('is_blocked_by');
    expect(slugOf('merge request')).toBe('merge_request');
    expect(slugOf('  Relates To  ')).toBe('relates_to');
    expect(slugOf('***')).toBe('relates_to');
  });
});

describe('toTicketComment', () => {
  it('renders the body as markdown and finds the platform’s marker', () => {
    // Parsed first, exactly as the adapter does: the timestamp normalisation lives in the schema,
    // so a mapper called on unparsed provider data would carry Jira's offset through.
    const comment = toTicketComment(
      jiraCommentSchema.parse({
        id: '10100',
        author: { accountId: '557058:fake', displayName: 'Agentic Platform' },
        created: '2026-09-01T09:30:00.000+0000',
        updated: '2026-09-01T09:31:00.000+0000',
        body: {
          type: 'doc',
          version: 1,
          content: [
            { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Workpad' }] },
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: '[agentic:marker:agentic:workpad]',
                  marks: [{ type: 'code' }],
                },
              ],
            },
          ],
        },
      }),
      { siteUrl: 'https://acme-example.atlassian.net', issueKey: 'ACME-1' },
    );

    expect(comment.body).toBe('# Workpad');
    expect(comment.marker_id).toBe('agentic:workpad');
    expect(comment.created_at).toBe('2026-09-01T09:30:00.000Z');
    expect(comment.url).toBe(
      'https://acme-example.atlassian.net/browse/ACME-1?focusedCommentId=10100',
    );
  });

  it('keeps an authorless comment readable instead of failing the whole ticket read', () => {
    const comment = toTicketComment(
      jiraCommentSchema.parse({ id: '1', created: '2026-09-01T09:30:00.000+0000' }),
      { siteUrl: 'https://x.test', issueKey: 'ACME-1' },
    );
    expect(comment.author.external_id).toBe('unknown');
    expect(comment.author.verified).toBe(false);
    expect(comment.body).toBe('');
  });
});

describe('issueUrl', () => {
  it('is the browse URL, with a trailing slash in the site absorbed', () => {
    expect(issueUrl('https://acme-example.atlassian.net/', 'ACME-1')).toBe(
      'https://acme-example.atlassian.net/browse/ACME-1',
    );
  });
});
