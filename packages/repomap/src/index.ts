/**
 * A repo mapper: rank a codebase's files by how central they are to it, and
 * render a budget-limited structural outline of the ones that matter most.
 *
 * The package knows nothing about any particular editor, agent or runtime.
 * A filesystem arrives as a FileSource, persistence as a RepoMapStore, and a
 * syntax parser as a ParserResolver — all injected. With no parser at all it
 * still works, on a regex fallback.
 *
 * Node hosts can import ready-made fs adapters from "@heapcode/repomap/node"
 * rather than writing their own.
 */
export * from './syntax.js';
export * from './symbols.js';
export * from './importGraph.js';
export * from './rank.js';
export * from './debugRanking.js';
export * from './indexer.js';
export { fnv1a } from './hash.js';
