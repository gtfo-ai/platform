/**
 * **Which platform this worker's page serves** — S-29.1, TD-031's 2026-11-24 amendment, decision 9
 * item 4.
 *
 * Two workers on one machine (one per core) must be told apart at a glance: the page's tab title,
 * its header and its tab icon all say the same **label**, which is, in this order:
 *
 *  1. `APP_WORKER_LABEL` — a person's own name for this install (`source: 'environment'`);
 *  2. the platform's display name, as its core last said it on the handshake (protocol 6) and kept
 *     in `worker-state` (`source: 'platform'`);
 *  3. the slug of the core's host (`agentic.fontai.org` → `fontai`, `source: 'host'`).
 *
 * The label is untrusted text twice over (a person's variable, an administrator's organisation
 * name): the page renders it as a text node and sets the tab title from it as text. The icon is the
 * one place it reaches markup, so {@link faviconSvgOf} lets **one** character of it in — the first
 * `[A-Za-z0-9]`, uppercased, or none — and a hue drawn from its SHA-256; nothing else of the label
 * enters the SVG, so nothing in it needs escaping.
 */
import { createHash } from 'node:crypto';
import { instanceNameOf } from '@platform/contracts';
import { slugOfHost } from '@platform/domain';

/** Where the label came from (decision 9 item 4's order). */
export type PageLabelSource = 'environment' | 'platform' | 'host';

export interface PageIdentity {
  readonly label: string;
  readonly source: PageLabelSource;
  /** The core's host (and port, when the URL names one), or `null` while no platform is chosen. */
  readonly core_host: string | null;
}

/** The core's host as `URL.host` spells it, or `null` for no (or no readable) address. */
const hostOf = (coreUrl: string | null): string | null => {
  if (coreUrl === null) return null;
  try {
    return new URL(coreUrl).host || null;
  } catch {
    return null;
  }
};

/**
 * The page's label and its source, or `null` when there is none to say — no `APP_WORKER_LABEL` and
 * no platform chosen yet (the wizard's first step). `environmentLabel` and `platformName` are
 * already bounded ({@link instanceNameOf}); the host's fallback is bounded here.
 */
export const pageIdentityOf = (input: {
  readonly environmentLabel: string | null;
  readonly platformName: string | null;
  readonly coreUrl: string | null;
}): PageIdentity | null => {
  const coreHost = hostOf(input.coreUrl);
  if (input.environmentLabel !== null) {
    return { label: input.environmentLabel, source: 'environment', core_host: coreHost };
  }
  if (coreHost === null) return null;
  if (input.platformName !== null) {
    return { label: input.platformName, source: 'platform', core_host: coreHost };
  }
  const hostname = new URL(input.coreUrl as string).hostname;
  const label = instanceNameOf(slugOfHost(hostname) || hostname);
  return label === null ? null : { label, source: 'host', core_host: coreHost };
};

/** The label's hue, 0–359: the first two bytes of its SHA-256 (decision 9 item 4). */
export const hueOf = (label: string): number => {
  const digest = createHash('sha256').update(label, 'utf8').digest();
  return ((digest[0] ?? 0) * 256 + (digest[1] ?? 0)) % 360;
};

/** The one character of the label the icon shows: its first `[A-Za-z0-9]`, uppercased, or `null`. */
export const faviconCharacterOf = (label: string): string | null =>
  /[A-Za-z0-9]/.exec(label)?.[0]?.toUpperCase() ?? null;

/**
 * The tab icon for `label`: a rounded square in the label's hue and, when it has one, the label's
 * first `[A-Za-z0-9]` uppercased. Built only from a number and a character from that allow-list, so
 * the SVG never carries anything else of the label (no escaping exists to get wrong). Presentation
 * attributes only, like `apps/web/public/favicon.svg` — no `style`, no script, no link.
 */
export const faviconSvgOf = (label: string): string => {
  const hue = hueOf(label);
  const character = faviconCharacterOf(label);
  const glyph =
    character === null
      ? ''
      : `\n  <text x="100" y="138" text-anchor="middle" font-family="system-ui, sans-serif" font-size="112" font-weight="700" fill="#ffffff">${character}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">\n  <rect width="200" height="200" rx="36" fill="hsl(${hue}, 55%, 38%)"/>${glyph}\n</svg>\n`;
};
