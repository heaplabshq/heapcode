/**
 * The provider layer: OpenAI-compatible chat completions, SSE streaming,
 * retry/backoff, the error taxonomy, the endpoint presets, and Azure.
 *
 * Everything here runs on `fetch` and nothing else, so it is browser-safe in
 * full — there is no curation to do and no module held back. Exposed as a
 * subpath so hosts without Node can take the provider layer without the
 * package barrel's Node-coupled modules. See `../agent/index.ts` for why the
 * barrel is not an option for them.
 */

export * from './types.js';
export * from './errors.js';
export * from './openaiCompatible.js';
export * from './azure.js';
export * from './factory.js';
export * from './presets.js';
export * from './sse.js';
export * from './modelFilter.js';

// `createProvider` takes a `ProviderProfileConfig`, so a barrel that exports the
// function but not its parameter type is unusable from this subpath — a caller
// would have to reach past it into the package barrel, which is the Node-coupled
// import this whole surface exists to avoid. The module is pure config shapes and
// is already inside this closure via factory.ts.
export * from '../config/profiles.js';
