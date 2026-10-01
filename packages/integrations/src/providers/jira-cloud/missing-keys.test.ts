/**
 * WP-110 review round 1: which keys a Jira `400` names as missing — and only among the keys the
 * platform asked for, so provider text can narrow the platform's own list and never extend it.
 */
import { IntegrationError } from '@platform/application';
import { describe, expect, it } from 'vitest';
import { missingIssueKeysIn } from './index.js';

const refusal = (text: string, code: 'invalid_request' | 'unavailable' = 'invalid_request') =>
  new IntegrationError(code, 'jira-cloud', `HTTP 400: ${text}`, { action: 'match_tickets' });

describe('the keys a search refusal names as missing', () => {
  it('reads every named key that was asked for, and nothing else', () => {
    const error = refusal(
      "An issue with key 'ACME-2' does not exist for field 'key'.; An issue with key 'OTHER-9' does not exist for field 'key'.",
    );
    expect(missingIssueKeysIn(error, ['ACME-1', 'ACME-2'])).toEqual(['ACME-2']);
  });

  it('reads nothing from another refusal, another code, or not an integration error', () => {
    expect(missingIssueKeysIn(refusal("Field 'labelz' does not exist"), ['ACME-1'])).toEqual([]);
    expect(
      missingIssueKeysIn(
        refusal("An issue with key 'ACME-1' does not exist for field 'key'.", 'unavailable'),
        ['ACME-1'],
      ),
    ).toEqual([]);
    expect(
      missingIssueKeysIn(new Error("An issue with key 'ACME-1' does not exist"), ['ACME-1']),
    ).toEqual([]);
  });
});
