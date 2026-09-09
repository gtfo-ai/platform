import { describe, expect, it } from 'vitest';
import { DISPATCH_CONFIG_DEFAULTS, loadDispatchConfig } from './config.js';

describe('loadDispatchConfig', () => {
  it('falls back to the documented defaults on an empty environment', () => {
    expect(loadDispatchConfig({})).toEqual(DISPATCH_CONFIG_DEFAULTS);
  });

  it('reads every variable', () => {
    expect(
      loadDispatchConfig({
        APP_DISPATCH_BATCH_SIZE: '8',
        APP_DISPATCH_MAX_CONCURRENCY: '4',
        APP_DISPATCH_POLL_INTERVAL_MS: '250',
        APP_DISPATCH_RETRY_DELAY_MS: '100',
        APP_DISPATCH_MAX_RETRY_DELAY_MS: '2000',
        APP_DISPATCH_DRAIN_TIMEOUT_MS: '5000',
        APP_BROADCAST_CHANNEL: 'other_channel',
      }),
    ).toEqual({
      batchSize: 8,
      maxConcurrency: 4,
      pollIntervalMs: 250,
      retryDelayMs: 100,
      maxRetryDelayMs: 2000,
      drainTimeoutMs: 5000,
      broadcastChannel: 'other_channel',
    });
  });

  it('treats an empty value as unset', () => {
    expect(
      loadDispatchConfig({ APP_DISPATCH_BATCH_SIZE: '  ', APP_BROADCAST_CHANNEL: '' }),
    ).toEqual(DISPATCH_CONFIG_DEFAULTS);
  });

  it('names the offending variable rather than the field', () => {
    expect(() => loadDispatchConfig({ APP_DISPATCH_BATCH_SIZE: 'lots' })).toThrow(
      /APP_DISPATCH_BATCH_SIZE/,
    );
    expect(() => loadDispatchConfig({ APP_DISPATCH_POLL_INTERVAL_MS: '0' })).toThrow(
      /APP_DISPATCH_POLL_INTERVAL_MS/,
    );
  });

  it('rejects a concurrency the pool could never satisfy', () => {
    expect(() => loadDispatchConfig({ APP_DISPATCH_MAX_CONCURRENCY: '0' })).toThrow(
      /APP_DISPATCH_MAX_CONCURRENCY/,
    );
    expect(() => loadDispatchConfig({ APP_DISPATCH_MAX_CONCURRENCY: '999' })).toThrow(
      /APP_DISPATCH_MAX_CONCURRENCY/,
    );
  });

  it('rejects a channel name that would have to be quoted in LISTEN', () => {
    expect(() => loadDispatchConfig({ APP_BROADCAST_CHANNEL: 'Some Channel' })).toThrow(
      /APP_BROADCAST_CHANNEL/,
    );
  });

  it('rejects a maximum backoff below the base one', () => {
    expect(() =>
      loadDispatchConfig({
        APP_DISPATCH_RETRY_DELAY_MS: '10000',
        APP_DISPATCH_MAX_RETRY_DELAY_MS: '1000',
      }),
    ).toThrow(/at least/);
  });

  it('reports every problem at once', () => {
    const failure = (() => {
      try {
        loadDispatchConfig({ APP_DISPATCH_BATCH_SIZE: '0', APP_BROADCAST_CHANNEL: '9nope' });
        return '';
      } catch (error) {
        return error instanceof Error ? error.message : '';
      }
    })();
    expect(failure).toMatch(/APP_DISPATCH_BATCH_SIZE/);
    expect(failure).toMatch(/APP_BROADCAST_CHANNEL/);
  });
});
