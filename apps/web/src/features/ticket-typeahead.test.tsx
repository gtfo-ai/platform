/**
 * The *Start a ticket* typeahead (`TicketKeyField` inside `StartTicketForm`, in the dialog the
 * board opens): the combobox pattern, the debounce, Enter that picks only an active option and
 * otherwise starts the typed key as before, Escape that closes the list before the dialog, the
 * quiet note when the tracker cannot be searched, and the tracker's text rendered as text.
 *
 * Rendered with the real query client and the form's real hooks over a stubbed `Endpoints`, inside
 * the board's `Dialog`, as `StartTicketDialog` renders it.
 */
import type { TicketSearchItem } from '@platform/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../api/http.js';
import { type Services, ServicesProvider } from '../app/services.js';
import { Dialog } from '../ui/dialog.js';
import { StartTicketForm } from './board.js';
import { startableWords } from './ticket-typeahead.js';

const PROJECT = '00000000-0000-4000-8000-0000000000f1';

const item = (
  key: string,
  title: string,
  status: string,
  startable: boolean,
): TicketSearchItem => ({
  ref: { provider: 'jira-cloud', key, url: `https://acme-example.atlassian.net/browse/${key}` },
  title,
  status,
  status_category: startable ? 'todo' : 'done',
  startable,
});

const SUGGESTIONS = [
  item('ACME-12', 'Invoice PDF layout', 'To pick up', true),
  item('ACME-120', '<img src=x onerror=alert(1)> totals', 'Done', false),
];

interface World {
  searched: string[];
  started: string[];
  answer: () => Promise<{ items: readonly TicketSearchItem[] }>;
}

const renderDialog = (world: World) => {
  const endpoints = {
    ticketSearch: async (_projectId: string, query: string) => {
      world.searched.push(query);
      return world.answer();
    },
    startTask: async (_projectId: string, body: { ticket_key: string }) => {
      world.started.push(body.ticket_key);
      return {
        performed: true,
        event_id: '00000000-0000-4000-8000-0000000000f2',
        ticket: {
          provider: 'jira-cloud',
          key: body.ticket_key,
          url: `https://acme-example.atlassian.net/browse/${body.ticket_key}`,
        },
      };
    },
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Harness = () => {
    const [open, setOpen] = useState(true);
    const field = useRef<HTMLInputElement>(null);
    return (
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Start a ticket"
        description="Start a task for a ticket by its key."
        initialFocus={field}
      >
        <StartTicketForm projectId={PROJECT} inputRef={field} />
      </Dialog>
    );
  };
  render(
    <QueryClientProvider client={queryClient}>
      <ServicesProvider services={{ endpoints } as unknown as Services}>
        <Harness />
      </ServicesProvider>
    </QueryClientProvider>,
  );
};

const newWorld = (): World => ({
  searched: [],
  started: [],
  answer: async () => ({ items: SUGGESTIONS }),
});

const field = async () =>
  within(await screen.findByRole('dialog', { name: 'Start a ticket' })).getByRole('combobox', {
    name: 'Ticket key',
  });

afterEach(cleanup);

describe('the Start a ticket typeahead', () => {
  it('is a combobox that asks once, debounced, and lists key, summary and status as text', async () => {
    const world = newWorld();
    renderDialog(world);
    const user = userEvent.setup();
    const input = await field();
    expect(input.getAttribute('aria-autocomplete')).toBe('list');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    await user.type(input, 'acme-12');
    const list = await screen.findByRole('listbox', { name: 'Suggested tickets' });
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-controls')).toBe(list.id);
    // One request for the settled query, none per keystroke.
    expect(world.searched).toEqual(['acme-12']);
    const options = within(list).getAllByRole('option');
    expect(options.map((option) => option.getAttribute('data-ticket-option'))).toEqual([
      'ACME-12',
      'ACME-120',
    ]);
    expect(options[0]?.textContent).toContain('Invoice PDF layout');
    expect(options[0]?.textContent).toContain('To pick up');
    expect(options[0]?.textContent).toContain(startableWords({ startable: true }));
    expect(options[1]?.textContent).toContain(startableWords({ startable: false }));
    // BD-022: the tracker's markup is text, never an element.
    expect(options[1]?.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(list.querySelector('img')).toBeNull();
  });

  it('asks nothing below two characters', async () => {
    const world = newWorld();
    renderDialog(world);
    const user = userEvent.setup();
    await user.type(await field(), 'a');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(world.searched).toEqual([]);
  });

  it('moves with the arrows, picks with Enter (filling the key, starting nothing), then Enter starts it', async () => {
    const world = newWorld();
    renderDialog(world);
    const user = userEvent.setup();
    const input = (await field()) as HTMLInputElement;
    await user.type(input, 'invoice');
    await screen.findByRole('listbox', { name: 'Suggested tickets' });
    await user.keyboard('{ArrowDown}{ArrowDown}');
    const active = input.getAttribute('aria-activedescendant');
    expect(active).not.toBeNull();
    expect(document.getElementById(active ?? '')?.getAttribute('data-ticket-option')).toBe(
      'ACME-120',
    );
    await user.keyboard('{ArrowUp}{Enter}');
    expect(input.value).toBe('ACME-12');
    expect(world.started).toEqual([]);
    expect(input.getAttribute('aria-expanded')).toBe('false');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(world.started).toEqual(['ACME-12']));
  });

  it('starts a typed key with Enter as before when no option is active', async () => {
    const world = newWorld();
    renderDialog(world);
    const user = userEvent.setup();
    const input = await field();
    await user.type(input, 'ACME-77');
    await screen.findByRole('listbox', { name: 'Suggested tickets' });
    await user.keyboard('{Enter}');
    await waitFor(() => expect(world.started).toEqual(['ACME-77']));
  });

  it('picks an option with the pointer', async () => {
    const world = newWorld();
    renderDialog(world);
    const user = userEvent.setup();
    const input = (await field()) as HTMLInputElement;
    await user.type(input, 'invoice');
    const list = await screen.findByRole('listbox', { name: 'Suggested tickets' });
    await user.click(within(list).getAllByRole('option')[1] as HTMLElement);
    expect(input.value).toBe('ACME-120');
    expect(world.started).toEqual([]);
  });

  it('closes the list on the first Escape and the dialog on the second', async () => {
    const world = newWorld();
    renderDialog(world);
    const user = userEvent.setup();
    const input = await field();
    await user.type(input, 'invoice');
    await screen.findByRole('listbox', { name: 'Suggested tickets' });
    await user.keyboard('{Escape}');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('dialog', { name: 'Start a ticket' })).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows a quiet note when the tracker cannot be searched, and the key still starts', async () => {
    const world = newWorld();
    world.answer = async () => {
      throw new ApiError(
        503,
        'ticket_search_unavailable',
        'the tracker did not answer within 5000 ms; type the full key',
      );
    };
    renderDialog(world);
    const user = userEvent.setup();
    const input = await field();
    await user.type(input, 'ACME-5');
    await screen.findByText('No suggestions from the tracker right now — type the full key.');
    expect(screen.queryByRole('listbox', { name: 'Suggested tickets' })).toBeNull();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(world.started).toEqual(['ACME-5']));
  });
});
