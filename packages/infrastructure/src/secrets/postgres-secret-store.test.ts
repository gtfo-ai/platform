/**
 * The store's four refusals, each asserted by its message rather than by "it threw".
 *
 * The rows are stubbed and the crypto is real: what is under test is the *resolution* — which id
 * maps to which config field, and what happens when that mapping cannot be made — not the sealing,
 * which `envelope.test.ts` holds. The positive case at the top is the one standing rule 42 asks
 * for: a boundary asserted from one side is half a test, and a store that refused everything would
 * pass every negative below.
 */
import { SecretResolutionError } from '@platform/application';
import type { Id } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import type { SqlExecutor } from '../events/sql.js';
import { deriveSecretKey, sealSecret } from './envelope.js';
import { createPostgresSecretStore, secretDocument } from './postgres-secret-store.js';

const KEY = deriveSecretKey('not-a-real-app-secret-key-000000000000');
const OTHER_KEY = deriveSecretKey('also-not-a-real-app-secret-key-11111111');

const TOKEN_ID = '00000000-0000-4000-8000-00000000e001' as Id;
const WEBHOOK_ID = '00000000-0000-4000-8000-00000000e002' as Id;

interface Row {
  readonly id: string;
  readonly ciphertext: Buffer;
  readonly key_id: string;
}

const row = (id: Id, field: string, value: string, key = KEY): Row => ({
  id,
  ciphertext: sealSecret(key, secretDocument(field, value)),
  key_id: key.keyId,
});

const storeOf = (rows: readonly Row[]) => {
  const queries: { text: string; values: unknown[] }[] = [];
  const sql: SqlExecutor = {
    query: async (text, values) => {
      queries.push({ text, values: values ?? [] });
      const wanted = new Set((values?.[0] ?? []) as string[]);
      const matched = rows.filter((candidate) => wanted.has(candidate.id));
      return { rows: matched as never[], rowCount: matched.length };
    },
  };
  return { store: createPostgresSecretStore({ sql, key: KEY }), queries };
};

describe('resolving an integration’s credentials', () => {
  it('maps every row onto the config field its own document names', async () => {
    const { store } = storeOf([
      row(TOKEN_ID, 'token', 'glpat-FAKE-not-a-real-token'),
      row(WEBHOOK_ID, 'webhook_secret_token', 'FAKE-webhook-secret'),
    ]);
    await expect(store.resolve([TOKEN_ID, WEBHOOK_ID])).resolves.toEqual({
      token: 'glpat-FAKE-not-a-real-token',
      webhook_secret_token: 'FAKE-webhook-secret',
    });
  });

  it('does not ask the database anything for an integration with no secrets', async () => {
    const { store, queries } = storeOf([]);
    await expect(store.resolve([])).resolves.toEqual({});
    expect(queries).toHaveLength(0);
  });

  it('asks for each id once when `secret_ids` repeats one', async () => {
    const { store, queries } = storeOf([row(TOKEN_ID, 'token', 'glpat-FAKE-not-a-real-token')]);
    await expect(store.resolve([TOKEN_ID, TOKEN_ID])).resolves.toEqual({
      token: 'glpat-FAKE-not-a-real-token',
    });
    expect(queries[0]?.values[0]).toEqual([TOKEN_ID]);
  });

  it('refuses a referenced row that does not exist', async () => {
    const { store } = storeOf([]);
    await expect(store.resolve([TOKEN_ID])).rejects.toThrow(
      /is referenced by an integration but has no row/,
    );
  });

  it('refuses a row sealed under another key, naming both key ids', async () => {
    const { store } = storeOf([row(TOKEN_ID, 'token', 'glpat-FAKE-not-a-real-token', OTHER_KEY)]);
    const error = await store.resolve([TOKEN_ID]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SecretResolutionError);
    expect((error as Error).message).toContain(OTHER_KEY.keyId);
    expect((error as Error).message).toContain(KEY.keyId);
  });

  it('refuses a row that does not decrypt, without quoting anything from it', async () => {
    const broken = row(TOKEN_ID, 'token', 'glpat-FAKE-not-a-real-token');
    const last = broken.ciphertext.length - 1;
    broken.ciphertext.writeUInt8(broken.ciphertext.readUInt8(last) ^ 0xff, last);
    const { store } = storeOf([broken]);
    const error = await store.resolve([TOKEN_ID]).catch((caught: unknown) => caught);
    expect((error as Error).message).toBe(`secret ${TOKEN_ID} could not be read`);
  });

  it('refuses a plaintext that is not the document this platform writes', async () => {
    const { store } = storeOf([
      {
        id: TOKEN_ID,
        ciphertext: sealSecret(KEY, JSON.stringify({ token: 'glpat-FAKE-not-a-real-token' })),
        key_id: KEY.keyId,
      },
    ]);
    await expect(store.resolve([TOKEN_ID])).rejects.toThrow(/could not be read/);
  });

  /**
   * The refusal that is not obvious, and the one with a credential behind it: two rows claiming one
   * field would otherwise resolve to whichever came back last, so which token an adapter is built
   * with would depend on the query planner. Silently keeping one is standing rule 18's shape.
   */
  it('refuses two rows claiming the same config field, naming both', async () => {
    const { store } = storeOf([
      row(TOKEN_ID, 'token', 'glpat-FAKE-first-not-a-real-token'),
      row(WEBHOOK_ID, 'token', 'glpat-FAKE-second-not-a-real-token'),
    ]);
    const error = await store.resolve([TOKEN_ID, WEBHOOK_ID]).catch((caught: unknown) => caught);
    expect((error as Error).message).toBe(
      `secrets ${TOKEN_ID} and ${WEBHOOK_ID} both claim the config field "token"`,
    );
    expect((error as Error).message).not.toContain('glpat-');
  });
});
