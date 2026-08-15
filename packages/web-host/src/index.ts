/**
 * @heapcode/web-host — the browser-facing host.
 *
 * The middle tier of docs/WEB_APP_PLAN.md §3.1: it serves the SPA, owns the
 * WebSocket, and is the *host* in the daemon's sense — the process with hands.
 * Tool execution, permission decisions, key access and shadow-git all happen
 * here, never in the browser, which is what keeps the browser a renderer and
 * the trust boundary in one place (§3.2, §6).
 *
 * Nothing in here is Electron-specific, and that is on purpose: under Electron
 * this same module becomes the `main` process and the SPA becomes `renderer`,
 * with no change to either (§11).
 */

export * from './protocol.js';
export * from './server.js';
export * from './session.js';
export * from './static.js';
export * from './artifacts.js';
export * from './workspace.js';
export * from './wsDuplex.js';
