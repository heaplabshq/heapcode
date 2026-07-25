// Ink's optional DEV-mode devtools hook statically imports react-devtools-core,
// which isn't (and shouldn't be) a real dependency of a shipped CLI. esbuild's
// ESM output hoists that import to the top of the bundle regardless of the
// runtime `DEV` env-var guard around it, so it must resolve to *something* —
// this is that something. Ink only calls .connectToDevTools() when
// process.env.DEV === 'true', which we never set in the built CLI.
export default { connectToDevTools() {} };
