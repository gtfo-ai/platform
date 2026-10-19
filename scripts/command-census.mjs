#!/usr/bin/env node
/**
 * `DATABASE_URL=… node scripts/command-census.mjs [--since <ISO date>] [--cap <rows>]` — the
 * recorded-command census (WP-225, Q122 (a)). It reads the Bash lines a database's runs wrote, in
 * one read-only transaction, and prints **counts only**: the three corpus cells, the uncertainty
 * reasons by name and the tier-3 classes. It never prints or writes a command line. The reading,
 * the classes and what each misses are `scripts/command-census.ts`'s docblock.
 *
 * `--since` defaults to thirty days ago and `--cap` (assistant rows read) to 100 000. The last line
 * is `PASS: command-census`, or `FAIL: command-census — <what>` with exit 1. A failure names the
 * error's code or class and never its message, which a server may build from row data.
 */
import process from 'node:process';
import { isProgram } from './is-program.mjs';
import './ts-source-resolver.mjs';

if (isProgram(import.meta.url)) {
  const fail = (what) => {
    process.stdout.write(`FAIL: command-census — ${what}\n`);
    process.exit(1);
  };
  const {
    censusCounts,
    formatCensus,
    parseCensusArguments,
    readRecordedCalls,
    withReadOnlySession,
  } = await import('./command-census.ts');
  const parsed = parseCensusArguments(process.argv.slice(2));
  if (typeof parsed === 'string') fail(parsed);
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === '') fail('DATABASE_URL is not set');
  try {
    const read = await withReadOnlySession(url, (client) =>
      readRecordedCalls(client, parsed.since, parsed.cap),
    );
    process.stdout.write(formatCensus(read, censusCounts(read.calls), parsed));
    process.stdout.write('PASS: command-census\n');
  } catch (error) {
    fail(`${error?.code ?? error?.name ?? 'error'} (message withheld: it may quote row data)`);
  }
}
