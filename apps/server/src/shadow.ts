/**
 * Shadow mode, composed for `apps/server` — product/18:24, product/19 §13 (WP-34).
 *
 * One command and no workers: the batch's *runs* are ordinary stage runs, so everything after the
 * `tasks` rows exist is the pipeline's (`createPipelineRuntime` registers the report handler and the
 * `shadow_report` duty). This file is the API half only, and it is shaped like `onboarding.ts` next
 * door for the same reason: which collaborators exist is a property of the `ROLE`, and a route whose
 * collaborator is absent answers `503` by name rather than disappearing.
 *
 * `jobs` is what decides whether the command can work at all. A batch creates N tasks and enqueues
 * N stages; without a queue every one of them would sit `active` at a stage nothing runs, which is
 * worse than a refusal — the same call `startDiscovery` makes.
 */
import { randomUUID } from 'node:crypto';
import type {
  Jobs,
  Logger,
  PipelineIntegrationsPort,
  StartShadowBatchResult,
} from '@platform/application';
import { startShadowBatch } from '@platform/application';
import type { Id } from '@platform/contracts';
import { SHIPPED_TEMPLATES } from '@platform/domain';
import {
  type eventing as eventingAdapters,
  pipeline as pipelineAdapters,
  shadow as shadowAdapters,
} from '@platform/infrastructure';
import type pg from 'pg';
import { OnboardingUnavailableError } from './onboarding.js';
import { createProjectSettingsPort } from './pipeline.js';

export interface ShadowCommands {
  startBatch(input: {
    readonly projectId: Id;
    readonly ticketKeys: readonly string[];
    readonly userId: Id;
  }): Promise<StartShadowBatchResult>;
}

export interface ShadowCommandOptions {
  readonly pool: pg.Pool;
  readonly eventing: ReturnType<typeof eventingAdapters.createEventing>;
  /** `null` on a process that runs no workers; the command refuses by name. */
  readonly jobs: Jobs | null;
  /** The project's bindings, resolved per call — the same port the pipeline is given (WP-15a). */
  readonly integrations: PipelineIntegrationsPort;
  readonly logger?: Logger;
}

export const createShadowCommands = (options: ShadowCommandOptions): ShadowCommands => ({
  startBatch: async ({ projectId, ticketKeys, userId }) => {
    const { jobs } = options;
    if (jobs === null) {
      throw new OnboardingUnavailableError(
        'this process runs no job workers, so it cannot start a shadow batch: the tasks would be created and their stages would never execute. Ask an instance that runs the workers',
      );
    }
    return startShadowBatch(
      {
        unitOfWork: options.eventing.unitOfWork,
        store: pipelineAdapters.createPostgresPipelineStore({ templates: SHIPPED_TEMPLATES }),
        shadow: new shadowAdapters.PostgresShadowStore(),
        settings: createProjectSettingsPort(options.pool),
        integrations: options.integrations,
        jobs,
        ids: { next: (): Id => randomUUID() as Id },
        clock: { now: () => new Date().toISOString() as never },
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      },
      { projectId, ticketKeys, requestedByUserId: userId },
    );
  },
});
