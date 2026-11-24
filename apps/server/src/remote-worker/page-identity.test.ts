/**
 * **Which platform the page serves** (S-29.1, TD-031's 2026-11-24 amendment, decision 9 item 4):
 * the label's order, and the tab icon generated from it — one `[A-Z0-9]` of the label at most, the
 * label's hue, and nothing else of it in the SVG, whatever the label holds.
 */
import { describe, expect, it } from 'vitest';
import {
  faviconCharacterOf,
  faviconSvgOf,
  hueOf,
  type PageIdentity,
  pageIdentityOf,
} from './page-identity.js';

describe('the page’s label (S-29.1)', () => {
  it('is APP_WORKER_LABEL first, then the platform’s name, then the host’s slug', () => {
    const core = 'https://agentic.fontai.org';
    expect(
      pageIdentityOf({ environmentLabel: 'Mine', platformName: 'FontAI', coreUrl: core }),
    ).toEqual<PageIdentity>({
      label: 'Mine',
      source: 'environment',
      core_host: 'agentic.fontai.org',
    });
    expect(
      pageIdentityOf({ environmentLabel: null, platformName: 'FontAI', coreUrl: core }),
    ).toEqual<PageIdentity>({
      label: 'FontAI',
      source: 'platform',
      core_host: 'agentic.fontai.org',
    });
    expect(
      pageIdentityOf({ environmentLabel: null, platformName: null, coreUrl: core }),
    ).toEqual<PageIdentity>({ label: 'fontai', source: 'host', core_host: 'agentic.fontai.org' });
    // The port is part of the host the header names.
    expect(
      pageIdentityOf({
        environmentLabel: null,
        platformName: null,
        coreUrl: 'http://localhost:8080',
      }),
    ).toEqual<PageIdentity>({ label: 'localhost', source: 'host', core_host: 'localhost:8080' });
  });

  it('says a person’s label before a platform is chosen, and nothing without either', () => {
    expect(
      pageIdentityOf({ environmentLabel: 'Mine', platformName: null, coreUrl: null }),
    ).toEqual<PageIdentity>({ label: 'Mine', source: 'environment', core_host: null });
    expect(pageIdentityOf({ environmentLabel: null, platformName: 'x', coreUrl: null })).toBeNull();
  });

  it('falls back to the whole host name when no label of it survives the slug', () => {
    expect(
      pageIdentityOf({
        environmentLabel: null,
        platformName: null,
        coreUrl: 'https://agentic.www',
      }),
    ).toEqual<PageIdentity>({ label: 'agentic.www', source: 'host', core_host: 'agentic.www' });
  });
});

describe('the generated tab icon (S-29.1)', () => {
  /** Every character the label carries besides the one the icon may show. */
  const HOSTILE = '<script>alert(1)</script>"\' onload="x" & 🚀 ]]> <!--';

  it('shows the first [A-Za-z0-9] uppercased, and no other character of the label', () => {
    const label = `${HOSTILE} zeta`;
    expect(faviconCharacterOf(label)).toBe('S');
    const svg = faviconSvgOf(label);
    expect(svg).toContain('>S</text>');
    // Nothing else of the label: no markup it carried, no quote, no emoji, no other letter of it.
    for (const fragment of ['<script', 'alert', 'onload', '🚀', ']]>', '<!--', '&', 'zeta', "'"]) {
      expect(svg, fragment).not.toContain(fragment);
    }
    // Exactly one <text>, and its body is the one character.
    expect([...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((match) => match[1])).toEqual([
      'S',
    ]);
    // No script, no link, no style, no handler: presentation attributes only.
    expect(svg).not.toMatch(/<script|href|xlink|style=|\son[a-z]+=/i);
  });

  it('draws no character at all for a label without one', () => {
    for (const label of ['🚀🚀', '<>"\'&', '株式会社', 'Ž']) {
      expect(faviconCharacterOf(label), label).toBeNull();
      const svg = faviconSvgOf(label);
      expect(svg, label).not.toContain('<text');
      expect(svg, label).not.toContain(label);
    }
  });

  it('gives one label one hue, and the hue is the label’s, not the character’s', () => {
    expect(hueOf('Autix')).toBe(hueOf('Autix'));
    expect(faviconSvgOf('Autix')).toBe(faviconSvgOf('Autix'));
    expect(faviconSvgOf('Autix')).toContain(`hsl(${hueOf('Autix')}, 55%, 38%)`);
    // Same first letter, different labels: the colour tells them apart (these two differ).
    const hues = new Set(['Autix', 'Acme', 'Alpha', 'Atlas', 'Aurora'].map(hueOf));
    expect(hues.size).toBeGreaterThan(1);
    for (const hue of hues) {
      expect(Number.isInteger(hue) && hue >= 0 && hue < 360).toBe(true);
    }
  });
});
