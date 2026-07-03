/**
 * Typed message protocol between the VS Code extension host and the webview UI.
 * Single source of truth — both sides import these types.
 */

export type WebviewToExtension =
  | { type: 'ready' }
  | { type: 'send'; text: string }
  | { type: 'stop' }
  | { type: 'clear' };

export type ExtensionToWebview =
  | { type: 'config'; baseUrl: string; model: string }
  | { type: 'chunk'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string };
