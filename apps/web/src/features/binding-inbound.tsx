/**
 * **Does this binding hear its tracker or git host by webhook?** (BACKLOG 1610) — one line under
 * each bound integration in the project's Connections.
 *
 * A Jira binding with no webhook secret hears a person's status or assignee change only at its
 * next poll, and nothing on the screen said so. The server answers two facts
 * (`ProjectBindingSummary.inbound`): whether a webhook can be verified, and when the last one
 * arrived — never counting a poll's own record. This component says them in plain words with the
 * setup guide one click away; a binding whose provider has no webhook door shows nothing.
 */
import {
  BINDING_WEBHOOK_LOOKBACK_DAYS,
  type ProjectBindingInbound,
  type ProjectBindingSummary,
} from '@platform/contracts';
import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { Badge, type BadgeTone, formatDateTime } from '../ui/kit.js';

/** The setup guide's step that registers the webhook, by provider (its own heading's number). */
const WEBHOOK_STEP: Readonly<Record<string, string>> = {
  'jira-cloud': 'step 4',
  gitlab: 'step 3',
};

/** What a webhook from the provider carries, in a person's words; an unknown one says "changes". */
const CHANGES_WORD: Readonly<Record<string, string>> = {
  'jira-cloud': 'a status or assignee change',
  gitlab: 'a merge request opened, merged or closed, or a review note',
};

/** The provider's name in a sentence; an unknown provider is "the provider", never its id. */
const PROVIDER_WORD: Readonly<Record<string, string>> = {
  'jira-cloud': 'Jira',
  gitlab: 'GitLab',
};

export interface InboundWords {
  readonly badge: string;
  readonly tone: BadgeTone;
  readonly sentence: string;
  /** Whether the line ends with the setup guide's webhook step. */
  readonly guide: boolean;
}

/** The words for one binding's `inbound` — pure, so each state is a unit case. */
export const inboundWords = (provider: string, inbound: ProjectBindingInbound): InboundWords => {
  const word = PROVIDER_WORD[provider] ?? 'the provider';
  if (inbound.webhook_secret === 'unreadable') {
    return {
      badge: 'Webhook unknown',
      tone: 'warning',
      sentence: `Whether ${word} can send webhooks here cannot be told: this integration’s stored credentials cannot be read.`,
      guide: false,
    };
  }
  if (inbound.webhook_secret === 'not_configured') {
    return {
      badge: 'Poll only',
      tone: 'warning',
      sentence: `Changes made in ${word} — ${CHANGES_WORD[provider] ?? 'any change'} — reach the platform only at the next poll. Register the webhook and they arrive within seconds.`,
      guide: true,
    };
  }
  if (inbound.last_webhook_at === null) {
    return {
      badge: 'Webhook set up',
      tone: 'neutral',
      sentence: `A webhook secret is set, but no webhook from ${word} has arrived in the last ${BINDING_WEBHOOK_LOOKBACK_DAYS} days — check that the webhook in ${word} points here and sends its events.`,
      guide: true,
    };
  }
  return {
    badge: 'Webhook',
    tone: 'success',
    sentence: `Changes in ${word} arrive within seconds. Last webhook ${formatDateTime(inbound.last_webhook_at)}.`,
    guide: false,
  };
};

export const BindingInboundStatus = ({
  binding,
}: {
  readonly binding: ProjectBindingSummary;
}): ReactElement | null => {
  if (binding.inbound === undefined) {
    return null;
  }
  const words = inboundWords(binding.provider, binding.inbound);
  const step = WEBHOOK_STEP[binding.provider];
  return (
    <span className="flex flex-wrap items-center gap-1 text-xs text-fg-muted" data-binding-inbound>
      <Badge tone={words.tone}>{words.badge}</Badge>
      <span>{words.sentence}</span>
      {words.guide ? (
        <Link
          to="/integrations/$integrationId"
          params={{ integrationId: binding.integration_id }}
          search={{ tab: 'setup-guide' }}
        >
          {step === undefined ? 'Setup guide' : `Setup guide, ${step}`}
        </Link>
      ) : null}
    </span>
  );
};
