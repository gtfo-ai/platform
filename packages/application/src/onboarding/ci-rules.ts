/**
 * The readiness **CI-rules notice**'s reads (WP-143, Q114) — where the CI configuration lives, its
 * bytes at the read commit, redacted and parsed — handed to the pure evaluator in
 * `@platform/domain` (`ciRulesNotice`).
 *
 * Two reads, both outside any transaction:
 *  1. **where**, from the provider through the executor (`gitReads.ciConfigLocation`, WP-139's
 *     `ci_config_path`) — an external location (`@` or a URL) yields a *not read* note and no file
 *     read at all;
 *  2. **what**, from the platform's mirror at the same commit the rest of the re-check reads
 *     (`RepositoryFileRequest.ciConfigPath`, the one provider-named path whose bytes are read).
 *
 * The file is redacted with the git binding's redactor **before** it is parsed (TD-012), so every
 * string the evaluator quotes — a job name, one rule — has already been through it. A provider or
 * mirror refusal is a note naming it, never a throw and never a warning; anything else propagates
 * (rule 20).
 *
 * It also hands back the redacted file when it sits at a custom path, so R13 reads the CI file the
 * project actually runs (backlog 442's CI-path half).
 */
import type { Id } from '@platform/contracts';
import {
  CI_RULES_SAMPLE_BRANCH,
  type CiRulesReading,
  ciRulesNotice,
  type ReadinessNotice,
} from '@platform/domain';
import type { RepositoryFileSource } from '../config/repository-config.js';
import type { PipelineIntegrationsPort } from '../pipeline/integrations.js';
import { gitReads, integrationsForProject, noRunScopedSecrets } from '../pipeline/integrations.js';
import { IntegrationError } from '../ports/integrations/common.js';

/** YAML → plain data for a CI file; `!reference` as `CI_REFERENCE_KEY`. Infrastructure's. */
export interface CiDocumentParser {
  parse(
    text: string,
  ):
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly reason: string };
}

export interface CiRulesObservation {
  /** The warning, a note, or `null` when there is nothing to say. */
  readonly notice: ReadinessNotice | null;
  /**
   * The CI file at the provider's path, **redacted**, when it was read — R13 reads it in place of
   * the root `.gitlab-ci.yml` when the two differ (backlog 442).
   */
  readonly ciFile: { readonly path: string; readonly text: string } | null;
}

/** Performs I/O, so it is never called in a transaction. */
export interface CiRulesProbe {
  read(projectId: Id, commitSha?: string): Promise<CiRulesObservation>;
}

export interface CiRulesProbeOptions {
  readonly integrations: PipelineIntegrationsPort;
  readonly files: RepositoryFileSource;
  readonly parser: CiDocumentParser;
  /** The stored `projects.default_branch` (WP-142), or `null` when the project has no row. */
  readonly defaultBranch: (projectId: Id) => Promise<string | null>;
}

const unavailable = (reason: string): CiRulesReading => ({ kind: 'unavailable', reason });

export const createCiRulesProbe = (options: CiRulesProbeOptions): CiRulesProbe => ({
  read: async (projectId, commitSha) => {
    const defaultBranch = await options.defaultBranch(projectId);
    if (defaultBranch === null) return { notice: null, ciFile: null };
    const observe = (reading: CiRulesReading, ciFile: CiRulesObservation['ciFile'] = null) => ({
      notice: ciRulesNotice({ reading, branch: CI_RULES_SAMPLE_BRANCH, defaultBranch }),
      ciFile,
    });

    const resolved = await integrationsForProject(
      options.integrations,
      projectId,
      noRunScopedSecrets(),
    );
    const git = resolved.git;
    if (git === null) {
      return observe(unavailable('the project has no git binding to ask where its CI lives'));
    }
    const redact = (text: string): string => git.redactor.redactText(text).value;
    let location: Awaited<ReturnType<ReturnType<typeof gitReads>['ciConfigLocation']>>;
    try {
      location = await gitReads(resolved).ciConfigLocation({ projectId, taskId: null });
    } catch (error) {
      if (!(error instanceof IntegrationError)) throw error;
      return observe(
        unavailable(
          `the git provider could not say where the CI configuration lives (${redact(error.message).slice(0, 200)})`,
        ),
      );
    }
    if (location === null) {
      return observe(unavailable('the project has no git binding to ask where its CI lives'));
    }
    if (location.kind === 'unknown') {
      return observe(unavailable(redact(location.reason).slice(0, 300)));
    }
    if (location.kind === 'external') {
      return observe({ kind: 'external', location: redact(location.location) });
    }
    const path = location.path;
    // Provider text (BD-022): what a notice shows of the path is the redacted one.
    const shown = redact(path);
    const read = await options.files.read({
      projectId,
      paths: [],
      ciConfigPath: path,
      ...(commitSha === undefined ? {} : { commitSha }),
    });
    if (read.status !== 'ok') {
      return observe(unavailable(redact(read.reason).slice(0, 300)));
    }
    const entry = read.ciConfig;
    if (entry === undefined) {
      return observe(unavailable(`the mirror's reading did not answer ${JSON.stringify(shown)}`));
    }
    switch (entry.kind) {
      case 'absent':
        return observe({ kind: 'absent' });
      case 'not_a_file':
        return observe(
          unavailable(
            `${JSON.stringify(shown)} is not a regular file (a symlink, a directory or a submodule)`,
          ),
        );
      case 'oversized':
        return observe(
          unavailable(
            `${JSON.stringify(shown)} is ${entry.bytes} bytes, larger than the platform reads`,
          ),
        );
      case 'file': {
        const text = redact(entry.text);
        return observe(
          { kind: 'file', path: shown, parsed: options.parser.parse(text) },
          // The redacted path: R13's evidence shows it, and the store keeps that evidence.
          { path: shown, text },
        );
      }
    }
  },
});
