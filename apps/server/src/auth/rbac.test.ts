import type { UserRole } from '@platform/contracts';
import { can } from '@platform/domain';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { ForbiddenError, NotFoundError, toApiError, UnauthorizedError } from '../errors.js';
import { type Actor, effectiveRole, requirePermission, VISIBILITY_GUARD } from './rbac.js';
import { everyProjectVisible, onlyProjectsVisible } from './visibility.test-fixture.js';

const actor = (role: UserRole): Actor => ({
  userId: 'u1',
  email: 'a@example.test',
  name: 'A',
  role,
  sessionId: 's1',
});

const request = (overrides: Partial<FastifyRequest> = {}): FastifyRequest =>
  ({ params: {}, ...overrides }) as FastifyRequest;

const reply = {} as FastifyReply;

/** No project membership at all — the default for the organisation-scoped cases. */
const noMembership = { projectRole: async () => null, visibleProjects: everyProjectVisible };

describe('effectiveRole', () => {
  it('promotes but never demotes', () => {
    // product/11 describes roles at organisation level and adds project membership on top; a
    // membership that could demote would let a project strip an organisation admin.
    expect(effectiveRole('member', 'maintainer')).toBe('maintainer');
    expect(effectiveRole('admin', 'viewer')).toBe('admin');
    expect(effectiveRole('viewer', null)).toBe('viewer');
    expect(effectiveRole('member', 'member')).toBe('member');
  });
});

describe('requirePermission', () => {
  it('refuses an anonymous request with 401', async () => {
    const guard = requirePermission(noMembership, 'org.read');
    await expect(guard(request(), reply)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('allows what the domain allows and refuses what it refuses', async () => {
    const read = requirePermission(noMembership, 'org.read');
    const audit = requirePermission(noMembership, 'org.audit.read');

    await expect(read(request({ actor: actor('viewer') }), reply)).resolves.toBeUndefined();
    // `org.audit.read` is maintainer-and-above (Q36).
    await expect(audit(request({ actor: actor('member') }), reply)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(audit(request({ actor: actor('maintainer') }), reply)).resolves.toBeUndefined();
  });

  it('asks packages/domain rather than deciding for itself', async () => {
    // The guard must not carry a second copy of the capability map. If this ever fails, the two
    // answers have diverged — which is how authorisation bugs are born.
    for (const role of ['viewer', 'member', 'maintainer', 'admin'] as const) {
      const guard = requirePermission(noMembership, 'task.cancel');
      const allowed = can(role, 'task.cancel');
      const result = await guard(request({ actor: actor(role) }), reply).then(
        () => true,
        () => false,
      );
      expect(result).toBe(allowed);
    }
  });

  it('applies the project membership when the route is project-scoped', async () => {
    const projectRole = vi.fn(async (): Promise<UserRole | null> => 'maintainer');
    const guard = requirePermission(
      { projectRole, visibleProjects: everyProjectVisible },
      'org.audit.read',
      { project: (req) => (req.params as { project_id: string }).project_id },
    );

    const req = request({ actor: actor('member'), params: { project_id: 'p1' } });
    await expect(guard(req, reply)).resolves.toBeUndefined();
    expect(projectRole).toHaveBeenCalledWith('p1', 'u1');
    // The role actually applied is recorded on the request, for the log line and the audit trail.
    expect(req.effectiveRole).toBe('maintainer');
  });

  it('does not look up a membership for an organisation-scoped route', async () => {
    const projectRole = vi.fn(async (): Promise<UserRole | null> => null);
    const guard = requirePermission(
      { projectRole, visibleProjects: everyProjectVisible },
      'org.read',
    );
    await guard(request({ actor: actor('viewer') }), reply);
    expect(projectRole).not.toHaveBeenCalled();
  });

  it('narrows on the resource’s state where the domain says so', async () => {
    const guard = requirePermission(noMembership, 'task.answer_question', {
      subject: () => ({ kind: 'question', status: 'answered' }),
    });
    // "First answer wins" is a state rule in packages/domain; the guard must honour it.
    await expect(guard(request({ actor: actor('admin') }), reply)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

describe('requirePermission: visibility before the role (BD-035, S-30.2)', () => {
  const VISIBLE = 'p-visible';
  const HIDDEN = 'p-hidden';
  const projectOf = (req: FastifyRequest) => (req.params as { project_id: string }).project_id;
  const narrowed = {
    projectRole: async () => null,
    visibleProjects: onlyProjectsVisible(VISIBLE),
  };
  const bodyOf = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => null,
      (caught: unknown) => caught,
    );
    return toApiError(error, 'request-1');
  };

  it('answers 401, then 404 for a hidden project, then 403 — in that order', async () => {
    // `task.cancel` is maintainer: a member is refused it, so a 404 here is the visibility half.
    const guard = requirePermission(narrowed, 'task.cancel', { project: projectOf });
    await expect(guard(request({ params: { project_id: HIDDEN } }), reply)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    await expect(
      guard(request({ actor: actor('member'), params: { project_id: HIDDEN } }), reply),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      guard(request({ actor: actor('member'), params: { project_id: VISIBLE } }), reply),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      guard(request({ actor: actor('maintainer'), params: { project_id: VISIBLE } }), reply),
    ).resolves.toBeUndefined();
  });

  it('gives a hidden project the body a missing one gets, and the scope hook’s label for a resource', async () => {
    const guard = requirePermission(narrowed, 'project.read', { project: projectOf });
    const hidden = await bodyOf(
      guard(request({ actor: actor('viewer'), params: { project_id: HIDDEN } }), reply),
    );
    const missing = toApiError(new NotFoundError(`project ${HIDDEN}`), 'request-1');
    expect(JSON.stringify(hidden.body)).toBe(JSON.stringify(missing.body));
    expect(hidden.statusCode).toBe(404);
    // A task's route names the task, exactly as `scopeToProject` names a missing one.
    const scoped = request({ actor: actor('viewer'), params: { project_id: HIDDEN } });
    scoped.scopeLabel = 'task t1';
    const task = await bodyOf(guard(scoped, reply));
    expect(JSON.stringify(task.body)).toBe(
      JSON.stringify(toApiError(new NotFoundError('task t1'), 'request-1').body),
    );
  });

  it('lets a person who sees every project through to the role, as before', async () => {
    const guard = requirePermission(noMembership, 'project.read', { project: projectOf });
    await expect(
      guard(request({ actor: actor('viewer'), params: { project_id: HIDDEN } }), reply),
    ).resolves.toBeUndefined();
  });

  it('reads the set once per request, and never for an organisation-scoped guard', async () => {
    const visibleProjects = vi.fn(onlyProjectsVisible(VISIBLE));
    const dependencies = { projectRole: async () => null, visibleProjects };
    const org = requirePermission(dependencies, 'org.read');
    const first = requirePermission(dependencies, 'project.read', { project: projectOf });
    const second = requirePermission(dependencies, 'task.read', { project: projectOf });
    const req = request({ actor: actor('viewer'), params: { project_id: VISIBLE } });
    await org(req, reply);
    expect(visibleProjects).not.toHaveBeenCalled();
    await first(req, reply);
    await second(req, reply);
    expect(visibleProjects).toHaveBeenCalledTimes(1);
  });

  it('refuses to build a project-scoped guard with no visibility reader, and marks the ones it builds', () => {
    const bare = { projectRole: async () => null } as unknown as typeof noMembership;
    expect(() => requirePermission(bare, 'project.read', { project: projectOf })).toThrow(
      /visibleProjects/,
    );
    // An organisation-scoped guard asks no project, so it needs none.
    expect(() => requirePermission(bare, 'org.read')).not.toThrow();
    const scoped = requirePermission(noMembership, 'project.read', { project: projectOf });
    const org = requirePermission(noMembership, 'org.read');
    expect((scoped as unknown as Record<symbol, unknown>)[VISIBILITY_GUARD]).toBe(true);
    expect((org as unknown as Record<symbol, unknown>)[VISIBILITY_GUARD]).toBeUndefined();
  });
});
