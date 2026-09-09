import type { UserRole } from '@platform/contracts';
import { describe, expect, it, vi } from 'vitest';
import { ForbiddenError, NotFoundError } from '../errors.js';
import { authoriseTopics, resolveTopic, type TopicAccessDependencies } from './topic-access.js';

const PROJECT = '0199aa11-2b3c-7d4e-8f90-000000000001';
const OTHER_PROJECT = '0199aa11-2b3c-7d4e-8f90-000000000009';
const TASK = '0199aa11-2b3c-7d4e-8f90-000000000002';
const RUN = '0199aa11-2b3c-7d4e-8f90-000000000003';

const deps = (overrides: Partial<TopicAccessDependencies> = {}): TopicAccessDependencies => ({
  projectRole: async () => null,
  projectExists: async (id) => id === PROJECT || id === OTHER_PROJECT,
  taskProjectId: async (id) => (id === TASK ? PROJECT : null),
  runProjectId: async (id) => (id === RUN ? PROJECT : null),
  ...overrides,
});

const actor = (role: UserRole) => ({ userId: 'u1', role });

describe('resolveTopic', () => {
  it('maps each topic kind to the capability technical/08 gives it', async () => {
    expect(await resolveTopic(deps(), 'org')).toEqual({ action: 'org.read', projectId: null });
    expect(await resolveTopic(deps(), `project:${PROJECT}`)).toEqual({
      action: 'project.read',
      projectId: PROJECT,
    });
    expect(await resolveTopic(deps(), `task:${TASK}`)).toEqual({
      action: 'task.read',
      projectId: PROJECT,
    });
    // A run's stream is its transcript, and `transcript.read` is member-and-above — the one place
    // where an SSE topic needs more than the viewer level the rest of the read surface does.
    expect(await resolveTopic(deps(), `run:${RUN}`)).toEqual({
      action: 'transcript.read',
      projectId: PROJECT,
    });
  });

  it('refuses a topic whose subject does not exist', async () => {
    const unknown = '0199aa11-2b3c-7d4e-8f90-0000000000ff';
    await expect(resolveTopic(deps(), `project:${unknown}`)).rejects.toBeInstanceOf(NotFoundError);
    await expect(resolveTopic(deps(), `task:${unknown}`)).rejects.toBeInstanceOf(NotFoundError);
    await expect(resolveTopic(deps(), `run:${unknown}`)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses a topic kind it does not know', async () => {
    await expect(resolveTopic(deps(), 'workspace:abc')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('authoriseTopics', () => {
  it('lets a viewer watch the org, a project and a task', async () => {
    await expect(
      authoriseTopics(deps(), actor('viewer'), ['org', `project:${PROJECT}`, `task:${TASK}`]),
    ).resolves.toBeUndefined();
  });

  it('refuses a viewer the run topic, because it carries the transcript', async () => {
    // Before this check existed, `/events` took any well-formed topic from any session: a viewer
    // could subscribe to an agent's transcript and receive it the moment WP-12 starts publishing.
    await expect(authoriseTopics(deps(), actor('viewer'), [`run:${RUN}`])).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(authoriseTopics(deps(), actor('member'), [`run:${RUN}`])).resolves.toBeUndefined();
  });

  it('applies a project membership, which promotes but never demotes', async () => {
    // A viewer in the organisation who maintains this project may read its transcripts.
    const promoted = deps({ projectRole: async () => 'member' });
    await expect(
      authoriseTopics(promoted, actor('viewer'), [`run:${RUN}`]),
    ).resolves.toBeUndefined();

    // …and a project membership below the org role cannot take the org role away.
    const demoting = deps({ projectRole: async () => 'viewer' });
    await expect(
      authoriseTopics(demoting, actor('member'), [`run:${RUN}`]),
    ).resolves.toBeUndefined();
  });

  it('refuses the whole subscription when one topic is not allowed', async () => {
    // All or nothing: dropping the disallowed topics would hand the client a stream that looks
    // subscribed and is quietly missing half of what it asked for.
    await expect(
      authoriseTopics(deps(), actor('viewer'), ['org', `run:${RUN}`]),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('looks a project membership up once, however many of its topics are named', async () => {
    const projectRole = vi.fn(async (): Promise<UserRole | null> => 'member');
    await authoriseTopics(deps({ projectRole }), actor('member'), [
      `project:${PROJECT}`,
      `task:${TASK}`,
      `run:${RUN}`,
    ]);
    expect(projectRole).toHaveBeenCalledTimes(1);
  });

  it('scopes each topic to its own project', async () => {
    const projectRole = vi.fn(
      async (projectId: string): Promise<UserRole | null> =>
        projectId === PROJECT ? 'member' : null,
    );
    // The task's project promotes the viewer; the other project does not, so its topic is refused.
    await expect(
      authoriseTopics(deps({ projectRole }), actor('viewer'), [`run:${RUN}`]),
    ).resolves.toBeUndefined();
    await expect(
      authoriseTopics(deps({ projectRole }), actor('viewer'), [`project:${OTHER_PROJECT}`]),
    ).resolves.toBeUndefined();
  });

  it('accepts an empty topic list, which is what a removal-only subscription update is', async () => {
    await expect(authoriseTopics(deps(), actor('viewer'), [])).resolves.toBeUndefined();
  });
});
