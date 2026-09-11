/**
 * A whole `apps/server` instance, on a real PostgreSQL 18, for the e2e tier (technical/10).
 *
 * The instance is started the way a container starts it — through `loadServerConfig`, from an
 * environment — so the test exercises the same fail-fast configuration path production uses rather
 * than a hand-built config object. It listens on a real socket, because the two things this tier
 * has to prove (a stream that replays after a reconnect, and a shutdown that drains it) are
 * properties of the socket and cannot be shown with `app.inject()`.
 */
import { createServer } from 'node:http';
import type { ServerRuntime, StartRuntimeOptions } from '@platform/server';
import { startRuntime } from '@platform/server';
import pg from 'pg';
import {
  createMigratedDatabase,
  type MigratedDatabase,
} from '../../integration/support/migrated.js';

/** A password that is obviously fake and long enough for the bootstrap check. */
export const BOOTSTRAP_EMAIL = 'operator@example.test';
export const BOOTSTRAP_PASSWORD = 'not-a-real-password-0000';

export interface Instance {
  readonly runtime: ServerRuntime;
  readonly baseUrl: string;
  readonly database: MigratedDatabase;
  stop(): Promise<void>;
}

/**
 * Reserves a free TCP port and gives it up again.
 *
 * `listen({ port: 0 })` would be race-free, but the instance's `APP_BASE_URL` has to be the origin
 * it actually serves on — Better Auth derives the cookie and the trusted origin from it — and that
 * has to be known before the process starts. The window between closing this socket and the
 * server binding is microseconds on a loopback interface in a test.
 */
const reservePort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('could not reserve a port'));
        return;
      }
      const { port } = address;
      probe.close(() => {
        resolve(port);
      });
    });
  });

export interface StartInstanceOptions {
  readonly role?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Skip creating the bootstrap administrator (for the "nobody can sign in" case). */
  readonly withoutBootstrapAdmin?: boolean;
  /** Name of the database to create; lets one file start two instances it can tell apart. */
  readonly label?: string;
  /**
   * Start against a database that already exists instead of creating one.
   *
   * The instance does **not** drop it on `stop()`: whoever created it owns its lifetime. This is
   * what lets one test hand a database from one instance to the next and ask what survived the
   * handover — which is the only time-free way to show that an event was queued rather than eaten.
   */
  readonly database?: MigratedDatabase;
  /**
   * Overrides for the pipeline composition, or `null` to start no pipeline at all.
   *
   * **Absent composes the pipeline** (WP-15b) — for the auth and SSE e2e files too, which is the
   * point: what `startRuntime()` does with no argument is what `main.ts` does, and an instance the
   * harness had to configure would not be evidence about production. What a caller may still
   * replace is the agent runner (Q52) and the provider registry; `null` is the labelled seam that
   * starts an incomplete consumer, and `composition.e2e.test.ts` is its only user.
   */
  readonly pipeline?: StartRuntimeOptions['pipeline'];
  /** Where pino writes; a test that asserts on a start-up decision reads it here. */
  readonly logDestination?: StartRuntimeOptions['logDestination'];
  /** Overrides `LOG_LEVEL`, which defaults to `silent` so a passing run prints nothing. */
  readonly logLevel?: string;
}

export const startInstance = async (options: StartInstanceOptions = {}): Promise<Instance> => {
  const ownsDatabase = options.database === undefined;
  const database = options.database ?? (await createMigratedDatabase(options.label ?? 'e2e'));
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const env: Record<string, string | undefined> = {
    ROLE: options.role ?? 'all',
    PORT: String(port),
    HOST: '127.0.0.1',
    APP_BASE_URL: baseUrl,
    DATABASE_URL: database.connectionString,
    // Obviously fake, and long enough for the 32-character floor.
    APP_SECRET_KEY: 'e2e-test-secret-key-not-a-real-secret-0000',
    LOG_LEVEL: options.logLevel ?? 'silent',
    TZ: 'UTC',
    APP_DB_POOL_MAX: '12',
    APP_SSE_PING_INTERVAL_MS: '1000',
    ...(options.withoutBootstrapAdmin === true
      ? {}
      : {
          APP_BOOTSTRAP_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
          APP_BOOTSTRAP_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
        }),
    ...options.env,
  };

  let runtime: ServerRuntime;
  try {
    runtime = await startRuntime({
      env,
      ...(options.pipeline === undefined ? {} : { pipeline: options.pipeline }),
      ...(options.logDestination === undefined ? {} : { logDestination: options.logDestination }),
    });
  } catch (error) {
    if (ownsDatabase) {
      await database.drop();
    }
    throw error;
  }

  try {
    await runtime.listen();
  } catch (error) {
    await runtime.stop();
    if (ownsDatabase) {
      await database.drop();
    }
    throw error;
  }

  return {
    runtime,
    baseUrl,
    database,
    stop: async () => {
      await runtime.stop();
      if (ownsDatabase) {
        await database.drop();
      }
    },
  };
};

export interface SeededProject {
  readonly organisationId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly runId: string;
}

/**
 * The minimum row graph an SSE topic can be authorised against.
 *
 * `/events` resolves `project:`/`task:`/`run:` to the project they belong to before asking `can()`,
 * so a topic naming nothing is a 404. That is the behaviour under test, which means the e2e tier
 * needs real rows rather than invented uuids.
 */
export const seedProject = async (instance: Instance): Promise<SeededProject> => {
  const client = new pg.Client({ connectionString: instance.database.connectionString });
  await client.connect();
  try {
    const org = await client.query<{ id: string }>(
      "insert into organizations (name) values ('e2e') returning id",
    );
    const organisationId = org.rows[0]?.id as string;
    const project = await client.query<{ id: string }>(
      `insert into projects (org_id, key, name, repo_url)
       values ($1, 'e2e', 'E2E project', 'https://git.example.test/e2e.git')
       returning id`,
      [organisationId],
    );
    const projectId = project.rows[0]?.id as string;
    const task = await client.query<{ id: string }>(
      `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template)
       values ($1, 'jira', 'E2E-1', 'https://jira.example.test/browse/E2E-1', 'feature')
       returning id`,
      [projectId],
    );
    const taskId = task.rows[0]?.id as string;
    const run = await client.query<{ id: string }>(
      `insert into runs (task_id, project_id, role, model, prompt_version)
       values ($1, $2, 'developer', 'claude-opus-5', 'developer@1')
       returning id`,
      [taskId, projectId],
    );
    return { organisationId, projectId, taskId, runId: run.rows[0]?.id as string };
  } finally {
    await client.end();
  }
};

/** A `fetch` bound to the instance, carrying the cookie jar and the headers the CSRF rule wants. */
export class Client {
  readonly #baseUrl: string;
  readonly #cookies = new Map<string, string>();

  constructor(baseUrl: string) {
    this.#baseUrl = baseUrl;
  }

  get cookieHeader(): string {
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  hasCookie(name: string): boolean {
    return this.#cookies.has(name);
  }

  headers(extra: Record<string, string> = {}): Record<string, string> {
    const cookie = this.cookieHeader;
    return {
      origin: this.#baseUrl,
      'x-requested-with': 'XMLHttpRequest',
      ...(cookie === '' ? {} : { cookie }),
      ...extra,
    };
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers: { ...this.headers(), ...(init.headers as Record<string, string> | undefined) },
      redirect: 'manual',
    });
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const separator = pair?.indexOf('=') ?? -1;
      if (pair !== undefined && separator > 0) {
        this.#cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
      }
    }
    return response;
  }

  async json<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
    const response = await this.request(path, init);
    const text = await response.text();
    return {
      status: response.status,
      body: (text === '' ? null : JSON.parse(text)) as T,
    };
  }

  async post<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
    return this.json<T>(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
}
