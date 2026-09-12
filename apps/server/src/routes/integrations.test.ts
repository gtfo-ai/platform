/**
 * `webhookUrlFor`, the one piece of `GET /api/integrations/:id/setup-guide` that is not a read.
 *
 * It is the URL an operator pastes into a provider's settings, so a doubled or missing slash is a
 * delivery that 404s and a webhook the vendor eventually disables. The provider id and the
 * integration id are both encoded even though the router accepts neither a slash nor a space in
 * either: the guard is at the place that builds the string, not at the place that happens to
 * validate the input today.
 */
import { describe, expect, it } from 'vitest';
import { webhookUrlFor } from './integrations.js';

const ID = '0199aa11-2b3c-7d4e-8f90-000000000001';

describe('webhookUrlFor', () => {
  it('builds the path routes/webhooks.ts registers', () => {
    expect(webhookUrlFor('https://agentic.example.test', 'gitlab', ID)).toBe(
      `https://agentic.example.test/webhooks/gitlab/${ID}`,
    );
  });

  it('does not double the slash when APP_BASE_URL carries a trailing one', () => {
    expect(webhookUrlFor('https://agentic.example.test/', 'jira-cloud', ID)).toBe(
      `https://agentic.example.test/webhooks/jira-cloud/${ID}`,
    );
    expect(webhookUrlFor('https://agentic.example.test///', 'slack', ID)).toBe(
      `https://agentic.example.test/webhooks/slack/${ID}`,
    );
  });

  it('keeps a base URL that carries a path prefix', () => {
    // One origin, possibly behind a path (technical/08). Stripping more than the trailing slash
    // would send the delivery to the wrong place.
    expect(webhookUrlFor('https://example.test/agentic', 'gitlab', ID)).toBe(
      `https://example.test/agentic/webhooks/gitlab/${ID}`,
    );
  });

  it('encodes both segments', () => {
    expect(webhookUrlFor('https://example.test', 'a b/c', 'x?y')).toBe(
      'https://example.test/webhooks/a%20b%2Fc/x%3Fy',
    );
  });
});
