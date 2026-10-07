/**
 * Electron's <webview>, as far as the Browser view uses it. Only exists inside
 * the desktop app, which enables the tag and vets every attach.
 */
import 'react';

declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        partition?: string;
        allowpopups?: string;
      };
    }
  }
}

export interface WebviewElement extends HTMLElement {
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  isLoading(): boolean;
  openDevTools(): void;
  getWebContentsId(): number;
  executeJavaScript<T = unknown>(code: string): Promise<T>;
}
