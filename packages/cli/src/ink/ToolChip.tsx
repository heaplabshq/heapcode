import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { TranscriptItem } from './types.js';

const TOOL_SUMMARY_CHARS = 200;

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
  return (
    <Box flexDirection="column" marginBottom={item.status === 'running' ? 0 : 1}>
      <Box gap={1}>
        {icon}
        <Text dimColor>{item.description}</Text>
      </Box>
      {item.summary && item.status !== 'running' && (
        <Box marginLeft={2}>
          <Text dimColor wrap="truncate-end">
            {item.summary.slice(0, TOOL_SUMMARY_CHARS).replace(/\n/g, ' ')}
          </Text>
        </Box>
      )}
    </Box>
  );
}
