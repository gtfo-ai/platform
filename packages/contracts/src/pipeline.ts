/**
 * `.agentic/pipeline.yml` — optional full template definition.
 *
 * Source: docs/technical/12-configuration-and-schemas.md § "`.agentic/pipeline.yml`". The file is
 * read from the default branch only (BD-025) and never carries secrets.
 *
 * This module validates the *shape* of a template. The graph rules technical/12 also lists —
 * every `requires` artifact is produced upstream, every transition target exists, no unbounded
 * cycle without an iteration limit — need the whole template at once and are enforced by the
 * pipeline interpreter (WP-15); `pipelineGraphIssues` here provides the same checks as a pure
 * function so both the config loader and the interpreter can share them.
 */
import * as z from 'zod';
import {
  agentRoleSchema,
  artifactTypeSchema,
  nonEmptyStringSchema,
  pathPatternSchema,
  slugSchema,
  stageIdSchema,
  templateIdSchema,
} from './common.js';
import { domainEventTypeSchema } from './events.js';

/** Stage kinds (technical/12). `system` stages are bookkeeping; `human` stages wait for people. */
export const stageKindSchema = z.enum(['system', 'agent', 'gate', 'human']);

/**
 * The three gates the platform evaluates itself, named by their stage id.
 *
 * technical/12's own `feature` template declares `rebase_gate` and `merged_gate` with neither an
 * `on` event nor a `command` — they are resolved by the platform reading the git provider, not by
 * anything the file can express. That is the whole reason a gate may omit both, and it is why the
 * exemption is an *enumeration* rather than a free pass: a project stage called `security_scan`
 * with neither would wait for an event that never arrives, which is a task parked for ever with no
 * error anywhere. `ci_gate` is listed because a project may legitimately re-declare it without
 * repeating `on: ci.pipeline.finished`.
 */
export const BUILTIN_GATE_STAGE_IDS = ['ci_gate', 'rebase_gate', 'merged_gate'] as const;

export type BuiltinGateStageId = (typeof BUILTIN_GATE_STAGE_IDS)[number];

export const isBuiltinGateStageId = (id: string): id is BuiltinGateStageId =>
  (BUILTIN_GATE_STAGE_IDS as readonly string[]).includes(id);

/**
 * The verdict vocabulary the interpreter transitions on (WP-15).
 *
 * `task_stages.outcome` and `task.stage.completed.verdict` are `text` on the wire because a
 * project's custom stage may report its own word, but the *shipped* transitions are decided by
 * these five and nothing else — technical/12: "Verdict fields drive transitions; the platform
 * never parses markdown to decide." An agent stage reports `approve`, `request_changes`, `reject`
 * or `questions`; a gate reports `pass` or `fail`. Anything else, or nothing at all, escalates
 * rather than guessing a transition.
 */
export const stageVerdictSchema = z.enum([
  'approve',
  'request_changes',
  'reject',
  'questions',
  'pass',
  'fail',
]);

export type StageVerdict = z.infer<typeof stageVerdictSchema>;

/** A transition an event triggers from a `human` stage. */
export const stageTransitionSchema = z.strictObject({
  on: domainEventTypeSchema,
  to: stageIdSchema,
});

export const systemStageSchema = z.strictObject({
  id: stageIdSchema,
  kind: z.literal('system'),
  enabled: z.boolean().optional(),
});

export const agentStageSchema = z.strictObject({
  id: stageIdSchema,
  kind: z.literal('agent'),
  role: agentRoleSchema,
  enabled: z.boolean().optional(),
  produces: artifactTypeSchema.optional(),
  requires: z.array(artifactTypeSchema).optional(),
  approve_to: stageIdSchema.optional(),
  return_to: stageIdSchema.optional(),
  next: stageIdSchema.optional(),
  /** Repository-relative path to a prompt that replaces the shipped role prompt. */
  prompt: pathPatternSchema.optional(),
  prompt_append: pathPatternSchema.optional(),
});

/**
 * A gate has to say how it is resolved, and may say it only once.
 *
 * Both fields were optional and unchecked until WP-15, so `- id: security_scan; kind: gate` parsed
 * happily and produced a stage nothing could ever settle. The rule is therefore:
 *
 *  - `on` **and** `command` together are refused: two answers to "what resolves this?" is one
 *    answer too many, and which one wins would be an implementation detail rather than a decision;
 *  - neither is refused **unless** the id is one of {@link BUILTIN_GATE_STAGE_IDS}, which the
 *    platform evaluates itself.
 *
 * The `check` is invisible to `z.toJSONSchema` — a custom refinement has no JSON Schema
 * counterpart and is dropped silently — so an editor validating `pipeline.yml` against
 * `schemas/pipeline.schema.json` will not see it. The zod schema is the enforcement point; the
 * published document is a convenience.
 */
export const gateStageSchema = z
  .strictObject({
    id: stageIdSchema,
    kind: z.literal('gate'),
    enabled: z.boolean().optional(),
    /** The event that resolves the gate, e.g. `ci.pipeline.finished`. */
    on: domainEventTypeSchema.optional(),
    /** A deterministic command run in the workspace instead of waiting for an event. */
    command: nonEmptyStringSchema.optional(),
    pass_to: stageIdSchema.optional(),
    fail_to: stageIdSchema.optional(),
  })
  .check((ctx) => {
    const hasOn = ctx.value.on !== undefined;
    const hasCommand = ctx.value.command !== undefined;
    if (hasOn && hasCommand) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        path: ['command'],
        message: `gate "${ctx.value.id}" sets both "on" and "command"; a gate is resolved by exactly one of them`,
      });
      return;
    }
    if (!hasOn && !hasCommand && !isBuiltinGateStageId(ctx.value.id)) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        path: ['on'],
        message: `gate "${ctx.value.id}" sets neither "on" nor "command", and only the built-in gates (${BUILTIN_GATE_STAGE_IDS.join(', ')}) are resolved by the platform itself`,
      });
    }
  });

export const humanStageSchema = z.strictObject({
  id: stageIdSchema,
  kind: z.literal('human'),
  enabled: z.boolean().optional(),
  on: z.array(stageTransitionSchema),
});

export const stageSchema = z.discriminatedUnion('kind', [
  systemStageSchema,
  agentStageSchema,
  gateStageSchema,
  humanStageSchema,
]);

/**
 * A project-defined stage spliced into a shipped template after `after` (technical/12
 * `custom_stages` / `templates.*.custom`). It registers a handler on the predecessor's
 * `task.stage.completed` (technical/02).
 */
export const customStageSchema = z
  .strictObject({
    id: stageIdSchema,
    kind: z.enum(['agent', 'gate']),
    after: stageIdSchema,
    role: agentRoleSchema.optional(),
    prompt: pathPatternSchema.optional(),
    command: nonEmptyStringSchema.optional(),
    produces: artifactTypeSchema.optional(),
    pass_to: stageIdSchema.optional(),
    fail_to: stageIdSchema.optional(),
  })
  .check((ctx) => {
    // A custom stage is never a built-in, so nothing evaluates it for the project: a gate that
    // names no command, or an agent with neither a shipped role nor a prompt to run, is a stage
    // the interpreter would enter and never leave.
    if (ctx.value.kind === 'gate' && ctx.value.command === undefined) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        path: ['command'],
        message: `custom gate "${ctx.value.id}" needs a "command": the platform evaluates only its own built-in gates`,
      });
    }
    if (
      ctx.value.kind === 'agent' &&
      ctx.value.role === undefined &&
      ctx.value.prompt === undefined
    ) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        path: ['role'],
        message: `custom agent stage "${ctx.value.id}" needs a "role" or a "prompt"`,
      });
    }
  });

export const pipelineTemplateSchema = z.strictObject({
  stages: z.array(stageSchema).min(1),
  custom: z.array(customStageSchema).optional(),
});

/** The whole `.agentic/pipeline.yml`. `version` is a major; the platform refuses unknown majors. */
export const pipelineFileSchema = z.strictObject({
  version: z.literal(1),
  templates: z.record(templateIdSchema, pipelineTemplateSchema),
});

// ── Graph validation (technical/12) ──────────────────────────────────────────

/** A structural problem in a template graph, reported with the stage it belongs to. */
export const pipelineIssueSchema = z.strictObject({
  code: z.enum(['unknown_target', 'duplicate_stage_id', 'missing_artifact', 'unknown_predecessor']),
  stage: slugSchema,
  detail: nonEmptyStringSchema,
});

export type PipelineIssue = z.infer<typeof pipelineIssueSchema>;
export type Stage = z.infer<typeof stageSchema>;
export type CustomStage = z.infer<typeof customStageSchema>;
export type PipelineTemplate = z.infer<typeof pipelineTemplateSchema>;
export type PipelineFile = z.infer<typeof pipelineFileSchema>;
export type StageKind = z.infer<typeof stageKindSchema>;

const targetsOf = (stage: Stage | CustomStage): string[] => {
  const targets: string[] = [];
  if ('approve_to' in stage && stage.approve_to) targets.push(stage.approve_to);
  if ('return_to' in stage && stage.return_to) targets.push(stage.return_to);
  if ('next' in stage && stage.next) targets.push(stage.next);
  if ('pass_to' in stage && stage.pass_to) targets.push(stage.pass_to);
  if ('fail_to' in stage && stage.fail_to) targets.push(stage.fail_to);
  if (stage.kind === 'human') targets.push(...stage.on.map((transition) => transition.to));
  return targets;
};

/**
 * Structural checks over one template: duplicate ids, transitions to stages that do not exist,
 * custom stages hung off an unknown predecessor, and `requires` artifacts that nothing upstream
 * produces. Returns an empty array for a valid template.
 */
export const pipelineGraphIssues = (template: PipelineTemplate): PipelineIssue[] => {
  const issues: PipelineIssue[] = [];
  const custom = template.custom ?? [];
  const ids = new Set<string>();

  for (const stage of [...template.stages, ...custom]) {
    if (ids.has(stage.id)) {
      issues.push({
        code: 'duplicate_stage_id',
        stage: stage.id,
        detail: `stage id "${stage.id}" is declared more than once`,
      });
    }
    ids.add(stage.id);
  }

  for (const stage of [...template.stages, ...custom]) {
    for (const target of targetsOf(stage)) {
      if (!ids.has(target)) {
        issues.push({
          code: 'unknown_target',
          stage: stage.id,
          detail: `transition target "${target}" is not a stage of this template`,
        });
      }
    }
  }

  for (const stage of custom) {
    if (!ids.has(stage.after)) {
      issues.push({
        code: 'unknown_predecessor',
        stage: stage.id,
        detail: `custom stage follows "${stage.after}", which is not a stage of this template`,
      });
    }
  }

  const produced = new Set<string>();
  for (const stage of template.stages) {
    for (const required of ('requires' in stage ? stage.requires : undefined) ?? []) {
      if (!produced.has(required)) {
        issues.push({
          code: 'missing_artifact',
          stage: stage.id,
          detail: `requires "${required}", which no earlier stage produces`,
        });
      }
    }
    if ('produces' in stage && stage.produces) produced.add(stage.produces);
  }

  return issues;
};
