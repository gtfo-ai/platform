/**
 * **What the updater does with the core's answer** — WP-287 (2), TD-032 decisions 3 and 6. Pure.
 *
 * The core advertises four digests (`GET release`, or the `426`'s body when it no longer serves this
 * worker's protocol). The updater compares them with the four this worker **runs** — the digests its
 * `PLATFORM_*_IMAGE` references pin — and decides:
 *
 *  - **nothing** when they are equal, when the core names none (`null`), or when this worker does not
 *    run pinned digests (a `platform:dev` checkout never self-updates: it is not the core's build);
 *  - **refuse** a downgrade — a target build attested **before** the running one — unless the
 *    core's protocol range excludes this worker's protocol, in which case following the core is the
 *    only way to keep working (TD-032 §3's residual: a compromised core may steer a worker to an older
 *    attested build; this is the bound). A build is its **commit**: the four images of a set must
 *    name one (the updater refuses a mixed set before it asks this), the same commit is never a
 *    downgrade, and two commits are ordered by the transparency log's time of their attestations —
 *    the earliest of each set's four. A time either side cannot establish is not an order, so it is
 *    refused the same way;
 *  - **update** otherwise. Verification is not decided here: every advertised digest is verified
 *    before this decision is even asked (`updater.ts`), so a refusal for a bad attestation comes first.
 */
import type { CoreImageDigests } from '@platform/contracts';
import { digestOfImageReference } from '../remote-worker/config.js';

/** The four image references this worker runs, as `PLATFORM_*_IMAGE` name them. */
export type ImageReferences = Readonly<Record<keyof CoreImageDigests, string>>;

export const IMAGE_KEYS = [
  'platform',
  'platform_launcher',
  'platform_runtime',
  'platform_egress',
] as const satisfies readonly (keyof CoreImageDigests)[];

/** Each image's repository below `APP_TRUSTED_IMAGE_REPOSITORY` (`…/platform` → `…/platform-launcher`). */
export const repositoriesOf = (
  trustedRepository: string,
): Readonly<Record<keyof CoreImageDigests, string>> => ({
  platform: trustedRepository,
  platform_launcher: `${trustedRepository}-launcher`,
  platform_runtime: `${trustedRepository}-runtime`,
  platform_egress: `${trustedRepository}-egress`,
});

/** The digests the running references pin, or `null` when any one is not pinned by digest. */
export const runningDigestsOf = (references: ImageReferences): CoreImageDigests | null => {
  const digests: Partial<Record<keyof CoreImageDigests, string>> = {};
  for (const key of IMAGE_KEYS) {
    const digest = digestOfImageReference(references[key]);
    if (digest === null) return null;
    digests[key] = digest;
  }
  return digests as CoreImageDigests;
};

export const sameDigests = (a: CoreImageDigests, b: CoreImageDigests): boolean =>
  IMAGE_KEYS.every((key) => a[key] === b[key]);

export type UpdateDecision =
  | { readonly kind: 'none'; readonly why: string }
  | { readonly kind: 'refuse'; readonly why: string }
  | { readonly kind: 'update'; readonly downgrade: boolean };

export const decideUpdate = (input: {
  readonly running: CoreImageDigests | null;
  readonly advertised: CoreImageDigests | null;
  /** The protocols the core accepts. */
  readonly accepted: readonly number[];
  /** This build's `WORKER_PROTOCOL_VERSION`. */
  readonly protocol: number;
  /** The commit each set's four attestations name, `null` when the set has none in common. */
  readonly runningCommit: string | null;
  readonly targetCommit: string | null;
  /** The earliest transparency-log time of each set's four attestations, `null` when unknown. */
  readonly runningAt: Date | null;
  readonly targetAt: Date | null;
}): UpdateDecision => {
  if (input.advertised === null) {
    return { kind: 'none', why: 'the core names no digests (digests_unresolved)' };
  }
  if (input.running === null) {
    return {
      kind: 'none',
      why: 'this worker does not run images pinned by digest, so it is not following a core',
    };
  }
  if (sameDigests(input.running, input.advertised)) {
    return { kind: 'none', why: 'this worker runs the digests its core advertises' };
  }
  const excluded = !input.accepted.includes(input.protocol);
  if (input.targetCommit !== null && input.targetCommit === input.runningCommit) {
    return { kind: 'update', downgrade: false };
  }
  const running = input.runningAt?.getTime() ?? Number.NaN;
  const target = input.targetAt?.getTime() ?? Number.NaN;
  const ordered = Number.isFinite(running) && Number.isFinite(target);
  const older = ordered && target < running;
  if (!ordered || older) {
    if (excluded) return { kind: 'update', downgrade: older };
    const when = (at: Date | null) => at?.toISOString() ?? 'unknown';
    return {
      kind: 'refuse',
      why: ordered
        ? `the advertised build (commit ${input.targetCommit}) was attested at ${when(input.targetAt)}, before this worker's build (commit ${input.runningCommit}, ${when(input.runningAt)}); a downgrade is refused while the core still serves this worker's protocol ${input.protocol}`
        : `the builds cannot be ordered (running ${input.runningCommit ?? 'unattested'} at ${when(input.runningAt)}, advertised ${input.targetCommit ?? 'unknown'} at ${when(input.targetAt)}), so this could be a downgrade; refused while the core still serves this worker's protocol ${input.protocol}`,
    };
  }
  return { kind: 'update', downgrade: false };
};
