import React from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import { Composer } from './Composer.js';

export interface AskUserRequest {
  question: string;
  options?: string[];
}

/**
 * Terminal surface for the ask_user tool — a select list when the model offered
 * options, else free text.
 *
 * `countdownSeconds` is set only for the last stretch of an idle timeout the
 * user opted into, and only for a question that can time out at all (a
 * blocksAction question never does). `onPartial` reports whatever has been
 * typed or highlighted so far, so an expiring question can hand the agent the
 * partial answer rather than nothing.
 */
export function AskUserPrompt({
  request,
  onAnswer,
  onPartial,
  countdownSeconds,
}: {
  request: AskUserRequest;
  onAnswer(answer: string): void;
  onPartial?(partial: string): void;
  countdownSeconds?: number;
}): React.ReactElement {
  const hasOptions = Boolean(request.options && request.options.length > 0);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} marginBottom={1}>
      <Box>
        <Text color="magenta" bold>
          Agent has a question
        </Text>
        {countdownSeconds !== undefined && (
          <Text color="yellow">
            {'  '}
            — no reply in {countdownSeconds}s and the agent will carry on
          </Text>
        )}
      </Box>
      <Text>{request.question}</Text>
      <Box marginTop={1}>
        {hasOptions ? (
          <SelectInput
            items={request.options!.map((o) => ({ label: o, value: o }))}
            onSelect={(item) => onAnswer(item.value)}
            onHighlight={(item) => onPartial?.(String(item.value))}
          />
        ) : (
          <Composer
            onSubmit={onAnswer}
            onActivity={(_hasText, text) => onPartial?.(text)}
            placeholder="Type your answer, Enter to submit"
          />
        )}
      </Box>
    </Box>
  );
}
