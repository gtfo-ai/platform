import { MAX_LINKED_ISSUES } from '@platform/application';
import { describe, expect, it } from 'vitest';
import { sentryLinkedIssues } from './links.js';

const SAAS = { baseUrl: 'https://sentry.io', organization: 'acme' };
const SELF_HOSTED = { baseUrl: 'https://sentry.example.test', organization: 'acme' };

const ids = (text: string, scope = SAAS): string[] =>
  sentryLinkedIssues(text, scope).map((ref) => ref.id);

describe('sentryLinkedIssues (WP-89)', () => {
  it.each([
    ['the organisation subdomain', 'https://acme.sentry.io/issues/4242/', SAAS],
    ['the organisations path', 'https://sentry.io/organizations/acme/issues/4242/?project=1', SAAS],
    [
      'a regional base host',
      'https://acme.sentry.io/issues/4242',
      { ...SAAS, baseUrl: 'https://us.sentry.io' },
    ],
    [
      'a self-hosted organisations path',
      'https://sentry.example.test/organizations/acme/issues/4242/',
      SELF_HOSTED,
    ],
    ['the older permalink form', 'https://sentry.example.test/acme/api/issues/4242/', SELF_HOSTED],
    [
      'Jira wiki markup around it',
      '[ACME-1AB|https://acme.sentry.io/issues/4242/?referrer=jira]',
      SAAS,
    ],
    ['Markdown around it', 'see [the issue](https://acme.sentry.io/issues/4242/).', SAAS],
  ])('finds the issue in %s', (_name, text, scope) => {
    expect(ids(text, scope)).toEqual(['4242']);
  });

  it.each([
    ['another host', 'https://evil.example.test/organizations/acme/issues/1/'],
    ['another organisation’s subdomain', 'https://other.sentry.io/issues/1/'],
    [
      'another organisation named in the path',
      'https://acme.sentry.io/organizations/other/issues/1/',
    ],
    ['the base host with no organisation in the path', 'https://sentry.io/issues/1/'],
    ['a non-numeric id', 'https://acme.sentry.io/issues/abc/'],
    ['an id longer than twenty digits', `https://acme.sentry.io/issues/${'9'.repeat(21)}/`],
    ['a lookalike host suffix', 'https://acme.sentry.io.evil.example.test/issues/1/'],
    ['a path that only contains the word', 'https://acme.sentry.io/myissues/1/'],
    ['a non-http scheme', 'ftp://acme.sentry.io/issues/1/'],
  ])('ignores %s', (_name, text) => {
    expect(ids(text)).toEqual([]);
  });

  it('keeps the order of first appearance and answers each issue once', () => {
    const text = [
      'https://acme.sentry.io/issues/2/',
      'https://sentry.io/organizations/acme/issues/1/',
      'https://acme.sentry.io/issues/2/?again',
    ].join(' and ');
    expect(ids(text)).toEqual(['2', '1']);
  });

  it('stops at MAX_LINKED_ISSUES, on both sides of the bound', () => {
    const links = (count: number): string =>
      Array.from({ length: count }, (_, at) => `https://acme.sentry.io/issues/${at + 1}/`).join(
        ' ',
      );
    expect(ids(links(MAX_LINKED_ISSUES))).toHaveLength(MAX_LINKED_ISSUES);
    expect(ids(links(MAX_LINKED_ISSUES + 1))).toHaveLength(MAX_LINKED_ISSUES);
    expect(ids(links(MAX_LINKED_ISSUES + 1)).at(-1)).toBe(String(MAX_LINKED_ISSUES));
  });

  it('answers nothing for text with no link, and never throws on a malformed one', () => {
    expect(ids('')).toEqual([]);
    expect(ids('http://[::1')).toEqual([]);
  });
});
