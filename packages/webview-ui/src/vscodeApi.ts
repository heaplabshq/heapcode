import type { WebviewToExtension } from '@heapcode/core';

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
