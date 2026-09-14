/**
 * What the notification band needs beyond the pipeline's own options (WP-32).
 *
 * Two fields, and both are **required** rather than optional. An optional store would be a store
 * nothing supplies in production (standing rule 31's shape), and an optional timezone would default
 * to something — and the only two candidates are UTC, which silently moves every digest for an
 * organisation that is not in it, and the host's, which is what the `Jobs` port already refuses for
 * a cron schedule: *"a schedule that means 09:00 has to say whose 09:00"*.
 */

import type { PipelineSagaOptions } from '../pipeline/saga.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import type { NotificationStore } from './ports.js';

export interface NotifyOptions extends PipelineSagaOptions {
  readonly unitOfWork: UnitOfWork;
  readonly notifications: NotificationStore;
  /** The organisation's IANA zone, seeded from `TZ` (Q38). Never the host's. */
  readonly timezone: string;
}
