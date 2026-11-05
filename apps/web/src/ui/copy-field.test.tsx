/** CopyField and DetailsDisclosure. */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CopyField } from './copy-field.js';
import { DetailsDisclosure } from './details.js';

afterEach(() => {
  cleanup();
});

describe('CopyField', () => {
  it('shows the value in a labelled read-only field and copies it from a named button', async () => {
    const writeText = vi.fn(async () => undefined);
    render(
      <CopyField
        label="Webhook URL"
        value="https://agentic.example.test/hook"
        writeText={writeText}
      />,
    );
    const field = screen.getByLabelText('Webhook URL');
    expect((field as HTMLInputElement).value).toBe('https://agentic.example.test/hook');
    expect(field.hasAttribute('readonly')).toBe(true);

    await userEvent.setup().click(screen.getByRole('button', { name: 'Copy Webhook URL' }));
    expect(writeText).toHaveBeenCalledWith('https://agentic.example.test/hook');
    expect((await screen.findByRole('status')).textContent).toBe('Copied.');
  });

  it('says what to do when the clipboard refuses', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('denied');
    });
    render(<CopyField label="Branch" value="agentic/proj-12" writeText={writeText} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Copy Branch' }));
    expect(await screen.findByText(/select the text and copy it by hand/)).toBeTruthy();
  });
});

describe('DetailsDisclosure', () => {
  it('is a native disclosure, closed by default, opened by its summary', async () => {
    const { container } = render(
      <DetailsDisclosure summary="Raw ids">
        <code>run 0000-1</code>
      </DetailsDisclosure>,
    );
    const details = container.querySelector('details');
    expect(details?.open).toBe(false);
    await userEvent.setup().click(screen.getByText('Raw ids'));
    expect(details?.open).toBe(true);
  });

  it('can start open', () => {
    const { container } = render(
      <DetailsDisclosure summary="JSON" defaultOpen>
        <code>{'{}'}</code>
      </DetailsDisclosure>,
    );
    expect(container.querySelector('details')?.open).toBe(true);
  });
});
