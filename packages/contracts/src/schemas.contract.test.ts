/**
 * The published JSON Schemas are a contract with everything outside this repository: the runner's
 * structured-output request, editors validating `.agentic/*.yml`, and any external reader of the
 * event log. This suite checks the committed files still match the zod definitions and that the
 * "unknown keys are errors" rule survives the translation to JSON Schema.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  publishedSchemas,
  renderAllJsonSchemas,
  renderJsonSchema,
  renderJsonSchemaIndex,
  SCHEMA_INDEX_FILE,
} from './schemas.js';

const schemasDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../schemas');

const listCommitted = (dir: string, prefix = ''): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return listCommitted(path.join(dir, entry.name), rel);
    return entry.name.endsWith('.json') ? [rel] : [];
  });

const rendered = renderAllJsonSchemas();

describe('published JSON Schemas', () => {
  it('publishes a document for every artifact type plus the five top-level contracts', () => {
    expect(publishedSchemas.map((document) => document.file)).toEqual([
      'domain-event.schema.json',
      'artifact.schema.json',
      'artifacts/refined-spec.schema.json',
      'artifacts/root-cause-analysis.schema.json',
      'artifacts/implementation-plan.schema.json',
      'artifacts/implementation-notes.schema.json',
      'artifacts/review-verdict.schema.json',
      'artifacts/acceptance-verdict.schema.json',
      'artifacts/retro-report.schema.json',
      'artifacts/librarian-proposals.schema.json',
      'artifacts/shadow-report.schema.json',
      'artifacts/readiness-report.schema.json',
      'artifacts/discovery-draft.schema.json',
      'agentic-config.schema.json',
      'agentic-pipeline.schema.json',
      'transcript-event.schema.json',
    ]);
  });

  it('renders deterministically — the same input twice gives byte-identical output', () => {
    for (const document of publishedSchemas) {
      expect(renderJsonSchema(document)).toBe(renderJsonSchema(document));
    }
  });

  it.each([...rendered.keys()])('has %s committed and up to date', (file) => {
    const committed = readFileSync(path.join(schemasDir, file), 'utf8');
    expect(committed).toBe(rendered.get(file));
  });

  it('has an up-to-date index', () => {
    expect(readFileSync(path.join(schemasDir, SCHEMA_INDEX_FILE), 'utf8')).toBe(
      renderJsonSchemaIndex(),
    );
  });

  it('leaves no orphaned document behind in schemas/', () => {
    const expected = new Set([...rendered.keys(), SCHEMA_INDEX_FILE]);
    expect(listCommitted(schemasDir).filter((file) => !expected.has(file))).toEqual([]);
  });
});

/** Walk every node of a JSON Schema document, yielding `[pointer, node]`. */
function* walk(node: unknown, pointer = '#'): Generator<[string, Record<string, unknown>]> {
  if (Array.isArray(node)) {
    for (const [index, child] of node.entries()) yield* walk(child, `${pointer}/${index}`);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const record = node as Record<string, unknown>;
  yield [pointer, record];
  for (const [key, child] of Object.entries(record)) yield* walk(child, `${pointer}/${key}`);
}

describe('unknown keys are errors, in the generated documents too', () => {
  it.each([...rendered.keys()])('closes every object in %s', (file) => {
    const document = JSON.parse(rendered.get(file) as string) as unknown;
    const open: string[] = [];
    for (const [pointer, node] of walk(document)) {
      if (node.type !== 'object') continue;
      const additional = node.additionalProperties;
      // `false` is a closed object; a schema object is an open map whose values are typed and
      // whose keys are constrained by `propertyNames`. `true` or absent would be neither.
      const closed = additional === false;
      const typedMap = typeof additional === 'object' && additional !== null;
      if (!closed && !typedMap) open.push(pointer);
    }
    expect(open).toEqual([]);
  });

  it.each([...rendered.keys()])('describes the keys of every open map in %s', (file) => {
    const document = JSON.parse(rendered.get(file) as string) as unknown;
    const withoutKeySchema: string[] = [];
    for (const [pointer, node] of walk(document)) {
      if (node.type !== 'object') continue;
      if (typeof node.additionalProperties !== 'object' || node.additionalProperties === null) {
        continue;
      }
      if (node.propertyNames === undefined) withoutKeySchema.push(pointer);
    }
    expect(withoutKeySchema).toEqual([]);
  });

  it('constrains the user-chosen keys of .agentic/config.yml to slugs', () => {
    const config = JSON.parse(rendered.get('agentic-config.schema.json') as string) as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const slugRef = { $ref: '#/$defs/Slug' };
    expect(config.properties?.stages?.propertyNames).toEqual(slugRef);
    expect(config.properties?.status_mapping?.propertyNames).toEqual(slugRef);
    expect(config.$defs?.Slug).toMatchObject({ pattern: '^[a-z][a-z0-9_]*$' });
  });

  it('names every hoisted definition, so a regenerated document stays diffable', () => {
    for (const [file, contents] of rendered) {
      expect(contents, file).not.toContain('__schema');
    }
  });

  it('targets draft 2020-12 and carries a title and description', () => {
    for (const [file, contents] of rendered) {
      const document = JSON.parse(contents) as Record<string, unknown>;
      expect(document.$schema, file).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(document.title, file).toBeTruthy();
      expect(document.description, file).toBeTruthy();
    }
  });
});
