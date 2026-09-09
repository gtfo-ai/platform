import { describe, expect, it } from 'vitest';
import { stabiliseDefs } from './json-schema-defs.js';

const nullableRefTo = (target: string) => ({
  anyOf: [{ $ref: `#/$defs/${target}` }, { type: 'null' }],
});

describe('stabiliseDefs', () => {
  it('returns a document without $defs untouched', () => {
    const document = { type: 'object', properties: { a: { type: 'string' } } };
    expect(stabiliseDefs(document)).toBe(document);
  });

  it('leaves named definitions and their references alone, but sorts the block', () => {
    const result = stabiliseDefs({
      $ref: '#/$defs/Id',
      $defs: { Slug: { type: 'string' }, Id: { type: 'string', format: 'uuid' } },
    });
    expect(Object.keys(result.$defs as object)).toEqual(['Id', 'Slug']);
    expect(result.$ref).toBe('#/$defs/Id');
  });

  it('names an anonymous definition after its content and rewrites the references', () => {
    const result = stabiliseDefs({
      properties: { a: { $ref: '#/$defs/__schema0' } },
      $defs: { Id: { type: 'string' }, __schema0: nullableRefTo('Id') },
    });
    const [name] = Object.keys(result.$defs as object).filter((key) => key.startsWith('anon_'));
    expect(name).toMatch(/^anon_[0-9a-f]{8}$/);
    expect(result.properties).toEqual({ a: { $ref: `#/$defs/${name}` } });
    expect(JSON.stringify(result)).not.toContain('__schema');
  });

  it('collapses structurally identical anonymous definitions onto one name', () => {
    const result = stabiliseDefs({
      properties: {
        a: { $ref: '#/$defs/__schema0' },
        b: { $ref: '#/$defs/__schema1' },
        c: { $ref: '#/$defs/__schema2' },
      },
      $defs: {
        Id: { type: 'string' },
        __schema0: nullableRefTo('Id'),
        __schema1: nullableRefTo('Id'),
        __schema2: nullableRefTo('Id'),
      },
    });
    const anonymous = Object.keys(result.$defs as object).filter((key) => key.startsWith('anon_'));
    expect(anonymous).toHaveLength(1);
    const properties = result.properties as Record<string, { $ref: string }>;
    expect(new Set(Object.values(properties).map((ref) => ref.$ref)).size).toBe(1);
  });

  it('is independent of the order zod happened to number the definitions in', () => {
    const names = (defs: Record<string, unknown>) =>
      Object.keys(stabiliseDefs({ $defs: defs }).$defs as object);
    expect(names({ __schema0: { type: 'boolean' }, __schema1: { type: 'string' } })).toEqual(
      names({ __schema0: { type: 'string' }, __schema1: { type: 'boolean' } }),
    );
  });

  it('throws rather than silently merging two different definitions onto one name', () => {
    // Both wrappers normalise to the same seed — the reference they carry is exactly the part of
    // the content the seed erases — but they are different definitions.
    expect(() =>
      stabiliseDefs({
        $defs: {
          __schema0: { type: 'boolean' },
          __schema1: { type: 'string' },
          __schema2: nullableRefTo('__schema0'),
          __schema3: nullableRefTo('__schema1'),
        },
      }),
    ).toThrow(/would merge two different definitions/);
  });

  it('leaves a reference with no definition behind it exactly as it was', () => {
    const result = stabiliseDefs({
      properties: { a: { $ref: '#/$defs/__schema9' } },
      $defs: { Id: { type: 'string' } },
    });
    expect(result.properties).toEqual({ a: { $ref: '#/$defs/__schema9' } });
  });

  it('still merges two wrappers that reference the same anonymous definition', () => {
    const result = stabiliseDefs({
      $defs: {
        __schema0: { type: 'boolean' },
        __schema1: nullableRefTo('__schema0'),
        __schema2: nullableRefTo('__schema0'),
      },
    });
    expect(Object.keys(result.$defs as object)).toHaveLength(2);
  });
});
