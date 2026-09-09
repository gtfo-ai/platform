/**
 * The JSON Schema publication set.
 *
 * `pnpm schemas` renders these into `schemas/` at the repository root; `pnpm schemas:check` fails
 * when the committed output no longer matches the zod definitions. The rendering lives here
 * rather than in the script so that it is covered by the test suite.
 *
 * Consumers:
 *  - the runner's structured-output contract (`outputFormat: { type: 'json_schema', schema }`,
 *    technical/04) uses the per-artifact `data` documents;
 *  - editors validating `.agentic/config.yml` and `.agentic/pipeline.yml` use the config
 *    documents (a YAML language server picks them up by file name);
 *  - anything outside this repository that needs to read the event log or a transcript.
 *
 * Every document is draft 2020-12 and self-contained: no `$ref` crosses a file boundary.
 */
import * as z from 'zod';
import {
  acceptanceCriterionSchema,
  artifactDataSchemas,
  artifactQuestionSchema,
  artifactRefSchema,
  artifactSchema,
  kbCitationSchema,
  reviewFindingSchema,
  validationCheckSchema,
} from './artifacts.js';
import {
  actorSchema,
  agentRoleSchema,
  artifactTypeSchema,
  autonomyLevelSchema,
  durationSchema,
  effortSchema,
  externalIdentitySchema,
  idSchema,
  isoDateTimeSchema,
  languageTagSchema,
  mergeRequestRefSchema,
  modelUsageSchema,
  nonEmptyStringSchema,
  pathPatternSchema,
  runCostSchema,
  runStatusSchema,
  runTerminalReasonSchema,
  sequenceSchema,
  severitySchema,
  shaSchema,
  sizeSchema,
  slugSchema,
  taskModeSchema,
  taskStateSchema,
  ticketRefSchema,
  timeOfDaySchema,
  tokenCountSchema,
  tokenUsageSchema,
  unitIntervalSchema,
  urlSchema,
  usdSchema,
  workspaceStatusSchema,
} from './common.js';
import { agenticConfigSchema } from './config.js';
import { domainEventSchema, domainEventTypeSchema, streamTypeSchema } from './events.js';
import { stabiliseDefs } from './json-schema-defs.js';
import { customStageSchema, pipelineFileSchema, stageSchema } from './pipeline.js';
import {
  answerChannelSchema,
  approvalRecordSchema,
  budgetScopeSchema,
  budgetWindowSchema,
  ciStatusSchema,
  configSourceSchema,
  contextPackRecordSchema,
  diffStatsSchema,
  feedbackRecordSchema,
  jsonObjectSchema,
  jsonValueSchema,
  knowledgeProposalRecordSchema,
  questionRecordSchema,
  taskTotalsSchema,
  workspaceRecordSchema,
} from './records.js';
import { contentBlockSchema, hookNameSchema, transcriptEventSchema } from './transcript.js';

/**
 * Stable `$defs` names for the schemas that appear more than once in a published document.
 *
 * Without them zod numbers the hoisted definitions in traversal order (`__schema0`, `__schema1`,
 * …), so inserting one event renumbers the whole file and every regeneration is an unreadable
 * diff. The registration is global on purpose — every JSON Schema and OpenAPI document generated
 * anywhere in the repository then names these shared definitions identically — and it is kept in
 * one place here rather than scattered over the definition sites.
 */
const SCHEMA_IDS: Readonly<Record<string, z.ZodType>> = {
  AcceptanceCriterion: acceptanceCriterionSchema,
  Actor: actorSchema,
  AgentRole: agentRoleSchema,
  AnswerChannel: answerChannelSchema,
  ApprovalRecord: approvalRecordSchema,
  ArtifactQuestion: artifactQuestionSchema,
  ArtifactRef: artifactRefSchema,
  ArtifactType: artifactTypeSchema,
  AutonomyLevel: autonomyLevelSchema,
  BudgetScope: budgetScopeSchema,
  BudgetWindow: budgetWindowSchema,
  CiStatus: ciStatusSchema,
  ConfigSource: configSourceSchema,
  ContentBlock: contentBlockSchema,
  ContextPackRecord: contextPackRecordSchema,
  CustomStage: customStageSchema,
  DiffStats: diffStatsSchema,
  DomainEventType: domainEventTypeSchema,
  Duration: durationSchema,
  Effort: effortSchema,
  ExternalIdentity: externalIdentitySchema,
  FeedbackRecord: feedbackRecordSchema,
  HookName: hookNameSchema,
  Id: idSchema,
  IsoDateTime: isoDateTimeSchema,
  JsonObject: jsonObjectSchema,
  JsonValue: jsonValueSchema,
  KbCitation: kbCitationSchema,
  KnowledgeProposalRecord: knowledgeProposalRecordSchema,
  LanguageTag: languageTagSchema,
  MergeRequestRef: mergeRequestRefSchema,
  ModelUsage: modelUsageSchema,
  NonEmptyString: nonEmptyStringSchema,
  PathPattern: pathPatternSchema,
  QuestionRecord: questionRecordSchema,
  ReviewFinding: reviewFindingSchema,
  RunCost: runCostSchema,
  RunStatus: runStatusSchema,
  RunTerminalReason: runTerminalReasonSchema,
  Sequence: sequenceSchema,
  Severity: severitySchema,
  Sha: shaSchema,
  Size: sizeSchema,
  Slug: slugSchema,
  Stage: stageSchema,
  StreamType: streamTypeSchema,
  TaskMode: taskModeSchema,
  TaskState: taskStateSchema,
  TaskTotals: taskTotalsSchema,
  TicketRef: ticketRefSchema,
  TimeOfDay: timeOfDaySchema,
  TokenCount: tokenCountSchema,
  TokenUsage: tokenUsageSchema,
  UnitInterval: unitIntervalSchema,
  Url: urlSchema,
  Usd: usdSchema,
  ValidationCheck: validationCheckSchema,
  WorkspaceRecord: workspaceRecordSchema,
  WorkspaceStatus: workspaceStatusSchema,
};

for (const [id, schema] of Object.entries(SCHEMA_IDS)) {
  z.globalRegistry.add(schema, { id });
}

export interface PublishedSchema {
  /** Path relative to the `schemas/` directory. */
  readonly file: string;
  readonly title: string;
  readonly description: string;
  readonly schema: z.ZodType;
}

const kebab = (pascal: string): string =>
  pascal.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

const artifactDataDocuments: PublishedSchema[] = Object.entries(artifactDataSchemas).map(
  ([type, schema]) => ({
    file: `artifacts/${kebab(type)}.schema.json`,
    title: `${type} data`,
    description: `Structured output of the stage that produces a ${type} artifact (technical/12).`,
    schema,
  }),
);

export const publishedSchemas: readonly PublishedSchema[] = [
  {
    file: 'domain-event.schema.json',
    title: 'Domain event',
    description:
      'One row of the append-only event log (technical/02 event catalogue, technical/03 events).',
    schema: domainEventSchema,
  },
  {
    file: 'artifact.schema.json',
    title: 'Artifact',
    description: 'A stage artifact with its envelope and type-specific data (technical/12).',
    schema: artifactSchema,
  },
  ...artifactDataDocuments,
  {
    file: 'agentic-config.schema.json',
    title: '.agentic/config.yml',
    description: 'Repository configuration; unknown keys are errors (technical/12).',
    schema: agenticConfigSchema,
  },
  {
    file: 'agentic-pipeline.schema.json',
    title: '.agentic/pipeline.yml',
    description: 'Optional full pipeline template definition (technical/12).',
    schema: pipelineFileSchema,
  },
  {
    file: 'transcript-event.schema.json',
    title: 'Transcript event',
    description:
      'Normalised, redacted run output as stored in run_messages and streamed over SSE (technical/04, technical/03).',
    schema: transcriptEventSchema,
  },
];

/** Render one published document. Exported for tests. */
export const renderJsonSchema = (document: PublishedSchema): string => {
  const jsonSchema = z.toJSONSchema(document.schema, {
    target: 'draft-2020-12',
    io: 'output',
    unrepresentable: 'throw',
    // Hoist every schema used more than once into `$defs`. Without it the event catalogue's
    // shared envelope is inlined 49 times and the document is half a megabyte.
    reused: 'ref',
  }) as Record<string, unknown>;
  const { $schema, ...rest } = stabiliseDefs(jsonSchema);
  const ordered = {
    $schema,
    title: document.title,
    description: document.description,
    ...rest,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
};

/** All published documents, keyed by their path relative to `schemas/`. */
export const renderAllJsonSchemas = (): Map<string, string> =>
  new Map(publishedSchemas.map((document) => [document.file, renderJsonSchema(document)]));

/** The index written next to the documents so a consumer can enumerate them. */
export const renderJsonSchemaIndex = (): string =>
  `${JSON.stringify(
    {
      $comment:
        'Generated by `pnpm schemas` from packages/contracts. Do not edit; run the script instead.',
      documents: publishedSchemas.map(({ file, title, description }) => ({
        file,
        title,
        description,
      })),
    },
    null,
    2,
  )}\n`;

export const SCHEMA_INDEX_FILE = 'index.json';
