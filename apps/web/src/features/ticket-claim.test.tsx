/**
 * The claim and the QA stage on the task page (WP-182 ruling (c)): each of the claim's three states
 * — confirmed, shadow, released — and the QA stage, as the task DTO publishes them (WP-181).
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { claimStateOf, TicketClaimAndQa } from './ticket-claim.js';

const CLAIMED_AT = '2026-10-08T09:15:00.000Z';
const RELEASED_AT = '2026-10-08T11:30:00.000Z';

afterEach(() => {
  cleanup();
});

const rendered = (): string | null =>
  document.querySelector('[data-ticket-claim]')?.getAttribute('data-ticket-claim') ?? null;

describe('the claim and the QA stage on the task page (WP-182 ruling (c))', () => {
  it('shows a confirmed claim', () => {
    render(
      <TicketClaimAndQa
        task={{
          ticket_claim: { status: 'confirmed', claimed_at: CLAIMED_AT, released_at: null },
          qa_stage: false,
        }}
      />,
    );
    expect(rendered()).toBe('confirmed');
    expect(screen.getByText('ticket claimed')).toBeTruthy();
    expect(screen.getByText(/confirmed on the tracker/)).toBeTruthy();
    expect(document.querySelector('[data-qa-stage]')).toBeNull();
  });

  it('shows a shadow claim as one that assigned nothing', () => {
    render(
      <TicketClaimAndQa
        task={{
          ticket_claim: { status: 'shadow', claimed_at: CLAIMED_AT, released_at: null },
          qa_stage: false,
        }}
      />,
    );
    expect(rendered()).toBe('shadow');
    expect(screen.getByText('claim (shadow)')).toBeTruthy();
    expect(screen.getByText(/assigned nothing/)).toBeTruthy();
  });

  it('shows a released claim, whichever it was before', () => {
    render(
      <TicketClaimAndQa
        task={{
          ticket_claim: { status: 'confirmed', claimed_at: CLAIMED_AT, released_at: RELEASED_AT },
          qa_stage: true,
        }}
      />,
    );
    expect(rendered()).toBe('released');
    expect(screen.getByText('claim released')).toBeTruthy();
    expect(screen.getByText(/given back/)).toBeTruthy();
    expect(
      claimStateOf({ status: 'shadow', claimed_at: CLAIMED_AT, released_at: RELEASED_AT }),
    ).toBe('released');
  });

  it('shows the QA stage, and nothing for a task that never claimed', () => {
    render(<TicketClaimAndQa task={{ ticket_claim: null, qa_stage: true }} />);
    expect(rendered()).toBe('none');
    expect(screen.getByText('QA stage')).toBeTruthy();
    expect(screen.queryByText(/claim/)).toBeNull();
    cleanup();
    render(<TicketClaimAndQa task={{ ticket_claim: null, qa_stage: false }} />);
    expect(rendered()).toBeNull();
  });
});
