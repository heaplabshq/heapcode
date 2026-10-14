import { Document, isMap, isSeq, type Node } from 'yaml';
import type { Expectation, Flow, Locator, Step } from './flow.js';

/**
 * `Flow` → the YAML a person would have written.
 *
 * Recording, the AI writer and healing all produce flows, and all of them end
 * in a file someone will read and edit — so the output is the hand-written
 * style from docs/QA_PLAN.md §6: one line per action where it fits, element
 * descriptions inline (`{ role: button, name: Save }`), the intent on the line
 * under it. `parseFlow(serializeFlow(f))` gives `f` back (source lines aside).
 */
export function serializeFlow(flow: Flow): string {
  const body: Record<string, unknown> = { name: flow.name };
  if (flow.baseUrl !== undefined) body.baseUrl = flow.baseUrl;
  if (Object.keys(flow.inputs).length) body.inputs = flow.inputs;
  body.steps = flow.steps.map(stepObject);

  const doc = new Document(body);
  const steps = (doc.contents as unknown as { get(key: string, keep: true): Node }).get('steps', true);
  if (isSeq(steps)) {
    for (const item of steps.items) {
      if (!isMap(item)) continue;
      // The action's own value goes inline; `intent` and `with` stay block-style below it.
      for (const pair of item.items) {
        const key = (pair.key as { value?: unknown }).value;
        if (key !== 'intent' && key !== 'with' && isMap(pair.value)) pair.value.flow = true;
        if (key === 'with' && isMap(pair.value)) pair.value.flow = true;
      }
    }
  }
  return doc.toString({ lineWidth: 0, flowCollectionPadding: true });
}

function stepObject(step: Step): Record<string, unknown> {
  const extra = (): Record<string, unknown> => (step.intent !== undefined ? { intent: step.intent } : {});
  switch (step.kind) {
    case 'goto':
      return { goto: step.url, ...extra() };
    case 'click':
      return { click: locatorValue(step.target), ...extra() };
    case 'type':
      return { type: { into: locatorObject(step.target), text: step.text, ...(step.clear ? {} : { clear: false }) }, ...extra() };
    case 'select':
      return { select: { in: locatorObject(step.target), option: step.option }, ...extra() };
    case 'press':
      return { press: step.target ? { key: step.key, on: locatorObject(step.target) } : step.key, ...extra() };
    case 'wait':
      return { wait: step.ms, ...extra() };
    case 'use':
      return { use: step.use, ...(Object.keys(step.inputs).length ? { with: step.inputs } : {}), ...extra() };
    case 'expect':
      return { expect: expectValue(step.expect), ...extra() };
  }
}

/** A text-only locator is written as the bare text — `click: Save`. */
function locatorValue(locator: Locator): unknown {
  const keys = Object.keys(locator);
  if (keys.length === 1 && locator.text !== undefined) return locator.text;
  return locatorObject(locator);
}

function locatorObject(locator: Locator): Record<string, unknown> {
  // Ladder order, so the file reads most-stable-first like the runner tries it.
  const out: Record<string, unknown> = {};
  for (const key of ['testId', 'role', 'name', 'label', 'placeholder', 'text', 'css', 'nth'] as const) {
    if (locator[key] !== undefined) out[key] = locator[key];
  }
  return out;
}

function expectValue(e: Expectation): unknown {
  switch (e.kind) {
    case 'noConsoleErrors':
      return 'noConsoleErrors';
    case 'noServerErrors':
      return 'noServerErrors';
    case 'screenshot':
      return e.target === undefined && e.maxDiff === undefined
        ? { screenshot: e.name }
        : { screenshot: { name: e.name, ...(e.target ? { in: locatorObject(e.target) } : {}), ...(e.maxDiff !== undefined ? { maxDiff: e.maxDiff } : {}) } };
    case 'visible':
    case 'hidden':
      return { [e.kind]: locatorObject(e.target) };
    case 'text':
      return { text: { in: locatorObject(e.target), ...(e.equals !== undefined ? { equals: e.equals } : {}), ...(e.contains !== undefined ? { contains: e.contains } : {}) } };
    case 'url': {
      if (e.contains !== undefined && e.equals === undefined && e.matches === undefined) return { url: e.contains };
      const out: Record<string, string> = {};
      if (e.equals !== undefined) out.equals = e.equals;
      if (e.contains !== undefined) out.contains = e.contains;
      if (e.matches !== undefined) out.matches = e.matches;
      return { url: out };
    }
    case 'count':
      return { count: { of: locatorObject(e.target), equals: e.equals } };
  }
}
