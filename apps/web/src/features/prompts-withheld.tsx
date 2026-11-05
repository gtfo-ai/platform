/**
 * **Why the project's prompt files were held back, in plain words** (S-23.22, the final UX audit's
 * item 2).
 *
 * `prompts_withheld` (WP-121, PROGRESS backlog 363) is the server's record of the reason: one
 * sentence plus an entry per integration whose credentials could not be decrypted, each written as
 * `integration "<name>" (<provider>, <id>)` with the secret store's reason. That record is a
 * diagnostic — it names ids, the redaction scheme and the command that re-reads the repository — so
 * the run page and the project's prompt-files card both say it the same way here: a sentence built
 * from the record's **shape** (whether any integration is named), a link to where the fix is, and the
 * record itself behind *Technical details*.
 */
import type { PromptsWithheldRecord } from '@platform/contracts';
import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { DetailsDisclosure } from '../ui/details.js';
import { UntrustedText } from '../ui/untrusted.js';

/** The visible sentence: what happened and what clears it — never the record's own text. */
export const promptsWithheldSentence = (withheld: PromptsWithheldRecord): string =>
  withheld.integrations.length > 0
    ? `${withheld.integrations.length === 1 ? 'An integration’s credentials' : `${withheld.integrations.length} integrations’ credentials`} can no longer be read, so the project’s prompt files were not used. They are used again once those credentials are replaced or the integration is retired.`
    : 'The project’s prompt files were not used: they were read before the platform could check them for credentials, and are used again once the repository is read again.';

/** The record behind *Technical details*, one line per part. */
export const PromptsWithheldDetails = ({
  withheld,
}: {
  readonly withheld: PromptsWithheldRecord;
}): ReactElement => (
  <DetailsDisclosure summary="Technical details">
    <ul className="flex flex-col gap-1 font-mono text-xs [overflow-wrap:anywhere]">
      <li>
        <UntrustedText value={withheld.reason} />
      </li>
      {withheld.integrations.map((entry) => (
        <li key={entry.integration}>
          <UntrustedText value={`${entry.integration}: ${entry.reason}`} />
        </li>
      ))}
    </ul>
  </DetailsDisclosure>
);

/** The sentence, the way to the fix, and the diagnostic — the run page's and the settings card's. */
export const PromptsWithheldExplanation = ({
  withheld,
}: {
  readonly withheld: PromptsWithheldRecord;
}): ReactElement => (
  <div className="flex flex-col gap-1">
    <p>{promptsWithheldSentence(withheld)}</p>
    {withheld.integrations.length === 0 ? null : (
      <p>
        <Link to="/integrations" className="text-link hover:underline">
          Open Integrations
        </Link>
      </p>
    )}
    <PromptsWithheldDetails withheld={withheld} />
  </div>
);
