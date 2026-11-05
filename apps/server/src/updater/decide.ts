/**
 * **What the updater does with the core's answer** — WP-287 (2), TD-032 decisions 3 and 6. Pure.
 *
 * The core advertises four digests (`GET release`, or the `426`'s body when it no longer serves this
 * worker's protocol). The updater compares them with the four this worker **runs** — the digests its
 * `PLATFORM_*_IMAGE` references pin — and decides:
 *
 *  - **nothing** when they are equal, when the core names none (`null`), or when this worker does not
 *    run pinned digests (a `platform:dev` checkout never self-updates: it is not the core's build);
 *  - **refuse** a downgrade — a target `platform` image built **before** the running one — unless the
 *    core's protocol range excludes this worker's protocol, in which case following the core is the
 *    only way to keep working (TD-032 §3's residual: a compromised core may steer a worker to an older
 *    attested build; this is the bound). A build time either side cannot read is not an order, so it
 *    is refused the same way;
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
  /** `APP_BUILT_AT` of the running build and of the advertised `platform` image. */
  readonly runningBuiltAt: string | null;
  readonly targetBuiltAt: string | null;
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
  const running = input.runningBuiltAt === null ? Number.NaN : Date.parse(input.runningBuiltAt);
  const target = input.targetBuiltAt === null ? Number.NaN : Date.parse(input.targetBuiltAt);
  const ordered = Number.isFinite(running) && Number.isFinite(target);
  const older = ordered && target < running;
  if (!ordered || older) {
    if (excluded) return { kind: 'update', downgrade: older };
    return {
      kind: 'refuse',
      why: ordered
        ? `the advertised platform image was built at ${input.targetBuiltAt}, before this worker's build (${input.runningBuiltAt}); a downgrade is refused while the core still serves this worker's protocol ${input.protocol}`
        : `the build times cannot be compared (running ${input.runningBuiltAt ?? 'unknown'}, advertised ${input.targetBuiltAt ?? 'unknown'}), so this could be a downgrade; refused while the core still serves this worker's protocol ${input.protocol}`,
    };
  }
  return { kind: 'update', downgrade: false };
};
