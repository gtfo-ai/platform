import type { UserRole } from '@platform/contracts';
import { can } from '@platform/domain';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { ForbiddenError, UnauthorizedError } from '../errors.js';
import { type Actor, effectiveRole, requirePermission } from './rbac.js';

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
const noMembership = { projectRole: async () => null };

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
    const guard = requirePermission({ projectRole }, 'org.audit.read', {
      project: (req) => (req.params as { project_id: string }).project_id,
    });

    const req = request({ actor: actor('member'), params: { project_id: 'p1' } });
    await expect(guard(req, reply)).resolves.toBeUndefined();
    expect(projectRole).toHaveBeenCalledWith('p1', 'u1');
    // The role actually applied is recorded on the request, for the log line and the audit trail.
    expect(req.effectiveRole).toBe('maintainer');
  });

  it('does not look up a membership for an organisation-scoped route', async () => {
    const projectRole = vi.fn(async (): Promise<UserRole | null> => null);
    const guard = requirePermission({ projectRole }, 'org.read');
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
