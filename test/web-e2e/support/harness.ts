/**
 * What every Playwright spec needs from the fake backend.
 *
 * The control endpoints are called through Playwright's own `request` fixture so they share the
 * base URL, and nothing here sleeps: `expect.poll` and Playwright's auto-waiting locators are the
 * only waiting primitives in this suite (standing rule 2).
 */
import type { SseFrame } from '@platform/contracts';
import { type APIRequestContext, expect, type Page } from '@playwright/test';
import { CREDENTIALS } from './fixtures.js';

/** Puts the fake backend back to its fixture state. See `POST /__test__/reset`. */
export const resetBackend = async (request: APIRequestContext): Promise<void> => {
  const response = await request.post('/__test__/reset');
  expect(response.ok()).toBe(true);
};

export const signIn = async (page: Page, path = '/'): Promise<void> => {
  await page.goto(path);
  await expect(page.getByRole('heading', { name: 'Agentic platform' })).toBeVisible();
  await page.getByLabel('Email').fill(CREDENTIALS.email);
  await page.getByLabel('Password').fill(CREDENTIALS.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
};

export const publishFrame = async (
  request: APIRequestContext,
  topic: string,
  event: string,
  frame: SseFrame,
): Promise<number> => {
  const response = await request.post('/__test__/publish', { data: { topic, event, frame } });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { delivered: number }).delivered;
};

export const sendControl = async (
  request: APIRequestContext,
  type: 'reset' | 'shutdown',
  topic: string | null = null,
): Promise<number> => {
  const response = await request.post('/__test__/control', { data: { type, topic } });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { delivered: number }).delivered;
};

export const streamState = async (
  request: APIRequestContext,
): Promise<{ open: number; connects: string[] }> => {
  const response = await request.get('/__test__/streams');
  expect(response.ok()).toBe(true);
  return (await response.json()) as { open: number; connects: string[] };
};

/**
 * Every command the fake backend accepted, with the body it parsed.
 *
 * The commands that move a task between stages have no visible effect in this suite — the fixtures
 * are static, so the screen looks identical whether the POST arrived or not. Reading the server's
 * own log is what makes the assertion about the *command* rather than about the button (standing
 * rule 24: a check that counts execution is not a check that counts assertion).
 */
export const commandLog = async (
  request: APIRequestContext,
): Promise<{ path: string; body: Record<string, unknown> }[]> => {
  const response = await request.get('/__test__/commands');
  expect(response.ok()).toBe(true);
  return (
    (await response.json()) as { commands: { path: string; body: Record<string, unknown> }[] }
  ).commands;
};

export const addTask = async (request: APIRequestContext): Promise<void> => {
  const response = await request.post('/__test__/add-task');
  expect(response.ok()).toBe(true);
};

/**
 * Waits until the fake backend has an open stream that carries `topic`.
 *
 * Necessary because the SPA opens the stream in an effect after the first paint, and publishing
 * into no stream would deliver nothing and prove nothing. Asserting `delivered >= 1` at the point
 * of publication is what turns "the frame was sent" into a fact rather than a hope (standing rule
 * 29: capture the counter, assert it moved).
 */
export const waitForStreamCarrying = async (
  request: APIRequestContext,
  topic: string,
  probe: SseFrame,
  event: string,
): Promise<void> => {
  await expect
    .poll(async () => publishFrame(request, topic, event, probe), {
      message: `no open SSE stream is subscribed to ${topic}`,
    })
    .toBeGreaterThan(0);
};
