/**
 * **Which platform this worker serves, in its header** — S-29.1, TD-031's 2026-11-24 amendment,
 * decision 9 item 4. The label (`APP_WORKER_LABEL` > the platform's name > its host), the core's
 * host and the port this page answers on — each a text node — on the room's header and the
 * wizard's alike, so two workers on one machine are told apart on every screen. And the tab title,
 * `<label> — worker`, set as text; `worker.html`'s static title is the fallback.
 */
import type { WorkerLocalIdentity } from '@platform/contracts';
import type { ReactElement } from 'react';
import { UntrustedText } from '../ui/untrusted.js';

/** The tab title for a label, or `null` to leave `worker.html`'s own. */
export const pageTitleOf = (identity: WorkerLocalIdentity | null | undefined): string | null =>
  identity == null ? null : `${identity.label} — worker`;

/** The port this page answers on (`location.port`), `''` outside a browser. */
export const currentPagePort = (): string =>
  typeof window === 'undefined' ? '' : window.location.port;

export const PlatformBadge = ({
  identity,
  port,
}: {
  identity: WorkerLocalIdentity;
  port: string;
}): ReactElement => (
  <p data-platform-badge="" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
    <span
      data-platform-label=""
      className="rounded-md border border-line bg-surface px-2 py-0.5 font-semibold text-fg"
    >
      <UntrustedText value={identity.label} />
    </span>
    {identity.core_host === null ? null : (
      <span data-platform-host="" className="text-fg-muted">
        <UntrustedText value={identity.core_host} />
      </span>
    )}
    {port === '' ? null : (
      <span data-page-port="" className="text-fg-muted">{`this page on port ${port}`}</span>
    )}
  </p>
);
