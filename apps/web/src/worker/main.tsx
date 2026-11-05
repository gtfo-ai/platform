/**
 * The worker's local page's entry (WP-292): `apps/web/worker.html`, Vite's second entry, served by
 * the remote worker on `127.0.0.1` only. Its own bundle budget (≤ 120 kB gz, `bundle:check`): it
 * imports `ui/*` and the shared transcript reducer, never `viz/*`, the router or the SPA's app.
 */
// No zod here, and so no `zod-jitless` either: the page reads its answers with `read-state.ts`.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import './worker.css';
import { browserTokenPlace, createLocalClient, takeToken } from './client.js';
import { WorkerApp } from './worker-app.js';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('#root is missing from worker.html');
}

const token = takeToken(browserTokenPlace());
createRoot(container).render(
  <StrictMode>
    <WorkerApp client={createLocalClient(token)} />
  </StrictMode>,
);
