/**
 * The people and projects the two BD-035 e2e files share (S-30.2 acceptance 4, S-30.3 acceptance 4):
 * projects A and B, each with a task and an open question; an administrator (the bootstrap
 * account); `narrowed`, a member whose one worker is scoped to [A]; and `open`, a member with no
 * worker, who has chosen nothing and so sees every project.
 */
import { expect } from 'vitest';
import { createTestClient } from '../../integration/support/postgres.js';
import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, Client, type Instance } from './instance.js';

export interface VisibilityWorld {
  readonly admin: Client;
  readonly narrowed: Client;
  readonly open: Client;
  readonly projectA: string;
  readonly projectB: string;
  readonly taskA: string;
  readonly taskB: string;
  /** The narrowed member's worker, which a test revokes. */
  readonly workerId: string;
}

const signIn = async (baseUrl: string, email: string, password: string): Promise<Client> => {
  const client = new Client(baseUrl);
  const response = await client.post('/api/auth/sign-in/email', { email, password });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return client;
};

const member = async (
  admin: Client,
  baseUrl: string,
  name: string,
): Promise<{ client: Client; userId: string }> => {
  const email = `${name}@example.test`;
  const password = `not-a-real-password-${name}-0000`;
  const created = await admin.post<{ user: { id: string } }>('/api/auth/admin/create-user', {
    email,
    password,
    name,
    role: 'member',
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return { client: await signIn(baseUrl, email, password), userId: created.body.user.id };
};

export const visibilityWorld = async (instance: Instance): Promise<VisibilityWorld> => {
  const admin = await signIn(instance.baseUrl, BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD);
  const narrowed = await member(admin, instance.baseUrl, 'narrowed');
  const open = await member(admin, instance.baseUrl, 'open');
  const client = createTestClient(instance.database.connectionString);
  await client.connect();
  try {
    const org = await client.query<{ id: string }>(
      "insert into organizations (name) values ('visibility') returning id",
    );
    const project = async (key: string): Promise<string> =>
      (
        await client.query<{ id: string }>(
          `insert into projects (org_id, key, name, repo_url)
           values ($1, $2, $2, 'https://git.example.test/acme/' || $2 || '.git') returning id`,
          [org.rows[0]?.id, key],
        )
      ).rows[0]?.id as string;
    const projectA = await project('vis_a');
    const projectB = await project('vis_b');
    const task = async (projectId: string, key: string): Promise<string> => {
      const row = await client.query<{ id: string }>(
        `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, state,
                            current_stage)
         values ($1, 'jira', $2, 'https://jira.example.test/browse/' || $2, 'feature',
                 'waiting_answers', 'refinement')
         returning id`,
        [projectId, key],
      );
      const taskId = row.rows[0]?.id as string;
      await client.query(
        `insert into questions (task_id, stage, text, blocking, status)
         values ($1, 'refinement', $2, true, 'open')`,
        [taskId, `A question about ${key}`],
      );
      return taskId;
    };
    const taskA = await task(projectA, 'VISA-1');
    const taskB = await task(projectB, 'VISB-1');
    const worker = await client.query<{ id: string }>(
      `insert into workers (user_id, name, credential_hash, claim_project_ids)
       values ($1, 'narrowed-laptop', $2, $3::uuid[]) returning id`,
      [narrowed.userId, 'e2e'.padEnd(64, '0').replace(/[^0-9a-f]/g, 'e'), [projectA]],
    );
    return {
      admin,
      narrowed: narrowed.client,
      open: open.client,
      projectA,
      projectB,
      taskA,
      taskB,
      workerId: worker.rows[0]?.id as string,
    };
  } finally {
    await client.end();
  }
};

/** Revokes the narrowed member's worker, as `DELETE /api/workers/:id` stores it. */
export const revokeWorker = async (instance: Instance, workerId: string): Promise<void> => {
  const client = createTestClient(instance.database.connectionString);
  await client.connect();
  try {
    await client.query("update workers set state = 'revoked', revoked_at = now() where id = $1", [
      workerId,
    ]);
  } finally {
    await client.end();
  }
};
