/**
 * The browser entry point. Everything else is in `app/app.tsx`, which takes its collaborators.
 */
// First, and deliberately above the rest: the decision it makes is memoised the first time a
// schema is built, so every import below this line is already too late (`zod-jitless.ts`).
import './zod-jitless.js';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createApp } from './app/app.js';
import './styles.css';
import { applyStoredThemeSynchronously } from './ui/theme.js';

// Before the first render, so the first paint is already the right colour.
applyStoredThemeSynchronously();

const container = document.getElementById('root');
if (container === null) {
  throw new Error('#root is missing from index.html');
}

createRoot(container).render(<StrictMode>{createApp().element}</StrictMode>);
