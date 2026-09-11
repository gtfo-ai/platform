/**
 * Reading the credentials an integration binding was configured with (technical/03 § "Identity and
 * configuration", BD-002).
 *
 * `integrations.secret_ids` is a list of `secrets` rows, each envelope-encrypted with
 * `APP_SECRET_KEY`; the provider registry wants `ProviderCreateInput.secrets`, a map from **config
 * field name** to value, because `secrets` is merged over `config` before the binding's schema
 * validates it (`jira-cloud/registration.ts`). This port is the step between the two, and it is a
 * port rather than a function because nothing in this ring may open a database connection or
 * import `node:crypto`.
 *
 * ## It fails closed, and the three failures are named
 *
 * Resolving a credential happens on the way to instantiating an adapter that will **mutate** a
 * provider — open a merge request, transition a ticket — so standing rule 20 points one way:
 * refuse. A row named by `secret_ids` that does not exist, a row that does not decrypt, and two
 * rows claiming the same config field are each a `SecretResolutionError` and never a silently
 * shorter map. The last one matters most: a map missing `api_token` merges as *absent*, the
 * binding's config keeps whatever placeholder the settings row holds, and the adapter is built
 * with a credential nobody notices is wrong until a provider answers 401 — while the redactor
 * built from that map does not hold the real token at all, which is standing rule 18's shape with
 * a credential in it.
 *
 * The error carries the secret **ids** and never a plaintext or a ciphertext: it is written to a
 * log by whoever catches it.
 */
import type { Id } from '@platform/contracts';

export class SecretResolutionError extends Error {
  override readonly name = 'SecretResolutionError';
  /** The `secrets.id` values the failing call asked for. Never a value. */
  readonly secretIds: readonly Id[];

  constructor(message: string, secretIds: readonly Id[], options: { cause?: unknown } = {}) {
    super(message, options);
    this.secretIds = [...secretIds];
  }
}

export interface SecretStore {
  /**
   * Decrypts the named rows into `{ <config field>: <value> }`.
   *
   * An empty list resolves to an empty map — a binding whose credentials all live in `config`
   * rather than in the secret store is legal, and every provider's `configSchema` is what decides
   * whether the result is usable.
   *
   * @throws {SecretResolutionError} when a row is missing, undecryptable, or collides on a field.
   */
  resolve(secretIds: readonly Id[]): Promise<Readonly<Record<string, string>>>;
}
