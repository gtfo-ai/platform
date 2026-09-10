/**
 * Integrations (product/10: "per-type cards with health, test connection, project-level settings").
 *
 * The cards and the setup guide are here. "Test connection" (`POST /api/integrations/:id/test`) and
 * creating an integration (`POST /api/integrations`) are **not**: both are mutations against routes
 * no work package has built, and a button that always fails is worse than a button that is not
 * there. The setup guide is what an operator actually needs first, and every provider already
 * ships one (technical/06).
 */
import { type ReactElement, useState } from 'react';
import { useIntegrations } from '../app/queries.js';
import { useServices } from '../app/services.js';
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  formatDateTime,
  Loading,
  SectionHeading,
} from '../ui/kit.js';
import { UntrustedProse, UntrustedText } from '../ui/untrusted.js';

const HEALTH_TONE: Record<string, BadgeTone> = {
  ok: 'success',
  degraded: 'warning',
  down: 'danger',
  unknown: 'neutral',
};

export const IntegrationsScreen = (): ReactElement => {
  const integrations = useIntegrations();
  const { endpoints } = useServices();
  const [guide, setGuide] = useState<{ id: string; markdown: string; title: string } | null>(null);
  const [guideError, setGuideError] = useState(false);

  return (
    <div className="flex flex-col gap-3">
      <SectionHeading>Integrations</SectionHeading>
      {integrations.isPending ? <Loading label="Loading integrations…" /> : null}
      {integrations.isError ? (
        <ErrorNotice
          title="Integrations could not be loaded."
          detail="Reading integration configuration needs the maintainer role (Q36)."
        />
      ) : null}
      {integrations.isSuccess && integrations.data.items.length === 0 ? (
        <EmptyState
          title="No integrations configured"
          hint="An integration connects one external system — a ticket board, a git host, a chat workspace, an error tracker, a log store. Credentials live in the environment or the secret store; they never come through the browser."
        />
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        {(integrations.data?.items ?? []).map((integration) => (
          <Card key={integration.id} className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold">
                <UntrustedText value={integration.name} />
              </span>
              <Badge tone="accent">{integration.type}</Badge>
              <Badge>{integration.provider}</Badge>
              <Badge tone={HEALTH_TONE[integration.health.status] ?? 'neutral'}>
                {integration.health.status}
              </Badge>
            </div>
            {integration.health.checked_at === null ? null : (
              <p className="text-xs text-fg-muted">
                checked {formatDateTime(integration.health.checked_at)}
              </p>
            )}
            {integration.health.detail === null ? null : (
              <p className="text-xs">
                <UntrustedText value={integration.health.detail} />
              </p>
            )}
            <Button
              onClick={() => {
                setGuideError(false);
                void endpoints
                  .integrationSetupGuide(integration.id)
                  .then((response) => {
                    setGuide({
                      id: integration.id,
                      markdown: response.markdown,
                      title: response.title,
                    });
                  })
                  .catch(() => {
                    setGuideError(true);
                  });
              }}
            >
              Setup guide
            </Button>
          </Card>
        ))}
      </div>

      {guideError ? <ErrorNotice title="That setup guide could not be loaded." /> : null}
      {guide === null ? null : (
        <Card className="flex flex-col gap-2">
          <SectionHeading
            actions={
              <Button
                tone="ghost"
                onClick={() => {
                  setGuide(null);
                }}
              >
                Close
              </Button>
            }
          >
            <UntrustedText value={guide.title} />
          </SectionHeading>
          {/* A provider's own guide text: paragraphs and code fences, never HTML (BD-022). */}
          <UntrustedProse value={guide.markdown} />
        </Card>
      )}
    </div>
  );
};
