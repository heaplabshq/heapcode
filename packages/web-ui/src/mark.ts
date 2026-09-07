/**
 * A stable hue per name, for the small square marks that stand in for a
 * connection.
 *
 * Shared between the settings page's connection cards and the rail's footer so
 * one endpoint is the same colour wherever it appears — which is the only
 * thing that makes the mark worth drawing at all. The initial alone does not
 * distinguish anything in the common case: a list of endpoints is often
 * `ollama`, `openrouter`, `openai`.
 */
export function markHue(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
