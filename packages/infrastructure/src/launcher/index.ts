/**
 * TD-028's control plane, from the **runner's** side.
 *
 * The wire format (`protocol.ts`) is shared with `apps/launcher`, which implements the server half;
 * `client.ts` is the HTTP adapter and `provisioner.ts` is the `RunWorkspaceProvisioner` a
 * composition root hands to `composeAgentRunner`. Nothing here constructs a Docker client — that is
 * the whole point of the split, and `apps/launcher/src/docker-access.test.ts` enforces it off disk.
 */
export * from './client.js';
export * from './protocol.js';
export * from './provisioner.js';
