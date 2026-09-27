/**
 * What the readiness **re-check after a merge** can decide without a run — product/17, WP-64
 * (PROGRESS backlog 46).
 *
 * product/17: criteria are *"re-checked after every merged task (cheap: mostly file and CI-event
 * inspection)"*. `READINESS_CRITERIA[].recheck` states which criterion is answered how; this module
 * holds the two answers that are not the platform's existing three (R9, R11, R12):
 *
 *  - **R8** from the files themselves — `CLAUDE.md` and `AGENTS.md` at the merged commit, read
 *    through the platform's mirror (no checkout). Both directions: the file read is the whole of
 *    product/17's *"file inspection"*;
 *  - **R3** from the provider's pipeline events the platform already stored, pass-only.
 *
 * Pure: the caller reads the files and counts the events and hands both in. Everything written into
 * `evidence` here is **platform text** — a path, a line count, a number — and never a byte of the
 * file, so nothing a repository writes reaches the stored evaluation through this module.
 */

/** product/17 R8's *"≤ 200 lines"*. */
export const MAX_AGENT_INSTRUCTIONS_LINES = 200;

/** product/17 R8's two files, in the order a reader looks for them. */
export const AGENT_INSTRUCTIONS_PATHS = ['CLAUDE.md', 'AGENTS.md'] as const;

/**
 * How far back the re-check looks for a merge-request pipeline event (R3).
 *
 * product/17 gives R3 no window and R4 one of thirty days; the re-check uses R4's so *"CI runs on
 * merge requests"* means *now*, and so the read is bounded by the `events` table's
 * `(type, occurred_at)` index and its monthly partitions rather than by the project's whole history.
 */
export const READINESS_CI_WINDOW_DAYS = 30;

/** One of R8's files at the read commit — the shape `RepositoryFileSource` answers with. */
export type AgentInstructionsFile =
  | { readonly kind: 'absent' }
  | { readonly kind: 'not_a_file' }
  | { readonly kind: 'oversized'; readonly bytes: number }
  | { readonly kind: 'file'; readonly text: string };

export interface ReadinessAnswer {
  readonly passed: boolean;
  /** Platform text only — see the module docblock. */
  readonly evidence: string;
}

/**
 * Lines as a reader counts them: a final newline ends the last line rather than starting another.
 * An empty file has none.
 */
export const lineCountOf = (text: string): number => {
  if (text.length === 0) return 0;
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
};

const shortSha = (commitSha: string): string => commitSha.slice(0, 12);

/**
 * product/17 R8 — *"`CLAUDE.md`/`AGENTS.md` present, ≤ 200 lines, links to the KB index"*.
 *
 * Passes when **either** file satisfies all three clauses. "Links to the KB index" is the
 * knowledge index's repository path appearing in the file (`<knowledge_dir>/index.md`), which is the
 * test the configuration export already applies before proposing its own one-line pointer
 * (`config/export.ts`) — so the pointer the platform proposes is exactly what makes R8 pass, and a
 * link spelled differently (a URL to a rendered page, `docs/kb`) does not. That is conservative in
 * the direction product/17 § "What it is not" asks for: a missed link costs a suggestion.
 */
export const agentInstructionsReadiness = (input: {
  readonly files: Readonly<
    Record<(typeof AGENT_INSTRUCTIONS_PATHS)[number], AgentInstructionsFile>
  >;
  readonly knowledgeDir: string;
  readonly commitSha: string;
}): ReadinessAnswer => {
  const index = `${input.knowledgeDir.replace(/\/+$/, '')}/index.md`;
  const findings: string[] = [];
  for (const path of AGENT_INSTRUCTIONS_PATHS) {
    const file = input.files[path];
    switch (file.kind) {
      case 'absent':
        findings.push(`${path} is absent`);
        break;
      case 'not_a_file':
        findings.push(`${path} is not a regular file (a symlink, a directory or a submodule)`);
        break;
      case 'oversized':
        findings.push(`${path} is ${file.bytes} bytes, larger than the platform reads`);
        break;
      case 'file': {
        const lines = lineCountOf(file.text);
        const links = file.text.includes(index);
        if (lines <= MAX_AGENT_INSTRUCTIONS_LINES && links) {
          return {
            passed: true,
            evidence: `${path} at ${shortSha(input.commitSha)} has ${lines} lines and links to ${index}`,
          };
        }
        findings.push(
          `${path} has ${lines} lines${lines > MAX_AGENT_INSTRUCTIONS_LINES ? ` (more than ${MAX_AGENT_INSTRUCTIONS_LINES})` : ''}${links ? '' : ` and does not link to ${index}`}`,
        );
        break;
      }
    }
  }
  return {
    passed: false,
    evidence: `at ${shortSha(input.commitSha)}: ${findings.join('; ')}`,
  };
};

/**
 * product/17 R3 — *"pipeline events observed for MRs"* — from the events the platform stored.
 *
 * product/19 §5 defines the pass: *"at least one `ci.pipeline.finished` for an MR in the last 30
 * days, or CI config file + pipeline observed at first task"*, checked *"continuously"*. This is the
 * first half; the second half is discovery's answer, which a miss here carries.
 *
 * **Pass-only** (`ReadinessRecheckSource`'s `ci_events`): `null` when nothing was observed, and the
 * caller then carries the previous answer. `null` and not `false`, because a project whose window
 * held no merge request has observed nothing about its CI at all.
 */
export const mergeRequestPipelineReadiness = (observed: number): ReadinessAnswer | null =>
  observed > 0
    ? {
        passed: true,
        evidence: `the platform observed ${observed} pipeline ${observed === 1 ? 'event' : 'events'} for merge requests in the last ${READINESS_CI_WINDOW_DAYS} days`,
      }
    : null;
