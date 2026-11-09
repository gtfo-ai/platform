/**
 * The record values S-25.20 took off the screens (`./records.ts`): each map names every value of
 * its contract enum — read off the schema, so a value added there and not here fails — and no label
 * is the code word it replaces.
 */
import {
  askAnswerCitationSchema,
  identityKindSchema,
  runCommandRecordSchema,
  runModeSchema,
  ticketBreakdownItemSchema,
} from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import {
  ASK_CITATION_KIND_LABEL,
  BREAKDOWN_ITEM_STATUS_LABEL,
  IDENTITY_KIND_LABEL,
  PROMPT_FILE_STATUS_LABEL,
  RUN_COMMAND_STATE_LABEL,
  RUN_MODE_LABEL,
} from './records.js';

/** The prompt file statuses — an inline enum of the effective-config read, so named here. */
const promptStatuses = ['file', 'not_a_file', 'oversized'] as const;

const TABLES: readonly [string, Readonly<Record<string, string>>, readonly string[]][] = [
  ['a run’s mode', RUN_MODE_LABEL, runModeSchema.options],
  ['a run command’s state', RUN_COMMAND_STATE_LABEL, runCommandRecordSchema.shape.state.options],
  ['a prompt file’s reading', PROMPT_FILE_STATUS_LABEL, promptStatuses],
  [
    'a proposed child ticket',
    BREAKDOWN_ITEM_STATUS_LABEL,
    ticketBreakdownItemSchema.shape.status.options,
  ],
  ['a linked account’s kind', IDENTITY_KIND_LABEL, identityKindSchema.options],
  ['an ask’s citation', ASK_CITATION_KIND_LABEL, askAnswerCitationSchema.shape.kind.options],
];

describe('the record values’ words (S-25.20)', () => {
  it.each(TABLES)('names every value of %s, and none raw', (_name, table, values) => {
    expect(Object.keys(table).sort()).toEqual([...values].sort());
    for (const value of values) {
      const label = table[value] ?? '';
      expect(label).not.toBe(value);
      expect(label).not.toMatch(/_/);
      expect(label.charAt(0)).toBe(label.charAt(0).toUpperCase());
    }
  });
});
