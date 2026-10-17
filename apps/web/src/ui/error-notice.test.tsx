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
import { ApiError, PLATFORM_UPDATED_MESSAGE, PlatformUpdatedError } from '../api/http.js';
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

  it('shows the error’s own text as the detail, and an explicit detail in its place', () => {
    const error = new ApiError(503, 'unavailable', 'the server is busy');
    const own = render(<ErrorNotice title="t" error={error} />);
    expect(own.container.textContent).toContain(String(error));
    own.unmount();
    const explicit = render(<ErrorNotice title="t" error={error} detail="said instead" />);
    expect(explicit.container.textContent).toContain('said instead');
    expect(explicit.container.textContent).not.toContain('the server is busy');
  });
});
