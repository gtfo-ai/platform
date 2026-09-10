import { describe, expect, it } from 'vitest';
import { EGRESS_PORT, egressFilterPattern, egressProxyUrl, renderEgressConfig } from './egress.js';

/**
 * The rendered filter line, compiled with JavaScript's regular expressions.
 *
 * This is a **model** of tinyproxy's POSIX ERE, not the binary — see the module docblock. What it
 * can settle is whether the *pattern* discriminates, which is the half that lives in this
 * repository; whether tinyproxy applies it to the CONNECT host is WP-22's, with the image.
 */
const matches = (pattern: string, host: string): boolean => new RegExp(pattern, 'i').test(host);

describe('egress allow-list', () => {
  it('anchors and escapes every host', () => {
    expect(egressFilterPattern('gitlab.example.com')).toBe(String.raw`^gitlab\.example\.com$`);
  });

  it('matches the host it was written for', () => {
    // Standing rule 42: the negatives below prove nothing without this. A filter that refused
    // everything would pass every one of them.
    expect(matches(egressFilterPattern('gitlab.example.com'), 'gitlab.example.com')).toBe(true);
    expect(matches(egressFilterPattern('gitlab.example.com'), 'GitLab.Example.COM')).toBe(true);
  });

  /**
   * Standing rule 43, and the third time this shape has appeared in this session. `evil.example.com`
   * is refused by an unanchored pattern, by `endsWith`, by `includes` and by exact matching alike,
   * so it discriminates nothing. Each of these separates one wrong implementation from the right
   * one, and is named for the one it separates.
   */
  it.each([
    ['a prefixed host, which an unanchored pattern and endsWith admit', 'evil-gitlab.example.com'],
    [
      'a suffixed host, which an unanchored pattern and startsWith admit',
      'gitlab.example.com.evil.test',
    ],
    ['a host containing the name, which includes() admits', 'x.gitlab.example.com.y'],
    ['a subdomain, which a suffix match admits', 'pages.gitlab.example.com'],
    ['a host with an unescaped-dot wildcard match', 'gitlabXexample.com'],
    ['the trailing-dot spelling, which a normalising match admits', 'gitlab.example.com.'],
  ])('refuses %s', (_label, host) => {
    expect(matches(egressFilterPattern('gitlab.example.com'), host)).toBe(false);
  });

  it('refuses to render a host that is not a DNS name', () => {
    // Unreachable through `create` — the spec schema validates first — and kept because this
    // function's output *is* a security rule: a caller reaching it another way must not be able to
    // put a regular expression into the filter file. Standing rule 22: named, not silently dead.
    expect(() => egressFilterPattern('.*')).toThrow(/not a DNS host name/);
    expect(() => egressFilterPattern('gitlab.example.com:443')).toThrow(/not a DNS host name/);
    expect(() => egressFilterPattern('https://gitlab.example.com')).toThrow(/not a DNS host name/);
  });
});

describe('rendered tinyproxy configuration', () => {
  const rendered = renderEgressConfig({
    hosts: ['registry.npmjs.org', 'api.anthropic.com', 'registry.npmjs.org'],
    connectPorts: [443, 443],
  });

  it('denies by default and matches the host rather than the URL', () => {
    expect(rendered.config).toContain('FilterDefaultDeny Yes');
    expect(rendered.config).toContain('FilterURLs Off');
    expect(rendered.config).toContain('FilterExtended On');
  });

  it('bounds the ports CONNECT may name', () => {
    // Without a `ConnectPort` line tinyproxy tunnels CONNECT to any port, which turns an HTTPS
    // allow-list into a general TCP relay for the allowed hosts.
    expect(rendered.config).toContain('ConnectPort 443');
    expect(rendered.config.match(/ConnectPort/g)).toHaveLength(1);
  });

  it('deduplicates and sorts, so two equal specs render one file', () => {
    expect(rendered.filter.trim().split('\n')).toEqual([
      String.raw`^api\.anthropic\.com$`,
      String.raw`^registry\.npmjs\.org$`,
    ]);
  });

  it('renders an empty filter for a spec that allows nothing, which denies everything', () => {
    const empty = renderEgressConfig({ hosts: [], connectPorts: [443] });
    expect(empty.filter).toBe('\n');
    expect(empty.config).toContain('FilterDefaultDeny Yes');
  });

  it('refuses a spec with no CONNECT port at all', () => {
    expect(() => renderEgressConfig({ hosts: ['a.example.com'], connectPorts: [] })).toThrow(
      /no CONNECT port/,
    );
  });

  it('points the workspace at the sidecar by name on the internal network', () => {
    expect(egressProxyUrl('egress-1')).toBe(`http://egress-1:${EGRESS_PORT}`);
  });
});
