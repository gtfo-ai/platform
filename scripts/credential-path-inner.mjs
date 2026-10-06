/**
 * The inside half of `credential-path-check.mjs` (backlog 481) — runs **in** the `platform-runtime`
 * image as uid 1000, with this repository mounted read-only at `/src`, and prints one JSON line.
 *
 * Every piece on the credential path is the real one, from source: the image's `git` → the helper
 * (`apps/runlet/src/index.ts credential --socket …`, the provider's source-form command) → the shim
 * (`createRunletShim`) → the runner's spawn adapter (`createRunletSpawn`) → `RunCredentialBroker`,
 * holding an obviously fake static token for `acme/api`. The git list is the provider's two entries
 * (`credential.helper`, `credential.useHttpPath`) numbered by `numberGitConfig`, as the CLI gets it.
 * A local HTTPS server on 443 stands in for the git host: it answers `401` to a request without
 * credentials and `403` to one with them (so git stops after one authenticated try), and records
 * which request carried the token.
 *
 * Not the production composition: no launcher, no egress sidecar, no container boundary between the
 * shim and the broker (both in this process, as the shim's own tests have them). What it measures is
 * git's behaviour and the helper → broker decision, end to end, with nothing stubbed between them.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import process from 'node:process';

const runlet = await import('/src/packages/infrastructure/src/runlet/index.ts');
const { RunCredentialBroker } = await import(
  '/src/packages/infrastructure/src/workspace/broker.ts'
);
const { systemClock } = await import('/src/packages/infrastructure/src/runner/clock.ts');
const { numberGitConfig } = await import(
  '/src/packages/infrastructure/src/workspace/cli-environment.ts'
);

const HOST = 'git.example.test';
const FAKE = 'FAKE-backlog481-run-token-not-a-credential';
const RUN = '48100000-0000-4000-8000-000000000481';
const TOKEN = 'r'.repeat(40);
const BASE = `https://${HOST}`;

execFileSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    '/tmp/k.pem',
    '-out',
    '/tmp/c.pem',
    '-days',
    '1',
    '-subj',
    `/CN=${HOST}`,
    '-addext',
    `subjectAltName=DNS:${HOST}`,
  ],
  { stdio: 'ignore' },
);

const requests = [];
const server = createServer(
  { key: readFileSync('/tmp/k.pem'), cert: readFileSync('/tmp/c.pem') },
  (request, response) => {
    const auth = request.headers.authorization ?? '';
    const decoded = auth.startsWith('Basic ')
      ? Buffer.from(auth.slice('Basic '.length), 'base64').toString('utf8')
      : '';
    requests.push({
      path: (request.url ?? '').split('?')[0],
      token: decoded.endsWith(`:${FAKE}`),
    });
    response.writeHead(decoded === '' ? 401 : 403, { 'WWW-Authenticate': 'Basic realm="check"' });
    response.end();
  },
);
await new Promise((resolve) => server.listen(443, '127.0.0.1', resolve));

mkdirSync('/tmp/ctl', { mode: 0o700 });
const logged = [];
const record = (fields, message) => {
  logged.push({ ...fields, message });
};
const logger = { debug: () => {}, info: record, warn: record, error: record };
const shim = runlet.createRunletShim({
  controlSocketPath: '/tmp/ctl/ctl.sock',
  credentialSocketPath: '/tmp/ctl/cred.sock',
  token: TOKEN,
  clock: systemClock,
});
await shim.start();

const broker = new RunCredentialBroker(logger);
broker.hold({
  runId: RUN,
  readOnly: false,
  credential: {
    host: HOST,
    username: 'oauth2',
    password: FAKE,
    scope: 'push',
    expiresAt: '2099-01-01T00:00:00.000Z',
    source: 'static',
  },
  repositoryPath: 'acme/api',
});
const spawn = runlet.createRunletSpawn({
  socketPath: '/tmp/ctl/ctl.sock',
  token: TOKEN,
  clock: systemClock,
  credentials: async ({ host, path }) => {
    const answer = broker.answer(RUN, { host, path });
    return answer === null ? null : { username: answer.username, password: answer.password };
  },
});

const gitList = numberGitConfig([
  {
    key: 'credential.helper',
    value:
      '!node --import /src/scripts/ts-source-resolver.mjs /src/apps/runlet/src/index.ts credential --socket /tmp/ctl/cred.sock',
  },
  { key: 'credential.useHttpPath', value: 'true' },
]);
const other = `${BASE}/other/repo.git`;
const script = [
  'cd /tmp && git init -q repo && cd repo',
  'git -c user.email=a@example.test -c user.name=a commit -q --allow-empty -m x',
  `git ls-remote ${BASE}/acme/api.git >/dev/null 2>&1`,
  `git push ${BASE}/acme/api.git HEAD:refs/heads/agentic/x >/dev/null 2>&1`,
  `git push ${other} HEAD:refs/heads/agentic/x >/dev/null 2>&1`,
  `git ls-remote ${other} >/dev/null 2>&1`,
  // An interpreter's spelling, which no reading of the command line sees.
  `node -e "require('child_process').spawnSync('git',['push','${other}','HEAD:refs/heads/agentic/x'])"`,
  `git -c credential.useHttpPath=false push ${other} HEAD:refs/heads/agentic/x >/dev/null 2>&1`,
  'git config credential.useHttpPath false',
  `git config credential.${BASE}.useHttpPath false`,
  `git push ${other} HEAD:refs/heads/agentic/x >/dev/null 2>&1`,
  'exit 0',
].join('\n');

const child = spawn({
  command: '/bin/sh',
  args: ['-c', script],
  cwd: '/tmp',
  env: {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: '/tmp',
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSL_CAINFO: '/tmp/c.pem',
    ...gitList,
  },
  signal: new AbortController().signal,
});
child.stdin.end();
const exitCode = await new Promise((resolve) => child.once('exit', (code) => resolve(code)));
await shim.close();
server.close();
process.stdout.write(
  `${JSON.stringify({
    exitCode,
    requests,
    refusals: logged.map((line) => line.reason ?? line.message),
    tokenInLog: JSON.stringify(logged).includes(FAKE),
  })}\n`,
);
process.exit(0);
