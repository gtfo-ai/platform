/**
 * The device flow's machine half — WP-280, TD-031 decision 10c, RFC 8628's shape (research/17 § 7):
 *
 *   POST /api/worker/v1/device         → a code pair
 *   POST /api/worker/v1/device/token   → the worker's poll
 *
 * **Unauthenticated by design**: a machine with no credential yet is what asks. What stands in for
 * authentication is the code pair — the `device_code` is 32 random bytes the poll must present, and
 * nothing is issued until a **signed-in** person approves the `user_code` on `/workers/approve`
 * (`routes/workers.ts`). Both codes are stored only as SHA-256.
 *
 * ## Limits (TD-031 §10c)
 *
 * At most {@link MAX_OUTSTANDING_DEVICE_CODES_PER_ADDRESS} pending codes per client address and
 * {@link MAX_OUTSTANDING_DEVICE_CODES_PER_INSTANCE} in the instance; past either, `device` answers
 * `429 device_code_limit` with `Retry-After`. The client address is
 * `client-address.ts`'s: `APP_TRUSTED_CLIENT_IP_HEADER` only from a peer `APP_TRUST_PROXY` trusts,
 * else `request.ip` — so a forged header from an untrusted peer is limited by its socket address.
 * The poll is throttled per code by RFC 8628's `slow_down`.
 *
 * ## Answers
 *
 * The poll answers RFC 8628 §3.5's body `{ "error": "<code>" }` with `400` — the one worker answer
 * that is not the API envelope (`workerDeviceTokenErrorSchema`) — and, **once**, `200` with the
 * worker's id and credential. An unknown `device_code` is `expired_token`: the client's only correct
 * move is the same (start again), and a distinct answer would only tell a guesser it guessed wrong.
 * Every answer is `Cache-Control: no-store` (RFC 6749 §5.1), the credential's above all.
 *
 * `X-Worker-Protocol` is checked **before** these routes, by `routes/worker/protocol.ts`'s
 * `registerWorkerProtocolCheck` on every `/api/worker/v1/` verb (WP-281, backlog 712): TD-031 §9 asks
 * the header on every request, and a worker whose protocol this core does not serve should learn it
 * before it registers a credential it cannot use. These handlers are therefore reached only by an
 * accepted protocol.
 */
import {
  apiErrorSchema,
  WORKER_API_PREFIX,
  WORKER_PATHS,
  workerDeviceRequestSchema,
  workerDeviceResponseSchema,
  workerDeviceTokenErrorSchema,
  workerDeviceTokenRequestSchema,
  workerDeviceTokenResponseSchema,
} from '@platform/contracts';
import {
  DEVICE_CODE_TTL_SECONDS,
  DEVICE_POLL_INTERVAL_SECONDS,
  MAX_OUTSTANDING_DEVICE_CODES_PER_ADDRESS,
  MAX_OUTSTANDING_DEVICE_CODES_PER_INSTANCE,
} from '@platform/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod';
import { compileTrust, resolveClientAddress, type TrustProxySetting } from '../client-address.js';
import { HttpError } from '../errors.js';
import type { WorkerStore } from '../queries/worker-queries.js';
import { hashSecret, mintDeviceCodes, mintWorkerCredential } from '../workers/secrets.js';

/** The page a person approves a code on (TD-031 §10c's `verification_uri`). */
export const WORKER_APPROVE_PAGE = '/workers/approve';
/** How long a limited client is told to wait: a pending code ages out in at most this long. */
export const DEVICE_LIMIT_RETRY_AFTER_SECONDS = 60;
/** A user agent is stored at most this long; the approval page shows it as text. */
export const MAX_USER_AGENT_CHARS = 512;
/** A collision on a fresh pair is a 2⁻¹²⁸ (device) or ~10⁻⁸ (user code) event; bounded anyway. */
const MAX_MINT_ATTEMPTS = 3;

export interface WorkerDeviceRoutesOptions {
  readonly store: WorkerStore;
  /** `APP_BASE_URL`: the `verification_uri` is absolute. */
  readonly baseUrl: string;
  readonly trustProxy: TrustProxySetting;
  readonly trustedClientIpHeader: string | null;
  readonly now?: () => Date;
}

/** The user agent as stored: control characters dropped, bounded, `null` when absent or empty. */
export const boundedUserAgent = (raw: string | string[] | undefined): string | null => {
  const value = (Array.isArray(raw) ? raw[0] : raw) ?? '';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: dropping control characters is the point.
  const cleaned = value.replaceAll(/[\u0000-\u001f\u007f]/g, '').slice(0, MAX_USER_AGENT_CHARS);
  return cleaned === '' ? null : cleaned;
};

const noStore = (reply: FastifyReply): void => {
  reply.header('cache-control', 'no-store');
};

export const registerWorkerDeviceRoutes = async (
  app: FastifyInstance,
  options: WorkerDeviceRoutesOptions,
): Promise<void> => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const now = options.now ?? (() => new Date());
  const trusted = compileTrust(options.trustProxy);
  const verificationUri = new URL(WORKER_APPROVE_PAGE, options.baseUrl).toString();

  const clientOf = (request: FastifyRequest): string =>
    resolveClientAddress({
      socketAddress: request.socket.remoteAddress,
      requestIp: request.ip,
      headers: request.headers,
      trusted,
      trustedHeader: options.trustedClientIpHeader,
    });

  typed.post(
    `${WORKER_API_PREFIX}/${WORKER_PATHS.device}`,
    {
      schema: {
        summary: 'Start a worker’s device login (RFC 8628 §3.1’s shape)',
        description: `Answers a \`device_code\` (32 random bytes, the poll’s secret), a \`user_code\` (\`XXXX-XXXX\`) for a signed-in person to approve at \`verification_uri\`, \`interval\` ${DEVICE_POLL_INTERVAL_SECONDS} and \`expires_in\` ${DEVICE_CODE_TTL_SECONDS}. Both codes are stored hashed. Unauthenticated. \`429 device_code_limit\` past ${MAX_OUTSTANDING_DEVICE_CODES_PER_ADDRESS} pending codes for the client address or ${MAX_OUTSTANDING_DEVICE_CODES_PER_INSTANCE} in the instance; the address is \`APP_TRUSTED_CLIENT_IP_HEADER\` only from a peer \`APP_TRUST_PROXY\` trusts (WP-280, TD-031 §10c).`,
        tags: ['worker'],
        body: workerDeviceRequestSchema,
        response: { 200: workerDeviceResponseSchema, 429: apiErrorSchema },
      },
    },
    async (request, reply): Promise<z.output<typeof workerDeviceResponseSchema>> => {
      noStore(reply);
      const clientAddress = clientOf(request);
      const userAgent = boundedUserAgent(request.headers['user-agent']);
      for (let attempt = 0; attempt < MAX_MINT_ATTEMPTS; attempt += 1) {
        const { deviceCode, userCode } = mintDeviceCodes();
        const createdAt = now();
        const result = await options.store.createDeviceCode(
          {
            id: crypto.randomUUID(),
            deviceCodeHash: hashSecret(deviceCode),
            userCodeHash: hashSecret(userCode),
            clientAddress,
            userAgent,
            createdAt,
            expiresAt: new Date(createdAt.getTime() + DEVICE_CODE_TTL_SECONDS * 1000),
            intervalSeconds: DEVICE_POLL_INTERVAL_SECONDS,
          },
          createdAt,
        );
        if (result.status === 'limited') {
          reply.header('retry-after', String(DEVICE_LIMIT_RETRY_AFTER_SECONDS));
          throw new HttpError(
            429,
            'device_code_limit',
            result.limit === 'address'
              ? `this address already has ${MAX_OUTSTANDING_DEVICE_CODES_PER_ADDRESS} pending device codes; approve, deny or let one expire first`
              : `the instance already has ${MAX_OUTSTANDING_DEVICE_CODES_PER_INSTANCE} pending device codes`,
          );
        }
        if (result.status === 'created') {
          return {
            device_code: deviceCode,
            user_code: userCode,
            verification_uri: verificationUri,
            interval: DEVICE_POLL_INTERVAL_SECONDS,
            expires_in: DEVICE_CODE_TTL_SECONDS,
          };
        }
      }
      throw new HttpError(503, 'device_code_unavailable', 'could not draw an unused device code');
    },
  );

  typed.post(
    `${WORKER_API_PREFIX}/${WORKER_PATHS.deviceToken}`,
    {
      schema: {
        summary: 'Poll a device login for the worker credential (RFC 8628 §3.4)',
        description:
          'Answers `400` with RFC 8628 §3.5’s `{ "error": … }` — `authorization_pending`, `slow_down` (polled sooner than the interval, which grows by 5 s), `access_denied` (the code was denied, or its approver can no longer act) or `expired_token` (expired, already collected, or unknown) — or, **once**, `200` with the new worker’s id and its `wkr_` credential, which the core stores only as SHA-256 and never shows again. Unauthenticated; `Cache-Control: no-store` (WP-280, TD-031 §7, §10c).',
        tags: ['worker'],
        body: workerDeviceTokenRequestSchema,
        response: {
          200: workerDeviceTokenResponseSchema,
          400: z.union([workerDeviceTokenErrorSchema, apiErrorSchema]),
        },
      },
    },
    async (request, reply) => {
      noStore(reply);
      const minted = mintWorkerCredential();
      const result = await options.store.pollDeviceCode({
        deviceCodeHash: hashSecret(request.body.device_code),
        now: now(),
        mint: { workerId: minted.workerId, credentialHash: minted.credentialHash },
      });
      if (result.outcome === 'issued') {
        return reply.code(200).send({ worker_id: result.workerId, credential: minted.credential });
      }
      return reply.code(400).send({ error: result.outcome });
    },
  );
};
