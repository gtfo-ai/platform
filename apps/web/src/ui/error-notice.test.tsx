/**
 * **`ErrorNotice` is hidden by the error's type, never by its text** — WP-167 ruling (b), PROGRESS
 * backlog 524.
 *
 * The platform-updated sentence is a fixed string the API client writes, but an `ApiError`'s
 * message is the server's problem-document text, which can quote what a caller or a provider sent.
 * So a notice whose text merely *contains* the sentence is an ordinary failure and is shown; only a
 * `PlatformUpdatedError` — which the client throws after `/api/version` named another build — is
 * left to the shell's banner. The whole-application half (banner shown, no error text) is
 * `apps/web/src/app/platform-updated.test.tsx`.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ApiError,
  NetworkError,
  PLATFORM_UPDATED_MESSAGE,
  PlatformUpdatedError,
} from '../api/http.js';
import { ErrorNotice } from './kit.js';

afterEach(() => {
  cleanup();
});

/** A server message that carries the platform's sentence inside untrusted text. */
const UNTRUSTED = `field "name" rejected: ${PLATFORM_UPDATED_MESSAGE}`;

describe('ErrorNotice (WP-167)', () => {
  it('renders an ApiError whose message contains the platform-updated sentence', () => {
    const { container } = render(
      <ErrorNotice title="The dial was not saved." error={new ApiError(400, 'bad', UNTRUSTED)} />,
    );
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('The dial was not saved.');
    expect(alert?.textContent).toContain(UNTRUSTED);
  });

  it('renders the sentence when it is the text of the title or the detail', () => {
    const { container } = render(
      <ErrorNotice title={PLATFORM_UPDATED_MESSAGE} detail={PLATFORM_UPDATED_MESSAGE} />,
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      PLATFORM_UPDATED_MESSAGE,
    );
  });

  it('renders nothing for a PlatformUpdatedError, whatever the title and detail say', () => {
    const { container } = render(
      <ErrorNotice
        title="Task could not be loaded."
        detail="x"
        error={new PlatformUpdatedError(200)}
      />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('says the error from its fields, and an explicit detail in its place', () => {
    const error = new ApiError(503, 'unavailable', 'the server is busy');
    const own = render(<ErrorNotice title="t" error={error} />);
    expect(visibleText(own.container)).toContain(
      'The server could not do this right now. Try again in a moment.',
    );
    own.unmount();
    const explicit = render(<ErrorNotice title="t" error={error} detail="said instead" />);
    expect(visibleText(explicit.container)).toContain('said instead');
    expect(visibleText(explicit.container)).not.toContain('the server is busy');
  });
});

/** The notice's text outside any `<details>` — what a person reads without opening anything. */
const visibleText = (root: HTMLElement): string => {
  const copy = root.cloneNode(true) as HTMLElement;
  for (const details of copy.querySelectorAll('details')) {
    details.remove();
  }
  return copy.textContent ?? '';
};

/** The text inside the notice's collapsed *Technical details*. */
const technicalText = (root: HTMLElement): string | null => {
  const details = root.querySelector('details');
  return details === null || details.open
    ? null
    : details.querySelector('summary')?.textContent === 'Technical details'
      ? (details.textContent ?? '')
      : null;
};

/**
 * **A server's text is a diagnostic** (S-23.22, the final UX audit's item 2): the visible sentence is
 * built from the error's code, status and paths, and the problem document's `message` — API paths,
 * ids, row names — is shown only inside a collapsed *Technical details*.
 */
describe('ErrorNotice keeps the server’s text behind Technical details (S-23.22)', () => {
  const SERVER =
    'integration 00000000-0000-4000-8000-00000000a100 has configuration that provider "jira"\'s schema refuses at: base_url (Invalid URL). Every binding load fails until it is corrected with PATCH /api/integrations/00000000-0000-4000-8000-00000000a100';

  it('names the invalid settings from the paths, and the message only in the details', () => {
    const error = new ApiError(400, 'invalid_integration_config', SERVER, [
      { path: 'config.base_url', message: 'Invalid URL' },
      { path: 'config.project_key', message: 'Required' },
    ]);
    const { container } = render(
      <ErrorNotice title="The integration was not saved." error={error} />,
    );
    expect(visibleText(container)).toContain('Some settings are invalid: Base URL, Project key.');
    expect(visibleText(container)).not.toContain('/api/');
    expect(visibleText(container)).not.toContain('00000000-0000-4000');
    expect(technicalText(container)).toContain(SERVER);
  });

  it.each([
    [
      new ApiError(403, 'forbidden', 'role member may not perform task.cancel'),
      'Your role does not allow this.',
    ],
    [
      new ApiError(409, 'illegal_transition', 'task in state merged cannot cancel'),
      'This is not possible in the state it is in now.',
    ],
    [new ApiError(404, 'not_found', 'no task 1f'), 'It was not found.'],
    [new ApiError(409, 'some_new_code', 'x'), 'This is not possible in the state it is in now.'],
    // Review of PR #51: these read only the status's sentence before.
    [
      new ApiError(400, 'missing_secret', 'JIRA_TOKEN is not set'),
      'An environment variable you named is not set on the server.',
    ],
    [new ApiError(409, 'ticket_has_task', 'ACME-1 has task 1f'), 'That ticket already has a task.'],
    [
      new ApiError(409, 'discovery_in_flight', 'task 1f is running'),
      'A discovery is already running for this project.',
    ],
    [
      new ApiError(409, 'project_has_live_tasks', '3 live tasks'),
      'The project has tasks still in progress.',
    ],
    [
      new ApiError(409, 'idempotency_key_reused', 'key k1 was used for another body'),
      'This was already sent with different details.',
    ],
    [
      new ApiError(409, 'idempotency_key_in_flight', 'key k1 in flight'),
      'The same request is still being performed.',
    ],
    [
      new ApiError(400, 'invalid_body', 'body/reason must be string', [
        { path: '/reason', message: 'x' },
      ]),
      'Some fields are invalid: Reason.',
    ],
  ])('says %s plainly', (error, sentence) => {
    const { container } = render(<ErrorNotice title="That command was refused." error={error} />);
    expect(visibleText(container)).toContain(sentence);
    expect(visibleText(container)).not.toContain(error.message);
    expect(technicalText(container)).toContain(error.message);
  });

  it('keeps the client’s own sentences visible, with no details to open', () => {
    const { container } = render(
      <ErrorNotice
        title="t"
        error={new ApiError(409, 'idempotency_attempt_unknown', 'Check the task first.')}
      />,
    );
    expect(visibleText(container)).toContain('Check the task first.');
    expect(container.querySelector('details')).toBeNull();
  });

  it('says a network failure as itself, and anything else as something that went wrong', () => {
    const network = render(<ErrorNotice title="t" error={new NetworkError(new Error('x'))} />);
    expect(visibleText(network.container)).toContain('The server could not be reached.');
    network.unmount();
    const other = render(<ErrorNotice title="t" error={new Error('boom at line 3')} />);
    expect(visibleText(other.container)).toContain('Something went wrong.');
    expect(technicalText(other.container)).toContain('boom at line 3');
  });
});
