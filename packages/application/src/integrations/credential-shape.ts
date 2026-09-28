/**
 * The **shape** of a minted run credential — TD-012's M5 amendment, WP-80, PROGRESS backlog 259.
 *
 * A run credential is redacted by exact value only in the process that minted it
 * (`RunScopedSecrets` is memory, deliberately). Every other process — on the shipped topology
 * `app`, which ingests every webhook — relied on the gitleaks-derived `gitlab-token` rule, which
 * knows GitLab's default `glpat-` prefix and nothing else; a GitLab administrator can change that
 * prefix and project access tokens inherit it
 * (<https://docs.gitlab.com/administration/settings/account_and_limit_settings/>, retrieved
 * 2026-09-28: *"Project access tokens and group access tokens also inherit this prefix"*).
 *
 * So the minting process records a **non-secret shape** of the value — the prefix the provider
 * declares, a closed character class and the exact length — beside the mint's audit row, and every
 * process compiles one pattern rule per recorded shape. A shape names **no character of the random
 * part**, which is what makes it storable (BD-002; TD-012's *"originals are never stored"*).
 *
 * **Why the prefix is the provider's declaration and never a guess.** The random part of a GitLab
 * token may contain `-` and `_`, and an administrator's prefix may contain neither, so no split of
 * an observed value can tell where a custom prefix ends: a guess that runs long stores random
 * characters, and one that runs short is a rule that over-matches everything. The provider says
 * what the prefix is (GitLab: the binding's `token_prefix`, `glpat-` by default), the adapter puts
 * it on the credential, and {@link hasMintedCredentialShape} checks the value against it before the
 * platform uses the credential — a value that does not have its declared shape is revoked and
 * refused, like one too short to redact (`runCredentialWrites.mint`).
 *
 * **The character class is a closed set**, never a provider-supplied pattern: the rule is compiled
 * into every process's redactor, and a pattern from an adapter would be a regular expression an
 * integration row could influence. The three classes cover the providers this build ships (GitLab's
 * legacy tokens are `[0-9a-zA-Z_-]`, its routable ones add `.`; the fake is alphanumeric).
 *
 * **What the rule costs.** It over-redacts any other string of the same prefix, class and length —
 * the safe direction, counted in `redaction_count` like every other rule. It does not see a value
 * that was transformed on its way into the text (URL-encoded, base64-wrapped, split across lines);
 * neither does the exact-value step, and neither did the `glpat-` rule it extends.
 */
import * as z from 'zod';

/** The closed set of character classes a minted value's random part may be drawn from. */
export const MINTED_CREDENTIAL_CHARSETS = {
  alnum: 'A-Za-z0-9',
  token: 'A-Za-z0-9_-',
  token_dotted: 'A-Za-z0-9_.-',
} as const;

export type MintedCredentialCharset = keyof typeof MINTED_CREDENTIAL_CHARSETS;

/**
 * What a declared prefix may contain: 3–32 characters, none of them whitespace and none a
 * regular-expression metacharacter other than `.` and `+`, which the compiler escapes. The same
 * alphabet is the migration's check constraint (0057) and GitLab's `token_prefix` schema, so a
 * prefix one of them accepts the others accept.
 */
export const MINTED_CREDENTIAL_PREFIX_PATTERN = /^[A-Za-z0-9_.+=/@:-]{3,32}$/;

/** The bounds on a minted value's length, restated by the migration's check constraint. */
export const MIN_MINTED_CREDENTIAL_LENGTH = 16;
export const MAX_MINTED_CREDENTIAL_LENGTH = 512;

export interface MintedCredentialShape {
  /** The characters before the provider's random part, as the provider declares them. */
  readonly prefix: string;
  readonly charset: MintedCredentialCharset;
  /** The whole value's length, prefix included. */
  readonly length: number;
}

export const mintedCredentialShapeSchema = z
  .strictObject({
    prefix: z.string().regex(MINTED_CREDENTIAL_PREFIX_PATTERN),
    charset: z.enum(['alnum', 'token', 'token_dotted']),
    length: z.int().min(MIN_MINTED_CREDENTIAL_LENGTH).max(MAX_MINTED_CREDENTIAL_LENGTH),
  })
  .refine((shape) => shape.length > shape.prefix.length, {
    message: 'a shape with no random part would redact its own prefix and nothing else',
  });

/**
 * A shape as the minting process records it: the shape and the minted credential's expiry, after
 * which nothing of that shape needs redacting on its account. The audit entry carries this and the
 * adapter upserts it, keeping the latest expiry per shape.
 */
export interface MintedCredentialShapeRecord {
  readonly shape: MintedCredentialShape;
  /** An ISO instant — the credential's own `expiresAt`. */
  readonly expiresAt: string;
}

export const mintedCredentialShapeRecordSchema = z.strictObject({
  shape: mintedCredentialShapeSchema,
  expiresAt: z.iso.datetime({ offset: true }),
});

const escapeLiteral = (text: string): string => text.replace(/[^A-Za-z0-9_]/g, (c) => `\\${c}`);

/** The pattern's source — the literal prefix, then exactly the random part's length of its class. */
const shapeSource = (shape: MintedCredentialShape): string =>
  `${escapeLiteral(shape.prefix)}[${MINTED_CREDENTIAL_CHARSETS[shape.charset]}]{${shape.length - shape.prefix.length}}`;

/**
 * The redaction rule's pattern for one shape, `g`-flagged. The redaction engine compiles its own
 * copy per call, so this object's `lastIndex` is never shared between inputs.
 *
 * @throws {z.ZodError} for a shape outside the schema — a row the database's own check would have
 * refused, so reaching this is a defect upstream, never a rule quietly compiled wrong.
 */
export const mintedCredentialShapePattern = (shape: MintedCredentialShape): RegExp =>
  new RegExp(shapeSource(mintedCredentialShapeSchema.parse(shape)), 'g');

/** Whether `value` is exactly of `shape` — the check a mint makes before it uses the value. */
export const hasMintedCredentialShape = (shape: MintedCredentialShape, value: string): boolean => {
  const parsed = mintedCredentialShapeSchema.safeParse(shape);
  return parsed.success && new RegExp(`^${shapeSource(parsed.data)}$`).test(value);
};
