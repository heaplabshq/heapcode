import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';

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
  /** Fires with whether the buffer currently has text — lets the host decide
   * what Ctrl+C should do (clear input vs. arm exit). */
  onActivity?(hasText: boolean): void;
  /** Increment to clear the buffer from outside (Ctrl+C-clears-input). */
  clearToken?: number;
}

const MENU_MAX_ROWS = 16;
const MENTION_MAX_ROWS = 8;

/** The `@token` the cursor is currently inside, if any. */
function mentionTokenAt(value: string, cursor: number): { start: number; query: string } | undefined {
  const before = value.slice(0, cursor);
  const match = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!match) return undefined;
  return { start: cursor - match[2]!.length - 1, query: match[2]! };
}

/**
 * The prompt line: single-line editing with a visible cursor, arrow-key
 * movement, readline chords (Ctrl+A/E/U/K/W), per-session input history on
 * Up/Down, and a slash-command autocomplete menu. Multi-line input is
 * CLI-M2 scope (docs/CLI_PLAN.md).
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
}: ComposerProps): React.ReactElement {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const valueRef = useRef('');
  const cursorRef = useRef(0);
  const [menuIndex, setMenuIndex] = useState(0);
  const historyRef = useRef<string[]>([]);
  const historyPos = useRef(-1); // -1 = editing a fresh (non-history) line
  const draftRef = useRef('');

  const setBuffer = (text: string, cur: number = text.length): void => {
    valueRef.current = text;
    cursorRef.current = Math.max(0, Math.min(cur, text.length));
    setValue(valueRef.current);
    setCursor(cursorRef.current);
    onActivity?.(valueRef.current.length > 0);
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
        const text = menuOpen ? menu[menuIndex]!.name : valueRef.current.trim();
        if (!text) return;
        if (historyRef.current[historyRef.current.length - 1] !== text) historyRef.current.push(text);
        historyPos.current = -1;
        setBuffer('');
        onSubmit(text);
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
        } else if (menuOpen) {
          setMenuIndex((i) => (i - 1 + menu.length) % menu.length);
        } else if (historyRef.current.length > 0) {
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
        } else if (menuOpen) {
          setMenuIndex((i) => (i + 1) % menu.length);
        } else if (historyPos.current !== -1) {
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
        }
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

  const before = value.slice(0, cursor);
  const at = value[cursor] ?? ' ';
  const after = value.slice(cursor + 1);

  return (
    <Box flexDirection="column">
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
