/**
 * Heap Chat may only use tokens the shared shell defines.
 *
 * This file's stylesheet began as standalone heapchat's, and three of its
 * variables came across with it — `--line`, `--panel`, `--muted` — none of
 * which exist in `@heapcode/web-ui/styles.css`. CSS does not complain about an
 * undefined variable, it drops the declaration, so the grounding badge
 * rendered with a currentColor border, no background and inherited text: the
 * element most particular to this product was the one least like the rest of
 * the application, and nothing failed to say so.
 *
 * Tokens resolving is most of what makes two products look like one, so it is
 * worth asserting directly rather than hoping to catch it in a screenshot.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const chat = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8');
const shared = readFileSync(fileURLToPath(new URL('../../web-ui/src/styles.css', import.meta.url)), 'utf8');

/** `--foo` names given a value in a stylesheet. */
function defined(css: string): Set<string> {
  return new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]!));
}

/** `--foo` names read by `var(--foo)`, ignoring any that supply a fallback. */
function referenced(css: string): Set<string> {
  return new Set([...css.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].map((m) => m[1]!));
}

describe('Heap Chat’s stylesheet', () => {
  it('reads no variable the shared sheet does not define', () => {
    const available = new Set([...defined(shared), ...defined(chat)]);
    const unresolved = [...referenced(chat)].filter((v) => !available.has(v));
    expect(unresolved, `not defined in web-ui/styles.css: ${unresolved.join(', ')}`).toEqual([]);
  });

  it('states no colour of its own', () => {
    // A literal hex is a colour that cannot follow the theme: the grounding
    // check mark was #2e7d4f, which stayed dark green against a dark palette.
    const literals = [...chat.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
    expect(literals, `use a token instead of: ${literals.join(', ')}`).toEqual([]);
  });
});
