import type { SessionKey } from '@anthropic-ai/claude-agent-sdk';
import type { SessionMirrorKey, SessionMirrorPort } from '@platform/application';
import type { JsonObject } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { PROJECT_KEY_IS_DERIVED_FROM_CWD, toSdkSessionStore } from './session-mirror.js';

const recordingPort = (
  overrides: Partial<SessionMirrorPort> = {},
): SessionMirrorPort & {
  readonly appended: { key: SessionMirrorKey; entries: JsonObject[] }[];
} => {
  const appended: { key: SessionMirrorKey; entries: JsonObject[] }[] = [];
  return {
    appended,
    append: async (key, entries) => {
      appended.push({ key, entries: [...entries] });
    },
    load: async () => null,
    ...overrides,
  };
};

const key = (subpath?: string): SessionKey =>
  subpath === undefined
    ? { projectKey: 'task-1', sessionId: 's1' }
    : { projectKey: 'task-1', sessionId: 's1', subpath };

describe('toSdkSessionStore', () => {
  it('passes a batch through to the port', async () => {
    const port = recordingPort();
    await toSdkSessionStore(port).append(key(), [{ type: 'user', uuid: 'u1' }]);
    expect(port.appended).toEqual([
      { key: { projectKey: 'task-1', sessionId: 's1' }, entries: [{ type: 'user', uuid: 'u1' }] },
    ]);
  });

  it('keeps a subagent subpath and omits the field for the main transcript', async () => {
    const port = recordingPort();
    const store = toSdkSessionStore(port);
    await store.append(key(), []);
    await store.append(key('agent-1'), []);
    expect(port.appended.map((entry) => entry.key)).toEqual([
      { projectKey: 'task-1', sessionId: 's1' },
      { projectKey: 'task-1', sessionId: 's1', subpath: 'agent-1' },
    ]);
  });

  it('returns null for a session that was never mirrored', async () => {
    await expect(toSdkSessionStore(recordingPort()).load(key())).resolves.toBeNull();
  });

  it('returns the stored entries on resume', async () => {
    const port = recordingPort({ load: async () => [{ type: 'assistant', uuid: 'a1' }] });
    await expect(toSdkSessionStore(port).load(key())).resolves.toEqual([
      { type: 'assistant', uuid: 'a1' },
    ]);
  });

  it('exposes `listSubkeys` only when the port implements it', async () => {
    expect(toSdkSessionStore(recordingPort()).listSubkeys).toBeUndefined();
    const port = recordingPort({ listSubkeys: async () => ['agent-1'] });
    await expect(toSdkSessionStore(port).listSubkeys?.(key())).resolves.toEqual(['agent-1']);
  });

  it('records that the SDK, not the platform, chooses `projectKey` (Q40 context)', () => {
    expect(PROJECT_KEY_IS_DERIVED_FROM_CWD).toBe(true);
  });
});
