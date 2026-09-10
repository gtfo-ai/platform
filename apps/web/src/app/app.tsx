/**
 * The composition root of the SPA.
 *
 * `createApp` takes every collaborator — a `fetch`, an `EventSource` factory, a clock — so the
 * whole application can be mounted in a test process against a fake server, and `mountApp` is the
 * two lines the browser runs. `apps/server`'s `runtime.ts` is the same shape on the other side.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import * as z from 'zod';
import { createEndpoints } from '../api/endpoints.js';
import { type ApiClientOptions, createApiClient } from '../api/http.js';
import { createAuthApi } from '../auth/session.js';
import type { EventStreamFactory } from '../realtime/client.js';
import { RealtimeProvider } from '../realtime/provider.js';
import { createAppRouter, type RouterContext } from '../routes/tree.js';
import { createTranscriptStore } from '../transcript/store.js';
import { ErrorBoundary } from '../ui/error-boundary.js';
import { ThemeProvider } from '../ui/theme.js';
import { type Services, ServicesProvider } from './services.js';

/** `POST /events/subscriptions` answers with the connection id and its topic list. */
const subscriptionAck = z.looseObject({});

export interface CreateAppOptions extends ApiClientOptions {
  readonly openStream?: EventStreamFactory;
  readonly now?: () => number;
  readonly queryClient?: QueryClient;
  /** Off in unit tests that render one screen; on everywhere else. */
  readonly realtime?: boolean;
  /**
   * Called with anything the application-level error boundary catches.
   *
   * There is no telemetry sink in the browser yet, so leaving this unset is not "swallowed": React
   * 19 still reports a caught error to the console itself (`onCaughtError`). The option exists so
   * a test can assert the boundary was reached, and so a reporter can be wired here rather than
   * inside a component.
   */
  readonly onError?: (error: unknown) => void;
}

export interface App {
  readonly element: ReactElement;
  readonly queryClient: QueryClient;
  readonly services: Services;
}

export const createApp = (options: CreateAppOptions = {}): App => {
  const client = createApiClient(options);
  const endpoints = createEndpoints(client);
  const auth = createAuthApi(client);
  const transcripts = createTranscriptStore();
  const services: Services = {
    endpoints,
    auth,
    transcripts,
    now: options.now ?? (() => Date.now()),
  };

  const queryClient =
    options.queryClient ??
    new QueryClient({
      defaultOptions: {
        queries: {
          // The stream is the invalidation signal; see `app/queries.ts`.
          refetchOnWindowFocus: false,
          retry: 1,
        },
      },
    });

  const context: RouterContext = { queryClient, services };
  const router = createAppRouter(context);

  const updateSubscriptions = async (body: {
    readonly connection_id: string;
    readonly add?: readonly string[];
    readonly remove?: readonly string[];
  }): Promise<void> => {
    await client.command('/events/subscriptions', { schema: subscriptionAck, body });
  };

  // Outside every provider on purpose: this is the backstop for a throw the router cannot see —
  // in a provider, in a provider's effect, or in the router's own render. The route-level
  // boundary is `defaultErrorComponent` in `routes/tree.tsx`; see `ui/error-boundary.tsx` for
  // what each one catches and for the measurement that says an app without them goes blank.
  const element = (
    <ErrorBoundary
      area="application"
      {...(options.onError === undefined ? {} : { onError: options.onError })}
    >
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <ServicesProvider services={services}>
            <RealtimeProvider
              transcripts={transcripts}
              enabled={options.realtime !== false}
              {...(options.openStream === undefined ? {} : { openStream: options.openStream })}
              updateSubscriptions={updateSubscriptions}
            >
              <RouterProvider router={router} />
            </RealtimeProvider>
          </ServicesProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );

  return { element, queryClient, services };
};
