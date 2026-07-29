import { resolveContextWindow, type ProviderProfileConfig } from '@heapcode/core';

/**
 * The effective context window for a profile.
 *
 * This used to build a Provider too. Nothing in the CLI calls one any more —
 * the agent loop, chat, RAG and PR review all run in the server, and /model
 * lists through `provider/listModels` — so constructing one here would be
 * reading a key out of secrets storage for an object that never makes a
 * request. The context window is still needed host-side: it sizes the usage
 * meter and PR review's per-batch diff budget, both of which the host passes
 * on the wire.
 */
export function profileContextWindow(profile: ProviderProfileConfig): number {
  return resolveContextWindow(profile);
}
