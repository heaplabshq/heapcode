import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { highlight } from 'cli-highlight';
import type { TranscriptItem } from './types.js';

// A preview, not a pager — enough to actually see what the tool returned
// (file contents, command output) without one big result taking over the
// transcript. Squashing everything to one line (the old behavior) threw
// away real information: a read_file result became unreadable, and a
// run_command's actual output vanished into "npm test 2>&1 | ...".
const SUMMARY_CHARS = 800;
const SUMMARY_LINES = 16;

/** Best-effort: cli-highlight throws on some inputs/unsupported languages — never let a render crash on that. */
function highlightSafe(text: string, language: string): string {
  try {
    return highlight(text, { language, ignoreIllegals: true });
  } catch {
    return text;
  }
}

export function ToolChip({ item }: { item: Extract<TranscriptItem, { kind: 'tool' }> }): React.ReactElement {
  const icon =
    item.status === 'running' ? (
      <Text color="cyan">
        <Spinner type="dots" />
      </Text>
    ) : item.status === 'ok' ? (
      <Text color="green">✓</Text>
    ) : (
      <Text color="red">✗</Text>
    );
  const indent = item.indent ? 2 : 0;

  let summaryNode: React.ReactNode = null;
  if (item.summary && item.status !== 'running') {
    const lines = item.summary.slice(0, SUMMARY_CHARS).split('\n');
    const shown = lines.slice(0, SUMMARY_LINES);
    const omitted = lines.length - shown.length;
    const text = shown.join('\n');
    const body = item.language ? highlightSafe(text, item.language) : text;
    summaryNode = (
      <Box flexDirection="column">
        <Text dimColor={!item.language}>{body}</Text>
        {omitted > 0 && <Text dimColor>… {omitted} more line(s)</Text>}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={item.status === 'running' ? 0 : 1} marginLeft={indent}>
      <Box gap={1}>
        {item.indent && <Text dimColor>↳</Text>}
        {icon}
        <Text dimColor>{item.description}</Text>
      </Box>
      {summaryNode && <Box marginLeft={2}>{summaryNode}</Box>}
    </Box>
  );
}
