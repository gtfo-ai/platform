/**
 * What a package registry says about a package — product/04:58's *"license and maintenance
 * status"*, Q84's answer, WP-38.
 *
 * ## Why this is a port and not an integration type
 *
 * Q84 priced three shapes and recommended this one: *"one read-only metadata client for the
 * ecosystems the detector recognises … against an **operator-declared** host allow-list that is
 * **empty by default**"*. It is deliberately **not** a sixth integration type (BD-017's port + fake
 * + contract suite + setup guide): there is no credential, no binding, no per-project
 * configuration and no mutation — *"BD-017's machinery without BD-017's problem"*. And it is
 * deliberately not the **agent's** job either, which was the cheapest shape of all: a licence a
 * model reports is a claim about a claim, and it would be rendered on the one screen a maintainer
 * uses to decide whether to merge (BD-022).
 *
 * ## What every implementation owes
 *
 *  1. **It never throws.** The gate must not depend on the lookup succeeding (Q84): a registry that
 *     is down, rate-limited or does not know the name answers `unavailable`, and the question is
 *     still asked or the block still applied. Standing rule 20's direction — this is a
 *     notification, not the mutation.
 *  2. **It never invents.** A registry that publishes no licence gives `license: null`, which the
 *     panel prints as *"the registry does not say"* rather than as anything else (rule 16).
 *  3. **It is called from a `pipeline.outbound` job, never from an event handler**, like every
 *     other outbound call the pipeline makes (WP-15d). {@link assertOutsideTransaction} is on the
 *     one implementation that reaches the network, so that is mechanical rather than remembered.
 *
 * The shipped default is {@link UNCONFIGURED_DEPENDENCY_METADATA}: an operator who declares no
 * registry host gets `not_checked` for every package and the platform makes no request at all.
 */
import type { DependencyEcosystem, DependencyMetadata } from '@platform/contracts';

export interface DependencyMetadataLookup {
  readonly ecosystem: DependencyEcosystem;
  /** The package name exactly as the manifest spells it; the adapter validates and encodes it. */
  readonly name: string;
}

export interface DependencyMetadataPort {
  /** Never throws, never invents; see the module docblock. */
  describe(lookup: DependencyMetadataLookup): Promise<DependencyMetadata>;
}

/** The answer when nothing was asked, spelled once so no caller builds it by hand. */
export const notCheckedMetadata = (): DependencyMetadata => ({
  status: 'not_checked',
  license: null,
  last_published_at: null,
  deprecated: null,
  source_url: null,
});

/** The answer when the registry was asked and could not say. */
export const unavailableMetadata = (): DependencyMetadata => ({
  ...notCheckedMetadata(),
  status: 'unavailable',
});

/** The answer for an ecosystem this build knows no registry for (`go`, `cargo`). */
export const unsupportedMetadata = (): DependencyMetadata => ({
  ...notCheckedMetadata(),
  status: 'unsupported',
});

/**
 * The port an instance composes when `APP_DEPENDENCY_REGISTRY_HOSTS` is empty — which is the
 * shipped default, so this is what most instances run.
 *
 * It is a *stated* non-answer rather than an absent collaborator: the Checks panel prints *"licence:
 * not checked"* with the setting that would change it, instead of a blank that reads as *"nobody
 * has a licence"* (standing rule 18).
 */
export const UNCONFIGURED_DEPENDENCY_METADATA: DependencyMetadataPort = {
  describe: async () => notCheckedMetadata(),
};
