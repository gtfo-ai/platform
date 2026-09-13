/**
 * The bundle path guard, against a real filesystem (WP-15j criterion 3, BD-022).
 *
 * Every refusal here is measured against a **file that exists**: a fixture root with an outside
 * neighbour, a symlink planted inside the root pointing at that neighbour, and a second one
 * pointing at `/etc/hosts`. A guard tested against paths that lead nowhere passes whether it
 * contains anything or not — the target's bytes are read directly in each case first, so "refused"
 * and "there was nothing there" cannot be confused (standing rules 42 and 55).
 *
 * The HTTP half — that a **raw** request line carrying `..` reaches this code un-normalised — is
 * `web-serving.test.ts`, which needs a socket to be honest about it.
 */
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BUNDLED_WEB_ROOT,
  contentTypeFor,
  decodeRequestPath,
  IMMUTABLE_CACHE_CONTROL,
  REVALIDATE_CACHE_CONTROL,
  resolveBundleFile,
  resolveBundleRoot,
} from './bundle.js';

const SHELL_BYTES = '<!doctype html><title>shell</title>\n';
const ASSET_BYTES = 'export const answer = 42;\n';
const OUTSIDE_BYTES = 'not-a-real-secret-but-outside-the-root\n';

let base: string;
let root: string;
let realRoot: string;

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), 'wp15j-bundle-'));
  root = join(base, 'dist');
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'index.html'), SHELL_BYTES);
  writeFileSync(join(root, 'assets', 'index-AbCd1234.js'), ASSET_BYTES);
  writeFileSync(join(root, 'favicon.svg'), '<svg/>\n');
  writeFileSync(join(root, '.env'), 'APP_SECRET_KEY=not-a-real-secret\n');
  mkdirSync(join(base, 'outside'), { recursive: true });
  writeFileSync(join(base, 'outside', 'neighbour.txt'), OUTSIDE_BYTES);
  // The two shapes criterion 3 names: a symlink to a file outside the root, and one to a
  // directory outside it, so a path *under* the link is tried too.
  symlinkSync(join(base, 'outside', 'neighbour.txt'), join(root, 'leak.txt'));
  symlinkSync(join(base, 'outside'), join(root, 'outside-link'));
  symlinkSync('/etc/hosts', join(root, 'hosts.txt'));
  realRoot = (await resolveBundleRoot(root)) ?? '';
  expect(realRoot).not.toBe('');
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('decodeRequestPath', () => {
  it('decodes the segments of a path the application actually serves', () => {
    expect(decodeRequestPath('/')).toEqual([]);
    expect(decodeRequestPath('/index.html')).toEqual(['index.html']);
    expect(decodeRequestPath('/assets/index-AbCd1234.js')).toEqual(['assets', 'index-AbCd1234.js']);
    // A key with a space in it is a legitimate project key in a deep link.
    expect(decodeRequestPath('/projects/ACME%20API/tasks/7')).toEqual([
      'projects',
      'ACME API',
      'tasks',
      '7',
    ]);
    // Empty segments are collapsed, so `//etc/hosts` is `etc/hosts` and not an absolute path.
    expect(decodeRequestPath('//etc/hosts')).toEqual(['etc', 'hosts']);
  });

  it.each([
    ['a relative path', 'assets/app.js'],
    ['a parent traversal', '/../outside/neighbour.txt'],
    ['a percent-encoded traversal', '/%2e%2e/outside/neighbour.txt'],
    ['a traversal deeper in', '/assets/../../outside/neighbour.txt'],
    ['a bare dot segment', '/./index.html'],
    ['a dotfile', '/.env'],
    ['a dot-directory', '/.git/config'],
    ['an encoded separator', '/assets%2f..%2f..%2foutside'],
    ['an encoded backslash', '/assets/..%5c..%5coutside'],
    // …and one whose decoded name does not begin with a dot, so only the separator clause
    // refuses it: without that clause a Windows-style separator would reach `join`.
    ['an encoded backslash inside a name', '/assets/sub%5c..%5cx'],
    ['a NUL byte', '/index.html%00.txt'],
    ['a malformed escape', '/%zz'],
    ['a lone percent', '/%'],
  ])('refuses %s', (_name, path) => {
    expect(decodeRequestPath(path)).toBeNull();
  });
});

describe('resolveBundleFile', () => {
  it('resolves the shell and a hashed asset to the bytes on disk', async () => {
    const shell = await resolveBundleFile(realRoot, ['index.html']);
    expect(shell?.contentType).toBe('text/html; charset=utf-8');
    expect(shell?.cacheControl).toBe(REVALIDATE_CACHE_CONTROL);
    expect(readFileSync(shell?.path ?? '', 'utf8')).toBe(SHELL_BYTES);

    const asset = await resolveBundleFile(realRoot, ['assets', 'index-AbCd1234.js']);
    expect(asset?.contentType).toBe('text/javascript; charset=utf-8');
    expect(asset?.cacheControl).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(readFileSync(asset?.path ?? '', 'utf8')).toBe(ASSET_BYTES);
  });

  it('caches only what Vite content-hashes, so a deploy cannot strand an unhashed file', async () => {
    // `favicon.svg` is copied from `public/` verbatim and keeps its name across builds; only
    // `assets/` carries the content hash that makes a year-long cache safe.
    const favicon = await resolveBundleFile(realRoot, ['favicon.svg']);
    expect(favicon?.cacheControl).toBe(REVALIDATE_CACHE_CONTROL);
  });

  it('refuses a symlink out of the root, and the target is readable to prove it exists', async () => {
    // Read the targets first: without this, every assertion below is satisfied by a guard that
    // refuses everything *and* by a fixture that was never created (standing rule 42).
    expect(readFileSync(join(base, 'outside', 'neighbour.txt'), 'utf8')).toBe(OUTSIDE_BYTES);
    expect(readFileSync(join(root, 'leak.txt'), 'utf8')).toBe(OUTSIDE_BYTES);
    expect(readFileSync('/etc/hosts', 'utf8').length).toBeGreaterThan(0);

    expect(await resolveBundleFile(realRoot, ['leak.txt'])).toBeNull();
    expect(await resolveBundleFile(realRoot, ['hosts.txt'])).toBeNull();
    expect(await resolveBundleFile(realRoot, ['outside-link', 'neighbour.txt'])).toBeNull();
  });

  it('refuses a traversal handed to it directly, not only one the decoder caught', async () => {
    // The decoder refuses `..` before this function is reached, so the containment branch would
    // otherwise never be exercised and could be deleted with every test still green (rule 10).
    expect(await resolveBundleFile(realRoot, ['..', 'outside', 'neighbour.txt'])).toBeNull();
    expect(await resolveBundleFile(realRoot, ['..'])).toBeNull();
  });

  it('refuses what is not a regular file', async () => {
    expect(await resolveBundleFile(realRoot, ['assets'])).toBeNull();
    expect(await resolveBundleFile(realRoot, [])).toBeNull();
    expect(await resolveBundleFile(realRoot, ['nothing-here.js'])).toBeNull();
  });

  it('states its guarantee over a case-insensitive volume rather than assuming one', async () => {
    // APFS folds case, ext4 does not, so *whether* this resolves is a property of the filesystem
    // (standing rules 15 and 26). What must hold on both is that a name that resolves at all
    // resolves inside the root — which is what a realpath comparison gives and a string compare
    // of the request path does not.
    const folded = await resolveBundleFile(realRoot, ['INDEX.HTML']);
    expect(folded === null || folded.path.startsWith(realRoot + sep)).toBe(true);
  });
});

describe('resolveBundleRoot', () => {
  it('follows a symlinked root to its realpath, which is what containment is measured against', async () => {
    const link = join(base, 'dist-link');
    symlinkSync(root, link);
    expect(await resolveBundleRoot(link)).toBe(realRoot);
  });

  it('answers null for a directory that is not there and for a file', async () => {
    expect(await resolveBundleRoot(join(base, 'no-such-directory'))).toBeNull();
    expect(await resolveBundleRoot(join(root, 'index.html'))).toBeNull();
  });
});

describe('contentTypeFor', () => {
  it('declares what the bundle contains and refuses to guess at anything else', () => {
    expect(contentTypeFor('index.html')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor('index-AbCd.CSS')).toBe('text/css; charset=utf-8');
    expect(contentTypeFor('logo.svg')).toBe('image/svg+xml');
    expect(contentTypeFor('font.woff2')).toBe('font/woff2');
    // No extension, an unknown one, and a leading dot are all downloads rather than sniffable.
    expect(contentTypeFor('LICENSE')).toBe('application/octet-stream');
    expect(contentTypeFor('archive.tar.zst')).toBe('application/octet-stream');
  });
});

describe('BUNDLED_WEB_ROOT', () => {
  it('is the checkout’s own apps/web/dist, resolved from this module rather than from cwd', () => {
    expect(BUNDLED_WEB_ROOT.endsWith(join('apps', 'web', 'dist'))).toBe(true);
    // Absolute, because it is handed to `resolveBundleRoot` and joined with nothing.
    expect(BUNDLED_WEB_ROOT.startsWith(sep)).toBe(true);
  });
});
