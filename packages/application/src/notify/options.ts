/**
 * What the notification band needs beyond the pipeline's own options (WP-32).
 *
 * Every field is **required** rather than optional. An optional store would be a store
 * nothing supplies in production (standing rule 31's shape), and an optional timezone would default
 * to something — and the only two candidates are UTC, which silently moves every digest for an
 * organisation that is not in it, and the host's, which is what the `Jobs` port already refuses for
 * a cron schedule: *"a schedule that means 09:00 has to say whose 09:00"*.
 */

import type { OrganisationIntegrationsPort } from '../pipeline/integrations.js';
import type { PipelineSagaOptions } from '../pipeline/saga.js';
import type { HeldConnectionLiveness } from '../ports/integrations/inbound-connection.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import type { NotificationStore } from './ports.js';

export interface NotifyOptions extends PipelineSagaOptions {
  readonly unitOfWork: UnitOfWork;
  readonly notifications: NotificationStore;
  /** The organisation's IANA zone, seeded from `TZ` (Q38). Never the host's. */
  readonly timezone: string;
  /**
   * The organisation's own chat account, for the notification that has no project — an
   * organisation budget (WP-65, PROGRESS backlog 80). Required for the reason the other two are: a
   * process that composed the band without it would decide an organisation-scoped notification and
   * have nowhere to deliver it, which is the silence backlog 80 is about.
   */
  readonly organisation: OrganisationIntegrationsPort;
  /**
   * Whether any process holds a chat account's inbound connection now (WP-72, PROGRESS backlog
   * 200) — asked before an approval is posted with buttons over a held transport. Required for the
   * reason the others are: a band composed without it could only answer from the configuration,
   * which is the dead control backlog 200 is about.
   */
  readonly heldConnections: Pick<HeldConnectionLiveness, 'isHeld'>;
}
