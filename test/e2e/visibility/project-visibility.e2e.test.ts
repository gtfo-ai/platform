/**
 * **A person sees only the projects they work in** — BD-035 on a real `apps/server` instance
 * (S-30.2 acceptance 4).
 *
 * Projects A and B, each with a task and an open question. `narrowed` is a member whose one worker
 * takes [A]; `open` is a member with no worker, who has chosen nothing; the administrator is the
 * bootstrap account. The narrowed member gets 404 for B's board and B's task — the bodies a missing
 * id gets — and their inbox lacks B's question, while the other member and the administrator see
 * both. Once the worker is revoked, nothing narrows them and they see both again.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Instance, startInstance } from '../support/instance.js';
import { revokeWorker, type VisibilityWorld, visibilityWorld } from '../support/visibility.js';

let instance: Instance;
let world: VisibilityWorld;

beforeEach(async () => {
  instance = await startInstance({ label: 'project-visibility' });
  world = await visibilityWorld(instance);
}, 180_000);

afterEach(async () => {
  await instance?.stop();
});

interface Inbox {
  readonly questions: readonly { readonly task_id: string }[];
}

const projectsOf = async (client: VisibilityWorld['admin']): Promise<string[]> => {
  const answer = await client.json<{ items: { id: string }[] }>('/api/projects');
  expect(answer.status).toBe(200);
  return answer.body.items.map((item) => item.id);
};

const inboxTasksOf = async (client: VisibilityWorld['admin']): Promise<string[]> => {
  const answer = await client.json<Inbox>('/api/org/inbox');
  expect(answer.status).toBe(200);
  return answer.body.questions.map((question) => question.task_id);
};

describe('project visibility (BD-035)', () => {
  it('hides B from the member whose worker takes [A], and from nobody else; a revoke widens them again', async () => {
    const { admin, narrowed, open, projectA, projectB, taskA, taskB } = world;

    // The narrowed member: A only, everywhere.
    expect(await projectsOf(narrowed)).toEqual([projectA]);
    expect((await narrowed.json(`/api/projects/${projectA}/tasks`)).status).toBe(200);
    expect((await narrowed.json(`/api/tasks/${taskA}`)).status).toBe(200);
    const board = await narrowed.json(`/api/projects/${projectB}/tasks`);
    expect(board.status).toBe(404);
    expect(board.body).toEqual({
      error: { code: 'not_found', message: `project ${projectB} does not exist` },
    });
    const task = await narrowed.json(`/api/tasks/${taskB}`);
    expect(task.status).toBe(404);
    // Byte for byte the answer for a task that does not exist, but for the id.
    const missingId = '00000000-0000-4000-8000-0000000dead0';
    const missing = await narrowed.json(`/api/tasks/${missingId}`);
    expect(missing.status).toBe(404);
    expect(JSON.stringify(task.body).replace(taskB, '<id>')).toBe(
      JSON.stringify(missing.body).replace(missingId, '<id>'),
    );
    // A command on B's task is the same 404, before its own role or body is asked.
    const answer = await narrowed.post(`/api/tasks/${taskB}/feedback`, { text: 'hello' });
    expect(answer.status).toBe(404);
    const inbox = await inboxTasksOf(narrowed);
    expect(inbox).toContain(taskA);
    expect(inbox).not.toContain(taskB);

    // Somebody who chose nothing, and the administrator: both projects.
    for (const client of [open, admin]) {
      expect(new Set(await projectsOf(client))).toEqual(new Set([projectA, projectB]));
      expect((await client.json(`/api/projects/${projectB}/tasks`)).status).toBe(200);
      expect((await client.json(`/api/tasks/${taskB}`)).status).toBe(200);
      expect(await inboxTasksOf(client)).toEqual(expect.arrayContaining([taskA, taskB]));
    }

    // The worker revoked: nothing narrows the member any more.
    await revokeWorker(instance, world.workerId);
    expect(new Set(await projectsOf(narrowed))).toEqual(new Set([projectA, projectB]));
    expect((await narrowed.json(`/api/projects/${projectB}/tasks`)).status).toBe(200);
    expect((await narrowed.json(`/api/tasks/${taskB}`)).status).toBe(200);
    expect(await inboxTasksOf(narrowed)).toEqual(expect.arrayContaining([taskA, taskB]));
  });

  it('still offers the narrowed member every project they may run in on their machine’s card', async () => {
    const { narrowed, projectA, projectB, workerId } = world;
    const scope = await narrowed.json<{ projects: { id: string }[]; claim_project_ids: string[] }>(
      `/api/workers/${workerId}/claim-scope`,
    );
    expect(scope.status, JSON.stringify(scope.body)).toBe(200);
    expect(scope.body.claim_project_ids).toEqual([projectA]);
    expect(new Set(scope.body.projects.map((project) => project.id))).toEqual(
      new Set([projectA, projectB]),
    );
    // Somebody else's machine is not theirs to read.
    expect((await world.open.json(`/api/workers/${workerId}/claim-scope`)).status).toBe(404);
  });
});
