import { apiErrorSchema } from '@platform/contracts';
import { PermissionDeniedError } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import {
  BadRequestError,
  ForbiddenError,
  HttpError,
  NotFoundError,
  TooManyRequestsError,
  toApiError,
  UnauthorizedError,
} from './errors.js';

const map = (error: unknown) => toApiError(error, 'req-1');

describe('toApiError', () => {
  it('produces a body that satisfies the published error schema', () => {
    for (const error of [
      new UnauthorizedError(),
      new ForbiddenError('org.audit.read', 'member'),
      new NotFoundError('project x'),
      new BadRequestError('invalid_topics', 'bad topic'),
      new TooManyRequestsError('slow down'),
      new PermissionDeniedError('task.cancel', 'member'),
      new Error('something unexpected'),
    ]) {
      expect(apiErrorSchema.safeParse(map(error).body).success).toBe(true);
    }
  });

  it('keeps 401 and 403 apart', () => {
    // Authenticating differently fixes one and not the other; a client has to be able to tell.
    expect(map(new UnauthorizedError()).statusCode).toBe(401);
    expect(map(new ForbiddenError('a', 'viewer')).statusCode).toBe(403);
  });

  it('maps the domain’s own permission error onto 403, not 500', () => {
    const mapped = map(new PermissionDeniedError('task.cancel', 'member'));
    expect(mapped.statusCode).toBe(403);
    expect(mapped.body.error.code).toBe('forbidden');
    expect(mapped.unexpected).toBe(false);
  });

  it('never leaks the cause of an unexpected failure', () => {
    const mapped = map(new Error('connect ECONNREFUSED postgres://app:hunter2@db:5432'));
    expect(mapped.statusCode).toBe(500);
    expect(mapped.unexpected).toBe(true);
    expect(JSON.stringify(mapped.body)).not.toContain('hunter2');
    // …but it does hand over the request id, so the log line can be found.
    expect(mapped.body.error.message).toContain('req-1');
  });

  it('carries a 4xx message through, because the client caused it', () => {
    expect(map(new NotFoundError('project x')).body.error.message).toBe('project x does not exist');
  });

  it('passes a details list through when one was given', () => {
    const mapped = map(
      new BadRequestError('invalid_request', 'bad', [{ path: 'a.b', message: 'required' }]),
    );
    expect(mapped.body.error.details).toEqual([{ path: 'a.b', message: 'required' }]);
  });

  it('turns a framework 4xx into a snake_case code', () => {
    const framework = Object.assign(new Error('body must be object'), {
      statusCode: 400,
      code: 'FST_ERR_CTP_EMPTY_JSON_BODY',
    });
    const mapped = map(framework);
    expect(mapped.statusCode).toBe(400);
    expect(mapped.body.error.code).toBe('fst_err_ctp_empty_json_body');
    expect(apiErrorSchema.safeParse(mapped.body).success).toBe(true);
  });

  it('treats a framework 5xx as unexpected', () => {
    const mapped = map(Object.assign(new Error('upstream died'), { statusCode: 502 }));
    expect(mapped.statusCode).toBe(500);
    expect(mapped.unexpected).toBe(true);
  });

  it('keeps an explicit HttpError’s status even in the 5xx range', () => {
    const mapped = map(new HttpError(500, 'invalid_stored_config', 're-import it'));
    expect(mapped.statusCode).toBe(500);
    expect(mapped.body.error.code).toBe('invalid_stored_config');
    expect(mapped.unexpected).toBe(false);
  });
});
