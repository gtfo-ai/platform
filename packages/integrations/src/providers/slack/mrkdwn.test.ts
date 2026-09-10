import { describe, expect, it } from 'vitest';
import { escapeSlackText, isLinkableUrl, toMrkdwn, truncate } from './mrkdwn.js';

describe('escapeSlackText', () => {
  it('escapes the three control characters, ampersand first', () => {
    expect(escapeSlackText('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
    // `&` first, or `&lt;` becomes `&amp;lt;`.
    expect(escapeSlackText('<')).toBe('&lt;');
    expect(escapeSlackText('&lt;')).toBe('&amp;lt;');
  });

  /**
   * The reason this function exists (BD-022). A ticket description is written by whoever opened
   * the ticket, and Slack reads `<!channel>` in a message body as "notify every member of this
   * channel, active or not".
   */
  it('defuses a broadcast mention hidden in untrusted text', () => {
    const fromATicket = 'Please fix ASAP <!channel> <!here> <@U0FAKEBOSS>';
    const rendered = toMrkdwn(fromATicket);
    expect(rendered).not.toContain('<!channel>');
    expect(rendered).not.toContain('<!here>');
    expect(rendered).not.toContain('<@U0FAKEBOSS>');
    expect(rendered).toContain('&lt;!channel&gt;');
  });

  /**
   * The case above asserts only the *pre-escaped literal*, which is the form nobody has to write
   * a broadcast in. This is the form found in review round 1: no control character in the input at
   * all, so the escape has nothing to do, and the link rule builds the brackets itself. The
   * adapter-level version of this lives in `test/contract/integrations/slack.contract.test.ts`,
   * because the bytes on the wire are what Slack parses.
   */
  it('defuses a mention written as a markdown link, which the escape cannot see', () => {
    const fromATicket =
      'Ticket says: [urgent](!channel) cc [boss](@U0FAKEBOSS) [devs](!subteam^S0FAKE)';
    const rendered = toMrkdwn(fromATicket);
    expect(rendered, 'nothing to escape, so the source must survive verbatim').toBe(fromATicket);
    expect(rendered, 'and no `<(.*?)>` substring for Slack to detect').not.toMatch(/<.*?>/s);
  });
});

describe('isLinkableUrl', () => {
  it('allows exactly https, http and mailto, in any case', () => {
    for (const url of [
      'https://example.test/x',
      'http://example.test/x',
      'mailto:team@example.test',
      'HTTPS://example.test/x',
      'MailTo:team@example.test',
    ]) {
      expect(isLinkableUrl(url), url).toBe(true);
    }
  });

  it('refuses everything Slack could read as a mention, and every other scheme', () => {
    for (const url of [
      '!channel',
      '!here',
      '!everyone',
      '!subteam^S0FAKE',
      '@U0FAKEBOSS',
      '@W0FAKEBOSS',
      '#C0FAKECHAN',
      '//evil.example.test',
      '/relative',
      'javascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'file:///etc/passwd',
      'slack://channel?id=C0FAKECHAN',
      '',
      ' https://example.test',
      '1https://example.test',
      // A scheme is ASCII by RFC 3986; a lookalike must not fold into one (standing rule 26).
      'ｈｔｔｐｓ://example.test',
      'HTTPS\u0130://example.test',
    ]) {
      expect(isLinkableUrl(url), url).toBe(false);
    }
  });
});

describe('toMrkdwn', () => {
  it('converts bold, strike, headings, bullets and links', () => {
    expect(toMrkdwn('Picked up **TASK-1**')).toBe('Picked up *TASK-1*');
    expect(toMrkdwn('__also bold__')).toBe('*also bold*');
    expect(toMrkdwn('~~gone~~')).toBe('~gone~');
    expect(toMrkdwn('## Plan')).toBe('*Plan*');
    expect(toMrkdwn('- one\n- two')).toBe('• one\n• two');
    expect(toMrkdwn('see [the MR](https://git.example.test/mr/1)')).toBe(
      'see <https://git.example.test/mr/1|the MR>',
    );
    // An empty label is the bare-link form, and it is allow-listed by the same rule.
    expect(toMrkdwn('[](https://git.example.test/mr/1)')).toBe('<https://git.example.test/mr/1>');
  });

  it('leaves a fenced code block alone', () => {
    const source = 'before **bold**\n```\nconst a = **not bold**;\n```\nafter **bold**';
    const rendered = toMrkdwn(source);
    expect(rendered).toContain('const a = **not bold**;');
    expect(rendered.startsWith('before *bold*')).toBe(true);
    expect(rendered.endsWith('after *bold*')).toBe(true);
  });

  it('leaves what it does not convert as plain text rather than mangling it', () => {
    // Stated as a limitation in the module's docblock, and asserted so a change is noticed.
    expect(toMrkdwn('| a | b |\n| - | - |')).toBe('| a | b |\n| - | - |');
    expect(toMrkdwn('> quoted')).toBe('&gt; quoted');
  });
});

describe('truncate', () => {
  it('never returns more characters than the limit', () => {
    expect(truncate('abcdef', 10)).toBe('abcdef');
    expect(truncate('abcdef', 3)).toBe('ab…');
    expect(truncate('abcdef', 3).length).toBe(3);
    expect(truncate('abcdef', 1)).toBe('…');
  });
});
