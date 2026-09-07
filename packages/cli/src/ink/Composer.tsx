import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useTerminalColumns } from './useTerminalColumns.js';

export interface SlashCommand {
  /** Including the leading slash, e.g. `/model`. */
  name: string;
  description: string;
  /** Optional argument hint shown next to the name, e.g. `[id]`. */
  args?: string;
}

export interface ComposerProps {
  onSubmit(text: string): void;
  disabled?: boolean;
  placeholder?: string;
  /** When provided, typing `/` opens a filtered autocomplete menu of these. */
  commands?: SlashCommand[];
  /** Workspace paths for `@` mention autocomplete (folders end with `/`). */
  mentionCandidates?: string[];
  /** Fired when the user types `@` — the host lazy-loads mentionCandidates. */
  onMentionTrigger?(): void;
  /** Fires with whether the buffer currently has text, and the text itself —
   * lets the host decide what Ctrl+C should do (clear input vs. arm exit), and
   * lets an ask_user prompt report the partial answer typed so far. */
  onActivity?(hasText: boolean, text: string): void;
  /** Increment to clear the buffer from outside (Ctrl+C-clears-input). */
  clearToken?: number;
  /**
   * Ctrl+V — attach whatever image is on the system clipboard.
   *
   * Not "paste": the terminal already owns Cmd+V/middle-click and delivers the
   * clipboard's TEXT as keystrokes, which is the behaviour people want and
   * which this must not take away. An image has no keystrokes, so it needs a
   * key of its own that goes and asks the OS (see clipboardImage.ts).
   */
  onAttachImage?(): void;
  /**
   * Ctrl+X — drop the most recently attached image.
   *
   * Attaching without a way to unattach is a trap: the only escape was to send
   * the message you did not want to send. Last-one-off rather than a picker,
   * because a terminal has nothing to click and pressing it again walks back
   * through the rest.
   */
  onRemoveImage?(): void;
  /** Images staged for the next message, shown above the input so they cannot be forgotten. */
  attachmentCount?: number;
}

// Commands keep growing (guardrail: every feature gets a slash command) —
// capped generously rather than tightly, since the alternative is a command
// existing but not fitting in its own menu. Typing more of the name filters
// the list down long before this cap would ever bite in practice.
const MENU_MAX_ROWS = 30;
const MENTION_MAX_ROWS = 8;

// Border (2 cols) + paddingX (2 cols) + the "❯ " gutter (2 cols, which every
// wrapped row also sits under — see the note by the render block) + a
// column of slack. The slack absorbs the sort of small, hard-to-pin-down
// width mismatches (a stale `columns` reading, a boundary cursor rendering
// one cell past a row's last character) that otherwise turn into a
// terminal-side wrap Ink doesn't know happened — see wrapValue below for why
// that matters.
const ROW_OVERHEAD = 7;
const MIN_CONTENT_WIDTH = 10;

/** The `@token` the cursor is currently inside, if any. */
function mentionTokenAt(value: string, cursor: number): { start: number; query: string } | undefined {
  const before = value.slice(0, cursor);
  const match = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!match) return undefined;
  return { start: cursor - match[2]!.length - 1, query: match[2]! };
}

interface Row {
  /** Display text for this physical (wrapped) row — never longer than `width`. */
  text: string;
  /** Offset into the raw buffer where this row's text begins. */
  start: number;
}

/**
 * Hard-wraps `value` to `width` columns per physical row, breaking on the
 * user's own newlines first and then again on width. This is the fix for
 * the actual bug: this composer used to hand Ink one long, unbroken line of
 * text per user-typed line and trust its border Box to stretch to exactly
 * the terminal's width. Any small mismatch between what Ink thinks that
 * width is and what the terminal actually does with it (and in practice,
 * across real terminals, there always eventually is one — a stale/racy
 * `columns` reading, a resize the terminal hasn't finished repainting,
 * whatever) causes the terminal itself to silently wrap a row onto an extra
 * physical line. Ink's incremental repaint has no idea that happened — it
 * only erases as many lines as its own layout says it wrote — so the extra
 * line never gets cleared and lingers as a stray fragment on the next
 * redraw. Pre-wrapping here means every row handed to Ink is already
 * guaranteed to fit, so the terminal never needs to wrap anything itself,
 * regardless of *why* a width mismatch happened.
 */
function wrapValue(value: string, width: number): Row[] {
  const rows: Row[] = [];
  let offset = 0;
  for (const line of value.split('\n')) {
    if (line.length === 0) {
      rows.push({ text: '', start: offset });
    } else {
      for (let i = 0; i < line.length; i += width) {
        rows.push({ text: line.slice(i, i + width), start: offset + i });
      }
    }
    offset += line.length + 1; // +1 skips the '\n' this line was split on.
  }
  return rows;
}

/** Which physical row (and column within it) a raw buffer offset falls on. */
function locateCursor(rows: Row[], cursor: number): { row: number; col: number } {
  for (let i = 0; i < rows.length; i++) {
    const next = rows[i + 1];
    if (!next || cursor < next.start) return { row: i, col: cursor - rows[i]!.start };
  }
  return { row: 0, col: 0 }; // unreachable — wrapValue always returns at least one row
}

/**
 * Raw buffer offset one physical (wrapped) row up/down from `cursor`,
 * clamped to the shorter row. Returns undefined at the first/last row —
 * the caller's cue to fall through to history navigation instead, exactly
 * like a normal multi-line text box. Physical rather than logical rows so
 * Up/Down walks a long wrapped line the way a real text area does, not just
 * the lines the user actually pressed Enter on.
 */
function moveVertical(rows: Row[], cursor: number, direction: 'up' | 'down'): number | undefined {
  const { row, col } = locateCursor(rows, cursor);
  const target = direction === 'up' ? row - 1 : row + 1;
  if (target < 0 || target >= rows.length) return undefined;
  return rows[target]!.start + Math.min(col, rows[target]!.text.length);
}

/**
 * The prompt line: multi-line-capable editing with a visible cursor,
 * arrow-key movement (vertical arrows move between physical rows when
 * there are any, falling through to history navigation only at the
 * first/last row), readline chords (Ctrl+A/E/U/K/W), per-session input
 * history on Up/Down, and a slash-command autocomplete menu.
 *
 * Newline entry, in order of what actually works where: Option+Enter
 * (ESC+CR — Terminal.app with "Use Option as Meta key", iTerm2, most
 * terminals; also what Claude Code's /terminal-setup rebinds Shift+Enter
 * to send in iTerm2/VS Code), Shift+Enter on terminals that genuinely
 * report the modifier, and a trailing backslash before Enter as the
 * everywhere-fallback — most terminals send byte-identical Enter
 * regardless of Shift, so plain Shift+Enter is undetectable app-side.
 * A multi-line paste is inserted as literal text the same way any paste
 * is (Ink already delivers a paste as one `input` call, newlines and all).
 *
 * Buffer and cursor live in refs mirrored to state: useInput fires from raw
 * stdin events outside React's batching, so back-to-back events in one tick
 * (paste + Enter, or a test driving stdin synchronously) would read a stale
 * state closure. The refs are always current; state is only what's rendered.
 */
export function Composer({
  onSubmit,
  disabled,
  placeholder,
  commands,
  mentionCandidates,
  onMentionTrigger,
  onActivity,
  clearToken,
  onAttachImage,
  onRemoveImage,
  attachmentCount = 0,
}: ComposerProps): React.ReactElement {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const valueRef = useRef('');
  const cursorRef = useRef(0);
  const [menuIndex, setMenuIndex] = useState(0);
  const historyRef = useRef<string[]>([]);
  const historyPos = useRef(-1); // -1 = editing a fresh (non-history) line
  const draftRef = useRef('');

  const columns = useTerminalColumns();
  const width = Math.max(MIN_CONTENT_WIDTH, columns - ROW_OVERHEAD);
  const widthRef = useRef(width);
  widthRef.current = width;

  const setBuffer = (text: string, cur: number = text.length): void => {
    valueRef.current = text;
    cursorRef.current = Math.max(0, Math.min(cur, text.length));
    setValue(valueRef.current);
    setCursor(cursorRef.current);
    onActivity?.(valueRef.current.length > 0, valueRef.current);
  };

  // Only the token should retrigger this — setBuffer is stable in behavior.
  useEffect(() => {
    if (clearToken) setBuffer('');
  }, [clearToken]);

  // Menu opens while the buffer is a single slash-word (`/`, `/mo`…); a space
  // closes it so commands with arguments — and plain messages that merely
  // start with a path like `/etc/hosts …` — pass through untouched.
  const menu = useMemo(() => {
    if (!commands || disabled || !value.startsWith('/') || value.includes(' ')) return [];
    const needle = value.toLowerCase();
    return commands.filter((c) => c.name.startsWith(needle)).slice(0, MENU_MAX_ROWS);
  }, [commands, disabled, value]);

  const mentionMenu = useMemo(() => {
    if (disabled || !mentionCandidates || mentionCandidates.length === 0) return [];
    const token = mentionTokenAt(value, cursor);
    if (!token) return [];
    const needle = token.query.toLowerCase();
    return mentionCandidates.filter((f) => f.toLowerCase().includes(needle)).slice(0, MENTION_MAX_ROWS);
  }, [disabled, mentionCandidates, value, cursor]);

  useEffect(() => setMenuIndex(0), [value, cursor]);

  // Lazy-load candidates the moment an @ shows up in the buffer.
  useEffect(() => {
    if (value.includes('@')) onMentionTrigger?.();
  }, [value, onMentionTrigger]);

  const completeMention = (path: string): void => {
    const token = mentionTokenAt(valueRef.current, cursorRef.current);
    if (!token) return;
    const tail = valueRef.current.slice(cursorRef.current);
    const suffix = path.endsWith('/') ? '' : ' ';
    setBuffer(
      `${valueRef.current.slice(0, token.start)}@${path}${suffix}${tail}`,
      token.start + 1 + path.length + suffix.length,
    );
  };

  useInput(
    (input, key) => {
      if (disabled) return;
      const menuOpen = menu.length > 0;
      const mentionOpen = mentionMenu.length > 0;

      if (key.escape) {
        if (valueRef.current) setBuffer('');
        return;
      }
      if (key.return) {
        if (mentionOpen) {
          completeMention(mentionMenu[menuIndex]!);
          return;
        }
        if (!menuOpen) {
          const cur = cursorRef.current;
          // Shift+Enter, on the rare terminal that actually reports it as
          // such (most send byte-identical Enter either way — see the
          // trailing-backslash fallback below, which works everywhere).
          if (key.shift) {
            setBuffer(valueRef.current.slice(0, cur) + '\n' + valueRef.current.slice(cur), cur + 1);
            return;
          }
          // A trailing backslash right before the cursor is a continuation
          // marker, not literal content — swap it for the newline it's
          // standing in for. Net-zero length change, so the cursor's
          // absolute position is unchanged even though it now sits after a
          // newline instead of a backslash.
          if (valueRef.current[cur - 1] === '\\') {
            setBuffer(valueRef.current.slice(0, cur - 1) + '\n' + valueRef.current.slice(cur), cur);
            return;
          }
        }
        const text = menuOpen ? menu[menuIndex]!.name : valueRef.current.trim();
        if (!text) return;
        if (historyRef.current[historyRef.current.length - 1] !== text) historyRef.current.push(text);
        historyPos.current = -1;
        setBuffer('');
        onSubmit(text);
        return;
      }
      // ESC+CR — what Option+Enter sends (Terminal.app with "Use Option as
      // Meta key", iTerm2, most others), and what Claude Code's
      // /terminal-setup binds Shift+Enter to in iTerm2/VS Code. Ink strips
      // the leading ESC and only names the bare-CR sequence 'return', so
      // this arrives as input '\r' with key.return unset — which is exactly
      // the signature to match on. '\n' (linefeed — some terminals'
      // Shift/Ctrl+Enter) means the same thing. Without this branch both
      // fell through to the literal-insert path and put a raw control
      // character in the buffer.
      if (input === '\r' || input === '\n') {
        const cur = cursorRef.current;
        setBuffer(valueRef.current.slice(0, cur) + '\n' + valueRef.current.slice(cur), cur + 1);
        return;
      }
      if (key.tab) {
        if (mentionOpen) completeMention(mentionMenu[menuIndex]!);
        else if (menuOpen) setBuffer(menu[menuIndex]!.name + (menu[menuIndex]!.args ? ' ' : ''));
        return;
      }
      if (key.upArrow) {
        if (mentionOpen) {
          setMenuIndex((i) => (i - 1 + mentionMenu.length) % mentionMenu.length);
          return;
        }
        if (menuOpen) {
          setMenuIndex((i) => (i - 1 + menu.length) % menu.length);
          return;
        }
        // A multi-line buffer moves the cursor up a row first — only once
        // it's already on the first row does Up fall through to history,
        // same as any ordinary multi-line text box.
        const moved = moveVertical(wrapValue(valueRef.current, widthRef.current), cursorRef.current, 'up');
        if (moved !== undefined) {
          setBuffer(valueRef.current, moved);
          return;
        }
        if (historyRef.current.length > 0) {
          if (historyPos.current === -1) {
            draftRef.current = valueRef.current;
            historyPos.current = historyRef.current.length - 1;
          } else {
            historyPos.current = Math.max(0, historyPos.current - 1);
          }
          setBuffer(historyRef.current[historyPos.current]!);
        }
        return;
      }
      if (key.downArrow) {
        if (mentionOpen) {
          setMenuIndex((i) => (i + 1) % mentionMenu.length);
          return;
        }
        if (menuOpen) {
          setMenuIndex((i) => (i + 1) % menu.length);
          return;
        }
        const moved = moveVertical(wrapValue(valueRef.current, widthRef.current), cursorRef.current, 'down');
        if (moved !== undefined) {
          setBuffer(valueRef.current, moved);
          return;
        }
        if (historyPos.current !== -1) {
          historyPos.current += 1;
          if (historyPos.current >= historyRef.current.length) {
            historyPos.current = -1;
            setBuffer(draftRef.current);
          } else {
            setBuffer(historyRef.current[historyPos.current]!);
          }
        }
        return;
      }
      if (key.leftArrow) {
        setBuffer(valueRef.current, cursorRef.current - 1);
        return;
      }
      if (key.rightArrow) {
        setBuffer(valueRef.current, cursorRef.current + 1);
        return;
      }
      if (key.backspace || key.delete) {
        const cur = cursorRef.current;
        if (cur > 0) setBuffer(valueRef.current.slice(0, cur - 1) + valueRef.current.slice(cur), cur - 1);
        return;
      }
      if (key.ctrl) {
        const cur = cursorRef.current;
        if (input === 'a') setBuffer(valueRef.current, 0);
        else if (input === 'e') setBuffer(valueRef.current);
        else if (input === 'u') setBuffer(valueRef.current.slice(cur), 0);
        else if (input === 'k') setBuffer(valueRef.current.slice(0, cur), cur);
        else if (input === 'w') {
          const head = valueRef.current.slice(0, cur).replace(/\S+\s*$/, '');
          setBuffer(head + valueRef.current.slice(cur), head.length);
        } else if (input === 'v') onAttachImage?.();
        else if (input === 'x') onRemoveImage?.();
        return;
      }
      if (key.meta) return;
      if (input) {
        const cur = cursorRef.current;
        setBuffer(valueRef.current.slice(0, cur) + input + valueRef.current.slice(cur), cur + input.length);
      }
    },
    { isActive: !disabled },
  );

  // Every row is already guaranteed to fit within `width` (see wrapValue),
  // so joining them back with '\n' can never trigger a terminal-side wrap —
  // the one thing this rewrite exists to prevent. Ink lines up a Text
  // node's wrapped/newline-broken rows at the node's own x-offset (right
  // after the "❯ " gutter here), so continuation rows land under the first
  // row's text for free — no manual per-row indent needed.
  const rows = wrapValue(value, width);
  const { row: cursorRow, col: cursorCol } = locateCursor(rows, cursor);
  const display = rows.map((r) => r.text).join('\n');
  const displayCursor = rows.slice(0, cursorRow).reduce((acc, r) => acc + r.text.length + 1, 0) + cursorCol;
  const before = display.slice(0, displayCursor);
  const at = display[displayCursor] ?? ' ';
  const after = display.slice(displayCursor + 1);

  return (
    <Box flexDirection="column">
      {/* Above the box, not inside it: the input's width arithmetic (see
          wrapValue) assumes the border contains exactly the typed rows, and a
          terminal that wraps a row the layout did not account for is the bug
          that rewrite exists to prevent. */}
      {attachmentCount > 0 && (
        <Box paddingLeft={2}>
          <Text color="cyan">
            {attachmentCount} image{attachmentCount === 1 ? '' : 's'} attached
          </Text>
          {/* The way back out, said where the thing to undo is shown. A key
              nobody is told about is a key nobody presses. */}
          <Text dimColor> — ctrl+x removes the last</Text>
        </Box>
      )}
      <Box borderStyle="round" borderColor={disabled ? 'gray' : 'cyan'} paddingX={1}>
        <Text color={disabled ? 'gray' : 'cyan'} bold>
          {'❯ '}
        </Text>
        {value ? (
          <Text>
            {before}
            {!disabled && <Text inverse>{at}</Text>}
            {after}
          </Text>
        ) : (
          <Text>
            {!disabled && <Text inverse> </Text>}
            <Text dimColor>{placeholder ?? 'Type a message or / for commands'}</Text>
          </Text>
        )}
      </Box>
      {menu.length > 0 && (
        <Box flexDirection="column" paddingLeft={2}>
          {menu.map((c, i) => (
            <Box key={c.name} gap={1}>
              <Text color={i === menuIndex ? 'cyan' : undefined} bold={i === menuIndex}>
                {c.name}
                {c.args ? ` ${c.args}` : ''}
              </Text>
              <Text dimColor>{c.description}</Text>
            </Box>
          ))}
        </Box>
      )}
      {mentionMenu.length > 0 && (
        <Box flexDirection="column" paddingLeft={2}>
          {mentionMenu.map((f, i) => (
            <Text key={f} color={i === menuIndex ? 'cyan' : undefined} bold={i === menuIndex}>
              {f}
            </Text>
          ))}
          <Text dimColor>tab/enter to insert · folders end with /</Text>
        </Box>
      )}
    </Box>
  );
}
