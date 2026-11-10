/**
 * S-28.12: which start failures are the **machine's** — handed back for another machine, the
 * worker stops claiming — and which are the task's or the project's, finished as not started.
 */
import type { NotStartedReport } from '@platform/application';
import { describe, expect, it } from 'vitest';
import { workspaceFaultOf } from './run-session.js';

const report = (failure: string, detail: string | null): NotStartedReport => ({
  kind: 'not_started',
  failure,
  detail,
  detailTruncated: false,
  transient: true,
  spawnRequested: false,
});
const redact = (text: string): string => text.replace('FAKE-secret-value', '[REDACTED]');

describe('a start failure that is the machine’s (S-28.12)', () => {
  it('is Docker out of network ranges, with the first line redacted', () => {
    expect(
      workspaceFaultOf(
        report(
          'RunStartError: workspace_failed',
          'Docker engine answered 400: all predefined address pools have been fully subnetted FAKE-secret-value\nmore',
        ),
        false,
        redact,
      ),
    ).toEqual({
      cause: 'docker_networks_exhausted',
      detail:
        'Docker engine answered 400: all predefined address pools have been fully subnetted [REDACTED]',
    });
  });

  it('is an engine the launcher cannot reach, or any refusal of the Docker engine itself', () => {
    expect(
      workspaceFaultOf(
        report('RunStartError: engine_unavailable', 'connect failed'),
        false,
        redact,
      ),
    ).toEqual({ cause: 'unknown', detail: 'connect failed' });
    expect(
      workspaceFaultOf(
        report('RunStartError: workspace_failed', 'Docker engine answered 500: odd'),
        false,
        redact,
      )?.cause,
    ).toBe('unknown');
  });

  it('is never a refused spec, a helper’s own failure, a run that asked for its CLI, or no words', () => {
    expect(
      workspaceFaultOf(
        report('RunStartError: invalid_spec, checkout_commit_missing', 'no space left on device'),
        false,
        redact,
      ),
    ).toBeNull();
    expect(
      workspaceFaultOf(
        report(
          'RunStartError: workspace_failed',
          'helper prep-1 exited 128\nfatal: repository not found',
        ),
        false,
        redact,
      ),
    ).toBeNull();
    expect(
      workspaceFaultOf(
        report('RunStartError: workspace_failed', 'no space left on device'),
        true,
        redact,
      ),
    ).toBeNull();
    expect(
      workspaceFaultOf(report('RunStartError: workspace_failed', null), false, redact),
    ).toBeNull();
  });
});
