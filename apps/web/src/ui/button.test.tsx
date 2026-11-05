/**
 * Button, IconButton and Counter (TD-033): the tones and sizes as classes on a real `<button>`, a
 * type that never submits by accident, a decorative icon, a trailing count, and an icon button whose
 * whole name is its required `aria-label`.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button, buttonClassName, IconButton } from './button.js';
import { Counter } from './counter.js';
import { Button as KitButton } from './kit.js';

afterEach(() => {
  cleanup();
});

describe('Button', () => {
  it('is type="button" unless the caller says otherwise', () => {
    render(
      <form>
        <Button>Cancel</Button>
        <Button type="submit">Save</Button>
      </form>,
    );
    expect(screen.getByRole('button', { name: 'Cancel' }).getAttribute('type')).toBe('button');
    expect(screen.getByRole('button', { name: 'Save' }).getAttribute('type')).toBe('submit');
  });

  it.each([
    ['primary', 'bg-primary'],
    ['default', 'bg-subtle'],
    ['danger', 'text-danger'],
    ['invisible', 'bg-transparent'],
  ] as const)('draws the %s tone', (tone, marker) => {
    render(<Button tone={tone}>Go</Button>);
    expect(screen.getByRole('button', { name: 'Go' }).className).toContain(marker);
  });

  it('is the beacon only in the primary tone, and danger is an outline rather than a fill', () => {
    expect(buttonClassName('primary')).toContain('text-primary-fg');
    for (const tone of ['default', 'danger', 'invisible'] as const) {
      expect(buttonClassName(tone)).not.toContain('bg-primary');
    }
    expect(buttonClassName('danger')).not.toMatch(/(^| )bg-danger( |$)/);
  });

  it.each([
    ['sm', 'min-h-7'],
    ['md', 'min-h-8'],
  ] as const)('has the %s size', (size, marker) => {
    expect(buttonClassName('default', size)).toContain(marker);
  });

  it('hides its leading icon and reads its trailing count with the label', () => {
    render(
      <Button leadingIcon={<svg data-testid="icon" />} count={12}>
        Issues
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Issues 12' });
    expect(screen.getByTestId('icon').parentElement?.getAttribute('aria-hidden')).toBe('true');
    expect(button.querySelector('[data-counter]')?.textContent).toBe('12');
  });

  it('acts on a click and not when disabled', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <>
        <Button onClick={onClick}>On</Button>
        <Button onClick={onClick} disabled>
          Off
        </Button>
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'On' }));
    await user.click(screen.getByRole('button', { name: 'Off' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('keeps the kit’s `ghost` tone as the new `invisible`', () => {
    render(
      <>
        <KitButton tone="ghost">Ghost</KitButton>
        <Button tone="invisible">Invisible</Button>
      </>,
    );
    expect(screen.getByRole('button', { name: 'Ghost' }).className).toBe(
      screen.getByRole('button', { name: 'Invisible' }).className,
    );
  });
});

describe('IconButton', () => {
  it('is named by its aria-label alone, its icon hidden', () => {
    render(<IconButton aria-label="More actions" icon={<svg data-testid="kebab" />} />);
    const button = screen.getByRole('button', { name: 'More actions' });
    expect(button.getAttribute('type')).toBe('button');
    expect(screen.getByTestId('kebab').parentElement?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('Counter', () => {
  it('formats the count and takes an accessible reading when the number is not enough', () => {
    const { container } = render(
      <>
        <Counter count={1234} />
        <Counter count={3} label="3 open questions" />
      </>,
    );
    expect(screen.getByText('1,234')).toBeTruthy();
    const [, labelled] = [...container.querySelectorAll('[data-counter]')];
    // No `aria-label` on a role-less span: hidden text is read, the bare number is not.
    expect(labelled?.hasAttribute('aria-label')).toBe(false);
    expect(screen.getByText('3 open questions').className).toContain('sr-only');
    expect(screen.getByText('3').getAttribute('aria-hidden')).toBe('true');
  });
});
