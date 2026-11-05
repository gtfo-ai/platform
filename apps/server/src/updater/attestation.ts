/**
 * **The build-attestation verifier** — WP-287 (2), TD-032 decision 3, TODO **V-WM6** (measured at
 * S-22.10).
 *
 * A worker's updater is root-equivalent on the developer's machine, so **the core chooses which
 * build, never what a build is**: every digest the core advertises is applied only after its
 * build attestation verifies against an identity configured **on the worker**
 * (`APP_TRUSTED_IMAGE_REPOSITORY`, `APP_TRUSTED_BUILDER`) — never served by the core.
 *
 * ## What V-WM6 measured (2026-11-05, `ghcr.io/gtfo-ai/platform:sha-640ca6a`)
 *
 * - **Where the attestation is**: `image.yml`'s `actions/attest-build-provenance` with
 *   `push-to-registry: true` stores a Sigstore bundle v0.3 (`application/vnd.dev.sigstore.bundle.v0.3+json`,
 *   a DSSE envelope over an in-toto statement, predicate `https://slsa.dev/provenance/v1`) as an OCI
 *   **referrer** of the manifest-list digest. GHCR answers the referrers API `404` and serves the
 *   OCI 1.1 tag fallback `sha256-<hex>`; both are read anonymously (`registry.ts`).
 * - **Which verifier**: `gh attestation verify` refuses to run without a GitHub token (measured:
 *   *"To get started with GitHub CLI, please run: gh auth login"*), and a worker has none to give;
 *   `cosign` 3.1.4 is 136–146 MB per architecture. **sigstore-js** (`@sigstore/verify`,
 *   `@sigstore/bundle`, `@sigstore/tuf` — GitHub's and npm's own provenance verifier) verified the real
 *   bundle in-process, anonymously, and refused it with a wrong workflow in the identity
 *   (`UNTRUSTED_SIGNER_ERROR`). It adds 2.2 MB to the image's `node_modules` (`du`; `make-fetch-happen` and its tree were already there).
 * - **The offline trust root**: the Sigstore public-good TUF root embedded in `@sigstore/tuf`
 *   (`seeds.json`). The verifier asks TUF for the current `trusted_root.json` (Fulcio, Rekor and CT
 *   keys) from `tuf-repo-cdn.sigstore.dev`, verified against that root, so a key rotation upstream is
 *   followed without a new image; the seed's own copy verified the same bundle offline (measured), and
 *   `attestation.test.ts` verifies the recorded bundle against it with no network.
 *
 * ## What is checked, all of it, for each digest
 *
 *  1. a referrer whose artifact type is a Sigstore bundle, fetched **by digest** (its bytes hashed);
 *  2. the bundle's signature, certificate chain to Fulcio, SCT and Rekor inclusion (sigstore-js), with
 *     the certificate's identity **equal** to `https://github.com/<APP_TRUSTED_BUILDER>` and its issuer
 *     GitHub Actions' OIDC (`https://token.actions.githubusercontent.com`);
 *  3. the in-toto statement: predicate type SLSA provenance v1; a subject whose **name** is the
 *     expected repository and whose **digest** is the advertised one; the provenance's workflow
 *     (repository, path, ref) equal to `APP_TRUSTED_BUILDER` again.
 *
 * **Keyless only** (the orchestrator's ruling on S-22.10's review): a keyed trust path would be a
 * second trust root TD-032 §3 never decided. The signature half is `signature.ts`.
 *
 * **What is a refusal and what is not.** Only a signature, certificate, bundle or statement that does
 * not verify refuses a digest (reported once per advertised set, `updater.ts`). A registry that does
 * not answer, answers `5xx`, or serves bytes that do not hash to the digest asked, and a trusted
 * root that cannot be fetched, are **thrown as they are** — the updater asks again at its next poll.
 */
import { bundleFromJSON } from '@sigstore/bundle';
import type { ImageRepository, RegistryClient } from './registry.js';
import {
  builderIdentity,
  createKeylessSignatureCheck,
  type SignatureCheck,
  SignatureRefusedError,
  type TrustedBuilder,
} from './signature.js';

export {
  builderIdentity,
  GITHUB_ACTIONS_ISSUER,
  type TrustedBuilder,
} from './signature.js';

/** The bundle artifact type `attest-build-provenance` pushes (v0.3; v0.2 accepted too). */
export const SIGSTORE_BUNDLE_ARTIFACT_TYPES = [
  'application/vnd.dev.sigstore.bundle.v0.3+json',
  'application/vnd.dev.sigstore.bundle+json;version=0.3',
  'application/vnd.dev.sigstore.bundle+json;version=0.2',
] as const;
export const SLSA_PROVENANCE_V1 = 'https://slsa.dev/provenance/v1';
/** At most this many referrers are tried for one digest; a bundle is a few KiB. */
export const MAX_ATTESTATION_CANDIDATES = 8;
export const BUNDLE_MAX_BYTES = 1024 * 1024;

/**
 * `APP_TRUSTED_BUILDER`: `<owner>/<repo>/<workflow path>@<ref>` — e.g.
 * `gtfo-ai/platform/.github/workflows/image.yml@refs/heads/main`. The ref defaults to
 * `refs/heads/main`. Its `https://github.com/` form is the Fulcio certificate's identity.
 */
export const parseTrustedBuilder = (raw: string): TrustedBuilder | null => {
  const value = raw.trim();
  const at = value.lastIndexOf('@');
  const path = at < 0 ? value : value.slice(0, at);
  const ref = at < 0 ? 'refs/heads/main' : value.slice(at + 1);
  const match =
    /^([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\/(\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml)$/.exec(path);
  if (match === null || !/^refs\/(heads|tags)\/[A-Za-z0-9._/-]+$/.test(ref)) return null;
  return { repository: match[1] as string, workflowPath: match[2] as string, ref };
};

export interface VerifierPolicy {
  readonly builder: TrustedBuilder;
}

/** A digest that does not verify: refused and reported, nothing pulled (TD-032 §3). */
export class AttestationRefusedError extends Error {
  override readonly name = 'AttestationRefusedError';
}

/** What a verified attestation says about the build. */
export interface VerifiedBuild {
  readonly repository: string;
  readonly digest: string;
  /**
   * The commit the provenance names — the certificate's source repository digest agrees with it
   * when both name one — or `null`. The updater requires the four images to name one commit.
   */
  readonly commit: string | null;
  /** The transparency log's time for the attestation: the order two builds are compared in. */
  readonly loggedAt: Date;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The in-toto statement's own checks (point 3 above), pure: the predicate type, the subject, the
 * provenance's workflow. Answers the commit the provenance names. Throws on any mismatch.
 */
export const checkStatement = (
  statement: unknown,
  expected: {
    readonly repository: string;
    readonly digest: string;
    readonly builder: TrustedBuilder;
  },
): { readonly commit: string | null } => {
  if (!isRecord(statement)) throw new AttestationRefusedError('the attestation is not a statement');
  if (statement.predicateType !== SLSA_PROVENANCE_V1) {
    throw new AttestationRefusedError(
      `the attestation's predicate is ${String(statement.predicateType)}, not SLSA provenance v1`,
    );
  }
  const hex = expected.digest.slice('sha256:'.length);
  const subjects = Array.isArray(statement.subject) ? statement.subject : [];
  const named = subjects.some(
    (subject) =>
      isRecord(subject) &&
      subject.name === expected.repository &&
      isRecord(subject.digest) &&
      subject.digest.sha256 === hex,
  );
  if (!named) {
    throw new AttestationRefusedError(
      `the attestation names no subject ${expected.repository}@${expected.digest}`,
    );
  }
  const predicate = isRecord(statement.predicate) ? statement.predicate : {};
  const definition = isRecord(predicate.buildDefinition) ? predicate.buildDefinition : {};
  const external = isRecord(definition.externalParameters) ? definition.externalParameters : {};
  const workflow = isRecord(external.workflow) ? external.workflow : {};
  const repositoryUrl = `https://github.com/${expected.builder.repository}`;
  if (
    workflow.repository !== repositoryUrl ||
    workflow.path !== expected.builder.workflowPath ||
    workflow.ref !== expected.builder.ref
  ) {
    throw new AttestationRefusedError(
      `the provenance's workflow is ${String(workflow.repository)}/${String(workflow.path)}@${String(workflow.ref)}, not the trusted builder ${repositoryUrl}/${expected.builder.workflowPath}@${expected.builder.ref}`,
    );
  }
  const dependencies = Array.isArray(definition.resolvedDependencies)
    ? definition.resolvedDependencies
    : [];
  const commit = dependencies
    .map((dependency) =>
      isRecord(dependency) && isRecord(dependency.digest) ? dependency.digest.gitCommit : undefined,
    )
    .find((value): value is string => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value));
  return { commit: commit ?? null };
};

export interface AttestationVerifier {
  /** Verifies `<repository>@<digest>`'s build attestation, or throws {@link AttestationRefusedError}. */
  verify(repository: string, image: ImageRepository, digest: string): Promise<VerifiedBuild>;
}

export const createAttestationVerifier = (input: {
  readonly registry: RegistryClient;
  readonly policy: VerifierPolicy;
  /** The signature half (default: keyless, `signature.ts`); a test hands its own. */
  readonly signature?: SignatureCheck;
  /** Where TUF caches its metadata (the default signature check's). */
  readonly tufCachePath?: string;
}): AttestationVerifier => {
  const { registry, policy } = input;
  const signature =
    input.signature ??
    createKeylessSignatureCheck(
      input.tufCachePath === undefined ? {} : { tufCachePath: input.tufCachePath },
    );

  /** What refuses: a signature, a bundle or a statement that does not verify. Nothing else. */
  const isRefusal = (error: unknown): boolean =>
    error instanceof AttestationRefusedError ||
    error instanceof SignatureRefusedError ||
    error instanceof SyntaxError ||
    (error instanceof Error && error.name === 'ValidationError');

  return {
    async verify(repository, image, digest) {
      // Registry failures propagate from here: the next poll asks again.
      const candidates = (await registry.referrers(image, digest))
        .filter(
          (entry) =>
            entry.artifactType !== undefined &&
            (SIGSTORE_BUNDLE_ARTIFACT_TYPES as readonly string[]).includes(entry.artifactType) &&
            (entry.annotations?.['dev.sigstore.bundle.predicateType'] ?? SLSA_PROVENANCE_V1) ===
              SLSA_PROVENANCE_V1,
        )
        .slice(0, MAX_ATTESTATION_CANDIDATES);
      if (candidates.length === 0) {
        throw new AttestationRefusedError(
          `${repository}@${digest} carries no build attestation in its registry; refused`,
        );
      }
      const reasons: string[] = [];
      for (const candidate of candidates) {
        // Fetched outside the refusal: a registry that fails here is not a refusal.
        const manifest = await registry.manifest(image, candidate.digest);
        const layers = Array.isArray(manifest.body.layers) ? manifest.body.layers : [];
        const layer = layers.find(
          (entry): entry is { digest: string } =>
            isRecord(entry) && typeof entry.digest === 'string',
        );
        if (layer === undefined) {
          reasons.push('the referrer has no layer');
          continue;
        }
        const bytes = await registry.blob(image, layer.digest, BUNDLE_MAX_BYTES);
        try {
          const bundle = bundleFromJSON(JSON.parse(bytes.toString('utf8')));
          if (bundle.content.$case !== 'dsseEnvelope') {
            throw new AttestationRefusedError('the bundle carries no DSSE envelope');
          }
          const signed = await signature.verify(bundle, policy.builder);
          const envelope = bundle.content.dsseEnvelope;
          if (envelope.payloadType !== 'application/vnd.in-toto+json') {
            throw new AttestationRefusedError(`the envelope carries ${envelope.payloadType}`);
          }
          const statement: unknown = JSON.parse(Buffer.from(envelope.payload).toString('utf8'));
          const { commit } = checkStatement(statement, {
            repository,
            digest,
            builder: policy.builder,
          });
          if (commit !== null && signed.commit !== null && commit !== signed.commit) {
            throw new AttestationRefusedError(
              `the provenance names commit ${commit} and the certificate ${signed.commit}`,
            );
          }
          return { repository, digest, commit: commit ?? signed.commit, loggedAt: signed.loggedAt };
        } catch (error) {
          if (!isRefusal(error)) throw error;
          reasons.push((error as Error).message);
        }
      }
      throw new AttestationRefusedError(
        `${repository}@${digest}: no attestation verifies against the trusted builder ${builderIdentity(policy.builder)} (${reasons.join('; ')}); refused`,
      );
    },
  };
};
