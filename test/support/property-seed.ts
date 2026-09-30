/**
 * Sets the seed every fast-check property in this file's run draws from — the vitest **setup file**
 * of every project that collects a property file (`vitest.config.ts`, WP-97).
 *
 * vitest runs a setup file inside each test file's own module graph before the file itself, so the
 * `fast-check` instance configured here is the one the file's `fc.assert` reads. The seed is the
 * gate's unless `PROPERTY_SEED` names another (the weekly exploration run, or a replay of what it
 * found); the decision and its reasons are `scripts/property-seed.mjs`'s, and
 * `scripts/property-seed.test.ts` asserts that the seed reaches a file which imports nothing to get
 * it.
 */
import process from 'node:process';
import fc from 'fast-check';
import { seedFrom } from '../../scripts/property-seed.mjs';

fc.configureGlobal({ ...fc.readConfigureGlobal(), seed: seedFrom(process.env).seed });
