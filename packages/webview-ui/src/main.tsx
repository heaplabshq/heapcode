import { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

/**
 * A render crash in a webview is otherwise a silent white panel — surface it
 * so it can be reported and the extension's fallbacks (e.g. modal permission
 * prompts) can be understood.
 */
class ErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  override state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 16 }}>
          <h3>Cortex chat crashed</h3>
          <pre style={{ whiteSpace: 'pre-wrap', opacity: 0.8 }}>
            {this.state.error.message}
            {'\n'}
            {this.state.error.stack}
          </pre>
          <p>Reload the window to recover. Please report this output.</p>
        </div>
      );
    }
    return this.props.children;
  }
}

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>,
  );
}
