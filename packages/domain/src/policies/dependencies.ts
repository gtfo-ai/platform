/**
 * The dependency policy — product/04:58, product/18:43, BD-030 (WP-38).
 *
 * > *"Adding a third-party dependency follows the project policy (`ask` by default → a question
 * > with license and maintenance status; `allow` for allow-listed packages; `block`)."*
 *
 * Two pure things live here and nothing else: **what a diff added**, and **what the project's
 * policy says about it**. The provider read, the metadata lookup and the three endings are
 * `packages/application/src/pipeline/dependency-gate.ts`; this module has no I/O and no clock.
 *
 * ## What "detected" means, exactly
 *
 * A dependency is detected from the **added lines of a patch**, per file, by a parser that knows
 * that file's format. There is no repository checkout and no package manager: the platform is
 * reading somebody else's diff, so every parser here is a reader of *added text* and is written to
 * under-report rather than to guess. The ecosystems are {@link DEPENDENCY_ECOSYSTEM_FILES} and they
 * are the enumeration `dependencyEcosystemSchema` publishes; a manifest belonging to an ecosystem
 * this build cannot read is reported by name instead ({@link UNREAD_MANIFEST_FILES}, standing rule
 * 18 — the absent case must not be the quiet one).
 *
 * ## Three deliberate limits, stated rather than discovered
 *
 *  1. **A manifest hunk that does not carry its section header under-reports.** `package.json`,
 *     `pyproject.toml` and `Cargo.toml` all express *"this is a dependency"* as a section the line
 *     sits in, and a patch is hunks rather than a document: when the header is not in the hunk, the
 *     parser does not know whether `"version": "1.2.3"` is a package or the file's own version, and
 *     it says nothing rather than inventing a package called `version`. The lockfile is what
 *     catches that case in practice, which is why lockfiles are read too.
 *  2. **A lockfile addition is reported as one**, `from: 'lockfile'`, because most of them are the
 *     transitive consequence of a manifest line rather than anybody's decision. They are still
 *     *gated* — product/04:58 gates adding a dependency and a lockfile is where one lands, and a
 *     lockfile-only change is exactly how an undeclared package enters a repository — and the
 *     distinction is on the record so the question and the panel can say which kind each is.
 *  3. **A version bump is not an addition, and the patch is what says so.** A bump rewrites the
 *     line, so `lodash@4.17.20` → `lodash@4.17.21` is a removed line and an added one with the same
 *     name. {@link detectDependencyChanges} reads *both* sides of the patch and drops a name that
 *     appears on both — which is why the removed lines are parsed at all. The residual is the
 *     opposite case and it is the safe one: a package genuinely removed in one file and added in
 *     another (a move between workspaces) is reported as neither.
 */
import type {
  DependencyEcosystem,
  DependencyPolicyValue,
  UnreadEcosystem,
} from '@platform/contracts';
import { DEPENDENCY_ECOSYSTEMS } from '@platform/contracts';

/** product/18:43's *"ask"* default: a dependency addition raises a question unless told otherwise. */
export const DEFAULT_DEPENDENCY_POLICY: DependencyPolicyValue = 'ask';

/**
 * How many packages one decision may carry.
 *
 * A lockfile refresh can add hundreds of transitive entries and all of them would otherwise reach a
 * `jsonb` column, a question's text and a screen. The cut is announced (`truncated`) rather than
 * silent, and it is applied *after* the policy is resolved for every package, so a `block` further
 * down the list still blocks — the bound is on what is **reported**, never on what is **decided**.
 *
 * That sentence was **false until review round 2**: {@link detectDependencyChanges} sliced its own
 * answer and the gate resolved policies over the slice, so the twenty-sixth package was neither
 * blocked nor asked about. The cut now lives in {@link boundReportedDependencies}, which takes
 * packages that already carry their policy — the type is what makes the order of the two steps
 * hard to get wrong again (standing rule 44).
 */
export const MAX_DETECTED_DEPENDENCIES = 25;

/** Where a package was seen. */
export type DependencySource = 'manifest' | 'lockfile';

export interface DetectedDependency {
  readonly ecosystem: DependencyEcosystem;
  readonly name: string;
  readonly from: DependencySource;
  /** The file it was read out of, as the provider spelled it. */
  readonly path: string;
}

export interface UnreadManifest {
  readonly ecosystem: UnreadEcosystem;
  readonly path: string;
}

export interface DependencyScan {
  /**
   * **Every** package an added line named, de-duplicated by `(ecosystem, name)`, manifest first —
   * uncut, because this is the list the policy is resolved over (see
   * {@link MAX_DETECTED_DEPENDENCIES}). {@link boundReportedDependencies} is what cuts the list
   * that gets stored and shown, after every package has a policy.
   */
  readonly added: readonly DetectedDependency[];
  /** Manifests of ecosystems this build recognises and cannot read. */
  readonly unread: readonly UnreadManifest[];
  /** The **caller** said the diff was cut — a provider file limit, never this module's bound. */
  readonly truncated: boolean;
}

/** One file of a merge request's diff, as much of it as this module needs. */
export interface ChangedFileDiff {
  readonly path: string;
  /** The provider's patch text, or `null` when it sent none. */
  readonly patch: string | null;
}

// ── the file table ───────────────────────────────────────────────────────────

interface EcosystemFiles {
  /** Files whose added lines are somebody's *declaration* of a dependency. */
  readonly manifests: readonly RegExp[];
  /** Files whose added lines are the resolved closure of one. */
  readonly lockfiles: readonly RegExp[];
  /** What a package of this ecosystem may be called — applied to every name before it is kept. */
  readonly name: RegExp;
  /** Names are compared for the allow-list after this (PyPI normalises, npm does not). */
  readonly normalise: (name: string) => string;
}

const identity = (name: string): string => name;

/**
 * PEP 503's normalisation: *"the name should be lowercased with all runs of the characters `.`,
 * `-`, or `_` replaced with a single `-`"* — so `Flask_SQLAlchemy` and `flask-sqlalchemy` are one
 * project, and an allow-list entry for either covers both.
 * <https://packaging.python.org/en/latest/specifications/name-normalization/> (retrieved 2026-09-14)
 */
const normalisePypi = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, '-');

/**
 * The ecosystems this build reads, their files and their name rules.
 *
 * `satisfies Record<DependencyEcosystem, …>` is the enforcement `dependencyEcosystemSchema`'s
 * docblock promises: a value added to that enum without an entry here does not compile, so the
 * configuration can never name an ecosystem nothing detects.
 */
export const DEPENDENCY_ECOSYSTEM_FILES = {
  npm: {
    manifests: [/(^|\/)package\.json$/],
    lockfiles: [/(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/],
    // npm allows an optional scope, and historic packages carry capitals.
    name: /^(@[A-Za-z0-9][\w.-]*\/)?[A-Za-z0-9][\w.-]*$/,
    normalise: identity,
  },
  pypi: {
    manifests: [/(^|\/)(requirements[\w.-]*\.txt|pyproject\.toml|Pipfile)$/],
    lockfiles: [/(^|\/)(poetry\.lock|uv\.lock)$/],
    name: /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/,
    normalise: normalisePypi,
  },
  go: {
    manifests: [/(^|\/)go\.mod$/],
    lockfiles: [/(^|\/)go\.sum$/],
    // A module path: a domain, then path segments. The dot is what keeps `require` and `(` out.
    name: /^[A-Za-z0-9][A-Za-z0-9.~-]*\.[A-Za-z0-9][A-Za-z0-9._~/-]*$/,
    normalise: identity,
  },
  cargo: {
    manifests: [/(^|\/)Cargo\.toml$/],
    lockfiles: [/(^|\/)Cargo\.lock$/],
    name: /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
    normalise: identity,
  },
} as const satisfies Record<DependencyEcosystem, EcosystemFiles>;

/**
 * Manifests this build **recognises and cannot read** — the five ecosystems of
 * `unreadEcosystemSchema`.
 *
 * They are here so that a `pom.xml` in a diff is a named gap on the Checks panel rather than a
 * silent *"no dependencies added"*: a gate that reports a fact it did not establish is worse than
 * one that says what it could not look at (standing rule 18).
 */
export const UNREAD_MANIFEST_FILES = {
  maven: [/(^|\/)pom\.xml$/],
  gradle: [/(^|\/)build\.gradle(\.kts)?$/, /(^|\/)gradle\/libs\.versions\.toml$/],
  composer: [/(^|\/)composer\.(json|lock)$/],
  rubygems: [/(^|\/)Gemfile(\.lock)?$/, /(^|\/)[\w.-]+\.gemspec$/],
  nuget: [/(^|\/)([\w.-]+\.csproj|packages\.lock\.json|Directory\.Packages\.props)$/],
} as const satisfies Record<UnreadEcosystem, readonly RegExp[]>;

const UNREAD_ECOSYSTEMS = Object.keys(UNREAD_MANIFEST_FILES) as readonly UnreadEcosystem[];

const matches = (patterns: readonly RegExp[], path: string): boolean =>
  patterns.some((pattern) => pattern.test(path));

/** Which ecosystem and which kind of file this path is, or `null` when it is neither. */
export const classifyDependencyFile = (
  path: string,
): { readonly ecosystem: DependencyEcosystem; readonly from: DependencySource } | null => {
  for (const ecosystem of DEPENDENCY_ECOSYSTEMS) {
    const files = DEPENDENCY_ECOSYSTEM_FILES[ecosystem];
    if (matches(files.manifests, path)) {
      return { ecosystem, from: 'manifest' };
    }
    if (matches(files.lockfiles, path)) {
      return { ecosystem, from: 'lockfile' };
    }
  }
  return null;
};

/** The ecosystem whose manifest this is, among the ones this build cannot read. */
export const classifyUnreadManifest = (path: string): UnreadEcosystem | null =>
  UNREAD_ECOSYSTEMS.find((ecosystem) => matches(UNREAD_MANIFEST_FILES[ecosystem], path)) ?? null;

// ── patch reading ────────────────────────────────────────────────────────────

/** How much of one file's patch is read. A diff is untrusted text of unbounded size (BD-022). */
export const MAX_PATCH_BYTES = 256 * 1024;

interface PatchLine {
  readonly text: string;
  readonly added: boolean;
}

/**
 * The lines of a unified diff, with the file headers dropped.
 *
 * Context and **removed** lines are kept (marked `added: false`) because the parsers need them for
 * two things: the section a line sits in, and the "was it already there" comparison the caller
 * makes between the added and the removed names. `+++`/`---` are dropped before anything else,
 * since `+++ b/package.json` starts with a `+`.
 */
const patchLines = (patch: string): readonly PatchLine[] => {
  const lines: PatchLine[] = [];
  for (const raw of patch.slice(0, MAX_PATCH_BYTES).split('\n')) {
    if (
      raw.startsWith('+++') ||
      raw.startsWith('---') ||
      raw.startsWith('@@') ||
      raw.startsWith('diff --git') ||
      raw.startsWith('index ')
    ) {
      continue;
    }
    if (raw.startsWith('+')) {
      lines.push({ text: raw.slice(1), added: true });
      continue;
    }
    lines.push({
      text: raw.startsWith('-') || raw.startsWith(' ') ? raw.slice(1) : raw,
      added: false,
    });
  }
  return lines;
};

/** A name the ecosystem's own pattern accepts, or `null`. */
const validName = (ecosystem: DependencyEcosystem, name: string): string | null => {
  const trimmed = name.trim();
  return trimmed.length > 0 &&
    trimmed.length <= 200 &&
    DEPENDENCY_ECOSYSTEM_FILES[ecosystem].name.test(trimmed)
    ? trimmed
    : null;
};

type LineParser = (line: string, section: string | null) => string | null;

/** The JSON/TOML section a line opens, for the parsers that need one. */
type SectionReader = (line: string, section: string | null) => string | null;

const jsonSection: SectionReader = (line, section) => {
  const opened = /^\s*"([\w.-]+)"\s*:\s*\{/.exec(line);
  if (opened?.[1] !== undefined) {
    return opened[1];
  }
  return /^\s{0,2}\}/.test(line) ? null : section;
};

const tomlSection: SectionReader = (line, section) => {
  const header = /^\s*\[\[?([^\]]+)\]\]?\s*$/.exec(line);
  return header?.[1] === undefined ? section : header[1].trim();
};

const NPM_DEPENDENCY_SECTIONS = new Set([
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
]);

/** `"lodash": "^4.17.21"` inside a dependency section of `package.json`. */
const npmManifestLine: LineParser = (line, section) => {
  if (section === null || !NPM_DEPENDENCY_SECTIONS.has(section)) {
    return null;
  }
  const pair = /^\s*"(@?[\w./-]+)"\s*:\s*"([^"]*)"/.exec(line);
  return pair?.[1] ?? null;
};

/**
 * A package entry in one of the four lockfiles npm-family tools write.
 *
 * `package-lock.json` keys by path (`"node_modules/@scope/pkg"`), pnpm and yarn by
 * `name@version` — so the split is on the **last** `@` that is not the scope's.
 */
const npmLockLine: LineParser = (line) => {
  const nodeModules = /^\s*"(?:.*\/)?node_modules\/(@[\w.-]+\/[\w.-]+|[\w.-]+)"\s*:/.exec(line);
  if (nodeModules?.[1] !== undefined) {
    return nodeModules[1];
  }
  const entry = /^\s*'?"?\/?((?:@[\w.-]+\/)?[\w.-]+)@[^'":]*'?"?\s*:/.exec(line);
  return entry?.[1] ?? null;
};

/** `requests>=2`, `flask[async]==3.0`, or a bare `httpx` in a requirements file. */
const pypiRequirementLine: LineParser = (line) => {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('-')) {
    return null;
  }
  const name = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*([<>=!~;].*)?$/.exec(trimmed);
  return name?.[1] ?? null;
};

const PYPI_TOML_SECTIONS = /(^|\.)dependencies$|^packages$|^dev-packages$/;

/** Both TOML spellings: a `dependencies = ["httpx>=0.27"]` array, and a `[…dependencies]` table. */
const pypiTomlLine: LineParser = (line, section) => {
  const quoted = /"([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*[<>=!~;][^"]*"/.exec(line);
  if (quoted?.[1] !== undefined && /^\s*("|dependencies\s*=)/.test(line)) {
    return quoted[1];
  }
  if (section === null || !PYPI_TOML_SECTIONS.test(section)) {
    return null;
  }
  const assigned = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/.exec(line);
  return assigned?.[1] ?? null;
};

/** `name = "httpx"` under a `[[package]]` table of `poetry.lock` or `uv.lock`. */
const lockPackageNameLine: LineParser = (line, section) => {
  if (section !== 'package') {
    return null;
  }
  const assigned = /^\s*name\s*=\s*"([^"]+)"/.exec(line);
  return assigned?.[1] ?? null;
};

const GO_REQUIRE_SECTION = 'require';

/** `golang.org/x/text v0.14.0` — inside a `require (` block or on a `require` line. */
const goModLine: LineParser = (line, section) => {
  const single = /^\s*require\s+([^\s]+)\s+v[\w.+-]+/.exec(line);
  if (single?.[1] !== undefined) {
    return single[1];
  }
  if (section !== GO_REQUIRE_SECTION) {
    return null;
  }
  const inBlock = /^\s*([^\s/][^\s]*)\s+v[\w.+-]+/.exec(line);
  return inBlock?.[1] ?? null;
};

/** `golang.org/x/text v0.14.0 h1:…` — `go.sum` has two lines per module and one name. */
const goSumLine: LineParser = (line) => {
  const entry = /^\s*([^\s]+)\s+v[\w.+/-]+\s+h1:/.exec(line);
  return entry?.[1] ?? null;
};

const CARGO_TOML_SECTIONS = /(^|\.)(dependencies|dev-dependencies|build-dependencies)$/;

/** `serde = "1.0"` or `serde = { version = "1" }` under a Cargo dependency table. */
const cargoTomlLine: LineParser = (line, section) => {
  if (section === null || !CARGO_TOML_SECTIONS.test(section)) {
    return null;
  }
  const assigned = /^\s*([A-Za-z0-9][A-Za-z0-9_-]*)\s*=/.exec(line);
  return assigned?.[1] ?? null;
};

interface FileReader {
  readonly section: SectionReader;
  readonly line: LineParser;
}

/** `go.mod`'s `require ( … )` is a block rather than a header, so it gets its own reader. */
const goModSection: SectionReader = (line, section) => {
  if (/^\s*require\s*\($/.test(line)) {
    return GO_REQUIRE_SECTION;
  }
  return /^\s*\)/.test(line) ? null : section;
};

const noSection: SectionReader = () => null;

/** Which reader a path gets. One entry per file pattern in the table above. */
const readerFor = (path: string, ecosystem: DependencyEcosystem): FileReader => {
  if (ecosystem === 'npm') {
    return /package\.json$/.test(path)
      ? { section: jsonSection, line: npmManifestLine }
      : { section: noSection, line: npmLockLine };
  }
  if (ecosystem === 'pypi') {
    if (/\.txt$/.test(path)) {
      return { section: noSection, line: pypiRequirementLine };
    }
    return /\.lock$/.test(path)
      ? { section: tomlSection, line: lockPackageNameLine }
      : { section: tomlSection, line: pypiTomlLine };
  }
  if (ecosystem === 'go') {
    return /go\.mod$/.test(path)
      ? { section: goModSection, line: goModLine }
      : { section: noSection, line: goSumLine };
  }
  return /Cargo\.toml$/.test(path)
    ? { section: tomlSection, line: cargoTomlLine }
    : { section: tomlSection, line: lockPackageNameLine };
};

/** Every package name this patch names, split by whether the line was added or removed. */
const namesInPatch = (
  path: string,
  ecosystem: DependencyEcosystem,
  patch: string,
): { readonly added: readonly string[]; readonly removed: readonly string[] } => {
  const reader = readerFor(path, ecosystem);
  const added: string[] = [];
  const removed: string[] = [];
  let section: string | null = null;
  for (const line of patchLines(patch)) {
    section = reader.section(line.text, section);
    const raw = reader.line(line.text, section);
    if (raw === null) {
      continue;
    }
    const name = validName(ecosystem, raw);
    if (name === null) {
      continue;
    }
    (line.added ? added : removed).push(name);
  }
  return { added, removed };
};

/**
 * What this diff added, and which manifests it could not read.
 *
 * `truncated` here is the **caller's** alone: a provider that cut the file list says so by
 * answering with exactly the limit (`getMergeRequestDiff`), and the record then says the report is
 * partial rather than implying it is complete. This function's own answer is **not** cut — the
 * policy has to be resolved over every package before any of them is dropped, which is
 * {@link boundReportedDependencies}' job and the reason {@link MAX_DETECTED_DEPENDENCIES} is not
 * mentioned below.
 */
export const detectDependencyChanges = (
  files: readonly ChangedFileDiff[],
  options: { readonly diffTruncated?: boolean } = {},
): DependencyScan => {
  const byKey = new Map<string, DetectedDependency>();
  const removed = new Set<string>();
  const unread: UnreadManifest[] = [];
  for (const file of files) {
    const unreadable = classifyUnreadManifest(file.path);
    if (unreadable !== null) {
      unread.push({ ecosystem: unreadable, path: file.path });
      continue;
    }
    const classified = classifyDependencyFile(file.path);
    if (classified === null || file.patch === null || file.patch === '') {
      continue;
    }
    const names = namesInPatch(file.path, classified.ecosystem, file.patch);
    const { normalise } = DEPENDENCY_ECOSYSTEM_FILES[classified.ecosystem];
    for (const name of names.removed) {
      removed.add(`${classified.ecosystem}:${normalise(name)}`);
    }
    for (const name of names.added) {
      const key = `${classified.ecosystem}:${normalise(name)}`;
      const existing = byKey.get(key);
      // A manifest declaration outranks the lockfile echo of the same package: it is the line
      // somebody wrote, and it is what the question should quote.
      if (
        existing === undefined ||
        (existing.from === 'lockfile' && classified.from === 'manifest')
      ) {
        byKey.set(key, {
          ecosystem: classified.ecosystem,
          name,
          from: classified.from,
          path: file.path,
        });
      }
    }
  }
  // A name on both sides of the patch is a **version bump**, not an addition (limit 3 above).
  const additions = [...byKey.entries()]
    .filter(([key]) => !removed.has(key))
    .map(([, value]) => value);
  const manifestFirst = [
    ...additions.filter((entry) => entry.from === 'manifest'),
    ...additions.filter((entry) => entry.from === 'lockfile'),
  ];
  return { added: manifestFirst, unread, truncated: options.diffTruncated ?? false };
};

/** A package the policy has already been resolved for — what {@link boundReportedDependencies} cuts. */
export interface PolicyResolvedDependency {
  readonly policy: DependencyPolicyValue;
}

export interface BoundedDependencyReport<T> {
  /** At most {@link MAX_DETECTED_DEPENDENCIES}, in the order they were detected. */
  readonly reported: readonly T[];
  /** The cut dropped a package, so *"nothing else"* is never read as *"nothing more"*. */
  readonly truncated: boolean;
}

/**
 * The cut, applied **after** every package has a policy — the order {@link MAX_DETECTED_DEPENDENCIES}
 * promises and the gate did not keep until review round 2.
 *
 * Which packages survive is decided by **what they decided**: every `block` first, then every
 * `ask`, then the rest, up to the bound. That is not decoration — `record.added` is what the return
 * reason and the question text quote, so a cut that dropped the twenty-sixth package *because* it
 * was last would block a task with a reason naming nobody. The output is then put back into
 * detection order (manifest first), because the panel's list is a description of the diff rather
 * than of this function.
 *
 * A consequence, stated so nobody has to re-derive it: since every `block` and then every `ask`
 * survives, `gateDecisionFor` over the *report* would today give the same answer as over the whole
 * list. The gate still decides over the whole list, because relying on that would make this
 * function's ordering rule load-bearing for the decision as well as for the wording.
 */
export const boundReportedDependencies = <T extends PolicyResolvedDependency>(
  resolved: readonly T[],
): BoundedDependencyReport<T> => {
  if (resolved.length <= MAX_DETECTED_DEPENDENCIES) {
    return { reported: resolved, truncated: false };
  }
  const rank: Readonly<Record<DependencyPolicyValue, number>> = { block: 0, ask: 1, allow: 2 };
  const kept = new Set(
    [...resolved.keys()]
      .sort((left, right) => {
        const byPolicy =
          (rank[resolved[left]?.policy ?? 'allow'] ?? 2) -
          (rank[resolved[right]?.policy ?? 'allow'] ?? 2);
        return byPolicy === 0 ? left - right : byPolicy;
      })
      .slice(0, MAX_DETECTED_DEPENDENCIES),
  );
  return {
    reported: resolved.filter((_, index) => kept.has(index)),
    truncated: true,
  };
};

// ── the policy ───────────────────────────────────────────────────────────────

/** The two shapes `policies.dependency_policy` accepts (`dependencyPolicyConfigSchema`). */
export type DependencyPolicyConfig =
  | DependencyPolicyValue
  | {
      readonly default?: DependencyPolicyValue;
      readonly ecosystems?: Partial<Record<DependencyEcosystem, DependencyPolicyValue>>;
      readonly allowlist?: readonly string[];
    };

export interface ResolvedDependencyPolicy {
  readonly policy: DependencyPolicyValue;
  /** The allow-list named this package, which is *why* it says `allow` (product/04:58). */
  readonly allowlisted: boolean;
}

const allowlistHit = (
  config: DependencyPolicyConfig | undefined,
  ecosystem: DependencyEcosystem,
  name: string,
): boolean => {
  if (config === undefined || typeof config === 'string') {
    return false;
  }
  const { normalise } = DEPENDENCY_ECOSYSTEM_FILES[ecosystem];
  const wanted = `${ecosystem}:${normalise(name)}`;
  return (config.allowlist ?? []).some((entry) => {
    const colon = entry.indexOf(':');
    if (colon === -1) {
      return false;
    }
    const listed = entry.slice(0, colon);
    return (
      listed === ecosystem && normalise(entry.slice(colon + 1).trim()) === wanted.slice(colon + 1)
    );
  });
};

/**
 * What this project does about this package — the whole of product/18:43's configuration column.
 *
 * The allow-list wins over everything, including `block`: product/04:58 reads *"`allow` for
 * allow-listed packages"* as the exception to the policy rather than as a third policy, and a
 * project that both blocks an ecosystem and names a package in it has said what it means.
 *
 * A project that configures nothing gets {@link DEFAULT_DEPENDENCY_POLICY}, which is the *"ask"*
 * product/18:43 ships — defaulted here as well as in `PLATFORM_DEFAULT_CONFIG`, because a settings
 * port built from `{}` never sees the platform layer (the reason `coverageSourceOf` states).
 */
export const dependencyPolicyFor = (
  config: DependencyPolicyConfig | undefined,
  ecosystem: DependencyEcosystem,
  name: string,
): ResolvedDependencyPolicy => {
  if (allowlistHit(config, ecosystem, name)) {
    return { policy: 'allow', allowlisted: true };
  }
  if (config === undefined) {
    return { policy: DEFAULT_DEPENDENCY_POLICY, allowlisted: false };
  }
  if (typeof config === 'string') {
    return { policy: config, allowlisted: false };
  }
  return {
    policy: config.ecosystems?.[ecosystem] ?? config.default ?? DEFAULT_DEPENDENCY_POLICY,
    allowlisted: false,
  };
};

/** What the gate does about a whole scan: the strictest policy any added package resolved to. */
export type DependencyGateDecision = 'none' | 'allow' | 'ask' | 'block';

export const gateDecisionFor = (
  policies: readonly DependencyPolicyValue[],
): DependencyGateDecision => {
  if (policies.length === 0) {
    return 'none';
  }
  if (policies.includes('block')) {
    return 'block';
  }
  return policies.includes('ask') ? 'ask' : 'allow';
};
