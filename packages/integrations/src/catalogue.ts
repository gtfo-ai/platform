/**
 * What this build knows about a provider **before** anybody constructs one (WP-15h part 2).
 *
 * `GET /api/integrations` and `GET /api/integrations/:id/setup-guide` need a provider's display
 * name, its setup guide and — the load-bearing one — **which of its configuration fields are
 * credentials**. None of that needs an adapter, and building one to find out would need the
 * binding's decrypted secrets, an executor and a clock on a read path that has no business holding
 * any of them. So the metadata is separated from {@link ProviderRegistration}, which exists to
 * *create* adapters and is composed per deployment.
 *
 * ## Why it is not the pipeline's registry
 *
 * `createPipelineProviderRegistry` registers a provider when something in the pipeline constructs
 * it — its docblock's rule, *entries nothing constructs are a set the code is parameterised over and
 * the tests are not*. It held two providers when this was written (git and task management), three
 * from WP-32 (Slack) and all five since WP-89 (Sentry and Loki, for the bug pre-fetch), so today the
 * two lists name the same providers — and they stay two lists, because the question differs. The
 * registry's is about `create`, which needs a binding's decrypted secrets, an executor and a clock.
 * A read surface calls `create` never and must still be able to name every provider an operator can
 * configure, whether or not a deployment composes it. Two questions, two lists.
 *
 * ## Nothing here is hand-copied
 *
 * Four entries are derived from the provider's own exported registration object. Jira's
 * registration is a factory (it captures an executor), so its metadata half is exported separately
 * and the factory spreads it — one definition either way (standing rule 7), and
 * `catalogue.test.ts` reads the provider directories off disk so a sixth provider is missing from
 * this list loudly rather than quietly.
 *
 * ## `inboundWebhook` is a declaration, and it is checked
 *
 * Whether a provider has an inbound half is a property of the object its `create` returns
 * (`'inbound' in port` — the same question `bindings/inbound-loader.ts` asks), which is exactly
 * what this module refuses to build. So it is declared here and `catalogue.test.ts` constructs
 * every provider through its own registration and fails on a disagreement, in both directions.
 * It matters because the answer is rendered: Sentry's own setup guide says *"Do not point a Sentry
 * webhook at the platform; nothing would consume it"*, so publishing a webhook URL beside it would
 * contradict the page on the same screen.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AgentTooling } from '@platform/application';
import type {
  IntegrationProvider,
  IntegrationType,
  JsonObject,
  JsonValue,
} from '@platform/contracts';
import type { z } from 'zod';
import { gitlabProviderRegistration } from './providers/gitlab/index.js';
import {
  JIRA_CLOUD_AGENT_TOOLING,
  JIRA_CLOUD_PROVIDER_METADATA,
} from './providers/jira-cloud/registration.js';
import { lokiProviderRegistration } from './providers/loki/index.js';
import { sentryProviderRegistration } from './providers/sentry/index.js';
import { slackProviderRegistration } from './providers/slack/index.js';

/** The half of a {@link ProviderRegistration} that is true without an adapter. */
export interface ProviderCatalogueEntry {
  readonly id: string;
  readonly type: IntegrationType;
  readonly displayName: string;
  /**
   * Config fields whose values are credentials (TD-020).
   *
   * The read API removes exactly these keys from `integrations.config` before publishing it. The
   * column is meant to hold non-secret configuration — a credential belongs in `secrets` and is
   * merged in at load — but `bindings/loader.ts` merges `{...config, ...secrets}` and every
   * provider's schema accepts its credential field either way, so an operator who pasted a token
   * into `config` would otherwise have it served over HTTP to anyone with the `maintainer` role.
   */
  readonly secretFields: readonly string[];
  /** Repository-relative path of the Markdown guide; see {@link readSetupGuide}. */
  readonly setupGuidePath: string;
  /** Whether the adapter this provider builds carries an `inbound` normaliser. */
  readonly inboundWebhook: boolean;
  /**
   * What an agent may be handed inside a run — the registration's own value, which is metadata and
   * true without an adapter (WP-54). Its `skill` is what provisions a provider skill for a project
   * that binds this provider (`createBoundSkillsReader`), and it is read **here** rather than off the
   * pipeline's registry. When WP-54 wrote that reader the registry built only the three types the
   * pipeline then called, so a Loki or Sentry binding's skill would never have been provisioned;
   * since WP-89 the registry holds both, and the catalogue stays the source because provisioning a
   * skill is a metadata question that must not construct an adapter.
   */
  readonly agentTooling: AgentTooling | null;
  /**
   * Config keys a **binding** may not set, because only the account's value is read (WP-73b,
   * PROGRESS backlog 201) — the registration's `accountOnlyFields`, `[]` when it declares none.
   */
  readonly accountOnlyFields: readonly string[];
  /**
   * The value each config field **defaults** to when a body leaves it out — read off the
   * provider's own schema, field by field, so nothing is hand-copied (WP-73b, PROGRESS backlog
   * 245). Sentry's `base_url` is `https://sentry.io` and Slack's `https://slack.com/api`; a field
   * with no default is absent. The create's host guard sweeps these beside the body, so a default
   * is judged like a typed value.
   */
  readonly configDefaults: JsonObject;
  /**
   * Every **non-credential** field the provider's schema declares, in declaration order, and
   * whether the schema requires it — read off the schema field by field like
   * {@link configDefaults}, so the create form renders what the provider asks for without a copy of
   * the schema in the SPA (WP-100, PROGRESS backlog 328). A field is required when its own schema
   * refuses `undefined`: Sentry's `organization`, GitLab's `base_url`.
   */
  readonly configFields: readonly { readonly name: string; readonly required: boolean }[];
  /**
   * The provider's schema **without its credential fields** — what `integrations.config` must
   * parse as (WP-100). Credentials are sealed into `secrets` and merged in at load, so the account's
   * own document is judged without them; {@link configIssuesOf} is the one reader.
   */
  readonly accountConfigSchema: z.ZodObject;
}

/**
 * Each field's default, asked of the field's own schema with `undefined` — the one input a
 * `.default()` answers and a required field refuses — so a credential, which is required, is never
 * here, and neither is a field whose absence is allowed without a value.
 */
const configDefaultsOf = (schema: z.ZodObject): JsonObject => {
  const defaults: Record<string, JsonValue> = {};
  for (const [field, fieldSchema] of Object.entries(schema.shape)) {
    const parsed = (fieldSchema as z.ZodType).safeParse(undefined);
    if (parsed.success && parsed.data !== undefined) {
      defaults[field] = parsed.data as JsonValue;
    }
  }
  return defaults;
};

/** Each non-credential field of the schema, and whether it is required (no default, not optional). */
const configFieldsOf = (
  schema: z.ZodObject,
  secretFields: readonly string[],
): { readonly name: string; readonly required: boolean }[] =>
  Object.entries(schema.shape)
    .filter(([field]) => !secretFields.includes(field))
    .map(([field, fieldSchema]) => ({
      name: field,
      required: !(fieldSchema as z.ZodType).safeParse(undefined).success,
    }));

/**
 * The schema with its credential fields omitted — `omit` keeps the object's strictness, so an
 * undeclared key is still refused. Only fields the shape declares are named: the mask's type is
 * the shape's own keys, which a list read at run time cannot state to `tsc`.
 */
const withoutCredentials = (schema: z.ZodObject, secretFields: readonly string[]): z.ZodObject => {
  const mask: Record<string, true> = {};
  for (const field of secretFields.filter((name) => name in schema.shape)) {
    mask[field] = true;
  }
  return schema.omit(mask as Parameters<typeof schema.omit>[0]);
};

/** The metadata half of a registration, plus the one fact a registration does not carry. */
const entryOf = (
  registration: {
    readonly id: string;
    readonly type: IntegrationType;
    readonly displayName: string;
    readonly secretFields: readonly string[];
    readonly setupGuidePath: string;
    readonly agentTooling: AgentTooling | null;
    readonly accountOnlyFields?: readonly string[];
    readonly configSchema: z.ZodObject;
  },
  inboundWebhook: boolean,
): ProviderCatalogueEntry => ({
  id: registration.id,
  type: registration.type,
  displayName: registration.displayName,
  secretFields: [...registration.secretFields],
  setupGuidePath: registration.setupGuidePath,
  inboundWebhook,
  agentTooling: registration.agentTooling,
  accountOnlyFields: [...(registration.accountOnlyFields ?? [])],
  configDefaults: configDefaultsOf(registration.configSchema),
  configFields: configFieldsOf(registration.configSchema, registration.secretFields),
  accountConfigSchema: withoutCredentials(registration.configSchema, registration.secretFields),
});

/**
 * Every provider this repository ships, whatever a given deployment composes.
 *
 * Ordered by id so the integrations screen is stable between reads.
 */
export const SHIPPED_PROVIDERS: readonly ProviderCatalogueEntry[] = [
  entryOf(gitlabProviderRegistration, true),
  entryOf({ ...JIRA_CLOUD_PROVIDER_METADATA, agentTooling: JIRA_CLOUD_AGENT_TOOLING }, true),
  entryOf(lokiProviderRegistration, false),
  entryOf(sentryProviderRegistration, false),
  entryOf(slackProviderRegistration, true),
].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

/** The shipped provider with this id, or `undefined` for one this build does not ship. */
export const findShippedProvider = (id: string): ProviderCatalogueEntry | undefined =>
  SHIPPED_PROVIDERS.find((entry) => entry.id === id);

/**
 * The config keys a **binding** may not set for this provider — its registration's
 * `accountOnlyFields`, `[]` for one that declares none or that this build does not ship. The
 * lookup the binding repository drops a stored binding's copy by on read (WP-79, PROGRESS backlog
 * 268), beside the write refusal (`assertNoAccountOnlyFields`) that reads the same list.
 */
export const accountOnlyFieldsOf = (provider: string): readonly string[] =>
  findShippedProvider(provider)?.accountOnlyFields ?? [];

/** One key path an account's configuration is refused at, and the schema's reason. */
export interface ConfigIssue {
  /** Dotted key path; for an undeclared key, the key itself. Never a value. */
  readonly path: string;
  readonly message: string;
}

/**
 * Why this configuration document would be refused by the provider's own schema — `[]` when it
 * parses (WP-100, PROGRESS backlog 328).
 *
 * It is the question the binding loader and the prober ask at use (`bindings/loader.ts`,
 * `bindings/prober.ts`: `configSchema.safeParse({ ...config, ...secrets })`), asked **without an
 * adapter** and without the credentials: the document is parsed against
 * {@link ProviderCatalogueEntry.accountConfigSchema} with the provider's credential keys taken out
 * first. Taken out rather than refused, because the write already refuses a credential key
 * (`assertNoCredentialInConfig` in `apps/server`) and a row written before that check, whose token
 * sits in the column, loads today — reporting it here would call a working row broken.
 *
 * Paths and the schema's messages only, never a value: the messages the five shipped schemas
 * produce are about shape (*"expected a Sentry slug"*, *"Invalid input: expected string"*), and an
 * undeclared key is reported by its **name** (zod reports it at the root with the key in `keys`),
 * which is what an operator removes.
 */
export const configIssuesOf = (
  entry: ProviderCatalogueEntry,
  config: JsonObject,
): readonly ConfigIssue[] => {
  const secret = new Set(entry.secretFields);
  const document = Object.fromEntries(Object.entries(config).filter(([key]) => !secret.has(key)));
  const parsed = entry.accountConfigSchema.safeParse(document);
  if (parsed.success) {
    return [];
  }
  return parsed.error.issues.flatMap((issue): ConfigIssue[] => {
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => ({
        path: key,
        message: `not a configuration field of provider "${entry.id}"`,
      }));
    }
    return [
      {
        path: issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.'),
        message: issue.message,
      },
    ];
  });
};

/**
 * The provider as `GET /api/integrations/providers` publishes it (WP-100) — one projection, so the
 * route and the SPA's own tests read the same shape off the same catalogue.
 */
export const toIntegrationProvider = (entry: ProviderCatalogueEntry): IntegrationProvider => ({
  id: entry.id,
  type: entry.type,
  display_name: entry.displayName,
  secret_fields: [...entry.secretFields],
  config_fields: entry.configFields.map((field) => ({
    name: field.name,
    required: field.required,
    account_only: entry.accountOnlyFields.includes(field.name),
  })),
});

/**
 * The repository root, derived from this module rather than from `process.cwd()`.
 *
 * `setupGuidePath` is repository-relative because that is how a registration reads (the string is
 * the path a developer would open), so something has to supply the root. Resolving against *this
 * file* holds wherever the package sits on disk; `cwd` holds only when the process was started from
 * the repository root.
 *
 * **Read off the build rather than measured in a container** (standing rule 86): `docker/app.Dockerfile`
 * sets `WORKDIR /app` and copies `packages` to `/app/packages`, and `.dockerignore` excludes no
 * Markdown — so the guides are in the image and the layout below the root is the same one. Nobody
 * has started the product image and called this function; `catalogue.test.ts` proves the guides
 * resolve from a checkout, which is the weaker of the two claims.
 */
const repositoryRoot = new URL('../../../', import.meta.url);

export interface SetupGuide {
  /** The guide's own `#` heading, or the provider's display name when it has none. */
  readonly title: string;
  /** The Markdown, byte-for-byte as it is committed. Rendered as text, never as HTML (BD-022). */
  readonly markdown: string;
}

/**
 * Reads a provider's setup guide off disk.
 *
 * The file is part of the repository, not user input, and it is still served through the untrusted
 * path in the SPA: a guide is prose with code fences in it, and the app has no markdown-to-HTML step
 * for anything (CLAUDE.md). Nothing here parses it beyond finding the first heading.
 *
 * @throws {Error} when the declared path does not exist — a registration naming a file that is not
 * shipped is a packaging bug, and answering with an empty guide would hide it.
 */
export const readSetupGuide = async (entry: ProviderCatalogueEntry): Promise<SetupGuide> => {
  const path = fileURLToPath(new URL(entry.setupGuidePath, repositoryRoot));
  const markdown = await readFile(path, 'utf8');
  const heading = /^#\s+(.+?)\s*$/m.exec(markdown);
  return { title: heading?.[1] ?? entry.displayName, markdown };
};
