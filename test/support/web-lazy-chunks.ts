/**
 * Loads the SPA's lazily-loaded **component** modules before a `ui` test file runs — the vitest
 * setup file of the `ui` project only (`vitest.config.ts`, S-25.13).
 *
 * `ui/action-menu.tsx` loads Base UI's Menu (`ui/action-menu-base.tsx`) with `import()`, because the
 * Menu was the largest contributor to TD-013's initial graph, and a menu that first renders before
 * the module has arrived is a plain trigger that Base UI's replaces on a press. In a browser that is
 * only the frame's menus on the first paint; in a test every menu would be one, and the trigger a
 * test holds would be detached by the press it made. So the module is loaded here, once per test
 * file and before its module graph renders anything, and every test meets the menu exactly as it
 * did when the import was static. A setup file shares the test file's module registry, so this is
 * the same `action-menu.tsx` instance the test renders.
 *
 * What it trades: no test but the ones written for it sees the plain trigger —
 * `ui/action-menu.test.tsx`'s *ActionMenu drawn before its menu module has loaded*, which resets
 * the registry to get a fresh, unloaded instance.
 */
import { loadActionMenu } from '../../apps/web/src/ui/action-menu.js';

await loadActionMenu();
