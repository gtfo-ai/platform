/**
 * The visibility reader a route test composes when visibility is not its subject (BD-035): every
 * project is visible, so the guard behaves as it did before visibility existed. A test **about**
 * visibility passes its own narrowed reader instead.
 */
import { EVERY_PROJECT, type VisibleProjectsReader } from './visibility.js';

export const everyProjectVisible: VisibleProjectsReader = async () => EVERY_PROJECT;

/** A reader that sees exactly `ids` for every caller. */
export const onlyProjectsVisible =
  (...ids: readonly string[]): VisibleProjectsReader =>
  async () => ({ all: false, ids: new Set(ids) });
