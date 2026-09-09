import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
