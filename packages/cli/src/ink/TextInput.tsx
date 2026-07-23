import React, { useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';

export interface TextInputProps {
  label: string;
  defaultValue?: string;
  /** Echo `*` per character instead of the real text — for API keys. */
  mask?: boolean;
  onSubmit(value: string): void;
}

/**
 * Single-line labeled text input. `defaultValue` is shown as a dim hint next
 * to the label (matching the old readline wizard's "Profile name (ollama): "
 * convention) rather than pre-loaded into the editable buffer — the buffer
 * starts empty, Enter with nothing typed submits the default. Pre-loading
 * the default as editable text was tried first and reverted: typing a
 * replacement value then just appends after it instead of replacing it,
 * which means "clear the field" requires manually backspacing the whole
 * default first — worse than not pre-filling at all.
 *
 * Uses the same ref+state pattern as Composer: useInput fires outside
 * React's own event/batching system, so reading a plain useState closure on
 * Enter can see a stale value if a character was typed in the same tick (a
 * real bug caught in Composer's own tests) — the ref is always current,
 * state is only what's rendered.
 */
export function TextInput({ label, defaultValue, mask, onSubmit }: TextInputProps): React.ReactElement {
  const [value, setValue] = useState('');
  const valueRef = useRef('');

  useInput((input, key) => {
    if (key.return) {
      onSubmit(valueRef.current.trim() || defaultValue || '');
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
  });

  return (
    <Box>
      <Text color="cyan">
        {label}
        {defaultValue ? ` (${defaultValue})` : ''}:{' '}
      </Text>
      <Text>{mask ? '*'.repeat(value.length) : value}</Text>
    </Box>
  );
}
