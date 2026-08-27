import { formatSnapshot, type Control, type PageSnapshot } from './snapshot.js';

/**
 * What changed since the last read.
 *
 * Re-sending a full snapshot every iteration is the main token sink in a
 * multi-step run: a ten-step task pays for ten complete pages, most of it
 * identical text (PRD section 4.2, and the cost bound in M2's exit criteria).
 * After the first read the agent gets a change summary instead.
 *
 * Handles cannot be used to match controls across snapshots -- the registry
 * renumbers from 1 on every read, so [4] is a position, not an identity. The
 * stable identity is what the control *is*: its role, its accessible name, and
 * the row or heading it sits under. That also survives the case this exists to
 * handle, a list re-rendering with the same items in a different order.
 */

/** Role + name + context. Two controls with the same key are the same control. */
function identity(control: Control): string {
  return `${control.role} ${control.name} ${control.context ?? ''}`;
}

function describe(control: Control): string {
  const value = control.value !== undefined ? ` value=${JSON.stringify(control.value)}` : '';
  return `[${control.handle}] ${control.role} ${JSON.stringify(control.name)}${value}`;
}

export interface DeltaOptions {
  budgetChars?: number;
  intent?: string;
  /**
   * Above this share of controls changing, a diff is longer and harder to read
   * than the page itself -- so send the page.
   */
  churnLimit?: number;
}

const DEFAULT_CHURN_LIMIT = 0.5;

/**
 * A compact description of the difference, or the full snapshot when that is
 * genuinely the smaller answer.
 *
 * Navigation is never expressed as a diff. A new URL means a new document, new
 * handles and a discarded registry, and describing that as "142 controls
 * removed, 138 added" is both longer and actively misleading (PRD section 7.5).
 */
export function describeChanges(
  previous: PageSnapshot,
  next: PageSnapshot,
  options: DeltaOptions = {},
): string {
  if (previous.url !== next.url) {
    return `The page navigated to ${next.url}. All previous handles are void. Current page:\n\n${formatSnapshot(next, options)}`;
  }

  const before = new Map(previous.controls.map((c) => [identity(c), c]));
  const after = new Map(next.controls.map((c) => [identity(c), c]));

  const added: Control[] = [];
  const removed: Control[] = [];
  const changed: string[] = [];

  for (const [key, control] of after) {
    const old = before.get(key);
    if (!old) added.push(control);
    else if (old.value !== control.value) {
      changed.push(`${describe(control)} (was ${JSON.stringify(old.value ?? '')})`);
    } else if (old.checked !== control.checked) {
      changed.push(`${describe(control)} is now ${control.checked ? 'checked' : 'unchecked'}`);
    } else if (old.disabled !== control.disabled) {
      changed.push(`${describe(control)} is now ${control.disabled ? 'disabled' : 'enabled'}`);
    }
  }
  for (const [key, control] of before) {
    if (!after.has(key)) removed.push(control);
  }

  const churn =
    next.controls.length > 0
      ? (added.length + removed.length) / Math.max(next.controls.length, previous.controls.length)
      : 0;
  if (churn > (options.churnLimit ?? DEFAULT_CHURN_LIMIT)) {
    return `The page changed substantially. Current page:\n\n${formatSnapshot(next, options)}`;
  }

  const parts: string[] = [];
  const scrolled = next.viewport.scrollY - previous.viewport.scrollY;
  if (scrolled !== 0) {
    parts.push(
      `Scrolled ${scrolled > 0 ? 'down' : 'up'} ${Math.abs(scrolled)}px (now at ${next.viewport.scrollY} of ${next.viewport.scrollHeight}).`,
    );
  }
  if (previous.title !== next.title) parts.push(`Title is now ${JSON.stringify(next.title)}.`);

  if (added.length > 0) {
    parts.push(`New controls:\n${added.map((c) => `  ${describe(c)}`).join('\n')}`);
  }
  if (changed.length > 0) parts.push(`Changed:\n${changed.map((c) => `  ${c}`).join('\n')}`);
  if (removed.length > 0) {
    parts.push(`Gone: ${removed.map((c) => JSON.stringify(c.name)).join(', ')}`);
  }

  const newText = next.text.length - previous.text.length;
  if (Math.abs(newText) > 200) {
    parts.push(
      `The page text ${newText > 0 ? 'grew' : 'shrank'} by about ${Math.abs(newText)} characters.`,
    );
  }

  if (parts.length === 0) return 'Nothing on the page changed.';

  // Handles are reissued on every read, so even an unchanged control has a new
  // number. Saying so prevents the model reusing the numbers it saw last time.
  return [
    'Handles have been reissued for this read -- use the numbers below, not the ones from before.',
    ...parts,
  ].join('\n');
}
