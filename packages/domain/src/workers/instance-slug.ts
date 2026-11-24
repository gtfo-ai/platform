/**
 * **A platform's slug** — S-29.1, TD-031's 2026-11-24 amendment, decision 9 items 1 and 3.
 *
 * One pure function for the core and the worker alike: the installers name a second install after
 * it (S-29.2 renders it into `install.sh`/`install.ps1`) and the worker's page falls back to it
 * when it knows no name. The organisation's display name is read first; when nothing of it
 * survives, the core's host is (`agentic.fontai.org` → `fontai`: the first DNS label that is not
 * `agentic`, `www` or `worker`).
 *
 * What comes out is `''` or matches {@link INSTANCE_SLUG_PATTERN},
 * `^[a-z0-9][a-z0-9-]{0,23}$` — decision 9 item 1's pattern for a person's `--name`, which also lies
 * inside the updater's project pattern `^[a-z0-9][a-z0-9_-]*$` (`apps/server/src/updater/plan.ts`),
 * so `agentic-worker-<slug>` is a project name either reads. It never emits `_`.
 *
 * The steps: NFKD, combining marks dropped (so `Mikeš` is `mikes`, not `mike-s`), lowercase, every
 * run of anything outside `[a-z0-9]` one `-`, hyphens trimmed from both ends, cut to 24, and the
 * hyphens the cut left at the end trimmed again. A name of only symbols, emoji or another script
 * (`株式会社`) has nothing left and falls back to the host.
 */

/** The longest slug (decision 9 item 1). */
export const INSTANCE_SLUG_MAX_CHARS = 24;

/** What every non-empty slug matches (decision 9 item 1). */
export const INSTANCE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,23}$/;

/** The DNS labels a host's slug skips: they name the product, not the platform (decision 9 item 3). */
export const INSTANCE_HOST_SKIPPED_LABELS: readonly string[] = ['agentic', 'www', 'worker'];

/** A text's slug, or `''` when nothing of it is `[a-z0-9]` after folding. */
export const slugOfText = (text: string): string => {
  const folded = text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return folded.slice(0, INSTANCE_SLUG_MAX_CHARS).replace(/-+$/, '');
};

/**
 * A host's slug: the first DNS label that is not {@link INSTANCE_HOST_SKIPPED_LABELS}, slugged —
 * `agentic.fontai.org` → `fontai`, `www.agentic.autix.eu` → `autix`. An IP address is slugged whole
 * (`127.0.0.1` → `127-0-0-1`), since its first label names nothing. `''` when nothing is left.
 */
export const slugOfHost = (host: string): string => {
  const trimmed = host.trim().toLowerCase();
  // An IPv6 address, bracketed (a URL's `hostname`) or not: slugged whole.
  const bracketed = /^\[([^\]]*)\](?::\d+)?$/.exec(trimmed);
  if (bracketed !== null) return slugOfText(bracketed[1] ?? '');
  if ((trimmed.match(/:/g) ?? []).length > 1) return slugOfText(trimmed);
  const bare = trimmed.replace(/:\d+$/, '').replace(/\.$/, '');
  if (/^[0-9.]+$/.test(bare)) return slugOfText(bare);
  const labels = bare.split('.').filter((label) => label !== '');
  for (const label of labels) {
    if (INSTANCE_HOST_SKIPPED_LABELS.includes(label)) continue;
    const slug = slugOfText(label);
    if (slug !== '') return slug;
  }
  return '';
};

/**
 * The platform's slug: its name's, else its host's, else `''` (decision 9 item 3). `name` is the
 * organisation's display name as stored (`null` for none); `host` the core's host, port allowed.
 */
export const instanceSlug = (input: {
  readonly name: string | null;
  readonly host: string;
}): string => {
  const named = input.name === null ? '' : slugOfText(input.name);
  return named !== '' ? named : slugOfHost(input.host);
};
