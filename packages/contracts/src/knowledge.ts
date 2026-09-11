/**
 * Knowledge-base document vocabulary — product/05 § "Lesson item schema", stored by technical/03
 * § "Knowledge and code".
 *
 * A vault document is a Markdown file in the **project's** repository with an optional YAML
 * frontmatter block. Two things follow from that and shape everything here.
 *
 * **It is untrusted input (BD-022).** The file is written by whoever can push to the project, and
 * a document that *contains* instructions is exactly the attack the rule names. Nothing in this
 * module turns a field into behaviour: the vocabulary decides retrieval *weight* and nothing else,
 * and the text is carried as data all the way to the prompt and the UI.
 *
 * **Unknown frontmatter keys are kept, not refused.** This is the "records with user-chosen keys"
 * exception to the repository's strict-boundary rule (CLAUDE.md). A project's own frontmatter
 * conventions — `owner`, `team`, `review_by` — are none of the platform's business, and refusing
 * to index a page because it carries one would make a vault brittle in exactly the way product/05
 * § "Curated, not dumped" is trying to avoid. What is *not* tolerated is a known key with a wrong
 * value: `status: activ` is a mistake about the platform's own vocabulary and fails the parse
 * loudly, because silently reading it as "not deprecated" is the permissive-empty defect.
 *
 * **`confidence` is a label here and a number in the database, and that is deliberate.** product/05
 * writes `confidence: confirmed`; technical/03 gives `kb_documents.confidence` the type
 * `real` bounded to `[0, 1]`, because technical/07 § "Retrieval" boosts a candidate *by*
 * confidence and a boost needs a number. Both are right: the label is the authored value and
 * survives in `kb_documents.frontmatter`; the column stores {@link kbConfidenceWeight} of it, which
 * is what the ranking multiplies by. See the note added to technical/03 at WP-16.
 */
import * as z from 'zod';
import { isoDateSchema, nonEmptyStringSchema, pathPatternSchema } from './common.js';

/** product/05: `type: lesson | pitfall | reference | decision-pointer`. */
export const KB_DOCUMENT_TYPES = ['lesson', 'pitfall', 'reference', 'decision-pointer'] as const;
export const kbDocumentTypeSchema = z.enum(KB_DOCUMENT_TYPES);

/** product/05: `kind: technical | business`. */
export const KB_KINDS = ['technical', 'business'] as const;
export const kbKindSchema = z.enum(KB_KINDS);

/** product/05: `status: active | deprecated`. Deprecated pages are kept, never deleted. */
export const KB_STATUSES = ['active', 'deprecated'] as const;
export const kbStatusSchema = z.enum(KB_STATUSES);

/** product/05: `confidence: proposed | confirmed | contested`. */
export const KB_CONFIDENCES = ['proposed', 'confirmed', 'contested'] as const;
export const kbConfidenceSchema = z.enum(KB_CONFIDENCES);

export type KbConfidence = z.infer<typeof kbConfidenceSchema>;

/**
 * The retrieval weight technical/07 multiplies a full-text score by, and the value written to
 * `kb_documents.confidence`.
 *
 * `contested` is deliberately not zero: product/05 says contradictions are "flagged for humans,
 * never auto-resolved", so a contested page stays reachable and merely ranks last. Zero would make
 * it unreachable through search while still sitting in the vault, which is a silent deletion.
 */
export const KB_CONFIDENCE_WEIGHTS = {
  confirmed: 1,
  proposed: 0.6,
  contested: 0.3,
} as const satisfies Record<KbConfidence, number>;

/**
 * The weight of an authored confidence label, or of its **absence**.
 *
 * A page with no `confidence` is not a page with no confidence: most of a vault (the business and
 * technical layers, written by humans) carries no frontmatter at all, and treating that as zero
 * would rank the curated core below every machine-proposed lesson. The unlabelled weight is
 * therefore `proposed`'s, stated here rather than left to a `?? 0` at a call site (rule 16).
 */
export const KB_UNLABELLED_CONFIDENCE_WEIGHT = KB_CONFIDENCE_WEIGHTS.proposed;

export const kbConfidenceWeight = (confidence: KbConfidence | null | undefined): number =>
  confidence === null || confidence === undefined
    ? KB_UNLABELLED_CONFIDENCE_WEIGHT
    : KB_CONFIDENCE_WEIGHTS[confidence];

/**
 * product/05: `scope: project | stage:<name>`. A stage-scoped document is only ever a candidate
 * for that stage's runs.
 */
export const kbScopeSchema = z.union([
  z.literal('project'),
  z.string().regex(/^stage:[a-z][a-z0-9_]*$/, 'expected "project" or "stage:<slug>"'),
]);

export type KbScope = z.infer<typeof kbScopeSchema>;

/**
 * The known frontmatter vocabulary. Every field is optional: a business overview page legitimately
 * has none of them, and the frontmatter block itself is optional.
 *
 * Not strict — see the module docblock. Unknown keys are carried through to
 * `kb_documents.frontmatter` and ignored by ranking.
 */
export const kbFrontmatterSchema = z.looseObject({
  id: nonEmptyStringSchema.optional(),
  title: nonEmptyStringSchema.optional(),
  type: kbDocumentTypeSchema.optional(),
  kind: kbKindSchema.optional(),
  /** Free text matched against the task description (product/05, Devin's "trigger description"). */
  trigger: nonEmptyStringSchema.optional(),
  /** Globs matched against the task's touched paths; a match scores 1.0 (technical/07 step 1). */
  paths: z.array(pathPatternSchema).optional(),
  scope: kbScopeSchema.optional(),
  status: kbStatusSchema.optional(),
  confidence: kbConfidenceSchema.optional(),
  evidence: z.array(nonEmptyStringSchema).optional(),
  added: isoDateSchema.optional(),
  last_confirmed: isoDateSchema.optional(),
  /** Soft expiry: the nightly hygiene job re-verifies rather than deleting (product/05). */
  expires: isoDateSchema.optional(),
});

export type KbFrontmatter = z.infer<typeof kbFrontmatterSchema>;

/** The known keys, asked of the schema rather than repeated as a list (rule 7). */
export const KB_FRONTMATTER_KEYS: readonly string[] = Object.keys(kbFrontmatterSchema.shape);
