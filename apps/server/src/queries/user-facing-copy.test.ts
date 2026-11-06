/**
 * **Server text a screen shows as it is, in plain words** (S-23.22, the final UX audit's item 2).
 *
 * Most of what the server writes — a problem document's `message`, a refusal's reason — is a
 * diagnostic, and the web app shows it only behind *Technical details*. A few sentences are written
 * *for* a screen and rendered there verbatim; those are listed here and held to the web side's rule
 * (`apps/web/src/spec-reference-census.test.ts`, `apps/web/src/admin-names-census.test.ts`): no spec
 * reference, no environment variable, no `.agentic/` path, no API path, no id, no table row.
 *
 * **The list is by hand, and says so**: a new user-facing constant is added here when it is written.
 * The patterns are the web censuses' own, restated because a server test may not import a web file.
 */
import { SHIPPED_PROVIDERS } from '@platform/integrations';
import { describe, expect, it } from 'vitest';
import { ORGANISATION_ACCOUNT_UNREADABLE_CONSEQUENCE } from './integration-queries.js';

/** Every server sentence a screen renders verbatim, by name. */
const USER_FACING: Readonly<Record<string, string>> = {
  ORGANISATION_ACCOUNT_UNREADABLE_CONSEQUENCE,
  // S-25.3: what a project uses an integration for — `used_by[].uses[].label`, shown as it is.
  ...Object.fromEntries(
    SHIPPED_PROVIDERS.flatMap((provider) =>
      provider.usageFields.map((usage) => [`${provider.id} use: ${usage.field}`, usage.label]),
    ),
  ),
};

const FORBIDDEN: readonly (readonly [string, RegExp])[] = [
  ['a spec reference', /\b(?:BD|TD|WP|Q)-?\d+\b|product\/\d+|technical\/\d+|PROGRESS/],
  ['an environment variable', /\bAPP_[A-Z0-9_]+|(?<![A-Za-z0-9])_FILE\b/],
  ['a repository path', /\.agentic\//],
  ['an API path', /\/api\//],
  ['an id', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ['a table row or a sealing word', /\bsecrets row\b|\bdecrypt|\bre-?seal/i],
];

describe('server sentences a screen shows verbatim are plain words (S-23.22)', () => {
  it.each(Object.entries(USER_FACING))('%s', (_name, text) => {
    const found = FORBIDDEN.filter(([, pattern]) => pattern.test(text)).map(([what]) => what);
    expect(found).toEqual([]);
  });

  it.each(FORBIDDEN)('the check sees %s', (what, pattern) => {
    // Calibration: each pattern refuses the old sentence's kind of text.
    const planted = {
      'a spec reference': 'see WP-157',
      'an environment variable': 'a changed APP_SECRET_KEY',
      'a repository path': 'none of .agentic/prompts/',
      'an API path': 'PATCH /api/integrations/x',
      'an id': 'integration 00000000-0000-4000-8000-00000000a358',
      'a table row or a sealing word': 'a damaged secrets row',
    }[what];
    expect(pattern.test(planted ?? '')).toBe(true);
  });
});
