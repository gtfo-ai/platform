/**
 * The egress policy's own decisions (WP-51, PROGRESS backlog 48; technical/10 unit tier).
 *
 * The module is a pure function of two inputs, so this file is where the **discriminating** cases
 * live and the executor's and the route's tests only have to prove that they consult it.
 *
 * Standing rule 43 shapes the negatives: `evil.example.com` is refused by every candidate
 * implementation — substring, suffix, exact — and therefore proves nothing on its own. The cases
 * that separate them are the *adjacent* ones, and they are the same three
 * `renderEgressConfig`'s pattern tests use for the run container's sidecar, deliberately, so the
 * platform's two allow-lists are argued from one set of examples:
 *
 *  - `evil-gitlab.example.com` — passes a naive `endsWith` on nothing, but passes `includes`;
 *  - `gitlab.example.com.evil.test` — passes `includes` and a naive `startsWith`;
 *  - `xgitlab.example.com` — passes `includes`;
 *  - `gitlab.example.com.` — the trailing dot DNS treats as the same name.
 *
 * Rule 42 is the other half: every case is asserted at the boundary **and one past it**, so a
 * declared host is admitted in the same test run in which its neighbour is refused. A file that
 * only refused would pass with `check: () => refused`.
 */
import { describe, expect, it } from 'vitest';
import {
  ALLOW_ANY_HOST,
  allowAnyIntegrationHost,
  createIntegrationEgressPolicy,
  egressHostOf,
  INTEGRATION_HOSTS_SETTING,
} from './egress.js';

const DECLARED = 'gitlab.example.com';

describe('createIntegrationEgressPolicy', () => {
  const policy = createIntegrationEgressPolicy([DECLARED, 'acme.atlassian.net']);

  it('admits a declared host', () => {
    const verdict = policy.check(`https://${DECLARED}`);

    expect(verdict).toEqual({ allowed: true, host: DECLARED });
  });

  it('admits a declared host on any port and any path, because neither is part of the decision', () => {
    // Stated at the line in the module: a port allow-list would be a second list to keep in step,
    // and Loki's documented deployment is `https://loki.example.test:3100`.
    expect(policy.check(`https://${DECLARED}:8443/api/v4`).allowed).toBe(true);
  });

  it.each([
    ['a hyphen-prefixed neighbour', 'evil-gitlab.example.com'],
    ['a suffixed neighbour', 'gitlab.example.com.evil.test'],
    ['a prefixed neighbour', 'xgitlab.example.com'],
    ['a subdomain of the declared host', 'api.gitlab.example.com'],
    ['a parent of the declared host', 'example.com'],
    ['an unrelated host', 'evil.example.com'],
  ])('refuses %s', (_name, host) => {
    const verdict = policy.check(`https://${host}`);

    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toBe('host_not_declared');
    expect(verdict.allowed === false && verdict.host).toBe(host);
  });

  it('names the refused host and the setting, and nothing else', () => {
    const verdict = policy.check('https://evil-gitlab.example.com/secret-path?token=x');

    expect(verdict.allowed).toBe(false);
    const message = verdict.allowed === false ? verdict.message : '';
    expect(message).toContain('evil-gitlab.example.com');
    expect(message).toContain(INTEGRATION_HOSTS_SETTING);
    // The declared list is quoted so an operator can see what they *did* declare; the caller's own
    // URL is not, because a config document is a place somebody may paste a credential.
    expect(message).toContain(DECLARED);
    expect(message).not.toContain('secret-path');
    expect(message).not.toContain('token=x');
  });

  it('treats case and one trailing dot as the same name, in both directions', () => {
    expect(policy.check(`HTTPS://GITLAB.EXAMPLE.COM`).allowed).toBe(true);
    expect(policy.check(`https://${DECLARED}.`).allowed).toBe(true);
    // And the declaration may carry them too, so an operator's spelling cannot silently miss.
    const shouty = createIntegrationEgressPolicy(['GitLab.Example.Com.']);
    expect(shouty.check(`https://${DECLARED}`).allowed).toBe(true);
    expect(shouty.check('https://evil-gitlab.example.com').allowed).toBe(false);
  });

  it.each([
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/html,<script>x</script>'],
    ['vbscript', 'vbscript:msgbox(1)'],
    ['file', 'file:///etc/passwd'],
    ['ftp', 'ftp://gitlab.example.com/x'],
  ])('refuses the %s scheme even when the host would be declared', (_name, url) => {
    // Q49: `z.url()` accepts the first four. The five provider schemas now use `httpUrlSchema`, and
    // this is the second layer — for a row written by `psql` and for a provider that forgets.
    const verdict = createIntegrationEgressPolicy([DECLARED, 'localhost']).check(url);

    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toBe('scheme_not_permitted');
  });

  it('admits http as well as https, because a self-hosted Loki on a private network is real', () => {
    expect(
      createIntegrationEgressPolicy(['loki.example.test']).check('http://loki.example.test:3100')
        .allowed,
    ).toBe(true);
  });

  it.each([
    ['a relative path', '/api/v4/projects'],
    ['a bare host', 'gitlab.example.com'],
    ['empty', ''],
  ])('refuses %s as not a URL, without inventing a host for it', (_name, value) => {
    const verdict = policy.check(value);

    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toBe('not_a_url');
    expect(verdict.allowed === false && verdict.host).toBeNull();
  });

  describe('the empty list', () => {
    const closed = createIntegrationEgressPolicy([]);

    it('refuses everything, which is rule 18: an empty allow-list is the closed one', () => {
      expect(closed.check(`https://${DECLARED}`).allowed).toBe(false);
      expect(closed.check('https://registry.npmjs.org').allowed).toBe(false);
      expect(closed.open).toBe(false);
    });

    it('says so in the message rather than quoting an empty list', () => {
      const verdict = closed.check(`https://${DECLARED}`);

      expect(verdict.allowed === false && verdict.message).toContain('declared: none');
    });

    it('is what a list of nothing but blanks and commas resolves to', () => {
      // The env parser drops malformed entries, so this is what reaches here from `,, ,`.
      expect(createIntegrationEgressPolicy(['', '  ']).check(`https://${DECLARED}`).allowed).toBe(
        false,
      );
    });
  });

  describe('the declared-open list', () => {
    it('admits any host when "*" is declared', () => {
      const open = createIntegrationEgressPolicy([ALLOW_ANY_HOST]);

      expect(open.open).toBe(true);
      expect(open.check('https://anything.example.test').allowed).toBe(true);
      expect(open.check('https://evil-gitlab.example.com').allowed).toBe(true);
    });

    it('still refuses a scheme the platform does not dial', () => {
      // "Open" is a statement about *hosts*. A `file:` URL names no host to be open about, and an
      // allow-list that admitted one would turn a configuration mistake into a local file read.
      expect(allowAnyIntegrationHost().check('file:///etc/passwd').allowed).toBe(false);
    });

    it('is open even when other hosts are listed beside the wildcard', () => {
      const open = createIntegrationEgressPolicy([DECLARED, ALLOW_ANY_HOST]);

      expect(open.open).toBe(true);
      expect(open.check('https://anything.example.test').allowed).toBe(true);
    });
  });

  it('publishes the declared entries as the operator wrote them, for the boot log', () => {
    expect(createIntegrationEgressPolicy(['GitLab.Example.Com']).declared).toEqual([
      'GitLab.Example.Com',
    ]);
  });
});

describe('egressHostOf', () => {
  it.each([
    ['https://gitlab.example.com', 'gitlab.example.com'],
    ['https://GitLab.Example.Com/api/v4', 'gitlab.example.com'],
    ['https://gitlab.example.com./', 'gitlab.example.com'],
    ['http://loki.example.test:3100/loki/api/v1', 'loki.example.test'],
    // Credentials in the authority are dropped by `URL.hostname`, which is what makes GitLab's
    // `buildCloneUrl` shape (`https://token@host/…`) decidable at all.
    ['https://user:pass@gitlab.example.com/x', 'gitlab.example.com'],
    ['https://[2001:db8::1]:443/x', '[2001:db8::1]'],
  ])('reads the host of %s', (url, expected) => {
    expect(egressHostOf(url)).toBe(expected);
  });

  it.each([['not a url'], ['/relative'], [''], ['gitlab.example.com']])(
    'answers null for %s, so a config string that is not a URL is left alone',
    (value) => {
      expect(egressHostOf(value)).toBeNull();
    },
  );

  it('answers the empty string for a URL that parses but names no host', () => {
    // `new URL('file:///etc/passwd')` succeeds with an empty hostname. `egressHostOf` reports what
    // it found rather than guessing; the policy turns it into a refusal.
    expect(egressHostOf('file:///etc/passwd')).toBe('');
  });
});
