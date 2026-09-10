/**
 * The five Web API methods the `Communication` port needs, and nothing else (TD-024: "covering
 * only the endpoints the type contracts need").
 *
 * Every response is parsed with `parseProviderData` before it reaches the application ring
 * (BD-022): a field that is missing, of the wrong type, or an unexpected shape is a loud
 * `IntegrationResponseError` at the boundary rather than an `undefined` three layers up. The error
 * never carries the offending value, because a Slack response body can echo the request.
 *
 * Sources, all retrieved 2026-09-10 — see `schemas.ts` for the response shapes.
 */
import { parseProviderData } from '@platform/application';
import type * as z from 'zod';
import { SLACK_PROVIDER_ID, type SlackHttp } from './http.js';
import {
  type AuthTestResponse,
  authTestResponseSchema,
  type ChatPostMessageResponse,
  chatPostMessageResponseSchema,
  chatUpdateResponseSchema,
  connectionsOpenResponseSchema,
  type SlackUser,
  userResponseSchema,
} from './schemas.js';

export interface PostMessageInput {
  readonly channel: string;
  readonly text: string;
  readonly blocks?: unknown;
  readonly threadTs?: string | null;
  readonly action: string;
}

export interface UpdateMessageInput {
  readonly channel: string;
  readonly ts: string;
  readonly text: string;
  readonly blocks?: unknown;
  readonly action: string;
}

export interface SlackClient {
  authTest(): Promise<AuthTestResponse>;
  postMessage(input: PostMessageInput): Promise<ChatPostMessageResponse>;
  updateMessage(input: UpdateMessageInput): Promise<{ channel: string; ts: string }>;
  /** `null` when Slack answered `users_not_found`, which is an answer rather than a failure. */
  lookupByEmail(email: string): Promise<SlackUser | null>;
  userInfo(userId: string): Promise<SlackUser | null>;
  /** The `wss://` URL for Socket Mode. Authenticated with the **app-level** token. */
  openConnection(appToken: string): Promise<string>;
}

const parse = <TValue>(schema: z.ZodType<TValue>, value: unknown, action: string): TValue =>
  parseProviderData(schema, value, { provider: SLACK_PROVIDER_ID, action });

export const createSlackClient = (http: SlackHttp): SlackClient => ({
  authTest: async () => {
    const body = await http.call({
      method: 'auth.test',
      action: 'test_connection',
      body: {},
      encoding: 'form',
    });
    return parse(authTestResponseSchema, body, 'test_connection');
  },

  postMessage: async (input) => {
    const body = await http.call({
      method: 'chat.postMessage',
      action: input.action,
      encoding: 'json',
      body: {
        channel: input.channel,
        text: input.text,
        ...(input.blocks === undefined ? {} : { blocks: input.blocks }),
        ...(input.threadTs == null ? {} : { thread_ts: input.threadTs }),
        // A thread reply that also lands in the channel would notify everyone twice; the port's
        // "one thread per task" only reads as one conversation if the replies stay in it.
        ...(input.threadTs == null ? {} : { reply_broadcast: false }),
      },
    });
    return parse(chatPostMessageResponseSchema, body, input.action);
  },

  updateMessage: async (input) => {
    const body = await http.call({
      method: 'chat.update',
      action: input.action,
      encoding: 'json',
      body: {
        channel: input.channel,
        ts: input.ts,
        text: input.text,
        ...(input.blocks === undefined ? {} : { blocks: input.blocks }),
      },
    });
    const parsed = parse(chatUpdateResponseSchema, body, input.action);
    return { channel: parsed.channel, ts: parsed.ts };
  },

  lookupByEmail: async (email) => {
    const body = await http.call({
      method: 'users.lookupByEmail',
      action: 'resolve_identity',
      encoding: 'form',
      body: { email },
      nullOnError: ['users_not_found'],
    });
    if (body === null) {
      return null;
    }
    return parse(userResponseSchema, body, 'resolve_identity').user;
  },

  userInfo: async (userId) => {
    const body = await http.call({
      method: 'users.info',
      action: 'resolve_identity',
      encoding: 'form',
      body: { user: userId },
      nullOnError: ['user_not_found', 'users_not_found'],
    });
    if (body === null) {
      return null;
    }
    return parse(userResponseSchema, body, 'resolve_identity').user;
  },

  openConnection: async (appToken) => {
    const body = await http.call({
      method: 'apps.connections.open',
      action: 'open_socket',
      encoding: 'form',
      body: {},
      token: appToken,
    });
    return parse(connectionsOpenResponseSchema, body, 'open_socket').url;
  },
});
