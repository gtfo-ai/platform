/**
 * **The updater's Docker calls** — WP-287 (3), TD-032 decision 4.
 *
 * Every call is the `docker` CLI (and its Compose plugin, both pinned by checksum in
 * `docker/app.Dockerfile`) against `DOCKER_HOST` — the updater's **own** socket proxy on an
 * `internal: true` network only it and the apply container join. The proxy filters by API path, not
 * by label or project (research/17 § 4), so **scoping to the worker's compose project is this
 * module's property**: every Compose call passes `--project-name` (and `--project-directory`)
 * explicitly ({@link composeArgs}, held by `update-apply.test.ts`), and every plain container call names a
 * container this project labelled or the apply container this updater created.
 *
 * Secrets: the CLI never receives one on its command line. The values the apply carries over from the
 * running containers (the Claude token among them) reach `docker compose` through its **process
 * environment** only — never an argument (`ps` shows arguments), never a file (`apply.ts`).
 */
import { execFile } from 'node:child_process';

export interface DockerResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type DockerRun = (
  args: readonly string[],
  options?: { readonly env?: Readonly<Record<string, string>>; readonly timeoutMs?: number },
) => Promise<DockerResult>;

export class DockerCallError extends Error {
  override readonly name = 'DockerCallError';
  readonly stderr: string;
  constructor(message: string, stderr: string) {
    super(message);
    this.stderr = stderr;
  }
}

/** One Docker call's default bound; `up --wait` and `pull` pass their own. */
export const DOCKER_CALL_TIMEOUT_MS = 120_000;

/** The `docker` CLI over `DOCKER_HOST`, with the process environment plus `options.env`. */
export const createDockerCli =
  (base: { readonly env?: Readonly<Record<string, string | undefined>> } = {}): DockerRun =>
  (args, options = {}) =>
    new Promise((resolve, reject) => {
      execFile(
        'docker',
        [...args],
        {
          env: { ...process.env, ...base.env, ...options.env },
          timeout: options.timeoutMs ?? DOCKER_CALL_TIMEOUT_MS,
          maxBuffer: 32 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error !== null) {
            reject(
              new DockerCallError(
                `docker ${args.slice(0, 3).join(' ')} failed: ${(stderr || error.message).trim().slice(0, 2_000)}`,
                stderr,
              ),
            );
            return;
          }
          resolve({ stdout, stderr });
        },
      );
    });

/** Where the worker's compose project lives, as its own containers' labels say. */
export interface ComposeProject {
  readonly name: string;
  /**
   * Every Compose call's `--project-directory`: the install folder as the updater's containers see
   * it (`HOST_BUNDLE_MOUNT`, S-22.21) — never a host path, which may be a Windows one.
   */
  readonly workingDir: string;
  /** The managed env file: `<workingDir>/.env`. */
  readonly envFile: string;
}

/** `docker compose --project-name … --project-directory … [--env-file …] -f <file> <args>`. */
export const composeArgs = (
  project: ComposeProject,
  file: string,
  args: readonly string[],
  options: { readonly envFile?: boolean } = {},
): string[] => [
  'compose',
  '--project-name',
  project.name,
  '--project-directory',
  project.workingDir,
  ...(options.envFile === false ? [] : ['--env-file', project.envFile]),
  '-f',
  file,
  ...args,
];

export interface InspectedContainer {
  readonly Id: string;
  readonly Name?: string;
  readonly Image?: string;
  readonly Config?: {
    readonly Image?: string;
    readonly Env?: readonly string[];
    readonly Labels?: Readonly<Record<string, string>>;
  };
  readonly State?: { readonly Running?: boolean; readonly Status?: string };
  readonly Mounts?: readonly {
    readonly Type?: string;
    readonly Name?: string;
    readonly Source?: string;
    readonly Destination?: string;
  }[];
  readonly NetworkSettings?: { readonly Networks?: Readonly<Record<string, unknown>> };
}

export const inspectContainers = async (
  docker: DockerRun,
  ids: readonly string[],
): Promise<InspectedContainer[]> => {
  if (ids.length === 0) return [];
  const { stdout } = await docker(['container', 'inspect', ...ids]);
  return JSON.parse(stdout) as InspectedContainer[];
};

/** The containers of a compose project (any state), by service. */
export const projectContainers = async (
  docker: DockerRun,
  project: string,
): Promise<InspectedContainer[]> => {
  const { stdout } = await docker([
    'container',
    'ls',
    '--all',
    '--quiet',
    '--filter',
    `label=com.docker.compose.project=${project}`,
  ]);
  return inspectContainers(
    docker,
    stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  );
};

export const serviceOf = (container: InspectedContainer): string | null =>
  container.Config?.Labels?.['com.docker.compose.service'] ?? null;

/** A container's environment as a map (the last of a repeated name wins, as Docker's does). */
export const environmentOf = (container: InspectedContainer): Map<string, string> => {
  const env = new Map<string, string>();
  for (const entry of container.Config?.Env ?? []) {
    const separator = entry.indexOf('=');
    if (separator > 0) env.set(entry.slice(0, separator), entry.slice(separator + 1));
  }
  return env;
};
