/**
 * Project configuration merge — technical/12 § "Effective configuration".
 *
 * "`effective = merge(defaults, org, project, repo)` with per-key provenance; computed at task
 * start and frozen into `Run.settings_snapshot`. Org maximum for autonomy and command policy caps
 * what project/repo may set (BD-025, BD-027)."
 *
 * Three rules, in the order they apply:
 *
 *  1. **Deep merge, later layer wins.** Objects merge key by key; scalars and arrays replace. Every
 *     leaf remembers which layer produced it, because "the UI shows the effective value per key
 *     with its source" (technical/12).
 *  2. **Autonomy is capped by the organisation.** A project or repository may turn the dial down,
 *     never up (BD-027).
 *  3. **The command policy only narrows below the organisation maximum** (BD-025). The
 *     organisation's own lists replace the shipped defaults for `allow`/`ask`; `block` only ever
 *     grows, at every layer.
 *
 * The repository layer is read from the project's **default branch**, never from the task branch
 * (BD-025) — that is the caller's job; this module only merges what it is handed.
 */
import type { AgenticConfig, AutonomyLevel, ConfigSource } from '@platform/contracts';
import { autonomyRank } from '../policies/autonomy.js';
import {
  type CommandVerdict,
  DEFAULT_COMMAND_POLICY,
  evaluateCommand,
  narrowCommandPolicy,
  type ResolvedCommandPolicy,
} from '../policies/command-policy.js';

/** A configuration layer's values: `.agentic/config.yml` minus the file-format `version`. */
export type ConfigValues = Omit<AgenticConfig, 'version'>;

export interface ConfigLayer {
  readonly source: ConfigSource;
  readonly values: ConfigValues;
}

/** Dot-path → the layer that produced the value at that path. */
export type ConfigProvenance = Readonly<Record<string, ConfigSource>>;

export interface EffectiveConfig {
  readonly values: ConfigValues;
  /** Provenance per leaf key, e.g. `stages.refinement.model` → `repo`. */
  readonly sources: ConfigProvenance;
  /** The three-list command policy after narrowing, with all three lists present. */
  readonly commands: ResolvedCommandPolicy;
  /** Allow entries a lower layer asked for that the organisation maximum does not grant. */
  readonly ignoredAllowCommands: readonly string[];
  /** Set when a layer asked for more autonomy than the organisation permits (BD-027). */
  readonly cappedAutonomy: {
    readonly requested: AutonomyLevel;
    readonly applied: AutonomyLevel;
  } | null;
}

/**
 * What the platform ships. technical/12's example file is the source for the shape; the values are
 * the documented defaults (BD-006 probation 5, BD-008 iteration limits, Q8 question timeout,
 * product/19 §2 protected paths, §4 significance thresholds, BD-028 feature defaults).
 */
export const PLATFORM_DEFAULT_CONFIG: ConfigValues = {
  project: {
    knowledge_dir: '.agentic/knowledge',
    communication_language: 'auto',
    commit_convention: 'conventional',
    default_branch: 'main',
  },
  pipeline: {
    limits: {
      code_review_iterations: 3,
      business_review_iterations: 2,
      ci_fix_iterations: 3,
      human_rounds: 3,
      question_timeout: '1 working day',
    },
  },
  policies: {
    autonomy: 'supervised',
    probation_tasks: 5,
    knowledge_apply: { auto_apply: false, discard_below: 0.2, proposal_above: 0.6 },
    dependency_policy: 'ask',
    drift_without_direction: 'disabled',
    protected_paths: [
      'tests/**',
      '**/*.test.*',
      '**/*.spec.*',
      '**/__tests__/**',
      '.gitlab-ci.yml',
      '.github/**',
      '.agentic/**',
      '.claude/**',
      'CLAUDE.md',
      'AGENTS.md',
      '.mcp.json',
      'Dockerfile*',
      'docker-compose*.yml',
      '**/migrations/**',
    ],
  },
  commands: {
    allow: [...DEFAULT_COMMAND_POLICY.allow],
    ask: [...DEFAULT_COMMAND_POLICY.ask],
    block: [...DEFAULT_COMMAND_POLICY.block],
  },
  features: {
    ticket_linter: { enabled: false },
    review_only: {
      enabled: false,
      trigger: 'label',
      label: 'agentic-review',
      severity_floor: 'major',
    },
    maintenance: { enabled: false, schedule: 'weekly', chores: ['deps', 'flaky', 'docs'] },
    digest: { enabled: true, at: '09:00', quiet_hours: null },
    shadow_mode: { enabled: false },
  },
};

// ── deep merge with provenance ───────────────────────────────────────────────

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Merges `patch` into `target`, recording the source of every leaf it writes.
 *
 * Arrays replace rather than concatenate: `protected_paths` and the command lists are complete
 * statements, and a project that shortens one means it.
 */
const mergeInto = (
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
  source: ConfigSource,
  prefix: string,
  sources: Record<string, ConfigSource>,
): void => {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      continue;
    }
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (isPlainObject(value)) {
      const existing = target[key];
      const next: Record<string, unknown> = isPlainObject(existing) ? { ...existing } : {};
      mergeInto(next, value, source, path, sources);
      target[key] = next;
      continue;
    }
    target[key] = value;
    sources[path] = source;
  }
};

// ── command policy ───────────────────────────────────────────────────────────

/**
 * The organisation maximum: the shipped defaults with the organisation's own lists applied.
 *
 * `allow` and `ask` are *replaced* when the organisation declares them — an admin editing the
 * maximum is stating it in full, and a project's commands (`make test-integration`) can only be
 * granted this way. `block` is the union, so nothing the platform blocks can be un-blocked.
 */
export const organisationCommandMaximum = (
  organisation: ConfigValues['commands'],
): ResolvedCommandPolicy => ({
  allow: organisation?.allow ?? DEFAULT_COMMAND_POLICY.allow,
  ask: organisation?.ask ?? DEFAULT_COMMAND_POLICY.ask,
  block: [...new Set([...DEFAULT_COMMAND_POLICY.block, ...(organisation?.block ?? [])])],
});

// ── the merge ────────────────────────────────────────────────────────────────

const LAYER_ORDER: readonly ConfigSource[] = ['default', 'org', 'project', 'repo'];

/**
 * Computes the effective configuration.
 *
 * Layers are applied in `default < org < project < repo` order regardless of the order they are
 * given in, so a caller cannot reorder precedence by accident. A layer may be omitted; `default`
 * is always present, seeded from `PLATFORM_DEFAULT_CONFIG` unless the caller supplies its own.
 */
export const mergeProjectConfig = (layers: readonly ConfigLayer[]): EffectiveConfig => {
  const bySource = new Map<ConfigSource, ConfigValues>();
  bySource.set('default', PLATFORM_DEFAULT_CONFIG);
  for (const layer of layers) {
    bySource.set(layer.source, layer.values);
  }

  const values: Record<string, unknown> = {};
  const sources: Record<string, ConfigSource> = {};
  for (const source of LAYER_ORDER) {
    const layer = bySource.get(source);
    if (layer === undefined) {
      continue;
    }
    // `commands` is merged by BD-025's narrowing rules, not by the generic deep merge.
    const { commands: _commands, ...rest } = layer;
    mergeInto(values, rest as Record<string, unknown>, source, '', sources);
  }

  // ── BD-025: the command policy narrows below the organisation maximum ──
  const maximum = organisationCommandMaximum(bySource.get('org')?.commands);
  const ignoredAllowCommands: string[] = [];
  let commands = maximum;
  for (const source of ['project', 'repo'] as const) {
    const narrowed = narrowCommandPolicy(commands, bySource.get(source)?.commands);
    commands = narrowed.policy;
    ignoredAllowCommands.push(...narrowed.ignoredAllow);
  }
  values.commands = {
    allow: [...commands.allow],
    ask: [...commands.ask],
    block: [...commands.block],
  };
  for (const source of LAYER_ORDER) {
    const declared = bySource.get(source)?.commands;
    if (declared?.allow !== undefined) {
      sources['commands.allow'] = source;
    }
    if (declared?.ask !== undefined) {
      sources['commands.ask'] = source;
    }
    if (declared?.block !== undefined) {
      sources['commands.block'] = source;
    }
  }

  // ── BD-027 / technical/12: the organisation caps the dial ──
  //
  // "Org maximum for autonomy … caps what project/repo may set." BD-027 does not say what the
  // maximum is when an organisation has never set one, and the shipped default is `supervised`
  // — so a silent organisation must not mean *unlimited*, or a repository could hand itself
  // `autonomous` by editing a file in its own tree (which BD-025 already distrusts). The cap is
  // therefore the organisation's value when it has one and the platform default otherwise; an
  // admin raises it by setting it, visibly and audibly (`config.changed`).
  const capSource: ConfigSource =
    bySource.get('org')?.policies?.autonomy === undefined ? 'default' : 'org';
  const cap = bySource.get(capSource)?.policies?.autonomy;
  const merged = values as ConfigValues;
  const requested = merged.policies?.autonomy;
  let cappedAutonomy: EffectiveConfig['cappedAutonomy'] = null;
  if (cap !== undefined && requested !== undefined && autonomyRank(requested) > autonomyRank(cap)) {
    cappedAutonomy = { requested, applied: cap };
    values.policies = { ...merged.policies, autonomy: cap };
    sources['policies.autonomy'] = capSource;
  }

  return {
    values: values as ConfigValues,
    sources,
    commands,
    ignoredAllowCommands,
    cappedAutonomy,
  };
};

/** Convenience: the verdict a command gets under an effective configuration. */
export const commandVerdictFor = (
  effective: EffectiveConfig,
  command: string,
  resolvedBinary?: string,
): CommandVerdict =>
  evaluateCommand(
    resolvedBinary === undefined ? { command } : { command, resolvedBinary },
    effective.commands,
  ).verdict;
