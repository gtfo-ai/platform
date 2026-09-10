/**
 * Starts the fake backend on a fixed port for Playwright's `webServer`.
 *
 * Run through `scripts/ts-source-resolver.mjs`, like `pnpm db:migrate` and `pnpm dev`, so the
 * repository's `.js` specifiers resolve to the `.ts` files on disk (CLAUDE.md).
 */
import process from 'node:process';
import { createFakeBackend } from './fake-backend.js';

const port = Number.parseInt(process.env['WEB_E2E_PORT'] ?? '4318', 10);

const backend = await createFakeBackend(port);
process.stdout.write(`fake backend listening on ${backend.url}\n`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void backend.close().then(() => {
      process.exit(0);
    });
  });
}
