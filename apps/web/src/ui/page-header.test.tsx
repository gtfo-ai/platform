/** PageHeader (TD-033 § 1): the page's one `<h1>`, with its back, state, meta and action slots. */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Button } from './button.js';
import { PageHeader } from './page-header.js';
import { StateLabel } from './status.js';

afterEach(() => {
  cleanup();
});

describe('PageHeader', () => {
  it('renders the title as the page heading with its slots', () => {
    const { container } = render(
      <PageHeader
        back={<span>All tasks</span>}
        title="PROJ-12 Retry the flaky upload"
        state={<StateLabel status="running" />}
        meta={<span>3 runs</span>}
        actions={<Button tone="primary">Cancel run</Button>}
      />,
    );
    expect(
      screen.getByRole('heading', { level: 1, name: 'PROJ-12 Retry the flaky upload' }),
    ).toBeTruthy();
    expect(screen.getByText('All tasks')).toBeTruthy();
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.getByText('3 runs')).toBeTruthy();
    expect(
      container
        .querySelector('[data-page-actions]')
        ?.contains(screen.getByRole('button', { name: 'Cancel run' })),
    ).toBe(true);
  });

  it('draws no empty slots', () => {
    const { container } = render(<PageHeader title="Agents" />);
    expect(container.querySelector('[data-page-actions]')).toBeNull();
    expect(container.textContent).toBe('Agents');
  });

  it('renders the title as text, not a heading, when the page below owns the h1 (S-23.4)', () => {
    const { container } = render(<PageHeader title="ACME" titleAs="p" divider={false} />);
    expect(screen.queryByRole('heading')).toBeNull();
    expect(container.querySelector('p')?.textContent).toBe('ACME');
    expect((container.firstChild as HTMLElement).className).not.toContain('border-b');
  });
});
