/**
 * `@platform/web` — the control tower SPA (BD-015, TD-013).
 *
 * The package is not consumed as a library by anything in the monorepo; `main.tsx` is the entry
 * point Vite builds. What is exported here is the surface a test harness or a future embedder
 * needs: the composition root, the realtime client and the transcript reducer.
 */

export { createEndpoints } from './api/endpoints.js';
export { ApiError, createApiClient, NetworkError } from './api/http.js';
export { queryKeys } from './api/keys.js';
export { type App, type CreateAppOptions, createApp } from './app/app.js';
export type { EventStream, EventStreamFactory, RealtimeStatus } from './realtime/client.js';
export { createRealtimeClient, STREAM_EVENT_NAMES } from './realtime/client.js';
export { parseFrameId, serialiseCursors } from './realtime/cursors.js';
export type { TranscriptBlock } from './transcript/blocks.js';
export { normaliseEvents, toBlocks } from './transcript/blocks.js';
export { createTranscriptStore } from './transcript/store.js';
export {
  safeHref,
  sanitiseUntrusted,
  segmentBlocks,
  segmentInline,
  stripAnsi,
} from './ui/untrusted-text.js';

export const packageId = '@platform/web' as const;
