import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DATABASE_CONFIG_DEFAULTS, loadDatabaseConfig, readEnvWithFile } from './config.js';

const scratch = mkdtempSync(join(tmpdir(), 'platform-db-config-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const minimalEnv = { DATABASE_URL: 'postgres://app@db:5432/app' } as const;

describe('readEnvWithFile', () => {
  it('prefers the _FILE variant and strips the trailing newline an editor leaves behind', () => {
    const file = join(scratch, 'database-url');
    writeFileSync(file, 'postgres://from-file/app\n');

    expect(
      readEnvWithFile('DATABASE_URL', {
        DATABASE_URL: 'postgres://from-env/app',
        DATABASE_URL_FILE: file,
      }),
    ).toBe('postgres://from-file/app');
  });

  it('falls back to the plain variable, treating blank as unset', () => {
    expect(readEnvWithFile('DATABASE_URL', minimalEnv)).toBe('postgres://app@db:5432/app');
    expect(readEnvWithFile('DATABASE_URL', { DATABASE_URL: '   ' })).toBeUndefined();
    expect(readEnvWithFile('DATABASE_URL', {})).toBeUndefined();
    expect(readEnvWithFile('DATABASE_URL', { ...minimalEnv, DATABASE_URL_FILE: '  ' })).toBe(
      'postgres://app@db:5432/app',
    );
  });
});

describe('loadDatabaseConfig', () => {
  it('applies the documented defaults', () => {
    expect(loadDatabaseConfig(minimalEnv)).toEqual({
      url: 'postgres://app@db:5432/app',
      appRole: DATABASE_CONFIG_DEFAULTS.appRole,
      poolMax: DATABASE_CONFIG_DEFAULTS.poolMax,
      connectionTimeoutMs: DATABASE_CONFIG_DEFAULTS.connectionTimeoutMs,
      partitionMonthsAhead: DATABASE_CONFIG_DEFAULTS.partitionMonthsAhead,
      transcriptRetentionDays: null,
    });
  });

  it('keeps transcripts forever unless a retention window is configured', () => {
    expect(
      loadDatabaseConfig({ ...minimalEnv, APP_TRANSCRIPT_RETENTION_DAYS: '' })
        .transcriptRetentionDays,
    ).toBeNull();
    expect(
      loadDatabaseConfig({ ...minimalEnv, APP_TRANSCRIPT_RETENTION_DAYS: '90' })
        .transcriptRetentionDays,
    ).toBe(90);
  });

  it('reads the tuning knobs', () => {
    const config = loadDatabaseConfig({
      ...minimalEnv,
      APP_DB_POOL_MAX: '25',
      APP_DB_CONNECTION_TIMEOUT_MS: '2500',
      APP_DB_PARTITION_MONTHS_AHEAD: '6',
      APP_DB_APP_ROLE: 'reporting_ro',
    });
    expect(config.poolMax).toBe(25);
    expect(config.connectionTimeoutMs).toBe(2500);
    expect(config.partitionMonthsAhead).toBe(6);
    expect(config.appRole).toBe('reporting_ro');
  });

  it('refuses a connection timeout that would restore the silent-hang behaviour', () => {
    // 0 would mean "wait for ever" in pg, which is the failure mode the setting exists to remove.
    expect(() => loadDatabaseConfig({ ...minimalEnv, APP_DB_CONNECTION_TIMEOUT_MS: '0' })).toThrow(
      /APP_DB_CONNECTION_TIMEOUT_MS/,
    );
  });

  it('accepts an empty APP_DB_APP_ROLE, which disables the SET ROLE switch', () => {
    expect(loadDatabaseConfig({ ...minimalEnv, APP_DB_APP_ROLE: '' }).appRole).toBe('');
  });

  it('names the variable to fix rather than the field it maps to', () => {
    expect(() => loadDatabaseConfig({})).toThrow(/DATABASE_URL is required/);
    expect(() => loadDatabaseConfig({ ...minimalEnv, APP_DB_POOL_MAX: 'lots' })).toThrow(
      /APP_DB_POOL_MAX/,
    );
  });

  it('reports every offending variable at once', () => {
    expect(() => loadDatabaseConfig({ APP_DB_POOL_MAX: '0', APP_DB_APP_ROLE: 'Nope' })).toThrow(
      /DATABASE_URL.*APP_DB_APP_ROLE.*APP_DB_POOL_MAX|DATABASE_URL[\s\S]*APP_DB_POOL_MAX/,
    );
  });

  it('rejects a role name that would need quoting', () => {
    expect(() => loadDatabaseConfig({ ...minimalEnv, APP_DB_APP_ROLE: 'app"; drop' })).toThrow();
    expect(() => loadDatabaseConfig({ ...minimalEnv, APP_DB_APP_ROLE: 'MixedCase' })).toThrow();
  });

  it('rejects non-numeric and out-of-range tuning values', () => {
    expect(() => loadDatabaseConfig({ ...minimalEnv, APP_DB_POOL_MAX: 'lots' })).toThrow();
    expect(() => loadDatabaseConfig({ ...minimalEnv, APP_DB_POOL_MAX: '0' })).toThrow();
    expect(() => loadDatabaseConfig({ ...minimalEnv, APP_DB_POOL_MAX: '1.5' })).toThrow();
    expect(() =>
      loadDatabaseConfig({ ...minimalEnv, APP_DB_PARTITION_MONTHS_AHEAD: '999' }),
    ).toThrow();
    expect(() =>
      loadDatabaseConfig({ ...minimalEnv, APP_TRANSCRIPT_RETENTION_DAYS: '0' }),
    ).toThrow();
    expect(() =>
      loadDatabaseConfig({ ...minimalEnv, APP_TRANSCRIPT_RETENTION_DAYS: 'forever' }),
    ).toThrow(/APP_TRANSCRIPT_RETENTION_DAYS/);
  });
});
