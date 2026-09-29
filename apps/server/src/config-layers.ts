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
 *  - **org** — `organizations.settings`, the organisation settings document (WP-93,
 *    `organisationSettingsSchema`): the command maximum (BD-025 §2), the autonomy maximum, the WIP
 *    maximum (WP-91) and the organisation's notification settings. `GET/PATCH /api/org`
 *    (`routes/settings.ts`) read and write it; every reader here **parses the whole document**
 *    through the one strict schema — never a cast, never one key picked out of an unparsed object
 *    (PROGRESS backlog 311's organisation half). A document that does not parse is a **refusal**,
 *    not an absent layer — an organisation maximum read as "none" is the permissive reading of a
 *    restriction somebody wrote (standing rule 20).
 *  - **project** — `projects.config`, the settings layer the screens and `PUT …/config` write.
 *  - **repo** — `project_repository_config`, the last reading of the default branch's
 *    `.agentic/config.yml` (`refreshRepositoryConfig`).
 */
import { type RepositoryConfigSnapshot, revalidateRepositorySnapshot } from '@platform/application';
import {
  type AutonomyLevel,
  type MaterialisedAutonomy,
  type OrganisationSettings,
  organisationSettingsSchema,
} from '@platform/contracts';
import { capMaterialisedAutonomy } from '@platform/domain';
import { config as configAdapters, redaction as redactionAdapters } from '@platform/infrastructure';
import { HttpError } from './errors.js';

/** Longest rendering of one refused clause: stored state came from outside (BD-022). */
const MAX_REFUSED_CLAUSE_CHARS = 120;

/**
 * `organizations.settings` is a document this release cannot read — WP-93.
 *
 * `clauses` are `key.path: <value>` (or `key.path (<why>)` when there is no value), **redacted**
 * through the platform's patterns and bounded, because the column is text an administrator typed —
 * a command list is free text, and a credential pasted into one would otherwise be quoted back by
 * every refusal (the WP-30 / WP-83 shape, `describeConfigIssues`).
 */
export class OrganisationSettingsInvalidError extends Error {
  readonly clauses: readonly string[];

  constructor(clauses: readonly string[]) {
    super(
      `organizations.settings does not parse (${clauses.join(', ')}); the organisation settings document is refused rather than read as absent, so nothing is planned or sent against a maximum nobody can name — correct it with PATCH /api/org`,
    );
    this.name = 'OrganisationSettingsInvalidError';
    this.clauses = clauses;
  }
}

const valueAt = (document: unknown, path: readonly PropertyKey[]): unknown => {
  let current: unknown = document;
  for (const segment of path) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  return current;
};

/**
 * The organisation settings document, **parsed** — `{}` for an organisation that states nothing
 * (`organizations.settings` defaults to `'{}'`) and for a caller with no row at all.
 *
 * @throws {OrganisationSettingsInvalidError} when the stored document fails the strict schema.
 */
export const organisationSettingsFrom = (settings: unknown): OrganisationSettings => {
  if (settings === null || settings === undefined) {
    return {};
  }
  const parsed = organisationSettingsSchema.safeParse(settings);
  if (parsed.success) {
    return parsed.data;
  }
  throw new OrganisationSettingsInvalidError(
    parsed.error.issues.map((issue) => {
      const path = issue.path.map(String).join('.');
      const value = valueAt(settings, issue.path);
      const clause =
        value === undefined || path === ''
          ? `${path === '' ? '(root)' : path} (${issue.message})`
          : `${path}: ${JSON.stringify(value)}`;
      return PATTERN_REDACTOR.redactText(clause).value.slice(0, MAX_REFUSED_CLAUSE_CHARS);
    }),
  );
};

/**
 * {@link organisationSettingsFrom} for an HTTP read or write: the refusal as the **409
 * `invalid_organisation_config`** every route answers it with (`GET …/config` since WP-63), naming
 * the key paths and values — an operator can act on it with `PATCH /api/org`.
 */
export const organisationSettingsForRequest = (settings: unknown): OrganisationSettings => {
  try {
    return organisationSettingsFrom(settings);
  } catch (error) {
    if (error instanceof OrganisationSettingsInvalidError) {
      throw new HttpError(409, 'invalid_organisation_config', error.message);
    }
    throw error;
  }
};

/**
 * The dial under the organisation's maximum (WP-93) — `capMaterialisedAutonomy` for a project whose
 * dial may never have been materialised; `null` stays `null`. One expression for the pipeline's
 * settings port and the Librarian's read (standing rule 41).
 */
export const cappedAutonomy = (
  materialised: MaterialisedAutonomy | null,
  maximum: AutonomyLevel | undefined,
): MaterialisedAutonomy | null =>
  materialised === null ? null : capMaterialisedAutonomy(materialised, maximum);

/** The columns of one `project_repository_config` row, as a raw query returns them. */
export interface RepositoryConfigColumns {
  readonly repo_status: string | null;
  readonly repo_commit_sha: string | null;
  readonly repo_config: unknown;
  readonly repo_not_applied: unknown;
  readonly repo_detail: string | null;
  readonly repo_read_at: Date | string | null;
  /** Migration 0063 (WP-92): the prompt directory the reading recorded, or `null`. */
  readonly repo_prompts: unknown;
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
        prompts: row.repo_prompts ?? null,
      });

/** The select list both readers join in, so the two cannot name different columns. */
export const REPOSITORY_CONFIG_COLUMNS = `r.status as repo_status, r.commit_sha as repo_commit_sha,
  r.config as repo_config, r.not_applied as repo_not_applied, r.detail as repo_detail,
  r.read_at as repo_read_at, r.prompts as repo_prompts`;
