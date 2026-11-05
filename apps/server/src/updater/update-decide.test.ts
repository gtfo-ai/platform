import { describe, expect, it } from 'vitest';
import { decideUpdate, repositoriesOf, runningDigestsOf, sameDigests } from './decide.js';

const digests = (hex: string) => ({
  platform: `sha256:${hex.repeat(64)}`,
  platform_launcher: `sha256:${'1'.repeat(64)}`,
  platform_runtime: `sha256:${'2'.repeat(64)}`,
  platform_egress: `sha256:${'3'.repeat(64)}`,
});
const RUNNING = digests('a');
const NEWER = digests('b');
const EARLY = '2026-11-01T00:00:00Z';
const LATE = '2026-11-05T00:00:00Z';

const decide = (overrides: Partial<Parameters<typeof decideUpdate>[0]> = {}) =>
  decideUpdate({
    running: RUNNING,
    advertised: NEWER,
    accepted: [1, 2],
    protocol: 2,
    runningBuiltAt: EARLY,
    targetBuiltAt: LATE,
    ...overrides,
  });

describe('what the updater does with the core’s digests (TD-032 §3, §6)', () => {
  it('updates to a newer build the core advertises', () => {
    expect(decide()).toEqual({ kind: 'update', downgrade: false });
  });

  it('does nothing for the digests it runs, for none, or when it runs no pinned digests', () => {
    expect(decide({ advertised: RUNNING }).kind).toBe('none');
    expect(decide({ advertised: null }).kind).toBe('none');
    expect(decide({ running: null }).kind).toBe('none');
  });

  it('refuses a downgrade below the running build while the core still serves this protocol', () => {
    const refused = decide({ runningBuiltAt: LATE, targetBuiltAt: EARLY });
    expect(refused.kind).toBe('refuse');
    expect(refused.kind === 'refuse' ? refused.why : '').toContain('downgrade is refused');
    // The boundary: one second older is a downgrade, the same instant is not.
    expect(decide({ runningBuiltAt: LATE, targetBuiltAt: '2026-11-04T23:59:59Z' }).kind).toBe(
      'refuse',
    );
    expect(decide({ runningBuiltAt: LATE, targetBuiltAt: LATE }).kind).toBe('update');
  });

  it('follows the core to an older build once its protocol range excludes this worker', () => {
    expect(decide({ runningBuiltAt: LATE, targetBuiltAt: EARLY, accepted: [3, 4] })).toEqual({
      kind: 'update',
      downgrade: true,
    });
  });

  it('refuses when either build time cannot be read — it could be a downgrade', () => {
    for (const times of [
      { runningBuiltAt: null },
      { targetBuiltAt: null },
      { targetBuiltAt: 'not a time' },
    ]) {
      const decision = decide(times);
      expect(decision.kind).toBe('refuse');
      expect(decision.kind === 'refuse' ? decision.why : '').toContain('cannot be compared');
    }
    expect(decide({ targetBuiltAt: null, accepted: [9] }).kind).toBe('update');
  });
});

describe('the references and the repositories', () => {
  it('reads the four digests the running references pin, or null when one is a tag', () => {
    const references = {
      platform: `ghcr.io/acme/platform@${RUNNING.platform}`,
      platform_launcher: `ghcr.io/acme/platform-launcher@${RUNNING.platform_launcher}`,
      platform_runtime: `ghcr.io/acme/platform-runtime@${RUNNING.platform_runtime}`,
      platform_egress: `ghcr.io/acme/platform-egress@${RUNNING.platform_egress}`,
    };
    expect(runningDigestsOf(references)).toEqual(RUNNING);
    expect(runningDigestsOf({ ...references, platform_egress: 'platform-egress:dev' })).toBeNull();
    expect(sameDigests(RUNNING, digests('a'))).toBe(true);
    expect(sameDigests(RUNNING, NEWER)).toBe(false);
  });

  it('names the three images beside the trusted platform repository', () => {
    expect(repositoriesOf('ghcr.io/acme/platform')).toEqual({
      platform: 'ghcr.io/acme/platform',
      platform_launcher: 'ghcr.io/acme/platform-launcher',
      platform_runtime: 'ghcr.io/acme/platform-runtime',
      platform_egress: 'ghcr.io/acme/platform-egress',
    });
  });
});
