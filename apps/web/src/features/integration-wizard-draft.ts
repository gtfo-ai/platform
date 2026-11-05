/**
 * The add-integration wizard's **draft**, kept in this tab's `sessionStorage` so a reload resumes the
 * step a person was on (S-23.23, the UX audit's item 10; research/19 rule 4, TD-033 decision 9).
 *
 * **Only what is not a secret is kept**: the provider, the name and the provider's configuration
 * fields — never the credential fields, whose *values* never reach the browser at all (TD-020), and
 * not even the environment-variable *names* the credentials step asks for, which a reload asks for
 * again. `sessionStorage` is per tab and is cleared when the tab closes, so a draft does not outlive
 * the visit; the create clears it, because from then on the integration's id in the URL is what the
 * wizard resumes from.
 *
 * What is read back is parsed, never trusted: a value another version of the page wrote, or a
 * person edited, is refused whole and the wizard starts at its first step. Storage that throws (a
 * private window, a quota) is the same as no draft.
 */
import * as z from 'zod';

export const INTEGRATION_DRAFT_STORAGE_KEY = 'agentic.integration-wizard.draft';

/** The longest value one field keeps; a draft past it is refused rather than cut. */
const MAX_DRAFT_CHARS = 4_000;

const draftValueSchema = z.string().max(MAX_DRAFT_CHARS);

export const integrationDraftSchema = z.strictObject({
  providerId: draftValueSchema,
  name: draftValueSchema,
  config: z.record(draftValueSchema, draftValueSchema),
});

export type IntegrationDraft = z.infer<typeof integrationDraftSchema>;

type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const storageOf = (): DraftStorage | undefined => {
  try {
    return globalThis.sessionStorage ?? undefined;
  } catch {
    return undefined;
  }
};

/** The stored draft, or `null` when there is none, it does not parse, or storage refuses. */
export const readIntegrationDraft = (
  storage: Pick<Storage, 'getItem'> | undefined = storageOf(),
): IntegrationDraft | null => {
  try {
    const raw = storage?.getItem(INTEGRATION_DRAFT_STORAGE_KEY);
    if (raw === null || raw === undefined) {
      return null;
    }
    const parsed = integrationDraftSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/** Keep the draft; an empty one (nothing chosen, nothing typed) is removed instead. */
export const storeIntegrationDraft = (
  draft: IntegrationDraft,
  storage: DraftStorage | undefined = storageOf(),
): void => {
  try {
    const empty =
      draft.providerId === '' && draft.name === '' && Object.keys(draft.config).length === 0;
    if (empty) {
      storage?.removeItem(INTEGRATION_DRAFT_STORAGE_KEY);
      return;
    }
    const kept: IntegrationDraft = {
      providerId: draft.providerId,
      name: draft.name,
      config: { ...draft.config },
    };
    storage?.setItem(INTEGRATION_DRAFT_STORAGE_KEY, JSON.stringify(kept));
  } catch {
    // Storage refused: the draft is not remembered, and the wizard still works.
  }
};

export const clearIntegrationDraft = (
  storage: Pick<Storage, 'removeItem'> | undefined = storageOf(),
): void => {
  try {
    storage?.removeItem(INTEGRATION_DRAFT_STORAGE_KEY);
  } catch {
    // Nothing to do: a storage that refuses kept nothing either.
  }
};
