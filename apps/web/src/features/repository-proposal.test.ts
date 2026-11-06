/**
 * What step 1 proposes from a repository URL (S-25.8): the name and key derived from it, the key
 * always one the server accepts or empty (by property, against the server's own schema), and the
 * draft rules — a field the person edited is never overwritten, the default branch is never
 * proposed.
 */
import { createProjectRequestSchema } from '@platform/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  draftWithName,
  draftWithRepositoryUrl,
  EMPTY_PROJECT_DRAFT,
  projectKeyOf,
  proposalFromRepositoryUrl,
  repositoryNameOf,
} from './repository-proposal.js';

/** The server's own key check — the schema `POST /api/projects` parses its body with. */
const keySchema = createProjectRequestSchema.shape.key;

/** A key the server accepts, or the empty proposal (nothing proposed). */
const acceptedOrEmpty = (key: string): boolean => key === '' || keySchema.safeParse(key).success;

/** Repository addresses in every spelling the field meets, with hostile segments in them. */
const segment = fc.string({ minLength: 0, maxLength: 24, unit: 'grapheme' });
const repositoryAddress = fc
  .tuple(
    fc.constantFrom('https://', 'http://', 'ssh://git@', 'file:///', 'git@', ''),
    fc.constantFrom('gitlab.com', 'git.example.test:2222', 'github.com', ''),
    fc.array(segment, { maxLength: 4 }),
    fc.constantFrom('', '.git', '.GIT', '/', '.git/', '?ref=main', '#readme', '/-/tree/main'),
  )
  .map(([scheme, host, path, suffix]) => {
    const separator = scheme === 'git@' ? ':' : '/';
    return `${scheme}${host}${separator}${path.join('/')}${suffix}`;
  });

describe('the repository proposal', () => {
  it.each([
    ['https://gitlab.com/autix/autix-core.git', 'autix-core', 'autix_core'],
    ['git@gitlab.com:autix/autix-core.git', 'autix-core', 'autix_core'],
    ['ssh://git@git.example.test:2222/group/sub/Billing-API.git', 'Billing-API', 'billing_api'],
    ['file:///srv/git/Billing%20API.git', 'Billing API', 'billing_api'],
    ['  https://gitlab.com/autix/autix-core.git/  ', 'autix-core', 'autix_core'],
    ['https://gitlab.com/autix/autix-core/-/tree/main', 'autix-core', 'autix_core'],
    ['https://gitlab.com/autix/autix-core?ref=main#readme', 'autix-core', 'autix_core'],
    ['https://example.test/acme/Café.Web.git', 'Café.Web', 'cafe_web'],
    // The key has to start with a letter: what comes before the first one is dropped.
    ['https://example.test/acme/2048-game.git', '2048-game', 'game'],
  ])('proposes from %s the name %s and the key %s', (url, name, key) => {
    expect(proposalFromRepositoryUrl(url)).toEqual({ name, key });
    expect(keySchema.safeParse(key).success).toBe(true);
  });

  it.each([
    ['', '', ''],
    ['https://gitlab.com', '', ''],
    ['https://gitlab.com/', '', ''],
    ['git@gitlab.com:', '', ''],
    // A name with no letter in it proposes no key rather than one the server refuses.
    ['https://example.test/acme/2048.git', '2048', ''],
    ['https://example.test/acme/___.git', '___', ''],
    // A stray `%` is kept as typed rather than thrown on.
    ['https://example.test/acme/100%-done', '100%-done', 'done'],
  ])('proposes from %j the name %j and the key %j', (url, name, key) => {
    expect(proposalFromRepositoryUrl(url)).toEqual({ name, key });
  });

  it('proposes, for any text at all, a key the server accepts or no key', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.string({ unit: 'binary' }), repositoryAddress),
        (url) => {
          const { name, key } = proposalFromRepositoryUrl(url);
          expect(
            acceptedOrEmpty(key),
            `key ${JSON.stringify(key)} from ${JSON.stringify(url)}`,
          ).toBe(true);
          // The key is the name's, and proposing again from a key changes nothing.
          expect(key).toBe(projectKeyOf(name));
          expect(projectKeyOf(key)).toBe(key);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it('proposes a non-empty name from every address whose last segment has a letter', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('https://gitlab.com/', 'git@gitlab.com:', 'file:///srv/'),
        fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/),
        (prefix, repository) => {
          expect(repositoryNameOf(`${prefix}group/${repository}.git`)).toBe(repository);
          expect(keySchema.safeParse(projectKeyOf(repository)).success).toBe(true);
        },
      ),
    );
  });
});

describe('the step-1 draft', () => {
  const untouched = { name: false, key: false };

  it('proposes the name and key from the URL, and never a default branch', () => {
    const draft = draftWithRepositoryUrl(
      EMPTY_PROJECT_DRAFT,
      untouched,
      'https://gitlab.com/autix/autix-core.git',
    );
    expect(draft).toEqual({
      repoUrl: 'https://gitlab.com/autix/autix-core.git',
      name: 'autix-core',
      key: 'autix_core',
      defaultBranch: '',
    });
    // A branch somebody typed survives a URL change too.
    expect(
      draftWithRepositoryUrl({ ...draft, defaultBranch: 'develop' }, untouched, 'git@x:a/b.git')
        .defaultBranch,
    ).toBe('develop');
  });

  it('proposes again while nothing was edited, so the last URL wins', () => {
    const first = draftWithRepositoryUrl(EMPTY_PROJECT_DRAFT, untouched, 'https://h/a/first.git');
    const second = draftWithRepositoryUrl(first, untouched, 'https://h/a/second-one.git');
    expect([second.name, second.key]).toEqual(['second-one', 'second_one']);
  });

  it('never overwrites an edited name; an unedited key follows the edited name', () => {
    const proposed = draftWithRepositoryUrl(EMPTY_PROJECT_DRAFT, untouched, 'https://h/a/b.git');
    const named = draftWithName(proposed, untouched, 'Autix Core');
    expect([named.name, named.key]).toEqual(['Autix Core', 'autix_core']);
    const moved = draftWithRepositoryUrl(
      named,
      { name: true, key: false },
      'https://h/a/elsewhere.git',
    );
    expect([moved.name, moved.key]).toEqual(['Autix Core', 'autix_core']);
    // Even emptied, an edited name stays the person's.
    const emptied = draftWithRepositoryUrl(
      { ...named, name: '' },
      { name: true, key: false },
      'https://h/a/x.git',
    );
    expect(emptied.name).toBe('');
  });

  it('never overwrites an edited key, from a URL change or a name change', () => {
    const edited = { name: false, key: true };
    const start = { ...EMPTY_PROJECT_DRAFT, key: 'core' };
    const moved = draftWithRepositoryUrl(start, edited, 'https://h/a/autix-core.git');
    expect([moved.name, moved.key]).toEqual(['autix-core', 'core']);
    expect(draftWithName(moved, { name: true, key: true }, 'Something else').key).toBe('core');
  });
});
