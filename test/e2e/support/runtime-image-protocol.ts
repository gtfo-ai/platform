/**
 * The fixture's one refusal of a stale run image (WP-169, PROGRESS backlog 504).
 *
 * Since WP-151 the provider reads `com.agentic.runlet-protocol` at every `create` and refuses an
 * image that declares no protocol, or another one, as `invalid_spec`. A `platform-runtime` built
 * before WP-151 therefore failed every case that creates a run, each on its own, with a sentence
 * that names no command. This asks the same question once, before the fixture creates anything,
 * and answers it with the command that rebuilds the image. It never skips (WP-22's row).
 *
 * Kept apart from `docker-workspace.ts` so the unit tier can reach it without the provider's
 * import graph (`scripts/e2e-runtime-image-protocol.test.ts`).
 */
import {
  declaredRunletProtocol,
  RUNLET_PROTOCOL_IMAGE_LABEL,
  RUNLET_PROTOCOL_VERSION,
} from '@platform/contracts';

/** How the two images are built, quoted verbatim in the failure when one is missing or stale. */
export const BUILD_IMAGES_COMMAND = 'node scripts/build-images.mjs runtime egress';

type Docker = (
  args: readonly string[],
  options?: { allowFailure?: boolean },
) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

/**
 * Throws when `image` does not declare {@link RUNLET_PROTOCOL_VERSION}, naming the image, both
 * numbers (the image's as *none* when it declares none) and {@link BUILD_IMAGES_COMMAND}.
 */
export const assertRuntimeImageProtocol = async (docker: Docker, image: string): Promise<void> => {
  const { stdout } = await docker([
    'image',
    'inspect',
    '--format',
    '{{json .Config.Labels}}',
    image,
  ]);
  const labels = JSON.parse(stdout || 'null') as Record<string, string> | null;
  // The launcher's own reading of the label, so the two cannot disagree about a spelling.
  const declared = declaredRunletProtocol(labels?.[RUNLET_PROTOCOL_IMAGE_LABEL]);
  if (declared === RUNLET_PROTOCOL_VERSION) {
    return;
  }
  throw new Error(
    `the run image ${image} declares shim protocol ${declared ?? 'none'} ` +
      `(${RUNLET_PROTOCOL_IMAGE_LABEL}), and this checkout's runner speaks protocol ` +
      `${RUNLET_PROTOCOL_VERSION}: rebuild it with \`${BUILD_IMAGES_COMMAND}\`, or point ` +
      'WORKSPACE_E2E_RUNTIME_IMAGE at an image built from this commit.',
  );
};
