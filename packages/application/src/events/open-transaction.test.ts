/**
 * The refusal, from both sides.
 *
 * A guard is written on the happy path and reviewed on the happy path, so its refusal is the part
 * nobody executes (standing rules 3 and 67 — four fail-open guards shipped in this repository
 * before anyone mutated one). So every assertion below has a twin: the call is refused *inside* a
 * transaction **and** performed outside one, and the refusal is named rather than observed as a
 * timeout.
 */
import { describe, expect, it } from 'vitest';
import { MemoryEventing } from '../testing/memory-eventing.js';
import {
  assertOutsideTransaction,
  markTransactions,
  TransactionOpenError,
  transactionIsOpen,
  withOpenTransaction,
} from './open-transaction.js';

describe('a transaction on this call path', () => {
  it('is not open until something opens one', () => {
    expect(transactionIsOpen()).toBe(false);
    expect(() => {
      assertOutsideTransaction('a provider call');
    }).not.toThrow();
  });

  it('is open inside withOpenTransaction, and closed again after it', async () => {
    const inside = await withOpenTransaction(async () => transactionIsOpen());
    expect(inside).toBe(true);
    expect(transactionIsOpen()).toBe(false);
  });

  it('refuses by name, saying what was attempted and where the call belongs', async () => {
    const thrown = await withOpenTransaction(async () => {
      try {
        assertOutsideTransaction('integrations.forProject');
        return null;
      } catch (error) {
        return error;
      }
    });
    expect(thrown).toBeInstanceOf(TransactionOpenError);
    expect((thrown as TransactionOpenError).attempted).toBe('integrations.forProject');
    // The message has to be usable at 03:00 by somebody who has never read this file.
    expect((thrown as Error).message).toContain('afterCommit');
    expect((thrown as Error).message).toContain('outbound.ts');
  });

  it('survives the awaits between the transaction and the call', async () => {
    // The mechanism is `AsyncLocalStorage`, so the thing worth asserting is depth: a provider call
    // is never made by the function that opened the transaction, it is made four layers down.
    const deep = async (depth: number): Promise<boolean> => {
      await Promise.resolve();
      if (depth === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return transactionIsOpen();
      }
      return deep(depth - 1);
    };
    expect(await withOpenTransaction(async () => deep(4))).toBe(true);
    expect(await deep(4)).toBe(false);
  });

  it('is not marked by work the caller detached from the transaction', async () => {
    // Stated because it is the mechanism's one hole, and the direction matters: a detached call is
    // *not* refused, so the guard can miss one — it can never refuse one that is safe.
    let detached: Promise<boolean> | null = null;
    await withOpenTransaction(async () => {
      detached = new Promise((resolve) => {
        setTimeout(() => {
          resolve(transactionIsOpen());
        }, 1);
      });
    });
    expect(await (detached as unknown as Promise<boolean>)).toBe(true);
  });
});

describe('markTransactions', () => {
  it('marks a unit of work’s transaction, and hands back what it returned', async () => {
    const marked = markTransactions(new MemoryEventing());
    const seen = await marked.transaction(async () => transactionIsOpen());
    expect(seen).toBe(true);
    expect(transactionIsOpen()).toBe(false);
  });

  it('leaves the mark behind when the transaction throws', async () => {
    const marked = markTransactions(new MemoryEventing());
    await expect(
      marked.transaction(async () => {
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect(transactionIsOpen()).toBe(false);
  });

  it('is what stops a job from calling a provider inside its own transaction', async () => {
    // The job path already had the right shape; this is what keeps it. Without the decorator the
    // call below is simply performed, which is the mutation this test dies on.
    const marked = markTransactions(new MemoryEventing());
    await expect(
      marked.transaction(async () => {
        assertOutsideTransaction('the provider read "get_default_branch_head"');
      }),
    ).rejects.toBeInstanceOf(TransactionOpenError);
  });
});
