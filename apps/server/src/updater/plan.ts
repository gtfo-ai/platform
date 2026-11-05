/**
 * **What the updater hands the apply container, and what the apply leaves behind** — WP-287 (2),
 * TD-032 decision 4.
 *
 * The **plan** crosses a process boundary (the updater writes it into the apply container's
 * environment as `APP_UPDATE_PLAN`), so it is a strict zod schema like every boundary. It carries no
 * secret: the values the apply must carry over from the running containers it reads itself.
 *
 * The **state** is `updates/state.json` on the `updates` volume — written at every step, so a crashed
 * apply leaves the step it reached, and the next updater start finishes it: a non-terminal state with
 * no apply container running is rolled back; a terminal one not yet reported is reported.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { coreImageDigestsSchema } from '@platform/contracts';
import * as z from 'zod';
import { writeFileAtomically } from './env-file.js';

const referencesSchema = z.strictObject({
  platform: z.string().min(1).max(512),
  platform_launcher: z.string().min(1).max(512),
  platform_runtime: z.string().min(1).max(512),
  platform_egress: z.string().min(1).max(512),
});

const absolutePath = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => value.startsWith('/') && !value.split('/').includes('..'), 'an absolute path');

export const updatePlanSchema = z.strictObject({
  id: z.uuid(),
  /** `update`: apply `to`; `rollback`: a crashed apply's leftovers, back to `from`. */
  mode: z.enum(['update', 'rollback']),
  project: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, 'a compose project name'),
  working_dir: absolutePath,
  env_file: absolutePath,
  from: referencesSchema,
  to: referencesSchema,
  from_digests: coreImageDigestsSchema,
  to_digests: coreImageDigestsSchema,
  core_url: z.url(),
  worker_url: z.url(),
  check_seconds: z.int().min(1).max(3_600),
});
export type UpdatePlan = z.infer<typeof updatePlanSchema>;

export const updateStepSchema = z.enum([
  'launched',
  'pulled',
  'pinned',
  'up',
  'checked',
  'rolling_back',
  'done',
]);

export const updateStateSchema = z.strictObject({
  id: z.uuid(),
  mode: z.enum(['update', 'rollback']),
  step: updateStepSchema,
  /** `null` until the apply ends. */
  result: z.enum(['succeeded', 'rolled_back', 'failed']).nullable(),
  detail: z.string().max(4_096).nullable(),
  from_digests: coreImageDigestsSchema,
  to_digests: coreImageDigestsSchema,
  from: referencesSchema,
  to: referencesSchema,
  started_at: z.iso.datetime(),
  finished_at: z.iso.datetime().nullable(),
  /** Whether the core recorded the result (`update-report`). */
  reported: z.boolean(),
});
export type UpdateState = z.infer<typeof updateStateSchema>;

export const STATE_FILE = 'state.json';
/**
 * Where the person's install folder is mounted, in the updater and in every apply container
 * (`compose.worker.yml`: `${APP_WORKER_BUNDLE_DIR:-.}:/var/lib/platform/host-bundle`, S-22.21).
 */
export const HOST_BUNDLE_MOUNT = '/var/lib/platform/host-bundle';

/** The template of the build an update leaves, written by the updater before it launches the apply. */
export const PREVIOUS_TEMPLATE_FILE = 'compose.previous.yml';

export const statePathOf = (stateDir: string): string => path.join(stateDir, STATE_FILE);

/** `null` when there is none (never updated); an unreadable file is an error, never a fresh start. */
export const readState = async (stateDir: string): Promise<UpdateState | null> => {
  let text: string;
  try {
    text = await readFile(statePathOf(stateDir), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return updateStateSchema.parse(JSON.parse(text));
};

export const writeState = async (stateDir: string, state: UpdateState): Promise<void> => {
  await writeFileAtomically(
    statePathOf(stateDir),
    `${JSON.stringify(updateStateSchema.parse(state), null, 2)}\n`,
    0o644,
  );
};

export const isTerminal = (state: UpdateState): boolean => state.result !== null;
