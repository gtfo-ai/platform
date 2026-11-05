/**
 * The wordmark: one accessible image with the name it is given, its letters in the surrounding
 * text colour (so it follows its ground) and only its two accents in amber.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Logo } from './logo.js';

afterEach(cleanup);

describe('<Logo />', () => {
  it('is one image named by its label', () => {
    render(<Logo label="Agentic platform" />);
    const mark = screen.getByRole('img', { name: 'Agentic platform' });
    expect(mark.tagName.toLowerCase()).toBe('svg');
    expect(mark.getAttribute('viewBox')).toBe('30 25 755 195');
  });

  it('draws the seven letters in currentColor and the two accents in beacon amber', () => {
    render(<Logo label="Agentic" />);
    const [letters, accents] = [...screen.getByRole('img').querySelectorAll('g')];
    expect(letters?.getAttribute('fill')).toBe('currentColor');
    expect(letters?.querySelectorAll('path')).toHaveLength(7);
    expect(accents?.getAttribute('class')).toBe('fill-signin-beacon');
    expect(accents?.querySelectorAll('path')).toHaveLength(2);
  });
});
