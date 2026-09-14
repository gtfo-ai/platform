/**
 * The package-registry metadata client (WP-38, Q84).
 *
 * One read-only HTTP client, no credential, no binding, and a host allow-list an operator declares
 * (`APP_DEPENDENCY_REGISTRY_HOSTS`, empty by default). `registry-metadata.ts` carries the reasoning,
 * including why this is the one outbound call the pipeline makes that does **not** go through
 * `IntegrationActionExecutor`.
 */
export * from './registry-metadata.js';
