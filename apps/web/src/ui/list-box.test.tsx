/** ListBox, ListBoxHeader and ListRow (TD-033 § 1): a named list of rows under a header row. */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ListBox, ListBoxHeader, ListRow } from './list-box.js';
import { StatusIcon } from './status.js';

afterEach(() => {
  cleanup();
});

describe('ListBox', () => {
  it('is a named list whose rows carry status, title, meta, facts and actions', () => {
    render(
      <ListBox
        label="Runs"
        header={<ListBoxHeader actions={<span>Sort</span>}>2 runs</ListBoxHeader>}
      >
        <ListRow
          leading={<StatusIcon status="running" />}
          title="Implementation"
          meta="started 2m ago"
          trailing="$0.42"
          actions={<button type="button">More</button>}
        />
        <ListRow leading={<StatusIcon status="success" />} title="Refinement" />
      </ListBox>,
    );
    const list = screen.getByRole('list', { name: 'Runs' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    const [first] = rows;
    if (first === undefined) {
      throw new Error('no first row');
    }
    expect(within(first).getByRole('img', { name: 'Running' })).toBeTruthy();
    expect(within(first).getByText('Implementation')).toBeTruthy();
    expect(within(first).getByText('started 2m ago')).toBeTruthy();
    expect(within(first).getByText('$0.42')).toBeTruthy();
    expect(within(first).getByRole('button', { name: 'More' })).toBeTruthy();
    expect(screen.getByText('2 runs')).toBeTruthy();
    expect(screen.getByText('Sort')).toBeTruthy();
    // The header is outside the list, so it is not counted as a row.
    expect(list.contains(screen.getByText('2 runs'))).toBe(false);
  });
});
