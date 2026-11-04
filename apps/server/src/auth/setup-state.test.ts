/**
 * The sign-in page's "has anybody signed in yet?" (WP-291), against a store in memory.
 *
 * The durable half — that the stamp survives sign-out, session pruning and a restart — needs a
 * real database and Better Auth, and is `test/e2e/server/setup-state.e2e.test.ts`. What this file
 * holds is the module's own decisions: a `false` is cached and a `true` is not, every session asks
 * for the stamp (the statement keeps an account's first instant), and a failed write never fails
 * the sign-in.
 */
import type { Logger } from '@platform/application';
import { fastify } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import { registerSetupStateRoutes } from '../routes/setup-state.js';
import { createSetupState } from './setup-state.js';

const USER = '00000000-0000-4000-8000-000000000291';

const world = () => {
  const state = {
    recorded: false,
    reads: 0,
    writes: 0,
    failWrite: false,
    warnings: [] as string[],
  };
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (_fields, message) => {
      state.warnings.push(message);
    },
    error: () => {},
  };
  const setupState = createSetupState({
    store: {
      anySignInRecorded: async () => {
        state.reads += 1;
        return state.recorded;
      },
      recordFirstSignIn: async () => {
        state.writes += 1;
        if (state.failWrite) {
          throw new Error('connection terminated');
        }
        state.recorded = true;
      },
    },
    logger,
  });
  return { state, setupState };
};

describe('createSetupState', () => {
  it('is pending on an instance nobody has signed in to, and asks the store every time', async () => {
    const { state, setupState } = world();
    expect(await setupState.firstSignInPending()).toBe(true);
    expect(await setupState.firstSignInPending()).toBe(true);
    // A `true` is never cached: another process may record the first sign-in at any moment.
    expect(state.reads).toBe(2);
    state.recorded = true;
    expect(await setupState.firstSignInPending()).toBe(false);
  });

  it('caches a false for good, so a used instance answers without the database', async () => {
    const { state, setupState } = world();
    state.recorded = true;
    expect(await setupState.firstSignInPending()).toBe(false);
    expect(await setupState.firstSignInPending()).toBe(false);
    expect(state.reads).toBe(1);
  });

  it('stamps every sign-in’s account and flips the answer without another read', async () => {
    const { state, setupState } = world();
    await setupState.signedIn(USER);
    expect(await setupState.firstSignInPending()).toBe(false);
    await setupState.signedIn(USER);
    // Each sign-in asks; the statement itself leaves an account's first instant alone.
    expect(state.writes).toBe(2);
    // The write is what flipped the cache: no read was needed.
    expect(state.reads).toBe(0);
  });

  it('logs a failed stamp and lets the sign-in stand; the next sign-in writes it', async () => {
    const { state, setupState } = world();
    state.failWrite = true;
    await expect(setupState.signedIn(USER)).resolves.toBeUndefined();
    expect(state.warnings).toEqual([
      'could not record the first sign-in; the sign-in page keeps its bootstrap hint until the next one',
    ]);
    expect(await setupState.firstSignInPending()).toBe(true);
    state.failWrite = false;
    await setupState.signedIn(USER);
    expect(await setupState.firstSignInPending()).toBe(false);
  });
});

describe('GET /api/setup-state', () => {
  it('answers the reader’s bit without a session, in the published shape', async () => {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    let pending = true;
    await registerSetupStateRoutes(app, {
      setupState: { firstSignInPending: async () => pending },
    });
    try {
      const first = await app.inject({ method: 'GET', url: '/api/setup-state' });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({ first_sign_in_pending: true });
      pending = false;
      const second = await app.inject({ method: 'GET', url: '/api/setup-state' });
      expect(second.json()).toEqual({ first_sign_in_pending: false });
    } finally {
      await app.close();
    }
  });
});
