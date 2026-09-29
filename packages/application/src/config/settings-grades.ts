/**
 * The settings-layer keys the platform parses and does not read — reported at the **settings
 * write** as they already are at the repository read (WP-91, the row's ruling; PROGRESS backlogs
 * 220 and 226).
 *
 * `PUT /api/projects/:id/config` accepts the whole strict document, and until WP-91 a key that
 * nothing reads was stored with a `200` and no signal: an operator who wrote
 * `business_review: { enabled: false }` still got a business review. The repository read already
 * reported the same keys (`repository-grades.ts`, where the file's whole `template_overrides` is
 * `not_applied`). The settings layer now answers the same way: the write is **accepted** — the
 * document is valid, and refusing it would break every stored document that carries the key
 * (backlog 58's lesson) — and its response names every such key with the reason, as does
 * `GET …/config` for as long as the stored document carries it.
 *
 * Only keys with **no reader at all** are listed. A key that is read and merely bounded (a WIP
 * limit above the organisation's) is reported by its own reader, not here.
 *
 *  - `pipeline.template_overrides.<t>.stages.<s>.enabled` — the interpreter honours a disabled
 *    stage, but nothing applies this key to a task's template snapshot (backlog 220); the reader
 *    waits on **Q99**, which decides what a stage set without a scope stage runs.
 *  - `pipeline.template_overrides.<t>.enabled` — no specified meaning at all (refuse a ticket of
 *    that template? fall back to another?), which is Q99's question too.
 *  - `pipeline.custom_stages` — declined for 0.1 (M5: Q56 has no loop counter for a custom stage).
 *
 * `stages.<s>.prompt` / `prompt_append` **are** read since WP-92 (`project-prompts.ts`) and left
 * this table; what is still reported of them is a **value** naming a file outside
 * `.agentic/prompts/`, which no reader reads (`projectPromptValueNotApplied`, the same function the
 * repository reading uses).
 *
 * `plan_approval` and `size_threshold` under `template_overrides` **are** read (the plan-approval
 * gate) and are not listed.
 */
import type { ConfigValues } from '@platform/domain';
import { projectPromptValueNotApplied } from './project-prompts.js';
import type { RepositoryConfigNotApplied } from './repository-config.js';

const STAGE_ENABLED_REASON =
  'switching a stage off is not applied on this build: nothing applies the key to a task’s template (PROGRESS backlog 220), and its reader waits on Q99; the stage still runs';
const TEMPLATE_ENABLED_REASON =
  'a template-level switch has no meaning on this build (backlog 220, Q99): tickets of this template still run it';

/** Every unread settings key, `*` standing for a user-chosen key, with the reason published. */
export const SETTINGS_UNREAD_KEYS: Readonly<Record<string, string>> = {
  'pipeline.template_overrides.*.enabled': TEMPLATE_ENABLED_REASON,
  'pipeline.template_overrides.*.stages.*.enabled': STAGE_ENABLED_REASON,
  'pipeline.custom_stages':
    'custom stages are not read on this build (a custom stage has no loop counter, Q56)',
};

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The concrete dotted paths `segments` (with `*` for any key) names in `target`. */
const pathsPresent = (target: unknown, segments: readonly string[], prefix: string): string[] => {
  const [head, ...rest] = segments;
  if (head === undefined || !isObject(target)) return [];
  const keys = head === '*' ? Object.keys(target) : [head];
  const found: string[] = [];
  for (const key of keys) {
    if (!Object.hasOwn(target, key) || target[key] === undefined) continue;
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (rest.length === 0) {
      found.push(path);
    } else {
      found.push(...pathsPresent(target[key], rest, path));
    }
  }
  return found;
};

/**
 * What a settings document states that this build does not read, in the table's order and then
 * the document's. Empty for a document that carries none — which is every shipped default.
 */
export const settingsNotApplied = (values: ConfigValues): readonly RepositoryConfigNotApplied[] => [
  ...Object.entries(SETTINGS_UNREAD_KEYS).flatMap(([pattern, reason]) =>
    pathsPresent(values, pattern.split('.'), '').map((key) => ({ key, reason })),
  ),
  ...projectPromptValueNotApplied(values),
];
