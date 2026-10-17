/**
 * *Retry run*'s model field is a select over the organisation's model list (WP-159, backlog 498),
 * and both selects start on *Configured (…)*, naming the run read's `retry_defaults` (WP-167,
 * backlog 514).
 *
 * Driven through `createApp` with a fake server, as `run-cancel.test.tsx` is: the real router, query
 * client and endpoint parsers (`orgModelsResponseSchema`, `retryRunRequestSchema`), so a body the
 * client builds wrongly is caught at the same parse production runs. Every wait binds the thing it
 * asserts (rule 87): an option's presence, or the retry body the fake recorded.
 */
import type { RetryDefaults, RunRecord } from '@platform/contracts';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';
import {
  CONFIGURED_MODEL,
  modelOptionValue,
  OTHER_MODEL,
  retryModelOptions,
  retryModelRequest,
} from './run-retry-model.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-0000000000b1';
const RUN = '00000000-0000-4000-8000-0000000000c1';

const SESSION: SessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'member',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

const runOn = (model: string): RunRecord => ({
  id: RUN,
  task_id: TASK,
  project_id: PROJECT,
  stage: 'implementation',
  role: 'developer',
  mode: 'normal',
  attempt: 1,
  session_id: null,
  model,
  effort: 'high',
  provider_mode: 'api',
  prompt_version: 'test@1',
  status: 'failed',
  terminal_reason: 'error_during_execution',
  started_at: '2026-09-30T09:00:00.000Z',
  ended_at: '2026-09-30T09:05:00.000Z',
  last_output_at: null,
  num_turns: 1,
  usage: {
    input_tokens: 1,
    output_tokens: 1,
    cache_write_5m_tokens: 0,
    cache_write_1h_tokens: 0,
    cache_read_tokens: 0,
  },
  model_usage: [],
  cost: { usd: 0, is_estimate: false, price_list_id: null },
  wall_ms: 0,
  redaction_count: 0,
  settings_hash: null,
  start_failure: null,
  saved_work: null,
  latest_progress: null,
});

const LISTED = ['claude-fake-a', 'claude-fake-b', 'claude-fake-c'];

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface World {
  readonly run: RunRecord;
  /** The run read's `retry_defaults`: the stage's configured model and effort. */
  readonly defaults: RetryDefaults;
  /** `null` answers the model list with a 500. */
  readonly listed: readonly string[] | null;
  readonly retries: unknown[];
}

const fetchFor = (world: World) =>
  (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const path = new URL(url, 'http://localhost').pathname;
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    if (init?.method === 'POST' && path === `/api/runs/${RUN}/retry`) {
      world.retries.push(JSON.parse(String(init.body)));
      return json({
        run_id: RUN,
        task_id: TASK,
        status: 'failed',
        task_state: 'running',
        performed: true,
      });
    }
    if (path === '/api/org/models') {
      return world.listed === null
        ? json({ error: { code: 'internal', message: 'fake failure' } }, 500)
        : json({ models: world.listed.map((model_id) => ({ model_id })) });
    }
    if (path === `/api/runs/${RUN}/messages`) return json({ items: [], next_seq: null });
    if (path === `/api/runs/${RUN}/commands`) return json({ items: [] });
    if (path === `/api/runs/${RUN}`) return json({ ...world.run, retry_defaults: world.defaults });
    if (path === '/api/projects') return json({ items: [] });
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  window.history.pushState({}, '', `/runs/${RUN}`);
});

const open = async (
  model: string,
  listed: readonly string[] | null,
  defaults: RetryDefaults = { model, effort: 'high' },
) => {
  const world: World = { run: runOn(model), defaults, listed, retries: [] };
  const user = userEvent.setup();
  render(createApp({ fetchImpl: fetchFor(world), realtime: false }).element);
  const select = (await screen.findByLabelText('Retry with model')) as HTMLSelectElement;
  return { world, user, select };
};

/** Waits for the list's own options, so a case never asserts over the pre-answer field. */
const listedShown = async (select: HTMLSelectElement, id: string) => {
  await within(select).findByRole('option', { name: id });
};

const optionLabels = (select: HTMLSelectElement): string[] =>
  [...select.options].map((option) => option.textContent ?? '');

const retry = async (world: World, user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: 'Retry run' }));
  await waitFor(() => {
    expect(world.retries).toHaveLength(1);
  });
  return world.retries[0];
};

describe('Retry run’s model select (WP-159)', () => {
  it('offers Configured (…) first, then the server’s list, and preselects Configured', async () => {
    const { select } = await open('claude-fake-b', LISTED);
    await listedShown(select, 'claude-fake-c');
    expect(optionLabels(select)).toEqual(['Configured (claude-fake-b)', ...LISTED, 'Other…']);
    expect(select.value).toBe(CONFIGURED_MODEL);
  });

  it('sends no model when the selection is unchanged', async () => {
    const { world, user, select } = await open('claude-fake-b', LISTED);
    await listedShown(select, 'claude-fake-c');
    expect(await retry(world, user)).toEqual({});
  });

  it('sends a listed model without the flag', async () => {
    const { world, user, select } = await open('claude-fake-b', LISTED);
    await listedShown(select, 'claude-fake-c');
    await user.selectOptions(select, 'claude-fake-c');
    expect(await retry(world, user)).toEqual({ model: 'claude-fake-c' });
  });

  it('keeps an unlisted current model as its own option, labelled not priced', async () => {
    const { world, user, select } = await open('claude-custom-pinned', LISTED);
    await listedShown(select, 'claude-fake-a');
    expect(optionLabels(select)).toEqual([
      'Configured (claude-custom-pinned)',
      'claude-custom-pinned (not priced)',
      ...LISTED,
      'Other…',
    ]);
    expect(select.value).toBe(CONFIGURED_MODEL);
    // Never silently replaced: an unchanged submit still sends nothing.
    expect(await retry(world, user)).toEqual({});
  });

  it('sends a typed id with allow_unlisted_model from Other…', async () => {
    const { world, user, select } = await open('claude-fake-b', LISTED);
    await listedShown(select, 'claude-fake-c');
    await user.selectOptions(select, 'Other…');
    await user.type(await screen.findByLabelText('Other model id'), ' claude-next-fake ');
    expect(await retry(world, user)).toEqual({
      model: 'claude-next-fake',
      allow_unlisted_model: true,
    });
  });

  it('offers Configured, the run’s model and Other… with a notice when the list cannot be read', async () => {
    const { world, user, select } = await open('claude-fake-b', null);
    await screen.findByText('The model list could not be loaded.');
    expect(optionLabels(select)).toEqual(['Configured (claude-fake-b)', 'claude-fake-b', 'Other…']);
    expect(select.value).toBe(CONFIGURED_MODEL);
    expect(await retry(world, user)).toEqual({});
  });
});

/**
 * WP-167 ruling (a), backlog 514: a run that was itself an override (it ran `claude-fake-b` at
 * `high` on a stage configured `claude-fake-a` at `medium`). The default names what an unchanged
 * submit runs; "the run's own again" is an ordinary choice that is sent.
 */
describe('Retry run of an override run (WP-167)', () => {
  const OVERRIDE: RetryDefaults = { model: 'claude-fake-a', effort: 'medium' };

  it('preselects Configured (the configured model), not the run’s own', async () => {
    const { select } = await open('claude-fake-b', LISTED, OVERRIDE);
    await listedShown(select, 'claude-fake-c');
    expect(select.value).toBe(CONFIGURED_MODEL);
    expect(select.selectedOptions[0]?.textContent).toBe('Configured (claude-fake-a)');
  });

  it('sends no model and no effort for an unchanged submit', async () => {
    const { world, user, select } = await open('claude-fake-b', LISTED, OVERRIDE);
    await listedShown(select, 'claude-fake-c');
    const effort = screen.getByLabelText('Retry with effort') as HTMLSelectElement;
    expect(effort.selectedOptions[0]?.textContent).toBe('Configured (medium)');
    expect(await retry(world, user)).toEqual({});
  });

  it('sends the run’s own model and effort when they are chosen', async () => {
    const { world, user, select } = await open('claude-fake-b', LISTED, OVERRIDE);
    await listedShown(select, 'claude-fake-c');
    await user.selectOptions(select, 'claude-fake-b');
    await user.selectOptions(screen.getByLabelText('Retry with effort'), 'high');
    expect(await retry(world, user)).toEqual({ model: 'claude-fake-b', effort: 'high' });
  });
});

describe('the field’s two pure halves', () => {
  it('builds the retry body’s model half', () => {
    expect(retryModelRequest({ selected: CONFIGURED_MODEL, other: 'x' })).toEqual({});
    expect(retryModelRequest({ selected: modelOptionValue('n'), other: 'x' })).toEqual({
      model: 'n',
    });
    // A model id that spells a keyword is still a model: the prefix keeps them apart.
    expect(retryModelRequest({ selected: modelOptionValue('configured'), other: '' })).toEqual({
      model: 'configured',
    });
    expect(retryModelRequest({ selected: OTHER_MODEL, other: '  ' })).toEqual({});
    expect(retryModelRequest({ selected: OTHER_MODEL, other: ' x ' })).toEqual({
      model: 'x',
      allowUnlistedModel: true,
    });
  });

  it('labels the current model only once the list has answered without it', () => {
    const configured = { value: CONFIGURED_MODEL, label: 'Configured (c)' };
    expect(retryModelOptions('m', 'c', null)).toEqual([
      configured,
      { value: 'model:m', label: 'm' },
    ]);
    expect(retryModelOptions('m', 'c', ['a'])).toEqual([
      configured,
      { value: 'model:m', label: 'm (not priced)' },
      { value: 'model:a', label: 'a' },
    ]);
    expect(retryModelOptions('a', null, ['a'])).toEqual([
      { value: CONFIGURED_MODEL, label: 'Configured' },
      { value: 'model:a', label: 'a' },
    ]);
  });
});
