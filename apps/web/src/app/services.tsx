/**
 * The collaborators every screen reaches for, injected rather than imported.
 *
 * A screen that imports a module-level `fetch` client cannot be rendered twice in one process with
 * two different servers, which is exactly what the test tier does. `apps/server` learned the same
 * lesson at WP-06 (`buildApp` takes every collaborator as an argument); this is that rule in the
 * browser.
 */
import { createContext, type ReactElement, type ReactNode, useContext } from 'react';
import type { Endpoints } from '../api/endpoints.js';
import type { AuthApi } from '../auth/session.js';
import type { TranscriptStore } from '../transcript/store.js';

export interface Services {
  readonly endpoints: Endpoints;
  readonly auth: AuthApi;
  readonly transcripts: TranscriptStore;
  /** Injected so a component never reads a clock directly (standing rule 2). */
  readonly now: () => number;
}

const ServicesContext = createContext<Services | null>(null);

export const ServicesProvider = ({
  services,
  children,
}: {
  readonly services: Services;
  readonly children: ReactNode;
}): ReactElement => (
  <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>
);

export const useServices = (): Services => {
  const value = useContext(ServicesContext);
  if (value === null) {
    throw new Error('useServices was called outside <ServicesProvider>');
  }
  return value;
};
