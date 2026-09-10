/**
 * TD-012 redaction: step 2 (the gitleaks-derived pattern rules) and the composition that puts the
 * steps in order. Step 1 — exact match of the secrets the platform injected — is WP-07's
 * `exactSecretRedactor` in `@platform/application`; see `pattern-redaction.ts` for the seam.
 */
export * from './pattern-redaction.js';
