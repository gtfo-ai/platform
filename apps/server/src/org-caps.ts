/**
 * Which projects a `PATCH /api/org` caps — WP-113, PROGRESS backlog 318.
 *
 * An organisation maximum is read, never written into a project (WP-93's ruling: *"a lowered
 * maximum applies at the next read, and nothing is rewritten"*), so lowering one changes what a
 * project runs at without touching its row — and until WP-113 the administrator who lowered it learnt
 * which projects that was one project page at a time, afterwards. The write now answers it.
 *
 * ## What counts as capped
 *
 * A project whose value **in force** fell: its autonomy level in force (the level it chose, capped at
 * the maximum — `GET …/autonomy`'s `level_in_force`) or one of its two WIP limits (`resolveWipLimits`,
 * what admission counts against). *Fell*, not *differs*: raising a maximum restores a project's own
 * choice and caps nobody, so it lists none, and a project already held at the old maximum that the
 * new one holds at the same value is not news either. `before` is computed against the stored
 * document the write replaced, `after` against the one it wrote — both through the readers' own
 * functions, so the list cannot disagree with what the next read answers (standing rule 41).
 *
 * ## Where it is computed
 *
 * In the write's own transaction: `replaceOrganisationSettings` reads the projects **under the
 * organisation row's lock**, after its `update`, and hands the rows here. A project created or
 * re-dialled by a concurrent transaction is answered as it stood when this one read it, which is the
 * read-committed answer every reader in the server gives.
 *
 * ## Two stated limits
 *
 *  - A project whose own settings layer does not parse (WP-106) runs on no layer at all — every run
 *    is refused by name — so its WIP limits are not a value an organisation maximum moves, and it is
 *    left out of the WIP half. Its autonomy half is answered: the dial is a column of its own.
 *  - A stored organisation document the write replaced and that did not parse is read as stating no
 *    maximum (`before`), because a document no reader could parse bound nothing anybody could name —
 *    the settings port refused every run under it rather than applying it.
 */
import {
  ProjectSettingsInvalidError,
  projectConfigWithRepository,
  type RepositoryConfigSnapshot,
} from '@platform/application';
import {
  type AutonomyLevel,
  type CappedProject,
  materialisedAutonomySchema,
  type OrganisationSettings,
} from '@platform/contracts';
import { autonomyRank, type ConfigValues, capAutonomy, resolveWipLimits } from '@platform/domain';
import { OrganisationSettingsInvalidError, organisationSettingsFrom } from './config-layers.js';

/** One project as the cap computation needs it — read in the write's transaction. */
export interface OrgCapProject {
  readonly id: string;
  readonly key: string;
  /** The level the project chose: the materialised dial's, or the column's when never materialised. */
  readonly level: AutonomyLevel;
  /**
   * `pipeline.wip` as the project's layers state it (the settings with the repository file merged
   * over them), `undefined` when neither does, or `'refused'` when the settings layer does not parse.
   */
  readonly wip: NonNullable<ConfigValues['pipeline']>['wip'] | 'refused';
}

/** The chosen level, as `GET …/autonomy` reads it: the materialised document's, else the column. */
export const chosenAutonomyLevelOf = (policies: unknown, column: AutonomyLevel): AutonomyLevel => {
  const parsed = materialisedAutonomySchema.safeParse(policies);
  return parsed.success ? parsed.data.level : column;
};

/**
 * A project row's stated WIP limits through the settings port's own layering
 * (`projectConfigWithRepository` over the parsed settings layer), or `'refused'`.
 */
export const statedWipOf = (
  settings: () => ConfigValues,
  snapshot: RepositoryConfigSnapshot | null,
): OrgCapProject['wip'] => {
  try {
    return projectConfigWithRepository(settings(), snapshot).values.pipeline?.wip;
  } catch (error) {
    if (error instanceof ProjectSettingsInvalidError) return 'refused';
    throw error;
  }
};

const organisationOrNone = (stored: unknown): OrganisationSettings => {
  try {
    return organisationSettingsFrom(stored);
  } catch (error) {
    if (error instanceof OrganisationSettingsInvalidError) return {};
    throw error;
  }
};

const WIP_KEYS = [
  ['pipeline.wip.max_parallel_tasks', 'maxParallelTasks'],
  ['pipeline.wip.max_tasks_in_pipeline', 'maxTasksInPipeline'],
] as const;

/**
 * The projects whose value in force this write lowered, autonomy first and then the two WIP limits,
 * in the order the rows were read. Empty when nothing fell.
 */
export const cappedProjectsOf = (input: {
  readonly before: unknown;
  readonly after: OrganisationSettings;
  readonly projects: readonly OrgCapProject[];
}): CappedProject[] => {
  const before = organisationOrNone(input.before);
  const after = input.after;
  const capped: CappedProject[] = [];
  for (const project of input.projects) {
    const levelBefore = capAutonomy(project.level, before.autonomy?.maximum ?? 'autonomous');
    const levelAfter = capAutonomy(project.level, after.autonomy?.maximum ?? 'autonomous');
    if (autonomyRank(levelAfter) < autonomyRank(levelBefore)) {
      capped.push({
        project_id: project.id,
        project_key: project.key,
        setting: 'autonomy',
        before: levelBefore,
        after: levelAfter,
      });
    }
    if (project.wip === 'refused') continue;
    const wipBefore = resolveWipLimits(project.wip, before.pipeline?.wip).limits;
    const wipAfter = resolveWipLimits(project.wip, after.pipeline?.wip).limits;
    for (const [setting, field] of WIP_KEYS) {
      if (wipAfter[field] < wipBefore[field]) {
        capped.push({
          project_id: project.id,
          project_key: project.key,
          setting,
          before: wipBefore[field],
          after: wipAfter[field],
        });
      }
    }
  }
  return capped;
};
