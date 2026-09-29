/**
 * The organisation settings document (`organizations.settings`, WP-93), behind a port.
 *
 * Only the notification band asks it in this ring — quiet hours and the organisation digest's
 * time for an organisation-scoped notification (PROGRESS backlog 235). The run path gets the
 * document's maximums through `ProjectSettingsPort`, which the composition root already composes
 * from the same column; the two parse it with the same strict schema (`organisationSettingsSchema`).
 */
import type { OrganisationSettings } from '@platform/contracts';

export interface OrganisationSettingsPort {
  /**
   * The document, **parsed**. `{}` for an organisation that states nothing.
   *
   * @throws when the stored document does not parse — never an empty document in its place,
   * because an empty document is "no quiet hours, no default account", the permissive reading of a
   * setting somebody wrote (standing rule 20).
   */
  readonly read: () => Promise<OrganisationSettings>;
}

/** An organisation that states nothing — the unit tier's default, and every instance before WP-93. */
export const noOrganisationSettings = (): OrganisationSettingsPort => ({
  read: async () => ({}),
});

/** A fixed document, for a test that states one. */
export const staticOrganisationSettings = (
  settings: OrganisationSettings,
): OrganisationSettingsPort => ({
  read: async () => settings,
});
