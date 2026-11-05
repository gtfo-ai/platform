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
 * The key-signed half is the Docker check's shape: a bundle with a `publicKey` hint, signed by a key
 * this test makes, so every refusal can be planted.
 */
import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
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
  parseTrustedKey,
  type TrustedBuilder,
} from './attestation.js';
import { createRegistryClient, parseImageRepositoryName, sha256Of } from './registry.js';

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
      policy: { builder: BUILDER, key: null },
      trustedRoot: seededRoot,
    });
    await expect(verifier.verify(REPOSITORY, image, IMAGE_DIGEST)).resolves.toEqual({
      repository: REPOSITORY,
      digest: IMAGE_DIGEST,
      commit: '640ca6acb3bf411f1f74d2c13514888438f4cb6a',
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
        policy: { builder: parseTrustedBuilder(builder) as TrustedBuilder, key: null },
        trustedRoot: seededRoot,
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
      policy: { builder: BUILDER, key: null },
      trustedRoot: seededRoot,
    });
    await expect(
      verifier.verify('ghcr.io/gtfo-ai/platform-launcher', image, IMAGE_DIGEST),
    ).rejects.toThrow(/names no subject ghcr\.io\/gtfo-ai\/platform-launcher/);
  });

  it('refuses a digest that carries no attestation, and one whose bundle bytes were altered', async () => {
    const other = `sha256:${'e'.repeat(64)}`;
    const { client } = recordedRegistry(ghcrTable());
    const verifier = createAttestationVerifier({
      registry: client,
      policy: { builder: BUILDER, key: null },
      trustedRoot: seededRoot,
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
      policy: { builder: BUILDER, key: null },
      trustedRoot: seededRoot,
    });
    await expect(refusing.verify(REPOSITORY, image, IMAGE_DIGEST)).rejects.toThrow(
      /do not hash to the digest/,
    );
  });
});

// ── A key-signed bundle (the Docker check's shape) ─────────────────────────────────────────────

const pae = (type: string, body: Buffer): Buffer =>
  Buffer.concat([Buffer.from(`DSSEv1 ${Buffer.byteLength(type)} ${type} ${body.length} `), body]);

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

const signedBundle = (privateKey: KeyObject, statement: unknown): Buffer => {
  const payload = Buffer.from(JSON.stringify(statement));
  const type = 'application/vnd.in-toto+json';
  const signature = sign('sha256', pae(type, payload), privateKey);
  return Buffer.from(
    JSON.stringify({
      mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
      verificationMaterial: {
        publicKey: { hint: 'worker-update-check' },
        tlogEntries: [],
        timestampVerificationData: { rfc3161Timestamps: [] },
      },
      dsseEnvelope: {
        payload: payload.toString('base64'),
        payloadType: type,
        signatures: [{ sig: signature.toString('base64'), keyid: '' }],
      },
    }),
  );
};

/** A local registry's table for one image digest and its one key-signed attestation. */
const keyedTable = (digest: string, bundle: Buffer): Record<string, Buffer> => {
  const empty = Buffer.from('{}');
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      artifactType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
      config: {
        mediaType: 'application/vnd.oci.empty.v1+json',
        digest: sha256Of(empty),
        size: 2,
      },
      layers: [
        {
          mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
          digest: sha256Of(bundle),
          size: bundle.length,
        },
      ],
    }),
  );
  const index = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.index.v1+json',
      manifests: [
        {
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          digest: sha256Of(manifest),
          size: manifest.length,
          artifactType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
        },
      ],
    }),
  );
  const base = 'https://localhost:5000/v2/acme/platform';
  return {
    [`${base}/manifests/sha256-${digest.slice(7)}`]: index,
    [`${base}/manifests/${sha256Of(manifest)}`]: manifest,
    [`${base}/blobs/${sha256Of(bundle)}`]: bundle,
  };
};

describe('a key-signed attestation (APP_TRUSTED_ATTESTATION_KEY)', () => {
  const trusted = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const stranger = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const local = parseImageRepositoryName('localhost:5000/acme/platform') as NonNullable<
    ReturnType<typeof parseImageRepositoryName>
  >;
  const digest = `sha256:${'d'.repeat(64)}`;
  const trustedKey = parseTrustedKey(
    trusted.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  );
  const verify = (bundle: Buffer, repository = 'localhost:5000/acme/platform') => {
    const { client } = recordedRegistry(keyedTable(digest, bundle));
    return createAttestationVerifier({
      registry: client,
      policy: { builder: BUILDER, key: trustedKey },
    }).verify(repository, local, digest);
  };

  it('verifies a bundle the trusted key signed', async () => {
    await expect(
      verify(
        signedBundle(trusted.privateKey, statementFor('localhost:5000/acme/platform', digest)),
      ),
    ).resolves.toMatchObject({ digest, commit: 'a'.repeat(40) });
  });

  it('refuses a bundle another key signed', async () => {
    await expect(
      verify(
        signedBundle(stranger.privateKey, statementFor('localhost:5000/acme/platform', digest)),
      ),
    ).rejects.toThrow(AttestationRefusedError);
  });

  it('refuses a signed statement about another digest, another repository or another builder', async () => {
    const otherBuilder = parseTrustedBuilder(
      'acme/fork/.github/workflows/image.yml@refs/heads/main',
    ) as TrustedBuilder;
    for (const statement of [
      statementFor('localhost:5000/acme/platform', `sha256:${'f'.repeat(64)}`),
      statementFor('localhost:5000/acme/platform-egress', digest),
      statementFor('localhost:5000/acme/platform', digest, otherBuilder),
    ]) {
      await expect(verify(signedBundle(trusted.privateKey, statement))).rejects.toThrow(
        AttestationRefusedError,
      );
    }
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
