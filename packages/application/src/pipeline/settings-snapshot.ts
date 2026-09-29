/**
 * The configuration a run was planned with, frozen onto its row — `runs.settings_snapshot` and
 * `runs.settings_hash` (WP-91, PROGRESS backlog 227).
 *
 * technical/12 promised *"frozen into `Run.settings_snapshot`"* and product/09's run record lists
 * *"settings snapshot (effective config hash + full copy)"*; both columns existed from migration
 * 0004 and nothing wrote them. The settings port is read **per stage** (a later stage can see a
 * newer repository reading, and the reading lags a merge by one index run), so without this a
 * stage-to-stage change within a task left no audit row. The snapshot does not stop that lag; it
 * makes every run say which reading it ran on.
 *
 * ## What is in it
 *
 * The **effective** configuration the planner read — `ProjectSettings`, the settings port's
 * answer — composed the way `GET …/config` publishes `effective`: platform defaults under the
 * settings layer and the repository file already merged into it (`settings.config`, tighten-only),
 * the command lists narrowed layer by layer (organisation maximum, settings, file), and the WIP
 * limits as admission resolved them. Beside it, the three things a run is planned from that are
 * not keys of the document: the **materialised** autonomy dial (BD-027:14 — what the dial meant
 * when a human chose it, never re-derived), the task budget cap, the template ids, and which
 * repository reading was merged (`status`, `commit_sha`).
 *
 * The planner applies the defaults at the point of use rather than reading them from a merged
 * document (the settings port merges without them, Q78), so this is the document those reads
 * **agree with**, composed once here; it is not a copy of a structure the planner held.
 *
 * ## Redacted, bounded, and hashed over what is stored
 *
 *  - **Redacted.** The schema accepts no credential (technical/12 rule 2), but several leaves are
 *    free text an operator typed — a checklist item, a reviewer handle, a status name — and a
 *    pasted token would otherwise be copied onto every run. So the document goes through the
 *    run's own TD-012 redactor (`redactJson`), the one its two prompt columns use. Its replacements
 *    are **not** added to `runs.redaction_count`, which means *the two prompt columns* since 0038.
 *  - **Bounded** at {@link MAX_SETTINGS_SNAPSHOT_BYTES} of canonical JSON. A larger document is
 *    stored as a stated marker — `{format, truncated: true, bytes}` — never cut mid-structure,
 *    and the hash is still the full document's.
 *  - **Hashed** as `sha256` (hex) over the **canonical JSON of the stored (redacted) document**:
 *    object keys sorted by code unit, `undefined` members dropped, arrays in order, no whitespace
 *    — `canonicalJson` below. Two runs planned with the same configuration therefore carry the
 *    same hash, key order never moves it, and — below the cap — the hash can be recomputed from the
 *    row (above it the row holds only the marker, so the hash is the one record of the document). The cost of
 *    hashing the redacted form is stated: two documents that differ only inside a secret the
 *    redactor replaced hash alike.
 */
import { createHash } from 'node:crypto';
import type { JsonObject } from '@platform/contracts';
import { type ConfigLayer, mergeProjectConfig } from '@platform/domain';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import type { ProjectSettings } from './settings.js';

/** The snapshot document's format; bumped when its shape changes, so a reader can tell. */
export const SETTINGS_SNAPSHOT_FORMAT = 1;

/** The largest canonical snapshot stored whole: 256 KiB, far above any document the schema admits. */
export const MAX_SETTINGS_SNAPSHOT_BYTES = 256 * 1024;

export interface RunSettingsSnapshot {
  readonly snapshot: JsonObject;
  /** `sha256` hex over {@link canonicalJson} of the redacted document. */
  readonly hash: string;
}

/**
 * Canonical JSON: keys sorted, `undefined` dropped, no whitespace. The serialisation the hash is
 * over, so it is exported and pinned by its own test.
 */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry ?? null)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
};

/** The effective document, composed from the settings the planner was handed. */
export const settingsSnapshotDocument = (settings: ProjectSettings): JsonObject => {
  const layers: ConfigLayer[] = [
    ...(settings.organisationCommands === undefined
      ? []
      : [{ source: 'org' as const, values: { commands: settings.organisationCommands } }]),
    { source: 'project', values: settings.config },
    ...(settings.repositoryCommands === undefined
      ? []
      : [{ source: 'repo' as const, values: { commands: settings.repositoryCommands } }]),
  ];
  // `autonomous`: the dial is the materialised record below, not a key this merge may cap — the
  // argument `GET …/config` makes for the same option (`PUBLISHED_AUTONOMY_MAXIMUM`).
  const merged = mergeProjectConfig(layers, { autonomyMaximum: 'autonomous' }).values;
  const effective = {
    version: 1,
    ...merged,
    pipeline: {
      ...merged.pipeline,
      // What admission uses, the organisation's bound applied (`resolveWipLimits`).
      wip: {
        max_parallel_tasks: settings.wip.maxParallelTasks,
        max_tasks_in_pipeline: settings.wip.maxTasksInPipeline,
      },
    },
  };
  return JSON.parse(
    JSON.stringify({
      format: SETTINGS_SNAPSHOT_FORMAT,
      effective,
      autonomy: settings.autonomy,
      task_budget_usd: settings.taskBudgetUsd,
      templates: Object.keys(settings.templates).sort(),
      repository:
        settings.repository === undefined
          ? null
          : { status: settings.repository.status, commit_sha: settings.repository.commitSha },
    }),
  ) as JsonObject;
};

/** The snapshot a run row carries, and its hash — redacted, bounded, canonical. */
export const runSettingsSnapshot = (
  settings: ProjectSettings,
  redactor: SecretRedactor,
): RunSettingsSnapshot => {
  const redacted = redactor.redactJson(settingsSnapshotDocument(settings)).value;
  const canonical = canonicalJson(redacted);
  const hash = createHash('sha256').update(canonical).digest('hex');
  const bytes = Buffer.byteLength(canonical, 'utf8');
  return bytes <= MAX_SETTINGS_SNAPSHOT_BYTES
    ? { snapshot: redacted, hash }
    : { snapshot: { format: SETTINGS_SNAPSHOT_FORMAT, truncated: true, bytes }, hash };
};
