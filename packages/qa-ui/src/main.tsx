import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
// Heap Code's stylesheet, shared by all three products; this product's own
// rules are only what the shell does not already have.
import '@heapcode/web-ui/styles.css';
import './styles.css';

// The launch token is already exchanged for a cookie; keep it out of history.
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
