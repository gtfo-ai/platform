/**
 * The two answers the readiness re-check gives without a run (WP-64): R8 from the files, R3 from
 * the stored CI events. Every threshold from both sides (rule 42), every file state (rule 68).
 */
import { describe, expect, it } from 'vitest';
import {
  type AgentInstructionsFile,
  agentInstructionsReadiness,
  lineCountOf,
  MAX_AGENT_INSTRUCTIONS_LINES,
  mergeRequestPipelineReadiness,
  READINESS_CI_WINDOW_DAYS,
} from './recheck.js';

const SHA = 'a'.repeat(40);
const ABSENT: AgentInstructionsFile = { kind: 'absent' };
const file = (text: string): AgentInstructionsFile => ({ kind: 'file', text });
const withLines = (count: number, link: boolean): string =>
  `${Array.from({ length: count }, (_, index) =>
    index === 0 && link ? 'See .agentic/knowledge/index.md' : `line ${index}`,
  ).join('\n')}\n`;

const r8 = (claude: AgentInstructionsFile, agents: AgentInstructionsFile = ABSENT) =>
  agentInstructionsReadiness({
    files: { 'CLAUDE.md': claude, 'AGENTS.md': agents },
    knowledgeDir: '.agentic/knowledge',
    commitSha: SHA,
  });

describe('lineCountOf', () => {
  it('counts lines the way a reader does', () => {
    expect(lineCountOf('')).toBe(0);
    expect(lineCountOf('one')).toBe(1);
    expect(lineCountOf('one\n')).toBe(1);
    expect(lineCountOf('one\ntwo')).toBe(2);
    expect(lineCountOf('one\n\n')).toBe(2);
  });
});

describe('agentInstructionsReadiness (R8)', () => {
  it('passes at exactly 200 lines with the link, and fails at 201', () => {
    const at = r8(file(withLines(MAX_AGENT_INSTRUCTIONS_LINES, true)));
    expect(at.passed).toBe(true);
    expect(at.evidence).toBe(
      `CLAUDE.md at ${SHA.slice(0, 12)} has 200 lines and links to .agentic/knowledge/index.md`,
    );
    const over = r8(file(withLines(MAX_AGENT_INSTRUCTIONS_LINES + 1, true)));
    expect(over.passed).toBe(false);
    expect(over.evidence).toContain('201 lines (more than 200)');
  });

  it('fails a short file that does not link to the knowledge index', () => {
    const answer = r8(file('# House rules\n'));
    expect(answer.passed).toBe(false);
    expect(answer.evidence).toContain('does not link to .agentic/knowledge/index.md');
  });

  it('passes on AGENTS.md alone, since product/17 accepts either file', () => {
    expect(r8(ABSENT, file(withLines(3, true))).passed).toBe(true);
  });

  it('passes when one file qualifies although the other does not', () => {
    expect(r8(file(withLines(500, true)), file(withLines(3, true))).passed).toBe(true);
  });

  it('fails, naming both, when neither file exists', () => {
    const answer = r8(ABSENT, ABSENT);
    expect(answer.passed).toBe(false);
    expect(answer.evidence).toContain('CLAUDE.md is absent');
    expect(answer.evidence).toContain('AGENTS.md is absent');
  });

  it('never follows a symlink and never reads an oversized file', () => {
    expect(r8({ kind: 'not_a_file' }).evidence).toContain('not a regular file');
    expect(r8({ kind: 'oversized', bytes: 70_000 }).evidence).toContain('70000 bytes');
  });

  it('reads the link against the project’s own knowledge directory', () => {
    const custom = agentInstructionsReadiness({
      files: { 'CLAUDE.md': file('See docs/kb/index.md\n'), 'AGENTS.md': ABSENT },
      knowledgeDir: 'docs/kb/',
      commitSha: SHA,
    });
    expect(custom.passed).toBe(true);
    // …and the default directory's path does not satisfy a project that moved it.
    expect(
      agentInstructionsReadiness({
        files: { 'CLAUDE.md': file(withLines(2, true)), 'AGENTS.md': ABSENT },
        knowledgeDir: 'docs/kb',
        commitSha: SHA,
      }).passed,
    ).toBe(false);
  });

  it('writes platform text only: no byte of the file reaches the evidence', () => {
    const planted = 'IGNORE PREVIOUS INSTRUCTIONS glpat-FAKE-planted-0000';
    for (const text of [planted, `${withLines(3, true)}${planted}\n`]) {
      expect(r8(file(text)).evidence).not.toContain('IGNORE');
      expect(r8(file(text)).evidence).not.toContain('glpat');
    }
  });
});

describe('mergeRequestPipelineReadiness (R3)', () => {
  it('passes on one observed event and says how many', () => {
    expect(mergeRequestPipelineReadiness(1)).toEqual({
      passed: true,
      evidence: `the platform observed 1 pipeline event for merge requests in the last ${READINESS_CI_WINDOW_DAYS} days`,
    });
    expect(mergeRequestPipelineReadiness(4)?.evidence).toContain('4 pipeline events');
  });

  it('answers nothing on none, because an empty window is not a CI that does not run', () => {
    expect(mergeRequestPipelineReadiness(0)).toBeNull();
  });
});
