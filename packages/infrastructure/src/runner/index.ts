/**
 * The Claude Agent SDK runner (technical/04) and its two fakes.
 *
 * `createClaudeRunner` is the adapter WP-15's stage executor drives; `createFakeClaudeRunner` and
 * `fakeSpawnClaudeCodeProcess` are the test doubles every later work package leans on, and each
 * carries its divergence register in its own file.
 *
 * WP-15g added the two collaborators a *production* run needs beside it: `createWorkspaceClaudeRunner`,
 * which builds the runner per run over the workspace's control channel and frees the workspace on
 * every ending, and `createPostgresTranscriptSink`, the first thing in this repository that writes
 * `run_messages`.
 */
export * from './async-queue.js';
export * from './claude-runner.js';
export * from './clock.js';
export * from './fake-claude-runner.js';
export * from './fake-spawn.js';
export * from './fixtures.js';
export * from './hooks.js';
export * from './options.js';
export * from './path-guard.js';
export * from './permission.js';
export * from './platform-mcp.js';
export * from './postgres-transcript-sink.js';
export * from './session-mirror.js';
export * from './stream-block-coalescer.js';
export * from './structured-output.js';
export * from './transcript-normaliser.js';
export * from './truncation.js';
export * from './workspace-runner.js';
