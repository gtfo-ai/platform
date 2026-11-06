/** Select (S-25.10): the native element, drawn in the brand. */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Select } from './select.js';

afterEach(() => {
  cleanup();
});

const renderRange = (props: Partial<Parameters<typeof Select>[0]> = {}) => {
  const onChange = vi.fn();
  render(
    <label>
      Range
      <Select value="7d" onChange={(event) => onChange(event.target.value)} {...props}>
        <option value="7d">Last 7 days</option>
        <option value="30d">Last 30 days</option>
      </Select>
    </label>,
  );
  return { onChange, field: screen.getByRole('combobox', { name: 'Range' }) as HTMLSelectElement };
};

describe('Select', () => {
  it('is the native select: a combobox named by its label, its options the browser’s', async () => {
    const { onChange, field } = renderRange();
    expect(field.tagName).toBe('SELECT');
    expect(field.multiple).toBe(false);
    expect(Array.from(field.options, (option) => option.textContent)).toEqual([
      'Last 7 days',
      'Last 30 days',
    ]);
    await userEvent.setup().selectOptions(field, '30d');
    expect(onChange).toHaveBeenCalledWith('30d');
  });

  it('draws the brand box: no OS arrow, the field ground, the input edge and the focus ring', () => {
    const { field } = renderRange();
    const classes = field.className.split(' ');
    expect(classes).toEqual(
      expect.arrayContaining([
        'appearance-none',
        'bg-inset',
        'border',
        'border-line-input',
        'rounded-md',
        'focus-visible:outline-focus',
      ]),
    );
    // One field ground in a form (the review of #85): never the card's, beside an inset `Field`.
    expect(classes).not.toContain('bg-default');
    // Never the divider, and no inline style (the production policy is `style-src 'self'`).
    expect(classes).not.toContain('border-line');
    expect(field.hasAttribute('style')).toBe(false);
    expect(field.closest('[data-select]')?.hasAttribute('style')).toBe(false);
  });

  it('puts an Octicon chevron over the field that a press passes through, hidden from assistive tech', () => {
    const { field } = renderRange();
    const wrapper = field.closest('[data-select]') as HTMLElement;
    const chevron = wrapper.querySelector('[data-select-chevron]') as HTMLElement;
    expect(chevron.getAttribute('aria-hidden')).toBe('true');
    expect(chevron.className).toContain('pointer-events-none');
    expect(chevron.querySelector('svg')).not.toBeNull();
    // The field leaves room for it.
    expect(field.className.split(' ')).toContain('pr-8');
  });

  it('gives the wrapper the caller’s layout classes, not the field', () => {
    const { field } = renderRange({ className: 'max-w-56 self-start' });
    const wrapper = field.closest('[data-select]') as HTMLElement;
    expect(wrapper.className.split(' ')).toEqual(
      expect.arrayContaining(['max-w-56', 'self-start']),
    );
    expect(field.className).not.toContain('max-w-56');
  });

  it('marks a refused value with the danger edge, and says nothing when it is not refused', () => {
    const { field } = renderRange({ invalid: true });
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.className.split(' ')).toContain('border-danger');
    expect(field.className.split(' ')).not.toContain('border-line-input');
    cleanup();
    const plain = renderRange().field;
    expect(plain.hasAttribute('aria-invalid')).toBe(false);
  });

  it('sizes a toolbar filter smaller than a form field', () => {
    expect(renderRange({ controlSize: 'sm' }).field.className.split(' ')).toContain('h-7');
    cleanup();
    expect(renderRange().field.className.split(' ')).toContain('h-8');
  });

  it('keeps the keyboard the browser’s: it takes the focus from Tab', async () => {
    const { field } = renderRange();
    await userEvent.setup().tab();
    expect(document.activeElement).toBe(field);
  });
});
