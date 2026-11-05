/** Flash: four tones, each with its own icon; danger announced, the others only on request. */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Button } from './button.js';
import { Flash, type FlashTone } from './flash.js';

afterEach(() => {
  cleanup();
});

describe('Flash', () => {
  it('announces danger as an alert, with its title, body and action', () => {
    render(
      <Flash tone="danger" title="The run could not start." action={<Button>Retry</Button>}>
        The launcher refused the workspace.
      </Flash>,
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('The run could not start.');
    expect(alert.textContent).toContain('The launcher refused the workspace.');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('does not announce info, warning or success unless asked', () => {
    render(
      <>
        <Flash tone="info">i</Flash>
        <Flash tone="warning">w</Flash>
        <Flash tone="success" live="status">
          s
        </Flash>
      </>,
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('s');
  });

  it.each(['info', 'warning', 'danger', 'success'] as FlashTone[])(
    'draws %s with a hidden icon, so the tone is never colour alone',
    (tone) => {
      const { container } = render(<Flash tone={tone} title="t" />);
      const box = container.querySelector(`[data-flash="${tone}"]`);
      expect(box?.querySelector('[aria-hidden="true"] svg')).not.toBeNull();
    },
  );

  it('gives each tone a different icon', () => {
    const { container } = render(
      <div>
        {(['info', 'warning', 'danger', 'success'] as const).map((tone) => (
          <Flash key={tone} tone={tone} title={tone} />
        ))}
      </div>,
    );
    const paths = [...container.querySelectorAll('[data-flash] svg path')].map((path) =>
      path.getAttribute('d'),
    );
    expect(new Set(paths).size).toBe(4);
  });
});
