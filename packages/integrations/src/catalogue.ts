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
 * `createPipelineProviderRegistry` registers **two** providers — git and task management — and its
 * docblock says why the other three are not there: entries nothing constructs are a set the code is
 * parameterised over and the tests are not. That argument is about `create`. A read surface calls
 * `create` never and must still be able to name every provider an operator can configure, or the
 * integrations screen refuses to describe rows the platform itself reads on every webhook. Two
 * questions, two lists.
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
import type { IntegrationType } from '@platform/contracts';
import { gitlabProviderRegistration } from './providers/gitlab/index.js';
import { JIRA_CLOUD_PROVIDER_METADATA } from './providers/jira-cloud/registration.js';
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
}

/** The metadata half of a registration, plus the one fact a registration does not carry. */
const entryOf = (
  registration: {
    readonly id: string;
    readonly type: IntegrationType;
    readonly displayName: string;
    readonly secretFields: readonly string[];
    readonly setupGuidePath: string;
  },
  inboundWebhook: boolean,
): ProviderCatalogueEntry => ({
  id: registration.id,
  type: registration.type,
  displayName: registration.displayName,
  secretFields: [...registration.secretFields],
  setupGuidePath: registration.setupGuidePath,
  inboundWebhook,
});

/**
 * Every provider this repository ships, whatever a given deployment composes.
 *
 * Ordered by id so the integrations screen is stable between reads.
 */
export const SHIPPED_PROVIDERS: readonly ProviderCatalogueEntry[] = [
  entryOf(gitlabProviderRegistration, true),
  entryOf(JIRA_CLOUD_PROVIDER_METADATA, true),
  entryOf(lokiProviderRegistration, false),
  entryOf(sentryProviderRegistration, false),
  entryOf(slackProviderRegistration, true),
].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

/** The shipped provider with this id, or `undefined` for one this build does not ship. */
export const findShippedProvider = (id: string): ProviderCatalogueEntry | undefined =>
  SHIPPED_PROVIDERS.find((entry) => entry.id === id);

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
