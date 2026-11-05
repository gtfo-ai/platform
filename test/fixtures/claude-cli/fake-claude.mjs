/**
 * A fake `claude` for the worker's sign-in (WP-294 (4)): it replays V-WM10's measured
 * `claude setup-token` screen (`setup-token.transcript.json`, whose `source` block says which parts
 * are recorded and which composed), reads the pasted code from stdin, and answers the token check
 * (`claude -p … --output-format json`) as the pinned CLI does — `is_error: false` for the fixture's
 * token, `api_error_status: 401` for any other.
 *
 * The success screen is written in two parts split inside the token, 150 ms apart.
 *
 * Like the real CLI it never exits on its own after the token: it waits until it is killed, and it
 * exits when its stdin closes. It reads nothing from the environment but `CLAUDE_CODE_OAUTH_TOKEN`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.join(here, 'setup-token.transcript.json'), 'utf8'));
const args = process.argv.slice(2);

if (args[0] === 'setup-token') {
  process.stdout.write(fixture.screen);
  let typed = '';
  let answered = false;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    if (answered) return;
    typed += chunk;
    const end = typed.indexOf('\r');
    if (end < 0) return;
    answered = true;
    const code = typed.slice(0, end);
    if (code !== fixture.good_code) {
      process.stdout.write(fixture.after_refused_code);
      return;
    }
    // The success screen in two writes split **inside** the token, as a pty may deliver it: the
    // reader must not take the half it has seen (review of PR #42).
    const screen = fixture.after_good_code;
    const cut = screen.indexOf(fixture.token) + 40;
    process.stdout.write(screen.slice(0, cut));
    setTimeout(() => process.stdout.write(screen.slice(cut)), 150);
  });
  process.stdin.on('end', () => process.exit(0));
  setInterval(() => undefined, 60_000);
} else if (args.includes('-p')) {
  const accepted = process.env.CLAUDE_CODE_OAUTH_TOKEN === fixture.token;
  process.stdout.write(
    `${JSON.stringify(
      accepted
        ? { type: 'result', subtype: 'success', is_error: false, result: 'OK' }
        : {
            type: 'result',
            subtype: 'success',
            is_error: true,
            api_error_status: 401,
            result: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.',
          },
    )}\n`,
  );
  process.exit(accepted ? 0 : 1);
} else {
  process.stderr.write(`fake claude: unknown arguments ${args.join(' ')}\n`);
  process.exit(2);
}
