import React, { useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';

export interface ComposerProps {
  onSubmit(text: string): void;
  disabled?: boolean;
  placeholder?: string;
}

/**
 * A single-line composer with basic line editing (printable chars,
 * backspace, submit on Enter). Multi-line input + slash-command autocomplete
 * is CLI-M2 scope (docs/CLI_PLAN.md) — kept out of CLI-M0 on purpose.
 *
 * Reads/writes a ref alongside React state for the submit check: useInput's
 * handler fires from a raw stdin event, outside React's own event system, so
 * back-to-back events in the same tick (a paste immediately followed by
 * Enter, or — same shape — a test driving stdin synchronously) can see a
 * stale `value` closure if state hasn't re-rendered between them yet. The
 * ref is always current; state is what's rendered.
 */
export function Composer({ onSubmit, disabled, placeholder }: ComposerProps): React.ReactElement {
  const [value, setValue] = useState('');
  const valueRef = useRef('');

  useInput(
    (input, key) => {
      if (disabled) return;
      if (key.return) {
        const text = valueRef.current.trim();
        if (text) {
          valueRef.current = '';
          setValue('');
          onSubmit(text);
        }
        return;
      }
      if (key.backspace || key.delete) {
        valueRef.current = valueRef.current.slice(0, -1);
        setValue(valueRef.current);
        return;
      }
      if (key.ctrl || key.meta) return;
      if (input) {
        valueRef.current += input;
        setValue(valueRef.current);
      }
    },
    { isActive: !disabled },
  );

  return (
    <Box borderStyle="round" borderColor={disabled ? 'gray' : 'cyan'} paddingX={1}>
      <Text color="cyan">{'> '}</Text>
      {value ? <Text>{value}</Text> : <Text dimColor>{placeholder ?? 'Type a message, Ctrl+C to exit'}</Text>}
    </Box>
  );
}
