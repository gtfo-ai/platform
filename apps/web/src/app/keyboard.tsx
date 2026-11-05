/**
 * The keyboard layer of the frame (research/19 § 3 rule 10, § 5.1): the top bar's **Search or jump
 * to…** button, the one `keydown` listener that applies `shortcuts.ts`, and the two dialogs it
 * opens — the command palette and the shortcuts sheet — which are a lazy chunk
 * (`command-palette.tsx`), fetched the first time either opens (or when the pointer or the focus
 * reaches the button, so the first press rarely waits for it).
 *
 * Mounted once, in the top bar, so it exists on every signed-in screen and on no other: the sign-in
 * page has nowhere to jump to.
 */
import type { ProjectSummary } from '@platform/contracts';
import { SearchIcon } from '@primer/octicons-react/SearchIcon';
import { useNavigate } from '@tanstack/react-router';
import { lazy, type ReactElement, Suspense, useEffect, useRef, useState } from 'react';
import { cx, FOCUS_RING } from '../ui/cx.js';
import { useProjectTasks } from './queries.js';
import {
  type ChordState,
  decideKey,
  IDLE,
  isInsideOverlay,
  isPaletteChord,
  isTypingTarget,
  moveInList,
  useShortcutsEnabled,
} from './shortcuts.js';

const loadDialogs = () => import('./command-palette.js');
const CommandPalette = lazy(async () => ({ default: (await loadDialogs()).CommandPalette }));
const ShortcutsSheet = lazy(async () => ({ default: (await loadDialogs()).ShortcutsSheet }));

export const CommandLayer = ({
  project,
  canCreateProject,
}: {
  /** The project the page is in, if any. */
  readonly project: ProjectSummary | null;
  readonly canCreateProject: boolean;
}): ReactElement => {
  const navigate = useNavigate();
  const enabled = useShortcutsEnabled();
  const tasks = useProjectTasks(project?.id ?? null);
  const canStartTicket = project !== null && tasks.data?.can_start_task === true;
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  // Mounted on first use and kept, so a second opening has no chunk to wait for.
  const [loaded, setLoaded] = useState(false);
  const chord = useRef<ChordState>(IDLE);

  const openPalette = (): void => {
    setLoaded(true);
    setSheetOpen(false);
    setPaletteOpen(true);
  };
  const openSheet = (): void => {
    setLoaded(true);
    setPaletteOpen(false);
    setSheetOpen(true);
  };

  // The latest of everything the listener reads, so it is registered once.
  const latest = useRef({ enabled, project, navigate, openPalette, openSheet });
  latest.current = { enabled, project, navigate, openPalette, openSheet };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const now = latest.current;
      if (event.defaultPrevented || isInsideOverlay(event.target)) {
        chord.current = IDLE;
        return;
      }
      if (isPaletteChord(event)) {
        event.preventDefault();
        chord.current = IDLE;
        now.openPalette();
        return;
      }
      if (!now.enabled || isTypingTarget(event.target)) {
        chord.current = IDLE;
        return;
      }
      const decided = decideKey(chord.current, event, Date.now());
      chord.current = decided.state;
      const action = decided.action;
      if (action === null) {
        return;
      }
      switch (action.kind) {
        case 'palette':
          event.preventDefault();
          now.openPalette();
          return;
        case 'sheet':
          event.preventDefault();
          now.openSheet();
          return;
        case 'row':
          if (moveInList(document.activeElement, action.step)) {
            event.preventDefault();
          }
          return;
        case 'jump':
          event.preventDefault();
          switch (action.to) {
            case 'home':
              void now.navigate({ to: '/' });
              return;
            case 'projects':
              void now.navigate({ to: '/projects' });
              return;
            case 'inbox':
              void now.navigate({ to: '/inbox' });
              return;
            case 'agents':
              void now.navigate({ to: '/agents' });
              return;
            case 'board':
              if (now.project !== null) {
                void now.navigate({ to: '/projects/$key', params: { key: now.project.key } });
              }
              return;
          }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const preload = (): void => {
    void loadDialogs();
  };

  return (
    <>
      <button
        type="button"
        aria-label="Search or jump to…"
        aria-keyshortcuts={enabled ? 'Meta+K Control+K /' : 'Meta+K Control+K'}
        onClick={openPalette}
        onPointerEnter={preload}
        onFocus={preload}
        className={cx(
          'inline-flex h-8 items-center gap-2 rounded-md border border-line px-2 text-sm text-fg-muted hover:bg-subtle hover:text-fg',
          FOCUS_RING,
        )}
      >
        <SearchIcon size={16} />
        <span className="hidden lg:inline">Search or jump to…</span>
        <span
          aria-hidden="true"
          className="hidden rounded border border-line px-1 font-mono text-xs lg:inline"
        >
          {enabled ? '/' : '⌘K'}
        </span>
      </button>
      {loaded ? (
        <Suspense fallback={null}>
          <CommandPalette
            open={paletteOpen}
            onOpenChange={setPaletteOpen}
            onShowShortcuts={openSheet}
            current={project}
            canCreateProject={canCreateProject}
            canStartTicket={canStartTicket}
          />
          <ShortcutsSheet open={sheetOpen} onOpenChange={setSheetOpen} />
        </Suspense>
      ) : null}
    </>
  );
};
