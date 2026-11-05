/**
 * **The keyless signature check of a build attestation** — WP-287 (2), TD-032 decision 3, V-WM6.
 *
 * One Sigstore bundle, verified the way `gh attestation verify --repo <r> --signer-workflow <w>
 * --source-ref <ref>` verifies it, in-process with sigstore-js:
 *
 *  - the certificate chains to Fulcio, carries an SCT, and the entry is in Rekor (inclusion verified,
 *    so its `integratedTime` is the log's, not the bundle's word);
 *  - the certificate's identity (SAN) is `https://github.com/<APP_TRUSTED_BUILDER>` and its issuer
 *    GitHub Actions' OIDC;
 *  - its Fulcio **source repository** (OID `…57264.1.12`) is `https://github.com/<repo>` and its
 *    **source repository ref** (`…1.14`) is the builder's ref; its **source repository digest**
 *    (`…1.13`) is the commit, answered to the caller to compare with the provenance's.
 *
 * **Keyless only** (the orchestrator's ruling on S-22.10's review): there is no keyed trust path. The
 * trust root is the Sigstore public-good TUF root `@sigstore/tuf` embeds; the current
 * `trusted_root.json` is fetched through TUF. A fetch failure is **not** a refusal: it is thrown as
 * {@link SignatureUnavailableError} and the updater asks again at its next poll.
 */
import type { Bundle } from '@sigstore/bundle';
import { getTrustedRoot } from '@sigstore/tuf';
import { toSignedEntity, toTrustMaterial, Verifier } from '@sigstore/verify';

export const GITHUB_ACTIONS_ISSUER = 'https://token.actions.githubusercontent.com';

/** Fulcio's GitHub-workflow certificate extensions (sigstore/fulcio `docs/oid-info.md`), v2 (DER). */
const SOURCE_REPOSITORY_URI = '1.3.6.1.4.1.57264.1.12';
const SOURCE_REPOSITORY_DIGEST = '1.3.6.1.4.1.57264.1.13';
const SOURCE_REPOSITORY_REF = '1.3.6.1.4.1.57264.1.14';

/** `<owner>/<repo>/<workflow path>@<ref>` — `APP_TRUSTED_BUILDER`, parsed (`attestation.ts`). */
export interface TrustedBuilder {
  readonly repository: string;
  readonly workflowPath: string;
  readonly ref: string;
}

export const builderIdentity = (builder: TrustedBuilder): string =>
  `https://github.com/${builder.repository}/${builder.workflowPath}@${builder.ref}`;

/** What a verified signature establishes beyond the bytes. */
export interface VerifiedSignature {
  /** The transparency log's time for the entry — the order builds are compared in. */
  readonly loggedAt: Date;
  /** The certificate's source repository digest: the commit the workflow ran at. */
  readonly commit: string | null;
}

/** The signature, the certificate or its identity does not verify: a refusal. */
export class SignatureRefusedError extends Error {
  override readonly name = 'SignatureRefusedError';
}

/** The trust root could not be fetched: not a refusal — the next poll asks again. */
export class SignatureUnavailableError extends Error {
  override readonly name = 'SignatureUnavailableError';
}

export interface SignatureCheck {
  verify(bundle: Bundle, builder: TrustedBuilder): Promise<VerifiedSignature>;
}

type TrustedRoot = Parameters<typeof toTrustMaterial>[0];

/** A DER UTF8String (`0c <len> <bytes>`, short or long length) as text; anything else is `null`. */
export const derUtf8 = (value: Buffer): string | null => {
  if (value.length < 2 || value[0] !== 0x0c) return null;
  const first = value[1] as number;
  if (first < 0x80) return value.length === 2 + first ? value.subarray(2).toString('utf8') : null;
  const octets = first & 0x7f;
  if (octets < 1 || octets > 2 || value.length < 2 + octets) return null;
  let length = 0;
  for (let index = 0; index < octets; index += 1)
    length = length * 256 + (value[2 + index] as number);
  return value.length === 2 + octets + length ? value.subarray(2 + octets).toString('utf8') : null;
};

export const createKeylessSignatureCheck = (
  options: {
    /** Test seam: the trusted root (default: TUF from the embedded public-good root). */
    readonly trustedRoot?: () => Promise<TrustedRoot>;
    /** Where TUF caches its metadata. */
    readonly tufCachePath?: string;
  } = {},
): SignatureCheck => {
  let verifier: Verifier | null = null;
  const verifierOf = async (): Promise<Verifier> => {
    if (verifier !== null) return verifier;
    let root: TrustedRoot;
    try {
      root = await (
        options.trustedRoot ??
        (() =>
          getTrustedRoot(
            options.tufCachePath === undefined ? {} : { cachePath: options.tufCachePath },
          ))
      )();
    } catch (error) {
      throw new SignatureUnavailableError(
        `the Sigstore trusted root could not be read (${(error as Error).message}); asked again at the next poll`,
      );
    }
    verifier = new Verifier(toTrustMaterial(root), { tlogThreshold: 1, ctlogThreshold: 1 });
    return verifier;
  };
  return {
    async verify(bundle, builder) {
      const current = await verifierOf();
      let signer: ReturnType<Verifier['verify']>;
      try {
        signer = current.verify(toSignedEntity(bundle), {
          subjectAlternativeName: builderIdentity(builder),
          extensions: { issuer: GITHUB_ACTIONS_ISSUER },
        });
      } catch (error) {
        // A refusal may be a key rotation the cached root predates: the next one is asked afresh.
        verifier = null;
        throw new SignatureRefusedError((error as Error).message);
      }
      const oid = (id: string): string | null => {
        const pair = signer.identity?.oids?.find((entry) => entry.oid?.id.join('.') === id);
        return pair === undefined ? null : derUtf8(Buffer.from(pair.value));
      };
      const repository = oid(SOURCE_REPOSITORY_URI);
      const ref = oid(SOURCE_REPOSITORY_REF);
      const expectedRepository = `https://github.com/${builder.repository}`;
      if (repository !== expectedRepository || ref !== builder.ref) {
        throw new SignatureRefusedError(
          `the certificate's source repository is ${String(repository)} at ${String(ref)}, not ${expectedRepository} at ${builder.ref}`,
        );
      }
      const commit = oid(SOURCE_REPOSITORY_DIGEST);
      const times = bundle.verificationMaterial.tlogEntries
        .map((entry) => Number(entry.integratedTime))
        .filter((seconds) => Number.isFinite(seconds) && seconds > 0);
      if (times.length === 0) {
        throw new SignatureRefusedError('the bundle carries no transparency-log time');
      }
      return {
        loggedAt: new Date(Math.min(...times) * 1000),
        commit: commit !== null && /^[0-9a-f]{40}$/.test(commit) ? commit : null,
      };
    },
  };
};
