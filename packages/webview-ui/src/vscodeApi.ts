import type { WebviewToExtension } from '@cortex/core';

interface VsCodeApi {
  postMessage(msg: unknown): void;
}

declare global {
  function acquireVsCodeApi(): VsCodeApi;
}

const api = acquireVsCodeApi();

export function postToExtension(msg: WebviewToExtension): void {
  api.postMessage(msg);
}
