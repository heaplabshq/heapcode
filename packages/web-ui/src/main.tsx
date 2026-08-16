import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

/**
 * If the launch URL still carries ?token=…, the host has already set its
 * HttpOnly cookie and redirected — but a user who copies the original URL into
 * a second tab lands here with it again. Strip it from the address bar so the
 * token stops surviving in history and screenshots (§6.1). The cookie, not the
 * query string, is what authenticates from here on.
 */
if (new URL(window.location.href).searchParams.has('token')) {
  const clean = new URL(window.location.href);
  clean.searchParams.delete('token');
  window.history.replaceState({}, '', clean.pathname + clean.search + clean.hash);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
