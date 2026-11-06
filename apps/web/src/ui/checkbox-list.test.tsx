/** CheckboxList (S-25.10): a multiple choice as checkboxes, with a count and an enforced maximum. */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CheckboxList, type CheckboxListOption, toggledValue } from './checkbox-list.js';

afterEach(() => {
  cleanup();
});

const OPTIONS: readonly CheckboxListOption[] = [
  { value: 'Sent back', label: 'Sent back (to do)' },
  { value: 'Testing', label: 'Testing (in progress)' },
  { value: 'Doing', label: 'Doing (in progress)' },
];

/** A controlled list, as a screen holds it, reporting every change. */
const Harness = ({
  initial = [],
  max,
  onChange,
}: {
  readonly initial?: readonly string[];
  readonly max?: number;
  readonly onChange: (next: readonly string[]) => void;
}) => {
  const [value, setValue] = useState<readonly string[]>(initial);
  return (
    <CheckboxList
      legend="Returned"
      options={OPTIONS}
      value={value}
      hint="Where a ticket goes when it is sent back."
      {...(max === undefined ? {} : { max })}
      onChange={(next) => {
        onChange(next);
        setValue(next);
      }}
    />
  );
};

describe('CheckboxList', () => {
  it('is a named group of checkboxes, never a multi-select, described by its count and hint', () => {
    render(<Harness onChange={vi.fn()} />);
    const group = screen.getByRole('group', { name: 'Returned' });
    expect(group.tagName).toBe('FIELDSET');
    expect(within(group).queryByRole('listbox')).toBeNull();
    expect(
      within(group)
        .getAllByRole('checkbox')
        .map((box) => box.getAttribute('value')),
    ).toEqual(['Sent back', 'Testing', 'Doing']);
    expect(within(group).getByRole('checkbox', { name: 'Testing (in progress)' })).toBeTruthy();
    const described = (group.getAttribute('aria-describedby') ?? '').split(' ');
    expect(described.map((id) => document.getElementById(id)?.textContent)).toEqual([
      '0 selected',
      'Where a ticket goes when it is sent back.',
    ]);
  });

  it('adds a value with one press — no modifier key — and counts it', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox', { name: 'Doing (in progress)' }));
    await user.click(screen.getByRole('checkbox', { name: 'Sent back (to do)' }));
    // The options' order, as a native select's `selectedOptions` was.
    expect(onChange).toHaveBeenLastCalledWith(['Sent back', 'Doing']);
    expect(screen.getByText('2 selected')).toBeTruthy();
    await user.click(screen.getByRole('checkbox', { name: 'Doing (in progress)' }));
    expect(onChange).toHaveBeenLastCalledWith(['Sent back']);
    expect(screen.getByText('1 selected')).toBeTruthy();
  });

  it('is used from the keyboard: Tab to a box, Space to check it', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole('checkbox', { name: 'Sent back (to do)' }),
    );
    await user.keyboard(' ');
    await user.tab();
    await user.keyboard(' ');
    expect(onChange).toHaveBeenLastCalledWith(['Sent back', 'Testing']);
  });

  it('refuses one more than the maximum with a message, and lets a press clear one', async () => {
    const onChange = vi.fn();
    render(<Harness initial={['Sent back', 'Testing']} max={2} onChange={onChange} />);
    const user = userEvent.setup();
    expect(screen.getByText('2 selected of at most 2')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    const doing = screen.getByRole('checkbox', { name: 'Doing (in progress)' }) as HTMLInputElement;
    // Never disabled at the limit: it stays in the tab order, and the press says why.
    expect(doing.disabled).toBe(false);
    await user.click(doing);
    expect(doing.checked).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe(
      'At most 2 can be selected. Clear one to select another.',
    );
    await user.click(screen.getByRole('checkbox', { name: 'Testing (in progress)' }));
    expect(onChange).toHaveBeenLastCalledWith(['Sent back']);
    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(doing);
    expect(onChange).toHaveBeenLastCalledWith(['Sent back', 'Doing']);
  });

  it('says so when the list it is given is already over the maximum', () => {
    render(<Harness initial={['Sent back', 'Testing', 'Doing']} max={2} onChange={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toMatch(/^At most 2 can be selected/);
  });

  it('draws its list on the field ground inside the input edge, as every field is', () => {
    render(<CheckboxList legend="Returned" options={OPTIONS} value={[]} onChange={vi.fn()} />);
    const list = screen.getAllByRole('checkbox')[0]?.closest('label')?.parentElement as HTMLElement;
    expect(list.className.split(' ')).toEqual(
      expect.arrayContaining(['bg-inset', 'border', 'border-line-input', 'rounded-md']),
    );
    expect(list.className.split(' ')).not.toContain('bg-default');
  });

  it('marks every box aria-invalid when refused, and none otherwise', () => {
    render(
      <CheckboxList legend="Returned" options={OPTIONS} value={[]} onChange={vi.fn()} invalid />,
    );
    for (const box of screen.getAllByRole('checkbox')) {
      expect(box.getAttribute('aria-invalid')).toBe('true');
    }
    // A group may not carry the attribute.
    expect(screen.getByRole('group').hasAttribute('aria-invalid')).toBe(false);
    cleanup();
    render(<CheckboxList legend="Returned" options={OPTIONS} value={[]} onChange={vi.fn()} />);
    for (const box of screen.getAllByRole('checkbox')) {
      expect(box.hasAttribute('aria-invalid')).toBe(false);
    }
  });
});

describe('toggledValue', () => {
  it('keeps the options’ order and a value the options do not list, in front', () => {
    expect(toggledValue(OPTIONS, ['Gone', 'Doing'], 'Sent back', true)).toEqual([
      'Gone',
      'Sent back',
      'Doing',
    ]);
    expect(toggledValue(OPTIONS, ['Gone', 'Doing'], 'Doing', false)).toEqual(['Gone']);
  });
});
