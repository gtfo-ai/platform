/**
 * A readiness level's words — its ladder name and the badge's "what agents may do" (product/17's
 * 2026-11-06 amendment, S-25.2) — as plain data, shared by the badge (`readiness-label.tsx`, in the
 * initial graph), its lazy popover (`readiness-popover.tsx`) and the wizard. A module of its own so
 * the popover's chunk reads them without importing the badge that loads it.
 */

export interface ReadinessLevelLook {
  /** product/17 § "Levels": the ladder's own name. */
  readonly name: string;
  /** The badge: what agents may do (product/17's 2026-11-06 amendment, word for word). */
  readonly badge: string;
}

/**
 * product/17 § "Levels", one entry per level it names (0 … 4). What each level *means* is the
 * popover's (`READINESS_LEVEL_MEANINGS`, in the lazy chunk).
 */
export const READINESS_LEVELS: readonly ReadinessLevelLook[] = [
  {
    name: 'Unverified',
    badge: 'Plans need your OK',
  },
  {
    name: 'Basic',
    badge: 'Big plans need your OK',
  },
  {
    name: 'Reliable',
    badge: 'Big plans need your OK',
  },
  {
    name: 'Agent-ready',
    badge: 'Agents plan on their own',
  },
  {
    name: 'Autonomous-capable',
    badge: 'Ready for more autonomy',
  },
];

export const levelLook = (level: number): ReadinessLevelLook | undefined => READINESS_LEVELS[level];

/** The badge's words: what agents may do, or "Level 5" for a level product/17 does not name. */
export const readinessBadgeWord = (level: number): string =>
  levelLook(level)?.badge ?? `Level ${level}`;

/** The ladder's name and number, as the popover titles it: "Level 0 · Unverified". */
export const readinessLadderName = (level: number): string => {
  const look = levelLook(level);
  return look === undefined ? `Level ${level}` : `Level ${level} · ${look.name}`;
};

/** Beside the wizard's "Readiness level 1": "Basic · Big plans need your OK", the number not repeated. */
export const readinessNameAndWord = (level: number): string => {
  const look = levelLook(level);
  return look === undefined ? `Level ${level}` : `${look.name} · ${look.badge}`;
};

/** The wizard's one-line summary: "Big plans need your OK (level 1, Basic)". */
export const readinessSummary = (level: number): string => {
  const look = levelLook(level);
  return look === undefined ? `Level ${level}` : `${look.badge} (level ${level}, ${look.name})`;
};

export type ReadinessTone = 'neutral' | 'success';

/** Neutral through level 2 — level 0 is the normal start, never red — and success from level 3. */
export const readinessTone = (level: number): ReadinessTone => (level >= 3 ? 'success' : 'neutral');
