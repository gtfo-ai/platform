/**
 * **A binding credential committed to `.agentic/prompts/` is not stored, not sent and not kept** —
 * WP-107, TD-012's M6 amendment (2), PROGRESS backlog 316.
 *
 * The planted value is a credential the platform holds for one of the project's bindings and that
 * no pattern rule knows (a Jira API token has no fixed shape). The case follows it the whole way the
 * backlog entry traced: through `refreshRepositoryConfig` into the stored reading, and from that
 * stored reading through the real planner and the real stage executor into what `runs.insert` is
 * handed for `runs.user_prompt` — the column `GET /api/runs/:id/prompt` serves. The pattern redactor
 * here is the identity, so nothing but the exact-value pass can remove it: a refresh that skips that
 * pass fails the first assertion by name (the canary in PROGRESS.md under WP-107).
 */

import type { IsoDateTime } from '@platform/contracts';
import { type DomainEvent, domainEventSchemasByType, type Id } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import type { NewRun } from '../pipeline/store.js';
import { askingRefinedSpec } from '../testing/artifact-fixtures.js';
import { createPipelineHarness, type PipelineHarness } from '../testing/pipeline-harness.js';
import {
  type ConfigDocumentCodec,
  type ProjectBindingSecrets,
  REPOSITORY_CONFIG_PATH,
  type RepositoryConfigSnapshot,
  type RepositoryConfigStore,
  type RepositoryFileSource,
  type RepositoryFilesResult,
  refreshRepositoryConfig,
} from './repository-config.js';

const PROJECT = '00000000-0000-4000-8000-0000000001b7' as Id;
const AT = '2026-10-01T09:00:00.000Z' as IsoDateTime;
const SHA = 'c'.repeat(40);

/**
 * The project's Jira API token, as the secret store decrypts it. Obviously fake, and shaped like no
 * provider's token (rule 93): no pattern rule matches it, which is the whole trigger.
 */
const JIRA_TOKEN = 'FAKE-wp107-jira-api-token-not-real-0001';
const NAME = 'jira-cloud:00000000-0000-4000-8000-00000000a107:api_token';
const PLACEHOLDER = `[REDACTED:integration:${NAME}]`;

const PROMPT_PATH = '.agentic/prompts/refinement.md';
const PROMPT_TEXT = `Query the tracker with the token ${JIRA_TOKEN} when you need history.`;

const jsonCodec: ConfigDocumentCodec = {
  parse: (text) => ({ ok: true, value: JSON.parse(text) as unknown }),
  stringify: (document) => JSON.stringify(document),
};

const sourceOf = (read: RepositoryFilesResult): RepositoryFileSource => ({
  read: async () => read,
});

const recordingStore = () => {
  const recorded: RepositoryConfigSnapshot[] = [];
  const store: RepositoryConfigStore = {
    read: async () => null,
    record: async (_projectId, snapshot) => {
      recorded.push(snapshot);
      return true;
    },
  };
  return { recorded, store };
};

/** The project's Sentry token, which no longer decrypts — so its value is unknown to the reading. */
const SENTRY_TOKEN = 'FAKE-wp107-sentry-token-not-real-0358';
const BROKEN = 'integration "acme sentry" (sentry, 00000000-0000-4000-8000-00000000a358)';
/** A merged tightening: the repository narrows `commands.allow` to one command. */
const TIGHTENED = JSON.stringify({ version: 1, commands: { allow: ['pnpm test'] } });

interface Line {
  readonly level: string;
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

const refreshWith = async (
  credentials: ProjectBindingSecrets,
  options: { readonly configText?: string; readonly promptText?: string } = {},
) => {
  const { recorded, store } = recordingStore();
  const asked: Id[] = [];
  const lines: Line[] = [];
  const at =
    (level: string) =>
    (fields: Record<string, unknown>, message: string): void => {
      lines.push({ level, fields, message });
    };
  const outcome = await refreshRepositoryConfig(
    {
      source: sourceOf({
        status: 'ok',
        commitSha: SHA,
        files: {
          [REPOSITORY_CONFIG_PATH]:
            options.configText === undefined
              ? { kind: 'absent' }
              : { kind: 'file', text: options.configText, blobSha: 'e'.repeat(40) },
        },
        prompts: {
          files: {
            [PROMPT_PATH]: {
              kind: 'file',
              text: options.promptText ?? PROMPT_TEXT,
              blobSha: 'd'.repeat(40),
            },
          },
          truncated: false,
        },
      }),
      codec: jsonCodec,
      store,
      // The identity: the planted value is one no pattern rule knows, so step 2 cannot be what
      // removes it.
      redactText: (value) => value,
      bindingSecrets: async (projectId) => {
        asked.push(projectId);
        return credentials;
      },
      clock: { now: () => AT },
      logger: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') },
    },
    { projectId: PROJECT },
  );
  return { outcome, recorded, asked, lines };
};

const ticketMatched = (): DomainEvent =>
  domainEventSchemasByType['ticket.matched'].parse({
    id: '00000000-0000-4000-9000-000000000107',
    stream_type: 'project',
    stream_id: PROJECT,
    stream_seq: 1,
    correlation_id: null,
    cause_event_id: null,
    actor: { kind: 'integration', integration_id: PROJECT, provider: 'fake-jira' },
    occurred_at: '2026-10-01T09:00:00.000Z',
    type: 'ticket.matched',
    payload: {
      project_id: PROJECT,
      ticket: { provider: 'fake-jira', key: 'ACME-107', url: 'https://jira.example.test/ACME-107' },
      rule: 'label:agentic',
      priority: null,
      issue_type: 'Story',
      epic: null,
      links: [],
    },
  }) as DomainEvent;

/** The refinement run's `runs.insert`, driven from the stored reading by the real planner. */
const runStoredFrom = async (
  snapshot: RepositoryConfigSnapshot,
): Promise<{ readonly userPrompt: string; readonly run: NewRun }> => {
  const harness: PipelineHarness = createPipelineHarness({
    projectId: PROJECT,
    // What the production settings port hands the planner from a stored reading (`pipeline.ts`).
    settings: {
      repositoryPrompts: snapshot.prompts ?? null,
      repositoryPromptsWithheld: snapshot.promptsWithheld ?? null,
    },
    runs: {
      refinement: {
        status: 'completed',
        terminalReason: 'success',
        structuredOutput: askingRefinedSpec(undefined, { goal: 'ship the footer' }),
      },
    },
  });
  const rows: NewRun[] = [];
  const repository = harness.store.runs as { insert: typeof harness.store.runs.insert };
  const original = repository.insert.bind(harness.store.runs);
  repository.insert = async (tx, run) => {
    rows.push(run);
    await original(tx, run);
  };
  await harness.publish([ticketMatched()]);
  const run = rows[0];
  if (run === undefined || typeof run.userPrompt !== 'string') {
    throw new Error('no run was started, or its prompt was not recorded');
  }
  return { userPrompt: run.userPrompt, run };
};

const userPromptStoredFrom = async (snapshot: RepositoryConfigSnapshot): Promise<string> =>
  (await runStoredFrom(snapshot)).userPrompt;

describe('a binding credential committed to a project prompt file (WP-107)', () => {
  it('is absent from the stored reading and from runs.user_prompt, replaced by its binding’s placeholder', async () => {
    const { outcome, recorded, asked } = await refreshWith({
      secrets: [{ name: NAME, value: JIRA_TOKEN }],
      unreadable: [],
    });
    expect(outcome).toMatchObject({ status: 'recorded', promptsWithheld: null });
    expect(asked).toEqual([PROJECT]);
    const stored = recorded[0];
    expect(stored, 'nothing was recorded').toBeDefined();
    // The stored reading: the value gone, the placeholder naming the binding's field in its place.
    expect(
      JSON.stringify(stored),
      'the stored reading carries the binding credential',
    ).not.toContain(JIRA_TOKEN);
    const entry = stored?.prompts?.files[PROMPT_PATH];
    expect(entry?.kind === 'file' ? entry.text : null).toBe(
      `Query the tracker with the token ${PLACEHOLDER} when you need history.`,
    );

    // The run: the stored reading is what the planner renders, so `runs.user_prompt` — and the
    // prompt the runner is handed, which it equals — never held the value.
    const userPrompt = await userPromptStoredFrom(stored as RepositoryConfigSnapshot);
    expect(userPrompt, 'runs.user_prompt carries the binding credential').not.toContain(JIRA_TOKEN);
    expect(userPrompt).toContain(PLACEHOLDER);
  });

  /**
   * WP-121 (TD-012's M7 amendment (2), PROGRESS backlogs 362 and 364): the exact-value set is every
   * credential the platform holds for the project — a declared credential field left in a binding's
   * `integrations.config`, and the organisation's chat account, which no project binds. Named as
   * `createProjectBindingSecrets` names them (its own cases in `packages/integrations` pin that it
   * answers both; `test/integration/config/prompt-reread.integration.test.ts` drives the production
   * composition); here, what the reading and the run's prompt column do with them.
   */
  it('is absent from the stored reading and from runs.user_prompt for a config-held field and an organisation account’s token (WP-121)', async () => {
    const CONFIG_HELD = 'FAKE-wp121-jira-webhook-secret-in-config-0362';
    const ORGANISATION = 'FAKE-wp121-organisation-chat-token-0364';
    const configName = 'jira-cloud:00000000-0000-4000-8000-00000000a107:webhook_secret';
    const organisationName = 'slack:00000000-0000-4000-8000-00000000a364:bot_token';
    const { recorded } = await refreshWith(
      {
        secrets: [
          { name: NAME, value: JIRA_TOKEN },
          { name: configName, value: CONFIG_HELD },
          { name: organisationName, value: ORGANISATION },
        ],
        unreadable: [],
      },
      { promptText: `Verify deliveries with ${CONFIG_HELD}; announce as ${ORGANISATION}.` },
    );
    const stored = recorded[0] as RepositoryConfigSnapshot;
    for (const planted of [CONFIG_HELD, ORGANISATION]) {
      expect(JSON.stringify(stored), 'the stored reading carries a credential').not.toContain(
        planted,
      );
    }
    const entry = stored.prompts?.files[PROMPT_PATH];
    expect(entry?.kind === 'file' ? entry.text : null).toBe(
      `Verify deliveries with [REDACTED:integration:${configName}]; announce as [REDACTED:integration:${organisationName}].`,
    );
    const userPrompt = await userPromptStoredFrom(stored);
    for (const planted of [CONFIG_HELD, ORGANISATION]) {
      expect(userPrompt, 'runs.user_prompt carries a credential').not.toContain(planted);
    }
    expect(userPrompt).toContain(`[REDACTED:integration:${organisationName}]`);
  });

  /**
   * The other direction (standing rule 42), and the reason the option is required rather than
   * defaulted: with no credential to redact against, the value is stored and reaches the run's
   * prompt column — the defect backlog 316 described, reproduced here so the case above is known to
   * be about the exact-value pass and nothing else.
   */
  it('reaches runs.user_prompt verbatim when the reading is given no credential — the defect, reproduced', async () => {
    const { recorded } = await refreshWith({ secrets: [], unreadable: [] });
    const userPrompt = await userPromptStoredFrom(recorded[0] as RepositoryConfigSnapshot);
    expect(userPrompt).toContain(JIRA_TOKEN);
  });

  /**
   * PROGRESS backlog 358, the orchestrator's ruling: **a broken binding never keeps a restriction
   * from applying.** One integration's credentials do not decrypt (a Sentry token sealed under a
   * retired key); a merged `commands.allow` narrowed to one command is in the stored reading; the
   * prompt file — which may quote the broken integration's credential, unknown to the reading — is
   * not stored at all; and the answer and an `error` line name the integration.
   */
  it('stores a merged restriction and withholds every prompt text while an integration’s credentials cannot be decrypted', async () => {
    const { outcome, recorded, lines } = await refreshWith(
      {
        secrets: [{ name: NAME, value: JIRA_TOKEN }],
        unreadable: [{ integration: BROKEN, reason: 'secret … is sealed under key "v1:old"' }],
      },
      { configText: TIGHTENED, promptText: `Ask Sentry with ${SENTRY_TOKEN}.` },
    );
    const stored = recorded[0];
    // The configuration half: stored, the restriction in it.
    expect(outcome.status).toBe('recorded');
    expect(stored?.status).toBe('valid');
    expect(stored?.status === 'valid' && stored.values).toEqual({
      commands: { allow: ['pnpm test'] },
    });
    // The prompt half: not stored new — no directory at all, so no previous text stands either.
    expect(stored?.prompts, 'the reading stored prompt texts it could not redact').toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain(SENTRY_TOKEN);
    // Named: on the answer, and at `error`.
    const withheld = outcome.status === 'recorded' ? outcome.promptsWithheld : null;
    expect(withheld).toContain(BROKEN);
    expect(withheld).toContain('sealed under key "v1:old"');
    const error = lines.find((line) => line.level === 'error');
    expect(error?.fields).toMatchObject({ unreadable_integrations: [BROKEN] });
    expect(error?.message).toContain(BROKEN);
    // WP-121 (backlog 363): recorded on the reading itself, not only logged.
    expect(stored?.promptsWithheld).toEqual({
      reason: withheld,
      integrations: [{ integration: BROKEN, reason: 'secret … is sealed under key "v1:old"' }],
    });
    // A run planned from this reading proceeds, with no prompt file and no credential — and the
    // record frozen on its row, so the missing file says why (`runs.prompts_withheld`).
    const { userPrompt, run } = await runStoredFrom(stored as RepositoryConfigSnapshot);
    expect(userPrompt).not.toContain(SENTRY_TOKEN);
    expect(userPrompt).not.toContain('Ask Sentry');
    expect(run.promptsWithheld).toEqual(stored?.promptsWithheld);
  });

  it('records nothing withheld on the run when the reading withheld nothing (WP-121)', async () => {
    const { recorded } = await refreshWith({
      secrets: [{ name: NAME, value: JIRA_TOKEN }],
      unreadable: [],
    });
    expect(recorded[0]?.promptsWithheld).toBeUndefined();
    const { run } = await runStoredFrom(recorded[0] as RepositoryConfigSnapshot);
    expect(run.promptsWithheld).toBeNull();
  });
});
