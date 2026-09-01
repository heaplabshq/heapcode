/**
 * The browser-safe agent surface: the loop and everything it needs to run,
 * with nothing that touches a filesystem, a process, or a socket.
 *
 * The loop is host-agnostic by construction — it takes tools as data and
 * execution as a callback, and never learns what a "file" is. That makes it
 * reusable by hosts with no Node at all (an MV3 extension, a web worker), but
 * only if they can import it without dragging the rest of core along. The
 * package barrel (`../index.ts`) re-exports Node-coupled modules like
 * `workspaceTools`, `mcp`, and `server/`, so `@heapcode/core` as a whole
 * pulls `node:child_process` into any bundle. This subpath is the way in for
 * those hosts.
 *
 * Deliberately excluded even though they are Node-free: `checkpoint`, `skills`
 * and `projectInstructions`. They compile fine in a browser but are
 * workspace-domain concepts, and this barrel is a curated surface rather than
 * "whatever happens to build". Add them when a non-Node host actually needs one.
 *
 * `toolDefinitions` is included despite mostly being workspace tools, because
 * `ask_user` lives there and is not workspace-specific at all — every host with
 * a human attached needs it, and heapbrowse restating the schema would put two
 * definitions of one protocol tool in the portfolio. The rest of the map is
 * inert data a bundler drops.
 *
 * Node-coupled and never to be added here: `workspaceTools` (child_process),
 * `webSearch` (reaches child_process through workspaceTools), `mcp` (the MCP
 * SDK's stdio transport). `test/browserSafety.test.ts` enforces this against
 * the full transitive import graph, which is the only check that catches
 * coupling arriving through a relative import.
 */

export * from './loop.js';
export * from './tools.js';
export * from './textProtocol.js';
export * from './todo.js';
export * from './commandRisk.js';
export * from './permissionModes.js';
export * from './permissions.js';
export * from './personas.js';
export * from './prompts.js';
export * from './subAgent.js';
export * from './askUser.js';
export * from './toolDefinitions.js';
