/**
 * The prompt-version census over the shipped prompts, and each of its refusals against a planted
 * tree (WP-176 criterion (2)).
 */
import { agentRoleSchema } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { ROLE_PROMPT_VERSIONS, ROLE_PROMPTS } from './index.js';
import { promptFileDigest, promptVersionCensus, ROLE_PROMPT_DIGESTS } from './prompt-digests.js';

const texts = Object.fromEntries(
  agentRoleSchema.options.map((role) => [role, ROLE_PROMPTS[role].text]),
);

describe('the prompt-version census', () => {
  it('finds every shipped prompt at the digest its declared version recorded', () => {
    expect(promptVersionCensus(ROLE_PROMPT_VERSIONS, texts, ROLE_PROMPT_DIGESTS)).toEqual([]);
  });

  it('keeps a digest row for every role and for no other', () => {
    expect(Object.keys(ROLE_PROMPT_DIGESTS).sort()).toEqual([...agentRoleSchema.options].sort());
  });

  const history = {
    developer: { '1': promptFileDigest('first'), '2': promptFileDigest('second') },
  };

  it('passes a prompt at its declared version', () => {
    expect(promptVersionCensus({ developer: '2' }, { developer: 'second' }, history)).toEqual([]);
  });

  it('refuses an edited prompt whose version was not bumped, naming the role and the fix', () => {
    const problems = promptVersionCensus({ developer: '2' }, { developer: 'third' }, history);
    expect(problems).toEqual([
      expect.stringContaining(
        "developer's prompt.md changed since developer@2 was recorded: bump ROLE_PROMPT_VERSIONS.developer",
      ),
    ]);
  });

  it('refuses a bumped version with no recorded digest', () => {
    const problems = promptVersionCensus({ developer: '3' }, { developer: 'third' }, history);
    expect(problems).toContainEqual(
      `developer@3 has no recorded digest: add '3': '${promptFileDigest('third')}' to ROLE_PROMPT_DIGESTS.developer`,
    );
    expect(problems).toContainEqual('developer@3 is not the newest recorded version (2 is)');
  });

  it("refuses a prompt that is an older version's text", () => {
    expect(promptVersionCensus({ developer: '2' }, { developer: 'first' }, history)).toEqual([
      "developer's prompt.md is developer@1's text, but the declared version is 2",
    ]);
  });

  it('refuses a declared version older than the newest recorded one', () => {
    expect(promptVersionCensus({ developer: '1' }, { developer: 'first' }, history)).toEqual([
      'developer@1 is not the newest recorded version (2 is)',
    ]);
  });

  it('orders versions numerically, so 10 is newer than 9', () => {
    const tens = { developer: { '9': promptFileDigest('nine'), '10': promptFileDigest('ten') } };
    expect(promptVersionCensus({ developer: '10' }, { developer: 'ten' }, tens)).toEqual([]);
  });

  it('refuses one digest recorded under two versions', () => {
    const twice = { developer: { '1': promptFileDigest('same'), '2': promptFileDigest('same') } };
    expect(promptVersionCensus({ developer: '2' }, { developer: 'same' }, twice)).toEqual([
      'developer records one digest under two versions',
    ]);
  });

  it('refuses a prompt with no declared version', () => {
    expect(promptVersionCensus({}, { developer: 'second' }, history)).toEqual([
      'developer has a prompt and no declared version',
    ]);
  });

  it('reads CRLF line endings as the same text', () => {
    expect(promptFileDigest('a\r\nb\r\n')).toBe(promptFileDigest('a\nb\n'));
  });
});
