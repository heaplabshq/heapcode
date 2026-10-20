import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { applyTheme } from '@heapcode/web-ui/theme';
// Heap Code's stylesheet, not a copy of it — the two products share a shell
// and must not drift. `styles.css` here holds only what is genuinely this
// product's: the grounding badge, the memory list, the folder picker.
import '@heapcode/web-ui/styles.css';
import './styles.css';

/**
 * Strip `?token=…` from the address bar. The host has already exchanged it for
 * an HttpOnly cookie and redirected; a user who pastes the original URL into a
 * second tab arrives with it again, and it should not survive into history or
 * a screenshot. The cookie authenticates from here on.
 */
if (new URL(window.location.href).searchParams.has('token')) {
  const clean = new URL(window.location.href);
  clean.searchParams.delete('token');
  window.history.replaceState({}, '', clean.pathname + clean.search + clean.hash);
}

// Before the first render, so a dark choice never flashes light.
applyTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
