/**
 * The attestation verifier (WP-287 (2), V-WM6) against **recorded** registry answers.
 *
 * `test/fixtures/attestations/ghcr-platform-640ca6a/` is what GHCR served anonymously on 2026-11-05
 * for `ghcr.io/gtfo-ai/platform@sha256:16cbb56e…` (`sha-640ca6a`, the build Autix runs): the OCI 1.1
 * referrers tag `sha256-16cbb56e…` (`referrers-index.json`), the attestation manifest it lists
 * (`attestation-manifest.json`) and the Sigstore bundle that is its one layer (`bundle.sigstore.json`)
 * — byte for byte, which is why biome does not format that directory: every file is asked for by its
 * digest and hashed. They are verified here with **no network**, against the Sigstore public-good
 * trusted root seeded in `@sigstore/tuf` (`forceCache`), which is the verifier's offline trust root.
 *
 * There is no keyed path (the orchestrator's ruling on PR #38): every signature here is the real one.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTrustedRoot } from '@sigstore/tuf';
import { describe, expect, it } from 'vitest';
import {
  AttestationRefusedError,
  builderIdentity,
  checkStatement,
  createAttestationVerifier,
  parseTrustedBuilder,
  type TrustedBuilder,
} from './attestation.js';
import {
  createRegistryClient,
  parseImageRepositoryName,
  RegistryError,
  sha256Of,
} from './registry.js';
import { createKeylessSignatureCheck, derUtf8 } from './signature.js';

const FIXTURES = fileURLToPath(
  new URL('../../../../test/fixtures/attestations/ghcr-platform-640ca6a/', import.meta.url),
);
const fixture = (name: string): Buffer => readFileSync(path.join(FIXTURES, name));
const IMAGE_DIGEST = 'sha256:16cbb56eee29d051deacc706addf26b67c2a26882afdc3278b26bc799a7a1cfb';
const REPOSITORY = 'ghcr.io/gtfo-ai/platform';
const BUILDER = parseTrustedBuilder(
  'gtfo-ai/platform/.github/workflows/image.yml@refs/heads/main',
) as TrustedBuilder;

/** A registry answering from a URL → bytes table; anything else is 404. Records every URL asked. */
const recordedRegistry = (table: Readonly<Record<string, Buffer>>) => {
  const asked: string[] = [];
  const fetch = async (url: string): Promise<Response> => {
    asked.push(url);
    const body = table[url];
    return body === undefined
      ? new Response('{"errors":[{"code":"MANIFEST_UNKNOWN"}]}', { status: 404 })
      : new Response(new Uint8Array(body), { status: 200 });
  };
  return { asked, client: createRegistryClient({ fetch }) };
};

const ghcrTable = (overrides: Record<string, Buffer> = {}): Record<string, Buffer> => {
  const manifest = fixture('attestation-manifest.json');
  const bundle = fixture('bundle.sigstore.json');
  return {
    [`https://ghcr.io/v2/gtfo-ai/platform/manifests/sha256-${IMAGE_DIGEST.slice(7)}`]:
      fixture('referrers-index.json'),
    [`https://ghcr.io/v2/gtfo-ai/platform/manifests/${sha256Of(manifest)}`]: manifest,
    [`https://ghcr.io/v2/gtfo-ai/platform/blobs/${sha256Of(bundle)}`]: bundle,
    ...overrides,
  };
};

const seededRoot = () =>
  getTrustedRoot({ cachePath: mkdtempSync(path.join(tmpdir(), 'tuf-seed-')), forceCache: true });

const image = parseImageRepositoryName(REPOSITORY) as NonNullable<
  ReturnType<typeof parseImageRepositoryName>
>;

describe('the recorded GHCR attestation of sha-640ca6a, verified offline (V-WM6)', () => {
  it('verifies against the trusted builder, and names the commit the provenance records', async () => {
    const { client, asked } = recordedRegistry(ghcrTable());
    const verifier = createAttestationVerifier({
      registry: client,
      policy: { builder: BUILDER },
      signature: createKeylessSignatureCheck({ trustedRoot: seededRoot }),
    });
    await expect(verifier.verify(REPOSITORY, image, IMAGE_DIGEST)).resolves.toEqual({
      repository: REPOSITORY,
      digest: IMAGE_DIGEST,
      commit: '640ca6acb3bf411f1f74d2c13514888438f4cb6a',
      // Rekor's integratedTime for the entry (1793877604), the order two builds are compared in.
      loggedAt: new Date(1_793_877_604_000),
    });
    // The referrers API first (GHCR answers it 404), then the OCI 1.1 tag fallback.
    expect(asked[0]).toBe(`https://ghcr.io/v2/gtfo-ai/platform/referrers/${IMAGE_DIGEST}`);
    expect(asked[1]).toContain('/manifests/sha256-16cbb56e');
  });

  it('refuses it for another workflow, another ref or another repository in the identity', async () => {
    for (const builder of [
      'gtfo-ai/platform/.github/workflows/ci.yml@refs/heads/main',
      'gtfo-ai/platform/.github/workflows/image.yml@refs/heads/feature',
      'someone-else/platform/.github/workflows/image.yml@refs/heads/main',
    ]) {
      const { client } = recordedRegistry(ghcrTable());
      const verifier = createAttestationVerifier({
        registry: client,
        policy: { builder: parseTrustedBuilder(builder) as TrustedBuilder },
        signature: createKeylessSignatureCheck({ trustedRoot: seededRoot }),
      });
      await expect(verifier.verify(REPOSITORY, image, IMAGE_DIGEST)).rejects.toThrow(
        AttestationRefusedError,
      );
    }
  });

  it('refuses it as the attestation of another repository (the subject names platform)', async () => {
    const { client } = recordedRegistry(ghcrTable());
    const verifier = createAttestationVerifier({
      registry: client,
      policy: { builder: BUILDER },
      signature: createKeylessSignatureCheck({ trustedRoot: seededRoot }),
    });
    await expect(
      verifier.verify('ghcr.io/gtfo-ai/platform-launcher', image, IMAGE_DIGEST),
    ).rejects.toThrow(/names no subject ghcr\.io\/gtfo-ai\/platform-launcher/);
  });

  it('refuses a digest that carries no attestation; bytes that do not hash are asked again, not refused', async () => {
    const other = `sha256:${'e'.repeat(64)}`;
    const { client } = recordedRegistry(ghcrTable());
    const verifier = createAttestationVerifier({
      registry: client,
      policy: { builder: BUILDER },
      signature: createKeylessSignatureCheck({ trustedRoot: seededRoot }),
    });
    await expect(verifier.verify(REPOSITORY, image, other)).rejects.toThrow(
      /carries no build attestation/,
    );
    // The same URL serving other bytes: the registry client refuses what does not hash to the digest.
    const bundle = fixture('bundle.sigstore.json');
    const tampered = Buffer.from(
      bundle.toString('utf8').replace('"payloadType"', '"payloadType" '),
    );
    const altered = recordedRegistry(
      ghcrTable({ [`https://ghcr.io/v2/gtfo-ai/platform/blobs/${sha256Of(bundle)}`]: tampered }),
    );
    const refusing = createAttestationVerifier({
      registry: altered.client,
      policy: { builder: BUILDER },
      signature: createKeylessSignatureCheck({ trustedRoot: seededRoot }),
    });
    // Not a refusal: a registry serving the wrong bytes is asked again at the next poll.
    const tamperedAnswer = refusing.verify(REPOSITORY, image, IMAGE_DIGEST);
    await expect(tamperedAnswer).rejects.toThrow(/do not hash to the digest/);
    await expect(tamperedAnswer).rejects.toBeInstanceOf(RegistryError);
  });
});

const statementFor = (repository: string, digest: string, builder = BUILDER) => ({
  _type: 'https://in-toto.io/Statement/v1',
  subject: [{ name: repository, digest: { sha256: digest.slice(7) } }],
  predicateType: 'https://slsa.dev/provenance/v1',
  predicate: {
    buildDefinition: {
      externalParameters: {
        workflow: {
          ref: builder.ref,
          repository: `https://github.com/${builder.repository}`,
          path: builder.workflowPath,
        },
      },
      resolvedDependencies: [{ digest: { gitCommit: 'a'.repeat(40) } }],
    },
  },
});

describe('what is a refusal, and what is asked again (review of PR #38)', () => {
  it('throws a registry that answers 503 as it is — not a refusal — and verifies once it answers', async () => {
    const table = ghcrTable();
    let failing = true;
    const asked: string[] = [];
    const client = createRegistryClient({
      fetch: async (url) => {
        asked.push(url);
        if (failing && url.includes('/blobs/')) {
          failing = false;
          return new Response('busy', { status: 503 });
        }
        const body = table[url];
        return body === undefined
          ? new Response('{}', { status: 404 })
          : new Response(new Uint8Array(body), { status: 200 });
      },
    });
    const verifier = createAttestationVerifier({
      registry: client,
      policy: { builder: BUILDER },
      signature: createKeylessSignatureCheck({ trustedRoot: seededRoot }),
    });
    const first = verifier.verify(REPOSITORY, image, IMAGE_DIGEST);
    await expect(first).rejects.toBeInstanceOf(RegistryError);
    await expect(first).rejects.not.toBeInstanceOf(AttestationRefusedError);
    await expect(verifier.verify(REPOSITORY, image, IMAGE_DIGEST)).resolves.toMatchObject({
      commit: '640ca6acb3bf411f1f74d2c13514888438f4cb6a',
    });
  });

  it('throws a trusted root that cannot be read as it is — not a refusal', async () => {
    const { client } = recordedRegistry(ghcrTable());
    const verifier = createAttestationVerifier({
      registry: client,
      policy: { builder: BUILDER },
      signature: createKeylessSignatureCheck({
        trustedRoot: async () => {
          throw new Error('tuf-repo-cdn.sigstore.dev: ECONNRESET');
        },
      }),
    });
    await expect(verifier.verify(REPOSITORY, image, IMAGE_DIGEST)).rejects.toThrow(
      /trusted root could not be read/,
    );
    await expect(verifier.verify(REPOSITORY, image, IMAGE_DIGEST)).rejects.not.toBeInstanceOf(
      AttestationRefusedError,
    );
  });

  it('reads the trusted root afresh after a refusal, and only then', async () => {
    let roots = 0;
    const counted = async () => {
      roots += 1;
      return seededRoot();
    };
    const check = createKeylessSignatureCheck({ trustedRoot: counted });
    const verifyAs = (builder: string) => {
      const { client } = recordedRegistry(ghcrTable());
      return createAttestationVerifier({
        registry: client,
        policy: { builder: parseTrustedBuilder(builder) as TrustedBuilder },
        signature: check,
      }).verify(REPOSITORY, image, IMAGE_DIGEST);
    };
    await verifyAs('gtfo-ai/platform/.github/workflows/image.yml@refs/heads/main');
    await verifyAs('gtfo-ai/platform/.github/workflows/image.yml@refs/heads/main');
    expect(roots).toBe(1);
    await expect(
      verifyAs('gtfo-ai/platform/.github/workflows/ci.yml@refs/heads/main'),
    ).rejects.toBeInstanceOf(AttestationRefusedError);
    await verifyAs('gtfo-ai/platform/.github/workflows/image.yml@refs/heads/main');
    expect(roots).toBe(2);
  });

  it('reads a Fulcio extension as a DER UTF8String, and nothing else as one', () => {
    expect(derUtf8(Buffer.from([0x0c, 0x0f, ...Buffer.from('refs/heads/main')]))).toBe(
      'refs/heads/main',
    );
    const long = 'x'.repeat(200);
    expect(derUtf8(Buffer.from([0x0c, 0x81, 200, ...Buffer.from(long)]))).toBe(long);
    // A raw string (Fulcio's v1 extensions), a wrong length, another tag: not a v2 value.
    expect(derUtf8(Buffer.from('refs/heads/main'))).toBeNull();
    expect(derUtf8(Buffer.from([0x0c, 0x05, 0x61]))).toBeNull();
    expect(derUtf8(Buffer.from([0x13, 0x01, 0x61]))).toBeNull();
  });
});

describe('the trusted builder and the statement, pure', () => {
  it('parses a builder with and without its ref, and refuses anything else', () => {
    expect(parseTrustedBuilder('acme/platform/.github/workflows/image.yml')).toEqual({
      repository: 'acme/platform',
      workflowPath: '.github/workflows/image.yml',
      ref: 'refs/heads/main',
    });
    expect(builderIdentity(BUILDER)).toBe(
      'https://github.com/gtfo-ai/platform/.github/workflows/image.yml@refs/heads/main',
    );
    for (const bad of [
      'acme/platform',
      'acme/platform/workflows/image.yml',
      'acme/platform/.github/workflows/image.yml@main',
      'https://github.com/acme/platform/.github/workflows/image.yml',
    ]) {
      expect(parseTrustedBuilder(bad)).toBeNull();
    }
  });

  it('refuses a statement whose predicate is not SLSA provenance v1', () => {
    const statement = { ...statementFor(REPOSITORY, IMAGE_DIGEST), predicateType: 'other' };
    expect(() =>
      checkStatement(statement, { repository: REPOSITORY, digest: IMAGE_DIGEST, builder: BUILDER }),
    ).toThrow(/not SLSA provenance v1/);
  });
});
