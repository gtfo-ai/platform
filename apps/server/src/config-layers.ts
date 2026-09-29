/**
 * The layers of a project's configuration as this process reads them — WP-63, technical/12
 * § "Effective configuration", PROGRESS backlogs 44 and 146.
 *
 * `effective = merge(defaults, org, project, repo)`, and until WP-63 production composed one of the
 * four: the pipeline read `projects.config` and nothing else. Two readers need the other layers —
 * the pipeline's settings port (`pipeline.ts`) and `GET /api/projects/:id/config`
 * (`routes/projects.ts`) — and they must read them the same way, so the reading is here, once
 * (standing rule 41).
 *
 *  - **org** — `organizations.settings.commands`, the organisation's command maximum (BD-025 §2).
 *    It is the only organisation key this build composes: no surface sets an organisation autonomy
 *    maximum (the WP-63 notes' discovered work), and the dial is the platform's record of the
 *    position a human chose. **Nothing writes the key yet** — the admin surface is backlog 146's
 *    half (2), left open by WP-63; what WP-63 closes is half (1), the intersection that makes
 *    composing it safe. A value that does not parse is a **refusal**, not an absent layer — an
 *    organisation maximum read as "none" is the permissive reading of a restriction somebody wrote
 *    (standing rule 20).
 *  - **project** — `projects.config`, the settings layer the screens and `PUT …/config` write.
 *  - **repo** — `project_repository_config`, the last reading of the default branch's
 *    `.agentic/config.yml` (`refreshRepositoryConfig`).
 */
import { type RepositoryConfigSnapshot, revalidateRepositorySnapshot } from '@platform/application';
import {
  type CommandPolicy,
  commandPolicySchema,
  type WipLimitsConfig,
  wipLimitsConfigSchema,
} from '@platform/contracts';
import { config as configAdapters, redaction as redactionAdapters } from '@platform/infrastructure';

/** `organizations.settings` names a `commands` value this release cannot read. */
export class OrganisationSettingsInvalidError extends Error {
  readonly keyPaths: readonly string[];

  constructor(
    keyPaths: readonly string[],
    subject: { readonly key: string; readonly what: string } = {
      key: 'commands',
      what: 'command maximum',
    },
  ) {
    super(
      `organizations.settings.${subject.key} does not parse (${keyPaths.join(', ')}); the organisation's ${subject.what} is refused rather than read as absent, so no run is planned against a maximum nobody can name`,
    );
    this.name = 'OrganisationSettingsInvalidError';
    this.keyPaths = keyPaths;
  }
}

/** The organisation's command maximum, or `undefined` when it states none. */
export const organisationCommandsFrom = (settings: unknown): CommandPolicy | undefined => {
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    return undefined;
  }
  const declared = (settings as Record<string, unknown>).commands;
  if (declared === undefined) {
    return undefined;
  }
  const parsed = commandPolicySchema.safeParse(declared);
  if (!parsed.success) {
    throw new OrganisationSettingsInvalidError(
      parsed.error.issues.map((issue) =>
        ['commands', ...issue.path.map(String)].join('.').slice(0, 120),
      ),
    );
  }
  return parsed.data;
};

/**
 * The organisation's WIP maximum — `organizations.settings.pipeline.wip`, the project key's shape
 * (WP-91, backlog 224) — or `undefined` when it states none, which bounds a project by nothing
 * but the schema. Like the command maximum it has **no writer but SQL** on this build (the
 * organisation settings document is WP-93's), and like it a value that does not parse is a
 * refusal, never an absent bound: a maximum read as "none" is the permissive reading of a
 * restriction somebody wrote (standing rule 20).
 */
export const organisationWipFrom = (settings: unknown): WipLimitsConfig | undefined => {
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    return undefined;
  }
  const pipeline = (settings as Record<string, unknown>).pipeline;
  if (pipeline === undefined) {
    return undefined;
  }
  const declared =
    typeof pipeline === 'object' && pipeline !== null && !Array.isArray(pipeline)
      ? (pipeline as Record<string, unknown>).wip
      : pipeline;
  if (declared === undefined) {
    return undefined;
  }
  const parsed = wipLimitsConfigSchema.safeParse(declared);
  if (!parsed.success) {
    throw new OrganisationSettingsInvalidError(
      parsed.error.issues.map((issue) =>
        ['pipeline', 'wip', ...issue.path.map(String)].join('.').slice(0, 120),
      ),
      { key: 'pipeline.wip', what: 'WIP maximum' },
    );
  }
  return parsed.data;
};

/** The columns of one `project_repository_config` row, as a raw query returns them. */
export interface RepositoryConfigColumns {
  readonly repo_status: string | null;
  readonly repo_commit_sha: string | null;
  readonly repo_config: unknown;
  readonly repo_not_applied: unknown;
  readonly repo_detail: string | null;
  readonly repo_read_at: Date | string | null;
}

/**
 * The reading a joined row carries, or `null` when the project was never read (a left join) —
 * **re-validated under this release** (`revalidateRepositorySnapshot`, WP-63 review round 1), so a
 * schema tightened or a key graded *not applied* since the row was written applies now.
 */
export const repositorySnapshotFrom = (
  row: Partial<RepositoryConfigColumns>,
): RepositoryConfigSnapshot | null =>
  revalidateRepositorySnapshot(
    storedSnapshotFrom(row),
    (value) => PATTERN_REDACTOR.redactText(value).value,
  );

/** TD-012 step 2 over a re-validation's key paths, composed once. */
const PATTERN_REDACTOR = redactionAdapters.patternRedactor();

const storedSnapshotFrom = (
  row: Partial<RepositoryConfigColumns>,
): RepositoryConfigSnapshot | null =>
  row.repo_status === null ||
  row.repo_status === undefined ||
  row.repo_commit_sha === null ||
  row.repo_commit_sha === undefined ||
  row.repo_read_at === null ||
  row.repo_read_at === undefined
    ? null
    : configAdapters.snapshotOfRow({
        status: row.repo_status,
        commit_sha: row.repo_commit_sha,
        config: row.repo_config ?? null,
        not_applied: row.repo_not_applied ?? [],
        detail: row.repo_detail ?? null,
        read_at: row.repo_read_at,
      });

/** The select list both readers join in, so the two cannot name different columns. */
export const REPOSITORY_CONFIG_COLUMNS = `r.status as repo_status, r.commit_sha as repo_commit_sha,
  r.config as repo_config, r.not_applied as repo_not_applied, r.detail as repo_detail,
  r.read_at as repo_read_at`;
