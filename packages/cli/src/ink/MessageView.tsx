import React from 'react';
import { Box, Text } from 'ink';
import type { ChatMessage } from '@heapcode/core';
import { renderMarkdown } from '../markdown.js';

export function MessageView({ message }: { message: ChatMessage }): React.ReactElement {
  if (message.role === 'user') {
    return (
      <Box marginBottom={1}>
        <Text color="cyan" bold>
          {'> '}
        </Text>
        <Text>{message.content}</Text>
      </Box>
    );
  }
  return (
    <Box marginBottom={1} flexDirection="column">
      <Text>{renderMarkdown(message.content)}</Text>
    </Box>
  );
}
