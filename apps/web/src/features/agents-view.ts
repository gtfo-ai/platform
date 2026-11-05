/**
 * Which of the Agents page's three views is shown (S-23.6): the map (the default), the office or
 * the list. Tiny and dependency-free on purpose: the route tree imports it for `?view=`, and the
 * route tree is in the initial graph, which the Agents screen itself is not.
 *
 * The URL wins (`/agents?view=office` is a link somebody can send), then the reader's last choice in
 * this browser, then the map.
 */
export const FLEET_VIEWS = ['map', 'office', 'list'] as const;

export type FleetView = (typeof FLEET_VIEWS)[number];

export const FLEET_VIEW_STORAGE_KEY = 'agentic.agents.view';

export const isFleetView = (value: unknown): value is FleetView =>
  typeof value === 'string' && (FLEET_VIEWS as readonly string[]).includes(value);

/** The stored choice, or `null` when there is none, it is not a view, or storage is refused. */
export const readStoredView = (storage: Pick<Storage, 'getItem'> | undefined): FleetView | null => {
  try {
    const value = storage?.getItem(FLEET_VIEW_STORAGE_KEY);
    return isFleetView(value) ? value : null;
  } catch {
    return null;
  }
};

export const storeView = (storage: Pick<Storage, 'setItem'> | undefined, view: FleetView): void => {
  try {
    storage?.setItem(FLEET_VIEW_STORAGE_KEY, view);
  } catch {
    // Storage refused (a private window, a quota): the choice is not remembered, the page works.
  }
};

/** The view to show: the URL's, else the stored one, else the map. */
export const chosenView = (fromUrl: unknown, stored: FleetView | null): FleetView =>
  isFleetView(fromUrl) ? fromUrl : (stored ?? 'map');
