import React from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import { Composer } from './Composer.js';

export interface AskUserRequest {
  question: string;
  options?: string[];
}

/** Terminal surface for the ask_user tool — a select list when the model offered options, else free text. */
export function AskUserPrompt({
  request,
  onAnswer,
}: {
  request: AskUserRequest;
  onAnswer(answer: string): void;
}): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} marginBottom={1}>
      <Text color="magenta" bold>
        Agent has a question
      </Text>
      <Text>{request.question}</Text>
      <Box marginTop={1}>
        {request.options && request.options.length > 0 ? (
          <SelectInput
            items={request.options.map((o) => ({ label: o, value: o }))}
            onSelect={(item) => onAnswer(item.value)}
          />
        ) : (
          <Composer onSubmit={onAnswer} placeholder="Type your answer, Enter to submit" />
        )}
      </Box>
    </Box>
  );
}
