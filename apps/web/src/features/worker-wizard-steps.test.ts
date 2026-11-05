/**
 * The *Add a worker* wizard's rules (S-23.20), as rules: done-ness, what may be passed, the resume
 * point, *Continue*'s reasons, which worker is "from this wizard", and the commands' origin.
 */
import type { ProjectExecutionResponse } from '@platform/contracts';
import { REMOTE_RUN_CREDENTIAL_REFUSED_NOTICE } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { NOW, USER_ID, workerFixture } from './worker.test-fixture.js';
import {
  blockingWorkerStepOf,
  INSTALLER_AVAILABLE,
  preferredInstallOs,
  projectTakesWorkers,
  resumeWorkerStepOf,
  WORKER_WIZARD_STEP_IDS,
  type WorkerWizardFacts,
  wizardWorkerOf,
  workerContinueBlockerOf,
  workerInstallCommands,
  workerWizardDonenessOf,
} from './worker-wizard-steps.js';

const facts = (over: Partial<WorkerWizardFacts> = {}): WorkerWizardFacts => ({
  installed: false,
  worker: false,
  canClaim: null,
  projectTakesWorkers: null,
  ...over,
});

describe('the worker wizard’s done-ness and gating', () => {
  it('opens at Install and holds every later step behind it', () => {
    const done = workerWizardDonenessOf(facts());
    expect(resumeWorkerStepOf(done)).toBe('install');
    expect(blockingWorkerStepOf('start', done)).toBe('install');
    expect(blockingWorkerStepOf('ready', done)).toBe('install');
    expect(workerContinueBlockerOf('install', done)).toMatch(/I’ve done this/);
  });

  it('takes the person’s word for Install, and lets Start be passed before any worker exists', () => {
    const done = workerWizardDonenessOf(facts({ installed: true }));
    expect(done.install).toBe(true);
    expect(done.start).toBe(false);
    // A person may already hold the code: Start never holds Continue.
    expect(workerContinueBlockerOf('start', done)).toBeNull();
    expect(blockingWorkerStepOf('approve', done)).toBeNull();
    // …but Approve does, until the worker exists.
    expect(blockingWorkerStepOf('ready', done)).toBe('approve');
    expect(workerContinueBlockerOf('approve', done)).toMatch(/approved and the worker connects/);
    expect(resumeWorkerStepOf(done)).toBe('start');
  });

  it('marks Install, Start and Approve done once a worker from this wizard exists', () => {
    const done = workerWizardDonenessOf(facts({ worker: workerFixture(), canClaim: false }));
    expect([done.install, done.start, done.approve, done.ready]).toEqual([true, true, true, false]);
    expect(resumeWorkerStepOf(done)).toBe('ready');
    expect(blockingWorkerStepOf('projects', done)).toBe('ready');
    expect(workerContinueBlockerOf('ready', done)).toMatch(/can take work/);
  });

  it('opens Choose projects once the worker can take work, and never gates on that optional step', () => {
    const done = workerWizardDonenessOf(facts({ worker: workerFixture(), canClaim: true }));
    expect(blockingWorkerStepOf('projects', done)).toBeNull();
    expect(resumeWorkerStepOf(done)).toBe('projects');
    expect(workerContinueBlockerOf('projects', done)).toBeNull();
  });

  it('says nothing is known while the workers read is in flight, rather than "not done"', () => {
    const done = workerWizardDonenessOf(facts({ worker: null }));
    expect(resumeWorkerStepOf(done)).toBeNull();
    expect(blockingWorkerStepOf('approve', done)).toBeUndefined();
    expect(workerContinueBlockerOf('approve', done)).toBe('Checking your workers…');
    // The person's own word does not wait for the read.
    expect(workerWizardDonenessOf(facts({ worker: null, installed: true })).install).toBe(true);
  });

  it('lists five steps, the last one optional', () => {
    expect(WORKER_WIZARD_STEP_IDS).toEqual(['install', 'start', 'approve', 'ready', 'projects']);
  });
});

describe('wizardWorkerOf', () => {
  const since = NOW - 60_000;
  it('is the newest active worker of this person created since the wizard opened', () => {
    const old = workerFixture({ id: 'old', created_at: new Date(since - 1).toISOString() });
    const first = workerFixture({ id: 'first', created_at: new Date(since).toISOString() });
    const second = workerFixture({ id: 'second', created_at: new Date(since + 5).toISOString() });
    const theirs = workerFixture({
      id: 'theirs',
      created_at: new Date(since + 10).toISOString(),
      user: { id: 'someone-else', email: 'x@example.invalid', name: null },
    });
    const revoked = workerFixture({
      id: 'revoked',
      created_at: new Date(since + 20).toISOString(),
      state: 'revoked',
    });
    const found = wizardWorkerOf([old, first, second, theirs, revoked], USER_ID, since);
    expect(found === false ? null : found.id).toBe('second');
    // The boundary from both sides: created exactly at `since` counts, a millisecond before not.
    expect(wizardWorkerOf([first], USER_ID, since)).not.toBe(false);
    expect(wizardWorkerOf([old], USER_ID, since)).toBe(false);
  });
});

describe('projectTakesWorkers', () => {
  const execution = (over: Partial<ProjectExecutionResponse>): ProjectExecutionResponse => ({
    mode: 'hybrid',
    prefer: 'server',
    fallback_after_seconds: null,
    assignee_window_seconds: 120,
    offer_timeout_seconds: 86_400,
    effective_fallback_after_seconds: 15,
    stored: false,
    server_claimant: 'running',
    notice: null,
    workers: [],
    waiting: {
      open: 0,
      closed_to_workers: { credential_refused: 0, server_only: 0, server_first: 0 },
    },
    ...over,
  });
  it('is true for a mode that admits workers and false for the server only', () => {
    expect(projectTakesWorkers(execution({ mode: 'workers_only' }))).toBe(true);
    expect(projectTakesWorkers(execution({ mode: 'hybrid' }))).toBe(true);
    expect(projectTakesWorkers(execution({ mode: 'server_only' }))).toBe(false);
  });
  it('is false when the git connection keeps its credential off workers', () => {
    expect(
      projectTakesWorkers(
        execution({ mode: 'workers_only', notice: REMOTE_RUN_CREDENTIAL_REFUSED_NOTICE }),
      ),
    ).toBe(false);
  });
});

describe('workerInstallCommands', () => {
  it('builds every command from this platform’s own origin, never a path or a trailing slash', () => {
    const commands = workerInstallCommands('https://agentic.example.test');
    expect(commands.download).toBe(
      'curl -fsSo compose.worker.yml https://agentic.example.test/api/worker/v1/compose.yml',
    );
    expect(commands.coreUrlLine).toBe('APP_CORE_URL=https://agentic.example.test');
    expect(commands.up).toBe('docker compose --env-file .env.worker -f compose.worker.yml up -d');
    expect(workerInstallCommands('https://agentic.example.test:8443/').coreUrlLine).toBe(
      'APP_CORE_URL=https://agentic.example.test:8443',
    );
  });
  it('runs the core’s installer in one line per OS, from the paths in one constant', () => {
    const { installer } = workerInstallCommands('https://agentic.example.test/');
    expect(installer.unix).toEqual({
      url: 'https://agentic.example.test/api/worker/v1/install.sh',
      run: "curl -fsSL 'https://agentic.example.test/api/worker/v1/install.sh' | sh",
    });
    expect(installer.windows).toEqual({
      url: 'https://agentic.example.test/api/worker/v1/install.ps1',
      run: "irm 'https://agentic.example.test/api/worker/v1/install.ps1' | iex",
    });
  });
  it('keeps the installer hidden until the core serves it (flip with S-22.20, BACKLOG 927)', () => {
    expect(INSTALLER_AVAILABLE).toBe(false);
  });
  it('shows the installer of the platform the browser reports first', () => {
    expect(preferredInstallOs('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows');
    expect(preferredInstallOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0)')).toBe('unix');
    expect(preferredInstallOs('Mozilla/5.0 (X11; Linux x86_64)')).toBe('unix');
    expect(preferredInstallOs('')).toBe('unix');
    // `Darwin` holds the letters `win`; it is not Windows.
    expect(preferredInstallOs('Mozilla/5.0 (Darwin arm64) AppleWebKit/537.36')).toBe('unix');
    expect(preferredInstallOs('Win32')).toBe('windows');
  });
  it('writes the token through a silent prompt, never printed', () => {
    expect(workerInstallCommands('https://agentic.example.test').writeToken).toBe(
      `read -rs T && printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\\n' "$T" >> .env.worker && unset T`,
    );
  });
});
