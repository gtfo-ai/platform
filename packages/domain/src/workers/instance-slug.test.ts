import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PROPERTY_TEST_TIMEOUT_MS } from '../testing/property.js';
import {
  INSTANCE_SLUG_MAX_CHARS,
  INSTANCE_SLUG_PATTERN,
  instanceSlug,
  slugOfHost,
  slugOfText,
} from './instance-slug.js';

/** The updater's project pattern (`apps/server/src/updater/plan.ts`): every slug lies inside it. */
const UPDATER_PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

const holdsThePattern = (slug: string): void => {
  if (slug === '') return;
  expect(slug).toMatch(INSTANCE_SLUG_PATTERN);
  expect(`agentic-worker-${slug}`).toMatch(UPDATER_PROJECT_PATTERN);
};

describe('a platform’s slug (S-29.1, TD-031 2026-11-24 decision 9)', () => {
  it('folds a name: lowercase, diacritics dropped, every other run one hyphen, the ends trimmed', () => {
    expect(slugOfText('FontAI')).toBe('fontai');
    expect(slugOfText('Mikeš s.r.o.')).toBe('mikes-s-r-o');
    expect(slugOfText('Žluťoučký kůň')).toBe('zlutoucky-kun');
    expect(slugOfText('  --Autix!!  ')).toBe('autix');
    expect(slugOfText('ﬁnance Ⅻ')).toBe('finance-xii');
    expect(slugOfText('Acme_Corp')).toBe('acme-corp');
  });

  it('answers nothing for a name with nothing of [a-z0-9] in it', () => {
    for (const nothing of ['', '   ', '株式会社', '🚀🚀', '—', '<>"\'']) {
      expect(slugOfText(nothing), nothing).toBe('');
    }
  });

  it('cuts a 200-character name to 24, never ending on a hyphen', () => {
    expect(slugOfText('a'.repeat(200))).toBe('a'.repeat(INSTANCE_SLUG_MAX_CHARS));
    // The 24th character would be the hyphen between the words: the cut drops it.
    const cut = slugOfText(`${'b'.repeat(23)} ${'c'.repeat(176)}`);
    expect(cut).toBe('b'.repeat(23));
    holdsThePattern(cut);
    expect(slugOfText('Agentic Platform for Autix Engineering Team')).toBe(
      'agentic-platform-for-aut',
    );
  });

  it('takes a host’s first label that is not agentic, www or worker', () => {
    expect(slugOfHost('agentic.fontai.org')).toBe('fontai');
    expect(slugOfHost('www.agentic.autix.eu')).toBe('autix');
    expect(slugOfHost('worker.agentic.example.com:8443')).toBe('example');
    expect(slugOfHost('Core.Example.TEST.')).toBe('core');
    expect(slugOfHost('localhost:8080')).toBe('localhost');
    expect(slugOfHost('host.docker.internal')).toBe('host');
    expect(slugOfHost('127.0.0.1')).toBe('127-0-0-1');
    expect(slugOfHost('[::1]')).toBe('1');
    expect(slugOfHost('[fe80::a]:8080')).toBe('fe80-a');
    expect(slugOfHost('agentic.www')).toBe('');
  });

  it('prefers the name, and falls back to the host when nothing of the name survives', () => {
    expect(instanceSlug({ name: 'FontAI s.r.o.', host: 'agentic.fontai.org' })).toBe(
      'fontai-s-r-o',
    );
    expect(instanceSlug({ name: '株式会社', host: 'agentic.fontai.org' })).toBe('fontai');
    expect(instanceSlug({ name: null, host: 'agentic.autix.eu' })).toBe('autix');
    expect(instanceSlug({ name: null, host: 'agentic.www' })).toBe('');
  });

  it(
    'always answers a slug the pattern admits, or nothing — whatever the name and host (property)',
    () => {
      fc.assert(
        fc.property(
          fc.option(fc.string({ unit: 'binary', maxLength: 200 }), { nil: null }),
          fc.string({ unit: 'binary', maxLength: 120 }),
          (name, host) => {
            holdsThePattern(slugOfText(name ?? ''));
            holdsThePattern(slugOfHost(host));
            holdsThePattern(instanceSlug({ name, host }));
          },
        ),
      );
      fc.assert(
        fc.property(
          fc.array(fc.constantFrom('a', 'Z', 'š', 'é', '-', ' ', '.', '_', '9', 'ß', 'ø'), {
            maxLength: 200,
          }),
          (parts) => holdsThePattern(slugOfText(parts.join(''))),
        ),
      );
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );
});
