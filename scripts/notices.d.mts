/**
 * Types for `notices.mjs`, which stays plain JavaScript for the reason every other guard in this
 * directory does: `verify` runs it as `node scripts/notices.mjs --check`, with no TypeScript
 * resolver loaded, and CI's lint job runs that same command on a clean checkout.
 *
 * The shapes are deliberately loose — a lockfile document is whatever the parser read, and `unknown`
 * would make every call site cast. What these declarations are for is the *signatures*
 * `scripts/notices.test.ts` drives, so a rename or an argument change is a compile error rather than
 * a runtime one (the `os-artefacts.d.mts` precedent).
 */

/** One YAML document of a pnpm lockfile, as plain nested objects, strings and string arrays. */
export type LockfileDocument = Record<string, unknown>;

export interface LicenceResolution {
  readonly licence: string;
  readonly note: string | null;
  /** What the package's own manifest declared, when that is not what is published. */
  readonly declaration?: string | null;
}

export interface PinnedArtefact {
  /** The literal pins the build files carry — a version, an image reference, a URL. */
  readonly pins: Set<string>;
  /** The files the pin was read from, repository-relative. */
  readonly files: Set<string>;
}

export interface ProductionClosure {
  /** Package ids (`name@version`) of everything shipped that is not a per-platform build. */
  readonly ids: readonly string[];
  /** Base package id → the per-platform builds it declares. */
  readonly variantOf: Readonly<Record<string, readonly string[]>>;
  /** The lockfile's `packages:` section, keyed by package id. */
  readonly packages: Readonly<Record<string, Record<string, unknown>>>;
}

export declare const parseYamlDocuments: (text: string) => LockfileDocument[];
export declare const parseLockfile: (text: string) => LockfileDocument[];
export declare const packageIdOf: (snapshotId: string) => string;
export declare const splitPackageId: (packageId: string) => { name: string; version: string };
export declare const productionClosure: (documents: LockfileDocument[]) => ProductionClosure;
export declare const readDeclaredLicences: (
  ids: readonly string[],
  modulesRoot: string,
) => Record<string, string | null>;
export declare const resolveLicence: (id: string, declaration: string | null) => LicenceResolution;
export declare const scanPinnedArtefacts: (root: string) => Map<string, PinnedArtefact>;
export declare const assertPinnedArtefactsAgree: (
  pinned: Map<string, PinnedArtefact>,
  declared?: Record<string, unknown>,
) => void;
export declare const renderNotices: (input: {
  readonly ids: readonly string[];
  readonly variantOf: Readonly<Record<string, readonly string[]>>;
  readonly declared: Record<string, string | null>;
  readonly pinned: Map<string, PinnedArtefact>;
}) => string;
