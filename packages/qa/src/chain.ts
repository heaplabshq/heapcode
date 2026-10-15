import type { Flow, Step } from './flow.js';
import type { SavedFingerprints } from './record.js';

/**
 * One test out of two recordings made one after the other in the same
 * browser — an Ask AI follow-up ("now also check the cart") carrying on from
 * where the last task stopped. The second's steps are appended; its inputs are
 * renamed where they clash with the first's, so both keep their own values;
 * its fingerprints move to the steps' new numbers.
 */
export function chainRecordings(
  first: { flow: Flow; fingerprints: SavedFingerprints },
  next: { flow: Flow; fingerprints: SavedFingerprints },
  name = first.flow.name,
): { flow: Flow; fingerprints: SavedFingerprints } {
  const inputs = { ...first.flow.inputs };
  const renames: [string, string][] = [];
  for (const [key, value] of Object.entries(next.flow.inputs)) {
    let free = key;
    for (let n = 2; free in inputs; n += 1) free = `${key}${n}`;
    inputs[free] = value;
    if (free !== key) renames.push([key, free]);
  }
  const rename = (step: Step): Step =>
    renames.length === 0
      ? step
      : (JSON.parse(renames.reduce((json, [from, to]) => json.split(`{{${from}}}`).join(`{{${to}}}`), JSON.stringify(step))) as Step);

  const offset = first.flow.steps.length;
  return {
    flow: { ...first.flow, name, inputs, steps: [...first.flow.steps, ...next.flow.steps.map(rename)] },
    fingerprints: {
      version: 1,
      steps: [...first.fingerprints.steps, ...next.fingerprints.steps.map((f) => ({ ...f, step: f.step + offset }))],
    },
  };
}
