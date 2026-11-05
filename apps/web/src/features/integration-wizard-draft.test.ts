/**
 * The add-integration wizard's tab-scoped draft (S-23.23): what is kept, what is refused on the way
 * back in, and that a storage which throws is the same as no draft. The wizard's resume itself is
 * `integration-wizard.test.tsx` › "the add-integration wizard after a reload".
 */
import { describe, expect, it } from 'vitest';
import {
  clearIntegrationDraft,
  INTEGRATION_DRAFT_STORAGE_KEY,
  readIntegrationDraft,
  storeIntegrationDraft,
} from './integration-wizard-draft.js';

const memory = () => {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
};

const DRAFT = {
  providerId: 'jira-cloud',
  name: 'ACME Jira',
  config: { site_url: 'https://acme.atlassian.example.test' },
};

describe('the integration wizard’s draft', () => {
  it('keeps the provider, the name and the configuration, and reads them back', () => {
    const storage = memory();
    storeIntegrationDraft(DRAFT, storage);
    expect(JSON.parse(storage.values.get(INTEGRATION_DRAFT_STORAGE_KEY) ?? '')).toEqual(DRAFT);
    expect(readIntegrationDraft(storage)).toEqual(DRAFT);
  });

  it('keeps nothing it was not given a slot for, so a credential name cannot ride along', () => {
    const storage = memory();
    storeIntegrationDraft(
      { ...DRAFT, secretEnv: { api_token: 'JIRA_API_TOKEN' } } as typeof DRAFT,
      storage,
    );
    expect(storage.values.get(INTEGRATION_DRAFT_STORAGE_KEY)).not.toContain('JIRA_API_TOKEN');
  });

  it('removes an empty draft rather than keeping one', () => {
    const storage = memory();
    storeIntegrationDraft(DRAFT, storage);
    storeIntegrationDraft({ providerId: '', name: '', config: {} }, storage);
    expect(storage.values.has(INTEGRATION_DRAFT_STORAGE_KEY)).toBe(false);
  });

  it.each([
    ['text that is not JSON', '{not json'],
    ['a document with an unknown key', JSON.stringify({ ...DRAFT, secretEnv: {} })],
    ['a document missing a key', JSON.stringify({ providerId: 'jira-cloud', name: 'x' })],
    ['a value past the bound', JSON.stringify({ ...DRAFT, name: 'x'.repeat(4_001) })],
    ['a configuration value that is not text', JSON.stringify({ ...DRAFT, config: { a: 1 } })],
  ])('refuses %s whole', (_name, raw) => {
    const storage = memory();
    storage.values.set(INTEGRATION_DRAFT_STORAGE_KEY, raw);
    expect(readIntegrationDraft(storage)).toBeNull();
  });

  it('treats a storage that throws as no draft, and never throws itself', () => {
    const refusing = {
      getItem: () => {
        throw new Error('storage disabled');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('storage disabled');
      },
    };
    expect(readIntegrationDraft(refusing)).toBeNull();
    expect(() => {
      storeIntegrationDraft(DRAFT, refusing);
      clearIntegrationDraft(refusing);
    }).not.toThrow();
  });

  it('clears what it kept', () => {
    const storage = memory();
    storeIntegrationDraft(DRAFT, storage);
    clearIntegrationDraft(storage);
    expect(readIntegrationDraft(storage)).toBeNull();
  });
});
