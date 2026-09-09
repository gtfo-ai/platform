import { describe, expect, it } from 'vitest';

/**
 * Placeholder for the Testcontainers / PGlite tier (technical/10).
 * WP-03 replaces it with the migration and repository suites.
 */
describe('integration tier', () => {
  it('is wired', () => {
    expect(process.env.NODE_ENV).not.toBe('production');
  });
});
