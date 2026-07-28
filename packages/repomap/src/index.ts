/**
 * A repo mapper: rank a codebase's files by how central they are to it, and
 * render a budget-limited structural outline of the ones that matter most.
 *
 * The package knows nothing about any particular editor, agent or runtime. A
 * syntax parser arrives as an injected ParserResolver, and with no parser at
 * all it still works, on a regex fallback.
 */
export * from './syntax.js';
export * from './symbols.js';
export * from './importGraph.js';
export * from './rank.js';
export { fnv1a } from './hash.js';
