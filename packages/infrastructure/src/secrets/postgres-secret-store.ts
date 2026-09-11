/**
 * `SecretStore` on the `secrets` table (technical/03, BD-002).
 *
 * The only reader of `secrets.ciphertext` in the platform. Everything it refuses is refused loudly,
 * because the caller is on its way to instantiating an adapter that will mutate a provider
 * (standing rule 20) and a *partial* map is the dangerous answer: `ProviderCreateInput.secrets` is
 * merged over the binding's `config` before the strict schema parses it, so a field this drops
 * silently keeps whatever the settings row holds — a placeholder, usually — and the adapter is
 * built with a credential that is wrong *and* absent from the redactor built beside it.
 *
 * Four refusals, each with its own message and its own test:
 *
 *  - an id in `secret_ids` with **no row**: the integration references a credential that has been
 *    deleted;
 *  - a row sealed under **another key** (`secrets.key_id`), which is what a half-finished
 *    `APP_SECRET_KEY` rotation looks like and is worth saying plainly rather than as "bad tag";
 *  - a row that does not **decrypt or parse** — including one whose plaintext is not the document
 *    this platform writes;
 *  - two rows claiming the **same config field**, which would otherwise resolve to whichever the
 *    query returned last and make a credential depend on row order.
 *
 * A duplicate **id** in `secret_ids` is not a refusal: it names one row once, and `uuid[]` has no
 * uniqueness of its own. It is deduplicated on the way in.
 */
import { SecretResolutionError, type SecretStore } from '@platform/application';
import { nonEmptyStringSchema } from '@platform/contracts';
import * as z from 'zod';
import type { SqlExecutor } from '../events/sql.js';
import { isSealedUnder, openSecret, type SecretKey } from './envelope.js';

/**
 * What one sealed row decrypts to.
 *
 * The **field name travels with the value** rather than being implied by the row's position in
 * `secret_ids`: an array column has no names, and an operator reordering it must not silently swap
 * a webhook secret for an API token. Strict, because it is a boundary this platform both writes
 * and reads, and an unknown key means the row was written by something else.
 */
export const secretDocumentSchema = z.strictObject({
  /** The provider config field this credential belongs to (`api_token`, `webhook_secret`). */
  field: nonEmptyStringSchema,
  value: z.string(),
});

export type SecretDocument = z.infer<typeof secretDocumentSchema>;

/** Serialises a credential for storage; the settings UI and the fixtures share it. */
export const secretDocument = (field: string, value: string): string =>
  JSON.stringify(secretDocumentSchema.parse({ field, value }));

interface SecretRow extends Record<string, unknown> {
  readonly id: string;
  readonly ciphertext: Buffer;
  readonly key_id: string;
}

export interface PostgresSecretStoreOptions {
  readonly sql: SqlExecutor;
  readonly key: SecretKey;
}

export const createPostgresSecretStore = (options: PostgresSecretStoreOptions): SecretStore => ({
  resolve: async (secretIds) => {
    const wanted = [...new Set(secretIds)];
    if (wanted.length === 0) {
      return {};
    }

    const { rows } = await options.sql.query<SecretRow>(
      'select id, ciphertext, key_id from secrets where id = any($1::uuid[])',
      [wanted],
    );

    const byId = new Map(rows.map((row) => [row.id, row]));
    const resolved: Record<string, string> = {};
    const fieldOwner = new Map<string, string>();

    for (const id of wanted) {
      const row = byId.get(id);
      if (row === undefined) {
        throw new SecretResolutionError(
          `secret ${id} is referenced by an integration but has no row`,
          wanted,
        );
      }
      if (!isSealedUnder(options.key, row.key_id)) {
        throw new SecretResolutionError(
          `secret ${id} is sealed under key "${row.key_id}", and this process holds "${options.key.keyId}"`,
          wanted,
        );
      }
      let document: SecretDocument;
      try {
        document = secretDocumentSchema.parse(JSON.parse(openSecret(options.key, row.ciphertext)));
      } catch (cause) {
        // Never the plaintext, never the ciphertext: this message reaches a log.
        throw new SecretResolutionError(`secret ${id} could not be read`, wanted, { cause });
      }
      const owner = fieldOwner.get(document.field);
      if (owner !== undefined) {
        throw new SecretResolutionError(
          `secrets ${owner} and ${id} both claim the config field "${document.field}"`,
          wanted,
        );
      }
      fieldOwner.set(document.field, id);
      resolved[document.field] = document.value;
    }

    return resolved;
  },
});
