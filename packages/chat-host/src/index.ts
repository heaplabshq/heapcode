/**
 * @heapcode/chat-host — Heap Chat's browser-facing host.
 *
 * A sibling of `@heapcode/web-host`, not a layer on top of it: it borrows that
 * package's HTTP/WS/auth shell wholesale and supplies its own session, tool
 * roster and agent identity. The two products share an engine and a front
 * door; they share no opinion about what the agent is.
 *
 * See docs/CHAT_MODE_PLAN.md.
 */
export * from './extractors.js';
export * from './protocol.js';
export * from './prompt.js';
export * from './server.js';
export * from './session.js';
export * from './tools.js';
