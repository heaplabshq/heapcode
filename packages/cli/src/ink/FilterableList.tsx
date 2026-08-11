import { Box, Text, useInput } from 'ink';
import React, { useRef, useState } from 'react';
import { filterModels } from '@heapcode/core';

export interface FilterableItem {
  label: string;
  value: string;
}

/** A row that always sits at the bottom, below the (filtered) items. */
export interface FilterableFooterRow {
  label: string;
  onSelect(): void;
}

const DEFAULT_ROWS = 12;

/**
 * An arrow-key select list that narrows as you type, for lists too long to
 * scroll through — provider model lists above all, where a plain list means
 * paging past hundreds of ids to reach one you already know the name of.
 *
 * Escape and Ctrl+C are deliberately not handled here: both the setup wizard
 * and the app shell already own dismissal for whatever is showing this list,
 * and consuming them here would break their cancel paths.
 */
export function FilterableList({
  items,
  onSelect,
  rows = DEFAULT_ROWS,
  footer,
  placeholder = 'Type to filter',
}: {
  items: readonly FilterableItem[];
  onSelect(value: string): void;
  rows?: number;
  footer?: FilterableFooterRow;
  placeholder?: string;
}): React.ReactElement {
  const [filter, setFilter] = useState('');
  const [highlight, setHighlight] = useState(0);

  // Filtering runs over the values (the model ids) rather than the labels,
  // which carry decoration like " (current)" that would otherwise match.
  const byValue = new Map(items.map((i) => [i.value, i]));
  const filtered = filterModels(
    items.map((i) => i.value),
    filter,
  ).map((value) => byValue.get(value)!);

  const shown = filtered.slice(0, rows);
  const footerIndex = footer ? shown.length : -1;
  const rowCount = shown.length + (footer ? 1 : 0);

  /**
   * Everything the key handler needs, refreshed on every render. Ink
   * resubscribes `useInput` when the handler identity changes, but inside a
   * tree the size of the app shell that resubscribe does not reliably land
   * between a keystroke and the next one: the handler goes on reading the
   * *first* render's `filter` and `shown`, so Enter selects row 0 of the
   * unfiltered list no matter what the user narrowed it to (the visible list
   * is correct — only the closure is stale, which is what made this look like
   * a rendering problem rather than an input one). Reading through a ref
   * assigned during render sidesteps the resubscribe entirely.
   */
  const live = useRef({ shown, highlight, footerIndex, rowCount, footer, onSelect });
  live.current = { shown, highlight, footerIndex, rowCount, footer, onSelect };

  useInput((input, key) => {
    const now = live.current;
    if (key.escape || key.ctrl || key.meta || key.tab) return;
    if (key.backspace || key.delete) {
      setFilter((f) => f.slice(0, -1));
      setHighlight(0);
      return;
    }
    if (key.upArrow) {
      if (now.rowCount > 0) setHighlight((h) => (h - 1 + now.rowCount) % now.rowCount);
      return;
    }
    if (key.downArrow) {
      if (now.rowCount > 0) setHighlight((h) => (h + 1) % now.rowCount);
      return;
    }
    if (key.return) {
      if (now.footer && now.highlight === now.footerIndex) now.footer.onSelect();
      else if (now.shown[now.highlight]) now.onSelect(now.shown[now.highlight]!.value);
      return;
    }
    if (input) {
      setFilter((f) => f + input);
      setHighlight(0);
    }
  });

  return (
    <Box flexDirection="column">
      <Text dimColor>
        {placeholder}
        {filter ? `: ${filter}` : ''} · ↑↓ to navigate · Enter to select
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {shown.map((item, i) => (
          <Text key={item.value} color={highlight === i ? 'cyan' : undefined} bold={highlight === i}>
            {highlight === i ? '❯ ' : '  '}
            {item.label}
          </Text>
        ))}
        {filtered.length > shown.length && (
          <Text dimColor> … {filtered.length - shown.length} more — keep typing to narrow</Text>
        )}
        {filtered.length === 0 && <Text dimColor> No matches.</Text>}
        {footer && (
          <Text color={highlight === footerIndex ? 'cyan' : undefined} bold={highlight === footerIndex}>
            {highlight === footerIndex ? '❯ ' : '  '}
            {footer.label}
          </Text>
        )}
      </Box>
    </Box>
  );
}
