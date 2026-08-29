import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('side panel root missing');
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
