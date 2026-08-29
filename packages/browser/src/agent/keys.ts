/**
 * Keys, in the three forms everything wants them in.
 *
 * A key press is the one input CDP will not take a shortcut on. `Input.insertText`
 * puts characters in a field but produces no key events at all, so a search box
 * that submits on Enter, a combobox driven by arrow keys, and a dialog that
 * closes on Escape are all unreachable through it. `Input.dispatchKeyEvent` does
 * the real thing, and it wants `key`, `code` and the legacy Windows virtual key
 * code to be mutually consistent — get one wrong and Chrome dispatches an event
 * the page quietly ignores, which looks exactly like a page that does not
 * respond to that key.
 */

export interface KeyPress {
  key: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
}

interface KeySpec {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  /** Set for keys that also produce a character, which need a `char` event. */
  text?: string;
}

/** The named keys worth supporting, spelled the way the DOM spells them. */
const NAMED: Record<string, KeySpec> = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, text: '\t' },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
};

/** Spellings a model reasonably reaches for, mapped to the canonical name. */
const ALIASES: Record<string, string> = {
  return: 'Enter',
  esc: 'Escape',
  escape: 'Escape',
  enter: 'Enter',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  space: 'Space',
  spacebar: 'Space',
  ' ': 'Space',
};

export const KNOWN_KEYS = Object.keys(NAMED);

/**
 * Parse what the model asked for, including a chord written as one string.
 *
 * "Enter", "Escape", "Ctrl+A" and "a" all arrive here, because those are all
 * things a person would write. Rejecting the chord form and demanding separate
 * modifier arguments would be technically tidier and would be got wrong on most
 * calls.
 */
export function parseKey(input: string): KeyPress | undefined {
  const raw = input.trim();
  if (!raw) return undefined;

  const parts = raw.includes('+') && raw.length > 1 ? raw.split('+') : [raw];
  const press: KeyPress = { key: '' };

  for (const part of parts) {
    const token = part.trim();
    const lower = token.toLowerCase();
    if (lower === 'ctrl' || lower === 'control') press.ctrl = true;
    else if (lower === 'alt' || lower === 'option') press.alt = true;
    else if (lower === 'shift') press.shift = true;
    else if (lower === 'meta' || lower === 'cmd' || lower === 'command') press.meta = true;
    else press.key = token;
  }

  if (!press.key) return undefined;

  const canonical = ALIASES[press.key.toLowerCase()] ?? press.key;
  if (NAMED[canonical]) {
    press.key = NAMED[canonical]!.key;
    return press;
  }
  // A single printable character is a legitimate key; anything longer that is
  // not a name we know would be dispatched as a key the page has never heard of.
  if ([...press.key].length !== 1) return undefined;
  return press;
}

/** The CDP modifier bitmask: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export function modifierMask(press: KeyPress): number {
  return (
    (press.alt ? 1 : 0) | (press.ctrl ? 2 : 0) | (press.meta ? 4 : 0) | (press.shift ? 8 : 0)
  );
}

/** The three consistent forms of one key, for `Input.dispatchKeyEvent`. */
export function keySpec(press: KeyPress): KeySpec {
  const canonical = ALIASES[press.key.toLowerCase()] ?? press.key;
  const named = NAMED[canonical];
  if (named) return named;

  const character = press.key;
  const upper = character.toUpperCase();
  if (/^[A-Z]$/.test(upper)) {
    return {
      key: character,
      code: `Key${upper}`,
      windowsVirtualKeyCode: upper.charCodeAt(0),
      text: character,
    };
  }
  if (/^[0-9]$/.test(character)) {
    return {
      key: character,
      code: `Digit${character}`,
      windowsVirtualKeyCode: character.charCodeAt(0),
      text: character,
    };
  }
  return { key: character, code: '', windowsVirtualKeyCode: 0, text: character };
}

/**
 * Which modifier means "the whole field" on this machine.
 *
 * Select-all is Command+A on macOS and Control+A everywhere else, and sending
 * the wrong one does not error -- it types the letter A, or does nothing, and
 * the field ends up with the new text appended to the old. Chrome's own
 * shortcut handling is platform-specific, so this has to be too.
 */
export function selectAllModifier(): number {
  const platform =
    typeof navigator !== 'undefined'
      ? `${(navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? ''} ${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`
      : '';
  return /mac/i.test(platform) ? 4 : 2;
}

/** How a press reads to a human, for the note that comes back. */
export function describeKey(press: KeyPress): string {
  return [
    press.ctrl && 'Ctrl',
    press.alt && 'Alt',
    press.shift && 'Shift',
    press.meta && 'Meta',
    press.key === ' ' ? 'Space' : press.key,
  ]
    .filter(Boolean)
    .join('+');
}
