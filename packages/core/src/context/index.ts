/**
 * Token estimation and the compaction thresholds the loop uses to decide when
 * a transcript has outgrown the model's window.
 *
 * Pure arithmetic over strings and messages — browser-safe in full. Exposed as
 * a subpath for the same reason as `../agent/index.ts` and
 * `../providers/index.ts`.
 */

export * from './tokens.js';
export * from './contextManager.js';
