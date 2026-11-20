/**
 * BACKLOG 1610: the four states of a binding's `inbound`, in words — each state's own sentence,
 * and the setup guide offered exactly where a person has something to set up.
 */
import { describe, expect, it } from 'vitest';
import { inboundWords } from './binding-inbound.js';

describe('inboundWords', () => {
  it('says a poll-only Jira binding hears changes at the next poll, and offers the guide', () => {
    const words = inboundWords('jira-cloud', {
      webhook_secret: 'not_configured',
      last_webhook_at: null,
    });
    expect(words).toMatchObject({ badge: 'Poll only', tone: 'warning', guide: true });
    expect(words.sentence).toContain('Changes made in Jira — a status or assignee change —');
  });

  it('says what a GitLab webhook carries, in GitLab’s own terms', () => {
    const words = inboundWords('gitlab', {
      webhook_secret: 'not_configured',
      last_webhook_at: null,
    });
    expect(words.sentence).toContain(
      'Changes made in GitLab — a merge request opened, merged or closed, or a review note —',
    );
    expect(words.sentence).not.toContain('assignee');
  });

  it('says a configured webhook that never arrived should be checked, and offers the guide', () => {
    const words = inboundWords('gitlab', { webhook_secret: 'configured', last_webhook_at: null });
    expect(words).toMatchObject({ badge: 'Webhook set up', guide: true });
    expect(words.sentence).toContain('no webhook from GitLab has arrived in the last 90 days');
  });

  it('names the last webhook and offers nothing when it works', () => {
    const words = inboundWords('jira-cloud', {
      webhook_secret: 'configured',
      last_webhook_at: '2026-09-13T04:00:00.000Z',
    });
    expect(words).toMatchObject({ badge: 'Webhook', tone: 'success', guide: false });
    expect(words.sentence).toContain('Last webhook ');
  });

  it('does not guess when the credentials cannot be read', () => {
    const words = inboundWords('jira-cloud', {
      webhook_secret: 'unreadable',
      last_webhook_at: '2026-09-13T04:00:00.000Z',
    });
    expect(words).toMatchObject({ badge: 'Webhook unknown', guide: false });
    expect(words.sentence).not.toContain('Poll only');
  });

  it('never names a provider by its id', () => {
    const words = inboundWords('acme-tracker', {
      webhook_secret: 'not_configured',
      last_webhook_at: null,
    });
    expect(words.sentence).toContain('the provider');
    expect(words.sentence).not.toContain('acme-tracker');
  });
});
