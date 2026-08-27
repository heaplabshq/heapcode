/**
 * The Node-only corner of core: implementations of the `../fs.ts` seams for
 * hosts that have a real filesystem.
 *
 * This subpath exists to give the Node-coupled surface an explicit, named home
 * rather than leaving it as an unmarked part of the package barrel. Importing
 * it from a browser host is a build error, and that is the point — the failure
 * arrives at the import, naming the module, instead of surfacing as a bundler
 * complaint about `node:fs/promises` from somewhere deep in a barrel.
 */

export * from './fs.js';
