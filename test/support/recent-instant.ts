/**
 * A fixed instant for a suite that freezes its clock, taken from the wall clock rather than written
 * as a literal (ci-fix, session 21).
 *
 * The event log refuses an `occurred_at` before the start of the **previous** UTC month
 * (`assertInPartitionWindow`, technical/03), and the integration harness gives the other partitioned
 * tables only three past months (`test/integration/support/migrated.ts`). A suite whose fixed clock
 * reads `'2026-09-11T12:00:00.000Z'` therefore passes for a month or two and then fails on the 1st,
 * with nothing in the suite changed: 22 tests in three files went red on 2026-11-01 that way. A
 * suite that needs a frozen *now* takes it from here once, at module load, and writes every other
 * instant it compares as an offset from it (`addMs`), so what the suite asserts is unchanged and the
 * calendar date it runs on stops mattering.
 *
 * The instant is truncated to the whole second, so the wire format a suite compares against is the
 * same `…:SS.000Z` its literal was. `test/integration/support/migrated.ts` refuses a stale write to
 * a partitioned table, which is what finds the next literal before the calendar does.
 */

import type { IsoDateTime } from '@platform/contracts';
import { addMs } from '@platform/domain';

/** The current wall-clock instant, truncated to the second, shifted by `offsetMs`. */
export const recentInstant = (offsetMs = 0): IsoDateTime =>
  addMs(new Date(Math.floor(Date.now() / 1000) * 1000).toISOString() as IsoDateTime, offsetMs);
