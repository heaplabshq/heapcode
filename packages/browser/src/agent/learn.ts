import { createProvider } from '@heapcode/core/providers';
import { loadApiKey, type StoredProfile } from '../shared/settings.js';
import type { Workflow } from '../shared/tasks.js';
import { toolLabel } from '../shared/toolLabels.js';

/**
 * Turning a run that worked into something worth running again.
 *
 * Saved tasks store the request and nothing else, so running one again is the
 * agent starting from scratch: re-reading, re-deciding, re-paying for every
 * turn it already spent working this out once. What is worth keeping is not
 * the request -- it is the deciding.
 *
 * Not recorded actions, which is the obvious idea and the wrong one. A recorded
 * click sequence is worthless a week later on a redesigned page and worse than
 * worthless on one that has merely changed its contents: "the third result" is
 * a different product this week, and clicking it again is precisely wrong. What
 * is durable is what the steps were *for*.
 *
 * So the model reads back its own transcript and writes down what it did, in
 * terms a person would use. The result is guidance for the next run, and the
 * next run still looks at the page.
 */

/** What the model is shown of its own run: what it did, not what it said. */
function transcriptOf(steps: { kind: string; tool?: { name: string; args: Record<string, unknown> } }[]): string {
  const lines: string[] = [];
  for (const step of steps) {
    if (step.kind !== 'tool' || !step.tool) continue;
    const args = Object.entries(step.tool.args)
      // Handles are the one thing that must not survive into a workflow: they
      // belong to one snapshot of one page and are meaningless by the time
      // anyone runs this again.
      .filter(([key]) => key !== 'handle' && key !== 'generation')
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(' ');
    lines.push(`${toolLabel(step.tool.name).past}${args ? ` (${args})` : ''}`);
  }
  return lines.join('\n');
}

const INSTRUCTION = `You are writing down how a browser task was carried out, so it can be done again later without working it out from scratch.

Reply with JSON only, in this exact shape:
{"name": "...", "varies": "...", "steps": ["...", "..."]}

"name" is two to four words a person would recognise this by, lowercase.

"varies" names the one thing that would differ next time, in plain words a person can act on — "the product to search for", "the month to report on". Use null if nothing varies.

"steps" is what was done, in order, six steps at most. Write each one in terms of what it was FOR, the way you would tell a colleague: "search for the product", "sort the results by price", "read the top few and note the prices". Never mention handle numbers, element ids or coordinates — they will not exist next time. Do not include the specific value that varies; say "the product" rather than "mac mini".

Describe only what actually worked. Leave out dead ends, retries and anything the user had to do by hand.`;

export interface LearnedWorkflow extends Workflow {
  name: string;
}

/**
 * Ask the model to describe the run it just finished.
 *
 * One plain completion, not an agent turn: it needs no tools and must not
 * touch the page. Returns undefined rather than throwing on anything
 * unexpected — failing to save a shortcut is a disappointment, not an error,
 * and the run it describes has already succeeded either way.
 */
export async function learnWorkflow(
  profile: StoredProfile,
  task: string,
  steps: { kind: string; tool?: { name: string; args: Record<string, unknown> } }[],
  signal?: AbortSignal,
): Promise<LearnedWorkflow | undefined> {
  const did = transcriptOf(steps);
  if (!did) return undefined;

  try {
    const provider = createProvider(profile, await loadApiKey(profile.name));
    const response = await provider.chat({
      model: profile.agentModel ?? profile.model,
      messages: [
        { role: 'system', content: INSTRUCTION },
        { role: 'user', content: `The request was: ${task}\n\nWhat it did:\n${did}` },
      ],
      temperature: 0,
      maxTokens: 600,
      signal,
    });
    return parseWorkflow(response.content);
  } catch {
    return undefined;
  }
}

/**
 * Read the model's answer, tolerantly.
 *
 * Models fence JSON in code blocks and add a sentence before it however firmly
 * they are told not to, and a shortcut that fails to save because of a stray
 * backtick would be a silly way to lose one.
 */
export function parseWorkflow(reply: string): LearnedWorkflow | undefined {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;

  try {
    const parsed = JSON.parse(reply.slice(start, end + 1)) as {
      name?: unknown;
      varies?: unknown;
      steps?: unknown;
    };
    const steps = Array.isArray(parsed.steps)
      ? parsed.steps.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
          .map((s) => s.trim())
          .slice(0, 8)
      : [];
    if (steps.length === 0) return undefined;

    const name = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : 'saved run';
    const varies =
      typeof parsed.varies === 'string' && parsed.varies.trim() && parsed.varies.trim() !== 'null'
        ? parsed.varies.trim()
        : undefined;

    return { name: name.slice(0, 60), varies, steps, learnedAt: Date.now() };
  } catch {
    return undefined;
  }
}

/**
 * The workflow as the next run is told about it.
 *
 * Deliberately worded as what happened rather than as instructions. A plan
 * given as orders gets followed past the point where the page stopped matching
 * it; a plan given as history gets checked.
 */
export function describeWorkflow(workflow: Workflow): string {
  return `\n\nHOW THIS WAS DONE BEFORE
A previous run of this task worked, and these were its steps:
${workflow.steps.map((step, i) => `${i + 1}. ${step}`).join('\n')}

Use it as a starting point, not as orders. The page may have changed, and the user's request may differ in the details${workflow.varies ? ` — last time ${workflow.varies} was the part that varied` : ''}. Check each step against what is actually on the page, and if the page no longer matches, say so plainly and work it out from there instead of forcing the old route.`;
}
