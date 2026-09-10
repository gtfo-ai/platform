import { describe, expect, it } from 'vitest';
import * as contracts from './index.js';

/**
 * The barrel is the package's public surface: `apps/*`, the rings and the UI import from here.
 * Dropping an export by accident is a breaking change, so the load-bearing names are pinned.
 */
const PUBLIC_SURFACE = [
  // events
  'domainEventSchema',
  'domainEventTypeSchema',
  'domainEventSchemasByType',
  'DOMAIN_EVENT_TYPES',
  'HANDLER_PRIORITY_BANDS',
  'streamTypeSchema',
  // artifacts
  'artifactSchema',
  'artifactDataSchemas',
  'artifactRefSchema',
  'artifactTypeSchema',
  // repository configuration
  'agenticConfigSchema',
  'pipelineFileSchema',
  'pipelineGraphIssues',
  'stageSchema',
  // runtime
  'transcriptEventSchema',
  'transcriptKindSchema',
  // run shim control frames (TD-025)
  'runletFrameSchema',
  'runletSignalSchema',
  'RUNLET_PROTOCOL_VERSION',
  // api
  'apiErrorSchema',
  'sseFrameSchema',
  'sseTopicSchema',
  // json schema publication
  'publishedSchemas',
  'renderAllJsonSchemas',
  'renderJsonSchemaIndex',
  'SCHEMA_INDEX_FILE',
];

describe('@platform/contracts', () => {
  it('is wired into the workspace', () => {
    expect(contracts.packageId).toBe('@platform/contracts');
  });

  it('exports its whole public surface from the barrel', () => {
    for (const name of PUBLIC_SURFACE) {
      expect(contracts, name).toHaveProperty(name);
    }
  });

  it('exports a schema for every artifact type and every event type', () => {
    expect(Object.keys(contracts.artifactDataSchemas)).toHaveLength(
      contracts.artifactTypeSchema.options.length,
    );
    expect(Object.keys(contracts.domainEventSchemasByType)).toHaveLength(
      contracts.DOMAIN_EVENT_TYPES.length,
    );
  });
});
